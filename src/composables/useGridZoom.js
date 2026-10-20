/**
 * Ctrl+滚轮缩放图片网格 —— TvImageGrid(看板/标签/收藏/系列)与扫描页共用
 * ====================================================================
 * 调的是 useJustifiedRows 的行高基准(base × zoom), 不是 transform:scale ——
 * 后者会把卡片糊掉且不重排; 前者是真·重新排版, 字号/留白比例都保持正常。
 *
 * 倍率范围由 buildRows 的行高上下限反推: targetH = base×16/9 被夹在 [120,600],
 * base 默认 150 → 有效倍率 [0.45, 2.25], 超出只会"顶到底不再变化", 没必要放行。
 * 步进 ×1.12 与光箱缩放一致; 滚一档记一次 localStorage(tv_grid_zoom),
 * 所有网格页面共用同一份(同一张卡片同一套审美, 没理由各记各的)。
 *
 * 用法:
 *   const { zoom, zoomFlash, onWheel, reset } = useGridZoom()
 *   useJustifiedRows(items, { base: computed(() => 150 * zoom.value) })
 *   <div @wheel="onWheel"> … <TvZoomBadge :zoom="zoom" :show="zoomFlash" @reset="reset" />
 */
import { ref, onBeforeUnmount } from 'vue'
import { readLS, writeLS, LS } from '@/utils/lskey.js'

export const ZOOM_MIN = 0.45
export const ZOOM_MAX = 2.25
export const ZOOM_STEP = 1.12

function clampSaved(v) {
  const n = Number(v)
  return (n >= ZOOM_MIN && n <= ZOOM_MAX) ? n : 1
}

export function useGridZoom() {
  const zoom = ref(clampSaved(readLS(LS.gridZoom.key)))
  /** 缩放时的提示徽标: 显示当前百分比, 停手 900ms 后淡出; 点击恢复 100% */
  const zoomFlash = ref(false)
  let flashTimer = null

  function flash() {
    zoomFlash.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { zoomFlash.value = false }, 900)
  }

  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return    // 普通滚动照常滚列表
    e.preventDefault()                       // 拦下 Electron 的页面级 Ctrl+滚轮缩放
    const f = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom.value * f * 100) / 100))
    if (next !== zoom.value) {
      zoom.value = next
      writeLS(LS.gridZoom.key, next)
    }
    flash()   // 顶到边界也给个反馈, 不然"没反应"像是坏了
  }

  function reset() {
    if (zoom.value === 1) return
    zoom.value = 1
    writeLS(LS.gridZoom.key, 1)
    flash()
  }

  onBeforeUnmount(() => clearTimeout(flashTimer))
  return { zoom, zoomFlash, onWheel, reset }
}
