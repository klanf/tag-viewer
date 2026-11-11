<script setup>
/**
 * 自然语言语料管理(2026-11-11) —— 入口在**标签页**工具栏
 * =====================================================
 * 管的是导出时追加的「动作 / 穿搭 / 发型」短句(见 core/nl-bank.js)。
 * 用户的原话是"在 tag 页面里面加一个入口管理" —— 所以它的层级是**全局**:
 *   管的东西与导出方案无关, 换个方案、重开应用都照样生效(nl_overrides.json)。
 * 高级替换弹窗里那个关键词框仍然有效, 两者是**并集**(见 nl-overrides.mergeNlBan)。
 *
 * 两种禁用粒度在界面上要分清楚, 否则用户会疑惑"为什么点了恢复没反应":
 *   单条 —— 右边的按钮, 精确到这一句
 *   关键词 —— 下方「按关键词批量禁用」, 一次带走一批, 以后新增的语料也算
 * 被关键词禁掉的行, 单条恢复是做不到的(会影响同关键词的其它行), 按钮会说明原因。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvInput from '../base/TvInput.vue'
import TvChip from '../base/TvChip.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])

const ui = useUiStore()

const DIMS = [
  { id: '', zh: '全部' },
  { id: 'pose', zh: '动作姿势' },
  { id: 'costume', zh: '整套穿搭' },
  { id: 'hair', zh: '发型' },
]
const LEVELS = [
  { id: 'sfw', zh: '常规' },
  { id: 'soft', zh: '暗示' },
  { id: 'nsfw', zh: '露骨' },
]
const LV_ZH = { sfw: '常规', soft: '暗示', nsfw: '露骨' }
const PAGE = 120

const dim = ref('')
const level = ref('')
const kw = ref('')
const onlyDisabled = ref(false)

const items = ref([])
const total = ref(0)
const loading = ref(false)
const err = ref('')
const scrollEl = ref(null)

/* 全局统计(不受上面筛选影响): 共多少条 / 已禁多少条 —— 界面上"已禁 N"必须是真实数 */
const stat = ref({ total: 0, disabled: 0 })
/* 全局覆盖: bannedIds(单条) / bannedKeys(关键词) */
const ov = ref({ bannedIds: [], bannedKeys: [] })

async function refreshStat() {
  try {
    const s = await api.random.nlstats('')
    const ds = s?.dims || []
    stat.value = {
      total: ds.reduce((n, d) => n + (d.total || 0), 0),
      disabled: ds.reduce((n, d) => n + (d.disabled || 0), 0),
    }
  } catch { /* 统计失败不影响列表本身 */ }
}
async function refreshOverrides() {
  try { ov.value = await api.nlBank.overrides() } catch { /* 同上 */ }
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const d = await api.nlBank.list({
      dim: dim.value,
      level: level.value,
      q: kw.value.trim(),
      disabledOnly: onlyDisabled.value,
      offset: 0,
      limit: PAGE,
    })
    items.value = d.items || []
    total.value = d.total || 0
    scrollEl.value?.scrollTo({ top: 0 })
  } catch (e) {
    err.value = e.message || String(e)
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loading.value || items.value.length >= total.value) return
  try {
    const d = await api.nlBank.list({
      dim: dim.value,
      level: level.value,
      q: kw.value.trim(),
      disabledOnly: onlyDisabled.value,
      offset: items.value.length,
      limit: PAGE,
    })
    if (d.items?.length) items.value.push(...d.items)
    total.value = d.total ?? total.value
  } catch { /* 滚动补页失败就停在这, 再滚一次会重试 */ }
}

let kwTimer = null
watch(kw, () => { clearTimeout(kwTimer); kwTimer = setTimeout(load, 280) })
watch([dim, level, onlyDisabled], load)

let inited = false
watch(() => props.modelValue, async (v) => {
  if (!v) return
  if (!inited) inited = true
  // 每次打开都重拉: 期间可能在高级替换弹窗里改过关键词
  await Promise.all([refreshStat(), refreshOverrides()])
  load()
})
onBeforeUnmount(() => clearTimeout(kwTimer))

/* ---------------- 单条禁用 / 恢复 ---------------- */
const busyIds = ref(new Set())
const isBusy = (id) => busyIds.value.has(id)

async function toggleOne(it) {
  if (isBusy(it.id)) return
  if (it.byKeys?.length) {
    ui.warn(`这条是被关键词「${it.byKeys.join('、')}」整批禁用的 —— 在下面「已禁关键词」里移除这个词才能恢复`, 3600)
    return
  }
  busyIds.value.add(it.id)
  try {
    const r = it.disabled
      ? await api.nlBank.patch({ removeIds: [it.id] })
      : await api.nlBank.patch({ addIds: [it.id] })
    if (!r?.ok) { ui.err('保存失败: ' + (r?.error || '未知原因')); return }
    ov.value = r.overrides
    // 就地改, 不整表重拉(重拉会把滚动位置拉回顶部)
    const next = !it.disabled
    it.disabled = next
    it.byId = next
    if (!next && onlyDisabled.value) items.value = items.value.filter((x) => x.id !== it.id)
    total.value = Math.max(0, total.value + (onlyDisabled.value ? (next ? 0 : -1) : 0))
    refreshStat()
  } catch (e) {
    ui.err('保存失败: ' + e.message)
  } finally {
    busyIds.value.delete(it.id)
  }
}

/* ---------------- 按关键词批量 ---------------- */
const bkw = ref('')
const bkwHits = ref(null)      // 预览命中数(null = 还没预览)
const bkwBusy = ref(false)

watch(bkw, () => { bkwHits.value = null })

async function previewKw() {
  const k = bkw.value.trim()
  if (!k) { bkwHits.value = null; return }
  try {
    const d = await api.nlBank.list({ q: k, offset: 0, limit: 1 })
    bkwHits.value = d.total || 0
  } catch (e) { ui.err('预览失败: ' + e.message) }
}

async function banKw() {
  const k = bkw.value.trim()
  if (!k) return
  if (bkwHits.value === null) { await previewKw(); if (!bkwHits.value) return }
  if (!bkwHits.value) { ui.warn(`没有语料包含「${k}」`); return }
  bkwBusy.value = true
  try {
    const r = await api.nlBank.patch({ addKeys: [k] })
    if (!r?.ok) { ui.err('保存失败: ' + (r?.error || '未知原因')); return }
    ov.value = r.overrides
    ui.ok(`已禁用含「${k}」的 ${bkwHits.value} 条(以后新增的同类语料也不会被抽到)`, 2600)
    bkw.value = ''
    await Promise.all([refreshStat(), load()])
  } catch (e) {
    ui.err('保存失败: ' + e.message)
  } finally {
    bkwBusy.value = false
  }
}

async function removeKey(k) {
  try {
    const r = await api.nlBank.patch({ removeKeys: [k] })
    if (!r?.ok) { ui.err('保存失败: ' + (r?.error || '未知原因')); return }
    ov.value = r.overrides
    ui.ok(`已恢复含「${k}」的语料`, 2000)
    await Promise.all([refreshStat(), load()])
  } catch (e) {
    ui.err('保存失败: ' + e.message)
  }
}

/* 清空全部禁用(二次确认: 第一次点变文案, 3 秒内再点才执行) */
const confirmClear = ref(false)
let clearTimer = null
async function clearAll() {
  if (!confirmClear.value) {
    confirmClear.value = true
    clearTimeout(clearTimer)
    clearTimer = setTimeout(() => (confirmClear.value = false), 3000)
    return
  }
  clearTimeout(clearTimer)
  confirmClear.value = false
  try {
    const r = await api.nlBank.patch({ clear: 'all' })
    if (!r?.ok) { ui.err('清空失败: ' + (r?.error || '未知原因')); return }
    ov.value = r.overrides
    ui.ok('已清空全部禁用', 1800)
    await Promise.all([refreshStat(), load()])
  } catch (e) {
    ui.err('清空失败: ' + e.message)
  }
}

const disabledCount = computed(() => stat.value.disabled)
const hasOverride = computed(() => (ov.value.bannedIds?.length || 0) + (ov.value.bannedKeys?.length || 0) > 0)
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="自然语言语料管理"
    size="xl"
    :mask-closable="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="nl-manage">
      <div class="lead">
        导出时追加的「动作 / 穿搭 / 发型」短句从这里管。禁掉的句子不会出现在任何导出结果里，
        <b>与当前导出方案无关</b>（换方案、重开应用都生效）。
      </div>

      <!-- 工具行: 维度 / 档位 / 搜索 -->
      <div class="tools">
        <div class="tabs">
          <TvChip
            v-for="d in DIMS"
            :key="`d-${d.id}`"
            :label="d.zh"
            :active="dim === d.id"
            @click="dim = d.id"
          />
        </div>
        <div class="tabs">
          <TvChip label="全部档位" :active="level === ''" @click="level = ''" />
          <TvChip
            v-for="l in LEVELS"
            :key="`l-${l.id}`"
            :label="l.zh"
            :active="level === l.id"
            :tone="l.id === 'nsfw' ? 'danger' : (l.id === 'soft' ? 'warn' : '')"
            @click="level = l.id"
          />
        </div>
        <div class="kw">
          <TvInput
            v-model="kw"
            size="sm"
            clearable
            placeholder="搜中文 / 英文 / 分类…"
          />
        </div>
        <TvChip
          :label="onlyDisabled ? '只看已禁' : '只看已禁?'"
          :active="onlyDisabled"
          tone="danger"
          title="只列出已经被禁掉的句子, 方便核对"
          @click="onlyDisabled = !onlyDisabled"
        />
      </div>

      <!-- 统计 -->
      <div class="stat-row">
        <span class="stat">共 <b>{{ stat.total.toLocaleString() }}</b> 条</span>
        <span class="stat" :class="{ warn: disabledCount > 0 }">
          已禁 <b>{{ disabledCount.toLocaleString() }}</b> 条
        </span>
        <span v-if="onlyDisabled || kw || dim || level" class="stat faint">
          当前筛选命中 {{ total.toLocaleString() }} 条
        </span>
        <span class="grow" />
        <TvButton
          v-if="hasOverride"
          size="xs"
          :variant="confirmClear ? 'danger' : 'ghost'"
          @click="clearAll"
        >{{ confirmClear ? '确认清空全部禁用?' : '清空全部禁用' }}</TvButton>
      </div>

      <!-- 批量: 按关键词 -->
      <div class="bulk">
        <span class="bulk-lb">按关键词批量禁用</span>
        <div class="bulk-in">
          <TvInput
            v-model="bkw"
            size="sm"
            clearable
            placeholder="如 针织 / knit（含该词的句子整条不抽）"
            @enter="previewKw"
          />
        </div>
        <TvButton size="xs" variant="ghost" @click="previewKw">预览命中</TvButton>
        <TvButton
          size="xs"
          variant="danger"
          :disabled="bkwBusy || !bkw.trim()"
          @click="banKw"
        >{{ bkwHits === null ? '禁用这些' : `禁用这 ${bkwHits} 条` }}</TvButton>
        <span v-if="bkwHits !== null" class="bulk-hint">命中 {{ bkwHits }} 条</span>
      </div>

      <!-- 已禁关键词 -->
      <div v-if="ov.bannedKeys.length" class="keys">
        <span class="keys-lb">已禁关键词</span>
        <TvChip
          v-for="k in ov.bannedKeys"
          :key="k"
          :label="k"
          removable
          tone="danger"
          title="点 ✕ 恢复: 含这个词的语料全部回到池子里"
          @remove="removeKey(k)"
        />
      </div>

      <!-- 列表 -->
      <div ref="scrollEl" class="list" @scroll.passive="(e) => {
        const el = e.currentTarget
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) loadMore()
      }">
        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="err" class="empty danger">加载失败: {{ err }}</div>
        <div v-else-if="!items.length" class="empty">
          {{ onlyDisabled ? '还没有禁用任何句子' : '没有匹配的语料' }}
        </div>
        <template v-else>
          <div
            v-for="it in items"
            :key="it.id"
            :class="['row', { off: it.disabled }]"
          >
            <span :class="['lv', `lv-${it.level}`]">{{ LV_ZH[it.level] || it.level }}</span>
            <div class="txt">
              <div class="zh">{{ it.zh || it.en }}</div>
              <div class="en">{{ it.en }}</div>
              <div v-if="it.byKeys.length" class="why">
                被关键词「{{ it.byKeys.join('、') }}」禁用 · 在下方「已禁关键词」里移除才能恢复
              </div>
            </div>
            <div class="meta">
              <span class="cat">{{ it.cat }}</span>
              <span class="dim">{{ it.dimZh }}</span>
            </div>
            <TvButton
              size="xs"
              :variant="it.disabled ? 'primary' : 'ghost'"
              :disabled="isBusy(it.id)"
              :title="it.byKeys.length
                ? '被关键词整批禁用, 单条恢复做不到'
                : (it.disabled ? '恢复这条句子, 重新进入抽取池' : '禁掉这条句子, 导出时不再抽到')"
              @click="toggleOne(it)"
            >{{ it.disabled ? (it.byKeys.length ? '关键词禁用' : '恢复') : '禁用' }}</TvButton>
          </div>
          <div v-if="items.length < total" class="empty faint">下滑加载更多（{{ items.length }} / {{ total }}）</div>
        </template>
      </div>
    </div>
  </TvModal>
</template>

<style scoped>
.nl-manage { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.lead { font-size: 11.5px; line-height: 1.7; color: var(--muted); }
.lead b { color: var(--text); }

.tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tabs { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.kw { width: 230px; }
.stat-row { display: flex; align-items: center; gap: 12px; font-size: 11.5px; color: var(--muted); }
.stat b { color: var(--text); font-variant-numeric: tabular-nums; }
.stat.warn b { color: var(--danger, #c05050); }
.grow { flex: 1 1 auto; }
.faint { color: var(--faint); }
.danger { color: var(--danger, #c05050); }

.bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 7px 9px; border: 1px dashed var(--border); border-radius: 8px; background: var(--panel2); }
.bulk-lb { font-size: 11.5px; color: var(--muted); }
.bulk-in { width: 250px; }
.bulk-hint { font-size: 11px; color: var(--warn, #c8862a); }

.keys { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.keys-lb { font-size: 11.5px; color: var(--muted); }

.list {
  flex: 1 1 auto; min-height: 220px; max-height: 46vh;
  overflow-y: auto; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg, transparent);
}
.empty { padding: 22px 12px; text-align: center; font-size: 12px; color: var(--faint); }

.row {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 10px; border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: 0; }
.row.off { opacity: .55; }
.row.off .zh { text-decoration: line-through; }

.lv {
  flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
}
.lv-soft { color: var(--warn, #c8862a); border-color: var(--warn, #c8862a); }
.lv-nsfw { color: var(--danger, #c05050); border-color: var(--danger, #c05050); }

.txt { flex: 1 1 auto; min-width: 0; }
.zh { font-size: 12.5px; color: var(--text); line-height: 1.45; }
.en { font-size: 11px; color: var(--faint); line-height: 1.4; margin-top: 1px; word-break: break-word; }
.why { font-size: 10.5px; color: var(--warn, #c8862a); margin-top: 2px; }

.meta { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.cat { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.dim { font-size: 10px; color: var(--faint); white-space: nowrap; }
</style>
