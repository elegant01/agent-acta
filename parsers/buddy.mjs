// ---------------- buddy jsonl（codebuddy / workbuddy：<base>/projects/<slug>/<sessionId>.jsonl） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanBuddy / buddyEntryContent
// 与口径函数（buddyUserText / buddyCall / buddyPreview —— 详情与扫描共用同一套）。
//
// 与 claude 同族的逐行 jsonl，但记录类型不同：
//   {"type":"message","role":"user"|"assistant"} 开轮/正文
//   {"type":"function_call"} / {"type":"function_call_result"}（callId 配对）/ {"type":"reasoning"}
//   {"type":"turn-metrics","durationMs","tokenDelta"} 一轮收尾 → 精确耗时
//   {"type":"ai-title","aiTitle"} 会话标题
// 两个必须知道的格式坑：
//   1) 用户真实输入常被包在 <system-reminder>（IDE 注入）里，真正的 prompt 在 <user_query> 中
//      （workbuddy 几乎全是这种），codebuddy 多数是裸文本 —— 先取 user_query，再剥 system-reminder 段。
//   2) token 用量挂在「每次 LLM 调用」的记录上，既可能在 message:assistant 也可能在 function_call，
//      按 providerData.messageId 去重累加（实测累加值 == turn-metrics.tokenDelta，可互相校验）；
//      且 usage.input_tokens 含缓存命中，要减去 cache_read_input_tokens 才与 claude 口径一致。
//   3) 同一条用户消息会被源重写一次（jsonl 只追加 → 两行、`id` 相同，第二行把同一段话包进
//      <user_query>），两边时间戳与抽取正文一致 —— 开轮按 `id` 去重（扫描/详情同一判据），
//      否则一张卡变两张（本机 149 份会话实测 7 对）。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, markKind, listDirCached, isDir, trunc, readCompleteLines } from './shared.mjs';

export const BUDDY_SKIP_RE = /^(<command-name>|<local-command|<system-reminder|<cb_summary>)/;

export function buddyUserText(content) {
  const blocks = Array.isArray(content) ? content : [];
  const raw = blocks.map(b => (typeof b === 'string' ? b : String(b?.text || ''))).join('\n');
  if (!raw.trim()) return '';
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw);
  if (q && q[1].trim()) return q[1].replace(/\s+/g, ' ').trim();
  const rest = raw.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!rest || BUDDY_SKIP_RE.test(rest)) return ''; // 纯注入/命令消息不开新轮（与详情同口径）
  return rest;
}

export function buddyUsage(j) {
  const u = j.message?.usage || j.providerData?.usage;
  const raw = j.providerData?.rawUsage;
  if (!u && !raw) return null;
  const inAll = u?.input_tokens ?? raw?.prompt_tokens ?? 0;
  // 两处都有可能带缓存命中数，取大者（口径：input_tokens 含缓存）
  const cache = Math.max(u?.cache_read_input_tokens || 0, raw?.prompt_tokens_details?.cached_tokens || 0);
  const tout = u?.output_tokens ?? raw?.completion_tokens ?? 0;
  return { tin: Math.max(0, inAll - cache), tout, tcache: cache };
}

// 一条 LLM 调用的用量（调用可能是 assistant 文本，也可能是 function_call，共用一个 messageId）
export function buddyCall(j) {
  const pd = j.providerData || {};
  return { mid: pd.messageId || j.id || null, model: pd.requestModelName || pd.model || '', usage: buddyUsage(j) };
}

// 预览文案：后台任务通知 / 队友消息 / 压缩摘要同样会开轮（它们确实在烧 token），但预览要把 XML 标签换成看得懂的字
export function buddyPreview(t) {
  const tn = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(t);
  if (tn) {
    const s = /<summary>([\s\S]*?)<\/summary>/.exec(tn[1]);
    return ('[后台任务] ' + (s ? s[1] : tn[1])).replace(/\s+/g, ' ').trim();
  }
  const tm = /<teammate-message[^>]*>([\s\S]*?)<\/teammate-message>/.exec(t);
  if (tm) return ('[队友消息] ' + tm[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (/^<(cb_summary|conversation_history_summary)>/.test(t)) return ('[历史摘要] ' + t.replace(/<\/?[a-z_]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t.replace(/\s+/g, ' ').trim();
}

export function buddyIdBase(fp) { return 'b#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function emitBuddyTurns(agent, fp, slug, data, fromIdx) {
  const idBase = buddyIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    addEntry(idBase + t.idx, {
      agent, project: data.cwd || slug, session: data.sessionId || path.basename(fp, '.jsonl'),
      time: t.time, dur: t.dur || Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      ctx: 0, rounds: t.calls, tools: t.tools, calls: t.calls, // 同 claude：rounds=calls=轮内 LLM 调用数
      models: t.models, preview: t.preview, name: data.title || null, // name=会话标题（无模型信息时前端用它兜底）
      finished: !!t.finished, aborted: !!t.aborted, toolNames: t.toolNames || {},
    }, { file: fp, turn: t.idx, kind: 'buddyjsonl' });
  }
}

export function scanBuddy(agent, root, onlyFile) { // onlyFile 见 scanClaude 的说明
  const slugs = listDirCached(root);
  if (!slugs) return;
  const onlyDir = onlyFile ? path.dirname(onlyFile) : null; // 同 scanClaude：排在 isDir 之前，省掉 slug 数 × 文件数次 stat
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    if (onlyDir && dir !== onlyDir) continue;
    if (!isDir(dir)) continue;
    const names = listDirCached(dir);
    if (!names) continue;
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const fp = path.join(dir, n);
      if (onlyFile && fp !== onlyFile) continue;
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) {
        // 重启后 entries 为空但 files 状态被恢复：从状态直接重建条目，不重扫文件
        if (prev.data?.turns?.length && !entries.has(buddyIdBase(fp) + (prev.data.turns.length - 1))) emitBuddyTurns(agent, fp, slug, prev.data, 0);
        continue;
      }
      const off = prev?.off || 0;
      const data = prev?.data || { cwd: '', title: '', sessionId: '', turns: [], emitted: 0, uids: [] };
      if (s <= off) { files.set(key, { agent, kind: 'buddyjsonl', m, s, off, data }); markKind('buddyjsonl'); continue; }
      try {
        const rd = readCompleteLines(fp, off, s);
        if (!rd) { files.set(key, { agent, kind: 'buddyjsonl', m, s, off, data }); markKind('buddyjsonl'); continue; } // 尚无完整行
        const newOff = rd.newOff;
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.cwd && !data.cwd) data.cwd = j.cwd;
          if (j.sessionId) data.sessionId = j.sessionId;
          if (j.type === 'ai-title' && j.aiTitle) data.title = String(j.aiTitle).slice(0, 60);
          if (j.type === 'message' && j.role === 'user') {
            const t0 = buddyUserText(j.content);
            if (!t0) continue;
            // 同一条用户消息会被源**原地重写**一次（jsonl 只追加，故落盘两行、`id` 相同）：
            // 先一行裸文本、紧跟一行把同一段话包进 <user_query>（实测 149 份会话共 7 对，
            // 两边的时间戳与抽取后的正文完全一致）。不去重就一张卡变两张。
            const umsg = j.id || null;
            if (umsg) {
              if (data.uids.includes(umsg)) continue;
              data.uids.push(umsg);
            }
            const ts = j.timestamp || 0;
            if (data.turns.length) data.turns[data.turns.length - 1].finished = true;
            data.turns.push({
              idx: data.turns.length, time: ts, lastTs: ts, dur: 0,
              tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, mids: [], models: [], err: false,
              preview: buddyPreview(t0).slice(0, 300), toolNames: {}, finished: false, aborted: false,
            });
            continue;
          }
          const cur = data.turns[data.turns.length - 1];
          if (!cur) continue;
          if (j.type === 'turn-metrics') {
            // 一轮收尾：durationMs 是从本轮开始到此刻的真实耗时（比相邻时间戳推算准）
            cur.dur = j.durationMs || 0;
            cur.finished = true;
          } else if (j.type === 'function_call') {
            cur.tools++;
            const nm = typeof j.name === 'string' && j.name ? j.name : (typeof j.toolName === 'string' && j.toolName ? j.toolName : '?');
            cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
          } else if (j.type !== 'message' && j.type !== 'function_call_result') {
            continue;
          }
          const c = buddyCall(j);
          if (c.mid && cur.mids.includes(c.mid)) {
            // 同一次 LLM 调用的多条记录（正文 + 工具调用）已计过用量
          } else if (c.usage) {
            cur.mids.push(c.mid);
            cur.calls++;
            cur.tin += c.usage.tin; cur.tout += c.usage.tout; cur.tcache += c.usage.tcache;
          }
          if (c.model && !cur.models.includes(c.model)) cur.models.push(c.model);
          if (j.status === 'error' || j.status === 'failed') cur.err = true;
          if (j.timestamp) cur.lastTs = Math.max(cur.lastTs, j.timestamp);
        }
        files.set(key, { agent, kind: 'buddyjsonl', m, s, off: newOff, data });
        markKind('buddyjsonl');
        // 从最后一个已发轮起重发（进行中的轮会被原地更新）
        emitBuddyTurns(agent, fp, slug, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}

// 详情：重读 jsonl 按 src.turn 过滤。开轮判定与用量去重都走扫描侧同一套函数
// （buddyUserText / buddyCall，同一条 messageId 只算一次），两边口径对齐。
export function buddyEntryContent(src, full) {
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null;
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  let turnIdx = -1, prevTs = 0;
  const out = { user: '', assistant: '', tools: [], calls: [], v: version };
  const texts = [];
  const byMid = new Set();   // 同一次 LLM 调用的多条记录只算一次用量
  const byCallId = new Map(); // function_call_result 按 callId 精确回填（并行调用不错位）
  // 正文和用量常常**不在同一条记录上**：纯工具调用那几次的用量挂在 function_call 那条，
  // 正文挂在 message/assistant 那条，两边靠 providerData.messageId 关联。
  // 实测 20 份会话：313 个带正文的 mid，只有 102 个的正文与用量同条。
  // 所以整篇读完再按 mid 回填，别在读到正文的那一刻就往上挂（那时还不知道它属于哪次调用）。
  const callByMid = new Map();  // mid -> 这一行明细
  const textByMid = new Map();  // mid -> 这次调用自己产出的正文
  const toolsByMid = new Map(); // mid -> 这次调用发起了哪些工具（同一次响应并行调几个就有几条记录）
  const seenUser = new Set();   // 同 id 的用户消息是源自己重写的第二条，扫描侧不开轮，这里也不能数
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'message' && j.role === 'user') {
      const t0 = buddyUserText(j.content);
      if (!t0) continue; // 与 scanBuddy 同口径跳过注入/命令消息
      if (j.id) {
        if (seenUser.has(j.id)) continue;
        seenUser.add(j.id);
      }
      turnIdx++;
      if (turnIdx > src.turn) break;
      if (turnIdx === src.turn) { out.user = t0; prevTs = j.timestamp || 0; }
      continue;
    }
    if (turnIdx !== src.turn) continue;
    const ts = j.timestamp || 0;
    if (j.type === 'message' && j.role === 'assistant') {
      // 与 scanBuddy 同一口径：只在「带用量的记录」上按 messageId 去重计一次
      const c = buddyCall(j);
      if (c.usage && !(c.mid && byMid.has(c.mid))) {
        if (c.mid) byMid.add(c.mid);
        const call = { model: c.model, tin: c.usage.tin, tout: c.usage.tout, tcache: c.usage.tcache, dur: ts && prevTs ? Math.max(0, ts - prevTs) : 0 };
        out.calls.push(call);
        if (c.mid) callByMid.set(c.mid, call);
      }
      for (const b of (Array.isArray(j.content) ? j.content : [])) {
        if (!b || b.type !== 'output_text' || !b.text) continue;
        const seg = String(b.text);
        texts.push(seg);
        // 正文记在当前记录自己的 mid 上（与上面记调用用的是同一个 messageId）
        if (c.mid) textByMid.set(c.mid, textByMid.has(c.mid) ? textByMid.get(c.mid) + '\n' + seg : seg);
      }
    } else if (j.type === 'function_call') {
      const c = buddyCall(j);
      if (c.usage && !(c.mid && byMid.has(c.mid))) {
        if (c.mid) byMid.add(c.mid);
        const call = { model: c.model, tin: c.usage.tin, tout: c.usage.tout, tcache: c.usage.tcache, dur: ts && prevTs ? Math.max(0, ts - prevTs) : 0 };
        out.calls.push(call);
        if (c.mid) callByMid.set(c.mid, call);
      }
      const fi = {};
      const tool = {
        name: j.name || '?', tid: j.callId || null, ts,
        input: trunc(j.arguments ?? '', full, fi), inputTrunc: !!fi.t,   // 过 toText（trunc 内），别在这里 String() 掉对象
        output: '', error: null,
      };
      out.tools.push(tool);
      if (tool.tid) byCallId.set(tool.tid, tool);
      if (c.mid) {
        const arr = toolsByMid.get(c.mid);
        if (arr) arr.push(tool.name); else toolsByMid.set(c.mid, [tool.name]);
      }
    } else if (j.type === 'function_call_result') {
      // callId 精确配对；无 id 时退回第一个空 output（旧格式）
      const t = (j.callId && byCallId.get(j.callId)) || out.tools.find(x => !x.output);
      if (t) {
        const o = j.output;
        const fo = {};
        t.output = trunc(o, full, fo);   // 同 claude：内容块/对象的拆解统一交给 toText()
        t.outputTrunc = !!fo.t;
        if (j.status && j.status !== 'completed') t.error = j.status;
        if (ts && t.ts) t.dur = Math.max(0, ts - t.ts); // 工具自身耗时：调用 → 结果
      }
    } else {
      continue;
    }
    if (ts) prevTs = ts;
  }
  for (const [mid, call] of callByMid) {
    const seg = textByMid.get(mid);
    if (seg) {
      const ft = {};
      call.text = trunc(seg, full, ft); call.textTrunc = !!ft.t;
    }
    const tl = toolsByMid.get(mid);
    if (tl && tl.length) call.tools = tl;
  }
  out.assistant = texts.join('\n');
  return out;
}
