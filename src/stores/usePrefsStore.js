/**
 * 用户偏好(跨页面共享)
 *  - bg_auto: 「缺背景时补背景标签」开关, 导出/复制都跟着它走
 *  - pageSize: 图片网格每页数量
 * 键名统一 `tv_*`(见 utils/lskey.js); 旧版的 tagviewer_* 会在第一次读到时
 * 自动搬到新键, 所以用户之前的选择不会丢。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { LS, readLS, writeLS } from '@/utils/lskey.js'

export const usePrefsStore = defineStore('prefs', () => {
  const bgAuto = ref(readLS(LS.bgAuto.key, LS.bgAuto.old) !== '0')          // 默认开
  const gridPageSize = ref(60)
  const trashAsk = ref(readLS(LS.trashAsk.key, LS.trashAsk.old) !== '0')    // 默认每次删除前询问

  watch(bgAuto, (v) => writeLS(LS.bgAuto.key, v ? '1' : '0'))
  watch(trashAsk, (v) => writeLS(LS.trashAsk.key, v ? '1' : '0'))

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
