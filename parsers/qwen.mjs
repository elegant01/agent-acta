// ---------------- qwen 解析器（Qwen Code：~/.qwen/projects/<项目编码>/chats/<会话 id>.jsonl） ----------------
// Qwen Code 是阿里通义千问团队 Terminal-Bench 榜上的 CLI，**gemini-cli 的 fork**，npm 包
// `@qwen-code/qwen-code`（本机实测 0.25.1）。落盘（真机核实，不是二手资料）：
//   <home>/.qwen/settings.json                     ← 配置（provider/model，**绝不读**：里面有 envKey 指向的密钥名）
//   <home>/.qwen/projects/<cwd 编码>/chats/<uuid>.jsonl   ← **主源**（逐会话一份，追加式）
//   <home>/.qwen/projects/<cwd 编码>/chats/<uuid>.runtime.json ← 会话活死状态（不是正文，跳过）
//   <home>/.qwen/projects/<cwd 编码>/*.ledger.jsonl       ← 另一份视图，**显式排除**（产品自己筛它，见源码）
//   <home>/.qwen/usage/token-usage-<YYYY-M>.jsonl         ← 全局逐次用量账（含后台子 agent，见 ⚠️ 口径三）
//   <home>/.qwen/usage_record.jsonl                       ← 会话级汇总（测试拿它对账用）
//   <home>/.qwen/model-registry.json                      ← 模型目录（本解析器不需要：窗口容量在行内，见下）
// 目录整体可被 QWEN_HOME（全局目录）/ QWEN_RUNTIME_DIR（projects/tmp 那一层）改写 ⇒ candidateBases 两个都铺。
//
// 逐行是 **claude 同族的消息流**（但 parts 是 Gemini 形状，不是 Anthropic 的 type 块）：
//   {"uuid","parentUuid","sessionId","timestamp":"ISO","type":"user","provenance":"real_user",
//    "cwd","version","message":{"role":"user","parts":[{"text":"…"}]},
//    "executionContext":{"modelId","authType","approvalMode"}}
//   {"type":"assistant", …, "model":"kimi-k3", "message":{"role":"model","parts":[
//        {"text":"…","thought":true}   ← 思考块：靠 thought 标记认，不是 type
//      | {"text":"…"}                  ← 正文
//      | {"functionCall":{"id","name","args":{…}}}]},
//    "usageMetadata":{"promptTokenCount","candidatesTokenCount","thoughtsTokenCount",
//                     "totalTokenCount","cachedContentTokenCount"},
//    "contextWindowSize":1000000}      ← ⚠️ 窗口容量**就在行内**，不查表、不编分母
//   {"type":"tool_result", …, "message":{"role":"user","parts":[{"functionResponse":{"id","name","response":{"output"}}}]},
//    "toolCallResult":{"callId","status":"success","resultDisplay":{…,"exitCode":0,"error":null}}}
//   {"type":"system","subtype":"ui_telemetry","systemPayload":{"uiEvent":{…}}}   ← 逐次耗时/ttft 在这儿
// uiEvent 三种（本机实测）：
//   "qwen-code.api_response"：{prompt_id, execution_id, model, status_code, duration_ms, ttft_ms,
//                              input_token_count, output_token_count, cached_content_token_count,
//                              thoughts_token_count, total_token_count, response_text, auth_type, subagentId?}
//   "qwen-code.tool_call"   ：{call_id, function_name, function_args, duration_ms, started_at_ms,
//                              status, success, decision, tool_type, content_length}
//   "request_lifecycle"     ：{promptId, executionId, phase:"started"|"ended", …}（正文无关，跳过）
//
// ⚠️ 口径一：**promptTokenCount 含缓存**（与 cline / buddyext 同侧，与 openclaw / pi 相反）。
//   实样自证：同一次调用 total 15070 = prompt 14997 + candidates 73，而 cached 14592 是 prompt 的一部分
//   （若 prompt 不含缓存，total 就该是 14997+14592+73）。⇒ tin = prompt − cached、tcache = cached。
//   thoughtsTokenCount **不再另加**：total = prompt + candidates 恒成立，说明思考 token 已经在
//   candidates 里（实测两次调用都是这个等式），再加一遍就凭空多出 20~30。
// ⚠️ 口径二：**轮 = type:"user" 且正文非空**开一轮，其后 assistant/tool_result 归本轮（与 claude 家族一致）。
//   `tool_result` 的 message.role 也是 "user" —— 只看 role 会把一次工具返回切成一轮，所以判据必须是 **type**。
// ⚠️ 口径三：**后台子 agent 的调用不进轮**。同一份转录里躺着 `managed-auto-memory-extractor` 的
//   api_response（本机实测每次会话结束后都会跑一次，白给 5~6k 输入 token）。它的特征有两个，都用上：
//   `uiEvent.subagentId` 非空、`prompt_id` 形如 `<会话 id>#<子 agent id>#0`；主链是 `<会话 id>########0`。
//   只按其中一个判的话，将来子 agent 命名一变就把后台账记进用户头上。
//   ⚠️ 这条只影响 **telemetry 派生**的 dur/ttft —— 轮级 token 取 assistant 行的 usageMetadata，
//   后台调用没有 assistant 行（实测），所以轮级总量天然干净。
// ⚠️ 口径四：逐次 dur/ttft 只能从 telemetry 现取，assistant 行**没有**耗时字段，而两者之间没有共同的 id：
//   api_response 写在对应 assistant 行的**前一行**（追加序），故按「最近一条未消费的、token 对得上的」配对。
//   配不上时 dur/ttft 留 0 并在 callsNote 说明次数，不编数字。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, markKind, listDirCached, isDir, isFile, toText, trunc, readCompleteLines } from './shared.mjs';

export const QWEN_DIRNAMES = ['.qwen'];   // 默认 <home>/.qwen（QWEN_HOME 可整体改写）

// 一个文件是不是 qwen 转录：首行得同时带 sessionId 与 provenance（claude 那份没有 provenance，
// openclaw / pi 的每条是 {type:"message",message:{…}} 包一层 —— 三条都能把邻居挡在外面）。
export function isQwenTranscript(fp) {
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    if (n <= 0) return false;
    const head = buf.toString('utf8', 0, n);
    const end = head.indexOf('\n');
    try {
      const j = JSON.parse(end < 0 ? head : head.slice(0, end));
      return !!j && typeof j.sessionId === 'string' && typeof j.provenance === 'string' && !!j.type;
    } catch { return false; }
  } finally { try { fs.closeSync(fd); } catch {} }
}

// base 可能是 ~/.qwen、~/.qwen/projects、某个项目目录、甚至某个 chats/ 目录（手工添加时用户就这么填）。
// 返回「该由谁去摆 projects/<项目>/chats 这两层」的那个根：
//   · 指到 chats/        → 它的项目目录
//   · 指到某个项目目录    → 那个项目目录本身（scanQwen 认这种「只有一层」的摆法）
//   · 指到 ~/.qwen 或 projects 根 → projects 根
// 判据始终是**内容**（首行带 sessionId + provenance），所以名字猜错不会误接邻居的数据。
function qwenChatsOk(dir) {
  if (!isDir(dir)) return false;
  for (const fn of (listDirCached(dir) || []).slice(0, 2000)) {
    if (!fn.endsWith('.jsonl') || fn.endsWith('.ledger.jsonl')) continue;
    if (isQwenTranscript(path.join(dir, fn))) return true;
  }
  return false;
}
export function qwenProjectsRoot(base) {
  if (!base || !isDir(base)) return null;
  if (path.basename(base).toLowerCase() === 'chats' && qwenChatsOk(base)) return path.dirname(base);
  if (qwenChatsOk(path.join(base, 'chats'))) return base;                     // 直接给了某个项目目录
  const proj = path.join(base, 'projects');
  if (isDir(proj)) {
    for (const dn of (listDirCached(proj) || []).slice(0, 400)) {
      if (qwenChatsOk(path.join(proj, dn, 'chats'))) return proj;
    }
  }
  for (const dn of (listDirCached(base) || []).slice(0, 400)) {              // base 本身就是 projects 根
    if (qwenChatsOk(path.join(base, dn, 'chats'))) return base;
  }
  return null;
}

// 枚举「根」下所有会话文件（discovery 的 confAvailable 与扫描主路共用这一份判据）
function qwenFiles(root) {
  const out = [];
  for (const dn of qwenProjectNames(root)) {
    const chats = path.join(root, dn, 'chats');
    if (!isDir(chats)) continue;
    for (const fn of (listDirCached(chats) || []).slice(0, 2000)) {
      // .ledger.jsonl 是另一份视图、.runtime.json 是活死状态 —— 都不进正文（产品自己也排除 ledger）
      if (!fn.endsWith('.jsonl') || fn.endsWith('.ledger.jsonl')) continue;
      const fp = path.join(chats, fn);
      if (!isFile(fp) || !isQwenTranscript(fp)) continue;
      out.push({ fp, projectDir: dn, sessionId: fn.replace(/\.jsonl$/, '') });
    }
  }
  return out;
}
// 根有两种摆法：projects 根（子目录 = 各项目）或单个项目目录（它自己就有 chats/）
function qwenProjectNames(root) {
  return isDir(path.join(root, 'chats')) ? ['.'] : (listDirCached(root) || []).slice(0, 400);
}
export function hasQwenSessions(root) { return qwenFiles(root).length > 0; }

export function qwenIdBase(fp) { return 'qw#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function tsMs(v) {
  const t = typeof v === 'string' ? Date.parse(v) : num(v);
  return Number.isFinite(t) ? t : 0;
}

// parts[] 抽正文。thinking=true 时只取带 thought 标记的块（详情里思考单独留痕用）。
function partsText(parts, wantThought) {
  const buf = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== 'object') continue;
    const isThought = !!p.thought;
    if (isThought !== wantThought) continue;
    if (typeof p.text === 'string' && p.text.trim()) buf.push(p.text);
  }
  return buf.join('\n\n');
}

// I8 复现包用：与扫描侧同一套开轮正文判据（别家解析器演进各自独立，不共用）
export function qwenUserText(message) {
  const t = partsText(message && message.parts, false);
  return t.trim() ? t : '';
}

// usageMetadata → 三个桶（口径一：prompt 含缓存，思考已在 candidates 里）
function addUsage(cur, u) {
  if (!u) return false;
  const prompt = num(u.promptTokenCount), cached = num(u.cachedContentTokenCount);
  cur.tin += Math.max(0, prompt - cached);
  cur.tout += num(u.candidatesTokenCount);
  cur.tcache += cached;
  if (prompt) cur.ctxUsed = prompt;
  return true;
}

function emitTurns(agent, fp, data, fromIdx) {
  const idBase = qwenIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(idBase + t.idx, {
      agent,
      project: data.project,
      session: data.session,
      name: data.name || undefined,
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : Math.max(0, (t.lastTs || 0) - t.time),
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: t.win || 0,             // 行内 contextWindowSize，取不到就 0（不查表编分母）
      ctxUsed: t.ctxUsed || 0,
      rounds: t.calls, calls: t.calls, tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: !!t.aborted,
      toolNames: t.toolNames,
      compacts: t.compacts || undefined,
    }, { file: fp, turn: t.idx, kind: 'qwen' });
  }
}

// ---------------- 扫描主入口（OFF_KINDS：逐行 off 增量续读，语义与 claude / pi 一致） ----------------
// root = **projects 根**（qwenProjectsRoot 解析出来的那一层）。
export function scanQwen(agent, root, onlyFile) {
  if (!isDir(root)) return;
  for (const dn of qwenProjectNames(root)) {
    const chats = path.join(root, dn, 'chats');
    if (!isDir(chats)) continue;
    for (const fn of listDirCached(chats) || []) {
      if (!fn.endsWith('.jsonl') || fn.endsWith('.ledger.jsonl')) continue;
      const fp = path.join(chats, fn);
      if (onlyFile && fp !== onlyFile) continue;
      if (!isFile(fp)) continue;
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) {
        if (prev.data?.turns?.length && !entries.has(qwenIdBase(fp) + (prev.data.turns.length - 1)))
          emitTurns(agent, fp, prev.data, 0);
        continue;
      }
      let off = prev?.off || 0;
      const data = prev?.data || { turns: [], emitted: 0, sessionId: '', session: '', project: '' };
      if (s < off) { off = 0; data.turns = []; data.emitted = 0; }   // 被整份重写（导出/迁移）：从头再来
      if (s <= off) {
        if (!data.session) data.session = fn.replace(/\.jsonl$/, '');
        if (!data.project) data.project = dn;
        files.set(key, { agent, kind: 'qwen', m, s, off, data });
        markKind('qwen');
        continue;
      }
      try {
        const rd = readCompleteLines(fp, off, s);
        if (!rd) { files.set(key, { agent, kind: 'qwen', m, s, off, data }); markKind('qwen'); continue; }
        if (!data.session) data.session = fn.replace(/\.jsonl$/, '');
        if (!data.project) data.project = dn;
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (!data.sessionId && typeof j.sessionId === 'string') data.sessionId = j.sessionId;
          // 项目名取行内 cwd（目录名把 `: \ /` 全换成 `-`，F:/a 与 F-\a 会撞名 —— 与 pi 同一坑）
          if (typeof j.cwd === 'string' && j.cwd) data.project = j.cwd;
          if (j.type === 'system') {
            // 扫描侧只吃三类系统行：API 失败（轮要标红）、压缩（轮要计数）、改名（会话名）
            if (j.subtype === 'chat_compression' && Array.isArray(j.systemPayload?.compressedHistory)) {
              const t = data.turns[data.turns.length - 1];
              if (t) { t.compacts++; t.lastTs = Math.max(t.lastTs, tsMs(j.timestamp)); }
              continue;
            }
            if (j.subtype === 'custom_title') {
              const ct = j.systemPayload && j.systemPayload.customTitle;
              if (typeof ct === 'string' && ct.trim()) data.name = ct.trim();
              continue;
            }
            const u = j.systemPayload && j.systemPayload.uiEvent;
            if (!u) continue;
            const ev = u['event.name'];
            if (ev !== 'qwen-code.api_error' && ev !== 'qwen-code.api_response') continue;
            const t = data.turns[data.turns.length - 1];
            if (!t) continue;
            const pid = String(u.prompt_id || '');
            if (u.subagentId || (pid && !pid.includes('########'))) continue;   // 后台子 agent 不算用户的轮
            t.lastTs = Math.max(t.lastTs, tsMs(j.timestamp));
            const code = num(u.status_code);
            if (ev === 'qwen-code.api_error') { t.err = true; if (!t.errMsg) t.errMsg = u.error_message || ('HTTP ' + code); }
            else if (code && code !== 200) { t.err = true; if (!t.errMsg) t.errMsg = 'HTTP ' + code; }
            continue;
          }
          if (j.type === 'tool_result') {
            const t = data.turns[data.turns.length - 1];
            if (!t) continue;
            t.lastTs = Math.max(t.lastTs, tsMs(j.timestamp));
            continue;
          }
          if (j.type !== 'user' && j.type !== 'assistant') continue;
          const msg = j.message || {};
          if (j.type === 'user') {
            const text = qwenUserText(msg);
            if (!text) continue;                    // 空用户消息不开轮（否则扫描与详情的轮序号错位）
            data.turns.push({
              idx: data.turns.length,
              time: tsMs(j.timestamp), lastTs: tsMs(j.timestamp),
              tin: 0, tout: 0, tcache: 0, ctxUsed: 0, win: 0,
              calls: 0, tools: 0, models: [], err: false, errMsg: '', aborted: false,
              compacts: 0, toolNames: {},
              preview: text.replace(/\s+/g, ' ').slice(0, 300),
            });
            continue;
          }
          const t = data.turns[data.turns.length - 1];
          if (!t) continue;                          // 首条 user 之前的注入不进轮
          t.calls++;
          t.lastTs = Math.max(t.lastTs, tsMs(j.timestamp));
          addUsage(t, j.usageMetadata);
          if (Number.isFinite(Number(j.contextWindowSize)) && Number(j.contextWindowSize) > 0) t.win = Number(j.contextWindowSize);
          const mdl = typeof j.model === 'string' ? j.model : '';
          if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
          for (const p of (Array.isArray(msg.parts) ? msg.parts : [])) {
            const fc = p && p.functionCall;
            if (!fc) continue;
            const nm = (typeof fc.name === 'string' && fc.name) || '?';
            t.tools++;
            t.toolNames[nm] = (t.toolNames[nm] || 0) + 1;
          }
        }
        files.set(key, { agent, kind: 'qwen', m, s, off: rd.newOff, data });
        markKind('qwen');
        emitTurns(agent, fp, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}

// ---------------- 详情：重读转录按 src.turn 过滤，逐次 dur/ttft 从 telemetry 现配对 ----------------
export function qwenEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + (st.off || 0) : null;
  let lines;
  try { lines = fs.readFileSync(src.file, 'utf8').split('\n'); } catch { return null; }
  const out = {
    user: '', assistant: '', tools: [], calls: [], v: version,
    callsNote: 'qwen 转录（projects/<项目>/chats/<会话 id>.jsonl）逐行是消息，usageMetadata 在每条 assistant ' +
      '行内（⚠️ promptTokenCount **含**缓存 ⇒ tin = prompt − cached；思考已在 candidates 里，不另加）；' +
      '上下文窗口容量取行内 contextWindowSize。逐次 dur/ttft 来自同一份转录里的 qwen-code.api_response ' +
      '遥测行（assistant 行本身不落耗时，两者没有公共 id ⇒ 按「紧邻的前一条、token 对得上」配对）。' +
      '后台 managed-auto-memory-extractor 等子 agent 的调用**不计入**（它只有遥测行、没有 assistant 行）。',
  };
  const texts = [];
  let turnIdx = -1;
  let errMsg = '';
  let apiQueue = [];          // 本轮内未消费的**主链** api_response
  let paired = 0, unpaired = 0, subSkipped = 0;
  let compactCount = 0, lastKept = 0;
  const toolEvents = new Map();  // call_id → {dur, status, decision}
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'system') {
      if (j.subtype === 'chat_compression' && Array.isArray(j.systemPayload?.compressedHistory)) {
        if (turnIdx === src.turn) { compactCount++; lastKept = j.systemPayload.compressedHistory.length; }
        continue;
      }
      if (j.subtype === 'custom_title' || (j.subtype && j.subtype !== 'ui_telemetry' && j.subtype !== 'attribution_snapshot')) continue;
      const u = j.systemPayload && j.systemPayload.uiEvent;
      if (!u) continue;
      const pid = String(u.prompt_id || u.promptId || '');
      const isSub = !!u.subagentId || (!!pid && !pid.includes('########'));
      if (u['event.name'] === 'qwen-code.tool_call') {
        if (isSub) { subSkipped++; continue; }
        toolEvents.set(String(u.call_id || ''), {
          dur: num(u.duration_ms), status: u.status || '', success: u.success !== false,
          decision: u.decision || '', args: u.function_args, name: u.function_name || '',
        });
        continue;
      }
      if (u['event.name'] === 'qwen-code.api_error') {
        if (isSub || turnIdx !== src.turn) continue;
        if (!errMsg) errMsg = u.error_message || (u.error_type ? String(u.error_type) : 'HTTP ' + num(u.status_code));
        continue;
      }
      if (u['event.name'] !== 'qwen-code.api_response') continue;   // request_lifecycle 等不进正文
      if (isSub) { subSkipped++; continue; }
      if (turnIdx !== src.turn) continue;
      apiQueue.push({
        tin: num(u.input_token_count), tout: num(u.output_token_count),
        tcache: num(u.cached_content_token_count), dur: num(u.duration_ms), ttft: num(u.ttft_ms),
        code: num(u.status_code), model: u.model || '', consumed: false,
      });
      if (u.status_code && num(u.status_code) !== 200 && !errMsg) errMsg = 'HTTP ' + u.status_code;
      continue;
    }
    if (j.type === 'tool_result') {
      if (turnIdx !== src.turn) continue;
      for (const p of (j.message?.parts || [])) {
        const fr = p && p.functionResponse;
        if (!fr) continue;
        const t = out.tools.find(x => x.tid === fr.id);
        const res = j.toolCallResult || {};
        const fo = {};
        const output = toText(fr.response ? (fr.response.output !== undefined ? fr.response.output : fr.response) : fr);
        if (t) {
          t.output = trunc(output, full, fo); t.outputTrunc = !!fo.t;
          const te = toolEvents.get(String(fr.id || ''));
          if (te) { t.dur = te.dur; if (te.success === false || te.status === 'error') t.error = 'error'; }
          if (res.status && res.status !== 'success') t.error = 'error';
        } else {
          out.tools.push({
            name: fr.name || '?', tid: fr.id || null, error: res.status && res.status !== 'success' ? 'error' : null,
            dur: 0, input: '', inputTrunc: false, output: trunc(output, full, fo), outputTrunc: !!fo.t,
          });
        }
      }
      continue;
    }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const msg = j.message || {};
    if (j.type === 'user') {
      if (!qwenUserText(msg)) continue;      // 与扫描侧同判据（同一个函数），否则轮序号错开
      turnIdx++;
      apiQueue = [];
      if (turnIdx === src.turn) out.user = qwenUserText(msg);
      continue;
    }
    if (turnIdx !== src.turn) continue;
    const think = partsText(msg.parts, true);
    const text = partsText(msg.parts, false);
    if (text) texts.push(text);
    const u = j.usageMetadata || {};
    const prompt = num(u.promptTokenCount), cached = num(u.cachedContentTokenCount);
    // 配对：优先 token 对得上的最近一条，退到紧邻的前一条（同一次调用必然紧邻写在 assistant 之前）
    let ev = null;
    for (let k = apiQueue.length - 1; k >= 0; k--) {
      const c = apiQueue[k];
      if (c.consumed) continue;
      if (c.tin === prompt && prompt) { ev = c; break; }
    }
    if (!ev) for (let k = apiQueue.length - 1; k >= 0; k--) if (!apiQueue[k].consumed) { ev = apiQueue[k]; break; }
    if (ev) { ev.consumed = true; paired++; } else unpaired++;
    const call = {
      model: j.model || (ev && ev.model) || '',
      tin: Math.max(0, prompt - cached), tout: num(u.candidatesTokenCount), tcache: cached,
      dur: ev ? ev.dur : 0, ttft: ev ? ev.ttft : 0,
    };
    if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
    if (think) { const fh = {}; call.thinking = trunc(think, full, fh); call.thinkingTrunc = !!fh.t; }
    for (const p of (Array.isArray(msg.parts) ? msg.parts : [])) {
      const fc = p && p.functionCall;
      if (!fc) continue;
      const nm = (typeof fc.name === 'string' && fc.name) || '?';
      const fi = {};
      const args = typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {});
      out.tools.push({
        name: nm, tid: fc.id || null, error: null,
        input: trunc(args, full, fi), inputTrunc: !!fi.t, output: '', outputTrunc: false,
      });
      (call.tools || (call.tools = [])).push(nm);
    }
    out.calls.push(call);
    if (turnIdx > src.turn) break;
  }
  out.assistant = texts.join('\n\n---\n\n');
  if (errMsg) out.callsNote += ' 这一轮没有成功拿到模型回复：' + errMsg + '。';
  if (compactCount) out.callsNote += ' 本轮之后发生过 ' + compactCount + ' 次上下文压缩（/compress，压缩后仍保留 ' + lastKept + ' 条历史）。';
  if (subSkipped) out.callsNote += ' 同转录里有 ' + subSkipped + ' 条后台子 agent 调用（记忆提取等），按口径不计入本轮。';
  if (unpaired) out.callsNote += ' 其中 ' + unpaired + ' 次调用没配上遥测行（dur/ttft 记 0，源头没有别的耗时字段）。';
  else if (paired) out.callsNote += ' 逐次 dur/ttft 与遥测行全部配对（' + paired + ' 次）。';
  return out;
}
