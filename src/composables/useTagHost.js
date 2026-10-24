/**
 * 「在来源页里就地打开子页面」的宿主登记
 * ======================================
 * 光箱是全局单例, 但它不知道当前视图有没有能力就地摊开子页面。这里让
 * 系列/看板/扫描/独立标签页在挂载时登记一个同路由名的处理器; 光箱点击时同步调用:
 * 有人接 = 不换路由, 就地叠一层; 没人接 = 回退到路由跳转(收藏/详情/购物车等)。
 *
 * 三类子页面各一份登记表(互不干扰):
 *   tag    —— 某标签的图片
 *   series —— 某系列的角色列表
 *   meta   —— 库内命中相似图(2026-10-24 补: 之前只能走路由, 一离开就把宿主的
 *             层级栈整个卸载了, 从扫描的叠层里跳出去再返回只剩文件夹)
 *
 * 同步调用是刻意的: 光箱要先知道"有没有接住"再决定要不要 router.push。
 * KeepAlive 里休眠的宿主仍登记着没关系 —— 光箱只用当前 route.name 去取。
 */
import { onMounted, onBeforeUnmount } from 'vue'

function makeRegistry() {
  const hosts = new Map()
  return {
    use(routeName, open) {
      onMounted(() => hosts.set(routeName, open))
      onBeforeUnmount(() => {
        if (hosts.get(routeName) === open) hosts.delete(routeName)
      })
    },
    open(routeName, key) {
      const fn = hosts.get(routeName)
      if (!fn) return false
      fn(key)
      return true
    },
  }
}

const tagHosts = makeRegistry()
const seriesHosts = makeRegistry()
const metaHosts = makeRegistry()

export function useTagHost(routeName, open) { tagHosts.use(routeName, open) }
export function useMetaHost(routeName, open) { metaHosts.use(routeName, open) }

/** 当前路由有宿主就就地打开, 返回 true; 否则 false(调用方走路由兜底) */
export function openTagInHost(routeName, tag) { return tagHosts.open(routeName, tag) }
export function openMetaInHost(routeName, src) { return metaHosts.open(routeName, src) }
