<script setup>
/**
 * 封面挑选弹窗 —— 系列卡 / 角色卡的「🖼 自定义封面」(2026-10-06)
 * =========================================================
 * 用户点卡片上的 🖼 → 这里列出该系列/角色的图(缩略图网格) → 点一张即设为封面。
 *   · 候选由主进程 covers:candidates 给出 —— 与列表页同口径: 来源过滤照常,
 *     安全模式开着时只返回该档位下可见的图(用户拍板: 挑选窗只出安全图)。
 *   · 当前是自定义封面时, 候选里对应那张会打上「当前」标记; 「恢复默认」
 *     清掉覆盖, 回到自动挑选(安全感知的比例择优)。
 *   · 保存成功后 emit('saved'), 父组件负责刷新列表拿新封面。
 */
import { ref, watch, computed } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvState from '../base/TvState.vue'
import TvImage from '../base/TvImage.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { nfmt } from '@/utils/format.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 'series' | 'chars' */
  kind: { type: String, default: 'series' },
  /** 系列名 / 角色代表 tag */
  entityKey: { type: String, default: '' },
  /** chars 时必传: 角色所在的系列(候选与角色卡同口径) */
  series: { type: String, default: '' },
  /** 弹窗标题里显示的名字 */
  title: { type: String, default: '' },
  /** 与页面同一份来源过滤 */
  source: { type: String, default: '' },
  /** 当前的封面路径(用于在候选里标「当前」; 自动挑选的封面也传进来) */
  current: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const ui = useUiStore()
const loading = ref(false)
const error = ref('')
const items = ref([])
const total = ref(0)
const capped = ref(false)
const busy = ref('')

const head = computed(() => `🖼 自定义封面 — ${props.title || (props.kind === 'series' ? '系列' : '角色')}`)

async function load() {
  if (!props.entityKey) return
  loading.value = true
  error.value = ''
  try {
    const d = await api.coverCandidates({
      kind: props.kind,
      key: props.entityKey,
      series: props.series,
      source: props.source || undefined,
    })
    items.value = d.candidates || []
    total.value = d.total || 0
    capped.value = !!d.capped
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) load() })

async function pick(path) {
  if (busy.value) return
  busy.value = path
  try {
    const r = await api.coverSet({ kind: props.kind, key: props.entityKey, path })
    if (r?.error) { ui.err(r.error); return }
    ui.ok(`✅ 已设为自定义封面`, 1800)
    /* saved 带上所选路径: 购物车那边要同步写回自己的 thumb(系列页忽略该参数) */
    emit('saved', path)
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('设置失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}

async function reset() {
  if (busy.value) return
  busy.value = '__reset__'
  try {
    const r = await api.coverSet({ kind: props.kind, key: props.entityKey, path: '' })
    if (r?.error) { ui.err(r.error); return }
    ui.ok('已恢复自动挑选封面', 1800)
    emit('saved', '')                   // 空串 = 恢复自动挑选(购物车据此重新补挑)
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('恢复失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    :title="head"
    size="lg"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      点一张图设为该{{ kind === 'series' ? '系列' : '角色' }}的封面; 封面只在列表里当缩略图用,
      不影响图片本身。<template v-if="source">候选已按当前来源过滤。</template>
      <template v-if="capped">候选较多, 这里只列前 {{ nfmt(items.length) }} 张(共 {{ nfmt(total) }})。</template>
    </div>

    <TvState v-if="loading" state="loading" text="加载候选图..." />
    <TvState v-else-if="error" state="error" :text="`加载失败: ${error}`" />
    <TvState v-else-if="!items.length" state="empty" text="没有可选的图(可能都被安全模式藏掉了)" />
    <div v-else class="cgrid">
      <button
        v-for="c in items"
        :key="c.path"
        :class="['cand', { cur: c.path === current }]"
        :data-path="c.path"
        :data-cur="c.path === current ? '1' : '0'"
        :title="c.path === current ? '当前封面' : '点一下设为封面'"
        :disabled="!!busy"
        @click="pick(c.path)"
      >
        <TvImage :path="c.path" :width="150" ratio="3 / 4" />
        <span v-if="c.path === current" class="cur-tag">当前</span>
      </button>
    </div>

    <template #footer>
      <TvButton variant="ghost" :loading="busy === '__reset__'" @click="reset">🔄 恢复自动挑选</TvButton>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">关闭</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; margin-bottom: 10px; line-height: 1.7; }
.cgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
  max-height: 54vh;
  overflow-y: auto;
  padding: 2px;
}
.cand {
  position: relative;
  padding: 0; border: 2px solid var(--border); border-radius: var(--r-sm);
  background: var(--panel2); cursor: pointer; overflow: hidden;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.cand:hover { border-color: var(--accent); transform: translateY(-1px); }
.cand.cur { border-color: var(--accent2); }
.cur-tag {
  position: absolute; top: 4px; left: 4px; z-index: 3;
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: rgba(10, 13, 18, .82); color: var(--accent2);
}
</style>
