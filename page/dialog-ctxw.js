// 上下文窗口弹层（R25 批 1 第三个组件）。
// 契约见 page/shared.js 头部；顶层只许有那一处 AACTA 赋值，Vue / Element Plus 的 API 一律写全名。
//
// 数据进出 —— 这个弹层与别处不同：**表数据不属于它**。
//   改前 ctxw.rows/unknown 就是根里的一个 reactive，侧栏那枚「待填 N」徽章（ctxUnfilled）吃的是
//   同一份 unknown.length。搬的时候如果把表整个端进组件，根就得在徽章和服务之间来回同步两份状态。
//   所以定成：**弹层自己拉、自己改（编辑态是它的），拉回来的结论上报给根**（emit('unfilled', n)），
//   根只留一个数字给徽章。保存成功后同样上报 —— 服务端重算了卡片，徽章要跟着变。
//   · visible ← 根（侧栏「上下文窗口」项点开、弹层自己关闭时回写）
//   · getJSON ← 根 provide（404 要点亮版本红条）
window.AACTA = window.AACTA || {};
AACTA.DialogCtxw = {
  name: 'aa-dialog-ctxw',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="上下文窗口" width="640px" append-to-body>
    <div class="diag-hint">
      卡片上「上下文」那根进度条需要两个数：<b>分子</b>是这一轮的占用（从日志里的 usage 算，已经有了），
      <b>分母</b>是模型窗口容量。分母**只有 claude 和 kimi 拿不到** —— 其余 agent 自带这个字段；
      claude 的请求体不落盘、kimi 的 wire.jsonl 只记用量，都只能按模型名查这张表。
      查不到的模型就只显示占用、不画条：宁可少一根条，也不拿一个假分母凑出一根看着像真的。
      <div style="margin-top:6px">表里的名字是**日志里的模型名**（网关转发后的名字，如 deepseek-flash / kimi-k3）。可以写全名，也可以写前缀（按最长命中）。填 <b>0</b> 表示停用这一条。</div>
    </div>
    <el-skeleton v-if="ctxw.loading" :rows="4" animated></el-skeleton>
    <template v-else>
      <div class="ctxw-t">已配置</div>
      <div v-for="(r, i) in ctxw.rows" :key="i" class="ctxw-row" :class="{off: !(r.value > 0)}">
        <el-input v-model="r.name" size="small" placeholder="模型名或前缀" class="ctxw-name"></el-input>
        <el-input-number v-model="r.value" size="small" :min="0" :step="1024" :controls="false" class="ctxw-val"></el-input-number>
        <span class="ctxw-src">{{ r.builtin ? '内置' : '自定义' }}{{ !(r.value > 0) ? ' · 停用' : '' }}</span>
        <el-icon class="del-btn" title="删掉这一行（保存后生效）" @click="ctxw.rows.splice(i, 1)"><Close></Close></el-icon>
      </div>
      <el-button size="small" style="margin-top:6px" @click="ctxw.rows.push({ name: '', value: 200000, builtin: false })">加一行</el-button>

      <template v-if="ctxw.unknown.length">
        <div class="ctxw-t" style="margin-top:14px">日志里出现过、表里没有的模型（点一下加进上表）</div>
        <div class="ctxw-chips">
          <span v-for="u in ctxw.unknown" :key="u.model" class="ctxw-chip" @click="addCtxRow(u.model)">
            {{ u.model }} <small>{{ u.n }} 轮</small>
          </span>
        </div>
      </template>
      <div v-else class="ctxw-t" style="margin-top:14px;font-weight:400;color:var(--placeholder)">
        日志里的模型都有窗口值了。
      </div>
    </template>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button type="primary" :loading="ctxw.saving" @click="saveCtxWindows">保存</el-button>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
  },
  emits: ['update:visible', 'unfilled'],
  setup(props, { emit }) {
    const getJSON = Vue.inject('getJSON');
    // visible 不在这个对象里：开关归根（与别的弹层一致），放这儿会有两份真相
    const ctxw = Vue.reactive({ loading: false, saving: false, rows: [], unknown: [] });
    // 服务端每次都整表回吐（含刚刚保存后的重算结果），落地与上报只有这一处
    function apply(j) {
      ctxw.rows = (j.windows || []).map(r => ({ name: r.name, value: r.value, builtin: !!r.builtin }));
      ctxw.unknown = j.unknown || [];
      emit('unfilled', ctxw.unknown.length);   // 侧栏徽章在根上，只有它需要知道这个数
    }
    async function load() {
      ctxw.loading = true;
      try {
        const j = await getJSON('/api/ctxwindows');
        if (!j.ok) throw new Error(j.error || '读取失败');
        apply(j);
      } catch (e) {
        ElementPlus.ElMessage.error('读取上下文窗口表失败：' + e.message);
      } finally { ctxw.loading = false; }
    }
    function addCtxRow(model) {
      if (ctxw.rows.some(r => r.name === model)) { ElementPlus.ElMessage.info('这个模型已经在表里了'); return; }
      ctxw.rows.push({ name: model, value: 200000, builtin: false });
      ctxw.unknown = ctxw.unknown.filter(u => u.model !== model);
    }
    async function saveCtxWindows() {
      ctxw.saving = true;
      try {
        // 整表提交：空名字的行丢掉，0/空 = 停用（照常提交，否则内置那条默认删不掉）
        const windows = ctxw.rows
          .map(r => ({ name: String(r.name || '').trim(), value: Number(r.value) > 0 ? Math.round(Number(r.value)) : 0 }))
          .filter(r => r.name);
        const j = await getJSON('/api/ctxwindows', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windows }),
        });
        if (!j.ok) throw new Error(j.error || '保存失败');
        apply(j);
        ElementPlus.ElMessage.success(j.changed ? '已保存，重算了 ' + j.changed + ' 张卡片' : '已保存');
      } catch (e) {
        ElementPlus.ElMessage.error('保存失败：' + e.message);
      } finally { ctxw.saving = false; }
    }
    Vue.watch(() => props.visible, v => { if (v) load(); });
    return { ctxw, addCtxRow, saveCtxWindows };
  }
};
