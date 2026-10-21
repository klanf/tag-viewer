<script setup>
/**
 * 某个标签的图片列表 —— `/tags/:tag`
 * ==================================
 * 从 TagsView 里**拆出来的独立子页面**(2026-09-20 用户要求):
 * 原来"点标签看它的图"是 TagsView 内部的第二级状态(view='images'),
 * 地址栏只有个 `?tag=xxx`, 对 history 来说和标签列表是同一个页面 ——
 * 从标签列表点进去再按浏览器后退, 得按两次才退得出去。
 * 现在它是真正的下一级路由: /tags -> /tags/xxx, 后退一步就是列表,
 * 面包屑也真的读作「全部标签 > koharu_(blue_archive)」。
 *
 * 标签名进的是**路径参数**而不是 query, 所以标签里的 `/` 由 vue-router 编码成 %2F
 * (`bb_(fate/extra)` 这类真的存在), 解析回来仍是原标签名 —— 这一点实测验证过,
 * 别改成自己拼字符串。
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvTagEditModal from '@/components/tag/TvTagEditModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useFloatBack } from '@/composables/useFloatBack.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import TvSourceScanBar from '@/components/filter/TvSourceScanBar.vue'
import { useSourceScanFilter } from '@/composables/useSourceScanFilter.js'
import { nfmt } from '@/utils/format.js'

const route = useRoute()
const router = useRouter()
const lb = useLightboxStore()
const fav = useFavStore()
const ui = useUiStore()
const prefs = usePrefsStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()

const tag = ref('')
const imgSort = ref(prefs.sortTagImgs)
const imgPageSize = ref(60)
const feed = useImageFeed({ infinite: true, pageSize: 60 })

/* ---------------- 来源 | 扫描夹 筛选(2026-10-21 用户需求) ----------------
 * 「筛选应该放到 tag 跳转这里」—— 标签列表页有的筛选, 跳进某个标签的图片页
 * 也要有, 否则 9 万张图里想只看某个来源的还得回列表。状态是 useSourceScanFilter
 * 的模块级单例, **与标签列表页共用同一份**: 在那边选了 新世界, 跳进来还是 新世界。
 * 数据管线(与列表页不同):
 *   · source 档 -> search({source})  库内按来源筛, 后端已有
 *   · scan 档   -> search({under})   按**文件夹路径前缀**筛库内图片 ——
 *     扫描缓存里只有"夹里有哪些标签", 没有标签->图的倒排, 图还得从库里出;
 *     前缀匹配由 doSearch 的 under 参数在缓存结果上过滤(见 core/query.js)
 */
const f = useSourceScanFilter()

/** 当前图片流顺序 —— 传给大图预览做「上一张 / 下一张」 */
const shownResults = computed(() => safety.filterItems(feed.results.value))
const imgPaths = computed(() => shownResults.value.map((i) => i.path).filter(Boolean))
watch(imgPaths, (arr) => { if (lb.visible) lb.setList(arr) })

function imgQuery() {
  const base = { q: tag.value, match: 'contains', sort: imgSort.value }
  if (f.mode.value === 'scan') {
    if (f.scanSel.value.length) base.under = f.scanSel.value.join(',')
  } else if (f.srcSel.value.length) {
    base.source = f.srcSel.value.join(',')
  }
  return base
}

/* 排序改了就记下来(不用重新点一遍); 重查由模板上的 @change="load()" 负责 */
watch(imgSort, (v) => { prefs.sortTagImgs = v })

/* 筛选(档位/选择)变了就重查 —— 本视图在 keep-alive 白名单里, 在标签列表页
 * 改筛选时组件还活着, 必须**判当前路由**再动, 不然会给上一个标签偷偷发查询 */
watch(() => [f.mode.value, f.srcSel.value.slice(), f.scanSel.value.slice()], () => {
  if (route.name !== 'tag-images') return
  load()
})

async function load() {
  feed.setPageSize(imgPageSize.value)
  await feed.search(imgQuery())
}

/* URL 是"当前标签"的真源: 路由参数变了就重查。
 * immediate 是必须的 —— 本视图在 keep-alive 白名单里, 从一个标签跳到另一个标签时
 * 组件不会重挂(onMounted 只跑一次), 只有参数在变。 */
watch(() => route.params.tag, (v) => {
  /* **必须先看"当前是不是本页"**: 本视图在 keep-alive 白名单里, 切走之后组件不卸载、
     这个 watch 还在跑; 而任何一次离开都会让 params.tag 变成 undefined —— 不判就会
     走下面的 replace('/tags'), 把"从标签子页面跳去别处"的导航硬拉回标签列表
     (实测: 子页面 -> 详情页, 地址栏一闪又被拽回 #/tags, 详情页根本没机会渲染)。 */
  if (route.name !== 'tag-images') return
  const t = v ? String(v) : ''
  if (!t) { router.replace('/tags'); return }
  tag.value = t
  load()
}, { immediate: true })

/** 回上一级: 标签列表。用 push 而不是 back —— 深链直接进来时 history 里没有"上一页" */
function backToTags() { router.push('/tags') }

/**
 * 智能返回(2026-09-20 用户需求): 从哪来回哪去, 不再固定回标签列表。
 *   · 正常跳进来  -> router.back() 回来源页; 若是从**光箱**点标签跳过来的
 *     (takeJump 有记忆), 回去之后把光箱恢复出来, 定位到刚才那张图(翻页列表也在)
 *   · 深链直接进来 -> history 里没有上一页, 退回标签列表
 * 面包屑「全部标签」和「← 返回标签列表」按钮保持字面行为不变 ——
 * 它们明说了去哪; 这里只改"返回"这个动作的语义。
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

/* 子页面 -> 返回: 交给 smartBack(见上)。
 *
 * **必须判当前路由**: 本视图在 keep-alive 白名单里, 注册的处理器在切走之后
 * 依然留在栈上(useFloatBack 只在真正卸载时注销)。无条件返回 true 就会把别的
 * 页面(如扫描页的二级)的返回抢过来, 表现是"在别的页面按返回, 结果跳去标签列表"。 */
useFloatBack(() => {
  if (route.name !== 'tag-images') return false
  smartBack()
  return true
})

function toggleFav(item) {
  /* 第三个参数是整条 item —— 让收藏记录带上像素尺寸(收藏页网格按真实比例排版) */
  const added = fav.toggle(item?.path || item, item?.tags, item)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 'info', 1200)
}

/* ---------------- 标签编辑(改名/删除) ----------------
 * 弹窗里执行完主进程会自动重载数据集(app:reloaded 推回来)。
 * 改名: 跳到新标签的页面(路由参数变化 -> watch 重查); 删除: 回标签列表。 */
const showEdit = ref(false)
function onTagRenamed(newTag) {
  router.replace({ name: 'tag-images', params: { tag: newTag } })
}
function onTagDeleted() {
  router.replace('/tags')
}
/** 面包屑悬停复制(2026-10-20): 复制当前标签名, 省得划选文字 Ctrl+C */
function copyTag(t) {
  if (!t) return
  ui.copy(t)
  ui.ok(`📋 已复制标签: ${t}`, 'ok', 1400)
}
</script>

<template>
  <div class="tag-images-view">
    <div class="head">
      <div class="crumb">
        <span class="link" @click="backToTags">全部标签</span>
        <span class="sep">&gt;</span>
        <span class="crumb-item">
          <span class="now">{{ tag }}</span>
          <button class="crumb-copy" :title="`复制标签名(${tag})`" @click="copyTag(tag)">📋</button>
        </span>
      </div>
      <span class="spacer" />
      <TvButton size="sm" variant="secondary" title="改名(全库替换)或删除(可圈范围)这个标签" @click="showEdit = true">✏️ 编辑标签</TvButton>
    </div>

    <div class="panel body">
      <div class="bar">
        <b class="cnt">{{ nfmt(feed.total.value) }}</b>
        <span class="hint">条匹配</span>
        <span class="hint faint">点大图里的标签可以继续往下跳 · 悬停标签点 📋 只复制这一个</span>
        <span class="spacer" />
        <TvSafetyToggle :counts="feed.unsafe.value" />
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
        <TvButton size="sm" variant="secondary" @click="backToTags">← 返回标签列表</TvButton>
      </div>

      <!-- (来源|扫描夹) 分段筛选: 与标签列表页共用同一份档位/选择, 点标签跳进来不断档 -->
      <TvSourceScanBar class="filter-row" />

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
          @open="(it) => lb.open(it.path, { list: imgPaths })"
          @toggle-fav="toggleFav"
          @load-more="feed.loadMore"
          @hover="({ text, event }) => ui.showTip(text, event)"
          @move="ui.moveTip"
          @leave="ui.hideTip"
        />
      </div>
    </div>

    <TvTagEditModal
      v-model="showEdit"
      :tag="tag"
      :count="feed.total.value"
      @renamed="onTagRenamed"
      @deleted="onTagDeleted"
    />
  </div>
</template>

<style scoped>
.tag-images-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}
.head { display: flex; align-items: center; flex: 0 0 auto; }
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .link { color: var(--accent); cursor: pointer; }
.crumb .link:hover { text-decoration: underline; }
.crumb .now { color: var(--text); word-break: break-all; }
.crumb .sep { color: var(--faint); }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
/* 筛选行: 夹在工具栏和图片流之间, 不随滚动 */
.filter-row { flex: 0 0 auto; margin-bottom: 10px; }
.hint { color: var(--muted); font-size: 12px; }
.cnt { color: var(--accent); font-size: 16px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
</style>
