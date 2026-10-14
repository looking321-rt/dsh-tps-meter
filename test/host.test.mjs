/**
 * 宿主半侧集成冒烟：用假 cordis 上下文加载插件，走通
 * 「agent/assistant-stream 实时帧 + session/event → /dsh-tps/state.json」
 * 与「widget.js 资源 + 网页注入」。
 *
 * 注入部分同时覆盖两套机制：HTTP 直连走 `tapIndex`，而 DSH 桌面端走
 * `webserver/index-inject` 结构化行（桌面端 index.html 不经 HTTP 渲染）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

function fakeCtx() {
  const routes = new Map()
  const taps = []
  const listeners = new Map()
  const listenerOptions = new Map()
  const cleanups = []
  const ctx = {
    logger: { warn() {} },
    on(event, fn, options) {
      listeners.set(event, fn)
      listenerOptions.set(event, options)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    webServer: {
      register(def) {
        routes.set(def.path, def.handler)
        return () => routes.delete(def.path)
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {
          const at = taps.indexOf(fn)
          if (at >= 0) taps.splice(at, 1)
        }
      },
    },
  }
  return { ctx, routes, taps, listeners, listenerOptions, cleanups }
}

test('插件契约：名字与服务依赖', () => {
  assert.equal(name, 'dsh-tps-meter')
  assert.deepEqual(inject, ['webServer'])
})

test('state.json：走通事件 → 读数链路', () => {
  const { ctx, routes, listeners } = fakeCtx()
  apply(ctx)
  assert.ok(listeners.has('session/event'), '必须订阅会话事件 firehose')

  const fire = listeners.get('session/event')
  const session = { id: 'session-abc', header: { cwd: 'D:\\work\\demo-project' } }
  const t0 = Date.now()
  fire(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 })
  for (let i = 0; i < 10; i += 1) {
    fire(session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'abcd' } }, time: t0 + i * 50 })
  }

  const state = routes.get('/dsh-tps/state.json')
  assert.equal(typeof state, 'function')
  const res = fakeRes()
  state({ method: 'GET', url: '/dsh-tps/state.json' }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /application\/json/)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].id, 'session-abc')
  assert.equal(payload.sessions[0].dir, 'demo-project')
  assert.equal(payload.sessions[0].running, true)
  assert.ok(payload.sessions[0].tps > 0, `tps=${payload.sessions[0].tps}`)
})

test('state.json：无事件时是空列表而不是 500', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  routes.get('/dsh-tps/state.json')({}, res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).sessions, [])
})

test('widget.js：可读取且是浮窗源码', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  routes.get('/dsh-tps/widget.js')({}, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /javascript/)
  assert.ok(res.body.includes('__dshTpsMeter'), 'widget 应带自身守卫标记')
  assert.ok(res.body.includes('/dsh-tps/state.json'), 'widget 应轮询状态端点')
})

test('tapIndex：只注入 DSH 页面，且不重复注入', () => {
  const { ctx, taps } = fakeCtx()
  apply(ctx)
  assert.equal(taps.length, 1)
  const injectInto = taps[0]

  const dshHtml = '<html><head></head><body><div id="root"></div><script>globalThis["__DSH_BOOT__"]={}</script></body></html>'
  const once = injectInto(dshHtml)
  assert.ok(once.includes('<script defer src="/dsh-tps/widget.js"></script>'))
  assert.ok(once.indexOf('</body>') > once.indexOf('/dsh-tps/widget.js'))
  assert.equal(injectInto(once), once, '已注入过就不再重复')

  const otherHtml = '<html><body>hello</body></html>'
  assert.equal(injectInto(otherHtml), otherHtml)
})

test('state.json：非本机 Host 回 403（DNS rebinding 防护），本机 Host 放行', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)
  const state = routes.get('/dsh-tps/state.json')

  const denied = fakeRes()
  state({ method: 'GET', headers: { host: 'attacker.test' } }, denied)
  assert.equal(denied.status, 403)
  assert.ok(!denied.body.includes('"sessions"'), '403 不能带出会话数据')

  for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) {
    const res = fakeRes()
    state({ method: 'GET', headers: { host } }, res)
    assert.equal(res.status, 200, `host=${host} 应放行`)
  }
})

test('只读端点：非 GET/HEAD 回 405，widget.js 同样守 Host', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)

  const posted = fakeRes()
  routes.get('/dsh-tps/state.json')({ method: 'POST', headers: { host: '127.0.0.1:3080' } }, posted)
  assert.equal(posted.status, 405)
  assert.equal(posted.headers.Allow, 'GET, HEAD')

  const widget = fakeRes()
  routes.get('/dsh-tps/widget.js')({ method: 'GET', headers: { host: 'evil.example' } }, widget)
  assert.equal(widget.status, 403)

  const head = fakeRes()
  routes.get('/dsh-tps/state.json')({ method: 'HEAD', headers: { host: 'localhost:3080' } }, head)
  assert.equal(head.status, 200)
})

test('effect 清理：dispose 后路由与注入点都被撤掉', () => {
  const { ctx, routes, taps, cleanups } = fakeCtx()
  apply(ctx)
  assert.equal(routes.size, 2)
  assert.equal(taps.length, 1)
  for (const dispose of cleanups) dispose()
  assert.equal(routes.size, 0)
  assert.equal(taps.length, 0)
})

// ---------------------------------------------------------------------------
// 实时通道（agent/assistant-stream）
// ---------------------------------------------------------------------------

test('订阅契约：必须同时订阅 agent/assistant-stream 且带 { global: true }', () => {
  const { ctx, listeners, listenerOptions } = fakeCtx()
  apply(ctx)
  assert.ok(listeners.has('session/event'), '生命周期与精确 usage 走 session/event')
  assert.ok(listeners.has('agent/assistant-stream'), '实时 token 流走 agent/assistant-stream')
  // 缺了 global:true，Cordis 的作用域过滤会把插件（不在 agent 作用域内）的帧全部挡掉，
  // 插件会静默收不到任何数据 —— 这正是本 P0 的同类陷阱，用断言钉死。
  assert.deepEqual(listenerOptions.get('agent/assistant-stream'), { global: true })
})

test('实时帧 → state.json：逐 chunk 累加出非零 tok/s', () => {
  const { ctx, routes, listeners } = fakeCtx()
  apply(ctx)
  const fire = listeners.get('agent/assistant-stream')

  // 真实形状：payload 是 { agent, frame }，agent.session 提供会话标识
  const session = { id: 'live-1', header: { cwd: 'D:\\work\\live-proj' } }
  const agent = { session }
  const t0 = Date.now()
  listeners.get('session/event')(session, { type: 'turn/start', data: { turn: 1 }, time: t0 })
  listeners.get('session/event')(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 })

  fire({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  for (let i = 0; i < 10; i += 1) {
    fire({
      agent,
      frame: {
        type: 'chunk',
        attemptId: 'a1',
        revision: i + 2,
        index: i,
        time: t0 + i * 50,
        chunk: { type: 'text-delta', index: 0, text: 'abcd' },
      },
    })
  }

  const res = fakeRes()
  routes.get('/dsh-tps/state.json')({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.sessions.length, 1, '实时通道必须能把会话登记进浮窗')
  const row = payload.sessions[0]
  assert.equal(row.id, 'live-1')
  assert.equal(row.dir, 'live-proj')
  assert.equal(row.running, true)
  assert.ok(row.tps > 0, `实时 tok/s 必须 > 0（修复前恒为 0），实际 ${row.tps}`)

  // 终帧之后实时窗口关闭
  fire({ agent, frame: { type: 'end', attemptId: 'a1', revision: 99, index: 10, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } } })
  const live = JSON.parse(res.body)
  assert.ok(live.ok)
})

test('实时帧：同 (attemptId,index) 重复投递不得重复计数', () => {
  const { ctx, routes, listeners } = fakeCtx()
  apply(ctx)
  const fire = listeners.get('agent/assistant-stream')
  const session = { id: 'live-2', header: { cwd: 'D:\\x\\p' } }
  const agent = { session }
  const t0 = Date.now()
  listeners.get('session/event')(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)

  const frame = { type: 'chunk', attemptId: 'a1', index: 0, time: t0 + 10, chunk: { type: 'text-delta', index: 0, text: 'abcdefgh' } }
  fire({ agent, frame })
  fire({ agent, frame })
  fire({ agent, frame })

  // 结算事件带全量快照，但本步已由实时通道供数 → 不得再从快照重算一遍
  listeners.get('session/event')(
    session,
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: {}, usage: { outputTokens: 2 }, stream: [{ type: 'text-chunks', time0: t0 + 10, index: 0, dt: [], texts: ['abcdefgh'] }] },
      time: t0 + 300,
    },
    t0 + 300,
  )

  const res = fakeRes()
  routes.get('/dsh-tps/state.json')({ method: 'GET' }, res)
  const row = JSON.parse(res.body).sessions[0]
  assert.equal(row.totalTokens, 2, `只应按精确 usage 入账一次，实际 ${row.totalTokens}`)
  assert.equal(row.stepTokens, 2)
})

test('实时通道异常不得冒泡（宿主 firehose 容错）', () => {
  const { ctx, listeners } = fakeCtx()
  apply(ctx)
  const fire = listeners.get('agent/assistant-stream')
  const session = { id: 'live-3', header: { cwd: 'D:\\x\\p' } }
  assert.doesNotThrow(() => {
    fire({ agent: { session }, frame: null })
    fire({ agent: { session }, frame: { type: 'chunk' } })
    fire({ agent: { session }, frame: { type: 'chunk', chunk: null } })
    fire({ agent: { session }, frame: { type: 'weird' } })
    fire({}) // 没有 agent
    fire({ agent: {}, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } } })
    fire(undefined)
  })
})

// ── 桌面端注入契约 ────────────────────────────────────────────────────────
// DSH 桌面的 index.html 由 Electron 从 dsh-web-frontend/dist 静态直供，
// **不经过 webServer 的 HTTP 渲染**，因此 `tapIndex` 在桌面端永不触发。
// 桌面端只消费 `collectIndexInjections()`（dsh-desktop-host 经 boot IPC
// 交给页面侧 interpreter）。下面几条把这条契约钉死，防止再次静默失效。

test('桌面端注入：注册 webserver/index-inject，行形如 script-src', () => {
  const { ctx, listeners } = fakeCtx()
  apply(ctx)
  const collect = listeners.get('webserver/index-inject')
  assert.equal(
    typeof collect,
    'function',
    '桌面端只认 collectIndexInjections()；缺此订阅则浮窗在桌面端永不出现（而端点仍返回 200）',
  )
  const table = []
  collect(table)
  assert.equal(table.length, 1, `应恰好登记一行，实际 ${table.length}`)
  assert.deepEqual(table[0], {
    kind: 'script-src',
    placement: 'body',
    src: '/dsh-tps/widget.js',
  })
})

test('桌面端注入：同一张表重复收集保持幂等', () => {
  const { ctx, listeners } = fakeCtx()
  apply(ctx)
  const collect = listeners.get('webserver/index-inject')
  const table = []
  collect(table)
  collect(table)
  collect(table)
  assert.equal(table.length, 1, `同一张注入表只应有一行，实际 ${table.length}`)
})

test('桌面端注入：kind 必须在前端 interpreter 支持的集合内', () => {
  // dsh-web-frontend 的 boot 解释器只处理这几种 kind，其它一律 throw：
  //   switch (row.kind) { global | script | script-src | script-preload | style | html }
  // 且 script-src 走 `await loader(src)`（动态创建 <script>），故 widget.js
  // 作为普通 IIFE 脚本即可加载（无需是 ES module）。
  const SUPPORTED = new Set(['global', 'script', 'script-src', 'script-preload', 'style', 'html'])
  const { ctx, listeners } = fakeCtx()
  apply(ctx)
  const table = []
  listeners.get('webserver/index-inject')(table)
  for (const row of table) {
    assert.ok(SUPPORTED.has(row.kind), `前端不支持的注入 kind: ${row.kind}`)
  }
})

test('注入不重复：结构化行与 tapIndex 同时存在时只输出一份脚本标签', () => {
  const { ctx, taps } = fakeCtx()
  apply(ctx)
  // 服务端渲染会先写入结构化行，再跑 tapIndex 变换。
  const html =
    '<html><head><script>globalThis.__DSH_BOOT__={}</script></head>' +
    '<body><div id="root"></div><script src="/dsh-tps/widget.js"></script></body></html>'
  const out = taps[0](html)
  assert.equal(out.split('/dsh-tps/widget.js').length - 1, 1, '不得注入两份脚本标签')
})

test('注入兜底：HTTP 直连页面缺脚本时 tapIndex 仍能注入', () => {
  const { ctx, taps } = fakeCtx()
  apply(ctx)
  const html =
    '<html><head><script>globalThis.__DSH_BOOT__={}</script></head>' +
    '<body><div id="root"></div></body></html>'
  const out = taps[0](html)
  assert.ok(out.includes('/dsh-tps/widget.js'), 'HTTP 直连场景应仍可注入')
})
