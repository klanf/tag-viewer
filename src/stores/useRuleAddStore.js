/**
 * 「看图时发现错 tag → 右键直接加进替换规则」的全局通道
 * =====================================================
 * TvTagPill 右键 → requestAdd(tag) → App.vue 里挂的全局 TvRulesEditorModal
 * (kind=replace)以构建器模式打开并预填一条「精确 + 保留原标签」的行,
 * 用户联想补上替换标签、选好组、保存 —— 全程不用手打符号。
 * 黑名单走 pill 上已有的 🚫(blacklistToggle), 这里不重复。
 */
import { defineStore } from 'pinia'

export const useRuleAddStore = defineStore('ruleAdd', {
  state: () => ({
    open: false,
    /** {core: tag, keep: true} —— 编辑器 load() 消费一次 */
    prefill: null,
  }),
  actions: {
    requestAdd(tag) {
      this.prefill = { core: String(tag || ''), keep: true }
      this.open = true
    },
    closed() {
      this.open = false
      this.prefill = null   // 用完即清: 避免下次从工具栏打开时又多插一行
    },
  },
})
