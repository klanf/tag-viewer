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
 * 与旧版的一个刻意差异: 旧版默认把**全部**标签一次性渲染成 DOM(limit=0),
 * 上万条 pill 一次性进 DOM 会明显卡顿。这里默认每页 300 条并给了
 * 「全部」选项 —— 想看全量依然可以, 但默认不再是"点开标签页先卡两秒"。
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TvTagList from '@/components/tag/TvTagList.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvPager from '@/components/base/TvPager.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvState from '@/components/base/TvState.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { useUiStore } from '@/stores/useUiStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const ui = useUiStore()
const router = useRouter()

const kw = ref('')
const pageSize = ref(300)
const page = ref(1)
const total = ref(0)
const tags = ref([])
const loading = ref(false)
const error = ref('')
/** 安全模式设置台(集合就是标签集合, 所以入口放在标签页最顺) */
/* 安全模式开关自带设置弹窗(TvSafetyToggle 里), 这里不再单独持有一份 show 状态 */

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

/** 点标签 = 去下一级子页面看它的图(路由跳转, 可后退) */
function showImages(tag) {
  if (!tag) return
  router.push({ name: 'tag-images', params: { tag } })
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

onMounted(() => loadTags(true))
</script>
<template>
  <div class="tags-view">
    <div class="head">
      <div class="crumb">
        <span class="now">全部标签</span>
      </div>
      <span class="spacer" />
    </div>

    <div class="panel body">
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
        <span class="hint faint">点标签看它的图片 · 🚫 = 导出时剔除 · 灰色删除线 = 已 ban</span>
        <TvSafetyToggle />
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
.crumb .now { color: var(--text); }
.spacer { flex: 1 1 auto; }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.kw { width: 300px; }
.hint { color: var(--muted); font-size: 12px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
</style>
