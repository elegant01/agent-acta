// 异常巡检弹层（R9）：配置三条异常规则 + 列出命中条目 + 一键定位回主列表。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 数据进出：
//   · visible ← 根（侧栏「异常巡检」项点开 / 弹层关掉时回写）
//   · getJSON ← 根 provide（接口 404 要点亮顶部版本红条，那段逻辑只有根里一份）
//   · 规则与命中条目都归弹层自己（自己拉 /api/alert、自己改）—— 命中集合（哪个 id 算异常）
//     归根持有（供「只看异常」筛选与定位），弹层只负责读回 / 触发定位；保存后把命中数
//     上报回根（@summary）好让徽章与「只看异常」即时同步。
//
// 规则口径（与服务端一一对应）：三条都是「启用 + 阈值」，命中 = 满足阈值即算一条异常；
//   · tokens：单轮 token（total = 输入+输出+缓存）超过阈值；
//   · durMs：  单轮耗时超过阈值（毫秒，轮内首条→末条时间差，含挂机/隔夜）；
//   · fail：   按 agent 统计最近 N 轮里失败（status != ok）占比超过阈值（%），
//              命中的是该 agent 里构成失败的那几轮。
// 保存即落盘（config.alert）并立刻重算命中，同 scanMs 那套设置机制（服务重启后仍在）。
window.AACTA = window.AACTA || {};
AACTA.DialogAlert = {
  name: 'aa-dialog-alert',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="异常巡检" width="min(920px, 95vw)" append-to-body class="al-dialog">
    <div class="al-hint">
      按三条规则盯住异常日志，命中后侧栏徽章与「只看异常」会标出新出现的异常条目，不用人工翻找。
      规则与阈值<b>即时生效并持久化</b>（写在 <code>~/.agent-acta/config.json</code>，重启服务仍在；不启用 = 绝不打扰）。
    </div>
    <el-skeleton v-if="al.loading && !al.j" :rows="5" animated></el-skeleton>
    <div v-else-if="al.error" class="al-err">
      <div class="al-errmsg">{{ al.error }}</div>
      <el-button size="small" :loading="al.loading" @click="load()">重试</el-button>
    </div>
    <template v-else>
      <div class="al-rules">
        <div class="al-rule" v-for="r in ruleRows" :key="r.k">
          <el-switch :model-value="r.on" @update:model-value="v => set(r.k, 'on', v)" size="small"></el-switch>
          <div class="al-rule-name">{{ r.label }}</div>
          <div class="al-rule-tip">{{ r.tip }}</div>
          <div class="al-rule-val">
            <template v-if="r.k === 'fail'">
              <el-input-number :model-value="r.val" @update:model-value="v => set(r.k, 'val', v)"
                :min="1" :max="100" size="small" style="width:88px"></el-input-number>
              <span class="al-unit">%</span>
              <span class="al-rule-window">最近
                <el-input-number :model-value="r.window" @update:model-value="v => set(r.k, 'window', v)"
                  :min="1" size="small" style="width:64px"></el-input-number> 轮
              </span>
            </template>
            <template v-else>
              <el-input-number :model-value="r.val" @update:model-value="v => set(r.k, 'val', v)"
                :min="1" size="small" style="width:120px" :disabled="!r.on"></el-input-number>
              <span class="al-unit">{{ r.unit }}</span>
            </template>
          </div>
        </div>
        <div class="al-save-row">
          <span class="al-count">当前命中 <b>{{ summary.count }}</b> 条</span>
          <el-button type="primary" size="small" :loading="al.saving" @click="save()">保存规则</el-button>
        </div>
      </div>

      <div class="al-hits">
        <div class="al-sec-head">命中的异常条目（点行可定位回主列表）</div>
        <el-empty v-if="!summary.count" description="没有命中（规则未启用，或当前内存窗口内没有异常）" :image-size="60"></el-empty>
        <template v-else>
          <div class="al-hit" v-for="h in hits" :key="h.id" @click="locate(h.id)">
            <div class="al-hit-l">
              <span class="al-agent">{{ h.agent }}</span>
              <span class="al-rules-tag">
                <el-tag v-for="r in h.rules" :key="r" size="small" :type="tagType(r)" effect="plain">{{ ruleLabel(r) }}</el-tag>
              </span>
              <span class="al-preview" :title="h.preview">{{ h.preview || '（空）' }}</span>
            </div>
            <div class="al-hit-r">
              <span v-if="h.rules.includes('tokens')" class="al-m">token {{ fmtN(h.total) }}</span>
              <span v-if="h.rules.includes('durMs')" class="al-m">耗时 {{ fmtDur(h.dur) }}</span>
              <span v-if="h.rules.includes('fail')" class="al-m">{{ h.status === 'ok' ? '成功' : '失败' }}</span>
              <span class="al-time">{{ fmtTime(h.time) }}</span>
            </div>
          </div>
          <div v-if="hits.length < summary.count" class="al-more">仅显示最近 {{ hits.length }} 条（共 {{ summary.count }} 条命中）</div>
        </template>
      </div>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
    fmtN: { type: Function, required: true },
    fmtDur: { type: Function, required: true },
    fmtTime: { type: Function, required: true },
  },
  emits: ['update:visible', 'locate', 'summary'],
  inject: ['getJSON'],
  setup(props, { emit }) {
    const al = Vue.reactive({ loading: false, saving: false, error: '', j: null });
    const summary = Vue.reactive({ count: 0, agents: [] });
    const hits = Vue.ref([]);
    // 规则编辑态（默认 = 服务端全关）。直接持有可写拷贝，改完按形状提交给 save。
    const rules = Vue.reactive({
      tokens: { on: false, val: 1000 },
      durMs: { on: false, val: 60000 },
      fail: { on: false, val: 50, window: 50 },
    });
    const ruleRows = Vue.computed(() => [
      { k: 'tokens', on: rules.tokens.on, val: rules.tokens.val, label: '单轮 token 超阈值', tip: 'total = 输入 + 输出 + 缓存', unit: 'token' },
      { k: 'durMs', on: rules.durMs.on, val: rules.durMs.val, label: '单轮耗时超阈值', tip: '轮内首条→末条时间差（含挂机/隔夜）', unit: 'ms' },
      { k: 'fail', on: rules.fail.on, val: rules.fail.val, window: rules.fail.window, label: '失败率超阈值', tip: '某 agent 最近 N 轮中失败占比', unit: '%' },
    ]);
    const ruleLabel = k => ({ tokens: 'token', durMs: '耗时', fail: '失败率' })[k] || k;
    const tagType = k => ({ tokens: 'warning', durMs: 'danger', fail: 'info' })[k] || 'info';
    function set(k, field, v) { rules[k][field] = v; }

    async function load() {
      al.loading = true; al.error = '';
      try {
        const j = await getJSON('/api/alert');
        al.j = j;
        Object.assign(rules.tokens, j.rules.tokens || { on: false, val: 0 });
        Object.assign(rules.durMs, j.rules.durMs || { on: false, val: 0 });
        Object.assign(rules.fail, j.rules.fail || { on: false, val: 0, window: 50 });
        summary.count = (j.summary && j.summary.count) || 0;
        summary.agents = (j.summary && j.summary.agents) || [];
        hits.value = (j.hits || []).slice(0, 200);
      } catch (e) { al.error = e.message || String(e); }
      al.loading = false;
    }
    async function save() {
      al.saving = true; al.error = '';
      try {
        const body = {
          rules: {
            tokens: { on: rules.tokens.on, val: rules.tokens.on ? rules.tokens.val : 0 },
            durMs: { on: rules.durMs.on, val: rules.durMs.on ? rules.durMs.val : 0 },
            fail: { on: rules.fail.on, val: rules.fail.on ? rules.fail.val : 0, window: rules.fail.window },
          },
        };
        await getJSON('/api/alert', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        // 保存后重新拉一次，取最新规则回显 + 命中列表（POST 返回摘要不带 hit 明细）
        const fresh = await getJSON('/api/alert');
        al.j = fresh;
        Object.assign(rules.tokens, fresh.rules.tokens);
        Object.assign(rules.durMs, fresh.rules.durMs);
        Object.assign(rules.fail, fresh.rules.fail);
        summary.count = (fresh.summary && fresh.summary.count) || 0;
        summary.agents = (fresh.summary && fresh.summary.agents) || [];
        hits.value = (fresh.hits || []).slice(0, 200);
        // 让根刷新侧栏徽章 / 「只看异常」集合（服务端已广播 alert，但根也可能在此时未连接 SSE）
        emit('summary', fresh.summary || { count: 0, agents: [] });
        ElMessage.success('异常巡检规则已保存');
      } catch (e) { al.error = e.message || String(e); }
      al.saving = false;
    }
    function locate(id) { emit('locate', id); }

    Vue.watch(() => props.visible, v => { if (v) load(); });

    return { al, summary, hits, ruleRows, rules, load, save, locate, set, ruleLabel, tagType, fmtN: props.fmtN, fmtDur: props.fmtDur, fmtTime: props.fmtTime };
  }
};