/**
 * 「在来源页里就地打开某系列的角色列表」的宿主登记
 * ==============================================
 * 与 useTagHost 同一套机制, 只是打开的是另一种面板(角色列表, 不是图片流):
 * 系列/看板/扫描在挂载时登记同路由名的处理器; 光箱点系列药丸时同步调用,
 * 有人接 = 就地叠一层、顶部 tab 不动; 没人接 = 回退到 /series?series=xxx。
 *
 * 同步调用是刻意的: 光箱要先知道"有没有接住"再决定要不要 router.push。
 */
import { onMounted, onBeforeUnmount } from 'vue'

const hosts = new Map()

export function useSeriesHost(routeName, open) {
  onMounted(() => hosts.set(routeName, open))
  onBeforeUnmount(() => {
    if (hosts.get(routeName) === open) hosts.delete(routeName)
  })
}

/** 当前路由有宿主就就地打开, 返回 true; 否则 false(调用方走路由兜底) */
export function openSeriesInHost(routeName, series) {
  const fn = hosts.get(routeName)
  if (!fn) return false
  fn(series)
  return true
}
