// ---------------- pi 解析器（Pi Coding Agent：<agentDir>/sessions/--<cwd 编码>--/<时间>_<uuid>.jsonl） ----------------
// agentDir 默认 ~/.pi/agent（PI_CODING_AGENT_DIR 可整体改写；Windows 与 mac/Linux 同），摆法：
//   <agentDir>/sessions/--F--centos-piSample--/2026-10-12T01-47-06-049Z_<uuid>.jsonl  ← **主源**（本文件只读它）
//   <agentDir>/models.json      ← 用户自定义 provider/模型（含 contextWindow）
//   <agentDir>/models-store.json ← pi 自己缓存的各家目录（provider → models[].contextWindow）
//   <agentDir>/auth.json        ← 密钥/OAuth，**绝不读**（会话源里没有任何凭证，读它没有意义）
// 目录名的编码规则（源码 session-manager.ts 的 encodeCwd）：去掉前导分隔符，把 `/ \ :` 一律换成 `-`，
// 前后各补一个 `--`。⇒ 名字本身在 Windows 上有歧义（F:-centos 与 F/centos 撞），项目名**只取首行 header.cwd**。
//
// 主源是**追加式会话树**（docs/session-format.md + dist/core/session-manager.d.ts 核实），逐行 JSON：
//   {"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"…"}   ← 头（唯一没有 parentId 的行）
//   {"type":"message","id","parentId","timestamp","message":{…}}                 ← 对话消息（唯一带正文的类型）
//   {"type":"model_change","provider","modelId"} / {"type":"thinking_level_change","thinkingLevel"}
//   {"type":"usage","kind","provider","model","usage","note?"}   ← **不进上下文**的用量（kind="cache_warm" 等）
//   {"type":"compaction","summary","firstKeptEntryId","tokensBefore","usage?","details","fromHook","systemMessage"}
//   {"type":"branch_summary","fromId","summary","usage?","details","fromHook"}
//   {"type":"context_edit","targetId","replacement"}  ← 把早先某条目从**后续上下文**里摘掉/替换，原条目不动
//   {"type":"custom","customType","data"} / {"type":"custom_message",…} / {"type":"label","targetId","label"}
//   {"type":"session_info","name"}                    ← /name 起的会话标题
// message 是 llm-core 的 AgentMessage（与 openclaw 同源，三种角色形状一致）：
//   user       {role:"user", content: string | [{type:"text",text}], timestamp}
//   assistant  {role:"assistant", content:[{type:"text"|"thinking"|"toolCall"}], api, provider, model,
//               usage, stopReason, timestamp, responseId, rawStopReason, durationMs, thinkingLevel}
//   toolResult {role:"toolResult", toolCallId, toolName, content:[…], isError, timestamp}   ← **每条一个条目行**
//   toolCall 块 = {type:"toolCall", id, name, arguments:{…}}（arguments 是对象，不是 JSON 字符串）
//   usage = {input, output, cacheRead, cacheWrite, cacheWrite1h, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}
//   stopReason 是 camelCase："toolUse" | "stop" | "length" | "error" | "aborted"（rawStopReason 才是上游原值）
//
// ⚠️ 口径一：**input 不含 cache**（与 openclaw 同侧，与 cline 相反）。实测同一会话第二次调用起
//   usage = {input:394, cacheRead:3072, …} —— 缓存命中的部分单列，没有并进 input。
//   ⇒ tin = usage.input；tcache = cacheRead + cacheWrite + **cacheWrite1h**（1 小时档写入是独立字段，
//   文档没写、实样里有；漏了它就是把最长寿命的那档缓存写入当没发生）。
//   totalTokens = input+output+cacheRead+cacheWrite(+1h)，与逐行求和实测一致。
// ⚠️ 口径二：**树不过滤，全量累加**。条目靠 id/parentId 组树、可多根（/tree 导航会留下废弃分支），
//   但 pi 自己的 `/session`（RPC get_session_stats）就是按**整份文件全量**记的：实测那份带废弃分支的
//   样本里 pi 报 {input:4862, output:1497, cacheRead:21168, cacheWrite:6144}，与逐行把两条分支、
//   compaction.usage 和 kind="cache_warm" 的 usage 行全加起来**一字不差**；只取当前叶子那条链的话
//   会得到 11419，比 pi 自己显示的少三分之二。⇒ 这里跟着源产品走：线性读、废弃分支的轮照常成行，
//   不剪枝。页面里同一会话可能出现两条分支的轮次时间交错，这是数据本来的形状，不是解析错位。
// ⚠️ 口径三：`usage` / `compaction.usage` / `branch_summary.usage` 都要计入所在轮。这三类都"不进上下文
//   但进会话总量"（docs/session-format.md 明写，get_session_stats 的注释同），漏 cache_warm 就是把
//   pi 的隐式预热成本当没花。
// ⚠️ 口径四：`context_edit{replacement:null}` 指向的那条 assistant 尝试**不再进上下文**，但 token 真的花了。
//   实测形态是「stopReason:"length" + output:1 的截断尝试」后面紧跟一条这样的 omit（pi 的 overflow 恢复
//   自己写的）。⇒ 照常计 token，详情里点명它被摘出上下文，不算成功正文。
//
// 轮口径（与 openclaw / minimax / hermes 同款）：message.role==="user" 且正文非空 → 开新轮；
// 轮内多条 assistant（工具循环）的 usage 求和；time = 首条 user 的 message.timestamp（毫秒）。
// 逐次耗时**不用算**：assistant 自带 durationMs（openclaw 没有这个字段，故它的 calls[].dur 恒为 0）。
// 失败轮：assistant stopReason==="error"（errorMessage/errorCode 原样带出）或 toolResult.isError=true；
//        stopReason==="aborted" 按 claude 口径与 status 独立，只标 aborted。
// 空用户消息不开轮（同 doubao / minimax / openclaw）：开了会让「扫到 N 轮」与「详情第 N 轮」错位。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, markKind, listDirCached, isDir, isFile, toText, trunc, readCompleteLines } from './shared.mjs';

export const PI_AGENT_DIRNAMES = ['.pi'];   // <home>/.pi/agent —— PI_CODING_AGENT_DIR 可整体改写

// 一个文件是不是 pi 转录：首行必须是会话头（type:"session" + version + id）。只读头 2KB。
// ⚠️ 这条内容判据是 discovery 抢在 atomcode 兜底之前认下 ~/.pi 的依据 —— 名字猜错不会误接邻居的数据。
export function isPiTranscript(fp) {
  let fd; try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    if (n <= 0) return false;
    const head = buf.toString('utf8', 0, n);
    const end = head.indexOf('\n');
    const first = end < 0 ? head : head.slice(0, end);
    if (!first) return false;
    try {
      const j = JSON.parse(first);
      return !!j && j.type === 'session' && j.version !== undefined && typeof j.id === 'string';
    } catch { return false; }
  } finally { try { fs.closeSync(fd); } catch {} }
}

// base 可能是 ~/.pi、~/.pi/agent、sessions/（或被 PI_CODING_AGENT_SESSION_DIR / settings.sessionDir
// 改名挪走的会话根）、甚至 sessions/--<cwd>--/ 单个项目目录 —— 都认（手工添加时用户就这么填）。
// ⚠️ 返回的 root 是**会话根本身**（不是 agentDir）：会话目录可以被改名，按 agentDir 再 join('sessions')
//    就找不到东西了。主文件那边因此要把 pi 记进 ROOT_SESSIONS_AGENTS（对它取 dirname 重嗅会爬到上层）。
export function piTranscripts(base) {
  if (!isDir(base)) return null;
  const bn = path.basename(base).toLowerCase();
  const cands = [
    path.join(base, 'sessions'),                 // ~/.pi 或直接给的 agentDir
    base,                                        // 会话根直接给（含改名挪走的那种）
    path.join(base, 'agent', 'sessions'),        // ~/.pi
  ];
  if (bn.startsWith('--') && bn.endsWith('--')) cands.unshift(path.dirname(base));  // 单个项目目录
  for (const root of [...new Set(cands)]) {
    if (!root || !isDir(root)) continue;
    const out = scanTranscriptFiles(root);
    if (out.length) return { root, files: out };
  }
  return null;
}

// root = 会话根（下面每个 `--<cwd 编码>--` 一个项目）。项目目录最多认 200 个、每个 400 份，
// 只为「别在嗅探上失控」，不是产品上限。
function scanTranscriptFiles(root) {
  const out = [];
  for (const dn of (listDirCached(root) || []).slice(0, 200)) {
    const projDir = path.join(root, dn);
    if (!isDir(projDir)) continue;
    for (const fn of (listDirCached(projDir) || []).slice(0, 400)) {
      if (!fn.endsWith('.jsonl')) continue;
      const fp = path.join(projDir, fn);
      if (!isFile(fp) || !isPiTranscript(fp)) continue;
      out.push({ fp, projectDir: dn, sessionId: fn.includes('_') ? fn.slice(fn.indexOf('_') + 1).replace(/\.jsonl$/, '') : fn.replace(/\.jsonl$/, '') });
    }
  }
  return out;
}

// 供 confAvailable / 自动发现用：会话根下能枚举出转录就算可用
export function hasPiSessions(root) { return scanTranscriptFiles(root).length > 0; }

export function piIdBase(fp) { return 'pi#' + fp.replace(/[\\/:]/g, '~') + '#'; }

// ---------------- ctx 分母：provider/modelId → contextWindow ----------------
// 两份目录合起来才是全集：models-store.json 是 pi 缓存的各家官方目录，models.json 是用户自己填的兼容端点
// （自定义 provider 只在前者里查不到）。两份都可能被 pi 随时重写，故按 mtime 缓存。
const _winCache = new Map();

// 会话根 → agentDir（那两个 json 在 agentDir，不在会话根）：默认摆法是 `<agentDir>/sessions`，
// 但会话根可能被 PI_CODING_AGENT_SESSION_DIR / settings.sessionDir 改名挪走，所以逐层上探、认文件在不在。
function agentDirFor(sessRoot) {
  for (const d of [path.dirname(sessRoot), path.dirname(path.dirname(sessRoot))]) {
    if (!d || d === sessRoot) continue;
    if (isFile(path.join(d, 'models-store.json')) || isFile(path.join(d, 'models.json'))) return d;
  }
  return null;
}

function windowMap(agentDir) {
  if (!agentDir) return null;
  const out = new Map();
  let sig = '';
  for (const fn of ['models-store.json', 'models.json']) {
    const fp = path.join(agentDir, fn);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    sig += fn + ':' + st.mtimeMs + ':' + st.size + ';';
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      // 两份文件的形状不一样：models-store.json 是 {provider:{models[]}} 扁平，
      // models.json 把 provider 挂在 {providers:{…}} 下面（真机实测 ctx 全 0 就是这个差别踩的）
      const src = j && j.providers && typeof j.providers === 'object' ? j.providers : j;
      for (const [prov, v] of Object.entries(src && typeof src === 'object' ? src : {})) {
        const arr = Array.isArray(v && v.models) ? v.models : [];
        for (const m of arr) {
          const id = m && m.id, w = Number(m && m.contextWindow);
          if (id && Number.isFinite(w) && w > 0) out.set(prov + '|' + id, w);
        }
      }
    } catch {}
  }
  if (!sig) return null;
  const c = _winCache.get(agentDir);
  if (c && c.sig === sig) return c.map;
  _winCache.set(agentDir, { sig, map: out });
  return out;
}

// I8 复现包原始片段提取复用：与扫描侧 role==='user' 的开轮判定**同一套**。
export function piUserText(content) {
  const t = contentText(content, /*dropThinking*/true);
  return t.trim() ? t : '';
}

// ---------------- 文本与用量小工具 ----------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// content 数组里抽文本。dropThinking=true 用于**用户**正文：思考块不该混进用户输入列。
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

// 一份 usage → 三个桶。cacheWrite1h 并进 tcache（实样字段、文档未列；1 小时档缓存写入漏了就是把
// 最长寿命那一档当没发生）。ctxUsed 只在**对话调用**上更新：预热/压缩摘要的 input 不是下一轮的
// prompt 占用，让它们覆写就把分母读歪了。
function addUsage(cur, u, isCall) {
  if (!u) return false;
  cur.tin += num(u.input);
  cur.tout += num(u.output);
  cur.tcache += num(u.cacheRead) + num(u.cacheWrite) + num(u.cacheWrite1h);
  if (isCall) cur.ctxUsed = num(u.input) + num(u.cacheRead) + num(u.cacheWrite) + num(u.cacheWrite1h);
  return true;
}

// ---------------- emit：把一轮落成 entry ----------------
//   · ctx      = 该轮模型的 contextWindow（models-store.json / models.json；取不到 → 0，页面退化成只显示占用）
//   · ctxUsed  = 本轮最后一次**对话调用**的 prompt 总量 = input + cacheRead + cacheWrite(+1h)
//   · finished = i < turns.length-1；最后一轮由页面按 lastTs 兜底（同 doubao / minimax / openclaw）
// ⚠️ 不设 rdur：pi 的 durationMs 只覆盖模型调用本身、不含工具执行，拿它当「实际工作时间」会把工具时间
//    一起剥掉（页面 tooltip 明写「已剥掉挂机/隔夜」，语义对不上）。逐次耗时走详情 calls[].dur。
//    compacts 可以给：页面那三处读取全是 v-if="e.compacts"，pi 没有的 compAuto/compManual 行自动不出现。
function emitTurns(agent, fp, data, fromIdx) {
  const idBase = piIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    addEntry(idBase + t.idx, {
      agent,
      project: data.project,
      session: data.session,
      name: data.name || undefined,
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : 0,
      status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache,
      total: t.tin + t.tout + t.tcache,
      ctx: t.win || 0,
      ctxUsed: t.ctxUsed || 0,
      rounds: t.calls,
      calls: t.calls,
      tools: t.tools,
      models: t.models,
      preview: t.preview,
      finished: i < data.turns.length - 1,
      aborted: !!t.aborted,
      toolNames: t.toolNames,
      compacts: t.compacts || undefined,
    }, { file: fp, turn: t.idx, kind: 'pi' });
  }
}

// 会话头（首行）元数据补读：index 恢复、文件截断重来、首读落在 off>0 这三种情况都拿不到首行。
function readHeader(fp, data, firstLine) {
  try {
    let line = firstLine;
    if (line === undefined) {
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(2048);
        const n = fs.readSync(fd, buf, 0, 2048, 0);
        const head = buf.toString('utf8', 0, n);
        const end = head.indexOf('\n');
        line = end < 0 ? head : head.slice(0, end);
      } finally { fs.closeSync(fd); }
    }
    const h = JSON.parse(line || '');
    if (!h || h.type !== 'session') return false;
    if (typeof h.id === 'string' && h.id) data.sessionId = h.id;
    if (typeof h.cwd === 'string') data.cwd = h.cwd;
    data.startedAt = Date.parse(h.timestamp) || 0;
    return true;
  } catch { return false; }
}

// ---------------- 扫描主入口（OFF_KINDS：逐行 off 增量续读，语义与 claude / openclaw 一致） ----------------
// root = **会话根**（discovery 的 sniffBase 解析出来的那个，默认 ~/.pi/agent/sessions，可被改名挪走）。
export function scanPi(agent, root, onlyFile) {
  if (!isDir(root)) return;
  const sessDir = root;
  const wins = windowMap(agentDirFor(root));
  for (const dn of listDirCached(sessDir) || []) {
    const projDir = path.join(sessDir, dn);
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
        if (prev.data?.turns?.length && !entries.has(piIdBase(fp) + (prev.data.turns.length - 1)))
          emitTurns(agent, fp, prev.data, 0);
        continue;
      }
      let off = prev?.off || 0;
      const data = prev?.data || {
        turns: [], emitted: 0, sessionId: '', session: '',
        name: '', cwd: '', project: '', startedAt: 0,
      };
      // 文件被截断（off 推到文件尾之后）：转录正常只追加，但导出/迁移会重写整份 —— 宁可整份重来。
      if (s < off) { off = 0; data.turns = []; data.emitted = 0; }
      if (s <= off) {
        if (!data.cwd) readHeader(fp, data);
        if (!data.sessionId) data.sessionId = fn.includes('_') ? fn.slice(fn.indexOf('_') + 1).replace(/\.jsonl$/, '') : fn.replace(/\.jsonl$/, '');
        if (!data.session) data.session = data.sessionId;
        if (!data.project) data.project = data.cwd || dn;
        files.set(key, { agent, kind: 'pi', m, s, off, data });
        markKind('pi');
        continue;
      }
      try {
        const rd = readCompleteLines(fp, off, s);
        if (!rd) { files.set(key, { agent, kind: 'pi', m, s, off, data }); markKind('pi'); continue; }
        if (off === 0 && rd.lines.length) readHeader(fp, data, rd.lines[0]);
        else if (!data.cwd) readHeader(fp, data);
        if (!data.sessionId) data.sessionId = fn.includes('_') ? fn.slice(fn.indexOf('_') + 1).replace(/\.jsonl$/, '') : fn.replace(/\.jsonl$/, '');
        if (!data.session) data.session = data.sessionId;
        if (!data.project) data.project = data.cwd || dn;
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.type === 'session') continue;
          // 会话名（/name）：只影响 entry.name，最后一笔为准
          if (j.type === 'session_info') {
            if (typeof j.name === 'string' && j.name.trim()) data.name = j.name.trim();
            continue;
          }
          const cur = data.turns[data.turns.length - 1];
          // ---- 不进上下文、但进会话总量的用量行（kind="cache_warm" 等）：计入所在轮 ----
          if (j.type === 'usage') {
            if (cur && addUsage(cur, j.usage)) {
              const ts = Date.parse(j.timestamp) || 0;
              if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
            }
            continue;
          }
          // ---- 压缩/分支摘要：正文不进，usage 进总量；compaction 另记一次（页面 compacts 那一列） ----
          if (j.type === 'compaction' || j.type === 'branch_summary') {
            if (cur) {
              const ts = Date.parse(j.timestamp) || 0;
              if (ts) cur.lastTs = Math.max(cur.lastTs, ts);
              if (j.type === 'compaction') cur.compacts = (cur.compacts || 0) + 1;
              addUsage(cur, j.usage);
            }
            continue;
          }
          // ---- context_edit：把某条早先条目摘出**后续**上下文。token 已经花在原条目上、这里不重复计，
          //      也不影响轮次切分，所以扫描侧直接跳过（摘除痕迹由详情侧从原文现算，见 piEntryContent） ----
          if (j.type === 'context_edit') continue;
          // ---- 其余非对话条目（model_change / thinking_level_change / label / custom / custom_message）跳过 ----
          if (j.type !== 'message') continue;
          const msg = j.message || {};
          const role = msg.role;
          if (role === 'user') {
            const text = piUserText(msg.content);
            if (!text) continue;   // 空用户消息不开轮（否则扫描与详情的轮序号错位）
            data.turns.push({
              idx: data.turns.length,
              time: num(msg.timestamp) || Date.parse(j.timestamp) || 0,
              lastTs: num(msg.timestamp) || Date.parse(j.timestamp) || 0,
              tin: 0, tout: 0, tcache: 0, ctxUsed: 0, win: 0,
              calls: 0, tools: 0, models: [], err: false, aborted: false, errMsg: '',
              compacts: 0,
              toolNames: {},
              preview: text.replace(/\s+/g, ' ').slice(0, 300),
            });
          } else if (role === 'assistant' && data.turns.length) {
            const t = data.turns[data.turns.length - 1];
            t.calls++;
            const ts = num(msg.timestamp) || Date.parse(j.timestamp) || 0;
            if (ts) t.lastTs = Math.max(t.lastTs, ts);
            addUsage(t, msg.usage, /*isCall*/true);
            if (msg.model) {
              if (!t.models.includes(msg.model)) t.models.push(msg.model);
              const w = wins && (wins.get((msg.provider || '') + '|' + msg.model) || wins.get(msg.model));
              if (w) t.win = w;
            }
            const sr = msg.stopReason;
            if (sr === 'error') {
              t.err = true;
              if (!t.errMsg) t.errMsg = msg.errorMessage || (msg.errorCode ? 'errorCode=' + msg.errorCode : '');
            } else if (sr === 'aborted') {
              t.aborted = true;   // 用户中断：与 status 独立（同 claude 口径）
            }
            for (const p of (Array.isArray(msg.content) ? msg.content : [])) {
              if (!p || typeof p !== 'object' || p.type !== 'toolCall') continue;
              const nm = typeof p.name === 'string' && p.name ? p.name : '?';
              t.tools++;
              t.toolNames[nm] = (t.toolNames[nm] || 0) + 1;
            }
          } else if (role === 'toolResult' && data.turns.length) {
            // 扫描侧只吃两个信号：轮时间与失败标志（工具计数已在 assistant 行完成，避免重复计数）
            const t = data.turns[data.turns.length - 1];
            const ts = num(msg.timestamp) || Date.parse(j.timestamp) || 0;
            if (ts) t.lastTs = Math.max(t.lastTs, ts);
            if (msg.isError) t.err = true;
          }
        }
        files.set(key, { agent, kind: 'pi', m, s, off: rd.newOff, data });
        markKind('pi');
        emitTurns(agent, fp, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}

// ---------------- 详情：重读转录按 src.turn 过滤 ----------------
// 开轮判定与扫描侧同一份（role=user 且正文非空），天然对齐，不会出现「扫到这一轮、详情找不到」。
export function piEntryContent(src, full) {
  const st = files.get(src.file);
  const version = st ? st.m + ':' + (st.off || 0) : null;
  let lines;
  try { lines = fs.readFileSync(src.file, 'utf8').split('\n'); } catch { return null; }
  let turnIdx = -1;
  const out = {
    user: '', assistant: '', tools: [], calls: [], v: version,
    callsNote: 'pi 转录（sessions/--<cwd>--/<时间>_<uuid>.jsonl）是追加式会话树：token/模型/逐次耗时都在 assistant ' +
      '消息行内（usage.input **不含** cache，tcache = cacheRead+cacheWrite+cacheWrite1h；逐次 dur 取 message.durationMs）。' +
      '按 pi 自己 /session 的口径**整棵树全量累加**，含废弃分支与 cache_warm 预热行。' +
      'context 窗口容量取 models-store.json / models.json 里该 provider+model 的 contextWindow（取不到则只显示占用）。',
  };
  const texts = [];
  let errMsg = '';
  let stopped = '';
  let compactCount = 0, warmCount = 0, omitCount = 0, branchCount = 0;
  let tokensBefore = 0;
  // ⚠️ 先单独扫一遍摘除记录：context_edit 永远写在它摘除的那条**之后**（pi 的 overflow 恢复当场补记），
  //    在主循环里「遇到再收」的话轮到那条 assistant 时集合还是空的，永远标不上 omitted。
  const omittedIds = new Set();
  for (const l0 of lines) {
    if (!l0.includes('"context_edit"')) continue;
    let k; try { k = JSON.parse(l0); } catch { continue; }
    if (k.type === 'context_edit' && k.replacement === null && k.targetId) omittedIds.add(k.targetId);
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session') continue;
    if (j.type === 'usage') {
      if (turnIdx === src.turn && j.usage) { warmCount++; continue; }
      continue;
    }
    if (j.type === 'compaction' || j.type === 'branch_summary') {
      if (turnIdx === src.turn) {
        if (j.type === 'compaction') { compactCount++; if (j.tokensBefore) tokensBefore = j.tokensBefore; }
        else branchCount++;
      }
      continue;
    }
    if (j.type !== 'message') continue;   // session_info / model_change / thinking_level_change / label / custom 不进正文
    const msg = j.message || {};
    if (msg.role === 'user') {
      const text = piUserText(msg.content);
      if (!text) continue;   // 与扫描侧同判据（同一个函数），否则轮序号错开
      turnIdx++;
      if (turnIdx === src.turn) out.user = text;
      continue;
    }
    if (turnIdx !== src.turn) continue;
    if (msg.role === 'assistant') {
      const omitted = omittedIds.has(j.id);
      if (omitted) omitCount++;
      const text = contentText(msg.content, /*dropThinking*/false);
      if (text && !omitted) texts.push(text);
      const u = msg.usage || {};
      const call = {
        model: msg.model || '',
        tin: num(u.input),
        tout: num(u.output),
        tcache: num(u.cacheRead) + num(u.cacheWrite) + num(u.cacheWrite1h),
        dur: num(msg.durationMs),
      };
      if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
      if (omitted) call.omitted = true;
      if (msg.thinkingLevel) call.thinking = msg.thinkingLevel;
      const tcs = Array.isArray(msg.content) ? msg.content.filter(p => p && p.type === 'toolCall') : [];
      if (tcs.length) call.tools = tcs.map(t => (typeof t.name === 'string' && t.name) || '?');
      for (const tc of tcs) {
        const nm = (typeof tc.name === 'string' && tc.name) || '?';
        const fi = {};
        const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
        out.tools.push({
          name: nm, tid: tc.id || null, error: null,
          input: trunc(args, full, fi), inputTrunc: !!fi.t, output: '', outputTrunc: false,
        });
      }
      if (msg.stopReason === 'error' && !errMsg) errMsg = msg.errorMessage || (msg.errorCode ? 'errorCode=' + msg.errorCode : '');
      if (msg.stopReason) stopped = msg.stopReason;
      out.calls.push(call);
    } else if (msg.role === 'toolResult') {
      // toolResult 自带 toolCallId / toolName，按 id 回填上一条 assistant 的 toolCall（同 doubao / openclaw）
      const tcid = msg.toolCallId || '';
      const t = out.tools.find(x => x.tid === tcid);
      if (!t) continue;
      const fo = {};
      t.output = trunc(toText(msg.content), full, fo);
      t.outputTrunc = !!fo.t;
      if (msg.isError) t.error = 'error';
    }
    if (turnIdx > src.turn) break;
  }
  out.assistant = texts.join('\n\n---\n\n');
  if (errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + errMsg;
  else if (stopped === 'aborted') out.callsNote += ' 本轮被中断（stopReason=aborted）。';
  else if (stopped === 'length') out.callsNote += ' 本轮最后一次调用触到输出上限被截断（stopReason=length）。';
  if (compactCount) out.callsNote += ' 本轮之后发生过 ' + compactCount + ' 次上下文压缩（压缩前 ' + tokensBefore + ' tokens）。';
  if (branchCount) out.callsNote += ' 本轮之后有 ' + branchCount + ' 条分支摘要（/tree 导航留下的废弃分支）。';
  if (warmCount) out.callsNote += ' 本轮另含 ' + warmCount + ' 条 prompt 缓存预热用量（不进上下文，按 pi 口径计入总量）。';
  if (omitCount) out.callsNote += ' 其中 ' + omitCount + ' 次尝试被 pi 摘出后续上下文（context_edit），token 已花但不回放。';
  return out;
}
