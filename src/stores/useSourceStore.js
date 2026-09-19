/**
 * 来源(多文件夹)过滤器 —— 首页与系列页共用同一份选择
 * ==================================================
 * 语义与旧版一致: 空数组 = 全部; 点单个来源累加, 再点一次取消; 点「全部」重置。
 * 不选任何来源 = 不过滤, 后端会走全局缓存(最快)。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/utils/api.js'

export const useSourceStore = defineStore('source', () => {
  const selected = ref([])      // 空 = 全部
  const list = ref([])          // [{name, images}]
  const totalImages = ref(0)

  const isAll = computed(() => selected.value.length === 0)
  const label = computed(() => (isAll.value ? '全部' : selected.value.join('、')))

  function isActive(name) {
    return name === '全部' ? isAll.value : selected.value.includes(name)
  }

  function toggle(name) {
    if (name === '全部') {
      selected.value = []
    } else {
      const i = selected.value.indexOf(name)
      if (i >= 0) selected.value.splice(i, 1)
      else selected.value.push(name)
    }
  }

  function reset() { selected.value = [] }

  async function load() {
    const st = await api.stats({})
    list.value = st.sources || []
    totalImages.value = st.total_images || 0
  }

  /** 拼进请求参数的形式: 逗号分隔字符串, 空则不带 */
  const param = computed(() => (selected.value.length ? selected.value.join(',') : undefined))

  return { selected, list, totalImages, isAll, label, isActive, toggle, reset, load, param }
})
