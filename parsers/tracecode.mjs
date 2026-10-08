// ---------------- tracecode / tracework 解析器 ----------------
// 数据源：TraeCode / TraeWork 桌面版的明文 renderer.log
//   路径形态：<APPDATA>\<Trae CN 或 Trae Work>\logs\<启动时间戳>\window1\renderer.log
//
// 定位（R23 起）：**回退源**。TraeCode/TraeWork 的完整会话数据在
// ModularData/ai-agent/database.db（SQLCipher 加密库）——该库现在由 parsers/traedb.mjs 读取
// （密钥配置项 traeKey，见 REFERENCE.md「Trae 的 SQLCipher 库」）；主文件 scanTraeAgent 在库读不出来时
// （没配密钥 / 密钥不对 / 库正在被写）自动回退到本文件。所以这里的原则是**保留骨架能力**：
// 事件、工具名、状态都有，token 与 AI 正文没有（见下面「口径限制」），不必也不该去猜。
// 这台机器上库一直读得出来时，这份解析器就不会被调用（两边同时上线=每轮两张重复卡片，
// 由主文件的源切换逻辑二选一）。
//
// snapshot/v2 是工作区文件的 git 快照（before/after 标签），sandbox json 是权限配置，
// 都不是会话内容。明文出口里含完整 ai-chat/v2 协议事件的就是 renderer.log。
//
// 事件流（每行一条 [ai-chat/v2] [Handler] 文字 + JSON）：
//   [MetadataHandler] received metadata {sessionId, chat_start_time, model_info,
//     user_message_context.parsed_query, references, agent_name, agent_id, trace_id, ...}
//     —— 一轮用户提问一次，含模型与用户原话
//   [PlanItemHandler] New plan item created {sessionId, planItemId, toolCallName}
//     —— 一次工具调用，toolCallName 可能为空串（思考/计划项，不算工具）
//   [DoneHandler] Stream done event received {sessionId, status, agentMessageId}
//     —— 一次回答结束，status: completed | canceled
//   [SessionTitleHandler] Session title updated {sessionId}  —— 会话标题
//
// 聚合粒度：**按轮聚合**（与 claude / codex / kimi 同款），不是按 session 聚合。
//   每个 MetadataHandler 事件 = 开一轮（一条 entry）；
//   该轮内（到下一个同 sid 的 MetadataHandler 之前）的 PlanItemHandler 归这一轮；
//   该轮的 DoneHandler 事件 = 收轮（status 决定 finished/aborted）。
//   entry id = `tc#<filepath>#<sessionId>#<seq>`，seq = 该 session 内第几个 metadata（从 0 开始）。
//
// 口径限制（与 LOGFORMATS.md 同步）：
//   · tin/tout/tcache 恒为 0：renderer.log 不含 token 用量（fee_usage 字段恒为 null，计费在后端）
//   · AI 输出正文不在 renderer.log（流式 SSE 走内存，不落地）—— 详情页只能给用户提示与工具列表
//   · calls = 1（每轮一次 LLM 调用，metadata 事件本身就是这次 LLM 调用的开始；
//     renderer.log 没有 LLM 调用级别的独立 token_count 事件，无法精确计数多次调用）
import fs from 'node:fs';
import path from 'node:path';
import { files, addEntry, markKind, listDirCached, isDir, readCompleteLines } from './shared.mjs';

// 行首时间戳：2026-09-17T15:47:57.011+08:00
// 模块 tag 不写死单个名字：老版本是 [ai-chat/v2]，新版 Trae（如 TRAE SOLO CN）改成了 [trae-chat-core]，
// 写死就一整行匹配不上、整份 renderer.log 白扫。放宽成字符类后两类都认，HANDLERS 的 prefix 仍负责挑出真正的事件行。
const TRAE_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})\s+\[info\]\s+\[[\w\-\/\.\s]+\]\s+\[(\w+)\]\s+(.*)$/;

// 各类 Handler 的事件关键字（出现在 message 文字开头）
// 注意：TRAE_TS 正则已经吃掉 `[Handler]`，所以 m[3] 直接从 message 开始，
//       这里的 prefix **不带** `[Handler] ` 前缀。
const HANDLERS = {
  META: 'received metadata ',
  PLAN: 'New plan item created ',
  DONE: 'Stream done event received ',
  TITLE: 'Session title updated ',
};

// 行尾 JSON 对象的解析：从字符串里找第一个能 JSON.parse 的子串。
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  // 兜底：从 start 起，每遇到一个 } 都试一次（应对「JSON 后还有文字」的边角）
  let depth = 0, inStr = false, esc = false, candidate = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { candidate = text.slice(start, i + 1); break; }
      }
    }
  }
  if (candidate) { try { return JSON.parse(candidate); } catch {} }
  return null;
}

// 解析单行：返回 { handler, json, ts } 或 null
function parseLine(line) {
  // Windows CRLF：split('\n') 后每行末尾留一个 \r，会让 `(.*)$` 匹配失败（$ 在 \r 前）
  if (line.endsWith('\r')) line = line.slice(0, -1);
  const m = line.match(TRAE_TS);
  if (!m) return null;
  const ts = Date.parse(m[1]);
  const rest = m[3];
  for (const [key, prefix] of Object.entries(HANDLERS)) {
    if (rest.startsWith(prefix)) {
      const json = extractJson(rest.slice(prefix.length));
      return { handler: key, json, ts, rest };
    }
  }
  return null;
}

// 把 parsed_query 数组（用户原话）规整成单行预览
function previewOf(parsedQuery) {
  if (!Array.isArray(parsedQuery)) return '';
  for (const q of parsedQuery) {
    if (typeof q === 'string' && q.trim()) return q.replace(/\s+/g, ' ').slice(0, 300);
    if (q && typeof q === 'object' && typeof q.data === 'object' && typeof q.data.content === 'string') {
      return q.data.content.replace(/\s+/g, ' ').slice(0, 300);
    }
    if (q && typeof q === 'object' && typeof q.content === 'string') {
      return q.content.replace(/\s+/g, ' ').slice(0, 300);
    }
  }
  return '';
}

// 把 parsed_query 数组里所有字符串块拼成完整用户输入（详情页用）
function userTextOf(parsedQuery) {
  if (!Array.isArray(parsedQuery)) return '';
  const strs = parsedQuery.filter(q => typeof q === 'string');
  if (strs.length) return strs.join('\n');
  // 兜底：query 字段是 JSON 字符串形式的 content blocks
  return '';
}

// 引用文件提取：references[].uri 取第一个作为 project 锚点
function projectOf(references) {
  if (!Array.isArray(references)) return '(Trae)';
  for (const r of references) {
    if (r && typeof r === 'object' && typeof r.uri === 'string' && r.uri.trim()) {
      try { return path.dirname(r.uri) || r.uri; } catch { return r.uri; }
    }
  }
  return '(Trae)';
}

// entry id 基：跨多个 renderer.log 文件不会冲突（带文件路径）
function traeIdBase(fp) { return 'tc#' + fp.replace(/[\\/:]/g, '~') + '#'; }

// 单文件增量扫描：按轮聚合
function scanTraeRendererFile(agent, kind, fp, onlyFile) {
  let fst; try { fst = fs.statSync(fp); } catch { return false; }
  const key = fp, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  if (prev && prev.m === m && prev.s === s) {
    // 签名没变：重建一遍条目（trace 同款语义：files 不进 OFF_KINDS 时 entries 可能被 evict）
    if (prev.data?.turns?.length) emitTraeTurns(agent, kind, fp, prev.data, 0);
    return true;
  }
  const off = prev?.off || 0;
  const data = prev?.data || { turns: [], bySidSeq: Object.create(null), emitted: 0 };
  // turns: [turnEntry]；bySidSeq: sessionId -> 下一个 seq（用于给新 metadata 分配序号）
  if (s <= off) { files.set(key, { agent, kind, m, s, off, data }); markKind(kind); return true; }
  try {
    const rd = readCompleteLines(fp, off, s);
    if (!rd) { files.set(key, { agent, kind, m, s, off, data }); markKind(kind); return true; }
    const newOff = rd.newOff;
    for (const line of rd.lines) {
      const ev = parseLine(line);
      if (!ev || !ev.json) continue;
      const sid = ev.json.sessionId || ev.json.session_id;
      if (!sid) continue;
      if (ev.handler === 'META') {
        // 开一轮
        const seq = data.bySidSeq[sid] || 0;
        data.bySidSeq[sid] = seq + 1;
        const uc = ev.json.user_message_context;
        const cst = typeof ev.json.chat_start_time === 'number' ? ev.json.chat_start_time : ev.ts;
        const mi = uc?.model_info;
        const modelName = mi ? (mi.display_model_name || mi.model_name || mi.config_name || '') : '';
        const turn = {
          sid, seq,
          firstTime: cst || ev.ts || 0,
          lastTs: ev.ts || cst || 0,
          models: modelName ? [modelName] : [],
          preview: uc ? previewOf(uc.parsed_query) : '',
          user: uc ? userTextOf(uc.parsed_query) : '',
          references: Array.isArray(ev.json.references) ? ev.json.references : [],
          agentName: ev.json.agent_name || '',
          tools: 0, toolNames: {},
          finished: false, aborted: false, err: false, status: '',
          doneTs: 0,
        };
        data.turns.push(turn);
      } else if (ev.handler === 'PLAN') {
        // 归到该 session 内最新一个未 finished 的 turn（即最近一个 metadata 之后的轮）
        const tn = ev.json.toolCallName;
        if (!tn) continue; // 思考/计划项，不算工具
        const turn = lastOpenTurn(data, sid);
        if (!turn) continue; // 没有 metadata 就有 plan，异常，丢
        turn.tools++;
        turn.toolNames[tn] = (turn.toolNames[tn] || 0) + 1;
        if (ev.ts && ev.ts > turn.lastTs) turn.lastTs = ev.ts;
      } else if (ev.handler === 'DONE') {
        // 收轮：标该 session 内最新一个未 finished 的 turn
        const turn = lastOpenTurn(data, sid);
        if (!turn) continue;
        turn.finished = true;
        turn.doneTs = ev.ts || 0;
        const st = ev.json.status;
        if (st === 'canceled') turn.aborted = true;
        else if (st && st !== 'completed') turn.err = true;
        if (st) turn.status = st;
        if (ev.ts && ev.ts > turn.lastTs) turn.lastTs = ev.ts;
      }
      // TITLE 事件体只有 sessionId，没带 title 正文，忽略
    }
    files.set(key, { agent, kind, m, s, off: newOff, data });
    markKind(kind);
    // 增量 emit：已 emit 过的 turn 也可能因新事件变化，重发最后一个（与 codearts 同款）
    emitTraeTurns(agent, kind, fp, data, Math.max(0, data.emitted - 1));
    data.emitted = data.turns.length;
  } catch {}
  return true;
}

// 找该 session 内最新一个未 finished 的 turn（用于把 plan/done 事件归到正确的轮）
function lastOpenTurn(data, sid) {
  for (let i = data.turns.length - 1; i >= 0; i--) {
    const t = data.turns[i];
    if (t.sid === sid && !t.finished) return t;
  }
  return null;
}

function emitTraeTurns(agent, kind, fp, data, fromIdx) {
  const idBase = traeIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const project = projectOf(t.references);
    const dur = Math.max(0, (t.doneTs || t.lastTs) - t.firstTime);
    // entry id = `tc#<filepath>#<sessionId>#<seq>`，src.turn = `<sessionId>#<seq>`
    const turnKey = t.sid + '#' + t.seq;
    addEntry(idBase + turnKey, {
      agent, project, session: t.sid,
      time: t.firstTime, dur,
      status: t.err ? 'error' : (t.aborted ? 'canceled' : 'ok'),
      tin: 0, tout: 0, tcache: 0, total: 0, // renderer.log 不含 token 用量
      ctx: 0, rounds: null, tools: t.tools, calls: 1, // 每轮一次 LLM 调用（metadata 即开始）
      models: t.models, preview: t.preview, name: t.agentName || '', nollm: false,
      finished: t.finished, aborted: t.aborted,
      toolNames: { ...t.toolNames },
    }, { file: fp, turn: turnKey, kind });
  }
}

// logs 根目录扫描：枚举 <timestamp>/window1/renderer.log
function scanTraeLogs(agent, kind, root, onlyFile) {
  const tses = listDirCached(root);
  if (!tses) return;
  for (const ts of tses) {
    const tsDir = path.join(root, ts);
    if (!isDir(tsDir)) continue;
    const w1 = path.join(tsDir, 'window1');
    if (!isDir(w1)) continue;
    const names = listDirCached(w1);
    if (!names) continue;
    for (const n of names) {
      if (n !== 'renderer.log') continue;
      const fp = path.join(w1, n);
      if (onlyFile && fp !== onlyFile) continue;
      scanTraeRendererFile(agent, kind, fp, onlyFile);
    }
  }
}

// 两个独立 kind 的入口：路径由 server 通过 conf.sessions 注入
export function scanTraecode(agent, root, onlyFile) { scanTraeLogs(agent, 'tracecode', root, onlyFile); }
export function scanTraework(agent, root, onlyFile) { scanTraeLogs(agent, 'tracework', root, onlyFile); }

// 详情页内容：从 renderer.log 重新提取指定 turn（sid#seq）的全部事件
export function traeEntryContent(src, full) {
  if (!src || !src.file) return null;
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null;
  let lines;
  try { lines = fs.readFileSync(src.file, 'utf8').split('\n'); } catch { return null; }
  // src.turn = `<sessionId>#<seq>`
  const parts = String(src.turn).split('#');
  const sid = parts[0];
  const seq = parseInt(parts[1], 10);
  const out = {
    user: '', assistant: '', tools: [], calls: [],
    v: version,
    note: 'TraeCode/TraeWork 的 renderer.log 只记录事件元数据（用户提问、工具调用名、结束状态），'
          + '不含 AI 输出正文与 token 用量（流式 SSE 走内存不落地，token 计费在后端）'
          + '——只能给出这一份事件流水。',
  };
  let metaCount = 0; // 该 session 内已经数到第几个 metadata
  let inTargetTurn = false; // 是否已进入目标 turn（目标 metadata 已出现、下一个同 sid metadata 还没来）
  for (const line of lines) {
    const ev = parseLine(line);
    if (!ev || !ev.json) continue;
    const curSid = ev.json.sessionId || ev.json.session_id;
    if (curSid !== sid) continue;
    if (ev.handler === 'META') {
      // 进入新的一轮：如果目标 turn 还在进行中，遇到下一个 metadata 表示该轮结束
      if (inTargetTurn) break;
      if (metaCount === seq) {
        // 进入目标 turn
        inTargetTurn = true;
        const uc = ev.json.user_message_context;
        if (uc) {
          out.user = userTextOf(uc.parsed_query);
          if (!out.user) {
            const q = uc.query;
            if (typeof q === 'string') {
              try {
                const qb = JSON.parse(q);
                if (Array.isArray(qb)) {
                  const texts = qb
                    .filter(b => b && b.type === 'text' && b.data && typeof b.data.content === 'string')
                    .map(b => b.data.content);
                  if (texts.length) out.user = texts.join('\n');
                }
              } catch {}
            }
          }
          const mi = uc.model_info;
          if (mi) {
            const mn = mi.display_model_name || mi.model_name || mi.config_name;
            if (mn) out.calls.push({
              model: mn, tin: 0, tout: 0, tcache: 0, dur: 0,
              note: 'renderer.log 不含逐次 token 用量',
            });
          }
        }
      }
      metaCount++;
    } else if (ev.handler === 'PLAN' && inTargetTurn) {
      const tn = ev.json.toolCallName;
      if (!tn) continue;
      const pid = ev.json.planItemId;
      out.tools.push({
        name: tn, tid: pid || null, ts: ev.ts,
        input: '(调用入参不落地)', inputTrunc: false,
        output: '(工具返回不落地)', outputTrunc: false, error: null,
      });
    } else if (ev.handler === 'DONE' && inTargetTurn) {
      const st = ev.json.status;
      if (st === 'canceled') out.aborted = true;
      else if (st && st !== 'completed') out.err = true;
      if (out.tools.length) out.tools[out.tools.length - 1].status = st;
      break; // 该轮结束，跳出循环
    }
  }
  return out;
}
