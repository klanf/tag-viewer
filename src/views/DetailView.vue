<script setup>
/**
 * 图片详情(独立页) —— 原 detail.html
 * ==================================
 * 与大图预览的区别: 这里是一条**可分享的固定路由** /detail?path=xxx,
 * 适合从别处(浏览器、笔记、脚本)直接跳进来; 大图预览是"随手看一眼"。
 *
 * 旧版 detail.html 没有大图缩放、没有收藏按钮, 这里保持功能对等, 只加了
 * 「在资源管理器中定位」与「复制路径」两个原版要来回切换才做到的动作。
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TvButton from '@/components/base/TvButton.vue'
import TvCheckbox from '@/components/base/TvCheckbox.vue'
import TvState from '@/components/base/TvState.vue'
import TvTagList from '@/components/tag/TvTagList.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import TvCopySplit from '@/components/tag/TvCopySplit.vue'
import TvImage from '@/components/base/TvImage.vue'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useCharCart } from '@/composables/useCharCart.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { normTags } from '@/utils/format.js'

const route = useRoute()
const router = useRouter()
const prefs = usePrefsStore()
const fav = useFavStore()
const ui = useUiStore()
const app = useAppStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()
const charCart = useCharCart()

/* 被 ban 标签的 显示/隐藏(2026-10-16): 与光箱共用设置里的 showBannedTags(默认开) */
const showBanned = computed({
  get: () => app.settings.showBannedTags !== false,
  set: (v) => app.setSetting('showBannedTags', v),
})

const path = computed(() => String(route.query.path || ''))
const data = ref(null)
const zhMap = ref({})
const loading = ref(false)
const error = ref('')

async function load() {
  const p = path.value
  if (!p) { error.value = '缺少 path 参数'; data.value = null; return }
  loading.value = true
  error.value = ''
  data.value = null
  zhMap.value = {}
  try {
    const d = await api.tagsForPath(p)
    if (d?.error) { error.value = `找不到这张图片的标签: ${d.error}`; return }
    data.value = d
    const tags = d.tags || []
    if (tags.length) {
      try { zhMap.value = await api.translate(tags) } catch { zhMap.value = {} }
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch(path, load, { immediate: true })

const tags = computed(() => data.value?.tags || [])
const needBg = computed(() => !!data.value?.needs_bg)
const bgAppend = computed(() => data.value?.bg_append || [])
const isFav = computed(() => (path.value ? fav.isFav(path.value) : false))

function maybeAddBg(list) {
  return prefs.maybeAddBg(list, needBg.value, bgAppend.value)
}

async function copyAll() {
  await ui.copy(normTags(maybeAddBg(tags.value)).join(', '))
}

async function copyNoBan() {
  const banMap = data.value?.ban_map || {}
  const kept = tags.value.filter((t) => !(banMap[t] || {}).banned)
  const removed = tags.value.length - kept.length
  const note = (prefs.bgAuto && needBg.value && bgAppend.value.length)
    ? `, 补背景 ${bgAppend.value.join('/')}` : ''
  await ui.copy(normTags(maybeAddBg(kept)).join(', '))
  ui.ok(`✅ 已复制(剔除 ${removed} 个被 ban 标签${note})`, 2400)
}

async function toggleBan(tag) {
  try {
    const r = await api.blacklistToggle(tag)
    if (r.action === 'wildcard') {
      ui.warn(r.warning || `该标签被通配规则 ${r.ban_rule} 命中, 需在黑名单里手动修改`, 4000)
      return
    }
    if (data.value?.ban_map) {
      data.value.ban_map[tag] = { banned: !!r.banned, rule: r.banned ? tag.toLowerCase() : '' }
    }
    ui.ok(r.banned ? `🚫 已 ban: ${tag}` : `已取消 ban: ${tag}`, 1600)
  } catch (e) {
    ui.err('操作失败: ' + e.message)
  }
}

function toggleFav() {
  const added = fav.toggle(path.value, tags.value)
  ui.ok(added ? '★ 已收藏' : '已取消收藏', 1200)
}

async function reveal() {
  try { await api.revealPath(path.value) } catch (e) { ui.err(e.message) }
}

function back() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

/**
 * 点标签 = 去标签页看这个标签的图片(与光箱、标签页同一个入口)。
 * 复制单个标签改点 pill 上的 📋。
 * 这里不用像光箱那样提示"库外图片": 本页的标签查自标签库
 * (query.js 的 getTagsForPath 对库外图直接返回 not found), 跳过去必有结果。
 */
function gotoTag(tag) {
  if (!tag) return
  router.push({ name: 'tag-images', params: { tag } })
}

/* 复制模式下拉(2026-09-20, 与光箱同一组件): 菜单项点击 = 切模式并立即复制 */
const copyModes = [
  { key: 'all', label: '全部标签', menu: '复制全部标签', title: '复制这张图的全部标签' },
  { key: 'noban', label: '去ban复制', menu: '去ban 复制(剔除被 ban 的, 与导出一致)', title: '复制标签, 剔除被 ban 的(与导出一致)' },
]
const copyMode = ref('all')
function runCopy(key) {
  if (key === 'noban') copyNoBan()
  else copyAll()
}
</script>

<template>
  <div class="detail">
    <div class="top">
      <TvButton variant="secondary" @click="back">← 返回</TvButton>
      <div class="path" :title="path">{{ path }}</div>
      <TvButton size="sm" variant="secondary" @click="reveal">📁 定位</TvButton>
      <TvButton size="sm" variant="secondary" @click="ui.copy(path, '已复制路径')">📋 复制路径</TvButton>
      <TvButton
        size="sm"
        variant="fav"
        :active="isFav"
        @click="toggleFav"
      >{{ isFav ? '★ 已收藏' : '☆ 收藏' }}</TvButton>
      <TvSafetyToggle />
    </div>

    <div class="main">
      <div class="img-box">
        <TvImage v-if="path" :path="path" :width="0" ratio="auto" contain :alt="path" />
        <TvState v-else state="empty" text="没有指定图片" />
      </div>

      <div class="side">
        <div class="panel">
          <div class="btns">
            <TvCopySplit
              v-model="copyMode"
              :modes="copyModes"
              @run="runCopy"
            />
          </div>

          <div class="checks">
            <TvCheckbox v-model="prefs.bgAuto" label="🌄 缺背景时补背景标签(复制)" />
            <TvCheckbox v-model="showBanned" label="显示被 ban 标签" />
            <span v-if="needBg" class="badge">该图缺背景 · 补 {{ bgAppend.join('/') }}</span>
          </div>

          <TvState v-if="loading" state="loading" size="sm" text="加载标签..." inline />
          <TvState v-else-if="error" state="error" size="sm" :text="error" inline />

          <template v-else>
            <h2>标签(<span class="cnt">{{ tags.length }}</span>个, 点标签看该标签的图 · 📋 复制)</h2>
            <TvTagList
              class="tag-list"
              :tags="tags"
              :zh-map="zhMap"
              :ban-map="data?.ban_map || {}"
              show-ban
              :hide-banned="!showBanned"
              copyable
              cartable
              :cart-tags="charCart.cart.keys"
              :grouped="app.settings.groupedTags !== false"
              action="filter"
              size="sm"
              max-height="60vh"
              @click="({ tag }) => gotoTag(tag)"
              @copy="(tag) => ui.copy(tag)"
              @cart="(tag) => charCart.toggle(tag, zhMap[tag] || '')"
              @ban="toggleBan"
              @hover="({ zh, event }) => ui.showTip(zh, event)"
              @leave="ui.hideTip"
            />
            <div class="hint">
              🟢 绿 = 角色 · 🟣 紫 = 系列 · 🔴 红 = 画师 · 🔵 蓝 = 人数 · 点标签跳去它的图片列表 · 悬停标签点 📋 可只复制这一个 · 灰色删除线 = 已 ban
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.top {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.path {
  flex: 1; min-width: 0;
  color: var(--muted); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.main {
  flex: 1 1 auto; min-height: 0;
  display: flex; gap: 16px;
  padding: 16px;
  overflow: hidden;
}
.img-box {
  flex: 1; min-width: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg);
  padding: 10px;
  overflow: hidden;
}
.img-box :deep(.tv-img) { width: 100%; height: 100%; background: transparent; }
.img-box :deep(img) { object-fit: contain; }

.side { width: 420px; flex: 0 0 420px; min-width: 0; overflow-y: auto; }
.panel { padding: 14px; }

.btns { display: flex; gap: 8px; }
.btns :deep(.tv-btn) { flex: 1; }
.checks {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 10px 0 12px;
}
.badge {
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  background: var(--warn-soft); color: var(--warn);
}
h2 { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.cnt { color: var(--accent); }
.tag-list { max-height: 60vh; }
.hint { color: var(--muted); font-size: 11px; margin-top: 10px; line-height: 1.7; }

@media (max-width: 1100px) {
  .main { flex-direction: column; }
  .side { width: 100%; flex: 1 1 auto; }
}
</style>
