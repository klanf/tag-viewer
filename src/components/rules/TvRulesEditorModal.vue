<script setup>
/**
 * 规则编辑器 —— 黑名单 / 替换规则共用一个弹窗
 * ==========================================
 * 旧版是两块几乎一模一样的 DOM(.bl-mask + textarea + 保存/取消),
 * 只有标题、提示文案、两个接口不同。这里用 kind 区分。
 *
 * 规则语法(两侧一致, 用户已经习惯):
 *   精确  red_hair      后缀  *_hair      前缀  blue_*      包含  *color*
 *   # 开头是注释; 替换规则写成 模式 -> 替换后(可多个, 逗号分隔)
 *   替换侧可写 {tag} 引用原标签(如 *_painting -> {tag}, best_quality)
 *   @xxx@ = 整段匹配(按 _ 切段), 如 @boy@ -> {tag}, male_focus; # 仍是注释
 *
 * 替换规则**分组**(2026-10-04): 用户不同导出目的要不同替换方案, 于是规则可以
 * 手动命名多套、导出时选哪一套(看板 / 预设 / 角色表都能选)。黑名单不分组。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvChip from '../base/TvChip.vue'
import TvInput from '../base/TvInput.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** blacklist | replace */
  kind: { type: String, default: 'blacklist' },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const ui = useUiStore()

const text = ref('')
const rules = ref([])
const bg = ref(null)
const loading = ref(false)
const saving = ref(false)

/* ---- 替换规则组 ---- */
const sets = ref([])          // [{id, name, text}]
const activeId = ref('')      // 正在编辑哪一组
/* 就地表单状态(新建/改名共用一个输入框)。
 * **绝不用 window.prompt**: Electron 渲染进程不支持它, 静默返回 null,
 * 表现为"点了没反应"(2026-10-04 用户实测)。同理也不用 window.confirm ——
 * 弹出来会把原生 select 的 GPU 合成状态搞坏, 之后下拉点不开。 */
const editing = ref(null)     // { id, name } | null; id='' 表示新建
/** 当前编辑的组对象(直接改它的 text —— 切组前不用手动同步, 也不会丢改动) */
const cur = computed(() => sets.value.find((s) => s.id === activeId.value) || null)
const defaultId = ref('')

const isBlack = computed(() => props.kind === 'blacklist')
const title = computed(() => (isBlack.value ? '🚫 导出黑名单' : '🔁 导出替换规则'))

const tips = computed(() => (isBlack.value
  ? ['每行一条规则(用下划线), 导出时自动剔除命中的标签',
     'red_hair 精确 · *_hair 后缀 · blue_* 前缀 · *color* 包含 · # 注释',
     '@xxx@ 整段匹配: @boy@ 命中 boy / xx_boy / boy_xx, 但不命中 tomboy / boyish / xxxboy',
     '  段里也能用 *: @boy*@ 段以 boy 开头 · @*hair@ 段以 hair 结尾']
  : ['每行一条: 模式 -> 替换后的标签(可多个, 逗号分隔); # 注释',
     '替换侧写 {tag} = 命中时的原标签(大小写不敏感), 用一条规则就能"留下来再追加"',
     '  *_painting -> {tag}, masterpiece, best_quality   给整类风格统一追质量词',
     '  *_hair     -> {tag}, hair_focus                  保留原标签 + 追加',
     '  painting   -> {tag}_art                          原标签整体改写',
     '通配同黑名单: red_* 前缀 · *_hair 后缀 · *color* 包含 · 精确 red_hair',
     '@xxx@ 整段匹配: @boy@ -> {tag}, male_focus 只对"boy 是独立段"的标签生效',
     '  段里也能用 *: @boy*@ 段以 boy 开头 · @*hair@ 段以 hair 结尾']))

const placeholder = computed(() => (isBlack.value
  ? 'red_hair\n*_hair\n@boy@\n# 这是注释'
  : '*_painting -> {tag}, masterpiece, best_quality\n@boy@ -> {tag}, male_focus'))

/** 前端数一遍当前组条数(切组时立刻能看, 不用回主进程) */
const curCount = computed(() => {
  const t = cur.value?.text || ''
  let n = 0
  for (const line of t.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#') || s.indexOf('->') < 0) continue
    if (s.slice(s.indexOf('->') + 2).split(',').map((x) => x.trim()).filter(Boolean).length) n++
  }
  return n
})

async function load() {
  loading.value = true
  try {
    if (isBlack.value) {
      const r = await api.blacklistGet()
      text.value = r.text || ''
      rules.value = r.rules || []
    } else {
      const r = await api.replaceSets()
      sets.value = (r.sets || []).map((s) => ({ ...s }))
      activeId.value = r.active || sets.value[0]?.id || ''
      rules.value = r.rules || []
    }
    // 背景补全配置顺带显示出来(只读) —— 否则用户改完黑名单
    // 会奇怪"为什么复制还是自动补了 scenery"
    if (!bg.value) { try { bg.value = await api.bgGet() } catch { bg.value = null } }
  } catch (e) {
    ui.err('读取规则失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) load() })

/* ---- 组的增删改(只在替换规则这一侧出现) ---- */

function startNew() { editing.value = { id: '', name: '' } }

function startRename() {
  const s = cur.value
  if (!s) return
  editing.value = { id: s.id, name: s.name }
}

function commitEdit() {
  const e = editing.value
  const name = (e?.name || '').trim()
  editing.value = null
  if (!e || !name) return
  if (e.id) {
    const s = sets.value.find((x) => x.id === e.id)
    if (s) s.name = name
  } else {
    const id = `set_${Date.now().toString(36)}`
    sets.value.push({ id, name, text: '' })
    activeId.value = id
  }
}

function copySet() {
  const s = cur.value
  if (!s) return
  const id = `set_${Date.now().toString(36)}`
  sets.value.push({ id, name: `${s.name} 副本`, text: s.text })
  activeId.value = id
}

/* 删除走**二次确认按钮**, 不弹窗口 —— 见 editing 状态的注释 */
const confirmDel = ref(false)
function askDel() {
  if (sets.value.length <= 1) { ui.warn('至少要保留一套替换规则'); return }
  confirmDel.value = true
}
function reallyDel() {
  const s = cur.value
  confirmDel.value = false
  if (!s) return
  const i = sets.value.indexOf(s)
  sets.value.splice(i, 1)
  if (activeId.value === s.id) activeId.value = sets.value[Math.max(0, i - 1)]?.id || sets.value[0].id
}

function setAsDefault() {
  const s = cur.value
  if (!s) return
  defaultId.value = s.id
  ui.ok(`「${s.name}」将作为默认组(导出时没特意选就用它), 保存后生效`, 2400)
}

async function save() {
  saving.value = true
  try {
    if (isBlack.value) {
      const r = await api.blacklistSave(text.value)
      if (r?.error) { ui.err('保存失败: ' + r.error); return }
      rules.value = r?.rules || rules.value
    } else {
      const r = await api.replaceSetsSave({ active: defaultId.value || activeId.value, sets: sets.value })
      if (r?.error) { ui.err('保存失败: ' + r.error); return }
      sets.value = r.sets || sets.value
      activeId.value = r.active || activeId.value
      ui.ok(`✅ 已保存 ${sets.value.length} 套规则, 立即生效`, 2000)
    }
    await api.rulesReload()
    if (isBlack.value) ui.ok('✅ 已保存, 立即生效', 2000)
    emit('saved')
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
    :title="title"
    size="md"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      <div v-for="(t, i) in tips" :key="i">{{ t }}</div>
    </div>

    <!-- 替换规则: 组切换(chips) + 增删改(就地表单, 不用 window.prompt/confirm) -->
    <div v-if="!isBlack" class="setbar">
      <div v-if="!editing" class="setrow">
        <TvChip
          v-for="x in sets"
          :key="x.id"
          :label="x.name + (x.id === defaultId ? ' ★' : '')"
          :active="x.id === activeId"
          @click="activeId = x.id"
        />
        <TvButton size="xs" variant="ghost" @click="startNew">＋ 新建</TvButton>
        <TvButton size="xs" variant="ghost" @click="startRename">✎ 改名</TvButton>
        <TvButton size="xs" variant="ghost" @click="copySet">⧉ 复制</TvButton>
        <TvButton size="xs" variant="ghost" :disabled="activeId === defaultId" @click="setAsDefault">★ 设为默认</TvButton>
        <TvButton v-if="!confirmDel" size="xs" variant="ghost" @click="askDel">🗑 删除</TvButton>
        <template v-else>
          <span class="warn-txt">确定删掉「{{ cur?.name }}」?</span>
          <TvButton size="xs" variant="warn" @click="reallyDel">确定删</TvButton>
          <TvButton size="xs" variant="ghost" @click="confirmDel = false">算了</TvButton>
        </template>
      </div>
      <div v-else class="setrow">
        <TvInput
          v-model="editing.name"
          size="sm"
          :placeholder="editing.id ? '新的组名' : '新规则组的名字'"
          @enter="commitEdit"
        />
        <TvButton size="xs" variant="primary" @click="commitEdit">确定</TvButton>
        <TvButton size="xs" variant="ghost" @click="editing = null">取消</TvButton>
      </div>
    </div>

    <div v-if="loading" class="loading">读取中...</div>
    <textarea
      v-else-if="isBlack"
      v-model="text"
      class="editor"
      spellcheck="false"
      :placeholder="placeholder"
    />
    <textarea
      v-else-if="cur"
      v-model="cur.text"
      class="editor"
      spellcheck="false"
      :placeholder="placeholder"
    />

    <div class="stat">
      <template v-if="isBlack">
        当前生效 <b>{{ rules.length }}</b> 条规则
      </template>
      <template v-else>
        本组 <b>{{ curCount }}</b> 条 · 共 <b>{{ sets.length }}</b> 套
        <span class="faint">(导出时在各导出入口选组; 不选 = 默认组)</span>
      </template>
      <template v-if="bg && bg.append && bg.append.length">
        · 🌄 缺背景时补 <b>{{ bg.append.join('/') }}</b>
        <span class="faint">(有 {{ (bg.have || []).length }} 个判定标签)</span>
      </template>
    </div>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="saving" @click="save">💾 保存</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 10px; }
.setbar {
  display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap;
  padding: 8px 10px; margin-bottom: 10px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm);
}
.setrow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; width: 100%; }
.warn-txt { font-size: 12px; color: var(--warn, #c8862a); }
.editor {
  width: 100%;
  min-height: 300px;
  background: var(--panel2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 1.65;
  resize: vertical;
  outline: none;
}
.editor:focus { border-color: var(--accent); }
.loading { color: var(--muted); font-size: 12px; padding: 20px 0; }
.stat { color: var(--muted); font-size: 11px; margin-top: 10px; }
.stat b { color: var(--accent); }
.faint { color: var(--faint); }
</style>
