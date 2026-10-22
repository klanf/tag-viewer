/**
 * 图片请求闸门
 * ============
 * 一次翻多页时, 新挂上来的几百张卡片会同时进入「要图」状态。主进程那边已经
 * 串行生成, 但几百个 tv://thumb 请求一起压过去仍会排长队, 而且用户很可能
 * 翻过去就不再看了。这里在渲染层先限流:
 *   · 缩略图同时最多 4 个在飞, 其余排队;
 *   · 原图是整张大文件(查重面板会一次挂很多张), 单独一条队, 最多 2 个在飞;
 *   · 卡片被卸载 / 换图时把排队项撤掉(cancel), 还没轮到就不再发;
 *   · 拿到槽的请求在 img load/error 时归还, 卸载也会归还, 不会占死。
 *
 * 缩略图(width > 0)默认走缩略图队; 原图(width = 0)默认直接放行(光箱一次只有
 * 一张), 需要限流的场景(查重面板)显式传 origGate 走原图队。
 */
function createGate(max) {
  let active = 0
  const waiters = []

  function makeRelease() {
    let done = false
    return () => {
      if (done) return
      done = true
      active = Math.max(0, active - 1)
      pump()
    }
  }

  function pump() {
    while (active < max && waiters.length) {
      const w = waiters.shift()
      if (w.canceled) continue
      active++
      w.grant(makeRelease())
    }
  }

  /**
   * 申请一个请求槽。
   * @returns {{promise: Promise<() => void>, cancel: () => void}}
   *   promise 在轮到它时 resolve 一个 release 函数; 排队期间 cancel() 可撤回。
   */
  return function acquire() {
    let entry
    const promise = new Promise((resolve) => {
      entry = { canceled: false, grant: resolve }
      waiters.push(entry)
      pump()
    })
    return {
      promise,
      cancel() {
        if (entry.canceled) return
        entry.canceled = true
        const i = waiters.indexOf(entry)
        if (i >= 0) waiters.splice(i, 1)
      },
    }
  }
}

const acquireThumb = createGate(4)
const acquireOrig = createGate(2)

/** 缩略图槽位(缩略图生成/读取, 默认 4 并发) */
export const acquireThumbSlot = acquireThumb

/** 原图槽位(查重面板这类一次挂多张原图的场景, 默认 2 并发) */
export const acquireOrigSlot = acquireOrig
