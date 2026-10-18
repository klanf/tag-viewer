<script setup>
/**
 * Tag 联想输入框 —— 规则构建器的模式侧 / 替换标签侧共用
 * =====================================================
 * 数据源就是看板搜索框那个 suggest:get(库内 tag + 中文翻译 + 图片数,
 * 支持中文关键词), 没有任何新后端。
 *
 * 两种用法(variant):
 *   fill(默认)  v-model          —— 模式侧: 选了就**填进输入框**, 还能接着改
 *   chips       @pick + @confirm —— 替换侧: 选了/回车确认就交给父级 push chip, 输入框清空
 * 库外自由输入永远允许(通配模式、还没入库的新 tag 都要能写)。
 */
import { ref, computed, watch } from 'vue'
import { api } from '@/utils/api.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '输入关键词(中英文都可以)…' },
  /** 下拉条数上限(suggest:get 上限 200) */
  limit: { type: Number, default: 12 },
  /** fill=选词填入输入框(模式侧) / chips=选词清空交父级(替换侧) */
  variant: { type: String, default: 'fill' },
})
const emit = defineEmits(['update:modelValue', 'pick', 'confirm'])

const text = ref(props.modelValue)
const sug = ref([])          // [{tag, zh, count}]
const active = ref(-1)       // 键盘高亮行; -1 = 没选
const open = ref(false)
const focused = ref(false)   // 输入框是否持有焦点 —— 联想响应回来时必须看它,
                             // 否则切组/外部改值触发的联想会把**没聚焦**的框的下拉弹出来
const loading = ref(false)

watch(() => props.modelValue, (v) => { if (v !== text.value) text.value = v })

let timer = 0
watch(text, (v) => {
  emit('update:modelValue', v)
  clearTimeout(timer)
  if (!v.trim()) { sug.value = []; open.value = false; active.value = -1; return }
  timer = setTimeout(async () => {
    loading.value = true
    try {
      const r = await api.suggest({ q: v.trim(), limit: props.limit })
      sug.value = r?.suggestions || []
      // 只有正持有焦点的框才自动展开; blur 后才回来的响应只更新数据不弹下拉
      open.value = focused.value && sug.value.length > 0
      active.value = open.value && sug.value.length ? 0 : -1
    } catch { sug.value = []; open.value = false } finally { loading.value = false }
  }, 220)
})

function choose(item) {
  emit('pick', item.tag)
  if (props.variant === 'chips') {
    text.value = ''
  } else {
    text.value = item.tag       // fill: 填入可继续编辑, 不清空
  }
  open.value = false
  sug.value = []
  active.value = -1
}

function onKey(e) {
  if (open.value && sug.value.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); active.value = (active.value + 1) % sug.value.length; return }
    if (e.key === 'ArrowUp') { e.preventDefault(); active.value = (active.value - 1 + sug.value.length) % sug.value.length; return }
    if (e.key === 'Enter' && active.value >= 0) { e.preventDefault(); choose(sug.value[active.value]); return }
  }
  if (e.key === 'Enter') {
    const v = text.value.trim()
    if (v) {
      e.preventDefault()
      emit('confirm', v)
      if (props.variant === 'chips') { text.value = ''; open.value = false }
      else { open.value = false }   // fill: 回车用输入框原文, 文本保留
    }
  } else if (e.key === 'Escape') {
    open.value = false
  }
}

const fmtCount = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n ?? 0))
const hasSug = computed(() => open.value && sug.value.length > 0)
</script>

<template>
  <div class="twc">
    <input
      v-model="text"
      class="twc-input"
      :placeholder="placeholder"
      spellcheck="false"
      autocomplete="off"
      @keydown="onKey"
      @focus="focused = true; open = sug.length > 0"
      @blur="focused = false; open = false"
    >
    <ul v-if="hasSug" class="twc-drop">
      <li
        v-for="(s, i) in sug"
        :key="s.tag"
        :class="{ act: i === active }"
        @mousedown.prevent="choose(s)"
        @mousemove="active = i"
      >
        <span class="tag">{{ s.tag }}</span>
        <span class="zh" :class="{ none: !s.zh }">{{ s.zh || '—' }}</span>
        <span class="cnt">{{ fmtCount(s.count) }}</span>
      </li>
      <li class="hint">↑↓ 选择 · 回车填入 · 直接回车 = 用输入框原文</li>
    </ul>
  </div>
</template>

<style scoped>
.twc { position: relative; display: inline-flex; flex-direction: column; }
.twc-input {
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 8px; font-size: 12px; font-family: Consolas, Menlo, monospace;
  outline: none; min-width: 150px;
}
.twc-input::placeholder { color: var(--faint); opacity: 1; }
.twc-input:focus { border-color: var(--accent); }
.twc-drop {
  position: absolute; top: calc(100% + 3px); left: 0; z-index: 60;
  min-width: 270px; max-height: 240px; overflow: auto;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r-sm); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
  list-style: none; margin: 0; padding: 2px;
}
.twc-drop li {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 8px; font-size: 11px; border-radius: 4px; cursor: pointer;
}
.twc-drop li.act { background: var(--panel2, rgba(127, 127, 127, 0.15)); }
.tag { font-family: Consolas, Menlo, monospace; flex: 1; }
.zh { color: var(--muted); }
.zh.none { color: var(--faint); }
.cnt { color: var(--faint); font-size: 10px; white-space: nowrap; }
.hint { color: var(--faint); font-size: 10px; cursor: default; border-top: 1px solid var(--border); border-radius: 0; }
</style>
