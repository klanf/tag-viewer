/**
 * 自适应行高网格（justified rows）—— 让「按真实比例排」和「不留大空洞」同时成立
 * ============================================================================
 * 为什么需要它（2026-09-23 用户拍板）:
 *   卡片改成按图片真实比例渲染之后, 原来的 CSS grid 是**按行对齐**的 —— 一行的高度
 *   取这一行里最高的那张卡, 于是横图(矮)下面必然空出一大片。实测用户库里横图占一半,
 *   壁纸那几个来源(垃圾桶/新世界/里世界/表世界, 一万四千多张)更是 100% 横的,
 *   所以那不是边角情况, 是满屏空洞。
 *
 * 做法(Flickr / Google 相册 / 苹果照片用的是同一套):
 *   1. **贪心分行**: 一张张往当前行里塞, 用"目标行高"估一下铺开要多少宽, 一旦超过容器
 *      宽度就把这一行定下来;
 *   2. **按比例铺满**: 定下来的行重新分配宽度, 让左右正好贴边 —— 行高因此会略微浮动,
 *      这正是它好看的原因(每一行都是满的, 没有一处留白);
 *   3. 每张图的宽度 = 行高 × 它自己的宽高比, 所以**一张图都不用裁**。
 *
 * 目标行高不是拍脑袋的数: 取 `竖图宽度 ≈ 原来的 --grid-min(150px)`, 也就是
 *   targetH = 150 × 16/9 ≈ 267px。
 *   于是**竖图的观感与改动前完全一致**(150px 宽、267px 高), 而横图自动变宽变完整
 *   (原来横图也是 150px 宽, 被裁成 150×267 的竖条; 现在约 500×280, 完整显示)。
 *
 * 最后一行不够长时**不铺满**(左对齐、保持目标行高) —— 强行铺满会把末尾那一两张
 * 拉成巨图。判据是"按目标行高排开能不能占到容器 3/4"。
 *
 * 拿不到尺寸的图(老库没回填 / 文件头读不出来)按 9/16 参与排版, 与卡片自身的回落一致
 * —— 这样"新特性对老数据的行为不变"这条在布局层也成立。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, toValue } from 'vue'

/** 拿不到尺寸时的回落比例 —— 与 TvImageCard / TvImage 的 '9 / 16' 保持一致 */
const FALLBACK_RATIO = 9 / 16
/** 行高的上下限: 防止极端比例(超宽全景图 / 极端窄图)把一行拉爆 */
const MIN_H = 120
const MAX_H = 600
/** 最后一行占到容器这个比例以上才铺满 */
const LAST_ROW_FULL = 0.75

/** 单张图的长宽比(宽/高); 拿不到尺寸 -> 回落竖图比例 */
export function aspectOf(item) {
  const w = Number(item?.px_w) || 0
  const h = Number(item?.px_h) || 0
  return (w > 0 && h > 0) ? w / h : FALLBACK_RATIO
}

/**
 * 把一串 item 排成若干行 —— **纯函数**, 不碰 DOM, 方便单测/探针直接调。
 * @param {Array} items
 * @param {number} W   容器可用宽度(px); <=0 表示还没量到 -> 返回空(不瞎排)
 * @param {{base?:number, gap?:number}} [opt]
 *        base = 「竖图目标宽度」, 默认 150(与原 --grid-min 一致)
 * @returns {Array<{h:number, cells:Array<{item:object, w:number}>}>}
 */
export function buildRows(items, W, opt = {}) {
  const base = Number(opt.base) || 150
  const gap = opt.gap === undefined ? 10 : Number(opt.gap)
  const target = Math.max(MIN_H, Math.min(MAX_H, (base * 16) / 9))
  const W0 = Number(W) || 0
  if (!(W0 > 0) || !Array.isArray(items) || !items.length) return []

  const rows = []
  let cur = []
  let sumR = 0

  /** 把当前这一行定下来; full=true 时按比例铺满, 否则保持目标行高 */
  function flush(full) {
    const n = cur.length
    if (!n) return
    const avail = W0 - gap * (n - 1)
    let h = full ? avail / sumR : target
    h = Math.max(MIN_H, Math.min(MAX_H, h))
    rows.push({
      h: Math.round(h),
      cells: cur.map((c) => ({ item: c.item, w: Math.round(h * c.r) })),
    })
    cur = []
    sumR = 0
  }

  for (const item of items) {
    const r = aspectOf(item)
    cur.push({ item, r })
    sumR += r
    // 按目标行高估: 加上这一张之后已经超过容器宽度 -> 这一行到此为止
    if (sumR * target + gap * (cur.length - 1) >= W0) flush(true)
  }
  if (cur.length) flush(sumR * target + gap * (cur.length - 1) >= W0 * LAST_ROW_FULL)
  return rows
}

/**
 * 让一组 item 按自适应行高排布。
 *
 * 宽度怎么来的: 用 ResizeObserver 量**网格元素自己**的 clientWidth。
 *   · 网格元素是 `v-if/v-else` 里的, 首次挂载时可能还不存在 —— 所以除了 onMounted
 *     还要 watch 模板 ref, 元素一出现就补量、补观察;
 *   · 首帧 width=0 会让 rows 为空, 但 onMounted 里的量测发生在浏览器绘制之前
 *     (Vue 的 DOM 更新在微任务里冲掉), 所以用户看不到"空一帧"。
 *
 * @param {import('vue').Ref<Array>} itemsRef
 * @param {{base?:number|import('vue').Ref<number>, gap?:number}} [opt]
 *        base 可以传 ref/computed(2026-10-20 Ctrl+滚轮缩放网格要用) —— buildRows
 *        在 computed 求值时才取值, base 一变行高立刻跟着重排。传普通数字行为不变。
 */
export function useJustifiedRows(itemsRef, opt = {}) {
  const wrapEl = ref(null)
  const width = ref(0)
  let ro = null
  let rafId = 0

  const rows = computed(() => buildRows(itemsRef.value, width.value, { ...opt, base: toValue(opt.base) }))

  /** 量一次宽度; 宽度没变就**不写**响应式状态(写了就会白白触发布局) */
  function measure() {
    const el = wrapEl.value
    if (!el) return
    const w = el.clientWidth
    if (w > 0 && w !== width.value) width.value = w
  }

  /**
   * ResizeObserver 回调 —— **必须延到下一帧**再改响应式状态, 不能直接调 measure()。
   *
   * 直接量+写会踩浏览器这条警告(实测每轮 7 条):
   *   "ResizeObserver loop completed with undelivered notifications."
   * 原因是 Vue 的组件更新在**微任务**里冲掉, 而"投递 resize 观察"这一轮**之内**就会把微任务
   * 跑掉 —— 刚写下的 width 立刻引起又一次布局变更, 浏览器判定这一轮没投递干净。
   * 推到下一帧, 这一轮就能正常收尾(实测 7 → 0)。
   *
   * ⚠️ 这条警告**不会**进 e2e 的错误断言: 它是浏览器生成的、经主进程
   * `electron/main.js` 的 console-message 通道以 `[render] …[error]` 转发到 stdout 的,
   * 和 CDP 那条收集路径不是同一个。所以"断言全绿"不等于"控制台干净"。
   *
   * 同一帧里的多次通知只跑一次(rafId 去重) —— 行高变了也会触发 RO 通知,
   * 那种通知量很大但宽度没变, 合并后等于什么都不做。
   */
  function measureNextFrame() {
    if (rafId) return
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 0)
    rafId = raf(() => { rafId = 0; measure() })
  }

  function bind(el) {
    if (!el) return
    measure()
    ro?.observe(el)
  }

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(measureNextFrame)
    // 没有 ResizeObserver(理论上不会, Electron 里一定有)也要能用: 退回 window.resize
    else window.addEventListener('resize', measure)
    bind(wrapEl.value)
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    if (rafId) cancelAnimationFrame(rafId)
    window.removeEventListener('resize', measure)
  })

  watch(wrapEl, (el, old) => {
    if (old && ro) ro.unobserve(old)
    bind(el)
  })

  return { wrapEl, rows, width, measure }
}
