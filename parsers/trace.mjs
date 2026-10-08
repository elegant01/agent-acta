// ---------------- trace 解析器（sessions/<pid>.json + traces/<pid>/trace_*.json） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanTraces。
// trace 是一次性写入的整文件 JSON（无 off 增量语义，不进 OFF_KINDS，每次启动重扫重建）。
import fs from 'node:fs';
import path from 'node:path';
import { files, pidCwd, addEntry, modelList, listDirCached, isDir } from './shared.mjs';

// agentConfs 由主文件注入（setAgentConfs）——解析器不 import 主文件，避免循环依赖。
let agentConfs = null;
export function setAgentConfs(m) { agentConfs = m; }

export function resolveCwd(agent, pid) {
  const key = agent + '|' + pid;
  if (pidCwd.has(key)) return;
  const sessions = agentConfs?.get(agent)?.sessions;
  if (!sessions) { pidCwd.set(key, '(未知项目)'); return; }
  const fp = path.join(sessions, pid + '.json');
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    pidCwd.set(key, j.cwd || '(未知项目)');
  } catch { pidCwd.set(key, '(未知项目)'); }
}

export function scanTraces(agent, root) {
  const pids = listDirCached(root);
  if (!pids) return;
  for (const pid of pids) {
    const dir = path.join(root, pid);
    if (!isDir(dir)) continue;
    resolveCwd(agent, pid);
    const tnames = listDirCached(dir);
    if (!tnames) continue;
    for (const n of tnames) {
      if (!n.startsWith('trace_') || !n.endsWith('.json')) continue;
      const fp = path.join(dir, n);
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const key = fp, m = fst.mtimeMs, s = fst.size;
      const prev = files.get(key);
      if (prev && prev.m === m && prev.s === s) continue;
      let data = null;
      try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const t = j.trace || {};
        data = {
          pid: t.workerPid || pid, startedAt: t.startedAt ? Date.parse(t.startedAt) : 0,
          dur: t.duration || 0, status: t.status || 'ok', total: t.totalTokens || 0,
          sessionId: t.sessionId || '', prompt: String(t.prompt || '').slice(0, 300),
          name: String(t.name || t.agentName || '').slice(0, 120), nollm: !t.modelInfo,
          models: modelList(t.modelInfo?.models), tin: t.modelInfo?.totalInputTokens || 0,
          tout: t.modelInfo?.totalOutputTokens || 0, tcache: t.modelInfo?.totalCachedTokens || 0,
          calls: t.modelInfo?.callCount || 0,
          tools: (j.spans || []).filter(sp => sp.toolName).length, // 只算有 toolName 的 span（原 spanCount 含非工具 span，虚高）
        };
      } catch { continue; }
      files.set(key, { agent, kind: 'trace', m, s, off: 0, data });
      const cwd = pidCwd.get(agent + '|' + data.pid) || '(未知项目)';
      addEntry('t#' + fp.replace(/[\\/:]/g, '~'), {
        agent, project: cwd, session: data.sessionId || ('pid ' + data.pid),
        time: data.startedAt, dur: data.dur, status: data.status === 'ok' ? 'ok' : 'error',
        tin: data.tin, tout: data.tout, tcache: data.tcache, total: data.total,
        ctx: 0, rounds: null, tools: data.tools, calls: data.calls, // trace 无轮概念，rounds 隐藏
        models: data.models, preview: data.prompt, name: data.name, nollm: data.nollm,
      }, { file: fp, kind: 'trace' });
    }
  }
}
