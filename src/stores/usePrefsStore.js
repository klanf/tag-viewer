/**
 * 用户偏好(跨页面共享, 与旧版共用同一批 localStorage key)
 *  - bg_auto: 「缺背景时补背景标签」开关, 导出/复制都跟着它走
 *  - pageSize: 图片网格每页数量
 * 旧版的 key 原样沿用, 用户之前的选择不会丢。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const BG_KEY = 'tagviewer_bg_auto'
const TRASH_KEY = 'tagviewer_trash_ask'

export const usePrefsStore = defineStore('prefs', () => {
  const bgAuto = ref(localStorage.getItem(BG_KEY) !== '0')     // 默认开
  const gridPageSize = ref(60)
  const trashAsk = ref(localStorage.getItem(TRASH_KEY) !== '0') // 默认每次删除前询问

  watch(bgAuto, (v) => {
    try { localStorage.setItem(BG_KEY, v ? '1' : '0') } catch { /* 忽略 */ }
  })
  watch(trashAsk, (v) => {
    try { localStorage.setItem(TRASH_KEY, v ? '1' : '0') } catch { /* 忽略 */ }
  })

  /**
   * 勾选状态下且该图缺背景 -> 追加背景补全标签(与导出行为一致)。
   * index / series / tags / cart / detail 五个地方都要用, 所以放在这里。
   */
  function maybeAddBg(list, needsBg, bgAppend) {
    if (!bgAuto.value || !needsBg || !(bgAppend || []).length) return list
    const out = list.slice()
    for (const b of bgAppend) if (!out.includes(b)) out.push(b)
    return out
  }

  return { bgAuto, gridPageSize, trashAsk, maybeAddBg }
})
