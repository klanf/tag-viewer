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
import TvButton from '../base/TvButton.vue'
import TvZoomBadge from '../base/TvZoomBadge.vue'
import { useJustifiedRows } from '@/composables/useJustifiedRows.js'
import { useGridZoom } from '@/composables/useGridZoom.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
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
  /** (item) => number 相似度, 返回 >0 时卡片左上角显示百分比(库内命中页) */
  simOf: { type: Function, default: null },
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

/* ── Ctrl+滚轮缩放网格(2026-10-20) ── 逻辑抽在 useGridZoom.js, 扫描页共用一份 */
const { zoom, zoomFlash, onWheel: onGridWheel, reset: resetZoom } = useGridZoom()
const effRowBase = computed(() => props.rowBase * zoom.value)
const { wrapEl, rows } = useJustifiedRows(shown, { base: effRowBase })

const sentinel = ref(null)
let io = null

const selectedSet = computed(() => {
  if (!props.selectedTags) return null
  return props.selectedTags instanceof Set ? props.selectedTags : new Set(props.selectedTags)
})

function isSelected(item) {
  const s = selectedSet.value
  if (!s) return false
  // 图片条目按 path 勾选(批量移动/删除); 也认 item.tag —— 预留给非图片条目的选择场景
  return s.has(item.path) || s.has(item.tag)
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
    <TvZoomBadge :zoom="zoom" :show="zoomFlash" @reset="resetZoom" />
    <TvState v-if="error" state="error" :text="`加载失败: ${error}`" />
    <TvState
      v-else-if="!shown.length && loading"
      state="loading"
      :text="loadingText"
    />
    <div v-else-if="allHidden" class="all-hidden">
      <TvState
        state="empty"
        :text="`这一批 ${nfmt(results.length)} 张都被安全模式隐藏了 —— 在工具栏关掉它就能看到`"
      />
      <!--
        整批都被藏时**没有网格、也就没有哨兵**, 无限滚动彻底停摆(2026-10-24 用户问到的死路)。
        不能改成"哨兵照挂、自动往下拉": 全库十万张里若安全图集中在后面, 会在几秒内
        连拉上千页。给个手动按钮, 拉一批看一批 —— 有能显示的图之后哨兵自然回来。
      -->
      <div v-if="infinite && hasMore" class="hidden-more">
        <TvButton size="sm" :loading="loading" @click="emit('load-more')">继续拉下一批</TvButton>
        <div class="hidden-tip">没有可显示的内容, 滚到底也不会自动加载; 点上面继续往后翻</div>
      </div>
      <div v-else-if="infinite" class="hidden-tip">已经到底了 —— 后面的图也都被藏了</div>
    </div>
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
            <!-- open/toggle-select 把原生事件带出去(2026-10-21): 批量选择要读
                 ctrlKey(浏览态 Ctrl+点=勾选)与 shiftKey(区间选); 旧调用方只收
                 第一个参数, 不受影响 -->
            <TvImageCard
              :item="c.item"
              fill
              :thumb-width="thumbWidth"
              :favable="favable"
              :favorited="favable && isFav(c.item.path)"
              :show-source="showSource"
              :sim="simOf ? (simOf(c.item) || 0) : 0"
              :tag-mode="tagMode"
              :footnote="footnote"
              :selectable="selectable"
              :selected="isSelected(c.item)"
              @open="(it, e) => emit('open', it, e)"
              @toggle-fav="(p) => emit('toggle-fav', p)"
              @toggle-select="(it, e) => emit('toggle-select', it, e)"
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
.all-hidden { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.hidden-more { display: flex; flex-direction: column; align-items: center; gap: 6px; padding-bottom: 12px; }
.hidden-tip { color: var(--faint); font-size: 11px; }
.more-msg {
  text-align: center; color: var(--muted); font-size: 12px;
  padding: 14px 0;
}
</style>
