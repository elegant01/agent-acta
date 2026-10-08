// ---------------- 解析器公共依赖（parsers/* 共用，唯一出口） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。这里只放「解析器真正需要的」：
//   * 扫描状态（files / entries / srcs / pidCwd / dirty …）—— 由主进程创建、所有解析器**共享同一份**，
//     千万不要在这里 new 完再导出别名（那会是两份 Map，条目会凭空消失）；
//   * 条目登记（addEntry / toolNameCounts）；
//   * 口径工具（modelName / toText / trunc / windowOf）；
//   * 目录缓存与常量表（OFF_KINDS / PARSER_REV）。
// HTTP / 扫描调度 / 配置读写 / 详情聚合仍留主文件。
import fs from 'node:fs';
import pathMod from 'node:path';
import os from 'node:os';
export const path = pathMod;   // 解析器顺手用：不从 shared 拿也行，自己 import node:path 等价

// ---------------- node:sqlite 加载器（cursor / zcode / discovery 的嗅探共用一份） ----------------
// node:sqlite 是实验特性，require 时会往 stderr 打一行 ExperimentalWarning。
// 那行对用户没意义（我们只是拿它读一个本地文件），却会把 --where / 前台运行/服务日志弄脏，
// 所以只在加载这一下挡住，加载完立刻恢复；挡的条件卡死「ExperimentalWarning + SQLite」，
// 别的警告一律照常。模块级缓存：三个使用方拿到的必然是同一个模块对象。
import { createRequire } from 'node:module';
let _sqlite = null, _sqliteTried = false;
export function sqliteMod() {
  if (_sqliteTried) return _sqlite;
  _sqliteTried = true;
  if (!!process.env.AGENT_LOG_NO_CURSOR_DB) return null;   // 不想被读库的人可以关掉（cursor 注释同源）
  try {
    const req = createRequire(import.meta.url);
    const orig = process.emitWarning;
    process.emitWarning = function (w, ...rest) {
      const t = (rest[0] && typeof rest[0] === 'object' ? rest[0].type : rest[0]) || '';
      if (t === 'ExperimentalWarning' && String(w).includes('SQLite')) return;
      return orig.apply(this, [w, ...rest]);
    };
    try { _sqlite = req('node:sqlite'); } finally { process.emitWarning = orig; }
  } catch { _sqlite = null; }   // Node < 22.5：没有这个模块，功能静默关闭（不是错误）
  return _sqlite;
}

export const HOME = os.homedir();
export function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// ---------------- 扫描状态（主文件与解析器共享同一份引用） ----------------
export const files = new Map();    // path -> {agent,kind,m,s,off,data}
export const entries = new Map();  // id -> entry(stats only)
export const srcs = new Map();     // id -> {file, turn, msgIndex, kind}
export const pidCwd = new Map();   // "agent|pid" -> cwd
export const dirty = new Set();    // entry ids changed since last broadcast
export const removedIds = [];      // entry ids removed since last broadcast
export const agentNotices = [];    // [{added:name}|{removed:name}] since last broadcast
export const kindDirty = new Set();// 待落盘的 index 分片 kind
// snapshot 排序缓存（addEntry/purge 时置脏）。用对象包一层：模块间传引用，主文件直接替换
// 这个变量的话解析器看到的是旧对象 —— 所以只允许改 .cache 字段，不允许整体重新赋值。
export const sorted = { cache: null };

// 带 off 增量语义的 kind：index 只持久化这些；meta/trace 无 off，每次启动重扫重建 entries（勿改，见需求书 §4.7）
// dsh 也**不在**这里面：它的会话是多帧 zstd，帧长不写进帧头，没法从任意字节偏移续读 ——
// 与 gemini / cursor 同一路数（整份重解析 + {mtime,size} 签名跳过没变的文件），故不进 OFF_KINDS。
// tracecode / tracework 走 codearts 那种「文本日志 + off 增量读」：renderer.log 在会话进行中持续追加，
// 用 mtime+size 签名跳过没变的文件、用 off 续读新增行，故进 OFF_KINDS（data.sessions[] 持久化）。
export const OFF_KINDS = new Set(['jsonl', 'claude', 'buddyjsonl', 'codearts', 'codex', 'kimi', 'copilot', 'tracecode', 'tracework',
  // doubao（豆包 Work 智能体）：trajectory.jsonl 是逐行追加的 OpenAI 风格消息流，逐行 off 续读
  // 语义与 claude 完全一致，故进 OFF_KINDS；assignment.md 时间戳随 data 一起落盘。
  'doubao',
  // minimax（Mavis 本地运行时）：~/.minimax/v2/sessions/<...>/messages.jsonl 是逐行追加的
  // Anthropic 风格消息流（message.role / message.content），每行带 usage/model/stopReason。
  // 逐行 off 续读语义与 claude/doubao 完全一致，故进 OFF_KINDS。
  'minimax',
  // openclaw（OpenClaw）：<stateDir>/agents/<id>/sessions/<uuid>.jsonl 是追加式会话树
  // （首行会话头 + 其后逐行 message/session_info/model_change/custom/compaction 条目），
  // 逐行 off 续读语义与 claude/doubao 完全一致，故进 OFF_KINDS。
  // ⚠️ 同目录的 <uuid>.trajectory.jsonl 是另一份视图，扫描时按文件名显式排除（见 parsers/openclaw.mjs）。
  'openclaw',
  // generic-jsonl（R18）：声明式接入的 claude 同族逐行 jsonl，逐行 off 续读语义与 claude 完全一致。
  // 它的「**rules** 口径」版本不按 kind 走、按 **agent 走**（同一 kind 下每个 agent 的 rules 可以
  // 各不相同），版本号 rulesRev / 指纹 rulesHash 随 config 一起落盘，由主文件在 loadIndex 恢复时
  // 逐文件比对（见 agent-acta-server.mjs loadIndex restore）。
  // 但 kind 级编号仍然要有，两者管的是不同的东西：rulesRev 管「这个 agent 的 rules 变了」，
  // PARSER_REV['generic-jsonl'] 管「**所有** generic agent 共用的解析器代码变了」——
  // 比如 readCompleteLines 那个字节偏移 bug，它跟 rules 一个字都没关系，rulesHash 不会变，
  // 只靠逐文件比对就永远作废不了那份被污染的 index。
  'generic-jsonl']);

// 解析器修订号：某个 kind 的「落盘 turns 内容」口径变了就 +1（否则老 index 恢复出来的条目还是旧口径，
// 只有重扫才更新，表现为「改了代码重启还是老样子」）。只给需要保护的 kind 写；没写的表示不校验。
// 加了编号的 kind：老 index 的 state 会被丢弃并**整文件重扫**一次。
// ⚠️ **漏加这一笔的代价比看上去大**：老 index 会被原样恢复，而该文件 mtime/size 都没变、`off` 又已经
//    推到文件尾 —— 重扫只会走 scanXxxFile 开头那句短路，**永远补不回来**，病征是
//    「升级了、重启了，页面还是老样子」且不会自愈。改口径时顺手跑 `node test/parser-rev-test.mjs`：
//    它拿一份「没有 rev 的老 index」验证丢弃重扫确实生效，并用口径指纹盯着你有没有忘记 bump 这里。
// claude:1 —— 每轮多记 ctxUsed（上下文占用）。老 state 没有这个字段，且 off 已推到文件尾，
//             不重扫那些会话会永远显示「—」（只有新写入的轮次才有值）。
// kimi:1   —— 同上（ctxUsed），另含会话名/项目名的取法改成与目录摆法无关（见 scanKimiFile）。
// kimi:2   —— 轮时长不再被「下一轮的会话 chrome」污染（桌面版每轮前重放一段 config/tools 事件，
//             时间戳是下一轮的，见 KIMI_CHROME）；同时剥掉桌面版注入的 `<meta …/>` 前缀。
// codex:1  —— 用户输入多了 item_completed 这种落点（见 codexUserText）。漏了这一步的话新装的
//             服务会恢复出老 index 里 preview='' 的条目，而文件 mtime/size 都没变、
//             off 又已在文件尾 —— 重扫也补不回来，页面就一直显示「（空）」，正是这次要修的症状。
// R19+R20（claude:2 / buddyjsonl:3 / codex:2 / kimi:3，四家共享一次 bump）—— 落盘 turns 每轮多了
//             finished / aborted（轮已结束 / 被打断，前端据此收紧「进行中」判定，见页面 recomputeLive）
//             与 toolNames（工具名去重计数，卡片收起状态直接可见工具名）。老 state 没有这些字段，
//             且 off 已推到文件尾，不 bump 的话老会话永远显示旧口径。
// claude:5 —— qoder 卡片改显真实用量：落盘 turns 每轮多了 credits / ctxRatio / compacts /
//             compPre / compPost（qoder 的 token 恒为 0，积分与上下文占比才是真信号）。
//             老 index 的轮没有这些字段，不 bump 的话 qoder 卡片会全显 0。
// claude:6 —— 用户中断开卡标 aborted："[Request interrupted by user]" 不再混在真实请求里当 ok，
//             落盘 turns 每轮多了 aborted 字段，老 index 没有，bump 让 claude 系（claude/qoder/qoder-cn）重扫。
// claude:8 —— I14 会话命名（2026-09-23）：落盘 turns 每轮多了 name（取产品自写的 ai-title，
//             兜底 last-prompt），会话列表拿它替掉裸 UUID。data 多了 title / lastPrompt 两个字段。
//             ⚠️ 这一笔**必须** bump：ai-title 平均落在文件 48.8% 处，老会话的标题早已落在 `off`
//             跳过的那一段里，不重扫的话只有新会话有名字 —— 正是最容易被误判成「功能没生效」的形状。
// claude:9 —— I15 工作指纹（2026-09-23）：落盘 turns 每轮多了 branch / permMode / cliVer
//             （git 分支 / 权限模式 / 产品版本），data 多了 curBranch / curVer / curPerm 三个游标。
//             这三个字段在**每一行**都有（几乎整个转录都带 gitBranch / version），老 state 没有、
//             且 off 已推到文件尾 ⇒ 不 bump 的话老会话永远显示「无此维度」，重扫补不回来。
// claude:10 —— I17 非 LLM 时间分解（2026-09-24）：落盘 turns 每轮多了 rdur / rdurMsg
//             （产品自报的 turn_duration.durationMs / messageCount = 轮的真实工作时间）。
//             老会话的 turn_duration 早已落在 `off` 跳过的那一段里（事件在轮末、平均在文件靠后，
//             但增量读的窗口后移后同样扫不到）⇒ 必须 bump 让老 index 作废重扫，否则只有新会话
//             有这个字段。
// claude:11 —— I12 上下文压缩画像（2026-09-28）：落盘 turns 每轮多了 compDrop（累计丢弃 token，
//             只有 claude 源有）/ compMs（压缩等待时长）/ compAuto + compManual（trigger 计数），
//             且 compacts / compPre / compPost 从「仅 qoder」放开为三家通用（原 isQoder 守卫）。
//             compact_boundary 事件在文件中部/后段（本机实测平均落在会话中后段）⇒ 老会话的事件
//             大多已在 `off` 跳过的那一段里，不 bump 的话只有新会话有压缩画像，且永远补不回来。
// jsonl:2 —— I16 的两处 atomcode 时间面修复（D1/D2，2026-09-28 前置闸顺带查出、本次一并修）：
//             ① **D1 `time` 取起点**：原来取 jsonl 的 `ts`，而那是**轮结束**时刻
//                （ts − started_at ≈ duration_ms，本机 773 条样本平均偏差 15ms 证实）—— atomcode 是
//                唯一一家取终点的，卡片/会话页显示的时间戳整体偏一个轮长、按天分桶也跟着偏。
//                现在优先取 jsonl 的 `started_at`，拿不到才退 `ts − duration_ms`（data 新增 turnStart）。
//             ② **D2 不再沉默回落 updated_at**：轮在 jsonl 里找不到时原来退 `data.updated || data.created`，
//                让同一会话几十轮全塌成同一时刻（本机 2391/3492 轮 = 68.5%）——那是「不知道」被冒充成
//                「这时候发生的」。现在落 `timeUnknown: true` + time=0，页面如实标「时间未知」。
//             ⚠️ 必须 bump：`time` 是整个索引里排第一的字段，而 atomcode 的 jsonl/meta 的 m/s 都没变、
//             `off` 又已在文件尾 —— 不 bump 的话老索引原样恢复，页面照旧显示偏一个轮长的旧时间戳。
// claude:12 —— I12 口径修正（2026-09-28，同一次未发版功能内）：compDrop 从「cumulativeDroppedTokens
//             逐条相加」改为「相邻事件累计值的增量之和」。源里这一位是**会话累计**不是单次丢弃量，
//             逐条相加会把每轮显示成「到该轮为止的运行总量」，会话小结再求和约虚高 (k+1)/2 倍
//             （本机 5 次压缩的会话 777,858 被读成 2,332,127）。盘上 index 已按 11 写过错值 ⇒
//             必须再 bump 一次才能作废重扫（老值 m/s/off 对得上，不 bump 永远修不回来）。
// doubao:1 —— 首次接入（R26）。新 kind 一上来就给编号：以后动落盘 turns 口径（如补 model/usage 字段）
//             必须 +1，否则老 index 原样恢复 + off 在文件尾 = 重扫补不回来。
// minimax:2 —— 口径修正（2026-09-21 真库复核）：① usage.input **不含** cache（totalTokens =
//             input+output+cacheRead+cacheWrite 恒成立），tin 从「input - cacheRead」改为 input 直接取
//             （旧口径少算 80%+ 真实输入）；② ctx 分母从「恒 0」改为同目录 llm-call.json 的 maxTokens；
//             ③ toolResult.isError 进轮状态、custom 角色留痕 + lastTs。落盘 turns 内容全变，必须 bump。
// minimax:1 —— 首次接入。新 kind 一上来就给编号：同 doubao:1 的逻辑。messages.jsonl 逐行 off 续读，
//             首行用户消息已剥 system-reminder，轮内 assistant 行 usage 聚合（tin = input 直接取）。
// 2026-09-20 增量读字节偏移修复（除 copilot 外全部 kind +1，另补 jsonl / generic-jsonl 两个此前没编号的）——
//             增量读的 off 是**字节**偏移，旧写法却拿解码后字符串的 `lastIndexOf('\n')` 当字节用：
//             一个 CJK 字符 3 字节 1 字符，于是 newOff 每轮偏小一段，同一段行被反复解析，
//             data.turns 攒出幽灵轮次并**随 index 永久落盘**（doubao 实测 9 行用户消息解析成 12 轮，
//             页面表现为「详情用户输入为空 / 串到别轮」）。改成 shared 的 readCompleteLines 后，
//             盘上那份带幽灵的 index 必须整体作废重扫 —— 不 bump 就永远错下去，且不会自愈。
//             copilot 不在其列：它本来就是按字节算的（consumed = Buffer.byteLength），口径没变。
// buddyjsonl:5 —— 开轮按用户消息 id 去重：源会把同一条用户消息重写一次（jsonl 只追加 → 两行同 id，
//             第二行把同一段话包进 <user_query>），不去重就一张卡变两张（本机 149 份会话实测 7 对）。
//             另：data 多了 uids 字段（已见用户消息 id），落盘内容变了，同样必须 bump。
// openclaw:1 —— 首次接入。新 kind 一上来就给编号：以后动落盘 turns 口径（如补 name/compaction 字段）
//             必须 +1，否则老 index 原样恢复 + off 在文件尾 = 重扫补不回来（同 doubao:1 的逻辑）。
//    · 不在 OFF_KINDS 里的 kind（dsh/gemini/cursor/opencode/zcode/hermes/traedb/mimocode/kilo/cline）
//      也**可以**登记编号 —— 它在那儿不管 index 落盘（本就不落），管的是
//      `~/.agent-acta/search/` 那份全文索引分片：search.mjs 用 revOf(kind) 比对分片里的 rev，
//      对不上就整片丢弃重扫（见 search.mjs loadSearch）。口径变了不 bump，老分片会一直
//      按旧键（turn 下标）返回正文 —— 页面搜到的「这一轮」可能张冠李戴，且不会自愈。
// mimocode:1 —— 首次登记（2026-09-24）：口径从「一条 message = 一条 entry」改为
//             「一条 user message 开一轮 = 一条 entry」（轮内 assistant message 聚合，
//             rounds=轮内 LLM 调用数）。turn 下标语义整个变了，老搜索分片的键会对到错轮，
//             必须 bump 让它作废重扫。
// kilo:1 —— 首次接入（2026-09-24）：KiloCode（Kilo CLI）是 opencode 的 fork，复用
//             parsers/opencode.mjs 的核心（口径实测一致），落盘 turns 的形状与 opencode 相同。
//             本 kind 不进 OFF_KINDS（活源整库重解析），这条编号只管搜索分片作废；新 kind 一上来
//             就给编号，以后动口径（如轮内聚合方式）必须 +1，否则老分片会按旧键返回错轮正文。
// comate:1 —— 首次接入（2026-09-24）：百度 Comate，会话正文是 ~/.comate-engine/store/chat_session_<uuid>
//             整份 JSON 原地重写（非逐行追加），不进 OFF_KINDS（与 cursor/gemini 同路数：
//             整份重解析 + {mtime,size} 签名跳过）。这条编号管搜索分片作废；以后动落盘 turns
//             口径（如补逐次 token 字段）必须 +1，否则老分片会按旧键返回错轮正文。
// comate:2 —— 修一个正在显示的错数（2026-09-24）：轮耗时改为 **assistant.completedAt − 轮首 requestedAt**
//             （缺失时退到「元素末点 epoch」→「轮首 + Σ metrics.duration」→ 都没有则 0）。
//             原写法把 elements 的 lastModifiedTime（**epoch 毫秒**）当**时长**加到轮首上，
//             本机三条轮全部倒出 dur≈1.79e12ms（≈56 年，页面渲染成「29837037m50s」）。
//             落盘 turns 的 dur 值整个变了 ⇒ 必须 +1：搜索分片按旧 dur 建的那份不重扫就永远错着。
// cline:1 —— 首次接入（2026-09-24）：Cline CLI 3.x，会话正文是
//             <data>/sessions/<会话 id>/<会话 id>.messages.json（**整份 JSON、每次落盘整体重写**，不是 JSONL），
//             按 {mtime,size} 签名整份重解析 ⇒ 不进 OFF_KINDS（与 comate/cursor/gemini 同路数）。
//             这条编号管搜索分片作废；口径上有两处一上来就钉死、以后动必须 +1：
//             ① 开轮只认「role==user 且 content 里有非空 text 块」（tool_result 也是 role:user，
//                只看 role 会把 8 轮切成 23 轮）；② metrics.inputTokens **含**缓存（与 openclaw/minimax 相反），
//                故 tin = input − cacheRead − cacheWrite、ctxUsed = 末次 input。
// claude:14 —— I16 收口（2026-09-28）：子转录的 project **跟父走**（parsers/claude.mjs 的
//             claudeParentProject），不再照抄自己的 cwd —— claude 子 agent 的 cwd 常是父项目的
//             **子目录**，两边 projectKey 不同 ⇒ 服务端按 (agent, projectKey, key) 认父查不到，
//             这批子会话被如实降级成根（真机实测 27 份丢 10 份，也就是两条父会话的合计整块消失）。
//             ⚠️ 必须 bump：project 是**已落盘的每轮字段**，且这些子转录的 m/s 没变、`off` 又在文件尾 ——
//             不 bump 的话老索引会一路走 m/s 相等短路，把旧的（错项目的）条目继续回吐，永远不自愈。
// claude:13 —— I16 子 agent 拓扑（2026-09-28）：① 新增扫描 `~/.claude/projects/<slug>/<会话>/subagents/*.jsonl`
//             （以前这一层整个没读 ⇒ 子 agent 的轮次在面板上根本不存在），落盘 turns 每轮多了
//             parent（父会话 id）/ depth（spawnDepth）/ sub（派活描述，取自 <同名>.meta.json 的 description）
//             / subMode / subProvider（dsh 侧）；② dsh 同样是新增字段（parent / depth / sub / subMode / subProvider）。
//             ⚠️ 必须 bump：子转录的 `link` 与这些字段是**新增的落盘内容**，而主转录的 m/s 都没变、
//             `off` 又已推到文件尾 —— 不 bump 的话老索引里既没有 link 也没有 sub，页面永远显示不出
//             父子关系（且那些子转录根本不会出现在条目里，重扫走的是 m/s 相等短路，补不回来）。
// buddyext:1 —— 首次接入（2026-09-28）：CodeBuddy **扩展版**（VSCode / CodeBuddyIDE / JetBrains 共用的
//             genie 扩展，数据在 %LOCALAPPDATA%\CodeBuddyExtension\Data），与已有的 buddyjsonl
//             （CodeBuddy **CLI** 的 ~/.codebuddy/projects）是两个产品、两份落盘、两个 kind。
//             会话正文 = 每会话一份 index.json（**整份重写**）+ messages/<消息 id>.json 逐条正文
//             ⇒ 不进 OFF_KINDS（与 cline/comate/cursor/gemini 同路数），这条编号管搜索分片作废。
//             口径上有三处一上来就钉死、以后动必须 +1：
//             ① 轮 = requests[] 的一项（产品自己记的轮，**不靠 role=user 猜**）；扫描与详情共用
//                buddyExtTurns() 挑同一份数组，改筛选条件就是改「第 N 轮」的编号；
//             ② usage.inputTokens **含**缓存（与 cline 同、与 openclaw/minimax 相反，算术自证
//                cachedMiss+cacheRead+cacheWrite == inputTokens），故 tin = input − 两个 cache 桶、
//                ctxUsed = usage.lastTokens；
//             ③ 逐工具只有 status==='error' 算失败，cancelled 记中断、skipped 两头都不记。
//             另：轮时间用 startedAt + 消息内容时间戳，⚠️ 不可换成文件 mtime —— 整份重写会把一批
//             消息文件的 mtime 拍平到同一瞬间（本机实测 mtime 差 2ms 而内容差 84s）。
export const PARSER_REV = { jsonl: 2, buddyjsonl: 5, claude: 14, kimi: 4, codex: 3, copilot: 1, codearts: 2, tracecode: 4, tracework: 4, doubao: 8, minimax: 2, 'generic-jsonl': 1, openclaw: 1, mimocode: 1, kilo: 1, comate: 2, cline: 1, buddyext: 1 };

// index 落盘由主文件负责（IO 与调度都在那边）；解析器只报「哪个 kind 脏了」。
// 主文件启动时调 setSaveHook 把落盘登记函数注入进来 —— 避免反向 import 主文件。
let saveHook = null;
export function setSaveHook(fn) { saveHook = fn; }
export function markKind(kind) { if (OFF_KINDS.has(kind)) { kindDirty.add(kind); saveHook && saveHook(); } }

export function addEntry(id, e, src) {
  // models 在这里**统一兜一道**：每个解析器各自 push 时已经过 modelName，这里是最后一道闸。
  // 页面拿它 join 成卡片标题，非字符串混进去就是一串 [object Object]（详见 modelName 上方）。
  // 放在这儿的另一个理由：条目也会从 index 恢复，只有这个出口能保证「所有来源」都被规整过。
  entries.set(id, { id, ...e, models: modelList(e.models) });
  srcs.set(id, src);
  dirty.add(id);
  sorted.cache = null;
}

// R20：工具名去重计数（{"Bash":12,"Read":5}）。普通对象，index 落盘可直接 JSON 化；
// 给明细本来就留在 t.tools 数组里的 kind（dsh / zcode / gemini）用 —— emit 时现场聚合，
// 不在落盘 turns 里再存一份，index 体积零增量。逐行解析的 kind（claude / codex / kimi / buddy）
// 是在扫到 tool_use / function_call 那一行时顺手累计到轮状态里的（对象同样可 JSON 化）。
export function toolNameCounts(list) {
  const tn = {};
  for (const x of list || []) { const nm = (x && x.name) || '?'; tn[nm] = (tn[nm] || 0) + 1; }
  return tn;
}

// ---------------- 模型名规整 ----------------
// 模型名一律**强制落成字符串**再进 models[]。
//
// 为什么值得单独一个函数：models[] 最终是由页面的 `e.models.join(', ')` 渲染成卡片标题的，
// 而 join 对非字符串一律调 toString —— 一旦哪个 agent 的某个版本把 model 写成对象
// （`{"slug":…}` / `{"id":…}` / 带 $ref 的 schema 片段），卡片标题就会变成
// `[object Object], [object Object], …`：日志本身完全正常，症状却是一张「标题是乱码」的卡片，
// 很难往解析器上想。认不出来的对象**宁可丢掉**也不能塞进数组 —— 丢一个模型名最多少一行信息，
// 渲染出 [object Object] 则会让人以为整份日志坏了。
// 模型名显示映射：内部 key → 用户可见的 display_name（qoder-cn 等产品的内部模型名是短码，
// 日志里只有短码，用户看到的是 display_name。映射从 qodercli.log 的 model_config 字段动态提取）。
export const modelDisplayMap = new Map();

// 从 qodercli.log 提取模型名映射（key → display_name）。
// 日志行格式：model_config={"key":"q37fmodel","display_name":"Qwen3.7-Flash",...}
// 正则提取 key 和 display_name，写入 modelDisplayMap。
// **增量**：runs 目录每次 qoder 启动都多一个子目录，全量重读一遍是 MB 级的；
// 按「目录 → 上次读取时的文件大小」跳过没变过的（同一 run 中途换模型会往 qodercli.log 追加
// model_config 行，所以变大的要重读，而不是整目录跳过）。
// 这样扫描循环里每轮调一次也只付「有变化的文件」的成本 —— 服务启动后用户换的新模型名不用重启就能对上。
const modelMapLoadedFiles = new Map();
export function loadModelDisplayMap(logDir) {
  if (!logDir || !isDir(logDir)) return;
  const regex = /model_config=\{"key":"([^"]+)","display_name":"([^"]+)"/g;
  try {
    const entries = fs.readdirSync(logDir);
    for (const entry of entries) {
      const logPath = path.join(logDir, entry, 'qodercli.log');
      if (!isFile(logPath)) continue;
      let size = 0;
      try { size = fs.statSync(logPath).size; } catch { continue; }
      if (modelMapLoadedFiles.get(entry) === size) continue;
      const content = fs.readFileSync(logPath, 'utf8');
      let match;
      while ((match = regex.exec(content)) !== null) {
        const key = match[1];
        const displayName = match[2];
        if (key && displayName) modelDisplayMap.set(key, displayName);
      }
      modelMapLoadedFiles.set(entry, size);
    }
  } catch { /* 读取失败不影响启动 */ }
}

export function modelName(v) {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return modelDisplayMap.get(trimmed) || trimmed;
  }
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(modelName).filter(Boolean).join('/');
  if (typeof v === 'object') {
    for (const k of ['slug', 'id', 'model', 'model_id', 'modelId', 'name', 'display_name']) {
      const s = modelName(v[k]);
      if (s) return s;
    }
    return '';
  }
  return String(v);
}
// 把任意来源的「模型集合」规整成去重后的字符串数组
export function modelList(v) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  return [...new Set(arr.map(modelName).filter(Boolean))];
}

// ---------------- 上下文窗口容量表（claude 专用） ----------------
// 只有 claude 这一族**源头拿不到窗口容量**：atomcode 的 .meta 有 ctx_window、cursor 的
// composerData 有 contextTokenLimit，而 claude 的转录里根本没这个字段 —— 请求体（system prompt +
// tools schema）压根不落盘，实测整个 projects 目录搜 "tools" / system_prompt 只命中 turn_duration
// 事件。转录里的 message.model 又是**上游模型名**（经网关转发后是 deepseek-flash / kimi-k3 这种），
// 窗口是网关侧配置，本地无处可查。
//
// 所以这里只能按模型名查表，**查不到就返回 0**：页面退化成「只显示占用、不画进度条」。
// 不要为认不出的模型编一个分母 —— 那会让一个假百分比看起来像真的一样。
// 用户可以在 config（~/.agent-log/config.json）的 ctxWindows 里补自己的模型：{"kimi-k3": 262144}。
// 键可以是全名，也可以是前缀（取最长命中）。
export const CTX_WINDOWS_DEFAULT = {
  'claude-': 200000,          // Anthropic 家族默认 200K；`[1m]` beta 会话实际是 1M，转录里看不出来（会低估）
  'anthropic.claude': 200000, // 同一批模型走 Bedrock 式命名时的写法（本机实测转录里就是这种）
};
export const ctxWindows = new Map(Object.entries(CTX_WINDOWS_DEFAULT)); // 生效表 = 默认 + 用户覆盖
// 用户声明的部分（只它落盘）。主文件 saveConfig 读这里 —— 用对象引用而不是导出 let 变量，
// 避免「import 的是拷贝」的经典 ESM 陷阱（基本类型导出是单向的）。
export const ctxUser = {};
// 哪些 kind 的窗口容量**只能**由这张表决定（日志里根本没有这个字段）：
//   claude —— 窗口在网关侧配置，转录里不落盘；
//   kimi   —— wire.jsonl 的 usage.record 只有用量，没有窗口。
// 其余 agent 自带窗口字段，不该被这张表覆盖（也就不用进「待填」清单）。
export const CTX_WINDOW_KINDS = new Set(['claude', 'kimi']);
// 用户条目里 value <= 0 表示**停用**这一条（内置默认也能这样关掉，否则 `claude-` 那条一旦默认
// 不合适就永远删不掉）。停用项照常落盘，页面才画得出「已停用」那一行。
export function loadCtxWindows(user) {
  const u = (user && typeof user === 'object') ? user : {};
  for (const k of Object.keys(ctxUser)) delete ctxUser[k];
  const off = new Set();
  for (const [k, v] of Object.entries(u)) {
    if (!k || !k.trim()) continue;
    const n = Number(v);
    ctxUser[k] = n > 0 ? n : 0;
    if (!(n > 0)) off.add(k);
  }
  ctxWindows.clear();
  for (const [k, v] of Object.entries(CTX_WINDOWS_DEFAULT)) if (!off.has(k)) ctxWindows.set(k, v);
  for (const [k, v] of Object.entries(ctxUser)) if (v > 0) ctxWindows.set(k, v);
}
// t.models 里存的是规整后的**短名**（modelName 过一道），这里直接前缀/全名匹配取最长命中
export function windowOf(models) {
  if (!models || !models.length) return 0;
  let best = 0;
  for (const m of models) {
    for (const [k, v] of ctxWindows) if (m.startsWith(k) && v > best) best = v;
  }
  return best;
}

// ---------------- 文本规整（所有解析器共用的出参/入参转文字） ----------------
// 把任意形状（字符串 / 内容块数组 / {content:[…]} / {output:[…]}）落成可读文本。
// 有个很难看的失败模式托底：GBK 乱码进不了这里 —— 那是产品自己写进日志的（见需求书 §6.1），
// 这里照原样透传；要防的是对象直接 String() 出来的 [object Object]。
// 用户看到的是一段本该是工具输出的乱码，而日志本身完全正常。
// 认内容块（{text} / {content}）优先，认不出来才 JSON.stringify：宁可给出多几行的原始 JSON，
// 也不要给一串看不出所以然的 [object Object]。
export function toText(s) {
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) return s.map(toText).filter(Boolean).join('\n');
  if (typeof s === 'object') {
    if (typeof s.text === 'string') return s.text;
    if (typeof s.content === 'string') return s.content;
    if (Array.isArray(s.content)) return toText(s.content);
    if (Array.isArray(s.output)) return toText(s.output);   // {…, output:[块]} 这种包一层的
    try { return JSON.stringify(s, null, 2); } catch { return '[无法序列化的值]'; }
  }
  return String(s);
}
// 逐次调用上挂的**工具名**（calls[i].tools）。只存名字、不设上限：同一次响应里并行调几个就几条，
// 一次二十个也是二十个短字符串 —— 对比同一份 payload 里已经躺着的那一堆工具入参/返回（各自截到
// 800 字），这点体量可以忽略。**所以别为它加 cap**：截断了就没法说清「这次到底调了几个」，
// 而「这次干了什么」正是这一列存在的理由。（出入参不在这里复制第二份，仍只有 tools[] 一份。）
export function trunc(s, full, flag) {
  s = toText(s);
  if (full || s.length <= 800) return s;
  flag.t = true;
  return s.slice(0, 800);
}

// ---------------- 增量读「从 off 起的完整行」（所有按 off 续读的解析器共用） ----------------
// off 是**字节**偏移，找行尾就必须用字节下标：一个汉字占 3 字节但只有 1 个字符，
// 先 buf.toString('utf8') 再拿字符串 lastIndexOf('\n') 的结果当字节用，off 会每轮倒退一段，
// 同一段行被反复解析 —— doubao 实测 9 行用户消息攒出 12 个 turn（页面因此出现幽灵卡片 + 详情串轮）。
// 返回 null = 这一段里还没有完整行（半截尾巴），调用方保持 off 不变、下一轮再读。
export function readCompleteLines(fp, off, size) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, size - off, off);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return null;
    return { lines: buf.subarray(0, end).toString('utf8').split('\n'), newOff: off + end + 1 };
  } finally { fs.closeSync(fd); }
}

// ---------------- 目录列表缓存（dir mtime 不变则复用 names，省去每 3s 全量 readdir） ----------------
// 注意：dir mtime 只在文件增删/改名时变；文件内容增长靠逐文件 stat 捕捉，不受影响
const dirCache = new Map(); // path -> {m, names}
export function listDirCached(dir) {
  let st; try { st = fs.statSync(dir); } catch { dirCache.delete(dir); return null; }
  if (!st.isDirectory()) return null;
  const c = dirCache.get(dir);
  if (c && c.m === st.mtimeMs) return c.names;
  let names; try { names = fs.readdirSync(dir); } catch { return null; }
  dirCache.set(dir, { m: st.mtimeMs, names });
  return names;
}
