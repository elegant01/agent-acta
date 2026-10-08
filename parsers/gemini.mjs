// ---------------- gemini 解析器（~/.gemini/tmp/<项目slug>/） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanGemini。
// 两个数据源，同一个会话只取一处（有会话文件的以它为准，其余回落到提示词流水）：
//
//   1) chats/session-<时间>-<短id>.jsonl —— **新版 CLI（2026-09 起）的会话正文**，一行一条记录。
//      逐行解析见 geminiSessionFile；消息里：
//        type=user   → {id,timestamp,content:[{text}]} 开一轮
//        type=gemini → 一次 LLM 调用：{content(字符串正文), tokens{input,output,cached,thoughts,tool,total},
//                                     model, toolCalls[{id,name,args,result,status}]}（工具结果内联在调用上）
//        type=info / error → 非 LLM（"Request cancelled." 之类）跳过；error 表示该轮失败
//   2) logs.json —— 整目录一份的提示词流水 [{sessionId,messageId,type:'user',message,timestamp}]。
//      它**只有提示词**，没有 token / 模型 / 回复正文，只用来兜住「会话文件已经不在」的那些老会话
//      （有会话文件的会话由上面的 covered 集合让位）。这类条目给 name='(无用量记录)'
//      （沿用前端既有的「小括号=无信息」标记习惯），不当成没数据而不收。
//
// ⚠ 历史教训：这里原先写的是「新版 CLI 不再落 chats/」，那是 2026-04 前后观察到的**临时状态** ——
//   2026-09 的新版 CLI 其实会落，只是把格式从单份 `.json` 换成了 `.jsonl`，而扫描只 glob `session-*.json`，
//   于是一整个新版会话都读不到、全部回落到 logs.json，表现就是「全是无用量记录、也没有模型」。
//   **老的单份 `.json` 支持已按需求删除**，现在只认 `.jsonl`。
//
// 不收 chats/<父会话短id>/<子会话id>.json：那是子代理（codebase_investigator 等）的完整轨迹，
// 单个 6MB 且 prompt 是内部指令而非用户请求，与「用户请求日志」的目标不符。
//
// token 口径：total = input + output + thoughts（+tool），且 input 含缓存 → tin = input - cached，
// tout = output + thoughts + tool（thoughts 与 output 同价，别漏）。与 claude/buddy 的 tin 口径一致。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, srcs, removedIds, sorted, addEntry, toolNameCounts, listDirCached, isDir } from './shared.mjs';

const GEMINI_CMD_RE = /^[/!]/;            // '/model' '/quit' '/exit' 这类 CLI 命令不算一次请求
// CLI 注入的 <session_context>（工作区目录树那一大坨）**不是用户说的话**，不能开轮：
// 实测新版每条会话的第 1 条 user 消息就是它，而**下一条才是用户真正敲的**，
// 不滤掉就会多出一个假条目 —— 时间是会话开始时刻、没有模型也没有 token、
// preview 是几百行目录树（比真正的提问还长，排在列表里特别显眼）。
// 只认开头的标签：正文里出现这四个字（比如用户就在讨论它）不算。
const GEMINI_CTX_RE = /^<session_context>/;
const GEMINI_CLI_TITLE = '(无用量记录)';   // logs.json 只有提示词，没有用量可报

export function geminiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (typeof b === 'string' ? b : String(b?.text || ''))).join('\n');
}

export function geminiUsage(tokens) {
  const t = tokens || {};
  const cached = t.cached || 0;
  return { tin: Math.max(0, (t.input || 0) - cached), tout: (t.output || 0) + (t.thoughts || 0) + (t.tool || 0), tcache: cached };
}

// 工具结果内联在 toolCalls[i].result 里，形如 [{functionResponse:{response:{output}}}]（也可能是纯字符串）
function geminiToolOutput(tc) {
  const parts = [];
  const push = v => { if (v == null) return; const s = typeof v === 'string' ? v : JSON.stringify(v); if (s) parts.push(s); };
  if (Array.isArray(tc.result)) {
    for (const x of tc.result) {
      if (x == null) continue;
      if (typeof x === 'string') { push(x); continue; }
      const fr = x.functionResponse?.response;
      if (fr && fr.output != null) push(fr.output);
      else if (fr) push(fr);
      else if (x.text) push(x.text);
      else push(x);
    }
  } else push(tc.result);
  const s = parts.join('\n');
  if (s) return s;
  return typeof tc.resultDisplay === 'string' ? tc.resultDisplay : ''; // 对象型 resultDisplay（子代理进度）不当正文
}

// 项目名：<slug>/.project_root 最准（CLI 自己写的），退回 <base>/projects.json 反查，再退回 slug 本身
let geminiProjMap = null;
function geminiProject(slugDir, slug, root) {
  try {
    const s = fs.readFileSync(path.join(slugDir, '.project_root'), 'utf8').trim();
    if (s) return s;
  } catch {}
  try {
    const mf = path.join(path.dirname(root), 'projects.json');
    const st = fs.statSync(mf);
    if (!geminiProjMap || geminiProjMap.m !== st.mtimeMs) {
      const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const map = {};
      for (const [p, s] of Object.entries(j.projects || {})) map[s] = p;
      geminiProjMap = { m: st.mtimeMs, map };
    }
    if (geminiProjMap.map[slug]) return geminiProjMap.map[slug];
  } catch {}
  return slug;
}

function geminiTurn(text0, sid, time, title) {
  return {
    user: text0, assistant: '', tools: [], callList: [],
    time, lastTs: time, dur: 0, tin: 0, tout: 0, tcache: 0, nCalls: 0, nTools: 0,
    models: [], err: false, session: sid, title,
    preview: text0.replace(/\s+/g, ' ').slice(0, 300),
  };
}

// 会话文件（`session-*.jsonl`，一行一条记录，三种行）：
//   1) 第 1 行 = 会话头 {sessionId, projectHash, startTime, lastUpdated, kind}
//   2) 消息行   = 完整消息对象 {id, timestamp, type, content, tokens, model, toolCalls}（与老格式同形）
//   3) 补丁行   = {"$set":{…}}，字段整体替换。实测出现过的键：messages / lastUpdated / summary
//                 （lastUpdated 每来一条消息就跟着来一行，与本解析无关，直接跳过）
//
// 两个**实测出来**的要点，都不直观：
//   · **同一个 id 会重复出现**：同一轮的消息先落一条简版、随后再落一条更全的
//     （实测第 5/7 行同 id，后一条多了 toolCalls）。所以按 id 收进 Map —— 后到的覆盖先到的；
//     而 Map.set 对已存在的键**不改变插入位置**，天然保住「首次出现」的顺序。
//   · `$set.messages` 只在开头出现一次、长度为 1（初始化用）。真出现就按整体替换处理，
//     与「消息逐行追加」并不冲突。
//
// 老格式（单份 JSON、messages 挂在顶层）已按需求**停止支持**：新版 CLI 只落 .jsonl。
function geminiSessionFile(fp) {
  const msgs = new Map();
  let head = null, title = '';
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; } // 追加写可能留半行
    if (!j) continue;
    if (j.$set) {
      const sm = j.$set.messages;
      if (Array.isArray(sm)) { msgs.clear(); for (const x of sm) if (x && x.id) msgs.set(x.id, x); }
      if (typeof j.$set.summary === 'string') title = j.$set.summary.slice(0, 60);
      continue;
    }
    if (j.id) { msgs.set(j.id, j); continue; }   // 消息行：同 id 后到者更全 → 覆盖，顺序不变
    if (j.sessionId) head = j;                   // 第 1 行的会话头
  }
  const sessionId = String((head && head.sessionId) || path.basename(fp, '.jsonl'));
  const turns = [];
  for (const m of msgs.values()) {
    const ts = m.timestamp ? Date.parse(m.timestamp) || 0 : 0;
    if (m.type === 'user') {
      const text0 = geminiText(m.content).trim();
      if (!text0 || GEMINI_CMD_RE.test(text0) || GEMINI_CTX_RE.test(text0)) continue; // 空/命令/上下文注入不开轮（扫描与详情同口径）
      turns.push(geminiTurn(text0, sessionId, ts, title));
      continue;
    }
    const cur = turns[turns.length - 1];
    if (!cur) continue;
    if (m.type === 'info') continue;
    if (m.type === 'error') { cur.err = true; if (ts) cur.lastTs = Math.max(cur.lastTs, ts); continue; }
    if (m.type !== 'gemini') continue;
    const u = geminiUsage(m.tokens);
    cur.tin += u.tin; cur.tout += u.tout; cur.tcache += u.tcache;
    cur.nCalls++;
    const model = m.model || '';
    if (model && !cur.models.includes(model)) cur.models.push(model);
    const txt = geminiText(m.content).trim();
    // 一轮里多次 LLM 调用各自可能带正文，逐段保留（同 atomcode 的多 round 处理）
    if (txt) cur.assistant = cur.assistant ? cur.assistant + '\n\n---\n\n' + txt : txt;
    // text = **这一次**调用自己产出的正文。gemini 的正文与用量同在一条记录上，
    // 是各家里唯一一上手就能按调用切开的（claude/codebuddy 要按 messageId 回填）。
    const call = {
      model, tin: u.tin, tout: u.tout, tcache: u.tcache,
      dur: ts && cur.lastTs ? Math.max(0, ts - cur.lastTs) : 0,
      text: txt || '',
    };
    // 同一条记录里的工具调用就属于这一次调用，不用像 claude/codebuddy 那样回填。
    // 没有工具的那几次不建空数组（这份 callList 是**常驻内存**的，空数组会白占）。
    if (m.toolCalls && m.toolCalls.length) {
      call.tools = m.toolCalls.map(tc => tc.name || tc.displayName || '?');
    }
    cur.callList.push(call);
    for (const tc of m.toolCalls || []) {
      cur.tools.push({
        name: tc.name || tc.displayName || '?', tid: tc.id || null,
        input: JSON.stringify(tc.args ?? ''), output: geminiToolOutput(tc),
        // 状态缺失不算错（旧记录没有 status 字段）；只有明确非成功才标红
        error: tc.status && tc.status !== 'success' && tc.status !== 'completed' ? String(tc.status) : null,
      });
      cur.nTools++;
    }
    if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
  }
  for (const t of turns) t.dur = Math.max(0, t.lastTs - t.time);
  return { sessionId, turns };
}

// 一个项目 slug = 一份状态（key 是 slug 目录）。目录里任何文件变了就整份重解析：会话文件是一次性重写的
// 整份 JSON，没有 jsonl 那种增量偏移；logs.json 也就几百 KB，全量重解析比维护偏移可靠。
// 条目 id 按 sessionId 派生（g#<sessionId>#<轮序>），所以重解析是原地覆盖而不是灌重复条目。
export function scanGemini(agent, root) {
  for (const slug of listDirCached(root) || []) {
    const dir = path.join(root, slug);
    if (!isDir(dir)) continue;
    try { scanGeminiSlug(agent, dir, slug, root); } catch (e) { console.error('[gemini]', slug, e.message); }
  }
}

function scanGeminiSlug(agent, dir, slug, root) {
  const chatsDir = path.join(dir, 'chats');
  const chatFiles = [];
  for (const n of listDirCached(chatsDir) || []) {
    // 只认新版 CLI 的 .jsonl（老的单份 .json 已停用）；子目录里的子代理轨迹不收
    if (!n.startsWith('session-') || !n.endsWith('.jsonl')) continue;
    const fp = path.join(chatsDir, n);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.isFile()) chatFiles.push([fp, st]);
  }
  const logsPath = path.join(dir, 'logs.json');
  let lst = null;
  try { const st = fs.statSync(logsPath); if (st.isFile()) lst = st; } catch {}
  const key = 'gemini:' + dir;
  const sig = chatFiles.map(([fp, st]) => fp + '|' + st.mtimeMs + '|' + st.size).join(';') +
    '||' + (lst ? lst.mtimeMs + '|' + lst.size : '-');
  const prev = files.get(key);
  if (prev && prev.data.sig === sig) return; // 内容没变：本轮不重解析（stat 量级，3s 一轮无压力）
  const project = geminiProject(dir, slug, root);
  const turns = [];
  const covered = new Set(); // 有会话文件的会话：logs.json 里同一句提示词不再重复计
  for (const [fp] of chatFiles) {
    try {
      const r = geminiSessionFile(fp);
      // 轮序按会话内从 0 数（不是 slug 内累计）：新增一个会话文件不会让别人的 id 漂移
      r.turns.forEach((t, k) => { t.ord = k; turns.push(t); });
      if (r.sessionId) covered.add(r.sessionId);
    } catch (e) { console.error('[gemini] parse', path.basename(fp), e.message); }
  }
  if (lst) {
    try {
      const arr = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      for (let i = 0; Array.isArray(arr) && i < arr.length; i++) {
        const e = arr[i];
        if (!e || e.type !== 'user') continue;
        const sid = String(e.sessionId || '');
        if (covered.has(sid)) continue;
        const text0 = geminiText(e.message).trim();
        if (!text0 || GEMINI_CMD_RE.test(text0)) continue;
        const ts = e.timestamp ? Date.parse(e.timestamp) || 0 : 0;
        const t = geminiTurn(text0, sid, ts, GEMINI_CLI_TITLE);
        t.ord = Number.isFinite(e.messageId) ? e.messageId : i; // 直接用文件里的轮序，最稳
        turns.push(t);
      }
    } catch (e) { console.error('[gemini] logs', slug, e.message); }
  }
  const data = { sig, project, rev: (prev?.data?.rev || 0) + 1, turns };
  files.set(key, { agent, kind: 'gemini', m: 0, s: 0, off: 0, data });
  emitGeminiTurns(agent, key, project, data, prev?.data);
}

function emitGeminiTurns(agent, key, project, data, prevData) {
  const idBase = 'g#' + key.slice(7).replace(/[\\/:]/g, '~') + '#';
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = idBase + t.session + '#' + t.ord;
    ids.add(id);
    addEntry(id, {
      agent, project, session: t.session,
      time: t.time, dur: t.dur || Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      ctx: 0, rounds: t.nCalls, tools: t.nTools, calls: t.nCalls, // 同 claude：rounds=calls=轮内 LLM 调用数
      models: t.models, preview: t.preview, name: t.title || null,
      finished: !!t.finished || i < data.turns.length - 1, aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools),
    }, { file: key, turn: i, kind: 'gemini' });
  });
  // 会话文件后到 / 被覆盖掉的 logs.json 条目要撤掉，否则会和新条目并存（同一句提示词出现两次）
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}
