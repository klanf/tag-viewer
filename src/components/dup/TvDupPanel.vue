<script setup>
/**
 * 「相似图查重」面板(2026-10-17)
 * ==============================
 * 依据: 两阶段 tag 相似度 —— 罕见 tag 共现出候选 + IDF 加权 Jaccard 打分 +
 * 并查集成组(算法在 electron/core/dupcheck.js, 真库 107k 图 ~2s)。
 * 扫描口径与看板可见图一致(gone=0 + 来源未注销), 幽灵记录/隐藏来源不掺和。
 *
 * 处理能力(2026-10-17 用户拍板):
 *   · 每张图悬停 🗑 = 单张删(系统回收站, 走全局确认弹窗)
 *   · 组头「删其余」 = 一键删掉组内非★项
 *   · ★保留优先级**可自定义**: 跨文件夹按「保留优先级」拖拽排序(越前越优先保留);
 *     同文件夹按「组内保留」下拉(画师信息 / 创建时间 / 文件大小 / 分辨率 / 提示词元数据,
 *     2026-10-24 用户需求; 之前是固定的"画师信息 → 分辨率")
 *   · 组头「非重复」 = 误报忽略 —— 整组两两 id 对持久化, 下次扫描不再出现
 *   · 「已忽略」里每组的「🗑 删记录」(2026-10-24 用户需求) = 永久忽略, 连已忽略列表
 *     也不再显示; 底部留一个计数 + 全部恢复
 *   · 安全模式(2026-10-17 用户补充): 面板结果也过安全模式审查 —— 每张图带
 *     unsafe 标记(主进程算), 开着 🛡 时敏感图/只剩一张的组整个不显示
 *   · 原图直显(2026-10-23): 不再请求缩略图, 直接看原图 + 按真实像素比完整显示;
 *     Ctrl+滚轮改卡片高度, 原图请求单独限流(2 个在飞) + 懒加载 + 分组增量渲染
 *   · 已忽略的组(2026-10-23): 可以切过去看忽略过哪些, 并逐组恢复
 *   · 滚到底自动加载 + 右下角回到顶部(2026-10-24 用户需求)
 *   · 光箱跨组连看(2026-10-24 用户需求): 翻页列表 = 所有可见组按显示顺序拍平,
 *     组末自然接下一组; 退出光箱自动滚回刚看的那一组并短暂高亮
 *
 * 删除后的组内剪枝统一监听 'tv:trashed'(与各视图同一套广播)。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvImage from '@/components/base/TvImage.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useTrash } from '@/composables/useTrash.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useImageCtxMenu } from '@/composables/useImageCtxMenu.js'

const open = defineModel({ type: Boolean, default: false })
const lightbox = useLightboxStore()
const trash = useTrash()
const ui = useUiStore()
/** 安全模式: 面板结果与看板同一套审查(展示层过滤, 关掉立刻全回来) */
const safety = useSafetyStore()
/** 右键菜单(与网格卡片同一套原生菜单) */
const fav = useFavStore()
const ctxMenu = useImageCtxMenu()

const loading = ref(false)
const error = ref('')
const result = ref(null)          // { scanned, candidates, ignoredPairs, groups, truncated, elapsedMs }
const threshold = ref(0.85)

/** 弹窗滚动容器(实际是 TvModal 的 .body): 自动加载 / 回到顶部 / 定位组都用它 */
const rootEl = ref(null)
const scrollEl = ref(null)
const showTop = ref(false)
const flashGi = ref(-1)
let flashTimer = null

/** 视图: 相似组 / 已忽略的组 */
const view = ref('groups')
const ignored = ref(null)         // { groups, pairs, missingPairs, blockedPairs, blockedGroups, elapsedMs }
const ignoredLoading = ref(false)

const THRESHOLD_OPTIONS = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65].map((v) => ({
  value: v, label: `≥ ${v}（${v >= 0.9 ? '严格' : v >= 0.8 ? '均衡' : '宽松'}）`,
}))

async function run() {
  loading.value = true
  error.value = ''
  try {
    result.value = await api.dupScan({ threshold: threshold.value })
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

watch(open, (v) => { if (v && !result.value) run() })
watch(threshold, () => { if (open.value) run() })

/* ---------------- 已忽略的组 ----------------
 * 忽略表只存 id 对, 主进程按库里的记录还原成组(见 findIgnoredGroups)。
 * 每次切过去重新拉: 忽略/恢复都改同一份文件, 缓存反而容易对不上。 */
async function loadIgnored() {
  ignoredLoading.value = true
  try {
    ignored.value = await api.dupIgnoreList()
  } catch (e) {
    ui.err('读取已忽略组失败: ' + (e?.message || e))
  } finally {
    ignoredLoading.value = false
  }
}
watch(view, (v) => { if (v === 'ignored') loadIgnored() })

/* 结果源: 相似组 / 已忽略组, 下游的安全过滤与排序对两者一视同仁 */
const sourceGroups = computed(() => (
  view.value === 'ignored' ? (ignored.value?.groups || []) : (result.value?.groups || [])
))

/* ---------------- 安全模式审查 ----------------
 * 每张图带主进程算好的 unsafe 0/1/2(与看板数据集同一套词表), 这里按当前
 * 开关/档位/显示方式过滤: 被隐藏的图剔除后组内不足 2 张的整组隐藏。 */
const safetyView = computed(() => {
  const gs = sourceGroups.value
  if (!safety.on) return { list: gs, hiddenGroups: 0, hiddenItems: 0 }
  let hg = 0
  let hi = 0
  const list = []
  for (const g of gs) {
    const vis = g.items.filter((it) => !safety.isHidden(it))
    if (vis.length < 2) { hg++; hi += g.items.length; continue }
    hi += g.items.length - vis.length
    list.push({ ...g, items: vis })
  }
  return { list, hiddenGroups: hg, hiddenItems: hi }
})
const groups = computed(() => safetyView.value.list)

/* ---------------- 原图尺寸 / Ctrl+滚轮缩放(2026-10-23) ----------------
 * 原图直接按 px_w:px_h 定卡片宽度, 配 object-fit: contain 完整显示, 不裁不缩水。
 * 高度 = 用户缩放级别, 宽度跟着真实像素比走; 没有尺寸记录时回落到 3:4。 */
const IMG_H_KEY = 'tv.dup.imgH'
const IMG_H_MIN = 120
const IMG_H_MAX = 900
const imgH = ref((() => {
  const n = Number(localStorage.getItem(IMG_H_KEY))
  return n >= IMG_H_MIN && n <= IMG_H_MAX ? n : 260
})())
watch(imgH, (v) => {
  try { localStorage.setItem(IMG_H_KEY, String(v)) } catch { /* 隐私模式等, 存不进就算了 */ }
})

function onWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  const dir = e.deltaY < 0 ? 1 : -1
  imgH.value = Math.max(IMG_H_MIN, Math.min(IMG_H_MAX, imgH.value + dir * 40))
}

/** 卡片宽度: 保持真实像素比, 控件只调高度 */
function itemW(it) {
  const w = Number(it.px_w) || 0
  const h = Number(it.px_h) || 0
  const ratio = w > 0 && h > 0 ? w / h : 3 / 4
  return Math.max(80, Math.min(1200, Math.round(imgH.value * ratio)))
}

/** 分组增量渲染: 一次挂几百组原图既卡又白下, 先给 12 组, 快滚到底自动接着加 */
const PAGE_GROUPS = 12
const shownGroups = ref(PAGE_GROUPS)

function loadMore() {
  if (restGroups.value <= 0) return
  shownGroups.value += PAGE_GROUPS
  nextTick(fillViewport)
}

/** 内容还没把滚动条撑出来时继续补 —— 否则用户滚不到底, 自动加载永远不触发 */
function fillViewport() {
  const el = scrollEl.value
  if (!el || restGroups.value <= 0) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) loadMore()
}

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  showTop.value = el.scrollTop > 320
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 480) loadMore()
}

/** 滚的是 TvModal 的 .body(不是 .list —— .list 高度跟着内容长, 自己不滚) */
function bindScroll() {
  unbindScroll()
  const el = rootEl.value?.closest('.body')
  if (!el) return
  scrollEl.value = el
  el.addEventListener('scroll', onScroll, { passive: true })
  fillViewport()
}
function unbindScroll() {
  if (scrollEl.value) scrollEl.value.removeEventListener('scroll', onScroll)
  scrollEl.value = null
  showTop.value = false
}
function toTop() {
  scrollEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

watch(view, () => {
  shownGroups.value = PAGE_GROUPS
  nextTick(() => {
    scrollEl.value?.scrollTo({ top: 0 })
    showTop.value = false
    fillViewport()
  })
})
watch(result, () => {
  shownGroups.value = PAGE_GROUPS
  nextTick(fillViewport)
})
watch(open, (v) => { if (v) nextTick(bindScroll); else unbindScroll() })
onBeforeUnmount(unbindScroll)

/* ---------------- 保留优先级(可自定义, 2026-10-17) ----------------
 * 「删其余」删谁留谁, 用户说了算:
 *   1) 跨文件夹: 拖拽「保留优先级」排序 —— 越靠前的文件夹里的图越优先保留;
 *   2) 同文件夹: 按「组内保留」下拉选的规则(见下面 KEEP_RULE_OPTIONS);
 *   3) 打平: 分辨率大的保留, 再平手看文件大小。
 * 文件夹顺序持久化在 localStorage(纯展示层偏好, 不值得过 IPC 落盘)。 */
const PRIO_LS_KEY = 'tv.dup.folderPriority'
function loadFolderOrder() {
  try { return JSON.parse(localStorage.getItem(PRIO_LS_KEY) || '[]') } catch { return [] }
}
const folderOrder = ref(loadFolderOrder())
watch(folderOrder, (v) => {
  try { localStorage.setItem(PRIO_LS_KEY, JSON.stringify(v)) } catch { /* 隐私模式等, 存不进就算了 */ }
}, { deep: true })

const dirOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '' : p.slice(0, i)
}
const baseOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}
/** 优先级排序的单位 = 注册的来源文件夹(不按子目录拆, 2026-10-17 用户拍板) */
const regFolderOf = (it) => it.folder || dirOf(it.path)
/** 目录显示名: 最多两级, 太长的前面省略 */
function shortDir(d) {
  const seg = String(d).split(/[\\/]/).filter(Boolean)
  if (!seg.length) return '(根目录)'
  return (seg.length > 2 ? '…' : '') + seg.slice(-2).join('\\')
}
/** 文件名的「画师信息分」: pixiv 式 名字+id 3 分; 有长数字(可能 id) 2 分; 裸图名 0 分 */
function fileScore(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '')
  if (/^[\w\u4e00-\u9fa5.\-]+[\s_\-]*\d{5,}(_p\d+)?$/i.test(base)) return 3
  if (/\d{5,}/.test(base)) return 2
  return 0
}

/* ---------------- 同文件夹保留规则(2026-10-24 用户需求) ----------------
 * 原来固定按「画师信息 → 分辨率 → 大小」, 改成下拉可选:
 *   跨文件夹仍然按上面的手工顺序优先, 同文件夹内按选中的规则定★。
 * 创建时间取文件 birthtime(主进程 stat), 读不到时回落库里的 mtime。 */
const KEEP_RULE_KEY = 'tv.dup.keepRule'
const KEEP_RULE_OPTIONS = [
  { value: 'artist', label: '画师信息（文件名带名字+uid/pid）' },
  { value: 'ctime', label: '创建时间（较早的优先）' },
  { value: 'size', label: '文件大小（较大的优先）' },
  { value: 'pixels', label: '分辨率（较大的优先）' },
  { value: 'meta', label: '带提示词元数据（优先）' },
]
const keepRule = ref((() => {
  try {
    const v = localStorage.getItem(KEEP_RULE_KEY)
    return KEEP_RULE_OPTIONS.some((o) => o.value === v) ? v : 'artist'
  } catch { return 'artist' }
})())
watch(keepRule, (v) => {
  try { localStorage.setItem(KEEP_RULE_KEY, v) } catch { /* 隐私模式等, 存不进就算了 */ }
})
const RULE_HINT = {
  artist: '同文件夹内文件名带画师信息的优先',
  ctime: '同文件夹内创建时间更早的优先',
  size: '同文件夹内文件更大的优先',
  pixels: '同文件夹内分辨率更高的优先',
  meta: '同文件夹内带图内提示词元数据的优先',
}
const ruleHint = computed(() => `${RULE_HINT[keepRule.value]}（打平看分辨率、大小）`)

/** 同文件夹内的比较: 第一判据由 keepRule 决定, 打平统一回落分辨率 → 大小 */
function keepCmp(a, b) {
  if (keepRule.value === 'ctime') {
    const x = a.bt || Number.MAX_SAFE_INTEGER
    const y = b.bt || Number.MAX_SAFE_INTEGER
    if (x !== y) return x - y
  } else if (keepRule.value === 'size') {
    if ((a.size || 0) !== (b.size || 0)) return (b.size || 0) - (a.size || 0)
  } else if (keepRule.value === 'pixels') {
    if (a.px !== b.px) return b.px - a.px
  } else if (keepRule.value === 'meta') {
    if (a.meta !== b.meta) return b.meta - a.meta
  } else if (a.fs !== b.fs) {
    return b.fs - a.fs
  }
  return b.px - a.px || (b.size || 0) - (a.size || 0)
}

/** 当前结果里出现过的来源文件夹(去重, 按首次出现), 用户排过的按手动顺序提前 */
const folderChips = computed(() => {
  const seen = []
  const seenSet = new Set()
  for (const g of sourceGroups.value) {
    for (const it of g.items) {
      const d = regFolderOf(it)
      const k = d.toLowerCase()
      if (!seenSet.has(k)) { seenSet.add(k); seen.push(d) }
    }
  }
  const idxOf = (d) => folderOrder.value.findIndex((x) => String(x).toLowerCase() === d.toLowerCase())
  const ordered = seen.filter((d) => idxOf(d) >= 0)
  const rest = seen.filter((d) => idxOf(d) < 0)
  ordered.sort((a, b) => idxOf(a) - idxOf(b))
  return [...ordered, ...rest]
})
const rankOf = computed(() => {
  const m = new Map()
  folderChips.value.forEach((d, i) => m.set(d.toLowerCase(), i))
  return m
})

/* 拖拽排序: dragstart 记起点, 拖到哪格就插到哪; 拖过一次 = 全部文件夹纳入手动排序 */
let dragFrom = -1
const dropAt = ref(-1)
function onDragStart(i, e) {
  dragFrom = i
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', String(i)) } catch { /* 老引擎无所谓 */ }
  }
}
function onDropAt(i) {
  const from = dragFrom
  dragFrom = -1
  dropAt.value = -1
  if (from < 0 || from === i) return
  const arr = [...folderChips.value]
  const moved = arr.splice(from, 1)[0]
  arr.splice(i, 0, moved)
  folderOrder.value = arr
  // 顺序是自动持久化的(localStorage) —— 明说一句, 免得"没保存"的误会
  ui.ok('优先级顺序已保存(重扫/重启后仍生效)', 'ok', 2000)
}

/** 面板真正渲染的组: 安全模式过滤 -> 组内按保留优先级排序(第 1 名 = ★) */
const decorated = computed(() => {
  const rk = rankOf.value
  return groups.value.map((g, gi) => {
    const items = g.items.map((it) => {
      const dir = dirOf(it.path)
      const base = baseOf(it.path)
      return {
        ...it, dir, base,
        fk: rk.get(regFolderOf(it).toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
        fs: fileScore(base),
        px: (it.px_w || 0) * (it.px_h || 0),
        bt: Number(it.bt) || Number(it.mtime_ms) || 0,
        mt: Number(it.mt) || Number(it.mtime_ms) || 0,
        meta: it.img_src ? 1 : 0,
      }
    })
    items.sort((a, b) => a.fk - b.fk || keepCmp(a, b) || (a.path < b.path ? -1 : 1))
    return { ...g, _key: `${items[0]?.id}-${gi}`, items }
  })
})
const pagedGroups = computed(() => decorated.value.slice(0, shownGroups.value))
const restGroups = computed(() => Math.max(0, decorated.value.length - shownGroups.value))

/** ★ 的理由(悬停提示): 说清楚为什么留它不留别的(跟着当前保留规则走) */
function keepWhy(items) {
  const a = items[0]
  const b = items[1]
  if (!a || !b) return '建议保留'
  if (a.fk !== b.fk) return `建议保留: 所在文件夹优先级更高(${shortDir(regFolderOf(a))})`
  if (keepRule.value === 'ctime' && a.bt !== b.bt) return `建议保留: 创建时间更早(${fmtTime(a.bt || a.mt)})`
  if (keepRule.value === 'size' && (a.size || 0) !== (b.size || 0)) return `建议保留: 文件更大(${fmtSize(a.size)})`
  if (keepRule.value === 'pixels' && a.px !== b.px) return `建议保留: 分辨率更高(${a.px_w}×${a.px_h})`
  if (keepRule.value === 'meta' && a.meta !== b.meta) return '建议保留: 带图内提示词元数据'
  if (keepRule.value === 'artist' && a.fs !== b.fs) {
    return a.fs >= 3 ? '建议保留: 文件名带画师信息(名字+uid/pid)' : '建议保留: 文件名更像画师命名'
  }
  if (a.px !== b.px) return `建议保留: 分辨率更大(${a.px_w}×${a.px_h})`
  if ((a.size || 0) !== (b.size || 0)) return `建议保留: 文件更大(${fmtSize(a.size)})`
  return '建议保留'
}

/** 右键菜单: 与网格卡片同一套原生菜单(路径来自查重结果, 收藏快照用组内 tags) */
function onItemCtx(e, it) {
  ctxMenu.open(e, {
    path: it.path,
    tags: String(it.tags || '').split(',').filter(Boolean),
    favable: true,
    favorited: fav.isFav(it.path),
  })
}

/* ---------------- 删除(单张 / 组级) ---------------- */
async function delOne(path) {
  if (trash.state.open) return   // 确认弹窗开着时不再叠加请求(与光箱 Del 同款防重入)
  const trashed = await trash.request([path])
  pruneTrashed(trashed)
}
/** 组级: 删掉非★项(优先级第 1 名不动) */
async function delRest(g) {
  if (trash.state.open) return
  if (!g.items.length) return
  const paths = g.items.slice(1).map((it) => it.path)
  if (!paths.length) { ui.toast('这组只有一张, 没有可删的', 'info'); return }
  const trashed = await trash.request(paths)
  pruneTrashed(trashed)
}

/** 'tv:trashed' 与删除回执统一走这里: 剪掉组内已删项, 剩不足 2 张的组整个移除 */
function pruneTrashed(trashed) {
  if (!trashed?.length) return
  const gone = new Set(trashed)
  if (result.value) {
    result.value.groups = result.value.groups
      .map((g) => ({ ...g, items: g.items.filter((it) => !gone.has(it.path)) }))
      .filter((g) => g.items.length >= 2)
  }
  if (ignored.value) {
    ignored.value.groups = ignored.value.groups
      .map((g) => ({ ...g, items: g.items.filter((it) => !gone.has(it.path)) }))
      .filter((g) => g.items.length >= 2)
  }
}
function onTrashed(e) { pruneTrashed(e?.detail?.paths) }
window.addEventListener('tv:trashed', onTrashed)
onBeforeUnmount(() => window.removeEventListener('tv:trashed', onTrashed))

/* ---------------- 误报忽略(持久化) ---------------- */
const ignoredAdded = ref(0)       // 本次会话里新忽略的组数(配合 result.ignoredPairs 展示)
/**
 * 面板渲染的组是「安全模式过滤 + 按保留规则重排」后的副本, 首图不一定还是原组首图,
 * 被过滤掉的图也不在副本里。所以反查原组只能按「任意一张的 id」找, 再拿**原组全部成员**
 * 去落盘 —— 否则多图组会点了没反应, 或只忽略/屏蔽掉一半图片对。
 */
function findOriginalGroup(list, g) {
  const id = g.items[0]?.id
  if (id == null) return null
  return list?.find((rg) => rg.items.some((it) => it.id === id)) || null
}
/** 整组两两 id 对 -> 主进程落盘; 本地立即剪掉这组 */
async function ignoreGroup(g) {
  const orig = findOriginalGroup(result.value?.groups, g)
  const idx = orig ? result.value.groups.indexOf(orig) : -1
  if (!orig || idx < 0) { ui.err('没找到这组的原始结果，重新扫描后再试'); return }
  const pairs = []
  for (let a = 0; a < orig.items.length; a++) {
    for (let b = a + 1; b < orig.items.length; b++) {
      pairs.push([orig.items[a].id, orig.items[b].id])
    }
  }
  try {
    await api.dupIgnoreAdd(pairs)
    result.value.groups.splice(idx, 1)
    ignoredAdded.value++
    ui.toast(`已忽略这组(${pairs.length} 对), 下次扫描不再出现`, 'ok')
  } catch (e) {
    ui.err('忽略失败: ' + (e?.message || e))
  }
}
const ignoredTotal = computed(() => (result.value?.ignoredPairs || 0) + ignoredAdded.value)

/** 恢复一组(2026-10-23): 删掉这组 id 之间的对, 再扫就会回来 */
async function restoreGroup(g) {
  const orig = findOriginalGroup(ignored.value?.groups, g)
  if (!orig) { ui.err('这组已经不在忽略记录里了，刷新后再试'); return }
  try {
    const r = await api.dupIgnoreRemove(orig.items.map((it) => it.id))
    ignored.value = ignored.value
      ? { ...ignored.value, pairs: Math.max(0, ignored.value.pairs - (r?.removed || 0)) }
      : null
    ui.toast(`已恢复这组(${r?.removed || 0} 对) · 重新扫描后会重新出现`, 'ok', 2600)
    await loadIgnored()
  } catch (e) {
    ui.err('恢复失败: ' + (e?.message || e))
  }
}

/**
 * 删记录(2026-10-24 用户需求): 这组确认不重复, 从「已忽略」里也删掉, 以后查重任何列表都不出现。
 * 不是删图片 —— 只动查重记录; 误删了可以点底部的「全部恢复」(重新扫描后回来)。
 */
async function blockGroup(g) {
  const orig = findOriginalGroup(ignored.value?.groups, g)
  if (!orig) { ui.err('这组已经不在忽略记录里了，刷新后再试'); return }
  try {
    await api.dupIgnoreBlock(orig.items.map((it) => it.id))
    // 永久忽略的组数由主进程按 id 对重新还原(可能并进已有的组), 直接读权威结果
    await loadIgnored()
    ui.toast(`已删除这组记录 · 以后查重不再出现（不删图片，可在底部全部恢复）`, 'ok', 3200)
  } catch (e) {
    ui.err('删除记录失败: ' + (e?.message || e))
  }
}

/** 恢复全部永久忽略: 清掉黑名单并重扫, 这些组会重新出现在相似组里 */
async function restoreBlockedAll() {
  try {
    const r = await api.dupBlockClear()
    ui.toast(`已恢复 ${r?.removed || 0} 对永久忽略记录, 重新扫描中…`, 'ok')
    await run()
    if (view.value === 'ignored') await loadIgnored()
  } catch (e) {
    ui.err('恢复失败: ' + (e?.message || e))
  }
}

/** 恢复全部 = 清空忽略表并重扫(之前忽略的全部回来) */
async function unignoreAll() {
  try {
    const r = await api.dupIgnoreClear()
    ignoredAdded.value = 0
    ui.toast(`已恢复 ${r?.removed || 0} 对误报记录, 重新扫描中…`, 'ok')
    await run()
    if (view.value === 'ignored') await loadIgnored()
  } catch (e) {
    ui.err('恢复失败: ' + (e?.message || e))
  }
}

/* ---------------- 光箱: 跨组连看(2026-10-24) ----------------
 * 用户需求: 一组看到最后一张时还能接着看下一组; 退出光箱后自动回到刚看的那一组。
 * 做法: 把面板里所有可见组按显示顺序拍平成一份翻页列表(组与组自然衔接),
 * 同时记下每组的 id 集合 —— 退出时用最后停留的图反查它属于哪一组。
 */
const lbMarks = ref([])   // [{ ids:Set, paths:Set }]

function openItem(group, item) {
  const list = []
  const marks = []
  for (const g of decorated.value) {
    const ids = new Set()
    const paths = new Set()
    for (const it of g.items) { list.push(it.path); ids.add(it.id); paths.add(it.path) }
    marks.push({ ids, paths })
  }
  // 点的那张必须能被 indexOf 定位(组刚被过滤/剪枝时兜底, 否则光箱没有翻页)
  if (!list.includes(item.path)) list.push(item.path)
  lbMarks.value = marks
  lightbox.open(item.path, { list })
}

function onLbClosed(e) {
  const p = e?.detail?.path
  if (!open.value || !p) return
  const mark = lbMarks.value.find((m) => m.paths.has(p))
  if (!mark) return
  const idx = decorated.value.findIndex((g) => g.items.some((it) => mark.ids.has(it.id)))
  revealGroup(idx)
}

/** 定位到某一组: 不够就先把组补渲染出来, 再滚过去并短暂高亮 */
function revealGroup(idx) {
  if (idx < 0) return
  if (shownGroups.value < idx + 1) shownGroups.value = idx + 1
  nextTick(() => requestAnimationFrame(() => {
    const el = rootEl.value?.querySelector(`[data-gi="${idx}"]`)
    const box = scrollEl.value
    if (!el || !box) return
    const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    flashGi.value = idx
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { flashGi.value = -1; flashTimer = null }, 1600)
  }))
}
window.addEventListener('tv:lb-closed', onLbClosed)
onBeforeUnmount(() => {
  window.removeEventListener('tv:lb-closed', onLbClosed)
  if (flashTimer) clearTimeout(flashTimer)
})

function fmtSize(n) {
  if (!n) return ''
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}
function fmtTime(ms) {
  if (!ms) return '未知'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <TvModal v-model="open" title="🔎 相似图查重" size="xl">
    <div ref="rootEl" class="dup" @wheel="onWheel">
      <!-- 工具条: 控件一行对齐(inline 下拉不再把标签顶到上一行) -->
      <div class="bar">
        <TvSelect v-model="threshold" inline size="sm" label="相似度" :options="THRESHOLD_OPTIONS" />
        <TvButton size="sm" variant="secondary" :loading="loading" @click="run">↻ 重新扫描</TvButton>

        <!-- 视图切换: 相似组 / 已忽略的组(2026-10-23) -->
        <div class="seg">
          <button type="button" :class="{ on: view === 'groups' }" @click="view = 'groups'">
            相似组{{ result ? ` ${groups.length}` : '' }}
          </button>
          <button type="button" :class="{ on: view === 'ignored' }" @click="view = 'ignored'">
            已忽略{{ ignored ? ` ${ignored.groups.length} 组` : '' }}
          </button>
        </div>

        <span v-if="view === 'groups' && result" class="sum">
          扫描 {{ result.scanned.toLocaleString() }} 张 ·
          <b>{{ groups.length }}</b> 组
          <span v-if="safetyView.hiddenGroups" class="sfthide" title="开着安全模式, 命中敏感标签的图/组不显示">（🛡 隐藏 {{ safetyView.hiddenGroups }} 组）</span>
          <template v-if="result.truncated">（已达上限，可提高阈值）</template>
          · {{ (result.elapsedMs / 1000).toFixed(1) }}s
        </span>
        <span v-else-if="view === 'ignored' && ignored" class="sum">
          共 <b>{{ ignored.groups.length }}</b> 组 / {{ ignored.pairs }} 对
          <span v-if="ignored.missingPairs" class="faint" title="图已删除或整库重导过, 这些 id 对已经对不上任何图">（{{ ignored.missingPairs }} 对已失效）</span>
          <span v-if="safetyView.hiddenGroups" class="sfthide">（🛡 隐藏 {{ safetyView.hiddenGroups }} 组）</span>
        </span>

        <span class="spacer" />
        <span class="zoomhint" title="Ctrl+滚轮可以放大 / 缩小原图卡片">🔍 {{ imgH }}px</span>
        <TvSafetyToggle />
        <button
          v-if="view === 'groups' && ignoredTotal > 0"
          class="igchip"
          type="button"
          title="切到「已忽略」看看忽略过哪些组, 可以逐组恢复"
          @click="view = 'ignored'"
        >
          已忽略 {{ ignoredTotal }} 项 · 查看
        </button>
        <button
          v-else-if="view === 'ignored' && ignored?.pairs"
          class="igchip"
          type="button"
          title="清空忽略表并重新扫描 —— 之前忽略的全部回来"
          @click="unignoreAll"
        >
          ↩ 恢复全部
        </button>
      </div>

      <!-- 保留优先级: 跨文件夹拖拽排序(只在一个组跨多个文件夹时才有得排) -->
      <div v-if="folderChips.length > 1" class="prio">
        <span class="plab" title="拖动调整顺序: 越靠前的文件夹里的图越优先保留">↕ 保留优先级</span>
        <div class="chips">
          <span
            v-for="(d, i) in folderChips"
            :key="d"
            class="chip"
            :class="{ over: dropAt === i }"
            draggable="true"
            :title="`${i + 1}. ${d}`"
            @dragstart="onDragStart(i, $event)"
            @dragend="dragFrom = -1; dropAt = -1"
            @dragover.prevent="dropAt = i"
            @drop.prevent="onDropAt(i)"
          ><b>{{ i + 1 }}</b>{{ shortDir(d) }}</span>
        </div>
        <TvButton size="xs" variant="ghost" title="注意: 这不是刷新 —— 会清除手动排序恢复默认顺序; 手动顺序平时已自动保存" @click="folderOrder = []">↺</TvButton>
        <span class="phint">越前越优先保留; 同文件夹内按下面的「组内保留」规则, 再看分辨率/大小</span>
      </div>
      <div v-else class="hintline">
        ★ = 建议保留 · 悬停原图 🗑 删单张 · 组头「删其余」删非★项 · 「非重复」忽略误报 —— 都进系统回收站/可还原
        · <b>Ctrl+滚轮</b>缩放原图
      </div>
      <div class="rulebar">
        <TvSelect v-model="keepRule" inline size="sm" label="组内保留" :options="KEEP_RULE_OPTIONS" />
        <span class="phint">{{ ruleHint }}</span>
      </div>

      <div v-if="error" class="err">扫描失败：{{ error }}</div>
      <div v-else-if="loading && !result" class="empty">正在比对全库标签…（约 2 秒）</div>
      <div v-else-if="view === 'ignored' && ignoredLoading && !ignored" class="empty">正在读取忽略记录…</div>
      <div v-else-if="view === 'ignored' && !ignored?.pairs" class="empty">
        <template v-if="ignored?.blockedGroups">忽略记录里的组都被你删掉了（永久忽略 {{ ignored.blockedGroups }} 组，可在下方恢复）</template>
        <template v-else>还没有忽略过任何图片组 —— 在「相似组」里点「🚫 非重复」的组会出现在这里</template>
      </div>
      <div v-else-if="!groups.length" class="empty">
        <template v-if="view === 'ignored'">忽略记录里的图对都对不上现存图片了（可能已经删掉或整库重导过）</template>
        <template v-else-if="safetyView.hiddenGroups">
          发现的相似组都被安全模式隐藏了（{{ safetyView.hiddenGroups }} 组 / {{ safetyView.hiddenItems }} 张）—— 关掉 🛡 可见
        </template>
        <template v-else>这个阈值下没有发现相似组 —— 试试调低阈值</template>
      </div>

      <div v-else class="list">
        <div v-for="(g, gi) in pagedGroups" :key="g._key" :data-gi="gi" :class="['grp', { flash: flashGi === gi }]">
          <div class="ghead">
            <span v-if="g.ignored" class="score ig">已忽略</span>
            <span v-else class="score" :class="{ hi: g.score >= 0.999 }">{{ (g.score * 100).toFixed(1) }}%</span>
            <span class="cnt">{{ g.items.length }} 张</span>
            <span v-if="g.shared?.length" class="shared" :title="g.shared.join(', ')">
              共享: <i v-for="t in g.shared.slice(0, 6)" :key="t">{{ t }}</i>
            </span>
            <span class="gacts">
              <template v-if="g.ignored">
                <button class="gbtn" type="button" title="把这组从忽略表移除 —— 重新扫描后会重新出现" @click="restoreGroup(g)">↩ 恢复这组</button>
                <button class="gbtn danger" type="button" title="这组确认不重复 —— 从忽略记录里删掉, 以后查重不再出现（只删记录, 不删图片）" @click="blockGroup(g)">🗑 删记录</button>
              </template>
              <template v-else>
                <button class="gbtn" type="button" title="这组不是重复图 —— 忽略后下次扫描不再出现" @click="ignoreGroup(g)">🚫 非重复</button>
                <button class="gbtn danger" type="button" title="删除组内除★(优先级第1名)外的所有图(进系统回收站)" @click="delRest(g)">🗑 删其余</button>
              </template>
            </span>
          </div>
          <div class="items">
            <div
              v-for="(it, ii) in g.items"
              :key="it.id"
              class="item"
              :style="{ width: itemW(it) + 'px' }"
              :title="`${it.path}\n${it.px_w}×${it.px_h}${it.size ? ' · ' + fmtSize(it.size) : ''}`"
              @contextmenu="onItemCtx($event, it)"
            >
              <!-- 原图直显(2026-10-23): width=0 走原图流, contain 完整显示;
                   原图请求单独限流 + 懒加载, rootMargin 收窄到 300px -->
              <div class="thumb" :style="{ height: imgH + 'px' }">
                <TvImage
                  :path="it.path"
                  :width="0"
                  contain
                  orig-gate
                  root-margin="300px 0px"
                  @click="openItem(g, it)"
                />
                <button
                  class="del"
                  type="button"
                  title="删除这张(进系统回收站, 可还原)"
                  @click.stop="delOne(it.path)"
                >🗑</button>
                <span v-if="ii === 0" class="bestmark" :title="keepWhy(g.items)">★</span>
                <span v-else class="rank" :title="`保留优先级第 ${ii + 1} 名`">{{ ii + 1 }}</span>
              </div>
              <div class="meta" @click="openItem(g, it)">
                <span class="fname" :title="it.path">{{ it.base }}</span>
                <span class="fdir" :title="it.dir">{{ shortDir(it.dir) }}</span>
                <span class="dims">{{ it.px_w }}×{{ it.px_h }}<template v-if="it.size"> · {{ fmtSize(it.size) }}</template></span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="restGroups" class="moregrp">
          <span class="spin" />继续向下滚动，自动加载（还剩 {{ restGroups }} 组）
        </div>
        <div v-else class="moregrp end">已经到底了 · 共 {{ groups.length }} 组</div>
      </div>

      <!-- 永久忽略(2026-10-24): 只留一个计数和总恢复入口, 不再逐组占列表 -->
      <div v-if="view === 'ignored' && ignored?.blockedPairs" class="blockedline">
        另有 <b>{{ ignored.blockedGroups }}</b> 组已删除记录（{{ ignored.blockedPairs }} 对永久忽略），不会再出现在查重里
        <button class="linkbtn" type="button" title="清空永久忽略并重新扫描 —— 这些组会重新回到相似组" @click="restoreBlockedAll">全部恢复</button>
      </div>

      <div class="totop-wrap">
        <button v-if="showTop" class="totop" type="button" title="回到顶部" @click="toTop">↑ 顶部</button>
      </div>
    </div>
  </TvModal>
</template>

<style scoped>
.dup { display: flex; flex-direction: column; gap: 10px; min-height: 420px; }
/* 工具条: 全部控件同一行内垂直居中, 不再有"标签顶到上一行"的错位 */
.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bar :deep(.tv-select.inline select) { min-width: 150px; }
.sum { color: var(--muted); font-size: 12px; }
.sum b { color: var(--accent); }
.sfthide { color: var(--muted); }
.spacer { flex: 1 1 auto; }
.phint, .hintline { color: var(--muted); font-size: 11px; }
.hintline { line-height: 1.6; }
.hintline b { color: var(--text); font-weight: 600; }
.err { color: var(--danger); font-size: 13px; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; }

/* 视图切换(相似组 / 已忽略) */
.seg {
  display: inline-flex; overflow: hidden;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--panel2);
}
.seg button {
  background: none; border: 0; cursor: pointer; font-family: inherit;
  color: var(--muted); font-size: 12px; padding: 4px 10px; line-height: 1.4;
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 500; }

.zoomhint {
  font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 已忽略误报提示 chip(可点进已忽略视图) */
.igchip {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: inherit; font-size: 12px; color: var(--muted);
  background: var(--panel3, rgba(128,128,128,.15));
  border: 1px solid transparent; border-radius: 999px; padding: 2px 10px;
  cursor: pointer;
}
.igchip:hover { color: var(--accent); border-color: var(--accent); }

/* 保留优先级行: 标签 + 可拖拽文件夹链 + 重置 */
.prio { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plab { font-size: 12px; color: var(--muted); white-space: nowrap; }
.chips { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text, inherit);
  background: var(--panel3, rgba(128,128,128,.15));
  border: 1px solid var(--border, rgba(128,128,128,.25));
  border-radius: 999px; padding: 2px 9px;
  cursor: grab; user-select: none; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip:active { cursor: grabbing; }
.chip b {
  font-size: 10px; line-height: 1; flex: none;
  background: var(--accent); color: var(--on-accent, #fff);
  border-radius: 999px; padding: 2px 5px;
}
.chip.over { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.phint { flex-basis: 100%; }

/* 组内保留规则: 文件夹优先级之后/单文件夹时的固定一行 */
.rulebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rulebar .phint { flex-basis: auto; }

.list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.moregrp {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 0 14px; color: var(--muted); font-size: 12px;
}
.moregrp.end { opacity: .7; }
/* 永久忽略汇总: 不打扰列表, 但要让人知道去哪找回 */
.blockedline {
  margin-top: 8px; padding: 8px 10px; border-radius: 6px;
  background: var(--panel2); border: 1px dashed var(--border);
  color: var(--muted); font-size: 12px;
}
.blockedline b { color: var(--text); }
.blockedline .linkbtn {
  border: none; background: none; padding: 0 4px; margin-left: 4px;
  color: var(--accent); font: inherit; cursor: pointer; text-decoration: underline;
}
.spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid var(--border); border-top-color: var(--accent);
  animation: dupspin .9s linear infinite;
}
@keyframes dupspin { to { transform: rotate(360deg); } }

/* 回到顶部: 粘在滚动区右下角(0 高度的壳不占布局, 按钮向上溢出) */
.totop-wrap {
  position: sticky; bottom: 10px; z-index: 8;
  height: 0; display: flex; align-items: flex-end; justify-content: flex-end;
  pointer-events: none;
}
.totop {
  pointer-events: auto;
  font-family: inherit; font-size: 12px; color: var(--text);
  background: var(--panel); border: 1px solid var(--border); border-radius: 999px;
  padding: 6px 12px; cursor: pointer; box-shadow: var(--shadow-2);
}
.totop:hover { border-color: var(--accent); color: var(--accent); }
.grp {
  border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 8px; padding: 8px 10px;
}
/* 从光箱退出后落到的那一组: 短暂高亮, 让人一眼看到位置 */
.grp.flash { animation: dupflash 1.6s ease; }
@keyframes dupflash {
  0%, 35% { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft, rgba(99,102,241,.25)); }
  100% { border-color: var(--border, rgba(128,128,128,.25)); box-shadow: none; }
}
.ghead { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.score {
  font-weight: 700; font-size: 13px; padding: 1px 8px; border-radius: 10px;
  background: var(--panel3, rgba(128,128,128,.15));
}
.score.hi { background: var(--danger-soft, rgba(239,68,68,.14)); color: var(--danger); }
.score.ig { background: var(--panel3, rgba(128,128,128,.15)); color: var(--muted); font-weight: 500; font-size: 12px; }
.cnt { font-size: 12px; color: var(--muted); }
.shared { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shared i {
  font-style: normal; color: var(--ok, #3f9d63); background: rgba(63,157,99,.1);
  border-radius: 4px; padding: 0 4px; margin-right: 4px;
}
.gacts { margin-left: auto; display: inline-flex; gap: 6px; flex: 0 0 auto; }
.gbtn {
  border: 1px solid var(--border, rgba(128,128,128,.25)); background: none;
  color: var(--muted); font-size: 11px; padding: 2px 8px; border-radius: 6px;
  cursor: pointer; white-space: nowrap;
}
.gbtn:hover { color: var(--text, inherit); border-color: var(--accent); }
.gbtn.danger:hover { color: var(--danger); border-color: var(--danger); }

.items { display: flex; gap: 8px; flex-wrap: wrap; }
.item {
  border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 6px;
  background: none; overflow: hidden; text-align: left; cursor: pointer;
  flex: 0 0 auto;
}
.item:hover { border-color: var(--accent); }
.item :deep(.tv-img) { display: block; width: 100%; height: 100%; }
.thumb { position: relative; }
/* 悬停单张删除: 右上角小圆钮, 不挤压布局 */
.thumb .del {
  position: absolute; top: 4px; right: 4px; z-index: 2;
  width: 24px; height: 24px; border-radius: 50%;
  border: none; cursor: pointer;
  background: rgba(10, 13, 18, .72); color: #fff; font-size: 12px; line-height: 1;
  opacity: 0; transition: opacity .15s ease;
  display: flex; align-items: center; justify-content: center;
}
.item:hover .del, .thumb .del:focus-visible { opacity: 1; }
.thumb .del:hover { background: var(--danger, #ef4444); }
/* 建议保留: 左上角常驻金★ */
.bestmark {
  position: absolute; top: 4px; left: 4px; z-index: 2;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--fav, #f59e0b); color: #fff; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
/* 非保留项: 左上角灰色小名次(让"为什么它排第 N"看得见) */
.rank {
  position: absolute; top: 6px; left: 6px; z-index: 2;
  min-width: 16px; height: 16px; border-radius: 999px; padding: 0 4px;
  background: rgba(10, 13, 18, .6); color: rgba(255,255,255,.85);
  font-size: 10px; line-height: 16px; text-align: center;
  pointer-events: none;
}
/* 文件名 / 所在文件夹 / 尺寸: 全省略号, 悬停 title 里给全路径 */
.meta { display: flex; flex-direction: column; gap: 1px; padding: 4px 6px 5px; }
.fname {
  font-size: 11px; color: var(--text, inherit);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fdir {
  font-size: 10px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dims { font-size: 10px; color: var(--muted); }
</style>
