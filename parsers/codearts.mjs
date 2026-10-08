// ---------------- codearts 解析器（%APPDATA%/codearts-agent/User/logs/CodeArts Agent-*.log） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanCodearts。
// 文本日志，opencode 风格事件：
//   【AgentCore question】partsInfo {sessionID, model.modelID, parts[text]}  → 用户开新轮
//   【AgentCore updated tokens】 tokens:[...],"input":N,"output":N,...         → 每次 LLM 调用的 token（跟在 step-finish 后）
//   type: tool info {...}                                                       → 工具调用事件
import fs from 'node:fs';
import path from 'node:path';
import { files, entries, addEntry, toolNameCounts, markKind, listDirCached, readCompleteLines } from './shared.mjs';

const CA_TS = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d{3}/;
const CA_TOKENS = /"input":(\d+),"output":(\d+),"reasoning":(\d+),"cache":\{"write":(\d+),"read":(\d+)\}/;

export function codeartsIdBase(fp) { return 'ca#' + fp.replace(/[\\/:]/g, '~') + '#'; }
function emitCodeartsTurns(agent, fp, data, fromIdx) {
  const idBase = codeartsIdBase(fp);
  for (let i = fromIdx; i < data.turns.length; i++) {
    const t = data.turns[i];
    const total = t.tin + t.tout + t.tcache;
    addEntry(idBase + t.idx, {
      agent, project: 'codearts-agent', session: t.session || path.basename(fp, '.log'),
      time: t.time, dur: Math.max(0, t.lastTs - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total,
      ctx: 0, rounds: t.calls.length, tools: t.tools, calls: t.calls.length,
      models: t.models, preview: t.preview,
      finished: !!t.finished || i < data.turns.length - 1, aborted: !!t.aborted,
      toolNames: toolNameCounts(t.toolList || []),
    }, { file: fp, turn: t.idx, kind: 'codearts' });
  }
}

export function scanCodearts(agent, root, onlyFile) { // onlyFile 见 scanClaude 的说明
  const names = listDirCached(root);
  if (!names) return;
  for (const n of names) {
    if (!/^CodeArts Agent-.*\.log$/i.test(n)) continue;
    const fp = path.join(root, n);
    if (onlyFile && fp !== onlyFile) continue;
    let fst; try { fst = fs.statSync(fp); } catch { continue; }
    const key = fp, m = fst.mtimeMs, s = fst.size;
    const prev = files.get(key);
    if (prev && prev.m === m && prev.s === s) {
      if (prev.data?.turns?.length && !entries.has(codeartsIdBase(fp) + (prev.data.turns.length - 1))) emitCodeartsTurns(agent, fp, prev.data, 0);
      continue;
    }
    const off = prev?.off || 0;
    const data = prev?.data || { turns: [], emitted: 0 };
    if (s <= off) { files.set(key, { agent, kind: 'codearts', m, s, off, data }); markKind('codearts'); continue; }
    try {
      const rd = readCompleteLines(fp, off, s);
      if (!rd) { files.set(key, { agent, kind: 'codearts', m, s, off, data }); markKind('codearts'); continue; }
      const newOff = rd.newOff;
      for (const line of rd.lines) {
        const tsm = line.match(CA_TS);
        const ts = tsm ? Date.parse(tsm[1].replace(' ', 'T')) : 0; // 日志是本地时间
        const cur = data.turns[data.turns.length - 1];
        if (line.includes('【AgentCore question】')) {
          const pi = line.indexOf('partsInfo ');
          let q = null;
          if (pi >= 0) { try { q = JSON.parse(line.slice(pi + 10)); } catch {} }
          const text0 = (q?.parts || []).filter(p => p && p.type === 'text').map(p => String(p.text || '')).join('\n');
          if (!text0) continue;
          data.turns.push({
            idx: data.turns.length, time: ts, lastTs: ts,
            session: q?.sessionID || '', models: q?.model?.modelID ? [q.model.modelID] : [],
            tin: 0, tout: 0, tcache: 0, tools: 0, err: false,
            user: text0.slice(0, 3000), preview: text0.replace(/\s+/g, ' ').slice(0, 300),
            calls: [], toolList: [], finished: false, aborted: false,
          });
        } else if (line.includes('【AgentCore updated tokens】') && cur) {
          const tm = line.match(CA_TOKENS);
          if (tm) {
            const tin = +tm[1], tout = +tm[2], tcache = +tm[4] + +tm[5];
            cur.tin += tin; cur.tout += tout; cur.tcache += tcache;
            cur.calls.push({ model: cur.models[0] || '', tin, tout, tcache, dur: ts && cur.lastTs ? Math.max(0, ts - cur.lastTs) : 0 });
          }
          if (ts) cur.lastTs = ts;
        } else if (line.includes('【AgentCore turn complete】') && cur) {
          cur.finished = true;
        } else if (line.includes('type: tool info') && cur) {
          cur.tools++;
          const tm = line.match(/(?:name|toolName)\s*[:=]\s*["']([^"']+)/i);
          cur.toolList.push({ name: tm ? tm[1] : '?' });
        } else if (line.includes('"session.error"') && cur) {
          cur.err = true;
          cur.finished = true;
        }
        if (cur && ts && ts > cur.lastTs) cur.lastTs = ts;
      }
      files.set(key, { agent, kind: 'codearts', m, s, off: newOff, data });
      markKind('codearts');
      emitCodeartsTurns(agent, fp, data, Math.max(0, data.emitted - 1));
      data.emitted = data.turns.length;
    } catch {}
  }
}
