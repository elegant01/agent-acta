// ---------------- claude 解析器（~/.claude/projects/<slug>/*.jsonl） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanClaude / claudeEntryContent +
// claudeUserText / claudeIsToolResultOnly / claudeIsCommandText（详情与扫描共用同一套口径函数）。
// 逐行增量解析 transcript：user 文本消息开新 turn，assistant 累加 usage/tools
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, modelName, modelList, windowOf, markKind, listDirCached, isDir, trunc, readCompleteLines } from './shared.mjs';

export function claudeUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.filter(b => b && b.type === 'text').map(b => b.text || '');
    return texts.join('\n');
  }
  return '';
}
export function claudeIsToolResultOnly(content) {
  return Array.isArray(content) && content.length > 0 && content.every(b => b && (b.type === 'tool_result'));
}
// /clear、!命令 等命令消息不是 LLM 请求，不产生 turn（扫描与详情两处必须同一口径，否则轮次对不上）
export function claudeIsCommandText(text0) {
  const t = String(text0).trimStart();
  return t.startsWith('<command-name>') || t.startsWith('<local-command');
}

export function claudeIdBase(fp) { return 'c#' + fp.replace(/[\\/:]/g, '~') + '#'; }
// qoder-cn 专属字段（claude 转录里没有，别家解析出的条目也不该带）：
//   credits / ctxRatio —— 来自 message.usage（qoder 的 token 全 0，真实用量只有积分和上下文占比）。
// 压缩画像（compacts / compPre / compPost / compDrop / compMs / compAuto / compManual）**不是**
// qoder 专属：源头是 compact_boundary 系统行，claude 与 qoder 都有（I12，见下方 scanClaude）。
function emitClaudeTurns(agent, fp, slug, data, fromIdx) {
  const isQoder = agent === 'qoder' || agent === 'qoder-cn';
  const idBase = claudeIdBase(fp);
  // I16 子 agent 拓扑：`data.link` 是**这一份转录自己的谱系**（主转录为 null = 根会话；
  // `subagents/agent-*.jsonl` 那些带 parent/depth/label，见 scanClaudeSub）。
  // 源头给的是显式字段（目录层级 + .meta.json 的 spawnDepth / description），不是按时间区间猜的。
  const link = data.link || null;
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const total = t.tin + t.tout + t.tcache;
    addEntry(idBase + t.idx, {
      // 子转录的项目**跟父走**（link.project，见 claudeParentProject）：它自己的 cwd 常是父项目的
      // 子目录，照抄会让父子落到两个 projectKey、认父失败。拿不到父项目时才退回自己的 cwd。
      agent, project: (link && link.project) || data.cwd || slug, session: path.basename(fp, '.jsonl'),
      // 谱系三件套。根会话为 undefined ⇒ JSON 丢键，页面按「根」处理，不编层级。
      parent: link ? link.parent : undefined,
      depth: link ? link.depth : undefined,
      sub: link ? link.label : undefined,
      // I14 会话命名：会话列表里这些会话以前全是裸 UUID，而名字**源头一直有** —— 就是产品自己
      // 写的 ai-title（见下 scanClaude 里的落点）。name 落在每一轮上，会话列表（sessionsAgg）
      // 取「任一轮有值即可」，所以 ai-title 出现在文件哪儿都不影响。
      // 次级兜底是 last-prompt（用户最后一句原话）：qoder-cn 实测**只有它、没有 ai-title**。
      name: data.title || data.lastPrompt || null,
      time: t.time, dur: Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total,
      // ctx = 窗口容量：转录里没有这个字段，按模型名查 CTX_WINDOWS 表，认不出就是 0
      // （页面此时只显示占用、不画进度条 —— 见页面对 ctxUsed 的兜底）。
      // ctxUsed = 这一轮结束时的实际占用（轮内**最后一次**调用的 prompt 全量，非累加）。
      ctx: windowOf(t.models), ctxUsed: t.ctxUsed || null,
      rounds: t.calls, tools: t.tools, calls: t.calls, // claude: rounds=calls=轮内 assistant 消息数
      // models 在这里再过一遍 modelList：持久化状态里可能存的是首次扫描时映射表尚未建立
      // 而烤进去的原始 key（如 qoder 的 q37fmodel），恢复路径直接重放会显示假模型名。
      // 存原始 key 反而更好（保留源信息），这里用当前映射表纠正即可。
      models: modelList(t.models), preview: t.preview,
      // I15 工作指纹（2026-09-23）：branch（git 分支）/ permMode（权限模式）/ cliVer（产品版本）。
      // 只有 claude 源有这三样（见 scanClaude 里 curBranch / curVer / curPerm 三个游标）；
      // qoder / qoder-cn 走同一个解析器但转录里没有这些字段 → undefined → JSON 序列化自动丢掉，
      // 页面按「无此维度」如实为空、不印 0（与 qoder「无 token 就不印 0」同一条约定）。
      branch: t.branch, permMode: t.permMode, cliVer: t.cliVer,
      // R19：claude 的转录没有「轮结束」标志（被打断就是戛然而止），服务端只能推算 ——
      // 后面还有轮 = 这一轮确定结束了；最后一轮收不了口，由页面按最后活动时间兜底。
      finished: i < data.turns.length - 1,
      aborted: !!t.aborted, // 用户中断（"[Request interrupted by user]"），与 status:'error' 独立
      // I17 非 LLM 时间分解（2026-09-24）：rdur = 产品在轮末自报的 turn_duration.durationMs，
      // 是这一轮的**真实工作时间**（剔除用户离开/隔夜的 idle gap）。与墙钟 dur（首条→末条
      // 时间差）并存，页面给「墙钟 / 实际」两列并说明差额来源 —— 不直接用 rdur 替换 dur，
      // 那会改变 status/排序/告警的既有语义。只有 claude 转录有 turn_duration：
      // qoder / qoder-cn 走同一解析器但没有该事件 → rdur 保持 undefined → JSON 序列化自动丢掉
      //（与 branch 同一条约定）。轮进行中（文件尾还没发 turn_duration）同样为 undefined。
      rdur: t.rdur || undefined, rdurMsg: t.rdurMsg || undefined,
      toolNames: t.toolNames || {},
      // 仅 qoder 落这两个字段：页面据此把「积分 / 上下文占比」替进卡片
      //（qoder 的 token 恒为 0，按原样渲染会是一排假 0）。
      ...(isQoder ? { credits: t.credits || 0, ctxRatio: t.ctxRatio || 0 } : {}),
      // I12 上下文压缩画像（2026-09-28）：**不再只在 qoder 分支里** —— 源头（compact_boundary）
      // claude 与 qoder 都有，scanClaude 一直无条件解析，只是以前被上面的 isQoder 守卫丢掉了。
      //   compDrop（**本轮**丢弃 token，= 本轮各次压缩的会话累计增量之和）只有 claude 源有 ⇒
      //   缺席时落 undefined、JSON 自动丢，
      //   页面据「有没有这一位」决定说不说，绝不印一个假 0（qoder 会被读成「压了却没丢 token」）；
      //   compMs（压缩等待）/ compAuto / compManual（自动 / 手动计数）两家都有。
      compacts: t.compacts || 0, compPre: t.compPre || 0, compPost: t.compPost || 0,
      compDrop: t.compDrop ?? undefined, compMs: t.compMs ?? undefined,
      compAuto: t.compAuto || 0, compManual: t.compManual || 0,
    }, { file: fp, turn: t.idx, kind: 'claude' });
  }
}

// onlyFile：分片首扫用 —— 本次只处理这一个文件，让首扫能按「一个会话文件」为粒度让出事件循环。
// 不传（同步扫描）时行为和以前完全一样；listDirCached 有缓存，反复调用不额外读盘。
export function scanClaude(agent, root, onlyFile) {
  const slugs = listDirCached(root);
  if (!slugs) return;
  // onlySlug 提前算好并**排在 isDir 之前**：分片时每次只处理一个文件，而这个循环是「所有 slug × 每次调用」，
  // 把 isDir（一次 statSync）留在前面会让 stat 次数变成 slug 数 × 文件数（本机 workbuddy 34×59 ≈ 2000 次，
  // 白白多花 ~0.2s）。path.relative 是纯字符串运算，放在最前面就能把这一坨整个省掉。
  // ⚠️ I16 改的是**判据粒度**（原为 dir 全等，现在只比 slug）：子转录在
  // <root>/<slug>/<会话>/subagents/ 下，它的 dirname 不是 <root>/<slug>，用 dir 全等会把这一整批
  // 从分片首扫里整段跳过（同步扫描看不到这个问题，只有首扫分片路径会漏）。
  const onlySlug = onlyFile ? path.relative(root, onlyFile).split(path.sep)[0] : null;
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    if (onlySlug && slug !== onlySlug) continue; // 不是这个项目目录，整段跳过
    if (!isDir(dir)) continue;
    const names = listDirCached(dir);
    if (!names) continue;
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const fp = path.join(dir, n);
      if (onlyFile && fp !== onlyFile) continue;
      scanClaudeFile(agent, fp, slug, null);
    }
    // I16 子 agent 拓扑：claude 把子 agent 的转录写在**会话目录下面的 subagents/ 子目录**里
    //   ~/.claude/projects/<slug>/<父会话 uuid>/subagents/agent-<id>.jsonl（本机实测 27 份）。
    // 以前这一层**整个没扫**（只读 <slug>/*.jsonl），所以子 agent 的轮次在面板上完全不存在。
    // 谱系是源头写死的三层：① 目录层级（subagents/ 的父目录名 = 父会话 uuid）；
    // ② 转录自己的 sessionId 字段（= 父会话 uuid，与父转录的 session 值同形，能直接对上）；
    // ③ 同目录的 <同名>.meta.json（agentType / description / spawnDepth）—— 子 agent 是干嘛的。
    // 不靠时间区间推、不猜：三条都是显式字段。
    for (const sess of listDirCached(dir) || []) {
      const subDir = path.join(dir, sess, 'subagents');
      const subNames = listDirCached(subDir);
      if (!subNames) continue;
      for (const sn of subNames) {
        if (!sn.endsWith('.jsonl')) continue;
        const fp = path.join(subDir, sn);
        if (onlyFile && fp !== onlyFile) continue;
        // parentFp 是给「子转录继承父会话的项目」用的，见 claudeParentProject
        scanClaudeFile(agent, fp, slug, { dir: subDir, parentSess: sess, parentFp: path.join(dir, sess + '.jsonl') });
      }
    }
  }
}

// I16：子 agent 转录旁边的那份 `<同名>.meta.json`。它是**唯一**能回答「这个子 agent 是干嘛的」的地方：
//   {"agentType":"Explore","description":"Find docs referencing data dir","toolUseId":"…","spawnDepth":1}
// 读不出来（没有 / 坏 JSON）就如实返回空 —— 谱系本身仍由目录层级给出，不因为缺这份文件而丢掉父子关系。
// 名字有上限：description 可能是一整句派活原文，截到 80 字随条目下发（与 preview 同一条「够看就行」约定）。
const claudeSubMetaCache = new Map();   // fp -> {m, v}
function claudeSubMeta(dir, base) {
  const fp = path.join(dir, base + '.meta.json');
  let st; try { st = fs.statSync(fp); } catch { return {}; }
  const hit = claudeSubMetaCache.get(fp);
  if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit.v;
  let v = {};
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const desc = String(j.description || '').replace(/\s+/g, ' ').trim();
    v = {
      agentType: j.agentType ? String(j.agentType) : '',
      label: desc ? desc.slice(0, 80) : '',
      spawnDepth: Number(j.spawnDepth) > 0 ? Number(j.spawnDepth) : 0,
    };
  } catch { /* 坏 JSON：只丢描述，父子关系照旧由目录给出 */ }
  if (claudeSubMetaCache.size > 256) claudeSubMetaCache.clear();
  claudeSubMetaCache.set(fp, { m: st.mtimeMs, s: st.size, v });
  return v;
}

// I16：子转录要继承**父会话的项目**，不能照抄自己的 cwd。
// 为什么：claude 子 agent 的 cwd 常是父项目的**子目录**（本机实测 `F:\centos\agentLog\agent-acta`、
// `…\agent-log-plugin\agent-log-hook`），而 project 会被归一化成 projectKey；两边一旦不同，服务端
// 按 (agent, projectKey, key) 认父就查不到（agent-acta-server.mjs 的 sessionsAgg），这批子会话
// 就如实降级成根 —— 树断掉、父行少一截合计（2026-09-28 实测 27 份里丢 10 份）。
// 父的 cwd 取两条路，**都不依赖扫描顺序**：① 本进程已扫过这个父（内存态，热启动走这条）；
//    ② 直接读父转录开头找第一条带 cwd 的行 —— 首扫分片下 `subagents/` 排在 `<会话>.jsonl` 前面
//       （sliceFiles 先推目录项、再推它下面的子文件），内存态这时往往还没有。
// 两条都拿不到（父转录不在盘上）→ 返回空，调用方如实退回自己的 cwd，不编一个项目出来。
const claudeCwdCache = new Map();   // parentFp -> cwd
function claudeParentProject(fp) {
  const st = files.get(fp);
  if (st?.data?.cwd) return st.data.cwd;
  if (claudeCwdCache.has(fp)) return claudeCwdCache.get(fp);
  let v = '';
  try {
    const fst = fs.statSync(fp);
    const rd = readCompleteLines(fp, 0, Math.min(fst.size, 262144));
    for (const line of (rd ? rd.lines : [])) {
      if (!line.includes('"cwd"')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.cwd) { v = String(j.cwd); break; }
    }
  } catch { /* 父转录读不动：如实留空 */ }
  if (claudeCwdCache.size > 256) claudeCwdCache.clear();
  claudeCwdCache.set(fp, v);
  return v;
}

// 读一份 claude 转录（主转录或 subagents/*.jsonl）。sub 非空 = 这是子 agent 转录，带谱系上下文。
export function scanClaudeFile(agent, fp, slug, sub) {
  let fst; try { fst = fs.statSync(fp); } catch { return; }
  const key = fp, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  if (prev && prev.m === m && prev.s === s) {
    // 重启后 entries 为空但 files 状态被恢复：从状态直接重建条目，不重扫文件
    if (prev.data?.turns?.length && !entries.has(claudeIdBase(fp) + (prev.data.turns.length - 1))) emitClaudeTurns(agent, fp, slug, prev.data, 0);
    return;
  }
  const off = prev?.off || 0;
  // title / lastPrompt 是 I14 加的会话名（老 state 没有这两个键，undefined 即「还没读到」）
  // curBranch / curVer / curPerm 是 I15 加的工作指纹游标（git 分支 / 产品版本 / 权限模式）：
  // 行是顺序读的，游标 = 「到当前行为止最后一次声明」，开轮时快照进轮、行尾回写当前轮 ——
  // 这样轮内取到的永远是**最后一次声明**（会话中途切分支/切权限，后面的才是当前值）。
  const data = prev?.data || { cwd: '', title: '', lastPrompt: '', turns: [], emitted: 0, lastCum: 0 };
  // I16：谱系只认**子转录**这一层（主转录 link = null = 根会话）。link 随 index 一起落，
  // 老 index 没有 link ⇒ 恢复出来就是根会话 —— 与「老会话本来也没扫过子转录」自洽。
  if (sub) {
    const meta = claudeSubMeta(sub.dir, path.basename(fp, '.jsonl'));
    data.link = {
      parent: sub.parentSess,
      depth: meta.spawnDepth > 0 ? meta.spawnDepth : 1,
      label: meta.label,
      // 继承父项目的 cwd（拿不到则空串，emitClaudeTurns 退回自己的 cwd）
      project: sub.parentFp ? claudeParentProject(sub.parentFp) : '',
      agentType: meta.agentType,
    };
  }
  if (s <= off) { files.set(key, { agent, kind: 'claude', m, s, off, data }); markKind('claude'); return; }
  try {
    const rd = readCompleteLines(fp, off, s);
    if (!rd) { files.set(key, { agent, kind: 'claude', m, s, off, data }); markKind('claude'); return; } // 尚无完整行
    const newOff = rd.newOff;
    for (const line of rd.lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.cwd && !data.cwd) data.cwd = j.cwd;
      // I15 工作指纹游标（2026-09-23）：git 分支 / 产品版本 / 权限模式。
      //   gitBranch / version 在**几乎所有顶层行**上（user / assistant / attachment / system…）；
      //   permissionMode 在 permission-mode 行（**无时间戳**，现有分支都不处理它，正好在此层收下）
      //   与部分 user 行上。统一在这层更新游标：行是顺序读的，先声明、后续行覆盖，
      //   最后一行 = 到当前为止的**最后一次声明**。轮内取最后一条（会话中途切分支/切权限，
      //   后面的才是当前值）。qoder 转录没有这些字段 → 游标保持 undefined → 如实无此维度。
      if (j.gitBranch) data.curBranch = String(j.gitBranch);
      if (j.version) data.curVer = String(j.version);
      if (j.permissionMode) data.curPerm = String(j.permissionMode);
      // I14 会话命名：**产品自己起的标题**，源头一直有、只是以前没读 —— 会话列表里这 100 多个
      // claude 会话以前全是裸 UUID（见 agent-log-ideas.md 的 I14）。
      //   ai-title（本机 3718 条，{"aiTitle":"ZCode 日志数据源适配"}）是首选，质量就是给人看的会话名；
      //   last-prompt（3737 条，用户最后一句原话）是次级兜底 —— qoder-cn 实测**只有它、没有 ai-title**。
      // 两者都取**最后一条**：会话进行中产品会重写标题，后面的才是当前的。
      // 这两行没有 timestamp，必须在下面取 ts 之前处理（它们不开轮、不进 lastTs）。
      if (j.type === 'ai-title' && j.aiTitle) {
        const s = String(j.aiTitle).replace(/\s+/g, ' ').trim();
        if (s) data.title = s.slice(0, 60);
      } else if (j.type === 'last-prompt' && j.lastPrompt) {
        const s = String(j.lastPrompt).replace(/\s+/g, ' ').trim();
        if (s) data.lastPrompt = s.slice(0, 60);
      }
      const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
      if (j.type === 'user') {
        const content = j.message?.content;
        if (claudeIsToolResultOnly(content)) continue; // 工具结果不开新轮
        const text0 = claudeUserText(content);
        if (!text0) continue;
        if (claudeIsCommandText(text0)) continue; // 命令消息不算请求
        // 用户中断（Esc）：转录里是一条 user 角色的 "[Request interrupted by user…]"，
        // 它不是真实请求，但按「开卡标特殊状态」口径保留记录 —— aborted=true，页面灰显「已打断」。
        const interrupted = /^\[Request interrupted by user( for tool use)?\]$/.test(text0.trim());
        data.turns.push({
          idx: data.turns.length, time: ts, lastTs: ts,
          tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, ctxUsed: 0,
          credits: 0, ctxRatio: 0, // qoder 专属，见 emitClaudeTurns
          // I12 压缩画像：compacts / compPre / compPost 三家通用；compDrop / compMs 缺席保持
          // null（源里没有这一位 ⇒ 不冒充 0），compAuto / compManual 是 trigger 的逐条计数。
          compacts: 0, compPre: 0, compPost: 0, compDrop: null, compMs: null, compAuto: 0, compManual: 0,
          models: [], mids: [], err: false, aborted: interrupted,
          // I15：开轮时快照工作指纹游标（当前行已在上面更新过游标，快照即「本轮第一行的声明」；
          // 之后每行行尾回写覆盖，最终 = 轮内最后一次声明）。
          branch: data.curBranch, cliVer: data.curVer, permMode: data.curPerm,
          preview: text0.replace(/\s+/g, ' ').slice(0, 300),
          toolNames: {}, // R20：工具名去重计数（toolNameCounts 说的第二形态：逐行扫到就累计）
        });
      } else if (j.type === 'system' && j.subtype === 'compact_boundary' && data.turns.length) {
        // 上下文压缩事件。这里**无条件**解析并累计到轮状态（claude 与 qoder 都会走到）。
        // ⚠️ 2026-09-23 更正：本行原注释写「claude 转录没有这个 subtype」——**错的**。
        //    本机实测 ~/.claude/projects 下有 39 条 compact_boundary（trigger auto/manual、
        //    preTokens/postTokens、durationMs、cumulativeDroppedTokens 齐全）。
        //    I12（2026-09-28）已把 emit 侧的 isQoder 守卫松开，落盘 turns 口径随之 bump 到 11。
        const cur = data.turns[data.turns.length - 1];
        const cm = j.compactMetadata || {};
        cur.compacts++;
        cur.compPre = cm.preTokens || 0;
        cur.compPost = cm.postTokens || 0;
        // I12 上下文压缩画像：把「压掉多少 / 等了多久 / 自动还是手动」也落下来。
        //   compMs = durationMs（这次压缩的等待时长，claude 与 qoder 都有），按轮累加 —— 它本就是
        //   逐事件的量，累加=「这轮一共等了多久」；
        //   compDrop **只有 claude 源有**：源里的 `cumulativeDroppedTokens` 是**会话累计**（每压一次
        //   往上叠，本机实测增量恰等于该次 pre − post），**不是**这次丢的量。所以按轮累加的是
        //   「相邻事件累计值的增量」= 本轮真正丢掉的 token 数（一轮可能压不止一次才累加）。
        //   ⚠️ 2026-09-28 修正：原写法直接把累计值逐条相加，于是每轮显示的是「到该轮为止的会话
        //   运行总量」，会话小结再把逐轮值求和 ⇒ 约虚高 (k+1)/2 倍（本机 5 次压缩的会话
        //   777,858 被读成 2,332,127，约 3×）。已在同一次未发版的 I12 内修正并 bump 到 12。
        //   ⚠️ 缺席 ≠ 0：源里没有这一位就保持 null（emit 时落 undefined），
        //   否则 qoder 会被读成「压过、却一个 token 都没丢」。
        if (typeof cm.cumulativeDroppedTokens === 'number') {
          cur.compDrop = (cur.compDrop || 0) + (cm.cumulativeDroppedTokens - (data.lastCum || 0));
          data.lastCum = cm.cumulativeDroppedTokens;
        }
        if (typeof cm.durationMs === 'number') cur.compMs = (cur.compMs || 0) + cm.durationMs;
        // trigger 逐条计数：页面要说清「自动压缩」还是「用户手动压的」；
        // 认不出的取值两边都不计 —— 宁可少说，也不替源编一个。
        if (cm.trigger === 'manual') cur.compManual++;
        else if (cm.trigger === 'auto') cur.compAuto++;
      } else if (j.type === 'system' && j.subtype === 'turn_duration' && data.turns.length) {
        // I17 非 LLM 时间分解（2026-09-24）：产品在**每轮结束**时发 system/turn_duration，
        // 自报 durationMs = 这一轮的**真实工作时间**（产品侧主动测量，剔除用户离开/隔夜的
        // idle gap），messageCount = 本轮消息数。事件落点 = 轮末 ⇒ 记到当前打开的那一轮，
        // 与 compact_boundary 同一条挂载逻辑（轮进行中读到的是上一轮的 turn_duration，
        // 下一轮 user 消息还没发，所以挂在当前轮正好对上）。墙钟 dur 不动，rdur 并存。
        const cur = data.turns[data.turns.length - 1];
        cur.rdur = j.durationMs || 0;
        cur.rdurMsg = j.messageCount || 0;
      } else if (j.type === 'assistant' && data.turns.length) {
        const cur = data.turns[data.turns.length - 1];
        // 同一 message.id 可能因续写出现多行，去重避免 token 翻倍。
        // 但 tool_use 是独立调用，不能因为 mid 重复就跳过整条消息：qoder-cn 在同一轮内所有 assistant 消息共享同一个 id，
        // 若直接 continue 会把后续含 tool_use 的消息全部丢弃 → tools=0。
        // 处理：mid 命中去重时只跳过 usage/calls/models（token 口径需要去重），tool_use 与时间戳照常累计。
        const mid = j.message?.id;
        let seenMid = false;
        if (mid) {
          if ((seenMid = cur.mids.includes(mid))) { /* duplicate – skip token fields */ }
          else cur.mids.push(mid);
        }
        if (!seenMid) {
          const u = j.message?.usage || {};
          cur.tin += u.input_tokens || 0;
          cur.tout += u.output_tokens || 0;
          cur.tcache += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const ctxNow = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (ctxNow > 0) cur.ctxUsed = ctxNow;
          cur.calls++;
          const model = j.message?.model;
          const mn = modelName(model);
          if (mn && !cur.models.includes(mn)) cur.models.push(mn);
        }
        // qoder：token 全 0，真实用量在 credits（每次调用计费额）与 context_usage_ratio。
        // 必须放在 mid 去重**之外**：qoder 同轮所有 assistant 消息共享同一个 id（见上方去重注释），
        // 放进 seenMid 守卫里的话一轮只累计到第一次调用。claude 没有这两个字段（|| 0 无副作用），
        // 其续写重复行即使带 usage 也不含 credits，不会重复计费。
        {
          const u = j.message?.usage || {};
          cur.credits += u.credits || 0;
          if (u.context_usage_ratio > 0) cur.ctxRatio = u.context_usage_ratio;
        }
        const blocks = j.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (!b || b.type !== 'tool_use') continue;
            cur.tools++;
            const nm = typeof b.name === 'string' && b.name ? b.name : '?';
            cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
          }
        }
        if (j.isApiErrorMessage) cur.err = true;
        if (ts) cur.lastTs = ts;
      }
      // I15：行尾把工作指纹游标回写到**当前轮**（若已开轮）—— 声明在开轮之后的行
      // （permission-mode 无时间戳、可能落在 user 行之后；assistant 行也带 gitBranch/version）
      // 也要让当前轮看到，保证「轮内最后一次声明」成立。快照与回写都做，游标本身也持久化。
      if (data.turns.length) {
        const curT = data.turns[data.turns.length - 1];
        curT.branch = data.curBranch; curT.cliVer = data.curVer; curT.permMode = data.curPerm;
      }
    }
    files.set(key, { agent, kind: 'claude', m, s, off: newOff, data });
    markKind('claude');
    // 从最后一个已发轮起重发（进行中的轮会被原地更新）
    emitClaudeTurns(agent, fp, slug, data, Math.max(0, data.emitted - 1));
    data.emitted = data.turns.length;
  } catch {}
}

// 详情：重读转录按 src.turn 过滤。开轮判定与扫描侧走同一套谓词（claudeUserText /
// claudeIsToolResultOnly / claudeIsCommandText），不会一边跳过命令消息、另一边把它算成一轮。
export function claudeEntryContent(src, full) {
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null;
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  let turnIdx = -1, prevTs = 0;
  const out = { user: '', assistant: '', tools: [], calls: [], v: version };
  // 一次 API 响应（一个 message.id）在转录里**不是一个记录**：更常见的是一种区块一条记录，
  // 每条都带同一份 usage。实测一份本机会话：33 个 mid 里，[thinking] 一条、每个 [tool_use]
  // 各一条，于是「正文/工具块不在首条上」是常态而不是例外（15 份样本里 694 个带正文的 mid，
  // 687 个的正文不在首条上）。
  //   → 所以按 mid **归并**：调用只计一次（取首条，它带 usage 与耗时基准），区块全部收下。
  // 旧写法是「见过这个 mid 就 continue」，等于只认首条：症状是详情里「AI 输出」与
  // 「工具调用」整块空掉（calls 却照常显示，因为调用正是在首条上记的），看着像解析器没接上。
  const callByMid = new Map();   // mid -> 这一行明细（同时用于把正文回填到对应调用）
  const textByMid = new Map();   // mid -> 这次调用自己产出的正文
  const toolIds = new Set();     // tool_use 的 id：同一块被写进多条记录时不去重就是重复的工具行
  const texts = [];
  let anon = 0;                  // 没有 message.id 的记录：各算各的，别互相吞
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'user') {
      const content = j.message?.content;
      // 工具结果按 tool_use_id 精确回填到对应工具（并行调用时不再错位；无 id 时退回第一个空 output）
      if (claudeIsToolResultOnly(content)) {
        if (turnIdx === src.turn) {
          if (j.timestamp) prevTs = Date.parse(j.timestamp) || prevTs;
          // I13：超时 / 软失败的结构化标志在**记录级**的 `toolUseResult` 上，不在 tool_result 块里。
          // 要害是超时那一批 `is_error` 是**显式 false**（本机实测 30 条全是，不是缺键）⇒ 只看
          // `is_error` 会把它读成"这一跑没问题"。不读这一层，超时在失败画像里就是不可见的。
          const tur = j.toolUseResult && typeof j.toolUseResult === 'object' ? j.toolUseResult : null;
          for (const b of content) {
            const t = (b.tool_use_id && out.tools.find(x => x.tid === b.tool_use_id)) || out.tools.find(x => !x.output);
            if (t) {
              const c = b.content;
              const fo = {};
              t.output = trunc(c, full, fo);   // 内容块的拆解统一交给 toText()，这里不再各写一份
              t.outputTrunc = !!fo.t;
              if (b.is_error) t.error = 'error';
              // 只搬**结构化**的那几位，一个字正文都不扫：超时是产品给的档位数值，软失败是产品给的
              // 判定串。这两者都**不并进** `error` —— 尤其软失败（`No matches found` = rg 没搜到）是
              // 正常结果，并进去就是把最常见的正常结果读成故障。
              if (tur) {
                if (tur.timedOutAfterMs != null) t.timeout = tur.timedOutAfterMs;
                if (tur.returnCodeInterpretation != null) t.soft = tur.returnCodeInterpretation;
                else if (tur.staleRecovered != null) t.soft = 'staleRecovered';
              }
            }
          }
        }
        continue;
      }
      const text0 = claudeUserText(content);
      if (!text0) continue;
      if (claudeIsCommandText(text0)) continue; // 与 scanClaude 同口径跳过命令消息
      turnIdx++;
      if (turnIdx === src.turn) { out.user = text0; prevTs = j.timestamp ? Date.parse(j.timestamp) : 0; }
      continue;
    }
    if (j.type === 'assistant' && turnIdx === src.turn) {
      const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
      const mid = j.message?.id || ('#' + (anon++));
      // 每次 LLM 调用只记一次：usage 与耗时基准取首条（较新的记录里 usage 各条相同，
      // 耗时仍是「首条时间 − 上一事件」，不能随第 N 条记录往后挪）
      let call = callByMid.get(mid);
      if (!call) {
        const u = j.message?.usage || {};
        call = {
          model: j.message?.model || '',
          tin: u.input_tokens || 0, tout: u.output_tokens || 0,
          tcache: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          dur: ts && prevTs ? Math.max(0, ts - prevTs) : 0,
        };
        callByMid.set(mid, call);
        out.calls.push(call);
        if (ts) prevTs = ts;
      }
      const blocks = j.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          texts.push(b.text);
          // 这次调用自己说了什么（而不是整轮拼起来的那坨）——「LLM 调用明细」展开就看这段
          const seg = String(b.text);
          textByMid.set(mid, textByMid.has(mid) ? textByMid.get(mid) + '\n' + seg : seg);
        } else if (b.type === 'tool_use') {
          if (b.id && toolIds.has(b.id)) continue;   // 同一块被重复写进多条记录
          if (b.id) toolIds.add(b.id);
          // 这次调用发起了哪些工具。没有工具的那几次不建空数组 ——
          // 否则每条明细都多一个 "tools":[] 白占带宽。
          const tname = b.name || '?';
          if (call.tools) call.tools.push(tname);
          else call.tools = [tname];
          const fi = {};
          out.tools.push({ name: b.name || '?', tid: b.id || null, input: trunc(JSON.stringify(b.input ?? ''), full, fi), inputTrunc: !!fi.t, output: '', error: null });
        }
      }
    }
    if (turnIdx > src.turn) break;
  }
  // 正文回填放在循环外：同一次响应的正文可能落在**任意一条**记录上（687/694 不在首条），
  // 边读边挂的话，只有「正文恰好与 usage 同条」的那 1% 能挂上。
  for (const [mid, call] of callByMid) {
    const seg = textByMid.get(mid);
    if (!seg) continue;
    const ft = {};
    call.text = trunc(seg, full, ft); call.textTrunc = !!ft.t;
  }
  out.assistant = texts.join('\n');
  return out;
}
