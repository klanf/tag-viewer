/**
 * 搜索历史(localStorage)
 * =======================
 * 最多保留 15 条, 重复的提到最前 —— 与旧版 loadHist/saveHist/pushHist 行为一致。
 * 旧的 `tagviewer_hist` 会在第一次读到时自动搬过来(见 utils/lskey.js)。
 *
 * **键是可传的**(2026-09-20): 首页搜索框和扫描页筛选框各存一份, 互不干扰 ——
 * 前者是"用户敲过的查询", 后者是"筛过的标签", 混在一起两边都变脏。
 * 默认仍是 `LS.searchHistory`(首页那份), 所以老的调用点一行都不用改。
 */
import { ref } from 'vue'
import { LS, readLS, writeLS } from '@/utils/lskey.js'

const MAX = 15

/**
 * @param {object} [entry] 键名条目 `{ key, old? }`, 取自 utils/lskey.js 的 LS 表。
 *   不要直接传字符串 —— 键名的唯一出处是那张表。
 */
export function useSearchHistory(entry = LS.searchHistory) {
  const list = ref([])
  let cur = entry || LS.searchHistory

  function load(e = cur) {
    cur = e || LS.searchHistory
    try {
      const a = JSON.parse(readLS(cur.key, cur.old) || '[]')
      list.value = Array.isArray(a) ? a : []
    } catch { list.value = [] }
    return list.value
  }

  function persist(arr) {
    list.value = arr.slice(0, MAX)
    writeLS(cur.key, JSON.stringify(list.value))
  }

  function push(q) {
    const v = String(q || '').trim()
    if (!v) return
    persist([v, ...list.value.filter((x) => x !== v)])
  }

  function remove(q) { persist(list.value.filter((x) => x !== q)) }
  function clear() { persist([]) }

  load(entry)

  return { list, push, remove, clear, load }
}
