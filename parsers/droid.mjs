// ---------------- droid 解析器（Factory Droid CLI：~/.factory/sessions/<cwd 转义>/<会话 id>.jsonl） ----------------
// 落盘摆法（2026-10-14 拿真件核实，本机 = C:\Users\4399\.factory）：
//   <home>/.factory/sessions/<cwd 转义>/<会话 id>.jsonl        ← **主源**（追加式会话转录，本文件只读它）
//   <home>/.factory/sessions/<cwd 转义>/<会话 id>.settings.json ← 会话账本（**整份重写**，见口径④）
//   <home>/.factory/sessions/<cwd 转义>/<会话 id>.settings.json.bak ← 上一次重写的备份，**必须排除**
//   <home>/.factory/{logs,cache,state,certs,droids,plugins,prem-auth,telemetry} ← 都不是会话源
// 那一层目录名 = **会话的 cwd 把 `:` 与路径分隔符一律换成 `-`**（实测 `F:\centos\agentLog\agent-acta`
// → `-F-centos-agentLog-agent-acta`）。它是**可逆**的，但项目名不靠它反解 —— 用首行 `header.cwd`。
// 与 pi（`--<cwd 编码>--`）同族、与 crush 同档（每个项目一层），所以「每项目一层」的先例照抄。
//
// 转录逐行（一行一个事件，只见到这三类 + 未知类型忽略）：
//   {"type":"session_start","id","title","owner","version":2,"cwd","hostId",
//    "isSessionTitleManuallySet","sessionTitleAutoStage"}                      ← 头（首行）
//   {"type":"message","id","parentId","timestamp","seq","message":{…}}          ← 对话消息
//   {"type":"agent_turn_outcome","turnId","reason","resultKind"}                ← 轮末（**每轮一条**）
// message 是 Anthropic 形状（工具调用/返回都是内容块，不另立角色）：
//   user       {role:"user", content:[{type:"text"|"tool_result"}], visibility?, interactionMode?}
//   assistant  {role:"assistant", content:[{type:"thinking"|"text"|"tool_use"}],
//               modelId, openaiMessageId, reasoningEffort, chatCompletionReasoningField?, chatCompletionReasoningContent?}
//   thinking 块 = {type:"thinking", thinking, signature, signatureProvider, durationMs}
//   tool_use 块 = {type:"tool_use", id, name, input:{…}}（input 是对象）
//   tool_result 块 = {type:"tool_result", tool_use_id, is_error, content}  ← **挂在 role:"user" 行里**
//
// ⚠️ 口径①（开轮）：真实用户输入 = `role:"user"` **且** 该 message **没有** `visibility` 字段
//   **且** content 里有非空 text 块。三条缺一就错：
//     · `visibility:"both"` —— droid 自己往转录里塞的告警正文（实测那条 provider 提示就是这种）；
//     · `visibility:"llm_only"` —— 一组 `<system-reminder>`（工具清单/技能/子 agent/系统信息/日期…，
//       实测一轮里 6 条），它只喂模型、不是用户说的话；
//     · 工具返回也挂 `role:"user"` 且没有 visibility —— 靠「非空 text 块」这条挡住（tool_result 行里
//       没有 text 块），与 cline / qwen 的「看 role 就把一次工具调用切成一轮」同源。
// ⚠️ 口径②（**逐轮 token 源头不可得**）：`.jsonl` 里 assistant 行**一个 usage 字段都没有**（实测键全集
//   = role,content,openaiMessageId,chatCompletionReasoningField,chatCompletionReasoningContent,modelId,
//   reasoningEffort），`.settings.json` 也只有 `tokenUsage`（会话累计）+ `lastCallTokenUsage`（**只留末次
//   调用**、每轮覆写）+ `inclusiveTokenUsage`/`childInclusiveTokenUsageBySessionId`（含子 agent 的合计）。
//   ⇒ 每轮 tin/tout/tcache/total/ctx/ctxUsed **一律如实 0**（crush / doubao 那一档）。
//   不拿会话累计冒充某一轮，也不拿「末次快照」贴到末轮 —— 那是个会随下一轮整体挪走的数，
//   老条目里留下的就是把 A 轮的数记在 B 轮头上。累计与末次只在详情 note 里如实给。
// ⚠️ 口径③（失败）：工具失败**只逐项**看 tool_result 的 `is_error === true`，写进详情 tools[].error，
//   **不把整轮染红** —— 真件实测那一轮先有两条 is_error:true（模型试 bash / wsl 失败），第三条成功、
//   答案也对；拿它当轮失败就是假警报（同 crush / devindb 的逐项取舍）。轮级失败信号源里**没有**：
//   assistant 行不带 stopReason，`agent_turn_outcome.reason` 本机只见过 `"completed"`，值域未明 ⇒
//   status 一律 ok、aborted 一律 false，不拿没摸清的值域推状态。
// ⚠️ 口径④（时长与文件枚举）：轮时间取行级 `timestamp`（**ISO 字符串**，不是毫秒数）；会话工作时长取
//   `.settings.json.assistantActiveTimeMs`，**别拿文件 mtime 差**（`.settings.json` 整份重写会把
//   一批文件的 mtime 拍平，同 buddyext 那条教训）。枚举只认 `*.jsonl`，`.settings.json` 与 `.bak` 都不算会话。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, markKind, listDirCached, isDir, isFile, toText, trunc, readCompleteLines } from './shared.mjs';

export const DROID_STATE_DIRNAMES = ['.factory'];   // <home>/.factory —— FACTORY_HOME_OVERRIDE 可整体改写

// 读首行（判据与 header 补读都用它）。只读头 2KB：首行是 session_start，必在最前。
function firstLine(fp) {
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return ''; }
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    if (n <= 0) return '';
    const head = buf.toString('utf8', 0, n);
    const end = head.indexOf('\n');
    return end < 0 ? head : head.slice(0, end);
  } finally { try { fs.closeSync(fd); } catch {} }
}

// 一个文件是不是 droid 转录：首行必须是会话头（type:"session_start" + version + id）。
// ⚠️ 这条**内容**判据是 discovery 抢在 atomcode 兜底之前认下 ~/.factory 的依据 ——
//   ~/.factory 下面还有 logs/ cache/ state/ 那些邻居目录，名字猜错不能把别家的数据接走。
export function isDroidTranscript(fp) {
  const line = firstLine(fp);
  if (!line) return false;
  try {
    const j = JSON.parse(line);
    return !!j && j.type === 'session_start' && j.version !== undefined && typeof j.id === 'string';
  } catch { return false; }
}

// base 可能是 ~/.factory、sessions 根本身、甚至某个 <cwd 转义> 项目目录 —— 都认（手工添加时用户就这么填）。
// ⚠️ 返回的 root 是**会话根本身**（不是 .factory）：FACTORY_HOME_OVERRIDE / FACTORY_PROFILE_DIR 能把
//    这棵树整个挪走，主文件因此要把 droid 记进 ROOT_SESSIONS_AGENTS（对它取 dirname 重嗅会爬到上层邻居目录）。
// 结构指纹：一个目录确实是 droid 的数据根，但**还没聊过天**（sessions 是空的）。
// 实测必须挡在这一层：装了 droid 没用它时，~/.factory 里只有 settings.json + sessions/(空) + logs/ +
// state/ + droids/，sniffBase 若只认内容判据就会让 **atomcode 兜底把 ~/.factory 接走**，
// 侧栏凭空多一个假 agent 行（与 dsh / kimi / openclaw / cline / pi 当初同源的那个静默故障，
// 只是这次反过来 —— 不是我们 0 条，而是别人冒充我们）。
// 要 siblings 里至少一项**只有 droid 才有**的（droids/ 与 prem-auth/ 是它的目录，
// logs/droid-log-single.log 是它的日志名），不是「任意 sessions/」。
function isDroidHomeShell(base) {
  if (!isDir(base) || !isDir(path.join(base, 'sessions'))) return false;
  return isDir(path.join(base, 'droids')) || isDir(path.join(base, 'prem-auth'))
    || isFile(path.join(base, 'logs', 'droid-log-single.log'));
}

export function droidTranscripts(base) {
  if (!isDir(base)) return null;
  const cands = [
    path.join(base, 'sessions'),   // ~/.factory 或直接给的 HOME 根
    base,                          // 会话根直接给
  ];
  // 手工填到**项目目录**那一层时，转录是平铺在它下面的（不是「根 → 项目目录 → 转录」那三层），
  // 上面的候选都扫不到 —— 此时会话根是它的父目录（与 pi 认 --<cwd>-- 单层同一处理）。
  if (fs.readdirSync(base).some(n => n.endsWith('.jsonl') && isDroidTranscript(path.join(base, n)))) {
    cands.push(path.dirname(base));
  }
  for (const root of [...new Set(cands)]) {
    if (!root || !isDir(root)) continue;
    const out = scanTranscriptFiles(root);
    if (out.length) return { root, files: out };
  }
  // 一条转录都没有，但结构指纹对得上 ⇒ 认下来，files 留空（用户聊第一句就有了，不必重启）
  if (isDroidHomeShell(base)) return { root: path.join(base, 'sessions'), files: [] };
  return null;
}

// root = 会话根（下面每个 <cwd 转义> 一个项目）。项目目录最多认 200 个、每个 400 份，
// 只为「别在嗅探上失控」，不是产品上限。
function scanTranscriptFiles(root) {
  const out = [];
  for (const dn of (listDirCached(root) || []).slice(0, 200)) {
    const projDir = path.join(root, dn);
    if (!isDir(projDir)) continue;
    for (const fn of (listDirCached(projDir) || []).slice(0, 400)) {
      if (!fn.endsWith('.jsonl')) continue;   // ⚠️ 口径④：.settings.json 与 .bak 都不算会话
      const fp = path.join(projDir, fn);
      if (!isFile(fp) || !isDroidTranscript(fp)) continue;
      out.push({ fp, projectDir: dn, sessionId: fn.replace(/\.jsonl$/, '') });
    }
  }
  return out;
}

// 供 confAvailable / 自动发现用：会话根下能枚举出转录就算可用
export function hasDroidSessions(root) { return scanTranscriptFiles(root).length > 0; }

export function droidIdBase(fp) { return 'droid#' + fp.replace(/[\\/:]/g, '~') + '#'; }

// ---------------- 会话账本（隔壁同名 .settings.json） ----------------
// 整份重写 ⇒ 按 {mtime,size} 缓存；读不出来就返回 null（详情照常，只是少一段 note）。
// 只取数字与模型名，**providerLock / providerLockTimestamp 一律不碰**（那是它的内部凭证锁，不是用量）。
const _statCache = new Map();
export function droidSessionStats(fp) {
  const sp = fp.replace(/\.jsonl$/, '.settings.json');
  let st; try { st = fs.statSync(sp); } catch { return null; }
  const c = _statCache.get(sp);
  if (c && c.m === st.mtimeMs && c.s === st.size) return c.out;
  let out = null;
  try {
    const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
    out = {
      model: typeof j.model === 'string' ? j.model : '',
      reasoningEffort: j.reasoningEffort || '',
      autonomyLevel: j.autonomyLevel || '',
      activeMs: Number(j.assistantActiveTimeMs) || 0,
      total: j.tokenUsage && typeof j.tokenUsage === 'object' ? j.tokenUsage : null,
      inclusive: j.inclusiveTokenUsage && typeof j.inclusiveTokenUsage === 'object' ? j.inclusiveTokenUsage : null,
      lastCall: j.lastCallTokenUsage && typeof j.lastCallTokenUsage === 'object' ? j.lastCallTokenUsage : null,
      childSessions: Object.keys(j.childInclusiveTokenUsageBySessionId || {}).length,
    };
  } catch { out = null; }
  _statCache.set(sp, { m: st.mtimeMs, s: st.size, out });
  return out;
}

// ---------------- 正文与用量小工具 ----------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// user 正文：只吃 text 块（tool_result 不在内）。I8 复现包与扫描侧共用这一个函数，
// 两边轮序号才不会错位。
export function droidUserText(content) {
  if (!Array.isArray(content)) return toText(content);
  const buf = [];
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) buf.push(b.text);
  return buf.join('\n\n');
}

// 开轮判据（⚠️ 口径①）：role==="user" + 无 visibility + 有非空 text 块。
// 扫描侧与详情侧、以及主文件的复现包分片（turnStartIdx）共用这一份，三处永远同判据。
export function droidIsUserPrompt(msg) {
  if (!msg || msg.role !== 'user' || msg.visibility !== undefined) return false;
  return !!droidUserText(msg.content);
}

// assistant 正文（text 块）；thinking 单独回给调用方挂到 calls[].thinking，不混进正文列。
function droidAssistantText(content) {
  if (!Array.isArray(content)) return toText(content);
  const buf = [], th = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) buf.push(b.text);
    else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) th.push(b.thinking);
  }
  return { text: buf.join('\n\n'), thinking: th.join('\n\n') };
}

// ---------------- emit：把一轮落成 entry ----------------
// ⚠️ 口径②：tin/tout/tcache/total/ctx/ctxUsed 一律 0 —— 源里没有逐轮用量，页面那一档就不印假数。
// finished = i < turns.length-1；最后一轮由页面按 lastTs 兜底（同 doubao / minimax / openclaw / pi）。
// 不设 rdur / compacts：转录里既没有产品自报的轮工作时间，也没有压缩事件行（只有 .settings.json 里那个
// compactionThresholdCheckEnabled 开关，不是发生过几次压缩的计数）。
function emitTurns(agent, fp, data, fromIdx) {
  const idBase = droidIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(idBase + t.idx, {
      agent,
      project: data.project,
      session: data.session,
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : 0,
      // 源里没有可信的轮失败信号（assistant 行无 stopReason，outcome 只见 "completed"）⇒ 一律 ok，
      // 逐项工具失败在详情 tools[].error 里给。不拿「没见过的字段」猜出 error 来。
      status: 'ok',
      tin: 0, tout: 0, tcache: 0, total: 0, ctx: 0, ctxUsed: 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: false,        // ⚠️ 口径③：没有可信的中断信号，不猜
      toolNames: t.toolNames,
    }, { file: fp, turn: t.idx, kind: 'droid' });
  }
}

// 会话头（首行）元数据补读：index 恢复、文件截断重来、首读落在 off>0 这三种情况都拿不到首行。
function readHeader(fp, data, line) {
  try {
    const h = JSON.parse(line === undefined ? firstLine(fp) : line || '');
    if (!h || h.type !== 'session_start') return false;
    if (typeof h.id === 'string' && h.id) data.sessionId = h.id;
    if (typeof h.cwd === 'string') data.cwd = h.cwd;
    if (typeof h.title === 'string' && h.title.trim()) data.title = h.title.trim();
    data.fmtVersion = num(h.version);
    return true;
  } catch { return false; }
}

// ---------------- 扫描主入口（OFF_KINDS：逐行 off 增量续读，语义与 claude / openclaw / pi 一致） ----------
// root = **会话根**（discovery 的 sniffBase 解析出来的那个，默认 ~/.factory/sessions，可被环境变量挪走）。
export function scanDroid(agent, root, onlyFile) {
  if (!isDir(root)) return;
  for (const dn of listDirCached(root) || []) {
    const projDir = path.join(root, dn);
    if (!isDir(projDir)) continue;
    for (const fn of listDirCached(projDir) || []) {
      if (!fn.endsWith('.jsonl')) continue;
      const fp = path.join(projDir, fn);
      if (onlyFile && fp !== onlyFile) continue;
      if (!isFile(fp)) continue;
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) {
        if (prev.data?.turns?.length && !entries.has(droidIdBase(fp) + (prev.data.turns.length - 1)))
          emitTurns(agent, fp, prev.data, 0);
        continue;
      }
      let off = prev?.off || 0;
      const data = prev?.data || {
        turns: [], emitted: 0, sessionId: '', session: '',
        cwd: '', project: '', title: '', fmtVersion: 0,
      };
      // 文件被截断（off 推到文件尾之后）：转录正常只追加，但导出/迁移会重写整份 —— 宁可整份重来。
      if (s < off) { off = 0; data.turns = []; data.emitted = 0; }
      if (s <= off) {
        if (!data.cwd) readHeader(fp, data);
        if (!data.sessionId) data.sessionId = fn.replace(/\.jsonl$/, '');
        if (!data.session) data.session = data.title || data.sessionId;
        if (!data.project) data.project = data.cwd || dn;
        files.set(key, { agent, kind: 'droid', m, s, off, data });
        markKind('droid');
        continue;
      }
      try {
        const rd = readCompleteLines(fp, off, s);
        if (!rd) { files.set(key, { agent, kind: 'droid', m, s, off, data }); markKind('droid'); continue; }
        if (off === 0 && rd.lines.length) readHeader(fp, data, rd.lines[0]);
        else if (!data.cwd) readHeader(fp, data);
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.type === 'session_start') continue;
          const cur = data.turns[data.turns.length - 1];
          // ---- 轮末事件：正文/用量都没有（⚠️ 口径③），只留原样供详情判读，并补一次轮末时间 ----
          if (j.type === 'agent_turn_outcome') {
            if (cur) { cur.outcome = { reason: j.reason || '', resultKind: j.resultKind || '' }; }
            continue;
          }
          if (j.type !== 'message') continue;   // 没见过的类型一律忽略（产品后续加类型时这里不会崩）
          const msg = j.message || {};
          const ts = Date.parse(j.timestamp) || 0;   // ⚠️ 口径④：行级 timestamp 是 ISO 字符串
          if (msg.role === 'user') {
            if (!droidIsUserPrompt(msg)) {
              // 工具返回行：扫描侧**一个信号都不取**。is_error 是逐项标记，真件实测那一轮里两条
              // is_error:true（bash/WSL 试错）后面跟着成功输出、答案也对 —— 拿它染红整轮就是假警报。
              // 逐项失败只在详情 tools[].error 里给（同 crush / devindb 的取舍），这里只补一次轮末时间。
              if (cur && ts) cur.lastTs = Math.max(cur.lastTs, ts);
              continue;
            }
            data.turns.push({
              idx: data.turns.length,
              time: ts,
              lastTs: ts,
              calls: 0, tools: 0, models: [],
              toolNames: {},
              preview: droidUserText(msg.content).replace(/\s+/g, ' ').slice(0, 300),
            });
          } else if (msg.role === 'assistant' && cur) {
            cur.calls++;
            if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
            if (msg.modelId) {
              const nm = String(msg.modelId);
              if (!cur.models.includes(nm)) cur.models.push(nm);
            }
            for (const b of (Array.isArray(msg.content) ? msg.content : [])) {
              if (!b || b.type !== 'tool_use') continue;
              const nm = typeof b.name === 'string' && b.name ? b.name : '?';
              cur.tools++;
              cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
            }
          }
        }
        if (!data.sessionId) data.sessionId = fn.replace(/\.jsonl$/, '');
        if (!data.session) data.session = data.title || data.sessionId;
        if (!data.project) data.project = data.cwd || dn;
        files.set(key, { agent, kind: 'droid', m, s, off: rd.newOff, data });
        markKind('droid');
        emitTurns(agent, fp, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}

// ---------------- 详情：重读转录按 src.turn 过滤 ----------------
// 开轮判定与扫描侧同一份（droidIsUserPrompt），天然对齐，不会出现「扫到这一轮、详情找不到」。
export function droidEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + (st.off || 0) : null;
  let lines;
  try { lines = fs.readFileSync(src.file, 'utf8').split('\n'); } catch { return null; }
  const out = {
    user: '', assistant: '', tools: [], calls: [], v: version,
    callsNote: 'droid 转录（~/.factory/sessions/<cwd 转义>/<会话 id>.jsonl）里 **assistant 行不带 usage**，'
      + '逐轮 token 源头不可得 ⇒ 每轮 tin/tout/tcache 如实 0（与 crush 同档，不拿会话累计冒充某一轮）。'
      + '工具调用是 assistant 里的 tool_use 块、工具返回挂在 role:"user" 的 tool_result 块里（逐项 is_error 只标这一条工具，不把整轮染红——真件里一轮有两条试错后面跟着成功回复）；'
      + 'droid 自己注入的告警与 <system-reminder> 都带 visibility 字段，已被开轮判据挡在外面、不算用户输入。',
  };
  const texts = [];
  let outcomeNote = '';
  let turnIdx = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session_start') continue;
    if (j.type === 'agent_turn_outcome') {
      if (turnIdx === src.turn) {
        const rs = [j.reason && 'reason=' + j.reason, j.resultKind && 'resultKind=' + j.resultKind].filter(Boolean).join(' ');
        if (rs) outcomeNote = ' 轮末事件：' + rs + '。';
      }
      continue;
    }
    if (j.type !== 'message') continue;
    const msg = j.message || {};
    if (msg.role === 'user') {
      if (!droidIsUserPrompt(msg)) {
        if (turnIdx === src.turn && Array.isArray(msg.content)) {
          // 工具返回按 tool_use_id 回填到它对应的那条 tool_use（同 doubao / openclaw 的 toolCallId 回填）
          for (const b of msg.content) {
            if (!b || b.type !== 'tool_result') continue;
            const t = out.tools.find(x => x.tid === b.tool_use_id);
            if (!t) continue;
            const fo = {};
            t.output = trunc(b.content, full, fo);
            t.outputTrunc = !!fo.t;
            if (b.is_error) t.error = 'error';
          }
        }
        continue;
      }
      turnIdx++;
      if (turnIdx === src.turn) out.user = droidUserText(msg.content);
      continue;
    }
    if (turnIdx !== src.turn) continue;
    if (msg.role === 'assistant') {
      const { text, thinking } = droidAssistantText(msg.content);
      if (text) texts.push(text);
      const call = { model: msg.modelId || '', tin: 0, tout: 0, tcache: 0, dur: 0 };
      if (thinking) call.thinking = trunc(thinking, full, {});
      const tcs = Array.isArray(msg.content) ? msg.content.filter(b => b && b.type === 'tool_use') : [];
      if (tcs.length) call.tools = tcs.map(t => (typeof t.name === 'string' && t.name) || '?');
      for (const tc of tcs) {
        // tool_use 块的 durationMs 在 thinking 上，工具本身不计时 ⇒ dur 留 0（不编数）
        const fi = {};
        const args = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {});
        out.tools.push({
          name: (typeof tc.name === 'string' && tc.name) || '?', tid: tc.id || null, error: null,
          input: trunc(args, full, fi), inputTrunc: !!fi.t, output: '', outputTrunc: false,
        });
      }
      out.calls.push(call);
    }
    if (turnIdx > src.turn) break;
  }
  out.assistant = texts.join('\n\n---\n\n');
  if (outcomeNote) out.callsNote += outcomeNote;
  // 会话级账本（真件里唯一存在的用量数字）：如实标成「会话累计」，不摊到轮上。
  const ss = droidSessionStats(src.file);
  if (ss) {
    const t = ss.total || {}, lc = ss.lastCall || {};
    const parts = [];
    if (ss.total) parts.push('累计 input ' + num(t.inputTokens) + ' / output ' + num(t.outputTokens)
      + ' / cacheRead ' + num(t.cacheReadTokens) + ' / cacheWrite ' + num(t.cacheCreationTokens)
      + ' / thinking ' + num(t.thinkingTokens));
    if (ss.lastCall) parts.push('末次调用 input ' + num(lc.inputTokens) + ' / output ' + num(lc.outputTokens)
      + ' / cacheRead ' + num(lc.cacheReadTokens) + '（这个数每轮被覆写，只对最后一次调用有效）');
    if (ss.inclusive && ss.childSessions) parts.push('含 ' + ss.childSessions + ' 个子会话的合计 input '
      + num(ss.inclusive.inputTokens) + ' / output ' + num(ss.inclusive.outputTokens));
    if (ss.activeMs) parts.push('会话工作时长 ' + ss.activeMs + 'ms（assistantActiveTimeMs）');
    if (ss.model) parts.push('模型 ' + ss.model + (ss.reasoningEffort ? ' / reasoning ' + ss.reasoningEffort : '')
      + (ss.autonomyLevel ? ' / autonomy ' + ss.autonomyLevel : ''));
    if (parts.length) out.callsNote += ' 会话账本（.settings.json）：' + parts.join('；') + '。';
  }
  return out;
}
