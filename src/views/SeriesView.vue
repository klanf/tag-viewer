<script setup>
/**
 * 系列浏览 —— 原 series.html
 * ==========================
 * 三层视图(同一个路由内切换, 不换页 —— 原版也是这样, 靠 showView() 切 div):
 *   1. 系列列表: 分类 tab + 中英文搜索 + ⚙️ 分类管理
 *   2. 角色列表: 四种排序 + 选择模式(批量入购物车) + 🛒 单个入车
 *   3. 图片: 该角色的图, 无限滚动, 可换排序/每页数量
 *
 * 原版用 window.scrollY 记忆滚动位置, 这个 SPA 里滚动发生在面板内部,
 * 所以改成记录/恢复面板的 scrollTop —— 返回时同样"回到刚才的位置"。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TvSourceChips from '@/components/filter/TvSourceChips.vue'
import TvEntityCard from '@/components/series/TvEntityCard.vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvInput from '@/components/base/TvInput.vue'
import TvTabs from '@/components/base/TvTabs.vue'
import TvState from '@/components/base/TvState.vue'
import TvCategoryManager from '@/components/rules/TvCategoryManager.vue'
import TvCoverPickerModal from '@/components/series/TvCoverPickerModal.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useFloatBack } from '@/composables/useFloatBack.js'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { nfmt, stripZhSeries } from '@/utils/format.js'

const src = useSourceStore()
const cart = useCartStore()
const lb = useLightboxStore()
const ui = useUiStore()
const prefs = usePrefsStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()

const view = ref('series')        // series | chars | images
const loading = ref(false)
const listError = ref('')

/* 三层视图是组件内状态(不产生路由历史), 浮动返回按层级回退:
   图片网格 -> 角色列表 -> 全部系列; 都不在顶层才走路由回退。
   不接管的话 router.back() 会跳过这些层级, 直接回到上一个路由
   (比如之前用过的扫描页) —— 不是用户期望的「回到上一级」。 */
useFloatBack(() => {
  if (view.value === 'images') { backToChars(); return true }
  if (view.value === 'chars') { showSeriesList(); return true }
  return false
})

/* ---------------- 一: 系列列表 ---------------- */
const seriesData = ref(null)
const curCat = ref('all')
const seriesKw = ref('')
const seriesZh = ref({})          // 系列名 -> 中文
const showCatMgr = ref(false)

const scrollSeries = ref(0)
const scrollChars = ref(0)
const seriesScrollEl = ref(null)
const charScrollEl = ref(null)
const imgScrollEl = ref(null)

const CATEGORY_LABELS = computed(() => ({
  game: '游戏', anime: '动漫', vtb: 'Vtuber', other: '其他',
  ...(seriesData.value?.category_labels || {}),
}))

const catTabs = computed(() => {
  const d = seriesData.value
  if (!d) return [{ value: 'all', label: '全部' }]
  const custom = d.custom_categories || []
  const cats = ['game', 'anime', 'vtb', 'other', ...custom.filter((c) => !CATEGORY_LABELS.value[c])]
  const cnt = {}
  for (const s of d.series) cnt[s.category] = (cnt[s.category] || 0) + 1
  const hidden = d.hidden_categories || []
  const all = { value: 'all', label: '全部', count: d.series.filter((s) => !hidden.includes(s.category)).length }
  const rest = cats.map((c) => ({
    value: c,
    label: CATEGORY_LABELS.value[c] || c,
    count: cnt[c] || 0,
    dim: hidden.includes(c),
    title: hidden.includes(c) ? '该分类已被隐藏' : '',
  }))
  return [all, ...rest]
})

const shownSeries = computed(() => {
  const d = seriesData.value
  if (!d) return []
  const hidden = d.hidden_categories || []
  const kw = seriesKw.value.trim()
  const kwl = kw.toLowerCase()
  return d.series
    .filter((s) => !hidden.includes(s.category))
    .filter((s) => (curCat.value === 'all' ? true : s.category === curCat.value))
    .filter((s) => {
      if (!kwl) return true
      if (s.name.toLowerCase().includes(kwl)) return true
      const zh = seriesZh.value[s.name] || ''
      return !!zh && zh.includes(kw)
    })
})

async function loadSeries() {
  loading.value = true
  listError.value = ''
  try {
    // withZero: 「显示无本地图的角色」开关 —— 决定系列列表的角色数统计口径
    seriesData.value = await api.series({ source: src.param, withZero: prefs.seriesShowZero })
    // 中文名: 一次批量查, 拿到之后卡片与搜索都能用上
    const names = seriesData.value.series.map((s) => s.name)
    if (names.length) {
      try {
        const m = await api.translate(names)
        seriesZh.value = { ...seriesZh.value, ...m }
      } catch { /* 没有翻译库也能用 */ }
    }
  } catch (e) {
    listError.value = e.message
  } finally {
    loading.value = false
  }
}

async function showSeriesList() {
  view.value = 'series'
  curSeries.value = ''          // 清掉, 面包屑才不会残留上一级系列名
  curChar.value = null
  await loadSeries()
  requestAnimationFrame(() => { if (seriesScrollEl.value) seriesScrollEl.value.scrollTop = scrollSeries.value })
}

/* ---------------- 二: 角色列表 ---------------- */
const curSeries = ref('')
const curSeriesZh = ref('')
const charData = ref([])
const charSort = ref('name')
const charsLoading = ref(false)
const selectMode = ref(false)
const selected = ref(new Set())
/** 角色完整标签 -> 中文(形如「莉央(blue_archive)」, 显示前要剥掉系列尾巴) */
const charZh = ref({})

const sortedChars = computed(() => {
  const arr = [...charData.value]
  const s = charSort.value
  if (s === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  else if (s === 'name_desc') arr.sort((a, b) => b.name.localeCompare(a.name, 'en'))
  else if (s === 'images_asc') arr.sort((a, b) => a.images - b.images)
  else arr.sort((a, b) => b.images - a.images)
  return arr
})

async function loadChars(series) {
  charsLoading.value = true
  try {
    // withZero: 开着时带上 0 图的补全角色(可入购物车, 卡片显示占位封面)
    const d = await api.characters({ series, source: src.param, withZero: prefs.seriesShowZero })
    charData.value = d.characters || []
    // 角色翻译: key 是完整标签(rio_(blue_archive)), 显示时去掉系列尾巴
    const need = charData.value.map((c) => c.tag)
    if (need.length) {
      try { charZh.value = { ...charZh.value, ...await api.translate(need) } } catch { /* 忽略 */ }
    }
  } catch (e) {
    ui.err('角色加载失败: ' + e.message)
    charData.value = []
  } finally {
    charsLoading.value = false
  }
}

async function openSeries(s) {
  scrollSeries.value = seriesScrollEl.value?.scrollTop || 0
  curSeries.value = s.name
  curSeriesZh.value = seriesZh.value[s.name] || ''
  selected.value = new Set()
  if (selectMode.value) selectMode.value = false
  view.value = 'chars'
  await loadChars(s.name)
  requestAnimationFrame(() => { if (charScrollEl.value) charScrollEl.value.scrollTop = scrollChars.value })
}

function backToChars() {
  if (!curSeries.value) { showSeriesList(); return }
  view.value = 'chars'
  requestAnimationFrame(() => { if (charScrollEl.value) charScrollEl.value.scrollTop = scrollChars.value })
}

/* 选择模式 */
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.value = new Set()
  ui.toast(selectMode.value ? '选择模式: 点击角色卡片勾选' : '已退出选择模式', 'info', 1600)
}
function toggleSelect(c) {
  const s = new Set(selected.value)
  if (s.has(c.tag)) s.delete(c.tag)
  else s.add(c.tag)
  selected.value = s
}
function selectAll() { selected.value = new Set(charData.value.map((c) => c.tag)) }
function invertSelect() {
  const s = new Set()
  for (const c of charData.value) if (!selected.value.has(c.tag)) s.add(c.tag)
  selected.value = s
}
function clearSelect() { selected.value = new Set() }

/** 把选中的角色加入购物车(与旧版 exportSelected 的语义一致: 已存在的算 skipped)。
 *  入车时把视图里已查到的中文翻译带上(剥掉系列尾巴) —— 以前只传 c.name(英文短名),
 *  购物车条目名就一直是英文, 中文翻译等于掉了(2026-10-06 用户反馈)。 */
function cartNameOf(c) {
  return stripZhSeries(charZh.value[c.tag]) || c.name
}
function addSelectedToCart() {
  if (!selected.value.size) { ui.warn('请先选择至少一个角色'); return }
  const chars = charData.value
    .filter((c) => selected.value.has(c.tag))
    .map((c) => ({ ...c, name: cartNameOf(c) }))
  const r = cart.addMany(chars, curSeries.value)
  ui.ok(`🛒 新增 ${r.added}${r.skipped ? `, 已存在 ${r.skipped}` : ''}, 购物车共 ${cart.count}`, 2400)
  toggleSelectMode()
}

function toggleCartOne(c) {
  const name = cartNameOf(c)
  const added = cart.toggle({ ...c, name }, curSeries.value)
  ui.ok(added ? `🛒 已加入: ${name}` : `已移除: ${name}`, 'info', 1400)
}

function inCart(tag) { return cart.has(tag) }

/* ---------------- 三: 图片 ---------------- */
const imgFeed = useImageFeed({ infinite: true, pageSize: 60 })

/**
 * 当前图片流顺序 —— 传给大图预览做「上一张 / 下一张」。
 * 无限滚动追加后会被 watch 同步进去, 所以滚到哪就能翻到哪。
 */
const shownResults = computed(() => safety.filterItems(imgFeed.results.value))
const imgPaths = computed(() => shownResults.value.map((i) => i.path).filter(Boolean))
watch(imgPaths, (arr) => { if (lb.visible) lb.setList(arr) })
const imgSort = ref(prefs.sortSeries)
const imgPageSize = ref(60)
const curChar = ref(null)

async function openCharImages(c) {
  scrollChars.value = charScrollEl.value?.scrollTop || 0
  curChar.value = c
  view.value = 'images'
  imgFeed.setPageSize(imgPageSize.value)
  await imgFeed.search(imgQuery(0))
  requestAnimationFrame(() => { if (imgScrollEl.value) imgScrollEl.value.scrollTop = 0 })
}

function imgQuery() {
  // 同一角色的两种写法(短名 frieren / 全名 frieren_(sousou_no_frieren))在角色列表里
  // 已合并成一张卡, 所以图集这边要**两种都搜**: exact 多 tag(逗号分隔, 默认 mode=any)
  // 命中任一即算。**不能用 contains + 短名** —— 短名子串会顺带命中别的作品角色。
  const c = curChar.value
  const tags = [c?.tag, ...(c?.alt || [])].filter(Boolean)
  return {
    q: tags.join(','),
    match: 'exact',
    sort: imgSort.value,
    source: src.param,
  }
}

function reloadImages() { if (curChar.value) imgFeed.search(imgQuery()) }

/** 面包屑 */
const crumb = computed(() => ({
  series: curSeries.value,
  seriesZh: curSeriesZh.value,
  char: curChar.value?.name || '',
}))

/** 面包屑悬停复制: 复制该层的 tag 名(系列用英文 tag, 角色用名字) */
function copyCrumb(text, label) {
  if (!text) return
  ui.copy(text)
  ui.ok(`📋 已复制${label}: ${text}`, 'ok', 1400)
}

/** 来源变化: 系列/角色/图片全部重算 */
async function onSourceChange() {
  if (view.value === 'series') return showSeriesList()
  if (view.value === 'chars' && curSeries.value) return loadChars(curSeries.value)
  if (view.value === 'images' && curChar.value) return reloadImages()
}

/* ---------------- 自定义封面(2026-10-06) ---------------- */
const showCoverPick = ref(false)
const coverPick = ref(null)   // { kind, key, title, current }

function openCoverPick(kind, key, title, current) {
  coverPick.value = { kind, key, title, current }
  showCoverPick.value = true
}

/** 挑完/恢复默认后重拉当前层, 卡片封面立刻换新 */
function onCoverSaved() {
  if (view.value === 'series') return loadSeries()
  if (view.value === 'chars' && curSeries.value) return loadChars(curSeries.value)
}

/* 封面是主进程按**当前安全档位**挑的 —— 🛡 开关/档位一变, 列表层要重拉才拿得到新封面。
   (图片层的网格走 safety.filterItems 即时过滤, 不用重查。) */
watch(() => `${safety.on}|${safety.level}`, () => {
  if (view.value === 'series') loadSeries()
  else if (view.value === 'chars' && curSeries.value) loadChars(curSeries.value)
})

/* 「显示无本地图的角色」开关切换 -> 重载当前层(角色数统计与卡片都要跟着口径走) */
watch(() => prefs.seriesShowZero, () => {
  if (view.value === 'series') loadSeries()
  else if (view.value === 'chars' && curSeries.value) loadChars(curSeries.value)
})

onMounted(() => {
  src.load()
  showSeriesList()
})

watch(imgSort, (v) => { prefs.sortSeries = v; reloadImages() })
watch(imgPageSize, (v) => { imgFeed.setPageSize(v); reloadImages() })
watch(charSort, () => { /* 纯前端排序, computed 已经处理 */ })

const route = useRoute()
const router = useRouter()
// 支持 /series?series=xxx 直达(从标签页/看板跳过来)
watch(() => route.query.series, async (name) => {
  if (name && seriesData.value) {
    const hit = seriesData.value.series.find((s) => s.name === name)
    if (hit) openSeries(hit)
  }
})
</script>

<template>
  <div class="series-view">
    <!-- 顶栏: 面包屑 + 来源 -->
    <div class="head">
      <div class="crumb">
        <span class="link" @click="showSeriesList">全部系列</span>
        <template v-if="crumb.series">
          <span class="sep">&gt;</span>
          <span class="crumb-item">
            <span class="link" @click="backToChars">
              {{ crumb.seriesZh || crumb.series }}
              <span v-if="crumb.seriesZh" class="name-en">{{ crumb.series }}</span>
            </span>
            <button
              class="crumb-copy"
              :title="`复制系列名(${crumb.series})`"
              @click="copyCrumb(crumb.series, '系列名')"
            >📋</button>
          </span>
        </template>
        <template v-if="view === 'images' && crumb.char">
          <span class="sep">&gt;</span>
          <span class="crumb-item">
            <span class="now">{{ crumb.char }}</span>
            <button
              class="crumb-copy"
              :title="`复制角色名(${crumb.char})`"
              @click="copyCrumb(crumb.char, '角色名')"
            >📋</button>
          </span>
        </template>
      </div>
      <TvSourceChips
        v-model="src.selected"
        :sources="src.list"
        :total="src.totalImages"
        @change="onSourceChange"
      />
      <!-- 放在**顶栏**而不是图片流的工具栏里: 系列页有"系列/角色/图片"三层,
           只有"图片"那层有图 —— 放工具栏的话, 用户在系列列表那一屏就找不到开关。
           顶栏是三层都在的, 一份就够。 -->
      <TvSafetyToggle :counts="imgFeed.unsafe.value" />
    </div>

    <div class="panel body">
      <!-- ============ 1. 系列列表 ============ -->
      <template v-if="view === 'series'">
        <div class="cat-bar">
          <TvTabs v-model="curCat" :tabs="catTabs" size="sm" />
          <span class="spacer" />
          <TvInput
            v-model="seriesKw"
            size="sm"
            placeholder="🔍 搜索系列(中/英文)"
            class="kw"
          />
          <label class="zero-tog" title="显示 danbooru 补全的、本地没有图片的角色(可入购物车)">
            <input v-model="prefs.seriesShowZero" type="checkbox" />
            无图角色
          </label>
          <TvButton size="sm" variant="secondary" @click="showCatMgr = true">⚙️ 分类管理</TvButton>
        </div>

        <div ref="seriesScrollEl" class="scroll">
          <TvState v-if="loading" state="loading" text="加载中..." />
          <TvState v-else-if="listError" state="error" :text="`加载失败: ${listError}`" />
          <TvState v-else-if="!seriesData?.series.length" state="empty" text="暂无系列数据" />
          <TvState
            v-else-if="!shownSeries.length"
            state="empty"
            :text="seriesKw.trim() ? `没有匹配「${seriesKw.trim()}」的系列` : '该分类下没有系列(或分类已被隐藏)'"
          />
          <div v-else class="grid">
            <TvEntityCard
              v-for="s in shownSeries"
              :key="s.name"
              :title="seriesZh[s.name] || s.name"
              :subtitle="seriesZh[s.name] ? s.name : ''"
              :thumb="s.thumb"
              :images="s.images"
              :characters="s.characters"
              :badge="s.custom ? '自定义' : (CATEGORY_LABELS[s.category] || s.category)"
              :badge-tone="s.custom ? 'ok' : 'accent'"
              :dim="(seriesData.hidden_categories || []).includes(s.category)"
              :thumb-width="300"
              :in-cart="null"
              coverable
              @open="openSeries(s)"
              @cover="openCoverPick('series', s.name, seriesZh[s.name] || s.name, s.thumb)"
            />
          </div>
        </div>
      </template>

      <!-- ============ 2. 角色列表 ============ -->
      <template v-else-if="view === 'chars'">
        <div class="cat-bar">
          <span class="hint">
            {{ crumb.seriesZh || curSeries }}
            <span v-if="crumb.seriesZh" class="name-en">{{ curSeries }}</span>
            · 共 {{ charData.length }} 个角色
          </span>
          <span class="spacer" />
          <template v-if="selectMode">
            <span class="sel-hint">已选 <b>{{ selected.size }}</b></span>
            <TvButton size="sm" variant="success" @click="addSelectedToCart">
              🛒 全部加入购物车({{ selected.size }})
            </TvButton>
            <TvButton size="sm" variant="secondary" @click="selectAll">☑️ 全选</TvButton>
            <TvButton size="sm" variant="secondary" @click="invertSelect">🔄 反选</TvButton>
            <TvButton size="sm" variant="ghost" @click="clearSelect">🗑 清空</TvButton>
            <TvButton size="sm" variant="ghost" @click="toggleSelectMode">✕ 取消</TvButton>
          </template>
          <template v-else>
            <TvButton size="sm" variant="secondary" @click="toggleSelectMode">🎯 选择导出</TvButton>
            <TvButton size="sm" variant="secondary" :disabled="!cart.count" @click="cart.drawerOpen = true">
              🛒 购物车({{ cart.count }})
            </TvButton>
          </template>
          <label class="zero-tog" title="显示 danbooru 补全的、本地没有图片的角色(可入购物车)">
            <input v-model="prefs.seriesShowZero" type="checkbox" />
            无图角色
          </label>
          <TvSelect
            v-model="charSort"
            size="sm"
            inline
            label="排序"
            :options="[
              { value: 'name', label: '名字 A-Z' },
              { value: 'name_desc', label: '名字 Z-A' },
              { value: 'images', label: '图片最多' },
              { value: 'images_asc', label: '图片最少' },
            ]"
          />
        </div>

        <div ref="charScrollEl" class="scroll">
          <TvState v-if="charsLoading" state="loading" text="加载中..." />
          <TvState v-else-if="!sortedChars.length" state="empty" text="该系列下没有识别到角色" />
          <div v-else class="grid">
            <TvEntityCard
              v-for="c in sortedChars"
              :key="c.tag"
              :title="stripZhSeries(charZh[c.tag]) || c.name"
              :subtitle="stripZhSeries(charZh[c.tag]) ? c.name : ''"
              :thumb="c.thumb"
              :images="c.images"
              :characters="null"
              :selectable="selectMode"
              :selected="selected.has(c.tag)"
              :in-cart="inCart(c.tag)"
              :badge="c.images === 0 ? '仅手动补充' : ''"
              :badge-tone="'warn'"
              :thumb-width="300"
              coverable
              @open="selectMode ? toggleSelect(c) : openCharImages(c)"
              @toggle-select="toggleSelect(c)"
              @toggle-cart="toggleCartOne(c)"
              @cover="openCoverPick('chars', c.tag, stripZhSeries(charZh[c.tag]) || c.name, c.thumb)"
            />
          </div>
        </div>
      </template>

      <!-- ============ 3. 图片 ============ -->
      <template v-else>
        <div class="cat-bar">
          <b class="cnt">{{ nfmt(imgFeed.total.value) }}</b>
          <span class="hint">条匹配</span>
          <span class="spacer" />
          <TvSelect
            v-model="imgSort"
            size="sm"
            inline
            label="排序"
            :options="[
              { value: 'path', label: '默认(路径)' },
              { value: 'time', label: '最新优先' },
              { value: 'random', label: '随机' },
            ]"
          />
          <TvSelect
            v-model="imgPageSize"
            size="sm"
            inline
            label="每页"
            :options="[60, 120, 240].map((n) => ({ value: n, label: String(n) }))"
          />
          <TvButton size="sm" variant="secondary" @click="backToChars">← 返回角色列表</TvButton>
        </div>

        <div ref="imgScrollEl" class="scroll">
          <TvImageGrid
            :results="imgFeed.results.value"
            :loading="imgFeed.loading.value"
            :error="imgFeed.error.value"
            :loaded-once="imgFeed.loadedOnce.value"
            :infinite="true"
            :has-more="imgFeed.hasMore.value"
            @open="(it) => lb.open(it.path, { list: imgPaths })"
            @load-more="imgFeed.loadMore"
            @hover="({ text, event }) => ui.showTip(text, event)"
            @move="ui.moveTip"
            @leave="ui.hideTip"
          />
        </div>
      </template>
    </div>

    <TvCategoryManager v-model="showCatMgr" :series-list="seriesData?.series || []" @saved="showSeriesList" />

    <TvCoverPickerModal
      v-model="showCoverPick"
      :kind="coverPick?.kind || 'series'"
      :entity-key="coverPick?.key || ''"
      :series="curSeries"
      :title="coverPick?.title || ''"
      :source="src.param"
      :current="coverPick?.current || ''"
      @saved="onCoverSaved"
    />
  </div>
</template>

<style scoped>
.series-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}
.head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: 0 0 auto; }
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .link { color: var(--accent); cursor: pointer; }
.crumb .link:hover { text-decoration: underline; }
.crumb .now { color: var(--text); }
.crumb .sep { color: var(--faint); }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }

.cat-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 12px; flex: 0 0 auto;
}
.hint { color: var(--muted); font-size: 12px; }
.sel-hint { color: var(--muted); font-size: 12px; }
.sel-hint b { color: var(--accent2); }
.cnt { color: var(--accent); font-size: 16px; }
.kw { max-width: 260px; }
/* 「无图角色」开关(两层工具栏各一个, 共用 v-model) */
.zero-tog {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--muted); cursor: pointer;
  user-select: none; white-space: nowrap;
}
.zero-tog input { accent-color: var(--accent); cursor: pointer; }
.zero-tog:hover { color: var(--accent); }
.kw :deep(.tv-input) { padding: 4px 8px; font-size: 12px; }

.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  align-content: start;
}
</style>
