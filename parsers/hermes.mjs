// ---------------- hermes 型解析器（Hermes Agent：%LOCALAPPDATA%\hermes\state.db 或 ~/.hermes/state.db） ----------------
// 数据源是**一个明文 SQLite 库**（WAL 模式，schema v30 实测）：
//   sessions(id, source, model, title, parent_session_id, started_at/ended_at, end_reason,
//            message_count, tool_call_count, api_call_count, input/output/cache_read/cache_write/reasoning_tokens,
//            cwd, model_config(JSON), billing_provider, archived, hidden, …)
//   messages(id, session_id, role, content, tool_calls(JSON 串), tool_call_id, tool_name,
//            timestamp(REAL epoch), finish_reason, active, compacted, _compressed_summary, …)
//   system_prompts / session_model_usage / messages_fts 等辅助表不进正文解析
//   （session_model_usage **按 task 分行**，含 title_generation 这种辅助调用；sessions 行级聚合只等于
//    task='' 的主体，所以逐会话 token 直接读 sessions 行即可，碰 usage 表反而会把标题调用混进来）。
//
// 轮口径（与 doubao/OpenAI 同族同构，2026-09-21 本机真库核验）：
//   user 行开轮 → assistant 行累加（content='' 且 tool_calls 非空 = 中间调用；finish_reason='stop' = 收轮）
//   → role='tool' 行按 tool_call_id 回填上一条 call 的出入参 → 下一条 user 收轮。
//   ⚠️ 只取 active=1 且 _compressed_summary=0 的行：compaction 会旧行置 active=0，
//   摘要行伪装成 user 注入，都混进轮里就是幽灵轮次（doubao 字节偏移前案同类）。
//   空 user 不开轮（判据只在 scan 一处写，详情读同一份内存数据，天然对齐）。
//
// **逐轮 token / 逐次调用在 DB 里没有**（messages.token_count 恒 NULL，sessions 只有会话级累计）——
// 唯一来源是同目录 logs/agent.log 的逐次行：
//   "… INFO [会话id] agent.conversation_loop: API call #1: model=X provider=Y in=23662 out=11
//    total=23673 latency=3.4s cache=256/23662 (1%) id=gen-… upstream=Reka"
//   in **含** cache（=DB 的 input+cache_read），所以 tin=in-cache、tcache=cache，上下文占用=in（逐轮取最后一次）。
//   #N 序号跨轮累加、title_generation 不打这行，所以按「时间戳落在轮窗口内」归属，不看序号。
//   upstream= 是网关后面的真实模型（sessions.model 只是预设名，如 nous/welcome）。
// 日志缺失/滚掉时退化为「调用数=assistant 行数、token 只有会话聚合可摊到最后一轮」——不编造逐轮值。
// 失败轮（真库实测）：assistant 行内容是合成的 "Your request was not processed…"、finish_reason=NULL，
// DB 里没有任何失败标记；错误原文只出现在 agent.log 的 "API call failed" 行 → 按轮窗口带出 errMsg。
//
// 只读纪律（与 opencode 同款）：DatabaseSync {readOnly:true}；签名 = state.db + -wal + agent.log 的
// mtime/size，变了整库重读，没变跳过。不进 OFF_KINDS / PARSER_REV。
import fs from 'node:fs';
import path from 'node:path';
import {
  entries, srcs, removedIds, sorted, addEntry, files,
  toolNameCounts, modelName, toText, trunc, sqliteMod,
} from './shared.mjs';

export const hermesScanErr = new Map();

function safeJson(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------- agent.log 逐次调用行 ----------------
// 行头 "YYYY-MM-DD HH:MM:SS,mmm"（本机时区）+ [会话id] 标签；日志会滚，读不到的轮退回 DB 口径。
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})\b/;
const LOG_SID_RE = /\[(\d{8}_\d{6}_[0-9a-fA-F]{4,})\]\s+agent\.conversation_loop:\s+(.*)$/;
function logEpochMs(head) {
  const m = LOG_TS_RE.exec(head);
  if (!m) return 0;
  // 返回 **毫秒**：全站条目时间口径是 epoch ms（页面按毫秒区间筛，喂秒会被 from/to 直接滤空）
  const t = new Date(`${m[1]}T${m[2]}.${m[3]}`).getTime();
  return Number.isFinite(t) ? t : 0;
}
// 返回 sid -> 按时间排序的 {t, in, out, cache, lat, model, provider, upstream, err?}
export function parseHermesAgentLog(fp) {
  const bySid = new Map();
  let text = '';
  try { text = fs.readFileSync(fp, 'utf8'); } catch { return bySid; }
  // 必须按 \r?\n 切：真库 agent.log 是 CRLF，而 JS 的 `.` 不认 \r、`$` 也不认行尾的 \r，
  // 留着 \r 时 LOG_SID_RE 的 `(.*)$` 整档恒不命中（fixture 用 LF 建所以测不出来——真库实测踩的）
  for (const line of text.split(/\r?\n/)) {
    const sm = LOG_SID_RE.exec(line);
    if (!sm) continue;
    const [, sid, msg] = sm;
    const t = logEpochMs(line);
    if (!t) continue;
    let item = null;
    if (msg.startsWith('API call #')) {
      const g = (re) => { const m2 = re.exec(msg); return m2 ? m2[1] : null; };
      const cm = /cache=(\d+)\/(\d+)/.exec(msg);
      item = {
        t, kind: 'call',
        model: g(/model=(\S+)/) || '', provider: g(/provider=(\S+)/) || '',
        in: num(g(/in=(\d+)/)), out: num(g(/out=(\d+)/)),
        cache: cm ? num(cm[1]) : 0,
        lat: num(g(/latency=([\d.]+)s/)),
        upstream: g(/upstream=(\S+)/) || '',
      };
    } else if (msg.startsWith('API call failed')) {
      // 只留收尾那条（"...after N retries. 原文 | provider=..."），attempt 那种中间重试行不重复记
      if (!msg.includes('retries')) continue;
      const m3 = /^API call failed after \d+ retries\.\s*([^|]*?)\s*(?:\|.*)?$/.exec(msg);
      item = { t, kind: 'fail', err: (m3 && m3[1]) || 'API call failed' };
    } else continue;
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push(item);
  }
  for (const arr of bySid.values()) arr.sort((a, b) => a.t - b.t);
  return bySid;
}

// 把 [lo,hi] 窗口内的日志调用分给这一轮：calls 与 assistant 行按时间序一对一配对，
// 落不进任何轮窗口的（会话级杂项）忽略；配不到日志行的调用只留结构、不编 token。
function sliceLogCalls(all, lo, hi) {
  const out = [];
  for (const x of all) if (x.t >= lo && x.t <= hi) out.push(x);
  return out;
}

function makeTurn(s, ts) {
  return {
    sid: s.id, time: ts || 0, lastTs: ts || 0, endTs: 0,
    model: s.model || '',
    project: s.cwd || '(未知项目)', session: s.id,
    name: (s.parent_session_id ? '⤷ ' : '') + String(s.title || '').trim(),
    // I16 子 agent 拓扑：`sessions.parent_session_id` 是源头给的显式外键（本机 fixture 实测
    // 子会话 B 的 parent = 主会话 A）。以前只用它给标题加「⤷ 」前缀，父子关系没往条目上落。
    parentId: s.parent_session_id || null,
    user: '', texts: [], tools: [], byTool: new Map(),
    callList: [], models: [], events: [], others: [],
    tin: 0, tout: 0, tcache: 0, ctxUsed: 0,
    err: false, errMsg: '', finished: false,
  };
}

function addCallFromRow(t, row, logCall, sessionModel) {
  const ts = num(row.timestamp);
  const calls = safeJson(row.tool_calls);
  const names = Array.isArray(calls) ? calls.map(c => modelName(c?.function?.name) || '?') : [];
  const call = {
    model: logCall?.model ? modelName(logCall.model) : modelName(sessionModel || '') || '(未知模型)',
    provider: logCall?.provider || '',
    tin: logCall ? Math.max(0, logCall.in - logCall.cache) : 0,
    tout: logCall ? logCall.out : 0,
    tcache: logCall ? logCall.cache : 0,
    dur: logCall ? Math.round(logCall.lat * 1000) : 0,
    ttft: 0,   // 源头只有整次 latency，没有首 token 分段 → 不画 ttft（同 dsh 失败调用占位约定）
    finishReason: row.finish_reason && row.finish_reason !== 'stop' ? String(row.finish_reason) : undefined,
  };
  if (logCall?.upstream) call.upstream = modelName(logCall.upstream);
  const txt = toText(row.content).trim();
  if (txt) call.text = txt;
  if (names.length) call.tools = names;
  t.callList.push(call);
  const mdl = call.model && call.model !== '(未知模型)' ? call.model : modelName(sessionModel || '');
  if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
  if (logCall) {
    t.tin += call.tin; t.tout += call.tout; t.tcache += call.tcache;
    if (logCall.in > 0) t.ctxUsed = logCall.in;   // 逐轮上下文 = 轮内最后一次调用的 prompt 全量（含缓存）
  }
  t.events.push({
    k: 'llm', t: ts, dur: call.dur, model: call.model, upstream: logCall?.upstream || '',
    tin: call.tin, tout: call.tout, tcache: call.tcache,
    err: false, blocks: names.length ? ['tool_calls'] : (txt ? ['text'] : []),
    finish: row.finish_reason || '',
  });
  return call;
}

function turnFromMessages(s, rows, logBySid) {
  const turns = [];
  let cur = null;
  for (const row of rows) {
    // DB 的 timestamp 是 REAL **秒** → 统一乘 1000 进毫秒口径（条目/事件/耗时全站都是毫秒）
    const ts = Math.round(num(row.timestamp) * 1000);
    if (row.role === 'user') {
      const text = toText(row.content).trim();
      if (!text) continue;                       // 空 user 不开轮（与详情共用这一份判据）
      cur = makeTurn(s, ts);
      cur.key = String(row.id);                   // 稳定键：轮里首条用户消息的行号
      cur.user = text.slice(0, 3000);
      cur.events.push({ k: 'user', t: ts });
      turns.push(cur);
      continue;
    }
    if (!cur) continue;                          // 首条 user 之前的杂项（系统注入等）不进轮
    if (row.role === 'assistant') {
      cur.lastTs = Math.max(cur.lastTs, ts);
      const txt = toText(row.content).trim();
      if (txt) cur.texts.push(txt);
      const calls = safeJson(row.tool_calls);
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const fn = c && typeof c === 'object' ? (c.function || {}) : {};
          const tool = {
            name: String(fn.name || '?'),
            tid: String(c.id || c.call_id || ''),
            ct: ts,
            input: typeof fn.arguments === 'string' ? fn.arguments : toText(fn.arguments ?? c?.args ?? ''),
            output: '', error: null, dur: 0,
          };
          if (tool.tid) cur.byTool.set(tool.tid, tool);
          cur.tools.push(tool);
        }
      }
      cur._pendingRows = cur._pendingRows || [];
      cur._pendingRows.push({ row, ts });
      continue;
    }
    if (row.role === 'tool') {
      const tcid = String(row.tool_call_id || '');
      const tool = tcid ? cur.byTool.get(tcid) : null;
      const out = toText(row.content);
      const j = safeJson(row.content);
      const failed = !!(j && (j.error || j.is_error));
      if (tool) {
        tool.output = out;
        tool.dur = Math.max(0, ts - (tool.ct || ts));
        if (failed) tool.error = 'error';
      } else {
        cur.tools.push({
          name: String(row.tool_name || '?'), tid: String(row.tool_call_id || ''),
          ct: ts, input: '', output: out, error: failed ? 'error' : null, dur: 0,
        });
      }
      cur.lastTs = Math.max(cur.lastTs, ts);
      continue;
    }
  }
  // 逐次调用与日志行配对：先按 assistant 行序排，把窗口内的 log call 依次对上；
  // 对不上的日志行（如没落行的失败重试）只贡献 errMsg / 聚合，不冒充一次「已结算调用」。
  const logAll = logBySid.get(s.id) || [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    // 窗口互不重叠（上界让开下一轮的下界 start−1s），一次日志调用只计进一轮 ——
    // 1s 是抵日志秒级取整与 DB 毫秒时间戳的错位；宁可「回复后 2s 内又发消息」少计一次，
    // 也不能双计（token 虚增更难查）。最后一轮没有下家，尾巴放宽 10s
    const start = t.time;
    const end = i + 1 < turns.length ? turns[i + 1].time - 2000 : t.lastTs + 10000;
    const inWin = sliceLogCalls(logAll, start - 1000, end);
    const winCalls = inWin.filter(x => x.kind === 'call');
    const rows2 = t._pendingRows || [];
    for (let r = 0; r < rows2.length; r++) addCallFromRow(t, rows2[r].row, winCalls[r] || null, t.model);
    const fail = inWin.find(x => x.kind === 'fail');
    const last = rows2[rows2.length - 1];
    const stopSeen = rows2.some(x => x.row.finish_reason === 'stop');
    t.finished = stopSeen || i + 1 < turns.length || num(s.ended_at) > 0;
    if (!stopSeen && last && t.finished) {
      // 收轮的 assistant 行没有 finish_reason = 失败轮（真库实测：合成分儿 + NULL），错误原文只来自日志
      t.err = true;
      if (fail) t.errMsg = fail.err;
    }
    delete t._pendingRows;
    t.events.push({ k: 'end', t: t.endTs || t.lastTs || t.time, reason: t.err ? 'error' : 'completed' });
  }
  // call/result 事件（i 与 tools[] 同下标，页面直接复用 tools[i] 的出入参）
  for (const t of turns) {
    for (const [i, tool] of t.tools.entries()) {
      t.events.push({ k: 'call', t: tool.ct || t.time, name: tool.name, tid: tool.tid || undefined, i });
      t.events.push({ k: 'result', t: (tool.ct || t.time) + (tool.dur || 0), tid: tool.tid || undefined, i, dur: tool.dur || 0, error: !!tool.error });
      if (tool.error) { t.err = true; if (!t.errMsg) t.errMsg = tool.error; }
    }
    t.events.sort((a, b) => (a.t || 0) - (b.t || 0));
    t.preview = (t.user || t.texts.join('\n\n---\n\n') || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
  }
  return turns;
}

function dbSignature(dbPath) {
  let dbSt, walSt = null, logSt = null;
  try { dbSt = fs.statSync(dbPath); } catch { return null; }
  try { walSt = fs.statSync(dbPath + '-wal'); } catch {}
  try { logSt = fs.statSync(hermesLogPath(dbPath)); } catch {}
  return {
    m: dbSt.mtimeMs, s: dbSt.size,
    sig: [
      dbSt.mtimeMs + '|' + dbSt.size,
      walSt ? walSt.mtimeMs + '|' + walSt.size : '-',
      logSt ? logSt.mtimeMs + '|' + logSt.size : '-',
    ].join('#'),
  };
}
export function hermesLogPath(dbPath) {
  return path.join(path.dirname(dbPath), 'logs', 'agent.log');
}

export function hermesIdBase(dbPath) { return 'hs#' + dbPath.replace(/[\\/:]/g, '~') + '#'; }

function emit(agent, dbPath, data, prevData) {
  const base = hermesIdBase(dbPath);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = base + t.sid.replace(/#/g, '~') + '#' + t.key;
    ids.add(id);
    addEntry(id, {
      agent,
      project: t.project,
      session: t.session,
      time: t.time,
      dur: Math.max(0, (t.endTs || t.lastTs || t.time) - t.time),
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: 0,
      ctxUsed: t.ctxUsed || null,
      rounds: t.callList.length,
      calls: t.callList.length,
      tools: t.tools.length,
      models: t.models,
      preview: t.preview,
      name: t.name || null,
      // I16：子会话谱系（parent_session_id → 父会话 id）。源头显式外键，直接透传。
      parent: t.parentId || undefined, depth: t.parentId ? 1 : undefined,
      finished: !!t.finished,
      aborted: false,
      toolNames: toolNameCounts(t.tools),
    }, { file: dbPath, turn: i, kind: 'hermes' });
  });
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

export function scanHermes(agent, dbPath) {
  const stat = dbSignature(dbPath);
  if (!stat) { hermesScanErr.set(agent, '数据库不存在：' + dbPath); return; }
  const prev = files.get(dbPath);
  if (prev && prev.data?.sig === stat.sig) {
    const last = prev.data.turns?.[prev.data.turns.length - 1];
    if (last && !entries.has(hermesIdBase(dbPath) + last.sid.replace(/#/g, '~') + '#' + last.key))
      emit(agent, dbPath, prev.data, null);
    return;
  }
  const mod = sqliteMod();
  if (!mod) { hermesScanErr.set(agent, '当前 Node 没有 node:sqlite（需要 22.5+）'); return; }
  let db = null;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    const sessions = db.prepare(
      'SELECT id, model, title, parent_session_id, started_at, ended_at, message_count, cwd, model_config FROM sessions ORDER BY started_at, id'
    ).all();
    // active=1：compaction 掉的旧行被置 0；_compressed_summary=1：伪装成 user 的摘要注入行，都不算正文
    const msgs = db.prepare(
      "SELECT id, session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp, finish_reason FROM messages WHERE active = 1 AND COALESCE(_compressed_summary,0) = 0 AND role IN ('user','assistant','tool') ORDER BY session_id, id"
    ).all();
    const logBySid = parseHermesAgentLog(hermesLogPath(dbPath));
    const bySession = new Map();
    for (const m of msgs) {
      if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
      bySession.get(m.session_id).push(m);
    }
    const turns = [];
    for (const s of sessions) {
      const rows = bySession.get(s.id);
      if (!rows || !rows.length) continue;
      for (const t of turnFromMessages(s, rows, logBySid)) turns.push(t);
      // 日志滚掉时的兜底：会话级 _usage_anchor（model_config 里，代表最后一次调用）只摊给最后一轮，
      // 其余轮保持 0 —— 宁可缺，不给每轮摊一个假数字
      const tail = turns.filter(t => t.sid === s.id).pop();
      if (tail && !tail.ctxUsed) {
        const anchor = safeJson(s.model_config)?._usage_anchor;
        if (anchor && num(anchor.prompt_tokens)) tail.ctxUsed = num(anchor.prompt_tokens);
      }
    }
    const data = { sig: stat.sig, turns, rev: (prev?.data?.rev || 0) + 1 };
    files.set(dbPath, { agent, kind: 'hermes', m: stat.m, s: stat.s, off: 0, data });
    hermesScanErr.delete(agent);
    emit(agent, dbPath, data, prev?.data);
  } catch (e) {
    console.error('[hermes]', e.message);
    hermesScanErr.set(agent, e.message);
  } finally {
    try { db?.close(); } catch {}
  }
}

export function hermesEntryContent(src, full) {
  const st = files.get(src.file);
  const t = st?.data?.turns?.[src.turn];
  if (!t) return null;
  const tools = t.tools.map(x => {
    const fi = {}, fo = {};
    return {
      name: x.name, tid: x.tid, error: x.error, dur: x.dur || 0,
      input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
      output: trunc(x.output, full, fo), outputTrunc: !!fo.t,
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
    assistant: t.texts.join('\n\n---\n\n'),
    tools, calls,
    events: t.events || [],
    others: (t.others || []).map(o => ({ type: o.type, t: o.t, json: full ? o.json : o.json.slice(0, 800) })),
    v: 'h' + (st.data.rev || 0),
  };
  if (t.err) out.callsNote = '这一轮没有成功拿到模型回复' + (t.errMsg ? '：' + t.errMsg : '（agent.log 里可见报错原文）');
  return out;
}

// 判据在 discovery.mjs（hermesDbVerify：sqlite 页头 + sessions/messages/session_model_usage 三张独有表），
// 与 opencode/zcode 同一处摆放 —— 嗅探每 3s 走一轮，读盘量在那里控制。
