// ---------------- cline 解析器（Cline CLI 3.x：~/.cline/data/sessions/<会话 id>/<会话 id>.messages.json） ----------------
// 真机口径（2026-09-24 用本机 CLI 3.0.64 的活会话逐字段核过，不是照社区文档写的）。Cline 家目录 `~/.cline/`：
//   <data>/sessions/<sid>/<sid>.messages.json   ← **主源**（本文件只读它 + 下面的清单）
//   <data>/sessions/<sid>/<sid>.json            ← 清单：cwd / model / provider / status / metadata.title
//   <data>/sessions/<sid>/<sid>.compaction.json ← 压缩快照（**不读**，理由见下）
//   <data>/db/sessions.db                         ← 会话索引（字段与清单重复，**不读**）
//   <data>/settings/providers.json                ← ⚠️ 明文 apiKey，**一个字节都不许读**（同 secrets.json / globalState.json）
// 本机 Windows 的 data 根就是 `~/.cline/data`；`CLINE_SESSION_DATA_DIR` 可整体改写会话根（discovery 认这个变量）。
//
// **整份 JSON，不是 JSONL** —— `{version, updated_at, agent, sessionId, origin, messages[], system_prompt}`，
// 会话进行中每次落盘都是**整份重写**（实测 33 → 37 → 39 条，`updated_at` 跟着变）。所以没有字节偏移可续读，
// 与 hermes / opencode / dsh 同一路数：按 `{mtime,size}` 签名整份重解析，签名没变就跳过。
// ⇒ **不进 OFF_KINDS**（本 kind 的 files 状态根本不落 index，重启即整份重扫）；
//   `PARSER_REV.cline` 仍然登记，它在这里管的是 `~/.agent-acta/search/` 那份全文分片的作废。
// 签名带清单：清单里的 `status`/`metadata.title` 变了（换标题、会话结束）也要重解析，否则 name 会长期是旧的。
//
// 消息形状（messages[] 元素）：
//   {id, role, content[], ts(毫秒),                // user 与 assistant 都有
//    modelInfo:{id, provider}, metrics:{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}  // 只有 assistant 有
// content 块只有三种：{type:"text",text} / {type:"tool_use",id,name,input(对象)} / {type:"tool_result",tool_use_id,name,content[]}
//
// ⚠️ 两个会把解析器写废的形状陷阱：
//   1. **tool_result 也是 `role:"user"`** —— 切轮只看 role 的话，本机这一份 39 条的会话会被切成 23 轮
//      （真实只有 8 轮）。开轮判据必须是「role==="user" **且** content 里有非空 text 块」，
//      扫描侧与详情侧共用 `clineUserInput()` 这一个函数，否则「扫到第 N 轮」与「详情第 N 轮」会错位。
//   2. 用户正文被产品自己的标签包着：`<user_input mode="act">…</user_input>`（切模式时另有
//      `<mode_notice>…</mode_notice>`）—— 不剥壳，卡片预览就是一串标签，搜索也搜不到正文。
//
// ⚠️ token 口径与 openclaw / minimax **相反**：这里的 `inputTokens` 就是**整次请求的 prompt 总量，
//    cacheRead/cacheWrite 是它的子集**，不是「不含 cache」的净输入。三条独立证据（本机实测）：
//   · 二进制里的用量归一化（cline.exe 内 `inputTokens: e8(X,"inputTokens","total") || t8(X,…,"prompt_tokens")`、
//     `cacheReadTokens: … || e8(X,"prompt_tokens_details","cached_tokens")`）—— OpenAI 语义下
//     cached_tokens 本来就是 prompt_tokens 的子集；
//   · 同一份二进制里的成本函数按 `inputTokens - cacheReadTokens - cacheWriteTokens` 才当未命中缓存的输入计价；
//   · 实测逐次增量：第 2 次调用若按「input 不含 cache」解释，prompt 会从 8378 变成下一次的 7868（**负增长**），
//     而按「input 就是 prompt 总量」解释，相邻差值 633/2093/… 恰好对上中间那些消息的字符数。
// ⇒ tin = max(0, inputTokens − cacheReadTokens − cacheWriteTokens)（净输入），tcache = 两个 cache 桶之和，
//   total = tin + tout + tcache = inputTokens + outputTokens（与产品自己的口径一致）；
//   ctxUsed = 轮内**最后一次**调用的 inputTokens。逐条相加 == 清单/库里的会话级 usage（实测 440706/8187/365056/0 全等）。
// ⚠️ 另因为此：**inputTokens 同会话内不单调**（/compact 之后第一次请求从 43662 掉到 19526）。它既不是累计值、
//   也不能拿相邻差值推轮边界 —— 轮边界只用上面那条 role+text 判据。
//
// 轮口径：user(text 非空) 开轮 → 轮内多条 assistant（工具循环）聚合成一条 entry → 下一条 user 收轮。
//   time = 该 user 消息的 ts；dur = 轮内最后一条消息的 ts − time（tool_result 也带 ts，参与 lastTs）。
//
// 失败口径（这是本 kind 唯一的失败信号，源头给的就这一处）：
//   tool_result 的 content[] 是**逐项**结果 `{query, result, success, error?}`，批量调用里可以只有一条失败
//   （本机实测 fetch 404/403 与 `Command exited with code 1`）。success===false 或有 error → 该工具标红 +
//   整轮 status=error（与 minimax / openclaw 的 isError 同口径），错误原文进详情 callsNote。
//   ⚠️ **模型侧失败不落盘**：assistant 行没有 stopReason / errorMessage 这种字段，请求挂掉就是少一行，
//   所以没有「这一轮失败了」的通用判据 —— 认不出来的失败宁可不标，也不拿「缺 assistant」猜成失败。
//   同理：会话级才有 status（idle/running…）与 exit_code，**逐轮**没有状态、没有耗时字段、没有成本
//   （本机第三方 provider 的 totalCost 恒 0）⇒ aborted 恒 false、calls[].dur 恒 0（逐工具耗时能算，见详情）。
//   ctx（窗口容量分母）**一律 0**：模型目录（contextWindow / maxInputTokens）只嵌在 144MB 的 cline.exe 里，
//   盘上没有任何 JSON 版本（data/ 全目录 grep contextWindow 零命中）—— 不编分母，页面退化成只显示占用。
//
// **不读 `<sid>.compaction.json`**：/compact 是**纯投影、不是记账事件** —— 实测它写出快照（1 条合成的
//   `Context summary:` user 消息 + 尾部原样搬运）之后，messages.json **一个字节都没改**、库里的 usage 也不变，
//   全量流水照旧单调追加。读它会把同一批消息数两遍（那份快照里连 metrics 都是复制的）。
// **不读 `data/db/sessions.db`**：它是清单的超集，字段全重；只有 lineage（parent_session_id / is_subagent /
//   agent_id）是独有的 —— 将来要标子会话再从它取，现在不值得为多一个活 SQLite 源付每轮扫描的代价。
// **不读 `data/db/hub-events-*.db`**：那里的 iteration/tool 事件确实带逐次耗时，但它是 hub（teams）守护进程
//   的事件流水，会话不经过 hub 就没有行 —— 拿它当主源会让同一份会话有两种详略不同的形状。
import fs from 'node:fs';
import path from 'node:path';
import {
  files, entries, srcs, removedIds, sorted, addEntry,
  modelName, toText, trunc, listDirCached, isDir, isFile,
} from './shared.mjs';

export const clineScanErr = new Map();
// 会话根可被环境变量整体改写（CLI 自己认这个），discovery 的 candidateBases 要用
export const CLINE_SESSION_DATA_ENV = 'CLINE_SESSION_DATA_DIR';

// id 前缀 `cl#`：与 claude 的、codex 的 `x#`、openclaw 的 `oc#`、kilo 的 `kl#` 都不撞
export function clineIdBase(msgPath) { return 'cl#' + String(msgPath).replace(/[\\/:]/g, '~') + '#'; }
function turnSuffix(key) { return String(key == null ? '' : key).replace(/#/g, '~'); }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function safeJson(raw) {
  if (raw && typeof raw === 'object') return raw;      // 清单里 metadata 本来就是对象（库里的 metadata_json 才是字符串）
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------- 用户正文：只取 text 块 + 剥产品自己的标签 ----------------
// 必须**先按块类型挑**再交给 toText：tool_result 块没有 text 字段却有 content 数组，
// 整块 toText 会把工具返回原文当成「用户说的话」—— 于是每一条工具结果都开一个幽灵轮。
export function clineUserText(s) {
  let t = toText(s);
  t = t.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/gi, '');
  t = t.replace(/<\/?user_input\b[^>]*>/gi, '');
  return t.trim();
}
export function clineUserInput(content) {
  if (typeof content === 'string') return clineUserText(content);
  if (!Array.isArray(content)) return '';
  const buf = [];
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') buf.push(b.text);
  return clineUserText(buf.join('\n\n'));
}
// assistant 正文：Cline 目前只有 text 块（没有 thinking 块），仍按 type 挑，
// 免的哪天多了 reasoning/tool_result 块被 toText 兜底塞进正文。
function clineAssistantText(content) {
  if (typeof content === 'string') return toText(content);
  if (!Array.isArray(content)) return '';
  const buf = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') buf.push(b.text);
    else if ((b.type === 'thinking' || b.type === 'reasoning') && typeof b.text === 'string') buf.push(b.text);
  }
  return buf.join('\n\n');
}

// 一次工具调用的入参：input 是**对象**（{path, content} 这种）。不能丢给 toText ——
// toText 见到 `content` 字段就只回那段正文，路径会被吞掉（写文件工具正好长这样）。
function toolArgsText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2); } catch { return toText(input); }
}
// 工具出参：content[] 是**逐项**结果 `{query, result, success, error?}`（也可能是纯字符串，老版本/别的工具）。
// 返回 {text, error}：error 取第一条失败项的原文（批量调用可以只错一项）。
function toolResultText(content) {
  const arr = Array.isArray(content) ? content : (content == null ? [] : [content]);
  const buf = [];
  let error = '';
  for (const e of arr) {
    if (e == null) continue;
    if (typeof e === 'string') { buf.push(e); continue; }
    if (e.success === false || e.error) error = error || String(e.error || e.result || '工具执行失败');
    const r = typeof e.result === 'string' ? e.result : (e.text != null ? toText(e.text) : toText(e));
    if (typeof e.query === 'string' && e.query) buf.push('▸ ' + e.query + '\n' + r);
    else buf.push(r);
  }
  return { text: buf.join('\n\n'), error };
}

// ---------------- 轮：整份 messages[] → turns[] ----------------
// 只存**卡片需要**的聚合量（正文/出入参不进内存：本 kind 一个会话就是一整份 JSON，
// 十几个长会话就能到 MB 级），详情侧按 src.turn 重读文件（与 openclaw 同一套分工）。
function buildTurns(messages) {
  const turns = [];
  let cur = null;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const ts = num(m.ts);
    if (role === 'user') {
      const text = clineUserInput(m.content);
      if (!text) {
        // 只有 tool_result 的 user 行：不开轮，但它**是轮内发生过的最新一件事** —— 不带进 lastTs 的话
        // 「以工具收尾」的那一轮耗时会短一截（实测能差几秒）
        if (cur && ts) cur.lastTs = Math.max(cur.lastTs, ts);
        if (cur) readToolFailures(m.content, cur);
        continue;
      }
      cur = {
        key: typeof m.id === 'string' && m.id ? m.id : 'i' + turns.length,
        time: ts, lastTs: ts,
        tin: 0, tout: 0, tcache: 0, ctxUsed: 0,
        calls: 0, tools: 0, models: [], toolNames: {},
        err: false, errMsg: '',
        preview: text.replace(/\s+/g, ' ').slice(0, 300),
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;                       // 首条用户消息之前的东西（防御：真实数据里没有）
    if (role === 'assistant') {
      if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
      cur.calls++;
      const u = m.metrics;
      if (u) {
        const cr = num(u.cacheReadTokens), cw = num(u.cacheWriteTokens), prompt = num(u.inputTokens);
        // ⚠️ inputTokens **含** cache（见文件头），净输入要减掉两个 cache 桶
        cur.tin += Math.max(0, prompt - cr - cw);
        cur.tout += num(u.outputTokens);
        cur.tcache += cr + cw;
        if (prompt > 0) cur.ctxUsed = prompt;   // 上下文占用 = 末次调用的 prompt 全量
      }
      const mdl = modelName(m.modelInfo && m.modelInfo.id);
      if (mdl && !cur.models.includes(mdl)) cur.models.push(mdl);
      for (const b of (Array.isArray(m.content) ? m.content : [])) {
        if (!b || b.type !== 'tool_use') continue;
        const nm = typeof b.name === 'string' && b.name ? b.name : '?';
        cur.tools++;
        cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
      }
      continue;
    }
    if (ts) cur.lastTs = Math.max(cur.lastTs, ts);   // 别的角色（system 等）只贡献时间，不进轮统计
  }
  return turns;
}

// 工具失败：逐项 success/error（这是本 kind 唯一可得的失败信号）
function readToolFailures(content, cur) {
  for (const b of (Array.isArray(content) ? content : [])) {
    if (!b || b.type !== 'tool_result') continue;
    const { error } = toolResultText(b.content);
    if (error && !cur.err) { cur.err = true; cur.errMsg = error; }
  }
}

// ---------------- emit：一轮一条 entry ----------------
function emit(agent, msgPath, data, prevData) {
  const base = clineIdBase(msgPath);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = base + turnSuffix(t.key);
    ids.add(id);
    addEntry(id, {
      agent,
      project: data.project,
      session: data.sid,
      name: data.name || undefined,
      time: t.time,
      dur: Math.max(0, (t.lastTs || t.time) - t.time),
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: 0,                              // 窗口容量只在 CLI 二进制里，盘上没有 —— 不编分母
      ctxUsed: t.ctxUsed || 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1, // 末轮交给页面按最近时间兜底（同 openclaw / hermes）
      aborted: false,                      // 逐轮无中断信号（会话级 status 不是逐轮的）
      toolNames: t.toolNames,
    }, { file: msgPath, turn: i, kind: 'cline' });
  });
  // 整份重写会一次性丢掉轮（比如手工编辑过会话文件）：按 id 集合回收，否则老条目悬在页面上
  for (const old of (prevData && prevData.ids) || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

// ---------------- 主源枚举（discovery 的 sniffBase 与手工添加共用） ----------------
// 一个 sessions 根下的 (会话 id, messages.json, 清单)：只认「目录里有 *.messages.json」的形状。
function sessionDirs(root, limit) {
  const out = [];
  const names = listDirCached(root);
  if (!names) return out;
  for (const sid of names.slice(0, limit || 400)) {
    const dir = path.join(root, sid);
    if (!isDir(dir)) continue;
    const inner = listDirCached(dir);
    if (!inner) continue;
    const want = sid + '.messages.json';
    let msgPath = inner.includes(want) ? path.join(dir, want) : null;
    if (!msgPath) {
      const alt = inner.find(n => n.endsWith('.messages.json'));
      if (alt) msgPath = path.join(dir, alt);
    }
    if (!msgPath || !isFile(msgPath)) continue;
    let manPath = path.join(dir, sid + '.json');
    if (!isFile(manPath)) {
      const alt = inner.find(n => n.endsWith('.json') && !n.endsWith('.messages.json') && !n.endsWith('.compaction.json'));
      if (alt) manPath = path.join(dir, alt);
    }
    out.push({ sid, dir, msgPath, manPath });
  }
  return out;
}

// 内容判据（嗅探每 3s 一轮，读盘量必须卡死）：整份 JSON 是**pretty-printed**，头几个键就在最前面，
// 所以只读头 2KB，要求同时出现 `"sessionId"` 与 `"messages": [`。文件名再兜一道 `.messages.json`。
export function isClineMessages(fp) {
  if (!/\.messages\.json$/i.test(String(fp))) return false;
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    if (n <= 0) return false;
    const head = buf.toString('utf8', 0, n);
    return /^\s*\{/.test(head) && /"sessionId"\s*:/.test(head) && /"messages"\s*:\s*\[/.test(head);
  } catch { return false; } finally { try { fs.closeSync(fd); } catch {} }
}

// 手工添加时用户可能填任意一层：`~/.cline` / `<home>/.cline/data` / `<...>/data/sessions` / 某个会话目录 /
// 甚至直接填那份 `*.messages.json`。返回 {root: <sessions 目录>, files:[{sid,msgPath,manPath}]}；认不出返回 null。
export function clineTranscripts(base) {
  if (isFile(base) && isClineMessages(base)) {
    const dir = path.dirname(base);
    return { root: dir, files: [{ sid: path.basename(dir), msgPath: base, manPath: path.join(dir, path.basename(dir) + '.json') }] };
  }
  if (!isDir(base)) return null;
  const bn = path.basename(base).toLowerCase();
  const cands = [];
  if (bn === 'sessions') cands.push(base);
  else if (bn === 'data') cands.push(path.join(base, 'sessions'));
  else if (bn === '.cline' || bn === 'cline') cands.push(path.join(base, 'data', 'sessions'), path.join(base, 'sessions'));
  else {
    cands.push(base);                                       // 填的就是 sessions 根
    cands.push(path.join(base, 'sessions'));                // 填的是 data 那一层
    cands.push(path.dirname(base));                         // 填的是某个会话目录 → 父目录才是 sessions 根
  }
  for (const root of [...new Set(cands)]) {
    if (!isDir(root)) continue;
    const hit = sessionDirs(root, 12).filter(s => isClineMessages(s.msgPath));
    if (hit.length) return { root, files: hit };
  }
  return null;
}

// ---------------- 清单（会话级元数据）----------------
// 只取 cwd / workspace_root / metadata.title / status —— **不**把 systemPrompt、usage 之外的内容带出去。
function readManifest(fp) {
  const out = { project: '', name: '', status: '' };
  let j; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return out; }
  if (!j || typeof j !== 'object') return out;
  if (typeof j.cwd === 'string' && j.cwd) out.project = j.cwd;
  else if (typeof j.workspace_root === 'string' && j.workspace_root) out.project = j.workspace_root;
  if (typeof j.status === 'string') out.status = j.status;
  const md = safeJson(j.metadata);
  if (md && typeof md.title === 'string' && md.title.trim()) out.name = md.title.trim();
  return out;
}

// ---------------- 扫描主入口 ----------------
// root = sessions 目录（由 discovery 的 sniffBase 解析出来，不是 ~/.cline 那一层）
export function scanCline(agent, root, onlyFile) {
  if (!isDir(root)) return;
  for (const s of sessionDirs(root)) {
    if (onlyFile && s.msgPath !== onlyFile) continue;
    let mst; try { mst = fs.statSync(s.msgPath); } catch { continue; }
    let ast = null; try { ast = fs.statSync(s.manPath); } catch {}
    const sig = mst.mtimeMs + '|' + mst.size + '#' + (ast ? ast.mtimeMs + '|' + ast.size : '-');
    const key = s.msgPath;
    const prev = files.get(key);
    if (prev && prev.data && prev.data.sig === sig) {
      // 本 kind 不落 index：重启后 files 也可能从「本轮更早那次扫描」带来，条目却已被清掉 → 按内存里那份重建
      const last = prev.data.turns && prev.data.turns[prev.data.turns.length - 1];
      if (last && !entries.has(clineIdBase(key) + turnSuffix(last.key))) emit(agent, key, prev.data, null);
      continue;
    }
    let payload;
    try { payload = JSON.parse(fs.readFileSync(s.msgPath, 'utf8')); } catch (e) {
      clineScanErr.set(agent, s.msgPath + ' 读不动（整份 JSON 解析失败）：' + e.message);
      continue;
    }
    if (!payload || !Array.isArray(payload.messages)) {
      clineScanErr.set(agent, s.msgPath + ' 里没有 messages[] —— 不是认得的 Cline 会话文件');
      continue;
    }
    clineScanErr.delete(agent);
    const man = readManifest(s.manPath);
    const turns = buildTurns(payload.messages);
    const data = {
      sig, sid: s.sid, turns,
      project: man.project || '(cline)',
      name: man.name,
      status: man.status,
      rev: (prev && prev.data ? (prev.data.rev || 0) : 0) + 1,
    };
    files.set(key, { agent, kind: 'cline', m: mst.mtimeMs, s: mst.size, off: 0, data });
    emit(agent, key, data, prev && prev.data);
  }
}

// ---------------- 详情：重读整份 JSON，按 src.turn 过滤 ----------------
// 开轮判据与扫描侧是同一个函数（clineUserInput），所以「扫到的第 N 轮」必定就是「详情的第 N 轮」。
export function clineEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + st.s : null;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(src.file, 'utf8')); } catch { return null; }
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const out = {
    user: '', assistant: '', tools: [], calls: [], v: version,
    callsNote: 'Cline CLI 的 sessions/<id>.messages.json 是**整份 JSON、每次落盘整体重写**（不是 JSONL）：' +
      '逐次用量挂在每条 assistant 消息的 metrics 上。metrics.inputTokens **含**缓存（cacheRead/Write 是它的子集，' +
      '与 openclaw/minimax 相反），故 tin = input − cacheRead − cacheWrite、tcache = 两个 cache 桶之和、' +
      'ctxUsed = 本轮末次调用的 input。⚠️ /compact 之后 inputTokens 会**回落**（上下文被换成了摘要），' +
      '它不是累计值。逐次调用耗时不落盘，故 calls[].dur 恒 0（逐工具耗时按 tool_use→tool_result 的 ts 差算，在 tools[].dur）。',
  };
  const texts = [];
  const notes = new Set();
  let turnIdx = -1;
  let toolCount = 0;
  let prevAssistant = null;   // 逐次调用与它发出的 tool_use 配对（详情里只挂名字）
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const ts = num(m.ts);
    if (m.role === 'user') {
      const text = clineUserInput(m.content);
      if (!text) {
        if (turnIdx === src.turn) {
          for (const b of (Array.isArray(m.content) ? m.content : [])) {
            if (!b || b.type !== 'tool_result') continue;
            const t = out.tools.find(x => x.tid && x.tid === b.tool_use_id) ||
              out.tools.find(x => !x.filled && x.name === b.name);
            if (!t) { notes.add('有工具返回找不到对应的调用（可能是上一轮被压缩掉的调用）'); continue; }
            t.filled = true;
            const { text: ot, error } = toolResultText(b.content);
            const fo = {};
            t.output = trunc(ot, full, fo); t.outputTrunc = !!fo.t;
            if (error) t.error = error;
            if (ts && t.ct) t.dur = Math.max(0, ts - t.ct);
          }
        }
        continue;
      }
      turnIdx++;
      if (turnIdx === src.turn) out.user = text;
      if (turnIdx > src.turn) break;
      continue;
    }
    if (m.role !== 'assistant' || turnIdx !== src.turn) continue;
    const u = m.metrics;
    const cr = u ? num(u.cacheReadTokens) : 0;
    const cw = u ? num(u.cacheWriteTokens) : 0;
    const prompt = u ? num(u.inputTokens) : 0;
    const text = clineAssistantText(m.content);
    if (text) texts.push(text);
    const call = {
      model: modelName(m.modelInfo && m.modelInfo.id) || '',
      provider: (m.modelInfo && typeof m.modelInfo.provider === 'string') ? m.modelInfo.provider : '',
      tin: u ? Math.max(0, prompt - cr - cw) : 0,
      tout: u ? num(u.outputTokens) : 0,
      tcache: cr + cw,
      dur: 0,
    };
    if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
    const names = [];
    for (const b of (Array.isArray(m.content) ? m.content : [])) {
      if (!b || b.type !== 'tool_use') continue;
      const nm = typeof b.name === 'string' && b.name ? b.name : '?';
      names.push(nm);
      const fi = {};
      out.tools.push({
        name: nm, tid: b.id || null, ct: ts, dur: 0, error: null, filled: false,
        input: trunc(toolArgsText(b.input), full, fi), inputTrunc: !!fi.t,
        output: '', outputTrunc: false,
      });
      toolCount++;
    }
    if (names.length) call.tools = names;
    out.calls.push(call);
    prevAssistant = call;
  }
  out.assistant = texts.join('\n\n---\n\n');
  // ct / filled 只是这一轮内配对用的临时字段，不进 API 出参（与 hermes / openclaw 的 tools[] 形状对齐）
  for (const t of out.tools) { delete t.filled; delete t.ct; }
  // 失败原话：批量工具里可以只错一项，逐条列出来才看得清是哪一次
  const errs = out.tools.filter(t => t.error);
  if (errs.length) {
    out.callsNote = '本轮有 ' + errs.length + ' 个工具执行失败（' +
      errs.slice(0, 3).map(t => t.name + '：' + t.error).join('；') +
      (errs.length > 3 ? ' 等' : '') + '）。Cline 只在 tool_result 里记成败，模型侧失败不落盘。' +
      (notes.size ? ' ' + [...notes].join('；') : '');
  } else if (prevAssistant && !out.assistant && !toolCount) {
    out.callsNote += ' 本轮没有正文也没有工具调用（源头就没有这一轮的记录）。';
  } else if (notes.size) {
    out.callsNote += ' ' + [...notes].join('；');
  }
  return out;
}

// 供 discovery 的判据/根解析见上方 clineTranscripts / hasClineSessions；服务端接线（scanBranch、
// entry-content 分发、KNOWN_AGENTS、confAvailable）在 agent-acta-server.mjs。
