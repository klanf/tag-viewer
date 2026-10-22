<script setup>
/**
 * 角色纠正 —— 改名 / 挪系列 / 屏蔽
 * ================================
 * 用户的判断存进 user_meta 的纠正层(压过括号自述与角色库推导):
 *   char_series   把角色(组里的所有写法)挪到目标系列; 选「自动」= 清除
 *   char_names    卡片显示名; 留空 = 回到 tag 短名
 *   hidden_chars  屏蔽推错的角色(系列页不出现, 图片标签本身不动)
 * 保存后主进程会重建系列索引, 所以卡片会立刻在新系列出现/从旧系列消失。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvComboBox from '../base/TvComboBox.vue'
import TvInput from '../base/TvInput.vue'
import TvButton from '../base/TvButton.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** getCharacters 返回的角色项 {tag, alt, name, images} */
  char: { type: Object, default: null },
  /** 当前系列(角色卡所在的系列) */
  series: { type: String, default: '' },
  /** [{name, zh}] 全系列列表, 给"挪到"下拉用 */
  seriesOptions: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const ui = useUiStore()

const loading = ref(false)
const saving = ref(false)
const meta = ref(null)
const alias = ref('')
const pickSeries = ref('')
const hide = ref(false)

const tags = computed(() => {
  const c = props.char
  if (!c) return []
  return [c.tag, ...(c.alt || [])].filter(Boolean)
})
const shortName = computed(() => String(props.char?.tag || '').replace(/_\([^)]*\)$/, ''))

const catOptions = computed(() => {
  const seen = new Set()
  const out = [{ value: '', label: '自动(按原识别)' }]
  for (const s of props.seriesOptions) {
    const name = String(s.name || '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ value: name, label: name, zh: s.zh || '' })
  }
  // 当前系列 / 已有纠正目标不在列表里(比如来源被过滤掉了)也要能显示
  for (const name of [props.series, pickSeries.value]) {
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push({ value: name, label: name })
    }
  }
  return out
})
const displaySeries = computed(() => {
  if (!pickSeries.value) return '自动(按原识别)'
  return catOptions.value.find((o) => o.value === pickSeries.value)?.label || pickSeries.value
})

async function load() {
  if (!props.char) return
  loading.value = true
  meta.value = null
  alias.value = ''
  pickSeries.value = ''
  hide.value = false
  try {
    const m = await api.seriesMeta()
    meta.value = m
    m.hidden_chars ||= []
    m.char_series ||= {}
    m.char_names ||= {}
    const lowered = tags.value.map((t) => t.toLowerCase())
    const ovTag = lowered.find((t) => m.char_series[t])
    if (ovTag) pickSeries.value = m.char_series[ovTag]
    const nameTag = lowered.find((t) => m.char_names[t])
    if (nameTag) alias.value = m.char_names[nameTag]
    hide.value = lowered.some((t) => m.hidden_chars.includes(t))
  } catch (e) {
    ui.err('读取角色纠正数据失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) load() })

async function save() {
  if (!meta.value || !tags.value.length) return
  saving.value = true
  try {
    const lowered = tags.value.map((t) => t.toLowerCase())
    const char_series = Object.fromEntries(lowered.map((t) => [t, pickSeries.value]))
    const char_names = Object.fromEntries(lowered.map((t) => [t, alias.value.trim()]))
    const hidden = new Set(meta.value.hidden_chars.map((t) => String(t).toLowerCase()))
    for (const t of lowered) {
      if (hide.value) hidden.add(t)
      else hidden.delete(t)
    }
    const r = await api.saveSeriesMeta({
      char_series,
      char_names,
      hidden_chars: [...hidden],
    })
    if (r?.error) { ui.err('保存失败: ' + r.error); return }
    emit('saved', {
      moved: !!pickSeries.value && pickSeries.value !== props.series,
      hidden: hide.value,
      renamed: !!alias.value.trim(),
    })
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('保存失败: ' + e.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="✏️ 纠正角色"
    size="md"
    :mask-closable="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="loading" class="loading">读取中...</div>
    <div v-else-if="!meta" class="loading">读取失败, 无法编辑</div>

    <template v-else-if="char">
      <div class="who">
        <div class="wname">{{ alias || char.name || shortName }}</div>
        <div class="wtag">{{ tags.join(' / ') }}</div>
        <div class="wmeta">当前系列: <b>{{ series }}</b> · {{ char.images || 0 }} 张图</div>
      </div>

      <div class="field">
        <div class="lab">显示名</div>
        <TvInput v-model="alias" size="sm" clearable :placeholder="shortName" />
        <div class="hint">留空 = 按 tag 自动截短名; 只影响卡片与搜索显示, 不改图片标签。</div>
      </div>

      <div class="field">
        <div class="lab">所属系列</div>
        <TvComboBox
          v-model="pickSeries"
          :options="catOptions"
          :display-value="displaySeries"
          placeholder="搜索系列(英文/中文)..."
        />
        <div class="hint">
          选另一个系列 = 把这个角色的所有写法一起挪过去; 选「自动」= 恢复括号/角色库的识别。
        </div>
      </div>

      <label class="hide-row">
        <input v-model="hide" type="checkbox">
        <span>
          屏蔽这个角色
          <span class="hint">—— 推错的角色从系列页隐藏, 也不参与系列计数; 图片标签本身不动。</span>
        </span>
      </label>

      <div class="note">
        保存会立即重建系列索引(约 1~3 秒), 卡片会从旧系列消失、出现在新系列。
      </div>
    </template>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="saving" :disabled="loading || !meta" @click="save">
        保存
      </TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.loading { color: var(--muted); font-size: 12px; padding: 16px 0; }
.who {
  background: var(--panel2); border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: 10px 12px; margin-bottom: 14px;
}
.wname { font-size: 15px; font-weight: 600; color: var(--text); }
.wtag { font-size: 11px; color: var(--muted); margin-top: 2px; word-break: break-all; }
.wmeta { font-size: 12px; color: var(--faint); margin-top: 5px; }
.wmeta b { color: var(--accent); }
.field { margin-top: 14px; }
.lab { font-size: 12px; color: var(--muted); margin-bottom: 5px; }
.hint { font-size: 11px; color: var(--faint); line-height: 1.7; margin-top: 5px; }
.hide-row {
  display: flex; align-items: flex-start; gap: 8px;
  margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border);
  font-size: 13px; color: var(--text); cursor: pointer;
}
.hide-row input { accent-color: var(--warn); margin-top: 2px; }
.hide-row .hint { display: inline; margin: 0; }
.note {
  margin-top: 14px; padding: 8px 10px;
  background: var(--warn-soft); color: var(--muted);
  border-radius: var(--r-sm); font-size: 11px; line-height: 1.7;
}
</style>
