<script setup>
/**
 * 标签药丸 —— 全站复用最多的组件
 * ==============================
 * 旧版在 5 个地方各写了一遍几乎相同的 innerHTML 拼接:
 *   common.js openLB() 的标签区、index.html 详情、series.html、tags.html 的 .tag-pill、
 *   detail.html 的 .tag、scan.html 的卡片标签。
 * 差异只在"有没有 🚫 按钮""点击是复制还是筛选""显示不显示计数"。
 * 这里把这些差异做成 props, 一份实现。
 *
 * ban 的三种状态(与旧版一致):
 *   未 ban           -> 常态, 点 🚫 加入黑名单精确规则
 *   被精确规则 ban   -> 灰化 + 删除线, 点 🚫 移除那条规则
 *   被通配规则命中   -> 灰化 + 删除线, 点 🚫 提示"需手动改规则"(不能单条取消)
 */
import { computed } from 'vue'
import { hasSeriesSuffix, isCharTag } from '@/utils/format.js'

const props = defineProps({
  tag: { type: String, required: true },
  zh: { type: String, default: '' },
  count: { type: [Number, String], default: null },
  banned: { type: Boolean, default: false },
  banRule: { type: String, default: '' },
  /** 显示 🚫 切换按钮 */
  showBan: { type: Boolean, default: false },
  /** 显示计数 */
  showCount: { type: Boolean, default: false },
  /** 显示中文 */
  showZh: { type: Boolean, default: true },
  /** 视觉变体: auto 会根据标签自动判定角色/系列 */
  variant: { type: String, default: 'auto' },   // auto | char | series | plain
  /** 点击动作, 只影响 title 文案: copy | filter | none */
  action: { type: String, default: 'copy' },
  /**
   * 显示一个悬停才显形的 📋 复制按钮。
   * 用在"点 pill 本体干别的事、复制要另给个口子"的地方 —— 光箱 / 详情页点标签
   * 是**跳去该标签的图片列表**, 复制单个标签就靠这个图标(与 🚫 同一套交互)。
   */
  copyable: { type: Boolean, default: false },
  /**
   * 显示 🛒 购物车按钮(角色 pill 专用, 光箱/详情页)。
   * inCart = 已在购物车里: 图标常驻高亮(与 banned 的常驻 🚫 同一套逻辑)。
   */
  cartable: { type: Boolean, default: false },
  inCart: { type: Boolean, default: false },
  /**
   * 显示 ★ 标签收藏按钮(2026-10-08) —— 与 🛒 同一套双层模式:
   * 悬停浮层里常显; 已收藏时另出**内联常驻** ★(静态宽度不参与悬停动画)。
   * 任何种类的 pill 都能挂(收藏的是标签名, 不限角色)。
   */
  favable: { type: Boolean, default: false },
  inFav: { type: Boolean, default: false },
  size: { type: String, default: 'md' },        // sm | md
  active: { type: Boolean, default: false },
  /** 长标签: 超出宽度省略 */
  clip: { type: Boolean, default: false },
})
const emit = defineEmits(['click', 'ban', 'copy', 'cart', 'fav'])

const wild = computed(() => props.banned && props.banRule.includes('*'))

const kind = computed(() => {
  if (props.variant !== 'auto') return props.variant
  if (isCharTag(props.tag)) return 'char'
  return 'plain'
})

/** 悬停浮层里是否真有图标(决定浮层 DOM 是否渲染) */
const hasHoverActs = computed(() =>
  props.copyable ||
  props.favable ||
  (props.cartable && kind.value === 'char') ||
  props.showBan
)

/** 角色/系列标签常常太长, 显示时去掉 _(系列) 尾巴让 pill 短一点; 悬停看完整 */
const shownTag = computed(() => {
  if (kind.value === 'char') return props.tag.replace(/_\(.+\)$/, '')
  return props.tag
})

const pillTitle = computed(() => {
  if (props.banned) {
    return '已 ban(导出时剔除)' + (wild.value ? ` · 由通配规则 ${props.banRule} 命中` : '')
  }
  if (props.action === 'filter') return `点击查看该标签的图片: ${props.tag}`
  if (props.action === 'copy') return `点击复制: ${props.tag}`
  return props.tag
})

const banTitle = computed(() => {
  if (!props.banned) return '点击 ban 掉这个标签'
  if (wild.value) return `被通配规则 ${props.banRule} 命中, 需在黑名单里手动修改`
  return '点击取消 ban'
})

const copyTitle = computed(() => `复制这个标签: ${props.tag}`)
const cartTitle = computed(() => props.inCart ? `移出购物车: ${props.tag}` : `加入购物车: ${props.tag}`)
const favTitle = computed(() => props.inFav ? `取消收藏标签: ${props.tag}` : `收藏这个标签: ${props.tag}`)

function onClick(e) {
  emit('click', { tag: props.tag, event: e })
}
function onBan(e) {
  e.stopPropagation()
  emit('ban', props.tag)
}
function onCopy(e) {
  e.stopPropagation()
  emit('copy', props.tag)
}
function onCart(e) {
  e.stopPropagation()
  emit('cart', props.tag)
}
function onFav(e) {
  e.stopPropagation()
  emit('fav', props.tag)
}
</script>

<template>
  <span
    :class="['pill', `k-${kind}`, `s-${size}`, { banned, active, clip }]"
    :title="pillTitle"
    :data-tag="tag"
    @click="onClick"
  >
    <span class="en">{{ shownTag }}</span>
    <span v-if="showZh && zh" class="zh" :title="zh">{{ zh }}</span>
    <b v-if="showCount && count !== null" class="cnt">{{ count }}</b>
    <!-- 常驻状态图标: 已 ban / 已入车。内联占位但**静态**(不随悬停伸缩),
         静态宽度不会触发重排循环 —— 抽搐的根源是"悬停改变宽度"而非占位本身 -->
    <i v-if="showBan && banned" class="st" :title="banTitle" @click="onBan">🚫</i>
    <i v-if="cartable && kind === 'char' && inCart" class="st ct on" :title="cartTitle" @click="onCart">🛒</i>
    <i v-if="favable && inFav" class="st fv on" :title="favTitle" @click="onFav">★</i>
    <!-- 悬停动作浮层: 绝对定位盖在 pill 自身右段上方, 完全不占布局宽度。
         pill 几何永不变化 -> flex-wrap 永不因悬停重排 -> 不再"掉行又弹回"抽搐。
         ⚠️ 浮层必须带全套动作(含 🚫/🛒, 不论 banned/inCart): 浮层会盖住内联
         状态图标, 若把状态图标从浮层排除, 悬停时就只剩 📋、"取消 ban"入口
         被自己盖掉(2026-09-20 用户实测踩中) -->
    <span v-if="hasHoverActs" class="acts">
      <i v-if="copyable" class="cp" :title="copyTitle" @click="onCopy">📋</i>
      <i v-if="favable" :class="['fv', { on: inFav }]" :title="favTitle" @click="onFav">★</i>
      <i v-if="cartable && kind === 'char'" :class="['ct', { on: inCart }]" :title="cartTitle" @click="onCart">🛒</i>
      <i v-if="showBan" class="ban" :title="banTitle" @click="onBan">🚫</i>
    </span>
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  position: relative;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  max-width: 100%;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.pill.s-sm { padding: 3px 8px; font-size: 11px; gap: 5px; }
.pill:hover { border-color: var(--accent); }
.pill.clip { max-width: 320px; }
.en { white-space: nowrap; }
.clip .en { overflow: hidden; text-overflow: ellipsis; }
.zh {
  color: var(--muted); font-size: 11px;
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cnt { color: var(--accent); font-size: 10px; font-weight: 700; }

/* 角色标签(黄) —— 最有辨识度, 要一眼看出来 */
.pill.k-char { border-color: var(--char); background: var(--char-bg); }
.pill.k-char .en { color: var(--char); font-weight: 700; }
.pill.k-char .zh { color: var(--char); opacity: .85; }

/* 系列标签(蓝) */
.pill.k-series { border-color: var(--accent); }
.pill.k-series .en { color: var(--accent); }

.pill.active { border-color: var(--accent); background: var(--accent-soft); }

/* 已 ban: 灰化 + 删除线 */
.pill.banned { opacity: .5; }
.pill.banned .en, .pill.banned .zh, .pill.banned .cnt {
  color: var(--muted) !important;
  text-decoration: line-through;
}

/* ── 悬停动作浮层(📋 / 🛒 / 🚫) ─────────────────────────────
 * 2026-09-20 二次反馈: 内联 max-width 展开会**改变 pill 宽度**, 行尾 pill 被
 * flex-wrap 挤到下一行 -> hover 丢失 -> 收拢弹回 -> 又悬停, 画面抽搐死循环。
 * 根治: 浮层绝对定位盖在 pill 自身右段上方, 完全不占布局宽度, pill 几何永不
 * 变化。视觉上图标从右侧滑入"替换"文字尾部; 已 ban/已入车的常驻图标改走
 * 内联静态 .st(静态宽度不随悬停变化, 同样不会抽搐)。 */
.acts {
  position: absolute; top: 0; bottom: 0; right: 0;
  display: inline-flex; align-items: center; gap: 3px;
  padding: 0 6px 0 8px;
  background: inherit;          /* 与 pill 同底色, 盖住文字尾部无接缝 */
  border-radius: inherit;
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateX(6px);   /* 从右侧轻滑入, 保留"右扩展"的动效感 */
  transition: transform .18s ease-out, opacity .18s ease-out, visibility .18s;
}
.pill:hover .acts, .pill:focus-within .acts {
  opacity: 1; visibility: visible; pointer-events: auto;
  transform: translateX(0);
}
.pill.s-sm .acts { padding: 0 4px 0 6px; gap: 2px; }

/* 常驻状态图标(已 ban / 已入车): 内联静态, 不参与悬停动画 */
.st {
  font-style: normal; font-size: 10px;
  cursor: pointer; transition: opacity var(--t-fast);
}

/* 📋 复制按钮: 与 🚫 同一套交互(悬停展开), 只有"点 pill 本体是跳转"的地方才挂 */
.cp {
  font-style: normal; font-size: 10px;
  opacity: .5; cursor: pointer; transition: opacity var(--t-fast);
}
.cp:hover { opacity: 1 !important; }

/* 🛒 购物车(角色 pill): 已入车时常驻高亮, 和 banned 的常驻 🚫 同一套逻辑 */
.ct {
  font-style: normal; font-size: 10px;
  opacity: .5; cursor: pointer; transition: opacity var(--t-fast);
}
.ct.on { opacity: 1; }
.ct:hover { opacity: 1 !important; }

/* ★ 标签收藏: 与 🛒 同一套双层模式(悬停浮层常显 / 已收藏内联常驻) */
.fv {
  font-style: normal; font-size: 10px;
  opacity: .5; cursor: pointer; transition: opacity var(--t-fast);
}
.fv.on { opacity: 1; color: var(--warn, #f59e0b); }
.fv:hover { opacity: 1 !important; }

/* 🚫 按钮: 悬停展开才显形, 已 ban 时常驻(整组随 .pill.banned 展开) */
.ban {
  font-style: normal; font-size: 10px;
  opacity: .5; cursor: pointer; transition: opacity var(--t-fast);
}
.ban:hover { opacity: 1 !important; }
</style>
