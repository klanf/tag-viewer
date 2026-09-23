<script setup>
/**
 * 购物车抽屉 —— 右侧滑出, 系列浏览 / 标签页 / 首页都能唤起
 * ====================================================
 * 旧版只有 series.html 里有一个 cart-mask 弹窗, 购物车页是独立页面。
 * 现在做成全站共享的抽屉(状态在 useCartStore().drawerOpen), 不管在哪个视图
 * 都能随手看一眼、删两个、直接导出。
 */
import { computed, ref } from 'vue'
import TvButton from '../base/TvButton.vue'
import TvCartItem from './TvCartItem.vue'
import TvCheckoutModal from './TvCheckoutModal.vue'
import TvHistoryModal from './TvHistoryModal.vue'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { api } from '@/utils/api.js'

const cart = useCartStore()
const ui = useUiStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()
const lb = useLightboxStore()

const showCheckout = ref(false)
const showHistory = ref(false)
const busy = ref(false)

/** 按系列分组, 与旧版 cart.html 的排序一致(系列 -> 角色名) */
const grouped = computed(() => {
  const arr = [...cart.list].sort((a, b) => (
    String(a.series || '').localeCompare(String(b.series || ''))
    || String(a.name || '').localeCompare(String(b.name || ''))
  ))
  const m = new Map()
  for (const it of arr) {
    const k = it.series || '(无系列)'
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(it)
  }
  return [...m.entries()].map(([k, v]) => ({ series: k, items: v }))
})

function close() { cart.drawerOpen = false }

async function exportAll() {
  if (!cart.count) { ui.warn('购物车是空的'); return }
  busy.value = true
  try {
    const r = await cart.exportFile(true)
    if (r?.canceled) { ui.toast('已取消导出', 'info'); return }
    if (r?.error) { ui.err(r.error); return }
    ui.ok(`✅ 已导出 ${r.count} 个角色(wildcard)`, 2400)
  } finally {
    busy.value = false
  }
}

function clearAll() {
  if (!cart.count) return
  if (!window.confirm(`清空购物车?(${cart.count} 个角色)`)) return
  cart.clear()
  ui.ok('已清空')
}

async function openCartFile() {
  // 把购物车内容渲染成一行文本贴到剪贴板 —— 方便直接粘进 ComfyUI 的 wildcard 节点
  if (!cart.count) { ui.warn('购物车是空的'); return }
  const text = cart.list.map((c) => c.tag.replace(/\(/g, '\\(').replace(/\)/g, '\\)')).join('\n')
  await ui.copy(text, `已复制 ${cart.count} 行 wildcard`)
}

/** 点击缩略图 -> 看大图 */
/** 购物车封面的顺序 —— 光箱里可以顺着翻 */
const thumbList = computed(() => cart.list.map((i) => i.thumb).filter(Boolean))

function openItem(it) { if (it.thumb) lb.open(it.thumb, { list: thumbList.value }) }

async function revealItem(it) {
  if (!it.thumb) return
  try { await api.revealPath(it.thumb) } catch (e) { ui.err(e.message) }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="tv-drawer">
      <div v-if="cart.drawerOpen" class="mask" @click="close">
        <div class="drawer" @click.stop>
          <div class="head">
            <b>🛒 角色购物车</b>
            <span class="cnt">{{ cart.count }} 个</span>
            <button class="x" title="关闭" @click="close">×</button>
          </div>

          <div class="acts">
            <TvButton size="sm" variant="success" :loading="busy" @click="exportAll">⬇ 导出全部</TvButton>
            <TvButton size="sm" variant="warn" :disabled="!cart.count" @click="showCheckout = true">💳 结算</TvButton>
            <TvButton size="sm" variant="secondary" @click="showHistory = true">🕘 历史</TvButton>
            <TvButton size="sm" variant="primary" :disabled="!cart.count" @click="openCartFile">📋 复制</TvButton>
            <TvSafetyToggle icon-only />
            <TvButton size="sm" variant="danger" :disabled="!cart.count" @click="clearAll">🗑 清空</TvButton>
          </div>

          <div class="body">
            <div v-if="!cart.count" class="empty">
              购物车是空的<br>
              <span class="faint">去「系列浏览」里点角色卡片上的 🛒 加入角色吧</span>
            </div>
            <template v-else>
              <div v-for="g in grouped" :key="g.series" class="group">
                <div class="g-head">{{ g.series }} <span class="faint">({{ g.items.length }})</span></div>
                <div class="g-items">
                  <div
                    v-for="it in g.items"
                    :key="it.tag"
                    class="row"
                    @dblclick="revealItem(it)"
                  >
                    <TvCartItem :item="it" compact @remove="(t) => cart.remove(t)" @open="openItem" />
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div class="foot">
            <span class="faint">双击条目可在资源管理器中定位原图</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <TvCheckoutModal v-model="showCheckout" />
  <TvHistoryModal v-model="showHistory" />
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 220;
  background: var(--mask);
  display: flex; justify-content: flex-end;
}
.drawer {
  width: 420px; max-width: 92vw;
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
}
.cnt { color: var(--accent); font-size: 12px; }
.x { margin-left: auto; font-size: 22px; line-height: 1; color: var(--muted); padding: 0 4px; }
.x:hover { color: var(--text); }

.acts {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.body { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px; min-height: 0; }
.foot { padding: 8px 16px; border-top: 1px solid var(--border); font-size: 11px; }

.group { margin-bottom: 14px; }
.g-head {
  font-size: 12px; color: var(--muted); font-weight: 600;
  margin-bottom: 6px;
  border-bottom: 1px dashed var(--border);
  padding-bottom: 4px;
}
.g-items { display: flex; flex-direction: column; gap: 6px; }

.empty { color: var(--muted); text-align: center; padding: 50px 0; font-size: 13px; line-height: 2; }
.faint { color: var(--faint); font-size: 11px; }

/* 滑入动画 */
.tv-drawer-enter-active, .tv-drawer-leave-active { transition: opacity .18s ease; }
.tv-drawer-enter-from, .tv-drawer-leave-to { opacity: 0; }
.tv-drawer-enter-active .drawer, .tv-drawer-leave-active .drawer { transition: transform .2s ease; }
.tv-drawer-enter-from .drawer, .tv-drawer-leave-to .drawer { transform: translateX(100%); }
</style>
