<script setup>
/**
 * 规则编辑器 —— 黑名单 / 替换规则共用一个弹窗
 * ==========================================
 * 黑名单仍是纯 textarea; 替换规则升级为**双模式**(2026-10-18):
 *   构建器(默认): 每条规则一行 —— 类型下拉 + 模式联想 + 原标签三态 + 替换标签联想chips,
 *                 不用再记 * / @ / {tag} 这些符号; 注释收纳到头/尾两个注释区。
 *   原文模式:     老的 textarea, 注释随写、批量粘贴、构建器表达不了的行(raw)都在这改。
 * 两种模式共享同一份组文本: 切换/切组/保存时双向序列化(src/utils/replaceGrammar.js)。
 * 数据格式(user/replace_sets.json 的 text 字段)一字未变 —— 导出/预设/角色表无感。
 *
 * 规则语法(后端 electron/core/rules.js 为唯一真源):
 *   精确 red_hair · 前缀 blue_* · 后缀 *_hair · 包含 *color* · 整段 @boy@
 *   替换侧 {tag} 引用原标签; # 注释
 */
import { ref, computed, watch, nextTick } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvChip from '../base/TvChip.vue'
import TvInput from '../base/TvInput.vue'
import TvTagComplete from '../base/TvTagComplete.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { parseRules, serializeRules, serializeRow, MODE_OPTIONS } from '@/utils/replaceGrammar.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** blacklist | replace */
  kind: { type: String, default: 'blacklist' },
  /** 打开时预填一条新规则(标签右键「加进替换规则」入口): {core, keep} */
  prefill: { type: Object, default: null },
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
  : builderMode.value
    ? ['每行选「匹配类型」再填模式, 替换标签有联想(带中文和图片数) —— 符号交给程序生成',
       '「保留原标签」= 替换侧自动带 {tag}; 「保留+后缀」= {tag}_art 这种改写',
       '想写注释/批量粘贴/改特殊规则 → 右上角「⌨ 原文模式」']
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

/* ================= 构建器模式(替换规则专用) ================= */
const builderMode = ref(true)   // 仅替换规则侧有意义
const headNotes = ref('')       // 第一条规则前的注释(分组说明)
const tailNotes = ref('')       // 行间注释收纳到这里 + 规则后面的内容
const rows = ref([])            // 行模型数组(见 replaceGrammar.js)
const rawCount = ref(0)         // 构建器表达不了的行数(去原文模式改)

function parseCurrent() {
  const p = parseRules(cur.value?.text || '')
  headNotes.value = p.headNotes.join('\n')
  tailNotes.value = p.tailNotes.join('\n')
  rows.value = p.rows
  rawCount.value = p.rows.filter((r) => r.mode === 'raw').length
}

/** 构建器当前状态写回所在组的 text(切组/切模式/保存前调用) */
function commitToSet() {
  if (!cur.value) return
  cur.value.text = serializeRules({
    headNotes: headNotes.value.split('\n'),
    rows: rows.value,
    tailNotes: tailNotes.value.split('\n'),
  })
}

function switchMode() {
  if (builderMode.value) {
    commitToSet()               // 构建 → 原文: 先落文本
    builderMode.value = false
  } else {
    const p = parseRules(cur.value?.text || '')
    rawCount.value = p.rows.filter((r) => r.mode === 'raw').length
    headNotes.value = p.headNotes.join('\n')
    tailNotes.value = p.tailNotes.join('\n')
    rows.value = p.rows
    builderMode.value = true
  }
}

function addRow(prefill = null) {
  rows.value.push({
    mode: 'exact',
    core: prefill?.core || '',
    keep: prefill ? prefill.keep !== false : true,
    suffix: '',
    repl: [],
  })
  nextTick(() => {
    const el = document.querySelectorAll('.row-core input')
    el[el.length - 1]?.focus()
  })
}

function delRow(i) { rows.value.splice(i, 1) }

const curCount = computed(() => (builderMode.value
  ? rows.value.filter((r) => r.mode !== 'raw').length
  : (() => {
      const t = cur.value?.text || ''
      let n = 0
      for (const line of t.split('\n')) {
        const s = line.trim()
        if (!s || s.startsWith('#') || s.indexOf('->') < 0) continue
        if (s.slice(s.indexOf('->') + 2).split(',').map((x) => x.trim()).filter(Boolean).length) n++
      }
      return n
    })()))

/* ---- 规则测试器(与导出引擎同一套代码, 走后端) ---- */
const testTag = ref('')
const testRes = ref(null)
watch(testTag, async (v) => {
  const t = v.trim()
  if (!t) { testRes.value = null; return }
  try { testRes.value = await api.rulesTest({ setId: activeId.value, tag: t }) }
  catch { testRes.value = null }
})

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
  commitToSet()                 // 复制前把构建器状态落进当前组, 副本才完整
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
      parseCurrent()
      builderMode.value = true
      if (props.prefill?.core) addRow(props.prefill)
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

/* 切组: 先把旧组构建器状态落盘(内存), 再解析新组 */
watch(activeId, (nv, ov) => {
  if (isBlack.value || ov === undefined) return
  const old = sets.value.find((s) => s.id === ov)
  if (old && builderMode.value) {
    old.text = serializeRules({
      headNotes: headNotes.value.split('\n'),
      rows: rows.value,
      tailNotes: tailNotes.value.split('\n'),
    })
  }
  // 新组要等 sets 里对象就位后解析(cur 是 computed, 直接解析它)
  nextTick(() => { if (builderMode.value) parseCurrent() })
})

watch(() => props.modelValue, (v) => { if (v) load() })

async function save() {
  saving.value = true
  try {
    if (isBlack.value) {
      const r = await api.blacklistSave(text.value)
      if (r?.error) { ui.err('保存失败: ' + r.error); return }
      rules.value = r?.rules || rules.value
    } else {
      if (builderMode.value) commitToSet()
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

    <!-- ============ 黑名单: 仍是纯 textarea ============ -->
    <textarea
      v-else-if="isBlack"
      v-model="text"
      class="editor"
      spellcheck="false"
      :placeholder="placeholder"
    />

    <!-- ============ 替换规则: 构建器模式 ============ -->
    <template v-else-if="builderMode">
      <details class="notes">
        <summary>🗒 分组注释{{ headNotes.trim() ? '(有内容)' : '' }}</summary>
        <textarea v-model="headNotes" class="notes-area" spellcheck="false" placeholder="文件开头的 # 注释/分组说明, 会写在规则前面" />
      </details>

      <div class="rows">
        <div v-for="(r, i) in rows" :key="i" class="row" :class="{ raw: r.mode === 'raw' }">
          <template v-if="r.mode !== 'raw'">
            <select v-model="r.mode" class="mode-sel" title="匹配类型">
              <option v-for="m in MODE_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <TvTagComplete
              v-model="r.core"
              class="row-core"
              :placeholder="MODE_OPTIONS.find((m) => m.value === r.mode)?.example || '模式'"
            />
            <span class="arr">→</span>
            <select v-model="r.keep" class="mode-sel keep-sel" title="命中的原标签怎么处理">
              <option :value="false">丢弃原标签</option>
              <option :value="true">保留原标签</option>
            </select>
            <input
              v-if="r.keep"
              v-model="r.suffix"
              class="suffix"
              placeholder="后缀可空"
              title="保留原标签并加后缀: 填 _art 生成 {tag}_art; 留空就是原样保留"
            >
            <span class="chips">
              <span v-for="(t, j) in r.repl" :key="j" class="chip">
                {{ t }}<b class="x" title="移除" @click="r.repl.splice(j, 1)">×</b>
              </span>
              <TvTagComplete
                class="chip-add"
                placeholder="+ 联想添加…"
                @pick="(t) => { if (!r.repl.includes(t)) r.repl.push(t) }"
                @confirm="(t) => { if (!r.repl.includes(t)) r.repl.push(t) }"
              />
            </span>
          </template>
          <template v-else>
            <span class="raw-badge">高级</span>
            <span class="raw-text">{{ r.text }}</span>
            <span class="raw-hint">符号太特殊, 请切「原文模式」修改</span>
          </template>
          <span class="sp" />
          <TvButton size="xs" variant="ghost" title="删除这条规则" @click="delRow(i)">🗑</TvButton>
        </div>
        <div v-if="!rows.length" class="empty">本组还没有规则 —— 点下面添加, 或切「原文模式」粘贴</div>
        <TvButton size="xs" variant="ghost" class="add" @click="addRow()">＋ 添加规则</TvButton>
      </div>

      <details class="notes">
        <summary>🗒 其他注释{{ tailNotes.trim() ? '(有内容)' : '' }}</summary>
        <textarea v-model="tailNotes" class="notes-area" spellcheck="false" placeholder="行间注释会收纳到这里, 保存时写在规则后面" />
      </details>

      <!-- 规则测试器: 与导出引擎同一套代码(后端 rules:test) -->
      <div class="tester">
        <span class="lab">🧪 规则测试</span>
        <TvTagComplete v-model="testTag" class="test-in" placeholder="输入一个标签试试, 如 blue_hair" :limit="8" />
        <span v-if="testRes" class="test-out">
          <template v-if="testRes.hits?.length">
            命中 <b>{{ testRes.hits.map((h) => h.pat).join(' · ') }}</b>
            → <b class="ok">{{ testRes.result.join(', ') }}</b>
          </template>
          <template v-else>未命中任何规则 → 原样 <b>{{ testRes.result.join(', ') }}</b></template>
        </span>
        <span v-else-if="testTag.trim()" class="lab">测试中…</span>
      </div>
      <div class="stat faint-note">测试基于**已保存**的规则; 编辑中的改动点 💾 保存后才会参与测试</div>
    </template>

    <!-- ============ 替换规则: 原文模式 ============ -->
    <template v-else-if="cur">
      <textarea
        v-model="cur.text"
        class="editor"
        spellcheck="false"
        :placeholder="placeholder"
      />
      <div class="stat">
        本组 <b>{{ curCount }}</b> 条 · 共 <b>{{ sets.length }}</b> 套
        <TvButton size="xs" variant="ghost" class="mode-btn" @click="switchMode">▦ 构建器模式</TvButton>
      </div>
    </template>

    <!-- 构建器模式的统计/切换行 -->
    <div v-if="!isBlack && !loading && builderMode" class="stat">
      本组 <b>{{ curCount }}</b> 条<template v-if="rawCount"> · <span class="warn-txt">{{ rawCount }} 条高级规则</span></template>
      · 共 <b>{{ sets.length }}</b> 套
      <span class="faint">(导出时在各导出入口选组; 不选 = 默认组)</span>
      <TvButton size="xs" variant="ghost" class="mode-btn" @click="switchMode">⌨ 原文模式</TvButton>
      <template v-if="bg && bg.append && bg.append.length">
        · 🌄 缺背景时补 <b>{{ bg.append.join('/') }}</b>
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

/* ---- 构建器 ---- */
.notes { margin-bottom: 8px; font-size: 11px; color: var(--muted); }
.notes summary { cursor: pointer; user-select: none; }
.notes-area {
  width: 100%; min-height: 60px; margin-top: 6px;
  background: var(--panel2); color: var(--muted);
  border: 1px dashed var(--border); border-radius: var(--r-sm);
  padding: 6px 10px; font-family: Consolas, Menlo, monospace;
  font-size: 11px; line-height: 1.6; resize: vertical; outline: none;
}
.rows { display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow: auto; padding: 2px; }
.row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 6px 8px; background: var(--panel2);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.row.raw { opacity: 0.75; border-style: dashed; }
.mode-sel {
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  font-size: 11px; padding: 4px 4px; outline: none;
}
.row-core { flex: 0 1 170px; }
.row-core :deep(input) { width: 100%; }
.keep-sel { flex: 0 0 auto; }
.suffix {
  width: 92px; background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 6px; font-size: 11px; font-family: Consolas, Menlo, monospace; outline: none;
}
.arr { color: var(--faint); font-size: 12px; }
.chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; flex: 1 1 200px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: Consolas, Menlo, monospace; font-size: 11px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 2px 8px;
}
.chip .x { color: var(--faint); cursor: pointer; font-weight: normal; }
.chip .x:hover { color: var(--text); }
.chip-add { flex: 0 1 120px; }
.chip-add :deep(input) { min-width: 0; width: 100%; padding: 3px 6px; font-size: 11px; }
.raw-badge {
  font-size: 10px; color: var(--warn, #c8862a);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px;
}
.raw-text { font-family: Consolas, Menlo, monospace; font-size: 11px; }
.raw-hint { color: var(--faint); font-size: 10px; }
.sp { flex: 1; }
.empty { color: var(--faint); font-size: 12px; padding: 10px 4px; }
.add { align-self: flex-start; }

/* ---- 测试器 ---- */
.tester {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; padding: 8px 10px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm);
}
.tester .lab { font-size: 11px; color: var(--muted); white-space: nowrap; }
.test-in { flex: 0 1 200px; }
.test-out { font-size: 11px; color: var(--text); }
.test-out b { color: var(--accent); font-family: Consolas, Menlo, monospace; font-weight: normal; }
.test-out .ok { color: var(--ok, #3d9970); }
.faint-note { color: var(--faint); }
.mode-btn { margin-left: 8px; }
</style>
