// ---------------- buddyext 解析器（CodeBuddy **扩展版**：%LOCALAPPDATA%\CodeBuddyExtension\Data） ----------------
//
// 为什么要单独一个 kind：CodeBuddy 家有三种落盘，彼此**不共享目录**（2026-09-28 本机逐目录核实）：
//   · CLI `@tencent-ai/codebuddy-code` → `~/.codebuddy/projects/**/*.jsonl`  = 已有的 kind `buddyjsonl`
//   · CodeBuddy CN 桌面应用（VSCode 壳）→ `%APPDATA%\CodeBuddy CN`：**只有 Electron 缓存 + state.vscdb**，
//     没有会话正文 —— 所以「装了应用却一条都看不到」不是解析器坏了，是正文真的不在那儿
//   · 共用的 genie 扩展（VSCode / CodeBuddyIDE / JetBrains 三种宿主都走它）
//     → `%LOCALAPPDATA%\CodeBuddyExtension\Data`：**这才是本 kind 的真源**
// 三者互不相干，故 `codebuddy`（buddyjsonl）与 `codebuddy-ext`（本 kind）是侧栏上两个独立 agent。
//
// 盘上摆法（<Data> = %LOCALAPPDATA%\CodeBuddyExtension\Data）：
//   <Data>/<acct>/<Host>/history/<wsKey>/index.json                 ← 工作区级：conversations[]{id,name,…} + current
//   <Data>/<acct>/<Host>/history/<wsKey>/<会话 id>/index.json        ← **会话级主源**：messages[]（索引）+ requests[]（轮）
//   <Data>/<acct>/<Host>/history/<wsKey>/<会话 id>/messages/<消息 id>.json  ← 逐条正文（一条一个文件）
// <Host> ∈ {VSCode, CodeBuddyIDE, JetBrains}。<acct> ∈ {`default`} ∪ {36 位 uuid}，两种形状：
//   acct==='default' → `<acct>/<Host>/history/…`（本机实测 5 段）
//   acct 为 uuid     → `<acct>/<Host>/<acct>/history/…`（**同一串再重复一层**，本机实测 6 段）
// 重复那一层是刻意的还是历史包袱无从考证，所以 `historyDirs` 两种都探（不写死层数）。
//
// ⚠️ **不读** 同一棵 tree 里的这些（与解析无关，读了只会平白多出几万个 stat/read）：
//   `check-point/` `file-tree/` `plan-task/` `genie-cache/` `.index_bak.json` `index.json.lock`
// 也**不读** `<Host>` 那一层旁边的 IDE 状态文件（`globalState.json` 等同族里有明文密钥的先例，见 cline.mjs 头）。
// 本 kind 全程只打开三类文件：工作区 index.json（取 name）、会话 index.json（取轮）、messages/*.json（取正文）。
//
// ---------------- 为什么是「整份重写 + 逐条签名」而不是 off 增量 ----------------
// 会话级 index.json 在会话进行中**每次都被整体重写**（实测：一条 assistant 消息从 isComplete:false 翻成
// true 时文件 mtime/size 都变），所以没有可续读的字节偏移 ⇒ **不进 OFF_KINDS**，files 状态不落 index，
// 重启即整份重扫。`PARSER_REV.buddyext` 仍然登记 —— 它在这里管的是 `~/.agent-acta/search/` 全文分片的作废。
// 但一个会话的消息是**散成上千个小文件**的（本机最大一份 3331 条 / 8.6MB），逐轮重读整棵 messages/ 太贵，
// 于是做了第二层缓存：每条消息按自己的 `{mtime,size}` 存一份紧凑投影（`data.mc`）。
// 每轮扫描的代价 = 会话 index 变了才重算聚合，重算时对每条消息只 stat；正文文件仅在签名变了才 read。
//
// ---------------- 轮口径：轮 = requests[] 里的一项 ----------------
// 与 cline / claude 靠「role=user 且有正文」猜轮边界不同，这里产品**自己记了轮**：
//   requests[i] = {id, type:'craft', messages:[消息 id 按序], state:'complete'|'running', startedAt?, usage?}
// 所以开轮判据就一条：`messages[]` 非空（本机 311/311 条请求都满足，且请求引用的消息 id 全部存在于
// 会话级 messages[] 索引里）。扫描侧与详情侧共用 `buddyExtTurns()` 挑这一份数组，
// 「扫到第 N 轮」与「详情第 N 轮」不可能错位。
//
// ---------------- token 口径 ----------------
// `usage = {inputTokens, outputTokens, totalTokens, lastTokens, cacheTokens?, cachedWriteTokens?, cachedMissTokens?, credit?}`
// ⚠️ **inputTokens 含缓存**（与 cline 同、与 openclaw/minimax 相反），算术自证（本机 2026-09-28 活会话）：
//     cachedMissTokens 22449 + cacheTokens 512 + cachedWriteTokens 0 === inputTokens 22961
// ⇒ tin = inputTokens − cacheTokens − cachedWriteTokens（净输入，实测恒等于 cachedMissTokens）、
//   tcache = 两个 cache 桶之和、tout = outputTokens、total = totalTokens（= Σ 各次调用的 in+out）。
//   多步请求的 inputTokens 是**各步之和**（本机实测 76 条消息的那一轮 = 2512800），不是末次值 ——
//   所以它可以直接和逐工具的聚合量并排显示，不用换算。
//   ctxUsed = `lastTokens`（产品自己记的「末次调用的上下文占用」；老样本没有时退回末条 assistant 的
//   statsSnapshot.inputTokens）。ctx（窗口**容量**分母）**一律 0**：模型目录嵌在扩展二进制里，盘上没有任何
//   JSON 版本 ⇒ 不编分母，页面退化成只显示占用（与 cline / minimax 同款处理）。
// 逐次明细：新版每条 assistant 的 `extra.statsSnapshot` = {inputTokens, outputTokens, cachedInputTokens,
//   cacheWriteTokens, cacheMissTokens, thinkingTokens, elapsedMs, credit} —— 是**那一步自己的**记账
//   （与同一条上的 lastStep* 三兄弟一致），故 calls[].tin/tout/tcache/dur 能逐次给。
//   ⚠️ 老方言（本机 2026 年 1–3 月那几份会话）没有 statsSnapshot：逐次 token **留 null**（页面据此不印 0），
//   逐次 dur 退化成「相邻消息时间戳之差」。
//
// ---------------- 时间口径 ----------------
// 轮时间优先 `request.startedAt`（epoch 毫秒；本机 282/311 有），否则退到该轮消息里最早的时间戳。
// 消息时间戳：新版每条消息带 `createdAt`（ISO）；老版只有 `extra.responseId`，两种书写都要认 ——
//   `^[0-9]{14}` 前缀 = <YYYYMMDDHHmmss><随机>，**是本地时间**（按本地时区解释才是对的 epoch）；
//   `^gen-<10 位 epoch 秒>-` 。两者都取不到 → 该轮 time=0 + timeUnknown=true（页面据此标「时间未知」）。
// dur = 该轮最晚消息时间戳 − time。**不要用文件 mtime 算**：整份重写会把一批消息文件的 mtime 拍平到
//   同一瞬间（本机 218e107b / 33ae5ab3 两份会话实测：mtime 差 ~2ms 而内容时间戳差 22s/84s），
//   拿它算出来的「耗时」是假的。
// finished = 非末轮恒 true；末轮看 `state`（'running' → false）。这里比 cline 多一个真信号，
//   所以按真信号写，不用「末轮一律 false + 页面 5 分钟兜底」那套。
//
// ---------------- 失败 / 中断口径 ----------------
// 逐工具成败只在 `tool-result` 块里：`result.status ∈ {success, error, cancelled, skipped}`。
//   status==='error' → 该工具红 + 整轮 status=error（errorMessage 进 callsNote）；
//   status==='cancelled'（errorMessage 是 "User cancel tool execution"）或消息级 extra.isCancelled
//     → 整轮 aborted。
// `skipped` 既不算失败也不算中断（本机 5 条，是「批量调用里被跳过的一项」，拿它标红就是误报）。
// 模型侧失败**不落盘**（没有 stopReason/errorMessage 这类字段）⇒ 认不出来的失败宁可不标。
import fs from 'node:fs';
import path from 'node:path';
import {
  files, entries, srcs, removedIds, sorted, addEntry,
  modelName, toText, trunc, listDirCached, isDir, isFile,
} from './shared.mjs';

export const buddyExtScanErr = new Map();

// 三种宿主目录名（大小写不敏感）。别的名字一律不认 —— 这一层认错了会把邻居应用的数据当成本 kind。
const HOSTS = new Set(['vscode', 'codebuddyide', 'jetbrains']);

// id 前缀 `bx#`：与 claude 的、codex 的 `x#`、cline 的 `cl#`、openclaw 的 `oc#` 都不撞
export function buddyExtIdBase(p) { return 'bx#' + String(p).replace(/[\\/:]/g, '~') + '#'; }
function turnSuffix(key) { return String(key == null ? '' : key).replace(/#/g, '~'); }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
// extra / message 两个字段在盘上都是**JSON 字符串套字符串**（不是对象），但别的版本直接给对象
function safeJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------- 时间戳 ----------------
const RID_HEX = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/;
const RID_GEN = /^gen-(\d{10})-/;
function tsOf(ex, o) {
  if (o && typeof o.createdAt === 'string') { const t = Date.parse(o.createdAt); if (Number.isFinite(t)) return t; }
  const rid = ex && ex.responseId;
  if (typeof rid === 'string') {
    const m1 = rid.match(RID_HEX);
    // ⚠️ 那 14 位是**本地时间**书写：用 new Date(y,m,d,h,mi,s) 而不是 ISO 串，否则整体偏一个时区
    if (m1) return new Date(+m1[1], +m1[2] - 1, +m1[3], +m1[4], +m1[5], +m1[6]).getTime();
    const m2 = rid.match(RID_GEN);
    if (m2) return +m2[1] * 1000;
  }
  return 0;
}

// ---------------- 用户正文 ----------------
// 一条 user 消息的正文里裹着好几层产品自己注入的壳（<user_info> 带 Workspace Folder、<git_status>、
// <additional_data> 带当前时间/打开过的文件……），真问句在 <user_query> 里。三层取法，优先级从高到低：
//   ① extra.inputPhrase —— 产品自己记的「用户实际输入了什么」，干净短句，不用剥壳；
//   ② <user_query> 块；
//   ③ 剥掉已知壳标签后的正文（老方言 / 手工改过的文件）。
function wrapRe(name) { return new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'); }
const WRAP_TAGS = ['user_info', 'additional_data', 'git_status', 'open_and_recently_viewed_files',
  'mode_notice', 'system_reminder', 'project_context', 'environment_details', 'selection'];
function inputPhraseText(ip) {
  if (!Array.isArray(ip)) return '';
  const buf = [];
  for (const x of ip) {
    if (!x || typeof x !== 'object') continue;
    const c = typeof x.content === 'string' ? x.content
      : (typeof x.expandContent === 'string' ? x.expandContent : '');
    if (c.trim()) buf.push(c.trim());
  }
  return buf.join('；');
}
function contentText(content) {
  if (typeof content === 'string') return content;      // ⚠️ user 正文在本机 294/311 里就是**裸字符串**
  if (!Array.isArray(content)) return '';
  const buf = [];
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') buf.push(b.text);
  return buf.join('\n\n');
}
export function buddyExtUserText(raw) {
  const m = wrapRe('user_query').exec(raw || '');
  if (m && m[1].trim()) return m[1].trim();
  let s = String(raw || '');
  for (const n of WRAP_TAGS) s = s.replace(wrapRe(n), ' ');
  return s.split('\n').map(x => x.trim()).filter(Boolean).join('\n').trim();
}
// 项目名：<Data> 里的 <wsKey> 是 md5（反推不出路径），唯一可读的工作区路径是 <user_info> 里那一行
function workspaceFolder(raw) {
  const m = /Workspace Folder:\s*([^\r\n<]+)/i.exec(raw || '');
  return m ? m[1].trim() : '';
}
// assistant 正文：text 之外还有 reasoning（本机 13 条），一并拼出来 —— 不拼的话「它为什么这么改」就没了
function assistantText(content) {
  if (typeof content === 'string') return toText(content);
  if (!Array.isArray(content)) return '';
  const buf = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if ((b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string') buf.push(b.text);
  }
  return buf.join('\n\n');
}

// ---------------- 工具块 ----------------
// tool-call 的 args 是**对象**（{filePath, ...}）。不能丢给 toText —— 它见 content/text 字段就只回那段
// 正文，路径这类键会被吞掉（与 cline 的 toolArgsText 同一个坑）。
function toolArgsText(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args, null, 2); } catch { return toText(args); }
}
// tool-result 的 result = {status, success, result?, errorMessage?}；内层 result 各家工具自己的结构
// （read_file_result 带 content、execute_command_result 带 stdout/stderr/exitCode）
// ⚠️ status 四态里**只有 error 算失败**。`cancelled`（"User cancel tool execution"）记成中断、
//   `skipped`（"may take a long time and the user does not want to wait"）两头都不记 —— 那是用户的
//   显式选择，标红就是把正常结果读成故障（与 claude 侧不把 rg「No matches found」算进失败率同一条约定）。
//   三者的 errorMessage 都照常进 output 文本，详情里不会是一片空白。
function toolResultInfo(block) {
  const r = (block && block.result) || {};
  const st = typeof r.status === 'string' ? r.status : '';
  const cancelled = st === 'cancelled';
  const error = st === 'error' ? String(r.errorMessage || '工具执行失败') : '';
  const inner = r.result;
  let text = '';
  if (typeof inner === 'string') text = inner;
  else if (inner && typeof inner === 'object') {
    const t = inner.content != null ? inner.content : (inner.text != null ? inner.text : inner.stdout);
    if (typeof t === 'string' && t) text = t;
    else { try { text = JSON.stringify(inner, null, 2); } catch { text = toText(inner); } }
    const se = typeof inner.stderr === 'string' ? inner.stderr.trim() : '';
    if (se && !text.includes(se)) text += (text ? '\n' : '') + se;
  } else if (inner != null) text = String(inner);
  // 没有内层 result 时（cancelled / skipped 就只有个 errorMessage）把那句话当**出参**带出去 ——
  // 不带就是详情里一行空白，用户看不到「这个工具为什么什么都没返回」。它不进 error，所以不会被算成失败。
  if (!text && r.errorMessage) text = String(r.errorMessage);
  return { text, error, cancelled };
}

// ---------------- 逐条消息的紧凑投影 ----------------
// 卡片聚合只要这几个量；正文与出入参**不进内存**（一份大会话 3331 条 / 8.6MB，全存下来就是几十 MB），
// 详情侧按 src.turn 只重读那一轮的消息文件（几十条封顶）。
function project(o) {
  const ex = safeJson(o.extra) || {};
  const msg = safeJson(o.message) || {};
  const content = msg.content;
  const p = {
    role: typeof o.role === 'string' ? o.role : '',
    ts: tsOf(ex, o),
    model: (typeof ex.modelName === 'string' && ex.modelName.trim()) || (typeof ex.modelId === 'string' ? ex.modelId : ''),
    cancelled: ex.isCancelled === true,
    ntools: 0, names: null, fails: 0, cancels: 0, errMsg: '',
    ask: '', proj: '',
    snap: null,
  };
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool-call') {
        p.ntools++;
        const nm = (typeof b.toolName === 'string' && b.toolName) ? b.toolName : '?';
        (p.names || (p.names = [])).push(nm);
      } else if (b.type === 'tool-result') {
        const info = toolResultInfo(b);
        if (info.cancelled) p.cancels++;
        else if (info.error) { p.fails++; if (!p.errMsg) p.errMsg = info.error; }
      }
    }
  }
  if (p.role === 'user') {
    const raw = contentText(content);
    p.ask = inputPhraseText(ex.inputPhrase) || buddyExtUserText(raw);
    p.proj = workspaceFolder(raw);
  }
  const s = ex.statsSnapshot;
  if (s && typeof s === 'object') {
    p.snap = {
      i: num(s.inputTokens), o: num(s.outputTokens),
      cr: num(s.cachedInputTokens) + num(s.cacheWriteTokens),
      ms: num(s.elapsedMs),
    };
  }
  return p;
}

// ---------------- 轮：requests[] 的一项 = 一轮 ----------------
// 扫描侧与详情侧**必须共用**这个筛选，否则「第 N 轮」两边数不齐。
export function buddyExtTurns(payload) {
  const out = [];
  const reqs = payload && Array.isArray(payload.requests) ? payload.requests : [];
  for (const r of reqs) {
    if (!r || typeof r !== 'object') continue;
    if (!Array.isArray(r.messages) || !r.messages.length) continue;
    out.push(r);
  }
  return out;
}

// mc: Map<消息 id, {m, s, p}>（p 就是上面那个投影）
function buildTurn(r, mc, idx) {
  const t = {
    key: typeof r.id === 'string' && r.id ? r.id : 'i' + idx,
    time: 0, dur: 0, running: r.state === 'running',
    tin: 0, tout: 0, tcache: 0, total: 0, ctxUsed: 0,
    calls: 0, tools: 0, models: [], toolNames: {},
    err: false, aborted: false, errMsg: '',
    preview: '', proj: '',
  };
  let minTs = 0, maxTs = 0;
  for (const mid of r.messages) {
    const e = mc.get(mid);
    if (!e) continue;
    const p = e.p;
    const ts = p.ts;
    if (ts) { if (!minTs || ts < minTs) minTs = ts; if (ts > maxTs) maxTs = ts; }
    if (p.role === 'assistant') {
      t.calls++;
      const mdl = modelName(p.model);
      if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
      t.tools += p.ntools;
      for (const nm of p.names || []) t.toolNames[nm] = (t.toolNames[nm] || 0) + 1;
      if (p.snap && p.snap.i) t.ctxUsed = p.snap.i + p.snap.o;   // 老方言兜底：末条 assistant 的那步占用
    }
    if (p.fails) { t.err = true; if (!t.errMsg) t.errMsg = p.errMsg; }
    if (p.cancels || p.cancelled) t.aborted = true;
    if (!t.preview && p.ask) t.preview = p.ask.replace(/\s+/g, ' ').slice(0, 300);
    if (!t.proj && p.proj) t.proj = p.proj;
  }
  const u = (r.usage && typeof r.usage === 'object') ? r.usage : {};
  const inp = num(u.inputTokens), outp = num(u.outputTokens);
  const cache = num(u.cacheTokens) + num(u.cachedWriteTokens);
  t.tin = Math.max(0, inp - cache);      // ⚠️ inputTokens **含**缓存（见文件头）
  t.tcache = cache;
  t.tout = outp;
  t.total = num(u.totalTokens) || (t.tin + t.tout + t.tcache);
  const lt = num(u.lastTokens);
  if (lt) t.ctxUsed = lt;
  t.time = num(r.startedAt) || minTs;
  if (maxTs > t.time) t.dur = maxTs - t.time;
  return t;
}

// ---------------- emit：一轮一条 entry ----------------
function emit(agent, key, data, prevData) {
  const base = buddyExtIdBase(key);
  const ids = new Set();
  const n = data.turns.length;
  data.turns.forEach((t, i) => {
    const id = base + turnSuffix(t.key);
    ids.add(id);
    addEntry(id, {
      agent,
      project: data.project,
      session: data.sid,
      name: data.name || undefined,
      time: t.time,
      timeUnknown: t.time ? undefined : true,
      dur: t.dur,
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.total,
      ctx: 0,                              // 窗口容量只嵌在扩展二进制里，盘上没有 —— 不编分母
      ctxUsed: t.ctxUsed || 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      // 末轮才看 state：'running' 说明会话还在写（页面据此判「进行中」，见 recomputeLive）
      finished: i < n - 1 ? true : !t.running,
      aborted: t.aborted,
      toolNames: t.toolNames,
    }, { file: key, turn: i, kind: 'buddyext' });
  });
  // 会话被删/轮被回收时按 id 集合回收，否则老条目悬在页面上
  for (const old of (prevData && prevData.ids) || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

// ---------------- 目录枚举 ----------------
// <Data>/<acct>/<Host>/(<acct>/)?history —— 两种账号形状都探，不写死层数。
// ⚠️ 这是每 3s 一轮的 sniff 路径：只用 listDirCached（按目录 mtime 缓存），且第三层只在
//   <Host> 下没有直挂 history 时才多读一次目录名。
function historyDirs(dataRoot) {
  const out = [];
  for (const acct of listDirCached(dataRoot) || []) {
    const acctDir = path.join(dataRoot, acct);
    if (!isDir(acctDir)) continue;
    for (const host of listDirCached(acctDir) || []) {
      if (!HOSTS.has(host.toLowerCase())) continue;
      const hostDir = path.join(acctDir, host);
      if (!isDir(hostDir)) continue;
      const direct = path.join(hostDir, 'history');
      if (isDir(direct)) { out.push(direct); continue; }
      for (const mid of listDirCached(hostDir) || []) {
        if (mid === 'history') continue;
        const deep = path.join(hostDir, mid, 'history');
        if (isDir(deep)) out.push(deep);
      }
    }
  }
  return out;
}

// 会话清单：…/history/<wsKey>/<会话 id>/index.json（与同级那份工作区 index.json 配对，只取 name）
function convIndexes(root, limit) {
  const out = [];
  for (const hist of historyDirs(root)) {
    for (const wsKey of listDirCached(hist) || []) {
      const wsDir = path.join(hist, wsKey);
      if (!isDir(wsDir)) continue;
      const wsIndex = path.join(wsDir, 'index.json');
      for (const conv of listDirCached(wsDir) || []) {
        if (conv === 'index.json' || conv === '.index_bak.json' || conv.endsWith('.lock')) continue;
        const convDir = path.join(wsDir, conv);
        if (!isDir(convDir)) continue;
        const index = path.join(convDir, 'index.json');
        if (!isFile(index)) continue;
        out.push({ convId: conv, convDir, index, wsIndex });
        if (limit && out.length >= limit) return out;
      }
    }
  }
  return out;
}

// 会话名来自**工作区级** index.json 的 conversations[]（会话自己那份没有 name 字段）。
// 空串就当没有 —— 页面会退回裸会话 id，比拿预览顶包诚实。
function readConvName(wsIndex, convId) {
  let j; try { j = JSON.parse(fs.readFileSync(wsIndex, 'utf8')); } catch { return ''; }
  const list = j && Array.isArray(j.conversations) ? j.conversations : [];
  for (const c of list) {
    if (c && typeof c === 'object' && c.id === convId) {
      return typeof c.name === 'string' && c.name.trim() ? c.name.trim() : '';
    }
  }
  return '';
}

// ---------------- 主源根（discovery 的 sniffBase 与手工添加共用）----------------
// 手工添加时用户可能填 `%LOCALAPPDATA%\CodeBuddyExtension`、`…\CodeBuddyExtension\Data`，
// 也可能顺着资源管理器填到 `<Data>/<acct>` 甚至 `<Data>/<acct>/<Host>` 那一层。
// ⚠️ sniffBase 是**每 3s 对每个候选目录**都要跑一遍的路径，所以这里绝不对任意目录盲下探：
//   先一次 stat 探 `<base>/Data` 在不在（绝大多数机器只有这一条命中），
//   往上走则只认**目录名真叫 data** 的那一层才付 historyDirs 的 readdir 代价。
//   判据本身是**结构**（acct/Host/history 三层齐不齐）而不是目录名，所以名字猜错不会误接邻居应用的数据。
export function buddyExtRoot(base) {
  if (!isDir(base)) return null;
  const bn = p => path.basename(p).toLowerCase();
  const sub = path.join(base, 'Data');
  if (isDir(sub) && historyDirs(sub).length) return sub;
  for (let d = base, i = 0; i < 4 && isDir(d); i++, d = path.dirname(d)) {
    if (bn(d) === 'data' && historyDirs(d).length) return d;
  }
  return null;
}

// ---------------- 「扩展根为什么没探到」的病历（诊断 / --doctor 用，不参与判据）----------------
// buddyExtRoot 返回 null 有四种成因，而在页面上长得一模一样（codebuddy 那行只剩 CLI 的数）：
//   ① 这台机器没有 CodeBuddyExtension 目录；② 有目录但没有 Data/；
//   ③ 有 Data，但 <acct> 底下的 <host> 名不在 HOSTS 白名单里（新版换宿主名就会这样，最隐蔽）；
//   ④ host 名对得上，但底下没有 history/。
// 不分开的话，同事一句「读不到 codebuddy」只能远程敲命令问盘 —— 这里把**实际看到的目录名**带回来。
// ⚠️ 只在用户点开诊断页 / 跑 --doctor 时调；同样只用 listDirCached，别挂到 3s 扫描路径上。
export function buddyExtWhyMissing(base) {
  const dirs = d => (listDirCached(d) || []).filter(n => isDir(path.join(d, n)));
  const cap = (arr, n = 6) => (arr.length > n ? arr.slice(0, n).concat('…（共 ' + arr.length + ' 个）') : arr);
  if (!isDir(base)) return '目录不存在';
  const data = path.join(base, 'Data');
  if (!isDir(data)) return '下面没有 Data/（实际子目录：' + (cap(dirs(base)).join(' ') || '空') + '）';
  const accts = dirs(data);
  if (!accts.length) return 'Data/ 是空的（一个账号目录都没有）';
  const badHosts = [], noHist = [];
  for (const acct of accts.slice(0, 8)) {
    const hosts = dirs(path.join(data, acct));
    const known = hosts.filter(h => HOSTS.has(h.toLowerCase()));
    if (!known.length) { badHosts.push(acct + '/ 下是「' + (hosts.join(' ') || '空') + '」'); continue; }
    for (const h of known) {
      const hd = path.join(data, acct, h);
      if (!isDir(path.join(hd, 'history')) && !dirs(hd).some(m => isDir(path.join(hd, m, 'history')))) {
        noHist.push(acct + '/' + h);
      }
    }
  }
  if (badHosts.length) return cap(badHosts).join('；') + ' —— <host> 名都不是那三个宿主（只认 ' + [...HOSTS].join(' / ') + '）';
  if (noHist.length) return '<host> 名认得、但底下没有 history/：' + cap(noHist).join('；');
  return 'Data/ 下有账号目录，却没探到 history/（账号目录：' + cap(accts).join(' ') + '）';
}

// ---------------- 扫描主入口 ----------------
// root = <Data> 目录（由 sniffBase 解析出来）
export function scanBuddyExt(agent, root, onlyFile) {
  if (!isDir(root)) return;
  for (const c of convIndexes(root, 400)) {
    if (onlyFile && c.index !== onlyFile) continue;
    let ist; try { ist = fs.statSync(c.index); } catch { continue; }
    let wst = null; try { wst = fs.statSync(c.wsIndex); } catch {}
    // 签名带上工作区那份 index：会话名是**产品后来才补上的**（首条回复之后才自动起标题），
    // 不把它算进签名，name 会长期停在旧值上。
    const sig = ist.mtimeMs + '|' + ist.size + '#' + (wst ? wst.mtimeMs + '|' + wst.size : '-');
    const key = c.index;
    const prev = files.get(key);
    if (prev && prev.data && prev.data.sig === sig) {
      // 本 kind 不落 index：files 可能从本轮更早那次扫描带来，条目却已被清掉 → 按内存里那份重建
      const last = prev.data.turns && prev.data.turns[prev.data.turns.length - 1];
      if (last && !entries.has(buddyExtIdBase(key) + turnSuffix(last.key))) emit(agent, key, prev.data, null);
      continue;
    }
    let payload;
    try { payload = JSON.parse(fs.readFileSync(c.index, 'utf8')); } catch (e) {
      buddyExtScanErr.set(agent, c.index + ' 读不动（整份 JSON 解析失败）：' + e.message);
      continue;
    }
    if (!payload || !Array.isArray(payload.requests)) {
      buddyExtScanErr.set(agent, c.index + ' 里没有 requests[] —— 不是认得的 CodeBuddy 扩展会话文件');
      continue;
    }
    buddyExtScanErr.delete(agent);
    const requests = buddyExtTurns(payload);
    const mdir = path.join(c.convDir, 'messages');
    const prevMc = prev && prev.data && prev.data.mc;
    const mc = new Map();
    for (const r of requests) {
      for (const mid of r.messages) {
        if (mc.has(mid)) continue;
        const fp = path.join(mdir, mid + '.json');
        let mst; try { mst = fs.statSync(fp); } catch { continue; }
        const cached = prevMc && prevMc.get(mid);
        // ⚠️ 只 stat 不 read 是这里的**全部增量语义**：正文文件写完就不动（消息级 isComplete 翻在 index 里），
        //   签名没变的直接复用上一轮的投影；index 每轮重写不会让它们重读。
        if (cached && cached.m === mst.mtimeMs && cached.s === mst.size) { mc.set(mid, cached); continue; }
        let o; try { o = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
        mc.set(mid, { m: mst.mtimeMs, s: mst.size, p: project(o) });
      }
    }
    const turns = requests.map((r, idx) => buildTurn(r, mc, idx));
    let wsPath = '';
    for (const t of turns) if (t.proj) { wsPath = t.proj; break; }
    const data = {
      sig, sid: c.convId, turns, mc,
      project: wsPath || '(CodeBuddy 扩展)',
      name: readConvName(c.wsIndex, c.convId),
      rev: (prev && prev.data ? (prev.data.rev || 0) : 0) + 1,
    };
    files.set(key, { agent, kind: 'buddyext', m: ist.mtimeMs, s: ist.size, off: 0, data });
    emit(agent, key, data, prev && prev.data);
  }
}

// ---------------- 详情：重读会话 index + 那一轮的消息文件 ----------------
// 轮的选择与扫描侧共用 buddyExtTurns()，所以 src.turn 一定落在同一份数组上。
export function buddyExtEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + st.s : null;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(src.file, 'utf8')); } catch { return null; }
  const r = buddyExtTurns(payload)[src.turn];
  if (!r) return null;
  const NOTE = 'CodeBuddy 扩展（VSCode / CodeBuddyIDE / JetBrains 共用的 genie 扩展）的源是**每个会话一份 ' +
    'index.json（会话进行中整体重写）+ messages/<消息 id>.json 逐条正文**，不是 JSONL。' +
    'usage.inputTokens **含**缓存（cacheTokens + cachedWriteTokens 是它的子集，与 cline 同、与 openclaw 相反），' +
    '故 tin = input − 两个 cache 桶、tcache = 两桶之和、total = usage.totalTokens = Σ 各次调用、' +
    'ctxUsed = usage.lastTokens（末次调用的上下文占用）。逐次明细挂在每条 assistant 的 ' +
    'extra.statsSnapshot 上（含 elapsedMs）；⚠️ 老方言没有这一层，此时逐次 token **留空**（不印假 0）、' +
    '逐次耗时退化成相邻消息时间戳之差。上下文窗口容量只嵌在扩展二进制里、盘上没有 ⇒ ctx 恒 0（不编分母）。';
  const out = { user: '', assistant: '', tools: [], calls: [], v: version, callsNote: NOTE };
  const mdir = path.join(path.dirname(src.file), 'messages');
  const texts = [];
  const notes = new Set();
  const callStart = new Map();   // toolCallId -> 发起它那条 assistant 的时间戳
  let prevTs = 0;
  for (const mid of r.messages) {
    const o = (() => { try { return JSON.parse(fs.readFileSync(path.join(mdir, mid + '.json'), 'utf8')); } catch { return null; } })();
    if (!o) continue;
    const ex = safeJson(o.extra) || {};
    const msg = safeJson(o.message) || {};
    const content = msg.content;
    const ts = tsOf(ex, o);
    const role = typeof o.role === 'string' ? o.role : '';
    if (role === 'user') {
      const raw = contentText(content);
      const ask = inputPhraseText(ex.inputPhrase) || buddyExtUserText(raw);
      if (ask && !out.user) out.user = ask;
      if (ts) prevTs = ts;
      continue;
    }
    if (role === 'assistant') {
      const text = assistantText(content);
      if (text) texts.push(text);
      const call = { model: modelName(ex.modelName || ex.modelId) || '', provider: '', tin: null, tout: null, tcache: null, dur: 0 };
      const s = ex.statsSnapshot && typeof ex.statsSnapshot === 'object' ? ex.statsSnapshot : null;
      if (s) {
        const cache = num(s.cachedInputTokens) + num(s.cacheWriteTokens);
        call.tin = Math.max(0, num(s.inputTokens) - cache);
        call.tcache = cache;
        call.tout = num(s.outputTokens);
        call.dur = num(s.elapsedMs);
      } else if (ts && prevTs) call.dur = Math.max(0, ts - prevTs);
      if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
      const names = [];
      for (const b of (Array.isArray(content) ? content : [])) {
        if (!b || b.type !== 'tool-call') continue;
        const nm = (typeof b.toolName === 'string' && b.toolName) ? b.toolName : '?';
        names.push(nm);
        const tid = typeof b.toolCallId === 'string' && b.toolCallId ? b.toolCallId : null;
        if (tid) callStart.set(tid, ts);
        const fi = {};
        out.tools.push({
          name: nm, tid, dur: 0, error: null, filled: false,
          input: trunc(toolArgsText(b.args), full, fi), inputTrunc: !!fi.t,
          output: '', outputTrunc: false,
        });
      }
      if (names.length) call.tools = names;
      out.calls.push(call);
      if (ts) prevTs = ts;
      continue;
    }
    // 其余角色（本机实测是 'tool'）：只用来按 toolCallId 回填出参与成败
    for (const b of (Array.isArray(content) ? content : [])) {
      if (!b || b.type !== 'tool-result') continue;
      const info = toolResultInfo(b);
      const tid = typeof b.toolCallId === 'string' ? b.toolCallId : null;
      const nm = (typeof b.toolName === 'string' && b.toolName) ? b.toolName : '?';
      const t = (tid && out.tools.find(x => x.tid === tid)) || out.tools.find(x => !x.filled && x.name === nm);
      if (!t) { notes.add('有工具返回找不到对应的调用（多半落在被摘要掉的那一段里）'); continue; }
      t.filled = true;
      const fo = {};
      t.output = trunc(info.text, full, fo); t.outputTrunc = !!fo.t;
      if (info.error) t.error = info.error;
      const ct = t.tid ? callStart.get(t.tid) : 0;
      if (ts && ct) t.dur = Math.max(0, ts - ct);
    }
    if (ts) prevTs = ts;
  }
  out.assistant = texts.join('\n\n---\n\n');
  // filled 只是本轮内配对用的临时字段，不进 API 出参（与 cline / openclaw 的 tools[] 形状对齐）
  for (const t of out.tools) delete t.filled;
  const errs = out.tools.filter(t => t.error);
  if (errs.length) {
    // 一行 note 装不下两条口径，挑可行动的那条（与 cline / openclaw 同款取舍）
    out.callsNote = '本轮有 ' + errs.length + ' 个工具执行失败（' +
      errs.slice(0, 3).map(t => t.name + '：' + t.error).join('；') +
      (errs.length > 3 ? ' 等' : '') + '）。CodeBuddy 扩展只在 tool-result 的 result.status 里记成败' +
      '（error / cancelled / skipped），模型侧失败不落盘。' + (notes.size ? ' ' + [...notes].join('；') : '');
  } else if (notes.size) {
    out.callsNote = NOTE + ' ' + [...notes].join('；');
  }
  return out;
}
