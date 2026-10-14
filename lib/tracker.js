/**
 * dsh-tps-meter 纯逻辑内核：把会话事件折成"实时输出吞吐"读数。
 *
 * 数据来源有**两条**通道（职责分离）：
 *
 * 1. `agent/assistant-stream`（**实时 token 流**，主数据源）
 *    模型每吐一个 chunk 就 emit 一帧，负载 `{ agent, frame }`，`frame.type` 为
 *    `start` | `chunk` | `end`，其中 `frame.chunk` 就是原始流式分片
 *    （text-delta / reasoning-delta / tool-call-delta / usage / finish …）。
 *    帧自带自增 `frame.index`，是**真正的增量**，天然不会重复计数——
 *    实时 tok/s 与波形都由它驱动。
 *
 * 2. `session/event`（**生命周期 + 精确 usage**）
 *    `turn/start`、`step/start`、`turn/end`、`session/title`、`tool/call`、`tool/result`
 *    以及 `assistant/message`（带提供方精确 usage，用来校正估算系数）。
 *
 * 另有一条**兼容**通道：旧运行时的 `assistant/chunk`（本机 DSH 0.2.0-rc.2
 * 已不存在，实测出现 0 次），保留以便在更老的宿主上仍能工作。
 *
 * 速度用滑动窗口算：窗口内估算 token 数 ÷ 窗口真实跨度，避免"整步平均"把
 * 首 token 等待时间也算进速度里。估算用固定启发式（ASCII 4 字符 ≈ 1 token，
 * 非 ASCII 字符 ≈ 0.6 token），再用每个已完成步骤的提供方 usage 做指数校正，
 * 因此显示值会随会话进行逐步贴近真实值。
 */

/** 滑动窗口长度（毫秒）：越小越"瞬时"，越大越平滑。 */
export const WINDOW_MS = 2000
/** 窗口真实跨度的下限（毫秒）：刚起步时避免用极短跨度外推出爆表数字。 */
export const MIN_SPAN_MS = 300
/** 距最后一次流式分片超过该时长即视为"已停止输出"（毫秒）。 */
export const IDLE_MS = 1500
/** 无事件超过该时长的会话从登记表中回收（毫秒）。 */
export const TRACKER_TTL_MS = 30 * 60 * 1000
/** 单会话保留的原始样本上限（防止极长输出导致数组无限增长）。 */
const MAX_SAMPLES = 4000

/** ASCII 字符每 token 字符数（英文粗略 4 字符 ≈ 1 token）。 */
const ASCII_PER_TOKEN = 4
/** 非 ASCII 字符（CJK 等）每字符 token 数。 */
const WIDE_PER_CHAR = 0.6

/**
 * 估算一段流式文本的 token 数。
 * @param {string} text - 增量文本。
 * @returns {number} 估算 token 数（非负）。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x80) ascii += 1
    else wide += 1
  }
  return ascii / ASCII_PER_TOKEN + wide * WIDE_PER_CHAR
}

/**
 * 取 cwd 的末级目录名做显示名。
 * @param {string|undefined} cwd - 会话工作目录。
 * @returns {string} 显示用短名。
 */
export function dirName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0)
  return parts.length === 0 ? cwd : parts[parts.length - 1]
}

/**
 * 新建一个会话追踪器。
 * @param {{ id: string, cwd?: string, sub?: boolean, title?: string, now: number }} meta - 会话标识与初始时间。
 * @returns {object} 追踪器状态。
 */
export function createTracker({ id, cwd, sub = false, title = '', now }) {
  return {
    id,
    cwd: cwd ?? '',
    dir: dirName(cwd),
    /** 会话标题（来自 dsh-session-title 的 `session/title` 事件）。 */
    title,
    /** 是否是 subagent 子会话（浮窗排序时让位于主会话）。 */
    sub,
    /** 是否有一轮正在进行（turn/start 已发生、turn/end 未发生）：思考与跑工具期间也为真。 */
    turnOpen: false,
    /** 尚未返回结果的工具调用 id（用来把状态行区分为"工具执行中"）。 */
    toolCalls: new Set(),
    createdAt: now,
    turn: 0,
    step: 0,
    /** idle | waiting（已发请求未见首 token）| streaming | done（本步已结束） */
    phase: 'idle',
    stepStartMs: 0,
    /** 本步结束时刻（0 = 尚未结束，stepMs 继续随时间增长）。 */
    stepEndMs: 0,
    firstTokenMs: 0,
    /** 本步最后一个 delta 的原始时刻（0 = 尚无）：用来圈定真实解码窗口的右端点。 */
    lastTokenMs: 0,
    /** 新路径（结算事件 stream）里最后一个 delta 的原始时刻，0 = 本步未走新路径。 */
    streamEndMs: 0,
    /** 实时通道（agent/assistant-stream）是否正在接收帧。 */
    liveActive: false,
    /** 实时通道当前 attempt 的 id 与已处理到的帧序号（帧级去重）。 */
    liveAttemptId: '',
    liveFrameIndex: -1,
    /** 本步是否已由实时通道提供过 token（有则结算事件的 stream 不再重复计入）。 */
    liveTokensThisStep: false,
    /** 当前窗口样本：{ t, n } */
    samples: [],
    /** 当前步骤的估算输出 token 累计。 */
    streamEstTokens: 0,
    /** 去重游标所在的 (turn, step)：结算事件的 `stream` 是全量快照，换步才重置。 */
    streamTurn: -1,
    streamStep: -1,
    /** 当前步的 `stream` 已消费到第几个展开 chunk（防止同一份流被重复累加）。 */
    streamConsumed: 0,
    /** 已被 `assistant/message` 收尾入账过的步骤键（`turn/step`），保证收尾幂等。 */
    settledStepKey: '',
    /** 当前步骤最后显示的 token 数（精确值优先）。 */
    stepTokens: 0,
    /** 提供方上报的当前步骤输出 token（有则优先）。 */
    exactStepTokens: null,
    /** 会话累计输出 token（精确值优先，缺则用估算校正值）。 */
    totalTokens: 0,
    /** 最近一步的首 token 延迟（毫秒），null 表示尚无。 */
    ttftMs: null,
    /** 最近一步的解码时长（毫秒）与平均速度。 */
    lastStepMs: null,
    lastStepTps: null,
    /** 估算→精确 的校正系数（EMA），完成后由精确 usage 收敛。 */
    calibration: 1,
    /** 实时窗口速度（每次事件更新）。 */
    lastTps: 0,
    lastEventMs: now,
  }
}

/** 把样本裁剪到窗口的两倍长度以内。 */
function pruneSamples(tr, now) {
  const keepFrom = now - WINDOW_MS * 2
  let cut = 0
  while (cut < tr.samples.length && tr.samples[cut].t < keepFrom) cut += 1
  if (cut > 0) tr.samples.splice(0, cut)
  if (tr.samples.length > MAX_SAMPLES) tr.samples.splice(0, tr.samples.length - MAX_SAMPLES)
}

/**
 * 计算窗口内实时速度。
 * @param {object} tr - 追踪器。
 * @param {number} now - 当前时间戳。
 * @param {number} [windowMs] - 窗口长度。
 * @returns {number} tok/s（无样本时为 0）。
 */
export function windowTps(tr, now, windowMs = WINDOW_MS) {
  const from = now - windowMs
  let sum = 0
  let oldest = null
  let newest = 0
  for (const s of tr.samples) {
    if (s.t < from) continue
    sum += s.n
    if (oldest === null) oldest = s.t
    newest = s.t
  }
  if (sum <= 0 || oldest === null) return 0
  // 用样本真实跨度（而非整个窗口）当分母：窗口还没铺满时才算得准。
  const span = Math.max(Math.max(newest, now) - oldest, MIN_SPAN_MS)
  return sum / (span / 1000)
}

/** 记一次 token 增量：入窗口 + 更新步骤估算。 */
function pushTokens(tr, tokens, now) {
  if (tokens <= 0) return
  tr.samples.push({ t: now, n: tokens })
  tr.streamEstTokens += tokens
  tr.lastEventMs = now
  pruneSamples(tr, now)
  if (tr.firstTokenMs === 0) tr.firstTokenMs = now
  tr.phase = 'streaming'
}

/**
 * 展开 `assistant/attempt` / `assistant/message` 的 `data.stream`，逐个吐出原始 chunk。
 *
 * **`stream` 的语义（已按本机 DSH 0.2.0-rc.2 实测确认）**
 *
 * `stream` 不是"本次新增的 chunk"，而是**该 attempt 完整、累积、已密封的紧凑记录列表**，
 * 在 attempt 结束时一次性打包进事件。依据：
 *  1. `dsh-agent-loop/lib/index.js:449` —— `get stream() { return [...this.accumulator.snapshot()] }`，
 *     每次读取都返回累加器**全量快照**；`settle()` 在 append 时取的就是这份全量。
 *  2. `dsh-llm/lib/types/assistant-stream.js:31` —— `AssistantStreamAccumulator` 把连续 delta
 *     压成 `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 游程（`texts[]`/`args[]` + `dt[]`），
 *     其它 chunk 原样存成 `{type:'chunk',time,chunk}`。所以元素**不一定**是 chunk 本身。
 *  3. 本机真实会话日志（`~/.dsh/sessions/` 下的 `session.v3.jsonl.zstd`，解压后 3769 行事件）实测：
 *     `assistant/attempt` + `assistant/message` 合计 644 条，`stream` 元素类型分布为
 *     `{chunk:4142, reasoning-chunks:376, tool-call-chunks:748, text-chunks:305}`；
 *     而 `assistant/chunk` 事件数为 **0**。
 *
 * 因此消费方必须像官方 `expandAssistantStream` 一样先"展开游程"，且这些 chunk 是
 * **整个 attempt 的累计**——同一 attempt 重复投递时会拿到完全相同的列表。
 *
 * @param {any} stream - 事件的 `data.stream`。
 * @returns {Array<object>} 展开后的原始 chunk 序列（`stream` 非法时为空数组）。
 */
export function expandStream(stream) {
  return expandTimedStream(stream).map((entry) => entry.chunk)
}

/**
 * 同 {@link expandStream}，但为每个 chunk 还原它**原始的产生时刻**。
 *
 * 紧凑游程把时间压成 `time0` + `dt[]`（相邻 delta 的毫秒增量），这正是为了在
 * 结算事件里保住真实的流式时间线（见官方 `expandAssistantStream` 的同一还原逻辑）。
 * 里程碑值就藏在里面：
 *  - 第一个 delta 的 time  → 首 token 时刻（真实 TTFT）
 *  - 最后一个 delta 的 time → 解码结束时刻（真实解码时长）
 *
 * 注意：结算事件本身是**整步结束后一次性到达**的，若只用事件时间戳当首 token 时刻，
 * TTFT 会退化成"整步耗时"，实时速度也就无从谈起。所以这里必须用内嵌时间。
 *
 * @param {any} stream - 事件的 `data.stream`。
 * @returns {Array<{ chunk: object, time: number|null }>} 带时间的 chunk 序列。
 */
export function expandTimedStream(stream) {
  if (!Array.isArray(stream)) return []
  const out = []
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      // 未经压缩的原始 chunk：{ type:'chunk', time, chunk }。
      if (record.chunk !== null && typeof record.chunk === 'object') {
        out.push({ chunk: record.chunk, time: typeof record.time === 'number' ? record.time : null })
      }
      continue
    }
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      const texts = Array.isArray(record.texts) ? record.texts : []
      const kind = record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta'
      let time = typeof record.time0 === 'number' ? record.time0 : null
      const dt = Array.isArray(record.dt) ? record.dt : []
      for (let i = 0; i < texts.length; i += 1) {
        if (i > 0 && time !== null && typeof dt[i - 1] === 'number') time += dt[i - 1]
        out.push({ chunk: { type: kind, index: record.index, text: texts[i] }, time })
      }
      continue
    }
    if (record.type === 'tool-call-chunks') {
      const args = Array.isArray(record.args) ? record.args : []
      let time = typeof record.time0 === 'number' ? record.time0 : null
      const dt = Array.isArray(record.dt) ? record.dt : []
      for (let i = 0; i < args.length; i += 1) {
        if (i > 0 && time !== null && typeof dt[i - 1] === 'number') time += dt[i - 1]
        out.push({
          chunk: { type: 'tool-call-delta', index: record.index, id: record.id, name: record.name, argumentsDelta: args[i] },
          time,
        })
      }
    }
  }
  return out
}

/**
 * 把一条 chunk 折算成"这一份内容值多少 token"。
 * 只认增量类的 chunk；`usage` / `finish` / `block-*` 不计入估算（usage 走精确通道）。
 * @param {object} chunk - 展开后的原始 chunk。
 * @returns {number} 估算 token 数（0 = 该 chunk 不产生吞吐）。
 */
function chunkTokens(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return estimateTokens(chunk.text)
  if (chunk.type === 'tool-call-delta') return estimateTokens(chunk.argumentsDelta)
  return 0
}

/**
 * 处理一条原始流式 chunk：估算类计入窗口，`usage` 类记为精确值。
 * 这是**新旧两条通道共用**的分派逻辑（`agent/assistant-stream` 的 `frame.chunk`
 * 与旧 `assistant/chunk` 的 `data.chunk` 形状完全一致）。
 * @param {object} tr - 追踪器（原地更新）。
 * @param {object} chunk - 原始流式 chunk。
 * @param {number} stamp - 该 chunk 的时间戳。
 * @returns {boolean} 是否产生了吞吐增量。
 */
export function consumeChunk(tr, chunk, stamp) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    const tokens = estimateTokens(chunk.text)
    if (tokens <= 0) return false
    pushTokens(tr, tokens * tr.calibration, stamp)
    return true
  }
  if (chunk.type === 'tool-call-delta') {
    const tokens = estimateTokens(chunk.argumentsDelta)
    if (tokens <= 0) return false
    pushTokens(tr, tokens * tr.calibration, stamp)
    return true
  }
  if (chunk.type === 'usage') {
    const out = chunk.usage?.outputTokens
    if (typeof out === 'number' && Number.isFinite(out) && out >= 0) {
      tr.exactStepTokens = out
      tr.stepTokens = out
    }
    return false
  }
  return false
}

/**
 * 处理一帧实时 `agent/assistant-stream` 里的 chunk，并标记本步已由实时通道供数。
 * @param {object} tr - 追踪器。
 * @param {object} chunk - 帧里的原始 chunk。
 * @param {number} stamp - 帧时间戳。
 * @returns {boolean} 是否产生吞吐增量。
 */
function consumeLiveChunk(tr, chunk, stamp) {
  const added = consumeChunk(tr, chunk, stamp)
  if (added) tr.liveTokensThisStep = true
  return added
}

/**
 * 应用一帧 `agent/assistant-stream` 事件。
 *
 * 这是**实时主数据源**：`frame.type` 为 `start` | `chunk` | `end`，
 * `frame.chunk` 即原始分片；`frame.index` 是本 attempt 内自增的帧序号。
 *
 * 去重依据：该通道**本身就是增量**（模型每吐一个 chunk 触发一帧），
 * 每个 chunk 恰好出现一次。这里仍用 `(attemptId, index)` 兜一层：
 * 宿主若因订阅重复/重放把同一帧投递两次，第二次会被丢弃，保证不重复计数。
 * 旧的 `session/event` 全量快照路径与它互斥（同一宿主只走其中一条）。
 *
 * @param {object} tr - 追踪器（原地更新）。
 * @param {{ type?: string, index?: number, attemptId?: string, time?: number, chunk?: object }} frame - 流式帧。
 * @param {number} now - 回退时间戳（帧未带 time 时用）。
 * @returns {object} 同一个追踪器。
 */
export function applyStreamFrame(tr, frame, now) {
  if (frame === null || typeof frame !== 'object') return tr
  const stamp = typeof frame.time === 'number' && frame.time > 0 ? frame.time : now

  if (frame.type === 'end') {
    // 终帧：本 attempt 结束。标记实时通道已交接，避免随后的 assistant/message
    // 再用全量 stream 把同一批内容重复计一遍。
    tr.liveActive = false
    tr.liveAttemptId = ''
    return tr
  }
  if (frame.type === 'start') {
    // 开帧：即将开始新的 attempt。重置帧级去重游标（新一轮的 index 从 0 开始）。
    tr.liveActive = true
    tr.liveAttemptId = typeof frame.attemptId === 'string' ? frame.attemptId : ''
    tr.liveFrameIndex = -1
    return tr
  }
  if (frame.type !== 'chunk') return tr

  // 帧级去重：同一 (attemptId, index) 只处理一次。
  const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : tr.liveAttemptId
  const index = typeof frame.index === 'number' ? frame.index : null
  if (index !== null) {
    if (attemptId !== tr.liveAttemptId) {
      tr.liveAttemptId = attemptId
      tr.liveFrameIndex = -1
    }
    if (index <= tr.liveFrameIndex) return tr
    tr.liveFrameIndex = index
  }

  tr.liveActive = true
  const added = consumeLiveChunk(tr, frame.chunk, stamp)
  // 实时通道同样记录末 token 时刻，供收尾时圈定真实解码窗口
  // （否则解码窗口会退化成"到结算事件为止"，把平均速度算飞）。
  if (added && stamp > tr.streamEndMs) tr.streamEndMs = stamp
  tr.lastEventMs = Math.max(tr.lastEventMs, stamp)
  return tr
}

/**
/**
 * 从 `stream` 里取提供方上报的精确输出 token（最后一个 `usage` chunk 胜出）。
 * 与官方 `lastAssistantStreamChunk(stream,'usage')` 的取法一致。
 * @param {any} stream - 事件的 `data.stream`。
 * @returns {number|null} outputTokens；没有合法值时返回 null。
 */
export function streamUsageTokens(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record?.type !== 'chunk' || record.chunk?.type !== 'usage') continue
    const out = record.chunk.usage?.outputTokens
    if (typeof out === 'number' && Number.isFinite(out) && out >= 0) return out
    return null
  }
  return null
}

/**
 * 把一条 attempt 结算事件的 `stream` 计入吞吐，**并保证同一 (turn, step) 的同一份内容只计一次**。
 *
 * 去重依据：`stream` 是该 attempt 的全量累计快照（见 {@link expandStream} 的论证）。
 * 但一次 `step` 可能被投递多条结算事件——本机实测有 32 个 step 出现
 * `assistant/attempt`(可多条) + `assistant/message`。此时**不能**逐条累加。
 *
 * 实测规律（同一真实日志）：失败的 attempt 其 `stream` 只含 `usage(0)` + `finish(error)`，
 * 即**不含任何 delta**；真正的 delta 只在最后成功的那条 `assistant/message` 里出现一次。
 * 所以"按 (turn,step) 记住已消费的 delta 长度、后续只取超出部分"既不丢首字，
 * 也不会把重试/重复投递算两遍：失败 attempt 贡献 0，成功 message 一次性补齐。
 *
 * 极端情况下同一 step 的后续结算事件带有**更短**的流（理论上不应发生），
 * 此时按"不回退"处理，只取 `[已消费, 本次长度)` 的增量，绝不为负。
 *
 * @param {object} tr - 追踪器（原地更新）。
 * @param {object} data - 事件负载（含 turn/step/stream/usage）。
 * @param {number} stamp - 事件时间戳。
 * @param {boolean} [skipTokens] - true 时只推进去重游标、不计 token
 *   （本步内容已由实时 `agent/assistant-stream` 通道逐帧计入，避免重复计数）。
 * @returns {number} 本次真正新计入的估算 token 数。
 */
function consumeStream(tr, data, stamp, skipTokens = false) {
  const stream = data.stream
  if (!Array.isArray(stream)) return 0

  const turn = typeof data.turn === 'number' ? data.turn : tr.turn
  const step = typeof data.step === 'number' ? data.step : tr.step
  // 换到新的 (turn, step) → 重置去重游标（这是"本步"的全新一份流）。
  if (turn !== tr.streamTurn || step !== tr.streamStep) {
    tr.streamTurn = turn
    tr.streamStep = step
    tr.streamConsumed = 0
  }

  const chunks = expandTimedStream(stream)
  // 只取"本次比已消费部分多出来"的尾部，避免全量重复累加。
  const from = Math.min(tr.streamConsumed, chunks.length)
  if (tr.streamConsumed > chunks.length) {
    // 流变短：保守地认为位置没变，不重放、也不回退游标。
    return 0
  }
  tr.streamConsumed = chunks.length
  if (skipTokens) return 0

  let added = 0
  for (let i = from; i < chunks.length; i += 1) {
    const tokens = chunkTokens(chunks[i].chunk)
    if (tokens <= 0) continue
    // 用 chunk 的**原始时间戳**入窗口：结算事件是整步结束后一次性到达的，
    // 若统一用事件时间戳，所有样本会挤在同一瞬间，实时波形与 TTFT 全部失真。
    // 内嵌时间可缺失，缺失时退回事件时间戳。
    const at = chunks[i].time !== null ? chunks[i].time : stamp
    pushTokens(tr, tokens * tr.calibration, at)
    // 记录新路径下最后一个 delta 的原始时刻，供收尾时圈定真实解码窗口。
    if (chunks[i].time !== null && chunks[i].time > tr.streamEndMs) tr.streamEndMs = chunks[i].time
    added += tokens
  }
  return added
}

/**
 * 应用一条会话事件。
 * @param {object} tr - 追踪器（原地更新）。
 * @param {{ type: string, data?: any, time?: number }} event - 会话事件。
 * @param {number} now - 当前时间戳。
 * @returns {object} 同一个追踪器。
 */
export function applyEvent(tr, event, now) {
  if (event === null || typeof event !== 'object') return tr
  const data = event.data ?? {}
  const stamp = typeof event.time === 'number' && event.time > 0 ? event.time : now
  tr.lastEventMs = Math.max(tr.lastEventMs, stamp)

  switch (event.type) {
    case 'session/title': {
      // 会话标题是仅写日志的 session/title 事件（dsh-session-title 产出），
      // 最新一条即当前标题；它不参与吞吐统计，只用于浮窗显示。
      const title = data.title
      if (typeof title === 'string' && title.trim().length > 0) tr.title = title.trim()
      return tr
    }
    case 'turn/start': {
      tr.turn = typeof data.turn === 'number' ? data.turn : tr.turn
      // 一轮开始 → 直到 turn/end 之前都算"在干活"（思考、跑工具、等工具结果
      // 这些空档里没有 chunk，只看流式活动会误判成"已完成"）。
      tr.turnOpen = true
      if (tr.phase === 'idle' || tr.phase === 'done') tr.phase = 'waiting'
      return tr
    }
    case 'step/start': {
      tr.turn = typeof data.turn === 'number' ? data.turn : tr.turn
      tr.step = typeof data.step === 'number' ? data.step : tr.step
      tr.phase = 'waiting'
      tr.stepStartMs = stamp
      tr.stepEndMs = 0
      tr.firstTokenMs = 0
      tr.lastTokenMs = 0
      tr.streamEndMs = 0
      tr.liveFrameIndex = -1
      tr.liveTokensThisStep = false
      tr.samples = []
      tr.streamEstTokens = 0
      tr.streamTurn = tr.turn
      tr.streamStep = tr.step
      tr.streamConsumed = 0
      tr.settledStepKey = ''
      tr.stepTokens = 0
      tr.exactStepTokens = null
      return tr
    }
    case 'assistant/attempt':
    case 'assistant/message': {
      // 结算事件：负载 { turn, step, stream, usage? }，`stream` 是该 attempt 的**全量累计快照**。
      //
      // 与实时通道的分工：若本步的 token 已经由 `agent/assistant-stream` 逐帧实时计入，
      // 这里就**只取精确 usage**、绝不再遍历 stream，否则同一批内容会被算两遍
      // （实时通道是增量、快照是全量，两者叠加必然重复）。
      consumeStream(tr, data, stamp, tr.liveTokensThisStep)

      // 精确 usage：`assistant/message` 的 data.usage 优先（官方 token-meter 同款判定），
      // 否则回溯 stream 里的类型 `usage` chunk（`assistant/attempt` 落在这一支）。
      let exact = null
      const direct = data.usage?.outputTokens
      if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) exact = direct
      else exact = streamUsageTokens(data.stream)

      // 只有 assistant/message 才是"一步组装完成"，才做收尾（校正系数、TTFT、冻结步长）。
      // assistant/attempt 只是尝试结束（可能是失败尝试），不能据此结束本步。
      if (event.type === 'assistant/attempt') {
        if (exact !== null && exact > 0) {
          tr.exactStepTokens = exact
          tr.stepTokens = exact
        }
        return tr
      }

      // 同一步的 assistant/message 重复投递（日志重放、宿主重发）必须幂等：
      // `totalTokens` 已按本步入账过就不再累加，否则会凭空翻倍。
      const stepKey = `${tr.streamTurn}/${tr.streamStep}`
      if (tr.settledStepKey === stepKey) {
        if (exact !== null) tr.stepTokens = exact
        return tr
      }

      const est = tr.streamEstTokens
      if (exact !== null) {
        // 用精确值校正估算系数（限幅，避免单步异常把系数带飞）。
        if (est > 0.5) {
          const ratio = Math.min(3, Math.max(0.3, exact / est))
          tr.calibration = tr.calibration * 0.7 + ratio * 0.3
        }
        tr.stepTokens = exact
        tr.totalTokens += exact
      } else {
        // 估算值在入账时已按当时的校正系数计入，这里直接采用。
        tr.stepTokens = est
        tr.totalTokens += est
      }
      tr.settledStepKey = stepKey
      // 解码窗口的右端点：
      //  - 新路径（结算事件的 stream）用**内嵌的末 token 时刻**——结算事件在整步结束后才落盘，
      //    两者可能差数百毫秒（含 tool-call 组装），用 stamp 会把平均速度系统性压低。
      //  - 旧路径（逐分片 assistant/chunk）沿用"到结算事件时间戳为止"，语义保持不变。
      const decodeEnd = tr.streamEndMs > tr.firstTokenMs ? tr.streamEndMs : stamp
      const decodeMs = tr.firstTokenMs > 0 ? Math.max(0, decodeEnd - tr.firstTokenMs) : 0
      tr.ttftMs = tr.firstTokenMs > 0 ? Math.max(0, tr.firstTokenMs - tr.stepStartMs) : tr.ttftMs
      tr.lastStepMs = decodeMs
      tr.lastStepTps = decodeMs >= 200 ? tr.stepTokens / (decodeMs / 1000) : null
      tr.lastTps = tr.lastStepTps ?? tr.lastTps
      tr.samples = []
      tr.streamEstTokens = 0
      tr.streamEndMs = 0
      // 本步到此结束：冻结步长，否则空闲后 stepMs 会一直涨（tooltip 显示"本步 600s"这种）。
      tr.stepEndMs = stamp
      tr.phase = 'done'
      return tr
    }
    case 'assistant/chunk': {
      // 兼容旧运行时的逐分片事件。本机 DSH 0.2.0-rc.2 **不再发出**该事件
      //（真实日志实测出现次数为 0），保留仅为兼容更老的宿主。
      // 由于新路径按 (turn, step) 去重、旧路径是真正的增量事件，二者不会重复计数：
      // 任何给定宿主只会走其中一条。
      const chunk = data.chunk
      if (chunk === null || typeof chunk !== 'object') return tr
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        pushTokens(tr, estimateTokens(chunk.text) * tr.calibration, stamp)
        return tr
      }
      if (chunk.type === 'tool-call-delta') {
        pushTokens(tr, estimateTokens(chunk.argumentsDelta) * tr.calibration, stamp)
        return tr
      }
      if (chunk.type === 'usage') {
        const out = chunk.usage?.outputTokens
        if (typeof out === 'number' && Number.isFinite(out) && out >= 0) {
          tr.exactStepTokens = out
          tr.stepTokens = out
        }
        return tr
      }
      return tr
    }
    case 'tool/call': {
      const callId = data.callId
      if (typeof callId === 'string') tr.toolCalls.add(callId)
      return tr
    }
    case 'tool/result': {
      const callId = data.message?.source?.callId
      if (typeof callId === 'string') tr.toolCalls.delete(callId)
      return tr
    }
    case 'turn/end': {
      tr.turnOpen = false
      tr.toolCalls.clear()
      tr.phase = 'idle'
      tr.samples = []
      return tr
    }
    default:
      return tr
  }
}

/**
 * 生成对外读数（HTTP 路由与浮窗消费的形状）。
 * @param {object} tr - 追踪器。
 * @param {number} now - 当前时间戳。
 * @returns {object} 读数快照。
 */
export function snapshot(tr, now) {
  const quiet = now - tr.lastEventMs
  const streaming = tr.phase === 'streaming' && quiet < IDLE_MS
  const waiting = tr.phase === 'waiting' && quiet < IDLE_MS
  const tps = streaming || waiting ? windowTps(tr, now) : tr.phase === 'streaming' ? tr.lastTps : 0

  // 均速：生成中实时算「本步至今」的平均速度，结束后定格为最近一步的平均速度。
  let avgTps = tr.lastStepTps
  let avgMs = tr.lastStepMs
  if (streaming && tr.firstTokenMs > 0) {
    const decodeMs = Math.max(0, now - tr.firstTokenMs)
    const tokens = tr.exactStepTokens !== null ? tr.exactStepTokens : tr.streamEstTokens
    avgMs = decodeMs
    avgTps = decodeMs >= 200 ? tokens / (decodeMs / 1000) : null
  }

  return {
    id: tr.id,
    dir: tr.dir,
    cwd: tr.cwd,
    /** 会话标题（可能为空串：标题还没生成，或旧宿主没带）。 */
    title: tr.title,
    /** true = subagent 子会话。 */
    sub: tr.sub,
    /** waiting | streaming | done | idle */
    phase: waiting ? 'waiting' : tr.phase,
    running: streaming || waiting,
    /** 整轮是否还没结束（含思考 / 跑工具的空档）：浮窗据此判断"在干活"。 */
    active: tr.turnOpen,
    /** 是否有工具调用正在执行（结果还没回来）。 */
    toolActive: tr.toolCalls.size > 0,
    /** 实时窗口速度（只有生成中才有意义）。 */
    tps: Number.isFinite(tps) ? Math.round(tps * 10) / 10 : 0,
    /** 本步（或最近一步）平均速度。 */
    avgTps: avgTps === null || !Number.isFinite(avgTps) ? null : Math.round(avgTps * 10) / 10,
    /** 均速对应的解码时长（毫秒）。 */
    avgMs: avgMs === null || !Number.isFinite(avgMs) ? null : Math.round(avgMs),
    stepTokens: Math.round(tr.stepTokens * 10) / 10,
    totalTokens: Math.round(tr.totalTokens),
    ttftMs: tr.ttftMs === null ? null : Math.round(tr.ttftMs),
    lastStepTps: tr.lastStepTps === null ? null : Math.round(tr.lastStepTps * 10) / 10,
    turn: tr.turn,
    step: tr.step,
    // 本步耗时：生成中随时间增长，本步结束后定格在 stepEndMs。
    stepMs: tr.stepStartMs > 0 ? Math.max(0, (tr.stepEndMs > 0 ? tr.stepEndMs : now) - tr.stepStartMs) : 0,
    quietMs: Math.max(0, Math.round(quiet)),
    lastEventMs: Math.round(tr.lastEventMs),
    calibration: Math.round(tr.calibration * 1000) / 1000,
  }
}

/**
 * 从会话日志里折叠最新标题：插件挂载前就生成过标题的会话也能显示出来。
 * @param {object} session - 会话对象（读 events）。
 * @returns {string} 标题，未找到时为空串。
 */
export function titleOf(session) {
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'session/title') continue
    const title = event.data?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  return ''
}

/**
 * 会话登记表：按会话 id 维护追踪器，并把快照按"活跃优先、最近优先"排序。
 * @returns {{ onEvent: Function, readings: Function, count: Function }}
 */
export function createRegistry() {
  /** @type {Map<string, object>} */
  const trackers = new Map()

  function trackerFor(session, now) {
    const id = String(session?.id ?? 'unknown')
    let tr = trackers.get(id)
    if (tr === undefined) {
      const cwd = session?.header?.cwd
      const depth = session?.header?.delegationDepth
      const sub = session?.header?.origin === 'subagent' || (typeof depth === 'number' && depth > 0)
      tr = createTracker({ id, cwd: typeof cwd === 'string' ? cwd : '', sub, title: titleOf(session), now })
      trackers.set(id, tr)
    }
    return tr
  }

  function sweep(now) {
    for (const [id, tr] of trackers) {
      if (now - tr.lastEventMs > TRACKER_TTL_MS) trackers.delete(id)
    }
  }

  return {
    /**
     * 喂入一条宿主会话事件。
     * @param {object} session - 会话对象（读 id / header.cwd）。
     * @param {object} event - 会话事件。
     * @param {number} [now] - 当前时间戳（测试可注入）。
     */
    onEvent(session, event, now = Date.now()) {
      applyEvent(trackerFor(session, now), event, now)
    },
    /**
     * 喂入一帧实时 `agent/assistant-stream`（`frame` 部分）。
     * @param {object} session - 会话对象（由 `agent.session` 提供，读 id / header.cwd）。
     * @param {object} frame - 流式帧（start | chunk | end）。
     * @param {number} [now] - 当前时间戳（测试可注入）。
     */
    onFrame(session, frame, now = Date.now()) {
      applyStreamFrame(trackerFor(session, now), frame, now)
    },
    /**
     * 取全部会话读数（活跃在前，其余按最近活动倒序）。
     * @param {number} [now] - 当前时间戳。
     * @param {number} [limit] - 最多返回条数。
     * @returns {object[]} 读数数组。
     */
    readings(now = Date.now(), limit = 12) {
      sweep(now)
      const all = []
      for (const tr of trackers.values()) {
        // 没有任何产出、整轮也没在进行的会话不占浮窗；反过来，正在思考（整轮开着、
        // 还没吐第一个 token）的会话必须显示出来，否则用户会以为浮窗坏了。
        if (tr.totalTokens <= 0 && tr.stepTokens <= 0 && tr.streamEstTokens <= 0 && !tr.turnOpen) continue
        all.push(snapshot(tr, now))
      }
      all.sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1
        if (a.sub !== b.sub) return a.sub ? 1 : -1
        return b.lastEventMs - a.lastEventMs
      })
      return all.slice(0, limit)
    },
    /** 已登记的会话数（诊断用）。 */
    count() {
      return trackers.size
    },
  }
}
