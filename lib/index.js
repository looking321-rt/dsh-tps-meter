/**
 * dsh-tps-meter 宿主半侧：把会话实时输出吞吐喂给页面里的浮窗。
 *
 * 数据链路（**实时通道 + 生命周期通道**）：
 *   `agent/assistant-stream`（模型每吐一个 chunk 一帧）
 *     → tracker（滑动窗口算 tok/s）   ← **实时 tok/s 与波形的主数据源**
 *   `session/event`（step/turn/tool/title 与 assistant/message 的精确 usage）
 *     → tracker（生命周期状态机 + 估算校正）
 *       → GET /dsh-tps/state.json（浮窗轮询）
 *   GET /dsh-tps/widget.js  +  webServer.tapIndex 注入，构成浮窗本体。
 *
 * 不注册投影、不写会话日志、不碰模型请求：纯读侧观测，卸载即净。
 *
 * @module dsh-tps-meter
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyStreamFrame, createRegistry } from './tracker.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDGET_FILE = path.join(PACKAGE_ROOT, 'lib', 'widget.js')

const SCRIPT_PATH = '/dsh-tps/widget.js'
const STATE_PATH = '/dsh-tps/state.json'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}
const JS_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** Cordis 插件名（同时是 loader 条目 id 与 profile insert 行的 name）。 */
export const name = 'dsh-tps-meter'

/** 依赖的服务：只需要能挂 HTTP 路由的 webServer。 */
export const inject = ['webServer']

/**
 * Host 头是否指向本机回环。DSH 只监听 127.0.0.1，正常访问的 Host 必是这几个；
 * 拦住其它 Host 是为了挡 DNS rebinding —— 恶意页面把自有域名解析到 127.0.0.1 后，
 * 请求就变成"同源"，能绕过 CORS 读走会话标题与工作目录。
 * @param {string|undefined} hostHeader - 请求的 Host 头。
 * @returns {boolean} 是否放行。
 */
function isLocalHost(hostHeader) {
  // 没有 Host 头（HTTP/1.0 客户端、测试桩）不构成 rebinding 风险，放行。
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return true
  let host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end > 0) host = host.slice(0, end + 1)
  } else if (host.indexOf(':') === host.lastIndexOf(':')) {
    const at = host.indexOf(':')
    if (at > 0) host = host.slice(0, at)
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/**
 * 只读端点守卫：非本机 Host → 403，非 GET/HEAD → 405。
 * @param {object} req - 请求对象。
 * @param {object} res - 响应对象。
 * @param {object} headers - 该端点的默认响应头。
 * @returns {boolean} true = 通过，可继续处理；false = 已回绝。
 */
function guard(req, res, headers) {
  const method = req?.method
  if (!isLocalHost(req?.headers?.host)) {
    res.writeHead(403, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dsh-tps-meter: host not allowed')
    return false
  }
  if (typeof method === 'string' && method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dsh-tps-meter: method not allowed')
    return false
  }
  return true
}

/**
 * 挂载插件：订阅会话事件流，注册浮窗资源与状态端点。
 * @param {object} ctx - 宿主 cordis 上下文。
 */
export function apply(ctx) {
  const registry = createRegistry()

  // 观察者绝不能把失败带进会话提交路径（firehose 是 fire-and-forget）。
  ctx.on('session/event', (session, event) => {
    try {
      registry.onEvent(session, event, Date.now())
    } catch (err) {
      try {
        ctx.logger?.warn?.('dsh-tps-meter: 事件处理失败: %s', String(err && err.message ? err.message : err))
      } catch (ignored) {}
    }
  })

  // **实时 token 流**：模型每吐一个 chunk 就有一帧，payload 是 `{ agent, frame }`。
  // 作用域路由解析器是 `args[0].agent`（dsh-scope/lib/invariant.js:10），
  // 而插件挂在应用根上下文、不在任何 agent 作用域内，因此**必须**传 `{ global: true }`，
  // 否则 Cordis 的 scope 过滤（cordis/lib/index.js:263）会把全部帧挡掉、收不到任何数据。
  // 官方同类订阅同样带 `{ global: true }`（dsh-api-session-controller/lib/index.js:1388、
  // lib/types/history.js:74）。这里刻意**不**做单 agent 过滤（官方 headless 那种
  // `if (subject !== agent) return`），因为浮窗要同时显示所有会话。
  ctx.on(
    'agent/assistant-stream',
    (payload) => {
      try {
        // 整个取值过程都在 try 内：宿主形状异常（payload 为 undefined 等）也不能冒泡，
        // 观察者的失败绝不允许影响会话提交路径。
        const session = payload?.agent?.session
        if (session === undefined || session === null) return
        registry.onFrame(session, payload.frame, Date.now())
      } catch (err) {
        try {
          ctx.logger?.warn?.('dsh-tps-meter: 实时帧处理失败: %s', String(err && err.message ? err.message : err))
        } catch (ignored) {}
      }
    },
    { global: true },
  )

  const disposers = []

  // 浮窗读的实时读数。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        if (!guard(req, res, JSON_HEADERS)) return
        const now = Date.now()
        let sessions = []
        try {
          sessions = registry.readings(now)
        } catch (err) {}
        const body = JSON.stringify({ ok: true, now, sessions })
        try {
          res.writeHead(200, JSON_HEADERS)
          res.end(body)
        } catch (err) {
          // 客户端提前断开（刷新页面/关标签）时写响应会抛，忽略即可。
        }
      },
    }),
  )

  // 浮窗脚本本体（每次读取磁盘，开发期改完刷新页面即可生效）。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: SCRIPT_PATH,
      handler: (req, res) => {
        if (!guard(req, res, JS_HEADERS)) return
        try {
          const source = fs.readFileSync(WIDGET_FILE, 'utf8')
          res.writeHead(200, JS_HEADERS)
          res.end(source)
        } catch (err) {
          try {
            res.writeHead(500, { ...JS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('dsh-tps-meter: widget.js unreadable: ' + String((err && err.message) || err))
          } catch (ignored) {}
        }
      },
    }),
  )

  // **桌面端注入（关键）**：DSH 桌面的 index.html 由 Electron 从
  // `@deepseek-ai/dsh-web-frontend/dist` 静态直供（app.asar 里 `dsh-app://`
  // 协议处理器对 `/`、`/index.html`、`/assets/*` 直接 serve 文件），
  // **不经过 webServer 的 HTTP 渲染**，所以下面的 `tapIndex` 在桌面端
  // 完全不触发、浮窗永远不出现（而端点仍正常 200，属静默失效）。
  //
  // 桌面端走的是 `collectIndexInjections()`（dsh-desktop-host/lib/index.js
  // 把结构化行经 boot IPC 交给页面侧 interpreter，前端 `case "script-src":
  // await n(o.src)` 动态加载）。必须在这里登记一行，桌面端才会加载浮窗脚本。
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    for (const row of table) {
      // 幂等：同一张注入表里不重复登记（collectIndexInjections 每次新建表）。
      if (row !== null && typeof row === 'object' && row.kind === 'script-src' && row.src === SCRIPT_PATH) return
    }
    table.push({ kind: 'script-src', placement: 'body', src: SCRIPT_PATH })
  })

  // HTTP 直连场景的注入（浏览器直接访问 19387 时走这里；桌面端不走）。
  // 只认 harness 自己的 index，避免污染其它 HTML。
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string') return html
      if (html.indexOf('__DSH_BOOT__') === -1) return html
      if (html.indexOf(SCRIPT_PATH) !== -1) return html
      const tag = `<script defer src="${SCRIPT_PATH}"></script>`
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', `${tag}</body>`)
      return html + tag
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {}
    }
  })
}
