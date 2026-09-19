<script setup>
/**
 * 图片网格 —— 首页 / 系列页 / 标签页 / 扫描页共用
 * ===========================================
 * 把「渲染卡片 + 三种状态 + 无限滚动哨兵」收在一起。页面只负责喂数据。
 *
 * 无限滚动用 IntersectionObserver, rootMargin 600px ——
 * 与旧版 setupInfiniteLoad 的 600px 保持一致, 用户滚到还有半屏时就开始加载,
 * 体感是"无缝"的。
 */
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import TvImageCard from './TvImageCard.vue'
import TvState from '../base/TvState.vue'

const props = defineProps({
  results: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  /** 是否已经加载过(用来区分"还没搜"和"搜了没结果") */
  loadedOnce: { type: Boolean, default: false },
  /** 无限滚动模式(否则由父组件渲染分页条) */
  infinite: { type: Boolean, default: false },
  hasMore: { type: Boolean, default: false },
  favable: { type: Boolean, default: false },
  /** (path) => boolean */
  isFav: { type: Function, default: () => false },
  tagMode: { type: String, default: 'head' },
  thumbWidth: { type: Number, default: 400 },
  footnote: { type: String, default: 'path' },
  showSource: { type: Boolean, default: false },
  selectable: { type: Boolean, default: false },
  /** Set<string> 或数组 */
  selectedTags: { type: [Object, Array], default: null },
  emptyText: { type: String, default: '没有匹配的图片' },
  loadingText: { type: String, default: '加载中...' },
  gridMin: { type: String, default: '' },
})
const emit = defineEmits(['open', 'toggle-fav', 'toggle-select', 'load-more', 'hover', 'move', 'leave'])

const sentinel = ref(null)
let io = null

const selectedSet = computed(() => {
  if (!props.selectedTags) return null
  return props.selectedTags instanceof Set ? props.selectedTags : new Set(props.selectedTags)
})

function isSelected(item) {
  const s = selectedSet.value
  return s ? s.has(item.tag) : false
}

function itemKey(item, i) {
  return item.path || item.tag || i
}

function connect() {
  io?.disconnect()
  io = null
  if (!props.infinite || !sentinel.value) return
  io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && props.hasMore && !props.loading) emit('load-more')
  }, { rootMargin: '600px 0px' })
  io.observe(sentinel.value)
}

onMounted(connect)
onBeforeUnmount(() => io?.disconnect())
watch(() => [props.infinite, props.hasMore, props.loading], () => {
  // 哨兵位置/条件变了要重连, 否则 hasMore 从 false 变 true 时不会再触发
  setTimeout(connect, 0)
})

/** 卡片悬停 -> 交给全局气泡 */
function onHover(payload) {
  emit('hover', { text: payload.text, event: payload.event })
}
</script>

<template>
  <div class="wrap-grid">
    <TvState v-if="error" state="error" :text="`加载失败: ${error}`" />
    <TvState
      v-else-if="!results.length && loading"
      state="loading"
      :text="loadingText"
    />
    <TvState
      v-else-if="!results.length && loadedOnce"
      state="empty"
      :text="emptyText"
    />
    <TvState
      v-else-if="!results.length"
      state="empty"
      text=""
    />
    <template v-else>
      <div class="grid" :style="gridMin ? { '--grid-min': gridMin } : undefined">
        <TvImageCard
          v-for="(item, i) in results"
          :key="itemKey(item, i)"
          :item="item"
          :thumb-width="thumbWidth"
          :favable="favable"
          :favorited="favable && isFav(item.path)"
          :show-source="showSource"
          :tag-mode="tagMode"
          :footnote="footnote"
          :selectable="selectable"
          :selected="isSelected(item)"
          @open="(it) => emit('open', it)"
          @toggle-fav="(p) => emit('toggle-fav', p)"
          @toggle-select="(it) => emit('toggle-select', it)"
          @hover="onHover"
          @move="(e) => emit('move', e)"
          @leave="emit('leave')"
        />
      </div>
      <!-- 无限滚动哨兵 -->
      <div ref="sentinel" class="sentinel" />
      <div v-if="loading && results.length" class="more-msg">加载中...</div>
      <div v-else-if="infinite && !hasMore && results.length" class="more-msg">
        已经到底了(共 {{ results.length }} 张)
      </div>
    </template>
    <!-- 分页模式由父组件把分页条放进这个插槽 -->
    <slot />
  </div>
</template>

<style scoped>
.wrap-grid { min-height: 0; }
.sentinel { height: 2px; }
.more-msg {
  text-align: center; color: var(--muted); font-size: 12px;
  padding: 14px 0;
}
</style>
