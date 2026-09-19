<script setup>
/** 输入框 —— 带标签/提示/清空按钮 */
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  label: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  hint: { type: String, default: '' },
  clearable: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'md' },       // sm | md
  spellcheck: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'enter', 'focus', 'input'])

function onInput(e) {
  emit('update:modelValue', e.target.value)
  emit('input', e.target.value)
}
function clear() {
  emit('update:modelValue', '')
  emit('input', '')
}
function onKeydown(e) {
  if (e.key === 'Enter') emit('enter', e)
}
</script>

<template>
  <label class="tv-field">
    <span v-if="label" class="lab">{{ label }}</span>
    <span class="box">
      <input
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :spellcheck="spellcheck"
        :class="['tv-input', `s-${size}`]"
        type="text"
        autocomplete="off"
        @input="onInput"
        @keydown="onKeydown"
        @focus="$emit('focus', $event)"
      >
      <button
        v-if="clearable && modelValue"
        class="clr"
        title="清空"
        type="button"
        @click.prevent="clear"
      >✕</button>
    </span>
    <span v-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.tv-field { display: block; }
.lab { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
.box { display: block; position: relative; }
.tv-input {
  width: 100%;
  background: var(--panel2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  outline: none;
  padding: 7px 10px;
  font-size: 13px;
  transition: border-color var(--t-fast);
}
.tv-input.s-sm { padding: 5px 8px; font-size: 12px; }
.tv-input:focus { border-color: var(--accent); }
.tv-input:disabled { opacity: .55; }
.tv-input::placeholder { color: var(--faint); }
.clr {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  width: 18px; height: 18px; border-radius: 4px;
  color: var(--muted); font-size: 11px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.clr:hover { background: var(--panel3); color: var(--text); }
.hint { display: block; font-size: 11px; color: var(--faint); margin-top: 4px; }
</style>
