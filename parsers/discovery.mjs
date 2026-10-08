// ---------------- 目录嗅探与摆法（discovery：sniffBase 及其全部判据） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。这是「日志在哪、认成什么格式」的唯一来源：
//   * candidateBases / probeBases —— 各平台候选根目录（自动发现与诊断共用）
//   * hasXxx 系列判据 —— 每种 kind 的目录/文件特征（读盘量刻意压到最小：这是每 3s 一轮的路径）
//   * sniffBase —— 判据编排（分支顺序就是优先级，见各分支注释，顺序动不得）
// 解析器（scanXxx）不在这里；kimi 的扫描（scanKimi）import 本文件的 kimiWires。
import fs from 'node:fs';
import path from 'node:path';
import { HOME, isDir, isFile, listDirCached, sqliteMod } from './shared.mjs';
import { hasMavisSession } from './minimax.mjs';
import { OPENCLAW_STATE_DIRNAMES, openclawTranscripts } from './openclaw.mjs';
import { clineTranscripts } from './cline.mjs';
import { buddyExtRoot, buddyExtWhyMissing } from './buddyext.mjs';
// hasCursorTranscripts 里枚举转录走的是 cursor 解析器那一个函数（两种落法共用一套判定，见该函数注释）。
// ⚠️ 这条 import 曾经漏掉过：函数体在外层 try{}catch{} 里，ReferenceError 被静默吞掉 →
// hasCursorTranscripts **恒 false** → 自动发现整条 cursor 分支永不命中（症状 = 侧栏 cursor 恒 0 条，
// 且因为本机那条是历史手动项而完全看不出来）。cursor-hook-test.mjs 的隔离 profile 现在守着它。
import { cursorTranscriptFiles } from './cursor.mjs';

// 各平台候选根目录：win / mac / linux / harmonyos(ohos 走 POSIX 分支)
// 名字别名：codeart 的真实目录是 codearts-agent（华为 CodeArts IDE）
// kimi：两个**已知**落盘格式的变体——kimi-code CLI（~/.kimi-code，走别名）与
//       Kimi CLI（~/.kimi，就是名字本身），两者的 wire.jsonl 摆法见 hasKimiSessions
// trae：TraeCode 桌面版的 Electron 应用目录名是 'Trae CN'（带空格），不是 'trae'，
//       故别名指向真实的安装目录名，basesFor 才能在 %APPDATA% 下找到它。
// traework：TraeWork 桌面版前身叫 'Trae SOLO'（2026年6月改名），两个目录名都列上，
//          装了哪个版本都能被发现。
// qoder：Qoder CN 版落盘目录是 ~/.qoder-cn，不加别名自动发现永远认不出（只能手动添加）。
// minimax：Mavis 本地运行时的数据根目录固定是 ~/.minimax（点目录），与「显式填入的 kind 名」
//          `minimax` 一致；HOME 下的小写别名 `mavis` 也算一份，避免同事按真实目录名手填时落空。
const NAME_ALIASES = {
  codeart: ['codearts-agent'], codearts: ['codearts-agent'], kimi: ['kimi-code'],
  trae: ['Trae CN', 'TraeCN', 'Trae Code', 'TraeCode'],
  traework: ['Trae Work', 'TraeWork', 'Trae SOLO', 'TraeSOLO', 'TRAE SOLO CN', 'Trae SOLO CN'],
  qoder: ['qoder-cn'],
  minimax: ['minimax', 'Mavis'],
  mimocode: ['mimocode'],
  kilo: ['kilo', 'kilocode'],
};
// 「只给诊断看、**不参与自动发现**」的候选路径。
//
// 为什么单列一份：需求书 R15 还要求覆盖 Kimi 桌面版（Win/mac/Linux/鸿蒙 PC），但这几个变体的
// 落盘格式本机无从查证（没装、也没有样本）。把它们塞进 candidateBases 的代价是**目录里随便一个
// `sessions/` 子目录都会被 sniffBase 的兜底分支认成 atomcode**，于是自动发现把 kimi 注册成
// atomcode、侧栏显示 0 条 —— 正好是这一版刚修掉的那个故障的另一个入口。
// 所以：诊断里照常列出来（有人装了桌面版就能一眼看到路径与顶层结构，截图发回来补解析器），
// 自动发现一律不碰。等真拿到样本、写了解析器，再把它挪进 NAME_ALIASES。
//
// 名单是按**社区/论坛里报过的落盘位置**列的（官网没写）：kimi-desktop 与 KimiDesktop 是同一个
// Electron 目录的两种书写（大小写不一致的报道都有），kimi-work / kimi-webbridge 是主目录下那两个
// 点目录，kimi-desktop-updater 是自动更新器 —— 更新器命中的概率低，但列上不花钱，
// 万一会话日志落在它那儿，诊断里会直接标出来。
// 注：`kimi-desktop` / `KimiDesktop` 这两个**不在**这里 —— 它们已经从「猜的路径」升级成
// 「有明确锚点的真路径」（读它的 daimon-storage.json → shareDir → 内嵌 kimi-code home，见
// kimiDesktopSessionsRoots）。剩下的三个仍旧只是「论坛里提过的落盘位置」，没有格式样本。
const PROBE_ONLY_BASES = {
  kimi: ['kimi-work', 'kimi-webbridge', 'kimi-desktop-updater'],
  // doubao 应用根目录（`%LOCALAPPDATA%\DoubaoWork`）：会话日志真正在它底下的
  // `User Data\Default\.doubaowork\...`，但不同安装/平台的具体摆法只在本机验证过 Windows 一条，
  // 归入「只给诊断看」——机器上装了但路径不对时，诊断里能一眼看到候选路径与顶层结构。
  doubao: ['DoubaoWork', 'Doubao'],
};
// 把「若干名字 → 各平台约定目录」展开（candidateBases 与 probeBases 共用）
//
// 这里就是「四平台都能用」里**平台相关的那一半**，它按 `process.platform` 分支、不认具体 agent：
//   win32            → ~/.<n>、%APPDATA%\<n>、%LOCALAPPDATA%\<n>（Electron 应用一般在这里）
//   darwin           → ~/.<n>、~/Library/Application Support/<n>、~/.config/<n>
//   linux / ohos / 其他 POSIX → ~/.<n>、$XDG_CONFIG_HOME(默认 ~/.config)/<n>、~/.local/share/<n>
// 鸿蒙 PC 的 Node 不是 win32 也不是 darwin，会落到最后一个分支 —— 与 Linux 同一套 XDG 约定，
// 这正是它该走的那套（真机要是报出别的 platform 值，在这里加一个分支即可，解析器不用动）。
// 另一半（解析器本身）与平台无关：只认文件内容，不碰路径分隔符、不调平台专属 API。
//
// 平台上下文**可注入**（第二参数，缺省 = 本机真实值）：这台开发机是 Windows，darwin / linux 两条
// 分支不可能在本机端到端验证，注入之后至少能把「哪个平台铺出哪些候选目录」钉在测试里，
// 而不是靠读代码猜（见 test/platform-test.mjs）。生产路径一律不传，行为与从前逐字一致。
function platCtx(c) {
  return {
    platform: (c && c.platform) || process.platform,
    home: (c && c.home) || HOME,
    env: (c && c.env) || process.env,
  };
}
function basesFor(names, c) {
  const { platform, home, env } = platCtx(c);
  const bases = [];
  for (const n of names) {
    bases.push(path.join(home, '.' + n)); // 全平台通用约定
    if (platform === 'win32') {
      if (env.APPDATA) bases.push(path.join(env.APPDATA, n));       // 桌面版 Electron 走这里
      if (env.LOCALAPPDATA) bases.push(path.join(env.LOCALAPPDATA, n));
    } else if (platform === 'darwin') {
      bases.push(path.join(home, 'Library', 'Application Support', n));
      bases.push(path.join(home, '.config', n));
    } else { // linux / ohos(HarmonyOS) / 其他 POSIX
      bases.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), n));
      bases.push(path.join(home, '.local', 'share', n));
    }
  }
  return bases;
}
function probeBases(name, c) {
  const n = PROBE_ONLY_BASES[name];
  return n ? basesFor(n, c) : [];
}

// ---------------- Kimi 桌面版的日志根（它内嵌了一份 kimi-code） ----------------
// 桌面版的会话**不在** `%APPDATA%\kimi-desktop` 里 —— 那个目录只有 Electron 的缓存与自身配置。
// 真正的会话在它自己挑的一个「数据根」下，结构是：
//     <shareDir>/…/runtime/kimi-code/home/sessions/<slug>/<会话 id>/agents/main/wire.jsonl
// 也就是一份**标准 kimi-code home**（同样带 session_index.jsonl、workspaces.json），
// 所以解析器完全复用 scanKimi，一个新格式都不用写。
//
// shareDir 记在桌面版自己的 `daimon-storage.json` 里（`{"shareDir":"E:\\KimiData"}`），
// 用户可以在设置里把它挪到别的盘 —— 本机就挪到了 E 盘，所以**不能写死路径**，必须读这个文件。
//
// 为什么不写死「daimon-share/daimon」那两层：那两层的名字是实现细节，可能随版本变；
// 而 `runtime/kimi-code/home` 是它内嵌的 kimi-code 的固定布局。所以按「往下探两层、每层都试一下
// <此处>/runtime/kimi-code/home」来找 —— 只探两层是刻意的：更深会走进 `app/daimon/node_modules`，
// 那是几万次 readdir，而 discoverAgents 每次启动都要跑。
const KIMI_DESKTOP_APPS = ['kimi-desktop', 'KimiDesktop'];
function kimiDesktopShareDirs() {
  const out = [];
  for (const dir of basesFor(KIMI_DESKTOP_APPS)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'daimon-storage.json'), 'utf8'));
      if (j && typeof j.shareDir === 'string' && j.shareDir.trim()) out.push(j.shareDir.trim());
    } catch {}   // 没装 / 老版本没这个文件 / 文件坏了 —— 都当没有
  }
  return [...new Set(out)];
}
function findKimiHomes(dir, depth, out) {
  const sessions = path.join(dir, 'runtime', 'kimi-code', 'home', 'sessions');
  if (isDir(sessions)) { out.push(sessions); return; }
  if (depth >= 2) return;
  let names; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names.slice(0, 60)) {
    const p = path.join(dir, n);
    if (isDir(p)) findKimiHomes(p, depth + 1, out);
  }
}
function kimiDesktopSessionsRoots() {
  const out = [];
  for (const sd of kimiDesktopShareDirs()) findKimiHomes(sd, 0, out);
  return [...new Set(out)];
}
function candidateBases(name, c) {
  const { platform, home, env } = platCtx(c);
  const out = basesFor([name, ...(NAME_ALIASES[name] || [])], c);
  // opencode 的数据根跟在 XDG 约定下（`~/.local/share/opencode`）——本机实测 Windows 上也在这里，
  // 既不是 `~/.opencode`，也不是 `%APPDATA%\opencode`。basesFor 只在 POSIX 分支里铺 .local/share，
  // 所以这里给它单补一条（其余平台与 basesFor 的结果重复，Set 去重后无副作用）。
  if (name === 'opencode') out.push(path.join(home, '.local', 'share', 'opencode'));
  // doubao（豆包 Work）的会话根在应用数据目录深处，不走 `~/.doubaowork` 约定：
  //   Windows 实测 = `%LOCALAPPDATA%\DoubaoWork\User Data\Default\.doubaowork\agent_mode\workspace`
  // （basesFor 的 `%LOCALAPPDATA%\doubaowork` 小写写法不存在，auto-discovery 靠这条真路径命中；
  //   上层目录的其它摆法交给 doubaoSessionsRoot 逐层下探，见下。）
  // 只在 win32 下铺：这是 Windows 应用的安装位置，别的平台补这条只会多出两段死路径。
  if (name === 'doubao' && platform === 'win32' && env.LOCALAPPDATA) {
    out.push(path.join(env.LOCALAPPDATA, 'DoubaoWork', 'User Data', 'Default', '.doubaowork', 'agent_mode', 'workspace'));
  }
  // hermes 的 home 整体可被 HERMES_HOME 改写（源码 hermes_constants.py 的唯一覆盖入口），
  // 指到哪儿都该被发现；basesFor 铺的 ~/.hermes 与 %LOCALAPPDATA%\hermes 已覆盖默认摆法。
  if (name === 'hermes' && env.HERMES_HOME) out.push(env.HERMES_HOME);
  // devin（Devin CLI）的数据目录按产品文档就是 XDG 式摆法：`~/.local/share/devin`（mac 与 Linux 同一处，
  // 库在它下面的 cli/sessions.db）。basesFor 只在 POSIX 分支铺 .local/share，darwin 分支铺的是
  // Library/Application Support 与 .config —— 这里补一条把 mac 也覆盖上。Windows 不用补：
  // 真身 %APPDATA%\Devin\cli 已被 basesFor 的 %APPDATA%\devin 命中（大小写不敏感）。
  if (name === 'devin') out.push(path.join(home, '.local', 'share', 'devin'));
  // minimax（Mavis 本地运行时）的会话**不在** ~/.minimax 顶层 —— 真根是 <home>/.minimax/v2/sessions，
  // 下面按 y/m/d/<session_id> 四层摆；顶层与 v2/ 都只是配置/缓存，没有 messages.jsonl。
  // basesFor 铺的 ~/.minimax + %APPDATA%/%LOCALAPPDATA% 下的同名目录都不够深，自动发现靠
  // 这条 v2/sessions 真路径命中（嗅探首行 JSON 形状，再由 hasMavisSession 下探）。
  if (name === 'minimax') out.push(path.join(home, '.minimax', 'v2', 'sessions'));
  // openclaw（OpenClaw）：stateDir 默认 ~/.openclaw（源码 dist/config-utils-*.js 的 resolveStateDir：
  // NEW_STATE_DIRNAME=".openclaw"、LEGACY_STATE_DIRNAMES=[".clawdbot"]），且 OPENCLAW_STATE_DIR 可整体改写。
  // 会话在 <stateDir>/agents/<id>/sessions/*.jsonl —— 所以铺的是 stateDir 本身，不是它的某个子目录。
  // basesFor 铺的 ~/.openclaw 已覆盖默认摆法；这里再补「环境变量指哪儿认哪儿」与老版本的 .clawdbot。
  if (name === 'openclaw') {
    if (env.OPENCLAW_STATE_DIR) {
      const sd = String(env.OPENCLAW_STATE_DIR).trim();
      if (sd) out.push(sd.startsWith('~') ? path.join(home, sd.replace(/^~[\\/]?/, '')) : sd);
    }
    if (env.OPENCLAW_HOME) {
      const oh = String(env.OPENCLAW_HOME).trim();
      if (oh) out.push(path.join(oh, OPENCLAW_STATE_DIRNAMES[0]));
    }
    for (const n of OPENCLAW_STATE_DIRNAMES) out.push(path.join(home, n));
  }
  // cline（Cline CLI 3.x）：会话在 <data>/sessions/<会话 id>/<会话 id>.messages.json，
  // data 根默认 `~/.cline/data`（basesFor 铺的 `~/.cline` 由 clineTranscripts 自己下探到 data/sessions）。
  // 二进制里认这三个环境变量（一处改写、其余派生）：CLINE_DATA_DIR 是 data 根，
  // CLINE_SESSION_DATA_DIR 直接就是 sessions 根，CLINE_DB_DATA_DIR 是旁边的库目录（不是会话根，不铺）。
  // 指到哪儿就得认到哪儿：用户把会话数据挪出家目录时，只按 `~/.cline` 铺路径会一无所获。
  if (name === 'cline') {
    const abs = v => {
      const s = String(v || '').trim();
      if (!s) return '';
      return s.startsWith('~') ? path.join(home, s.replace(/^~[\\/]?/, '')) : s;
    };
    const dd = abs(env.CLINE_DATA_DIR);
    if (dd) { out.push(dd, path.join(dd, 'sessions')); }
    const sd = abs(env.CLINE_SESSION_DATA_DIR);
    if (sd) out.push(sd);
  }
  // mimocode（记忆/检查点类 agent）：真源是 <home>/.local/share/mimocode/mimocode.db。
  // Windows 实测就是 C:\Users\<u>\.local\share\mimocode\mimocode.db（mac/Linux 同源，XDG 式摆法，
  // 没有 Electron 的 %APPDATA% 分支）。memory/ 是库导出的展示层，在 db 下一层。
  // 真路径 hit 靠下面两条：应用根（直接命中 mimocode.db）优先，memory/ 作为兜底。
  if (name === 'mimocode') {
    out.push(path.join(home, '.local', 'share', 'mimocode'));
    out.push(path.join(home, '.local', 'share', 'mimocode', 'memory'));
  }
  // kilo（KiloCode / Kilo CLI）：真源是 <home>/.local/share/kilo/kilo.db，XDG 摆法，本机 Windows 实测
  // 也在这里（既不是 %APPDATA%\kilo 也不是 ~/.kilo）。basesFor 只在 POSIX 分支铺 .local/share，
  // 所以这里单补一条（其余平台重复、Set 去重后无副作用，与 opencode 同款做法）。
  if (name === 'kilo') out.push(path.join(home, '.local', 'share', 'kilo'));
  // comate（百度 Comate）：会话真源是 <home>/.comate-engine/store/（本机 Windows 实测），
  // 不是 ~/.comate（那是 IDE 壳的 skills/hooks/extensions）也不是 %APPDATA%\Comate（Electron 缓存
  // + state.vscdb 索引指针）。basesFor 铺的三个候选都在 store 的**外面**，自动发现靠这条真路径命中；
  // 嗅探判据是内容（store 里有 chat_session_* 文件），不会误接。
  if (name === 'comate') out.push(path.join(home, '.comate-engine', 'store'));
  return [...new Set(out)];
}

export function hasCodeartsLogs(logsDir) {
  try { return fs.readdirSync(logsDir).some(n => /^CodeArts Agent-.*\.log$/i.test(n)); } catch { return false; }
}

// TraeCode / TraeWork 桌面版：<base>/logs/<启动时间戳>/window1/renderer.log
// 判据：logs 目录下存在任意形如 YYYYMMDDTHHMMSS 的 timestamp 目录，且该目录下有 window1/renderer.log，
//       并在 renderer.log 头 256KB 内扫到 `[ai-chat/v2]` 锚点（确认是 Trae 系的会话日志，不是 VS Code 等邻居）。
//
// 为什么读 256KB 而不是头 4KB：Trae 的 renderer.log 头部是 Electron 初始化日志
// （[ThirdPartyToken]、[HubNet]、[external-modules] 等），第一条 `[ai-chat/v2]` 事件要等到
// 第 1800 行左右（约 200KB）才出现。头 4KB 一条都扫不到，判据恒为 false → 自动发现静默失败。
// 256KB 内若还没有，基本可认定这份 renderer.log 不是 Trae 的会话日志（只是同名文件）。
//
// 区分 tracecode 与 tracework **不靠这里**——sniffBase 根据 base 目录名（Trae CN vs Trae Work/SOLO）
// 返回不同 kind；判据本身只回答「是不是 Trae 系的日志根」。
//
// 读盘量：最多枚举 5 个 timestamp 目录，每个最多读 256KB。
export function hasTraeRendererLogs(logsDir) {
  if (!isDir(logsDir)) return false;
  let tsCount = 0;
  let names; try { names = fs.readdirSync(logsDir); } catch { return false; }
  for (const ts of names) {
    if (tsCount++ > 5) break;
    // timestamp 目录名形如 20260917T154413（YYYYMMDDTHHMMSS）—— 这是 Trae 启动时创建的目录
    if (!/^\d{8}T\d{6}$/.test(ts)) continue;
    const fp = path.join(logsDir, ts, 'window1', 'renderer.log');
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size === 0) continue;
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(Math.min(262144, st.size));  // 256KB
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.toString('utf8', 0, n);
        // 锚点认两种日志 tag：老版 [ai-chat/v2]，新版（TRAE SOLO CN）[trae-chat-core]，否则新版机器识别不了自己的日志根。
        if (/\[ai-chat\/v2\]|\[trae-chat-core\]/.test(head)) return true;
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  return false;
}

export function hasTraceFiles(tracesDir) {
  try {
    for (const d of fs.readdirSync(tracesDir)) {
      const dd = path.join(tracesDir, d);
      if (!isDir(dd)) continue;
      try { if (fs.readdirSync(dd).some(n => n.startsWith('trace_') && n.endsWith('.json'))) return true; } catch {}
    }
  } catch {}
  return false;
}

// codex CLI: <base>/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl（按日期三层嵌套）
export function hasCodexRollouts(dir, depth = 0) {
  let names; try { names = fs.readdirSync(dir); } catch { return false; }
  if (names.some(n => /^rollout-.*\.jsonl$/.test(n))) return true;
  if (depth >= 3) return false;
  for (const n of names) {
    const p = path.join(dir, n);
    if (isDir(p) && hasCodexRollouts(p, depth + 1)) return true;
  }
  return false;
}

export function hasClaudeJsonl(projectsDir) {
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const dd = path.join(projectsDir, d);
      if (!isDir(dd)) continue;
      try { if (fs.readdirSync(dd).some(n => n.endsWith('.jsonl'))) return true; } catch {}
    }
  } catch {}
  return false;
}

// buddy 型（codebuddy / workbuddy）与 claude 型同为 projects/<slug>/*.jsonl，靠记录判别：
// claude 顶层是 {"type":"user"|"assistant"}（"message" 是嵌套对象），buddy 顶层是 {"type":"message","role":...}
// 这是每个扫描周期都会跑的嗅探路径，读盘量必须小：最多看 3 个目录 × 2 个文件 × 头 16KB
export function hasBuddyJsonl(projectsDir) {
  try {
    let dirs = 0;
    for (const d of fs.readdirSync(projectsDir)) {
      const dd = path.join(projectsDir, d);
      if (!isDir(dd)) continue;
      if (++dirs > 3) break;
      let names; try { names = fs.readdirSync(dd).filter(n => n.endsWith('.jsonl')).slice(0, 2); } catch { continue; }
      for (const n of names) {
        try {
          const head = fs.readFileSync(path.join(dd, n), 'utf8').slice(0, 16384);
          for (const line of head.split('\n')) {
            if (!line.includes('"type":"message"')) continue;
            try { const j = JSON.parse(line); if (j.type === 'message' && (j.role === 'user' || j.role === 'assistant')) return true; } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  return false;
}

// gemini 型：<base>/tmp/<项目slug>/ 下每个会话一份 session-*.json，外加同目录的 logs.json 提示词流水。
// 目录名是项目 slug（不是 hash），判据取「有会话文件」或「有 logs.json」都算——新版 CLI 只写后者
export function hasGeminiSessions(tmpDir) {
  let slugs = 0;
  for (const d of listDirCached(tmpDir) || []) {
    const dd = path.join(tmpDir, d);
    if (!isDir(dd)) continue;
    if (++slugs > 3) break;
    const names = listDirCached(path.join(dd, 'chats'));
    if (names && names.some(n => n.startsWith('session-') && n.endsWith('.jsonl'))) return true;
    try { if (fs.statSync(path.join(dd, 'logs.json')).isFile()) return true; } catch {}
  }
  return false;
}

// cursor 型：<base>/projects/<项目slug>/agent-transcripts/<会话uuid>/<同名>.jsonl，每行一个 {role, message}。
// 判据是**顶行没有 type**——这一条就把两个同构的邻居区分开了：claude 顶层 type=user/assistant、
// buddy 顶层 type=message，cursor 顶层只有 role/message。读取量与 hasBuddyJsonl 同级（≤3 目录 × 头 16KB）
//
// 探测深度是**故意放宽**的：原来只看前 3 个 slug、每个 slug 只看第一个文件、每条文件只看**第一条**
// 能解析的记录。三条都可能误判「这里不是 cursor」：
//   · .cursor/projects 下并存两种项目目录 —— 真跑过 Agent 的（有 agent-transcripts/，只有它算数）
//     和 Cursor 自己临时工作区的（只有 mcps/）。按字母序排在前面的常常是后者；
//   · 第一个会话可能刚开、转录是空的或只有半行；
//   · 首行是半行 JSON 时原来直接 break 整个文件，后面明明有正经记录也看不到。
// 代价仍然有上限：最多 5 个项目 × 2 个会话 × 1 个文件 × 头 16KB。
export function hasCursorTranscripts(projectsDir) {
  try {
    let slugs = 0;
    for (const d of fs.readdirSync(projectsDir)) {
      const at = path.join(projectsDir, d, 'agent-transcripts');
      if (!isDir(at)) continue;
      if (++slugs > 5) break;
      // 每个项目最多试 2 份转录（枚举交给 cursorTranscriptFiles，与扫描共用同一套落法判定）
      for (const { fp } of cursorTranscriptFiles(at).slice(0, 2)) {
        try {
          const head = fs.readFileSync(fp, 'utf8').slice(0, 16384);
          for (const line of head.split('\n').slice(0, 8)) {   // 头 8 行里有一条像样的记录就够（原来只试 1 行）
            const t = line.trim();
            if (!t || !t.includes('"role"')) continue;
            let j; try { j = JSON.parse(t); } catch { continue; }   // 半行/截断行：跳过继续，别放弃整个文件
            if (!j || j.type) continue;                             // 有顶层 type ⇒ 不是 cursor（claude/buddy 都有）
            if (j.role !== 'user' && j.role !== 'assistant') continue;
            // message 既可能是 {content:[…]}，也可能是纯字符串 —— cursorText() 两种都认，
            // 判据这边必须同样两种都认，否则会出现「解析器读得出来、探测却说不认识」的自相矛盾
            if (typeof j.message === 'string' || (j.message && Array.isArray(j.message.content))) return true;
          }
        } catch {}
      }
    }
  } catch {}
  return false;
}

// Kimi 的会话落盘（两个变体，wire.jsonl 事件流格式相同，只是摆法差一层）：
//   kimi-code CLI : ~/.kimi-code/sessions/<workdir slug>/session_<uuid>/agents/main/wire.jsonl
//   Kimi CLI      : ~/.kimi/sessions/<md5(workdir)>/<uuid>/wire.jsonl        （直接躺在会话目录里）
// 两个都可能在会话里挂子 agent 目录（agents/<agent-id>/、subagents/<agent-id>/），同样各有一份
// wire.jsonl —— 那些也算数（否则子 agent 那一轮的 token 就丢了），所以判据按「会话目录里任意深度
// ≤2 处存在 wire.jsonl」写，而不是写死 `agents/main`。
//
// 为什么不能只看路径、还要验一下文件头：`<x>/<y>/wire.jsonl` 这个形状并非 kimi 专属，
// atomcode 的 sessions/<hash>/ 里同样可能出现同名文件（扫描器是按目录走的，误认成 kimi 会让
// 整个 atomcode 目录一条都扫不出来）。所以两手都用：
//   · 结构 —— 会话目录下 ≤2 层内找到 wire.jsonl；
//   · 内容 —— 只读**头 512 字节**，要求第一行是 {"type":"metadata","protocol_version":…}。
//     只读头 512 字节是因为这一行**必然在最前且很短**（本机实测 94 字节），
//     与下面那段踩坑正好相反：以前的判据去读头 8KB 找 turn.prompt，而第 2 行是 20KB 的 systemPrompt，
//     8KB 里一行有效事件都没有，判据恒为 false → sniffBase 落到 atomcode 兜底 → 自动发现把 kimi
//     认成 atomcode、扫出 0 条。
//
//   那个错的隐蔽之处在于**升级过的机器上完全看不出来**：本机配置里那条 kimi 是历史手动项
//   kimi-code 迁移过来的（迁移时直接把 kind 写成 kimi），它一直有 59 条数据，看着一切正常；
//   只有干净环境（新同事、或用户删掉 kimi 条目后让自动发现重新接管）才会暴露成「装得好好的 kimi，
//   侧栏里 0 条」。所以断言别信本机，要信隔离 profile（见根目录 r15-kimi-test.mjs）。
//
// 上限 200 个 session：这是每个扫描周期都会走的嗅探路径，不能让一个畸形目录把它拖住。
const WIRE_RELS = [['agents', 'main', 'wire.jsonl'], ['wire.jsonl'], ['subagents', 'main', 'wire.jsonl']];
export function isKimiWire(fp) {
  if (!fs.existsSync(fp)) return false;
  try {
    let fd; try { fd = fs.openSync(fp, 'r'); } catch { return false; }
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      if (n <= 0) return false;
      const first = buf.toString('utf8', 0, n);
      // 头一行就是 metadata：不去 find('turn.prompt')，那一行可能在 20KB 之外（见上）
      return /^\{[^\n]*"type"\s*:\s*"metadata"/.test(first) && first.includes('"protocol_version"');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}
// 会话目录 -> 那一份 wire.jsonl 的绝对路径（找不到返回 null）。子目录只探一层：agents/<id>/、subagents/<id>/
export function kimiWireIn(sessDir) {
  for (const rel of WIRE_RELS) {
    const fp = path.join(sessDir, ...rel);
    if (isKimiWire(fp)) return fp;
  }
  try {
    for (const sub of listDirCached(sessDir) || []) {
      if (sub !== 'agents' && sub !== 'subagents') continue;
      const sd = path.join(sessDir, sub);
      if (!isDir(sd)) continue;
      for (const id of (listDirCached(sd) || []).slice(0, 8)) {
        const fp = path.join(sd, id, 'wire.jsonl');
        if (isKimiWire(fp)) return fp;
      }
    }
  } catch {}
  return null;
}
// 一个 sessions 根目录下的全部 (会话目录, wire.jsonl)：扫描与嗅探共用，避免两处各写一遍摆法
export function kimiWires(base) {
  const out = [];
  for (const slug of listDirCached(base) || []) {
    const slugDir = path.join(base, slug);
    if (!isDir(slugDir)) continue;
    for (const sess of listDirCached(slugDir) || []) {
      const sessDir = path.join(slugDir, sess);
      if (!isDir(sessDir)) continue;
      const fp = kimiWireIn(sessDir);
      if (fp) out.push({ sessDir, fp });
    }
  }
  return out;
}
export function hasKimiSessions(base) {
  if (!isDir(base)) return false;
  let checked = 0;
  try {
    for (const slug of (listDirCached(base) || []).slice(0, 60)) {
      const slugDir = path.join(base, slug);
      if (!isDir(slugDir)) continue;
      for (const sess of (listDirCached(slugDir) || []).slice(0, 40)) {
        if (++checked > 200) return false;
        if (kimiWireIn(path.join(slugDir, sess))) return true;
      }
    }
  } catch {}
  return false;
}

// ---------------- dsh（DeepSeek Harness） ----------------
// 落盘：~/.dsh/sessions/<项目 slug（形如 --F-centos-next-admin--）>/session-<uuid>/session.v3.jsonl.zstd
//   （同级的 settings.yaml / profiles/ / storages/ 都不是会话正文）
//
// 摆法与 atomcode 只差在第二层：atomcode 是 sessions/<hash>/<文件>.jsonl，dsh 是
// sessions/<slug>/<会话目录>/<文件>.zstd。所以光靠「sessions 下是目录」这个兜底判据，
// dsh 会被认成 atomcode，而 atomcode 的解析器一个文件都匹配不到 → 侧栏 0 条、且完全静默
// （这正是 kimi 当初的处境，见 sniffBase 里那段）。判据因此必须排在兜底前面。
//
// 会话文件名**带格式版本**（dsh 自己升版就改名）：实测 v3，2026-09-28 起落 v4。
//   · 同目录里可能同时躺着多份，取**版本号最高**的那份；
//   · 早期格式 session.jsonl.zstd（无版本号）是迁移前残留（实测只有会话头 + 几条配置事件、
//     没有轮次），永远排最后兜底。
// ⚠️ 曾经把版本号**写死**成 v3（`['session.v3.jsonl.zstd', …]`）：dsh 一升到 v4，新会话就整批
// 静默消失 —— 症状是「聊了一下午，面板今天 0 条」，而解析器本身完全读得动 v4（事件类型与 v3 同构，
// 多出来的 request/header、system/message 等新类型本就被忽略）。所以这里**不许再写死版本号**。
const DSH_SESSION_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;
const DSH_PLAIN_RANK = -1;   // 无版本号：比任何 vN 都旧

export function dshSessionFile(sessDir) {
  let ents;
  try { ents = fs.readdirSync(sessDir, { withFileTypes: true }); } catch { return null; }
  let best = '', bestRank = DSH_PLAIN_RANK - 1;
  for (const e of ents) {
    if (!e.isFile()) continue;
    const m = DSH_SESSION_RE.exec(e.name);
    if (!m) continue;
    const rank = m[1] ? Number(m[1]) : DSH_PLAIN_RANK;
    if (rank > bestRank) { bestRank = rank; best = e.name; }
  }
  return best ? path.join(sessDir, best) : null;
}

// 判据**只看有没有 .zstd 会话文件、不解压**：sniffBase 每轮扫描都要跑，解压太贵。
// 代价是老 Node（< 22.15，没有 zlib.zstdDecompressSync）上仍会把它认成 dsh、却扫不出条目 ——
// 那种机器由诊断直说原因（见 diagnose 里的 dsh 分支），而不是静默变成 0 条。
export function hasDshSessions(base) {
  if (!isDir(base)) return false;
  let checked = 0;
  try {
    for (const slug of (listDirCached(base) || []).slice(0, 60)) {
      const slugDir = path.join(base, slug);
      if (!isDir(slugDir)) continue;
      for (const sess of (listDirCached(slugDir) || []).slice(0, 40)) {
        if (++checked > 200) return false;
        if (dshSessionFile(path.join(slugDir, sess))) return true;
      }
    }
  } catch {}
  return false;
}

// ---------------- mimocode（记忆/检查点类 agent） ----------------
// mimocode 的**真源是 SQLite 库** mimocode.db（Drizzle ORM 之上）；memory/ 下那些 checkpoint.md/notes.md/
// MEMORY.md 只是库导出的展示层（本机实测 task 表为空）。库的位置：<mimocode 应用根>/mimocode.db，
// 而用户给的 memory 根在 <应用根>/memory/ 下 —— 所以嗅探/扫描都要**往上爬一层**找到 mimocode.db。
// 应用根通常是 <home>/.local/share/mimocode（Windows 实测 C:\Users\<u>\.local\share\mimocode）。
//
// 判据优先级：① 先看 base 这一层及往上数层有没有 mimocode.db（真源，命中即认）；② 没有库时退回到
// memory 展示层判据（sessions/projects/global 目录 + 目标文件存在），作为「库读不动」时的只读兜底根。
// mimocode 库的**内容**判据（与 opencode/zcode 一样按表认，不按文件名）。
//
// ⚠️ 为什么必须按内容认：mimocode.db 与 opencode.db 是**同源 schema**（都源自同一套
// session/message/part + event/event_sequence），opencodeDbVerify 的判据（那五张表）在
// mimocode.db 上**全为真**（本机实测）—— 光按表名认，mimocode 的库会被 opencode 探针接走，
// 结果是 mimocode 一条都出不来（与 dsh/kimi 当初被 atomcode 兜底接走同源）。
// 区分点在各自**独有**的表上：
//   mimocode 独有：history_fts(_idx) / actor_registry / inbox / task / workflow_run / memory_fts
//   opencode 独有：session_message / session_input / credential / project_directory
// 两边互相排斥，顺序就不再重要（本机实测各自独有表稳定存在）。
export const MIMOCODE_ONLY_TABLES = ['history_fts_idx', 'actor_registry', 'memory_fts_idx', 'workflow_run', 'task_event'];
export function mimocodeDbVerify(fp) {
  if (!isFile(fp)) return false;
  const mod = sqliteMod();
  if (!mod) return false;
  let db = null;
  try {
    db = new mod.DatabaseSync(fp, { readOnly: true });
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!names.has('session') || !names.has('message') || !names.has('part')) return false;
    // 至少命中一张 mimocode 独有表才算数（一张就够，别把「多了一张表」当必要条件）
    return MIMOCODE_ONLY_TABLES.some(t => names.has(t));
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}

export function hasMimocodeDb(root) {
  if (!isDir(root)) return false;
  const probe = p => {
    if (!isFile(p)) return false;
    // node:sqlite 不可用（Node < 22.5）时退回纯文件名判据：此时反正读不了库、要回退 markdown，
    // 且旧环境里不会同时装着 opencode 的库，认错的代价仅是「回退层能扫到东西」。
    if (!sqliteMod()) return true;
    return mimocodeDbVerify(p);
  };
  if (probe(path.join(root, 'mimocode.db'))) return true;
  // 往上爬几层（memory -> mimocode 应用根）
  let cur = root;
  for (let i = 0; i < 4; i++) {
    const up = path.dirname(cur);
    if (up === cur) break;
    if (probe(path.join(up, 'mimocode.db'))) return true;
    cur = up;
  }
  return false;
}
export function hasMimocodeSessions(root) {
  const s = path.join(root, 'sessions');
  if (!isDir(s)) return false;
  let n = 0;
  for (const sid of listDirCached(s) || []) {
    if (++n > 8) break;
    const d = path.join(s, sid);
    if (!isDir(d)) continue;
    if (isFile(path.join(d, 'checkpoint.md')) || isFile(path.join(d, 'notes.md'))) return true;
  }
  return false;
}
export function hasMimocodeProjects(root) {
  // projects 与 global 两者任一存在且非空就算命中（global 是 projects/global 的平级目录）。
  // 先探 projects：下面 <pid>/MEMORY.md 才算数；
  const p = path.join(root, 'projects');
  if (isDir(p)) {
    for (const pid of listDirCached(p) || []) {
      if (isFile(path.join(p, pid, 'MEMORY.md'))) return true;
    }
  }
  return isFile(path.join(root, 'global', 'MEMORY.md'));
}

// 从用户填的任意一层路径解析出「mimocode 应用根」（含 mimocode.db 的那层），找不到返回 null。
// 处理两层意思：① base 本身就是应用根（含 mimocode.db 或 memory/）；② base 是 memory 或更上层，
// 沿 known 目录名（memory、mimocode）逐层下探 / 上爬，命中 mimocode.db 即认。
export function mimocodeRoot(base) {
  if (!base) return null;
  // 直接是文件（用户误填 mimocode.db 本身）：那就是根
  try {
    if (fs.statSync(base).isFile()) {
      if (path.basename(base).toLowerCase() === 'mimocode.db') return path.dirname(base);
      return null;
    }
  } catch {}
  if (!isDir(base)) return null;
  if (hasMimocodeDb(base)) return base;
  // ② 没库时回退到 memory 展示层判据（本函数上方注释写的「②」，此前只写了判据函数、
  //    **从未接进来** —— 后果是库被删/被锁的机器上，memory/ 会被 atomcode 兜底接走
  //    （isDir(sessions) 就认），解析器一个文件都匹配不到 → 0 条且静默。
  //    这正是 mimocode-test 里「隔离 HOME、只拷 memory」那条用例长期红的根因。）
  if (hasMimocodeSessions(base) || hasMimocodeProjects(base)) return base;
  // 往下探：memory / mimocode 子目录
  for (const d of ['memory', 'mimocode']) {
    const p = path.join(base, d);
    if (isDir(p) && (hasMimocodeDb(p) || hasMimocodeSessions(p) || hasMimocodeProjects(p)))
      return mimocodeRoot(p);
  }
  // 往上爬：找 mimocode.db
  let cur = base;
  for (let i = 0; i < 5; i++) {
    const up = path.dirname(cur);
    if (up === cur) break;
    if (hasMimocodeDb(up)) return up;
    cur = up;
  }
  return null;
}
// 兼容旧名：返回 memory 展示层根（库读不动时的兜底入口）
export function mimocodeMemoryRoot(base) { return mimocodeRoot(base); }

// ---------------- GitHub Copilot CLI（~/.copilot/session-state/<id>/events.jsonl） ----------------
// Copilot 的 ~/.copilot/ide/*.lock 只是 IDE/MCP 通信锁；真正的会话正文落在 session-state 下。
// 判据与扫描器共用 copilotSessionFiles，避免“探测认得、扫描读不到”的漂移。
function copilotStateDir(base) {
  if (!base) return null;
  if (path.basename(base).toLowerCase() === 'session-state') return isDir(base) ? base : null;
  const p = path.join(base, 'session-state');
  return isDir(p) ? p : null;
}

function isCopilotEvents(fp) {
  if (!isFile(fp)) return false;
  try {
    const head = fs.readFileSync(fp, 'utf8').slice(0, 32768);
    for (const line of head.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j?.type === 'session.start' || j?.type === 'user.message') return true;
    }
  } catch {}
  return false;
}

export function copilotSessionFiles(base) {
  const state = copilotStateDir(base);
  if (!state) return [];
  const out = [];
  for (const id of listDirCached(state) || []) {
    const dir = path.join(state, id);
    if (!isDir(dir)) continue;
    const fp = path.join(dir, 'events.jsonl');
    if (isCopilotEvents(fp)) out.push({ sessionId: id, dir, fp });
  }
  return out;
}

export function hasCopilotSessions(base) {
  return copilotSessionFiles(base).length > 0;
}

// ---------------- kilo（KiloCode / Kilo CLI：opencode 的 fork） ----------------
// 真源：<home>/.local/share/kilo/kilo.db（明文 SQLite + WAL，**不需要解密**；页头就是 `SQLite format 3\0`）。
// XDG 摆法，本机 Windows 实测也在这里（不是 %APPDATA%\kilo，也不是 ~/.kilo）；同目录还有
// kilo.db-wal / kilo.db-shm、log/、repos/、storage/（storage/session_diff/ 是 opencode 那套文件式 diff）。
//
// ⚠️ 判据按**独有表**认，且各处必须排在 opencode 之前：kilo.db 与 opencode.db 是**同源 schema**，
// opencodeDbVerify 的五个条件（session/message/part/event/event_sequence）在 kilo.db 上**全为真**
// （本机实测）—— 光按那些表认，kilo 的库会被 opencode 探针接走，结果是 kilo 一条都出不来
// （与 mimocode 当初被接走、dsh/kimi 被 atomcode 兜底接走同源）。
// 区分点用 kilo **自己**的扩展表：
//   kilo 独有：kilo_board / kilo_board_message（多 agent 协作板）
//   ⚠️ 别拿 credential / project_directory / session_input / session_message 当判据 —— 那四张是
//   **opencode 本体**也有的扩展表，而 kilo 作为 fork 把它们**保留**了下来（本机实测全在），
//   拿它们当判据等于两家都认（mimocode 恰好相反：它把这些换成了 history_fts_idx / actor_registry 等）。
//   ⚠️ session_context_epoch 看着像 kilo 新增，**其实 opencode 本体也有**（本机实测两个库都在）：
//   把它放进判据的后果是 opencode.db 反过来被 kiloDbVerify 认成 kilo，而 sniffBase 里 kilo 又排在
//   opencode 前面 —— 真 opencode 会被静默抢走（实测踩到，故只留 kilo_board 两张）。
export const KILO_ONLY_TABLES = ['kilo_board', 'kilo_board_message'];
export function kiloDbVerify(fp) {
  if (!isFile(fp)) return false;
  // 先验页头再交给 node:sqlite：加密库（SQLCipher）与任意二进制在这里就被挡掉，
  // 不会让 sniffBase 每轮去尝试打开一个注定失败的文件。
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
    // 先把同源家族的那三张基础表作为门槛，再要求至少命中一张 kilo 独有表
    if (!(names.has('session') && names.has('message') && names.has('part'))) return false;
    return KILO_ONLY_TABLES.some(t => names.has(t));
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}

// 手工添加可能填：kilo.db 文件本身 / 数据根 ~/.local/share/kilo / ~/.local/share /
// ~/.local / 用户主目录 —— 都认。返回命中的**数据库文件路径**（sessions 字段存文件路径，与 opencode 同款）。
const KILO_DB_RELS = [
  'kilo.db',
  path.join('kilo', 'kilo.db'),
  path.join('share', 'kilo', 'kilo.db'),
  path.join('.local', 'share', 'kilo', 'kilo.db'),
  path.join('local', 'share', 'kilo', 'kilo.db'),
];
export function kiloDbFile(base) {
  if (!base) return null;
  try { if (fs.statSync(base).isFile()) return kiloDbVerify(base) ? base : null; } catch { return null; }
  for (const rel of KILO_DB_RELS) {
    const fp = path.join(base, rel);
    try { if (fs.statSync(fp).isFile() && kiloDbVerify(fp)) return fp; } catch {}
  }
  return null;
}

// ---------------- opencode（~/.local/share/opencode/opencode.db，明文 SQLite） ----------------
// OpenCode 的会话也**不在文件树里**，而是集中写在一个明文 SQLite 库（WAL 模式，旁边有 opencode.db-wal）：
//   session / message(data JSON) / part(data JSON) 是正文与用量，event + event_sequence 是同一份状态的
//   事件投影（解析器不把它当第二条数据源，见 parsers/opencode.mjs 的文件头）。
// **不需要解密**：这是标准 SQLite（页头就是 `SQLite format 3\0`），与 traedb 那种 SQLCipher 库不是一回事。
//
// 判据必须是**内容**，而且要比 zcode 更严：两个库都有 session + message + part 三张表，
// 光按那三张认会把 OpenCode 的库判成 zcode（或反之）。区分点在各自独有的表上 ——
//   OpenCode 独有：event / event_sequence（事件投影）
//   ZCode  独有：turn_usage / model_usage / tool_usage
// 所以 opencode 的判据加上 event + event_sequence，并且在 sniffBase 里排在 zcode 前面。
export function opencodeDbVerify(fp) {
  if (!isFile(fp)) return false;
  // 先验页头再交给 node:sqlite：加密库（SQLCipher）与任意二进制在这里就被挡掉，
  // 不会让 sniffBase 每轮去尝试打开一个注定失败的文件。
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
    if (!(names.has('session') && names.has('message') && names.has('part')
      && names.has('event') && names.has('event_sequence'))) return false;
    // ⚠️ 必须把 mimocode 的库挡回去：两家是**同源 schema**，上面五张表在 mimocode.db 上全为真
    //（本机实测），不挡就会被这里接走 → mimocode 恒 0 条。判据见 MIMOCODE_ONLY_TABLES。
    if (MIMOCODE_ONLY_TABLES.some(t => names.has(t))) return false;
    // ⚠️ kilo 同理（KiloCode 是 opencode 的 fork，上面五张表在 kilo.db 上同样全为真，本机实测）：
    // 不挡的话，用户把 kilo.db 手工填给 opencode（或把 ~/.local/share 整个填进来）就会被这里接走，
    // 且 server 的自愈逻辑还会把 kilo 的 kind 改写成 opencode。判据见 KILO_ONLY_TABLES。
    if (KILO_ONLY_TABLES.some(t => names.has(t))) return false;
    return true;
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}

// 手工添加可能填：opencode.db 文件本身 / 数据根 ~/.local/share/opencode / ~/.local/share /
// ~/.local / 用户主目录 —— 都认。返回命中的**数据库文件路径**（sessions 字段存文件路径，与 zcode 同款）。
const OPENCODE_DB_RELS = [
  'opencode.db',
  path.join('opencode', 'opencode.db'),
  path.join('share', 'opencode', 'opencode.db'),
  path.join('.local', 'share', 'opencode', 'opencode.db'),
  path.join('local', 'share', 'opencode', 'opencode.db'),
];
export function opencodeDbFile(base) {
  if (!base) return null;
  try { if (fs.statSync(base).isFile()) return opencodeDbVerify(base) ? base : null; } catch { return null; }
  for (const rel of OPENCODE_DB_RELS) {
    const fp = path.join(base, rel);
    try { if (fs.statSync(fp).isFile() && opencodeDbVerify(fp)) return fp; } catch {}
  }
  return null;
}

// ---------------- hermes（Hermes Agent：state.db，明文 SQLite + WAL） ----------------
// 落盘：<hermes home>/state.db。home 按平台（源码 hermes_constants.py 核实）：
//   Windows 原生 = %LOCALAPPDATA%\hermes；Linux/mac/WSL2 = ~/.hermes；HERMES_HOME 环境变量可整体改写。
// 判据要比 zcode/opencode 更留意重名：**state.db 这种文件名不稀奇**，认的是三张独有表
// （sessions/messages/session_model_usage，复数命名 + 用量表，与 zcode 的 session/message/part、
//   opencode 的 session/message/part+event 都错开）。旁边常年挂着 -wal（未 checkpoint 的新数据在 WAL 里，
// node:sqlite 只读连接会带上，与 opencode 同款处理）。
// 同目录 logs/agent.log 是逐次用量的辅源，判据不看它（缺失只降级口径，不影响认领）。
export function hermesDbVerify(fp) {
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
    return names.has('sessions') && names.has('messages') && names.has('session_model_usage');
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}
// 手工添加可能填：state.db 文件本身 / hermes home（~/.hermes、%LOCALAPPDATA%\hermes）/ 其父目录 —— 都认。
// 返回命中的**数据库文件路径**（sessions 字段存文件路径，与 zcode/opencode 同款）。
const HERMES_DB_RELS = [
  'state.db',
  path.join('hermes', 'state.db'),
  path.join('.hermes', 'state.db'),
];
export function hermesDbFile(base) {
  if (!base) return null;
  try { if (fs.statSync(base).isFile()) return hermesDbVerify(base) ? base : null; } catch { return null; }
  for (const rel of HERMES_DB_RELS) {
    const fp = path.join(base, rel);
    try { if (fs.statSync(fp).isFile() && hermesDbVerify(fp)) return fp; } catch {}
  }
  return null;
}

// ---------------- devin（Devin CLI：sessions.db，明文 SQLite + WAL） ----------------
// 落盘：<cli 数据目录>/sessions.db。数据目录（产品文档 devin 的 configuration/extensibility 章节核实）：
//   Windows = %APPDATA%\devin\cli；mac/Linux = ~/.local/share/devin/cli。
// 判据里**不含 `sessions` 这张表** —— 它跟 hermes / zcode / opencode 都重名；认的是三张**独有表同时在场**：
//   sessions + message_nodes（消息森林）+ tool_call_state（工具调用状态）。
// 另注：老版本（cognition 时代）的数据在 ~/.local/share/cognition/cli/，升级时**留下了兼容符号链接**指向
//   devin/ —— 所以**故意不去探那条老路径**：跟进去只会把同一个库按两个路径注册成两个 agent。
export function devinDbVerify(fp) {
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
    return names.has('sessions') && names.has('message_nodes') && names.has('tool_call_state');
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}
// 手工添加可能填：sessions.db 文件本身 / cli 数据目录（%APPDATA%\Devin\cli、~/.local/share/devin/cli）/
// 产品根（%APPDATA%\Devin、~/.local/share/devin）—— 都认。返回命中的**数据库文件路径**（与 hermes 同款，
// sessions 字段存文件路径）。'Devin'/'devin' 两种大小写都列上：Windows 路径不敏感，POSIX 上两种写法
// 都有人建。
const DEVIN_DB_RELS = [
  'sessions.db',
  path.join('cli', 'sessions.db'),
  path.join('Devin', 'cli', 'sessions.db'),
  path.join('devin', 'cli', 'sessions.db'),
];
export function devinDbFile(base) {
  if (!base) return null;
  try { if (fs.statSync(base).isFile()) return devinDbVerify(base) ? base : null; } catch { return null; }
  for (const rel of DEVIN_DB_RELS) {
    const fp = path.join(base, rel);
    try { if (fs.statSync(fp).isFile() && devinDbVerify(fp)) return fp; } catch {}
  }
  return null;
}

// ---------------- zcode（~/.zcode/cli/db/db.sqlite，WAL 模式的 SQLite 库） ----------------
// ZCode 的会话**不在工作区里**（workspace 下没有 claude 那样的 jsonl 转录），而是集中写在用户目录的
// 一个 SQLite 库里：session / message / part / session_input / tool_usage / model_usage / turn_usage。
// 这正是「聊了几轮、手动添加却检测不到日志」的根因 —— 扫文件树的嗅探永远看不到数据库里的数据。
//
// 判据是**内容**（sqlite_master 里有没有 session+message+part 三张核心表），不是文件名：
// 叫 db.sqlite 的文件遍地都是，内容不符一律不认，免得把别的工具的库接进来。
// 只读打开、查完即关；库被锁/损坏/不是 sqlite 一律返回 null（下一轮扫描再试，不报错不崩溃）。
// 嗅探路径每轮扫描都会走，这里只开一次库、查一张 sqlite_master，开销与读一个小文件同级。
// node:sqlite 加载器在 shared.mjs（cursor / zcode / discovery 共用同一份实例）。
export function zcodeDbVerify(fp) {
  const mod = sqliteMod();
  if (!mod) return false;
  let db = null;
  try {
    db = new mod.DatabaseSync(fp, { readOnly: true });
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    return names.has('session') && names.has('message') && names.has('part');
  } catch { return false; }
  finally { try { db && db.close(); } catch {} }
}

// 手工添加可能填：db.sqlite 文件本身 / db 目录 / cli 目录 / .zcode 基目录 —— 四种都认。
// 返回命中的**数据库文件路径**（sessions 字段存文件路径，不是目录），认不出返回 null。
export function zcodeDbFile(base) {
  if (!base) return null;
  try {
    if (fs.statSync(base).isFile()) return zcodeDbVerify(base) ? base : null;
  } catch { return null; }
  for (const rel of ['db.sqlite', path.join('db', 'db.sqlite'), path.join('cli', 'db', 'db.sqlite')]) {
    const fp = path.join(base, rel);
    try { if (fs.statSync(fp).isFile() && zcodeDbVerify(fp)) return fp; } catch {}
  }
  return null;
}

// ---------------- traedb（Trae CN / Trae Work 的 SQLCipher 会话库，见 parsers/traedb.mjs） ----------------
// 路径：<产品根>/ModularData/ai-agent/database.db。**判据只能是「路径 + 文件特征」**：
// 库是 SQLCipher 加密的（头 16 字节是随机 salt，不是 'SQLite format 3\0'），拿 sqlite 去开必然失败 ——
// zcode 那种「查 sqlite_master 认表」的内容判据在这里用不了；而解密需要密钥，嗅探每轮都跑、不能配密钥。
// 所以：路径组合命中 + 不是明文 sqlite + 有起码的体量，就认。认错的风险被路径本身兜住
// （ModularData/ai-agent/database.db 这个组合是 Trae 专属的，别的产品不这么摆）。
// 文件特征只挡一种误接：用户手工指定时指到一份**明文** sqlite（database.db 这个名字太普通）——
// 那种库不是这个解析器该读的源（下游解密一定读不出），宁可在这里不认。
function traeDbVerify(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size < 1024) return false;
    const fd = fs.openSync(fp, 'r');
    try {
      const head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, 16, 0);
      return n === 16 && head.toString('latin1') !== 'SQLite format 3\0';
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}
// 手工添加可能填：database.db 文件本身 / ai-agent 目录 / ModularData 目录 / 产品根目录 —— 都认。
// 返回命中的**数据库文件路径**（sessions 字段存文件路径，与 zcode 同款）。
export function traeDbFile(base) {
  if (!base) return null;
  try {
    const st = fs.statSync(base);
    if (st.isFile()) return /^database\.db$/i.test(path.basename(base)) && traeDbVerify(base) ? base : null;
  } catch { return null; }
  for (const rel of ['database.db', path.join('ai-agent', 'database.db'), path.join('ModularData', 'ai-agent', 'database.db')]) {
    const fp = path.join(base, rel);
    try { if (fs.statSync(fp).isFile() && traeDbVerify(fp)) return fp; } catch {}
  }
  return null;
}
// db 读不出来（没配密钥 / 密钥不对 / Trae 正在写库）时回退 renderer.log 需要的两样东西：
//   traeLogKindOf —— 这个产品该用哪个日志解析器（Trae Work / SOLO → tracework，其余 → tracecode）
//   traeLogsFromDb —— logs 根目录在哪（沿 database.db 往上找 <产品根>/logs）
// 判据与 sniffBase 的日志分支、candidateBases 的别名表保持同一套（目录名带 work/solo 就是 TraeWork）。
export function traeLogKindOf(dbPath) {
  let d = path.dirname(dbPath);
  for (let i = 0; i < 4; i++) {
    const bn = path.basename(d).toLowerCase();
    if (bn.startsWith('trae')) return (bn.includes('work') || bn.includes('solo')) ? 'tracework' : 'tracecode';
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return 'tracecode';   // 认不出产品根（数据被挪到自定义路径）时按主产品 Trae CN 兜底
}
export function traeLogsFromDb(dbPath) {
  let d = path.dirname(dbPath);
  for (let i = 0; i < 4; i++) {
    const l = path.join(d, 'logs');
    if (isDir(l) && hasTraeRendererLogs(l)) return l;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}


// ---------------- doubao（豆包 Work 智能体，trajectory.jsonl） ----------------
// 落盘：<workspace>/.sessions/<会话 id>/agents/<agent id>/system/trajectory.jsonl
//   OpenAI 风格逐行 jsonl（{"role":"user"|"assistant"|"tool",…}），user 开轮、assistant 累加、
//   tool 行按 tool_call_id 回填。同目录 assignment.md 是每轮 user 消息的 ISO 时间戳源。
//
// 判据 = 目录结构 + 内容，读盘量压到最小（嗅探每 3s 走一轮）：
//   最多看 8 个会话 × 8 个 agent × 每个 trajectory 头 4KB，要求其中至少一条记录的
//   role 是 user/assistant/tool 之一。`agents/<id>/system/trajectory.jsonl` 这个摆法
//   加上 role 字段双保险，不会把别的工具的 trajectory.jsonl 误认进来。
export function hasDoubaoSessions(base) {
  if (!isDir(base)) return false;
  let s = 0;
  try {
    for (const sid of listDirCached(base) || []) {
      if (++s > 8) break;
      const agents = path.join(base, sid, 'agents');
      if (!isDir(agents)) continue;
      for (const aid of (listDirCached(agents) || []).slice(0, 8)) {
        const fp = path.join(agents, aid, 'system', 'trajectory.jsonl');
        if (!isFile(fp)) continue;
        try {
          const st = fs.statSync(fp);
          if (st.size < 8) continue; // 空文件 / 只有半行：不算
          const fd = fs.openSync(fp, 'r');
          try {
            const buf = Buffer.alloc(Math.min(4096, st.size));
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            const head = buf.toString('utf8', 0, n);
            for (const line of head.split('\n')) {
              if (!line.includes('"role"')) continue;
              try {
                const j = JSON.parse(line);
                if (j.role === 'user' || j.role === 'assistant' || j.role === 'tool') return true;
              } catch {}
            }
          } finally { fs.closeSync(fd); }
        } catch {}
      }
    }
  } catch {}
  return false;
}

// 从用户填的任意一层路径解析出 `.sessions` 根（找不到返回 null）。
// 处理两层意思：① base 本身就是 .sessions；② base 是它上面任意一层（DoubaoWork 应用根 /
// User Data / Default / .doubaowork / agent_mode / workspace），沿已知目录名逐层下探。
// 下探是「名字命中」+「内容验证」双闸：名字猜错不会误认（最后一道是 hasDoubaoSessions 的
// 内容判据），所以可以放心把非 doubao 的目录也放进来探。
const DOUBAO_DESCENT = ['User Data', 'Default', '.doubaowork', 'agent_mode', 'workspace'];
export function doubaoSessionsRoot(base) {
  if (!isDir(base)) return null;
  if (path.basename(base) === '.sessions' && hasDoubaoSessions(base)) return base;
  let cur = base;
  for (let i = 0; i < 6; i++) {
    const s = path.join(cur, '.sessions');
    if (isDir(s) && hasDoubaoSessions(s)) return s;
    let next = null;
    for (const d of DOUBAO_DESCENT) {
      const p = path.join(cur, d);
      if (isDir(p)) { next = p; break; }
    }
    if (!next) return null;
    cur = next;
  }
  return null;
}

//   buddy 型:  同上目录结构，但记录格式不同（codebuddy / workbuddy）
//   codearts 型: <base>/User/logs/CodeArts Agent-*.log（sessions 字段存 logs 目录）
//   gemini 型:  <base>/tmp/<项目slug>/{chats/session-*.json, logs.json}（sessions 字段存 tmp 目录）
//   cursor 型:  <base>/projects/<项目slug>/agent-transcripts/<会话uuid>/<同名>.jsonl（sessions 字段存 projects 目录）
//   zcode 型:   <base>/cli/db/db.sqlite（sessions 字段存**数据库文件本身**，不是目录——
//               手工添加时填 db.sqlite 文件 / db 目录 / cli 目录 / .zcode 基目录都认）
//   kilo 型:    <base>/kilo.db（同 opencode 型，sessions 存数据库文件本身；手工添加时填 kilo.db 文件 /
//               数据根 ~/.local/share/kilo / ~/.local/share / ~/.local / 用户主目录都认）
//   opencode 型: <base>/opencode.db（同上，sessions 存数据库文件本身；手工添加时填 opencode.db 文件 /
//               数据根 ~/.local/share/opencode / ~/.local/share / ~/.local / 用户主目录都认）
//   traedb 型:  <base>/ModularData/ai-agent/database.db（同上，sessions 存数据库文件本身；
//               手工添加时填 database.db 文件 / ai-agent 目录 / ModularData 目录 / 产品根目录都认）
// ---------------- Comate（百度）会话嗅探 ----------------
// 判据是**内容**：store 目录里至少有一个 chat_session_* 普通文件（会话正文是整份 JSON，
// 首字符 '{'、含 "sessionUuid"）。blobs/ 里的 .d 是目录、comate_chat_sessions.jsonl 是索引，
// 都不算数 —— 名字猜错不会误接，与 openclaw 的首行判据同一条约定。
// 探测（sniffBase）与扫描（scanComate）都认「平铺 chat_session_* 文件」这一种摆法。
export function comateSessionFiles(storeDir) {
  const out = [];
  for (const n of listDirCached(storeDir) || []) {
    if (!n.startsWith('chat_session_')) continue;
    const fp = path.join(storeDir, n);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.isFile()) out.push({ fp, st });
  }
  return out;
}
export function hasComateSessions(storeDir) {
  if (!isDir(storeDir)) return false;
  const list = comateSessionFiles(storeDir);
  if (!list.length) return false;
  try {
    const head = fs.readFileSync(list[0].fp, 'utf8').slice(0, 512);
    return head.trimStart().startsWith('{') && head.includes('"sessionUuid"');
  } catch { return false; }
}

export function sniffBase(base) {
  // kilo 必须排在 opencode **之前**：kilo.db 与 opencode.db 是同源 schema，kilo.db 在 opencodeDbVerify
  // 下五张表全为真（本机实测），排在后面就永远轮不到它 → kilo 恒 0 条。两家靠独有表互斥
  // （opencodeDbVerify 也反向排除了 KILO_ONLY_TABLES），判据见各自 verify 的注释。
  const klf = kiloDbFile(base);
  if (klf) return { kind: 'kilo', sessions: klf, traces: null };
  // opencode 是**文件型**源头（sessions 存 opencode.db 路径），且必须排在 zcode 前面：
  // 两个库都有 session + message + part，zcode 的判据（只看这三张表）会把 opencode 的库接走。
  const okf = opencodeDbFile(base);
  if (okf) return { kind: 'opencode', sessions: okf, traces: null };
  // zcode 是**文件型**源头，必须在 isDir 兜底之前判断：手工添加直接填 db.sqlite 的路径时，
  // base 是个文件，进不了下面任何一个 isDir 分支
  const zf = zcodeDbFile(base);
  if (zf) return { kind: 'zcode', sessions: zf, traces: null };
  // traedb 同理是文件型（sessions 存 database.db 的路径），也必须在 isDir 兜底之前
  const tf = traeDbFile(base);
  if (tf) return { kind: 'traedb', sessions: tf, traces: null };
  // hermes 同理是文件型（sessions 存 state.db 的路径）：~/.hermes / %LOCALAPPDATA%\hermes /
  // HERMES_HOME 指哪儿都命中；判据是三张独有表，与上面两家错开（见 hermesDbVerify 注释）
  const hf = hermesDbFile(base);
  if (hf) return { kind: 'hermes', sessions: hf, traces: null };
  // devin 同理是文件型（sessions 存 sessions.db 的路径）：%APPDATA%\Devin\cli /
  // ~/.local/share/devin/cli 指哪儿都命中；判据是三张独有表（见 devinDbVerify 注释）
  const df = devinDbFile(base);
  if (df) return { kind: 'devindb', sessions: df, traces: null };
  // comate（百度 Comate）：store 目录判据是内容（chat_session_* 文件首部含 "sessionUuid"），
  // 必须抢在 atomcode 兜底（isDir(sessions) 就认）之前——store 下没有 sessions/ 子目录，
  // 但用户手工填 ~/.comate-engine 或 /store 时不能静默变成 0 条（与 dsh/kimi 当初的坑同源）。
  if (hasComateSessions(base)) return { kind: 'comate', sessions: base, traces: null };
  // minimax（Mavis 本地运行时）：路径可能直接是会话目录（含 messages.jsonl + manifest.json），
  // 也可能是 v2/sessions 根（向下四层到 session_<id>）。必须在 isDir(sessions) 兜底之前：
  // 否则 ~/.minimax/v2/sessions 会被嗅探认成 atomcode、且解析器在 messages.jsonl 上一个都匹配不到 → 0 条。
  // minimax（Mavis 本地运行时）：base 可能是会话目录、v2/sessions 根、或 ~/.minimax 应用根。
  // hasMavisSession 直接返回解析出的会话根（~/.minimax → ~/.minimax/v2/sessions），sniffBase 用它当 sessions。
  { const mv = hasMavisSession(base); if (mv) return { kind: 'minimax', sessions: mv, traces: null }; }
  // openclaw（OpenClaw）：真源是 <stateDir>/agents/<id>/sessions/<uuid>.jsonl（stateDir 默认 ~/.openclaw）。
  // 必须抢在 atomcode 兜底（isDir(sessions) 就认）之前认 —— 用户手工填 <stateDir>/agents/<id>/sessions 时，
  // 那正是 atomcode 兜底要接的形状，而 openclaw 的条目在里面一条都匹配不到 → 0 条且静默（dsh/kimi 同源）。
  // 判据是**内容**（首行必须是会话头 {"type":"session","version":…,"id":…}），名字猜错不会误接。
  { const oc = openclawTranscripts(base); if (oc) return { kind: 'openclaw', sessions: oc.root, traces: null }; }
  // cline（Cline CLI）：真源是 <data>/sessions/<会话 id>/<会话 id>.messages.json（**整份 JSON、每次落盘整体重写**）。
  // 必须抢在 atomcode 兜底之前：手工填 `<...>/data/sessions` 时，那正是兜底两分支（isDir(sessions) /
  // basename==='sessions'）要接的形状，而 atomcode 找的是 <hash>/*.jsonl|*.meta → 0 条且静默
  // （与 dsh / kimi / openclaw 当初同源）。判据是**内容**（文件名以 .messages.json 结尾 + 头 2KB 里同时
  // 出现 "sessionId" 与 "messages": [），所以 `~/.cline` / `data` / `sessions` / 单个会话目录 /
  // 直接填那份 json 五种写法都认，名字猜错也不会误接邻居的数据。
  { const cl = clineTranscripts(base); if (cl) return { kind: 'cline', sessions: cl.root, traces: null }; }
  // buddyext（CodeBuddy **扩展版**，与上面 codebuddy=CLI 是两个产品）：真源是
  //   %LOCALAPPDATA%\CodeBuddyExtension\Data/<acct>/<Host>/(<acct>/)?history/<wsKey>/<会话 id>/index.json。
  // 同样必须抢在 atomcode 兜底之前：手工填到 `<Host>` 那一层时底下并没有 sessions/，但填到
  //   `<Data>` 或 `<Data>/<acct>` 时隔壁就有别的 agent 形状的目录，兜底会认成 atomcode → 0 条且静默
  //   （与 dsh / kimi / openclaw / cline 当初同源）。判据是**结构**（acct/Host/history 三层齐不齐），
  //   且只在 `<base>/Data` 存在、或 base 顺着祖先走到名为 data 的层时才付 readdir 代价 —— 见 buddyExtRoot。
  { const bx = buddyExtRoot(base); if (bx) return { kind: 'buddyext', sessions: bx, traces: null }; }
  if (!isDir(base)) return null;
  // TraeCode / TraeWork 桌面版：<base>/logs/<timestamp>/window1/renderer.log
  // 必须排在所有 sessions/projects 判据之前 —— Trae CN 应用目录下没有 sessions/、projects/、
  // traces/ 等子目录，但有 ModularData/、logs/、User/ 等，落到 atomcode 兜底会变成 0 条且静默。
  // 区分 kind 靠 base 目录名（Trae CN → tracecode；Trae Work / SOLO → tracework）：
  //   装在同一台机器上的两个产品会被自动发现分别注册（不同 name、不同 kind、不同 sessions 路径）。
  // 这条分支只伺候**库不在**的机器（老版本 Trae / 库被删）或密钥读不出来的回退：库在时上面那条
  // traedb 已经接走了 —— 回退由主文件按 traeLogKindOf/traeLogsFromDb 指路，不靠这里。⚠️
  const traeLogs = path.join(base, 'logs');
  if (isDir(traeLogs) && hasTraeRendererLogs(traeLogs)) {
    const bn = path.basename(base).toLowerCase();
    if (bn.includes('work') || bn.includes('solo')) {
      return { kind: 'tracework', sessions: traeLogs, traces: null };
    }
    return { kind: 'tracecode', sessions: traeLogs, traces: null };
  }
  // Copilot：session-state/*/events.jsonl 必须抢在通用目录兜底之前，否则 ~/.copilot 会被误判为未知目录。
  if (hasCopilotSessions(base)) return { kind: 'copilot', sessions: base, traces: null };
  // doubao：workspace/.sessions/<会话 id>/agents/<agent id>/system/trajectory.jsonl。
  // 必须排在 atomcode 兜底（isDir(sessions) 就认）之前——用户手工填的可能就是 .sessions /
  // workspace / 应用根任意一层，全由 doubaoSessionsRoot 下探解析；内容判据兜底，不会误接。
  const dbSess = doubaoSessionsRoot(base);
  if (dbSess) return { kind: 'doubao', sessions: dbSess, traces: null };
  const sessions = path.join(base, 'sessions');
  const traces = path.join(base, 'traces');
  const projects = path.join(base, 'projects');
  const caLogs = path.join(base, 'User', 'logs');
  if (isDir(caLogs) && hasCodeartsLogs(caLogs)) return { kind: 'codearts', sessions: caLogs, traces: null };
  const geminiTmp = path.join(base, 'tmp');
  if (isDir(geminiTmp) && hasGeminiSessions(geminiTmp)) return { kind: 'gemini', sessions: geminiTmp, traces: null };
  // cursor 必须排在 hasClaudeJsonl 前面：那个判据只看「slug 目录里有没有 .jsonl」，不认内容
  if (isDir(projects) && hasCursorTranscripts(projects)) return { kind: 'cursor', sessions: projects, traces: null };
  // buddy 先于 trace：这类目录（codebuddy/workbuddy）同时有 traces，但 traces 只是空壳，projects 才是正文
  if (isDir(projects) && hasBuddyJsonl(projects)) return { kind: 'buddyjsonl', sessions: projects, traces: null };
  if (isDir(traces) && hasTraceFiles(traces)) return { kind: 'trace', sessions: isDir(sessions) ? sessions : null, traces };
  if (isDir(projects) && hasClaudeJsonl(projects)) return { kind: 'claude', sessions: projects, traces: null };
  if (isDir(sessions) && hasCodexRollouts(sessions)) return { kind: 'codex', sessions, traces: null };
  // kimi：判据是 wire.jsonl 的事件结构，必须排在 atomcode 兜底（isDir(sessions) 就认）前面
  if (isDir(sessions) && hasKimiSessions(sessions)) return { kind: 'kimi', sessions, traces: null };
  // dsh：同理必须排在兜底前面 —— 它的 sessions/<slug>/<会话目录>/ 这个摆法会被 atomcode 兜底接走，
  // 而 atomcode 找的是 <hash>/<文件>.jsonl|.meta，对 dsh 一个都匹配不到 → 0 条且静默
  if (isDir(sessions) && hasDshSessions(sessions)) return { kind: 'dsh', sessions, traces: null };
  // mimocode（记忆/检查点类 agent）：真源是 mimocode.db，位于 mimocode 应用根（通常为
  // <home>/.local/share/mimocode，库在 memory/ 上一层）。memory/ 下的 markdown 只是展示层。
  // 必须抢在 atomcode 兜底（isDir(sessions) 就认）前认，否则 memory/sessions/<id>/ 会被认成 atomcode
  // （atomcode 解析器一个文件都匹配不到 → 0 条且静默，与 dsh / kimi 当初的处境同源）。
  // sessions 字段存解析出的「应用根」（含 mimocode.db 或 memory/），扫描器内部再定位库 / 兜底 markdown。
  { const mm = mimocodeRoot(base); if (mm) return { kind: 'mimocode', sessions: mm, traces: null }; }
  if (isDir(sessions)) return { kind: 'atomcode', sessions, traces: null };
  // 直接给的就是 projects 目录（或形如 projects 的目录：<slug>/*.jsonl）
  if (hasBuddyJsonl(base)) return { kind: 'buddyjsonl', sessions: base, traces: null };
  if (hasCursorTranscripts(base)) return { kind: 'cursor', sessions: base, traces: null }; // 同样要抢在 hasClaudeJsonl 前
  if (hasClaudeJsonl(base)) return { kind: 'claude', sessions: base, traces: null };
  if (path.basename(base).toLowerCase() === 'projects') return { kind: 'claude', sessions: base, traces: null };
  // 用户手工添加时很可能**直接填 sessions 目录**（本机那条历史配置就是这么填的）。
  // 这一支同样要抢在 atomcode 前面，否则手工加 dsh 会静默变成 0 条 —— 与 kimi 踩过的坑同源。
  if (path.basename(base).toLowerCase() === 'sessions' && hasDshSessions(base)) return { kind: 'dsh', sessions: base, traces: null };
  if (path.basename(base).toLowerCase() === 'sessions') return { kind: 'atomcode', sessions: base, traces: null };
  if (path.basename(base).toLowerCase() === 'logs' && hasCodeartsLogs(base)) return { kind: 'codearts', sessions: base, traces: null };
  return null;
}

export { candidateBases, probeBases, kimiDesktopSessionsRoots, basesFor };

// genie 扩展（VSCode / CodeBuddyIDE / JetBrains 与 CodeBuddy CN 应用共用）的数据目录名。
// 它**不是**一个独立 agent：会话并到 `codebuddy` 那一个 agent 名下（两份落盘是同一产品的不同形态，
// 用户心智里那就是一个 CodeBuddy；并源的那段理由见主文件 discoverAgents 里的注释）。
// 所以它不进 NAME_ALIASES（否则自动发现会再注册出一行 codebuddy-ext），只给下面这个函数用 ——
// 主文件每轮拿它算出「该挂到 codebuddy.sessionsExtra 上的根」。
const BUDDY_EXT_DIRNAMES = ['CodeBuddyExtension'];
export function buddyExtDataRoots() {
  const out = [];
  for (const base of basesFor(BUDDY_EXT_DIRNAMES)) {
    const r = buddyExtRoot(base);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

// 「codebuddy 的扩展根为什么没挂上」——一句能直接抄进病历的话（探到了就回空串，调用方据此不写）。
// 三个候选根（~/、%APPDATA%、%LOCALAPPDATA%）在没装扩展的机器上**全都**不存在，那种情况合并成一句：
// 三行「目录不存在」会把真正有用的那行（目录在、结构不对）淹掉。
// c（可选，同 basesFor 的平台上下文）是给测试用的：不传就是当前这台机器。
export function buddyExtMissingWhy(c) {
  const bases = basesFor(BUDDY_EXT_DIRNAMES, c);
  if (bases.some(b => buddyExtRoot(b))) return '';      // 探到了就不解释
  const present = [...new Set(bases.filter(b => isDir(b)))];   // 去重：APPDATA 与 LOCALAPPDATA 被指到同一个目录时别说两遍
  if (present.length) return present.map(b => b + ' —— ' + buddyExtWhyMissing(b)).join('；');
  return '这台机器没有 CodeBuddyExtension 目录（候选：' + bases.join('、') + '）—— 没装 genie 扩展，或它的数据根被挪走了';
}

// re-export 让 sniffBase 能直接用 hasMavisSession（定义在 parsers/minimax.mjs）：
// 不在头部 import 是为避开「discovery 静态 import minimax.mjs → 服务启动必须先解析 minimax.mjs」
// 的耦合；minimax.mjs 现在只 import shared.mjs，本身已是轻量模块，import 进来即可。
export { hasMavisSession } from './minimax.mjs';
