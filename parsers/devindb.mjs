// ---------------- devindb 型解析器（Devin CLI：%APPDATA%\Devin\cli\sessions.db / ~/.local/share/devin/cli/sessions.db） ----------------
// 数据源是**一个明文 SQLite 库**（WAL 模式，未加密），本机实测结构（backend_type='windsurf'）：
//   sessions(id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at,
//            title, main_chain_id, cogs_json, workspace_dirs, hidden, metadata)
//   message_nodes(row_id PK, session_id, node_id, parent_node_id, chat_message(JSON), created_at, metadata)
//   tool_call_state(session_id, tool_call_id, tool_call_json, tool_call_update_json)
//   prompt_history / rendered_commits / subagent_heads 本机全空；app_state 只有 schema_compat_version；
//   refinery_schema_history 是产品自己的迁移流水（17 条），都不进正文解析。
//
// **消息是一棵森林，不是一张表**：node_id/parent_node_id 连成树，sessions.main_chain_id 指向当前分支的
// 叶节点，沿 parent_node_id 往回走就是这一会话当前的主线。本机实测 261 个节点里只有 164 个在主线：
// 余下的全是「重新生成」留下的旁支（第一条 user 消息 #2/#9/#16 三份、#192 那份被顶掉的回复都在旁支里），
// 整表扫会把同一轮算三遍（旁支的 assistant/tool 节点与主线共享前缀）。所以**只走主线**。
//
// 轮口径：user 节点开轮 → 其后的 assistant 节点累加 → role='tool' 节点按 tool_call_id 回填上一条 call 的
// 出入参 → 下一条 user 收轮。中间穿插的 role='system' 节点（<additional_metadata> 之类）跳过；
// assistant 的 `thinking` 不是正文，进 others[]。
//   一次 assistant 节点 = **一次 LLM 调用**（与 hermes 的一行日志一次调用同构），它可能带 0..N 个
//   tool_calls（实测有 2 个的），所以 calls 数 = assistant 节点数、tools 数 = tool_calls 总数。
//   收轮判据 = assistant 的 metadata.finish_reason === 'stop'（工具轮是 'tool_calls'）。
//
// token 口径：**逐次精确值都在库里**，不需要辅助日志（assistant.metadata.metrics）：
//   input_tokens（**不含** cache）/ output_tokens / cache_read_tokens / cache_creation_tokens /
//   ttft_ms / total_time_ms / tpot_ms。逐轮聚合 = 轮内各次相加；
//   ctxUsed = 轮内最后一次调用的 input + cache_read + cache_creation。
//   上下文窗口容量源头没有 → ctx 恒 0（不编分母，与 hermes 同款纪律）。
//   （根目录那批 py 探针断言「token 大多是 null、只在服务端」是错的：它们经 copy_db.bat 只拷了
//    sessions.db、没拷 -wal，读到的是一份过期快照。）
//
// 时间：message_nodes.created_at（**列**）整库同一个值、不可用；真正的时间在 chat_message.metadata.created_at
//   （ISO-8601 纳秒，UTC），user/assistant/tool 行同款，全站统一换成毫秒 epoch。
//
// 失败判据：工具失败在本轮工具行上（chisel/tool_result_meta.success === false，实测与 tool_call_state 的
//   status='failed' 一一对应），只给那个工具打 ✗ —— 不把整轮染红（跑错一条命令在 devin 里太常见，
//   与 hermes「工具错即整轮 error」的取舍不同，这里源头有逐工具的明确标记，用不着连坐）。
//   轮级 error 只留给「这一轮一次都没结算」：后面还有新轮却没有任何一次带 metrics 的调用
//   ⇒ 没拿到模型回复；被下一条 user 顶掉但调用是结算过的 ⇒ 用户打断（aborted，页面灰显，不算失败）。
//
// 只读纪律（与 hermes/opencode 同款）：DatabaseSync {readOnly:true}；签名 = sessions.db + -wal + -shm 的
// mtime/size，变了整库重读，没变跳过。内存态、不落 index，故不进 OFF_KINDS / PARSER_REV。
import fs from 'node:fs';
import path from 'node:path';
import {
  entries, srcs, removedIds, sorted, addEntry, files,
  toolNameCounts, modelName, toText, trunc, sqliteMod,
} from './shared.mjs';

export const devinDbErr = new Map();

function safeJson(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// ISO-8601 → 毫秒 epoch。库里的纳秒精度（"…T01:58:56.086899Z"）**不能直接喂 Date.parse**：
// 规范只认到毫秒，多出来的小数位在部分运行时上直接 NaN；截到 3 位再解析，两边一致。
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?/;
function isoMs(s) {
  const m = typeof s === 'string' ? ISO_RE.exec(s) : null;
  if (!m) return 0;
  const t = Date.parse(m[1] + '.' + (m[2] || '').padEnd(3, '0').slice(0, 3) + 'Z');
  return Number.isFinite(t) ? t : 0;
}

function makeTurn(s, ts) {
  return {
    sid: s.id, time: ts || 0, lastTs: ts || 0,
    model: s.model || '',
    project: s.working_directory || '(未知项目)', session: s.id,
    name: String(s.title || '').trim(),
    user: '', texts: [], tools: [], byTool: new Map(),
    callList: [], models: [], events: [], others: [],
    tin: 0, tout: 0, tcache: 0, ctxUsed: 0,
    err: false, errMsg: '', finished: false, aborted: false,
  };
}

// 一个 assistant 节点 = 一次 LLM 调用；它的 tool_calls 全部登记成工具（可能有多个，并行调用）
function addCallFromNode(t, cm, ts) {
  const md = cm.metadata || {};
  const metrics = md.metrics || null;
  const txt = toText(cm.content).trim();
  const raw = Array.isArray(cm.tool_calls) ? cm.tool_calls : [];
  const names = [];
  for (const c of raw) {
    const fn = c && typeof c === 'object' ? c : {};
    const tool = {
      name: String(fn.name || '?'),
      tid: String(fn.id || ''),
      ct: ts,
      // arguments 在库里是**对象**（不是 JSON 串）——页面只认字符串，这里就地序列化
      input: fn.arguments == null ? '' : (typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments, null, 2)),
      output: '', error: null, dur: 0,
    };
    if (tool.tid) t.byTool.set(tool.tid, tool);
    t.tools.push(tool);
    names.push(tool.name);
  }
  // 真实模型名在每次调用的 generation_model 上（会话行的 model 是同一份预设）；两者取到哪个用哪个
  const mdl = modelName(md.generation_model) || modelName(t.model) || '';
  const call = {
    model: mdl || '(未知模型)',
    provider: '',
    tin: metrics ? num(metrics.input_tokens) : 0,
    tout: metrics ? num(metrics.output_tokens) : 0,
    tcache: metrics ? num(metrics.cache_read_tokens) : 0,
    dur: metrics ? num(metrics.total_time_ms) : 0,
    ttft: metrics ? num(metrics.ttft_ms) : 0,
    finishReason: md.finish_reason && md.finish_reason !== 'stop' ? String(md.finish_reason) : undefined,
  };
  if (txt) call.text = txt;
  if (names.length) call.tools = names;
  t.callList.push(call);
  if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
  if (metrics) {
    t.tin += call.tin; t.tout += call.tout; t.tcache += call.tcache;
    // 逐轮上下文 = 轮内最后一次**结算过**的调用的 prompt 全量（含缓存写入，口径同 claude 家族）
    const ctx = call.tin + call.tcache + num(metrics.cache_creation_tokens);
    if (ctx > 0) t.ctxUsed = ctx;
  }
  t.events.push({
    k: 'llm', t: ts, ttft: call.ttft,
    // 时间线把 llm 拆成「等待(ttft) + 解码(dur)」两段（见 sess-view）：dur 给解码段，卡片上的 c.dur 才是整次
    dur: metrics ? Math.max(0, call.dur - call.ttft) : 0,
    model: call.model, tin: call.tin, tout: call.tout, tcache: call.tcache,
    err: false, blocks: names.length ? ['tool_calls'] : (txt ? ['text'] : []),
    finish: md.finish_reason || '',
  });
  return { call, settled: !!metrics };
}

function turnFromChain(s, chain) {
  const turns = [];
  let cur = null;
  const pending = [];   // [{ts, cm}]：assistant 节点，等 tool 行回填后再结算
  for (const row of chain) {
    const cm = safeJson(row.chat_message);
    if (!cm) continue;
    const md = cm.metadata || {};
    const ts = isoMs(md.created_at);
    if (cm.role === 'user') {
      const text = toText(cm.content).trim();
      if (!text) continue;                      // 空 user 不开轮（判据只写这一处，详情读同一份内存数据）
      cur = makeTurn(s, ts);
      cur.key = String(row.node_id);            // 稳定键：轮里首条用户消息的节点号
      cur.user = text.slice(0, 3000);
      cur.events.push({ k: 'user', t: ts });
      turns.push(cur);
      continue;
    }
    if (!cur) continue;                         // 首条 user 之前的系统注入/规则载入不进轮
    if (cm.role === 'system') continue;         // 轮中间的系统注入（additional_metadata 之类）
    if (cm.role === 'assistant') {
      const thinking = cm.thinking && typeof cm.thinking.thinking === 'string' ? cm.thinking.thinking.trim() : '';
      if (thinking) cur.others.push({ type: 'thinking', t: ts, json: thinking });
      const txt = toText(cm.content).trim();
      if (txt) cur.texts.push(txt);
      const { settled } = addCallFromNode(cur, cm, ts);
      cur.lastTs = Math.max(cur.lastTs, ts);
      cur._settled = cur._settled || settled;
      if (md.finish_reason === 'stop') cur._stop = true;
      continue;
    }
    if (cm.role === 'tool') {
      const tcid = String(cm.tool_call_id || '');
      const tool = tcid ? cur.byTool.get(tcid) : null;
      const out = toText(cm.content);
      const ext = md.extensions || {};
      const meta = ext['chisel/tool_result_meta'] || null;
      const timing = ext['chisel/tool_call_timing'] || null;
      const failed = !!(meta && meta.success === false);
      if (tool) {
        tool.output = out;
        tool.dur = timing ? num(timing.duration_ms) : Math.max(0, ts - (tool.ct || ts));
        if (failed) tool.error = 'error';
      } else {
        // 找不到对应的 call（该节点被裁掉等）：不静默丢，单列一条只有返回的工具
        const orphan = {
          name: String(cm.tool_name || '?'), tid: tcid, ct: ts, input: '', output: out,
          error: failed ? 'error' : null, dur: timing ? num(timing.duration_ms) : 0,
        };
        cur.tools.push(orphan);
        if (tcid) cur.byTool.set(tcid, orphan);
      }
      cur.lastTs = Math.max(cur.lastTs, ts);
      continue;
    }
  }
  // 结算：收轮判据只看 finish_reason（与轮边界同一个来源），打断/失败在此定级
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const superseded = i + 1 < turns.length;
    t.finished = !!t._stop || superseded;
    if (!t._stop && t.finished) {
      if (t._settled) t.aborted = true;      // 结算过 ⇒ 用户打断（主动打断 ≠ 失败）
      else { t.err = true; t.errMsg = '这一轮没有成功拿到模型回复（轮内没有任何一次调用结算）'; }
    }
    delete t._stop; delete t._settled;
    t.endTs = t.lastTs;
    t.events.push({ k: 'end', t: t.lastTs || t.time, reason: t.err ? 'error' : (t.aborted ? 'aborted' : 'completed') });
  }
  // call/result 事件（i 与 tools[] 同下标，页面直接复用 tools[i] 的出入参）
  for (const t of turns) {
    for (const [i, tool] of t.tools.entries()) {
      t.events.push({ k: 'call', t: tool.ct || t.time, name: tool.name, tid: tool.tid || undefined, i });
      t.events.push({ k: 'result', t: (tool.ct || t.time) + (tool.dur || 0), tid: tool.tid || undefined, i, dur: tool.dur || 0, error: !!tool.error });
    }
    t.events.sort((a, b) => (a.t || 0) - (b.t || 0));
    t.preview = (t.user || t.texts.join('\n\n---\n\n') || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
  }
  return turns;
}

function dbSignature(dbPath) {
  let dbSt;
  try { dbSt = fs.statSync(dbPath); } catch { return null; }
  let walSt = null, shmSt = null;
  try { walSt = fs.statSync(dbPath + '-wal'); } catch {}
  try { shmSt = fs.statSync(dbPath + '-shm'); } catch {}
  return {
    m: dbSt.mtimeMs, s: dbSt.size,
    // 主库的 mtime/size 在 WAL 模式下可能长时间不动（新行只进 -wal），三个文件都要进签名
    sig: [
      dbSt.mtimeMs + '|' + dbSt.size,
      walSt ? walSt.mtimeMs + '|' + walSt.size : '-',
      shmSt ? shmSt.mtimeMs + '|' + shmSt.size : '-',
    ].join('#'),
  };
}

export function devinDbIdBase(dbPath) { return 'dv#' + dbPath.replace(/[\\/:]/g, '~') + '#'; }

function emit(agent, dbPath, data, prevData) {
  const base = devinDbIdBase(dbPath);
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
      ctx: 0,                       // 源头没有窗口容量 —— 不编分母
      ctxUsed: t.ctxUsed || null,
      rounds: t.callList.length,
      calls: t.callList.length,
      tools: t.tools.length,
      models: t.models,
      preview: t.preview,
      name: t.name || null,
      finished: !!t.finished,
      aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools),
    }, { file: dbPath, turn: i, kind: 'devindb' });
  });
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

export function scanDevinDb(agent, dbPath) {
  const stat = dbSignature(dbPath);
  if (!stat) { devinDbErr.set(agent, '数据库不存在：' + dbPath); return; }
  const prev = files.get(dbPath);
  if (prev && prev.data?.sig === stat.sig) {
    const last = prev.data.turns?.[prev.data.turns.length - 1];
    if (last && !entries.has(devinDbIdBase(dbPath) + last.sid.replace(/#/g, '~') + '#' + last.key))
      emit(agent, dbPath, prev.data, null);
    return;
  }
  const mod = sqliteMod();
  if (!mod) { devinDbErr.set(agent, '当前 Node 没有 node:sqlite（需要 22.5+）'); return; }
  let db = null;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    // main_chain_id 为空的会话（还没落过轮）不查节点
    const sessions = db.prepare(
      'SELECT id, working_directory, model, title, main_chain_id, hidden FROM sessions ORDER BY created_at, id'
    ).all();
    const nodes = db.prepare(
      'SELECT session_id, node_id, parent_node_id, chat_message FROM message_nodes ORDER BY session_id, node_id'
    ).all();
    const bySession = new Map();
    for (const n of nodes) {
      if (!bySession.has(n.session_id)) bySession.set(n.session_id, new Map());
      bySession.get(n.session_id).set(n.node_id, n);
    }
    const turns = [];
    for (const s of sessions) {
      const map = bySession.get(s.id);
      if (!map || s.main_chain_id == null) continue;
      // 从叶往根回溯再翻正 —— 旁支因此天然被排除（它们不是 main_chain_id 的祖先）
      const chain = [];
      let cur = s.main_chain_id, guard = 0;
      while (cur != null && map.has(cur) && guard++ < 100000) {
        const n = map.get(cur);
        chain.push(n);
        cur = n.parent_node_id;
      }
      chain.reverse();
      if (!chain.length) continue;
      for (const t of turnFromChain(s, chain)) turns.push(t);
    }
    const data = { sig: stat.sig, turns, rev: (prev?.data?.rev || 0) + 1 };
    files.set(dbPath, { agent, kind: 'devindb', m: stat.m, s: stat.s, off: 0, data });
    devinDbErr.delete(agent);
    emit(agent, dbPath, data, prev?.data);
  } catch (e) {
    console.error('[devindb]', e.message);
    devinDbErr.set(agent, e.message);
  } finally {
    try { db?.close(); } catch {}
  }
}

export function devinDbEntryContent(src, full) {
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
    v: 'dv' + (st.data.rev || 0),
  };
  if (t.err) out.callsNote = t.errMsg || '这一轮没有成功拿到模型回复';
  return out;
}

// 判据在 discovery.mjs（devinDbVerify：sqlite 页头 + sessions/message_nodes/tool_call_state 三张独有表），
// 与 hermes/opencode 同一处摆放 —— 嗅探每 3s 走一轮，读盘量在那里控制。
