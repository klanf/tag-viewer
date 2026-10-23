/**
 * 「在来源页里打开 tag 页」的宿主登记
 * ==================================
 * 光箱是全局单例, 但它不知道当前视图有没有能力就地摊开 tag 页。这里让
 * 系列/看板/扫描在挂载时登记一个同路由名的处理器; 光箱点 tag 时同步调用:
 * 有人接 = 不换路由, 就地开页; 没人接 = 回退到 /tags/:tag 路由(标签区/深链)。
 *
 * 同步调用是刻意的: 光箱要先知道"有没有接住"再决定要不要 router.push。
 * KeepAlive 里休眠的宿主仍登记着没关系 —— 光箱只用当前 route.name 去取。
 */
import { onMounted, onBeforeUnmount } from 'vue'

const hosts = new Map()

export function useTagHost(routeName, open) {
  onMounted(() => hosts.set(routeName, open))
  onBeforeUnmount(() => {
    if (hosts.get(routeName) === open) hosts.delete(routeName)
  })
}

/** 当前路由有宿主就就地打开, 返回 true; 否则 false(调用方走路由兜底) */
export function openTagInHost(routeName, tag) {
  const fn = hosts.get(routeName)
  if (!fn) return false
  fn(tag)
  return true
}
