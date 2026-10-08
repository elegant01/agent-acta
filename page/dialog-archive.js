// R28 历史归档弹层：浏览 ~/.agent-acta/archive 下被冻结的条目（模板与数据全在本文件）。
// 契约见 page/shared.js 头部「R25 组件文件契约」；Vue / Element Plus 的 API 写全名。
//
// 数据进出：
//   · visible ← 根（侧栏「历史归档」项点开 / 弹层自己关闭时回写）；getJSON ← 根 provide（404 要点亮版本红条）
//   · 三个只读端点（服务端批 1 已上）：
//       /api/archive/index    → 清单（root / days[] / agents[] / totals）
//       /api/archive/entries  → 条目列表（**不含** detail，只给 hasDetail 标记）
//       /api/archive/entry    → 单条冻结的详情快照
//   · 归档是**旁路**：只读、不参与主列表的扫描与查询链路（archive.mjs 头部的第一条约束）。
//     所以这个弹层与左侧栏的 agent/时间筛选无关，自己一套 selAgent/selDay/q。
//
// 与主列表刻意不同的三处（都是归档的固有性质，不是缺功能）：
//   · 没有「加载完整内容」：冻下来的就是当时那份（正文 800 字截断、tools/calls/events 各最多 40 项），
//     truncated 的原文随产品删日志一起没了，这里给不出更多 —— 底部那行把它说清楚。
//   · 没有进行中的轮（归档只收已结束且早于今天 0 点的条目），所以状态只有 ok / 失败。
//   · 详情是快照而非重读源文件：源文件删了照样打得开，这正是这个功能存在的理由。
window.AACTA = window.AACTA || {};
AACTA.DialogArchive = {
  name: 'aa-dialog-archive',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="历史归档" width="min(1120px, 95vw)" append-to-body class="arc-dialog">
    <el-skeleton v-if="arc.loading && !arc.days.length" :rows="8" animated></el-skeleton>
    <div v-else-if="!arc.days.length" class="empty">
      <el-alert v-if="arc.error" :title="arc.error" type="error" :closable="false" show-icon style="margin-bottom:10px"></el-alert>
      <template v-else>
        还没有归档数据。归档在服务内每日自动跑一遍，也可以手动执行
        <code>node agent-acta-server.mjs --archive</code>（先 <code>--list</code> 看一眼再跑）。
      </template>
      <el-button size="small" @click="load">重试</el-button>
    </div>
    <div v-else class="arc-wrap">
      <aside class="arc-side">
        <div class="arc-sum">
          <div><b>{{ arc.totals.count }}</b> 条 · <b>{{ arc.totals.days }}</b> 个日期文件</div>
          <div class="arc-sum-2">{{ arc.totals.agents }} 个 agent · {{ arcBytes(arc.totals.bytes) }}</div>
        </div>
        <div class="arc-tree">
          <div class="arc-node lv0" :class="{active: selAgent==='' && selDay===''}" @click="pick('', '')">
            <span class="arc-nm">全部</span><span class="arc-ct">{{ arc.totals.count }}</span>
          </div>
          <template v-for="a in arc.agents" :key="a.agent">
            <div class="arc-node lv1" :class="{active: selAgent===a.agent && selDay===''}" @click="pick(a.agent, '')" :title="a.lastDay ? '最近归档 ' + a.lastDay : ''">
              <!-- 折叠开关单独占一格：点箭头只管收起/展开，点整行是「筛到这个 agent」（顺手展开）。
                   18 个 agent 全展开是 214 行，没有折叠就只能一路滚 -->
              <span class="arc-caret" :class="{open: isOpen(a.agent)}" :title="isOpen(a.agent) ? '收起' : '展开'" @click.stop="toggleAgent(a.agent)">{{ isOpen(a.agent) ? '▾' : '▸' }}</span>
              <img v-if="agentIcon(a.agent)" class="arc-ico" :src="agentIcon(a.agent)">
              <span v-else class="arc-dot" :style="{background: agentColor(a.agent)}"></span>
              <span class="arc-nm">{{ a.agent }}</span>
              <span class="arc-ct">{{ a.unknown ? '?' : a.count }}</span>
            </div>
            <template v-for="d in dayRows(a.agent)" :key="d.day">
              <div v-if="isOpen(a.agent)" class="arc-node lv2" :class="{active: selAgent===a.agent && selDay===d.day}" @click="pick(a.agent, d.day)">
                <span class="arc-nm">{{ d.day }}</span>
                <span class="arc-ct">{{ d.count < 0 ? '?' : d.count }}</span>
              </div>
            </template>
          </template>
        </div>
        <!-- per-agent 归档开关：树里只有「已经有归档」的 agent，而开关要能管到**还没有归档**的那些
             （以后也永远不会有 —— 正是需要它出现在这里的理由），所以名单取自配置（index 的 configAgents），不是树。 -->
        <div class="arc-cfg">
          <div class="arc-cfg-h" @click="cfgOpen = !cfgOpen" :title="cfgOpen ? '收起' : '展开'">
            <span>归档开关</span>
            <span class="arc-cfg-n">{{ arc.skip.length ? '已关 ' + arc.skip.length + ' 个' : '全部开启' }}</span>
            <span class="arc-caret" :class="{open: cfgOpen}">{{ cfgOpen ? '▾' : '▸' }}</span>
          </div>
          <div v-show="cfgOpen" class="arc-cfg-body">
            <div class="arc-cfg-tip">关掉就不再归档这个 agent 的新条目（写进 config.json 的 archive.skip）；已经冻好的日期文件保留，下一轮归档起生效。</div>
            <div v-for="a in arc.configAgents" :key="a" class="arc-cfg-row">
              <span class="arc-nm">{{ a }}</span>
              <el-switch size="small" :model-value="!isSkipped(a)" :loading="skipSaving === a"
                :title="isSkipped(a) ? '当前不归档这个 agent（打开即恢复归档）' : '当前会归档这个 agent（关掉即停止归档新条目）'"
                @click.stop @change="v => toggleSkip(a, v)"></el-switch>
            </div>
            <div v-if="!arc.configAgents.length" class="arc-cfg-tip">没有已启用的 agent。</div>
          </div>
        </div>
      </aside>
      <section class="arc-main">
        <!-- 失败不清场：已经拉到的树与列表留在原地，错误只占一条横幅。
             以前这里是「有 error 就整层换成一条红条」，服务重启/瞬断时会看起来像归档数据没了
             （用户第一次反馈就是打开一会儿报 Failed to fetch 后整层空了）。 -->
        <div v-if="arc.error" class="arc-errbar">
          <span class="arc-errmsg">{{ arc.error }}</span>
          <el-button size="small" @click="load">重试</el-button>
        </div>
        <div class="arc-bar">
          <el-input v-model="q" size="small" clearable placeholder="关键词（预览 / 用户 / 助手 / 会话 / 模型 / 工具）" style="width:300px" @keyup.enter="reload" @clear="reload"></el-input>
          <el-button size="small" type="primary" :loading="arc.listLoading" @click="reload">搜索</el-button>
          <span class="arc-scope">{{ scopeText }}</span>
        </div>
        <div class="arc-list">
          <div v-for="r in arc.list" :key="r.id" class="arc-row" :class="{err: r.status !== 'ok', open: openId === r.id}" @click="toggle(r)">
            <span class="arc-t">{{ fmtTime(r.time) }}</span>
            <span class="arc-pv">{{ r.preview || '(无文本预览)' }}</span>
            <span class="arc-tag">{{ agentLetter(r.agent) }}</span>
            <span v-if="!r.hasDetail" class="arc-nod">无详情</span>
            <span class="arc-kv">↑{{ fmtN(r.tin) }} ↓{{ fmtN(r.tout) }}</span>
            <span v-if="r.tools" class="arc-kv">{{ r.tools }} 工具</span>
            <span v-if="r.calls" class="arc-kv">{{ r.calls }} 次 LLM</span>
            <span v-if="r.dur" class="arc-kv">{{ fmtDur(r.dur) }}</span>
            <span class="arc-arrow">{{ openId === r.id ? '▾' : '▸' }}</span>
          </div>
          <div v-if="!arc.list.length && !arc.listLoading" class="arc-none">这个范围内没有条目{{ q ? '匹配「' + q + '」' : '' }}</div>
        </div>
        <div v-if="arc.total > arc.list.length" class="arc-more">
          <el-button size="small" :loading="arc.listLoading" @click="more">加载更多（已列 {{ arc.list.length }} / 共 {{ arc.total }}）</el-button>
        </div>
        <div v-if="openId" class="arc-detail" @click.stop>
          <el-skeleton v-if="arc.detailLoading" :rows="4" animated></el-skeleton>
          <div v-else-if="arc.detailErr" class="arc-derr">{{ arc.detailErr }}</div>
          <template v-else-if="detail">
            <div class="arc-dhead">
              <span class="arc-dtime">{{ fmtTime(detail.time) }}</span>
              <span class="arc-dmeta">{{ detail.project || '(无项目)' }}<template v-if="detail.session"> · {{ detail.session }}</template></span>
              <span class="arc-dmeta">归档于 {{ detail.day }} · 口径 rev {{ detail.rev == null ? '—' : detail.rev }}</span>
            </div>
            <div v-if="!detail.detail" class="arc-none">归档时未取到详情：那会儿源日志就已经读不到了，只剩统计字段。</div>
            <template v-else>
              <h4>用户输入 <span class="copy-btn" title="复制原文" @click="copyRaw($event, detail.detail.user)">复制</span></h4>
              <pre>{{ detail.detail.user || '(空)' }}</pre>
              <template v-if="detail.detail.assistant">
                <h4>AI 输出 <span class="copy-btn" title="复制原文（非渲染后文本）" @click="copyRaw($event, detail.detail.assistant)">复制</span></h4>
                <div class="md-body" v-html="detail.detail._assistantMd"></div>
              </template>
              <template v-if="detail.detail.tools && detail.detail.tools.length">
                <h4>工具调用（{{ detail.detail.tools.length }}）</h4>
                <div v-for="(t, i) in detail.detail.tools" :key="i" class="tool-item">
                  <div class="tool-head">
                    <span class="tname">{{ t.name }}</span>
                    <span v-if="t.error" class="terr">✗ {{ t.error }}</span>
                    <span class="tool-copy" @click="copyRaw($event, (t.input || '') + (t.output ? '\\n' + t.output : ''))">复制</span>
                  </div>
                  <pre v-if="t.input">{{ t._inPretty || prettyJson(t.input) }}</pre>
                  <pre v-if="t.output">{{ t._outPretty || prettyJson(t.output) }}</pre>
                </div>
              </template>
              <template v-if="detail.detail.calls && detail.detail.calls.length">
                <h4>LLM 调用明细（{{ detail.detail.calls.length }} 次）</h4>
                <div class="call-list">
                  <div v-for="(c, i) in detail.detail.calls" :key="i" class="call-item">
                    <div class="call-row">
                      <span class="ci">#{{ i + 1 }}</span>
                      <span class="cm">{{ c.model || 'generation' }}</span>
                      <span v-if="c.tools && c.tools.length" class="call-tools" :title="'这次调用发起了：' + toolText(c.tools, 99)">{{ toolText(c.tools) }}</span>
                      <span v-if="c.error" class="cerr">✗ {{ c.error }}</span>
                      <span class="cd">{{ fmtDur(c.dur) }}</span>
                      <span v-if="c.tin != null && c.model" class="ct">↑{{ fmtN(c.tin) }} · ↓{{ fmtN(c.tout) }}<template v-if="c.tcache"> · 缓存 {{ fmtN(c.tcache) }}</template></span>
                    </div>
                    <pre v-if="c.text" class="call-out">{{ c.text }}</pre>
                  </div>
                </div>
              </template>
              <div v-else-if="detail.detail.callsNote" class="calls-note">{{ detail.detail.callsNote }}</div>
              <template v-if="detail.detail.events && detail.detail.events.length">
                <h4>事件（{{ detail.detail.events.length }}）</h4>
                <div v-for="(ev, i) in detail.detail.events" :key="i" class="arc-ev">
                  <span class="arc-ev-t">{{ fmtTime(ev.time) }}</span>
                  <span class="arc-ev-n">{{ ev.name || ev.type || ev.title || '(事件)' }}</span>
                  <span v-if="ev.text" class="arc-ev-x">{{ ev.text }}</span>
                </div>
              </template>
              <div v-if="detail.detail.note" class="calls-note">{{ detail.detail.note }}</div>
              <div v-if="thenNote" class="arc-then">{{ thenNote }}</div>
            </template>
          </template>
        </div>
      </section>
    </div>
    <template #footer>
      <span class="arc-foot">归档 = 条目级冻结（统计字段 + 归档当时的详情快照）：只读旁路，不并入上方请求列表；正文截断 800 字、工具/调用/事件各最多 40 项 —— 被截掉的那部分原文已随产品删日志一起消失，这里补不回来。</span>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button type="primary" :loading="arc.loading" @click="load">刷新</el-button>
    </template>
  </el-dialog>`,
  props: { visible: Boolean },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    const PAGE = 200;
    const arc = Vue.reactive({
      loading: false, error: '', listLoading: false, detailLoading: false, detailErr: '',
      days: [], agents: [], skip: [], configAgents: [], totals: { agents: 0, days: 0, count: 0, bytes: 0 },
      list: [], total: 0, scanned: 0,
    });
    const selAgent = Vue.ref(''), selDay = Vue.ref(''), q = Vue.ref('');
    const openId = Vue.ref(''), detail = Vue.ref(null);
    const cfgOpen = Vue.ref(true);      // 开关列表默认展开：它是这个弹层唯一的「写」入口，藏起来等于没有
    const skipSaving = Vue.ref('');     // 正在保存的那个 agent 名（只用来给该行的开关转圈）

    // 展开状态只记「被收起」的 agent：默认全展开（与加折叠之前一致，18 个 agent 也就 214 行），
    // 收起是用户主动的动作。反过来记「展开的」会让第一次打开的面板变成光秃秃一排 agent 名。
    const closed = Vue.reactive({});
    const isOpen = a => !closed[a];
    function toggleAgent(a) { closed[a] = !closed[a]; }

    // 取数统一走这里：**只**对网络层失败（fetch 直接 reject）自动重试一次 —— 服务重启/瞬断是
    // 一次性事件，重试一次基本就好了；接口真报错（404/500/非 JSON）不重试，那是版本或数据的问题，
    // 重试只会把错误拖晚 1.2s 才显示。
    const netFail = e => /Failed to fetch|NetworkError|Load failed|fetch failed/i.test((e && e.message) || '');
    async function withRetry(fn) {
      try { return await fn(); }
      catch (e) {
        if (!netFail(e)) throw e;
        await new Promise(r => setTimeout(r, 1200));
        return await fn();
      }
    }
    const errText = (what, e) => what +
      (netFail(e) ? '：连不上服务（可能正在重启或已停止）—— ' : '：') + ((e && e.message) || e);

    async function load() {
      if (arc.loading) return;
      arc.loading = true; arc.error = '';
      try {
        const j = await withRetry(() => getJSON('/api/archive/index'));
        if (!j.ok) throw new Error(j.error || '清单读取失败');
        arc.days = j.days || [];
        arc.agents = j.agents || [];
        arc.skip = j.skip || [];
        arc.configAgents = j.configAgents || [];
        arc.totals = j.totals || arc.totals;
        // 顺带把当前选中范围的条目也拉一遍：不然打开弹层只有左边一棵树、右边空着，
        // 得先点一下才知道能看什么。全量扫一遍 195 个日期文件实测 ~0.6s，不值得为它加个「请选择」的空态。
        closeDetail();
        loadEntries(0);
      } catch (e) { arc.error = errText('历史归档加载失败', e); }
      finally { arc.loading = false; }
    }
    // 每次打开都回到「全部展开」：el-dialog 默认不销毁内容，组件实例活到整页刷新为止，
    // closed 不清就是在**跨次记忆** —— 上次随手收起的几个 agent 下次打开时静默留着，
    // 看起来就是「一打开全都收起了」。收起只属于本次浏览。
    function resetCollapsed() { for (const k of Object.keys(closed)) delete closed[k]; }
    Vue.watch(() => props.visible, v => { if (v) { resetCollapsed(); load(); } });

    // 清单里的 days[] 是一串扁平行（agent + day + count + bytes），按 agent 归一次组给模板用
    const dayMap = Vue.computed(() => {
      const m = new Map();
      for (const d of arc.days) {
        if (!m.has(d.agent)) m.set(d.agent, []);
        m.get(d.agent).push(d);
      }
      return m;
    });
    const dayRows = a => dayMap.value.get(a) || [];

    function pick(agent, day) {
      selAgent.value = agent; selDay.value = day;
      // 点行筛选时顺手把它展开：不然「筛到了但看不见日期」，还得再点一次箭头
      if (agent) closed[agent] = false;
      closeDetail();
      arc.list = []; arc.total = 0; arc.scanned = 0;
      loadEntries(0);
    }
    function reload() { closeDetail(); loadEntries(0); }
    function more() { loadEntries(arc.list.length); }

    async function loadEntries(off) {
      arc.listLoading = true;
      try {
        const j = await withRetry(() => getJSON('/api/archive/entries?agent=' + encodeURIComponent(selAgent.value)
          + '&day=' + encodeURIComponent(selDay.value)
          + '&q=' + encodeURIComponent(q.value.trim())
          + '&limit=' + PAGE + '&offset=' + off));
        if (!j.ok) throw new Error(j.error || '条目读取失败');
        arc.list = off > 0 ? arc.list.concat(j.list || []) : (j.list || []);
        arc.total = j.total || 0; arc.scanned = j.scanned || 0;
        arc.error = '';
      } catch (e) { arc.error = errText('归档条目加载失败', e); }
      finally { arc.listLoading = false; }
    }

    function closeDetail() { openId.value = ''; detail.value = null; arc.detailErr = ''; }

    // ---- per-agent 归档开关（写 config.archive.skip）----
    // 开关的显示态由 arc.skip 推出来（不是 v-model），所以保存失败时它自己会弹回原位 —— 不需要额外的回滚。
    const isSkipped = a => arc.skip.includes(a);
    async function toggleSkip(a, on) {
      skipSaving.value = a;
      try {
        const j = await withRetry(() => getJSON('/api/archive/skip', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: a, skip: !on }),
        }));
        if (!j.ok) throw new Error(j.error || '保存失败');
        arc.skip = j.skip || [];
        arc.error = '';
        ElementPlus.ElMessage.success(on ? '已恢复归档 ' + a : '已停止归档 ' + a + '（已冻好的文件保留）');      } catch (e) { arc.error = errText('归档开关保存失败', e); }
      finally { skipSaving.value = ''; }
    }
    async function toggle(r) {
      if (openId.value === r.id) { closeDetail(); return; }
      openId.value = r.id; detail.value = null; arc.detailErr = '';
      arc.detailLoading = true;
      try {
        const j = await withRetry(() => getJSON('/api/archive/entry?agent=' + encodeURIComponent(r.agent)
          + '&day=' + encodeURIComponent(r.day) + '&id=' + encodeURIComponent(r.id)));
        if (!j.ok) throw new Error(j.error || '详情读取失败');
        detail.value = prepArcDetail(j.entry);
      } catch (e) { arc.detailErr = errText('归档详情读取失败', e); }
      finally { arc.detailLoading = false; }
    }
    // 与页面 prepDetail 同一套「入库前把贵的渲染算一次」的做法：别在模板里调 renderMd/prettyJson
    function prepArcDetail(rec) {
      const d = rec && rec.detail;
      if (d) {
        if (d.assistant) d._assistantMd = renderMd(d.assistant);
        for (const t of d.tools || []) {
          if (t.input) t._inPretty = prettyJson(t.input);
          if (t.output) t._outPretty = prettyJson(t.output);
        }
      }
      return rec;
    }

    const scopeText = Vue.computed(() => {
      const scope = (selAgent.value || '全部 agent') + (selDay.value ? ' · ' + selDay.value : '');
      return scope + ' · 命中 ' + arc.total + ' / 扫描 ' + arc.scanned + ' 条';
    });
    // 归档时被 40 项上限砍掉的部分：归档文件里只留了计数（detailMore），原文补不回来，直接说清楚
    const thenNote = Vue.computed(() => {
      const m = detail.value && detail.value.detailMore;
      if (!m) return '';
      const parts = Object.keys(m).map(k => ({ tools: '工具', calls: 'LLM 调用', events: '事件' })[k] + ' ' + m[k] + ' 项');
      return '归档时按每类最多 40 项截断：另有 ' + parts.join('、') + '未入库（原文已随源日志一起消失）。';
    });

    const arcBytes = n => {
      const v = Number(n) || 0;
      if (v < 1024) return v + 'B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + 'KB';
      if (v < 1024 * 1024 * 1024) return (v / 1048576).toFixed(1) + 'MB';
      return (v / 1073741824).toFixed(2) + 'GB';
    };

    // 模板只认 props ∪ setup return（page-check.mjs 盯住）—— 下面这串全是模板里出现过的名字
    return { arc, selAgent, selDay, q, openId, detail, load, pick, reload, more, toggle,
      isOpen, toggleAgent, cfgOpen, isSkipped, toggleSkip, skipSaving, dayRows, scopeText, thenNote, arcBytes,
      fmtN, fmtDur, fmtTime, agentLetter, agentColor, agentIcon, toolText, copyRaw, prettyJson };
  }
};
