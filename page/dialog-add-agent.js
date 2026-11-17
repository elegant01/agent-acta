// 添加 agent 弹层（R25 批 1 第二个组件）。
// 契约见 page/shared.js 头部；顶层只许有那一处 AACTA 赋值，Vue / Element Plus 的 API 一律写全名。
//
// 数据进出：
//   · visible ← 根（侧栏 agent 列表右上角的「+」）
//   · getJSON ← 根 provide（POST 也要它：404 得能点亮版本红条，口径只有根里一份）
//   · 添加成功后 emit('added') —— 重新拉 agents 与快照是根的活儿（那是根的 all/agents 状态），
//     组件不碰：它只负责「把这一条 POST 出去、把失败原因摆出来」
//
// 「探测」是什么（POST /api/probe，对应 dsh-skills-manager 的 Add source + Scan subfolders）：
//   不知道一个目录是哪家的日志根时，先粘进来让它用**和自动发现同一套判据**认一遍
//   （本层 → 往上 4 层 → 往下 2 层），认出来就把建议名称与真正的根一键填回表单。
//   它只读、不注册任何东西；「添加」还是走 /api/agents 那条老路。
window.AACTA = window.AACTA || {};
AACTA.DialogAddAgent = {
  name: 'aa-dialog-add-agent',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="添加 agent" width="520px" append-to-body>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="Agent 名称">
        <el-input v-model="addForm.name" placeholder="如 claude、trae、cursor…" @keyup.enter="submitAdd"></el-input>
        <div class="form-tip">留空路径时按平台自动探测：~/.名称（全平台）、%APPDATA%（Win）、Application Support（mac）、~/.config（Linux/HarmonyOS）</div>
        <div class="form-tip">已知 agent（claude / codex / cursor / trae / traework / qoder / opencode / kilo / gemini / copilot / windsurf / codearts / kimi / dsh / zcode / doubao / hermes / devin / minimax / mimocode / openclaw / comate / cline / pi / qwen / crush / droid / goose / openhands / commandcode）服务启动时会自动发现，无需手动添加。</div>
        <div class="form-tip">codebuddy 一家有三份落盘，<b>侧栏只有一行 codebuddy</b>：CLI 的 ~/.codebuddy/projects 与 genie 扩展（VSCode / JetBrains / CodeBuddy CN 应用共用）的 %LOCALAPPDATA%\\CodeBuddyExtension\\Data 都并到这一行；%APPDATA%\\CodeBuddy CN 那个目录只有 IDE 缓存、没有会话正文。</div>
        <div class="form-tip">qwen / hunyuan / grok 目前<b>只有图标、没有解析器</b>：不会被自动发现，手动添加也会因识别不到日志结构而失败（R16 遗留）。</div>
      </el-form-item>
      <el-form-item label="日志路径（可选）">
        <div class="path-row">
          <el-input v-model="addForm.path" placeholder="手动指定根目录，或 sessions / projects 目录" @keyup.enter="submitAdd"></el-input>
          <el-button :loading="probeLoading" :disabled="!addForm.path.trim()" @click="runProbe">探测</el-button>
        </div>
        <div class="form-tip">不知道名字？把目录粘进来点「探测」：它按自动发现那套判据认一遍（本层、往上 4 层、往下 2 层），认出来就一键填回上面两栏。只读，不会登记任何东西。</div>
        <div v-if="probe" class="probe">
          <template v-if="probe.ok && probe.recognized">
            <div class="probe-line">认出来了：<b>{{ probe.kind }}</b><span v-if="!probe.selfRecognized">（结构在你填的那层上面，不是这一层）</span></div>
            <div class="tried-p">{{ probe.note }}</div>
            <div class="tried-p">根：{{ probe.matchedAt }}</div>
            <div v-if="probe.ownedBy" class="probe-warn">这个目录{{ probe.ownedBy.exact ? '' : '（或它里面）' }}已经由 agent「{{ probe.ownedBy.name }}」在扫了，再加一条会被拒（条目按「文件路径 + 轮」寻址，重叠扫会重复计数）。</div>
            <div v-else style="margin-top:6px"><el-button size="small" type="primary" plain @click="fillProbe(probe)">用这个目录</el-button></div>
          </template>
          <template v-else-if="probe.ok && probe.children && probe.children.length">
            <div class="probe-line">这一层不是日志根，但底下认出来了：{{ probe.note }}</div>
            <div v-for="c in probe.children" :key="c.path" class="probe-kid">
              <span class="tried-p">{{ c.rel }} · {{ c.kind }}</span>
              <span v-if="c.ownedBy" class="probe-warn">已被「{{ c.ownedBy.name }}」扫</span>
              <el-button v-else size="small" link type="primary" @click="fillProbe(c)">填这个</el-button>
            </div>
            <div v-if="probe.truncated" class="probe-warn">预算用完了，只看了 {{ probe.scanned }} 个目录，没列出的地方可能还有。</div>
          </template>
          <template v-else-if="probe.ok">
            <div class="probe-line">没认出来。{{ probe.note }}</div>
            <div v-if="probe.hint" class="tried-p">{{ probe.hint }}</div>
            <div v-if="(probe.tried || []).length" class="tried">
              <div class="tried-t">逐层试过的路径与原因（可整段复制给帮你排查的人）：</div>
              <div v-for="t in probe.tried" :key="t" class="tried-p">{{ t }}</div>
            </div>
          </template>
          <div v-else class="probe-warn">{{ probe.error }}</div>
        </div>
      </el-form-item>
      <el-alert v-if="addError" :title="addError" type="error" :closable="false" show-icon></el-alert>
      <div v-if="addTried.length" class="tried">
        <div class="tried-t">逐条试过的路径与各自的原因（可整段复制给帮你排查的人）：</div>
        <div v-for="t in addTried" :key="t" class="tried-p">{{ t }}</div>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="addLoading" @click="submitAdd">添加</el-button>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
  },
  emits: ['update:visible', 'added'],
  setup(props, { emit }) {
    const getJSON = Vue.inject('getJSON');
    const addForm = Vue.reactive({ name: '', path: '' });
    const addError = Vue.ref('');
    const addTried = Vue.ref([]);
    const addLoading = Vue.ref(false);
    // probe 存的是接口原样返回的 JSON（ok 也带上，三种分支在前端各排一次），失败的传输错误也塞成 {ok:false,error}
    const probe = Vue.ref(null);
    const probeLoading = Vue.ref(false);
    async function submitAdd() {
      if (!addForm.name.trim()) { addError.value = '请填写 agent 名称'; return; }
      addError.value = ''; addTried.value = []; addLoading.value = true;
      try {
        const j = await getJSON('/api/agents', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: addForm.name, path: addForm.path || undefined }),
        });
        if (!j.ok) { addError.value = j.error || '添加失败'; addTried.value = j.tried || []; return; }
        ElementPlus.ElMessage.success('已添加 ' + j.name + '（' + j.kind + ' 格式 · ' + (j.sessions || j.traces) + '）');
        emit('update:visible', false);
        emit('added');   // 拉新数据是根的活儿（改前是这儿直接调 loadAgents/loadSnapshot）
      } catch (e) { addError.value = e.message; }
      finally { addLoading.value = false; }
    }
    async function runProbe() {
      const p = addForm.path.trim();
      if (!p) return;
      probe.value = null; probeLoading.value = true;
      try {
        probe.value = await getJSON('/api/probe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        });
      } catch (e) { probe.value = { ok: false, error: e.message }; }
      finally { probeLoading.value = false; }
    }
    // hit 既可能是探测结果本身，也可能是 children 里的一项（两者字段同名，只有 path/sessions 的取法不同）
    function fillProbe(hit) {
      addForm.name = hit.suggestedName || '';
      addForm.path = hit.sessions || hit.traces || hit.matchedAt || hit.path || '';
      addError.value = ''; addTried.value = [];
      ElementPlus.ElMessage.success('已填入 ' + addForm.name + '，确认后点「添加」');
    }
    // 每次打开都是干净的表单（改前由 openAdd 重置；现在开与关都在根，重置挂在这儿）
    Vue.watch(() => props.visible, v => {
      if (v) { addForm.name = ''; addForm.path = ''; addError.value = ''; addTried.value = []; probe.value = null; }
    });
    return { addForm, addError, addTried, addLoading, probe, probeLoading, submitAdd, runProbe, fillProbe };
  }
};