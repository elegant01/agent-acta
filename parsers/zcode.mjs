// ---------------- zcode 解析器（~/.zcode/cli/db/db.sqlite，WAL 模式的 SQLite 库） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanZcode / zcodeScanErr / zcodeIdBase。
//
// 表结构与关联（本机实测，见 LOGFORMATS.md 的 zcode 一节）：
//   session(id, parent_id, directory, title, task_type, time_created/updated/archived)
//   message(id, session_id, sequence, time_created, data JSON)   —— data.role = user/assistant，
//         data.time.{created,completed}、data.tokens、data.error、data.modelID/providerID
//   part(id, message_id, session_id, sequence, data JSON)        —— data.type = text / reasoning /
//         tool / step-start / step-finish / timeline / …；tool part 的出入参在 data.state.{input,output}
//   session_input(payload JSON)                                   —— 用户输入的兜底：payload.text
//         或 payload.conversationInputIntent.text，promoted_message_id 关联到 user message
//   tool_usage / model_usage / turn_usage                         —— 逐次工具/模型/轮的真实指标
//         （起止时间、duration_ms、token、status、error），靠 turn_id / tool_call_id / user_message_id
//         关联回 message 与 part
//
// 切轮：一个 role=user 的 message 开一轮（与 claude/cursor 同口径），turn_usage.user_message_id
// 正好也是这个键，两边天然对齐。turn_usage 缺行（老版本/中断）时回退到「按消息分组 + model_usage 求和」。
// 首个 user 之前的 assistant 消息（实测存在：会话头一条 assistant）挂进一个「序章」轮，不丢。
//
// 增量：SQLite 没有字节偏移语义，且 WAL 模式下新数据先落在 db.sqlite-wal（库文件本身的 mtime 不动），
// 所以签名 = db 文件与 wal 文件的 {mtime,size} 四元组，变了才整份重解析 —— 与 gemini 同一路数。
// 库很小（本机 <1MB），整份重读比维护水位线可靠；zcode 因此不进 OFF_KINDS，也就无需 PARSER_REV。
//
// 只读纪律：DatabaseSync 一律 {readOnly:true} 打开，查完即关；任何一步失败（库被锁、损坏、表缺失）
// 都保留上一轮的解析结果并记下原因（诊断页可见），绝不对库做任何写操作。
import fs from 'node:fs';
import { files, entries, srcs, removedIds, sorted, addEntry, toolNameCounts, modelName, toText, sqliteMod } from './shared.mjs';

// node:sqlite 加载器在 shared.mjs（cursor / zcode / discovery 的嗅探共用同一份实例）。
// zcode 这里只需要「拿不拿得到模块」：拿到就能扫，拿不到在 zcodeScanErr 里说明原因。

// 每个 agent 最近一次 zcode 扫描的失败原因（诊断页「已接入 · 0 条」时展示；成功则清除）
export const zcodeScanErr = new Map();

// part.data 的安全解析：损坏 JSON 不能拖垮整个会话（需求「兼容和容错」），坏了就以原文进 others
function zcodeJson(raw) { try { return JSON.parse(raw); } catch { return null; } }

function zcodeTurn(sid, key, ts) {
  return {
    sid, key, time: ts || 0, lastTs: ts || 0, endTs: 0,
    tin: 0, tout: 0, tcache: 0, ctxUsed: 0,
    models: [], callList: [], tools: [], byCall: new Map(),
    user: '', texts: [], events: [], others: [],
    err: false, errMsg: '', steps: 0,
  };
}

// 非文本 part 的处理：工具进 tools[]，有信息量的状态事件压缩后进 others[]，纯占位的不留。
// 未知类型**不静默丢弃**（需求）：整个 JSON 截到 2000 字进 others，详情面板「其他事件」里可看。
function zcodePart(turn, msg, part) {
  const d = zcodeJson(part.data);
  const t = part.time_created || msg?.time_created || 0;
  if (!d) {
    turn.others.push({ type: '(损坏的 JSON)', t, json: String(part.data || '').slice(0, 2000) });
    return;
  }
  const type = typeof d.type === 'string' ? d.type : '(无 type)';
  if (type === 'text') {
    const s = toText(d.text);
    if (!s) return;
    if (msg?.role === 'user') { if (!turn.user) turn.user = s; }
    else if (msg?.role === 'assistant') turn.texts.push(s);
    else {
      // system 或更晚出现的角色：不进「AI 输出」冒充助手正文，留结构化锚点 + sys 事件
      turn.others.push({ type: (msg?.role || '未知角色') + ' 文本', t, json: JSON.stringify(s.slice(0, 2000)) });
      turn.events.push({ k: 'sys', t: t || turn.time, len: s.length });
    }
    return;
  }
  if (type === 'tool') {
    const st = d.state || {};
    const tool = {
      name: d.tool || '?', tid: d.callID || null, ct: t,
      input: st.input != null ? st.input : '', output: st.output != null ? st.output : '',
      error: st.status && st.status !== 'completed' ? String(st.error || st.status) : null,
      dur: 0,
    };
    turn.tools.push(tool);
    if (tool.tid) turn.byCall.set(tool.tid, tool);
    return;
  }
  if (type === 'step-start') { turn.steps++; turn.events.push({ k: 'step', t: t || turn.time, n: turn.steps, ph: 'start' }); return; }
  if (type === 'step-finish') {
    // step-finish 带这一步的 token 账：model_usage 缺行时它就是调用级的兜底来源
    const tk = d.tokens || {};
    turn.others.push({ type, t, json: JSON.stringify({ reason: d.reason, tokens: tk }).slice(0, 2000) });
    turn._stepTokens = tk; // 调用级 token 兜底（见 scanZcode 的 calls 回填）
    return;
  }
  if (type === 'reasoning') {
    // 推理正文可能是整段思考，且 metadata 里常带签名junk —— 只留长度锚点（同 dsh 对 sys 的处理）
    turn.others.push({ type, t, json: JSON.stringify({ len: toText(d.text).length }) });
    return;
  }
  // timeline / 未知类型：保留结构化 JSON（截断），在详情「其他事件」里可查
  turn.others.push({ type, t, json: JSON.stringify(d).slice(0, 2000) });
}

export function scanZcode(agent, dbPath) {
  const key = dbPath;
  let dst, wst = null;
  try { dst = fs.statSync(dbPath); } catch { zcodeScanErr.set(agent, '数据库不存在：' + dbPath); return; }
  try { wst = fs.statSync(dbPath + '-wal'); } catch {}  // WAL 可能已被 checkpoint 掉，没有是正常的
  const sig = dst.mtimeMs + '|' + dst.size + '|' + (wst ? wst.mtimeMs + '|' + wst.size : '-');
  const prev = files.get(key);
  if (prev && prev.data.sig === sig) {
    // 库没变就不重解析 —— 但条目可能被 LRU 淘汰过（同 dsh 的处理：按最后一轮补回）
    const last = prev.data?.turns?.[prev.data.turns.length - 1];
    if (last && !entries.has(zcodeIdBase(key) + last.sid.replace(/#/g, '~') + '#' + last.key)) emitZcodeTurns(agent, key, prev.data, null);
    return;
  }

  const mod = sqliteMod();
  if (!mod) { zcodeScanErr.set(agent, '当前 Node 没有 node:sqlite（需要 22.5+）'); return; }
  let db = null;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    // 每张表单独容错：库在、但某张表缺失/损坏时，其余表照常解析，不让整库变白
    const qAll = (sql) => { try { return db.prepare(sql).all(); } catch { return null; } };
    const sessions = qAll('SELECT id, parent_id, directory, path, title, task_type, time_created, time_updated, time_archived FROM session ORDER BY time_created');
    if (!sessions) throw new Error('读不到 session 表（schema 不兼容或被锁定）');
    const messages = qAll('SELECT id, session_id, sequence, time_created, time_updated, data FROM message ORDER BY session_id, sequence') || [];
    const parts = qAll('SELECT id, message_id, session_id, sequence, time_created, data FROM part ORDER BY session_id, sequence') || [];
    const inputs = qAll('SELECT id, session_id, kind, status, payload, promoted_message_id, time_created FROM session_input') || [];
    const toolUs = qAll('SELECT session_id, turn_id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms, exit_code, error_message, stdout_bytes, stderr_bytes FROM tool_usage') || [];
    const modelUs = qAll('SELECT session_id, turn_id, parent_user_message_id, assistant_message_id, provider_id, model_id, status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, finish_reason, tool_call_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, error_type, error_message FROM model_usage') || [];
    const turnUs = qAll('SELECT session_id, turn_id, user_message_id, status, started_at, completed_at, duration_ms, time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, tool_call_count, error_type, error_code FROM turn_usage') || [];

    const sessById = new Map(sessions.map(s => [s.id, s]));
    // sequence 排序的防御：真库的 sequence 是 INTEGER，但万一哪个版本写成别的（或错列），
    // 退回 time_created 也得保证「同一会话内按真实先后」——切轮正确性全靠这个顺序
    const seqOf = r => (typeof r.sequence === 'number' ? r.sequence : (r.time_created || 0));
    messages.sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : seqOf(a) - seqOf(b)));
    parts.sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : seqOf(a) - seqOf(b)));
    // ---- 消息与其 part 归组 ----
    const msgById = new Map();
    const partsByMsg = new Map();
    for (const p of parts) {
      if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
      partsByMsg.get(p.message_id).push(p);
    }
    const inputByMsg = new Map();
    for (const si of inputs) {
      const d = zcodeJson(si.payload);
      const text = toText(d?.text ?? d?.conversationInputIntent?.text);
      if (text && si.promoted_message_id && !inputByMsg.has(si.promoted_message_id)) inputByMsg.set(si.promoted_message_id, text);
    }

    // ---- 按会话切轮：role=user 开一轮，其后的 assistant 归这一轮 ----
    const turns = [];
    const turnByMsg = new Map();   // 任意 message id（user 或 assistant）→ 它所属的轮
    const turnByUserMsg = new Map();
    for (const s of sessions) {
      const sMsgs = messages.filter(m => m.session_id === s.id);
      // 会话级信息拍平进每一轮：emit / 详情不再回查 session 表
      const proj = s.directory || s.path || '(未知项目)';
      const title = (s.title || '').trim();
      const name = (s.parent_id ? '⤷ ' : '') + title;   // parent_id 非空 = 子 agent 会话
      let cur = null;
      for (const m of sMsgs) {
        const d = zcodeJson(m.data) || {};
        const role = typeof d.role === 'string' ? d.role : '';
        const ts = typeof d.time?.created === 'number' ? d.time.created : (m.time_created || 0);
        const msg = { id: m.id, role, ts, d };
        msgById.set(m.id, msg);
        if (role === 'user' || !cur) {
          // 首个 user 之前的消息（会话头的 assistant 序章）也开一轮，key 用消息 id 兜底
          cur = zcodeTurn(s.id, role === 'user' ? m.id : ('pre#' + m.id), ts);
          cur.ord = turns.length;
          cur.project = proj;
          cur.name = name || null;
          // I16 子 agent 拓扑：`session.parent_id` 非空 = 这一坨轮次属于**子 agent 会话**。
          // 源头给的显式外键（子会话 id 指向父会话 id），不需要按时间区间猜父子。
          // 之前只用它给标题加了个「⤷ 」前缀，父子关系本身没往条目上落，聚合层也就无从成树。
          cur.parentId = s.parent_id || null;
          turns.push(cur);
          if (role === 'user') turnByUserMsg.set(m.id, cur);
          // 时间线锚点：这一轮的用户输入时刻（dsh 的 user/message 事件同义）
          if (role === 'user') cur.events.push({ k: 'user', t: ts || 0 });
        }
        turnByMsg.set(m.id, cur);
        if (ts) { if (!cur.time || ts < cur.time) cur.time = ts; cur.lastTs = Math.max(cur.lastTs, ts); }
        if (d.time?.completed) cur.endTs = Math.max(cur.endTs, d.time.completed);
        // message 级错误（模型调用失败整条挂在 assistant message 上）
        if (d.error && !cur.errMsg) cur.errMsg = toText(d.error?.data?.message || d.error?.message || d.error?.name || '');
        // 该消息的 parts 归进当前轮
        for (const p of partsByMsg.get(m.id) || []) zcodePart(cur, msg, p);
        // 用户输入兜底：user message 没有 text part 时，从 session_input 补
        if (role === 'user' && !cur.user && inputByMsg.has(m.id)) cur.user = inputByMsg.get(m.id);
      }
    }

    // ---- 用量表回填（turn_id / message id 三条路都试，配不上的按时间落） ----
    const turnByTurnId = new Map();
    for (const tu of turnUs) {
      const t = turnByUserMsg.get(tu.user_message_id);
      if (t && tu.turn_id) turnByTurnId.set(tu.session_id + '|' + tu.turn_id, t);
    }
    const findTurn = (sid, turnId, msgIds, ts) => {
      if (turnId && turnByTurnId.has(sid + '|' + turnId)) return turnByTurnId.get(sid + '|' + turnId);
      for (const mid of msgIds || []) if (mid && turnByMsg.has(mid)) return turnByMsg.get(mid);
      // 时间兜底：落到「包含这个时刻」的轮（轮与轮之间按 user 消息切，时间必然单调）
      if (ts) {
        let best = null;
        for (const t of turns) {
          if (t.sid !== sid || !t.time || ts < t.time) continue;
          if (!best || t.time > best.time) best = t;
        }
        if (best) return best;
      }
      return null;
    };

    for (const tu of turnUs) {
      const t = findTurn(tu.session_id, null, [tu.user_message_id], tu.started_at);
      if (!t) continue;
      if (tu.turn_id) turnByTurnId.set(tu.session_id + '|' + tu.turn_id, t);
      // 轮级账以 turn_usage 为准（它是源头自己算的聚合）；字段为 null 时不覆盖已有值
      t._tu = tu;
      if (tu.started_at) t.time = t.time ? Math.min(t.time, tu.started_at) : tu.started_at;
      if (tu.completed_at) { t.endTs = Math.max(t.endTs, tu.completed_at); t.lastTs = Math.max(t.lastTs, tu.completed_at); }
      if (tu.status && tu.status !== 'completed') { t.err = true; if (!t.errMsg && tu.error_type) t.errMsg = tu.error_type; }
    }
    for (const mu of modelUs) {
      const t = findTurn(mu.session_id, mu.turn_id, [mu.parent_user_message_id, mu.assistant_message_id], mu.started_at);
      if (!t) continue;
      const mdl = modelName(mu.model_id);
      const cache = (mu.cache_read_input_tokens || 0) + (mu.cache_creation_input_tokens || 0);
      const failed = mu.status && mu.status !== 'completed';
      const call = {
        model: mdl || '(未知模型)',
        tin: mu.input_tokens || 0, tout: (mu.output_tokens || 0) + (mu.reasoning_tokens || 0), tcache: cache,
        dur: mu.duration_ms || (mu.started_at && mu.completed_at ? Math.max(0, mu.completed_at - mu.started_at) : 0),
      };
      if (failed) call.error = mu.error_message || mu.error_type || String(mu.status);
      // 这次调用自己产出的正文：assistant_message_id 直接指到那条 message，它的 text parts 就是
      const amsg = mu.assistant_message_id ? msgById.get(mu.assistant_message_id) : null;
      if (amsg) {
        const pts = (partsByMsg.get(mu.assistant_message_id) || [])
          .map(p => zcodeJson(p.data)).filter(d => d && d.type === 'text').map(d => toText(d.text)).filter(Boolean);
        if (pts.length) call.text = pts.join('\n');
      }
      t.callList.push(call);
      if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
      const ctxNow = (mu.input_tokens || 0) + cache;
      if (ctxNow > 0) t.ctxUsed = ctxNow;   // 轮内最后一次胜出（与 claude/kimi 同口径，非累加）
      if (mu.started_at) { if (!t.time || mu.started_at < t.time) t.time = mu.started_at; }
      if (mu.completed_at) { t.lastTs = Math.max(t.lastTs, mu.completed_at); t.endTs = Math.max(t.endTs, mu.completed_at); }
      // 逐事件时间线（与 dsh 同一 schema）：ttft = 首 token − 发起，dur = 流式解码段
      t.events.push({
        k: 'llm', t: mu.started_at || t.time,
        ttft: mu.first_token_at && mu.started_at ? Math.max(0, mu.first_token_at - mu.started_at) : (mu.time_to_first_token_ms || 0),
        dur: mu.first_token_at && mu.completed_at ? Math.max(0, mu.completed_at - mu.first_token_at) : call.dur,
        model: mdl || '', tin: call.tin, tout: call.tout, tcache: cache,
        err: !!failed, blocks: call.text ? ['text'] : [],
      });
      if (failed && !t.errMsg && call.error) t.errMsg = toText(call.error);
    }
    for (const tu of toolUs) {
      const t = findTurn(tu.session_id, tu.turn_id, null, tu.started_at);
      if (!t) continue;
      // 指标挂回 part 层面的工具（tool_call_id ↔ callID）；配不上 part 的以「纯指标」工具补一条
      let tool = tu.tool_call_id ? t.byCall.get(tu.tool_call_id) : null;
      if (!tool) {
        tool = { name: tu.tool_name || '?', tid: tu.tool_call_id || null, ct: tu.started_at || 0, input: '', output: '', error: null, dur: 0 };
        t.tools.push(tool);
        if (tool.tid) t.byCall.set(tool.tid, tool);
      }
      const failed = tu.status && tu.status !== 'completed';
      tool.dur = tu.duration_ms || (tu.started_at && tu.completed_at ? Math.max(0, tu.completed_at - tu.started_at) : 0);
      if (failed && !tool.error) tool.error = toText(tu.error_message || tu.error_type || (tu.exit_code ? 'exit ' + tu.exit_code : tu.status));
      const i = t.tools.indexOf(tool);
      t.events.push({ k: 'call', t: tu.started_at || t.time, name: tool.name, tid: tool.tid, i });
      t.events.push({ k: 'result', t: tu.completed_at || (tu.started_at || t.time), tid: tool.tid, i, dur: tool.dur, error: !!failed });
      if (failed) t.err = true;
    }

    // ---- 收尾：轮级字段定稿 ----
    for (const t of turns) {
      const tu = t._tu;
      if (tu) {
        t.tin = tu.input_tokens || 0;
        t.tout = (tu.output_tokens || 0) + (tu.reasoning_tokens || 0);
        t.tcache = (tu.cache_read_input_tokens || 0) + (tu.cache_creation_input_tokens || 0);
      } else {
        // turn_usage 缺行：回退到逐次调用求和
        for (const c of t.callList) { t.tin += c.tin; t.tout += c.tout; t.tcache += c.tcache; }
      }
      if (!t.callList.length && t._stepTokens) {
        // 连 model_usage 也没有：step-finish 的 token 账兜底一次调用（宁可少算不造假，标 1 次）
        const tk = t._stepTokens;
        t.callList.push({ model: t.models[0] || '(未知模型)', tin: tk.input || 0, tout: (tk.output || 0) + (tk.reasoning || 0), tcache: (tk.cache?.read || 0) + (tk.cache?.write || 0), dur: 0 });
      }
      // 状态：turn_usage 说错了才算错；没有 turn_usage 时「有调用且全败」才算错（与 dsh 同思路）
      if (!t.err && !tu && t.callList.length && t.callList.every(c => c.error)) t.err = true;
      if (t.err && !t.errMsg) t.errMsg = (t.callList.find(c => c.error) || {}).error || '';
      t.user = t.user.slice(0, 3000);
      const body = t.texts.join('\n\n---\n\n');
      t.preview = (t.user || body || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
      // 事件按真实时刻排序；end 事件放在最后（turn_usage 的 completed_at 或最后一条消息时刻）
      t.events.push({ k: 'end', t: t.endTs || t.lastTs || t.time, reason: t.err ? 'error' : 'completed' });
      t.events.sort((a, b) => (a.t - b.t) || 0);
      delete t._tu; delete t._stepTokens;
    }

    // 全空的轮不灌条目：真库里存在「序章 assistant 消息」（首个 user 之前、无 part 无调用）与
    // 打开了但没说话的轮 —— 它们会以 preview 空、calls 0、tools 0 的卡片出现在列表里，纯噪音。
    // 「只有推理/步态/时间线标记」也算空（实测：每个会话的序章 assistant 消息只挂一个
    // timeline=model_change part，留着就是一张全空卡片）；但带未知类型 part 的轮必须留着
    // （未知内容不能静默丢弃）。
    const KEEP_NOISY = new Set(['reasoning', 'step-finish', 'timeline']);
    const liveTurns = turns.filter(t =>
      t.user || t.texts.length || t.callList.length || t.tools.length || t.errMsg ||
      t.others.some(o => !KEEP_NOISY.has(o.type)));
    const data = { sig, turns: liveTurns, rev: (prev?.data?.rev || 0) + 1 };
    files.set(key, { agent, kind: 'zcode', m: dst.mtimeMs, s: dst.size, off: 0, data });
    zcodeScanErr.delete(agent);
    emitZcodeTurns(agent, key, data, prev?.data);
  } catch (e) {
    // 库被锁/损坏/schema 变了：保留旧数据，原因写到诊断页，绝不让一个库拖垮整轮扫描
    console.error('[zcode]', e.message);
    zcodeScanErr.set(agent, e.message);
  } finally {
    try { db && db.close(); } catch {}
  }
}

export function zcodeIdBase(key) { return 'z#' + key.replace(/[\\/:]/g, '~') + '#'; }

function emitZcodeTurns(agent, key, data, prevData) {
  const idBase = zcodeIdBase(key);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = idBase + t.sid.replace(/#/g, '~') + '#' + t.key;
    ids.add(id);
    addEntry(id, {
      agent, project: t.project, session: t.sid,
      time: t.time, dur: Math.max(0, (t.endTs || t.lastTs) - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      ctx: 0, ctxUsed: t.ctxUsed || null,   // zcode 源头没有窗口容量字段：只显示占用，不画进度条
      rounds: t.callList.length, tools: t.tools.length, calls: t.callList.length,
      models: t.models, preview: t.preview, name: t.name || null,
      // I16：子会话谱系（parent_id → 父会话 id；根会话不落 depth 这个键）。源头显式外键，直接透传。
      parent: t.parentId || undefined, depth: t.parentId ? 1 : undefined,
      finished: !!t.finished || i < data.turns.length - 1, aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools),
    }, { file: key, turn: i, kind: 'zcode' });
  });
  // 库重写/会话被删时旧条目要撤掉（同 dsh / gemini）
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}
