/**
 * 搜索历史(localStorage, key `tv_search_hist`)
 * 最多保留 15 条, 重复的提到最前 —— 与旧版 loadHist/saveHist/pushHist 行为一致。
 * 旧的 `tagviewer_hist` 会在第一次读到时自动搬过来(见 utils/lskey.js)。
 */
import { ref } from 'vue'
import { LS, readLS, writeLS } from '@/utils/lskey.js'

const MAX = 15

export function useSearchHistory() {
  const list = ref(load())

  function load() {
    try {
      const a = JSON.parse(readLS(LS.searchHistory.key, LS.searchHistory.old) || '[]')
      return Array.isArray(a) ? a : []
    } catch { return [] }
  }

  function persist(arr) {
    list.value = arr.slice(0, MAX)
    writeLS(LS.searchHistory.key, JSON.stringify(list.value))
  }

  function push(q) {
    const v = String(q || '').trim()
    if (!v) return
    persist([v, ...list.value.filter((x) => x !== v)])
  }

  function remove(q) { persist(list.value.filter((x) => x !== q)) }
  function clear() { persist([]) }

  return { list, push, remove, clear }
}
