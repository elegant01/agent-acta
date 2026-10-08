// ---------------- mimocode 型解析器（记忆/检查点类 agent，真源是 mimocode.db SQLite） ----------------
// 从其它 agent 的解析器套用同一套接口（addEntry / files / entries / srcs / markKind），纯新增、不改动主文件其它路径。
// 导出 scanMimocode / mimocodeEntryContent。
//
// ⚠️ 重要修正：mimocode 真正的会话数据在 **SQLite 库**（`mimocode.db`，Drizzle ORM 之上），
// 不是 markdown。用户给的那几个 checkpoint.md / notes.md / progress.md 是由库导出的展示层、
// 且本机实测 task 表为空（任务目前只存在于 markdown）。所以**以 mimocode.db 为权威源**，
// markdown 落盘的那几份仅在「SQLite 库读不动」时作为只读兜底回退（见下面 scanMimocode 的分支）。
//
// SQLite 真源的数据模型（本机实测 mimocode.db）：
//   session        : 一次会话；id / title / directory / project_id / time_created / time_updated
//   message        : 一条消息（**不是**一轮）；data = {role, agent, time:{created,completed},
//                    model:{providerID,modelID}(user) 或顶层 modelID/providerID(assistant),
//                    tokens:{input,output,reasoning,cache:{read,write}}, cost, finish, error, ...}
//   part           : 一条 message 的内容碎片；data.type ∈ {text, reasoning, tool, step-start, step-finish}；
//                    tool 碎片带 callID / tool / state:{status,input,output} / time:{start,end}
//   project        : id / worktree（如 F:\centos\next-admin）/ name
//   task / history_fts 等：task 常为空；history_fts 是库自己的搜索索引（不另取）
//
// 映射（**一条 user message 开一轮 = AgentActa 一条 entry**）：
//   ⚠️ 这是本文件的核心口径，别退回「一条 message 一条 entry」：mimocode 的 agent 循环是
//      「想一步 → 调工具 → 看结果 → 再想一步」，一次提问会落 **十几到几十条 assistant message**
//      （本机实测：一句「hello，我能去哪找你的应用图标的svg」落了 19 条 assistant、20 次工具调用）。
//      若每条 message 各灌一条 entry，页面一张卡就变 20 条，与 claude/opencode/zcode 的「轮」语义也对不上。
//   · session   = session.id；project = project.worktree 或会话自己的 directory
//   · rounds    = 轮内 LLM 调用数（= 轮内 assistant message 数）；calls 同值；tools = 轮内 tool 碎片数
//   · time      = 轮内最早 message.time.created（**毫秒**，全项目统一 13 位）
//   · dur       = 轮内 (最晚 completed) − time（**毫秒**，与 claude/opencode 一致，页面 fmtDur 按毫秒读）
//   · tin/tout  = 逐次 tokens.input / (output + reasoning) 之和；tcache = cache.read + cache.write
//   · models    = 轮内出现过的 modelID（assistant 看顶层，user 看 model.modelID）
//   · status    = 轮内任何 tool 碎片 state.status==='error' 或 message.error → 'error'
//   · nollm     = 轮内没有任何 assistant message（用户刚发问、还没回复）
//   · user/assistant（详情）= 该轮的用户输入 / 逐次 reasoning+text；tool 碎片作为工具调用明细
//
// 不在 OFF_KINDS 里：SQLite 库是实时写入的活源（带 -wal），按字节偏移续读既没必要也不可靠；
// 同 dsh/gemini/cursor 一路 —— 每次启动整份重解析 + 库的 {mtime,size} 签名跳过没变的库。
// 因为不进 OFF_KINDS，entries 本身不落 index 分片（只落 files 状态没意义），重启后靠重扫重建，
// 与 dsh 的处理一致。
// PARSER_REV['mimocode'] 仍然登记（见 shared.mjs）：它在这里**不**管 index 落盘（本 kind 不落），
// 管的是**搜索分片**的作废 —— search.mjs 用 revOf(kind) 比对分片里的 rev，对不上就整片丢弃重扫。
// 本轮把「message 下标」改成了「轮下标」，turn 的语义变了，老分片的键会对到错的正文上，
// 所以必须给编号让它失效（不给的话要等库自己变一次才自愈）。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, srcs, removedIds, sorted, addEntry, toText, markKind, listDirCached, isDir, isFile, sqliteMod, toolNameCounts } from './shared.mjs';
// 诊断出口（core/log.mjs）：下面三行「回退 markdown」的提示以前是靠 core 那行全局 console 补丁
// 才没漏进 MCP 的协议通道的 —— 补丁拆了，这里得自己走同一个出口（零 import 的叶子模块，不成环）。
import { log } from '../core/log.mjs';

// 库 + WAL 的签名：变了才整库重读，没变直接跳过。
// ⚠️ 这不是「优化」而是必需：本机实测 mimocode.db 已达 187MB（part.data 就有 72MB、29302 行），
// 而默认扫描节奏是 3s。没有签名跳过就是每 3 秒把整库 2181 条 message + 29302 条 part 全读出来
// 重新 JSON.parse 一遍（实测单轮 1.2s、常驻 RSS 219MB）—— 页面同步卡住、浏览器都跟着顿。
// 与 opencode / hermes 同款：不进 OFF_KINDS、不登记 PARSER_REV，靠签名跳过没变的库。
function dbSignature(dbPath) {
  let dbSt, walSt = null;
  try { dbSt = fs.statSync(dbPath); } catch { return null; }
  try { walSt = fs.statSync(dbPath + '-wal'); } catch {}
  return {
    m: dbSt.mtimeMs,
    s: dbSt.size,
    sig: dbSt.mtimeMs + '|' + dbSt.size + '|' + (walSt ? walSt.mtimeMs + '|' + walSt.size : '-'),
  };
}

// ---------- 找 mimocode.db（root 可能是 memory 根、mimocode 应用根、或其上层）----------
function findDb(root) {
  if (!root) return null;
  const candidates = [
    path.join(root, 'mimocode.db'),
    path.join(root, 'memory', 'mimocode.db'),
    path.join(root, 'mimocode', 'mimocode.db'),
  ];
  for (const c of candidates) if (isFile(c)) return c;
  // root 上层逐级探：<root>/../mimocode.db 等（用户填 memory 时）
  let cur = root;
  for (let i = 0; i < 4; i++) {
    const up = path.dirname(cur);
    if (up === cur) break;
    const c = path.join(up, 'mimocode.db');
    if (isFile(c)) return c;
    cur = up;
  }
  return null;
}

// 单个 tool 碎片存进内存时的截断上限。详情页本身只展示 output 前 4000 字符（见 mimocodeEntryContent），
// 而本机实测存在 518KB 的 Read 返回、459KB 的截图返回 —— 原样留在内存里是纯浪费（也是 RSS 200MB+ 的主因）。
const TOOL_TEXT_CAP = 8000;
const cap = s => { const t = String(s == null ? '' : s); return t.length > TOOL_TEXT_CAP ? t.slice(0, TOOL_TEXT_CAP) : t; };

// 会话内「一轮」的序号：user 消息开一轮，后续 assistant（含多步工具循环）都归这一轮。
// 原实现用「message 在库里的序号」当 rounds，一个 user 后面跟 20 步 assistant 时会数到 20+，
// 与页面「第几轮」的语义对不上（opencode/zcode 都是按 user 开轮）。
function roleOf(md) { return String(md && md.role || 'unknown'); }
function modelOfMessage(md) {
  // ⚠️ 真实数据里两个角色把模型放在**不同位置**（本机 2181 条实测）：
  //   assistant：顶层 modelID / providerID（873/873 有；`.model` 对象**一个都没有**）
  //   user     ：`model: { providerID, modelID }`（表示这条消息用的模型）
  // 原实现只读 md.model.modelID → assistant 侧恒为空，页面模型名全部退化成「未知模型」
  //（实测 873 条 assistant 的 models[] 全是空的，正是这个原因）。
  const id = md && (md.modelID || (md.model && md.model.modelID));
  const prov = md && (md.providerID || (md.model && md.model.providerID));
  return String(id || prov || '').trim();
}
function statusOf(md, errTools) {
  const finish = String(md && md.finish || '').toLowerCase();
  const aborted = ['abort', 'cancel', 'interrupt'].some(x => finish.includes(x));
  const failed = !!md?.error || /error|fail/.test(finish) || errTools > 0;
  return { failed, aborted };
}

function scanMimocodeDb(agent, dbPath) {
  const stat = dbSignature(dbPath);
  if (!stat) return false;
  // 库没变：不重读，但要确认上次的条目还在（首次扫描后才载入内存/被 LRU 淘汰的情形），
  // 与 opencode 的 prev 分支同款处理。
  const prev = files.get(dbPath);
  if (prev && prev.data && prev.data.sig === stat.sig && prev.data.list) {
    const firstId = prev.data.ids && prev.data.ids[0];
    if (!firstId || !entries.has(firstId)) emitMimocodeDb(agent, dbPath, prev.data, null);
    return true;
  }
  const S = sqliteMod();
  if (!S) { log('[mimocode] node:sqlite 不可用，回退 markdown'); return false; }
  let db;
  try { db = new S.DatabaseSync(dbPath, { readOnly: true }); }
  catch (e) { console.error('[mimocode] 打开库失败：' + e.message + '，回退 markdown'); return false; }
  try {
    // 库结构防御：缺核心表就当作非 mimocode 库，回退 markdown
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!have.has('session') || !have.has('message') || !have.has('part')) {
      log('[mimocode] 库缺少 session/message/part，回退 markdown'); return false;
    }
    // project: id -> worktree（给条目 project 用）
    const projMap = new Map();
    try { for (const r of db.prepare('SELECT id, worktree FROM project').all()) projMap.set(r.id, r.worktree || r.id); } catch {}
    // project 名：worktree 是 '/' 或缺失时退回会话自己的 directory —— 否则 global 项目那批
    //（本机 60+ 个会话）会全挤在 'mimocode:global' 一个分组里，看不出是哪个工作目录。
    const projOf = (pid, dir) => {
      const w = projMap.get(pid);
      if (w && w !== '/' && w !== '\\') return w;
      if (dir) return dir;
      return 'mimocode:' + (pid || 'global');
    };

    const sessions = db.prepare('SELECT id, project_id, title, directory, time_created, time_updated FROM session ORDER BY time_created').all();
    const list = [];        // 每项 = 一轮（src.turn 就是下标）
    const ids = [];
    for (const s of sessions) {
      const session = s.id;
      const project = projOf(s.project_id, s.directory);
      const msgs = db.prepare('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(session);
      const parts = db.prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(session);
      // 按 message_id 归组 parts（解析 data.type）
      const partsByMsg = new Map();
      for (const p of parts) {
        let d; try { d = JSON.parse(p.data); } catch { continue; }
        // 只留详情页真正用得到的三类碎片（text/reasoning/tool）；step-start / step-finish
        // 这类纯标记不留在内存里（step-finish 的 tokens 与 message.tokens 实测完全一致，见 README 口径）
        const ty = d && d.type;
        if (ty !== 'text' && ty !== 'reasoning' && ty !== 'tool') continue;
        if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
        partsByMsg.get(p.message_id).push({ t: p.time_created, ...d });
      }
      // ---- 轮聚合：user message 开一轮，其后所有 assistant message 都并入这一轮 ----
      // 首条 message 若不是 user（会话被截断/只留了回复）也算一轮，否则那些消息会整批丢掉。
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const t = finalizeTurn(cur, s);
        // 全空的轮不灌条目（同 claude/doubao 的约定）：只有 user 行、没有任何正文/工具/错误
        // 的那种「打开了没说话」的记录铺在页面上只是噪音。
        if (t) { list.push(t); ids.push('mc#' + t.key); }
        cur = null;
      };
      for (const m of msgs) {
        let md; try { md = JSON.parse(m.data); } catch { md = {}; }
        const role = roleOf(md);
        if (role === 'user' || !cur) {
          flush();
          cur = {
            key: m.id, session, project,
            sTitle: s.title || '',
            time: 0, lastTs: 0, endTs: 0,
            userTexts: [], texts: [], reasonings: [], tools: [], models: [], callList: [],
            calls: 0, tin: 0, tout: 0, tcache: 0, total: 0,
            failed: false, aborted: false, finished: false, errTools: 0, errMsg: '',
          };
        }
        const ps = partsByMsg.get(m.id) || [];
        const created = Number(md.time?.created) || Number(m.time_created) || 0;
        const completed = Number(md.time?.completed) || 0;
        if (created) cur.time = cur.time ? Math.min(cur.time, created) : created;
        cur.lastTs = Math.max(cur.lastTs, completed || created || 0);
        if (completed) cur.endTs = Math.max(cur.endTs, completed);

        // 正文（text / reasoning）按角色归位：user 的进 userTexts，assistant 的进 texts/reasonings
        const texts = ps.filter(p => p.type === 'text').map(p => p.text || '');
        const reasonings = ps.filter(p => p.type === 'reasoning').map(p => p.text || '');
        if (role === 'user') cur.userTexts.push(...texts);
        else { cur.texts.push(...texts); cur.reasonings.push(...reasonings); }

        const tools = ps.filter(p => p.type === 'tool').map(p => ({
          callID: p.callID, name: p.tool || '?',
          status: p.state?.status || '',
          input: p.state?.input != null ? cap(JSON.stringify(p.state.input)) : '',
          output: p.state?.output != null ? cap(p.state.output) : '',
          start: p.time?.start || 0, end: p.time?.end || 0,
          // 这次工具调用发生在第几次 LLM 调用之后（callList 的下标），详情页按调用分组用
          call: cur.calls,
        }));
        cur.tools.push(...tools);
        const errTools = tools.filter(t => t.status === 'error').length;
        cur.errTools += errTools;

        // token 口径（与 opencode / zcode 对齐，也和库自己的 tokens.total 一致）：
        //   tin  = input
        //   tout = output + reasoning   ← 推理 token 属输出侧；原实现漏了 reasoning，
        //                                 本机 18 条有推理的消息少算 25~462 token
        //   tcache = cache.read + cache.write
        //   实测库里的 tokens.total 恰等于 input+output+reasoning+cache（49/49 条吻合），可佐证口径。
        //   ⚠️ 只累加 assistant 的用量：user message 的 tokens 实测为空，但万一有值也不该算成一次调用。
        if (role === 'assistant') {
          const tk = md.tokens || {};
          const cache = tk.cache || {};
          const tin = Number(tk.input) || 0;
          const tout = (Number(tk.output) || 0) + (Number(tk.reasoning) || 0);
          const tcache = (Number(cache.read) || 0) + (Number(cache.write) || 0);
          const total = tk.total != null ? (Number(tk.total) || 0) : (tin + tout + tcache);
          cur.tin += tin; cur.tout += tout; cur.tcache += tcache; cur.total += total;
          cur.calls++;
          // 逐次调用的明细（详情页「LLM 调用明细」块 + 会话视图）：
          // 模型/用量/正文各归各的，一次调用只装自己产出的那段文字。
          cur.callList.push({
            model: modelOfMessage(md) || '(未知模型)',
            tin, tout, tcache,
            dur: (created && completed && completed >= created) ? (completed - created) : 0,
            finishReason: md.finish || '',
            error: md.error ? String(md.error.message || md.error.name || md.error || '') : '',
            text: [...reasonings.map(x => '💭 ' + x), ...texts].join('\n\n').trim(),
          });
          const mdl = modelOfMessage(md);
          if (mdl && !cur.models.includes(mdl)) cur.models.push(mdl);
        }

        const st = statusOf(md, errTools);
        if (st.failed) { cur.failed = true; if (!cur.errMsg) cur.errMsg = String(md.error?.message || md.error?.name || md.error || md.finish || ''); }
        if (st.aborted) cur.aborted = true;
        if (md.finish || completed) cur.finished = true;
      }
      flush();
    }
    // ⚠️ 这里的 data 就是详情页要用的那份（mimocodeEntryContent 读 files.get(src.file)），
    // 所以 mimoKind 必须落 'db'：漏了它详情会一路落到最后的「项目记忆」兜底分支，
    // 症状是正文全空、tools/calls 都没有（本机踩过）。
    const data = { mimoKind: 'db', sig: stat.sig, list, ids, rev: (prev?.data?.rev || 0) + 1 };
    files.set(dbPath, { agent, kind: 'mimocode', m: stat.m, s: stat.s, off: 0, data });
    emitMimocodeDb(agent, dbPath, data, prev?.data);
    return true;
  } finally { try { db.close(); } catch {} }
}

// 一轮定稿：算出页面要用的预览/状态。
// user 正文要**剥掉 <system-reminder> 注入块**：mimocode 会把运行上下文（MCP 配置、工作目录、
// 「上次回复没有可用答案」等）当作 text 碎片塞进 user message，本机实测一条 2014 字的注入块里
// 真用户输入只有 21 字。不剥的话卡片预览与「用户输入」全是那段注入物，搜索/筛选也都废了。
// 与 minimax 的 stripReminder 同口径（严格：必须是块状标签，剥完为空则退回原文）。
function stripInject(text) {
  const t = String(text || '');
  const cleaned = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ')
    .replace(/<local-command[\s\S]*?<\/local-command[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return cleaned;
}
function turnPreview(t) {
  const u = stripInject(t.userTexts.join(' '));
  if (u) return ('👤 ' + u).slice(0, 300);
  const a = t.texts.join(' ').replace(/\s+/g, ' ').trim();
  if (a) return ('🤖 ' + a).slice(0, 300);
  if (t.errMsg) return ('⚠ ' + t.errMsg).slice(0, 300);
  if (t.tools.length) return ('🔧 ' + t.tools.length + ' 次工具调用').slice(0, 300);
  return '（空轮）';
}
function finalizeTurn(t, s) {
  // 全空的轮：既没有用户正文、也没有任何回复/工具/错误 → 返回 null（调用方丢掉不灌条目）。
  // 判据只看「有没有内容」，不看 userTexts 是否为空：只有一句「hi」的轮也是有效记录。
  const hasUser = t.userTexts.some(x => String(x || '').trim());
  if (!hasUser && !t.texts.length && !t.reasonings.length && !t.tools.length && !t.errMsg) return null;
  if (t.tools.length) t.toolNames = toolNameCounts(t.tools);
  t.time = t.time || Number(s.time_created) || 0;   // 兜底：全部 message 都没时间戳时才用会话时间
  t.preview = turnPreview(t);
  t.name = t.sTitle || '';
  return t;
}

// 把一次扫描的结果灌成条目。与 opencode 的 emit 同款：末尾把「库没了 / 这轮不再出现的 id」清掉，
// 否则删掉的会话会一直挂在页面上（原实现只 add 不删）。
// 一条 entry = 一轮（见 scanMimocodeDb 的口径注释）。
function emitMimocodeDb(agent, dbPath, data, prevData) {
  const list = data.list || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const id = 'mc#' + r.key;
    addEntry(id, {
      agent, project: r.project, session: r.session,
      time: r.time,
      // dur 与 claude/opencode 同口径：**毫秒**（页面 fmtDur 按毫秒渲染，旧实现写的是秒）
      dur: Math.max(0, (r.endTs || r.lastTs || r.time) - r.time),
      status: r.failed ? 'error' : (r.aborted ? 'canceled' : 'ok'),
      tin: r.tin, tout: r.tout, tcache: r.tcache, total: r.total,
      rounds: r.calls,                    // 轮内 LLM 调用数（= 轮内 assistant message 数）
      tools: r.tools.length, calls: r.calls,
      models: r.models,
      preview: r.preview,
      finished: r.finished, aborted: r.aborted, toolNames: r.toolNames || {},
      ctx: 0, ctxUsed: null,
      name: r.sTitle ? (r.sTitle + ' · 第 ' + (i + 1) + ' 轮') : ('第 ' + (i + 1) + ' 轮'),
      nollm: r.calls === 0,             // 只有 user 消息、还没有任何回复
      mimoKind: 'db',
    }, { file: dbPath, turn: i, kind: 'mimocode' });
  }
  // 清理上一轮存在、这一轮不再出现的条目（会话/消息被删）
  const keep = new Set(data.ids || []);
  for (const old of prevData?.ids || []) {
    if (keep.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  sorted.cache = null;
}

// ---------- markdown 兜底（库读不动时）----------
function scanMimocodeMarkdown(agent, root) {
  let mem = root;
  if (!isDir(path.join(mem, 'sessions')) && !isDir(path.join(mem, 'projects')) && !isDir(path.join(mem, 'global'))) {
    const d = path.join(mem, 'memory');
    if (isDir(d)) mem = d;
  }
  const sDir = path.join(mem, 'sessions');
  if (isDir(sDir)) {
    for (const sid of listDirCached(sDir) || []) {
      const sd = path.join(sDir, sid);
      if (!isDir(sd)) continue;
      try { scanMimocodeSessionMd(agent, mem, sid, sd); } catch (e) { console.error('[mimocode] md session', sid, e.message); }
    }
  }
  const pDir = path.join(mem, 'projects');
  if (isDir(pDir)) for (const pid of listDirCached(pDir) || []) {
    const mdP = path.join(pDir, pid, 'MEMORY.md');
    if (isFile(mdP)) try { scanMimocodeProjectMd(agent, mem, pid, mdP, false); } catch (e) { console.error('[mimocode] md project', pid, e.message); }
  }
  const gMd = path.join(mem, 'global', 'MEMORY.md');
  if (isFile(gMd)) try { scanMimocodeProjectMd(agent, mem, 'global', gMd, true); } catch (e) { console.error('[mimocode] md global', e.message); }
  markKind('mimocode');
}

function scanMimocodeSessionMd(agent, root, sessId, sessDir) {
  const session = sessId, project = 'mimocode:' + sessId;
  const idBase = 'mc#' + path.join(root, sessId).replace(/[\\/:]/g, '~') + '#';
  const stat = p => { try { return fs.statSync(p); } catch { return null; } };
  const cp = path.join(sessDir, 'checkpoint.md'); const cpSt = stat(cp);
  if (cpSt && cpSt.isFile()) {
    let text = ''; try { text = fs.readFileSync(cp, 'utf8'); } catch {}
    const data = parseCheckpoint(text); data.sessId = sessId; data.mtime = cpSt.mtimeMs;
    files.set(cp, { agent, kind: 'mimocode', m: cpSt.mtimeMs, s: cpSt.size, off: 0, data });
    emitCheckpointMd(agent, cp, root, sessId, session, project, data);
  }
  const nt = path.join(sessDir, 'notes.md'); const ntSt = stat(nt);
  if (ntSt && ntSt.isFile()) {
    let text = ''; try { text = fs.readFileSync(nt, 'utf8'); } catch {}
    const data = parseNotes(text, ntSt);
    files.set(nt, { agent, kind: 'mimocode', m: ntSt.mtimeMs, s: ntSt.size, off: 0, data });
    emitNotesMd(agent, nt, root, sessId, session, project, data);
  }
  const tasksDir = path.join(sessDir, 'tasks');
  if (isDir(tasksDir)) for (const tid of listDirCached(tasksDir) || []) {
    const pr = path.join(tasksDir, tid, 'progress.md'); const prSt = stat(pr);
    if (!prSt || !prSt.isFile()) continue;
    let text = ''; try { text = fs.readFileSync(pr, 'utf8'); } catch {}
    const data = { text, mtime: prSt.mtimeMs, tid, mimoKind: 'task' };
    files.set(pr, { agent, kind: 'mimocode', m: prSt.mtimeMs, s: prSt.size, off: 0, data });
    emitTaskMd(agent, pr, root, sessId, session, project, tid, data);
  }
}
function emitCheckpointMd(agent, fp, root, sessId, session, project, data) {
  const id = 'mc#' + path.join(root, sessId).replace(/[\\/:]/g, '~') + '#checkpoint';
  const active = (data.sections && data.sections['§1']) ? data.sections['§1'].trim() : '';
  addEntry(id, { agent, project, session, time: data.mtime || 0, dur: 0, status: 'ok', tin: 0, tout: 0, tcache: 0, total: 0, rounds: 0, tools: 0, calls: 0, models: [], preview: ('📌 检查点 · ' + (active || (data.title || '无活动意图'))).slice(0, 300), finished: false, aborted: false, toolNames: {}, ctx: 0, ctxUsed: null, name: data.title || ('检查点 · ' + sessId), mimoKind: 'checkpoint' }, { file: fp, turn: 0, kind: 'mimocode' });
}
function emitNotesMd(agent, fp, root, sessId, session, project, data) {
  const idBase = 'mc#' + path.join(root, sessId).replace(/[\\/:]/g, '~') + '#note';
  data.turns.forEach((t, i) => {
    const id = idBase + i;
    const bp = (t.body || '').replace(/\s+/g, ' ').slice(0, 300);
    addEntry(id, { agent, project, session, time: t.time || data.mtime || 0, dur: 0, status: 'ok', tin: 0, tout: 0, tcache: 0, total: 0, rounds: 0, tools: 0, calls: 0, models: [], preview: ('📝 turn ' + t.n + (t.ts ? ' · ' + t.ts : '') + (bp ? ' · ' + bp : '')).slice(0, 300), finished: false, aborted: false, toolNames: {}, ctx: 0, ctxUsed: null, name: '笔记 turn ' + t.n, mimoKind: 'note' }, { file: fp, turn: i, kind: 'mimocode' });
  });
}
function emitTaskMd(agent, fp, root, sessId, session, project, tid, data) {
  const id = 'mc#' + path.join(root, sessId).replace(/[\\/:]/g, '~') + '#task#' + tid;
  const head = (data.text.split('\n').find(l => l.trim() && !l.trim().startsWith('#')) || '').trim();
  const bp = data.text.replace(/\s+/g, ' ').slice(0, 300);
  addEntry(id, { agent, project, session, time: data.mtime || 0, dur: 0, status: 'ok', tin: 0, tout: 0, tcache: 0, total: 0, rounds: 0, tools: 0, calls: 0, models: [], preview: ('🗂 任务 ' + tid + (head ? ' · ' + head : '') + (bp ? ' · ' + bp : '')).slice(0, 300), finished: false, aborted: false, toolNames: {}, ctx: 0, ctxUsed: null, name: '任务 ' + tid, mimoKind: 'task' }, { file: fp, turn: 0, kind: 'mimocode' });
}
function scanMimocodeProjectMd(agent, root, pid, mdPath, isGlobal) {
  const session = isGlobal ? 'global' : ('proj-' + pid);
  const project = isGlobal ? 'mimocode:global' : ('mimocode:proj-' + pid);
  let st; try { st = fs.statSync(mdPath); } catch { return; }
  let text = ''; try { text = fs.readFileSync(mdPath, 'utf8'); } catch { return; }
  const data = { text, mtime: st.mtimeMs, pid, mimoKind: isGlobal ? 'global' : 'project' };
  files.set(mdPath, { agent, kind: 'mimocode', m: st.mtimeMs, s: st.size, off: 0, data });
  const id = 'mc#' + path.join(path.dirname(mdPath), path.basename(mdPath, '.md')).replace(/[\\/:]/g, '~') + '#mem';
  const head = (text.split('\n').find(l => l.trim() && !l.trim().startsWith('#')) || '').trim();
  addEntry(id, { agent, project, session, time: data.mtime || 0, dur: 0, status: 'ok', tin: 0, tout: 0, tcache: 0, total: 0, rounds: 0, tools: 0, calls: 0, models: [], preview: ('📚 ' + (isGlobal ? '全局记忆' : ('项目记忆 · ' + pid)) + (head ? ' · ' + head : '')).slice(0, 300), finished: false, aborted: false, toolNames: {}, ctx: 0, ctxUsed: null, name: isGlobal ? '全局记忆' : ('项目记忆 · ' + pid), mimoKind: isGlobal ? 'global' : 'project' }, { file: mdPath, turn: 0, kind: 'mimocode' });
}
function parseCheckpoint(text) {
  const lines = text.split('\n'); let title = ''; const sections = {}; let cur = null;
  for (const ln of lines) {
    const t = ln.trim();
    if (!title && /^Topic:\s*(.+)$/i.test(t)) title = t.replace(/^Topic:\s*/i, '').trim();
    const sm = /^##\s+(§\d+[^\n]*)/.exec(t);
    if (sm) { cur = sm[1].trim(); sections[cur] = ''; continue; }
    if (cur != null) sections[cur] += ln + '\n';
  }
  return { title, sections };
}
function parseNotes(text, st) {
  const turns = []; const re = /^##\s*\[\s*turn\s+(\d+)\s*·\s*([^\]]*)\]/i; let cur = null;
  const TS_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
  for (const ln of text.split('\n')) {
    const m = re.exec(ln.trim());
    if (m) { if (cur) turns.push(cur); const ts = m[2].trim(); const t = TS_RE.exec(ts); cur = { n: Number(m[1]), ts, time: t ? Date.parse(t[1].replace(' ', 'T')) : 0, body: '' }; }
    else if (cur) cur.body += ln + '\n';
  }
  if (cur) turns.push(cur);
  return { turns, mtime: st ? st.mtimeMs : 0 };
}

// ---------- 主入口 ----------
export function scanMimocode(agent, root) {
  const db = findDb(root);
  if (db && scanMimocodeDb(agent, db)) return;     // 真源优先
  log('[mimocode] 走 markdown 兜底（库不存在或读不动）');
  scanMimocodeMarkdown(agent, root);
}

// ---------- 详情 ----------
// 库分支的「一轮」：正文与工具都在扫描时就切好放在 list[turn] 里（不必重开库）。
export function mimocodeEntryContent(src, full) {
  const st = files.get(src.file);
  if (!st) return null;
  const data = st.data || {};
  const fi = {}, fo = {};
  // 库分支（mimoKind='db'）：src.turn 是 data.list 的下标（一项 = 一轮）
  if (data.mimoKind === 'db') {
    const r = (data.list || [])[src.turn];
    if (!r) return null;
    const tools = (r.tools || []).map(t => {
      const tin = {}, tout = {};
      return {
        name: t.name, tid: t.callID || '', error: t.status === 'error',
        dur: (t.end && t.start) ? Math.max(0, t.end - t.start) : 0,   // 毫秒（与条目 dur 同口径）
        input: trunc(t.input, full, tin), inputTrunc: !!tin.t,
        output: trunc(t.output, full, tout), outputTrunc: !!tout.t,
      };
    });
    // user：剥掉 <system-reminder> 注入块（否则「用户输入」显示的是运行上下文，见 stripInject）
    const userRaw = (r.userTexts || []).join('\n');
    const userStripped = stripInject(userRaw);
    const user = userStripped || userRaw.trim();
    const assistant = ([...r.reasonings.map(x => '💭 ' + x), ...r.texts].join('\n\n')).trim();
    // LLM 调用明细：逐次（轮内每次 assistant message 一条），与 opencode 的 calls 同形
    const calls = (r.callList || []).map(c => {
      const ft = {};
      const text = trunc(c.text, full, ft);
      const o = {
        model: c.model, tin: c.tin, tout: c.tout, tcache: c.tcache, dur: c.dur,
      };
      if (text) { o.text = text; if (ft.t) o.textTrunc = true; }
      if (c.error) o.error = c.error;
      if (c.finishReason && c.finishReason !== 'stop') o.finishReason = c.finishReason;
      return o;
    });
    // 每次调用发起了哪些工具（页面调用行上用 toolText 展示）——按 tools[].call 分组
    for (let ci = 0; ci < calls.length; ci++) {
      const names = (r.tools || []).filter(t => t.call === ci).map(t => t.name);
      if (names.length) calls[ci].tools = names;
    }
    const note = 'mimocode 助手回复（来自 mimocode.db message 表；token 取自 message.data.tokens，reasoning 计入输出）。';
    const out = {
      user: trunc(user, full, fi), assistant: trunc(assistant, full, fo), tools, calls,
      note: r.calls === 0 ? '这一轮只有你的输入，还没有任何模型回复（mimocode.db）。' : note,
      v: 'mc' + src.turn,
    };
    if (r.errTools) out.callsNote = '这一轮有 ' + r.errTools + ' 次工具调用失败。';
    return out;
  }
  // 旧形状兜底（mimoKind='message'）：内存里若还留着升级前扫描的结果，别让它炸
  if (data.mimoKind === 'message') {
    const ps = data.ps || [];
    const texts = ps.filter(p => p.type === 'text').map(p => p.text || '');
    const reasonings = ps.filter(p => p.type === 'reasoning').map(p => p.text || '');
    const tools = ps.filter(p => p.type === 'tool').map(p => ({
      name: p.tool || '?', tid: p.callID || '', error: p.state?.status === 'error',
      input: p.state?.input != null ? JSON.stringify(p.state.input) : '',
      output: p.state?.output != null ? String(p.state.output) : '',
      dur: (p.time?.end && p.time?.start) ? Math.max(0, Math.round((p.time.end - p.time.start) / 1000)) : 0,
    }));
    const user = (data.role === 'user') ? texts.join('\n') : '';
    const assistant = (data.role === 'assistant' || data.role === 'unknown')
      ? ([...reasonings.map(r => '💭 ' + r), ...texts].join('\n\n')).trim() : '';
    const calls = tools.map(t => ({ text: ('#' + t.name + (t.error ? ' [失败]' : '') + (t.input ? '\n入参: ' + t.input : '') + (t.output ? '\n返回: ' + t.output.slice(0, 4000) : '')), tool: t.name, error: t.error, dur: t.dur }));
    const note = data.role === 'user' ? 'mimocode 用户消息（来自 mimocode.db message 表）。' : 'mimocode 助手回复（来自 mimocode.db message 表；token 取自 message.data.tokens）。';
    return { user: trunc(user, full, fi), assistant: trunc(assistant, full, fo), tools, calls, note, v: 'mc' + src.turn };
  }
  // markdown 兜底分支（data 形状同上）
  if (data.sections) {
    const sec = data.sections || {};
    const body = Object.keys(sec).map(k => '## ' + k + '\n\n' + sec[k].trim()).join('\n\n');
    return { user: '', assistant: body, tools: [], calls: [], note: 'mimocode 检查点快照（§1~§11）。本源为记忆文件，不含 token 与工具调用数据。', v: 'mc' + src.turn };
  }
  if (Array.isArray(data.turns)) { const t = data.turns[src.turn]; return { user: '', assistant: t ? ('turn ' + t.n + (t.ts ? ' · ' + t.ts : '') + '\n\n' + (t.body || '').trim()) : '', tools: [], calls: [], note: 'mimocode 会话笔记的一条记录。', v: 'mc' + src.turn }; }
  const txt = (data.text || '').trim();
  return { user: '', assistant: txt, tools: [], calls: [], note: data.mimoKind === 'global' ? 'mimocode 全局记忆（global/MEMORY.md）。' : data.mimoKind === 'task' ? 'mimocode 任务进度（tasks/<id>/progress.md）。' : 'mimocode 项目记忆（projects/<pid>/MEMORY.md）。', v: 'mc' + src.turn };
}
function trunc(s, full, flag) {
  s = toText(s);
  if (full || s.length <= 8000) return s;
  flag.t = true;
  return s.slice(0, 8000);
}
