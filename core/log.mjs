// 诊断行的唯一出口（2026-09-29 拆掉全局 console 补丁之后立的）。
//
// 原来 core/service.mjs 里有一行 `console.log = (...a) => console.error(...a)` —— 改的是**整个进程**
// 的 console 对象。MCP 里没问题（独立进程、stdout 是协议通道），但 DSH 插件一旦被加载，**宿主自己的**
// console.log 也跟着被我们改道到 stderr：宿主日志采集器会因此少掉全部 info 行。那是越界的副作用，
// 而且症状落在宿主身上（我们的代码一个字节没改，宿主的日志先少了一半），所以换成这个模块内的出口。
//
// 为什么是**单独一个叶子模块**，而不是 core/service.mjs 里的一个函数：parsers/ 下也要用它
//（mimocode 有 3 处 console.log），而 core/service.mjs 正是 import parsers 的那一方 ——
// 从 parsers 反向 import 它就成了循环依赖。这里零 import，谁都能用。
//
// 去向由 core/service.mjs 在模块体里定一次 —— 「被当库 import 还是当入口跑」的判据只有那一份
//（MODE 那一段，hosted 也是从那儿切过去的），两边各算一遍判据就会漂。规则：
//   cli  → stdout —— 终端体验与搬家前一致，--status / --doctor 的球与文字走原来的流
//   其余 → stderr —— lib 的 stdout 是 MCP over stdio 的**协议通道**（混进一行「[index] loaded 1234
//          states」就是一条解析不了的坏消息）；hosted 的 stdout 归宿主，插件往里写诊断行同样是污染。
//          日志在 stderr 里一行不少。
let toStderr = false;
export function routeLogsToStderr(on) { toStderr = !!on; }
export function log(...a) { if (toStderr) console.error(...a); else console.log(...a); }
