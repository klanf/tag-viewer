/**
 * 标签收藏 —— 用户常复用的提示词标签
 * ====================================
 * 与「图片收藏」(useFavStore, 存的是路径) 是两回事: 这里存的是**标签名**,
 * 典型用途是把顺手的画风/服饰/构图标签攒起来, 复制提示词时一眼找到。
 *
 * 存储: localStorage `tv_tag_favs`(JSON 字符串数组) —— 纯前端偏好, 不进主进程,
 * 与「隐藏已ban」「无图角色开关」同一档(见 utils/lskey.js 的分层)。
 *
 * 消费方:
 *   · 光箱(TvLightbox)的标签 pill —— ★ 一键收藏/取消
 *   · 标签页(TagsView) —— 「★ 只看收藏」开关 + pill 上直接 ★
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { LS, readLS, writeLS } from '@/utils/lskey.js'
import { useUiStore } from './useUiStore.js'

export const useTagFavStore = defineStore('tagFav', () => {
  function load() {
    try {
      const arr = JSON.parse(readLS(LS.tagFavs.key) || '[]')
      return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string' && t) : []
    } catch { return [] }   // 坏数据当空, 不至于整个 store 起不来
  }

  /** Set 保查找 O(1); 整体替换引用是为了让 computed(如 list) 稳定刷新 */
  const favs = ref(new Set(load()))
  const list = computed(() => [...favs.value])

  function has(tag) { return favs.value.has(tag) }

  function save() {
    writeLS(LS.tagFavs.key, JSON.stringify([...favs.value].sort()))
  }

  /** @returns {boolean} true=加入了收藏 */
  function toggle(tag) {
    if (!tag) return false
    const ui = useUiStore()
    let added
    if (favs.value.has(tag)) {
      favs.value.delete(tag)
      added = false
    } else {
      favs.value.add(tag)
      added = true
    }
    favs.value = new Set(favs.value)
    save()
    ui.ok(added ? `★ 已收藏标签: ${tag}` : `已取消收藏标签: ${tag}`, 'ok', 1400)
    return added
  }

  return { favs, list, has, toggle }
})
