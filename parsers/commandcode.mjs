// ---------------- commandcode 解析器（Command Code：~/.commandcode/projects/<cwd 转义>/<会话 id>.jsonl） ----------------
// 落盘摆法（2026-10-19 真件实测，本机 14 份会话 = 用户 1 份真会话 + 配网关时的探针）：
//   <home>/.commandcode/projects/<cwd 转义>/<会话 uuid>.jsonl   ← 追加式转录，逐行 off 续读 ⇒ 进 OFF_KINDS
//   同目录 <uuid>.checkpoints.jsonl                            ← 逐轮快照（本机只在首轮一行、files:0），**不是会话源**
//   同目录 <uuid>.meta.json                                    ← print 载体是 {"entrypoint":"print"}，TUI 是 {"traceIds":[…]}
// ⚠️ 枚举只认 `.jsonl` 且**显式排除 `.checkpoints.jsonl`** —— 写成 `*.json*` 会把 checkpoints 当第二份会话、
//    条数直接翻倍（droid 的 `.settings.json.bak` 同型坑）。
// 行形状只有三种（14 份聚合出来的全集，没有第四种）：
//   {type:"session",version:3,id,timestamp,cwd}                                        ← 会话头，cwd 是**真绝对路径**
//   {type:"message",id,parentId,timestamp,message{role,content[],meta{source,messageId[,createdAt]}}}
//   {type:"message",…,message{…},usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens},model}
//   ⇒ **用量挂在行顶层**，不在 message 里（照抄 claude 的 `j.message.usage` 会整排 0）。
//
// ⚠️ 口径一（开轮）：`message.meta.source === "user"` 且有非空 text 块。
//   工具回执**也是 role:"user"**（`meta.source === "tool"`，本机 13 行）⇒ 照 role 数会把轮数虚增约一倍；
//   还有第三种行：`meta` 只有 messageId、没有 source（本机 5 行，内容是 "Authentication failed…" 这类
//   产品写回的错误文案）⇒ 既不是真人也不是工具，一律不开轮。所以一次失败运行的会话只剩「一问无答」
//   那 1 条，三桶与 calls 如实全 0 —— 既不是整份不出现，也不是拿错误文案凑成正文。
// ⚠️ 口径二（**inputTokens 已含缓存命中**，goose / codebuddy / cline 那一档）：
//   `tin = input − cacheRead`、`tcache = cacheRead`、`ctxUsed = input`，**不得把 cacheRead 再叠进 tin**。
//   自证（用户那条真会话逐次 input）：18988→20607→19988→22167→24136→25327 就是上下文全长；若 input 不含缓存，
//   上一条 in+out 才 19.3k、下一条 in+cacheRead 就是 39.9k ⇒ 一轮之内上下文翻倍，物理不可能。
//   另：cacheWrite 全程 0、cacheRead 会中途归零再涨（第 3 次 0、第 4 次 20736）⇒ 缓存两位是
//   Anthropic-wire 网关合成的，单列展示即可，不参与总量、也不拿去反推。
// ⚠️ 口径三（时间）：行级 `timestamp` 在同一次请求组内 user 与 assistant **完全相同**（本机 `07:17:59.773` 两行一样），
//   拿它算轮时长恒为 0 ⇒ 轮时间取 `message.meta.createdAt`（毫秒 epoch），没有才退行级 timestamp。
//   ⚠️ **tool 行的 meta 没有 createdAt**（本机 13/13）⇒ 轮末时间只取到本轮最后一条 **assistant** 的 createdAt。
//   两套时钟还会互相矛盾（某行 ts=07:19:40.094 而 createdAt 折回 07:18:13.06，差 87s）⇒ 全站按 createdAt，
//   行级只做兜底，别在一轮里混用两个源。
// ⚠️ 口径四（失败与计数）：**源头没有失败信号** —— 20 个 tool_result 块只有 {content,tool_use_id,type}，
//   不带 is_error / exit_code；命令失败写在文本里（本机见 "Exit code: 255" 前缀 + GBK 乱码），
//   从产品文本猜状态不是判据 ⇒ status 一律 ok、aborted 一律 false，只在详情里原样带出文本。
//   `calls` = 该轮内**按行 id 去重后**带 usage 的 assistant 行数（一次调用一行，本机 25 行）；
//   `tools` = tool_use 块数。⚠️ `.meta.json` 的 traceIds 条数**含失败调用**（那份失败会话 traceIds=1 而 assistant=0）
//   ⇒ 只配当校验，不能当数据源。
// ⚠️ 口径五（会话名没有源头）：三种行里没有 title / summary 一类（不像 claude 的 ai-title、openclaw 的 session_info）
//   ⇒ name 如实 null，会话列表显示裸 uuid，不拿 preview 冒充标题。
// ⚠️ 模型名是 provider 限定名（`4399bot/claude-dsv41fv[1m]`）⇒ 照原样进 models。CTX_WINDOWS 认不出
//   带 `[1m]` 后缀的别名 ⇒ ctx 走 windowOf 得 0，页面按「只显占用、不画进度条」兜底。
//   **不去读 ~/.commandcode/providers.json 里的 contextWindow**：那份是用户的网关配置、baseURL 可能嵌凭证，
//   而且它属于「用户想接什么就写什么」的外部可变项，拿它当分母会让同一条会话在不同机器上口径不一致。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, modelName, modelList, windowOf, markKind, listDirCached, isDir, isFile, readCompleteLines } from './shared.mjs';

const SNIFF_SLUGS = 60;      // 嗅探最多翻几个 slug 目录（判据是内容，命中即返回，不需要扫全）
const SNIFF_HEAD_BYTES = 8192;

export function commandcodeIdBase(fp) { return 'cmdc#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function isSessionFile(name) { return name.endsWith('.jsonl') && !name.endsWith('.checkpoints.jsonl'); }

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}
export function commandcodeUserText(content) { return textOf(content); }

// ⚠️ 口径一：扫描与详情共用这一份开轮判据
export function commandcodeIsTurnStart(j) {
  if (!j || j.type !== 'message') return false;
  const m = j.message;
  if (!m || m.role !== 'user') return false;
  if (!m.meta || m.meta.source !== 'user') return false;
  return !!textOf(m.content).trim();
}

function isToolRow(j) { return !!(j && j.message && j.message.meta && j.message.meta.source === 'tool'); }

// ⚠️ 口径三：createdAt（毫秒）优先，行级 ISO 只兜底
function rowTime(j) {
  const c = j && j.message && j.message.meta && Number(j.message.meta.createdAt);
  if (Number.isFinite(c) && c > 0) return c;
  const t = Date.parse((j && j.timestamp) || '');
  return Number.isFinite(t) ? t : 0;
}

// 读首行判断是不是 commandcode 的会话转录（内容判据：{type:"session",version,id,cwd}）
function headIsSessionLine(fp) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(SNIFF_HEAD_BYTES);
    const got = fs.readSync(fd, buf, 0, SNIFF_HEAD_BYTES, 0);
    const first = buf.slice(0, got).toString('utf8').split('\n')[0].trim();
    if (!first.startsWith('{')) return false;
    let j; try { j = JSON.parse(first); } catch { return false; }
    return j.type === 'session' && !!j.id && typeof j.cwd === 'string';
  } catch { return false; } finally { try { fs.closeSync(fd); } catch {} }
}

// <base> / <base>/projects 是不是 commandcode 的 projects 根。
// 三种手工填法都要接住：`~/.commandcode`、projects 根本身、某个 slug 目录（此时回它的父级）。
export function commandcodeProjectsRoot(base) {
  if (!base || !isDir(base)) return null;
  // 直接给的就是某个 slug 目录（里头躺着 <uuid>.jsonl）⇒ 认它的**父级**为 projects 根，
  // 让 scanCommandcode 仍能按「projects 根 → slug → 会话文件」三层走（父级里别的 slug 一起进来）。
  if (headIsSessionFileIn(base)) { const par = path.dirname(base); return isDir(par) ? par : null; }
  const bn = path.basename(base).toLowerCase();
  const cands = bn === 'projects' ? [base] : [path.join(base, 'projects'), base];
  for (const root of [...new Set(cands)]) {
    if (!isDir(root)) continue;
    if (commandcodeLooksLikeProjects(root)) return root;
  }
  return null;
}

function commandcodeLooksLikeProjects(root) {
  const slugs = listDirCached(root) || [];
  for (const slug of slugs.slice(0, SNIFF_SLUGS)) {
    const dir = path.join(root, slug);
    if (!isDir(dir)) continue;                       // ~/.commandcode 下还躺着 cache/ taste/ logs/
    if (headIsSessionFileIn(dir)) return true;
  }
  return false;
}

function headIsSessionFileIn(dir) {
  const names = listDirCached(dir) || [];
  for (const n of names.slice(0, 8)) {
    if (!isSessionFile(n)) continue;
    const fp = path.join(dir, n);
    if (isFile(fp) && headIsSessionLine(fp)) return true;
  }
  return false;
}

export function hasCommandcodeSessions(root) { return !!commandcodeProjectsRoot(root); }

function emitCommandcodeTurns(agent, fp, slug, data, fromIdx) {
  const idBase = commandcodeIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    const total = t.tin + t.tout + t.tcache;
    addEntry(idBase + t.idx, {
      agent,
      project: data.cwd || slug,                 // 会话头 / 行内 cwd 是真绝对路径，slug 只兜底
      session: data.session || path.basename(fp, '.jsonl'),
      name: null,                                // ⚠️ 口径五：这家没有产品自报的会话名
      time: t.time,
      dur: next ? Math.max(0, (next.time || t.time) - t.time) : Math.max(0, t.lastTs - t.time),
      status: 'ok',                              // ⚠️ 口径四：源头无失败信号，不染红
      tin: t.tin, tout: t.tout, tcache: t.tcache, total,
      ctx: windowOf(t.models), ctxUsed: t.ctxUsed || null,
      rounds: t.calls, tools: t.tools, calls: t.calls,
      models: modelList(t.models),
      preview: t.preview,
      finished: i < data.turns.length - 1,       // 同 claude：没有「轮结束」标志，靠后面还有轮推算
      aborted: false,
      toolNames: t.toolNames,
    }, { file: fp, turn: t.idx, kind: 'commandcode' });
  }
}

// 分片首扫用 onlyFile（一次一个会话文件，让出事件循环）
export function scanCommandcode(agent, root, onlyFile) {
  const slugs = listDirCached(root);
  if (!slugs) return;
  const onlySlug = onlyFile ? path.relative(root, onlyFile).split(path.sep)[0] : null;
  for (const slug of slugs) {
    if (onlySlug && slug !== onlySlug) continue;
    const dir = path.join(root, slug);
    if (!isDir(dir)) continue;
    const names = listDirCached(dir);
    if (!names) continue;
    for (const n of names) {
      if (!isSessionFile(n)) continue;
      const fp = path.join(dir, n);
      if (onlyFile && fp !== onlyFile) continue;
      scanCommandcodeFile(agent, fp, slug);
    }
  }
}

export function scanCommandcodeFile(agent, fp, slug) {
  let fst; try { fst = fs.statSync(fp); } catch { return; }
  const key = fp, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  if (prev && prev.m === m && prev.s === s) {
    // 重启后 entries 为空但 files 状态恢复了：从状态重建，不重读文件
    if (prev.data?.turns?.length && !entries.has(commandcodeIdBase(fp) + (prev.data.turns.length - 1)))
      emitCommandcodeTurns(agent, fp, slug, prev.data, 0);
    return;
  }
  let off = prev?.off || 0;
  const data = prev?.data || { cwd: '', session: '', turns: [], emitted: 0, mids: [] };
  if (!Array.isArray(data.mids)) data.mids = [];   // 老 state 恢复出来可能没有这一位
  if (s < off) { off = 0; data.turns = []; data.emitted = 0; data.mids = []; }   // 被整份重写：从头再来
  if (s <= off) {
    if (!data.session) data.session = path.basename(fp, '.jsonl');
    files.set(key, { agent, kind: 'commandcode', m, s, off, data });
    markKind('commandcode');
    return;
  }
  try {
    const rd = readCompleteLines(fp, off, s);
    if (!rd) { files.set(key, { agent, kind: 'commandcode', m, s, off, data }); markKind('commandcode'); return; }
    if (!data.session) data.session = path.basename(fp, '.jsonl');
    for (const line of rd.lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'session') {
        if (typeof j.cwd === 'string' && j.cwd) data.cwd = j.cwd;
        if (j.id) data.session = String(j.id);
        continue;
      }
      if (j.type !== 'message' || !j.message) continue;
      const ts = rowTime(j);
      if (commandcodeIsTurnStart(j)) {
        data.turns.push({
          idx: data.turns.length, time: ts, lastTs: ts,
          tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, ctxUsed: 0,
          models: [], preview: textOf(j.message.content).replace(/\s+/g, ' ').slice(0, 300),
          toolNames: {},
        });
        continue;
      }
      const cur = data.turns[data.turns.length - 1];
      if (!cur) continue;                 // 首条真人提问之前的行：无主，跳过
      if (isToolRow(j)) continue;         // 工具回执只贡献正文（详情侧再取），不影响桶
      const u = j.usage;
      if (!u) continue;                   // 没有用量就不是调用（错误文案那类）—— ⚠️ 也不许它推轮末时间
      if (j.id) {                         // ⚠️ 口径四：按行 id 去重，防同一响应的续写行重复计
        if (data.mids.includes(j.id)) continue;   // 续写行也不推进轮末（它不是新的一次调用）
        data.mids.push(j.id);
        if (data.mids.length > 4000) data.mids.splice(0, data.mids.length - 4000);
      }
      if (ts) cur.lastTs = Math.max(cur.lastTs, ts);   // ⚠️ 口径三：轮末只取到**去重后的 assistant 调用行**
      const inTok = u.inputTokens || 0, cache = u.cacheReadTokens || 0;
      cur.tin += Math.max(0, inTok - cache);        // ⚠️ 口径二：input 已含缓存，拆出来单列
      cur.tcache += cache;
      cur.tout += u.outputTokens || 0;
      if (inTok > 0) cur.ctxUsed = inTok;
      cur.calls++;
      const mn = modelName(j.model);
      if (mn && !cur.models.includes(mn)) cur.models.push(mn);
      for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
        if (!b || b.type !== 'tool_use') continue;
        cur.tools++;
        const nm = typeof b.name === 'string' && b.name ? b.name : '?';
        cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
      }
    }
    files.set(key, { agent, kind: 'commandcode', m, s, off: rd.newOff, data });
    markKind('commandcode');
    emitCommandcodeTurns(agent, fp, slug, data, Math.max(0, data.emitted - 1));
    data.emitted = data.turns.length;
  } catch {}
}

// 详情：重读转录按 src.turn 过滤，开轮判据与扫描侧同一份（commandcodeIsTurnStart）
export function commandcodeEntryContent(src, full) {
  const st = files.get(src.file);
  const v = st ? st.m + ':' + (st.off || 0) : null;
  const out = { user: '', assistant: '', tools: [], calls: [], v,
    callsNote: 'Command Code 的用量挂在**行顶层**（`usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`），'
      + '`inputTokens` **已含**缓存命中 ⇒ 这里把 `tin = input − cacheRead`、`tcache = cacheRead` 拆开列，不叠加。'
      + '工具回执也挂 role:"user"（`meta.source:"tool"`），不算一轮。'
      + '轮时间取 `message.meta.createdAt`（行级 timestamp 在同一请求组内 user 与 assistant 完全相同）。'
      + '⚠️ 源头没有工具失败字段（tool_result 只有 content/tool_use_id），命令失败只写在文本里（如 "Exit code: 255"），'
      + '所以逐项 error 一律 null、整轮不染红。' };
  const toolIds = new Set();
  let idx = -1, started = false, prevTs = 0;
  let lines;
  try { lines = fs.readFileSync(src.file, 'utf8').split('\n'); } catch { return null; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session') { out.cwd = j.cwd || ''; out.sessionVersion = j.version || 0; continue; }
    if (j.type !== 'message' || !j.message) continue;
    const ts = rowTime(j);
    if (commandcodeIsTurnStart(j)) {
      idx++;
      if (idx === src.turn) { out.user = textOf(j.message.content); started = true; prevTs = ts; continue; }
      if (idx > src.turn) break;
      continue;
    }
    if (!started || idx > src.turn) continue;
    if (isToolRow(j)) {
      for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
        if (!b || b.type !== 'tool_result') continue;
        const body = typeof b.content === 'string' ? b.content : textOf(b.content);
        const tgt = out.tools.find(x => x.tid === b.tool_use_id && !x.output) || out.tools.find(x => !x.output);
        if (tgt) { const flag = {}; tgt.output = clip(body, flag); tgt.outputTrunc = !!flag.t; }
      }
      continue;
    }
    if (!j.usage) continue;             // 错误文案一类的行不进调用列表（与扫描侧同一判据）
    const u = j.usage;
    const call = { model: modelName(j.model), tin: Math.max(0, (u.inputTokens || 0) - (u.cacheReadTokens || 0)),
      tout: u.outputTokens || 0, tcache: u.cacheReadTokens || 0, dur: Math.max(0, ts - prevTs) };
    prevTs = ts;
    const texts = [], thinks = [];
    for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
      if (!b) continue;
      if (b.type === 'text' && b.text) texts.push(b.text);
      else if (b.type === 'thinking' && b.thinking) thinks.push(b.thinking);
      else if (b.type === 'tool_use') {
        if (toolIds.has(b.id)) continue;
        toolIds.add(b.id);
        const flag = {};
        out.tools.push({ name: b.name || '?', tid: b.id, error: null,
          input: clip(typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}, null, 1), flag),
          inputTrunc: !!flag.t, output: '' });
      }
    }
    if (thinks.length) call.thinking = thinks.join('\n\n');
    if (texts.length) {
      const body = texts.join('\n\n');
      out.assistant += (out.assistant ? '\n\n---\n\n' : '') + body;
      if (!call.text) call.text = body;
    }
    out.calls.push(call);
  }
  if (!started) return null;
  const ck = checkpointCount(src.file);
  if (ck != null) out.callsNote += ' 旁挂 `.checkpoints.jsonl` 本机只记到第 ' + ck + ' 轮（`files:0`），不能当轮次或改动计数用。';
  return out;
}

function checkpointCount(fp) {
  const p = fp.replace(/\.jsonl$/, '.checkpoints.jsonl');
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { return null; }
}

function clip(s, flag) {
  const v = String(s == null ? '' : s);
  if (v.length <= 800) return v;
  flag.t = true;
  return v.slice(0, 800);
}
