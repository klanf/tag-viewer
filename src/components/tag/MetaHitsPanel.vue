<script setup>
/**
 * 库内命中相似图 —— 一个"与这张图像不像"的图片流
 * =================================================
 * 两处用:
 *   · 就地叠层 —— 看板/系列/扫描/独立标签页里, 从光箱「库内命中」徽章翻开的层
 *   · 独立页 /meta-hits —— 收藏/详情这类没有叠层宿主的页面, 走路由兜底
 *
 * 打分口径在 core/metasim.js(2026-10-24 用户拍板「要的就是查重的形式」):
 * 剔掉角色/系列 + 机位/视角词之后, 用 IDF 加权 Jaccard 算相似度, 阈值以上按分数降序。
 * 这里只管展示: 阈值、来源|扫描夹口径、安全模式、批量、网格。
 *
 * 口径(2026-10-24 用户要求与标签图片页一致): 顶部「来源 | 扫描夹」分段栏沿用
 * 全局单例 useSourceScanFilter —— 在标签页筛了「新世界」, 翻到命中页还是「新世界」;
 * 扫描档按文件夹路径前缀收窄库内记录。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvBatchBar from '@/components/image/TvBatchBar.vue'
import MoveTargetModal from '@/components/scan/MoveTargetModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import TvSourceScanBar from '@/components/filter/TvSourceScanBar.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useBatchOps } from '@/composables/useBatchOps.js'
import { useSourceScanFilter } from '@/composables/useSourceScanFilter.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const props = defineProps({
  /** 源图路径 —— 打分以它为准 */
  src: { type: String, default: '' },
  /** 本层是否正在看(叠层里只有栈顶为 true) */
  active: { type: Boolean, default: true },
})

const lb = useLightboxStore()
const fav = useFavStore()
const ui = useUiStore()
const safety = useSafetyStore()
const f = useSourceScanFilter()

/** 相似度阈值 —— 后端只做过滤, 打分与排序跟阈值无关, 换档很快。
 * 默认 0.4: 实测同批近重复图得分 0.34~0.62, 0.85(查重默认)在这条链上恒为 0 张。 */
const threshold = ref(0.4)
const THRESHOLD_OPTIONS = [0.6, 0.5, 0.4, 0.3, 0.2].map((v) => ({
  value: v,
  label: `≥ ${v}（${v >= 0.5 ? '严格' : v >= 0.4 ? '均衡' : '宽松'}）`,
}))
/** 后端随页带回的匹配概况(参与词/剔除数/候选数/最高分) */
const info = ref({
  hitTags: [], metaCount: 0, usedCount: 0, stripChar: 0, stripView: 0,
  candTotal: 0, maxScore: 0,
})

/** 扫描档没选夹子 = 「全部」: 把登记表里的所有扫描夹都算上。
 * 不这么做会变成"全库口径" —— 与上面那颗胶囊写的不一样。 */
function filterParams() {
  if (f.mode.value === 'scan') {
    const dirs = f.scanSel.value.length
      ? f.scanSel.value
      : f.scanChips.value.map((c) => c.value)
    return dirs.length ? { under: dirs.join(',') } : {}
  }
  return f.srcSel.value.length ? { source: f.srcSel.value.join(',') } : {}
}

const feed = useImageFeed({
  infinite: true,
  pageSize: 60,
  fetcher: async (p) => {
    const d = await api.metaSimilar({
      ...p, path: props.src, threshold: threshold.value, ...filterParams(),
    })
    if (d?.error) throw new Error(d.error)   // 后端异常别静默成 0 张(2026-10-21)
    info.value = {
      hitTags: d.hitTags || [], metaCount: d.metaCount || 0,
      usedCount: d.usedCount || 0, stripChar: d.stripChar || 0, stripView: d.stripView || 0,
      candTotal: d.candTotal || 0, maxScore: d.maxScore || 0,
    }
    return d
  },
})

/** 「放宽」提示: 本档 0 张但低档还有货时, 告诉用户最低档能看多少张 */
const canRelax = computed(() => (
  !feed.loading.value && !feed.error.value && feed.loadedOnce.value
  && !feed.total.value && info.value.candTotal > 0 && threshold.value > 0.2
))

/** 当前图片流顺序 —— 传给大图预览做「上一张 / 下一张」 */
const shownResults = computed(() => safety.filterItems(feed.results.value))
const imgPaths = computed(() => shownResults.value.map((i) => i.path).filter(Boolean))
watch(imgPaths, (arr) => { if (props.active && lb.visible) lb.setList(arr) })

/* 藏着的时候口径变了, 露脸时补一次 —— 与 TagImagesPanel 同款:
 * 无条件重查会把用户刚退回来的那一层翻回第一页。 */
let stale = false
function load() { feed.search() }

watch(() => props.src, (v) => {
  if (!v) { feed.reset(); return }
  if (props.active) load()
  else stale = true
}, { immediate: true })

watch(threshold, () => {
  if (!props.src) return
  if (props.active) load()
  else stale = true
})

watch(() => [
  f.mode.value,
  f.srcSel.value.slice().join(','),
  f.scanSel.value.slice().join(','),
  f.scanChips.value.map((c) => c.value).join(','),
], () => {
  if (!props.src) return
  if (props.active) load()
  else stale = true
})

watch(() => props.active, (v) => {
  if (v && stale) { stale = false; if (props.src) load() }
})

function toggleFav(item) {
  /* 第三个参数是整条 item —— 让收藏记录带上像素尺寸(收藏页网格按真实比例排版) */
  const added = fav.toggle(item?.path || item, item?.tags, item)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 1200)
}

/* 批量选择: 与看板/标签图片页同款(useBatchOps), 浏览态 Ctrl+点=勾选 */
const {
  selectMode, selected, moving, copying, moveOpen, copyOpen, folders: moveFolders,
  toggleSelectMode, toggleSelect, selectAll, invertSel, clearSel,
  onCardClick, batchDelete, openMove, openCopy, doMove, doCopy, onKey: batchKey,
} = useBatchOps({
  items: () => feed.results.value,
  openImage: (it) => lb.open(it.path, { list: imgPaths.value }),
})
function onKey(e) { if (props.active) batchKey(e) }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="meta-panel">
    <div class="panel body">
      <div class="bar">
        <b class="cnt">{{ nfmt(feed.total.value) }}</b>
        <span class="hint">张 · 与这张图相似</span>
        <TvSelect v-model="threshold" inline size="sm" label="相似度" :options="THRESHOLD_OPTIONS" />
        <span class="hint">
          剔角色 {{ info.stripChar }} / 机位 {{ info.stripView }} 后 {{ info.usedCount }} 词参与 ·
          候选 {{ nfmt(info.candTotal) }} 张 · 最高 {{ (info.maxScore * 100).toFixed(1) }}%
        </span>
        <span v-if="info.metaCount" class="hint faint">图内 {{ info.metaCount }} 词 → 命中库内词条 {{ info.hitTags.length }}</span>
        <span class="spacer" />
        <TvSafetyToggle :counts="feed.unsafe.value" />
        <TvButton
          size="sm"
          variant="ghost"
          title="批量选择: 勾选后批量移动/复制/删除(浏览状态下 Ctrl+点击也可直接勾)"
          @click="toggleSelectMode"
        >☑ 选择</TvButton>
      </div>

      <TvSourceScanBar v-if="src" class="filter-row" />

      <div
        v-if="src && !feed.loading.value && feed.loadedOnce.value && !feed.total.value"
        class="note"
      >
        <template v-if="!info.metaCount">
          这张图没有图内提示词 —— 库内相似图要靠 PNG 里的提示词来比对
        </template>
        <template v-else-if="!info.candTotal">
          这个范围内没有能对上库内词条的内容 —— 换个来源/扫描夹或调低阈值再看
        </template>
        <template v-else-if="canRelax">
          相似度 ≥ {{ threshold }} 没有图 · 最高分 {{ (info.maxScore * 100).toFixed(1) }}% ——
          <button class="linkbtn" @click="threshold = 0.2">
            放宽到 ≥ 0.2, 看看这 {{ nfmt(info.candTotal) }} 张
          </button>
        </template>
        <template v-else>
          相似度 ≥ 0.2 也没有相似图 —— 这张的提示词在库里可能确实没有同款
        </template>
      </div>

      <TvBatchBar
        v-if="selectMode"
        :count="selected.size"
        :moving="moving"
        :copying="copying"
        @sel-all="selectAll"
        @sel-invert="invertSel"
        @sel-clear="clearSel"
        @exit="toggleSelectMode"
        @move="openMove"
        @copy="openCopy"
        @del="batchDelete"
      />

      <div class="scroll">
        <TvImageGrid
          :results="feed.results.value"
          :loading="feed.loading.value"
          :error="feed.error.value"
          :loaded-once="feed.loadedOnce.value"
          :infinite="true"
          :has-more="feed.hasMore.value"
          :sim-of="(it) => it.sim || 0"
          show-source
          favable
          :is-fav="fav.isFav"
          :selectable="selectMode"
          :selected-tags="selected"
          @open="onCardClick"
          @toggle-select="toggleSelect"
          @toggle-fav="toggleFav"
          @load-more="feed.loadMore"
          @hover="({ text, event }) => ui.showTip(text, event)"
          @move="ui.moveTip"
          @leave="ui.hideTip"
        />
      </div>
    </div>

    <MoveTargetModal v-model="moveOpen" :count="selected.size" :folders="moveFolders" :busy="moving" @pick="doMove" />
    <MoveTargetModal v-model="copyOpen" mode="copy" :count="selected.size" :folders="moveFolders" :busy="copying" @pick="doCopy" />
  </div>
</template>

<style scoped>
.meta-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; flex: 0 0 auto; }
.filter-row { flex: 0 0 auto; margin-bottom: 10px; }
.hint { color: var(--muted); font-size: 12px; }
.cnt { color: var(--accent); font-size: 16px; }
.faint { color: var(--faint); }
.note {
  flex: 0 0 auto; margin: -4px 0 10px; padding: 8px 10px;
  border: 1px dashed var(--border); border-radius: 8px;
  color: var(--muted); font-size: 12px;
}
.linkbtn {
  border: 0; background: transparent; padding: 0;
  color: var(--accent); font-size: 12px; cursor: pointer;
}
.linkbtn:hover { text-decoration: underline; }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
</style>
