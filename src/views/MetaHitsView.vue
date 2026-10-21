<script setup>
/**
 * 库内命中相似图 —— /meta-hits?src=<图片路径>
 * ==============================================
 * 光箱 meta 模式「库内命中 n/m」徽章的落点(2026-10-21 用户二次澄清):
 * 点击徽章 = **直接看命中的库内图片**, 按「与源图的重合词条数」降序 ——
 * 第一屏就是库里与这张最像的图。不是把 n 个词条塞进看板筛选框
 * (上一版的做法, n 个热词任一命中等于没筛, 用户当场否掉)。
 *
 * 复用现状: 图片网格/光箱/收藏/安全开关/批量选择全套现成组件, 数据走
 * 专用通道 tags:metaSimilar(匹配与排序见 core/metasim.js)。
 * 用 query 传 src 而不是 path 段 —— Windows 路径里 \ 和 : 塞 path 段要
 * 反复转义, 与 /detail 同一个理由。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvBatchBar from '@/components/image/TvBatchBar.vue'
import MoveTargetModal from '@/components/scan/MoveTargetModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useBatchOps } from '@/composables/useBatchOps.js'
import { useFloatBack } from '@/composables/useFloatBack.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const route = useRoute()
const router = useRouter()
const lb = useLightboxStore()
const fav = useFavStore()
const ui = useUiStore()
const safety = useSafetyStore()

const srcPath = ref('')
/** 后端随页带回来的匹配概况(工具栏那句「图内 n · 命中 m」的来路) */
const info = ref({ hitTags: [], metaCount: 0, maxHits: 0 })

const feed = useImageFeed({
  infinite: true,
  pageSize: 60,
  fetcher: async (p) => {
    const d = await api.metaSimilar({ ...p, path: srcPath.value })
    info.value = { hitTags: d.hitTags || [], metaCount: d.metaCount || 0, maxHits: d.maxHits || 0 }
    return d
  },
})

/** 当前图片流顺序 —— 传给大图预览做「上一张 / 下一张」 */
const shownResults = computed(() => safety.filterItems(feed.results.value))
const imgPaths = computed(() => shownResults.value.map((i) => i.path).filter(Boolean))
watch(imgPaths, (arr) => { if (lb.visible) lb.setList(arr) })

/* src 是本页唯一参数: 光箱跳转/深链都走这里。本组件不在 KeepAlive 白名单,
 * 每次进入都重新挂载, immediate 兜住首屏。 */
watch(() => route.query.src, (v) => {
  if (route.name !== 'meta-hits') return
  srcPath.value = v ? String(v) : ''
  if (srcPath.value) feed.search({})
  else feed.reset()
}, { immediate: true })

/** 返回: 有上一页就 back(通常是光箱所在页), 深链直进则回看板 */
function back() {
  if (window.history.state?.back != null) router.back()
  else router.replace('/')
}
useFloatBack(() => {
  if (route.name !== 'meta-hits') return false
  back()
  return true
})

function toggleFav(item) {
  /* 第三个参数是整条 item —— 让收藏记录带上像素尺寸(收藏页网格按真实比例排版) */
  const added = fav.toggle(item?.path || item, item?.tags, item)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 'info', 1200)
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
function onKey(e) { if (route.name !== 'meta-hits') return; batchKey(e) }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="meta-hits-view">
    <div class="head">
      <div class="crumb">
        <span class="link" @click="back">返回</span>
        <span class="sep">&gt;</span>
        <span class="now">库内命中相似图</span>
      </div>
      <span class="spacer" />
    </div>

    <div class="panel body">
      <div class="bar">
        <b class="cnt">{{ nfmt(feed.total.value) }}</b>
        <span class="hint">张库内图与这张图有共同词条 · 重合越多排越前</span>
        <span v-if="info.metaCount" class="hint faint">图内 {{ info.metaCount }} 个词条 · 命中库内 {{ info.hitTags.length }} 个</span>
        <span class="spacer" />
        <TvSafetyToggle :counts="feed.unsafe.value" />
        <TvButton
          size="sm"
          variant="ghost"
          title="批量选择: 勾选后批量移动/复制/删除(浏览状态下 Ctrl+点击也可直接勾)"
          @click="toggleSelectMode"
        >☑ 选择</TvButton>
        <TvButton size="sm" variant="secondary" @click="back">← 返回</TvButton>
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
.meta-hits-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}
.head { display: flex; align-items: center; flex: 0 0 auto; }
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .link { color: var(--accent); cursor: pointer; }
.crumb .link:hover { text-decoration: underline; }
.crumb .now { color: var(--text); }
.crumb .sep { color: var(--faint); }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.hint { color: var(--muted); font-size: 12px; }
.cnt { color: var(--accent); font-size: 16px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
</style>
