// R27 活跃热力图弹层：全年活跃热力（GitHub contributions 风格）+ 当月月历热力。
// 契约见 page/shared.js 头部「R25 组件文件契约」；Vue / Element Plus 的 API 写全名。
//
// 数据进出：
//   · visible ← 根（侧栏「活跃热力」项 / 弹层自己关闭时回写）
//   · getJSON ← 根 provide
//   · 天桶 ← /api/daily?range=all（不带任何筛选）——口径是需求书 R27 定死的：
//     **任一 agent 当天有日志记录即算活跃**，颜色深浅按当天记录条数分五档。
//     所以这张图**刻意不跟随**左侧栏的 agent/项目/时间范围筛选：它回答的是「这一年我出没出现过」，
//     跟「用量统计」那种「筛出来的这一段烧了多少 token」是两个问题，别接 req。
//   · 聚合全在前端做（天桶只有 day+count 两个字段要，服务端不新开端点）。
//
// 分档：取当年全部活跃日的条数，按**去重后的值**均匀映射到 1..5 档（不是按最大值线性切——
// 一个爆量的日子会把其余全压成最浅档）。档位在全年与月历之间共用，两块的深浅才可比。
// 周连登：从当周（周日为首，与月历同口径）往前回溯连续活跃周数，需求书 R27 定义。
//
// 悬浮提示（2026-09-22 按用户补发的 Qoder 新任务面板截图对齐「内容系统」）：
// 第一行「M月D日周X」+ 右对齐「N 个任务」，第二行灰字「单日活跃任务」。
// 原生 title 排不出这个两行版式，所以是一块全局单例的自绘提示（事件委托在两块网格上，
// 不给 400 个格子各挂监听）。无记录/未到/非本月三种日子给各自的第二行文案，不冒充「0 个任务」。
window.AACTA = window.AACTA || {};
AACTA.DialogHeatmap = {
  name: 'aa-dialog-heatmap',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="活跃热力图" width="min(1080px, 94vw)" append-to-body class="hm-dialog">
    <el-skeleton v-if="hm.loading && !hm.days.length" :rows="8" animated></el-skeleton>
    <el-alert v-else-if="hm.error" :title="hm.error" type="error" :closable="false" show-icon></el-alert>
    <div v-else-if="!hm.days.length" class="empty">暂无日志数据</div>
    <template v-else>
      <div class="hm-sec">
        <div class="hm-head">
          <span class="hm-h1">全年活跃记录</span>
          <span class="hm-stat"><b>{{ hmActive }}</b> 天活跃 · <b class="rate">{{ hmRate }}%</b> 活跃率 · <b>{{ hmStreak }}</b> 周连登</span>
          <span class="hm-legend">未活跃<i v-for="lv in hmLvs" :key="lv" class="hm-chip" :class="'lv' + lv"></i>活跃</span>
        </div>
        <div class="hm-year" @mouseover="onHover" @mouseleave="hideTip">
          <div v-for="mo in yearMonths" :key="mo.label" class="hm-month">
            <div class="hm-m-label">{{ mo.label }}</div>
            <div class="hm-grid">
              <template v-for="c in mo.cells" :key="c.k">
                <i v-if="c.pad" class="hm-cell hm-pad"></i>
                <i v-else class="hm-cell" :class="['lv' + c.lv, {fut: c.future}]" :data-d="c.k" :data-n="c.n" :data-f="c.future ? '1' : ''"></i>
              </template>
            </div>
          </div>
        </div>
        <div class="hm-foot">{{ hmFoot }}</div>
      </div>
      <div class="hm-sec">
        <div class="hm-head">
          <span class="hm-h1">{{ monthTitle }}</span>
          <span class="hm-stat"><b>{{ monthActive }}</b> 天活跃 · 色阶与上方全年热力同一档位</span>
        </div>
        <div class="hm-cal" @mouseover="onHover" @mouseleave="hideTip">
          <span v-for="w in weekLabels" :key="w" class="hm-wd">{{ w }}</span>
          <div v-for="c in monthCal" :key="c.k" class="hm-day" :class="['lv' + c.lv, {out: c.out, today: c.today}]" :data-d="c.k" :data-n="c.n" :data-out="c.out ? '1' : ''">{{ c.today ? '今日' : c.d }}</div>
        </div>
      </div>
      <!-- 全局单例悬浮提示：position:fixed 按格子 rect 落位（见文件头注释） -->
      <div v-if="tip.show" class="hm-tip" :class="{below: tip.below}" :style="{left:tip.x+'px', top:tip.y+'px'}">
        <div class="hm-tip-1"><b>{{ tip.date }}</b><span v-if="!tip.fut && !tip.out">{{ tip.n }} 个任务</span></div>
        <div class="hm-tip-2">{{ tip.sub }}</div>
      </div>
    </template>
    <template #footer>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button type="primary" :loading="hm.loading" @click="load">刷新</el-button>
    </template>
  </el-dialog>`,
  props: { visible: Boolean },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    const hm = Vue.reactive({ loading: false, error: '', days: [] });
    // 打开时重新取数、也重新认「今天」（挂着的服务跨了午夜再开弹层，今日格不能留在昨天）
    const now = Vue.ref(new Date());

    async function load() {
      if (hm.loading) return;
      hm.loading = true;
      hm.error = '';
      now.value = new Date();
      try {
        const j = await getJSON('/api/daily?range=all');
        if (!j.ok) throw new Error(j.error || '聚合失败');
        hm.days = j.days || [];
      } catch (e) { hm.error = '活跃热力图加载失败：' + e.message; }
      finally { hm.loading = false; }
    }
    Vue.watch(() => props.visible, v => { if (v) load(); });

    const pad2 = n => (n < 10 ? '0' : '') + n;
    const dk = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const todayKey = Vue.computed(() => dk(now.value));
    const year = Vue.computed(() => now.value.getFullYear());
    // 只收有记录的天：热力图只问「有没有、多少条」，token/耗时一概不用
    const cnt = Vue.computed(() => {
      const m = new Map();
      for (const d of hm.days) if (d.count) m.set(d.day, d.count);
      return m;
    });
    // 五档：当年活跃日条数去重后均匀铺到 1..5（见文件头注释）。只有一个档位时给中间档，
    // 不至于「全年就一天有记录」反而画成最深绿。
    const levelMap = Vue.computed(() => {
      const ys = String(year.value);
      const uniq = [...new Set([...cnt.value].filter(([k]) => k.slice(0, 4) === ys).map(([, n]) => n))].sort((a, b) => a - b);
      const m = new Map();
      uniq.forEach((v, i) => m.set(v, uniq.length === 1 ? 3 : 1 + Math.round(i / (uniq.length - 1) * 4)));
      return m;
    });
    const lvOf = (n) => !n ? 0 : (levelMap.value.get(n) || 1);

    // ---- 悬浮提示（内容系统对齐 Qoder 新任务面板，见文件头）----
    const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const tip = Vue.reactive({ show: false, below: false, x: 0, y: 0, date: '', n: 0, fut: false, out: false, sub: '' });
    // 事件委托：监听挂在两块网格容器上，格子只带 data-*
    function onHover(ev) {
      const el = ev.target && ev.target.closest ? ev.target.closest('.hm-cell, .hm-day') : null;
      const d = el && el.dataset.d;
      if (!d) { tip.show = false; return; }
      const n = +el.dataset.n || 0;
      const dt = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
      tip.date = (dt.getMonth() + 1) + '月' + dt.getDate() + '日' + WD[dt.getDay()];
      tip.n = n;
      tip.fut = el.dataset.f === '1';
      tip.out = el.dataset.out === '1';
      tip.sub = tip.fut ? '未到' : tip.out ? '非本月' : n ? '单日活跃任务' : '无活跃记录';
      const r = el.getBoundingClientRect();
      tip.below = r.top < 76;                       // 第一行格子的提示放不下头顶，翻到下方
      tip.x = Math.round(r.left + r.width / 2);
      tip.y = Math.round(tip.below ? r.bottom + 8 : r.top - 8);
      tip.show = true;
    }
    function hideTip() { tip.show = false; }

    const yearMonths = Vue.computed(() => {
      const Y = year.value, tk = todayKey.value, out = [];
      for (let m = 0; m < 12; m++) {
        const off = new Date(Y, m, 1).getDay();          // 周日为首（与月历同一口径）
        const dim = new Date(Y, m + 1, 0).getDate();
        const cells = [];
        for (let i = 0; i < off; i++) cells.push({ pad: true, k: Y + '-' + m + '-p' + i });
        for (let d = 1; d <= dim; d++) {
          const key = Y + '-' + pad2(m + 1) + '-' + pad2(d);
          const n = cnt.value.get(key) || 0;
          cells.push({ pad: false, k: key, n, lv: lvOf(n), future: key > tk });
        }
        out.push({ label: (m + 1) + '月', cells });
      }
      return out;
    });
    // 活跃率 = 活跃天数 / 当年已过天数（需求书 R27 口径；1 月 1 日当天算已过 1 天）
    const hmActive = Vue.computed(() => {
      const ys = String(year.value);
      let n = 0;
      for (const [k] of cnt.value) if (k.slice(0, 4) === ys) n++;
      return n;
    });
    const hmRate = Vue.computed(() => {
      const elapsed = Math.floor((now.value - new Date(year.value, 0, 1)) / 86400000) + 1;
      return elapsed > 0 ? Math.round(hmActive.value / elapsed * 100) : 0;
    });
    const hmStreak = Vue.computed(() => {
      const cur = new Date(now.value);
      cur.setHours(0, 0, 0, 0);
      cur.setDate(cur.getDate() - cur.getDay());         // 本周日
      let s = 0;
      for (let g = 0; g < 110; g++) {                     // 上限只是防病态回溯（数据最老也就 400 天）
        let hit = false;
        for (let i = 0; i < 7 && !hit; i++) {
          const d = new Date(cur);
          d.setDate(d.getDate() + i);
          if (cnt.value.has(dk(d))) hit = true;
        }
        if (!hit) break;
        s++;
        cur.setDate(cur.getDate() - 7);
      }
      return s;
    });

    const monthTitle = Vue.computed(() => year.value + '年' + (now.value.getMonth() + 1) + '月');
    const monthActive = Vue.computed(() => {
      const p = year.value + '-' + pad2(now.value.getMonth() + 1);
      let n = 0;
      for (const [k] of cnt.value) if (k.slice(0, 7) === p) n++;
      return n;
    });
    const monthCal = Vue.computed(() => {
      const Y = year.value, M = now.value.getMonth(), tk = todayKey.value;
      const off = new Date(Y, M, 1).getDay();
      const dim = new Date(Y, M + 1, 0).getDate();
      const cells = [];
      for (let i = 0; i < Math.ceil((off + dim) / 7) * 7; i++) {
        const dt = new Date(Y, M, 1 - off + i);
        const key = dk(dt);
        const inM = dt.getMonth() === M;
        const n = inM ? (cnt.value.get(key) || 0) : 0;
        cells.push({
          k: key, d: dt.getDate(), n, out: !inM, today: key === tk, lv: lvOf(n),
        });
      }
      return cells;
    });

    const hmLvs = [0, 1, 2, 3, 4, 5];
    const weekLabels = ['日', '一', '二', '三', '四', '五', '六'];
    // 参考截图底部那行写的是「数据更新于每日 02:00」——本服务没有每日定点任务，
    // 数据随扫描实时进桶，照抄那句就是假话，改成如实的口径说明。
    const hmFoot = '活跃口径：任一 agent 当天有日志记录即算活跃 · 色阶 = 当天条数按全年活跃日分五档 · 数据随日志扫描实时更新';

    // 模板只认 props ∪ setup return（page-check.mjs 盯住），用到的名字必须全列出来
    return { hm, load, yearMonths, monthCal, hmLvs, weekLabels, hmActive, hmRate, hmStreak, monthTitle, monthActive, hmFoot, tip, onHover, hideTip };
  }
};
