# AgentActa

[English](./README.en.md) | 中文

本地 AI agent 请求日志面板：聚合多款 AI agent 写在磁盘上的会话日志，在浏览器里查看每一「轮次/请求」的耗时、token、缓存命中、上下文占用与工具调用明细。

- 本地常驻服务 + SSE 实时推送，**无外部依赖、无网络上报、纯只读旁路**（不注入、不改各 agent 的配置）
- 一个页面看 24 家 agent：atomcode / codebuddy / workbuddy / claude / codex / cursor / trae / qoder / opencode / gemini / copilot / windsurf / codearts / kimi / dsh / zcode / doubao / hermes / devin / minimax / mimocode / kilo / openclaw / cline
- 另有桌面悬浮卡片（Electron 小窗）：今日/累计 token + 最新卡片流

要求：机器上有 `node`（`node -v` 可用即可，`>=22.5`）。**Windows 是主要验证平台**；mac / Linux / 鸿蒙 PC
的代码路径（候选目录按平台展开、跨平台搬运的自愈、POSIX 权限）已就位并有回归钉着，但未在真机端到端跑过 ——
换平台前先看 [REFERENCE.md](REFERENCE.md)「跨平台」一节，那里写明了两边不一致的地方与要手工处理的两三件事。

完整口径、原理与排障详解见 **[REFERENCE.md](REFERENCE.md)**；各 agent 日志格式的字段口径与解析边界见 **[LOGFORMATS.md](LOGFORMATS.md)**。

## 安装与快速上手

### 从 npm 装

```bash
npm i -g @yxzpro/agent-acta        # 装完多出命令 agentacta 与 agentacta-mcp
agentacta --open                   # 起服务并打开 http://127.0.0.1:14570
```

⚠ 包名带作用域 `@yxzpro/`：裸名 `agent-acta` 与 npm 上已存在的 `agentacta`（别人的同类项目）被判定太像而发不出去。**命令名不受影响**，敲的还是 `agentacta`。国内镜像同步有先后（实测 npmmirror 还没同步到，腾讯云镜像已可回源），装不上就加 `--registry=https://registry.npmjs.org/`。

### 拿到的是压缩包（tgz）

```bash
npm i -g agent-acta-<版本>.tgz   # 装完多出命令 agentacta
agentacta --install-hooks          # 可选：会话启动时自动拉起服务
agentacta --open                   # 起服务并打开 http://127.0.0.1:14570
```

### 拿到的是源码目录

```bash
npm i -g <本目录>                                # 软链安装，改源码即时生效
node <本目录>/agent-acta-server.mjs --ensure     # 或者不装 npm，直接一条命令起服务
```

然后浏览器打开 <http://127.0.0.1:14570>。支持的服务已自动发现，无需配置。

## 命令一览

| 命令 | 作用 |
|---|---|
| `agentacta` | 前台常驻（服务本体） |
| `agentacta --ensure` | 确保端口上跑的是**本版**服务：同版幂等退出，旧版自动重启（hook 调的就是它） |
| `agentacta --open` | 起服务并打开浏览器 |
| `agentacta --client` | 起桌面悬浮卡片（首次执行会装 ~100MB Electron 运行时到 `~/.agent-acta/widget-runtime/`） |
| `agentacta --stop` | 停止服务（先优雅关闭并落盘索引，拿不到响应才按 pid 强杀） |
| `agentacta --status` | 查状态：服务在不在跑、端口上那版与本地包是否一致、悬浮卡片开着没（退出码 0 一致 / 1 不一致或问不出 / 2 没在跑） |
| `agentacta --doctor` | 自检并输出一段**可粘贴的病历**：配置能不能解析、配置指向的目录还在不在、索引片有没有损坏或口径对不上、端口上跑的是不是这一版、页面文件齐不齐、归档现在多大（退出码 0 无失败 / 1 有失败）。**只读**，不改数据也不改配置 |
| `agentacta --install-hooks [--dry] [--agent atomcode,claude]` | 把「会话启动自动拉起」写进 atomcode / claude 的配置（幂等，改前自动备份） |
| `agentacta --uninstall-hooks` | 移除上面写入的 hook |
| `agentacta --where` | 打印自身安装路径 + 可直接抄的 hook 命令 |
| `agentacta --archive` | 归档一次：把「已结束、且早于今天」的日志条目连详情快照冻进 `~/.agent-acta/archive/`（有些 agent 自己删日志，不冻就永久没了）。服务在跑时也会每天自动归档；这条是手动补跑/排查用的 |
| `agentacta --archive --list` | 只看归档清单，不做归档 |
| `agentacta --archive --dry` | 只报要写什么、不落盘（可配 `--list`） |
| `agentacta --search-reindex [--dry]` | 手动重建全文搜索索引（页面搜索框**回车**搜的就是它）。日常不用跑：服务启动 60 秒后自己建首轮、之后每 10 分钟一轮增量。**服务在跑时拒绝执行**（先 `--stop`），`--dry` 只统计不落盘 |
| `agentacta-mcp` | 以 **MCP server** 身份跑（stdio）：给 Claude / Cursor / Qoder 这类客户端当只读工具用，见下节 |
| `agentacta --version` / `-v` | 版本号 + 服务脚本指纹（判断端口上跑的是不是这一版） |
| `agentacta --help` / `-h` | 用法 |

未知参数会报错并以退出码 `2` 结束，不会默默起服务。

**改完服务端代码后**：`agentacta --ensure` 一步到位（比对代码指纹，不一致就停旧拉新）。改页面只需刷新浏览器。

## 当 MCP server 用（让 agent 自己查日志）

`agentacta-mcp` 是随包发的第二个命令，把本机日志以 MCP 工具的形式开放给客户端；它是**独立进程、直读**日志与索引，**不连 14570、不写任何文件**，所以常驻服务在不在跑都能用（首次握手后要全量扫一遍本机日志，约 2s，期间不打日志）。

配置片段（把路径换成本机实际装的那份，`agentacta --where` 可查）：

```json
{ "mcpServers": { "agent-acta": { "command": "node", "args": ["<安装目录>/mcp-server.mjs"] } } }
```

| 工具 | 干什么 |
|---|---|
| `overview` | 有哪些 agent、各多少条、索引新旧 |
| `search_entries` | 按 agent/项目/时间范围列轮次（时间倒序，默认 50 条） |
| `get_entry` | 按条目 id 取全文（提问、输出、工具调用、LLM 明细） |
| `list_sessions` | 按会话聚合：几轮、多少 token、跨多久 |
| `usage_stats` | `by=day` 逐日 / `by=model` 按模型的汇总 |
| `slowest_turns` | 最慢的 N 轮 + p50/p95 |
| `tool_fails` | 哪个工具最常失败 / 超时（三分类排行 + 逐 agent 覆盖度，超时算失败、软失败单列） |

工具口径与页面/HTTP API 同源（同一批聚合函数），不另算一套。完整说明与逐客户端配置在 REFERENCE 的「作为 MCP server 接入」。

## 当 DSH 插件用（在 DeepSeek Harness 里看同一块面板）

装了 [DeepSeek Harness](https://atomgit.com)（DSH）的话，可以把它当 Cordis 插件装进去：左侧栏多一个「AgentActa」图标，点开在中间栏占一整块面板 —— 就是同一个 Vue3 页面（iframe 承载，筛选 / 详情 / SSE 实时推送都在），**不需要你再开浏览器或常驻服务**。

```
dsh plugin --profile desktop add "@yxzpro/agent-acta"                      # npm 包名
dsh plugin --profile desktop add "git+https://github.com/elegant01/agent-acta.git#v2.14.7"   # 或直接从仓库
```

> 包名带 `@yxzpro/` 是因为 npm 的相似性规则：裸名 `agent-acta` 与已存在的 `agentacta`（别人的同类项目，2026-02 就发了）判为太像而被拒。
> **产品名没改** —— 命令仍是 `agentacta`，仓库、面板标题、URL 全不变；只有 npm 标识与 DSH 的 bundle 名跟着包名走。

- `dsh plugin` 的参数逐字转发给 pnpm，认 registry / git / tarball / path 四态；只想要文件就把上面换成 `"file:C:/绝对路径/yxzpro-agent-acta-2.14.7.tgz"`（作用域包打出来的 tgz 文件名会去掉 `@`、把 `/` 变成 `-`）。⚠ URL 里的 `#` 与带 `@` 的包名在 Git Bash / PowerShell 里**整条加引号**。把 `v2.14.7` 换成你要的版本即可（`git ls-remote --tags https://github.com/elegant01/agent-acta` 能看全）。
- 本项目以 **MIT** 许可发布（见 `LICENSE`），代码里没有网络出口、也不上传任何日志内容 —— 它只读你自己机器上那些 agent 已经落盘的文件。
- **装完要彻底退出 DSH 再启动**（进程全没才算，只关窗口无效 —— 宿主有模块缓存）。
- 图标没出现，先按这两条查：① 宿主按 semver 判插件兼容（不匹配只进 `skippedBundles`、**不报错**，表现就是不出现）；② `--profile` 有没有指对你实际在用的那个 profile。已在 **DSH 0.1.7-rc.2 / runtime 0.2.0-rc.1** 上验通。

**和命令行服务怎么共处**（这条最常问）：插件**每次请求**现判 `127.0.0.1:14570` 在不在（环回探测约 1ms，结果缓存 2 秒），所以不用你选：

| 14570 | 面板给你什么 |
|---|---|
| 在跑 | **就是它的面板**，原样递进 iframe（数据、SSE、写操作全通）—— 本机仍然只有它那一个扫描器，插件不另起一套 |
| 没在跑 | 插件自己在宿主进程里起一套（不监听端口、不写 pid、不空闲自停），面板照常用 |

CLI 中途退出时面板会换成一小页「命令行服务已退出」，带一个**让插件接手**按钮 —— 点了才起，不自动起：自动起可能和你又把 CLI 拉回来撞成两个写者，这种决定留给人做。
**不需要**为了看面板去 `agentacta --stop` 或重启整个 DSH（早先那版要你这么做，体验很差，已改掉）。

**边界**（有意为之，不是漏做）：插件不唤起悬浮卡片，`/`（宿主的认证兜底位）、`/api/shutdown`、`/api/client`、`/api/trae/capture-key`、`/widget` 这五条路由在宿主里根本不注册（防一次误触把宿主进程带走）；面板保持自家深色皮、不跟宿主明暗切换；数据面照旧只读本机、零网络出口。细节在 REFERENCE 的「作为 DSH 插件接入」。

## 页面用法速查

打开 <http://127.0.0.1:14570>：

- **筛选**：Agent / 项目 / 时间范围（今天 / 近 7 天 / 近 30 天，按本地自然日）/ 状态 / 关键词
- **全文搜索**：搜索框里**敲字** = 只筛当前窗口（即时、免费）；**按回车** = 全库检索 —— 搜的是每条轮次的**正文**
  （用户输入 + AI 回复 + 工具入参/返回），跨 agent、跨未加载的历史，**默认不套时间范围**（「上周那次报错」本来就在默认两天之外）。
  结果直接接手卡片列表，命中片段会高亮；顶部横幅如实报「已索引 A/B 条」「不套用时间范围」，以及这一轮是否被
  单轮 200 条上限截断（「本次只取回 200 条」），想按当前日期收窄就勾「限定当前时间范围」。
  索引由服务在后台增量维护（`~/.agent-acta/search/`），首次启动约一分钟后可搜
- **卡片**：点任意卡片展开用户输入、AI 输出、执行链路、LLM 调用明细与工具调用
- **右上角状态徽标** = SSE 连接状态，点它可调刷新频率；旁边下拉可开「空闲自停」（30 分钟 / 2 小时 / 6 小时，默认关）
- **按会话浏览**（侧栏第 2 项）：以 session 为单位看完整多轮演进；dsh / zcode / trae 的会话带真实时间轴。
  会话名取**产品自己起的标题**（I14：claude 系读转录里的 `ai-title`、没有则退回 `last-prompt`；dsh / gemini /
  buddy / zcode / traedb / opencode / kilo / hermes / devin 各有各的源头），都没有才退回显示会话 key —— **不拿文件名冒充标题**
- **子 agent 拓扑**（I16）：会话列表里子 agent 会话缩进带 `└`，父会话那行显示「合计 N 轮 · x tok」（含自身）；
  右栏顶部可点着**跳父 / 跳子**。判据是源头的显式谱系外键（dsh 的 `parentSession`、claude 的 `subagents/` 目录 +
  `.meta.json`、zcode/opencode 的 `session.parent_id`、hermes 的 `parent_session_id`），**不按时间区间猜**
- **时间未知如实标注**（I16）：拿不到轮时间戳的轮（atomcode 的 `.jsonl` 0 字节 / `turn_id` 缺失，本机 44.6%）
  不再拿会话 `updated_at` 冒充 —— 卡片标「时间未知」，且不进按天统计（统计弹层写明少算了几轮）
- **用量统计**（工具栏折线图标）：按天聚合 token 与耗时 + 按模型聚合，跟随当前筛选；
  「时延分析」里有四个排行子 tab —— 最慢轮 / 工具调用 / 缓存命中率 / **工具失败画像**（I6：哪个工具最常失败，
  含覆盖度表：哪几家源头根本没有逐工具失败信号，那里空着不是"从不出错"）
- **导出**（工具栏下载图标 → JSON / CSV / Excel）：导的就是列表此刻这份筛选集，并且**把筛选条件一起写进文件**
  （CSV 头两行、Excel 说明行、JSON 的 `meta.filters`）—— 事后能自证「这批数是按什么筛出来的」。展开某一轮后
  详情底部还有**导出该轮完整详情**（走 `/api/entry?full=1`，工具入参/返回不截断）。纯浏览器下载，服务端不写盘；
  口径、列清单与「为什么 Excel 是 SpreadsheetML」见 REFERENCE.md「导出（R11）」一节
- **两轮对比**（卡片顶行「对比」按钮，点两条自动弹开）：并排比耗时 / 模型 / LLM 调用 / 工具 / 积分或 Token /
  上下文占用 / 压缩，每条指标标出「谁大」与差多少；下半区是两条的用户输入、AI 输出与工具调用逐条对照（点开才取）。
  qoder 那侧只给积分与占比（它不落盘 token，印 0 会被读成"没花钱"），混比时不适用的一格给 `—` 且不作差
- **单轮复现包**（卡片详情底栏「导出复现包」）：一键 zip = 该轮**原始日志片段**（按解析器同一套开轮判定切，
  行号与磁盘一致）+ 完整解析结果 + 四枚版本指纹 + 导出那一刻的筛选条件，贴群 / 提 bug 直接带上文。
  zip 在浏览器里手写打包（store 模式、零依赖），**服务端不写盘、不新增网络出口**；数据库 / 多帧压缩那几家
  切不出原始片段，会退回「原始路径 + 完整解析结果」并说明原因
- **历史归档**（侧栏第 4 项）：浏览 `~/.agent-acta/archive/` 里被冻结的历史条目 —— 产品自己删日志（如 CodeArts 只留约 30 天）后，这里还打得开当时的用户输入 / AI 输出 / 工具与调用明细。**只读旁路**，不跟随左侧筛选；左下还有一排**归档开关**（每个 agent 一个，不想留的关掉即可）
- **磁盘占用**（侧栏第 6 项）：按 agent 列「日志目录 / 归档 / 索引片」各占多少、谁最大，清理前先看清构成（`~/.agent-acta` 顶层逐项列出，含 widget 那份 Electron 运行时）。**只统计、不删除**；遍历带预算，走不完会明标「统计到一半」而不是给个看似完整的假数
- **解析器自检**（侧栏同名一项）：改完解析口径，上一次回归跑成什么样 —— `test/` 下每个脚本各自的结果（绿 / 红 / 超时）、耗时、以及**这次没跑的以及为什么不跑**，一页看全。数据来自 `~/.agent-acta/selftest.json`（由 `node test/selftest.mjs` 写），这一页**只读、不在浏览器里跑测试**；结果出自另一版代码时顶部会黄条警告「这份绿不代表当前这版」
- 侧栏每个 agent 旁的开关 = 临时禁用（不删配置）；`✕` = 移除该 agent 配置（不动本地日志文件）；`+` = 手动添加
- **cursor 行那个图标按钮 = 注入 / 卸载 token 采集钩子**：cursor 的转录文件里没有 token，本地唯一的逐轮用量
  来自它自己的 `stop` 钩子。点一下（二次确认）就往 `~/.cursor/hooks.json` 加一条命令，之后每轮的
  input/output/缓存用量会被采到 `~/.agent-acta/cursor-usage.jsonl` 并贴回卡片上；再点一下卸载。
  **只加自己那一条、不动你已有的钩子**；`hooks.json` 不是合法 JSON 时会拒绝改动而不是覆盖。口径见
  [LOGFORMATS.md](LOGFORMATS.md) 的 cursor 一节，接口见 [REFERENCE.md](REFERENCE.md) 的 `POST /api/cursor-hook`
- 桌面挂件（不用 Electron 的轻量玩法）：
  `msedge --app=http://127.0.0.1:14570/widget`，再用 PowerToys 置顶

## 数据与配置

- 配置：`~/.agent-acta/config.json`（老位置 `~/.agent-log/`、`~/.atomcode/agent-log/` 启动时自动搬迁）
- 索引：`~/.agent-acta/index/<kind>.json`（增量偏移持久化，重启不全量重扫）
- 归档：`~/.agent-acta/archive/<agent>/<YYYY-MM-DD>.jsonl` + `manifest.json`（条目级冻结，默认永久保留）
  - 每个 agent **可单独开关**：在「历史归档」弹层左下直接点（写 `config.json` 的 `archive.skip`，即改即生效，不用重启）；
    手改配置也行：`"archive": { "skip": ["cursor"] }`。**只停未来的归档，已冻好的文件保留**
  - 同段还能配 `enabled`（关自动轮）、`maxDays` / `maxMB`（限量，只删整天文件）。详见 REFERENCE「历史归档」
- 全文索引：`~/.agent-acta/search/<kind>.json`（每条轮次的正文，一个源一条记录）。**由服务自己在后台增量维护**
  （启动 60 秒后首轮、之后每 10 分钟一轮），不需要手工干预；手动重建用 `agentacta --search-reindex`（服务在跑时先 `--stop`）。
  本机量级参考（2026-09-22 晚，常驻服务实测 `/api/search/status`）：**648 个源 / 5111 条可查**（该机共 5431 条，
  余下的要么源文件已被产品删掉、要么这一轮本来就没有正文）→ 索引约 **24MB**。
  想关掉「每条正文最多索引 8000 字」的上限，用环境变量 `AGENT_LOG_SEARCH_MAX_CHARS`
  - 记录按**绝对路径**认源，所以把 `~/.agent-acta` 搬去另一台机器/另一个平台后，载入时会把对不上本机的
    记录剪掉并重扫（日志与 `/api/search/status.pruned` 都会报数）。POSIX 上 `search/` `index/` `archive/`
    三处都按私有新建（`0700`/`0600`，里面是明文对话）；老文件不动，要一次收干净就 `chmod -R go-rwx ~/.agent-acta`
- 端口：默认 `14570`，环境变量 `AGENT_LOG_PORT` 可覆盖
- pid 文件：`~/.agent-acta/server-<端口>.pid`

## 服务端 HTTP API

| 端点 | 作用 |
|---|---|
| `GET /` | 页面 |
| `GET /widget` | 桌面小卡片页（SSE 实时刷新） |
| `GET /api/ping` | 存活探测 |
| `GET /api/version` | `{version, build, pid}`，build = 服务脚本内容指纹 |
| `GET /api/agents` · `POST /api/agents` · `DELETE /api/agents?name=` · `POST /api/agents/toggle` | agent 配置的增删改查 |
| `GET /api/diagnose` | 环境诊断：每个候选 agent 每条候选路径的探测结果与未识别原因 |
| `GET /api/usage?force=1` | 磁盘占用：按 agent 的日志/归档大小 + 索引片 + `~/.agent-acta` 顶层构成（结果缓存 60s，`force=1` 绕开） |
| `GET /api/selftest` | 上一次回归自检的结果（原样递出 `~/.agent-acta/selftest.json` + `ageMs` / `sameBuild` / `sameParserRev` 三个诚实标注）。**不跑测试**，没跑过时 `ok:false` 并附 `hint` |
| `GET /api/snapshot?limit&agent=&project=&range=&scan=1` | 条目快照（列表主数据） |
| `GET /api/daily` | 按自然日聚合 token/耗时（不吃 limit，算整个筛选集） |
| `GET /api/models` | 按模型聚合（参数同上） |
| `GET /api/analyze?range=&agent=&project=&from=&to=&top=` | 排行分析：`slowest` / `p50` / `p95` / `byTools`（本轮工具次数）/ `byCacheRate` + `toolFails`（**I6 工具失败画像**：`rows` 按 agent×工具名出 `fail/total/rate`，`agents` 出覆盖度与「未索引」数）。`top` 上限 50，默认 10 |
| `GET /api/entry?id=&full=1` | 单轮详情（dsh/zcode/traedb 额外返回逐事件 `events[]`） |
| `GET /api/search?q=&re=1&agent=&project=&status=&from=&to=&limit=&offset=` | **全文搜索**（页面搜索框回车走的就是它）。`from`/`to` 只在页面勾了「限定当前时间范围」时才传，**不传 = 不限时间**；每条的 `_snip` 是命中片段（三段纯文本，页面自己转义再高亮）。空的 `q` 与非法正则都回 400 + 原话 |
| `GET /api/search/status` | 全文索引的覆盖度：`{entries, files, total, building, unreadable, noState, bytes, at, maxChars}` —— 页面横幅「已索引 A/B 条」用的就是前四个 |
| `GET /api/sessions` · `GET /api/session?key=` | 会话列表与会话详情（「按会话浏览」） |
| `GET /api/events` | SSE：hello / update / remove / agents / settings / resync / scanning |
| `GET /api/settings` · `POST /api/settings` | 扫描节奏 / 空闲自停 |
| `GET /api/ctxwindows` · `POST /api/ctxwindows` | 上下文窗口表（claude/kimi 进度条分母） |
| `GET /api/archive/index` | 归档清单：`{root, days[], agents[], totals, skip[], configAgents[]}`（`skip` / `configAgents` 供「归档开关」列表用） |
| `POST /api/archive/skip` | 逐个 agent 开关归档：`{agent, skip}` → 改 `config.archive.skip`，即改即生效 |
| `GET /api/archive/entries?agent&day&q&limit&offset` | 归档条目列表（**不含**详情，只给 `hasDetail` 标记） |
| `GET /api/archive/entry?agent&day&id` | 单条冻结的详情快照（没了返回 404） |
| `POST /api/shutdown` | 优雅关闭（落盘索引后退出） |

各端点的字段细节与口径见 [REFERENCE.md](REFERENCE.md)「服务端 HTTP API」。

## 打包分发（开发者）

```bash
mkdir -p ../dist
npm pack --pack-destination ../dist   # → dist/agent-acta-<版本>.tgz（发版前先 bump package.json 的 version）
node test/pack-smoke.mjs              # 冒烟：解包→隔离环境跑起来→逐个接口探一遍
```

回归/验收脚本在 `test/`（带 fixture，可重复运行）。一次跑完并在页面上看结果：

```bash
node test/selftest.mjs                 # 默认清单（不依赖仓库外东西的那些），串行约 2 分钟
node test/selftest.mjs --only parser   # 只跑名字对得上的（前缀或标题里含这个词）
node test/selftest.mjs --group parser  # 只跑一组：static / parser / cli / release / real / parity / slow
node test/selftest.mjs --all           # 连默认不跑的组一起跑（要看本机脸色）
```

结果写进 `~/.agent-acta/selftest.json`，页面侧栏「解析器自检」读的就是它（细节见 REFERENCE「解析器自检」）。

发出去的那份 tgz **同时是 DSH 插件包**：`files` 里带 `plugin/`，装载契约全在 `package.json` 上 —— `exports["."]` 给宿主动态 import 服务端壳、`dsh.bundle.patch` 指到 `plugin/cordis.patch.yml`、`dsh.client.inject` 列那两个宿主 UI 包（漏了就装得上但图标不出现）。所以 bump 版本后要一起看一眼：`plugin/client.js` **不能有顶层 `import`/`export`**（宿主把它原样拼进普通 `<script>`，带 ESM 会把整个 DSH 启动带崩）。

## 常见问题速查

- **不知道从哪查起**：`agentacta --doctor` —— 一次列出配置 / 目录 / 索引 / 端口版本 / 页面文件 / 归档的现状，把整段贴出来即可（**只读**，不改任何东西）
- **页面打不开 / 一直「重连中…」**：`curl http://127.0.0.1:14570/api/ping`；无响应跑 `agentacta --ensure`
- **升级/改码后新接口 404**：端口上是旧版服务，`agentacta --ensure` 重启（判据：`GET /api/version` 的 `build` 指纹；`--doctor` 会直接把这条报成 `[fail]`）
- **某个 agent 一直是 0 条**：看侧栏「环境诊断」或 `GET /api/diagnose`
- **换到 mac / Linux（或换了台机器）**：把 `~/.agent-acta` 搬过去即可 —— 索引会按本机磁盘自动校验重建，
  对不上的旧记录自己剪掉；`config.json` 里**手工加的** agent 根会一直留着且 0 条，`--doctor` 会点名并提示
  「这是 Windows 的路径形态」，删掉那几条让自动发现重新认。trae 的密钥抓取只有 Windows，换平台后 token
  与 AI 正文拿不到。详见 [REFERENCE.md](REFERENCE.md)「跨平台」
- **trae 看不到 token / AI 正文**：SQLCipher 库需要一把机器各自的密钥，用 `tools/grab-trae-key.ps1` 抓取后填 `traeKey`——步骤见 [REFERENCE.md](REFERENCE.md)「Trae 的 SQLCipher 库」
- 更多排障（codex 用户输入为空、atomcode datalog、hook 验证卡管道、改源码不生效等）见 [REFERENCE.md](REFERENCE.md)「常见问题」
