// AgentActa 的 DSH 客户端垫片（I11 批 3）。手写纯 ESM-free 的 .js：宿主把插件 client 原样拼成普通 <script>，
// react 由浏览器的模块表提供，所以这里没有 JSX、也没有构建步骤（实测见 DSH-PLUGIN-PLAN.md §8.4/§8.6）。
// __ModuleLoader__.load 的 id 必须等于包名，且同一个 id 只能注册一次（重复注册宿主会抛）。
window.__ModuleLoader__.load({
  id: '@yxzpro/agent-acta',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'agent-acta';
    // 面板入口：由服务端**同源递出**面板 HTML（宿主前端在 dsh-app://app，只代理 /api/*，
    // 而 iframe 302 到 http 口是跨源、实测被拦成空白 —— 见 DSH-PLUGIN-PLAN.md §8.6 第七轮）。
    // 页面里的 /page/、/vendor/ 引用由服务端递送时翻译成 /api/agent-acta/asset?p=…，浏览器侧一行都不用改。
    const PAGE_URL = '/api/agent-acta/entry';

    // 没有 icon 这个注册参数 —— 注册的组件本身就是侧栏那颗图标，宿主按 { size, active } 喂它。
    function PanelIcon({ size, active }) {
      const s = size || 18;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.6 },
      },
        h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M7.5 13.5h2.2l1.4-4 1.9 6.4 1.4-2.4h2.1', fill: 'none', stroke: active ? 'currentColor' : 'currentColor', strokeWidth: 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }

    function Panel() {
      return h('iframe', {
        // 面板 HTML 必须从 /api 递出：宿主前端在 dsh-app://app 下只把 /api/* 代理到 webServer，
        // 走 /page/ 之类路径会被当成宿主自己的静态资源（§8.6 实测）。同源之后 SSE 也照用。
        title: 'AgentActa',
        src: PAGE_URL,
        style: { width: '100%', height: '100%', border: 0, display: 'block' },
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 任一步失败都只降级成 console.error：slot API 变了不该把宿主一起拖崩。
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 900, label: 'AgentActa' }, PanelIcon));
        } catch (e) { console.error('[agent-acta] 侧栏入口注册失败：', e && e.message); }
        try {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
        } catch (e) { console.error('[agent-acta] 面板注册失败：', e && e.message); }
      },
    };
  },
});
