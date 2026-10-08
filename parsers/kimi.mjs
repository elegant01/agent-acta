// ---------------- kimi 解析器（~/.kimi-code 与 ~/.kimi 两个变体，wire.jsonl 事件流） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanKimiFile / scanKimi /
// kimiEntryContent / stripKimiMeta（详情与扫描共用同一套口径函数）。
//
// 目录摆法（isKimiWire / kimiWireIn / kimiWires）在主文件的 discovery.mjs——嗅探与扫描共用，
// 这里只 import kimiWires。
// wire.jsonl 事件流（本机 kimi-code 0.10.1 实测）：
//   metadata（协议版本）→ turn.prompt（用户开轮，input[].text + time 毫秒）
//   → context.append_loop_event（event.type = step.begin / tool.call / tool.result / text / think）
//   → usage.record（usageScope=turn，model + usage{inputOther,output,inputCacheRead,inputCacheCreation}）
//   → turn.cancel（用户中断收轮）
// 一轮 = turn.prompt 到下一个 turn.prompt（或文件尾）。token 只认 usageScope=turn 的 usage.record（每轮最后一条是轮级汇总口径）。
//
// 已知的版本差异（本机 866 条 usage.record 全是 turn 域、model 就是真模型名，故按此实现；
// 若将来某版本把 model 写成别名（__xxx_model__）、或出现只带 usageScope=session 的压缩调用，
// 症状是「模型列显示占位名 / 少算一块 token」，对着 wire.jsonl 核一遍即可，排查入口在这）；
// 增量：文件按 off 续读（OFF_KINDS 已含 kimi），turn 按 idx 重发（进行中的轮原地更新）。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, modelName, windowOf, markKind, toText, trunc, readCompleteLines } from './shared.mjs';
import { kimiWires } from './discovery.mjs';

export function kimiIdBase(fp) { return 'k#' + fp.replace(/[\\/:]/g, '~') + '#'; }

// 会话级「chrome」事件：跟「这一轮干了什么」无关，只是会话/工具注册表的状态。
// 一律跳过，**不能**让它们参与 lastTs 累加 —— 桌面版（daimon 内核）每一轮开始前都会把整段
// 重放一遍（本机实测第 33–52 行：config.update ×3、tools.set_active_tools ×2、
// tools.register_user_tool ×13、permission.set_mode ×1），而它们的时间戳是**下一轮的**。
// 落在上一轮的尾巴上，就把「第一轮跑了多久」从 4.6 秒拉成了 30.6 分钟（03:58:12 → 04:28:45）。
// CLI 版没这么明显（16 个文件里只有 6 处 chrome 落在轮中），所以这个坑只有接了桌面版才暴露。
const KIMI_CHROME = new Set(['metadata', 'config.update', 'tools.set_active_tools', 'tools.register_user_tool', 'permission.set_mode']);

// 桌面版 Work 模式会在用户输入前面注入一段 `<meta awareness="low" timestamp="…" />`：
//   turn.prompt 的 input = [{"type":"text","text":"<meta awareness=\"low\" … />\n真正的问题"}]
// 不剥掉的话，卡片预览和详情里的「用户输入」显示的就是这行注入物，而不是用户问的话。
// 只在**最开头**剥一次，且只认这一种形状 —— 用户自己打一个 `<meta>` 开头的消息不受影响（概率极低，
// 且真遇到了也只是少显示一个标签）。
const KIMI_META = /^\s*<meta\b[^>]*>\s*/i;
export const stripKimiMeta = s => String(s || '').replace(KIMI_META, '');

// 从一条事件里挖出工作目录：工具调用入参里的 "cwd"（shell 工具跑在哪儿就是项目在哪）。
//
// 这是**给没有 session_index.jsonl 的变体兜底的**：kimi-code 的项目名来自
// ~/.kimi-code/session_index.jsonl（slug → workDir，权威），而 Kimi CLI 那套
// ~/.kimi/sessions/<md5(workdir)>/<uuid>/ 的目录名是**哈希**，反推不出来，索引文件也没有。
// 兜底只在索引没给值时生效，不会覆盖权威值。
//
// 准不准：拿本机 16 个 kimi-code 会话对过账（那批有索引当标准答案）——抓到 cwd 的 9 个**全部一致**，
// 另外 7 个压根没有带 cwd 的工具调用（没跑过 shell），抓不到就留空、退回 slug，不会编一个出来。
// 深度限 6 层：tool.call 的入参嵌在 event → args 里，再深就不是我们要的东西了。
function findCwd(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return '';
  if (typeof o.cwd === 'string' && o.cwd.trim()) return o.cwd.trim();
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') { const r = findCwd(v, depth + 1); if (r) return r; }
  }
  return '';
}

function emitKimiTurns(agent, fp, data, fromIdx) {
  const idBase = kimiIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    addEntry(idBase + t.idx, {
      // 项目名三档：索引给的（权威）> 从工具调用挖的（兜底，见 findCwd）> 目录名
      agent, project: data.cwdIdx || data.cwdGuess || data.slug || '(未知项目)', session: data.sessionId || data.sessName || '',
      time: t.time, dur: Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      rounds: t.calls, tools: t.tools, calls: t.calls,
      models: t.models, preview: t.preview,
      // 上下文占用 = 本轮**最后一次**调用的 prompt 全量（与 claude 同义），不是轮内累加；
      // 窗口**容量** kimi 这边没有（wire.jsonl 里只有用量没有窗口），只能按模型名查表（见
      // CTX_WINDOW_KINDS）：表里查不到就是 0，页面只显示占用、不画进度条 —— 与页面那段
      // 「宁可少一根条，也不要用一个假分母凑出一根像真的的条」一致。
      // 注意别留 undefined：页面 ctxUsed 取不到时会退回 e.total（轮内累加，跑多轮能到千万级），
      // 那是给「自带窗口的 agent」用的近似，套到 kimi 上会显示一个虚高的占用。
      ctx: windowOf(t.models), ctxUsed: t.ctxUsed || null,
      finished: !!t.finished, aborted: !!t.aborted, toolNames: t.toolNames || {},
    }, { file: fp, turn: t.idx, kind: 'kimi' });
  }
}

// 项目名有两个来源，**分开存**：cwdIdx 来自 session_index.jsonl（权威），cwdGuess 从工具调用里挖
// （兜底，见 findCwd）。分开放是因为它们到得晚——索引晚于文件读到、工具调用要读到那行才有——
// 合用一个字段的话先到的那档会把后到的权威值挡在外面（`if (!data.cwd)` 那句就是干这个的）。
// state.json 帮不上忙：它只有 createdAt/title/lastPrompt，没有 workDir。
// sessName / slug 由调用方传入（就是会话目录名与它上一层）：以前从 fp 往上数三层推，
// 只对 kimi-code 的 <slug>/<session>/agents/main/wire.jsonl 成立；Kimi CLI 的
// <hash>/<uuid>/wire.jsonl 少一层，会推成 hash 那一层的名字。
export function scanKimiFile(agent, fp, cwd, sessName, slug) {
  let fst; try { fst = fs.statSync(fp); } catch { return false; }
  const key = fp, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  if (prev && prev.m === m && prev.s === s) {
    if (prev.data?.turns?.length && !entries.has(kimiIdBase(fp) + (prev.data.turns.length - 1))) emitKimiTurns(agent, fp, prev.data, 0);
    return true;
  }
  const off = prev?.off || 0;
  const data = prev?.data || { sessionId: '', cwdIdx: cwd || '', cwdGuess: '', slug: slug || '', sessName: sessName || '', turns: [], emitted: 0 };
  if (!data.cwdIdx && cwd) data.cwdIdx = cwd;   // 索引值后到也要补上（它比兜底值优先）
  if (!data.slug && slug) data.slug = slug;
  if (!data.sessName && sessName) data.sessName = sessName;
  if (s <= off) { files.set(key, { agent, kind: 'kimi', m, s, off, data }); markKind('kimi'); return true; }
  try {
    const rd = readCompleteLines(fp, off, s);
    if (!rd) { files.set(key, { agent, kind: 'kimi', m, s, off, data }); markKind('kimi'); return true; }
    const newOff = rd.newOff;
    for (const line of rd.lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const ts = typeof j.time === 'number' ? j.time : 0;
      if (KIMI_CHROME.has(j.type)) continue;   // 会话 chrome 与 metadata 同处理，见 KIMI_CHROME
      // 项目名兜底：挖到了就存下（索引值优先，在 emit 那一步排序，这里不做取舍）
      // 先过一遍 '"cwd"' 子串再深挖：绝大多数事件里没有这个键，省掉每行的对象树遍历
      if (!data.cwdGuess && line.includes('"cwd"')) { const c = findCwd(j); if (c) data.cwdGuess = c; }
      if (j.type === 'turn.prompt') {
        const text0 = stripKimiMeta(toText(j.input));   // 去掉桌面版注入的 <meta …/>
        data.turns.push({
          idx: data.turns.length, time: ts, lastTs: ts,
          tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, ctxUsed: 0,
          models: [], mids: [], err: false, preview: (text0 || '').replace(/\s+/g, ' ').slice(0, 300), user: (text0 || '').slice(0, 3000),
          toolNames: {}, finished: false, aborted: false,
        });
        continue;
      }
      const cur = data.turns[data.turns.length - 1];
      if (!cur) continue;
      if (j.type === 'turn.cancel') { cur.aborted = true; cur.finished = true; if (ts) cur.lastTs = Math.max(cur.lastTs, ts); continue; }
      if (j.type === 'usage.record' && j.usage && j.usageScope === 'turn') {
        const u = j.usage;
        const inNow = (u.inputOther || 0) + (u.input || 0);
        cur.tin += inNow;
        cur.tout += u.output || 0;
        cur.tcache += (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
        cur.calls++;
        // 每次调用**覆盖**、轮内最后一次胜出 = 这一轮结束时的上下文占用（与 claude 同口径，不是累加）
        const ctxNow = inNow + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
        if (ctxNow > 0) cur.ctxUsed = ctxNow;
        const mdl = modelName(j.model);
        if (mdl && !cur.models.includes(mdl)) cur.models.push(mdl);
        if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
        continue;
      }
      if (j.type === 'context.append_loop_event' && j.event) {
        const ev = j.event;
        if (ev.type === 'tool.call') {
          cur.tools++;
          const nm = typeof ev.name === 'string' && ev.name ? ev.name : (typeof ev.tool === 'string' && ev.tool ? ev.tool : '?');
          cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
        }
        else if (ev.type === 'tool.result' && (ev.error || ev.result?.is_error)) cur.err = true;
        if (typeof j.time === 'number') cur.lastTs = Math.max(cur.lastTs, j.time);
        continue;
      }
      if (ts && ts > cur.lastTs) cur.lastTs = ts;
    }
    files.set(key, { agent, kind: 'kimi', m, s, off: newOff, data });
    markKind('kimi');
    emitKimiTurns(agent, fp, data, Math.max(0, data.emitted - 1));
    data.emitted = data.turns.length;
  } catch {}
  return true;
}

export function scanKimi(agent, root) {
  // 顺带从 session_index.jsonl 补 cwd（slug → workDir 映射就在这里，一次读全量）
  const cwdByDir = new Map();
  try {
    const idxFp = path.join(path.dirname(root), 'session_index.jsonl');
    if (fs.existsSync(idxFp)) {
      const lines = fs.readFileSync(idxFp, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.sessionDir && j.workDir) cwdByDir.set(path.normalize(j.sessionDir), j.workDir);
      }
    }
  } catch {}
  // 摆法交给 kimiWires()：kimi-code 的 agents/main/wire.jsonl 与 Kimi CLI 的裸 wire.jsonl 都在这里被收进来
  for (const { sessDir, fp: wire } of kimiWires(root)) {
    // cwd / 会话名 / slug 都在进解析器前取好：emit 发生在 scanKimiFile 内部，事后补会漏掉首扫条目
    scanKimiFile(agent, wire, cwdByDir.get(path.normalize(sessDir)) || '',
      path.basename(sessDir), path.basename(path.dirname(sessDir)));
  }
}

// 详情：重读 wire.jsonl 按 src.turn 过滤。开轮（turn.prompt 计数）与扫描同一口径，
// 用户输入同过 stripKimiMeta —— 桌面版注入的 <meta …/> 在两边都不该出现。
export function kimiEntryContent(src, full) {
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null;
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  let turnIdx = -1;
  const out = { user: '', assistant: '', tools: [], calls: [], v: version };
  const texts = new Map();  // uuid -> 正文片段（按出现顺序，见 content.part 那段注释）
  const byCall = new Map(); // toolCallId -> tool（tool.result 精确回填）
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'turn.prompt') {
      turnIdx++;
      if (turnIdx > src.turn) break;
      // 与扫描同口径：桌面版注入的 <meta …/> 前缀在这里也要剥掉，否则详情里的「用户输入」是那行注入物
      if (turnIdx === src.turn && !out.user) out.user = stripKimiMeta(toText(j.input));
      continue;
    }
    if (turnIdx !== src.turn) continue;
    if (j.type === 'usage.record' && j.usage && j.usageScope === 'turn') {
      const u = j.usage;
      out.calls.push({ model: j.model || '', tin: (u.inputOther || 0) + (u.input || 0), tout: u.output || 0, tcache: (u.inputCacheRead || 0) + (u.inputCacheCreation || 0), dur: 0 });
      continue;
    }
    if (j.type !== 'context.append_loop_event' || !j.event) continue;
    const ev = j.event;
    if (ev.type === 'text') {
      // 老写法（原样保留）：正文直接挂在 event 上
      const t0 = toText(ev.text ?? ev.content);
      // 与下面 content.part 同一套键：texts 是 Map（uuid 去重）。这里原为 texts.push —— 该分支
      // 一命中就是 TypeError（Map 没有 push），老形状日志的详情会整个读失败
      if (t0) texts.set(ev.uuid || ('#' + texts.size), t0);
    } else if (ev.type === 'content.part' && ev.part) {
      // **实际形状**（CLI protocol 1.3 与桌面版 1.4 实测一致）：正文与思考都包在
      // `event.part` 里，`part.type` 是 'text' | 'think'。原来只认 `ev.type === 'text'`，
      // 而 ev.type 永远是 'content.part' —— 那个分支从接入起就没命中过，所以 kimi 的详情
      // 一直**没有助手正文**（卡片能出数字、能出用户输入，唯独正文那一段是空的）。
      // 这里只取正文；think 是模型推理过程，与其它 agent 一样不落详情。
      // 按 uuid 去重：实测两个版本都不重复写，但万一将来改成流式覆盖写，直接 push 会拼出重复正文。
      if (ev.part.type === 'text') {
        const t0 = toText(ev.part.text ?? ev.part.content);
        if (t0) texts.set(ev.uuid || ('#' + texts.size), t0);
      }
    } else if (ev.type === 'tool.call') {
      const fi = {};
      const t = { name: ev.name || '?', tid: ev.toolCallId || null, input: trunc(ev.args ?? ev.arguments, full, fi), inputTrunc: !!fi.t, output: '', error: null };
      out.tools.push(t);
      if (t.tid) byCall.set(t.tid, t);
    } else if (ev.type === 'tool.result') {
      const t = (ev.toolCallId && byCall.get(ev.toolCallId)) || out.tools.find(x => !x.output);
      if (t) {
        const fo = {};
        t.output = trunc(ev.result ?? ev.output, full, fo);
        t.outputTrunc = !!fo.t;
        t.error = !!(ev.error || ev.result?.is_error);
      }
    }
  }
  out.assistant = [...texts.values()].join('\n\n---\n\n');
  return out;
}
