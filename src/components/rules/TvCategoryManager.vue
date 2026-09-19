<script setup>
/**
 * 分类管理 —— 系列归类 / 补充角色 / 隐藏分类 三个页签
 * =================================================
 * 旧版这套 UI 全靠字符串拼 DOM: comboInit('cmSeries') + comboRender + comboItemHTML +
 * comboOpen + comboFilter + comboKey 六件套, 靠 `$(id + 'Search')` 找元素,
 * 一个 id 打错就是静默失效。这里全部换成组件与 v-model。
 *
 * 数据面: GET series_meta -> 三个 tab 各自改 META -> POST series_meta 整体保存。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvTabs from '../base/TvTabs.vue'
import TvComboBox from '../base/TvComboBox.vue'
import TvInput from '../base/TvInput.vue'
import TvChip from '../base/TvChip.vue'
import TvButton from '../base/TvButton.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** [{name, category}] —— 从 series:get 的返回里拿 */
  seriesList: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const ui = useUiStore()

const tab = ref('series')
const meta = ref(null)
const zhMap = ref({})
const loading = ref(false)

/** 系列 -> 分类 */
const pickSeries = ref('')
const pickCat = ref('')
/** 新增分类名 */
const newCat = ref('')
/** 补充角色 */
const charSeries = ref('')
const charTag = ref('')

const DEFAULT_LABELS = { game: '游戏', anime: '动漫', vtb: 'Vtuber', other: '其他' }

const labels = computed(() => ({ ...DEFAULT_LABELS, ...(meta.value?.category_labels || {}) }))

const catOptions = computed(() => {
  const all = ['game', 'anime', 'vtb', 'other', ...(meta.value?.custom_categories || [])]
  return all.map((c) => ({ value: c, label: labels.value[c] || c }))
})

const seriesOptions = computed(() => props.seriesList.map((s) => ({
  value: s.name,
  label: s.name,
  zh: zhMap.value[s.name] || '',
  note: labels.value[s.category] || s.category,
})))

const seriesForChar = computed(() => props.seriesList.map((s) => ({
  value: s.name,
  label: s.name,
  zh: zhMap.value[s.name] || '',
})))

const displaySeries = computed(() => seriesOptions.value.find((o) => o.value === pickSeries.value)?.label || '')
const displayCat = computed(() => catOptions.value.find((o) => o.value === pickCat.value)?.label || '')
const displayCharSeries = computed(() => seriesForChar.value.find((o) => o.value === charSeries.value)?.label || '')

const tabs = [
  { value: 'series', label: '系列归类' },
  { value: 'char', label: '补充角色' },
  { value: 'hide', label: '隐藏分类' },
]

async function load() {
  loading.value = true
  pickSeries.value = ''
  pickCat.value = ''
  charSeries.value = ''
  charTag.value = ''
  newCat.value = ''
  try {
    meta.value = await api.seriesMeta()
    if (!meta.value.categories) meta.value.categories = {}
    meta.value.custom_categories ||= []
    meta.value.hidden_categories ||= []
    meta.value.custom_chars ||= {}
    // 系列中文名(用于中文搜索) —— 一次批量查, 失败了也不影响主流程
    try {
      const names = props.seriesList.map((s) => s.name).join(',')
      zhMap.value = names ? await api.translate(names.split(',')) : {}
    } catch { zhMap.value = {} }
  } catch (e) {
    ui.err('读取元数据失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) load() })

/** 整体保存: 与后端 patchUserMeta 的字段一一对应 */
async function save() {
  const m = meta.value
  try {
    const r = await api.saveSeriesMeta({
      categories: m.categories,
      custom_categories: m.custom_categories,
      hidden_categories: m.hidden_categories,
      custom_chars: m.custom_chars,
    })
    if (r?.error) { ui.err('保存失败: ' + r.error); return false }
    return true
  } catch (e) {
    ui.err('保存失败: ' + e.message)
    return false
  }
}

async function applySeriesCat() {
  if (!pickSeries.value || !pickCat.value) { ui.warn('请先选择系列和分类'); return }
  meta.value.categories[pickSeries.value] = pickCat.value
  if (await save()) {
    ui.ok(`已把 ${pickSeries.value} 归入 ${labels.value[pickCat.value] || pickCat.value}`)
    emit('saved')
  }
}

async function addCustomCat() {
  const name = String(newCat.value || '').trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')
  if (!name) return
  if (!meta.value.custom_categories.includes(name)) meta.value.custom_categories.push(name)
  newCat.value = ''
  if (await save()) {
    ui.ok(`已新增分类: ${name}`)
    emit('saved')
  }
}

async function delCustomCat(name) {
  if (!window.confirm(`删除分类「${labels.value[name] || name}」?该分类下的系列会回到「其他」`)) return
  meta.value.custom_categories = meta.value.custom_categories.filter((c) => c !== name)
  for (const k of Object.keys(meta.value.categories)) {
    if (meta.value.categories[k] === name) delete meta.value.categories[k]
  }
  if (await save()) { ui.ok('已删除分类'); emit('saved') }
}

async function toggleHideCat(cat) {
  const h = meta.value.hidden_categories
  const i = h.indexOf(cat)
  if (i >= 0) h.splice(i, 1)
  else h.push(cat)
  if (await save()) emit('saved')
}

async function addCustomChar() {
  if (!charSeries.value) { ui.warn('请先选择系列'); return }
  const tag = String(charTag.value || '').trim()
  if (!tag) { ui.warn('请输入角色标签'); return }
  const arr = meta.value.custom_chars[charSeries.value] || (meta.value.custom_chars[charSeries.value] = [])
  if (arr.includes(tag)) { ui.warn('该角色已经在列表里了'); return }
  arr.push(tag)
  charTag.value = ''
  if (await save()) {
    ui.ok(`已新增角色: ${tag}`)
    emit('saved')
  }
}

async function delCustomChar(seriesName, tag) {
  const arr = meta.value.custom_chars[seriesName] || []
  meta.value.custom_chars[seriesName] = arr.filter((t) => t !== tag)
  if (!meta.value.custom_chars[seriesName].length) delete meta.value.custom_chars[seriesName]
  if (await save()) { ui.ok('已移除'); emit('saved') }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="⚙️ 分类管理"
    size="lg"
    :mask-closable="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="loading" class="loading">读取中...</div>

    <template v-else-if="meta">
      <TvTabs v-model="tab" :tabs="tabs" />

      <!-- 系列归类 -->
      <div v-if="tab === 'series'" class="pane">
        <div class="row2">
          <div>
            <div class="lab">选择系列</div>
            <TvComboBox
              v-model="pickSeries"
              :options="seriesOptions"
              :display-value="displaySeries"
              placeholder="搜索系列(英文/中文)..."
            />
          </div>
          <div>
            <div class="lab">归入分类</div>
            <TvComboBox
              v-model="pickCat"
              :options="catOptions"
              :display-value="displayCat"
              placeholder="搜索分类..."
            />
          </div>
          <TvButton variant="primary" class="mt" @click="applySeriesCat">应用</TvButton>
        </div>

        <div class="sect">
          <div class="lab">自定义分类</div>
          <div class="chips">
            <TvChip
              v-for="c in meta.custom_categories"
              :key="c"
              :label="labels[c] || c"
              removable
              @remove="delCustomCat(c)"
            />
            <span v-if="!meta.custom_categories.length" class="faint">暂无自定义分类</span>
          </div>
          <div class="addline">
            <TvInput
              v-model="newCat"
              size="sm"
              placeholder="新增分类名(如: 新游戏)"
              @enter="addCustomCat"
            />
            <TvButton size="sm" variant="secondary" @click="addCustomCat">＋ 新增</TvButton>
          </div>
        </div>
      </div>

      <!-- 补充角色 -->
      <div v-else-if="tab === 'char'" class="pane">
        <div class="tip">
          标签库没识别到的角色可以在这里手动补上, 之后会出现在该系列的角色列表里(图片数为 0 也保留)。
        </div>
        <div class="row2">
          <div>
            <div class="lab">系列</div>
            <TvComboBox
              v-model="charSeries"
              :options="seriesForChar"
              :display-value="displayCharSeries"
              placeholder="搜索系列(英文/中文)..."
            />
          </div>
          <div>
            <div class="lab">角色完整标签</div>
            <TvInput v-model="charTag" size="sm" placeholder="如: xxx_(series)" @enter="addCustomChar" />
          </div>
          <TvButton variant="primary" class="mt" @click="addCustomChar">＋ 新增</TvButton>
        </div>

        <div class="sect">
          <div class="lab">已补充的角色</div>
          <div v-if="!Object.keys(meta.custom_chars).length" class="faint">还没有手动补充的角色</div>
          <div v-for="(tags, s) in meta.custom_chars" :key="s" class="char-group">
            <div class="cg-head">{{ zhMap[s] || s }} <span class="faint">{{ s }}</span></div>
            <div class="chips">
              <TvChip
                v-for="t in tags"
                :key="t"
                :label="t"
                tone="warn"
                removable
                @remove="delCustomChar(s, t)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 隐藏分类 -->
      <div v-else class="pane">
        <div class="tip">
          勾选表示「隐藏」—— 系列列表里默认不显示该分类(数据还在, 切到对应 tab 仍能看到)。
        </div>
        <div class="chips">
          <TvChip
            v-for="c in catOptions"
            :key="c.value"
            :label="labels[c.value] || c.value"
            :active="meta.hidden_categories.includes(c.value)"
            :readonly="false"
            @click="toggleHideCat(c.value)"
          />
        </div>
        <div class="hint">
          已隐藏 <b>{{ meta.hidden_categories.length }}</b> 个分类
        </div>
      </div>
    </template>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">关闭</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.loading { color: var(--muted); font-size: 12px; padding: 20px 0; }
.pane { margin-top: 12px; min-height: 260px; }
.row2 { display: flex; gap: 10px; align-items: flex-end; }
.row2 > div { flex: 1; min-width: 0; }
.mt { margin-bottom: 1px; }
.lab { font-size: 12px; color: var(--muted); margin-bottom: 5px; }
.sect { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.addline { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; max-width: 420px; }
.addline :deep(.tv-field) { flex: 1; }
.char-group { margin-bottom: 10px; }
.cg-head { font-size: 12px; color: var(--text); margin-bottom: 5px; }
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 12px; }
.hint { color: var(--muted); font-size: 12px; margin-top: 12px; }
.hint b { color: var(--accent); }
.faint { color: var(--faint); font-size: 11px; }
</style>
