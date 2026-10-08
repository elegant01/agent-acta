// 两轮对比弹层（候选池 I9）：选中主列表里两条轮，并排对比模型 / token / 工具链 / 耗时，
// 回答「同一个 prompt 为什么这次慢」。入口 = 每张卡片顶行的「对比」按钮（选两条自动弹开）。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue / Element Plus 的 API 一律写全名。
//
// 数据进出：
//   · visible ← 根（卡片「对比」选满两条 / 弹层关闭时回写）
//   · req     ← 根：{ a, b } —— 两条条目本体（快照 / 搜索命中集里现有的对象，带模型 / token / 耗时等统计字段）
//   · getJSON ← 根 provide（接口 404 要点亮版本红条）
//   · 正文（用户输入 / AI 输出 / 工具链）仍走 /api/entry 懒加载：点开对比才取，两条各自独立缓存。
//
// 对比口径：统计行用的是条目**本体**（快照就带，不必等详情），正文与工具链用的是 /api/entry 详情。
// 每条指标行给一个「谁大」的标记 —— 这一条是 diff 的意义所在，光把两列摆一起不标出差值不算对比。
// qoder 不落盘 token（tin/tout/total 恒 0，只有最后一次调用的 context_usage_ratio）：
//   它的格子一律走「积分」与「占比」两行，绝不在 Token 行印 0（印了会被读成「这轮没花钱」），
//   两侧单位不同（一积分一 token）时不做差 —— 与卡片 page/log-card.js 的 isQoder 分支同一口径。
window.AACTA = window.AACTA || {};
AACTA.DialogCompare = {
  name: 'aa-dialog-compare',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="两轮对比" width="min(1100px, 96vw)" append-to-body class="cmp-dialog" top="4vh">
    <div v-if="!reqA || !reqB" class="empty">还没有选够两条轮，先回列表里点卡片顶行的「对比」。</div>
    <div v-else>
      <!-- 概览：两列头部（agent / 模型 / 时间 / 状态）+ 耗时条相对比例 -->
      <div class="cmp-head">
        <div class="cmp-col cmp-col-b">
          <div class="cmp-hdr">
            <span class="cmp-agent"><b>{{ titleOf(reqA) }}</b></span>
            <span class="mini-tag">{{ reqA.agent }}</span>
            <span :class="'tag ' + (reqA.status==='ok' ? 'tag-ok' : 'tag-err')">{{ reqA.status==='ok' ? 'OK' : 'ERR ⚠' }}</span>
          </div>
          <div class="cmp-meta">{{ fmtTime(reqA.time) }} · {{ reqA.project }}</div>
        </div>
        <div class="cmp-vs">VS</div>
        <div class="cmp-col">
          <div class="cmp-hdr">
            <span class="cmp-agent"><b>{{ titleOf(reqB) }}</b></span>
            <span class="mini-tag">{{ reqB.agent }}</span>
            <span :class="'tag ' + (reqB.status==='ok' ? 'tag-ok' : 'tag-err')">{{ reqB.status==='ok' ? 'OK' : 'ERR ⚠' }}</span>
          </div>
          <div class="cmp-meta">{{ fmtTime(reqB.time) }} · {{ reqB.project }}</div>
        </div>
      </div>

      <div class="cmp-table">
        <!-- 耗时：并排进度条，一眼看出谁慢 -->
        <div class="cmp-row cmp-dur">
          <span class="cmp-label">耗时<b v-if="durDiffOn" class="cmp-hot">差 {{ cmpDurText }}</b></span>
          <div class="cmp-barwrap">
            <div class="cmp-bar" :style="{width: durPctOf(reqA) + '%'}"><span>{{ fmtDur(reqA.dur) }}</span></div>
          </div>
          <div class="cmp-barwrap">
            <div class="cmp-bar bar-b" :style="{width: durPctOf(reqB) + '%'}"><span>{{ fmtDur(reqB.dur) }}</span></div>
          </div>
        </div>
        <!-- 指标行全在 setup 的 cmpRows 里算：显示文本、「谁大」、「差多少」用同一份数，不在模板里各算一遍 -->
        <div class="cmp-row" v-for="r in cmpRows" :key="r.label">
          <span class="cmp-label">{{ r.label }}<b v-if="r.hot" class="cmp-hot">{{ r.hot }}</b></span>
          <span class="cmp-val" :class="{big: r.big === 'a'}" :title="r.at">{{ r.a }}</span>
          <span class="cmp-val" :class="{big: r.big === 'b'}" :title="r.bt">{{ r.b }}</span>
        </div>
      </div>

      <div class="cmp-loading" v-if="loading">正在读取两条正文…</div>
      <div v-else-if="err" class="cmp-err">{{ err }} <el-button size="small" @click="load">重试</el-button></div>
      <!-- 正文对比 -->
      <div v-else class="cmp-body">
        <div class="cmp-sec">
          <div class="cmp-sec-head"><h4>用户输入</h4></div>
          <div class="cmp-cols">
            <div class="cmp-col"><pre class="cmp-pre">{{ detA && detA.user ? detA.user : '(空)' }}</pre></div>
            <div class="cmp-col"><pre class="cmp-pre">{{ detB && detB.user ? detB.user : '(空)' }}</pre></div>
          </div>
        </div>
        <div class="cmp-sec" v-if="(detA && detA.assistant) || (detB && detB.assistant)">
          <div class="cmp-sec-head"><h4>AI 输出</h4></div>
          <div class="cmp-cols">
            <div class="cmp-col"><div v-if="detA && detA.assistant" class="md-body" v-html="detA._assistantMd"></div><span v-else class="cmp-none">(无)</span></div>
            <div class="cmp-col"><div v-if="detB && detB.assistant" class="md-body" v-html="detB._assistantMd"></div><span v-else class="cmp-none">(无)</span></div>
          </div>
        </div>
        <div class="cmp-sec" v-if="(detA && detA.tools && detA.tools.length) || (detB && detB.tools && detB.tools.length)">
          <div class="cmp-sec-head"><h4>工具调用</h4></div>
          <!-- 入参/返回一律先读 prepDetail 缓存的 _inPretty / _outPretty（缓存缺失才现算）：
               一对长会话能并到 90 多个工具项，每条重渲染都全量 prettyJson 就是把卡片当年踩过的坑再踩一遍。 -->
          <div class="cmp-cols">
            <div class="cmp-col">
              <div v-for="(t, i) in (detA ? detA.tools : [])" :key="i" class="tool-item cmp-tool">
                <div class="tool-head"><span class="tname">{{ t.name }}</span><span v-if="t.error" class="terr">✗ {{ t.error }}</span><span v-if="t.dur!=null" class="tdur">{{ fmtDur(t.dur) }}</span></div>
                <pre v-if="t.input" class="cmp-pre">{{ t._inPretty || prettyJson(t.input) }}</pre>
                <pre v-if="t.output" class="cmp-pre">{{ t._outPretty || prettyJson(t.output) }}</pre>
              </div>
              <span v-if="!detA || !detA.tools || !detA.tools.length" class="cmp-none">(没有工具调用)</span>
            </div>
            <div class="cmp-col">
              <div v-for="(t, i) in (detB ? detB.tools : [])" :key="i" class="tool-item cmp-tool">
                <div class="tool-head"><span class="tname">{{ t.name }}</span><span v-if="t.error" class="terr">✗ {{ t.error }}</span><span v-if="t.dur!=null" class="tdur">{{ fmtDur(t.dur) }}</span></div>
                <pre v-if="t.input" class="cmp-pre">{{ t._inPretty || prettyJson(t.input) }}</pre>
                <pre v-if="t.output" class="cmp-pre">{{ t._outPretty || prettyJson(t.output) }}</pre>
              </div>
              <span v-if="!detB || !detB.tools || !detB.tools.length" class="cmp-none">(没有工具调用)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <span class="cmp-foot">两条轮对比的是「同一件事这次为什么慢」—— 先看耗时条，再比对模型 / token / 工具链。</span>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
    </template>
  </el-dialog>`,
  props: {
    visible: Boolean,
    // 被对比的两条轮：{ a, b }，条目本体（快照 / 搜索命中集中的对象）。
    req: { type: Object, default: null },
  },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    const detA = Vue.ref(null), detB = Vue.ref(null);   // /api/entry 的详情（含正文 / 工具）
    const loading = Vue.ref(false), err = Vue.ref('');
    let loadedKey = '';   // 'a.id + "_" + b.id'：别拿旧条目的缓存去配新条目

    async function load() {
      const a = props.req && props.req.a, b = props.req && props.req.b;
      if (!a || !b) { detA.value = detB.value = null; return; }
      const key = a.id + '_' + b.id;
      loading.value = true; err.value = '';
      try {
        const [ja, jb] = await Promise.all([
          getJSON('/api/entry?id=' + encodeURIComponent(a.id)),
          getJSON('/api/entry?id=' + encodeURIComponent(b.id)),
        ]);
        if (key !== loadedKey) return;   // 打开期间换代了，丢弃旧响应
        detA.value = prepDetail(ja); detB.value = prepDetail(jb);
      } catch (e) {
        if (key === loadedKey) err.value = '读取详情失败：' + e.message;
      } finally { if (key === loadedKey) loading.value = false; }
    }
    // labels 复用 set 前后序：loadedKey 要跟当前对比对一致才复用 / 触发加载
    Vue.watch(() => props.req, r => {
      err.value = '';
      const k = (r && r.a && r.b) ? r.a.id + '_' + r.b.id : '';
      if (k === loadedKey) return;        // 同两条：已有的详情直接可看，不重拉
      loadedKey = k;
      detA.value = detB.value = null;
      if (k) load();
    });

    const reqA = Vue.computed(() => (props.req && props.req.a) || null);
    const reqB = Vue.computed(() => (props.req && props.req.b) || null);
    // 指标行：两侧同单位才作差、才标「谁大」；一侧没这个单位（qoder 无 token / 别家无积分）就给 '—'。
    const cmpRows = Vue.computed(() => {
      const a = reqA.value, b = reqB.value;
      if (!a || !b) return [];
      const DASH = '—';
      const qa = isQoder(a), qb = isQoder(b);
      const nOf = v => (typeof v === 'number' && isFinite(v) ? v : null);
      const rows = [];
      // ka/kb 是两格各自要挂的 title：'—' 有两种意思（这条根本没数据 / 这一行对它压根不适用），
      // 不分开写清就会让人以为「另一条没花 token」也是缺数据。
      const push = (label, ta, tb, na, nb, fmtDiff, ka, kb) => {
        let hot = '', big = '';
        if (na != null && nb != null && na !== nb) {
          big = na > nb ? 'a' : 'b';
          hot = '差 ' + (fmtDiff ? fmtDiff(Math.abs(na - nb)) : fmtN(Math.abs(na - nb)));
        }
        rows.push({ label, a: ta, b: tb, hot, big, at: ka || '', bt: kb || '' });
      };
      const NO_CREDIT = '这条不按积分计费（按 token），见下面 Token 行';
      const NO_TOKEN = 'qoder 不落盘 token（恒 0），它的花费在「积分」行';
      const NO_CTX = '日志没给这轮的占用与窗口容量';
      push('模型', modelText(a.models) || '(无模型信息)', modelText(b.models) || '(无模型信息)');
      push('LLM 调用', a.calls != null ? String(a.calls) : DASH, b.calls != null ? String(b.calls) : DASH, nOf(a.calls), nOf(b.calls));
      push('工具', a.tools != null ? String(a.tools) : DASH, b.tools != null ? String(b.tools) : DASH, nOf(a.tools), nOf(b.tools));
      // 积分：只要有一条是 qoder 就出这一行，非 qoder 那侧给 '—'（单位不同，不作差）
      if (qa || qb) {
        const cr = e => (isQoder(e) && e.credits != null ? fmtCredits(e.credits) : DASH);
        const crn = e => (isQoder(e) && e.credits != null ? nOf(e.credits) : null);
        push('积分', cr(a), cr(b), crn(a), crn(b), v => v.toFixed(2),
          isQoder(a) ? '' : NO_CREDIT, isQoder(b) ? '' : NO_CREDIT);
      }
      // Token 四行：qoder 那侧一律 '—' —— 它的 tin/tout/total 恒 0，印 0 会被读成「这轮没花钱」
      if (!qa || !qb) {
        const tk = (label, f) => push(label,
          isQoder(a) ? DASH : fmtN(f(a)), isQoder(b) ? DASH : fmtN(f(b)),
          isQoder(a) ? null : nOf(f(a)), isQoder(b) ? null : nOf(f(b)), null,
          isQoder(a) ? NO_TOKEN : '', isQoder(b) ? NO_TOKEN : '');
        tk('Token 输入', e => e.tin);
        tk('Token 输出', e => e.tout);
        tk('缓存命中', e => e.tcache);
        tk('Token 合计', sumTok);
      }
      // 上下文占用：qoder 只有占比（日志不落窗口容量），别家给「占用 / 容量（百分比）」；
      // 作差用的是同一把尺（0–1 占用率），所以两侧单位不同也能比。
      const ctxText = e => isQoder(e) ? (e.ctxRatio > 0 ? fmtPct(e.ctxRatio) : DASH)
        : (e.ctxUsed != null || e.ctx)
          ? fmtN(ctxUsed(e)) + (e.ctx ? ' / ' + fmtN(e.ctx) + '（' + ctxPct(e) + '%）' : '')
          : DASH;
      const ctxNum = e => isQoder(e) ? (e.ctxRatio > 0 ? Math.min(1, e.ctxRatio > 1 ? e.ctxRatio / 100 : e.ctxRatio) : null)
        : (e.ctx ? ctxPct(e) / 100 : null);
      push('上下文占用', ctxText(a), ctxText(b), ctxNum(a), ctxNum(b), v => Math.round(v * 100) + '%',
        ctxNum(a) == null ? NO_CTX : '', ctxNum(b) == null ? NO_CTX : '');
      if (a.compacts || b.compacts) {
        // I12：压缩对比也带上「自动/手动」「丢多少」「等多久」——两侧各自缺哪一位就不说哪一位。
        const cp = e => {
          if (!e.compacts) return DASH;
          let s = e.compacts + ' 次';
          if (e.compAuto || e.compManual) s += '（自动' + (e.compAuto || 0) + ' / 手动' + (e.compManual || 0) + '）';
          if (e.compPre) s += '（' + fmtN(e.compPre) + '→' + fmtN(e.compPost) + '）';
          if (e.compDrop) s += ' 丢 ' + fmtN(e.compDrop);
          if (e.compMs) s += ' 等 ' + fmtDur(e.compMs);
          return s;
        };
        push('压缩', cp(a), cp(b));
      }
      return rows;
    });
    // 耗时条：以两条里较大者为满刻度，谁慢谁就顶满
    const durMax = Vue.computed(() => Math.max((reqA.value && reqA.value.dur) || 0, (reqB.value && reqB.value.dur) || 0));
    const durPctOf = e => durMax.value ? Math.max(2, Math.round(((e && e.dur) || 0) / durMax.value * 100)) : 0;
    const durDiffOn = Vue.computed(() => durMax.value > 0 && reqA.value && reqB.value && reqA.value.dur !== reqB.value.dur);
    const cmpDurText = Vue.computed(() => {
      if (!durDiffOn.value) return '';
      const a = (reqA.value && reqA.value.dur) || 0, b = (reqB.value && reqB.value.dur) || 0;
      const abs = Math.abs(a - b);
      const fast = a < b ? 'A 快' : 'B 快';
      return fast + ' ' + fmtDur(abs);
    });
    const titleOf = e => {
      const mt = modelText(e && e.models);
      if (mt) return mt;
      if (e && e.name) return e.name;
      return '(无模型信息)';
    };
    return { reqA, reqB, detA, detB, loading, err, load, cmpRows,
      durPctOf, durDiffOn, cmpDurText, titleOf, fmtDur, fmtTime, prettyJson };
  }
};