<script setup>
/**
 * 复制模式的「主按钮 + 下拉」
 * ==========================
 * 2026-09-20 用户需求: 光箱/详情页那排复制按钮(复制全部标签 / 去ban / 含角色)
 * 收成一个按钮 —— 主按钮按**当前模式**复制, 右侧小箭头展开菜单换模式。
 * 菜单项点击 = 切到该模式**并立即复制**(顺手的事一次做完), 同时关菜单。
 *
 * modes: [{ key, label, menu, title }]
 *   label = 主按钮上显示的模式名(短), menu = 菜单项文案(长), title = 悬停说明
 * v-model = 当前模式 key; @run(key) = 父组件执行对应复制。
 *
 * 2026-10-19 扩展(光箱复制设置面板, 旧调用方不受影响):
 *   currentLabel / currentTitle —— 覆写主按钮文案/悬停(配置驱动时主按钮不再对应某个 mode);
 *   #menu-bottom 具名插槽 —— 菜单底部追加自定义面板(勾选项等), 菜单本身的开关仍归组件管。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  /** 空数组 = 无快捷档, 菜单只剩 #menu-bottom 面板(光箱复制过滤, 2026-10-19) */
  modelValue: { type: String, default: '' },
  modes: { type: Array, default: () => [] },
  currentLabel: { type: String, default: '' },
  currentTitle: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'run'])

const open = ref(false)
const root = ref(null)
const current = computed(() => props.modes.find((m) => m.key === props.modelValue) || props.modes[0])
const mainLabel = computed(() => props.currentLabel || current.value?.label || '')
const mainTitle = computed(() => props.currentTitle || current.value?.title || '')
/** 空模式列表时主按钮写「复制标签」, 不带 "复制: xxx" 后缀 */
const mainText = computed(() => (mainLabel.value ? `📋 复制: ${mainLabel.value}` : '📋 复制标签'))

function run(key) {
  emit('update:modelValue', key)
  emit('run', key)
}
function pick(m) {
  open.value = false
  run(m.key)
}
function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false
}
function onKey(e) {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <span ref="root" class="copy-split">
    <button
      :class="['cs-main', 'tv-like']"
      :title="mainTitle"
      type="button"
      @click="run(modelValue)"
    >{{ mainText }}</button><button
      class="cs-arrow tv-like"
      title="选择复制模式"
      :aria-expanded="open"
      type="button"
      @click.stop="open = !open"
    >▾</button>

    <transition name="cs-drop">
      <div v-if="open" class="cs-menu" @click.stop>
        <div
          v-for="m in modes"
          :key="m.key"
          :class="['mi', { cur: m.key === modelValue }]"
          :title="m.title"
          @click="pick(m)"
        >
          <span class="mk">{{ m.key === modelValue ? '✓' : '' }}</span>
          {{ m.menu }}
        </div>
        <slot name="menu-bottom" />
      </div>
    </transition>
  </span>
</template>

<style scoped>
.copy-split {
  position: relative;
  display: inline-flex;
  align-items: stretch;
}
/* 两截拼成一个按钮: 左边吃掉右圆角, 右边吃掉左圆角, 中缝一条分隔线 */
.tv-like {
  display: inline-flex; align-items: center;
  border: 1px solid transparent;
  font-weight: 600; white-space: nowrap;
  cursor: pointer;
  transition: filter var(--t-fast);
  background: var(--accent); color: var(--on-accent);
  font-size: 12px; padding: 5px 10px; line-height: 1.2;
}
.tv-like:hover { filter: brightness(1.12); }
.cs-main { border-radius: var(--r-sm) 0 0 var(--r-sm); }
.cs-arrow {
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  border-left: 1px solid rgba(0, 0, 0, .18);
  padding: 5px 7px; font-size: 10px;
}
.cs-menu {
  position: absolute; top: calc(100% + 4px); left: 0;
  z-index: 30;
  min-width: 200px;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  box-shadow: 0 8px 22px rgba(0, 0, 0, .28);
  padding: 4px;
}
.mi {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 9px; font-size: 12px; color: var(--text);
  border-radius: 4px; cursor: pointer; white-space: nowrap;
}
.mi:hover { background: var(--accent-soft); }
.mi.cur { color: var(--accent); font-weight: 600; }
.mk { width: 12px; flex: 0 0 12px; font-size: 10px; }

/* 菜单展开/收起: 轻微下移淡入, 与 pill 的展开动画一个量级 */
.cs-drop-enter-active, .cs-drop-leave-active { transition: opacity .14s ease-out, transform .14s ease-out; }
.cs-drop-enter-from, .cs-drop-leave-to { opacity: 0; transform: translateY(-3px); }
</style>
