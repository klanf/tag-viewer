<script setup>
/**
 * 库内命中相似图 · 独立页 /meta-hits?src=<图片路径>
 * ==================================================
 * 只作为**路由兜底**存在: 看板/系列/扫描/独立标签页里点光箱的「库内命中」徽章,
 * 走的是宿主就地叠一层(MetaHitsPanel), 不换路由、不丢层级栈(2026-10-24 用户报
 * 「从扫描的 breasts > open_mouth 里跳过去, 返回只剩 某个扫描夹」)。
 *
 * 收藏/购物车/详情这些没有叠层宿主的页面仍跳这里; 正文全部在 MetaHitsPanel。
 * 用 query 传 src 而不是 path 段 —— Windows 路径里 \ 和 : 塞 path 段要反复转义。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MetaHitsPanel from '@/components/tag/MetaHitsPanel.vue'
import { usePagePath } from '@/composables/usePagePath.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

const route = useRoute()
const router = useRouter()
const lb = useLightboxStore()

const srcPath = computed(() => (route.query.src ? String(route.query.src) : ''))

/** 父级 crumb 文案: 来源页名(光箱跳转时写在 query.from), 深链进来就写「上一页」 */
const FROM_LABELS = {
  home: '看板', 'tag-images': '标签图片', tags: '标签', series: '系列',
  scan: '扫描', favs: '收藏', cart: '购物车', detail: '详情', sources: '来源管理',
}
const fromLabel = computed(() => FROM_LABELS[String(route.query.from || '')] || '上一页')

/** 返回: 原路回来源页。从光箱跳来的回来时把光箱重新拉起来
 *  —— 与标签页的 smartBack 同一套机制, 不然回到列表页顶部看起来像"跳去了新页面"。 */
function back() {
  const j = lb.takeJump(`meta:${srcPath.value}`)
  if (window.history.state?.back != null) {
    router.back()
    // 等来源页渲染回来再拉起光箱 —— 立即开会被路由切换的渲染覆盖
    if (j) setTimeout(() => { lb.open(j.imgPath, { list: j.list || [j.imgPath] }) }, 180)
  } else {
    router.replace('/')
  }
}

usePagePath('meta-hits', computed(() => (
  srcPath.value
    ? [{ label: fromLabel.value, onClick: back, back }, { label: '库内命中相似图' }]
    : []
)))
</script>

<template>
  <div class="meta-hits-view">
    <MetaHitsPanel :src="srcPath" :active="route.name === 'meta-hits'" />
  </div>
</template>

<style scoped>
.meta-hits-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 12px;
  overflow: hidden;
}
</style>
