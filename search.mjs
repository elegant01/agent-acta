// ---------------- 全文搜索索引（R33 / 候选池 I10） ----------------
// 为什么要有它：页面那个关键词框只筛**已经拉回浏览器的窗口条目**（占位符自己都写着「仅搜索当前 N 条」），
// 所以它搜不到没加载进来的历史；而且条目上只存了用户输入的前 300 字摘要 —— AI 回复正文、工具入参/返回
// 压根不在条目里，搜「哪一轮报的这个错」「哪个工具超时了」一律搜不到。这里把每条轮次的正文抽出来单独存
// 一份，让检索跨 agent、跨未加载历史、且真的能搜到正文。
//
// 四条硬设计（与实时数据/扫描链的边界，别越线）：
//   1) **只读旁路，不回喂扫描链**。索引只被 /api/search 读，绝不参与条目的构造 —— 扫描链一个字节都不改。
//   2) **幂等靠合并，不靠重建**。与 archive.mjs 同一条纪律：一次只覆盖**变化了的那个文件**的记录，
//      其余原样留着。entries 有 LRU 上限（MAX_ENTRIES），内存里没有 ≠ 没索引过；拿内存重建整片会把
//      已索引但已被淘汰的正文整段抹掉。这是本模块最危险的坑，和归档那份是同一个。
//   3) **文本与卡片详情同源**。取的正文就是 entryContent(id, false) 那条路（同一套解析器、同一套字段
//      截断），不另写一份取文口径 —— 各解析器的取法已经写了一遍，再写第二遍必然漂成「搜得到、点开没有」。
//   4) **判活一律问扫描链，不自己 stat**。见下面 sigOf 的说明：有整整两家（cursor / gemini）的源标识
//      根本不是文件路径，自己 stat 会把它们整家静默漏掉。
//   5) **记录按绝对路径认人，所以换平台/换机器时靠载入剪枝自愈**。记录的主键是源标识（绝大多数
//      就是源文件的绝对路径），Windows 上是 `C:\…`、mac/linux 上是 `/…`。把整个 `~/.agent-acta`
//      搬去另一台机器或另一个平台，一整片记录的路径就全部对不上本机的源 —— 载入时剪掉它们（见
//      sourceAlive），下一次建索引自然会按新路径重扫出来。**剪掉是安全的**：一条记录只有在扫描链
//      扫到它的源文件、给出 (源标识, 轮次) -> id 的映射之后才可能被搜到（见 reindex），源不在本机
//      ⇒ 它永远解析不出 id ⇒ 留在盘上既搜不到、白占地方，还会让「已索引 A/B」里的 A 虚高。
//
// 依赖由主进程注入（initSearch）：entries / srcs / files 是扫描链的共享 Map，entryContent 在主文件里
//（详情要回读源文件），本模块不反向 import 主文件、避免循环依赖。
import fs from 'node:fs';
import path from 'node:path';

let DEPS = null;   // { dataDir, entries, srcs, files, entryContent, parserRev, maxChars, readOnly }
export function searchRoot() { return path.join(DEPS.dataDir, 'search'); }

// 导出来是给测试用的：platform-test 要造一份「当前格式」的分片来验剪枝，写死字面量的话
// 每次 +1 都会把那个测试弄红（v1→v2 时就红过一回）。生产代码请继续用这个常量，别再抄数字。
export const SHARD_V = 3;        // 分片格式版本：结构变了才 +1（与 PARSER_REV 管的是两件事）
                                // v2（I6 工具失败画像）：每个源多带一张 `tf` 逐轮工具失败计数表
                                // v3（I13 超时 / 软失败画像）：`tf` 的值从 `{名:次数}` 变成
                                //     `{名:{e,t,s}}`（error / timeout / soft 三分类）
const TEXT_CAP = 8000;          // 每条轮次的正文上限（用户拍板；见 indexTextOf 的逐段上限）
const MAX_QUERY = 200;          // 查询词长度上限：再长也不像人搜的东西，而正则的代价随长度暴涨
const QUERY_BUDGET_MS = 2000;   // 单次查询墙钟预算（只对正则模式有意义，见 searchEntries）

// 落盘结构：一个**解析器 kind** 一片，一个源标识一条记录。
// 增量粒度跟源文件走（与 loadIndex 校验 files 状态的签名同一套思路）：没动就整条跳过，动了就把这
// 一个文件的全部轮次重算一遍 —— 一个文件的记录要么整体换掉、要么原样不动，不做半截更新。
//   SHARDS: kind -> { v, rev, files: Map<源标识, {a, f, sig, t: {turn: 正文}, tf: {turn: 失败分类}}> }
// 条目 id **不冻进索引**：id 的构造规则属于各解析器（claude 是 'c#路径#轮号'、atomcode 是另一套），
// 冻进来等于把 id 规则复制了一份，解析器一改这里就悄悄对不上。查询时用 (源标识, 轮次) 反查 srcs 拿 id。
const SHARDS = new Map();
// 查询用的扁平视图：id -> { k, f, u, x }（x = 正文原文，**不是**小写副本 —— 大小写不敏感靠正则的 i 标志，
// 见 searchEntries 里那段）。由 reindex() 从 SHARDS + srcs 现推。
const IDX = new Map();
// I6 的扁平视图：`源标识\u0000轮次` -> 该轮的工具失败分类（`0` = 已核对且无失败，`{Bash:{e:2,t:0,s:0}}` = 有）。
// **读不到就是查不到这个键**（`toolFailsOf` 回 undefined），不写成 0 —— 把"没数据"记成"没失败"
// 正是这条画像最容易造的假绿：一个从没被索引过的 agent 会显示成「一次都没错过」。
const FAILIDX = new Map();

let unreadable = 0;    // 上次建索引时读不出正文的条数（详情为 null / 命中了读失败占位串）
let noState = 0;       // 上次建索引时「扫描链没给出这个源的签名、又没有旧记录」而跳过的源数
                       //（正常应为 0；不为 0 说明有一批条目这一轮根本没进索引，是要查的信号）
let lastRunAt = 0;
let building = false;  // 后台正在建 —— /api/search 据此如实告诉页面「这一份结果可能不全」
let prunedAtLoad = 0;  // 上一次载入时剪掉的「源不在本机」记录数（跨平台搬运 / 日志被删；见 loadSearch）
let pruneReport = 0;   // 上面那个数里「还没写进日志」的部分（searchRun 取走即清零）
// 剪过记录、但还没落盘的 kind。saveSearch 会把它们并进这一轮的写里 —— 于是盘上的死记录
// 在下一次任意写时顺手清掉，不需要为「剪枝」单开一条写路径（LIB 模式照旧一个字都不写）。
const pruneDirty = new Set();

export function initSearch(d) { DEPS = d; }

// 并发让出：entryContent 是同步读文件，一轮几千条会把事件循环占死（页面就转圈）。
// 与 archive.mjs 里那个同款（那边是模块私有没导出，不为了复用把两个互不相干的功能模块耦起来）。
function makeTick(budgetMs) {
  let deadline = Date.now() + (budgetMs || 40);
  return async function tick() {
    if (Date.now() < deadline) return;
    await new Promise(r => setImmediate(r));
    deadline = Date.now() + (budgetMs || 40);
  };
}

const safeKind = k => String(k || '').replace(/[^A-Za-z0-9._-]/g, '_');

// ---------------- 源标识的判活与版本（本模块最容易写错的一处） ----------------
// ⚠ 两条都是实测踩出来的，别改回去：
//
// ① **不能自己 fs.statSync(src.file)**。cursor 与 gemini 的源标识是伪路径
//    （parsers/cursor.mjs:'cursor:'+dir、parsers/gemini.mjs:'gemini:'+dir），它们一个目录算一个源、
//    整份重解析，files 里记的是 {m:0, s:0}：stat 必然抛异常。按「stat 不到 = 源没了」处理的话，
//    这两家（本机 714 条，占 13%）会被**整家静默漏掉**，而且日志里只会看到一句「missing」不好查。
// ② 判活与版本都从 `files` 拿，那是扫描链自己维护的、与 loadIndex 校验的**同一份**签名：
//    整份重解析的 kind 用 data.sig（文件内容签名），增量读的 kind 用 mtime/size/off。
//    于是「什么都没变」与扫描链的判断完全一致，不会出现索引觉得变了、扫描链觉得没变那种来回抖。
function srcState(file) { return DEPS.files.get(file) || null; }
function sigOf(file) {
  const st = srcState(file);
  if (st) {
    if (st.data && typeof st.data.sig === 'string') return 'x:' + st.data.sig;
    return 'm:' + st.m + ':s:' + st.s + ':o:' + (st.off || 0);
  }
  // 扫描链里没有这个源的状态 —— **不代表不能索引**，退回自己 stat 兜底。
  // 实测踩到的来路：atomcode 的会话目录里有一批 **0 字节的 .jsonl**（对话正文其实在 .snapshot /
  // .meta 里），而 scanAtomcodeDir 对它是 `if (s <= off) continue`（0 <= 0）—— 在 files.set 之前
  // 就短路了，于是这个路径永远不进 files。可条目照旧由 .meta 产出来（src.file 指的正是这个空 jsonl）。
  // 不加这条兜底的话，本机 47 个源 / 885 条（占 25%）会被整批判成「源没了」而**搜不到** ——
  // 连按会话名/模型名这种纯元信息检索都搜不到，因为它们压根没进索引。
  // stat 不到（伪路径，或源文件真被删了）才算真没有证据。
  try { const s = fs.statSync(file); return 'f:' + s.mtimeMs + ':' + s.size; } catch { return null; }
}
// PARSER_REV 的键是**解析器 kind**，不是 src.kind：atomcode 的 src.kind='atomcode'，
// 而它在 files 里（以及 PARSER_REV 里）是 'jsonl'。用 src.kind 查会永远得到 undefined ⇒ 永不失效。
function parserKindOf(file, fallback) { const st = srcState(file); return (st && st.kind) || fallback || ''; }
function revOf(kind) { return DEPS.parserRev[kind] == null ? null : DEPS.parserRev[kind]; }

// ---------------- 「这个源还属于本机吗」（载入剪枝用，见头部设计 5） ----------------
// 判据三条，按可信度排：
//   ① 扫描链认它 → 活着。这一条把 cursor / gemini 的伪路径源标识（'cursor:'+dir）也保住了：
//      它们根本不是文件系统路径，交给 ②③ 判必被误剪。**必须在扫描链已经跑过之后判**，所以
//      loadSearch 是懒加载的（ensureLoaded），由 searchRun / searchEntries 在扫描之后触发。
//   ② 明显是**另一个平台**的绝对路径 → 死了。少了这一条，`C:\Users\x` 在 mac/linux 上会被
//      path.isAbsolute() 判成「相对路径」而被 ③ 放过，整片死记录永远留在盘上。
//   ③ 本机绝对路径 → 看盘上还在不在。不在 ⇒ 死了（源被产品删了也算 —— 那条纪律由 archive 负责，
//      这儿是缓存：源没了就重建不出来，留着也解析不出 id）。网盘/移动盘一时挂不上也会落进这一条：
//      代价是下次重扫一遍，不是数据没了 —— 它本来就是缓存。
// 非 ①②③ 的（相对路径、伪路径但扫描链还没跑）一律**当活着的留着**：宁可留着死重也不能误剪。
export function foreignPath(f, platform) {
  const p = String(f || '');
  if (!p) return false;
  if ((platform || process.platform) === 'win32') return p.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');   // 盘符（含正斜杠写法）或 UNC
}
function sourceAlive(f) {
  if (srcState(f)) return true;
  if (foreignPath(f)) return false;
  if (!path.isAbsolute(f)) return true;
  try { fs.statSync(f); return true; } catch { return false; }
}

function shardFor(kind, create) {
  let s = SHARDS.get(kind);
  if (!s && create) { s = { v: SHARD_V, rev: revOf(kind), files: new Map() }; SHARDS.set(kind, s); }
  return s;
}

// ---------------- 载入 / 落盘 ----------------
// 载入**必须先于任何一次建索引**，所以 searchRun / searchEntries 入口都挂了这个闸：
// 不先读回盘上的分片，SHARDS 就是空的，第一次 searchRun 会把「所有源」判成「没建过」——
// 逐条重读源文件重建一遍（本机实测 140 秒），而且**每次重启都重来一遍**。
// 更坏的是那次重建会把盘上已有的分片整片覆盖（违背下面 searchRun 里那条「合并而不重建」）。
let loaded = false;
function ensureLoaded() { if (!loaded) loadSearch(); }

export function loadSearch() {
  loaded = true;
  SHARDS.clear(); IDX.clear();
  pruneDirty.clear();
  let files = 0, pruned = 0;
  try {
    for (const fn of fs.readdirSync(searchRoot())) {
      if (!fn.endsWith('.json') || fn.endsWith('.tmp')) continue;   // 半截写下的别解析
      const kind = fn.slice(0, -5);
      let j; try { j = JSON.parse(fs.readFileSync(path.join(searchRoot(), fn), 'utf8')); } catch { continue; }
      if (!j || j.v !== SHARD_V) continue;
      // 解析器改过口径的 kind：整片丢弃重扫。索引里的正文是**用旧解析器抽出来的**，
      // 与 loadIndex「老 rev 的 state 直接丢弃」是同一条纪律（留着就是静默的旧口径）。
      if (j.rev !== revOf(kind)) continue;
      const rec = { v: SHARD_V, rev: j.rev, files: new Map() };
      let cut = 0;
      for (const f of j.files || []) {
        if (!f || !f.f) continue;
        // 源不在本机 → 剪掉（跨平台搬运 / 日志被删；理由见头部设计 5 与 sourceAlive）。
        // 注意与「被 LRU 淘汰」区分开：那批源文件还在盘上，sourceAlive 过得了，
        // 正是设计 2「合并而非重建」要保住的那一份。
        if (!sourceAlive(f.f)) { cut++; continue; }
        rec.files.set(f.f, f);
      }
      pruned += cut;
      if (cut) pruneDirty.add(kind);   // 标记脏：下次任意一次落盘顺手把盘上的死记录清掉
      SHARDS.set(kind, rec);
      files += rec.files.size;
    }
  } catch {}   // 目录还不存在 = 还没建过索引，不是错误
  prunedAtLoad = pruned;
  pruneReport = pruned;   // 报一次就清零（见 searchRun），不然每一轮都刷同一句话
  reindex();
  return { files, entries: IDX.size, pruned };
}

// 从 SHARDS + srcs 反推「id -> 正文」。反查表一次性建好：srcs 是本机几千条的 Map，
// 每个 turn 都去扫一遍会变成平方级。
function reindex() {
  IDX.clear();
  FAILIDX.clear();
  const byFileTurn = new Map();
  for (const [id, s] of DEPS.srcs) {
    if (!s || s.file == null || s.turn == null) continue;
    byFileTurn.set(s.file + '\u0000' + s.turn, id);
  }
  for (const [kind, rec] of SHARDS) {
    for (const f of rec.files.values()) {
      const t = f.t || {};
      const tf = f.tf || {};
      // tf 覆盖的轮集合与 t **不完全相同**（正文抽不出、但工具失败读得出的轮只有 tf），所以两张表各走各的键。
      for (const k of Object.keys(t)) {
        const id = byFileTurn.get(f.f + '\u0000' + k);
        // 反查不到 = 这一条已不在扫描链里（被 LRU 淘汰）。正文**留在盘上**不动：它回来时立刻又能搜到，
        // 而且不用再读一次源文件。这里只是这一轮查询看不见它（searchEntries 里数进 stale）。
        if (id == null) continue;
        IDX.set(id, { k: kind, f: f.f, u: k, x: t[k] });
      }
      // FAILIDX **按 (源标识, 轮次) 键，不按条目 id**：id 要经 srcs 反查，而「载入分片的那一刻 srcs
      // 齐不齐」是不该影响正确性的外部状态 —— 刚重启、首扫还没跑完时反查会漏掉一大批，盘上明明有数据
      // 却查得到"未知"（本机实测 zcode 154 轮、qoder-cn 208 轮就是这么被吞的）。改按键存之后
      // 由 toolFailsOf 在**调用时**现查 srcs，拿到的永远是当前这份扫描链状态。
      for (const k of Object.keys(tf)) FAILIDX.set(f.f + '\u0000' + k, tf[k]);
    }
  }
  return IDX.size;
}

// I6 取数入口：这一轮的工具失败分类（`undefined` = 还没索引到 / 详情读不出，与 `0` = 无失败是两回事）。
// 值形状见 indexFailsOf：`0` 或 `{名:{e,t,s}}`。
// 挂 ensureLoaded：--status / MCP 这类没走定时建索引的进程第一次问也能拿到盘上那份，而不是全场「未知」。
// srcs 在**调用时**查（不在 reindex 那一刻预解），理由见上面 FAILIDX 的注释。
export function toolFailsOf(id) {
  ensureLoaded();
  const s = DEPS.srcs.get(id);
  if (!s || s.file == null || s.turn == null) return undefined;
  return FAILIDX.get(s.file + '\u0000' + s.turn);
}
// 建索引是否正在进行（页面据此说明「画像可能不全」）。**只读这个位，别拿 searchStatus()**：
// 那个函数每次都要 stat 一遍分片目录算体积，排行接口不该摊上这笔开销。
export function searchBuilding() { return building; }

export function saveSearch(kinds) {
  // 只读库模式（MCP 进程）：索引分片只有常驻服务那一份写者（与 saveIndex / saveConfig 同一条理由）。
  if (DEPS.readOnly) return { ok: true, skipped: true, kinds: 0, bytes: 0 };
  const list = new Set(kinds ? [...kinds] : [...SHARDS.keys()]);
  for (const k of pruneDirty) list.add(k);   // 载入时剪过记录的 kind：借这次写把盘上那份也清干净
  let bytes = 0, n = 0;
  const posix = process.platform !== 'win32';   // 权限只在 POSIX 上有意义（win32 的 chmod 只管只读位）
  try {
    // 索引正文是**明文对话**，POSIX 下按私有建：0700 目录 / 0600 文件。
    // mode 只在**新建**时生效（umask 只能清位、清不掉已经从 0700/0600 里拿掉的组/其他人位），
    // 所以下面写临时文件时还补一道 chmod —— 早先版本建的文件是 0644，光靠 mode 永远转不过来。
    const mkOpts = { recursive: true };
    if (posix) mkOpts.mode = 0o700;
    fs.mkdirSync(searchRoot(), mkOpts);
    for (const kind of list) {
      const s = SHARDS.get(kind);
      if (!s) continue;
      // 按源标识排序：同一份数据每次落盘逐字节相同，diff 稳定（与归档 manifest 同一个理由）
      const files = [...s.files.values()].sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
      const body = JSON.stringify({ v: SHARD_V, rev: s.rev, files });
      const fp = path.join(searchRoot(), safeKind(kind) + '.json');
      // 临时名带 pid + 随机段：CLI 与服务仍有可能同时写（--search-reindex 只在服务在跑时拒跑，
      // 挡不住「先起 CLI、服务后起」这种交错），固定叫 `fp + '.tmp'` 的话两边会互相写坏
      //（archive.mjs / saveIndex 用的是固定名，这里不跟着抄）。
      const tmp = fp + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
      fs.writeFileSync(tmp, body, posix ? { mode: 0o600 } : undefined);
      // 补一道 chmod：writeFileSync 的 mode 只对**新建**的文件生效，早先版本用默认权限写下的
      // 分片（POSIX 上普遍是 0644，同机其他用户可读）不改的话永远转不过来。
      if (posix) { try { fs.chmodSync(tmp, 0o600); } catch {} }
      fs.renameSync(tmp, fp);
      bytes += Buffer.byteLength(body); n++;
      pruneDirty.delete(kind);   // 这个 kind 的盘上内容已经与内存一致（死记录被这次写清掉了）
    }
  } catch (e) { return { ok: false, error: e.message, kinds: n, bytes }; }
  return { ok: true, kinds: n, bytes };
}

// ---------------- 抽一条轮次的正文 ----------------
// 口径写死在这儿，别漂。顺序 = user → assistant → 逐个工具（名/入参/返回）→ 逐次调用正文。
//
// **逐段先截、最后再兜一道总上限**，不是拼完再截。为什么：各解析器返回的 assistant 是**没截过的**
//（claude.mjs 的 out.assistant = texts.join('\n')），一段长回复就能把 8000 字额度吃干净，
// 排在它后面的工具行全部对搜索不可见 —— 而「哪一轮跑过那条命令 / 那个工具返回了什么」恰恰是最常搜的。
// 逐段截让覆盖可预测，总上限只作为保险（一次几十个工具的长轮次）。
const CAP = { user: 4000, assistant: 4000, name: 200, tool: 800, call: 800, note: 500 };

function indexTextOf(c) {
  if (!c) return null;
  // ⚠ 主文件的 entryContent 读不到源文件时**不返回 null**，而是吞掉异常回一句占位串
  //（catch 里硬编码的 '[内容读取失败: …]'）。照单全收就会把这五个字当正文索引进去 ——
  // 搜「失败」时满屏假命中，而且从结果上看不出是假的。这里当场认出来，当「读不到」处理。
  if (typeof c.user === 'string' && c.user.startsWith('[内容读取失败')) return null;
  const parts = [];
  const add = (s, cap) => { if (s == null) return; const t = String(s); if (t) parts.push(t.length > cap ? t.slice(0, cap) : t); };
  add(c.user, CAP.user);
  add(c.assistant, CAP.assistant);
  for (const tl of c.tools || []) { add(tl.name, CAP.name); add(tl.input, CAP.tool); add(tl.output, CAP.tool); }
  for (const k of c.calls || []) { add(k && k.text, CAP.call); if (k && k.tools) add(Array.isArray(k.tools) ? k.tools.join(' ') : k.tools, CAP.name); }
  add(c.note, CAP.note);          // 「为什么这一轮全是 0」这类说明也是可搜的内容
  add(c.callsNote, CAP.note);
  if (!parts.length) return null;
  const joined = parts.join('\n');
  return joined.length > TEXT_CAP ? joined.slice(0, TEXT_CAP) : joined;
}

// I6（工具失败画像）的逐轮计数，I13 起扩成**三分类**。**只认解析器已经落好的结构化标志**
// （`tools[].error` / `tools[].timeout` / `tools[].soft`），一个字的正文都不扫 —— 两条理由：
// ① 「输出里恰好含 error 字样」是原条目自己警告过的误判来源；
// ② claude / codex / kimi 这些 OFF_KINDS 在扫描侧根本不保留正文，要做文本启发式就得么漏判、
// 么把正文烤进索引（现况 claude.json 已 1.2MB），两头都不划算。
// 返回值三态，别把「没数据」写成 0：
//   null        = 这一条的详情读不出（safeDetail 已经吞了异常）→ 键不落盘 = 未知
//   0           = 看过、可判定、这一轮没有失败的工具
//   {名:{e,t,s}} = 有失败的工具，按名字分类计数（e=error / t=timeout / s=soft）
// ⚠️ 对 `cursor` / `codearts` 这类详情**本来就回 `tools:[]`** 的 kind，这里回的是 0 ——「看过、没有失败」
// 在字面上没错，但它是「没有可看的东西」而不是「这个 agent 从不出错」。那层区分属于**能力口径**、
// 按 kind 静态给定（见主文件的 TOOL_FAIL_TIERS），不在这里逐轮编码。
// ⚠️ I13 的另一半同款：`t` / `s` 只有 claude 系解析器会置位（别家源里没有这层字段），所以别家的
// `t`/`s` 恒为 0 —— 那个 0 是「没有这个信号」而不是「一次没超时」，同样由能力口径
// （主文件的 TOOL_TIMEOUT_SIGNAL_KINDS）在聚合侧挡掉，不在这里逐轮编码。
const FAIL_NAME_CAP = 60;
function indexFailsOf(c) {
  if (!c) return null;
  if (typeof c.user === 'string' && c.user.startsWith('[内容读取失败')) return null;   // 同 indexTextOf 那道闸
  const tools = Array.isArray(c.tools) ? c.tools : null;
  if (!tools) return null;      // 详情连 tools 字段都不给的 kind：未知，不当成 0
  const m = {};
  for (const tl of tools) {
    if (!tl) continue;
    const e = tl.error ? 1 : 0;
    // 超时判「有这一位」而不是判真假：解析器搬过来的是产品给的档位数值（45000 / 60000 …），
    // 拿 `!!` 判会把某个恰好为 0 的档位读没。
    const t = tl.timeout != null ? 1 : 0;
    const s = tl.soft != null ? 1 : 0;
    if (!e && !t && !s) continue;
    const nm = String(tl.name || '?').slice(0, FAIL_NAME_CAP);
    const r = m[nm] || (m[nm] = { e: 0, t: 0, s: 0 });
    r.e += e; r.t += t; r.s += s;
  }
  return Object.keys(m).length ? m : 0;
}

// ---------------- 建索引（增量） ----------------
// maxPerRun 按**文件**封顶，检查点只在文件边界：一个文件的记录要么整体换掉、要么原样不动。
// （不按条目数封顶是因为「一个文件多少条」差几个数量级，按条数切会把一个文件的更新切成两半。）
export async function searchRun(opts) {
  ensureLoaded();
  const o = opts || {};
  const maxPerRun = o.maxPerRun > 0 ? o.maxPerRun : 0;
  const maxFiles = o.maxFiles > 0 ? o.maxFiles : 0;
  const cap = maxFiles || maxPerRun;
  building = true;
  unreadable = 0;
  noState = 0;
  try {
    // 按源标识归组当前内存里的条目 —— 这一份就是「本轮要覆盖的集合」
    const groups = new Map();   // file -> { file, srcKind, rows: [{id, turn}] }
    for (const [id, e] of DEPS.entries) {
      const s = DEPS.srcs.get(id);
      if (!s || !s.file || s.turn == null) continue;
      let g = groups.get(s.file);
      if (!g) { g = { file: s.file, srcKind: s.kind || '', rows: [] }; groups.set(s.file, g); }
      g.rows.push({ id, turn: String(s.turn) });
    }

    const stat = {
      files: groups.size, processed: 0, entries: 0, indexed: 0, skipped: 0,
      unreadable: 0, noState: 0, chars: 0, cut: 0, capped: false,
      failsKnown: 0,   // I6：这一轮认得出「有无失败工具」的条数（分母；剩下的都是未知）
      // 载入时剪掉的死记录（源不在本机）：与上面几个数一样是**如实交代**的一部分 ——
      // 换平台/换机器后的第一轮必然非 0，那正是这套自愈机制在干活，不该悄悄发生。
      pruned: (() => { const n = pruneReport; pruneReport = 0; return n; })(),
    };
    const tick = makeTick(40);
    const dirty = new Set();

    for (const g of groups.values()) {
      if (cap && stat.processed >= cap) { stat.capped = true; break; }
      stat.processed++;
      const kind = parserKindOf(g.file, g.srcKind);
      const sig = sigOf(g.file);
      const shard = shardFor(kind, true);
      const prev = shard.files.get(g.file);
      // 源的状态没见过（没扫到过这个源）又没有旧记录：这一轮跳过并计数，等扫描链把它收进来。
      // 有旧记录就照常按签名比对（伪路径那两家永远走 data.sig 这一支，不会落到这里）。
      if (sig == null && !prev) {
        stat.noState++;
        if (o.log && stat.noState <= 5) o.log('noState 源（扫描链里没有它的状态）：' + g.file);
        continue;
      }
      // 签名一致 = 整条跳过（noState 之外的唯一快路径）。sig 两边都为 null 时视为「都没证据」，
      // 不能当成「变了」—— 否则一个拿不到状态的源会每轮重建一次。
      if (!o.force && prev && prev.sig === sig) { stat.skipped++; continue; }

      const t = {}, tf = {};
      for (const r of g.rows) {
        stat.entries++;
        // **一次 safeDetail 喂两个消费者**：I6 的失败计数就是顺着这同一次详情读出来的，
        // 不另开一遍「按需拉 5000 条详情」的读盘（claude 的详情是每次 readFileSync 整份转录，
        // 实测 41ms/条；单独为画像跑一遍就是分钟级）。
        const c = safeDetail(r.id);
        const fails = indexFailsOf(c);
        if (fails != null) { tf[r.turn] = fails; stat.failsKnown++; }
        const text = indexTextOf(c);
        if (text == null) { stat.unreadable++; unreadable++; continue; }
        // 存**原文**，不做 toLowerCase。小写化能省掉匹配时的 i 标志，但片段是从这段文本里切出来的 ——
        // 一旦烤进小写，页面上就会显示「命中 timeout」而卡片上写着「Timeout」，用户照着找找不到，
        // 还以为搜索坏了。大小写不敏感改由正则的 i 标志实现（见 searchEntries），不碰文本本身。
        t[r.turn] = text;
        stat.chars += text.length;
        if (text.length >= TEXT_CAP) stat.cut++;
      }
      const e0 = DEPS.entries.get(g.rows[0] && g.rows[0].id) || {};
      shard.files.set(g.file, { a: e0.agent || '', f: g.file, sig, t, tf });
      stat.indexed++;
      dirty.add(kind);
      if (o.log && stat.processed % 50 === 0) o.log('建全文索引… ' + stat.processed + '/' + stat.files + ' 个源');
      await tick();
    }

    reindex();
    lastRunAt = Date.now();
    // dry（agentacta --search-reindex --dry）：只统计不落盘。注意抽正文的代价照付 ——
    // 那不是「预估」，是真的把每个源读了一遍，只是最后不写。
    // 有剪枝、但这一轮没重建任何源时也要落一次盘（saveSearch 会把 pruneDirty 并进来），
    // 否则盘上的死记录要等到「这个 kind 下次有源变动」才清得掉 —— 而换平台后最坏情况是
    // 新机器上一份日志都没有，那它就一直清不掉。
    const saved = (!o.dry && (dirty.size || pruneDirty.size))
      ? saveSearch(dirty) : { ok: true, kinds: 0, bytes: 0, skipped: !!o.dry };
    stat.inIndex = IDX.size;
    stat.bytes = saved.bytes;
    stat.savedOk = saved.ok !== false;
    return stat;
  } finally {
    building = false;
  }
}

function safeDetail(id) {
  // entryContent 有自己的 catch，但 generic / cursor 那几条支路可能回 undefined，这里再兜一道：
  // 索引是附加能力，一条抽不出来不能让整轮挂掉。
  try { return DEPS.entryContent(id, false) || null; } catch { return null; }
}

// ---------------- 查询 ----------------
// 只做「文本命中 + 片段」，**不做 agent / 项目 / 时间范围那层筛选** —— 那套口径的唯一来源是主文件的
// filterEntries（项目还要过 projKey 归一化），在这里再实现一遍就是第二份口径。所以返回全部命中，
// 由主文件筛完再切片（这也就天然满足「默认不套时间范围」：主文件不传 from/to 就没有时间过滤）。
// 条目自带的元信息也参与匹配（正文没中才退到这一层）。顺序按「用户最可能拿它当关键词」排，
// 命中哪个就在片段上标出来（where），页面据此显示「命中：会话名」而不是摆一段看着不相干的正文。
const META_FIELDS = [
  ['输入摘要', e => e.preview || ''],
  ['会话', e => e.session || ''],
  ['项目', e => e.project || ''],
  ['模型', e => (e.models || []).join(' ')],
  ['工具', e => Object.keys(e.toolNames || {}).join(' ')],
];

function matchIn(x, re) {
  re.lastIndex = 0;
  const m = re.exec(x);
  return m ? { x, at: m.index, len: m[0].length || 1 } : null;
}

const SNIP_PRE = 60, SNIP_HIT = 120, SNIP_POST = 60;
function snippet(x, at, len) {
  const s = Math.max(0, at - SNIP_PRE);
  const hitEnd = Math.min(at + len, at + SNIP_HIT);
  return {
    // 三段分开回，**不在这儿拼 HTML**：页面拿到后各自转义再高亮，服务端不碰转义就不会有注入口子。
    pre: x.slice(s, at), hit: x.slice(at, hitEnd),
    post: x.slice(hitEnd, Math.min(x.length, at + len + SNIP_POST)),
  };
}

export function searchEntries({ q, regex } = {}) {
  ensureLoaded();
  const kw = String(q == null ? '' : q);
  if (!kw.trim()) return { ok: false, error: '关键词为空' };
  if (kw.length > MAX_QUERY) return { ok: false, error: '查询词过长（上限 ' + MAX_QUERY + ' 字）' };

  // 两种模式**都**走正则，只是子串模式先把关键词转义成字面量。这样匹配一律返回**原文**里的位置，
  // 片段天然是原始大小写；也省掉「维护一份小写副本」（那条路要 40MB 再来一遍）。
  // 转义后的字面量不可能回溯，所以子串模式的速度与安全性都不受正则引擎拖累。
  // 非法正则**不抛**：用户在输入框里边敲边搜，`[` 这种半截写法是常态，一次 500 会把整页搞红。
  // 如实回一条错误让页面提示，自己这边当「这一轮没搜到」处理。
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  try { re = new RegExp(regex ? kw : esc(kw), 'gi'); }
  catch (e) { return { ok: false, error: '正则写法有误：' + e.message }; }

  const matches = [];
  let stale = 0, scanned = 0;
  const deadline = Date.now() + QUERY_BUDGET_MS;
  for (const [id, it] of IDX) {
    const e = DEPS.entries.get(id);
    // 元数据已被 LRU 淘汰：条文还在索引里（盘上也还在），但这一轮报不出它 —— 没有时间/agent/项目
    // 就没法排序也没法筛选。**只计数、不假装它不存在**，页面据此说明「另有 N 条在当前内存窗口外」。
    if (!e) { stale++; continue; }
    scanned++;
    // 正则回溯能卡死事件循环（用户写个 (a+)+b 就是一场事故）。转义过的字面量不可能回溯，
    // 所以这条预算实际上只会在用户自己开了正则开关时才触发。
    if ((scanned & 255) === 0 && Date.now() > deadline)
      return { ok: false, error: '查询超时（正则可能回溯过深），把模式写得更具体些再试' };
    // 正文先搜：命中它才给得出有意义的上下文片段。
    let hit = matchIn(it.x, re);
    let where = '';
    if (!hit) {
      // 正文没中再退到条目自带的元信息 —— 页面搜索框一直承诺的是「内容 / 会话 / 模型…」，
      // 只搜正文等于把这个承诺砍掉一半。而且**工具名必须走这条路**：像 codearts 这种
      // entryContent 明确回 tools:[] 的 kind（详情页本来就不显示工具），工具名只存在于
      // 条目的 toolNames 上，不匹配它就永远搜不到「哪一轮跑过 Bash」。
      // 元信息也不进索引正文：它是**内存里的实时值**（项目名按 projKey 归一、模型名经映射表纠正），
      // 冻进索引就得跟着失效重建，不值当。
      for (const [label, get] of META_FIELDS) {
        const s = get(e);
        if (!s) continue;
        const m = matchIn(s, re);
        if (m) { hit = m; where = label; break; }
      }
    }
    if (!hit) continue;
    const snip = snippet(hit.x, hit.at, hit.len);   // 零长匹配（如 a*）也要给个可见片段
    if (where) snip.where = where;
    matches.push({ id, e, snip });
  }
  // 按时间降序（与 /api/snapshot、sortedEntries 同序）—— 主文件按自己的筛选口径再筛一遍之后
  // 直接切片就是页面要的顺序。**这里不截断**：主文件还要跟 filterEntries 的结果求交集，
  // 先截一道会让「命中 N 条」里的 N 变成「截断前 N 条里活下来的那些」，报出去的数就不是真数了。
  matches.sort((a, b) => (b.e.time || 0) - (a.e.time || 0));
  return {
    ok: true, total: matches.length, stale,
    // e 一律**浅拷贝**再挂字段：e 是 entries 里那个活对象，直接加字段会把搜索态漏进
    // /api/snapshot、会话视图、SSE 增量等所有别的出口（一个最容易被忽略的串味）。
    matches: matches.map(m => ({ e: { ...m.e }, snip: m.snip })),
  };
}

// 页面横幅的「已索引 A/B」。A 用反查得到的条数，B 用扫描链当前认识的条数 —— 两个数都在动
//（扫描在进、LRU 在淘），所以两个都如实给，不做「A==B 才算好」的判断。
export function searchStatus() {
  ensureLoaded();
  let bytes = 0, files = 0;
  for (const s of SHARDS.values()) files += s.files.size;
  try {
    for (const fn of fs.readdirSync(searchRoot())) {
      if (!fn.endsWith('.json') || fn.endsWith('.tmp')) continue;
      try { bytes += fs.statSync(path.join(searchRoot(), fn)).size; } catch {}
    }
  } catch {}
  return {
    ok: true,
    entries: IDX.size,        // 反查得到、这一轮查得动的条数
    files,
    total: DEPS.entries.size, // 扫描链当前认识的条数（分母）
    building, unreadable, noState, bytes, at: lastRunAt,
    // 载入时剪掉的「源不在本机」记录（跨平台搬运 / 日志被删）。A（entries）里已经不含它们了；
    // 单独报出来是为了让「换台机器后 A 一下子变小」有个解释，而不是让人以为索引丢了。
    pruned: prunedAtLoad,
    maxChars: DEPS.maxChars > 0 ? DEPS.maxChars : TEXT_CAP,
  };
}
