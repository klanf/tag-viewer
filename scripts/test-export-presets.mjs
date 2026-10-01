/**
 * 自动导出「排程器」测试 —— 不启动 Electron, 用假时钟把 3 分钟在一毫秒里跑完
 * ==========================================================================
 * 守的是 2026-09-24 那次改造: 延迟从写死的 1.5s 变成**全局可配、默认 3 分钟**,
 * 并且顺手修掉一个真 bug ——
 *
 *   旧代码 `runAuto()` 开头是 `if (running) return {skipped:true}`:
 *   定时器到点时上一轮还没跑完, **这次黑名单改动就永远不会落地**了,
 *   而且没有任何提示(用户以为导过了, 文件还是旧的)。延迟从 1.5 秒改成几分钟后,
 *   撞上这个窗口的概率大幅上升, 所以必须修。
 *
 * 为什么能纯 Node 跑: 排程逻辑(延迟/防抖/补跑/dirty)全在 electron/core/exportScheduler.js,
 * 依赖是注入进来的 —— 换成假时钟 + 假定时器 + 假 run, 就不碰磁盘、不碰 electron。
 *
 * 用法: node scripts/test-export-presets.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { ROOT } from './harness.mjs'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const okA = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const MOD = await import(pathToFileURL(path.join(ROOT, 'electron/core/exportScheduler.js')).href)
const { createScheduler, DELAY_OPTIONS, DEFAULT_DELAY_MS, normDelay } = MOD

/* ------------------------------------------------------------ 假时钟 */

/**
 * 手动推进的时钟 + 定时器。
 * 关键点: 到期回调如果是 async(我们的 fire 就是), `advance` **不能等它跑完** ——
 * 真机上 setTimeout 的回调是 fire-and-forget, 等它就把"正在跑的时候又改一次"这个
 * 场景给测没了。所以这里只把同步部分跑掉 + 冲几轮微任务。
 */
function makeClock() {
  let t = 1_700_000_000_000
  let seq = 1
  const timers = new Map()
  const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = seq++; timers.set(id, { at: t + Math.max(0, ms), fn }); return id },
    clearTimer: (id) => { timers.delete(id) },
    pending: () => timers.size,
    /** 推进到 t+ms, 途中按到期先后逐个触发 */
    async advance(ms) {
      const target = t + ms
      for (;;) {
        let hit = null
        for (const [id, v] of timers) if (v.at <= target && (!hit || v.at < hit[1].at)) hit = [id, v]
        if (!hit) break
        timers.delete(hit[0])
        t = hit[1].at
        hit[1].fn()
        await drain()
      }
      t = target
      await drain()
    },
  }
}

/* -------------------------------------------------------- 测试台 */

/**
 * @param {{delayMs?:number, autoCount?:number, runImpl?:Function}} o
 */
function setup(o = {}) {
  const delayMs = o.delayMs ?? 30000
  const autoCount = o.autoCount ?? 1
  const clock = makeClock()
  const events = []
  let runCalls = 0
  let runningNow = 0
  let maxRunning = 0
  let gate = null

  const run = async () => {
    runCalls++
    runningNow++
    if (runningNow > maxRunning) maxRunning = runningNow
    try {
      if (gate) await gate
      return o.runImpl ? await o.runImpl() : { results: [{ ok: true, name: 'e2e 预设', count: 3, trigger: 'auto' }] }
    } finally {
      runningNow--
    }
  }

  const scheduler = createScheduler({
    run,
    notify: (p) => events.push(p),
    getDelayMs: () => delayMs,
    listAutoCount: () => autoCount,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  return {
    scheduler, clock, events,
    delayMs,
    delay: () => clock.advance(delayMs),
    runCalls: () => runCalls,
    maxRunning: () => maxRunning,
    /** 让下一轮 run 卡住不返回; 返回的函数用来放行 */
    hold() {
      let resolve
      const p = new Promise((r) => { resolve = r })
      gate = p
      return () => { gate = null; resolve() }
    },
    kinds: () => events.map((e) => e.kind),
    last: () => events[events.length - 1],
  }
}

/* -------------------------------------------------- 0. 先证明测试台可信 */

console.log('\n[0] 测试台自检(假时钟不准的话, 后面的断言全是自我安慰)')

await okA('假时钟: 100ms 的定时器在 99ms 不动、100ms 触发', async () => {
  const c = makeClock()
  let fired = 0
  c.setTimer(() => fired++, 100)
  await c.advance(99)
  assert.equal(fired, 0, '99ms 就触发了 -> 假时钟提前了')
  await c.advance(1)
  assert.equal(fired, 1)
  assert.equal(c.pending(), 0)
})

/* -------------------------------------------------------- 1/2. 排程与到期 */

console.log('\n[1] 排程: 延迟没到之前不许导(负向对照: 去掉定时器这条就红)')

const A = setup({ delayMs: 30000 })
ok('schedule() 之后进入 scheduled, 且 run 一次都没调', () => {
  const r = A.scheduler.schedule()
  assert.equal(r.scheduled, true)
  assert.equal(r.delayMs, 30000)
  assert.equal(A.scheduler.getState().state, 'scheduled')
  assert.equal(A.runCalls(), 0, 'schedule 就开跑了 -> 防抖失效')
  assert.equal(A.clock.pending(), 1, '应该正好挂一个定时器')
})
ok('排程时会推一条 kind=scheduled(渲染层靠它显示倒计时)', () => {
  const ev = A.events[0]
  assert.equal(ev.kind, 'scheduled')
  assert.equal(ev.dueAt, A.clock.now() + 30000)
  assert.equal(ev.fresh, true, '空闲 -> 排程 = 一批的第一次, 渲染层只在这时提示一次')
})

await okA('倒计时: remainingMs 从 30s 走到 15s(首页角标「待导出 mm:ss」就是它)', async () => {
  await A.clock.advance(15000)
  const s = A.scheduler.getState()
  assert.equal(s.remainingMs, 15000, `期望 15000, 实际 ${s.remainingMs}`)
  assert.equal(A.runCalls(), 0, '还没到点就导了')
})

await okA('到期 -> 恰好跑一次, 并推 kind=result(带 results)', async () => {
  await A.clock.advance(15000)
  assert.equal(A.runCalls(), 1)
  const ev = A.last()
  assert.equal(ev.kind, 'result')
  assert.equal(ev.trigger, 'timer')
  assert.equal(ev.results.length, 1)
  assert.equal(A.scheduler.getState().state, 'idle')
  assert.equal(A.scheduler.hasPending(), false, '跑完就该没有待办了')
})

/* -------------------------------------------------- 3. running 期间又变更 */

console.log('\n[3] 正在导的时候又改黑名单 —— 这次改动**不许丢**(旧的 return skipped 就丢在这里)')

await okA('run 跑到一半时 schedule -> 跑完自动补一轮(run 共 2 次)', async () => {
  const B = setup({ delayMs: 30000 })
  const release = B.hold()                     // 让第一轮卡住, 模拟"导出要跑好几秒"
  B.scheduler.schedule()
  await B.delay()                              // 定时器到点 -> run 开始(卡在 gate 上)
  assert.equal(B.runCalls(), 1, '第一轮应该已经开跑')
  assert.equal(B.scheduler.getState().state, 'running')

  const r = B.scheduler.schedule()              // ← 用户这时候又 ban 了一个
  assert.equal(r.scheduled, true)
  assert.equal(r.coalesced, true, '正在跑时不该另起一个定时器, 只标脏')
  assert.equal(B.scheduler.getState().dirty, true)
  assert.equal(B.maxRunning(), 1, '不能并发跑两轮导出')

  release()                                     // 第一轮跑完
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal(B.scheduler.getState().state, 'scheduled', '跑完发现 dirty, 应该自动补排一轮')
  assert.equal(B.runCalls(), 1, '补跑也要等延迟, 不是立刻再来一次')
  assert.equal(B.events.filter((e) => e.kind === 'result').length, 1)
  assert.equal(B.events.filter((e) => e.kind === 'scheduled').length, 2, '补跑会再推一次 scheduled')
  // 补跑是**新一轮**, fresh=true 是对的: 上一轮已经导完了(不含用户刚 ban 的那个词),
  // 这次得让用户知道"又排上了"。同一批内连点不刷屏由 [4] 那条守着。
  assert.equal(B.events[B.events.length - 1].fresh, true)

  await B.delay()                                // 补跑到期
  assert.equal(B.runCalls(), 2, '那次变更必须真的被导出去')
})

/* -------------------------------------------------------- 4. 防抖合并 */

console.log('\n[4] 连着 ban 好几个: 延迟内多次改动合并成一次')

await okA('3 次变更(每次间隔 1/3 延迟) -> 只导 1 次', async () => {
  const C = setup({ delayMs: 30000 })
  C.scheduler.schedule()
  await C.clock.advance(10000); C.scheduler.schedule()
  await C.clock.advance(10000); C.scheduler.schedule()
  assert.equal(C.runCalls(), 0)
  assert.equal(C.scheduler.getState().remainingMs, 30000, '每次改动都要把到期时间往后推(防抖)')
  await C.clock.advance(30000)
  assert.equal(C.runCalls(), 1, `期望只导 1 次, 实际 ${C.runCalls()}`)
  assert.equal(C.events.filter((e) => e.fresh).length, 1, '一批只提示一次')
})

/* -------------------------------------------------------- 5. 立刻导 */

console.log('\n[5] flushNow(): 跳过等待立刻导(首页角标点一下 / 关窗口前)')

await okA('排程中 flushNow -> 立刻跑, 且定时器被取消(不会再导第二次)', async () => {
  const D = setup({ delayMs: 180000 })
  D.scheduler.schedule()
  await D.scheduler.flushNow()
  assert.equal(D.runCalls(), 1)
  assert.equal(D.clock.pending(), 0, '定时器没清掉 -> 待会还会导一次')
  await D.clock.advance(600000)                 // 10 分钟
  assert.equal(D.runCalls(), 1, '被取消的定时器又把它叫起来了')
  assert.equal(D.scheduler.hasPending(), false)
})

await okA('正在跑的时候 flushNow -> 先等它跑完, 再导一轮(共 2 次)', async () => {
  const E = setup({ delayMs: 180000 })
  E.scheduler.schedule()
  await E.delay()
  const release = E.hold()                      // 下一轮卡住
  const p1 = E.scheduler.flushNow()              // 立刻导(这一轮会卡在 gate)
  await Promise.resolve()
  const p2 = E.scheduler.flushNow()              // 用户又点了一次角标
  release()
  await p1; await p2
  assert.equal(E.maxRunning(), 1, '不能并发')
  assert.equal(E.runCalls(), 3, `定时器那轮 + 两次 flush, 实际 ${E.runCalls()}`)
  assert.equal(E.scheduler.hasPending(), false)
})

/* --------------------------------------------- 6. 数据集没就绪的补跑 */

console.log('\n[6] 数据集没就绪: 不导, 但只补一次(不许定时器+补跑撞成双跑)')

await okA('run 返回 not-ready -> 推 result(带 reason), 且不会自己再排一次', async () => {
  const F = setup({
    delayMs: 180000,
    runImpl: () => ({ skipped: true, reason: 'not-ready', phase: 'loading', results: [] }),
  })
  F.scheduler.schedule()
  await F.delay()
  assert.equal(F.runCalls(), 1)
  const ev = F.last()
  assert.equal(ev.kind, 'result')
  assert.equal(ev.reason, 'not-ready', '渲染层要靠它说"数据还在加载"')
  assert.equal(F.clock.pending(), 0, 'not-ready 不该自动重排 —— 补跑由 whenReady 负责')
  assert.equal(F.scheduler.hasPending(), false)
})

await okA('就绪后 flushNow 补跑 -> 恰好 1 次, 之后再推进时钟也不会多跑', async () => {
  const G = setup({
    delayMs: 180000,
    runImpl: () => ({ skipped: true, reason: 'not-ready', phase: 'loading', results: [] }),
  })
  G.scheduler.schedule()
  await G.delay()
  assert.equal(G.runCalls(), 1)
  await G.scheduler.flushNow()                  // 模拟 armReadyRetry: 数据集就绪后补跑
  assert.equal(G.runCalls(), 2)
  await G.clock.advance(900000)                 // 15 分钟
  assert.equal(G.runCalls(), 2, '补跑之后又冒出一次导出 -> 多半是定时器没清')
  assert.equal(G.clock.pending(), 0)
})

/* ------------------------------------------------------ 7. 没有预设时 */

console.log('\n[7] 一个 auto 预设都没有时: 不排空程')

ok('autoCount=0 -> schedule 返回未排程, 且不挂定时器', () => {
  const H = setup({ autoCount: 0 })
  const r = H.scheduler.schedule()
  assert.equal(r.scheduled, false)
  assert.equal(r.autoCount, 0)
  assert.equal(H.clock.pending(), 0)
  assert.equal(H.scheduler.hasPending(), false)
})

/* ------------------------------------------------------ 8. 延迟值归一 */

console.log('\n[8] 延迟: 档位白名单 + 默认 3 分钟')

ok(`档位表 = ${DELAY_OPTIONS.join(', ')}`, () => {
  assert.deepEqual(DELAY_OPTIONS, [1500, 30000, 60000, 180000, 300000, 600000])
  assert.equal(DEFAULT_DELAY_MS, 180000)
})
ok('normDelay: 档位内的原样保留(1500/600000)', () => {
  assert.equal(normDelay(1500), 1500)
  assert.equal(normDelay(600000), 600000)
  assert.equal(normDelay('60000'), 60000, '字符串数字也要认(从 json/表单来)')
})
ok('normDelay: 不在档位/空/乱值 -> 回默认 3 分钟(手改 json 也炸不了)', () => {
  for (const bad of [undefined, null, 0, -1, 12345, 'abc', NaN, 86400000]) {
    assert.equal(normDelay(bad), 180000, `${String(bad)} 应归一成 180000`)
  }
})
ok('normDelay: 老版本存档(没有这个字段) -> 也是 3 分钟, 不需要迁移脚本', () => {
  assert.equal(normDelay(undefined), DEFAULT_DELAY_MS)
})

/* ---------------- 汇总 ---------------- */

console.log(`\n导出预设排程: ${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
