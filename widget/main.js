// AgentActa 悬浮卡片壳：一个无边框、透明、置顶的窗口，里面加载 agent-acta 服务的 /widget?float=1。
// 壳只管窗口形态（悬浮层皮），数据与页面逻辑全在服务端 agent-acta-widget.html —— 升级页面不用动壳。
// 由 `agentacta --client` 拉起（Electron 运行时首次使用时下载到 数据目录/widget-runtime/，不进包）。
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.AGENT_LOG_PORT || 14570);
const URL_WIDGET = `http://127.0.0.1:${PORT}/widget?float=1`;
const URL_PANEL = `http://127.0.0.1:${PORT}/`;

// 状态落在数据目录而不是包目录：全局安装的包目录不该被运行时写（只读部署/权限都说得通），
// 且升级包时状态天然留住。写坏了删掉这个文件，壳用默认值重来。
const DATA_DIR = process.env.AGENT_ACTA_DATA_DIR || path.join(os.homedir(), '.agent-acta');
const STATE_FILE = path.join(DATA_DIR, 'widget-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
const state = loadState();

// 单实例：重复 `agentacta --client` / 面板「悬浮卡片」按钮 = 聚焦已有窗口，不开第二个。
// 卡片关掉（✕）只是 hide：壳还在，这里把它 show 回来即可，不重建 —— 用户模型里卡片就是这个进程的
// 常驻形态，只有 --stop 才让壳退出（2026-09-21）。窗口真销毁过（历史路径）才走 create 兜底。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => {
  if (!win || win.isDestroyed()) { create(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); }
});

let win = null;
// 水球模式的窗口尺寸 = 页面 CSS 的 --bs（球本体直径，现 88px）+ 24（四周各 12px 透明边给 CSS 圆形阴影落脚）。
// ⚠️ 两处必须一起改：只改页面的 --bs，窗口还是这个数，多出来的一圈透明区照样吞鼠标点击（透明区不穿透），
//    球看着偏在窗口中间、四周点不动。改这里要 npm pack + 全局重装才生效（跑的是全局那份拷贝，不是源码目录）。
const BALL_SIZE = 112;

// 把记住的位置夹回「现在还连着的屏」里。原来 create() 直接用 state.bounds 的 x/y、不夹 ——
// 拔一块屏或改过排列之后，窗口会开在谁都看不见的坐标上，而唯一的「✕」就在那个窗口里，等于自锁
// （本机实测：卡片位记成 x=-918，那是左边那块屏）。
// 两道判断：先按所有工作区的**并集外接矩形**夹一遍，再验「中心是否真落在某块屏上」—— 两屏高度不等时
// 并集的外接矩形会包含两屏之间那段空隙，只夹边界能夹出「在并集内、却不在任何屏上」的坐标。
function placeWithin(x, y, w, h) {
  const areas = screen.getAllDisplays().map(d => d.workArea);
  if (!areas.length) return { x, y };
  const l = Math.min(...areas.map(a => a.x)), t = Math.min(...areas.map(a => a.y));
  const r = Math.max(...areas.map(a => a.x + a.width)), bo = Math.max(...areas.map(a => a.y + a.height));
  let nx = Math.max(l, Math.min(x, r - w)), ny = Math.max(t, Math.min(y, bo - h));
  const cx = nx + w / 2, cy = ny + h / 2;
  const onSome = areas.some(a => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
  if (!onSome) {   // 落进空隙（或窗口比任何一块屏都大）→ 退回主屏右下角，也就是本来的开机位
    const p = screen.getPrimaryDisplay().workArea;
    nx = p.x + p.width - w - 24; ny = p.y + p.height - h - 24;
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}

function create() {
  const wa = screen.getPrimaryDisplay().workArea; // 避开任务栏
  const b = state.bounds;
  // 开机固定 324×404：对齐预览卡 300×380（窗口 = 内容 + 四周各 12px 透明留白），落主屏右下角。
  // 尺寸不读存档（用户要求：运行中可以拖拉，重启一律回到这个宽高），只记住位置。
  const defW = 324, defH = 404;
  const cw = defW, ch = defH;
  // 开机**一律开卡片**（2026-09-24 用户点名：`--client` 要打开的是悬浮卡片，不是水球）——
  // 上次会话里随手点的那个 ○ 不该决定这次起来是什么形态。会话内的收放照旧（float-mode 那条 ipc）。
  const pos = (b && b.x != null && b.y != null)
    ? placeWithin(b.x, b.y, cw, ch)
    : { x: wa.x + wa.width - cw - 24, y: wa.y + wa.height - ch - 24 };
  win = new BrowserWindow({
    width: cw, height: ch,
    x: pos.x, y: pos.y,
    minWidth: 230, minHeight: 160, maxWidth: 640, maxHeight: 1200,
    frame: false,             // 无边框：标题栏消失，拖动由页面 header 的 app-region 负责
    transparent: true,        // 透明背景：圆角与阴影由页面 CSS 画
    hasShadow: false,         // ⚠️ 必须显式关：Win10 的 DWM 给透明窗画阴影按**窗口矩形**画，
                              //    水球底下会冒出一个正方形影子（2026-09-20 实测）——阴影让 CSS 自己画
    resizable: true, minimizable: false,  // 透明无边框窗没有系统拉边框，缩放走页面右下角的拖拽柄（float-resize）。
                                          // 「缩小」= 收成水球（页面的 ○ 按钮），不做真最小化：
                                          // skipTaskbar 的窗口最小化后没有入口能叫回来（本机踩过，2026-09-20）
    alwaysOnTop: true,        // 悬浮窗的本体
    skipTaskbar: true,        // 不占任务栏（托盘也不做 —— 关掉就是关掉）
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // 层级拉高一点，压过普通置顶窗口
  win.loadURL(URL_WIDGET);   // 不带 &mode=ball：开机形态恒为卡片（球只是会话内的收放）
  if (state.zoom) win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(state.zoom));

  win.on('close', () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        bounds: win.getBounds(), zoom: win.webContents.getZoomFactor() || 1,
        cardBounds: state.cardBounds || null,
      }, null, 1));
    } catch { /* 落盘失败下次用默认，不挡关窗 */ }
  });
}

// 卡片 ⇄ 水球：窗口尺寸切换由壳做（页面拿不到窗口），位置锚定右下角 —— 用户把它摆在角落，
// 收放不该让角跑掉。卡片尺寸在切走前记住，切回来时还原。
ipcMain.on('float-mode', (e, mode) => {
  if (!win) return;
  const b = win.getBounds();
  if (win.isVisible()) {           // 切模式锚定右下角：藏在后台时别动它，show 回来还是原位
    if (mode === 'ball') {
      state.cardBounds = { width: b.width, height: b.height };
      // 先降最小尺寸再缩窗：setBounds 会被 minWidth/minHeight 夹住（球比卡片下限小），
      // 顺序反了球会飘在一个大一圈的透明窗里，那圈透明边照样挡下层的点击。
      win.setMinimumSize(BALL_SIZE, BALL_SIZE);
      // 卡片能被拖成右下角探出屏外（用户故意的「停半个在角落」）：锚右下角收球会把球
      // 直接放进屏外，再也点不到（2026-09-28 用户撞上）。收球同样夹回工作区 —— 卡片在屏内时
      // placeWithin 是恒等，不影响「缩回卡片那个角」的落点。
      const p = placeWithin(b.x + b.width - BALL_SIZE, b.y + b.height - BALL_SIZE, BALL_SIZE, BALL_SIZE);
      win.setBounds({ x: p.x, y: p.y, width: BALL_SIZE, height: BALL_SIZE });
    } else {
      const c = state.cardBounds || { width: 324, height: 404 };
      // 球能被拖到屏幕顶边/左边：锚右下角还原会让卡片顶（= 唯一拖柄所在的顶栏）探出屏外，
      // 卡片就此拖不回来（2026-09-28 用户撞上：球贴顶边展开，卡片上半截在屏外）。
      // 夹回工作区；球在屏内时 placeWithin 是恒等，不动「从球的位置长回来」的落点。
      const p = placeWithin(b.x + b.width - c.width, b.y + b.height - c.height, c.width, c.height);
      win.setBounds({ x: p.x, y: p.y, width: c.width, height: c.height });
      win.setMinimumSize(230, 160);   // 还原卡片模式的下限
    }
  } else if (mode === 'card') win.setMinimumSize(230, 160);
});

ipcMain.on('float-hide', () => { if (win && !win.isDestroyed()) win.hide(); });  // 关卡片 = 隐藏，不销毁（再开只是 show）
ipcMain.on('float-close', () => { if (win) win.close(); });
// 注意：没有 float-minimize。skipTaskbar 的窗口真最小化 = 永远叫不回来；「缩小」就是收球（float-mode）
// 页面拖拽柄报的是「目标尺寸」（页面从拖动起点自己算好增量），这里只负责夹紧再 setSize
ipcMain.on('float-resize', (e, w, h) => {
  if (!win) return;
  w = Math.max(230, Math.min(640, Math.round(w)));
  h = Math.max(160, Math.min(1200, Math.round(h)));
  win.setSize(w, h);
});
// 水球拖动：球不设系统拖区（app-region:drag 在 Windows 会吞掉 click），页面按 pointer 增量报过来。
// 起点位置在 begin 时记一次 —— 直接每帧读 cursor 位置的另一条路要轮询，增量方案没有竞态。
let dragOrigin = null;
ipcMain.on('float-drag-begin', () => { if (win) dragOrigin = win.getBounds(); });
ipcMain.on('float-drag-by', (e, dx, dy) => {
  if (win && dragOrigin) win.setPosition(dragOrigin.x + Math.round(dx), dragOrigin.y + Math.round(dy));
});

// Ctrl+滚轮的内容缩放，clamp 在壳里 —— 页面只管报方向。
// 基准读 webContents 的实际值而不是本地变量：Chromium 会按 origin 自动记忆缩放（Preferences），
// 重启后实际值可能不是 1，本地变量从 1 起算会跟真实值错开一档。
ipcMain.on('float-zoom', (e, dir) => {
  if (!win) return;
  const cur = win.webContents.getZoomFactor() || 1;
  const next = Math.max(0.6, Math.min(1.5, Math.round((cur + dir) * 10) / 10));
  win.webContents.setZoomFactor(next);
});

// 完整面板：悬浮窗里点「面板 ↗」/球上的 ↗，开成**正经有框大窗**（1280×820 内自适应屏幕），
// 不是浏览器、也不是 Electron 默认那个 500×400 的憋屈弹窗。单例：再点就是聚焦，不开第二个。
let panel = null;
function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(1280, wa.width - 80), h = Math.min(820, wa.height - 60);
  panel = new BrowserWindow({
    width: w, height: h,
    x: wa.x + ((wa.width - w) >> 1), y: wa.y + ((wa.height - h) >> 1),
    autoHideMenuBar: true, title: 'Agent 请求日志', backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false },  // 无 preload：面板页不需要任何壳能力
  });
  panel.loadURL(URL_PANEL);
  // setWindowOpenHandler 的 deny 还没返回就建窗，Chromium 的 popup 流程没收尾，
  // 新窗可能停在不可见态（2026-09-21 实测：第一次点击后窗口存在但 vis=False）。创建路径上补一次显式 show/focus。
  panel.show(); panel.focus();
  panel.on('closed', () => { panel = null; });
}
// 页面里的 target=_blank / window.open 一律由壳接管：本服务的链接开成面板窗，外部链接去系统浏览器。
// 不拦的话 Electron 默认开一个又小又没菜单栏的弹窗（2026-09-20 用户撞上：面板挤得展不开）。
// ⚠️ 建窗动作必须 setImmediate 推迟到 handler 返回之后（Electron 文档口径，见 openPanel 里那条实测）。
app.on('web-contents-created', (e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:' + PORT) || url.startsWith('http://localhost:' + PORT)) setImmediate(openPanel);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// CDP 调试口：默认关。要量「真卡片」（读 computed style、看层叠到底落在哪一版皮肤）时显式开：
//   AGENT_ACTA_WIDGET_DEBUG=9333 agentacta --client
//   curl http://127.0.0.1:9333/json/list   → 拿 webSocketDebuggerUrl（页面标题就是「Agent 实况」）
// 为什么不默认开：这个口能驱动页面，而页面能打到本地服务（/api/agents 写配置、/api/shutdown 停服务）——
// 只绑 127.0.0.1 也不是零风险。做成显式开关，随壳一起退出，不留常驻后门。
const DEBUG_PORT = Number(process.env.AGENT_ACTA_WIDGET_DEBUG) || 0;
if (DEBUG_PORT > 1024 && DEBUG_PORT < 65536) app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT));

app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
