// 用量统计弹层（R25 批 1 第五个组件，也是批 1 里最重的一个）。
// 契约见 page/shared.js 头部「R25 组件文件契约」；顶层只许有那一处 AACTA 赋值，Vue / Element Plus 的 API 写全名。
//
// 数据进出 —— 这是批 1 里唯一「一个弹层装三个 tab」的：
//   · visible ← 根（顶栏 TrendCharts 按钮 / 弹层自己关闭时回写）
//   · req     ← 根：{ qs, filterText, keepRange, n }，含义见下
//   · fAgent / fAgents / sideAgents ← 根：弹层里那个 agent 下拉要与左侧栏**同一个**筛选，
//     所以值不从这儿算，直接把根的活状态递进来（多选态要禁用，见模板上的 R10 注释）
//   · getJSON ← 根 provide（404 要点亮版本红条）
//   · 天桶 / 可视窗 / 按模型 / 时延 —— 全是弹层自己的
//
// 为什么 req 里带一个自增的 n 而不是「visible 变化就 load」：
//   弹层里的 agent 下拉会**在开着的时候**改筛选（根 pickAgent 后重新发一份 req），
//   visible 全程是 true，光看 visible 就漏了这一次。n 每次都变，watch 它最省事。
//   qs 是根在点击那一刻按活筛选拼好的（含 from/to + agent(s) + project(s)），
//   filterText 同理 —— 数字显示期间用户改了筛选，口径说明也得跟着那份数字走，不能现算。
window.AACTA = window.AACTA || {};
AACTA.DialogStats = {
  name: 'aa-dialog-stats',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="用量统计（按天）" width="min(1080px, 94vw)" append-to-body class="st-dialog">
    <div class="st-body">
    <div class="st-note">
      统计区间：<b>{{ statsRange ? statsRange[0] + ' ~ ' + statsRange[1] : '—' }}</b> · {{ stats.filterText }} · 区间内共 <b>{{ statsViewTotals.count }}</b> 条
      —— 卡片、明细、按模型都是这段区间内的数字；改区间只用上方日期选择器（不受右上角「条/页」影响）。
      <span v-if="stats.label !== '全部时间'">（可统计的数据本身受左侧「时间范围 = {{ stats.label }}」限制）</span>
      <!-- 跨度大到只统计了最近 400 天时说出来：上限本身是防病态跨度的，但少算了哪一段必须让用户知道 -->
      <span v-if="stats.daysCapped" style="color:#c26a1b">⚠ 跨度超过 400 天，只统计了最近 400 天。</span>
      <!-- I16/D2：时间未知的轮不进这张按天图（它们没有可用的时间戳）。不说明的话，
           合计会比上面那个条数少一截，读起来像漏算 —— 那是把「不知道」读成了「丢了」。 -->
      <span v-if="stats.timeUnknown" style="color:#c26a1b" title="源里没有这些轮的时间戳（atomcode 的 .jsonl 0 字节 / turn_id 在 jsonl 里不存在）。它们仍在列表与卡片里，只是不参与按天统计与时间排序——不拿会话更新时刻冒充轮时间。">⚠ 另有 <b>{{ stats.timeUnknown }}</b> 轮时间未知，未计入下面的按天统计。</span>
    </div>
    <el-skeleton v-if="stats.loading" :rows="7" animated></el-skeleton>
    <el-alert v-else-if="stats.error" :title="stats.error" type="error" :closable="false" show-icon></el-alert>
    <template v-else>
      <div class="st-tiles">
        <div v-for="t in statsTiles" :key="t.k" class="st-tile">
          <div class="tl"><span v-if="t.color" class="st-chip" :style="{background:t.color}"></span>{{ t.label }}</div>
          <div class="tv">{{ fmtN(t.value) }}</div>
          <div class="ts">{{ t.sub }}</div>
        </div>
      </div>
      <div class="st-line">
        <!-- 条数在顶部 st-note 已说过「区间内共 N 条」，这里不重复 -->
        <span class="st-meta">{{ statsViewTotals.calls }} 次 LLM 调用 · {{ statsViewTotals.tools }} 个工具 · 总耗时 {{ fmtDurBig(statsViewTotals.dur) }}</span>
        <!-- R10：多选态（fAgents 非空且无单选）时下拉禁用为「跟随列表筛选」，避免与主列表多选打架 -->
        <el-select :model-value="fAgent" size="small" style="width:132px;flex:none"
          :disabled="!fAgent && fAgents.length > 0"
          :title="(!fAgent && fAgents.length) ? '当前为 agent 多选筛选（' + fAgents.join(', ') + '），统计跟随列表' : '只看某个 agent —— 与左侧栏是同一个筛选（背后的请求列表也跟着变）；切换时保留当前日期区间'"
          @change="onAgentChange">
          <el-option label="全部 agent" value=""></el-option>
          <el-option v-for="n in sideAgents" :key="n" :label="n" :value="n"></el-option>
        </el-select>
        <el-date-picker v-model="statsRange" type="daterange" size="small" value-format="YYYY-MM-DD"
          range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false"
          :disabled-date="statsDisabledDate" :shortcuts="statsShortcuts"
          style="width:240px" title="统计区间：从几号到几号；卡片、明细、按模型都跟着这段区间变"></el-date-picker>
        <el-radio-group v-model="stats.withCache" size="small">
          <el-radio-button :value="false">输入 + 输出</el-radio-button>
          <el-radio-button :value="true">含缓存</el-radio-button>
        </el-radio-group>
      </div>
      <!-- 读数独占一行（不是跟上面挤一条会折行的 flex 行）：见 .st-read 的注释 -->
      <div class="st-read" :title="statsReadout">{{ statsReadout }}</div>
      <div class="st-chart">
        <div v-for="b in statsBars" :key="b.day" class="st-bar" :class="{on: hoverDay===b.day}"
          @mouseenter="hoverDay = b.day" @mouseleave="hoverDay = ''" :title="b.tip">
          <!-- DOM 顺序 = 视觉从上到下：缓存 → 输出 → 输入（输入贴基线）。段间的 2px 缝只在**够高**的段之间留，
               否则 3px 的下限里再挖掉 2px 就只剩一条 1px 的线了 -->
          <div v-if="b.hCache" class="st-seg" :class="{top:true, sep:b.hOut>ST_GAP}" :style="{height:b.hCache+'%',background:'var(--s-cache)'}"></div>
          <div v-if="b.hOut" class="st-seg" :class="{top:!b.hCache, sep:b.hIn>ST_GAP, hit:true}" :style="{height:b.hOut+'%',background:'var(--s-out)'}"></div>
          <div v-if="b.hIn" class="st-seg" :class="{top:!b.hCache && !b.hOut, hit:true}" :style="{height:b.hIn+'%',background:'var(--s-in)'}"></div>
        </div>
      </div>
      <div class="st-x">
        <span v-for="(b, i) in statsBars" :key="b.day">{{ i % statsTickEvery === 0 ? b.short : '' }}</span>
      </div>
      <div class="st-legend">
        <span v-if="stats.withCache" class="li"><i class="st-chip" style="background:var(--s-cache)"></i>缓存命中</span>
        <span class="li"><i class="st-chip" style="background:var(--s-out)"></i>输出</span>
        <span class="li"><i class="st-chip" style="background:var(--s-in)"></i>输入（不含缓存）</span>
        <span style="margin-left:auto">每根柱子 = 一天；悬停看当天明细</span>
      </div>
      <div class="st-tabs">
        <span class="st-tab" :class="{on: stats.tab==='day'}" @click="stats.tab='day'">按天明细（{{ stats.days.length }}）</span>
        <span class="st-tab" :class="{on: stats.tab==='model'}" @click="stats.tab='model'">按模型（{{ statsModels.length }}）</span>
        <!-- I15 工作指纹：git 分支 / 权限模式 / 产品版本。切入时才拉 /api/work（复用当前筛选），
             不随统计打开自动请求 —— 与「时延分析」同款懒加载 -->
        <span class="st-tab" :class="{on: stats.tab==='work'}" @click="stats.tab='work'; loadWork()">工作指纹</span>
        <!-- R8：时延分析 tab，切入时才拉 /api/analyze（复用当前筛选），不随统计打开自动请求 -->
        <span class="st-tab" :class="{on: stats.tab==='lat'}" @click="stats.tab='lat'; loadAnalyze()">时延分析</span>
      </div>
      <div class="st-pane">
        <template v-if="stats.tab==='day'">
          <div class="st-note">
            <template v-if="statsHeavyNote">⚠ <b>{{ statsHeavyNote }}</b><br></template>
            耗时 = 各轮「首条记录 → 末条记录」的时间差之和，<b>不是真实工作时间</b>。
            <el-popover placement="top-start" :width="400" trigger="hover">
              <template #reference><span class="st-info">?</span></template>
              挂机、隔夜的轮会把一整天算爆（本机实测有单轮 63 小时）。表里「耗时」列打 ⚠ 的天，
              当天最长单轮超过全天总耗时的一半（且全天 ≥ 1 小时才标记，样本太小不算）——那种天别当工作量看。
            </el-popover>
          </div>
          <div class="st-table">
            <table>
              <thead><tr><th>日期</th><th>条目</th><th>输入</th><th>输出</th><th>缓存命中</th><th>合计</th><th title="各轮「首条→末条记录」时间差之和。打 ⚠ = 当天最长单轮超过全天一半（多为挂机/隔夜）">耗时</th></tr></thead>
              <tbody>
                <tr v-for="b in statsTableRows" :key="b.day" :class="{zero: !b.count}">
                  <td>{{ b.day }}</td>
                  <td>{{ b.count || '—' }}</td>
                  <td>{{ b.count ? fmtN(b.tin) : '—' }}</td>
                  <td>{{ b.count ? fmtN(b.tout) : '—' }}</td>
                  <td>{{ b.count ? fmtN(b.tcache) : '—' }}</td>
                  <td>{{ b.count ? fmtN(b.total) : '—' }}</td>
                  <td>
                    <span v-if="!b.count">—</span>
                    <span v-else-if="isHeavyDay(b)" :title="'当天最长单轮 ' + fmtDurBig(b.maxDur) + '，占全天 ' + Math.round(b.maxDur / b.dur * 100) + '%——多半是挂机/隔夜的那一轮'">
                      {{ fmtDurBig(b.dur) }} <span class="st-warn">⚠</span>
                    </span>
                    <span v-else>{{ fmtDurBig(b.dur) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <template v-else-if="stats.tab==='model'">
          <div class="st-note">
            条形长度 = 该模型 token 占合计的比例（<b>绝对占比</b>，不按第一名归一）· 无模型记录
            <b>{{ stats.noModel }}</b> 条（token 恒为 0，只占条数、不占 token）
            <template v-if="stats.multi">· {{ stats.multi }} 条轮次用了多个模型，token 全归第一个</template>
            <el-popover placement="top-start" :width="400" trigger="hover">
              <template #reference><span class="st-info">?</span></template>
              同一个模型被不同 agent 写成两种大小写时（Deepseek-V4-Flash / deepseek-v4-flash）按小写并成一行；
              大小写之外一个字都不动 —— 去空格/去连字符会把 hy4 preview 和 hy4-preview 并掉，
              但同样的规则也会把 gpt-5.4 和 gpt-54 并错，宁可少并也不并错。
            </el-popover>
          </div>
          <div v-if="stats.modelError" class="st-note" style="color:var(--red)">{{ stats.modelError }}</div>
          <div class="st-mlist" v-loading="stats.modelsLoading">
            <div v-for="m in statsModels" :key="m.key" class="st-mrow" :class="{none: m.none}">
              <span class="st-mname" :title="m.tip">{{ m.label }}<i v-if="m.names.length > 1">（{{ m.names.length }} 种写法）</i></span>
              <span class="st-mtrack">
                <i v-if="m.wIn" class="st-mseg" :class="{mgap: m.wOut > ST_GAP}" :style="{width:m.wIn+'%',background:'var(--s-in)'}"></i>
                <i v-if="m.wOut" class="st-mseg" :class="{mgap: m.wCache > ST_GAP}" :style="{width:m.wOut+'%',background:'var(--s-out)'}"></i>
                <i v-if="m.wCache" class="st-mseg" :style="{width:m.wCache+'%',background:'var(--s-cache)'}"></i>
              </span>
              <span class="st-mnum">{{ m.total ? fmtN(m.total) : '—' }}</span>
              <span class="st-mshare">{{ m.shareText }}</span>
              <span class="st-mcnt">{{ m.count }} 条</span>
            </div>
          </div>
        </template>
        <template v-else-if="stats.tab==='work'">
          <!-- I15 工作指纹：三个维度各自的分桶表。要点都在 note 里说清：
               ① 只有 claude 源有这三样（covered 如实列出）；别家「无此维度」不印 0；
               ② 值取轮内最后一次声明，未声明的轮落在「未声明」行；
               ③ token 列是绝对数，条形按本次最大的一档归一。 -->
          <div class="st-note" v-if="workData">
            <template v-if="workData.covered.length">数据源：<b>{{ workData.covered.join(' / ') }}</b>（工作指纹只有这些 agent 的日志里带；其余 agent 一律不印 0，如实标「无此维度」）。</template>
            <template v-else>当前筛选里没有带工作指纹的 agent（工作指纹只在 claude 日志里）。</template>
            · 值取轮内<em>最后一次声明</em>（会话中途切分支/切权限，后面的才是当前值）· 未声明/无此维度的轮单列「未声明」，不冒充默认值。
            <span class="ana-refresh" @click="loadWork">重新统计</span>
          </div>
          <div class="wf-dims" v-if="workData">
            <!-- 维度选择：三个维度的表格共用一块屏，点标签切换（与 ana.sub 同一模式） -->
            <div class="ana-tabs">
              <span class="st-tab" :class="{on: work.dim==='branch'}" @click="work.dim='branch'">git 分支</span>
              <span class="st-tab" :class="{on: work.dim==='permMode'}" @click="work.dim='permMode'">权限模式</span>
              <span class="st-tab" :class="{on: work.dim==='cliVer'}" @click="work.dim='cliVer'">产品版本</span>
            </div>
            <div v-loading="work.loading" class="ana-body">
              <template v-if="workRows.length">
                <div class="sess-sum">
                  <span>共 <b>{{ workData.totals.count }}</b> 轮</span>
                  <span>合计 <b>{{ fmtN(workData.totals.total) }}</b> token</span>
                  <span>总耗时 <b>{{ fmtDurBig(workData.totals.dur) }}</b></span>
                  <span v-if="curDim.noVal">未声明 <b>{{ curDim.noVal }}</b> 轮</span>
                </div>
                <div class="wf-note">条形长度 = 该档 token 占合计的比例（绝对占比，不按第一名归一）；失败轮数只数 status=error 的轮。</div>
                <div class="ana-list">
                  <div v-for="(r, i) in workRows" :key="r.key" class="ana-row wf-row">
                    <span class="sn">#{{ i + 1 }}</span>
                    <span class="st-preview wf-key" :title="r.key">{{ r.key }}</span>
                    <span class="st-mtrack"><i class="st-mseg" :style="{ width: r.w + '%', background: 'var(--s-in)' }"></i></span>
                    <span class="wf-num">{{ fmtN(r.total) }}</span>
                    <span class="wf-share">{{ r.shareText }}</span>
                    <span class="wf-cnt">{{ r.count }} 条<template v-if="r.err"> · <b class="wf-err">{{ r.err }} 失败</b></template></span>
                    <span class="wf-dur">{{ fmtDurBig(r.dur) }}</span>
                  </div>
                  <!-- 未声明/无此维度单列一行：token 恒为 0（无此维度的 agent 本来就没有这些字段的 token 也一样被算进 total？）
                       注意：noValTotal 是这些轮的 token，照样要显示出来，否则「各行 + 未声明」对不上 totals -->
                  <div v-if="curDim.noVal" class="ana-row wf-row wf-noval">
                    <span class="sn">—</span>
                    <span class="st-preview wf-key">(未声明 / 无此维度)</span>
                    <span class="st-mtrack"></span>
                    <span class="wf-num">{{ fmtN(curDim.noValTotal) }}</span>
                    <span class="wf-share">{{ curDim.noValShareText }}</span>
                    <span class="wf-cnt">{{ curDim.noVal }} 条</span>
                    <span class="wf-dur">{{ fmtDurBig(curDim.noValDur) }}</span>
                  </div>
                </div>
              </template>
              <div v-else-if="!work.loading" class="empty">当前筛选里没有带工作指纹的条目</div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="ana-tabs">
            <span class="st-tab" :class="{on: ana.sub==='lat'}" @click="ana.sub='lat'">最慢轮</span>
            <span class="st-tab" :class="{on: ana.sub==='tools'}" @click="ana.sub='tools'">工具调用</span>
            <span class="st-tab" :class="{on: ana.sub==='cache'}" @click="ana.sub='cache'">缓存命中率</span>
            <span class="st-tab" :class="{on: ana.sub==='fail'}" @click="ana.sub='fail'">工具失败画像</span>
          </div>
          <div class="st-note">
            耗时 = 各轮「首条记录 → 末条记录」的时间差（含挂机/隔夜，p95 会被少数超长轮拉高）。
            有真实值的 agent（claude 的 turn_duration）另给「实际」=<b>产品自报的真实工作时间</b>，
            已剥掉用户离开/隔夜的部分 —— 差额就是「人等的」那部分（本机实测虚高约 2.5 倍）。
            <span class="ana-refresh" @click="loadAnalyze">刷新</span>
          </div>
          <div v-loading="ana.loading" class="ana-body">
            <template v-if="ana.data">
              <!-- 最慢轮：p50/p95 + 最慢 TopN；claude 另给「实际」真实工作时间 -->
              <template v-if="ana.sub==='lat'">
                <div class="sess-sum">
                  <span>共 <b>{{ ana.data.count }}</b> 轮</span>
                  <span>p50 <b>{{ fmtDur(ana.data.p50) }}</b></span>
                  <span>p95 <b>{{ fmtDur(ana.data.p95) }}</b></span>
                  <span>最长 <b>{{ fmtDur(ana.data.maxDur) }}</b></span>
                </div>
                <div v-if="ana.data.aCount > 0" class="sess-sum ana-sum-actual">
                  <span>实际 p95 <b>{{ fmtDur(ana.data.aP95) }}</b></span>
                  <span>实际最长 <b>{{ fmtDur(ana.data.aMax) }}</b></span>
                  <span class="st-meta">仅算拿到真实值的 <b>{{ ana.data.aCount }}</b> 轮（别家回落墙钟，不计入实际）</span>
                </div>
                <div class="ana-list">
                  <div v-for="(s, i) in ana.data.slowest" :key="s.id" class="ana-row" :title="'点击在列表中定位该条目'" @click="gotoEntry(s.id)">
                    <span class="sn">#{{ i + 1 }}</span>
                    <span class="ana-dur">{{ fmtDur(s.dur) }}<span v-if="s.rdur" class="ana-rdur">实际 {{ fmtDur(s.rdur) }}</span></span>
                    <span class="st-preview">{{ s.preview || '(无文本预览)' }}</span>
                    <span v-if="s.status !== 'ok'" class="tag tag-err">ERR</span>
                    <span class="ana-meta">{{ s.agent }} · {{ s.project || '—' }} · {{ fmtTime(s.time) }}</span>
                  </div>
                </div>
              </template>
              <!-- 工具调用排行：轮内工具调用次数 TopN（同一套下钻） -->
              <template v-else-if="ana.sub==='tools'">
                <div class="sess-sum">
                  <span>共 <b>{{ ana.data.count }}</b> 轮</span>
                  <span>有工具调用的轮 <b>{{ ana.data.byTools.length }}</b> 轮（取 Top {{ ana.data.byTools.length }}）</span>
                </div>
                <div class="ana-list">
                  <div v-for="(s, i) in ana.data.byTools" :key="s.id" class="ana-row" :title="'本轮 ' + s.tools + ' 次工具调用 · 点击在列表中定位该条目'" @click="gotoEntry(s.id)">
                    <span class="sn">#{{ i + 1 }}</span>
                    <span class="ana-dur">{{ s.tools }}×</span>
                    <span class="st-preview">{{ s.preview || '(无文本预览)' }}</span>
                    <span v-if="s.status !== 'ok'" class="tag tag-err">ERR</span>
                    <span class="ana-meta">{{ s.agent }} · {{ s.project || '—' }} · {{ fmtTime(s.time) }}</span>
                  </div>
                </div>
              </template>
              <!-- 缓存命中率排行：命中率最高的 TopN（命中率 = 缓存 / 合计） -->
              <template v-else-if="ana.sub==='cache'">
                <div class="sess-sum">
                  <span>共 <b>{{ ana.data.count }}</b> 轮</span>
                  <span>有 token 记录的轮 <b>{{ ana.data.byCacheRate.length }}</b> 轮（取命中率 Top {{ ana.data.byCacheRate.length }}）</span>
                </div>
                <div class="ana-list">
                  <div v-for="(s, i) in ana.data.byCacheRate" :key="s.id" class="ana-row" :title="'缓存命中率 ' + (s.rate*100).toFixed(1) + '% · 点击在列表中定位该条目'" @click="gotoEntry(s.id)">
                    <span class="sn">#{{ i + 1 }}</span>
                    <span class="ana-pct" :style="cachePctColor(s.rate)">{{ fmtPct(s.rate) }}</span>
                    <span class="st-preview">{{ s.preview || '(无文本预览)' }}</span>
                    <span v-if="s.status !== 'ok'" class="tag tag-err">ERR</span>
                    <span class="ana-meta">{{ s.agent }} · {{ s.project || '—' }} · {{ fmtTime(s.time) }} · 缓存 {{ fmtN(s.tcache) }}</span>
                  </div>
                </div>
              </template>
              <!-- I6/I13 工具失败画像：分子 = 搜索分片里逐轮的 tools[].error / .timeout / .soft 分类计数，
                   分母 = 同一批轮上的 toolNames 次数 -->
              <template v-else>
                <div class="st-note">
                  只认解析器落好的<b>结构化标志</b>（<code>tools[].error</code> / <code>.timeout</code> /
                  <code>.soft</code>），一个字正文都不扫 —— 「输出里恰好写着 error」不算失败。
                  <b>超时算失败</b>（它就是失败）；<b>软失败单列一档、不进失败率</b>（<code>No matches found</code>
                  这种"rg 没搜到"是正常结果）。失败数按<b>工具名 × agent</b> 分桶，<b>不跨 agent 并名字</b>
                  （同一家里 <code>Edit</code> 与 <code>edit</code> 是两种写法，跨家同名更是两回事）。
                  <span class="ana-refresh" @click="loadAnalyze">重新统计</span>
                </div>
                <div class="sess-sum">
                  <span>共 <b>{{ ana.data.count }}</b> 轮</span>
                  <span>带工具调用的轮 <b>{{ tfSum.turns }}</b></span>
                  <span>已核对 <b>{{ tfSum.known }}</b><i v-if="tfSum.unknown"> · 另有 <b>{{ tfSum.unknown }}</b> 轮还没索引到（不算进分母）</i></span>
                  <span>含失败工具的轮 <b>{{ tfSum.failTurns }}</b><template v-if="tfSum.known">（{{ fmtPct(tfSum.failTurns / tfSum.known) }}）</template></span>
                  <span v-if="tfSum.totals.timeout">其中超时 <b class="tf-to-n">{{ tfSum.totals.timeout }}</b> 次</span>
                  <span v-if="tfSum.totals.soft">软失败 <b>{{ tfSum.totals.soft }}</b> 次<i class="tf-soft-hint">（单列，不算失败）</i></span>
                </div>
                <div v-if="tfSum.building" class="st-note">后台正在建索引，「已核对」还会往上涨 —— 现在这张画像是不全的。</div>
                <div v-if="tfRowsView.length" class="st-note tf-howto">
                  条形 = 失败率（该工具失败次数 ÷ 它在这一批轮里被调用的次数），<b>按本次最高的那个率归一</b>，
                  所以最长的条不一定等于「最该修的」。左边 <b>N×</b> 才是绝对失败次数；
                  分母 &lt; {{ tfData.minTotal }} 的行标了「样本不足」，别拿它的率做结论。
                </div>
                <div class="ana-list">
                  <div v-for="(s, i) in tfRowsView" :key="s.agent + '\u0000' + s.name" class="ana-row tf-row"
                       :title="s.tip">
                    <span class="sn">#{{ i + 1 }}</span>
                    <span class="ana-dur">{{ s.fail }}×</span>
                    <span class="ana-pct tf-rate" :style="{ opacity: s.lowDenom ? .45 : 1 }">{{ s.rateText }}</span>
                    <span class="st-preview">{{ s.name }}<i v-if="s.lowDenom" class="tf-low">样本不足</i><i v-if="s.timeout" class="tf-low tf-to">超时 {{ s.timeout }}</i><i v-if="s.soft" class="tf-low tf-soft">软失败 {{ s.soft }}</i></span>
                    <span class="st-mtrack tf-track"><i class="st-mseg" :style="{ width: s.w + '%', background: 'var(--red)' }"></i></span>
                    <span class="ana-meta">{{ s.agent }} · 调用 {{ s.total }} 次</span>
                  </div>
                  <div v-if="!tfRowsView.length" class="empty">{{ tfEmptyText }}</div>
                </div>
                <!-- 覆盖度按 agent×来源如实摊开：没有信号的档位一律说明「这里空着的原因」，不画 0 -->
                <div v-if="tfCovView.length" class="tf-cov">
                  <div class="tf-cov-h">覆盖度（按来源；这一层决定哪些格子是空的、为什么空）</div>
                  <div v-for="c in tfCovView" :key="c.agent + '\u0000' + c.kind" class="tf-cov-row">
                    <span class="tf-cov-a">{{ c.agent }}</span>
                    <span class="tf-cov-k">{{ c.kind || '—' }}</span>
                    <span class="tf-cov-t" :class="'tier-' + c.tier">{{ c.tierText }}</span>
                    <span class="tf-cov-n">带工具 {{ c.turns }} 轮 · 已核对 {{ c.known }}<template v-if="c.unknown"> · 未索引 {{ c.unknown }}</template><template v-if="c.softTurns"> · 仅软失败 {{ c.softTurns }} 轮</template></span>
                    <span class="tf-cov-ts" :class="c.tsSig ? 'ts-yes' : 'ts-no'">{{ c.tsText }}</span>
                    <span class="tf-cov-r">{{ c.rateText }}</span>
                  </div>
                </div>
              </template>
            </template>
            <div v-else-if="!ana.loading" class="empty">暂无数据</div>
          </div>
        </template>
      </div>
    </template>
    </div>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button type="primary" :loading="stats.loading" @click="reload">重新统计</el-button>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
    // 「统计哪一段、按什么筛」：根在点击那一刻拼好递进来（qs 已 toString）。
    // n 只用来触发重算（自增），keepRange = 切 agent 时保住手选的日期区间。
    req: { type: Object, default: null },
    // 弹层里那个 agent 下拉要与左侧栏同一个筛选：值/禁用/选项都从根递，改动也上报给根（emit agent-change）
    fAgent: { type: String, default: '' },
    fAgents: { type: Array, default: () => [] },
    sideAgents: { type: Array, default: () => [] },
  },
  emits: ['update:visible', 'agent-change', 'locate'],
  setup(props, { emit }) {
    const getJSON = Vue.inject('getJSON');
    const stats = Vue.reactive({
      // visible 不在这个对象里：开关归根（与别的弹层一致），放这儿会有两份真相
      loading: false, error: '', label: '全部时间', filterText: '', days: [], totals: {}, withCache: true,
      tab: 'day',   // 明细区一次只显示一屏：按天表格 / 按模型列表（同时摆出来每块只剩百来像素）
      viewN: 7, viewEnd: null,   // 图表可视窗口：默认最近 7 天；viewEnd=null = 贴最新一侧
      modelsLoading: false, modelError: '',   // 按模型跟着窗口重新取数（服务端聚合，前端切不了）
      models: [], modelTotals: {}, noModel: 0, multi: 0,   // 按模型那一块（/api/models）
      daysCapped: 0, timeUnknown: 0,   // 按天统计的两个「少算了什么」：跨度截断 / 时间未知的轮（I16/D2）
    });
    const hoverDay = Vue.ref('');
    // 段高（%）超过它才在段之间留 2px 缝：约等于 5px（图表内容高 123px）。
    // 比这矮的段本来就只有 3px 的显示下限，再挖掉 2px 缝隙就只剩一根 1px 的线了。
    const ST_GAP = 4;

    // 按天桶一次取回**整个筛选集**（窗口在前端切，缩放/拖动不用回服务端）；
    // 「按模型」是另一套聚合维度，前端没有 天×模型 明细，跟着窗口单独取（见 fetchModels）。
    async function load(keepRange) {
      // 切 agent 时保住手选的日期区间（keepRange）：同一段时间跨 agent 对比才有意义。
      // 先记下日期（下标在新数据里会移位，日期不会），取回新数据后再按日期恢复（越界自动收进新范围）。
      const r = props.req || {};
      const prevRange = keepRange ? statsRange.value : null;
      stats.loading = true;
      stats.error = '';
      try {
        const j = await getJSON('/api/daily?' + (r.qs || ''));
        if (!j.ok) throw new Error(j.error || '统计失败');
        stats.days = j.days || [];
        stats.totals = j.totals || {};
        stats.label = j.label || '全部时间';
        stats.daysCapped = j.daysCapped || 0;
        stats.timeUnknown = j.timeUnknown || 0;   // I16/D2：未计入按天统计的时间未知轮数（如实说明）
        stats.filterText = r.filterText || '';   // 记下「这份数字是按什么筛出来的」，中途改筛选也不会让已显示的数字对不上
        hoverDay.value = '';
        stats.tab = 'day';
        stats.viewN = 7; stats.viewEnd = null;
        if (prevRange) setViewByDates(prevRange[0], prevRange[1]);
        stats.modelError = '';
        queueModels(true);
      } catch (e) { stats.error = '统计失败：' + e.message; }
      finally { stats.loading = false; }
    }
    // 弹窗里的 agent 下拉：与左侧栏是**同一个**筛选（改了它，背后的请求列表也跟着变），
    // 重算统计但保住日期区间 —— 改根的状态是根的事，这儿只把「选了谁」报上去。
    function onAgentChange(name) { emit('agent-change', name); }
    // 点最慢排行行 → 关统计框 → 在主列表里定位（跨组件的动作，归根做：列表状态在那儿）
    function gotoEntry(id) { emit('locate', id); }
    function reload() { load(false); }

    // 柱高按「当前这一档里的最大值」归一，而不是跟另一档共用纵轴：
    // 含缓存时缓存占 95%+，共用一个分母的话「输入+输出」那档会整片贴地看不见。
    // 代价是两档的纵轴刻度不同 —— 所以每档都自带「峰值」说明，别跨档比柱高。
    const stDenom = Vue.computed(() => {
      const f = stats.withCache ? (d => d.tin + d.tout + d.tcache) : (d => d.tin + d.tout);
      return Math.max(1, ...stats.days.map(f));
    });
    // 统计区间（= 图表可视窗）：默认最近 7 天，**只由日期选择器改** —— 区间驱动卡片/明细/按模型全部数字，
    // 曾在图上支持滚轮缩放、拖动平移，结果随手一滚底下数字全跳，撤了。
    // 归一分母用**全部天数**的最大值（stDenom），不切区间重标 —— 跨区间比柱高才成立。
    const statsView = Vue.computed(() => {
      const days = stats.days, T = days.length;
      if (!T) return { days: [], start: 0, end: 0, total: 0 };
      const n = Math.min(Math.max(3, stats.viewN), T);
      const end = stats.viewEnd == null ? T : Math.min(Math.max(Math.round(stats.viewEnd), n), T);
      return { days: days.slice(end - n, end), start: end - n, end, total: T };
    });
    const statsBars = Vue.computed(() => statsView.value.days.map(d => {
      const p = v => Math.max(0, Math.min(100, v / stDenom.value * 100));
      const total = d.tin + d.tout + d.tcache;
      return {
        ...d, short: d.day.slice(5).replace('-', '/'),
        hIn: p(d.tin), hOut: p(d.tout), hCache: stats.withCache ? p(d.tcache) : 0,
        tip: d.day + '　合计 ' + fmtN(total) + '（输入 ' + fmtN(d.tin) + ' / 输出 ' + fmtN(d.tout) + ' / 缓存 ' + fmtN(d.tcache)
          + '）　' + d.count + ' 条 · ' + fmtDurBig(d.dur),
      };
    }));
    // x 轴标签抽稀：太密全写会糊成一团（柱本身仍是一天一根，不合并）
    const statsTickEvery = Vue.computed(() => Math.max(1, Math.ceil(statsView.value.days.length / 9)));
    // 悬停读数：没悬停时落在可视窗内**最近一个有数据的天**，这样打开就能看见「今天」的数字
    const statsReadout = Vue.computed(() => {
      const v = statsView.value;
      const d = (hoverDay.value && v.days.find(x => x.day === hoverDay.value))
        || [...v.days].reverse().find(x => x.count);
      if (!d) return '可视范围内没有条目';
      const total = d.tin + d.tout + d.tcache;
      return (d.day === hoverDay.value ? '' : '最近：') + d.day.slice(5).replace('-', '/') + '　合计 ' + fmtN(total)
        + '（输入 ' + fmtN(d.tin) + ' / 输出 ' + fmtN(d.tout) + ' / 缓存 ' + fmtN(d.tcache) + '）　' + d.count + ' 条 · ' + fmtDurBig(d.dur);
    });
    // 卡片 / 概况 / 明细表的数字全部按**可视窗**现算：天桶里字段是全的，切片求和即可，不用回服务端。
    // 选的区间就是统计口径 —— 卡片、图表、明细表、按模型，四块永远在说同一段时间。
    const statsViewTotals = Vue.computed(() => {
      const t = { count: 0, tin: 0, tout: 0, tcache: 0, total: 0, dur: 0, calls: 0, tools: 0 };
      for (const d of statsView.value.days) {
        t.count += d.count; t.tin += d.tin; t.tout += d.tout; t.tcache += d.tcache;
        t.dur += d.dur; t.calls += d.calls; t.tools += d.tools;
      }
      t.total = t.tin + t.tout + t.tcache;
      return t;
    });
    // 「按模型」按可视窗从服务端现取。窗口每次变（选区间/快捷键）都重新取：
    // 防抖 250ms + 序号作废旧响应，快速连改不会打架。
    let modelTimer = null, modelSeq = 0;
    async function fetchModels() {
      const v = statsView.value;
      if (!v.days.length) { stats.models = []; stats.modelTotals = {}; stats.noModel = 0; stats.multi = 0; return; }
      // 「按模型」跟着统计弹窗的**可视窗**走（显式 from/to 就是可视窗），不重复带左侧区间：
      // 服务端 customBounds(from,to) 优先于 range，即使带了符号也是这个区间算，不如不传 ——
      // 所以下面两行 set 会把 req.qs 里可能已有的 from/to **覆盖**掉，只剩可视窗那一段。
      const qs = new URLSearchParams((props.req || {}).qs || '');
      qs.set('from', v.days[0].day);
      qs.set('to', v.days[v.days.length - 1].day);
      const my = ++modelSeq;
      stats.modelsLoading = true;
      try {
        const m = await getJSON('/api/models?' + qs.toString());
        if (my !== modelSeq) return;   // 窗口又变了，旧响应作废
        if (!m.ok) throw new Error(m.error || '按模型统计失败');
        stats.models = m.models || [];
        stats.modelTotals = m.totals || {};
        stats.noModel = m.noModel || 0;
        stats.multi = m.multi || 0;
        stats.modelError = '';
      } catch (e) { if (my === modelSeq) stats.modelError = '按模型统计失败：' + e.message; }
      finally { if (my === modelSeq) stats.modelsLoading = false; }
    }
    function queueModels(immediate) {
      clearTimeout(modelTimer);
      if (immediate) { fetchModels(); return; }
      modelTimer = setTimeout(fetchModels, 250);
    }
    // 统计区间 ↔ 日期选择器：picker 显示的就是当前区间；手选区间直接定位。
    // days 是按自然日连续分桶的，用字符串比较就能换算下标。
    function setViewByDates(from, to) {
      const days = stats.days, T = days.length;
      if (!T || !from || !to) return;
      const i0 = days.findIndex(d => d.day >= from);
      let i1 = days.findIndex(d => d.day > to);
      if (i1 === -1) i1 = T;
      const start = Math.max(0, i0 === -1 ? 0 : i0);
      const end = Math.min(T, Math.max(i1, start + 1));
      stats.viewN = end - start;
      stats.viewEnd = end;
      hoverDay.value = '';
    }
    const statsRange = Vue.computed({
      get() {
        const v = statsView.value;
        return v.days.length ? [v.days[0].day, v.days[v.days.length - 1].day] : null;
      },
      set(val) {
        if (!val) return;
        setViewByDates(val[0], val[1]);
        queueModels();
      },
    });
    // 数据范围外的日期禁选（第一天之前 / 最后一天之后）
    function statsDisabledDate(t) {
      const days = stats.days;
      if (!days.length) return false;
      const s = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
      return s < days[0].day || s > days[days.length - 1].day;
    }
    const statsShortcuts = ['近7天', '近30天', '近90天'].map((text, i) => ({
      text,
      value: () => {
        const d = stats.days, T = d.length;
        return T ? [d[Math.max(0, T - [7, 30, 90][i])].day, d[T - 1].day] : [new Date(), new Date()];
      },
    })).concat([{ text: '全部', value: () => { const d = stats.days; return d.length ? [d[0].day, d[d.length - 1].day] : [new Date(), new Date()]; } }]);
    const statsTiles = Vue.computed(() => {
      const t = statsViewTotals.value, all = t.total || 0;   // 卡片跟可视窗走，不看全量 totals
      // 占比：小于 10% 的留一位小数 —— 输出占 0.4% 时四舍五入成「0%」会被读成「这个数没意义/坏了」
      const pct = v => { const p = all ? v / all * 100 : 0; return all ? '占比 ' + (p >= 10 ? Math.round(p) : p.toFixed(1)) + '%' : ''; };
      return [
        { k: 'in', label: '输入（不含缓存）', color: 'var(--s-in)', value: t.tin || 0, sub: pct(t.tin || 0) },
        { k: 'out', label: '输出', color: 'var(--s-out)', value: t.tout || 0, sub: pct(t.tout || 0) },
        { k: 'cache', label: '缓存命中', color: 'var(--s-cache)', value: t.tcache || 0, sub: pct(t.tcache || 0) },
        // 合计按三项现算（服务端就是这么给的）：四个数字必须自洽，不然又是「合计 < 输入」那种卡片（§12）
        { k: 'total', label: '合计', value: all, sub: '= 输入 + 输出 + 缓存' },
      ];
    });
    const statsTableRows = Vue.computed(() => [...statsView.value.days].reverse());   // 只列可视窗内的天，新 → 旧，和列表一个方向

    // 按模型：条形长度用**绝对占比**（该模型合计 / 全部合计），不是按第一名归一 ——
    // 「deepseek 占七成」这种结论要一眼看得出来，归一化会把长尾拉得一样长。
    // 三个分段各自 = 该分量 / 全部合计，所以三段加起来正好等于这一行的占比。
    const statsModels = Vue.computed(() => {
      const tot = stats.modelTotals.total || 1;
      const rows = (stats.models || []).map(m => {
        const share = m.total / tot * 100;
        return {
          ...m, wIn: m.tin / tot * 100, wOut: m.tout / tot * 100, wCache: m.tcache / tot * 100,
          shareText: (share >= 1 ? share.toFixed(1) : share.toFixed(2)) + '%',
          tip: m.names.join(' / ') + '\n' + m.count + ' 条 · 输入 ' + m.tin.toLocaleString()
            + ' · 输出 ' + m.tout.toLocaleString() + ' · 缓存 ' + m.tcache.toLocaleString()
            + '\nagent：' + Object.entries(m.agents).map(([k, v]) => k + ' ' + v).join('、'),
        };
      });
      // 没有模型记录的条目单列一行（token 恒为 0，条形是空的）——不列出来的话，
      // 「各行条数之和」会比对话框顶上的「共 N 条」少一千多，看着像漏数据
      if (stats.noModel) rows.push({
        key: '__none__', none: true, label: '(无模型记录)', names: [], count: stats.noModel,
        total: 0, wIn: 0, wOut: 0, wCache: 0, shareText: '0%',
        tip: '这些条目的日志里没有模型字段（gemini 的 logs.json、读不到 Cursor IDE 会话库的 cursor 转录、atomcode 元信息缺失等）。\n本机实测它们的 token 恒为 0，所以只在「条数」上占位。',
      });
      return rows;
    });
    // 「耗时」这个量本机数据上是不干净的：一个挂机轮能占掉当天 95%（实测单轮 63 小时）。
    // 与其把总耗时当工作量报出去，不如把这种天数出来 —— 用户要拿它做决定，得先知道哪几天不能信。
    // 「最长单轮占一半以上」要再加一道下限（当天总耗时 ≥ 1 小时）才成立：只有 4 条、合计 2 分钟的一天，
    // 随手一条就能占一半，那不是挂机、是样本太小 —— 不加下限的话 20 个标记里大半是这种噪声。
    const isHeavyDay = d => !!d.count && d.dur >= 3600000 && d.maxDur * 2 > d.dur;
    const statsHeavyNote = Vue.computed(() => {
      const bad = statsView.value.days.filter(isHeavyDay);   // 只数可视窗里的天，跟表格看到的行一致
      if (!bad.length) return '';
      const list = bad.slice(-3).map(d => d.day.slice(5) + '（' + Math.round(d.maxDur / d.dur * 100) + '%）').join('、');
      return '本次统计里有 ' + bad.length + ' 天的耗时由单个挂轮主导，别当工作量看：' + list + (bad.length > 3 ? ' 等' : '') + '。';
    });

    // ---- R8 排行分析（时延维度：最慢轮 TopN + p50/p95）+ I6 工具失败画像 ----
    // 打开「时延分析」tab 时按当前筛选拉一次 /api/analyze（不随统计打开自动请求），
    // 四个子 tab（最慢轮 / 工具调用 / 缓存命中率 / 工具失败画像）共用同一份 ana.data，切换不再取数。
    const ana = Vue.reactive({ loading: false, data: null, sub: 'lat' });   // sub: lat|tools|cache|fail
    // ---- I15 工作指纹（git 分支 / 权限模式 / 产品版本）----
    // 打开「工作指纹」tab 时按当前筛选拉一次 /api/work（懒加载，与时延分析同款）。三个维度
    // （branch / permMode / cliVer）共用一份 work.data，切换维度只换视图不动请求。
    const work = Vue.reactive({ loading: false, data: null, dim: 'branch' });
    async function loadWork() {
      work.loading = true;
      try {
        // 用 req.qs 打底（左侧区间 + 筛选）：/api/work 与 /api/daily 同口径（agent/project/range/from/to）
        const q = new URLSearchParams((props.req || {}).qs || '');
        const j = await getJSON('/api/work?' + q.toString());
        work.data = j.ok ? j : null;
      } catch { work.data = null; }
      finally { work.loading = false; }
    }
    // 当前维度分桶的视图行：条形按**本次最大 token**归一（与统计主图同理），token 并列按条数、再按名字
    const workData = Vue.computed(() => work.data || null);
    const curDim = Vue.computed(() => {
      const d = workData.value;
      if (!d || !d[work.dim]) return { rows: [], noVal: 0, noValTotal: 0, noValDur: 0, noValShareText: '' };
      const dim = d[work.dim];
      const tot = (d.totals && d.totals.total) || 1;
      return {
        ...dim,
        noValShareText: dim.noValTotal ? (dim.noValTotal / tot * 100).toFixed(1) + '%' : '',
      };
    });
    const workRows = Vue.computed(() => {
      const dim = curDim.value;
      const maxTotal = dim.rows.reduce((m, r) => Math.max(m, r.total || 0), 0) || 1;
      const tot = (workData.value && workData.value.totals && workData.value.totals.total) || 1;
      return dim.rows.map(r => ({
        ...r,
        w: Math.max(2, Math.round((r.total || 0) / maxTotal * 100)),
        shareText: r.total ? (r.total / tot * 100).toFixed(1) + '%' : '0%',
      }));
    });
    async function loadAnalyze() {
      ana.loading = true;
      try {
        // 与按动物模型同理：用 req.qs 打底（左侧区间 + 筛选），只加一个 top
        const q = new URLSearchParams((props.req || {}).qs || '');
        q.set('top', '10');
        const j = await getJSON('/api/analyze?' + q.toString());
        ana.data = j.ok ? j : null;
      } catch { ana.data = null; }
      finally { ana.loading = false; }
    }
    // 缓存命中率条目的颜色：命中率越高越偏绿（var(--s-cache) 系），0~100% 线性映射到 —> 用不透明度表达强弱
    function cachePctColor(rate) {
      const p = Math.max(0, Math.min(1, rate || 0));
      return { background: 'var(--s-cache)', opacity: Math.max(0.25, 0.25 + 0.75 * p) };
    }

    // ---- I6/I13 工具失败画像（同一个 /api/analyze 返回里的 toolFails；不另发请求、不前端二次聚合）----
    const tfData = Vue.computed(() => (ana.data && ana.data.toolFails)
      || { rows: [], agents: [], minTotal: 0, totals: { err: 0, timeout: 0, soft: 0 } });
    const tfSum = Vue.computed(() => {
      const o = { turns: 0, known: 0, unknown: 0, failTurns: 0, softTurns: 0, building: 0,
        totals: tfData.value.totals || { err: 0, timeout: 0, soft: 0 } };
      for (const c of tfData.value.agents || []) {
        o.turns += c.turns || 0; o.known += c.known || 0; o.unknown += c.unknown || 0;
        o.failTurns += c.failTurns || 0; o.softTurns += c.softTurns || 0;
      }
      o.building = tfData.value.building || 0;
      return o;
    });
    // 条形按**本次最高的那个率**归一，不按 100% 归一：真实失败率都在个位数百分比，
    // 按满刻度画会得到一排看不见的空条；而相对归一的代价在下面那行小字里写明了。
    const tfRowsView = Vue.computed(() => {
      const rows = tfData.value.rows || [];
      const maxRate = rows.reduce((m, r) => Math.max(m, r.rate || 0), 0) || 1;
      return rows.map(r => ({ ...r,
        w: Math.max(2, Math.round((r.rate || 0) / maxRate * 100)),
        rateText: r.rate == null ? '—' : fmtPct(r.rate),
        // I13：构成里超时是**算进失败**的，软失败单列（不进 fail / 不进率）。没有这一层的来源
        // （timeout/soft 为 null）就整段不印 —— 印成「超时 0 次」会被读成"这个 agent 一次没超时"。
        tip: r.agent + ' 的 ' + r.name + '：失败 ' + r.fail + ' 次 / 调用 ' + r.total + ' 次'
          + (r.rate == null ? '' : '（' + fmtPct(r.rate) + '）')
          + '\n构成：出错 ' + (r.err || 0) + ' 次'
          + (r.timeout == null ? '' : ' · 超时 ' + r.timeout + ' 次（算失败）')
          + (r.soft == null ? '' : ' · 软失败 ' + r.soft + ' 次（单列，不算失败）')
          + (r.lowDenom ? '\n分母不足 ' + tfData.value.minTotal + ' 次，这个率是偶发而不是倾向' : '')
          + '\n失败判定 = 解析器落在 tools[].error / .timeout / .soft 上的结构化标志（不扫正文）',
      }));
    });
    // 空列表有两种完全不同的原因：核对过确实没失败 vs 根本没核对到。并成一句就是把「还不知道」
    // 说成「没问题」，这条画像最容易造的假绿就在这儿。I13 补第三种：只有软失败时排行也是空的，
    // 但那是「看到了、判定为正常」，得说出来，别让它读成「什么都没发生」。
    const tfEmptyText = Vue.computed(() => tfSum.value.known
      ? '已核对的 ' + tfSum.value.known + ' 轮里，没有一个工具带失败标志。'
        + (tfSum.value.totals.soft ? '（另有 ' + tfSum.value.totals.soft + ' 次软失败，单列一档、不参与这个排行）' : '')
      : (tfSum.value.unknown
        ? '带工具的轮还一轮都没索引到（' + tfSum.value.unknown + ' 轮待索引）—— 现在给不出失败画像，等后台建完索引或点「重新统计」。'
        : '这一批筛选里没有带工具调用的轮。'));
    const TF_TIER_TEXT = { signal: '有失败信号', noDetail: '源头不给工具明细', noFlag: '工具行没有失败标志', unknown: '来源未登记' };
    const tfCovView = Vue.computed(() => (tfData.value.agents || []).map(c => ({ ...c,
      tierText: TF_TIER_TEXT[c.tier] || c.tier,
      // I13：超时/软失败是**另一份能力**，与上面那三档正交 —— claude 系有、别家源里没有。
      tsText: c.tsSig ? '超时/软失败：有信号' : '超时/软失败：源里没有',
      rateText: c.tier !== 'signal' ? '不画（' + (TF_TIER_TEXT[c.tier] || '未知来源') + '）'
        : c.known > 0 ? fmtPct(c.failTurns / c.known) + ' 的轮含失败工具'
          : c.unknown > 0 ? '未核对' : '无数据',
    })));

    // 打开时按递进来的 req 拉一次；开着的时候 agent/筛选变了会再递一份（n 变），也走这儿。
    // visible 关掉时源值归 0 —— 不会误触发。
    Vue.watch(() => (props.visible && props.req ? props.req.n : 0), n => { if (n) load(!!(props.req && props.req.keepRange)); });

    // 模板只能看见 setup return 里的键：shared.js 的格式化函数在本文件作用域里能直接调（经典 script 全局），
    // 但模板编译成 with(_ctx) 后只认 props / return / 已注册组件 / JS 内建。要用的必须列出来。
    return {
      stats, hoverDay, ST_GAP, statsRange, statsTiles, statsBars, statsTickEvery, statsReadout,
      statsViewTotals, statsTableRows, statsModels, isHeavyDay, statsHeavyNote,
      statsDisabledDate, statsShortcuts, ana, loadAnalyze, cachePctColor, onAgentChange, gotoEntry, reload,
      tfData, tfSum, tfRowsView, tfEmptyText, tfCovView,
      work, loadWork, workData, curDim, workRows,
      fmtN, fmtDur, fmtDurBig, fmtTime, fmtPct,
    };
  }
};
