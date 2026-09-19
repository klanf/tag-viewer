<script setup>
/**
 * 可搜索下拉(中英文双匹配)
 * ========================
 * 旧版为了「分类管理」手写了一套 combo(), 用 id 字符串拼 DOM:
 * comboInit('cmSeries') / comboRender / comboItemHTML / comboOpen / comboFilter / comboKey
 * —— 靠 `$(id + 'List')` 这种字符串拼接找元素。这里改成组件, 用 v-model 传值。
 *
 * 匹配规则沿用旧版: 输入同时匹配英文 label 与中文 zh(子串, 不区分大小写),
 * 空输入显示前 80 条。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  /** [{value, label, zh, note}] */
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '搜索...' },
  /** 输入框里显示的文本(选中项 label); 不传则跟随 modelValue */
  displayValue: { type: String, default: '' },
  max: { type: Number, default: 80 },
  emptyText: { type: String, default: '无匹配' },
})
const emit = defineEmits(['update:modelValue', 'pick', 'enter'])

const open = ref(false)
const kw = ref('')
const cursor = ref(0)
const root = ref(null)

const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const list = props.options || []
  let hits = list
  if (k) {
    hits = list.filter((o) => (
      String(o.label).toLowerCase().includes(k)
      || (o.zh && String(o.zh).toLowerCase().includes(k))
      || (o.value !== undefined && String(o.value).toLowerCase().includes(k))
    ))
  }
  return hits.slice(0, props.max)
})

function openBox() {
  open.value = true
  cursor.value = 0
}
function closeBox() { open.value = false }

function pick(o) {
  emit('update:modelValue', o.value)
  emit('pick', o)
  kw.value = o.label
  closeBox()
}

function onInput(e) {
  kw.value = e.target.value
  if (!open.value) openBox()
  cursor.value = 0
}

function onKeydown(e) {
  const items = filtered.value
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open.value || !items.length) return
    e.preventDefault()
    cursor.value = e.key === 'ArrowDown'
      ? (cursor.value + 1) % items.length
      : (cursor.value - 1 + items.length) % items.length
  } else if (e.key === 'Enter') {
    if (open.value && items.length) {
      e.preventDefault()
      pick(items[Math.min(cursor.value, items.length - 1)])
    } else {
      emit('enter', kw.value)
    }
  } else if (e.key === 'Escape') {
    closeBox()
  }
}

// 点组件外关闭
function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) closeBox()
}
document.addEventListener('click', onDocClick)
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

watch(() => props.displayValue, (v) => { if (v !== undefined && v !== null) kw.value = v }, { immediate: true })

defineExpose({ close: closeBox, focus: () => nextTick(() => root.value?.querySelector('input')?.focus()) })
</script>

<template>
  <div ref="root" class="combo">
    <input
      :value="kw"
      :placeholder="placeholder"
      autocomplete="off"
      type="text"
      @input="onInput"
      @focus="openBox"
      @keydown="onKeydown"
    >
    <div v-if="open" class="list">
      <template v-if="filtered.length">
        <div
          v-for="(o, i) in filtered"
          :key="String(o.value)"
          :class="['item', { active: i === cursor }]"
          @mouseenter="cursor = i"
          @mousedown.prevent="pick(o)"
        >
          <span class="en">{{ o.label }}</span>
          <span v-if="o.zh" class="zh">{{ o.zh }}</span>
          <span v-if="o.note" class="note">{{ o.note }}</span>
        </div>
      </template>
      <div v-else class="empty-item">{{ emptyText }}</div>
    </div>
  </div>
</template>

<style scoped>
.combo { position: relative; min-width: 0; }
input {
  width: 100%;
  background: var(--panel2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 7px 10px; font-size: 13px; outline: none;
}
input:focus { border-color: var(--accent); }
input::placeholder { color: var(--faint); }

.list {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r-sm); box-shadow: var(--shadow-1);
  max-height: 300px; overflow-y: auto;
}
.item {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 12px; font-size: 12px; cursor: pointer;
}
.item.active, .item:hover { background: var(--panel2); }
.en { color: var(--text); word-break: break-all; }
.zh { color: var(--muted); font-size: 11px; margin-left: auto; white-space: nowrap; }
.note {
  color: var(--accent); font-size: 10px; border: 1px solid var(--accent);
  border-radius: 3px; padding: 0 4px; white-space: nowrap;
}
.empty-item { padding: 10px 12px; font-size: 12px; color: var(--muted); }
</style>
