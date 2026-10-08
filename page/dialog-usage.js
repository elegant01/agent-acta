// 磁盘占用弹层（R30 / 候选池 I3）：一眼看清「哪个 agent 的日志最占地方、清理时该动谁」。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 数据进出（与 dialog-diag / dialog-archive 同法：开关归根、数据归组件）：
//   · visible ← 根（侧栏「磁盘占用」项点开 / 弹层关掉时回写）
//   · getJSON ← 根 provide（接口 404 要点亮顶部版本红条，那段逻辑只有根里一份）
//   · 自己拉 /api/usage（服务端一次遍历三处：源日志目录 / index 分片 / archive 清单）
//
// 四处口径要留意（都是服务端刻意这么定的，页面只是别把它藏起来）：
//   · 索引**单列**、不并进 agent 行：一个 kind 的分片可能同时供好几个 agent，相加就是重复计数。
//   · partial（统计到一半）必须显式说明：遍历带预算，宁可报「这是部分」也不给假的完整数字。
//   · 归档条数 -1 = manifest 没记（手工拷进来的日期文件），显示成 ?，不是 0。
//   · 两个 agent 指同一份目录时：行内各报各的，**合计去重**（totals.logBytes 与 logBytesRows 不等即为共用）。
window.AACTA = window.AACTA || {};
AACTA.DialogUsage = {
  name: 'aa-dialog-usage',
  template: `
  <el-dialog :model-value="visible" @update:model-value="v => $emit('update:visible', v)" title="磁盘占用" width="min(1000px, 95vw)" append-to-body class="us-dialog">
    <div class="us-hint">
      下面按 agent 列出<b>本机磁盘上真实占了多少</b>：日志 = 它自己的日志目录（库类连 -wal/-shm 一起算），
      归档 = <code>~/.agent-acta/archive</code> 里冻结的历史。这一页<b>只统计、不删除</b>，
      要清理请照着自己判断的路径动手（先看一眼 <code>agentacta --doctor</code> 更稳）。
    </div>
    <el-skeleton v-if="us.loading && !us.rows.length" :rows="6" animated></el-skeleton>
    <div v-else-if="us.error" class="us-err">
      <div class="us-errmsg">{{ us.error }}</div>
      <el-button size="small" :loading="us.loading" @click="run(true)">重试</el-button>
    </div>
    <div v-else>
      <div class="us-sum">
        <span>日志 <b>{{ b(us.totals.logBytes) }}</b><template v-if="us.totals.logBytesRows !== us.totals.logBytes">（已去重共用目录）</template></span><i>·</i>
        <span>归档 <b>{{ b(us.archive.bytes) }}</b></span><i>·</i>
        <span>索引 <b>{{ b(us.totals.indexBytes) }}</b></span><i>·</i>
        <span>数据目录 <b>{{ b(us.totals.dataBytes) }}</b></span>
        <div class="us-sum-2">
          {{ us.totals.agents }} 个 agent · {{ fmtN(us.totals.logFiles) }} 个日志文件 ·
          归档 {{ us.archive.agents }} 个 agent / {{ us.archive.days }} 个日期文件 ·
          统计于 {{ us.at ? fmtTime(us.at) : '—' }}<template v-if="us.cached">（用的一分钟内的结果）</template>
        </div>
      </div>
      <!-- 超预算：数字是「已统计的部分」。不写这一行的话，一个偏小的总数会被当成事实。 -->
      <div v-if="us.partial" class="us-warn">
        本次遍历到达上限（最多 {{ fmtN(us.budget.maxFiles) }} 个目录项 / {{ us.budget.maxMs }}ms），
        下面的数字是<b>已统计的部分</b>，比磁盘上真实的要小。
      </div>

      <div class="us-cap">按 agent</div>
      <div class="us-head">
        <span class="us-c nm" @click="sortBy('agent')" :class="{on: key==='agent'}">Agent <i>{{ arrow('agent') }}</i></span>
        <span class="us-c num" @click="sortBy('logBytes')" :class="{on: key==='logBytes'}">日志 <i>{{ arrow('logBytes') }}</i></span>
        <span class="us-c num" @click="sortBy('archiveBytes')" :class="{on: key==='archiveBytes'}">归档 <i>{{ arrow('archiveBytes') }}</i></span>
        <span class="us-c num" @click="sortBy('entries')" :class="{on: key==='entries'}">内存条目 <i>{{ arrow('entries') }}</i></span>
        <span class="us-c num" @click="sortBy('totalBytes')" :class="{on: key==='totalBytes'}">合计 <i>{{ arrow('totalBytes') }}</i></span>
      </div>
      <div class="us-list">
        <div v-for="r in sortedRows" :key="r.agent" class="us-row" :class="{off: !r.enabled}">
          <span class="us-c nm">
            <img v-if="agentIcon(r.agent)" class="us-ico" :src="agentIcon(r.agent)">
            <span v-else class="us-dot" :style="{background: agentColor(r.agent)}"></span>
            <span class="us-nm">{{ r.agent }}</span>
            <span class="us-kind">{{ r.kind }}</span>
            <span v-if="!r.enabled" class="us-tag" title="已禁用：不再扫描，但磁盘上的日志仍然占着地方">已禁用</span>
            <span v-if="r.sharedBy" class="us-tag" :title="'与 ' + r.sharedBy + ' 指向同一份目录：两边各报各的大小，合计只算一次'">共用目录</span>
            <span v-if="r.partial" class="us-tag part" title="这个 agent 的目录太大，统计被预算截断">统计到一半</span>
          </span>
          <span class="us-c num" :title="r.roots.join('\\n')">
            {{ b(r.logBytes) }}<i class="us-sub">{{ fmtN(r.logFiles) }} 文件</i>
          </span>
          <span class="us-c num">
            {{ r.archiveBytes ? b(r.archiveBytes) : '—' }}
            <i v-if="r.archiveDays" class="us-sub">{{ r.archiveDays }} 天 / {{ r.archiveCount < 0 ? '?' : fmtN(r.archiveCount) }} 条</i>
          </span>
          <span class="us-c num">{{ r.entries ? fmtN(r.entries) : '—' }}</span>
          <span class="us-c num tot">
            {{ b(r.totalBytes) }}
            <!-- 条长 = 占最大那一行的比例（不是占总量的比例）：这一列要比的是「谁比谁大多少」 -->
            <span class="us-bar" :style="{width: barPct(r.totalBytes) + '%'}"></span>
          </span>
        </div>
        <div v-if="!us.rows.length" class="us-none">还没有配置任何 agent。</div>
      </div>

      <div class="us-cap">索引分片 <span class="us-cap-note">~/.agent-acta/index —— 一片可能同时供多个 agent，所以不并进上面的行</span></div>
      <div class="us-shards">
        <span v-for="s in us.indexShards" :key="s.kind" class="us-shard"
          :class="{orphan: !s.persisted}" :title="s.persisted ? '解析器口径 rev ' + s.rev : '这个 kind 已不再落盘（孤儿片，可手工删）'">
          {{ s.kind }} <b>{{ b(s.bytes) }}</b><i v-if="!s.persisted">孤儿</i>
        </span>
        <span v-if="!us.indexShards.length" class="us-none">没有索引文件。</span>
      </div>

      <div class="us-cap">数据目录构成 <span class="us-cap-note">{{ us.dataDir }}</span></div>
      <div class="us-shards">
        <span v-for="d in us.dataItems" :key="d.name" class="us-shard" :class="{orphan: d.link}"
          :title="d.link ? '链接项：不跟随、不计大小（跟过去要么重复计数、要么转圈）' : (d.dir ? '目录：' + fmtN(d.files) + ' 个文件' : '文件')">
          {{ d.name }} <b>{{ d.link ? '—' : b(d.bytes) }}</b><i v-if="d.partial">到一半</i><i v-if="d.link">链接</i>
        </span>
      </div>
    </div>
    <template #footer>
      <span class="us-foot">「内存条目」是服务当前留着的条数（有上限，重启后会重新扫回来），与磁盘占用无关。
        这一页只读：删任何东西都要你自己动手 —— 日志删了历史就没了（想留先开归档），索引片删了下次启动会重扫一遍。</span>
      <el-button @click="$emit('update:visible', false)">关闭</el-button>
      <el-button :loading="us.loading" @click="run(false)">刷新（用缓存）</el-button>
      <el-button type="primary" :loading="us.loading" @click="run(true)">重新统计</el-button>
    </template>
  </el-dialog>`,
  props: { visible: Boolean },
  emits: ['update:visible'],
  setup(props) {
    const getJSON = Vue.inject('getJSON');
    const us = Vue.reactive({
      loading: false, error: '', at: 0, cached: false, partial: false, dataDir: '',
      rows: [], indexShards: [], dataItems: [],
      archive: { agents: 0, days: 0, count: 0, bytes: 0 },
      totals: { logBytes: 0, archiveBytes: 0, indexBytes: 0, dataBytes: 0, agents: 0, logFiles: 0 },
      budget: { maxFiles: 0, maxMs: 0, visited: 0 },
    });
    async function run(force) {
      if (us.loading) return;
      us.loading = true;
      try {
        const j = await getJSON('/api/usage' + (force ? '?force=1' : ''));
        if (!j.ok) throw new Error(j.error || '统计失败');
        us.at = j.at; us.cached = !!j.cached; us.partial = !!j.partial;
        us.rows = j.agents || []; us.indexShards = j.indexShards || []; us.dataItems = j.dataItems || [];
        us.archive = j.archive || us.archive; us.totals = j.totals || us.totals; us.budget = j.budget || us.budget;
        us.dataDir = j.dataDir || '';
        us.error = '';
      } catch (e) { us.error = '磁盘占用统计失败：' + e.message; }
      finally { us.loading = false; }
    }
    // 点开才统计（与「环境诊断」一样是独立弹层，不跟随左侧筛选）
    Vue.watch(() => props.visible, v => { if (v) run(false); });

    // 列头排序：同一个键再点一次翻转方向；默认就是服务端给的「合计从大到小」。
    // 数字列首点从大到小（这一列就是用来找最大的），agent 名首点正序（找名字没人想倒着找）。
    const key = Vue.ref('totalBytes'), desc = Vue.ref(true);
    function sortBy(k) { if (key.value === k) desc.value = !desc.value; else { key.value = k; desc.value = k !== 'agent'; } }
    const arrow = k => key.value === k ? (desc.value ? '▾' : '▴') : '';
    const sortedRows = Vue.computed(() => {
      const k = key.value, s = desc.value ? -1 : 1;
      return us.rows.slice().sort((a, b) => (k === 'agent'
        ? String(a.agent).localeCompare(String(b.agent)) * s
        : (a[k] - b[k]) * s));
    });
    const maxTotal = Vue.computed(() => us.rows.reduce((m, r) => Math.max(m, r.totalBytes), 0));
    const barPct = v => maxTotal.value ? Math.max(1, Math.round(v / maxTotal.value * 100)) : 0;
    const b = n => {
      const v = Number(n) || 0;
      if (v < 1024) return v + 'B';
      if (v < 1048576) return (v / 1024).toFixed(1) + 'KB';
      if (v < 1073741824) return (v / 1048576).toFixed(1) + 'MB';
      return (v / 1073741824).toFixed(2) + 'GB';
    };
    return { us, run, key, sortBy, arrow, sortedRows, barPct, b, fmtN, fmtTime, agentColor, agentIcon };
  }
};
