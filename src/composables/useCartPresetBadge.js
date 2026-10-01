/**
 * 「购物车自动导出」的状态点
 * ==========================
 * 抽屉(CartDrawer)与购物车页(CartView)各挂一个「⚙ 自动导出」按钮, 都需要知道:
 *   · 开着没有(开关 + 目录都设了才算真会导)
 *   · 开着、但当前购物车与"上次导出"不一致(这次更新还没导出去)
 *
 * 每次进页/拉开抽屉时**问一次主进程**, 不缓存 —— 配置可能在别处改过
 * (首页的「导出预设」弹窗里就有同一个面板), 缓存一份容易显示成过期状态:
 * 用户会看到"绿点亮着其实开关是关的", 转而怀疑自动导出没在工作。
 */
import { ref } from 'vue'
import { api } from '@/utils/api.js'

export function useCartPresetBadge() {
  const on = ref(false)
  const lag = ref(false)

  async function refresh() {
    try {
      const s = await api.cartPreset()
      on.value = !!(s?.enabled && s?.dir)
      lag.value = on.value && !s?.synced && !!s?.cartCount
    } catch {
      on.value = false
      lag.value = false
    }
  }

  /** 按钮 title: 说清"现在什么情况", 顺带说明点进去能改 */
  function title() {
    if (!on.value) return '购物车有更新就自动导出一份到指定目录'
    return lag.value
      ? '自动导出已开启 —— 购物车有更新，稍后会自动导出去'
      : '自动导出已开启（购物车与上次导出一致）'
  }

  return { on, lag, refresh, title }
}
