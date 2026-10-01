/**
 * 自动导出「排程器」 —— 延迟多久导、期间又改了几次、正在导的时候又改了一次怎么办
 * ============================================================================
 * 为什么单独摘一个文件:
 *   这套东西是**纯状态机**(idle / scheduled / running + dirty), 而"导出到哪、
 *   怎么原子写盘"是 IO。混在一起就没法用假时钟把"3 分钟"在一毫秒里跑完 ——
 *   见 scripts/test-export-presets.mjs(纯 Node, 不启 Electron、不碰真实库)。
 *
 * 状态机:
 *   idle --schedule()--> scheduled --延迟到期--> running --跑完--> idle
 *                          ↑                        │
 *                          └───── 跑完发现 dirty ────┘
 *
 * 三条刻意的取舍:
 *   · **正在导的时候又改黑名单 —— 不许丢**(2026-09-24 修的旧 bug)。
 *     旧实现是 `if (running) return {skipped:true}`: 定时器到点时上一轮还没跑完,
 *     这次改动就**永远不落地**了, 而且没有任何提示 —— 用户以为导过了, 文件还是旧的。
 *     现在只置 dirty, 跑完自动补一轮。
 *   · 延迟是**从最后一次改动**起算(防抖), 所以"一直在 ban"就会一直顺延 ——
 *     这是刻意的: 用户要的就是"停手之后再导"。点角标 / 关窗口走 flushNow() 不受影响。
 *   · 没有 auto 预设时不排空程(不建定时器), 免得白转。
 *
 * 依赖全部注入(便于替换成假时钟/假定时器, 也便于 main.js 与 ipc.js 共用同一实例):
 *   run()           真正跑一轮导出(exportPresets 里的 runAuto)。返回的对象会被原样
 *                   放进 notify payload —— 里面必须有 results(渲染层靠它说人话)
 *   notify(p)       把状态推给渲染层
 *   getDelayMs()    当前延迟(全局可配, 存 export_presets.json 顶层)
 *   listAutoCount() 有几个开了自动导出的预设
 *   now()           时钟
 *   setTimer/clearTimer  定时器(测试里换成手动推进的假定时器)
 */

/**
 * 延迟档位(全局一个值)。放在这个文件里是为了**可单测** —— 它是纯函数,
 * 不碰文件也不碰 electron(见 scripts/test-export-presets.mjs)。
 * 为什么要限定档位: 这个值会落在用户能手改的 json 里, 白名单化最省心 ——
 * 手抖写出 1ms(等于没延迟)或 86400000(一天, 等于不导)都不可怕, 归一化就能救回来。
 */
export const DELAY_OPTIONS = [1500, 30000, 60000, 180000, 300000, 600000]
export const DEFAULT_DELAY_MS = 180000         // 3 分钟: 连续 ban 一批只导一次

/** 延迟值归一: 不在档位里(含 undefined/NaN/手改的乱七八糟)就回默认 3 分钟 */
export function normDelay(v) {
  const n = Number(v)
  return DELAY_OPTIONS.includes(n) ? n : DEFAULT_DELAY_MS
}

export function createScheduler({
  run,
  notify = () => {},
  getDelayMs = () => 1500,
  listAutoCount = () => 0,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  let state = 'idle'
  let timer = null
  let dueAt = 0
  let dirty = false          // running 期间又变更过 -> 跑完补一轮
  let runningPromise = null  // flushNow 要能"等当前这轮跑完"

  function clear() {
    if (timer) { clearTimer(timer); timer = null }
    dueAt = 0
  }

  /**
   * 黑名单内容变了 -> 排一次(防抖合并)。
   * @returns {{scheduled:boolean, autoCount:number, dueAt?:number, delayMs?:number, coalesced?:boolean, fresh?:boolean}}
   *   fresh = 这一批的**第一次**排程(上次空闲) —— 渲染层只在这时候提示一次, 免得连 ban 刷屏。
   */
  function schedule() {
    const autoCount = listAutoCount()
    if (!autoCount) return { scheduled: false, autoCount: 0 }
    if (state === 'running') {
      dirty = true
      return { scheduled: true, coalesced: true, autoCount }
    }
    const fresh = state === 'idle'
    clear()                                  // 防抖: 每次改动都重算到期时间
    const delayMs = Math.max(0, Number(getDelayMs()) || 0)
    state = 'scheduled'
    dueAt = now() + delayMs
    timer = setTimer(() => {
      timer = null
      dueAt = 0
      void fire('timer')
    }, delayMs)
    notify({ kind: 'scheduled', at: now(), dueAt, delayMs, autoCount, fresh })
    return { scheduled: true, autoCount, dueAt, delayMs, fresh }
  }

  /** 跑一轮(定时器到期 / flushNow 都走这里)。同一时刻只允许一轮。 */
  async function fire(trigger) {
    if (state === 'running') {          // 理论上到不了(定时器已清), 兜一层
      dirty = true
      return { skipped: true, reason: 'busy', results: [] }
    }
    state = 'running'
    dirty = false
    runningPromise = (async () => {
      let payload
      try {
        payload = (await run()) || {}
      } catch (e) {
        // 导出失败绝不能往上抛: ban 是主操作、导出是附带的
        payload = { results: [], error: e?.message || String(e) }
      }
      state = 'idle'
      notify({ kind: 'result', at: now(), trigger, ...payload })
      const again = dirty
      dirty = false
      if (again) schedule()             // 补跑: 上一轮跑的时候用户又改了
      return payload
    })()
    try {
      return await runningPromise
    } finally {
      runningPromise = null
    }
  }

  /**
   * 跳过等待, 立刻跑。
   * 两个调用方: 首页角标点一下 / 关窗口前的收尾(before-quit)。
   * 正在跑就先等它跑完, 再补一轮 —— 保证"用户最后一次改动"一定落地。
   */
  async function flushNow() {
    clear()
    while (runningPromise) {
      try { await runningPromise } catch { /* fire 内部已兜 */ }
    }
    clear()          // 上一轮跑完可能因为 dirty 又排了一次 —— 立刻跑, 不用再等
    dirty = false
    return fire('manual')
  }

  /** 取消待排程(应用退出 / 用户不想导了)。注意: 不打断正在跑的那一轮。 */
  function cancel() {
    clear()
    dirty = false
  }

  function hasPending() {
    return !!timer || state === 'running' || dirty
  }

  function getState() {
    return {
      state,
      pending: hasPending(),
      dueAt,
      remainingMs: timer ? Math.max(0, dueAt - now()) : 0,
      autoCount: listAutoCount(),
      delayMs: getDelayMs(),
      dirty,
    }
  }

  /** 等"排程中的活"自己跑完(测试与关窗前收尾用); 有超时, 不会把退出卡死。 */
  function waitIdle(timeoutMs = 8000) {
    if (!hasPending()) return Promise.resolve()
    return new Promise((resolve) => {
      const t0 = now()
      const poll = () => {
        if (!hasPending() || now() - t0 > timeoutMs) return resolve()
        setTimer(poll, 60)
      }
      setTimer(poll, 60)
    })
  }

  return { schedule, fire, flushNow, cancel, hasPending, getState, waitIdle }
}
