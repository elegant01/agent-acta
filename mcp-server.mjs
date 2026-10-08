#!/usr/bin/env node
// agentacta-mcp —— 把 AgentActa 的**只读**查询面包成 MCP server（stdio 传输），让 agent 自己问自己的日志。
//
// 为什么要有它：面板只能「看」，看的前提是人已经知道要看哪一列。而复盘类的提问天然是问句
// （「我上周最慢的一轮是哪一轮」「哪个项目 token 涨得最凶」），拿界面去答就得人肉翻筛子。
// 接成 MCP 之后 claude / cursor / qoder 这些客户端可以直接问，答的每一句都能回溯到条目 id。
//
// 三条硬边界（与项目「本地只读」的定位一致）：
//   1) **只读**。数据全部来自 `agent-acta-server.mjs` 导出的 LIBRO（只读库模式：不落索引、不写配置、
//      不搬数据、不起 HTTP、不抢端口、不挂定时器），工具面里也没有任何写入口。
//   2) **不新增网络出口**。传输只有 stdio —— 客户端 fork 本进程、我们只往 stdout 写协议消息。
//      stdout 是协议通道，所以一行诊断都不许往那儿打（服务端那侧的诊断在只读库模式下走它自己的
//      log() 出口 → stderr，见 core/log.mjs —— 2026-09-29 之前是靠改全局 console 实现的，现在不是了）。
//   3) **不美化口径**。返回的字段与页面/HTTP 接口逐字同源（同一个 filterEntries / dailyAgg / analyzeAgg），
//      截断与上限都要在返回里说清楚（truncated / dropped），宁少不假。
//
// 协议：JSON-RPC 2.0 over stdio，一行一条消息（MCP stdio 传输的现行帧格式）。
// 手工对接（不装客户端也能验）：
//   printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
//     | node mcp-server.mjs
import { LIBRO } from './agent-acta-server.mjs';

const PROTOCOL_SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOL_LATEST = PROTOCOL_SUPPORTED[0];
// 长驻的 MCP 进程要有新日志可问，但每问一次就全量走一遍源目录太憨（本机 5.2K 个目录项）：
// 超过这个年龄才补扫一轮。客户端连着用就是「最多滞后 15 秒」，急用可以显式传 refresh:true。
const REFRESH_TTL_MS = Number(process.env.AGENT_LOG_MCP_TTL_MS || 15000);
const PREVIEW_CHARS = 200;        // 列表里的用户输入摘要（条目里本来就存了 300 字，别再放大）
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_DAYS = 90;          // 按天聚合默认只回最近 90 天（全量 401 天对问句没用，还容易顶到响应上限）
const MAX_CHARS = Number(process.env.AGENT_LOG_MCP_MAX_CHARS || 220000);

const log = (...a) => { try { process.stderr.write('[agentacta-mcp] ' + a.join(' ') + '\n'); } catch {} };
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let lastScanAt = 0;
function ensureFresh(force) {
  if (!force && lastScanAt && Date.now() - lastScanAt < REFRESH_TTL_MS) return;
  const r = LIBRO.refresh();
  lastScanAt = Date.now();
  log('补扫一轮：' + r.scanMs + 'ms / 内存 ' + r.entries + ' 条');
}

// ---------------- 参数与形状 ----------------
const num = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const str = v => (v == null ? '' : String(v));
// 时间范围与页面/HTTP 同一套：range ∈ today|7d|30d，或显式 from/to（YYYY-MM-DD，本地自然日）。
// 两者同给时显式区间优先 —— 这条口径在 filterEntries 里，这里不另判一次。
const filters = a => [str(a.agent), str(a.project), str(a.range), str(a.from), str(a.to)];
const FILTER_PROPS = {
  agent: { type: 'string', description: '只看某个 agent（claude / codex / cursor / trae / qoder-cn …，见 overview）。留空 = 全部' },
  project: { type: 'string', description: '只看某个项目（页面侧栏那个归一化后的名字）。留空 = 全部' },
  range: { type: 'string', enum: ['today', '7d', '30d'], description: '相对范围；与 from/to 二选一，同给时以 from/to 为准' },
  from: { type: 'string', description: '起始自然日 YYYY-MM-DD（本地时区）' },
  to: { type: 'string', description: '结束自然日 YYYY-MM-DD（含当天）' },
  refresh: { type: 'boolean', description: '先补扫一轮再回答（默认只在超过 15 秒没扫时才扫）。刚产生的新日志问不到时用它' },
};
const fmtTime = t => {
  if (!t) return null;
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; };

// 一条轮次（卡片）的稳定子集：字段名与页面/接口一致，不改名、不算第二套口径。
function turnRow(e, withPreview) {
  const row = {
    id: e.id, at: fmtTime(e.time), time: e.time, agent: e.agent, project: e.project,
    session: e.session || null, dur: e.dur || 0, status: e.status || 'ok',
    models: e.models || [], tin: e.tin || 0, tout: e.tout || 0, tcache: e.tcache || 0, total: e.total || 0,
    calls: e.calls || 0, tools: e.tools || 0,
  };
  // token 恒 0 不等于没用量：qoder 走 credits、cursor 的转录里根本没有 usage 字段（见 LOGFORMATS.md）。
  // 这几个键是 undefined 时 JSON 会自动丢掉，所以只在该有条目带它们时才出现在返回里。
  for (const k of ['ctx', 'ctxUsed', 'ctxRatio', 'credits', 'compacts']) if (e[k]) row[k] = e[k];
  if (e.aborted) row.aborted = true;          // 用户打断的一轮：与 status:'error' 是两回事
  if (withPreview) row.preview = clip(e.preview, PREVIEW_CHARS);
  return row;
}

// 响应上限兜底：模型上下文被一次工具调用灌爆是真事故，所以宁可如实截短，也别返回一坨被客户端掐掉的 JSON。
// 只削「行数组」（entries / days / sessions / slowest / models / agents 这些），标量键不动。
function shrinkToFit(payload) {
  let text = JSON.stringify(payload);
  if (text.length <= MAX_CHARS) return payload;
  const lists = Object.keys(payload).filter(k => Array.isArray(payload[k]) && payload[k].length > 1);
  for (const k of lists) {
    const n = Math.max(1, Math.floor(payload[k].length * 0.6));
    if (n === payload[k].length) continue;
    payload[k] = payload[k].slice(0, n);
    payload.truncated = (payload.truncated || []) .concat(k + ' 只保留前 ' + n + ' 条（响应上限 ' + MAX_CHARS + ' 字符）');
    text = JSON.stringify(payload);
    if (text.length <= MAX_CHARS) return payload;
  }
  return payload;
}

// ---------------- 工具面（七个，全只读） ----------------
const TOOLS = [
  {
    name: 'overview',
    description: '先问这个：本机接了哪些 agent、各有多少条、内存窗口多大、归档里还有多少（回答"看不到"之前要用它定位是没扫到还是已被产品删掉）',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const { agents, projects } = LIBRO.counts();
      const confs = LIBRO.agentsList();
      const rows = confs.map(c => ({
        agent: c.name, kind: c.kind, entries: agents[c.name] || 0,
        enabled: c.enabled !== false, missing: !!c.missing, source: c.source,
      })).sort((a, b) => b.entries - a.entries || a.agent.localeCompare(b.agent));
      return {
        version: LIBRO.version, build: LIBRO.build, dataDir: LIBRO.dataDir,
        entries: Object.values(agents).reduce((s, n) => s + n, 0),
        agents: rows,
        projects: Object.entries(projects).sort((a, b) => b[1] - a[1]).slice(0, 30)
          .map(([project, count]) => ({ project, count })),
        projectsTotal: Object.keys(projects).length,
        notes: [
          '内存窗口有条数上限（LRU 淘汰最旧、每个 agent 至少保留最近 200 条），窗口外的历史在归档里：页面「历史归档」可查（本工具面暂未提供归档查询）',
          'token 为 0 不代表没消耗：qoder 走 credits、cursor 的转录里没有 usage 字段、部分 agent 只给模型名不给逐次用量',
          'preview 只是用户输入的前 300 字；正文与工具入参出参要用 get_entry',
        ],
      };
    },
  },
  {
    name: 'search_entries',
    description: '按 agent/项目/时间范围列轮次卡片（一行 = 一轮请求），可按 preview 文本粗筛；要正文与工具输出用 get_entry',
    inputSchema: {
      type: 'object', properties: {
        ...FILTER_PROPS,
        text: { type: 'string', description: '在「用户输入摘要」里做子串匹配（大小写不敏感）。⚠ 不是全文检索：助手正文与工具输出不在索引里' },
        status: { type: 'string', enum: ['any', 'ok', 'error'], description: '只要成功轮 / 只要失败轮（默认 any）' },
        slowest: { type: 'boolean', description: '按耗时降序给（默认按时间倒序）' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: '最多返回多少条（默认 50）' },
      },
    },
    run: a => {
      const { list, rb } = LIBRO.filterEntries(...filters(a));
      const kw = str(a.text).trim().toLowerCase();
      let rows = list;
      if (kw) rows = rows.filter(e => String(e.preview || '').toLowerCase().includes(kw));
      if (a.status && a.status !== 'any') rows = rows.filter(e => (e.status || 'ok') === a.status);
      const sortedRows = a.slowest ? [...rows].sort((x, y) => (y.dur || 0) - (x.dur || 0)) : rows;
      const limit = num(a.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      return {
        rangeLabel: rb ? rb.label : '全部时间',
        matched: rows.length, returned: Math.min(limit, sortedRows.length),
        order: a.slowest ? 'dur desc' : 'time desc',
        entries: sortedRows.slice(0, limit).map(e => turnRow(e, true)),
      };
    },
  },
  {
    name: 'get_entry',
    description: '取一轮的详情：用户输入、助手正文、工具调用（入参/出参/是否报错）、逐次调用；id 来自 search_entries 或 slowest_turns',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: '条目 id（形如 agent:file:turn）' },
        full: { type: 'boolean', description: 'true = 不截断长正文与工具输出（响应会明显变大）' },
      },
      required: ['id'],
    },
    run: a => {
      const e = LIBRO.entry(str(a.id));
      if (!e) return { ok: false, error: '没有这个条目 id（可能已被内存窗口淘汰；用 search_entries 重新取）' };
      const content = LIBRO.entryContent(str(a.id), !!a.full) || { note: '详情取不到：源文件已变化或已被产品删除（这一轮的列表字段仍然有效）' };
      return { ok: true, entry: turnRow(e, true), src: LIBRO.srcOf(str(a.id)) || null, content };
    },
  },
  {
    name: 'list_sessions',
    description: '按会话归组给轮次级汇总（一个会话 = 同一 agent + 项目 + session 标识），用来回答「那次会话烧了多少 / 花了多久 / 有没有失败轮」',
    inputSchema: {
      type: 'object', properties: {
        ...FILTER_PROPS,
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: '最多返回多少个会话（默认 30，按最后活跃倒序）' },
      },
    },
    run: a => {
      const r = LIBRO.sessionsAgg(...filters(a), num(a.limit, 30, 1, MAX_LIMIT));
      return {
        rangeLabel: r.range, matched: r.count, returned: r.sessions.length,
        sessions: r.sessions.map(s => ({
          session: s.key, agent: s.agent, project: s.project, name: s.name || null,
          turns: s.turns, firstAt: fmtTime(s.from), lastAt: fmtTime(s.to),
          dur: s.dur, tin: s.tin, tout: s.tout, tcache: s.tcache, total: s.total,
          calls: s.calls, tools: s.tools, models: s.models, status: s.status, hasTimeline: !!s.hasTimeline,
        })),
      };
    },
  },
  {
    name: 'usage_stats',
    description: '用量聚合：by=day 给自然日序列（含空天，时间轴不被压扁），by=model 给按模型的 token/耗时/条数；回答「这周比上周多花了多少」这类对比',
    inputSchema: {
      type: 'object', properties: {
        ...FILTER_PROPS,
        by: { type: 'string', enum: ['day', 'model'], description: '分桶维度（默认 day）' },
        last: { type: 'integer', minimum: 1, maximum: 400, description: 'by=day 只回最近 N 个自然日（默认 90，更早的如实标 dropped）' },
        top: { type: 'integer', minimum: 1, maximum: 200, description: 'by=model 只回前 N 个模型（默认 20，按合计 token 倒序）' },
      },
    },
    run: a => {
      const f = filters(a);
      if (str(a.by) === 'model') {
        const m = LIBRO.modelAgg(...f);
        const top = num(a.top, 20, 1, 200);
        // 行里的 label 是「组内条目最多的写法」（显示名），names 是同一模型的全部写法（大小写差异已归并）
        const models = m.models.slice(0, top).map(x => ({
          model: x.label, spellings: x.names.length > 1 ? x.names : undefined,
          count: x.count, tin: x.tin, tout: x.tout, tcache: x.tcache, total: x.total,
          dur: x.dur, calls: x.calls, tools: x.tools, credits: x.credits || 0,
          agents: x.agents,
        }));
        return {
          by: 'model', range: m.range, matched: m.count,
          dropped: Math.max(0, m.models.length - models.length),
          noModel: m.noModel, noModelTotal: m.noModelTotal, multi: m.multi,
          totals: m.totals, models,
        };
      }
      const d = LIBRO.dailyAgg(...f);
      const last = num(a.last, DEFAULT_DAYS, 1, 400);
      const days = d.days.slice(-last).map(x => ({
        day: x.day, count: x.count, tin: x.tin, tout: x.tout, tcache: x.tcache, total: x.total,
        dur: x.dur, maxDur: x.maxDur, calls: x.calls, tools: x.tools, agents: x.agents,
      }));
      return {
        by: 'day', rangeLabel: d.label, from: d.from, to: d.to,
        dropped: Math.max(0, d.days.length - days.length), daysCapped: d.daysCapped || 0,
        days, totals: d.totals,
      };
    },
  },
  {
    name: 'slowest_turns',
    description: '时延画像：最慢轮 TopN + p50/p95（同一套筛选口径，不吃条/页窗口），用来找「哪一轮卡住了」',
    inputSchema: {
      type: 'object', properties: {
        ...FILTER_PROPS,
        topN: { type: 'integer', minimum: 1, maximum: 100, description: '最慢前 N（默认 10）' },
      },
    },
    run: a => {
      const r = LIBRO.analyzeAgg(...filters(a), num(a.topN, 10, 1, 100));
      return {
        matched: r.count, p50: r.p50, p95: r.p95, maxDur: r.maxDur,
        slowest: r.slowest.map(e => ({ ...turnRow(e, true), at: fmtTime(e.time) })),
      };
    },
  },
  {
    name: 'tool_fails',
    description: '工具失败画像：哪个工具最常失败 / 超时（按失败次数倒序，附失败率与样本下限）+ 逐 agent 的覆盖度。' +
      '超时算失败（fail = err + timeout）；软失败（rg 没搜到这类被判定为正常的结果）单列一档、不进失败率；' +
      '源里没有超时/软失败这一层的 agent 出 null 而不是 0 —— 别把「源里没这层」读成「从没超时」',
    inputSchema: {
      type: 'object', properties: {
        ...FILTER_PROPS,
        top: { type: 'integer', minimum: 1, maximum: 100, description: '只回前 N 个工具行（默认 10，按失败次数倒序）' },
      },
    },
    run: a => {
      const r = LIBRO.analyzeAgg(...filters(a), num(a.top, 10, 1, 100));
      const tf = r.toolFails;
      const unknown = tf.agents.reduce((s, c) => s + (c.unknown || 0), 0);
      const sig = tf.agents.filter(c => c.tsSig).map(c => c.agent);
      const notes = [];
      if (!tf.agents.length) notes.push('这次筛选里没有带工具调用的轮 ⇒ 画像是空的，别读成「零失败」');
      if (tf.building) notes.push('后台正在建索引：画像不全，「已核对」还会往上涨，别现在下结论');
      if (unknown > 0) notes.push('有 ' + unknown + ' 轮带工具调用但还没索引到：它们既不算分子也不算分母' +
        '（画像读的是搜索分片，本进程只读、不建索引，常驻服务建好那份才看得见）');
      // 只列**带**这一层的 agent（通常两三家）：列反了就是每次调用都甩一长串名字，把 context 占掉。
      // 逐 agent 的 tsSig 在 agents[] 里都有，这里只是把结论先说出来。
      if (tf.agents.length && sig.length < tf.agents.length) notes.push(sig.length
        ? '这些 agent 源里带超时/软失败这一层：' + sig.join('、') +
          '；其余 agent 没有超时/软失败这一层，它们的 timeout/soft 出 null（不是 0）'
        : '本次筛选里的 agent 都没有超时/软失败这一层（源里没这个信息），timeout/soft 全是 null —— 不是 0');
      notes.push('fail = err + timeout（超时算失败）；soft 单列、不进失败率；total 低于 minTotal 的行 lowDenom=1，率别当结论');
      return {
        matched: r.count, minTotal: tf.minTotal, totals: tf.totals,
        totalKinds: tf.totalKinds, truncated: tf.truncated,
        rows: tf.rows, agents: tf.agents, building: tf.building, notes,
      };
    },
  },
];

// ---------------- 协议处理 ----------------
let clientInfo = null;

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const want = str(params?.protocolVersion);
      const protocolVersion = PROTOCOL_SUPPORTED.includes(want) ? want : PROTOCOL_LATEST;
      clientInfo = params?.clientInfo || null;
      log('握手：客户端 ' + (clientInfo?.name || '?') + ' ' + (clientInfo?.version || '?') + '，协议 ' + protocolVersion);
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-acta', version: LIBRO.version, title: 'AgentActa 本地 agent 日志（只读）' },
        instructions: '数据是本机各 AI agent 的会话日志（只读）。回答任何一条结论都要能指回条目 id：先 overview 看清有哪些 agent，' +
          '再 search_entries / usage_stats / slowest_turns / tool_fails 收窄，最后 get_entry 取证。' +
          'token 为 0 别直接说「没花钱」（见 overview.notes）；问「哪个工具最常超时/失败」用 tool_fails，' +
          '它的 timeout/soft 为 null 表示源里没这一层、不是 0。',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;                                   // 通知不带 id，也不该有响应
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = str(params?.name);
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) return replyErr(id, -32602, '没有这个工具：' + name);
      const args = params?.arguments || {};
      try {
        ensureFresh(args.refresh === true);
        const out = shrinkToFit(tool.run(args));
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], isError: false });
      } catch (e) {
        // 工具执行失败按 MCP 口径回 isError（不是 JSON-RPC error）：让模型看见原因、自己改问法
        log('工具 ' + name + ' 失败：' + e.message);
        return reply(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true });
      }
    }
    default:
      // 未实现的可选面（resources / prompts / logging）一律明确拒绝，别静默吞：
      // 客户端拿不到答复会重试到超时，报错反而一眼看出「这个 server 只提供 tools」。
      if (id == null) return;
      return replyErr(id, -32601, '不支持的方法：' + method + '（本 server 只提供 tools：' + TOOLS.map(t => t.name).join(', ') + '）');
  }
}

// ---------------- 主流程 ----------------
// 先扫一轮再挂 stdin：扫描期间进来的消息由内核缓冲，Node 在读侧没挂 handler 时不会丢，
// 这样模型的第一条 initialize 不会撞上「还没数据」。
const opened = await LIBRO.open();
lastScanAt = Date.now();
log('只读库就绪：' + opened.agents + ' 个 agent / ' + opened.entries + ' 条 / 首扫 ' + opened.scanMs + 'ms / 数据目录 ' + opened.dataDir);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('忽略一行非 JSON（' + line.length + ' 字符）'); continue; }
    if (Array.isArray(msg)) { for (const m of msg) handle(m); continue; }   // 批量请求
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));   // 客户端关掉管道 = 本进程没有存在的理由
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
