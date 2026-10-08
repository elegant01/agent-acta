// 请求日志的一张卡片（R25 批 4）：顶行 + 三格指标 + 脚注 + 展开后的详情。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 为什么详情没有再拆一个 aa-log-detail（文档原计划里有）：详情要读的那一份状态（secs / callOpen /
// toolJsonFold / fullIds / detail）卡片这边也得读，拆两个文件就只有两种下场 —— 卡片把七八个 props
// 原样转手一遍（文档明令禁止的「聪明透传」），或者走 provide/inject 把 page-check 的可用面查成一个瞎子。
// 合成一个文件 220 行，离 600 行的预算还早，于是按「一个卡片一个组件」落地。
//
// ⚠ v-memo 的依赖表（根里的 cardMemo）**不在这个文件里**，它挂在 aa-log-view 的 v-for 上：
// memo 判的是「这次要不要重渲染这一整棵子树」，跳过了连 props 都不会更新。所以**卡片模板新增读任何
// 响应式状态，都必须同步给 cardMemo 加一项**，漏一个就是「点了没反应」——这条注释在 aa-log-view 里也有一份。
window.AACTA = window.AACTA || {};
AACTA.LogCard = {
  name: 'aa-log-card',
  template: `
    <div :id="'card-' + e.id" class="card" :class="{sel: expanded, failed: e.status!=='ok'}" @click="$emit('toggle', e.id)">
      <div class="card-top">
        <img v-if="iconOf(e)" class="avatar-img" :src="iconOf(e)">
        <span v-else class="avatar" :style="{background: agentColor(e.agent)}">{{ agentLetter(e.agent) }}</span>
        <div class="title-block">
          <div class="title-line">
            <b>{{ titleOf(e) }}</b>
            <span class="mini-tag">{{ e.agent }}</span>
            <span v-if="e.nollm" class="mini-tag" style="color:var(--placeholder)">非 LLM</span>
          </div>
          <div class="sub-line">{{ e.preview || '(无文本预览)' }}</div>
          <!-- R33 全文搜索的命中片段（只在搜索态、且这一条确实命中正文时有）。为什么不能省：
               preview 是**用户输入**的前 300 字，而全文搜索多半命中的是 AI 回复或工具返回 ——
               片段不摆出来的话，用户看着卡片上那段毫不相干的预览会以为「这条为什么算命中」。
               三段分开渲染而不是拼 HTML：服务端只回原文，转义交给 Vue 的 {{ }}，谁也不碰 innerHTML。 -->
          <div v-if="e._snip" class="snip-line">
            <span v-if="e._snip.pre">…{{ e._snip.pre }}</span><mark>{{ e._snip.hit }}</mark><span v-if="e._snip.post">{{ e._snip.post }}…</span>
          </div>
        </div>
        <div class="tags-right">
          <span class="tag" :class="e.status==='ok' ? 'tag-ok' : 'tag-err'">{{ e.status==='ok' ? 'OK' : 'ERR ⚠' }}</span>
          <span v-if="e.aborted" class="tag tag-plain">已打断</span>
          <span class="tag tag-plain">{{ fmtDur(e.dur) }}</span>
          <!-- I17 非 LLM 时间分解：墙钟里混着挂机/隔夜，卡片主 tag 是墙钟；真实工作时间（产品自报
               turn_duration）明显更短时补一个哑色「实际」徽章说明差额，相等时不显示免得满屏噪声。 -->
          <span v-if="e.rdur && e.rdur < e.dur" class="tag tag-plain tag-rdur"
            :title="'实际工作时间（产品自报，已剥掉挂机/隔夜）：' + fmtDur(e.rdur) + '，墙钟为 ' + fmtDur(e.dur)">实际 {{ fmtDur(e.rdur) }}</span>
          <!-- I9 两轮 diff：勾选这条参与对比（点一下标入对比组，凑满两条自动弹开） -->
          <span class="cmp-pick" :class="{on: compareSel}" :title="compareSel ? '已选中，点一下取消；再选一条即可对比' : '选这条参与两轮对比（再选一条自动弹出对比）'"
            @click.stop="$emit('compare', e)">{{ compareSel ? '✓ 已选' : '对比' }}</span>
        </div>
      </div>

      <div class="metrics">
        <div class="m-group">
          <div class="m-label">{{ isQoder(e) ? '积分' : 'Token' }}
            <el-tooltip placement="top" effect="dark" :show-after="200">
              <template #content>
                <div class="tok-tip">
                  <template v-if="isQoder(e)">
                    <div class="tr"><span>本轮积分</span><span>{{ fmtCredits(e.credits) }}</span></div>
                    <div class="sep"></div>
                    <div class="tr"><span>说明</span><span>qoder 按积分计费，不暴露 token</span></div>
                  </template>
                  <template v-else>
                    <div class="tr"><span>输入</span><span>{{ (e.tin||0).toLocaleString() }}</span></div>
                    <div class="tr"><span>输出</span><span>{{ (e.tout||0).toLocaleString() }}</span></div>
                    <div class="tr"><span>缓存命中</span><span>{{ (e.tcache||0).toLocaleString() }}</span></div>
                    <div class="sep"></div>
                    <div class="tr"><span>合计</span><span>{{ (e.total||0).toLocaleString() }}</span></div>
                  </template>
                  <!-- I12 压缩画像：与计费口径无关，qoder / token 两种卡片共用这一块。
                       「丢多少 / 等多久」只有源里真有这一位才说（compDrop 是 claude 独有），
                       缺席不补 0 —— 否则会把「没记」读成「压了却没丢」。 -->
                  <template v-if="e.compacts">
                    <div class="sep"></div>
                    <div class="tr"><span>压缩次数</span><span>{{ e.compacts }}<template v-if="e.compAuto || e.compManual">（自动 {{ e.compAuto }} / 手动 {{ e.compManual }}）</template></span></div>
                    <div class="tr" v-if="e.compPre"><span>压缩前 token</span><span>{{ (e.compPre||0).toLocaleString() }}</span></div>
                    <div class="tr" v-if="e.compPost"><span>压缩后 token</span><span>{{ (e.compPost||0).toLocaleString() }}</span></div>
                    <div class="tr" v-if="e.compDrop"><span>丢弃 token</span><span>{{ (e.compDrop||0).toLocaleString() }}</span></div>
                    <div class="tr" v-if="e.compMs"><span>压缩等待</span><span>{{ fmtDur(e.compMs) }}</span></div>
                  </template>
                </div>
              </template>
              <!-- 图标是全局注册的组件（根 script 把 ElementPlusIconsVue 全登记了）。kebab-case 是沿用改前
                   in-DOM 时代的写法（那时浏览器会把 <QuestionFilled> 降成 <questionfilled>）；现在这段是
                   JS 字符串模板，标签名不再被小写化，两种写法 Vue 都按 camelize + 首字母大写去查注册表。 -->
              <el-icon class="tok-q"><question-filled></question-filled></el-icon>
            </el-tooltip>
          </div>
          <div class="m-vals">
            <template v-if="isQoder(e)">
              <span class="m-val hi"><el-icon><Coin></Coin></el-icon>{{ fmtCredits(e.credits) }} <small>积分</small></span>
              <span v-if="e.compacts" class="m-val"><el-icon><Refresh></Refresh></el-icon>{{ e.compacts }} <small>压缩</small></span>
            </template>
            <template v-else-if="e.total || e.tin || e.tout || e.tcache">
              <span class="m-val"><el-icon><Top></Top></el-icon>{{ fmtN(e.tin) }}</span>
              <span class="m-val"><el-icon><Bottom></Bottom></el-icon>{{ fmtN(e.tout) }}</span>
              <span class="m-val hi"><el-icon><Coin></Coin></el-icon>{{ fmtN(e.total) }}</span>
              <span class="m-val"><el-icon><Files></Files></el-icon>{{ fmtN(e.tcache) }}</span>
              <!-- I12 压缩徽章：claude 系以前只在 qoder 分支里印，现在压过就印（tooltip 里是明细） -->
              <span v-if="e.compacts" class="m-val"><el-icon><Refresh></Refresh></el-icon>{{ e.compacts }} <small>压缩</small></span>
            </template>
            <!-- 一家源里没有逐轮 token（comate 只记上下文占用）就整栏留空，不印「0 0 0 0」：
                 四个 0 读起来像「这轮没花钱」，而真相是「这个产品没记」—— 与下面 ctx 那栏
                 「宁可少一根条，也不拿假分母凑」是同一条约定（hermes 日志滚掉时同理）。 -->
            <span v-else class="m-val" style="color:var(--placeholder);font-weight:400">—</span>
          </div>
        </div>
        <div class="m-group">
          <div class="m-label">上下文</div>
          <div class="m-vals">
            <!-- qoder：token 恒为 0 没有占用可显，改显最后一次调用的 context_usage_ratio（进度条分母=1） -->
            <template v-if="isQoder(e)">
              <span class="m-val">{{ fmtPct(e.ctxRatio) }}</span>
              <span class="m-val"><span class="ctx-track"><i :style="{width: Math.min(100, e.ctxRatio<=1 ? e.ctxRatio*100 : e.ctxRatio)+'%'}"></i></span></span>
              <span v-if="e.compPre" class="m-val" style="color:var(--placeholder);font-weight:400"><small>{{ fmtN(e.compPre) }} → {{ fmtN(e.compPost) }}</small></span>
            </template>
            <!-- ctxUsed 有值就先把占用显示出来 —— ctx（窗口**容量**）拿不到时这就是全部信息。
                 容量只对 claude 缺（转录里没有这个字段，靠模型名查表，见服务端 CTX_WINDOWS），
                 查不到就只显示占用、不画条：宁可少一根条，也不要用一个假分母凑出一根像真的的条。 -->
            <template v-else-if="e.ctxUsed != null || e.ctx">
              <span class="m-val">{{ fmtN(ctxUsed(e)) }} <small v-if="e.ctx">/ {{ fmtN(e.ctx) }}</small></span>
              <span v-if="e.ctx" class="m-val"><span class="ctx-track"><i :style="{width: ctxPct(e)+'%'}"></i></span> {{ ctxPct(e) }}%</span>
              <!-- I12：压过的轮把「压缩前 → 压缩后」也摆出来（与 qoder 分支同一画法） -->
              <span v-if="e.compPre" class="m-val" style="color:var(--placeholder);font-weight:400"><small>{{ fmtN(e.compPre) }} → {{ fmtN(e.compPost) }}</small></span>
            </template>
            <span v-else class="m-val" style="color:var(--placeholder);font-weight:400">—</span>
          </div>
        </div>
        <div class="m-group">
          <div class="m-label">调用
            <!-- 具体工具与次数收成问号悬浮层，图标位置对齐 Token 的问号（挂在栏目标签旁） -->
            <el-tooltip v-if="toolList(e).length" placement="top" effect="dark" :show-after="200">
              <template #content>
                <div class="tok-tip">
                  <div class="tr" v-for="t in toolList(e)" :key="t[0]"><span class="tn">{{ t[0] }}</span><span>×{{ t[1] }}</span></div>
                </div>
              </template>
              <el-icon class="tok-q"><question-filled></question-filled></el-icon>
            </el-tooltip>
          </div>
          <div class="m-vals">
            <span v-if="e.calls != null" class="m-val"><el-icon><Lightning></Lightning></el-icon>{{ e.calls }} <small>次 LLM</small></span>
            <span class="m-val"><el-icon><set-up></set-up></el-icon>{{ e.tools }} <small>工具</small></span>
            <span v-if="e.rounds != null" class="m-val"><el-icon><Timer></Timer></el-icon>{{ e.rounds }} <small>轮</small></span>
          </div>
        </div>
      </div>

      <div class="card-foot">
        <!-- I16/D2：时间未知的轮如实标出来，不印 1970。atomcode 里这类轮本机占 44.6%
             （.jsonl 0 字节 / turn_id 在 jsonl 里不存在），回落 updated_at 会假装它们同时发生。 -->
        <span v-if="e.timeUnknown" class="tag-unknown" title="这一轮拿不到时间戳（源里没有可用的轮时间），不拿会话更新时刻冒充；它不参与按天统计与时间排序">时间未知</span>
        <span v-else>{{ fmtTime(e.time) }}</span>
        <!-- R6：session 可点击 → 会话时间线弹层（stop 防止触发卡片展开） -->
        <span class="r"><span class="sess-link" title="查看该会话完整时间线" @click.stop="$emit('open-session', e.session, e.agent, e.project)">{{ e.project }} · {{ e.session || '(无会话)' }}</span></span>
      </div>

      <div v-if="expanded" class="detail" @click.stop>
        <template v-if="detail">
          <h4>用户输入 <span class="copy-btn" title="复制原文" @click="copyRaw($event, detail.user)">复制</span></h4>
          <pre>{{ detail.user || '(空)' }}</pre>
          <!-- R5：失败轮单独列「失败原因」块——取 assistant 里的错误文本（isApiErrorMessage / error 事件的正文都落在 assistant），没有就提示看正文 -->
          <template v-if="e.status !== 'ok'">
            <h4>失败原因</h4>
            <pre class="fail-block">{{ detail.assistant || '（本轮未捕获到独立错误文本，请查看下方 AI 输出 / 工具调用中的 ✗ 标记）' }}</pre>
          </template>
          <template v-if="detail.assistant">
            <h4>AI 输出 <span class="copy-btn" title="复制原文（非渲染后文本）" @click="copyRaw($event, detail.assistant)">复制</span></h4>
            <!-- _assistantMd 是 prepDetail 在详情入库时算好缓存的：模板里直接调 renderMd 的话，
                 卡片每次重渲染（点折叠、来 SSE）都会把几十 KB 的正则渲染重跑一遍 -->
            <div class="md-body" v-html="detail._assistantMd"></div>
          </template>
          <template v-if="detail.spans && detail.spans.length">
            <h4>执行链路（{{ detail.spans.length }} 个 span）</h4>
            <div class="span-list">
              <div v-for="(sp, i) in secs.spans.items" :key="i" class="span-row" :style="{paddingLeft: (14 + sp.depth*18) + 'px'}">
                <span class="sn">{{ sp.name }}</span>
                <span v-if="sp.type" class="st">{{ sp.type }}</span>
                <span v-if="sp.error" class="serr">✗ {{ sp.error }}</span>
                <span class="sd">{{ fmtDur(sp.dur) }}</span>
              </div>
            </div>
            <div v-if="secs.spans.more" class="more-btn sec-toggle" @click="$emit('toggle-sec', 'spans')">{{ secs.spans.open ? '收起' : '展开全部 ' + detail.spans.length + ' 个 span（还有 ' + secs.spans.rest + ' 个）' }}</div>
          </template>
          <!-- 卡片写着「N 次 LLM」但一条明细都没拿到（datalog 默认关，或这轮没落盘）时，把原因说出来 -->
          <template v-if="detail.calls && detail.calls.length">
            <h4>LLM 调用明细（{{ detail.calls.length }} 次）</h4>
            <div class="call-list">
              <div v-for="(c, i) in secs.calls.items" :key="i" class="call-item">
                <div class="call-row">
                  <!-- 圆点 = 这次调用有正文，点得开；没有的多半是「只发起了工具调用」 -->
                  <span class="ci"><i v-if="c.text" class="call-dot" title="这次调用有正文，可点开"></i>#{{ i + 1 }}</span>
                  <span class="cm">{{ c.model || 'generation' }}</span>
                  <!-- 这次调用发起了哪些工具 —— 上面那行数字说明不了「它干了什么」，这个能 -->
                  <span v-if="c.tools && c.tools.length" class="call-tools" :title="'这次调用发起了：' + toolText(c.tools, 99)">{{ toolText(c.tools) }}</span>
                  <span v-if="c.error" class="cerr">✗ {{ c.error }}</span>
                  <span class="cd">{{ fmtDur(c.dur) }}</span>
                  <span v-if="c.tin != null && c.model" class="ct">↑{{ fmtN(c.tin) }} · ↓{{ fmtN(c.tout) }}<template v-if="c.tcache"> · 缓存 {{ fmtN(c.tcache) }}</template></span>
                </div>
                <!-- 这次调用自己产出的正文（而不是整轮拼起来的那坨）。默认收起：一轮几十次调用时
                     全铺开就是十几屏。有的行没有正文 —— 那多半是纯工具调用那几次，本来就没说话。 -->
                <template v-if="c.text">
                  <div class="tool-sec-h call-out-h" @click="$emit('fold-callout', e.id, i)">{{ callOpen.has(e.id + ':' + i) ? '▾ 本次输出' : '▸ 本次输出' }}</div>
                  <pre v-show="callOpen.has(e.id + ':' + i)" class="call-out">{{ c.text }}</pre>
                  <span v-if="c.textTrunc && !fullIds.has(e.id)" class="more-btn" @click="$emit('load-full', e.id)">本次输出已截断，查看完整内容</span>
                </template>
              </div>
            </div>
            <div v-if="secs.calls.more" class="more-btn sec-toggle" @click="$emit('toggle-sec', 'calls')">{{ secs.calls.open ? '收起' : '展开全部 ' + detail.calls.length + ' 次（还有 ' + secs.calls.rest + ' 次）' }}</div>
          </template>
          <div v-else-if="detail.callsNote" class="calls-note">{{ detail.callsNote }}</div>
          <template v-if="detail.tools && detail.tools.length">
            <h4>工具调用（{{ detail.tools.length }}）</h4>
            <div v-for="(t, i) in secs.tools.items" :key="i" class="tool-item">
              <div class="tool-head">
                <span class="tname">{{ t.name }}</span>
                <span v-if="t.error" class="terr">✗ {{ t.error }}</span>
                <span v-if="t.dur!=null" class="tdur">{{ fmtDur(t.dur) }}</span>
                <span class="tool-copy" @click="copyRaw($event, (t.input || '') + (t.output ? '\\n' + t.output : ''))">复制</span>
              </div>
              <!-- 入参/返回：_inPretty/_outPretty 是 prepDetail 缓存的 prettyJson 结果（缓存缺失时回退现算）；
                   折叠开关独立记录（toolJsonFold） -->
              <template v-if="t.input">
                <div class="tool-sec-h" @click="$emit('fold-json', e.id, i, 'in')">{{ toolJsonFold.has(e.id + ':' + i + ':in') ? '▸ 入参' : '▾ 入参' }}</div>
                <pre v-show="!toolJsonFold.has(e.id + ':' + i + ':in')">{{ t._inPretty || prettyJson(t.input) }}</pre>
              </template>
              <span v-if="t.inputTrunc" class="more-btn" @click="$emit('load-full', e.id)">输入已截断，查看完整内容</span>
              <template v-if="t.output">
                <div class="tool-sec-h" @click="$emit('fold-json', e.id, i, 'out')">{{ toolJsonFold.has(e.id + ':' + i + ':out') ? '▸ 返回' : '▾ 返回' }}</div>
                <pre v-show="!toolJsonFold.has(e.id + ':' + i + ':out')">{{ t._outPretty || prettyJson(t.output) }}</pre>
              </template>
              <span v-if="t.outputTrunc" class="more-btn" @click="$emit('load-full', e.id)">输出已截断，查看完整内容</span>
            </div>
            <div v-if="secs.tools.more" class="more-btn sec-toggle" @click="$emit('toggle-sec', 'tools')">{{ secs.tools.open ? '收起' : '展开全部 ' + detail.tools.length + ' 个（还有 ' + secs.tools.rest + ' 个）' }}</div>
          </template>
          <!-- 非文本 part（zcode 的状态事件 / 推理锚点 / 未知类型）：未知类型不静默丢弃，保留结构化 JSON -->
          <template v-if="detail.others && detail.others.length">
            <h4>其他事件（{{ detail.others.length }}）</h4>
            <div v-for="(o, oi) in detail.others" :key="oi">
              <div class="other-item"><span class="ot">{{ o.type }}</span><span class="od">{{ o.t ? fmtTime(o.t) : '' }}</span></div>
              <pre v-if="o.json" class="other-json">{{ o.json }}</pre>
            </div>
          </template>
          <div v-if="isLive(e.id)" class="more-btn" @click="$emit('reload-detail', e.id)">该 agent 最新一轮 · 详情会随新日志自动刷新，也可点此手动重取</div>
          <!-- 整张卡片的「收起」。做成吸底（.detail-foot），详情十几屏高时也随时点得到 ——
               按钮只放在末尾的话，想中途退出就得先一路滑到底，那等于没有 -->
          <div class="detail-foot">
            <el-button size="small" @click="$emit('export-detail', e.id, $event)">导出该轮完整详情</el-button>
            <el-button size="small" type="primary" @click="$emit('export-repro', e.id, $event)">导出复现包</el-button>
            <el-button size="small" @click="$emit('collapse', e.id, $event)">收起</el-button>
          </div>
        </template>
        <el-skeleton v-else :rows="3" animated></el-skeleton>
      </div>
    </div>`,
  props: {
    // 条目本体：applyUpdate 会整体换对象，所以引用比较就够（cardMemo 的第一项就是它）
    e: { type: Object, required: true },
    // 「是不是这张卡展开着」由父层算好 —— 卡片不需要知道 expandedId 是谁
    expanded: Boolean,
    // 详情本体（undefined = 还没拉回来 → 骨架屏）。secs 是它派生的三个长列表视图
    detail: { type: Object, default: null },
    secs: { type: Object, default: null },
    // 三份折叠开关：与「按会话浏览」那一份共用同一套根状态（同一个 Set 在两个视图里都可能出现）
    callOpen: { type: Object, default: () => new Set() },
    toolJsonFold: { type: Object, default: () => new Set() },
    fullIds: { type: Object, default: () => new Set() },
    // 两个判定函数留在根（titleOf 闭包读 isLive → liveIds），以函数形态作 props 传入
    titleOf: { type: Function, required: true },
    isLive: { type: Function, required: true },
    // I9 两轮 diff：这张卡是不是已在对比选中组里（决定「对比」按钮的选中态）
    compareSel: { type: Boolean, default: false },
  },
  emits: ['toggle', 'open-session', 'collapse', 'load-full', 'fold-json', 'fold-callout', 'toggle-sec', 'reload-detail', 'export-detail', 'export-repro', 'compare'],
  setup() {
    // 模板看不见 page/*.js 的顶层名（批 1 实测），shared.js 的 helper 要逐个转交
    return { iconOf, agentColor, agentLetter, isQoder, fmtCredits, fmtN, fmtDur, fmtPct, fmtTime,
      ctxUsed, ctxPct, toolList, toolText, prettyJson, copyRaw };
  }
};
