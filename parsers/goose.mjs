// ---------------- goose 解析器（Block Goose：sessions.db 会话库 + usage_ledger 逐次账本） ----------------
// 真源（2026-10-14 拿 goose 1.54.0 本机实测点名，**第三方索引表那条 `~/.local/share/goose` 在 Windows 上根本不存在**）：
//   <root>/data/sessions/sessions.db   ← **主源**（本文件只读它）
//   <root>/data/logs/llm_request.<n>.jsonl、<root>/data/logs/cli/<日期>/*.log  ← 旁路，不读（会话库已够，且它含整份请求体）
//   <root>/config/config.yaml、<root>/config/custom_providers/*.json            ← **绝不读**（里面是 provider 与密钥）
// <root>：Windows = `%APPDATA%\Block\goose`；POSIX = `~/.local/share/goose`（`goose info` 会把它自己算出来的三条路径打出来）。
// `GOOSE_PATH_ROOT` 可整棵挪走 ⇒ candidateBases 认这个环境变量，测试里必须显式覆盖它（本机真数据就压在默认位置上）。
//
// 库是 **SQLite（WAL）**，不是追加式文本 ⇒ 与 crush / devindb / traedb / opencode / kilo 同一路数：
// 按 {mtime,size} 签名整份重读、**不进 OFF_KINDS**（没有可续读的字节偏移），详情直接吃扫描时并进内存的轮，
// 回源重读在 goose 上是危险的：goose 正在跑的时候它的 provider 文件我实测拿到过 EPERM 独占锁。
//
// 表（本机实测存在的）：`sessions` / `messages` / `usage_ledger` / `schema_version` / `provider_inventory_*`。
// `messages` 列：id, message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json
//   content_json 是 **块数组**，块类型本机实测四种：`text` / `thinking` / `toolRequest` / `toolResponse`
//     · toolRequest 挂在 **role=assistant** 行：{type,id,toolCall:{status,value:{name,arguments}},_meta:{goose.toolCall.providerIndex,goose_extension}}
//     · toolResponse 挂在 **role=user** 行：{type,id,toolResult:{status,value:{resultType,content[],isError}}}
//     ⇒ 配对键是块上的 `id`（`call_xxx`）。⚠️ **不是** Anthropic 的 tool_use/tool_result，也不是 cline/openclaw 的 toolCallId 字段。
//   metadata_json：{userVisible, agentVisible, turnContext?, inference?:{provider,requestedModel}, usage?:{…}}
//     usage = {inputTokens, outputTokens, totalTokens, cacheReadTokens?, cost, costSource, elapsedMs, timeToFirstTokenMs}
//     ⚠️ `cacheReadTokens` 是**缺键**而不是 0（本机第一条就没有这一位）。
//   `tokens` 那一列本机全部为 null —— 用量只认 metadata_json.usage，别去读它。
// `usage_ledger` 列：session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens,
//   cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction   ← 逐次请求一行，`is_compaction` 是压缩信号
// `sessions` 列（取用的那些）：id, name, user_set_name, working_dir, created_at, updated_at, provider_name,
//   model_config_json（`{"model_name":…,"max_tokens":128000,…}` ⇒ ctx 分母现成）, goose_mode,
//   parent_session_id（子 agent 归属）, archived_at, 以及下面 ⚠️ 口径二 那两组同名易混的累计/快照列。
//
// ⚠️ 口径一（开轮）：`role="user"` **且 `metadata.userVisible !== false`** 且 content 有非空 text 块。
//   goose 每个真人句后面常紧跟一条 `<turn-context>`（当前时间 + 工作目录）注入行，它也是 role:user，
//   但 `userVisible:false` + `turnContext:true`（本机实测）；而 **工具返回同样挂 role:user**
//   （块是 toolResponse、没有 text 块）。三条判据缺一就虚增轮数 —— 与 droid 的 visibility 完全同型。
// ⚠️ 口径二（累计 vs 快照，命名是反向陷阱）：`sessions.input_tokens/output_tokens/total_tokens/cache_read_tokens`
//   实测 = **最后一次请求**的快照（会话 20261014_4：6762/253/5632 恰等于 usage_ledger 末行）；
//   带前缀的 `sessions.accumulated_*` 才是会话累计（accumulated_input_tokens=51172 = Σ usage_ledger.input_tokens，一字不差）。
//   ⇒ 会话合计一律读 `accumulated_*`，**裸名那一组只当快照看**。crush 那次是「自述累计、实为快照」，这次方向相反。
// ⚠️ 口径三（缓存档位）：**inputTokens 含缓存**（与 qwen / cline / buddyext 同侧，与 openclaw / pi / minimax 相反）。
//   自证：`total = input + output` 恒成立、`input` 5558→6172→6762 随上下文平滑涨，而 cacheRead 单列 4608/5632 且 ≤ input。
//   ⇒ `tin = input − cacheRead`、`tcache = cacheRead`、`ctxUsed = input`（含缓存才是真实上下文占用）。
//   逐轮用量取**该轮 assistant 行自己的** metadata_json.usage（一轮内多次调用就求和）；不读 usage_ledger 当第二数据源。
//   ⚠️ 真件里有 1 条 assistant 行**带 `inference` 却没有 `usage`**（对账实测：calls 14 vs usage_ledger 13 行）——
//   所以 `calls`（assistant 行数）**可以比账本行数多**，这不是重复计数，别去「对齐」成账本那一侧。
// ⚠️ 口径四（时间与耗时）：`created_timestamp` 是 **unix 秒** ⇒ 入库 ×1000（`timestamp` 那列是 UTC 文本，只做对照）。
//   逐次耗时用 usage.elapsedMs、TTFT 用 usage.timeToFirstTokenMs（本机实测都在，比 pi 还要齐）；
//   `is_compaction` / usage 里能认出的压缩进 compacts。工具失败信号本机样本**全是 success**（4 对），
//   ⇒ `toolResult.value.isError` / `status` 按字面读，但**值域未实测**，不拿它推轮级 status。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, isFile, sqliteMod } from './shared.mjs';

export const GOOSE_STATE_DIRNAMES = ['goose'];   // Windows 在 %APPDATA%\Block\goose —— 见 discovery 的 candidateBases

// 判「这个文件是不是 goose 的会话库」：SQLite 页头 + sessions/messages 两张表齐 + messages 必须有 content_json
// 与 metadata_json（别的 agent 的库也常有 messages 表 —— opencode/kilo/crush 都姓这个，靠列集合区分）。
export function gooseDbVerify(fp) {
  if (!isFile(fp)) return false;
  try {
    const fd = fs.openSync(fp, 'r');
    try {
      const b = Buffer.alloc(16);
      if (fs.readSync(fd, b, 0, 16, 0) < 16 || b.toString('latin1', 0, 15) !== 'SQLite format 3') return false;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  const sql = sqliteMod(); if (!sql) return false;
  let db; try { db = new sql.DatabaseSync(fp, { readOnly: true }); } catch { return false; }
  try {
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has('sessions') || !has('messages')) return false;
    const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
    return cols.has('content_json') && cols.has('metadata_json') && cols.has('session_id');
  } catch { return false; } finally { try { db.close(); } catch {} }
}

// base 可能是 goose 根（%APPDATA%\Block\goose）、data 目录、sessions 目录，或直接是那份 db —— 都认。
// ⚠️ sessions 存的是**db 文件路径**（文件型 kind，与 zcode / opencode / kilo / hermes / devindb 同款）
//    ⇒ 主文件的 confAvailable 要按文件放行，不能对它取 dirname 重嗅。
export function gooseDbFrom(base) {
  if (!base) return null;
  let st = null; try { st = fs.statSync(base); } catch { return null; }
  if (st.isFile()) return gooseDbVerify(base) ? base : null;
  if (!st.isDirectory()) return null;
  const cands = [
    path.join(base, 'data', 'sessions', 'sessions.db'),   // 生产摆法
    path.join(base, 'sessions', 'sessions.db'),           // 直接给到 data 那一层
    path.join(base, 'sessions.db'),                       // 直接给到 sessions 目录
  ];
  for (const c of cands) if (gooseDbVerify(c)) return c;
  return null;
}

export function hasGooseSessions(fp) { return !!gooseDbFrom(fp); }

export function gooseIdBase(fp) { return 'goose#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function blocksOf(j) { try { const a = JSON.parse(j); return Array.isArray(a) ? a : []; } catch { return []; } }
function metaOf(j) { try { return JSON.parse(j) || {}; } catch { return {}; } }

// 用户正文：只吃 text 块（toolResponse 里没有 text，天然挡住工具返回）
export function gooseUserText(content) {
  const buf = [];
  for (const b of blocksOf(content)) if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) buf.push(b.text);
  return buf.join('\n\n');
}

// ⚠️ 口径一：扫描、详情、主文件的复现包分片三处共用这一份判据，各写一遍必错位。
// 入参可以是整行也可以是已拆出的 {role, content_json?, content?, metadata_json?}。
export function gooseIsUserPrompt(row) {
  if (!row || row.role !== 'user') return false;
  const meta = metaOf(row.metadata_json !== undefined ? row.metadata_json : row.metadata);
  if (meta.userVisible === false) return false;
  return !!gooseUserText(row.content_json !== undefined ? row.content_json : row.content);
}

// 一轮落成 entry。⚠️ 口径三：逐次 usage 在本轮各 assistant 行的 metadata_json.usage 里。
function emitTurns(agent, fp, data, fromIdx) {
  const idBase = gooseIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(idBase + t.idx, {
      agent,
      project: t.project || data.project,
      session: data.session,
      name: data.userNamed ? data.session : undefined,   // user_set_name=0 时那个 name 是 goose 自动摘要，不当「用户起的会话名」用
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : (t.elapsedMs || 0),
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: data.ctx || 0,                 // ⚠️ 口径四之外另一处白送：sessions.model_config_json.max_tokens
      ctxUsed: t.ctxUsed || 0,            // 本轮最后一次调用的 input（含缓存）
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: false,
      toolNames: t.toolNames,
      compacts: t.compacts || undefined,
    }, { file: fp, turn: t.idx, kind: 'goose' });
  }
}

// 整库读一遍。库小（本机 <1MB），整份重读比维护水位线可靠 —— 与 opencode / kilo / devindb 同一取舍。
function readGooseDb(fp) {
  const sql = sqliteMod(); if (!sql) return null;
  let db;
  try { db = new sql.DatabaseSync(fp, { readOnly: true }); } catch { return null; }
  const out = { sessions: [], messages: [], ledger: [] };
  try {
    try { out.sessions = db.prepare('SELECT * FROM sessions').all(); } catch {}
    out.messages = db.prepare('SELECT * FROM messages ORDER BY id').all();
    try { out.ledger = db.prepare('SELECT * FROM usage_ledger ORDER BY id').all(); } catch {}
    return out;
  } catch { return null; } finally { try { db.close(); } catch {} }
}

// 压缩：本机没有压缩样本（is_compaction 全 0）。认这两个信号，都取不到就当没发生 —— 不编。
function ledgerCompactions(ledger, sid) {
  let n = 0;
  for (const r of ledger) if (r.session_id === sid && (r.is_compaction === 1 || r.is_compaction === true)) n++;
  return n;
}

// ---------------- 扫描主入口（SQLite 型：整份重解析 + {mtime,size} 签名跳过） ----------------
export function scanGoose(agent, dbPath) {
  const fst = (() => { try { return fs.statSync(dbPath); } catch { return null; } })();
  if (!fst) return;
  const key = dbPath, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  if (prev && prev.m === m && prev.s === s) {
    if (prev.data?.turns?.length && !entries.has(gooseIdBase(dbPath) + (prev.data.turns.length - 1)))
      emitTurns(agent, dbPath, prev.data, 0);
    return;
  }
  const raw = readGooseDb(dbPath);
  if (!raw) { files.set(key, { agent, kind: 'goose', m, s, off: 0, data: prev?.data || { turns: [], emitted: 0 } }); return; }
  const sessById = new Map(raw.sessions.map(r => [r.id, r]));
  const data = { turns: [], emitted: 0, session: '', project: '', ctx: 0, userNamed: false };
  // 会话级元信息取「最近活跃的那个会话」—— goose 一个库里躺着这台机器的全部历史会话，
  // 但卡片要的是当前会话名/目录；跨会话的区分靠 session_id 分桶，不靠这里。
  const msgs = raw.messages;
  // 按 (session_id, 行序) 切轮：assistant 行的 usage 归它前面最近的那个 user 轮。
  let cur = null, curSid = null;
  const compBySession = new Map();
  for (const r of raw.ledger) compBySession.set(r.session_id, (compBySession.get(r.session_id) || 0) + (r.is_compaction ? 1 : 0));
  const seenSession = new Set();
  for (const row of msgs) {
    const sid = row.session_id;
    if (gooseIsUserPrompt(row)) {
      const sv = sessById.get(sid) || {};
      curSid = sid;
      // 会话元信息随第一个遇到的会话落一次（多会话时每个会话各自成轮，project 按会话各自的 working_dir 走）
      if (!seenSession.has(sid)) { seenSession.add(sid); }
      let mc = null; try { mc = JSON.parse(sv.model_config_json || 'null'); } catch {}
      cur = {
        idx: data.turns.length,
        sid,
        time: num(row.created_timestamp) * 1000,          // ⚠️ 口径四：unix 秒 ⇒ ×1000
        lastTs: num(row.created_timestamp) * 1000,
        tin: 0, tout: 0, tcache: 0, ctxUsed: 0, calls: 0, tools: 0, models: [], err: false,
        toolNames: {}, elapsedMs: 0, compacts: 0,
        project: typeof sv.working_dir === 'string' && sv.working_dir ? sv.working_dir : '',
        sessionName: typeof sv.name === 'string' ? sv.name : '',
        userNamed: !!sv.user_set_name,
        ctx: num(mc && mc.max_tokens),
        preview: gooseUserText(row.content_json).replace(/\s+/g, ' ').slice(0, 300),
      };
      data.turns.push(cur);
      if (!data.session && cur.sessionName) { data.session = cur.sessionName; data.userNamed = cur.userNamed; }
      if (!data.project && cur.project) data.project = cur.project;
      if (!data.ctx && cur.ctx) data.ctx = cur.ctx;
      continue;
    }
    if (row.role !== 'assistant') continue;   // 工具返回挂 role:user 但没有 text 块 ⇒ 这里一并落空，不它开轮
    if (!cur || curSid !== row.session_id) continue;   // 无主的 assistant（跨会话切换的尾巴）不硬塞进上一轮
    cur.calls++;
    const meta = metaOf(row.metadata_json);
    const u = meta.usage || null;
    if (u) {
      const cache = num(u.cacheReadTokens);        // ⚠️ 口径三：缺键就是 0，不是「命中 0」之外的含义
      cur.tin += Math.max(0, num(u.inputTokens) - cache);
      cur.tout += num(u.outputTokens);
      cur.tcache += cache;
      cur.ctxUsed = Math.max(0, num(u.inputTokens));   // 本轮最后一次调用的 input（含缓存）= 真实上下文占用
      cur.elapsedMs = num(u.elapsedMs) || cur.elapsedMs;
      if (u.cost) cur.cost = (cur.cost || 0) + num(u.cost);
    }
    const ts = num(row.created_timestamp) * 1000;
    if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
    const inf = meta.inference || {};
    const mdl = inf.requestedModel || (sessById.get(row.session_id) || {}).provider_name || '';
    if (mdl && !cur.models.includes(mdl)) cur.models.push(mdl);
    for (const b of blocksOf(row.content_json)) {
      if (!b || b.type !== 'toolRequest') continue;
      const nm = (b.toolCall && b.toolCall.value && b.toolCall.value.name) || '?';
      cur.tools++;
      cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
      const st = b.toolCall && b.toolCall.status;
      if (st === 'error' || st === 'failed') cur.err = true;   // ⚠️ 口径四：值域本机未实测（样本全 success），只认字面失败
    }
    // 压缩：assistant 行本身没有标记，落在 usage_ledger 上 —— 见下面并到各会话末轮的那段
  }
  // 逐会话的压缩次数并到该会话的末轮上（见上面注释的取舍）
  const lastBySession = new Map();
  for (const t of data.turns) lastBySession.set(t.sid, t);
  for (const [sid, n] of compBySession) { const t = lastBySession.get(sid); if (t && n) t.compacts = n; }
  if (!data.session) {
    const first = raw.sessions[0] || {};
    data.session = typeof first.id === 'string' ? first.id : 'goose';
  }
  if (!data.project) data.project = (raw.sessions[0] && raw.sessions[0].working_dir) || '';
  files.set(key, { agent, kind: 'goose', m, s, off: 0, data });
  emitTurns(agent, dbPath, data, 0);
  data.emitted = data.turns.length;
}

// ---------------- 详情：吃扫描时并进内存的那轮（不回源重开库） ----------------
// goose 正在跑时它的文件我实测拿到过 EPERM 独占锁，且整份重读一个 WAL 库只为出一轮不划算 ——
// 与 crush / devindb / traedb 同一取舍。
export function gooseEntryContent(src, full) {
  const st = files.get(src.file);
  if (!st || !st.data) return null;
  const raw = readGooseDb(src.file);       // 库小、且扫描刚读完还在 mtime 上，这里重读一次只为拿逐工具明细
  const t = st.data.turns[src.turn];
  if (!t) return null;
  const out = { user: t.preview || '', assistant: '', tools: [], calls: [], v: st.m + ':0',
    callsNote: 'goose 的会话库是 SQLite（sessions.db，**WAL**）：逐次用量在 assistant 行的 `metadata_json.usage` 里 '
      + '（⚠️ `inputTokens` **含**缓存 ⇒ tin = input − cacheRead、tcache = cacheRead；`elapsedMs` / `timeToFirstTokenMs` 现成）。'
      + '工具块叫 `toolRequest`（挂 assistant 行）/ `toolResponse`（挂 user 行），按块上的 `id`（call_xxx）配对。'
      + '会话合计取 `sessions.accumulated_*` —— 裸名 `sessions.input_tokens` 那组实测是**最后一次请求的快照**，不是累计。'
      + (st.data.ctx ? 'ctx 分母 = `model_config_json.max_tokens`。' : 'ctx 分母源里没有（该会话没落 model_config_json）。') };
  if (!raw) { out.assistant = ''; return out; }
  // 只取这一轮的行：从本轮的 user 行开始，到下一轮 user 行为止（行序 id 稳定）
  const userIdx = [];
  raw.messages.forEach((r, i) => { if (gooseIsUserPrompt(r)) userIdx.push(i); });
  const start = userIdx[src.turn];
  if (start === undefined) return out;
  const end = userIdx[src.turn + 1] === undefined ? raw.messages.length : userIdx[src.turn + 1];
  out.user = gooseUserText(raw.messages[start].content_json);
  const texts = [];
  for (let i = start; i < end; i++) {
    const r = raw.messages[i];
    let rowThink = '';
    for (const b of blocksOf(r.content_json)) {
      if (!b || !b.type) continue;
      if (b.type === 'text' && r.role === 'assistant' && typeof b.text === 'string') texts.push(b.text);
      if (b.type === 'thinking' && typeof b.thinking === 'string') rowThink += (rowThink ? '\n\n' : '') + b.thinking;
      if (b.type === 'toolRequest') {
        const v = (b.toolCall && b.toolCall.value) || {};
        const fi = {};
        out.tools.push({
          name: v.name || '?', tid: b.id || null, error: null,
          input: truncLite(typeof v.arguments === 'string' ? v.arguments : JSON.stringify(v.arguments ?? {}), fi), inputTrunc: !!fi.t,
          output: '', outputTrunc: false,
        });
      }
      if (b.type === 'toolResponse') {
        const tr = (b.toolResult && b.toolResult.value) || {};
        const tgt = out.tools.find(x => x.tid === b.id);
        const fo = {};
        const body = Array.isArray(tr.content) ? tr.content.map(c => (c && c.text) || '').filter(Boolean).join('\n') : JSON.stringify(tr.content ?? '');
        if (tgt) { tgt.output = truncLite(body, fo); tgt.outputTrunc = !!fo.t; }
        const bad = tr.isError === true || (b.toolResult && b.toolResult.status && b.toolResult.status !== 'success');
        if (bad && tgt) tgt.error = 'error';
      }
    }
    if (r.role === 'assistant') {
      const u = metaOf(r.metadata_json).usage || {};
      const cache = num(u.cacheReadTokens);
      out.calls.push({
        model: metaOf(r.metadata_json).inference?.requestedModel || '',
        tin: Math.max(0, num(u.inputTokens) - cache), tout: num(u.outputTokens), tcache: cache,
        dur: num(u.elapsedMs), ttft: num(u.timeToFirstTokenMs) || undefined,
        cost: u.cost ? num(u.cost) : undefined,
        thinking: rowThink ? truncLite(rowThink, {}) : undefined,
      });
    }
  }
  out.assistant = texts.join('\n\n---\n\n');
  if (t.compacts) out.callsNote += ' 该会话累计发生过 ' + t.compacts + ' 次压缩（usage_ledger.is_compaction）。';
  if (t.cost) out.callsNote += ' 本轮上游自报成本 ' + t.cost.toFixed(6) + '（cost_source=estimated）。';
  return out;
}

// 与 shared.trunc 同义，但这里不 import 它也能跑（保持解析器只依赖 shared 的公开件）
function truncLite(s, flag) {
  const v = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  if (v.length <= 800) return v;
  flag.t = true;
  return v.slice(0, 800);
}
