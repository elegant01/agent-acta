// ---------------- openhands 解析器（OpenHands：~/.openhands/conversations/<会话 id>/） ----------------
// 落盘摆法（2026-10-14 真件实测，本机 1 个会话 11 个事件）：
//   <home>/.openhands/conversations/<会话 uuid 32 位>/events/event-<NNNNN>-<uuid>.json  ← **一事件一文件**
//   <home>/.openhands/conversations/<会话 uuid>/base_state.json                          ← 会话账本 + 工作目录
//   <home>/.openhands/agent_settings.json、<home>/.openhands/cache、profiles            ← 不是会话源
// 会话根**没有环境变量入口**（包里只翻到 OPENHANDS_SUPPRESS_BANNER / PROJECT_DIR / SESSION_ID 这些，
// 没有一条能改写持久化目录），所以 candidateBases 铺默认的 `~/.openhands` 就够（basesFor 的
// `.` + name 那条正好命中）；手工填 `~/.openhands / conversations 根 / 单个会话目录` 三种写法都认。
// ⚠️⚠️ **凭证红线**：`base_state.json` 里嵌着 `agent.llm.api_key`（明文 51 字符），
//   `agent_settings.json` 整份也是密钥与网关配置。⇒ **只许点取白名单字段**
//   （`stats` / `workspace` / `execution_status` / `agent.llm.model`），
//   绝不把整份 state 文本并进 data、绝不进详情正文、绝不进全文搜索分片。
//   回归里放一条 canary 断言（test/openhands-test.mjs 的 G 段）。
//
// 事件逐种形状（每个文件是一个完整事件对象，顶层都带 id / timestamp / source / kind）：
//   MessageEvent      {llm_message:{role,content[],thinking_blocks}, activated_skills, extended_content}
//                     source:"user" = 真人输入；source:"agent" = 助手正文
//   ActionEvent       {thought[], thinking_blocks, tool_name, tool_call_id, tool_call:{id,name,arguments,origin},
//                     action:{command,…,kind}, llm_response_id, security_risk, summary}
//   ObservationEvent  {tool_name, tool_call_id, action_id, observation:{content[],is_error,command,exit_code,timeout,metadata,kind}}
//   SystemPromptEvent {system_prompt, tools[], dynamic_context}                       ← 不算轮、不进正文
// ⚠️ 口径一（开轮）：`kind==="MessageEvent" && source==="user"` 且 llm_message 里有非空 text。
//   工具返回**不挂 user**（它在 ObservationEvent 里，source:"environment"），这一家比 droid / goose 干净；
//   但 SystemPromptEvent 也是 source:"agent"，别拿它当助手正文。
// ⚠️ 口径二（逐轮 token 源头不可得，droid 那一档）：事件对象里**没有任何 usage 字段**，
//   用量只在 `base_state.json` 的 `stats.usage_to_metrics.<来源>`：`accumulated_token_usage`
//   {prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
//    **context_window**, per_turn_token} + `accumulated_cost`。⇒ 每轮 tin/tout/tcache/total 一律如实 0，
//   **不拿会话累计冒充某一轮**；`per_turn_token` 语义未明（本机 20969，既不像末次调用也不像均值）⇒ 只进 note 不进桶。
//   唯一的例外是 **ctx 分母白送**：`context_window`（本机 922000）照实填进 entry.ctx（与 qwen 的行内
//   contextWindowSize 同一档，不用查 ctxWindows 表）；ctx 有分母但没有分子 ⇒ ctxUsed 留 0，不编。
// ⚠️ 口径三（轮内计数）：`calls` = 该轮内**去重后的 `llm_response_id` 数**（一次 LLM 响应可以并行产出
//   多个 ActionEvent，数 ActionEvent 会把一次调用报成两次）；`tools` = 该轮 ActionEvent 的条数。
// ⚠️ 口径四（时间与失败）：`timestamp` 是**不带时区的本地时间**（`2026-10-14T11:19:45.837188`）⇒
//   按本地时间解析（全站按毫秒 epoch 存），**别当 UTC**，否则每一轮都差一个时区；
//   失败只逐项认 `observation.is_error === true`（写进详情 tools[].error，同 droid 不染红整轮），
//   `exit_code` 非 0 一并带出；`security_risk` 不是失败信号，只原样进详情。
// 一个会话一个条目文件键：**会话目录**才是「文件」粒度的签名对象（事件只会新增不会改写），
// 签名 = 事件数 + 事件总字节 + base_state 的 mtime/size；与 buddyext / goose 同路数 ⇒ 不进 OFF_KINDS。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, isDir, isFile, toText } from './shared.mjs';

const MAX_EVENTS_PER_CONV = 4000;   // 只为「别在嗅探上失控」，不是产品上限

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }

// OpenHands 的 timestamp 无时区 ⇒ 按**本地**时间解析（Date.parse 对 'YYYY-MM-DDTHH:MM:SS.ffffff' 正是这么处理）
function evTime(s) { const n = Date.parse(String(s || '')); return Number.isFinite(n) ? n : 0; }

// ⚠️ 口径一：扫描、详情共用这一份开轮判据
export function openhandsIsUserPrompt(ev) {
  if (!ev || ev.kind !== 'MessageEvent' || ev.source !== 'user') return false;
  return !!openhandsUserText(ev.llm_message && ev.llm_message.content);
}

function textBlocks(content) {
  const buf = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) buf.push(b.text);
  }
  return buf;
}
export function openhandsUserText(content) { return textBlocks(content).join('\n\n'); }
function thinkingOf(content) {
  const buf = [];
  for (const b of Array.isArray(content) ? content : []) if (b && b.type === 'thinking' && b.thinking) buf.push(String(b.thinking));
  return buf.join('\n\n');
}

// 一个目录是不是 OpenHands 的会话目录：events/ 存在，且**至少一个**事件文件带 kind + source
// （内容判据 —— `~/.openhands` 下面还躺着 cache/ profiles/，名字猜错不能把邻居的数据接走）
export function openhandsConversation(base) {
  if (!isDir(base)) return null;
  const bn = path.basename(base);
  const cands = [
    path.join(base, 'conversations'),          // ~/.openhands
    base,                                      // conversations 根直接给
  ];
  if (isDir(path.join(base, 'events'))) cands.push(path.dirname(base));   // 单个会话目录直接给
  for (const root of [...new Set(cands)]) {
    if (!root || !isDir(root)) continue;
    const convs = listConversations(root);
    if (convs.length) return { root, convs };
  }
  return null;
}

function isEventFile(name) { return /^event-\d+-.*\.json$/i.test(name); }

// 单个会话目录：事件文件名排序就是事件顺序（NNNNN 是全局递增序号）
function conversationEvents(dir) {
  let names; try { names = fs.readdirSync(path.join(dir, 'events')); } catch { return null; }   // 事件在 dir/events/ 下，不是 dir 本身
  const evs = names.filter(isEventFile).sort();
  if (!evs.length) return null;
  let count = 0, bytes = 0, maxM = 0;
  for (const n of evs.slice(0, MAX_EVENTS_PER_CONV)) {
    try { const st = fs.statSync(path.join(dir, 'events', n)); bytes += st.size; maxM = Math.max(maxM, st.mtimeMs); count++; } catch {}
  }
  return { names: evs.slice(0, MAX_EVENTS_PER_CONV), count, bytes, maxM };
}

function listConversations(root) {
  const out = [];
  let names; try { names = fs.readdirSync(root); } catch { return out; }
  for (const d of names.slice(0, 400)) {
    const dir = path.join(root, d);
    if (!isDir(dir)) continue;
    const ev = conversationEvents(dir);
    if (!ev) continue;
    out.push({ dir, id: d, ev });
  }
  return out;
}

export function hasOpenhandsSessions(root) { return !!openhandsConversation(root); }

export function openhandsIdBase(dir) { return 'openhands#' + dir.replace(/[\\/:]/g, '~') + '#'; }

// 会话账本：只点取白名单字段（⚠️ 凭证红线 —— 整份 base_state 永远不外递）
function conversationStats(dir) {
  const st = readJson(path.join(dir, 'base_state.json'));
  if (!st) return null;
  const u = (st.stats && st.stats.usage_to_metrics) || {};
  const pick = (k) => {
    const m = u[k] || {};
    const t = m.accumulated_token_usage || {};
    return { source: k, model: m.model_name || '', cost: num(m.accumulated_cost),
      prompt: num(t.prompt_tokens), completion: num(t.completion_tokens), cacheRead: num(t.cache_read_tokens),
      cacheWrite: num(t.cache_write_tokens), reasoning: num(t.reasoning_tokens),
      ctx: num(t.context_window), perTurn: num(t.per_turn_token) };
  };
  const list = Object.keys(u).map(pick);
  const main = list.find(x => x.source === 'agent') || list[0] || { model: '', cost: 0, prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ctx: 0, perTurn: 0 };
  return {
    workspace: (st.workspace && st.workspace.working_dir) || '',
    workspaceKind: (st.workspace && st.workspace.kind) || '',
    executionStatus: st.execution_status || '',
    maxIterations: num(st.max_iterations),
    llm: (st.agent && st.agent.llm && st.agent.llm.model) || main.model || '',
    usage: main, all: list,
  };
}

// 一轮落成 entry。⚠️ 口径二：三桶一律 0；ctx 有分母、ctxUsed 没有分子。
function emitTurns(agent, dir, data, fromIdx) {
  const idBase = openhandsIdBase(dir);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(idBase + t.idx, {
      agent,
      project: data.project,
      session: data.session,
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : (t.lastTs > t.time ? t.lastTs - t.time : 0),
      status: 'ok',           // ⚠️ 口径四：is_error 只逐项，不染红整轮；轮级失败信号源里没有
      tin: 0, tout: 0, tcache: 0, total: 0,
      ctx: data.ctx || 0,
      ctxUsed: 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: false,
      toolNames: t.toolNames,
    }, { file: dir, turn: t.idx, kind: 'openhands' });
  }
}

// ---------------- 扫描主入口（一会话一个签名对象，整份重读；不进 OFF_KINDS） ----------------
export function scanOpenhands(agent, root) {
  const found = openhandsConversation(root);
  if (!found) return;
  for (const c of found.convs) {
    const key = c.dir;
    const bsPath = path.join(c.dir, 'base_state.json');
    let bsM = 0, bsS = 0; try { const st = fs.statSync(bsPath); bsM = st.mtimeMs; bsS = st.size; } catch {}
    const sig = c.ev.count + ':' + c.ev.bytes + ':' + bsM + ':' + bsS;   // ⚠️ 用签名比 m/s 更稳：事件是「新增文件」不是改写
    const prev = files.get(key);
    if (prev && prev.sig === sig) {
      if (prev.data?.turns?.length && !entries.has(openhandsIdBase(c.dir) + (prev.data.turns.length - 1)))
        emitTurns(agent, c.dir, prev.data, 0);
      continue;
    }
    const data = { turns: [], emitted: 0, session: c.id, project: '', ctx: 0 };
    let cur = null;
    const respIds = new Set();
    for (const n of c.ev.names) {
      const ev = readJson(path.join(c.dir, 'events', n));
      if (!ev || !ev.kind) continue;
      const ts = evTime(ev.timestamp);
      if (openhandsIsUserPrompt(ev)) {
        cur = {
          idx: data.turns.length, time: ts, lastTs: ts, calls: 0, tools: 0, models: [],
          toolNames: {}, preview: openhandsUserText(ev.llm_message.content).replace(/\s+/g, ' ').slice(0, 300),
        };
        data.turns.push(cur);
        continue;
      }
      if (!cur) continue;                     // 首条用户消息之前的 SystemPromptEvent 等：无主，跳过
      if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
      if (ev.kind === 'MessageEvent' && ev.source === 'agent') {
        const id = ev.llm_response_id || ev.id;
        if (id && !respIds.has(id)) { respIds.add(id); cur.calls++; }
        continue;
      }
      if (ev.kind === 'ActionEvent') {
        const id = ev.llm_response_id || ev.id;
        if (id && !respIds.has(id)) { respIds.add(id); cur.calls++; }   // ⚠️ 口径三：按 llm_response_id 去重
        cur.tools++;
        const nm = ev.tool_name || (ev.tool_call && ev.tool_call.name) || '?';
        cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
      }
    }
    const st = conversationStats(c.dir);
    if (st) {
      data.project = st.workspace || '';
      data.ctx = st.usage.ctx || 0;
      if (st.llm) for (const t of data.turns) if (!t.models.includes(st.llm)) t.models.push(st.llm);
    }
    files.set(key, { agent, kind: 'openhands', m: c.ev.maxM, s: c.ev.bytes, sig, off: 0, data, stats: st });
    emitTurns(agent, c.dir, data, 0);
    data.emitted = data.turns.length;
  }
}

// ---------------- 详情：吃扫描时并进内存的那轮 + 现读该轮的事件文件 ----------------
// 事件文件不可变（只新增不改写），所以按 turn 重读这一段的几个文件是安全且便宜的。
export function openhandsEntryContent(src, full) {
  const st = files.get(src.file);
  if (!st || !st.data) return null;
  const t = st.data.turns[src.turn];
  if (!t) return null;
  const out = { user: '', assistant: '', tools: [], calls: [], v: st.sig,
    callsNote: 'OpenHands 的落盘是**一事件一文件**（conversations/<会话>/events/event-<NNNNN>-<uuid>.json），'
      + '事件对象里**没有任何 usage 字段** ⇒ 逐轮 token 源头不可得，每轮三桶如实 0（与 droid 同档）。'
      + '会话账本在 base_state.json 的 `stats.usage_to_metrics`（见下面「会话账本」一行）；'
      + 'ctx 分母 = `context_window`，但分子没有 ⇒ ctxUsed 留 0。'
      + '事件时间是**不带时区的本地时间**，这里按本地解析。' };
  let idx = -1, started = false;
  const names = (conversationEvents(src.file)?.names || []).length
    ? conversationEvents(src.file).names
    : fs.readdirSync(path.join(src.file, 'events')).filter(isEventFile).sort();
  for (const n of names) {
    const ev = readJson(path.join(src.file, 'events', n));
    if (!ev) continue;
    if (openhandsIsUserPrompt(ev)) { idx++; if (idx === src.turn) { out.user = openhandsUserText(ev.llm_message.content); started = true; continue; } }
    if (idx > src.turn) break;
    if (!started) continue;
    if (ev.kind === 'MessageEvent' && ev.source === 'agent') {
      const body = openhandsUserText(ev.llm_message && ev.llm_message.content);
      if (body) out.assistant += (out.assistant ? '\n\n---\n\n' : '') + body;
      const call = { model: (st.stats && st.stats.llm) || '', tin: 0, tout: 0, tcache: 0, dur: 0 };
      const th = thinkingOf(ev.llm_message && ev.llm_message.content);
      if (th) call.thinking = th;
      out.calls.push(call);
      continue;
    }
    if (ev.kind === 'ActionEvent') {
      const fi = {};
      const args = typeof ev.tool_call?.arguments === 'string' ? ev.tool_call.arguments : JSON.stringify(ev.tool_call?.arguments ?? ev.action ?? {});
      out.tools.push({
        name: ev.tool_name || ev.tool_call?.name || '?', tid: ev.tool_call_id || ev.id, error: null,
        input: truncText(args, fi), inputTrunc: !!fi.t, output: '', outputTrunc: false,
        risk: ev.security_risk || null, summary: ev.summary || null,
      });
      if (ev.thought && ev.thought.length) {
        const th = textBlocks(ev.thought).join('\n');
        if (th && out.calls.length) out.calls[out.calls.length - 1].thinking = th;
      }
      continue;
    }
    if (ev.kind === 'ObservationEvent') {
      const tgt = out.tools.find(x => x.tid === (ev.action_id && ev.tool_call_id ? ev.tool_call_id : ev.tool_call_id));
      const ob = ev.observation || {};
      const body = typeof ob.content === 'string' ? ob.content : toText(ob.content);
      const fo = {};
      if (tgt) { tgt.output = truncText(body, fo); tgt.outputTrunc = !!fo.t; if (ob.is_error) tgt.error = 'error'; if (typeof ob.exit_code === 'number' && ob.exit_code !== 0) tgt.exitCode = ob.exit_code; }
      if (ob.is_error) out.errCount = (out.errCount || 0) + 1;
    }
  }
  if (out.errCount) out.callsNote += ' 这一轮有 ' + out.errCount + ' 次工具返回 is_error=true（逐项标记，未染红整轮）。';
  const s = st.stats;
  if (s) {
    const u = s.usage || {};
    const parts = ['累计 prompt ' + num(u.prompt) + ' / completion ' + num(u.completion) + ' / cacheRead ' + num(u.cacheRead) + ' / cacheWrite ' + num(u.cacheWrite) + ' / reasoning ' + num(u.reasoning)];
    if (u.ctx) parts.push('context_window ' + u.ctx);
    if (u.perTurn) parts.push('per_turn_token ' + u.perTurn + '（语义未明，只照抄不参与计算）');
    if (u.cost) parts.push('累计成本 ' + u.cost.toFixed(6));
    if (s.llm) parts.push('模型 ' + s.llm);
    if (s.executionStatus) parts.push('execution_status=' + s.executionStatus);
    if (s.all && s.all.length > 1) parts.push('另有 ' + (s.all.length - 1) + ' 个来源的账（usage_to_metrics 按来源分桶）');
    out.callsNote += ' 会话账本（base_state.json.stats.usage_to_metrics，只取数字）：' + parts.join('；') + '。';
  }
  return out;
}

function truncText(s, flag) {
  const v = toText(s);
  if (v.length <= 800) return v;
  flag.t = true;
  return v.slice(0, 800);
}
