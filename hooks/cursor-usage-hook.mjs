#!/usr/bin/env node
// ---------------- AgentActa × Cursor：逐轮 token 采集 hook ----------------
// 由页面侧栏 cursor 行那个「注入」按钮写进 ~/.cursor/hooks.json（见服务端 /api/cursor-hook）。
// Cursor 在每一轮 agent loop 结束时 spawn 本脚本、把事件 JSON 从 stdin 递进来，本脚本把**用量字段**
// 追加到 ~/.agent-acta/cursor-usage.jsonl，解析器（parsers/cursor.mjs）再把它按会话/轮配对贴回卡片。
//
// 为什么非得走 hook：cursor 的转录文件（agent-transcripts/*.jsonl）里**只有 role + text**，
// 连时间戳都没有；IDE 的 state.vscdb 里 usageData 是空对象、tokenCount 恒为 0。
// 逐轮用量只在这条 hook 载荷里出现（实测字段见下），没有第二条本地来源。
//
// 载荷（stop / afterAgentResponse 同值，只挑 stop 当唯一来源，免得同一个 generation 记两遍）：
//   { hook_event_name, conversation_id, generation_id, model, model_id, model_params,
//     status, loop_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }
// 三条实测口径（都写进解析器注释了，这里只落原始值，不做换算）：
//   1) input_tokens **含** cache_read + cache_write，要减掉才是不重复的「输入」；
//   2) 这几个数是**这一轮**的累计（一轮里所有模型调用加总），不是单次调用；
//   3) token 字段是可选的 —— 老版本 Cursor 没有，缺了就整条不落（宁可不记，也不落一排假的 0）。
//
// 落盘格式（一行一条，供解析器读，不要手改）：
//   {"v":1,"ev":"stop","conv":"<会话id>","gen":"<本轮id>","ts":<毫秒>,"model":"<model_id>",
//    "status":"completed","in":N,"out":N,"cr":N,"cw":N}
//   · conv 就是转录所在目录名（会话 id），两边靠它对上；gen 用来在同一会话里去重（自动续跑会让
//     stop 触发多次、值相同）；ts = 本脚本落盘时刻，解析器按它把用量分派到对应轮。
//
// 三条硬约束（hook 是**旁路**，绝不能拖累 Cursor）：
//   1) **fail-open**：任何异常都吞掉、永远 exit 0、stdout 只吐一个 `{}`。
//      非权限类 hook（stop 就是）退出码非 0 时 Cursor 照常继续，但会记一条 hook 失败日志 ——
//      我们不想让用户在自己的 Cursor 日志里看到我们的报错。
//   2) **绝不阻塞**：stdin 最多等 5s（hooks.json 里给的 timeout 是 10s），到点就按「没数据」收工。
//   3) **只追加、不重写**：追加式落盘，单行写入；并发（多个 Cursor 窗口）也只是多几行，解析器去重。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT_DIR = path.join(os.homedir(), '.agent-acta');
const OUT = path.join(OUT_DIR, 'cursor-usage.jsonl');
const STDIN_WAIT_MS = 5000;
const STDIN_MAX = 256 * 1024;   // 载荷只有几百字节；给个上限纯粹是防呆

const str = v => (typeof v === 'string' ? v : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

function readStdin() {
  return new Promise(resolve => {
    let buf = '', done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(fin, STDIN_WAIT_MS);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { if (buf.length < STDIN_MAX) buf += c; });
      process.stdin.on('end', fin);
      process.stdin.on('error', fin);
    } catch { fin(); }
  });
}

async function main() {
  const raw = await readStdin();
  // 必须剥 BOM：Cursor（Windows）往 stdin 递的 JSON 以 UTF-8 BOM 开头（\uFEFF），
  // 直接 JSON.parse 会抛 "Unexpected token '\uFEFF'"，整个脚本静默不落盘 —— 实测踩过。
  let j = null;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '').trim()); } catch { return; }   // 半截/非法 JSON：当没数据
  if (!j || typeof j !== 'object') return;

  const rec = {
    v: 1,
    ev: str(j.hook_event_name),
    conv: str(j.conversation_id),
    gen: str(j.generation_id),
    ts: Date.now(),
    // model_id 是真模型名（grok-4.6）；model 是带模式后缀的档位名（cursor-grok-4.6-high-fast），
    // 只有当 model_id 缺失时才拿它顶上。
    model: str(j.model_id) || str(j.model),
    status: str(j.status),
    in: num(j.input_tokens), out: num(j.output_tokens),
    cr: num(j.cache_read_tokens), cw: num(j.cache_write_tokens),
  };
  if (!rec.conv) return;                                          // 没有会话 id：配不上任何轮
  if (rec.in == null && rec.out == null && rec.cr == null && rec.cw == null) return;  // 没有用量字段（老版本）

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n', 'utf8');
}

main().catch(() => {}).then(() => {
  // stdout 是给 Cursor 的协议通道（stop 只认 followup_message，这里什么都不返回），
  // 写完再退，免得管道里还没刷出去就被 exit 截掉。
  process.stdout.write('{}\n', () => process.exit(0));
});