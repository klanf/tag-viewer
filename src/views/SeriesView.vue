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
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TvSourceChips from '@/components/filter/TvSourceChips.vue'
import TvEntityCard from '@/components/series/TvEntityCard.vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvBatchBar from '@/components/image/TvBatchBar.vue'
import MoveTargetModal from '@/components/scan/MoveTargetModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvInput from '@/components/base/TvInput.vue'
import TvTabs from '@/components/base/TvTabs.vue'
import TvState from '@/components/base/TvState.vue'
import TvZoomBadge from '@/components/base/TvZoomBadge.vue'
import TvModal from '@/components/base/TvModal.vue'
import TvCategoryManager from '@/components/rules/TvCategoryManager.vue'
import TvCoverPickerModal from '@/components/series/TvCoverPickerModal.vue'
import TvCharEditModal from '@/components/series/TvCharEditModal.vue'
import TagImagesPanel from '@/components/tag/TagImagesPanel.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useBatchOps } from '@/composables/useBatchOps.js'
import { useGridZoom } from '@/composables/useGridZoom.js'
import { usePagePath } from '@/composables/usePagePath.js'
import { useTagHost } from '@/composables/useTagHost.js'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { useAppStore } from '@/stores/useAppStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { nfmt, stripZhSeries } from '@/utils/format.js'
import { readLS, writeLS, LS } from '@/utils/lskey.js'

const src = useSourceStore()
const cart = useCartStore()
const lb = useLightboxStore()
const ui = useUiStore()
const prefs = usePrefsStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()
/** 全局后台任务状态(批量拉封面的进度、封面变更广播都在这里) */
const app = useAppStore()

const view = ref('series')        // series | chars | images
const loading = ref(false)
const listError = ref('')

/* ---------------- 来源内 tag 页 + 全局路径栏(2026-10-23) ----------------
 * 在某一层的图集光箱里点标签 = 就地翻到下一层「该标签的图片」, 层级接着当前上下文:
 *   全部系列 > 系列 > 角色 > 标签
 * 标签页的光箱里再点标签可以继续往下叠(全部系列 > 系列 > 角色 > A > B)。
 * 每层记下 from(开这一层时的光箱 + 翻页列表): 返回箭头退一层并把光箱原样拉回来;
 * 点祖先 crumb / 回角色图集是直接跳过去, 不恢复光箱。 */
let tagSeq = 0
const tagLevels = ref([])          // [{ id, tag, from: { imgPath, list } | null }]
const curTag = computed(() => tagLevels.value[tagLevels.value.length - 1]?.tag || '')
const topLevel = computed(() => tagLevels.value[tagLevels.value.length - 1] || null)

function openTagPage(tag) {
  if (!tag) return
  tagLevels.value.push({
    id: ++tagSeq,
    tag: String(tag),
    /* 光箱此刻还开着(gotoTag 先调宿主再 close): 记下这一层返回时要恢复的图和翻页列表 */
    from: lb.path ? { imgPath: lb.path, list: lb.list.length > 1 ? [...lb.list] : null } : null,
  })
}
function restoreFrom(lv) {
  const f = lv?.from
  if (!f?.imgPath) return
  /* 等 tag 页收起、图集渲染回来再开, 不然光箱会被同一帧的渲染盖住 */
  nextTick(() => lb.open(f.imgPath, { list: f.list || [f.imgPath] }))
}
/** 返回箭头: 退一层并恢复开那一层时的光箱 */
function backFromTagPage() {
  restoreFrom(tagLevels.value.pop())
}
/** 点祖先 tag crumb: 直接回到那一层, 不恢复光箱 */
function goTagLevel(i) {
  if (i < 0 || i >= tagLevels.value.length - 1) return
  tagLevels.value.splice(i + 1)
}
/** 回角色图集: 整栈清空, 并恢复第一层打开时的光箱(与点角色 crumb 的老行为一致) */
function backToRootPage() {
  const first = tagLevels.value[0]
  tagLevels.value = []
  restoreFrom(first)
}
/** 点系列 / 全部系列: 整栈清空, 不恢复光箱 */
function clearTagPages() {
  tagLevels.value = []
}
useTagHost('series', openTagPage)
function onTagRenamedInPage(t) {
  if (topLevel.value) topLevel.value.tag = String(t)
}
/** 当前层被删: 只收起这一层, 不恢复光箱 */
function onTagDeletedInPage() {
  tagLevels.value.pop()
}


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

/**
 * 系列/角色两层卡片的 Ctrl+滚轮缩放(2026-10-22 用户要求)。
 * 复用图片网格那套(同一个 tv_grid_zoom): 卡片基准都是 150px, "同一套审美"
 * 没理由各记一份。滚轮只挂在这两层的 .scroll 上 —— 图片层有自己的 TvImageGrid
 * 缩放, 挂在外层会一次滚轮触发两份状态。
 */
const { zoom: cardZoom, zoomFlash, onWheel: onCardWheel, reset: resetCardZoom } = useGridZoom()
const cardGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(150 * cardZoom.value)}px, 1fr))`,
}))

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

/**
 * opts.silent: **换封面这类"内容没变、只是图换了"的重拉**要用。
 * 默认那套会先把整层网格换成「加载中」占位框(TvState), 滚动容器里的内容一没,
 * scrollTop 直接塌回 0 —— 用户看到的就是"封面一拉完就给我跳回开头"(2026-10-22 反馈)。
 * 静默模式保留网格、原地换数据, 并把滚动位置在重渲染后再按回去。
 */
async function loadSeries(opts = {}) {
  const keepTop = opts.silent ? (seriesScrollEl.value?.scrollTop || 0) : 0
  if (!opts.silent) loading.value = true
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
    if (!opts.silent) loading.value = false
    else requestAnimationFrame(() => { if (seriesScrollEl.value) seriesScrollEl.value.scrollTop = keepTop })
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
const charKw = ref('')
const charSort = ref(prefs.sortSeriesChars)
const charsLoading = ref(false)
const selectMode = ref(false)
const selected = ref(new Set())
/** 角色完整标签 -> 中文(形如「莉央(blue_archive)」, 显示前要剥掉系列尾巴) */
const charZh = ref({})

const sortedChars = computed(() => {
  const kw = charKw.value.trim().toLowerCase()
  const arr = charData.value.filter((c) => {
    if (!kw) return true
    const zh = charZh.value[c.tag] || ''
    return [c.name, c.tag, ...(c.alt || []), zh, stripZhSeries(zh)]
      .filter(Boolean)
      .some((s) => String(s).toLowerCase().includes(kw))
  })
  const s = charSort.value
  if (s === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  else if (s === 'name_desc') arr.sort((a, b) => b.name.localeCompare(a.name, 'en'))
  else if (s === 'images_asc') arr.sort((a, b) => a.images - b.images)
  else arr.sort((a, b) => b.images - a.images)
  return arr
})

const charsEmptyText = computed(() => (charKw.value.trim() ? '没有匹配的角色' : '该系列下没有识别到角色'))

async function loadChars(series, opts = {}) {
  const keepTop = opts.silent ? (charScrollEl.value?.scrollTop || 0) : 0
  if (!opts.silent) charsLoading.value = true
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
    if (!opts.silent) charsLoading.value = false
    else requestAnimationFrame(() => { if (charScrollEl.value) charScrollEl.value.scrollTop = keepTop })
  }
}

async function openSeries(s) {
  scrollSeries.value = seriesScrollEl.value?.scrollTop || 0
  curSeries.value = s.name
  curSeriesZh.value = seriesZh.value[s.name] || ''
  charKw.value = ''
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
/* 搜索过滤时「全选/反选」只看当前可见的角色 —— 否则筛出 1 个点全选，
   会把另外 151 个看不见的也加进购物车 */
function selectAll() { selected.value = new Set(sortedChars.value.map((c) => c.tag)) }
function invertSelect() {
  const s = new Set()
  for (const c of sortedChars.value) if (!selected.value.has(c.tag)) s.add(c.tag)
  selected.value = s
}
function clearSelect() { selected.value = new Set() }

/* ---------------- 批量操作(2026-10-22, 复用上面那套选择模式) ----------------
 * 「拉封面」的三个口径来自用户点名: 全部 / 没自定义过的 / 没有图片的。
 * 口径先算成目标数组, 再交给主进程的后台任务(covers:auto:run) —— 页面切走、
 * 弹窗关掉都不影响它继续跑, 进度由 store 接 covers:auto:progress。 */
const COVER_SCOPES = [
  { value: 'selected', label: '仅选中的' },
  { value: 'nocustom', label: '没自定义过封面的' },
  { value: 'noimg', label: '没有本地图片的' },
  { value: 'all', label: '全部(当前筛选结果)' },
]
const coverScope = ref('nocustom')
const coverSource = ref('danbooru')
const coverRating = ref('g')
/** solo 默认开 + 记住选择(2026-10-22 用户要求): 落在 prefs, 不在这里另存一份 */
const coverSolo = computed({
  get: () => prefs.coverSolo,
  set: (v) => { prefs.coverSolo = v },
})
/* Danbooru 配没配 API Key —— 面板上那句"能不能又要 solo 又要站方人气排序"要说准。
 * null = 还没问过(打开面板才问, 不为这个多占一条启动路径)。 */
const booruKeyed = ref(null)
/** 面板下面那句说明要跟着三个选择变, 不能写死成"取人气最高的一张安全图" ——
 *  匿名拿不到站方排序(实测 order 被忽略), 这时候说"人气"是吹牛。 */
const coverHint = computed(() => {
  const cred = booruKeyed.value === true && coverSource.value === 'danbooru'
  const pop = cred
    ? '按站方人气(score)从高到低取第一张'
    : '在翻到的那几十张里取分数最高的一张（匿名拿不到站方排序）'
  return `${coverSolo.value ? '只认单人图(solo)' : '不限人数'} · ${pop} · 已有封面的默认跳过，中断后再点会接着跑`
})

/** 口径 -> 目标列表。注意读的是 sortedChars(筛过的可见项), 与「全选」同一口径 */
const coverTargets = computed(() => {
  const list = sortedChars.value
  const pick = coverScope.value === 'selected'
    ? list.filter((c) => selected.value.has(c.tag))
    : coverScope.value === 'nocustom'
      ? list.filter((c) => !c.has_cover)
      : coverScope.value === 'noimg'
        ? list.filter((c) => c.images === 0)
        : list
  return pick.map((c) => ({ kind: 'chars', key: c.tag, label: stripZhSeries(charZh.value[c.tag]) || c.name }))
})

/** 下拉里给每个口径标个数, 用户点之前就知道这次要跑多少个(0 个就别点了) */
function scopeCount(v) {
  const list = sortedChars.value
  if (v === 'selected') return list.filter((c) => selected.value.has(c.tag)).length
  if (v === 'nocustom') return list.filter((c) => !c.has_cover).length
  if (v === 'noimg') return list.filter((c) => c.images === 0).length
  return list.length
}
/* 面板上「范围」与「追加范围」是同一个选择(都写 coverScope) —— 选项也共用一份,
   否则跑起来之后标签从"没自定义过封面的(N)"变成"没自定义过封面的"会让人以为是两回事。
   ⚠️ 这里是脚本作用域, Ref 不会像模板那样自动解包: 必须 `selected.value.size`。 */
const coverScopeOptions = computed(() => COVER_SCOPES.map((s) => ({
  ...s,
  label: s.value === 'selected' ? `仅选中的(${selected.value.size})` : `${s.label}(${scopeCount(s.value)})`,
})))

async function runAutoCovers() {
  const t = coverTargets.value
  if (!t.length) { ui.err('这个口径下没有要拉封面的角色(换个口径或先勾选)'); return }
  /* 任务在跑时这一下是**追加**(2026-10-22 用户反馈「切到另一个系列就加不进来」):
   * 主进程排队, 跑完手头这条就接上, 不用等整批结束再点一次。 */
  const running = !!app.autoCover?.running
  if (t.length > 50 && !window.confirm(running
    ? `要把 ${t.length} 个角色排进当前这批的队尾。\n整批会变成 ${(app.autoCover.total || 0) + t.length} 个，当前这条拉完就接着来。\n确定追加？`
    : `要给 ${t.length} 个角色逐个联网拉封面。\n本机到图床是慢链路，粗估要 ${Math.ceil(t.length * 4 / 60)} 分钟，中途可以点「停止」。\n已经设过封面的会被跳过(所以断了可以再点一次接着跑)。\n确定开跑？`)) return
  const r = await app.autoCoverRun(t, { source: coverSource.value, rating: coverRating.value, solo: coverSolo.value })
  if (r?.error) { ui.err(r.error); return }
  if (r?.added) ui.ok(`已排进队尾 ${r.added} 个（本批合计 ${r.total} 个）`, 3200)
  else if (r?.note) ui.toast(r.note, 'info', 2600)
  else if (r?.started) ui.ok(`开始拉取 ${t.length} 个封面`, 2200)
}

async function stopAutoCovers() {
  await app.autoCoverCancel()
  ui.toast('已请求停止(当前这个拉完就停)', 'info', 2000)
}

/** 面板开合。跑着的时候强制可见 —— 用户点到别处也不该看不见进度。 */
const coverPanel = ref(false)
/* 每次打开都重新问一遍配没配 Key。以前只在第一次打开时问(`!== null` 当缓存),
 * 于是"设置里刚存好 Key → 回来开面板"仍然按匿名说话, 用户看到的就是"存了没用"
 * (2026-10-22)。这句话是**当前状态**的描述, 不是一次性的探测结果, 不该缓存。 */
watch(coverPanel, (v) => {
  if (!v) return
  api.booruAuthGet().then((r) => { booruKeyed.value = !!r?.hasKey }).catch(() => { booruKeyed.value = false })
})
const autoCover = computed(() => app.autoCover)
const autoCoverLive = computed(() => !!autoCover.value && (autoCover.value.running || coverPanel.value))
const autoCoverDoneText = computed(() => {
  const a = autoCover.value
  if (!a) return ''
  const mm = Math.round((a.elapsedMs || 0) / 60000)
  return `${a.cancelled ? '已停止' : '跑完了'}：成功 ${a.ok}、跳过 ${a.skipped}、失败 ${a.failed}（用时 ${mm} 分钟）`
})

/* 封面变了 -> 静默重拉当前层。放这里而不是等弹窗 emit: 任务在**主进程**跑,
   发起时那个界面可能早就切走了。 */
watch(() => autoCover.value?.finished, (done) => {
  if (!done) return
  const a = autoCover.value || {}
  fetchingKey.value = ''                // 卡片上那个 🌐 的加载态到这里才解除
  if (a.failed) ui.warn(autoCoverDoneText.value + (a.errors?.length ? `｜例如：${a.errors[0]}` : ''), 6000)
  else ui.ok(autoCoverDoneText.value, 4000)
  refreshCoverLayer()
})

/** 批量隐藏 = 把选中角色写进 hidden_chars。
 *  ⚠️ 这个字段是**整数组替换**语义(meta.js 的 patchUserMeta), 所以必须先把现有
 *  列表并进来再发 —— 直接发选中那几个会把之前屏蔽的角色全解屏蔽。 */
/** 单张卡「联网拉一张封面」(角色卡/系列卡都有这个入口, 2026-10-22 用户点名)。
 *  不另起一套下载代码, 走的就是批量那条链路(targets 只有一项) —— 为了让
 *  「进度 / 取消 / 跳过已有封面 / 写盘失败要报错」这些行为两处完全一致。 */
const fetchingKey = ref('')
async function fetchOneCover(kind, key, label) {
  if (!key) return
  if (fetchingKey.value || app.autoCover?.running) { ui.warn('已经有一批在跑了，先等它结束'); return }
  fetchingKey.value = `${kind}:${key}`
  const r = await app.autoCoverRun([{ kind, key, label }], { source: coverSource.value, rating: coverRating.value, solo: coverSolo.value })
  if (r?.error) { ui.err(r.error); fetchingKey.value = '' }
}

async function hideSelected() {
  const tags = [...selected.value]
  if (!tags.length) { ui.err('先勾选要隐藏的角色'); return }
  if (!window.confirm(`隐藏选中的 ${tags.length} 个角色？\n之后在 分类管理 → 屏蔽角色 里可以恢复。`)) return
  try {
    const cur = await api.seriesMeta()
    const merged = [...new Set([...(cur.hidden_chars || []), ...tags.map((t) => String(t).toLowerCase())])]
    const r = await api.saveSeriesMeta({ hidden_chars: merged })
    if (r?.error) { ui.err(r.error); return }
    ui.ok(`已隐藏 ${tags.length} 个角色`, 2000)
    selected.value = new Set()
    selectMode.value = false
    // 静默重拉: 隐藏只是让几张卡消失, 不该把用户从看到的位置甩回顶部
    await loadChars(curSeries.value, { silent: true })
    await loadSeries({ silent: true })
  } catch (e) {
    ui.err('隐藏失败: ' + e.message)
  }
}

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

/* ---------------- 单卡 ban(2026-10-23) ----------------
 * 与批量隐藏写的是同一份 hidden_chars —— 这个字段是**整数组替换**, 必须把现有列表
 * 并进来再发, 否则会把之前屏蔽的角色全解屏蔽。
 * 用户点名要确认弹窗 + 「以后不再提示」: 偏好存 localStorage(纯展示层习惯, 不落数据目录);
 * 恢复入口不变 —— 分类管理 → 屏蔽角色。 */
const banTarget = ref(null)
const banNoAsk = ref(false)
const banSkipAsk = ref(readLS(LS.charBanSkip.key) === '1')
const banDisplayName = computed(() => {
  const c = banTarget.value
  return c ? (stripZhSeries(charZh.value[c.tag]) || c.name || c.tag) : ''
})

function askBan(c) {
  if (banSkipAsk.value) { doBan(c); return }
  banNoAsk.value = false
  banTarget.value = c
}

async function doBan(c) {
  if (!c) return
  if (banNoAsk.value) {
    writeLS(LS.charBanSkip.key, '1')
    banSkipAsk.value = true
  }
  const tag = String(c.tag || '').toLowerCase()
  const name = stripZhSeries(charZh.value[c.tag]) || c.name || tag
  banTarget.value = null
  try {
    const cur = await api.seriesMeta()
    const merged = [...new Set([...(cur.hidden_chars || []), tag])]
    const r = await api.saveSeriesMeta({ hidden_chars: merged })
    if (r?.error) { ui.err(r.error); return }
    ui.ok(`已屏蔽 ${name}（可在 分类管理 → 屏蔽角色 恢复）`, 2800)
    if (selected.value.has(c.tag)) {
      const s = new Set(selected.value)
      s.delete(c.tag)
      selected.value = s
    }
    // 静默重拉: 只是让这张卡消失, 别把用户从原位甩回顶部
    await loadChars(curSeries.value, { silent: true })
    await loadSeries({ silent: true })
  } catch (e) {
    ui.err('屏蔽失败: ' + e.message)
  }
}

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
const imgPageSize = ref(prefs.seriesImgPageSize)
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

/* ---------------- 图片层批量选择(2026-10-21): 勾选 -> 批量移动/复制/删除 ----------------
 * 与看板/扫描页同款交互(useBatchOps)。**重命名解构**: 角色列表层已经有一套
 * selectMode/selected/selectAll(购物车选择导出), 两套选择语义不同不能撞名。
 * 键盘守卫判 route.name: 本页在 KeepAlive 白名单里, 切走后监听器还在。 */
const {
  selectMode: imgSelMode, selected: imgSel, moving: imgMoving, copying: imgCopying,
  moveOpen: imgMoveOpen, copyOpen: imgCopyOpen, folders: imgMoveFolders,
  toggleSelectMode: imgToggleSelectMode, toggleSelect: imgToggleSelectOne,
  selectAll: imgSelectAll, invertSel: imgInvertSel, clearSel: imgClearSel,
  onCardClick: imgCardClick, batchDelete: imgBatchDelete,
  openMove: imgOpenMove, openCopy: imgOpenCopy, doMove: imgDoMove, doCopy: imgDoCopy,
  onKey: imgBatchKey,
} = useBatchOps({
  items: () => imgFeed.results.value,
  openImage: (it) => lb.open(it.path, { list: imgPaths.value }),
})

function onSeriesKey(e) {
  if (route.name !== 'series') return
  imgBatchKey(e)
}
onMounted(() => window.addEventListener('keydown', onSeriesKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onSeriesKey))

/** 角色列表工具栏上那句「系列中文名 (英文名) · N 个角色」 */
const crumb = computed(() => ({
  series: curSeries.value,
  seriesZh: curSeriesZh.value,
}))

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
/* 这里以前走的是**非静默**重拉(loading 把整层网格换成占位框) —— 用户 2026-10-22 报的
 * 「挑完封面还是跳到最上面, 而且画面闪一下」就是它: 滚动容器内容一空, scrollTop 塌回 0,
 * 占位框→网格那一跳就是"闪"。上一轮只把**广播**那条路径改成静默了, emit 这条漏了。
 * 顺带把待执行的防抖重拉取消掉: 同一次写盘会同时走 emit 和广播, 不取消就白重拉两遍。 */
function onCoverSaved() {
  if (coverReloadTimer) { clearTimeout(coverReloadTimer); coverReloadTimer = null }
  refreshCoverLayer()
}

/* 封面变更的**第二条**刷新路径(2026-10-22): 由主进程在写盘成功后广播 cover:changed。
   为什么不能只靠上面那个 emit —— 用户在「下载中」把换封面弹窗关掉时, 下载和写盘照旧
   在主进程完成了, 但那句 emit 是在弹窗组件里发的, 丢了就没人刷新, 于是"数据明明改了、
   卡片还是旧封面, 只能重启"。订阅全局推送就和弹窗活不活着无关。

   ⚠️ 但批量拉封面时每写成功一张都会广播一次(100 个角色 = 100 次), 每次都整层重拉会把
   列表反复刷掉、滚动位置反复跳顶 —— 用户反馈的"拉完强制回到开头"就是这么来的。
   所以这里**合并**成一次: 安静 1.2 秒才真重拉, 而且是静默重拉(不动 loading、保住 scrollTop)。 */
const COVER_RELOAD_QUIET_MS = 1200
let coverReloadTimer = null
function refreshCoverLayer() {
  if (view.value === 'series') loadSeries({ silent: true })
  else if (view.value === 'chars' && curSeries.value) loadChars(curSeries.value, { silent: true })
  // 图片层的网格不吃这个: 那里没有"卡片封面"这个东西
}
watch(() => app.coverTick, () => {
  if (coverReloadTimer) clearTimeout(coverReloadTimer)
  coverReloadTimer = setTimeout(() => { coverReloadTimer = null; refreshCoverLayer() }, COVER_RELOAD_QUIET_MS)
})
onBeforeUnmount(() => { if (coverReloadTimer) clearTimeout(coverReloadTimer) })

/* ---------------- 角色纠正(2026-10-21) ---------------- */
const showCharEdit = ref(false)
const charEdit = ref(null)
const seriesPickOptions = computed(() => (seriesData.value?.series || []).map((s) => ({
  name: s.name,
  zh: seriesZh.value[s.name] || '',
})))

function openCharEdit(c) {
  charEdit.value = { char: c, series: curSeries.value }
  showCharEdit.value = true
}

/** 改名/挪系列/屏蔽落盘后: 当前卡可能已不属于本系列, 两层都重拉 */
async function onCharEditSaved(info) {
  const tag = charEdit.value?.char?.tag
  if (tag && selected.value.has(tag)) {
    const s = new Set(selected.value)
    s.delete(tag)
    selected.value = s
  }
  if (info?.hidden) ui.ok('已屏蔽该角色(可在 分类管理 → 屏蔽角色 里恢复)', 2600)
  else if (info?.moved) ui.ok('已挪到目标系列', 2000)
  else ui.ok('角色已更新', 1600)
  await loadChars(curSeries.value)
  await loadSeries()
  if (view.value === 'images' && curChar.value && tag === curChar.value.tag) {
    // 正在看这个角色的图集: 返回角色列表, 避免停在已挪走的角色上
    backToChars()
  }
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
watch(imgPageSize, (v) => { prefs.seriesImgPageSize = v; imgFeed.setPageSize(v); reloadImages() })
watch(charSort, (v) => { prefs.sortSeriesChars = v })

const route = useRoute()
const router = useRouter()
// 支持 /series?series=xxx 直达(从标签页/看板跳过来)
watch(() => route.query.series, async (name) => {
  if (name && seriesData.value) {
    const hit = seriesData.value.series.find((s) => s.name === name)
    if (hit) openSeries(hit)
  }
})

/** tag 栈的一串 crumb: 祖先层点了直接跳回那层(不恢复光箱), 栈顶挂复制按钮 */
function tagCrumbs(stack) {
  return stack.map((lv, i) => (i === stack.length - 1
    ? { label: lv.tag, copy: lv.tag, copyLabel: '标签名' }
    : { label: lv.tag, onClick: () => goTagLevel(i), back: backFromTagPage }))
}

/* 路径栏的内容(放在末尾: 引用了上面所有的层级状态与返回函数) */
usePagePath('series', computed(() => {
  const stack = tagLevels.value
  const inTag = stack.length > 0
  const crumbs = [{
    label: '全部系列',
    onClick: () => { clearTagPages(); showSeriesList() },
    back: inTag ? backFromTagPage : undefined,
  }]
  if (!curSeries.value) return [...crumbs, ...tagCrumbs(stack)]
  const zh = curSeriesZh.value
  crumbs.push({
    label: zh || curSeries.value,
    sub: zh ? curSeries.value : '',
    copy: curSeries.value,
    copyLabel: '系列名',
    onClick: () => {
      clearTagPages()
      if (view.value === 'images') backToChars()
    },
    // 箭头 = 真的退一层: 图片层退回角色列表; 标签页退回去是光箱那一页
    back: inTag ? backFromTagPage : (view.value === 'images' ? backToChars : undefined),
  })
  if (view.value !== 'images' || !curChar.value) return [...crumbs, ...tagCrumbs(stack)]
  crumbs.push({
    label: curChar.value.tag,
    copy: curChar.value.tag,
    copyLabel: '角色 tag',
    onClick: () => { if (inTag) backToRootPage() },
    back: inTag ? backFromTagPage : undefined,
  })
  return [...crumbs, ...tagCrumbs(stack)]
}))
</script>

<template>
  <div class="series-view">
    <template v-if="!tagLevels.length">
    <!-- 顶栏: 来源 + 安全模式(路径已搬到全局路径栏) -->
    <div class="head">
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

        <div ref="seriesScrollEl" class="scroll" @wheel="onCardWheel">
          <TvState v-if="loading" state="loading" text="加载中..." />
          <TvState v-else-if="listError" state="error" :text="`加载失败: ${listError}`" />
          <TvState v-else-if="!seriesData?.series.length" state="empty" text="暂无系列数据" />
          <TvState
            v-else-if="!shownSeries.length"
            state="empty"
            :text="seriesKw.trim() ? `没有匹配「${seriesKw.trim()}」的系列` : '该分类下没有系列(或分类已被隐藏)'"
          />
          <div v-else class="grid" :style="cardGridStyle">
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
              fetchable
              :fetching="fetchingKey === 'series:' + s.name"
              @open="openSeries(s)"
              @cover="openCoverPick('series', s.name, seriesZh[s.name] || s.name, s.thumb)"
              @fetch="fetchOneCover('series', s.name, seriesZh[s.name] || s.name)"
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
            · 共 {{ charData.length }} 个角色<template v-if="charKw.trim()">, 匹配 <b>{{ sortedChars.length }}</b> 个</template>
          </span>
          <TvInput
            v-model="charKw"
            size="sm"
            clearable
            placeholder="🔍 搜索角色(中/英文)"
            class="kw"
          />
          <span class="spacer" />
          <template v-if="selectMode">
            <span class="sel-hint">已选 <b>{{ selected.size }}</b></span>
            <TvButton size="sm" variant="success" @click="addSelectedToCart">
              🛒 全部加入购物车({{ selected.size }})
            </TvButton>
            <TvButton size="sm" variant="danger" :disabled="!selected.size" @click="hideSelected">
              🙈 批量隐藏({{ selected.size }})
            </TvButton>
            <TvButton size="sm" variant="secondary" @click="selectAll">☑️ 全选</TvButton>
            <TvButton size="sm" variant="secondary" @click="invertSelect">🔄 反选</TvButton>
            <TvButton size="sm" variant="ghost" @click="clearSelect">🗑 清空</TvButton>
            <TvButton size="sm" variant="ghost" @click="toggleSelectMode">✕ 取消</TvButton>
          </template>
          <template v-else>
            <TvButton size="sm" variant="secondary" @click="toggleSelectMode">🎯 选择导出</TvButton>
            <TvButton size="sm" variant="secondary" @click="coverPanel = !coverPanel">
              🌐 批量拉封面
            </TvButton>
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

        <!-- 批量拉封面(2026-10-22): 口径 + 源 + 档位, 跑起来之后这里就是进度条 -->
        <div v-if="autoCoverLive || coverPanel" class="auto-cover">
          <template v-if="!autoCover?.running">
            <TvSelect
              v-model="coverScope"
              size="sm"
              inline
              label="范围"
              :options="coverScopeOptions"
            />
            <TvSelect
              v-model="coverSource"
              size="sm"
              inline
              label="图源"
              :options="[{ value: 'danbooru', label: 'Danbooru' }, { value: 'safebooru', label: 'Safebooru' }]"
            />
            <TvSelect
              v-model="coverRating"
              size="sm"
              inline
              label="分级"
              :options="[
                { value: 'g', label: '仅安全级' },
                { value: 's', label: '放开敏感' },
                { value: 'all', label: '不限' },
              ]"
            />
            <label class="zero-tog" title="只要单人图：挡掉群像/对打里混一个的那种，那种当封面经常认不出是谁">
              <input v-model="coverSolo" type="checkbox" />
              只要单人图 (solo)
            </label>
            <TvButton size="sm" variant="primary" @click="runAutoCovers">
              🌐 开始拉取({{ coverTargets.length }})
            </TvButton>
            <span class="hint">{{ coverHint }}</span>
            <span v-if="booruKeyed === false" class="hint keyhint">
              🔑 没配 Danbooru API Key：一次最多带 2 个普通标签（勾了 solo 正好用满，再加第三个条件就会报错），
              而且「人气」只能在翻到的那几十张里自己比。在 设置 → 在线封面 填 Key 两处都放开；Safebooru 不需要 Key。
            </span>
            <span class="spacer" />
            <TvButton size="sm" variant="ghost" @click="coverPanel = false">✕ 收起</TvButton>
          </template>
          <template v-else>
            <span class="run">🌐 正在拉封面 <b>{{ autoCover.done }}</b> / {{ autoCover.total }}</span>
            <span v-if="autoCover.queued" class="hint q">排队 {{ autoCover.queued }}</span>
            <span class="hint">成功 {{ autoCover.ok }} · 跳过 {{ autoCover.skipped }} · 失败 {{ autoCover.failed }}<template v-if="autoCover.current"> · 当前：{{ autoCover.current }}</template></span>
            <span class="spacer" />
            <!-- 追加(2026-10-22): 跑到一半切到另一个系列, 从这里把它的角色排到队尾。
                 范围/图源/分级沿用面板里选的那套, 每批目标各自记住(见 coverfetch.js)。 -->
            <TvSelect v-model="coverScope" size="sm" inline label="追加" :options="coverScopeOptions" />
            <TvButton size="sm" variant="secondary" @click="runAutoCovers">
              ＋ 加入队列({{ coverTargets.length }})
            </TvButton>
            <TvButton size="sm" variant="danger" @click="stopAutoCovers">⏹ 停止</TvButton>
          </template>
          <template v-if="autoCover?.finished && !autoCover.running">
            <div class="done-line">{{ autoCoverDoneText }}<template v-if="autoCover.errors?.length">（例：{{ autoCover.errors[0] }}）</template></div>
          </template>
        </div>

        <div ref="charScrollEl" class="scroll" @wheel="onCardWheel">
          <TvState v-if="charsLoading" state="loading" text="加载中..." />
          <TvState v-else-if="!sortedChars.length" state="empty" :text="charsEmptyText" />
          <div v-else class="grid" :style="cardGridStyle">
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
              :badge="c.images === 0 ? (c.fromLibrary ? '库内角色' : '仅手动补充') : ''"
              :badge-tone="'warn'"
              :thumb-width="300"
              coverable
              editable
              fetchable
              :fetching="fetchingKey === 'chars:' + c.tag"
              @open="selectMode ? toggleSelect(c) : openCharImages(c)"
              @toggle-select="toggleSelect(c)"
              @toggle-cart="toggleCartOne(c)"
              @cover="openCoverPick('chars', c.tag, stripZhSeries(charZh[c.tag]) || c.name, c.thumb)"
              @edit="openCharEdit(c)"
              @fetch="fetchOneCover('chars', c.tag, stripZhSeries(charZh[c.tag]) || c.name)"
              @ban="askBan(c)"
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
          <TvButton size="sm" variant="ghost" title="批量选择: 勾选后批量移动/复制/删除(浏览状态下 Ctrl+点击也可直接勾)" @click="imgToggleSelectMode">☑ 选择</TvButton>
        </div>

        <!-- 批量操作条: 选择模式下出现, 钉在滚动区外 -->
        <TvBatchBar
          v-if="imgSelMode"
          :count="imgSel.size"
          :moving="imgMoving"
          :copying="imgCopying"
          @sel-all="imgSelectAll"
          @sel-invert="imgInvertSel"
          @sel-clear="imgClearSel"
          @exit="imgToggleSelectMode"
          @move="imgOpenMove"
          @copy="imgOpenCopy"
          @del="imgBatchDelete"
        />

        <div ref="imgScrollEl" class="scroll">
          <TvImageGrid
            :results="imgFeed.results.value"
            :loading="imgFeed.loading.value"
            :error="imgFeed.error.value"
            :loaded-once="imgFeed.loadedOnce.value"
            :infinite="true"
            :has-more="imgFeed.hasMore.value"
            :selectable="imgSelMode"
            :selected-tags="imgSel"
            @open="imgCardClick"
            @toggle-select="imgToggleSelectOne"
            @load-more="imgFeed.loadMore"
            @hover="({ text, event }) => ui.showTip(text, event)"
            @move="ui.moveTip"
            @leave="ui.hideTip"
          />
        </div>
      </template>
    </div>
    </template>

    <!-- 标签次级页(2026-10-23): 图集光箱点标签 = 就地翻开, 层级接着当前系列/角色。
         只渲染栈顶; key 用层 id —— 换一层就是新面板, 不把上一层的批量勾选带过来。 -->
    <TagImagesPanel
      v-else-if="topLevel"
      :key="topLevel.id"
      :tag="curTag"
      use-source-scan
      :active="route.name === 'series'"
      @renamed="onTagRenamedInPage"
      @deleted="onTagDeletedInPage"
    />

    <TvCategoryManager v-model="showCatMgr" :series-list="seriesData?.series || []" @saved="showSeriesList" />

    <!-- 系列/角色两层卡片的缩放徽标(图片层有自己的, 别叠两个) -->
    <TvZoomBadge v-if="!tagLevels.length && view !== 'images'" :zoom="cardZoom" :show="zoomFlash" @reset="resetCardZoom" />

    <MoveTargetModal v-model="imgMoveOpen" :count="imgSel.size" :folders="imgMoveFolders" :busy="imgMoving" @pick="imgDoMove" />
    <MoveTargetModal v-model="imgCopyOpen" mode="copy" :count="imgSel.size" :folders="imgMoveFolders" :busy="imgCopying" @pick="imgDoCopy" />

    <TvCharEditModal
      v-model="showCharEdit"
      :char="charEdit?.char || null"
      :series="charEdit?.series || ''"
      :series-options="seriesPickOptions"
      @saved="onCharEditSaved"
    />

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

    <!-- 单卡 ban 确认(2026-10-23): 「不再提示」勾上后, 以后点 ban 直接隐藏 -->
    <TvModal
      :model-value="!!banTarget"
      title="屏蔽角色"
      size="sm"
      @update:model-value="(v) => { if (!v) banTarget = null }"
    >
      <div class="ban-modal">
        <p class="ban-ask">确定要屏蔽 <b>{{ banDisplayName }}</b> 吗？</p>
        <p class="ban-hint">屏蔽后这个角色不会再出现在系列 / 角色列表里；随时可以在 分类管理 → 屏蔽角色 中恢复。</p>
        <label class="ban-skip">
          <input v-model="banNoAsk" type="checkbox">
          以后不再提示（点 ban 直接屏蔽）
        </label>
      </div>
      <template #footer>
        <TvButton size="sm" variant="secondary" @click="banTarget = null">取消</TvButton>
        <TvButton size="sm" variant="danger" @click="doBan(banTarget)">确认屏蔽</TvButton>
      </template>
    </TvModal>
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
/* 批量拉封面那一条(2026-10-22): 平时收起, 点「🌐 批量拉封面」或任务在跑时出现 */
.auto-cover {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel2); font-size: 12px; color: var(--muted);
}
.auto-cover .hint { color: var(--muted); }
.auto-cover .run { color: var(--text); font-size: 13px; }
.auto-cover .run b { color: var(--accent); }
.auto-cover .done-line { flex: 1 0 100%; color: var(--warn); }
/* 匿名限制那句指路单独占一行(混在说明里就看不见"去哪能放开") */
.auto-cover .keyhint {
  flex: 1 0 100%;
  font-size: 11px; line-height: 1.5;
  color: var(--accent2, var(--accent));
}
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

/* ban 确认弹窗(2026-10-23) */
.ban-modal { display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 1.65; }
.ban-ask { margin: 0; }
.ban-ask b { color: var(--text); }
.ban-hint { margin: 0; color: var(--muted); font-size: 12px; }
.ban-skip {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: 2px; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none;
}
.ban-skip input { accent-color: var(--accent); cursor: pointer; }
</style>
