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
import { useAppStore } from '@/stores/useAppStore.js'

const app = useAppStore()

const props = defineProps({
  tags: { type: Array, default: () => [] },
  zhMap: { type: Object, default: () => ({}) },
  banMap: { type: Object, default: () => ({}) },
  showBan: { type: Boolean, default: false },
  /** 隐藏被 ban 的标签(2026-10-16): 开关在光箱/详情页, 选择记忆到设置 */
  hideBanned: { type: Boolean, default: false },
  /** 按分类分组展示(2026-10-16): 段位小节 + 韦林大类归堆, 顺序即导出段位顺序 */
  grouped: { type: Boolean, default: false },
  /** 每个 pill 上挂一个悬停显形的 📋 复制图标(点 pill 本体干别的时用) */
  copyable: { type: Boolean, default: false },
  /**
   * 角色 pill 上挂 🛒 购物车按钮(TvTagPill 内部只对角色 pill 生效)。
   * cartTags = 当前已在购物车里的标签名数组, 用来点亮"已入车"状态。
   */
  cartable: { type: Boolean, default: false },
  cartTags: { type: Array, default: () => [] },
  /**
   * 每个 pill 上挂 ★ 标签收藏按钮(2026-10-08, 任意种类 pill 都可)。
   * favTags = 当前已收藏的标签名数组, 用来点亮"已收藏"状态。
   */
  favable: { type: Boolean, default: false },
  favTags: { type: Array, default: () => [] },
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
const emit = defineEmits(['click', 'ban', 'copy', 'cart', 'fav', 'hover', 'leave'])

/** 归一化成统一对象; 顺带带上分类快照 cat(pill 按段位着色用) */
const items = computed(() => {
  const arr = props.tags || []
  let out = arr.map((t) => {
    if (t && typeof t === 'object') {
      return {
        tag: t.tag,
        zh: t.zh || props.zhMap[t.tag] || '',
        count: t.count ?? null,
        banned: !!t.banned,
        banRule: t.ban_rule || t.banRule || '',
        cat: t.cat || app.catOf(t.tag),
      }
    }
    const b = props.banMap[t] || {}
    return {
      tag: t,
      zh: props.zhMap[t] || '',
      count: null,
      banned: !!b.banned,
      banRule: b.rule || '',
      cat: app.catOf(t),
    }
  })
  if (props.hideBanned) out = out.filter((it) => !it.banned)
  if (props.charsFirst && !props.grouped) {
    out.sort((a, b) => (isCharTag(b.tag) ? 1 : 0) - (isCharTag(a.tag) ? 1 : 0))
  }
  return out
})

/**
 * 分组展示(2026-10-16): 按 app store 的分类映射把标签归到段位小节。
 * 段位顺序: 人数 → 角色 → 系列 → 画师 → 通用(按韦林大类: 人物→服饰→汉服→表情动作
 * →物品→场景→环境→画面→镜头→魔法系, 未归到 sub 的排最后) → Meta → 其他。
 * grouped 开着时 charsFirst 失效(分组本身已把角色排前面了)。
 */
const groups = computed(() => {
  if (!props.grouped) return null
  const SUB_ORDER = ['人物', '服饰', '汉服', '表情动作', '物品', '场景', '环境', '画面', '镜头', '魔法系']
  const SEG_LABEL = { count: '人数', char: '角色', series: '系列', artist: '画师', meta: 'Meta', other: '其他' }
  const rankOf = (cat) => {
    const [seg, sub] = String(cat).split(':')
    if (seg === 'count') return [0, 0]
    if (seg === 'char') return [1, 0]
    if (seg === 'series') return [2, 0]
    if (seg === 'artist') return [3, 0]
    if (seg === 'general') {
      const i = SUB_ORDER.indexOf(sub)
      return [4, i >= 0 ? i : SUB_ORDER.length]
    }
    if (seg === 'meta') return [5, 0]
    return [6, 0]
  }
  const buckets = new Map()   // cat -> { title, items }
  for (const it of items.value) {
    const cat = app.catOf(it.tag)
    const [seg, sub] = String(cat).split(':')
    const key = cat.startsWith('general:') ? cat : seg
    const title = seg === 'general' ? (sub || '通用') : (SEG_LABEL[seg] || seg)
    if (!buckets.has(key)) buckets.set(key, { title, key, items: [] })
    buckets.get(key).items.push(it)
  }
  const order = [...buckets.values()].map((b) => ({ ...b, rank: rankOf(b.key) }))
  order.sort((a, b) => (a.rank[0] - b.rank[0]) || (a.rank[1] - b.rank[1]))
  return order
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
    <!-- 分组形态: 段位小节, 每节一个标题行 + 该节的 pills -->
    <template v-if="grouped && groups">
      <template v-for="g in groups" :key="g.key">
        <div class="seg-head" :class="'seg-' + g.key.split(':')[0]">{{ g.title }}<i>{{ g.items.length }}</i></div>
        <TvTagPill
          v-for="it in g.items"
          :key="it.tag"
          :tag="it.tag"
          :zh="it.zh"
          :count="it.count"
          :banned="it.banned"
          :ban-rule="it.banRule"
          :cat="it.cat"
          :show-ban="showBan"
          :copyable="copyable"
          :cartable="cartable"
          :in-cart="cartTags.includes(it.tag)"
          :favable="favable"
          :in-fav="favTags.includes(it.tag)"
          :show-count="showCount && it.count !== null"
          :show-zh="showZh"
          :action="action"
          :size="size"
          @click="(p) => emit('click', p)"
          @ban="(t) => emit('ban', t)"
          @copy="(t) => emit('copy', t)"
          @cart="(t) => emit('cart', t)"
          @fav="(t) => emit('fav', t)"
          @mouseenter="emit('hover', { tag: it.tag, zh: it.zh, event: $event })"
        />
      </template>
    </template>
    <!-- 平铺形态(原样) -->
    <template v-else>
      <TvTagPill
        v-for="it in items"
        :key="it.tag"
        :tag="it.tag"
        :zh="it.zh"
        :count="it.count"
        :banned="it.banned"
        :ban-rule="it.banRule"
        :show-ban="showBan"
        :copyable="copyable"
        :cartable="cartable"
        :in-cart="cartTags.includes(it.tag)"
        :favable="favable"
        :in-fav="favTags.includes(it.tag)"
        :show-count="showCount && it.count !== null"
        :show-zh="showZh"
        :action="action"
        :size="size"
        @click="(p) => emit('click', p)"
        @ban="(t) => emit('ban', t)"
        @copy="(t) => emit('copy', t)"
        @cart="(t) => emit('cart', t)"
        @fav="(t) => emit('fav', t)"
        @mouseenter="emit('hover', { tag: it.tag, zh: it.zh, event: $event })"
      />
    </template>
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
/* 分组小节标题: 占满一整行, 按段位着色(与 pill 本体同一组 --seg-* 令牌;
 * 2026-10-16 之前用的 --ok/--violet/--err 根本没定义过, 全靠 fallback 兜底) */
.seg-head {
  flex: 0 0 100%;
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  user-select: none;
}
.seg-head::after { content: ''; flex: 1; height: 1px; background: var(--border, rgba(128,128,128,.25)); }
.seg-head i { font-style: normal; opacity: .7; }
.seg-head.seg-char { color: var(--seg-char); font-weight: 600; }
.seg-head.seg-series { color: var(--seg-series); font-weight: 600; }
.seg-head.seg-artist { color: var(--seg-artist); font-weight: 600; }
.seg-head.seg-count { color: var(--seg-count); font-weight: 600; }
.seg-head.seg-meta { opacity: .75; }
</style>
