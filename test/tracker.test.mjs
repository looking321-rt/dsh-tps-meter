/**
 * tracker 纯逻辑单测：token 估算、滑动窗口速度、步骤状态机、提供方 usage 校正、
 * 登记表过滤与排序。跑法：node --test test/ （在项目根）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvent,
  applyStreamFrame,
  createRegistry,
  createTracker,
  dirName,
  estimateTokens,
  expandStream,
  IDLE_MS,
  snapshot,
  streamUsageTokens,
  windowTps,
} from '../lib/tracker.js'

const SESSION = { id: 'session-test', header: { cwd: 'D:\\work\\demo-project' } }

function chunk(text, kind = 'text-delta') {
  return { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: kind, index: 0, text } } }
}

/**
 * 真实事件形状构造器（本机 DSH 0.2.0-rc.2）。
 *
 * `stream` 是**紧凑记录列表**：连续 delta 被压成 `text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks` 游程（`texts[]`/`args[]` + `dt[]`），其它 chunk 存成
 * `{type:'chunk',time,chunk}`。与真实会话日志逐字节同构。
 */
function rec(chunkBody, time = 1000) {
  return { type: 'chunk', time, chunk: chunkBody }
}
function textRun(index, texts, time0 = 1000, dt = null) {
  return { type: 'text-chunks', time0, index, dt: dt ?? texts.slice(1).map(() => 10), texts }
}
function reasoningRun(index, texts, time0 = 1000, dt = null) {
  return { type: 'reasoning-chunks', time0, index, dt: dt ?? texts.slice(1).map(() => 10), texts }
}
function toolRun(index, id, name, args, time0 = 1000, dt = null) {
  return { type: 'tool-call-chunks', time0, index, dt: dt ?? args.slice(1).map(() => 10), id, name, args }
}
function usageRec(outputTokens, inputTokens = 10) {
  return rec({ type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }, 2000)
}

/** 一条 assistant/message 事件（真实形状）。 */
function assistantMessage({ turn = 1, step = 1, stream = [], usage, time = 2000 }) {
  const data = { turn, step, stream, message: { role: 'assistant', content: [] } }
  if (usage !== undefined) data.usage = usage
  return { type: 'assistant/message', data, time }
}

/** 一条 assistant/attempt 事件（真实形状，失败尝试通常只有 usage+finish）。 */
function assistantAttempt({ turn = 1, step = 1, stream = [], usage, time = 2000 }) {
  const data = { turn, step, stream }
  if (usage !== undefined) data.usage = usage
  return { type: 'assistant/attempt', data, time }
}

test('estimateTokens：ASCII / CJK / 混合 / 空', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('你好世界'), 2.4)
  assert.ok(Math.abs(estimateTokens('hello 你好') - 2.7) < 1e-9)
  assert.equal(estimateTokens(null), 0)
})

test('dirName：取末级目录', () => {
  assert.equal(dirName('D:\\work\\demo-project'), 'demo-project')
  assert.equal(dirName('/home/me/proj'), 'proj')
  assert.equal(dirName(''), '')
  assert.equal(dirName(undefined), '')
})

test('滑动窗口：连续 chunk 的速度落在合理区间', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const start = 1_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: start }, start)
  let now = start
  // 每 100ms 一个 'abcd' chunk（≈1 token），共 10 个 → 约 10 tok/s
  for (let i = 0; i < 10; i += 1) {
    now += 100
    applyEvent(tr, chunk('abcd'), now)
  }
  const tps = windowTps(tr, now)
  assert.ok(tps > 8 && tps < 14, `tps=${tps}`)
})

test('状态机：waiting → streaming → done，并按精确 usage 记账', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 5_000
  applyEvent(tr, { type: 'step/start', data: { turn: 2, step: 3 }, time: t0 }, t0)
  assert.equal(tr.phase, 'waiting')

  let now = t0
  for (let i = 0; i < 5; i += 1) {
    now += 100
    applyEvent(tr, chunk('abcd'), now)
  }
  assert.equal(tr.phase, 'streaming')
  assert.equal(tr.firstTokenMs, t0 + 100)

  applyEvent(
    tr,
    { type: 'assistant/chunk', data: { turn: 2, step: 3, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 40 } } } },
    now,
  )
  assert.equal(tr.stepTokens, 40)

  now += 100
  applyEvent(
    tr,
    { type: 'assistant/message', data: { turn: 2, step: 3, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 40 } }, time: now },
    now,
  )
  assert.equal(tr.phase, 'done')
  assert.equal(tr.totalTokens, 40)
  assert.equal(tr.ttftMs, 100)
  assert.equal(tr.lastStepMs, 500)
  assert.ok(tr.lastStepTps > 75 && tr.lastStepTps < 85, `tps=${tr.lastStepTps}`)
  // 估算（5 token）与精确（40）差距大，校正系数应被拉高但受限幅
  assert.ok(tr.calibration > 1 && tr.calibration <= 3, `cal=${tr.calibration}`)
})

test('无 usage 的步：用估算值累计', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 9_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, chunk('abcdefgh'), t0 + 50)
  applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, time: t0 + 500 }, t0 + 500)
  assert.equal(tr.totalTokens, 2)
  assert.equal(tr.ttftMs, 50)
  // 解码 450ms 产出 2 token → 约 4.4 tok/s
  assert.ok(tr.lastStepTps > 4 && tr.lastStepTps < 5, `tps=${tr.lastStepTps}`)
})

test('解码时长过短的步不给平均速度（避免噪声）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 20_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, chunk('abcd'), t0 + 10)
  applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, time: t0 + 60 }, t0 + 60)
  assert.equal(tr.lastStepTps, null)
  assert.equal(tr.totalTokens, 1)
})

test('tool-call-delta 同样计入输出吞吐', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: 1000 }, 1000)
  applyEvent(tr, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{"path":"a"}' } } }, 1100)
  assert.equal(tr.phase, 'streaming')
  assert.ok(tr.streamEstTokens > 0)
})

test('readings：running 优先，空闲超时后 running=false', () => {
  const reg = createRegistry()
  const a = { id: 'a', header: { cwd: 'D:\\x\\proj-a' } }
  const b = { id: 'b', header: { cwd: 'D:\\x\\proj-b' } }
  const t0 = 100_000
  reg.onEvent(a, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(a, chunk('abcd'), t0 + 100)
  reg.onEvent(b, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 - 5000 }, t0 - 5000)
  reg.onEvent(b, chunk('abcd'), t0 - 4900)
  reg.onEvent(b, { type: 'turn/end', data: { turn: 1 }, time: t0 - 4000 }, t0 - 4000)

  const running = reg.readings(t0 + 200)
  assert.equal(running[0].id, 'a')
  assert.equal(running[0].running, true)
  assert.equal(running[0].dir, 'proj-a')

  const later = reg.readings(t0 + IDLE_MS + 500)
  assert.equal(later[0].running, false, '空闲超时后不再算 running')
  assert.equal(later.find((r) => r.id === 'b').phase, 'idle')
})

test('readings：整轮进行中（哪怕还没输出）也要显示，彻底空闲才让位', () => {
  const reg = createRegistry()
  const session = { id: 'noop', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 1000
  // 刚发消息、模型还在思考：没有任何 token，但整轮开着 → 必须出现在列表里
  reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } }, t0)
  const list = reg.readings(t0 + 200)
  assert.equal(list.length, 1)
  assert.equal(list[0].active, true)
  // 等待首 token 的窗口内 running 也是 true（1.5s 后自然回落），但 active 全程为真
  assert.equal(list[0].running, true)
  assert.equal(reg.readings(t0 + 5000)[0].running, false)

  // 整轮结束且全程零输出 → 不再占位
  reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: t0 + 500 }, t0 + 500)
  assert.equal(reg.readings(t0 + 600).length, 0)
  assert.equal(reg.count(), 1)
})

test('snapshot：字段形状与空值', () => {
  const tr = createTracker({ id: 's', cwd: 'D:\\x\\proj', now: 0 })
  const snap = snapshot(tr, 1000)
  assert.deepEqual(Object.keys(snap).sort(), [
    'active', 'avgMs', 'avgTps', 'calibration', 'cwd', 'dir', 'id', 'lastEventMs', 'lastStepTps', 'phase',
    'quietMs', 'running', 'step', 'stepMs', 'stepTokens', 'sub', 'title', 'toolActive', 'totalTokens', 'tps', 'ttftMs', 'turn',
  ])
  assert.equal(snap.running, false)
  assert.equal(snap.ttftMs, null)
  assert.equal(snap.sub, false)
  assert.equal(snap.avgTps, null)
  assert.equal(snap.title, '')
  assert.equal(snap.active, false)
  assert.equal(snap.toolActive, false)
})

test('整轮活动：turn 未结束就是 active（思考/跑工具空档里不能误判成已完成）', () => {
  const reg = createRegistry()
  const session = { id: 'busy', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 600_000
  reg.onEvent(session, { type: 'turn/start', data: { turn: 1 }, time: t0 }, t0)
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(session, chunk('abcd'), t0 + 50)

  const r = reg.readings(t0 + 100).find((x) => x.id === 'busy')
  assert.equal(r.active, true, 'turn 未结束 → active')
  assert.equal(r.toolActive, false)

  // 输出停了很久（思考 / 跑工具的空档）：running 会变 false，但 active 必须仍为 true
  const quiet = reg.readings(t0 + 60_000).find((x) => x.id === 'busy')
  assert.equal(quiet.running, false)
  assert.equal(quiet.active, true, '空档期不能算完成')

  // 工具执行中
  reg.onEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, time: t0 + 60_100 }, t0 + 60_100)
  assert.equal(reg.readings(t0 + 60_200).find((x) => x.id === 'busy').toolActive, true)
  reg.onEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'c1' } } }, time: t0 + 61_000 }, t0 + 61_000)
  assert.equal(reg.readings(t0 + 61_100).find((x) => x.id === 'busy').toolActive, false)

  // 整轮结束 → 才算完成
  reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: t0 + 62_000 }, t0 + 62_000)
  const done = reg.readings(t0 + 62_100).find((x) => x.id === 'busy')
  assert.equal(done.active, false)
  assert.equal(done.running, false)
})

test('会话标题：session/title 事件与历史折叠都能取到', () => {
  const reg = createRegistry()
  const session = { id: 'titled', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 500_000
  reg.onEvent(session, { type: 'session/title', data: { title: '修一下登录', source: { kind: 'auto' } }, time: t0 }, t0)
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(session, chunk('abcd'), t0 + 50)
  assert.equal(reg.readings(t0 + 100).find((r) => r.id === 'titled').title, '修一下登录')

  // 最新一条胜出
  reg.onEvent(session, { type: 'session/title', data: { title: '改标题了', source: { kind: 'user' } }, time: t0 + 200 }, t0 + 200)
  assert.equal(reg.readings(t0 + 300).find((r) => r.id === 'titled').title, '改标题了')

  // 插件挂载前就已存在的标题：从 session.events 折叠
  const old = { id: 'old', header: { cwd: 'D:\\x\\proj' }, events: [{ type: 'session/title', data: { title: '历史标题' } }] }
  reg.onEvent(old, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(old, chunk('abcd'), t0 + 50)
  const oldReading = reg.readings(t0 + 100).find((r) => r.id === 'old')
  assert.equal(oldReading.title, '历史标题')

  // 空标题不覆盖已有标题
  reg.onEvent(session, { type: 'session/title', data: { title: '   ' }, time: t0 + 400 }, t0 + 400)
  assert.equal(reg.readings(t0 + 500).find((r) => r.id === 'titled').title, '改标题了')
})

test('均速：生成中实时增长，结束后定格为最后一步平均', () => {
  const reg = createRegistry()
  const session = { id: 's', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 400_000
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  // 20 个 'abcd'（各 ≈1 token），每 100ms 一个 → 首 token 落在 t0+100
  let now = t0
  for (let i = 0; i < 20; i += 1) {
    now += 100
    reg.onEvent(session, chunk('abcd'), now)
  }
  const mid = reg.readings(now)[0]
  assert.ok(mid.avgTps > 8 && mid.avgTps < 13, `avgTps=${mid.avgTps}`)
  assert.ok(mid.avgMs >= 1800 && mid.avgMs <= 2000, `avgMs=${mid.avgMs}`)
  assert.ok(mid.tps > 8 && mid.tps < 13, `tps=${mid.tps}`)

  // 结算：提供方给 40 token → 均速切换为精确值 40 / 2.0s = 20 tok/s
  now += 100
  reg.onEvent(
    session,
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 5, outputTokens: 40 } }, time: now },
    now,
  )
  const done = reg.readings(now + 100)[0]
  assert.equal(done.running, false)
  assert.equal(done.tps, 0, '停下后实时速度归零')
  assert.equal(done.avgTps, done.lastStepTps)
  assert.ok(done.avgTps > 19 && done.avgTps < 21, `avgTps=${done.avgTps}`)
})

test('readings：主会话排在 subagent 子会话之前', () => {
  const reg = createRegistry()
  const main = { id: 'main', header: { cwd: 'D:\\x\\proj' } }
  const sub = { id: 'sub', header: { cwd: 'D:\\x\\proj', origin: 'subagent', delegationDepth: 1 } }
  const t0 = 300_000
  for (const s of [main, sub]) {
    reg.onEvent(s, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
    reg.onEvent(s, chunk('abcd'), t0 + 50)
  }
  const list = reg.readings(t0 + 100)
  assert.equal(list[0].id, 'main')
  assert.equal(list[0].sub, false)
  assert.equal(list[1].sub, true)
})

test('stepMs：本步结束后定格，不随空闲时间增长', () => {
  const reg = createRegistry()
  const session = { id: 's-steps', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 900_000
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  reg.onEvent(session, chunk('abcd'), t0 + 100)
  reg.onEvent(
    session,
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: { outputTokens: 4 } }, time: t0 + 600 },
    t0 + 600,
  )
  const soon = reg.readings(t0 + 1000)[0]
  const later = reg.readings(t0 + 600_000)[0]
  assert.equal(soon.stepMs, 600, '本步耗时 = 结束时刻 - 开始时刻')
  assert.equal(later.stepMs, 600, '空闲 10 分钟后仍是 600ms，不再膨胀')
})

// ---------------------------------------------------------------------------
// 真实事件形状（assistant/attempt | assistant/message + data.stream[]）
//
// 这组用例锁住 P0 修复：本机 DSH 0.2.0-rc.2 只发这两种事件，`assistant/chunk`
// 根本不存在；且 `stream` 是**该 attempt 的全量累计紧凑记录列表**（不是增量）。
// ---------------------------------------------------------------------------

test('expandStream：把紧凑游程展开成原始 chunk（与官方 expandAssistantStream 同构）', () => {
  const stream = [
    rec({ type: 'block-start', index: 0, blockType: 'text' }, 1000),
    textRun(0, ['Hel', 'lo ', 'world'], 1000, [5, 7]),
    reasoningRun(1, ['想', '一下'], 1200, [3]),
    toolRun(2, 'call_1', 'pwsh', ['{"a"', ':1}'], 1400, [2]),
    usageRec(42),
    rec({ type: 'finish', reason: { kind: 'stop' } }, 2000),
  ]
  assert.deepEqual(expandStream(stream), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo ' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'reasoning-delta', index: 1, text: '想' },
    { type: 'reasoning-delta', index: 1, text: '一下' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'pwsh', argumentsDelta: '{"a"' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'pwsh', argumentsDelta: ':1}' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 42, totalTokens: 52 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  // 非数组 / 空数组要稳
  assert.deepEqual(expandStream(undefined), [])
  assert.deepEqual(expandStream(null), [])
  assert.deepEqual(expandStream([]), [])
  // 未知记录类型忽略，不抛
  assert.deepEqual(expandStream([{ type: 'who-knows' }, null, 5]), [])
})

test('streamUsageTokens：取最后一个 usage chunk 的 outputTokens', () => {
  assert.equal(streamUsageTokens([textRun(0, ['a']), usageRec(7)]), 7)
  assert.equal(streamUsageTokens([usageRec(7), usageRec(9)]), 9, '最后一个胜出')
  assert.equal(streamUsageTokens([textRun(0, ['a'])]), null)
  assert.equal(streamUsageTokens(undefined), null)
  // usage chunk 缺 outputTokens → null（不误当 0）
  assert.equal(streamUsageTokens([rec({ type: 'usage', usage: { inputTokens: 3 } })]), null)
})

test('文本增量：assistant/message 的 stream 计入吞吐并触发 streaming', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 1_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  assert.equal(tr.phase, 'waiting')

  // 真实形状：一个 text-chunks 游程装若干 delta。
  // 先只喂 assistant/attempt（不结算）以便观察流式期的 phase 与窗口速度。
  applyEvent(
    tr,
    assistantAttempt({
      stream: [rec({ type: 'block-start', index: 0, blockType: 'text' }, t0 + 100), textRun(0, ['abcd', 'abcd', 'abcd'], t0 + 100, [100, 100])],
      time: t0 + 300,
    }),
    t0 + 300,
  )
  // 3 × 4 字符 ÷ 4 = 3 token
  assert.ok(Math.abs(tr.streamEstTokens - 3) < 1e-9, `est=${tr.streamEstTokens}`)
  assert.equal(tr.phase, 'streaming', '有内容就进入 streaming（修复前恒为 waiting/idle）')
  // 首 token 时刻取 stream 内嵌的首 delta 时间（t0+100），不是事件时间戳（t0+300）
  assert.equal(tr.firstTokenMs, t0 + 100)
  const w = windowTps(tr, t0 + 300)
  assert.ok(w > 0, `窗口速度必须大于 0（修复前恒为 0），实际 ${w}`)

  // 结算：估算值转入 stepTokens
  applyEvent(tr, assistantMessage({ stream: [textRun(0, ['abcd', 'abcd', 'abcd'], t0 + 100, [100, 100])], time: t0 + 400 }), t0 + 400)
  assert.equal(tr.phase, 'done')
  assert.ok(Math.abs(tr.stepTokens - 3) < 1e-9, `stepTokens=${tr.stepTokens}`)
  assert.equal(tr.totalTokens, 3)
})

test('reasoning 增量：只算 reasoning-delta，不重复算 block-end 的正文', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 2_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(
    tr,
    assistantMessage({
      stream: [
        rec({ type: 'block-start', index: 0, blockType: 'reasoning' }, t0 + 10),
        reasoningRun(0, ['你好', '世界'], t0 + 10, [10]), // 4 个宽字符 × 0.6 = 2.4
        // block-end 带同一段文本：不能重复计入
        rec({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '你好世界' } }, t0 + 30),
      ],
      time: t0 + 100,
    }),
    t0 + 100,
  )
  assert.ok(Math.abs(tr.stepTokens - 2.4) < 1e-9, `stepTokens=${tr.stepTokens}（block-end 不得重复计数）`)
  // 若把 block-end 的 4 个宽字符也算进去会得到 4.8
  assert.ok(tr.stepTokens < 3, '绝不能把 block-end 的已完成文本再算一遍')
})

test('tool-call 增量：argumentsDelta 计入吞吐', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 3_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(
    tr,
    assistantAttempt({
      stream: [
        rec({ type: 'block-start', index: 0, blockType: 'tool-call' }, t0 + 10),
        toolRun(0, 'call_x', 'pwsh', ['abcd', 'efgh'], t0 + 10, [10]), // 8 字符 ÷ 4 = 2
      ],
      time: t0 + 100,
    }),
    t0 + 100,
  )
  assert.ok(Math.abs(tr.streamEstTokens - 2) < 1e-9, `est=${tr.streamEstTokens}`)
  assert.equal(tr.phase, 'streaming', '工具调用参数也是模型输出，同样算吞吐')
})

test('usage 精确校正：data.usage 优先，缺失时回溯 stream 里的 usage chunk', () => {
  // A) assistant/message 自带 data.usage → 优先用它（而不是 stream 里的 99）
  const a = createTracker({ id: 'a', cwd: '', now: 0 })
  const ta = 4_000_000
  applyEvent(a, { type: 'step/start', data: { turn: 1, step: 1 }, time: ta }, ta)
  applyEvent(
    a,
    assistantMessage({
      stream: [textRun(0, ['abcdefgh'], ta + 10), rec({ type: 'usage', usage: { outputTokens: 99 } }, ta + 20)],
      usage: { inputTokens: 5, outputTokens: 40 },
      time: ta + 500,
    }),
    ta + 500,
  )
  assert.equal(a.stepTokens, 40, 'data.usage 优先于 stream 内的 usage chunk')
  assert.equal(a.totalTokens, 40)
  assert.ok(a.calibration > 1, `校正系数应被拉高，实际 ${a.calibration}`)

  // B) assistant/attempt 没有 data.usage → 回溯 stream 里的 usage chunk（真实形状）
  const b = createTracker({ id: 'b', cwd: '', now: 0 })
  const tb = 5_000_000
  applyEvent(b, { type: 'step/start', data: { turn: 1, step: 1 }, time: tb }, tb)
  applyEvent(
    b,
    assistantMessage({ stream: [textRun(0, ['abcdefgh'], tb + 10)], time: tb + 400 }),
    tb + 400,
  )
  assert.equal(b.totalTokens, 2, '无精确值 → 先用估算入账')

  const b2 = createTracker({ id: 'b2', cwd: '', now: 0 })
  applyEvent(b2, { type: 'step/start', data: { turn: 1, step: 1 }, time: tb }, tb)
  applyEvent(
    b2,
    assistantAttempt({ stream: [textRun(0, ['abcdefgh'], tb + 10), rec({ type: 'usage', usage: { outputTokens: 12 } }, tb + 20)], time: tb + 300 }),
    tb + 300,
  )
  assert.equal(b2.stepTokens, 12, 'attempt 要从 stream 里捞 usage')
  assert.equal(b2.exactStepTokens, 12)
  // attempt 携带了真实 delta，所以流式状态机照常推进（streaming），
  // 但绝不等于"本步组装完成"——phase 不能是 done（done 只由 assistant/message 产生）。
  assert.equal(b2.phase, 'streaming')
  assert.notEqual(b2.phase, 'done', 'attempt 不代表本步组装完成')
})

test('去重：同一份 stream 重复投递不得重复计数（含 assistant/message 重发）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 6_000_000
  const stream = [textRun(0, ['abcd', 'abcd'], t0 + 10, [10]), rec({ type: 'usage', usage: { outputTokens: 30 } }, t0 + 20)]
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)

  const ev = assistantMessage({ stream, usage: { outputTokens: 30 }, time: t0 + 500 })
  applyEvent(tr, ev, t0 + 500)
  const once = { est: tr.streamEstTokens, total: tr.totalTokens }

  // 同一份流再来 3 次（宿主重发 / 日志重放）
  for (let i = 0; i < 3; i += 1) applyEvent(tr, { ...ev, time: t0 + 600 + i * 100 }, t0 + 600 + i * 100)

  assert.equal(tr.totalTokens, once.total, `totalTokens 不得翻倍：${tr.totalTokens} vs ${once.total}`)
  assert.equal(tr.streamEstTokens, once.est, 'streamEstTokens 不得重复累加')
  assert.equal(tr.stepTokens, 30)
  assert.equal(tr.samples.reduce((n, s) => n + s.n, 0), 0, '收尾后样本已清空，重复投递不得再灌入')
})

test('去重：流变长时只计新增的尾部（逐步到达同一 step 的多个结算事件）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 7_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)

  // 第 1 次：2 个 'abcd' = 2 token
  applyEvent(tr, assistantAttempt({ stream: [textRun(0, ['abcd', 'abcd'], t0 + 10, [10])], time: t0 + 100 }), t0 + 100)
  assert.ok(Math.abs(tr.streamEstTokens - 2) < 1e-9, `est=${tr.streamEstTokens}`)

  // 第 2 次：同一 step 的流增长到 3 个（累计语义）→ 只应新增 1 token
  applyEvent(tr, assistantAttempt({ stream: [textRun(0, ['abcd', 'abcd', 'abcd'], t0 + 10, [10, 10])], time: t0 + 200 }), t0 + 200)
  assert.ok(Math.abs(tr.streamEstTokens - 3) < 1e-9, `est=${tr.streamEstTokens}（应为 3，不是 5）`)

  // 第 3 次：完全相同的流 → 不再新增
  applyEvent(tr, assistantAttempt({ stream: [textRun(0, ['abcd', 'abcd', 'abcd'], t0 + 10, [10, 10])], time: t0 + 300 }), t0 + 300)
  assert.ok(Math.abs(tr.streamEstTokens - 3) < 1e-9, `est=${tr.streamEstTokens}（重复投递必须 0 增量）`)
})

test('去重：流变短时保守处理，不回退也不倒扣', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 8_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, assistantAttempt({ stream: [textRun(0, ['abcd', 'abcd', 'abcd'], t0 + 10, [10, 10])], time: t0 + 100 }), t0 + 100)
  const before = tr.streamEstTokens
  applyEvent(tr, assistantAttempt({ stream: [textRun(0, ['abcd'], t0 + 10)], time: t0 + 200 }), t0 + 200)
  assert.equal(tr.streamEstTokens, before, '流变短不得倒扣')
  assert.equal(tr.streamConsumed, 3, '游标不回退')
})

test('去重游标：换 step 后重新计数（新的一步是新的一份流）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 9_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, assistantMessage({ stream: [textRun(0, ['abcd'], t0 + 10)], time: t0 + 100 }), t0 + 100)
  assert.equal(tr.stepTokens, 1, '第 1 步入账 1 token')

  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 2 }, time: t0 + 200 }, t0 + 200)
  applyEvent(tr, assistantMessage({ step: 2, stream: [textRun(0, ['abcd'], t0 + 210)], time: t0 + 300 }), t0 + 300)
  assert.equal(tr.stepTokens, 1, '新 step 的内容必须重新计入，不能被上一步的游标吃掉')
  assert.equal(tr.totalTokens, 2, '两步各 1 token')

  // 换轮之后同样按新的一步计数
  applyEvent(tr, { type: 'step/start', data: { turn: 2, step: 1 }, time: t0 + 400 }, t0 + 400)
  applyEvent(tr, assistantMessage({ turn: 2, stream: [textRun(0, ['abcd', 'abcd'], t0 + 410, [10])], usage: { outputTokens: 7 }, time: t0 + 500 }), t0 + 500)
  assert.equal(tr.stepTokens, 7)
  assert.equal(tr.totalTokens, 9, '累计 = 前两步估算 1+1 + 本步精确 7')
})

test('真实重试序列：失败 attempt（空 delta 流）→ 成功 message，不重复计数', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 10_000_000
  applyEvent(tr, { type: 'turn/start', data: { turn: 30 } }, t0)
  applyEvent(tr, { type: 'step/start', data: { turn: 30, step: 3 }, time: t0 }, t0)

  // 两次失败的 attempt：真实日志里只有 usage(0) + finish(error)，无任何 delta
  const failed = [rec({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, t0 + 10), rec({ type: 'finish', reason: { kind: 'error' } }, t0 + 20)]
  applyEvent(tr, assistantAttempt({ turn: 30, step: 3, stream: failed, time: t0 + 100 }), t0 + 100)
  applyEvent(tr, assistantAttempt({ turn: 30, step: 3, stream: failed, time: t0 + 200 }), t0 + 200)
  assert.equal(tr.streamEstTokens, 0, '失败尝试不含 delta')
  assert.equal(tr.totalTokens, 0, '失败尝试不得入账')
  assert.equal(tr.stepTokens, 0, 'outputTokens:0 不得覆盖')

  // 第三次成功：完整流 + 精确 usage
  applyEvent(
    tr,
    assistantMessage({
      turn: 30,
      step: 3,
      stream: [textRun(0, ['abcd', 'abcd'], t0 + 300, [10]), rec({ type: 'usage', usage: { outputTokens: 601 } }, t0 + 400)],
      usage: { inputTokens: 3557, outputTokens: 601 },
      time: t0 + 500,
    }),
    t0 + 500,
  )
  assert.equal(tr.stepTokens, 601)
  assert.equal(tr.totalTokens, 601, '整步只入账一次 601')
  assert.equal(tr.phase, 'done')
})

test('ttft 与实时速度：真实形状下确实产生非零读数（P0 回归）', () => {
  const reg = createRegistry()
  const session = { id: 'p0', header: { cwd: 'D:\\x\\proj' } }
  const t0 = 11_000_000
  reg.onEvent(session, { type: 'turn/start', data: { turn: 1 }, time: t0 }, t0)
  reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)

  // 真实形状：一个游程装 20 个 'abcd'（= 20 token），时间戳按 100ms 递增铺开
  const texts = Array.from({ length: 20 }, () => 'abcd')
  const dt = Array.from({ length: 19 }, () => 100)
  reg.onEvent(
    session,
    assistantMessage({ stream: [textRun(0, texts, t0 + 200, dt)], usage: { inputTokens: 5, outputTokens: 20 }, time: t0 + 2100 }),
    t0 + 2100,
  )

  const r = reg.readings(t0 + 2400).find((x) => x.id === 'p0')
  assert.ok(r, '会话必须出现在浮窗里')
  assert.ok(r.totalTokens > 0, `totalTokens 必须 > 0（修复前恒为 0），实际 ${r.totalTokens}`)
  assert.equal(r.totalTokens, 20)
  // 首 token 时刻来自 stream 内嵌时间戳（t0+200），不是结算事件时间戳（t0+2100）
  assert.equal(r.ttftMs, 200, 'TTFT 用内嵌的首 delta 时刻')
  // 解码窗口 = 首 delta(t0+200) → 末 delta(t0+2100)，共 1900ms，20 token ≈ 10.5 tok/s
  assert.ok(r.lastStepTps > 10 && r.lastStepTps < 11, `lastStepTps=${r.lastStepTps}`)
  assert.equal(r.avgMs, 1900, '解码时长 = 末 token - 首 token')
})

test('兼容性回归：旧运行时的 assistant/chunk 分支仍然生效', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 12_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyEvent(tr, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'abcd' } } }, t0 + 100)
  assert.ok(Math.abs(tr.streamEstTokens - 1) < 1e-9)
  assert.equal(tr.phase, 'streaming')
})

test('坏数据不得抛异常（宿主 firehose 容错）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 13_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  // stream 缺失 / 非数组 / 元素畸形 / usage 非数字 —— 一律安静跳过
  assert.doesNotThrow(() => {
    applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1 }, time: t0 }, t0)
    applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, stream: 'nope' }, time: t0 }, t0)
    applyEvent(tr, { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [null, 3, {}, { type: 'chunk' }, { type: 'chunk', chunk: null }] }, time: t0 }, t0)
    applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], usage: { outputTokens: 'NaN' } }, time: t0 }, t0)
    applyEvent(tr, { type: 'assistant/message', data: { turn: 1, step: 1, stream: [rec({ type: 'usage', usage: { outputTokens: -1 } })], usage: { outputTokens: -5 } }, time: t0 }, t0)
  })
  assert.equal(tr.streamEstTokens, 0)
  assert.equal(tr.totalTokens, 0, '非法 usage 不得入账')
})

// ---------------------------------------------------------------------------
// 实时通道：agent/assistant-stream（frame.type = start | chunk | end）
//
// 这是主数据源：模型每吐一个 chunk 触发一帧，`frame.chunk` 是原始分片，
// `frame.index` 是 attempt 内自增序号 → 天然增量、不会重复计数。
// ---------------------------------------------------------------------------

/** 造一帧实时流式事件里的 frame。 */
function frame(type, body = {}) {
  return { type, attemptId: 'a1', ...body }
}

test('实时帧：三种 frame.type 的状态机（start / chunk / end）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 20_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  assert.equal(tr.liveActive, false, '未开始前实时通道是关闭的')

  // start：开帧，重置帧级去重游标
  applyStreamFrame(tr, frame('start', { revision: 1, turn: 1, step: 1 }), t0 + 10)
  assert.equal(tr.liveActive, true)
  assert.equal(tr.liveFrameIndex, -1, '新 attempt 的 index 从 0 开始，游标要归零')

  // chunk：逐帧累加
  applyStreamFrame(tr, frame('chunk', { index: 0, time: t0 + 100, chunk: { type: 'text-delta', index: 0, text: 'abcd' } }), t0 + 100)
  assert.equal(tr.liveFrameIndex, 0)
  assert.ok(Math.abs(tr.streamEstTokens - 1) < 1e-9)

  // end：关帧，实时通道交接
  applyStreamFrame(tr, frame('end', { index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } }), t0 + 200)
  assert.equal(tr.liveActive, false)
  // end 帧只做交接，不改变已累计的 token
  assert.ok(Math.abs(tr.streamEstTokens - 1) < 1e-9)
})

test('实时帧：四路 chunk 分派（文本 / reasoning / tool-call / usage）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 21_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyStreamFrame(tr, frame('start', { turn: 1, step: 1 }), t0 + 5)

  // text-delta：4 ASCII 字符 = 1 token
  applyStreamFrame(tr, frame('chunk', { index: 0, time: t0 + 100, chunk: { type: 'text-delta', index: 0, text: 'abcd' } }), t0 + 100)
  // reasoning-delta：4 个宽字符 × 0.6 = 2.4
  applyStreamFrame(tr, frame('chunk', { index: 1, time: t0 + 200, chunk: { type: 'reasoning-delta', index: 1, text: '你好世界' } }), t0 + 200)
  // tool-call-delta：8 ASCII 字符 = 2
  applyStreamFrame(tr, frame('chunk', { index: 2, time: t0 + 300, chunk: { type: 'tool-call-delta', index: 2, id: 'c1', name: 'pwsh', argumentsDelta: 'abcdefgh' } }), t0 + 300)
  const beforeUsage = tr.streamEstTokens
  assert.ok(Math.abs(beforeUsage - (1 + 2.4 + 2)) < 1e-9, `est=${beforeUsage}`)
  assert.equal(tr.phase, 'streaming')

  // usage：只记精确值，不计估算
  applyStreamFrame(tr, frame('chunk', { index: 3, time: t0 + 400, chunk: { type: 'usage', usage: { outputTokens: 77 } } }), t0 + 400)
  assert.ok(Math.abs(tr.streamEstTokens - beforeUsage) < 1e-9, 'usage 不参与估算累加')
  assert.equal(tr.exactStepTokens, 77)
  assert.equal(tr.stepTokens, 77)

  // block-start / block-end / finish 都不产生吞吐
  applyStreamFrame(tr, frame('chunk', { index: 4, time: t0 + 500, chunk: { type: 'block-start', index: 0, blockType: 'text' } }), t0 + 500)
  applyStreamFrame(tr, frame('chunk', { index: 5, time: t0 + 600, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'abcd' } } }), t0 + 600)
  applyStreamFrame(tr, frame('chunk', { index: 6, time: t0 + 700, chunk: { type: 'finish', reason: { kind: 'stop' } } }), t0 + 700)
  assert.ok(Math.abs(tr.streamEstTokens - beforeUsage) < 1e-9, 'block-*/finish 不得计入')
})

test('实时帧：同 (attemptId,index) 重复投递不重复计数', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 22_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyStreamFrame(tr, frame('start', { turn: 1, step: 1 }), t0 + 5)

  const f0 = frame('chunk', { index: 0, time: t0 + 100, chunk: { type: 'text-delta', index: 0, text: 'abcd' } })
  const f1 = frame('chunk', { index: 1, time: t0 + 200, chunk: { type: 'text-delta', index: 0, text: 'abcd' } })
  applyStreamFrame(tr, f0, t0 + 100)
  applyStreamFrame(tr, f1, t0 + 200)
  assert.ok(Math.abs(tr.streamEstTokens - 2) < 1e-9)

  // 同一批帧重放（订阅重复 / 宿主重发）
  for (let i = 0; i < 3; i += 1) {
    applyStreamFrame(tr, f0, t0 + 100)
    applyStreamFrame(tr, f1, t0 + 200)
  }
  assert.ok(Math.abs(tr.streamEstTokens - 2) < 1e-9, `重复帧必须 0 增量，实际 ${tr.streamEstTokens}`)
  assert.equal(tr.liveFrameIndex, 1, '游标停在本 attempt 的最大 index')
})

test('双通道不重复计数：实时帧已供数时，结算快照不得再算一遍', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 23_000_000
  applyEvent(tr, { type: 'turn/start', data: { turn: 1 } }, t0)
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  applyStreamFrame(tr, frame('start', { turn: 1, step: 1 }), t0 + 5)

  const texts = Array.from({ length: 20 }, () => 'abcd')
  texts.forEach((t, i) => {
    applyStreamFrame(tr, frame('chunk', { index: i, time: t0 + 200 + i * 100, chunk: { type: 'text-delta', index: 0, text: t } }), t0 + 200 + i * 100)
  })
  applyStreamFrame(tr, frame('end', { index: 20, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } }), t0 + 2200)
  assert.ok(Math.abs(tr.streamEstTokens - 20) < 1e-9)

  // 结算事件带**全量快照**（同样的 20 个 delta）。若不去重就是 40。
  applyEvent(
    tr,
    assistantMessage({
      stream: [textRun(0, texts, t0 + 200, Array.from({ length: 19 }, () => 100)), rec({ type: 'usage', usage: { outputTokens: 20 } }, t0 + 2100)],
      usage: { inputTokens: 5, outputTokens: 20 },
      time: t0 + 2400,
    }),
    t0 + 2400,
  )

  const s = snapshot(tr, t0 + 2500)
  assert.equal(s.totalTokens, 20, `双通道叠加必须仍是 20，实际 ${s.totalTokens}`)
  assert.equal(s.stepTokens, 20)
  // 首 token 时刻来自实时帧（t0+200），解码窗口到末帧（t0+2100）→ 1900ms
  assert.equal(s.ttftMs, 200)
  assert.equal(s.avgMs, 1900)
  assert.ok(s.lastStepTps > 10 && s.lastStepTps < 11, `lastStepTps=${s.lastStepTps}`)
})

test('实时帧：跨 attempt 的 index 重置（重试后 index 从 0 重新开始）', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 24_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)

  // attempt 1：1 个 delta 后失败
  applyStreamFrame(tr, { type: 'start', attemptId: 'a1', turn: 1, step: 1 }, t0 + 5)
  applyStreamFrame(tr, { type: 'chunk', attemptId: 'a1', index: 0, time: t0 + 100, chunk: { type: 'text-delta', index: 0, text: 'abcd' } }, t0 + 100)
  applyStreamFrame(tr, { type: 'end', attemptId: 'a1', index: 1, outcome: { kind: 'abandoned' } }, t0 + 150)
  assert.ok(Math.abs(tr.streamEstTokens - 1) < 1e-9)

  // attempt 2：新的 attemptId，index 从 0 重新开始 → 必须被接受（不能因为 index<=旧游标被丢）
  applyStreamFrame(tr, { type: 'start', attemptId: 'a2', turn: 1, step: 1 }, t0 + 200)
  assert.equal(tr.liveFrameIndex, -1, '换 attempt 必须重置游标')
  applyStreamFrame(tr, { type: 'chunk', attemptId: 'a2', index: 0, time: t0 + 300, chunk: { type: 'text-delta', index: 0, text: 'abcd' } }, t0 + 300)
  assert.ok(Math.abs(tr.streamEstTokens - 2) < 1e-9, `新 attempt 的 index 0 必须被接受，实际 ${tr.streamEstTokens}`)
})

test('实时帧：坏数据不得抛异常', () => {
  const tr = createTracker({ id: 's', cwd: '', now: 0 })
  const t0 = 25_000_000
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: t0 }, t0)
  assert.doesNotThrow(() => {
    applyStreamFrame(tr, null, t0)
    applyStreamFrame(tr, undefined, t0)
    applyStreamFrame(tr, {}, t0)
    applyStreamFrame(tr, { type: 'weird' }, t0)
    applyStreamFrame(tr, frame('chunk'), t0)
    applyStreamFrame(tr, frame('chunk', { index: 0 }), t0)
    applyStreamFrame(tr, frame('chunk', { index: 0, chunk: null }), t0)
    applyStreamFrame(tr, frame('chunk', { index: 0, chunk: { type: 'usage', usage: { outputTokens: 'x' } } }), t0)
  })
  assert.equal(tr.streamEstTokens, 0)
})

