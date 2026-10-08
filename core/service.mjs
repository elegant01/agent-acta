// agent-acta 的服务侧（2026-09-29 从 agent-acta-server.mjs 拆出，**纯搬家零逻辑改动**，见 claude-step.md §4）。
//
// 为什么要拆：I11 要把服务做成 DSH 插件，插件壳 import 的应该是服务侧，而不是 CLI 入口 —— 老入口里的
// argv 解析、hook 安装、--stop/--status/--doctor 那一整套跟插件毫无关系，混在一个文件里就只能靠 LIB
// 布尔硬挡，而挡不住 hosted 模式要的第三种组合（见 claude-step.md §0.5 更正 1 与 §5）。
//
// 搬过来时**必须显式处理**的三处（claude-step.md §2，都是 import.meta.url 派生值：搬错不报错，只改语义）：
//   ① ROOT  —— 本文件在 core/ 下，包根要显式取上一级，否则 PAGE_FILE / VENDOR_DIR 全指错、页面与 vendor 全 404
//   ② LIB   —— 判据从「是不是本文件」改成「是不是包根下的入口 agent-acta-server.mjs」；不改的话跑 CLI 时
//               argv[1] ≠ 本文件 ⇒ LIB 恒为真 ⇒ 服务静默变成只读、一个字都不落盘
//   ③ BUILD —— 口径改为哈希整个服务面（入口 + core/*.mjs）；只哈希本文件的话，改入口时指纹不变，
//               「端口上是另一版」那句提示就在半数改动上瞎掉
// 另外两处本文件不能自己解决的，都在下方就近注释里：ENSURE_FLAG（CLI flag 泄漏，§5 点名，Step 2 清）
// 与 setClientSpawner（/api/client 要唤起悬浮卡片，而那段必须留在入口）。
//
// **Step 2（2026-09-29）**：布尔 LIB 已扩成三态 MODE，副作用全部收进 start() / stop()：
//   · 'cli'    —— 今天默认分支那一整套（listen / 写 pid / 空闲自停 / 真 process.exit）
//   · 'lib'    —— MCP 的只读库模式，**行为与 Step 1 逐字一致**（不扫描落盘、不 listen、不挂定时器）
//   · 'hosted' —— 宿主内插件：写路径全开（扫描 / 落索引 / SSE / 归档轮 / 搜索轮），但
//                listen:false、不写 pid、不挂 checkIdle、stop() 只停循环不退进程
// 三态在模块加载时按「argv[1] 是不是入口」定成 cli/lib（与原来一模一样），hosted 由宿主调
// start({ mode:'hosted' }) 切过去。状态保持模块级单例，不做闭包化（§5 第 3 条已定理由）。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------- 诊断出口（见 core/log.mjs 开头：为什么不是改全局 console） ----------------
import { log, routeLogsToStderr } from './log.mjs';

// ---------------- 归档（历史条目冻结，见 archive.mjs 开头的三条硬设计） ----------------
import { initArchive, archiveRun, archiveIndex, archiveEntries, archiveEntry, pruneArchive, archiveRoot, fmtBytes } from '../archive.mjs';

// ---------------- 全文搜索索引（R33 / 候选池 I10，见 search.mjs 开头的四条硬设计） ----------------
import { initSearch, loadSearch, searchRun, searchEntries, searchStatus, searchRoot, foreignPath, toolFailsOf, searchBuilding } from '../search.mjs';

// ---------------- 解析器（parsers/，2026-09-17 从本文件拆出，纯搬家零逻辑改动） ----------------
import { files, entries, srcs, pidCwd, dirty, removedIds, agentNotices, kindDirty, sorted,
         OFF_KINDS, PARSER_REV, CTX_WINDOW_KINDS, CTX_WINDOWS_DEFAULT, ctxUser, ctxWindows,
         loadCtxWindows, setSaveHook, markKind, modelName, modelList, windowOf, toText, trunc,
         listDirCached, sqliteMod, isDir, isFile, loadModelDisplayMap } from '../parsers/shared.mjs';
import { scanAtomcodeDir, atomcodeDirs, atomcodeEntryContent } from '../parsers/atomcode.mjs';
import { scanTraces, resolveCwd, setAgentConfs } from '../parsers/trace.mjs';
import { scanClaude, claudeEntryContent } from '../parsers/claude.mjs';
import { scanDoubao, doubaoEntryContent } from '../parsers/doubao.mjs';
import { scanBuddy, buddyEntryContent } from '../parsers/buddy.mjs';
import { scanCodex, codexEntryContent } from '../parsers/codex.mjs';
import { scanKimi, kimiEntryContent } from '../parsers/kimi.mjs';
import { scanComate, comateEntryContent } from '../parsers/comate.mjs';
import { scanDsh, DSH_ZSTD_OK } from '../parsers/dsh.mjs';
import { scanCodearts } from '../parsers/codearts.mjs';
import { scanGemini } from '../parsers/gemini.mjs';
import { scanCursor, cursorTranscriptFiles, CURSOR_NO_USAGE_NOTE, CURSOR_MODEL_NOTE, CURSOR_HOOK_NOTE } from '../parsers/cursor.mjs';
import { scanZcode, zcodeScanErr } from '../parsers/zcode.mjs';
import { scanOpencode, opencodeScanErr, opencodeEntryContent } from '../parsers/opencode.mjs';
import { scanHermes, hermesScanErr, hermesEntryContent } from '../parsers/hermes.mjs';
import { scanDevinDb, devinDbErr, devinDbEntryContent } from '../parsers/devindb.mjs';
import { scanMavis, mavisEntryContent } from '../parsers/minimax.mjs';
import { scanOpenclaw, openclawEntryContent, openclawUserText } from '../parsers/openclaw.mjs';
import { scanCline, clineScanErr, clineEntryContent } from '../parsers/cline.mjs';
// buddyext（CodeBuddy 扩展版：VSCode / CodeBuddyIDE / JetBrains 共用的 genie 扩展，
// %LOCALAPPDATA%\CodeBuddyExtension\Data）—— 与 parsers/buddy.mjs 那个 CodeBuddy **CLI**（~/.codebuddy）
// 是两个产品、两份落盘，故独立成 kind=buddyext、独立成侧栏 agent=codebuddy-ext。
import { scanBuddyExt, buddyExtScanErr, buddyExtEntryContent } from '../parsers/buddyext.mjs';
// ↑ kind=buddyext 的会话**并到 codebuddy 这一个 agent 名下**（同产品的第二份落盘，不是第二个产品），
//   所以侧栏没有 codebuddy-ext 这一行；根从 buddyExtDataRoots() 每轮重算，挂在 codebuddy.sessionsExtra 上。
import { scanTraecode, scanTraework, traeEntryContent } from '../parsers/tracecode.mjs';
import { scanTraeDb, traeDbErr, traeDbEntryContent } from '../parsers/traedb.mjs';
import { scanCopilot, copilotScanErr, copilotTurnStart } from '../parsers/copilot.mjs';
import { scanGeneric, genericEntryContent, validateGenericRules, genericRulesHash, genericTurnStart } from '../parsers/generic.mjs';
import { scanMimocode, mimocodeEntryContent } from '../parsers/mimocode.mjs';
import { scanKilo, kiloScanErr, kiloEntryContent } from '../parsers/kilo.mjs';
// I8：单轮「复现包」的原始日志片段提取（复用各解析器的开轮判定，保证与扫描口径一致，不另写一份）。
// 只针对「单文件逐行 jsonl」的 kind 做提取；其余 kind（数据库 / 内存 / 多文件）诚实标不可提取。
import { readCompleteLines } from '../parsers/shared.mjs';
import { claudeUserText, claudeIsToolResultOnly, claudeIsCommandText } from '../parsers/claude.mjs';
import { buddyUserText } from '../parsers/buddy.mjs';
import { mavisUserText } from '../parsers/minimax.mjs';
import { sniffBase, candidateBases, probeBases, kimiDesktopSessionsRoots, kimiWires, kimiWireIn, isKimiWire,
         buddyExtDataRoots, buddyExtMissingWhy,
         dshSessionFile, hasDshSessions, zcodeDbVerify, zcodeDbFile,
         opencodeDbFile, opencodeDbVerify,
         traeDbFile, traeLogKindOf, traeLogsFromDb,
         hasCodeartsLogs, hasTraceFiles, hasCodexRollouts, hasClaudeJsonl, hasBuddyJsonl,
         hasGeminiSessions, hasCursorTranscripts, hasKimiSessions, hasTraeRendererLogs } from '../parsers/discovery.mjs';


// ---------------- 载体模式 MODE：cli / lib / hosted ----------------
// 'lib'（R31：给同目录的 mcp-server.mjs import 用）：本文件被 **import** 而不是作为入口脚本跑时，
// 它只是一份「日志内存 + 查询函数」的库：绝不能有服务侧副作用 —— 常驻服务正在同一个 DATA_DIR 上写
// `index/` 与 `config.json`，第二个进程跟着写就是互相覆盖丢条目（谁后落盘谁赢，前一份白扫）。
// 判据用「是不是入口脚本」而不是加一个环境变量开关：常驻那条路（直接跑 / npm bin）argv[1] 就是入口文件，
// 天然不受影响；而漏设标志的失败方向是「静默双写」，正是要防的那类事故，不能留给人记住。
//
// 'hosted'（I11 Step 2）：宿主内插件要的既不是「只读」也不是「独占端口」，而是第三种组合 ——
// 写路径全开、但不 listen / 不写 pid / 不空闲自停 / 不退出宿主进程。布尔 LIB 装不下它（claude-step §0.5
// 更正 1），所以在这里定成三态。**加载时的判据一个字没改**，只是结果从 true/false 变成 'lib'/'cli'；
// 'hosted' 只能由 start({ mode:'hosted' }) 切过去 —— 那意味着「import 本文件」依旧是零副作用的，
// 宿主必须显式开口。MODE 是 let 而不是 const，正是为了这一处切换。
//
// 包根：页面 / vendor / widget / package.json 都相对它定位。**必须显式取上一级** —— 2026-09-29 本文件
// 搬进 core/ 之后，path.dirname(import.meta.url) 得到的是 core/，于是 PAGE_FILE / PAGE_DIR /
// VENDOR_DIR / WIDGET_FILE 全指错、页面与 vendor 全 404（claude-step.md §2 第 1 行）。
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sameModule = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// 入口是**包根下**的 agent-acta-server.mjs。判据不能再拿 import.meta.url 去比：那比的是 core/service.mjs，
// 于是正常跑 CLI 时 argv[1] ≠ 它 ⇒ 判成 'lib' ⇒ 服务静默变成只读、一个字都不落盘。
const CLI_ENTRY = path.resolve(path.join(ROOT, 'agent-acta-server.mjs'));
// 判据**必须过 realpath**。npm 在 mac / linux 上把 bin 装成**符号链接**（`/opt/homebrew/bin/agentacta` → 包内那个 .mjs），
// 而 node 交给 `process.argv[1]` 的是「被敲进去的那个路径」、不解析软链 ⇒ 直接字符串相等会把 CLI 判成 'lib'，
// 症状极难查：**任何参数都零输出、退出码 0**（`runCli()` 压根没被调用），Windows 却一切正常 ——
// 因为 npm 在 Windows 生成的是 `.cmd` / `.ps1` shim，传给 node 的是真路径。09-30 同事在 mac 上装完就是这样。
// `real` 做成可注入：这台机（Windows，未开开发者模式）建不了软链，单测靠假 realpath 才能钉住这条语义。
export function detectMode(argv1, entryPath, real = p => { try { return fs.realpathSync(p); } catch { return p; } }) {
  return sameModule(real(path.resolve(argv1 || '')), real(entryPath)) ? 'cli' : 'lib';
}
let MODE = detectMode(process.argv[1], CLI_ENTRY);
// 诊断行的去向在这里定一次，之后全库一律走 log()（core/log.mjs）：
//   cli  → stdout —— 终端体验与搬家前一致（--status / --doctor 的球与文字走原来的流）
//   其余 → stderr —— lib 的 stdout 是 importer 的**协议通道**（MCP over stdio），混进一行
//          「[index] loaded 1234 states」就是一条解析不了的坏消息；hosted 的 stdout 归宿主，
//          插件往里写诊断行同样是污染。两种情况的日志在 stderr 里一行不少。
// 在 import 时判一次就够：MODE 之后只可能从 'lib' 变成 'hosted'，而这两者对去向的要求相同。
//
// 2026-09-29：这里原先是 `console.log = (...a) => console.error(...a)` —— 改的是**整个进程**的
// console。MCP 里没事（独立进程），但 DSH 插件加载后**宿主自己的** console.log 也被我们改道到
// stderr，宿主的日志采集器因此少掉全部 info 行。越界的副作用，换成模块内的 log()；原始那个函数
// 留给宿主，一个字节都不碰。
routeLogsToStderr(MODE !== 'cli');

const HOME = os.homedir();
const QODER_RUNS_DIR = path.join(HOME, '.qoder-cn', 'logs', 'runs'); // qodercli.log 所在，模型名映射来源
const PORT = Number(process.env.AGENT_LOG_PORT || 14570);
// ROOT 在上面 LIB 那一段就定好了（判据要用到它），别在这里重定义 —— 重定义 = 「两处各算一遍」。
// 用户数据目录：~/.agent-acta —— 跟 ~/.claude / ~/.codex / ~/.kimi-code 同一层规则，
// 与代码位置无关（换机器、重装、升级都不冲配置），也**不依赖任何别的产品的安装目录**。
// 2026-09-18 之前它固定在 ~/.atomcode/agent-log/：那时它还只是个「看 atomcode 每轮 token」的小工具，
// 名字顺着宿主的窝叫；现在它聚合十几个 agent，「放在 atomcode 目录里」既误导、又会被 atomcode 的
// 卸载程序连锅端走（配置里那些手工 agent 与 traeKey 是用户唯一带不走的东西）。老数据由 migrateDataDir 自动搬。
const DATA_DIR = path.join(HOME, '.agent-acta');
// 旧位置（按「越新越靠前」排）：只读来搬迁与兼容，**绝不再往里写**。
// 每搬一次家就往这里加一条 —— 跨代升级（比如从没装过 1.9.0、数据还躺在 ~/.atomcode/agent-log 的机器）
// 靠它一步到位，不必先经过中间那一代。
const LEGACY_DATA_DIRS = [
  path.join(HOME, '.agent-log'),             // 1.9.0 ~ 1.x：命令还叫 agentlog 的那个时代
  path.join(HOME, '.atomcode', 'agent-log'), // 1.9.0 之前：顺着 atomcode 的窝叫
];
const LEGACY_CONFIG_NAME = 'agent-log-config.json';                // 旧配置文件名（新名是 config.json）
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const INDEX_DIR = path.join(DATA_DIR, 'index');
// 「某个目录里有没有**真**配置」。判据盯的是配置文件本身、不是目录在不在 —— 空的新目录到处都是
// （用户手工建的、上次搬到一半留下的），把它们当成「已经搬好了」，loadConfig 就会装载默认预置，
// 首次 saveConfig 把用户的 agent 列表 / traeKey / ctxWindows 顶掉（唯一不可逆的损失）。
// 2026-09-29 随搬家从「数据目录搬迁」那一段挪进来：服务侧的 saveConfig(:519) 与 loadConfig(:697)
// 都要用它，而 core 不能反向 import 入口 —— 所以它属于服务侧，搬迁那边只是共用同一个判据。
function hasRealConfig(dir) {
  return isFile(path.join(dir, 'config.json')) || isFile(path.join(dir, LEGACY_CONFIG_NAME));
}
// 第一个「有真配置」的旧位置。多条 legacy 时以新者为准 —— 那份配置一定是搬迁后又被改过的，
// 比老的更接近用户意图；老的那条原样留着，不动它（红线②：搬迁永不删旧东西）。
function legacyWithConfig() {
  for (const d of LEGACY_DATA_DIRS) if (hasRealConfig(d)) return d;
  return null;
}
// --stop 的兜底线索；判活仍以端口为准。按端口分文件：换 AGENT_LOG_PORT 起第二个实例时不会互相覆盖
const PID_FILE = path.join(DATA_DIR, 'server-' + PORT + '.pid');
const PAGE_FILE = path.join(ROOT, 'agent-acta-page.html');
// R25 批 0：主页面拆出的静态文件（shared.js / style.css / 后续各组件）。路由见 '/page/' 分支，
// 指纹见 pageBuild()，启动自检见 server.listen 回调。
const PAGE_DIR = path.join(ROOT, 'page');
// 桌面小卡片页（/widget）：与主页同一进程伺候、同一套指纹注入，但**不引共享片段**——
// 卡片不做项目筛选，用不上 projKey；依赖越少，这张小页挂掉的面越小。
const WIDGET_FILE = path.join(ROOT, 'agent-acta-widget.html');
const VENDOR_DIR = path.join(ROOT, 'vendor');

// 本进程跑的到底是哪一版代码 —— 用命令来辨认（版本号 + 服务脚本内容指纹）。
//
// 为什么非要有这个东西：`npm i -g <新版 tgz>` 换掉的是**磁盘上的文件**，换不掉**已经在跑的进程**。
// 而服务是从磁盘现读 agent-acta-page.html 的，于是升级后会出现最难查的一种状态：
// **页面是新的、接口是旧的** —— 页面点「用量统计」请求 /api/daily，旧服务不认识这条路由，
// 落到兜底 404 返回纯文本 'not found'，页面再 r.json() 就报「Unexpected token 'o'」；
// 同一台机器上 .cursor 也扫不到、手动加也加不上（旧服务的 sniffBase 里根本没有 cursor 分支）。
// 现象看着是三件不相干的事，根子是同一个：旧进程占着端口。
//
// 指纹取脚本内容而不是 package.json 的版本号：版本号要人记得改，改了也可能只动页面不动服务端；
// 内容指纹不需要任何人维护，改了哪个字节数都对不上。12 位 SHA1 前缀的碰撞概率在这里可以忽略。
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }   // 源码目录/被裁剪的安装：拿不到版本号不影响指纹判等
})();
// 服务面指纹（claude-step.md §2 第 3 行）：哈希的是**整个服务面**，不是本文件一个 —— 口径与 pageBuild()
// 同一套（按文件名排序、名字也进哈希，改名同样算变）。
//   为什么必须在本步改：本文件搬进 core/ 之后「只哈希自己」就等于「只哈希 core/service.mjs」，
//   改 CLI 入口（agent-acta-server.mjs）时指纹**不变** —— 于是「端口上是另一版」那句提示在半数改动上
//   瞎掉，而那正是它存在的唯一理由。agent-acta-server.mjs + core/*.mjs 合起来才是「服务是哪一版」。
// 范围**不含** archive.mjs / search.mjs / mcp-server.mjs：搬家前也只哈希入口文件一个，本步只补回
// 「因搬家而变窄」的那部分，不顺手扩面（扩面会让每次改搜索/归档都触发一次换班提示）。
const BUILD = (() => {
  try {
    const coreDir = path.join(ROOT, 'core');
    const names = ['agent-acta-server.mjs',
      ...(fs.existsSync(coreDir) ? fs.readdirSync(coreDir).filter(n => /\.mjs$/.test(n)).sort().map(n => 'core/' + n) : [])];
    const parts = names.map(n => n + '\x00' + fs.readFileSync(path.join(ROOT, n), 'utf8'));
    return crypto.createHash('sha1').update(parts.join('\x00')).digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
})();
// 页面文件指纹（R25 批 0）= 主页面 html + page/ 下所有 .js/.css（按文件名排序，名字也进哈希 —— 改名同样算变）。
// 与 BUILD 的分工：BUILD 只哈希服务端脚本，页面拆出 /page/ 之后「只改页面文件」不会让它变；
// 页面侧比对 /api/version 里的这一枚，抓的是「浏览器里跑着旧页面、磁盘上已是新页面文件」。
// 每次请求现算（几笔小文件，开销可忽略）：想让「编辑页面文件后 reload」立刻见效、且不改服务就不必重启。
function pageBuild() {
  try {
    const parts = [fs.readFileSync(PAGE_FILE, 'utf8')];
    for (const f of fs.readdirSync(PAGE_DIR).filter(n => /\.(js|css)$/.test(n)).sort())
      parts.push(f + '\x00' + fs.readFileSync(path.join(PAGE_DIR, f), 'utf8'));
    return crypto.createHash('sha1').update(parts.join('\x00')).digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
}
const SNAPSHOT_LIMIT = 2000;
const DEFAULT_SCAN_MS = 3000;     // 前端可在 UI 上调；0 = 暂停定时扫描（手动刷新仍可用）
const SCAN_CHOICES = [0, 1000, 2000, 3000, 5000, 10000];
let scanMs = DEFAULT_SCAN_MS;      // 当前扫描节奏（config 持久化）
// 空闲自停：页面全关 + 没有任何新日志持续这么久，服务自己退出（0 = 永不，默认关）。
// 挂着 `--ensure` hook 的情况下退出无副作用——下次开会话又会把它拉起来。
const IDLE_CHOICES = [0, 1800000, 7200000, 21600000]; // 关 / 30min / 2h / 6h
// AGENT_LOG_IDLE_MS：临时覆盖（不落盘、不受白名单限制），调试用——不然验一次要等半小时
const IDLE_ENV = Number(process.env.AGENT_LOG_IDLE_MS || 0) > 0 ? Number(process.env.AGENT_LOG_IDLE_MS) : 0;
let idleExitMs = 0;

// ---------------- 异常巡检（R9） ----------------
// 可配置规则，命中后由页面提醒并可一键筛出命中条目。规则与阈值按 scanMs / idleExitMs 同一套
// 「顶层设置 + config 持久化」机制落盘（见 loadConfig / saveConfig）。
//   tokens: 单轮 token（total = tin+tout+tcache）超过 val 即命中；
//   durMs:  单轮耗时超过 val（毫秒）即命中；
//   fail:   按 agent 统计最近 window 轮里失败（status != 'ok'）占比超过 val%（0-100）。
// 默认全关：用户没配过就是「绝不打扰」，不凭空报一堆异常。
// 命中集合 alertHits = Map(id -> {agent, rules:[key...], value})，随广播重算并推给前端。
// alertHits 只记「当前在内存里的命中条目」；条目被 LRU 淘汰或删除后由重算自然清除。
const ALERT_DEFAULT = { tokens: { on: false, val: 0 }, durMs: { on: false, val: 0 }, fail: { on: false, val: 0, window: 50 } };
let alertRules = JSON.parse(JSON.stringify(ALERT_DEFAULT));
const alertHits = new Map();          // id -> {agent, rules:[...]，value}
let alertDirty = true;                // 有新日志/改规则后置脏，下次广播前重算

const MAX_ENTRIES = 20000;        // 内存条目上限（LRU 淘汰最旧）
const EVICT_BATCH = 2000;         // 触发淘汰时一次降到上限 - EVICT_BATCH
const KEEP_MIN_PER_AGENT = 200;   // 淘汰时每个 agent 至少保留的最近条数

// 归档（见 archive.mjs）：这里只放「服务内自动跑」的两条策略 —— 开关与保留上限，都是用户意图、
// 随 config 落盘。默认永久保留：归档本身就是对抗产品删日志，自动清理等于自己又制造一次空档。
// skip 是**按 agent** 的开关（名字数组）：有些 agent 的日志本来就不值得留，冻了纯占地方。
// 语义只说一半会被误解，这里写死：**只停未来的归档，绝不删已冻好的文件** ——
// 想清已有归档用 maxDays / maxMB（也是删整天文件），或自己去归档目录删。
const ARCHIVE_DEFAULT = { enabled: true, maxDays: 0, maxMB: 0, skip: [] };
let archiveCfg = { ...ARCHIVE_DEFAULT, skip: [] };

// 默认 agent（原"内置"）：全部走 config，可禁用、可覆盖路径；builtin:true 不可删除只能禁用
//   kind=atomcode:   sessions/<hash>/*.meta + *.jsonl
//   kind=trace:      sessions/<pid>.json + traces/<pid>/trace_*.json
//   kind=buddyjsonl: projects/<项目slug>/<sessionId>.jsonl（codebuddy / workbuddy 的会话正文）
//   kind=gemini:     tmp/<项目slug>/{chats/session-*.json 会话正文, logs.json 提示词流水}
//   kind=cursor:     projects/<项目slug>/agent-transcripts/<会话uuid>/<同名>.jsonl（纯对话，无 token/时间戳）
// 注：codebuddy / workbuddy 以前用 kind=trace，读到的只是会话注册表 + 每条 trace 的空壳记录
//     （tin/tout/preview 全空），真正的逐轮 token 与内容在 projects/ 下的 jsonl 里，故改用它。
const DEFAULT_AGENTS = {
  atomcode:  { kind: 'atomcode', sessions: path.join(HOME, '.atomcode', 'sessions') },
  // codebuddy 一家有**两份互不相干、格式也不同**的落盘，侧栏合成一行（见 discoverAgents 里的并源注释）：
  //   sessions      = CLI @tencent-ai/codebuddy-code 的 ~/.codebuddy/projects/**/*.jsonl（kind buddyjsonl）
  //   sessionsExtra = genie 扩展的 %LOCALAPPDATA%\CodeBuddyExtension\Data（kind buddyext，每轮重算）
  codebuddy: { kind: 'buddyjsonl', sessions: path.join(HOME, '.codebuddy', 'projects') },
  workbuddy: { kind: 'buddyjsonl', sessions: path.join(HOME, '.workbuddy', 'projects') },
};
// 启动/扫描时自动发现名单（命中 candidateBases+sniffBase 即注册 source:auto），保留扩展位
// traework 与 trae 都在名单里：装在同一台机器上的两个产品（Trae CN / Trae Work / Trae SOLO）
// 各自走 NAME_ALIASES 中的不同别名，被 sniffBase 区分成 tracecode 与 tracework 两个 kind。
// kilo 与 opencode 也是各自独立的一行：装了 KiloCode 的机器上两家库会同时在（名字不同、kind 不同）。
const KNOWN_AGENTS = ['claude', 'codex', 'cursor', 'trae', 'traework', 'qoder', 'opencode', 'gemini', 'copilot', 'windsurf', 'codearts', 'kimi', 'dsh', 'zcode', 'doubao', 'hermes', 'devin', 'minimax', 'mimocode', 'kilo', 'openclaw', 'comate', 'cline'];

const agentConfs = new Map(); // name -> {kind, sessions, sessionsExtra?, traces, builtin, enabled, source, missing}

// ---------------- 自检结果（/api/selftest，R32 / I5）----------------
// 只把 test/selftest.mjs 写下的那份结果**读出来**，服务端不 spawn 任何测试子进程：
// 一轮默认清单要串行起停二十来个服务、跑几分钟，这种副作用不能挂在一个 HTTP 处理器上
// （刷新一下页面就重跑一遍 = 谁都不敢刷新）。跑的动作留在终端里。
// 版本章是这里唯一真正新增的判断：结果文件里盖着跑它那时的 build，与当前 build 不同就说明
// 「这份绿不代表现在这版代码」——不提示的话，一页绿字比没有自检更危险。
// 落点在数据目录而不是仓库的 test/：`npm pack` 的 files 不含 test/，常驻服务跑的是全局安装那一份
// （见 README 的 --where），它仓库里根本没有 test/ 目录 —— 路径跟着代码走的话，页面永远只会报
// 「还没跑过自检」。跟着 HOME 走才对：源码树里的 runner 和全局包的服务读的是同一个文件。
function selftestReport() {
  const fp = path.join(DATA_DIR, 'selftest.json');
  const now = { version: VERSION, build: BUILD, pageBuild: pageBuild(), parserRev: PARSER_REV };
  let j = null;
  try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
    return { ok: false, file: fp, server: now, error: e.code === 'ENOENT' ? '还没跑过自检' : '结果文件读不动：' + e.message, hint: 'node test/selftest.mjs' };
  }
  // 时刻读不出就退到文件修改时间：年龄这一栏宁可偏一点，也不能给出「一万年」或者 NaN。
  let atMs = Date.parse(j.at);
  if (!Number.isFinite(atMs)) { try { atMs = fs.statSync(fp).mtimeMs; } catch (e) { atMs = 0; } }
  const ageMs = Math.max(0, Date.now() - atMs);
  // 口径比对只看「有哪些 kind、各是什么值」，不看键的顺序：JSON.stringify 那种写法会把「对象换了键序」
  // 判成「解析器变了」，而这一栏的作用是决定页面要不要警告，误报一次就少信一分。
  const sameRev = (a, b) => {
    const ka = Object.keys(a || {}), kb = Object.keys(b || {});
    return ka.length === kb.length && ka.every(k => a[k] === b[k]);
  };
  return {
    ok: true, file: fp, server: now, ageMs,
    sameBuild: !!(j.self && j.self.build === BUILD),
    sameParserRev: !!(j.self && sameRev(j.self.parserRev, PARSER_REV)),
    ...j,
  };
}

// 一个 agent 的**全部**日志根。配置模型原本只有 `sessions` 一个根，但 kimi 是反例：
// kimi-code CLI 的 `~/.kimi-code` 与 Kimi 桌面版内嵌的 `runtime/kimi-code/home` 是两个
// 完全独立的目录（本机一个在 C 盘、一个在 E 盘），只认一个就等于**静默丢一半数据**。
// 所以加 `sessionsExtra` 承载「额外的、同格式的根」：**只增不改** —— sessions 仍是主根，
// 其余 8 个 agent 不写这个字段，行为与从前逐字一致（rootsOf 对单根返回只含一项的数组）。
// 没有做成「sessions 直接支持数组」，是因为 conf.sessions 在配置读写 / 目录占用判定 / 诊断
// 等十几处被当作字符串用，全改成数组的爆炸半径太大；多一个可选字段是能一眼看明白的最小改法。
function rootsOf(c) {
  if (!c) return [];
  const extra = Array.isArray(c.sessionsExtra) ? c.sessionsExtra : [];
  return [...new Set([c.sessions, ...extra].filter(Boolean))];
}

function agentsList() {
  return [...agentConfs].map(([name, c]) => {
    const o = {
      name, kind: c.kind, sessions: c.sessions || null, traces: c.traces || null,
      sessionsExtra: c.sessionsExtra || null,
      builtin: !!c.builtin, enabled: c.enabled !== false, source: c.source || (c.builtin ? 'builtin' : 'manual'),
      missing: !!c.missing,
    };
    // traedb（trae/traework）的密钥状态：页面靠这三个字段决定「解密」按钮的形态与提示。
    // 只回「有没有 / 读不读得动 / 能不能抓」，**永远不回密钥本身**（接口不必外泄）。
    if (c.kind === 'traedb') {
      o.hasKey = !!c.traeKey;
      o.traeErr = traeDbErr.get(name) || null;
      o.captureSupported = traeCaptureSupported();
    }
    // cursor 的逐轮 token 只能靠 stop 钩子采（转录与 state.vscdb 都没有），所以这一行多带一份
    // 「hook 注了没」—— 页面据此决定那个图标按钮是「去注入」还是「已注入」。
    if (c.kind === 'cursor') o.hook = cursorHookStatus();
    return o;
  });
}

let configMissingWithLegacy = false; // 见 loadConfig 里的保险丝说明；saveConfig 据此拒绝落盘

// 归档配置：坏值一律回落默认（同 scanMs 的白名单思路）—— maxDays: "abc" 或 -1 不能被当成
// 「保留 -1 天」而把归档全删了，认不出的值等于没设。
// skip 是 agent 名数组：只收非空字符串、去重、按名排序（落盘后 diff 稳定，不会因为顺序抖动反复重写配置）。
function loadArchiveCfg(j) {
  if (!j || typeof j !== 'object') return;
  const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const skip = Array.isArray(j.skip)
    ? [...new Set(j.skip.map(s => String(s == null ? '' : s).trim()).filter(Boolean))].sort()
    : [];
  archiveCfg = { enabled: j.enabled !== false, maxDays: pos(j.maxDays), maxMB: pos(j.maxMB), skip };
}

// 异常巡检规则（R9）：坏值一律回落默认（同 scanMs 白名单思路 —— 阈值写成 "abc" / -1 不算数）。
//   tokens: {val}  > 0 才算启用，单位 token；durMs: {val} > 0 才算启用，单位毫秒；
//   fail:   {val} 取 1..100 的百分比，{window} 取 >=1 的轮数，val 越界即回落。
function loadAlertRules(j) {
  if (!j || typeof j !== 'object') return;
  const clone = () => JSON.parse(JSON.stringify(ALERT_DEFAULT));
  const next = clone();
  const tr = j.tokens; if (tr && typeof tr === 'object') {
    const v = Number(tr.val); if (Number.isFinite(v) && v > 0) next.tokens = { on: true, val: Math.round(v) };
  }
  const dr = j.durMs; if (dr && typeof dr === 'object') {
    const v = Number(dr.val); if (Number.isFinite(v) && v > 0) next.durMs = { on: true, val: Math.round(v) };
  }
  const fr = j.fail; if (fr && typeof fr === 'object') {
    const v = Number(fr.val); const w = Number(fr.window);
    if (Number.isFinite(v) && v >= 1 && v <= 100) {
      next.fail = { on: true, val: Math.round(v), window: Number.isFinite(w) && w >= 1 ? Math.round(w) : 50 };
    }
  }
  alertRules = next;
  alertDirty = true;
}

// 按当前规则重算命中条目。每次广播前调用（有新增日志或规则变化时），保证「新产生的异常条目
// 无需人工翻找即可被提示」。遍历 entries 是 O(n * 规则数)，n 上限 20000、规则又是简单数值比较，
// 只发生在 broadcast 附近，代价可接受。命中结果不落 index（纯内存派生，重扫后自然重算）。
const ALERT_KEYS = ['tokens', 'durMs', 'fail'];
function recomputeAlerts() {
  alertHits.clear();
  if (!(alertRules.tokens.on || alertRules.durMs.on || alertRules.fail.on)) { alertDirty = false; return; }
  let list = sortedEntries();
  // 失败率规则按 agent 分批：先算出每个 agent 的「最近 window 轮里失败占比」，再回填命中。
  // 只在 fail 规则启用时才做这份分组计算；两个「单轮」规则直接在遍历里判，不分组。
  const failAgents = new Map();   // agent -> {fail, total, threshold}
  if (alertRules.fail.on) {
    const perAgent = new Map();
    for (const e of list) { if (!perAgent.has(e.agent)) perAgent.set(e.agent, []); perAgent.get(e.agent).push(e); }
    const win = alertRules.fail.window;
    for (const [agent, arr] of perAgent) {
      // 窗口取「最近 window 轮」：list 已按时间降序，取前 window 条（不再翻更早的历史，
      // 否则挂机/隔夜那半天会把正常窗口全部稀释成低失败率，规则就失灵了）。
      const recent = arr.slice(0, win);
      const failed = recent.filter(e => e.status !== 'ok').length;
      failAgents.set(agent, {
        fail: failed, total: recent.length,
        threshold: alertRules.fail.val,
        hits: failed / (recent.length || 1) * 100,
      });
    }
  }
  for (const e of list) {
    const rules = [];
    let value = null;
    if (alertRules.tokens.on && (e.total || 0) > alertRules.tokens.val) { rules.push('tokens'); value = e.total; }
    if (alertRules.durMs.on && (e.dur || 0) > alertRules.durMs.val) { rules.push('durMs'); value = e.dur; }
    if (alertRules.fail.on && e.status !== 'ok') {
      // 失败率规则命中的是「构成失败的那几轮」—— 只有当该 agent 的失败占比超阈值时，
      // 这批失败轮才算异常；不超的话失败轮再多也是正常波动，不报。
      const f = failAgents.get(e.agent);
      if (f && f.hits >= f.threshold) { rules.push('fail'); value = value == null ? e.status : value; }
    }
    if (rules.length) alertHits.set(e.id, { agent: e.agent, rules, value });
  }
  alertDirty = false;
}

function alertSummary() {
  const byAgent = new Map();
  for (const h of alertHits.values()) {
    if (!byAgent.has(h.agent)) byAgent.set(h.agent, { count: 0, rules: new Set() });
    const o = byAgent.get(h.agent); o.count++; for (const r of h.rules) o.rules.add(r);
  }
  return {
    rules: alertRules,
    count: alertHits.size,
    agents: [...byAgent].map(([agent, o]) => ({ agent, count: o.count, rules: [...o.rules] })),
  };
}

// 页面上的 per-agent 归档开关（POST /api/archive/skip 的后端）：只认**已配置**的 agent 名 ——
// 页面将来要是传了个拼错的名字进来，那种名字会永久躺在 config.json 里，以后排查看不出出处。
// 语义与 config.archive.skip 完全一致：只停未来的归档，不删已冻好的文件。
function setArchiveSkip(agent, skip) {
  const name = String(agent == null ? '' : agent);
  if (!name || !agentConfs.has(name)) return { ok: false, error: '没有这个 agent：' + (name || '(空)') };
  const set = new Set(archiveCfg.skip);
  if (skip) set.add(name); else set.delete(name);
  archiveCfg = { ...archiveCfg, skip: [...set].sort() };
  saveConfig();
  return { ok: true, skip: archiveCfg.skip };
}

// 保存异常巡检规则（R9 的后端）：整组替换，坏值回落默认，保存后立刻重算命中并广播。
// 规则入口由 loadAlertRules 那套白名单守住 —— fetch 前先用它对 rules 做一次「归一化加载」，
// 保证命中的值都是干净整数。
function setAlertRules(rules) {
  const canned = { tokens: rules && rules.tokens, durMs: rules && rules.durMs, fail: rules && rules.fail };
  loadAlertRules(canned);       // 复用白名单校验 + 回落逻辑，把用户 payload 归一化成合法规则
  saveConfig();
  recomputeAlerts();
  broadcast();                  // 规则变化本身就是 user intent（lastActivity 已含），推 alert 事件
  return { ok: true, rules: alertRules, summary: alertSummary() };
}

function saveConfig() {
  // 只读库模式：一个字节都不写（R31 的 MCP 进程与常驻服务共用 DATA_DIR，双写就是互相覆盖）。
  // 内存里的 agentConfs 照改不误 —— 本进程要用它；只是不落盘，下次启动重新发现，代价几毫秒。
  if (MODE === 'lib') return;
  // 保险丝：本次一条配置都没读到，而老配置还躺在旧位置 —— 说明数据目录没搬完（或搬岔了）。
  // 这时落盘 = 把默认预置写成用户的配置：手工加的 agent、traeKey、ctxWindows 全被顶掉，
  // 用户刻意删掉的 agent 还会复活（loadConfig 开头那条红线）。宁可这一次不落盘。
  if (configMissingWithLegacy) {
    console.error('[config] 拒绝写盘：本次没读到任何配置，而老配置还在 ' + (legacyWithConfig() || LEGACY_DATA_DIRS.join(' / ')) +
      ' —— 多半是数据目录没搬完。把那里的配置拷到 ' + CONFIG_FILE + ' 后再启动服务。');
    return;
  }
  const agents = {};
  for (const [n, c] of agentConfs) {
    agents[n] = {
      kind: c.kind, sessions: c.sessions || null, traces: c.traces || null,
      builtin: !!c.builtin, enabled: c.enabled !== false, source: c.source || (c.builtin ? 'builtin' : 'manual'),
    };
    if (c.sessionsExtra && c.sessionsExtra.length) agents[n].sessionsExtra = c.sessionsExtra;
    // traedb 的解密密钥（64 位十六进制）。属于**用户意图**：库换个新版本/新机器时用户唯一要带过来的东西。
    // 只在有值时落盘（别的 agent 配置里不该凭空多一行）；agentsList() 不返回它 —— 接口不必外泄密钥。
    if (c.traeKey) agents[n].traeKey = c.traeKey;
    // R18 generic-jsonl：声明式规则、目录摆法与口径版本属于**用户意图**，随 config 落盘。
    // rulesHash 不是用户写的 —— 是 loadConfig 校验时算好挂上来的，这里照原样带回去，
    // 下次启动拿它判断「rules 改了没」（改了就 bump rulesRev → 旧 index 状态整份失效重扫）。
    if (c.kind === 'generic-jsonl') {
      if (c.rules) agents[n].rules = c.rules;
      if (c.sniff) agents[n].sniff = c.sniff;
      agents[n].rulesRev = c.rulesRev || 1;
      if (c.rulesHash) agents[n].rulesHash = c.rulesHash;
    }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // scanMs / idleExitMs 是顶层设置（与 agents 同级），同样属于用户意图，重启后保持
    // ctxWindows 只写**用户显式声明**的那几条，不写内置默认（否则以后改默认值会被旧配置压住）；
    // 空表干脆不写这个键，免得用户没改过窗口表、配置文件里却凭空多出一行
    const cfg = { v: 3, scanMs, idleExitMs, agents };
    if (Object.keys(ctxUser).length) cfg.ctxWindows = ctxUser;
    // 归档默认值不写盘（同 ctxWindows）：用户没改过就别让配置文件凭空多出一行，
    // 以后改默认值时也不会被旧配置压住。
    if (archiveCfg.enabled !== ARCHIVE_DEFAULT.enabled || archiveCfg.maxDays || archiveCfg.maxMB || archiveCfg.skip.length)
      cfg.archive = { ...archiveCfg };
    // 异常巡检规则：与默认全关不同就落盘（同 ctxWindows 思路——用户没配过不让配置凭空多一行）
    if (JSON.stringify(alertRules) !== JSON.stringify(ALERT_DEFAULT)) cfg.alert = { ...alertRules };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[config] save failed', e.message); }
}

// v2 的旧预置（codebuddy/workbuddy 走 trace）。v3 起改用 buddyjsonl（projects 正文）。
// 迁移只动「一字未改的旧预置」：kind 与两条路径都与旧默认一致、且新目录真实存在；用户改过的一律不碰。
const LEGACY_PRESETS = {
  codebuddy: { kind: 'trace', sessions: path.join(HOME, '.codebuddy', 'sessions'), traces: path.join(HOME, '.codebuddy', 'traces') },
  workbuddy: { kind: 'trace', sessions: path.join(HOME, '.workbuddy', 'sessions'), traces: path.join(HOME, '.workbuddy', 'traces') },
};
const samePath = (a, b) => (a || '') === (b || '');

function migratePresets() {
  const moved = [];
  for (const [name, oldP] of Object.entries(LEGACY_PRESETS)) {
    const c = agentConfs.get(name);
    if (!c || c.kind !== oldP.kind || !samePath(c.sessions, oldP.sessions) || !samePath(c.traces, oldP.traces)) continue;
    const next = DEFAULT_AGENTS[name];
    if (!next || !isDir(next.sessions)) continue; // 新版目录不存在（旧版产品）：保持原样，别把能用的配置改废
    agentConfs.set(name, { ...c, kind: next.kind, sessions: next.sessions, traces: next.traces || null });
    moved.push(name);
  }
  if (moved.length) log('[config] migrated v2 -> v3 presets:', moved.join(', '));
  return moved.length;
}

// R15：历史手动添加的 kimi-code 配置归一化为 kimi（需求书验收——不分裂为两个 agent）。
// 规则：有 kimi-code、无 kimi → 整条改名（保留 enabled/source 等全部字段）；
//       两者都在 → kimi 已被自动发现接管，删掉 kimi-code 避免并列。
// 复用 migratePresets 的「启动时一次性迁移 + 落盘」模式；迁移后索引里的旧 agent 名条目
// 会在下次扫描时因 agent 名对不上而被 evictStale/重扫自然淘汰，无需手搬数据。
function migrateKimiRename() {
  let moved = false;
  const old = agentConfs.get('kimi-code');
  if (old) {
    agentConfs.delete('kimi-code');
    if (!agentConfs.has('kimi')) agentConfs.set('kimi', old);
    moved = true;
  }
  // 已改过名的也可能带着旧 kind（上一版迁移只改名没纠正 kind）：sessions 指向 .kimi-code 的
  // 一律按 kimi 的 wire.jsonl 结构重认，kind 本来就是 kimi 的不动
  const cur = agentConfs.get('kimi');
  if (cur && cur.kind !== 'kimi' && cur.sessions && /kimi/i.test(String(cur.sessions))) {
    agentConfs.set('kimi', { ...cur, kind: 'kimi', sessions: path.join(HOME, '.kimi-code', 'sessions') });
    moved = true;
  }
  if (moved) log('[config] migrated kimi-code -> kimi (kind=' + agentConfs.get('kimi')?.kind + ')');
  return moved;
}

// 上一版把 genie 扩展注册成了独立一行 `codebuddy-ext`，现在它的会话并到 `codebuddy` 名下
// （同一个 CodeBuddy 拆两行，会把一个项目的历史劈成两半 —— 按 agent 筛就漏一边）。
// 这里**只删那条 conf**：根由 discoverAgents 每轮从 buddyExtDataRoots() 重算挂回
// codebuddy.sessionsExtra，所以不搬 sessions（搬了会和重算结果打架）。
// 条目也不用搬：buddyext 不在 OFF_KINDS，它的条目每次启动都是重建的，重启后自然挂在新 agent 名下。
function migrateCodebuddyMerge() {
  if (!agentConfs.has('codebuddy-ext')) return false;
  agentConfs.delete('codebuddy-ext');
  log('[config] codebuddy-ext 已并入 codebuddy（genie 扩展成为它的第二个根）');
  return true;
}

function migrateCopilotKind() {
  const cur = agentConfs.get('copilot');
  if (!cur) return false;
  for (const base of candidateBases('copilot')) {
    const conf = sniffBase(base);
    if (!conf || conf.kind !== 'copilot') continue;
    const same = cur.kind === conf.kind && samePath(cur.sessions, conf.sessions) && samePath(cur.traces, conf.traces);
    if (same) return false;
    agentConfs.set('copilot', { ...cur, kind: conf.kind, sessions: conf.sessions, traces: conf.traces || null });
    log('[config] migrated copilot kind/path:', cur.kind + ' -> ' + conf.kind, '(' + conf.sessions + ')');
    return true;
  }
  return false;
}

// Copilot 初接入前可能已有一个自动项被旧的通用探测误接到错误父目录；候选路径命中真实格式时纠正它。
function migrateCopilotKindAndPath() {
  return migrateCopilotKind();
}

// dsh 接入前，本机那条 dsh 是**手工加的**、kind 填的是 atomcode（当时没有解析器，这是唯一办法）。
// 现在有了真解析器，这些老配置必须纠正过来，否则它们挡在自动发现前面（discoverAgents 见名字已存在
// 就不接管），侧栏会一直是 0 条 —— 正是 kimi 当年「升级过的机器上完全看不出来」的翻版。
//
// 判据取**内容**而不是名字/路径：这个条目指向的目录（或它下面的 sessions/）里确实躺着 dsh 的
// 会话文件，才算它是 dsh。这样两种历史填法都能覆盖 —— 填 sessions 目录本身（本机就是这样）、
// 填 .dsh 基目录、以及用户把它命名成了别的名字。不看名字也顺带避免了「同名但不是 dsh」的误伤：
// 目录里没有 dsh 会话文件就一律不动。
// 安全性：一个目录里真有 dsh 会话文件时，原来的 kind 本来就读不出任何东西（否则也不用纠正了），
// 所以这个纠正不会让任何**原本能用**的配置变坏。
function migrateDshKind() {
  let moved = false;
  for (const [name, conf] of [...agentConfs]) {
    if (conf.kind === 'dsh' || !conf.sessions) continue;
    const s = String(conf.sessions);
    if (!hasDshSessions(s) && !hasDshSessions(path.join(s, 'sessions'))) continue;
    agentConfs.set(name, { ...conf, kind: 'dsh' });
    log('[config] migrated dsh kind:', name, conf.kind, '-> dsh');
    moved = true;
  }
  return moved;
}

// Trae 系解析器升级：SQLCipher 库现在能读了（见 parsers/traedb.mjs），老配置（tracecode/tracework，
// sessions 指向 logs 目录）要改接 database.db —— 库里有 token/工具/正文，renderer.log 只有事件骨架。
// 与 discoverAgents 的重嗅探是同一件事的两条路：source:auto 的条目靠重嗅探自愈，这里专门兜
// **手工添加**的（source:manual 不参与重嗅探，不迁移就是永远读不到库里的东西）。
// 判据取**实际文件**（traeDbFile 沿候选路径找 database.db），不看配置里怎么命名；
// 密钥没配的场景由主文件自动回退 renderer.log —— 迁过来至少不会比现在差。
function migrateTraeKind() {
  let moved = false;
  for (const [name, conf] of [...agentConfs]) {
    if (conf.kind !== 'tracecode' && conf.kind !== 'tracework') continue;
    if (!conf.sessions) continue;
    const db = traeDbFile(String(conf.sessions)) || traeDbFile(path.dirname(String(conf.sessions)));
    if (!db) continue;
    agentConfs.set(name, { ...conf, kind: 'traedb', sessions: db });
    log('[config] migrated trae kind:', name, conf.kind, '-> traedb', '(' + db + ')');
    moved = true;
  }
  return moved;
}

function loadConfig() {
  agentConfs.clear();
  let j = null;
  try { j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {
    // 回退：**同目录**下的旧文件名。覆盖两种人 —— 手工把老目录拷到新路径的，以及老版本刚写过的。
    // 读到就顺手改名为 config.json（与 loadIndex 把旧单文件索引改名成 .bak 同一套路）：
    // 否则下次还走回退，而且会出现「读的是旧名、写的是新名」两份配置。
    try {
      const old = path.join(DATA_DIR, LEGACY_CONFIG_NAME);
      j = JSON.parse(fs.readFileSync(old, 'utf8'));
      // 改名是**写**：只读库模式只读不改名（不改名的后果只是下次还走这条回退，几毫秒）
      if (MODE !== 'lib') try { fs.renameSync(old, CONFIG_FILE); log('[config] 配置文件名 ' + LEGACY_CONFIG_NAME + ' 已改为 config.json'); } catch {}
    } catch {}
  }
  // 保险丝（见 saveConfig 开头）：读到配置就一切照常；一条都没读到、而老配置还在旧位置 → 禁止落盘。
  // 它防的不是「搬迁逻辑写错了」，而是「搬迁逻辑将来被改错了」—— 那条链一旦走通是不可逆的。
  configMissingWithLegacy = !j && !!legacyWithConfig();
  // 预置只在「没有配置」时发生（全新安装 / v1 老配置迁移）。
  // v2/v3 配置就是用户意图的完整快照：删过的 agent 不能再被这里重新塞回来（否则又是删不掉）。
  if (!j || j.v === 1) {
    for (const [n, c] of Object.entries(DEFAULT_AGENTS)) agentConfs.set(n, { ...c, builtin: true, enabled: true, source: 'builtin' });
  }
  if (j && (j.v === 2 || j.v === 3)) {
    // 扫描节奏：只接受白名单值，坏值回落到默认（0 = 不实时更新/暂停定时扫描）
    if (SCAN_CHOICES.includes(j.scanMs)) scanMs = j.scanMs;
    if (IDLE_CHOICES.includes(j.idleExitMs)) idleExitMs = j.idleExitMs;
    loadAlertRules(j.alert);      // 异常巡检规则（R9；默认全关，坏值回落默认）
    loadCtxWindows(j.ctxWindows); // 上下文窗口表：模型名（或前缀）-> 容量，认不出的留 0
    loadArchiveCfg(j.archive);    // 归档开关与保留上限（见 archive.mjs）
    for (const [n, c] of Object.entries(j.agents || {})) {
      // builtin 仅作展示标记（预置项），不再决定能否删除
      const isPreset = Object.prototype.hasOwnProperty.call(DEFAULT_AGENTS, n);
      agentConfs.set(n, { ...c, builtin: isPreset, enabled: c.enabled !== false });
    }
    if (j.v === 2 && migratePresets()) saveConfig();
  } else if (j && j.v === 1) {
    // v1 无损迁移：custom -> agents，source:manual
    for (const [n, c] of Object.entries(j.custom || {})) agentConfs.set(n, { ...c, builtin: false, enabled: true, source: 'manual' });
    log('[config] migrated v1 -> v2');
    saveConfig();
  }
  // R15：无论哪个版本，都把历史 kimi-code 改名为 kimi（改了就落盘）
  const migrated = migrateKimiRename();
  const migratedCopilot = migrateCopilotKindAndPath();
  const migratedBx = migrateCodebuddyMerge();
  // dsh 同理：手工加的那条要把 kind 从 atomcode 纠正过来（见 migrateDshKind）
  // trae 系同理：tracecode/tracework 的老配置改接 SQLCipher 库（见 migrateTraeKind）
  // R18：generic-jsonl 的规则校验 + 口径版本管理（loadIndex 之前必须做完 —— 恢复 index 要拿
  // rulesRev/rulesHash 逐文件比对；这里必须在首次 loadIndex 前把 rulesHash 算好挂到 conf 上）
  const genericChanged = validateGenericConfigs();
  if (migrateDshKind() || migrateTraeKind() || migrated || migratedCopilot || migratedBx || genericChanged) saveConfig();
}

// R18：generic-jsonl 声明式规则的集中校验与版本管理。每个 kind=generic-jsonl 的 agent：
//   1) rules 过 validateGenericRules —— 校验失败回落 enabled:false，错误明细挂在 rulesErrors 上
//      （诊断页据此说出**具体哪条 rule 坏了**，不静默扫出 0 条；修好规则后错误清除，
//      enabled 仍要用户手动恢复 —— 避免「改对一个字段就让停用的 agent 自己上线」的意外）；
//   2) rulesHash 变了（= 落盘 turns 口径变了）自动 bump rulesRev。不靠人记 bump：
//      index 恢复按 rr/rh 逐文件比对，版本对不上整份丢弃重扫，不会出现「半新半旧」。
function validateGenericConfigs() {
  let changed = false;
  for (const [name, c] of agentConfs) {
    if (c.kind !== 'generic-jsonl') continue;
    const errs = validateGenericRules(c.rules);
    const hash = genericRulesHash(c.rules || {});
    if (!c.rulesRev) c.rulesRev = 1;                       // 首次声明
    else if (c.rulesHash && c.rulesHash !== hash) c.rulesRev++;  // rules 变了
    if (c.rulesHash !== hash) changed = true;
    c.rulesHash = hash;
    if (errs.length) {
      if (c.enabled !== false) {
        console.error('[config] generic-jsonl 规则校验失败，回落禁用：' + name + ' —— ' +
          errs.map(e => e.rule + '：' + e.msg).join('；'));
      }
      c.enabled = false;
      c.rulesErrors = errs;
    } else if (c.rulesErrors && c.rulesErrors.length) {
      delete c.rulesErrors;
      changed = true;
    }
  }
  return changed;
}

// ---------------- 环境诊断（/api/diagnose） ----------------
// 给每个候选 agent 逐个候选目录报「在不在 / 认成什么格式 / 没认出来是为什么 / 接没接上」。
// 目的：把「目录就在那、但格式没识别」这种静默情况显式暴露出来，补解析器有的放矢（见需求书 §3.6）。
// 只在用户点开诊断时调用，不做缓存。
const DB_RE = /\.(db|sqlite|sqlite3|vscdb)$/i;
function dirHint(base) {
  let names; try { names = fs.readdirSync(base).slice(0, 60); } catch { return null; }
  if (!names.length) return '空目录';
  const sq = names.filter(n => DB_RE.test(n));
  // 数据库常常放在子目录里（cursor 的就是 <base>/ai-tracking/ai-code-tracking.db），
  // 只扫顶层会把「这里其实有 sqlite」漏掉——而 A3 的决策正需要看到它。往下探一层，限量扫。
  for (const n of names.slice(0, 12)) {
    if (sq.length >= 3) break;
    if (!isDir(path.join(base, n))) continue;
    let sub; try { sub = fs.readdirSync(path.join(base, n)).slice(0, 40); } catch { continue; }
    for (const s of sub) if (DB_RE.test(s)) sq.push(n + '/' + s);
  }
  const head = names.slice(0, 8).map(n => (isDir(path.join(base, n)) ? n + '/' : n)).join(' ');
  let out = '顶层：' + head + (names.length > 8 ? ' …' : '') +
    (sq.length ? '；含 sqlite 数据库（' + sq.slice(0, 3).join(', ') + '）——零依赖原则下读不了，需先决策' : '');
  // cursor 的常见「路径明明对、却一条也扫不到」：它的 projects/<slug>/ 里，**只有跑过 Agent 模式的项目**
  // 才有 agent-transcripts/；只聊过天的项目只有 mcps/ 和 terminals/。
  // 这不是解析器坏了，也不是路径写错了 —— 直接说出来，省得往那两个方向查。
  const projDir = path.join(base, 'projects');
  if (isDir(projDir)) {
    try {
      let withT = 0, without = 0;
      for (const s of fs.readdirSync(projDir).slice(0, 60)) {
        if (!isDir(path.join(projDir, s))) continue;
        if (isDir(path.join(projDir, s, 'agent-transcripts'))) withT++; else without++;
      }
      if (!withT && without) out += '；projects/ 下有 ' + without + ' 个项目目录，但没有一个含 agent-transcripts —— Cursor 的 Chat 不落这个目录，只有 Agent 模式的会话才写，说明这台机器上还没跑过 Agent 会话';
      else if (withT) out += '；projects/ 下有 ' + withT + ' 个项目含 agent-transcripts（有 Agent 会话）';
    } catch {}
  }
  return out;
}

function diagnose() {
  const cnt = counts().agents;
  const rows = [];
  const describe = (name, conf, cands) => {
    const row = {
      name, registered: !!conf, enabled: conf ? conf.enabled !== false : null,
      kind: conf?.kind || null, sessions: conf?.sessions || null, traces: conf?.traces || null,
      // 额外根要在诊断页看得见，否则「一个 agent 名下有两份落盘」（kimi 的桌面版根、codebuddy 的
      // genie 扩展根）这件事只剩 note 里一句话，排查时点进来看不到根清单。
      sessionsExtra: conf?.sessionsExtra || null,
      source: conf?.source || null, missing: !!(conf && conf.missing), entries: cnt[name] || 0,
      ownedBy: conf ? (dirTaken(conf, name) || null) : null, candidates: cands,
      ruleErrors: conf?.rulesErrors || null,   // R18 generic-jsonl：坏规则明细（诊断页要能说出哪条 rule 坏了）
    };
    const hit = cands.find(c => c.kind && !c.probe);   // 探路路径不算「认出来了」，见 PROBE_ONLY_BASES
    if (!conf) {
      // 认出来了但没注册给它：多半是同一份目录已经被别的 agent 接了（如手工加的 codeart 与
      // 自动发现名单里的 codearts 指向同一个 codearts-agent 目录），别误报成「需要写新解析器」
      const owner = hit ? dirTaken({ sessions: hit.sessions, traces: null }, name) : null;
      if (hit && owner) {
        row.state = 'owned';
        row.stateText = '已由 ' + owner + ' 接入';
        row.note = '同一份目录（' + hit.path + '），避免重复扫描所以不让 ' + name + ' 再接一次';
      } else if (hit) {
        row.state = 'unrecognized';
        row.stateText = '目录在但未识别';
        row.note = hit.path + ' —— 嗅探没认出来，需要新增解析器';
      } else {
        // 「目录在但整棵子树都没认出来」和「压根没装」必须分开：前者正是要补解析器的目标
        // （cursor/copilot 就是这一类），混进灰色「未安装」里就等于又静默了。
        const any = cands.find(c => c.exists);
        if (any) {
          row.state = 'unrecognized';
          row.stateText = '目录在但未识别';
          row.note = any.path + ' —— ' + (any.probe
            ? '这是尚未接入的变体（探路路径，不参与自动发现），需要先拿到它的日志样本再写解析器'
            : '目录在，但整棵子树都没被认成已知格式，需要新增解析器');
        } else {
          row.state = 'absent'; row.stateText = '未安装'; row.note = '候选目录都不存在';
        }
      }
    } else if (!row.enabled) {
      row.state = 'disabled'; row.stateText = '已禁用';
      // generic-jsonl 的「被禁用」多半不是手关的：rules 校验失败在 loadConfig 阶段回落 enabled:false。
      // 不把坏的是哪条说清楚，用户面对一片空白只会以为路径写错了 —— 这里把 rule 名和原因逐条列出。
      row.note = (row.ruleErrors && row.ruleErrors.length)
        ? '声明式规则校验失败，已回落禁用（修好 config 里的 rules 后再手动启用）：' +
          row.ruleErrors.map(e => e.rule + ' —— ' + e.msg).join('；')
        : '在页面上被手动关掉了，不参与扫描';
    } else if (conf.missing === undefined) {
      // conf.missing 只在扫描经过 agentScannable 时才会被赋值，所以「从没被赋过值」= 这一轮还没看过盘
      // （首扫是分片的，一个 agent 一个 agent 过；或这条配置刚加进来）。这时候报「已接入 · 0 条」
      // 再补一句「目录认出来了、也在扫，但一条都没解析出来」是假话 —— 它压根还没扫，
      // 而 0 条只是还没轮到。首扫那几秒里整页都长这样，会把人送去查解析器。
      row.state = 'pending'; row.stateText = '还没扫到';
      row.note = '首扫是分片的，这一轮还没轮到它（或这条配置刚加进来）—— 现在 0 条不代表盘上没有，扫完这行会自己改口';
    } else if (row.missing) {
      row.state = 'missing'; row.stateText = '目录消失'; row.note = '配置里的目录（' + (row.sessions || row.traces) + '）现在不存在';
    } else if (!row.entries) {
      row.state = 'empty'; row.stateText = '已接入 · 0 条';
      // dsh 的 zstd 需要 Node 22.15+。这一条必须**单独说**：笼统的「格式细节对不上」会把排查方向
      // 指向「去看日志里长什么样」，而真正该做的是升级 Node —— 换个版本的 Node 就全好了。
      row.note = (row.kind === 'dsh' && !DSH_ZSTD_OK)
        ? '目录认出来了，但 dsh 的会话是 zstd 压缩的，解压接口要 Node 22.15+（当前 ' + process.version +
          ' 的 zlib 里没有 zstdDecompressSync）——升级 Node 即可，不是路径或格式的问题'
        : (row.kind === 'zcode' && zcodeScanErr.get(name))
          ? '数据库认出来了，但最近一次读取失败：' + zcodeScanErr.get(name) +
            '（库被别的进程独占锁定、文件损坏或 schema 变了都会走到这里；面板会保留上一轮读到的数据，恢复后自动跟上）'
          : (row.kind === 'opencode' && opencodeScanErr.get(name))
            ? 'OpenCode 库认出来了，但最近一次读取失败：' + opencodeScanErr.get(name) +
              '（库被别的进程独占锁定、文件损坏或 schema 变了都会走到这里；面板会保留上一轮读到的数据，恢复后自动跟上）'
          : (row.kind === 'kilo' && kiloScanErr.get(name))
            ? 'KiloCode 库认出来了，但最近一次读取失败：' + kiloScanErr.get(name) +
              '（库被别的进程独占锁定、文件损坏或 schema 变了都会走到这里；面板会保留上一轮读到的数据，恢复后自动跟上）'
          : (row.kind === 'hermes' && hermesScanErr.get(name))
            ? 'Hermes 库认出来了，但最近一次读取失败：' + hermesScanErr.get(name) +
              '（库被别的进程独占锁定、文件损坏或 schema 变了都会走到这里；面板会保留上一轮读到的数据，恢复后自动跟上）'
          : (row.kind === 'devindb' && devinDbErr.get(name))
            ? 'Devin 库认出来了，但最近一次读取失败：' + devinDbErr.get(name) +
              '（库被别的进程独占锁定、文件损坏或 schema 变了都会走到这里；面板会保留上一轮读到的数据，恢复后自动跟上）'
          : (row.kind === 'traedb' && traeDbErr.get(name))
            ? 'SQLCipher 库认出来了，但读不出来：' + traeDbErr.get(name) +
              '（库里是 Trae 的完整会话记录；没配 traeKey 时只能用 renderer.log 的骨架数据，' +
              '密钥的获取办法见 REFERENCE.md「Trae 的 SQLCipher 库」一节）'
            : (row.kind === 'copilot' && copilotScanErr.get(name))
              ? 'Copilot 目录认出来了，但最近一次读取用量库失败：' + copilotScanErr.get(name) +
                '（正文仍会从 session-state/*/events.jsonl 解析；用量库恢复后自动补齐）'
            : (row.kind === 'cline' && clineScanErr.get(name))
              ? 'Cline 目录认出来了，但最近一份会话文件读不动：' + clineScanErr.get(name) +
                '（messages.json 是**整份 JSON**、会话进行中每次整体重写 —— 写到一半被读到、文件坏了、' +
                '或新版换了字段形状都会走到这里；下一轮扫描会自动重来，不必重启）'
            : ((row.kind === 'buddyext' || row.kind === 'buddyjsonl') && buddyExtScanErr.get(name))
              ? 'CodeBuddy 扩展目录认出来了，但最近一份会话 index.json 读不动：' + buddyExtScanErr.get(name) +
                '（会话 index 是**整份 JSON**、进行中每次整体重写 —— 写到一半被读到、文件坏了、' +
                '或新版换了 requests/messages 形状都会走到这里；下一轮扫描会自动重来，不必重启。' +
                '另：CodeBuddy 家的 CLI 在 ~/.codebuddy、IDE 壳在 %APPDATA%\\CodeBuddy CN，都不在这份数据里）'
            : (row.kind === 'traedb' )
              ? '库认出来了、也能解密，但一条会话都没解析出来（库可能是空的，或 schema 与已知版本不同）'
              : '目录认出来了、也在扫，但一条都没解析出来——多半是格式细节对不上';
    } else {
      row.state = 'ok'; row.stateText = '已接入'; row.note = row.kind + ' · ' + row.entries + ' 条';
      // 库读不出来、回退 renderer.log 时条目是有的（所以落在 ok 行），但必须把「为什么是日志数据」说清：
      // 不写的话这一行看着完全正常，用户不会知道卡片上少了 token 与工具明细是因为密钥没配。
      if (row.kind === 'traedb' && traeDbErr.get(name)) {
        const active = traeLogKindOf(row.sessions || '');
        row.note += '（已回退 ' + active + ' 日志解析：' + traeDbErr.get(name) + '）';
      }
      // codebuddy 名下有两份落盘（CLI 的 projects/**/*.jsonl + genie 扩展的 CodeBuddyExtension/Data），
      // 合成一行就必须让这一行说得出「两边各有多少、另一边是不是坏了」：
      // 不写的话扩展那半读不动时这行看着完全正常（CLI 那半还有条目撑着条数），
      // 用户只会觉得「应用里的会话怎么少了一半」—— 与 trae 回退 renderer.log 同一类要说明的事。
      if (row.kind === 'buddyjsonl' && (row.sessionsExtra || []).length) {
        let bx = 0;
        for (const [id, e] of entries) if (e.agent === name && srcs.get(id)?.kind === 'buddyext') bx++;
        row.note += '（含 genie 扩展 ' + bx + ' 条）';
        if (buddyExtScanErr.get(name)) row.note += '（genie 扩展那半最近一次读不动：' + buddyExtScanErr.get(name) + '，下一轮自动重来）';
      }
    }
    // 「两个 agent 指向同一个根」在这种重复被拦住之前就可能已经落进配置里了。它不会多出一份数据，
    // 只会让两边的条数随扫描先后互相抢（条目 id 不含 agent 名）—— 抢输的那行看着像坏了。
    // 这条必须说破，否则用户只会去怀疑解析器。删掉哪一条都行，所以两个名字都给出来。
    if (row.ownedBy && (row.state === 'ok' || row.state === 'empty')) {
      row.note = (row.note ? row.note + ' ' : '') + '⚠ 这个根同时也由「' + row.ownedBy + '」在扫：条目归属会被后扫的一方抢走（不是两份数据），两条里删掉一条即可';
      row.state = 'warn'; row.stateText = '重复的根';
    }
    // codebuddy 名下有两份落盘。扩展那半没探到时，这一行看着只是「CLI 的数」，而成因有四种
    // （没装扩展 / 没有 Data/ / <host> 名不认得 / 没有 history/）—— 不写出来的话，同事一句
    // 「读不到 codebuddy」只能远程让人敲命令问盘。措辞与 [discover] 那行同源（buddyExtMissingWhy）。
    if (name === 'codebuddy' && !(row.sessionsExtra || []).length) {
      const bxWhy = buddyExtMissingWhy();
      if (bxWhy) row.note = (row.note ? row.note + ' ' : '') + '（genie 扩展根未探到：' + bxWhy + '）';
    }
    return row;
  };
  for (const name of KNOWN_AGENTS) {
    const cands = [];
    // 探路路径排在**最后**：它们只用来「让人看见这台机器上有没有这个变体、里面长什么样」，
    // 不参与自动发现（原因见 PROBE_ONLY_BASES），所以就算被 sniffBase 兜底认成别的 kind，
    // 也不会盖过前面那些真候选 —— describe() 里 hit 取的是第一个 kind 非空的，就是为这个排序。
    // kimi 已注册时，把它**实际在扫的全部根**也列进来（桌面版那份 home 不在任何候选路径里，
    // 是从 daimon-storage.json 推出来的）——「我明明装了桌面版，怎么没数据」靠这行自查。
    // ⚠️ 这些是 **sessions 目录本身**，不是「基目录」，不能再丢给 sniffBase：
    // 它会把 basename==='sessions' 的路径按兜底分支判成 atomcode（本轮就踩到过）。
    // 所以直接按已知的 kind 报，不嗅探。
    const actual = name === 'kimi' ? rootsOf(agentConfs.get(name)) : [];
    for (const p of actual) {
      cands.push({
        path: p, exists: isDir(p), kind: agentConfs.get(name)?.kind || null, sessions: p,
        probe: false, known: true, hint: null,
        reason: isDir(p) ? null : '目录不存在（配置里还记着，下次扫描会摘掉）',
      });
    }
    const real = candidateBases(name).filter(p => !actual.includes(p)).map(p => ({ path: p, probe: false }));
    const probe = probeBases(name).map(p => ({ path: p, probe: true }));
    for (const { path: base, probe: isProbe } of [...real, ...probe]) {
      const exists = isDir(base);
      let conf = null, err = null;
      if (exists) { try { conf = sniffBase(base); } catch (e) { err = e.message; } }
      let hint = null;
      if (exists && !conf) { try { hint = dirHint(base); } catch {} }
      cands.push({
        path: base, exists, kind: conf ? conf.kind : null, sessions: conf ? conf.sessions : null,
        probe: isProbe,   // 探路路径：诊断照列，自动发现不碰（见 PROBE_ONLY_BASES）
        reason: err ? ('嗅探报错：' + err) : (!exists ? '目录不存在' : (conf ? null : '目录存在但未识别到已知日志结构')),
        hint,
      });
    }
    rows.push(describe(name, agentConfs.get(name), cands));
  }
  // 名单外的手工项（如 codeart）也列出来，否则「我加的 agent 跑哪去了」没法自查
  for (const [name, conf] of agentConfs) {
    if (KNOWN_AGENTS.includes(name)) continue;
    rows.push(describe(name, conf, [{ path: conf.sessions || conf.traces || '', exists: confAvailable(conf), kind: conf.kind, sessions: conf.sessions || null, reason: null, hint: null }]));
  }
  rows.sort((a, b) => (b.entries - a.entries) || a.name.localeCompare(b.name));
  // version/build 一起报出去：「我装的是新版、为什么没有新功能」这类问题，第一步就得能看出**正在伺候你的服务**是哪一版
  // platform 一起报出去：这份诊断经常是**别的机器**（mac / Linux / 鸿蒙 PC）上截的图，
  // 而候选路径是按 process.platform 分支展开的 —— 不写平台，收到截图的人没法判断
  // 「这条路径不存在」是在哪套约定下不存在的，也没法确认鸿蒙 PC 的 Node 到底报什么值。
  return { home: HOME, platform: process.platform, port: PORT, dataDir: DATA_DIR, version: VERSION, build: BUILD, known: KNOWN_AGENTS, agents: rows };
}

// ---------------- 磁盘占用（/api/usage，R30） ----------------
// 回答的是「哪个 agent 的日志 / 索引 / 归档最占地方，清理时该动谁」——这些数散在三个地方
// （源日志目录、index/ 分片、archive/ 清单），没有任何一处能一次看全。
//
// 遍历必须**带预算**：整个服务只有一个线程，扫描与 SSE 推送都在上面，而日志目录动辄几万个文件
// （本机 .claude/projects 一个项目就 86 个会话文件）。所以一次请求最多走 USAGE_MAX_FILES 个目录项、
// 最多花 USAGE_MAX_MS 毫秒，超了就返回已统计的部分并标 partial（页面上明说「统计到一半」，
// 不假装是完整数字 —— 报小了比报不出来更坏）。
const USAGE_MAX_FILES = Number(process.env.AGENT_LOG_USAGE_MAX_FILES || 60000);
const USAGE_MAX_MS = Number(process.env.AGENT_LOG_USAGE_MAX_MS || 4000);
const USAGE_TTL_MS = 60000;   // 结果缓存：磁盘占用不是要实时的数，反复点开别把机器走一遍
let usageCache = { at: 0, data: null };

// 一个文件有多大。Dirent 自己**没有** statSync（Node 到 v23 才挂上懒取属性），必须按路径 stat；
// 早先在这里写 e.statSync() 会静默抛错，被 catch 吞掉的结果是整棵目录树报 0 字节（test/usage-test.mjs 拦这条）。
function sizeOfEnt(base, name) {
  try { return fs.statSync(path.join(base, name)).size; } catch { return -1; }
}

// 一次统计**一批根**，返回与入参同序的 [{bytes,files,dirs,links,partial}]。
// 三条要紧的做法：
//   · **按目录轮转**（队列广度优先，不是走完一个根再走下一个）：预算不够时每个根都分到一点，
//     表上不会出现「只有第一行有数、其余全 0」—— 那种截断会把「谁最占地方」的排名彻底带偏。
//   · **不跟随符号链接 / junction**：把日志根链到别处是常见做法（测试环境就这么造），跟着走要么
//     重复计数、要么直接转圈。
//   · 库文件根（zcode / traedb / opencode / kilo / hermes / devin 的 sessions 是 .db 路径）连 WAL / SHM 一起算 ——
//     那两个常常比主文件还大，只算主文件会把占用报小一半。
function rootsUsage(roots, budget) {
  const outs = roots.map(() => ({ bytes: 0, files: 0, dirs: 0, links: 0, partial: false }));
  const queue = [];
  roots.forEach((r, i) => {
    if (isFile(r)) {
      for (const s of [r, r + '-wal', r + '-shm']) {
        try { const st = fs.statSync(s); if (st.isFile()) { outs[i].bytes += st.size; outs[i].files++; } } catch {}
      }
      return;
    }
    queue.push([r, i]);
  });
  const out = () => { for (const [, i] of queue) outs[i].partial = true; };   // 还在排队的都是没走完的
  while (queue.length) {
    const [dir, i] = queue.shift();
    if (budget.visited >= USAGE_MAX_FILES || Date.now() > budget.until) { outs[i].partial = true; out(); break; }
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      // 先判后加：写成 `budget.visited++ >= MAX` 会让**被拒的那一次**也计进 visited，
      // 报出来的「走了多少个目录项」就比预算还大一个（页面把它当账目展示，账必须对得上）
      if (budget.visited >= USAGE_MAX_FILES || Date.now() > budget.until) { outs[i].partial = true; out(); queue.length = 0; break; }
      budget.visited++;
      if (e.isSymbolicLink()) { outs[i].links++; continue; }
      const base = e.path || dir;
      if (e.isDirectory()) { outs[i].dirs++; queue.push([path.join(base, e.name), i]); continue; }
      if (!e.isFile()) continue;
      const sz = sizeOfEnt(base, e.name);
      if (sz < 0) continue;
      outs[i].bytes += sz; outs[i].files++;
    }
  }
  return outs;
}

function usageReport(force) {
  if (!force && usageCache.data && Date.now() - usageCache.at < USAGE_TTL_MS)
    return { ...usageCache.data, cached: true };
  const budget = { visited: 0, until: Date.now() + USAGE_MAX_MS };
  const cnt = counts().agents;   // 一次算好：counts() 是遍历全部条目的，别在循环里调
  const arch = archiveIndex();
  const archBy = {};
  for (const a of arch.agents) archBy[a.agent] = a;

  const rows = [];
  // 同一份目录被两个 agent 指着是可能的（手工加了 codex、又留着 copilot 的旧配置指向同一处）。
  // 行内照实各报各的（这一行回答的是「这个 agent 的根有多大」），但**合计去重** ——
  // 不然 totals 比磁盘上真实占的还大，而这一页的存在理由恰恰是「要清多少地方」。
  const normRoot = p => { try { return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p); } catch { return String(p); } };
  const rootOwner = new Map();
  let logBytesDedup = 0;
  for (const [agent, conf] of agentConfs) {
    const roots = [...rootsOf(conf), conf.traces].filter(Boolean);
    let bytes = 0, files = 0, partial = false, sharedBy = '';
    const us = rootsUsage(roots, budget);
    roots.forEach((r, ri) => {
      const u = us[ri], key = normRoot(r);
      bytes += u.bytes; files += u.files; partial = partial || u.partial;
      if (rootOwner.has(key)) sharedBy = sharedBy || rootOwner.get(key);
      else { rootOwner.set(key, agent); logBytesDedup += u.bytes; }
    });
    const a = archBy[agent] || { days: 0, count: 0, bytes: 0 };
    rows.push({
      agent, kind: conf.kind || 'atomcode', enabled: conf.enabled !== false, roots,
      logBytes: bytes, logFiles: files, partial, sharedBy,
      indexKind: OFF_KINDS.has(conf.kind) ? conf.kind : null,   // 索引按 kind 分片，见下面 indexShards
      archiveBytes: a.bytes, archiveDays: a.days, archiveCount: a.unknown ? -1 : a.count,
      entries: cnt[agent] || 0,
    });
  }
  rows.forEach(r => { r.totalBytes = r.logBytes + r.archiveBytes; });
  rows.sort((a, b) => b.totalBytes - a.totalBytes || a.agent.localeCompare(b.agent));

  // 索引片单独一列：一片可能同时供好几个 agent（traedb 的 agent 用的是 tracecode.json），
  // 塞进 agent 行里相加就是重复计数。
  const indexShards = [];
  let indexBytes = 0;
  try {
    for (const fn of fs.readdirSync(INDEX_DIR).filter(n => n.endsWith('.json')).sort()) {
      let st = null; try { st = fs.statSync(path.join(INDEX_DIR, fn)); } catch {}
      const kind = fn.slice(0, -5);
      indexShards.push({ kind, bytes: st ? st.size : 0, rev: PARSER_REV[kind] == null ? null : PARSER_REV[kind], persisted: PARSER_REV[kind] != null });
      indexBytes += st ? st.size : 0;
    }
  } catch {}

  // 数据目录构成：清理残留时要能一句句报出来（widget-runtime 那份 Electron 运行时就能占 ~100MB）。
  // 与上面同样一次 rootsUsage：目录之间轮转，预算截断时每项都分到一点，而不是第一项吃完其余全 0。
  const dataItems = [];
  let dataBytes = 0;
  try {
    const items = [];
    for (const e of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (e.isSymbolicLink()) { items.push({ name: e.name, path: path.join(DATA_DIR, e.name), skip: true }); continue; }
      items.push({ name: e.name + (e.isDirectory() ? '/' : ''), path: path.join(DATA_DIR, e.name), dir: e.isDirectory() });
    }
    const us2 = rootsUsage(items.map(i => i.path), budget);
    items.forEach((it, i) => {
      const u = us2[i];
      // 顶层的链接项不跟随（也不 stat），但要在构成里露出来 —— 看不见就会以为「这里怎么少了东西」
      if (it.skip) { dataItems.push({ name: it.name, dir: false, bytes: 0, files: 0, partial: false, link: true }); return; }
      dataItems.push({ name: it.name, dir: it.dir, bytes: u.bytes, files: u.files, partial: u.partial });
      dataBytes += u.bytes;
    });
    dataItems.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  } catch {}

  const data = {
    ok: true, at: Date.now(), dataDir: DATA_DIR, port: PORT,
    budget: { maxFiles: USAGE_MAX_FILES, maxMs: USAGE_MAX_MS, visited: budget.visited },
    partial: rows.some(r => r.partial) || dataItems.some(i => i.partial),   // 以「哪一段真被截断」为准，不看 visited
    agents: rows,
    indexShards,
    archive: { root: arch.root, agents: arch.totals.agents, days: arch.totals.days, count: arch.totals.count, bytes: arch.totals.bytes },
    dataItems,
    totals: {
      // logBytes 去重、logBytesRows 是各行相加：两个数不等就说明确有 agent 共用目录（页脚说明白）
      logBytes: logBytesDedup, logBytesRows: rows.reduce((s, r) => s + r.logBytes, 0),
      archiveBytes: arch.totals.bytes, indexBytes, dataBytes,
      agents: rows.length, logFiles: rows.reduce((s, r) => s + r.logFiles, 0),
    },
  };
  usageCache = { at: data.at, data };
  return { ...data, cached: false };
}


// 自动发现：KNOWN_AGENTS 名单逐个探测；已注册的 source:auto 条目目录消失/被他人占用则自动摘除（不报错）
// 同一份日志目录只允许一个 agent 扫：用户手工加的 codeart 和自动发现的 codearts 指向同一个
// codearts-agent 目录，两个都注册会重复扫/重复灌条目，自动发现这边让位（手工配置优先）
// （重组脚本误删后对照备份补回）
function dirTaken(conf, self) {
  const norm = p => (p ? (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)) : '');
  for (const [n, c] of agentConfs) {
    if (n === self) continue;
    if (conf.sessions && rootsOf(c).some(p => norm(p) === norm(conf.sessions))) return n;
    if (conf.traces && norm(c.traces) === norm(conf.traces)) return n;
  }
  return null;
}

// 配置里的根是否真的存在（missing 判定）；重组脚本误删后对照备份补回
function confAvailable(c) {
  // zcode / traedb / opencode / kilo / hermes / devin 的根是**数据库文件**而不是目录（sessions 存的是 db 路径）
  if (c.kind === 'zcode' || c.kind === 'traedb' || c.kind === 'opencode' || c.kind === 'kilo' || c.kind === 'hermes' || c.kind === 'devindb') return !!(c.sessions && isFile(c.sessions));
  return rootsOf(c).some(isDir) || (c.traces && isDir(c.traces));
}

// 这几个 agent 的 conf.sessions **本身就是根目录**，不是「根目录下的某个子目录」：
//   copilot  = <base>/session-state
//   minimax  = <base>/v2/sessions
//   mimocode = <base>（mimocode 应用根，库在它下面）
//   openclaw = <base>（OpenClaw stateDir，转录在它下面的 agents/<id>/sessions/）
//   comate   = <base>（百度 Comate 的 store 根，chat_session_* 平铺在它下面）
//      ⚠️ 漏了 comate 的实测病征：**每轮扫描 0 条 ↔ 3 条来回闪**。它的 sessions 是
//      ~/.comate-engine/store，取 dirname 爬到 ~/.comate-engine —— 那底下 browser/ log/ machine/ 里
//      有 *.jsonl，被 claude 的兜底判据 hasClaudeJsonl(base) 接走 → kind 被改写成 claude 并 purgeAgent
//      → 下一轮 candidateBases 又把它找回来注册成 comate → 无限翻转（条目一会儿有一会儿没）。
// 重新嗅探时若对它们取 path.dirname 会爬到**上层**，从而认成隔壁 agent（mimocode 的真实事故）
// 或退化成 atomcode。按 name 判断，不按 kind —— kind 正是可能被改坏的那个字段。
const ROOT_SESSIONS_AGENTS = new Set(['copilot', 'minimax', 'mimocode', 'openclaw', 'comate']);

// 只用**本 agent 自己的**候选路径重新推导配置（candidateBases + sniffBase）。
// 用途：配置里的 sessions 被别的 agent 抢走 / 被改错时，回到本源把它找回来。
// 为什么不复用下面那段「爬一层重嗅探」：那段是从**已被改坏的 sessions** 出发的，
// 已被改坏时它只会再次返回对方的 kind（mimocode 顶着 opencode.db 时正是如此），永远自愈不了。
//
// 挑选规则（两条都不能省）：
//   ① 跳过被**别的 agent** 占着的候选（dirTaken）—— 否则 ~/.local/share 这种上层路径
//      会认成 opencode，等于把抢来的东西又认一遍；
//   ② kind 与 name **同名**的优先（mimocode / opencode 这类一一对应的），
//      没有同名命中时（qoder→claude、trae→traedb、traework→tracework 这类多对一）退回第一份未被占的。
function ownConfFor(name) {
  const cands = [];
  for (const base of candidateBases(name)) {
    const conf = sniffBase(base);
    if (!conf) continue;
    if (dirTaken(conf, name)) continue;      // ①
    cands.push(conf);
    if (conf.kind === name) return conf;     // ②
  }
  return cands[0] || null;
}

// codebuddy 扩展根的结论只记一份：discoverAgents 每轮扫描都会跑，日志要「变了才说一句」
let bxWhyLogged = null;
function discoverAgents() {
  for (const name of KNOWN_AGENTS) {
    const cur = agentConfs.get(name);
    if (cur) {
      const owner = cur.source === 'auto' ? dirTaken(cur, name) : null;
      if (cur.source === 'auto' && (!confAvailable(cur) || owner)) {
        purgeAgent(name);
        agentConfs.delete(name);
        saveConfig();
        agentNotices.push({ removed: name });
        log('[discover] removed (' + (owner ? 'dir owned by ' + owner : 'dir gone') + '):', name);
        continue;
      }
      // source:auto 的 kind 可能因解析器升级而过时（如 codex 早期被当成 atomcode），重新嗅探自愈
      if (cur.source === 'auto' && cur.sessions) {
        // ⚠️ 先处理「被抢」这一种：cur 指向的那份 sessions 同时被**另一个 agent** 声称。
        // 本机真实事故：mimocode 的 kind 被改写成 opencode、sessions 被改成 opencode.db，
        // 于是两个 agent 的 sessions 完全相同 —— 而 dirTaken 是**对称**判据，两边互指对方是 owner，
        // 谁先被判谁先被删（opencode 排在 KNOWN_AGENTS 前面，于是被删的是 opencode），
        // 剩下 mimocode 顶着 opencode 的 kind 跑 → 恒 0 条，且**永远不会自愈**。
        // 所以这里不能只做「爬一层重嗅探」：必须回到**本 agent 自己的候选路径**上重新推导。
        const poachedBy = dirTaken(cur, name);
        if (poachedBy) {
          const own = ownConfFor(name);
          if (own) {
            const old = cur.kind + ' @ ' + cur.sessions;
            cur.kind = own.kind; cur.sessions = own.sessions; cur.traces = own.traces;
            purgeAgent(name);
            saveConfig();
            log('[discover] reclaimed:', name, old, '->', own.kind, own.sessions, '(曾被 ' + poachedBy + ' 占用)');
          } else {
            // 自己的候选路径一个都认不出来，那这份 sessions 确实该归对方 —— 原样让位
            purgeAgent(name);
            agentConfs.delete(name);
            saveConfig();
            agentNotices.push({ removed: name });
            log('[discover] removed (dir owned by ' + poachedBy + '):', name);
          }
          continue;
        }
        // copilot / minimax / mimocode / openclaw 的 sessions 本身就是「根目录」（copilot=session-state、
        // minimax=v2/sessions、mimocode=应用根、openclaw=stateDir），dirname 会爬到更上层导致重新嗅探认错：
        //   ⚠️ mimocode 踩过一次真实事故 —— 它的应用根是 ~/.local/share/mimocode，dirname 爬到
        //   ~/.local/share，而 opencode 的相对候选里正好有 `share/opencode/opencode.db`，
        //   于是 kind 被改写成 opencode（上半段 reclaimed 分支负责把它救回来）。
        //   ⚠️ 这里按 **name** 判断而不是按 cur.kind：cur.kind 正是可能被改坏的那个字段
        //   （mimocode 顶着 opencode 时按 kind 判断会走 dirname 分支，等于又嗅一遍 opencode）。
        const base = ROOT_SESSIONS_AGENTS.has(name) ? cur.sessions : path.dirname(cur.sessions);
        const re = sniffBase(base);
        if (re && !dirTaken(re, name) && (re.kind !== cur.kind || re.sessions !== cur.sessions)) {
          const old = cur.kind;
          cur.kind = re.kind; cur.sessions = re.sessions; cur.traces = re.traces;
          purgeAgent(name);
          saveConfig();
          log('[discover] kind updated:', name, old + ' -> ' + re.kind);
        } else {
          // 上面那条从**当前 sessions** 出发，sessions 本身被改坏时它只会再认一次对方。
          // 兜底：回到本 agent 自己的候选路径重新推导（跳过被别的 agent 占着的），
          // 认出来跟现状不同就采纳 —— 这是「mimocode 顶着 opencode.db」能自愈的关键一步。
          const own = ownConfFor(name);
          if (own && (own.kind !== cur.kind || own.sessions !== cur.sessions)) {
            const old = cur.kind + ' @ ' + cur.sessions;
            cur.kind = own.kind; cur.sessions = own.sessions; cur.traces = own.traces;
            purgeAgent(name);
            saveConfig();
            log('[discover] kind updated:', name, old, '->', own.kind, own.sessions);
          }
        }
      }
      continue;
    }
    for (const base of candidateBases(name)) {
      const conf = sniffBase(base);
      if (!conf) continue;
      const owner = dirTaken(conf, name);
      if (owner) { log('[discover] skip', name, '(dir already served by', owner + ')'); break; }
      agentConfs.set(name, { ...conf, builtin: false, enabled: true, source: 'auto' });
      saveConfig();
      agentNotices.push({ added: name });
      log('[discover] found:', name, '->', conf.kind, conf.sessions || conf.traces);
      break;
    }
  }
  // kimi 的桌面版根要单独处理两件事 —— 它**不在 candidateBases 里**（得先读桌面版的
  // daimon-storage.json 才知道数据根在哪），所以上面那个候选循环碰不到它：
  //   (a) 机器上**只有桌面版**、没装 kimi-code CLI 时必须靠这里注册
  //       —— 否则「装了桌面版却一条都看不到」，正是需求书要避免的那种静默；
  //   (b) 两者都有时，把桌面版那份挂成额外根。
  // 两者都每轮**重算**：桌面版卸载了、或用户把数据根挪到别的盘，死路径会自己掉出去。
  const kimiRoots = () => kimiDesktopSessionsRoots().filter(r => !dirTaken({ sessions: r, traces: null }, 'kimi'));
  const kimi = agentConfs.get('kimi');
  if (!kimi) {
    const roots = kimiRoots();
    if (roots.length) {
      agentConfs.set('kimi', {
        kind: 'kimi', sessions: roots[0], sessionsExtra: roots.slice(1), traces: null,
        builtin: false, enabled: true, source: 'auto',
      });
      saveConfig();
      agentNotices.push({ added: 'kimi' });
      log('[discover] found (desktop): kimi ->', roots.join('  |  '));
    }
  } else {
    const extra = kimiRoots().filter(r => r !== kimi.sessions);
    if ((kimi.sessionsExtra || []).join('\n') !== extra.join('\n')) {
      // 根集合变了就整份重扫：否则旧根的条目会一直留着（evictIfNeeded 只管 LRU 上限，不清死路径）
      purgeAgent('kimi');
      kimi.sessionsExtra = extra;
      saveConfig();
      log('[discover] kimi roots:', [kimi.sessions, ...extra].join('  |  '));
    }
  }
  // codebuddy 的**第二份落盘**：genie 扩展（VSCode 插件 / JetBrains 插件 / CodeBuddy CN 应用内部共用同一个）
  // 把会话写到 %LOCALAPPDATA%\CodeBuddyExtension\Data，既不在 ~/.codebuddy（那是 CLI），也不在
  // %APPDATA%\CodeBuddy CN（那只是 IDE 壳的 Electron 缓存 + state.vscdb，**没有会话正文**）。
  // 上一版把它注册成了独立一行 codebuddy-ext —— 用户反馈那在他们心智里就是同一个 CodeBuddy，
  // 拆两行会把同一个项目的历史劈成两半（按 agent 筛就漏一边），所以合到一个 agent 名下：
  //   主根 buddyjsonl（CLI） + 额外根 buddyext（扩展），两个 kind 各自解析、条目同一个 agent。
  // ⚠️ 与 trae 那种「两个源覆盖同一批会话」不同，这里两份是**互不重叠的会话**（CLI 用 uuid v7、
  //   扩展用 md5 串，会话 id 形状都不一样），所以不需要 purgeTraeOtherSide 那样的去重。
  // 每轮重算：扩展卸载了 / 数据根被挪走，死路径自己掉出去。
  const bxAll = buddyExtDataRoots();
  const bxRoots = bxAll.filter(r => !dirTaken({ sessions: r, traces: null }, 'codebuddy'));
  const cb = agentConfs.get('codebuddy');
  if (cb && (cb.sessionsExtra || []).join('\n') !== bxRoots.join('\n')) {
    purgeAgent('codebuddy');
    cb.sessionsExtra = bxRoots;
    saveConfig();
  }
  // 「扩展根没挂上」原来在日志里只有一句「这台机器上没有」，等于什么都没说 —— 成因有四种（没装扩展 /
  // 没有 Data/ / <host> 名不认得 / 没有 history/，明细见 buddyExtWhyMissing）。每轮都算一次，
  // 但只在结论变了时打一行：roots 为空是稳态，不能每轮刷。
  const bxWhy = bxRoots.length ? bxRoots.join('  |  ')
    : '（没有：' + (bxAll.length ? '候选根已被别的 agent 占了' : (buddyExtMissingWhy() || '未知原因')) + '）';
  if (bxWhy !== bxWhyLogged) { bxWhyLogged = bxWhy; log('[discover] codebuddy 扩展根:', bxWhy); }
}

// 给「没认出来」的路径配一句**原因**。
//
// 为什么必须配：手动添加失败时，原来只回一串路径，而**光看路径什么都判断不出来** ——
// 是目录压根不存在？还是目录在、只是里面不是我们认识的结构？这两种情况的下一步动作完全不同
// （前者让用户确认路径，后者要去看目录里到底是什么），但提示长得一模一样，只能来回猜。
// 措辞与 diagnose() 里那份保持一致（同一套判断，别两处各写一句不一样的话）。
function sniffWhyNot(base, conf) {
  if (conf) return '识别为 ' + conf.kind;                 // 正常走不到（认出来就不会问原因）
  if (!isDir(base)) return '目录不存在';
  try { const h = dirHint(base); return '目录在，但没认出已知结构' + (h ? '：' + h : ''); }
  catch { return '目录在，但没认出已知结构'; }
}

// 同一个根被两个 agent 扫，**不是「多一份数据」而是「抢一份数据」**：条目 id 只由「文件路径 + 轮」
// 决定（不含 agent 名），所以后加入的那条扫描会把已有条目的 agent 标签整个改写成自己的名字，
// 原先那行反而变成 0 条 —— 谁后扫谁赢，页面上一会儿一边有一会儿一边没。
// 自动发现那条路早就有 dirTaken 拦着；手动添加这条路以前**没拦**，于是「CodeBuddy 看不到吗？
// 那我把 %LOCALAPPDATA%\CodeBuddyExtension 手填一遍」这种完全正常的自救动作会静默把 codebuddy
// （它的额外根正是这里）的行掏空。并源之后这种撞法变常见，所以在这里挡住。
// ⚠️ 这里**不用** dirTaken 的「根相等」判据，而是管到**包含关系**：手填某一条会话的目录时
//   根字符串和自动项不相等（比如 cline 的 <sessions>/<会话 id>），但那目录底下扫的还是同一批文件、
//   算出来的还是同一批 id —— 相等判据放它过去，就照样偷。只给 addAgent 用这一份强判据：
//   自动发现那边不动（kimi / codebuddy 自己就有多根，改成包含判据会把合法的并列根当成冲突剔掉）。
function rootOverlap(name, conf) {
  const norm = p => (p ? (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)) : '');
  const a = norm(conf.sessions);
  if (!a) return null;
  const inside = (x, y) => x === y || x.startsWith(y + path.sep);
  for (const [n, c] of agentConfs) {
    if (n === name) continue;
    for (const rp of rootsOf(c)) {
      const b = norm(rp);
      if (!b) continue;
      if (inside(a, b) || inside(b, a)) return n;
    }
    const t = norm(c.traces), ct = norm(conf.traces);
    if (t && ct && (inside(ct, t) || inside(t, ct))) return n;
  }
  return null;
}

function dupRootError(name, conf) {
  const owner = rootOverlap(name, conf);
  if (!owner) return null;
  return {
    ok: false, ownedBy: owner, kind: conf.kind, sessions: conf.sessions,
    error: '这个目录（或它底下的某一层）已经由 agent「' + owner + '」在扫了，不能再加一遍 —— 条目是按「文件路径 + 轮」寻址的、' +
      '不认 agent 名，再加一条只会把那批条目的归属抢到新车名底下，「' + owner + '」那一行反而变空。' +
      '要看这一份数据请直接找「' + owner + '」；想分开看就在页面里按项目/会话筛，' +
      '或者指一个**真正不同**的目录（比如另一台机器/另一个盘上的另一批日志）。',
  };
}

function addAgent(rawName, manualPath) {
  const name = String(rawName || '').trim().toLowerCase();
  if (!/^[\w][\w-]{0,31}$/.test(name)) return { ok: false, error: '名称需为 1-32 位字母/数字/下划线/中划线' };
  if (agentConfs.has(name)) return { ok: false, error: '已存在同名 agent' };
  if (manualPath) {
    const p = String(manualPath).trim();
    if (p.startsWith('\\\\') || p.startsWith('//')) return { ok: false, error: '不支持网络盘 / UNC 路径' };
    const abs = path.resolve(p);
    const conf = sniffBase(abs);
    if (!conf) {
      return {
        ok: false,
        error: '指定路径下未识别到日志结构 —— 原因见下面这行（该目录可以是 agent 根目录，也可以是 sessions / projects 目录本身）',
        tried: [p + ' —— ' + sniffWhyNot(abs, null)],
      };
    }
    const dup = dupRootError(name, conf);
    if (dup) return dup;
    agentConfs.set(name, { ...conf, builtin: false, enabled: true, source: 'manual' });
    return { ok: true, name, ...conf, source: abs };
  }
  const tried = [];
  for (const base of candidateBases(name)) {
    const conf = sniffBase(base);
    if (conf) {
      const dup = dupRootError(name, conf);
      if (dup) return dup;
      agentConfs.set(name, { ...conf, builtin: false, enabled: true, source: 'manual' });
      return { ok: true, name, ...conf, source: base };
    }
    tried.push(base + ' —— ' + sniffWhyNot(base, null));
  }
  return { ok: false, error: '未找到该 agent 的日志目录。下面是逐个试过的路径与各自的原因' + (manualPath ? '' : '（也可以直接在「日志路径」里手动指一个）'), tried };
}

// 清除某 agent 的全部内存状态（files/entries/srcs/pidCwd），并排队 SSE remove 事件
function purgeAgent(name) {
  for (const [p, f] of files) if (f.agent === name) files.delete(p);
  for (const [id, e] of entries) if (e.agent === name) { entries.delete(id); srcs.delete(id); removedIds.push(id); }
  for (const k of [...pidCwd.keys()]) if (k.startsWith(name + '|')) pidCwd.delete(k);
  sorted.cache = null;
}

function removeAgent(name) {
  const conf = agentConfs.get(name);
  if (!conf) return { ok: false, error: '不存在该 agent' };
  // 预置项同样可删：v2 配置是用户意图的完整快照，删掉后 loadConfig 不会再把它塞回来
  purgeAgent(name);
  agentConfs.delete(name);
  saveConfig();
  return { ok: true };
}

function toggleAgent(name, enabled) {
  const conf = agentConfs.get(name);
  if (!conf) return { ok: false, error: '不存在该 agent' };
  enabled = !!enabled;
  if ((conf.enabled !== false) === enabled) return { ok: true, enabled };
  conf.enabled = enabled;
  if (!enabled) purgeAgent(name);
  saveConfig();
  return { ok: true, enabled };
}

// ---------------- index 持久化（按 kind 分片，仅 OFF_KINDS） ----------------
function loadIndex() {
  let n = 0;
  const restore = (arr, rev) => {
    for (const [p, f] of arr || []) {
      if (!OFF_KINDS.has(f.kind)) continue;
      // 解析器改过口径的 kind：老 rev 的 state 直接丢弃（让它重扫），否则恢复出来的是旧口径条目。
      // kind 级编号查的是「共用解析器代码」，对所有 OFF_KINDS 一视同仁，包括 generic-jsonl；
      // generic-jsonl 另外还要按 agent 比对 rulesRev/rulesHash（rules 口径），两道都不过关才恢复。
      const need = PARSER_REV[f.kind];
      if (need != null && rev !== need) continue;
      if (f.kind === 'generic-jsonl') {
        const gc = agentConfs.get(f.agent);
        if (!gc || gc.kind !== 'generic-jsonl') continue;
        if (f.rr !== gc.rulesRev || f.rh !== gc.rulesHash) continue;
      }
      // 恢复前校验 mtime/size 与磁盘一致，不一致丢弃让其重扫
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs !== f.m || st.size !== f.s) continue;
      if ((f.kind === 'claude' || f.kind === 'buddyjsonl') && f.data?.turns) for (const t of f.data.turns) if (t.mids && !Array.isArray(t.mids)) t.mids = [];
      files.set(p, f); n++;
    }
  };
  // 旧版单文件迁移：agent-log-index.json (v2)
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'agent-log-index.json'), 'utf8'));
    if (legacy.v === 2) { restore(legacy.files); kindDirty.add('jsonl'); kindDirty.add('claude'); kindDirty.add('buddyjsonl'); kindDirty.add('codearts'); }
    // 改名是写盘：只读库模式照样**读**这份旧索引（不读就少一半数据），但不替常驻服务改名
    if (MODE !== 'lib') {
      fs.renameSync(path.join(DATA_DIR, 'agent-log-index.json'), path.join(DATA_DIR, 'agent-log-index.json.bak'));
      log('[index] migrated legacy single-file index');
    }
  } catch {}
  if (MODE === 'lib' && kindDirty.size) kindDirty.clear();   // 只读进程不去补这次迁移，别把脏标记留着让人以为有东西要写

  try {
    for (const fn of fs.readdirSync(INDEX_DIR)) {
      if (!fn.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, fn), 'utf8'));
        restore(j.files, j.rev);
      } catch {}
    }
  } catch {}
  if (n) log('[index] loaded', n, 'states');
}
let saveTimer = null;
function scheduleSave() { if (!saveTimer) saveTimer = after(5000, () => { saveTimer = null; saveIndex(); }); }
function saveIndex() {
  if (MODE === 'lib') return;   // 只读库模式：索引分片只有常驻服务那一份写者（见 setSaveHook 与 saveConfig 同一条理由）
  if (!kindDirty.size) return;
  try {
    // POSIX 权限（R34）：索引分片里带着条目的元信息与文件路径，是内部状态、没有共享的用法，
    // 所以按私有建（目录 0700 / 文件 0600；win32 上 mode 无副作用）。只对新文件生效，
    // 老分片保持原样 —— 要收紧就 chmod -R go-rwx ~/.agent-acta（与 search.mjs / archive.mjs 同一套）。
    const posix = process.platform !== 'win32';
    const mkOpts = { recursive: true };
    if (posix) mkOpts.mode = 0o700;
    fs.mkdirSync(INDEX_DIR, mkOpts);
    for (const kind of kindDirty) {
      const arr = [...files.entries()].filter(([, f]) => f.kind === kind);
      const fp = path.join(INDEX_DIR, kind + '.json');
      fs.writeFileSync(fp + '.tmp', JSON.stringify({ v: 2, rev: PARSER_REV[kind], files: arr }), posix ? { mode: 0o600 } : undefined);
      fs.renameSync(fp + '.tmp', fp);
    }
    kindDirty.clear();
  } catch (e) { console.error('[index] save failed', e.message); }
}

// 解析器统一走 shared 的 markKind（shared 里 no-op），这里把「该落盘了」接回本文件的调度：
// 只读库模式挂空函数：markKind 照常往 kindDirty 里记（内存口径不变），但没人去落盘。
// **装配点在下面 assemble()**（Step 2 把 setSaveHook / initArchive / initSearch 三处合成一个入口）：
// 它按 MODE 定 readOnly 与写钩子，且 start() 切 mode 之后还要再装一遍。这里只剩一句说明，
// 免得有人以为「解析器一 import 就接上了落盘」—— 装配发生在模块加载的末尾，早于任何扫描。
// trace 解析器需要读 agentConfs 拿 sessions 目录（resolveCwd）
setAgentConfs(agentConfs);

// ---------------- scan loop ----------------
// 并发闸门：同步时代「一次 scanAll 跑到底」天然互斥；首扫分片让出事件循环之后，
// 定时扫描 / 手动刷新 / 增删 agent 随时可能插进半路，两个扫描同时写同一份 entries Map。
// 忙的时候分两种处理：
//   queueIfBusy=true（手动刷新 / 增删 agent）：记一个补扫，扫完再补一轮 —— 这类请求必须真的扫到，
//     暂停定时扫描时更是唯一一次机会；
//   queueIfBusy=false（定时轮）：直接跳过 —— 它自己会再排下一次，此刻补一轮纯属浪费。
let scanning = false;
let rescanQueued = false;
const yieldToLoop = () => new Promise(r => setImmediate(r));

function scanAll(queueIfBusy) {
  if (scanning) { if (queueIfBusy) rescanQueued = true; return; }
  scanning = true;
  try { scanAllSync(); } finally { scanning = false; }
}

function scanAllSync() {
  try {
    // qoder 模型名映射增量刷新（只读新出现的 runs 目录）：服务启动后用户换的新模型不用重启就对上名
    loadModelDisplayMap(QODER_RUNS_DIR);
    discoverAgents();
    for (const [agent, conf] of agentConfs) scanOneAgent(agent, conf);
    evictIfNeeded();
    broadcast();
  } catch (e) { console.error('[scan]', e.message); }
}

// 禁用 / 目录消失：两种情况都直接跳过（manual/builtin 目录消失标 missing 保留；source:auto 的已在 discoverAgents 摘除）
function agentScannable(conf) {
  if (conf.enabled === false) return false;
  conf.missing = !confAvailable(conf);
  return !conf.missing;
}

// 「这个 agent 该走哪条扫描分支」集中成一处：scanOneAgent 与分片版各写一份 if/else 迟早走偏
function scanBranch(conf) {
  switch (conf.kind) {
    case 'trace': return { kind: 'trace', list: conf.traces };
    case 'codearts': return { kind: 'codearts', list: conf.sessions };
    case 'claude': return { kind: 'claude', list: conf.sessions };
    // doubao（豆包 Work 智能体）：list = .sessions 根，解析器内部枚举 <会话>/agents/<agent>/system/trajectory.jsonl
    case 'doubao': return { kind: 'doubao', list: conf.sessions };
    // minimax（Mavis 本地运行时）：list = v2/sessions 根，解析器内部按 y/m/d/session_<id> 四层下探
    case 'minimax': return { kind: 'minimax', list: conf.sessions };
    // openclaw（OpenClaw）：list = stateDir（默认 ~/.openclaw），解析器内部枚举 agents/<id>/sessions/*.jsonl
    case 'openclaw': return { kind: 'openclaw', list: conf.sessions };
    case 'generic-jsonl': return { kind: 'generic-jsonl', list: conf.sessions };
    case 'buddyjsonl': return { kind: 'buddyjsonl', list: conf.sessions };
    case 'codex': return { kind: 'codex', list: conf.sessions };
    case 'gemini': return { kind: 'gemini', list: conf.sessions };
    case 'cursor': return { kind: 'cursor', list: conf.sessions };
    case 'dsh': return { kind: 'dsh', list: conf.sessions };
    case 'copilot': return { kind: 'copilot', list: conf.sessions };
    case 'zcode': return { kind: 'zcode', list: conf.sessions }; // list = db.sqlite 文件路径（不是目录）
    case 'opencode': return { kind: 'opencode', list: conf.sessions }; // list = opencode.db 文件路径（不是目录）
    case 'kilo': return { kind: 'kilo', list: conf.sessions }; // list = kilo.db 文件路径（不是目录）
    case 'hermes': return { kind: 'hermes', list: conf.sessions }; // list = state.db 文件路径（不是目录）
    case 'devindb': return { kind: 'devindb', list: conf.sessions }; // list = sessions.db 文件路径（不是目录）
    case 'traedb': return { kind: 'traedb', list: conf.sessions }; // list = database.db 文件路径（不是目录）
    // list 只用来判「有没有根可扫」；真正的遍历在 scanOneAgent 里按 rootsOf(conf) 逐个走
    case 'kimi': return { kind: 'kimi', list: rootsOf(conf)[0] || null };
    // comate（百度 Comate）：list = ~/.comate-engine/store 根，解析器内部枚举平铺的 chat_session_* 文件
    case 'comate': return { kind: 'comate', list: conf.sessions };
    // cline（Cline CLI）：list = <data>/sessions 根，解析器内部枚举 <会话 id>/<会话 id>.messages.json
    case 'cline': return { kind: 'cline', list: conf.sessions };
    // buddyext（CodeBuddy 扩展版）：list = <Data> 根，解析器内部枚举
    // <acct>/<Host>/(<acct>/)?history/<wsKey>/<会话 id>/index.json（两种账号形状都在内部处理）
    case 'buddyext': return { kind: 'buddyext', list: conf.sessions };
    // tracecode / tracework：sessions 存的是 logs 目录（不是 sessions 子目录），
    // 解析器内部枚举 <timestamp>/window1/renderer.log
    case 'tracecode': return { kind: 'tracecode', list: conf.sessions };
    case 'tracework': return { kind: 'tracework', list: conf.sessions };
    // mimocode（记忆/检查点类 agent）：list = memory 根目录，解析器内部枚举 sessions/<id> 与 projects/<pid>/MEMORY.md
    case 'mimocode': return { kind: 'mimocode', list: conf.sessions };
    default: return { kind: 'atomcode', list: conf.sessions }; // 未分类 kind = 原子码式「hash 会话目录」
  }
}

// Trae 的两个数据源（SQLCipher 库 / renderer.log）覆盖同一批会话，同时上线就是每轮两张重复卡片，
// 所以任何时刻只保留一边的条目：扫完当前这一边后，把这个 agent 名下**另一边的**条目清掉。
// 必须按 entries 里的实际存在清，不能只看内存 files —— tracecode 在 OFF_KINDS 里，它的文件状态
// 会从 index 恢复，光看内存会漏掉「上一版进程留下的条目」。
function purgeTraeOtherSide(agent, keepKind) {
  for (const [id, e] of entries) {
    if (e.agent !== agent) continue;
    const k = srcs.get(id)?.kind;
    if ((k === 'traedb' || k === 'tracecode' || k === 'tracework') && k !== keepKind) {
      entries.delete(id); srcs.delete(id); removedIds.push(id);
    }
  }
  sorted.cache = null;
}

// traedb 的取数编排：库优先，读不出来回退 renderer.log（同一个 agent 名下接着用，不另起 agent）。
//   库能读（ok / empty）→ 用库，清掉日志那边的旧条目；
//   库读不出来（nokey / fail）→ 回退日志（kind 与 logs 目录都由 db 路径反推），清掉库这边的旧条目。
// 为什么回退而不是只报错：没配密钥的人升级后看到的应与从前一样（renderer.log 那套），而不是一片空白；
// 加密参数变了/库暂时被写坏时也是同理 —— 有骨架看总好过没有，诊断页同时写着原因（traeDbErr）。
// codebuddy 的第二份落盘（genie 扩展，kind buddyext）—— 见 discoverAgents 里的并源注释。
// 它**不参与按文件分片**：那是「一会话一份整份重写的 index.json」，冷扫实测 0.65s、热扫 ~10ms，
// 切了只是白添调用（与 cline 同一个判断）。所以：
//   · 同步扫描（定时/手动补扫）在 buddyjsonl 分支里顺带扫一次；
//   · 首扫分片只切主根，切完再补这一趟。
function scanBuddyExtExtras(agent, conf) {
  for (const r of (conf.sessionsExtra || []).filter(x => x && x !== conf.sessions)) scanBuddyExt(agent, r, null);
}

function scanTraeAgent(agent, conf, onlyFile) {
  const r = scanTraeDb(agent, conf.sessions, conf.traeKey);
  if (r === 'ok' || r === 'empty') { purgeTraeOtherSide(agent, 'traedb'); return; }
  const logKind = traeLogKindOf(conf.sessions);
  const logs = traeLogsFromDb(conf.sessions);
  if (!logs) return;   // 库读不出来、日志也没有：交给诊断页说原因，这里没有别的可做
  if (logKind === 'tracework') scanTraework(agent, logs, onlyFile);
  else scanTraecode(agent, logs, onlyFile);
  purgeTraeOtherSide(agent, logKind);
}

function scanOneAgent(agent, conf, onlyFile) {
  try {
    if (!agentScannable(conf)) return;
    const b = scanBranch(conf);
    if (!b.list) return;
    if (b.kind === 'trace') scanTraces(agent, b.list);
    else if (b.kind === 'codearts') scanCodearts(agent, b.list, onlyFile);
    else if (b.kind === 'claude') scanClaude(agent, b.list, onlyFile);
    // doubao（豆包 Work 智能体）：trajectory.jsonl 逐行 off 增量，轮时间与 assignment.md 对齐
    else if (b.kind === 'doubao') scanDoubao(agent, b.list, onlyFile);
    // generic-jsonl（R18）：声明式接入的 claude 同族逐行 jsonl，rules/sniff 全在 conf 上
    else if (b.kind === 'generic-jsonl') scanGeneric(agent, conf, b.list, onlyFile);
    else if (b.kind === 'buddyjsonl') { scanBuddy(agent, b.list, onlyFile); if (!onlyFile) scanBuddyExtExtras(agent, conf); }
    else if (b.kind === 'codex') scanCodex(agent, b.list);
    else if (b.kind === 'gemini') scanGemini(agent, b.list);
    else if (b.kind === 'cursor') scanCursor(agent, b.list);
    else if (b.kind === 'dsh') scanDsh(agent, b.list);
    // Copilot：正文在 session-state/*/events.jsonl，用量由同根 session-store.db 补齐；ide/*.lock 不是会话正文。
    else if (b.kind === 'copilot') scanCopilot(agent, b.list);
    else if (b.kind === 'zcode') scanZcode(agent, b.list);
    // OpenCode：会话全在一个明文 SQLite 库里（不需要解密），按 db+wal 签名整库只读重读
    else if (b.kind === 'opencode') scanOpencode(agent, b.list);
    // KiloCode（Kilo CLI）：opencode 的 fork，库同构（kilo.db + -wal、同样的 message.data.tokens 口径），
    // 复用 opencode 的扫描核心（parsers/kilo.mjs 薄壳）
    else if (b.kind === 'kilo') scanKilo(agent, b.list);
    // hermes（Hermes Agent）：会话全在 state.db（明文 SQLite），逐次用量在旁路 agent.log（见 parsers/hermes.mjs）
    else if (b.kind === 'hermes') scanHermes(agent, b.list);
    // devin（Devin CLI）：会话全在 sessions.db（明文 SQLite + WAL），消息是 node_id/parent_node_id
    // 连成的森林 —— 只沿 main_chain_id 回溯主线，逐次 token/工具明细都在库里（见 parsers/devindb.mjs）
    else if (b.kind === 'devindb') scanDevinDb(agent, b.list);
    // minimax（Mavis 本地运行时）：v2/sessions/YYYY/MM/DD/<session-id>/messages.jsonl，逐行 off 增量
    // 续读；usage/model/stopReason 都在消息行内、不必依赖旁路日志（见 parsers/minimax.mjs）。
    else if (b.kind === 'minimax') scanMavis(agent, b.list);
    // openclaw（OpenClaw）：<stateDir>/agents/<id>/sessions/<uuid>.jsonl，追加式会话树，逐行 off 增量续读；
    // token/模型在 assistant 消息行的 usage 里（input **不含** cache），不必依赖旁路日志（见 parsers/openclaw.mjs）。
    else if (b.kind === 'openclaw') scanOpenclaw(agent, b.list, onlyFile);
    // traedb：库优先 + 读不出来回退 renderer.log（两边的取舍见 scanTraeAgent）
    else if (b.kind === 'traedb') scanTraeAgent(agent, conf, onlyFile);
    // kimi 可能有多个根（CLI 的 ~/.kimi-code + 桌面版的 runtime/kimi-code/home），逐个扫
    else if (b.kind === 'kimi') for (const root of rootsOf(conf)) scanKimi(agent, root);
    // comate（百度 Comate）：chat_session_<uuid> 整份 JSON 原地重写，整份重解析 + 签名跳过（见 parsers/comate.mjs）
    else if (b.kind === 'comate') scanComate(agent, b.list);
    // cline（Cline CLI）：<data>/sessions/<会话 id>/<会话 id>.messages.json 是**整份 JSON、每次落盘整体重写**，
    // 按 {mtime,size} 签名整份重解析（不进 OFF_KINDS）；逐次用量在每条 assistant 的 metrics 里，
    // 且 inputTokens **含**缓存（与 openclaw 相反，见 parsers/cline.mjs 头）
    else if (b.kind === 'cline') scanCline(agent, b.list, onlyFile);
    // buddyext（CodeBuddy 扩展版）：每会话一份 index.json **整份重写**（不进 OFF_KINDS）+
    // messages/<消息 id>.json 逐条正文；增量靠「会话 index 签名变了才重算聚合 + 逐条消息 {mtime,size}
    // 投影缓存」两层，轮 = requests[] 的一项，token 的 inputTokens **含**缓存（见 parsers/buddyext.mjs 头）
    else if (b.kind === 'buddyext') scanBuddyExt(agent, b.list, onlyFile);
    // tracecode / tracework：sessions 是 logs 根目录，解析器内部枚举 <timestamp>/window1/renderer.log
    else if (b.kind === 'tracecode') scanTraecode(agent, b.list, onlyFile);
    else if (b.kind === 'tracework') scanTraework(agent, b.list, onlyFile);
    else if (b.kind === 'mimocode') scanMimocode(agent, b.list);
    else for (const dir of atomcodeDirs(b.list)) {
      const names = listDirCached(dir);
      if (!names) continue;
      scanAtomcodeDir(agent, names, dir);
    }
  } catch (e) { console.error('[' + agent + ']', e.message); }
}

// 分片粒度：这三个 kind 在真实数据上一整段就有 0.7~1.3s（本机实测 claude 1.16s / buddyjsonl 1.02s /
// codearts 0.70s），而它们慢的原因都是「一个目录里堆了几十个上百个会话文件」
// （.claude/projects 里一个项目 86 个、.codebuddy/projects 里一个项目 100 个、codearts 20 个 .log 共 69MB），
// 所以按目录切还不够，要切到**单个文件**。其余 kind 一段几十 ms，切了只是白添调用，整段同步扫完。
const SLICE_BY_FILE = new Set(['claude', 'buddyjsonl', 'codearts']);

// 切片清单 = 这些 kind 下面要挨个扫的文件。非目标文件也列进去无所谓：
// 扫描器自己会按扩展名/正则跳过，多出来的是一次几十微秒的空调用。
// ⚠️ I16：claude 除了 <slug>/*.jsonl，还要列 **<slug>/<会话>/subagents/*.jsonl** —— 子 agent 转录
//    是「按会话目录再下一层」摆的，只列第一层的话首扫分片会把它们整批漏掉（同步扫描没这问题，
//    但首扫走的是分片路径，漏了就是「冷启动看不到子 agent、等下一轮补扫才冒出来」）。多列一层带来的
//    额外开销是「非会话目录也去 statSync 一个不存在的 subagents/」——listDirCached 对不存在的目录
//    直接返回 null（一次必然失败的 statSync），本机 9 个 slug ≈ 98 次，可忽略。
function sliceFiles(kind, root) {
  const out = [];
  if (kind === 'codearts') {
    for (const n of listDirCached(root) || []) out.push(path.join(root, n));
    return out;
  }
  for (const slug of listDirCached(root) || []) {
    const dir = path.join(root, slug);
    for (const n of listDirCached(dir) || []) {
      out.push(path.join(dir, n));
      // I16：会话子目录里的 subagents/*.jsonl（claude 才有这一层；别的目录下探不到就跳过）
      const subDir = path.join(dir, n, 'subagents');
      for (const sn of listDirCached(subDir) || []) out.push(path.join(subDir, sn));
    }
  }
  return out;
}

// 原子码的切片：一个 hash 目录里可能堆着几千个会话文件（本机实测 2200 个，单这一坨就 ~0.6s），
// 按目录切不够，要按「同一目录下的一批会话」再切。
// 关键约束：一个会话的 .jsonl 和 .meta 必须落在同一批 —— scanAtomcodeDir 用同批的 jsonls
// 给 meta 补轮次时间戳/预览，拆开首扫就会全变成无预览条目（且下次 meta 没变不再重扫，不会自愈）。
// 所以按「去掉扩展名后的会话名」分组，再按组切批，而不是直接切文件列表。
function atomcodeBatches(names, size) {
  const groups = new Map(); // 会话名 -> 它的文件（.jsonl + .meta）
  for (const n of names) {
    const base = n.replace(/\.(jsonl|meta)$/, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(n);
  }
  const out = [];
  let cur = [];
  for (const files of groups.values()) {
    for (const f of files) cur.push(f);
    if (cur.length >= size) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// 让出的粒度按**时间预算**而不是「每个单位让一次」。
// 本机实测：Windows 上单次 setImmediate 往返约 1.5ms，按文件让（几百次）会凭空多花 ~0.4s，
// 热启动的整轮重扫从 554ms 涨到 943ms —— 页面就得在「扫描中」多待半秒。
// 改成「攒够 ~40ms 才让一次」：最坏请求延迟仍被压在几十 ms，让出次数降到个位数。
const SLICE_BUDGET_MS = 40;
function makeSlicer() {
  let deadline = Date.now() + SLICE_BUDGET_MS;
  return async function tick() {
    if (Date.now() < deadline) return;
    await yieldToLoop();
    deadline = Date.now() + SLICE_BUDGET_MS;
  };
}

// 首扫专用：单个 agent 的分片扫描。原子码按「一批会话文件」拆，claude/buddy/codearts 按单个会话文件拆，
// 其余 kind 单个体量小，直接交给同步版 —— 免得把简单路径也改成 async 引新 bug。
async function scanAgentChunked(agent, conf) {
  if (!agentScannable(conf)) return;
  const b = scanBranch(conf);
  if (!b.list) return;
  const tick = makeSlicer();
  if (b.kind === 'atomcode') {
    for (const dir of atomcodeDirs(b.list)) {
      const names = listDirCached(dir);
      if (!names) continue;
      for (const batch of atomcodeBatches(names, 100)) {
        scanAtomcodeDir(agent, batch, dir);
        await tick();
      }
    }
    return;
  }
  if (!SLICE_BY_FILE.has(b.kind)) { scanOneAgent(agent, conf); return; }
  for (const fp of sliceFiles(b.kind, b.list)) {
    scanOneAgent(agent, conf, fp);
    await tick();
  }
  // buddyjsonl 的第二份落盘（genie 扩展）不切片，切完主根补一趟 —— 见 scanBuddyExtExtras
  if (b.kind === 'buddyjsonl' && (conf.sessionsExtra || []).length) { scanBuddyExtExtras(agent, conf); await tick(); }
}

// 首扫分片版：每扫完一个 agent 让出一次事件循环 —— 这是本任务的关键。
// 同步跑几秒会把事件循环占死，页面连不上（TCP backlog 里躺着）、进度事件发出去也没人收。
// 只有首扫走这里；定时/手动补扫仍走同步版（一轮就几十~几百 ms，拆开只会让「扫描中」每个周期闪一次）。
async function scanAllChunked() {
  if (scanning) { rescanQueued = true; return; }
  scanning = true;
  scanState = { done: 0, total: agentConfs.size, agent: '' };
  try {
    loadModelDisplayMap(QODER_RUNS_DIR);
    discoverAgents();
    scanState.total = agentConfs.size;
    scanEvent('start');
    let done = 0;
    for (const [agent, conf] of agentConfs) {
      scanState.agent = agent;
      scanEvent('progress');       // 即将扫谁（done 是「已完成」数）
      await yieldToLoop();         // 让出：页面能连上、旧索引数据能查、hook 的 ping 能应答
      await scanAgentChunked(agent, conf);
      scanState.done = ++done;
      scanState.agent = '';
      broadcast();                 // 每段扫完推一次 —— 数据逐步出现，不是等全部扫完才一起冒出来
      scanEvent('progress');
    }
    evictIfNeeded();
    broadcast();
  } catch (e) { console.error('[scan]', e.message); }
  finally {
    scanning = false;
    scanState = null;
    scanEvent('done');
    if (rescanQueued) { rescanQueued = false; scanAll(true); } // 首扫期间被挡下的补扫（增删 agent / 手动刷新）
  }
}

// 当前扫描进度（null = 没在扫）。挂给 /api/events 的 hello：页面中途连上时靠它拿到进度，
// 否则要等到下一个分段才有事件（冷启动第一段就是 ~1.5s）。
// 进度不是「脏条目」，不进 dirty —— broadcast() 在没客户端时会把 dirty 清空，所以直接写给当前连着的人。
let scanState = null;
function scanEvent(phase) {
  if (!sseClients.size) return;
  const msg = { type: 'scanning', seq: ++bseq, phase, done: scanState ? scanState.done : 0, total: scanState ? scanState.total : 0, agent: scanState ? scanState.agent : '' };
  for (const res of [...sseClients]) sseWrite(res, msg);
}

// entries LRU：超上限淘汰最旧，但每个 agent 至少保留最近 KEEP_MIN_PER_AGENT 条
function evictIfNeeded() {
  if (entries.size <= MAX_ENTRIES) return;
  const perAgent = {};
  for (const e of entries.values()) perAgent[e.agent] = (perAgent[e.agent] || 0) + 1;
  const asc = [...entries.values()].sort((a, b) => (a.time || 0) - (b.time || 0));
  const target = MAX_ENTRIES - EVICT_BATCH;
  for (const e of asc) {
    if (entries.size <= target) break;
    if ((perAgent[e.agent] || 0) <= KEEP_MIN_PER_AGENT) continue;
    entries.delete(e.id); srcs.delete(e.id); removedIds.push(e.id); perAgent[e.agent]--;
  }
  sorted.cache = null;
  log('[lru] evicted to', entries.size);
}


function entryContent(id, full) {
  const src = srcs.get(id);
  if (!src) return null;
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null; // 前端据此判断进行中轮是否需重取
  try {
    if (src.kind === 'atomcode') return atomcodeEntryContent(src, full, entries.get(id));
    if (src.kind === 'claude') return claudeEntryContent(src, full);
    // doubao（豆包 Work 智能体）：重读 trajectory.jsonl 按 src.turn 过滤，工具按 tool_call_id 回填
    if (src.kind === 'doubao') return doubaoEntryContent(src, full);
    // R18 generic-jsonl：声明式详情 —— 用同一套 rules 重读转录重建正文（工具输出回填不做，
    // 见 parsers/generic.mjs 的能力声明）。
    if (src.kind === 'generic-jsonl') {
      const e0 = entries.get(id);
      const conf = e0 ? agentConfs.get(e0.agent) : null;
      if (!conf || conf.kind !== 'generic-jsonl' || !conf.rules) {
        return { user: '', assistant: '', tools: [], calls: [], v: version, note: '该 agent 的声明式规则当前不可用（见环境诊断）' };
      }
      const out = genericEntryContent(src.file, src.turn, full, conf);
      out.v = version;
      return out;
    }
    if (src.kind === 'buddyjsonl') return buddyEntryContent(src, full);
    if (src.kind === 'codex') return codexEntryContent(src, full);
    if (src.kind === 'kimi') return kimiEntryContent(src, full);
    // comate（百度 Comate）：重读会话文件按 src.turn 切，扫描与详情同一份解析（见 parsers/comate.mjs）
    if (src.kind === 'comate') return comateEntryContent(src, full);
    // cline：整份 JSON 重读一遍、按 src.turn 切那一轮（开轮判据与扫描侧同一个函数，见 parsers/cline.mjs）
    if (src.kind === 'cline') return clineEntryContent(src, full);
    // buddyext：重读会话 index、按 src.turn 取那一轮，再只读那一轮引用的几十条消息文件
    // （轮的选择与扫描侧共用 buddyExtTurns，见 parsers/buddyext.mjs）
    if (src.kind === 'buddyext') return buddyExtEntryContent(src, full);
    if (src.kind === 'gemini') {
      // 扫描时已把整轮（用户文本 / 回复正文 / 工具 / 逐次调用）解析进内存：直接读，不重解析文件。
      // 扫描与详情共用同一份数据，天然不存在「快照与详情对不上」的口径问题。
      const st = files.get(src.file);
      const t = st?.data?.turns?.[src.turn];
      if (!t) return null;
      const tools = t.tools.map(x => {
        const fi = {}, fo = {};
        return {
          name: x.name, tid: x.tid, error: x.error,
          input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
          output: trunc(x.output, full, fo), outputTrunc: !!fo.t,
        };
      });
      // 逐次正文（callList[].text）在扫描时就存好了，这里只按同一套 800 字截断过一遍：
      // 缓存里的那份必须保持原文，否则 full=1 二次拉取拿到的还是截断过的（同 tools 的处理）
      const calls = t.callList.map(c => {
        if (!c.text) return c;
        const ft = {};
        const s = trunc(c.text, full, ft);
        return ft.t ? { ...c, text: s, textTrunc: true } : c;
      });
      return { user: t.user, assistant: t.assistant, tools, calls, v: 'g' + (st.data.rev || 0) };
    }
    if (src.kind === 'cursor') {
      // 同 gemini：扫描时已把整轮解析进内存，直接读，扫描与详情不可能对不上
      const st = files.get(src.file);
      const t = st?.data?.turns?.[src.turn];
      if (!t) return null;
      // 详情里必须说清「为什么这张卡片上全是 0」，否则用户只会看到一屏的 0、合理地去怀疑解析器坏了。
      // 这不是解析缺口 —— 转录文件里真的只有 role + text（见 CURSOR_NO_USAGE_NOTE）。
      // 说哪一段按「手上到底有什么」分三档：采到用量 → 讲钩子那套口径；只有模型名 → 讲模型名从哪来；
      // 都没有 → 解释为什么连模型名都没有（并顺带指出那个注入 hook 的按钮）。
      const note = t.usage ? CURSOR_HOOK_NOTE
        : ((t.models && t.models.length) ? CURSOR_MODEL_NOTE : CURSOR_NO_USAGE_NOTE);
      return { user: t.user, assistant: t.assistant, tools: [], calls: [], callsNote: note, v: 'r' + (st.data.rev || 0) };
    }
    if (src.kind === 'copilot') {
      const st = files.get(src.file);
      const t = st?.data?.turns?.[src.turn];
      if (!t) return null;
      const tools = (t.tools || []).map(x => {
        const fi = {}, fo = {};
        return {
          name: x.name, tid: x.tid, error: x.error, dur: x.dur || 0,
          input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
          output: trunc(x.output, full, fo), outputTrunc: !!fo.t,
        };
      });
      const calls = (t.callList || []).map(c => ({ ...c }));
      const out = {
        user: t.user || '', assistant: (t.texts || []).join('\n\n---\n\n'),
        tools, calls, v: 'c' + (st.data.rev || 0), events: [],
      };
      if (t.err && t.errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + t.errMsg;
      return out;
    }
    if (src.kind === 'dsh') {
      // 同 gemini / cursor：扫描时已把整轮（用户输入 / 正文 / 工具 / 逐次调用）解析进内存，直接读。
      // 扫描与详情共用同一份数据，天然不存在「快照与详情对不上」的口径问题。
      const st = files.get(src.file);
      const t = st?.data?.turns?.[src.turn];
      if (!t) return null;
      const tools = t.tools.map(x => {
        const fi = {}, fo = {};
        return {
          name: x.name, tid: x.tid, error: x.error,
          input: trunc(x.input, full, fi), inputTrunc: !!fi.t,
          output: trunc(x.output, full, fo), outputTrunc: !!fo.t,
        };
      });
      const out = {
        user: t.user, assistant: t.texts.join('\n\n---\n\n'),
        tools, calls: t.callList, v: 'd' + (st.data.rev || 0),
        // 轨迹（R6）：本轮按真实时间顺序的事件流。call/result 的 i 与上面 tools[] 同下标，
        // 所以页面可以直接复用 tools[i] 的入参/返回（含 800 字截断标记与 full=1 的不截断），
        // 不必给事件再写一套正文通道。
        events: t.events || [],
      };
      // 失败轮必须说清「为什么全 0」：dsh 的失败调用不落用量，卡片上会是 0 次调用 + token 全 0，
      // 看着像解析器没接上。把源头给的错误原文带出来，方向就明确了（本机那个会话 4 轮全是网关 405）。
      if (t.err && t.errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + t.errMsg;
      return out;
    }
    if (src.kind === 'zcode') {
      // 同 gemini / dsh：扫描时已把整轮（用户输入 / 正文 / 工具 / 逐次调用 / 事件流）解析进内存，直接读。
      // 扫描与详情共用同一份数据，天然不存在「快照与详情对不上」的口径问题。
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
      // 逐次正文（callList[].text）与 dsh/gemini 同口径：缓存里保持原文，输出时按 800 字截断
      const calls = t.callList.map(c => {
        if (!c.text) return c;
        const ft = {};
        const s = trunc(c.text, full, ft);
        return ft.t ? { ...c, text: s, textTrunc: true } : c;
      });
      const out = {
        user: t.user, assistant: t.texts.join('\n\n---\n\n'),
        tools, calls, v: 'z' + (st.data.rev || 0),
        // 逐事件时间线（EVENT_AGENTS 里有 zcode）：call/result 的 i 与上面 tools[] 同下标
        events: t.events || [],
        // 非文本 part（状态事件 / 推理长度锚点 / 未知类型的结构化 JSON）——未知类型不静默丢弃
        others: (t.others || []).map(o => ({ type: o.type, t: o.t, json: full ? o.json : o.json.slice(0, 800) })),
      };
      if (t.err && t.errMsg) out.callsNote = '这一轮没有成功拿到模型回复：' + t.errMsg;
      return out;
    }
    // opencode：同 zcode —— 扫描时已把整轮（用户输入 / 正文 / 工具 / 逐次调用 / 事件流）解析进内存，直接读
    if (src.kind === 'opencode') return opencodeEntryContent(src, full);
    // kilo：与 opencode 同一条路（复用同一份核心，只按 kilo 的 id 前缀 / 详情版本号取内存 turns）
    if (src.kind === 'kilo') return kiloEntryContent(src, full);
    // hermes：同 opencode（DB 主源 + agent.log 逐次行都在扫描时并进了内存 turns）
    if (src.kind === 'hermes') return hermesEntryContent(src, full);
    // devindb：同 opencode/hermes（整轮解析都在扫描时做完，直接读内存 turns）
    if (src.kind === 'devindb') return devinDbEntryContent(src, full);
    if (src.kind === 'codearts') {
      // 扫描时已把每轮的用户文本与逐次调用存进 files 数据，直接读内存
      const t = files.get(src.file)?.data?.turns?.[src.turn];
      return t ? { user: t.user || '', assistant: '', tools: [], calls: t.calls || [], v: version } : null;
    }
    if (src.kind === 'trace') {
      const j = JSON.parse(fs.readFileSync(src.file, 'utf8'));
      const t = j.trace || {};
      const tools = (j.spans || []).filter(sp => sp.toolName).slice(0, 100).map(sp => {
        const fi = {}, fo = {};
        return {
          name: sp.toolName, dur: sp.duration || 0,
          error: sp.error || sp.status !== 'ok' ? (sp.error || sp.status) : null,
          input: trunc(sp.toolInput, full, fi), inputTrunc: !!fi.t, output: trunc(sp.toolOutput, full, fo), outputTrunc: !!fo.t,
        };
      });
      // generation span = 每次 LLM 调用；源头只有耗时/状态，无单次 token
      const calls = (j.spans || []).filter(sp => sp.type === 'generation').slice(0, 100).map(sp => ({
        model: '', dur: sp.duration || 0,
        error: sp.error || sp.status !== 'ok' ? (sp.error || sp.status) : null,
      }));
      // 按 parentId 组装两层（workflow -> span），平铺输出带 depth 供前端缩进
      const spans = j.spans || [];
      const byParent = new Map();
      for (const sp of spans) {
        const p = sp.parentId || '';
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(sp);
      }
      const tree = [];
      const walk = (pid, depth) => {
        for (const sp of byParent.get(pid) || []) {
          if (tree.length >= 200) return;
          tree.push({
            depth, name: String(sp.name || sp.toolName || sp.type || 'span').slice(0, 120),
            type: sp.type || '', dur: sp.duration || 0,
            error: sp.error || (sp.status && sp.status !== 'ok' ? sp.status : null),
          });
          if (depth < 3 && (sp.spanId || sp.id)) walk(sp.spanId || sp.id, depth + 1); // span 的唯一键是 spanId（不是 id）
        }
      };
      walk('', 0);
      // parentId 指向不存在根时的兜底（防整棵丢失）
      if (!tree.length && spans.length) for (const sp of spans.slice(0, 200)) tree.push({ depth: 0, name: String(sp.name || sp.type || 'span').slice(0, 120), type: sp.type || '', dur: sp.duration || 0, error: sp.error || null });
      return { user: String(t.prompt || ''), assistant: '', tools, calls, spans: tree, v: version };
    }
    // traedb：同 zcode —— 扫描时已把整轮（用户输入 / 正文 / 工具 / 逐次调用 / 事件流）解析进内存，直接读
    if (src.kind === 'traedb') return traeDbEntryContent(src, full);
    // minimax（Mavis 本地运行时）：详情不走内存——重读 messages.jsonl 按 src.turn 过滤，
    // 正文分段、工具按 toolCallId 回填、calls 逐次明细（usage 取 assistant 行 message.usage）。
    if (src.kind === 'minimax') return mavisEntryContent(src, full);
    // openclaw：同 minimax —— 重读转录按 src.turn 过滤，工具按 toolCallId 回填，calls 带逐次 usage
    if (src.kind === 'openclaw') return openclawEntryContent(src, full);
    // tracecode / tracework：详情从 renderer.log 重解析指定 sessionId 的全部事件
    //（扫描只存了 entry 概要，详情页要逐事件展开；与 codearts/codex 同款「重读文件按 turn 过滤」）
    if (src.kind === 'tracecode' || src.kind === 'tracework') {
      return traeEntryContent(src, full) || { user: '', assistant: '', tools: [] };
    }
    if (src.kind === 'mimocode') return mimocodeEntryContent(src, full);
  } catch (e) { return { user: '[内容读取失败: ' + e.message + ']', assistant: '', tools: [] }; }
  return null;
}

// ---------------- I8 单轮「复现包」原始日志片段提取 ----------------
// 复现包要把「这一轮在原始日志里长什么样」一并导出。能精确切出原始行的前提是：source 是**单文件逐行 jsonl**，
// 且「哪一行属于这一轮」的判定能复用解析器的开轮逻辑（见下方 turnStartIdx）。其余 kind 的源不是单文本文件
// （SQLite / 多帧 zstd / 内存转录 / 多文件），无法切出「该轮片段」——那就诚实标 extractable:false 并附原始路径，
// 解析结果（entryContent）仍是完整、可信的。绝不为了「都有片段」而编造。
// 返回：{ kind, file, extractable, lines|null, note }。lines 是**原始文本行数组**（trim 后非空、未解析），
// 下标与磁盘行号对齐（1-based 行号 = 下标+1），复现时直接 cp 这一段即可。
const REPRO_JSONL_KINDS = new Set(['claude', 'codex', 'buddyjsonl', 'doubao', 'minimax', 'kimi', 'copilot', 'generic-jsonl', 'openclaw']);
function reproRaw(src, e) {
  const out = { kind: src.kind, file: src.file || null, extractable: false, lines: null, note: '' };
  const fstate = files.get(src.file);
  if (!fstate) {
    out.note = '源文件未载入内存（可能尚未扫描或已被淘汰）：无法切出原始片段；原始路径见 file，完整解析结果见 parsed.json';
    return out;
  }
  if (!REPRO_JSONL_KINDS.has(src.kind)) {
    out.note = src.kind === 'cline'
      ? 'Cline 的源是**一份整份 JSON**（每次落盘整体重写），不是「一个轮一行」——按行切不出轮边界；' +
        '复现请给 file 字段那整个 messages.json，本轮解析结果见 parsed.json。' +
        '⚠️ 那份文件里是完整对话正文 + system_prompt，对外贴之前先自己过一眼。'
      : src.kind === 'buddyext'
        ? 'CodeBuddy 扩展的一个轮 = 会话 index.json 里 requests[] 的**一项**，正文散在同一目录的 ' +
          'messages/<消息 id>.json 里（一条一个文件），不是「一个轮一行」——按行切不出轮边界；' +
          '复现请给 file 那整份 index.json 加它同目录 messages/ 下被该轮 requests[].messages 引用的那些文件' +
          '（本轮的消息 id 见 parsed.json 的 calls/tools）。' +
          '⚠️ 那些文件里是完整对话正文，对外贴之前先自己过一眼。'
        : '该 agent（' + src.kind + '）的源不是单文件 JSONL 文本日志（数据库 / 多帧压缩 / 内存转录 / 多文件），' +
        '无法切出「该轮原始片段」；完整解析结果见 parsed.json（file 字段给出原始路径）。';
    return out;
  }
  let text;
  try { text = fs.readFileSync(src.file, 'utf8'); } catch (e) { out.note = '读取源文件失败：' + e.message; return out; }
  // 复用 readCompleteLines：只处理「完整行」，与扫描口径一致（避免把半截尾行算进来）。
  const rd = readCompleteLines(src.file, 0, text.length);
  const rawLines = rd ? rd.lines : text.split('\n');
  // 找到这一轮的起止行（[start, end) 下标，end 不含）。turn 在 src.turn 里是轮序号 idx（整数）。
  const span = turnStartIdx(src.kind, rawLines, src.turn, e);
  if (!span) { out.note = '按开轮判定未能在该源文件中定位到第 ' + src.turn + ' 轮（可能源已轮转/截断）：完整解析结果见 parsed.json'; return out; }
  const lines = [];
  for (let i = span.start; i < span.end; i++) if (rawLines[i].trim()) lines.push(rawLines[i]);
  out.extractable = true;
  out.lines = lines;
  out.note = '本文件第 ' + (span.start + 1) + '–' + span.end + ' 行（行号 1-based，与磁盘一致；空行已跳过）；' +
    '这些行按「与解析器完全相同的开轮判定」归到这一轮（从这一轮的用户输入起到下一轮开始前，' +
    '含该轮内模型响应、工具调用与 tool_result 等全部交互），可直接贴出复现。';
  return out;
}

// 给定 kind + 原始行数组 + 目标轮 idx，返回该轮在 rawLines 中的 [start, end) 下标。
// 复用各解析器的开轮判定函数（claudeUserText / codexUserText / …），保证切出来的片段与扫描归到的轮一一对应。
// 仅在 REPRO_JSONL_KINDS 内被调用。
function turnStartIdx(kind, lines, targetIdx, e) {
  const starts = [];   // 每个开轮行在 lines 中的下标
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (isTurnStart(kind, j, e)) starts.push(i);
  }
  if (!starts.length || targetIdx < 0 || targetIdx >= starts.length) return null;
  const s = starts[targetIdx];
  const e2 = targetIdx + 1 < starts.length ? starts[targetIdx + 1] : lines.length;
  return { start: s, end: e2 };
}

// 与解析器「开轮」完全同一套判定（不含命令/工具结果这类跳过，仅用于定位轮起点）。
function isTurnStart(kind, j, e) {
  if (kind === 'claude') {
    if (j.type !== 'user') return false;
    const c = j.message && j.message.content;
    if (claudeIsToolResultOnly(c)) return false;
    const t0 = claudeUserText(c);
    if (!t0) return false;
    return !claudeIsCommandText(t0);
  }
  if (kind === 'codex') return !!(j.payload && j.payload.type === 'task_started');
  if (kind === 'buddyjsonl') return j.type === 'message' && j.role === 'user' && !!buddyUserText(j.content);
  if (kind === 'doubao') return j.role === 'user' && !!toText(j.content);
  if (kind === 'minimax') {
    const msg = j.message || {};
    const role = msg.role || (msg.toolCallId ? 'toolResult' : null);
    return role === 'user' && !!mavisUserText(msg.content);
  }
  // openclaw：追加式会话树，开轮行 = type:"message" 且 message.role="user" 且正文非空
  if (kind === 'openclaw') {
    if (j.type !== 'message') return false;
    const msg = j.message || {};
    return msg.role === 'user' && !!openclawUserText(msg.content);
  }
  if (kind === 'kimi') return j.type === 'turn.prompt';
  if (kind === 'copilot') return j.type === 'user.message' && copilotTurnStart(j);
  if (kind === 'generic-jsonl') {
    const agent = e && e.agent;
    const conf = agent && agentConfs.get(agent);
    return genericTurnStart(j, conf && conf.rules);
  }
  return false;
}

// ---------------- 项目归一化 + 时间窗口（跨端共享，需求书 R12） ----------------
// 同一套口径要在两处跑：服务端（按项目/范围过滤窗口）与页面（项目下拉分组、直播增量该不该进窗）。
// 页面是单文件 HTML、共享不了模块 —— 以前两边各抄一份、靠注释提醒人工同步，漂了就是静默的
// 筛选错位（点项目 0 条、「今天」各算各的）。现在**唯一来源是下面这段字符串**（R12）：
// 服务端自己 eval 一份用；GET / 时把它原样注入页面的 __AGENT_LOG_SHARED__ 占位符，页面不再持有副本。
// 于是「改了一处忘了另一处」在结构上不可能 —— 只剩一处。test/shared-snippet-test.mjs 守住
// 「页面不许再出现本地副本」这条；改本段代码等于同时改两端，无需同步、也无 rev 义务（不落盘）。
const SHARED_JS = `
// 同一个项目会被各家 agent 写成不同样子（\`F:\\centos\\next-admin\` / \`f:\\centos\\next-admin\` /
// cursor 那种盘符与分隔符全退化成 \`-\` 的 slug）。去掉所有非字母数字再比就全都归一了，
// 不必去猜 slug 的原路径。条目不落盘原文改写 —— 归一只作用在「项目」这个筛选维度。
const projNorm = p => String(p || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const projKey = p => projNorm(p) || String(p); // 名字里一个字母数字都没有时退回原名
// 符号 range（today/7d/30d）→ 窗口起点的 ms（本地时区自然日 0 点）；没传/不认识 → null（不限，
// 宁可全给，也不要静默返回一张空表）。页面传符号而不是算好的时间戳：标签页挂过午夜后「今天」得跟着走，
// 每次用到现算。用 setDate 递减而不是减 86400000 —— 有夏令时的时区里一天不是恒等于 24 小时。
const rangeDayStart = range => {
  const n = { today: 1, '7d': 7, '30d': 30 }[range];
  if (!n) return null;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (n - 1));
  return d.getTime();
};
`;
// 服务端自己的一份：与注入页面的是同一个字符串，不存在第二份实现。
// 语法写错了会在这里当场抛出来（启动即失败）—— 这就是 R12 要的「主动发现」。
const { projNorm, projKey, rangeDayStart } = new Function(SHARED_JS + '\nreturn { projNorm, projKey, rangeDayStart };')();

// ---------------- 时间范围（C2） ----------------
// 页面传的是**符号**（today / 7d / 30d）而不是算好的时间戳：标签页挂过午夜之后，「今天」得跟着走。
// 每次请求现算边界，于是「页面上写的范围」和「服务端实际过滤的范围」永远是同一个（传时间戳就会错开）。
// 边界一律取**本地时区的自然日**：今天 = 当地 0 点 → 现在；近 7 天 = 今天 + 前 6 个自然日（含今天共 7 天）。
// 窗口起点的算法在共享片段 rangeDayStart 里（见上，与页面同一份代码）；这里只补上界与展示标签。
const RANGE_LABEL = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' };
function rangeBounds(range) {
  const from = rangeDayStart(range);
  if (from == null) return null;   // 不认识的取值 = 不限（宁可全给，也不要静默返回一张空表）
  return { from, to: Date.now(), label: RANGE_LABEL[range] };
}
// 显式日期区间（YYYY-MM-DD，本地自然日）：页面「用量统计」的 from→to 选择器走这里。
// 与符号 range 同一套本地自然日口径；两者都给时以显式区间为准（符号只是「没选区间时的默认」）。
function customBounds(from, to) {
  const p = s => /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  const a = p(from), b = p(to);
  if (!a || !b) return null;
  const dayStart = m => new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const dayEnd = m => { const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setDate(d.getDate() + 1); return d.getTime() - 1; };
  const lo = Math.min(dayStart(a), dayStart(b)), hi = Math.max(dayEnd(a), dayEnd(b));   // 起止选反了也容错
  const loS = lo === dayStart(a) ? from : to, hiS = lo === dayStart(a) ? to : from;
  return { from: lo, to: hi, label: loS + ' ~ ' + hiS };
}
// 按天分桶用**同一套本地自然日**口径（否则「今天」这个桶会跨到昨天去，柱状图与范围筛选对不上）
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
// I16/D2：**时间未知**的轮（`timeUnknown === true`，time 落 0）不进任何按时间的口径。
// 它们原先（回落 updated_at 时）是「假装有一个时间」，现在如实为 0 —— 若不管，1970-01-01 会冒出
// 一个上千条的巨大桶、把按天柱状图的横轴拉成 56 年，而那个桶里的轮其实分布在好几个月里。
//   · 时间范围筛选（rangeBounds / customBounds）下**天然落到区间外**，无需特判；
//   · 按天分桶要显式跳过（否则 1970 那个桶）；
//   · 排序统一用 `time || 0` 之后它们自然沉底（页面如实标「时间未知」）。
const hasTime = e => (e.time || 0) > 0 && !e.timeUnknown;

// ---------------- 归档（调度与 CLI 入口，核心在 archive.mjs） ----------------
// 装配：entries / srcs 是扫描链的共享 Map，dayKey 与 entryContent 都在本文件（详情要回读源文件），
// 由这里注入 —— archive.mjs 不反向 import 主文件，避免循环依赖。

// ---------------- 全文搜索（调度与 CLI 入口，核心在 search.mjs） ----------------
// 装配同归档：files 是扫描链的共享 Map（索引靠它判「源变没变」，**不自己 statSync** ——
// cursor / gemini 的源标识是伪路径，stat 必然抛，见 search.mjs 里 srcState 那段）；
// maxChars：每条轮次索引的正文上限（默认 8000）。只做环境变量覆盖，不进 config.json ——
// 它不是用户意图，是「这台机器内存吃不吃得消」的运维旋钮，调它的人本来就在改启动参数。
const SEARCH_MAX_CHARS = Number(process.env.AGENT_LOG_SEARCH_MAX_CHARS || 0) > 0 ? Number(process.env.AGENT_LOG_SEARCH_MAX_CHARS) : 8000;

// ---------------- 装配（Step 2 收口：三处注入合成一个入口，按 MODE 定写闸） ----------------
// 三处注入式装配（archive / search / 解析器的落盘钩子）原先散在模块级，且读的是加载时就定死的 LIB。
// hosted 模式要在加载**之后**才切过来，那时 readOnly 与写钩子必须跟着翻 —— 所以合成一个函数，
// start() 切完 MODE 再调一遍。两个 init 都是 `DEPS = d` 的一句赋值，重复调用是无副作用的。
//
// 写闸的判据（三态各一行，**不要合并简化**）：
//   lib    （MCP）    —— readOnly:true、落盘钩子空：第二个读者绝不跟常驻服务抢索引分片的写者身份
//   cli/hosted        —— readOnly:false、钩子接回 scheduleSave：写路径全开
function assemble() {
  initArchive({ dataDir: DATA_DIR, entries, srcs, entryContent, dayKey, parserRev: PARSER_REV });
  initSearch({ dataDir: DATA_DIR, entries, srcs, files, entryContent, parserRev: PARSER_REV, maxChars: SEARCH_MAX_CHARS, readOnly: MODE === 'lib' });
  setSaveHook(MODE === 'lib' ? () => {} : scheduleSave);
}
// 模块加载时装一遍。**lib 模式就到这儿为止**（它不经过 start()），而这一遍的结果与 Step 1 前逐字一致：
// 同一组 DEPS、同样 readOnly:true、同样空钩子。cli 模式这一遍也照旧，start() 里那遍是幂等的重装。
assemble();

// ---------------- 常驻定时器登记表（Step 2 副作用收口） ----------------
// 服务里所有「挂上就再也不停」的定时器都登记在这里，stop() 一口气全撤。
// 为什么不止登记 §5 点名的那两个（saveIndex / checkIdle）：hosted 的 stop() 语义是**只停循环、不退进程**
// （退出权在宿主手里），漏掉扫描自续期 / 归档轮 / 搜索轮里的任何一个，宿主那边「已经停掉的服务」
// 就还在后台扫盘写索引 —— 正是这次收口要消灭的那类副作用。登记面 = 全部常驻定时器。
// 语义与裸 setInterval/setTimeout 完全一致（同一个定时器池、同样的回调），多出来的只是「记一笔好撤销」。
const timers = new Set();
// 一次性定时器**自撤登记**：回调一进来先把自己从表里摘掉。不这么做的话，scanTimer 那种 3 秒自续期的
// 一次性定时器会在表里留下一串跑完的句柄 —— 那不是收口，是换个地方漏（一天攒两万条）。
function after(ms, fn) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }
function every(fn, ms) { const t = setInterval(fn, ms); timers.add(t); return t; }
function cancel(t) { if (!t) return; try { clearTimeout(t); clearInterval(t); } catch {} timers.delete(t); }
function clearTimers() { for (const t of [...timers]) cancel(t); timers.clear(); if (saveTimer) saveTimer = null; }

// 服务内的后台增量建索引。节奏与归档**刻意不同**：归档冻的是「已结束且早于今天」的历史，
// 判据「今天跑过没」就够；索引跟的是**正在长的活文件**（会话每几秒追加一行），
// 按天记账会让整天的新内容搜不到，所以改成「首轮 + 定时增量」两条线。
//   首轮：等首扫落停再动（扫描与建索引都在读同一批源文件，撞一起是白抢 CPU）。
//   之后：每 SEARCH_AUTO_CHECK_MS 增量跑一轮，只重建签名变了的源，稳态下就是「今天动过的那几个会话」。
const SEARCH_AUTO_DELAY_MS = 60000;
const SEARCH_AUTO_CHECK_MS = 10 * 60000;
// AGENT_LOG_SEARCH_DELAY_MS：临时覆盖首轮延迟（不落盘），调试/测试用 ——
// 不然验一次「服务会不会自己建索引」要等 60 秒（与 AGENT_LOG_ARCHIVE_DELAY_MS 同一套理由）。
const SEARCH_AUTO_DELAY_ENV = Number(process.env.AGENT_LOG_SEARCH_DELAY_MS || 0) > 0 ? Number(process.env.AGENT_LOG_SEARCH_DELAY_MS) : 0;
// 一轮最多处理多少个源文件。按**文件**封顶而不是按条目：一个文件的记录要么整体换掉、要么原样不动，
// 从中间切开会把一份记录留成半新半旧，而它下一轮又因为签名已更新而跳过 —— 会永久错下去。
const SEARCH_AUTO_FILES = 200;
let searchRunning = false;

async function autoSearchTick(force, maxFiles) {
  if (searchRunning) return null;   // 重入闸：定时轮与手动轮不叠着跑
  searchRunning = true;
  try {
    // 扫描还在跑就先等它。索引覆盖的是「内存里的条目」，扫到一半就开建，建出来的是一份**残缺**的
    // 索引：后面才扫出来的条目这一轮全漏掉，要等下一轮（10 分钟）才补得上 —— 而首轮恰恰是
    // 用户最可能搜的时候。踩过：首轮延迟压到 2s 时实测只覆盖 1149/3564。
    // 等的是同进程的状态位、不是猜时间；scanAllChunked 会主动让出事件循环，所以这个轮询不会把它卡死。
    // 上限 60s 兜底：万一状态位因故没落回来，宁可建一份残缺的也别永远不建。
    for (let i = 0; i < 120 && scanning; i++) await new Promise(r => setTimeout(r, 500));
    // 载入（幂等、只做一次）在 searchRun 内部自己管，这里不用管。
    // maxFiles 缺省用稳态那一档；首轮显式传 0 = 不限量，见 scheduleAutoSearch。
    const cap = maxFiles == null ? SEARCH_AUTO_FILES : maxFiles;
    let stat = await searchRun({ force: !!force, maxFiles: force ? 0 : cap, log: m => log('[search] ' + m) });
    // 补跑到稳定。首扫是**分片让出**的，而建索引取的是「此刻内存里的条目」快照 —— 两者叠在一起时，
    // 一轮建完往往还有一批源是这之后才扫出来的（实测首轮 389 个源，最终是 436 个），
    // 漏掉的那部分要等下一轮（10 分钟）才补得上，而首轮恰恰是用户最可能搜的时候。
    // 稳态下第二轮的 indexed 必然是 0（没有源的签名变过），这个 for 一轮就退出，不额外花时间。
    for (let i = 0; i < 4; i++) {
      const more = await searchRun({ force: false, maxFiles: 0, log: m => log('[search] ' + m) });
      stat = {
        ...more, files: Math.max(stat.files, more.files),
        indexed: stat.indexed + more.indexed, skipped: stat.skipped + more.skipped,
        unreadable: stat.unreadable + more.unreadable, entries: stat.entries + more.entries,
        chars: stat.chars + more.chars, cut: stat.cut + more.cut, noState: stat.noState + more.noState,
        savedOk: more.savedOk !== false, bytes: (stat.bytes || 0) + (more.bytes || 0),
      };
      log('[search] 补跑第 ' + (i + 1) + ' 轮：' + more.files + ' 个源 / 重建 ' + more.indexed +
        ' / 跳过 ' + more.skipped + ' / noState ' + more.noState + ' / 抽正文 ' + more.entries);
      if (!more.indexed) break;   // 一轮下来一个源都不用建 = 追平了
    }
    if (stat.indexed || stat.skipped || stat.unreadable || stat.pruned) {
      log('[search] 全文索引：' + stat.files + ' 个源 / 重建 ' + stat.indexed + ' / 跳过 ' + stat.skipped +
        ' / noState ' + stat.noState + ' / 抽正文 ' + stat.entries + ' 条' +
        (stat.unreadable ? ' / 读不出正文 ' + stat.unreadable : '') +
        // 剪枝：源不在本机的旧记录（换平台 / 换机器 / 日志被产品删了）。这条只会在换环境后的
        // 第一轮出现，是**正常自愈**，不是数据丢了 —— 写明白免得看见「可查条数掉了」以为坏了。
        (stat.pruned ? ' / 剪掉 ' + stat.pruned + ' 条源不在本机的旧记录（换平台或日志已删，下次扫到会重建）' : '') +
        (stat.capped ? '（本轮有截断，下一轮接着来）' : '') +
        '，可查 ' + stat.inIndex + ' 条，' + fmtBytes(stat.bytes || 0));
    }
    return stat;
  } catch (e) { console.error('[search]', e.message); return null; }
  finally { searchRunning = false; }
}

function scheduleAutoSearch() {
  const delay = SEARCH_AUTO_DELAY_ENV || SEARCH_AUTO_DELAY_MS;
  after(delay, () => {
    // 首轮**不限量**（maxFiles: 0）。理由：一台刚装的机器有几百个源，按稳态那档 200/轮要跑半小时，
    // 而这段时间里用户搜什么都是「还没索引到」。40ms 让出一次事件循环保证页面不卡，
    // 所以「一次跑完那 100 多秒」是可接受的取舍（与归档首轮跑几分钟同一个量级、同一种理由）。
    autoSearchTick(false, 0);
    every(() => autoSearchTick(false, SEARCH_AUTO_FILES), SEARCH_AUTO_CHECK_MS);
  });
}

// 服务内的每日自动归档。为什么不是「每天定时那一下就完」：
//   1) 服务可能一天被拉起很多次（hook 每次开会话都 --ensure），所以判据是「今天跑过没」而不是「距上次多久」；
//   2) 首次跑要在首扫之后 —— 归档冻的是内存里的条目，扫描还没把源文件读进来时跑等于白跑。
// 失败不抛：归档是附加能力，出错不能把扫描/服务带下水。
// maxPerRun：后台轮一次最多 4000 条（entryContent 要逐条回读源文件），跑不完下次接着跑，
// 免得一台积压几万条历史的机器上，第一次自动归档把事件循环占上几分钟。
const ARCHIVE_AUTO_LIMIT = 4000;
const ARCHIVE_AUTO_DELAY_MS = 90000;      // 首扫通常几秒内完成，留 90s 缓冲
// AGENT_LOG_ARCHIVE_DELAY_MS：临时覆盖首次自动归档的延迟（不落盘），调试/测试用 ——
// 不然验一次「服务会不会自己归档」要等 90 秒（与 AGENT_LOG_IDLE_MS 同一套理由）。
const ARCHIVE_AUTO_DELAY_ENV = Number(process.env.AGENT_LOG_ARCHIVE_DELAY_MS || 0) > 0 ? Number(process.env.AGENT_LOG_ARCHIVE_DELAY_MS) : 0;
const ARCHIVE_AUTO_CHECK_MS = 3 * 3600e3; // 每 3h 看一眼「今天跑过没」（一天最多真正跑一次）
let archiveAutoDay = '';                  // 本次进程内已自动归档过的自然日
let archiveRunning = false;

async function autoArchiveTick(force) {
  const today = dayKey(Date.now());
  if (!force && archiveAutoDay === today) return null;
  if (archiveRunning) return null;
  archiveRunning = true;
  archiveAutoDay = today;   // 先记账再跑：跑失败了也不该每 3h 重试一次（手动 --archive 随时能补）
  try {
    const stat = await archiveRun({ maxPerRun: ARCHIVE_AUTO_LIMIT, skip: archiveCfg.skip, log: m => log('[archive] ' + m) });
    if (stat.failed) console.error('[archive] 有 ' + stat.failed + ' 个日期文件写失败（详见上方日志）');
    if (stat.archived || stat.updated) {
      log('[archive] 自动归档：新冻 ' + stat.archived + ' 条 / 更新 ' + stat.updated +
        ' 条' + (stat.capped ? '（本轮有截断，下次接着跑）' : '') + '，写入 ' + fmtBytes(stat.bytes));
    }    if (archiveCfg.maxDays || archiveCfg.maxMB) pruneArchive({ maxDays: archiveCfg.maxDays, maxMB: archiveCfg.maxMB, log: m => log('[archive] ' + m) });
    return stat;
  } catch (e) { console.error('[archive]', e.message); return null; }
  finally { archiveRunning = false; }
}

function scheduleAutoArchive() {
  if (!archiveCfg.enabled) return;   // 关掉自动归档只影响这里；--archive 手动跑不受影响
  const delay = ARCHIVE_AUTO_DELAY_ENV || ARCHIVE_AUTO_DELAY_MS;
  after(delay, () => { autoArchiveTick(false); every(() => autoArchiveTick(false), ARCHIVE_AUTO_CHECK_MS); });
}

// R10：合并单值键与多值键 —— agents= / projects=（逗号分隔合集）优先；没传多值键时回落单值 agent= / project=（语义不变）。
const multiParam = (u, single, multi) => {
  const m = (u.searchParams.get(multi) || '').trim();
  return m || (u.searchParams.get(single) || '');
};
// I15 工作指纹：从查询串里取 branch= / permMode= / cliVer=（与 agent= / project= 一样，单值键，
// 多值走逗号分隔的 branchs= / permModes= / cliVers= 键；没有就回落单值键）。返回 { branch, permMode, cliVer }，
// 三个键都是「逗号分隔集合」的字符串或 ''。只有 claude 源带这些字段，别家筛选结果天然为空 ——
// 页面按「无此维度」提示，不印 0（见 I15 条目约定）。
const workParam = (u) => {
  const pick = (single, multi) => {
    const m = (u.searchParams.get(multi) || '').trim();
    return m || (u.searchParams.get(single) || '').trim();
  };
  return { branch: pick('branch', 'branchs'), permMode: pick('permMode', 'permModes'), cliVer: pick('cliVer', 'cliVers') };
};

// 快照与按天聚合**共用同一套筛选口径**（agent / 项目 / 时间范围），区别只在下游：
// 快照还要再切「条/页」这个显示窗口，聚合要的是**整个筛选集**——不能被 2000 条的窗口截断，
// 否则「今天烧了多少」会随着条/页档位变来变去。
// agent / project 筛选值兼容多值：R10 独立多选下拉传 `agents=a,b` / `projects=k1,k2`（逗号分隔），
// 老的单值键 agent= / project= 语义不变（单值天然是"逗号分隔的一项"）。空段忽略。
// I15 追加 work 筛选：{ branch, permMode, cliVer } 三者任一非空即按对应维度收窄（AND 组合）。
// 三个维度的取值都是「逗号分隔集合」（与 agents/projects 同一种多值语义）；值为 undefined 时不筛。
function filterEntries(agentFilter, projectFilter, range, from, to, work) {
  let all = sortedEntries();
  const aset = new Set(String(agentFilter || '').split(',').map(s => s.trim()).filter(Boolean));
  if (aset.size) all = all.filter(e => aset.has(e.agent));
  const pset = new Set(String(projectFilter || '').split(',').map(s => s.trim()).filter(Boolean));
  if (pset.size) all = all.filter(e => pset.has(projKey(e.project)));
  const w = work || {};
  const bset = new Set(String(w.branch || '').split(',').map(s => s.trim()).filter(Boolean));
  if (bset.size) all = all.filter(e => bset.has(e.branch));
  const mset = new Set(String(w.permMode || '').split(',').map(s => s.trim()).filter(Boolean));
  if (mset.size) all = all.filter(e => mset.has(e.permMode));
  const vset = new Set(String(w.cliVer || '').split(',').map(s => s.trim()).filter(Boolean));
  if (vset.size) all = all.filter(e => vset.has(e.cliVer));
  const rb = customBounds(from, to) || rangeBounds(range);
  if (rb) all = all.filter(e => e.time >= rb.from && e.time <= rb.to);
  return { list: all, rb };
}

// ---------------- 按天聚合（C2） ----------------
function newBucket(day) {
  return { day, count: 0, tin: 0, tout: 0, tcache: 0, total: 0, dur: 0, maxDur: 0, calls: 0, tools: 0, agents: {} };
}
function dailyAgg(agentFilter, projectFilter, range, from, to, work) {
  const { list, rb } = filterEntries(agentFilter, projectFilter, range, from, to, work);
  const map = new Map();
  // I16/D2：时间未知的轮不进按天分桶 —— 它们 time=0，落下去就是 1970-01-01 一个巨桶，
  // 会把柱状图横轴从几个月拉成 56 年。它们仍躺在列表里（页面如实标「时间未知」），只是不参与按天统计。
  const timed = list.filter(hasTime);
  let skipped = list.length - timed.length;
  for (const e of timed) {
    const k = dayKey(e.time);
    let o = map.get(k);
    if (!o) { o = newBucket(k); map.set(k, o); }
    o.count++;
    o.tin += e.tin || 0; o.tout += e.tout || 0; o.tcache += e.tcache || 0;
    const dur = e.dur || 0;
    o.dur += dur;
    if (dur > o.maxDur) o.maxDur = dur;
    o.calls += e.calls || 0; o.tools += e.tools || 0;
    o.agents[e.agent] = (o.agents[e.agent] || 0) + 1;
  }
  // 没有日志的自然日补 0：柱状图的 x 轴必须是**连续的自然日**，把空天跳掉会把时间轴压扁、
  // 「隔了两周没干活」看起来和「连着两天」一样。
  const days = [];
  let capped = 0;
  if (timed.length || rb) {
    const firstT = rb ? rb.from : timed[timed.length - 1].time;   // list 是按时间降序的
    const lastT = rb ? rb.to : timed[0].time;
    const cur = new Date(firstT); cur.setHours(0, 0, 0, 0);
    const stop = new Date(lastT); stop.setHours(0, 0, 0, 0);
    // 上限只是防病态跨度（几年前的日志 + 今天会拉出上千根柱子）：超了丢最旧的并如实报出来，
    // 不静默截断 —— 悄悄少算一段历史比图难看严重得多。
    const MAX_DAYS = 400;
    if ((stop.getTime() - cur.getTime()) / 86400000 > MAX_DAYS) { cur.setTime(stop.getTime() - MAX_DAYS * 86400000); cur.setHours(0, 0, 0, 0); capped = 1; }
    let guard = 0;
    while (cur.getTime() <= stop.getTime() && guard++ < 5000) {
      const k = dayKey(cur.getTime());
      days.push(map.get(k) || newBucket(k));
      cur.setDate(cur.getDate() + 1);
    }
  }
  const totals = newBucket('');
  for (const o of days) {
    // 合计按三项**现算**，不累加条目里的 total 字段：「输入 + 输出 + 缓存 = 合计」由构造保证，
    // 免得哪天某个解析器的 total 口径漂了，图表上又出现「合计 < 输入」那种算不通的数（§12 的教训）。
    o.total = o.tin + o.tout + o.tcache;
    totals.count += o.count; totals.tin += o.tin; totals.tout += o.tout; totals.tcache += o.tcache;
    totals.dur += o.dur; totals.calls += o.calls; totals.tools += o.tools;
    if (o.maxDur > totals.maxDur) totals.maxDur = o.maxDur;
  }
  totals.total = totals.tin + totals.tout + totals.tcache;
  return {
    ok: true,
    range: range || 'all',
    label: rb ? rb.label : '全部时间',
    from: days.length ? days[0].day : null,
    to: days.length ? days[days.length - 1].day : null,
    daysCapped: capped ? 1 : 0,     // 1 = 跨度过大，只统计了最近 400 天
    // I16/D2：**没进这张图**的时间未知轮数，如实报出来（页面据此说明「有 N 轮时间未知、未计入」）。
    // 不报的话，按天合计会小于列表里看到的条数，看着像漏算 —— 那是把「不知道」读成了「丢了」。
    timeUnknown: skipped || 0,
    days, totals,
  };
}

// ---------------- 按模型聚合（C2 续） ----------------
// 与按天聚合同一套筛选、同样不吃「条/页」窗口，只是分桶维度换成模型。
//
// 归一：**只按小写**（`Deepseek-V4-Flash` 与 `deepseek-v4-flash` 是同一个模型的两写法，本机 5 组）。
// 为什么不做得更"聪明"（去空格/去连字符）：那会把 `hy4 preview` 与 `hy4-preview` 并掉（这俩看着也该并），
// 但同样的规则也会把 `gpt-5.4` 与 `gpt-54` 并掉 —— 宁可少并，也不要并错。显示名仍取组内最多的写法。
//
// 归属：一条轮次挂多个模型时（本机 20/4717），token **全部归给 models[0]**（数据里它就是主模型），
// 并把条数回在 multi 里让页面写出来 —— 不静默挑一个。这样 Σ(各模型) == 合计 永真，能进对账脚本。
function modelAgg(agentFilter, projectFilter, range, from, to, work) {
  const { list } = filterEntries(agentFilter, projectFilter, range, from, to, work);
  const map = new Map();
  let noModel = 0, noModelTotal = 0, noModelCredits = 0, multi = 0;
  for (const e of list) {
    const ms = e.models || [];
    if (!ms.length) { noModel++; noModelTotal += e.total || 0; noModelCredits += e.credits || 0; continue; }   // 本机实测这些条目 total 恒为 0；但不假设，如实累出来
    if (ms.length > 1) multi++;
    const name = String(ms[0]);
    const k = name.toLowerCase();
    let o = map.get(k);
    if (!o) { o = { key: k, count: 0, tin: 0, tout: 0, tcache: 0, total: 0, dur: 0, calls: 0, tools: 0, credits: 0, nameCounts: {}, agents: {} }; map.set(k, o); }
    o.count++;
    o.nameCounts[name] = (o.nameCounts[name] || 0) + 1;
    o.tin += e.tin || 0; o.tout += e.tout || 0; o.tcache += e.tcache || 0;
    o.dur += e.dur || 0; o.calls += e.calls || 0; o.tools += e.tools || 0;
    o.credits += e.credits || 0;   // qoder 的 token 恒 0、真实用量在 credits（见 parsers/claude.mjs），不进 total、单独成列
    o.agents[e.agent] = (o.agents[e.agent] || 0) + 1;
  }
  const models = [...map.values()];
  for (const o of models) {
    o.total = o.tin + o.tout + o.tcache;   // 同按天聚合：合计现算，四个数必然自洽
    // 显示名取组内条目最多的写法（并列取字典序小的，保证每次算出来一致）—— 与项目下拉同一套规则
    const names = Object.keys(o.nameCounts);
    names.sort((a, b) => (o.nameCounts[b] - o.nameCounts[a]) || a.localeCompare(b));
    o.label = names[0];
    o.names = names;
    delete o.nameCounts;
  }
  // 排序：token 多的在前；token 并列（或都为 0）时按条目数，再按名字，保证每次算出来顺序一致
  models.sort((a, b) => (b.total - a.total) || (b.count - a.count) || a.label.localeCompare(b.label));
  const totals = models.reduce((a, o) => ({
    count: a.count + o.count, tin: a.tin + o.tin, tout: a.tout + o.tout, tcache: a.tcache + o.tcache,
    dur: a.dur + o.dur, calls: a.calls + o.calls, tools: a.tools + o.tools, credits: a.credits + o.credits,
  }), { count: 0, tin: 0, tout: 0, tcache: 0, total: 0, dur: 0, calls: 0, tools: 0, credits: 0 });
  totals.total = totals.tin + totals.tout + totals.tcache;
  totals.credits += noModelCredits;   // credits 与 count 同一口径：Σ(各模型) + noModel = 全部
  // totals 覆盖**整个筛选集**（把没有模型记录的条目也算进 count），这样它与 /api/daily 的 totals 永远相等 ——
  // 同一屏里两个「合计条目数」差着一千多，看着就是错账。那部分 token 恒为 0，只是条目数要算上。
  // 于是口径是：Σ(各模型.count) + noModel == totals.count。
  totals.noModel = noModel;
  totals.count += noModel;
  return {
    ok: true, range: range || 'all', models, totals,
    // noModel 的条目单独计数、不进任何模型行：没有模型可归属，混进模型表只会让「条目数」对不上。
    // 页面把它作为**单独一行**显示出来，这样「各模型 + 无模型 = 全部」是能对得上账的。
    noModel, noModelTotal, multi,
  };
}

// ---------------- 工作指纹聚合（I15，2026-09-23） ----------------
// 回答「这周我在 yxz 分支上烧了多少」「升到 2.1.263 之后失败率变了吗」「plan 模式下的轮是不是更贵」。
// 三个维度（git 分支 / 权限模式 / 产品版本）各自按「值 × 条目数 / token / 耗时 / 失败轮数」分桶。
// 与按模型同一套筛选口径、同样不吃「条/页」窗口；只覆盖 claude（源里带这三样）。
// ⚠️ 覆盖边界（I15 条目约定）：别家**没有这些维度**，一律如实标「无此维度」，不印 0 ——
//    与 qoder「无 token 就不印 0」同一条约定。故返回里带 covered（哪些 agent 有数据），页面据此说明。
//    另：值取「轮内最后一次声明」（见 parsers/claude.mjs 的 curBranch/curVer/curPerm 游标注释），
//    未声明的轮（permissionMode 有约 302 轮没声明）落在 noVal 里单列，不冒充「default」。
function workAgg(agentFilter, projectFilter, range, from, to, work) {
  const { list, rb } = filterEntries(agentFilter, projectFilter, range, from, to, work);
  // 三个维度各自的分桶
  const dim = () => ({ buckets: new Map(), noVal: 0, noValTotal: 0, noValDur: 0 });
  const D = { branch: dim(), permMode: dim(), cliVer: dim() };
  const covered = new Set();   // 有工作指纹数据的 agent（如实标覆盖，不替无此维度的 agent 印 0）
  for (const e of list) {
    const wf = { branch: e.branch, permMode: e.permMode, cliVer: e.cliVer };
    for (const k of ['branch', 'permMode', 'cliVer']) {
      const v = wf[k];
      if (v == null || v === '') {
        // 无此维度 / 未声明：如实单列。claude 系以外全落这里（它们没有这些字段）。
        D[k].noVal++; D[k].noValTotal += e.total || 0; D[k].noValDur += e.dur || 0;
        continue;
      }
      covered.add(e.agent);
      let o = D[k].buckets.get(v);
      if (!o) { o = { key: v, count: 0, tin: 0, tout: 0, tcache: 0, total: 0, dur: 0, calls: 0, tools: 0, err: 0, agents: {} }; D[k].buckets.set(v, o); }
      o.count++;
      o.tin += e.tin || 0; o.tout += e.tout || 0; o.tcache += e.tcache || 0;
      o.dur += e.dur || 0; o.calls += e.calls || 0; o.tools += e.tools || 0;
      if (e.status === 'error') o.err++;
      o.agents[e.agent] = (o.agents[e.agent] || 0) + 1;
    }
  }
  const out = {};
  for (const k of ['branch', 'permMode', 'cliVer']) {
    const d = D[k];
    const rows = [...d.buckets.values()].map(o => {
      o.total = o.tin + o.tout + o.tcache;   // 同按天/按模型：合计现算，四个数必然自洽
      return o;
    });
    // 排序：token 多的在前（token 并列按条数、再按名字），保证每次算出来顺序一致 —— 与按模型同一套
    rows.sort((a, b) => (b.total - a.total) || (b.count - a.count) || String(a.key).localeCompare(String(b.key)));
    out[k] = { rows, noVal: d.noVal, noValTotal: d.noValTotal, noValDur: d.noValDur };
  }
  const totals = list.reduce((a, e) => ({
    count: a.count + 1, tin: a.tin + (e.tin || 0), tout: a.tout + (e.tout || 0), tcache: a.tcache + (e.tcache || 0),
    dur: a.dur + (e.dur || 0), calls: a.calls + (e.calls || 0), tools: a.tools + (e.tools || 0),
  }), { count: 0, tin: 0, tout: 0, tcache: 0, total: 0, dur: 0, calls: 0, tools: 0 });
  totals.total = totals.tin + totals.tout + totals.tcache;
  return {
    ok: true, range: range || 'all', label: rb ? rb.label : '全部时间',
    covered: [...covered].sort(),   // 有哪些 agent 真的带工作指纹数据（页面据此说明覆盖）
    totals, ...out,
  };
}

// I16：某个会话名下的**子 agent 会话**清单（只回答问题「这一坨是谁挂出来的」，不做树上卷）。
// 判据与 sessionsAgg 的树完全一致：条目上的显式 `parent` 外键 + 同一 agent + 同一归一化项目
//（session 值跨 agent/项目不唯一，不带上这两维就会把同名会话错挂成别人的孩子）。
// 返回逐子会话一行的小结；父会话不在当前筛选集合里时**如实返回空数组**，不编。
// ⚠️ seen 是**防环**用的，不是优化：源里理论上不该成环（父指向子、子指向父），但日志是外部写进来的，
//    真出现环时没有这道闸就是**无限递归**（服务端会栈溢出崩掉，而不是少显示一行）。
function sessionChildren(sessionKey, agent, projectK, seen) {
  const guard = seen || new Set([sessionKey]);
  const map = new Map();
  for (const e of entries.values()) {
    if (e.agent !== agent || e.parent !== sessionKey) continue;
    if (projKey(e.project) !== projectK) continue;
    const sk = e.session || '';
    if (!sk || guard.has(sk)) continue;
    let o = map.get(sk);
    if (!o) {
      o = { key: sk, name: e.name || null, sub: e.sub || null, subMode: e.subMode || null, turns: 0, total: 0, dur: 0, status: 'ok', from: e.time, to: e.time };
      map.set(sk, o);
    }
    o.turns++;
    o.total += e.total || 0;
    o.dur += e.dur || 0;
    if (e.time < o.from) o.from = e.time;
    if (e.time > o.to) o.to = e.time;
    if (e.status === 'error') o.status = 'error';
    if (!o.name && e.name) o.name = e.name;
    if (!o.sub && e.sub) o.sub = e.sub;
    if (!o.subMode && e.subMode) o.subMode = e.subMode;
  }
  const kids = [...map.values()].sort((a, b) => (a.from - b.from) || String(a.key).localeCompare(String(b.key)));
  // 子会话自己还可能挂子会话（dsh 的 delegationDepth 支持多层）：逐层的后代合计算进 subKids。
  // 每个子会话各带一份自己的 guard 副本（不能共用同一个 Set，否则兄弟分支会互相误伤）。
  for (const k of kids) {
    const nextSeen = new Set(guard); nextSeen.add(k.key);
    const grand = sessionChildren(k.key, agent, projectK, nextSeen);
    k.childCount = grand.length;
    k.subKids = grand.reduce((a, c) => a + 1 + (c.subKids || 0), 0);
    k.subTurns = k.turns + grand.reduce((a, c) => a + (c.subTurns || c.turns || 0), 0);
    k.subTotal = k.total + grand.reduce((a, c) => a + (c.subTotal || c.total || 0), 0);
    k.subDur = k.dur + grand.reduce((a, c) => a + (c.subDur || c.dur || 0), 0);
  }
  return kids;
}

// ---------------- 按会话聚合（R6） ----------------
// session 值来自各解析器落的条目字段（e.session），同一会话的多轮共享同一个值。
// 返回该 session 的全部轮次（时间正序）+ 会话级汇总。轮次正文不在这里给——前端拿到 id 列表后
// 仍走 /api/entry 懒加载，避免一个大会话一次性读爆。
function sessionAgg(sessionKey, agentFilter, projectFilter, work) {
  if (!sessionKey) return null;
  const list = [];
  const w = work || {};
  const bset = new Set(String(w.branch || '').split(',').map(s => s.trim()).filter(Boolean));
  const mset = new Set(String(w.permMode || '').split(',').map(s => s.trim()).filter(Boolean));
  const vset = new Set(String(w.cliVer || '').split(',').map(s => s.trim()).filter(Boolean));
  for (const e of entries.values()) {
    if (e.session !== sessionKey) continue;
    // agent / project 是**可选**收窄：都不传 == 老行为（只按 session 匹配）。
    // 为什么需要能传：session 值跨 agent、跨项目**都不保证唯一** —— 各解析器口径不同
    // （claude/buddy 用文件名、codex/dsh/kimi/gemini/cursor 用 sessionId、atomcode 用 .meta 的 name），
    // 本机实测 atomcode 就有不同项目下的同名 session（取的是标题）。只按 session 匹配会把
    // 两个不相干的会话并成一个，汇总数也就跟着错。
    // 保留「不传就照旧」是为了不改坏页面上已有的会话时间线弹层。
    if (agentFilter && e.agent !== agentFilter) continue;
    // project 参数按**归一化后的 key** 比（与 /api/daily、/api/models、页面项目下拉同一口径）；
    // 顺手也接受原始写法（projKey 幂等，两种都能命中），省得调用方纠结该传哪种。
    if (projectFilter) {
      const pk = projKey(e.project);
      if (pk !== projectFilter && pk !== projKey(projectFilter)) continue;
    }
    // I15 工作指纹筛选（可选）：与 filterEntries 同一套「逗号分隔集合」多值语义
    if (bset.size && !bset.has(e.branch)) continue;
    if (mset.size && !mset.has(e.permMode)) continue;
    if (vset.size && !vset.has(e.cliVer)) continue;
    list.push(e);
  }
  if (!list.length) return null;
  list.sort((a, b) => a.time - b.time);   // 时间正序：会话时间线要从头看到尾
  const agg = {
    session: sessionKey,
    count: list.length,
    tin: 0, tout: 0, tcache: 0, dur: 0, calls: 0, tools: 0,
    agents: {}, projects: {},
    from: list[0].time, to: list[list.length - 1].time,
    models: [],
  };
  const modelSet = new Set();
  for (const e of list) {
    // I14：会话名（各 agent 的「产品自写标题」）。会话列表走 sessionsAgg 已经能拿到，这里补一份
    // 是为了**只按 key 打开会话**的路径：页面 sess-view 的标题是 `sessPick.name || sessCur.session`，
    // 不带 sessPick 直接进来时会退回裸 UUID。名字可能只落在其中几轮上（ai-title 只写一次），
    // 任一轮有值即可，故取第一个命中的。
    if (!agg.name && e.name) agg.name = e.name;
    agg.tin += e.tin || 0; agg.tout += e.tout || 0; agg.tcache += e.tcache || 0;
    agg.dur += e.dur || 0; agg.calls += e.calls || 0; agg.tools += e.tools || 0;
    agg.agents[e.agent] = (agg.agents[e.agent] || 0) + 1;
    agg.projects[e.project] = (agg.projects[e.project] || 0) + 1;
    for (const m of e.models || []) modelSet.add(m);
  }
  agg.models = [...modelSet];
  // I16：单会话视图要能点着跳到父 / 子会话，所以把「这一坨到底是哪个 agent / 哪个项目」也直接给出，
  // 免得页面从 agents/projects 那两个计数对象里猜（它们是多值映射，猜错了跳转就跳飞）。
  agg.agent = list[0].agent; agg.project = list[0].project; agg.projectKey = projKey(list[0].project);
  // I16 子 agent 拓扑：这一坨轮次自己的谱系（取任一轮带值即可，解析器落在每一轮上）。
  //   parent = 父会话 id；depth = 深度（0/undefined = 人开的）；sub/subMode = 子 agent 的派活描述。
  for (const e of list) {
    if (!agg.parent && e.parent) agg.parent = e.parent;
    if (e.depth && (!agg.depth || e.depth > agg.depth)) agg.depth = e.depth;
    if (!agg.sub && e.sub) agg.sub = e.sub;
    if (!agg.subMode && e.subMode) agg.subMode = e.subMode;
  }
  // 子会话清单（**只在这一屏回答「这个会话下面挂了哪些子 agent」**）：按同一套 agent/project 口径
  // 在内存条目里反查 parent === 本会话 key 的会话。与 sessionsAgg 的树同一份判据（显式外键），
  // 不是按时间推的。父不在筛选里时这里会空 —— 如实空着，不编。
  agg.children = sessionChildren(agg.session, list[0]?.agent || '', projKey(list[0]?.project));
  agg.subTurns = list.length;
  agg.subTotal = agg.tin + agg.tout + agg.tcache;
  agg.subDur = agg.dur;
  for (const c of agg.children) {
    agg.subTurns += c.turns; agg.subTotal += c.total; agg.subDur += c.dur;
  }
  // ctx / ctxUsed / credits / ctxRatio / 压缩画像 按需透传：
  // qoder 的 token 恒为 0、真实用量在积分与上下文占比（见 parsers/claude.mjs 的 emitClaudeTurns），
  // 会话视图的逐轮用量图靠这些字段决定画「积分模式」还是「token 模式」；普通 agent 这些键是
  // undefined，JSON 序列化时自动丢掉，响应体积零增量。
  // 压缩画像（compacts / compPre / compPost / compDrop / compMs / compAuto / compManual，I12）自
  // 2026-09-28 起 claude 与 qoder 都会落：会话视图的压缩红点 tooltip 与会话级压缩小结要读它们，
  // 所以必须在这里一起透传 —— 漏一个，图上就只剩「压过几次」、丢多少/等多久整块读不到。
  // ctxTbl 不走解析器、只问已落盘的 srcs.kind：CTX_WINDOW_KINDS 里那几家的窗口容量日志里根本没有，
  // 是分母只能查表（可在侧栏「上下文窗口」改）的 —— 占用率线据此标出「这个百分比是查表算的」，
  // 免得表里填错时曲线读起来像个硬事实。自带窗口的 agent 为 undefined，同样零增量。
  agg.entries = list.map(e => ({ id: e.id, time: e.time, dur: e.dur, status: e.status, preview: e.preview, agent: e.agent, project: e.project, nollm: e.nollm, tin: e.tin, tout: e.tout, tcache: e.tcache, total: e.total, models: e.models, calls: e.calls, tools: e.tools, ctx: e.ctx, ctxUsed: e.ctxUsed, credits: e.credits, ctxRatio: e.ctxRatio, compacts: e.compacts, compPre: e.compPre, compPost: e.compPost, compDrop: e.compDrop, compMs: e.compMs, compAuto: e.compAuto, compManual: e.compManual, branch: e.branch, permMode: e.permMode, cliVer: e.cliVer, rdur: e.rdur, rdurMsg: e.rdurMsg, timeUnknown: e.timeUnknown || undefined, ctxTbl: CTX_WINDOW_KINDS.has(srcs.get(e.id)?.kind) ? true : undefined }));
  return { ok: true, ...agg };
}

// ---------------- 会话列表聚合（R6） ----------------
// 与 sessionAgg 的分工：那个给「**一个**会话的轮次」（页面弹层用），这个给「**会话列表** + 会话级汇总」。
//
// 为什么必须服务端算：会话级汇总（累计 token / 总耗时 / 起止）要覆盖**全量索引**，而页面手里
// 只有最多 5000 条的窗口，客户端分组会漏会话、汇总会偏。这里与 /api/daily、/api/models 一样
// **不吃「条/页」窗口** —— 聚合口径不能随显示档位变。
//
// 聚合键是 agent + session，**不是只用 session**：各解析器对 session 的取值口径不同
// （claude/buddy 用文件名、codex/dsh/kimi/gemini/cursor 用 sessionId、atomcode 用 .meta 的 name），
// 跨 agent 不保证唯一，只按 session 归并会把不同 agent 的同名会话错误合并。
// 注意 sessionAgg（/api/session?key=）仍是「只按 session 匹配」的老口径 —— 本次**不动它**，
// 免得改坏页面上已有的会话时间线弹层。
// 「这个来源的解析器会产出逐事件轨迹（events[]）」的能力名单 —— 目前有 dsh / zcode / traedb / opencode / kilo / hermes / devindb。
// ⚠️ 名单里是 **kind**（条目 srcs 里存的来源 kind），不是 agent 名：两者不总是一回事
//    （trae 系列 agent 名是 trae/traework，DB 解析 kind 是 traedb；dsh/zcode/opencode 恰好同名）。
// 页面靠 /api/sessions 的 hasTimeline 决定要不要挂「没有逐事件时间」的告警；把名单收在这里，
// 是为了让「接一个新 agent」这件事只需要改**一行**，而不是去满仓库找散落的 agent === 'dsh'。
const EVENT_AGENTS = new Set(['dsh', 'zcode', 'traedb', 'opencode', 'kilo', 'hermes', 'devindb']);

function sessionsAgg(agentFilter, projectFilter, range, from, to, limit, work) {
  const { list } = filterEntries(agentFilter, projectFilter, range, from, to, work);
  const map = new Map();
  for (const e of list) {
    const sk = e.session || '';
    if (!sk) continue;                    // 没有会话标识的条目归不了组：如实跳过，不塞进一个假会话
    // 聚合键 = agent + project + session：session 值跨 agent、跨项目都不保证唯一
    // （atomcode 的 session 取的是 .meta 的标题，本机实测不同项目下有重名），
    // 只用 agent+session 会把两个不相干的会话并成一个。
    const key = e.agent + '\u0000' + projKey(e.project) + '\u0000' + sk;
    let o = map.get(key);
    if (!o) {
      o = {
        key: sk, agent: e.agent, project: e.project, projectKey: projKey(e.project), name: e.name || null,
        turns: 0, tin: 0, tout: 0, tcache: 0, dur: 0, calls: 0, tools: 0,
        from: e.time, to: e.time, status: 'ok', modelSet: new Set(), hasTimeline: false,
      };
      map.set(key, o);
    }
    o.turns++;
    o.tin += e.tin || 0; o.tout += e.tout || 0; o.tcache += e.tcache || 0;
    o.dur += e.dur || 0; o.calls += e.calls || 0; o.tools += e.tools || 0;
    if (e.time < o.from) o.from = e.time;
    if (e.time > o.to) o.to = e.time;
    if (e.status === 'error') o.status = 'error';   // 会话里有失败轮就标出来，不静默藏掉
    if (!o.name && e.name) o.name = e.name;          // 标题可能只落在其中几轮上
    // I16 子 agent 拓扑：谱系取**任一轮带值即可**（解析器把它落在每一轮上）。
    //   parent = 父会话 id（源头显式外键：dsh 的 session 头 parentSession、claude 的 subagents/
    //   目录层级、zcode/opencode 的 session.parent_id、hermes 的 parent_session_id）。
    //   ⚠️ 不按时间区间推父子 —— 那条路在 2026-09-28 的前置闸里被证伪（atomcode 那 11047 对
    //   嵌套 100% 是「time 取轮终点 + 时间未知回落 updated_at」两处缺陷叠出来的噪声）。
    if (!o.parent && e.parent) o.parent = e.parent;
    if (e.depth && (!o.depth || e.depth > o.depth)) o.depth = e.depth;
    if (!o.sub && e.sub) o.sub = e.sub;                                   // 子 agent 的派活描述
    if (!o.subMode && e.subMode) o.subMode = e.subMode;                   // continuable / one-shot
    if (e.timeUnknown) o.timeUnknown = true;                              // I16/D2：时间未知如实带上
    // hasTimeline 按**条目来源的 kind** 判（srcs），不按 agent 名 —— 两者不总是一回事：
    // trae 系列 agent 的 DB 解析 kind 是 'traedb'，agent 名却是 trae/traework（详见下方名单注释）。
    if (!o.hasTimeline && EVENT_AGENTS.has(srcs.get(e.id)?.kind)) o.hasTimeline = true;
    for (const m of e.models || []) o.modelSet.add(m);
  }
  const sessions = [...map.values()];
  for (const o of sessions) {
    o.total = o.tin + o.tout + o.tcache;   // 同按天/按模型聚合：合计现算，四个数必然自洽
    o.models = [...o.modelSet];
    delete o.modelSet;
    // 逐事件轨迹的能力声明由上方 EVENT_AGENTS 名单给出（hasTimeline 已在聚合循环里按 srcs.kind 落定）。
    // ⚠️ 这是**能力声明**（一份名单），不是**探测**（没去翻这一轮的 events）—— 所以谁把逐事件接进
    //    别的解析器（claude/codex/kimi，见任务文档 §8 的「明确不在本次范围」），**必须把这个 kind 加进
    //    EVENT_AGENTS**；否则那个 agent 会一边正常渲染轨迹、一边在顶上挂着「没有逐事件时间」的告警。
    //    页面侧另有一道自纠正兜底（真加载到 events 就不显示那条告警，见 agent-acta-page.html 的
    //    sessHasEvents），所以最坏情况是「名单漏更新」，不会是「明明有数据却被藏起来」。
  }
  // ---- I16：按显式谱系上卷出树（父子 + 子树合计） ----
  // 三件事必须在**分页（limit）之前**做完，否则截断会把父子拆散：
  //   ① 认父：父会话必须与子在同一 agent + 同一项目下（session 值跨 agent/项目不唯一，见上面的聚合键）；
  //   ② 认不出父的（父不在当前筛选窗口 / 源里根本没有那个父 / 父被淘汰）→ 如实**降级成根**，
  //      不硬造一个不存在的父节点；
  //   ③ 子树合计（subTurns / subTotal / subDur）**含自身**，回答原来那个「这一坨一共花了多少」。
  const byKey = new Map(sessions.map(s => [s.agent + '\u0000' + s.projectKey + '\u0000' + s.key, s]));
  // ⚠️ 先给**所有**会话建好 children 数组，再挂孩子：父会话在数组里的位置是任意的（这边按
  //    map 插入序、没有任何排序保证），边遍历边初始化会让「父排在子后面」的那些 p.children.push
  //    直接 TypeError —— 而 /api/sessions 一崩，整个页面连会话列表都出不来（不是少一行的问题）。
  for (const s of sessions) s.children = [];
  for (const s of sessions) {
    if (!s.parent) continue;
    const p = byKey.get(s.agent + '\u0000' + s.projectKey + '\u0000' + s.parent);
    // 自环（源里 parent 指回自己）也当没有父，免得后面 DFS 无限转
    if (p && p !== s) { s.parentKey = p.key; p.children.push(s); }
  }
  for (const s of sessions) {
    if (!s.children.length) delete s.children;
  }
  // 子树合计：从根往下推（先算 depth 序，父子不会成环 —— 上面的自环已排除；真出现环也只是这一支不计入）
  const roots = sessions.filter(s => !s.parentKey);
  const seen = new Set();
  const walk = s => {
    if (seen.has(s)) return null;   // 防御：万一源数据成环，只算一次
    seen.add(s);
    let turns = s.turns, total = s.total, dur = s.dur, tin = s.tin, tout = s.tout, tcache = s.tcache, calls = s.calls, tools = s.tools;
    let kids = 0;
    for (const c of s.children || []) {
      const r = walk(c);
      if (!r) continue;
      turns += r.turns; total += r.total; dur += r.dur;
      tin += r.tin; tout += r.tout; tcache += r.tcache; calls += r.calls; tools += r.tools;
      kids += 1 + r.kids;
    }
    s.subTurns = turns; s.subTotal = total; s.subDur = dur;
    s.subTin = tin; s.subTout = tout; s.subTcache = tcache; s.subCalls = calls; s.subTools = tools;
    s.subKids = kids;                      // 后代（子 agent）会话数，不含自己
    s.subSelf = turns === s.turns && total === s.total;   // true = 没有子，页面不必显示「合计」那一列
    return { turns, total, dur, tin, tout, tcache, calls, tools, kids };
  };
  for (const r of roots) walk(r);
  // 兜底：成环的会话不会从任何根走到，单独各算各的（不让它们带着 undefined 的 sub* 出去）
  for (const s of sessions) if (!seen.has(s)) walk(s);
  sessions.sort((a, b) => (b.to - a.to) || String(a.key).localeCompare(String(b.key)));
  const capped = sessions.length > limit;
  return { ok: true, range: range || 'all', count: sessions.length, capped: capped ? 1 : 0, sessions: capped ? sessions.slice(0, limit) : sessions };
}

// ---------------- 排行分析（R8） ----------------
// 只做用量统计没有的两个时延维度：最慢轮 TopN（可跳回原条目）、时延 p50/p95。
// 按 agent/项目/时间范围同一套筛选口径（filterEntries），不吃「条/页」窗口。
// R8 剩余两项（byTools / byCacheRate）已于 v2.39 结案，见 history.md「R8 排行与分析」。
// I6 追加 byToolFails（工具失败画像），数据来自搜索分片，见下面 TOOL_FAIL_TIERS 的说明。
// slowest 字段与其形状保持不动，mcp-server 的 slowest_turns 与既有断言不受影响。

// I6：**哪些 kind 的详情带得出「结构化工具失败标志」**（`tools[].error`，源头给的就是布尔/字符串 flag，
// 不是正文里的 error 字样）。与 EVENT_AGENTS 同一类东西 —— 一份**能力声明**，接新 agent 改这里一行。
// 三档的差别必须让用户看得见：只有 signal 档谈得上「谁最常失败」，另外两档的画像是空的，
// 而空的原因是「源头没这个信息」，不是「这个 agent 从不出错」（把 0 印成结论就是造假日绿，
// 与 qoder 那边「拿不到 token 就不印 0」同一条约定）。
// 各家信号出处：dsh:290 / zcode:265 / traedb:247 / opencode:127 / hermes:199 / gemini:172 /
//   devindb:334 / atomcode:279 / claude:219(详情回填) / kimi:243 / buddy:253 / doubao:399 / minimax:482 /
//   openclaw:468(详情回填 toolResult.isError) / copilot:187 / kilo**同 opencode**（复用 opencode.mjs 的
//   addTool，工具 state.status 的 error 判定即 opencode:127 那一处） / trace 系由 span 现算（本文件 entryContent 的 trace 支路）。
//   cline 的失败信号不在整块 isError 上，而是 tool_result.content[] **逐项**的 success===false / error
//   （一次批量调用可以只错一项），见 parsers/cline.mjs 的 toolResultText。
// ⚠️ signal 档 = 「有 `tools[].error` 信号」，但**超时与软失败不在这一位里**（它们各自是另外的位，
//   见下面 TOOL_TIMEOUT_SIGNAL_KINDS）。本机实测 141 份 claude 转录里 30 条 `toolUseResult.timedOutAfterMs`，
//   其 `tool_result.is_error` **一律明确写着 false**（不是缺键）⇒ 只看 `error` 会把它读成"核对过、没问题"。
//   I13 已把这一层补上：`tf` 扩成 `{名:{e,t,s}}` 三分类（`SHARD_V` 2→3），claude 那一档现在**含超时**。
//   另有 41 条第三态（`returnCodeInterpretation` 的 No matches found / Files differ）与 16 条
//   `staleRecovered` 实测 `is_error` 也全是 false ⇒ 它们进 `s` 单独一列，**不并进失败率**
//   （把"rg 没搜到"算成失败就是把最常见的正常结果读成故障）。
// noFlag 那几家是查过代码才归进来的：codex 的 error 建好后从不赋值（codex.mjs:172）、
//   tracecode/tracework 源里明写「工具返回不落地」（tracecode.mjs:335）、generic 的 rules 没有 result 规则。
const TOOL_FAIL_TIERS = {
  signal: new Set(['claude', 'jsonl', 'dsh', 'zcode', 'traedb', 'opencode', 'kilo', 'hermes', 'devindb', 'gemini',
    'kimi', 'buddyjsonl', 'doubao', 'minimax', 'copilot', 'trace', 'atomcode', 'openclaw', 'cline', 'buddyext']),
  noDetail: new Set(['cursor', 'codearts']),
  noFlag: new Set(['codex', 'tracecode', 'tracework', 'generic-jsonl']),
};
// I13：哪些 kind 的详情**额外**带得出超时 / 软失败的结构化标志（转录里的 `toolUseResult`）。
// 与 TOOL_FAIL_TIERS 同一类东西 —— 一份**能力声明**，接新 agent 改这里一行。
// v1 只有 claude 系：claude 与 qoder-cn 共用 claude 解析器、共用这个 kind，两家转录实测都带
//   `timedOutAfterMs` / `returnCodeInterpretation` / `staleRecovered`（claude 30 / 41 / 16，qoder-cn 80 / 72 / 29）。
// ⚠️ 别家不在这个集合里 = 「源里根本没有这一层」，不是「一次没超时」⇒ 聚合侧把它们的 t/s 置 null，
//   页面对这一档**不印 0**（与 noFlag / qoder「拿不到 token 就不印 0」同一条约定）。
// ⚠️ 别把 `jsonl` 加进来：那是 atomcode 的解析器 kind（见 search.mjs 的 parserKindOf），不是 claude。
const TOOL_TIMEOUT_SIGNAL_KINDS = new Set(['claude']);
// 没点名的 kind 一律 'unknown'：宁可说「口径里没登记过这个来源」，也不替它默认「有信号」。
function toolFailTier(kind) {
  if (TOOL_FAIL_TIERS.signal.has(kind)) return 'signal';
  if (TOOL_FAIL_TIERS.noDetail.has(kind)) return 'noDetail';
  if (TOOL_FAIL_TIERS.noFlag.has(kind)) return 'noFlag';
  return 'unknown';
}
// 分母下限：一次没试过的工具与只跑过一次的偶发失败都不配上排行。实测本机样本里
// `StopCommand 1/1` 与 `ExitPlanMode 1/2` 会顶着 100% 排到最前，而 `Bash` 只有 1.0% 却因量大霸榜 ——
// 低于这个下限的行照样返回（带着 `lowDenom` 标记），由页面排到「样本不足」那一档，不当结论。
const TOOL_FAIL_MIN_TOTAL = 10;

function analyzeAgg(agentFilter, projectFilter, range, from, to, topN, work) {
  const { list } = filterEntries(agentFilter, projectFilter, range, from, to, work);
  const durs = list.map(e => e.dur || 0).filter(d => d > 0).sort((a, b) => a - b);
  // I17 非 LLM 时间分解：dur 是墙钟（首条→末条），会混进用户离开/隔夜的 idle gap（本机实测
  // 虚高 2.5 倍）。有 rdur（产品自报 turn_duration.durationMs）的条目才是「真实工作时间」。
  // 目前只有 claude 有 rdur，别家回落墙钟 —— 页面按 aCount（有多少轮是真值）如实说明覆盖度，
  // 不把「没这句话」读成「实际时长 = 墙钟」（那正是 I17 要修的错误）。
  const adurs = list.map(e => e.rdur > 0 ? e.rdur : 0).filter(d => d > 0).sort((a, b) => a - b);
  const adurCount = list.filter(e => e.rdur > 0).length;   // 本轮筛选里拿到真值的轮数
  const pct = p => durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * p))] : 0;
  const apct = p => adurs.length ? adurs[Math.min(adurs.length - 1, Math.floor(adurs.length * p))] : 0;
  const row = e => ({ id: e.id, time: e.time, dur: e.dur, rdur: e.rdur > 0 ? e.rdur : undefined, agent: e.agent, project: e.project, preview: e.preview, status: e.status, models: e.models, total: e.total, tcache: e.tcache, branch: e.branch, permMode: e.permMode, cliVer: e.cliVer });
  const slowest = [...list].sort((a, b) => (b.dur || 0) - (a.dur || 0)).slice(0, topN).map(row);
  const byTools = [...list].sort((a, b) => (b.tools || 0) - (a.tools || 0) || (b.dur || 0) - (a.dur || 0)).slice(0, topN)
    .map(e => ({ ...row(e), tools: e.tools || 0 }));
  // 缓存命中率：分母为 total（服务端各轮 total 恒 = tin+tout+tcache，见 dailyAgg 的口径注释）。
  // 分母为零 = 该轮没有任何 token 记录（cursor 转录 / 失败轮），命中率无意义，塞进去反而是噪声。
  const byCacheRate = list.filter(e => (e.total || 0) > 0)
    .map(e => ({ ...row(e), rate: (e.tcache || 0) / e.total }))
    .sort((a, b) => (b.rate - a.rate) || (b.tools || 0) - (a.tools || 0) || (b.time || 0) - (a.time || 0))
    .slice(0, topN);
  // ---- I6 工具失败画像 ----
  // 分子来自搜索分片（search.mjs 建索引那一遍**顺手**抽的 `tf`，见其 indexFailsOf），这里只是一次
  // Map 累加、不再读盘 —— 详情侧读一次 claude 转录实测 41ms/条，为画像单开一遍就是分钟级。
  // 分母走条目自带的 `toolNames`，但**只累加分子那一批同集合的轮**：没被索引到的轮连分母一起不计，
  // 否则率会被「根本没看过的轮」稀释成假的低值。
  const tfRows = new Map();    // agent\0name -> {agent, name, fail, err, timeout, soft, total, hasTs}
  const tfCov = new Map();     // agent\0kind -> {agent, kind, tier, tsSig, turns, known, failTurns, softTurns}
  const tfRow = (agent, name) => {
    const k = agent + '\u0000' + name;
    let r = tfRows.get(k);
    if (!r) { r = { agent, name, fail: 0, err: 0, timeout: 0, soft: 0, total: 0, hasTs: 0 }; tfRows.set(k, r); }
    return r;
  };
  for (const e of list) {
    if (!(e.tools > 0)) continue;              // 没有工具调用的轮：对这个画像既不分子也不分母
    const kind = srcs.get(e.id)?.kind || '';
    const tsSig = TOOL_TIMEOUT_SIGNAL_KINDS.has(kind) ? 1 : 0;   // I13：这个来源带不带超时/软失败信号
    const ck = e.agent + '\u0000' + kind;
    let c = tfCov.get(ck);
    if (!c) { c = { agent: e.agent, kind, tier: toolFailTier(kind), tsSig, turns: 0, known: 0, failTurns: 0, softTurns: 0 }; tfCov.set(ck, c); }
    c.turns++;
    const tf = toolFailsOf(e.id);
    if (tf === undefined) continue;            // 未索引 / 详情读不出 = **未知**，绝不能当 0
    c.known++;
    for (const [nm, n] of Object.entries(e.toolNames || {})) {
      const r = tfRow(e.agent, nm);
      r.total += n || 0;
      r.hasTs = tsSig;                         // 行级记下「这一行的 t/s 是真值还是没信号」
    }
    if (tf === 0) continue;
    let hard = 0, softOnly = 0;
    for (const [nm, v] of Object.entries(tf)) {
      const r = tfRow(e.agent, nm);
      r.err += v.e || 0; r.timeout += v.t || 0; r.soft += v.s || 0;
      // fail = 出错 + 超时：I13 的定案是**超时算失败**（它就是失败）。软失败**不进** fail ——
      // 它是单列的一档（"rg 没搜到"是正常结果），并进失败率就是把正常读成故障。
      const h = (v.e || 0) + (v.t || 0);
      r.fail += h;
      hard += h; softOnly += (v.s || 0);
    }
    // 轮级也照同一把尺：只有软失败的那一轮不算「含失败工具的轮」，另计 softTurns，
    // 否则页面上「含失败工具的轮」会比失败排行多出一批只搜了个空的轮。
    if (hard > 0) c.failTurns++;
    else if (softOnly > 0) c.softTurns++;
  }
  // 排序按**绝对失败次数**倒序 —— 「最常失败」问的就是次数；率只作为并列维度与页面第二列。
  // 为什么不用率排：样本 1 次的工具能排到 100%（见 TOOL_FAIL_MIN_TOTAL 上方那句实测）。
  const byToolFails = [...tfRows.values()]
    .filter(r => r.fail > 0)
    .map(r => ({ ...r, rate: r.total > 0 ? r.fail / r.total : null, lowDenom: r.total < TOOL_FAIL_MIN_TOTAL ? 1 : 0,
      // I13：这一行没有超时/软失败信号的（别家），把 t/s 置 **null 而不是 0** —— 页面据此不印 0，
      // 否则「这个 agent 一次没超时」会被读成结论，而真相是「源里没有这一层」。
      timeout: r.hasTs ? r.timeout : null, soft: r.hasTs ? r.soft : null }))
    .sort((a, b) => (b.fail - a.fail) || ((b.rate || 0) - (a.rate || 0)) || String(a.name).localeCompare(String(b.name)));
  // I13：三分类的**总数**按全量行算（不是按 topN 截断后的那些行，也不是按 fail>0 过滤后的那些）——
  // 否则「只有软失败、从没硬失败」的工具会被漏掉，而那正是最容易被读成"没问题"的一批。
  const tfTotals = [...tfRows.values()].reduce((o, r) => {
    o.err += r.err || 0;
    o.timeout += r.hasTs ? (r.timeout || 0) : 0;   // 没信号的来源不计数（也不印 0）
    o.soft += r.hasTs ? (r.soft || 0) : 0;
    return o;
  }, { err: 0, timeout: 0, soft: 0 });
  return {
    ok: true,
    count: list.length,
    p50: pct(0.5), p95: pct(0.95),
    maxDur: durs.length ? durs[durs.length - 1] : 0,
    // I17：实际耗时分位数（有 rdur 的轮）。aCount = 本轮筛选里拿到产品自报真值的轮数
    //（页面据此说明「实际」覆盖到哪些轮，别家回落墙钟不冒充真值）。
    aP50: adurs.length ? apct(0.5) : 0, aP95: adurs.length ? apct(0.95) : 0,
    aMax: adurs.length ? adurs[adurs.length - 1] : 0, aCount: adurCount,
    slowest,
    byTools,
    byCacheRate,
    // topN 只截工具行；覆盖度那几张表按 agent 数收敛，不跟 topN 走（它是图例不是排行）。
    toolFails: {
      minTotal: TOOL_FAIL_MIN_TOTAL,
      rows: byToolFails.slice(0, topN),
      truncated: byToolFails.length > topN ? 1 : 0,
      totalKinds: byToolFails.length,
      // I13 三分类总数（error / timeout / soft），全量行口径，见上面 tfTotals
      totals: tfTotals,
      // 每个 agent×kind 一档：turns = 本轮筛选里带工具的轮数，known = 其中索引到的，failTurns = 有失败的
      // （tsSig = 这一档带不带超时/软失败信号；softTurns = 只出现过软失败的轮，不进 failTurns）
      // 顺序按样本量倒排（页面图例直接跟着这个顺序渲染，不再排一次）
      agents: [...tfCov.values()].sort((a, b) => (b.turns - a.turns) || a.agent.localeCompare(b.agent)).map(c => ({ ...c,
        turnRate: c.known > 0 ? c.failTurns / c.known : null,
        unknown: c.turns - c.known })),
      building: searchBuilding() ? 1 : 0,
    },
  };
}

// ---------------- broadcast ----------------
// 条目被移除后侧栏计数会失真（remove 事件不带全量快照），这里给前端一份权威计数
function counts() {
  const agents = {}, projects = {};
  for (const e of entries.values()) { agents[e.agent] = (agents[e.agent] || 0) + 1; projects[e.project] = (projects[e.project] || 0) + 1; }
  return { agents, projects };
}

function dirtyEntries() {
  const arr = [];
  for (const id of dirty) { const e = entries.get(id); if (e) arr.push(e); }
  dirty.clear();
  return arr;
}
const sseClients = new Set();  // 当前连接的 SSE 页面（/api/events）
let bseq = 0;                  // SSE 事件序号
let lastActivity = Date.now(); // 「有人看」或「有新日志」的活动时刻，空闲自停据此判断（见 checkIdle）
let lastAlertSig = '';         // 上次推给前端的命中集合签名（用于判断是否需要发 alert 事件）
let alertChanged = false;      // 命中集合与上次相比变了（不论是否有 SSE 连接，状态先记下）
function sseWrite(res, msg) {
  try { res.write('data: ' + JSON.stringify(msg) + '\n\n'); return true; }
  catch { sseClients.delete(res); return false; }
}
function broadcast() {
  // 有新日志就算「有活动」——哪怕页面没开，也要在 checkIdle 里重新计时，
  // 否则「正在跑会话但没开页面」会被误判成空闲（本机 3s 一轮，新条目是常态）。
  if (dirty.size || removedIds.length || agentNotices.length) lastActivity = Date.now();
  // 异常巡检（R9）：任何一轮扫描后有新日志（dirty）或者规则被改动（alertDirty）都重算命中，
  // 保证「新产生的异常条目无需人工翻找即可被提示」。扫完一批就重算一次 + 推送摘要。
  if (dirty.size || removedIds.length || alertDirty) {
    recomputeAlerts();
    const sig = [...alertHits.keys()].sort().join('|');
    if (sig !== lastAlertSig) { lastAlertSig = sig; alertChanged = true; }
  }
  if (!sseClients.size) { dirty.clear(); removedIds.length = 0; agentNotices.length = 0; return; }
  const list = dirtyEntries();
  const needCounts = list.length || removedIds.length;
  const c = needCounts ? counts() : null; // 权威计数随事件下发，避免前端本地累加漂移
  if (list.length) {
    if (list.length > 5000) {
      // 单轮变化过大（如整库 rescan），整表重取比逐条补更省
      for (const res of [...sseClients]) sseWrite(res, { type: 'resync', seq: ++bseq });
    } else {
      // 分批推完，不截断 —— 旧版 slice(-500) 会永久丢掉溢出条目
      for (let i = 0; i < list.length; i += 500) {
        const msg = { type: 'update', seq: ++bseq, entries: list.slice(i, i + 500), agents: c.agents, projects: c.projects };
        for (const res of [...sseClients]) sseWrite(res, msg);
      }
    }
  }
  if (removedIds.length) {
    const msg = { type: 'remove', seq: ++bseq, ids: removedIds.splice(0), agents: c.agents, projects: c.projects };
    for (const res of [...sseClients]) sseWrite(res, msg);
  }
  while (agentNotices.length) {
    const n = agentNotices.shift();
    const msg = { type: 'agents', seq: ++bseq, ...n, agents: agentsList() };
    for (const res of [...sseClients]) sseWrite(res, msg);
  }
  // 异常巡检（R9）：命中集合变化时单独推一个 alert 事件（带摘要 + 命中 id 列表），
  // 前端据它点亮徽章 / 更新「只看异常」的集合，不用重拉快照。
  // 这里不走 settings（那是改扫描/自停用的），另起 type 独立消费。
  if (alertChanged) {
    alertChanged = false;
    const msg = { type: 'alert', seq: ++bseq, ids: [...alertHits.keys()], summary: alertSummary() };
    for (const res of [...sseClients]) sseWrite(res, msg);
  }
}
// 设置项（扫描节奏 / 空闲自停）是全局的，改完广播给所有标签页，避免两个页面显示不一致
function broadcastSettings() {
  const msg = { type: 'settings', seq: ++bseq, scanMs, idleExitMs };
  for (const res of [...sseClients]) sseWrite(res, msg);
}
function setScanMs(ms) {
  if (!SCAN_CHOICES.includes(ms)) return { ok: false, error: '不支持的刷新频率（0/1000/2000/3000/5000/10000）' };
  scanMs = ms;
  saveConfig();
  scheduleNextScan();  // 立刻按新节奏重排；0 会清掉定时器 = 不实时更新
  broadcastSettings();
  return { ok: true, scanMs };
}
function setIdleExitMs(ms) {
  if (!IDLE_CHOICES.includes(ms)) return { ok: false, error: '不支持的空闲自停（0/1800000/7200000/21600000）' };
  idleExitMs = ms;
  lastActivity = Date.now(); // 改设置本身就是一次活动，别让改完立刻到期
  saveConfig();
  broadcastSettings();
  return { ok: true, idleExitMs };
}

// ---------------- 上下文窗口表（设置面板那一个入口） ----------------
// 生效表 = 内置默认 + 用户条目；用户条目 value<=0 记作停用（off:true），内置默认也能这样关掉。
function ctxWindowRows() {
  const rows = new Map();
  for (const [k, v] of Object.entries(CTX_WINDOWS_DEFAULT)) rows.set(k, { name: k, value: v, builtin: true, user: false, off: false });
  for (const [k, v] of Object.entries(ctxUser)) {
    const r = rows.get(k) || { name: k, value: 0, builtin: false, user: true, off: false };
    r.user = true;
    if (v > 0) { r.value = v; r.off = false; } else r.off = true;
    rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => (a.off - b.off) || (b.builtin - a.builtin) || a.name.localeCompare(b.name));
}
// 日志里出现过、但表里查不出窗口的模型 —— 设置面板据此列「待填」，用户不用自己去翻日志抄模型名。
// 只管 CTX_WINDOW_KINDS：别的 agent 自带窗口字段（atomcode 的 .meta、cursor 的 composerData），
// 这张表对它们没用、也不该去覆盖它们。
function ctxUnknownModels() {
  const seen = new Map();
  for (const [id, e] of entries) {
    const s = srcs.get(id);
    if (!s || !CTX_WINDOW_KINDS.has(s.kind)) continue;
    for (const m of (e.models || [])) {
      const name = String(m || '').trim();
      if (!name || windowOf([name])) continue;      // 命中的不算待填
      if (name.startsWith('<')) continue;           // `<synthetic>`：Claude Code 自己造的占位模型名，不是真模型
      seen.set(name, (seen.get(name) || 0) + 1);
    }
  }
  return [...seen].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n);
}
// 改完表要**就地重算**已有条目的 ctx：只改表不回头改条目的话，已经扫出来的卡片要等日志文件下次
// 增长才会变（ctx 是在 emit 那一刻定下的），看着就像没生效。CTX_WINDOW_KINDS 里这几个的 ctx
// 本来就只由这张表决定，直接覆盖即可；别的 agent 的 ctx 来自它们各自的源头，一律不碰。
function applyCtxWindows() {
  let n = 0;
  for (const [id, e] of entries) {
    if (!CTX_WINDOW_KINDS.has(srcs.get(id)?.kind)) continue;
    const w = windowOf(e.models);
    if (w !== e.ctx) { e.ctx = w; dirty.add(id); n++; }
  }
  if (n) { sorted.cache = null; broadcast(); }
  return n;
}
// 整表替换（页面上点保存时提交的就是完整的用户表）。没有值的条目 = 停用，照常写在 ctxUser 里
function setCtxWindows(list) {
  const next = {};
  for (const it of (Array.isArray(list) ? list : [])) {
    const name = String((it && it.name) || '').trim();
    if (!name || name.length > 200) continue;
    const v = Number(it && it.value);
    const val = v > 0 ? Math.round(v) : 0;
    // 页面提交的是**整张表**（含内置行），原封不动提交回来的内置默认不能落盘 ——
    // 否则「没改过」也会变成用户条目，以后改默认值会被旧配置压住，跟 saveConfig 那条约定正好相反。
    // 停用（0）例外：那是一次真实决定，必须存。
    if (val > 0 && CTX_WINDOWS_DEFAULT[name] === val) continue;
    next[name] = val;
  }
  loadCtxWindows(next);
  saveConfig();
  return { ok: true, changed: applyCtxWindows(), windows: ctxWindowRows(), unknown: ctxUnknownModels() };
}

// ---------------- Trae 密钥抓取（页面「解密」按钮的服务端） ----------------
// traeKey 是**每台机器一把**的 32 字节随机密钥，只存在于 Trae 宿主进程的内存里（磁盘上没有、
// 也推不出来，见 REFERENCE.md「Trae 的 SQLCipher 库」）。页面按钮 → 这里 spawn tools/grab-trae-key.ps1：
// 脚本先普通权限扫一遍，扫不到就自己弹 UAC 提权重来 —— 提权那一半的 stdout 父进程拿不到，
// 所以双方约定用「结果文件」这种最土也最可靠的方式带回 {ok, key?, error?, message?}。
//   完成信号 = 子进程退出（脚本在提权接管后会等结果文件出现才退，见 ps1 里那段注释）+
//   每次 tick 先试读结果文件（成功/取消提权两个快路径不用等退出）。
// 抓取是**机器级**的：同机 trae/traework 共用一把钥匙，所以不区分 agent，成功后写给所有 traedb 条目。
const TRAE_KEY_RE = /^[0-9a-fA-F]{64}$/;
const CAPTURE_SCRIPT = path.join(ROOT, 'tools', 'grab-trae-key.ps1');
const CAPTURE_MINUTES = 3;   // 提权实例的扫描窗口：Trae 开过库的场景第一圈就命中；3 分钟够用户去 Trae 里发一条消息
let traeCapture = { phase: 'idle', startedAt: 0, finishedAt: 0, error: '', message: '' };
let traeCaptureChild = null, traeCaptureTimer = null, traeCaptureOut = '', traeCaptureChildExit = null;

function traeCaptureSupported() {
  return process.platform === 'win32' && fs.existsSync(CAPTURE_SCRIPT);
}

// 脚本的失败码 → 给用户看的话（必须带下一步动作；服务端组好整句放进 state.message，页面直接 toast）
const CAPTURE_ERRS = {
  'no-trae-process': '没有找到 Trae 进程。先打开 Trae CN（随便发一条 AI 消息），再点一次「解密」。',
  'no-key': '扫描结束仍没抓到密钥。抓取过程中请在 Trae 里发一条 AI 消息（触发它打开数据库），然后重试。',
  'elevation-canceled': '管理员授权被拒绝（UAC 弹窗）。Trae 的宿主进程带反调试，读它的内存必须过一次 UAC —— 重试并在弹窗上点「是」。',
  'scan-error': '抓取脚本出错',
  'timeout': '抓取超时（脚本没在预期时间内写回结果）。请重试；若 Trae 刚启动，先在 Trae 里发一条消息。',
  'script-exit': '抓取脚本退出且没有写回结果（提权弹窗被关掉，或被安全软件/PowerShell 执行策略拦住）。重试一次并在 UAC 弹窗上点「是」；若反复出现，可照 REFERENCE.md 的手动命令自查。',
};
function captureErrText(code, detail) {
  // 未知错误码也保留原文：新脚本版本加了码但服务端还没认识时，宁可难看也别吞掉线索
  const base = CAPTURE_ERRS[code] || ('抓取失败（' + code + '）');
  return detail ? base + '（' + detail + '）' : base;
}

function traeCaptureState() {
  return { phase: traeCapture.phase, startedAt: traeCapture.startedAt, finishedAt: traeCapture.finishedAt,
           error: traeCapture.error, message: traeCapture.message, minutes: CAPTURE_MINUTES };
}

function endTraeCapture(phase, error, message) {
  traeCapture.phase = phase;
  traeCapture.finishedAt = Date.now();
  traeCapture.error = error || '';
  traeCapture.message = message || '';
  if (traeCaptureTimer) { clearInterval(traeCaptureTimer); traeCaptureTimer = null; }
  if (traeCaptureOut) {
    const f = traeCaptureOut;
    try { fs.unlinkSync(f); } catch {}   // 结果文件里有明文密钥，读完/放弃即删
    // 放弃时提权实例可能还在扫、稍后才把文件写出来 —— 补一枪，别让密钥文件留在 %TEMP% 里过夜
    setTimeout(() => { try { fs.unlinkSync(f); } catch {} }, 120000).unref?.();
    traeCaptureOut = '';
  }
  traeCaptureChild = null;
  log('[trae-capture]', phase, error || '', message || '');
}

// 抓到密钥：写给**所有** traedb 条目（机器级共享一把钥匙），落盘 + 通知 + 重扫。
// 重扫不可省：scanTraeDb 按 (库签名, keyHash) 增量，换了钥匙 keyHash 变了才会重解析。
function applyTraeKey(keyHex) {
  const k = String(keyHex || '').trim().toLowerCase();
  if (!TRAE_KEY_RE.test(k)) return 0;
  let n = 0, first = '';
  for (const [name, c] of agentConfs) {
    if (c.kind !== 'traedb') continue;
    agentConfs.set(name, { ...c, traeKey: k });
    if (!first) first = name;
    n++;
  }
  if (n) {
    saveConfig();
    agentNotices.push({ traeKey: first });
    scanAll(true);
  }
  return n;
}

function clearTraeKeys() {
  let n = 0;
  for (const [name, c] of agentConfs) {
    if (c.kind !== 'traedb' || !c.traeKey) continue;
    const { traeKey, ...rest } = c;
    agentConfs.set(name, rest);
    n++;
  }
  if (n) {
    saveConfig();
    agentNotices.push({ traeKeyCleared: 'trae' });
    scanAll(true);   // 清掉后下一轮扫描会走回 renderer.log 回退（scanTraeDb 的 nokey 分支）
  }
  return n;
}

function startTraeCapture() {
  if (!traeCaptureSupported()) return { ok: false, error: '这个平台/这份安装里没有抓取脚本（tools/grab-trae-key.ps1），只能在 Windows 上从页面抓' };
  if (traeCapture.phase === 'running') return { ok: false, error: '已有一次抓取在进行中，等它结束（或到 Trae 里发一条消息帮它命中）' };
  const outFile = path.join(os.tmpdir(), 'agentacta-traekey-' + process.pid + '-' + Date.now() + '.json');
  let child;
  try {
    child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT, '-Minutes', String(CAPTURE_MINUTES), '-OutFile', outFile],
      { windowsHide: true, stdio: 'ignore' });
  } catch (e) {
    return { ok: false, error: '启动抓取脚本失败：' + e.message };
  }
  traeCapture = { phase: 'running', startedAt: Date.now(), finishedAt: 0, error: '', message: '' };
  traeCaptureChild = child;
  traeCaptureOut = outFile;
  traeCaptureChildExit = null;
  let exitedAt = 0;
  child.on('exit', code => { exitedAt = Date.now(); traeCaptureChildExit = code; });
  child.on('error', e => {
    // spawn 本身失败（不常见；正常失败都走结果文件/退出码）
    if (traeCapture.phase === 'running') endTraeCapture('error', 'script-exit', captureErrText('script-exit', e.message));
  });
  const startedAt = Date.now();
  traeCaptureTimer = setInterval(() => {
    if (traeCapture.phase !== 'running') return;
    const j = readCaptureResult();
    if (j) return finishFromResult(j);
    // 子进程退了、结果文件却还不在（给文件落盘留 2s 宽限）：脚本被拦/被杀，没别的路径能带回原因了
    if (exitedAt && Date.now() - exitedAt > 2000) {
      return endTraeCapture('error', 'script-exit', captureErrText('script-exit', '退出码 ' + traeCaptureChildExit));
    }
    // 兜底保险丝：理论上子进程自己的等待窗口就有界（见 ps1），这里只防「脚本自己卡死」
    if (Date.now() - startedAt > (CAPTURE_MINUTES * 60 + 300) * 1000) endTraeCapture('error', 'timeout', CAPTURE_ERRS['timeout']);
  }, 1000);
  traeCaptureTimer.unref?.();
  return { ok: true, state: traeCaptureState() };
}

function readCaptureResult() {
  if (!traeCaptureOut) return null;
  let txt;
  try { txt = fs.readFileSync(traeCaptureOut, 'utf8'); } catch { return null; }
  // 脚本用 UTF8(无 BOM) 一次性写全；万一读到半截（别的工具写的），JSON.parse 失败就当没写完，下个 tick 再读
  const j = (() => { try { return JSON.parse(txt.replace(/^\uFEFF/, '')); } catch { return null; } })();
  return j && typeof j === 'object' ? j : null;
}
function finishFromResult(j) {
  if (j.ok && typeof j.key === 'string') {
    if (!TRAE_KEY_RE.test(j.key.trim())) return endTraeCapture('error', 'bad-key', '抓到的密钥格式不对（不是 64 位十六进制），未写入');
    const n = applyTraeKey(j.key);
    if (!n) return endTraeCapture('done', '', '抓到了密钥，但当前没有 traedb 类型的 agent 可写入（先把 trae 添加回来）');
    return endTraeCapture('done', '', '');
  }
  const code = typeof j.error === 'string' && j.error ? j.error : 'scan-error';
  endTraeCapture('error', code, captureErrText(code, typeof j.message === 'string' ? j.message : ''));
}

// ---------------- Cursor token 采集 hook 的注入 / 卸载（页面 cursor 行「注入」按钮的服务端） ----------------
// 为什么需要它：cursor 的逐轮 token **只**出现在它的 stop 钩子载荷里 —— 转录文件只有 role + text，
// state.vscdb 的 usageData 是空对象、tokenCount 恒为 0（见 parsers/cursor.mjs 的两段注释）。
// 所以这里做的事很窄：往 ~/.cursor/hooks.json 的 hooks.stop 里加/删一条指向 hooks/cursor-usage-hook.mjs 的命令；
// 脚本在每轮结束时把用量追加到 ~/.agent-acta/cursor-usage.jsonl，解析器再读那份日志配对到轮上。
//
// 三条硬约束：
//   1) **绝不覆盖用户的 hooks.json**：只动 hooks.stop 里我们自己那一条，别的键/别的钩子原样保留。
//      文件存在但解析不出 JSON 时报错退出，绝不「重置成默认」—— 那等于静默删掉用户自己的钩子。
//   2) **认自己那条靠脚本文件名**（cursor-usage-hook.mjs），不靠绝对路径：安装目录搬过、路径写法
//      正/反斜杠不同、用户手工改过命令，都还认得出来，卸载不会漏也不会误删别人的。
//   3) **命令里的解释器写 process.execPath**（正跑着本服务的那个 node 的绝对路径），不写 `node`：
//      Cursor 子进程的 PATH 未必有 node（服务可能是被 IDE/快捷方式用绝对路径拉起来的）。
const CURSOR_HOOK_SCRIPT = path.join(ROOT, 'hooks', 'cursor-usage-hook.mjs');
const CURSOR_HOOK_NAME = 'cursor-usage-hook.mjs';
const CURSOR_HOOK_TIMEOUT = 10;   // 秒。脚本自己的 stdin 等待窗口是 5s，留一倍余量
export const CURSOR_USAGE_LOG = path.join(DATA_DIR, 'cursor-usage.jsonl');   // 解析器也要读，故导出

// user 级 hooks 固定在这里（项目级的 <repo>/.cursor/hooks.json 是另一份，我们不碰）
function cursorHooksFile() { return path.join(HOME, '.cursor', 'hooks.json'); }
function isCursorHookEntry(h) {
  return !!h && typeof h.command === 'string' && h.command.includes(CURSOR_HOOK_NAME);
}
// 读出来就地补好 hooks 容器。返回 {ok, j, existed} 或 {ok:false, error}
function readCursorHooks() {
  const fp = cursorHooksFile();
  let txt;
  try { txt = fs.readFileSync(fp, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: true, j: { version: 1, hooks: {} }, existed: false };
    return { ok: false, error: '读不到 ' + fp + '：' + e.message };
  }
  let j;
  try { j = JSON.parse(txt.replace(/^\uFEFF/, '')); }
  catch { return { ok: false, error: fp + ' 不是合法 JSON，未做任何改动（请先手工修好，免得覆盖你自己的钩子）' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: fp + ' 的内容不是对象，未做任何改动' };
  if (!j.hooks || typeof j.hooks !== 'object' || Array.isArray(j.hooks)) j.hooks = {};
  return { ok: true, j, existed: true };
}
function writeCursorHooks(j) {
  const fp = cursorHooksFile();
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // 2 空格缩进 + 结尾换行：Cursor 自己也是这么写的，两边交替改也看不出 diff 噪声
    fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: '写 ' + fp + ' 失败：' + e.message }; }
}
function cursorHookStatus() {
  const script = fs.existsSync(CURSOR_HOOK_SCRIPT);
  const r = readCursorHooks();
  const base = { script, file: cursorHooksFile(), log: CURSOR_USAGE_LOG };
  if (!r.ok) return { ...base, injected: false, error: r.error };
  const stop = Array.isArray(r.j.hooks.stop) ? r.j.hooks.stop : [];
  const entry = stop.find(isCursorHookEntry);
  return { ...base, injected: !!entry, command: entry ? entry.command : '' };
}
// 命令里的两个参数一律加引号：路径可能带空格，而且 Cursor 是按 shell 命令跑的（官方示例带参数，
// 说明不是直接 exec），引号由 shell 剥掉。
function cursorHookCommand() {
  return '"' + process.execPath + '" "' + CURSOR_HOOK_SCRIPT + '"';
}
function installCursorHook() {
  if (!fs.existsSync(CURSOR_HOOK_SCRIPT)) return { ok: false, error: '这份安装里没有 hooks/' + CURSOR_HOOK_NAME + '，无法注入' };
  const r = readCursorHooks();
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.j;
  if (!Number.isFinite(Number(j.version))) j.version = 1;
  if (!Array.isArray(j.hooks.stop)) j.hooks.stop = [];
  if (j.hooks.stop.some(isCursorHookEntry)) {
    // 已经在里面了：把命令刷成当前这份安装的路径（安装目录搬过、node 换过都能自愈），其余不动
    const cmd = cursorHookCommand();
    const i = j.hooks.stop.findIndex(isCursorHookEntry);
    if (j.hooks.stop[i].command === cmd) return { ok: true, injected: true, already: true, ...cursorHookStatus() };
    j.hooks.stop[i] = { ...j.hooks.stop[i], command: cmd };
    const w = writeCursorHooks(j);
    return w.ok ? { ok: true, injected: true, updated: true, ...cursorHookStatus() } : w;
  }
  j.hooks.stop.push({ command: cursorHookCommand(), timeout: CURSOR_HOOK_TIMEOUT });
  const w = writeCursorHooks(j);
  return w.ok ? { ok: true, injected: true, ...cursorHookStatus() } : w;
}
function uninstallCursorHook() {
  const r = readCursorHooks();
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.j;
  const stop = Array.isArray(j.hooks.stop) ? j.hooks.stop : [];
  const keep = stop.filter(h => !isCursorHookEntry(h));
  const removed = stop.length - keep.length;
  if (!removed) return { ok: true, injected: false, removed: 0, ...cursorHookStatus() };
  // 数组空了就把 stop 这个键删掉（留着空数组是纯噪声）；已采集的 cursor-usage.jsonl **不删** ——
  // 那些是真实采到的用量，卸载只是停止继续采，解析器照旧认它。
  if (keep.length) j.hooks.stop = keep; else delete j.hooks.stop;
  const w = writeCursorHooks(j);
  return w.ok ? { ok: true, injected: false, removed, ...cursorHookStatus() } : w;
}

// 落盘索引 → 断开 SSE → 删 pid 文件 → 停掉全部定时器 → 按退出策略决定退不退进程。
// SSE 是长连接，只 server.close() 进程退不掉。
//
// **Step 2 的拆点**：原先这里直接 process.exit(0)，而 /api/shutdown 就挂在它上面 ——
// 插件把这个服务挂进宿主 DSH 之后，「点一下页面上的停止」等于**把宿主进程关掉**（评审 §3.1 点名的根因）。
// 所以退出权改成注入的：cli 传真 process.exit（今天的行为），hosted 传空函数（只停循环，命留给宿主）。
// 模块级默认取**空函数**而不是 process.exit：这是失败方向的选择 —— 默认不动手，就绝不会出现
// 「宿主忘了传策略 ⇒ 插件把宿主关了」；cli 那条路在 start() 里显式传进来，不受这个默认影响。
let exitPolicy = () => {};
let shuttingDown = false;
export function stop(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('[agent-acta] shutting down: ' + reason);
  // 抓取中的脚本不等它了：留着它只会继续扫内存、把（含明文密钥的）结果文件写到一个没人读的路径上
  if (traeCaptureChild) { try { traeCaptureChild.kill(); } catch {} traeCaptureChild = null; }
  if (traeCaptureTimer) { clearInterval(traeCaptureTimer); traeCaptureTimer = null; }
  if (traeCaptureOut) { try { fs.unlinkSync(traeCaptureOut); } catch {} traeCaptureOut = ''; }
  try { saveIndex(); } catch (e) { console.error('[index]', e.message); }
  for (const res of [...sseClients]) { try { res.end(); } catch {} sseClients.delete(res); }
  // 只删自己那份 pid 文件：第二个实例撞 EADDRINUSE 退出时也会走到这里，别把在跑的那个的文件删了
  try { if (Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
  // 定时器全撤：不等这一步的话，hosted 下 stop() 之后归档轮 / 搜索轮 / 扫描自续期还在后台扫盘写索引。
  clearTimers();
  if (server.listening) { try { server.close(); } catch {} }
  exitPolicy(0);
}
// 空闲自停：页面全关（无 SSE 连接）且这段时间没有任何新条目 → 自己退。
// 计时器在 listen 时就挂上（不是等首扫）：被 hook `--ensure` 拉起、之后一直没人打开页面的服务，
// 根本没人发过第一个 HTTP 请求，startScanning 从未执行 —— 挂在它里面就等于永远不自停。
// hosted 模式不挂它（插件里那个服务不是「没人看就自己走」的进程，命归宿主）—— 见 start() 里的 guard。
function checkIdle() {
  const limit = IDLE_ENV || idleExitMs;
  if (!limit || sseClients.size) return;
  const idle = Date.now() - lastActivity;
  if (idle >= limit) stop('空闲 ' + Math.round(idle / 1000) + 's（无页面连接、无新日志）');
}

// SSE 心跳：防代理/负载均衡掐空闲连接；写失败即清理断开的 client。
// **Step 2 收口**：原来是 `if (!ENSURE_FLAG && !LIB) setInterval(...)` —— 服务代码直接读 CLI flag，
// 这是 §5 点名的唯一真正的泄漏。现在它只由 start({ keepAlive }) 决定，服务侧一个 CLI 旗标都不认了：
//   谁要长连接（前台常驻 / 插件宿主）谁传 keepAlive:true 从 start() 里挂上；
//   --ensure 那个进程根本不调 start()（它只负责拉起别人），所以「不挂定时器」这件事不用再判。
// 挂上之后由 stop() 的 clearTimers() 统一撤掉，不再是一挂到进程结束。
let heartTimer = null;
function startHeartbeat() {
  heartTimer = every(() => {
    for (const res of [...sseClients]) { try { res.write(': ping\n\n'); } catch { sseClients.delete(res); } }
  }, 25000);
}

// ---------------- http ----------------
function sortedEntries() {
  if (!sorted.cache) sorted.cache = [...entries.values()].sort((a, b) => (b.time || 0) - (a.time || 0));
  return sorted.cache;
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => cb(b));
}

// 跨域写保护：无 CORS 头（浏览器跨域读被同源策略拦截）；写操作再校验 Origin 必须同源。
//
// **Step 2 补丁（2026-09-29）**：判据原来硬绑在 PORT 上（`ou.port === String(PORT)`）。CLI 下那是对的，
// 在宿主里是**错的** —— 面板 iframe 的 Origin 是 `http://127.0.0.1:<宿主端口>` 或 `dsh-app://app`，
// 端口永远不是 14570，于是 13 处写路径（`badOrigin(req)` 的全部调用点）全 403。
// 症状极具误导性：**面板读得到、任何保存都失败** —— 读路径不查 Origin，所以「连接明明是通的」，
// 排障会往 CORS / 反代 / 权限上找，而根因是一个写死的端口号。
//
// 所以判据改成**可注入**：cli 逐字不变；hosted 默认收「环回主机名（端口不限）+ dsh-app 协议」。
// 宿主想再收紧（比如只认它自己那一个 Origin）就传 start({ originIsLocal }) 给一个判据，别在插件里绕。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);   // [::1] 是 URL 里 IPv6 环回的 hostname 写法
const ORIGIN_GATES = {
  // cli：与搬家前**逐字一致** —— 环回主机名 **且** 端口就是本服务的 PORT。
  // 两条断言钉着它，改这两行之前先看它们：本文件 [7] 的「cli 端口不符要 403」，
  // 以及 traedb-test 的「外来主机名要 403」。
  cli: u => (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(PORT),
  // lib：只读库不经过 HTTP，这条永远不会被调用；与 cli 保持同一个表达式，
  // 免得有人看见第三种写法以后以为「lib 的口径不一样」。
  lib: u => (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(PORT),
  // hosted：端口归宿主，写死任何一个端口都是错的。收「http(s) + 环回主机名（端口不限）」与 dsh-app://。
  // 收紧的是**主机名与协议**那一维 —— 跨站页面（evil.example）照样拒：闸门没有被改松，
  // 只是不再拿「端口等于 14570」当同源标识（那个标识在宿主里根本不存在）。
  hosted: u => u.protocol === 'dsh-app:' ||
    ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)),
};
// null = 用当前 MODE 的内置判据。传函数即覆盖；传别的一律回到内置。
// start() 每次都会重置它（不传 originIsLocal 就重置成 null），免得同一进程里两次 start 之间串味。
let originGate = null;
export function setOriginGate(fn) { originGate = typeof fn === 'function' ? fn : null; }
function badOrigin(req) {
  const o = req.headers.origin;
  if (!o) return false; // curl / 导航请求无 Origin
  try {
    const gate = originGate || ORIGIN_GATES[MODE] || ORIGIN_GATES.cli;
    return !gate(new URL(o));
  } catch { return true; }   // Origin 解析不出来一律拒（与搬家前一致）
}

// /api/client 那条路由要唤起悬浮卡片壳，而那段（runClient → runEnsure → spawnServer）**必须留在 CLI 入口**：
// spawnServer 里那句 fileURLToPath(import.meta.url) 得指入口文件，跟着搬进 core 就会去 spawn
// core/service.mjs —— 那时 argv[1] 不是入口 ⇒ LIB 为真 ⇒ 什么都不会发生，**而且不报错**（正是 §2 那类
// 静默改语义）。core 不能反向 import 入口，所以由入口启动时把 runClient 注进来。
// 这是 Step 1 里**唯一**一处不是纯搬家的地方：只加了一个可空钩子，没动任何原有分支；
// 入口没注入时给出话说清楚，而不是静默什么都不做。Step 2 的 start(opts) 可以把它收成一个 opts 字段。
let clientSpawner = null;
export function setClientSpawner(fn) { clientSpawner = fn; }

// ---------------- 路由表（Step 2 抽表） ----------------
// 抽表不是为了好看，是三件事同时要它：
//   ① 守卫拿它跟 test/routes.expected.json 对账（表 ≡ 预期），「插件悄悄少挂一条」当场红；
//   ② 插件壳按它逐条 register（hosted 模式下 prefix 路由在真宿主上不生效，只能按表逐条来）；
//   ③ 抽完以后路由清单只有**一份**（原来是 if 链里数一遍、清单里再数一遍，两边必然漂）。
// 表是**权威**的：handle() 就按它派发，不是「声明一份、实现另一份」。
//
// 每条五个字段：
//   path     u.pathname 的精确值（前缀路由在下面 ROUTE_PREFIXES，不在这张表里）
//   method   对外口径 —— 守卫按它挑探法、插件壳按它决定注册范围。与 routes.expected.json 的
//            method 字段逐字一致（守卫会断言这一点）。它**不是**方法闸：多条路由接受不止一种方法
//   methods  实现口径的方法闸。null = 不断方法（照单全收，与原来那批「GET 即达」的路由写法一致）
//   miss     方法不符时答什么：'404' = 这条压根没命中、继续往下找（原来写作 `pathname && req.method === 'POST'`）；
//            '405' = 命中了但不认这个方法（原来写作「进分支后再判 method」）
//   fn       处理函数（签名 (req, res, u)），函数体是从原来那条 if 分支里**逐字搬**过来的
//
// ⚠ 顺序不重要（路径两两不重复），但保持与抽表前 if 链**同一个顺序** —— 这样 review 时能一行行对着看。
const ROUTES = [
  { path: '/api/ping', method: 'GET', methods: null, miss: '404', fn: routePing },
  { path: '/api/shutdown', method: 'POST', methods: ['POST'], miss: '405', fn: routeShutdown },
  { path: '/api/client', method: 'POST', methods: ['POST'], miss: '405', fn: routeClient },
  { path: '/api/archive/index', method: 'GET', methods: null, miss: '404', fn: routeArchiveIndex },
  { path: '/api/archive/skip', method: 'POST', methods: ['POST'], miss: '404', fn: routeArchiveSkip },
  { path: '/api/archive/entries', method: 'GET', methods: null, miss: '404', fn: routeArchiveEntries },
  { path: '/api/archive/entry', method: 'GET', methods: null, miss: '404', fn: routeArchiveEntry },
  { path: '/api/diagnose', method: 'GET', methods: null, miss: '404', fn: routeDiagnose },
  { path: '/api/usage', method: 'GET', methods: null, miss: '404', fn: routeUsage },
  { path: '/api/search/status', method: 'GET', methods: null, miss: '404', fn: routeSearchStatus },
  { path: '/api/search', method: 'GET', methods: null, miss: '404', fn: routeSearch },
  { path: '/api/selftest', method: 'GET', methods: null, miss: '404', fn: routeSelftest },
  { path: '/api/agents', method: 'GET', methods: null, miss: '404', fn: routeAgents },
  { path: '/api/agents/toggle', method: 'POST', methods: ['POST'], miss: '404', fn: routeAgentsToggle },
  { path: '/api/trae/capture-key', method: 'GET/POST', methods: null, miss: '404', fn: routeTraeCaptureKey },
  { path: '/api/trae/clear-key', method: 'POST', methods: ['POST'], miss: '404', fn: routeTraeClearKey },
  { path: '/api/cursor-hook', method: 'GET', methods: null, miss: '404', fn: routeCursorHook },
  { path: '/api/settings', method: 'GET', methods: null, miss: '404', fn: routeSettings },
  { path: '/api/alert', method: 'GET', methods: null, miss: '404', fn: routeAlert },
  { path: '/api/ctxwindows', method: 'GET', methods: null, miss: '404', fn: routeCtxWindows },
  { path: '/api/version', method: 'GET', methods: null, miss: '404', fn: routeVersion },
  { path: '/', method: 'GET', methods: null, miss: '404', fn: routePage },
  { path: '/widget', method: 'GET', methods: null, miss: '404', fn: routeWidget },
  { path: '/api/snapshot', method: 'GET', methods: null, miss: '404', fn: routeSnapshot },
  { path: '/api/daily', method: 'GET', methods: null, miss: '404', fn: routeDaily },
  { path: '/api/models', method: 'GET', methods: null, miss: '404', fn: routeModels },
  { path: '/api/work', method: 'GET', methods: null, miss: '404', fn: routeWork },
  { path: '/api/analyze', method: 'GET', methods: null, miss: '404', fn: routeAnalyze },
  { path: '/api/session', method: 'GET', methods: null, miss: '404', fn: routeSession },
  { path: '/api/sessions', method: 'GET', methods: null, miss: '404', fn: routeSessions },
  { path: '/api/entry', method: 'GET', methods: null, miss: '404', fn: routeEntry },
  { path: '/api/repro', method: 'GET', methods: null, miss: '404', fn: routeRepro },
  { path: '/api/events', method: 'GET', methods: null, miss: '404', fn: routeEvents },
];
// 前缀路由（2 条）。它们排在精确路由**之后**匹配，与抽表前 if 链的先后无关 ——
// /vendor/ 与 /page/ 跟上面任何一条精确路径都不可能同时命中，两种排法等价。
const ROUTE_PREFIXES = [
  { path: '/vendor/', fn: routeVendor },
  { path: '/page/', fn: routePageFile },
];

function routePing(req, res, u) {
    res.end('ok');
    // ping 的响应已写入 socket，这里再启动首扫 —— 阻塞期间 hook 不会再等
    if (!scanStarted) setTimeout(startScanning, 300);
    return;
}
function routeShutdown(req, res, u) {
    // --stop 的优雅通道：先把响应写回 socket，再落盘索引退出（免得把还没落盘的增量偏移丢掉）。
    // Step 2：退出的是「进程」还是「循环」由 start() 注入的 exitPolicy 定 —— 宿主里这条不该关掉 DSH。
    if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end('{"ok":true}');
    setTimeout(() => stop('收到 /api/shutdown'), 50);
    return;
}
function routeClient(req, res, u) {
    // 从网页面板唤出桌面悬浮卡片（等价 agentacta --client）：面板页没有壳进程的入口，
    // 卡片被 ✕ 关掉后就只能回命令行 —— 这里给页面一个按钮用的口子。
    // runClient 幂等：服务已在跑直接过；壳单实例，重复只是聚焦/重建卡片（见 widget/main.js 的 second-instance）。
    if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end('{"ok":true}');
    if (clientSpawner) clientSpawner().catch(err => console.error('[client] 唤起悬浮卡片失败：' + (err && err.message)));
    else console.error('[client] 本进程没装悬浮卡片唤起器（只读库模式？）：请在命令行跑 agentacta --client');
    return;
}
// 归档三接口（页面「历史归档」视图专用）：**独立只读数据源**，与实时条目完全不混 ——
// 归档条目只在这里出现，不进 /api/snapshot、不进按天聚合、不进会话视图（见 archive.mjs 的设计约束 1）。
// 不吃 whenReady：归档在磁盘上，与「首扫完了没」无关，页面一打开就能查。
function routeArchiveIndex(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // skip 由服务端补进来（归档模块只管冻，不知道 config）：页面拿它解释「这个 agent 怎么没在树里」
    // configAgents = 已启用的 agent 名单：开关要能管到**还没有任何归档**的 agent（树里根本没有它），
    // 光靠清单列不出「以后也永远不会有」的那些。
    try {
      res.end(JSON.stringify({
        ok: true, skip: archiveCfg.skip,
        configAgents: [...agentConfs].filter(([, c]) => c.enabled !== false).map(([n]) => n).sort(),
        ...archiveIndex(),
      }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
}
// per-agent 归档开关的写口（页面「历史归档」左下的开关列表）。写入即落盘 config.archive.skip，
// 与 `agentacta --archive` / 服务内自动轮共用同一份 archiveCfg —— 不用重启就立刻生效。
// 方法闸（只认 POST）在表里：原来是 `pathname === … && req.method === 'POST'`，GET 落到兜底 404。
function routeArchiveSkip(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
    readBody(req, body => {
      let out;
      try { const j = JSON.parse(body || '{}'); out = setArchiveSkip(j.agent, !!j.skip); }
      catch (e) { out = { ok: false, error: e.message }; }
      res.statusCode = out.ok ? 200 : 400;
      res.end(JSON.stringify(out));
    });
    return;
}
function routeArchiveEntries(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      res.end(JSON.stringify({ ok: true, ...archiveEntries({
        agent: u.searchParams.get('agent'), day: u.searchParams.get('day'),
        q: u.searchParams.get('q'), limit: u.searchParams.get('limit'), offset: u.searchParams.get('offset'),
      }) }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
}
function routeArchiveEntry(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const rec = archiveEntry(u.searchParams.get('agent') || '', u.searchParams.get('day') || '',
        u.searchParams.get('id') || '');
      if (!rec) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'not found' })); return; }
      res.end(JSON.stringify({ ok: true, entry: rec }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
}
function routeDiagnose(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify({ ok: true, ...diagnose() })); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
// 磁盘占用：走磁盘、可能几秒，所以只读 + 缓存 + 预算（见 usageReport 上方注释）。
// 与 /api/diagnose 一样挂在 whenReady 上：agentConfs 要等首轮配置加载完才有内容。
function routeUsage(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(usageReport(u.searchParams.get('force') === '1'))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
// 全文搜索（R33 / 候选池 I10）。挂 whenReady：索引要等首扫把 entries / srcs 填起来才算数。
// 两处与别家接口**刻意不同**，都写进返回让页面能如实解释：
//   ① 时间范围默认**不套**：不传 from/to 就没有时间条件。这是全文搜索存在的理由 ——
//      「上周那次报错」本来就在页面默认的最近两天之外，套上默认区间等于把功能抹掉。
//      页面那个「限定当前时间范围」开关才传这两个参数。
//   ② 回带索引覆盖度（已索引 A/B、是否在重建、几条读不出正文）：索引是后台一点点建的，
//      不报覆盖度的话「没搜到」会被读成「没有这条日志」。
function routeSearchStatus(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(searchStatus())); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
function routeSearch(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const hit = searchEntries({ q: u.searchParams.get('q'), regex: u.searchParams.get('re') === '1' });
        // 关键词为空 / 正则不合法 → 400 带原话。**不能落到 404 兜底**：那个路径回的是纯文本 'not found'，
        // 页面 getJSON 会把它说成「接口不存在（多半是旧版服务）」，与本意差了十万八千里。
        if (!hit.ok) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: hit.error })); return; }
        // 筛选口径的唯一来源仍是 filterEntries（项目按 projKey 归一化、多值键 agents=/projects=）。
        // 文本匹配留在 search.mjs、条目筛选留在这儿，两边各管各的，谁都不写第二套口径。
        const { list, rb } = filterEntries(multiParam(u, 'agent', 'agents'), multiParam(u, 'project', 'projects'),
          u.searchParams.get('range'), u.searchParams.get('from'), u.searchParams.get('to'));
        const allow = new Set(list.map(e => e.id));
        const st = u.searchParams.get('status') || '';
        const out = [];
        for (const m of hit.matches) {
          if (!allow.has(m.e.id)) continue;      // 求交集：命中集 ∩ 当前筛选集
          if (st && m.e.status !== st) continue;
          out.push({ ...m.e, _snip: m.snip });
        }
        const lim = Math.min(Math.max(Number(u.searchParams.get('limit')) || 200, 1), 2000);
        const { projects } = counts();
        res.end(JSON.stringify({
          ok: true, total: out.length, scanned: list.length, stale: hit.stale,
          capped: out.length > lim ? 1 : 0,
          entries: out.slice(0, lim),
          // 覆盖度的分母是**扫描链当前认识的条数**（不是命中数），页面横幅写「已索引 A/B」用的就是这两个
          index: searchStatus(),
          rangeLabel: rb ? rb.label : '全部时间',
          agents: agentsList(), projects,
        }));
      } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
// 不挂 whenReady：它只读一个文件，跟内存索引没关系，首扫期间也该能看上次自检结果。
function routeSelftest(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try { res.end(JSON.stringify(selftestReport())); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
}
// 表里这条的 methods 是 null（不断方法）：GET/POST/DELETE 三种语义都在函数体里，
// 兜底 405 也在体里（原先就是「进分支之后」才判的，搬进表反而会改掉 405 响应头的形状）。
function routeAgents(req, res, u) {
    if (req.method === 'GET') {
      whenReady(() => {
        if (res.writableEnded) return;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(agentsList()));
      });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'POST') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      readBody(req, body => {
        let out;
        try {
          const j = JSON.parse(body || '{}');
          out = addAgent(j.name, j.path);
          if (out.ok) { saveConfig(); scanAll(true); }
        } catch (e) { out = { ok: false, error: e.message }; }
        res.statusCode = out.ok ? 200 : 400;
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (req.method === 'DELETE') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      const out = removeAgent(u.searchParams.get('name') || '');
      res.statusCode = out.ok ? 200 : 400;
      res.end(JSON.stringify(out));
      return;
    }
    res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}');
    return;
  }
// 方法闸在表里（只认 POST；GET 落兜底 404 —— 原来是 `pathname && method` 同判，不是 405）
function routeAgentsToggle(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
    readBody(req, body => {
      let out;
      try {
        const j = JSON.parse(body || '{}');
        out = toggleAgent(j.name, j.enabled);
        if (out.ok) scanAll(true);
      } catch (e) { out = { ok: false, error: e.message }; }
      res.statusCode = out.ok ? 200 : 400;
      res.end(JSON.stringify(out));
    });
    return;
}
// Trae 密钥抓取（页面「解密」按钮）：POST 起抓取、GET 查状态。状态里**永远没有密钥** ——
// 抓到的钥匙由服务端直接写进配置（saveConfig + SSE 通知 + 重扫），页面不需要也不应该看到它。
// 注意 GET 只回状态（traeCaptureState），**安全的只读探法**；危险的是它的 POST（UAC 提权抓密钥）。
function routeTraeCaptureKey(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET') { res.end(JSON.stringify({ ok: true, state: traeCaptureState() })); return; }
    if (req.method === 'POST') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      const out = startTraeCapture();
      res.statusCode = out.ok ? 200 : 400;
      res.end(JSON.stringify(out));
      return;
    }
    res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}');
    return;
  }
// 清除已配置的密钥（页面菜单里的「清除密钥」）：删的是**配置**，下一轮扫描自动回退 renderer.log。
// 方法闸在表里（只认 POST；GET 落兜底 404）。
function routeTraeClearKey(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
    if (traeCapture.phase === 'running') { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: '抓取正在进行中，等它结束再清除' })); return; }
    res.end(JSON.stringify({ ok: true, cleared: clearTraeKeys() }));
    return;
}
// Cursor 逐轮 token 采集 hook（页面 cursor 行的图标按钮）：GET 查状态、POST 注入/卸载。
// 只改 ~/.cursor/hooks.json 里我们自己那一条 stop 钩子，用户其它的钩子一个字节都不动（见 installCursorHook）。
function routeCursorHook(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET') { res.end(JSON.stringify({ ok: true, ...cursorHookStatus() })); return; }
    if (req.method === 'POST') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      readBody(req, body => {
        let out;
        try {
          const j = JSON.parse(body || '{}');
          out = j.action === 'uninstall' ? uninstallCursorHook() : installCursorHook();
        } catch (e) { out = { ok: false, error: e.message }; }
        res.statusCode = out.ok ? 200 : 400;
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}');
    return;
}
function routeSettings(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET') { res.end(JSON.stringify({ ok: true, scanMs, choices: SCAN_CHOICES, idleExitMs, idleChoices: IDLE_CHOICES })); return; }
    if (req.method === 'POST') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      readBody(req, body => {
        let out;
        try {
          const j = JSON.parse(body || '{}');
          out = 'idleExitMs' in j ? setIdleExitMs(Number(j.idleExitMs)) : setScanMs(Number(j.scanMs));
        } catch (e) { out = { ok: false, error: e.message }; }
        res.statusCode = out.ok ? 200 : 400;
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}');
    return;
}
// 异常巡检（R9）：GET 取当前规则 + 命中摘要 + 命中条目（含 agent/规则），POST 保存规则并重算。
function routeAlert(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET') {
      if (alertDirty) recomputeAlerts();
      // 命中条目带完整字段，供弹层列表展示（编号直接定位回主列表用 id）。
      const hits = [];
      for (const [id, h] of alertHits) {
        const e = entries.get(id);
        if (!e) continue;
        hits.push({ id, ...h, time: e.time, preview: e.preview, status: e.status, dur: e.dur, total: e.total, project: e.project });
      }
      hits.sort((a, b) => (b.time || 0) - (a.time || 0));
      res.end(JSON.stringify({ ok: true, rules: alertRules, summary: alertSummary(), hits }));
      return;
    }
    if (req.method === 'POST') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      readBody(req, body => {
        let out;
        try { out = setAlertRules(JSON.parse(body || '{}').rules); }
        catch (e) { out = { ok: false, error: e.message }; }
        res.statusCode = out.ok ? 200 : 400;
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}');
    return;
}
function routeCtxWindows(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET') { res.end(JSON.stringify({ ok: true, windows: ctxWindowRows(), unknown: ctxUnknownModels() })); return; }
    if (req.method === 'POST') {
      if (badOrigin(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden origin"}'); return; }
      readBody(req, body => {
        let out;
        try { out = setCtxWindows(JSON.parse(body || '{}').windows); }
        catch (e) { out = { ok: false, error: e.message }; }
        res.statusCode = out.ok ? 200 : 400;
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}');
    return;
}
function routeVersion(req, res, u) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, version: VERSION, build: BUILD, pageBuild: pageBuild(), platform: process.platform, pid: process.pid }));
    return;
}
function routePage(req, res, u) {
    try {
      // 把本进程的指纹注入页面：页面据此比对「我这张页面」和「正在伺候我的服务」是不是同一版。
      // 页面必须跟着服务端走 —— 浏览器留缓存会让新页面配旧接口（或反过来），症状就是上面 BUILD 注释里那三件事。
      // 同时注入跨端共享片段（R12）：projNorm / projKey / rangeDayStart 的唯一来源是本进程的 SHARED_JS，
      // 页面文件里只有 __AGENT_LOG_SHARED__ 占位符、没有第二份实现 —— 两端漂移在结构上不可能。
      const html = fs.readFileSync(PAGE_FILE, 'utf8')
        .split('__AGENT_LOG_BUILD__').join(BUILD)
        .split('__AGENT_LOG_PAGE_BUILD__').join(pageBuild())
        .split('__AGENT_LOG_SHARED__').join(SHARED_JS);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); // 本地服务，重取一次的开销可以忽略；缓存带来的错配代价大得多
      res.end(html);
    } catch { res.statusCode = 500; res.end('page file missing: ' + PAGE_FILE); }
    return;
}
function routeWidget(req, res, u) {
    try {
      // 桌面小卡片：与 '/' 同一套指纹注入与 no-store（理由见 '/' 路由注释）。
      // 卡片常驻桌面、几天不刷新是常态，指纹比对（hello.build ≠ 页面 meta → 自动 reload）对它更重要。
      const html = fs.readFileSync(WIDGET_FILE, 'utf8')
        .split('__AGENT_LOG_BUILD__').join(BUILD);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(html);
    } catch { res.statusCode = 500; res.end('widget file missing: ' + WIDGET_FILE); }
    return;
}
function routeVendor(req, res, u) {
    // 子目录要跟着走（svg/ 下的品牌图标就是 /vendor/svg/x.svg）。原来用 path.basename 挡穿越，
    // 顺手把所有子目录都拍平了 —— 图标一进目录就全 404，而且 404 是静默的（<img> 挂掉只出现空白）。
    // 改成相对路径 + resolve 后比对前缀：`..` 会被 resolve 吃掉，落在 VENDOR_DIR 外就 404。
    const rel = u.pathname.slice('/vendor/'.length);
    const fp = path.resolve(VENDOR_DIR, rel);
    const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml' };
    if (!fp.startsWith(VENDOR_DIR + path.sep)) { res.statusCode = 404; res.end('not found'); return; }
    try {
      const buf = fs.readFileSync(fp);
      res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(buf);
    } catch { res.statusCode = 404; res.end('not found'); }
    return;
}
function routePageFile(req, res, u) {
    // R25 批 0：主页面拆出的静态文件。防穿越与 /vendor/ 同款（相对路径 + resolve 前缀比对）。
    // MIME 连 charset 一起给：组件模板与注释里有大量中文，漏了 charset 在 Edge 上有乱码风险。
    // Cache-Control 用 no-store（**不是** vendor 的 86400）：这些文件开发期高频变更，
    // 与「页面本体 no-store、页面必须跟着服务端走」同一条纪律。
    const rel = u.pathname.slice('/page/'.length);
    const fp = path.resolve(PAGE_DIR, rel);
    const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    if (!fp.startsWith(PAGE_DIR + path.sep)) { res.statusCode = 404; res.end('not found'); return; }
    try {
      const buf = fs.readFileSync(fp);
      res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    } catch { res.statusCode = 404; res.end('not found'); }
    return;
}
function routeSnapshot(req, res, u) {
    const limit = Math.min(Number(u.searchParams.get('limit')) || SNAPSHOT_LIMIT, 10000);
    // scan=1：手动刷新按钮用。暂停定时扫描时也照样先扫一轮，让「刷新」真的刷新到新日志
    const forceScan = u.searchParams.get('scan') === '1';
    // agent= / project=：把「最近 N 条」这个窗口**收窄到该筛选内部**，而不是先取全局最近 N 条、再由页面过滤。
    // 不收窄的话，日志整体落在窗口外的 agent / 项目（停更的、条目年代久的）点进去永远是空的，
    // 页面只能写一句「把条/页调大就能看到」——可它明明有数据，这个提示没道理。
    // project= 收到的是页面算好的归一化 key（见 projKey 上方），不是原始项目名。
    // R10：多选下拉走新键 agents= / projects=（逗号分隔合集），单值键仍兼容
    const agentFilter = multiParam(u, 'agent', 'agents');
    const projectFilter = multiParam(u, 'project', 'projects');
    // I15：工作指纹筛选（branch= / permMode= / cliVer=，多值走 branchs= / permModes= / cliVers=）
    const workFilter = workParam(u);
    // 边界由服务端每次请求现算（见 rangeBounds），页面挂过午夜也不会拿着昨天的边界过滤。
    // R22：也接受显式 from=/to=（YYYY-MM-DD）自然日区间 —— 与 /api/daily 同一条 filterEntries、
    // 同一套 customBounds 口径（两者同给时显式区间优先），页面不再传算好的时间戳。
    const rangeFilter = u.searchParams.get('range') || '';
    const fromFilter = u.searchParams.get('from') || '';
    const toFilter = u.searchParams.get('to') || '';
    whenReady(() => {
      if (res.writableEnded) return;
      if (forceScan) scanNow();
      const { list, rb } = filterEntries(agentFilter, projectFilter, rangeFilter, fromFilter, toFilter, workFilter);
      // 计数仍是全量：侧栏与项目下拉要的是全局数字，不能跟着这个窗口缩水
      const { agents, projects } = counts();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ seq: bseq, total: entries.size, scanMs, idleExitMs, agents, projects, range: rangeFilter || 'all', rangeLabel: rb ? rb.label : '全部时间', rangeTotal: list.length, entries: list.slice(0, limit), shown: Math.min(limit, list.length) }));
    });
    return;
}
// 按天聚合（C2）：时间范围的**同一个筛选集**上按自然日分桶，给页面「用量统计」用。
// 注意它与快照的关键区别：这里不切「条/页」窗口 —— 聚合口径不能随显示档位变。
function routeDaily(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(dailyAgg(multiParam(u, 'agent', 'agents'), multiParam(u, 'project', 'projects'), u.searchParams.get('range') || '', u.searchParams.get('from') || '', u.searchParams.get('to') || '', workParam(u)))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
// 按模型聚合（C2 续）：参数与 /api/daily 完全一致，同样不吃 limit
function routeModels(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(modelAgg(multiParam(u, 'agent', 'agents'), multiParam(u, 'project', 'projects'), u.searchParams.get('range') || '', u.searchParams.get('from') || '', u.searchParams.get('to') || '', workParam(u)))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
// I15 工作指纹聚合：参数与 /api/daily 一致（agent/project/range/from/to + 可选的 work 筛选本身），
// 不吃「条/页」窗口。返回 branch / permMode / cliVer 三个维度的分桶 + covered（哪些 agent 有数据）。
function routeWork(req, res, u) {
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(workAgg(multiParam(u, 'agent', 'agents'), multiParam(u, 'project', 'projects'), u.searchParams.get('range') || '', u.searchParams.get('from') || '', u.searchParams.get('to') || '', workParam(u)))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
function routeAnalyze(req, res, u) {
    const agent = multiParam(u, 'agent', 'agents');
    const project = multiParam(u, 'project', 'projects');
    const range = u.searchParams.get('range') || '';
    const from = u.searchParams.get('from') || '', to = u.searchParams.get('to') || '';
    const topN = Math.min(50, Math.max(1, Number(u.searchParams.get('top')) || 10));
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(analyzeAgg(agent, project, range, from, to, topN, workParam(u))));
    });
    return;
}
function routeSession(req, res, u) {
    const key = u.searchParams.get('key') || '';
    // agent / project 是**可选**参数（不传 = 老行为，只按 session 匹配）。传了才能精确命中
    // 重名的 session —— /api/sessions 就是这么调的，否则同一 agent 下不同项目的同名会话会对不上账。
    const agent = u.searchParams.get('agent') || '';
    const project = u.searchParams.get('project') || '';
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const s = sessionAgg(key, agent, project, workParam(u));
      res.end(JSON.stringify(s || { ok: false, error: '未找到该会话（可能已被淘汰出索引或 session 为空）' }));
    });
    return;
}
// 会话列表（R6）：参数与 /api/daily 一致（agent/project/range/from/to），另加 limit。
// 同样不吃「条/页」窗口 —— 会话级汇总必须覆盖全量索引，否则会和逐轮累加对不上账。
function routeSessions(req, res, u) {
    const agent = multiParam(u, 'agent', 'agents');
    const project = multiParam(u, 'project', 'projects');
    const range = u.searchParams.get('range') || '';
    const from = u.searchParams.get('from') || '', to = u.searchParams.get('to') || '';
    const limit = Math.min(2000, Math.max(1, Number(u.searchParams.get('limit')) || 200));
    whenReady(() => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(sessionsAgg(agent, project, range, from, to, limit, workParam(u)))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
}
function routeEntry(req, res, u) {
    const id = u.searchParams.get('id') || '', full = u.searchParams.get('full') === '1';
    whenReady(() => {
      if (res.writableEnded) return;
      const c = entryContent(id, full);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(c || { user: '', assistant: '', tools: [] }));
    });
    return;
  }
// I8 单轮「复现包」数据源：把一个条目连同「原始日志片段 + 解析结果 + build 指纹」一起递出。
// 页面拿它在浏览器端打成 zip（零依赖、不引 zip 库）。筛选条件由页面 POST 过来（服务端没有筛选态），
// 原样嵌进 meta.filters，让复现包自证「当时是按什么条件看的」。
// 返回结构：{ ok, meta:{version,build,pageBuild,parserRev,generatedAt,entry,src,filters},
//            parsed: entryContent(full=1), raw: {kind,file,extractable,lines|null,note} }
// OPTIONS（CORS 预检）那条留在函数体里 —— 它是这条路由自己的分支，不是方法闸。
function routeRepro(req, res, u) {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    const id = u.searchParams.get('id') || '';
    whenReady(() => {
      if (res.writableEnded) return;
      try {
        const e = entries.get(id);
        const src = srcs.get(id);
        if (!e || !src) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: false, error: '找不到该条目（id 错误或条目已淘汰）' })); return; }
        const filters = (() => { try { return JSON.parse(u.searchParams.get('filters') || 'null'); } catch { return null; } })();
        const meta = {
          version: VERSION, build: BUILD, pageBuild: pageBuild(), parserRev: PARSER_REV,
          generatedAt: new Date().toISOString(),
          entry: e, src: { file: src.file, turn: src.turn, kind: src.kind },
          filters: filters || null,
        };
        const parsed = entryContent(id, true) || { user: '', assistant: '', tools: [] };
        const raw = reproRaw(src, e);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, meta, parsed, raw }));
      } catch (err) {
        res.statusCode = 500; res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
function routeEvents(req, res, u) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    sseClients.add(res);
    lastActivity = Date.now(); // 有人打开页面 = 有活动（空闲自停据此判断）
    req.on('close', () => sseClients.delete(res));
    whenReady(() => {
      if (res.writableEnded) return;
      // scanning：中途连上来时立刻显示进度，不用干等下一个分段（冷启动第一段 ~1.5s）
      const scan = scanState && { done: scanState.done, total: scanState.total, agent: scanState.agent };
      // build / pageBuild 一起带上：页面已经开着、服务在背后被重启过（新旧换班）时，这一条能让页面立刻发现自己配错了版本。
      // 两个指纹都要：BUILD 只哈希服务脚本，改了 page/ 下任何文件页面的 BUILD 是不变的（2026-09-21 R25 批 0 拆出 page/），
      // 只带 build 的话「编辑了页面文件 + 重启服务」这条最常见的情况页面看不见 —— 红条那条分支等于死代码。
      if (alertDirty) recomputeAlerts();
      sseWrite(res, { type: 'hello', seq: bseq, total: entries.size, scanMs, idleExitMs, build: BUILD, pageBuild: pageBuild(), agents: agentsList(), scanning: scan, alert: alertSummary(), alertIds: [...alertHits.keys()] });
    });
    return;
}

// ---------------- handle：请求入口（具名 + 导出） ----------------
// Step 2 把原来那个匿名 `http.createServer((req, res) => …)` 回调提成具名函数并导出。
// 宿主内插件**不要 server 对象** —— 宿主的 webServer 才是监听者，插件只需要一个 (req,res) 处理器；
// 这正是 hosted 模式的门。CLI 那条路仍然自己 createServer(handle) 来 listen。
//
// 派发语义与抽表前的 if 链**逐字等价**：
//   · 精确路由按表扫；方法闸分两种（见 ROUTES 的 miss 字段）：
//       miss='405' → 命中但方法不对：405 + 与原来同一条 JSON 正文；
//       miss='404' → 这条压根不算命中（原来是 `pathname && method` 同判），**继续往下找**。
//   · 前缀路由在精确路由之后（两者路径不可能同时命中，与 if 链里的先后无关）。
//   · 都没命中 → 裸文本 404 `not found`。**这行文案是地基**：路由自己答的 404 是 JSON，
//     守卫靠「裸文本」把兜底与路由分支区分开（见 test/cli-behavior-guard.mjs 的 isFallback404）。
export function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  for (const r of ROUTES) {
    if (u.pathname !== r.path) continue;
    if (r.methods && !r.methods.includes(req.method)) {
      if (r.miss === '405') { res.statusCode = 405; res.end('{"ok":false,"error":"method not allowed"}'); return; }
      break;   // 没命中这条，落到下面继续找（最终多半是兜底 404）
    }
    return r.fn(req, res, u);
  }
  for (const p of ROUTE_PREFIXES) if (u.pathname.startsWith(p.path)) return p.fn(req, res, u);
  res.statusCode = 404; res.end('not found');
}

const server = http.createServer(handle);

// 首扫就绪闸门：trace 格式没有增量偏移(off)，冷启动必须全量重读，一次能阻塞事件循环 8~10s。
// 要是把它同步放在 listen 回调(或紧邻的 setImmediate)里，端口虽然已 bind 却无法应答，
// ensure 脚本的 ping 轮询就得一直等到 hook timeout 边缘才侥幸通过。
// 所以：/api/ping 立刻应答（hook 只等它），首扫等 ping 响应写到 socket 之后再动；数据类接口排队等首扫完成。
let scanStarted = false, scanReady = false;
const readyWaiters = [];

// 定时扫描用「一次性定时器自续期」而不是 setInterval：
//   1) 改 scanMs 能立刻生效，不用重挂 interval；
//   2) scanAll 是同步阻塞的，间隔若小于单轮耗时 setInterval 会排队堆积，自续期天然不会。
// scanMs === 0 表示暂停（不排下一次），手动刷新走 runScan() 仍可扫。
let scanTimer = null;
function scheduleNextScan() {
  cancel(scanTimer); scanTimer = null;
  if (!scanMs) return;
  // 定时轮：首扫分片期间撞上了就跳过（忙），下一轮照常排 —— 排队补一轮等于刚扫完立刻再全扫一遍
  scanTimer = after(scanMs, () => { scanTimer = null; runScan(false); scheduleNextScan(); });
}
function runScan(queueIfBusy) {
  // scanAll 内部已在末尾 broadcast()，这里不要再推一次（会把脏集合读空）
  try { scanAll(queueIfBusy); } catch (e) { console.error('[scan]', e.message); }
}
// 外部触发的即时扫描（新增/禁用 agent、手动刷新），暂停状态下也执行
function scanNow() { runScan(true); scheduleNextScan(); }

function startScanning() {
  if (scanStarted) return;
  scanStarted = true;
  try { loadIndex(); } catch (e) { console.error('[index]', e.message); }
  discoverAgents();
  // 就绪闸门先放开：索引里的旧数据立刻可查，页面拿到的是「旧数据 + 扫描中」而不是「空白 + 连不上」。
  // scanAllChunked 第一件事是同步置 scanning 占位，之后才让出事件循环，
  // 所以下面 markReady() 放出的等待者（/api/snapshot、/api/events）不会撞上并发扫描。
  scanAllChunked().catch(e => console.error('[scan]', e.message));
  markReady();
  scheduleNextScan();
  // 下面三条都由登记表看着（Step 2 副作用收口）：原先裸 setInterval/setTimeout，挂上就再也撤不掉；
  // 现在 stop() 一句 clearTimers() 全停 —— hosted 模式要的正是「停得下来」。
  every(saveIndex, 60000); // 周期落盘（无改动时直接跳过）
  scheduleAutoArchive();   // 每日自动归档（默认开；见 scheduleAutoArchive）
  scheduleAutoSearch();    // 后台增量建全文索引（R33；见 scheduleAutoSearch）
}
function markReady() {
  scanReady = true;
  for (const fn of readyWaiters.splice(0)) { try { fn(); } catch (e) { console.error('[ready]', e.message); } }
}
function whenReady(fn) { if (scanReady) fn(); else { readyWaiters.push(fn); startScanning(); } }


// ---------------- 生命周期：start(opts) / stop(reason) ----------------
// 载体（CLI 入口 / 插件宿主）装配服务的地方。**状态仍是模块级单例**，不做闭包化（§5 第 3 条）：
// 闭包化会把「搬家」变成「重写」，而插件与 CLI 天然不同进程，单例足够。
//
// opts（四个字段就是与插件侧的会签面，改形状要同步 claude-step.md §0.5）：
//   mode       'cli' | 'lib' | 'hosted'（默认 'cli'）—— 见文件头 MODE 那一段
//   listen     要不要自己 listen（默认：只有 cli 才 listen）。hosted 的流量由宿主 webServer 转进 handle()
//   keepAlive  要不要挂 SSE 心跳（默认 true）。原先由 CLI 旗标 ENSURE 反推，现在由调用方直说
//   exitPolicy stop(reason) 里怎么收场：cli 传 c => process.exit(c)，hosted 传空函数（只停循环）
//   originIsLocal  写操作的 Origin 判据（可选，u => boolean，u 是 Origin 头解析出的 URL）。
//                  不传 = 用按 MODE 的内置判据（cli：环回 + 端口必须是 PORT；hosted：环回主机名
//                  端口不限 + dsh-app 协议）。宿主想只认自己那一个 Origin 就传这个，别去改插件外的东西。
// 返回 { mode, listen, keepAlive } 供宿主自检；listen 那条路会等到真的 listening 才 resolve。
const MODES = ['cli', 'lib', 'hosted'];
export async function start(opts = {}) {
  const mode = opts.mode || 'cli';
  if (!MODES.includes(mode)) throw new Error('[agent-acta] start({mode}) 只认 ' + MODES.join(' / ') + '，收到：' + mode);
  MODE = mode;
  const listen = opts.listen === undefined ? mode === 'cli' : !!opts.listen;
  const keepAlive = opts.keepAlive === undefined ? true : !!opts.keepAlive;
  exitPolicy = typeof opts.exitPolicy === 'function' ? opts.exitPolicy
    : (mode === 'cli' ? (code => process.exit(code)) : (() => {}));
  // Origin 闸：**每次 start 都重新定**（不传就回到按 MODE 的内置判据）。
  // 这句重置是必需的：originGate 是模块级单例，不重置的话同一进程里第二次 start 会继承上一次的口径。
  setOriginGate(opts.originIsLocal);
  // 写闸按新 MODE 重装：readOnly 与落盘钩子在模块加载时就按 'lib' 定死了（hosted 那一刻 argv[1] 是宿主入口），
  // 不重装的话插件会得到一个「能扫不能存」的服务 —— 而且不报错。
  assemble();

  // ① 数据目录：建目录 → 读配置 → 模型名映射（原 runCli 默认分支的头几行，逐字照搬）。
  //    注意**搬家不在这一步**：migrateDataDir 要探端口、且是「老 CLI 的数据往哪儿搬」的入口语义，
  //    宿主里的插件不该替用户搬（配置搬错不可逆，见 migrateDataDir 上方那段）。CLI 入口自己先 await 它。
  fs.mkdirSync(DATA_DIR, { recursive: true });
  loadConfig();
  loadModelDisplayMap(QODER_RUNS_DIR);

  if (keepAlive) startHeartbeat();

  if (!listen) {
    // hosted：没有自己的端口，就没有 /api/ping 来触发首扫 —— 这里直接踢第一轮。
    // 归档轮 / 搜索轮 / 周期落盘都挂在 startScanning 里，不主动踢等于「写路径开着但什么都不发生」。
    startScanning();
    return { mode, listen, keepAlive };
  }

  server.listen(PORT, '127.0.0.1', () => {
    log('[agent-acta] listening on http://127.0.0.1:' + PORT + ' (data: ' + DATA_DIR + ')');
    checkPageAssets();
    // pid 文件与空闲自停只属于「自己攥着端口」的那个载体。hosted 不 listen ⇒ 这个回调压根不跑
    // ⇒ 写 pid / 挂 checkIdle 两个副作用一起不发生。这里再判一次 listen 是兜底：万一有人给
    // hosted 传了 listen:true，PID_FILE 记的也是宿主进程的 pid，「没人看就退出宿主」更不是插件该干的事。
    if (listen) {
      // 写完 pid 文件才算「本实例持有端口」；EADDRINUSE 分支在入口那边已退出，不会走到这
      try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
      every(checkIdle, 30000); // 空闲自停检查（阈值最短 30min，30s 精度够；没开启时直接返回）
    }
  });
  // 等真正 listening 再 resolve：调用方 await 完就知道「端口通了」。
  // 同时听 'error' 是为了**绝不挂死** —— EADDRINUSE 时入口那个 handler 会 process.exit，
  // 但万一换了别的载体没装 handler，这里也得把 promise 放掉。
  await new Promise(res => {
    const done = () => { server.off('listening', done); server.off('error', done); res(); };
    server.once('listening', done);
    server.once('error', done);
  });
  return { mode, listen, keepAlive };
}

// R12 / R25 批 0 的启动自检：页面文件必须还带着共享片段占位符。占位符没了 = 页面被换成不走注入
// 机制的旧版/拷贝，浏览器端会白屏（页面侧另有兜底文案）—— 在这里先喊出来，别等用户报「页面打不开」。
// 原先是写在入口 listen 回调里的一段匿名代码，搬进 start() 时提成具名函数（hosted 模式也要能单独调）。
function checkPageAssets() {
  try {
    const pageSrc = fs.readFileSync(PAGE_FILE, 'utf8');
    if (!pageSrc.includes('__AGENT_LOG_SHARED__'))
      console.error('[agent-acta] ⚠ 页面文件缺少 __AGENT_LOG_SHARED__ 占位符：' + PAGE_FILE + '\n' +
        '  共享片段（projNorm/projKey/rangeDayStart）将无法注入，页面会白屏。页面文件被换成旧版了？');
    // R25 批 0 自检：页面文件指纹占位符 + 页面引用的每个 /page/ 文件都得在（少一个就是白屏/样式全丢）。
    if (!pageSrc.includes('__AGENT_LOG_PAGE_BUILD__'))
      console.error('[agent-acta] ⚠ 页面文件缺少 __AGENT_LOG_PAGE_BUILD__ 占位符：' + PAGE_FILE + '\n' +
        '  页面文件指纹将无法注入，红条不再能发现「旧页面配新页面文件」。页面文件被换成旧版了？');
    for (const m of pageSrc.matchAll(/(?:src|href)="\/page\/([^"]+)"/g))
      if (!fs.existsSync(path.join(PAGE_DIR, m[1])))
        console.error('[agent-acta] ⚠ 页面引用的 /page/ 文件不存在：' + m[1] + '（应为 ' + path.join(PAGE_DIR, m[1]) + '）');
  } catch (e) {
    console.error('[agent-acta] ⚠ 读不到页面文件 ' + PAGE_FILE + '：' + e.message);
  }
}


// ---------------- 服务侧对外的名字（给 CLI 入口用） ----------------
// 用一条显式 export 列表，而不是给每个声明加 export：这份清单就是「入口到底依赖了服务侧的什么」的答案，
// 一眼能看完，搬家时也不会漏掉一个（漏了的症状是某个分支运行到才 ReferenceError）。
//
// **Step 2 的会签面**（claude-step.md §0.5，插件侧按这四个名字写 plugin.mjs）：
//   handle(req, res)         请求入口 —— 宿主内只要它，不要 server 对象
//   ROUTES / ROUTE_PREFIXES  路由表（表 ≡ test/routes.expected.json，守卫盯着）
//   start(opts)              装配并起服务 { mode, keepAlive, listen, exitPolicy }
//   stop(reason)             停服务（退出权由 start 注入的 exitPolicy 决定）
// 另有 MODE / MODES 供宿主自查现在跑在哪个载体。改这四个名字或字段就同步改 §0.5，别悄悄换。
export {
  BUILD, CONFIG_FILE, DATA_DIR, HOME, INDEX_DIR, LEGACY_CONFIG_NAME,
  LEGACY_DATA_DIRS, MODE, MODES, PAGE_DIR, PAGE_FILE, PID_FILE, PORT,
  QODER_RUNS_DIR, ROOT, ROUTE_PREFIXES, ROUTES, SEARCH_MAX_CHARS, VERSION, agentConfs, agentsList,
  analyzeAgg, archiveCfg, checkIdle, confAvailable, counts, dailyAgg,
  diagnose, entryContent, filterEntries, hasRealConfig, legacyWithConfig, loadConfig,
  loadIndex, modelAgg, pageBuild, projKey, projNorm, rangeDayStart,
  saveConfig, saveIndex, scanAll, scanAllSync, scanBranch, scanMs,
  scheduleSave, server, sessionAgg, sessionsAgg, workAgg
  // handle / start / stop 是本文件里 `export function` 直接给的，别再列一遍（重复导出行会直接报语法错）
};
