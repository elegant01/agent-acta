// ---------------- openclaw 解析器（OpenClaw：<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl） ----------------
// stateDir（默认 ~/.openclaw，Windows 与 mac/Linux 同）下的摆法：
//   <stateDir>/agents/<agentId>/agent/models.json      ← 模型目录：每家 provider 的 models[].id → contextWindow（ctx 分母）
//   <stateDir>/agents/<agentId>/sessions/sessions.json ← 会话索引：sessionKey（"agent:main:main"）→ sessionId / sessionFile
//   <stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl            ← **主源**（本文件只读它）
//   <stateDir>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl ← 运行轨迹（另一份视图，本版不读，见文末）
//   <stateDir>/state/openclaw.sqlite                    ← 认证/设备/租约状态，**不是**会话源（实测：表里没有会话）
//
// 主源是**追加式会话树**（源码 packages/agent-core/src/harness/types.d.ts 的 SessionTreeEntry 核实），
// 逐行 JSON，首行是会话头、其后是条目：
//   {"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"…"}        ← 头（只有它没有 parentId）
//   {"type":"message","id","parentId","timestamp","message":{…}}                      ← 对话消息（唯一带正文的类型）
//   {"type":"session_info","name":"…"}                                                ← 会话名（产品自己写的标题）
//   {"type":"model_change","provider","modelId"} / {"type":"thinking_level_change","thinkingLevel"}
//   {"type":"custom","customType","data"}          ← 注入上下文但**不**回放给模型
//   {"type":"custom_message","customType","content","display"} ← 注入且回放（实测 customType="openclaw:bootstrap-context:full"）
//   {"type":"compaction","summary","firstKeptEntryId","tokensBefore"} / {"type":"branch_summary","fromId","summary"}
//   {"type":"label","targetId","label"} / {"type":"leaf","targetId"}   ← 纯导航标记，不含对话内容
//
// message 是 llm-core 的 Message（源码 packages/llm-core/src/types.d.ts 核实），三种角色：
//   user       {role:"user", content: string | [{type:"text",text}] ,        timestamp}
//   assistant  {role:"assistant", content: [{type:"text"|"thinking"|"toolCall"}],
//               api, provider, model, usage, stopReason, errorMessage?/errorCode?, timestamp}
//   toolResult {role:"toolResult", toolCallId, toolName, content:[{type:"text"}], isError, timestamp}
//   toolCall 块 = {type:"toolCall", id, name, arguments:{…}}（arguments 是**对象**，不是 JSON 字符串）
//   usage = {input, output, cacheRead, cacheWrite, totalTokens, cost:{…}}
//   stopReason = "stop" | "length" | "toolUse" | "error" | "aborted"
//
// ⚠️ 口径关键：**input 不含 cache**。不是推断，是源码里写死的 ——
//   dist/openai-completions-*.js: `const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)`
//   且 `totalTokens = input + output + cacheRead + cacheWrite`；dist/agent-runner.runtime-*.js 另有一处
//   `const promptTotal = (cacheRead ?? 0) + (cacheWrite ?? 0) + (input ?? 0)`。
//   ⇒ tin = usage.input 直接取（与 minimax 同口径），tcache = cacheRead + cacheWrite（两个互斥桶，**不能**取 max）。
//   ⇒ 上下文占用 = 三者之和（那正是 promptTotal）；**不是** input 单独一项。
//
// 轮口径（与 minimax / hermes 同款）：message.role==="user" 且正文非空 → 开新轮，下一条 user 收轮；
// 轮内多轮 assistant（工具循环）的 usage 求和；time = 首条 user 消息的 message.timestamp（毫秒）。
// 失败轮：assistant 的 stopReason==="error"（带 errorMessage/errorCode，详情原样带出来），
//         或 toolResult 的 isError=true；stopReason==="aborted"（用户中断）按 claude 口径与 status 独立，只标 aborted。
// 空用户消息不开轮（同 doubao / minimax）：开了就会让「扫到 N 轮」与「详情第 N 轮」错位。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, markKind, listDirCached, isDir, isFile, toText, trunc, readCompleteLines } from './shared.mjs';

// ---------------- 根目录解析（供 discovery 的 sniffBase 与手工添加共用） ----------------
// 真实摆法（源码 dist/config-utils-*.js 的 resolveStateDir）：stateDir 名字是 `.openclaw`，
// 老版本叫 `.clawdbot`（LEGACY_STATE_DIRNAMES），且 OPENCLAW_STATE_DIR 可整体改写。
// 手工添加时用户可能填任意一层：stateDir / agents / agents/<id> / agents/<id>/sessions —— 都认。
export const OPENCLAW_STATE_DIRNAMES = ['.openclaw', '.clawdbot'];

// 一个文件是不是 openclaw 转录：首行必须是会话头（带 type:"session" + version + id）。
// 只读头 2KB —— 会话头是首行且很短（实测 ~150 字节）。
export function isOpenclawTranscript(fp) {
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    if (n <= 0) return false;
    const head = buf.toString('utf8', 0, n);
    const end = head.indexOf('\n');
    const first = end < 0 ? head : head.slice(0, end);
    if (!first) return false;
    try {
      const j = JSON.parse(first);
      return j && j.type === 'session' && j.version !== undefined && typeof j.id === 'string';
    } catch { return false; }
  } finally { try { fs.closeSync(fd); } catch {} }
}

// transcriptsOf(root)：root 是**任意一层**，返回 {root: <stateDir>, files: [{fp, agentId, sessionId}]}。
// 内容判据兜底（认头行形状），所以名字猜错不会误接别的 agent 的数据。
export function openclawTranscripts(base) {
  if (!isDir(base)) return null;
  const cands = [];
  const bn = path.basename(base).toLowerCase();
  if (bn === 'agents') cands.push(path.dirname(base));
  else if (bn === 'sessions') cands.push(path.dirname(path.dirname(path.dirname(base))));   // <root>/agents/<id>/sessions
  else {
    cands.push(base);
    cands.push(path.dirname(path.dirname(base)));   // 填的是 agents/<id> → 上两级
    cands.push(path.dirname(base));                 // 填的是 <root>/agents → 上一级
  }
  for (const root of [...new Set(cands)]) {
    if (!root) continue;
    const out = scanTranscriptFiles(root);
    if (out.length) return { root, files: out };
  }
  return null;
}

// root = stateDir（含 agents/）。枚举 agents/<id>/sessions/*.jsonl（**排除** .trajectory.jsonl）。
// 上限只为「别在嗅探上失控」：agent 目录最多 16 个、每个会话目录最多认 200 个转录。
function scanTranscriptFiles(root) {
  const out = [];
  const agentsDir = path.join(root, 'agents');
  if (!isDir(agentsDir)) return out;
  for (const aid of (listDirCached(agentsDir) || []).slice(0, 16)) {
    const sessDir = path.join(agentsDir, aid, 'sessions');
    if (!isDir(sessDir)) continue;
    for (const fn of (listDirCached(sessDir) || []).slice(0, 200)) {
      if (!fn.endsWith('.jsonl') || fn.includes('.trajectory.')) continue;
      const fp = path.join(sessDir, fn);
      if (!isFile(fp) || !isOpenclawTranscript(fp)) continue;
      out.push({ fp, agentId: aid, sessionId: fn.replace(/\.jsonl$/, '') });
    }
  }
  return out;
}

// 供 agent-acta-server 的 confAvailable 用：目录型来源，只要 root 下能枚举出转录就算可用
export function hasOpenclawSessions(root) {
  return scanTranscriptFiles(root).length > 0;
}

export function openclawIdBase(fp) { return 'oc#' + fp.replace(/[\\/:]/g, '~') + '#'; }

// ---------------- 两个带 mtime 缓存的小目录表（每次扫描都调，不能每轮重读） ----------------
// sessions.json（会话索引）：sessionId → sessionKey，拿它当 entry.session 比裸 UUID 可读得多。
const _keyCache = new Map();
function sessionKeyMap(sessDir) {
  const fp = path.join(sessDir, 'sessions.json');
  let st; try { st = fs.statSync(fp); } catch { return null; }
  const c = _keyCache.get(fp);
  if (c && c.m === st.mtimeMs) return c.map;
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const [k, v] of Object.entries(j || {})) {
      const sid = v && v.sessionId;
      if (sid) map.set(String(sid), k);
    }
  } catch {}
  _keyCache.set(fp, { m: st.mtimeMs, map });
  return map;
}

// agent/models.json：模型 id → contextWindow（ctx 分母）。文件里带 apiKey —— **只取 id 与 contextWindow**，
// 绝不把整份内容带进任何日志或响应。
const _winCache = new Map();
function windowMapFor(root, agentId) {
  const fp = path.join(root, 'agents', agentId, 'agent', 'models.json');
  let st; try { st = fs.statSync(fp); } catch { return null; }
  const c = _winCache.get(fp);
  if (c && c.m === st.mtimeMs) return c.map;
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const p of Object.values((j && j.providers) || {})) {
      const arr = p && Array.isArray(p.models) ? p.models : [];
      for (const m of arr) {
        const id = m && m.id, w = Number(m && m.contextWindow);
        if (id && Number.isFinite(w) && w > 0) map.set(String(id), w);
      }
    }
  } catch {}
  _winCache.set(fp, { m: st.mtimeMs, map });
  return map;
}

// I8 复现包原始片段提取复用：与扫描侧 role==='user' 的开轮判定**同一套**（正文非空即开轮）。
export function openclawUserText(content) {
  const t = contentText(content, /*dropThinking*/true);
  return t.trim() ? t : '';
}

// ---------------- 文本与用量小工具 ----------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// content 数组里抽文本。dropThinking=true 用于**用户**正文：思考块不该混进用户输入列。
// 字符串型 content（user 可以就是纯字符串）原样交给 toText。
function contentText(content, dropThinking) {
  if (Array.isArray(content)) {
    const buf = [];
    for (const p of content) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') buf.push(p.text);
      else if (p.type === 'thinking' && !dropThinking && typeof p.thinking === 'string') buf.push(p.thinking);
    }
    return buf.join('\n\n');
  }
  return toText(content);
}

// ---------------- emit：把一轮落成 entry ----------------
// 轮字段：time/dur/status/tin/tout/tcache/total/ctx/ctxUsed/rounds/calls/tools/models/preview/finished/aborted/toolNames
//   · ctx      = 该轮模型的 contextWindow（agents/<id>/agent/models.json；取不到 → 0，页面退化成只显示占用）
//   · ctxUsed  = 轮内最后一次 assistant 的 prompt 总量 = input + cacheRead + cacheWrite（见文件头 ⚠️）
//   · finished = i < turns.length-1；最后一轮由页面按 lastTs 兜底（同 doubao / minimax）
function emitTurns(agent, fp, data, fromIdx) {
  const idBase = openclawIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(idBase + t.idx, {
      agent,
      project: data.project,
      session: data.session,
      name: data.name || undefined,
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : 0,
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: t.win || 0,
      ctxUsed: t.ctxUsed || 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: !!t.aborted,
      toolNames: t.toolNames,
    }, { file: fp, turn: t.idx, kind: 'openclaw' });
  }
}

// 会话头（首行）元数据补读：拿到 sessionId / cwd / 起始时间。index 恢复、文件截断重来、首读落在 off>0
// 这三种情况都拿不到首行，所以单独读一次 2KB —— 首行实测只有 ~150 字节。
function readHeader(fp, data, firstLine) {
  try {
    let line = firstLine;
    if (line === undefined) {
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(2048);
        const n = fs.readSync(fd, buf, 0, 2048, 0);
        const head = buf.toString('utf8', 0, n);
        const end = head.indexOf('\n');
        line = end < 0 ? head : head.slice(0, end);
      } finally { fs.closeSync(fd); }
    }
    const h = JSON.parse(line || '');
    if (!h || h.type !== 'session') return false;
    if (typeof h.id === 'string' && h.id) data.sessionId = h.id;
    if (typeof h.cwd === 'string') data.cwd = h.cwd;
    data.startedAt = Date.parse(h.timestamp) || 0;
    return true;
  } catch { return false; }
}

// ---------------- 扫描主入口（OFF_KINDS：逐行 off 增量续读，语义与 claude / doubao 一致） ----------------
// root = stateDir（由 discovery 的 sniffBase 解析出的那个）。每个会话一个文件，逐行追加。
export function scanOpenclaw(agent, root, onlyFile) {
  if (!isDir(root)) return;
  const agentsDir = path.join(root, 'agents');
  if (!isDir(agentsDir)) return;
  for (const aid of listDirCached(agentsDir) || []) {
    const sessDir = path.join(agentsDir, aid, 'sessions');
    if (!isDir(sessDir)) continue;
    const keys = sessionKeyMap(sessDir);
    const wins = windowMapFor(root, aid);
    for (const fn of listDirCached(sessDir) || []) {
      // ⚠️ 必须排掉 .trajectory.jsonl —— 它同样以 .jsonl 结尾，但格式完全不同（运行轨迹，不是会话树）
      if (!fn.endsWith('.jsonl') || fn.includes('.trajectory.')) continue;
      const fp = path.join(sessDir, fn);
      if (onlyFile && fp !== onlyFile) continue;
      if (!isFile(fp)) continue;
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) {
        // 重启后 entries 为空但 files 状态已从 index 恢复：直接重建条目，不重扫文件
        if (prev.data?.turns?.length && !entries.has(openclawIdBase(fp) + (prev.data.turns.length - 1)))
          emitTurns(agent, fp, prev.data, 0);
        continue;
      }
      const off = prev?.off || 0;
      const data = prev?.data || {
        turns: [], emitted: 0, sessionId: '', session: '',
        name: '', cwd: '', project: '', startedAt: 0, curModel: '', markerTypes: [],
      };
      // 文件被截断（off 已推到文件尾之后）：旧写法在这里会永久卡住（s <= off 短路 → 再也不读）。
      // 转录正常只追加，但压缩/重建会重写整份 —— 宁可整份重来，也不能装作没事。
      if (s < off) { off = 0; data.turns = []; data.emitted = 0; }
      if (s <= off) {
        if (!data.cwd) readHeader(fp, data);
        if (!data.sessionId) data.sessionId = fn.replace(/\.jsonl$/, '');
        if (!data.session) data.session = (keys && keys.get(data.sessionId)) || (aid + ':' + data.sessionId);
        if (!data.project) data.project = data.cwd || '(openclaw)';
        files.set(key, { agent, kind: 'openclaw', m, s, off, data });
        markKind('openclaw');
        continue;
      }
      try {
        const rd = readCompleteLines(fp, off, s);
        if (!rd) { files.set(key, { agent, kind: 'openclaw', m, s, off, data }); markKind('openclaw'); continue; }
        const newOff = rd.newOff;
        // 会话头（首行）只在 off===0 那轮落进 rd.lines；其余情况（index 恢复、截断重来）单独补读首行
        if (off === 0 && rd.lines.length) readHeader(fp, data, rd.lines[0]);
        else if (!data.cwd) readHeader(fp, data);
        if (!data.sessionId) data.sessionId = fn.replace(/\.jsonl$/, '');
        if (!data.session) data.session = (keys && keys.get(data.sessionId)) || (aid + ':' + data.sessionId);
        if (!data.project) data.project = data.cwd || '(openclaw)';
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          // ---- 会话头：只在 off=0 那轮见到，元数据已在上方补过 ----
          if (j.type === 'session') continue;
          // ---- 会话名（产品自己写的标题）：只影响 entry.name，最后一笔为准 ----
          if (j.type === 'session_info') {
            if (typeof j.name === 'string' && j.name.trim()) data.name = j.name.trim();
            continue;
          }
          if (j.type === 'model_change') {
            if (typeof j.modelId === 'string' && j.modelId) data.curModel = j.modelId;
            continue;
          }
          // ---- 注入/压缩类标记：不进正文、不开轮，但**不静默丢弃** ——
          //      更新 lastTs（否则末尾的注入会截断该轮 dur）、计数并记类型，详情侧留痕。
          if (j.type === 'custom' || j.type === 'custom_message' || j.type === 'compaction' || j.type === 'branch_summary') {
            const cur = data.turns[data.turns.length - 1];
            const ct = typeof j.customType === 'string' && j.customType ? j.customType : j.type;
            if (!data.markerTypes.includes(ct)) data.markerTypes.push(ct);
            if (cur) {
              const ts = num(j.data && j.data.timestamp) || Date.parse(j.timestamp) || 0;
              if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
              cur.markers = (cur.markers || 0) + 1;
              if (!cur.markerTypes) cur.markerTypes = [];
              if (!cur.markerTypes.includes(ct)) cur.markerTypes.push(ct);
            }
            continue;
          }
          // ---- 纯导航/状态标记（label / leaf / thinking_level_change）：不含对话内容，跳过 ----
          if (j.type !== 'message') continue;
          const msg = j.message || {};
          const role = msg.role;
          if (role === 'user') {
            const text = openclawUserText(msg.content);
            if (!text) continue;   // 空用户消息不开轮（否则扫描与详情的轮序号会错位）
            data.turns.push({
              idx: data.turns.length,
              time: num(msg.timestamp) || Date.parse(j.timestamp) || 0,
              lastTs: num(msg.timestamp) || Date.parse(j.timestamp) || 0,
              tin: 0, tout: 0, tcache: 0, ctxUsed: 0, win: 0,
              calls: 0, tools: 0, models: [], err: false, aborted: false, errMsg: '',
              markers: 0, markerTypes: [], toolNames: {},
              preview: text.replace(/\s+/g, ' ').slice(0, 300),
            });
          } else if (role === 'assistant' && data.turns.length) {
            const cur = data.turns[data.turns.length - 1];
            cur.calls++;
            const ts = num(msg.timestamp) || Date.parse(j.timestamp) || 0;
            if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
            const u = msg.usage;
            if (u) {
              // ⚠️ input 不含 cache（源码写死），tin 直接取；tcache = 两个 cache 桶之和
              cur.tin += num(u.input);
              cur.tout += num(u.output);
              cur.tcache += num(u.cacheRead) + num(u.cacheWrite);
              cur.ctxUsed = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);   // prompt 总量
            }
            if (msg.model) {
              if (!cur.models.includes(msg.model)) cur.models.push(msg.model);
              const w = wins && wins.get(msg.model);
              if (w) cur.win = w;
            }
            const sr = msg.stopReason;
            if (sr === 'error') {
              cur.err = true;
              if (!cur.errMsg) cur.errMsg = msg.errorMessage || (msg.errorCode ? 'errorCode=' + msg.errorCode : '');
            } else if (sr === 'aborted') {
              cur.aborted = true;   // 用户中断：与 status 独立（同 claude 口径）
            }
            const content = Array.isArray(msg.content) ? msg.content : [];
            for (const p of content) {
              if (!p || typeof p !== 'object' || p.type !== 'toolCall') continue;
              const nm = typeof p.name === 'string' && p.name ? p.name : '?';
              cur.tools++;
              cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
            }
          } else if (role === 'toolResult' && data.turns.length) {
            // 扫描侧只吃两个信号：轮时间与失败标志（工具计数已在 assistant 行完成，避免重复计数）
            const cur = data.turns[data.turns.length - 1];
            const ts = num(msg.timestamp) || Date.parse(j.timestamp) || 0;
            if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
            if (msg.isError) cur.err = true;
          }
        }
        files.set(key, { agent, kind: 'openclaw', m, s, off: newOff, data });
        markKind('openclaw');
        emitTurns(agent, fp, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}

// ---------------- 详情：重读转录按 src.turn 过滤 ----------------
// 开轮判定与扫描侧同一份（role=user 且正文非空），天然对齐，不会出现「扫到这一轮、详情找不到」。
export function openclawEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + (st.off || 0) : null;
  let lines;
  try { lines = fs.readFileSync(src.file, 'utf8').split('\n'); } catch { return null; }
  let turnIdx = -1;
  const out = {
    user: '', assistant: '', tools: [], calls: [], v: version,
    callsNote: 'openclaw 转录（sessions/<id>.jsonl）是追加式会话树：token/模型在 assistant 消息行内 ' +
      '（usage.input **不含** cache —— totalTokens = input+output+cacheRead+cacheWrite，故 tin = input 直接取、' +
      'tcache = cacheRead+cacheWrite），轮耗时 = 下一轮 time − 本轮 time；' +
      'context 窗口容量取同 agent 的 agent/models.json 里该模型的 contextWindow（取不到则只显示占用）。' +
      '转录不落逐次调用耗时，故 calls[].dur 恒为 0。',
  };
  const texts = [];
  const callArgs = {};
  let errMsg = '';
  let stopped = '';
  let markerCount = 0;
  const markerTypes = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session') continue;
    if (j.type === 'custom' || j.type === 'custom_message' || j.type === 'compaction' || j.type === 'branch_summary') {
      if (turnIdx === src.turn) {
        markerCount++;
        const ct = typeof j.customType === 'string' && j.customType ? j.customType : j.type;
        if (!markerTypes.includes(ct)) markerTypes.push(ct);
      }
      continue;
    }
    if (j.type !== 'message') continue;   // session_info / model_change / label / leaf / thinking_level_change 不进正文
    const msg = j.message || {};
    if (msg.role === 'user') {
      const text = openclawUserText(msg.content);
      if (!text) continue;   // 与扫描侧同判据（同一个函数），否则轮序号错开
      turnIdx++;
      if (turnIdx === src.turn) out.user = text;
      continue;
    }
    if (turnIdx !== src.turn) continue;
    if (msg.role === 'assistant') {
      // 正文 = text + thinking 一起拼（页面 md 渲染，与 minimax 同款）
      const text = contentText(msg.content, /*dropThinking*/false);
      if (text) texts.push(text);
      const u = msg.usage;
      const call = {
        model: msg.model || '',
        tin: u ? num(u.input) : 0,
        tout: u ? num(u.output) : 0,
        tcache: u ? num(u.cacheRead) + num(u.cacheWrite) : 0,
        dur: 0,
      };
      if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
      const tcs = Array.isArray(msg.content) ? msg.content.filter(p => p && p.type === 'toolCall') : [];
      if (tcs.length) call.tools = tcs.map(t => (typeof t.name === 'string' && t.name) || '?');
      for (const tc of tcs) {
        const nm = (typeof tc.name === 'string' && tc.name) || '?';
        const fi = {};
        const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
        out.tools.push({
          name: nm, tid: tc.id || null, error: null,
          input: trunc(args, full, fi), inputTrunc: !!fi.t, output: '', outputTrunc: false,
        });
        if (tc.id) callArgs[tc.id] = true;
      }
      if (msg.stopReason === 'error' && !errMsg) errMsg = msg.errorMessage || (msg.errorCode ? 'errorCode=' + msg.errorCode : '');
      if (msg.stopReason) stopped = msg.stopReason;
      out.calls.push(call);
    } else if (msg.role === 'toolResult') {
      // toolResult 自带 toolCallId / toolName，按 id 回填上一条 assistant 的 toolCall（同 doubao）
      const tcid = msg.toolCallId || '';
      const t = out.tools.find(x => x.tid === tcid);
      if (!t) continue;
      const fo = {};
      t.output = trunc(toText(msg.content), full, fo);
      t.outputTrunc = !!fo.t;
      if (msg.isError) t.error = 'error';
    }
    if (turnIdx > src.turn) break;
  }
  out.assistant = texts.join('\n\n---\n\n');
  if (errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + errMsg;
  else if (stopped === 'aborted') out.callsNote += ' 本轮被中断（stopReason=aborted）。';
  else if (stopped === 'length') out.callsNote += ' 本轮因达到输出上限被截断（stopReason=length）。';
  if (markerCount) {
    out.callsNote += ' 本轮含 ' + markerCount + ' 条注入/压缩标记（' + markerTypes.join(', ') +
      '：context.compiled 快照、bootstrap 上下文、compaction 等，由运行时自动插入，不进正文）。';
  }
  return out;
}

// sniffBase 的分支与 candidateBases 见 discovery.mjs；这里只负责解析。
//
// 本版**不读** <sessionId>.trajectory.jsonl：它是同一批事件的另一份视图（session.started / trace.metadata /
// context.compiled / prompt.submitted / model.completed / trace.artifacts / session.ended / model.fallback_step），
// 其中的用量是 `promptCache.lastCallUsage`（**整轮最后一次调用**的聚合），而主源的 usage 在每条 assistant
// 消息上、逐次都在 —— 主源粒度更细，且 messagesSnapshot 会把整轮消息再复制一遍（按它计数会翻倍）。
// 轨迹里有、主源没有的只有 harness 元信息（版本 / 工具数 / invocation / finalStatus），解析器不消费，故不读。
