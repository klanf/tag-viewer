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
  /**
   * 本地标签池 —— 传了(哪怕是空数组)就**完全不查库**, 只在这个数组里补全。
   * 元素形如 `{ tag, count, zh? }`。
   *
   * 扫描页要用它: 那里的图是**库外图片**(标签从 PNG 元数据现场解析),
   * 拿标签名去问标签库, 扫描夹特有的标签根本不在库里, 补不出东西来。
   * 不传(null) = 老行为, 走 `suggest:get` 查库。
   */
  localTags: { type: Array, default: null },
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

  // 本地标签池(扫描页): 同步过滤, 不往返主进程。
  if (props.localTags !== null) {
    const pool = props.localTags || []
    const toks = kw.split(/\s+/).filter(Boolean)
    const hits = []
    for (const t of pool) {
      if (!t || !t.tag) continue
      const en = String(t.tag).toLowerCase()
      // 标签名里的下划线/括号当空格再比一遍: 用户习惯按空格敲, 而库里存的是
      // blue_archive —— 少了这一下, 输入「blue archive」筛选能出结果, 补全却说
      // "没有匹配的标签", 两处自相矛盾。
      const flat = en.replace(/[_()]/g, ' ')
      const zh = String(t.zh || '')
      // 与"筛选"同一套语义: 空格分隔的每个词都要命中(AND), 不是把整串当一个词
      if (toks.every((w) => en.includes(w) || flat.includes(w) || zh.includes(w))) hits.push(t)
    }
    hits.sort((a, b) => (b.count || 0) - (a.count || 0))
    items.value = hits.slice(0, props.limit)
    cursor.value = 0
    busy.value = false
    return
  }

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
  /* 扫描页那个筛选框只有 300px 出头, 长标签(如 hoshino_(blue_archive))加上中文
     会被挤成两行。给个下限, 下拉可以比输入框宽; 输入框本身更宽时 right:0 照旧生效。 */
  min-width: 300px;
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
