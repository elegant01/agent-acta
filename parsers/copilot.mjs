// ---------------- GitHub Copilot CLI 解析器（~/.copilot/session-state/*/events.jsonl） ----------------
// 正文/事件来自每个 session 的 events.jsonl；逐次用量来自同根 session-store.db 的
// assistant_usage_events（SQLite WAL 也由 node:sqlite 自动读到）。
import fs from 'node:fs';
import path from 'node:path';
import {
  files, entries, srcs, removedIds, sorted, addEntry, markKind,
  toolNameCounts, modelName, toText, sqliteMod,
} from './shared.mjs';
import { copilotSessionFiles } from './discovery.mjs';

export const copilotScanErr = new Map();

// I8 复现包原始片段提取复用：copilot 的 `user.message` 行即开轮（扫描侧不跳过空/命令，这里同口径）。
export function copilotTurnStart(j) { return j.type === 'user.message'; }

function ts(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const raw = v.trim();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
      ? raw.replace(' ', 'T') + 'Z' : raw;
    const n = Date.parse(normalized);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sessionIdOf(fp) {
  return path.basename(path.dirname(fp));
}

function sourceKey(fp) { return fp; }
function idBase(fp) { return 'p#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function readWorkspace(sessionDir) {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^(cwd|name):\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return out;
}

function turnOf(turns, byKey, key, t) {
  const k = key == null || key === '' ? '0' : String(key);
  let turn = byKey.get(k);
  if (!turn) {
    turn = {
      key: k, time: t || 0, lastTs: t || 0, endTs: 0,
      user: '', texts: [], tools: [], callList: [], models: [],
      events: [], others: [], err: false, errMsg: '', finished: false, aborted: false,
    };
    byKey.set(k, turn);
    turns.push(turn);
  }
  if (t) {
    turn.time = turn.time ? Math.min(turn.time, t) : t;
    turn.lastTs = Math.max(turn.lastTs, t);
  }
  return turn;
}

function toolName(req) {
  return String(req?.name || req?.toolName || req?.tool || req?.function?.name || '?');
}

function toolInput(req) {
  return req?.arguments ?? req?.input ?? req?.parameters ?? req?.function?.arguments ?? '';
}

function addTool(turn, req, t, output = '', error = null) {
  const tid = req?.id || req?.callId || req?.call_id || req?.toolCallId || req?.tool_call_id || null;
  let tool = tid ? turn.tools.find(x => x.tid === tid) : null;
  if (!tool) {
    tool = { name: toolName(req), tid, ct: t || turn.time, input: toolInput(req), output, error, dur: 0 };
    turn.tools.push(tool);
  } else {
    if (output !== '') tool.output = output;
    if (error) tool.error = error;
  }
  return tool;
}

function readUsage(root) {
  const dbPath = path.join(path.basename(root).toLowerCase() === 'session-state' ? path.dirname(root) : root, 'session-store.db');
  let dbSt = null, walSt = null;
  try { dbSt = fs.statSync(dbPath); } catch {}
  try { walSt = fs.statSync(dbPath + '-wal'); } catch {}
  const sig = dbSt
    ? dbSt.mtimeMs + '|' + dbSt.size + '|' + (walSt ? walSt.mtimeMs + '|' + walSt.size : '-')
    : '-';
  if (!dbSt) return { byKey: new Map(), path: dbPath, sig, error: null };
  const mod = sqliteMod();
  if (!mod) return { byKey: new Map(), path: dbPath, sig, error: '当前 Node 没有 node:sqlite（需要 22.5+）' };
  let db = null;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT session_id, turn_index, agent_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms,
      time_to_first_token_ms, finish_reason, created_at
      FROM assistant_usage_events ORDER BY session_id, id`).all();
    const byKey = new Map();
    for (const r of rows) {
      const key = String(r.session_id || '') + '|' + String(r.turn_index == null ? '' : r.turn_index);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    return { byKey, path: dbPath, error: null, sig };
  } catch (e) {
    return { byKey: new Map(), path: dbPath, error: e.message, sig };
  } finally {
    try { db && db.close(); } catch {}
  }
}

function parseEvents(fp, usageByKey) {
  const raw = fs.readFileSync(fp, 'utf8');
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  const sessionId = sessionIdOf(fp);
  const sessionDir = path.dirname(fp);
  const ws = readWorkspace(sessionDir);
  const turns = [], byKey = new Map();
  let cwd = ws.cwd || '';
  let sessionName = ws.name || null;
  let sessionStart = 0;
  for (const line of complete.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const j = safeJson(line);
    if (!j) continue;
    const d = j.data || {};
    const t = ts(j.timestamp || d.timestamp || d.startTime || d.completedAt);
    if (j.type === 'session.start') {
      sessionStart = t || sessionStart;
      cwd = d.context?.cwd || cwd;
      continue;
    }
    if (j.type === 'user.message') {
      const turn = turnOf(turns, byKey, d.turnId, t);
      const text = toText(d.content);
      if (text && !turn.user) turn.user = text;
      if (t) turn.events.push({ k: 'user', t });
      continue;
    }
    if (j.type === 'assistant.message') {
      const turn = turnOf(turns, byKey, d.turnId, t);
      const text = toText(d.content);
      if (text) turn.texts.push(text);
      const mdl = modelName(d.model);
      if (mdl && !turn.models.includes(mdl)) turn.models.push(mdl);
      for (const req of Array.isArray(d.toolRequests) ? d.toolRequests : []) addTool(turn, req, t);
      if (d.phase === 'error' || d.error) {
        turn.err = true;
        turn.errMsg = turn.errMsg || toText(d.error || d.content);
      }
      if (t) turn.events.push({ k: 'llm', t, model: mdl || '', blocks: text ? ['text'] : [] });
      continue;
    }
    if (j.type === 'assistant.turn_end') {
      const turn = turnOf(turns, byKey, d.turnId, t);
      turn.finished = true;
      turn.endTs = Math.max(turn.endTs, t || 0);
      if (t) turn.lastTs = Math.max(turn.lastTs, t);
      continue;
    }
    if (j.type === 'hook.start' && d.hookType === 'agentStop') {
      const turn = turnOf(turns, byKey, d.input?.turnId, t);
      if (d.input?.stopReason && d.input.stopReason !== 'end_turn') {
        turn.aborted = true;
        turn.err = true;
        turn.errMsg = turn.errMsg || String(d.input.stopReason);
      }
      continue;
    }
    const type = String(j.type || '').toLowerCase();
    if (type.includes('tool')) {
      const payload = d.tool || d;
      const turn = turnOf(turns, byKey, d.turnId ?? payload.turnId, t);
      const isResult = type.includes('result') || type.includes('end') || type.includes('complete');
      const tool = addTool(turn, payload, t, isResult ? (payload.output ?? payload.result ?? '') : '', payload.error || (payload.isError ? 'error' : null));
      if (isResult && tool.ct && t) tool.dur = Math.max(0, t - tool.ct);
      continue;
    }
    if (j.type === 'session.end' || j.type === 'session.stop') {
      for (const turn of turns) {
        if (!turn.finished) { turn.finished = true; turn.endTs = Math.max(turn.endTs, t || 0); }
      }
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const rows = usageByKey.get(sessionId + '|' + turn.key) || [];
    for (const r of rows) {
      const mdl = modelName(r.model);
      const cache = (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
      const call = {
        model: mdl || '(未知模型)',
        tin: r.input_tokens || 0,
        tout: (r.output_tokens || 0) + (r.reasoning_tokens || 0),
        tcache: cache,
        dur: r.duration_ms || 0,
        ttft: r.time_to_first_token_ms || 0,
      };
      if (r.finish_reason && r.finish_reason !== 'stop') call.finishReason = r.finish_reason;
      turn.callList.push(call);
      if (mdl && !turn.models.includes(mdl)) turn.models.push(mdl);
      turn.tin = (turn.tin || 0) + call.tin;
      turn.tout = (turn.tout || 0) + call.tout;
      turn.tcache = (turn.tcache || 0) + call.tcache;
      if (r.created_at) {
        const ct = ts(r.created_at);
        if (ct) turn.time = turn.time ? Math.min(turn.time, ct) : ct;
      }
      if (call.dur && turn.time) turn.lastTs = Math.max(turn.lastTs, turn.time + call.dur);
      if (r.finish_reason && r.finish_reason !== 'stop') turn.err = true;
    }
    if (!turn.callList.length && turn.models.length) {
      turn.callList.push({ model: turn.models[0], tin: 0, tout: 0, tcache: 0, dur: 0 });
    }
    turn.endTs = Math.max(turn.endTs, turn.lastTs, turn.time);
    turn.preview = (turn.user || turn.texts.join('\n\n---\n\n') || turn.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
    turn.events.push({ k: 'end', t: turn.endTs, reason: turn.err ? 'error' : 'completed' });
    turn.events.sort((a, b) => (a.t || 0) - (b.t || 0));
  }
  return { sessionId, cwd, sessionName, sessionStart, turns, consumed: Buffer.byteLength(complete) };
}

function emit(agent, fp, data, prevData) {
  const base = idBase(fp);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = base + data.sessionId + '#' + t.key;
    ids.add(id);
    addEntry(id, {
      agent, project: data.cwd || '(未知项目)', session: data.sessionId,
      time: t.time || data.sessionStart || 0,
      dur: Math.max(0, (t.endTs || t.lastTs || t.time) - (t.time || data.sessionStart || 0)),
      status: t.err ? 'error' : 'ok',
      tin: t.tin || 0, tout: t.tout || 0, tcache: t.tcache || 0,
      total: (t.tin || 0) + (t.tout || 0) + (t.tcache || 0),
      ctx: 0, ctxUsed: (t.tin || 0) + (t.tcache || 0),
      rounds: t.callList.length, calls: t.callList.length, tools: t.tools.length,
      models: t.models, preview: t.preview, name: data.sessionName || null,
      finished: !!t.finished || i < data.turns.length - 1, aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools),
    }, { file: fp, turn: i, kind: 'copilot' });
  });
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

export function scanCopilotFile(agent, fp, root, usageByKey, usageSig = '-') {
  let st;
  try { st = fs.statSync(fp); } catch { return; }
  const sig = st.mtimeMs + '|' + st.size + '|u:' + usageSig;
  const prev = files.get(sourceKey(fp));
  if (prev && prev.data?.sig === sig) {
    const last = prev.data.turns?.[prev.data.turns.length - 1];
    if (last && !entries.has(idBase(fp) + prev.data.sessionId + '#' + last.key)) emit(agent, fp, prev.data, null);
    return;
  }
  try {
    const data = parseEvents(fp, usageByKey);
    data.sig = sig;
    data.rev = (prev?.data?.rev || 0) + 1;
    files.set(sourceKey(fp), { agent, kind: 'copilot', m: st.mtimeMs, s: st.size, off: data.consumed, data });
    copilotScanErr.delete(agent);
    markKind('copilot');
    emit(agent, fp, data, prev?.data);
  } catch (e) {
    console.error('[copilot]', e.message);
    copilotScanErr.set(agent, e.message);
  }
}

export function scanCopilot(agent, root) {
  const usage = readUsage(root);
  if (usage.error) copilotScanErr.set(agent, '用量库读取失败：' + usage.error);
  const list = copilotSessionFiles(root);
  const seen = new Set(list.map(x => x.fp));
  for (const x of list) {
    try { scanCopilotFile(agent, x.fp, root, usage.byKey, usage.sig); }
    catch (e) { copilotScanErr.set(agent, e.message); }
  }
  if (usage.error) copilotScanErr.set(agent, '用量库读取失败：' + usage.error);
  for (const [fp, f] of [...files]) {
    if (f.agent !== agent || f.kind !== 'copilot' || seen.has(fp)) continue;
    for (const [id, e] of [...entries]) {
      if (e.agent === agent && srcs.get(id)?.file === fp) { entries.delete(id); srcs.delete(id); removedIds.push(id); }
    }
    files.delete(fp);
  }
  sorted.cache = null;
}

export function copilotIdBase(fp) { return idBase(fp); }
