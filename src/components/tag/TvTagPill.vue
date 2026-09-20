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
  size: { type: String, default: 'md' },        // sm | md
  active: { type: Boolean, default: false },
  /** 长标签: 超出宽度省略 */
  clip: { type: Boolean, default: false },
})
const emit = defineEmits(['click', 'ban', 'copy'])

const wild = computed(() => props.banned && props.banRule.includes('*'))

const kind = computed(() => {
  if (props.variant !== 'auto') return props.variant
  if (isCharTag(props.tag)) return 'char'
  return 'plain'
})

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
</script>

<template>
  <span
    :class="['pill', `k-${kind}`, `s-${size}`, { banned, active, clip }]"
    :title="pillTitle"
    @click="onClick"
  >
    <span class="en">{{ shownTag }}</span>
    <span v-if="showZh && zh" class="zh" :title="zh">{{ zh }}</span>
    <b v-if="showCount && count !== null" class="cnt">{{ count }}</b>
    <i v-if="copyable" class="cp" :title="copyTitle" @click="onCopy">📋</i>
    <i v-if="showBan" class="ban" :title="banTitle" @click="onBan">🚫</i>
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex; align-items: center; gap: 6px;
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

/* 📋 复制按钮: 与下面的 🚫 同一套交互(平时藏起来, 悬停才显形),
 * 只有"点 pill 本体是跳转"的地方才挂它, 免得和点击意图打架 */
.cp {
  font-style: normal; font-size: 10px; margin-left: 2px;
  opacity: 0; cursor: pointer; transition: opacity var(--t-fast);
}
.pill:hover .cp { opacity: .5; }
.cp:hover { opacity: 1 !important; }

/* 🚫 按钮: 平时藏起来, 悬停才显形, 已 ban 时常驻 —— 和旧版手感一致 */
.ban {
  font-style: normal; font-size: 10px; margin-left: 2px;
  opacity: 0; cursor: pointer; transition: opacity var(--t-fast);
}
.pill:hover .ban { opacity: .5; }
.pill.banned .ban { opacity: 1; }
.ban:hover { opacity: 1 !important; }
</style>
