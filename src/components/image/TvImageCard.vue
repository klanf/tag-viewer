<script setup>
/**
 * 图片卡片 —— 首页 / 系列页 / 标签页 / 扫描页共用的网格单元
 * ======================================================
 * 旧版这些卡片在 4 个地方各写了一遍 innerHTML, 差异只有:
 *   - 首页多一个 ☆ 收藏按钮
 *   - 扫描页多一个"来源"角标, 标签区换成 key_tags 高亮角色标签
 *   - 系列/标签页没有收藏按钮
 * 所以这里把「收藏按钮」「角标」「标签渲染方式」都做成可选 props。
 */
import { computed, onMounted, ref } from 'vue'
import TvImage from '../base/TvImage.vue'
import { clipTags, shortPath } from '@/utils/format.js'
import { useImageCtxMenu } from '@/composables/useImageCtxMenu.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

const props = defineProps({
  /** {path, tags} 或扫描页的 {path, tags, source, key_tags, chars} */
  item: { type: Object, required: true },
  /** 缩略图宽度(200/300/400 三档, 与旧版 .thumb_cache 命名对齐) */
  thumbWidth: { type: Number, default: 400 },
  /** 显示 ☆ 收藏按钮 */
  favable: { type: Boolean, default: false },
  favorited: { type: Boolean, default: false },
  /** 显示右下角来源角标(扫描页用) */
  showSource: { type: Boolean, default: false },
  /** 标签展示方式: head=前 N 个 / keys=角色标签高亮 + 独有标签(扫描页) */
  tagMode: { type: String, default: 'head' },
  /** 标签中文映射(可选): keys 模式下有就显示中文, 没有回退英文原文 */
  tagZhMap: { type: Object, default: () => ({}) },
  /** head 模式显示几个 */
  tagLimit: { type: Number, default: 8 },
  /** 卡片底部显示什么: path | name | none */
  footnote: { type: String, default: 'path' },
  /** 悬停气泡里显示几个标签 */
  tipLimit: { type: Number, default: 14 },
  /** 选择模式下的勾选态 */
  selectable: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
})
const emit = defineEmits(['open', 'toggle-fav', 'toggle-select', 'hover', 'move', 'leave'])

const path = computed(() => props.item.path || '')

/** 失效收藏: prop 显式传, 或数据里带 _missing 标记(网格不用加新的透传 prop) */
const isMissing = computed(() => props.missing || !!props.item._missing)

/* 上次在光箱里看过的那张 -> 绿色描边(跟随光箱翻页实时移动, 关掉后保留)。
 * 直接读光箱 store 而不是加 prop: 首页/系列/标签/扫描四个网格一行都不用改,
 * 以后新视图只要用这张卡片就自动带上这个行为。 */
const lb = useLightboxStore()
const isLastViewed = computed(() => !!lb.lastPath && lb.lastPath === path.value)

/* 绿框持久化后的"找回"一步: 应用重启(或翻页/进文件夹后绿框那张第一次被渲染)时,
 * 自动把它滚进视野居中, 然后清掉 scrollPending —— 只滚这一次, 之后不再打扰。
 * 光箱 close() 里的滚动(block:'nearest')负责"关掉就回到原地"; 这里负责
 * "重启/首次渲染时主动找到它"。 */
const rootEl = ref(null)
onMounted(() => {
  if (isLastViewed.value && lb.scrollPending) {
    lb.scrollPending = false
    rootEl.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }
})

const tags = computed(() => props.item.tags || [])

const tipText = computed(() => {
  const t = tags.value
  if (!t.length) return '(无标签)'
  return clipTags(t, props.tipLimit)
})

/** 扫描页的 key_tags 展示: 角色标签单独着色, 其余是"这张图独有"的内容标签 */
const keyParts = computed(() => {
  const z = (t) => props.tagZhMap[t] || t
  const key = (props.item.key_tags || []).map(z)
  const nChar = (props.item.chars || []).length
  return { head: key.slice(0, nChar).join(', '), rest: key.slice(nChar, nChar + 12).join(', ') }
})

const footText = computed(() => {
  if (props.footnote === 'none') return ''
  if (props.footnote === 'name') return props.item.name || ''
  return shortPath(path.value)
})

const hasTags = computed(() => tags.value.length > 0)

/* 右键菜单: 复制图片/标签/路径、打开所在位置、详情页、收藏(主进程弹原生菜单) */
const ctxMenu = useImageCtxMenu()
function onCtx(e) {
  ctxMenu.open(e, {
    path: path.value,
    tags: tags.value,
    name: props.item.name,
    favable: props.favable,
    favorited: props.favorited,
  })
}
</script>

<template>
  <div
    ref="rootEl"
    :class="['card', { selected, 'has-sel': selectable, 'last-viewed': isLastViewed, 'is-missing': isMissing }]"
    :title="isMissing ? '文件已不在原位置 —— 可能把图移走了; 收藏已保留, 打开收藏页时会按文件名自动找回' : (selectable ? '点击勾选/取消' : (isLastViewed ? '上次看到这张(绿色描边) · 点击预览大图与标签' : '点击预览大图与标签'))"
    @click="emit('open', item)"
    @contextmenu="onCtx"
    @mouseenter="emit('hover', { text: tipText, event: $event })"
    @mousemove="emit('move', $event)"
    @mouseleave="emit('leave')"
  >
    <!-- 发整个 item: 收藏记录要存标签快照, 只有 path 不够(2026-09-19) -->
    <button
      v-if="favable"
      :class="['fav', { on: favorited }]"
      :title="favorited ? '取消收藏' : '收藏'"
      @click.stop="emit('toggle-fav', item)"
    >{{ favorited ? '★' : '☆' }}</button>

    <span v-if="selectable" class="ckbox" @click.stop="emit('toggle-select', item)">
      <input type="checkbox" :checked="selected" @click.stop="emit('toggle-select', item)">
    </span>

    <!-- 失效收藏不请求缩略图: 路径已失效, 请求必然 404(还会打红 e2e 的控制台总闸) -->
    <TvImage v-if="!isMissing" :path="path" :width="thumbWidth" :alt="item.name || path" />
    <span v-else class="tv-img gone-ph" />

    <span v-if="showSource && item.source" class="src">{{ item.source }}</span>

    <!-- 标签区 -->
    <div v-if="tagMode === 'keys'" class="tags keys">
      <template v-if="!hasTags">
        <span class="none">(无提示词元数据)</span>
      </template>
      <template v-else-if="!keyParts.head && !keyParts.rest">
        <span class="none">(标签与本批其他图相同)</span>
      </template>
      <template v-else>
        <span v-if="keyParts.head" class="ch">{{ keyParts.head }}</span>
        <span v-if="keyParts.head && keyParts.rest"> · </span>
        <span>{{ keyParts.rest }}</span>
      </template>
    </div>
    <div v-else class="tags">
      {{ tags.slice(0, tagLimit).join(', ') }}
    </div>

    <div v-if="footText" class="foot" :title="path">{{ footText }}</div>
    <span v-if="isMissing" class="gone">文件已不在</span>
    <slot />
  </div>
</template>

<style scoped>
.card {
  position: relative;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.card:hover { border-color: var(--accent); }
.card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft) inset; }

/* 上次看过的图(光箱关掉后靠它找回位置): 绿色描边 + 淡淡的绿色光晕,
 * 颜色用 --accent2(本主题的"成功/OK"绿), 与悬停/选中的蓝色区分开。
 * 放在 :hover 规则之后 —— 悬停变蓝是瞬时反馈, 绿框是持久标记, 绿框优先。 */
.card.last-viewed {
  border-color: var(--accent2);
  box-shadow: 0 0 0 2px var(--accent2-soft) inset, 0 0 10px rgba(126, 231, 135, .22);
}
.card.last-viewed:hover { border-color: var(--accent2); }

/* 失效收藏: 整卡去色 + 角标, 记录保留(找回/还原后自动恢复正常显示) */
.card.is-missing { opacity: .45; }
.card.is-missing img { filter: grayscale(1); }
.gone {
  position: absolute; top: 6px; left: 6px; z-index: 5;
  background: rgba(10, 13, 18, .85); color: var(--muted);
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  border: 1px solid var(--border);
}
.gone-ph {
  display: block; width: 100%; aspect-ratio: 9 / 16;
  background: var(--panel3);
}

/* ☆ 收藏: 平时隐藏, 悬停才出现(除非已收藏) */
.fav {
  position: absolute; top: 6px; right: 6px; z-index: 5;
  width: 30px; height: 30px; border-radius: 7px;
  background: rgba(10, 13, 18, .75);
  color: var(--muted); font-size: 16px; line-height: 1;
  opacity: 0; transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.card:hover .fav { opacity: 1; }
.fav.on { opacity: 1; color: var(--fav); }
.fav:hover { background: var(--fav-soft); color: var(--fav); }

.ckbox {
  position: absolute; top: 8px; left: 8px; z-index: 5;
  width: 22px; height: 22px; border-radius: 5px;
  background: rgba(10, 13, 18, .7);
  display: flex; align-items: center; justify-content: center;
}
.ckbox input { accent-color: var(--accent); width: 14px; height: 14px; pointer-events: none; }

/* 来源角标: 左上角 —— 以前在左下角, 正好压住标签区的提示词文字。
   选择模式下勾选框也占左上角, 徽标往右让一格。 */
.src {
  position: absolute; top: 6px; left: 6px; z-index: 4;
  background: rgba(10, 13, 18, .8); color: var(--accent2);
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  max-width: calc(100% - 12px); overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis;
}
.card.has-sel .src { left: 36px; }

.tags {
  font-size: 10px; color: var(--muted);
  padding: 4px 8px 2px;
  max-height: 28px; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis;
}
.tags.keys { white-space: normal; max-height: 42px; line-height: 1.35; }
.tags .ch { color: var(--char); font-weight: 700; }
.tags .none { color: var(--faint); font-style: italic; }

.foot {
  font-size: 9px; color: var(--faint);
  padding: 0 8px 5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
</style>
