// ---------------- doubao 解析器（豆包 Work 智能体：trajectory.jsonl） ----------------
// 落盘：<workspace>/.sessions/<会话 id>/agents/<agent id>/system/trajectory.jsonl
//   OpenAI 风格逐行 jsonl，一行 = 一条消息：
//     {"role":"user","content":"…"}
//     {"role":"assistant","content":"…","tool_calls":[{"id":"…","type":"function","function":{"name":"…","arguments":{…}}}]}
//     {"role":"tool","content":"…","tool_call_id":"…"}
//   user 消息开新轮，其后的 assistant / tool 都归这一轮，下一条 user 收轮。
//
// 源头**没有**这些字段（实测本机两份 trajectory.jsonl）：
//   · 时间戳 —— 每轮的真实时间在同目录 assignment.md 的「## [ISO时间] 需求」记录里（与 trajectory
//     同一事件流追加，按规范化文本匹配对齐；匹配不到 / 没有该文件 → time=0，页面显示「—」）；
//   · 模型 / token / usage —— 转录不落盘：逐次 token 恒 0；模型名从 IndexedDB 补
//     （chat 库的 model_item_key 数字 key + launcher 库 model_list 目录的 key→UTF-16LE 名字）。
// 工具调用是真实可数的：assistant 行的 tool_calls[] 计数，tool 行按 tool_call_id 回填出入参。
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, markKind, listDirCached, isDir, isFile, toText, trunc, readCompleteLines } from './shared.mjs';

// ---------------- 全局 IndexedDB context 提取（context_window_usage / model_item_key / 模型名目录） ----------------
// doubao 客户端的 chat IndexedDB 存了每轮会话的上下文占用（system_prompt + messages + skills + tools 的 token 数），
// 还有 model_item_key（数字 key，如 "9"）和 reasoning_effort（数字 key，如 "5"）。
// 但 IndexedDB 里嵌在 protobuf 里，JSON key 部分被 tag bytes 破坏，只能用正则 + 数值推断来提。
// 模型名的对照表在**另一个库**——launcher 的 model_list 目录（key → UTF-16LE name，如 9→自动、4→豆包 2.1 Turbo）。
// 这些数据是全局的（整个客户端共享 chat / launcher 两个库），缓存键含两个目录，任一目录变化即刷新。

import { homedir } from 'node:os';

// 硬编码路径：DoubaoWork 在 Windows 上的默认位置
function doubaoIdbDir() {
  const p = path.join(homedir(), 'AppData', 'Local', 'DoubaoWork', 'User Data', 'Default', 'IndexedDB', 'chrome_doubaowork-chat_0.indexeddb.leveldb');
  return fs.existsSync(p) ? p : null;
}

function doubaoLauncherDir() {
  const p = path.join(homedir(), 'AppData', 'Local', 'DoubaoWork', 'User Data', 'Default', 'IndexedDB', 'chrome_doubaowork-launcher_0.indexeddb.leveldb');
  return fs.existsSync(p) ? p : null;
}

// 按 mtime 缓存
let _contextCache = { dir: null, mtime: 0, result: null };

function latestMtime(dir) {
  if (!dir) return 0;
  let latest = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ldb') && !f.endsWith('.log')) continue;
    try { latest = Math.max(latest, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
  }
  return latest;
}

// launcher 库的 model_list 目录：`model_item_key"\x01<数字>` 附近跟着 `name` + 0x63 tag + 长度 + UTF-16LE 名字
// （9→自动、4→豆包 2.1 Turbo、5→豆包 2.1 Pro）。菜单目录（modeSelectConfig）里同名字段是混合编码坏样本，
// 用「每个码点都得是常用汉字或可打印 ASCII」筛掉；effort 档位名（低/中/高，2 字节）由 len>=4 排除。
function extractDoubaoModelNames() {
  const dir = doubaoLauncherDir();
  const map = new Map();
  if (!dir) return map;
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.ldb') && !fname.endsWith('.log')) continue;
    let buf; try { buf = fs.readFileSync(path.join(dir, fname)); } catch { continue; }
    const s = buf.toString('latin1'); // 1 字符 = 1 字节，charCodeAt 即原始字节值
    let i = 0;
    while ((i = s.indexOf('model_item_key', i)) !== -1) {
      i += 14;
      const kM = /^"\x01(.)$/.exec(s.slice(i, i + 3));
      if (!kM || !/\d/.test(kM[1]) || map.has(kM[1])) continue;
      const key = kM[1];
      const win = s.slice(i, i + 120);
      let j = 0;
      while ((j = win.indexOf('name', j)) !== -1) {
        let p = j + 4;
        if (win.charCodeAt(p) !== 0x63) p++; // 部分记录 name 与 tag 之间夹一个分隔字节
        const len = win.charCodeAt(p) === 0x63 ? win.charCodeAt(p + 1) : 0;
        if (len >= 4 && len <= 48 && len % 2 === 0 && p + 2 + len <= win.length) {
          let name = '', good = true;
          for (let k = 0; k < len; k += 2) {
            const cp = win.charCodeAt(p + 2 + k) | (win.charCodeAt(p + 3 + k) << 8);
            if (!((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x20 && cp <= 0x7e))) { good = false; break; }
            name += String.fromCharCode(cp);
          }
          if (good && name.trim()) { map.set(key, name.trim()); break; }
        }
        j += 4;
      }
    }
  }
  return map;
}

function extractDoubaoContext() {
  const dir = doubaoIdbDir();
  const ldir = doubaoLauncherDir();
  if (!dir) return null;
  // 用两个库（chat + launcher）LDB/LOG 的最新 mtime 做 dirty 标记
  const latest = Math.max(latestMtime(dir), latestMtime(ldir));
  const ck = dir + '|' + (ldir || '');
  if (_contextCache.dir === ck && _contextCache.mtime === latest) return _contextCache.result;

  const t0 = Date.now();
  const out = { ctxUsed: 0, ctx: 0, modelKey: '', modelName: '', reasoningEffort: '' };
  const windows = new Map();
  const modelKeys = new Set();
  const efforts = new Set();

  for (const fname of fs.readdirSync(dir)) {
    if (Date.now() - t0 > 3000) break; // 总超时保护：不要因为 IndexedDB 扫描拖慢服务启动
    if (!fname.endsWith('.ldb') && !fname.endsWith('.log')) continue;
    let buf; try { buf = fs.readFileSync(path.join(dir, fname)); } catch { continue; }
    const text = buf.toString('utf8');

    // 正则必须提到循环外。写在 while 条件里是**死循环**：正则字面量每次求值都是新对象，
    // lastIndex 恒为 0，于是只要文本里命中过一次，exec 每次都返回同一个匹配、永远不返回 null。
    // 解析器/页面都靠外层线程，这里转死 = 服务起不来，且是在 import 阶段（见文件末尾 note 的说明）。
    let m;
    const reModelKey = /"model_item_key"\s*:\s*"([^"]+)"/g;
    const reEffort = /"reasoning_effort"\s*:\s*"([^"]+)"/g;
    while ((m = reModelKey.exec(text)) !== null) modelKeys.add(m[1]);
    while ((m = reEffort.exec(text)) !== null) efforts.add(m[1]);

    let idx = 0, safeCount = 0;
    while ((idx = text.indexOf('"system_prompt"', idx)) !== -1) {
      safeCount++;
      if (safeCount > 5000) break; // 异常保护
      const braceStart = text.lastIndexOf('{', idx);
      if (braceStart === -1 || braceStart < idx - 200) { idx++; continue; }
      const twsIdx = text.indexOf('256000', idx);
      if (twsIdx === -1 || twsIdx > idx + 50000) { idx++; continue; }
      const braceEnd = text.indexOf('}', twsIdx);
      if (braceEnd === -1 || braceEnd > idx + 60000) { idx++; continue; }
      const frag = text.slice(braceStart, braceEnd + 1);

      if (!frag.includes('8282')) { idx = braceEnd; continue; }
      if (!frag.includes('256000')) { idx = braceEnd; continue; }

      const nums = [...frag.matchAll(/(\d+)/g)].map(x => parseInt(x[1]));
      const tws = nums.find(n => n === 256000) || 0;
      const sp = nums.find(n => n === 8282 || n === 8280 || n === 8300) || 0;
      if (!tws || !sp) { idx = braceEnd; continue; }

      const rest = [...new Set(nums.filter(n => n !== sp && n !== tws && n > 0))];
      let messages = 0, skills = 0, tools = 0;
      if (rest.length >= 3) {
        skills = rest.find(n => n >= 0 && n <= 5000) ?? Math.min(...rest);
        tools = rest.find(n => n >= 50000) ?? Math.max(...rest);
        messages = rest.find(n => n !== skills && n !== tools && n >= 1000) ?? 0;
      } else if (rest.length === 2) {
        skills = Math.min(...rest); tools = Math.max(...rest);
      } else if (rest.length === 1) {
        tools = rest[0];
      }

      const sig = `${sp}|${messages}|${skills}|${tools}|${tws}`;
      if (!windows.has(sig)) windows.set(sig, { system_prompt: sp, messages, skills, tools, total_window_size: tws });
      idx = braceEnd;
    }
  }

  if (modelKeys.size) {
    out.modelKey = [...modelKeys][0];
    out.modelName = extractDoubaoModelNames().get(out.modelKey) || '';
  }
  if (efforts.size) out.reasoningEffort = [...efforts][0];

  // context 窗口：取平均值（所有会话共享同一个 IndexedDB，可能有多个会话各自的窗口大小）
  if (windows.size) {
    let sumUsed = 0, sumTws = 0;
    for (const [, w] of windows) {
      sumUsed += w.system_prompt + w.messages + w.skills + w.tools;
      sumTws += w.total_window_size;
    }
    out.ctxUsed = Math.round(sumUsed / windows.size);
    out.ctx = Math.round(sumTws / windows.size);
  }

  _contextCache = { dir, mtime: latest, result: out };
  return out;
}

// 注意：这里**必须**是函数，不能是 `export const ... = ...extractDoubaoContext()...`。
// 以前它是 const + 顶层 IIFE，于是「import 这个模块」= 「同步扫一遍豆包客户端的 IndexedDB」。
// 而 server 是静态 import 全部 parser 的，所以任何参数（连 --version / --help / --stop 这些
// 明令零副作用的）都得先等这次扫描；扫描里出任何毛病（2026-09-20 那次是正则死循环，
// 见上方 reModelKey 处的说明）就是整个 CLI 零输出挂死，而不是「豆包那块不好使」。
// 谁要这条 note 谁调；每轮详情那条活的 note 在 doubaoEntryContent 里，本来也带这些字段。
// 模型显示名：launcher 库目录里有 key→名字（9→自动）就用名字；目录没命中才退回数字 key
function doubaoModelLabel(ctx) {
  return ctx.modelName || (ctx.modelKey ? 'item_key=' + ctx.modelKey : '');
}

export function doubaoNoUsageNote() {
  const c = extractDoubaoContext();
  return 'doubao 转录（trajectory.jsonl）只有 role / content / tool_calls，源头不落盘 token 用量；' +
    '模型名 = launcher IndexedDB model_list 目录按 chat 库的 model_item_key=' + (c?.modelKey || '(未提取到)') +
    ' 映射（' + (c?.modelName || '目录未命中，退回数字 key') + '）；' +
    '故本卡逐次 token 恒为 0；' +
    '上下文占用 = IndexedDB context_window_usage 的平均值（system_prompt + messages + skills + tools / total_window_size）。' +
    '每轮时间取自同目录 assignment.md 的「## [时间] 需求」记录（按文本匹配对齐），匹配不到的轮为 0。';
}

// ---------------- assignment.md 时间戳源 ----------------
// 每轮用户需求以「## [ISO时间] 需求」开行、正文跟在其后，直到下一条标题。两文件同源追加，
// 轮数与顺序天然一致，但正文写法可能不同（skill 链接在 assignment 里是 skill://、在 trajectory
// 里是 <本地路径>），所以匹配用**规范化文本**（剥 markdown 链接 → 折叠空白）而不是原样比对。
const ASSIGN_TS_RE = /^##\s*\[([^\]]+)\]\s*(.*)$/; // 形如「## [ISO时间] 需求」——标题行带一个标签后缀，别只认到 ] 为止

function parseAssignment(fp) {
  const out = []; // [{ts, text, used}]
  let cur = null;
  try {
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const m = ASSIGN_TS_RE.exec(line.trim());
      if (m) { cur = { ts: Date.parse(m[1]) || 0, text: '', used: false }; out.push(cur); continue; }
      if (!cur) continue; // 标题之前的内容（头部元信息）不归任何轮
      const t = line.trim();
      if (t) cur.text += (cur.text ? '\n' : '') + t;
    }
  } catch { /* 读不到 = 没有时间源，全部轮 time=0 */ }
  return out;
}

function normText(s) {
  return String(s || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown 链接 → 链接文本（两处写法的差异剥掉）
    .replace(/\s+/g, ' ')
    .trim();
}

// 给一条 user 消息找一个时间戳：先按规范化文本精确匹配（第一优先，处理链接写法差异），
// 匹配不到再按顺序取下一个未用条目兜底（两文件同源追加，顺序对齐在绝大多数情况成立）。
// 都落空 → 0（页面显示「—」，不编造时间）。
function matchAssignTs(assign, text0) {
  const n = normText(text0);
  for (const a of assign) {
    if (a.used || !a.text) continue;
    if (normText(a.text) === n) { a.used = true; return a.ts; }
  }
  for (const a of assign) {
    if (!a.used) { a.used = true; return a.ts; }
  }
  return 0;
}

// ---------------- 扫描（OFF_KINDS：逐行 off 增量续读，语义与 claude 完全一致） ----------------
export function doubaoIdBase(fp) { return 'db#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function emitDoubaoTurns(agent, fp, data, fromIdx) {
  const idBase = doubaoIdBase(fp);
  const ctx = data._context || {}; // { ctx, ctxUsed, modelKey }
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const next = data.turns[i + 1];
    // dur = 下一轮时间 − 本轮时间（同 claude 的 lastTs 推算；最后一轮没有下一轮 → 0）
    addEntry(idBase + t.idx, {
      agent, project: data.project, session: data.session,
      time: t.time, dur: next ? Math.max(0, next.time - t.time) : 0, status: t.err ? 'error' : 'ok',
      tin: 0, tout: 0, tcache: 0, total: 0,
      ctx: ctx.ctx || 0, ctxUsed: ctx.ctxUsed || 0,
      rounds: t.calls, tools: t.tools, calls: t.calls, // 一轮 = 一条 user 消息；calls = 其后的 assistant 行数
      // R21：模型字段 = launcher 目录映射出的模型名（9→自动），目录没命中退回 item_key=数字
      models: [doubaoModelLabel(ctx)].filter(Boolean),
      preview: t.preview,
      // R19：转录没有「轮结束」标志，收不了口的最后一轮由页面按最后活动时间兜底（同 claude）
      finished: i < data.turns.length - 1,
      aborted: false,
      toolNames: t.toolNames, // R20：工具名去重计数，逐行扫到就累计
    }, { file: fp, turn: t.idx, kind: 'doubao' });
  }
}

// onlyFile：分片首扫用（doubao 单文件很小，暂不进 SLICE_BY_FILE，但签名保持一致）
export function scanDoubao(agent, root, onlyFile) {
  // 每个 workspace 扫一次 IndexedDB（全局共享一个 chat IndexedDB，缓存自动处理重复调用）
  const ctx = extractDoubaoContext() || {};

  for (const sid of listDirCached(root) || []) {
    const agentsDir = path.join(root, sid, 'agents');
    if (!isDir(agentsDir)) continue;
    for (const aid of listDirCached(agentsDir) || []) {
      const sysDir = path.join(agentsDir, aid, 'system');
      const fp = path.join(sysDir, 'trajectory.jsonl');
      if (!isFile(fp)) continue;
      if (onlyFile && fp !== onlyFile) continue;
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) {
        // 重启后 entries 为空但 files 状态被恢复：从状态直接重建条目，不重扫文件
        if (prev.data) prev.data._context = ctx; // 确保 context 最新
        if (prev.data?.turns?.length && !entries.has(doubaoIdBase(fp) + (prev.data.turns.length - 1))) emitDoubaoTurns(agent, fp, prev.data, 0);
        continue;
      }
      const off = prev?.off || 0;
      const data = prev?.data || { turns: [], emitted: 0, session: sid + '/' + aid, project: '' };
      data._context = ctx;
      // project：doubao 没有项目概念，用会话根（.sessions）的上级 workspace 目录作为真实容器
      //（同一 workspace 的所有 doubao 会话归到一个项目，避免空字符串进项目筛选下拉）
      if (!data.project) data.project = (root ? path.dirname(root) : '') || '(doubao)';
      if (s <= off) { files.set(key, { agent, kind: 'doubao', m, s, off, data }); markKind('doubao'); continue; }
      try {
        // 文件有新增内容（新轮/新消息）时重读 assignment.md：它与 trajectory 同源追加，此时多半也长了
        data.assign = parseAssignment(path.join(sysDir, 'assignment.md'));
        const rd = readCompleteLines(fp, off, s);
        if (!rd) { files.set(key, { agent, kind: 'doubao', m, s, off, data }); markKind('doubao'); continue; } // 尚无完整行
        const newOff = rd.newOff;
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.role === 'user') {
            const text0 = toText(j.content);
            if (!text0) continue; // 空用户消息不开轮
            data.turns.push({
              idx: data.turns.length, time: matchAssignTs(data.assign, text0), lastTs: 0,
              tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, ctxUsed: 0,
              models: [], err: false, aborted: false,
              preview: text0.replace(/\s+/g, ' ').slice(0, 300),
              toolNames: {}, // R20：工具名去重计数（逐行扫到就累计）
            });
          } else if (j.role === 'assistant' && data.turns.length) {
            const cur = data.turns[data.turns.length - 1];
            cur.calls++; // 每条 assistant 行 = 一次 LLM 响应
            const tcs = Array.isArray(j.tool_calls) ? j.tool_calls : [];
            for (const tc of tcs) {
              const nm = typeof tc?.function?.name === 'string' && tc.function.name ? tc.function.name : '?';
              cur.tools++;
              cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
            }
          }
          // role === 'tool'：详情侧按 tool_call_id 回填，扫描侧不参与轮统计
        }
        files.set(key, { agent, kind: 'doubao', m, s, off: newOff, data });
        markKind('doubao');
        // 从最后一个已发轮起重发（进行中的轮会被原地更新）
        emitDoubaoTurns(agent, fp, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}

// ---------------- 详情：重读转录按 src.turn 过滤 ----------------
// 开轮判定与扫描侧同一套（role=user 即开轮），不会出现「扫描算了一轮、详情找不到」。
export function doubaoEntryContent(src, full) {
  const fstate = files.get(src.file);
  const version = fstate ? fstate.m + ':' + (fstate.off || 0) : null;
  const lines = fs.readFileSync(src.file, 'utf8').split('\n');
  // 从 IndexedDB 拿 model_item_key（可能被 fstate 缓存了）
  const ctx = fstate?.data?._context || extractDoubaoContext() || {};
  let turnIdx = -1;
  const noteParts = [
    'doubao 转录（trajectory.jsonl）只有 role / content / tool_calls，源头不落盘 token 用量；',
    '模型名 = launcher IndexedDB model_list 目录按 model_item_key=' + (ctx.modelKey || '?') +
      ' 映射出的「' + (ctx.modelName || '(目录未命中，退回数字 key)') + '」（reasoning_effort=' + (ctx.reasoningEffort || '?') + '）；',
  ];
  if (ctx.ctx) noteParts.push('上下文占用 ≈ ' + (ctx.ctxUsed || 0).toLocaleString() + ' / ' + ctx.ctx.toLocaleString() + ' tokens（来自 IndexedDB context_window_usage 平均值）；');
  noteParts.push('每轮时间取自同目录 assignment.md 的「## [时间] 需求」记录，匹配不到的轮为 0。');
  const out = { user: '', assistant: '', tools: [], calls: [], v: version, callsNote: noteParts.join(' ') };
  const texts = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.role === 'user') {
      const text0 = toText(j.content);
      if (!text0) continue; // 与扫描侧同判据：空用户消息不开轮，否则两侧轮序号错开
      turnIdx++;
      if (turnIdx === src.turn) out.user = text0;
      continue;
    }
    if (turnIdx !== src.turn) continue;
    if (j.role === 'assistant') {
      const text = toText(j.content);
      if (text) texts.push(text);
      const tcs = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      const names = [];
      for (const tc of tcs) {
        const fn = (tc && tc.function) || {};
        const nm = typeof fn.name === 'string' && fn.name ? fn.name : '?';
        names.push(nm);
        const fi = {};
        // arguments 可能是字符串（JSON 文本）或对象，统一落成可读文本
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? '');
        out.tools.push({
          name: nm, tid: tc.id || null, error: null,
          input: trunc(args, full, fi), inputTrunc: !!fi.t, output: '', outputTrunc: false,
        });
      }
      // 一次 assistant 行 = 一次 LLM 调用；源里没有 token/usage/逐次模型，只有正文与工具名
      // R21：模型字段 = launcher 目录映射的模型名（9→自动），没命中退回 item_key=数字
      const call = { model: doubaoModelLabel(ctx), tin: 0, tout: 0, tcache: 0, dur: 0 };
      if (text) { const ft = {}; call.text = trunc(text, full, ft); call.textTrunc = !!ft.t; }
      if (names.length) call.tools = names;
      out.calls.push(call);
    } else if (j.role === 'tool') {
      const t = out.tools.find(x => x.tid === j.tool_call_id);
      if (t) {
        const fo = {};
        t.output = trunc(j.content, full, fo);
        t.outputTrunc = !!fo.t;
        if (j.is_error) t.error = 'error';
      }
    }
    if (turnIdx > src.turn) break;
  }
  out.assistant = texts.join('\n\n---\n\n');
  return out;
}
