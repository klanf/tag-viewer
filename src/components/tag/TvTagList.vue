<script setup>
/**
 * 标签列表 —— TvTagPill 的容器
 * =======================
 * 接受两种输入:
 *   1. 纯字符串数组 ['1girl', 'blue_archive', ...]  + zhMap/banMap 两个可选映射
 *      (lightbox / 详情页的形态)
 *   2. 对象数组 [{tag, count, zh, banned, ban_rule}]
 *      (标签浏览页 /api/alltags 的形态)
 * 内部统一归一化, 所以这两处的渲染代码不用各写一遍。
 *
 * 另外把「鼠标悬停显示中文气泡」做成事件往外抛, 由全局的 tip 气泡接住 ——
 * 旧版是给每个 pill 单独挂 mouseover 监听, 一个 lightbox 里上百个标签就上百个监听器。
 */
import { computed } from 'vue'
import TvTagPill from './TvTagPill.vue'
import { isCharTag } from '@/utils/format.js'

const props = defineProps({
  tags: { type: Array, default: () => [] },
  zhMap: { type: Object, default: () => ({}) },
  banMap: { type: Object, default: () => ({}) },
  showBan: { type: Boolean, default: false },
  showCount: { type: Boolean, default: false },
  showZh: { type: Boolean, default: true },
  action: { type: String, default: 'copy' },
  size: { type: String, default: 'md' },
  /** 角色标签排最前(lightbox 的行为) */
  charsFirst: { type: Boolean, default: false },
  /** 空态文案 */
  emptyText: { type: String, default: '' },
  gap: { type: String, default: '5px' },
  /** 每行高度上限, 超出滚动 */
  maxHeight: { type: String, default: '' },
})
const emit = defineEmits(['click', 'ban', 'hover', 'leave'])

/** 归一化成统一对象 */
const items = computed(() => {
  const arr = props.tags || []
  const out = arr.map((t) => {
    if (t && typeof t === 'object') {
      return {
        tag: t.tag,
        zh: t.zh || props.zhMap[t.tag] || '',
        count: t.count ?? null,
        banned: !!t.banned,
        banRule: t.ban_rule || t.banRule || '',
      }
    }
    const b = props.banMap[t] || {}
    return {
      tag: t,
      zh: props.zhMap[t] || '',
      count: null,
      banned: !!b.banned,
      banRule: b.rule || '',
    }
  })
  if (props.charsFirst) {
    out.sort((a, b) => (isCharTag(b.tag) ? 1 : 0) - (isCharTag(a.tag) ? 1 : 0))
  }
  return out
})
</script>

<template>
  <!--
    单一根节点是刻意的: 根节点必须唯一, 父组件传下来的 class / 原生事件
    (例如 lightbox 的 @mousemove) 才能正常落到这个 div 上。
    之前写成 v-if / v-else 两个根节点 -> 变成 fragment, 传进来的 class 会被丢掉。
  -->
  <div
    class="tag-list"
    :style="{ gap, maxHeight: maxHeight || undefined }"
    @mouseleave="emit('leave')"
  >
    <TvTagPill
      v-for="it in items"
      :key="it.tag"
      :tag="it.tag"
      :zh="it.zh"
      :count="it.count"
      :banned="it.banned"
      :ban-rule="it.banRule"
      :show-ban="showBan"
      :show-count="showCount && it.count !== null"
      :show-zh="showZh"
      :action="action"
      :size="size"
      @click="(p) => emit('click', p)"
      @ban="(t) => emit('ban', t)"
      @mouseenter="emit('hover', { tag: it.tag, zh: it.zh, event: $event })"
    />
    <div v-if="!items.length && emptyText" class="empty-inline">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
.tag-list {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  overflow-y: auto;
  padding: 2px 0;
}
.empty-inline { color: var(--muted); font-size: 11px; padding: 6px 0; flex: 0 0 100%; }
</style>
