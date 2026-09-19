<script setup>
/**
 * 搜索输入框 + 自动补全 + 搜索历史
 * ================================
 * 旧版这段逻辑写了两份:
 *   - index.html 的 showHist/showSuggest/onQKey/attachSuggest(手写 DOM 遍历高亮)
 *   - common.js 的 attachSuggest(独立一份)
 * 行为一样但实现不同, 修一个 bug 要改两处。
 *
 * 键盘行为(沿用旧版, 这是用户已经习惯的手感):
 *   Enter 只有在「用 ↑/↓ 主动选中了补全项」时才填充; 否则直接提交搜索 ——
 *   这样模糊搜索不会被补全"劫持"。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { api } from '@/utils/api.js'
import { useSearchHistory } from '@/composables/useSearchHistory.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  /** 是否启用补全 */
  suggest: { type: Boolean, default: true },
  /** 是否在空输入时显示搜索历史(只有首页搜索框需要) */
  history: { type: Boolean, default: false },
  /** 参与补全的来源过滤 */
  source: { type: String, default: '' },
  limit: { type: Number, default: 12 },
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'md' },
})
const emit = defineEmits(['update:modelValue', 'submit', 'pick', 'input'])

const hist = useSearchHistory()
const root = ref(null)
const input = ref(null)
const open = ref(false)
const mode = ref('suggest')       // suggest | history
const items = ref([])
const cursor = ref(0)
const busy = ref(false)

let timer = null
let seq = 0

const showHistory = computed(() => props.history && mode.value === 'history' && !props.modelValue.trim())
const histItems = computed(() => hist.list.value)

function show() { open.value = true }
function hide() { open.value = false }

async function fetchSuggest() {
  const kw = props.modelValue.trim().toLowerCase()
  if (!kw || !props.suggest) { mode.value = 'history'; return }
  mode.value = 'suggest'
  show()
  busy.value = true
  const my = ++seq
  try {
    const d = await api.suggest({ q: kw, limit: props.limit, source: props.source || undefined })
    if (my !== seq) return                          // 输入已变, 丢弃这次结果
    if (props.modelValue.trim().toLowerCase() !== kw) return
    items.value = d.suggestions || []
  } catch {
    if (my === seq) items.value = []
  } finally {
    if (my === seq) busy.value = false
  }
  cursor.value = 0
}

function onFocus() {
  if (props.modelValue.trim()) fetchSuggest()
  else if (props.history) { mode.value = 'history'; show() }
}

function onInput(e) {
  emit('update:modelValue', e.target.value)
  emit('input', e.target.value)
  clearTimeout(timer)
  if (!e.target.value.trim()) {
    if (props.history) { mode.value = 'history'; show() }
    else hide()
    return
  }
  timer = setTimeout(fetchSuggest, 180)      // 与旧版一致的 180ms 防抖
}

function pick(tag) {
  emit('update:modelValue', tag)
  emit('pick', tag)
  hide()
}

function submit() {
  hide()
  emit('submit', props.modelValue)
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    const active = open.value && mode.value === 'suggest' ? items.value[cursor.value] : null
    if (active) {
      e.preventDefault()
      pick(active.tag)
    } else {
      submit()
    }
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (mode.value !== 'suggest' || !open.value || !items.value.length) return
    e.preventDefault()
    cursor.value = e.key === 'ArrowDown'
      ? (cursor.value + 1) % items.value.length
      : (cursor.value - 1 + items.value.length) % items.value.length
  } else if (e.key === 'Escape') {
    hide()
  }
}

function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) hide()
}
document.addEventListener('click', onDocClick)
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  clearTimeout(timer)
})

watch(() => props.modelValue, (v) => {
  if (!v) { items.value = []; cursor.value = 0 }
})

defineExpose({ focus: () => input.value?.focus(), hide })
</script>

<template>
  <div ref="root" class="sug">
    <input
      ref="input"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="[`s-${size}`]"
      type="text"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="onFocus"
      @keydown="onKeydown"
    >

    <div v-if="open" class="drop">
      <!-- 历史 -->
      <template v-if="showHistory">
        <template v-if="histItems.length">
          <div
            v-for="h in histItems"
            :key="h"
            class="item h"
            @mousedown.prevent="() => { emit('update:modelValue', h); submit() }"
          >
            <span class="h-ico">🔍</span>
            <span class="h-txt">{{ h }}</span>
            <span class="h-rm" title="从历史中删除" @mousedown.stop.prevent="hist.remove(h)">✕</span>
          </div>
          <div class="h-clear" @mousedown.prevent="hist.clear()">🗑 清空全部历史</div>
        </template>
        <div v-else class="msg">暂无搜索历史</div>
      </template>

      <!-- 补全 -->
      <template v-else>
        <div v-if="busy && !items.length" class="msg">搜索中...</div>
        <div v-else-if="!items.length" class="msg">没有匹配的标签</div>
        <div
          v-else
          v-for="(s, i) in items"
          :key="s.tag"
          :class="['item', { active: i === cursor }]"
          @mouseenter="cursor = i"
          @mousedown.prevent="pick(s.tag)"
        >
          <span class="s-en">{{ s.tag }}</span>
          <span v-if="s.zh" class="s-zh">{{ s.zh }}</span>
          <span class="s-cnt">{{ s.count }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sug { position: relative; min-width: 0; }
input {
  width: 100%;
  background: var(--panel2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 7px 10px; font-size: 13px; outline: none;
  transition: border-color var(--t-fast);
}
input.s-sm { padding: 5px 8px; font-size: 12px; }
input:focus { border-color: var(--accent); }
input::placeholder { color: var(--faint); }
input:disabled { opacity: .55; }

.drop {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 120;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r-sm); box-shadow: var(--shadow-1);
  max-height: 290px; overflow-y: auto;
}
.item {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 12px; font-size: 12px; cursor: pointer;
}
.item.active, .item:hover { background: var(--panel2); }
.s-en { flex: 1; color: var(--text); word-break: break-all; min-width: 0; }
.s-zh {
  color: var(--muted); font-size: 11px; white-space: nowrap;
  max-width: 45%; overflow: hidden; text-overflow: ellipsis;
}
.s-cnt { color: var(--accent); font-size: 11px; min-width: 44px; text-align: right; }
.msg { padding: 10px 12px; font-size: 12px; color: var(--muted); }

.item.h .h-ico { font-size: 11px; opacity: .7; }
.item.h .h-txt { flex: 1; color: var(--text); }
.h-rm { color: var(--muted); font-size: 11px; padding: 0 4px; border-radius: 3px; }
.h-rm:hover { color: #f66; background: rgba(255, 60, 60, .14); }
.h-clear {
  padding: 7px 12px; text-align: center; font-size: 12px; color: var(--muted);
  cursor: pointer; border-top: 1px solid var(--border);
}
.h-clear:hover { color: #f66; }
</style>
