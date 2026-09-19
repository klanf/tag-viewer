/** 顶部的提示条 + 跟随鼠标的标签气泡 —— 全站唯一实例, 谁都能调 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/utils/api.js'

export const useUiStore = defineStore('ui', () => {
  const toastText = ref('')
  const toastOn = ref(false)
  const toastTone = ref('info')       // info | ok | err | warn
  let toastTimer = null

  function toast(msg, tone = 'info', dur = 1800) {
    toastText.value = String(msg ?? '')
    toastTone.value = tone
    toastOn.value = true
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastOn.value = false }, dur)
  }
  const ok = (m, d) => toast(m, 'ok', d)
  const err = (m, d) => toast(m, 'err', d ?? 3000)
  const warn = (m, d) => toast(m, 'warn', d ?? 2600)

  /* ---------- 跟随鼠标的标签气泡 ---------- */
  const tipText = ref('')
  const tipOn = ref(false)
  const tipPos = ref({ x: 0, y: 0 })

  function showTip(text, e) {
    tipText.value = text || ''
    if (!tipText.value) return
    tipOn.value = true
    moveTip(e)
  }
  function moveTip(e) {
    if (!tipOn.value || !e) return
    // 鼠标右下方; 贴到视口边缘就翻到另一侧
    const tw = 340, th = 220        // 用上限估算, 免得先渲染再测量导致抖动
    let x = e.clientX + 16
    let y = e.clientY + 16
    if (x + tw > window.innerWidth - 8) x = Math.max(8, e.clientX - tw - 16)
    if (y + th > window.innerHeight - 8) y = Math.max(8, e.clientY - th - 16)
    tipPos.value = { x, y }
  }
  function hideTip() { tipOn.value = false }

  /** 复制并给出统一反馈 */
  async function copy(text, label) {
    const t = String(text ?? '')
    if (!t) return
    try {
      await api.copy(t)
      const head = t.slice(0, 40) + (t.length > 40 ? '...' : '')
      toast(label ? `✅ ${label}` : `✅ 已复制: ${head}`, 'ok', 1600)
    } catch (e) {
      toast('复制失败: ' + e.message, 'err')
    }
  }

  return {
    toastText, toastOn, toastTone, toast, ok, err, warn,
    tipText, tipOn, tipPos, showTip, moveTip, hideTip,
    copy,
  }
})
