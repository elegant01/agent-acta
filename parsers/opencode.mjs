// ---------------- OpenCode SQLite 解析器（同时是两个 fork 的共享实现） ----------------
// 数据源：~/.local/share/opencode/opencode.db（明文 SQLite，WAL 模式）
//
// OpenCode 与 zcode 一样是 SQLite 文件型源头，但 schema/口径不同：
//   session(id, project_id, parent_id, directory, path, title, agent, model, time_created/updated)
//   message(id, session_id, time_created/updated, data JSON)
//   part(id, message_id, session_id, time_created/updated, data JSON)
//   event/event_sequence 是同一份状态的事件投影，不作为第二条数据源重复解析。
//
// ⚠️ 本文件是 **opencode 家族**的共享实现：KiloCode（Kilo CLI）是 opencode 的 fork，schema 与
// 口径实测完全同构（session/message/part 三表 + 同一套 message.data.tokens 语义），差的只是
// 库路径、日志文件名和几张自家扩展表。所以核心逻辑只写一份，由 `FAMILY` 描述符区分来源——
//   kind / idPrefix（条目 id 前缀，两家必须错开，否则同一 db 路径会互相顶掉 entries）/
//   tag（错误日志前缀）/ errMap（各家的「最近一次读取失败」映射）/ verPrefix（详情版本号前缀）。
// 入口：scanOpencode + opencodeEntryContent（opencode 本体）；parsers/kilo.mjs 薄壳拿同一份核心。
// ⚠️ 复用的前提是**口径真的相同**：接新 fork 前先核对 token 求和关系（每条 message 的 tokens 是
// 该次调用的用量，逐条相加 == session.tokens_* 聚合），不同就另写解析器，别硬套。
//
// 只读纪律：DatabaseSync 一律 {readOnly:true}，签名包含 db + -wal 的 mtime/size；
// 签名变化时整库重读，库没变时跳过。本家族不进入 OFF_KINDS（活源，按字节续读不可靠），
// 但 PARSER_REV 仍登记（只管 ~/.agent-acta/search/ 那份全文索引分片的作废）。
import fs from 'node:fs';
import {
  files, entries, srcs, removedIds, sorted, addEntry,
  toolNameCounts, modelName, toText, trunc, sqliteMod,
} from './shared.mjs';

export const opencodeScanErr = new Map();

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function textOf(v) {
  return toText(v).trim();
}

function messageData(raw) {
  const d = safeJson(raw);
  return d && typeof d === 'object' ? d : {};
}

function partTime(d, row, fallback) {
  return num(d?.time?.start) || num(d?.time?.created) || num(row?.time_created) || fallback || 0;
}

function partEndTime(d, row, start) {
  return num(d?.time?.end) || num(d?.time?.completed) || num(row?.time_updated) || start || 0;
}

function tokenFields(tokens) {
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
  return {
    tin: num(t.input),
    tout: num(t.output) + num(t.reasoning),
    tcache: num(cache.read) + num(cache.write),
    rawInput: num(t.input),
    rawOutput: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

function statusFromMessage(d) {
  const finish = String(d?.finish || '').toLowerCase();
  const err = d?.error;
  const aborted = ['abort', 'aborted', 'cancel', 'canceled', 'cancelled'].some(x => finish.includes(x));
  const failed = !!err || ['error', 'failed', 'failure'].some(x => finish.includes(x));
  return { failed, aborted, finish };
}

function errorText(d) {
  return textOf(d?.error?.data?.message || d?.error?.message || d?.error?.name || d?.error || '');
}

function turnFor(turns, byKey, sid, key, ts, session) {
  const k = sid + '\u0000' + key;
  let t = byKey.get(k);
  if (!t) {
    const title = String(session?.title || '').trim();
    t = {
      sid,
      key,
      time: ts || 0,
      lastTs: ts || 0,
      endTs: 0,
      project: session?.directory || session?.path || '(未知项目)',
      name: (session?.parent_id ? '⤷ ' : '') + (title || ''),
      parentId: session?.parent_id || null,
      user: '',
      texts: [],
      tools: [],
      byTool: new Map(),
      callList: [],
      models: [],
      events: [],
      others: [],
      tin: 0,
      tout: 0,
      tcache: 0,
      ctxUsed: 0,
      err: false,
      errMsg: '',
      aborted: false,
      finished: false,
    };
    byKey.set(k, t);
    turns.push(t);
  }
  if (ts) {
    t.time = t.time ? Math.min(t.time, ts) : ts;
    t.lastTs = Math.max(t.lastTs, ts);
  }
  return t;
}

function addOther(t, type, when, value) {
  let json;
  try { json = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { json = '[无法序列化的值]'; }
  t.others.push({ type, t: when || t.time, json: String(json || '').slice(0, 2000) });
}

function addTool(t, d, row, fallbackTs) {
  const state = d.state && typeof d.state === 'object' ? d.state : {};
  // 工具的真实起止在 state.time（实测工具 part 顶层没有 time），消息行时间只是兜底
  const st = state.time && typeof state.time === 'object' ? state.time : {};
  const tid = d.callID || d.callId || d.toolCallID || null;
  const start = num(st.start) || partTime(d, row, fallbackTs);
  const end = num(st.end) || partEndTime(d, row, start);
  const status = String(state.status || d.status || '').toLowerCase();
  const error = status && !['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)
    ? textOf(state.error || state.message || status)
    : null;
  let tool = tid ? t.byTool.get(String(tid)) : null;
  if (!tool) {
    tool = {
      name: String(d.tool || d.name || '?'),
      tid: tid ? String(tid) : null,
      pid: row?.id || null,   // 来源 part：没有 callID 的工具靠它避免被重复登记一次
      ct: start,
      input: state.input ?? d.input ?? '',
      output: state.output ?? state.result ?? d.output ?? '',
      error,
      dur: start && end ? Math.max(0, end - start) : 0,
    };
    t.tools.push(tool);
    if (tool.tid) t.byTool.set(tool.tid, tool);
  } else {
    if (state.input != null) tool.input = state.input;
    if (state.output != null) tool.output = state.output;
    if (error) tool.error = error;
    if (start) tool.ct = Math.min(tool.ct || start, start);
    if (start && end) tool.dur = Math.max(tool.dur || 0, end - start);
  }
  return tool;
}

function addAssistantCall(t, msg, d, parts) {
  const created = num(d?.time?.created) || num(msg.time_created) || t.time;
  const completed = num(d?.time?.completed) || num(msg.time_updated) || created;
  const token = tokenFields(d?.tokens);
  const status = statusFromMessage(d);
  const mdl = modelName(d?.modelID || d?.model?.modelID || d?.model || '');
  const textParts = [];
  let firstOutput = 0;
  for (const p of parts) {
    const pd = p.data;
    if (!pd) continue;
    // 首 token 时刻取本调用**最早一段内容**（reasoning 或 text）的起点：
    // 只认 text 的话，先思考后回答的那种调用 ttft 会被算成接近 dur，看着像「没有排队时间」
    if (pd.type === 'text' || pd.type === 'reasoning') {
      const pt = partTime(pd, p, created);
      if (pt && pt >= created && (!firstOutput || pt < firstOutput)) firstOutput = pt;
    }
    if (pd.type === 'text') {
      const s = textOf(pd.text);
      if (s) textParts.push(s);
    }
  }
  const firstToken = firstOutput && firstOutput >= created ? firstOutput : 0;
  const call = {
    model: mdl || '(未知模型)',
    provider: modelName(d?.providerID || ''),
    tin: token.tin,
    tout: token.tout,
    tcache: token.tcache,
    dur: completed >= created ? completed - created : 0,
    ttft: firstToken ? Math.max(0, firstToken - created) : 0,
    finishReason: d?.finish && d.finish !== 'stop' ? String(d.finish) : undefined,
  };
  if (textParts.length) call.text = textParts.join('\n');
  if (status.failed) call.error = errorText(d) || status.finish || 'error';
  const names = [];
  for (const p of parts) {
    if (p.data?.type !== 'tool') continue;
    // 工具已经在 parsePart 里登记过（可能没有 callID，所以不能靠 tid 找）：按来源 part 认领，不重复登记
    const tid = p.data.callID || p.data.callId || p.data.toolCallID || null;
    const tool = t.tools.find(x => x.pid === p.row.id) || (tid ? t.byTool.get(String(tid)) : null);
    if (tool?.name) names.push(tool.name);
  }
  if (names.length) call.tools = names;
  t.callList.push(call);
  if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
  t.tin += token.tin;
  t.tout += token.tout;
  t.tcache += token.tcache;
  const ctx = token.tin + token.tcache;
  if (ctx > 0) t.ctxUsed = ctx;
  if (created) t.time = t.time ? Math.min(t.time, created) : created;
  t.lastTs = Math.max(t.lastTs, completed, created);
  t.endTs = Math.max(t.endTs, completed);
  if (status.failed) {
    t.err = true;
    if (!t.errMsg) t.errMsg = errorText(d) || call.error || '';
  }
  if (status.aborted) t.aborted = true;
  if (completed || d?.finish) t.finished = true;
  t.events.push({
    k: 'llm', t: created, ttft: call.ttft, dur: firstToken && completed >= firstToken ? completed - firstToken : call.dur,
    model: mdl || '', tin: call.tin, tout: call.tout, tcache: call.tcache,
    err: !!status.failed, blocks: call.text ? ['text'] : [], finish: d?.finish || '',
  });
}

function parsePart(t, msg, p, role) {
  const d = safeJson(p.data);
  const when = num(p.time_created) || num(msg.time_created) || t.time;
  if (!d) { addOther(t, '(损坏的 JSON)', when, String(p.data || '')); return; }
  const type = typeof d.type === 'string' ? d.type : '(无 type)';
  if (type === 'text') {
    const s = textOf(d.text);
    if (!s) return;
    if (role === 'user') { if (!t.user) t.user = s; }
    else if (role === 'assistant') t.texts.push(s);
    else addOther(t, role + ' 文本', when, s);
    return;
  }
  if (type === 'tool') {
    addTool(t, d, p, when);
    return;
  }
  if (type === 'step-start') {
    t.events.push({ k: 'step', t: when, ph: 'start' });
    return;
  }
  if (type === 'step-finish') {
    addOther(t, type, when, { reason: d.reason, tokens: d.tokens || null, cost: d.cost });
    return;
  }
  if (type === 'reasoning') {
    // 推理正文不混入 assistant 输出，但保留在详情 others 中，便于完整查看。
    addOther(t, type, when, { text: textOf(d.text), len: textOf(d.text).length });
    return;
  }
  addOther(t, type, when, d);
}

function finalizeTurn(t, index, count) {
  const tools = t.tools;
  for (const [i, tool] of tools.entries()) {
    const ct = tool.ct || t.time;
    t.events.push({ k: 'call', t: ct, name: tool.name, tid: tool.tid, i });
    t.events.push({ k: 'result', t: ct + (tool.dur || 0), tid: tool.tid, i, dur: tool.dur || 0, error: !!tool.error });
    // 工具失败也算这一轮出错（与 zcode 同口径）；用户主动打断仍只标 aborted，不混进 error 红
    if (tool.error) { t.err = true; if (!t.errMsg) t.errMsg = String(tool.error); }
  }
  t.events.push({ k: 'end', t: t.endTs || t.lastTs || t.time, reason: t.err ? 'error' : (t.aborted ? 'canceled' : 'completed') });
  t.events.sort((a, b) => (a.t || 0) - (b.t || 0));
  t.preview = (t.user || t.texts.join('\n\n---\n\n') || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
  t.finished = !!t.finished || index < count - 1;
  t.user = t.user.slice(0, 3000);
  t.assistant = t.texts.join('\n\n---\n\n');
}

function dbSignature(dbPath) {
  let dbSt, walSt = null;
  try { dbSt = fs.statSync(dbPath); } catch { return null; }
  try { walSt = fs.statSync(dbPath + '-wal'); } catch {}
  return {
    m: dbSt.mtimeMs,
    s: dbSt.size,
    sig: dbSt.mtimeMs + '|' + dbSt.size + '|' + (walSt ? walSt.mtimeMs + '|' + walSt.size : '-'),
  };
}

// 条目 id 前缀由各家自己给（fam.idPrefix）：同一路径的同一个库若被两家同时登记，
// 前缀相同会让后扫的那家把前一家留在 entries 里的条目按 id 顶掉（见 file 头）。
function dbIdBase(prefix, dbPath) { return prefix + dbPath.replace(/[\\/:]/g, '~') + '#'; }

function emit(agent, dbPath, data, prevData, fam) {
  const base = dbIdBase(fam.idPrefix, dbPath);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = base + t.sid.replace(/#/g, '~') + '#' + t.key;
    ids.add(id);
    addEntry(id, {
      agent,
      project: t.project,
      session: t.sid,
      time: t.time,
      dur: Math.max(0, (t.endTs || t.lastTs || t.time) - t.time),
      status: t.err ? 'error' : (t.aborted ? 'canceled' : 'ok'),
      tin: t.tin,
      tout: t.tout,
      tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: 0,
      ctxUsed: t.ctxUsed || null,
      rounds: t.callList.length,
      calls: t.callList.length,
      tools: t.tools.length,
      models: t.models,
      preview: t.preview,
      name: t.name || null,
      // I16：子会话谱系（session.parent_id → 父会话 id）。源头显式外键（kilo 是它的 fork，同一份口径）。
      parent: t.parentId || undefined, depth: t.parentId ? 1 : undefined,
      finished: !!t.finished,
      aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools),
    }, { file: dbPath, turn: i, kind: fam.kind });
  });
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

// 家族共享的扫描主体：opencode 本体与 kilo 都走这里，差异全在 fam 描述符里。
function scanOpencodeLike(agent, dbPath, fam) {
  const stat = dbSignature(dbPath);
  if (!stat) { fam.errMap.set(agent, '数据库不存在：' + dbPath); return; }
  const prev = files.get(dbPath);
  if (prev && prev.data?.sig === stat.sig) {
    const last = prev.data.turns?.[prev.data.turns.length - 1];
    if (last && !entries.has(dbIdBase(fam.idPrefix, dbPath) + last.sid.replace(/#/g, '~') + '#' + last.key)) emit(agent, dbPath, prev.data, null, fam);
    return;
  }
  const mod = sqliteMod();
  if (!mod) { fam.errMap.set(agent, '当前 Node 没有 node:sqlite（需要 22.5+）'); return; }
  let db = null;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    const qAll = (sql) => { try { return db.prepare(sql).all(); } catch { return null; } };
    const sessions = qAll('SELECT id, project_id, parent_id, directory, path, title, agent, model, time_created, time_updated FROM session ORDER BY time_created, id');
    if (!sessions) throw new Error('读不到 session 表（schema 不兼容或库被锁定）');
    const messages = qAll('SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY session_id, time_created, id') || [];
    const parts = qAll('SELECT id, message_id, session_id, time_created, time_updated, data FROM part ORDER BY session_id, time_created, id') || [];
    const sessionById = new Map(sessions.map(s => [s.id, s]));
    const partsByMsg = new Map();
    for (const row of parts) {
      const d = safeJson(row.data);
      const item = { row, data: d };
      if (!partsByMsg.has(row.message_id)) partsByMsg.set(row.message_id, []);
      partsByMsg.get(row.message_id).push(item);
    }
    const messagesBySession = new Map();
    for (const row of messages) {
      if (!messagesBySession.has(row.session_id)) messagesBySession.set(row.session_id, []);
      messagesBySession.get(row.session_id).push(row);
    }
    const turns = [];
    const byKey = new Map();
    for (const [sid, rows] of messagesBySession) {
      const session = sessionById.get(sid) || { id: sid, directory: '', path: '', title: '' };
      let current = null;
      for (const row of rows) {
        const d = messageData(row.data);
        const role = String(d.role || '');
        const ts = num(d.time?.created) || num(row.time_created);
        if (role === 'user' || !current) {
          const key = role === 'user' ? row.id : 'pre#' + row.id;
          current = turnFor(turns, byKey, sid, key, ts, session);
          if (role === 'user') current.events.push({ k: 'user', t: ts });
        }
        if (ts) current.lastTs = Math.max(current.lastTs, ts);
        if (num(d.time?.completed)) current.endTs = Math.max(current.endTs, num(d.time.completed));
        const p = partsByMsg.get(row.id) || [];
        for (const item of p) parsePart(current, { ...row, role }, item.row, role);
        if (role === 'assistant') addAssistantCall(current, row, d, p);
        const msgStatus = statusFromMessage(d);
        if (d.error && !current.errMsg) current.errMsg = errorText(d);
        if (msgStatus.failed) current.err = true;
        if (msgStatus.aborted) current.aborted = true;
        if (msgStatus.finish || num(d.time?.completed)) current.finished = true;
      }
    }
    for (let i = 0; i < turns.length; i++) finalizeTurn(turns[i], i, turns.length);
    const liveTurns = turns.filter(t => t.user || t.texts.length || t.tools.length || t.callList.length || t.errMsg || t.others.length);
    const data = { sig: stat.sig, turns: liveTurns, rev: (prev?.data?.rev || 0) + 1 };
    files.set(dbPath, { agent, kind: fam.kind, m: stat.m, s: stat.s, off: 0, data });
    fam.errMap.delete(agent);
    emit(agent, dbPath, data, prev?.data, fam);
  } catch (e) {
    console.error(fam.tag, e.message);
    fam.errMap.set(agent, e.message);
  } finally {
    try { db?.close(); } catch {}
  }
}

function familyEntryContent(src, full, fam) {
  const st = files.get(src.file);
  const t = st?.data?.turns?.[src.turn];
  if (!t) return null;
  const tools = t.tools.map(x => {
    const fi = {}, fo = {};
    return {
      name: x.name,
      tid: x.tid,
      error: x.error,
      dur: x.dur || 0,
      input: trunc(x.input, full, fi),
      inputTrunc: !!fi.t,
      output: trunc(x.output, full, fo),
      outputTrunc: !!fo.t,
    };
  });
  const calls = t.callList.map(c => {
    if (!c.text) return { ...c };
    const ft = {};
    const text = trunc(c.text, full, ft);
    return ft.t ? { ...c, text, textTrunc: true } : { ...c };
  });
  const out = {
    user: t.user,
    assistant: t.assistant,
    tools,
    calls,
    events: t.events || [],
    others: (t.others || []).map(o => ({ type: o.type, t: o.t, json: full ? o.json : o.json.slice(0, 800) })),
    v: fam.verPrefix + (st.data.rev || 0),
  };
  if (t.err && t.errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + t.errMsg;
  return out;
}

// ---- 家族描述符与对外入口 ----
// opencode 本体的对外接口（server 在用）：行为与重构前逐字一致。
const OPENCODE_FAMILY = {
  kind: 'opencode',
  idPrefix: 'oc#',
  tag: '[opencode]',
  errMap: opencodeScanErr,
  verPrefix: 'oc',
};

export function scanOpencode(agent, dbPath) { return scanOpencodeLike(agent, dbPath, OPENCODE_FAMILY); }
export function opencodeEntryContent(src, full) { return familyEntryContent(src, full, OPENCODE_FAMILY); }

// 供 fork（parsers/kilo.mjs）复用同一份核心：只暴露描述符化的两个入口，不暴露内部状态。
export function opencodeFamilyApi(fam) {
  return {
    scan: (agent, dbPath) => scanOpencodeLike(agent, dbPath, fam),
    entryContent: (src, full) => familyEntryContent(src, full, fam),
  };
}
