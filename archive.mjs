// ---------------- 归档（历史条目冻结） ----------------
// 为什么要有它：有些 agent 自己删日志 —— codearts 的 %APPDATA%/codearts-agent/User/logs 只留
// 约 30 天，产品一删就永久没有，面板再怎么扫也扫不回来（本机历史月已出现空档）。归档把
// 「已经结束、且发生在今天之前」的**条目 + 详情快照**按 <agent>/<YYYY-MM-DD>.jsonl 冻在本地：
// 源文件被产品删掉之后，历史在归档里仍然查得到。
//
// 三条硬设计（与实时数据/扫描链的边界，别越线）：
//   1) **只冻结、不回喂**。不做「把归档目录当扫描根」那套 —— 扫描、快照、聚合、会话、热力图
//      一条链都不动；归档以独立只读视图（/api/archive/*）呈现。否则同一轮会既算实时又算归档。
//   2) **幂等靠合并，不靠重建**。重跑某一天时先读回旧文件、再按 id 合并覆盖，绝不用「当前内存
//      里的条目」重建整天文件 —— entries 有 LRU 上限（MAX_ENTRIES），内存里没有 ≠ 没归档过，
//      重建的那一版会把已归档但已被淘汰的历史整段抹掉（这是本模块最危险的坑）。
//   3) **口径升级不重放**。条目级快照按落盘当时的口径冻结，PARSER_REV 变了也不回头改老归档：
//      源文件很可能已经被产品删了，想重放也没有原料。代价是归档条目与实时条目可能口径不同，
//      页面上要写清楚（见 REFERENCE.md「归档」一节）。
//
// 依赖由主进程注入（initArchive）：entries / srcs 是扫描的共享 Map，dayKey 与 entryContent 都
// 在主文件里（entryContent 要读回源文件重建正文），本模块不 import 主文件、避免循环依赖。
import fs from 'node:fs';
import path from 'node:path';

let DEPS = null;              // { dataDir, entries, srcs, entryContent, dayKey, parserRev }
export function archiveRoot() { return path.join(DEPS.dataDir, 'archive'); }

// 单条记录里详情数组的上限：一轮真能堆上百次工具调用，全存进去归档文件会畸形膨胀，
// 而页面上的归档视图是「翻历史用的」，超出的部分只记个数（detailMore）即可。
const MAX_DETAIL_ITEMS = 40;

export function initArchive(d) { DEPS = d; }

const agentDir = agent => path.join(archiveRoot(), agent);
const dayFile = (agent, day) => path.join(agentDir(agent), day + '.jsonl');
const isDayName = s => /^\d{4}-\d{2}-\d{2}$/.test(s);

// 归档目录里绝对不能出现的字符（agent 名来自 config，理论上可控；一旦有人手工写个带路径的名字，
// 不挡就会把文件写到归档目录之外去）。只允许字母数字与 . _ - ，其余一律换成 _。
const safeAgent = n => String(n || '').replace(/[^A-Za-z0-9._-]/g, '_');

// POSIX 权限（R34）：归档文件里是**完整对话快照**，多用户机器上不该默认可读，所以新建的按私有建
//（目录 0700 / 文件 0600，win32 上 mode 无副作用 —— 那边的 chmod 只管只读位）。
// **只在新文件上生效，不 chmod 已有文件**：归档目录是用户可见的数据，有人可能故意放在共享位置
// 让同事读（或在网络上备份），悄悄把老文件改成 0600 会砸掉那种用法。老文件要收紧就显式来：
//   chmod -R go-rwx ~/.agent-acta
// 与 search.mjs 的 saveSearch 是同一套做法，各写一遍是有意的（archive 不 import search，反之亦然）。
const POSIX = process.platform !== 'win32';
const NEW_FILE_MODE = POSIX ? { mode: 0o600 } : undefined;
function ensureDir(p) { try { fs.mkdirSync(p, POSIX ? { recursive: true, mode: 0o700 } : { recursive: true }); } catch {} }

function readDay(agent, day) {
  const fp = dayFile(agent, day);
  const map = new Map();
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return map; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o && o.id) map.set(o.id, o); } catch {}
  }
  return map;
}

function writeDay(agent, day, map) {
  ensureDir(agentDir(agent));
  const fp = dayFile(agent, day);
  const lines = [...map.values()].sort((a, b) => (a.time || 0) - (b.time || 0)).map(o => JSON.stringify(o));
  const body = lines.length ? lines.join('\n') + '\n' : '';
  fs.writeFileSync(fp + '.tmp', body, NEW_FILE_MODE);
  fs.renameSync(fp + '.tmp', fp);
  return { count: lines.length, bytes: Buffer.byteLength(body) };
}

// ---------------- manifest（清单） ----------------
// 页面清单接口每次请求都去数一遍每个 jsonl 的行数太亏（几十个文件、几 MB），所以归档时顺手
// 把 {条数, 字节} 记在 manifest 里；清单接口以 manifest 为主、再用 readdir 校正文件是否还在
// （用户手工删过文件时不至于报出不存在的条目）。
const MANIFEST = () => path.join(archiveRoot(), 'manifest.json');
function loadManifest() {
  try { const j = JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')); if (j && j.agents) return j; } catch {}
  return { v: 1, updatedAt: 0, agents: {} };
}
function saveManifest(m) {
  ensureDir(archiveRoot());
  m.updatedAt = Date.now();
  const fp = MANIFEST();
  try { fs.writeFileSync(fp + '.tmp', JSON.stringify(m), NEW_FILE_MODE); fs.renameSync(fp + '.tmp', fp); } catch {}
}
// 按磁盘实况校正 manifest：文件没了就划掉，manifest 里没有但盘上有的（手工拷进来的）补一条
// count:-1（条数未知，页面显示为「?」，不假装是 0）。
function resolveManifest() {
  const m = loadManifest();
  const out = [];
  let agents = [];
  try { agents = fs.readdirSync(archiveRoot(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const agent of agents) {
    let names = [];
    try { names = fs.readdirSync(path.join(archiveRoot(), agent)); } catch {}
    for (const n of names) {
      if (!n.endsWith('.jsonl') || n.endsWith('.tmp')) continue;
      const day = n.slice(0, -6);
      if (!isDayName(day)) continue;
      const rec = m.agents?.[agent]?.[day];
      let bytes = rec ? rec.bytes : 0;
      try { bytes = fs.statSync(path.join(archiveRoot(), agent, n)).size; } catch {}
      out.push({ agent, day, count: rec ? rec.count : -1, bytes });
    }
  }
  out.sort((a, b) => (a.day === b.day ? a.agent.localeCompare(b.agent) : b.day.localeCompare(a.day)));
  return out;
}

// ---------------- 归档一轮 ----------------
// 选哪些条目：已结束（finished 不为 false）且发生在**今天 0 点之前**。进行中的轮不冻 ——
// 冻下来的是半截数据（token 还没累完），而它下一轮扫就会补齐。
// opts.skip = 不归档的 agent 名（config.archive.skip，见 REFERENCE「历史归档」）：
// 有的 agent 的日志本来就不值得留（量小/无正文/临时跑跑），开关只停**未来**的归档，
// **绝不碰已经冻好的文件** —— 开关是省磁盘的，不是删数据的入口。
// maxPerRun > 0 时只处理最老的 N 条（给服务内的后台轮用，避免一次跑几分钟）。
export async function archiveRun(opts) {
  const o = opts || {};
  const now = Date.now();
  const todayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const skipSet = new Set((o.skip || []).map(s => String(s)));
  const all = [];
  let skipped = 0;
  for (const [id, e] of DEPS.entries) {
    if (!e || !e.agent || !e.time || e.time >= todayStart) continue;
    if (e.finished === false) continue;
    if (skipSet.size && skipSet.has(e.agent)) { skipped++; continue; }
    all.push([id, e]);
  }
  all.sort((a, b) => (a[1].time || 0) - (b[1].time || 0));
  const capped = o.maxPerRun > 0 ? all.slice(0, o.maxPerRun) : all;

  const stat = { scanned: all.length, processed: capped.length, archived: 0, updated: 0, unchanged: 0, noDetail: 0, days: 0, bytes: 0, failed: 0, capped: capped.length < all.length, skipped };
  const groups = new Map();    // "agent|day" -> {agent, day, ids:[[id,e]]}
  for (const [id, e] of capped) {
    const agent = safeAgent(e.agent), day = DEPS.dayKey(e.time);
    const k = agent + '|' + day;
    if (!groups.has(k)) groups.set(k, { agent, day, rows: [] });
    groups.get(k).rows.push([id, e]);
  }

  const manifest = loadManifest();
  let tick = makeTick();
  let done = 0;
  const progress = () => {
    // 首次归档一台积压几千条的机器要跑几分钟（每条都要回读源文件重建正文），
    // 全程静默会让人以为卡死了，所以每 500 条报一次进度。
    if (o.log && ++done % 500 === 0) o.log('归档中… ' + done + '/' + stat.processed);
  };
  for (const g of groups.values()) {
    const existing = readDay(g.agent, g.day);
    const isNewDay = !fs.existsSync(dayFile(g.agent, g.day));
    let changed = false;
    for (const [id, e] of g.rows) {
      const prev = existing.get(id);
      // 同一条已经冻过且当时取到了详情 → 不再重读源文件（一轮几百条，重读是白花的时间）。
      if (prev && prev.detail) { stat.unchanged++; progress(); continue; }
      const rec = buildRecord(id, e, prev);
      existing.set(id, rec);
      if (prev) stat.updated++; else stat.archived++;
      if (!rec.detail) stat.noDetail++;
      changed = true;
      progress();
      await tick();
    }
    if (!changed) continue;
    if (o.dry) { stat.days++; continue; }
    try {
      const w = writeDay(g.agent, g.day, existing);
      (manifest.agents[g.agent] ||= {})[g.day] = { count: w.count, bytes: w.bytes };
      stat.days++; stat.bytes += w.bytes;
      if (isNewDay) o.log && o.log('archive: ' + g.agent + '/' + g.day + '（' + w.count + ' 条，' + fmtBytes(w.bytes) + '）');
    } catch (err) { stat.failed++; o.log && o.log('archive: 写 ' + g.agent + '/' + g.day + ' 失败：' + err.message); }
  }
  if (!o.dry && stat.days) saveManifest(manifest);
  return stat;
}

// 一条归档记录 = 列表要用的统计字段 + 详情快照。统计字段逐个显式列，不用 {...e} 整对象摊开：
// entry 里将来多出内部字段（如缓存用的临时字段）时，不至于悄悄冻进归档、以后想删都删不掉。
function buildRecord(id, e, prev) {
  const src = DEPS.srcs.get(id);
  const rec = {
    v: 1, id, agent: e.agent,
    kind: src ? src.kind : (prev?.kind || ''),
    project: e.project || '', session: e.session || '',
    time: e.time || 0, day: DEPS.dayKey(e.time),
    dur: e.dur || 0, status: e.status || 'ok',
    tin: e.tin || 0, tout: e.tout || 0, tcache: e.tcache || 0, total: e.total || 0,
    ctx: e.ctx || 0, rounds: e.rounds || 0, tools: e.tools || 0, calls: e.calls || 0,
    models: e.models || [], preview: e.preview || '',
    finished: e.finished !== false, aborted: !!e.aborted,
    toolNames: e.toolNames || {},
    rev: src ? (DEPS.parserRev[src.kind] ?? null) : (prev?.rev ?? null),
  };
  if (prev && prev.detail) return { ...rec, detail: prev.detail, detailMore: prev.detailMore };
  const d = detailOf(id);
  if (d) { rec.detail = d.detail; rec.detailMore = d.more; }
  return rec;
}

// 详情快照：拿实时详情那条路（entryContent，full=false）现取一次，截断口径与非 full 的页面一致。
// 取不到（源文件已被产品删掉 / 该 kind 不支持回读）不是错误 —— 归档照样记统计，只是没有正文，
// 页面上会显示「归档时未取到详情」。
function detailOf(id) {
  let d = null;
  try { d = DEPS.entryContent(id, false); } catch { d = null; }
  if (!d) return null;
  // ⚠ 主文件的 entryContent 读不到源文件时**不返回 null**，而是吞掉异常回一句占位串
  //（catch 里硬编码的 '[内容读取失败: …]'）。不认出来的话，归档会把这条占位串当成用户的真实输入
  // 冻进文件 —— 而归档恰恰是「以后再也补不回来」的那一份：源文件当时读不到，留下来的却是句误导人的话。
  // 当「归档时未取到详情」处理（走已有的 noDetail 口径），与上面那句「取不到不是错误」保持一致。
  if (typeof d.user === 'string' && d.user.startsWith('[内容读取失败')) return null;
  const more = {};
  const cut = (arr, key) => {
    if (!Array.isArray(arr)) return [];
    if (arr.length <= MAX_DETAIL_ITEMS) return arr;
    more[key] = arr.length - MAX_DETAIL_ITEMS;
    return arr.slice(0, MAX_DETAIL_ITEMS);
  };
  const out = {};
  if (d.user) out.user = String(d.user);
  if (d.assistant) out.assistant = String(d.assistant);
  if (d.note) out.note = d.note;
  if (d.callsNote) out.callsNote = d.callsNote;
  out.tools = cut(d.tools, 'tools');
  out.calls = cut(d.calls, 'calls');
  if (Array.isArray(d.events) && d.events.length) out.events = cut(d.events, 'events');
  return { detail: out, more: Object.keys(more).length ? more : undefined };
}

// 并发让出：entryContent 是同步读文件，一轮几千条会把事件循环占死（页面就转圈）。
// 攒够 ~40ms 才 let 一次（与首扫分片同一套预算，见主文件 SLICE_BUDGET_MS 的说明）。
function makeTick(budgetMs) {
  let deadline = Date.now() + (budgetMs || 40);
  return async function tick() {
    if (Date.now() < deadline) return;
    await new Promise(r => setImmediate(r));
    deadline = Date.now() + (budgetMs || 40);
  };
}

// ---------------- 查询（页面只读视图直接用） ----------------
export function archiveIndex() {
  const rows = resolveManifest();
  const agents = {};
  let totalCount = 0, totalBytes = 0;
  for (const r of rows) {
    const a = agents[r.agent] || (agents[r.agent] = { agent: r.agent, days: 0, count: 0, bytes: 0, lastDay: '' });
    a.days++; a.bytes += r.bytes;
    if (r.count >= 0) a.count += r.count; else a.unknown = true;
    if (r.day > a.lastDay) a.lastDay = r.day;
    totalBytes += r.bytes; if (r.count >= 0) totalCount += r.count;
  }
  return {
    root: archiveRoot(), days: rows, agents: Object.values(agents).sort((x, y) => y.lastDay.localeCompare(x.lastDay)),
    totals: { agents: Object.keys(agents).length, days: rows.length, count: totalCount, bytes: totalBytes },
  };
}

// 列条目：agent/day 至少给一个；q 为关键词（对 preview/user/assistant/session 做包含匹配，
// 与主列表的「关键词」口径一致 —— 都是简单的包含，不做分词/正则）。
export function archiveEntries({ agent, day, q, limit, offset } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const off = Math.max(Number(offset) || 0, 0);
  const kw = String(q || '').trim().toLowerCase();
  const rows = resolveManifest().filter(r => (!agent || r.agent === agent) && (!day || r.day === day));
  const hit = [];
  let scanned = 0, total = 0;
  for (const r of rows) {
    const list = readDay(r.agent, r.day);
    for (const rec of list.values()) {
      scanned++;
      if (kw && !matchKw(rec, kw)) continue;
      total++;
      if (total <= off || hit.length >= lim) continue;
      hit.push({ ...rec, detail: undefined, detailMore: undefined, hasDetail: !!rec.detail });
    }
  }
  hit.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { list: hit, total, scanned, offset: off, limit: lim };
}

function matchKw(rec, kw) {
  const hay = [rec.preview, rec.session, rec.project, rec.detail?.user, rec.detail?.assistant,
    (rec.models || []).join(' '), Object.keys(rec.toolNames || {}).join(' ')].join('\n').toLowerCase();
  return hay.includes(kw);
}

export function archiveEntry(agent, day, id) {
  const rec = readDay(safeAgent(agent), day).get(id);
  return rec || null;
}

// ---------------- 保留策略 ----------------
// 默认「永久保留」：归档的意义就是对抗产品删日志，自动删归档等于又制造一次空档。
// 想限量的机器给 config.archive.maxDays（按日期保留最近 N 天）/ maxMB（整目录上限，超了从最老的日期文件开始删）。
// 删除只针对**整天文件**，不做单条裁剪 —— 归档的价值在「那天发生过什么」，留半天的残卷没意义。
export function pruneArchive({ maxDays, maxMB, dry, log } = {}) {
  const rows = resolveManifest();
  const removed = [];
  if (maxDays > 0) {
    const cutoff = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - maxDays + 1); return DEPS.dayKey(d.getTime()); })();
    for (const r of rows) if (r.day < cutoff) removed.push(r);
  }
  if (maxMB > 0) {
    const keep = new Set(removed.map(r => r.agent + '|' + r.day));
    const rest = rows.filter(r => !keep.has(r.agent + '|' + r.day)).sort((a, b) => a.day.localeCompare(b.day));
    let total = rest.reduce((s, r) => s + r.bytes, 0);
    const cap = maxMB * 1024 * 1024;
    for (const r of rest) { if (total <= cap) break; total -= r.bytes; removed.push(r); }
  }
  if (!removed.length) return { removed: 0, bytes: 0 };
  let bytes = 0;
  for (const r of removed) {
    bytes += r.bytes;
    if (dry) continue;
    try { fs.unlinkSync(path.join(archiveRoot(), r.agent, r.day + '.jsonl')); } catch {}
  }
  if (!dry) {
    const m = loadManifest();
    for (const r of removed) { if (m.agents?.[r.agent]) delete m.agents[r.agent][r.day]; }
    saveManifest(m);
    for (const r of removed) { try { if (!fs.readdirSync(path.join(archiveRoot(), r.agent)).length) fs.rmdirSync(path.join(archiveRoot(), r.agent)); } catch {} }
  }
  log && log('archive: 按保留策略删除 ' + removed.length + ' 个日期文件（' + fmtBytes(bytes) + '）');
  return { removed: removed.length, bytes };
}

export function fmtBytes(n) {
  if (!n) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
