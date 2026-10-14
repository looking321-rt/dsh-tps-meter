/**
 * dsh-tps-meter 客户端浮窗（注入脚本）。
 *
 * 宿主插件把本文件作为 GET /dsh-tps/widget.js 提供，并经两条路径注入：
 * HTTP 直连走 webServer.tapIndex，DSH 桌面端走 `webserver/index-inject`
 * 结构化行（桌面端首页由 Electron 静态直供，不经过 HTTP 渲染）。
 * 浮窗自己轮询 /dsh-tps/state.json 拿会话实时读数，因此不依赖客户端模块
 * 系统，也不占用任何 DSH slot。
 *
 * 宿主插件被停用/卸载后，`/dsh-tps/state.json` 会变成 404。此时浮窗会
 * 自行移除并停止轮询——否则页面上会永远留着一个「打开但没数据」的空壳，
 * 只能靠重启 DSH 清掉。
 */
;(function () {
  if (typeof window === 'undefined' || window.__dshTpsMeter === true) return
  window.__dshTpsMeter = true

  var ENDPOINT = '/dsh-tps/state.json'
  var SELF_ENDPOINT = '/dsh-tps/widget.js'
  // 本文件版本号：浮窗会定期拉一次自身源码比对，不一致就在头部显示「⟳ 更新」按钮
  // （只提示、不自动刷新，避免打断正在输入的内容）。
  var BUILD = '2026-10-14a'
  var POS_KEY = 'dsh-tps-meter:pos'
  var COLLAPSE_KEY = 'dsh-tps-meter:collapsed'
  var MODE_KEY = 'dsh-tps-meter:mode'
  var SEL_KEY = 'dsh-tps-meter:selected'
  var CLOSED_KEY = 'dsh-tps-meter:closed'
  var POLL_MS = 400
  var POLL_HIDDEN_MS = 2000
  var HISTORY_LEN = 40

  var STYLE = [
    '#dshtps{position:fixed;z-index:2147483000;width:186px;box-sizing:border-box;',
    'font-family:var(--ds-font-family-text,ui-sans-serif,system-ui,"Segoe UI",sans-serif);',
    'font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary,#e8e8ea);',
    'background:var(--dsw-alias-surface-2,rgba(32,33,38,.92));',
    'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;',
    'box-shadow:0 6px 22px rgba(0,0,0,.28);backdrop-filter:blur(10px);',
    'padding:8px 10px 9px;user-select:none;opacity:1}',
    '#dshtps.is-collapsed{width:118px;padding:6px 9px}',
    '#dshtps .t-head{display:flex;align-items:center;gap:6px;cursor:grab;margin-bottom:5px}',
    '#dshtps .t-head:active{cursor:grabbing}',
    '#dshtps .t-dot{width:7px;height:7px;border-radius:50%;background:#7a7a85;flex:none}',
    '#dshtps .t-dot.live{background:#39d98a;box-shadow:0 0 8px rgba(57,217,138,.75);animation:t-pulse 1.1s ease-in-out infinite}',
    '#dshtps .t-dot.wait{background:#e8b64c;animation:t-pulse 1.6s ease-in-out infinite}',
    '#dshtps .t-dot.done{background:#5b9bff}',
    '@keyframes t-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '#dshtps .t-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'color:var(--dsw-alias-label-secondary,#a9a9b3);font-size:10.5px;letter-spacing:.4px}',
    '#dshtps .t-tools{display:flex;gap:3px;align-items:center;flex:none}',
    '#dshtps .t-btn{border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;',
    'padding:1px 3px;border-radius:4px;font-size:11px;line-height:1}',
    '#dshtps .t-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}',
    '#dshtps .t-btn.t-reload{opacity:1;color:#39d98a}',
    // 实时 / 均速 分段切换器
    '#dshtps .t-seg{display:flex;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));',
    'border-radius:6px;overflow:hidden}',
    '#dshtps .t-seg button{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.5;',
    'font-size:9.5px;line-height:1;padding:2px 5px;font-family:inherit}',
    '#dshtps .t-seg button:hover{opacity:.85;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
    '#dshtps .t-seg button.on{opacity:1;background:rgba(57,217,138,.18);color:#39d98a;font-weight:600}',
    '#dshtps.is-avg .t-seg button.on{background:rgba(91,155,255,.2);color:#5b9bff}',
    '#dshtps .t-main{display:flex;align-items:baseline;gap:5px}',
    // 数字配色只跟口径走：实时=绿、均速=蓝（完全没有会话数据时才是中性灰）
    '#dshtps .t-num{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);',
    'font-size:26px;font-weight:600;letter-spacing:-.5px;font-variant-numeric:tabular-nums;color:#39d98a}',
    '#dshtps.is-avg .t-num{color:#5b9bff}',
    '#dshtps.is-idle-num .t-num{color:var(--dsw-alias-label-tertiary,#8b8b95)}',
    '#dshtps .t-unit{font-size:11px;color:var(--dsw-alias-label-secondary,#a9a9b3)}',
    '#dshtps .t-spark{display:block;width:100%;height:30px;margin:3px 0 2px}',
    // 会话列表：最多 3 行 + 省略行；当前会话绿色、其余白色，点击切换
    '#dshtps .t-sessions{display:flex;flex-direction:column;gap:1px;margin:0 0 4px}',
    '#dshtps .t-sess{display:flex;align-items:center;gap:5px;width:100%;box-sizing:border-box;border:0;',
    'background:transparent;cursor:pointer;font-family:inherit;font-size:11px;line-height:15px;padding:0 2px;',
    'text-align:left;border-radius:4px;color:var(--dsw-alias-label-primary,#e8e8ea);flex:none}',
    '#dshtps .t-sess .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // 右侧状态标：工作中 = Windows 式转圈，已完成 = 短横
    '#dshtps .t-sess .st{flex:none;width:12px;height:12px;box-sizing:border-box;display:flex;align-items:center;',
    'justify-content:center;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary,#8b8b95)}',
    '#dshtps .t-sess .st.spin{border-radius:50%;border:1.5px solid rgba(57,217,138,.28);border-top-color:#39d98a;',
    'animation:t-spin .8s linear infinite}',
    '@keyframes t-spin{to{transform:rotate(360deg)}}',
    '#dshtps .t-sess:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
    '#dshtps .t-sess.on{color:#39d98a;font-weight:600}',
    '#dshtps .t-sess.more{color:var(--dsw-alias-label-tertiary,#8b8b95);cursor:default;font-size:10.5px;line-height:14px}',
    '#dshtps .t-sess.more:hover{background:transparent}',
    '#dshtps .t-row{display:flex;justify-content:space-between;gap:6px;font-size:10.5px;',
    'color:var(--dsw-alias-label-secondary,#a9a9b3);font-variant-numeric:tabular-nums}',
    '#dshtps .t-row b{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8ea)}',
    '#dshtps.is-collapsed .t-spark,#dshtps.is-collapsed .t-rows,#dshtps.is-collapsed .t-sessions{display:none}',
    '#dshtps .t-state{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b8b95);margin-top:2px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ].join('')

  function injectStyle() {
    if (document.querySelector('style[data-plugin-css="dsh-tps-meter"]') !== null) return
    var tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-tps-meter'
    tag.dataset.pluginCss = 'dsh-tps-meter'
    tag.textContent = STYLE
    document.head.appendChild(tag)
  }

  /** 读数字段的兜底：缺失/非数字一律当 0，别让一个 undefined 把整帧渲染炸掉。 */
  function toNum(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0
  }

  function fmtCount(n) {
    if (!isFinite(n) || n <= 0) return '0'
    if (n < 1000) return String(Math.round(n))
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 'k'
    return (n / 1000000).toFixed(2) + 'M'
  }

  function fmtSeconds(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '—'
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's'
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '0.0s'
    return (ms / 1000).toFixed(1) + 's'
  }

  var PHASE_TEXT = {
    waiting: '等待首 token…',
    streaming: '生成中',
    done: '本步完成',
    idle: '空闲',
  }

  function loadPos() {
    try {
      var raw = localStorage.getItem(POS_KEY)
      if (raw === null) return null
      var pos = JSON.parse(raw)
      if (typeof pos.left === 'number' && typeof pos.top === 'number') return pos
    } catch (err) {}
    return null
  }

  function savePos(pos) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos))
    } catch (err) {}
  }

  function loadCollapsed() {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch (err) {
      return false
    }
  }

  function saveCollapsed(value) {
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
    } catch (err) {}
  }

  function loadMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'avg' ? 'avg' : 'live'
    } catch (err) {
      return 'live'
    }
  }

  function saveMode(value) {
    try {
      localStorage.setItem(MODE_KEY, value)
    } catch (err) {}
  }

  function loadSelected() {
    try {
      return localStorage.getItem(SEL_KEY) || null
    } catch (err) {
      return null
    }
  }

  function saveSelected(id) {
    try {
      localStorage.setItem(SEL_KEY, id)
    } catch (err) {}
  }

  /** 被用户双击关闭（不再显示）的会话 id 列表。 */
  function loadClosed() {
    try {
      var raw = localStorage.getItem(CLOSED_KEY)
      var list = raw === null ? [] : JSON.parse(raw)
      return Array.isArray(list) ? list.filter(function (v) { return typeof v === 'string' }) : []
    } catch (err) {
      return []
    }
  }

  function saveClosed(list) {
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify(list))
    } catch (err) {}
  }

  function build() {
    injectStyle()
    var root = document.createElement('div')
    root.id = 'dshtps'
    root.innerHTML = [
      '<div class="t-head">',
      '<span class="t-dot"></span>',
      '<span class="t-label">TOK/S</span>',
      '<span class="t-tools">',
      '<button class="t-btn t-reload" data-act="reload" title="浮窗脚本已更新，点击刷新页面（Ctrl+R）" style="display:none">⟳</button>',
      '<span class="t-seg" title="切换显示：实时窗口速度 / 本步平均速度">',
      '<button data-mode="live">实时</button>',
      '<button data-mode="avg">均速</button>',
      '</span>',
      '<button class="t-btn" data-act="collapse" title="折叠 / 展开">–</button>',
      '</span>',
      '</div>',
      '<div class="t-sessions"></div>',
      '<div class="t-main"><span class="t-num">0.0</span><span class="t-unit">tok/s</span></div>',
      '<canvas class="t-spark" width="332" height="60"></canvas>',
      '<div class="t-rows">',
      '<div class="t-row"><span>本步</span><b data-f="step">0</b></div>',
      '<div class="t-row"><span>累计</span><b data-f="total">0</b></div>',
      '<div class="t-row"><span>TTFT</span><b data-f="ttft">—</b></div>',
      '</div>',
      '<div class="t-state"></div>',
    ].join('')
    document.body.appendChild(root)

    var num = root.querySelector('.t-num')
    var dot = root.querySelector('.t-dot')
    var state = root.querySelector('.t-state')
    var canvas = root.querySelector('.t-spark')
    var sessionsEl = root.querySelector('.t-sessions')
    var fields = {
      step: root.querySelector('[data-f="step"]'),
      total: root.querySelector('[data-f="total"]'),
      ttft: root.querySelector('[data-f="ttft"]'),
    }

    // ---- 拖动 & 位置记忆 ----
    var pos = loadPos()
    if (pos === null) {
      // 默认落在右下角，但让开最右侧约 268px（给桌面宠物 / 挂件类插件留位）。
      pos = {
        left: Math.max(8, window.innerWidth - 186 - 268),
        top: Math.max(8, window.innerHeight - 166),
      }
    }
    function place() {
      var maxLeft = Math.max(4, window.innerWidth - root.offsetWidth - 4)
      var maxTop = Math.max(4, window.innerHeight - root.offsetHeight - 4)
      pos.left = Math.min(Math.max(4, pos.left), maxLeft)
      pos.top = Math.min(Math.max(4, pos.top), maxTop)
      root.style.left = pos.left + 'px'
      root.style.top = pos.top + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
    place()
    window.addEventListener('resize', place)

    var drag = null
    root.querySelector('.t-head').addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('.t-btn') !== null || ev.target.closest('.t-seg') !== null) return
      drag = { dx: ev.clientX - pos.left, dy: ev.clientY - pos.top }
      ev.currentTarget.setPointerCapture(ev.pointerId)
    })
    root.querySelector('.t-head').addEventListener('pointermove', function (ev) {
      if (drag === null) return
      pos.left = ev.clientX - drag.dx
      pos.top = ev.clientY - drag.dy
      place()
    })
    function endDrag() {
      if (drag === null) return
      drag = null
      savePos(pos)
    }
    root.querySelector('.t-head').addEventListener('pointerup', endDrag)
    root.querySelector('.t-head').addEventListener('pointercancel', endDrag)

    // ---- 折叠 ----
    var collapsed = loadCollapsed()
    if (collapsed) root.classList.add('is-collapsed')
    root.querySelector('[data-act="collapse"]').addEventListener('click', function () {
      collapsed = !collapsed
      root.classList.toggle('is-collapsed', collapsed)
      saveCollapsed(collapsed)
      place()
    })

    // ---- 会话选择：单击切换显示，双击关闭（仅限已停止工作的会话） ----
    var selectedId = loadSelected()
    sessionsEl.addEventListener('click', function (ev) {
      var row = ev.target.closest('.t-sess')
      if (row === null) return
      // 「…N 个已关闭（点此恢复）」
      if (row.getAttribute('data-act') === 'restore') {
        closedIds.length = 0
        saveClosed(closedIds)
        lastListKey = ''
        refresh()
        return
      }
      if (row.classList.contains('more')) return
      var id = row.getAttribute('data-id')
      if (id === null) return
      selectedId = id
      saveSelected(id)
      shown = -1
      refresh()
    })
    sessionsEl.addEventListener('dblclick', function (ev) {
      var row = ev.target.closest('.t-sess')
      if (row === null || row.classList.contains('more')) return
      var id = row.getAttribute('data-id')
      if (id === null) return
      var one = null
      for (var i = 0; i < rawReadings.length; i += 1) {
        if (rawReadings[i].id === id) one = rawReadings[i]
      }
      // 前置条件：整轮还没结束就不许关（思考 / 跑工具期间也算没结束）
      if (one !== null && isWorking(one)) return
      if (closedIds.indexOf(id) < 0) {
        closedIds.push(id)
        saveClosed(closedIds)
      }
      if (selectedId === id) {
        selectedId = null
        saveSelected('')
      }
      lastListKey = ''
      refresh()
    })

    // ---- 显示模式：实时窗口速度 / 本步均速（右上角按钮手动切换，不再自动跳） ----
    var mode = loadMode()
    var segButtons = root.querySelectorAll('.t-seg button')
    function applyMode() {
      for (var i = 0; i < segButtons.length; i += 1) {
        var on = segButtons[i].getAttribute('data-mode') === mode
        segButtons[i].className = on ? 'on' : ''
      }
      root.classList.toggle('is-avg', mode === 'avg')
    }
    function setMode(next) {
      if (next === mode) return
      mode = next
      saveMode(mode)
      applyMode()
      shown = -1 // 强制下一帧直接跳到新数值，避免跨模式插值
      refresh()
    }
    for (var bi = 0; bi < segButtons.length; bi += 1) {
      segButtons[bi].addEventListener('click', function (ev) {
        setMode(ev.currentTarget.getAttribute('data-mode'))
      })
    }
    applyMode()

    // ---- 迷你曲线 ----
    var history = []
    var ctx = canvas.getContext('2d')
    function drawSpark() {
      var w = canvas.width
      var h = canvas.height
      ctx.clearRect(0, 0, w, h)
      var dark = document.body.hasAttribute('data-ds-dark-theme')
      var step = w / HISTORY_LEN
      var barW = Math.max(2, step - 2)
      var accent = mode === 'avg' ? '#5b9bff' : '#39d98a'
      var max = 0
      for (var i = 0; i < history.length; i += 1) max = Math.max(max, history[i])
      if (max <= 0) {
        // 还没有任何输出：画一条基线，别留一块空白。
        ctx.fillStyle = dark ? 'rgba(140,150,170,.28)' : 'rgba(90,100,120,.24)'
        ctx.fillRect(0, h - 2, w, 2)
        return
      }
      // 空槽留在左侧，柱子随时间从左向右推进（最新的在最右）。
      var offset = HISTORY_LEN - history.length
      for (var j = 0; j < history.length; j += 1) {
        var value = history[j]
        var bh = Math.max(2, (value / max) * (h - 4))
        var x = (offset + j) * step
        var live = j === history.length - 1
        ctx.fillStyle = live ? accent : dark ? 'rgba(160,170,190,.55)' : 'rgba(70,80,100,.45)'
        ctx.fillRect(Math.round(x), h - bh, Math.round(barW), bh)
      }
    }

    // ---- 渲染 ----
    var shown = 0
    var rawReadings = []
    var closedIds = loadClosed()
    var lastListKey = ''
    var MAX_ROWS = 3
    /**
     * 行序锚定：id → { seq, seenAt }。`seq` 是首次出现时分配的单调递增序号，
     * 位置只由它（和分组上浮）决定；`seenAt` 用来判断这个位置还值不值得保留。
     */
    var orderSeq = Object.create(null)
    /** 分配 seq 的自增游标。 */
    var nextSeq = 0
    /** 会话从列表消失后仍替它留位的时长（毫秒）。 */
    var SEQ_KEEP_MS = 10 * 60 * 1000
    /** 当前实际显示的会话 id：没手动点选过也咬住它，别让绿字跟着列表顺序跳。 */
    var shownId = null

    /**
     * "在干活"的判定：优先看整轮是否结束（`active`，思考 / 跑工具都算），
     * 宿主没给该字段时（旧版）退回"最近有流式输出"（`running`）。
     * 只看 running 会在思考空档里误判成"已完成"。
     */
    function isWorking(r) {
      if (typeof r.active === 'boolean') return r.active === true
      return r.running === true
    }

    /**
     * 过滤掉被双击关闭的会话；若某个被关掉的会话又开始干活，自动恢复显示
     * （关闭的语义是"这个闲着的会话先别占地方"，不是永久拉黑）。
     */
    function visibleReadings() {
      var out = []
      var changed = false
      for (var i = 0; i < rawReadings.length; i += 1) {
        var r = rawReadings[i]
        var at = closedIds.indexOf(r.id)
        if (at >= 0) {
          if (isWorking(r)) {
            closedIds.splice(at, 1)
            changed = true
          } else {
            continue
          }
        }
        out.push(r)
      }
      if (changed) saveClosed(closedIds)
      return out
    }

    function refresh() {
      render(stableOrder(visibleReadings()))
    }

    /**
     * 行序稳定化。宿主返回的顺序会随"谁刚吐了 token"每次轮询变化，直接照单渲染
     * 就会看到行上下互相换位。这里给每个会话锚定一个单调递增的"首次出现"序号：
     *   - **新会话一律追加到队尾**：插队会把已有行整体顶下去 —— 跨工作区多任务时
     *     subagent / IM / 新会话频繁加入，一插队就是用户看到的"标题上下跳"；
     *   - **会话短暂消失再回来，位置照样保留**：整轮结束且零输出的会话会被宿主
     *     过滤掉，下一秒又开始干活就回来了，不能当成新会话插队；
     *   - 位置只在「整轮开始 / 结束」时因分组上浮（工作中的会话排前面）而变化。
     * @param {object[]} readings - 本轮读数。
     * @returns {object[]} 新数组，顺序稳定。
     */
    function stableOrder(readings) {
      var now = Date.now()
      var alive = Object.create(null)
      var i
      for (i = 0; i < readings.length; i += 1) alive[readings[i].id] = true
      // 消失的会话先留着位置（下一轮可能马上回来）；超过保留时长才真正清理，防止长跑后无限增长。
      for (var gone in orderSeq) {
        if (alive[gone] !== true && now - orderSeq[gone].seenAt > SEQ_KEEP_MS) delete orderSeq[gone]
      }
      for (i = 0; i < readings.length; i += 1) {
        var row = readings[i]
        var entry = orderSeq[row.id]
        if (entry === undefined) orderSeq[row.id] = { seq: (nextSeq += 1), seenAt: now }
        else entry.seenAt = now
      }

      var out = readings.slice()
      out.sort(function (a, b) {
        var ga = isWorking(a) ? 0 : 1
        var gb = isWorking(b) ? 0 : 1
        if (ga !== gb) return ga - gb
        return orderSeq[a.id].seq - orderSeq[b.id].seq
      })
      return out
    }

    function esc(text) {
      return String(text).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    }

    /**
     * 列表里显示的会话名：优先真实标题；宿主还没提供标题时（旧版宿主/标题未生成），
     * 退回"目录名 · #短id"，至少能把同名目录下的不同会话区分开。
     */
    function displayName(r) {
      if (typeof r.title === 'string' && r.title.length > 0) return r.title
      var base = r.dir || r.id
      var short = String(r.id).replace(/^session-/, '').slice(0, 4)
      return short.length > 0 ? base + ' · #' + short : base
    }

    /** 会话列表（最多 3 行 + 省略行）；只在内容变化时重建，避免每 400ms 抖动。 */
    function renderSessions(readings, selected) {
      var names = readings.map(displayName)
      var key = readings.map(function (r, i) {
        return r.id + '\u0001' + names[i] + (r === selected ? '*' : '') + (isWorking(r) ? '+' : '-')
      }).join('\u0002') + '\u0003' + closedIds.join(',')
      if (key === lastListKey) return
      lastListKey = key

      var html = ''
      var rows = readings.slice(0, MAX_ROWS)
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i]
        var busy = isWorking(r)
        var tip = [
          r.title,
          names[i],
          r.sub ? '子代理' : '',
          busy ? '正在工作（思考 / 输出 / 跑工具）' : '已完成（双击关闭显示）',
          r.cwd || r.dir,
        ].filter(Boolean).join(' · ')
        // 右侧状态标：工作中 = 转圈，已完成 = 短横
        var mark = busy
          ? '<span class="st spin" aria-label="工作中"></span>'
          : '<span class="st" aria-label="已完成">–</span>'
        html += '<button class="t-sess' + (r === selected ? ' on' : '') + '" data-id="' + esc(r.id) + '" title="' + esc(tip) + '">' +
          '<span class="nm">' + esc(names[i]) + '</span>' + mark + '</button>'
      }
      if (readings.length > MAX_ROWS) {
        var rest = names.slice(MAX_ROWS)
        html += '<div class="t-sess more" title="' + esc(rest.join('\n')) + '">…还有 ' + rest.length + ' 个</div>'
      }
      // 被双击关掉、当前还看不到的会话：给一个一键找回的入口（可逆才敢用）。
      if (closedIds.length > 0) {
        html += '<div class="t-sess more" data-act="restore" title="点击恢复显示">…' + closedIds.length + ' 个已关闭（点此恢复）</div>'
      }
      if (html === '') html = '<div class="t-sess more">暂无会话输出</div>'
      sessionsEl.innerHTML = html
    }

    /**
     * 选哪个会话当"当前显示"：手动点选过的优先；没点选过就咬住上一次显示的
     * 那个（`shownId`），不要每次都取列表第一条 —— 第一条会随宿主排序抖动而
     * 换人，绿字就会在几个会话之间来回跳。
     */
    function pickReading(readings) {
      if (readings.length === 0) return null
      var want = selectedId === null || selectedId === '' ? shownId : selectedId
      if (want !== null) {
        for (var i = 0; i < readings.length; i += 1) {
          if (readings[i].id === want) return readings[i]
        }
      }
      return readings[0]
    }

    function render(readings) {
      var one = pickReading(readings)
      if (one !== null) shownId = one.id
      var phase = one === null ? 'idle' : one.phase
      var live = one !== null && one.running
      var avgMode = mode === 'avg'
      // 均速优先取本步实时均速（新宿主），缺失时回退到最后一步均速（兼容旧宿主）。
      var avg = null
      if (one !== null) {
        if (one.avgTps !== undefined && one.avgTps !== null) avg = one.avgTps
        else if (one.lastStepTps !== undefined && one.lastStepTps !== null) avg = one.lastStepTps
      }

      // 数值完全由模式决定，绝不自动来回跳：实时=窗口速度，均速=本步/最近一步平均。
      var target = one === null ? 0 : avgMode ? toNum(avg) : toNum(one.tps)
      if (shown < 0) shown = target
      else if (live) {
        shown = shown + (target - shown) * 0.45
        if (Math.abs(shown - target) < 0.05) shown = target
      } else shown = target
      num.textContent = shown.toFixed(1)

      root.classList.toggle('is-idle-num', one === null)
      dot.className = 't-dot' + (phase === 'streaming' ? ' live' : phase === 'waiting' ? ' wait' : phase === 'done' ? ' done' : '')

      renderSessions(readings, one)

      if (one === null) {
        fields.step.textContent = '0'
        fields.total.textContent = '0'
        fields.ttft.textContent = '—'
      } else {
        fields.step.textContent = fmtCount(one.stepTokens)
        fields.total.textContent = fmtCount(one.totalTokens)
        fields.ttft.textContent = fmtSeconds(one.ttftMs)
      }

      // 状态行：只要整轮还没结束就露一行简讯（思考 / 跑工具期间数字会掉到 0，
      // 靠这行说明"其实还在干活"）；闲下来就整行收起，把地方让给会话列表。
      var busy = one !== null && isWorking(one)
      if (busy) {
        var statusText
        if (live) statusText = (PHASE_TEXT[phase] || phase) + ' · ' + fmtDuration(toNum(one.stepMs))
        else if (one.toolActive === true) statusText = '工具执行中…'
        else statusText = '思考中…'
        state.style.display = ''
        state.textContent = (one.sub ? '子代理 · ' : '') + statusText
      } else {
        state.style.display = 'none'
        state.textContent = ''
      }
      // 完整信息挂到 tooltip 上，不占版面。
      root.title = one === null
        ? ''
        : [
            one.title || one.dir || one.id,
            (avgMode ? '均速 ' : '实时 ') + shown.toFixed(1) + ' tok/s',
            '实时 ' + toNum(one.tps).toFixed(1),
            avg === null ? null : '均速 ' + toNum(avg).toFixed(1) + ' tok/s',
            'T' + toNum(one.turn) + '/S' + toNum(one.step),
            '本步 ' + Math.round(toNum(one.stepMs) / 1000) + 's',
            one.cwd || one.dir,
          ].filter(function (v) { return v !== null && v !== undefined && v !== '' }).join(' · ')

      // 波形只在实时口径显示（均速口径不需要它，省掉这块高度）。
      if (live) {
        history.push(toNum(one.tps))
        while (history.length > HISTORY_LEN) history.shift()
      }
      if (avgMode) {
        canvas.style.display = 'none'
      } else {
        canvas.style.display = ''
        if (!collapsed) drawSpark()
      }
    }

    var emptyHistory = []
    for (var k = 0; k < HISTORY_LEN; k += 1) emptyHistory.push(0)
    history = emptyHistory.slice()
    render([])

    /** 收到一轮后端读数：存原始列表 → 过滤关闭项 → 渲染。 */
    function update(sessions) {
      rawReadings = Array.isArray(sessions) ? sessions : []
      refresh()
    }

    return { update: update, refresh: refresh, root: root }
  }

  function start() {
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    var ui = build()
    var failures = 0
    var notFound = 0
    var stopped = false
    var timer = null
    var buildTimer = null
    var buildInterval = null
    var inflight = false

    /**
     * 宿主插件已停用/卸载：移除浮窗并停止全部轮询。
     * 触发条件是连续多次 404——该状态码表示 `/dsh-tps/state.json` 路由已不存在，
     * 与「宿主临时不可用」（超时/5xx）不同，后者应保留浮窗继续重试。
     */
    function teardown() {
      if (stopped) return
      stopped = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (buildTimer !== null) { clearTimeout(buildTimer); buildTimer = null }
      if (buildInterval !== null) { clearInterval(buildInterval); buildInterval = null }
      try {
        if (ui.root.parentNode) ui.root.parentNode.removeChild(ui.root)
      } catch (err) {}
    }

    function tick() {
      if (stopped || inflight) return schedule()
      inflight = true
      fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(function (res) {
          if (res.status === 404) {
            notFound += 1
            throw new Error('HTTP 404')
          }
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (payload) {
          failures = 0
          notFound = 0
          ui.update(payload.sessions)
        })
        .catch(function () {
          failures += 1
          if (failures === 3) ui.update([])
          // 连续 3 次 404 才认定插件已被停用。宿主重启导致的短暂 404 通常
          // 伴随页面重载，这个阈值足以避开瞬时抖动而误删浮窗。
          if (notFound >= 3) teardown()
        })
        .finally(function () {
          inflight = false
          schedule()
        })
    }

    function schedule() {
      if (stopped) return
      if (timer !== null) clearTimeout(timer)
      var delay = failures > 2 ? 5000 : document.hidden ? POLL_HIDDEN_MS : POLL_MS
      timer = setTimeout(tick, delay)
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        if (timer !== null) clearTimeout(timer)
        tick()
      }
    })

    // ---- 自更新提示：脚本文件换了（宿主每次请求读磁盘）就在头部亮出「⟳」 ----
    var reloadBtn = ui.root.querySelector('[data-act="reload"]')
    reloadBtn.addEventListener('click', function () {
      window.location.reload()
    })
    function checkBuild() {
      fetch(SELF_ENDPOINT, { cache: 'no-store' })
        .then(function (res) {
          return res.ok ? res.text() : ''
        })
        .then(function (source) {
          var found = /var BUILD = '([^']+)'/.exec(source)
          if (found !== null && found[1] !== BUILD) reloadBtn.style.display = ''
        })
        .catch(function () {})
    }
    buildTimer = setTimeout(checkBuild, 15_000)
    buildInterval = setInterval(checkBuild, 60_000)

    tick()
  }

  start()
})()
