// ---------------- CodeArts Doer 的会话库（kind=codeartsdb；条目仍归侧栏的 codearts 一行） ----------------
// 数据源：`~/.codeartsdoer/codearts-data/opencode.db`（明文 SQLite + WAL；本机实测 510MB / 637 会话 /
// 2026-03-30→09-24 / user 消息 3222 条）。同目录另有 `storage/session_diff/ses_*.json`，那是**文件改动快照**
// 不是会话正文（抽一份内容是 `[]`），别去读它。
//
// Doer 的内核就是 opencode：`codearts-data/codearts.json` 的 `$schema` 直接写 `https://opencode.ai/config.json`，
// 会话 id 也是 `ses_…` 那套。所以解析主体走 opencode.mjs 的家族共享实现（`opencodeFamilyApi`），同 kilo 的先例。
//
// ⚠️ 但这库是**老世代**，与本机那份 `~/.local/share/opencode/opencode.db` 差在列上：
//   session 列 = id,project_id,parent_id,slug,directory,title,version,…,time_created,time_updated,type,workspace_id
//   —— **没有** 新版的 `path` / `agent` / `model` / `cost` / `tokens_*`；message 表也**没有** `role` 列。
//   role / tokens / cost / finish / modelID / providerID 全在 `message.data` 那个 JSON 里。
//   家族主体原来那句 `SELECT id, project_id, …, path, agent, model …` 在这里会整条 SQL 失败
//   （no such column: path）⇒ 已改成 `SELECT *`（见 opencode.mjs 的注释），两边都容得下。
//
// token 口径**与已验收的日志源逐字段对得上**（这是选它当主源的根据，不是推断）：
//   会话 ses_f2ef90936ffe… 库里两条 assistant 的 data.tokens.input = 35368 + 35968，
//   日志 `【AgentCore updated tokens】` 同会话该轮记 input 35368（第一条调用，含
//   context.messages 5192 / system_prompts 33053 完全一致），整轮合计 71336 = 侧栏那条的 tin。
//   `finish` 也是同一套（tool-calls / stop），失败与中断沿用家族的判读（statusFromMessage）。
//   `cost` 本机恒 0（内部计价）⇒ 不参与费用口径。
//
// 为什么并到 `codearts` 一行、而不是新开一行 agent：日志与库是**同一批调用的两种序列化**（本机实测
// 日志侧 20 条轮的 sessionID 与轮时间 20/20 全在库里命中），库里另有 617 个日志根本看不到的会话
// （日志只留约 30 天）。分成两行就是把同一批会话数两遍。归属规则因此照 **traedb** 的先例：
// **库优先、日志回退**，见 service.mjs 的 scanCodeartsAgent。
import fs from 'node:fs';
import path from 'node:path';
import { isFile, sqliteMod, files, entries } from './shared.mjs';
import { opencodeFamilyApi } from './opencode.mjs';

export const codeartsDbScanErr = new Map();

// opencode 探针必须把这几张表挡回去：Doer 库同样有 session/message/part + event/event_sequence，
// 光按那五张认会被 opencode 接走（判据与 KILO_ONLY_TABLES / MIMOCODE_ONLY_TABLES 同源）。
export const CODEARTS_DOER_ONLY_TABLES = ['cag_session_extra', 'cag_message_extra', 'cag_file_diff', 'digital_avatars'];

export function codeartsDoerRoots(home) {
  return [path.join(home, '.codeartsdoer')];
}

export function codeartsDoerDbVerify(fp) {
  if (!isFile(fp)) return false;
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
    if (!(names.has('session') && names.has('message') && names.has('part'))) return false;
    if (!CODEARTS_DOER_ONLY_TABLES.some(t => names.has(t))) return false;   // 独有表才算 Doer，别把普通 opencode 库接走
    return true;
  } catch { return false; } finally { try { db?.close(); } catch {} }
}

// base 可以是 ~/.codeartsdoer、里面的 codearts-data、或那份 db 本身（手工添加时三种都会出现）。
export function codeartsDoerDbFile(base) {
  if (!base) return null;
  if (codeartsDoerDbVerify(base)) return base;
  for (const rel of [path.join('codearts-data', 'opencode.db'), 'opencode.db']) {
    const fp = path.join(base, rel);
    if (codeartsDoerDbVerify(fp)) return fp;
  }
  return null;
}

const family = opencodeFamilyApi({
  kind: 'codeartsdb',
  // id 前缀必须与 opencode 的 'oc#' / kilo 的 'kl#' 错开：手工误指同一个库时，同前缀会让后扫那家把前一家的条目顶掉。
  idPrefix: 'cadb#',
  tag: '[codearts-doer]',
  errMap: codeartsDbScanErr,
  verPrefix: 'cadb',
});

// 返回 'ok' | 'empty' | 'err' —— service.mjs 的 scanCodeartsAgent 靠它决定「用库」还是「回退日志」，
// 契约与 scanTraeDb 同一类：只有**真的读不动**才允许回退，空库算读到（否则会拿 30 天日志冒充全量）。
export function scanCodeartsDoerDb(agent, dbPath) {
  if (!dbPath || !isFile(dbPath)) { codeartsDbScanErr.set(agent, '找不到 Doer 的会话库（' + (dbPath || '未探到路径') + '）'); return 'err'; }
  codeartsDbScanErr.delete(agent);
  family.scan(agent, dbPath);
  if (codeartsDbScanErr.has(agent)) return 'err';
  return codeartsDoerDbTurns(dbPath) ? 'ok' : 'empty';
}

function codeartsDoerDbTurns(dbPath) {
  const st = files.get(dbPath);
  return !!st?.data?.turns?.length;
}

export function codeartsDbEntryContent(src, full) { return family.entryContent(src, full); }

// 诊断用：这一行现在吃的到底是哪一份（库 or 日志），以及库里有多少轮 —— 并成一行的代价必须说得出来，
// 否则「CodeArts 怎么突然多了几千条」和「怎么少了」都变成一次排障。
export function codeartsDbSummary(agent) {
  let turns = 0, sess = 0, dbPath = null;
  for (const [fp, st] of files) {
    if (st.kind !== 'codeartsdb' || st.agent !== agent) continue;
    dbPath = fp; sess = new Set((st.data?.turns || []).map(t => t.sid)).size;
    turns += (st.data?.turns || []).length;
  }
  return { dbPath, sess, turns };
}
