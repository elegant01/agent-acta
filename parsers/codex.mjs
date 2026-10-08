// ---------------- codex 解析器（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanCodex / codexEntryContent
// + 口径函数（codexUserText / codexTokenUsage —— 详情与扫描共用同一套）。
//
// 事件流：session_meta(cwd) → event_msg/task_started(开轮, 带 model_context_window)
//        → response_item/function_call|message(reasoning) → event_msg/token_count(逐次 LLM 用量)
//        → event_msg/task_complete | turn_aborted(收轮)
// 用户真实输入**不能**从 response_item/message 取：那里面混着 <environment_context> /
// <permissions instructions> 等注入内容，且注入物同样是 role=user，字段上区分不出来。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, modelName, markKind, listDirCached, isDir, toText, trunc, readCompleteLines } from './shared.mjs';

export function codexIdBase(fp) { return 'x#' + fp.replace(/[\\/:]/g, '~') + '#'; }

// 用户输入的落点 codex 各版本不一致，已实测两种方言，都要认：
//   老：event_msg/user_message 的 message（本机 2026-09-11 那份 0.153.4 还是这种）
//   新：event_msg/item_completed 的 item（type=UserMessage）的 content
//       —— Codex Desktop 的会话走这种，整份 rollout 里 user_message 一条都没有，
//          只认老的那支「用户输入」就恒为空（页面渲成「（空）」），而 token/耗时/AI 输出都在，
//          所以看起来像整轮坏了、其实只塌了这一格。
// 两种形态的正文都不必特判：toText 认内容块数组（{content:[{type:'text',text}]}）。
export function codexUserText(p) {
  if (p.type === 'user_message') return toText(p.message);
  if (p.type === 'item_completed' && p.item?.type === 'UserMessage') return toText(p.item);
  return '';
}

export function codexTokenUsage(j) {
  const u = j.payload?.info;
  if (!u) return null;
  const d = u.last_token_usage || u.total_token_usage; // last = 本次调用增量
  if (!d) return null;
  return { tin: d.input_tokens || 0, tout: (d.output_tokens || 0) + (d.reasoning_output_tokens || 0), tcache: (d.cached_input_tokens || 0) + (d.cache_write_input_tokens || 0) };
}

function emitCodexTurns(agent, fp, data, fromIdx) {
  const idBase = codexIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    addEntry(idBase + t.idx, {
      agent, project: data.cwd || '(未知项目)', session: data.sessionId || path.basename(fp).replace(/^rollout-|\.jsonl$/g, ''),
      time: t.time, dur: Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      ctx: t.ctx || 0, rounds: t.calls, tools: t.tools, calls: t.calls,
      models: t.models, preview: t.preview,
      // R19：codex 的轮边界是显式的 —— task_complete 收轮（finished），turn_aborted 用户打断
      //（aborted，不标红：主动打断 ≠ 失败）。
      finished: !!t.finished, aborted: !!t.aborted, toolNames: t.toolNames || {},
    }, { file: fp, turn: t.idx, kind: 'codex' });
  }
}

export function scanCodexFile(agent, fp, names) {
  let fst; try { fst = fs.statSync(fp); } catch { return false; }
  const key = fp, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  if (prev && prev.m === m && prev.s === s) {
    if (prev.data?.turns?.length && !entries.has(codexIdBase(fp) + (prev.data.turns.length - 1))) emitCodexTurns(agent, fp, prev.data, 0);
    return true;
  }
  const off = prev?.off || 0;
  const data = prev?.data || { cwd: '', sessionId: '', turns: [], emitted: 0 };
  if (s <= off) { files.set(key, { agent, kind: 'codex', m, s, off, data }); markKind('codex'); return true; }
  try {
    const rd = readCompleteLines(fp, off, s);
    if (!rd) { files.set(key, { agent, kind: 'codex', m, s, off, data }); markKind('codex'); return true; }
    const newOff = rd.newOff;
    for (const line of rd.lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const p = j.payload || {};
      const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
      const cur = data.turns[data.turns.length - 1];
      if (j.type === 'session_meta') {
        if (p.cwd) data.cwd = p.cwd;
        if (p.id) data.sessionId = p.id;
      } else if (p.type === 'task_started') {
        data.turns.push({
          idx: data.turns.length, time: p.started_at ? p.started_at * 1000 : ts, lastTs: p.started_at ? p.started_at * 1000 : ts,
          tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, ctx: p.model_context_window || 0,
          models: [], mids: [], err: false, preview: '', user: '',
          toolNames: {}, finished: false, aborted: false, // R19/R20
        });
      } else if (cur && (p.type === 'user_message' || p.type === 'item_completed')) {
        // 两种方言都从 codexUserText 取；item_completed 里还夹着 AgentMessage，
        // 它会返回空串，这里自然不落地（正文另有 response_item/task_complete 两支在管）
        const text0 = codexUserText(p);
        if (text0 && !cur.preview) { cur.preview = text0.replace(/\s+/g, ' ').slice(0, 300); cur.user = text0.slice(0, 3000); }
      } else if (p.type === 'token_count' && cur) {
        const u = codexTokenUsage(j);
        if (u) { cur.tin += u.tin; cur.tout += u.tout; cur.tcache += u.tcache; cur.calls++; }
        if (ts) cur.lastTs = ts;
      } else if (j.type === 'turn_context' && cur) {
        // 过 modelName 再进数组：codex 各版本对 model 的写法不一致（字符串 / {slug} / 带 $ref 的 schema），
        // 非字符串直接 join 出去就是一串 [object Object]（见 modelName 上方的说明）
        const mdl = modelName(p.model || p.model_id);
        if (mdl && !cur.models.includes(mdl)) cur.models.push(mdl);
      } else if (j.type === 'response_item') {
        if (!cur) continue;
        if (p.type === 'function_call' || p.type === 'custom_tool_call') {
          cur.tools++;
          const nm = typeof p.name === 'string' && p.name ? p.name : '?';
          cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
        }
        else if (p.type === 'message') {
          const mdl = modelName(p.model);
          if (mdl && !cur.models.includes(mdl)) cur.models.push(mdl);
        }
      } else if (p.type === 'turn_aborted' && cur) {
        cur.aborted = true; // R19：用户主动打断，单独立标志，不混入 error 红
        if (ts) cur.lastTs = ts;
      } else if (p.type === 'task_complete' && cur) {
        cur.finished = true;
        if (ts) cur.lastTs = ts;
        if (p.error) cur.err = true;
      }
      if (cur && ts && ts > cur.lastTs) cur.lastTs = ts;
    }
    files.set(key, { agent, kind: 'codex', m, s, off: newOff, data });
    markKind('codex');
    emitCodexTurns(agent, fp, data, Math.max(0, data.emitted - 1));
    data.emitted = data.turns.length;
  } catch {}
  return true;
}

// 日期三层目录递归；用 listDirCached 做目录 mtime 短路
export function scanCodex(agent, root) {
  const walk = (dir, depth) => {
    const names = listDirCached(dir);
    if (!names) return;
    for (const n of names) {
      const fp = path.join(dir, n);
      if (n.endsWith('.jsonl')) { if (/^rollout-/.test(n)) scanCodexFile(agent, fp); continue; }
      if (depth < 4 && isDir(fp)) walk(fp, depth + 1);
    }
  };
  walk(root, 0);
}

// 详情：重读 rollout 文件按 src.turn 过滤（日志可能已被轮转/压缩，扫描缓存里没有正文）。
// 用户输入与 token 取数走扫描侧同一套函数（codexUserText / codexTokenUsage），
// 开轮也都按 task_started 计数 —— 两边口径对齐，详情不会跟卡片对不上账。
export function codexEntryContent(src, full) {
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null; // 与页面轮询比对的版本号
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  let turnIdx = -1;
  const out = { user: '', assistant: '', tools: [], calls: [], v: version };
  const texts = [];
  const byCall = new Map(); // call_id -> tool（精确配对 input/output）
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload || {};
    if (p.type === 'task_started') { turnIdx++; continue; }
    if (turnIdx !== src.turn) { if (turnIdx > src.turn) break; continue; }
    // 同扫描侧：认 user_message 与 item_completed 两种方言（codexUserText 里有两者的样本）
    if (p.type === 'user_message' || p.type === 'item_completed') { if (!out.user) out.user = codexUserText(p); continue; }
    if (p.type === 'token_count') {
      const u = codexTokenUsage(j);
      if (u) out.calls.push({ model: '', tin: u.tin, tout: u.tout, tcache: u.tcache, dur: 0 });
      continue;
    }
    if (p.type === 'task_complete') { if (p.last_agent_message && !texts.length) texts.push(String(p.last_agent_message)); continue; }
    if (j.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'assistant') {
      for (const c of p.content || []) if (c && (c.text || c.type === 'output_text')) texts.push(String(c.text || ''));
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const fi = {};
      const t = { name: p.name || p.tool_name || '?', tid: p.call_id || null, input: trunc(p.arguments ?? p.input, full, fi), inputTrunc: !!fi.t, output: '', error: null };
      out.tools.push(t);
      if (t.tid) byCall.set(t.tid, t);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = (p.call_id && byCall.get(p.call_id)) || out.tools.find(x => !x.output);
      if (t) {
        const fo = {};
        // 这里就是同事截图里那两行 `[object Object],[object Object]` 的入口：
        // 较新版本的 codex 把 output 写成内容块数组，原来 trunc 里的 String() 直接把它串成了那样。
        t.output = trunc(p.output ?? p.content, full, fo);
        t.outputTrunc = !!fo.t;
      }
    }
  }
  out.assistant = texts.join('\n');
  return out;
}
