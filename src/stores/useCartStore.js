/**
 * 角色购物车
 * ==========
 * 之前 series.html 和 cart.html 各写了一份 getCart/setCart, 从这里开始只有一份。
 * 数据结构与旧版一致 ({ tag: {tag,name,series,thumb,images,t} }), localStorage key 也沿用,
 * 所以用户原来攒的购物车直接可用。
 *
 * 顺带修掉了旧版一个坑: 路径里的反斜杠在 HTML 属性里会被吞掉,
 * 所以旧版要写个 fixCartThumb() 把历史记录里的那种被吞过的路径硬映射回真实路径。
 * 这里数据不再经过 HTML 属性, 不需要那个 hack。
 */
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '@/utils/api.js'
import { LS, readLS, writeLS } from '@/utils/lskey.js'

function load() {
  try {
    const o = JSON.parse(readLS(LS.cart.key) || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch { return {} }
}

export const useCartStore = defineStore('cart', () => {
  const items = ref(load())
  const drawerOpen = ref(false)

  const list = computed(() => Object.values(items.value))
  const count = computed(() => list.value.length)
  /** 按加入时间倒序(旧数据没有 t 字段的排最后) */
  const ordered = computed(() => [...list.value].sort((a, b) => (b.t || 0) - (a.t || 0)))

  watch(items, () => {
    writeLS(LS.cart.key, JSON.stringify(items.value))
  }, { deep: true })

  function has(tag) { return !!items.value[tag] }
  function add(c, series) {
    if (!c?.tag) return false
    if (items.value[c.tag]) return false
    items.value[c.tag] = {
      tag: c.tag,
      name: c.name,
      series: c.series || series || '',
      thumb: c.thumb || '',
      images: c.images ?? 0,
      t: Date.now(),
    }
    return true
  }
  function remove(tag) { delete items.value[tag] }
  function toggle(c, series) {
    if (items.value[c.tag]) { remove(c.tag); return false }
    add(c, series)
    return true
  }
  function replaceAll(cart) { items.value = cart && typeof cart === 'object' ? cart : {} }
  function clear() { items.value = {} }

  /**
   * 批量加入(选择模式用)。返回 {added, skipped}
   */
  function addMany(chars, series) {
    let added = 0, skipped = 0
    for (const c of chars) {
      if (items.value[c.tag]) { skipped++; continue }
      if (add(c, series)) added++
      else skipped++
    }
    return { added, skipped }
  }

  /** 导出 wildcard; save=true 时走原生「另存为」 */
  async function exportFile(save = true) {
    const tags = list.value.map((c) => c.tag)
    if (!tags.length) return { error: '购物车是空的' }
    return api.exportCart(tags, { save })
  }

  /** 结算: 导出 -> 存历史 -> 清空 */
  async function checkout(name) {
    const n = String(name || '').trim()
    if (!n) return { error: '请填写历史记录名称' }
    if (!list.value.length) return { error: '购物车是空的' }

    const ex = await api.exportCart(list.value.map((c) => c.tag), { save: true })
    if (ex?.canceled) return { canceled: true }
    if (ex?.error) return { error: ex.error }

    const r = await api.cartSave(n, JSON.parse(JSON.stringify(items.value)))
    if (r?.error) return { error: r.error }

    const cnt = list.value.length
    clear()
    return { ok: true, count: cnt, exported: ex?.path || '' }
  }

  return {
    items, list, ordered, count, drawerOpen,
    has, add, remove, toggle, replaceAll, clear, addMany,
    exportFile, checkout,
  }
})
