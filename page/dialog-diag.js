// 环境诊断弹层（R25 批 1 从 agent-acta-page.html 搬出的第一个组件）。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；本文件顶层只许有那一处 AACTA 赋值 ——
// Vue 的 API 一律写全名（Vue.reactive / Vue.watch / Vue.inject），**不要解构**：
// 顶层 const 与根内联 script 共享同一个全局词法作用域，重名就是整页 SyntaxError。
//
// 数据进出（搬的时候逐个对过）：
//   · visible   ← 根（侧栏「环境诊断」项点开、弹层关掉时回写）—— 开关状态留根，与改前一样
//   · pageBuild ← 根（底部那行「服务自报指纹 ≠ 页面注入指纹」的比对基准）
//   · getJSON   ← 根 provide：接口 404 要点亮顶部版本红条，那段逻辑只有根里一份，别在这儿重写
//   · 自己拉 /api/diagnose（改前就是独立 fetch，不依赖根的任何状态）
window.AACTA = window.AACTA || {};
AACTA.DialogDiag = {
  name: 'aa-dialog-diag',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="环境诊断" width="720px" append-to-body>
    <div class="diag-hint">
      下面逐个列出候选 agent 的探测结果：<b>已接入</b>是正常在扫；<b>目录在但未识别</b>说明这个 agent
      的日志目录就在本机、但格式还没写过解析器（顺着给出的路径补一个即可）；
      <b>已由 xxx 接入</b>是同一份目录被另一个 agent 接走了（避免重复扫描，不是故障）。
    </div>
    <el-skeleton v-if="diag.loading" :rows="5" animated></el-skeleton>
    <el-alert v-else-if="diag.error" :title="diag.error" type="error" :closable="false" show-icon></el-alert>
    <div v-else>
      <div v-for="a in diag.rows" :key="a.name" class="diag-row">
        <span class="dn">{{ a.name }}</span>
        <span class="ds" :class="a.state==='ok' ? 'ok' : (a.state==='absent' ? 'off' : 'warn')">{{ a.stateText }}</span>
        <div class="db">
          <div class="dnote">{{ a.note }}</div>
          <div v-for="c in a.candidates" :key="c.path">
            <div class="dpath">{{ c.exists ? '✓' : '·' }} {{ c.path }}<template v-if="c.reason"> —— {{ c.reason }}</template></div>
            <div v-if="c.hint" class="dhint">　{{ c.hint }}</div>
          </div>
        </div>
      </div>
      <div class="diag-hint" style="margin-top:10px">
        平台：{{ diag.platform || '？' }} ｜ 数据目录：{{ diag.dataDir }} ｜ 端口：{{ diag.port }} ｜ 服务版本：{{ diag.version || '？' }}（指纹 {{ diag.build ? diag.build.slice(0, 12) : '无' }}）
        <!-- 指纹是「正在跑的服务」自报的代码指纹，与页面顶部注入的那份比对不上就是新旧错配。
             「我装的是新版、怎么没有新功能」这类问题，第一步就看这一行。 -->
        <span v-if="diag.build && diag.build !== pageBuild" style="color:var(--red)">　⚠ 与页面不一致，请重启服务</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button type="primary" :loading="diag.loading" @click="run">重新探测</el-button>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
    pageBuild: { type: String, default: '' },
  },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    // 改前这个对象还带 visible 字段（弹层开关），现在开关归根 —— 放这儿会有两份真相
    const diag = Vue.reactive({ loading: false, error: '', rows: [], platform: '', dataDir: '', port: '', version: '', build: '' });
    async function run() {
      diag.loading = true; diag.error = '';
      try {
        const j = await getJSON('/api/diagnose');
        if (!j.ok) throw new Error(j.error || '诊断失败');
        diag.rows = j.agents || [];
        diag.platform = j.platform || '';   // 截图发回来时能自证是哪台机器（四平台验证靠它）
        diag.dataDir = j.dataDir || ''; diag.port = j.port || '';
        diag.version = j.version || ''; diag.build = j.build || '';
      } catch (e) { diag.error = '诊断失败：' + e.message; }
      finally { diag.loading = false; }
    }
    // 侧栏点开就探一次（改前是 openDiagnose 顺手把 visible 置 true；现在根只置 visible，探测挂在这儿）
    Vue.watch(() => props.visible, v => { if (v) run(); });
    return { diag, run };
  }
};
