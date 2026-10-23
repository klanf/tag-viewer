/**
 * 把视图的当前层级注册进路径栏
 * ============================
 * getCrumbs 是一个 computed 工厂: 层级/筛选一变就重算, watcher 把新数组写进 store。
 * 只认"当前路由就是自己"的时候写入 —— KeepAlive 里休眠的页面也会重算, 不能去覆盖
 * 别的页面的路径栏。
 *
 * onActivated 再同步一次: 休眠期间内部状态也可能被外部改(比如来源切换重载)。
 */
import { watch, onActivated, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { usePathStore } from '@/stores/usePathStore.js'

export function usePagePath(owner, getCrumbs) {
  const route = useRoute()
  const store = usePathStore()

  /* 调用方传的是 computed(响应式 ref), 不是函数 —— 直接 getCrumbs() 会把
     Proxy 当函数调, 抛 "not a function" 且 store 永远写不进去(路径栏整条消失)。
     两种都收: 函数照旧调, ref 取 .value。 */
  const read = () => (typeof getCrumbs === 'function' ? getCrumbs() : getCrumbs.value)

  const sync = () => {
    if (route.name !== owner) return
    const crumbs = read()
    if (Array.isArray(crumbs) && crumbs.length) store.set(owner, crumbs)
    else store.clear(owner)
  }

  watch(getCrumbs, sync, { immediate: true })
  onActivated(sync)
  onBeforeUnmount(() => store.clear(owner))
}
