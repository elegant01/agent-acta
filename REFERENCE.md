# AgentActa —— 本地 AI agent 请求日志面板

聚合多款 AI agent 的本地日志，在浏览器里查看每一「轮次/请求」的耗时、token、缓存、上下文占用与工具调用明细。
本地常驻服务 + SSE 实时推送，无外部依赖、无上报。

## 安装

### 发给别人 / 长期部署：发压缩包（推荐）

```bash
# 打包方（源码目录里；版本号取自 package.json 的 version，发版前先 bump）
mkdir -p ../dist                      # ⚠️ 必须先建：npm pack --pack-destination 不会自动建目录，
                                         #    缺了它报的是 ENOENT: open ...tgz，看不出是目录不存在
npm pack --pack-destination ../dist   # → dist/agent-acta-<版本>.tgz（约 0.68MB）
node test/pack-smoke.mjs               # 冒烟：解包→隔离环境跑起来→逐个接口与 vendor 资源探一遍
# 想连口径一起验（冒烟只看「包里有没有」）：解包后把 R6_SRC 指过去
#   tar -xzf ../dist/agent-acta-<版本>.tgz -C /tmp/al && \
#   R6_SRC=/tmp/al/package/agent-acta-server.mjs node test/r6-verify.mjs

# 接收方（只要有 node，不需要 git、不需要网络、不需要源码目录）
npm i -g agent-acta-<版本>.tgz    # 装完多一个命令 agentacta
agentacta --install-hooks                # 把「会话启动自动拉起」写进你的 agent 配置
agentacta --open                         # 起服务并打开页面
```

> **`npm pack` 之后跑一下 `pack-smoke.mjs`**（在仓库根）：`node --check` 查的是源码目录，
> 跟包里那两份不是一回事 —— 少一个 `vendor/` 文件、页面内联脚本被压坏，只有装出来才会暴露。
> 它用隔离 `USERPROFILE` + junction 指向真实 `~/.claude/projects`，扫真数据但只读，跑完自动清理。

包内含服务、页面、`vendor/` 静态资源与 `package.json`，无 `.git`、无 `node_modules`。
`npm i -g <tgz>` 装出来是**真拷贝**——重新打包后要重装一次；`private: true` 只挡 `npm publish`，不挡 `npm pack`。

`--install-hooks` 干的事：读改写 `~/.atomcode/hooks.json`（atomcode）与 `~/.claude/settings.json`（claude code），
**保留原有内容，只加自己那一条**；重复跑无副作用（幂等）；改动前把原文件备份成 `<文件名>.bak`；
目标文件 JSON 解析失败就整体放弃、一个字都不改；没检测到的 agent（目录不存在）自动跳过。
加 `--dry` 只预览不写，`--agent atomcode` 可只装一个；反悔就 `agentacta --uninstall-hooks`。

### 自己用 / 要改源码

```bash
npm i -g <本目录>     # 从本地目录装 = 软链（等价 npm link），不留副本、改源码即时生效
```

- 不用 npm 也行：把本目录拷到任意位置，跑一次 `node <目录>/agent-acta-server.mjs --ensure`，
  浏览器打开 <http://127.0.0.1:14570>（加 `--open` 顺手开页面）。

### 命令一览

| 命令 | 作用 |
|---|---|
| `agentacta` | 前台常驻（服务本体） |
| `agentacta --ensure` | 确保在跑的是**本版**服务：同版就幂等退出，是旧版则自动重启（hook 里调的就是它） |
| `agentacta --open` | 起服务并打开浏览器 |
| `agentacta --client` | 起桌面悬浮卡片（无边框置顶小窗：今日/累计 token + 最新卡片流，点小球收成水球）。首次执行会把 Electron 运行时（~100MB）装进 `~/.agent-acta/widget-runtime/`（默认走 npmmirror，`ELECTRON_MIRROR` 可覆盖），装一次之后只是启动；重复执行只是聚焦已有窗口。关闭：悬停卡片顶栏/水球右上角露出的 `✕` |
| `agentacta --stop` | 停掉在跑的服务（先走 `/api/shutdown` 优雅关闭并落盘索引，拿不到响应才按 pid 强杀；没在跑则直接退出） |
| `agentacta --install-hooks [--dry] [--agent atomcode,claude]` | 把 hook 写进 atomcode / claude 的配置 |
| `agentacta --uninstall-hooks` | 移除上面写入的 hook |
| `agentacta --where` | 打印自身安装路径 + 两段可直接抄的 hook 命令 |
| `agentacta --doctor` | 自检一次，输出一段可粘贴的病历（配置 / 目录 / 索引 / 端口版本 / 页面文件 / 归档），退出码 0 无失败、1 有失败。**只读**，不改数据也不改配置。口径见「自检」一节 |
| `agentacta --archive` | 归档一次：把「已结束、且早于今天 0 点」的条目连**详情快照**冻进 `~/.agent-acta/archive/`。服务在跑时会每天自动跑一次，这条是手动补跑/排查用 |
| `agentacta --archive --list` | 只打印归档清单（几个 agent / 几个日期文件 / 多少条 / 多大），不做归档。**只许配 `--archive` 用**，单独敲会报错并退 2 |
| `agentacta --archive --dry` | 只报要给哪些日期文件写多少条，不落盘 |
| `agentacta --search-reindex [--dry]` | 手动重建全文搜索索引（`~/.agent-acta/search/`）。日常不用跑 —— 服务启动 60 秒后自己建首轮、之后每 10 分钟一轮增量。**服务在跑时拒绝执行**（索引只有它一个写者），要立刻整体重建先 `--stop`；`--dry` 只统计不落盘（代价照付），口径见「全文搜索」一节 |
| `agentacta-mcp` | **第二个命令名**（不是 `agentacta` 的开关）：以 MCP server 身份跑，stdio 传输、七个只读工具，给 Claude / Cursor / Qoder 当工具用。独立进程直读日志与索引，**不连 14570、不写任何文件**，口径见「作为 MCP server 接入（R31）」一节 |
| `agentacta --version`（`-v`） | 打印版本号 + 服务脚本指纹（就是 `--where` 里那行「版本/指纹」，用来判断端口上跑的是不是这一版） |
| `agentacta --help`（`-h`） | 打印用法（内容取的就是服务脚本开头的注释，不存在两份会各改各的用法） |

> **参数写错了会报错，不会默默起服务**：认不出来的参数（含 typo，如 `--versoin`）走 stderr 报错并以退出码 `2` 结束。
> 以前它们被静默忽略，所有开关落空就落到默认分支＝前台常驻起服务 —— 只想查个版本，结果占住了端口和终端。
>
> **改完服务端代码 / 升级到新版，重启一步到位**：直接 `agentacta --ensure`（或 `--open`）。
> 它会比对端口上那个服务自报的代码指纹，不一致就优雅停掉再拉起来 —— 不用再手工 `--stop` 再等端口释放。
>
> 为什么必须有这一步：升级包换掉的是**磁盘上的文件**，换不掉**已经在跑的进程**；
> 而服务是从磁盘现读 `agent-acta-page.html` 的，于是会变成**页面是新的、接口是旧的** ——
> 新接口一律 404（页面报 `统计失败：Unexpected token 'o', "not found" is not valid JSON`），
> 新接入的 agent 也扫不到、手动加也加不上。三个症状一个根因。
>
> 直接跑 `agentacta`（前台常驻）撞上端口被占时，若版本不同它会**明说**是哪一版在跑，不再静默退出。
> 页面侧也有一条常驻红条说同一件事，并给出该敲的命令。

### 想让它自动常驻

**不需要任何常驻脚本**：`--ensure` 幂等，挂在**你常用 agent 自己的 hook** 上，用哪个 agent 就由它把服务带起来。

```bash
agentacta --install-hooks        # 一条命令写完（先 --dry 可预览）
```

想手工写就照下面抄。实测冷启动 0.4s、热启动 0.1s（幂等），不会拖慢会话。

**atomcode** —— `~/.atomcode/hooks.json`：

```json
{
  "hooks": {
    "agent-acta": {
      "event": "session_start",
      "command": "node <本目录>/agent-acta-server.mjs --ensure",
      "timeout_ms": 15000
    }
  }
}
```

⚠️ atomcode 的 hook 命令**不经过 shell**，引号会被当成路径的一部分、含空格的路径无解——所以这里**不要加引号**，
本目录路径里也别有空格。改完可用 `atomcode hooks list` 确认已加载，`atomcode hooks test agent-acta` 实跑一次。

**claude code** —— `~/.claude/settings.json`（走 shell，引号是安全的）：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"<本目录>/agent-acta-server.mjs\" --ensure", "timeout": 15 } ] }
    ]
  }
}
```

其它支持 hook 的 agent 同理加一行；一个都没有的话，`agentacta --open` 手动起也一样。

> **别做成 atomcode 插件**：实测 atomcode **不会加载已安装插件里的 hook**（只装插件时 `atomcode hooks list` 是 0 个，
> 跑完会话服务也没被拉起），`marketplace add/install/trust` 这一套在"自动拉起"上没有作用。

服务是纯旁路只读——只按已知路径读各 agent 写的本地日志，不注入、不改配置、不上报。

> 需要机器上有 `node`（`node -v` 能跑即可）。服务与页面都在本目录内，配置与索引写在用户目录，换目录不会冲掉你的配置。

## 使用

- 打开 <http://127.0.0.1:14570>（`agentacta --open` 会替你起服务并打开）
- 右上角状态徽标 = SSE 实时连接状态；**点它可以调刷新频率**（1s / 2s / 3s 默认 / 5s / 10s / 不实时更新）
- 徽标旁「空闲自停」下拉：页面全关且没有新日志超过 30 分钟 / 2 小时 / 6 小时后，服务自己退出（默认关）
- 可用 **Agent / 项目 / 时间范围 / 状态 / 关键词**筛选；点任意卡片展开用户输入、AI 输出、执行链路、LLM 调用明细与工具调用
  - 三个长列表（工具调用 / LLM 调用明细 / 执行链路）**默认只露前几条**，够长时下面给「展开全部 N 个（还有 M 个）」/「收起」。
    实测单轮最多 81 个工具调用，全铺开有 19,318px（约 19 屏）——所以默认就是收着的。
  - **「LLM 调用明细」每一行说明这次调用干了什么**：序号前的蓝点 = 这次调用有正文（点开是「本次输出」）；
    模型名后的灰标记 = 这次调用发起的工具（`Bash×2` = 同一次响应里并行调了两个 Bash，完整列表在悬停提示里）。
    两个标记都没有的行 = 那次调用只回了工具调用、一个字的正文都没说 —— 正常，产物在下面的「工具调用」块里
    （实测一轮 114 次调用里 107 次是这样）。
    逐次正文目前只有 **claude / codebuddy / workbuddy / gemini** 解析得出来，其余 agent 不显示「本次输出」；
    单条超 800 字先截断，点「查看完整内容」按 `full=1` 重取。
  - 详情末尾有吸底的「收起」按钮：滚到再深也点得到，点了折叠卡片并把卡片滚回视野
    （实测滚到 9,659px 深处时，卡片头已在视野上方 9,081px，靠点卡片头是收不掉的）。
  - **点侧栏 agent、选项目、选时间范围 = 把窗口收窄到它**（服务端只取该范围内的最近 N 条），
    所以停更很久的 agent 点进去也能立刻看到它自己的日志，不会因为「全局最近 2000 条里没有它」而空着。
  - 「项目」下拉按**归一化后的项目**分组：同一个项目被各家 agent 写成 `F:\centos\next-admin` / `f:\centos\next-admin` / `f-centos-next-admin`
    （cursor 只有 slug）时并成一项，标签写「（N 种写法）」、悬停可看全部写法。**卡片上显示的仍是原始写法**，不会被改写。
- 侧边栏每个 agent 旁的开关可临时禁用（只停止扫描并隐藏条目，**不删配置**）
- 开关右边常显的 `✕` = 移除该 agent 配置（**同样不动本地日志文件**，鼠标移上去变红）。
  只有「有配置」的 agent 才有这个键；手动添加的入口是 Agent 标题右侧的 `+`
- 鼠标悬停「Token」标签旁的问号可看输入/输出/缓存/合计明细
- **时间范围**：全部时间 / 今天 / 近 7 天 / 近 30 天（按**本地自然日**算，近 7 天 = 今天 + 前 6 天）
- **按会话浏览**（侧栏第 2 项，与「请求日志」并列的**独立视图**）：以 session 为单位看完整的多轮演进，而不是散落的单轮卡片。
  左侧是会话列表（标题 / agent / 项目 / 轮数 / token / 耗时 / 相对时间，可搜索、可换排序），右侧是该会话的汇总与逐轮轨迹；
  **跟随左侧 agent / 项目 / 时间范围筛选**（同一个筛选集，不会出现「侧栏选了项目、会话列表却没跟着收窄」）。
  - 会话级汇总：轮数 / 累计 token（输入·输出·缓存）/ 总耗时 / 起止时间 / 涉及模型。数据来自 `GET /api/sessions` + `/api/session`，
    **服务端算**（页面手里只有最多 5000 条的窗口，客户端分组会漏会话、汇总会偏）。
  - **会话名单取「产品自己起的标题」**（2026-09-23，I14）：`name` 来自各 agent 自带的标题 ——
    claude 系取转录里的 `ai-title`（字段 `aiTitle`，没有则退回 `last-prompt`），dsh / gemini / buddy /
    zcode / traedb / opencode / kilo / hermes / devin / cursor 各有各的源头。都没有时 `name` 为 `null`，
    列表退回显示会话 key（裸 UUID/sessionId）——**不拿文件名冒充标题**。
    claude 系是这次**新接上**的（此前 101 个会话 0% 有名字、全是裸 UUID）；因 `ai-title` 平均落在
    文件 48.8% 处，老会话必须重扫才补得上（`PARSER_REV.claude` 已 7→8）。
  - **子 agent 拓扑（2026-09-28，I16）**：会话列表里，**子 agent 会话**缩进一级并带 `└` 前缀；
    没有子会话的行 token 那一格照旧，**有**子会话的父会话那一格换成「合计 N 轮 · x tok」（含自身，
    鼠标悬浮说明含几个子会话）。右栏顶部多一块「父会话 / 子 agent」：能点着**跳到父**、也能点着**跳到某个子**。
    判据全是源头的**显式谱系外键**（dsh 会话头的 `parentSession` / `delegationDepth`；
    claude 的 `<slug>/<父会话>/subagents/agent-*.jsonl` 目录层级 + `<同名>.meta.json` 的
    `description` / `spawnDepth`；zcode / opencode `/ kilo` 的 `session.parent_id`；hermes 的
    `parent_session_id`），**不按时间区间判父子** —— 那条路已被 2026-09-28 的前置闸证伪（见 `LOGFORMATS.md`
    的「子 agent 谱系」一节）。认不出父的会话**如实当根**（不硬造父节点），源里没这一层的 agent
    不显示任何层级（**不印 0、不画假树**）。
  - **`updated_at` 不再冒充轮时间（I16/D2）**：atomcode 里 `.jsonl` 0 字节、或 `turn_id` 在 jsonl 里
    不存在（打断/回退留下的轮）的轮**拿不到时间戳**，本机实测占 **44.6%**。这类轮现在 `time = 0` +
    `timeUnknown: true`：卡片与会话视图如实标「**时间未知**」，**不参与按天统计**（否则 1970-01-01
    会冒出一个巨桶把横轴拉成 56 年），统计弹层会写明「另有 N 轮时间未知，未计入」。同时 `time` 改成取
    **轮起点**（`started_at`）而不是轮终点（`ts`）—— 后者是 atomcode 独有的取法，会让卡片时间整体偏一个轮长。
    动了落盘口径 ⇒ `PARSER_REV.jsonl` 已 1→2。
  - 点开某一轮：**dsh** 会画出**真实时间轴** —— 每一步的等待（TTFT）、流式解码段、每次工具的真实耗时，
    横轴按真实时间比例（**不给任何段画等宽**）；顶部的会话总览条按同一套比例画段，点击可定位到对应轮次并高亮。
    概览条**不支持滚轮缩放/拖动**（这是既有决策，见 `agent-log-next-steps.md`）。
  - **逐事件时间线目前有 dsh 和 zcode**（dsh 的解析器把逐事件留成一条流：`step` 边界、`stream[]` 流式起止、工具起止；zcode 则由 `model_usage`/`tool_usage` 表的真实起止时间直接生成）。
    ⚠️ 别写成「只有 dsh 的日志带时间戳」—— **claude / codebuddy / gemini 的日志里都有逐行时间戳，而且解析器已经拿它算出了
    每次 LLM 调用的真实耗时**（实测 15/15、5/5、1/1 有非零 `dur`），只是**算完没留成流**。缺的是「留成流」，不是「时间」。
    codex / kimi 才是真的拿不到（逐次 `dur` 恒为 0）。实测见 `agent-log-next-steps.md` §30.9。
    别的 agent 打开会看到一条说明，轮次退回「LLM 调用明细 + 工具调用」两块渲染、时间列显示 `—`，
    **不假装有时间轴**。界面据 `/api/sessions` 的 `hasTimeline` 判断，页面**不硬编码 agent 名单**。
  - 失败/被中断的调用（没有 `stream[]`）画成**细占位条 + `?`**，不编造时长。
  - **逐轮用量图里那根线是两态的**（2026-09-23）：会话里只要有任意一轮拿得到窗口容量（`e.ctx`），线就是**上下文占用率**
    （该轮结束时的占用 ÷ 窗口，0–100 绝对刻度、**顶格＝满窗**）；一根分母都没有（kimi / gemini / workbuddy / zcode 这类）
    才退回**耗时折线**（按本会话峰值归一）。占用率线**按连续有分母的轮分段**，缺分母的那轮断开、不连线，
    不足两个点的一段不画。柱子始终按本会话最大那轮归一，所以图下那行小字会同时说明「柱与线不是同一把尺」；
    分母来自「上下文窗口」查表的（`/api/session` 的 `ctxTbl`，即 claude / kimi）还会写明「表里填错曲线就跟着错」。
  - **压缩红点**落在该轮占用率的高度上，拿不到分母时改画**基线空心点**（只说「这轮压过」，高度不带含义）。
    画法对所有 agent 生效；**claude 与 qoder 两家都会落**这些字段（认的是 `system/compact_boundary` 那行）。
    ⚠️ **2026-09-23 更正**：这里原先写的理由是「claude 转录没有它」—— **该理由不成立**。本机实测
    `~/.claude/projects` 下有 39 条 `compact_boundary`，且 `parsers/claude.mjs` **本来就无条件**
    解析并累计了这些字段；丢掉它们的是 `emitClaudeTurns` 的 `isQoder` 守卫。
    **I12（2026-09-28）已把这个守卫松开**（落盘口径先 bump `PARSER_REV['claude']` 10→11、后因 compDrop
    口径修正再 bump 到 12，老索引失效重扫，老会话的压缩画像补得回来），并顺带落了三个新位：
    `compDrop`（**本轮**丢弃 token）/ `compMs`（本轮压缩等待，`durationMs`）/
    `compAuto` + `compManual`（`trigger` 逐条计数）。逐轮、逐会话、两轮对比三处都有展示。
    ⚠️ **`compDrop` 不是源里那个累计值**：`cumulativeDroppedTokens` 是**会话累计**（每压一次往上叠），
    落盘取相邻事件累计的增量再按轮求和 ⇒ 才是「本轮丢了多少」；直接把累计值逐条相加会把每轮显示成
    「到该轮为止的运行总量」（会话小结再求和约虚高 (k+1)/2 倍）。
    ⚠️ **缺席 ≠ 0**：`compDrop` **只有 claude 源有**这一位，qoder 的 `compactMetadata` 里没有 ⇒
    缺席时落 `undefined`（JSON 自动掉键），页面据「有没有这一位」决定说不说，**绝不补一个 0**
    （否则 qoder 会被读成「压过、却一个 token 都没丢」）。`trigger` 认不出的取值两边都不计。
  - 卡片页脚的 session 链接仍然打开原来的会话时间线弹层（那是「一轮一行」的旧视图，两者并存）。
- **历史归档**（侧栏第 4 项，R28）：浏览 `~/.agent-acta/archive/` 里被冻结的历史条目。
  左侧是 agent → 日期文件的树（带条数与最近归档日），每个 agent 前的箭头单独管**折叠/展开**
  （点整行才是「筛到这个 agent」，顺手展开它 —— 18 个 agent 全展开是 214 行，不给折叠就只能一路滚）；
  **每次打开都回到全展开**（收起只属于本次浏览 —— 弹层内容不随关闭销毁，不显式清就会跨次记忆，
  变成「一打开全都收起」）；
  右侧是该范围的条目列表（可关键词搜索、可翻页），
  点开某条看**归档当时冻下来的**用户输入 / AI 输出 / 工具 / 调用明细 —— 产品把源日志删了也照样打得开。
  **刻意不跟随**左侧的 agent / 项目 / 时间筛选（它读的是归档目录，不是扫描出来的条目），
  是**只读旁路**、不并入主列表。左下的**归档开关**是这个弹层唯一的「写」入口：每个已启用的 agent
  一个开关，写 `config.archive.skip`（见下一节）。加载失败**不清场**：已拉到的树与列表留在原地，错误只占一条横幅带「重试」，
  且网络层失败（服务重启/瞬断）会自动重试一次 —— 整层换成红条会让人以为归档数据没了。
  口径与边界见「历史归档（R28）」一节。
- **磁盘占用**（侧栏第 6 项，R30）：按 agent 列「日志 / 归档 / 合计」谁最大（合计带占比条、列头可点排序），
  下面另列 `index/` 分片与 `~/.agent-acta` 顶层构成。**只统计、不删除**，也不给「一键清理」——
  删日志不可逆（想留历史该走归档）。四件事在页面上都露出来：库根连 `-wal`/`-shm` 一起算、索引片单列不与
  agent 行相加、共用同一目录的两个 agent 打「共用目录」且总数只算一次、遍历超预算时打「统计到一半」。
  口径与预算见「磁盘占用（R30）」一节。
- **用量统计**（工具栏那个折线图标）：按天聚合 token 与耗时，跟随当前的 agent / 项目 / 时间范围
  - 顶部四格 = 输入（不含缓存）/ 输出 / 缓存命中 / 合计，**合计 = 三者之和**（自洽，不会出现「合计 < 输入」）
  - 图上的柱子一天一根（宽度上限 48px，所以「今天」就只有一根柱子，不会拉成整条色块），悬停看当天明细；「输入 + 输出 / 含缓存」可切换 —— 缓存通常占 95% 以上，
    默认这档能直接看出「实打实」的部分；**两档的纵轴各自归一，别跨档比柱高**
  - 下面的表格就是同一份数据（可滚动），也是无障碍上的「表格视图」
  - ⚠ **耗时不是工作时长**：它是各轮「首条记录 → 末条记录」时间差之和，挂机/隔夜的轮会把一整天算爆
    （本机实测有单轮 63 小时）。某天最长单轮超过当天总耗时一半（且当天合计 ≥ 1 小时）时会打 ⚠，那种天别当工作量看
  - **按模型**（同一对话框下半部分）：每个模型一行，条形长度 = 它占合计 token 的**绝对**比例（不是按第一名归一，
    所以「某个模型占七成」直接看得出来），分段仍是输入/输出/缓存；右侧给出合计、占比、条数，悬停看各字段原始值与用到它的 agent
    - 同一个模型被不同 agent 写成两种大小写（`Deepseek-V4-Flash` / `deepseek-v4-flash`）按**小写**并成一行，
      显示名取条目最多的那个写法；**大小写之外一个字都不动** —— 去空格/连字符能并掉 `hy4 preview`/`hy4-preview`，
      但同一条规则也会并掉 `gpt-5.4`/`gpt-54`，宁可少并也不并错
    - 没有模型记录的条目（只剩 `logs.json` 的老 gemini 会话、读不到 Cursor IDE 会话库的 cursor 转录等）单列一行，**不混进任何模型**：
      它们 token 恒为 0，只占条数。这样「各模型 + 无模型 = 合计」永远对得上账
    - 极少数轮次会挂多个模型（本机 20/4718）—— 这些轮的 token 全部归给**第一个**模型，条数在下方说明里写出来（不静默挑一个）
  - 统计**不受右上角「条/页」影响**：算的是当前筛选下的全部条目。所以它显示的条数常大于列表标题那行 —— 那是设计如此
    （不然换个档位数字就变，没法信）。列表标题在范围内条目超过窗口时也会明说「该范围内共 N 条，只显示最近 M 条」
- **导出**（工具栏那个下载图标 → 下拉选 JSON / CSV / Excel；展开某一轮后详情底部另有「导出该轮完整详情」，R11）：
  导的是**列表此刻这份筛选集**（已加载窗口里筛出来的全部，不止屏幕上渲染的那一屏），三种格式都带「按什么条件导出」的
  说明行，能自证这批数是按什么筛出来的。文件由浏览器直接下载，**服务端一个字节都不写**。口径与上限见「导出（R11）」一节。

## 支持的日志格式

支持 agent 与各格式的字段口径、解析边界、踩坑记录（dsh 的 zstd 多帧、cursor 从 `state.vscdb` 取模型名、
atomcode 要开 datalog 才有逐次明细、kimi 三份日志根、trae 的 SQLCipher 库等）完整说明见 **LOGFORMATS.md**。

- **内置**（开箱即读，不需要配置）：`atomcode`（`~/.atomcode/sessions`）、`codebuddy`（**两个根**：CLI 的 `~/.codebuddy/projects` + genie 扩展的 `%LOCALAPPDATA%\CodeBuddyExtension\Data`，后者挂在 `sessionsExtra` 上、每轮重算）、`workbuddy`（`~/.workbuddy/projects`）
- **自动发现**：服务启动与每轮扫描时对 `claude / codex / cursor / trae / qoder / opencode / gemini / copilot / windsurf / codearts / kimi / dsh / zcode / doubao / hermes / devin / minimax / mimocode / kilo / openclaw / cline`
  在 `~/.<name>`、`%APPDATA%\<name>`、Application Support/<name>、`~/.config/<name>` 等位置自动嗅探，命中即注册（`source:auto`），目录消失自动摘除。mimocode 的会话不在 `~/.<name>` 那套约定里，而在 `~/.local/share/mimocode/memory`（`candidateBases('mimocode')` 单独补这条真路径命中），见下面「mimocode」一节。
  注意 **zcode 是例外形态**：它的会话不在目录里，而在 SQLite 库 `~/.zcode/cli/db/db.sqlite`（只读）——所以「ZCode 聊了几轮、这里却扫不到」在 1.8.4 起不再发生
  **opencode 也是例外形态**：会话全在 `~/.local/share/opencode/opencode.db`（**明文** SQLite + WAL，**不需要密钥**），
  按内容认库（`session`/`message`/`part` + `event`/`event_sequence` 五张表齐才算），手工添加填 `opencode.db` 文件或数据根都认——
  注意它与 ZCode 的库都有 `session`/`message`/`part`，服务靠「事件投影两张表」把两者分开，不会互相抢库
  **kilo 也是例外形态，而且是 opencode 的 fork**：KiloCode（Kilo CLI）的会话同样集中在一个**明文** SQLite 库里
  （`~/.local/share/kilo/kilo.db` + `-wal`，不需要密钥），schema 与 opencode 实测**同构**（`session`/`message`/`part` +
  `event`/`event_sequence` 全在），所以**解析层直接复用 opencode 的核心**（`parsers/kilo.mjs` 只是薄壳，口径已用真实样本核对：
  每条 `message.data.tokens` 是**该次调用**的用量，逐条相加 == `session` 表的聚合值）。认领层必须与 opencode **双向互斥**：
  kilo.db 满足 opencode 的全部五张表判据，两家各靠**独有表**分开（kilo：`kilo_board`/`kilo_board_message`），
  且 kilo 在 `sniffBase()` 里排在 opencode **之前** —— 口径见 LOGFORMATS.md 的 kilo 一节
  **trae 同样是例外形态**：优先读它的 SQLCipher 库 `%APPDATA%\Trae CN\ModularData\ai-agent\database.db`（完整会话记录，**要配 `traeKey`**），
  读不了时自动回退 `renderer.log` 骨架——密钥从哪来见下面「Trae 的 SQLCipher 库」一节
  **Copilot 也有独立落盘格式**：`~/.copilot/ide/*.lock` 只是 VS Code/MCP 通信锁；真正的会话正文在 `~/.copilot/session-state/<sessionId>/events.jsonl`，同根 `session-store.db` 的 `assistant_usage_events` 补 token、耗时与模型用量。服务会自动识别 `copilot`；用量库暂时不可读时仍保留正文卡片。
  **doubao 也是例外形态**：Windows 上会话不在 `~/.doubaowork`（那条约定不存在），而在 `%LOCALAPPDATA%\DoubaoWork\User Data\Default\.doubaowork\agent_mode\workspace\.sessions\<会话 id>\agents\<agent id>\system\trajectory.jsonl`；
  自动发现走这条真路径，手工填 `DoubaoWork 应用根 / User Data / Default / .doubaowork / agent_mode / workspace` 任意一层都认（沿已知目录名下探 + 首行 role 字段内容判据双保险）；转录里没有时间戳与 token/模型，时间取自同目录 `assignment.md`，见 LOGFORMATS.md 的 doubao 一节。
  **hermes 也是例外形态**：会话全在 SQLite 库 `state.db`（Win=`%LOCALAPPDATA%\hermes`、mac/Linux=`~/.hermes`，`HERMES_HOME` 指到哪认到哪，只读打开），
  按页头 + `sessions`/`messages`/`session_model_usage` 三张表验明正身；但它**没有逐轮 token**（DB 只有会话聚合），
  真实用量从同目录 `logs/agent.log` 的 `API call #N` 行按轮窗口配对 —— 日志滚掉时该轮退回 0 token，口径见 LOGFORMATS.md 的 hermes 一节。
  **devin 也是例外形态**：会话全在 SQLite 库 `sessions.db`（Win=`%APPDATA%\Devin\cli`、mac/Linux=`~/.local/share/devin/cli`，只读打开，**明文、不需要密钥**），
  按页头 + `sessions`/`message_nodes`/`tool_call_state` 三张**独有表**验明正身（`sessions` 这个名字与 hermes/zcode/opencode 重名，单靠它不算数）；
  消息是 `node_id`/`parent_node_id` 连成的**森林**，只沿 `main_chain_id` 回溯主线（本机实测 261 个节点里 164 个在主线，其余是重新生成留下的旁支）；
  逐次 token/耗时/工具出入参**全在库里**（`assistant.metadata.metrics`），口径见 LOGFORMATS.md 的 devin 一节。
   **minimax 也是例外形态**：会话在 `~/.minimax/v2/sessions/YYYY/MM/DD/<…-session_<id>>/messages.jsonl`（`v2/sessions` 要下探四层才到会话目录），
   usage/model/stopReason 全在消息行的 `message` 里；token 口径是 `tin = input` 直接取（input 不含 cache），ctx 分母取同目录 `llm-call.json` 的 `maxTokens`，见 LOGFORMATS.md 的 minimax 一节。
   **mimocode 也是例外形态**：它落盘的是 **SQLite 库**（`~/.local/share/mimocode/mimocode.db`，Drizzle ORM 之上），`memory/` 下那些 `checkpoint.md`/`notes.md`/`MEMORY.md` 只是库导出的展示层（本机实测 `task` 表为空、任务只活在 markdown）。
   解析器**以 mimocode.db 为权威源**：**一条 user `message` 开一轮**，其后所有 assistant `message` 并入该轮 → 映射成 AgentActa 一条 entry（⚠️ 别退回「一条 message 一条 entry」：mimocode 的 agent 循环是「想一步→调工具→看结果→再想一步」，一次提问会落十几到几十条 assistant message —— 本机实测一句「hello，我能去哪找你的应用图标的svg」落了 19 条 assistant / 20 次工具调用，逐条灌 entry 就是一张卡变 20 张，与 claude/opencode 的轮语义也对不上）。`rounds=calls=`轮内 LLM 调用数、`tools=`轮内 tool 碎片数；token 逐次累加（`tin=Σtokens.input` / `tout=Σ(tokens.output+reasoning)`，推理 token 属输出侧 / `tcache=Σcache.read+write`）；模型进 `models[]`（⚠️ **assistant 的模型在顶层 `modelID`/`providerID`**，`user` 才是 `model.{providerID,modelID}` —— 两者位置不同，只读后者会让助手侧模型全空）、`part` 里的 tool 碎片进 `tools[]/calls[]`（`state.status==='error'` 的 → 轮 `status='error'`）、`time` 用轮内最早 `message.data.time.created` **原样毫秒**（全项目统一 13 位毫秒，**不要除以 1000**，否则条目全落到 1970）、`dur` 取「轮内最晚 completed − 最早 created」的**毫秒**（与 claude/opencode 同口径，页面 `fmtDur` 按毫秒读）。详情里的「用户输入」会**剥掉 `<system-reminder>` 注入块**（库会把运行上下文当 text 碎片塞进 user message，本机实测一个 2014 字的注入块里真用户输入只有 21 字，不剥则预览与搜索全废）。库读不动时回退 markdown 层（token/工具恒 0，详情 `note` 说明）。整份重解析 + 库 `{mtime,size}`（含 `-wal`）签名跳过，不进 `OFF_KINDS`；但**登记 `PARSER_REV.mimocode`** —— 它不管 index 落盘（本 kind 不落），管的是 `~/.agent-acta/search/` 分片的作废（轮口径变了必须 bump，否则老分片按旧 `turn` 下标返回错轮正文且不会自愈），见 LOGFORMATS.md 的 mimocode 一节。
   ⚠️ **嗅探判据必须与 opencode 互斥**：mimocode.db 与 opencode.db 是**同源 schema**（都源自 session/message/part + event/event_sequence），opencode 原本的判据（那五张表）在 mimocode.db 上**全为真** —— 不挡就会把 mimocode 的库接走，mimocode 恒 0 条且静默。两家各靠**独有表**互斥（mimocode：`history_fts_idx`/`actor_registry` 等；opencode：`session_message`/`session_input` 等），见 `discovery.mjs` 的 `MIMOCODE_ONLY_TABLES`。
   另：`mimocode` 的 `sessions` 就是**应用根本身**（不是「根下的某层」），重新嗅探时不能对它取 `dirname` —— 曾因此爬到 `~/.local/share`、被 opencode 的相对候选 `share/opencode/opencode.db` 抢走并把 kind 改写，且因 `dirTaken` 对称判据**永不自愈**（详见 `agent-acta-server.mjs` 的 `ROOT_SESSIONS_AGENTS` 与 `ownConfFor`）。
   **openclaw 也是例外形态**：会话不在 `~/.<name>` 顶层，而在 `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl`（`stateDir` 默认 `~/.openclaw`、老版本 `.clawdbot`，`OPENCLAW_STATE_DIR`/`OPENCLAW_HOME` 可整体改写）。
   判据 = **首行**是会话头（`type:"session"` + `version` + `id`，只读头 2KB），并硬排同样以 `.jsonl` 结尾的 `<id>.trajectory.jsonl`（运行轨迹，不是会话树）；`sessions` 填 `stateDir` 本身（转录在它下面的 `agents/<id>/sessions/`），手工填 `stateDir / agents / agents/<id> / agents/<id>/sessions` 任意一层都认。⚠️ `agent/models.json` 里带 `apiKey`，解析器只取 `id` 与 `contextWindow`，绝不外带。口径见 LOGFORMATS.md 的 openclaw 一节。
   **cline 也是例外形态**（Cline CLI 3.x）：会话在 `<data>/sessions/<会话 id>/<会话 id>.messages.json`，data 根默认 `~/.cline/data`（`CLINE_DATA_DIR` / `CLINE_SESSION_DATA_DIR` 可整体改写）。它是**整份 JSON 文档、每次落盘整体重写**（不是 JSONL）⇒ 没有 off 可续读，按 `{mtime,size}`（含清单）签名整份重解析，**不进 `OFF_KINDS`**，`PARSER_REV.cline` 只管搜索分片作废。两条最容易被照抄写错的口径：① ⚠️ **`tool_result` 也是 `role:"user"`**，只看 role 切轮会把本机 8 轮的会话切成 23 轮 —— 开轮要「role=user **且** content 有非空 text 块」，正文还得剥掉 `<user_input mode="act">` / `<mode_notice>` 壳；② ⚠️ **`metrics.inputTokens` 含缓存**（cacheRead/Write 是它的子集，OpenAI 语义，与 openclaw/minimax 相反、与 hermes 同侧）⇒ `tin = input − cacheRead − cacheWrite`、`ctxUsed` 取轮内末次 `input`；`/compact` 之后它会**回落**（43662→19526），不是累计值。`ctx` 恒 0（模型目录只嵌在 144MB 的 `cline.exe` 里，盘上没有）。逐轮无状态/耗时/成本，唯一失败信号是 `tool_result.content[]` **逐项**的 `success===false`/`error`（批量调用可只错一项）。`<id>.compaction.json` 与 `sessions.db` 都不读（压缩是纯投影、不改全量日志）；⚠️ `data/settings/providers.json` 是**明文 apiKey**，一个字节都不许读。口径见 LOGFORMATS.md 的 cline 一节。
- **手动添加**：侧栏 Agent 标题右侧 `+`，填名字（留空路径自动探测）或直接指定 `sessions` / `projects` / `traces` 目录
- 目录在但格式没认出来 → 用 `GET /api/diagnose`（侧栏「环境诊断」）逐条看原因

## Trae 的 SQLCipher 库

Trae CN 把 AI 会话的完整记录写在 `%APPDATA%\Trae CN\ModularData\ai-agent\database.db`，这是**真 SQLCipher 加密库**
（SQLCipher 4.5.7，AES-256；口径见 `LOGFORMATS.md` 的 traedb 一节）。AgentActa 读它需要配置里给一把钥匙（`traeKey`），
这一节讲清：为什么这把钥匙必须手动搞到、怎么搞。

**为什么不能自动**：这把钥匙是**整机安装级**的（本机实测：`ai-agent` 与 `ai-chat` 两个库、跨 2025-08 → 2026-09
是同一把），只存在于 **Trae 运行时的进程内存**里——磁盘上任何文件都不落（数据目录 2953 个文件 × 6 种编码全扫，
0 命中），也不是 machineid / 机器码派生出来的（769 组派生组合试过，0 命中）。它是 32 字节**随机** key（不是口令），
**没有口令材料可爆破，也不能从库文件反推**——拿到它的唯一办法是从 Trae 进程内存里取。

**怎么拿（每台机器做一次）**：包里带了 `tools/grab-trae-key.ps1`，在 Trae 开着的情况下运行：

```bash
powershell -ExecutionPolicy Bypass -File tools/grab-trae-key.ps1
```

1. 脚本先以普通权限把 Trae 的所有进程扫一遍（约 20 秒）；
2. Trae 的关键宿主进程带反调试组件、对普通权限进程拒绝内存读取（实测 `OpenProcess(VM_READ)` 报 err=5），
   扫不到会自动**以管理员身份重来**（弹一次 UAC）；
3. 扫描期间建议在 Trae 里**随便发一条 AI 消息**（或重启 Trae），触发它打开数据库——只要它开过一次库，
   `PRAGMA key = "x'…'"` 的整条字符串会在进程堆里驻留数小时（实测），内存扫描直接可捞；
4. 抓到后脚本会把 key 打印出来并**复制到剪贴板**。

**填进配置**：`~/.agent-acta/config.json` 的 trae 条目补一个字段（示例路径按需改名）：

```json
"trae": {
  "kind": "traedb",
  "sessions": "C:\\Users\\<你>\\AppData\\Roaming\\Trae CN\\ModularData\\ai-agent\\database.db",
  "traeKey": "<64 位十六进制>",
  "source": "auto"
}
```

不想提权、或暂时不配也不影响用：AgentActa 自动回退读 `renderer.log`（轮次 / 用户输入 / 工具 / 状态 / 轮级耗时都在，
**但没有 token、没有 AI 正文、没有逐次调用明细**），诊断页会写「SQLCipher 库认出来了，但读不出来」并指到本节。填对后下一轮扫描自动换成完整数据。

> key 是**每台机器各自一把**：分发给同事时，每人都要在自己机器上跑一次上面的脚本——
> 别人机器上的 key 解不开你的库，反之亦然。同机抓到一次即可长期使用；将来若 Trae 升级换代
> 导致诊断页变回「密钥不对」，重跑一次脚本即可。

## 服务端 HTTP API

```
GET  /                     页面
GET  /widget               桌面小卡片页：今日/累计 token 汇总 + 最新卡片流（SSE 实时刷新）。
                           桌面挂件用法：msedge --app=http://127.0.0.1:14570/widget
                           再用 PowerToys Always On Top（Win+Ctrl+T）置顶即成桌面卡片。
                           注意：卡片开着 = 有 SSE 连接，空闲自停不会触发（这正是挂件想要的行为）
GET  /vendor/<file>        静态资源（本地化，无 CDN）；品牌图标在 /vendor/svg/ 下，支持一层以上子目录
GET  /api/ping             存活探测
GET  /api/agents           列出 agent 配置
GET  /api/diagnose         环境诊断：每个候选 agent 每条候选路径的探测结果与未识别原因
GET  /api/usage?force=1    磁盘占用（R30，见下面「磁盘占用」一节）。一次遍历三处：agent 的日志根、
                           index/ 分片、archive/ 清单。返回
                           {at, cached, dataDir, port, partial, budget{maxFiles,maxMs,visited},
                            agents[{agent,kind,enabled,roots[],logBytes,logFiles,partial,sharedBy,
                                    archiveBytes,archiveDays,archiveCount,totalBytes,entries}],
                            indexShards[{kind,bytes,rev,persisted}], archive{root,agents,days,count,bytes},
                            dataItems[{name,dir,bytes,files,partial,link}],
                            totals{logBytes,logBytesRows,archiveBytes,indexBytes,dataBytes,agents,logFiles}}
                           结果缓存 60s（?force=1 绕开）；archiveCount=-1 表示 manifest 没记这条日期文件
                           （手工拷进来的），条数未知、页面显示 ?；sharedBy 非空 = 该 agent 与另一个 agent
                           指向同一份目录，行内各报各的、totals.logBytes 只算一次
GET  /api/selftest         上一次回归自检的结果（R32，见下面「解析器自检」一节）。**只读 ~/.agent-acta/selftest.json**，
                           服务端不跑任何测试。没跑过/读不动都返 200 + {ok:false, error, hint:"node test/selftest.mjs"}；
                           有结果则原样透传 runner 写的字段（v, at, durationMs, self{version,build,parserRev},
                           env{node,platform}, groups[{id,label,def,note}], rows[{file,title,group,status,ms,code,
                           tail,reds[],note}], skipped[{file,title,group,why}], summary{total,pass,fail,timeout,error}）
                           并添三个服务端算的标注：file（结果文件绝对路径）、ageMs（at 读不出时退到文件修改时间）、
                           sameBuild / sameParserRev（结果出自哪版代码 vs 当前服务是哪版；不一致页面顶栏黄条）
POST /api/agents           {name, path?} 添加
                           ⚠️ 路径解析出的根若与**任一已有 agent 的根重叠**（相等 / 在其内 / 包住它），
                           返回 400 与 `{ok:false, ownedBy:"<那个 agent>", kind, sessions, error}` ——
                           同一批文件被两条 agent 扫不会多出一份数据，只会因条目 id 不含 agent 名而互相抢归属。
                           详见 LOGFORMATS.md「手动添加」一节
DELETE /api/agents?name=   移除该 agent（任何 agent 都可移除，只删配置不动本地日志；v2 配置不会把它再加回来）
POST /api/agents/toggle    {name, enabled} 启用/禁用
GET  /api/cursor-hook      cursor 逐轮 token 采集 hook 的状态
                           {ok, injected, script, file, log, command, error?}
                           · injected = ~/.cursor/hooks.json 的 stop 里是否已有我们那条命令；
                           · script = 随包的 hooks/cursor-usage-hook.mjs 在不在（不在则注入必然失败）；
                           · file = hooks.json 的绝对路径，log = 侧车日志 ~/.agent-acta/cursor-usage.jsonl 路径
POST /api/cursor-hook      {action:'install'|'uninstall'} 注入 / 卸载（侧栏 cursor 行那个图标按钮打的）
                           · **合并，不覆盖**：只往 hooks.stop 里加/删我们那一条，用户自己的钩子与
                             其它事件（beforeSubmitPrompt 等）原样保留；
                           · 幂等：已注入再 install 回 {ok:true, already:true}，不会重复追加；
                           · hooks.json **不是合法 JSON 时拒绝改动**（回 ok:false + error，文件一个字节不动）——
                             宁可让人手工修，也不「重置成默认」把用户自己的钩子静默删掉；
                           · 卸载只摘我们那条，**不删已采集的 cursor-usage.jsonl**（历史数据留着）
                           口径（为什么只有这条路能拿到 cursor 的 token）见 LOGFORMATS.md 的 cursor 一节
GET  /api/snapshot?limit   快照 {seq,total,shown,rangeTotal,scanMs,agents{名字:条数},projects{名字:条数},entries[]}
                           ?scan=1 先扫一轮再返回；?agent=名字 / ?project=归一化key / ?range=today|7d|30d
                           把「最近 limit 条」收窄到该 agent / 该项目的所有写法 / 该时间范围的内部（可叠加）
                           （agents/projects 计数仍是全量，不随窗口缩水；project 的 key 见服务端 SHARED_JS
                             的 projNorm —— R12 起它是唯一实现，GET / 时注入页面，页面无本地副本；
                             rangeTotal = 过滤后（切窗口前）的条数，可能大于 entries.length）
                           注：range 传的是**符号**不是时间戳，边界由服务端每次请求现算 ——
                           标签页挂过午夜后「今天」跟着走，页面显示的范围与服务端过滤的范围永远一致
GET  /api/daily            按自然日聚合 {label, from, to, daysCapped, days[{day,count,tin,tout,tcache,
                           total,dur,maxDur,calls,tools,agents{}}], totals{}}
                           参数同 snapshot 的 ?agent= / ?project= / ?range=（同样可叠加），
                           但**不吃 limit**：算的是整个筛选集 —— 聚合口径不能跟着「条/页」档位变。
                           没有日志的自然日补 0（柱状图 x 轴必须连续）；
                           total 一律现算 = tin+tout+tcache（保证四个数自洽）；
                           totals.maxDur 是「这些天里最长的那一轮」，不是求和
GET  /api/models           按模型聚合 {models[{key,label,names[],count,tin,tout,tcache,total,dur,
                           calls,tools,credits,agents{}}], totals{}, noModel, noModelTotal, multi}
                           参数与 /api/daily 完全一致（同样可叠加、同样不吃 limit），排序按合计 token 降序。
                           key = 模型名小写（归一只有小写这一步），label = 组内最多的写法，names = 全部写法；
                           Σ(models.count) + noModel == totals.count，Σ(models.total) == totals.total，
                           且 totals 与 /api/daily 的 totals 逐字段相等（同一屏里两个「共 N 条」不能对不上）
GET  /api/entry?id=&full=1 详情（full=1 返回未截断内容）
                           **dsh 的返回里多一个 events[]**：本轮按真实时间顺序的事件流
                           [{k:'user'|'sys'|'step'|'llm'|'call'|'result'|'end', t, …}]。
                           · llm 段把一次调用拆成 ttft（排队 + prefill 等待）与 dur（流式解码），
                             两者都取自 dsh 原生的 stream[] 时间戳；
                           · call / result 的 i 是**指向同响应里 tools[] 的下标**，不是正文副本
                             （否则内存翻倍，且 full=1 时会出现「事件里截断、tools 里完整」两份真相）；
                           · result.dur = 该次工具的真实耗时；sys 只记 len 不记正文（系统提示不入内存）。
                           失败调用（assistant/attempt）常常没有 stream[]，ttft/dur 都是 0 —— 页面画占位。
                           **非 dsh 没有 events 字段**，页面必须 v-if 兜底。
                           口径与验收见 AGENTLOG-HISTORY.md §30（原 agent-log-r6-trajectory-task.md 已并入归档）
GET  /api/session?key=&agent=&project=
                           单个会话的聚合 + 正序轮次。**实测返回字段**（别按直觉猜，这里踩过一次）：
                           {ok, session, name?, count, tin, tout, tcache, dur, calls, tools,
                            agents{}, projects{}, from, to, models[], entries[]}
                           · session = 回显的会话键；agents / projects 是**计数表**（{名字: 条数}）；
                           · **`name`（2026-09-23，I14 加）= 会话名**（同 /api/sessions 的那一档，
                             任一轮有标题即可，都没有则**整个键不出现**）；页面标题走
                             `sessPick.name || sessCur.name || sessCur.session`，所以不带 sessPick
                             直接按 key 打开也不会退回裸 UUID；
                           · **calls / tools 在这里是数字**（会话内合计），跟 /api/entry 里的同名
                             字段（那是**数组**）不是一个东西 —— 同一个名字两种类型，写代码时注意；
                           · **没有 `total`**（只有 tin/tout/tcache 三项，要合计得自己加），
                             也**没有 `hasTimeline`**（那是 /api/sessions 才有）；
                              **但 I16 起有顶层 `agent` / `project` / `projectKey`** ——
                              页面从「父会话 / 子 agent」那两条链接跳转时要靠它们（session 值跨 agent、
                              跨项目都不唯一，只按 key 打开会跳错人）；
                           · **I16 子 agent 拓扑（2026-09-28）**：`parent`（父会话 id）/ `depth` / `sub` /
                              `subMode` + `children[]`（这个会话下面挂的子 agent 会话清单，每行
                              `{key,name,sub,subMode,turns,total,dur,status,from,to,childCount,subKids,subTurns,subTotal,subDur}`）
                              + `subTurns` / `subTotal` / `subDur`（**含自身**的子树合计）。
                              判据与 /api/sessions 的树**同一份**（显式谱系外键 + 同 agent + 同归一化项目）；
                              父会话不在当前筛选集里时 `children` **如实为空数组**，不编；
                           · `to` = **最后一轮的起点**（= max(轮.time)），不是会话结束时间 ——
                             所以 `to - from` ≠ `dur`（dur 是各轮耗时之和）；
                           · entries 按时间**正序**，元素 {id,time,dur,status,preview,agent,project,
                             tin,tout,tcache,total,models,calls,tools}，**没有轮号字段**，轮号用下标。
                             ⚠️ **cursor 的老版会话例外**：整段会话共用文件 mtime、所有轮 `time` 并列，
                             而解析器是**倒序插入**的（见 `emitCursorTurns` 的注释），稳定排序下
                             `entries[0]` 是**最后一轮** —— 这时下标**不是**轮号，要轮号得从 `id`
                             末尾的 `#<ord>` 取（回归 `test/cursor-hook-test.mjs` 就是这么取的）。
                             另有一批**按需透传**的键（没有就是 undefined、序列化时直接掉，别当必然存在）：
                             `ctx`（窗口容量）/ `ctxUsed`（该轮结束时的占用）/ `ctxTbl`（这个 `ctx` 来自
                             「上下文窗口」查表而非日志，逐轮现算自 `srcs.kind`，不落盘）/ `compacts` +
                             `compPre` + `compPost`（压缩次数 / 压缩前 / 压缩后 token，**claude 与 qoder 两家**都落，
                             见上方「压缩红点」段）/ `compDrop` + `compMs`（**本轮**丢弃 token / 本轮压缩等待时长 ——
                             compDrop 由源里**会话累计** `cumulativeDroppedTokens` 取相邻增量得到，
                             **只有 claude 源有 `compDrop`**，qoder 缺席即 undefined）/ `compAuto` + `compManual`
                             （`trigger` 逐条计数的自动 / 手动压缩次数）/ `credits` + `ctxRatio`（qoder 专属，
                             页面据此决定逐轮用量图画积分还是画 token）。
                           agent / project 是**可选**收窄参数：都不传 = 只按 session 匹配（老行为，
                           页面的会话时间线弹层走的就是它）；传了才能精确命中重名的 session。
                           ⚠️ session 值跨 agent、跨 project 都**不保证唯一**（claude/buddy 用文件名、
                           codex/dsh/kimi/gemini/cursor 用 sessionId、atomcode 用 .meta 里的标题），
                           所以传 project 时要传**归一化后的 key**（projNorm / projKey，与页面项目下拉同口径）。
GET  /api/sessions?agent=&project=&range=&from=&to=&limit=
                           **会话列表 + 会话级汇总**（页面「按会话浏览」用的就是它）
                           {ok,range,count,capped,sessions[{key,agent,project,projectKey,name,turns,
                           tin,tout,tcache,total,dur,calls,tools,from,to,status,models[],hasTimeline,
                           parent?,parentKey?,children[]?,depth?,sub?,subMode?,timeUnknown?,
                           subTurns,subTotal,subDur,subKids,subSelf}]}
                           · name = 会话名（各 agent 自带的标题，如 claude 系的 ai-title；都没有则 null，
                             页面退回显示 key）—— 见页面上方「按会话浏览」那条的说明；
                           · 参数与 /api/daily 完全一致（可叠加），同样**不吃「条/页」窗口** ——
                             会话级汇总必须覆盖整个筛选集，否则会和逐轮累加对不上账；
                           · 聚合键 = **agent + projKey(project) + session**。三者缺一都不行：
                             只用 session 会把不同 agent、乃至同一 agent 下不同项目的同名会话并成一个
                             （atomcode 的 session 取的是标题，本机实测会重名），
                             不过 projKey 会把 F:\x / f:\x / cursor 的 slug 误拆成三行；
                           · 排序按 to 降序（最近活跃在前）；limit 默认 200、上限 2000，超了给 capped:1；
                           · hasTimeline = 该会话的轮次有没有逐事件时间线，**目前 dsh / zcode / traedb 为 true**。
                             页面据它决定画时间轴还是走「无逐事件时间」的兜底渲染 ——
                             这样页面**不需要硬编码 agent 名单**，将来别的 agent 补上 events 也自动生效。
                           · **I16 子 agent 拓扑（2026-09-28）**：`parent`（父会话 id）/ `depth` / `sub`
                             （子 agent 的派活描述）来自解析器落的**显式谱系外键**（dsh 会话头 parentSession、
                             claude 的 `subagents/` 目录层级 + `.meta.json`、zcode/opencode 的
                             `session.parent_id`、hermes 的 `parent_session_id`）。聚合侧按
                             `agent + projKey + parent→key` 上卷：
                             `parentKey` = 父会话在**本次返回的列表里**的 key（认不出父时**缺席**，
                             这时该会话如实当根用，不硬造一个不存在的父节点）；
                             `children[]` = 直接子会话（每行 `{key,name,sub,subMode,turns,total,dur,status,from,to,subKids}`）；
                             `subTurns / subTotal / subDur / subTin / subTout / subTcache / subCalls / subTools`
                             = **含自身**的子树合计（回答「这一坨一共花了多少」）；
                             `subKids` = 后代子会话数（不含自己）；`subSelf` = true 表示没有子会话
                             （页面据此不显示「合计」那一列，免得每行都挂一个和本体相同的数）。
                             ⚠️ **不按时间区间判父子** —— 那条路已被 2026-09-28 的前置闸证伪
                             （atomcode 那 11047 对区间嵌套是「time 取轮终点 + 时间未知回落 updated_at」
                             两处缺陷叠出来的噪声，修正后嵌套 = 0）。源里没有谱系字段的 agent 一律不带这些键。
                           · **`timeUnknown`** = 这一轮**拿不到时间戳**（atomcode 的 `.jsonl` 0 字节，或
                             `turn_id` 在 jsonl 里不存在）。这类轮 `time = 0` 且带 `timeUnknown: true`，
                             **不回落会话 `updated_at`**（那会让同会话几十轮塌成同一时刻）；它们
                             **不参与按天统计**（否则 1970-01-01 会冒出一个巨桶把横轴拉成 56 年），
                             页面在卡片与会话视图里如实标「时间未知」。
GET  /api/events           SSE：hello / update / remove / agents / settings / resync / scanning + 每 25s 心跳
                           hello 里带 scanning:{done,total,agent}（连上来时首扫还没跑完才有，否则为 null）
                           scanning {phase:'start'|'progress'|'done',done,total,agent}：首扫进度，
                           只推给已连接的 SSE 客户端、不进 dirty（漏了不影响正确性，hello 会补当前状态）
GET  /api/settings         当前设置 {scanMs, choices, idleExitMs, idleChoices}
POST /api/settings         {scanMs} 调整扫描节奏（0/1000/2000/3000/5000/10000，0=不实时更新；落盘并广播）
                           {idleExitMs} 调整空闲自停（0/1800000/7200000/21600000）
GET  /api/alert            异常巡检规则与命中 {ok, rules, summary, hits[]}
                            rules = {tokens:{on,val}, durMs:{on,val}, fail:{on,val,window}}（顶层三规则，
                            保存于 config.alert，随 scanMs 同套机制持久化，重启服务仍在；全关 = 绝不打扰）
                            summary = {count, agents[{agent,count,rules}]} —— count 是侧栏徽章数 / 「只看异常」条目数
                            hits = 命中的完整条目 [{id, agent, rules[], time, dur, total, status, preview, project}]，
                            按 time 降序（弹层点击行 -> 前端用 id 调 locateEntry 定位回主列表）
POST /api/alert            {rules:{tokens,durMs,fail}} 整组替换规则（白名单校验，坏值回落默认），
                            落盘 config.alert 并立刻重算命中 + 广播 alert 事件 → 徽章 / 只看异常即时刷新。
                            返回 {ok, rules, summary}（不含 hit 明细，前端保存后另拉 GET 取列表）
                            规则语义：tokens = 单轮 total（输入+输出+缓存）超阈值；durMs = 单轮耗时
                            （轮内首条→末条时间差，含挂机/隔夜）超阈值；fail = 某 agent **最近 N 轮**
                            （fail.window，最多 100）中失败占比（status != ok，1..100%）超阈值，命中该 agent 里构成失败的那几轮。
                            GET 在 alertDirty 时先就地重算；扫描 / 规则改动 / 归档都会触发 recomputeAlerts。
GET  /api/ctxwindows       上下文窗口表 {windows:[{name,value,builtin,user,off}], unknown:[{model,n}]}
                           这张表只服务于 claude 卡片的进度条**分母**：别的 agent 自带窗口字段，
                           claude 的转录里没有（请求体不落盘），只能按模型名查表。
                           unknown = 日志里出现过、表里查不到的模型，页面据此列「待填」。
POST /api/ctxwindows       {windows:[{name,value}]} **整表替换**用户条目；value<=0 = 停用该条
                           （内置默认也能这样关掉）；与内置默认同值的条目不落盘。
                           保存后就地重算已有条目的 ctx 并广播，无需重扫/重启。
POST /api/shutdown         优雅关闭（落盘索引后退出；--stop 用的就是它，同源校验）
GET  /api/version          {version, build, pid}；build = 服务脚本内容的 SHA1 前 12 位。
                           --ensure 用它判断「端口上跑的是不是我这版」，页面用它判断「我这张页面配不配得上服务」。
                           刻意**不走 whenReady**：首扫阻塞事件循环时，ensure 恰恰要尽快拿到答案
GET  /api/archive/index    归档清单 {root, days[{agent,day,count,bytes}], agents[{agent,days,count,bytes,lastDay,unknown?}],
                           totals{agents,days,count,bytes}, skip[], configAgents[]}
                           skip = `config.archive.skip` 的原样回显；configAgents = **已启用**的 agent 名
                           （开关列表要用它管到「还没有任何归档」的 agent —— 那些在清单里是查不到的）
                           清单每次读盘都与目录 readdir 对账：手工删掉的日期文件会消失，
                           目录里多出来的未知文件以 count=-1（页面显示「?」）出现，不会被静默吞掉
POST /api/archive/skip     改 `config.archive.skip`：body {agent, skip:true|false} → {ok, skip[]}。
                           即改即落盘、立刻影响下一轮归档（不用重启，与 --archive 共用同一份配置）。
                           agent 必须是**已配置**的，否则 400（拼错的名字不能进 config）。
                           只停未来的归档，绝不删已冻好的文件。
GET  /api/archive/entries  归档条目列表 {list[], total, scanned, offset, limit}
                           ?agent= / ?day= 至少给一个（页面点树给）；?q= 关键词对
                           preview/user/assistant/session/models/工具名 做**包含**匹配（与主列表同口径，不分词不正则）；
                           ?limit 默认 200（夹在 1..2000）/ ?offset 翻页。
                           **list 里的条目不含 detail**，只有 hasDetail 标记 —— 详情要单条去取，
                           否则「全部 agent」一页 200 条会把几百 KB 正文一起塞进响应。
                           注：total 是**扫完所有匹配的日期文件**才得出的，所以不传 ?day= 时耗时随归档总量线性增长
                           （本机 195 个文件 / 5022 条实测 ~0.6s）
GET  /api/archive/entry    单条冻结的详情快照 {entry}；agent/day/id 任一查不到 → 404 {ok:false,error:"not found"}
                           返回的是**归档当时冻下来的那份**，与源日志在不在无关 —— 这正是归档的意义
```

## 历史归档（R28）

**解决的问题**：有些 agent 自己会删历史（CodeArts 只留约 30 天 `User/logs`，本机历史月已出现空档）。
日志没了，页面上的统计和详情就永久缺一块 —— 这是**不可逆**的，只能靠提前冻一份来对抗。

**冻什么（条目级，不是压原文）**：每个「已结束、且发生在今天 0 点之前」的条目落一条 JSONL 记录：

- 统计字段逐个显式列出（agent/project/session/time/day/dur/status/tin/tout/tcache/total/ctx/rounds/tools/calls/
  models/preview/finished/aborted/toolNames/rev/kind）—— 不用 `{...e}` 整对象摊开，
  免得将来 entry 里多出内部字段被悄悄冻进去、以后想删都删不掉；
- **详情快照**：归档那一刻走一遍实时详情那条路（`entryContent`），把用户输入 / AI 输出 /
  工具 / 逐次调用 / 事件一起冻下来 —— 原文没了也照样打得开。
  截断口径与非 full 的页面一致（正文 800 字），且每类**最多 40 项**，被砍掉的只记个数（`detailMore`），
  页面明说「另有 N 项未入库」而不是假装完整；
- `rev` = 归档时该 kind 的 `PARSER_REV`。**归档不随口径升级重放**（源文件可能已被产品删了），
  这个字段只用来在页面上标「这份是什么口径冻的」，不是重算的依据。

**为什么不做「按天压日志」**：压原文要靠各 agent 的解析器事后重读，而详情本来就是懒加载的 ——
真按天压，冻下来的只是一坨无法自证的原始文本，还得信任「以后解析器认得出它」。
条目级冻结换来两件事：① 详情与统计一起冻，源文件删了也能看；② **天然幂等**（见下）。

**幂等靠「合并不重建」**：每次归档都**读回当天的日期文件、按 id 合并增量**，绝不拿内存里的 `entries` 重建整天文件。
这条是硬约束 —— 内存里的条目是 LRU 上限 20000 的，第 20001 条会把最老的挤掉；
真按内存重建，昨天已归档的历史会在某天被静默抹掉一大截，而且**看起来一切正常**。
副作用是「已经冻过且当时取到了详情」的条目直接跳过（`已是最新`），所以复跑很快：
本机 5022 条首跑 1m22s，复跑 3.7s / 写入 0 个文件。

**什么时候跑**：

- **服务内每日自动**：服务跑着的时候每 3 小时检查一次，跨过 0 点后跑一轮（`AGENT_LOG_ARCHIVE_DELAY_MS`
  可覆盖首次延迟，测试用）；单轮最多 4000 条（`maxPerRun`），剩下的下一轮继续。
  关掉：`config.archive.enabled = false` —— **只影响自动轮，`agentacta --archive` 手动跑不受影响**。
- **`agentacta --archive [--list] [--dry]`**：手动补跑/排查，不启 HTTP、不占端口。
  ⚠️ 手动跑完会直接退出，**不落盘索引**（索引本来就有 5s 延迟写盘的定时器，进程先退了），
  所以它跟「重启后再看」是两件事——这符合预期（归档读的是内存里已扫出来的条目，不动索引）。

**按 agent 关掉归档**（`config.archive.skip = ["cursor", "trae"]`）：有的 agent 日志本来就不值得留
（量小 / 没正文 / 临时跑跑），逐个关比整机关自动轮实用。语义钉死两条：**只停未来的归档**，
已经冻好的日期文件**一个字都不动** —— 它是省磁盘的开关，不是删数据的入口（要清已有归档用 `maxDays`/`maxMB`，
或者自己去归档目录删）。
**页面上就能开关**：`config.archive.skip` 是唯一一个「手改 config 不如点一下」的配置 —— 服务端加了
`POST /api/archive/skip`（`{agent, skip}`，写入即 `saveConfig()` 落盘，**立刻生效、不用重启** ——
它和 `agentacta --archive` / 服务内自动轮读的是同一份 `archiveCfg`），页面「历史归档」左下的
**归档开关**列表就是它的编辑口（名单来自已启用的 agent，**包括还没有任何归档的那些** ——
树里根本没有它们，而这是唯一能给它们开关的地方）。
被跳过的条目会在 `agentacta --archive` 的输出里报一行条数，`--list` 也会跟着打一行「已排除（config.archive.skip…）」，
页面的开关列表表头则显示「已关 N 个」—— 不然「清单里怎么少了个 agent」会变成一次排障。
`POST` 只收**已配置**的 agent 名（拼错的名字会被拒 400，否则会永久躺在 config 里查不出出处）。
**配置只在服务启动时读一次**：手改 `config.json` 后，在跑的那个服务要重启才认（`agentacta --stop` 再 `--ensure`）；
只想马上看效果就直接敲一次 `agentacta --archive`（它每次都重新读配置）。

**保留策略：默认永久**。归档的意义就是对抗产品删日志，自动删归档等于又制造一次空档。
要限量的机器给 `config.json` 的 `archive.maxDays`（按日期保留最近 N 天）/ `archive.maxMB`（整目录上限，
超了从最老的日期文件开始删）。**删除只针对整天文件**，不做单条裁剪 —— 归档的价值在「那天发生过什么」，
留半天的残卷没意义。

**存哪**：`~/.agent-acta/archive/<agent>/<YYYY-MM-DD>.jsonl` + `manifest.json`
（`{v, updatedAt, agents:{<agent>:{<day>:{count,bytes}}}}`）。agent 名做 `[^A-Za-z0-9._-] → _` 归一后当目录名。

**边界（刻意不做的事，别当缺陷）**：

- **不并入主列表**：归档是**只读旁路**，只在「历史归档」弹层里看。主列表的扫描/查询链路一律不碰归档目录 ——
  一旦接进去，「归档」就变成了第二份数据源，两边口径打架时没人说得清谁对。
- **不收进行中的轮**：冻结时要 `finished !== false`。半截数据（token 还没累完）没意义，它下一轮扫就会补齐。
- **events 只在非空时存**：只有 dsh / zcode / traedb 这类解析器会给 `events[]`，其余 agent 不存这个键。
- **容量量级**：本机 5022 条 → 195 个日期文件 ≈ 47.8MB（约 9.5KB/条）。
  按这个密度，一年全量归档约 **190MB 量级**；重活是 atomcode / claude / codebuddy 三家（各 10MB+），
  codearts 这类文本日志最轻（约 1.2KB/条）。

**回归测试**：`node test/archive-test.mjs` —— 隔离 profile 起真服务，四条不变式各钉一条：
① 详情确实冻住（删源文件后仍读得到）、② 复跑逐字节幂等、③ 合并不重建（删源+删索引后历史仍在）、
④ 保留策略只删整天文件；另带 `config.archive.skip` 五条（报跳过条数 + 已冻文件不动 + 归档目录不被创建 +
去掉开关能恢复 + 端点回显 skip）、三个端点、服务内自动归档（`AGENT_LOG_ARCHIVE_DELAY_MS`）、
`--archive --list` 输出与「`--list` 单敲必须退 2」。

## 全文搜索（搜索框回车 / `GET /api/search`，R33）

**解决的问题**：页面搜索框过去是**纯客户端**过滤，只作用于已经拉回浏览器的窗口条目（占位符自己都写着
「仅搜索当前 N 条」），而且只匹配「用户输入的前 300 字摘要 / 会话 / 模型 / 项目」——
AI 回复正文、工具入参/返回压根不在条目上。于是「上周那次报错」「哪个工具超时了」一律搜不到。

**怎么用**：在搜索框里敲词 = 照旧只筛当前窗口（免费、即时）；**按回车** = 走后端全库检索，
结果直接接手卡片列表，顶部多一条横幅。横幅上那几行都是**必须看**的：

```
全文搜索「npm run build」 · 命中 2 条 · 已索引 3382/3564 条 · 未套用时间范围   [限定当前时间范围] [清除]
```

**四条口径（都是刻意定的，别当 bug）**：

- **默认不套时间范围**。这是全文搜索存在的理由 —— 「上周那次报错」本来就在页面默认的最近两天之外。
  想按当前日期区间收窄，勾横幅上的「限定当前时间范围」（会立刻重搜一次）。
- **一轮最多取回 200 条命中**（`/api/search` 的 `limit`，最大 2000）。服务端在 `capped` 里说「其实还有更多」，
  横幅据此多一段「命中不止这些，本次只取回 200 条」并带悬浮说明（换更具体的词 / 勾限定时间 / 先按 agent·项目收窄）。
  没这一段的话「命中 200 条」会被读成全库就 200 条 —— 与快照那行「仅保留最近 5000 条」同一处理方式。
- **每条轮次正文上限 8000 字**，且是**逐段先截再兜总上限**（用户输入 4000 / AI 回复 4000 /
  每个工具入参·返回各 800 / 每次调用正文 800）。不逐段截的话，一段长回复就能把额度吃干净、
  把排在它后面的工具行全挤出索引 —— 而「哪一轮跑过那条命令」正是最常搜的。
  环境变量 `AGENT_LOG_SEARCH_MAX_CHARS` 可改总上限。
- **正文之外还搜条目的元信息**（输入摘要 / 会话 / 项目 / 模型 / 工具名）。这层是内存里的实时值、
  不进索引。工具名必须走这条路：像 codearts 这种 `entryContent` 明确回 `tools: []` 的 kind，
  工具名只存在于条目的 `toolNames` 上，不匹配它就永远搜不到「哪一轮跑过 Bash」。
  命中元信息时片段上会带 `where`，页面因此能说清「命中：会话名」而不是摆一段看着不相干的正文。

**索引落在哪、长什么样**：`~/.agent-acta/search/<kind>.json`，一个**源标识**一条记录：

```jsonc
{ "v": 3, "rev": 7, "files": [ { "a": "claude", "f": "<源标识>", "sig": "m:…:s:…:o:…",
                                  "t": { "<轮次>": "该轮正文" },
                                  "tf": { "<轮次>": { "Bash": { "e": 2, "t": 1, "s": 0 } } } } ] }
```

- 条目 id **不冻进索引**（id 的构造规则属于各解析器），查询时用 `(源标识, 轮次)` 反查 `srcs` 拿 id。
- `tf`（v2 起 I6；**v3 起 I13 扩三分类**）= 逐轮的工具失败分类计数，**三态**：`{"Bash":{"e":2,"t":1,"s":0}}`
  有失败、`0` 核对过没失败、**键缺失** 没索引到。三个分量是 `e`=error / `t`=timeout / `s`=soft
  （只读结构化标志、不扫正文；超时算失败、软失败单列，见「工具失败画像」与 `LOGFORMATS.md`）。
  它与正文是同一次 `entryContent` 抽出来的（`indexFailsOf`），**不额外读一遍盘**；
  内存视图按 `(源标识, 轮次)` 键、不按条目 id —— id 要经 `srcs` 反查，而「载入那一刻首扫跑完没有」
  是不该影响正确性的外部状态（刚重启时会有一大批条目盘上有数据却查成"未知"）。
  `v` 变了就是**整片丢弃重扫**（与 `rev` 同一条纪律），所以 v2 的老分片会自愈重建，不需要手工删。
- `sig` = 扫描链 `files` 里那份**同一套**判活签名（整份重解析的 kind 用 `data.sig`，增量读的用 `mtime/size/off`）；
  签名没变就整条跳过。扫描链里没有该源状态时退回 `fs.statSync` 兜底（见下）。
- `rev` = `PARSER_REV[解析器 kind]`，对不上就**整片丢弃重扫**（与 `index/` 分片同一条纪律）。

**什么时候建**：服务启动 **60 秒后**跑首轮（首轮不限量，一次建完），之后**每 10 分钟**一轮增量
（只重建签名变过的源，稳态下就是当天动过的那几个会话）。载入（读回盘上的分片）是懒的、且只做一次。
`LIB` / MCP 进程**只读不写**（`readOnly` 闸），`agentacta --search-reindex [--dry]` 是手动重建入口
（**服务在跑时拒绝执行**：索引分片一个 kind 一整片，两边同时写就是丢更新；先 `--stop`）。

**几条会以为是 bug 的地方**：

- **「已索引 A/B 条」里的 A 可以小于 B**。A 是「反查得到、这一轮查得动」的条数，B 是扫描链当前认识的条数。
  差额主要是两类：**没有可索引正文**的条目（源文件读不出来，或者这一轮本来就没有正文 ——
  例如 atomcode 有一批 **0 字节 `.jsonl`**，对话其实在 `.snapshot` 里），以及**已滑出内存窗口**的条目。
  两种都如实报在横幅上，不假装搜过。
- **命中的条目可能「在当前内存窗口外」**（`stale`）。它们在索引里、盘上也还在，只是这一轮拿不到统计字段
  就没法排序，所以这一轮不返回；源回来时立刻又能搜到。
- **搜不到归档条目**。归档（R28）是刻意隔离的只读数据源，不进这个索引；它的关键词搜索在「历史归档」弹层里。
- **正则模式**：把词当正则（`re=1`）。非法正则回 `400 + ok:false` 加原话，不会 500、
  更不会落到 404 兜底被说成「接口不存在」。回溯过深的模式有 2 秒预算兜底。

**两条「差点做错」的判活（改代码前先读）**：

- **不能自己 `statSync` 源标识**：cursor / gemini 的源标识是**伪路径**（`'cursor:' + dir`），
  一个目录算一个源、整份重解析，`files` 里记的是 `{m:0, s:0}`、真签名在 `data.sig`。
  按「stat 不到 = 源没了」处理会把这**两家整家静默漏掉**（本机 714 条，占 13%）。
  同理 `PARSER_REV` 要按**解析器 kind** 查（atomcode 的 `src.kind='atomcode'` 而 `files.kind='jsonl'`）。
- **扫描链没有某源的状态 ≠ 不能索引**：atomcode 会话目录里有一批 0 字节 `.jsonl`，
  `scanAtomcodeDir` 对它是 `if (s <= off) continue`（0 <= 0），在 `files.set` 之前就短路了；
  可条目照旧由 `.meta` 产出来、`src.file` 指的正是这个空 jsonl。不加「退回 `fs.statSync`」这条兜底，
  本机 **47 个源 / 885 条（占 25%）会被整批判成「源没了」**，连按会话名/模型名都搜不到。加上之后覆盖率 2679 → 3382。

**接口**：

- `GET /api/search?q=&re=1&agent=&agents=&project=&projects=&status=&from=&to=&limit=&offset=`
  —— `from`/`to` **只在页面勾了「限定当前时间范围」时才传**；不传 = 不限时间。
  返回 `{ ok, total, scanned, stale, capped, entries[], index, rangeLabel, agents, projects }`，
  条目与 `/api/snapshot` 同形状、另加 `_snip = { pre, hit, post, where? }`（三段纯文本，页面自己转义再高亮）。
  关键词为空 → 400；非法正则 → 400 + 原话。
- `GET /api/search/status` → `{ ok, entries, files, total, building, unreadable, noState, bytes, at, maxChars, pruned }`
  —— 横幅的「已索引 A/B」与「正在建」用的就是前四个；`pruned` 是 R34 加的，见下。
- **记录按绝对路径认人**：一条记录只有在扫描链把它的源文件扫成条目、给出 `(源标识, 轮次) → id` 的映射之后
  才**可能**被搜到，所以源不在本机的记录（跨平台/跨机器搬过来的、或日志已被产品删掉的）载入时就被剪掉
  （`pruned` 报数，写进日志），留着只会让「已索引 A」虚高。被 LRU 淘汰但源还在盘上的记录**不受影响**，
  那正是「合并而非重建」要保住的那批。

**回归测试**：`node test/search-test.mjs`（30 条断言）。分两段：第一段拿**假 deps** 直接单测 `search.mjs`
（增量跳过 / 只重建变了的源 / 大小写不敏感 / 片段保持原文大小写 / 非法正则不抛 / LRU 淘汰后正文留盘 /
`rev` 失效 / `readOnly` 一个字节不写 / 元信息兜底层）；第二段起真服务走 `/api/search`，验接线、
筛选口径与「不套时间范围」这条（fixture 里特意放了 6 天前的那一轮）。

## 导出（列表筛选集 JSON / CSV / Excel + 单条完整详情，R11）

**入口两处**：列表工具栏的下载图标 → 「导出当前筛选结果」下拉（JSON / CSV / Excel）；展开某一轮后，
详情底部吸底条上的「导出该轮完整详情」。

**先认清导的是哪一份**（最容易对不上账的一条）：就是列表此刻那份筛选集 `filtered`，
也就是「服务端按 agent / 项目 / 时间 / 状态取回来的那批」再过一遍客户端关键词、`只看异常`、侧栏那枚
「显示非 LLM 轨迹」的显示偏好。**它跟列表一致，所以也跟着一致地受限**：
- 快照窗口由右上角「条/页」档位决定（默认 200，档位最大 500；服务端那边最高认到 10000，
  前端另有 5000 条内存兜底 `MAX_ALL`，真触到了列表那行会写「仅保留最近 5000 条」）——
  要更多就收窄时间范围或把档位调大。**导出的是已加载窗口里筛出来的全部，不止渲染出来的那一屏**；
- 搜索态（R33 那种「搜索框回车接管列表」）下 `filtered` 源自 `/api/search` 的 `entries`：那里默认只回 **200 条**
  （`limit` 最大 2000），且条数按「命中集 ∩ 当前筛选集」算。横幅写的「命中 N 条」就是这 N 条，
  于是**导出与横幅永远一致**；命中真被 200 截了，横幅会多一段「本次只取回 200 条」（见「全文搜索」那节的四条口径）。

**三种格式都带「按什么条件导出」**（R11 的验收点，`exportFilterText`）：时间 / agent / 项目 / 状态 / 关键字 /
只看异常（勾了才写）/ 显示档位。字段名照实写、不自欺 —— 档位也在里面，因为「这批为什么只有 200 条」正是靠它回答。
- **JSON**：`{meta:{exportedAt,count,filters[]},entries[]}`。`meta.exportedAt` 是 ISO（UTC，带 `Z`），给机器读的。
- **CSV**：**UTF-8 BOM + CRLF**（中文在表格软件里不乱码）。头两行是 `筛选条件: …` 与 `# 共 N 条`，第三行是表头，其后是数据。
  值里含逗号 / 双引号 / 换行时按 CSV 正规做法用双引号包住、内部双引号翻倍。
- **Excel**：扩展名 `.xls`，内容是 **SpreadsheetML 2003 XML**（同样带 BOM）—— Excel / WPS 原生打开。
  说明行在前、一个空行隔开、再表头 + 数据；纯数字的值写成 `ss:Type="Number"`，其余 `String`。
  **为什么不做真 `.xlsx`**：那要么引 SheetJS 之类的库、要么走 CDN，而这是个离线本地旁路 ——
  多一个依赖就多一条「断网 / 装不上」的烂路；XML 那一套表格软件认，手写够了。

**15 列**（CSV/Excel 表头与 JSON 的 `entries` 同序）：`time`（本地时间串，与卡面一致）、`agent`、`project`、
`session`、`status`、`preview`（用户输入摘要，源头截 300 字）、`models`、`dur`（毫秒）、`tin` / `tout` /
`tcache` / `total`、`calls`、`tools`、`nollm`（是 / 空）。**没有正文与工具入参** —— 那是单条详情的活。

**单条完整详情**走 `GET /api/entry?id=&full=1`：用户输入 / AI 输出 / 每次工具调用的入参与返回都是**未截断**的
完整内容（`full=1` 就是为此存在的），连同条目元信息（agent / 项目 / 会话 / 时间 / 状态 / 耗时 / 模型 / token 合计）
写成 `{meta,entry}`。条目已经不在列表里（被 LRU 淘汰、或列表已筛走）会提示「无法导出：找不到该条目」，
不会闷声导一个空文件；拉取失败给的是带原因的报错。

**文件名一律本地时间**：`agent-acta-YYYYMMDDHHmmss.<ext>`，单条那份是 `agent-acta-<时间>-entry-<id 前 40 字符>.json`。
用本地而不是 `toISOString()`，因为文件名要和筛选区间（本地自然日）与卡面时间对得上 ——
东八区拿 UTC 命名会出现「9 点导出的文件叫 01 点」。

**实现落点**：序列化与下载是 `page/shared.js` 里四个零依赖纯函数（`csvCell` / `buildCSV` / `buildExcelXLSText` /
`downloadBlob`），「筛了什么、导哪些行」留在根 setup（`exportFilterText` / `exportRows` / `exportData` /
`exportEntryDetail`）—— 前者不认响应式状态，才放得进 R12 那份跨端共享逻辑的单一面孔（见 `test/shared-snippet-test.mjs`）。
下载走 `a.download` + `URL.createObjectURL`，**不经过服务端**：整个导出不新增任何写盘、也不新增网络出口。

## 两轮对比（卡片顶行「对比」选两条，I9）

回答的是「**同一个 prompt 这次为什么慢**」：主列表每张卡片顶行有一个「对比」按钮，点两条自动弹开并排对比弹层。
只许两条 —— 选第三条会给一句「一次只对比两条轮」；再点已选中的那条是取消选择。

**比的是什么**：上半区是条目**本体**的指标（快照就带，不必等详情）：耗时（两条并排的相对柱，以较长者为满刻度）+
模型 / LLM 调用 / 工具 / 积分 / Token 输入·输出·缓存命中·合计 / 上下文占用 / 压缩。
下半区是正文（用户输入、AI 输出、工具调用逐条），走 `/api/entry` **懒加载**，点开对比才取，两条各自独立。

**每条指标行都标「谁大」**：标签后跟 `差 N`，数值大的一侧加深加粗。前提是**两侧同单位**：
qoder 与别家混比时，「积分」行的别家一侧、Token 行的 qoder 一侧都给 `—` 并且**不作差**
（单位不同的差没有意义），`—` 上挂了 title 说明是"不适用"还是"没数据"。

**qoder 一律不给 token 数字**：它日志里 `input/output/total_tokens` 恒为 0，真实花费只有积分（`credits`），
上下文也只有最后一次调用的占比（`context_usage_ratio`）而不是占用/容量。所以：

- 只要有一条是 qoder，就出现「积分」行；两条都不是 qoder 才完全没有这一行；
- 两条都是 qoder 时 Token 四行整段不出现（没有可比的东西）；
- 「上下文占用」行 qoder 侧显示占比（如 `19.7%`），别家显示 `占用 / 容量（百分比）` —— 与卡片同一口径。

**关掉再开**：弹层关掉不清掉手里那两条，所以重选同一对不会先闪空态；但弹层里**没有**「换条目」入口，
要换就得回列表重选两条。「选完第一条后那条掉出当前列表」（SSE 增量、改筛选、回车切进全库搜索命中集都算）
时不会弹一个空层：会提示「先选的那条已不在当前列表里」，并把你刚点的那条留在选中态。

**实现落点**：组件 `page/dialog-compare.js`（222 行，模板 + `cmpRows` 那张表全在里），
根只持 `compareSet / compareVisible / compareReq` 三个 ref 与 `onCompare`（`agent-acta-page.html`）。
状态"谁用谁持有"：选中组、两条本体、详情缓存都在根（切视图/关弹层都不丢），组件只认 props 与 inject 的 `getJSON`。
卡片模板为按钮高亮新读了一份 `compareSet`，所以 `cardMemo` 同步加了 `cmpBit` 一项（漏了就点不亮）。
**纯前端**：不新增任何接口、不写盘、不碰解析口径（无 `PARSER_REV` 影响）。

## 单轮复现包（卡片详情「导出复现包」/ `GET /api/repro`，I8）

一键把**某一轮**打包成 zip，用于贴群 / 提 bug 时带上完整上下文：原始日志片段 + 完整解析结果 + 版本指纹 +
导出那一刻的筛选条件。入口在卡片展开后的底栏「导出复现包」。

**接口**：`GET /api/repro?id=<条目 id>&filters=<JSON 串>` → `{ ok, meta, parsed, raw }`。

- `meta`：`version / build / pageBuild / parserRev` 四枚指纹 + `generatedAt` + 条目本体 `entry` +
  `src`（原始文件路径、轮序号、kind）+ `filters`。
- `parsed`：就是 `/api/entry?full=1` 那份完整解析结果（工具入参/返回、逐次调用都不截断）。
- `raw`：`reproRaw()` 切出的**该轮原始片段**，三种结果之一 ——
  ① 能切：`extractable:true` + `lines[]`，`note` 里写清「本文件第 N–M 行（1-based，与磁盘一致，空行已跳过）」；
  ② 源不是单文件 JSONL（数据库 / 多帧压缩 / 内存转录 / 多文件）：只给 `file` 路径 + 一句说明；
  ③ 源文件未载入内存（还没扫到或已淘汰）、或按开轮判定定位不到那一轮（源被轮转/截断）：同样退回说明文字。
  ②③ 不是 bug，是设计边界 —— 能切的这九家：`claude / codex / buddyjsonl / doubao / minimax / kimi / copilot / generic-jsonl / openclaw`。
- 坏 id 或条目已淘汰 → **404** `{ ok:false, error:'找不到该条目…' }`。

**「原始片段」的归轮口径**：从这一轮的**用户输入行**起，到**下一轮开始前**止，含该轮内的模型响应、工具调用与
`tool_result` 等全部交互 —— 用的就是各解析器**同一套**开轮判定（`copilotTurnStart` / `genericTurnStart` /
`mavisUserText` 三个新导出的 helper），不是另写一遍"看着像开头"的启发式。读原始行走 `readCompleteLines`，
与扫描侧同为"只吃完整行"，半截尾行不会被算进来。

**打包在浏览器里做**：`page/shared.js` 的 `makeZip()` 手写 **store 模式 ZIP**（不压缩、零依赖，不引 JSZip ——
离线本地服务引不了 CDN，而内容本就是文本，压不压无所谓），CRC-32 自己算。zip 里四个条目：
`repro-meta.json` / `repro-raw.jsonl` / `repro-parsed.json` / `README.txt`。文件名
`agent-acta-<本地时间>-repro-<id 前 40 字符>.zip`（时间用本地、与筛选区间和卡面对得上，同 R11 那条理由）。
下载走 `URL.createObjectURL` + `a.download`，**不经过服务端**：整个导出既不在服务端写盘，也不新增网络出口。

**筛选条件是页面递进来的**（服务端没有"筛选态"这个东西），原样回显进 `meta.filters` 并抄一份进 zip 里的
`README.txt`，所以事后能自证「当时是按什么条件看的这一轮」。原始片段切不出来时，`repro-raw.jsonl` 里会写
`# 原始片段不可用：<原因>` 并附上原始路径，成功提示里也如实带一句"原始片段不可用"。

**那个原始片段文件为什么叫 `.jsonl`**：内容就是磁盘上那几行原文（逐行 JSON），所以扩展名跟着走。
2.10.3 及之前包内 `README.txt` 的清单误写成 `repro-raw.log`（条目名本身一直是对的 `.jsonl`），
**2.10.4 统一过来**，同时删掉了当初那个两个分支都返回 `.jsonl` 的 `rawExt` 三元。

**回归**：`test/repro-test.mjs`（隔离 HOME，四条验收：形状 / claude 按开轮精准切片 / `filters` 回显 / 坏 id 退 404），
已登记进 `test/selftest.mjs` 的 `cli` 组。**没做**：zip 解压回验、多轮合并打包、不可提取 kind 的尽力重读。

## 工具失败画像（统计弹层 →「时延分析」→ 第 4 个子 tab，I6；I13 扩三分类）

**回答的问题**：「哪个工具最常把我绊倒」。同一段筛选里给出每个 **agent × 工具名** 的
`失败次数 / 调用次数 / 失败率`，外加一张按 `agent × 来源 kind` 摊开的**覆盖度表**（谁有信号、谁为什么是空的）。

入口在「用量统计 → 时延分析」下面，与最慢轮 / 工具调用 / 缓存命中率共用同一次 `/api/analyze` 取数
（切子 tab 不再发请求）。

```
GET /api/analyze?range=30d&top=10        →  { …slowest, byTools, byCacheRate,
    toolFails: { minTotal: 10, building: 0, truncated: 0, totalKinds: 61,
      totals: { err, timeout, soft },                            // 三分类总数，**全量行**口径（不受 topN 截断影响）
      rows:   [ { agent, name, fail, err, timeout, soft, total, rate, lowDenom, hasTs } ],  // 按 fail 倒序，只含 fail>0
      agents: [ { agent, kind, tier, tsSig, turns, known, unknown, failTurns, softTurns, turnRate } ] } }
```

- `fail = err + timeout`（**超时算失败** —— 它就是失败）；`soft`（软失败）**不进 fail、不进失败率**，
  只进 `totals.soft` 与轮级 `softTurns`（`No matches found` = rg 没搜到，是最常见的正常结果）。
- `fail` 来自搜索分片的逐轮计数，`total` 来自条目的 `toolNames`，**且只累加"分子那一批同集合的轮"** ——
  没核对过的轮连分母一起不算，否则失败率会被"根本没看过的轮"稀释成假的低值。
- `tier` 三档（`signal` / `noDetail` / `noFlag`）与「未索引」是四件事，页面分开交代；
  后三种**一律不画 0**（那里的空是"没有这个信息"，不是"从不出错"）。
- `tsSig=1` = 这个来源的详情带得出**超时 / 软失败**信号（I13，现只有 `claude` 那一档，qoder-cn 共用）。
  没这一层的来源 `timeout` / `soft` 是 **`null` 而不是 0**，页面整段不印 —— 那个 0 会被读成
  「这个 agent 一次没超时」，而真相是「源里根本没有这一层」。
- `lowDenom=1` = 分母不足 `minTotal`（默认 10 次）。这么定的原因很实在：本机实测
  `StopCommand 1/1 = 100%`、`ExitPlanMode 1/2 = 50%`，而真正天天绊人的 `Bash` 只有 1.0%~4%。
  排行主序按**绝对失败次数**，率只作并列维度与第二列；条形按本次最高的那个率归一（不是按 100% 归一 ——
  真实失败率都在个位数，按满刻度画会得到一排看不见的空条）。
- `building=1` = 后台还在建索引，`unknown` 那批还会往下降；此时画像不完整，页面顶上有这一句。

**为什么挂在搜索索引上**：工具失败标志只存在于**详情侧**（`tools[].error` / `.timeout` / `.soft`，见
`LOGFORMATS.md`「工具失败信号」），而逐条读详情的代价极高（claude 一条 41ms —— 每次 `readFileSync` 整份转录）。
`search.mjs` 建索引那一遍本来就在逐条 `entryContent`，I6 就顺手在同一遍里抽出 `tf` 计数落进分片：
**零额外读盘、不 bump `PARSER_REV`**（分片自己的 `SHARD_V` 1→2；I13 又 2→3，老搜索分片自愈重建）。

**与「异常巡检」（R9）的 `fail` 规则不重叠**：那条按 agent 统计**轮级** `status != ok` 的占比，
而工具失败在多数 agent 里根本不冒泡成轮 err（claude 全体非 ok 2.9%，抽样带工具的轮 20% 含失败工具）。

**I13 补上的那两层（超时 / 软失败）**：判据仍然是「只读解析器落好的结构化标志、一个字正文都不扫」，
变的只是"有几位可读"。信号在 claude 转录的**记录级** `toolUseResult` 上（不在 `tool_result` 块里），
由 `parsers/claude.mjs` 的详情回填搬到 `tools[]`：`timedOutAfterMs` → `timeout`、
`returnCodeInterpretation` / `staleRecovered` → `soft`。要害是**超时那批 `tool_result.is_error` 是显式 `false`**
（本机 141 份转录 / 30 次超时，一律如此，不是缺键）⇒ 旧口径下它们不是"未知"，是被**明确记成"这一跑没问题"**；
软失败同理（`No matches found` 39 / `Files differ` 2 / `staleRecovered` 16），只是它本来就该算正常。
这一笔**只扩详情侧字段、落盘 turns 一个字节没动 ⇒ 不 bump `PARSER_REV`**。

**没做**：点行下钻回"该工具失败的那些轮"（要新的筛选维度）；MCP 面新增工具 —— 目前只暴露
`slowest_turns`（不读 `toolFails`，**不受影响**），所以 agent 现在还**问不出**「哪个工具最常超时」；
补 codex / generic 的失败信号（属解析口径，要单独立项 + bump）。

**回归**：`test/tool-fail-test.mjs`（隔离 HOME，两阶段 25 条：没建索引时必须报
`unknown` 而不是"零失败" / 分片 `tf` 三分类落盘 / 排行与分母同批 / `lowDenom` 两档 / 按天筛选同时收窄分子分母 /
`fail = err + timeout` 且软失败不占排行 / 无信号来源出 `null` 不出 0（用 gemini 一家验）/
`PARSER_REV` 未动），`test/platform-test.mjs` 第 5 节钉住三态在载入与剪枝后仍可区分。已登记进
`test/selftest.mjs` 的 `cli` 组。

## 数据与配置

> **数据目录 2.0.0 起在 `~/.agent-acta/`。**沿革：最早在 `~/.atomcode/agent-log/`（那时它还只是个
> 「看 atomcode 逐次 token」的小工具，名字顺着宿主的窝叫）→ 1.9.0 搬到 `~/.agent-log/`（跟
> `~/.claude` / `~/.codex` 同一层规则）→ 2.0.0 随改名落到 `~/.agent-acta/`。
> **升级不用手工操作**：下次启动服务时自动搬一次（配置、索引、pid 一起过去），**两条老位置都认**，
> 跨代升级（从没装过 1.9.0 的机器）也一步到位；旧位置各留一张 `<老目录名>-MOVED.txt` 说明。
> 若新位置里已经有真配置，则一切照旧、不再搬；搬迁只在「新位置还没有真配置」时发生。

- 配置：`~/.agent-acta/config.json`（v3，含扫描节奏 `scanMs`）
  - 老版本（v1/v2）会自动升级到 v3；v2 里 codebuddy/workbuddy 若仍是出厂默认的 trace 预设，
    且本机存在 `~/.codebuddy/projects`，会被就地改成 `projects` 解析；**自己改过路径的一律不动**。
  - `sessionsExtra`（可选，数组）：**额外的同格式日志根**。一个 agent 默认只有一个 `sessions`，
    但 kimi 有两份（CLI 的 `~/.kimi-code` 与桌面版内嵌的那份 home，可能分在两个盘），
    只认一个就等于静默丢一半数据。这一项由服务端每轮自动发现时重算并写回，
    桌面版卸载/挪盘后会自动摘掉，**不用手改**。
  - `ctxWindows`（可选）：上下文窗口表，模型名或前缀 -> 容量。一般不用手改——
    页面侧栏「上下文窗口」就是它的编辑器（含「日志里出现过但没填」的模型清单）。
    **这张表只服务 claude 与 kimi**：这两个的日志里**没有**窗口容量字段（claude 的死在网关侧，
    kimi 的 `wire.jsonl` 只记用量），只能按模型名查表；查不到就只显示占用、不画进度条。
    其余 agent 的窗口来自各自源头（atomcode 的 `.meta`、cursor 的 `composerData`），不由这张表决定。
  - `traeKey`（可选）：Trae CN 的 SQLCipher 库密钥（64 位十六进制）。**不配也能用**——trae 自动回退
    `renderer.log` 骨架；配置后才读库（有完整用户输入与逐调用明细）。获取办法见「Trae 的 SQLCipher 库」一节。
  - `archive`（可选，R28）：`{enabled, maxDays, maxMB, skip}`。默认 `{enabled:true, maxDays:0, maxMB:0, skip:[]}`
    = 自动归档开、**全 agent 参与**、**永久保留**。
    `enabled:false` 只关自动轮（`agentacta --archive` 手动跑不受影响）；`maxDays`/`maxMB` > 0 才限量，
    超了从最老的**整天文件**开始删；`skip`（agent 名数组）**按 agent 停掉归档**，
    **只停未来、绝不删已冻的文件**（写 `["cursor","trae"]` 这样）。与出厂默认同值的写法不会落盘。
    口径详见「历史归档（R28）」一节。
  - `alert`（可选，R9）：异常巡检规则：`{tokens:{on,val}, durMs:{on,val}, fail:{on,val,window}}`。默认全关。
    挂在同 scanMs 的持久化通道上：页面弹层「异常巡检」就是它的编辑器（POST /api/alert），
    **保存即落盘、重启服务仍在**；三条规则全是顶层规则，只有 `fail` 在求值时**按 agent** 统计。
    `tokens`：单轮 total（输入+输出+缓存）超 `val`（token）；`durMs`：单轮耗时
    （轮内首条→末条时间差，含挂机/隔夜）超 `val`（毫秒）；`fail`：某 agent 最近 `window`（1..100）轮里
    失败（status != ok）占比超 `val`（%），命中该 agent 构成失败的那几轮。全关 = 绝不打扰。
    命中集合是**纯内存派生**（不落盘不占索引），任一规则/阈值改动或新日志扫完会就地重算并
    广播 `alert` 事件，前端据此点亮侧栏徽章与「只看异常」，新产生的异常条目无需人工翻找。
    口径详见「异常巡检（R9）」一节。
- 索引：`~/.agent-acta/index/<kind>.json`（按格式分片，仅存带增量偏移的状态）
  - 每份索引带 `rev`，与解析器版本不符时该项整体丢弃、下次冷读一遍——改了统计口径又不想让页面报旧数字时用它。
- 归档：`~/.agent-acta/archive/<agent>/<YYYY-MM-DD>.jsonl` + `manifest.json`（R28，条目级冻结；默认永久保留）
- 端口：`AGENT_LOG_PORT` 环境变量可覆盖，默认 `14570`
- pid 文件：`~/.agent-acta/server-<端口>.pid`（`--stop` 的兜底线索；判活仍以端口为准，
  被强杀过的进程留下的陈旧文件不会误导它）
- **空闲自停**：右上角「空闲自停」下拉可选 30 分钟 / 2 小时 / 6 小时（默认关）。
  条件是**页面全关（无 SSE 连接）且这段时间没有任何新日志**——正在跑会话就会一直续期。
  自停只是退出进程，配置与索引都在，下次开会话会被 hook 的 `--ensure` 重新拉起。
  临时调试可用 `AGENT_LOG_IDLE_MS=60000` 覆盖阈值（不落盘）

## 异常巡检（R9）

**解决的问题**：异常（单轮 token 爆表、单轮卡了很久、某 agent 失败率飙升）要命的是**不知道它发生了**，
等手动翻列表才看到，往往已经过了半天。R9 让它**主动说出来**：侧栏多了「异常巡检」一项，
命中时该项带红色角标（条数），请求日志列表多一个「只看异常」勾选框，点开弹层逐条查看并一键定位回主列表。

三套规则**全在顶层**（不是 per-agent），保存即落盘 `config.alert`，**与 scanMs 同一套设置机制**——

| 规则 | 求值对象 | 阈值 | 命中 |
|------|---------|------|------|
| 单轮 token 超阈值 | 每条日志 | total = 输入+输出+缓存 > N token | 该轮 |
| 单轮耗时超阈值 | 每条日志 | 轮内首条→末条时间差（含挂机/隔夜）> N ms | 该轮 |
| 失败率超阈值 | **按 agent** | 最近 N 轮（fail.window，1..100）中失败（status != ok）占比 > X%（1..100） | 该 agent 里构成失败的那几轮 |

- 命中集合 `alertHits` 是**纯内存派生**，不落盘、不进索引；默认全关 = 绝不打扰。
- 任何一轮扫描后（有新日志）或规则被改动时**就地重算**并广播一条 `alert` 事件
  （带摘要 `summary` + 命中 id 列表），前端据它点亮徽章 / 更新「只看异常」集合，
  于是**新产生的异常条目无需人工翻找即可被提示**（R9 验收点）。
- 接口：`GET /api/alert` / `POST /api/alert`，详见「服务端 HTTP API」。
- 回归：`node test/alert-test.mjs`（不发浏览器，走接口断言命中数与字段）。

## 磁盘占用（侧栏「磁盘占用」/ `GET /api/usage`，R30）

**解决的问题**：占用散在三处 —— 各 agent 自己的日志目录、`~/.agent-acta/index/` 的分片、`archive/` 的日期文件，
没有任何一处能一次看全。「要清磁盘」时就只能 `du` 来 `du` 去，还得记得 trae 的库要连 `-wal` 一起算。

**页面**（侧栏「磁盘占用」）：按 agent 一行，列 日志 / 归档 / 内存条目 / 合计（合计带占比条，列头可点排序）；
下面两块是索引分片与 `~/.agent-acta` 顶层构成。**只读** —— 这一页不删任何东西，删都要自己动手。

四条口径（服务端刻意这么定的）：

| 口径 | 为什么 |
| --- | --- |
| 索引片**单列**，不并进 agent 行 | 一片按 kind 存、可能同时供好几个 agent（traedb 用的就是 tracecode 那片），并进行里相加就是重复计数 |
| 库类根连 `-wal` / `-shm` 一起算 | 那两个常常比主文件还大，只算主文件会把占用报小一半 |
| 两个 agent 指同一份目录时：行内各报各的，`totals.logBytes` 只算一次（`logBytesRows` 才是各行相加） | 这一页要回答「要清多少地方」，重复计数的那个数不能当总数用；页面上那行带「共用目录」标记 |
| 遍历**带预算**（默认最多 6 万个目录项 / 4 秒），走不完标 `partial` | 整个服务只有一个线程，扫描与 SSE 都在这上面；宁可写「统计到一半」也不给一个看似完整的假数。截断按目录**轮转**摊到每个根，避免「只有第一行有数、其余全 0」把排名带偏 |

临时调预算用环境变量（不落盘）：`AGENT_LOG_USAGE_MAX_FILES` / `AGENT_LOG_USAGE_MAX_MS`。
结果缓存 60 秒，页脚「刷新（用缓存）」走缓存、「重新统计」带 `?force=1` 绕开。

## 自检（`agentacta --doctor`，R29）

输出一段**可粘贴的病历**：排障第一步跑它，把整段贴出来，省掉「你那边是哪一版 / 有没有改过配置」这类来回。
与页面上的「环境诊断」分工不同 —— 诊断页回答「**能不能发现路径**」（目录在不在、认成什么格式、没认出来是为什么），
`--doctor` 回答「**已经攒下的这些东西还可不可用**」。

查这些，判据全部取自服务端真正在用的那套（不另编一套判据，否则体检结果与真实行为会分家）：

| 检查 | 判据 | 说明 |
|---|---|---|
| 配置能不能解析 | `config.json` 的 JSON + 版本号 | 解析失败＝`[fail]`：服务会**静默回落成默认预置**，手工加的 agent 与 `traeKey` 全丢 |
| 配置指向的目录还在不在 | `confAvailable()`（库类 kind 认文件，其余认目录） | `source:auto` 的会自动摘掉；手工项会一直留着，确认卸载了就删 |
| `kind` 还有没有解析器 | `scanBranch()` 的兜底分支 | 认不出会**按原子码式目录扫**（有目录也扫得出东西，只是字段少一截）——静默，所以必须点出来 |
| generic-jsonl 的 rules | `validateGenericRules()` | 坏规则会被回落成禁用，点名是哪条 rule、坏在哪 |
| dsh 的 zstd | `DSH_ZSTD_OK` | Node < 22.15 解不开 zstd，目录在也一条都出不来（升级 Node，不是路径问题） |
| 索引片 | `index/<kind>.json` 能否解析、`rev` 与 `PARSER_REV` 是否一致 | 坏片/旧口径片会在启动时整片丢弃重扫（源日志还在就只是慢一轮，数据不丢） |
| 端口上跑的是不是这一版 | `/api/version` 的 `build` 指纹 | 不一致＝`[fail]`，典型症状「页面是新的、接口是旧的」 |
| 页面文件 | 两个占位符 + `/page/` 资源齐不齐 | 缺了就是白屏（这条自检原本只写进服务日志，用户看不到） |
| 归档现状 | `manifest.json` + 归档目录实况 | 只报多大、几天、多少条、跳过了谁 |

- **只读**：不搬家、不改配置、不动索引。跑体检本身不该改变被诊断的状态 —— 否则「跑一下就好了」这件事
  永远说不清原因。所以它不调 `loadConfig()` / `loadIndex()`（那两个会做 v1→v2 迁移、把旧配置/旧索引改名、
  把 `rulesHash` 落盘），配置与索引都是自己按只读方式读一遍。测试里对这一点有逐字节断言
  （`test/doctor-test.mjs`）。
- **退出码**：`0` 没有失败项 / `1` 有失败项。`[warn]` 不拦脚本（它多半会自己好，或需要人判断）。
- **在源码目录里跑，会必然报一条「端口上跑的是另一版」——这是对的**：那份指纹取的是**当前这个文件**，
  而端口上常驻的通常是全局 npm 包那份（内容不同版号相同）。要验装出来的那版就敲 `agentacta --doctor`。
- **不上色**：这段输出是给人粘贴的，ANSI 转义一贴就成乱码。级别用 `[ok]`/`[info]`/`[warn]`/`[fail]` 前缀表达。
  级别口径：`[fail]` = 现在就已经是坏的（有东西在静默地少）；`[warn]` = 会自己好、或需要人判断；
  `[info]` = 正常但值得知道（还没跑过服务、还没归档）。

## 作为 MCP server 接入（`agentacta-mcp`，R31）

面板只能「看」，而看的前提是人已经知道要看哪一列。复盘类的提问天然是问句（"我上周最慢的一轮是哪一轮"
"哪个项目 token 涨得最凶"），拿界面去答就得人肉翻筛子。`agentacta-mcp`（随包发的第二个 bin，`mcp-server.mjs`）
把这套查询面包成 MCP server，claude / cursor / qoder 之类的客户端可以直接问。

### 三条硬边界

- **只读**。数据全部来自 `agent-acta-server.mjs` 导出的 `LIBRO`（**只读库模式**：同一个文件被 `import` 而不是
  作为入口跑起来时，落索引 / 写配置 / 搬数据 / 起 HTTP / 挂定时器这五处全部短路，写盘只剩三个入口
  ——`saveConfig`、`saveIndex`、`loadConfig`/`loadIndex` 里的一次性改名，都各自带了门）。
  所以常驻服务在不在跑都能用，两个进程也不会互相踩文件；`test/mcp-test.mjs` 里对"跑前跑后整棵树逐字节相同"
  有断言，不是"看着像只读"。
- **不新增网络出口**。传输只有 stdio：客户端 fork 本进程，我们只往 stdout 写协议消息。stdout 是协议通道，
  所以一行诊断都不许往那儿打（服务端的 `console.log` 在只读模式下已整体改道 stderr）。
- **不美化口径**。七个工具调的就是页面/HTTP 接口用的那批函数（`filterEntries` / `dailyAgg` / `modelAgg` /
  `analyzeAgg` / `sessionsAgg` / `entryContent`），bin 里不另算第二套数字；截断与上限都在返回里如实标注。

### 接入

命令路径填 `agentacta --where` 打出来的那份（全局包），或源码目录里的 `mcp-server.mjs`：

```json
{ "mcpServers": { "agent-acta": { "command": "node", "args": ["C:\\Users\\<你>\\AppData\\Roaming\\npm\\node_modules\\agent-acta\\mcp-server.mjs"] } } }
```

- **Claude Code**：`claude mcp add agent-acta -- node "…\\mcp-server.mjs"`（或写进项目根的 `.mcp.json`，键名同上）
- **Cursor**：Settings → MCP，或 `~/.cursor/mcp.json` 里加上面那一段
- **Qoder**：MCP 设置里新增一个 server，command 填 `node`，args 填那个绝对路径

各客户端的键名/入口略有差异，但都要的是"`command` + `args` 两个字符串"；stdio 传输不需要端口，也不需要先起服务。

### 七个工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `overview` | — | 版本/指纹/数据目录、每个 agent 的条数与是否缺目录、项目 Top30，外加三条"读法提醒" |
| `search_entries` | 筛选 + `text` / `status` / `slowest` / `limit`（默认 50，上限 500） | 轮次列表：`id at agent project session dur status models tin tout tcache total calls tools preview` |
| `get_entry` | `id`（必填）、`full` | 这一轮的详情：用户输入、助手正文、工具调用入参出参、逐次 LLM 调用，附源文件路径 |
| `list_sessions` | 筛选 + `limit`（默认 30） | 会话级汇总：几轮、首末时间、合计 token/耗时、模型、是否有时间轴 |
| `usage_stats` | 筛选 + `by=day\|model`、`last`（默认 90 天）、`top`（默认 20 个模型） | 逐日序列（含空天）或按模型汇总 + `totals` |
| `slowest_turns` | 筛选 + `topN`（默认 10） | 最慢 N 轮 + `matched/p50/p95/maxDur` |
| `tool_fails` | 筛选 + `top`（默认 10 个工具行） | 工具失败画像：`rows`（按失败次数倒序，含 `fail/err/timeout/soft/total/rate/lowDenom/hasTs`）、`totals`、逐 agent 覆盖度 `agents`、`minTotal`、`notes` |

公共筛选键（除 `overview`、`get_entry` 外都吃）：`agent`、`project`、`range`（`today`/`7d`/`30d`）、
`from`/`to`（`YYYY-MM-DD` 本地自然日，同给时优先于 `range`）、`refresh`。

`tool_fails` 的口径与页面「工具失败画像」同源（同一个 `analyzeAgg.toolFails`）：**超时算失败**
（`fail = err + timeout`）、**软失败单列一档不进失败率**（`No matches found` 这类被判定为正常的结果）、
**源里没这一层的 agent 出 `null` 而不是 `0`**。所以 `timeout`/`soft` 为 `null` 时别读成"从没超时"，
`notes` 里会写清是哪几家、以及"多少轮还没索引到"。

### 行为细节（会以为是 bug 的地方）

- **第一次握手慢**：进程起来要先全量扫一遍本机日志（本机实测 18 个 agent / 5405 条 ≈ 2.2s）。这期间 stdin
  由内核缓冲，消息不会丢，所以是"问第一句要等一下"，不是卡住。
- **最多滞后 15 秒**：超过这个年龄才补扫一轮（`AGENT_LOG_MCP_TTL_MS` 可改）。刚产生的日志问不到就显式传
  `refresh: true`。
- **响应有上限**（默认 22 万字符，`AGENT_LOG_MCP_MAX_CHARS` 可改）：超了会削行数组并在 `truncated` 里说明削了谁。
  宁可不给全，也不给一个被客户端掐掉的 JSON。`get_entry` 的 `full: true` 是唯一故意放大的口子。
- **`text` 不是全文检索**：只在"用户输入摘要"（前 300 字）里做子串匹配，助手正文与工具输出不在索引里。
- **token 为 0 不等于没消耗**：qoder 走 `credits`、cursor 的转录里没有 usage 字段（要注了侧栏那个
  `stop` 钩子才有逐轮 token，见 LOGFORMATS.md 的 cursor 一节）。这些键只在该条真有值时才出现。
- **v1 不吃归档**：内存窗口有条数上限（LRU 淘汰最旧、每个 agent 至少保留最近 200 条），窗口外的历史只有页面
  「历史归档」能查。工具面暂时没这条，`overview` 的提醒里写明了。
- **`tool_fails` 依赖搜索分片，而 MCP 进程自己不建索引**：工具失败画像的分子来自 `~/.agent-acta/search/`
  里的 `tf`，那份索引只有**常驻服务**会建（本进程只读）。所以刚装好、服务还没建过索引时问 `tool_fails`，
  它会如实回 `rows: []` + `agents[].unknown = turns`，并在 `notes` 里说明"还没索引到" —— 那不是"零失败"。
  常驻服务建好那份索引后，两边共用同一份数据目录，这里立刻就看得见了。

### 不装客户端怎么验

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"overview","arguments":{}}}' | node mcp-server.mjs
```

stdout 一行一条 JSON-RPC 消息，stderr 是诊断。回归见 `test/mcp-test.mjs`（协议/工具面/容错/只读/新鲜度/stdout 纯净六段）。

## 作为 DSH 插件接入（`plugin/`，I11）

第三种载体：装进 DeepSeek Harness（DSH），在宿主左侧栏拿一个图标、中间栏占一整块面板。与 CLI 载体**并存、共用同一个数据目录**，读的还是那 22 家本机日志；`parsers/`、`archive.mjs`、`search.mjs` 与页面文件都是同一批，插件只是**装配层**（`plugin/plugin.mjs` 服务端壳 + `plugin/client.js` 客户端垫片）。

### 装与生效

```
dsh plugin --profile desktop add "@yxzpro/agent-acta"                       # npm 包名（已发布）
dsh plugin --profile desktop add "git+https://github.com/elegant01/agent-acta.git#v2.14.7"
dsh plugin --profile desktop add "file:C:/绝对路径/yxzpro-agent-acta-2.14.7.tgz"     # 或直接给包
dsh plugin --profile desktop list                                             # 看装没装上
```

`dsh plugin` 的参数逐字转发给 pnpm（认 registry / git / tarball / path 四态），**开发期不用发版**：`link:<绝对目录>` 也能装（只拒相对路径）。三条纪律：

- **改代码必须彻底退出 DSH 再启动**，只关窗口无效（宿主有模块缓存）。
- URL 里的 `#` 在 Git Bash / PowerShell 要整条加引号；`github:` 缩写认的是 GitHub，本仓库在 AtomGit 得写全 `git+https`。
- 图标不出现有两类原因，别再怀疑「路由没挂上」：① 宿主按 semver 判兼容性，不匹配**只进 `skippedBundles`、不报错**；② `dsh.client.inject` 必须列出声明目标 slot 的宿主包（`@deepseek-ai/dsh-client-ui-sidebar` / `-layout`，已在本包写好），少了它服务端路由、client 模块、两条 `slots.register` 全都「成功」而图标就是不出现。

本项目以 **MIT** 许可发布（`LICENSE`）。npm 上的名字是 **`@yxzpro/agent-acta`** —— 裸名 `agent-acta` 发不出去：npm 的相似性规则判它与已存在的 `agentacta`（Miraj Chokshi 的同类项目，2026-02 首发，MIT）太像，`PUT` 时直接 403 并建议改用作用域名。⚠ **这只改 npm 标识与 DSH 的 bundle 名**：CLI 命令仍是 `agentacta`，仓库名、面板标题、`/api/agent-acta/*` 那些 URL 都没动。发到 npm 之后装法可以直接写包名 —— `dsh plugin --profile desktop add "@yxzpro/agent-acta"`，这也是社区目录 `awesome-dsh-plugin.com/plugins.json` 里主流形态（4392 条中 2264 条走 npm 包名、1903 条走 `github:` 简写、`git+https` 全形式 0 条先例，详见 `DSH-PLUGIN-PLAN.md` §8.9）。代码里没有任何网络出口，也不上传日志内容：它只读你自己机器上那些 agent 已经落盘的文件。
**已发布（2026-09-30）**：`@yxzpro/agent-acta@2.14.4` 在 npmjs 上公开可读（匿名 `GET` 包文档 200、空目录 `npm i @yxzpro/agent-acta` 实测装到 `plugin/` 三件齐、两个 bin 都在）。⚠ 镜像同步有先后：实测腾讯云镜像已能回源，**npmmirror 当时还是 404** —— 装不上就显式带 `--registry=https://registry.npmjs.org/`。

### 面板给什么内容：每次请求现判（09-30 由「装载时二选一」改成代理）

插件对 `127.0.0.1:14570` 的探测是**每次请求**做的（环回探测约 1ms，结果缓存 2 秒），不是装载时定死：

| 14570 | 行为 |
|---|---|
| 在跑 | **代理**：入口/资产/API 全部转给那个服务，上游递出来的 HTML、JS、CSS 再过一遍 `rewriteRefs`（代理过来的面板若不改写，在 iframe 里照样白屏）；`/api/events` 走**流式**透传（缓冲整条流等于把实时推送做成轮询）；POST 的 body 要转出去，写操作才有效；转的时候 `host` 换成上游、剔掉 hop-by-hop 与 `content-length`。本机仍然只有它那一个扫描器 |
| 没在跑 | 插件自己 `start({ mode:'hosted', listen:false })`：扫描 / 落索引 / SSE 心跳照跑，但不监听端口、不写 pid、不挂空闲自停 |

CLI 中途退出时插件**自己接手**（2026-10-09 改判）：`api`/`entry`/`asset` 三支每支都现判 —— 本机 hosted 已起就直接用，CLI 在跑就代理，两边都没有就 `startHosted()` 再接着用（用在途 promise 收口，SSE 重连 + 快照轮询 + 资产一起撞进来也只 start 一次）。原先这里是一页带按钮的「命令行服务已退出」，点 `POST /api/agent-acta/takeover` 才起 hosted，理由「自动起可能和用户又把 CLI 起回来撞成两个写者，这个决定留给人做」—— 但装载那一刻做的本来就是同一件事，拦在按钮上只是多一次点击，于是撤了。接手后 `local` 一直是 true，把 CLI 起回来也不会换回代理（要换回得重启 DSH）。上游不在时代理回 **502**（不是 500、也不把插件弄崩）。
注册数因此是 **108** 条（`ROUTES − DENY + EXTRA + 静态`，EXTRA = 入口 / 资产两条）。时序验收在 `test/plugin-takeover-test.mjs`（假上游 → 关掉 → 下一条请求要递出真面板，不是说明页）。

### 为什么面板不是「打开一个 URL」，以及静态资源为什么要中转

宿主前端在 `dsh-app://app` 这个协议下，**只有 `/api/*` 被代理到宿主 `webServer`**，别的路径当宿主自己的静态资源处理。所以：

- iframe 的 src 只能写 `/api/…` —— 入口是 `/api/agent-acta/entry`，由它**同源递出面板 HTML**（借 core 的 `/` 路由，占位符注入仍是那一份实现）。早先试过「入口 302 到宿主 http 口」，在 iframe 里是跨源、被拦成空白，已废。
- 页面里 `/page/…`、`/vendor/…` 那 23 处绝对引用在浏览器侧到不了（**curl 宿主 http 口是 200，会骗人**）⇒ 递送时把「紧跟引号」的这两类前缀翻译成 `/api/agent-acta/asset?p=page/x.js`，由这条中转路由换回原路径交给 core 的 `routePageFile` / `routeVendor`（防穿越、MIME、no-store 只有一份）。只认引号后面那一处，所以注释与报错文案不动，而 `page/shared.js` 里 `'/vendor/svg/' + name` 那种运行时拼接照样覆盖。
- 静态文件**必须逐条 `exact` 注册**（宿主的 `prefix` 注册不报错、但请求根本不进 handler），清单是启动时**递归**列出来的 78 个（`page/` 18 + `vendor/` 60，含 `vendor/svg/` 54 个图标）—— 加新文件要重启 DSH 才认。
- 重复的 `(kind, path)` 在宿主是 **throw + 先注册的赢**，所以入口与资产这两条在自己的循环里先 `continue` 再单独挂 handler。
- **绝不注册 `exact /`**：宿主的认证兜底挂在 `/`（壳启动拿 `GET /?token=` 换 303 + set-cookie），exact 优先于兜底 ⇒ 插件抢了它，DSH 每次开机 `Desktop Host authentication failed`。`'/'` 已在 `HOSTED_DENY` 里，`test/plugin-hosted-test.mjs` 有一条专门守它。

### 宿主里刻意不存在的四条路由

`/api/shutdown`（原义=退出进程）、`/api/client`（spawn Electron 悬浮卡片壳）、`/api/trae/capture-key`（会弹 UAC）、`/widget`（卡片页）。它们在 core 的路由表里照旧留着给 CLI 用，只是不往宿主注册 —— 否则一次误触会用掉用户的 DSH。顶栏那颗「悬浮卡片」按钮跟着一起藏：入口 src 是 `/api/agent-acta/entry?dsh=1`（iframe 的文档 URL 就是它，两支都不用把查询串转给上游），`page/topbar.js` 的 setup 读 `location.search` 得 `isDsh`，按钮挂 `v-if="!isDsh"` —— 否则点了只剩一句「唤出失败」。Origin 闸在 hosted 下不再拿「端口等于 14570」当同源标识（宿主端口每次动态），改收「http(s) + 环回主机名（端口不限）」与 `dsh-app:`，且**只管写操作**，与 CLI 同口径。

### 边界与回归

不跟宿主明暗切换（面板是自家深色皮，且实测注入 `--dsw-alias-*` 也零变化）；不唤起悬浮卡片（连顶栏那颗按钮都不渲染）；无网络出口。验收：`test/plugin-delivery-test.mjs`（静态：改写覆盖 / 产物可达 / 白名单挡穿越）+ `test/plugin-hosted-test.mjs`（隔离端口 14631 + `mkdtemp` 数据目录里驱动 `apply()`：108 条注册、`exact /` 不在表里、入口 200 非 302、资产与图标真取到、Origin 闸、不写 pid、卸载撤干净）+ `test/plugin-takeover-test.mjs`（隔离端口 14637：假上游在跑时走代理、关掉之后下一条请求要静默接手并递出真面板），三者都在 selftest 的 `cli` 组；老 CLI 那一面由 `test/cli-behavior-guard.mjs` 七类不变式守着。宿主侧逐条取证与推翻记录在 `DSH-PLUGIN-PLAN.md` §8。

## 解析器自检（侧栏「解析器自检」/ `GET /api/selftest`，R32）

`test/` 下攒了三四十个回归脚本，改完一个解析器想知道有没有弄坏邻居，从前得挨个敲、挨个看终端。
这一条把它们收成**一份机器可读的结果**，页面只负责把那份结果讲实话。两件事分开：

| 谁 | 干什么 |
|---|---|
| `node test/selftest.mjs`（终端） | **唯一会跑测试的东西**。串行跑完选中的脚本，把结果写进 `~/.agent-acta/selftest.json` |
| 服务端的 `GET /api/selftest` + 侧栏弹层 | **只读那份文件**，加上「多旧 / 出自哪版代码」三个标注（`ageMs` / `sameBuild` / `sameParserRev`）。服务端不 spawn 任何测试子进程 |

为什么不做成页面上一个「跑一遍」按钮：一轮默认清单要串行起停二十来个服务、跑两分钟，这种副作用挂在弹层上
就没人敢刷新了；跑的节奏得由人在终端里定。也不在这一页里「拿真日志重解析一遍」—— 那是
`agentacta --doctor` 的活（见上面「自检」一节），两边各答各的问题。

### runner 的三条口径

- **串行，绝不并行**：脚本里的端口是硬编码的，但已做到**全 `test/` 唯一**（14589–14658 那一带 + 14677 + 14690–14703，
  外加 `mimocode` 的派生号 `PORT+1`）；另有 `%TEMP%\dsh-home` 这类固定名临时目录 —— 仍是串行跑的理由：
  两条会话同时跑同一批脚本，哪怕端口不撞，也会互相**改写对方的隔离 HOME / 数据目录**。
- **成败只认退出码**：这些脚本没有统一的 JSON 结果协议，末行文案还有八个都是「✓ 全部通过」，光看文字分不出是谁。
  超时、被信号打死、脚本自己 `exit 1` 三者**判得分开**（超时不是「解析器坏了」，报错了要说清是哪一类）。
- **默认清单必须不依赖仓库外的东西**：要 `../dist` 历史包的、要真实 `~/.dsh` 的、靶子是常驻 14570 的，
  全部另立分组、**默认不跑**，并把「为什么不跑」随结果一起写出去（页面据此解释「为什么这里少了一类测试」）。
  名字里带 `probe` / `bench` 的那几个连失败概念都没有（找不到目录也退 0），永久排除 —— 一个永远绿的检查比没有检查更糟。

```bash
node test/selftest.mjs                    # 默认组：static / parser / cli，约两分钟
node test/selftest.mjs --only page        # 前缀或标题里含这个词的都算命中
node test/selftest.mjs --group parser     # 只跑一组
node test/selftest.mjs --all              # 连默认不跑的组一起跑（要看本机脸色）
node test/selftest.mjs --json             # 结果 JSON 同时打到 stdout
node test/selftest.mjs --timeout 60000 --out /tmp/r.json   # 单脚本超时 / 换落点
```

新加脚本必须登记进 runner 的 `SUITES`（分组 + 一句话标题；非默认组还必须写 `why`）——
没登记的脚本 runner 会在开头点名警告，`test/selftest-contract-test.mjs` 还会把它判成红。

### 结果文件为什么在 `~/.agent-acta/` 而不是仓库的 `test/` 下

`npm pack` 的 `files` 不含 `test/`，而常驻服务跑的正是全局安装那一份（`agentacta --where` 可看路径）。
路径要是跟着代码目录走，服务读到的永远是「还没跑过自检」。跟着 `HOME` 走，源码树里的 runner 和全局包的服务
才读到同一个文件。代价是**它记的是「哪一版代码、什么时候跑的」**：改了代码后旧结果照样在，
所以页面必须拿 `sameBuild` 警告，不能让人把上一版的绿当成这一版的。

### 页面上每一栏的意思

- 顶部黄条：结果出自另一版代码（`sameBuild:false`）。若 `sameParserRev` 仍为真，会补一句「口径倒是没变」。
- 「这次没跑的 N 项」：按分组列出，每条带 runner 写下的 `why`。这一栏在，页面才不会把「默认清单全绿」说成「测试全过了」。
- 不绿的行：把脚本里带 `✗` 的那几行原样摊开（最多 12 条），另有末行摘要与退出码。
- 「断言红 / 超时 / runner 没收住」三种红分开标：处置方式完全不同 —— 前两个查代码，最后一个查环境。

回归：`test/selftest-api-test.mjs`（接口的透传 / 版本章 / 年龄 / 没跑过与读不动分得开）、
`test/selftest-contract-test.mjs`（runner 自己的四条口径，含一条「真红必须判成红」的替身演）。

## 跨平台（mac / Linux / 鸿蒙 PC，R34）

**一句话**：解析与展示那一半本来就与平台无关，平台相关的只有「去哪些目录找日志」和少数几个平台专属动作。
开发机是 Windows，所以 mac / Linux 的路径分支是靠 `test/platform-test.mjs` **注入 platform/home/env**
钉住的（能在 Windows 上跑），不是靠读代码猜 —— 端到端的真机验证仍未做过，见本节末尾「验证边界」。

### 与平台无关的那一半

- **全部解析器**：只认文件内容，不碰路径分隔符、不调平台专属 API（`parsers/discovery.mjs` 头部的承诺）。
- 索引分片、归档文件、页面、HTTP API、SSE、MCP 工具面 —— 都是平台无关的读写与格式。
- `--open` 按平台走 `start` / `open` / `xdg-open`；`--client` 的 Electron 运行时按平台装（`electron.exe` / `electron`，
  首次执行时由 `npm install electron@44` 拉当前平台的预编译包）；`--stop` 只在 win32 调 `taskkill`，POSIX 走信号。
  hook 安装（`--install-hooks`）写的是 `node "<自身路径>" --ensure`，路径统一成正斜杠，两个平台都吃得下。

### 平台相关的那一半：候选根目录

`parsers/discovery.mjs` 的 `basesFor()` 是**唯一**按 `process.platform` 分支的地方：

| 平台 | 除各名字的 `~/.<name>` 外还铺 |
|---|---|
| `win32` | `%APPDATA%\<name>`、`%LOCALAPPDATA%\<name>` |
| `darwin` | `~/Library/Application Support/<name>`、`~/.config/<name>` |
| `linux` / 鸿蒙 PC / 其他 POSIX | `$XDG_CONFIG_HOME`（默认 `~/.config`）`/<name>`、`~/.local/share/<name>` |

几条**只在特定平台**才铺的补丁路径：doubao 的 `%LOCALAPPDATA%\DoubaoWork\…\workspace` 仅 win32；
opencode 的 `~/.local/share/opencode` 与 minimax 的 `~/.minimax/v2/sessions` 三平台都补（它们本来就长这样）。

### 平台专属能力（不是 bug）

- **trae 的 SQLCipher 密钥抓取只有 Windows**（`tools/grab-trae-key.ps1` 是 PowerShell 脚本，服务端 `traeCaptureSupported()`
  直接判 `win32`）。mac / Linux 上 trae 退到 `renderer.log` 那条路：轮次、耗时、工具照常，**token 与 AI 正文拿不到**。
- **doubao** 的自动发现只在 Windows 补那条深路径，别的平台要手工添加。

### 换机器 / 换平台：整个 `~/.agent-acta` 搬过去会怎样

三份状态各有各的自愈方式，都是**载入时按本机磁盘校验**，不需要手工清：

| 状态 | 搬过去之后 |
|---|---|
| 扫描索引 `index/<kind>.json` | `loadIndex` 恢复每条 state 前 `statSync` 校验 `mtime/size`，对不上就丢弃让它重扫（老代码就有） |
| 全文索引 `search/<kind>.json` | **R34 新增**：载入时按 `sourceAlive` 剪掉「源不在本机」的记录（记录是按绝对路径认人的，跨平台一整片对不上），剪掉的条数进日志与 `/api/search/status.pruned`；盘上那份借下一次落盘清干净 |
| `config.json` 里的 agent 根 | `source: auto` 的会自己摘掉再重新发现；**手工加的一直留着**（0 条），`--doctor` 会点名，且 R34 起会额外提示「这是 Windows 的路径形态，而当前平台是 darwin，像是从别的平台搬过来的配置」 |

`widget-runtime/` 里那份 Electron 是**按平台编译**的：搬到 mac 上找不到 `dist/electron`（只有 `electron.exe`），
`--client` 会自动重装一份当前平台的，不用手工删。`archive/` 是自描述的（`manifest.json` + 按天 JSONL，
详情快照就在里面），换平台照样能翻。pid 文件不作数（判活一律以端口为准）。

### 文件权限（POSIX 才有的问题）

这三处落的都是**明文对话**（归档是完整快照、全文索引是正文、扫描索引是元信息与路径）。R34 起在 POSIX 上
按私有建 —— 目录 `0700`、文件 `0600`（win32 上 `mode` 无副作用，那边的 `chmod` 只管只读位）：

| 位置 | 权限 | 老文件 |
|---|---|---|
| `search/` | `0700` / `0600` | **写的时候顺带 `chmod` 收回来**（它是缓存，没有共享的用法） |
| `index/` | `0700` / `0600` | 不动（`writeFileSync` 的 `mode` 只对新建文件生效） |
| `archive/` | `0700` / `0600` | 不动 —— **刻意的**：归档是用户可见的数据，有人可能故意放在共享位置让同事读或在网络上备份，悄悄改老文件会砸掉那种用法 |

`writeFileSync` 的 `mode` 只对**新建**的文件生效，所以早先版本写下的 0644 分片/归档不会自动转过来；
想一次收干净：`chmod -R go-rwx ~/.agent-acta`。macOS 的家目录默认就是 0700，这三处在 mac 上本来也不暴露。

### 验证边界（如实说）

- 已在**真机验证**的：Windows（本项目的开发与日常使用平台）。
- 未被真机验证、但有测试钉住的：darwin / linux 的候选目录展开、别名、平台归属判定、换平台的索引剪枝
  —— `test/platform-test.mjs`（37 条断言，随默认回归清单跑，任何平台都能跑）。
- **测试脚手架本身已不是 Windows 专有的**（R34 补的一遍）：
  - 隔离用的目录链接统一走 `test/lib/iso.mjs` 的 `linkDir()` —— win32 上等价于 `mklink /J`（同样不需要
    管理员权限），POSIX 上就是普通目录符号链接。此前 4 个脚本直接 spawn `cmd /c mklink`，mac/Linux 上必然失败；
  - `import.meta.url` 取路径统一成 `fileURLToPath()`（34 个脚本）。此前有两种写法，其中
    `…pathname.replace(/^\//, '')` **在 POSIX 上就是错的**（把开头的 `/` 当盘符前缀剥掉，得到相对路径，
    spawn 出去的服务根本起不来）；另一种只是碰巧对，但走 URL 的 `pathname` 遇到带空格或中文用户名的
    路径会被百分号编码。这一条在换机后是高发场景；
  - 「跨卷搬迁」那条用例原先写死 `D:\`，改成按 `st.dev` 找一块**真的与家目录不同设备**的卷
    （win32 试 D:/E:/F:，POSIX 试 /Volumes、/media、/mnt），找不到就打印原因跳过，而不是默默不跑；
  - `platform-test.mjs` 第 6 段是一条静态体检：**用到 `linkDir` / `fileURLToPath` 却没 import 的脚本直接点名**。
    加它是因为这类错 `node --check` 拦不住（那是语法检查，这是运行到那一行才炸的 ReferenceError），
    而 real / release / slow / none 四组的脚本默认清单里不跑 —— 今晚这两类各栽了一次，都是慢组/真机组才炸。
- 仍未验过的：mac / Linux 上的端到端（首扫、各 agent 解析、页面、桌面卡片）。上面这几刀是**把已知的
  平台专属机制拆掉**，不等于真机跑过 —— 第一次在 mac/Linux 上跑 `node test/selftest.mjs` 时，
  要按「第一次上这台机器」的心态看待结果。

## 常见问题

**先跑 `agentacta --doctor`**
它一次列出配置 / 目录 / 索引 / 端口版本 / 页面文件 / 归档的现状，带 `[fail]`/`[warn]` 的行就是该看的地方，
整段贴出来也省得来回问版本。下面这些症状大多能先在它那几行里看出方向。

**想知道哪个 agent 最占磁盘、清理该动哪里**
侧栏「磁盘占用」（口径见上面「磁盘占用」一节）。它把散在三处的占用合成一张表：各 agent 的日志根
（库类连 `-wal`/`-shm`）、`index/` 分片、`archive/` 日期文件，外加 `~/.agent-acta` 的顶层构成
（桌面卡片那份 Electron 运行时经常是最大的一项）。**这一页只统计不删除**，删哪一处自己判断；
如果它标了「统计到一半」，说明目录大到超了遍历预算，那行的数只当参考。

**页面打不开 / 一直「重连中…」**
先 `curl http://127.0.0.1:14570/api/ping`。无响应说明服务没起来：跑一次 `agentacta --ensure`
（没走 npm 就 `node <本目录>/agent-acta-server.mjs --ensure`）；
仍不行多半是 `node` 不在 PATH（`node -v` 确认）。

> **刷新时先看到一个会呼吸的绿方块 +「正在加载 AgentActa…」是正常的**：那是页面在等 `vendor/` 下的
> vue / element-plus 加载完（本机一闪而过）。**超过 8 秒**它会定格成灰色方块、文字变红写着
> 「页面没加载起来 —— …（多半是 /vendor 下的脚本没取到）」——真看到这句就按 F12 看控制台的 404，
> 再刷一次通常就好。（这段占位只存在于 Vue 挂载之前，挂载完自动消失。）

> **首扫期间页面不再「重连中…」**：服务一监听端口就先放行就绪闸门（旧索引数据立刻可查），
> 首扫拆成一小片一小片跑、每片之间让出事件循环，进度通过 SSE 的 `scanning` 事件推给页面。
> 所以首屏立刻就有内容，右上角显示**「扫描中 N/M（当前 agent）」**，扫完自动变成「实时更新 · Ns」；
> 列表一时为空时写的是「正在扫描…（N/M）」，不是「暂无匹配的请求记录」。
> 本机实测（约 4700 条）：从端口监听到页面连上 SSE ≈0.15~0.2s、看到首批数据 ≈0.2s，
> 首扫整轮 ≈4.2s、热启动（有索引）≈0.9s。慢只影响「N/M 走到头」的时间，不影响能不能看、能不能点。

**codex 的「用户输入」那一栏一直是空的**
已经修了（1.8.2 起）：Codex Desktop 的较新会话把用户输入写在 `event_msg` / `item_completed` 里，
而不是老的 `event_msg` / `user_message`，早先只认后者。**两版 `cli_version` 相同也可能是不同写法**，
所以是按事件形状认、不按版本号认，两种形态并存。看到这个症状先确认服务是新版；
仍是空的就把那份 rollout 发给开发（判断口径见 `LOGFORMATS.md` 的 codex 一节）。
注意这类会话里**轮次、token、耗时、AI 输出都是正常的**，只有用户输入这一格塌了，别误判成整条记录坏了。

**某个 agent 一直是 0 条**
打开侧栏「环境诊断」（或 `curl http://127.0.0.1:14570/api/diagnose`）：它逐个列出每个候选 agent 的每条候选路径，
以及没认出来时该目录里长什么样。三种判定要分清——**已接入**是正常；**目录在但未识别**说明日志就在本机、
只是还没写解析器（照着它给出的路径补一个）；**已由 xxx 接入**是同一份目录被另一个 agent 接了，不是故障。

**trae 看不到 token / AI 正文 / 逐次调用**
这是回退态：库没读到（没配 `traeKey`、密钥不对、或库正在被重写），服务退回了 `renderer.log`（只有事件骨架）。
诊断页会写明原因；按「Trae 的 SQLCipher 库」一节抓一次密钥（每台机器各自一把），配好后 trae 立刻读库、卡片变完整。

**侧栏写着有几十条，点进去却是空的 / 「都早于当前加载的窗口」**
以前会这样，现在不会了：**窗口跟着你选的东西走**——「2000 条/页」在选中某个 agent 或某个项目时，
指的是**它自己的最近 2000 条**，而不是「全局最近 2000 条里属于它的那些」。
所以停更的 agent（比如停在 8 月的 gemini）、只留旧日志的项目照样点进去就有内容。清空筛选（或点侧栏「全部」）即恢复全局窗口。

> 老日志「整组落在窗口外」的那种提示已经彻底删掉了——列表为空 = 真的没有，不再有第二种含义。
> 选 agent 与选项目可以叠加（两个都选 = 同时满足）。

**项目下拉里出现了「（N 种写法）」**
不是脏数据：同一个项目的路径被不同 agent 写成了不同样子（大小写盘符、盘符与分隔符退化成 `-` 的 slug），
下拉按「去掉所有非字母数字后是否相同」把它们并成了一项，显示名取**条目最多**的那个写法，鼠标悬停可看全部写法。
点这一项 = 选中该项目的**所有写法**。卡片页脚的路径仍是各家写进去的原样，方便排查。

**重启后要不要全量重扫**
不会。带增量偏移的格式（atomcode/claude/codex/codearts/codebuddy/workbuddy）会把偏移持久化，重启只读新增部分。
gemini 与 cursor 例外：它们按 `{mtime,size}` 签名判断要不要重解析（没变就跳过整个目录）。
gemini 是整文件重写、没有偏移语义；cursor 是追加式但「后到的 assistant 行会挂到当前那一轮上」，
用增量偏移极易把最后几轮算重，而单份转录只有几十 KB，整份重读更可靠。

**atomcode 的卡片写着「N 次 LLM」，点开却没有调用明细**
正常，不是坏了：那份逐次账在 **datalog** 里，而它**默认关闭**（`~/.atomcode/config.toml` 的 `[datalog]`，
键是 `enabled` 和 `dir`；本机实测这个 `dir` 可以是别的盘）。没开、或者这一轮早于开启时间，
都只有轮级汇总——详情里会直接写一行说明是哪种。面板不去改你的配置：想开自己开，
开完**只对新轮生效**（旧的不会补写）。

**codebuddy 某一轮的 token 比它自己记的少**
个别轮次里 `turn-metrics.tokenDelta` 会大于该轮所有已落盘调用的用量之和（全量抽样约 62/431 轮）——
大概是有些调用没写进会话文件。面板报的是**可核对的逐次调用之和**，`turn-metrics` 只用来取轮级耗时。

**用了 CodeBuddy CN（或 VSCode / JetBrains 里的 CodeBuddy 插件），`codebuddy` 那一行却一条都没有**
先去看**环境诊断里 `codebuddy` 那行的「额外根」**，别去 `%APPDATA%\CodeBuddy CN` 找 —— 那个目录只有
IDE 壳自己的 Electron 缓存（Cache / Backups / DIPS / state.vscdb），**会话正文一条都不在那儿**。
插件形态的正文在 `%LOCALAPPDATA%\CodeBuddyExtension\Data`，服务把它挂成 `codebuddy` 的第二个根
（不是新开一行 `codebuddy-ext`：同一个 CodeBuddy 拆两行会把同一个项目的历史劈成两半）。
那行 note 会写成 `buddyjsonl · 885 条（含 genie 扩展 314 条）`，括号里的数字就是第二根贡献的；
**没有这个括号**才说明这台机器上真没装扩展，或 `Data/<acct>/<Host>/history/` 那三层结构不齐。
另：`Data/Public/auth/` 是 CodeBuddy 自己的凭据文件，解析器按结构判据挡在门外，一个字节都不读。

**验 hook 时 `atomcode hooks test agent-acta | grep …` 卡住不返回**
不是 hook 卡了，是**管道卡了**：服务子进程是 `detached` 被拉起来的，它会把 hook 进程 stdout 管道的写端一直攥着，
于是任何等 EOF 的消费者（`| grep`、`| tail`、命令替换）都要等到服务退出为止——而服务默认是**永不退出**的（空闲自停需手动开）。
把 hook 输出**重定向到文件**再看即可，本机实测 0.8s 返回、`Duration 357ms / SUCCESS`：

```bash
atomcode hooks test agent-acta > /tmp/hook.txt 2>&1; grep -E "Duration|Status" /tmp/hook.txt
```

真正要看的是「服务有没有被拉起来」，直接跑 hook 那条命令再探端口最实在：

```bash
agentacta --stop && node <本目录>/agent-acta-server.mjs --ensure && curl http://127.0.0.1:14570/api/ping
```

**端口被占**
服务自身检测到 `EADDRINUSE` 会静默退出（幂等），不会起两个实例。

**想把它停掉**
`agentacta --stop`。服务本身没有常驻控制通道，这是唯一的停止入口：先 POST `/api/shutdown`
（会落盘索引再退，本机实测 ~0.3s），老版本实例没有这个接口，才退化为按监听 pid 强杀（约 5s）。
不想手动停就开「空闲自停」，或干脆让它挂着——它只读文件，不占 CPU。

> ⚠️ 实测补齐：`/api/shutdown` **不保证进程立刻退干净**。曾出现 4 个残留进程继续占着端口，
> 下一次启动时被它们挡下（日志写「端口 X 上的服务是另一版…本次未启动」）并**连到旧实例**——
> 而旧实例跑的是旧代码，于是「新接口 404、新字段 undefined」全都冒出来，排查时很容易得出相反结论。
> 判断端口上到底跑的是哪一版，一律以 `agentacta --where` / `GET /api/version` 的 `build` 指纹为准。

**改了源码，刷新页面却没变化**
先确认「端口上跑的到底是哪一份」——`agentacta --where` 打印的是 **`agentacta` 这条命令**会用哪一份，
而服务也可能是被 hook 直接拉起的**源码**那份（本机就是这样：`~/.claude/settings.json` 里的 hook 是
`node "F:/centos/AgentActa/agent-acta/agent-acta-server.mjs" --ensure`，
服务脚本内容一变就把在跑的重启成源码版）。判据取进程命令行，或比对 `GET /api/version` 的 `build`
与两份脚本各自的 SHA1。

服务只从**自己脚本所在的目录**读 `agent-acta-page.html`、`page/`（页面拆出的 `style.css` 与各 `*.js`，2026-09-21 R25 批 0 起）和 `vendor/`，所以「服务跑哪份，页面就是哪份」。
反过来：**改页面（含 `page/` 下的文件）只要刷新浏览器**（都是每个请求现读、`no-store`），**改服务端才需要重启**。
⚠️ 只改了 `page/` 下的文件时 `build` 指纹**不变**（BUILD 只哈希服务脚本），页面顶部不会立刻报版本不一致；
新开的标签页会拿到新文件，**开着的旧标签页等 SSE 重连时才会出现「页面文件更新过…刷新一下即可」的红条**（比对的是第二枚指纹 `pageBuild`）。

⚠️ 两个容易踩的坑：
- `agentacta` 这个 npm shim 指向**全局安装副本**（`%APPDATA%\npm\node_modules\agent-acta\`，真拷贝）。
  端口上跑的若是源码那份，**单独执行 `agentacta --ensure` 会把服务换成旧副本**（版本号可能一样，
  `build` 指纹不同，于是「新接口 404、新字段 undefined」一起冒出来）。要重启就统一走源码：
  `node <源码目录>/agent-acta-server.mjs --ensure`；或先 `agentacta --stop`，再用同一条源码命令起来。
- 想让全局装成软链、改完即时生效：`npm i -g <源码目录>`（等价 `npm link`，不留副本）；
  发版给别人则用 `npm pack --pack-destination ../dist` + `npm i -g ./../dist/<新包>.tgz`
  （落点固定在**仓库外**的同级 `../dist` —— `test/pack-smoke.mjs` 找的就是那里，`.gitignore` 也把
  仓库内的 `dist/` 挡了；别在仓库里打包。装的时候那个路径**必须带 `./`**，否则 npm 把它当 git 地址去 ssh 拉）。

**「按会话浏览」里有的会话没有时间轴**
正常，不是解析漏了 —— 但**原因不是「这些 agent 的日志里没有时间戳」**（早先这么写过，是错的）：
claude / codebuddy / gemini 的日志里**就有**逐行时间戳，解析器也**已经**拿它算出了每次 LLM 调用的真实耗时，
只是**算完没留成一条事件流**。逐事件流水目前只有 dsh / zcode / trae 的解析器做了保留：dsh 的原始事件流里本来就有
`step/start|end`、`assistant/message.stream[]` 的逐块时间戳、`tool/call` → `tool/result` 的起止；
zcode 则是 `model_usage` / `tool_usage` 表里本来就记着每次调用的真实起止（含 TTFT）；
trae 走库里的开轮/收轮与 `timing`（工具真实起止），但 llm 事件源头没有流式分段，dur 恒 0。
其余 agent 的会话在详情顶部会有一条说明，轮次退回「LLM 调用明细 + 工具调用」两块渲染
（**codex / kimi 连逐次调用耗时都拿不到**，时间列才显示 `—`）。判断依据是 `/api/sessions` 返回的
`hasTimeline`（服务端算的，本质是一份**能力名单** `EVENT_AGENTS`），页面不硬编码 agent 名单 ——
将来别的 agent 补上 `events` 会自动生效（页面另有一道自纠正：真加载到 `events` 就不显示那条说明）。

**想用 chrome-devtools MCP 量页面 DOM / 点控件，但连不上浏览器**
先确认浏览器那边开着**远程调试服务**：Chrome 地址栏进 `chrome://inspect/#remote-debugging`，
把里面的 remote debugging server 打开（Chrome 144+ 才有这个开关；`chrome-devtools-mcp --autoConnect` 依赖它）。
只给 Chrome 加 `--remote-debugging-port` 启动参数**不是**这个开关，是两回事。
没开时 MCP 的 `new_page` / `evaluate_script` 会连不上，而页面本身是好的——
`curl http://127.0.0.1:14570/` 能拿到 HTML 就说明服务侧没问题。
