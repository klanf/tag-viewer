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
 *
 * 2026-10-16 段位配色: 新增 cat prop(由 TvTagList 用 app.catOf 传入, 形如
 * "char" | "general:服饰"), 按 SEG_ORDER 段位上色 —— 人数蓝/角色绿/系列紫/画师红,
 * 通用/meta/other 维持中性灰。不传 cat 时退回旧的 isCharTag 判定(向后兼容)。
 * 图标从 emoji 换成单色 SVG(13px, currentColor 着色)。状态标识(2026-10-17 定稿):
 * 收藏/入车点亮态 = 右上角金色★圆徽外挂角标(唯一常驻层, fav 右上/cart 偏左一格,
 * 可点击快速取消); 内联静态图标只留给已 ban(取消 ban 的非悬停入口)。
 * 内联图标与角标双层同显会叠在一起(2026-10-17 用户截图实测), 已删除。
 */
import { computed } from 'vue'
import { hasSeriesSuffix, isCharTag, subHueNo } from '@/utils/format.js'

const props = defineProps({
  tag: { type: String, required: true },
  zh: { type: String, default: '' },
  count: { type: [Number, String], default: null },
  banned: { type: Boolean, default: false },
  banRule: { type: String, default: '' },
  /** 分类快照(TvTagList 从 app.catOf 传入): "char" / "series" / "count" / "artist" / "general:服饰" / "meta" ... */
  cat: { type: String, default: '' },
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
  /** 灰化(2026-10-21 光箱 meta 模式): 库内无此标签, 不可跳转 —— 点击退回复制 */
  dim: { type: Boolean, default: false },
  /** 长标签: 超出宽度省略 */
  clip: { type: Boolean, default: false },
})
const emit = defineEmits(['click', 'ban', 'copy', 'cart', 'fav', 'rule-add'])

const wild = computed(() => props.banned && props.banRule.includes('*'))

const kind = computed(() => {
  if (props.variant !== 'auto') return props.variant
  if (isCharTag(props.tag)) return 'char'
  return 'plain'
})

/** 段位配色类(2026-10-16): cat 优先, 没传 cat 退回旧 isCharTag/variant 判定。
 *  通用段按韦林大类上左边条(k-subN, 2026-10-17), 不整块上色避免满屏彩虹。 */
const colorCls = computed(() => {
  if (props.variant === 'char') return 'k-char'
  if (props.variant === 'series') return 'k-series'
  const [seg, sub] = String(props.cat || '').split(':')
  if (seg === 'count' || seg === 'char' || seg === 'series' || seg === 'artist') return `k-${seg}`
  if (seg === 'general') {
    const n = subHueNo(sub)
    return n ? `k-sub${n}` : 'k-plain'
  }
  if (kind.value === 'char') return 'k-char'
  if (kind.value === 'series') return 'k-series'
  return 'k-plain'
})

/** 悬停浮层里是否真有图标(决定浮层 DOM 是否渲染) */
const hasHoverActs = computed(() =>
  props.copyable ||
  props.favable ||
  (props.cartable && kind.value === 'char') ||
  props.showBan
)

/** 右上角常驻角标(2026-10-17): 已收藏/已入车都是金色★圆徽, 绝对定位不占布局 */
const showCornerFav = computed(() => props.favable && props.inFav)
const showCornerCart = computed(() => props.cartable && kind.value === 'char' && props.inCart)

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
/** 右键 = 加进替换规则(2026-10-18): 看图时发现错 tag, 右键直接进构建器预填 */
function onCtxMenu(e) {
  e.preventDefault()
  e.stopPropagation()
  emit('rule-add', props.tag)
}
</script>

<template>
  <span
    :class="['pill', colorCls, `s-${size}`, { banned, active, clip, dim }]"
    :title="pillTitle"
    :data-tag="tag"
    @click="onClick"
    @contextmenu="onCtxMenu"
  >
    <span class="en">{{ shownTag }}</span>
    <span v-if="showZh && zh" class="zh" :title="zh">{{ zh }}</span>
    <b v-if="showCount && count !== null" class="cnt">{{ count }}</b>
    <!-- 常驻状态徽章: 只有已 ban 走内联(角标方案不覆盖它, 且它是取消 ban 的
         唯一非悬停入口)。收藏/入车的点亮态**只走右上角角标**(mock 原始设计) ——
         内联静态图标 + 角标双层同显会叠在一起: 角标压在图标正上方、或两颗★
         隔两像素重复(2026-10-17 用户截图实测), 悬停浮层里仍有全套可点图标 -->
    <i v-if="showBan && banned" class="st ic" :title="banTitle" @click="onBan">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/></svg>
    </i>
    <!-- 悬停动作浮层: 绝对定位盖在 pill 自身右段上方, 完全不占布局宽度。
         pill 几何永不变化 -> flex-wrap 永不因悬停重排 -> 不再"掉行又弹回"抽搐。
         ⚠️ 浮层必须带全套动作(含 🚫/🛒, 不论 banned/inCart): 浮层会盖住内联
         状态图标, 若把状态图标从浮层排除, 悬停时就只剩 📋、"取消 ban"入口
         被自己盖掉(2026-09-20 用户实测踩中) -->
    <span v-if="hasHoverActs" class="acts">
      <i v-if="copyable" class="ic cp" :title="copyTitle" @click="onCopy">
        <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
      </i>
      <i v-if="favable" :class="['ic', 'fv', { on: inFav }]" :title="favTitle" @click="onFav">
        <svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z"/></svg>
      </i>
      <i v-if="cartable && kind === 'char'" :class="['ic', 'ct', { on: inCart }]" :title="cartTitle" @click="onCart">
        <svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6"/><circle cx="10" cy="20.5" r="1.4"/><circle cx="17" cy="20.5" r="1.4"/></svg>
      </i>
      <i v-if="showBan" class="ic ban" :title="banTitle" @click="onBan">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/></svg>
      </i>
    </span>
    <!-- 右上角常驻角标(mock 定稿样式): 收藏/入车点亮态的唯一常驻标识, 浮在
         pill 外沿(fav 右上角/cart 偏左一格), 不悬停也一眼可见。可点击 =
         不悬停也能快速取消(补回被删的内联图标的入口), 点击不冒泡到 pill -->
    <span v-if="showCornerFav" class="corner fav" :title="favTitle" @click="onFav">
      <svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.5 1.1 6.4L12 17.1l-5.8 3.1 1.1-6.4L2.6 9.3l6.5-.9z"/></svg>
    </span>
    <span v-if="showCornerCart" :class="['corner', 'cart', { shifted: showCornerFav }]" :title="cartTitle" @click="onCart">
      <svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.5 1.1 6.4L12 17.1l-5.8 3.1 1.1-6.4L2.6 9.3l6.5-.9z"/></svg>
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
/* 灰化(2026-10-21): meta 模式库里没有的词条 —— 降透明度 + 虚线边,
 * 悬停不给 accent 反馈(点了也是复制, 不跳) */
.pill.dim { opacity: .55; border-style: dashed; }
.pill.dim:hover { border-color: var(--border); }
.en { white-space: nowrap; }
.clip .en { overflow: hidden; text-overflow: ellipsis; }
.zh {
  color: var(--muted); font-size: 11px;
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cnt { color: var(--accent); font-size: 10px; font-weight: 700; }

/* ── 段位配色(2026-10-16): 边框+浅底+文字同色相 ──────────────
 * 人数蓝/角色绿/系列紫/画师红, 通用与 meta 维持中性灰让四类跳出来。
 * 角色从黄改绿(用户点名), 与金色收藏星/警示黄不再撞色。 */
.pill.k-count { border-color: color-mix(in srgb, var(--seg-count) 45%, transparent); background: var(--seg-count-bg); }
.pill.k-count .en { color: var(--seg-count); font-weight: 600; }
.pill.k-char { border-color: color-mix(in srgb, var(--seg-char) 50%, transparent); background: var(--seg-char-bg); }
.pill.k-char .en { color: var(--seg-char); font-weight: 700; }
.pill.k-char .zh { color: var(--seg-char); opacity: .85; }
.pill.k-series { border-color: color-mix(in srgb, var(--seg-series) 50%, transparent); background: var(--seg-series-bg); }
.pill.k-series .en { color: var(--seg-series); font-weight: 600; }
.pill.k-artist { border-color: color-mix(in srgb, var(--seg-artist) 50%, transparent); background: var(--seg-artist-bg); }
.pill.k-artist .en { color: var(--seg-artist); font-weight: 600; }

/* ── 通用大类左边条(2026-10-17) ──────────────────────────────
 * 人物/服饰/汉服… 各占一个色相(tokens.css --sub-h1..11)。只染 3px 左边条,
 * pill 底色和文字保持中性 —— 通用段一屏几十个, 整块上色会满屏彩虹,
 * 盖过人数/角色/系列/画师那四个"有色即信息"的段位。 */
.pill[class*="k-sub"] { border-left-width: 3px; }
.pill.k-sub1  { border-left-color: hsl(var(--sub-h1)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub2  { border-left-color: hsl(var(--sub-h2)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub3  { border-left-color: hsl(var(--sub-h3)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub4  { border-left-color: hsl(var(--sub-h4)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub5  { border-left-color: hsl(var(--sub-h5)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub6  { border-left-color: hsl(var(--sub-h6)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub7  { border-left-color: hsl(var(--sub-h7)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub8  { border-left-color: hsl(var(--sub-h8)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub9  { border-left-color: hsl(var(--sub-h9)  var(--sub-s) var(--sub-l) / .8); }
.pill.k-sub10 { border-left-color: hsl(var(--sub-h10) var(--sub-s) var(--sub-l) / .8); }

.pill.active { border-color: var(--accent); background: var(--accent-soft); }

/* 已 ban: 灰化 + 删除线(优先级最高, 盖过段位色) */
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
 * 内联静态(静态宽度不随悬停变化, 同样不会抽搐)。 */
.acts {
  position: absolute; top: 0; bottom: 0; right: 0;
  display: inline-flex; align-items: center; gap: 4px;
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
.pill.s-sm .acts { padding: 0 4px 0 6px; gap: 3px; }

/* ── SVG 图标(2026-10-16): emoji 全部换掉, 13px 单色, currentColor 着色 ── */
.ic {
  display: inline-flex; width: 13px; height: 13px; flex: 0 0 auto;
  font-style: normal;
}
.ic svg {
  width: 100%; height: 100%;
  fill: none; stroke: currentColor; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round;
}

/* 常驻状态图标(已 ban): 内联静态, 不参与悬停动画; 收藏/入车不走内联(只走角标) */
.st { cursor: pointer; }

/* 图标配色: 中性动作半透明, 状态点亮用颜色说话 */
.cp, .ban { color: var(--muted); opacity: .65; transition: opacity var(--t-fast); }
.cp:hover, .ban:hover { opacity: 1 !important; }

.ct { color: var(--muted); opacity: .55; cursor: pointer; transition: opacity var(--t-fast), color var(--t-fast); }
.ct.on { color: var(--accent2, #2f9e63); opacity: 1; }
.ct.on svg { fill: currentColor; }
.ct:hover { opacity: 1 !important; }

.fv { color: var(--muted); opacity: .55; cursor: pointer; transition: opacity var(--t-fast), color var(--t-fast); }
.fv.on { color: var(--fav, #f59e0b); opacity: 1; }
.fv.on svg { fill: currentColor; }
.fv:hover { opacity: 1 !important; }

/* ── 右上角常驻角标(mock 定稿样式): 收藏/入车点亮态的唯一常驻标识 ──
 * 绝对定位浮在 pill 外沿, 不占布局、不会被悬停浮层盖掉; 可点击快速取消。
 * 收藏/入车都是金色★圆徽: fav 右上角, cart 偏左一格, 同时存在时并排。 */
.corner {
  position: absolute; top: -5px; right: -5px; width: 13px; height: 13px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
  cursor: pointer; z-index: 2;
}
.corner.fav { background: var(--fav, #f59e0b); }
/* 入车角标默认也贴右上角; 仅当收藏角标同时存在时才往左让一格, 避免两颗★重叠 */
.corner.cart { background: var(--fav, #f59e0b); }
.corner.cart.shifted { right: 9px; }
.corner svg { width: 8px; height: 8px; fill: #fff; stroke: none; }
</style>
