// 会话时间线弹层（R25 批 1 第四个组件）。
// 契约见 page/shared.js 头部「R25 组件文件契约」；顶层只许有那一处 AACTA 赋值，Vue / Element Plus 的 API 写全名。
//
// 数据进出 —— 与上下文窗口弹层同理：**轮次数据不算根的**。
//   改前 sessLoading / sessData / sessExpanded / sessDetails 都摊在根里，但只有这个弹层用；
//   根的卡片页脚只负责「开哪一个」，所以定成：
//   · visible ← 根（卡片页脚 openSession / 弹层关闭时回写）
//   · req     ← 根：{ key, agent, project }，点一次卡片页脚递一份（key 为空时根本就没开）
//   · getJSON ← 根 provide（404 要点亮版本红条）
//   · 拉数据、展开态、逐轮详情缓存 —— 都是弹层自己的
// 轮次正文仍走 /api/entry 懒加载：点开哪轮才取哪轮，大会话不一次读爆（与改前一致）。
window.AACTA = window.AACTA || {};
AACTA.DialogSessTimeline = {
  name: 'aa-dialog-sess-timeline',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="会话时间线" width="min(860px, 94vw)" append-to-body class="sess-dialog">
    <div v-if="sessLoading" v-loading="true" style="min-height:200px"></div>
    <template v-else-if="sessData">
      <div class="sess-sum">
        <span><b>{{ sessData.count }}</b> 轮</span>
        <span>↑{{ fmtN(sessData.tin) }} · ↓{{ fmtN(sessData.tout) }} · 缓存 {{ fmtN(sessData.tcache) }}</span>
        <span>合计 {{ fmtDurBig(sessData.dur) }}</span>
        <span>{{ fmtTime(sessData.from) }} ~ {{ fmtTime(sessData.to) }}</span>
        <span v-if="sessData.models.length" class="sess-models">{{ sessData.models.join('、') }}</span>
      </div>
      <div class="sess-list">
        <div v-for="(t, i) in sessData.entries" :key="t.id" class="sess-turn" :class="{err: t.status !== 'ok'}">
          <div class="sess-turn-head" @click="sessToggle(t.id)">
            <span class="sn">#{{ i + 1 }}</span>
            <span class="st-preview">{{ t.preview || '(无文本预览)' }}</span>
            <span v-if="t.status !== 'ok'" class="tag tag-err">ERR</span>
            <span class="sd">{{ fmtDur(t.dur) }}</span>
            <span class="st-time">{{ fmtTime(t.time) }}</span>
            <span class="sess-arrow">{{ sessExpanded.has(t.id) ? '▾' : '▸' }}</span>
          </div>
          <div v-if="sessExpanded.has(t.id)" class="sess-turn-body" @click.stop>
            <template v-if="sessDetailOf(t.id)">
              <h4>用户输入 <span class="copy-btn" @click="copyRaw($event, sessDetailOf(t.id).user)">复制</span></h4>
              <pre>{{ sessDetailOf(t.id).user || '(空)' }}</pre>
              <template v-if="sessDetailOf(t.id).assistant">
                <h4>AI 输出 <span class="copy-btn" @click="copyRaw($event, sessDetailOf(t.id).assistant)">复制</span></h4>
                <div class="md-body" v-html="sessDetailOf(t.id)._assistantMd"></div>
              </template>
              <template v-if="sessDetailOf(t.id).tools && sessDetailOf(t.id).tools.length">
                <h4>工具调用（{{ sessDetailOf(t.id).tools.length }}）</h4>
                <div v-for="(t2, j) in sessDetailOf(t.id).tools" :key="j" class="tool-item">
                  <div class="tool-head"><span class="tname">{{ t2.name }}</span><span v-if="t2.error" class="terr">✗</span></div>
                  <pre v-if="t2.input">{{ prettyJson(t2.input) }}</pre>
                  <pre v-if="t2.output">{{ prettyJson(t2.output) }}</pre>
                </div>
              </template>
            </template>
            <el-skeleton v-else :rows="2" animated></el-skeleton>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty">会话数据不可用</div>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
    // 「开哪一个」：{ key, agent, project }。agent/project 是**可选**的精确化参数 —— session 值跨 agent、
    // 跨项目都不保证唯一（各解析器口径不同，本机实测 atomcode 就有不同项目下的同名 session）。
    // 不传 == 老行为（只按 key 匹配）。project 传原始写法即可：服务端按 projKey 两边归一后比。
    req: { type: Object, default: null },
  },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    const sessLoading = Vue.ref(false);
    const sessData = Vue.ref(null);         // /api/session 的返回：{count, tin..., from, to, models, entries[]}
    const sessExpanded = Vue.ref(new Set()); // 已展开的轮次 id（点开才拉 /api/entry）
    const sessDetails = Vue.ref({});        // id -> 详情（同 detailOf 的缓存结构，独立一份避免互相污染）
    async function load() {
      const r = props.req || {};
      sessLoading.value = true; sessData.value = null;
      sessExpanded.value = new Set(); sessDetails.value = {};
      try {
        const j = await getJSON('/api/session?key=' + encodeURIComponent(r.key)
          + (r.agent ? '&agent=' + encodeURIComponent(r.agent) : '')
          + (r.project ? '&project=' + encodeURIComponent(r.project) : ''));
        sessData.value = j.ok ? j : null;
        if (!j.ok) ElementPlus.ElMessage.error(j.error || '会话加载失败');
      } catch (e) { ElementPlus.ElMessage.error('会话加载失败：' + e.message); }
      finally { sessLoading.value = false; }
    }
    function sessDetailOf(id) { return sessDetails.value[id] || null; }
    async function sessToggle(id) {
      const s = new Set(sessExpanded.value);
      if (s.has(id)) { s.delete(id); sessExpanded.value = s; return; }
      s.add(id); sessExpanded.value = s;
      if (!sessDetails.value[id]) {
        try { sessDetails.value = { ...sessDetails.value, [id]: prepDetail(await getJSON('/api/entry?id=' + encodeURIComponent(id))) }; }
        catch (e) { ElementPlus.ElMessage.error('详情加载失败：' + e.message); }
      }
    }
    // 点开卡片页脚才拉（改前是 openSession 顺手 fetch；现在根只置 visible + 递 req）
    Vue.watch(() => props.visible, v => { if (v) load(); });
    // 模板只能看见 setup return 里的键：shared.js 里的格式化函数虽然在本文件的作用域里（经典 script 全局），
    // 但模板编译成 with(_ctx) 后只认 props / return / 已注册组件 / JS 内建（实测 Math、Date、console 能命中，
    // document、window、ElementPlus、fmtN 全是 undefined）。所以模板要用的这几只必须**列进 return**，
    // 否则渲染期抛「fmtN is not a function」，弹层直接打不开。
    return { sessLoading, sessData, sessExpanded, sessDetailOf, sessToggle, fmtN, fmtDur, fmtDurBig, fmtTime, copyRaw, prettyJson };
  }
};
