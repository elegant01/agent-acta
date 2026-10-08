// 会话视图（R25 批 3）：左栏会话列表 + 右栏逐轮轨迹 + 逐轮用量图 + 概览条 + 轮详情。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 为什么这里**不像弹层那样把数据搬进组件**（批 1 的先例在此不适用，是刻意的）：
//   这个视图是 `v-if`（不变式写着「sess 视图是 v-if，自己两栏内滚」），切去「请求日志」就把整棵子树销毁。
//   改前那些状态活在根的 setup 里，所以切回来还留着选中的会话、已展开的轮和 /api/entry 缓存
//   （列表另有一支 watch(view) 会重拉）。数据若搬到组件肚子里，这一份状态就跟着子树一起没了 ——
//   「切个视图丢光展开」是行为变化，纯重构不许。故本组件与顶栏/侧栏同类：**状态全留根，props 收数据、emit 发动作**。
//   props 面宽（30 多个）是 R25 评审时就接受下的代价（文档：「props 面过宽 → 接受，不做自动注入魔法」）；
//   换来的好处是 page-check 能逐个标识符盯住模板 ↔ 可用面，换成一个 `inject` 的状态口袋就全瞎了。
//
// 三个 v-model 式回写（sess-search / sess-sort / sess-chart-open）的事件名走 kebab，
// 靠 Vue emit 的 camelize 兜底对上根里的 onUpdate:xxx（批 2 实测过的那条）。
window.AACTA = window.AACTA || {};
AACTA.SessView = {
  name: 'aa-sess-view',
  template: `
    <main class="main sv-main">
      <aside class="sv-side">
        <div class="sv-side-head">
          <el-input :model-value="sessSearch" @update:model-value="v => $emit('update:sess-search', v)" size="small" clearable placeholder="搜索会话 / 项目 / 模型…" :prefix-icon="searchIcon"></el-input>
          <div class="sv-side-row">
            <span class="sv-side-n" title="列表跟随左侧的 agent / 项目 / 时间范围收窄（服务端 /api/sessions 与 /api/daily 同口径）">{{ sessListFiltered.length }} / {{ sessList.length }} 个会话<template v-if="sessListCapped"> · 只取最近 500 个</template></span>
            <el-select :model-value="sessSort" @update:model-value="v => $emit('update:sess-sort', v)" size="small" class="sv-sort" title="排序（客户端排，不重新请求）">
              <el-option label="最近活跃" value="to"></el-option>
              <el-option label="最早开始" value="from"></el-option>
              <el-option label="轮数最多" value="turns"></el-option>
              <el-option label="耗时最长" value="dur"></el-option>
              <el-option label="token 最多" value="total"></el-option>
            </el-select>
          </div>
          <el-alert v-if="sessListError" :title="sessListError" type="error" :closable="false" show-icon></el-alert>
        </div>
        <div class="sv-list" v-loading="sessListLoading">
          <div v-if="!sessListLoading && !sessList.length" class="empty sv-empty">当前范围内没有带会话标识的条目</div>
          <div v-else-if="!sessListFiltered.length" class="empty sv-empty">没有匹配的会话</div>
          <div v-for="s in sessListFiltered" :key="s._sid" class="sv-item" :class="{on: sessPick && sessPick._sid === s._sid, sub: s.parentKey}" @click="$emit('pick-session', s)" :title="s.key">
            <div class="sv-item-1">
              <!-- I16：子 agent 会话缩进 + 折线前缀。判据是**服务端算好的显式谱系**（s.parentKey），
                   不是按时间区间猜的 —— 见 server 的 sessionsAgg。认不出父的那些照旧平铺（不硬造层级）。 -->
              <span v-if="s.parentKey" class="sv-sub-branch" title="子 agent 会话（父会话在当前列表里）">└</span>
              <img v-if="agentIcon(s.agent)" class="adot-img" :src="agentIcon(s.agent)">
              <span v-else class="adot" :style="{background: agentColor(s.agent)}"></span>
              <span class="sv-item-t">{{ s.name || s.key }}</span>
              <span v-if="s.status !== 'ok'" class="tag tag-err">有失败轮</span>
            </div>
            <div class="sv-item-2">{{ s.agent }} · {{ s.project || '—' }}<template v-if="s.sub"> · 子 agent</template></div>
            <div class="sv-item-3">
              <span>{{ s.turns }} 轮</span>
              <!-- I16：子树合计只在真有子会话时显示（subSelf=false），免得每行都挂一个和本体一样的数 -->
              <span v-if="!s.subSelf" class="sv-item-sub" :title="'含 ' + s.subKids + ' 个子 agent 会话的合计'">合计 {{ s.subTurns }} 轮 · {{ fmtN(s.subTotal) }} tok</span>
              <span v-else>{{ fmtN(s.total) }} tok</span>
              <span>{{ fmtDurBig(s.dur) }}</span>
              <span class="sv-item-n">{{ fmtAgo(s.to) }}</span>
            </div>
            <div v-if="!s.hasTimeline" class="sv-item-4">
              <span class="mini-tag" title="该 agent 没有逐事件时间轴（缺的是「把逐事件留成一条流」，不是日志里没有时间戳），轮次退回 LLM 调用明细 + 工具调用两块渲染">无逐事件</span>
            </div>
          </div>
        </div>
      </aside>

      <section class="sv-cur">
        <div v-if="sessCurLoading" v-loading="true" style="min-height:180px"></div>
        <div v-else-if="!sessCur" class="empty sv-empty">从左边选一个会话，看它的逐轮轨迹</div>
        <template v-else>
          <div class="sv-head">
            <div style="min-width:0">
              <!-- I14：标题三档兜底。sessPick.name 来自会话列表（/api/sessions）；
                   sessCur.name 来自 /api/session 的会话级字段 —— 列表那一份拿不到时（如直接带 key 进来，
                   sessPick 为空）也不该退回裸 UUID。两者都无才是「这个来源没有标题」 -->
              <h1 class="sv-title">{{ (sessPick && sessPick.name) || sessCur.name || sessCur.session || '(无标题会话)' }}</h1>
              <div class="statline">{{ sessPick.agent }} · {{ sessPick.project || '—' }} · {{ sessCur.session }}</div>
            </div>
          </div>

          <div class="sess-sum">
            <span><b>{{ sessCur.count }}</b> 轮</span>
            <span>↑{{ fmtN(sessCur.tin) }} · ↓{{ fmtN(sessCur.tout) }} · 缓存 {{ fmtN(sessCur.tcache) }}</span>
            <span>累计 token <b>{{ fmtN(sumTok(sessCur)) }}</b></span>
            <!-- I12 压缩画像：会话级小结（逐轮累加），回答「一共压掉多少 / 等了多久」。
                 只有真压过才有这一格；compDrop 只有 claude 源有 ⇒ 没有就不说，不印假 0。 -->
            <span v-if="sessChart && sessChart.comp"
              :title="(sessChart.comp.auto || sessChart.comp.manual) ? '自动压缩 ' + sessChart.comp.auto + ' 次 / 手动压缩 ' + sessChart.comp.manual + ' 次' : ''">
              压缩 <b>{{ sessChart.comp.n }}</b> 次<template v-if="sessChart.comp.drop"> · 丢 {{ fmtN(sessChart.comp.drop) }} tok</template><template v-if="sessChart.comp.ms"> · 等 {{ fmtDurBig(sessChart.comp.ms) }}</template>
            </span>
            <span>总耗时 <b>{{ fmtDurBig(sessCur.dur) }}</b></span>
            <span>{{ fmtTime(sessFrom) }} ~ {{ fmtTime(sessTo) }}</span>
            <span v-if="sessCur.models && sessCur.models.length" class="sess-models">{{ modelText(sessCur.models) }}</span>
          </div>

          <!-- I16 子 agent 拓扑：这一坨的谱系。两件事分开说 ——
               ①「我挂在谁下面」（父会话，可点着跳过去）；
               ②「我下面挂了谁」（子会话清单，每个可点着跳过去）。
               数据全部来自服务端的**显式外键**（dsh 会话头 parentSession / claude 的 subagents/ 目录层级 /
               zcode·opencode 的 session.parent_id / hermes 的 parent_session_id），不是按时间区间猜的。
               两边都认不出来时整块不渲染（不占位、不写「无」）—— 与「拿不到就不印 0」同一条约定。 -->
          <div v-if="sessCur.parent || (sessCur.children && sessCur.children.length)" class="sv-tree">
            <div v-if="sessCur.parent" class="sv-tree-row">
              <span class="sv-tree-k">父会话</span>
              <a class="sv-tree-link" :title="'跳到父会话 ' + sessCur.parent" @click="$emit('open-session', sessCur.parent)">{{ sessCur.parent }}</a>
              <span class="sv-tree-note">这一坨是它派出来的子 agent</span>
            </div>
            <div v-if="sessCur.sub && sessCur.subMode" class="sv-tree-row">
              <span class="sv-tree-k">派活</span>
              <span class="sv-tree-sub">{{ sessCur.sub }}</span>
              <span class="mini-tag" :title="sessCur.subMode === 'one-shot' ? '一次性子任务（跑完就结束）' : '可续的子会话（还能接着对话）'">{{ sessCur.subMode }}</span>
            </div>
            <div v-if="sessCur.children && sessCur.children.length" class="sv-tree-row sv-tree-kids">
              <span class="sv-tree-k">子 agent</span>
              <span class="sv-tree-note">{{ sessCur.children.length }} 个会话 · 合计 {{ sessCur.subTurns }} 轮 / {{ fmtN(sessCur.subTotal) }} tok（含本级）</span>
              <div v-for="c in sessCur.children" :key="c.key" class="sv-tree-kid" :class="{err: c.status !== 'ok'}" @click="$emit('open-session', c.key)" :title="'跳到子会话 ' + c.key">
                <i class="sv-chip" :style="{background: agentColor(sessPick && sessPick.agent)}"></i>
                <span class="sv-tree-kid-t">{{ c.name || c.sub || c.key }}</span>
                <span class="sv-tree-kid-n">{{ c.turns }} 轮 · {{ fmtN(c.total) }} tok</span>
                <span v-if="c.subKids" class="mini-tag" :title="'它还挂着 ' + c.subKids + ' 层后代会话'">+{{ c.subKids }}</span>
              </div>
            </div>
          </div>

          <!-- 逐轮用量图：模式由**数据**决定（sessChart 的注释），不按 agent 名硬编码 ——
               token 系画「缓存+输入+输出」堆叠柱，线**只有一根**：拿得到窗口容量的会话画上下文占用率
               （0–100 绝对刻度，顶格＝满窗），一根都没有就退回耗时折线；qoder 画积分柱 + 上下文占比线。
               压缩红点两种模式通用（谁落了 compacts 就点谁），无分母时落基线画空心。
               压缩数据自 I12（2026-09-28）起 claude 与 qoder 都会落（tooltip 带自动/手动、丢多少、等多久）。
               全 0（cursor 这类源头就没有用量）时 sessChart 为 null，整块不渲染（卡片上已有「无用量」说明，
               画一排 0 没有意义）。横轴是轮次序号（等宽），真实时间轴在下面概览条里，两图各司其职。
               点柱子 = 定位并展开那一轮，与概览条 sessOvClick 同一语义。 -->
          <div v-if="sessChart" class="sv-chart">
            <div class="sv-chart-h" @click="$emit('update:sess-chart-open', !sessChartOpen)">
              <span class="sess-arrow">{{ sessChartOpen ? '▾' : '▸' }}</span>
              <span>逐轮用量</span>
              <template v-if="sessChart.mode === 'token'">
                <span class="li"><i class="sv-chip" style="background:var(--s-cache)"></i>缓存</span>
                <span class="li"><i class="sv-chip" style="background:var(--s-in)"></i>输入</span>
                <span class="li"><i class="sv-chip" style="background:var(--s-out)"></i>输出</span>
                <template v-if="sessChart.segs.length">
                  <span v-if="sessChart.lineKind === 'ctx'" class="li"><i class="sv-chip" style="background:var(--green)"></i>上下文占用率</span>
                  <span v-else class="li"><i class="sv-chip" style="background:var(--green)"></i>耗时</span>
                </template>
              </template>
              <template v-else>
                <span class="li"><i class="sv-chip" style="background:var(--s-out)"></i>积分</span>
                <span class="li"><i class="sv-chip" style="background:var(--s-in)"></i>上下文占比</span>
              </template>
              <span v-if="sessChart.hasMark" class="li"><i class="sv-dot"></i>压缩</span>
              <span class="sv-hint">点柱子定位到那一轮</span>
            </div>
            <template v-if="sessChartOpen">
              <div v-if="sessChart.note" class="sv-chart-note">{{ sessChart.note }}</div>
              <div class="sv-chart-body">
                <div v-for="r in sessChart.rows" :key="r.id" class="sv-col" :title="r.tip" @click="$emit('chart-go', r.id)">
                  <div class="sv-bar"><i v-for="(seg, si) in r.stack" :key="si" :style="{height: seg.h + '%', background: seg.c}"></i></div>
                  <i v-if="r.mark" class="sv-mark" :class="{bare: r.mark.bare}" :style="{bottom: r.mark.y + '%'}"></i>
                </div>
                <svg v-if="sessChart.segs.length" class="sv-line" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <polyline v-for="(pts, li) in sessChart.segs" :key="li" :points="pts" fill="none" :stroke="sessChart.lineColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
                </svg>
              </div>
              <div class="sv-chart-x">
                <span v-for="(r, i) in sessChart.rows" :key="r.id" class="sv-x-tick">{{ i % sessChart.tickEvery === 0 ? '#' + (i + 1) : '' }}</span>
              </div>
            </template>
          </div>

          <!-- hasTimeline 是**服务端**算的（能力名单 EVENT_AGENTS，目前是 dsh / zcode / traedb / opencode / kilo / hermes / devin），页面不硬编码 agent 名单。
               sessHasEvents 是页面侧的自纠正：真加载到 events 就不显示这条告警（防名单漏更新）。
               ⚠️ 措辞别写成「这个 agent 的日志没有逐事件时间戳」—— 那是错的：claude/codebuddy/gemini
               的日志里有逐行时间戳，解析器也已经用它算出了每次调用的真实耗时（实测 15/15、5/5、1/1 都有非零 dur），
               只是**算完没留成事件流**。缺的是「留成流」，不是「时间」。 -->
          <el-alert v-if="sessPick && !sessPick.hasTimeline && !sessHasEvents" type="info" :closable="false" show-icon style="margin-bottom:12px"
            title="这个 agent 没有逐事件时间轴"
            description="逐事件流水目前只有 dsh / zcode / traedb（Trae 的 SQLCipher 库）/ opencode / kilo / hermes / devin 的解析器做了保留（服务端 hasTimeline 字段）；该 agent 的轮次退回 LLM 调用明细 + 工具调用两块渲染。别的 agent 的日志也带逐行时间戳，只是解析时用来算完每次调用的耗时，没再留成一条事件流。"></el-alert>

          <!-- 概览条：横轴 = sessSpan（[首轮起点, 末轮**结束**]，见 sessSpan 的注释），
               宽度 = **真实时间占比**（pctOf），不给任何段画等宽。
               背景轨 = 每一轮（所有轮都有真实 time/dur）；前景轨 = 只画**已经展开取过 events 的轮**，
               llm 拆成「等待(ttft)」与「解码(dur)」两段，工具画 call→result 的真实区间。
               **不做滚轮缩放 / 拖动**（既有决策：区间一被随手滚掉，下面的数字就全跟着跳），
               交互只有「点击定位 + 高亮」。 -->
          <div v-if="sessSpan && sessCur.entries.length" class="sv-ov">
            <div class="sv-ov-h">
              <span class="li"><i class="sv-chip" style="background:var(--placeholder)"></i>轮（真实起止）</span>
              <span class="li"><i class="sv-chip" style="background:var(--s-out)"></i>TTFT 等待</span>
              <span class="li"><i class="sv-chip" style="background:var(--s-in)"></i>解码</span>
              <span class="li"><i class="sv-chip" style="background:var(--s-cache)"></i>工具（真实耗时）</span>
              <span class="sv-hint">点一下落在最近的一轮并展开 · 前景轨只画已展开过的轮</span>
            </div>
            <div class="sv-ov-body" @click="e => $emit('ov-click', e)">
              <div class="sv-mtrack">
                <i v-for="seg in sessOvTurns" :key="seg.id" class="sv-mseg" :class="{mgap: seg.mgap}"
                  :style="{left: seg.left + '%', width: seg.width + '%', background: seg.err ? 'var(--red)' : 'var(--placeholder)'}"
                  :title="seg.tip"></i>
              </div>
              <div class="sv-mtrack">
                <i v-for="(seg, si) in sessOvEvents" :key="si" class="sv-mseg" :class="[seg.cls, {mgap: seg.mgap}]"
                  :style="{left: seg.left + '%', width: seg.width + '%'}" :title="seg.tip"></i>
              </div>
              <i v-if="sessCursor != null" class="sv-cur-line" :style="{left: (sessCursor * 100) + '%'}"></i>
            </div>
            <div class="sv-ov-x">
              <span>{{ fmtTime(sessFrom) }}</span>
              <span class="sv-ov-mid">{{ fmtTime((sessFrom + sessTo) / 2) }}</span>
              <span>{{ fmtTime(sessTo) }}</span>
            </div>
          </div>

          <!-- 逐轮轨迹：默认全折叠，点开哪轮才拉哪轮（懒加载 + sessDetail 缓存，不重复请求） -->
          <div v-for="(tk, i) in sessCur.entries" :key="tk.id" :id="'sv-turn-' + tk.id" class="sess-turn" :class="{err: tk.status !== 'ok'}">
            <div class="sess-turn-head" @click="$emit('toggle-turn', tk)">
              <span class="sn">#{{ i + 1 }}</span>
              <span class="st-preview">{{ tk.preview || '(无文本预览)' }}</span>
              <span v-if="sessEvIndex[tk.id]" class="mini-tag" :title="'该轮有 ' + sessEvIndex[tk.id].length + ' 条逐事件记录'">轨迹 {{ sessEvIndex[tk.id].length }}</span>
              <span v-if="tk.status !== 'ok'" class="tag tag-err">ERR</span>
              <span class="sd">{{ fmtN(sumTok(tk)) }}</span>
              <span class="sd">{{ fmtDur(tk.dur) }}</span>
              <span class="st-time">{{ tk.timeUnknown ? '时间未知' : fmtTime(tk.time) }}</span>
              <span class="sess-arrow">{{ sessOpen.has(tk.id) ? '▾' : '▸' }}</span>
            </div>
            <div v-if="sessOpen.has(tk.id)" class="sess-turn-body" @click.stop>
              <template v-if="sessDetail[tk.id]">
                <!-- 有逐事件时间戳 → 轨迹。事件按真实时间顺序，但**不保证**严格成对
                     （step 可能缺 end、result 可能配不上 call），所以每一行都自己撑住，不假设配对。 -->
                <template v-if="sessEvRows[tk.id]">
                  <div class="sv-evs-h">逐事件轨迹（{{ sessEvRows[tk.id].length }} 条 · 时间为相对本轮起点的偏移）</div>
                  <div class="sv-evs">
                    <template v-for="row in sessEvRows[tk.id]" :key="row.key">
                      <div class="sv-ev" :class="['k-' + row.k, {on: sessHi === row.key, err: row.err}]" @click="$emit('event-click', tk, row)">
                        <span class="sv-ev-t">{{ row.rel }}</span>
                        <span class="sv-ev-k">{{ row.label }}</span>
                        <!-- llm：TTFT / decode 两段迷你条。两个都是 0（失败调用）时画斜纹占位 + 文案里的「?」，
                             不画成 0 宽空气，也不编造时长。 -->
                        <span v-if="row.k === 'llm'" class="sv-mini" :title="'等待 ' + (row.ev.ttft || 0) + 'ms + 解码 ' + (row.ev.dur || 0) + 'ms（按本轮最长的一次调用归一）'">
                          <i v-if="row.bar.w" class="sv-mini-w" :style="{width: row.bar.w + '%'}"></i>
                          <i v-if="row.bar.d" class="sv-mini-d" :style="{width: row.bar.d + '%'}"></i>
                          <i v-if="row.zero" class="sv-mini-z"></i>
                        </span>
                        <span v-if="row.k === 'llm'" class="sv-ev-ttft">TTFT {{ row.ev.ttft ? row.ev.ttft + 'ms' : '?' }} │ decode {{ row.ev.dur ? row.ev.dur + 'ms' : '?' }}</span>
                        <span class="sv-ev-sub">{{ row.sub }}</span>
                        <span v-if="row.tool" class="sess-arrow">{{ sessHi === row.key ? '▾' : '▸' }}</span>
                      </div>
                      <!-- 工具入参/返回：正文只在 tools[ev.i] 里存一份（事件里不存副本），
                           这里按同一套折叠 / 复制渲染；截断时走 sessLoadFull 二次拉取。 -->
                      <div v-if="row.tool && sessHi === row.key" class="sv-ev-json" @click.stop>
                        <template v-if="row.tool.input">
                          <div class="tool-sec-h" @click="$emit('fold-json', tk.id, row.ev.i, 'in')">{{ toolJsonFold.has(tk.id + ':' + row.ev.i + ':in') ? '▸ 入参' : '▾ 入参' }}</div>
                          <pre v-show="!toolJsonFold.has(tk.id + ':' + row.ev.i + ':in')">{{ row.tool._inPretty || prettyJson(row.tool.input) }}</pre>
                        </template>
                        <span v-if="row.tool.inputTrunc && !sessFullIds.has(tk.id)" class="more-btn" @click="$emit('load-full', tk.id)">输入已截断，查看完整内容</span>
                        <template v-if="row.tool.output">
                          <div class="tool-sec-h" @click="$emit('fold-json', tk.id, row.ev.i, 'out')">{{ toolJsonFold.has(tk.id + ':' + row.ev.i + ':out') ? '▸ 返回' : '▾ 返回' }}</div>
                          <pre v-show="!toolJsonFold.has(tk.id + ':' + row.ev.i + ':out')">{{ row.tool._outPretty || prettyJson(row.tool.output) }}</pre>
                        </template>
                        <span v-if="row.tool.outputTrunc && !sessFullIds.has(tk.id)" class="more-btn" @click="$emit('load-full', tk.id)">输出已截断，查看完整内容</span>
                        <span class="tool-copy" @click="copyRaw($event, (row.tool.input || '') + (row.tool.output ? '\\n' + row.tool.output : ''))">复制</span>
                      </div>
                    </template>
                  </div>
                </template>

                <!-- 没有逐事件（不在 EVENT_AGENTS，或这轮没落盘）→ 退回 LLM 调用明细 + 工具调用两块。
                     ⚠️ 措辞：缺的是「把逐事件留成一条流」，**不是**「日志里没有时间戳」——
                     claude/codebuddy/gemini 的日志有逐行时间戳，下面那张「LLM 调用明细」里的耗时
                     就是解析器用它们算出来的（实测 15/15、5/5、1/1 非零）。 -->
                <template v-else>
                  <div class="calls-note">这一轮没有逐事件时间轴，退回 LLM 调用明细 + 工具调用两块渲染。</div>
                  <template v-if="sessDetail[tk.id].calls && sessDetail[tk.id].calls.length">
                    <h4>LLM 调用明细（{{ sessDetail[tk.id].calls.length }} 次）</h4>
                    <div class="call-list">
                      <div v-for="(c, ci) in sessDetail[tk.id].calls" :key="ci" class="call-item">
                        <div class="call-row">
                          <span class="ci"><i v-if="c.text" class="call-dot" title="这次调用有正文，可点开"></i>#{{ ci + 1 }}</span>
                          <span class="cm">{{ c.model || 'generation' }}</span>
                          <span v-if="c.tools && c.tools.length" class="call-tools" :title="'这次调用发起了：' + toolText(c.tools, 99)">{{ toolText(c.tools) }}</span>
                          <span v-if="c.error" class="cerr">✗ {{ c.error }}</span>
                          <span class="cd">{{ fmtDur(c.dur) }}</span>
                          <span v-if="c.tin != null && c.model" class="ct">↑{{ fmtN(c.tin) }} · ↓{{ fmtN(c.tout) }}<template v-if="c.tcache"> · 缓存 {{ fmtN(c.tcache) }}</template></span>
                        </div>
                        <!-- 同卡片详情：这次调用自己说了什么。折叠开关按 tk.id 独立记，
                             与卡片里的 details 缓存不是一份（见 sessLoadFull 上面那段说明） -->
                        <template v-if="c.text">
                          <div class="tool-sec-h call-out-h" @click="$emit('fold-callout', tk.id, ci)">{{ callOpen.has(tk.id + ':' + ci) ? '▾ 本次输出' : '▸ 本次输出' }}</div>
                          <pre v-show="callOpen.has(tk.id + ':' + ci)" class="call-out">{{ c.text }}</pre>
                          <span v-if="c.textTrunc && !sessFullIds.has(tk.id)" class="more-btn" @click="$emit('load-full', tk.id)">本次输出已截断，查看完整内容</span>
                        </template>
                      </div>
                    </div>
                  </template>
                  <div v-else-if="sessDetail[tk.id].callsNote" class="calls-note">{{ sessDetail[tk.id].callsNote }}</div>
                  <template v-if="sessDetail[tk.id].tools && sessDetail[tk.id].tools.length">
                    <h4>工具调用（{{ sessDetail[tk.id].tools.length }}）</h4>
                    <div v-for="(tt, ti) in sessDetail[tk.id].tools" :key="ti" class="tool-item">
                      <div class="tool-head">
                        <span class="tname">{{ tt.name }}</span>
                        <span v-if="tt.error" class="terr">✗ {{ tt.error }}</span>
                        <span v-if="tt.dur != null" class="tdur">{{ fmtDur(tt.dur) }}</span>
                        <span class="tool-copy" @click="copyRaw($event, (tt.input || '') + (tt.output ? '\\n' + tt.output : ''))">复制</span>
                      </div>
                      <template v-if="tt.input">
                        <div class="tool-sec-h" @click="$emit('fold-json', tk.id, ti, 'in')">{{ toolJsonFold.has(tk.id + ':' + ti + ':in') ? '▸ 入参' : '▾ 入参' }}</div>
                        <pre v-show="!toolJsonFold.has(tk.id + ':' + ti + ':in')">{{ tt._inPretty || prettyJson(tt.input) }}</pre>
                      </template>
                      <span v-if="tt.inputTrunc && !sessFullIds.has(tk.id)" class="more-btn" @click="$emit('load-full', tk.id)">输入已截断，查看完整内容</span>
                      <template v-if="tt.output">
                        <div class="tool-sec-h" @click="$emit('fold-json', tk.id, ti, 'out')">{{ toolJsonFold.has(tk.id + ':' + ti + ':out') ? '▸ 返回' : '▾ 返回' }}</div>
                        <pre v-show="!toolJsonFold.has(tk.id + ':' + ti + ':out')">{{ tt._outPretty || prettyJson(tt.output) }}</pre>
                      </template>
                      <span v-if="tt.outputTrunc && !sessFullIds.has(tk.id)" class="more-btn" @click="$emit('load-full', tk.id)">输出已截断，查看完整内容</span>
                    </div>
                  </template>
                </template>

                <!-- 非文本 part（zcode 的状态事件 / 推理锚点 / 未知类型）：不静默丢弃，
                     与时间轴 / 退回两块都并存，所以放在两条渲染路径之外 -->
                <template v-if="sessDetail[tk.id].others && sessDetail[tk.id].others.length">
                  <h4>其他事件（{{ sessDetail[tk.id].others.length }}）</h4>
                  <div v-for="(o, oi) in sessDetail[tk.id].others" :key="oi">
                    <div class="other-item"><span class="ot">{{ o.type }}</span><span class="od">{{ o.t ? fmtTime(o.t) : '' }}</span></div>
                    <pre v-if="o.json" class="other-json">{{ o.json }}</pre>
                  </div>
                </template>

                <!-- 正文两块：轨迹说的是「怎么跑的」，正文说的是「跑了什么」，两条渲染路径都要给 -->
                <h4>用户输入 <span class="copy-btn" title="复制原文" @click="copyRaw($event, sessDetail[tk.id].user)">复制</span></h4>
                <pre>{{ sessDetail[tk.id].user || '(空)' }}</pre>
                <template v-if="sessDetail[tk.id].assistant">
                  <h4>AI 输出 <span class="copy-btn" title="复制原文（非渲染后文本）" @click="copyRaw($event, sessDetail[tk.id].assistant)">复制</span></h4>
                  <!-- _assistantMd 由 prepDetail 缓存（见卡片详情同款注释） -->
                  <div class="md-body" v-html="sessDetail[tk.id]._assistantMd"></div>
                </template>
              </template>
              <el-skeleton v-else :rows="2" animated></el-skeleton>
              <!-- 轮详情底部的「收起」：复用卡片的 .detail-foot（吸底 + 渐变上沿，十几屏高也随时点得到）。
                   交互同 collapseCard：折叠后把轮头滚回视野，见 sessCollapseTurn。 -->
              <div class="detail-foot">
                <el-button size="small" @click="$emit('collapse-turn', tk.id, $event)">收起</el-button>
              </div>
            </div>
          </div>
        </template>
      </section>
    </main>`,
  props: {
    // 左栏列表（状态与请求都在根：v-if 销毁子树时这些得活着，见文件头）
    sessSearch: { type: String, default: '' },
    sessSort: { type: String, default: 'to' },
    sessList: { type: Array, default: () => [] },
    sessListFiltered: { type: Array, default: () => [] },
    sessListCapped: Boolean,
    sessListError: { type: String, default: '' },
    sessListLoading: Boolean,
    // 右栏：选中的会话 + /api/session 聚合 + 逐轮懒加载的详情缓存
    sessPick: { type: Object, default: null },
    sessCur: { type: Object, default: null },
    sessCurLoading: Boolean,
    sessOpen: { type: Object, default: () => new Set() },
    sessDetail: { type: Object, default: () => ({}) },
    sessFullIds: { type: Object, default: () => new Set() },
    sessHi: { type: String, default: '' },
    sessCursor: { type: Number, default: null },
    sessSpan: { type: Object, default: null },
    sessFrom: { type: Number, default: 0 },
    sessTo: { type: Number, default: 0 },
    sessHasEvents: Boolean,
    sessOvTurns: { type: Array, default: () => [] },
    sessOvEvents: { type: Array, default: () => [] },
    sessEvIndex: { type: Object, default: () => ({}) },
    sessEvRows: { type: Object, default: () => ({}) },
    sessChart: { type: Object, default: null },
    sessChartOpen: Boolean,
    // 折叠开关两份：与卡片详情共用同一份根状态（同一个 Set 在两个视图里都可能出现）
    toolJsonFold: { type: Object, default: () => new Set() },
    callOpen: { type: Object, default: () => new Set() },
    searchIcon: { type: [Object, Function], default: null },
  },
  emits: ['update:sess-search', 'update:sess-sort', 'update:sess-chart-open', 'pick-session',
    'toggle-turn', 'event-click', 'ov-click', 'chart-go', 'collapse-turn', 'load-full',
    'fold-json', 'fold-callout', 'open-session'],
  setup() {
    return { fmtN, fmtDur, fmtDurBig, fmtTime, fmtAgo, sumTok, modelText, toolText, prettyJson, copyRaw, agentColor, agentIcon };
  }
};
