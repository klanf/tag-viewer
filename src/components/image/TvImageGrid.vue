<script setup>
/**
 * 图片网格 —— 首页 / 系列页 / 标签页 / 收藏页共用
 * =============================================
 * 把「渲染卡片 + 三种状态 + 无限滚动哨兵」收在一起。页面只负责喂数据。
 *
 * 排布方式(2026-09-23 改): **自适应行高**(justified rows), 见
 * composables/useJustifiedRows.js 的说明 —— 每行按图片真实比例铺满, 行高自适应,
 * 一行都不留空洞, 而且一张图都不裁。改之前是 CSS grid 按行对齐, 横图下方必然空一片。
 *
 * 安全模式也在这一层过滤(只影响展示): 传进来的 `results` 先过一遍安全模式, 于是
 *   · 网格里少掉的图不占格子;
 *   · 页脚那句「已经到底了(共 N 张)」里的 N 是**过滤后**的真实张数;
 *   · 各视图传给光箱的翻页序列用的是同一个过滤结果(见各视图的 imgPaths)。
 *
 * 无限滚动用 IntersectionObserver, rootMargin 600px —— 与旧版 setupInfiniteLoad 的
 * 600px 保持一致, 用户滚到还有半屏时就开始加载, 体感是"无缝"的。
 */
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import TvImageCard from './TvImageCard.vue'
import TvState from '../base/TvState.vue'
import { useJustifiedRows } from '@/composables/useJustifiedRows.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { readLS, writeLS, LS } from '@/utils/lskey.js'
import { nfmt } from '@/utils/format.js'

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
  /** 「竖图目标宽度」: 自适应行高下竖图大约这么宽(默认与原 --grid-min 一致) */
  rowBase: { type: Number, default: 150 },
})
const emit = defineEmits(['open', 'toggle-fav', 'toggle-select', 'load-more', 'hover', 'move', 'leave'])

/* 安全模式: 只做展示层过滤, 数据集/统计数字一个都不动(关掉立刻全回来) */
const safety = useSafetyStore()

/** 真正渲染的列表 = 传进来的结果过一遍安全模式 */
const shown = computed(() => safety.filterItems(props.results))
/** 有图, 但全被安全模式藏掉了 —— 得明确告诉用户, 否则看起来像"搜不到" */
const allHidden = computed(() => (
  !!props.results.length && !shown.value.length && safety.on
))

/* ── Ctrl+滚轮缩放网格(2026-10-20, 与光箱缩放同一套手感) ─────────────────
 * 调的是 useJustifiedRows 的行高基准(base × zoom), 不是 transform:scale ——
 * 后者会把卡片糊掉且不重排; 前者是真·重新排版, 字号/留白比例都保持正常。
 *
 * 倍率范围由 buildRows 的行高上下限反推: targetH = base×16/9 被夹在 [120,600],
 * base 默认 150 → 有效倍率 [0.45, 2.25], 超出只会"顶到底不再变化", 没必要放行。
 * 步进 ×1.12 与光箱一致; 滚一档记一次 localStorage, 看板/标签/收藏/系列四个
 * 页面共用同一份(它们本来就是同一张卡片同一套审美, 没理由各记各的)。
 */
const ZOOM_MIN = 0.45
const ZOOM_MAX = 2.25
const ZOOM_STEP = 1.12

function clampZoom(v) {
  const n = Number(v)
  return (n >= ZOOM_MIN && n <= ZOOM_MAX) ? n : 1
}
const zoom = ref(clampZoom(readLS(LS.gridZoom.key)))
const effRowBase = computed(() => props.rowBase * zoom.value)
const { wrapEl, rows } = useJustifiedRows(shown, { base: effRowBase })

/** 缩放时的提示徽标: 显示当前百分比, 停手 900ms 后淡出; 点击恢复 100% */
const zoomFlash = ref(false)
let flashTimer = null
function flashZoom() {
  zoomFlash.value = true
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { zoomFlash.value = false }, 900)
}
function onGridWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return    // 普通滚动照常滚列表
  e.preventDefault()                       // 拦下 Electron 的页面级 Ctrl+滚轮缩放
  const f = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom.value * f * 100) / 100))
  if (next !== zoom.value) {
    zoom.value = next
    writeLS(LS.gridZoom.key, next)
  }
  flashZoom()   // 顶到边界也给个反馈, 不然"没反应"像是坏了
}
function resetZoom() {
  if (zoom.value === 1) return
  zoom.value = 1
  writeLS(LS.gridZoom.key, 1)
  flashZoom()
}
onBeforeUnmount(() => clearTimeout(flashTimer))

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
  <div ref="wrapEl" class="wrap-grid" @wheel="onGridWheel">
    <!-- Ctrl+滚轮缩放提示徽标: 停手即淡出, 点击恢复 100% -->
    <Transition name="zoomfade">
      <div
        v-if="zoomFlash"
        class="zoom-badge"
        title="Ctrl+滚轮缩放网格 · 点击恢复 100%"
        @click="resetZoom"
      >{{ Math.round(zoom * 100) }}%</div>
    </Transition>
    <TvState v-if="error" state="error" :text="`加载失败: ${error}`" />
    <TvState
      v-else-if="!shown.length && loading"
      state="loading"
      :text="loadingText"
    />
    <TvState
      v-else-if="allHidden"
      state="empty"
      :text="`${nfmt(results.length)} 张都被安全模式隐藏了 —— 在工具栏关掉它就能看到`"
    />
    <TvState
      v-else-if="!shown.length && loadedOnce"
      state="empty"
      :text="emptyText"
    />
    <TvState
      v-else-if="!shown.length"
      state="empty"
      text=""
    />
    <template v-else>
      <div class="grid jrows">
        <div v-for="(row, ri) in rows" :key="ri" class="jrow">
          <div
            v-for="(c, ci) in row.cells"
            :key="itemKey(c.item, ci)"
            class="jcell"
            :style="{ width: `${c.w}px`, '--img-h': `${row.h}px` }"
          >
            <TvImageCard
              :item="c.item"
              fill
              :thumb-width="thumbWidth"
              :favable="favable"
              :favorited="favable && isFav(c.item.path)"
              :show-source="showSource"
              :tag-mode="tagMode"
              :footnote="footnote"
              :selectable="selectable"
              :selected="isSelected(c.item)"
              @open="(it) => emit('open', it)"
              @toggle-fav="(p) => emit('toggle-fav', p)"
              @toggle-select="(it) => emit('toggle-select', it)"
              @hover="onHover"
              @move="(e) => emit('move', e)"
              @leave="emit('leave')"
            />
          </div>
        </div>
      </div>
      <!-- 无限滚动哨兵 -->
      <div ref="sentinel" class="sentinel" />
      <div v-if="loading && shown.length" class="more-msg">加载中...</div>
      <div v-else-if="infinite && !hasMore && shown.length" class="more-msg">
        已经到底了(共 {{ nfmt(shown.length) }} 张)
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

/* 缩放徽标: 底部居中的小药丸, 与光箱的缩放徽标同一套观感 */
.zoom-badge {
  position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
  z-index: 70;
  background: rgba(10, 13, 18, .85); color: var(--text);
  font-size: 12px; padding: 5px 13px; border-radius: 999px;
  border: 1px solid var(--border);
  cursor: pointer; user-select: none;
}
.zoomfade-enter-active, .zoomfade-leave-active { transition: opacity .18s ease; }
.zoomfade-enter-from, .zoomfade-leave-to { opacity: 0; }
</style>
