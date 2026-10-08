# AgentLog —— 支持的日志格式与解析边界

本文件收录各 agent 日志格式的字段口径、解析边界与踩坑记录（拆自 REFERENCE.md 的「支持的日志格式」章节）。
速查与使用说明见 README.md，完整口径与排障见 REFERENCE.md。

## 格式总览

| agent | 日志位置 | 结构 | 粒度 | 耗时 | token |
|---|---|---|---|---|---|
| atomcode | `~/.atomcode/sessions` | `<hash>/<uuid>.meta` + `.jsonl` | 轮；**开了 datalog 就能下钻到每次调用** | ✅ 轮级 | ✅ 轮级汇总；datalog 给逐次真实账 |
| claude | `~/.claude/projects/<slug>/*.jsonl` | 每消息一行 | 轮（按 user 消息聚合） | ⚠️ 相邻时间戳推算 | ✅ 逐请求累加 |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 事件流（**用户输入有两种落点**，见下） | 轮（task_started 分界） | ✅ 时间戳差值 | ✅ 逐次调用 |
| codearts | `%APPDATA%/codearts-agent/User/logs` | 文本日志 | 轮 | ✅ | ✅ |
| codebuddy / workbuddy | `~/.codebuddy/projects`、`~/.workbuddy/projects` | `<slug>/<会话 id>.jsonl`，每事件一行 | 轮（按 user 消息聚合） | ✅ 轮级 `durationMs` | ✅ 逐次调用累加（含缓存） |
| gemini | `~/.gemini/tmp/<项目 slug>/` | `chats/session-*.jsonl`（会话正文，**新版 CLI 的行式格式**）+ `logs.json`（提示词流水，兜底） | 轮（按 user 消息聚合） | ✅ 时间戳差值 | ✅ 会话文件里有；仅剩 logs.json 的老会话没有 |
| cursor | `~/.cursor/projects/<项目 slug>/agent-transcripts/<会话 id>/<同名>.jsonl`（也认平铺的 `agent-transcripts/<名>.jsonl`） | 每行 `{role, message}`，只有 text 块；新版另有 `<timestamp>` 与 `turn_ended` | 轮（按 user 消息聚合） | ❌ `dur` 恒为 0（源里的逐轮时间戳对不齐，见下面 cursor 一节）；**轮时间**另取新版每条 user 开头的 `<timestamp>`，老版退回转录文件 mtime | ❌ 没有（模型名与上下文占用另从 Cursor IDE 的 `state.vscdb` 取，见下）；**逐轮 token 只能靠注入 `stop` 钩子采**（侧栏 cursor 行的图标按钮，采到才有，见下面 cursor 一节） |
| kimi | 三份根，见下面那段：`~/.kimi-code/sessions/…`、`~/.kimi/sessions/…`、桌面版 `<shareDir>/…/runtime/kimi-code/home/sessions/…` | `wire.jsonl` 事件流（`turn.prompt` 开轮 → `context.append_loop_event` 记工具调用 → `usage.record` 记 token） | 轮（`turn.prompt` 分界） | ✅ 轮内首末事件的时间差 | ✅ 按 `usageScope=turn` 的 `usage.record` 累加；每轮的上下文占用取**最后一次调用**的 prompt 全量 |
| dsh（DeepSeek Harness） | `~/.dsh/sessions/<项目 slug>/<会话目录>/` | `session.v<N>.jsonl.zstd`（**名字里的版本 dsh 自己升，实测 v3 → 2026-09-28 起 v4，取版本最高的一份**）—— **zstd 多帧拼接**的 JSONL 事件流（`turn/start` 开轮 → `assistant/message` 记正文与用量 → `tool/call`/`tool/result` 记工具） | 轮（`turn/start` 分界；一轮可含多步） | ✅ 轮内首末事件的时间差 | ✅ `assistant/message` 的 `usage`；每轮的上下文占用取**最后一次调用**的 prompt 全量 |
| doubao（豆包 Work 智能体） | `%LOCALAPPDATA%\DoubaoWork\User Data\Default\.doubaowork\agent_mode\workspace\.sessions\<会话 id>\agents\<agent id>\system\trajectory.jsonl` | OpenAI 风格逐行消息（`{role: user/assistant/tool, content, tool_calls}`） | 轮（role=user 开轮，其后 assistant/tool 归本轮） | ⚠️ 转录无时间戳，取同目录 `assignment.md` 的「## [时间] 需求」按**规范化文本**对齐（匹配不到 → 0，页面显示「—」） | ❌ 转录不落盘 token/模型（恒 0、模型留空，详情 callsNote 说明）；工具出入参按 `tool_call_id` 回填 |
| minimax（MiniMax Mavis 本地运行时） | `~/.minimax/v2/sessions/YYYY/MM/DD/<HH-MM-SS-mmm-session_<id>>/messages.jsonl` | 每消息一行（Anthropic 风格 wrapper：`{message_id, turn_id, message:{…}}`）；同目录 `manifest.json` / `llm-call.json` | 轮（`message.role=user` 开轮，同 `turn_id` 的多 assistant/toolResult 归本轮） | ⚠️ 取下一轮 user 时间差（末轮 0）；**逐次调用耗时源头不落盘**，`calls[].dur` 恒 0 | ✅ assistant 行 `message.usage`（**`tin = input` 直接取——input 不含 cache**，tcache=cacheRead）；ctx 分母 = 同目录 `llm-call.json` 的 `maxTokens`（128000） |
| mimocode（记忆/检查点类 agent） | `~/.local/share/mimocode/mimocode.db`（Drizzle/SQLite，**真源**）；`memory/` 下那些 `checkpoint.md`/`notes.md`/`MEMORY.md` 是库导出的展示层，仅作库读不动时的只读兜底 | SQLite：`session`(一次会话) / `message`(一条消息，**不是一轮**，`data` 含 `role`/`time.{created,completed}`/`tokens.{input,output,reasoning,cache}`/`cost`/`finish`/`error`；**assistant 的模型在顶层 `modelID`/`providerID`，user 才是 `model.{providerID,modelID}`**) / `part`(`data.type` ∈ text/reasoning/tool/step-start/step-finish；tool 碎片带 `callID`/`tool`/`state.{status,input,output}`/`time.{start,end}`) / `project`(`worktree`) | 轮（**一条 user `message` 开一轮**，其后所有 assistant `message` 并入该轮 —— 与 opencode 同款；首条非 user 也算一轮） | ✅ 轮内最早 `message.data.time.created`（**毫秒，原样透传**，与全项目 13 位毫秒口径一致） | ✅ 逐次累加：`tin=Σtokens.input` / `tout=Σ(tokens.output+reasoning)` / `tcache=Σ(cache.read+cache.write)` / `total` 优先取库自带 `tokens.total`（实测 = input+output+reasoning+cache）；`rounds=calls=`轮内 assistant message 数，`tools=`轮内 tool 碎片数，`state.status==='error'` 的碎片 → 轮 `status='error'`；`dur` = 轮内 (最晚 completed − 最早 created)，**毫秒**（与 claude/opencode 同口径，页面 `fmtDur` 按毫秒读）；`models` 取轮内 assistant 顶层 `modelID`（缺则 user 的 `model.modelID`）；`nollm` = 轮内无 assistant（用户刚发问）；详情 `user` **剥掉 `<system-reminder>` 注入块**（真用户输入常只有注入块的百分之一），`calls[]` 给逐次 LLM 调用明细；`ctx` 恒 0（库里没有窗口字段，页面按查表退化）。库读不动时回退 markdown 层（token/工具恒 0，详情 `note` 说明）。⚠️ **`PARSER_REV.mimocode` 管的是搜索分片**（本 kind 不落 index），改轮口径必须 bump 它 —— 否则老分片按旧 `turn` 下标返回错轮的正文且不会自愈 |
| openclaw（OpenClaw） | `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl`（`stateDir` 默认 `~/.openclaw`，老版本 `.clawdbot`，`OPENCLAW_STATE_DIR` 可整体改写） | 追加式**会话树**逐行 JSON：首行会话头（`{"type":"session","version":3,…}`）→ `message` 行（user/assistant/toolResult）→ `session_info`/`model_change`/`custom`/`compaction` 等标记行 | 轮（`message.role=user` 且正文非空开轮，下一条 user 收轮；空用户消息不开轮） | ⚠️ 轮级 = 下一轮 user 时间差（末轮 0）；转录不落逐次调用耗时，`calls[].dur` 恒 0 | ✅ assistant 行 `message.usage`（**`tin = input` 直接取 —— 源码写死 input 不含 cache**，`tcache = cacheRead+cacheWrite`）；ctx 分母 = 同 agent `agent/models.json` 里该模型的 `contextWindow`（取不到 → 0，退化为只显示占用） |
| copilot（GitHub Copilot CLI） | `~/.copilot/session-state/<sessionId>/events.jsonl`；同根 `session-store.db` + WAL | 每行一个结构化事件：`session.start` / `user.message` / `assistant.message` / `assistant.turn_end`；用量库为 `assistant_usage_events` | 轮（`turnId` 分组） | ✅ 事件时间戳；SQLite 用量表补逐次 duration/TTFT | ✅ `assistant_usage_events` 的 input/output/cache/reasoning；库不可读时正文仍可显示 |
| cline（Cline CLI 3.x） | `<data>/sessions/<会话 id>/<会话 id>.messages.json`（data 根默认 `~/.cline/data`；`CLINE_DATA_DIR` / `CLINE_SESSION_DATA_DIR` 可改写） | **整份 JSON 文档**（`{version, updated_at, agent, sessionId, messages[], system_prompt}`，会话进行中每次落盘**整体重写**，不是 JSONL） | 轮（`role=user` **且** content 里有非空 `text` 块才开轮 —— ⚠️ `tool_result` 也是 `role:user`） | ✅ 轮内末条 `ts` − 轮首 `ts`（逐次调用耗时不落盘，`calls[].dur` 恒 0；逐工具耗时能算） | ✅ assistant 消息的 `metrics`（⚠️ **`inputTokens` 含缓存** ⇒ `tin = input−cacheRead−cacheWrite`、`tcache` = 两个 cache 桶，与 openclaw 相反）；`ctx` 恒 0（模型目录只嵌在二进制里）；失败只有 `tool_result.content[]` 的**逐项** `success`/`error` |
| buddyext（CodeBuddy 的 **genie 扩展** —— 与上一行同一个 `codebuddy` agent，挂在它的 `sessionsExtra` 上；VSCode / CodeBuddyIDE / JetBrains 与 CodeBuddy CN 应用共用） | `%LOCALAPPDATA%\CodeBuddyExtension\Data\<acct>\<Host>/(<acct>/)?history\<wsKey>\<会话 id>\`（`<Host>` ∈ VSCode / CodeBuddyIDE / JetBrains；`<acct>` = `default` 或 36 位 uuid，**uuid 时同一串再重复一层**） | **每个会话一份 `index.json`**（`{messages[], requests[]}`，会话进行中**整份重写**）+ `messages/<消息 id>.json` **一条一个文件**（`{role, message(JSON 字符串), extra(JSON 字符串), createdAt?}`）；同级还有工作区级 `index.json` 供会话名 | 轮（**轮 = `requests[]` 的一项**，产品自己记的，不靠 role 猜） | ✅ `request.startedAt` → 该轮最晚消息时间戳。消息时间戳三取：`createdAt`(ISO) → `extra.responseId` 前 14 位（**本地时间**）→ `gen-<epoch 秒>`；⚠️ **绝不用文件 mtime** —— 整份重写会把一批消息文件的 mtime 拍平到同一瞬间（实测 mtime 差 2ms 而内容差 84s） | ✅ `request.usage`（⚠️ **`inputTokens` 含缓存**，与 cline 同、与 openclaw 相反 ⇒ `tin = input−cacheTokens−cachedWriteTokens`、`total = totalTokens = Σ 各步`）；`ctxUsed = lastTokens`；逐次 token+耗时取新版每条 assistant 的 `extra.statsSnapshot`（老方言没有 ⇒ `calls[].tin` 留 null 不印假 0）；`ctx` 恒 0；失败 = `tool-result` 的 `result.status==='error'`（`cancelled` 记中断、`skipped` 两头都不记） |
| trace（其它走 span 的 agent） | `<base>/sessions` + `<base>/traces` | span 模型 | 每次 Agent workflow | ✅ 现成 duration | ✅ modelInfo 汇总 |
| zcode（ZCode CLI） | `~/.zcode/cli/db/db.sqlite`（WAL 模式的 SQLite 库，**不是文件树**） | `session` / `message`(data JSON) / `part`(data JSON) / `session_input` / `tool_usage` / `model_usage` / `turn_usage` 七张表 | 轮（role=user 的 message 开轮，与 `turn_usage.user_message_id` 天然对齐） | ✅ `turn_usage` / `model_usage` / `tool_usage` 的真实起止时间（含 TTFT=`first_token_at−started_at`） | ✅ `turn_usage` 轮级账（缺行回退 `model_usage` 求和）；上下文占用 = 最后一次调用的 input+cache |
| opencode（OpenCode CLI/桌面） | `~/.local/share/opencode/opencode.db`（**明文** SQLite + WAL，不需要密钥/解密） | `session` / `message`(data JSON) / `part`(data JSON) + `event`·`event_sequence`（事件投影，不作第二数据源） | 轮（role=user 的 message 开轮；其后每条 assistant message = 一次 LLM 调用） | ✅ 消息 `time.created/completed` 差值；工具取 `state.time.{start,end}` | ✅ 每条 assistant message 的 `tokens`（input/output/reasoning/cache）逐次求和；上下文占用 = 最后一次调用的 input+cache |
| kilo（KiloCode CLI） | `~/.local/share/kilo/kilo.db`（**明文** SQLite + WAL，不需要密钥/解密；opencode 的 fork，schema/口径同款） | `session` / `message`(data JSON) / `part`(data JSON) + `event`·`event_sequence`（事件投影，不作第二数据源）+ **自有扩展表** `kilo_board` / `kilo_board_message`（判据用；`session_context_epoch` 两家都有，**不算**） | 轮（同 opencode：role=user 的 message 开轮；其后每条 assistant message = 一次 LLM 调用） | ✅ 同 opencode：消息 `time.created/completed` 差值；工具取 `state.time.{start,end}` | ✅ 同 opencode：每条 assistant message 的 `tokens`（input/output/reasoning/cache）逐次求和；上下文占用 = 最后一次调用的 input+cache |
| hermes（Hermes Agent） | Win=`%LOCALAPPDATA%\hermes\state.db`，mac/Linux=`~/.hermes/state.db`（`HERMES_HOME` 可整体改写）；**明文** SQLite + WAL | `sessions` / `messages`（OpenAI 风格行）/ `session_model_usage`（按 task 分行，含 title_generation 辅助调用，不作正文源）+ 辅源同目录 `logs/agent.log` | 轮（user 行开轮；只取 `active=1` 且非 `_compressed_summary` 的行） | ✅ 轮起止取消息时间戳差（DB 是秒、出门统一毫秒）；调用耗时取日志 `latency=`，工具 = tool 行 − 调用行 | ⚠️ **逐轮 token 只在 agent.log**（`API call #N` 行，`in` 含 cache）；日志滚掉 → 该轮 0 token、`_usage_anchor` 只兜每会话最后一轮。失败轮 = assistant 行 `finish_reason=NULL`，错误原文也只来自日志 |
| devin（Devin CLI，库内 `backend_type='windsurf'`） | Win=`%APPDATA%\Devin\cli\sessions.db`，mac/Linux=`~/.local/share/devin/cli/sessions.db`；**明文** SQLite + WAL | `sessions`(一行一会话) / `message_nodes`(**消息森林**：`node_id`/`parent_node_id` + `chat_message` JSON 列) / `tool_call_state`(工具状态，另有空的 `prompt_history`/`rendered_commits`/`subagent_heads`) | 轮（user 节点开轮，**只走 `sessions.main_chain_id` 主线**；`role='tool'` 按 `tool_call_id` 回填，`role='system'` 跳过） | ✅ 轮起止取 `chat_message.metadata.created_at`（**ISO 纳秒，截到毫秒**；列 `created_at` 所有行同值不可用）；调用 `metrics.total_time_ms`/`ttft_ms`，工具 `chisel/tool_call_timing.duration_ms` | ✅ `chat_message.metadata.metrics` 的 `input_tokens`（**不含 cache**）/`output_tokens`/`cache_read_tokens`/`cache_creation_tokens` 逐次求和；上下文占用 = 最后一次调用的 input+cache_read+cache_creation；`ctx` 恒 0 |
| tracecode / traework | `%APPDATA%\Trae CN\logs\<启动时间戳>\window1\renderer.log`（TraeWork 走 `%APPDATA%\Trae Work\` 或 `%APPDATA%\Trae SOLO\`） | 文本日志（每行一条 `[ai-chat/v2] [Handler] message {json}`） | 轮（每个 `MetadataHandler received metadata` 开一轮，与 claude/codex 同款） | ⚠️ `chat_start_time` 与 `DoneHandler` 行时间戳的差值 | ❌ **renderer.log 不含 token 用量**（`fee_usage` 恒为 null，计费在后端）；calls 固定 1（每轮一次 LLM 调用，无独立 token_count 事件）。**R23 起是回退源**：SQLCipher 库读不出来时才用它（见下方 traedb 一节） |
| traedb（Trae CN / Trae Work 的 SQLCipher 库） | `<产品根>\ModularData\ai-agent\database.db`（**SQLCipher 4.x 加密**的 SQLite 库；产品根 = `%APPDATA%\Trae CN` / `%APPDATA%\Trae Work`） | `chat_session` / `chat_turn`（一轮一行）/ `chat_message_general`·`chat_message_task`·`chat_message_chat`（正文）/ `server_history_info`（逐次调用）/ `project` / `fts_session_title` | 轮（`chat_turn` 一行 = 一轮） | ✅ 轮起止取 `turn.context` 的 chat 时间；工具逐个取 `plan_item.timing` 的真实耗时 | ✅ `server_history_info` 的 `exact_*` 精确用量（逐次求和）；上下文占用与窗口分母都有（`prompt_max_tokens`）。**需要 `traeKey`**（见下），没配时回退 renderer.log |

## copilot（GitHub Copilot CLI）

> **真正的会话数据不在 `ide/*.lock`。** `~/.copilot/ide/<uuid>.lock` 只是 VS Code/MCP 通信锁；打开 Copilot CLI 并发送消息后，正文会写入
> `~/.copilot/session-state/<sessionId>/events.jsonl`，同根的 `workspace.yaml` 保存工作目录/标题。
>
> `events.jsonl` 里的 `user.message.data.content` 是用户原文，`assistant.message.data.content` 是 AI 输出，
> `data.model` 是模型，`data.turnId` 是轮次键。`transformedContent` 含系统注入，不作为用户输入。
> `assistant.message.data.toolRequests` 可提供工具名和入参；无法从事件配对到返回值时不虚构工具输出。
>
> token 和逐次耗时优先从同根 `session-store.db` 的 `assistant_usage_events` 读取：
> `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `reasoning_tokens` / `duration_ms` / `time_to_first_token_ms`。
> 数据库用只读模式打开，WAL 变化会触发重新聚合；数据库不存在或暂时不可读时，正文条目仍保留，只缺用量补充。
>
> 解析器按 `sessionId + turnId` 生成稳定条目，完整正文留在内存快照供 `/api/entry` 详情读取；尾部半行 JSON 会等下一轮补全后再解析。
> 首版不把 Copilot 宣称为逐事件时间轴 agent，避免把普通事件时间戳误画成精确的工具/流式轨迹。


## zcode（ZCode CLI）

> **会话不在工作区里。** ZCode 不像 claude 那样在 workspace 写逐行 jsonl —— 所有会话集中写在
> **用户级** SQLite 库 `~/.zcode/cli/db/db.sqlite`（WAL 模式，旁边常有 `db.sqlite-wal` / `db.sqlite-shm`）。
> 症状是「聊了几轮、手动添加 agent 却检测不到日志」：扫目录树的嗅探永远看不到库里的数据。
> 1.8.4 起接入，认的就是这个库本身（`sniffBase` 接受 db.sqlite 文件 / db 目录 / cli 目录 / `~/.zcode` 基目录四种填法）。
>
> **只读纪律**：一律 `{readOnly:true}` 打开（`node:sqlite`，与 cursor 的 `state.vscdb` 共用加载器），
> 查完即关，绝不执行任何写操作。库被独占锁定 / 损坏 / schema 变了 → 保留上一轮读到的数据，
> 原因写进「环境诊断」（`zcodeScanErr`），不崩不误报。
>
> **增量**：SQLite 没有字节偏移语义，且 WAL 模式下新数据先落在 `db.sqlite-wal`（库文件本身的 mtime 不动），
> 所以签名 = **db 与 wal 两个文件的 {mtime,size} 四元组**，变了才整份重解析。库很小（本机 <1MB），
> 与 gemini/dsh 同属「整份重解析 + 签名跳过」一路 —— zcode 不在 `OFF_KINDS` 里，也不需要 `PARSER_REV`。
>
> **切轮与关联**（本机实测 schema）：
> - 一个 `role=user` 的 message 开一轮，其后 assistant 归这一轮；`turn_usage.user_message_id` 正好是同一个键。
> - 首个 user 之前的 assistant 序章消息、以及「只挂 timeline/reasoning 标记、没有任何内容」的轮**不灌条目**
>   （真库每个会话都有一条这种序章，留着就是全空卡片）。
> - 轮级 token/耗时/状态以 `turn_usage` 为准；缺行（老版本/中断）回退到 `model_usage` 求和。
>   `tout` 含 `reasoning_tokens`，`tcache` = cache_read + cache_creation。
> - 工具：part `type=tool` 给入参/返回（`state.input`/`state.output`），`tool_usage` 给真实耗时/退出码/错误，
>   靠 `tool_call_id ↔ callID` 配对；只有指标没有 part 的（或反之）都各自保留。
> - 逐次 LLM 明细：`model_usage` 每行一次调用，`assistant_message_id` 指回那条 message，
>   它的 text parts 就是「本次输出」。
> - 用户输入兜底：user message 没有 text part 时取 `session_input` 的 `payload.text`
>   或 `payload.conversationInputIntent.text`（靠 `promoted_message_id` 关联）。
> - 子 agent 会话（`session.parent_id` 非空）独立成行，标题带 `⤷ ` 前缀，不并入父会话（不重复计 token）。
>
> **逐事件时间线**（`EVENT_AGENTS` 第二个成员）：`model_usage.started_at/first_token_at/completed_at`
> 直接给 TTFT 与流式解码段，`tool_usage.started_at/completed_at/duration_ms` 给工具起止 ——
> 不需要像 dsh 那样从流式 chunk 推。失败调用没有 `first_token_at`，画占位（同 dsh 约定）。
>
> **非文本 part**：`step-finish`（带这步的 token 账，压成一行 JSON）、`reasoning`（只留长度锚点，
> 正文可能是整段思考且 metadata 常带签名 junk）、`timeline`（模型切换等）、**未知类型与损坏 JSON**
> 一律进详情的「其他事件」块（结构化 JSON，截到 2000 字）——未知内容不静默丢弃。
> `step-start` 是纯顺序占位（`{"type":"step-start"}`），只转成时间线的 step 事件，不进 others。
>
> **时间字段**一律是 Unix epoch 毫秒（`time_created` / `started_at` 等），为空按 0 处理、排序退回
> `sequence`（解析侧另有防御：sequence 非数字时退回 time_created）。
> 上下文窗口容量源头没有 → 卡片只显示占用（ctxUsed），不画进度条（同 cursor 缺分母的处理）。
> `cli/log/*.jsonl` 与 `cli/rollout/*.jsonl` 是运维流水与模型 IO 副本，**不接**（主源是库）。

## opencode（OpenCode）

> **会话不在工作区里，也不需要解密。** OpenCode（CLI / 桌面版）把全部会话集中写在
> `~/.local/share/opencode/opencode.db` —— 一个**明文** SQLite 库（页头就是 `SQLite format 3`，
> 与 traedb 那种 SQLCipher 加密库不是一回事）。WAL 模式下旁边常有 `opencode.db-wal` / `-shm`：
> 本机实测主库本体只有 4 KB、真正的新数据全在 1.7 MB 的 WAL 里 —— **只拷主库会一条都看不到**，
> 读取必须把两者当一个整体（`node:sqlite` 只读打开时自动重放 WAL，服务侧不需要自己解析 WAL）。
>
> **判据是内容，而且要比 zcode 更严**：OpenCode 与 ZCode 的库**都有** `session` / `message` / `part`
> 三张表，只看这三张必然互相误认。区分点是各自独有的表 —— OpenCode 独有 `event` + `event_sequence`
> （事件投影），ZCode 独有 `turn_usage` / `model_usage` / `tool_usage`。所以 `opencodeDbVerify()` 要求
> 五张表齐（并先验 `SQLite format 3` 页头），且在 `sniffBase()` 里排在 zcode 分支**之前**。
> 同名但不是这个结构的普通 SQLite 库一律不认（回归测试里有一条专门的断言守着）。
>
> **增量**：SQLite 没有字节偏移语义，签名 = db 与 `-wal` 两文件的 `{mtime,size}` 四元组，变了才整库重读。
> 库很小（本机 <2 MB），整份重读比维护水位线可靠；opencode **不进 `OFF_KINDS`**，
> 每次启动重建，因此**不需要 `PARSER_REV`**（与 zcode / gemini / dsh / traedb 同一路数）。
>
> **只读纪律**：`DatabaseSync(..., {readOnly:true})` 打开、查完即关；不执行 checkpoint、不写任何 pragma。
> 库被独占锁定 / 损坏 / schema 变了 → 保留上一轮读到的数据，原因写进「环境诊断」（`opencodeScanErr`），
> 不崩、不误报成「未安装」。
>
> **切轮与字段口径**（对照真实库与本机样本验证）：
> - 一个 `role=user` 的 message 开一轮，其后的 assistant message 都归这一轮；
>   会话头若有 user 之前的 assistant，单列一个 `pre#<消息 id>` 的序章轮，不丢内容。
> - 每条 assistant message = **一次 LLM 调用**：`modelID` / `providerID` 给模型与来源，
>   `tokens.{input,output,reasoning,cache.read,cache.write}` 给本次用量，
>   `time.{created,completed}` 给本次起止，`finish`（`stop` / `tool-calls` / `error`…）给收尾状态。
> - 轮级 token = 逐次调用求和（`tin = Σinput`、`tout = Σ(output+reasoning)`、`tcache = Σ(cache.read+cache.write)`）；
>   上下文占用 `ctxUsed` = **最后一次调用**的 `input + cache`（与 claude / kimi / zcode 同口径，不是求和）。
> - 正文与工具在 `part.data`：`text` 给用户输入（role=user）与 AI 输出（role=assistant），
>   `tool` 给工具（`tool` 名、`callID`、`state.input`/`state.output`/`state.status`，
>   耗时优先取 `state.time.{start,end}`，缺失时退回该 part 行的 `time_created/time_updated`）。
> - TTFT = 本轮**最早一段内容**（`reasoning` 或 `text`）的 `time.start − message.time.created`：
>   只认 text 的话，"先思考再回答"的那种调用 ttft 会被算成接近总耗时，看着像没有排队时间。
> - `reasoning` 正文不混进 assistant 输出（与其它 agent 一致），但**保留进详情的「其他事件」**；
>   `step-start` 转成时间线的 step 事件，`step-finish`（带这步的 token 账）压成一行 JSON 进 others。
> - **未知类型的 part 与损坏 JSON 一律进 others**（截到 2000 字），不静默丢弃，也不拖垮整个会话。
> - 子会话（`session.parent_id` 非空）独立成行，标题带 `⤷ ` 前缀，不并入父会话（不重复计 token）。
> - 项目取 `session.directory`（缺失回退 `session.path`）；标题取 `session.title`。
> - 全空的轮（只有 user 消息、没有任何 part 与 assistant）不灌条目 —— 那是"打开了没说话"的噪音。
> - 上下文**只有占用没有分母**：源头没有窗口容量字段（`session` / `message.tokens` 里都没有），
>   所以卡片只显示 `ctxUsed`、不画进度条（与 zcode / cursor 缺分母时的处理一致）。
> - 已知边界：用户输入只看 user 消息的 text part；`session_input.prompt`（排队输入）**不接** ——
>   实测该表在有数据的库里是空的，正文都在 part 里，接它反而有把排队输入错配到轮次上的风险。
>
> **逐事件时间线**（`EVENT_AGENTS` 第四个成员）：user 开轮 → 逐次 llm（带 ttft 与流式解码段）
> → 工具 call/result（与 `tools[]` 同下标 `i`）→ end 收轮，schema 与 dsh / zcode / traedb 完全一致。
>
> **事件投影（`event` / `event_sequence`）不接**：它存的是同一份状态的事件流（`session.updated.1`
> / `message.updated.1` / `message.part.updated.1`），与 `message` / `part` 表内容重叠；
> 把它当第二条数据源会重复计调用与工具。它只作为**判据**的一部分（见上）。

## kilo（KiloCode）

> **契约的 fork，不是新格式。** KiloCode CLI 的库在 `~/.local/share/kilo/kilo.db`
> （XDG 路径，Windows 上也在 `~/.local/share` 下，与 opencode / mimocode 同款），
> **明文** SQLite + WAL，页头就是 `SQLite format 3`。它的日志目录里也有 `opencode.log`——
> 这就是它同源的直接证据。`session` / `message` / `part` 三张表连同字段形态、
> `role=user` 开轮、assistant message = 一次 LLM 调用、`tokens.{input,output,reasoning,cache}`
> 逐次求和的**口径与 opencode 逐字一致**（拿真实库对照过：库自带会话聚合
> `tokens_input/output/reasoning` 与逐条 message 求和分毫不差）。
> 因此解析层**不重复实现**——`parsers/kilo.mjs` 只是一层薄壳，通过
> `opencodeFamilyApi(fam)` 复用 `parsers/opencode.mjs` 的同一份核心（切轮、token、工具、时间线全同）；
> 差异只在描述符：`kind='kilo'`、id 前缀 `kl#`、版本前缀 `kl`、独立的 `kiloScanErr`。
>
> **判据必须双向排他**（本格式最需要小心的地方）：opencode 的判据（五张表 `session`/`message`/
> `part`/`event`/`event_sequence` 齐）在 kilo.db 上**同样为真**——kilo 保留了这些表。
> 所以只靠 opencode 判据会把 kilo 认成 opencode。区分点是 **kilo 独有的表**：
> `kiloDbVerify()` 要求核心三表齐 **且** 命中 `KILO_ONLY_TABLES`（`kilo_board` / `kilo_board_message`）之一；
> 同时给 `opencodeDbVerify()` 加了反向排除（表里出现 `kilo_board*` 就不是 opencode）。
> `sniffBase()` 里 kilo 分支排在 opencode **之前**（先认 fork、再认本体），两条判据在真实库上互为假。
>
> ⚠️ **坑：`session_context_epoch` 不能当 kilo 独有表**。它名字看着像 kilo 新增，但**真实
> opencode.db 里也有这张表**——把 `KILO_ONLY_TABLES` 加进它就等于让 `kiloDbVerify(真 opencode.db)=true`，
> 而 kilo 又先判，会**静默抢走真 opencode 的会话**。所以判据只认 `kilo_board` / `kilo_board_message`。
> 同理，kilo **保留**了 opencode 的 `credential` / `project_directory` / `session_input` / `session_message`，
> 这些**不能**用作判据（两边都有）。
>
> **增量与 rev**：与 opencode 完全同路数——签名 = `kilo.db` 与 `-wal` 的 `{mtime,size}` 四元组，
> 变了才整库重读（WAL 重放交给 `node:sqlite`）；**不进 `OFF_KINDS`**，每次启动整库重建，
> 不靠 `PARSER_REV`。`PARSER_REV.kilo=1` 只登记用来作废搜索分片（本 kind 不落 index），
> 与 opencode 一致：改轮口径要 bump 它，否则老分片按旧 `turn` 下标返回错轮正文。
> 只读纪律同 opencode：`DatabaseSync(..., {readOnly:true})`、查完即关、不 checkpoint；
> 读失败（独占锁/损坏）保留上轮数据并把原因写进 `kiloScanErr`，不崩、不误报「未安装」。

## hermes（Hermes Agent）

> **会话集中在一个明文 SQLite 库**：Windows 原生 = `%LOCALAPPDATA%\hermes\state.db`，
> mac / Linux / WSL2 = `~/.hermes/state.db`（源码 `hermes_constants.py` 核实），
> `HERMES_HOME` 环境变量可把整个 home 改写 —— 自动发现把该变量也列为候选根。WAL 模式，
> 判据 = `SQLite format 3` 页头 + `sessions` / `messages` / `session_model_usage` 三张独有表
> （与 zcode / opencode 的 `session/message/part` 单数命名错开，见 `hermesDbVerify`）。
>
> **双源口径（这个格式独有）**：DB 里有正文、工具、会话级 token 聚合，但**没有逐轮/逐次 token**
> （`messages.token_count` 恒 NULL，`sessions` 只有会话累计）。逐次调用的唯一来源是同目录
> `logs/agent.log` 的 `API call #N: model=… in=… out=… latency=…s cache=R/A … upstream=…` 行：
> - `in` **含** cache（= DB 的 input+cache_read 口径），所以 `tin = in − cache`、`tcache = cache`、
>   逐轮上下文占用 = 轮内最后一次调用的 `in`。
> - `#N` 跨轮累加、title_generation 这类辅助调用不打这行 —— 所以**按时间戳落在轮窗口内归属**，不看序号。
>   轮窗口刻意做成互不重叠（宁可少计一次也不双计，双计 = token 虚增更难查）。
> - `upstream=` 是网关后的真实模型，`sessions.model` 只是预设名（如 `nous/welcome`）。
> - 日志会滚动：读不到的轮退回「调用数 = assistant 行数、token 0」，`model_config._usage_anchor`
>   只兜给该会话**最后一轮**的 ctxUsed —— 宁可缺，不给每轮摊假数。
>
> **切轮与字段口径**（真库 schema v30 核验）：
> - user 行开轮；**只取 `active=1` 且 `_compressed_summary=0` 的行** —— compaction 把旧行置
>   `active=0`、摘要伪装成 user 注入，混进来就是幽灵轮次。空 user 行不开轮。
> - 失败轮：assistant 行内容是合成的 "Your request was not processed…"、`finish_reason=NULL`，
>   **DB 里没有任何失败标记**；错误原文只来自 agent.log 的 `API call failed after N retries.` 行，
>   详情按 callsNote 带出。
> - `session_model_usage` 按 task 分行（title_generation 是独立辅助调用），sessions 行级聚合不含它 ——
>   所以逐会话 token 直接读 sessions 行即可，碰 usage 表反而会把标题调用混进来；该表在解析里**不读**，
>   只作判据。
> - 工具：assistant 行 `tool_calls`（JSON 串）给出入参，`role='tool'` 行按 `tool_call_id` 回填返回与耗时；
>   `tool_name` 列只在 tool 行有，中间 assistant 行没有（不可靠，配对只认 id）。
> - 子会话 = `sessions.parent_session_id` 非空，独立成行带 `⤷ ` 前缀。项目取 `sessions.cwd`，
>   标题取 `sessions.title`。
>
> **两个真库踩过的坑**（fixture 都有断言钉住）：
> - `messages.timestamp` 是 REAL **epoch 秒** —— 条目/事件/耗时的全站口径是毫秒，出门统一 ×1000，
>   否则页面按毫秒 from/to 一筛就恒空（症状：侧栏有计数、列表 0 条）。
> - `agent.log` 是 **CRLF**：JS 的 `.` 不认 `\r`、`$` 也不认行尾 `\r`，按 `\n` 切行会让
>   `(.*)$` 这种行尾锚定正则整档恒不命中（token 全 0 且无报错）—— 必须 `split(/\r?\n/)`。
>
> **增量与只读纪律**同 opencode：签名 = state.db + `-wal` + `logs/agent.log` 三文件的 {mtime,size}，
> 变了整库重读；`{readOnly:true}`；锁定/损坏时保留上一轮数据、原因写进「环境诊断」（`hermesScanErr`）。
> 不进 `OFF_KINDS` / `PARSER_REV`。逐事件时间线为 `EVENT_AGENTS` 第五个成员。

## devin（Devin CLI）

> **会话集中在一个明文 SQLite 库**：Windows 原生 = `%APPDATA%\Devin\cli\sessions.db`，
> mac / Linux = `~/.local/share/devin/cli/sessions.db`。WAL 模式、不加密，判据 = `SQLite format 3` 页头
> + `sessions` / `message_nodes` / `tool_call_state` 三张独有表（见 `discovery.mjs` 的 `devinDbVerify`）。
> 库内 `sessions.backend_type` 是 `'windsurf'`（Devin CLI 装在原 Windsurf 的应用目录下），所以侧栏图标复用
> `vendor/svg/windsurf.svg` —— 本机 `E:\Devin` 全树只有 VS Code 自带的文件类型图标，没有独立 Devin 品牌图；
> 侧栏名按其产品名挂 `devin`（历史保留名 `windsurf` 留给原产品，不混用）。
>
> **消息是一棵森林，不是一张表**（这个格式最容易踩的一处）：`message_nodes` 靠 `node_id`/`parent_node_id`
> 连成树，`sessions.main_chain_id` 指向当前分支的叶节点，沿 `parent_node_id` 回溯再反转就是这一会话的**主线**。
> 本机实测 261 个节点里只有 164 个在主线，余下全是「重新生成」留下的旁支（第一条 user 消息有 #2/#9/#16 三份、
> 还有一份被顶掉的回复），旁支与主线共享前缀 —— **整表扫会把同一轮算三遍**（token 与工具全虚高）。
> 所以解析只走主线：从 `main_chain_id` 回溯取链、反转成时序。
>
> **切轮与字段口径**（真库核验）：
> - user 节点开轮 → 其后的 assistant 节点累加 → 下一条 user 收轮。一次 assistant 节点 = **一次 LLM 调用**
>   （与 hermes 的一行日志一次调用同构），它可能带 0..N 个 `tool_calls`（实测有 2 个的）
>   ⇒ `calls` 数 = assistant 节点数、`tools` 数 = `tool_calls` 总数。
> - `role='tool'` 节点按 `tool_call_id` 回填上一条 call 的返回；中间穿插的 `role='system'` 节点
>   （`<additional_metadata>` 之类注入）跳过；assistant 的 `thinking` 不是正文，进 `others[]`。
> - 收轮判据 = assistant 的 `metadata.finish_reason === 'stop'`（工具轮是 `'tool_calls'`）。
> - 模型名在**每次调用**的 `metadata.generation_model`（会话行的 `sessions.model` 只是同一份预设），
>   两者取到哪个用哪个；会话项目取 `sessions.working_directory`、标题取 `sessions.title`。
> - `hidden=1` 的会话**不过滤**（本机无样本；静默丢数据比多一行更难查）。
> - `subagent_heads` 本机为空，不做子会话展开；主线上的子 agent 调用与返回本身仍带可见活动。
>
> **token 与时间口径**（逐次精确值都在库里，**不需要辅助日志** —— 这点与 hermes / minimax 不同）：
> - `chat_message.metadata.metrics`：`input_tokens`（**不含 cache**，与 minimax 同款，别照抄 hermes 的
>   「input 含 cache」） / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens`。
>   `tin = input_tokens`、`tout = output_tokens`、`tcache = cache_read`（+ creation 计入 tcache 侧）。
> - 逐轮聚合 = 轮内各次相加；**上下文占用 `ctxUsed` = 轮内最后一次调用的 input + cache_read + cache_creation**；
>   窗口容量源头没有 ⇒ `ctx` 恒 0（不编分母，页面按查表退化）。
> - 轮起止取 `chat_message.metadata.created_at`（ISO-8601 **纳秒**、UTC）；调用耗时取 `metrics.total_time_ms`、
>   TTFT 取 `metrics.ttft_ms`；工具耗时取 `chisel/tool_call_timing.duration_ms`。
>
> **两个真库踩过的坑**（fixture 都有断言钉住）：
> - **`message_nodes.created_at`（列）不可用**：整库所有行同值（是写入时刻不是消息时刻）。真正的时间只在
>   `chat_message.metadata.created_at` 里；且它是**纳秒精度**字符串，`Date.parse` 只认到毫秒、多出的小数位
>   在部分运行时上直接 NaN ⇒ 必须截到 3 位再解析（`isoMs`），否则条目全落 1970。
> - **根目录那批 py 探针说「token 大多是 null、只在服务端」是错的**：它们的 `copy_db.bat` 只拷了 `sessions.db`、
>   没拷 `-wal`，读到的是过期快照。真库 `metadata.metrics` 每次调用都齐。
>
> **失败判据**：工具失败在本轮工具行上（`chisel/tool_result_meta.success === false`，与 `tool_call_state` 的
> `status='failed'` 一一对应），**只给那个工具打 ✗**，不把整轮染红（跑错一条命令在 devin 里太常见）。
> 轮级 `error` 只留给「这一轮一次都没结算」（后面还有新轮却没有任何带 metrics 的调用 ⇒ 没拿到模型回复）；
> 被下一条 user 顶掉但调用是结算过的 ⇒ 用户打断（`aborted`，页面灰显「已打断」，不算失败）。
>
> **增量与只读纪律**同 hermes / opencode：签名 = `sessions.db` + `-wal` + `-shm` 三文件的 {mtime,size}
> （主库在 WAL 模式下可能长时间不动，新行只进 `-wal`），变了整库重读、没变跳过；`{readOnly:true}`；
> 锁定/损坏时保留上一轮数据、原因写进「环境诊断」（`devinDbErr`）。内存态、不落 index，
> 故不进 `OFF_KINDS` / `PARSER_REV`。回归见 `test/devin-test.mjs`。

## traedb（Trae CN / Trae Work 的 SQLCipher 会话库）

> **Trae 的完整会话数据不在 renderer.log 里，在 SQLCipher 加密的 SQLite 库里**：
> `<产品根>\ModularData\ai-agent\database.db`（产品根 = `%APPDATA%\Trae CN` / `%APPDATA%\Trae Work`）。
> renderer.log 只有事件骨架（谁提问、调了什么工具、结束状态）——**没有 token、没有 AI 正文、
> 没有逐次调用**；这张库什么都有：逐轮精确的 prompt/completion/cache 用量（`server_history_info.extra_info`
> 的 `exact_*`）、工具调用的入参与返回（`chat_message_task` 的 plan_item JSON）、每轮用户输入与最终回答、
> 项目路径、会话标题。差异不是「多一点少一点」，是「整张卡片从空的变成满的」。
>
> **密钥与回退**：库密钥是 raw-key 模式的 32 字节（64 位十六进制），配置在 agent 的 `traeKey` 字段
> （抓取办法见 REFERENCE.md「Trae 的 SQLCipher 库」一节）。**没配 / 配错 / 库正在被重写** → 自动回退
> renderer.log 骨架解析（同一个 agent 名下接着用，不另起 agent、不换 kind 名），诊断页写明回退原因；
> 库能读时反过来清掉日志侧的旧条目 —— 两套源**永不同时在线**（同时在线就是每轮两张重复卡片）。
> 老配置（kind 还是 tracecode/tracework）在库里就认到 database.db 时自动迁移成 traedb。
>
> **SQLCipher 解密**（纯 JS 零依赖，`parsers/traedb.mjs`）：页 4096 字节，page1 头 16 字节 salt 明文、
> 其余整页 AES-256-CBC；尾 80 字节 = IV(16) + HMAC-SHA512(64)，HMAC 覆盖密文+IV+页号。参数有一张小矩阵
> （kdf sha512/256/1 × fast_iter 2/1 × hmac 算法 × 页号端序 × 页大小），用 page1+page2 双页 HMAC 探测
> 真命中的那一组（本机 4.5.7 落在 sha512/2/sha512/LE·u32/4096；别的版本不写死、逐次探测）。
> **只读纪律**：读的是内存副本，解密结果写进 temp 临时文件、查完即删（含 node:sqlite 产生的
> -shm/-wal 副产物），真实库一个字节不碰。WAL 一并重放（帧头大端；盐对不上的陈旧帧、最后一个提交帧
> 之后的尾帧都跳过）。
>
> **增量**：签名 = db 与 `-wal` 两个文件的 {mtime,size} 四元组（WAL 模式下新数据先落 wal、库文件
> mtime 不动），变了才整份重解密（几十毫秒量级）。traedb **不在 `OFF_KINDS`**：每次启动重解密重建，
> 不需要 `PARSER_REV`。
>
> **切轮与字段口径**（对照真实库逐项验证）：
> - `chat_turn` 一行 = 一轮；`reply_to_message_id` = 用户消息、`response_message_id` = 助手消息；
>   状态取 `turn_status`（`in_progress`=进行中、`canceled`=打断，其余非 `completed` 值按失败）。
> - 用户输入：`chat_message_general.content` 的 text 块（图片块记 `[图片]`）。
> - 助手正文按 response 消息的 `message_type` 三种落点：`task` → plan_item 里
>   `tool_call_info.name='finish'` 的 `params.summary`（没有 finish —— 未跑完/被取消 —— 取最后一条 thought）；
>   `chat` → `content.content`（2025 老会话）；`general` → 同用户输入格式。
> - 工具 = task JSON 的 plan_item（`name≠finish`）：入参 `params`、返回 `result`、耗时取
>   `timing.tool_call_started_at_ms/finished_at_ms`（老库没有 timing → dur=0）。`finish` 不是工具，它的正文是回答。
> - token 以 `server_history_info` 里 `session_id == 该轮 reply_to_message_id` 且 `source='llm_default'`
>   的行为准（一次 LLM 调用一行，`extra_info.exact_*` 精确用量）：轮级 = 逐次求和，
>   `tin = Σ(prompt−cache_read)`（cache 单列进 `tcache`，与 claude 同口径），`ctxUsed` = 最后一次调用的
>   prompt 全量（含 cache，同 claude/kimi）；**2025 老会话没有这些行**（源头就没记）→ 回退
>   `turn.context.token_usage` 的轮级汇总，再没有才恒 0，详情页用 `callsNote` 说明是哪种。
> - 模型名取 `config_name`（与 server_history_info 同源、跨来源去重才干净），大小写不敏感去重。
> - 上下文窗口分母取 `user_message_context.model_info.prompt_max_tokens`（源头自己的上限）。
> - 项目：`project` 表（`chat_session.project_id` → `absolute_path`）；查不到回退 turn.context 的
>   `workspace_folders` / `references`；都没有才 `(Trae)`。标题：`fts_session_title` → `chat_session.session_title`。
> - 全空的轮（user/assistant/tools/错误信息全无）、`deleted_at` 置位的会话与轮都不灌条目。
>
> **逐事件时间线**（`EVENT_AGENTS` 第三个成员）：user 开轮 → 逐次 llm（时间点取 `created_at`，
> dur=0 —— 源头没有流式分段，与 dsh/zcode 的 ttft/dur 拆分不同）→ 工具 call/result（`timing` 真实起止，
> result.dur = 该次工具耗时）→ end 收轮。与其他 agent 同 schema（call/result 的 `i` 指 tools[] 下标）。
>
> **密钥轮换**：Trae 自己开库就是用这把钥匙 —— 运行中的进程内存里能找到 `PRAGMA key = "x'…'"`
> 字符串（随包抓取工具 `tools/grab-trae-key.ps1`：提权扫一次内存，原理见 REFERENCE.md「Trae 的 SQLCipher 库」）。
> Trae 大版本升级 / 库重建后密钥可能换，症状是诊断页
> 从「已接入」变成「已回退 tracecode 日志解析：密钥不对」，按 REFERENCE.md 的步骤重抓一次即可。

## dsh（DeepSeek Harness）

> **dsh 的 `.zstd` 不是「一个 zstd 文件」**：dsh 每落一次盘就**追加一帧**，一个会话几十帧
> （本机实测 11~76 帧）。而 Node 的 `zlib.zstdDecompressSync` / `createZstdDecompress`
> **只解第一帧就停** —— 不报错、不继续、也不告诉你后面还有，偏偏第一帧就是那条会话头
> （解出来 202 字节、1 行）。所以「把文件解压开」得到的是 1 行、0 轮，看上去和「没有数据」一模一样。
> 服务里是**按 magic 逐帧解**的（见 `dshDecode`）；zstd 帧头里不写本帧的压缩长度，这也是它没法像
> 别的 agent 那样按字节偏移续读、只能整份重解析的原因。
> 另：正在写入的那一帧会解压失败，**跳过**即可（下一轮扫描它写完了自然会被解出来），
> 不要因此把整个会话判成坏的。
>
> **会话文件名里带格式版本**（`session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`；dsh 升版就改名，
> 实测 2026-09-28 起落 v4）。选文件时按**版本号取最高**的一份，早期的 `session.jsonl.zstd`
> （无版本号，迁移前残留）排最后兜底。⚠️ 这里**不许写死版本号**：曾写死 v3，v4 一落地新会话就整批
> 静默消失（症状 = 当天聊了一下午、面板当天 0 条），而解析器读 v4 毫无问题（事件类型与 v3 同构，
> 只多出 `request/header`、`system/message`、`command/*` 等本就忽略的新类型）。
>
> **dsh 要 Node 22.15+**：`zstdDecompressSync` 是那时才有的。更老的 Node 上 dsh 仍会被**认出来**
> （目录、格式都判对），但扫不出条目 —— 这时「环境诊断」里会直接写清是 Node 版本的问题，
> 而不是笼统的「格式细节对不上」。`package.json` 的 `engines.node` 保持 `>=22.5`：
> 对别的 agent 来说 22.5 完全够用，没必要为了 dsh 把整包的门槛抬上去。
>
> **dsh 的「N 次 LLM」怎么数的**：一次**已结算**的模型调用算一次，包括没拿到回复的那些
> （`assistant/attempt`：报错 / 被中断）。不这么算的话，一轮全是失败时卡片会显示「0 次调用 + token 全 0」，
> 看着像解析器没接上，而实际上确实调了、只是都失败了 —— 那种轮的状态是 error，详情里会带上源头的报错原文。
>
> **子 agent 谱系（I16，2026-09-28）**：dsh 把谱系**写死在会话头**上，不需要按时间区间猜父子：
> `delegationDepth`（0 = 人开的，1 = 子 agent）、`parentSession`（父会话的 `session-<uuid>` 全名，
> 与解析器落的 `session` 值同形，能直接对上）、`origin`（子会话为 `"subagent"`）。
> 子会话另有 `subagent/descriptor` 事件给 `label`（派活名）/ `mode`（`continuable` / `one-shot`）/
> `provider`（`spawn` / `fork`）—— 落成条目的 `sub` / `subMode` / `subProvider`。
> ⚠️ 这三样在**扁平的会话头**上（不是事件那样包在 `data` 里）；父侧那条 `subagent/catalog` 事件
> **不收**（父子关系已由子会话头给出，收两处就是两份真相）。
> 条目的 `parent` / `depth` / `sub` 缺席即 JSON 丢键 —— 根会话如实为空，不编层级。

## 子 agent 谱系（I16 统一口径，2026-09-28）

> **判据是源头给的显式外键，不是时间区间。** 2026-09-28 的前置闸已证伪「按 `[time, time+dur]` 嵌套
> 判父子」这条路：atomcode 那 11047 对嵌套 100% 是噪声（`time` 取轮终点 + 时间未知回落 `updated_at`
> 两处缺陷叠出来的），修正后嵌套对 = 0。所以各家一律只认下面这些**显式字段**：

| 来源 | 显式谱系字段 | 落成条目 |
| --- | --- | --- |
| claude / qoder-cn | `<slug>/<父会话 uuid>/subagents/agent-<id>.jsonl` 的**目录层级**（父 = 上级目录名）；同目录 `<同名>.meta.json` 给 `description` / `agentType` / `spawnDepth` | `parent` / `depth` / `sub` |
| dsh | 会话头 `parentSession` / `delegationDepth`；`subagent/descriptor` 给 `label` / `mode` | `parent` / `depth` / `sub` / `subMode` |
| zcode | `session.parent_id` | `parent` / `depth` |
| opencode / kilo | `session.parent_id` | `parent` / `depth` |
| hermes | `sessions.parent_session_id` | `parent` / `depth` |

> 聚合侧（`sessionsAgg` / `sessionAgg`）按 `agent + 归一化项目 + parent→key` 上卷成树：
> `parentKey`（父会话在列表里的 key）、`children[]`、`subTurns / subTotal / subDur`（**含自身**的子树合计）。
> **认不出父就如实降级成根**（父不在筛选窗口 / 盘上没有 / 被 LRU 淘汰）：不硬造一个不存在的父节点。
> 源里没有这一层的 agent → 不落字段、页面不显示任何层级，**不印 0、不画假树**。
>
> ⚠️ **子转录的 `project` 必须跟父走，不能照抄自己的 `cwd`**（claude:14 的收口）。claude 子 agent 的
> `cwd` 常是父项目的**子目录**（本机实测 `F:\centos\agentLog\agent-acta`、`…\agent-log-plugin\agent-log-hook`），
> 而聚合侧的认父键里有**归一化项目**这一位 —— 照抄自己的 cwd 会让父子落进两个 projectKey，
> 于是「目录层级明明对得上」的父子在列表里认不出来、被降级成两根（2026-09-28 真机实测 27 份子转录丢 10 份，
> 两条父会话的合计整块消失）。父的 cwd 取两条路且**都不依赖扫描顺序**：内存态（热启动）→ 读父转录开头
> 找第一条带 `cwd` 的行（首扫分片下 `subagents/` 排在 `<会话>.jsonl` 前面）；两条都拿不到才退回自己的 cwd。
>
> ⚠️ claude 的子转录在 `<slug>/<会话>/subagents/` 下一层：`sliceFiles`（首扫分片）必须一起列出来，
> 且 `scanClaude` 的 `onlyFile` 判据只能比 **slug**（原来比整个 `dirname`，会把这一批整段跳过）。
> 动这一层落盘内容 ⇒ **必须 bump `PARSER_REV.claude`**（新增字段 + 新增条目都在「落盘 turns 内容」里；
> 改 `project` 这一位同样要 bump —— 它是**已落盘的每轮字段**，老索引会一路走 m/s 相等短路、永不自愈）。

## doubao（豆包 Work 智能体）

> **落盘位置**（Windows 实测）：`%LOCALAPPDATA%\DoubaoWork\User Data\Default\.doubaowork\agent_mode\workspace\.sessions\<会话 id>\agents\<agent id>\system\trajectory.jsonl`。
> 自动发现走的就是这条**真路径**（`~/.doubaowork` 小写约定在 Windows 上不存在，`basesFor` 铺出来的那几条都落空，
> 靠 `candidateBases('doubao')` 单独补的这条命中）；手工填路径时，`DoubaoWork 应用根 / User Data / Default / .doubaowork /
> agent_mode / workspace / .sessions` 任意一层都能沿已知目录名下探认出来（见 `doubaoSessionsRoot`）。
> 探路路径（`%LOCALAPPDATA%\DoubaoWork` 应用根等，未全平台验证）只进诊断，不参与自动发现。
>
> **格式**：OpenAI 风格逐行消息流，一行 = 一条消息，`user` 开新轮，其后的 `assistant` / `tool` 都归这一轮，
> 下一条 `user` 收轮：
> `{"role":"user","content":"…"}` / `{"role":"assistant","content":"…","tool_calls":[…]}`
> / `{"role":"tool","content":"…","tool_call_id":"…"}`。
> calls = assistant 行数（每条 = 一次 LLM 响应）；tools = tool_calls 总数（含去重后的 toolNames，R20）；
> 详情里工具出入参按 `tool_call_id` 精确回填。**空 user 消息不开轮**——扫描侧与详情侧共用这一条判据，
> 两边数出来的轮序号必须一致，否则详情会串轮（`doubaoEntryContent` 与 `scanDoubao` 各写一份判据就是这次的前案）。
>
> **增量**：`off` 是**字节**偏移，找「最后一个完整行」必须在 Buffer 上找 `0x0a`（`shared.readCompleteLines`），
> 不能先 `toString('utf8')` 再拿字符串的 `lastIndexOf('\n')` 当字节用——一个汉字 3 字节 1 字符，
> 那样每轮少走 (字节数 − 字符数)，少走的那段里的整行会被下一轮重复解析，`data.turns` 攒出幽灵轮次并随 index 永久落盘。
> 2026-09-20 本机实测：源 9 行用户消息解析成 12/13 轮，页面 25 张卡片里 8 张点开用户输入是空的。
>
> **转录里没有的字段（源头不落盘，解析器不编造）**：
> - **时间戳**：每轮真实时间在同目录 `assignment.md` 的「## [ISO时间] 需求」记录里。两文件同源追加、
>   轮数天然一致，但正文写法可能不同（skill 链接在 assignment 里是 `skill://`、在 trajectory 里是 `<本地路径>`），
>   所以按**规范化文本**（剥 markdown 链接 → 折叠空白）匹配对齐；匹配不到、或没有 assignment.md → time=0，
>   页面显示「—」。dur = 下一轮时间 − 本轮时间。
> - **模型 / token / usage**：转录不落盘，逐次 token 恒 0（2026-09-21 复测：四个 IndexedDB 库全扫，
>   `prompt_tokens / total_tokens / usage` 零命中，这个本地真没有）；模型名与上下文占用从客户端库补：
>   - **上下文占用** = chat 库（`chrome_doubaowork-chat_0.indexeddb.leveldb`）会话记录里的
>     `context_window_usage`（system_prompt + messages + skills + tools / total_window_size=256000，多会话取平均）；
>   - **模型名** = chat 库 `extra.model_item_key` 只有数字 key（实测 `"9"`），**key→名字对照表在 launcher 库**
>     （`chrome_doubaowork-launcher_0.indexeddb.leveldb` 的 `model_list` / `modeSelectConfig` 目录，
>     name 为 UTF-16LE 嵌 protobuf；实测 9→「工作任务 Auto」、4→「豆包 2.1 Turbo」、5→「豆包 2.1 Pro」）。
>     目录未命中才退回显示 `item_key=N`（`extractDoubaoModelNames`）。
>   2026-09-20 曾结论「模型名本地拿不到」——那是只扫了 chat 库；9-21 补上 launcher 库后成立，
>   `PARSER_REV.doubao` 已 bump 到 8 作废旧 index。注意别和 Trae 混淆：Trae 卡片上的 token/模型名
>   是 **Trae 自己那次会话的消耗与所用模型**（解密 SQLite 的 model_info / usage），与豆包日志无关。
>
> **project / session**：doubao 没有项目概念，project 取 `.sessions` 的上级 workspace 目录
> （真实容器；非空，避免空串混进项目筛选下拉）；session = `<会话 id>/<agent id>`
> （一个会话目录里每个 agent 各有一条 trajectory，各占一行会话）。

## minimax（MiniMax Mavis 本地运行时）

> **落盘位置**：`~/.minimax/v2/sessions/YYYY/MM/DD/<HH-MM-SS-mmm-session_<base64-id>>/`。
> 一个日期文件夹 = 一个会话，主源是同目录 `messages.jsonl`（逐行追加，off 增量语义与 claude/doubao 同），
> 辅源 `manifest.json`（sessionId / createdAtMs）与 `llm-call.json`（系统提示 + 工具 schema 的**一次性聚合快照**，
> 不是逐次调用日志）。自动发现从 `~/.minimax` 一路指到 `v2/sessions` 再按 y/m/d/session 四层下探；
> 会话目录判据只看 basename 的 `session_` 前缀（时间戳前缀是装饰，同一分钟多开的会话分不出先后，
> 所以轮顺序按文件内消息序号，不靠目录名排序）。
>
> **每行是一条消息，字段全在 `message` 里**（早期版本误读顶层 `j` 导致 token/model 全落空）：
> `{"message_id":"msg-…","turn_id":"<uuid>","message":{…}}`。`message.role` 有**四态**：
> `user`（开轮；content 是 `[{type:"text"}]`，首行常带 `<system-reminder>` 块，正文截到提醒块之后）、
> `assistant`（content 可含 `thinking` / `text` / `toolCall`，`arguments` 是**对象**不是 JSON 字符串）、
> `toolResult`（按 `toolCallId` 回填上一条 assistant 的 toolCall 出参，与 OpenAI 系同语义）、
> `custom`（系统注入，见下）。
>
> **token 口径：`tin = input` 直接取，input 不含 cache。** 真库实测 95/95 条 assistant 行恒有
> `totalTokens = input + output + cacheRead + cacheWrite`，且 93/95 行 `input < cacheRead`
> （实测 input=652 / cacheRead=107410）。hermes 那套「input 含 cache、`tin = input − cacheRead`」
> 是**另一个库的口径**，照抄会把真实输入砍掉 80%+（79 次调用的轮：真实 105,196 → 旧口径 18,513）。
> `tcache = cacheRead`；`ctxUsed` = 轮内最后一次 assistant 的 `input`。
>
> **ctx 分母来自 `llm-call.json` 的 `maxTokens`**（实测 128000）。它是聚合快照、拿不到逐次账，
> 但窗口容量是现成的 —— 页面据此画「占用 / 窗口」进度条；文件缺失或字段异常才留 0（退化为只显示占用）。
>
> **`role:"custom"` 不能静默丢弃。** 实测 `customType="todo_cadence_reminder"`、`display=false`、
> content 是字符串——运行时自动插入的系统提醒。它不开轮、不进正文，但解析器要：① 更新轮内
> `lastTs`（提醒恰好落在轮尾会截断该轮时长）；② 计数与类型留痕，详情 callsNote 注明
> 「本轮含 N 条系统注入消息」。早期版本只列 user/assistant/toolResult 三个分支，custom 整条被丢弃。
>
> **失败轮有两门判据**：① assistant 的 `stopReason` 非 `toolUse`/`endTurn`/`stop`；
> ② `toolResult` 的 `isError=true`（真库实测存在，bash 失败行）。只认 ① 时，一个含失败工具的轮
> 在列表里仍是 `status:"ok"`（详情侧会标红单个工具，但轮状态看着健康）——两门都进 `err`。
>
> **逐次耗时拿不到**：assistant 行没有任何时长字段，`llm-call.json` 也不是逐次日志，
> 所以 `calls[].dur` 恒为 0（详情 callsNote 已说明，不是漏实现）。轮级 `dur` = 下一轮 user 时间 − 本轮时间，末轮为 0。
>
> `PARSER_REV.minimax = 2`（2026-09-21 口径修正：tin 改 input 直取、ctx 补 llm-call.json 分母、
> isError/custom 两项留痕——落盘 turns 内容全变，老 index 整文件作废重扫）。回归见 `test/minimax-test.mjs`。

## openclaw（OpenClaw）

> **落盘位置**：`<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl`，`stateDir` 默认 `~/.openclaw`
> （Windows 与 mac/Linux 同；老版本叫 `.clawdbot`，`OPENCLAW_STATE_DIR` 可整体改写，`OPENCLAW_HOME` 亦可）。
> 一个 agent 目录下一堆转录（`agents/<id>/sessions/*.jsonl`）。主源是**追加式会话树**，off 增量语义与
> claude/doubao 同。同目录还有 `sessions.json`（会话索引：`sessionId → sessionKey`）与上一级的
> `agent/models.json`（模型目录，取 ctx 分母）；`<stateDir>/state/openclaw.sqlite` 是认证/设备/租约状态，
> **不是**会话源（实测表里没有会话），别去读它。
>
> **⚠️ `sessions/<id>.trajectory.jsonl` 必须排掉**：它以同样的 `.jsonl` 结尾，但格式完全不同（运行轨迹：
> `session.started`/`context.compiled`/`model.completed`/`trace.artifacts`…）。判据是**首行**必须是会话头
> （`type:"session"` + `version` + `id`），轨迹首行不是；扫描侧再加一道 `fn.includes('.trajectory.')` 硬排。
> 不排的后果：把轨迹当第二数据源，`messagesSnapshot` 会把整轮消息再复制一遍 → 轮数/工具数翻倍。
>
> **逐行是会话树的条目**（源码 `SessionTreeEntry` 核实）：
> `session`（首行，唯一没有 `parentId` 的）、`message`（**唯一带对话正文的类型**）、
> `session_info`（产品自己写的会话标题 → entry.name）、`model_change`（切模型）、
> `thinking_level_change`、`custom` / `custom_message`（注入上下文，前者不回放给模型）、
> `compaction` / `branch_summary`（上下文压缩）、`label` / `leaf`（纯导航标记）。除 `session` 与 `message`
> 外都**不开轮、不进正文**，但 `custom(_message)`/`compaction`/`branch_summary` 这类注入/压缩标记
> **不能静默丢弃**：要更新轮内 `lastTs`（否则落在轮尾的注入会截断该轮 dur）、计数并记类型，详情 callsNote 注明。
>
> **message 是 llm-core 的 Message**，三种角色：`user`（content 是字符串**或** `[{type:"text"}]`）、
> `assistant`（content 可含 `text`/`thinking`/`toolCall`，`arguments` 是**对象**不是 JSON 字符串）、
> `toolResult`（自带 `toolCallId`/`toolName`，按 id 回填上一条 assistant 的 toolCall 出参，同 doubao）。
>
> **token 口径：`tin = input` 直接取，input 不含 cache。** 这不是推断，是源码写死的 ——
> `dist/openai-completions-*.js`：`const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)`，
> 且 `totalTokens = input + output + cacheRead + cacheWrite`。⇒ `tcache = cacheRead + cacheWrite`（两个互斥桶，
> **不能**取 max）；**上下文占用 = input + cacheRead + cacheWrite**（就是 promptTotal），不是 input 单独一项。
> 与 minimax 同口径；hermes 那套「input 含 cache」是另一个库，照抄会把真实输入砍掉。
>
> **ctx 分母来自同 agent 的 `agent/models.json`**：`providers.*.models[].id → contextWindow`。
> ⚠️ 这个文件里带 `apiKey` —— 解析器**只取 id 与 contextWindow 两个字段**，绝不把整份内容带进任何日志或响应。
> 文件缺失（如某些 agent 目录没写过模型）→ ctx 留 0，页面退化为只显示占用。
>
> **失败轮两门判据**（同 minimax）：① assistant 的 `stopReason==="error"`（带 `errorMessage`/`errorCode`，详情原样带出）；
> ② `toolResult` 的 `isError=true`。`stopReason==="aborted"`（用户中断）按 claude 口径与 `status` **独立**，
> 只标 `aborted` 不上 error；`stopReason==="length"`（触输出上限被截断）只在详情 callsNote 注明。
>
> `PARSER_REV.openclaw = 1`（2026-09-23 首次接入即定档）。回归见 `test/openclaw-test.mjs`。

## cursor（Cursor IDE 的 Agent 转录）

> **轮时间取新版每条 user 消息开头那个 `<timestamp>` 块**（形如 `Tuesday, Sep 15, 2026, 3:44 PM (UTC+8)`，
> 时区偏移自己拆，不交给 `Date.parse` —— 它一律按本机时区解释）；老版本没这个块，
> 只能退回「整段会话共用文件 mtime」，那种会话里所有轮的时间会一模一样。
> 另外新版每轮末尾有 `{"type":"turn_ended","status":…}`，非 `success` 会把该轮标成 error。

> **耗时（dur）恒为 0**：源里只在**少数**消息上零星记了 `startedAtMs`/`completedAtMs`
> （382 个气泡里只有 150/117 个），`turnDurationMs` 更少（19 个，且不在用户气泡上）——
> 按轮对齐不可靠。用下一轮的开始时间顶上则会把挂机时间算进去，所以宁可留 0。

> **cursor 的模型名与上下文占用从哪来？** 转录文件里**没有**这两个字段（实测只有 `role` + `text`），
> 记着它的是 Cursor IDE 自己的会话库 `state.vscdb`（SQLite，表 `cursorDiskKV`）：
>
> | 键 | 字段 | 含义 |
> |---|---|---|
> | `composerData:<会话 id>` | `modelConfig.modelName` | 会话级默认模型 |
> | `bubbleId:<会话 id>:<气泡 id>` | `modelInfo.modelName` | 该条消息**实际**用的模型 |
>
> 键里的会话 id **就是转录所在目录的名字**，能直接对上。**以气泡为准**（会话级配置只是默认值，
> Auto 模式实际路由到哪个模型只有气泡知道）；实测 `modelInfo` 只挂在 **type=1（用户）气泡**上，
> 而「一条 user 记录 = 一轮」，所以按顺序一一对应即可。气泡没带的回落到会话级默认值。
>
> 三条边界：**① 只用 Node 22.5+ 自带的 `node:sqlite`，没有就静默关闭**（`engines` 已提到 `>=22.5`，
> 但 npm 的 engines 只是**警告**不是闸门，所以老 Node 上仍要能跑、只是看不到模型名）；
> **② 只读打开，永不写**，读不到/被锁/结构变了都当作没有，
> 行为与从前完全一致；**③ 哨兵值当没有** —— 库里实测有 33 个会话写的是 `"default"`（Cursor 内部
> 枚举，不是模型名），填到卡片上比空着更误导，所以 `default` / `auto` 一律过滤掉。
> 设 `AGENT_LOG_NO_CURSOR_DB=1` 可完全关掉这个读取。
>
> **上下文占用照样取这一层。** `composerData` 上还有 `contextTokensUsed` / `contextTokenLimit`
> （本机实测 46837 / 256000），卡片上那根「占用 / 窗口 + 百分比」的条就是它。
> ⚠️ 它是**会话当前**的值、**不是逐轮的** —— 气泡上没有任何逐轮的上下文字段，所以同一会话的每一轮
> 显示的是同一个数（早期轮次其实远没这么满），详情里写明了这一点。
>
> **工具次数也从这一层数。** 助手气泡的 `toolFormerData` 上每个工具调用有唯一 `toolCallId`，
> 按它去重就是**精确**的工具次数（⚠️ 同一个 id 会在多行气泡里重复出现，实测 1/2/4 次 —— 不去重会翻几倍）。
> 切轮与转录同一套顺序：一个用户气泡开一轮，其后的助手气泡都算这一轮。
>
> **「N 次 LLM」这个徽章 cursor 不显示**，因为本地推不出来：`toolFormerData` 上还有个 `modelCallId`
> （实测全库 87 个 < 工具调用 123 个，说明一次请求可带多个并行的工具调用），去重它能数出
> 「**带工具调用的**模型请求数」—— 但每轮收尾那次请求只产文字、不带工具，数不到，所以那是**下界**。
> 写 0 等于宣称这轮没调过模型，写下界又会被当成准数，于是一律留 `null`（页面据此隐藏这个徽章）。
> 「N 轮」同理留空。
>
> **token 用量：落盘的这些文件里确实没有，但能从 Cursor 自己的 `stop` 钩子采回来**（见下面一节）。
> 落盘侧是真的没有：`usageData` 是空对象，每条消息的 `tokenCount` 恒为
> `{"inputTokens":0,"outputTokens":0}`；`promptTokenBreakdown` 是**上下文占用的估算**（按
> system prompt / tools / rules / 对话分类），不是计费用量。耗时也拿不到：源里只在
> 少数消息上零星记了 `startedAtMs`/`completedAtMs`（150/117 个，共 382 个），`turnDurationMs` 更是
> 只在 19 个上、且不在用户气泡上 —— 不足以按轮算耗时，所以 `dur` 恒为 0。详情里会写一段话说明。

### cursor 的逐轮 token：只能靠 `stop` 钩子采回来

本地逐轮用量的**唯一来源**是 Cursor 在每轮 agent loop 结束时递给 `stop` 钩子的那份载荷。页面侧栏
cursor 行那个图标按钮（`POST /api/cursor-hook`）往 `~/.cursor/hooks.json` 里加一条命令
（`hooks/cursor-usage-hook.mjs`），脚本把用量追加到侧车日志 `~/.agent-acta/cursor-usage.jsonl`，
解析器读那份日志、按会话配对贴回轮上。**没注入的机器上这份日志不存在，行为与从前完全一致**（全 0 +
原来那段「源里没有」的说明）—— 所以下面所有分支都写成「读不到就当没有」。

**脚本必须自己剥掉 stdin 的 UTF-8 BOM**：Cursor（Windows）递给钩子的 JSON 以 `\uFEFF` 开头，
直接 `JSON.parse` 会抛 `Unexpected token '\uFEFF'`。这个失败**一点声响都没有** —— Cursor 自己的
钩子日志写着 `exit code 0` / `executed successfully`，页面却永远没 token（实测踩过，见
`cursor-hook-test.mjs` 的 [6] 段：把钩子当子进程真跑、喂带 BOM 的 stdin）。
排查时先看 Cursor 自己的钩子日志：`%APPDATA%\Cursor\logs\<会话时间戳>\window*\output_*\cursor.hooks.*.log`
（里面会记 `Loaded N user hook(s) for steps: stop`、命令原文、载荷原文与退出码）。

**侧车日志每行一条**（脚本只白名单落这几个字段，别的载荷字段一律不落）：

```json
{"v":1,"ev":"stop","conv":"<会话 id>","gen":"<generation id>","ts":1789000000000,
 "model":"claude-4.5-sonnet","status":"completed","in":5000,"out":300,"cr":2000,"cw":500}
```

`in`/`out`/`cr`/`cw` 就是载荷里的 `input_tokens` / `output_tokens` / `cache_read_tokens` /
`cache_write_tokens`；`model` 取 `model_id || model`；`ts` 是脚本落盘时刻（毫秒）。`conv` 对上
**转录所在目录的名字**（会话 id），这是配对的主键。

**卡片上的口径（三条，都来自载荷的实测语义）**：

| 卡片字段 | 算法 | 为什么 |
|---|---|---|
| `tin` | `max(0, in − cr − cw)` | 载荷里的 `input_tokens` **含**缓存两项，不减会重复计 |
| `tcache` | `cr + cw` | 两项合并成一列「缓存」 |
| `tout` | `out` | 原样 |

`total` 照全项目惯例 = `tin + tout + tcache`。另外两条边界：**① 这是「这一轮」的累计值** ——
一次用户请求里所有模型调用加总，不是单次调用；**② 不含子智能体（subagent）** —— Cursor 的
`subagentStop` 只给元信息、不给 token，这部分目前采不到（注入之前的历史轮次同样没有，token 仍是 0：
不是没记，是那时还没采）。

**按轮配对的两条路**（`cursorPairUsage`）：

- **转录里有 `<timestamp>`（新版）→ 按轮开始时间分桶**：某条用量的 `ts` 落在
  `[第 k 轮开始, 第 k+1 轮开始)` 里就归第 k 轮。**早于整段会话的 `ts` 一律丢掉**，不硬塞给第 0 轮
  （否则历史遗留记录会把第一轮顶得虚高）。
- **转录里没有 `<timestamp>`（老版）→ 后缀对齐**：老版整段会话共用一个文件 mtime、没有任何时间锚点，
  只能把日志里该会话的**最后 N 条**贴到**最后 N 轮**上（顺序一一对应）。所以老会话里只有末尾几轮有
  token，前面的轮是 0 —— 这是源的边界，不是 bug。

**签名**：用量日志也进 `scanCursorSlug` 的签名（`…;u:<mtimeMs>:<size>`）。只注 hook、转录没再写时
签名照样变，会触发重解析把新用量贴上新卡片；否则新采的用量要等下次转录变动才出现。

## cline（Cline CLI 3.x）

> **落盘位置**：`<data>/sessions/<会话 id>/<会话 id>.messages.json`，data 根默认 `~/.cline/data`（Windows 与 mac/Linux 同）。
> 位置可改写（从 `cline.exe` 里核出来的三个变量）：`CLINE_DATA_DIR` = data 根、`CLINE_SESSION_DATA_DIR` = 直接就是
> sessions 根、`CLINE_DB_DATA_DIR` = 旁边的库目录（**不是**会话源）。手工添加时填 `~/.cline` / `data` / `sessions` /
> 单个会话目录 / 那份 `*.messages.json` 五种写法都认。
>
> **⚠️ 主源是整份 JSON，不是 JSONL**：`{version, updated_at, agent, sessionId, origin, messages[], system_prompt}`，
> 会话进行中**每次落盘都整份重写**（实测 33→37→39 条，`updated_at` 跟着变）。所以没有字节偏移可续读 ——
> 与 comate / cursor / gemini 同一路数：按 `{mtime,size}` 签名整份重解析，签名没变就跳过，**不进 `OFF_KINDS`**。
> 清单 `<会话 id>.json`（同目录）只取 `cwd` / `metadata.title` / `status`，签名也带上它 —— 换标题、会话结束都要触发重解析。
>
> **消息形状**：`{id, role, content[], ts(毫秒)}`，`modelInfo{id,provider}` 与 `metrics{…}` **只挂在 assistant 上**。
> content 块只有三种：`text` / `tool_use{id,name,input(对象)}` / `tool_result{tool_use_id,name,content[]}`。
>
> **⚠️ `tool_result` 也是 `role:"user"`** —— 切轮只看 role 的话，本机那份 39 条的会话会从 **8 轮切成 23 轮**。
> 开轮判据是「`role==="user"` **且** content 里有非空 `text` 块」，扫描侧与详情侧共用同一个函数（否则「扫到第 N 轮」
> 与「详情第 N 轮」错位）。空 / 纯空白的用户消息同样不开轮。用户正文还被产品自己的标签包着
> （`<user_input mode="act">…</user_input>`，切模式时另有 `<mode_notice>…</mode_notice>`），要剥壳。
>
> **token 口径：`metrics.inputTokens` 含缓存** —— 它就是整次请求的 prompt 总量，`cacheReadTokens` /
> `cacheWriteTokens` 是它的**子集**（OpenAI 语义），与 openclaw / minimax 那种「input 不含 cache」**相反**
> （hermes 与它同侧）。三条证据：二进制里的归一化取的是 `prompt_tokens` / `prompt_tokens_details.cached_tokens`；
> 同一份二进制的成本函数拿 `inputTokens − cacheReadTokens − cacheWriteTokens` 才当未命中缓存的输入计价；
> 实测逐次差值按「不含缓存」解释会出现 −510 的**负增长**，按「含缓存」解释则恰好对上中间消息的字符数。
> ⇒ `tin = max(0, input − cacheRead − cacheWrite)`、`tcache = cacheRead + cacheWrite`、
> `total = tin+tout+tcache = Σinput + Σoutput`（与清单 / 库里那个会话级 `usage` 是同一个数，逐条相加恒等）。
> 上下文占用 `ctxUsed` = 轮内**末次**调用的 `inputTokens`。
> ⚠️ 它**同会话内不单调**：`/compact` 之后第一次请求从 43662 掉到 19526（上下文换成了摘要）——
> 既不能当累计值，也不能拿相邻差值推轮边界。
>
> **`ctx` 分母拿不到，恒 0**：模型目录（`contextWindow` / `maxInputTokens`）只嵌在 144MB 的 `cline.exe` 里，
> `~/.cline` 全目录 grep `contextWindow` 零命中 —— 不编分母，页面退化成只显示占用。
>
> **失败判据只有一处**：`tool_result.content[]` 是**逐项**结果 `{query, result, success, error?}`，
> 一次批量调用可以只错一项（本机实测 `Command exited with code 1` / HTTP 404 / 403 rate limit exceeded）。
> 任一项失败 → 该工具标红 + 整轮 `status=error`（与 minimax / openclaw 的 `isError` 同口径），错误原话进详情 callsNote
> （那一行装不下两条，失败原话优先 —— 口径说明在无失败的轮上照常给）。
> **模型侧失败不落盘**：assistant 行没有 `stopReason` / `errorMessage`，请求挂掉就是少一行 ⇒ 没有通用的逐轮失败判据，
> 认不出来就不标。逐轮也没有耗时 / 成本字段（会话级才有 `status` / `exit_code` / `totalCost`，本机第三方 provider
> 的 totalCost 恒 0）⇒ `aborted` 恒 false、`calls[].dur` 恒 0；逐工具耗时算得出（`tool_result.ts − tool_use.ts`）。
>
> **不读的三样**：① `<会话 id>.compaction.json` —— `/compact` 的快照，实测写出它之后 messages.json
> **一个字节都没改**、库里 `usage` 也不变 ⇒ 压缩是**纯投影、不是记账事件**，读它会把同一批消息数两遍；
> ② `data/db/sessions.db` —— 清单的超集，只有 lineage（`parent_session_id` / `is_subagent`）是独有的，
> 将来要标子会话再从它取；③ ⚠️ `data/settings/providers.json` —— **明文 apiKey**，一个字节都不许读，
> 也不能出现在任何接口响应里（`test/cline-test.mjs` 有 canary 断言）。
>
> `PARSER_REV.cline = 1`（2026-09-24 首次接入即定档；本 kind 不落 index，这条编号管搜索分片作废）。
> 回归见 `test/cline-test.mjs`。

## atomcode

> **atomcode 的「LLM 调用明细」要靠 datalog。** `~/.atomcode/sessions` 里最细只到**轮**（`.meta` 的
> `model_usage` 是轮×模型的聚合，一轮跑 80 次调用也只留一行），拆不开。逐次明细在 `config.toml` 的
> `[datalog]` 段指向的目录里，**默认关闭**、要用户自己 opt-in（它会 dump 完整请求体，默认关是有意的）。
> 开了之后：每轮一对 `<时间戳>-<会话uuid>-t<轮号>-p<pid>-i<n>.{md,jsonl}`，`.md` 里每个 round 一段，
> 带真实的 `prompt/completion/cache`。面板**只读 `.md` 的这几个数字**（那目录实测 16G，其中 11G 是
> `.jsonl` 完整请求体，不碰；推理全文、工具出入参也一个字节都不往外带）。
> 没开、或这一轮早于开启时间 → 卡片照常显示轮级汇总，详情里写一行「这一轮没有 datalog 记录…」说清原因。
>
> **逐轮耗时那一列显示 `—` 是正常的**：5.1.0 之前的 atomcode 不记这个（旧命名格式里那个 `_(3.9s)_`
> 是**工具**耗时，不是这一轮的请求耗时，不能拿来充数）。本面板已经能认 v5.1.0 新增的 `dur=Nms`，
> 装上升级后**新产生的轮次**会自动带上耗时；升级之前的轮次不会补写，永远只能是 `—`。
>
> **`time` 取轮起点，拿不到就如实标「时间未知」（I16/D1/D2，2026-09-28 修）**：
> `.jsonl` 每行**同时**有 `started_at`（轮**起点**）与 `ts`（轮**终点**，对账 `ts − started_at ≈ duration_ms`，
> 本机 773 条样本平均偏差 15ms）。全项目口径是**起点**（claude / dsh / zcode / codex 全取起点），
> 而 atomcode 原先取的是 `ts` —— **唯一一家取终点的**，于是卡片/会话页显示的时间戳整体偏一个轮长、
> 按天分桶也跟着偏。现在：`started_at` > `ts − duration_ms` > **时间未知**。
> 拿不到时间的轮（`.jsonl` 0 字节、或 `turn_id` 在 jsonl 里不存在 —— 会话目录有 `rewind.json`，
> 是打断/回退留下的轮；本机实测这两类合计 **2391/3492 = 68.5%**）**不再回落 `updated_at`**：
> 那会让同会话几十轮全塌成同一时刻，把「不知道」冒充成「这时候发生的」。
> 改成 `time = 0` + `timeUnknown: true`，页面如实标注、不拿它做时间轴与拓扑排序。
> 改这两处动了落盘 turns ⇒ **已 bump `PARSER_REV.jsonl` 1→2**。

## codebuddy / workbuddy

codebuddy / workbuddy 优先按上表的 `projects/` 解析（能拿到真实 prompt、模型、token 与工具明细）；
只有当该目录不存在时才回退到 `sessions/ + traces/` 的 trace 解析——后者只有「Agent workflow」外壳，token 恒为 0，读起来像没意义的一堆行。

### CodeBuddy 家有**三份互不相干的落盘**，侧栏只有 `codebuddy` 一行

| 那一侧是什么 | 落在哪 | kind | 在侧栏哪儿 |
|---|---|---|---|
| CLI `@tencent-ai/codebuddy-code` | `~/.codebuddy/projects/<slug>/<会话 id>.jsonl` | `buddyjsonl` | `codebuddy` 的**主根** |
| genie 扩展（VSCode 插件 / JetBrains 插件 / **CodeBuddy CN 应用里的聊天**共用这一个扩展） | `%LOCALAPPDATA%\CodeBuddyExtension\Data\…` | `buddyext` | `codebuddy` 的**额外根**（`sessionsExtra`，每轮由 `buddyExtDataRoots()` 重算） |
| CodeBuddy CN 的 IDE 壳自己 | `%APPDATA%\CodeBuddy CN` | —— | 只有 Electron 缓存（Cache / Backups / DIPS / state.vscdb），**没有会话正文**，不接 |

⚠️ 「装了 CodeBuddy CN 却一条看不到」**不是**该去 `%APPDATA%\CodeBuddy CN` 找 —— 那目录里真的没有正文；
是 `%LOCALAPPDATA%\CodeBuddyExtension` 不存在（没装扩展）或那棵 tree 里没有 `history/` 结构。
顶层那份 `codebuddy-sessions.vscdb` 名字最骗人（本机拆开验过）：整库一张 `ItemTable`，一条会话只有一行
`session:<id>` = `{conversationId, cwd, userId, title, status, createdAt, updatedAt}` —— 只是索引，没有消息也没有 token。

扩展根没挂上时现在有话说：诊断行、`--doctor` 与 `[discover]` 日志都会点名盘上**实际看到的目录名**，
把四种成因分开讲（没装扩展 / 没有 `Data/` / `<acct>` 底下的 `<host>` 名不在 `vscode`·`codebuddyide`·`jetbrains`
白名单里 / `<host>` 底下没有 `history/`），不用再远程让人敲命令问盘 —— 判据与措辞都在 `buddyExtMissingWhy`。

为什么合成一行而不是并排两行：两边是同一个产品在不同宿主里的形态，拆两行会把**同一个项目的历史劈成两半**
（按 agent 筛就漏一边，用户只会觉得「应用里的会话怎么少了一半」）。代价是一行里两类卡片的完整度不同
（CLI 每轮有 `durationMs`，扩展版没有上下文窗口分母、老方言没有逐次 token），靠详情 callsNote 逐卡片说明
—— 与 trae 一行两源（SQLCipher 库 / renderer.log）同一种取舍。
但**不需要** trae 那套去重：trae 两个源覆盖同一批会话，这里两份是互不重叠的会话（CLI 用 uuid v7、
扩展用 md5 串，会话 id 形状都不一样），并扫即可。

## codebuddy 的 genie 扩展（kind `buddyext`）

`%LOCALAPPDATA%\CodeBuddyExtension\Data` 下的摆法（`<Data>` 就是这一层）：

```
<Data>/<acct>/<Host>/(<acct>/)?history/<wsKey>/index.json                ← 工作区级：conversations[]{id, name, …} + current
<Data>/<acct>/<Host>/(<acct>/)?history/<wsKey>/<会话 id>/index.json       ← 会话级主源：messages[]（索引）+ requests[]（轮）
<Data>/<acct>/<Host>/(<acct>/)?history/<wsKey>/<会话 id>/messages/<消息 id>.json  ← 逐条正文，一条一个文件
```

- `<Host>` ∈ `VSCode` / `CodeBuddyIDE` / `JetBrains`（三种宿主同一个扩展，只认这三个名字）；
- `<acct>` = `default` 或 36 位 uuid，**两种深度**：`default` 直挂 `history/`，uuid 时同一串再重复一层
  （`<uuid>/<Host>/<uuid>/history/…`）。`historyDirs` 两种都探，不写死层数；
- `<wsKey>` 是 md5，**反推不出工作区路径** ⇒ 项目名只能从首条用户消息 `<user_info>` 里的
  `Workspace Folder:` 取，取不到就落 `(CodeBuddy 扩展)`；
- 同 tree 里的 `check-point/` `file-tree/` `plan-task/` `genie-cache/` `.index_bak.json` `index.json.lock`
  都不是会话正文，一个字节都不读；`Data/Public/auth/*.info` 是 CodeBuddy 自己的**凭据**文件，
  靠「`<acct>` 下面必须是那三个 `<Host>` 名」这一条结构判据挡在门外（buddyext-test 的金丝雀守着）。

轮、token、时间、失败四件事的口径都在 `parsers/buddyext.mjs` 文件头，这里只记最容易踩的三条：

1. **轮 = `requests[]` 的一项**（产品自己记的轮，不靠 `role=user` 猜）。扫描侧与详情侧共用
   `buddyExtTurns()` 挑同一份数组 —— 改这个筛选就是改「第 N 轮」的编号，两边必须一起变。
2. **`usage.inputTokens` 含缓存**（与 cline 同、与 openclaw/minimax 相反）。算术自证：
   `cachedMissTokens + cacheTokens + cachedWriteTokens === inputTokens`。
   多步请求的 `inputTokens` 是**各步之和**（本机实测 76 条消息那一轮 = 2512800），不是末次值。
   逐次 token 与逐次耗时只有**新版**每条 assistant 的 `extra.statsSnapshot` 里有；老方言没有 ⇒
   `calls[].tin` 留 `null`（页面据此不印 0）、`calls[].dur` 退化成相邻消息时间戳之差。
3. ⚠️ **轮时间绝不能用消息文件的 mtime 算**。整份重写会把一批消息文件的 mtime 拍平到同一瞬间
   （本机 218e107b / 33ae5ab3 两份会话实测：mtime 差 ~2ms，而内容时间戳差 22s / 84s）。
   消息时间戳三取：`createdAt`(ISO) → `extra.responseId` 前 14 位（**那是本地时间书写**，按 UTC 解就整体偏一个时区）
   → `gen-<epoch 秒>-`。

不进 `OFF_KINDS`（会话 index 整份重写，没有可续读的字节偏移），增量靠两层签名：
会话 index 的 `{mtime,size}` 变了才重算聚合，重算时逐条消息按自己的 `{mtime,size}` 复用投影缓存
（所以**同字节数的原地改正文也认得出来** —— 只比 size 就会漏，buddyext-test 的 D 节守着）。
`PARSER_REV.buddyext` 仍然登记，它在这个 kind 上管的是全文搜索分片的作废。

## claude

`~/.claude/projects/<slug>/<session>.jsonl`，一行一条记录，按 user 消息切轮。

> **一次 API 响应在文件里不止一行。** 较新的转录把一次响应**按内容块拆成多条记录**：`thinking` 一条、
> 每个 `tool_use` 各一条，每条都带**同一份** `message.id` 与**同一份** `usage`（实测一份本机会话：
> 33 个 `message.id`，每个 2–3 条记录）。由此两条规矩：
>
> * **计数按 `message.id` 去重**（一个 id = 一次 LLM 调用）—— 逐行加会把调用次数翻两三倍；
> * **区块按 `message.id` 归并**，不能「见过这个 id 就跳过后面的行」：正文与 `tool_use` 大多**不在首条**上
>   （15 份样本里 694 个带正文的 id，687 个的正文不在首条；`usage` 则首条就有）。早期只认首条，
>   症状是详情里「AI 输出」与「工具调用」整块空掉，而 `calls` 照常显示 —— 看着像解析器没接上。
>
> 「LLM 调用明细」里的 `calls[i].text`（这次调用说了什么）与 `calls[i].tools`（这次调用调了哪些工具）
> 就是按这个归并切出来的。`tools` 只留名字，出入参不复制第二份（仍只有 `tools[]` 一份）。

> **会话名取产品自己写的标题（2026-09-23，I14）。** 转录里另有两条不开轮的元信息行：
> `{"type":"ai-title","aiTitle":"…"}`（本机 3718 条，就是给人看的会话名，如「ZCode 日志数据源适配」）
> 与 `{"type":"last-prompt","lastPrompt":"…"}`（用户最后一句原话，3737 条）。
> 取法：`aiTitle` 优先 → `lastPrompt` 兜底 → 都没有则 `name` 为 `null`（**如实为空**，不拿文件名冒充标题）；
> 同一文件出现多条时取**最后一条**（会话进行中产品会重写标题）。
> 名字落在**每一轮**条目上（会话列表任取一轮即可），另在 `/api/session` 的会话级汇总上带一份。
> ⚠️ `ai-title` 平均落在文件 48.8% 处 ⇒ 老会话的标题在 `off` 跳过的那一段里，
> 因此这次口径变更 **bump 了 `PARSER_REV.claude` 7→8**（不 bump 就永远补不回来）。
> qoder-cn 的转录实测**只有 `last-prompt`、没有 `ai-title`**，走的就是兜底那一档。

> **上下文压缩画像（2026-09-28，I12）。** 转录里有 `{"type":"system","subtype":"compact_boundary"}`
> 系统行，`compactMetadata` 带 `trigger`（`auto`/`manual`）、`preTokens`/`postTokens`、
> `durationMs`、`cumulativeDroppedTokens`（本机实测 `~/.claude/projects` 下 39 条 `compact_boundary`）。
> 逐轮累加成七个字段：`compacts`（次数）、`compPre`/`compPost`（**最后一次**压缩的前/后 token）、
> `compDrop`（**本轮**丢弃 token）、`compMs`（本轮等待时长）、`compAuto`/`compManual`（`trigger` 逐条计数）。
> ⚠️ `compDrop` 的口径要分清：源里 `cumulativeDroppedTokens` 是**会话累计**（每压一次往上叠，不是这一
> 次丢的量），落盘取的是**相邻事件累计的增量**再按轮求和，所以它是**本轮**压掉的总量（页面也是逐轮
> 相加成会话小结，两头对得上）；直接把累计值相加会把每轮显示成「到该轮为止的运行总量」。
> ⚠️ 两条边界：① `compDrop` **只有 claude 源有** `cumulativeDroppedTokens`，qoder 的 `compactMetadata`
> 里没有 ⇒ 缺席时落 `undefined`（JSON 掉键），**不冒充 0**；② `trigger` 认不出的取值 `auto`/`manual`
> 两边都不计。这次口径变更 **bump 了 `PARSER_REV.claude` 11→12**（`compact_boundary` 大多落在会话中后段，
> 老会话的事件在 `off` 跳过的那一段里，不 bump 就永远补不回来；11→12 那次是同功能内的 compDrop 口径修正）。
> 此前这三个字段被 `emitClaudeTurns`
> 的 `isQoder` 守卫挡住，只有 qoder 落盘 —— 该守卫已在本轮松开。

## 内置与自动发现

**内置**（开箱即读，不需要配置）：`atomcode`（`~/.atomcode/sessions`）、`codebuddy`（`~/.codebuddy/projects`）、`workbuddy`（`~/.workbuddy/projects`）。

**自动发现**：服务启动与每轮扫描时，会对 `claude / codex / cursor / trae / qoder / opencode / gemini / copilot / windsurf / codearts / kimi / dsh / zcode / doubao / hermes / devin / minimax / mimocode / kilo / openclaw / cline`
在 `~/.<name>`、`%APPDATA%\<name>`、`Application Support/<name>`、`~/.config/<name>` 等位置自动嗅探，
命中即注册（`source:auto`）；对应目录消失时自动摘除，不报错。
（zcode 的命中条件是 `~/.zcode/cli/db/db.sqlite` 这个库本身，按内容验证三张核心表，不是看目录名。
hermes 同理：认 `state.db` 文件本身（Win=`%LOCALAPPDATA%\hermes`、mac/Linux=`~/.hermes`，
`HERMES_HOME` 指到哪认到哪），按页头 + `sessions`/`messages`/`session_model_usage` 三张表验明正身。
devin 同理：认 `sessions.db` 文件本身（Win=`%APPDATA%\Devin\cli`、mac/Linux=`~/.local/share/devin/cli`），
按页头 + `sessions`/`message_nodes`/`tool_call_state` 三张表验明正身；**不**探老的 `~/.local/share/cognition/cli`
（那是同一份库的向后兼容软链，两头都认会把同一个库注册两遍）。
trae 同理：`%APPDATA%\Trae CN` 下先找 `ModularData/ai-agent/database.db`（SQLCipher 库，按「不是明文
SQLite 头」验证），找不到才回退认 `logs` 目录里的 renderer.log —— 库是主源，日志是回退源。
doubao 的命中条件见上面 doubao 一节：Windows 上走 `%LOCALAPPDATA%\DoubaoWork\…` 真路径，判据 = `agents/<id>/system/trajectory.jsonl` 的目录结构 + 首行 `role` 字段双保险。
minimax 的命中条件见上面 minimax 一节：`~/.minimax` 下钻到 `v2/sessions` 的 `YYYY/MM/DD/<…-session_<id>>` 四层结构，判据 = 首行 JSON 含 `message_id` + `message.role` 取 user/assistant/toolResult 之一（只读头 2KB，不要求首行带 usage/model——真库首行永远是 user 消息）。
openclaw 的命中条件见上面 openclaw 一节：`stateDir`（`OPENCLAW_STATE_DIR` › `OPENCLAW_HOME/.openclaw` › `~/.openclaw` › 老的 `~/.clawdbot`）下钻到 `agents/<id>/sessions/*.jsonl`，判据 = **首行**是会话头（`type:"session"` + `version` + `id`，只读头 2KB），并硬排同样以 `.jsonl` 结尾的 `<id>.trajectory.jsonl`；手工填 `stateDir / agents / agents/<id> / agents/<id>/sessions` 任意一层都认。
kilo 的命中条件见上面 kilo 一节：认 `~/.local/share/kilo/kilo.db` 文件本身，判据 = 页头 + 核心三表 `session`/`message`/`part` 齐 **且** 命中自有扩展表 `kilo_board` / `kilo_board_message` 之一（**反向排除**：opencode 判据也要排掉带 `kilo_board*` 的库）；`sniffBase` 里 kilo 排在 opencode **之前**，两者在真实库上互为假。
cline 的命中条件见上面 cline 一节：`~/.cline` 下钻到 `data/sessions/<会话 id>/`，判据 = 文件名以 `.messages.json` 结尾 **+** 头 2KB 里同时出现 `"sessionId"` 与 `"messages": [`（整份 JSON 是 pretty-printed，头几个键必在最前，所以只读 2KB）；`sniffBase` 里必须排在 atomcode 兜底之前，否则手工填 `…/data/sessions` 会被认成 atomcode 而 0 条静默。VS Code 系满地的 `nls.messages.json`（顶层是数组）被这条判据挡在外面。

## codex

> **「用户输入」有两种落点，都要认**（同一条推论：**不能**回退到 `response_item/message` 取用户输入）：
>
> | 方言 | 事件 | 正文位置 |
> |---|---|---|
> | 老 | `event_msg` + `payload.type = user_message` | `payload.message` |
> | 新（Codex Desktop 实测） | `event_msg` + `payload.type = item_completed`、`payload.item.type = UserMessage` | `payload.item.content[]` |
>
> **不能回退到 `response_item/message`**：注入物（`<environment_context>`、`<permissions instructions>`、
> `<app-context>` 等）同样是 `role: "user"`，与真人输入在字段上区分不出来 —— 拿它兜底会把注入物当成用户原话。
> `toText()` 两种形态都认（`message` 直接是串或内容块数组；`item` 走 `content[]` 那一支），解析侧只需认准事件。
>
> **同版本号也可能是不同方言**：实测同事 Mac 与本机同为 `cli_version 0.153.4`，Mac 那份整篇没有
> `user_message`、本机那份有 —— 所以**按版本号分支是错的**，两种方言必须并存。认老不认新时的症状很具迷惑性：
> 轮次、token、耗时、AI 输出**全都正常**，只有「用户输入」一栏是空的（页面渲成「（空）」）。
>
> **同一轮的 `item_completed` 里还夹着 `AgentMessage`**（助手正文），解析时不能顺手当成用户输入 ——
> 判据是 `payload.item.type`，不是 `payload.type`。

## kimi

> **kimi 认三个变体，全部归一到同一个 `kimi` 入口**：
> 1. Kimi Code CLI —— `~/.kimi-code/sessions/<slug>/<会话 id>/agents/main/wire.jsonl`
> 2. Kimi CLI —— `~/.kimi/sessions/<hash>/<会话 id>/wire.jsonl`（少一层 `agents/main`）
> 3. **Kimi 桌面版（daimon）** —— 它**内嵌了一份 kimi-code**，会话落在自己挑的数据根下：
>    `<shareDir>/…/runtime/kimi-code/home/sessions/…`，结构与 1 完全同源，解析器一行没改。
>    `shareDir` 记在桌面版自己的 `daimon-storage.json` 里（`{"shareDir":"E:\\KimiData\\daimon-share"}`，
>    用户可以在设置里挪到别的盘），所以路径是**读出来的、不是写死的**。
>
> 判据是 `wire.jsonl` 的**文件头**（首行 `{"type":"metadata","protocol_version":…}`）加上目录结构 ——
> 不能靠读「前 N 行找某个事件名」：`wire.jsonl` 第 2 行是整份 system prompt（实测单行 20KB），
> 任何固定大小的头部窗口都会被它挤爆。
>
> **一个 agent 可以有多份日志根**（kimi 就是：CLI 一份、桌面版一份，可能分在两个盘），
> 配置里用 `sessionsExtra` 承载额外的同格式根 —— 见 README.md「数据与配置」与 REFERENCE.md 详解和 `rootsOf()` 的注释。
>
> 桌面版会话的「项目」是它自己的任务工作区（`<shareDir>/kimi/tasks/<日期>/<id>`），
> 不是你的代码仓库 —— 那是 Work 模式一个任务一个工作区的设计，日志里只有这个路径。
>
> ⚠️ 桌面版的数据根目录里有**明文 API key 与 accessToken**（`config.toml`、`kimi-code-key.json`、
> `daimon/config.json`）。本服务只读 `sessions/`，不碰那几个文件 —— 但你截图/打包/外传那个目录前请留意。

## R19 / R20 统一条目字段（2026-09-17）

所有解析器 emit 的列表条目现在都可带：

- `finished`：源格式确认该轮已经收尾；老 index 没有该字段时由前端按兼容规则处理。
- `aborted`：源格式明确记录用户中断/取消。它与 `status:'error'` 独立；dsh 为保持既有验收口径，非 completed 结局仍可能同时是 error。
- `toolNames`：工具名到次数的去重 map，例如 `{ "Bash": 12, "Read": 5 }`。详情仍保留完整工具调用；cursor 因源日志没有工具明细不提供摘要。

列表卡片只展示前 5 个工具名，超出显示 `+M 更多`。R19/R20 改变了 claude、buddyjsonl、codex、kimi、codearts 的落盘 turns 口径，对应 `PARSER_REV` 已 bump；dsh、zcode、gemini、cursor、traedb、opencode、kilo 是签名全量重读，不依赖 rev（kilo 仍登记了 `PARSER_REV.kilo=1`，管的是搜索分片作废，本 kind 不落 index）。

## 工具失败信号（I6 判据，2026-09-23；I13 扩三分类，2026-09-24）

「哪个工具最常失败」这条画像的判定只有一句：**解析器落在 `tools[].error` 上的结构化标志非空即算失败**
（`!!error`）。不扫输出正文、不比字符串 —— 各家的取值形态本来就不统一（`dsh` 是布尔 `true`、
`claude` / `doubao` / `minimax` 是字面串 `'error'`、`zcode` / `traedb` 是人话原文、
`cline` 也是人话原文但**挂在逐项结果上** —— 它的 `tool_result.content[]` 每项各带
`{query, result, success, error?}`，一次批量调用可以只错一项，取第一条失败项的 `error` 当标志），
而「输出里恰好写着 error」更不是失败。

**I13 起这一档扩成三分类**：`error`（`!!tools[].error`）/ `timeout`（`tools[].timeout` 有值）/
`soft`（`tools[].soft` 有值）。判据仍然是同一句 —— **只读解析器落好的结构化标志、一个字正文都不扫**，
变的只是"有几位可读"。三者的口径与归属：

- **`error` 算失败**：产品标了失败的调用。
- **`timeout` 也算失败**（`fail = error + timeout`）—— 它就是失败。
- **`soft` 单列一档、不进失败率**：它是"判定为正常"的那些结果（见下），并进失败率就是把正常读成故障。

**没有 `is_error` 键 ≠ 不知道**：claude 系走 Anthropic 协议，false 可以整个省略，所以 `!!error` 与
「缺键即正常」在这一家同义。本机实测 141 份 claude 转录 / 14167 个 `tool_result` 块，`is_error` 分布
`true` 442 · `false` 5790 · **无此键** 7935 —— 缺键那批是真的没失败。

**超时为什么要单独读一层**：`toolUseResult.timedOutAfterMs` 命中 30 次（取值就是产品的超时档位
`45000 / 60000 / 90000 / 120000 / 180000 / 200000 / 300000 / 600000`），这 30 行的
`tool_result.is_error` **一律显式写着 `false`** —— 不是缺键。⇒ 它们在旧口径下不是"未知"，是被**明确记成
"这一跑没问题"**。一句更准确的表述：超时对 `!!error` 不是"看不见"，是"被读反了"。
同理 `returnCodeInterpretation`（`No matches found` 39 / `Files differ` 2）与 `staleRecovered` 16
实测 `is_error` 也全是 false ⇒ 它们进 `soft`，**不算失败**（"rg 没搜到"是最常见的正常结果）。

**信号从哪来（claude 系，且只在详情侧）**：这三个字段在**记录级**的 `toolUseResult` 上，不在
`tool_result` 块里 —— `parsers/claude.mjs` 的详情回填（`claudeEntryContent`）在回填工具结果时顺手
把它们搬到 `tools[]` 上（`timeout` = 档位毫秒数、`soft` = 判定串 / `'staleRecovered'`）。
**这一笔不动落盘 turns 口径，所以不 bump `PARSER_REV`**；它动的是搜索分片里的 `tf` 值形状 ⇒
`tf` 从 `{名:次数}` 变成 `{名:{e,t,s}}`，`SHARD_V` 2→3（与 `PARSER_REV` 管的是两件事）。

**别家没有这一层**：`TOOL_TIMEOUT_SIGNAL_KINDS`（主文件）目前只有 `claude` —— claude 与 qoder-cn
共用 claude 解析器与这个 kind，两家转录实测都带全三层（claude 30 / 41 / 16，qoder-cn 80 / 72 / 29）。
不在这个集合里的来源，聚合侧把它的 `timeout`/`soft` 置 **null 而不是 0**，页面**不印 0** ——
那个 0 会被读成「这个 agent 一次没超时」，而真相是「源里根本没有这一层」。
⚠️ 别把 `jsonl` 加进去：那是 atomcode 的解析器 kind（见 `search.mjs` 的 `parserKindOf`），不是 claude。

**信号从哪读（详情侧，不是扫描侧）**：`entryContent(id)` 返回的 `tools[]` 上。
各家出处 —— dsh `:290`、zcode `:265-267`、traedb `:247`、opencode `:127-130`、kilo **同 opencode**（`parsers/kilo.mjs` 复用其 `addTool`）、hermes `:199-203`、
devindb `:334`、gemini `:172`、atomcode `:279`、claude `:219`、kimi `:243`、buddy `:253`、doubao `:399`、
minimax `:482`、copilot `:187`、trace 系由 span 现算（`agent-acta-server.mjs` 的 trace 支路）。

**为什么不在扫描侧统计**：`claude` / `kimi` / `buddy` / `doubao` / `minimax` / `codex` 这些走 `off` 增量读的
kind 在扫描时**根本不带工具结果**（`claude.mjs:105` 连 `tool_result` 整行跳过），而 `is_error` 恰恰在那一行上。
要在扫描侧按名字累计，就得为每个轮挂一个 `tool_use_id → 名字` 的映射、并让它活过扫描边界
（长命令的 result 常落在下一个扫描周期）→ 那是 `index/<kind>.json` 的落盘口径变更，要 bump `PARSER_REV`。
I6 走的是「搜索索引那一遍本来就在逐条读详情」这条零额外读盘的路，所以**没动任何解析器**。
（顺带一条纪律：`test/parser-rev-test.mjs` 的指纹字段表里没有 `toolNames` 这类对象字段，
它**抓不到**"给条目加了一个 map 却忘了 bump" —— 加字段的人得自己记得，别拿"它仍绿"当证据。）

**三档覆盖度（`TOOL_FAIL_TIERS`，按 kind 静态给定，接新 agent 改这一行）**：

| 档 | 含义 | 目前 |
|---|---|---|
| `signal` | 详情里有 `tools[].error` 可用 | claude 系（含 qoder-cn）、dsh、zcode、traedb、opencode、kilo、hermes、devin、gemini、atomcode、kimi、buddy 系、doubao、minimax、copilot、trace |
| `noDetail` | 详情**压根不回工具行**（`tools: []`） | cursor、codearts |
| `noFlag` | 有工具行，但 `error` 恒空 / 源头不落地 | codex（`codex.mjs:172` 建好后从不赋值）、tracecode / tracework（`:335`「工具返回不落地」）、generic-jsonl（rules 无 result 规则、`output` 恒空） |

后两档在页面上**一律不画 0**：那里的空是「没有这个信息」，不是「这个 agent 从不出错」。
另有第四态**未索引**（这一轮的 `tf` 键还没落进搜索分片）—— 它也不参与分母，见
`REFERENCE.md`「工具失败画像」。

**与轮级 `status` 不重叠**：`status != ok` 是轮级、各家判据不一（claude 只由 `isApiErrorMessage` 决定，
`claude.mjs:169`，工具失败不参与；`zcode.mjs:271` 才把工具失败冒泡成轮 err；dsh 不冒泡）。
本机实测：claude 全体非 ok 轮 2.9%，而抽样里带工具的轮 20% 含失败工具 —— 两个数回答的是两个问题。

## 环境诊断

> 想知道**哪个 agent 的目录在、但格式没认出来**，用 `GET /api/diagnose`（页面侧栏「环境诊断」）：
> 它逐个列出每个候选 agent 的每个候选路径、探到的 kind、以及没认出来时该目录里长什么样。

## 手动添加

侧栏 Agent 标题右侧 `+`，填名字（留空路径自动探测）或直接指定 `sessions` / `projects` / `traces` 目录。

⚠️ **指到一个已被别的 agent 在扫的目录（含它的上层或某一层子目录）会被明确拒绝**，并点名那个 agent：
条目 id 只由「文件路径 + 轮」决定、不认 agent 名，所以同一批文件被两条 agent 扫**不会多出一份数据**，
只会让后扫的一方把条目的归属抢过去、原先那行变成 0 条。想分开看请在页面里按项目/会话筛。
自动发现那一侧一直有 `dirTaken` 拦着；手动添加这条更严（管到包含关系），因为「CodeBuddy 看不到吗，
那我把它的目录手填一遍」这类自救动作恰好会撞在并源后的 `codebuddy` 额外根上。
