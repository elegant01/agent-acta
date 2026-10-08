// ---------------- minimax 解析器（Mavis 本地运行时：~/.minimax/v2/sessions/.../messages.jsonl） ----------------
// 落盘：
//   ~/.minimax/v2/sessions/YYYY/MM/DD/<HH-MM-SS-mmm-session_<base64-id>>/
//     ├─ messages.jsonl      ← 主源（逐行追加，OFF 增量语义与 claude/doubao 同）
//     ├─ manifest.json       ← sessionId / createdAtMs / layout（=v2-final-dated-session）
//     ├─ history-catalog.json（activeRevision / artifacts[]，目前只起版本校验作用）
//     ├─ user-message-locators.jsonl（每条 user 消息的字节定位，目前不进解析）
//     └─ llm-call.json       ← **聚合**的系统提示/工具 schema 一次性快照（不是逐次调用日志），
//                            但带 maxTokens —— context 窗口容量（ctx 分母）就从这里取
//
// 每行 messages.jsonl（一行 = 一条消息，Anthropic 风格）：
//   {"message_id":"msg-...","turn_id":"<uuid>","message":{...}}
//   其中 message 才是消息体，**所有字段都挂在 message 里**（这是真库实测、与想象不同之处）：
//     message.role = "user" | "assistant" | "toolResult" | "custom"
//     message.content = [...]（user/assistant 是 [{type:"text"|"thinking"|"toolCall", ...}]）
//     message.timestamp = 毫秒（user/assistant/toolResult 都有；custom 也有）
//     message.api / message.provider / message.model / message.responseId（仅 assistant 带）
//     message.usage = {input,output,cacheRead,cacheWrite,totalTokens,cost}（**仅 assistant 带**；
//       ⚠️ input **不含** cache：真库 95/95 行恒有 totalTokens = input+output+cacheRead+cacheWrite，
//       且 93/95 行 input < cacheRead（如 input=652 / cacheRead=107410），hermes 那套
//       「input 含 cache、tin = input − cacheRead」的假设在 minimax 上**不成立**）
//     message.stopReason = "toolUse"|"endTurn"|"stop"|...（**仅 assistant 带**）
//     message.toolCallId / message.toolName / message.isError / message.details（**仅 toolResult 带**；
//       isError 真库实测存在（bash 失败行），会进轮状态，见下）
//     message.customType / message.display（**仅 custom 带**）：系统注入消息
//       （实测 customType="todo_cadence_reminder"、display=false、content 是字符串），
//       不进正文、不开轮，但**不能静默丢弃**（会更新 lastTs、在详情 callsNote 留痕）
//   ⚠️ 顶层 message_id / turn_id / message 之外**没有** usage/model/stopReason —— 解析器一律从
//      message 取，不能从顶层 j 取（早期版本误读顶层 → 全部 token/model 落空，见 scanMavis/mavisEntryContent）。
//
//   user 行的 content 是 [{type:"text",text:"..."}]，首行常带 <system-reminder> 块：用户正文
//     用 stripReminder 截到提醒块之后；提醒块没出现 → 整段当用户正文。
//   assistant 行的 content 同时可含 {type:"thinking",thinking:...} / {type:"toolCall",id,name,arguments}：
//     thinking 累到轮内 text（页面 md 渲染与正文同列），toolCall 累到工具表，toolCall.arguments 为对象。
//   toolResult 行（message.role==="toolResult"）的 message.content 是 [{type:"text",text:"..."}]，
//     按 message.toolCallId 回填上一条 assistant 的 toolCall 的 output（与 OpenAI 系同语义）。
//
// 轮口径：message.role==="user" 开新轮（同一 turn_id 内的 user + 多轮 assistant + toolResult 都归本轮），
// 下一条 user 收轮。每轮的 time / dur / status / 用量按「轮窗口内的 assistant 行 usage 求和」摊派（与 hermes 同款）。
// ⚠️ 同 turn_id 内多次调用的 usage 一律按 assistant 行**聚合**：input **不含** cache
//    （真库恒等式 totalTokens = input + output + cacheRead + cacheWrite，95/95 行成立），
//    所以 tin = input 直接取、tcache = cacheRead；上下文占用 = 轮内最后一次 assistant 的 input。
// 失败轮：① assistant 的 stopReason 非 toolUse/endTurn/stop；② toolResult 的 isError=true
//    （真库实测存在，bash 失败行）—— 两种都记 err，详情侧 callsNote 提示。
import fs from 'node:fs';
import path from 'node:path';
import {
  files, entries, addEntry, markKind, listDirCached, isDir, isFile,
  toText, trunc, readCompleteLines,
} from './shared.mjs';

// ---------------- 入口候选根（一个日期文件夹对应一个会话） ----------------
// minimax 的 v2 会话目录是有日期前缀的：v2/sessions/YYYY/MM/DD/<HH-MM-SS-mmm-session_<id>>/
// 同一 v2/sessions 根下可能横跨多天（v2/sessions/2026/09/20 与 v2/sessions/2026/09/21 同在）。
// 扫描入口以「会话根」为单位，循环向 YYYY/MM/DD 下探一层。
//
// 这个下探只发生在 scanMavis 内部：sniffBase 已经把 base 修到 v2/sessions（由 candidateBases /
// discovery.mjs 里的 candidateBases 分支兜底，见 discovery.mjs 的 minimax 注释），下面再细探。
//
// 子目录名形如 `07-49-21-725-session_<base64-id>`：识别只看 basename 是否以 `session_` 开头，
// 时间戳前缀是装饰、不靠它排序（同一分钟内多开两个会话就分不出先后；所以轮顺序按文件内消息序号）。
function mavisSessionDirs(root) {
  const out = [];
  if (!isDir(root)) return out;
  // 第一层：YYYY（最多 6 年份）
  for (const y of (listDirCached(root) || []).slice(0, 6)) {
    const yDir = path.join(root, y);
    if (!isDir(yDir) || !/^\d{4}$/.test(y)) continue;
    // 第二层：MM
    for (const m of (listDirCached(yDir) || []).slice(0, 12)) {
      const mDir = path.join(yDir, m);
      if (!isDir(mDir) || !/^\d{2}$/.test(m)) continue;
      // 第三层：DD
      for (const d of (listDirCached(mDir) || []).slice(0, 31)) {
        const dDir = path.join(mDir, d);
        if (!isDir(dDir) || !/^\d{2}$/.test(d)) continue;
        // 第四层：HH-MM-SS-mmm-session_<id>
        for (const s of (listDirCached(dDir) || []).slice(0, 80)) {
          if (!/^[\d-]+-session_/.test(s)) continue;
          const sd = path.join(dDir, s);
          if (isDir(sd)) out.push(sd);
        }
      }
    }
  }
  return out;
}

// 用户文本清理——剥掉行首自动注入的 system-reminder（常见：首条 user 内容里嵌了一整段 xml）。
// 不剥的话预览就会是「跳了一大段提醒块 + 几十字真用户输入」，搜索/筛选体验很差。
// 严格策略：必须以 <system-reminder> 开头、且以 </system-reminder> 收尾；其余情况原样保留。
function stripReminder(text) {
  if (typeof text !== 'string') return text;
  const t = text.trimStart();
  if (!t.startsWith('<system-reminder>')) return text;
  const close = t.indexOf('</system-reminder>');
  if (close < 0) return text;          // 没找到收尾标签 → 不剥（残缺 reminder 比错剥更安全）
  return t.slice(close + '</system-reminder>'.length).replace(/^\s+/, '');
}

// 从 content 数组里抽 text（与 doubao 的 toText 同款：数组 → 逐项 .text；字符串 → 原样）。
// thinking 文本不进 userText（只进 assistant 文本），避免详情头部把模型思考混进用户列。
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

// 用户消息正文（I8 复现包原始片段提取复用）：与扫描侧 role==='user' 的开轮判定同一套口径——
// 空文本不开轮、剥完 system-reminder 是空也不开轮。返回非空文本即「这一行是开轮行」。
export function mavisUserText(content) {
  const rawText = contentText(content, /*dropThinking*/ true);
  if (!rawText) return '';
  const text = stripReminder(rawText);
  return text ? text : '';
}

// 数字规整（与 hermes 同款）
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function usageTin(u) {
  if (!u) return 0;
  // minimax 的 usage.input **不含** cache（真库实测：totalTokens = input+output+cacheRead+cacheWrite
  // 95/95 行成立，且 input 常远小于 cacheRead，如 input=652 / cacheRead=107410）。
  // hermes 那套「input 含 cache → tin = input - cacheRead」是**另一个库的口径**，照抄会把
  // 真实输入砍掉 80%+（79 次调用的轮：真实 105,196 → 旧口径 18,513）。tin 直接取 input。
  return num(u.input);
}

// 探测一个 messages.jsonl 是否真属于 minimax 格式。
// sniffBase 用它防「空目录 / 别名目录被认成 minimax 而一条都扫不出」。
// 只读头 2KB（首行 JSON 通常 < 256B，CJK 累 3 字节，单行常落在 4KB 之内）。
//
// ⚠️ 真库实测：每行都是 {"message_id":...,"turn_id":...,"message":{role,content,...}}，
// 而 usage/model/stopReason 这些**只在 assistant 行**的 message 里出现、user 行没有。
// 会话首行永远是 user 消息 → 首行绝不可能带着 usage/model。所以判据不能要求「首行含 usage/model」，
// 否则每个真实会话都会被认成 false、自动发现整体失效。正确判据：含 message_id + message.role
// 取 Anthropic 风格三态之一（user/assistant/toolResult），与 usage/model 无关。
export function isMavisMessages(fp) {
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    if (n <= 0) return false;
    const head = buf.toString('utf8', 0, n);
    const firstBrace = head.indexOf('{');
    const firstLineEnd = head.indexOf('\n');
    if (firstBrace < 0 || firstLineEnd < 0 || firstLineEnd <= firstBrace) return false;
    const firstLine = head.slice(firstBrace, firstLineEnd);
    return /"message_id"\s*:/.test(firstLine)
        && /"message"\s*:\s*\{\s*"role"\s*:\s*"(user|assistant|toolResult)"/.test(firstLine);
  } finally { try { fs.closeSync(fd); } catch {} }
}

// 嗅探一个目录是否含 minimax 会话，并返回**解析出的 v2/sessions 根**（由 discovery.mjs 的 sniffBase 调用）。
// 返回：能认出 minimax 就返回「会话根目录」字符串（后续 scanMavis 直接拿它下探），否则返回 null。
// 三种命中形态：
//   1) 自己就是会话目录（含 messages.jsonl + manifest.json + isMavisMessages） → 返回自己
//   2) 自己是 v2/sessions 根，下探四层命中 session_<id> → 返回自己
//   3) 自己是 ~/.minimax 应用根（顶层有 v2/ 子目录）→ 返回 <base>/v2/sessions（真库实测：会话数据在这）
// 形态 3 是真实摆法：candidateBases 铺出的 ~/.minimax 顶层只有 v2/ 与配置/缓存，没有 messages.jsonl，
// 必须一路指到 v2/sessions 才能让 scanMavis 扫到；否则 sniffBase 会把 ~/.minimax 兜底认成 atomcode。
export function hasMavisSession(base) {
  if (!isDir(base)) return null;
  // 形态 A：自己就是会话目录
  const fpSelf = path.join(base, 'messages.jsonl');
  if (isFile(fpSelf) && isFile(path.join(base, 'manifest.json')) && isMavisMessages(fpSelf)) return base;
  // 形态 C：应用根下的 v2/sessions（优先——真库数据都在这）
  const v2 = path.join(base, 'v2', 'sessions');
  if (isDir(v2) && mavisSessionsRoot(v2)) return v2;
  // 形态 B：自己就是 v2/sessions 根，下面任意深度≤4 命中一个会话目录
  if (mavisSessionsRoot(base)) return base;
  return null;
}

// 判断一个「候选 v2/sessions 根」下面有没有真实会话目录（四层 y/m/d/session_<id>）。
function mavisSessionsRoot(root) {
  if (!isDir(root)) return false;
  for (const y of (listDirCached(root) || []).slice(0, 6)) {
    const yDir = path.join(root, y);
    if (!isDir(yDir) || !/^\d{4}$/.test(y)) continue;
    for (const m of (listDirCached(yDir) || []).slice(0, 12)) {
      const mDir = path.join(yDir, m);
      if (!isDir(mDir) || !/^\d{2}$/.test(m)) continue;
      for (const d of (listDirCached(mDir) || []).slice(0, 31)) {
        const dDir = path.join(mDir, d);
        if (!isDir(dDir) || !/^\d{2}$/.test(d)) continue;
        for (const s of (listDirCached(dDir) || []).slice(0, 80)) {
          if (!/^[\d-]+-session_/.test(s)) continue;
          const sd = path.join(dDir, s);
          if (isDir(sd)) return true;
        }
      }
    }
  }
  return false;
}

// id 前缀：mvs-session_<base64-id> 里的 base64 可能含 `/` 与 `+`，所以用「把路径哈希化」做 key
// （doubao 的 idBase 是同样的「路径 → 唯一字符串」法）。会话目录路径已是「唯一标识」，无需 hash。
export function mavisIdBase(sessionDir) {
  return 'mv#' + sessionDir.replace(/[\\/:]/g, '~') + '#';
}

// manifest 解析（取 createdAtMs 当会话起始时间；sessionId 写到 entry 的 session 字段，调试向日追溯）
function readManifest(sessionDir) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir, 'manifest.json'), 'utf8')); }
  catch { return null; }
}

// context 窗口容量（ctx 分母）：同目录 llm-call.json 的 maxTokens（真库实测 128000）。
// 它是「聚合快照」不是逐次调用日志（拿不到逐次耗时），但 maxTokens 是现成的容量口径 ——
// 页面据此画「占用 / 窗口」进度条；取不到才留 0（页面退化为只显示占用）。
function readCtxWindow(sessionDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sessionDir, 'llm-call.json'), 'utf8'));
    const n = Number(j && j.maxTokens);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

// ---------------- emit：把一轮的数据落成 entry ----------------
// 轮字段（与 hermes 同款语义，但写得更紧——minimax 的 usage 现成、不必等旁路日志凑）：
//   time      首条 user 消息的 timestamp（毫秒）
//   dur       endTs - time；endTs = 轮内最后一条 assistant/toolResult 的 timestamp
//   status    err?'error':'ok'，按 stopReason != 'toolUse' 且 stopReason != null 当 ok
//   tin/tout/tcache/total  轮内 assistant usage 之和
//   ctx       = 同目录 llm-call.json 的 maxTokens（窗口容量；取不到 → 0，页面不画进度条）
//   ctxUsed   轮内最后一次 assistant 的 usage.input（不含 cache；页面拿来画占用进度条）
//   rounds    = calls（一轮 = 一条 user；calls = assistant 行数）
//   tools     轮内 toolCall 计数
//   models    轮内去重后的 model 名
//   preview   首条 user 文本截前 300 字符
//   finished  i < turns.length - 1；最后一轮由页面按 lastTs 兜底（同 doubao）
//   aborted   仅按 stopReason 字面量认；aborted 字面量没见到，恒 false（不编造）
function emitTurns(agent, sessionDir, data, fromIdx) {
  const base = mavisIdBase(sessionDir);
  const sid = data.manifest?.sessionId || path.basename(sessionDir);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(base + t.idx, {
      agent,
      project: data.project,
      session: sid,
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : 0,
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: data.win || 0,       // 窗口容量来自同目录 llm-call.json 的 maxTokens（取不到 → 0）
      ctxUsed: t.ctxUsed || 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: false,
      toolNames: t.toolNames,
    }, { file: data.fp, turn: t.idx, kind: 'minimax' });
  }
}

// ---------------- 扫描主入口 ----------------
// root 通常是 v2/sessions 根；scanMavis 内部按 y/m/d/session-id 四层下探每个会话目录。
// 约定：root 下每多一层，都按 y(4) / m(2) / d(2) / session-id 走；不是这套的就跳过（不报错）。
//
// 单文件增量续读：每条 OFF_KINDS.jsonl 的标准做法（claude/doubao/kimi/codex 走 readCompleteLines）。
// messages.jsonl 的 usage 字段在每行里现成，所以不需要额外旁路（hermes 的 agent.log / doubao 的
// assignment.md 都不必打开）。
export function scanMavis(agent, root, onlyFile) {
  if (!isDir(root)) return;
  for (const sessionDir of mavisSessionDirs(root)) {
    const fp = path.join(sessionDir, 'messages.jsonl');
    if (!isFile(fp)) continue;
    if (onlyFile && fp !== onlyFile) continue;
    let fst; try { fst = fs.statSync(fp); } catch { continue; }
    const key = fp;
    const m = fst.mtimeMs, s = fst.size;
    const prev = files.get(key);
    if (prev && prev.m === m && prev.s === s) {
      // 没变 → 不重发条目（首扫时 prev.data 由 emitTurns 推过；这里只补一次已发条目）
      if (prev.data?.turns?.length && !entries.has(mavisIdBase(sessionDir) + (prev.data.turns.length - 1)))
        emitTurns(agent, sessionDir, prev.data, 0);
      continue;
    }
    const off = prev?.off || 0;
    const data = prev?.data || {
      turns: [], emitted: 0, session: path.basename(sessionDir),
      project: '', manifest: null, fp,
    };
    if (!data.manifest) data.manifest = readManifest(sessionDir);
    if (data.win === undefined) data.win = readCtxWindow(sessionDir);   // ctx 分母：llm-call.json maxTokens
    if (!data.project) {
      // 缺省项目名 = 会话目录的祖上 4 层（v2/sessions/YYYY/MM/DD）；同根所有会话共享同一项目，
      // 避免项目筛选下拉里冒出一长串「会话号 / 日期」项
      const ancestors = sessionDir.split(path.sep);
      data.project = ancestors.slice(0, Math.max(0, ancestors.length - 4)).join(path.sep) || '(minimax)';
    }
    if (s <= off) { files.set(key, { agent, kind: 'minimax', m, s, off, data }); markKind('minimax'); continue; }
    try {
      const rd = readCompleteLines(fp, off, s);
      if (!rd) { files.set(key, { agent, kind: 'minimax', m, s, off, data }); markKind('minimax'); continue; }
      const newOff = rd.newOff;
      for (const line of rd.lines) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        // ⚠️ 真库实测：每行都是 {message_id, turn_id, message:{...}}，usage/model/stopReason
        // 这些只在 assistant 行的 message 里；user / toolResult 行没有这些字段。
        // 所以 role 与所有用量/模型都从 `msg`（=j.message）取，不能从顶层 `j` 取。
        const msg = j.message || {};
        const role = msg.role || (msg.toolCallId ? 'toolResult' : null);
        if (!role) continue;
        if (role === 'user') {
          const rawText = contentText(msg.content, /*dropThinking*/true);
          if (!rawText) continue;          // 空用户消息不开轮（与 doubao / hermes 同款）
          const text = stripReminder(rawText);
          if (!text) continue;            // 剥完 reminder 是空 → 同样不开轮
          data.turns.push({
            idx: data.turns.length,
            time: num(msg.timestamp) || 0,
            lastTs: num(msg.timestamp) || 0,
            tin: 0, tout: 0, tcache: 0, ctxUsed: 0,
            calls: 0, tools: 0, models: [], err: false,
            custom: 0, customTypes: [],
            preview: text.replace(/\s+/g, ' ').slice(0, 300),
            toolNames: {},
          });
        } else if (role === 'assistant' && data.turns.length) {
          const cur = data.turns[data.turns.length - 1];
          cur.calls++;
          const ts = num(msg.timestamp) || 0;
          if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
          // usage 求和（多个 LLM 调用属于同一个 user → 同一轮）
          // minimax 的 usage 在 message.usage（不是顶层 j.usage）；input 不含 cache → tin 直接取
          const u = msg.usage;
          if (u) {
            const tin = usageTin(u);
            const tout = num(u.output);
            const tcache = Math.max(num(u.cacheRead), num(u.cacheWrite));
            cur.tin += tin; cur.tout += tout; cur.tcache += tcache;
            cur.ctxUsed = num(u.input);    // 逐轮上下文 = 轮内最后一次 assistant 的 input（不含 cache）
          }
          if (msg.model && !cur.models.includes(msg.model)) cur.models.push(msg.model);
          // 失败判定：stopReason 既不是 toolUse（中间调用）也不是正常的 endTurn/stop 时记 err
          // （isError 的兜底在 toolResult 分支；两者都进同一门 err）
          const sr = msg.stopReason;
          if (sr && sr !== 'toolUse' && sr !== 'endTurn' && sr !== 'stop') cur.err = true;
          // 工具调用累积（minimax 的 toolCall.arguments 是对象，不是 JSON 字符串）
          const content = Array.isArray(msg.content) ? msg.content : [];
          for (const p of content) {
            if (!p || typeof p !== 'object') continue;
            if (p.type === 'toolCall') {
              const nm = typeof p.name === 'string' && p.name ? p.name : '?';
              cur.tools++;
              cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
            }
          }
        } else if (role === 'toolResult' && data.turns.length) {
          // toolResult：暂不参与轮统计（详情侧按 toolCallId 回填，扫描侧只标记有结果回来）
          // 这样不会重复计数 tools（toolCall 计数已在 assistant 行完成）。
          // toolResult 行的时间戳在 message.timestamp（不是顶层 j.timestamp）
          const ts = num(msg.timestamp) || 0;
          if (ts) {
            const cur = data.turns[data.turns.length - 1];
            cur.lastTs = Math.max(cur.lastTs, ts);
          }
          // isError=true（真库实测：bash 失败行）→ 该轮记 err。
          // 详情侧本来就会标红这个工具，但轮状态不记的话「列表一片 ok、点开才有红」，
          // 一个含失败工具的轮在列表里看着是健康的。
          if (msg.isError) data.turns[data.turns.length - 1].err = true;
        } else if (role === 'custom' && data.turns.length) {
          // custom（系统注入，实测 customType=todo_cadence_reminder / display=false / content 是字符串）：
          // 不开轮、不进正文，但**不静默丢弃** —— ① 更新 lastTs（否则提醒恰好落在轮尾会截断该轮 dur）；
          // ② 记数与类型进轮状态，详情侧 callsNote 留痕（"本轮含 N 条系统注入"）。
          const ts = num(msg.timestamp) || 0;
          const cur = data.turns[data.turns.length - 1];
          if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
          cur.custom = (cur.custom || 0) + 1;
          const ct = typeof msg.customType === 'string' && msg.customType ? msg.customType : 'custom';
          if (!cur.customTypes) cur.customTypes = [];
          if (!cur.customTypes.includes(ct)) cur.customTypes.push(ct);
        }
      }
      files.set(key, { agent, kind: 'minimax', m, s, off: newOff, data });
      markKind('minimax');
      emitTurns(agent, sessionDir, data, Math.max(0, data.emitted - 1));
      data.emitted = data.turns.length;
    } catch {}
  }
}

// ---------------- 详情：重读 messages.jsonl 按 src.turn 过滤 ----------------
// 开轮判定与扫描侧同一份（role=user 且文本非空）——天然对齐，不会出现「扫到这一轮、详情找不到」。
export function mavisEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + (st.off || 0) : null;
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  let turnIdx = -1;
  const out = {
    user: '', assistant: '', tools: [], calls: [],
    v: version,
    callsNote: 'minimax 转录（messages.jsonl）每行带 usage / model / stopReason：token 按行聚合' +
               '（tin = input 直接取——minimax 的 input 不含 cache，totalTokens = input+output+cacheRead+cacheWrite；tcache = cacheRead），' +
               '模型名 = assistant 行 model，轮耗时 = 下一轮 time − 本轮 time；' +
               'context 窗口容量取同目录 llm-call.json 的 maxTokens（取不到则只显示占用）；' +
               '逐次调用耗时源头不落盘（assistant 行无时长字段，llm-call.json 是聚合快照不是逐次日志），故 calls[].dur 恒为 0。',
  };
  const texts = [];
  let lastStopReason = '';
  let lastModel = '';
  // 本轮 custom（系统注入）消息的计数与类型 —— 不开轮、不进正文，只在 callsNote 留痕
  let customCount = 0;
  const customTypes = [];
  // 收集 assistant 行的 toolCall 入参（arguments 是对象），按 toolCallId 索引，
  // 回填到对应的 toolResult 详情（toolResult 行本身不含入参，只有出参）。
  const callArgs = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    // ⚠️ 真库实测：toolResult 的 toolCallId / toolName / content / isError 都在 message 里
    // （顶层只有 message_id / turn_id / message）。role 与所有工具字段都从 msg 取。
    const msg = j.message || {};
    const role = msg.role || (msg.toolCallId ? 'toolResult' : null);
    if (!role) continue;
    if (role === 'user') {
      const rawText = contentText(msg.content, true);
      const text = rawText ? stripReminder(rawText) : '';
      if (!text) continue;
      turnIdx++;
      if (turnIdx === src.turn) out.user = text;
      continue;
    }
    if (turnIdx !== src.turn) continue;
    if (role === 'assistant') {
      // 文本：thinking + 散落 text 都拼起来（页面 md 渲染），与扫描侧对应
      const text = contentText(msg.content, /*dropThinking*/false);
      if (text) texts.push(text);
      // usage / model / stopReason 都在 message 里（不是顶层 j）
      const u = msg.usage;
      if (msg.stopReason) lastStopReason = msg.stopReason;
      if (msg.model) lastModel = msg.model;
      const call = {
        model: msg.model || lastModel || '',
        tin: u ? usageTin(u) : 0,
        tout: u ? num(u.output) : 0,
        tcache: u ? Math.max(num(u.cacheRead), num(u.cacheWrite)) : 0,
        dur: 0,
      };
      if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
      const tcs = Array.isArray(msg.content) ? msg.content.filter(p => p && p.type === 'toolCall') : [];
      if (tcs.length) call.tools = tcs.map(t => t.name || '?');
      for (const tc of tcs) if (tc.id) callArgs[tc.id] = tc.arguments;  // 入参按 id 暂存
      out.calls.push(call);
    } else if (role === 'toolResult') {
      // toolCallId / toolName / content / isError 都在 message 里
      const tcid = msg.toolCallId || '';
      // 找上一条 assistant 行里同 id 的 toolCall；找不到就先暂存，等下一条 assistant 再补
      // （scan 端 toolCall 计数以 assistant 行为准；详情侧要保证输出在正确 tool 上）
      const t = out.tools.find(x => x.tid === tcid) || (() => {
        // 还没建：建一个最小占位
        const ph = { name: msg.toolName || '?', tid: tcid, error: null, input: '', inputTrunc: false, output: '', outputTrunc: false };
        out.tools.push(ph);
        return ph;
      })();
      if (t.input === '' && callArgs[tcid] !== undefined) {
        const fi = {}; t.input = trunc(JSON.stringify(callArgs[tcid]), full, fi); t.inputTrunc = !!fi.t;
      }
      const cArr = Array.isArray(msg.content) ? msg.content : [];
      const txt = cArr.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
      const fo = {}; t.output = trunc(txt || toText(msg.content), full, fo); t.outputTrunc = !!fo.t;
      if (msg.isError) t.error = 'error';
    } else if (role === 'custom') {
      // custom（系统注入，如 todo_cadence_reminder）：不进正文、不开轮，只留痕（与扫描侧同一口径）
      customCount++;
      const ct = typeof msg.customType === 'string' && msg.customType ? msg.customType : 'custom';
      if (!customTypes.includes(ct)) customTypes.push(ct);
    }
    if (turnIdx > src.turn) break;
  }
  // assistant 文本里若没有 toolCall 文本，前面已经拼好；若 toolResult 在 user 之前到达（畸形）也不会错位
  out.assistant = texts.join('\n\n---\n\n');
  if (lastStopReason && lastStopReason !== 'toolUse' && lastStopReason !== 'endTurn' && lastStopReason !== 'stop') {
    out.callsNote += ' 本轮 stopReason=' + lastStopReason + '（非正常收尾）。';
  }
  if (customCount) {
    out.callsNote += ' 本轮含 ' + customCount + ' 条系统注入消息（custom：' + customTypes.join(', ') +
                     '，display=false 由运行时自动插入，不进正文）。';
  }
  return out;
}

// sniffBase 与 candidateBases 见 discovery.mjs；这里只负责解析。