<script setup>
/**
 * 看板(首页) —— 原 index.html
 * ==========================
 * 左栏: 来源筛选 + 筛选表单 + 高频标签/系列分布(2026-10-06 交换: 筛选提到高频标签上面)
 * 右栏: 结果网格 + 分页
 *
 * 与原版的行为对应关系(逐条对齐, 别改语义):
 *   · 筛选框留空 = 浏览全部图片
 *   · 点高频标签 = 追加进搜索框(不自动搜); 点系列 = 直接搜该系列并立即执行
 *   · 排序默认随机, 且有种子 —— 「换一批」只换种子, 其余参数不变
 *   · 「只看收藏」把收藏路径整份传给后端(由后端过滤), 不是只过滤当前页 ——
 *     旧版踩过坑: 只在当前页过滤会导致结果空掉
 *   · 导出时剔除黑名单、应用替换规则、按需补背景标签(都由主进程完成)
 */
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from 'vue'
import TvSourceChips from '@/components/filter/TvSourceChips.vue'
import TvTagBars from '@/components/tag/TvTagBars.vue'
import TvTabs from '@/components/base/TvTabs.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvReplaceSetPicker from '@/components/export/TvReplaceSetPicker.vue'
import TvCheckbox from '@/components/base/TvCheckbox.vue'
import TvInput from '@/components/base/TvInput.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvRulesEditorModal from '@/components/rules/TvRulesEditorModal.vue'
import TvExportPresetsModal from '@/components/export/TvExportPresetsModal.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useSearchHistory } from '@/composables/useSearchHistory.js'
import { LS } from '@/utils/lskey.js'
import { useAppStore } from '@/stores/useAppStore.js'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const src = useSourceStore()
const app = useAppStore()
const fav = useFavStore()
const prefs = usePrefsStore()
const lb = useLightboxStore()
const ui = useUiStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()
const hist = useSearchHistory()

/* ---------------- 筛选表单 ---------------- */
const q = ref('')
const mode = ref('all')
const match = ref('contains')
const nameFilter = ref('')   // 文件名子串过滤(如 "Anima-" 找 ComfyUI 生成的图)
const excludeChar = ref(true)
/* 排序从 prefs 读、改完写回 —— 用户明确要求"记住排序", 每次进来不用重点一遍 */
const sort = ref(prefs.sortHome)
const pageSize = ref(60)
const rndSeed = ref(Date.now())

const tab = ref('tags')
const stats = ref(null)
const statsLoading = ref(false)

const showBlacklist = ref(false)
const showReplace = ref(false)
const showPresets = ref(false)
const exportMenu = ref(false)      // 「⬇ 导出标签 ▾」下拉是否展开
const autoPresetCount = ref(0)     // 开了「黑名单变更后自动导出」的预设数(按钮上显示)
const exporting = ref(0)      // 0=空闲 1=纯标签 2=带路径
const stripCharExport = ref(true)  // 导出时剔除角色/系列标签(含无括号角色, 走角色库)
const stripViewExport = ref(false) // 导出时剔除视角/机位标签(词表 data/export_view_tags.txt, 来自随机机位交接文档)
const safeOnlyExport = ref(false)  // 导出时剔除敏感tag(只导出安全模式的标签, 口径跟随安全模式档位)
const replaceExport = ref(true)    // 导出时应用替换规则(默认开; 关了就导原始标签, 主进程 exporter 本来就认 replace=0)
/* 替换规则组(2026-10-04): 选中哪一套。多套规则时导出时挑一套, 见 🔁 规则编辑器。
 * 列表与"纠正成真实 id"都由 TvReplaceSetPicker 自己干(它挂载时会 emit), 这里只留值。 */
const replaceSet = ref('')

/** 预设弹窗里「新建预设」的初值 = 首页当前筛选条件(建完之后就是快照, 不再联动) */
const presetSnapshot = computed(() => ({
  source: [...src.selected],
  q: cleanQ(),
  mode: mode.value,
  match: match.value,
  exclude: '',
  exclude_char: excludeChar.value,
  spaces: true,
  blacklist: true,
  replace: replaceExport.value,
  bg: prefs.bgAuto,
  strip_char: stripCharExport.value,
  strip_view: stripViewExport.value,
  safe_only: safeOnlyExport.value,
  with_path: false,
  replace_set: replaceSet.value,
}))

const presetTitle = computed(() => (autoPresetCount.value
  ? `已开启自动导出: ${autoPresetCount.value} 个预设(ban 完黑名单后自动覆盖导出)`
  : '把筛选条件 + 目标目录存成预设, ban 完自动导出'))

/**
 * 待导出的倒计时(mm:ss)。
 * 为什么要有: 延迟是**几分钟**级别, 静默等待与"功能坏了"在界面上长得一样。
 * 数据来自 app store(主进程排程时推一条, 之后本地每秒走), 这个组件只负责显示。
 */
const autoLeft = computed(() => {
  const s = Math.ceil((app.autoExport?.remainingMs || 0) / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
})
const autoBadgeTitle = computed(() => (app.autoExport?.pending
  ? `黑名单已改动, 还有 ${autoLeft.value} 自动导出 —— 点一下立刻导`
  : presetTitle.value))
/** 角标: 排程中 = 点一下立刻导; 空闲 = 点开预设弹窗 */
async function onAutoBadge() {
  if (app.autoExport?.pending) { await app.flushAutoNow(); return }
  showPresets.value = true
}

async function refreshPresetCount() {
  try {
    const r = await api.exportPresets()
    autoPresetCount.value = (r?.presets || []).filter((p) => p.auto && p.dir).length
  } catch { /* 取不到就不显示角标, 不影响主流程 */ }
  // 顺带同步一次"待导出"状态 —— 可能是在别的窗口/上一轮排下的(见 app.pullAutoState)
  void app.pullAutoState()
}

const feed = useImageFeed({ infinite: true, pageSize: 60 })

/**
 * 当前页的图片顺序 —— 传给大图预览, 它才知道「下一张」是谁(滚轮/箭头/方向键翻页)。
 * 少了这个, 光箱里 `count` 只有 1, 翻页相关的一切都不显示。
 */
/* 安全模式开着时, 光箱的翻页序列必须和网格里看到的一致 —— 否则网格里已经被藏掉的
 * 那张, 光箱还把它算在"下一张"里, 往后翻就翻到一张本该看不见的图。 */
const shownResults = computed(() => safety.filterItems(feed.results.value))
const imgPaths = computed(() => shownResults.value.map((i) => i.path).filter(Boolean))

// 换页 / 换一批后就地同步, 免得光箱还拿着上一批的顺序。
// ⚠️ 必须带**激活守卫**: 光箱全站唯一, 本视图被 KeepAlive 休眠时这些 watch
// 依然活跃 —— 用户在扫描页开着光箱, 这边 epoch++ 后台重查, 若照旧 setList
// 会把看板的列表塞进光箱(当前图不在其中 -> index 丢失), 用户再移一张图
// removeCurrent 就会清空列表并 close() —— "光箱自己关了"(2026-10-03 实锤)。
const homeActive = ref(true)
onActivated(() => { homeActive.value = true })
onDeactivated(() => { homeActive.value = false })
watch(imgPaths, (arr) => { if (homeActive.value && lb.visible) lb.setList(arr) })

/** 组装查询参数 —— 与后端 parseQuery 的字段名一一对应 */
function buildQuery(offset = 0) {
  const o = {
    q: cleanQ(),
    mode: mode.value,
    match: match.value,
    exclude_char: excludeChar.value ? '1' : '0',
    sort: sort.value,
    offset,
    limit: pageSize.value,
    source: src.param,
  }
  if (nameFilter.value.trim()) o.name = nameFilter.value.trim()
  if (sort.value === 'random') o.seed = rndSeed.value
  return o
}

/* ---------------- 搜索 ---------------- */
/**
 * q 的规整形态: 按中英文逗号切段、去空、再拼回 —— 输入框里可能留着
 * 「胶囊, 」的尾逗号(multi 模式组词节奏), 传给后端/写进历史前统一清掉。
 */
function cleanQ() {
  return q.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).join(', ')
}

async function doSearch() {
  const qv = cleanQ()
  if (qv) hist.push(qv)
  await feed.search(buildQuery(0))
}

/** 「✕ 清空」: 搜索词整个丢掉, 回到浏览全部(全选了一大串词之后的最快退路) */
async function clearSearch() {
  q.value = ''
  await doSearch()
}

/** 文件名过滤: 不进标签搜索历史, 防抖后自动生效 */
function applyNameFilter() { feed.search(buildQuery(0)) }
let nameTimer = null
watch(nameFilter, () => {
  clearTimeout(nameTimer)
  nameTimer = setTimeout(applyNameFilter, 400)
})

/** 换一批: 只换随机种子 */
async function shuffle() {
  rndSeed.value = Date.now()
  await feed.setQuery({ seed: rndSeed.value })
}

/* ---------------- 统计 ---------------- */
async function loadStats() {
  statsLoading.value = true
  try {
    stats.value = await api.stats({ source: src.param })
  } catch (e) {
    ui.err('统计加载失败: ' + e.message)
  } finally {
    statsLoading.value = false
  }
}

/* ---------------- 交互 ---------------- */
/** 点高频标签: 追加进搜索框(不立刻搜, 让用户还能接着加)。
 * ⚠️ 结尾带**裸逗号**(不要 ", "): multi 输入框的 activeSeg 是最后一段,
 * 尾随空格会让它变成 " " → Backspace 删胶囊失灵 */
function addToQ(tag) {
  const list = q.value ? q.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
  const dup = list.includes(tag)
  if (!dup) list.push(tag)
  q.value = list.join(',')
  ui.toast(dup ? `已在筛选中: ${tag}` : `已加入筛选: ${tag}`, 'info', 1200)
}

/**
 * 下拉「全选」: 把匹配到的标签全部加入(去重)。
 * 多个标签在 all(全部命中)下几乎必然空集 —— 没有图能同时带 20 个发色,
 * 所以自动切到 any 并说明; 用户真的要交集就该只选一个词。
 * kw 是被展开的那个词(正在打的最后一段): 用匹配结果**替换**它, 不留成胶囊。
 */
function onPickMany({ tags, kw }) {
  const list = q.value ? q.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
  if (kw && list.length && list[list.length - 1].toLowerCase() === String(kw).toLowerCase()) list.pop()
  let added = 0
  for (const t of tags) {
    if (!list.includes(t)) { list.push(t); added++ }
  }
  q.value = list.length ? list.join(',') + ',' : ''
  if (!added) { ui.toast('匹配到的标签都已在筛选里', 'info', 1800); return }
  if (mode.value === 'all' && list.length > 1) {
    mode.value = 'any'
    ui.ok(`已加入 ${added} 个标签, 组合模式切到 any(任一命中) —— 多标签全选在 all 下没有交集`, 3600)
  } else {
    ui.ok(`已加入 ${added} 个标签`, 1600)
  }
}

/** 点系列: 直接搜索(contains 命中角色标签) */
async function searchSeriesClick(series) {
  q.value = series
  await doSearch()
}

async function onSourceChange() {
  await Promise.all([loadStats(), doSearch()])
}

async function withSource() {
  // 来源变了要重新统计 + 重新搜(分页回到第一页)
  return onSourceChange()
}

/* ---------------- 导出 ---------------- */
async function doExport(withPath) {
  exporting.value = withPath ? 2 : 1
  try {
    const params = buildQuery(0)
    if (withPath) params.with_path = '1'
    params.bg = prefs.bgAuto ? '1' : '0'
    params.strip_char = stripCharExport.value ? '1' : '0'
    params.strip_view = stripViewExport.value ? '1' : '0'
    params.safe_only = safeOnlyExport.value ? '1' : '0'
    params.replace = replaceExport.value ? '1' : '0'
    params.replace_set = replaceSet.value
    const r = await api.exportSave(params)
    if (r?.canceled) { ui.toast('已取消导出', 'info'); return }
    if (r?.error) { ui.err('导出失败: ' + r.error); return }
    const stripNote = stripCharExport.value && r.stripped ? `(已剔 ${nfmt(r.stripped)} 个角色/系列)` : ''
    const viewNote = stripViewExport.value && r.viewStripped ? `(已剔 ${nfmt(r.viewStripped)} 个视角/机位)` : ''
    const safeNote = safeOnlyExport.value && r.safeStripped ? `(已剔 ${nfmt(r.safeStripped)} 个敏感tag)` : ''
    const repNote = replaceExport.value && r.replaced ? `(已替换 ${nfmt(r.replaced)} 个)` : ''
    ui.ok(`✅ 已导出 ${nfmt(r.count)} 行${stripNote}${viewNote}${safeNote}${repNote} → ${r.path}`, 3200)
  } catch (e) {
    ui.err('导出失败: ' + e.message)
  } finally {
    exporting.value = 0
  }
}

/**
 * 下拉里点了某个导出变体: 先收起菜单再导出。
 * 悬浮菜单正好压在那排按钮上, 不收起来就看不到"正在导出"的转圈反馈。
 */
function pickExport(withPath) {
  exportMenu.value = false
  return doExport(withPath)
}

/* ---------------- 收藏 ---------------- */
/* 收藏按钮现在发整个 item —— tags 存进收藏记录当快照(收藏页要用),
   item 一起传进去是为了让收藏记录**顺便带上像素尺寸**(收藏页的网格要按真实
   比例排版, 没尺寸就会把横图裁成竖条)。
   2026-10-01: 「只看收藏」模式已整个移除, 这里只剩 ★ 收藏本身。 */
function toggleFav(item) {
  const added = fav.toggle(item?.path || item, item?.tags, item)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 'info', 1200)
}

/* ---------------- 生命周期 ---------------- */
/**
 * 初始加载。两步都单独兜错 —— 任一失败都不能把另一步带下水
 * (踩过一次: await src.load() 抛了, 后面的 doSearch 就再也没执行, 首页空着)。
 */
async function initHome() {
  rndSeed.value = Date.now()
  await Promise.allSettled([
    src.load().catch((e) => ui.err('来源统计加载失败: ' + e.message)),
    loadStats(),
    refreshPresetCount(),
  ])
  await doSearch()
}

onMounted(initHome)

// 数据换了(启动时"窗口先渲染、数据后到"，或菜单里「重新加载数据」) -> 重跑一次初始查询
watch(() => app.epoch, (n) => { if (n) initHome() })

// 排序 / 每页数量变化 -> 重搜
watch(sort, (v) => { prefs.sortHome = v; doSearch() })
// 打开预设弹窗时刷一下"自动 N"角标 —— 预设也可能是在别处(或上一轮)建的
watch(showPresets, (v) => { if (v) refreshPresetCount() })
watch(pageSize, (v) => { feed.setPageSize(v); doSearch() })
// 背景补全开关: 只影响复制/导出, 不用重搜
</script>

<template>
  <div class="home">
    <!-- ---------------- 左栏 ---------------- -->
    <aside class="left">
      <TvSourceChips
        v-model="src.selected"
        :sources="src.list"
        :total="stats?.total_images ?? src.totalImages"
        :loading="statsLoading"
        @change="withSource"
      />

      <div class="panel">
        <h2>筛选</h2>

        <label class="lab">要搜索的标签(选词/全选加入胶囊; 敲中英文逗号继续下一个词)</label>
        <TvTagSuggestInput
          v-model="q"
          multi
          history
          :source="src.selected.join(',')"
          placeholder="如: 1girl, blue_archive / 中文: 蔚蓝档案 / 发"
          @submit="doSearch"
          @pick-many="onPickMany"
        />

        <div class="row">
          <TvSelect
            v-model="mode"
            label="组合模式"
            :options="[
              { value: 'all', label: 'all - 全部命中' },
              { value: 'any', label: 'any - 任一命中' },
            ]"
          />
          <TvSelect
            v-model="match"
            label="匹配方式"
            :options="[
              { value: 'contains', label: 'contains - 包含' },
              { value: 'exact', label: 'exact - 精确' },
            ]"
          />
        </div>

        <div class="checks">
          <TvCheckbox v-model="excludeChar" label="过滤角色标签(含括号的 xxx_(系列))" />
        </div>

        <div class="row">
          <TvSelect
            v-model="sort"
            label="排序"
            :options="[
              { value: 'random', label: '随机' },
              { value: 'path', label: '默认(路径)' },
              { value: 'time', label: '最新优先(时间)' },
            ]"
          />
          <TvSelect
            v-model="pageSize"
            label="每页数量"
            :options="[60, 120, 240].map((n) => ({ value: n, label: String(n) }))"
          />
        </div>

        <!--
          动作区分三层(改之前是 6 个等宽按钮摊成两排, 主次不分):
            1. 搜索        —— 唯一的高频动作, 独占一行
            2. 导出 + 黑名单 —— 导出做成分裂按钮(主键直接导出, ▾ 放"带路径"与两个导出选项);
                              黑名单是 ban 循环入口, 留在明面上
            3. 文字链      —— 替换/预设导出这类"进去配置"的入口, 降级成 ghost 小按钮
          底部 tip 原本还挂着这三个入口的超链接, 与按钮完全重复, 已删;
          说明文字改挂到各按钮的 title 上(悬停可见, 不再占版面)。
        -->
        <div class="btns">
          <div class="brow">
            <TvButton variant="primary" @click="doSearch">🔍 搜索</TvButton>
            <TvButton
              variant="ghost"
              title="清空搜索词并回到全部图片"
              @click="clearSearch"
            >✕ 清空</TvButton>
          </div>

          <div class="brow">
            <div class="split">
              <TvButton :loading="exporting !== 0" @click="doExport(false)">⬇ 导出标签</TvButton>
              <button
                class="caret"
                type="button"
                :class="{ on: exportMenu }"
                :aria-expanded="exportMenu ? 'true' : 'false'"
                title="更多导出方式 / 导出选项"
                @click="exportMenu = !exportMenu"
              ><span class="chev" :class="{ up: exportMenu }">▾</span></button>
            </div>

            <TvButton title="导出时自动剔除黑名单里的标签" @click="showBlacklist = true">🚫 黑名单</TvButton>

            <!--
              菜单挂在**整排**上, 不挂在分裂按钮上 —— 按分裂按钮的宽度算只有半排宽,
              两条说明文字和复选框 label 会立刻被挤成两三行(实测过)。
            -->
            <div v-if="exportMenu" class="menu-off" @click="exportMenu = false" />
            <div v-if="exportMenu" class="menu">
              <button class="mi" type="button" :disabled="exporting !== 0" @click="pickExport(false)">
                <span class="mt">⬇ 导出标签</span>
                <span class="mh">每行一组逗号分隔的标签</span>
              </button>
              <button class="mi" type="button" :disabled="exporting !== 0" @click="pickExport(true)">
                <span class="mt">⬇ 导出（带图片路径）</span>
                <span class="mh">每行末尾附上文件路径</span>
              </button>
              <div class="msep" />
              <div class="mopt">
                <TvCheckbox
                  v-model="replaceExport"
                  label="导出时应用替换规则"
                  title="导出结果先过一遍替换规则(🔁 替换规则里配的那些); 不想要替换后的版本就关掉, 导出原始标签"
                />
              </div>
              <div v-if="replaceExport" class="mopt">
                <TvReplaceSetPicker v-model="replaceSet" label="用哪套规则" />
              </div>
              <div class="mopt">
                <TvCheckbox
                  v-model="stripCharExport"
                  label="导出剔除角色/系列标签"
                  title="导出结果里去掉角色标签(含 higuchi_madoka 这类无括号写法, 由角色库识别)和裸系列标签; 生成提示词通常需要"
                />
              </div>
              <div class="mopt">
                <TvCheckbox
                  v-model="stripViewExport"
                  label="导出剔除视角/机位标签"
                  title="导出结果里去掉视角/机位类标签(from behind、high angle、dutch angle 等), 随机机位工作流会自己随机视角, 不需要图里带的; 词表在 data/export_view_tags.txt, 可自行增删"
                />
              </div>
              <div class="mopt">
                <TvCheckbox
                  v-model="safeOnlyExport"
                  label="只导出安全模式的标签(剔除敏感tag)"
                  title="导出结果的每个标签串里去掉敏感标签(nude/sex 等), 行数不变; 敏感口径跟随安全模式的档位(core/edge), 词表即 data/safety_tags.txt"
                />
              </div>
              <div class="mopt">
                <TvCheckbox
                  v-model="prefs.bgAuto"
                  label="缺背景时补背景标签"
                  title="标签组合里没有背景/场景标签时, 自动追加 scenery 等背景标签, 防止 AI 生图画出白底"
                />
              </div>
            </div>
          </div>

          <div class="lnk">
            <TvButton
              variant="ghost"
              size="sm"
              title="导出时对标签应用替换规则"
              @click="showReplace = true"
            >🔁 替换规则</TvButton>
            <TvButton variant="ghost" size="sm" :title="presetTitle" @click="showPresets = true">📤 预设导出</TvButton>
            <button
              v-if="autoPresetCount"
              class="badge"
              :class="{ live: app.autoExport?.pending }"
              :title="autoBadgeTitle"
              @click="onAutoBadge"
            >{{ app.autoExport?.pending ? `待导出 ${autoLeft}` : `自动 ${autoPresetCount}` }}</button>
          </div>
        </div>

        <div class="tip">💡 筛选框留空 = 浏览全部图片</div>
      </div>

      <div class="panel bars-panel">
        <TvTabs
          v-model="tab"
          :tabs="[{ value: 'tags', label: '高频标签' }, { value: 'series', label: '系列分布' }]"
        />
        <div class="bars-box">
          <TvTagBars
            v-if="tab === 'tags'"
            :data="stats?.top_tags || []"
            max-height="380px"
            @pick="addToQ"
          />
          <TvTagBars
            v-else
            :data="stats?.top_series || []"
            max-height="380px"
            @pick="searchSeriesClick"
          />
        </div>
        <div class="tip">💡 点击标签加入筛选; 点击系列直接查看该系列图片(按数量排序)</div>
      </div>
    </aside>

    <!-- ---------------- 右栏 ---------------- -->
    <section class="panel result">
      <div class="result-head">
        <b>{{ nfmt(feed.total.value) }}</b><span class="muted">条匹配</span>
        <TvInput
          v-model="nameFilter"
          class="name-input"
          placeholder="按文件名过滤, 如 Anima-"
          title="对当前结果的文件路径做子串匹配(大小写不敏感), 输入后自动生效"
          @enter="applyNameFilter"
        />
        <TvSafetyToggle :counts="feed.unsafe.value" />
        <span class="spacer" />
        <span class="muted nowrap">已加载 {{ nfmt(shownResults.length) }} / 共 {{ nfmt(feed.total.value) }} 张 · 滚到底自动加载</span>
      </div>

      <div class="grid-wrap">
        <TvImageGrid
          :results="feed.results.value"
          :loading="feed.loading.value"
          :error="feed.error.value"
          :loaded-once="feed.loadedOnce.value"
          :infinite="true"
          :has-more="feed.hasMore.value"
          favable
          :is-fav="fav.isFav"
          @open="(it) => lb.open(it.path, { list: imgPaths })"
          @toggle-fav="toggleFav"
          @load-more="feed.loadMore"
          @hover="({ text, event }) => ui.showTip(text, event)"
          @move="ui.moveTip"
          @leave="ui.hideTip"
        />
      </div>
    </section>

    <!-- 换一批: 只在随机排序下有意义 -->
    <button
      v-if="sort === 'random'"
      class="shuffle"
      title="换一批(随机重排, 参数不变)"
      @click="shuffle"
    >🎲</button>

    <TvRulesEditorModal v-model="showBlacklist" kind="blacklist" @saved="doSearch" />
    <TvRulesEditorModal v-model="showReplace" kind="replace" @saved="doSearch" />
    <TvExportPresetsModal
      v-model="showPresets"
      :sources="src.list"
      :total-images="stats?.total_images ?? src.totalImages"
      :snapshot="presetSnapshot"
      @changed="refreshPresetCount"
    />
  </div>
</template>

<style scoped>
.home {
  flex: 1; min-height: 0;
  display: flex; gap: 12px;
  padding: 12px;
  overflow: hidden;
}

.left {
  flex: 0 0 372px; width: 372px;
  display: flex; flex-direction: column; gap: 12px;
  overflow-y: auto;
  padding-right: 2px;
}

.panel h2 { font-size: 13px; color: var(--muted); margin-bottom: 8px; }

.bars-panel { padding: 12px 14px 14px; }
.bars-box { margin-top: 10px; }

.lab { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 5px; }
.row { display: flex; gap: 10px; margin-top: 4px; }
.row > * { flex: 1; min-width: 0; }
.checks { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; }
/*
 * 动作区。三层结构(搜索 / 导出+黑名单 / 文字链), 见模板里的注释。
 * 原来是 `flex-wrap` 让 6 个按钮等宽对折, 谁高频谁低频完全看不出来。
 */
.btns { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
/* position: relative 是给导出菜单当定位上下文用的 —— 菜单要与整排同宽, 见模板注释 */
.brow { position: relative; display: flex; gap: 6px; }
.brow > * { flex: 1 1 0; min-width: 0; }

/* 分裂按钮: 主键 = 直接导出, caret = 更多导出方式 + 导出选项 */
.split { display: flex; min-width: 0; }
.split :deep(.tv-btn) { flex: 1 1 auto; border-radius: var(--r-sm) 0 0 var(--r-sm); }
.caret {
  flex: 0 0 auto; width: 26px;
  background: var(--panel2); color: var(--muted);
  border: 1px solid var(--border); border-left: 0;
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  font-size: 11px; line-height: 1; cursor: pointer;
  transition: color var(--t-fast), border-color var(--t-fast);
}
.caret:hover, .caret.on { color: var(--text); border-color: var(--accent); }
/* 菜单向下展开, 箭头跟着翻, 免得方向感对不上 */
.chev { display: inline-block; transition: transform var(--t-fast); }
.chev.up { transform: rotate(180deg); }

/*
 * 菜单**向下**展开: 2026-10-06 面板换位后动作区在侧栏中部, 下方是高频标签面板,
 * 向下有整块空间; 向上开反而会顶出侧栏可视顶沿(几何断言实测抓到)。
 * .menu-off 是透明遮罩, 只负责点外部关闭(固定定位不受 .left 的 overflow 影响)。
 */
.menu-off { position: fixed; inset: 0; z-index: 55; }
.menu {
  position: absolute; right: 0; top: calc(100% + 6px); left: 0; z-index: 56;
  max-height: 260px; overflow-y: auto;
  padding: 4px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r-sm); box-shadow: var(--shadow-1);
}
.mi {
  display: flex; flex-direction: column; gap: 1px;
  width: 100%; padding: 6px 8px;
  background: transparent; border: 0; border-radius: 4px;
  text-align: left; cursor: pointer;
}
.mi:not(:disabled):hover { background: var(--panel2); }
.mi:disabled { opacity: .5; cursor: not-allowed; }
.mt { font-size: 12px; color: var(--text); }
.mh { font-size: 11px; color: var(--faint); }
.msep { height: 1px; margin: 4px 0; background: var(--border); }
.mopt { padding: 4px 8px; }

/* 第三层: 配置入口的文字链 */
.lnk { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px; }
.lnk :deep(.tv-btn) { flex: 0 0 auto; }
.badge {
  padding: 1px 7px; border-radius: var(--r-pill);
  background: var(--accent-soft); color: var(--accent);
  font-size: 11px; white-space: nowrap;
}
/* 角标改成可点了(待导出时点一下 = 立刻导) —— button 的默认样式要清掉 */
.badge {
  border: 0; font-family: inherit; line-height: inherit; cursor: pointer;
}
.badge:hover { filter: brightness(1.15); }
/* 排程中: 用"待办"色(不是报错的-red), 一眼看出还在等 */
.badge.live { background: var(--warn-soft); color: var(--warn); }

.result {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  padding: 12px;
  overflow: hidden;
}
.result-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 10px; font-size: 13px;
  flex: 0 0 auto;
}
.result-head b { color: var(--accent); font-size: 16px; }
.name-input { width: 240px; flex: 0 1 auto; margin-left: 6px; }
.grid-wrap { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }

.shuffle {
  position: fixed; right: 20px; bottom: 24px; z-index: 90;
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--panel2); color: var(--text);
  border: 1px solid var(--border);
  font-size: 18px;
  box-shadow: var(--shadow-1);
}
.shuffle:hover { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
</style>
