<script setup>
/**
 * 标签浏览 —— 原 tags.html
 * =======================
 * 两个视图: 标签列表(点击看该标签的图, 🚫 切换黑名单) / 该标签的图片(分页)
 *
 * 与旧版的一个刻意差异: 旧版默认把**全部**标签一次性渲染成 DOM(limit=0),
 * 上万条 pill 一次性进 DOM 会明显卡顿。这里默认每页 300 条并给了
 * 「全部」选项 —— 想看全量依然可以, 但默认不再是"点开标签页先卡两秒"。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TvTagList from '@/components/tag/TvTagList.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvImageGrid from '@/components/image/TvImageGrid.vue'
import TvPager from '@/components/base/TvPager.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvState from '@/components/base/TvState.vue'
import { useImageFeed } from '@/composables/useImageFeed.js'
import { useFloatBack } from '@/composables/useFloatBack.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const lb = useLightboxStore()
const fav = useFavStore()
const ui = useUiStore()
const route = useRoute()
const router = useRouter()

const view = ref('list')
const kw = ref('')
const pageSize = ref(300)
const page = ref(1)
const total = ref(0)
const tags = ref([])
const loading = ref(false)
const error = ref('')

/* 两级视图是组件内状态: 标签的图片网格 -> 标签列表优先接管浮动返回,
   否则 router.back() 会跳过列表直接回上一个路由 */
useFloatBack(() => {
  if (view.value === 'images') { backToList(); return true }
  return false
})

/* ---------------- 标签列表 ---------------- */
async function loadTags(resetPage = true) {
  if (resetPage) page.value = 1
  loading.value = true
  error.value = ''
  try {
    const limit = pageSize.value
    const offset = limit > 0 ? (page.value - 1) * limit : 0
    const d = await api.allTags({ q: kw.value.trim(), offset, limit })
    total.value = d.total || 0
    tags.value = d.tags || []
  } catch (e) {
    error.value = e.message
    tags.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function gotoTagPage(p) {
  page.value = p
  loadTags(false)
  document.querySelector('.scroll')?.scrollTo({ top: 0 })
}

/** 🚫 切换: 就地更新那一条, 不重拉整页(与旧版一致) */
async function toggleBan(tag) {
  try {
    const r = await api.blacklistToggle(tag)
    if (r.action === 'wildcard') {
      ui.warn(r.warning || `该标签被通配规则 ${r.ban_rule} 命中, 需在黑名单里手动修改`, 4000)
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

/* ---------------- 图片 ---------------- */
const curTag = ref('')
const imgFeed = useImageFeed({ infinite: true, pageSize: 60 })

/** 当前图片流顺序 —— 传给大图预览做「上一张 / 下一张」 */
const imgPaths = computed(() => imgFeed.results.value.map((i) => i.path).filter(Boolean))
watch(imgPaths, (arr) => { if (lb.visible) lb.setList(arr) })
const imgSort = ref('path')
const imgPageSize = ref(60)

/* ---------------- 标签名进 URL ----------------
 * 两级视图是组件内状态, 但"现在看的是哪个标签"要写进 query(?tag=xxx) ——
 * 光箱 / 详情页点标签就是**跳到这个地址**来的, 刷新与前进后退也才停得住。
 * 两边都改 URL 就有回环风险, 所以约定: 谁主动改的, 谁把对方的 syncUrl 关掉。 */
async function showImages(tag, { syncUrl = true } = {}) {
  curTag.value = tag
  view.value = 'images'
  if (syncUrl && route.query.tag !== tag) router.replace({ query: { ...route.query, tag } })
  imgFeed.setPageSize(imgPageSize.value)
  await imgFeed.search(imgQuery())
}

function imgQuery() {
  return { q: curTag.value, match: 'contains', sort: imgSort.value }
}

function backToList({ syncUrl = true } = {}) {
  curTag.value = ''
  view.value = 'list'
  if (syncUrl && route.query.tag) {
    const q = { ...route.query }
    delete q.tag
    router.replace({ query: q })
  }
  loadTags(false)
}

/* URL 是"当前标签"的真源: 带 ?tag=xxx 进来就直接展开那组图。
 * immediate 是必须的 —— TagsView 在 keep-alive 白名单里, onMounted 只跑一次,
 * 后续从光箱跳进来(query 变、组件不重挂)全靠这个 watch。 */
watch(() => route.query.tag, (v) => {
  const tag = v ? String(v) : ''
  if (!tag) {
    if (view.value === 'images') backToList({ syncUrl: false })
    return
  }
  if (view.value === 'images' && curTag.value === tag) return   // 自己刚写进去的, 别理
  showImages(tag, { syncUrl: false })
}, { immediate: true })

function toggleFav(item) {
  const added = fav.toggle(item?.path || item, item?.tags)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 'info', 1200)
}

onMounted(() => loadTags(true))
</script>

<template>
  <div class="tags-view">
    <div class="head">
      <div class="crumb">
        <span class="link" :class="{ on: view === 'list' }" @click="backToList">全部标签</span>
        <template v-if="view === 'images'">
          <span class="sep">&gt;</span>
          <span class="now">{{ curTag }}</span>
        </template>
      </div>
      <span class="spacer" />
    </div>

    <div class="panel body">
      <!-- ============ 标签列表 ============ -->
      <template v-if="view === 'list'">
        <div class="bar">
          <div class="kw">
            <TvTagSuggestInput
              v-model="kw"
              placeholder="搜索标签... (Enter 搜索)"
              @submit="loadTags(true)"
              @pick="loadTags(true)"
            />
          </div>
          <TvButton size="sm" variant="primary" @click="loadTags(true)">搜索</TvButton>
          <TvSelect
            v-model="pageSize"
            size="sm"
            inline
            label="每页"
            :options="[
              { value: 300, label: '300' },
              { value: 1000, label: '1000' },
              { value: 0, label: '全部' },
            ]"
            @change="loadTags(true)"
          />
          <span class="hint">共 {{ nfmt(total) }} 个标签</span>
          <span class="hint faint">🚫 = 导出时剔除 · 灰色删除线 = 已 ban · 点 🚫 可切换</span>
        </div>

        <div class="scroll">
          <TvState v-if="loading" state="loading" text="加载中..." />
          <TvState v-else-if="error" state="error" :text="`加载失败: ${error}`" />
          <TvTagList
            v-else
            :tags="tags"
            show-ban
            show-count
            action="filter"
            empty-text="没有匹配的标签"
            @click="({ tag }) => showImages(tag)"
            @ban="toggleBan"
            @hover="({ zh, event }) => ui.showTip(zh, event)"
            @leave="ui.hideTip"
          />
          <TvPager
            v-if="pageSize > 0"
            :total="total"
            :page="page"
            :page-size="pageSize"
            @goto="gotoTagPage"
          />
        </div>
      </template>

      <!-- ============ 图片 ============ -->
      <template v-else>
        <div class="bar">
          <b class="cnt">{{ nfmt(imgFeed.total.value) }}</b>
          <span class="hint">条匹配</span>
          <span class="spacer" />
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
            @change="imgFeed.search(imgQuery())"
          />
          <TvSelect
            v-model="imgPageSize"
            size="sm"
            inline
            label="每页"
            :options="[60, 120, 240].map((n) => ({ value: n, label: String(n) }))"
            @change="(v) => { imgFeed.setPageSize(v); imgFeed.search(imgQuery()) }"
          />
          <TvButton size="sm" variant="secondary" @click="backToList">← 返回标签列表</TvButton>
        </div>

        <div class="scroll">
          <TvImageGrid
            :results="imgFeed.results.value"
            :loading="imgFeed.loading.value"
            :error="imgFeed.error.value"
            :loaded-once="imgFeed.loadedOnce.value"
            :infinite="true"
            :has-more="imgFeed.hasMore.value"
            favable
            :is-fav="fav.isFav"
            @open="(it) => lb.open(it.path, { list: imgPaths })"
            @toggle-fav="toggleFav"
            @load-more="imgFeed.loadMore"
            @hover="({ text, event }) => ui.showTip(text, event)"
            @move="ui.moveTip"
            @leave="ui.hideTip"
          />
        </div>
      </template>
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
.head { display: flex; align-items: center; flex: 0 0 auto; }
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .link { color: var(--accent); cursor: pointer; }
.crumb .link:hover { text-decoration: underline; }
.crumb .now { color: var(--text); }
.crumb .sep { color: var(--faint); }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.kw { width: 300px; }
.hint { color: var(--muted); font-size: 12px; }
.cnt { color: var(--accent); font-size: 16px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
</style>
