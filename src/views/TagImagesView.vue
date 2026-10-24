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
 * 2026-10-24: 这一页自己也当**叠层宿主** —— 在这里点开光箱再点标签/系列药丸, 是往
 *   本页上方叠一层(路径栏跟着接一节, 左上角返回只退一层), 不再被换成系列/看板 tab。
 *
 * 标签名进的是**路径参数**而不是 query, 所以标签里的 `/` 由 vue-router 编码成 %2F
 * (`bb_(fate/extra)` 这类真的存在), 解析回来仍是原标签名 —— 这一点实测验证过,
 * 别改成自己拼字符串。
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TagImagesPanel from '@/components/tag/TagImagesPanel.vue'
import TvSeriesCharsPanel from '@/components/series/TvSeriesCharsPanel.vue'
import MetaHitsPanel from '@/components/tag/MetaHitsPanel.vue'
import { usePagePath } from '@/composables/usePagePath.js'
import { useTagHost, useMetaHost } from '@/composables/useTagHost.js'
import { useSeriesHost } from '@/composables/useSeriesHost.js'
import { useLevelStack } from '@/composables/useLevelStack.js'
import { useScrollKeep } from '@/composables/useScrollKeep.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

const route = useRoute()
const router = useRouter()
const lb = useLightboxStore()

const tag = ref('')

/* 就地叠层(与看板/系列/扫描同一套 useLevelStack): 本页自己的 tag 是底层,
 * 光箱里点标签/系列往上叠; 每层各存一份开层时的光箱现场, 返回箭头逐层退。 */
const {
  levels: tagLevels,
  openTagPage, openSeriesPage, openMetaPage,
  backOneLevel: backFromTagPage, clearLevels: clearTagPages,
  popLevel: onTagDeletedInPage, renameTopLevel: onTagRenamedInPage, levelCrumbs,
} = useLevelStack()
useTagHost('tag-images', openTagPage)
useMetaHost('tag-images', openMetaPage)
useSeriesHost('tag-images', openSeriesPage)

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
  /* 换的是**另一个根标签** = 这是一次全新进入, 上一标签叠的层不属于它 */
  if (t !== tag.value) clearTagPages()
  tag.value = t
}, { immediate: true })

/** 回上一级: 标签列表。用 push 而不是 back —— 深链直接进来时 history 里没有"上一页" */
function backToTags() {
  clearTagPages()
  router.push('/tags')
}

/**
 * 智能返回(保留 2026-09-20 的行为): 从哪来回哪去。
 *   · 正常跳进来  -> router.back() 回来源页; 若是从**光箱**点标签跳过来的
 *     (takeJump 有记忆), 回去之后把光箱恢复出来, 定位到刚才那张图
 *   · 深链直接进来 -> history 里没有上一页, 退回标签列表
 * 路径栏的「全部标签」crumb 仍按字面回列表, 只有箭头走这里(见 usePathStore 的 back)。
 * 叠了层的时候箭头轮不到它 —— 栈里只有 0 层时「全部标签」才是倒数第二级。
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

/** 路径栏: 全部标签 > 该标签 > 叠上来的各层 */
usePagePath('tag-images', computed(() => {
  if (!tag.value) return []
  const root = { label: tag.value, copy: tag.value, copyLabel: '标签名' }
  if (!tagLevels.value.length) return [{ label: '全部标签', onClick: backToTags, back: smartBack }, root]
  return [
    { label: '全部标签', onClick: backToTags },
    { ...root, onClick: clearTagPages, back: backFromTagPage },
    ...levelCrumbs(tagLevels.value),
  ]
}))
useScrollKeep('.tag-images-view .tag-panel .scroll')

function onTagRenamed(newTag) {
  clearTagPages()
  router.replace({ name: 'tag-images', params: { tag: newTag } })
}
function onTagDeleted() {
  clearTagPages()
  router.replace('/tags')
}
</script>

<template>
  <div class="tag-images-view">
    <!-- 本页的 tag 是底层: 叠层压上来时藏起来而不是拆掉, 退一层时它的图片流/滚动原样还在 -->
    <div v-show="!tagLevels.length" class="layer-base">
      <TagImagesPanel
        :tag="tag"
        use-source-scan
        :active="route.name === 'tag-images' && !tagLevels.length"
        @renamed="onTagRenamed"
        @deleted="onTagDeleted"
      />
    </div>

    <template v-for="(lv, i) in tagLevels" :key="lv.id">
      <TagImagesPanel
        v-if="lv.kind === 'tag'"
        v-show="i === tagLevels.length - 1"
        :tag="lv.tag"
        use-source-scan
        :active="route.name === 'tag-images' && i === tagLevels.length - 1"
        @renamed="onTagRenamedInPage"
        @deleted="onTagDeletedInPage"
      />
      <TvSeriesCharsPanel
        v-else-if="lv.kind === 'series'"
        v-show="i === tagLevels.length - 1"
        :series="lv.series"
        :active="route.name === 'tag-images' && i === tagLevels.length - 1"
        @open-char="(c) => openTagPage(c.tag)"
      />
      <MetaHitsPanel
        v-else
        v-show="i === tagLevels.length - 1"
        :src="lv.meta"
        :active="route.name === 'tag-images' && i === tagLevels.length - 1"
      />
    </template>
  </div>
</template>

<style scoped>
.tag-images-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 12px;
  overflow: hidden;
}
/* 包装层不参与排布: 露脸时 display 回到 contents, 布局跟没有这层时一模一样 */
.layer-base { display: contents; }
</style>
