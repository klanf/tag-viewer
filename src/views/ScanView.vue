<script setup>
/**
 * 扫描文件夹 —— 原 scan.html
 * ==========================
 * 读外部文件夹里 AI 生成图的元数据(png tEXt/iTXt, ComfyUI / A1111 / NAI / InvokeAI),
 * 提取提示词, 并按「能区分这张图」的顺序展示标签。
 *
 * 原版要靠 web 端的 /api/pick_folder 另起一个 python 进程弹 tkinter 窗口选目录
 * (还得 -topmost 抢焦点); 这里直接用 Electron 原生 dialog。
 *
 * 2026-09-18 改造成**两级结构**(文件夹库):
 *   一级 = 扫过的文件夹卡片列表, 添加即入库, 以后点开就用(不用每次再选目录);
 *   二级 = 该文件夹里的图片网格, 点图进大图预览(滚轮 / ←→ 可翻页)。
 *   扫描结果在主进程有 5 分钟内存缓存, 所以第二次点开是秒开;
 *   「重扫」按钮强制忽略缓存。
 *
 * 关键提示(原版专门写过警告, 保留): 如果一个文件夹里所有图的提示词**完全相同**,
 * 那不是"读取失败", 而是这批图本来就是同一提示词换种子刷出来的。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import TvInput from '@/components/base/TvInput.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvCheckbox from '@/components/base/TvCheckbox.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvImageCard from '@/components/image/TvImageCard.vue'
import TvEntityCard from '@/components/series/TvEntityCard.vue'
import TvState from '@/components/base/TvState.vue'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useAppStore } from '@/stores/useAppStore.js'
import { useTrash } from '@/composables/useTrash.js'
import { useJustifiedRows } from '@/composables/useJustifiedRows.js'
import { useGridZoom } from '@/composables/useGridZoom.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { openTaggerSetup } from '@/composables/useTaggerSetup.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import TvZoomBadge from '@/components/base/TvZoomBadge.vue'
import MoveTargetModal from '@/components/scan/MoveTargetModal.vue'
import { useFloatBack } from '@/composables/useFloatBack.js'
import { api, onPush } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'
import { LS } from '@/utils/lskey.js'

/** 扫描页筛选历史的键 —— 与首页那份公用历史分开存(见 utils/lskey.js 的 searchHistoryScan) */
const SCAN_HIST_KEY = LS.searchHistoryScan.key

const lb = useLightboxStore()
const ui = useUiStore()
const prefs = usePrefsStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()
const fav = useFavStore()
const trash = useTrash()
const route = useRoute()
/** 反推环境状态(config.available/missing 来自 tagger:status 的静态探测, 见 tagger.js) */
const app = useAppStore()
/** 反推环境不全时, 这页就是"事故现场" —— 常驻一条可操作的引导, 不让降级变成死胡同 */
const taggerMissing = computed(() => {
  const cfg = app.tagger?.config
  return !!cfg && cfg.available === false
})
const taggerMissingText = computed(() => (app.tagger?.config?.missing || []).join('、'))

/* ---------------- 一级: 文件夹库 ---------------- */
const level = ref('list')            // list | folder
const folders = ref([])
const loadingList = ref(false)
const listError = ref('')
const kw = ref('')
const recursive = ref(true)          // 新添加时是否含子文件夹
const adding = ref(false)
const addProgress = ref('')
const manual = ref('')               // 手动输入路径

/* ---------------- 二级: 文件夹内容 ---------------- */
const cur = ref(null)                // 当前文件夹记录
const result = ref(null)             // 扫描结果
const opening = ref(false)
const rescanning = ref(false)
const page = ref(1)
const pageSize = ref(120)
const sortBy = ref(prefs.sortScan)

/* 排序可选值 —— 全在前端排(扫描的是**库外图片**, 库里没有它们的行, 后端排不了)。
 * 时间/大小要的数据由后端 scan.js 的 item 带过来(它本来就 statSync 过, 白捡的)。 */
const SORT_OPTIONS = [
  { value: 'name', label: '文件名 A-Z' },
  { value: 'name_desc', label: '文件名 Z-A' },
  { value: 'folder', label: '按子文件夹' },
  { value: 'time_desc', label: '修改时间 新→旧' },
  { value: 'time_asc', label: '修改时间 旧→新' },
  { value: 'size_desc', label: '大小 大→小' },
  { value: 'size_asc', label: '大小 小→大' },
  { value: 'tags_desc', label: '标签数 多→少' },
]
/* 文件名比较用带 numeric 的 Collator: 默认的字符串比较下 "10.png" 排在 "2.png" 前面,
 * 0001..9999 这种命名看着就是乱的。Collator 建一次复用, 别在比较函数里反复 new。 */
const nameColl = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a, b) => nameColl.compare(a.name || '', b.name || '')
/* 主键相同的再按文件名兜底 —— 否则同 mtime/同大小的一批图每次刷新都换顺序, 像在跳 */
function cmpOf(mode) {
  switch (mode) {
    case 'name_desc': return (a, b) => byName(b, a)
    case 'folder': return (a, b) => (a.folder || '').localeCompare(b.folder || '') || byName(a, b)
    case 'time_desc': return (a, b) => (b.mtime || 0) - (a.mtime || 0) || byName(a, b)
    case 'time_asc': return (a, b) => (a.mtime || 0) - (b.mtime || 0) || byName(a, b)
    case 'size_desc': return (a, b) => (b.size || 0) - (a.size || 0) || byName(a, b)
    case 'size_asc': return (a, b) => (a.size || 0) - (b.size || 0) || byName(a, b)
    case 'tags_desc': return (a, b) => (b.tags || []).length - (a.tags || []).length || byName(a, b)
    default: return byName
  }
}
const error = ref('')
/* 图片卡上的角色/独有标签 -> 中文(批量查一次, 全页共用) */
const scanZh = ref({})

/* 元数据解析进度(主进程 worker 推送, 仅大批次扫描时出现) */
const scanProg = ref(null)
const scanPct = computed(() => {
  const p = scanProg.value
  return p?.total ? Math.round((p.done * 100) / p.total) : 0
})

const shownFolders = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const arr = [...folders.value]
  arr.sort((a, b) => {
    if (!!a.exists !== !!b.exists) return a.exists ? -1 : 1      // 失效的沉底
    return (b.last_scan || 0) - (a.last_scan || 0)               // 最近扫的在前
  })
  if (!k) return arr
  return arr.filter((f) => (f.name || '').toLowerCase().includes(k)
    || (f.path || '').toLowerCase().includes(k))
})

const rawItems = computed(() => result.value?.items || [])

/** 安全模式开关上那个数字 —— 是**这个文件夹**(= 当前所在来源)里会隐藏多少张,
 *  不是整个库的。用 rawItems 而不是 sortedItems: 这里回答的是"这个来源藏了多少",
 *  上面那个标签筛选改变的是"当前在看什么", 不该让这个数字跟着缩。
 *  (扫描页的图是库外图, 没有 feed 可用, 只能前端按标签现算 —— unsafeOf 里有记忆。) */
const scanHits = computed(() => safety.countHits(rawItems.value))

/* ---------------- 筛选(标签 + 文件名) ----------------
 * 扫描页的图是**库外图片**(标签从 PNG 元数据现场解析), 所以筛选只能在前端做,
 * 而且筛选条件本身也得来自这一批图 —— 搜索框的补全用当前文件夹的标签池,
 * **不查标签库**(扫描夹特有的标签在库里可能根本不存在, 查了也补不出来)。
 *
 * 匹配规则: 空格**或逗号**分隔多个词 = AND(每个词都得命中)。
 * 逗号是 TvTagSuggestInput 胶囊多词模式(multi)的定格键 —— 敲一下逗号,
 * 当前词变胶囊、继续输入时补全针对**下一个**词(2026-10-16 用户要求, 与看板同款);
 * 空格保留是因为老用户已经习惯了"空格分隔"(两种都认, 互不排斥)。
 * 单个词**两个地方都试**: 标签 或 文件名(含扩展名, 大小写不敏感), 命中其一即算。
 * 用**子串**匹配而非精确 —— 扫描出的角色标签带括号后缀,
 * 输入 hoshino 要能命中 hoshino_(blue_archive); 文件名同理(输入 a3 命中 a3.png)。
 * 文件名这一路是库外图的地盘: 扫描夹里常有一批**裸图**(PNG 里没提示词, 标签也
 * 反推不出来), 想在其中定位某一张, 唯一抓手就是文件名。 */
const filterKw = ref('')
const filterTokens = computed(() => filterKw.value.trim().toLowerCase().split(/[\s,，]+/).filter(Boolean))

/** 当前文件夹出现过的标签: 计数降序 + 中文(给补全用), 只在打开文件夹后才有内容 */
const scanTagPool = computed(() => {
  const cnt = new Map()
  for (const it of rawItems.value) {
    for (const t of it.tags || []) cnt.set(t, (cnt.get(t) || 0) + 1)
  }
  return [...cnt.entries()]
    .map(([tag, count]) => ({ tag, count, zh: scanZh.value[tag] || '' }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
})

const sortedItems = computed(() => {
  let arr = [...rawItems.value]
  const tk = filterTokens.value
  if (tk.length) {
    arr = arr.filter((it) => {
      const ts = it.tags || []
      const nm = (it.name || '').toLowerCase()
      return tk.every((w) => nm.includes(w) || ts.some((t) => t.toLowerCase().includes(w)))
    })
  }
  arr.sort(cmpOf(sortBy.value))
  /* 安全模式也管扫描页: 这些图是库外的, 没有主进程算好的敏感标记, 由 useSafetyStore
     按标签**现算**(见 utils/safetyMatch.js)。放在排序之后 —— 过滤不影响排序结果。 */
  return safety.filterItems(arr)
})

const totalPages = computed(() => Math.max(1, Math.ceil(sortedItems.value.length / pageSize.value)))
/* 累加式显示: 显示到第 page 页为止的全部内容(不是只显示这一页)。
 * 滚到底自动 page+1 追加下一页, 已看过的内容不消失、滚动位置不跳。 */
const pagedItems = computed(() => sortedItems.value.slice(0, page.value * pageSize.value))
/** 光箱翻页用全量顺序(不只当前页) */
const imgPaths = computed(() => sortedItems.value.map((it) => it.path))
/* 自适应行高: 每行按真实比例铺满、行高自适应(与首页/系列页/标签页同一套)。
 * 用 pagedItems(增量显示到第 page 页)而不是 sortedItems —— 必须和**实际渲染的内容**
 * 一致, 否则行会被还没显示出来的图撑变形。 */
/* 自适应行高: 每行按真实比例铺满、行高自适应(与首页/系列页/标签页同一套)。
 * 用 pagedItems(增量显示到第 page 页)而不是 sortedItems —— 必须和**实际渲染的内容**
 * 一致, 否则行会被还没显示出来的图撑变形。
 * base 乘上 Ctrl+滚轮的缩放倍率(2026-10-20, 与看板四个网格同一套, 倍率共用
 * tv_grid_zoom)—— base 支持响应式, 倍率一变行高立刻重排。 */
const { zoom: gridZoom, zoomFlash, onWheel: onGridWheel, reset: resetGridZoom } = useGridZoom()
const { wrapEl: rowsEl, rows: scanRows } = useJustifiedRows(pagedItems, { base: computed(() => 150 * gridZoom.value) })

/* 网格顺序变了(删除/移动联动剔除、改排序)就同步给光箱 —— 与首页 / 系列 / 标签三页一致。
 * 少了这一步, 光箱里那份 list 就只是"打开那一刻的快照": 网格已经把某张剔掉了,
 * 光箱还把它算在翻页序列里, 于是往后翻会翻到一张已经不在网格里的幽灵图。
 * (「删掉当前这张就前进」由 useLightboxStore 订阅 tv:trashed / tv:moved 自己负责,
 *  这里管的是另外那种情况: 被剔掉的是**别的**图。) */
watch(imgPaths, (arr) => { if (scanActive.value && lb.visible) lb.setList(arr) })
/* 激活守卫(2026-10-03): 本页被 KeepAlive 休眠时上面的 watch 依然活跃 —— 若用户
 * 在别的页面(看板)开着光箱, 这边后台刷新把扫描列表塞进光箱会污染翻页序列
 * (当前图不在其中 -> index 丢失 -> 再移一张图 removeCurrent 就 close())。
 * setList 里另有一道"新列表不含当前图就不动"的守卫, 两道防线互补: 这道挡
 * "恰好含当前图"的跨视图污染, 那道挡不含时的 index 丢失。 */
const scanActive = ref(true)
onActivated(() => { scanActive.value = true })
onDeactivated(() => { scanActive.value = false })

function fmtTime(ms) {
  if (!ms) return '从未'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------------- 动作 ---------------- */
async function loadFolders() {
  loadingList.value = true
  listError.value = ''
  try {
    const d = await api.folders()
    folders.value = d.folders || []
  } catch (e) {
    listError.value = e.message
  } finally {
    loadingList.value = false
  }
}

/* ---------------- 卡片统计后台刷新(2026-10-20) ----------------
 * 卡片上的「含提示词 N · 共 M」是上次打开/重扫时写的快照 —— 批量把图移走后
 * 缓存条目虽然被剔了, 快照没人重写, 卡片就一直停在旧数字。
 * 现在列表页每次进来(挂载/切回/搬完图返回)都叫主进程逐夹**增量对账**一遍,
 * 没变化的夹在 5 分钟 TTL 内秒回; 每夹完成推 folders:stats 回来重拉列表,
 * 卡片逐个变准, 不再需要手点「重扫」才更新。 */
const statsRefresh = ref(null)        // { done, total } | null —— 列表工具栏的小字进度
let statsReloadTimer = null
let lastStatsKick = 0
function kickStatsRefresh(onlyPaths) {
  /* only(精准对账单个夹)不受 15s 节流: 连续进出多个夹是正常操作, 被节流挡掉的话
   * 第二个夹退回来数字就不对; 单夹增量对账在 TTL 缓存内是秒回, 放行没代价。
   * 全量兜底(进列表页/切回)照旧节流, 主进程另有防重入。 */
  if (!onlyPaths && Date.now() - lastStatsKick < 15000) return
  lastStatsKick = Date.now()
  api.refreshFolderStats(onlyPaths).catch(() => { /* 主进程老版没这条通道就静默 */ })
}
function onStatsPush(p) {
  if (level.value !== 'list') return
  statsRefresh.value = p?.done ? null : { done: p.done, total: p.total }
  clearTimeout(statsReloadTimer)
  statsReloadTimer = setTimeout(() => {
    if (level.value === 'list') loadFolders()
  }, 250)
}

/** 选目录(可多选) -> 逐个扫描入库 */
async function addByPicker() {
  let picked
  try {
    picked = await api.pickFolder({ multi: true, title: '选择要加入的文件夹(可多选)' })
  } catch (e) {
    ui.err('打开文件夹选择框失败: ' + e.message)
    return
  }
  if (picked?.canceled) return
  await addMany(picked.paths || (picked.path ? [picked.path] : []))
}

async function addManual() {
  const p = manual.value.trim()
  if (!p) { ui.warn('先粘贴或输入一个文件夹路径'); return }
  const ok = await addMany([p])
  if (ok) manual.value = ''
}

async function addMany(paths) {
  const list = (paths || []).filter(Boolean)
  if (!list.length) return false
  adding.value = true
  let okCount = 0
  try {
    for (let i = 0; i < list.length; i++) {
      addProgress.value = list.length > 1 ? `正在扫描 ${i + 1} / ${list.length} ...` : '正在扫描 ...'
      try {
        const r = await api.addFolder({ path: list[i], recursive: recursive.value })
        if (r?.error) { ui.err(`${list[i]}: ${r.error}`); continue }
        okCount++
        if (r.folder) {
          const i2 = folders.value.findIndex((f) => f.path.toLowerCase() === r.folder.path.toLowerCase())
          if (i2 >= 0) folders.value[i2] = r.folder
          else folders.value = [...folders.value, r.folder]
        }
      } catch (e) {
        ui.err(`${list[i]}: ${e.message}`)
      }
    }
    if (okCount) ui.ok(list.length > 1 ? `✅ 已加入 ${okCount} / ${list.length} 个文件夹` : '✅ 已加入文件夹')
  } finally {
    adding.value = false
    addProgress.value = ''
  }
  return okCount > 0
}

async function removeFolder(f) {
  if (!window.confirm(`从列表移除「${f.name}」?\n\n只删这条记录, 磁盘上的文件不会被删除。`)) return
  try {
    const r = await api.removeFolder(f.path)
    if (r?.error) { ui.err(r.error); return }
    folders.value = folders.value.filter((x) => x.path.toLowerCase() !== f.path.toLowerCase())
    ui.ok('已从列表移除(文件未动)', 'info', 1800)
  } catch (e) {
    ui.err(e.message)
  }
}

/* 就地改名 —— 不用 window.prompt: Electron 渲染进程不支持它, 点了静默没反应
 * (与替换规则组那次同一个坑, 2026-10-04 顺手一起修)。点 ✏️ 变成输入框, 回车提交。 */
const renaming = ref('')
const renamingInput = ref('')
async function renameFolder(f) {
  if (renaming.value !== f.path) { renaming.value = f.path; return }
  const next = renamingInput.value
  renaming.value = ''
  renamingInput.value = ''
  try {
    const r = await api.updateFolder({ path: f.path, label: String(next || '').trim() })
    if (r?.error) { ui.err(r.error); return }
    const i = folders.value.findIndex((x) => x.path.toLowerCase() === f.path.toLowerCase())
    if (i >= 0) folders.value[i] = r.folder
  } catch (e) {
    ui.err(e.message)
  }
}

/** 本批图片的标签汇总去重, 批量查中文 —— 卡片上的中文 + 筛选框的中文补全都吃这张表 */
function fillScanZh(d) {
  // 覆盖**全部** tags, 不只是卡片上展示的那几个 key_tags: 筛选框要支持输入中文
  // (输「星野」补出 hoshino), 而中文映射只存在于这一张表里。
  // 4000 是防大文件夹(几万张图)把一次 IPC 撑爆; 超出只影响中文补全, 英文筛选照常。
  const cnt = new Map()
  for (const it of d.items || []) {
    for (const t of it.tags || []) cnt.set(t, (cnt.get(t) || 0) + 1)
  }
  const uniq = [...cnt.keys()].sort((a, b) => cnt.get(b) - cnt.get(a)).slice(0, 4000)
  if (!uniq.length) return
  api.translate(uniq)
    .then((m) => { scanZh.value = { ...scanZh.value, ...m } })
    .catch(() => { /* 没有翻译库也能用 */ })
}

/** 打开文件夹: 缓存命中秒开; 大文件夹走**流式**(扫到首批就进, 后台续扫边扫边涨) */
async function openFolder(f, { refresh = false } = {}) {  if (!f.exists) { ui.warn('这个文件夹已经不在了(可能被移动或改名)'); return }
  cur.value = f
  level.value = 'folder'
  opening.value = true
  scanProg.value = null
  streaming.value = false            // 上一轮的后台扫描状态作废(晚到的推送会被 path 匹配挡掉)
  streamInfo.value = null
  if (refresh) rescanning.value = true
  error.value = ''
  if (refresh) result.value = null
  page.value = 1
  filterKw.value = ''   // 换了文件夹就是换了一批图, 上一次的筛选词没有意义了
  selectMode.value = false   // 换文件夹也换了一批图, 选择集没有延续的意义
  clearSel()
  try {
    const d = await api.openFolder({ path: f.path, refresh })
    if (d?.error) { error.value = d.error; result.value = null; return }
    result.value = d
    fillScanZh(d)
    // 流式: 首批已经能看了(opening 立刻收工), 后台续扫由 scan:partial/scan:final 接力
    if (d?.streaming) {
      streaming.value = true
      streamInfo.value = { done: d.items?.length || 0, total: d.total || 0 }
    }
    // 高亮框持久化的场景: 重启后第一次打开这个文件夹, 高亮那张可能落在第 2+ 页,
    // 不补页的话它根本不会被渲染, TvImageCard 里的"自动滚过去"就永远等不到。
    if (lb.scrollPending && lb.lastPath) expandPageForPath(lb.lastPath)
    if (d.folder_record) {
      const i = folders.value.findIndex((x) => x.path.toLowerCase() === f.path.toLowerCase())
      if (i >= 0) folders.value[i] = d.folder_record
      cur.value = d.folder_record
    }
  } catch (e) {
    error.value = e.message
  } finally {
    opening.value = false
    rescanning.value = false
  }
}

function backToList() {
  /* 置空前记住刚退出的夹: 回列表只对账这一个(2026-10-20) —— 全量对账虽然便宜,
   * 但把所有夹都"活动"一遍没有任何必要, 用户诉求就是"只刷新退出的文件夹"。
   * 两个返回入口(右下悬浮箭头 / 右上「← 返回」按钮)都走这里, 改一处即可。 */
  const exited = cur.value?.path || null
  level.value = 'list'
  cur.value = null
  result.value = null
  error.value = ''
  selectMode.value = false
  streaming.value = false            // 回列表后后台扫描的推送不再有落点(path 匹配挡住)
  streamInfo.value = null
  clearSel()
  kickStatsRefresh(exited ? [exited] : null)   // 在夹里动过图(搬移/删除)回来, 卡片数字自动对账
}

function openImage(it) { lb.open(it.path, { list: imgPaths.value }) }

/* ---------------- 选择模式(批量移动 / 批量删除) ----------------
 * 交互: 工具栏「选择」进出; 选择模式下点击=勾选, Shift=区间选(按当前排序),
 * Ctrl+点击在浏览状态下也能直接勾(顺手进入选择模式); Ctrl+A 全选 / Esc 退出 /
 * Del 批量删除。选择集按 path 记, 排序/筛选变化不影响已勾的。
 * ( TvImageCard 自带 selectable/selected/勾选角标 —— 系列页选择模式同款。 ) */
const selectMode = ref(false)
const selected = ref(new Set())     // path 集合
const moving = ref(false)           // 批量移动进行中(锁弹窗与按钮)
const copyOpen = ref(false)         // 「复制到」目标选择弹窗(2026-10-16)
const copying = ref(false)          // 批量复制进行中
const moveOpen = ref(false)         // 目标选择弹窗
let lastSelIdx = -1                 // Shift 区间选的锚点(当前排序里的下标)

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.value = new Set()
  lastSelIdx = -1
  ui.toast(selectMode.value ? '☑ 选择模式: 点击勾选, Shift 区间, Ctrl+A 全选, Esc 退出' : '已退出选择模式', 'info', 1800)
}

function toggleSelect(it, ev) {
  const idx = sortedItems.value.findIndex((x) => x.path === it.path)
  if (ev?.shiftKey && lastSelIdx >= 0 && idx >= 0) {
    rangeTo(idx)
  } else {
    const s = new Set(selected.value)
    if (s.has(it.path)) s.delete(it.path)
    else s.add(it.path)
    selected.value = s
    lastSelIdx = idx
  }
}

/** 锚点 -> idx 的区间全部并入选中集(按当前排序; 卡片主体与勾选框共用) */
function rangeTo(idx) {
  const [a, b] = lastSelIdx < idx ? [lastSelIdx, idx] : [idx, lastSelIdx]
  const s = new Set(selected.value)
  for (let i = a; i <= b; i++) s.add(sortedItems.value[i].path)
  selected.value = s
}

function selectAll() {
  selected.value = new Set(sortedItems.value.map((it) => it.path))
}

function invertSel() {
  const s = new Set()
  for (const it of sortedItems.value) if (!selected.value.has(it.path)) s.add(it.path)
  selected.value = s
}

function clearSel() {
  selected.value = new Set()
  lastSelIdx = -1
}

/** 卡片点击的唯一入口( TvImageCard @open 把原生事件也带出来了 ):
 *  选择模式里点击=勾选(Shift=区间) / 浏览模式里 Ctrl=勾选并顺手进入选择模式。 */
function onCardClick(it, ev) {
  if (selectMode.value) {
    toggleSelect(it, ev)
    return
  }
  if (ev && (ev.ctrlKey || ev.metaKey)) {
    selectMode.value = true
    toggleSelect(it, ev)
    return
  }
  openImage(it)
}

/* ---------------- 批量删除(复用 useTrash: 确认弹窗显示 N 张, tv:trashed 联动剔除) ---------------- */
function batchDelete() {
  const paths = [...selected.value]
  if (!paths.length) return
  trash.request(paths).then((trashedList) => {
    // 删成的从选择集里摘掉, 失败的留着可以再试
    const done = new Set(trashedList || [])
    selected.value = new Set([...selected.value].filter((p) => !done.has(p)))
  })
}

/* ---------------- 批量移动 ---------------- */
function openMove() {
  if (!selected.value.size) { ui.warn('先勾选至少一张图'); return }
  moveOpen.value = true
}

async function doMove(target) {
  if (!target?.path || moving.value) return
  const paths = [...selected.value]
  moving.value = true
  try {
    const r = await api.moveImages(paths, target.path)
    if (r?.error) { ui.err('移动失败: ' + r.error); return }
    const movedFrom = (r.moved || []).map((m) => m.from)
    // 收藏跟随改写到新位置(与右键单张移动同款), 失败的不动
    for (const m of r.moved || []) fav.onMoved(m.from, m.to)
    if (movedFrom.length) {
      // 广播 tv:moved: 本页 onGone 把卡从网格剔除, 光箱把翻页序列同步掉
      window.dispatchEvent(new CustomEvent('tv:moved', { detail: { paths: movedFrom, dest: r.dest || '' } }))
    }
    if (r.failed?.length) ui.err(`${r.failed.length} 张移动失败(${r.failed[0]?.error || '未知原因'})`, 3600)
    if (movedFrom.length) ui.ok(`📤 已移动 ${movedFrom.length} 张到「${r.destName}」`, 'ok', 2600)
    if (r.sync?.started) ui.toast('后台正在把新位置入库并排队反推…', 'info', 2600)
    // 失败的留在选择集里, 成功的清掉; 弹窗关掉
    selected.value = new Set((r.failed || []).map((f) => f.path))
    moveOpen.value = false
  } catch (e) {
    ui.err('移动失败: ' + e.message)
  } finally {
    moving.value = false
  }
}

/* ---------------- 批量复制(原文件不动, 副本落目标目录; 不剔除卡片不改库) ---------------- */
function openCopy() {
  if (!selected.value.size) { ui.warn('先勾选至少一张图'); return }
  copyOpen.value = true
}

async function doCopy(target) {
  if (!target?.path || copying.value) return
  const paths = [...selected.value]
  copying.value = true
  try {
    const r = await api.copyImages(paths, target.path)
    if (r?.error) { ui.err('复制失败: ' + r.error); return }
    const done = (r.moved || []).length
    if (r.failed?.length) ui.err(`${r.failed.length} 张复制失败(${r.failed[0]?.error || '未知原因'})`, 3600)
    if (done) ui.ok(`📋 已复制 ${done} 张到「${r.destName}」`, 'ok', 2600)
    // 复制完就取消选中(2026-10-16 用户反馈: 复制后还挂着一片勾选, 不知道有没有生效)。
    // 副本落盘成功不代表这批要继续操作 —— 与批量移动同款语义: 失败的留着可重试。
    selected.value = new Set((r.failed || []).map((f) => f.path))
    copyOpen.value = false
  } catch (e) {
    ui.err('复制失败: ' + e.message)
  } finally {
    copying.value = false
  }
}

/** Esc 退出选择 / Ctrl+A 全选 / Del 批量删除 —— 只在本页、二级网格、非光箱时接管。
 *  ⚠️ 本视图在 KeepAlive 白名单里, 监听器卸载前一直在 —— 必须先判 route.name,
 *  否则在别的页面按 Esc/Ctrl+A 会被这里抢走。 */
function onScanKey(e) {
  if (route.name !== 'scan' || level.value !== 'folder') return
  if (lb.visible || moveOpen.value || copyOpen.value) return   // 光箱/弹窗自己管键盘
  if (!selectMode.value) return
  const k = e.key?.toLowerCase()
  if ((e.ctrlKey || e.metaKey) && k === 'a') {
    e.preventDefault()
    selectAll()
  } else if (e.key === 'Escape') {
    selectMode.value = false
    clearSel()
  } else if (e.key === 'Delete') {
    batchDelete()
  }
}

function gotoPage(p) {
  page.value = Math.max(1, Math.min(p, totalPages.value))
  document.querySelector('.scan-body .result-scroll')?.scrollTo({ top: 0 })
}

/* ---------------- 分页按钮 = 滚动定位(2026-10-16) ----------------
 * 网格是**累加式显示**(slice(0, page*pageSize), 滚到底自动追加), 旧版按钮只改
 * page 数字, 于是 ▶ 只是"多出一页可看"、◀ 把已显示的截掉一页(体感没反应),
 * ⏭ 最危险 —— 会把两万多张一次性全渲染, 直接假死。改成纯滚动语义:
 * 数据不动, 视口滚到"那一页开头"所在的行 —— 按钮说的和做的终于是一回事。 */
/** 每行第一张在 pagedItems 里的下标(与 scanRows 一一对应), 用来定位"第 n 张在哪一行" */
const rowStarts = computed(() => {
  const arr = []
  let acc = 0
  for (const row of scanRows.value) { arr.push(acc); acc += row.cells.length }
  return arr
})

function scrollToItemIndex(idx) {
  const grid = rowsEl.value
  if (!grid || idx < 0) return
  const starts = rowStarts.value
  let lo = 0, hi = starts.length - 1, row = 0
  while (lo <= hi) {                    // 二分: 最后一个 starts[row] <= idx 的行
    const mid = (lo + hi) >> 1
    if (starts[mid] <= idx) { row = mid; lo = mid + 1 } else hi = mid - 1
  }
  const el = grid.children[row]
  const scroller = el?.closest('.result-scroll')
  if (!el || !scroller) return
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 6
  scroller.scrollTo({ top: Math.max(0, top) })
}

/** 翻到第 p 页的开头: 内容还没加载就先补页(累加式只增不减), 再滚过去 */
function turnToPage(p) {
  const t = Math.max(1, Math.min(p, totalPages.value))
  if (t > page.value) page.value = t
  nextTick(() => scrollToItemIndex((t - 1) * pageSize.value))
}

/** ⏭: 滚到**已加载内容**的末尾 —— 绝不做"全量渲染到底", 两万张会假死 */
function scrollToLoadedEnd() {
  document.querySelector('.scan-body .result-scroll')?.scrollTo({ top: 1e9 })
}

const pageOptions = [60, 120, 240, 600]

/* ---------------- 滚到底自动加载下一页 ----------------
 * 网格尾部放一个哨兵元素, 进视口(提前 400px 预载)就自动 page+1。
 * 打开文件夹/改排序/改每页张数时 page 归 1, 哨兵跟着内容重新挂载。 */
const sentinel = ref(null)
let gridOb = null
function loadMore() {
  if (opening.value || page.value >= totalPages.value) return
  page.value++
}
watch([sortBy, pageSize], () => {
  prefs.sortScan = sortBy.value
  page.value = 1
  document.querySelector('.result-scroll')?.scrollTo({ top: 0 })
})
/* 改了筛选词也要回第一页并滚到顶 —— 否则会停在第 5 页对着一个空网格 */
watch(filterKw, () => {
  page.value = 1
  document.querySelector('.scan-body .result-scroll')?.scrollTo({ top: 0 })
})
/* 🛡 开关/档位一变, 文件夹列表要重拉: 封面是主进程按当前档位给的
   (封面图会被藏的文件夹直接不给 cover, 显示默认占位封面)。
   图片层(items)走 safety.filterItems 即时过滤, 不用重查。 */
watch(() => `${safety.on}|${safety.level}`, () => { loadFolders() })
watch(sentinel, (el) => {
  gridOb?.disconnect()
  if (!el) return
  gridOb = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) loadMore()
  }, { rootMargin: '400px 0px' })
  gridOb.observe(el)
})

/* ---------------- 删除/移动联动 ----------------
 * trash 成功后广播 'tv:trashed'、移动成功后广播 'tv:moved',
 * 这里把图从网格与统计里剔除;
 * Del 键删除只在 tag 详情页(光箱)处理。 */
function onGone(e) {
  const gone = new Set(e.detail?.paths || [])
  if (!gone.size || !result.value) return
  result.value.items = (result.value.items || []).filter((it) => !gone.has(it.path))
  result.value.total = Math.max(0, (result.value.total || 0) - gone.size)
  if (page.value > totalPages.value) page.value = totalPages.value
}

/* ---------------- 光箱关掉后回到上次那张 ----------------
 * 红色描边本身由 TvImageCard 读 lb.lastPath 自己画; 这里只解决扫描页特有的
 * 一个问题: 网格是**累加分页**, 用户在光箱里向后翻了很多张时, 高亮那张可能
 * 还没被 slice(0, page*pageSize) 渲染出来 —— 滚动就会扑空。
 * 收到 'tv:lb-closed' 后按下标一次性把 page 补齐到能包含它
 * (累加式显示不会让已加载的内容消失), 滚动由 store 里的 nextTick scrollIntoView 做。 */
function expandPageForPath(p) {
  if (!p || level.value !== 'folder') return false
  const idx = sortedItems.value.findIndex((it) => it.path === p)
  if (idx < 0) return false
  const need = Math.floor(idx / pageSize.value) + 1
  if (need > page.value) page.value = need
  return true
}

function onLbClosed(e) {
  expandPageForPath(e.detail?.path)
}

/* 二级(图片网格)是组件内部状态, 路由回退感知不到 ——
   浮动导航的「返回」在这里优先回到文件夹列表。
   必须先判"当前就在扫描页": 本视图在 keep-alive 白名单里, 处理器在切走之后
   还留在栈上(useFloatBack 只在真正卸载时注销), 不判的话在**别的页面**按返回
   会被它抢走 —— 表现为"在首页按返回, 结果扫描页的层级被清了一层"。 */
useFloatBack(() => {
  if (route.name !== 'scan') return false
  if (level.value !== 'folder') return false
  // 正在筛选时, 第一次按返回只清筛选(网格恢复全量), 再按一次才回文件夹列表
  if (filterKw.value) { filterKw.value = ''; return true }
  backToList()
  return true
})

/* 元数据解析进度: worker 在主进程之外解析, 进度推到渲染端画进度条。
   只在二级(文件夹内容)接收 —— 一级页的「添加文件夹」已有逐个文字进度。 */
const offScanProg = onPush('scan:progress', (p) => {
  if (level.value === 'folder') scanProg.value = p
})

/* 卡片统计后台刷新的进度/完成(2026-10-20) —— 每夹完成推一次, 防抖重拉列表 */
const offStatsPush = onPush('folders:stats', onStatsPush)

/* ---------------- 流式扫描合并(2026-10-16) ----------------
 * 大文件夹"扫到首批就能进": openFolder 先返回前 ~100 张(out.streaming=true),
 * 后台每解析完一批推 scan:partial(增量 items), 全部扫完推 scan:final(全量快照,
 * 统计/共享标签/尺寸都修正过)。合并按 path 去重 —— 重扫/重复推送是幂等的;
 * final 直接整体替换 result。换文件夹/返回列表后晚到的推送按 path 匹配挡掉。 */
const streaming = ref(false)
const streamInfo = ref(null)          // { done, total }
const streamPct = computed(() => {
  const s = streamInfo.value
  return s?.total ? Math.min(100, Math.round((s.done * 100) / s.total)) : 0
})

function sameFolder(a, b) {
  return !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

const offScanPartial = onPush('scan:partial', (p) => {
  if (!p?.folder || level.value !== 'folder' || !result.value) return
  if (!sameFolder(p.folder, cur.value?.path)) return
  const have = new Set(result.value.items.map((it) => it.path))
  const fresh = (p.items || []).filter((it) => !have.has(it.path))
  if (fresh.length) result.value.items.push(...fresh)
  streamInfo.value = { done: p.done, total: p.total }
})

const offScanFinal = onPush('scan:final', (out) => {
  if (!out?.folder || level.value !== 'folder' || !result.value) return
  if (!sameFolder(out.folder, cur.value?.path)) return
  result.value = out                  // 全量快照: 统计/共享标签/key_tags/尺寸全部修正
  streaming.value = false
  streamInfo.value = null
  fillScanZh(out)                     // 流式期间新出现的标签补中文映射
})

onMounted(() => {
  loadFolders()
  window.addEventListener('tv:trashed', onGone)
  window.addEventListener('tv:moved', onGone)
  window.addEventListener('tv:lb-closed', onLbClosed)
  window.addEventListener('keydown', onScanKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('tv:trashed', onGone)
  window.removeEventListener('tv:moved', onGone)
  window.removeEventListener('tv:lb-closed', onLbClosed)
  window.removeEventListener('keydown', onScanKey)
  offScanProg()
  offScanPartial()
  offScanFinal()
  offStatsPush()
  clearTimeout(statsReloadTimer)
  gridOb?.disconnect()
})

/* ---------------- keep-alive: 切走再切回, 停在离开时的滚动位置 ----------------
 * App.vue 的 KeepAlive 白名单原来不含 ScanView —— 首页/系列/标签切回来都还在
 * 原地, 唯独扫描页被整个卸载, 回来只剩文件夹列表(2026-09-19 用户反馈)。
 * 现在 ScanView 进了白名单, 组件状态(打开的文件夹/分页/排序)自动保留;
 * 唯一要手动管的是滚动位置: DOM 被摘下来再插回去, scrollTop 会归零。
 * 存的时刻用路由离开守卫(onBeforeRouteLeave) —— onDeactivated 触发时 DOM 已经
 * 被 KeepAlive 摘离 document, querySelector 会扑空。 */
let savedScroll = { list: 0, folder: 0 }
onBeforeRouteLeave(() => {
  const box = document.querySelector(level.value === 'folder' ? '.scan-body .result-scroll' : '.list-panel')
  if (box) savedScroll[level.value] = box.scrollTop
})
/* 首次激活是紧跟在 onMounted 之后的(KeepAlive 组件的正常行为) —— 那时列表刚加载过,
   再查一次纯属白跑, 用一个开关跳过它。 */
let firstActivate = true
onActivated(() => {
  nextTick(() => {
    const sel = level.value === 'folder' ? '.scan-body .result-scroll' : '.list-panel'
    const box = document.querySelector(sel)
    const top = savedScroll[level.value] || 0
    if (box && top) box.scrollTo({ top })
  })
  /* 「切回来要刷新列表」—— KeepAlive 保住了状态, 代价是 **onMounted 一辈子只跑一次**。
   * 而这份列表的上游( folders 登记表 )现在是**来源页与扫描页共用的一张表**: 在来源页
   * 把某个目录勾成「扫描夹」、或者在那边「移出/恢复」, 回到扫描页看到的还是老清单 ——
   * 用户会以为"加了没用"(2026-09-23 实测: e2e 里先改开关再切回来, 页面压根没刷新)。
   * loadFolders() 是整体替换 folders.value, 不会重复追加, 也不动 level/分页/滚动,
   * 所以每次激活重查一遍是安全的; 代价只有一条 folders:list 查询。 */
  if (firstActivate) { firstActivate = false; kickStatsRefresh(); return }
  loadFolders()
  if (level.value === 'list') kickStatsRefresh()
})
</script>

<template>
  <div class="scan-view">
    <!-- 来源管理的入口(2026-10-04 从顶栏挪来; 2026-10-16 改为只在一级列表页显示:
         原先绝对定位右上角, 和二级文件夹详情的「← 返回」按钮重叠(用户截图反馈)。
         二级视图里改并入头部按钮行, 见下面 head 里的那份)。 -->
    <RouterLink
      v-if="level === 'list'"
      to="/sources"
      class="to-sources"
      data-test="goto-sources"
      title="文件夹登记表: 登记来源/扫描夹、开关用途、追平"
    >🗄️ 来源管理</RouterLink>

    <!-- ==================== 一级: 文件夹库 ==================== -->
    <template v-if="level === 'list'">
      <div class="panel bar-panel">
        <h2>📂 扫描文件夹</h2>
        <div class="tip">
          加入过的文件夹会一直留在这里, 下次点开即用(不用重新选目录)。<br>
          支持 ComfyUI / A1111 / NovelAI / InvokeAI 生成图的 png 元数据。<br>
          <b>与「看板」的分工</b>: 这里按<b>磁盘文件夹</b>浏览全部图片(含未入库的), 负责就地整理文件
          (移动 / 复制 / 删除 / 打标); 已入库图片的标签搜索 / 组词 / 导出标签去「看板」。
        </div>

        <!-- 反推环境不全: 常驻一条可操作的引导(点开是三步装法), 不是干瘪的"已跳过" -->
        <div v-if="taggerMissing" class="tagger-warn">
          ⚠️ 自动打标(WD14 反推)没有就绪<template v-if="taggerMissingText">：缺 {{ taggerMissingText }}</template>
          —— <a href="#" @click.prevent="openTaggerSetup">看看怎么装</a>
        </div>

        <div class="bar">
          <TvButton variant="primary" :loading="adding" @click="addByPicker">
            📁 添加文件夹(可多选)
          </TvButton>
          <div class="path">
            <!-- path-check-ignore: 下面这行是给用户看的输入示例, 不是真实的机器路径 -->
            <TvInput
              v-model="manual"
              placeholder="或粘贴文件夹路径后回车, 例如 D:\图片\我的图库"
              @enter="addManual"
            />
          </div>
          <TvCheckbox v-model="recursive" label="含子文件夹" />
        </div>

        <div v-if="addProgress" class="progress">⏳ {{ addProgress }}</div>

        <div class="bar2">
          <TvInput v-model="kw" size="sm" placeholder="🔍 过滤文件夹(名字 / 路径)" class="kw" />
          <!-- 也放在这里一份: 图要"进了文件夹"才看得到, 但开关不该被藏在里面 -->
          <TvSafetyToggle />
          <TvButton size="sm" variant="secondary" :loading="loadingList" @click="loadFolders">🔄 刷新列表</TvButton>
          <span v-if="statsRefresh" class="stats-refresh" title="逐个文件夹增量对账, 卡片张数自动对齐磁盘现状">⏳ 统计对账中 {{ statsRefresh.done }}/{{ statsRefresh.total }}</span>
        </div>

        <div v-if="listError" class="err">读取列表失败: {{ listError }}</div>
      </div>

      <div class="panel list-panel">
        <TvState v-if="loadingList && !folders.length" state="loading" text="正在读取文件夹列表..." />
        <TvState
          v-else-if="!folders.length"
          state="empty"
          text="还没有加入任何文件夹 —— 点上面的「添加文件夹」开始"
        />
        <TvState
          v-else-if="!shownFolders.length"
          state="empty"
          :text="`没有匹配「${kw.trim()}」的文件夹`"
        />
        <div v-else class="grid folders">
          <TvEntityCard
            v-for="f in shownFolders"
            :key="f.path"
            :title="f.name"
            :subtitle="f.path"
            :thumb="f.cover"
            :images="f.stats?.total || 0"
            :characters="null"
            :badge="f.exists ? (f.stats ? `${f.stats.distinct_prompts} 种提示词` : '待扫描') : '路径失效'"
            :badge-tone="f.exists ? 'ok' : 'warn'"
            :dim="!f.exists"
            :thumb-width="300"
            @open="openFolder(f)"
          >
            <div class="fmeta">
              <span>含提示词 {{ nfmt(f.stats?.with_prompt || 0) }}</span>
              <span v-if="f.stats?.shared_count">· 共用 {{ f.stats.shared_count }}</span>
            </div>
            <!-- 上面那行是「**图里**嵌了多少提示词」(扫描页的图是库外图片, 标签现场
                 从 PNG 元数据解析); 这一行是「**库里**存了多少张 / 其中多少张来自 WD14
                 反推」。两个"标签"不是一回事 —— 表世界那批裸图图内元数据是 0, 反推却
                 实打实跑了 2970 张。少了这行, 反推跑完扫描页看着还像"没有标签"。 -->
            <div v-if="f.images" class="fmeta">
              <span>库内 {{ nfmt(f.images) }} 张</span>
              <span v-if="f.tagged">· 已反推 {{ nfmt(f.tagged) }}</span>
            </div>
            <div class="fmeta faint">上次扫描 {{ fmtTime(f.last_scan) }}</div>
            <div class="fbtns">
              <button v-if="renaming !== f.path" title="重命名显示名" @click.stop="renameFolder(f)">✏️</button>
              <span v-else class="rename-box">
                <TvInput
                  v-model="renamingInput"
                  size="sm"
                  placeholder="显示名(留空 = 文件夹名)"
                  @enter="renameFolder(f)"
                />
                <button class="mini" title="确定" @click.stop="renameFolder(f)">✓</button>
                <button class="mini" title="取消" @click.stop="renaming = ''; renamingInput = ''">✕</button>
              </span>
              <button title="从列表移除(不删文件)" @click.stop="removeFolder(f)">🗑</button>
            </div>
          </TvEntityCard>
        </div>
      </div>
    </template>

    <!-- ==================== 二级: 文件夹里的图片 ==================== -->
    <template v-else>
      <div class="panel bar-panel">
        <div class="head">
          <div class="crumb">
            <span class="link" @click="backToList">全部文件夹</span>
            <span class="sep">&gt;</span>
            <span class="now">{{ cur?.name || '' }}</span>
          </div>
          <span class="spacer" />
          <TvButton
            size="sm"
            :variant="selectMode ? 'primary' : 'secondary'"
            data-test="scan-select-toggle"
            @click="toggleSelectMode"
          >
            ☑ {{ selectMode ? '退出选择' : '选择' }}
          </TvButton>
          <TvButton size="sm" variant="secondary" :loading="rescanning" @click="openFolder(cur, { refresh: true })">
            🔄 重扫这个文件夹
          </TvButton>
          <RouterLink
            to="/sources"
            class="to-sources-inline"
            data-test="goto-sources-folder"
            title="文件夹登记表: 登记来源/扫描夹、开关用途、追平"
          >🗄️ 来源管理</RouterLink>
          <TvButton size="sm" variant="secondary" @click="backToList">← 返回</TvButton>
        </div>

        <div class="path-line" :title="cur?.path">{{ cur?.path }}</div>

        <!-- 流式扫描的后台进度(2026-10-16): 不挡网格, 一行小字 + 细条, 扫完自动消失 -->
        <div v-if="streaming" class="stream-line" data-test="scan-stream-line">
          <span class="sp-mini"><span class="sp-fill" :style="{ width: streamPct + '%' }" /></span>
          <span>后台扫描中 <b>{{ nfmt(streamInfo?.done ?? rawItems.length) }}</b> / {{ nfmt(streamInfo?.total || 0) }} 张 · 完成前标签筛选只覆盖已扫描的部分</span>
        </div>

        <div v-if="error" class="err">{{ error }}</div>
      </div>

      <div class="panel result scan-body">
        <TvState
          v-if="opening"
          state="loading"
          :text="scanProg ? `${scanProg.phase === 'dims' ? '正在读取图片尺寸' : '正在扫描元数据'} ${scanProg.done} / ${scanProg.total} (${scanPct}%)` : '正在扫描并读取元数据, 请稍候...'"
        />
        <div v-if="opening && scanProg" class="scan-prog">
          <div class="sp-bar"><div class="sp-fill" :style="{ width: scanPct + '%' }" /></div>
        </div>
        <TvState v-else-if="!opening && !rawItems.length" state="empty" text="没有可显示的图片" />
        <template v-else>
          <!-- 批量操作条: 选择模式下出现(置顶常驻, 滚动也看得见) -->
          <div v-if="selectMode" class="batch-bar" data-test="scan-batch-bar">
            <span class="bcnt">已选 <b data-test="scan-sel-count">{{ selected.size }}</b> 张</span>
            <TvButton size="sm" variant="ghost" data-test="scan-sel-all" @click="selectAll">全选</TvButton>
            <TvButton size="sm" variant="ghost" data-test="scan-sel-invert" @click="invertSel">反选</TvButton>
            <TvButton size="sm" variant="ghost" :disabled="!selected.size" data-test="scan-sel-clear" @click="clearSel">清空</TvButton>
            <TvButton size="sm" variant="ghost" data-test="scan-batch-exit" title="退出选择模式(同时清空已选)" @click="toggleSelectMode">✕ 退出</TvButton>
            <span class="spacer" />
            <TvButton
              size="sm"
              variant="primary"
              :disabled="!selected.size"
              :loading="moving"
              data-test="scan-batch-move"
              @click="openMove"
            >📤 移动到…</TvButton>
            <TvButton
              size="sm"
              variant="secondary"
              :disabled="!selected.size"
              :loading="copying"
              data-test="scan-batch-copy"
              @click="openCopy"
            >📋 复制到…</TvButton>
            <TvButton
              size="sm"
              variant="danger"
              :disabled="!selected.size"
              data-test="scan-batch-trash"
              @click="batchDelete"
            >🗑 删除</TvButton>
          </div>

          <!-- 工具条挪到滚动区**外**(2026-10-16 用户反馈: 往下拉图片, 搜索框那排就看不见了)
               与批量条同款结构性常驻 —— 滚动只发生在 .result-scroll 里, 工具条天生钉在顶上 -->
          <div class="pager-bar">
            <!-- 按标签 / 文件名筛选: 复用首页/标签页那个带补全的搜索框, 但补全走**本夹的标签池**
                 (扫描图是库外的, 它们的标签在标签库里可能根本不存在; 文件名压根不在标签库里)。
                 multi 胶囊模式(2026-10-16): 敲逗号定格成胶囊、继续输入时补全针对下一个词 ——
                 与看板搜索框同款; 空格分隔的 AND 老用法照旧(两种都认)。
                 历史也走**自己那份键**: 这里是"筛过的词", 首页那边是"敲过的查询",
                 混着存两边都会变脏(见 utils/lskey.js 的 searchHistoryScan)。 -->
            <div class="tag-filter">
              <TvTagSuggestInput
                v-model="filterKw"
                size="sm"
                multi
                :local-tags="scanTagPool"
                :limit="14"
                history
                remember
                :history-key="SCAN_HIST_KEY"
                history-label="扫描页筛选历史"
                placeholder="🔍 按标签 / 文件名筛选(空格或逗号分隔多个)"
                empty-text="没有匹配的标签(文件名仍会匹配)"
              />
            </div>
            <TvButton v-if="filterKw" size="sm" variant="ghost" title="清除筛选" @click="filterKw = ''">✕ 清除</TvButton>
            <span class="hint">
              <template v-if="filterTokens.length">筛选出 <b class="hit">{{ nfmt(sortedItems.length) }}</b> / 共 {{ nfmt(rawItems.length) }} 张</template>
              <template v-else-if="streaming">已加载 {{ nfmt(pagedItems.length) }} / {{ nfmt(streamInfo?.total || rawItems.length) }} 张 · 后台扫描 {{ streamPct }}%</template>
              <template v-else>已加载 {{ nfmt(pagedItems.length) }} / 共 {{ nfmt(sortedItems.length) }} 张 · 滚到底自动加载</template>
            </span>
            <span class="spacer" />
            <TvSafetyToggle :counts="scanHits" />
            <TvSelect
              v-model="sortBy"
              size="sm"
              inline
              label="排序"
              :options="SORT_OPTIONS"
            />
            <TvSelect
              v-model="pageSize"
              size="sm"
              inline
              label="每页"
              :options="pageOptions.map((n) => ({ value: n, label: String(n) }))"
            />
            <!-- 分页按钮 = 滚动定位(2026-10-16): 网格是累加式显示, 旧版改页码数字
                 的做法让 ▶ 看起来"只是变多"、◀ 像没反应、⏭ 更会全量渲染假死。
                 现在按钮只管把视口滚到对应位置, 数据(累加)不动。 -->
            <TvButton size="sm" variant="ghost" title="回到第一页(从头开始看)" @click="gotoPage(1)">⏮</TvButton>
            <TvButton size="sm" variant="ghost" :disabled="page <= 1" title="滚到上一页的开头" @click="turnToPage(page - 1)">◀</TvButton>
            <TvButton size="sm" variant="ghost" :disabled="page >= totalPages" title="翻到下一页的开头(自动加载那一页)" @click="turnToPage(page + 1)">▶</TvButton>
            <TvButton size="sm" variant="ghost" title="滚到已加载内容的末尾(不会一次性渲染全部)" @click="scrollToLoadedEnd">⏭</TvButton>
          </div>

          <!-- 滚动只发生在这一层: 上面两排工具条都在滚动区外, 常驻顶上 -->
          <div class="result-scroll">

          <TvState
            v-if="!sortedItems.length"
            state="empty"
            :text="`这个文件夹里没有匹配「${filterKw.trim()}」的图片(标签或文件名)`"
          />

          <div v-else ref="rowsEl" class="grid imgs jrows" @wheel="onGridWheel">
            <div v-for="(row, ri) in scanRows" :key="ri" class="jrow">
              <div
                v-for="(c, ci) in row.cells"
                :key="c.item.path || ci"
                class="jcell"
                :style="{ width: `${c.w}px`, '--img-h': `${row.h}px` }"
              >
                <TvImageCard
                  :item="c.item"
                  fill
                  :thumb-width="400"
                  show-source
                  tag-mode="keys"
                  :tag-zh-map="scanZh"
                  footnote="name"
                  :tip-limit="24"
                  :selectable="selectMode"
                  :selected="selected.has(c.item.path)"
                  @open="onCardClick"
                  @toggle-select="toggleSelect"
                  @hover="({ text, event }) => ui.showTip(text, event)"
                  @move="ui.moveTip"
                  @leave="ui.hideTip"
                />
              </div>
            </div>
          </div>
          <!-- Ctrl+滚轮缩放提示徽标: 停手即淡出, 点击恢复 100% -->
          <TvZoomBadge :zoom="gridZoom" :show="zoomFlash" @reset="resetGridZoom" />
          <!-- 无限滚动哨兵: 进入视口(提前 400px)自动追加下一页 -->
          <div v-if="page < totalPages" ref="sentinel" class="load-sentinel">
            <span class="hint">加载中...</span>
          </div>
          </div>
        </template>
      </div>


      <MoveTargetModal
        v-model="moveOpen"
        :count="selected.size"
        :folders="folders"
        :busy="moving"
        @pick="doMove"
      />
      <MoveTargetModal
        v-model="copyOpen"
        mode="copy"
        :count="selected.size"
        :folders="folders"
        :busy="copying"
        @pick="doCopy"
      />
    </template>
  </div>
</template>

<style scoped>
.scan-view {
  position: relative;
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}
.bar-panel { flex: 0 0 auto; padding: 14px; }
.bar-panel h2 { font-size: 16px; margin-bottom: 6px; }
.tip { color: var(--muted); font-size: 12px; line-height: 1.7; margin-bottom: 12px; }

.bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.bar2 { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.path { flex: 1; min-width: 260px; }
.kw { max-width: 320px; }
.progress { color: var(--accent2); font-size: 12px; margin-top: 8px; }
.stats-refresh { color: var(--muted); font-size: 12px; }
/* 反推未就绪的常驻引导条: 警示但不吓人, 入口("看看怎么装")才是重点 */
.tagger-warn {
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px dashed var(--warn, var(--accent));
  border-radius: var(--r-md, 8px);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.tagger-warn a { color: var(--accent); font-weight: 600; }

.info { color: var(--muted); font-size: 12px; margin-top: 10px; line-height: 1.7; }
.info b { color: var(--accent2); }
.path-line { color: var(--faint); font-size: 11px; word-break: break-all; margin-top: 6px; }
.warn-box {
  margin-top: 6px; color: var(--warn);
  background: var(--warn-soft); border-radius: var(--r-sm); padding: 6px 9px;
}
.shared { margin-top: 6px; }
.faint { opacity: .85; color: var(--faint); }
.hint-line { margin-top: 6px; }
.err { color: var(--danger); font-size: 12px; margin-top: 10px; }

.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/* 二级视图头部里的「来源管理」入口: 观感对齐 TvButton secondary(顶栏链接同款 pill) */
.to-sources-inline {
  font-size: 12px; text-decoration: none; line-height: 1;
  color: var(--text); background: var(--panel2);
  border: 1px solid var(--border); border-radius: var(--r-pill);
  padding: 6px 12px;
}
.to-sources-inline:hover { color: var(--accent); border-color: var(--accent); }
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .link { color: var(--accent); cursor: pointer; }
.crumb .link:hover { text-decoration: underline; }
.crumb .now { color: var(--text); }
.crumb .sep { color: var(--faint); }
.spacer { flex: 1 1 auto; }

.list-panel { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }
.result { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 14px; display: flex; flex-direction: column; }
/* 滚动层: 工具条在这层外面, 常驻顶上 */
.result-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

.pager-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.pager-bar .hint { color: var(--muted); font-size: 12px; }
/* 筛选框: 可伸缩但别把右边的排序/分页挤走 */
.pager-bar .tag-filter { flex: 1 1 300px; max-width: 360px; margin-right: 4px; }
.pager-bar .hit { color: var(--accent); font-size: 13px; }

/* 批量操作条(选择模式) —— 放在滚动区**外**的结构性常驻: .result 是不滚的 flex 列,
   滚动只发生在 .result-scroll 里 —— 工具条天生钉在顶上, 连 sticky 都不用
   (sticky 在带 padding 的滚动容器里钉住后会露出一条缝, 10-01 用户截图实锤, 弃用)。 */
.batch-bar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 0 0 12px; padding: 7px 10px;
  border-radius: var(--r-sm); background: var(--panel3);
  border: 1px solid var(--accent-soft, transparent);
}
.batch-bar .bcnt { font-size: 12px; color: var(--muted); margin-right: 4px; }
.batch-bar .bcnt b { color: var(--accent); font-size: 14px; }

.load-sentinel { display: flex; justify-content: center; padding: 18px 0; }

/* 扫描元数据进度条(opening 期间, worker 解析进度) */
.scan-prog { max-width: 420px; margin: 0 auto 14px; }
.sp-bar {
  height: 6px; border-radius: 999px;
  background: var(--panel3); overflow: hidden;
}
.sp-fill {
  height: 100%; border-radius: 999px;
  background: var(--accent);
  transition: width .2s ease;
}

/* 流式扫描的后台进度行(head 里, 不挡网格; 扫完 v-if 收掉) */
.stream-line {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; color: var(--muted); font-size: 11px;
}
.stream-line b { color: var(--accent); }
.sp-mini {
  display: inline-block; width: 120px; height: 4px; flex: none;
  border-radius: 999px; background: var(--panel3); overflow: hidden;
}
.sp-mini .sp-fill { display: block; height: 100%; background: var(--accent); transition: width .2s ease; }

/* 只给**文件夹卡**用 —— 图片网格已经换成自适应行高(`.grid.imgs.jrows`, 见 tokens.css)。
 * 原来这里有一条裸 `.grid` 规则, 与 tokens.css 的 `.grid.jrows` 撞车: 两条选择器权重
 * 相同(本文件的 scoped 样式会带一个属性选择器), 谁生效只看打包顺序 —— 那是个隐蔽的
 * 定时炸弹, 所以直接改名, 让图片网格只有一处定义。 */
.grid.folders {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  align-content: start;
}

.fmeta { display: flex; gap: 6px; font-size: 10px; color: var(--muted); padding: 0 8px; }
.fbtns {
  position: absolute; top: 6px; right: 6px; z-index: 6;
  display: flex; gap: 4px; opacity: 0;
  transition: opacity var(--t-fast);
}
/* 卡片右上角的 ✏️/🗑: 悬停卡片才出现(slot 内容带父组件 scope id, 所以可以直接用 :deep 选到卡) */
:deep(.ecard:hover) .fbtns { opacity: 1; }
.fbtns button {
  width: 26px; height: 26px; border-radius: 6px;
  background: rgba(10, 13, 18, .78); color: #fff; font-size: 12px;
}
.fbtns button:hover { background: var(--accent); }
/* 就地改名(不用 window.prompt, 见 renameFolder 注释) */
.to-sources {
  position: absolute; top: 10px; right: 14px; z-index: 3;
  font-size: 12px; text-decoration: none;
  color: var(--muted); background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--r-pill);
  padding: 3px 12px;
}
.to-sources:hover { color: var(--accent); border-color: var(--accent); }
.rename-box { display: inline-flex; align-items: center; gap: 4px; width: 100%; }
.rename-box :deep(.tv-field) { flex: 1; min-width: 0; }
.mini {
  width: 22px; height: 22px; border-radius: 5px; flex: none;
  background: var(--panel2); color: var(--text);
  border: 1px solid var(--border); font-size: 11px; line-height: 1;
}
.mini:hover { background: var(--accent); color: var(--on-accent); }
</style>
