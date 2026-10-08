// 「解析器自检」弹层（R32 / I5）：把上一次 `node test/selftest.mjs` 的结果摊开给人看。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 数据进出（与 dialog-usage / dialog-diag 同法：开关归根、数据归组件）：
//   · visible ← 根（侧栏「解析器自检」项点开 / 弹层关掉时回写）
//   · getJSON ← 根 provide（接口 404 要点亮顶部版本红条，那段逻辑只有根里一份）
//   · 自己拉 /api/selftest（服务端只读 ~/.agent-acta/selftest.json，不 spawn 任何测试）
//
// 为什么这里**没有「跑一遍」按钮**（用户 2026-09-22 定的两条口径）：
//   1) 一轮默认清单要串行起停二十来个服务、跑两分钟，副作用挂在一个弹层上 = 谁都不敢刷新；
//      跑的动作留在终端里，由人决定什么时候花这两分钟。
//   2) 也不在这儿「拿真日志重解析一遍」—— 那是 `agentacta --doctor` 的活（环境诊断弹层里已经接了）。
//      这一页保持纯回归结果，不掺真机数据，两边才各自能说清自己在回答什么问题。
//
// 三处口径要留意（都是刻意定的，页面只是别把它藏起来）：
//   · sameBuild=false 必须显式警告：结果出自另一版代码，一页绿字如果不代表当前这版，比没有自检更危险。
//   · 「这次没跑的」要跟数量与理由（skipped[].why / groups[].note）：默认清单只有 23 条，
//     剩下 13 条要真机数据 / 要 dist 包 / 靶子是常驻服务 —— 不写清楚，页面就显得「测试全过了」。
//   · bench / probe 那几个连失败概念都没有（找不到目录也退 0），永久排除：一个永远绿的检查比没有检查更糟。
window.AACTA = window.AACTA || {};
AACTA.DialogSelftest = {
  name: 'aa-dialog-selftest',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="解析器自检" width="min(940px, 95vw)" append-to-body class="sf-dialog">
    <div class="sf-hint">
      这里看的是<b>上一次回归跑的结果</b>：改完解析口径会不会弄坏邻居，不用挨个敲那二十几个脚本。
      这一页<b>只读、不跑测试</b> —— 一轮要串行起停二十来个服务、跑两分钟，得由你在终端里决定什么时候花这两分钟：
      <code>node test/selftest.mjs</code>（<code>--only</code> 挑子集、<code>--group</code> 挑一组、<code>--all</code> 连默认不跑的一起跑）。
    </div>
    <el-skeleton v-if="sf.loading && !sf.j" :rows="6" animated></el-skeleton>
    <div v-else-if="sf.error" class="sf-err">
      <div class="sf-errmsg">{{ sf.error }}</div>
      <el-button size="small" :loading="sf.loading" @click="run()">重试</el-button>
    </div>
    <div v-else-if="!sf.j || !sf.j.ok" class="sf-none">
      <div class="sf-none-t">{{ sf.j && sf.j.error ? sf.j.error : '拿不到结果' }}</div>
      <div class="sf-none-b">
        在仓库的 <code>agent-acta/</code> 目录下跑一次就有内容了（结果写进
        <code>{{ (sf.j && sf.j.file) || '~/.agent-acta/selftest.json' }}</code>，服务只读它）：
      </div>
      <div class="sf-cmd">
        <code>node test/selftest.mjs</code>
        <el-button size="small" text @click="copyRaw($event, 'node test/selftest.mjs')">复制</el-button>
      </div>
    </div>
    <div v-else>
      <!-- build 不同 = 这份绿不代表你现在看的这版代码。它必须排在汇总之前，不然人会先看到「全绿」。 -->
      <div v-if="!sf.j.sameBuild" class="sf-warn">
        这份结果出自 <code>{{ revOf(sf.j.self) }}</code>，当前服务是 <code>{{ revOf(sf.j.server) }}</code>。
        <b>中间改过代码</b>，这一页的绿不代表现在这一版 ——
        要判断这一版，请在终端重跑一次 <code>node test/selftest.mjs</code>。
        <template v-if="sf.j.sameParserRev">（解析器口径倒是一致：改的大概不是解析那层。）</template>
      </div>
      <div v-else-if="!sf.j.sameParserRev" class="sf-warn">
        代码指纹对得上，但<b>解析器口径与结果里那份不一致</b>（各 kind 的 rev 有出入）——
        这份结果不足以说明现在的口径是对的，请重跑。
      </div>

      <div class="sf-sum" :class="{bad: !allGreen}">
        <span class="sf-verdict">
          <i class="sf-vico" :class="allGreen ? 'pass' : 'fail'">{{ allGreen ? '✓' : '✗' }}</i>
          <template v-if="allGreen">{{ sf.j.summary.total }} 项全绿</template>
          <template v-else>{{ bad }} 项不绿 <i>/ {{ sf.j.summary.total }}</i></template>
        </span><i>·</i>
        <span>用时 <b>{{ dur(sf.j.durationMs) }}</b></span><i>·</i>
        <span>{{ ageText }}</span><i>·</i>
        <span>{{ sf.j.rows.length }} 跑过 / {{ sf.j.skipped.length }} 没跑</span>
        <div class="sf-sum-2">
          跑它时 {{ sf.j.self.version || '?' }} / 指纹 <code>{{ sf.j.self.build || '?' }}</code> ·
          这台机器 node {{ sf.j.env.node }} / {{ sf.j.env.platform }} ·
          不绿 {{ sf.j.summary.fail }}、超时 {{ sf.j.summary.timeout }}、runner 没收住 {{ sf.j.summary.error }}
        </div>
      </div>

      <!-- 分组表来自 runner；万一某行的 group 不在表里（旧结果 / 手改过的文件），它得落在「未分组」里，
           而不是跟着找不到分组的循环被静默跳过 —— 少几行还报「全绿」是这一页最不该犯的错。 -->
      <template v-for="sec in sections" :key="sec.id">
        <div class="sf-cap">
          {{ sec.label }}
          <span class="sf-cap-note">{{ sec.rows.length }} 项 · {{ dur(sec.ms) }}</span>
          <span v-if="sec.bad" class="sf-tag bad">{{ sec.bad }} 项不绿</span>
        </div>
        <div class="sf-list">
          <div v-for="r in sec.rows" :key="r.file" class="sf-row" :class="r.status">
            <span class="sf-st">{{ iconOf(r.status) }}</span>
            <span class="sf-nm">
              <span class="sf-title">{{ r.title }}</span>
              <span class="sf-file">{{ r.file }}</span>
              <span v-if="r.status !== 'pass'" class="sf-tag" :class="r.status">{{ statusText(r.status) }}</span>
            </span>
            <span class="sf-ms">{{ dur(r.ms) }}</span>
            <div v-if="r.status !== 'pass'" class="sf-detail">
              <div v-if="r.tail" class="sf-tail">{{ r.tail }}</div>
              <pre v-if="r.reds && r.reds.length" class="sf-reds">{{ r.reds.join('\\n') }}</pre>
              <div v-if="r.note" class="sf-tail">这一类默认不进清单：{{ r.note }}</div>
              <div v-if="!r.tail && !(r.reds && r.reds.length)" class="sf-tail">（这个脚本没留下可读的失败行，退出码 {{ r.code }}；去终端跑它看全文）</div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="sf.j.skipped.length" class="sf-cap">
        这次没跑的 <span class="sf-cap-note">{{ sf.j.skipped.length }} 项 —— 不是漏了，是默认清单故意不收；每一类为什么不收，runner 随结果一起写了理由</span>
      </div>
      <div v-if="sf.j.skipped.length" class="sf-skip">
        <div v-for="g in skipSections" :key="g.id" class="sf-skip-g">
          <div class="sf-skip-h">{{ g.label }}<span v-if="g.note" class="sf-skip-note">{{ g.note }}</span></div>
          <div v-for="s in g.items" :key="s.file" class="sf-skip-i">
            <code>{{ s.file }}</code><span>{{ s.title }}</span><em>{{ s.why }}</em>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <span class="sf-foot">这一页只读上次结果（服务端不 spawn 测试子进程）；要跑请在终端敲上面那条命令。
        结果文件 <code>{{ (sf.j && sf.j.file) || '~/.agent-acta/selftest.json' }}</code> 跟着 HOME 走，
        所以源码树里跑的 runner 和常驻服务读到的是同一份。</span>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button type="primary" :loading="sf.loading" @click="run()">重新读取</el-button>
    </template>
  </el-dialog>`,
  props: { visible: Boolean },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    const sf = Vue.reactive({ loading: false, error: '', j: null });
    // 归一化：结果文件是人也能手工碰的东西（runner 正常写出的一定全，缺字段的旧文件/改坏的文件也可能有）。
    // 缺什么就按行本身现算，而不是让模板读到 undefined 整片空白 —— 汇总说「全绿」而实际少了几行，
    // 是这一页最不能犯的错。
    function norm(j) {
      const rows = Array.isArray(j.rows) ? j.rows : [];
      const st = k => rows.filter(r => r.status === k).length;
      j.rows = rows; j.skipped = Array.isArray(j.skipped) ? j.skipped : []; j.groups = Array.isArray(j.groups) ? j.groups : [];
      j.self = j.self || {}; j.env = j.env || {};
      j.summary = j.summary || {};
      j.summary.total = Number(j.summary.total) || rows.length;
      j.summary.pass = st('pass');
      j.summary.fail = st('fail'); j.summary.timeout = st('timeout'); j.summary.error = st('error');
      return j;
    }
    async function run() {
      if (sf.loading) return;
      sf.loading = true;
      try {
        const j = await getJSON('/api/selftest');
        sf.j = norm(j); sf.error = '';
      } catch (e) { sf.error = '自检结果读取失败：' + e.message; }
      finally { sf.loading = false; }
    }
    // 点开才读（一次文件读取，不缓存：每次都想要最新的年龄）
    Vue.watch(() => props.visible, v => { if (v) run(); });

    // 分组渲染统一走「组 → 行」两张表：先按 runner 给的分组表排，表外那些（旧结果里没这个 id、
    // 或分组表整个没带）兜到「未分组」一节，绝不因为对不上号就少几行。
    const bucketize = (groups, items, groupOf) => {
      const gs = Array.isArray(groups) ? groups : [];
      const known = new Set(gs.map(g => g.id));
      const out = gs.map(g => ({ id: g.id, label: g.label || g.id, note: g.note, items: items.filter(x => groupOf(x) === g.id) }));
      const rest = items.filter(x => !known.has(groupOf(x)));
      if (rest.length) out.push({ id: '__rest', label: '未分组（结果里的 group 对不上分组表）', note: '', items: rest });
      return out.filter(x => x.items.length);
    };
    // 没跑的那批按「为什么这一类不收」成组显示：分组表是 runner 随结果一起发出来的，这里不另立名单
    const skipSections = Vue.computed(() => bucketize(sf.j && sf.j.groups, (sf.j && sf.j.skipped) || [], s => s.group));
    const sections = Vue.computed(() => {
      const j = sf.j; if (!j) return [];
      // 行的 label 用分组表的；一行的 group 缺席时也照样出现（见 bucketize 的兜底）
      return bucketize(j.groups, j.rows, r => r.group).map(sec => {
        const rows = sec.items;
        return { id: sec.id, label: sec.label, rows,
          ms: rows.reduce((s, r) => s + (r.ms || 0), 0),
          bad: rows.filter(r => r.status !== 'pass').length };
      });
    });
    const allGreen = Vue.computed(() => !!sf.j && !!sf.j.rows.length
      && sf.j.summary.fail === 0 && sf.j.summary.timeout === 0 && sf.j.summary.error === 0
      && sf.j.rows.every(r => r.status === 'pass'));
    const bad = Vue.computed(() => (sf.j ? sf.j.summary.total - sf.j.summary.pass : 0));
    const ageText = Vue.computed(() => {
      if (!sf.j) return '—';
      const a = sf.j.ageMs || 0;
      // 年龄超过一天就别报「x 天前」了事：自检是「改完之后跑」的东西，隔天以上本身就说明它旧
      const t = a < 60000 ? '刚刚' : a < 3600000 ? Math.floor(a / 60000) + ' 分钟前'
        : a < 86400000 ? Math.floor(a / 3600000) + ' 小时前' : Math.floor(a / 86400000) + ' 天前';
      return '跑完于 ' + t + '（' + fmtTime(Date.parse(sf.j.at) || Date.now() - a) + '）';
    });
    // 与 runner 里那个 fmtMs 同口径（先四舍五入到整秒再拆分）：直接用页面的 fmtDur 会算出「1 分 60 秒」
    const dur = n => {
      const ms = Number(n) || 0;
      if (ms < 1000) return ms + ' ms';
      const tot = Math.round(ms / 1000);
      if (tot < 60) return (ms / 1000).toFixed(1) + ' 秒';
      const m = Math.floor(tot / 60), s = tot % 60;
      return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
    };
    const revOf = o => o && o.build ? o.version + ' / ' + String(o.build).slice(0, 8) : '未知版本';
    const iconOf = st => ({ pass: '✓', fail: '✗', timeout: '✗', error: '!' })[st] || '?';
    const statusText = st => ({ fail: '断言红', timeout: '超时', error: 'runner 没收住' })[st] || st;
    // copyRaw 是 page/shared.js 的顶层函数（与根模板用的是同一份），这里只是让模板能看见它
    return { sf, run, sections, skipSections, allGreen, bad, ageText, dur, revOf, iconOf, statusText, copyRaw };
  }
};
