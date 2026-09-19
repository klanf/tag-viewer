<script setup>
/** 复选框 / 开关 —— 旧版 .chk 类名在各页面重复了七八次 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: '' },
  title: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  /**
   * 做成开关样式(用在筛选面板顶部)。
   * 注意: 这个 prop 必须叫 isSwitch —— 叫 `switch` 的话模板里没法引用它,
   * `switch` 是 JS 保留字, 在表达式位置会被编译器判成语法错误。
   */
  isSwitch: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'change'])

function toggle() {
  if (props.disabled) return
  const v = !props.modelValue
  emit('update:modelValue', v)
  emit('change', v)
}
</script>

<template>
  <label
    :class="['tv-check', { on: modelValue, disabled, switch: isSwitch }]"
    :title="title || undefined"
    @click.prevent="toggle"
  >
    <input v-if="!isSwitch" type="checkbox" :checked="modelValue" :disabled="disabled" @click.stop="toggle">
    <span v-else class="track"><span class="knob" /></span>
    <span v-if="label || $slots.default" class="txt"><slot>{{ label }}</slot></span>
  </label>
</template>

<style scoped>
.tv-check {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; color: var(--muted); cursor: pointer; user-select: none;
}
.tv-check.disabled { opacity: .5; cursor: not-allowed; }
.tv-check:hover { color: var(--text); }
input[type=checkbox] { accent-color: var(--accent); cursor: pointer; width: 14px; height: 14px; }
.txt { line-height: 1.4; }

/* 开关样式 */
.track {
  position: relative; width: 30px; height: 16px; flex: 0 0 auto;
  background: var(--panel3); border: 1px solid var(--border);
  border-radius: 9px; transition: background var(--t-fast), border-color var(--t-fast);
}
.knob {
  position: absolute; top: 1px; left: 1px; width: 12px; height: 12px;
  background: var(--muted); border-radius: 50%;
  transition: transform var(--t-fast), background var(--t-fast);
}
.tv-check.on .track { background: var(--accent-soft); border-color: var(--accent); }
.tv-check.on .knob { transform: translateX(14px); background: var(--accent); }
.tv-check.on { color: var(--text); }
</style>
