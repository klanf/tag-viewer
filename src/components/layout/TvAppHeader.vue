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
import { computed } from 'vue'
import TvButton from '../base/TvButton.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useRoute } from 'vue-router'
import { nfmt } from '@/utils/format.js'
import { api } from '@/utils/api.js'

const app = useAppStore()
const cart = useCartStore()
const ui = useUiStore()
const route = useRoute()

const NAV = [
  { to: '/', label: '看板', icon: '📊' },
  { to: '/series', label: '系列', icon: '🗂️' },
  { to: '/tags', label: '标签', icon: '🏷️' },
  { to: '/scan', label: '扫描', icon: '📂' },
  { to: '/sources', label: '来源', icon: '🗄️' },
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

async function openDataDir() {
  try { await api.openPath('') } catch (e) { ui.err(e.message) }
}
</script>

<template>
  <header class="hdr">
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
    <TvButton
      size="sm"
      variant="secondary"
      :title="app.theme === 'dark' ? '切到浅色主题' : '切到深色主题'"
      @click="app.toggleTheme()"
    >{{ app.theme === 'dark' ? '☀️' : '🌙' }}</TvButton>
  </header>
</template>

<style scoped>
.hdr {
  height: var(--header-h);
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 12px;
  padding: 0 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
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
</style>
