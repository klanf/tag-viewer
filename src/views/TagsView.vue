<script setup>
/**
 * 标签浏览 —— 原 tags.html
 * =======================
 * 只剩一级: 标签列表(🚫 切换黑名单 / 点标签去它的图片列表)。
 *
 * 「某个标签的图片」2026-09-20 拆成了**下一级子页面** `/tags/:tag`
 * (见 TagImagesView.vue) —— 原来它是本组件里的第二级状态, 地址栏只带 `?tag=`,
 * 浏览器后退得按两次才退得出标签页。现在 点标签 = 路由跳转, 层级是真的。
 *
 * 2026-10-06 三件(用户需求):
 *   · **去分页改滚动加载** —— 页码器和「每页」选择框撤掉, 滚到底自动补下一批
 *     (每批 300)。旧版"上万 pill 一次进 DOM 会卡"的担心依然成立, 所以照旧渐进
 *     加载, 只是翻页动作换成了滚动。
 *   · **「🚫 隐藏已ban」胶囊开关**(默认开, 记忆在 localStorage `tv_tags_hide_banned`)
 *     —— 过滤走**服务端**(getAllTags 的 hide_banned), total 是真实的可见数,
 *     接口顺带报被滤掉多少个; 开关一翻重拉列表(批量大, 毫秒级)。
 *   · **安全模式对词条生效** —— 开着 🛡 时, 敏感词(命中 core/edge 集合的标签名)
 *     从列表里藏掉。走**客户端过滤**(复用 useSafetyStore 的判定), 跟着工具栏开关
 *     即时生效, 不用重拉; 词和图口径同源(同一份 safety_tags.txt)。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TvTagList from '@/components/tag/TvTagList.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvChip from '@/components/base/TvChip.vue'
import TvState from '@/components/base/TvState.vue'
import TvSourceScanBar from '@/components/filter/TvSourceScanBar.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { useTagFavStore } from '@/stores/useTagFavStore.js'
import { useSourceScanFilter } from '@/composables/useSourceScanFilter.js'
import { usePagePath } from '@/composables/usePagePath.js'
import { api } from '@/utils/api.js'
import { readLS, writeLS, LS } from '@/utils/lskey.js'
import { nfmt } from '@/utils/format.js'

const ui = useUiStore()
const router = useRouter()
const safety = useSafetyStore()
const tagFav = useTagFavStore()

/* 标签区根页: 路径栏只有「全部标签」, 没有返回箭头 */
usePagePath('tags', computed(() => [{ label: '全部标签' }]))

const kw = ref('')
const BATCH = 300
const total = ref(0)          // 服务端可见总数(已按 hide_banned 过滤)
const bannedHidden = ref(0)   // 服务端报的被滤掉的已 ban 数
const tags = ref([])          // 已加载的(服务端过滤后)
const loading = ref(false)
const error = ref('')
const hideBanned = ref(readLS(LS.tagsHideBanned.key) !== '0')   // 默认隐藏

/* ---------------- 来源 / 扫描夹筛选(2026-10-21 重构) ----------------
 * 旧版两条筛选行并排铺开、靠"灰掉另一条"表达互斥 —— 用户反馈"看不懂怎么个
 * 互斥法, UI 也丑", 点名改成「(来源|扫描) 胶囊开关, 点击切换下面的文件夹就换,
 * 图片也跟着切」。照办: 状态与档位收进 useSourceScanFilter(模块级单例,
 * **标签图片页共用同一份**, 从列表跳进子页筛选不断档), 本页只接数据管线:
 *   · source 档 -> allTags({source})  服务端按 srcSet 过滤, total 是筛后真实数
 *   · scan 档   -> tags:scanList, 数据源是扫描的持久缓存(scan_cache.json,
 *     tags 在扫描时就已 promptToTags 规范化), 纯内存聚合不读图片
 * 两套口径没有交集(扫描夹的图不进库), 所以一次只有一个档生效 —— 这就是
 * "互斥"的本意, 现在由分段开关替用户表达, 不再靠灰掉。 */
const f = useSourceScanFilter()
/** 扫描模式的缓存情况提示(来自 scanTagList 的回执) */
const scanNote = ref(null)         // { images, withTags, missing: [] }
const scanMode = f.isScan

/* 档位 / 任一档的选择变了都重拉(切档换数据源, 点胶囊换筛选) */
watch(() => [f.mode.value, f.srcSel.value.slice(), f.scanSel.value.slice()], () => reload())

/* ---------------- ★ 只看收藏(2026-10-08) ----------------
 * 收藏在**前端 localStorage**(useTagFavStore), 服务端不知道 —— 所以「只看收藏」
 * 走客户端拼装: 逐个收藏标签调 allTags({q}) 拿 count/zh/ban 状态(收藏一般几十个,
 * 每个一次小查询, 毫秒级), 服务端大列表原封不动留着 —— 关掉开关立即恢复, 不用重拉。 */
const favOnly = ref(readLS(LS.tagsFavOnly.key) === '1')
const favRows = ref([])        // 收藏标签的词条(带 count/zh/banned)
const favLoading = ref(false)

async function loadFavRows() {
  const names = tagFav.list
  favLoading.value = true
  try {
    const rows = await Promise.all(names.map(async (tag) => {
      try {
        const d = await api.allTags({ q: tag, limit: 20, hide_banned: hideBanned.value ? '1' : '' })
        // q 是子串匹配, 取完全相等的那条; 查不到(标签已不在库里)也给个壳, 收藏不丢
        return d.tags?.find((t) => t.tag === tag) || { tag }
      } catch { return { tag } }
    }))
    rows.sort((a, b) => (b.count || 0) - (a.count || 0))
    favRows.value = rows
  } finally {
    favLoading.value = false
  }
}

/** 收藏标签页 pill 上的 ★: 就地增删, favOnly 开着时取消的条目当场消失 */
function toggleFavRow(tag) {
  const added = tagFav.toggle(tag)
  if (favOnly.value && !added) {
    favRows.value = favRows.value.filter((t) => t.tag !== tag)
  } else if (favOnly.value && added) {
    favRows.value = [...favRows.value, { tag }].sort((a, b) => (b.count || 0) - (a.count || 0))
  }
}

writeLS(LS.tagsFavOnly.key, favOnly.value ? '1' : '0')
watch(favOnly, (v) => {
  writeLS(LS.tagsFavOnly.key, v ? '1' : '0')
  if (v) loadFavRows()
  /* 关掉不重拉: tags.value 一直是服务端那份, 渲染切回去就行 */
})

/* ---------------- 安全模式: 敏感词从列表藏掉(客户端, 即时生效) ---------------- */
/** 只看收藏是标签库口径的(收藏词的 count/zh 从 allTags 查) —— 扫描夹模式暂不参与 */
const favActive = computed(() => favOnly.value && !scanMode.value)
const visibleTags = computed(() => {
  const base = favActive.value ? favRows.value : tags.value
  if (!safety.on) return base
  return base.filter((t) => !safety.isHidden({ tags: [t.tag] }))
})
/** 当前档位下藏掉了多少个词(只统计已加载的那批) */
const safetyHidden = computed(() =>
  safety.on ? (favActive.value ? favRows.value : tags.value).length - visibleTags.value.length : 0)
/** 标题栏"共 N 个"的口径跟着视图走 */
const shownTotal = computed(() => favActive.value ? favRows.value.length : total.value)

/* ---------------- 滚动加载 ---------------- */
const scrollEl = ref(null)
/** initialized: 首批没落地前 done 必须是 false —— 否则 0>=0 会把首屏加载挡死 */
const initialized = ref(false)
const done = computed(() => initialized.value && tags.value.length >= total.value)

function nearBottom() {
  const el = scrollEl.value
  if (!el) return false
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 240
}

async function loadMore(force = false) {
  if (loading.value || done.value) return
  if (!force && scrollEl.value && !nearBottom()) return   // force: 搜索/切开关的重拉, 不看位置
  loading.value = true
  error.value = ''
  try {
    const base = {
      q: kw.value.trim(),
      offset: tags.value.length,
      limit: BATCH,
      hide_banned: hideBanned.value ? '1' : '',
    }
    // 两种模式同一个返回形状(total/tags/bannedHidden), 下面的装配逻辑不分家
    const d = scanMode.value
      ? await api.scanTagList({ ...base, paths: f.scanSel.value.join(',') })
      : await api.allTags({ ...base, source: f.srcSel.value.length ? f.srcSel.value.join(',') : undefined })
    total.value = d.total || 0
    bannedHidden.value = d.bannedHidden || 0
    scanNote.value = d.scan || null
    if (d.tags?.length) tags.value.push(...d.tags)
    initialized.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
  // 批次落完还在底部(首屏没填满), 继续补 —— done 会兜住循环
  if (!force && !done.value && !error.value) loadMore()
}

/** 搜索 / 切换隐藏已ban: 清空重拉。
 * ⚠️ 必须 force —— 清空后 DOM 还没刷新, nearBottom() 读到旧滚动高度会拒绝加载,
 * 列表就永远空着(实测抓过)。 */
function reload() {
  tags.value = []
  initialized.value = false
  scrollEl.value?.scrollTo({ top: 0 })
  loadMore(true)
}

function onKwSubmit() { reload() }
/* 默认值也落盘: 让键从第一次运行就存在(断言/排查都好认), 不等第一次切换 */
writeLS(LS.tagsHideBanned.key, hideBanned.value ? '1' : '0')
watch(hideBanned, (v) => {
  writeLS(LS.tagsHideBanned.key, v ? '1' : '0')
  reload()
})

/* ---------------- 交互 ---------------- */
/** 点标签 = 去下一级子页面看它的图(路由跳转, 可后退) */
function showImages(tag) {
  if (!tag) return
  router.push({ name: 'tag-images', params: { tag } })
}

/**
 * 🚫 切换: 就地更新那一条, 不重拉列表(与旧版一致)。
 * 「隐藏已ban」开着时, ban 上的那条按语义应从列表消失(它已经是"已ban"了);
 * 取消 ban 的入口在关掉开关之后(开关开着根本看不见它)。
 */
async function toggleBan(tag) {
  try {
    const r = await api.blacklistToggle(tag)
    if (r.action === 'wildcard') {
      ui.warn(r.warning || `该标签被通配规则 ${r.ban_rule} 命中, 需在黑名单里手动修改`, 4000)
      return
    }
    if (r.banned && hideBanned.value) {
      tags.value = tags.value.filter((t) => t.tag !== tag)
      total.value = Math.max(0, total.value - 1)
      bannedHidden.value++
      ui.ok(`🚫 已 ban 并隐藏: ${tag}`, 'info', 1600)
      return
    }
    const it = tags.value.find((t) => t.tag === tag)
    if (it) {
      it.banned = !!r.banned
      it.ban_rule = r.banned ? tag.toLowerCase() : ''
    }
    ui.ok(r.banned ? `🚫 已 ban: ${tag}` : `已取消 ban: ${tag}`, 'info', 1600)
  } catch (e) {
    ui.err('操作失败: ' + e.message)
  }
}

onMounted(() => {
  safety.ensureLoaded()
  loadMore()
  if (favOnly.value) loadFavRows()   // 开关记忆是开的: 首屏就要收藏列表
})
</script>
<template>
  <div class="tags-view">
    <div class="panel body">
      <div class="bar">
        <div class="kw">
          <TvTagSuggestInput
            v-model="kw"
            placeholder="搜索标签... (Enter 搜索)"
            @submit="onKwSubmit"
            @pick="onKwSubmit"
          />
        </div>
        <TvButton size="sm" variant="primary" @click="onKwSubmit">搜索</TvButton>
        <TvChip
          :label="hideBanned ? '🚫 已ban已隐藏' : '🚫 已ban可见'"
          :active="hideBanned"
          :title="hideBanned
            ? '已 ban 的词条已从列表隐藏(记忆在本地, 重启仍生效); 点一下显示它们(灰色删除线)'
            : '已 ban 的词条正以灰色删除线显示; 点一下把它们藏起来'"
          @click="hideBanned = !hideBanned"
        />
        <TvChip
          :label="favOnly ? `★ 只看收藏(${tagFav.list.length})` : '★ 只看收藏'"
          :active="favActive"
          :title="scanMode
            ? '扫描夹模式下不参与(收藏词条的统计是标签库口径), 清空扫描夹后恢复'
            : favOnly
              ? '正显示收藏的标签; 点一下回到全部标签'
              : `只显示收藏的标签(现在 ${tagFav.list.length} 个, 收藏入口: 光箱/本页 pill 上的 ★)`"
          :class="{ dim: scanMode }"
          @click="!scanMode && (favOnly = !favOnly)"
        />
        <span class="hint">共 {{ nfmt(shownTotal) }} 个标签</span>
        <span v-if="hideBanned && bannedHidden > 0" class="hint faint banned-hint">已隐藏 {{ nfmt(bannedHidden) }} 个已 ban</span>
        <span v-if="safetyHidden > 0" class="hint faint safety-hint">
          {{ safety.mode === 'unsafe'
            ? `🙈 不安全模式: 已隐藏 ${nfmt(safetyHidden)} 个非敏感词`
            : `🛡 已隐藏 ${nfmt(safetyHidden)} 个敏感词` }}
        </span>
        <span v-if="scanMode && scanNote" class="hint faint scan-hint">
          📁 缓存 {{ nfmt(scanNote.withTags) }}/{{ nfmt(scanNote.images) }} 张有标签<template v-if="scanNote.missing?.length"> · ⚠️ {{ scanNote.missing.length }} 个夹还没有缓存(去扫描页打开/重扫一次)</template>
        </span>
        <span class="hint faint">点标签看它的图片 · 🚫 = 导出时剔除 · 灰色删除线 = 已 ban</span>
        <TvSafetyToggle />
      </div>

      <!-- 筛选行: (来源|扫描夹) 分段开关 + 当档 chips —— 点哪边哪边生效, 列表跟着换数据源 -->
      <TvSourceScanBar class="filter-row" />

      <div ref="scrollEl" class="scroll" @scroll="loadMore">
        <TvState v-if="favActive && favLoading" state="loading" text="加载收藏..." />
        <TvState v-else-if="loading && !tags.length && !favActive" state="loading" text="加载中..." />
        <TvState v-else-if="error && !tags.length && !favActive" state="error" :text="`加载失败: ${error}`" />
        <TvTagList
          v-else
          :tags="visibleTags"
          show-ban
          show-count
          action="filter"
          favable
          :fav-tags="tagFav.list"
          empty-text="没有匹配的标签(可能被「隐藏已ban」/安全模式藏掉了, 或还没收藏任何标签 —— pill 上的 ★ 就是收藏)"
          @click="({ tag }) => showImages(tag)"
          @ban="toggleBan"
          @fav="toggleFavRow"
          @hover="({ zh, event }) => ui.showTip(zh, event)"
          @leave="ui.hideTip"
        />
        <div v-if="loading && tags.length && !favActive" class="more-hint">加载中...</div>
        <div v-else-if="!favActive && done && tags.length" class="more-hint">到底了 · 共 {{ nfmt(total) }} 个标签</div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.tags-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.kw { width: 300px; }
.hint { color: var(--muted); font-size: 12px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
.more-hint { color: var(--faint); font-size: 11px; text-align: center; padding: 10px 0 4px; }
/* 筛选行与工具栏的间距; .dim 只剩「只看收藏」在扫描档下灰掉时用 */
.filter-row { flex: 0 0 auto; }
.dim { opacity: .45; pointer-events: none; }
.scan-hint { color: var(--accent2, var(--muted)); }
</style>
