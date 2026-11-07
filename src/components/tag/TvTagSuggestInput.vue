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
 * multi 模式(2026-10-30 二稿, 看板搜索框开宽档; 扫描页筛选框开窄档):
 *   **纯文本, 没有胶囊** —— 输入框里就是完整字符串 "1girl, 1boy, hosh"(2026-10-30
 *   用户定稿: 胶囊 UI 去掉, 看起来就是普通的 tag 输入, 定格词以 ", " 分隔)。
 *   分隔符两档: 窄档(扫描页)=中英文逗号; 宽档(看板)=空格/中英文逗号/顿号/中英文分号/竖线。
 *   敲分隔符 = 当前词定格 + **立即触发一次搜索**(搜索/清空按钮已删, 敲分隔符就是"搜索键");
 *   连续多个分隔符只算一次(不产生空词), 重复词跳过并提示。
 *   联想只针对**最后一个词**; 选中补全(点/Tab/Enter)= 仅把最后一个词补全成所选词,
 *   不定格不搜索 —— 组词节奏完全由分隔符掌控。
 *   下拉里多一个「全选」: 把当前词匹配到的标签(≤200, 按图片数排序)全部加入 ——
 *   配合组合模式 any 就是「输入发 → 发色发型全都要」的用法。
 *   ✕ 一键清空全部并回到"浏览全部"; Backspace 回归原生删字符(没有胶囊可删)。
 *
 * 通用改进(所有使用处受益):
 *   - 下拉里 ↑↓ 移动高亮项时, 超出可视区自动跟随滚动(scrollTop 手工算, 不用
 *     scrollIntoView —— 那个会把外层侧栏也滚走)。
 *   - 中文输入法组词中(isComposing)方向键/回车不再被抢走: 以前拼音候选确认那下
 *     回车会同时误触发搜索。
 *   - 下拉里对「已经选过的词」打 ✓(选它是空操作, 只弹提示), 防重复。
 *   - 联想项带「槽·大类」归属(2026-10-30): 后端 suggest:get 补发 slot/slotZh/sec,
 *     下拉里显示 `中文（槽·大类）` —— 用户能看出这个词属于哪个槽(配合高级替换按槽配置)。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { api } from '@/utils/api.js'
import { useSearchHistory } from '@/composables/useSearchHistory.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { LS } from '@/utils/lskey.js'

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
   * 多词模式(纯文本, 没有胶囊): 分隔符定格 + 定格即搜索 + 联想针对最后一个词。
   * 看板搜索框(wide-sep 宽档)和扫描页筛选框(窄档)都开。
   */
  multi: { type: Boolean, default: false },
  /**
   * 宽分隔符(2026-10-30): 空格/顿号/分号/竖线也当"定格+搜索"键。
   * 只给看板搜索框开 —— 扫描页筛选框的空格是 AND 分词的普通字符(词表里带空格的
   * 查询合法), 开了宽档会把 'blue archive' 撕成两个词, 筛选语义全变。
   */
  wideSep: { type: Boolean, default: false },
  /**
   * 本地标签池 —— 传了(哪怕是空数组)就**完全不查库**, 只在这个数组里补全。
   * 元素形如 `{ tag, count?, zh?, slotZh?, sec? }`(count 缺省不显示计数)。
   *
   * 两类使用者:
   *   - 扫描页: 那里的图是**库外图片**(标签从 PNG 元数据现场解析),
   *     拿标签名去问标签库, 扫描夹特有的标签根本不在库里, 补不出东西来。
   *   - 高级替换弹窗的钉词: 只允许从所选槽的池子里挑, 池子词条带「槽·大类」标识。
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

/* ---------------- multi: 纯文本多词 ---------------- */
/** multi 分隔符两档:
 *  · 窄(缺省, 扫描页筛选框): 只有中英文逗号 —— 那边的空格是 AND 分词的普通字符,
 *    当分隔符会把它撕成两个词, 筛选结果全变(2026-10-30 e2e 实锤 13 条)
 *  · 宽(wide-sep, 看板搜索框): 空格/中英文逗号/顿号/中英文分号/竖线都算 */
const SEPS_NARROW = /[,，]/
const SEPS_WIDE = /[,，、;；|\s]+/
const seps = () => (props.wideSep ? SEPS_WIDE : SEPS_NARROW)
/** 定格词统一以 ", " 分隔(2026-10-30 用户定稿的样例格式 "1girl, 1boy,") */
const JOINT = ', '
/** 归一键: 小写 + 空格/下划线归一 —— 重复词判定用它, 展示用原文 */
const normKey = (w) => String(w || '').toLowerCase().replace(/[\s_]+/g, '_')
/** 把完整串切成 { done: [定格词...], active: 正在打的词 } */
function wordsOf(v) {
  const parts = String(v || '').split(seps()).map((s) => s.trim())
  return { done: parts.slice(0, -1).filter(Boolean), active: parts[parts.length - 1] ?? '' }
}
/** 拼回完整串: 定格词 join(', ') + 尾逗号 + 正在打的词 */
function renderVal(done, active) {
  return (done.length ? done.join(JOINT) + JOINT : '') + active
}
/** 正在打的词(联想关键词的原料) */
const activeSeg = computed(() => wordsOf(props.modelValue).active)
/** 已定格词(无尾逗号的 "blue_archive" 也算 —— 回车即搜) */
const doneWords = computed(() => wordsOf(props.modelValue).done)
const doneSet = computed(() => new Set(doneWords.value.map(normKey)))
const hasAny = computed(() => Boolean(props.modelValue.trim()))

/** 当前联想关键词: multi 只看正在打的词, 老模式整串就是词 */
function currentKw() {
  const v = props.multi ? activeSeg.value : props.modelValue
  return String(v || '').trim().toLowerCase()
}

const showHistory = computed(() =>
  props.history && mode.value === 'history' && !(props.multi && doneWords.value.length))
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
    // multi 且已有定格词: 空词没有可联想的东西, 收起下拉, 别弹历史/空态
    if (props.multi && doneWords.value.length) { hide(); return }
    if (props.history) show()
    else hide()
    return
  }
  mode.value = 'suggest'
  show()

  // 本地标签池(扫描页/钉词槽池): 同步过滤, 不往返主进程。
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
  const v = String(el && 'value' in el ? el.value : props.modelValue || '').trim()
  if (!props.multi && v && el.select) el.select()
  if (v) fetchSuggest()
  else if (props.multi && doneWords.value.length) hide()
  else if (props.history) { mode.value = 'history'; show() }
}

function onBlur() { focused.value = false }

function onInput(e) {
  const raw = e.target.value
  emit('input', raw)
  let mv = raw
  let finalized = false   // 这次输入里有没有"敲了分隔符定格词"
  if (props.multi) {
    const parts = raw.split(seps())
    if (parts.length === 1) {
      mv = renderVal(doneWords.value, raw)
    } else {
      // 敲了分隔符: 定格词 = 已定格 + 新定格的段(连续多个分隔符只算一次), 归一成 ", " 分隔
      const { done, active } = wordsOf(raw)
      const all = [...doneWords.value]
      for (const w of done) {
        if (all.some((c) => normKey(c) === normKey(w))) {
          if (done.length === 1) ui.toast(`已在筛选中: ${w}`, 'info', 1400)
          continue
        }
        all.push(w)
      }
      mv = renderVal(all, active)
      finalized = true
    }
  }
  emit('update:modelValue', mv)
  // 定格即搜索(2026-10-30): 敲分隔符 = 定格 + 立即触发一次搜索 ——
  // 搜索/清空按钮已经删了, 敲分隔符就是"搜索键"。
  // mv 非空才发(纯清空的路径走下面 !raw 分支); 下拉收起, 别悬在搜索结果上。
  if (props.multi && finalized) {
    hide()
    emit('submit', mv)
    return
  }
  clearTimeout(timer)
  // 判空必须看 **DOM 里的 raw**: emit 之后 props.modelValue 这一刻还没刷回来,
  // 拿它派生的 currentKw() 读到的是上一个词 —— 联想定时器就永远设不上
  // (与 onFocus 同一个坑)。multi 下输入框装完整串, raw 空即整串空;
  // "还有没有定格词"看刚算出来的 mv, 不看旧 prop。
  if (!raw.trim()) {
    if (props.multi && mv.trim()) { hide(); return }
    if (props.history) { mode.value = 'history'; show() }
    else hide()
    return
  }
  timer = setTimeout(fetchSuggest, 180)      // 与旧版一致的 180ms 防抖
}

function pick(tag) {
  if (props.multi) {
    // 仅补全(2026-10-30 定稿): 把正在打的词补全成所选词, 不定格、不搜索 ——
    // 定格归分隔符管(敲空格/逗号才定格+搜索); 下拉保持开着, 连续换词不用再点输入框
    emit('update:modelValue', renderVal(doneWords.value, tag))
    emit('pick', tag)
    cursor.value = -1                       // 不再高亮任何项, 下一次 Enter = 提交搜索
    return
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
  if (e.key === 'Enter') {
    const active = open.value && mode.value === 'suggest' ? items.value[cursor.value] : null
    if (active) {
      e.preventDefault()
      pick(active.tag)      // 仅补全(2026-10-30): 再按一次 Enter(无高亮项)才提交搜索
    } else {
      submit()
    }
    return
  }
  if (e.key === 'Tab' && props.multi) {
    // Tab = 补全(不打断输入节奏): 有高亮项就补全, 没有就让默认行为走
    const active = open.value && mode.value === 'suggest' ? items.value[cursor.value] : null
    if (active) { e.preventDefault(); pick(active.tag) }
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
    <!-- 统一单输入框(2026-10-30 二稿): multi 也是纯文本 —— 完整字符串 "1girl, 1boy, hosh",
         没有胶囊; ✕ 清空浮在框右侧(仅 multi) -->
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
      @blur="onBlur"
      @keydown="onKeydown"
    >
    <span
      v-if="multi && hasAny"
      class="clear"
      title="清空全部标签并回到全部图片"
      @mousedown.prevent="() => { emit('update:modelValue', ''); hide(); input?.focus(); emit('submit', '') }"
    >✕</span>

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
          :class="['item', { active: i === cursor, dup: doneSet.has(normKey(s.tag)) }]"
          :title="doneSet.has(normKey(s.tag)) ? '已在筛选中(再点是空操作)' : ''"
          @mouseenter="cursor = i"
          @mousedown.prevent="pick(s.tag)"
        >
          <span class="s-en">{{ s.tag }}<span v-if="doneSet.has(normKey(s.tag))" class="s-dup"> ✓已选</span></span>
          <span v-if="s.zh || s.slotZh" class="s-zh">
            {{ s.zh }}<template v-if="s.slotZh">（{{ s.slotZh }}<span v-if="s.sec">·{{ s.sec }}</span>）</template>
          </span>
          <span v-if="s.count != null" class="s-cnt">{{ s.count }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sug { position: relative; min-width: 0; }

/* 单输入框(所有模式统一 —— 2026-10-30 二稿: multi 去胶囊, 也是纯文本) */
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

/* ✕ 清空(仅 multi): 浮在输入框右侧 —— 红色常亮, 全选了一堆词之后找得到它(2026-10-06 反馈) */
.clear {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
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
  max-width: 52%; overflow: hidden; text-overflow: ellipsis;
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
