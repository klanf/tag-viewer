<script setup>
/**
 * 角色购物车(独立页) —— 原 cart.html
 * ================================
 * 数据与动作全在 useCartStore 里, 这一页只是它的一个"铺开"视图。
 * 结算弹窗 / 历史弹窗与抽屉里的是**同一个组件**, 不再有两份逻辑。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TvCartItem from '@/components/cart/TvCartItem.vue'
import TvCheckoutModal from '@/components/cart/TvCheckoutModal.vue'
import TvHistoryModal from '@/components/cart/TvHistoryModal.vue'
import TvCartPresetModal from '@/components/cart/TvCartPresetModal.vue'
import TvCartExtraModal from '@/components/cart/TvCartExtraModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvInput from '@/components/base/TvInput.vue'
import TvState from '@/components/base/TvState.vue'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { stripZhSeries } from '@/utils/format.js'
import { useCartPresetBadge } from '@/composables/useCartPresetBadge.js'
import TvReplaceSetPicker from '@/components/export/TvReplaceSetPicker.vue'

const cart = useCartStore()
const ui = useUiStore()
/** 安全模式(全局一个开关): 本页只用它过滤要显示的图片 */
const safety = useSafetyStore()
const router = useRouter()

const showCheckout = ref(false)
const showHistory = ref(false)
const showPreset = ref(false)
const busy = ref(false)
/** 「自动导出」的状态点(绿=已同步 / 橙=有更新待导) —— 与抽屉共用一份 */
const { on: presetOn, lag: presetLag, refresh: refreshPreset, title: presetTitle } = useCartPresetBadge()
onMounted(() => { void refreshPreset() })
function onPresetClose(v) {
  showPreset.value = v
  if (!v) void refreshPreset()
}

/* ---------------- 搜索 ---------------- */
const kw = ref('')

/* ---------------- 汉化 ----------------
 * 角色/系列名批量查中文(同一套翻译库), 查不到的回退英文原文。 */
const zhMap = ref({})          // 完整角色标签 -> 中文(可能带系列尾巴)
const seriesZhMap = ref({})    // 系列英文名 -> 中文

onMounted(async () => {
  const tags = cart.list.map((i) => i.tag)
  if (tags.length) {
    try { zhMap.value = { ...zhMap.value, ...await api.translate(tags) } } catch { /* 忽略 */ }
  }
  const sers = [...new Set(cart.list.map((i) => i.series).filter(Boolean))]
  if (sers.length) {
    try { seriesZhMap.value = { ...seriesZhMap.value, ...await api.translate(sers) } } catch { /* 忽略 */ }
  }
})

/** 角色显示名: 完整标签的中文剥掉系列尾巴, 没翻译就回退 name/tag */
function displayName(it) {
  const full = zhMap.value[it.tag] || ''
  return stripZhSeries(full) || it.name || it.tag
}
/** 系列显示名 */
function seriesLabel(en) {
  if (!en) return '(无系列)'
  return seriesZhMap.value[en] || en
}

/** 按系列分组(排序与旧版 cart.html 一致: 系列 -> 角色名); 含搜索过滤与汉化 */
const grouped = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const kRaw = kw.value.trim()
  const arr = cart.list.filter((it) => {
    if (!k) return true
    const zh = zhMap.value[it.tag] || ''
    const serZh = it.series ? (seriesZhMap.value[it.series] || '') : ''
    return (it.name || '').toLowerCase().includes(k)
      || (it.tag || '').toLowerCase().includes(k)
      || (it.series || '').toLowerCase().includes(k)
      || (zh && zh.toLowerCase().includes(k))
      || (serZh && serZh.includes(kRaw))
  })
  arr.sort((a, b) => (
    String(a.series || '').localeCompare(String(b.series || ''))
    || String(a.name || '').localeCompare(String(b.name || ''))
  ))
  const m = new Map()
  for (const it of arr) {
    const key = it.series || ''
    if (!m.has(key)) m.set(key, { key, label: seriesLabel(it.series), items: [] })
    m.get(key).items.push({ ...it, name: displayName(it), series: seriesLabel(it.series) })
  }
  return [...m.values()]
})

const filteredCount = computed(() => grouped.value.reduce((n, g) => n + g.items.length, 0))

async function exportAll() {
  if (!cart.count) { ui.warn('购物车是空的'); return }
  busy.value = true
  try {
    const r = await cart.exportFile(true)
    if (r?.canceled) { ui.toast('已取消导出', 'info'); return }
    if (r?.error) { ui.err(r.error); return }
    ui.ok(`✅ 已导出 ${r.count} 个角色(wildcard) → ${r.path}`, 3000)
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

/* 编辑条目的「附加标签」(如给哥伦比亚加 closed_eyes, 导出同行拼上) */
const showExtra = ref(false)
const extraItem = ref(null)
function editExtra(it) { extraItem.value = it; showExtra.value = true }

/** 点购物车条目 = 去看这个角色的图集(2026-10-06, 与系列页"点角色看图"同语义) ——
 *  以前是直接开光箱(只看得见封面那一张), 用户指出不合理; 光箱从图集里点任意一张进。 */
function openItem(it) {
  router.push({ name: 'tag-images', params: { tag: it.tag } })
}

async function reveal(it) {
  if (!it.thumb) return
  try { await api.revealPath(it.thumb) } catch (e) { ui.err(e.message) }
}
</script>

<template>
  <div class="cart-view">
    <div class="panel head">
      <div class="ttl">
        🛒 角色购物车
        <span class="sub">从各系列收集的角色, 可随时删除; 导出为 wildcard 随机抽角色</span>
      </div>
      <span class="spacer" />
      <TvSafetyToggle />
      <TvButton variant="secondary" @click="router.push('/series')">← 回系列浏览</TvButton>
      <TvReplaceSetPicker v-model="cart.replaceSet" />
      <TvButton variant="success" :loading="busy" :disabled="!cart.count" @click="exportAll">⬇ 导出全部</TvButton>
      <TvButton variant="warn" :disabled="!cart.count" @click="showCheckout = true">💳 结算</TvButton>
      <TvButton variant="primary" @click="showHistory = true">🕘 历史记录</TvButton>
      <!-- 购物车这份是**独立于「导出预设」的一份预设**(只有一个, 不需要筛选快照):
           有更新就按延迟自动覆盖导一份到指定目录 —— 省掉每次「另存为」挑目录 -->
      <TvButton variant="secondary" :title="presetTitle()" @click="showPreset = true">
        ⚙ 自动导出<i v-if="presetOn" class="dot" :class="{ lag: presetLag }" />
      </TvButton>
      <TvButton variant="danger" :disabled="!cart.count" @click="clearAll">🗑 清空</TvButton>
    </div>

    <div class="panel body">
      <div class="count-row">
        <div class="count">
          共 <b>{{ cart.count }}</b> 个角色<template v-if="kw.trim()">, 匹配 <b>{{ filteredCount }}</b> 个</template>
        </div>
        <TvInput v-model="kw" size="sm" placeholder="🔍 搜索角色 / 系列(中英文)" class="kw" />
      </div>

      <TvState
        v-if="!cart.count"
        state="empty"
        text="购物车是空的, 去系列浏览里点 🛒 加入角色吧"
      />
      <TvState
        v-else-if="!grouped.length"
        state="empty"
        text="没有匹配的角色, 换个关键词试试"
      />

      <div v-else class="groups">
        <div v-for="g in grouped" :key="g.key" class="group">
          <div class="g-head">
            {{ g.label }}
            <span class="faint">{{ g.items.length }} 个</span>
          </div>
          <div class="grid">
            <div
              v-for="it in g.items"
              :key="it.tag"
              @dblclick="reveal(it)"
            >
              <TvCartItem :item="it" @remove="(t) => cart.remove(t)" @open="openItem" @edit="editExtra" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <TvCheckoutModal v-model="showCheckout" />
    <TvHistoryModal v-model="showHistory" />
    <TvCartPresetModal :model-value="showPreset" @update:model-value="onPresetClose" />
    <TvCartExtraModal v-model="showExtra" :item="extraItem" />
  </div>
</template>

<style scoped>
/* 「⚙ 自动导出」开着时的状态点: 绿 = 已同步, 橙 = 有更新还没导出去(与抽屉同一套) */
.dot {
  display: inline-block; width: 6px; height: 6px; margin-left: 5px;
  border-radius: 50%; background: var(--accent2); vertical-align: middle;
}
.dot.lag { background: var(--warn); }

.cart-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 14px; flex: 0 0 auto; }
.ttl { font-size: 15px; font-weight: 600; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sub { font-size: 11px; color: var(--muted); font-weight: 400; }

.body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }
.count-row {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-bottom: 10px;
}
.count { color: var(--muted); font-size: 12px; }
.count b { color: var(--accent); }
.kw { flex: 0 1 280px; }

.group { margin-bottom: 18px; }
.g-head {
  font-size: 13px; font-weight: 600; color: var(--text);
  border-bottom: 1px dashed var(--border);
  padding-bottom: 6px; margin-bottom: 10px;
  display: flex; gap: 8px; align-items: baseline;
}
.faint { color: var(--faint); font-size: 11px; font-weight: 400; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
</style>
