#!/usr/bin/env node
// Agent 请求日志聚合服务
// 聚合 atomcode / codebuddy / workbuddy / claude / codex / codearts / gemini / cursor / kimi / dsh 等多款 AI agent 的本地日志，
// 增量扫描 + 内存索引 + HTTP API + SSE 实时推送。后台常驻, http://127.0.0.1:14570
// 用法（`agentacta` 是装好之后的命令名；在源码目录里直接跑就是 node agent-acta-server.mjs）:
//   agentacta                    前台常驻（服务本体）
//   agentacta --ensure           确保服务在跑（已在跑则幂等退出）——agent hook / npm bin 用
//   agentacta --open             等价 --ensure --open：起服务 + 打开浏览器（隐式进拉起模式）
//   agentacta --client           起桌面悬浮卡片（无边框置顶小窗：今日/累计 token + 最新卡片流 + 水球模式）。
//                                首次执行会把 Electron 运行时（~100MB）装到 ~/.agent-acta/widget-runtime/，
//                                默认走 npmmirror（ELECTRON_MIRROR 可覆盖）；装一次，之后只是启动。
//                                卡片开着 = 有 SSE 连接 = 服务不会空闲自停。关卡片点悬停露出的 ✕
//   agentacta --stop             停掉已在跑的服务（优雅关闭，先落盘索引；拿不到响应才按 pid 强杀）
//   agentacta --status           查状态：服务在不在跑、端口上那版和本包是否一致、悬浮卡片开着没。
//                                退出码给脚本用：0 在跑且与本版一致 / 1 在跑但版本不一致或问不出 / 2 没在跑
//   agentacta --doctor           自检：一次体检输出一段**可粘贴的病历** —— 配置能不能解析、配置指向的目录
//                                还在不在、索引片有没有损坏 / 口径跟当前代码对不对得上、端口上跑的是不是
//                                这一版、页面文件齐不齐、归档现在多大。**只读**：不搬数据、不改配置
//                                （体检本身不该改变被诊断的状态）。退出码：0 无失败项 / 1 有失败项
//   agentacta --where            打印自身安装路径 + 两段可直接抄的 hook 命令
//   agentacta --version, -v      打印版本号 + 服务脚本指纹（用来判断端口上跑的是不是这一版）
//   agentacta --help, -h         打印这段用法
//   agentacta --install-hooks    把「会话启动时 --ensure」写进 atomcode / claude 的 hook 配置
//   agentacta --uninstall-hooks  移除上面写入的 hook
//      上面两条可加 --agent atomcode,claude 限定目标，加 --dry 只报不改
//   agentacta --archive          归档一次：把「已结束、且早于今天」的条目连详情快照冻进
//                                ~/.agent-acta/archive/（有些 agent 自己删日志，不冻就永久没了）。
//                                服务在跑时也会每天自动归档一次；这条命令是手动补跑/排查用的
//                                策略全在 config.json 的 archive 段：enabled / skip（**按 agent 关掉归档**，
//                                只停未来、不删已冻的）/ maxDays / maxMB（限量保留，只删整天文件）；
//                                skip 也能在页面「历史归档」里逐个 agent 开关（POST /api/archive/skip）
//      加 --list 打印归档清单，加 --dry 只报要写什么、不落盘
//   agentacta --search-reindex   手动把全文搜索索引（~/.agent-acta/search/）重建一遍：
//                                把每条轮次的正文（用户输入 / AI 回复 / 工具入参返回）抽出来存成
//                                可检索的索引，供页面搜索框**回车**时的全库检索用。
//                                日常不用跑——常驻服务启动 60 秒后自己建首轮，之后每 10 分钟一轮增量。
//                                服务在跑时**拒绝执行**（索引只有它一个写者）：先 --stop 或加 --dry 看统计
//   agentacta-mcp                以 MCP server 的身份跑（stdio，给 Claude/Cursor/Qoder 这类客户端当工具用）：
//                                七个只读工具 overview / search_entries / get_entry / list_sessions /
//                                usage_stats / slowest_turns / tool_fails。独立进程**直读**日志与索引，不连 14570、
//                                不写任何文件（只读门在本服务端里，两条入口共享），所以常驻服务在不在跑都可用
//   认不出来的参数直接报错退出——不会默默变成「起一个前台服务」占住端口和终端
//   代码位置随意（自定位）；用户数据（config/index/pid）固定在 ~/.agent-acta/，与任何 agent 的安装目录无关
//   —— 2.0.0 起从 ~/.agent-log/ 搬过来（再往前是 ~/.atomcode/agent-log/，两条老位置都认），下次启动服务时自动搬
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

// ---------------- 归档（历史条目冻结，见 archive.mjs 开头的三条硬设计） ----------------
import { initArchive, archiveRun, archiveIndex, archiveEntries, archiveEntry, pruneArchive, archiveRoot, fmtBytes } from './archive.mjs';

// ---------------- 全文搜索索引（R33 / 候选池 I10，见 search.mjs 开头的四条硬设计） ----------------
import { initSearch, loadSearch, searchRun, searchEntries, searchStatus, searchRoot, foreignPath, toolFailsOf, searchBuilding } from './search.mjs';

// ---------------- 解析器（parsers/，2026-09-17 从本文件拆出，纯搬家零逻辑改动） ----------------
import { files, entries, srcs, pidCwd, dirty, removedIds, agentNotices, kindDirty, sorted,
         OFF_KINDS, PARSER_REV, CTX_WINDOW_KINDS, CTX_WINDOWS_DEFAULT, ctxUser, ctxWindows,
         loadCtxWindows, setSaveHook, markKind, modelName, modelList, windowOf, toText, trunc,
         listDirCached, sqliteMod, isDir, isFile, loadModelDisplayMap } from './parsers/shared.mjs';
import { scanAtomcodeDir, atomcodeDirs, atomcodeEntryContent } from './parsers/atomcode.mjs';
import { scanTraces, resolveCwd, setAgentConfs } from './parsers/trace.mjs';
import { scanClaude, claudeEntryContent } from './parsers/claude.mjs';
import { scanDoubao, doubaoEntryContent } from './parsers/doubao.mjs';
import { scanBuddy, buddyEntryContent } from './parsers/buddy.mjs';
import { scanCodex, codexEntryContent } from './parsers/codex.mjs';
import { scanKimi, kimiEntryContent } from './parsers/kimi.mjs';
import { scanComate, comateEntryContent } from './parsers/comate.mjs';
import { scanDsh, DSH_ZSTD_OK } from './parsers/dsh.mjs';
import { scanCodearts } from './parsers/codearts.mjs';
import { scanGemini } from './parsers/gemini.mjs';
import { scanCursor, cursorTranscriptFiles, CURSOR_NO_USAGE_NOTE, CURSOR_MODEL_NOTE, CURSOR_HOOK_NOTE } from './parsers/cursor.mjs';
import { scanZcode, zcodeScanErr } from './parsers/zcode.mjs';
import { scanOpencode, opencodeScanErr, opencodeEntryContent } from './parsers/opencode.mjs';
import { scanHermes, hermesScanErr, hermesEntryContent } from './parsers/hermes.mjs';
import { scanDevinDb, devinDbErr, devinDbEntryContent } from './parsers/devindb.mjs';
import { scanMavis, mavisEntryContent } from './parsers/minimax.mjs';
import { scanOpenclaw, openclawEntryContent, openclawUserText } from './parsers/openclaw.mjs';
import { scanCline, clineScanErr, clineEntryContent } from './parsers/cline.mjs';
// buddyext（CodeBuddy 扩展版：VSCode / CodeBuddyIDE / JetBrains 共用的 genie 扩展，
// %LOCALAPPDATA%\CodeBuddyExtension\Data）—— 与 parsers/buddy.mjs 那个 CodeBuddy **CLI**（~/.codebuddy）
// 是两个产品、两份落盘，故独立成 kind=buddyext、独立成侧栏 agent=codebuddy-ext。
import { scanBuddyExt, buddyExtScanErr, buddyExtEntryContent } from './parsers/buddyext.mjs';
// ↑ kind=buddyext 的会话**并到 codebuddy 这一个 agent 名下**（同产品的第二份落盘，不是第二个产品），
//   所以侧栏没有 codebuddy-ext 这一行；根从 buddyExtDataRoots() 每轮重算，挂在 codebuddy.sessionsExtra 上。
import { scanTraecode, scanTraework, traeEntryContent } from './parsers/tracecode.mjs';
import { scanTraeDb, traeDbErr, traeDbEntryContent } from './parsers/traedb.mjs';
import { scanCopilot, copilotScanErr, copilotTurnStart } from './parsers/copilot.mjs';
import { scanGeneric, genericEntryContent, validateGenericRules, genericRulesHash, genericTurnStart } from './parsers/generic.mjs';
import { scanMimocode, mimocodeEntryContent } from './parsers/mimocode.mjs';
import { scanKilo, kiloScanErr, kiloEntryContent } from './parsers/kilo.mjs';
// I8：单轮「复现包」的原始日志片段提取（复用各解析器的开轮判定，保证与扫描口径一致，不另写一份）。
// 只针对「单文件逐行 jsonl」的 kind 做提取；其余 kind（数据库 / 内存 / 多文件）诚实标不可提取。
import { readCompleteLines } from './parsers/shared.mjs';
import { claudeUserText, claudeIsToolResultOnly, claudeIsCommandText } from './parsers/claude.mjs';
import { buddyUserText } from './parsers/buddy.mjs';
import { mavisUserText } from './parsers/minimax.mjs';
import { sniffBase, candidateBases, probeBases, kimiDesktopSessionsRoots, kimiWires, kimiWireIn, isKimiWire,
         buddyExtDataRoots, buddyExtMissingWhy,
         dshSessionFile, hasDshSessions, zcodeDbVerify, zcodeDbFile,
         opencodeDbFile, opencodeDbVerify,
         traeDbFile, traeLogKindOf, traeLogsFromDb,
         hasCodeartsLogs, hasTraceFiles, hasCodexRollouts, hasClaudeJsonl, hasBuddyJsonl,
         hasGeminiSessions, hasCursorTranscripts, hasKimiSessions, hasTraeRendererLogs } from './parsers/discovery.mjs';


const ARGV = process.argv.slice(2);
const OPEN_URL = ARGV.includes('--open'); // 拉起后顺带打开浏览器（替代原来的 autostart.vbs）
// 拉起模式：不启服务本体，只保证它在跑（替代原来的 ensure.vbs）。
// --open 隐式进拉起模式：否则 `agentacta --open` 会把服务跑在前台占住终端、且永远走不到 openBrowser——
// 用户看到的「起服务 + 自动开页面」就变成了「卡住 + 什么都不开」。裸跑（无参数）仍是前台常驻。
const ENSURE = ARGV.includes('--ensure') || OPEN_URL;
const SHOW_WHERE = ARGV.includes('--where');            // 只打印自身路径与 hook 命令，给别人配 hook 用
const INSTALL_HOOKS = ARGV.includes('--install-hooks');  // 把 hook 写进 atomcode / claude 的配置
const UNINSTALL_HOOKS = ARGV.includes('--uninstall-hooks');
const DRY_RUN = ARGV.includes('--dry');                  // 与上面两条搭配：只报要改什么，不落盘
const STOP = ARGV.includes('--stop');                    // 停掉已在跑的服务（唯一的停止入口）
const CLIENT = ARGV.includes('--client');                // 起桌面悬浮卡片（Electron 壳，首跑自动装运行时）
const SHOW_VERSION = ARGV.includes('--version') || ARGV.includes('-v');
const STATUS = ARGV.includes('--status');                // 纯查询：服务/卡片现在是什么状态（见 runStatus）
const DOCTOR = ARGV.includes('--doctor');                // 纯查询：一次体检（见 runDoctor）
const ARCHIVE = ARGV.includes('--archive');              // 手动归档一次（--list 打印清单；服务内另有每日自动归档）
const ARCHIVE_LIST = ARGV.includes('--list');            // 只配 --archive 用：打印归档清单，不做归档
const SEARCH_REINDEX = ARGV.includes('--search-reindex'); // 手动重建全文索引（R33；服务内另有后台增量轮）
const HELP = ARGV.includes('--help') || ARGV.includes('-h');

const AGENT_FILTER = (() => {                            // --agent atomcode,claude
  const i = ARGV.indexOf('--agent');
  if (i < 0) return null;
  return (ARGV[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
})();


// 参数校验：认不出来的参数不能静默忽略。
// 静默的代价不是「没反应」而是「有副作用」——所有开关都落空，就会一路走到文件末尾的默认分支＝
// 前台常驻起服务，于是 `agentacta --versoin`（任何 typo 同理）会占住 14570 端口和当前终端，
// 而使用者以为自己只是在查个版本。--version / --help 恰是最常被敲的两个参数，以前连它们都在这个坑里。
// 校验必须早于任何副作用（建数据目录 / 抢端口 / 写 hook），所以放在这里而不是 dispatch 里。
// 退出码用 2：跟「跑起来了但失败」（1）分开，脚本好分辨是参数写错了还是执行错了。
const KNOWN_FLAGS = ['--open', '--ensure', '--where', '--stop', '--status', '--doctor', '--install-hooks', '--uninstall-hooks',
  '--dry', '--agent', '--client', '--version', '--help', '-v', '-h', '--archive', '--list', '--search-reindex'];
const FLAGS_WITH_VALUE = ['--agent'];   // 吃一个值的参数：它的值不算「未知参数」，别误报
// 判据从 LIB 换成 MODE === 'cli'（Step 2）：加载时只有两种可能 —— 'cli'（argv[1] 就是本文件）
// 或 'lib'（被 mcp-server.mjs import）。'hosted' 只可能出现在调过 start({mode:'hosted'}) 的进程里，
// 而那种进程的顶层早已跑完，判不到这里。语义与原来的 `!LIB` 逐字相同。
if (MODE === 'cli') {
  // 只读库模式下整段跳过：这时 ARGV 是**入口脚本**（mcp-server.mjs）的参数，服务这套 CLI 校验管不着它。
  const unknown = [];
  for (let i = 0; i < ARGV.length; i++) {
    if (FLAGS_WITH_VALUE.includes(ARGV[i])) { i++; continue; }
    if (!KNOWN_FLAGS.includes(ARGV[i])) unknown.push(ARGV[i]);
  }
  if (unknown.length) {
    console.error('[agent-acta] 不认识的参数：' + unknown.join(' '));
    console.error('[agent-acta] 支持的参数见：agentacta --help');
    process.exit(2);
  }
  // --list 只配 --archive 用。不拦的话 `agentacta --list` 会一路落到默认分支＝前台起服务占住端口，
  // 而敲它的人以为自己只是想看个清单（同「typo 变成起服务」那个坑）。
  if (ARGV.includes('--list') && !ARGV.includes('--archive')) {
    console.error('[agent-acta] --list 只配合 --archive 用：agentacta --archive --list');
    process.exit(2);
  }
}


import { setClientSpawner, MODE, start, stop,
  BUILD, CONFIG_FILE, DATA_DIR, HOME, INDEX_DIR, LEGACY_CONFIG_NAME,
  LEGACY_DATA_DIRS, PAGE_DIR, PAGE_FILE, PID_FILE, PORT, QODER_RUNS_DIR,
  ROOT, SEARCH_MAX_CHARS, VERSION, agentConfs, agentsList, analyzeAgg,
  archiveCfg, confAvailable, counts, dailyAgg, diagnose,
  entryContent, filterEntries, hasRealConfig, legacyWithConfig, loadConfig, loadIndex,
  modelAgg, pageBuild, projKey, projNorm, rangeDayStart, saveConfig,
  scanAll, scanAllSync, scanBranch, scanMs,
  server, sessionAgg, sessionsAgg, workAgg
} from './core/service.mjs';

// 入口把「唤起悬浮卡片」注入服务侧。runClient → runEnsure → spawnServer 这一串**必须留在入口**：
// spawnServer 里那句 fileURLToPath(import.meta.url) 得指入口文件本身，跟着搬进 core 就会去 spawn
// core/service.mjs（那时 argv[1] 不是入口 ⇒ LIB 为真 ⇒ 什么都不会发生，而且不报错）。
// core 不能反向 import 入口，所以用这个可空钩子（core 里 /api/client 那条路由用它）。
setClientSpawner(() => runClient());

// `agentacta --archive [--list] [--dry]`：不启 HTTP、不占端口，走和默认分支同一套「先搬家 → 读配置 →
// 读索引 → 扫一轮 → 归档」。必须真的扫一轮：归档只冻内存里的条目，不扫就没有条目可冻。
async function runArchiveCli() {
  await migrateDataDir();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  loadConfig();
  loadModelDisplayMap(QODER_RUNS_DIR);
  if (ARCHIVE_LIST) { printArchiveList(); return 0; }
  try { loadIndex(); } catch (e) { console.error('[index]', e.message); }
  scanAll(true);
  const stat = await archiveRun({ dry: DRY_RUN, skip: archiveCfg.skip, log: m => console.log('[archive] ' + m) });
  const pruned = (!DRY_RUN && (archiveCfg.maxDays || archiveCfg.maxMB))
    ? pruneArchive({ maxDays: archiveCfg.maxDays, maxMB: archiveCfg.maxMB, dry: DRY_RUN, log: m => console.log('[archive] ' + m) })
    : { removed: 0 };
  if (stat.skipped) console.log('[archive] 按 config.archive.skip 跳过 ' + stat.skipped + ' 条（' + archiveCfg.skip.join(', ') + '）');
  console.log('[archive] ' + (DRY_RUN ? '试运行（未落盘）：' : '') +
    '扫到 ' + stat.scanned + ' 条可归档条目，本次处理 ' + stat.processed +
    ' 条 → 新冻 ' + stat.archived + ' / 更新 ' + stat.updated + ' / 已是最新 ' + stat.unchanged +
    (stat.noDetail ? ' / 无详情 ' + stat.noDetail : '') +
    (DRY_RUN ? '，涉及 ' + stat.days + ' 个日期文件' : '，写入 ' + stat.days + ' 个日期文件 ' + fmtBytes(stat.bytes)) +
    (stat.failed ? '，失败 ' + stat.failed : ''));
  if (stat.capped) console.log('[archive] 本轮只处理了最老的 ' + stat.processed + ' 条：再跑一次接上（或等服务内自动轮继续）');
  if (pruned.removed) console.log('[archive] 保留策略删除 ' + pruned.removed + ' 个日期文件 ' + fmtBytes(pruned.bytes));
  return stat.failed ? 1 : 0;
}

function printArchiveList() {
  const ix = archiveIndex();
  // 被 skip 关掉的 agent 要明说：不然「清单里怎么没有 cursor」会变成一次排障。
  // 注意它只影响**未来**的归档 —— 关之前冻下的文件仍列在上面，不会被这个开关删掉。
  const skipLine = archiveCfg.skip.length
    ? '  已排除（config.archive.skip，不再归档新条目；已有归档保留）：' + archiveCfg.skip.join(', ')
    : '';
  if (!ix.totals.days) {
    console.log('[archive] 还没有归档（' + ix.root + '）—— 跑 agentacta --archive 生成');
    if (skipLine) console.log(skipLine);
    return;
  }
  console.log('[archive] ' + ix.root);
  console.log('  共 ' + ix.totals.agents + ' 个 agent / ' + ix.totals.days + ' 个日期文件 / ' +
    ix.totals.count + ' 条 / ' + fmtBytes(ix.totals.bytes));
  for (const a of ix.agents) {
    console.log('  ' + a.agent.padEnd(12) + a.days + ' 天  ' + (a.unknown ? '≥' : '') + a.count + ' 条  ' +
      fmtBytes(a.bytes) + '  最近 ' + a.lastDay);
  }
  if (skipLine) console.log(skipLine);
}

// `agentacta --search-reindex [--dry]`：手动把全文索引（~/.agent-acta/search/）重建/补建一遍。
// 什么时候需要它：改了 search.mjs 的取文口径（那要 bump 里面的卡片）想立刻生效、或者索引被手工删了
// 不想等后台轮（首轮要等 60 秒，之后每 10 分钟一轮）。日常用不着 —— 服务自己会维护。
//
// 三条与其他 CLI 不同的地方：
//   1) **服务在跑时拒绝执行**（--dry 除外）。索引分片是「一个 kind 一整片」，服务里那个后台轮
//      正在写同一批文件 —— 两边同时写就是丢更新。归档那边靠「合并而不是重建」侥幸躲得过，
//      这里不赌：让常驻服务自己维护才是唯一的写者，要立刻重建就先 --stop。
//   2) 必须真的扫一轮。索引只覆盖「内存里的条目」，而 entries 是扫描链填的 —— 不扫就没条目可索引。
//   3) --dry 只统计不落盘，但**代价照付**（真的把每个源读了一遍），别指望它快。
async function runSearchReindexCli() {
  await migrateDataDir();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  loadConfig();
  loadModelDisplayMap(QODER_RUNS_DIR);
  if (!DRY_RUN && await portOpen(600)) {
    console.log('[agent-acta] 服务正在跑（端口 ' + PORT + '）—— 全文索引由它自己维护：首轮在启动 60 秒后，之后每 10 分钟一轮增量。');
    console.log('[agent-acta] 要立刻整体重建：先 agentacta --stop 再跑本命令；只想看统计就加 --dry。');
    return 2;
  }
  try { loadIndex(); } catch (e) { console.error('[index]', e.message); }
  scanAll(true);
  const t0 = Date.now();
  const stat = await searchRun({ force: true, maxFiles: 0, dry: DRY_RUN, log: m => console.log('[search] ' + m) });
  const st = searchStatus();
  console.log('[search] ' + (DRY_RUN ? '试运行（未落盘）：' : '') +
    '扫到 ' + st.total + ' 条内存条目 → 重建 ' + stat.indexed + ' 个源 / 跳过 ' + stat.skipped +
    ' / 抽了 ' + stat.entries + ' 条正文' + (stat.unreadable ? ' / 读不出 ' + stat.unreadable + ' 条' : '') +
    (stat.cut ? ' / ' + stat.cut + ' 条被 ' + SEARCH_MAX_CHARS + ' 字上限截断' : ''));
  console.log('[search] 索引里可查 ' + st.entries + ' 条 / ' + st.files + ' 个源，' +
    fmtBytes(DRY_RUN ? stat.bytes : st.bytes) + '，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (stat.unreadable) console.log('[search] 读不出正文的条目：源文件当时打不开（多半已被产品删掉）。这些条搜不到，但不会产生假命中。');
  // 索引记录按**绝对路径**认源，所以把 ~/.agent-acta 搬去另一台机器/另一个平台后，旧记录一律解析不出来。
  // 载入时已经剪掉它们（这一步也会把盘上那份清干净），这里只如实交代一句。
  if (st.pruned) console.log('[search] 剪掉 ' + st.pruned + ' 条源不在本机的旧记录：多半是换平台/换机器搬过来的（日志已删也一样）。它们解析不出条目 id，留着只会让可查条数虚高。');
  return stat.savedOk === false ? 1 : 0;
}

// ---------------- hook 安装 / 卸载（--install-hooks / --uninstall-hooks / --where） ----------------
// 目的：别人装完包（npm i -g <tgz>）不用手抄 JSON，一条命令把「会话启动时 --ensure」写进各 agent 自己的 hook 配置。
// 两条硬约束（都实测踩过）：
//   1) atomcode 的 hook command 不经过 shell —— 引号会被当成路径的一部分，所以既不能加引号、路径也不能含空格；
//   2) claude 的 hook command 走 shell —— 路径含空格时必须加引号。
// 安全约定：目标文件解析失败就整体放弃、一个字都不改；改动前先把原文件备份成 <文件名>.bak。
const SELF_PATH = fileURLToPath(import.meta.url).replace(/\\/g, '/'); // 统一正斜杠：node 与 JSON 都吃得下
// 键名（atomcode 用）。改名前的旧键 `agent-log` 不用单独列：它里面那条命令写着旧文件名，
// 会被下面 isOurs 的双名判据认出来并删掉（见 planAtomcode 的收拢分支）。
const HOOK_NAME = 'agent-acta';
const HOOK_TIMEOUT_MS = 15000;
const HOOK_AGENTS = ['atomcode', 'claude'];

function hookTargets() {
  return [
    { agent: 'atomcode', file: path.join(HOME, '.atomcode', 'hooks.json'), home: path.join(HOME, '.atomcode') },
    { agent: 'claude', file: path.join(HOME, '.claude', 'settings.json'), home: path.join(HOME, '.claude') },
  ];
}
// 「这条 hook 是不是我们写的」——**旧文件名要长期一起认**。
// 判据只看命令里的脚本文件名（与路径无关）。2.0.0 改名时如果只认新名，老机器上已经写好的 hook
// 就既收不拢也卸不掉：--install-hooks 会并列再写一条（claude 变两个 SessionStart、atomcode 留两个键），
// 于是每次开会话都把服务拉两遍，其中一条还指向早已不存在的文件。
const isOurs = s => typeof s === 'string' &&
  (s.includes('agent-acta-server.mjs') || s.includes('agent-log-server.mjs'));

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { data: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { data: {} };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: '顶层不是对象' };
    return { data };
  } catch (e) { return { error: e.message }; }
}
function saveJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // 只留「改动前一刻」这一份
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// atomcode: ~/.atomcode/hooks.json  {hooks:{<名字>:{event,command,timeout_ms}}}
function planAtomcode(data, install) {
  const j = JSON.parse(JSON.stringify(data));
  if (install && /\s/.test(SELF_PATH)) {
    return { skip: 'atomcode 的 hook 命令不经过 shell、引号会被当路径，当前路径含空格无法写：' + SELF_PATH };
  }
  if (install) {
    if (j.hooks === undefined) j.hooks = {};
    if (!j.hooks || typeof j.hooks !== 'object' || Array.isArray(j.hooks)) return { skip: 'hooks 字段不是对象' };
    // 别的名字但指向本脚本的，也认作已装 → 收拢成标准名，免得一条服务被拉起两次
    for (const [k, v] of Object.entries(j.hooks)) if (k !== HOOK_NAME && isOurs(v && v.command)) delete j.hooks[k];
    j.hooks[HOOK_NAME] = { event: 'session_start', command: `node ${SELF_PATH} --ensure`, timeout_ms: HOOK_TIMEOUT_MS };
  } else {
    if (!j.hooks || typeof j.hooks !== 'object' || Array.isArray(j.hooks)) return { next: j };
    for (const [k, v] of Object.entries(j.hooks)) if (k === HOOK_NAME || isOurs(v && v.command)) delete j.hooks[k];
    if (!Object.keys(j.hooks).length) delete j.hooks;
  }
  return { next: j };
}

// claude: ~/.claude/settings.json  {hooks:{SessionStart:[{hooks:[{type:'command',command,timeout}]}]}}
function planClaude(data, install) {
  const j = JSON.parse(JSON.stringify(data));
  const entry = { type: 'command', command: `node "${SELF_PATH}" --ensure`, timeout: 15 };
  if (install) {
    if (j.hooks === undefined) j.hooks = {};
    if (!j.hooks || typeof j.hooks !== 'object' || Array.isArray(j.hooks)) return { skip: 'hooks 字段不是对象' };
    if (!Array.isArray(j.hooks.SessionStart)) j.hooks.SessionStart = [];
    let found = false;
    for (const group of j.hooks.SessionStart) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (let i = group.hooks.length - 1; i >= 0; i--) {
        if (!isOurs(group.hooks[i] && group.hooks[i].command)) continue;
        if (found) group.hooks.splice(i, 1);          // 重复条目删掉
        else { group.hooks[i] = entry; found = true; } // 第一个原位更新
      }
    }
    if (!found) j.hooks.SessionStart.push({ hooks: [entry] });
  } else {
    if (!j.hooks || typeof j.hooks !== 'object' || Array.isArray(j.hooks)) return { next: j };
    if (!Array.isArray(j.hooks.SessionStart)) return { next: j };
    j.hooks.SessionStart = j.hooks.SessionStart
      .map(g => (g && Array.isArray(g.hooks)) ? { ...g, hooks: g.hooks.filter(h => !isOurs(h && h.command)) } : g)
      .filter(g => !(g && Array.isArray(g.hooks) && !g.hooks.length));
    if (!j.hooks.SessionStart.length) delete j.hooks.SessionStart;
    if (!Object.keys(j.hooks).length) delete j.hooks;
  }
  return { next: j };
}

function runHooks(install) {
  const unknown = (AGENT_FILTER || []).filter(a => !HOOK_AGENTS.includes(a));
  if (unknown.length) { console.log(`! --agent 只认 ${HOOK_AGENTS.join(' / ')}，不认识：${unknown.join(', ')}`); return 1; }
  const targets = hookTargets().filter(t => !AGENT_FILTER || AGENT_FILTER.includes(t.agent));
  let changed = 0, blocked = 0;
  console.log(install ? '安装 agent-acta hook：' : '移除 agent-acta hook：');
  for (const t of targets) {
    if (!fs.existsSync(t.home)) { console.log(`- ${t.agent}: 跳过（未检测到 ${t.home}）`); continue; }
    const existed = fs.existsSync(t.file);
    const r = readJsonFile(t.file);
    if (r.error) { console.log(`! ${t.agent}: ${t.file} 解析失败（${r.error}）——未改动任何内容`); blocked++; continue; }
    const plan = t.agent === 'claude' ? planClaude(r.data, install) : planAtomcode(r.data, install);
    if (plan.skip) { console.log(`! ${t.agent}: ${plan.skip}`); blocked++; continue; }
    if (JSON.stringify(r.data) === JSON.stringify(plan.next)) { console.log(`= ${t.agent}: ${t.file} 已是最新，无变化`); continue; }
    if (DRY_RUN) { console.log(`~ ${t.agent}: ${t.file} 需要更新（--dry，未写入）`); changed++; continue; }
    saveJsonFile(t.file, plan.next);
    console.log(`✓ ${t.agent}: ${install ? '已写入' : '已移除'} → ${t.file}${existed ? `（备份 ${path.basename(t.file)}.bak）` : ''}`);
    changed++;
  }
  if (DRY_RUN) console.log(`（--dry 预览：${changed} 处待更新，${blocked} 处受阻）`);
  else if (!changed) console.log(blocked ? '未做任何改动。' : '无需改动。');
  if (install && changed && !DRY_RUN) console.log('下次启动这些 agent 的会话时会自动拉起服务；atomcode 可用 `atomcode hooks list` 复核。');
  return blocked ? 1 : 0;
}

// --help 的内容就是本文件开头那段注释，从自身源码读回来，不另抄一份。
// 抄一份的下场可预见：文件头的用法和 --help 的输出会各改各的，最后谁也说不清哪份是真的——
// 跟 BUILD 取脚本内容指纹同一个理由：能不靠人维护的就不靠人维护。
function printUsage() {
  console.log('agent-acta ' + VERSION + ' (' + BUILD + ')');
  console.log('');
  try {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    const from = lines[0].startsWith('#!') ? 1 : 0;   // 跳过 shebang：那是给 shell 看的，不是给用户看的
    for (let i = from; i < lines.length; i++) {
      if (!lines[i].startsWith('//')) break;          // 头部注释到此为止（下一行就是 import）
      console.log(lines[i].replace(/^\/\/ ?/, ''));
    }
  } catch {
    console.log('（读不到自身源码，打不出用法；跑 agentacta --where 可看安装路径与版本指纹）');
  }
}

function printWhere() {
  console.log('server    : ' + SELF_PATH);
  console.log('版本/指纹 : ' + VERSION + ' / ' + BUILD + '（页面上点「环境诊断」也能看到服务自报的版本）');
  console.log('页面      : ' + PAGE_FILE);
  console.log('数据/配置 : ' + DATA_DIR);
  // --where 必须零副作用（不能顺手搬），所以老数据还没搬过来时，这里只把话说清楚：
  // 否则用户按这条路径去找配置、发现目录不存在，会以为配置丢了。
  const pendingLegacy = hasRealConfig(DATA_DIR) ? null : legacyWithConfig();
  if (pendingLegacy) {
    console.log('            （还没搬：老数据仍在 ' + pendingLegacy + '，下次启动服务时自动搬过来）');
  }
  for (const t of hookTargets()) console.log(`${t.agent.padEnd(9)}: ${t.file}${fs.existsSync(t.file) ? '' : '（尚未创建）'}`);
  console.log('');
  console.log('atomcode ~/.atomcode/hooks.json 里的 command（不能带引号）：');
  console.log('  node ' + SELF_PATH + ' --ensure');
  console.log('claude ~/.claude/settings.json 里的 command（走 shell，含空格必须加引号）：');
  console.log('  node "' + SELF_PATH + '" --ensure');
  console.log('');
  console.log('懒得抄就跑：node ' + SELF_PATH + ' --install-hooks');
}

// ---------------- --ensure 拉起模式 ----------------
// 插件 hook（atomcode / claude / …）与 npm bin 都走这里：不再需要 .vbs / .cmd / PowerShell。
// 全程无窗口：hook 进程的 stdio 由宿主接管，服务子进程 detached + windowsHide + stdio ignore。
// 就绪判定用「TCP 是否连得上」而不是 HTTP ping：首扫是同步阻塞事件循环的（trace 格式冷启动要重读 ~1GB），
// 阻塞期间 HTTP 请求一律得不到响应，用它当探针会让 ensure 白等到扫描结束（实测 9.5s，逼近 hook 15s 超时）。
// TCP 连接在 backlog 阶段就由内核完成握手，不受事件循环阻塞影响 —— 端口一旦监听立刻能探到。
function portOpen(ms = 400) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    const done = ok => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(ms);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function openBrowser() {
  const url = 'http://127.0.0.1:' + PORT;
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开浏览器不算失败 */ }
}
// 问一问端口上那个服务是哪一版。三种答案必须分得开：
//   {build}                —— 答了，且自报版本
//   {build:'', old:true}   —— 答了，但**没有 /api/version 这个接口**（拿的是 404 的 'not found'）：旧服务，无歧义
//   null                   —— 没答上来（连不上 / 超时）。**不能当成旧服务**：首扫是同步阻塞事件循环的，
//                             冷启动那 8~10s 里任何 HTTP 请求都得不到响应，此时把一个同版本的健康服务杀掉是纯破坏。
function probeVersion(ms = 2000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/version', timeout: ms }, r => {
      let s = '';
      r.on('data', d => s += d);
      r.on('end', () => {
        if (r.statusCode !== 200) return resolve({ build: '', old: true });   // 404 = 早于本接口的版本
        try {
          const j = JSON.parse(s);
          resolve({ build: j.build || '', version: j.version || '?', old: !j.build });
        } catch { resolve({ build: '', old: true }); }                        // 答了但不是 JSON：同样不是本版
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 停掉端口上那个「不是我这版」的服务。复用 --stop 的全部谨慎规则：先走优雅通道，
// 优雅通道不管用（比 1.3.0 还老的版本没有 /api/shutdown）才强杀，且只在**确认监听者就是本服务**时强杀。
async function evictStale() {
  await postShutdown();
  if (await waitPortClosed(4000)) return true;
  const own = readPidFile();
  const listeners = listenerPids();
  let victims = listeners.includes(own) ? [own] : [];
  if (!victims.length) {
    // pid 文件对不上（陈旧 / 被别人覆盖）—— 只有确认监听者就是本服务时才敢杀，
    // 否则 AGENT_LOG_PORT 指错时会把别人的进程杀掉（与 --stop 同一条红线）
    if (!listeners.length) { console.error('[agent-acta] 旧服务停不掉：找不到监听进程的 pid'); return false; }
    if (!(await pingOk())) { console.error('[agent-acta] 端口 ' + PORT + ' 上的监听者不响应 /api/ping，不敢强杀 —— 请手动确认后重试'); return false; }
    victims = listeners;
  }
  for (const pid of victims) { console.log('[agent-acta] 强制结束旧服务 pid ' + pid); killPid(pid); }
  if (await waitPortClosed(4000)) return true;
  console.error('[agent-acta] 旧服务停不掉：端口 ' + PORT + ' 仍被占用');
  return false;
}

function spawnServer() {
  // process.execPath = 真实 node.exe（不是 npm 的 .cmd shim），detached 后与宿主会话无关
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
async function runEnsure() {
  if (await portOpen()) {
    const p = await probeVersion();
    // 问不出来时再给一次机会：可能是同版本的服务正卡在首扫里（冷启动全量重读要 8~10s）。
    // 一共探 3 次（2s + 1s + 2s + 1s + 2s ≈ 8s 封顶），仍然问不出来就按「已在跑」处理 ——
    // 宁可漏重启一次，也不能杀掉一个正在干活的服务。hook 的超时是 15s，这条最坏路径留得出余量。
    let cur = p;
    for (let i = 0; i < 2 && !cur; i++) { await sleep(1000); if (!(await portOpen(600))) break; cur = await probeVersion(); }
    if (!cur) { console.log('[agent-acta] 端口 ' + PORT + ' 已被占用但暂时问不出信息（可能正在首扫），按已在运行处理'); if (OPEN_URL) openBrowser(); return; }
    // 同一版：幂等退出（绝大多数情况走这条）。**版本号也要比**：BUILD 只覆盖服务脚本，
    // 「只改了 package.json 的版本号」这种发布不换指纹，不比版本号的话服务会一直自报旧版本号 ——
    // 而「服务自报的版本」正是排障时要看的那一行，报错了比报不出来更误导。
    if (cur.build === BUILD && (!cur.version || cur.version === VERSION)) { if (OPEN_URL) openBrowser(); return; }
    // 不是我这版 —— 这正是「升级了包、旧进程还在跑」的那个状态，必须换班，否则页面新、接口旧
    console.log('[agent-acta] 端口上的服务是另一版（在跑 ' + (cur.version || '?') + '/' + (cur.build || '无版本接口') + '，本版 ' + VERSION + '/' + BUILD + '），自动重启…');
    // 停不干净也照样往下走：下面的 spawn 要么顺利接管（端口已空），要么自己 EADDRINUSE 幂等退出（还占着），不会打架。
    // 反面做法（这里 return）在「优雅关闭成功、只是端口释放得慢」时会让服务彻底没人拉 —— 比停不干净更糟。
    if (!(await evictStale())) console.error('[agent-acta] 自动重启未完全成功：如页面顶部仍提示版本不一致，请手动 agentacta --stop 后再 agentacta --open');
  }
  spawnServer();
  for (let i = 0; i < 24; i++) { await sleep(250); if (await portOpen()) break; } // 最多等 ~6s，端口一监听就返回
  if (OPEN_URL) openBrowser();
}

// ---------------- --client 桌面悬浮卡片 ----------------
// 壳的代码随包走（widget/，就一个 main.js + preload.js），但 Electron 那 ~100MB 二进制**不进包** ——
// 包要保持 0.68MB 零依赖。首次 --client 才把 electron 装进数据目录 widget-runtime/（npm 装，默认走
// npmmirror —— GitHub releases 国内实测卡死；ELECTRON_MIRROR 环境变量可覆盖）。装一次，之后只是 spawn。
// 单实例由壳自己保证（requestSingleInstanceLock）：重复 --client 只是聚焦，不会开第二个。
const CLIENT_DIR = path.join(ROOT, 'widget');
const CLIENT_RUNTIME = path.join(DATA_DIR, 'widget-runtime');
function clientElectronExe() {
  return path.join(CLIENT_RUNTIME, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
}
async function runClient() {
  await runEnsure();   // 悬浮窗是服务的客户端：服务不在先拉起来（幂等，已在跑就直接过）
  if (!fs.existsSync(path.join(CLIENT_DIR, 'main.js'))) {
    console.error('[agent-acta] 包里没有 widget/ 壳文件 —— 悬浮卡片需要 2.4.0 以上的包');
    return 1;
  }
  const exe = clientElectronExe();
  if (!fs.existsSync(exe)) {
    console.log('[agent-acta] 首次启动悬浮卡片：安装 Electron 运行时（约 100MB，一次性，装到 ' + CLIENT_RUNTIME + '）…');
    fs.mkdirSync(CLIENT_RUNTIME, { recursive: true });
    const env = { ...process.env };
    if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    const r = spawnSync('npm', ['install', '--prefix', CLIENT_RUNTIME, 'electron@44', '--no-audit', '--no-fund'],
      { stdio: 'inherit', env, shell: process.platform === 'win32' });
    // npm 装完不一定有二进制：electron 的二进制靠 postinstall（install.js）下载，
    // 而 npm config ignore-scripts=true 时 postinstall 直接被跳过（本机就是这个配置，2026-09-20 踩过）。
    // 所以 install.js 单独补跑一遍 —— 已装好则幂等（有 dist 就直接返回）。
    if (!fs.existsSync(clientElectronExe()) && r.status === 0) {
      console.log('[agent-acta] npm 跳过了 postinstall，单独补跑 electron 二进制下载…');
      spawnSync(process.execPath, [path.join(CLIENT_RUNTIME, 'node_modules', 'electron', 'install.js')],
        { stdio: 'inherit', env, cwd: path.join(CLIENT_RUNTIME, 'node_modules', 'electron') });
    }
    if (!fs.existsSync(clientElectronExe())) {
      console.error('[agent-acta] Electron 运行时安装失败。网络问题可设 ELECTRON_MIRROR 后重试；错误在上方 npm 输出里');
      return 1;
    }
  }
  spawn(exe, [CLIENT_DIR], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, AGENT_LOG_PORT: String(PORT), AGENT_ACTA_DATA_DIR: DATA_DIR },
  }).unref();
  console.log('[agent-acta] 悬浮卡片已启动（重复执行只是聚焦已有窗口）');
  return 0;
}

// ---------------- 数据目录搬迁（旧位置 → ~/.agent-acta，一次性） ----------------
// 每换一次名/换一次窝，就往 LEGACY_DATA_DIRS 里加一条；下面按「越新越靠前」取第一个有真配置的搬。
// 判据盯的是「新目录里有没有**真配置**」，不是「新目录在不在」。空的新目录到处都是：用户手工建的、
// 上次搬到一半留下的、下面那句 mkdirSync 顺手建出来的 —— 它们都会被当成「已经搬好了」，而
// loadConfig() 读不到配置就装载默认预置，首扫一 saveConfig()，用户的 agent 列表 / traeKey /
// ctxWindows 就被默认值顶掉。这是整件事里**唯一不可逆**的损失，所以判据必须落在配置文件本身
// （saveConfig 里另有一道保险丝，防的是这段逻辑将来被改坏）。
//
// 顺序也由这个代价定：**先配置、后其余**。索引搬不动只是下次重扫（索引里存的是「源日志 mtime+size
// → 已解析数据」，源日志没动，条目一条不少）；配置搬不动就是上面那条不可逆链。
//
// 端口门：端口被占 = 已经有实例在跑（多半是旧版，它正在写旧目录）。此时把目录搬走，它下一次
// scheduleSave()/saveConfig() 会把旧目录连同 index/ 整个重建出来，留下两个都在写的目录。所以
// 这一轮干脆不搬 —— 服务本来也起不来，等下一轮真握有端口时再搬。
function parseConfigFile(f) {   // 搬迁验收：能解析、且长得像配置（有 agents 键）
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' && j.agents ? j : null; } catch { return null; }
}
// 尽力搬：目标已有的文件一律不覆盖（合并语义），单个文件失败只记日志、不抛。
// 没有扩展名白名单 —— *.before-* 是配置升级翻车时唯一的对照物，2MB 的 agent-log-index.json.bak
// 是 v2 索引的孤本，.tmp 残留可能是人工恢复的线索，全部照搬，一律不清理。
function moveInto(srcDir, dstDir) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (e.name === LEGACY_CONFIG_NAME || e.name === 'config.json') continue;  // 配置单独在第 ① 步处理
    const s = path.join(srcDir, e.name), d = path.join(dstDir, e.name);
    try {
      if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); moveInto(s, d); }
      else if (!fs.existsSync(d)) { try { fs.renameSync(s, d); } catch { fs.copyFileSync(s, d); } }
    } catch (err) { console.error('[data] 搬迁 ' + s + ' 失败（不影响其它文件）：' + err.message); }
  }
}
async function migrateDataDir() {
  try {
    if (hasRealConfig(DATA_DIR)) return false;            // 新家已有真配置：幂等，旧目录一动不动
    const legacyDir = legacyWithConfig();                 // 旧位置可能有两条（改过两次名），取有新配置的那条
    if (!legacyDir) return false;                         // 全新安装（或旧目录已空）：没有旧数据可搬
    if (await portOpen(400)) {
      console.log('[data] 端口 ' + PORT + ' 上已有实例在跑，本轮不搬数据目录（等它退出，下次启动再搬）');
      return false;
    }
    const legacyCfgSrc = isFile(path.join(legacyDir, 'config.json'))
      ? path.join(legacyDir, 'config.json') : path.join(legacyDir, LEGACY_CONFIG_NAME);
    fs.mkdirSync(DATA_DIR, { recursive: true });          // 合并语义：新目录可能已存在（空目录/半截搬迁）
    // ① 配置先落地：同卷 rename 秒成；旧目录被 junction 指到别的盘时会 EXDEV，退回拷贝
    try { fs.renameSync(legacyCfgSrc, CONFIG_FILE); }
    catch { try { fs.copyFileSync(legacyCfgSrc, CONFIG_FILE); } catch (err) { console.error('[data] 配置拷贝失败：' + err.message); } }
    if (!parseConfigFile(CONFIG_FILE)) {
      // 半截文件比没有更坏（下次会被当成「已有配置」而跳过搬迁）—— 删掉它，留给下次重搬
      try { fs.unlinkSync(CONFIG_FILE); } catch {}
      console.error('[data] 配置没能搬到 ' + CONFIG_FILE + '（老配置仍在 ' + legacyCfgSrc + '）：本次不写入任何默认配置，' +
        '服务可以用，但请手工把那份配置拷到新路径后再启动（否则下次会重试搬迁）。');
      return false;
    }
    // ② 其余尽力搬：index/、pid、*.before-*、agent-log-index.json.bak 都在这一步，搬不动就留在原地
    moveInto(legacyDir, DATA_DIR);
    // ③ 旧位置留一张说明。用**同级文件**而不是在旧路径下重建目录写 MOVED.txt：
    //    重建出来的旧数据目录是个降级陷阱（旧版本跑起来 mkdirSync 成功、配置读不到 → 默认预置静默 0 条）。
    //    文件名 = 那条 legacy 目录自己的名字 + -MOVED.txt（如 ~/.atomcode/agent-log-MOVED.txt、
    //    ~/.agent-log-MOVED.txt），两条 legacy 各留各的，互不覆盖。
    try {
      const legacyParent = path.dirname(legacyDir);
      if (isDir(legacyParent)) {
        fs.writeFileSync(path.join(legacyParent, path.basename(legacyDir) + '-MOVED.txt'),
          'AgentActa 的用户数据目录已搬到：' + DATA_DIR + '\r\n' +
          '本文件是搬迁留下的说明：' + legacyDir + ' 下剩下的空目录与残留文件都可以删。\r\n' +
          '若这里跑的是 2.0.0 之前的旧版服务，请先升级 —— 否则它会当成配置丢了，用默认配置静默跑出 0 条。\r\n');
      }
    } catch {}
    console.log('[data] 数据目录已搬迁：' + legacyDir + ' -> ' + DATA_DIR);
    return true;
  } catch (e) {
    console.error('[data] 搬迁失败（服务照常启动，但本次不会写入任何默认配置）：' + e.message);
    return false;
  }
}

// ---------------- --stop 停止服务 ----------------
// 服务原本「拉起来就永不退出」：没有任何停止入口，只能 netstat 找端口占用者再 taskkill（还容易杀错）。
// 判活一律以「端口是否还监听」为准，不信 pid 文件 —— 被 taskkill /F 过的进程会留下陈旧 pid 文件。
function readPidFile() {
  // 兜底读旧位置：升级后的第一步往往就是 --stop（换班），那时数据目录还在老地方，
  // 那份 pid 文件仍是找到旧实例的线索。判活红线不变：强杀只认端口上的监听者，pid 只是线索。
  for (const f of [PID_FILE, ...LEGACY_DATA_DIRS.map(d => path.join(d, 'server-' + PORT + '.pid'))]) {
    try { const n = Number(fs.readFileSync(f, 'utf8').trim()); if (Number.isInteger(n) && n > 0) return n; } catch {}
  }
  return 0;
}
function removePidFiles() {   // 同上：新位置没有就清掉旧位置的陈旧文件（数据目录迟早搬过来，别留个假的）
  for (const f of [PID_FILE, ...LEGACY_DATA_DIRS.map(d => path.join(d, 'server-' + PORT + '.pid'))]) {
    try { fs.unlinkSync(f); } catch {}
  }
}
function listenerPids() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return [...new Set(out.split('\n')
        .filter(l => l.includes(':' + PORT) && /LISTENING/i.test(l))
        .map(l => l.trim().split(/\s+/).pop())
        .filter(p => /^\d+$/.test(p) && p !== '0'))];
    }
    const out = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s)))];
  } catch { return []; }
}
function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
    return true;
  } catch { return false; }
}
async function waitPortClosed(ms) {
  for (let i = 0; i < Math.ceil(ms / 200); i++) { if (!(await portOpen(300))) return true; await sleep(200); }
  return !(await portOpen(300));
}
function postShutdown() {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/shutdown', method: 'POST', timeout: 2500 }, r => {
      r.resume();
      r.on('end', () => resolve(r.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
// 强杀前的最后一道确认：端口上的监听者到底是不是本服务
function pingOk() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1500 }, r => {
      let s = '';
      r.on('data', d => s += d);
      r.on('end', () => resolve(r.statusCode === 200 && s.trim() === 'ok'));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function runStop() {
  if (!(await portOpen(300))) {
    removePidFiles();  // 顺手清掉陈旧 pid 文件
    console.log('[agent-acta] 服务没在运行（端口 ' + PORT + ' 空闲）');
    return 0;
  }
  await postShutdown();
  if (await waitPortClosed(5000)) { console.log('[agent-acta] 已停止（端口 ' + PORT + ' 已释放）'); return 0; }
  // 优雅关闭没生效：可能是老版本实例（没有 /api/shutdown），也可能事件循环正被首扫堵着
  const own = readPidFile();
  const listeners = listenerPids();
  let victims = listeners.includes(own) ? [own] : [];
  if (!victims.length) {
    // pid 文件对不上（陈旧 / 被别人覆盖）—— 只有在确认监听者就是本服务时才敢强杀，
    // 否则 AGENT_LOG_PORT 指错时会把别人的进程杀掉
    if (!listeners.length) { console.error('[agent-acta] 端口 ' + PORT + ' 被占用，但找不到监听进程的 pid，请手动处理'); return 1; }
    if (!(await pingOk())) {
      console.error('[agent-acta] 端口 ' + PORT + ' 被占用，但监听者不响应 /api/ping、也不匹配 pid 文件，疑似别的程序 —— 未强杀，请手动确认');
      return 1;
    }
    victims = listeners;
  }
  for (const pid of victims) { console.log('[agent-acta] 强制结束 pid ' + pid); killPid(pid); }
  if (await waitPortClosed(5000)) {
    removePidFiles();
    console.log('[agent-acta] 已停止（端口 ' + PORT + ' 已释放）');
    return 0;
  }
  console.error('[agent-acta] 停止失败：端口 ' + PORT + ' 仍被占用');
  return 1;
}

// ---------------- --status 状态查询 ----------------
// 零副作用（同 --version/--where 的红线）：只探端口、只问版本，不起服务、不搬数据。
// 悬浮卡片按进程查：壳的 exe 固定落在 <dataDir>/widget-runtime/ 下，路径里认得出。
function clientRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`wmic process where "name='electron.exe'" get ExecutablePath`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.includes('widget-runtime');
    }
    const out = execSync('ps -eo args', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.includes(path.join(CLIENT_RUNTIME, ''));
  } catch { return null; }   // 查不动（wmic 被裁/权限）就说不清，不硬判
}
// ANSI 球色与卡片顶栏那颗灯同口径：绿=健康、红=没在跑、橙=在跑但有别的问题（版本不一致/问不出）。
// ● 是几何字符，终端不吃 ANSI 时也至少能看清颜色缺省的球。
const LAMP = { green: '\x1b[32m●\x1b[0m', orange: '\x1b[33m●\x1b[0m', red: '\x1b[31m●\x1b[0m' };
async function runStatus() {
  const client = () => { const r = clientRunning(); return r === null ? '未知（查不了进程）' : r ? '开着' : '没起（agentacta --client）'; };
  console.log('[agent-acta] 本地包 : ' + VERSION + ' (' + BUILD + ') @ ' + SELF_PATH);
  if (!(await portOpen(600))) {
    console.log('[agent-acta] ' + LAMP.red + ' 服务  ：没在跑（端口 ' + PORT + ' 空闲）—— 拉起用 agentacta --ensure');
    console.log('[agent-acta] 悬浮卡片：' + client());
    return 2;
  }
  const p = await probeVersion();
  if (!p) {
    console.log('[agent-acta] ' + LAMP.orange + ' 服务  ：端口 ' + PORT + ' 被占用但问不出信息（可能正卡在首扫）监听 pid: ' + (listenerPids().join(',') || '未知'));
    return 1;
  }
  if (p.old) {
    console.log('[agent-acta] ' + LAMP.orange + ' 服务  ：端口上是个没有 /api/version 的旧版（pid ' + readPidFile() + '）—— agentacta --ensure 换班');
    return 1;
  }
  const same = p.build === BUILD && p.version === VERSION;
  console.log('[agent-acta] ' + (same ? LAMP.green : LAMP.orange) + ' 服务  ：在跑 ' + p.version + ' (' + p.build + ') pid ' + readPidFile() + '，入口 http://127.0.0.1:' + PORT + '/');
  if (!same) console.log('[agent-acta]          ⚠ 与本地包不同版（本地 ' + VERSION + '/' + BUILD + '）—— 发布后 agentacta --ensure 换班');
  console.log('[agent-acta] 悬浮卡片：' + client());
  return same ? 0 : 1;
}

// ---------------- --doctor 自检 ----------------
// 诊断页（/api/diagnose）回答的是「**能不能发现路径**」，这条命令回答的是「**已经攒下的这些东西还可不可用**」：
// 索引片有没有坏、它的口径跟当前代码对不对得上、配置指向的目录还在不在、端口上伺候你的是不是这一版。
// 排障入口从「问人」变成「跑一条命令，把整段贴出来」。
//
// 两条硬约束：
//   1) **只读**。不搬家（migrateDataDir 会移目录）、不调 loadConfig()（它会做 v1→v2 迁移、旧配置改名、
//      rulesHash 落盘、预置项迁移）。跑一条体检命令却顺手把配置改了，会让「跑完就好了」这件事再也说不清
//      原因 —— 所以配置与索引都由本函数自己按只读方式读一遍，宁可多写几行。同理不调 loadIndex()：它会把
//      旧单文件索引改名成 .bak。
//   2) **不上色**。这段输出是给人**粘贴**的病历，ANSI 转义一贴就是乱码（--status 那几颗彩球是给人当场看的，
//      场景不同）。级别用 [ok]/[info]/[warn]/[fail] 前缀表达，别加颜色也别加框线。
const DOCTOR_TAG = { ok: '[ok]  ', info: '[info]', warn: '[warn]', fail: '[fail]' };
// 级别选择的口径：fail = 现在就是坏的（有东西已经在静默地少、或者根本起不来）；warn = 会自己好、或需要人判断；
// info = 正常但值得知道（没跑过服务、还没归档）；ok = 明确正常。只有 fail 影响退出码，warn 不拦脚本。
async function runDoctor() {
  let warn = 0, fail = 0;
  const doc = (level, label, text) => {
    if (level === 'warn') warn++; else if (level === 'fail') fail++;
    console.log(DOCTOR_TAG[level] + ' ' + label + '：' + text);
  };
  console.log('[agent-acta] 本地包 ' + VERSION + ' (' + BUILD + ') @ ' + SELF_PATH);
  console.log('[agent-acta] 平台 ' + process.platform + ' / ' + process.version + ' / 数据目录 ' + DATA_DIR);
  console.log('');

  // ---- ① 数据目录与配置 ----
  if (!isDir(DATA_DIR)) {
    const legacy = legacyWithConfig();
    if (legacy) doc('warn', '数据目录', '还没有 ' + DATA_DIR + '，但老位置仍有一份配置（' + legacy + '）—— 下次启动服务会自动搬过来（本命令不搬，免得体检本身动了数据）');
    else doc('info', '数据目录', '还没有 ' + DATA_DIR + '（这台机器上还没跑过服务）—— agentacta --ensure 启动时会自动建，配置也会在那时生成');
  }
  let cfg = null;
  let cfgRaw = '';
  try { cfgRaw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch {}
  if (!cfgRaw) {
    if (isFile(path.join(DATA_DIR, LEGACY_CONFIG_NAME)))
      doc('warn', '配置', '只有老文件名 ' + LEGACY_CONFIG_NAME + '，没有 config.json —— 下次启动服务时会自动改名');
    else if (isDir(DATA_DIR))
      doc('warn', '配置', 'config.json 不存在 —— 服务会拿内置预置项从零开始（手工加的 agent 与 traeKey 都没有）');
  } else {
    try {
      cfg = JSON.parse(cfgRaw);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('顶层不是对象');
    } catch (e) {
      cfg = null;
      // 这条是 fail 而不是 warn：loadConfig 读不动它会**静默回落成默认预置**，用户手工加的 agent / traeKey
      // 全都不见，而服务照样起得来 —— 属于「一启动就已经错了」的那种损坏。
      doc('fail', '配置', CONFIG_FILE + ' 解析失败：' + e.message +
        ' —— 服务读不动它会回落成默认预置（手工加的 agent 与 traeKey 全丢）。先备份这个文件再修 JSON，别让服务带着坏配置先起来');
    }
  }
  if (cfg) {
    const agents = (cfg.agents && typeof cfg.agents === 'object') ? cfg.agents : {};
    const names = Object.keys(agents);
    doc('ok', '配置', CONFIG_FILE + ' 可解析（v' + (cfg.v == null ? '?' : cfg.v) + '，' + names.length + ' 个 agent）');
    if (cfg.v === 1) doc('warn', '配置', '还是 v1 老格式 —— 下次启动服务时会就地迁成 v2（本命令不动它）');
    else if (cfg.v !== 2 && cfg.v !== 3) doc('warn', '配置', '认不出的版本号 v' + cfg.v + ' —— 服务会当成「没有配置」，用预置项跑（手工项会消失）');
    for (const [name, c] of Object.entries(agents)) {
      const probs = [];
      // kind 认不出时 scanBranch 兜底成 atomcode（老配置常见）。这条是**静默**的：目录在、也扫得出东西，
      // 只是字段少一截，所以必须说出来 —— 静默正是这个功能要消灭的东西。
      const br = scanBranch({ kind: c.kind });
      if (br.kind === 'atomcode' && c.kind !== 'atomcode')
        probs.push(['warn', (c.kind == null ? '缺 kind 字段' : 'kind=' + c.kind + ' 没有对应解析器') + ' —— 会按原子码式目录扫，检查是不是写错了']);
      if (c.kind === 'generic-jsonl') {
        const errs = validateGenericRules(c.rules);
        if (errs.length) probs.push(['fail', 'generic-jsonl 的 rules 校验不过（服务会把它回落成禁用）：' +
          errs.map(e => e.rule + '：' + e.msg).join('；')]);
      }
      if (c.kind === 'dsh' && !DSH_ZSTD_OK)
        probs.push(['fail', 'dsh 的会话是 zstd 压缩的，当前 ' + process.version + ' 的 zlib 里没有 zstdDecompressSync（需 Node 22.15+）—— 升级 Node 即可，不是路径或格式问题']);
      const root = c.sessions || c.traces || '';
      // codebuddy 名下有两份落盘（CLI + genie 扩展）。扩展那半没挂上时，病历上必须说得出**为什么**
      // （没装扩展 / 没有 Data/ / <host> 名不认得 / 没有 history/ 四种成因），否则只能远程敲命令问盘。
      // 问的是当前盘上的实情，不是配置里那份 sessionsExtra（它可能停在上一轮扫描的结论上）。
      const bxWhy = (name === 'codebuddy' && !(c.sessionsExtra || []).length) ? buddyExtMissingWhy() : '';
      if (c.enabled === false) doc('info', 'agent ' + name, '已禁用，不参与扫描');
      else if (!confAvailable(c)) doc('warn', 'agent ' + name, '根不存在：' + (root || '(空)') +
        // 「换平台/换机器」是这句话最常见的来路：整个 ~/.agent-acta 搬过来，配置里的路径还是老平台的写法。
        // 不点破的话，看到的只是「某个 agent 一直 0 条」，很容易当成「这台机器没装它」而不查。
        (foreignPath(root) ? ' —— 这是 ' + (root.startsWith('/') ? 'mac / Linux' : 'Windows') + ' 的路径形态，而当前平台是 '
          + process.platform + '：像是一份从别的平台搬过来的配置。删掉它让自动发现重新认（或改成这台机器上的真实路径）'
          : '') +
        (c.source === 'auto' ? ' —— 下次启动服务时会自己摘掉' : ' —— 手工项会一直留着（确认是卸载了就删掉它）') +
        (bxWhy ? '；另：genie 扩展根也未探到 —— ' + bxWhy : ''));
      else doc('ok', 'agent ' + name, c.kind + ' · ' + root +
        (Array.isArray(c.sessionsExtra) && c.sessionsExtra.length ? '（另有 ' + c.sessionsExtra.length + ' 个额外根）'
          : (bxWhy ? '（genie 扩展根未探到：' + bxWhy + '）' : '')));
      for (const [lv, t] of probs) doc(lv, 'agent ' + name, t);
    }
  }

  // ---- ② 索引（只读通读：不调 loadIndex，它会顺手把旧单文件索引改名） ----
  if (!isDir(INDEX_DIR)) {
    doc('info', '索引', '还没有 ' + INDEX_DIR + '（服务从没扫过盘）—— 首次启动会全量扫一遍');
  } else {
    let names = [];
    try { names = fs.readdirSync(INDEX_DIR); } catch (e) { doc('warn', '索引', '目录读不动：' + e.message); }
    const shards = names.filter(n => n.endsWith('.json'));
    const tmps = names.filter(n => n.endsWith('.tmp'));
    if (!shards.length && !tmps.length) doc('info', '索引', '目录是空的（还没落过盘）');
    for (const fn of shards) {
      const kind = fn.slice(0, -5);
      const fp = path.join(INDEX_DIR, fn);
      let j = null;
      try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
        // 这片坏了不等于要立刻修：启动时会忽略它、这些文件全量重扫（源日志还在就只是慢一轮）。
        // 说清楚后果，免得看到 fail 就以为数据丢了。
        doc('fail', '索引 ' + kind, fn + ' 解析失败：' + e.message + ' —— 启动时这片会被忽略；这些文件会全量重扫（源日志还在，数据不会丢，只是慢一轮）');
        continue;
      }
      const arr = Array.isArray(j?.files) ? j.files : [];
      let moved = 0, gone = 0;
      for (const [p, f] of arr) {
        let st; try { st = fs.statSync(p); } catch { gone++; continue; }
        if (!f || st.mtimeMs !== f.m || st.size !== f.s) moved++;
      }
      let bytes = 0; try { bytes = fs.statSync(fp).size; } catch {}
      const need = PARSER_REV[kind];
      if (need == null) doc('warn', '索引 ' + kind, fn + '：这个 kind 在当前版本不再落盘索引（解析器改名/删过了？）—— 文件可删，这 ' + arr.length + ' 条记录不会再用到');
      else if (j.rev !== need) doc('warn', '索引 ' + kind, '口径已变：索引记的是 rev=' + j.rev + '，当前是 ' + need +
        ' —— 启动时这 ' + arr.length + ' 条会被整片丢弃重扫（这是有意的：老口径的字段会静默少一截，留着比丢了更糟）');
      else doc('ok', '索引 ' + kind, arr.length + ' 个文件状态 · ' + fmtBytes(bytes) +
        (moved || gone ? '（' + moved + ' 个源文件已变化、' + gone + ' 个已不在 —— 下一轮扫描会重新核对）' : ''));
    }
    if (tmps.length) doc('warn', '索引', tmps.length + ' 个 .tmp 残留（上次落盘被打断）：' + tmps.join(', ') + ' —— 可删');
  }
  if (isFile(path.join(DATA_DIR, 'agent-log-index.json')))
    doc('warn', '索引', '旧单文件索引 agent-log-index.json 还在 —— 下次启动服务时会迁成 .bak（内容不丢，本命令不动它）');

  // ---- ③ 服务 / 端口 / pid 文件 ----
  // 判活以端口为准、pid 文件只当线索（跟 --stop 同一条红线）：pid 文件是被强杀过的进程留下的常见残留，
  // 而「端口上跑的是另一版」才是真正会让人查半天的那个状态。
  const pid = readPidFile();
  if (!(await portOpen(600))) {
    if (pid) doc('warn', '服务', '端口 ' + PORT + ' 空闲，但 pid 文件还在（记着 pid ' + pid + '）—— 多半是被强杀过；agentacta --ensure 会重新拉起并覆盖它');
    else doc('info', '服务', '没在跑（端口 ' + PORT + ' 空闲）—— agentacta --ensure 拉起来');
  } else {
    const p = await probeVersion();
    if (!p) doc('warn', '服务', '端口 ' + PORT + ' 被占用但问不出 /api/version（可能正卡在首扫，也可能是别的程序占了端口）—— 监听 pid: ' + (listenerPids().join(',') || '未知'));
    else if (p.old) doc('fail', '服务', '端口上是个没有 /api/version 的旧版（pid ' + pid + '）—— 页面与接口互相不认识，agentacta --ensure 换班');
    else if (p.build !== BUILD || p.version !== VERSION) doc('fail', '服务', '端口上跑的是另一版：' + p.version + ' (' + p.build +
      ') ，本包 ' + VERSION + ' (' + BUILD + ') —— 典型症状是「页面是新的、接口是旧的」；agentacta --ensure 换班');
    else doc('ok', '服务', '在跑 ' + p.version + ' (' + p.build + ')，与本包一致 · pid ' + pid);
  }

  // ---- ④ 页面文件（与启动自检同一把尺子，但那边的输出只进了服务日志，用户看不到） ----
  try {
    const src = fs.readFileSync(PAGE_FILE, 'utf8');
    const refs = [...src.matchAll(/(?:src|href)="\/page\/([^"]+)"/g)].map(m => m[1]);
    const missing = refs.filter(n => !fs.existsSync(path.join(PAGE_DIR, n)));
    const noShared = !src.includes('__AGENT_LOG_SHARED__'), noBuild = !src.includes('__AGENT_LOG_PAGE_BUILD__');
    if (noShared || noBuild) doc('fail', '页面', PAGE_FILE + ' 缺少占位符（' +
      [noShared && '__AGENT_LOG_SHARED__', noBuild && '__AGENT_LOG_PAGE_BUILD__'].filter(Boolean).join(' / ') +
      '）—— 页面被换成不走注入机制的旧版了，浏览器里会白屏');
    else if (missing.length) doc('fail', '页面', '/page/ 资源缺失：' + missing.join(', ') + ' —— 页面会白屏或样式全丢，重装这个包');
    else doc('ok', '页面', '主页面 + ' + refs.length + ' 个 /page/ 资源齐、占位符在（指纹 ' + pageBuild() + '）');
  } catch (e) {
    doc('fail', '页面', '读不到 ' + PAGE_FILE + '：' + e.message);
  }

  // ---- ⑤ 归档（只读：读 manifest + 数目录，不写） ----
  const ix = archiveIndex();
  const archSkip = Array.isArray(cfg?.archive?.skip) ? cfg.archive.skip : [];
  const archOn = cfg?.archive?.enabled !== false;
  if (!ix.totals.days) doc('info', '归档', '还没有归档（' + ix.root + '）—— ' + (archOn
    ? 'agentacta --archive，或等服务内每日自动轮'
    : '而且 config.archive.enabled=false，自动归档是关着的'));
  else doc(archOn ? 'ok' : 'info', '归档', ix.totals.agents + ' 个 agent / ' + ix.totals.days + ' 个日期文件 / ' +
    ix.totals.count + ' 条 · ' + fmtBytes(ix.totals.bytes) +
    (archSkip.length ? ' · 已关掉 ' + archSkip.join(', ') + '（只停未来，已冻文件保留）' : '') +
    (archOn ? '' : ' · 自动归档已关（enabled=false）'));

  const parts = [];
  if (fail) parts.push(fail + ' 项失败');
  if (warn) parts.push(warn + ' 项提醒');
  console.log('');
  console.log('[agent-acta] 体检结论：' + (parts.length ? parts.join('、') : '一切正常') +
    (parts.length ? '（带 [fail]/[warn] 的行就是要处理的地方；把上面这一段整体贴出来即可）' : ''));
  return fail ? 1 : 0;
}

// ---------------- CLI 派发 + 服务本体（R31：被 import 时整段不跑） ----------------
// 抽成函数的唯一理由是「只读库模式」：常驻那条路（直接跑 / npm bin）argv[1] 就是本文件，照旧一路跑到底，
// 行为与搬家前逐字一致；被 mcp-server.mjs import 时 LIB 为真，这个函数根本不调用 —— 于是数据搬家、
// 落盘、抢端口、写 pid、空闲自停定时器全都不会发生（写路径的门在 saveConfig / saveIndex / setSaveHook）。
async function runCli() {
  if (HELP) {          // 放在所有分支最前：--help 就该是「什么都不干，只回答」
    printUsage();
    process.exit(0);
  }
  if (SHOW_VERSION) {  // 同上：纯查询，不能有任何副作用（以前它会真的起一个前台服务）
    console.log('agent-acta ' + VERSION + ' (' + BUILD + ')');
    process.exit(0);
  }
  if (SHOW_WHERE) {
    printWhere();
    process.exit(0);
  }
  if (STATUS) {
    process.exit(await runStatus());
  }
  if (DOCTOR) {         // 纯查询，但会连端口问一句「你是谁」；与 --status 一样零副作用
    process.exit(await runDoctor());
  }
  if (STOP) {
    process.exit(await runStop());
  }
  if (INSTALL_HOOKS || UNINSTALL_HOOKS) {
    process.exit(runHooks(INSTALL_HOOKS));
  }
  if (CLIENT) {
    process.exit(await runClient());
  }
  if (ARCHIVE) {
    process.exit(await runArchiveCli());
  }
  if (SEARCH_REINDEX) {   // 纯本地活（读源文件 + 写索引分片），不连端口、不抢 14570
    process.exit(await runSearchReindexCli());
  }
  if (ENSURE) {
    await runEnsure();
    process.exit(0);
  }

  // 老数据搬家。放在这里（默认前台分支）而不是放到最上面的分支派发前，有两个理由：
  //   1) --help / --version 必须零副作用，--stop 可能正被用来停一个旧实例、更不能搬；
  //   2) 端口被别的实例占着时绝不搬（旧实例下一次落盘会把旧目录重建出来，见 migrateDataDir 的说明）。
  //
  // **为什么它不在 start() 里**（Step 2 的取舍）：它要探端口、且是「老 CLI 的数据往哪儿搬」的入口语义；
  // 宿主里的插件不该替用户搬（配置搬错是整件事里唯一不可逆的损失）。所以留在入口，start() 之前 await。
  await migrateDataDir();
  server.on('error', async e => {
    // 幂等：已在运行则静默退出（hook / 自启每次会话都会拉起）
    if (e.code === 'EADDRINUSE') {
      // 但「已在跑的那个是别的版本」绝不能静默：直接跑 node agent-acta-server.mjs 的人会看到「服务在跑」
      // 却始终用不上新代码，然后去查页面上的怪现象。这里只报不改 —— 想换班请用 --ensure/--open（它会自动重启）。
      const p = await probeVersion(1500);
      if (p && (p.build !== BUILD || (p.version && p.version !== VERSION))) {
        console.error('[agent-acta] 端口 ' + PORT + ' 上的服务是另一版（在跑 ' + (p.version || '?') + '/' + (p.build || '无版本接口') + '，本版 ' + VERSION + '/' + BUILD + '），本次未启动。');
        console.error('[agent-acta] 换班请跑：agentacta --stop 然后 agentacta --open（或直接 agentacta --open，它会自动重启旧服务）');
      } else console.log('[agent-acta] already running, exit');
      process.exit(0);
    }
    console.error('[agent-acta]', e.message); process.exit(1);
  });
  // 服务本体从这儿交给 core 的 start()（Step 2）。入口只剩三件**只有 CLI 才有的**东西：
  //   ① 搬家（上面那句，探端口 + 入口语义）；② EADDRINUSE 的 CLI 话术（上面那个 handler）；
  //   ③ 退出权：传「真 process.exit」，因为这条路的语义就是「终端里跑着的那一个服务」。
  // 页面自检 / 写 pid / 空闲自停都随 start({ listen:true }) 走，位置与搬家前逐字一致。
  await start({
    mode: 'cli',
    listen: true,
    keepAlive: true,                       // 前台常驻：SSE 要心跳（原来由 !ENSURE 反推，见 §5）
    exitPolicy: code => process.exit(code), // /api/shutdown / 空闲自停 / --stop 走的都是这条
  });
}

if (MODE === 'cli') await runCli();

// ---------------- 只读库模式的对外面（R31，给 mcp-server.mjs） ----------------
// 刻意只给「读」：open() 之外全是纯查询，配置增删 / 改设置 / trae 密钥抓取 / 归档写入一个入口都没暴露 ——
// 少一个入口，就少一处「MCP 进程改坏常驻数据」的可能。
// open() 的次序与 runCli 的默认分支一致（读配置 → 模型名映射 → 恢复索引 → 扫一轮），
// 差别是它不搬家、不落盘、不起服务、不挂任何定时器；扫描本身要读源文件，这是它唯一的成本。
export const LIBRO = {
  version: VERSION, build: BUILD, dataDir: DATA_DIR, port: PORT, parserRev: PARSER_REV,
  async open() {
    loadConfig();
    loadModelDisplayMap(QODER_RUNS_DIR);
    loadIndex();
    const t0 = Date.now();
    scanAllSync();
    return { ok: true, scanMs: Date.now() - t0, entries: entries.size, agents: agentConfs.size, dataDir: DATA_DIR, version: VERSION };
  },
  // 长驻的 MCP 进程要靠它取新日志（客户端不会自己重开进程）：只扫一轮，不落盘（saveHook 已是空函数）。
  refresh() { const t0 = Date.now(); scanAllSync(); return { ok: true, scanMs: Date.now() - t0, entries: entries.size }; },
  agentsList, counts, filterEntries, dailyAgg, modelAgg, workAgg, analyzeAgg, sessionsAgg, sessionAgg, entryContent,
  // R33：全文搜索的**只读**面（loadSearch 读盘、searchEntries 只查内存、searchStatus 只报数）。
  // 刻意不给 searchRun —— MCP 进程是第二个读者，建索引是常驻服务的活（见 search.mjs 里 readOnly 那道闸）。
  loadSearch, searchEntries, searchStatus,
  entry: id => entries.get(id) || null,
  srcOf: id => srcs.get(id) || null,
  agentConf: name => agentConfs.get(name) || null,
};
