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
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, nextTick } from 'vue'
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
import { useFloatBack } from '@/composables/useFloatBack.js'
import { api, onPush } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'
import { LS } from '@/utils/lskey.js'

/** 扫描页筛选历史的键 —— 与首页那份公用历史分开存(见 utils/lskey.js 的 searchHistoryScan) */
const SCAN_HIST_KEY = LS.searchHistoryScan.key

const lb = useLightboxStore()
const ui = useUiStore()
const route = useRoute()

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
const sortBy = ref('name')
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

/* ---------------- 标签筛选 ----------------
 * 扫描页的图是**库外图片**(标签从 PNG 元数据现场解析), 所以筛选只能在前端做,
 * 而且筛选条件本身也得来自这一批图 —— 搜索框的补全用当前文件夹的标签池,
 * **不查标签库**(扫描夹特有的标签在库里可能根本不存在, 查了也补不出来)。
 *
 * 匹配规则: 空格分隔多个词 = AND(每个词都得命中)。
 * 单个词用**子串**匹配而非精确 —— 扫描出的角色标签带括号后缀,
 * 输入 hoshino 要能命中 hoshino_(blue_archive)。 */
const tagKw = ref('')
const tagTokens = computed(() => tagKw.value.trim().toLowerCase().split(/\s+/).filter(Boolean))

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
  const tk = tagTokens.value
  if (tk.length) {
    arr = arr.filter((it) => {
      const ts = it.tags || []
      return tk.every((w) => ts.some((t) => t.toLowerCase().includes(w)))
    })
  }
  if (sortBy.value === 'name_desc') arr.sort((a, b) => b.name.localeCompare(a.name))
  else if (sortBy.value === 'folder') arr.sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name))
  else arr.sort((a, b) => a.name.localeCompare(b.name))
  return arr
})

const totalPages = computed(() => Math.max(1, Math.ceil(sortedItems.value.length / pageSize.value)))
/* 累加式显示: 显示到第 page 页为止的全部内容(不是只显示这一页)。
 * 滚到底自动 page+1 追加下一页, 已看过的内容不消失、滚动位置不跳。 */
const pagedItems = computed(() => sortedItems.value.slice(0, page.value * pageSize.value))
/** 光箱翻页用全量顺序(不只当前页) */
const imgPaths = computed(() => sortedItems.value.map((it) => it.path))

/* 网格顺序变了(删除/移动联动剔除、改排序)就同步给光箱 —— 与首页 / 系列 / 标签三页一致。
 * 少了这一步, 光箱里那份 list 就只是"打开那一刻的快照": 网格已经把某张剔掉了,
 * 光箱还把它算在翻页序列里, 于是往后翻会翻到一张已经不在网格里的幽灵图。
 * (「删掉当前这张就前进」由 useLightboxStore 订阅 tv:trashed / tv:moved 自己负责,
 *  这里管的是另外那种情况: 被剔掉的是**别的**图。) */
watch(imgPaths, (arr) => { if (lb.visible) lb.setList(arr) })

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

async function renameFolder(f) {
  const next = window.prompt('显示名(留空 = 用文件夹名)', f.label || '')
  if (next === null) return
  try {
    const r = await api.updateFolder({ path: f.path, label: next.trim() })
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

/** 打开文件夹(有缓存就是秒开) */
async function openFolder(f, { refresh = false } = {}) {  if (!f.exists) { ui.warn('这个文件夹已经不在了(可能被移动或改名)'); return }
  cur.value = f
  level.value = 'folder'
  opening.value = true
  scanProg.value = null
  if (refresh) rescanning.value = true
  error.value = ''
  if (refresh) result.value = null
  page.value = 1
  tagKw.value = ''      // 换了文件夹就是换了一批标签, 上一次的筛选词没有意义了
  try {
    const d = await api.openFolder({ path: f.path, refresh })
    if (d?.error) { error.value = d.error; result.value = null; return }
    result.value = d
    fillScanZh(d)
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
  level.value = 'list'
  cur.value = null
  result.value = null
  error.value = ''
}

function openImage(it) { lb.open(it.path, { list: imgPaths.value }) }

function gotoPage(p) {
  page.value = Math.max(1, Math.min(p, totalPages.value))
  document.querySelector('.scan-body')?.scrollTo({ top: 0 })
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
  page.value = 1
  document.querySelector('.result')?.scrollTo({ top: 0 })
})
/* 改了筛选词也要回第一页并滚到顶 —— 否则会停在第 5 页对着一个空网格 */
watch(tagKw, () => {
  page.value = 1
  document.querySelector('.scan-body')?.scrollTo({ top: 0 })
})
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
  if (tagKw.value) { tagKw.value = ''; return true }
  backToList()
  return true
})

/* 元数据解析进度: worker 在主进程之外解析, 进度推到渲染端画进度条。
   只在二级(文件夹内容)接收 —— 一级页的「添加文件夹」已有逐个文字进度。 */
const offScanProg = onPush('scan:progress', (p) => {
  if (level.value === 'folder') scanProg.value = p
})

onMounted(() => {
  loadFolders()
  window.addEventListener('tv:trashed', onGone)
  window.addEventListener('tv:moved', onGone)
  window.addEventListener('tv:lb-closed', onLbClosed)
})
onBeforeUnmount(() => {
  window.removeEventListener('tv:trashed', onGone)
  window.removeEventListener('tv:moved', onGone)
  window.removeEventListener('tv:lb-closed', onLbClosed)
  offScanProg()
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
  const box = document.querySelector(level.value === 'folder' ? '.scan-body' : '.list-panel')
  if (box) savedScroll[level.value] = box.scrollTop
})
/* 首次激活是紧跟在 onMounted 之后的(KeepAlive 组件的正常行为) —— 那时列表刚加载过,
   再查一次纯属白跑, 用一个开关跳过它。 */
let firstActivate = true
onActivated(() => {
  nextTick(() => {
    const sel = level.value === 'folder' ? '.scan-body' : '.list-panel'
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
  if (firstActivate) { firstActivate = false; return }
  loadFolders()
})
</script>

<template>
  <div class="scan-view">
    <!-- ==================== 一级: 文件夹库 ==================== -->
    <template v-if="level === 'list'">
      <div class="panel bar-panel">
        <h2>📂 扫描文件夹</h2>
        <div class="tip">
          加入过的文件夹会一直留在这里, 下次点开即用(不用重新选目录)。<br>
          支持 ComfyUI / A1111 / NovelAI / InvokeAI 生成图的 png 元数据。
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
          <TvButton size="sm" variant="secondary" :loading="loadingList" @click="loadFolders">🔄 刷新列表</TvButton>
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
              <button title="重命名显示名" @click.stop="renameFolder(f)">✏️</button>
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
          <TvButton size="sm" variant="secondary" :loading="rescanning" @click="openFolder(cur, { refresh: true })">
            🔄 重扫这个文件夹
          </TvButton>
          <TvButton size="sm" variant="secondary" @click="backToList">← 返回</TvButton>
        </div>

        <div class="path-line" :title="cur?.path">{{ cur?.path }}</div>

        <div v-if="error" class="err">{{ error }}</div>
      </div>

      <div class="panel result scan-body">
        <TvState
          v-if="opening"
          state="loading"
          :text="scanProg ? `正在扫描元数据 ${scanProg.done} / ${scanProg.total} (${scanPct}%)` : '正在扫描并读取元数据, 请稍候...'"
        />
        <div v-if="opening && scanProg" class="scan-prog">
          <div class="sp-bar"><div class="sp-fill" :style="{ width: scanPct + '%' }" /></div>
        </div>
        <TvState v-else-if="!opening && !rawItems.length" state="empty" text="没有可显示的图片" />
        <template v-else>
          <div class="pager-bar">
            <!-- 按标签筛选: 复用首页/标签页那个带补全的搜索框, 但补全走**本夹的标签池**
                 (扫描图是库外的, 它们的标签在标签库里可能根本不存在)。
                 历史也走**自己那份键**: 这里是"筛过的标签", 首页那边是"敲过的查询",
                 混着存两边都会变脏(见 utils/lskey.js 的 searchHistoryScan)。 -->
            <div class="tag-filter">
              <TvTagSuggestInput
                v-model="tagKw"
                size="sm"
                :local-tags="scanTagPool"
                :limit="14"
                history
                remember
                :history-key="SCAN_HIST_KEY"
                history-label="扫描页筛选历史"
                placeholder="🔍 按标签筛选(空格分隔多个)"
              />
            </div>
            <TvButton v-if="tagKw" size="sm" variant="ghost" title="清除筛选" @click="tagKw = ''">✕ 清除</TvButton>
            <span class="hint">
              <template v-if="tagTokens.length">筛选出 <b class="hit">{{ nfmt(sortedItems.length) }}</b> / 共 {{ nfmt(rawItems.length) }} 张</template>
              <template v-else>已加载 {{ nfmt(pagedItems.length) }} / 共 {{ nfmt(sortedItems.length) }} 张 · 滚到底自动加载</template>
            </span>
            <span class="spacer" />
            <TvSelect
              v-model="sortBy"
              size="sm"
              inline
              label="排序"
              :options="[
                { value: 'name', label: '文件名 A-Z' },
                { value: 'name_desc', label: '文件名 Z-A' },
                { value: 'folder', label: '按子文件夹' },
              ]"
            />
            <TvSelect
              v-model="pageSize"
              size="sm"
              inline
              label="每页"
              :options="pageOptions.map((n) => ({ value: n, label: String(n) }))"
            />
            <TvButton size="sm" variant="ghost" :disabled="page <= 1" @click="gotoPage(1)">⏮</TvButton>
            <TvButton size="sm" variant="ghost" :disabled="page <= 1" @click="gotoPage(page - 1)">◀</TvButton>
            <TvButton size="sm" variant="ghost" :disabled="page >= totalPages" @click="gotoPage(page + 1)">▶</TvButton>
            <TvButton size="sm" variant="ghost" :disabled="page >= totalPages" @click="gotoPage(totalPages)">⏭</TvButton>
          </div>

          <TvState
            v-if="!sortedItems.length"
            state="empty"
            :text="`这个文件夹里没有图片匹配「${tagKw.trim()}」`"
          />

          <div v-else class="grid imgs">
            <TvImageCard
              v-for="it in pagedItems"
              :key="it.path"
              :item="it"
              :thumb-width="400"
              show-source
              tag-mode="keys"
              :tag-zh-map="scanZh"
              footnote="name"
              :tip-limit="24"
              @open="openImage"
              @hover="({ text, event }) => ui.showTip(text, event)"
              @move="ui.moveTip"
              @leave="ui.hideTip"
            />
          </div>
          <!-- 无限滚动哨兵: 进入视口(提前 400px)自动追加下一页 -->
          <div v-if="page < totalPages" ref="sentinel" class="load-sentinel">
            <span class="hint">加载中...</span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scan-view {
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
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .link { color: var(--accent); cursor: pointer; }
.crumb .link:hover { text-decoration: underline; }
.crumb .now { color: var(--text); }
.crumb .sep { color: var(--faint); }
.spacer { flex: 1 1 auto; }

.list-panel { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }
.result { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }

.pager-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.pager-bar .hint { color: var(--muted); font-size: 12px; }
/* 筛选框: 可伸缩但别把右边的排序/分页挤走 */
.pager-bar .tag-filter { flex: 1 1 300px; max-width: 360px; margin-right: 4px; }
.pager-bar .hit { color: var(--accent); font-size: 13px; }
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

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min), 1fr));
  gap: 10px;
  align-content: start;
}
.grid.folders { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }

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
</style>
