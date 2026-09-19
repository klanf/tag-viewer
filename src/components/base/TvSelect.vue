<script setup>
/** 下拉选择 —— 支持对象数组(options)或纯值数组 */
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  label: { type: String, default: '' },
  /** [{value, label}] 或 ['a','b'] */
  options: { type: Array, default: () => [] },
  inline: { type: Boolean, default: false },   // 标签与控件同行(工具条里用)
  size: { type: String, default: 'md' },
})
const emit = defineEmits(['update:modelValue', 'change'])

const norm = computed(() => props.options.map((o) => (
  o && typeof o === 'object' ? o : { value: o, label: String(o) }
)))

function onChange(e) {
  const raw = e.target.value
  // 还原成原始类型(option 的 value 只能是字符串)
  const hit = norm.value.find((o) => String(o.value) === raw)
  const v = hit ? hit.value : raw
  emit('update:modelValue', v)
  emit('change', v)
}
</script>

<template>
  <label :class="['tv-select', { inline }]">
    <span v-if="label" class="lab">{{ label }}</span>
    <select :value="modelValue" :class="[`s-${size}`]" @change="onChange">
      <option v-for="o in norm" :key="String(o.value)" :value="String(o.value)">
        {{ o.label }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.tv-select { display: block; }
.tv-select.inline { display: flex; align-items: center; gap: 6px; }
.lab { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
.inline .lab { margin: 0; white-space: nowrap; }
select {
  width: 100%;
  background: var(--panel2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 7px 10px;
  font-size: 13px;
  outline: none;
  cursor: pointer;
}
select.s-sm { padding: 4px 8px; font-size: 12px; }
select:focus { border-color: var(--accent); }
.inline select { width: auto; }
</style>
