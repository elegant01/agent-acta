// ---------------- generic-jsonl：受限声明式解析器（R18） ----------------
// 让「claude 同族」的逐行 jsonl agent 通过 config 声明接入，不再为每一个手写 scanXxx。
// 「受限」的边界（写进需求验收，别越界）：
//   * 只支持**逐行 JSON 的线性状态机**：开轮 / 累加 / 收轮三类事件；
//   * 字段路径是白名单子集：单层 message.xxx、content[]（迭代）、content[type=tool_use]（过滤）；
//   * 表达式只允许字段引用与 + 组合（如 in + cacheRead + cacheCreate），**禁止 eval / new Function**；
//   * 不支持跨行配对（buddy 的 callId）、多帧压缩（dsh）、事件流重放（kimi）、SQLite（cursor/zcode）
//     —— 这些仍走各自的手写解析器，generic-jsonl **不替代**任何现有 kind。
// 版本纪律：kind 级的 PARSER_REV 表管不了它 —— 同一 kind 下每个 agent 的 rules 各不相同，
// 口径版本（rulesRev + rulesHash）随 config 落盘，主文件 loadIndex 恢复时逐文件比对，
// 不一致即丢弃该文件状态整份重扫（不允许「半新半旧」）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { files, entries, addEntry, modelName, modelList, windowOf, markKind, listDirCached, isDir, toText, readCompleteLines } from './shared.mjs';

// ---------------- 路径与表达式的白名单 ----------------
// 路径段：name | name[]（迭代数组） | name[k=v]（按字段过滤数组元素）。
// 组合按从左到右逐段求值；`[]` 之后还可以接过滤器（content[][type=x]），但常规写法是 content[type=tool_use]。
const SEG_RE = /^([A-Za-z_][\w-]*)(\[\])?(?:\[([A-Za-z_][\w-]*)=([^\]]*)\])?$/;
// 表达式项：只能是 usage 规则里配置的那几个字段名（in/out/cacheRead/cacheCreate）之一，用 + 连接。
const EXPR_FIELDS = ['in', 'out', 'cacheRead', 'cacheCreate'];

// 校验一条路径 spec（字符串或字符串数组），返回 null（合法）或错误信息。
function pathErr(spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  if (!list.length) return '路径为空';
  for (const s of list) {
    if (typeof s !== 'string' || !s.trim()) return '路径必须是非空字符串';
    for (const seg of s.trim().split('.')) {
      if (!SEG_RE.test(seg)) return '路径段「' + seg + '」不合法（只允许 字段名 / 字段名[] / 字段名[字段=值]）';
    }
  }
  return null;
}
// 校验表达式：按 + 拆项，每一项必须是白名单字段名。返回 null（合法）或错误信息。
function exprErr(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return '表达式为空';
  for (const term of expr.split('+')) {
    const t = term.trim();
    if (!EXPR_FIELDS.includes(t)) return '表达式项「' + t + '」不合法（只允许 ' + EXPR_FIELDS.join('/') + ' 与 + 组合）';
  }
  return null;
}
// 表达式求值：vars 是 {in, out, cacheRead, cacheCreate} 的数值表，缺项按 0。split 而非 eval。
function evalExpr(expr, vars) {
  let sum = 0;
  for (const term of String(expr).split('+')) {
    const v = vars[term.trim()];
    sum += typeof v === 'number' && isFinite(v) ? v : 0;
  }
  return sum;
}
// 路径求值：返回全部命中值（数组）。求值对象中途碰到标量/缺失即断（不报错，返回空）。
function evalPath(obj, spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  let out = [];
  for (const s of list) {
    let cur = [obj];
    let dead = false;
    for (const seg of s.trim().split('.')) {
      const m = SEG_RE.exec(seg);
      if (!m) { dead = true; break; }
      const next = [];
      for (const o of cur) {
        if (o == null || typeof o !== 'object') continue;
        let v = o[m[1]];
        if (v == null) continue;
        if (m[2]) {   // name[]：迭代数组
          if (!Array.isArray(v)) continue;
          next.push(...v);
        } else next.push(v);
      }
      if (m[3]) {   // name[k=v]：按字段过滤。值是数组时**对元素过滤**（content[type=tool_use] 的本意），
                    // 不是标量时才当单对象看 —— 数组本身不是候选值（tool_use 块在数组里，不在数组上）
        const kept = [];
        for (const o of next) {
          const items = Array.isArray(o) ? o : [o];
          for (const el of items) {
            if (el && typeof el === 'object' && String(el[m[3]]) === m[4]) kept.push(el);
          }
        }
        cur = kept;
      } else cur = next;
      if (!cur.length) { dead = true; break; }
    }
    if (!dead) out.push(...cur);
  }
  return out;
}
// 路径取**第一个**命中值；'textPath' 支持数组（多个候选路径，先命中的赢 —— 见 turnOpen）。
function firstOf(obj, spec) {
  const v = evalPath(obj, spec);
  return v.length ? v[0] : undefined;
}
// turnOpen 的正文提取：textPath 可以是单个路径，也可以是**按序兜底**的路径数组（块数组形态在先、
// 字符串 content 兜底）。两条口径与 claudeUserText 对齐：
//   * 只收**字符串**命中值 —— 兜底路径 'message.content' 在 content 是块数组时会命中整个数组，
//     那不是正文；数组必须走 `content[]` 迭代。只收字符串顺带保证「只有 tool_result 的 user 行」
//     取不到正文 → 不开轮（与 claude 的 tool_result-only 跳过同口径）；
//   * 多个候选按序试，第一个取到非空正文的赢；全空返回 ''（不开轮）。
function textFromPath(j, spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  for (const s of list) {
    const t = evalPath(j, s).filter(v => typeof v === 'string').join('\n');
    if (t) return t;
  }
  return '';
}

// ---------------- rules 校验（loadConfig 阶段调用；失败回落 enabled:false） ----------------
// 返回错误数组（空数组 = 合法）。每条错误带 rule 名 —— 诊断页要能说出**具体哪条 rule 坏了**，
// 不允许静默扫出 0 条。
export function validateGenericRules(rules) {
  const errs = [];
  const bad = (rule, msg) => errs.push({ rule, msg });
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    bad('rules', 'rules 必须是对象（至少要有 turnOpen）');
    return errs;
  }
  const to = rules.turnOpen;
  if (!to || typeof to !== 'object') bad('turnOpen', 'turnOpen 缺失：没有开轮规则就扫不出任何轮');
  else {
    if (typeof to.lineType !== 'string' || !to.lineType) bad('turnOpen', 'lineType 必须是非空字符串（行的 type 字段值）');
    if (to.textPath == null) bad('turnOpen', 'textPath 缺失');
    else { const e = pathErr(to.textPath); if (e) bad('turnOpen', 'textPath：' + e); }
    if (to.skipIf != null && (!Array.isArray(to.skipIf) || to.skipIf.some(x => typeof x !== 'string')))
      bad('turnOpen', 'skipIf 必须是字符串数组（前缀黑名单）');
  }
  if (rules.usage != null) {
    const u = rules.usage;
    if (typeof u !== 'object') bad('usage', 'usage 必须是对象');
    else {
      if (typeof u.on !== 'string' || !u.on) bad('usage', 'on 必须是非空字符串');
      if (u.path != null) { const e = pathErr(u.path); if (e) bad('usage', 'path：' + e); }
      for (const k of EXPR_FIELDS) {
        if (u[k] != null && (typeof u[k] !== 'string' || !/^[A-Za-z_][\w-]*$/.test(u[k])))
          bad('usage', k + ' 必须是 usage 对象上的字段名');
      }
      if (u.ctxUsed != null) { const e = exprErr(u.ctxUsed); if (e) bad('usage', 'ctxUsed：' + e); }
      if (u.dedupeBy != null) { const e = pathErr(u.dedupeBy); if (e) bad('usage', 'dedupeBy：' + e); }
    }
  }
  if (rules.model != null) {
    const m = rules.model;
    if (typeof m !== 'object' || m.path == null) bad('model', 'model 必须是对象且带 path');
    else { const e = pathErr(m.path); if (e) bad('model', 'path：' + e); }
  }
  if (rules.tools != null) {
    const t = rules.tools;
    if (typeof t !== 'object') bad('tools', 'tools 必须是对象');
    else {
      if (typeof t.on !== 'string' || !t.on) bad('tools', 'on 必须是非空字符串');
      if (t.count == null) bad('tools', 'count 缺失');
      else { const e = pathErr(t.count); if (e) bad('tools', 'count：' + e); }
    }
  }
  if (rules.turnClose != null) {
    const tc = rules.turnClose;
    if (typeof tc !== 'object') bad('turnClose', 'turnClose 必须是对象');
    else {
      if (typeof tc.on !== 'string' || !tc.on) bad('turnClose', 'on 必须是非空字符串（行的 type 字段值）');
      if (tc.setFlag == null) bad('turnClose', 'setFlag 缺失');
      else { const e = pathErr(tc.setFlag); if (e) bad('turnClose', 'setFlag：' + e); }
    }
  }
  if (rules.ts != null) {
    const t = rules.ts;
    if (typeof t !== 'object' || t.path == null) bad('ts', 'ts 必须是对象且带 path');
    else { const e = pathErr(t.path); if (e) bad('ts', 'path：' + e); }
  }
  if (rules.cwd != null) {
    const c = rules.cwd;
    if (typeof c !== 'object' || c.path == null) bad('cwd', 'cwd 必须是对象且带 path');
    else { const e = pathErr(c.path); if (e) bad('cwd', 'path：' + e); }
  }
  // 扩展（R18 实现补充，需求 schema 之外的可选项）：详情页的「AI 输出」正文路径。
  // 没有它卡片照常出（轮次/token/模型都在），只是点开详情 assistant 一栏为空。
  if (rules.assistantText != null) {
    const a = rules.assistantText;
    if (typeof a !== 'object') bad('assistantText', 'assistantText 必须是对象');
    else {
      if (typeof a.on !== 'string' || !a.on) bad('assistantText', 'on 必须是非空字符串');
      if (a.path == null) bad('assistantText', 'path 缺失');
      else { const e = pathErr(a.path); if (e) bad('assistantText', 'path：' + e); }
    }
  }
  return errs;
}

// rules 指纹：键排序后 JSON 串的 sha1。config 落盘用它判断「rules 变了没」。
export function genericRulesHash(rules) {
  const norm = (function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
      return o;
    }
    return v;
  })(rules || {});
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex').slice(0, 12);
}

// ---------------- 扫描 ----------------
// fileGlob → 正则（只支持 * 与 ?，够用且受限）。匹配不了返回 null（回落 '*.jsonl'）。
function globToRe(g) {
  if (typeof g !== 'string' || !g) return null;
  try {
    const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.');
    return new RegExp('^' + esc + '$', 'i');
  } catch { return null; }
}
// 编译结果缓存：agent 名 -> {hash, conf}。rulesHash 变了自动重编（改配置不用重启扫描循环也认新规则）。
const compiledCache = new Map();
function compiledOf(agent, conf) {
  const hash = genericRulesHash(conf && conf.rules);
  const c = compiledCache.get(agent);
  if (c && c.hash === hash) return c;
  const nc = { hash, conf };
  compiledCache.set(agent, nc);
  return nc;
}
function num(v) { const n = Number(v); return typeof v === 'number' && isFinite(v) ? v : (isFinite(n) ? n : 0); }
function tsOf(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const t = Date.parse(String(v));
  return isFinite(t) ? t : 0;
}

// 从一行 JSON 推进状态机（compiled = {conf}）。与 scanClaude 的分支一一对应，规则全部来自 config。
function processLine(j, compiled, data) {
  const r = compiled.conf.rules || {};
  const ts = r.ts ? tsOf(firstOf(j, r.ts.path)) : 0;
  if (r.cwd) {
    const cv = firstOf(j, r.cwd.path);
    if (cv != null && String(cv) && !data.cwd) data.cwd = String(cv);
  }
  const to = r.turnOpen || {};
  const type = j.type;
  if (type === to.lineType) {
    const text = textFromPath(j, to.textPath);
    if (!text) return;                                     // 没有正文：工具结果这类行不开轮（同 claude 的 tool_result-only）
    const t0 = String(text).trimStart();
    if ((to.skipIf || []).some(p => t0.startsWith(p))) return;   // 命令消息不开轮（同 claudeIsCommandText 口径）
    data.turns.push({
      idx: data.turns.length, time: ts, lastTs: ts,
      tin: 0, tout: 0, tcache: 0, tools: 0, calls: 0, ctxUsed: 0,
      models: [], mids: [], err: false,
      preview: text.replace(/\s+/g, ' ').slice(0, 300),
      toolNames: {},
    });
    return;
  }
  const u = r.usage;
  const modelOn = (r.model && r.model.on) || (u && u.on);
  const assistantLike = (u && type === u.on) || (!u && modelOn && type === modelOn);
  if (assistantLike && data.turns.length) {
    const cur = data.turns[data.turns.length - 1];
    // 去重口径与 claude 的 mids 相同：dedupeBy 命中的行只计一次 usage/calls/model；
    // 命中重复时 tools / 时间戳照常累计（tool_use 是独立调用，不能被 mid 去重吞掉）。
    let seenMid = false;
    if (u) {
      const midPath = u.dedupeBy;
      const midRaw = midPath ? firstOf(j, midPath) : undefined;
      const mid = midRaw == null || midRaw === '' ? null : String(midRaw);
      let uv = {};
      if (u.path) uv = firstOf(j, u.path) || {};
      if (!(uv && typeof uv === 'object')) uv = {};
      if (mid) {
        if ((seenMid = cur.mids.includes(mid))) { /* duplicate – skip token fields */ }
        else cur.mids.push(mid);
      }
      if (!seenMid) {
        const g = k => (u[k] != null ? num(uv[u[k]]) : 0);
        cur.tin += g('in'); cur.tout += g('out'); cur.tcache += g('cacheRead') + g('cacheCreate');
        if (u.ctxUsed) {
          const vars = {};
          for (const k of EXPR_FIELDS) vars[k] = g(k);
          const ctxNow = evalExpr(u.ctxUsed, vars);
          if (ctxNow > 0) cur.ctxUsed = ctxNow;
        }
        cur.calls++;
      }
    }
    // 模型名与 usage 同守卫（去重命中时不重复收）；一律过 modelName 强制字符串化
    if (r.model && !seenMid) {
      const mn = modelName(firstOf(j, r.model.path));
      if (mn && !cur.models.includes(mn)) cur.models.push(mn);
    }
    if (ts) cur.lastTs = ts;
  }
  if (r.tools && type === r.tools.on && data.turns.length) {
    const cur = data.turns[data.turns.length - 1];
    for (const b of evalPath(j, r.tools.count)) {
      cur.tools++;
      const nm = b && typeof b === 'object' && typeof b.name === 'string' && b.name ? b.name : '?';
      cur.toolNames[nm] = (cur.toolNames[nm] || 0) + 1;
    }
  }
  if (r.turnClose && type === r.turnClose.on && data.turns.length) {
    const cur = data.turns[data.turns.length - 1];
    const fv = firstOf(j, r.turnClose.setFlag);
    if (fv) cur.err = true;
  }
}

function emitGenericTurns(agent, fp, projFallback, data, fromIdx) {
  const idBase = 'g#' + fp.replace(/[\\/:]/g, '~') + '#';
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const total = t.tin + t.tout + t.tcache;
    addEntry(idBase + t.idx, {
      agent, project: data.cwd || projFallback, session: path.basename(fp).replace(/\.[^.]+$/, ''),
      time: t.time, dur: Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total,
      ctx: windowOf(t.models), ctxUsed: t.ctxUsed || null,
      rounds: t.calls, tools: t.tools, calls: t.calls,
      models: modelList(t.models), preview: t.preview,
      // 同 claude：转录没有「轮结束」标志，后面还有轮 = 确定结束；最后一轮由页面按最后活动时间兜底
      finished: i < data.turns.length - 1,
      toolNames: t.toolNames || {},
    }, { file: fp, turn: t.idx, kind: 'generic-jsonl' });
  }
}

// onlyFile：分片首扫用（与 scanClaude 同参语义）；不传则整段同步扫完。
export function scanGeneric(agent, conf, root, onlyFile) {
  const compiled = compiledOf(agent, conf);
  const sniff = conf.sniff || {};
  const dirLayout = sniff.dirLayout === 'flat' ? 'flat' : 'claude'; // 认不出的一律按 claude 摆法
  const re = globToRe(sniff.fileGlob) || /\.jsonl$/i;
  let groups = [];   // [{dir, slug, names}]：claude 摆法 slug 目录若干；flat 摆法就一层
  if (dirLayout === 'flat') {
    const names = listDirCached(root);
    if (names) groups.push({ dir: root, slug: path.basename(root), names: names.filter(n => re.test(n)) });
  } else {
    const slugs = listDirCached(root);
    if (slugs) {
      for (const slug of slugs) {
        const dir = path.join(root, slug);
        if (!isDir(dir)) continue;
        const names = listDirCached(dir);
        if (names) groups.push({ dir, slug, names: names.filter(n => re.test(n)) });
      }
    }
  }
  const onlyDir = onlyFile ? path.dirname(onlyFile) : null;
  for (const g of groups) {
    if (onlyDir && g.dir !== onlyDir) continue;
    for (const n of g.names) {
      const fp = path.join(g.dir, n);
      if (onlyFile && fp !== onlyFile) continue;
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) {
        // 重启后 entries 为空但 files 状态被恢复：从状态直接重建条目，不重扫文件（同 scanClaude）
        if (prev.data?.turns?.length && !entriesHasTurn(prev, fp)) emitGenericTurns(agent, fp, g.slug, prev.data, 0);
        continue;
      }
      // 口径守卫：恢复出来的旧状态若不是当前 rules 版本（理论上 loadIndex 已挡），这里再兜一道
      const usable = prev && prev.rr === conf.rulesRev && prev.rh === conf.rulesHash;
      const off = usable ? prev.off : 0;
      const data = usable ? prev.data : { cwd: '', turns: [], emitted: 0 };
      if (s <= off) {
        files.set(key, { agent, kind: 'generic-jsonl', m, s, off, rr: conf.rulesRev, rh: conf.rulesHash, data });
        markKind('generic-jsonl'); continue;
      }
      try {
        const rd = readCompleteLines(fp, off, s);
        if (!rd) {   // 尚无完整行（半行）：只记状态不解析
          files.set(key, { agent, kind: 'generic-jsonl', m, s, off, rr: conf.rulesRev, rh: conf.rulesHash, data });
          markKind('generic-jsonl'); continue;
        }
        const newOff = rd.newOff;
        for (const line of rd.lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          processLine(j, compiled, data);
        }
        files.set(key, { agent, kind: 'generic-jsonl', m, s, off: newOff, rr: conf.rulesRev, rh: conf.rulesHash, data });
        markKind('generic-jsonl');
        emitGenericTurns(agent, fp, g.slug, data, Math.max(0, data.emitted - 1));
        data.emitted = data.turns.length;
      } catch {}
    }
  }
}
function entriesHasTurn(prev, fp) {
  const idBase = 'g#' + fp.replace(/[\\/:]/g, '~') + '#';
  return entries.has(idBase + (prev.data.turns.length - 1));
}

// ---------------- 详情（entryContent 的 generic-jsonl 分支） ----------------
// 用同一套 rules 重读转录文件重建某一轮的正文。能力声明（与受限边界一致）：
//   user / assistant 正文、calls（按 dedupeBy 归并）、tools 入参都给；工具**输出**回填需要
//   跨行配对规则（tool_result → tool_use_id），声明式 schema 里没有 —— 留空，不硬编。
export function genericEntryContent(fp, turn, full, conf) {
  const compiled = { conf };
  const r = conf.rules || {};
  const to = r.turnOpen || {};
  const out = { user: '', assistant: '', tools: [], calls: [], v: null };
  const callByMid = new Map();   // mid -> calls[] 项（同 claude：正文/工具块常不在带 usage 的首条上）
  const textByMid = new Map();
  const texts = [];
  let turnIdx = -1, prevTs = 0, anon = 0;
  let lines;
  try { lines = fs.readFileSync(fp, 'utf8').split('\n'); } catch { return out; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const type = j.type;
    if (type === to.lineType) {
      const text = textFromPath(j, to.textPath);
      if (!text) continue;
      const t0 = String(text).trimStart();
      if ((to.skipIf || []).some(p => t0.startsWith(p))) continue;
      turnIdx++;
      if (turnIdx > turn) break;
      if (turnIdx === turn) {
        out.user = text;
        prevTs = r.ts ? tsOf(firstOf(j, r.ts.path)) : 0;
      }
      continue;
    }
    if (turnIdx !== turn) continue;
    const u = r.usage;
    const modelOn = (r.model && r.model.on) || (u && u.on);
    const assistantLike = (u && type === u.on) || (!u && modelOn && type === modelOn);
    if (assistantLike) {
      const ts = r.ts ? tsOf(firstOf(j, r.ts.path)) : 0;
      const midRaw = u && u.dedupeBy ? firstOf(j, u.dedupeBy) : undefined;
      const mid = midRaw == null || midRaw === '' ? '#' + (anon++) : String(midRaw);
      if (!callByMid.has(mid)) {
        let uv = u && u.path ? (firstOf(j, u.path) || {}) : {};
        if (!(uv && typeof uv === 'object')) uv = {};
        const g = k => (u && u[k] != null ? num(uv[u[k]]) : 0);
        const call = {
          model: r.model ? (modelName(firstOf(j, r.model.path)) || '') : '',
          tin: g('in'), tout: g('out'), tcache: g('cacheRead') + g('cacheCreate'),
          dur: ts && prevTs ? Math.max(0, ts - prevTs) : 0,
        };
        callByMid.set(mid, call);
        out.calls.push(call);
        if (ts) prevTs = ts;
      }
      if (r.assistantText && type === r.assistantText.on) {
        for (const seg of evalPath(j, r.assistantText.path)) {
          const s0 = typeof seg === 'string' ? seg : toText(seg);
          if (!s0) continue;
          texts.push(s0);
          textByMid.set(mid, textByMid.has(mid) ? textByMid.get(mid) + '\n' + s0 : s0);
        }
      }
    }
    if (r.tools && type === r.tools.on) {
      for (const b of evalPath(j, r.tools.count)) {
        out.tools.push({
          name: b && typeof b.name === 'string' && b.name ? b.name : '?',
          tid: b && b.id ? b.id : null,
          input: truncOut(typeof b === 'object' && b ? JSON.stringify(b.input ?? '') : '', full),
          inputTrunc: false, output: '', error: null,
        });
      }
    }
  }
  for (const [mid, call] of callByMid) {
    const seg = textByMid.get(mid);
    if (seg) call.text = truncOut(seg, full);
  }
  out.assistant = texts.join('\n');
  return out;
}
// 详情正文截断（800 字）——与 trunc 同口径但没有 shared 的 flag 对象接线，就地实现
function truncOut(s, full) {
  s = toText(s);
  if (full || s.length <= 800) return s;
  return s.slice(0, 800);
}

// I8 复现包原始片段提取复用：与 processLine 的 turnOpen 分支完全同口径（lineType 命中 &&
// 正文非空 && 不以 skipIf 任一前缀开头）。rules 即 agent 的 rules 对象（conf.rules）。
export function genericTurnStart(j, rules) {
  const r = rules || {};
  const to = r.turnOpen || {};
  if ((j.type || '') !== to.lineType) return false;
  const text = textFromPath(j, to.textPath);
  if (!text) return false;
  const t0 = String(text).trimStart();
  if ((to.skipIf || []).some(p => t0.startsWith(p))) return false;
  return true;
}
