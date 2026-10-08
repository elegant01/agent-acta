// 页面共享的纯函数与常量（R25 批 0 从 agent-acta-page.html 的根内联 script 搬出的第一块）。
//
// 形态：经典 script（不是 ESM）—— 顶层声明即全局，后面的根内联 script 与其模板能直接看见。
// 约束（拆的时候定死，后面每批照抄）：
//   · 这里只放**不依赖响应式状态**的东西；用到 agentsMeta / liveIds / details 等 ref / reactive 的一律留在 setup。
//     （所以 toolJsonFold / callOpen / isLive / titleOf / isDisabled / pathTip 这些没搬 —— 它们吃着 setup 里的状态。）
//   · **不得**重新声明 projNorm / projKey / rangeDayStart —— 唯一来源是服务端 SHARED_JS 注入（R12），
//     test/shared-snippet-test.mjs 与 test/page-components-test.mjs 都会拦。
//   · 模板只能看见 setup() return 里的键：根 script 的 return 仍逐个列出这里的函数名。
//     别指望模板直接去找全局 —— prod Vue 的 _ctx 代理对未知名字一律返回 undefined，表现是那格静默空白。
// 加载顺序：vendor（Vue / Element Plus）→ 本文件 → SHARED_JS 注入段 → 各组件文件 → 根内联 script。
// ⚠ 顶层 const / function 与根 script 的顶层声明共享同一个全局词法作用域：重名 = 整页 SyntaxError。
//    跨文件重名由 test/page-components-test.mjs 静态拦；本文件刻意不声明任何 ElMessage / Vue 解构名。
//
// ---- R25 组件文件契约（**机器可定位**，test/page-check.mjs 与 test/page-components-test.mjs 按此抠键）----
// 每个组件文件（page/*.js 里除本文件外的都是）必须长成这个形状，不许多态：
//
//   window.AACTA = window.AACTA || {};
//   AACTA.XxxView = {
//     name: 'aa-xxx',                       // 必须 aa- 前缀（全局注册防撞 + 检查器识别锚点）
//     template: `<div>…</div>`,             // 反引号字符串；**不得**出现未转义的 `${`（会变成 JS 插值）
//     props: { a: …, b: … },                // 对象字面量或字符串数组两种形态都行
//     inject: ['padLeft'],                  // 同上
//     emits: ['open-session'],
//     setup(props, { emit }) {
//       …
//       return { x, y };                    // 必须是函数体里**最后一个**顶层 return，且是对象字面量
//     }
//   };
//
// 另外两条风格约束（检查器靠它们收名字，破了不会报错但检查会失明）：
//   · 顶层声明一律**顶格**（不缩进）—— page/*.js 的顶层名集合由顶格正则收集；
//   · 一个文件恰一个组件（`AACTA.<ID> = {` 只许出现一处）。
// 注册方式（方案 C 拍板）：组件不自己 app.component，统一由根内联 script 末尾注册（时序天然安全）。

// 品牌色 / 品牌图标映射（图标来自 @lobehub/icons 静态 SVG，已本地化到 /vendor/svg/）
const AGENT_COLORS = { atomcode: '#3b74e7', codebuddy: '#18a058', 'codebuddy-ext': '#18a058', workbuddy: '#7c5cd6', claude: '#d97757', zcode: '#0e9aa7' };
const PALETTE = ['#3b74e7', '#18a058', '#7c5cd6', '#c26a1b', '#c2185b', '#0e9aa7', '#795548'];
const AGENT_ICONS = { atomcode: 'logo-AtomGit-G-red.svg', claude: 'claudecode-color.svg', codebuddy: 'codebuddy-color.svg', 'codebuddy-ext': 'codebuddy-color.svg', workbuddy: 'workbuddy-color.svg', trae: 'trae-color.svg', traework: 'traework-v2.svg', cursor: 'cursor.svg', codex: 'codex-color.svg', opencode: 'opencode.svg', kilo: 'kilocode.svg', openclaw: 'openclaw-color.svg', cline: 'cline.svg', qoder: 'qoder-color.svg', 'qoder-cn': 'qoder-color.svg', codeart: 'huawei-color.svg', codearts: 'huawei-color.svg', gemini: 'gemini-color.svg', kimi: 'kimi.svg', 'zcode': 'zai.svg', 'dsh': 'deepseek-harness-whale.svg', hermes: 'hermesagent.svg', devin: 'windsurf.svg', qwen: 'qwen-color.svg', doubao: 'doubao-color.svg', hunyuan: 'hunyuan-color.svg', grok: 'grok.svg', copilot: 'copilot.svg', windsurf: 'windsurf.svg', minimax: 'minimax-code-logo.svg', mimocode: 'mimo.svg' };
// R16 遗留子项：只有图标、后端零检测的名字 —— 不会自动发现、没有解析器。
// 用户在「添加 agent」里敲这些名字时会误以为能自动识别，必须明示（口径与需求书 R16 一致）。
// doubao 已有解析器（R26）、hermes 已于 2026-09-21 接入（state.db SQLite + agent.log 辅源）、
// openclaw 已于 2026-09-23 接入（~/.openclaw/agents/<id>/sessions/*.jsonl 追加式会话树），从名单里移除（图标仍在 AGENT_ICONS，正常显示）
// devin 已于 2026-09-24 接入（%APPDATA%\Devin\cli\sessions.db 明文 SQLite）。图标**沿用 windsurf.svg**：
//   装的这份 Devin 桌面版里，产品自己的扩展目录就叫 `extensions/windsurf`、displayName 写的是 "Devin"
//   （库里 backend_type 也是 'windsurf'）—— 同一家同一个产品，本机拿不到单独的 Devin 品牌图。
//   将来手上有官方 devin.svg 时，放进 vendor/svg/ 再把这里改成 devin.svg 即可。
// kilo 已于 2026-09-24 接入（~/.local/share/kilo/kilo.db，opencode 的 fork）；图标用已有的 kilocode.svg。
const ICON_ONLY_AGENTS = new Set(['qwen', 'hunyuan', 'grok']);
const MODEL_ICONS = [
  ['claude', 'claude-color.svg'],
  ['glm', 'zhipu-color.svg'],
  ['deepseek', 'deepseek-color.svg'],
  ['qwen', 'qwen-color.svg'],
  ['codex', 'codex-color.svg'],
  ['gpt', 'openai.svg'], ['openai', 'openai.svg'],
  ['gemini', 'gemini-color.svg'],
  ['grok', 'grok.svg'],
  ['kimi', 'kimi.svg'], ['moonshot', 'moonshot.svg'],
  ['doubao', 'doubao-color.svg'],
  ['minimax', 'minimax-color.svg'],
  ['hunyuan', 'hunyuan-color.svg'],
  ['wenxin', 'wenxin-color.svg'], ['ernie', 'wenxin-color.svg'],
  ['mimo', 'xiaomimimo.svg'],
  ['yuanbao', 'yuanbao-color.svg'], ['bytedance', 'bytedance-color.svg'], ['pangu', 'huawei-color.svg'],
  ['mai-code', 'copilot.svg'],
];

const fmtN = n => !n ? '0' : (n >= 1e6 ? (n/1e6).toFixed(1)+'M' : (n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n)));
const fmtDur = ms => !ms ? '—' : ms < 1000 ? ms+'ms' : ms < 60000 ? (ms/1000).toFixed(1)+'s' : Math.floor(ms/60000)+'m'+Math.round(ms%60000/1000)+'s';
// qoder 按 credits 计费、token 恒为 0，卡片改显真实用量（积分 / 上下文占比 / 压缩前后 token）。
// 解析器只对 qoder 落这几个字段，故用「字段存在」判定即可，不必硬编码 agent 名单。
const isQoder = e => e.credits != null;
const fmtCredits = n => !n ? '0' : (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const fmtPct = r => !r ? '0%' : (r <= 1 ? (r * 100).toFixed(1) : r.toFixed(1)) + '%';

// ---- R3 详情渲染辅助（全本地实现，不引外部库：页面是离线本地服务，CDN 不可用）----
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 简易代码高亮：先转义再上色（顺序不能反，否则会被注入）。覆盖常见关键字/字符串/注释/数字，
// 目的是「可读」而不是「完备」—— 渲染错漏不影响原文（复制按钮给的是原文）。
function hlCode(code) {
  let s = escHtml(code);
  s = s.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="hl-str">$1</span>');
  s = s.replace(/(^|\n)(\s*)(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, '$1$2<span class="hl-com">$3</span>');
  s = s.replace(/\b(const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|try|catch|throw|def|self|this|null|true|false|undefined|None|True|False)\b/g, '<span class="hl-kw">$1</span>');
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="hl-num">$1</span>');
  return s;
}
// 轻量 Markdown → HTML：块级（标题/列表/代码围栏/引用/分隔线/段落）+ 行内（粗斜体/行内码/链接）。
// 输入一律先 escHtml，任何未识别语法都原样呈现，绝不拼原文进 HTML。
function renderMd(src) {
  const text = String(src ?? '');
  const lines = text.split('\n');
  let out = '', i = 0, para = [];
  const flush = () => { if (para.length) { out += '<p>' + inlineMd(escHtml(para.join('\n'))).replace(/\n/g, '<br>') + '</p>'; para = []; } };
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => '<code class="md-ic">' + c + '</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  while (i < lines.length) {
    const L = lines[i];
    if (/^```/.test(L)) {
      flush();
      const lang = L.slice(3).trim();
      let j = i + 1, buf = [];
      while (j < lines.length && !/^```/.test(lines[j])) buf.push(lines[j++]);
      out += '<pre class="md-code">' + (lang ? '<span class="hl-lang">' + escHtml(lang) + '</span>' : '') + '<code>' + hlCode(buf.join('\n')) + '</code></pre>';
      i = j + 1; continue;
    }
    const h = L.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); out += '<h5 class="md-h">' + inlineMd(escHtml(h[2])) + '</h5>'; i++; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(L)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')), i++;
      out += '<ul class="md-ul">' + items.map(t => '<li>' + inlineMd(escHtml(t)) + '</li>').join('') + '</ul>';
      continue;
    }
    if (/^>\s?/.test(L)) { flush(); out += '<blockquote class="md-q">' + inlineMd(escHtml(L.replace(/^>\s?/, ''))) + '</blockquote>'; i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(L)) { flush(); out += '<hr class="md-hr">'; i++; continue; }
    if (!L.trim()) { flush(); i++; continue; }
    para.push(L); i++;
  }
  flush();
  return out || '<p>(空)</p>';
}
// 工具入参/返回：能解析成 JSON 就缩进美化（截断内容解析失败则原样返回）
function prettyJson(s) {
  if (typeof s !== 'string') return s;
  try { const v = JSON.parse(s); return JSON.stringify(v, null, 2); } catch { return s; }
}

// 详情入库前的预处理：把昂贵的派生渲染（Markdown 正则渲染、每个工具的 JSON 美化）
// 一次性算好缓存在对象上（下划线字段）。之前这些都是模板里的函数调用 —— 卡片每次重渲染
// （点开折叠、来一条 SSE、别的卡片展开）都会全量重算，362 个工具的大卡片实测主线程 100~500ms。
// 模板侧一律读缓存、以 `|| prettyJson(...)` 兜底：缓存缺失时退回现算，行为与旧版一致。
function prepDetail(d) {
  if (!d || d._prepped) return d;
  if (d.assistant) d._assistantMd = renderMd(d.assistant);
  for (const t of d.tools || []) {
    if (t.input) t._inPretty = prettyJson(t.input);
    if (t.output) t._outPretty = prettyJson(t.output);
  }
  d._prepped = true;
  return d;
}
// 详情内容指纹（不含下划线缓存字段）：reloadDetail 用来判断「这次拉回来的和手里的是不是同一份」
const detailSig = d => d ? JSON.stringify([d.user, d.assistant, d.spans, d.calls, d.tools, d.others, d.callsNote]) : '';

// 「LLM 调用明细」那行右侧的工具标记文案：按**名字去重计数**后再列。
// 同一次响应里并行调三个 Bash 是常事，原样铺出来就是「Bash · Bash · Bash」——
// 那不是信息，是噪声。收成「Bash×3」。
// limit 默认 2：一行里还要放模型、耗时、token，列全了会把它们挤没（完整的在 title 里）。
function toolText(list, limit) {
  if (!list || !list.length) return '';
  const order = [], cnt = new Map();
  for (const n of list) { if (!cnt.has(n)) { cnt.set(n, 0); order.push(n); } cnt.set(n, cnt.get(n) + 1); }
  const lim = limit || 2;
  const head = order.slice(0, lim).map(n => (cnt.get(n) > 1 ? n + '×' + cnt.get(n) : n)).join(' · ');
  return order.length > lim ? head + ' +' + (order.length - lim) : head;
}

async function copyRaw(ev, text) {
  ev.stopPropagation();
  const t = String(text ?? '');
  try { await navigator.clipboard.writeText(t); }
  catch {
    // file:// 或旧浏览器无 clipboard 权限 → 走 execCommand 兜底
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  ElementPlus.ElMessage.success('已复制原文');
}

// 会话级的「相对时间」：列表里一眼看出哪个会话是刚跑过的
const fmtAgo = t => {
  if (!t) return '—';
  const d = Date.now() - t;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
  return new Date(t).toLocaleDateString('zh-CN');
};
// 合计 token 一律现算：/api/session 与它的 entries[] 只给 tin/tout/tcache，**没有** total 字段
// （服务端 sessionsAgg 是在返回前现算 total 的，这里跟它同一口径）。
const sumTok = o => ((o && o.tin) || 0) + ((o && o.tout) || 0) + ((o && o.tcache) || 0);

// 聚合量（按天/整个范围）用的耗时格式：拿上面那个格式会算出「30089m41s」——200 天合计 501 小时，
// 分针读法到这儿就不可读了。单条卡片仍用 fmtDur（那里都是分钟级）。
const fmtDurBig = ms => {
  if (!ms) return '—';
  const h = ms / 3600000;
  if (h >= 48) return (h / 24).toFixed(1) + '天';
  if (h >= 1) return h.toFixed(1) + 'h';
  return fmtDur(ms);
};
const fmtTime = t => t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—';

// 模型名一律先落成字符串再拼。原因：卡片标题就是 models.join(', ')，而 join 对非字符串一律调
// toString —— 只要数组里混进一个对象（某个 agent 的某个版本把 model 写成 {slug:…}），标题就会
// 变成「[object Object], [object Object]…」：日志本身没坏，看起来却像整张卡片乱了。
// 服务端已经统一强制过（见 agent-acta-server.mjs 的 modelName / modelList）；这里是页面侧第二道，
// 因为页面比服务端好更新——老服务端配新页面时也得能正常显示。
const modelText = list => (list || []).map(m => {
  if (typeof m === 'string') return m.trim();
  if (m && typeof m === 'object') return String(m.slug || m.id || m.model_id || m.name || '').trim();
  return m == null ? '' : String(m);
}).filter(Boolean).join(', ');

// R20：工具名摘要收进「N 工具」旁的问号悬浮层（完整列表，不再截 5 个），详情仍展开完整工具列表。
const toolList = e => Object.entries(e.toolNames || {})
  .filter(([n, c]) => n && c > 0)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const agentLetter = a => ({ atomcode: 'A', codebuddy: 'C', workbuddy: 'W' })[a] || (String(a || '?')[0] || '?').toUpperCase();
// 上下文进度条的分子是「这一轮结束时的上下文占用」，**不是 Token 合计**——
// 合计（e.total）是轮内各次调用的累加，跑 80 轮能到千万级，拿它除以窗口会永远贴着 100%。
// atomcode 有真实末轮占用（e.ctxUsed = meta.total_tokens = 末轮 prompt+completion）；
// 其余 agent 只有累加值可近似，退回 e.total（原来就是这个行为，别改）。
const ctxUsed = e => e.ctxUsed != null ? e.ctxUsed : e.total;
const ctxPct = e => e.ctx ? Math.min(100, Math.round(ctxUsed(e) / e.ctx * 100)) : 0;

const agentColor = name => {
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
const agentIcon = name => AGENT_ICONS[name] ? '/vendor/svg/' + AGENT_ICONS[name] : null;

// 前缀匹配表：模型名以这些前缀开头即命中（hy3/hy-t1→混元、seedance→豆包等），优先于子串匹配
const MODEL_PREFIX_ICONS = [
  ['deepseek', 'deepseek-color.svg'],
  ['qwen', 'qwen-color.svg'],
  // 智谱系模型名实际都是 glm/GLM 开头（glm-4.7、GLM-5.3，见 zcode/trae/opencode 解析器 fixture），
  // 一律走 zhipu-color.svg；glmv（GLM-V 视觉系）排在 glm 前防被吞
  ['glmv', 'glmv-color.svg'],
  ['glm', 'zhipu-color.svg'],
  ['llama', 'meta-color.svg'],
  ['openrouter', 'openrouter-color.svg'],
  ['doubao', 'doubao-color.svg'], ['seed', 'doubao-color.svg'], // seedance/seed1.6 等字节系→豆包
  ['hy', 'hunyuan-color.svg'], ['hunyuan', 'hunyuan-color.svg'],
  ['kimi', 'kimi.svg'], ['moonshot', 'moonshot.svg'],
  ['gemini', 'gemini-color.svg'],
  ['grok', 'grok.svg'],
  ['claude', 'claude-color.svg'],
  ['gpt', 'openai.svg'], ['o3', 'openai.svg'], ['o4', 'openai.svg'],
  ['step', 'stepfun.svg'], // step 系模型（step-xxx / stepfun）
  ['minimax', 'minimax-color.svg'], ['abab', 'minimax-color.svg'],
  ['ernie', 'wenxin-color.svg'], ['wenxin', 'wenxin-color.svg'],
  ['mimo', 'xiaomimimo.svg'],
  ['pangu', 'huawei-color.svg'],
  ['yuanbao', 'yuanbao-color.svg'],
  ['mai-code', 'copilot.svg'], // 蚂蚁 mai-code 系模型（mai-code-xxx）借 GitHub Copilot 图标
  ['muse', 'meta-color.svg'], // Muse 系模型（muse-xxx）
  ['nemotron', 'nvidia-color.svg'], // Nemotron 系模型（nemotron-xxx）
  ['ling-', 'antgroup-color.svg'], // 蚂蚁百灵 Ling 系模型（ling-xxx）
  ['sensenova', 'sensenova-color.svg'], ['sense-', 'sensenova-color.svg'], // 商汤（sensenova-u1 / sense-nova-xxx 两种写法）
  ['nex-', 'nex-color.svg'], // Nex 系模型（Nex-N2.5-Pro/Mini/Max）
];
const modelIcon = models => {
  const list = models || [];
  for (const m of list) {
    const s = String(m).toLowerCase();
    for (const [p, f] of MODEL_PREFIX_ICONS) if (s.startsWith(p)) return '/vendor/svg/' + f;
  }
  const joined = modelText(list).toLowerCase();   // 非字符串一律先落成字符串，否则 {slug:…} 会变成 "[object object]" 匹配不上任何前缀
  for (const [k, f] of MODEL_ICONS) if (joined.includes(k)) return '/vendor/svg/' + f;
  return null;
};
const iconOf = e => modelIcon(e.models) || agentIcon(e.agent);

// ---- R11 导出纯函数（CSV / Excel）----
// 这里只放**不依赖响应式状态**的序列化与下载触发，筛选条件怎么拼由根 setup 决定（它才认识那些 ref）。
// 约束同 shared.js 头部：不引外部库（离线本地服务，CDN 不可用）、零依赖、手写格式。
// CSV 与 Excel(SpreadsheetML) 都带 UTF-8 BOM —— 中文在表格软件里不乱码。

// CSV 单元格转义：值含逗号/双引号/换行时用双引号包起来，内部双引号翻倍。
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// 组装 CSV：lines 已含表头与筛选说明行。
function buildCSV(lines) {
  return '\uFEFF' + lines.map(row => row.map(csvCell).join(',')).join('\r\n');
}
// 触发浏览器下载。
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
// Excel 兼容文件：SpreadsheetML 2003 XML（.xls）。Excel / WPS 原生打开，无需任何第三方库。
// sheetName 当工作表名；说明行（noteLines）+ 空行 + 数据表头 + 数据行，满足「能自证按什么条件导出」。
function buildExcelXLSText(sheetName, noteLines, header, rows) {
  const ssCell = v => {
    const s = String(v ?? '');
    const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isNum = /^-?\d+(\.\d+)?$/.test(s);
    return '<Cell><Data ss:Type="' + (isNum ? 'Number' : 'String') + '">' + esc + '</Data></Cell>';
  };
  const rowXml = cells => '<Row>' + cells.map(ssCell).join('') + '</Row>';
  // 说明行横跨到第 2 列（表头列数未知前先固定用长度 2）：值放第 1 列即可，第 2 列留空当分隔。
  const noteRows = (noteLines || []).map(t => '<Row><Cell><Data ss:Type="String">' + String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</Data></Cell><Cell></Cell></Row>');
  const dataRows = rows.map(r => rowXml(header.map(h => r[h])));
  const xml =
    '<?xml version="1.0"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:o="urn:schemas-microsoft-com:office:office"\n' +
    ' xmlns:x="urn:schemas-microsoft-com:office:excel"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    ' <Worksheet ss:Name="' + String(sheetName).replace(/[\\*?[\]]/g, '_') + '">\n' +
    '  <Table>\n' +
    noteRows.join('\n') +
    '<Row></Row>\n' +
    rowXml(header) + '\n' +
    dataRows.join('\n') + '\n' +
    '  </Table>\n' +
    ' </Worksheet>\n' +
    '</Workbook>';
  return '\uFEFF' + xml;
}

// ---------------- I8 单轮「复现包」：零依赖 ZIP 打包 ----------------
// 约束：本地离线服务、浏览器里也禁第三方库，所以**不能**引 JSZip 之类。这里手写 store 模式（不压缩）
// 的 ZIP，跨平台、各类解压工具与 `unzip` 都认。内容是文本为主，store 不压缩并无所谓。
// files: [{ name, text }]，name 用正斜杠（`/`）当分隔符、末尾不带 `/`；text 任意字符串（按 UTF-8 落盘）。
// 返回 Blob（type='application/zip'），直接丢给 downloadBlob。
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function _crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];     // 所有写入的 Uint8Array 片段（按 ZIP 流顺序）
  const central = [];    // 中央目录记录（每个文件一条）
  let offset = 0;        // 当前本地文件头起点（相对 ZIP 起点）
  const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(String(f.text ?? ''));
    const crc = _crc32(data);
    // 本地文件头（30 字节签名 + name）
    const local = [
      u32(0x04034b50),     // local file header signature
      u16(20),             // version needed
      u16(0x0800),         // general purpose flag: bit 11 = UTF-8 文件名（中文名不乱码）
      u16(0),              // compression method: 0 = store
      u16(0), u16(0),      // mod time / mod date（留 0，复现包不在乎）
      u32(crc),            // CRC-32
      u32(data.length),    // compressed size（store = 原长）
      u32(data.length),    // uncompressed size
      u16(nameBytes.length), u16(0), // file name / extra length
      nameBytes,
    ];
    chunks.push(...local, data);
    // 中央目录记录
    const cd = [
      u32(0x02014b50),     // central directory header signature
      u16(20), u16(20),    // version made by / needed
      u16(0x0800),         // flag: UTF-8
      u16(0),              // method: store
      u16(0), u16(0),      // time / date
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), // name / extra / comment length
      u32(0),              // disk number start
      u16(0),              // internal attrs
      u32(0),              // external attrs
      u32(offset),         // local header offset
      nameBytes,
    ];
    central.push({ bytes: cd, len: cd.reduce((a, b) => a + b.length, 0) });
    offset += local.reduce((a, b) => a + b.length, 0) + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(...c.bytes); cdSize += c.len; }
  // 结束目录记录（End of Central Directory）
  const eocd = [
    u32(0x06054b50), u16(0), u16(0),   // signature + disk numbers
    u16(files.length), u16(files.length), // entries on this / total
    u32(cdSize), u32(cdStart),         // central dir size / offset
    u16(0),                            // comment length
  ];
  chunks.push(...eocd);
  return new Blob(chunks, { type: 'application/zip' });
}
