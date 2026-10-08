// 侧栏（R25 批 2）：菜单（两个视图 + 活跃热力 / 历史归档 / 环境诊断 / 磁盘占用 / 解析器自检 / 上下文窗口六个弹层）
// + Agent 列表（Trae 解密三态 / Cursor token 采集 hook / 启停开关 / 移除）+ 非 LLM 轨迹勾选。
// 契约见 page/shared.js 头部的「R25 组件文件契约」；Vue 的 API 一律写全名，不解构。
//
// 数据进出（搬的时候逐个对过）：
//   · 纯展示 + 发命令：view / fAgent / agents / agentsMeta / sideAgents / showNoLLM 全是根的状态（筛选五元组
//     喂 snapUrl、深链在根），一份真相留根；连 isDisabled / isMissing / pathTip / isTraeKeyAgent 这几个判定
//     也留在根，因为它们闭包读 agentsMeta —— 搬过来就是第二份 agentsMeta。
//   · agentColor / agentIcon 是 page/shared.js 的顶层函数，本文件的 JS 作用域看得见，
//     但**模板**看不见页面脚本的顶层名，所以 setup 里 return 出去（与 dialog-stats -return-fmtN 同法）。
//   · 一处接线纠正（2026-09-21 批 2）：改前侧栏写的是 @command="traeCommandUI"，而 el-dropdown 的 @command
//     第二个实参是 EP 自己传进来的组件实例（实测 vendor bundle：commandHandler(command, instance, event)），
//     不是 v-for 的 agent 名 —— 于是 traeCommandUI 里的 `if (!name) return` 永不触发、traeBusy 被写成实例对象，
//     「这一行的按钮转圈 / 禁用」一直没生效。组件这边由 v-for 的 name 显式随命令传出，行为回到注释描述的三态。
window.AACTA = window.AACTA || {};
AACTA.Sidebar = {
  name: 'aa-sidebar',
  template: `
    <aside class="side">
      <div class="nav-label" style="padding-top:2px">菜单</div>
      <!-- R6：这里变成两个真实视图（'log' | 'sess'），所以第一项不再是硬编码的 active。
           「环境诊断」「上下文窗口」保持原样 —— 它们是弹层，不是视图。 -->
      <div class="nav-item" :class="{active: view==='log'}" @click="$emit('switch-view', 'log')">
        <el-icon><Document></Document></el-icon>请求日志
      </div>
      <div class="nav-item" :class="{active: view==='sess'}" @click="$emit('switch-view', 'sess')">
        <el-icon><Files></Files></el-icon>按会话浏览
      </div>
      <!-- R27：活跃热力图弹层（数据固定 range=all、不跟随筛选，与「环境诊断」一样是独立弹层） -->
      <div class="nav-item" @click="$emit('open-heatmap')">
        <el-icon><Calendar></Calendar></el-icon>活跃热力
      </div>
      <!-- R28：历史归档弹层（读 ~/.agent-acta/archive 下的冻结条目，只读旁路、不跟随筛选） -->
      <div class="nav-item" @click="$emit('open-archive')">
        <el-icon><Box></Box></el-icon>历史归档
      </div>
      <!-- R9：异常巡检弹层（规则配置 + 命中条目列表）。徽章 = 当前命中的异常条数；
           有命中时高亮（红色），无命中一个都不报警，规则没启用也自然为 0 -->
      <div class="nav-item" @click="$emit('open-alert')">
        <el-icon><Bell></Bell></el-icon>异常巡检
        <span v-if="alertCount" class="cnt alert-cnt" :title="alertCount + ' 条异常命中，点开可查看并定位'">{{ alertCount }}</span>
      </div>
      <div class="nav-item" @click="$emit('open-diag')">
        <el-icon><Monitor></Monitor></el-icon>环境诊断
      </div>
      <!-- R30：磁盘占用弹层（走一遍磁盘的只读统计，与筛选无关，所以也是独立弹层） -->
      <div class="nav-item" @click="$emit('open-usage')">
        <el-icon><Coin></Coin></el-icon>磁盘占用
      </div>
      <!-- R32：解析器自检弹层（只读展示上次回归结果；跑测试留在终端，见 page/dialog-selftest.js 头部） -->
      <div class="nav-item" @click="$emit('open-selftest')">
        <el-icon><Checked></Checked></el-icon>解析器自检
      </div>
      <div class="nav-item" @click="$emit('open-ctxw')">
        <el-icon><data-line></data-line></el-icon>上下文窗口
        <!-- 徽章 = 日志里出现过、这张表里却查不到窗口的模型数。没有它，「少了点什么」就只是个感觉：
             得点进去才知道是 2 个模型没填还是压根没有 claude 日志 -->
        <span v-if="ctxUnfilled" class="cnt ctxw-cnt" :title="ctxUnfilled + ' 个模型没有窗口值，这些卡片只显示占用、不画进度条'">{{ ctxUnfilled }}</span>
      </div>
      <div class="nav-label agent-label">Agent
        <el-icon class="add-btn" title="添加 agent" @click="$emit('open-add')"><Plus></Plus></el-icon>
      </div>
      <div class="nav-item" :class="{active: fAgent===''}" @click="$emit('pick-agent', '')">
        <span class="adot" style="background:#a8abb2"></span><span class="agent-name">全部</span><span class="cnt">{{ allCount }}</span>
      </div>
      <div v-for="name in sideAgents" :key="name" class="nav-item" :class="{active: fAgent===name, off: isDisabled(name) || isIconOnly(name)}" @click="$emit('pick-agent', name)" :title="pathTip(name)">
        <img v-if="agentIcon(name)" class="adot-img" :class="{dim: isIconOnly(name)}" :src="agentIcon(name)">
        <span v-else class="adot" :style="{background: agentColor(name)}"></span>
        <span class="agent-name">{{ name }}</span>
        <span v-if="isIconOnly(name)" class="icon-only-tag" title="该 agent 只有图标：暂无解析器，不会自动发现，点击无效。若已安装且想接入，请在 GitHub 提 issue 提供日志样本">仅图标</span>
        <el-icon v-if="isMissing(name)" class="mini-warn" title="日志目录不存在，条目来自内存或手动配置"><Warning></Warning></el-icon>
        <span class="cnt">{{ agents[name] || 0 }}</span>
        <!-- Trae 的解密按钮（三态）：无密钥→「抓取解密密钥」/ 有密钥但读不动→「重抓密钥」/ 正常→菜单（重新抓取/清除密钥） -->
        <el-dropdown v-if="isTraeKeyAgent(name)" trigger="click" placement="bottom-end" @command="cmd => $emit('trae-command', cmd, name)" :disabled="traeBusy===name" :hide-on-click="false">
          <el-icon class="dec-btn" :class="{busy: traeBusy===name}" title="解密 Trae 的 SQLCipher 库：没 key 就抓取、有 key 但读不动就重抓、都正常就显示菜单">
            <Key></Key>
          </el-icon>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="trae-retry" :disabled="traeBusy===name">重新抓取密钥</el-dropdown-item>
              <el-dropdown-item command="trae-clear" divided>清除密钥</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <!-- Cursor 的 token 采集 hook 按钮：Cursor 的转录/会话库都不含逐轮用量，只能靠它的 stop 钩子采
             （见 parsers/cursor.mjs 头部说明）。状态由服务端给（agentsMeta[name].hook），页面只读：
             高亮 = 已注入；高亮 + 转圈 = 正在注入/卸载；灰着 = 还没注入。点一下走根里的 toggleCursorHook。 -->
        <el-icon v-if="isCursorHookAgent(name)" class="hook-btn" :class="{on: cursorHookState(name).injected, busy: cursorHookBusy===name}"
          :title="cursorHookState(name).injected ? '已注入 token 采集 hook（每轮结束时采集用量）。点一下可卸载'
            : '注入 token 采集 hook：Cursor 转录里没有逐轮用量，装上后每轮结束时把 token 记到本地'"
          @click.stop="$emit('cursor-hook', name)">
          <MagicStick></MagicStick>
        </el-icon>
        <el-switch class="sw" :model-value="!isDisabled(name)" :disabled="toggleLoading===name"
          title="启用 / 禁用（禁用不移除配置，仅停止扫描并隐藏条目）" @click.stop @change="v => $emit('toggle-agent', name, v)"></el-switch>
        <el-icon v-if="agentsMeta[name]" class="del-btn" title="移除该 agent（只删配置，不动本地日志文件）" @click.stop="$emit('remove-agent', name)"><Close></Close></el-icon>
      </div>
      <div class="side-foot">
        <el-checkbox :model-value="noLlm" @update:model-value="v => $emit('update:no-llm', v)">显示非 LLM 轨迹</el-checkbox>
      </div>
    </aside>`,
  props: {
    view: { type: String, default: 'log' },
    ctxUnfilled: { type: Number, default: 0 },
    alertCount: { type: Number, default: 0 },
    fAgent: { type: String, default: '' },
    allCount: { type: Number, default: 0 },
    sideAgents: { type: Array, default: () => [] },
    agents: { type: Object, default: () => ({}) },
    agentsMeta: { type: Object, default: () => ({}) },
    noLlm: Boolean,
    traeBusy: { type: String, default: '' },
    toggleLoading: { type: String, default: '' },
    // 四个判定函数留在根（读根的 agentsMeta），连同按钮的三态状态一起递进来
    isDisabled: { type: Function, required: true },
    isIconOnly: { type: Function, required: true },
    isMissing: { type: Function, required: true },
    pathTip: { type: Function, required: true },
    isTraeKeyAgent: { type: Function, required: true },
    // Cursor token 采集 hook：判定与状态都是函数（闭包读根的 agentsMeta，搬过来就是第二份）
    cursorHookBusy: { type: String, default: '' },
    isCursorHookAgent: { type: Function, required: true },
    cursorHookState: { type: Function, required: true },
  },
  emits: ['switch-view', 'open-diag', 'open-usage', 'open-selftest', 'open-ctxw', 'open-heatmap', 'open-archive', 'open-alert', 'open-add', 'pick-agent', 'trae-command', 'cursor-hook', 'toggle-agent', 'remove-agent', 'update:no-llm'],
  setup() {
    return { agentColor, agentIcon };
  }
};
