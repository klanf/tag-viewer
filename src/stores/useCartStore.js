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

/**
 * 附加标签归一(2026-10-01): 字符串或数组都行, 按逗号拆、去空白、去重、封顶 30 个。
 * 用途: 给购物车条目追加 tag(如给哥伦比亚追加 closed_eyes), 导出时拼在同一行。
 */
export function normExtra(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(',')
  const out = []
  for (const x of raw) {
    const t = String(x || '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, 30)
}

export const useCartStore = defineStore('cart', () => {
  const items = ref(load())
  const drawerOpen = ref(false)

  const list = computed(() => Object.values(items.value))
  const count = computed(() => list.value.length)
  /** 已入车的标签名集合(角色 pill 点 🛒 状态用) */
  const keys = computed(() => Object.keys(items.value))
  /** 按加入时间倒序(旧数据没有 t 字段的排最后) */
  const ordered = computed(() => [...list.value].sort((a, b) => (b.t || 0) - (a.t || 0)))

  watch(items, () => {
    writeLS(LS.cart.key, JSON.stringify(items.value))
    /**
     * 上报主进程 —— 「购物车有更新就自动导出一份」的预设靠这个触发。
     * ============================================================
     * 挂在这里(而不是各个界面上)是刻意的: 购物车有六个改动入口 —— 标签详情页的
     * 「角色」区 pill、光箱 pill、系列页卡片/批量加入、购物车页与抽屉的删除清空、
     * 结算后自动清空、历史载入整体替换。挂 store 一次全覆盖, 以后加新入口也不会漏。
     *
     * **条目整包上报**(tag + extra): 2026-10-01 起条目可以带附加标签,
     * 附加变了导出的行文本就变了, 指纹和自动导出都必须跟着走 —— 只报 tag 会漏。
     *
     * 顺序 = list 的顺序(Object.values 的插入序), 与「导出全部」写文件时一字不差 ——
     * 主进程拿这个顺序算指纹, 所以"移出再放回来"也算内容变了(文件行序真的变了)。
     *
     * 上报是**附带动作**: 失败(比如正在退出、浏览器降级)只吞掉, 绝不影响购物车本身。
     */
    api.cartChanged(Object.values(items.value).map((c) => ({
      tag: c.tag,
      extra: Array.isArray(c.extra) ? c.extra : [],
    }))).catch(() => {})
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

  /**
   * 改某条目的附加标签(编辑弹窗用)。归一后写回; 空数组 = 清掉附加。
   * watch(items, deep) 会自动: 持久化 + 上报主进程重算自动导出指纹。
   */
  function setExtra(tag, extra) {
    const it = items.value[tag]
    if (!it) return
    it.extra = normExtra(extra)
  }

  /**
   * 单条目的 wildcard 行文本(wildcardLine / 复制到剪贴板用)。
   * spaces=false 是「复制」按钮的老口径(保留下划线); spaces=true 与导出文件一致。
   */
  function wildcardLine(item, { spaces = false } = {}) {
    if (!item) return ''
    const esc = (t) => {
      let s = String(t).replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      if (spaces) s = s.replace(/_/g, ' ')
      return s
    }
    const extras = Array.isArray(item.extra) ? item.extra : []
    return [esc(item.tag), ...extras.map((x) => esc(x))].join(', ')
  }
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

  /** 导出 wildcard; save=true 时走原生「另存为」。条目整包传(tag+extra), 附加标签跟行走 */
  /* 角色表用哪套替换规则(2026-10-04 规则组)。localStorage 记忆, 跟看板/预设
     各选各的 —— 三处是三个独立场景, 用同一套反而不一定对。 */
  const replaceSet = ref(readLS(LS.cartReplaceSet.key, ''))
  watch(replaceSet, (v) => writeLS(LS.cartReplaceSet.key, String(v || '')))

  async function exportFile(save = true) {
    const entries = list.value.map((c) => ({ tag: c.tag, extra: Array.isArray(c.extra) ? c.extra : [] }))
    if (!entries.length) return { error: '购物车是空的' }
    return api.exportCart(entries, { save, replace_set: replaceSet.value })
  }

  /** 结算: 导出 -> 存历史 -> 清空 */
  async function checkout(name) {
    const n = String(name || '').trim()
    if (!n) return { error: '请填写历史记录名称' }
    if (!list.value.length) return { error: '购物车是空的' }

    const ex = await api.exportCart(
      list.value.map((c) => ({ tag: c.tag, extra: Array.isArray(c.extra) ? c.extra : [] })),
      { save: true, replace_set: replaceSet.value })
    if (ex?.canceled) return { canceled: true }
    if (ex?.error) return { error: ex.error }

    const r = await api.cartSave(n, JSON.parse(JSON.stringify(items.value)))
    if (r?.error) return { error: r.error }

    const cnt = list.value.length
    clear()
    return { ok: true, count: cnt, exported: ex?.path || '' }
  }

  /**
   * 换某条目的缩略图(2026-10-02): 原文件没了(加载失败)或当前是横图想换竖图时,
   * TvCartItem 搜到更合适的图后写回这里 —— watch(items, deep) 自动持久化。
   * 注意: 自动导出指纹(cartPreset.fingerprint)只含 tag+extra, 换缩略图**不会**触发导出。
   */
  function setThumb(tag, thumb) {
    const it = items.value[tag]
    if (!it || !thumb || it.thumb === thumb) return
    it.thumb = thumb
  }

  return {
    items, list, ordered, count, keys, drawerOpen,
    has, add, remove, setExtra, setThumb, wildcardLine, toggle, replaceAll, clear, addMany,
    exportFile, checkout, replaceSet,
  }
})
