// ---------------- dsh 型解析器（DeepSeek Harness：sessions/<slug>/<会话目录>/session*.jsonl.zstd） ----------------
// 从 agent-acta-server.mjs 拆出（纯搬家，逻辑零改动）。导出 scanDsh。
//
// 事件流是从 dsh 自己的源码里核出来的（@deepseek-ai/dsh-agent-loop 里逐条 session.append，
// 本机又拿 2 个真实会话逐行验过）。一行一个 {type, seq, time, data}：
//   session            会话头（cwd / createdAt / version / agentPreset）
//   turn/start         一轮开始，data.turn 从 1 起
//   step/start|end     一步。**一轮可以有多步**（模型调工具 → 拿结果 → 再调模型），
//                      所以「轮内调用了几次模型」和「走了几步」是两个数，别混
//   user/message       正文在 data.content[].text。⚠️ **只有 source.kind === 'user' 才是人打的**：
//                      同一条通道还写 agent-instructions（工作区指令）/ skill-catalog（技能目录）/
//                      plugin（审批策略变更通知）以及 tool（工具结果，见下）。
//                      不过滤就会把一整段系统提示当成用户提问，且一轮里挤进来好几条
//   assistant/message  一次**成功提交**的模型调用：正文在 data.message.content[]（text / reasoning /
//                      tool-call 三种块），用量在 data.usage（字段口径见下）
//   assistant/attempt  同一次调用**没提交出消息**时的落法（报错 / 被中断且无可提交内容），
//                      只有 stream 没有 usage —— 与 assistant/message 互斥（源码里是同一个 settle）
//   tool/call|result   工具调用与结果，靠 data.callId / message.content[].toolCallId 配对
//   session/title      会话标题（先落 fallback 的「首条输入」，随后被标题模型的结果覆盖）
//   request/context    **模型 + contextWindow**。dsh 这一路不用查表就有上下文分母（见下）
//
// 用量口径（@deepseek-ai/dsh-llm 的 LlmUsage 注释写明）：inputTokens 是**不含缓存命中**的那部分，
// 缓存命中/写入另算 cacheReadTokens / cacheWriteTokens —— 与 claude / kimi 的口径一致，
// 所以 tin=inputTokens、tcache=cacheRead+Write、上下文占用=三者之和（轮内最后一次胜出，非累加）。
//
// zstd 这一层是**接入 dsh 真正卡住的地方**，单独说清楚：
//   磁盘上是 .zstd，但**不是「一个 zstd 文件」**——dsh 每落一次盘就追加一帧，一个会话几十帧
//   （本机实测 11~19 帧）。而 Node 的 zlib.zstdDecompressSync / createZstdDecompress
//   **只解第一帧就停**：不报错、不继续、也不告诉你后面还有。偏偏第一帧就是那条会话头
//   （解出来 202 字节、1 行）—— 于是「把文件解压开」得到的是 1 行、0 轮，
//   看上去跟完全没有数据一模一样。必须逐帧解（见 dshDecode）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { files, entries, srcs, removedIds, sorted, addEntry, toolNameCounts, modelName, toText, markKind, listDirCached, isDir } from './shared.mjs';
import { dshSessionFile, hasDshSessions } from './discovery.mjs';

const DSH_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);   // zstd 帧头 magic
// Node 22.15+ 才有 zstd 解压；更老的 Node 上仍然要**认得出** dsh（见 hasDshSessions），
// 但扫不出条目 —— 那种机器由诊断直说原因，不静默变成 0 条（见 diagnose）
export const DSH_ZSTD_OK = typeof zlib.zstdDecompressSync === 'function';

// 逐帧解压并拼成完整 JSONL 文本。
//   · 按 magic 找每一帧的起点，逐帧解 —— zstd 帧头里**不写本帧的压缩长度**（只有解压后的长度），
//     所以没法「从上一帧末尾接着读」，只能靠下一个 magic 定位，这也正是逐帧解可行、按偏移续读不可行的原因；
//   · 假命中（magic 恰好出现在压缩数据里）几乎必然解不成 JSON，用「每一行都能 JSON.parse」筛掉；
//   · 半帧（正在写入的那一帧）会直接抛异常，跳过即可 —— 下一轮扫描它写完了自然会被解出来。
function dshDecode(buf) {
  const parts = [];
  for (let i = buf.indexOf(DSH_MAGIC); i !== -1; i = buf.indexOf(DSH_MAGIC, i + 1)) {
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.every(l => { try { JSON.parse(l); return true; } catch { return false; } })) parts.push(text);
    } catch {}
  }
  return parts.join('');
}

export function dshIdBase(fp) { return 'd#' + fp.replace(/[\\/:]/g, '~') + '#'; }

function dshTurn(n, ts) {
  return {
    n, time: ts || 0, lastTs: ts || 0, endTs: 0, steps: 0,
    tin: 0, tout: 0, tcache: 0, calls: 0, ctxUsed: 0, ctx: 0,
    models: [], callList: [], tools: [], byCall: new Map(),
    user: '', texts: [], err: false, errMsg: '', finished: false, aborted: false,
    toolNames: {},
    // 轨迹（R6）：本轮**按真实时间顺序**的事件流，供 /api/entry 输出、页面画时间线。
    //
    // 为什么能这么便宜：下面那个逐行循环本来就按顺序拿得到每个事件的 j.time，
    // 以及 stream[] 的起止（见 assistant/message 分支）。以前只留了轮级的 time/lastTs，
    // 逐事件时间戳、step 边界、工具耗时全被丢掉，而「工具归属哪次 LLM 调用」根本无法还原。
    //
    // 为什么**不用**动 PARSER_REV：dsh 不在 OFF_KINDS 里 —— 本轮的 turns 从不落盘，
    // 每次启动整份重解析，所以加大 events 不会让 index/*.json 膨胀，也不存在
    // 「增量偏移已推到文件尾、改了口径却永不自愈」那个非要 rev 升版才能解的问题。
    events: [],
  };
}

// 会话目录名与文件属主都可能为空，项目名按「会话头里的 cwd（权威）> 目录 slug」取，
// 与 kimi 的 cwdIdx > slug 同思路；cwd 是绝对路径，页面的 projNorm 会把它和别的 agent 的记录并成一项。
function emitDshTurns(agent, fp, data, prevData) {
  const idBase = dshIdBase(fp);
  const ids = new Set();
  data.turns.forEach((t, i) => {
    const id = idBase + t.n;
    ids.add(id);
    addEntry(id, {
      agent, project: data.cwd || data.slug || '(未知项目)', session: data.sessionId || data.sessName || '',
      // I16 子 agent 拓扑：dsh **在会话头里直接写死谱系**（本机 34 个会话实测：30 个 depth=0 无 parent，
      // 4 个 depth=1、parentSession 精确指到父会话 id）。这是**显式字段**，
      // 不是靠时间区间猜的 —— 与前置闸推翻的那条路（[time, time+dur] 嵌套）毫无关系。
      //   · parentSession 是父会话的 `session-<uuid>` 全名，与本解析器落的 session 值同形，能直接对上；
      //   · delegationDepth 是深度（0=人开的，1=子 agent），页面据此决定缩进口径；
      //   · 缺席（老会话/别家）→ undefined → JSON 丢键，页面按「根会话」处理、不编层级。
      parent: data.parentSess || undefined, depth: data.depth || undefined,
      time: t.time, dur: Math.max(0, (t.endTs || t.lastTs) - t.time), status: t.err ? 'error' : 'ok',
      tin: t.tin, tout: t.tout, tcache: t.tcache, total: t.tin + t.tout + t.tcache,
      rounds: t.calls, tools: t.tools.length, calls: t.calls,
      models: t.models, preview: t.preview,
      finished: !!t.finished, aborted: !!t.aborted, toolNames: toolNameCounts(t.tools),
      // ctx 是**源头给的**窗口容量（request/context.contextWindow），不是查表猜的；
      // ctxUsed 是本轮最后一次调用的 prompt 全量。两者都有，页面才画得出真的进度条。
      ctx: t.ctx || data.ctxWin || 0, ctxUsed: t.ctxUsed || null,
      name: data.title || null,
      // 子 agent 的「派活描述」。只有子会话有（descriptor 事件），根会话为 undefined。
      sub: data.subLabel ? data.subLabel : undefined,
      subMode: data.subMode || undefined, subProvider: data.subProvider || undefined,
    }, { file: fp, turn: i, kind: 'dsh' });
  });
  // 会话被重写/截断（比如调用了 compact）时，旧的轮要撤掉，否则新旧并存
  for (const old of prevData?.ids || []) {
    if (ids.has(old)) continue;
    entries.delete(old); srcs.delete(old); removedIds.push(old);
  }
  data.ids = [...ids];
  sorted.cache = null;
}

export function scanDshFile(agent, fp, slug, sessName) {
  let fst; try { fst = fs.statSync(fp); } catch { return false; }
  const key = fp, m = fst.mtimeMs, s = fst.size;
  const prev = files.get(key);
  // 整份重解析 + {mtime,size} 签名跳过没变的文件（与 gemini / cursor 同一路数）。
  // 为什么不走 off 增量：多帧 zstd 没法从任意字节偏移续读（帧长不写在帧头里，见 dshDecode）；
  // 而单份会话解出来也就几十~几百 KB，整份重读比维护帧边界可靠得多（同 §6 的教训）。
  // 顺带这也是「进行中的轮」能自己更新的原因：文件每 flush 一次 size 就变，下一轮扫描重解析。
  if (prev && prev.m === m && prev.s === s) {
    // 文件没变就不重解析 —— 但**条目可能被 LRU 淘汰过**（evictIfNeeded 只删 entries，不动 files）。
    // 不补这一下，被淘汰的轮会一直空着，直到这个会话再写一行才自愈。判据取最后一轮（同 kimi）。
    const last = prev.data?.turns?.[prev.data.turns.length - 1];
    if (last && !entries.has(dshIdBase(fp) + last.n)) emitDshTurns(agent, fp, prev.data, null);
    return true;
  }
  if (!DSH_ZSTD_OK) return true;                  // 老 Node：认得出、解不开，原因由诊断说
  let text;
  try { text = dshDecode(fs.readFileSync(fp)); } catch (e) { console.error('[dsh] read', path.basename(fp), e.message); return true; }
  if (!text) return true;                         // 空文件 / 半个首帧还没写完

  const byNum = new Map();
  const order = [];
  const ensure = (n, ts) => {
    let t = byNum.get(n);
    if (!t) { t = dshTurn(n, ts); byNum.set(n, t); order.push(t); }
    if (ts && (!t.time || ts < t.time)) t.time = ts;
    return t;
  };
  // routeModel 是**路由上**的模型名（request/context），只用来给「没提交出消息的调用」兜底：
  // 失败的那次没有 message.source.model，不留名字的话整轮 models 空着、卡片标题就没模型可显示。
  let cwd = '', sessionId = '', title = '', ctxWin = 0, routeModel = '', cur = null;
  // I16 子 agent 拓扑：这三样全部来自会话头 / subagent 事件，是**源头写死的谱系**（见 emitDshTurns）。
  let parentSess = '', depth = 0, subLabel = '', subMode = '', subProvider = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const d = j.data || {};
    const ts = typeof j.time === 'number' ? j.time : 0;
    // ⚠️ 会话头是**扁平**的（{type,version,id,createdAt,cwd,…}），不像后面的事件那样包在 data 里——
    // 照抄事件那套 `d.cwd` 会永远取到空值，项目名就悄悄退回目录 slug（`--F-centos-next-admin--`），
    // 页面按 projNorm 跟别的 agent 合并项目时也就对不上了。
    // I16：谱系两字段（delegationDepth / parentSession）同样在**扁平**的会话头上，别写成 d.*。
    //（会话头里还有个 origin='subagent'，那只是探针核对该样本时的旁证，解析器不读它 —— 谱系一律以 parentSession 为准。）
    if (j.type === 'session') {
      cwd = j.cwd || ''; sessionId = j.id || '';
      if (j.parentSession) parentSess = String(j.parentSession);
      if (typeof j.delegationDepth === 'number' && j.delegationDepth > 0) depth = j.delegationDepth;
      else if (parentSess) depth = 1;            // 有父没写深度：至少是 1，不编更深的
      continue;
    }
    if (j.type === 'session/title') { if (d.title) title = String(d.title); continue; }
    // 子 agent 的描述符：这是**唯一**能回答「这个子会话是干嘛的 / 怎么起来的」的地方
    //（label 是派活时给的任务名，mode 是 continuable / one-shot，provider 是 spawn / fork）。
    // 只取字符串、截断后随条目下发；子会话本来就有自己的 title，两者互补。
    if (j.type === 'subagent/descriptor') {
      if (d.label) subLabel = String(d.label).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (d.mode) subMode = String(d.mode);
      if (d.provider) subProvider = String(d.provider);
      continue;
    }
    if (j.type === 'subagent/catalog') continue;   // 父侧的子会话清单：父子关系已由子会话头的 parentSession 给出，不重复收
    if (j.type === 'request/context') {
      if (d.contextWindow) { ctxWin = d.contextWindow; if (cur) cur.ctx = ctxWin; }
      const rm = modelName(d.model);
      if (rm) routeModel = rm;
      continue;
    }
    if (j.type === 'turn/start') { cur = ensure(d.turn, ts); cur.ctx = ctxWin; continue; }
    // 带轮号的事件一律按轮号落（不依赖事件顺序）；不带轮号的（user/message 也没有）落到当前轮
    const n = typeof d.turn === 'number' ? d.turn : (cur ? cur.n : 0);
    if (!n) continue;
    const t = ensure(n, ts);
    if (ts) t.lastTs = Math.max(t.lastTs, ts);

    if (j.type === 'step/start') {
      t.steps++;
      t.events.push({ k: 'step', t: ts || t.time, n: typeof d.step === 'number' ? d.step : t.steps, ph: 'start' });
      continue;
    }
    // step/end 以前**没有任何分支接**（直接落空），轨迹要靠它定「这一步到哪结束」
    if (j.type === 'step/end') {
      t.events.push({ k: 'step', t: ts || t.time, n: typeof d.step === 'number' ? d.step : null, ph: 'end' });
      continue;
    }
    if (j.type === 'turn/end') {
      t.endTs = ts || t.lastTs;
      t.finished = true;
      // 状态只看**这一轮的结局**（turn/end 的 reason）。不看中途的 assistant/attempt：
      // 一次失败的调用会被 dsh-llm-retry 重试，重试成功后这一轮是 completed —— 按 attempt 判错会把好轮标红。
      const kind = d.reason?.kind || '';
      if (kind && kind !== 'completed' && kind !== 'max-tokens') {
        if (/abort|cancel|interrupt/i.test(kind)) t.aborted = true;
        t.err = true;
        t.errMsg = d.reason?.error?.message || d.reason?.reason?.message || d.reason?.message || '';
      }
      t.events.push({ k: 'end', t: ts || t.lastTs, reason: kind });
      if (cur === t) cur = null;
      continue;
    }
    if (j.type === 'system/message') {
      // 轨迹里只留一个「这一步注入了多长的系统提示」的锚点，**正文不存**：
      // 它是整段提示词，而 t.user / t.texts / t.tools 已经占着内存，再存一份不划算。
      t.events.push({ k: 'sys', t: ts || t.time, len: toText(d.message?.content).length });
      continue;
    }
    if (j.type === 'user/message') {
      // 只认人打的（见文件头那段）：agent-instructions / skill-catalog / plugin / tool 全跳过
      if (d.source?.kind !== 'user') continue;
      const s0 = toText(d.content).trim();
      if (!s0 || t.user) continue;                // 一轮只取第一条（后续同轮的多半是注入物）
      t.user = s0;
      t.events.push({ k: 'user', t: ts || t.time });
      continue;
    }
    if (j.type === 'assistant/message' || j.type === 'assistant/attempt') {
      // 一次**已结算**的模型调用（提交出消息的算 message，报错/中断没消息的算 attempt）。两者互斥。
      // attempt 也计入：不然一轮全是失败（本机那个会话 4 轮全 405）会显示「0 次调用」，
      // 看着像解析器没接上，而实际上确实调了 4 次、只是都失败了。
      t.calls++;
      const u = d.usage;
      if (u) {
        const inNow = u.inputTokens || 0;
        const cache = (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
        t.tin += inNow;
        t.tout += u.outputTokens || 0;
        t.tcache += cache;
        // 上下文占用 = **这一次**请求的 prompt 全量（与 claude / kimi 同口径：轮内最后一次胜出，不是累加）
        const ctxNow = inNow + cache;
        if (ctxNow > 0) t.ctxUsed = ctxNow;
      }
      const mdl = modelName(d.message?.source?.model) || routeModel;
      if (mdl && !t.models.includes(mdl)) t.models.push(mdl);
      if (Array.isArray(d.message?.content)) {
        for (const b of d.message.content) if (b && b.type === 'text' && b.text) t.texts.push(String(b.text));
      }
      // 每次调用单独一行明细（卡片上「N 次 LLM」点开的那个表）：耗时取这次流式本身的跨度
      let lo = 0, hi = 0;
      for (const st of d.stream || []) {
        for (const v of [st?.time, st?.time0]) {
          if (typeof v !== 'number') continue;
          if (!lo || v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      t.callList.push({
        model: mdl || '(未知模型)',
        tin: u?.inputTokens || 0, tout: u?.outputTokens || 0,
        tcache: (u?.cacheReadTokens || 0) + (u?.cacheWriteTokens || 0),
        dur: lo && hi > lo ? hi - lo : 0,
      });
      // 轨迹里把这次调用拆成两段：
      //   ttft = 首个流事件 − 该次调用之前**最近一个事件**的时刻（正常就是同一步的 step/start），
      //          也就是队列 + prefill 的等待；
      //   dur  = 流式本身的跨度，也就是 decode。
      // 两者相加 ≈ 这一步的墙钟，零头是收尾/落盘。失败调用（assistant/attempt）常常没有 stream，
      // 两个都是 0 —— 页面必须画占位，不能假装有耗时（对照 callsNote 的处理思路）。
      const prevEv = t.events.length ? t.events[t.events.length - 1] : null;
      t.events.push({
        k: 'llm', t: ts || t.time,
        ttft: lo && prevEv && prevEv.t ? Math.max(0, lo - prevEv.t) : 0,
        dur: lo && hi > lo ? hi - lo : 0,
        model: mdl || '',
        tin: u?.inputTokens || 0, tout: u?.outputTokens || 0,
        tcache: (u?.cacheReadTokens || 0) + (u?.cacheWriteTokens || 0),
        err: j.type === 'assistant/attempt',
        blocks: Array.isArray(d.message?.content) ? d.message.content.map(b => (b && b.type) || '').filter(Boolean) : [],
      });
      if (j.type === 'assistant/attempt') {
        // 把源头给的失败原因原样记下来 —— 否则失败轮在详情里是「0 次调用 + 全 0」，像坏了
        for (const st of d.stream || []) {
          const c = st?.chunk;
          if (c?.type === 'finish' && c.reason?.kind === 'error' && !t.errMsg) {
            t.errMsg = c.reason.failure?.message || '';
          }
        }
      }
      continue;
    }
    if (j.type === 'tool/call') {
      // ct 是这次调用的发起时刻，只给轨迹算工具耗时用（O(1)，不必回头扫 events）。
      // /api/entry 的 tools[] 是**显式白名单**映射，所以 ct 不会漏进接口。
      const tool = { name: d.name || '?', tid: d.callId || null, input: d.arguments, output: '', error: null, ct: ts || 0 };
      t.tools.push(tool);
      if (tool.tid) t.byCall.set(tool.tid, tool);
      // i 是**指向 t.tools 的下标**，不是正文副本：入参/返回正文已经在 t.tools[i] 里，
      // 复制一份会让内存翻倍，还会让 full=1 时出现「事件里是截断的、tools 里是全的」两份真相。
      t.events.push({ k: 'call', t: ts || t.time, name: tool.name, tid: tool.tid, i: t.tools.length - 1 });
      continue;
    }
    if (j.type === 'tool/result') {
      // 结果的正文包在 data.message 里（dsh 内部就是一条 role:'user'、source.kind:'tool' 的消息），
      // 真正的用例挂在 content[].toolCallId 上 —— 与 tool/call 的 callId 配对
      const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
      const tr = blocks.find(b => b && b.type === 'tool-result') || null;
      const tid = tr?.toolCallId || d.message?.source?.callId || null;
      const tool = (tid && t.byCall.get(tid)) || t.tools.find(x => !x.output) || null;
      if (tool) {
        tool.output = tr ? tr.content : d.message;
        tool.error = !!(d.error || tr?.isError);
      }
      // 工具真实耗时 = 结果时刻 − 这次调用的发起时刻（tool.ct）。配不到 → 0，页面画占位。
      //
      // ⚠️ 事件下标**只认 tid 精确配对**，不走上面 tool.output 那个 `find(x => !x.output)` 的兜底：
      // 兜底是为了「有输出的轮别漏掉输出」，用在**归属**上却是错的 —— 它会把这个孤儿结果挂到
      // 第一个「还没输出」的工具上（空字符串输出也满足 `!x.output`，于是能被反复命中）。
      // 本机实测一轮 177 次调用却有 181 条 result，多出来的 4 条就是这么被硬塞进某个工具的。
      // 轨迹宁可如实写「未配对」（i = -1），也不要指错工具。
      const evTool = (tid && t.byCall.get(tid)) || null;
      t.events.push({
        k: 'result', t: ts || t.time, tid,
        i: evTool ? t.tools.indexOf(evTool) : -1,
        dur: evTool && evTool.ct && ts ? Math.max(0, ts - evTool.ct) : 0,
        error: !!(d.error || tr?.isError),
      });
      continue;
    }
  }

  // 轮按号排序后再编号：ord 只用来定位（详情按 src.turn 取 data.turns[i]），序稳、id 稳
  const turns = order.sort((a, b) => a.n - b.n);
  for (const t of turns) {
    t.user = t.user.slice(0, 3000);
    const body = t.texts.join('\n\n---\n\n');
    t.preview = (t.user || body || t.errMsg || '').replace(/\s+/g, ' ').slice(0, 300);
  }
  const data = {
    slug, sessName, cwd, sessionId, title, ctxWin, turns,
    // I16：谱系随 data 一起落（dsh 不进 OFF_KINDS，本就不落 index，这里是给 emit 用的）。
    parentSess, depth, subLabel, subMode, subProvider,
    rev: (prev?.data?.rev || 0) + 1,
  };
  files.set(key, { agent, kind: 'dsh', m, s, off: 0, data });
  emitDshTurns(agent, fp, data, prev?.data);
  return true;
}

export function scanDsh(agent, root) {
  // 配置里的 sessions 可能是**基目录**（~/.dsh）而不是会话目录本身（~/.dsh/sessions）——
  // 手工添加时很容易这么填，而两种填法都得能扫出东西来。所以这里认一次：
  // 根目录下没有会话文件就再往下一层试 <root>/sessions。自动发现给的一律是后者（sniffBase
  // 把 <base>/sessions 填进 sessions 字段），所以这一支只对手工配置生效。
  const dirs = hasDshSessions(root) ? [root] : [path.join(root, 'sessions')];
  for (const dir of dirs) {
    for (const slug of listDirCached(dir) || []) {
      const slugDir = path.join(dir, slug);
      if (!isDir(slugDir)) continue;
      for (const sess of listDirCached(slugDir) || []) {
        const sessDir = path.join(slugDir, sess);
        if (!isDir(sessDir)) continue;
        const fp = dshSessionFile(sessDir);
        if (!fp) continue;
        try { scanDshFile(agent, fp, slug, sess); } catch (e) { console.error('[dsh]', sess, e.message); }
      }
    }
  }
}
