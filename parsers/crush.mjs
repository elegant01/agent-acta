// ---------------- crush 解析器（Crush / Charm 的终端 agent：**每个项目一份** .crush/crush.db） ----------------
// crush 由 charmbracelet 出品（Go，bubbletea TUI），谱系上接着 opencode 的会话模型，**但库不是 opencode 那套表**
// （本机 0.96.1 实测，判据与字段都按实样，不按二手资料）：
//   <数据目录>/projects.json      ← {projects:[{path, data_dir, last_accessed}] —— **每个用过的目录一条**
//   <数据目录>/providers.json     ← provider/模型目录（含 cost_per_1m_*、context_window）；⚠️ 里面的 api_key
//                                    是 "$ANTHROPIC_API_KEY" 这种**环境变量引用**，但仍然不读：会话侧的账不缺它
//   <数据目录>/hyper.json         ← 产品自用的计费/凭证端点描述，不进解析
//   <data_dir>/crush.db           ← **真源**，落在项目目录里的 `.crush/` 下（不是数据目录！）
//   <data_dir>/logs/crush.log     ← 应用日志（JSON 行），常规级别**没有**逐次 token，只有 --debug 才有 ⇒ 不依赖
// 数据目录（`crush dirs` 本机实测）：Windows = %LOCALAPPDATA%\crush，POSIX = ~/.local/share/crush，
//   整体可被 CRUSH_GLOBAL_DATA 改写；配置目录（crush.json / crushrc）在 ~/.config/crush，两者不同一层。
//
// 表结构（sessions / messages / files / read_files + goose_db_version 迁移流水）：
//   sessions(id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost,
//            created_at, updated_at, summary_message_id, todos)
//   messages(id, session_id, role, parts(JSON 文本), model, created_at, updated_at, finished_at,
//            provider, is_summary_message, prism_*)
//   ⚠️ **时间列是 unix 秒**（不是毫秒）—— 全站按毫秒读，入库一律 ×1000；忘了乘就是把一轮显示成 1970。
//   ⚠️ 表名与 opencode 家族**只差一个复数 s**（session/message/part vs sessions/messages+parts 列），
//      所以嗅探判据不能只看表名，必须带 messages.parts 的列集合（见 crushDbVerify 的列判据）。
//
// parts 是**一条消息一个 JSON 数组**（opencode 是一条消息多行 part），本机实测的形状：
//   {"type":"text","data":{"text":"…"}}
//   {"type":"reasoning","data":{"thinking":"…","signature":"…","started_at":秒,"finished_at":秒}}
//   {"type":"tool_call","data":{"id","name","input":"<JSON 字符串>","provider_executed":false,"finished":true}}
//   {"type":"tool_result","data":{"tool_call_id","name","content","metadata":"<JSON 字符串>","is_error":bool}}
//   {"type":"finish","data":{"reason":"stop"|"end_turn"|"tool_use"|"error",  "time":秒, "message?","details?"}}
// 一条消息 = **一次 LLM 调用**（不是轮）：带 tool_call 的那条 reason=tool_use，正文那条 reason=end_turn，
// role='tool' 的消息是工具返回（不是模型回复）⇒ 轮 = 一条 role='user' 开轮，其后 assistant/tool 并入本轮
// （与 opencode / mimocode 同款）。
//
// ⚠️ 口径一（最要紧的一条）：**逐轮 token 源头不可得**。库里没有 per-message 用量列，parts 里也没有 usage 块；
//   sessions.prompt_tokens / completion_tokens 是**最后一次调用的快照**（同一会话连问三轮实测
//   completion 187→**3**→13、prompt 11790→11985→11995：会倒退的数不可能累计），只有 cost 是会话累计；
//   ⇒ tin/tout/tcache 一律 0（与 doubao 同一档：源头不落盘就是不落盘），**不拿会话快照去冒充某一轮**，
//   也不把累计 cost 按轮摊。详情 callsNote 明写这件事，页面卡片按「条数/时长」口径显示。
// ⚠️ 口径二：`is_summary_message=1` 的那条 assistant 消息是**压缩摘要**（正文不是模型给用户的回复）
//   ⇒ 进 compacts 计数与 others[]，不进 assistant 正文，也不计成一次对话调用。
// ⚠️ 口径三：`finish.reason` 里 `error` 才是失败；含 abort/cancel 字样的按中断（aborted，页面灰显不算失败）。
//   tool_result 的 `is_error` 只给那个工具打 ✗，不把整轮染红（跑错一条命令太常见，与 devindb 同一取舍）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  entries, srcs, removedIds, sorted, addEntry, files,
  toolNameCounts, toText, trunc, sqliteMod, isFile,
} from './shared.mjs';

export const crushDbErr = new Map();

const CRUSH_DB_NAME = 'crush.db';

function safeJson(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
// 秒 → 毫秒（见 ⚠️ 口径的时间列）
const sec = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0; };

// 判据：**sqlite 页头 + 独有列集合**。表名单独不够 —— 与 opencode 家族只差复数 s，
// 而 messages.parts / messages.is_summary_message 这对列是 crush 独有的（opencode 把 part 拆成行、
// mimocode 的用量在 message.data 里）。缺任一条就不认，认错的代价是把别家的库读成 0 token。
export function crushDbVerify(fp) {
  if (!fp || !isFile(fp)) return false;
  try {
    const fd = fs.openSync(fp, 'r');
    try {
      const head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, 16, 0);
      if (n !== 16 || head.toString('latin1') !== 'SQLite format 3\0') return false;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  const mod = sqliteMod();
  if (!mod) return false;
  let db = null;
  try {
    db = new mod.DatabaseSync(fp, { readOnly: true });
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!names.has('sessions') || !names.has('messages')) return false;
    const cols = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all('messages').map(r => r.name));
    return cols.has('parts') && cols.has('is_summary_message');
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}

// 数据目录（放 projects.json / providers.json 那一层）。CRUSH_GLOBAL_DATA 指哪儿算哪儿。
export function crushDataDir(c) {
  const env = (c && c.env) || process.env;
  const platform = (c && c.platform) || process.platform;
  const v = env.CRUSH_GLOBAL_DATA && String(env.CRUSH_GLOBAL_DATA).trim();
  if (v) return v;
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'crush') : null;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'crush');
  return path.join((c && c.home) || os.homedir(), '.local', 'share', 'crush');
}

// base（discovery 给的候选，或用户手工填的路径）→ sessions 字段该存什么：
//   · 直接给了 crush.db 文件           → 那个文件
//   · 给了数据目录（有 projects.json） → 数据目录（扫描时按索引展开成 N 份库）
//   · 给了某个项目目录 / 项目下的 .crush → 那份库文件本身
// 认不出返回 null。**返回的是「根」，不是库表**：一个 agent 下面可能有几十份库（每个项目一份）。
export function crushRoot(base) {
  if (!base) return null;
  try {
    const st = fs.statSync(base);
    if (st.isFile()) return crushDbVerify(base) ? base : null;
  } catch { return null; }
  const direct = path.join(base, CRUSH_DB_NAME);
  if (isFile(direct) && crushDbVerify(direct)) return base;                       // 项目下的 .crush 目录本身
  const proj = path.join(base, '.crush', CRUSH_DB_NAME);
  if (isFile(proj) && crushDbVerify(proj)) return base;                            // 项目根目录
  if (isFile(path.join(base, 'projects.json'))) return base;                        // 数据目录（按索引展开）
  // ⚠️ **不要**在这里回落到 crushDataDir()：那样一来「用户手工填了一个八竿子打不着的目录」也会
  //    被认成 crush —— 认的还是**这台机器**那份真数据（本机实测把 C:\Users\<u>\AppData\Local\crush
  //    塞进过一条无关 agent 的配置）。自动发现该找到数据目录，靠的是 candidateBases 里显式铺的那条。
  return null;
}

// sessions 字段 → 本轮要读的库清单（带上各自的项目路径）。上限 200 份只为「别在扫描上失控」。
export function crushDbs(sessions) {
  const out = [];
  const push = (dbPath, project) => {
    if (out.length < 200 && isFile(dbPath) && crushDbVerify(dbPath)) out.push({ dbPath, project: project || '' });
  };
  try {
    if (fs.statSync(sessions).isFile()) { push(sessions, path.basename(path.dirname(sessions))); return out; }
  } catch { return out; }
  const idx = path.join(sessions, 'projects.json');
  if (isFile(idx)) {
    const j = safeJson(fs.readFileSync(idx, 'utf8'));
    for (const p of (Array.isArray(j && j.projects) ? j.projects : [])) {
      const dir = p && (p.data_dir || (p.path ? path.join(p.path, '.crush') : ''));
      if (!dir) continue;
      push(path.join(dir, CRUSH_DB_NAME), p.path || path.dirname(dir));
    }
    if (out.length) return out;
  }
  push(path.join(sessions, CRUSH_DB_NAME), path.basename(sessions === '.crush' ? path.dirname(sessions) : sessions));
  push(path.join(sessions, '.crush', CRUSH_DB_NAME), sessions);
  return out;
}

export function crushIdBase(dbPath) { return 'cr#' + dbPath.replace(/[\\/:]/g, '~') + '#'; }

function makeTurn(s, ts, project) {
  return {
    sid: s.id, time: ts || 0, lastTs: ts || 0,
    project: project || '(未知项目)', session: s.id,
    name: String(s.title || '').trim() === 'Untitled Session' ? '' : String(s.title || '').trim(),
    user: '', texts: [], tools: [], byTool: new Map(),
    callList: [], models: [], events: [], others: [],
    err: false, errMsg: '', aborted: false, finished: false,
    compacts: 0,
  };
}

// 一条 assistant 消息 = 一次调用。它的 tool_call 全登记成工具，等 role='tool' 的行按 id 回填。
function addCall(t, m, parts, ts) {
  const txt = [];
  const names = [];
  let reason = '';
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const d = p.data || {};
    if (p.type === 'text' && typeof d.text === 'string' && d.text.trim()) txt.push(d.text);
    else if (p.type === 'reasoning') {
      const think = String(d.thinking || '');
      if (think.trim()) t.others.push({ type: 'thinking', t: sec(d.started_at) || ts, json: think });
    } else if (p.type === 'tool_call') {
      const tool = {
        name: String(d.name || '?'), tid: String(d.id || ''), ct: ts,
        // crush 的 input 是 **JSON 字符串**（不像 pi/devin 那样是对象），原样给出，页面只吃字符串
        input: typeof d.input === 'string' ? d.input : JSON.stringify(d.input ?? {}),
        output: '', error: null, dur: 0,
      };
      if (tool.tid) t.byTool.set(tool.tid, tool);
      t.tools.push(tool);
      names.push(tool.name);
    } else if (p.type === 'finish') {
      reason = String(d.reason || '');
      if (reason === 'error') {
        t.err = true;
        if (!t.errMsg) t.errMsg = String(d.message || '') + (d.details ? '：' + String(d.details).slice(0, 300) : '');
      } else if (/abort|cancel/i.test(reason)) t.aborted = true;
    }
  }
  const mdl = (typeof m.model === 'string' && m.model) || '';
  const text = txt.join('\n\n');
  const call = {
    model: mdl || '(未知模型)', provider: m.provider || '',
    tin: null, tout: null, tcache: null,        // 源头没有逐次用量（⚠️ 口径一），null = 不印 0
    dur: Math.max(0, sec(m.finished_at) - ts), ttft: 0,
    finishReason: reason && reason !== 'end_turn' && reason !== 'stop' ? reason : undefined,
  };
  if (text) { call.text = text; t.texts.push(text); }
  if (names.length) call.tools = names;
  t.callList.push(call);
  if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
  t.events.push({
    k: 'llm', t: ts, ttft: 0, dur: call.dur, model: call.model,
    tin: 0, tout: 0, tcache: 0,
    err: reason === 'error', blocks: names.length ? ['tool_calls'] : (text ? ['text'] : []),
    finish: reason,
  });
  return reason;
}

function parseSession(s, rows, project) {
  const turns = [];
  let cur = null;
  for (const m of rows) {
    const parts = safeJson(m.parts) || [];
    const ts = sec(m.created_at);
    if (m.role === 'user') {
      const text = [];
      for (const p of (Array.isArray(parts) ? parts : [])) {
        if (p && p.type === 'text' && p.data && typeof p.data.text === 'string') text.push(p.data.text);
      }
      const joined = text.join('\n\n').trim();
      if (!joined) continue;                    // 空 user 不开轮（判据只写这一处，详情读同一份内存数据）
      cur = makeTurn(s, ts, project);
      cur.key = String(m.id);
      cur.user = joined.slice(0, 3000);
      cur.events.push({ k: 'user', t: ts });
      turns.push(cur);
      continue;
    }
    if (!cur) continue;                          // 首条 user 之前的注入不进轮
    if (m.role === 'tool') {
      for (const p of (Array.isArray(parts) ? parts : [])) {
        const d = (p && p.data) || {};
        if (p.type !== 'tool_result') continue;
        const tcid = String(d.tool_call_id || '');
        const out = toText(d.content !== undefined ? d.content : d);
        const failed = !!d.is_error;
        const tool = tcid ? cur.byTool.get(tcid) : null;
        if (tool) {
          tool.output = out;
          if (failed) tool.error = 'error';
          const md = safeJson(d.metadata) || {};
          // 工具耗时在 metadata 的 start_time / end_time 里，**毫秒**（表列是 unix 秒，不同一格）；
          // 取不到才退到消息时间差 —— 那个只有秒级精度，一条 100ms 的命令会显示成 0 或 1s
          const mdDur = md.start_time && md.end_time ? Math.max(0, num(md.end_time) - num(md.start_time)) : 0;
          tool.dur = mdDur || Math.max(0, ts - (tool.ct || ts));
        } else {
          cur.tools.push({
            name: String(d.name || '?'), tid: tcid, ct: ts, input: '', output: out,
            error: failed ? 'error' : null, dur: 0,
          });
        }
        cur.events.push({ k: 'result', t: ts, tid: tcid || undefined, dur: 0, error: failed });
      }
      cur.lastTs = Math.max(cur.lastTs, ts);
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (Number(m.is_summary_message) === 1) {    // 压缩摘要（⚠️ 口径二）：正文不进、算一次压缩
      cur.compacts++;
      const sTxt = [];
      for (const p of (Array.isArray(parts) ? parts : [])) {
        if (p && p.type === 'text' && p.data && typeof p.data.text === 'string') sTxt.push(p.data.text);
      }
      cur.others.push({ type: 'summary', t: ts, json: sTxt.join('\n\n') });
      cur.lastTs = Math.max(cur.lastTs, ts);
      continue;
    }
    const reason = addCall(cur, m, Array.isArray(parts) ? parts : [], ts);
    cur.lastTs = Math.max(cur.lastTs, sec(m.finished_at) || ts);
    if (reason === 'end_turn' || reason === 'stop') cur._stop = true;
  }
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    t.finished = !!t._stop || i + 1 < turns.length;
    delete t._stop;
    t.endTs = t.lastTs;
    t.events.push({ k: 'end', t: t.lastTs || t.time, reason: t.err ? 'error' : (t.aborted ? 'aborted' : 'completed') });
    for (const [k, tool] of t.tools.entries()) {
      t.events.push({ k: 'call', t: tool.ct || t.time, name: tool.name, tid: tool.tid || undefined, i: k });
    }
    t.events.sort((a, b) => (a.t || 0) - (b.t || 0));
    t.preview = (t.user || t.texts.join('\n\n---\n\n') || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
  }
  return turns;
}

function collectTurns(dbPath, project) {
  const mod = sqliteMod();
  if (!mod) throw new Error('当前 Node 没有 node:sqlite（需要 22.5+）');
  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at, id').all();
    const msgs = db.prepare('SELECT * FROM messages ORDER BY rowid').all();
    const bySession = new Map();
    for (const m of msgs) {
      if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
      bySession.get(m.session_id).push(m);
    }
    const turns = [];
    for (const s of sessions) {
      const rows = bySession.get(s.id);
      if (!rows || !rows.length) continue;
      // **只按 created_at 稳定排序**：库里的时间列是秒，同一轮的 user 与 assistant 常常同秒 ——
      // 再拿 id(uuid) 当次级键就会把顺序打乱（实测：assistant 排到 user 之前 ⇒ 那条回复落在 cur 还没
      // 建立的阶段被丢掉，这一轮显示 0 次调用）。V8 的 sort 是稳定的，同秒的保持 rowid（=写入序）。
      rows.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      for (const t of parseSession(s, rows, project)) turns.push(t);
    }
    return { turns, sessionCount: sessions.length };
  } finally { try { db.close(); } catch {} }
}

function dbSignature(dbPath) {
  let st; try { st = fs.statSync(dbPath); } catch { return null; }
  let wal = null, shm = null;
  try { wal = fs.statSync(dbPath + '-wal'); } catch {}
  try { shm = fs.statSync(dbPath + '-shm'); } catch {}
  // WAL：主库 mtime 可能长时间不动（新行只进 -wal），三个文件都要进签名
  return {
    m: st.mtimeMs, s: st.size,
    sig: [st.mtimeMs + '|' + st.size, wal ? wal.mtimeMs + '|' + wal.size : '-', shm ? shm.mtimeMs + '|' + shm.size : '-'].join('#'),
  };
}

function emit(agent, dbPath, data, prevData) {
  const base = crushIdBase(dbPath);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = base + String(t.sid).replace(/#/g, '~') + '#' + t.key;
    ids.add(id);
    addEntry(id, {
      agent,
      project: t.project,
      session: t.session,
      name: t.name || null,
      time: t.time,
      dur: Math.max(0, (t.endTs || t.lastTs || t.time) - t.time),
      status: t.err ? 'error' : 'ok',
      tin: 0, tout: 0, tcache: 0, total: 0,      // ⚠️ 口径一：源头没有逐轮用量，如实记 0（不冒充会话快照）
      ctx: 0,                                     // 库里没有窗口容量字段 —— 不编分母
      ctxUsed: null,
      rounds: t.callList.length, calls: t.callList.length, tools: t.tools.length,
      models: t.models,
      preview: t.preview,
      finished: !!t.finished,
      aborted: !!t.aborted,
      toolNames: toolNameCounts(t.tools),
      compacts: t.compacts || undefined,
    }, { file: dbPath, turn: i, kind: 'crush' });
  });
  for (const old of (prevData && prevData.ids) || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

function scanOneDb(agent, dbPath, project) {
  const stat = dbSignature(dbPath);
  if (!stat) { crushDbErr.set(agent, '库不存在：' + dbPath); return false; }
  const prev = files.get(dbPath);
  if (prev && prev.data && prev.data.sig === stat.sig) {
    const last = prev.data.turns && prev.data.turns[prev.data.turns.length - 1];
    if (last && !entries.has(crushIdBase(dbPath) + String(last.sid).replace(/#/g, '~') + '#' + last.key))
      emit(agent, dbPath, prev.data, null);
    return true;
  }
  try {
    const { turns, sessionCount } = collectTurns(dbPath, project);
    const data = { sig: stat.sig, turns, sessions: sessionCount, rev: ((prev && prev.data && prev.data.rev) || 0) + 1 };
    files.set(dbPath, { agent, kind: 'crush', m: stat.m, s: stat.s, off: 0, data });
    crushDbErr.delete(agent);
    emit(agent, dbPath, data, prev && prev.data);
    return true;
  } catch (e) {
    console.error('[crush]', dbPath, e.message);
    crushDbErr.set(agent, dbPath + '：' + e.message);
    return false;
  }
}

// sessions = crushRoot 解析出来的根（数据目录 / 项目目录 / .crush / 库文件），按索引展开成 N 份库。
export function scanCrush(agent, sessions) {
  if (!sessions) { crushDbErr.set(agent, '找不到 crush 的数据目录'); return; }
  const dbs = crushDbs(sessions);
  if (!dbs.length) {
    crushDbErr.set(agent, isFile(sessions) ? '这份库不像 crush 的库：' + sessions : '数据目录里没有可读的 crush.db：' + sessions);
    return;
  }
  let ok = 0;
  for (const d of dbs) if (scanOneDb(agent, d.dbPath, d.project)) ok++;
  if (ok) crushDbErr.delete(agent);
}

// 详情：整轮从扫描时的内存里读（与 devindb / traedb 同路数 —— 源是库，重读一遍按 turn 过滤没有意义）
export function crushEntryContent(src, full) {
  const st = files.get(src.file);
  const t = st && st.data && st.data.turns && st.data.turns[src.turn];
  if (!t) return null;
  const tools = t.tools.map(x => {
    const fi = {}, fo = {};
    return {
      name: x.name, tid: x.tid, error: x.error, dur: x.dur || 0,
      input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
      output: trunc(x.output, full, fo), outputTrunc: !!fo.t,
    };
  });
  const calls = t.callList.map(c => {
    if (!c.text) return { ...c };
    const ft = {};
    const text = trunc(c.text, full, ft);
    return ft.t ? { ...c, text, textTrunc: true } : { ...c };
  });
  const out = {
    user: t.user,
    assistant: t.texts.join('\n\n---\n\n'),
    tools, calls,
    events: t.events || [],
    others: (t.others || []).map(o => ({ type: o.type, t: o.t, json: full ? o.json : String(o.json).slice(0, 800) })),
    v: 'cr' + ((st.data && st.data.rev) || 0),
    callsNote: 'crush 的会话库是 **每个项目一份 .crush/crush.db**：一条 assistant 消息 = 一次模型调用，' +
      'parts 里带 text / reasoning / tool_call / finish，工具返回单独一条 role=tool 的消息按 tool_call_id 回填。' +
      '⚠️ 库里**没有逐轮 token**：sessions.prompt_tokens/completion_tokens 只是「最后一次请求」的快照' +
      '（实测会被后一轮改小），cost 才是会话累计 —— 所以这一家的 tin/tout 如实记 0、逐次 calls[].tin 留空，' +
      '不拿会话快照冒充某一轮，也不把累计 cost 按轮摊。时间列是 unix 秒，入库已 ×1000。',
  };
  if (t.err) out.callsNote = '这一轮没有成功拿到模型回复：' + (t.errMsg || 'finish.reason=error') + '。' + out.callsNote;
  else if (t.aborted) out.callsNote += ' 本轮被中断（finish.reason 带 abort/cancel）。';
  if (t.compacts) out.callsNote += ' 本轮前后发生过 ' + t.compacts + ' 次上下文压缩（摘要消息 is_summary_message=1，正文不进本轮回复）。';
  return out;
}
