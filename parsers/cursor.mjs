// ---------------- cursor 解析器 ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanCursor。
// <base>/projects/<项目slug>/agent-transcripts/<会话uuid>/<同名>.jsonl，每行一个事件：
//   {role:'user'|'assistant', message:{content:[{type:'text',text}]}}
// 只有 text 块——**没有 token、没有模型、没有时间戳、没有工具调用**，所以这一路是「对话内容优先」的接入：
// 条目给 name='(无用量记录)'（沿用前端「小括号=无信息」的标记习惯），不当成没数据而不收。
//
// 用户轮：正文在 <user_query>…</user_query> 里（和 codebuddy 一个写法）。同一条记录前面可能挂
// <attached_files>…</attached_files> 之类的上下文注入——那不是用户说的话，只在没有 user_query 时才考虑它。
// 连续的 assistant 行是**同一轮回复的多个步骤**（先想、再动手、最后总结），按顺序拼进同一轮。
//
// 时间：文件里没有。退而取转录文件自己的 mtime 当整段会话的时间——它至少是真实的（文件确实是那时写的），
// 且能让这些条目落在正确的时间位置上；同一个会话里的所有轮共用这一个时间，展示时按轮序倒序排（见 emitCursorTurns）。
//
// 与 gemini 同样**不进 OFF_KINDS**：这里用整份会话重解析 + {mtime,size} 签名跳过没变的目录。
// 转录是「后到的 assistant 行会继续挂到当前那一轮上」的追加式文件，用增量偏移极易把最后几轮算重；
// 单份转录只有几十 KB，整份重读比维护偏移可靠得多（同 §6 的教训）。
// 「为什么 cursor 全是无用量记录」——这个问题的答案不在解析器里，在数据里，所以直接写在详情上。
//
// 本机实测（把一个转录文件的每一行都拆开看过）：顶层只有 `role` 和 `message` 两个键，
// message 下只有 content，content 里**只有 text 块**。没有 token、没有模型名、没有时间戳、没有工具调用。
// 也就是说 cursor 的转录是**纯对话**，不是「带用量的调用记录」—— 与 codex/claude 那种
// 边跑边记 usage 的 jsonl 不是一类东西。既然源头没有，卡片上的 token / 调用次数就只能恒为 0，
// 模型也只能空着（能显示模型名的地方只有 ~/.cursor/ai-tracking 那个 sqlite，
// 但它的 model 列本机实测写的是 `"default"` 或 null —— 是 Cursor 内部的枚举，不是真模型名，
// 而且整张表记的是「AI 改过哪些文件」，没有 token 字段；详见需求书 §21）。
//
// ---------------- 逐轮 token：只能靠 Cursor 自己的 stop 钩子采回来 ----------------
// 上面说的「源头没有」只针对**已经落地的文件**。Cursor 在每轮 agent loop 结束时会把一份载荷递给
// stop 钩子，那份载荷里**有**逐轮用量（input_tokens / output_tokens / cache_read_tokens /
// cache_write_tokens，外加 model / model_id / generation_id）—— 这是本地唯一的逐轮 token 来源。
// 所以接入方式是：页面 cursor 行的图标按钮往 ~/.cursor/hooks.json 注入一条命令（hooks/cursor-usage-hook.mjs），
// 脚本把用量追加到 ~/.agent-acta/cursor-usage.jsonl，这里读那份日志、按会话配对贴回轮上。
// 没注入 hook 的机器上这份日志不存在 —— 行为与从前**完全一致**（全 0 + 原样的说明文案），
// 这就是下面所有分支都写成「读不到就当没有」的原因。
import fs from 'node:fs';
import path from 'node:path';
import { HOME, files, entries, srcs, removedIds, sorted, addEntry, listDirCached, isDir, sqliteMod } from './shared.mjs';
export const CURSOR_NO_USAGE_NOTE = 'Cursor 的转录文件里只有对话正文（role + text）——没有模型名、token 用量、时间戳，也没有工具调用。'
  + '（逐轮 token 本地只有一条来源：Cursor 的 stop 钩子。侧栏 cursor 行那个「注入 token 采集 hook」按钮就是去装它。）';
// 注了 hook、这一轮也真的采到了用量时说的那段（口径三句，都是从钩子载荷的实测语义来的）
export const CURSOR_HOOK_NOTE = '本轮 token 来自 Cursor 的 stop 钩子（AgentActa 注入的 cursor-usage-hook 采集）。三点口径：'
  + '① 这是**这一轮**的累计值 —— 一次用户请求里所有模型调用加总，不是单次调用；'
  + '② 载荷里的 input_tokens **含**缓存两项，卡片上的「输入」已按 input − cache_read − cache_write 减过，不会重复计；'
  + '③ **不含子智能体（subagent）的用量** —— Cursor 的 subagentStop 只给元信息、不给 token，这部分目前采不到。'
  + '注入之前的历史轮次没有这份数据，token 仍是 0（不是没记，是那时还没采）。';

const CURSOR_UQ_RE = /<user_query>([\s\S]*?)<\/user_query>/;
// <timestamp> 也要剥：新版本每条 user 消息都以它开头（见 cursorTurnTime），
// 在「没有 user_query」的兜底分支里不剥就会把「星期二, 9月15日…」当用户说的话
const CURSOR_CTX_RE = /<(attached_files|system_reminder|system-reminder|terminal_selection|timestamp)\b[^>]*>[\s\S]*?<\/\1>/g;
// 新版本每个 user 消息里带一行真实时间：
//   <timestamp>Tuesday, Sep 15, 2026, 3:44 PM (UTC+8)</timestamp>
// 这是 cursor 这一路**唯一**的时间来源（转录本身没有时间戳字段）——
// 老版本没有它，整段会话只能退回文件 mtime（所有轮共用一个时间）。
const CURSOR_TS_RE = /<timestamp>([\s\S]*?)<\/timestamp>/;
const CURSOR_CLI_TITLE = '(无用量记录)';

// ---------------- cursor 的模型名：只能从 Cursor IDE 自己的会话库里取 ----------------
// 转录文件里**没有**模型字段（实测只有 role + text，见 §21）。记着模型的是 IDE 的
// globalStorage/state.vscdb（SQLite，表 cursorDiskKV）：
//   composerData:<会话id>        → modelConfig.modelName    会话级默认模型
//   bubbleId:<会话id>:<气泡id>    → modelInfo.modelName       逐条消息**实际**用的模型
// 键里的**会话 id 就是转录所在目录的名字**，能直接对上。
//
// 「以气泡为准」不只是精度问题：会话级配置写着 A、而 Auto 模式实际路由到 B 时，
// 只有气泡上的字段是真的。实测 modelInfo 只挂在 **type=1（用户）气泡**上，而转录里
// 「一条 user 记录 = 一轮」—— 于是**第 k 个用户气泡就是第 k 轮**，按顺序对上即可，
// 不用按时间匹配。气泡没带 modelInfo 的（老数据）回落到会话级默认值。
//
// 三条硬约束：
//   1. **零依赖**：只用 Node 22.5+ 自带的 node:sqlite，没有就静默关闭。
//      （engines 2026-09-16 起写 >=22.5，但 npm 的 engines 只警告不拦人 —— 老 Node 照样装得上，
//        所以这里的容错分支不能删。）
//   2. **只读**：readOnly 打开，永不写。读不到/被锁/结构变了 → 当作没有，行为与从前完全一致。
//   3. **不额外扫盘**：只在转录**真的变了**时查（scanCursorSlug 有签名短路），平时零开销。
const CURSOR_DB_OFF = !!process.env.AGENT_LOG_NO_CURSOR_DB;   // 不想被读这个库的人可以关掉
export const CURSOR_MODEL_NOTE = '模型名、上下文占用与工具次数取自 Cursor IDE 的会话存储（state.vscdb），转录文件本身不带这些字段。'
  + '三点口径要说清：'
  + '① 上下文占用是**会话当前**的值，同一会话的每一轮显示的是同一个数（源里只有会话级，没有逐轮的值）；'
  + '② 工具次数是按 toolCallId 去重数出来的**精确值**（同一个调用会在多行气泡里重复出现，不去重会翻几倍）；'
  + '③ 输入/输出/缓存在没有注入 token 采集 hook 时恒为 0 —— 那个库的 usageData 是空对象、每条消息的 tokenCount 恒为 0；'
  + '注了 hook 的轮次就有逐轮真值（那几轮另有一段说明）。'
  + '**「N 次 LLM」这个徽章这里不显示**：Cursor 按聊天消息存库、不按每次模型请求存，'
  + '能从气泡数到的只有「带工具调用的模型请求数」，而每轮收尾那次只产文字、数不到，那是个下界 —— '
  + '写 0 等于说这轮没调过模型，写下界又会被当成准数，所以干脆不显示。'
  + '耗时同理留空：源里只在少数消息上零星记了起止时间，覆盖不全。';

// node:sqlite 加载器在 shared.mjs（cursor / zcode / discovery 的嗅探共用同一份实例，
// 避免三处各压一次 ExperimentalWarning 各缓存一份模块）。直接用 shared 的 sqliteMod。

// Cursor 的 state.vscdb 按平台各在一个固定位置；正式版与 Nightly 都试一下
function cursorStateDbPath() {
  const rel = ['User', 'globalStorage', 'state.vscdb'];
  const names = ['Cursor', 'Cursor Nightly'];
  const cands = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) for (const n of names) cands.push(path.join(process.env.APPDATA, n, ...rel));
  } else if (process.platform === 'darwin') {
    for (const n of names) cands.push(path.join(HOME, 'Library', 'Application Support', n, ...rel));
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    for (const n of names) cands.push(path.join(cfg, n, ...rel));
  }
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

// 连接只开一次并留着：扫描每 3s 一轮，每次重开一个 20MB 的库不划算。
// 但库是 Cursor 在用的（WAL、随时在写），所以**任何一次查询出错就丢掉句柄**、
// 一分钟内不再重试 —— 宁可这一轮没有模型名，也不能让它把整轮扫描带崩。
let _cursorDb = null, _cursorDbFailedAt = 0;
function cursorStateDb() {
  if (_cursorDb) return _cursorDb;
  if (Date.now() - _cursorDbFailedAt < 60000) return null;
  const mod = sqliteMod();
  if (!mod) return null;
  const p = cursorStateDbPath();
  if (!p) return null;
  try { _cursorDb = new mod.DatabaseSync(p, { readOnly: true }); return _cursorDb; }
  catch { _cursorDbFailedAt = Date.now(); return null; }
}
// 库里的 modelName 不一定真是模型名：**实测全库分布**是 `default` ×33 / `gemini-3-flash` ×3 /
// `grok-4.6` ×3 —— 那 33 个 `default` 是 Cursor 的内部枚举（「没指定，用默认」），
// 老会话（本机 2 月那批）全是它。把 `default` 当模型名填到卡片上，用户看到的是「default」，
// 比空着更误导（而且他会以为这是某个真模型）。所以这类哨兵值一律当没有。
// `auto` 同理：Auto 模式实际落到哪个模型，按 Cursor 自己的说法要看**气泡**上的 modelInfo，
// 会话级的 `auto` 只是个模式名，不是模型。
const CURSOR_MODEL_SENTINELS = new Set(['default', 'auto', 'automatic']);
const _modelNameOf = o => {
  const s = o && typeof o.modelName === 'string' ? o.modelName.trim() : '';
  return CURSOR_MODEL_SENTINELS.has(s.toLowerCase()) ? '' : s;
};
function cursorDropDb() { try { _cursorDb && _cursorDb.close(); } catch {} _cursorDb = null; _cursorDbFailedAt = Date.now(); }

// 取这个会话的元信息：{ def, perTurn[], ctxUsed, ctxLimit }；拿不到返回 null（调用方原样保留空值）
//
// 上下文占用（contextTokensUsed / contextTokenLimit）也在 composerData 上 —— 它是**会话当前**的值，
// 不是每一轮各自的值：Cursor 只在会话级记这个数，气泡上没有任何逐轮的上下文字段
// （实测气泡里 tokenCount 恒为 0、context 只是个 {composers:[]…} 的引用列表）。
// 所以同一会话的每一轮拿到的是同一个数 = 会话最新的占用，这一点必须在详情里写明，
// 否则会被当成「那一轮当时的占用」（早期轮次其实远没这么满）。
function cursorSessionMeta(sessionId) {
  if (!sessionId) return null;
  const db = cursorStateDb();
  if (!db) return null;
  try {
    let def = '', ctxUsed = 0, ctxLimit = 0;
    const cd = db.prepare('select value from cursorDiskKV where key = ?').get('composerData:' + sessionId);
    if (cd && cd.value) {
      try {
        const j = JSON.parse(cd.value);
        def = _modelNameOf(j && j.modelConfig);
        ctxUsed = Number(j && j.contextTokensUsed) || 0;
        ctxLimit = Number(j && j.contextTokenLimit) || 0;
      } catch {}
    }

    // 气泡要先**整体**按时间排好再切轮：同一个 toolCallId 会以多行出现（实测有 1/2/4 次的），
    // 且行的顺序不保证。用 key 做次序键，保证同一时间戳下的顺序也是确定的。
    const rows = db.prepare('select key, value from cursorDiskKV where key like ?').all('bubbleId:' + sessionId + ':%');
    const bs = [];
    for (const r of rows) { let j; try { j = JSON.parse(r.value); } catch { continue; } if (j) { j.__k = r.key; bs.push(j); } }
    bs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.__k).localeCompare(String(b.__k)));

    // 切轮：一个 type=1（用户气泡）开一轮，其后到下一个用户气泡为止的助手气泡都算这一轮。
    // 这与「转录里一条 user 记录 = 一轮、第 k 个用户气泡就是第 k 轮」是同一套顺序，两边能对上。
    const turns = [];
    for (const b of bs) {
      if (b.type === 1) { turns.push({ m: _modelNameOf(b.modelInfo), tool: new Set(), mc: new Set() }); continue; }
      if (b.type !== 2 || !turns.length) continue;
      const d = b.toolFormerData;
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
      const cur = turns[turns.length - 1];
      // 按 id 去重：一个工具调用会在多个气泡行上重复出现，直接计数会翻好几倍
      if (d.toolCallId) cur.tool.add(d.toolCallId);
      if (d.modelCallId) cur.mc.add(d.modelCallId);
    }
    if (!turns.length && !def && !ctxLimit) return null;
    return {
      def, ctxUsed, ctxLimit,
      perTurn: turns.map(t => t.m),
      // 工具调用次数：**精确值**（每个工具调用有唯一 toolCallId）。
      // modelCalls：**只是下界**，见 emitCursorTurns 里把 calls 留成 null 的说明。
      tools: turns.map(t => t.tool.size),
      modelCalls: turns.map(t => t.mc.size),
    };
  } catch { cursorDropDb(); return null; }
}

// ---------------- stop 钩子采到的逐轮用量（~/.agent-acta/cursor-usage.jsonl） ----------------
// 一行一条，由 hooks/cursor-usage-hook.mjs 追加（字段口径见那个文件头）。这里只做两件事：
// 读成「按会话分组、组内按时间升序」的表，然后把每一轮该拿哪条算出来。
const CURSOR_USAGE_FILE = path.join(HOME, '.agent-acta', 'cursor-usage.jsonl');
let _usageCache = null;   // { sig, byConv }：整份日志很小（一行一轮），mtime/size 变了才重读
// 这份日志的签名要并进「这份转录变了没」的判定（scanCursorSlug）：只注了 hook、转录一个字节没变时，
// 也必须重解析才能把新采到的用量贴上卡片。没有这份日志时返回 ''，签名与从前逐字节相同。
export function cursorUsageSig() {
  try { const st = fs.statSync(CURSOR_USAGE_FILE); return st.mtimeMs + '|' + st.size; } catch { return ''; }
}
const _un = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };
function cursorUsageByConv() {
  const sig = cursorUsageSig();
  if (!sig) { _usageCache = null; return null; }        // 没注入 hook / 还没采到：当作没有
  if (_usageCache && _usageCache.sig === sig) return _usageCache.byConv;
  let txt;
  try { txt = fs.readFileSync(CURSOR_USAGE_FILE, 'utf8'); } catch { _usageCache = null; return null; }
  const acc = new Map();                                // conv -> Map(gen -> rec)，同 gen 去重
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }   // 半行/坏行跳过（追加写可能留半行）
    const conv = j && typeof j.conv === 'string' ? j.conv : '';
    if (!conv) continue;
    const cr = _un(j.cr), cw = _un(j.cw), inp = _un(j.in);
    const rec = {
      ts: Number(j.ts) || 0,
      gen: typeof j.gen === 'string' ? j.gen : '',
      status: typeof j.status === 'string' ? j.status : '',
      model: typeof j.model === 'string' ? j.model.trim() : '',
      // input_tokens 含缓存两项（实测口径）：减掉才是「真正没命中的输入」，clamp 在 0。
      // 不减就会把缓存读/写重复算进「输入」，缓存大的轮次会离谱地翻倍。
      tin: Math.max(0, inp - cr - cw), tout: _un(j.out), tcache: cr + cw,
    };
    let m = acc.get(conv); if (!m) { m = new Map(); acc.set(conv, m); }
    // 同一个 generation（= 同一次用户请求）会因自动续跑被 stop 触发多次、值相同 ——
    // 按 gen 去重留 ts 最大的那条（最后落的那条才是这一轮的终值）。没有 gen 的老数据用 ts 兜底。
    const key = rec.gen || ('t' + rec.ts);
    const prev = m.get(key);
    if (!prev || rec.ts >= prev.ts) m.set(key, rec);
  }
  const byConv = new Map();
  for (const [conv, m] of acc) byConv.set(conv, [...m.values()].sort((a, b) => a.ts - b.ts));   // 升序 = 轮序
  _usageCache = { sig, byConv };
  return byConv;
}

// 把用量记录对齐到转录的轮上。转录里**没有 generation_id**（老版本连时间戳都没有），
// 所以只能靠时间或顺序对，两条路按可信度排（timed = 每一轮都带真实 <timestamp>）：
//   1) timed → **按轮开始时间分桶**：落在 [T_k, T_{k+1}) 的用量属于第 k 轮。
//      中间有轮没采到（Cursor 重启过、hook 刚装）也不会整体错位。
//   2) 不是 timed（老版本，整段会话共用一个 mtime）→ **后缀对齐**：把用量记录的最后 N 条
//      按序贴到最后 N 轮上。只在「装上 hook 之后的轮都在末尾、且每条都采到了」时成立，所以它只是兜底。
// ⚠️ timed 由调用方显式传进来，**不在这里读 t.time**：调用方随后会把「没有时间戳的轮」的 time
//    填成文件 mtime（那不是这一轮的开始时间，拿去分桶会把整段会话都判给最后一轮）。
function cursorPairUsage(turns, list, timed) {
  const out = new Array(turns.length).fill(null);
  if (!list || !list.length || !turns.length) return out;
  const add = (k, rec) => {
    const p = out[k];
    if (!p) { out[k] = { ...rec }; return; }
    p.tin += rec.tin; p.tout += rec.tout; p.tcache += rec.tcache;   // 同一轮多 generation：相加
    if (!p.model) p.model = rec.model;
  };
  if (timed) {
    const starts = turns.map(t => t.time);
    for (const rec of list) {
      // 最后一个「开始时间 <= 这条用量落盘时间」的轮。线性扫，轮数很小；不做 break 是为了
      // 万一时间戳不是严格升序（同一秒的两轮）也能取到最靠后的那个。
      let k = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= rec.ts && (k < 0 || starts[i] >= starts[k])) k = i;
      if (k >= 0) add(k, rec);   // k<0 = 早于整段会话（理论上不该有）：丢掉，不硬塞给第 0 轮
    }
    return out;
  }
  const n = Math.min(list.length, turns.length);
  for (let i = 0; i < n; i++) out[turns.length - n + i] = { ...list[list.length - n + i] };
  return out;
}

// 从 <timestamp> 文本算出这一轮的真实时间；拿不到返回 0（调用方退回 mtime）。
//
// 为什么自己拆偏移而不是直接 Date.parse：Date.parse 会**按本机时区**解释这段墙上时间，
// 而字符串自带的 (UTC±N) 恰好说明了它该按哪个时区理解 —— 引擎会不会尊重那个后缀是没保证的。
// 本机时区与 Cursor 报的偏移一致时两者结果相同；不一致时（远程/跨时区）只有自己算是准的。
function cursorTurnTime(raw) {
  const m = String(raw || '').match(CURSOR_TS_RE);
  if (!m) return 0;
  const s = m[1].trim();
  const t = Date.parse(s.replace(/\s*\(UTC[^)]*\)\s*/, ''));
  if (!Number.isFinite(t)) return 0;
  const off = s.match(/\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)/);
  if (!off) return t;                                   // 没有偏移说明：就按本机时区理解
  const want = (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] || 0));
  const have = -new Date(t).getTimezoneOffset();        // 本机偏移（分钟，东为正），与 want 同符号
  return t + (have - want) * 60000;
}

function cursorText(line) {
  const c = line?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => (typeof b === 'string' ? b : String(b?.text || ''))).join('\n');
}

// 取这一条 user 记录里「用户真正说的话」；返回空串表示这不是一次请求，不该开轮
// raw0：调用方已经算过 cursorText 时传进来，省一次拼接（两份必须同源，别各取各的）
function cursorUserText(line, raw0) {
  const raw = raw0 != null ? raw0 : cursorText(line);
  const m = raw.match(CURSOR_UQ_RE);
  if (m) return m[1].trim();
  // 没有 user_query：可能是纯上下文注入（<attached_files> 单独一条），剥掉已知块后还剩东西才算请求
  return raw.replace(CURSOR_CTX_RE, '').replace(/<\/?[a-z_]+>/gi, '').trim();
}

function cursorTurn(text0, sid, time) {
  return {
    user: text0, assistant: '', tools: [], callList: [],
    time, lastTs: time, dur: 0, tin: 0, tout: 0, tcache: 0, nCalls: 0, nTools: 0,
    models: [], err: false, aborted: false, finished: false, session: sid, title: CURSOR_CLI_TITLE,
    preview: text0.replace(/\s+/g, ' ').slice(0, 300),
  };
}

// 一份转录：整文件解析（调用方按签名决定是否重解析）
function cursorSessionFile(fp) {
  const sessionId = path.basename(fp, '.jsonl');
  const turns = [];
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; } // 追加写可能留半行，跳过就是
    if (j?.role === 'user') {
      const raw = cursorText(j);
      const text0 = cursorUserText(j, raw);
      if (!text0) continue; // 空/纯上下文注入：不开轮（扫描与详情同口径）
      turns.push(cursorTurn(text0, sessionId, cursorTurnTime(raw)));   // 0 = 没带时间戳，调用方退回 mtime
      continue;
    }
    if (j?.role === 'assistant') {
      const cur = turns[turns.length - 1];
      if (!cur) continue; // 轮次之前的 assistant（很少见）：没有归属，丢掉
      const txt = cursorText(j).trim();
      if (txt) cur.assistant = cur.assistant ? cur.assistant + '\n\n' + txt : txt;
      continue;
    }
    // 新版本在每轮末尾追加一条 {type:'turn_ended', status:'success'} —— 没有 role/message。
    // 它本身不是内容，但 status 有用：非 success（中断/失败）就把这一轮标成 error，
    // 否则「这轮被中断了」在页面上完全看不出来。取值不做假设，只要不是 success 就算异常。
    if (j?.type === 'turn_ended') {
      const cur = turns[turns.length - 1];
      if (cur && j.status) {
        cur.finished = true;
        if (j.status !== 'success') {
          if (/abort|cancel|interrupt/i.test(String(j.status))) cur.aborted = true;
          else cur.err = true;
        }
      }
      continue;
    }
  }
  return { sessionId, turns };
}

export function scanCursor(agent, root) {
  for (const slug of listDirCached(root) || []) {
    const dir = path.join(root, slug);
    if (!isDir(dir)) continue;
    try { scanCursorSlug(agent, dir, slug); } catch (e) { console.error('[cursor]', slug, e.message); }
  }
}

// 列出一份 <agent-transcripts>/ 下的转录文件。**两种落法都认**：
//   <agent-transcripts>/<uuid>/<uuid>.jsonl   本机实测的形态，也是原来探测与扫描唯一认的一种
//   <agent-transcripts>/<名字>.jsonl          平铺（新版本 Cursor 若改成这样落，
//                                             旧写法会让**探测和扫描一起瞎**：探测说没这回事、
//                                             扫描也捞不到文件，症状跟「没跑过 Agent」一模一样，极难分辨）
// 探测（hasCursorTranscripts）与扫描（scanCursorSlug）**共用这一个函数**：
// 两边各写一份的话，「解析器读得出来、探测却说不认识」这种自相矛盾迟早出现。
// 走 listDirCached，与目录列表缓存是同一份，不会额外增加 readdir 开销。
export function cursorTranscriptFiles(at) {
  const out = [];
  for (const u of listDirCached(at) || []) {
    const ud = path.join(at, u);
    if (isDir(ud)) {
      for (const n of listDirCached(ud) || []) {
        if (n.endsWith('.jsonl')) out.push({ fp: path.join(ud, n), uid: u });
      }
    } else if (u.endsWith('.jsonl')) {
      out.push({ fp: path.join(at, u), uid: path.basename(u, '.jsonl') });
    }
  }
  return out;
}

function scanCursorSlug(agent, dir, slug) {
  const at = path.join(dir, 'agent-transcripts');
  const found = [];
  for (const { fp } of cursorTranscriptFiles(at)) {
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.isFile()) found.push([fp, st]);
  }
  const key = 'cursor:' + dir;
  const prev = files.get(key);
  // 签名 = 所有转录文件 + **那份 hook 用量日志**。带上日志是必须的：只注了 hook 而转录没再写时，
  // 也必须重解析才能把新采到的用量贴上卡片（否则要等下一次对话才看得见）。
  const sig = found.map(([fp, st]) => fp + '|' + st.mtimeMs + '|' + st.size).join(';') + ';u:' + cursorUsageSig();
  if (prev && prev.data.sig === sig) return; // 没变：本轮不重解析
  const usage = cursorUsageByConv();
  const turns = [];
  for (const [fp, st] of found) {
    try {
      const r = cursorSessionFile(fp);
      // 模型名：转录里没有，去 Cursor IDE 的会话库里按同一个会话 id 取。
      // 每轮取「第 k 个用户气泡」上的 modelInfo，没有则回落到会话级默认值（见 cursorTurnModels）。
      // **只在转录变了的时候才走到这里**（上面有签名短路），所以不会每 3s 去查一次库。
      const tm = cursorSessionMeta(r.sessionId);
      // 这一份转录对应会话的 hook 用量（没有就全 null），下面按轮贴上。
      // timed = 每一轮都带真实 <timestamp>（新版 Cursor）—— 此时才能按时间分桶；否则后缀对齐。
      // 必须在这之前算：下面 forEach 会把没有时间戳的轮的 time 填成文件 mtime，那之后就分不清了。
      const timed = r.turns.length > 0 && r.turns.every(t => t.time > 0);
      const umap = cursorPairUsage(r.turns, usage ? usage.get(r.sessionId) : null, timed);
      // 轮序按会话内从 0 数（不是 slug 内累计）：新增一份转录不会让别人的 id 漂移
      r.turns.forEach((t, k) => {
        t.ord = k;
        const mdl = tm ? (tm.perTurn[k] || tm.def) : '';
        t.models = mdl ? [mdl] : [];
        // 工具调用次数能从气泡精确数出来（toolFormerData 按 toolCallId 去重）。
        // 注意它**不是** LLM 调用次数 —— 那个本地推不出来，见 emitCursorTurns 的说明。
        t.tools = tm && tm.tools ? (tm.tools[k] || 0) : 0;
        t.modelCalls = tm && tm.modelCalls ? (tm.modelCalls[k] || 0) : 0;
        // 上下文占用是**会话当前**的值（源里只有会话级），同一会话的每一轮都是同一个数 ——
        // 详情里写明了这一点，见 CURSOR_MODEL_NOTE。
        if (tm && tm.ctxLimit) { t.ctx = tm.ctxLimit; t.ctxUsed = tm.ctxUsed; }
        // 逐轮用量：贴上 hook 采到的那份（没采到的轮保持 0）。
        // 模型名**以 IDE 会话库为准**（它有逐气泡的 modelInfo，精度更高），库里没有才用钩子带的 model_id
        // 顶上 —— 钩子的 model 是档位名（cursor-grok-4.6-high-fast），我们只落 model_id。
        const u = umap[k];
        if (u) {
          t.tin = u.tin; t.tout = u.tout; t.tcache = u.tcache;
          t.total = u.tin + u.tout + u.tcache;
          t.usage = true;
          if (!t.models.length && u.model) t.models = [u.model];
        }
        // 标题：这一路本来一律是「(无用量记录)」。既然有轮真的采到用量、或至少认得模型名了，
        // 就不能再挂着那句；清空后 titleOf 会退回模型名 / 「(无模型信息)」。
        if (t.usage || t.models.length) t.title = '';
        // 时间：新版本每轮自带 <timestamp>（真时间，各轮互不相同），老版本没有 → 整段会话共用文件 mtime。
        // 只有 time 用真值，**lastTs 仍留成同一个值**：dur = lastTs - time，这一路拿不到「这一轮什么时候结束」，
        // 拿下一轮的开始时间顶上去会把两轮之间的挂机时间算成这一轮的耗时（本机别的 agent 已经因为
        // 挂机轮污染过耗时统计，见 §17 的 ⚠ 标记）。宁可耗时留 0，也不往日报表里灌假数。
        // （hook 的 ts 确实是「这一轮结束」的时刻、够算 dur —— 但那会让卡片/日报表/时延分析的耗时口径
        //   只对注了 hook 的轮生效，同一张表里两套口径，故不做；要做得单独立一条。）
        t.time = t.time || st.mtimeMs; t.lastTs = t.time;
        turns.push(t);
      });
    } catch (e) { console.error('[cursor] parse', path.basename(fp), e.message); }
  }
  const data = { sig, project: slug, rev: (prev?.data?.rev || 0) + 1, turns };
  files.set(key, { agent, kind: 'cursor', m: 0, s: 0, off: 0, data });
  emitCursorTurns(agent, key, data, prev?.data);
}

function emitCursorTurns(agent, key, data, prevData) {
  const idBase = 'r#' + key.slice(7).replace(/[\\/:]/g, '~') + '#';
  const ids = new Set();
  // 倒序发出：老版本的一整个会话共用同一个 time（文件 mtime），而 entries 是 Map、快照排序是稳定排序，
  // 并列时按插入顺序展示——倒着插才能让最后一轮排在最前（和全局的新→旧一致）。
  // 先删后插是必须的：Map.set 对已存在的 key **不改变插入位置**，否则重扫多出来的新轮会跑到末尾去。
  for (let i = data.turns.length - 1; i >= 0; i--) {
    const t = data.turns[i];
    const id = idBase + t.session + '#' + t.ord;
    ids.add(id);
    entries.delete(id); srcs.delete(id);
    addEntry(id, {
      agent, project: data.project, session: t.session,
      // status 原来写死 'ok'：新版转录末尾那条 {type:'turn_ended',status:'aborted'} 标出来的中断，
      // 到这一步就被丢掉了，卡片永远显示 OK。t.err 由 cursorSessionFile 从那儿取。
      time: t.time, dur: 0, status: t.err ? 'error' : 'ok',
      // 逐轮用量：注了 token 采集 hook 的机器上这是钩子采到的真值（口径见 CURSOR_HOOK_NOTE），
      // 没注的机器上恒为 0（源里没有，见 CURSOR_NO_USAGE_NOTE）。total 与别家一样是三项之和。
      tin: t.tin || 0, tout: t.tout || 0, tcache: t.tcache || 0, total: t.total || 0,
      // ctx = 窗口容量，ctxUsed = 占用（页面那根进度条要的是后者，见页面 ctxUsed 注释）
      //
      // calls / rounds 刻意留 **null**（页面用 `!= null` 判断，null 就不显示这个徽章）：
      // Cursor 按「聊天消息」存库、不按「每一次 provider 调用」存，一轮里「思考→调工具→再调模型→…」
      // 中间那些请求大部分不会各变成一条气泡。能从气泡里数到的只有「**带工具调用**的模型请求数」
      // （去重 modelCallId，实测全库 87 个 < 工具调用 123 个，说明一次请求可带多个工具），
      // 而每轮收尾那次只产文字、不带工具，数不到 —— 那是个**下界**。
      // 写 0 是撒谎（等于说这一轮没调过 LLM），写下界又会被当成准数，所以宁可不显示。
      ctx: t.ctx || 0, ctxUsed: t.ctxUsed, rounds: null, calls: null,
      tools: t.tools || 0,   // 这个是精确值，照常显示
      finished: !!t.finished || i < data.turns.length - 1, aborted: !!t.aborted, toolNames: t.toolNames || {},
      models: t.models || [], preview: t.preview, name: t.title,
    }, { file: key, turn: i, kind: 'cursor' });
  }
  // 转录被截断/删除时残留的旧条目要撤掉
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}
