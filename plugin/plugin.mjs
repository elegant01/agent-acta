// AgentActa 的 DSH 插件壳（I11 批 2）。
//
// 形状是「URL 转接 + 逐条注册」，不是第二套服务：handler 要么转给 core 的 handle(req,res)（本机 hosted），
// 要么转给 14570 上那一个已在跑的服务（代理），两条都不自己再开扫描器。
// 静态文件也走 core 原有的 routePageFile / routeVendor（那套 path.resolve + 前缀校验防逃逸只有一份）。
// 装配层的生命周期（扫描 / 落索引 / SSE 心跳 / 归档轮）由 start({mode:'hosted'}) 开，
// 但**不监听端口、不写 pid、不挂空闲自停、不退出宿主进程** —— 见 core/service.mjs 的 MODE 三态。
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import {
  ROUTES, PAGE_DIR, ROOT, PORT, VERSION, BUILD,
  handle, start, stop,
} from '../core/service.mjs';

// 插件声明名 = 包名（cordis 按这个键装配；09-30 因为 npm 上 `agentacta` 已被别人的同名项目占了，
// 包名换成作用域名 `@yxzpro/agent-acta` —— 产品名、CLI 命令 `agentacta`、面板 key 与 URL 都不跟着改）。
export const name = '@yxzpro/agent-acta';
export const inject = ['webServer'];

// 宿主里不该存在的五条：抢认证兜底的 `/`、退进程、起 Electron 壳、弹 UAC 抓密钥、悬浮球壳。
// 它们在 core 的路由表里照旧存在（CLI 要用），只是不给宿主注册。
// 导出是给守卫对的：test/cli-behavior-guard.mjs 断言「插件实际注册的集合 ≡ ROUTES − DENY + EXTRA」。
// 不导出的话，「插件悄悄少挂一条 API」这条红线只守住了 core 那半边。
//
// '/' 也必须让出去：宿主 webServer 的兜底位（dsh-host-frontend-static）在上面挂的是
// authorizeIndex —— 壳启动时拿 GET /?token=… 换 303 + set-cookie 才算认证过。
// exact 路由优先于兜底位，插件一旦把 '/' 挂成 exact，这一问就由面板 HTML 200 应答（无 cookie），
// 壳直接判「Desktop Host authentication failed」⇒ DSH 每次开机都起不来（2026-09-30 实测）。
export const HOSTED_DENY = ['/', '/api/shutdown', '/api/client', '/api/trae/capture-key', '/widget'];
// 面板的唯一入口路径：两支（本机 hosted 递 HTML / 代理上游递 HTML）都挂在这一条上，
// client.js 的 iframe src 就是它 —— 两支换路不换路径，才不会出现「图标点了但 404」。
export const ENTRY_PATH = '/api/agent-acta/entry';
// 静态资产的中转路径：`?p=page/x.js`。宿主前端在 `dsh-app://app` 下**只把 /api/* 代理到 webServer**，
// 所以面板里那些 `/page/…`、`/vendor/…` 引用在浏览器侧一律 404（curl 打宿主 http 口却是 200，别被骗）。
// 只能把它们收进 /api 命名空间，见下面的 rewriteRefs。
export const ASSET_PATH = '/api/agent-acta/asset';
// 「让插件接手」那条：代理模式下 CLI 服务中途停了，面板顶部会给出一个按钮，点它才起 hosted。
// 为什么要人点一下才起：自动起就可能和「用户又把 CLI 起回来」撞成两个写者，那个决定该由人负责。
export const TAKEOVER_PATH = '/api/agent-acta/takeover';
export const HOSTED_EXTRA = [ENTRY_PATH, ASSET_PATH, TAKEOVER_PATH];

// 双载体探测在测试里要能换掉（守卫不能依赖「用户有没有开着 14570」这种环境状态）。
let cliProbe = probeCliService;
export function setCliProbe(fn) { cliProbe = typeof fn === 'function' ? fn : probeCliService; }
// 上游端口也要能换：代理那一支的测试靠它指向一个假上游，不能去碰用户真在跑的 14570。
let cliPort = PORT;
export function setCliPort(p) { const n = Number(p); cliPort = Number.isFinite(n) && n > 0 ? n : PORT; }

// PLAN §8.8 的 A/B 之择，09-30 由 A 改判成 **B（代理转发）**：A 的体感是「装了个不能用」——
// 常驻服务才是常态，于是点开面板永远只看到一页说教，而给出的处置（停服务 + 重启整个 DSH）比看日志本身贵得多。
// B 之后：CLI 在跑就把它的面板原样递进来（本机仍然只有一个扫描器），没在跑才由插件自己起 hosted。
// 「在不在跑」改成**每次请求现判**（环回探测约 1ms，结果缓存 2 秒），所以说明页上那个假版本号也一并消了。
function probeCliService() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: cliPort, timeout: 600 });
    s.on('connect', () => {
      s.write('GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      let buf = '';
      s.on('data', (d) => { buf += d; });
      s.on('end', () => {
        const m = buf.match(/\{[\s\S]*\}/);
        try { const j = m ? JSON.parse(m[0]) : null; resolve(j && j.ok ? j : null); } catch { resolve(null); }
      });
      s.on('error', () => resolve(null));
    });
    s.on('timeout', () => { s.destroy(); resolve(null); });
    s.on('error', () => resolve(null));
  });
}

let cliCache = { at: -1e9, up: null };
const CLI_TTL = 2000;
async function cliServiceUp(force) {
  const now = Date.now();
  if (!force && now - cliCache.at < CLI_TTL) return cliCache.up;
  const up = await cliProbe();
  cliCache = { at: now, up: up || null };
  return cliCache.up;
}

// 静态资源白名单：启动时递归列目录，而不是抄一份常量表 ——
// 抄来的清单会随页面加组件/图标而过期（vendor/svg 下 54 个图标正是先前漏掉的那批）。
function staticFiles() {
  const out = [];
  for (const dir of [PAGE_DIR, path.join(ROOT, 'vendor')]) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d, pre) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs, pre + e.name + '/');
        else out.push(pre + e.name);
      }
    };
    const base = path.basename(dir);
    walk(dir, '/' + base + '/');
  }
  return out;
}

// 插件到底该往宿主注册哪些路由 —— **纯函数**，不 start、不起扫描、不碰数据目录。
// 守卫要的就是这一份：拿 apply() 去数注册条式意味着在测试里真起一个 hosted 服务，
// 那会在用户的机器上多出第二个索引写者（2026-09-29 我这么试过一次，2 秒，事后无法归因）。
export function hostedRouteSpecs() {
  const deny = new Set(HOSTED_DENY);
  const specs = ROUTES.filter(r => !deny.has(r.path)).map(r => ({ kind: 'exact', path: r.path }));
  for (const p of staticFiles()) specs.push({ kind: 'exact', path: p });
  for (const p of HOSTED_EXTRA) specs.push({ kind: 'exact', path: p });
  return specs;
}

// 面板引用改写：只认「紧跟引号的那个 /page/ 或 /vendor/」，换成资产路由的形式。
// 收窄到引号后面这一处有两个理由：① 注释和报错文案里的 `/page/` 不是 URL，跟着改会让人以为是新路径；
// ② 运行时拼出来的图标（`'/vendor/svg/' + name`，page/shared.js:234）也是引号开头，所以这一条规则同时覆盖静态标签和动态拼接。
// 已核过 vendor/ 内部没有任何绝对引用（Element Plus 的 url() 全是 data:/#fragment），改写不会漏掉二跳引用。
const ASSET_URL = ASSET_PATH + '?p=';
const REWRITEABLE = /^text\/(html|javascript|css)/;
export function rewriteRefs(text) {
  return text.replace(/(["'])\/(page|vendor)\//g, '$1' + ASSET_URL + '$2/');
}

// 借 core 的手把文件发出去，插件只在中间加一层「URL 前缀翻译」：
// 防穿越、MIME、no-store、`__AGENT_LOG_BUILD__` / `__AGENT_LOG_SHARED__` 注入全都还是那一份实现
//（顶注那条纪律 —— 装配层不另起一套服务）。
function deliver(req, res, urlPath) {
  const cap = { statusCode: 200, headers: {}, body: null };
  const push = (chunk) => {
    if (chunk == null) return;
    cap.body = Buffer.concat([cap.body || Buffer.alloc(0), Buffer.from(chunk)]);
  };
  const shim = {
    get statusCode() { return cap.statusCode; },
    set statusCode(v) { cap.statusCode = v; },
    setHeader(k, v) { cap.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return cap.headers[String(k).toLowerCase()]; },
    hasHeader(k) { return String(k).toLowerCase() in cap.headers; },
    write: push,
    end(chunk) {
      push(chunk);
      const type = String(cap.headers['content-type'] || '');
      let out = cap.body || Buffer.alloc(0);
      if (cap.statusCode === 200 && REWRITEABLE.test(type)) out = Buffer.from(rewriteRefs(out.toString('utf8')), 'utf8');
      res.statusCode = cap.statusCode;
      for (const [k, v] of Object.entries(cap.headers)) { try { res.setHeader(k, v); } catch {} }
      res.end(out);
    },
  };
  // 那三条目标路由（'/'、/page/*、/vendor/*）都是同步 readFileSync + 同步 end，所以改 req.url、调用、再改回来是安全的；
  // 若哪天它们改成异步流式输出，这里要换成复制一个 req。
  const orig = req.url;
  req.url = urlPath;
  try { handle(req, shim); }
  catch (e) { res.statusCode = 500; res.end('agent-acta: 递送失败 ' + (e && e.message)); }
  finally { req.url = orig; }
}

// ?p= 只收裸相对路径（page/x.js、vendor/svg/y.svg）。带前导斜杠、带 .. 的一律不收 ——
// core 里那套 resolve + 前缀比对仍作第二层，这两层不是重复：那层防文件穿越，这层防「把资产路由当成任意路径的口子」。
const ASSET_REL = /^(?:page|vendor)\/[\w.-]+(?:\/[\w.-]+)*$/;
export function assetTarget(req) {
  let p = '';
  try { p = new URL(req.url, 'http://agent-acta.local').searchParams.get('p') || ''; } catch { return null; }
  if (!ASSET_REL.test(p) || p.includes('..')) return null;
  return '/' + p;
}

// 上游递出来的 HTML / JS / CSS 里那些 `/page/`、`/vendor/` 一样到不了浏览器（iframe 在 dsh-app:// 下），
// 所以代理这一支也必须过同一遍改写 —— 复用 rewriteRefs，不另写第二套规则。
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);

export function proxy(req, res, upstreamPath) {
  return new Promise((resolve) => {
    const finish = () => resolve();
    const up = http.request(
      {
        host: '127.0.0.1', port: cliPort, path: upstreamPath || req.url, method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:' + cliPort },
      },
      (ur) => {
        const type = String(ur.headers['content-type'] || '');
        const rewrite = ur.statusCode === 200 && REWRITEABLE.test(type);
        const copyHeaders = () => {
          res.statusCode = ur.statusCode;
          for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase())) { try { res.setHeader(k, v); } catch {} }
        };
        if (!rewrite) {
          // 原样透传：SSE（/api/events）靠这一支才能一段段 flush 出去，缓冲整条流等于把实时推送做成轮询
          copyHeaders();
          ur.on('data', (c) => { try { res.write(c); } catch {} });
          ur.on('end', () => { try { res.end(); } catch {}; finish(); });
          ur.on('error', () => { try { res.end(); } catch {}; finish(); });
          return;
        }
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          copyHeaders();
          res.end(Buffer.from(rewriteRefs(Buffer.concat(chunks).toString('utf8')), 'utf8'));
          finish();
        });
        ur.on('error', () => { try { res.statusCode = 502; res.end('agent-acta: 上游断流'); } catch {}; finish(); });
      });
    up.on('error', () => {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('agent-acta: 连不上 127.0.0.1:' + cliPort + '（命令行服务刚好退了？重新打开面板可让插件接手）');
      finish();
    });
    if (req.method === 'GET' || req.method === 'HEAD') up.end(); else req.pipe(up);   // POST 的 body 要转出去，写操作才有效
  });
}

const PAGE_STYLE = 'body{font:14px/1.7 ui-monospace,Consolas,monospace;background:#12161d;color:#dfe6ef;padding:22px;max-width:46rem}code{background:#ffffff14;padding:2px 6px;border-radius:4px}button{font:inherit;background:#2d6cdf;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer}';

// 代理模式下 CLI 中途退了才见得到这一页：给一个明确的按钮，点了才起 hosted（不自动起 —— 自动起可能和
// 「用户又把 CLI 起回来」撞成两个写者，那个决定该由人负责）。
const TAKEOVER_PAGE = () => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AgentActa</title>
<style>${PAGE_STYLE}</style>
<body><h3>命令行那版服务已退出</h3>
<p>插件刚才是把 <code>127.0.0.1:${cliPort}</code> 的面板原样递进来的；那个服务不在了，所以这里没有数据可读。</p>
<p>要插件自己接手（在本进程里起一套扫描与索引，仍不占端口、不写 pid）：
<button id="go">让插件接手</button>
<script>document.getElementById('go').onclick=function(){var b=this;b.disabled=1;b.textContent='启动中…';
fetch('${TAKEOVER_PATH}',{method:'POST'}).then(function(r){return r.json()}).then(function(){location.reload()},function(){location.reload()})};</script>
</body></html>`;

const plain = (res, code, msg) => { res.statusCode = code; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('agent-acta: ' + msg); };

export function apply(ctx) {
  let web = null;
  const registered = [];

  const reg = (kind, p, h) => {
    try {
      web.effect(() => {
        const off = web.webServer.register({ kind, path: p, handler: h });
        registered.push(p);
        return () => { try { if (typeof off === 'function') off(); } catch (e) { /* 卸载不该拖垮宿主 */ } };
      });
    } catch (e) {
      console.error('[agent-acta] 路由注册失败 ' + p + '：' + (e && e.message));
    }
  };

  // 把 inject 的 promise 交回去：宿主（和测试）要能 await 到「注册真的挂完」，
  // 否则 apply() 只是「发起」了装配 —— 测试里就会看见注册表还是空的、断言空跑。
  return ctx.inject(['webServer'], async (webCtx) => {
    web = webCtx;
    // local = hosted 是否已在本进程起来。装载时探一次：CLI 在跑就先走代理，一个扫描器都不多起。
    let local = false;
    if (!(await cliServiceUp(true))) { await start({ mode: 'hosted', listen: false }); local = true; }

    const api = async (req, res) => {
      if (local) return handle(req, res);
      if (await cliServiceUp()) return proxy(req, res);
      return plain(res, 503, '命令行服务已退出、插件也还没接手 —— 重新打开面板，点「让插件接手」');
    };
    const entry = async (req, res) => {
      if (local) return deliver(req, res, '/');
      if (await cliServiceUp()) return proxy(req, res, '/');
      res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(TAKEOVER_PAGE());
    };
    const asset = async (req, res) => {
      const target = assetTarget(req);
      if (!target) return plain(res, 400, '资产请求的 p 参数不在白名单（要形如 page/x.js）');
      if (local) return deliver(req, res, target);
      if (await cliServiceUp()) return proxy(req, res, target);
      return plain(res, 503, '命令行服务已退出，插件也还没接手');
    };
    const takeover = async (req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (local) { res.end('{"ok":true,"already":true}'); return; }
      if (await cliServiceUp(true)) { res.statusCode = 409; res.end('{"ok":false,"error":"命令行服务又在跑了，插件继续代理即可"}'); return; }
      await start({ mode: 'hosted', listen: false });
      local = true;
      webCtx.logger?.info?.('[agent-acta] 接手：hosted 就绪 v' + VERSION + ' (' + BUILD + ')');
      res.end('{"ok":true,"started":true}');
    };

    // EXTRA 那几条有自己的 handler，不能让 passthrough 先占位：core 没这些路由，passthrough 会答 404；
    // 而重复的 (kind,path) 在宿主里是 throw + **先注册的那条赢** ⇒ 真 handler 永远挂不上（302 那次就是这么坏的）。
    const extraHandlers = { [ENTRY_PATH]: entry, [ASSET_PATH]: asset, [TAKEOVER_PATH]: takeover };

    for (const s of hostedRouteSpecs()) {
      if (extraHandlers[s.path]) continue;
      reg(s.kind, s.path, api);
    }
    for (const p of HOSTED_EXTRA) reg('exact', p, extraHandlers[p]);

    // 面板入口不 302 到宿主 http 口：iframe 从 dsh-app:// 跳 http://127.0.0.1 是跨源，实测被拦（空白）。
    // 由 ENTRY_PATH 同源递 HTML（本机 hosted 那份或代理上游那份），页面里的静态引用统一翻译成 ASSET_PATH。
    webCtx.logger?.info?.('[agent-acta] 就绪 v' + VERSION + ' (' + BUILD + ')，路由 ' + registered.length + ' 条，'
      + (local ? '本机 hosted' : '代理 127.0.0.1:' + cliPort) + '，入口 ' + ENTRY_PATH);

    // 只有真起了 hosted 才需要收尾停掉它（代理那一支没起任何东西）
    web.effect(() => () => { if (local) stop('DSH 插件卸载'); });
  });
}
