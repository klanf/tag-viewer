<script setup>
/**
 * 顶栏 —— 品牌 / 导航 / 数据集数字 / 数据目录 / 购物车 / 主题
 * ========================================================
 * 旧版每个页面都在 header 里手写自己的按钮与返回链接(index.html 只有"扫描文件夹"
 * 一个链接, series/tags/cart 各写"回首页", 互相之间没有直达路径)。
 * 这里统一成一个导航条, 各视图互相可达。
 *
 * 2026-10-01 用户反馈: 看板的「只看收藏」模式和 ❤ 入口整个去掉 ——
 * 收藏本身还在(图片 ★ / 光箱 ☆ / ⭐收藏页), 只是不再有"看板只显示收藏"这个模式。
 *
 * 注意: 这里显示的数字是**数据集总量**(不随来源筛选变化) ——
 * 带来源筛选的统计在首页左栏, 两者语义不同, 不要混。
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import TvButton from '../base/TvButton.vue'
import { useAppStore, APP_THEMES } from '@/stores/useAppStore.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useRoute, useRouter } from 'vue-router'
import { runFloatBack } from '@/composables/useFloatBack.js'
import { nfmt } from '@/utils/format.js'
import { api } from '@/utils/api.js'
import { openAppSettings } from '@/composables/useAppSettings.js'

const app = useAppStore()
const cart = useCartStore()
const ui = useUiStore()
const route = useRoute()
const router = useRouter()

/* 返回按钮搬到左上角(2026-10-23 用户拍板): 顺着浏览器/大多数桌面软件的习惯。
 * 判定与原来的右下角浮动键完全一致 —— history.state.back 有值才可用;
 * 视图内部的层级(系列: 图片→角色→系列, 扫描: 图片→文件夹)仍由 runFloatBack 接管。
 * 始终占位(不可用时只隐藏), 免得上一条/下一条路由之间整个顶栏内容左右跳。 */
const canBack = ref(false)
function refreshBack() { canBack.value = !!window.history.state?.back }
function back() {
  if (runFloatBack()) return
  router.back()
}
watch(() => route.fullPath, refreshBack)
onMounted(() => {
  refreshBack()
  window.addEventListener('popstate', refreshBack)
})
onBeforeUnmount(() => window.removeEventListener('popstate', refreshBack))

/* 2026-10-04: 「来源」曾在这里占一格, 用户反馈不常用(要改开关/追平时才进),
 * 已挪到**扫描页标题旁**的按钮 —— 那两处本来就是同一类操作(管目录),
 * tab 栏 7→6 项, 让常用的位置更宽。路由 /sources 保留, 入口在 ScanView。 */
const NAV = [
  { to: '/', label: '看板', icon: '📊' },
  { to: '/series', label: '系列', icon: '🗂️' },
  { to: '/tags', label: '标签', icon: '🏷️' },
  { to: '/scan', label: '扫描', icon: '📂' },
  { to: '/favs', label: '收藏', icon: '⭐' },
  { to: '/cart', label: '购物车', icon: '🛒' },
]

/* 子页面也要点亮父导航: 在 /tags/xxx(某个标签的图片)时「标签」应保持选中 ——
   它就是标签页的下一级。根路径要单独判, 否则 '/' 会把所有路径都前缀匹配上。 */
function isOn(to) {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(to + '/')
}

const totals = computed(() => {
  const s = app.stats || {}
  return { images: s.records ?? 0, tags: s.tags ?? 0, series: s.series ?? 0 }
})

function toggleFavFilter() {
  fav.onlyFav = !fav.onlyFav
  ui.ok(fav.onlyFav
    ? '📌 已开启「只看收藏」, 首页结果只显示收藏的图片'
    : '已关闭「只看收藏」', 'info', 1800)
  // 首页在监听 onlyFav 变化, 会自己重搜; 其他视图只影响首页, 这里顺手带回去
  if (route.path !== '/') router.push('/')
}

/* ---- 主题色板(2026-10-01): 顶栏 ☀/🌙 二态按钮扩成 5 套主题下拉色板。
   点外面收起 —— 挂在 window 上的捕获监听, 点在色板容器外就关。 */
const showThemes = ref(false)
const themeWrap = ref(null)
function onDocClick(e) {
  if (showThemes.value && themeWrap.value && !themeWrap.value.contains(e.target)) showThemes.value = false
}
function pickTheme(key) {
  app.setTheme(key)
  showThemes.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

async function openDataDir() {
  try { await api.openPath('') } catch (e) { ui.err(e.message) }
}
</script>

<template>
  <header class="hdr">
    <!-- 左上角返回(2026-10-23): 换掉原来右下角的浮动 ←; 不可返回时只隐藏、仍占位 -->
    <button
      class="back-btn"
      :class="{ hidden: !canBack }"
      :disabled="!canBack"
      :title="canBack ? '返回上一页' : ''"
      aria-label="返回上一页"
      data-test="hdr-back"
      @click="back"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 5.5L8 12l6.5 6.5" />
        <path d="M8.2 12H20" />
      </svg>
    </button>

    <div class="brand" title="Tag 可视化看板">
      <span class="logo">🎨</span>
      <span class="name">Tag 看板</span>
    </div>

    <nav class="nav">
      <RouterLink
        v-for="n in NAV"
        :key="n.to"
        :to="n.to"
        :class="['nv', { on: isOn(n.to) }]"
      >
        <span class="ico">{{ n.icon }}</span>{{ n.label }}
        <span v-if="n.to === '/cart' && cart.count" class="badge">{{ cart.count }}</span>
      </RouterLink>
    </nav>

    <div class="spacer" />

    <div class="stats">
      <div class="stat" title="数据集里的图片总数(全部来源)">
        <b>{{ nfmt(totals.images) }}</b><span>图片</span>
      </div>
      <div class="stat" title="数据集里的标签总数">
        <b>{{ nfmt(totals.tags) }}</b><span>标签</span>
      </div>
      <div class="stat" title="识别出的系列数">
        <b>{{ nfmt(totals.series) }}</b><span>系列</span>
      </div>
    </div>

    <TvButton size="sm" variant="secondary" title="打开数据目录" @click="openDataDir">📁</TvButton>
    <!-- 设置弹窗(2026-10-15): 反推后端 / CUDA 加速提示 / 检查更新 / 阈值自定义 -->
    <TvButton size="sm" variant="secondary" title="设置" data-test="hdr-settings" @click="openAppSettings">⚙️</TvButton>
    <!-- 主题色板: 点 🎨 弹出主题圆点列表, 点选即换; 当前项打勾 -->
    <div ref="themeWrap" class="theme-wrap">
      <TvButton
        size="sm"
        variant="secondary"
        data-test="hdr-theme"
        :title="'主题: ' + (APP_THEMES.find((t) => t.key === app.theme)?.label || app.theme)"
        @click="showThemes = !showThemes"
      >🎨</TvButton>
      <div v-if="showThemes" class="theme-pop" data-test="theme-pop">
        <button
          v-for="t in APP_THEMES"
          :key="t.key"
          class="theme-opt"
          :class="{ on: app.theme === t.key }"
          type="button"
          :data-test="`theme-dot-${t.key}`"
          @click="pickTheme(t.key)"
        >
          <span class="dot" :style="{ background: t.dot }"></span>
          <span class="lbl">{{ t.label }}</span>
          <span v-if="app.theme === t.key" class="ck">✓</span>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.hdr {
  height: var(--header-h);
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 12px;
  padding: 0 14px;
  /* 跟页面背景同色(2026-10-02 用户反馈: 浅色主题下 --panel 比背景白一截,
   * 顶栏横着一条白很突兀)。内容卡片仍用 --panel, 层次靠这条边框撑。 */
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
/* 左上角返回: 34px 圆钮, 视觉重量比导航 tab 轻一档 */
.back-btn {
  flex: 0 0 auto;
  width: 30px; height: 30px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent;
  color: var(--muted); cursor: pointer;
  transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast);
}
.back-btn svg {
  width: 17px; height: 17px;
  fill: none; stroke: currentColor; stroke-width: 1.9;
  stroke-linecap: round; stroke-linejoin: round;
}
.back-btn:hover:not(:disabled) {
  color: var(--accent); border-color: var(--accent); background: var(--accent-soft);
}
.back-btn.hidden { visibility: hidden; pointer-events: none; }

.brand { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
.logo { font-size: 18px; }
.name { font-size: 15px; font-weight: 600; white-space: nowrap; }

.nav { display: flex; gap: 3px; flex: 0 0 auto; margin-left: 6px; }
.nv {
  position: relative;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 11px; border-radius: var(--r-sm);
  font-size: 13px; color: var(--muted);
  border: 1px solid transparent;
  transition: all var(--t-fast);
}
.nv:hover { color: var(--text); background: var(--panel2); text-decoration: none; }
.nv.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.ico { font-size: 13px; }
.badge {
  min-width: 16px; height: 16px; padding: 0 4px;
  background: var(--accent2); color: #08170e;
  border-radius: 8px; font-size: 10px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}

.spacer { flex: 1; min-width: 0; }

.stats { display: flex; gap: 14px; flex: 0 0 auto; }
.stat { text-align: right; line-height: 1.25; }
.stat b { display: block; font-size: 14px; color: var(--accent); }
.stat span { font-size: 10px; color: var(--muted); }

@media (max-width: 1180px) {
  .stats { display: none; }
}

/* 主题色板下拉 */
.theme-wrap { position: relative; flex: 0 0 auto; }
.theme-pop {
  position: absolute; right: 0; top: calc(100% + 6px);
  min-width: 132px; padding: 4px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r-md); box-shadow: var(--shadow-pop);
  z-index: 120;
}
.theme-opt {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 6px 8px;
  border-radius: var(--r-sm); font-size: 12px; color: var(--text);
  text-align: left;
}
.theme-opt:hover { background: var(--panel2); }
.theme-opt.on { background: var(--accent-soft); color: var(--accent); }
.theme-opt .dot {
  flex: 0 0 auto; width: 14px; height: 14px; border-radius: 50%;
  border: 1px solid var(--border-strong);
}
.theme-opt .lbl { flex: 1 1 auto; }
.theme-opt .ck { flex: 0 0 auto; font-size: 11px; }
</style>
