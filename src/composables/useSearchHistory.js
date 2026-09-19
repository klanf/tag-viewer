/**
 * 搜索历史(localStorage, key 沿用旧版的 tagviewer_hist)
 * 最多保留 15 条, 重复的提到最前 —— 与旧版 loadHist/saveHist/pushHist 行为一致。
 */
import { ref } from 'vue'

const KEY = 'tagviewer_hist'
const MAX = 15

export function useSearchHistory() {
  const list = ref(load())

  function load() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY) || '[]')
      return Array.isArray(a) ? a : []
    } catch { return [] }
  }

  function persist(arr) {
    list.value = arr.slice(0, MAX)
    try { localStorage.setItem(KEY, JSON.stringify(list.value)) } catch { /* 忽略 */ }
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
