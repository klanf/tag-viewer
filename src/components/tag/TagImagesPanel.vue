<script setup>
/**
 * 标签图片面板 —— 一个标签筛出来的图片
 * ====================================
 * 一个组件四处用:
 *   · 独立页 /tags/:tag
 *   · 系列 / 看板 / 扫描里的「来源内 tag 页」(就地翻开, 可以一层层往下叠)
 * 四处都带「来源 | 扫描夹」档位栏(useSourceScan): 不选任何 chips = 全库口径。
 * 路径栏、返回动作、页面归属都由宿主决定, 这里只管正文:
 * 计数 / 排序 / 安全模式 / 批量 / 网格 / 编辑标签。
 *
 * active 是给 KeepAlive 与来源宿主用的: 光箱列表同步、共享筛选变化后的重查、
 * 键盘批量操作都只在"这一页正在看"时生效。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvBatchBar from '@/components/image/TvBatchBar.vue'
import MoveTargetModal from '@/components/scan/MoveTargetModal.vue'
import TvTagEditModal from '@/components/tag/TvTagEditModal.vue'
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
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const props = defineProps({
  tag: { type: String, default: '' },
  /** true = 显示「来源 | 扫描夹」档位栏并按它取数; false = 固定全库口径 */
  useSourceScan: { type: Boolean, default: false },
  /** 本页是否正在看(KeepAlive/来源宿主) */
  active: { type: Boolean, default: true },
  /** 是否给「编辑标签」入口(改名/删除是全局动作) */
  editable: { type: Boolean, default: true },
})
const emit = defineEmits(['renamed', 'deleted'])

const lb = useLightboxStore()
const fav = useFavStore()
const ui = useUiStore()
const prefs = usePrefsStore()
const safety = useSafetyStore()
const f = useSourceScanFilter()

const imgSort = ref(prefs.sortTagImgs)
const imgPageSize = ref(60)
const feed = useImageFeed({
  infinite: true,
  pageSize: 60,
  // 档位现场分叉: source 档走库内 search, scan 档走扫描缓存 scan:tagImages
  fetcher: (p) => (props.useSourceScan && f.mode.value === 'scan' ? api.scanTagImages(p) : api.search(p)),
})

/** 当前图片流顺序 —— 传给大图预览做「上一张 / 下一张」 */
const shownResults = computed(() => safety.filterItems(feed.results.value))
const imgPaths = computed(() => shownResults.value.map((i) => i.path).filter(Boolean))
watch(imgPaths, (arr) => {
  if (props.active && lb.visible) lb.setList(arr)
})

function imgQuery() {
  const base = { q: props.tag, sort: imgSort.value }
  if (!props.useSourceScan) return { ...base, match: 'contains' }
  if (f.mode.value === 'scan') {
    // scan:tagImages 固定 contains/any 语义(与库搜索一致), 不需要 match 参数
    base.paths = f.scanSel.value.join(',')
  } else {
    base.match = 'contains'
    if (f.srcSel.value.length) base.source = f.srcSel.value.join(',')
  }
  return base
}

/* 排序改了就记下来(不用重新点一遍); 重查由模板上的 @change="load()" 负责 */
watch(imgSort, (v) => { prefs.sortTagImgs = v })

/* 筛选(档位/选择)变了就重查 —— 组件在 KeepAlive/宿主里常驻, 必须判 active,
 * 不然会给别的页面的标签偷偷发查询 */
watch(() => [f.mode.value, f.srcSel.value.slice(), f.scanSel.value.slice()], () => {
  if (props.useSourceScan && props.active) load()
})

async function load() {
  if (!props.tag) return
  feed.setPageSize(imgPageSize.value)
  await feed.search(imgQuery())
}

/* tag 变了就重查。来源内 tag 页点另一个 tag 时走的也是这里(同一实例, 只换 prop)。 */
watch(() => props.tag, (t) => {
  if (!t) return
  if (props.active) load()
}, { immediate: true })

/* 从休眠/别的页面切回来时补一次 —— 面板可能是在 active=false 时被换过 tag */
watch(() => props.active, (v) => { if (v && props.tag) load() })

function toggleFav(item) {
  /* 第三个参数是整条 item —— 让收藏记录带上像素尺寸(收藏页网格按真实比例排版) */
  const added = fav.toggle(item?.path || item, item?.tags, item)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 'info', 1200)
}

/* ---------------- 批量选择: 勾选 -> 批量移动/复制/删除 ---------------- */
const {
  selectMode, selected, moving, copying, moveOpen, copyOpen, folders: moveFolders,
  toggleSelectMode, toggleSelect, selectAll, invertSel, clearSel,
  onCardClick, batchDelete, openMove, openCopy, doMove, doCopy, onKey: batchKey,
} = useBatchOps({
  items: () => feed.results.value,
  openImage: (it) => lb.open(it.path, { list: imgPaths.value }),
})

function onPanelKey(e) {
  if (!props.active) return
  batchKey(e)
}
onMounted(() => window.addEventListener('keydown', onPanelKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onPanelKey))

/* ---------------- 标签编辑(改名/删除) ----------------
 * 弹窗里执行完主进程会自动重载数据集(app:reloaded 推回来)。
 * 改什么名字/删了之后去哪, 由宿主决定(独立页换路由, 来源页换/关 tag 页)。 */
const showEdit = ref(false)
</script>

<template>
  <div class="tag-panel">
    <div class="panel body">
      <div class="bar">
        <span class="tag-name"><span class="hash">#</span>{{ tag }}</span>
        <b class="cnt">{{ nfmt(feed.total.value) }}</b>
        <span class="hint">条匹配</span>
        <span
          v-if="!useSourceScan"
          class="scope-pill"
          title="来源里的 tag 页按全库口径出图; 想只看某个来源/扫描夹, 去「标签」页筛选"
        >全库</span>
        <span class="hint faint">点大图里的标签可以继续往下跳 · 悬停标签点 📋 只复制这一个</span>
        <span class="spacer" />
        <TvSafetyToggle :counts="feed.unsafe.value" />
        <TvButton
          size="sm"
          variant="ghost"
          title="批量选择: 勾选后批量移动/复制/删除(浏览状态下 Ctrl+点击也可直接勾)"
          @click="toggleSelectMode"
        >☑ 选择</TvButton>
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
          @change="load()"
        />
        <TvSelect
          v-model="imgPageSize"
          size="sm"
          inline
          label="每页"
          :options="[60, 120, 240].map((n) => ({ value: n, label: String(n) }))"
          @change="load()"
        />
        <TvButton
          v-if="editable"
          size="sm"
          variant="secondary"
          title="改名(全库替换)或删除(可圈范围)这个标签"
          @click="showEdit = true"
        >✏️ 编辑标签</TvButton>
      </div>

      <!-- (来源|扫描夹) 分段筛选: 与标签列表页共用同一份选择 -->
      <TvSourceScanBar v-if="useSourceScan" class="filter-row" />

      <!-- 批量操作条: 选择模式下出现, 钉在滚动区外 -->
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

    <TvTagEditModal
      v-if="editable"
      v-model="showEdit"
      :tag="tag"
      :count="feed.total.value"
      @renamed="(t) => emit('renamed', t)"
      @deleted="emit('deleted')"
    />

    <MoveTargetModal v-model="moveOpen" :count="selected.size" :folders="moveFolders" :busy="moving" @pick="doMove" />
    <MoveTargetModal v-model="copyOpen" mode="copy" :count="selected.size" :folders="moveFolders" :busy="copying" @pick="doCopy" />
  </div>
</template>

<style scoped>
.tag-panel {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
}
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.tag-name { font-size: 14px; font-weight: 600; color: var(--text); word-break: break-all; }
.tag-name .hash { color: var(--accent); margin-right: 1px; }
.cnt { color: var(--accent); font-size: 16px; }
.scope-pill {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.filter-row { flex: 0 0 auto; margin-bottom: 10px; }
.hint { color: var(--muted); font-size: 12px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
</style>
