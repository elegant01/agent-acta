// 请求日志视图（R25 批 4）：页头（标题行 + 一排筛选）+ 骨架屏 + 空态 + 卡片列表 + 加载更多 + 回到顶部。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 根节点是 **fragment**（`<main>` 与 `<button class="back-top">` 两个）—— 改前这两个就是兄弟节点，
// `.back-top` 靠 `position: fixed` 定位、与 `.main` 无父子选择器关系，所以搬在一起不动布局。
// fragment 的代价：落在组件标签上的属性与非声明的监听器都会被丢掉，所以 emit 必须逐个声明、逐个接。
//
// ⚠ 不变式（改这个文件前先读）：
//   1. `.main` 是**唯一**的滚动容器，且这一份必须是 `v-show` 不能 `v-if`：销毁重建会丢滚动位置和已展开的详情。
//      （会话视图那一份是 v-if —— 它自己两栏内滚，不共享这个滚动位置。）
//   2. `v-memo` 留在这里的 v-for 上，依赖表 `cardMemo` 是**根传进来的函数**。卡片模板新增读任何响应式状态，
//      都必须同步给根里的 cardMemo 加一项，漏一个就是「点了没反应」（memo 相等 → 整棵子树跳过重渲）。
//   3. 滚动相关的三个状态（mainScroll / showTop 与那两个函数）是本批**唯一**搬进组件的状态 ——
//      它们只服务于这一棵子树：根里的 locateEntry 与 collapseCard 都用 `document.getElementById('card-'+id)`
//      / `ev.target.closest('.card')` 拿元素，不经过这个 ref，所以不需要 defineExpose 递出去。
//      其余状态（筛选、条目、详情缓存、折叠开关）一个都不搬，理由同批 3：见 agent-log-requirements.md R25。
window.AACTA = window.AACTA || {};
AACTA.LogView = {
  name: 'aa-log-view',
  template: `
    <main class="main" ref="mainScroll" v-show="active" @scroll.passive="onMainScroll">
      <div class="page-head">
        <div>
          <h1>请求日志</h1>
          <!-- R33：搜索态下「共 N 条」会撒谎 —— 那个 N 是**当前窗口**的条数（几百到 5000），
               而搜索覆盖的是全库。两句话不能同时出现，否则「共 2000 条 · 命中 30 条」看着像自相矛盾。 -->
          <div v-if="searchOn" class="statline">全库搜索 · 命中 {{ filtered.length }} 条</div>
          <div v-else class="statline">共 {{ all.length }} 条 · 匹配 {{ filtered.length }} 条<span v-if="capped" style="color:#c26a1b"> · 仅保留最近 5000 条</span><!-- R5：失败聚合入口，点击直接筛出失败条目 --><span v-if="failCount" class="fail-link" @click="$emit('fail-toggle')"> · <b>{{ fStatus==='error' ? '退出失败筛选' : '失败 ' + failCount + ' 条' }}</b></span></div>
        </div>
        <div class="filters">
          <!-- 搜索有**两档**，必须都在提示里说清楚，否则用户拿标题行的总条数对照「匹配 0 条」会以为搜索坏了：
               ① 敲字 = 客户端过滤，只作用于已拉回来的窗口条目（见根里的 filtered 注释）；
               ② 回车 = 走后端全文索引（R33 / I10），跨 agent、跨未加载历史，还能搜到 AI 回复与工具正文。
               不额外加「全库」按钮：.filters 里的 el-input 固定 220px，塞 append 按钮会把输入区挤窄一圈；
               回车是标准动作，提示里写明白就够，搜完还有横幅可以一键清除。 -->
          <el-input :model-value="fSearch" @update:model-value="v => $emit('update:f-search', v)"
            @keyup.enter="$emit('search-run')"
            :placeholder="searchOn ? '已全库搜索；改词后再回车重搜' : '当前 ' + all.length + ' 条内过滤，回车搜全库'"
            clearable :prefix-icon="searchIcon"></el-input>
          <!-- R10 agent 多选：只在侧栏处于「全部」（fAgent 为空）时显示且有效 ——
               点了具体 agent 后隐藏，避免「侧栏单选 + 多选」两个筛选打架。空 = 全部，勾 N 个 = 合集 -->
          <el-select v-show="!fAgent" :model-value="fAgents" @update:model-value="v => $emit('update:f-agents', v)" multiple collapse-tags collapse-tags-tooltip
            placeholder="全部 agent（可多选）" clearable filterable class="multi-sel"
            title="agent 多选：仅侧栏为「全部」时生效；空 = 全部" @change="v => $emit('agents-multi', v)">
            <el-option v-for="n in sideAgents.filter(x => !isIconOnly(x))" :key="n" :label="n" :value="n"></el-option>
          </el-select>
          <!-- R10 项目多选：暂时隐藏（2026-09-17 用户拍板：项目筛选整体不用）。逻辑与深链保留，恢复只需解开这段注释
          <el-select v-model="fProjects" multiple collapse-tags collapse-tags-tooltip
            placeholder="全部项目（可多选）" clearable filterable class="multi-sel"
            title="项目多选：空 = 全部" @change="pickProjectsMulti">
            <el-option v-for="p in projectList" :key="p.key" :value="p.key" :title="p.names.join('\\n')"
              :label="p.names.length > 1 ? p.label + '（' + p.names.length + ' 种写法）' : p.label"></el-option>
          </el-select>
          -->
          <!-- 项目单选下拉暂时隐藏（2026-09-17 用户拍板）：多选一个就够，单选场景 = 只勾一个。
               fProject 及其 pickProject / 深链逻辑全部保留未动，恢复只需解开这段注释
          <el-select v-model="fProject" placeholder="全部项目" clearable filterable @change="pickProject">
            <el-option v-for="p in projectList" :key="p.key" :value="p.key" :title="p.names.join('\\n')"
              :label="p.names.length > 1 ? p.label + '（' + p.names.length + ' 种写法）' : p.label"></el-option>
          </el-select>
          -->
          <!-- R22 时间范围：与用量统计同款的**具体日期区间**（YYYY-MM-DD，本地自然日），默认最近 2 天；
               清空 = 全部时间。仍走服务端收窄（显式 from/to，复用 customBounds，挂过午夜不漂移）。
               符号快捷档（today/7d/30d）从 UI 撤下；旧深链 \`range=\` 链接在 restoreFromHash 里换算成日期区间 -->
          <el-date-picker :model-value="fDates" @update:model-value="v => $emit('update:f-dates', v)" type="daterange" class="rng-picker" value-format="YYYY-MM-DD"
            range-separator="至" start-placeholder="开始" end-placeholder="结束" clearable
            title="具体日期范围（默认最近 2 天）；清空 = 全部时间，与用量统计同一套自然日口径"
            @change="v => $emit('range-change', v)"></el-date-picker>
          <el-select :model-value="fStatus" @update:model-value="v => $emit('update:f-status', v)" placeholder="全部状态" clearable class="slim" @change="$emit('status-change')">
            <el-option label="成功" value="ok"></el-option>
            <el-option label="出错" value="error"></el-option>
          </el-select>
          <!-- R9 只看异常：按异常巡检命中集合过滤主列表（与状态/搜索可叠加），没命中时不点亮 -->
          <el-checkbox :model-value="alertOnly" @update:model-value="v => $emit('update:alert-only', v)"
            class="alert-only-cb" title="只显示异常巡检命中的条目（可在异常巡检弹层配置规则）">
            只看异常<template v-if="alertCount">({{ alertCount }})</template>
          </el-checkbox>
          <el-select :model-value="fLimit" @update:model-value="v => $emit('update:f-limit', v)" class="slim" @change="v => $emit('limit-change', v)">
            <el-option label="50 条/页" :value="50"></el-option>
            <el-option label="100 条/页" :value="100"></el-option>
            <el-option label="200 条/页" :value="200"></el-option>
            <el-option label="500 条/页" :value="500"></el-option>
          </el-select>
          <el-button circle :icon="trendIcon" title="用量统计（按天聚合，跟随当前筛选）" @click="$emit('open-stats', $event)"></el-button>
          <!-- R11 导出增强：原 JSON 按钮升级为「导出当前筛选结果」下拉，选格式（JSON/CSV/Excel）。
               筛选条件会随文件带出（CSV/Excel 首行、JSON meta），不丢「按什么条件导出」的上下文 -->
          <el-dropdown trigger="click" @command="k => $emit('export-json', k)">
            <el-button circle :icon="downloadIcon" title="导出当前筛选结果"></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="json">导出为 JSON</el-dropdown-item>
                <el-dropdown-item command="csv">导出为 CSV（可直接在表格软件打开）</el-dropdown-item>
                <el-dropdown-item command="xls">导出为 Excel</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button circle :icon="refreshIcon" title="刷新" @click="$emit('refresh', $event)"></el-button>
        </div>
      </div>

      <!-- R33 全文搜索的结果条（只在搜索态出现）。三件事必须写全，少一件就会误导：
           ① 搜的是什么词；② 命中多少；③ **索引覆盖到哪了** —— 索引是后台一点点建的，
           没建完时「没搜到」的意思是「还没索引到」，不写出来就会被读成「没有这条日志」。
           另有三条如实交代：读不出源文件的条数、命中里有多少条已滑出内存窗口、以及这一轮被服务端
           单轮条数上限截断了吗（capped —— 少了这条，「命中 200 条」会被读成全库就 200 条）。 -->
      <div v-if="searchOn" class="search-bar">
        <span>全文搜索「<b>{{ searchQ }}</b>」<template v-if="searchRegex">（正则）</template> · 命中 <b>{{ filtered.length }}</b> 条</span>
        <span v-if="searchError" class="sb-err">· {{ searchError }}</span>
        <template v-else>
          <span v-if="searchCapped" class="sb-meta"
            :title="'服务端这一轮只取回前 ' + searchHitsCount + ' 条（/api/search 的 limit，默认 200），全库命中其实更多 —— 上面那个「命中 N 条」说的是取回来的这些。要看得更全：换更具体的词、勾「限定当前时间范围」，或先用侧栏把 agent / 项目收窄'">· 命中不止这些，本次只取回 {{ searchHitsCount }} 条</span>
          <span class="sb-meta">· {{ searchMeta.building ? '索引构建中，已覆盖' : '已索引' }}
            {{ searchMeta.entries || 0 }}/{{ searchMeta.total || 0 }} 条</span>
          <span v-if="searchMeta.stale" class="sb-meta"
            title="这些条目命中了，但已滑出服务端的内存窗口（LRU），这一轮拿不到它们的统计字段">· 另有 {{ searchMeta.stale }} 条在内存窗口外</span>
          <span v-if="searchMeta.unreadable" class="sb-meta"
            title="这几条没有可索引的正文：源文件读不出来了（多半被产品删了），或者这一轮本来就没有正文（例如 atomcode 的空转录——它的对话在 .snapshot 里，不在 jsonl 里）。它们仍可按会话名 / 模型 / 工具名搜到">· {{ searchMeta.unreadable }} 条没有正文</span>
          <span v-if="!searchNarrow" class="sb-meta">· 未套用时间范围</span>
        </template>
        <span class="sb-spacer"></span>
        <el-checkbox :model-value="searchNarrow" @update:model-value="v => $emit('search-toggle-narrow', v)"
          title="默认搜全部历史（这正是全文搜索的意义）；勾上 = 只搜当前日期区间里的条目">限定当前时间范围</el-checkbox>
        <el-button size="small" @click="$emit('search-clear')">清除</el-button>
      </div>

      <!-- 首份快照还没回来 → 骨架屏。形状照抄真卡片（顶行 + 三格指标 + 脚注），一眼看出是「在加载」而不是「没有」 -->
      <div v-if="booting" class="sk-list">
        <div v-for="n in 4" :key="n" class="sk-card">
          <div class="sk-top">
            <div class="sk-av"></div>
            <div class="sk-body">
              <div class="sk-line l1"></div>
              <div class="sk-line l2"></div>
            </div>
          </div>
          <div class="sk-metrics">
            <div class="sk-box"></div>
            <div class="sk-box"></div>
            <div class="sk-box"></div>
          </div>
          <div class="sk-foot"><div class="sk-line l3"></div></div>
        </div>
      </div>
      <div v-else-if="!visible.length" class="empty">
        <!-- 扫描中优先：冷启动时列表本来就是空的，写「暂无匹配」会被读成「没数据/坏了」 -->
        <template v-if="scanning">正在扫描…（{{ scanning.done }}/{{ scanning.total }}）</template>
        <!-- 搜索无果且范围里有未进窗口的历史条目时，必须说明「为什么搜不到」，否则用户以为没有这条日志 -->
        <template v-else-if="fSearch && !filtered.length && rangeTotal > all.length">当前 {{ all.length }} 条中无匹配；该范围内共 {{ rangeTotal }} 条，历史条目未参与搜索，请调大「条/页」后重试</template>
        <template v-else>暂无匹配的请求记录</template>
      </div>

      <!-- v-memo：展开/收起一张卡时 expandedId 一变，整棵 vnode 子树都会重建 —— 没有 memo 的话
           200 张卡（含 ~2000 个 el-tooltip/el-icon 实例）全部重新 diff，实测主线程 65~150ms。
           memo 依赖见**根里的** cardMemo（它读的是根那一份状态，作函数 props 递进来）：
           收起的卡只看条目本体和 live 标志，展开的卡把详情相关状态全列上。 -->
      <aa-log-card v-for="e in visible" :key="e.id" v-memo="cardMemo(e)"
        :e="e" :expanded="expandedId === e.id" :detail="detailOf(e.id)" :secs="secs"
        :call-open="callOpen" :tool-json-fold="toolJsonFold" :full-ids="fullIds"
        :title-of="titleOf" :is-live="isLive"
        :compare-sel="compareIsOf(e.id)"
        @toggle="onToggle" @open-session="onOpenSession" @collapse="onCollapse" @load-full="onLoadFull"
        @fold-json="onFoldJson" @fold-callout="onFoldCallout" @toggle-sec="onToggleSec" @reload-detail="onReloadDetail" @export-detail="onExportDetail" @export-repro="onExportRepro" @compare="onCompare"></aa-log-card>

      <el-button v-if="shown < filtered.length" id="loadmore" plain @click="$emit('load-more')">
        加载更多（还有 {{ filtered.length - shown }} 条）
      </el-button>
    </main>

    <!-- R21 回到顶部悬浮按钮：fixed 右下角，滚动超过一屏才出现（见本文件的 onMainScroll）；
         展开详情时上移让开吸底的「收起」（.detail-foot，sticky bottom:0），窄窗口也不遮挡 -->
    <button v-show="showTop && active" class="back-top" :class="{shift: expandedId !== null}" title="回到顶部" @click="scrollMainTop">
      <el-icon><Top></Top></el-icon>
    </button>`,
  props: {
    // view === 'log'：两个视图共用一个根，靠这个开关显隐（v-show，见头部不变式 1）
    active: Boolean,
    booting: Boolean,
    scanning: { type: Object, default: null },
    // 条目：all 是窗口本体（标题行/搜索提示要它的长度），filtered 是客户端筛选结果，visible 是本页要画的
    all: { type: Array, default: () => [] },
    filtered: { type: Array, default: () => [] },
    visible: { type: Array, default: () => [] },
    capped: Boolean,
    failCount: { type: Number, default: 0 },
    rangeTotal: { type: Number, default: 0 },
    // 五个筛选（状态全在根：深链 restoreFromHash / snapUrl / 侧栏共用同一份）
    fSearch: { type: String, default: '' },
    fAgents: { type: Array, default: () => [] },
    fAgent: { type: String, default: '' },
    fDates: { type: Object, default: null },
    fStatus: { type: String, default: '' },
    fLimit: { type: Number, default: 200 },
    // R9 只看异常：只显示命中集合里的条目（alertOnly 归根，命中计数进标题提示）
    alertOnly: { type: Boolean, default: false },
    alertCount: { type: Number, default: 0 },
    // 项目那两个筛选 2026-09-17 起停用，模板里只剩注释块（page-check 连注释一起扫，故要声明）；
    // 照样从根递值进来，将来解开注释即刻可用。
    fProjects: { type: Array, default: () => [] },
    fProject: { type: String, default: '' },
    projectList: { type: Array, default: () => [] },
    pickProject: { type: Function, required: true },
    pickProjectsMulti: { type: Function, required: true },
    sideAgents: { type: Array, default: () => [] },
    isIconOnly: { type: Function, required: true },
    shown: { type: Number, default: 200 },
    // R33 全文搜索（I10）：搜索态下 filtered 的数据源在根里换成了服务端命中集，本组件只负责显示与转发。
    // searchMeta = 服务端索引的覆盖情况（entries/total/building）叠加本次查询的 stale/unreadable。
    searchOn: { type: Boolean, default: false },
    searchQ: { type: String, default: '' },
    searchRegex: { type: Boolean, default: false },
    searchBusy: { type: Boolean, default: false },
    searchNarrow: { type: Boolean, default: false },
    searchError: { type: String, default: '' },
    searchMeta: { type: Object, default: () => ({}) },
    // capped 由服务端算（命中数 > 这一轮的 limit），页面只负责把它说出来；hits 数是取回来的条数，
    // 不是全库命中数 —— 横幅上那两个数各说各的，正是这条提示要防的误读。
    searchCapped: { type: Boolean, default: false },
    searchHitsCount: { type: Number, default: 0 },
    // 卡片与详情：expandedId 决定哪张展开（也决定「收起」按钮让位），secs 是当前展开卡那三个长列表视图
    expandedId: { type: [String, Number], default: null },
    secs: { type: Object, default: null },
    callOpen: { type: Object, default: () => new Set() },
    toolJsonFold: { type: Object, default: () => new Set() },
    fullIds: { type: Object, default: () => new Set() },
    // I9 两轮 diff：判这条在不在对比组里（函数 prop —— 它读根里的对比 Set，不搬进组件）
    compareIsOf: { type: Function, required: true },
    // 四个读根状态的函数以函数形态作 props 传入（批 2/3 的先例）：memo 表也在根
    cardMemo: { type: Function, required: true },
    detailOf: { type: Function, required: true },
    titleOf: { type: Function, required: true },
    isLive: { type: Function, required: true },
    // Element Plus 图标是**表达式**不是组件标签，全局注册帮不上，只能从根递进来（批 3 的 searchIcon 同款）
    searchIcon: { type: [Object, Function], required: true },
    trendIcon: { type: [Object, Function], required: true },
    downloadIcon: { type: [Object, Function], required: true },
    refreshIcon: { type: [Object, Function], required: true },
  },
  emits: ['update:f-search', 'update:f-agents', 'agents-multi', 'update:f-dates', 'range-change',
    'update:f-status', 'status-change', 'update:f-limit', 'limit-change', 'fail-toggle',
    'update:alert-only',
    'open-stats', 'export-json', 'refresh', 'load-more',
    'toggle', 'open-session', 'collapse', 'load-full', 'fold-json', 'fold-callout', 'toggle-sec', 'reload-detail', 'export-detail', 'export-repro',
    // I9 两轮 diff：卡片「对比」点上来（选满两条由根弹开）
    'compare',
    // R33：搜索框回车走服务端全文搜索；清除与「限定时间范围」也在横幅上转发回根
    'search-run', 'search-clear', 'search-toggle-narrow'],
  setup(props, { emit }) {
    // 滚动三件套（本批唯一搬进来的状态，见头部不变式 3）：.main 是唯一滚动容器，
    // 只在滚动超过一屏时出现按钮；点击平滑回顶。展开详情时按钮上移由模板的 :class.shift 负责。
    const mainScroll = Vue.ref(null);
    const showTop = Vue.ref(false);
    function onMainScroll() {
      const el = mainScroll.value;
      showTop.value = !!(el && el.scrollTop > el.clientHeight);
    }
    function scrollMainTop() {
      const el = mainScroll.value;
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }
    // 卡片转发上来的八个事件用**成员表达式**监听（不是内联语句）：Vue 直接把函数交给监听器，
    // 于是 emit 的全部实参都原样传到根 —— 内联的 $event 只有第一个，collapse 的 $event、
    // fold-json 的 (id, i, which) 会静默丢掉（静态检查查不出，实测才发现，见批 3 的先例 ④）。
    const fwd = k => (...a) => emit(k, ...a);
    return {
      mainScroll, showTop, onMainScroll, scrollMainTop,
      onToggle: fwd('toggle'), onOpenSession: fwd('open-session'), onCollapse: fwd('collapse'),
      onLoadFull: fwd('load-full'), onFoldJson: fwd('fold-json'), onFoldCallout: fwd('fold-callout'),
      onToggleSec: fwd('toggle-sec'), onReloadDetail: fwd('reload-detail'), onExportDetail: fwd('export-detail'),
      onExportRepro: fwd('export-repro'),
      onCompare: fwd('compare'),
    };
  }
};
