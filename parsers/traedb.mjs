// ---------------- traedb 解析器（Trae CN / Trae Work 的 SQLCipher 会话库） ----------------
// 数据源：<产品根>/ModularData/ai-agent/database.db —— SQLCipher 4.x 加密的 SQLite 库
//   （产品根 = %APPDATA%/Trae CN 或 %APPDATA%/Trae Work；用户把数据挪走时以实际路径为准）
//
// 为什么值得为它写一个解析器（而不再是「读不了，只能看 renderer.log」）：
//   renderer.log 只有事件元数据（谁提问、调了什么工具、结束状态），没有 token、没有逐次调用、
//   没有 AI 输出正文；而这张库里什么都有 —— 逐轮的 prompt/completion/cache 精确用量（
//   server_history_info.extra_info 的 exact_* 字段）、每次工具调用的入参与返回（chat_message_task
//   的 plan_item JSON）、每轮的用户输入与最终回答、项目路径、会话标题。差异不是「多一点少一点」，
//   是「整张卡片从空的变成满的」。密钥说明见 REFERENCE.md「Trae 的 SQLCipher 库」一节。
//
// SQLCipher 解密（纯 JS，零依赖；参数取自 sqlcipher.c 与实测爆破）：
//   · 页面 4096 字节；page1 头 16 字节是 salt（明文，不参与加密），其余页从 0 起
//   · 尾 80 字节 = IV(16) + HMAC-SHA512(64)；HMAC 输入 = 密文+IV + 页号(LE u32)
//   · AES 密钥 = 32 字节原始密钥（raw key 模式，x'...'）；HMAC 密钥 = PBKDF2(kdf, key, salt^0x3a, 2, 32)
//   · WAL 的帧头是**大端**（salt 对不上的是上一代残留帧，忽略；只重放到最后一个提交帧）
//   参数组合有个小矩阵（kdf sha512/256/1 × fast_iter 2/1 × HMAC sha512/256/1 × 页号 LE/BE ×
//   页大小 4096/8192/2048/1024/16384），用 page1+page2 双页 HMAC 确认真命中的那一组 ——
//   本机实测 4.5.7 落在 (sha512, 2, sha512, LE, 4096)，但别的 Trae 版本/未来版本不保证，
//   探测一次的成本是几十毫秒，好过写死一组参数后在新版本上静默读不出来。
//
// 解密纪律：**只读**（fs.readFileSync 一份副本，原件一个字节不碰）；解密结果写进 os.tmpdir 的
//   临时文件（node:sqlite 只认文件路径），查询完在 finally 里删除 —— 明文不在磁盘上留驻。
//
// 切轮与字段口径（对照真实库逐一验证过）：
//   chat_turn 一行 = 一轮；reply_to_message_id = 用户消息、response_message_id = 助手消息
//   · 用户输入  chat_message_general.content = [{type:'text', text_content}] 按 message_id 取
//   · 助手正文  response 消息按 message_type 分三种落点：
//         task → chat_message_task.content JSON 里最后一个 plan_item 的 tool_call_info.name='finish'，
//                正文在它的 params（JSON 字符串）的 summary 字段；没有 finish（未跑完/被取消）取最后一条 thought
//         chat → chat_message_chat.content JSON 的 content 字段（2025 老会话）
//         general → 同上 general 格式
//   · 工具      task JSON 的 plan_item（tool_call_info.name ≠ finish）：入参 params、返回 result、
//                耗时取 timing.{tool_call_started_at_ms, tool_call_finished_at_ms}（老库没有 timing，dur=0）
//   · token     server_history_info 里 session_id == 该轮 reply_to_message_id 的行：
//                source='llm_default' 的行 = 一次 LLM 调用（extra_info.exact_* 是精确用量），
//                其余 source（工具名/user_input/…）是历史条目不是调用。轮级 = 逐次求和：
//                tin = Σ(prompt − cache_read)（cache_read 单列进 tcache，与 claude 同口径）、
//                tout = Σ output、ctxUsed = 最后一次调用的 prompt（含 cache，与 claude/kimi 同口径）
//                —— 2025 老会话没有这些行（源头就没记），token 恒 0，详情页用 callsNote 说明
//   · 项目      chat_session.project_id → project.absolute_path；查不到时回退 turn.context 里的
//                references/workspace_folders
//   · 会话名    fts_session_title（增量同步的全文索引表，标题跟着 Trae UI 走）；没有就退回 chat_session.session_title
//
// 增量：SQLite 没有字节偏移语义，且 WAL 模式下新数据先落在 database.db-wal（库文件 mtime 不动），
//   所以签名 = db 与 wal 的 {mtime,size} 四元组，变了才整份重解密 —— 与 zcode / gemini 同一路数。
//   库体量比 zcode 大（本机 12MB / 3000 页），但纯 JS 解密的成本在几十毫秒量级，3s 一轮的节奏下
//   只有 Trae 正在写库的那几秒会付这份成本。traedb 因此**不进 OFF_KINDS**（内存重建，无需 PARSER_REV）。
//
// 与 renderer.log（tracecode/tracework）的关系：两者覆盖同一批会话（新版 Trae 两个都写），
//   同时上线就是每轮两张重复卡片 —— 二选一由主文件的数据源切换逻辑保证（db 能用就用 db，
//   读不出来才回退日志，并清掉另一边的条目）。本文件只负责「db 这条路」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { files, entries, srcs, removedIds, sorted, addEntry, toolNameCounts, modelName, trunc, sqliteMod } from './shared.mjs';

// 每个 agent 最近一次 traedb 扫描的失败原因（诊断页「已接入 · 0 条」或回退 renderer.log 时展示）
export const traeDbErr = new Map();

function traeDbJson(raw) { try { return JSON.parse(raw); } catch { return null; } }

// ---------------- SQLCipher 解密 ----------------
const PAGE_SIZES = [4096, 8192, 2048, 1024, 16384];   // 4096 是 SQLCipher 默认，探测顺序按命中概率
const KEY_RE = /^[0-9a-f]{64}$/i;                     // raw key 模式：32 字节 = 64 位十六进制

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

// 密码参数矩阵：与 rawdec.cjs（对着真实库验证过的那份）保持同一套组合
const KDFS = ['sha512', 'sha256', 'sha1'];
const FAST_ITERS = [2, 1];
const HMAC_ALGOS = [
  { algo: 'sha512', hs: 64, reserve: 80 },
  { algo: 'sha256', hs: 32, reserve: 48 },
  { algo: 'sha1', hs: 20, reserve: 48 },
];
const PGNOS = [{ f: u32le }, { f: u32be }];

// HMAC 覆盖范围：密文 + IV（IV 就是尾段 reserve 的头 16 字节）。page1 的前 16 字节是 salt，不属于密文。
// 页号编码跟着探测结果走（LE 是 4.5.x 默认；PGNOS 矩阵里两种都试）。
function hmacInput(page, pgno, ps, reserve) {
  const base = pgno === 1 ? 16 : 0;
  return page.subarray(base, ps - reserve + 16);
}
function hmacCheck(page, pgno, ps, reserve, hs, algo, hk, pgnoF) {
  const got = crypto.createHmac(algo, hk).update(Buffer.concat([hmacInput(page, pgno, ps, reserve), pgnoF(pgno)])).digest();
  const stored = page.subarray(ps - reserve + 16, ps - reserve + 16 + hs);
  return got.length === stored.length && got.equals(stored);
}

// 用 page1+page2 的 HMAC 从矩阵里确诊实际参数（两页都验上才算赢家；单页库只验 page1）
function detectParams(raw, key) {
  const salt = raw.subarray(0, 16);
  const saltXor = Buffer.from(salt.map(b => b ^ 0x3a));
  for (const ps of PAGE_SIZES) {
    if (raw.length < ps) continue;
    const p1 = raw.subarray(0, ps);
    const hasP2 = raw.length >= ps * 2;
    for (const kdf of KDFS) for (const fit of FAST_ITERS) {
      let hk;
      try { hk = crypto.pbkdf2Sync(key, saltXor, fit, 32, kdf); } catch { continue; }
      for (const hc of HMAC_ALGOS) for (const pg of PGNOS) {
        if (!hmacCheck(p1, 1, ps, hc.reserve, hc.hs, hc.algo, hk, pg.f)) continue;
        if (hasP2 && !hmacCheck(raw.subarray(ps, ps * 2), 2, ps, hc.reserve, hc.hs, hc.algo, hk, pg.f)) continue;
        return { ps, kdf, fit, hc, pgnoF: pg.f };
      }
    }
  }
  return null;
}

function decryptPage(page, pgno, ps, reserve, key) {
  const base = pgno === 1 ? 16 : 0;
  const iv = page.subarray(ps - reserve, ps - reserve + 16);
  const ct = page.subarray(base, ps - reserve);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false);
  const pt = Buffer.concat([d.update(ct), d.final()]);
  const out = Buffer.alloc(ps);
  if (pgno === 1) Buffer.from('SQLite format 3\0', 'latin1').copy(out, 0);
  pt.copy(out, base);
  return out;
}

// 解整库（含 WAL 重放）。返回 { ok:true, buf } 或 { ok:false, why }。
// why 的措辞会直接进诊断页，必须能区分「密钥不对」与「库在写/结构异常」——两种情况的下一步完全不同。
function decryptTraeDb(raw, keyHex, walPath) {
  let key; try { key = Buffer.from(keyHex, 'hex'); } catch { key = null; }
  if (!key || key.length !== 32) return { ok: false, why: '密钥格式不对（需要 64 位十六进制字符）' };
  if (raw.length < 1024) return { ok: false, why: '库文件太小，不像 SQLCipher 库' };
  const params = detectParams(raw, key);
  if (!params) return { ok: false, why: '密钥不对（也可能是新版换了加密参数）：页面 HMAC 全部未命中' };
  const { ps, kdf, fit, hc, pgnoF } = params;
  const hk = crypto.pbkdf2Sync(key, Buffer.from(raw.subarray(0, 16).map(b => b ^ 0x3a)), fit, 32, kdf);

  const totalPages = Math.floor(raw.length / ps);
  const pages = new Array(totalPages + 1);   // 1-based
  for (let i = 1; i <= totalPages; i++) {
    const page = raw.subarray((i - 1) * ps, i * ps);
    if (!hmacCheck(page, i, ps, hc.reserve, hc.hs, hc.algo, hk, pgnoF)) continue;
    pages[i] = decryptPage(page, i, ps, hc.reserve, key);
  }
  if (!pages[1]) return { ok: false, why: '第 1 页校验失败：库可能正在被 Trae 重写（下一轮扫描会自动重试）' };
  // 逻辑页数在解出来的 page1 头（offset 28, BE）。物理可能比它大（末尾残留空间），
  // 校验只要求 1..logical 全部完好；logical 之后的页不必读。
  const logical = pages[1].readUInt32BE(28) || totalPages;
  // usable 范围内的坏页 = 读到了写一半的库（文件正在被替换/truncate）。宁可这一轮不更新，
  // 也不能拿一份缺页的库去查表 —— 缺的可能是索引页，查询会给出错误结果。
  let usableBad = 0;
  for (let i = 1; i <= Math.min(totalPages, logical); i++) if (!pages[i]) usableBad++;
  if (usableBad > 0) return { ok: false, why: '库中有 ' + usableBad + ' 页校验失败（Trae 正在写入），下一轮会自动重试' };

  let finalPages = logical;
  // ---- WAL 重放（帧头大端；与主库同一套页加密，pgno=1 同样跳过 16 字节 salt） ----
  if (walPath && fs.existsSync(walPath)) {
    try {
      const wal = fs.readFileSync(walPath);
      if (wal.length > 32) {
        const frameSz = 24 + ps;
        const nFrames = Math.floor((wal.length - 32) / frameSz);
        const s1 = wal.readUInt32BE(16), s2 = wal.readUInt32BE(20);
        const frames = [];
        for (let i = 0; i < nFrames; i++) {
          const off = 32 + i * frameSz;
          const pgno = wal.readUInt32BE(off);
          const dbsize = wal.readUInt32BE(off + 4);
          if (wal.readUInt32BE(off + 8) !== s1 || wal.readUInt32BE(off + 12) !== s2) continue; // 上一代残留帧
          const data = wal.subarray(off + 24, off + 24 + ps);
          if (pgno < 1 || pgno > 1e7) continue;
          if (!hmacCheck(data, pgno, ps, hc.reserve, hc.hs, hc.algo, hk, pgnoF)) continue;
          frames.push({ pgno, dbsize, data });
        }
        let lastCommit = -1;
        for (let k = 0; k < frames.length; k++) if (frames[k].dbsize > 0) lastCommit = k;
        if (lastCommit >= 0) {
          for (let k = 0; k <= lastCommit; k++) {
            const f = frames[k];
            pages[f.pgno] = decryptPage(f.data, f.pgno, ps, hc.reserve, key);
          }
          finalPages = frames[lastCommit].dbsize || finalPages;
        }
      }
    } catch { /* WAL 读不了就当没有：主库本身仍是自洽的一份 */ }
  }

  const out = Buffer.alloc(finalPages * ps);
  for (let i = 1; i <= finalPages; i++) if (pages[i]) pages[i].copy(out, (i - 1) * ps);
  out.writeUInt32BE(finalPages, 28);
  return { ok: true, buf: out, note: 'ps=' + ps + ' kdf=' + kdf + '/' + fit + ' hmac=' + hc.algo + ' pages=' + finalPages };
}

// ---------------- 查询与装配 ----------------
// 内容表 → message_id 映射（三张表按 message_type 拆分，键不重叠）
function contentMap(qAll, table) {
  const m = new Map();
  for (const r of qAll('SELECT message_id, content FROM ' + table) || []) {
    if (r && typeof r.message_id === 'string') m.set(r.message_id, r.content);
  }
  return m;
}

// general 格式：[{type:'text', text_content}] —— 用户输入与（老会话的）助手正文共用
function generalText(content) {
  const j = traeDbJson(content);
  if (!Array.isArray(j)) return '';
  const out = [];
  for (const b of j) {
    if (b && typeof b.text_content === 'string' && b.text_content.trim()) out.push(b.text_content);
    else if (b && b.type === 'image') out.push('[图片]');
  }
  return out.join('\n');
}

const TRAE_TOOL_SKIP = new Set(['finish']);   // finish 不是真工具，它的正文是助手回答
const TRAE_OTHER_SOURCES = new Set(['user_input', 'llm_default', 'new_context', 'task_notification', 'summary', 'system']);

// task JSON（chat_message_task.content）→ 助手正文 + 工具列表 + others 锚点
function parseTaskContent(content, out) {
  const j = traeDbJson(content);
  if (!j || !Array.isArray(j.messages)) return false;
  let finishText = '', lastThought = '';
  for (const m of j.messages) {
    if (!m) continue;
    if (m.type === 'finish' && typeof m.content === 'string') { finishText = finishText || m.content; continue; }  // 老格式
    if (m.type === 'proposal' && m.proposal) {
      const p = traeDbJson(m.proposal);
      out.others.push({ type: 'proposal', t: out.lastTs, json: JSON.stringify(p ? (p.content?.thought || p.content || p) : m.proposal).slice(0, 2000) });
      continue;
    }
    const pi = m.plan_item || m;   // 新版是 {type:'plan_item', plan_item:{...}}，patience 容错：直接就是 plan_item 形状时也认
    if (!pi || typeof pi !== 'object') continue;
    const tci = pi.tool_call_info;
    const timing = (pi.timing && typeof pi.timing === 'object') ? pi.timing : null;
    if (tci && typeof tci.name === 'string') {
      if (TRAE_TOOL_SKIP.has(tci.name)) {
        // finish：正文优先取 params.summary（上游就是这么存的），退回 result.data.summary、再退 thought
        let summary = '';
        const pj = typeof tci.params === 'string' ? traeDbJson(tci.params) : tci.params;
        if (pj && typeof pj.summary === 'string') summary = pj.summary;
        if (!summary && tci.result && typeof tci.result === 'object' && tci.result.data && typeof tci.result.data.summary === 'string') summary = tci.result.data.summary;
        if (!summary) summary = typeof pi.thought === 'string' ? pi.thought : '';
        if (summary && !finishText) finishText = summary;
        continue;
      }
      const st = tci.result && typeof tci.result === 'object' ? tci.result.status : null;
      const started = timing && timing.tool_call_started_at_ms, finished = timing && timing.tool_call_finished_at_ms;
      const tool = {
        name: tci.name,
        tid: (tci.meta && tci.meta.llm_toolcall_id) || tci.id || null,
        ct: started || (timing && timing.generated_at_ms) || 0,
        input: typeof tci.params === 'string' ? tci.params : JSON.stringify(tci.params ?? ''),
        output: tci.result != null ? (typeof tci.result === 'string' ? tci.result : JSON.stringify(tci.result)) : '',
        error: (st && st !== 'success') ? String((tci.result && tci.result.error_message) || st) : null,
        dur: (started && finished && finished > started) ? finished - started : 0,
      };
      out.tools.push(tool);
    }
    if (typeof pi.thought === 'string' && pi.thought.trim()) lastThought = pi.thought;
    if (typeof pi.reasoning_content === 'string' && pi.reasoning_content) {
      out.others.push({ type: 'reasoning', t: (timing && timing.generated_at_ms) || out.lastTs, json: JSON.stringify({ len: pi.reasoning_content.length }) });
    }
  }
  out.assistant = finishText || lastThought;
  return true;
}

// models[] 去重：大小写不敏感（同一模型在 user_message_context 与 server_history_info 里可能
// 一个写配置名、一个写产品展示名），先到者胜出（用户消息的 model_info 先处理，名字更友好）
function modelOf(t, name) {
  const n = modelName(name);
  if (!n) return '';
  const k = n.toLowerCase();
  const hit = t.models.find(m => m.toLowerCase() === k);
  if (hit) return hit;
  t.models.push(n);
  return n;
}

// 单轮装配（把两个来源 —— 任务 JSON 与用量行 —— 合进 out）
function buildTurn(row, ctx) {
  const t = {
    sid: row.session_id, key: row.turn_id, time: 0, lastTs: 0, endTs: 0,
    user: '', assistant: '', preview: '', name: ctx.name, project: ctx.project,
    tools: [], calls: [], events: [], others: [],
    models: [], ctxWin: ctx.ctxWin || 0, ctxUsed: 0,
    tin: 0, tout: 0, tcache: 0, err: false, errMsg: '', aborted: false, live: false, finish: false,
  };
  const c = traeDbJson(row.context) || {};
  const startMs = c.chat_start_time || (row.created_at || 0) * 1000;
  const endMs = c.chat_end_time || (row.updated_at || 0) * 1000;
  t.time = startMs; t.lastTs = endMs; t.endTs = endMs;
  const st = String(row.turn_status || '');
  t.live = st === 'in_progress';
  t.aborted = st === 'canceled';
  if (row.error_message) { t.err = true; t.errMsg = String(row.error_message); }
  else if (st && !['completed', 'canceled', 'in_progress'].includes(st)) { t.err = true; t.errMsg = 'turn_status=' + st; }
  return t;
}

export function scanTraeDb(agent, dbPath, keyHex) {
  const key = dbPath;
  let dst; try { dst = fs.statSync(dbPath); } catch { traeDbErr.set(agent, '数据库不存在：' + dbPath); return 'fail'; }
  // 密钥检查放在最前：用户把 traeKey 删掉/改错后必须立刻走「回退 renderer.log」这条路，
  // 不能被下面的「库没变就不重解析」短路留住 —— 那会让「我已经关了它」的意图看不出来。
  const k = String(keyHex || '').trim();
  if (!KEY_RE.test(k)) { traeDbErr.set(agent, '未配置 traeKey（或格式不对），已回退日志解析'); return 'nokey'; }
  const kh = crypto.createHash('sha256').update(k).digest('hex');
  let wst = null; try { wst = fs.statSync(dbPath + '-wal'); } catch {}   // WAL 可能已被 checkpoint 掉，没有是正常的
  const sig = dst.mtimeMs + '|' + dst.size + '|' + (wst ? wst.mtimeMs + '|' + wst.size : '-');
  const prev = files.get(key);
  if (prev && prev.data.sig === sig && prev.data.keyHash === kh) {
    // 库没变（密钥也没换）就不重解析 —— 但条目可能被 LRU 淘汰过（同 zcode：按最后一轮补回）
    const last = prev.data.turns[prev.data.turns.length - 1];
    if (last && !entries.has(traeDbIdBase(key) + last.sid.replace(/#/g, '~') + '#' + last.key)) emitTraeDbTurns(agent, key, prev.data, null);
    traeDbErr.delete(agent);
    return prev.data.turns.length ? 'ok' : 'empty';
  }

  const mod = sqliteMod();
  if (!mod) { traeDbErr.set(agent, '当前 Node 没有 node:sqlite（需要 22.5+）'); return 'fail'; }

  let tmp = null;
  try {
    const raw = fs.readFileSync(dbPath);
    const dec = decryptTraeDb(raw, k, dbPath + '-wal');
    if (!dec.ok) { traeDbErr.set(agent, dec.why); return 'fail'; }

    tmp = path.join(os.tmpdir(), 'agent-log-trae-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.db');
    fs.writeFileSync(tmp, dec.buf, { mode: 0o600 });
    const data = { turns: [], sig, keyHash: kh, rev: (prev?.data?.rev || 0) + 1 };
    const db = new mod.DatabaseSync(tmp, { readOnly: true });
    try { data.turns = collectTurns(db); } finally { try { db.close(); } catch {} }
    // 全空的轮不灌条目（打开了没说话的会话）：user/assistant/tools 全无的轮就是噪音
    data.turns = data.turns.filter(t => t.user || t.assistant || t.tools.length || t.errMsg);
    files.set(key, { agent, kind: 'traedb', m: dst.mtimeMs, s: dst.size, off: 0, data });
    traeDbErr.delete(agent);
    emitTraeDbTurns(agent, key, data, prev?.data);
    return data.turns.length ? 'ok' : 'empty';
  } catch (e) {
    // 解密/查询失败：保留上一轮数据，原因写进诊断页，绝不让一张库拖垮整轮扫描
    console.error('[traedb]', e.message);
    traeDbErr.set(agent, e.message);
    return 'fail';
  } finally {
    // node:sqlite 打开 WAL 库时会在同目录建 -shm/-wal 副产物，只删主文件会在 temp 里越积越多
    if (tmp) for (const p of [tmp, tmp + '-shm', tmp + '-wal']) { try { fs.unlinkSync(p); } catch {} }
  }
}

// 一条 SQL 单独容错：库在、但某张表缺失/损坏时，其余表照常解析，不让整库变白
function queryTurns(qAll) {
  // 见文件头「切轮与字段口径」。所有 deleted_at 过滤都用 COALESCE，兼容 NULL 与 0 两种历史写法。
  return {
    sessions: qAll("SELECT session_id, project_id, session_type, session_title, created_at FROM chat_session WHERE COALESCE(deleted_at,0)=0"),
    projects: qAll('SELECT project_id, absolute_path FROM project') || [],
    titles: qAll('SELECT session_id, title FROM fts_session_title') || [],
    turns: qAll("SELECT session_id, turn_id, reply_to_message_id, response_message_id, turn_status, error_message, context, created_at, updated_at, agent_type, agent_name FROM chat_turn WHERE COALESCE(deleted_at,0)=0 ORDER BY created_at"),
    userCtx: qAll("SELECT message_id, user_message_context FROM chat_message WHERE message_role='user' AND COALESCE(deleted_at,0)=0") || [],
    history: qAll("SELECT conversation_id, session_id, source, extra_info, created_at FROM server_history_info WHERE COALESCE(is_deleted,0)=0") || [],
  };
}

function collectTurns(db) {
  const qAll = (sql) => { try { return db.prepare(sql).all(); } catch { return null; } };
  const tb = queryTurns(qAll);
  if (!tb.sessions) throw new Error('读不到 chat_session 表（schema 不兼容或库损坏）');
  const general = contentMap(qAll, 'chat_message_general');
  const chat = contentMap(qAll, 'chat_message_chat');
  const task = contentMap(qAll, 'chat_message_task');

  const projPath = new Map(tb.projects.map(p => [p.project_id, p.absolute_path]));
  const titleOf = new Map(tb.titles.map(r => [r.session_id, (r.title || '').trim()]));
  // 用量行按「会话|用户消息 id」归组 —— server_history_info.session_id 存的就是那一轮的用户消息 id
  const histByTurn = new Map();
  for (const h of tb.history) {
    const k = h.conversation_id + '\u0000' + h.session_id;
    if (!histByTurn.has(k)) histByTurn.set(k, []);
    histByTurn.get(k).push(h);
  }
  const userCtxOf = new Map(tb.userCtx.map(r => [r.message_id, r.user_message_context]));

  const turns = [];
  for (const s of tb.sessions) {
    const title = titleOf.get(s.session_id) || (s.session_title || '').trim();
    // 项目：project 表优先；表里没有（老会话）就等装配时从 turn.context 里找
    const ctxBase = { name: title || null, project: projPath.get(s.project_id) || '' };
    for (const row of tb.turns) {
      if (row.session_id !== s.session_id) continue;
      const t = buildTurn(row, ctxBase);
      // 用户输入
      const uctx = userCtxOf.get(row.reply_to_message_id);
      t.user = generalText(general.get(row.reply_to_message_id));
      if (uctx) {
        const mi = (traeDbJson(uctx) || {}).model_info;
        if (mi) {
          // 名字取 config_name（与 server_history_info 同源，跨来源去重才干净）；没有才退回展示名
          const cn = typeof mi.config_name === 'string' ? mi.config_name : '';
          const dn = typeof mi.display_model_name === 'string' ? mi.display_model_name : '';
          if (cn || dn) modelOf(t, cn || dn);
          // prompt_max_tokens = 源头自己的「最大 prompt」上限，正是这张进度条的分母
          if (typeof mi.prompt_max_tokens === 'number' && mi.prompt_max_tokens > 0) t.ctxWin = mi.prompt_max_tokens;
        }
      }
      // 助手正文与工具
      const am = row.response_message_id;
      if (am && task.has(am)) parseTaskContent(task.get(am), t);
      else if (am && chat.has(am)) {
        const cj = traeDbJson(chat.get(am));
        if (cj && typeof cj.content === 'string') t.assistant = cj.content;
      } else if (am && general.has(am)) t.assistant = generalText(general.get(am));

      // 用量与逐次调用
      const rows = histByTurn.get(s.session_id + '\u0000' + row.reply_to_message_id) || [];
      for (const h of rows) {
        if (h.source === 'llm_default') {
          const ei = traeDbJson(h.extra_info) || {};
          const prompt = Number(ei.exact_prompt_tokens_v1) || 0;
          const out = Number(ei.exact_output_tokens_v1) || 0;
          const cache = Number(ei.exact_cache_read_input_tokens_v1) || 0;
          // 源头的 exact_token_semantics_v1 自己写明 completion_includes_reasoning ——
          // 所以 output 直接就是 tout，不再加 reasoning（加了就是双计）
          const cfg = typeof ei.config_name === 'string' ? ei.config_name : '';
          const call = { model: modelOf(t, cfg) || t.models[0] || '(未知模型)', tin: Math.max(0, prompt - cache), tout: out, tcache: cache, dur: 0, t: (h.created_at || 0) * 1000 };
          t.calls.push(call);
          if (prompt > 0) t.ctxUsed = prompt;   // 最后一次调用胜出（与 claude/kimi 同口径）
          t.events.push({ k: 'llm', t: call.t || t.time, model: call.model, tin: call.tin, tout: call.tout, tcache: cache, dur: 0, err: false, blocks: [] });
        } else if (!TRAE_OTHER_SOURCES.has(String(h.source))) {
          // 工具历史行：source 就是工具名。task JSON 已有工具时只做补充（补名字计数），
          // 没有 task JSON 的老会话才用它兜底成一条纯指标工具。
          if (!t.tools.length) {
            t.tools.push({ name: String(h.source), tid: null, ct: (h.created_at || 0) * 1000, input: '', output: '', error: null, dur: 0 });
          }
        }
      }
      if (!t.calls.length) {
        // 老会话没有 server_history_info：turn.context.token_usage 可能还有最后一笔（有就用，没有就是 0）
        const cj = traeDbJson(row.context) || {};
        const tu = cj.token_usage || {};
        const prompt = Number(tu.prompt_tokens) || 0, out = Number(tu.completion_tokens) || 0, cache = Number(tu.cache_read_input_tokens) || 0;
        if (prompt || out) { t.tin = Math.max(0, prompt - cache); t.tout = out; t.tcache = cache; t.ctxUsed = prompt || 0; }
      } else {
        for (const c of t.calls) { t.tin += c.tin; t.tout += c.tout; t.tcache += c.tcache; }
      }
      // 项目兜底：turn.context 的 workspace_folders / references
      if (!t.project) {
        const cj = traeDbJson(row.context) || {};
        const wf = Array.isArray(cj.workspace_folders) ? cj.workspace_folders : [];
        const refs = Array.isArray(cj.references) ? cj.references : [];
        const p = (wf[0] && (wf[0].path || wf[0].uri)) || (refs[0] && refs[0].uri) || '';
        t.project = p ? (path.dirname(String(p)) || String(p)) : '(Trae)';
      }
      // 事件流：user → 逐次 llm → 工具 call/result → end（与 dsh/zcode 同一 schema）
      t.events.unshift({ k: 'user', t: t.time });
      t.tools.forEach((tool, i) => {
        const ct = tool.ct || t.time;
        t.events.push({ k: 'call', t: ct, name: tool.name, tid: tool.tid, i });
        t.events.push({ k: 'result', t: ct + (tool.dur || 0), tid: tool.tid, i, dur: tool.dur || 0, error: !!tool.error });
      });
      t.events.push({ k: 'end', t: t.endTs || t.lastTs, reason: t.err ? 'error' : (t.aborted ? 'canceled' : (t.live ? 'running' : 'completed')) });
      t.events.sort((a, b) => (a.t - b.t) || 0);
      t.finish = !!t.assistant;
      t.user = t.user.slice(0, 3000);
      t.assistant = t.assistant.slice(0, 20000);
      t.preview = (t.user || t.assistant || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
      turns.push(t);
    }
  }
  return turns;
}

export function traeDbIdBase(key) { return 'td#' + key.replace(/[\\/:]/g, '~') + '#'; }

function emitTraeDbTurns(agent, key, data, prevData) {
  const idBase = traeDbIdBase(key);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = idBase + t.sid.replace(/#/g, '~') + '#' + t.key;
    ids.add(id);
    addEntry(id, {
      agent, project: t.project, session: t.sid,
      time: t.time, dur: Math.max(0, (t.endTs || t.lastTs) - t.time),
      status: t.err ? 'error' : (t.aborted ? 'canceled' : 'ok'),
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      ctx: t.ctxWin || 0, ctxUsed: t.ctxUsed || null,
      rounds: t.calls.length, tools: t.tools.length, calls: t.calls.length,
      models: t.models, preview: t.preview, name: t.name || null,
      finished: !t.live, aborted: t.aborted,
      toolNames: toolNameCounts(t.tools),
    }, { file: key, turn: i, kind: 'traedb' });
  });
  // 会话在 Trae 里被删 / 库重写时旧条目要撤掉（同 dsh / zcode）
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

// 详情页：扫描时已把整轮（用户输入 / 正文 / 工具 / 逐次调用 / 事件流）解析进内存，直接读
export function traeDbEntryContent(src, full) {
  const st = files.get(src.file);
  const t = st?.data?.turns?.[src.turn];
  if (!t) return null;
  const tools = t.tools.map(x => {
    const fi = {}, fo = {};
    return {
      name: x.name, tid: x.tid, error: x.error, dur: x.dur || 0,
      input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
      output: trunc(x.output, full, fo), outputTrunc: !!fo.t,
    };
  });
  const out = {
    user: t.user, assistant: t.assistant,
    tools, calls: t.calls, v: 'td' + (st.data.rev || 0),
    events: t.events || [],
    others: (t.others || []).map(o => ({ type: o.type, t: o.t, json: full ? o.json : o.json.slice(0, 800) })),
  };
  // 「为什么这张卡片上 token 全是 0」在 2025 老会话里是常态（源头就没记），必须说出来。
  // 判据是「**一个数字都没有**」而不是「没有逐次调用」：有些轮只有 turn.context.token_usage 这一笔
  // 汇总账（没有逐次行），token 明明有值，再挂「不存 token 用量」就是自相矛盾；进行中的轮则是
  // 还没到记账的时候，也不该按旧版会话提示。
  if (!t.calls.length && !t.tin && !t.tout && !t.tcache && !t.live) out.callsNote = '这是 Trae 的旧版会话记录（2025-08 之前）：那一版的库不存 token 用量与逐次调用，只留了对话正文。';
  if (t.err && t.errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + t.errMsg;
  return out;
}
