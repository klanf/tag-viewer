<script setup>
/**
 * 看板(首页) —— 原 index.html
 * ==========================
 * 左栏: 来源筛选 + 高频标签/系列分布 + 筛选表单
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
import { ref, computed, watch, onMounted } from 'vue'
import TvSourceChips from '@/components/filter/TvSourceChips.vue'
import TvTagBars from '@/components/tag/TvTagBars.vue'
import TvTabs from '@/components/base/TvTabs.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvCheckbox from '@/components/base/TvCheckbox.vue'
import TvInput from '@/components/base/TvInput.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvRulesEditorModal from '@/components/rules/TvRulesEditorModal.vue'
import TvExportPresetsModal from '@/components/export/TvExportPresetsModal.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useSearchHistory } from '@/composables/useSearchHistory.js'
import { useAppStore } from '@/stores/useAppStore.js'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const src = useSourceStore()
const app = useAppStore()
const fav = useFavStore()
const prefs = usePrefsStore()
const lb = useLightboxStore()
const ui = useUiStore()
const hist = useSearchHistory()

/* ---------------- 筛选表单 ---------------- */
const q = ref('')
const mode = ref('all')
const match = ref('contains')
const exclude = ref('')
const nameFilter = ref('')   // 文件名子串过滤(如 "Anima-" 找 ComfyUI 生成的图)
const excludeChar = ref(true)
const sort = ref('random')
const pageSize = ref(60)
const rndSeed = ref(Date.now())

const tab = ref('tags')
const stats = ref(null)
const statsLoading = ref(false)

const showBlacklist = ref(false)
const showReplace = ref(false)
const showPresets = ref(false)
const autoPresetCount = ref(0)     // 开了「黑名单变更后自动导出」的预设数(按钮上显示)
const exporting = ref(0)      // 0=空闲 1=纯标签 2=带路径
const stripCharExport = ref(true)  // 导出时剔除角色/系列标签(含无括号角色, 走角色库)

/** 预设弹窗里「新建预设」的初值 = 首页当前筛选条件(建完之后就是快照, 不再联动) */
const presetSnapshot = computed(() => ({
  source: [...src.selected],
  q: q.value,
  mode: mode.value,
  match: match.value,
  exclude: exclude.value,
  exclude_char: excludeChar.value,
  spaces: true,
  blacklist: true,
  replace: true,
  bg: prefs.bgAuto,
  strip_char: stripCharExport.value,
  with_path: false,
}))

const presetTitle = computed(() => (autoPresetCount.value
  ? `已开启自动导出: ${autoPresetCount.value} 个预设(ban 完黑名单后自动覆盖导出)`
  : '把筛选条件 + 目标目录存成预设, ban 完自动导出'))

async function refreshPresetCount() {
  try {
    const r = await api.exportPresets()
    autoPresetCount.value = (r?.presets || []).filter((p) => p.auto && p.dir).length
  } catch { /* 取不到就不显示角标, 不影响主流程 */ }
}

const feed = useImageFeed({ infinite: true, pageSize: 60 })

/**
 * 当前页的图片顺序 —— 传给大图预览, 它才知道「下一张」是谁(滚轮/箭头/方向键翻页)。
 * 少了这个, 光箱里 `count` 只有 1, 翻页相关的一切都不显示。
 */
const imgPaths = computed(() => feed.results.value.map((i) => i.path).filter(Boolean))

// 换页 / 换一批 / 收藏筛选后就地同步, 免得光箱还拿着上一批的顺序
watch(imgPaths, (arr) => { if (lb.visible) lb.setList(arr) })

const favCount = computed(() => fav.count)

/** 组装查询参数 —— 与后端 parseQuery 的字段名一一对应 */
function buildQuery(offset = 0) {
  const o = {
    q: q.value,
    mode: mode.value,
    match: match.value,
    exclude: exclude.value,
    exclude_char: excludeChar.value ? '1' : '0',
    sort: sort.value,
    offset,
    limit: pageSize.value,
    source: src.param,
  }
  if (nameFilter.value.trim()) o.name = nameFilter.value.trim()
  if (sort.value === 'random') o.seed = rndSeed.value
  if (fav.onlyFav) o.fav = fav.paths
  return o
}

/* ---------------- 搜索 ---------------- */
async function doSearch() {
  const qv = q.value.trim()
  if (qv) hist.push(qv)
  await feed.search(buildQuery(0))
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
/** 点高频标签: 追加进搜索框(不立刻搜, 让用户还能接着加) */
function addToQ(tag) {
  const list = q.value ? q.value.split(',').map((s) => s.trim()).filter(Boolean) : []
  if (!list.includes(tag)) list.push(tag)
  q.value = list.join(', ')
  ui.toast(`已加入筛选: ${tag}`, 'info', 1200)
}

/** 点系列: 直接搜索(contains 命中角色标签) */
async function searchSeriesClick(series) {
  q.value = series
  await doSearch()
}

function pickFromHistory(v) {
  q.value = v
  doSearch()
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
    const r = await api.exportSave(params)
    if (r?.canceled) { ui.toast('已取消导出', 'info'); return }
    if (r?.error) { ui.err('导出失败: ' + r.error); return }
    const stripNote = stripCharExport.value && r.stripped ? `(已剔 ${nfmt(r.stripped)} 个角色/系列)` : ''
    ui.ok(`✅ 已导出 ${nfmt(r.count)} 行${stripNote} → ${r.path}`, 3200)
  } catch (e) {
    ui.err('导出失败: ' + e.message)
  } finally {
    exporting.value = 0
  }
}

/* ---------------- 收藏 ---------------- */
/* 收藏按钮现在发整个 item —— tags 存进收藏记录当快照(收藏页要用) */
function toggleFav(item) {
  const added = fav.toggle(item?.path || item, item?.tags)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 'info', 1200)
  if (fav.onlyFav) doSearch()
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

// 收藏筛选 / 排序 / 每页数量变化 -> 重搜
watch(() => fav.onlyFav, () => doSearch())
watch(sort, () => doSearch())
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

      <div class="panel">
        <h2>筛选</h2>

        <label class="lab">要搜索的标签(逗号分隔, 如: blue_archive, 1girl)</label>
        <TvTagSuggestInput
          v-model="q"
          history
          :source="src.selected.join(',')"
          placeholder="blue_archive, 1girl / 输入中文搜索(如: 蔚蓝档案)"
          @submit="doSearch"
          @pick="pickFromHistory"
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

        <label class="lab">排除标签(可选, 生图时过滤掉角色/外观等)</label>
        <TvInput v-model="exclude" placeholder="red hair, cat ears, ..." @enter="doSearch" />

        <div class="checks">
          <TvCheckbox v-model="excludeChar" label="过滤角色标签(含括号的 xxx_(系列))" />
          <TvCheckbox
            v-model="stripCharExport"
            label="⬇ 导出剔除角色/系列标签"
            title="导出结果里去掉角色标签(含 higuchi_madoka 这类无括号写法, 由角色库识别)和裸系列标签; 生成提示词通常需要"
          />
          <TvCheckbox
            v-model="prefs.bgAuto"
            label="🌄 缺背景时补背景标签(导出/复制)"
            title="标签组合里没有背景/场景标签时, 自动追加 scenery 等背景标签, 防止 AI 生图画出白底"
          />
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

        <div class="btns">
          <TvButton variant="primary" @click="doSearch">🔍 搜索</TvButton>
          <TvButton variant="secondary" :loading="exporting === 1" @click="doExport(false)">⬇ 导出标签</TvButton>
          <TvButton variant="secondary" :loading="exporting === 2" @click="doExport(true)">⬇ 导出(带路径)</TvButton>
          <TvButton variant="secondary" :title="presetTitle" @click="showPresets = true">
            📤 预设导出<template v-if="autoPresetCount"> · 自动 {{ autoPresetCount }}</template>
          </TvButton>
          <TvButton variant="secondary" @click="showBlacklist = true">🚫 黑名单</TvButton>
          <TvButton variant="secondary" @click="showReplace = true">🔁 替换</TvButton>
        </div>

        <div class="tip">
          💡 筛选框留空 = 浏览全部图片 · 导出时自动剔除
          <a href="#" @click.prevent="showBlacklist = true">黑名单</a>标签、应用
          <a href="#" @click.prevent="showReplace = true">替换</a>规则 ·
          <a href="#" @click.prevent="showPresets = true">预设导出</a>可让 ban 完自动导出
        </div>
      </div>
    </aside>

    <!-- ---------------- 右栏 ---------------- -->
    <section class="panel result">
      <div class="result-head">
        <b>{{ nfmt(feed.total.value) }}</b><span class="muted">条匹配</span>
        <span v-if="fav.onlyFav" class="fav-on" title="只看收藏模式">📌 只看收藏({{ favCount }})</span>
        <TvInput
          v-model="nameFilter"
          class="name-input"
          placeholder="按文件名过滤, 如 Anima-"
          title="对当前结果的文件路径做子串匹配(大小写不敏感), 输入后自动生效"
          @enter="applyNameFilter"
        />
        <span class="spacer" />
        <span class="muted nowrap">已加载 {{ nfmt(feed.results.value.length) }} / 共 {{ nfmt(feed.total.value) }} 张 · 滚到底自动加载</span>
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
.btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; }
.btns :deep(.tv-btn) { flex: 1 1 auto; }

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
.fav-on {
  color: var(--fav); font-size: 12px;
  border: 1px solid var(--fav); border-radius: var(--r-pill);
  padding: 1px 8px;
}
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
