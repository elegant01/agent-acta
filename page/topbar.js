// 顶栏（R25 批 2 从 agent-acta-page.html 搬出的第一个组件）。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 数据进出（搬的时候逐个对过）：
//   · 这里只是**显示 + 发命令**：liveText / idleText / scanning / scanMs / idleExitMs 全是根的 SSE
//     与 /api/settings 回写出来的状态（改前就在根里，改后还在根里）—— 组件不持有其中任何一个，
//     否则一份真相变两份，多标签页对齐（settings 事件）就会写不到真正驱动连接的那份上。
//   · 三个命令走 emit：set-scan / set-idle 都是 POST /api/settings + ElMessage，launch-client 是 POST /api/client，
//     这些都要用根的 getJSON（404 点亮版本红条那段逻辑只有一份），所以处理函数留在根。
//   · 品牌区（logo + AgentActa）纯静态，跟着搬家。
window.AACTA = window.AACTA || {};
AACTA.Topbar = {
  name: 'aa-topbar',
  template: `
  <header class="topbar">
    <div class="brand"><span class="logo">A</span>AgentActa</div>
    <div class="top-right">
      <!-- 唤出桌面悬浮卡片：卡片被 ✕ 关掉后壳可能还活着（被面板窗吊着），命令行之外给页面一个入口。
           服务端 POST /api/client → runClient()（幂等）：壳在就聚焦/重建卡片，不在就拉起新壳。 -->
      <el-button size="small" plain :loading="clientLaunching" title="打开桌面悬浮卡片（右上角常驻的小窗/水球）" @click="$emit('launch-client')">悬浮卡片</el-button>
      <el-dropdown trigger="click" placement="bottom-end" @command="v => $emit('set-idle', v)">
        <span class="live-tag idle" :class="{idleOn: idleExitMs > 0}" :title="'页面全关且没有新日志持续这么久后，服务自己退出（下次开会话会被 hook 自动拉起）。当前：' + idleText">
          <span class="dot"></span>{{ idleText }}<el-icon class="caret"><arrow-down></arrow-down></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="o in idleOptions" :key="o.v" :command="o.v" :class="{picked: idleExitMs === o.v}">{{ o.label }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown trigger="click" placement="bottom-end" @command="v => $emit('set-scan', v)">
        <span class="live-tag" :class="{on: live && !paused && !scanning, scan: live && scanning, paused: live && paused && !scanning}"
          :title="scanning ? '正在扫描各 agent 的日志目录，扫完自动进入实时更新' : (paused ? '已暂停定时扫描，点此选择刷新频率' : '点此调整刷新频率')">
          <span class="dot"></span>{{ liveText }}<el-icon class="caret"><arrow-down></arrow-down></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="o in scanOptions" :key="o.v" :command="o.v" :class="{picked: scanMs === o.v}">{{ o.label }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>`,
  props: {
    clientLaunching: Boolean,
    live: Boolean,
    paused: Boolean,
    // null = 没在扫；{ done, total, agent } = 正在扫。模板只读它做 class 与 title，不写
    scanning: { type: Object, default: null },
    scanMs: { type: Number, default: 0 },
    scanOptions: { type: Array, default: () => [] },
    liveText: { type: String, default: '' },
    idleExitMs: { type: Number, default: 0 },
    idleOptions: { type: Array, default: () => [] },
    idleText: { type: String, default: '' },
  },
  emits: ['launch-client', 'set-idle', 'set-scan'],
  setup() {
    return {};
  }
};
