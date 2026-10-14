/**
 * 浮窗渲染行为测试（客户端半侧）：用极简 DOM 桩在 vm 里跑 lib/widget.js，
 * 验证用户能直接看到的两件事 ——
 *   ① 多会话交替输出时，会话行的位置不会互相换位（宿主返回顺序抖动也不动）；
 *   ② "当前显示"的会话（绿字 + 大数字）不会在几个会话之间来回跳。
 * 跑法：node test/widget.test.mjs（或 node --test test/）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRegistry } from '../lib/tracker.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'), 'utf8')

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 一个刚好够 widget.js 跑起来的假元素。 */
function fakeEl() {
  const el = {
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    id: '',
    dataset: {},
    style: {},
    offsetWidth: 186,
    offsetHeight: 166,
    width: 332,
    height: 60,
    _attrs: {},
    _handlers: {},
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c)
      },
      remove(c) {
        this._set.delete(c)
      },
      contains(c) {
        return this._set.has(c)
      },
      toggle(c, on) {
        const next = on === undefined ? !this._set.has(c) : !!on
        if (next) this._set.add(c)
        else this._set.delete(c)
        return next
      },
    },
    addEventListener(type, fn) {
      ;(this._handlers[type] = this._handlers[type] || []).push(fn)
    },
    removeEventListener() {},
    appendChild(kid) {
      this._kids = this._kids || []
      this._kids.push(kid)
      kid.parentNode = this
      return kid
    },
    removeChild(kid) {
      if (this._kids) {
        const at = this._kids.indexOf(kid)
        if (at >= 0) this._kids.splice(at, 1)
      }
      kid.parentNode = null
      return kid
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v)
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null
    },
    hasAttribute() {
      return false
    },
    closest() {
      return null
    },
    getContext() {
      return { clearRect() {}, fillRect() {}, fillStyle: '' }
    },
  }
  return el
}

/** 搭一个 DOM 环境并把 widget.js 跑起来。 */
function startWidget() {
  const stubs = new Map()
  const docHandlers = {}
  const visibility = []

  const segments = ['live', 'avg'].map((mode) => {
    const el = fakeEl()
    el._attrs['data-mode'] = mode
    return el
  })

  // 同一个选择器始终返回同一个桩，这样 widget 写进去的内容测试读得到。
  const makeEl = () => {
    const el = fakeEl()
    el.querySelector = (sel) => {
      if (!stubs.has(sel)) stubs.set(sel, fakeEl())
      return stubs.get(sel)
    }
    el.querySelectorAll = () => segments
    return el
  }

  const document = {
    hidden: false,
    head: fakeEl(),
    body: fakeEl(),
    createElement: () => makeEl(),
    querySelector: () => null,
    addEventListener(type, fn) {
      ;(docHandlers[type] = docHandlers[type] || []).push(fn)
      if (type === 'visibilitychange') visibility.push(fn)
    },
  }

  const store = new Map()
  const env = {
    document,
    window: {
      innerWidth: 1280,
      innerHeight: 860,
      location: { reload() {} },
      addEventListener() {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  }

  let payload = { ok: true, sessions: [] }
  // 端点响应实现：默认回放 push() 推进来的读数，可由 setFetch 替换，
  // 用于模拟「插件已停用（404）」与「宿主临时故障（5xx）」两类失败。
  let fetchImpl = async () => ({ status: 200, ok: true, json: async () => payload })
  const sandbox = {
    window: env.window,
    document: env.document,
    localStorage: env.localStorage,
    fetch: (...args) => fetchImpl(...args),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'widget.js' })

  // widget 自己 createElement 出根节点并挂到 body —— 取回来当测试的观察窗口。
  const root = document.body._kids[0]
  env.root = root
  const sessionsEl = root.querySelector('.t-sessions')
  env.rows = () => Array.from(sessionsEl.innerHTML.matchAll(/data-id="([^"]+)"/g), (m) => m[1])
  env.selected = () => {
    const m = /class="t-sess on" data-id="([^"]+)"/.exec(sessionsEl.innerHTML)
    return m === null ? null : m[1]
  }
  /** 推一轮宿主读数（顺带触发一次轮询渲染）。 */
  env.push = async (sessions) => {
    payload = { ok: true, now: Date.now(), sessions }
    for (const fn of visibility) fn()
    await flush()
    await flush()
  }
  /** 替换端点响应实现（模拟停用 404 / 临时故障 5xx）。 */
  env.setFetch = (fn) => {
    fetchImpl = fn
  }
  /** 只触发一次轮询，不改变 payload。 */
  env.poll = async () => {
    for (const fn of visibility) fn()
    await flush()
    await flush()
  }
  return env
}

/** 造一条读数（只填与排序/选择相关的字段）。 */
function reading(id, { working = true, tps = 50, title = '' } = {}) {
  return {
    id,
    dir: id,
    cwd: 'D:\\work\\' + id,
    title,
    sub: false,
    phase: working ? 'streaming' : 'done',
    running: working,
    active: working,
    toolActive: false,
    tps,
    avgTps: tps,
    avgMs: 1000,
    stepTokens: 100,
    totalTokens: 2000,
    ttftMs: 500,
    lastStepTps: tps,
    turn: 1,
    step: 2,
    stepMs: 2000,
    quietMs: 100,
    lastEventMs: Date.now(),
    calibration: 1,
  }
}

test('行序稳定：宿主把同一批会话换个顺序返回，行不会上下换位', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  const first = ui.rows()
  assert.equal(first.length, 2, '两个会话都应显示')

  // 宿主排序按"谁刚吐 token"翻来覆去，这里反复交换顺序推送
  for (let i = 0; i < 6; i += 1) {
    const order = i % 2 === 0 ? [reading('b'), reading('a')] : [reading('a'), reading('b')]
    await ui.push(order)
    assert.deepEqual(ui.rows(), first, `第 ${i} 次轮询后行序应保持不变`)
  }
})

test('行序稳定：工作状态的会话恒在已完成之前，组内次序不受抖动影响', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  // a 闲下来：它掉到"已完成"组，b 仍在工作 → b 在前，且之后不再变
  await ui.push([reading('a', { working: false }), reading('b')])
  assert.deepEqual(ui.rows(), ['b', 'a'])
  for (let i = 0; i < 4; i += 1) {
    const order = i % 2 === 0 ? [reading('b'), reading('a', { working: false })] : [reading('a', { working: false }), reading('b')]
    await ui.push(order)
    assert.deepEqual(ui.rows(), ['b', 'a'], '组内位置应恒定')
  }
})

test('绿字不跳：没手动点选时，当前显示的会话咬住不放', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  const shown = ui.selected()
  assert.ok(shown === 'a' || shown === 'b', `应有选中项，实际 ${shown}`)

  // 另一个会话开始输出并被宿主排到最前 —— 显示项不许跟着换人
  for (let i = 0; i < 6; i += 1) {
    await ui.push(i % 2 === 0 ? [reading('b', { tps: 90 }), reading('a')] : [reading('a'), reading('b', { tps: 90 })])
    assert.equal(ui.selected(), shown, `第 ${i} 次轮询后绿字应仍是 ${shown}`)
  }
})

test('绿字不跳：被关闭的会话消失后，才回落到新的可用会话', async () => {
  const ui = startWidget()
  await ui.push([reading('a'), reading('b')])
  const shown = ui.selected()
  const other = shown === 'a' ? 'b' : 'a'

  // 只剩另一个会话（被关掉的 / 已下线的）→ 必须回落到它，不能空着
  await ui.push([reading(other)])
  assert.equal(ui.selected(), other)
})

test('空读数不炸：列表给占位、数字归零', async () => {
  const ui = startWidget()
  await ui.push([])
  assert.equal(ui.rows().length, 0)
  assert.ok(ui.root.querySelector('.t-sessions').innerHTML.includes('暂无会话输出'))
  assert.equal(ui.root.querySelector('.t-num').textContent, '0.0')
})

test('端到端：宿主按活跃度抖动排序时，浮窗行序与当前会话都纹丝不动', async () => {
  // ① 用真实 tracker 造「两个会话交替输出」的流量，取宿主真实返回的读数序列。
  //    宿主排序键是 running + lastEventMs，交替输出时两者都在变 → 顺序会抖，
  //    这正是用户看到的"位置上下浮动 + 绿字交替"的来源。
  const reg = createRegistry()
  const a = { id: 'session-aaaa1111', header: { cwd: 'D:\\work\\proj-a' } }
  const b = { id: 'session-bbbb2222', header: { cwd: 'D:\\work\\proj-b' } }
  const delta = () => ({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(400) } },
  })
  reg.onEvent(a, { type: 'turn/start', data: { turn: 1 } }, 5_000_000)
  reg.onEvent(b, { type: 'turn/start', data: { turn: 1 } }, 5_000_000)
  let now = 5_000_000
  const frames = []
  for (let i = 0; i < 12; i += 1) {
    reg.onEvent(i % 2 === 0 ? a : b, delta(), now)
    now += 400
    frames.push(reg.readings(now))
  }
  const hostOrders = new Set(frames.map((f) => f.map((r) => r.id).join(',')))
  assert.ok(hostOrders.size > 1, `宿主顺序应随活跃度变化（否则这个场景没造出抖动）：${[...hostOrders].join(' / ')}`)

  // ② 把这份抖动的数据原样喂给浮窗：行序与"当前显示"的会话都不许变。
  const ui = startWidget()
  const rows = []
  const shown = []
  for (const frame of frames) {
    await ui.push(frame)
    rows.push(ui.rows().join(','))
    shown.push(ui.selected())
  }
  assert.equal(new Set(rows).size, 1, `行序应恒定，实际出现 ${new Set(rows).size} 种：${[...new Set(rows)].join(' / ')}`)
  assert.equal(new Set(shown).size, 1, `当前显示的会话应恒定，实际出现 ${new Set(shown).size} 种：${[...new Set(shown)].join(' / ')}`)
})

test('跨工作区多会话：会话频繁进出列表（新会话加入 / 短暂消失重现）时，已有行不许被顶动', async () => {
  const ui = startWidget()
  const r = (id, dir, working = true) => reading(id, { working, title: id + '@' + dir })

  // 多工作区同时跑任务：s1/s2/s3 常驻，s2 中途短暂消失（整轮结束且零输出会被宿主过滤），
  // s4 中途加入（新工作区的新会话 / subagent）。
  const frames = [
    [r('s1', 'ws-a'), r('s2', 'ws-a'), r('s3', 'ws-b')],
    [r('s2', 'ws-a'), r('s1', 'ws-a'), r('s3', 'ws-b')], // 宿主顺序抖动
    [r('s1', 'ws-a'), r('s3', 'ws-b')], // s2 暂时消失
    [r('s3', 'ws-b'), r('s1', 'ws-a'), r('s2', 'ws-a')], // s2 回来
    [r('s1', 'ws-a'), r('s2', 'ws-a'), r('s3', 'ws-b'), r('s4', 'ws-c')], // s4 新加入
    [r('s4', 'ws-c'), r('s3', 'ws-b'), r('s2', 'ws-a'), r('s1', 'ws-a')],
    [r('s1', 'ws-a'), r('s3', 'ws-b'), r('s4', 'ws-c'), r('s2', 'ws-a')],
  ]

  const seen = []
  for (const frame of frames) {
    await ui.push(frame)
    seen.push(ui.rows())
  }

  // 浮窗只渲染前 3 行（MAX_ROWS），所以"被新会话挤出去"就是用户看到的跳。
  const resident = seen.filter((rows) => !rows.includes('s1') || !rows.includes('s3'))
  assert.equal(resident.length, 0, `常驻会话不该被挤出可见区，出问题的帧：${JSON.stringify(resident)}`)

  // s1 与 s3 全程都在：它俩的相对次序任何一轮都不许变。
  const pair = seen.map((rows) => rows.filter((id) => id === 's1' || id === 's3').join('>'))
  assert.equal(new Set(pair).size, 1, `常驻会话的相对次序应恒定，实际 ${[...new Set(pair)].join(' / ')}`)

  // s2 只是"消失了一帧"，回来必须回到原位（在 s1 之后、s3 之前），而不是被当成新会话插到最前。
  const back = seen[3]
  assert.equal(back.indexOf('s2') > back.indexOf('s1'), true, `s2 回归后应排在 s1 之后，实际 ${back.join(',')}`)
  assert.equal(back.indexOf('s2') < back.indexOf('s3'), true, `s2 回归后应回到 s3 之前，实际 ${back.join(',')}`)

  // s4 是新加入的：只能追加到队尾，不许把 s1/s2/s3 顶下去。
  const joined = seen[4]
  assert.equal(joined.join(','), 's1,s2,s3', `新会话应追加队尾（前 3 行仍是老会话），实际 ${joined.join(',')}`)
})

// ── 插件停用后的自清理 ──────────────────────────────────────────────────
// 宿主插件被停用/卸载后，`/dsh-tps/state.json` 会变 404。此前浮窗只会清空
// 数据、继续留在页面上（用户看到一个「打开但没数据」的空壳，只能重启 DSH
// 才能清掉）。下面把「停用即自行移除」以及「临时故障不得误删」钉死。

const notFoundRes = async () => ({ status: 404, ok: false, json: async () => ({}) })
const serverErrorRes = async () => ({ status: 503, ok: false, json: async () => ({}) })

test('插件停用（404）：浮窗自行移除，不留「打开但没数据」的空壳', async () => {
  const ui = startWidget()
  await ui.push([reading('a')])
  assert.equal(ui.rows().length, 1, '初始应显示会话行')
  assert.notEqual(ui.root.parentNode, null, '初始应挂在 body 上')

  ui.setFetch(notFoundRes)

  // 单次、两次 404 不足以判定（避开宿主重启等瞬时抖动）
  await ui.poll()
  await ui.poll()
  assert.notEqual(ui.root.parentNode, null, '未达阈值前不应移除浮窗')

  await ui.poll()
  assert.equal(ui.root.parentNode, null, '连续 3 次 404 后浮窗应自行移除')
})

test('宿主临时故障（5xx）：不得误删浮窗', async () => {
  const ui = startWidget()
  await ui.push([reading('a')])

  ui.setFetch(serverErrorRes)
  for (let i = 0; i < 6; i += 1) await ui.poll()

  assert.notEqual(
    ui.root.parentNode,
    null,
    '5xx 只说明宿主临时不可用（可能马上恢复），不应移除浮窗',
  )
})

test('404 后端点恢复：计数重置，浮窗保留', async () => {
  const ui = startWidget()
  await ui.push([reading('a')])

  ui.setFetch(notFoundRes)
  await ui.poll()
  await ui.poll()

  // 端点恢复（例如插件被重新启用且页面重载）→ notFound 归零
  ui.setFetch(async () => ({ status: 200, ok: true, json: async () => ({ ok: true, sessions: [reading('a')] }) }))
  await ui.poll()
  assert.notEqual(ui.root.parentNode, null, '恢复后浮窗应仍在')

  // 再次 404 时计数从头算：单次不足以移除
  ui.setFetch(notFoundRes)
  await ui.poll()
  assert.notEqual(ui.root.parentNode, null, '成功响应后计数应已重置')
})
