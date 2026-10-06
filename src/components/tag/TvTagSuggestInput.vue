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
 *   Enter 只有在「↑↓ 或悬停主动选中了补全项」时才填充(cursor 初始 -1, 光出下拉不算选中);
 *   否则直接提交搜索 —— 这样模糊搜索不会被补全"劫持"(如输入 twint 直接回车 = contains 搜 twint)。
 *
 * multi 模式(2026-10-06, 看板搜索框专用; 扫描页是空格 AND 语义、标签页是单词搜索, 都不开):
 *   已选的词渲染成胶囊(可单独 ✕ 删除), 输入框里只保留「正在打的那一段」。
 *   中英文逗号(，/,)都算分隔符: 敲下逗号 = 当前段升级成胶囊, 接着打下一个词。
 *   联想只针对当前段; 选中补全 = 追加成胶囊, 不自动搜(组词节奏由回车/搜索按钮掌控)。
 *   下拉里多一个「全选」: 把当前词匹配到的标签(≤200, 按图片数排序)全部加入 ——
 *   配合组合模式 any 就是「输入发 → 发色发型全都要」的用法。
 *   Backspace 在输入框为空时删除最后一个胶囊; ✕ 一键清空全部。
 *
 * 通用改进(所有使用处受益):
 *   - 下拉里 ↑↓ 移动高亮项时, 超出可视区自动跟随滚动(scrollTop 手工算, 不用
 *     scrollIntoView —— 那个会把外层侧栏也滚走)。
 *   - 中文输入法组词中(isComposing)方向键/回车不再被抢走: 以前拼音候选确认那下
 *     回车会同时误触发搜索。
 *   - 下拉里对「已经选过的词」打 ✓(选它是空操作, 只弹提示), 防重复。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { api } from '@/utils/api.js'
import { useSearchHistory } from '@/composables/useSearchHistory.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { LS } from '@/utils/lskey.js'
import TvChip from '@/components/base/TvChip.vue'

/** 输入停稳多久算"用户筛的就是这个词" —— 扫描页筛选框的即时筛选没有搜索按钮, 只能这么认 */
const REMEMBER_MS = 1200

/** 「全选」一次最多加入多少个标签(后端 getSuggest 的输出上限同涨到 200) */
const PICK_ALL_MAX = 200

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  /** 是否启用补全 */
  suggest: { type: Boolean, default: true },
  /** 是否在空输入时显示搜索历史(只有首页搜索框需要) */
  history: { type: Boolean, default: false },
  /**
   * 这套历史存到哪个键(取自 utils/lskey.js 的 LS 表里某一项的 `.key`)。
   * 不传 = 用首页那份公用历史(`tv_search_hist`)。
   * 扫描页筛选框传自己那份(`tv_search_hist_scan`) —— 两边词表不是一回事, 混着存
   * 会互相污染(首页搜过的查询跑进筛选框的下拉里, 反之亦然)。
   */
  historyKey: { type: String, default: '' },
  /**
   * 历史下拉里那行小标题 —— 两套历史各自标明自己是哪一份,
   * 用户才看得出"扫描页筛过的词不会跑到首页搜索框里"。
   */
  historyLabel: { type: String, default: '搜索历史' },
  /**
   * 输入停稳后**自动记入历史**。
   * 首页那种"输入 + 明确点搜索"的框不需要(父组件在 submit 时自己 push);
   * 扫描页的筛选是即时的, 没有提交动作, 不自动记就永远是空历史。
   */
  remember: { type: Boolean, default: false },
  /** 参与补全的来源过滤 */
  source: { type: String, default: '' },
  /**
   * 胶囊多词模式: 已选词变胶囊、按段联想、选中追加不搜索、下拉带「全选」。
   * 只有看板搜索框开 —— 扫描页是空格分隔 AND(逗号只是普通字符), 标签页是单词搜索。
   */
  multi: { type: Boolean, default: false },
  /**
   * 本地标签池 —— 传了(哪怕是空数组)就**完全不查库**, 只在这个数组里补全。
   * 元素形如 `{ tag, count, zh? }`。
   *
   * 扫描页要用它: 那里的图是**库外图片**(标签从 PNG 元数据现场解析),
   * 拿标签名去问标签库, 扫描夹特有的标签根本不在库里, 补不出东西来。
   * 不传(null) = 老行为, 走 `suggest:get` 查库。
   */
  localTags: { type: Array, default: null },
  /**
   * 补全一条都没有时的提示语。
   * 扫描页要覆盖它: 那边的框除了标签还按**文件名**筛(见 ScanView),
   * 敲 a3 补不出标签很正常, 但网格确实筛出了 a3.png —— 只写"没有匹配的标签"
   * 会让人以为搜索框坏了。默认值就是老文案, 不传时行为不变。
   */
  emptyText: { type: String, default: '没有匹配的标签' },
  limit: { type: Number, default: 12 },
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'md' },
})
const emit = defineEmits(['update:modelValue', 'submit', 'pick', 'pick-many', 'input'])

const ui = useUiStore()
const hist = useSearchHistory(props.historyKey ? { key: props.historyKey } : LS.searchHistory)
const root = ref(null)
const input = ref(null)
const open = ref(false)
const mode = ref('suggest')       // suggest | history
const items = ref([])
const cursor = ref(-1)            // -1 = 没有主动选中的项: 裸回车 = 直接提交搜索,
                                  // ↑↓/悬停才算「主动选中」(见 onKeydown 的 Enter 分支)
const busy = ref(false)
const pickAllBusy = ref(false)
const focused = ref(false)

let timer = null
let rememberTimer = null
let seq = 0

/* ---------------- multi: 段与胶囊 ---------------- */
/** 按中英文逗号切段。modelValue 的最后一段 = 输入框里正在打的内容, 前面的段 = 已选胶囊 */
function segsOf(v) { return String(v || '').split(/[,，]/) }
const chips = computed(() => segsOf(props.modelValue).slice(0, -1).map((s) => s.trim()).filter(Boolean))
const activeSeg = computed(() => segsOf(props.modelValue)[segsOf(props.modelValue).length - 1] ?? '')
const chipsSet = computed(() => new Set(chips.value))
const hasAny = computed(() => Boolean(props.modelValue.trim()))

/** 当前联想关键词: multi 只看正在打的段, 老模式整串就是词 */
function currentKw() {
  const v = props.multi ? activeSeg.value : props.modelValue
  return String(v || '').trim().toLowerCase()
}
/** 已选胶囊拼回 modelValue 前缀。⚠️ 结尾用**裸逗号**不要 ", " ——
 * 尾随空格会让 activeSeg 变成 " " 而不是 "", 输入框非空 → Backspace 删胶囊失灵 */
function chipPrefix() { return chips.value.length ? chips.value.join(',') + ',' : '' }

const showHistory = computed(() =>
  props.history && mode.value === 'history' && !(props.multi && hasAny.value))
const histItems = computed(() => hist.list.value)

function show() { open.value = true }
function hide() { open.value = false }

/** 下拉可视区跟随: 只滚 .drop 自己, 不碰外层滚动容器 */
function scrollActiveIntoView() {
  const drop = root.value && root.value.querySelector('.drop')
  if (!drop) return
  const el = drop.querySelector('.item.active')
  if (!el) return
  const top = el.offsetTop
  if (top < drop.scrollTop) drop.scrollTop = top - 4
  else if (top + el.offsetHeight > drop.scrollTop + drop.clientHeight) {
    drop.scrollTop = top + el.offsetHeight - drop.clientHeight + 4
  }
}

async function fetchSuggest() {
  const kw = currentKw()
  if (!kw || !props.suggest) {
    mode.value = 'history'
    // multi 且已有胶囊: 空段没有可联想的东西, 收起下拉(胶囊本身已可见), 别弹历史/空态
    if (props.multi && hasAny.value) { hide(); return }
    if (props.history) show()
    else hide()
    return
  }
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
    cursor.value = -1
    busy.value = false
    nextTick(scrollActiveIntoView)
    return
  }

  busy.value = true
  const my = ++seq
  try {
    const d = await api.suggest({ q: kw, limit: props.limit, source: props.source || undefined })
    if (my !== seq) return                          // 输入已变, 丢弃这次结果
    if (currentKw() !== kw) return
    items.value = d.suggestions || []
  } catch {
    if (my === seq) items.value = []
  } finally {
    if (my === seq) busy.value = false
  }
  cursor.value = -1
  nextTick(scrollActiveIntoView)
}

/**
 * 聚焦时看 **DOM 里的值**, 不能看 props.modelValue:
 * 清空输入框后立刻聚焦(同一 tick)时, Vue 还没把新值刷回 prop, props 里仍是上一个词,
 * 于是跑去跑补全、把下拉顶成 suggest 模式 —— 结果"空输入应该出历史"这件最该看到的
 * 事反而看不到(e2e 就是这么抓出来的: 历史确实存了, 下拉却只有补全项)。
 * 老模式聚焦顺手全选旧词 —— 直接打字即可覆盖重搜。
 */
function onFocus(e) {
  focused.value = true
  const el = e && e.target
  const v = String(el && 'value' in el ? el.value : (props.multi ? activeSeg.value : props.modelValue) || '').trim()
  if (!props.multi && v && el.select) el.select()
  if (v) fetchSuggest()
  else if (props.multi && hasAny.value) hide()
  else if (props.history) { mode.value = 'history'; show() }
}

function onBlur() { focused.value = false }

function onInput(e) {
  const raw = e.target.value
  emit('input', raw)
  let mv = raw
  if (props.multi) {
    const parts = raw.split(/[,，]/)
    if (parts.length === 1) {
      mv = chipPrefix() + raw
    } else {
      // 敲了逗号(中/英): 前面的段升级成胶囊, 最后一段留在输入框继续打
      const lead = parts.slice(0, -1).map((s) => s.trim()).filter(Boolean)
      const all = [...chips.value, ...lead]
      mv = all.length ? all.join(',') + ',' + parts[parts.length - 1] : parts[parts.length - 1]
    }
  }
  emit('update:modelValue', mv)
  clearTimeout(timer)
  // 判空必须看 **DOM 里的 raw**: emit 之后 props.modelValue 这一刻还没刷回来,
  // 拿它派生的 currentKw() 读到的是上一个词 —— 联想定时器就永远设不上
  // (与 onFocus 同一个坑)。multi 下输入框只装当前段, raw 空即当前段空;
  // "还有没有胶囊"看刚算出来的 mv, 不看旧 prop。
  if (!raw.trim()) {
    if (props.multi && mv.trim()) { hide(); return }
    if (props.history) { mode.value = 'history'; show() }
    else hide()
    return
  }
  timer = setTimeout(fetchSuggest, 180)      // 与旧版一致的 180ms 防抖
}

/** 删一个胶囊(multi) */
function removeChip(c) {
  const all = chips.value.filter((t) => t !== c)
  emit('update:modelValue', all.length ? all.join(',') + ',' : '')
  input.value && input.value.focus()
}

function pick(tag) {
  if (props.multi) {
    if (chipsSet.value.has(tag)) { ui.toast(`已在筛选中: ${tag}`, 'info', 1400); return }
    emit('update:modelValue', chipPrefix() + tag + ',')
    emit('pick', tag)
    cursor.value = -1                       // 不再高亮任何项, 下一次 Enter = 提交搜索
    return                                  // 下拉保持开着 —— 连续组词不用再点输入框
  }
  emit('update:modelValue', tag)
  emit('pick', tag)
  if (props.remember) { clearTimeout(rememberTimer); hist.push(tag) }
  hide()
}

/**
 * 全选(multi): 把当前词匹配到的标签(按图片数排序, ≤200)全部交给父组件加入。
 * 组合模式怎么切是父组件的事(见 HomeView 的 onPickMany: all→any + toast)。
 */
async function pickAll() {
  if (pickAllBusy.value) return
  const kw = currentKw()
  if (!kw) return
  pickAllBusy.value = true
  try {
    const d = await api.suggest({ q: kw, limit: PICK_ALL_MAX, source: props.source || undefined })
    const tags = (d.suggestions || []).map((s) => s.tag).filter(Boolean)
    if (!tags.length) { ui.toast('没有匹配的标签', 'info', 1400); return }
    emit('pick-many', { tags, kw })
    hide()
  } catch (e) {
    ui.err('全选失败: ' + e.message)
  } finally {
    pickAllBusy.value = false
  }
}

function submit() {
  hide()
  if (props.remember) { clearTimeout(rememberTimer); hist.push(props.modelValue) }
  emit('submit', props.modelValue)
}

function onKeydown(e) {
  // 中文输入法组词中: 方向键/回车是 IME 的候选操作, 不归下拉管
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Backspace' && props.multi) {
    const el = input.value
    if (el && !el.value && chips.value.length) {
      e.preventDefault()
      const all = chips.value.slice(0, -1)
      emit('update:modelValue', all.length ? all.join(',') + ',' : '')
    }
    return
  }
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
    const n = items.value.length
    cursor.value = e.key === 'ArrowDown'
      ? (cursor.value + 1) % n
      : (cursor.value <= 0 ? n - 1 : cursor.value - 1)
    nextTick(scrollActiveIntoView)
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
  clearTimeout(rememberTimer)
})

watch(() => props.modelValue, (v) => {
  if (!v) { items.value = []; cursor.value = -1 }
  /* 自动记历史: 输入停稳就把当前值记下 —— 即时筛选没有"提交"这个动作,
     只能认"停住不动了"。清空会取消待记的那一条(用户在框里留下的才是他筛的)。 */
  if (!props.remember) return
  clearTimeout(rememberTimer)
  if (!v || !v.trim()) return
  rememberTimer = setTimeout(() => hist.push(v), REMEMBER_MS)
})

/* 键名是可换的(见 historyKey 注释) —— 换了就换一套历史, 不能把上一条键的内容留在内存里 */
watch(() => props.historyKey, (k) => {
  hist.load(k ? { key: k } : LS.searchHistory)
})

defineExpose({ focus: () => input.value?.focus(), hide })
</script>

<template>
  <div ref="root" class="sug">
    <!-- 胶囊多词模式(multi): 已选词 = 胶囊, 输入框只装正在打的段 -->
    <div v-if="multi" :class="['tagbox', `s-${size}`, { focused }]" @focusin="focused = true" @focusout="focused = false">
      <TvChip
        v-for="c in chips"
        :key="c"
        :label="c"
        removable
        readonly
        class="chip"
        @remove="removeChip(c)"
      />
      <input
        ref="input"
        :value="activeSeg"
        :placeholder="chips.length ? '' : placeholder"
        :disabled="disabled"
        type="text"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      >
      <span
        v-if="hasAny"
        class="clear"
        title="清空全部标签"
        @mousedown.prevent="() => { emit('update:modelValue', ''); hide(); input?.focus() }"
      >✕</span>
    </div>

    <!-- 老模式: 单输入框(扫描页筛选 / 标签页搜索) -->
    <input
      v-else
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
      @blur="onBlur"
      @keydown="onKeydown"
    >

    <div v-if="open" class="drop">
      <!-- 历史 -->
      <template v-if="showHistory">
        <div class="h-head">{{ historyLabel }}</div>
        <template v-if="histItems.length">
          <div
            v-for="h in histItems"
            :key="h"
            class="item h"
            :title="h"
            @mousedown.prevent="() => { emit('update:modelValue', h); submit() }"
          >
            <span class="h-ico">🔍</span>
            <span class="h-txt">{{ h }}</span>
            <span class="h-rm" title="从历史中删除" @mousedown.stop.prevent="hist.remove(h)">✕</span>
          </div>
          <div class="h-clear" @mousedown.prevent="hist.clear()">🗑 清空全部历史</div>
        </template>
        <div v-else class="msg">暂无{{ historyLabel }}</div>
      </template>

      <!-- 补全 -->
      <template v-else>
        <div v-if="multi && items.length" class="pick-all" @mousedown.prevent="pickAll">
          <span v-if="pickAllBusy">取标签中...</span>
          <span v-else title="把当前词匹配到的标签全部加入(≤200 个, 按图片数排序); 多标签要配「any - 任一命中」才出结果">✚ 全选匹配的标签</span>
        </div>
        <div v-if="busy && !items.length" class="msg">搜索中...</div>
        <div v-else-if="!items.length" class="msg">{{ emptyText }}</div>
        <div
          v-else
          v-for="(s, i) in items"
          :key="s.tag"
          :class="['item', { active: i === cursor, dup: chipsSet.has(s.tag) }]"
          :title="chipsSet.has(s.tag) ? '已在筛选中(再点是空操作)' : ''"
          @mouseenter="cursor = i"
          @mousedown.prevent="pick(s.tag)"
        >
          <span class="s-en">{{ s.tag }}<span v-if="chipsSet.has(s.tag)" class="s-dup"> ✓已选</span></span>
          <span v-if="s.zh" class="s-zh">{{ s.zh }}</span>
          <span class="s-cnt">{{ s.count }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sug { position: relative; min-width: 0; }

/* 老模式的单输入框 */
.sug > input {
  width: 100%;
  background: var(--panel2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 7px 10px; font-size: 13px; outline: none;
  transition: border-color var(--t-fast);
}
.sug > input.s-sm { padding: 5px 8px; font-size: 12px; }
.sug > input:focus { border-color: var(--accent); }
.sug > input::placeholder { color: var(--faint); }
.sug > input:disabled { opacity: .55; }

/* multi: 胶囊容器。外观对齐老输入框, 里面是 胶囊 + 裸输入框 + ✕ */
.tagbox {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  width: 100%;
  background: var(--panel2);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 26px 4px 6px;
  cursor: text;
  transition: border-color var(--t-fast);
}
.tagbox:focus-within { border-color: var(--accent); }
.tagbox input {
  flex: 1 1 110px; min-width: 110px;
  border: 0; outline: none; background: transparent;
  color: var(--text); font-size: 13px; padding: 3px 4px;
}
.tagbox input::placeholder { color: var(--faint); }
.tagbox input:disabled { opacity: .55; }
.tagbox .chip { max-width: 100%; }
.clear {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  /* 常态就是红的 —— 灰色太不显眼, 用户在全选了一堆词之后找不到它(2026-10-06 反馈) */
  color: var(--danger, #e5484d); font-size: 12px; line-height: 1;
  padding: 3px 5px; border-radius: 3px; cursor: pointer;
}
.clear:hover { background: rgba(255, 60, 60, .16); }

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
.item.dup { opacity: .62; }
.s-en { flex: 1; color: var(--text); word-break: break-all; min-width: 0; }
.s-dup { color: var(--accent); font-size: 11px; }
.s-zh {
  color: var(--muted); font-size: 11px; white-space: nowrap;
  max-width: 45%; overflow: hidden; text-overflow: ellipsis;
}
.s-cnt { color: var(--accent); font-size: 11px; min-width: 44px; text-align: right; }
.msg { padding: 10px 12px; font-size: 12px; color: var(--muted); }

.pick-all {
  position: sticky; top: 0; z-index: 1;
  padding: 7px 12px; font-size: 12px; color: var(--accent);
  background: var(--panel); cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.pick-all:hover { background: var(--panel2); }

.item.h .h-ico { font-size: 11px; opacity: .7; flex: 0 0 auto; }
.item.h .h-txt {
  flex: 1; color: var(--text); min-width: 0;
  /* 「全选」会把一大串标签存进历史, 不截断的话删除按钮会被顶出可视区(2026-10-06 反馈) */
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.h-head {
  padding: 6px 12px 4px; font-size: 11px; color: var(--faint);
  border-bottom: 1px solid var(--border); margin-bottom: 2px;
}
.h-rm { color: var(--muted); font-size: 11px; padding: 0 4px; border-radius: 3px; flex: 0 0 auto; }
.h-rm:hover { color: #f66; background: rgba(255, 60, 60, .14); }
.h-clear {
  padding: 7px 12px; text-align: center; font-size: 12px; color: var(--muted);
  cursor: pointer; border-top: 1px solid var(--border);
}
.h-clear:hover { color: #f66; }
</style>
