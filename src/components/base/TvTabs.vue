<script setup>
/** 小标签页切换(首页的"高频标签/系列分布"、分类管理的三个 tab 都用它) */
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  /** [{value, label, count?, badge?}] 或 ['a','b'] */
  tabs: { type: Array, default: () => [] },
  size: { type: String, default: 'md' },   // sm | md
})
const emit = defineEmits(['update:modelValue', 'change'])

function list() {
  return props.tabs.map((t) => (t && typeof t === 'object' ? t : { value: t, label: String(t) }))
}
function pick(v) {
  emit('update:modelValue', v)
  emit('change', v)
}
</script>

<template>
  <div :class="['tv-tabs', `s-${size}`]">
    <button
      v-for="t in list()"
      :key="String(t.value)"
      :class="['tab', { active: t.value === modelValue, dim: t.dim }]"
      :title="t.title || undefined"
      type="button"
      @click="pick(t.value)"
    >
      {{ t.label }}<span v-if="t.count !== undefined" class="c">({{ t.count }})</span>
    </button>
  </div>
</template>

<style scoped>
.tv-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tab {
  padding: 4px 12px; border-radius: var(--r-sm);
  font-size: 12px; color: var(--muted); background: var(--panel2);
  border: 1px solid transparent;
  transition: all var(--t-fast);
}
.s-sm .tab { padding: 4px 9px; font-size: 11px; }
.tab:hover { color: var(--text); border-color: var(--border); }
.tab.active { background: var(--accent); color: var(--on-accent); font-weight: 600; }
/* 被"隐藏分类"标记的 tab: 仍然可点(点进去还能看), 但要一眼看出是被隐藏的 */
.tab.dim { opacity: .45; text-decoration: line-through; }
.c { opacity: .8; margin-left: 2px; }
</style>
