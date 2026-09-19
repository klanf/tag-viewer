<script setup>
/**
 * 收藏页(2026-09-19 新增)
 * ========================
 * 为什么独立成页: 看板「只看收藏」走的是**标签库记录**的精确路径过滤,
 * 而扫描页收藏的图根本不在标签库里(扫描是独立的文件夹视图, 不走导入),
 * 在看板里永远刷不出来。所以收藏统一收拢到这一页, 不依赖库:
 *
 *   - 卡片直接用文件路径出缩略图(tv://thumb 对任何盘上路径都有效)
 *   - 标签显示的是**收藏那一刻的快照**(扫描图没库可查; 文件还在时可在
 *     光箱里看到实时标签)
 *   - 打开时后台跑一次 fav:resolve: 路径失效的按文件名在已知目录里找回
 *     (用户会在应用外把图挪进"涩不了一点"这类文件夹), 找回即改写记录
 *   - 文件确实不在的标灰"文件已不在"(卡片读 item._missing), 记录保留
 *     (用户拍板: 删除/移动都不清收藏)
 */
import { ref, computed, onMounted } from 'vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import { useFavStore } from '@/stores/useFavStore.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'

const fav = useFavStore()
const lb = useLightboxStore()
const ui = useUiStore()

/** 找回后确认"文件已不在"的路径(原路径), 卡片据此标灰 */
const missingSet = ref(new Set())
/** 找回跑完才渲染卡片(失效记录要先标上, 免得对失效路径发缩略图请求) */
const ready = ref(false)
/** 标签过滤(子串, 不分大小写; 空串=不过滤) */
const tagFilter = ref('')

/** 展示列表: 按收藏时间倒序(旧迁移数据 at=0 沉底), 再套标签过滤, 打上失效标记 */
const displayList = computed(() => {
  const q = tagFilter.value.trim().toLowerCase()
  const sorted = fav.list.slice().sort((a, b) => (b.at || 0) - (a.at || 0))
  return sorted
    .filter((r) => !q || (r.tags || []).some((t) => t.toLowerCase().includes(q)))
    .map((r) => (missingSet.value.has(r.path) ? { ...r, _missing: true } : r))
})

/** 传给光箱的翻页列表: 当前过滤结果(标灰的也能开 —— 光箱自己会显示加载失败) */
const openList = computed(() => displayList.value.map((r) => r.path))

function openItem(item) {
  lb.open(item.path, { list: openList.value })
}

/** 收藏页上的取消收藏 = 移除记录, 卡片消失 */
function toggleFav(item) {
  fav.toggle(item.path)
}

onMounted(async () => {
  if (!fav.list.length) { ready.value = true; return }
  const updates = await fav.resolveMissing()
  const gone = (updates || []).filter((u) => !u.found).map((u) => u.from)
  if (gone.length) missingSet.value = new Set([...missingSet.value, ...gone])
  const moved = (updates || []).filter((u) => u.found).length
  if (moved) ui.ok(`🔗 已按文件名找回 ${moved} 张移动过的收藏图`, 'ok', 3200)
  ready.value = true
})
</script>

<template>
  <div class="favs-view">
    <header class="bar">
      <h1>收藏 <span class="cnt">{{ fav.count }}</span></h1>
      <span v-if="fav.resolving" class="resolving">正在按文件名找回移动过的图…</span>
      <input
        v-model="tagFilter"
        class="filter"
        type="search"
        placeholder="按标签过滤收藏(子串匹配)"
        spellcheck="false"
      >
    </header>

    <TvImageGrid
      :results="ready ? displayList : []"
      :loading="!ready"
      :loaded-once="ready"
      :infinite="false"
      favable
      :is-fav="fav.isFav"
      footnote="name"
      empty-text="还没有收藏 —— 在图片或光箱里点 ☆ 收藏, 扫描页收藏的也会出现在这里"
      @open="openItem"
      @toggle-fav="toggleFav"
      @hover="({ text, event }) => ui.showTip(text, event)"
      @move="ui.moveTip"
      @leave="ui.hideTip"
    />
  </div>
</template>

<style scoped>
.favs-view { padding: 14px 18px 24px; }
.bar {
  display: flex; align-items: center; gap: 14px;
  margin-bottom: 12px;
}
.bar h1 { font-size: 16px; margin: 0; }
.cnt {
  color: var(--muted); font-size: 13px; font-weight: 400;
  background: var(--panel2); border: 1px solid var(--border);
  border-radius: var(--r-pill); padding: 1px 9px;
}
.resolving { color: var(--accent2); font-size: 12px; }
.filter {
  margin-left: auto;
  width: 240px;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--text);
  padding: 6px 10px;
  font-size: 12px;
}
.filter:focus { outline: none; border-color: var(--accent); }
</style>
