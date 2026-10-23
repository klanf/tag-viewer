<script setup>
/**
 * 某个标签的图片列表 —— `/tags/:tag`
 * ==================================
 * 独立页(标签区进标签 / 深链直开)的薄壳: 正文全部交给 TagImagesPanel,
 * 这里只负责路由参数 -> tag、路径栏, 以及旧版的"智能返回"。
 *
 * 2026-10-23 导航改版后:
 *   · 面包屑与返回箭头挪到全局路径栏(根页无箭头, 子页箭头贴最左)
 *   · 系列/看板/扫描里点光箱标签**不再**跳到这里, 而是在来源页就地开 tag 页
 *   · 本路由保留: 标签区点标签、/tags?tag= 老地址、/tags/:tag 深链
 *
 * 标签名进的是**路径参数**而不是 query, 所以标签里的 `/` 由 vue-router 编码成 %2F
 * (`bb_(fate/extra)` 这类真的存在), 解析回来仍是原标签名 —— 这一点实测验证过,
 * 别改成自己拼字符串。
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TagImagesPanel from '@/components/tag/TagImagesPanel.vue'
import { usePagePath } from '@/composables/usePagePath.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

const route = useRoute()
const router = useRouter()
const lb = useLightboxStore()

const tag = ref('')

/* URL 是"当前标签"的真源: 路由参数变了就重查(面板监听 tag prop)。
 * immediate 是必须的 —— 本视图在 keep-alive 白名单里, 从一个标签跳到另一个标签时
 * 组件不会重挂, 只有参数在变。 */
watch(() => route.params.tag, (v) => {
  /* **必须先看"当前是不是本页"**: 切走之后组件不卸载、这个 watch 还在跑;
     任何一次离开都会让 params.tag 变成 undefined —— 不判就会走下面的 replace('/tags'),
     把"从子页面跳去别处"的导航硬拉回标签列表。 */
  if (route.name !== 'tag-images') return
  const t = v ? String(v) : ''
  if (!t) { router.replace('/tags'); return }
  tag.value = t
}, { immediate: true })

/** 回上一级: 标签列表。用 push 而不是 back —— 深链直接进来时 history 里没有"上一页" */
function backToTags() { router.push('/tags') }

/**
 * 智能返回(保留 2026-09-20 的行为): 从哪来回哪去。
 *   · 正常跳进来  -> router.back() 回来源页; 若是从**光箱**点标签跳过来的
 *     (takeJump 有记忆), 回去之后把光箱恢复出来, 定位到刚才那张图
 *   · 深链直接进来 -> history 里没有上一页, 退回标签列表
 * 路径栏的「全部标签」crumb 仍按字面回列表, 只有箭头走这里(见 usePathStore 的 back)。
 */
function smartBack() {
  const j = lb.takeJump(tag.value)
  if (window.history.state?.back != null) {
    router.back()
    // 等来源页渲染回来再把光箱拉起 —— 立即开会被路由切换的渲染覆盖
    if (j) setTimeout(() => { lb.open(j.imgPath, { list: j.list || [j.imgPath] }) }, 180)
  } else {
    backToTags()
  }
}

/** 路径栏: 全部标签 > 该标签 */
usePagePath('tag-images', computed(() => (tag.value ? [
  { label: '全部标签', onClick: backToTags, back: smartBack },
  { label: tag.value, copy: tag.value, copyLabel: '标签名' },
] : [])))

function onTagRenamed(newTag) {
  router.replace({ name: 'tag-images', params: { tag: newTag } })
}
function onTagDeleted() {
  router.replace('/tags')
}
</script>

<template>
  <div class="tag-images-view">
    <TagImagesPanel
      :tag="tag"
      use-source-scan
      :active="route.name === 'tag-images'"
      @renamed="onTagRenamed"
      @deleted="onTagDeleted"
    />
  </div>
</template>

<style scoped>
.tag-images-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 12px;
  overflow: hidden;
}
</style>
