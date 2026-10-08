// ---------------- comate 解析器（百度 Comate / comate-kernel，.comate-engine/store 会话库） ----------------
// 首次接入（2026-09-24）。真源是 ~/.comate-engine/store/（本机 Windows 实测；IDE 侧
// %APPDATA%\Comate 是 Electron 壳，只有 state.vscdb 索引指针，不是会话正文）：
//   comate_chat_sessions.jsonl        会话索引（每次变更追加一行，同 uuid 多条、取最新）
//   chat_session_<uuid>               会话正文，**整份 JSON 原地重写**（不是逐行追加！）
//   blobs/chat_session_<uuid>.d/      工具输出大对象的 blob（正文里以 {"$blob":"sha256:…"} 占位）
//   <工作区名>-<hash>/                按工作区隔离的小件（recentSkills 等，与轮次无关）
//
// 因此扫描走 cursor/gemini 同一路数：**整份重解析 + {mtime,size} 签名跳过没变的文件**，
// 不进 OFF_KINDS（没有字节偏移可续读 —— 文件被整个重写，off 语义不存在）。
//
// 会话文件结构（v2 实测）：{ sessionUuid, title, ctime, utime, workspaceDirectory, messages[] }。
// 一轮 = 一条 user 消息（payload.query 是用户输入，requestedAt 是轮起点毫秒）+ 它后面那条
// assistant 消息（用 userMessageId 回指）。assistant 的 elements[] 是一棵两层的树：
//   顶层节点（无 type）= 一次「模型往返」，metrics.duration 是这段耗时；
//     children = REASON（思考，不落详情）/ TEXT（正文片段）/ TOOL（工具调用）。
// tokenUsage 只有 contextUsed / contextLimit（上下文占用与容量），**没有**逐次 input/output ——
// 全 store 目录里 token 形状的键只有 tokenUsage 与 firstTokenLatency 两个，旁边 log/ 里搜到的
// 「token」全是 accessToken / semanticTokens 之类（凭证与 LSP 能力位），没有请求用量。
// 与 cursor 同样的处境：tin/tout 写 0、calls/rounds 写 null —— 页面那栏据此留空（`—`），不印假 0。
// 轮耗时取 assistant.completedAt（epoch 毫秒）减轮首；⚠️ elements 上的 lastModifiedTime/startTime
// 也是 epoch、metrics.duration 才是时长 —— 两个单位混过一次，卡片上就出现过 56 年的耗时（见 collectElements）。
// 源里另有两条本轮不用的：performanceMetrics.firstTokenLatency（TTFT，卡片没有渲染位、要它得先落 events[]）、
// tokenUsage.needCompression（本机实测三条全 true，更像「此刻需要压缩」的状态位而不是「压缩发生过几次」，
// 拿去点 compacts 会造出「每轮都压缩」的假账）。
// 模型名在 user 消息 payload.model（displayName 可读名 + modelId），逐轮各异，取轮自己的。
import fs from 'node:fs';
import path from 'node:path';
import { files, srcs, entries, removedIds, sorted, addEntry, listDirCached, isDir, toText, trunc, toolNameCounts } from './shared.mjs';

const COMATE_NO_USAGE_NOTE = 'Comate 的会话文件只记上下文占用（contextUsed/contextLimit），没有逐次 input/output token，'
  + '卡片那一栏留空（—）是「源里没有」，不是解析缺口；上下文占用取该轮结束时 assistant 消息上那份（会话级口径）。';

// 会话状态 → 轮状态。cancelled（用户打断）/ inProgress（进行中）/ success。
// failed / 其它未知值一律当 error，不做假设。
function comateTurnStatus(st) {
  if (st === 'cancelled') return { aborted: true, finished: true, err: false };
  if (st === 'inProgress') return { aborted: false, finished: false, err: false };
  if (st === 'success') return { aborted: false, finished: true, err: false };
  return { aborted: false, finished: true, err: true };
}

// 从 assistant 消息的 elements 树里收正文（TEXT 节点）与工具（TOOL 节点，含入参/输出/错误）。
// toolState：executed / executing / pending / failed —— 非 executed 的输出是空的，如实保留。
// ⚠️ 返回的是**两个不同单位**的量，别再混进一个变量（这里曾经错过一次）：
//   durSum   —— 轮内各顶层节点 metrics.duration 之和，是**时长**（毫秒）
//   endEpoch —— 元素上 lastModifiedTime / startTime 的最大值，是**时间戳**（epoch 毫秒）
// 轮耗时由调用方按「completedAt → endEpoch → time + durSum」的优先级算，见 comateSessionFile。
function collectElements(msg) {
  const texts = [], tools = [];
  let durSum = 0, endEpoch = 0;
  for (const top of msg.elements || []) {
    const dur = Number(top?.metrics?.duration) || 0;
    if (dur > 0) durSum += dur;   // 顶层节点顺序相接，耗时累加 ≈ 轮内时间推进
    for (const el of (top.children || [top])) {
      const type = el.type || '';
      if (type === 'TEXT') {
        const t = String(el.content || '').trim();
        if (t) texts.push(t);
      } else if (type === 'TOOL') {
        const r = el.result || {};
        tools.push({
          name: el.toolName || '?', tid: el.id || null,
          input: trunc(el.params ?? {}, true), inputTrunc: false,
          output: trunc(r.output ?? '', true), outputTrunc: false,
          error: el.toolState && el.toolState !== 'executed' ? (el.toolState) : null,
          dur: Number(el?.metrics?.duration) || 0,
        });
      }
      // REASON（思考过程）与其余未知类型不落详情，与其它 agent 口径一致
      const st0 = Number(el.lastModifiedTime) || Number(el.startTime) || 0;
      if (st0 > endEpoch) endEpoch = st0;
    }
  }
  return { text: texts.join('\n\n---\n\n'), tools, durSum, endEpoch };
}

// 解析一份会话文件 → { sessionId, title, project, turns[] }。轮序 = user 消息序。
function comateSessionFile(fp) {
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const sessionId = j.sessionUuid || path.basename(fp).replace(/^chat_session_/, '');
  const turns = [];
  // assistant 消息用 userMessageId 回指所属轮：先按 id 建索引，扫到 user 时直接取配对
  const byUser = new Map();
  for (const m of j.messages || []) if (m.role === 'assistant' && m.userMessageId) byUser.set(m.userMessageId, m);
  for (const m of j.messages || []) {
    if (m.role !== 'user') continue;
    const query = String(m.payload?.query ?? m.content ?? '');
    if (!query.trim()) continue;          // 空注入不开轮
    const a = byUser.get(m.id);
    const time = Number(m.requestedAt) || Number(j.ctime) || 0;
    const st = comateTurnStatus(a ? a.status : 'inProgress');
    const col = a ? collectElements(a) : { text: '', tools: [], durSum: 0, endEpoch: 0 };
    // 轮末时刻三档（都在**同一单位 epoch 毫秒**上比，谁都不许当时长用）：
    //   ① assistant.completedAt —— 源里写的本轮收尾时刻，真值；
    //   ② 元素上的 lastModifiedTime/startTime 最大值 —— 只在它确实晚于轮首时采信；
    //   ③ 轮首 + Σ metrics.duration —— 前两档都没有时，用「各段时长之和」推一个末点。
    // 三档全落空（进行中/被打断，压根没收尾）→ 末点就是轮首，dur = 0，页面显「—」，
    // 而不是拿 epoch 当耗时倒出一个 56 年的数字（本机实测错值：dur=1790222269956ms）。
    const completedAt = Number(a?.completedAt) || 0;
    const end = completedAt > time ? completedAt
      : (col.endEpoch > time ? col.endEpoch : (col.durSum > 0 ? time + col.durSum : time));
    const mdl = m.payload?.model || {};
    const model = mdl.displayName || mdl.modelId || '';
    const usage = a?.tokenUsage || {};
    turns.push({
      session: sessionId, ord: turns.length,
      user: query.slice(0, 3000), preview: query.replace(/\s+/g, ' ').slice(0, 300),
      assistant: col.text, tools: col.tools,
      time, lastTs: Math.max(end, time),
      tin: 0, tout: 0, tcache: 0, nTools: col.tools.length, nCalls: 0,
      models: model ? [model] : [],
      ctx: Number(usage.contextLimit) || 0, ctxUsed: Number(usage.contextUsed) || 0,
      ...st,
    });
  }
  return { sessionId, title: String(j.title || ''), project: String(j.workspaceDirectory || ''), turns };
}

function emitComateTurns(agent, key, data, prevData) {
  const idBase = 'C#' + key.replace(/[\\/:]/g, '~') + '#';
  const ids = new Set();
  for (let i = data.turns.length - 1; i >= 0; i--) {
    const t = data.turns[i];
    const id = idBase + t.session + '#' + t.ord;
    ids.add(id);
    entries.delete(id); srcs.delete(id);   // 先删后插：重扫新增的轮不会漂到列表末尾（同 cursor）
    addEntry(id, {
      agent, project: data.project || '(未知项目)', session: t.session,
      name: data.title,
      time: t.time, dur: Math.max(0, t.lastTs - t.time),
      status: t.err ? 'error' : 'ok',
      tin: 0, tout: 0, tcache: 0, total: 0,
      ctx: t.ctx || 0, ctxUsed: t.ctxUsed || null,
      rounds: null, calls: null,        // LLM 调用次数源里没有，不印假 0（同 cursor）
      tools: t.nTools, finished: !!t.finished, aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools), models: t.models, preview: t.preview,
    }, { file: key, turn: i, kind: 'comate' });
  }
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

// root = ~/.comate-engine/store。会话正文是平铺的 chat_session_* 文件（无子目录）。
export function scanComate(agent, root) {
  for (const n of listDirCached(root) || []) {
    if (!n.startsWith('chat_session_')) continue;   // 索引 jsonl / blobs / <工作区>-<hash>/ 一律不碰
    const fp = path.join(root, n);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (!st.isFile()) continue;
    const key = 'comate:' + fp;
    const sig = st.mtimeMs + '|' + st.size;
    const prev = files.get(key);
    if (prev && prev.data?.sig === sig) continue;   // 整份重写式落盘：签名没变就一个字节都没变
    try {
      const r = comateSessionFile(fp);
      const data = { sig, project: r.project, title: r.title, rev: (prev?.data?.rev || 0) + 1, turns: r.turns };
      files.set(key, { agent, kind: 'comate', m: st.mtimeMs, s: st.size, off: 0, data });
      emitComateTurns(agent, key, data, prev?.data);
    } catch (e) { console.error('[comate]', n, e.message); }
  }
}

// 详情：重读会话文件按 src.turn 切（与扫描同一份解析，口径天然一致）。
// 工具输出截断：full=0 时 800 字（与其它 agent 的详情口径一致），full=1 全量。
const COMATE_DETAIL_TRUNC = 800;
export function comateEntryContent(src, full) {
  const fstate = files.get(src.file);
  let r;
  try { r = comateSessionFile(src.file.slice('comate:'.length)); } catch (e) {
    return { user: '', assistant: '', tools: [], calls: [], v: null, note: '会话文件读取失败：' + e.message };
  }
  const t = r.turns[src.turn];
  if (!t) return null;
  const tools = (t.tools || []).map(x => {
    const fi = {}, fo = {};
    return {
      name: x.name, tid: x.tid, error: x.error, dur: x.dur || 0,
      input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
      output: full ? x.output : (typeof x.output === 'string' ? x.output.slice(0, COMATE_DETAIL_TRUNC) : x.output),
      outputTrunc: !full && typeof x.output === 'string' && x.output.length > COMATE_DETAIL_TRUNC,
    };
  });
  return {
    user: t.user, assistant: t.assistant, tools, calls: [],
    callsNote: COMATE_NO_USAGE_NOTE,
    v: 'C' + (fstate?.data?.rev || 0),
  };
}

export { toText };
