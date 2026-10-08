// ---------------- KiloCode（Kilo CLI）SQLite 解析器 ----------------
// 数据源：~/.local/share/kilo/kilo.db（明文 SQLite，WAL 模式；本机实测 Windows 也在这个 XDG 路径，
// 既不是 %APPDATA%\kilo 也不是 ~/.kilo）—— 同目录另有 kilo.db-wal / kilo.db-shm、log/、repos/、storage/。
//
// ⚠️ Kilo 是 OpenCode 的 **fork**（本机 log/ 目录里直接叫 opencode.log），schema 与口径实测完全同构：
//   session / message(data JSON) / part(data JSON) + event / event_sequence 是同一套；
//   kilo_board / kilo_board_message（多 agent 协作板）与 session_context_epoch 是 kilo 自家扩展表；
//   Kilo 保留了 opencode 的扩展表（credential / project_directory / session_input / session_message），
//   这点与 mimocode 相反（mimocode 把它们换成了 history_fts_idx / actor_registry 等）。
//   从目录结构看也是 opencode 那套：storage/session_diff/ses_*.json 是文件式 diff 存储。
//
// 所以核心解析**不重复实现**，直接用 opencode.mjs 的家族共享实现（opencodeFamilyApi）。
// 复用前已核对口径真的相同（本机实测样本 ses_f2ec0aeb0ffeupLomLTPbkTn7t，5 步 assistant）：
//   每条 message.data.tokens 是**该次调用**的用量（input 逐条递增是上下文在长，不是累计），
//   逐条相加 == session 表的聚合值：
//     input 16979+17163+17715+21306+26213 = 99376 = session.tokens_input ✓
//     output 304 / reasoning 1142 同样对得上 ✓
//   轮语义也一致（一条 user message 开一轮，轮内多条 assistant message = 多步工具循环 → rounds）。
//
// 唯一必须自己处理的是**认领**（见 discovery.mjs）：kilo.db 满足 opencodeDbVerify 的全部五个条件，
// 光按表认会被 opencode 探针接走（本机实测），所以 kilo 有自己的独有表判据 KILO_ONLY_TABLES，
// 且 sniffBase 里排在 opencodeDbFile 之前；opencodeDbVerify 也反向排除了 kilo 的独有表。
//
// 不在 OFF_KINDS 里（SQLite 是实时写入的活源，按字节偏移续读不可靠；同 opencode/zcode/dsh）：
// 每次启动整份重解析，库没变时按 {mtime,size} 签名跳过。PARSER_REV['kilo'] 仍然登记 —— 它在这里
// 不管 index 落盘（本 kind 不落），管的是 ~/.agent-acta/search/ 全文索引分片的作废。
import { opencodeFamilyApi } from './opencode.mjs';

export const kiloScanErr = new Map();

// idPrefix 必须与 opencode 的 'oc#' 错开：两家若被指到同一个库（手工误填），
// 前缀相同会让后扫的那家把前一家的条目按 id 顶掉。
const family = opencodeFamilyApi({
  kind: 'kilo',
  idPrefix: 'kl#',
  tag: '[kilo]',
  errMap: kiloScanErr,
  verPrefix: 'kl',
});

export function scanKilo(agent, dbPath) { return family.scan(agent, dbPath); }
export function kiloEntryContent(src, full) { return family.entryContent(src, full); }
