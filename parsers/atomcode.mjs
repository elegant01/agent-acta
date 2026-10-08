// ---------------- atomcode 解析器（sessions/<hash>/*.meta + *.jsonl） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出：
//   expandMeta      —— .meta 轮次 → 条目（scanAtomcodeDir 与分片首扫共用）
//   scanAtomcodeDir —— 一个 hash 会话目录：*.jsonl 逐行增量（轮时间戳/预览）+ *.meta 全量
//   atomcodeDirs    —— hash 会话目录列表
//   atomcodeEntryContent —— 单轮详情（重读 .jsonl 取正文/工具；逐次调用来自 datalog）
//   datalogCalls / datalogDir —— 逐次 LLM 调用明细（数据源，atomcodeEntryContent 内部调用）
import fs from 'node:fs';
import path from 'node:path';
import { HOME, files, addEntry, modelList, markKind, listDirCached, isDir, trunc, readCompleteLines } from './shared.mjs';

export function sumModel(ts, key) { return (ts.model_usage || []).reduce((a, m) => a + (m.tokens?.[key] || 0), 0); }

// ---------------- atomcode datalog（config.toml 的 [datalog]：逐次 LLM 调用明细） ----------------
// atomcode 的「逐次请求」明细**不在** sessions/ 里：`.meta` 的 `turn_stats[].model_usage` 是
// **轮 × 模型**的聚合（一轮里跑 80 次调用也只留一行），拆不开。真正的逐次记录在 `config.toml`
// 的 `[datalog]` 段指向的独立目录里：每个 turn 一对
//   `<时间戳>-<会话uuid>-t<轮号>-p<pid>-i<实例>.{md,jsonl}`
// `.md` 里每个 round 一段 `### Turn N`，带**真实**的 `_[tokens: prompt=…+completion=…, cache=…tok]_`。
//
// 三个必须守住的约束：
//  1. **只读 .md**。本机实测那目录 16GB，其中 11GB 是 .jsonl（完整请求体），.md 只有 85MB。
//  2. **只取数字**。.md 里有原始 prompt、推理全文、工具出入参——一个字节都不往这里带。
//  3. **拿不到不算错**。datalog 默认关闭（`enabled=false` 时目录根本不存在），用户没开就返回空数组。
//     旧命名（`2026-05-26_15-57-41.md`，名字里没有 uuid）挂不到具体某一轮上，只能放弃——
//     本机 3233 轮里能精确对上的 1013 轮，所以 UI 必须容忍「有的轮有明细、有的没有」。

// config.toml 里 [datalog] 的 dir，30s 缓存。**必须读配置**：本机就落在 E: 盘（不在 ~/.atomcode 下），
// 硬猜默认路径在这台机器上会一条都读不到。没有 config.toml / 解析不了 → 退回默认位置试一下。
let dlCfg = { at: 0, dir: null };
export function datalogDir() {
  if (dlCfg.dir !== null && Date.now() - dlCfg.at < 30000) return dlCfg.dir || null;
  const home = path.join(HOME, '.atomcode');
  const fallback = path.join(home, 'datalog');
  let dir = fallback;
  try {
    const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    let inSec = false, enabled = null, raw = '';
    for (const line0 of text.split('\n')) {
      const line = line0.trim();
      if (line.startsWith('[')) { inSec = line.replace(/\s/g, '') === '[datalog]'; continue; }
      if (!inSec || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (v[0] === '"' || v[0] === "'") { const q = v[0], e = v.indexOf(q, 1); v = e > 0 ? v.slice(1, e) : v.slice(1); }
      else { const h = v.indexOf('#'); if (h >= 0) v = v.slice(0, h); v = v.trim(); }
      if (m[1] === 'enabled') enabled = v !== 'false';
      if (m[1] === 'dir') raw = v;
    }
    if (enabled === false) { dlCfg = { at: Date.now(), dir: '' }; return null; }   // 显式关掉 → 不读
    if (raw) {
      // 支持 ~ 与绝对路径；相对路径按 cwd 解析（这里没有可靠的 cwd）→ 不猜，退回默认位置
      if (raw === '~') dir = HOME;
      else if (/^[~][\\/]/.test(raw)) dir = path.join(HOME, raw.slice(2));
      else if (path.isAbsolute(raw)) dir = raw;
    }
  } catch { /* 没有 config.toml：按默认位置试 */ }
  try { if (!fs.statSync(dir).isDirectory()) dir = ''; } catch { dir = ''; }
  dlCfg = { at: Date.now(), dir };
  return dir || null;
}

// uuid#轮号 → .md 路径。uuid 全局唯一，不用拿项目名/hash 去拼（省掉一套命名清洗的坑）。
// 目录里 2600+ 文件、6 个子目录，readdir 一遍很便宜，30s 重建一次足够。
let dlIdx = { at: 0, dir: '', map: null };
function datalogIndex(dir) {
  if (dlIdx.map && dlIdx.dir === dir && Date.now() - dlIdx.at < 30000) return dlIdx.map;
  const map = new Map();
  try {
    for (const proj of fs.readdirSync(dir)) {
      const dp = path.join(dir, proj);
      let st; try { st = fs.statSync(dp); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(dp)) {
        const m = f.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-t(\d+)-[^\\/]*\.md$/i);
        if (m) map.set(m[1].toLowerCase() + '#' + m[2], path.join(dp, f));
      }
    }
  } catch { /* 目录半路消失就当没有 */ }
  dlIdx = { at: Date.now(), dir, map };
  return map;
}

// 把一份 .md 解析成逐轮调用。两个坑都踩过，记下来：
//
//  1. **别拿 ``` 配对来跳过代码块**。真这么写了，结果某些 md 里围栏行数是**奇数**（实测一份
//     139 行，全都在列 0），状态机一旦错位就把后半份文件整个吞掉——那次的症状是「54 轮只解析出
//     44 轮」。源文件的围栏本来就不保证平衡，靠它做区间划分就是用不可靠的输入去当边界。
//  2. 工具结果里**可能逐字回显** `### Turn N` 和整行 tokens（这个面板自己就在读别的日志，这不是
//     假想）。所以表头必须序号连续才认；账行要求行首恰好缩进两格、整行严丝合缝；而且一轮里若
//     出现多行，**以最后一行为准**——真账行总是打在这一轮全部工具调用之后，回声在它前面，会被盖掉。
function parseDatalogMd(text) {
  let model = '';
  const rounds = [];
  let cur = null, last = 0;
  for (const line of text.split('\n')) {
    if (!model && line.startsWith('**env:**')) { const m = line.match(/model=([^,\s]+)/); if (m) model = m[1]; continue; }
    const h = line.match(/^### Turn (\d+)\s*$/);
    if (h) {
      const n = Number(h[1]);
      if (n === last + 1) { cur = { n, prompt: null, completion: 0, cache: 0, dur: null }; rounds.push(cur); last = n; }
      continue;   // 不连续的表头 = 正文里的回声，当没看见（保留 cur，别把这一轮的账丢了）
    }
    if (!cur) continue;
    const t = line.match(/^ {2}_\[tokens: prompt=(\d+)\+completion=(\d+), cache=(\d+)tok([^\]]*)\]_\s*$/);
    if (t) {
      cur.prompt = +t[1]; cur.completion = +t[2]; cur.cache = +t[3];
      // v5.1.0 起这一行会多带本轮的请求耗时（on_request→on_model_response 计时）。字段是本机
      // 5.0.9 还产不出来的东西，所以**尾段留成通配**再捞 `dur=Nms`：格式换了位置也认，
      // 没有就是没有（对 5.1.0 之前的全部旧文件实测零影响）。
      const d = t[4].match(/dur=(\d+)ms/);
      if (d) cur.dur = +d[1];
    }
  }
  return { model, rounds: rounds.filter(r => r.prompt != null) };
}

// 同一份 .md 会随会话进行不断变长，而 live 的条目每个扫描周期都会被重新取一次详情——
// 用 {mtime,size} 当版本号挡住重复解析（statSync 比重读+解析一个几 MB 的 md 便宜得多）。
const dlCache = new Map();
export function datalogCalls(src, fallbackModel) {
  const dir = datalogDir();
  if (!dir) return [];
  const base = path.basename(src.file);
  const uuid = (base.endsWith('.jsonl') ? base.slice(0, -6) : base).toLowerCase();
  const f = datalogIndex(dir).get(uuid + '#' + src.turn);
  if (!f) return [];
  let calls, key;
  try {
    const st = fs.statSync(f);
    key = st.mtimeMs + ':' + st.size;
    const hit = dlCache.get(f);
    if (hit && hit.key === key) return hit.calls;
    const { model, rounds } = parseDatalogMd(fs.readFileSync(f, 'utf8'));
    const mdl = model || fallbackModel || '';
    calls = rounds.map(r => ({
      model: mdl,
      // 口径对齐卡片：datalog 的 prompt **含**缓存，面板的 tin 是**不含**缓存的输入。
      // 对过账：Σ(prompt − cache) == .meta 的 model_usage.input，896/896 精确相等。
      tin: Math.max(0, r.prompt - r.cache), tout: r.completion, tcache: r.cache,
      // 本轮请求耗时。5.1.0 之前 datalog 不记（旧命名格式那个 _(3.9s)_ 是**工具**耗时，别混进来），
      // 拿不到就是 0 → 页面 fmtDur 渲染成 —，宁可留空也不编一个数出来
      dur: r.dur != null ? r.dur : 0,
    }));
  } catch { return []; }
  if (dlCache.size > 64) dlCache.clear();
  dlCache.set(f, { key, calls });
  return calls;
}

// ---------------- 条目生成 ----------------
export function expandMeta(agent, metaPath, base, jsonlRef, data) {
  const jsonlPath = jsonlRef ? jsonlRef[0] : metaPath.slice(0, -5) + '.jsonl';
  const jdata = jsonlRef ? files.get(jsonlRef[0])?.data : null;
  const turnTs = jdata?.turnTs || {};
  const preview = jdata?.preview || {};
  const md5ish = metaPath.replace(/[\\/:]/g, '~');
  for (const t of data.turns) {
    // 确定性 id：meta 每轮都会变、会重扫，自增 id 会导致同一轮重复灌入（曾放大到 67 份）
    const id = 'a#' + md5ish + '#' + t.turn_id;
    // I16 / D1：`time` 一律取**轮起点**，与全项目口径一致（claude / dsh / zcode / codex 全取起点）。
    //   以前写的是 `turnTs[t.turn_id]`，而 jsonl 的 `ts` 是**轮结束**时刻（对账 ts − started_at
    //   ≈ duration_ms，本机 773 条样本平均偏差 15ms 证实）⇒ atomcode 是唯一一家取终点的，
    //   卡片/会话页显示的时间戳整体偏一个轮长、按天分桶也跟着偏。
    //   jsonl 里**同时**有 started_at（起点）与 ts（终点）：优先取 started_at，拿不到才退 ts − dur
    //   （dur = meta 的 duration_ms，本身就是「终点−起点」），两者都拿不到才算时间未知。
    // I16 / D2：拿不到时间时**不再沉默回落 updated_at**。那会让同一会话几十轮全塌成同一时刻
    //   （本机 2391/3492 轮 = 68.5% 是这么来的），页面看上去「这些轮同时发生」，而真相是「不知道」。
    //   改成落 `timeUnknown: true` + time=0 —— 页面按「时间未知」如实标注并把它排到最后，
    //   不拿会话更新时刻冒充轮时间。这是前置闸那条「排除时间未知的轮」的落点。
    const end = Number(turnTs[t.turn_id]);
    const start = Number(jdata?.turnStart?.[t.turn_id]);
    const dur = Number(t.dur) || 0;
    let time = 0, unknown = false;
    if (start > 0) time = start;
    else if (end > 0) time = Math.max(0, end - dur);
    else unknown = true;
    addEntry(id, {
      agent, project: data.project || '(未知项目)', session: data.name || base,
      time, dur: t.dur, status: t.errored ? 'error' : 'ok',
      // 时间未知的轮如实标注：页面据此不拿它做时间轴/拓扑排序，也不并进按天分桶的假位置。
      timeUnknown: unknown ? true : undefined,
      // total 与别家口径统一：轮内各次调用的累加（meta 的 model_usage 本来就是按轮累加的）。
      // ⚠️ 不能再用 meta.total_tokens 当 total —— 实测它 = **末轮 prompt+completion**（986 个样本 985 个精确相等），
      // 语义是「这一轮结束时的上下文占用」，跟 tin/tout/tcache（各轮累加）不是一个量纲。
      // 拿它当合计的话卡片上会出现「合计 269160 < 输入 431208」这种算不通的数。
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      // ctx 是窗口**容量**，ctxUsed 是结束时**实际占用**，页面那根进度条要的是后者（见页面 ctxUsed）
      ctx: t.ctx, ctxUsed: t.ctxUsed,
      // round_count 就是轮内 LLM 调用次数（拿 datalog 的逐轮块数对过：1015 轮里 896 轮精确相等，
      // 少数差 1 是被打断没跑完的那轮）——以前写死 null 让「N 次 LLM」徽章一直不显示，数字其实一直在手上
      rounds: t.rounds, tools: t.tools, calls: t.rounds,
      toolNames: (jdata?.toolNames || {})[t.turn_id] || {},
      models: t.models, preview: preview[t.turn_id] || '',
    }, { file: jsonlPath, turn: Number(t.turn_id), kind: 'atomcode' });
  }
}

// ---------------- 扫描 ----------------
export function scanAtomcodeDir(agent, names, dir) {
  const metas = [], jsonls = new Map();
  for (const n of names) {
    const fp = path.join(dir, n);
    let fst; try { fst = fs.statSync(fp); } catch { continue; }
    if (!fst.isFile()) continue;
    if (n.endsWith('.meta')) metas.push([fp, fst]);
    else if (n.endsWith('.jsonl')) jsonls.set(n.slice(0, -6), [fp, fst]);
  }
  for (const [base, [fp, fst]] of jsonls) {
    const key = fp, m = fst.mtimeMs, s = fst.size;
    const prev = files.get(key);
    if (prev && prev.m === m && prev.s === s) continue;
    const off = prev?.off || 0;
    let data = prev?.data || { turnTs: {}, turnStart: {}, preview: {}, toolNames: {} };
    if (s <= off) continue;
    try {
      // 只推进到最后一个完整行，避免半截行被吞（旧版 off=size+shift 每次追加丢一条）
      const rd = readCompleteLines(fp, off, s);
      if (!rd) { files.set(key, { agent, kind: 'jsonl', m, s, off, data }); continue; }
      const newOff = rd.newOff;
      for (const line of rd.lines) {
        // I16 / D1：`ts` 是**轮结束**时刻、`started_at` 才是**轮起点**（全项目口径取起点）。
        // 两个都收下来，emit 时优先用 started_at（见 expandMeta），拿不到才退 `ts − duration_ms`。
        // 老 state 没有 turnStart ⇒ 缺这一位时回落仍成立，不会把已有的轮时间弄丢。
        const tm = line.match(/"turn_id":(\d+)/), tsm = line.match(/"ts":(\d+)/), sam = line.match(/"started_at":(\d+)/);
        if (!tm || (!tsm && !sam)) continue;
        const tid = tm[1];
        if (tsm && !data.turnTs[tid]) data.turnTs[tid] = Number(tsm[1]);
        if (!data.turnStart) data.turnStart = {};
        if (sam && !data.turnStart[tid]) data.turnStart[tid] = Number(sam[1]);
        if (!data.preview[tid]) {
          const um = line.match(/"user":"((?:[^"\\]|\\.)*)"/);
          if (um) data.preview[tid] = um[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u[\dA-Fa-f]{4}/g, '·').slice(0, 200);
        }
        // 工具名去重计数（卡片「调用」旁的问号悬浮层数据源）：jsonl 每行的 tools[] 带逐个 name。
        // 用 JSON.parse 而不是正则：tools 的 args 字符串里可能含 ] 等字符，正则会断在半路
        // （实测一轮 7 个 edit_file 只数出 1 个）。解析失败的行宁可丢掉也不数错。
        try {
          const j = JSON.parse(line);
          if (Array.isArray(j.tools) && j.tools.length) {
            if (!data.toolNames[tid]) data.toolNames[tid] = {};
            const tn = data.toolNames[tid];
            for (const tl of j.tools) { const n = tl && tl.name; if (n) tn[n] = (tn[n] || 0) + 1; }
          }
        } catch {}
      }
      files.set(key, { agent, kind: 'jsonl', m, s, off: newOff, data });
      markKind('jsonl');
    } catch {}
  }
  for (const [fp, fst] of metas) {
    const base = path.basename(fp).slice(0, -5);
    const key = fp, m = fst.mtimeMs, s = fst.size;
    const prev = files.get(key);
    if (prev && prev.m === m && prev.s === s) continue;
    let data = null;
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      data = {
        project: j.working_dir || '', name: j.name || '', created: j.created_at || 0, updated: j.updated_at || 0,
        turns: (j.turn_stats || []).map(t => ({
          // total_tokens 不是「本轮用了多少 token」，是**末轮 prompt+completion**＝结束时的上下文占用，
          // 所以挂在 ctxUsed 上（页面用它画上下文进度条），别当 token 合计用
          turn_id: t.turn_id, dur: t.duration_ms || 0, ctxUsed: t.total_tokens || 0,
          tin: sumModel(t, 'input'), tout: sumModel(t, 'output'), tcache: sumModel(t, 'cached_input'),
          ctx: t.ctx_window || 0, rounds: t.round_count || 0, tools: t.tool_call_count || 0,
          errored: !!t.errored, models: modelList((t.model_usage || []).map(x => x.model_id)),
        })),
      };
    } catch { continue; }
    files.set(key, { agent, kind: 'meta', m, s, off: 0, data });
    expandMeta(agent, fp, base, jsonls.get(base), data);
  }
}

// hash 会话目录列表（原逻辑：列不出目录、或子项不是目录都跳过）
export function atomcodeDirs(root) {
  const hashes = listDirCached(root);
  if (!hashes) return [];
  const out = [];
  for (const hash of hashes) { const d = path.join(root, hash); if (isDir(d)) out.push(d); }
  return out;
}

// 详情：重读 sessions 的 .jsonl 按 turn_id 过滤取正文/工具，逐次调用明细来自 datalog（见上）。
// entry 是扫描侧产出的条目（models / calls）——只作兜底用，从参数传入，避免这里反向去查全局表。
export function atomcodeEntryContent(src, full, entry) {
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null;
  let out = null;
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.turn_id !== src.turn) continue;
    if (!out) out = { user: '', assistant: '', tools: [] };
    if (j.user && !out.user) out.user = String(j.user);
    // 一轮多 round：assistant 逐行累加（原为覆盖，中间输出会丢）
    if (j.assistant) out.assistant = out.assistant ? out.assistant + '\n\n---\n\n' + j.assistant : String(j.assistant);
    for (const tl of j.tools || []) {
      const fi = {}, fo = {};
      out.tools.push({ name: tl.name, input: trunc(tl.args, full, fi), inputTrunc: !!fi.t, output: trunc(tl.result, full, fo), outputTrunc: !!fo.t, error: !!tl.is_error });
    }
  }
  if (!out) out = { user: '', assistant: '', tools: [] };
  // 逐次 LLM 调用明细来自 datalog（sessions 里没有这个粒度），没有就空数组 → 页面那块不渲染。
  // 注意：sessions 的 .jsonl 可能是 0 字节（实测有这种会话），此时上面循环啥也没读到，
  // 但 datalog 照旧能给明细，所以 calls 必须挂在「读不到正文」这个分支之外。
  out.calls = datalogCalls(src, (entry?.models || [])[0]);
  // 卡片上写着「N 次 LLM」却一条明细都拿不出来时，得说清为什么——不然看着像坏了。
  // 两种情况分开写：开关/目录压根没开（用户能去开），和这一轮恰好没落盘（只能等）。
  if (!out.calls.length) {
    const rc = entry?.calls || 0;
    if (rc > 0) out.callsNote = datalogDir()
      ? `这一轮没有 datalog 记录（${rc} 次调用只剩轮级汇总）`
      : 'datalog 未开启（默认关闭），拿不到逐次明细';
  }
  out.v = version;
  return out;
}
