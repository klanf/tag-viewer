<script setup>
/**
 * 规则编辑器 —— 黑名单 / 替换规则共用一个弹窗
 * ==========================================
 * 黑名单仍是纯 textarea; 替换规则为**双模式**(2026-10-18, UI v2 重排):
 *   构建器(默认): 每条规则一张**两行卡片** —— 第一行 类型+模式→导出结果预览(serializeRow
 *                 实时生成, 所见即导出); 第二行 原标签三态+替换标签联想chips。
 *                 左侧独立**组栏**(xl 弹窗 1200px), 注释/帮助/测试器分别收进
 *                 工具栏按钮与底部停靠条, 不再纵向堆叠。
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
import { parseRules, serializeRules, MODE_OPTIONS } from '@/utils/replaceGrammar.js'

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
    ? ['每条规则一张卡片: 选「匹配类型」填模式, 替换标签有联想(带中文和图片数)',
       '卡片第一行是**导出结果预览** —— 你看到的就是导出文件里会出现的文本',
       '「保留原标签」= 替换侧自动带 {tag}; 「保留+后缀」= {tag}_art 这种改写',
       '想写注释/批量粘贴/改特殊规则 → 工具栏「⌨ 原文模式」; 注释在「🗒 注释」里']
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
const hasNotes = computed(() => !!(headNotes.value.trim() || tailNotes.value.trim()))

/* 工具栏浮层 */
const helpOpen = ref(false)
const notesOpen = ref(false)

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
  helpOpen.value = false
  notesOpen.value = false
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

watch(() => props.modelValue, (v) => {
  if (v) { load(); helpOpen.value = false; notesOpen.value = false; editing.value = null; confirmDel.value = false }
})

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
    :size="isBlack ? 'lg' : 'xl'"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <!-- ============ 黑名单: 纯 textarea + 常驻提示(结构不变) ============ -->
    <template v-if="isBlack">
      <div class="tip">
        <div v-for="(t, i) in tips" :key="i">{{ t }}</div>
      </div>
      <textarea
        v-if="!loading"
        v-model="text"
        class="editor tall"
        spellcheck="false"
        :placeholder="placeholder"
      />
      <div v-if="loading" class="loading">读取中...</div>
    </template>

    <!-- ============ 替换规则: 左组栏 + 右主区 ============ -->
    <div v-else class="grid">
      <!-- 左: 组栏 -->
      <aside class="side">
        <div class="side-cap">规则组 · {{ sets.length }} 套</div>
        <div class="side-list">
          <div
            v-for="x in sets"
            :key="x.id"
            class="side-item"
            :class="{ on: x.id === activeId }"
            @click="activeId = x.id"
          >
            <div class="side-name">
              {{ x.name }}
              <span v-if="x.id === defaultId" class="star" title="默认组">★</span>
            </div>
            <div class="side-meta">
              {{ x.id === activeId ? curCount + ' 条 · 编辑中' : '已保存组' }}
            </div>
          </div>
        </div>
        <div class="side-ops">
          <template v-if="!editing && !confirmDel">
            <TvButton size="xs" variant="ghost" @click="startNew">＋ 新建</TvButton>
            <TvButton size="xs" variant="ghost" @click="startRename">✎ 改名</TvButton>
            <TvButton size="xs" variant="ghost" @click="copySet">⧉ 复制</TvButton>
            <TvButton size="xs" variant="ghost" :disabled="activeId === defaultId" @click="setAsDefault">★ 默认</TvButton>
            <TvButton size="xs" variant="ghost" @click="askDel">🗑 删除</TvButton>
          </template>
          <template v-else-if="editing">
            <TvInput
              v-model="editing.name"
              size="sm"
              :placeholder="editing.id ? '新的组名' : '新规则组的名字'"
              @enter="commitEdit"
            />
            <div class="side-ops-row">
              <TvButton size="xs" variant="primary" @click="commitEdit">确定</TvButton>
              <TvButton size="xs" variant="ghost" @click="editing = null">取消</TvButton>
            </div>
          </template>
          <template v-else>
            <span class="warn-txt">删「{{ cur?.name }}」?</span>
            <div class="side-ops-row">
              <TvButton size="xs" variant="warn" @click="reallyDel">确定删</TvButton>
              <TvButton size="xs" variant="ghost" @click="confirmDel = false">算了</TvButton>
            </div>
          </template>
        </div>
      </aside>

      <!-- 右: 主区 -->
      <div class="main">
        <!-- 工具栏: 模式切换 / 统计 / 注释 / 帮助 -->
        <div class="bar">
          <div class="seg">
            <button type="button" class="seg-b" :class="{ on: builderMode }" @click="!builderMode && switchMode()">▦ 构建器</button>
            <button type="button" class="seg-b" :class="{ on: !builderMode }" @click="builderMode && switchMode()">⌨ 原文</button>
          </div>
          <span class="bar-stat">本组 <b>{{ curCount }}</b> 条<template v-if="rawCount"> · <span class="warn-txt">{{ rawCount }} 条高级</span></template></span>
          <span v-if="!builderMode" class="bar-stat faint">直接改文本, 支持批量粘贴</span>
          <span
            class="bar-btn"
            :class="{ lit: hasNotes, open: notesOpen }"
            title="分组注释(# 开头, 保存时写在规则前/后)"
            @click="notesOpen = !notesOpen; helpOpen = false"
          >🗒 注释<i v-if="hasNotes" class="dot" /></span>
          <span
            class="bar-btn help"
            :class="{ open: helpOpen }"
            title="语法说明"
            @click="helpOpen = !helpOpen; notesOpen = false"
          >?</span>

          <!-- 浮层: 分组注释 -->
          <div v-if="notesOpen" class="pop notes-pop">
            <div class="pop-cap">开头注释(分组说明)</div>
            <textarea v-model="headNotes" class="notes-area" spellcheck="false" placeholder="文件开头的 # 注释/分组说明, 会写在规则前面" />
            <div class="pop-cap">结尾注释(行间注释收纳在这)</div>
            <textarea v-model="tailNotes" class="notes-area" spellcheck="false" placeholder="行间注释会收纳到这里, 保存时写在规则后面" />
          </div>
          <!-- 浮层: 语法帮助(先讲用途, 再逐功能) -->
          <div v-if="helpOpen" class="pop help-pop">
            <template v-if="builderMode">
              <div class="h-sec"><b>这是干嘛的</b></div>
              <div class="help-line">替换规则在<b>导出 txt 时</b>生效: 对每张图里命中的标签做改写 / 追加 / 删除。<b>不改动库内数据</b>, 同一张图用不同规则组能导出不同方案。</div>
              <div class="h-sec"><b>匹配类型(选完填模式)</b></div>
              <div v-for="m in MODE_OPTIONS" :key="m.value" class="help-line">
                <b>{{ m.label }}</b> · {{ m.hint }} · 例 <code>{{ m.example }}</code>
              </div>
              <div class="h-sec"><b>命中的原标签怎么处理</b></div>
              <div class="help-line"><b>丢弃</b> = 原标签不要了, 只留右边替换标签(不填替换标签等于没作用)</div>
              <div class="help-line"><b>保留</b> = 原标签留着(替换侧自动带 <code>{tag}</code>), 后缀可加 <code>_art</code> 这类改写</div>
              <div class="help-line"><b>删除标签</b> = 命中即整个删掉, 用来剔除不要的 tag</div>
              <div class="h-sec"><b>其他</b></div>
              <div class="help-line">🧪 测试条: 输入标签实时看命中与结果(基于<b class="u">已保存</b>规则)</div>
              <div class="help-line">🗒 注释: <code>#</code> 开头, 保存时写在规则前/后, 只给人看</div>
              <div class="help-line">⌨ 原文模式: 批量粘贴、改构建器表达不了的特殊符号规则</div>
              <div class="help-line">★ 默认组: 导出入口不特意选组时用它</div>
            </template>
            <template v-else>
              <div v-for="(t, i) in tips" :key="i" class="help-line">{{ t }}</div>
            </template>
            <div v-if="bg && bg.append && bg.append.length" class="help-line">🌄 缺背景时自动补 <b>{{ bg.append.join('/') }}</b>(背景补全设置)</div>
          </div>
        </div>

        <div v-if="loading" class="loading">读取中...</div>

        <!-- 构建器: 两行式规则卡片 -->
        <div v-else-if="builderMode" class="rows">
          <div v-for="(r, i) in rows" :key="i" class="rule-card" :class="{ raw: r.mode === 'raw' }" @click="r.mode === 'raw' && switchMode()">
            <template v-if="r.mode !== 'raw'">
              <div class="row-top">
                <select
                  v-model="r.mode"
                  class="mode-sel"
                  :title="MODE_OPTIONS.find((m) => m.value === r.mode)?.hint + ' · 例 ' + MODE_OPTIONS.find((m) => m.value === r.mode)?.example"
                >
                  <option v-for="m in MODE_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
                </select>
                <TvTagComplete
                  v-model="r.core"
                  class="row-core"
                  :placeholder="MODE_OPTIONS.find((m) => m.value === r.mode)?.example || '模式'"
                />
                <TvButton size="xs" variant="ghost" class="row-del" title="删除这条规则" @click.stop="delRow(i)">🗑</TvButton>
              </div>
              <div v-if="r.keep !== 'del'" class="row-sub">
                <span class="arr">→</span>
                <span class="lab">原标签</span>
                <select v-model="r.keep" class="mode-sel keep-sel" title="命中的原标签怎么处理">
                  <option :value="false">丢弃</option>
                  <option :value="true">保留</option>
                  <option value="del">删除标签</option>
                </select>
                <input
                  v-if="r.keep === true"
                  v-model="r.suffix"
                  class="suffix"
                  placeholder="例: _art"
                  title="保留原标签并加后缀: 填 _art 生成 {tag}_art; 留空就是原样保留"
                >
              </div>
              <div v-if="r.keep !== 'del'" class="row-sub repl-sub">
                <span class="lab">替换标签</span>
                <span v-for="(t, j) in r.repl" :key="j" class="chip">
                  {{ t }}<b class="x" title="移除" @click="r.repl.splice(j, 1)">×</b>
                </span>
                <TvTagComplete
                  class="chip-add"
                  placeholder="+ 联想添加…"
                  @pick="(t) => { if (!r.repl.includes(t)) r.repl.push(t) }"
                  @confirm="(t) => { if (!r.repl.includes(t)) r.repl.push(t) }"
                />
              </div>
              <div v-else class="row-sub del-sub">
                <span class="del-mark">命中即从导出结果中<b>删除</b>该标签 —— 不替换、不保留</span>
              </div>
            </template>
            <template v-else>
              <span class="raw-badge">高级</span>
              <code class="raw-text">{{ r.text }}</code>
              <span class="raw-hint">构建器表达不了 · 点击卡片切「原文模式」修改</span>
            </template>
          </div>
          <div v-if="!rows.length" class="empty">本组还没有规则 —— 点下面添加, 或切「原文模式」粘贴</div>
          <TvButton size="xs" variant="ghost" class="add" @click="addRow()">＋ 添加规则</TvButton>
        </div>

        <!-- 原文模式 -->
        <template v-else-if="cur">
          <textarea
            v-model="cur.text"
            class="editor tall"
            spellcheck="false"
            :placeholder="placeholder"
          />
        </template>

        <!-- 底部停靠: 规则测试条(构建器模式才有) -->
        <div v-if="builderMode && !loading" class="tester">
          <span class="lab">🧪 测试</span>
          <TvTagComplete v-model="testTag" class="test-in" placeholder="输入一个标签试试, 如 blue_hair" :limit="8" />
          <span v-if="testRes" class="test-out">
            <template v-if="testRes.hits?.length && testRes.result.length">
              命中 <b>{{ testRes.hits.map((h) => h.pat).join(' · ') }}</b>
              → <b class="ok">{{ testRes.result.join(', ') }}</b>
            </template>
            <template v-else-if="testRes.hits?.length">命中 <b>{{ testRes.hits.map((h) => h.pat).join(' · ') }}</b> → <b class="bad">删除该标签</b></template>
            <template v-else>未命中任何规则 → 原样 <b>{{ testRes.result.join(', ') }}</b></template>
          </span>
          <span v-else-if="testTag.trim()" class="lab">测试中…</span>
          <span class="lab faint" style="margin-left: auto;">基于<b class="u">已保存</b>的规则</span>
        </div>
      </div>
    </div>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="saving" @click="save">💾 保存</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 10px; }
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
.editor.tall { min-height: 52vh; }
.loading { color: var(--muted); font-size: 12px; padding: 20px 0; }

/* ============ 网格: 左组栏 + 右主区 ============ */
.grid { display: flex; gap: 0; min-height: 60vh; align-items: stretch; }
.side {
  flex: 0 0 200px; display: flex; flex-direction: column;
  border-right: 1px solid var(--border); padding-right: 12px; margin-right: 14px;
}
.side-cap { font-size: 11px; color: var(--faint); padding: 2px 6px 8px; }
.side-list { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.side-item { border-radius: var(--r-sm); padding: 7px 10px; cursor: pointer; border: 1px solid transparent; }
.side-item:hover { background: var(--panel2); }
.side-item.on { background: var(--panel2); border-color: var(--accent); }
.side-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.star { color: var(--warn, #c8862a); font-size: 11px; }
.side-meta { font-size: 11px; color: var(--faint); margin-top: 2px; }
.side-ops { flex: 0 0 auto; padding-top: 10px; border-top: 1px dashed var(--border); display: flex; flex-wrap: wrap; gap: 4px; }
.side-ops-row { display: flex; gap: 4px; width: 100%; }
.side-ops :deep(.btn) { padding-left: 6px; padding-right: 6px; }

.main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }

/* ---- 工具栏 ---- */
.bar {
  position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 2px 0 10px;
}
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; }
.seg-b {
  background: transparent; color: var(--muted); border: none; cursor: pointer;
  font-size: 12px; padding: 5px 14px;
}
.seg-b.on { background: var(--panel2); color: var(--text); }
.bar-stat { font-size: 12px; color: var(--muted); }
.bar-stat b { color: var(--accent); }
.faint { color: var(--faint); }
.bar-btn {
  margin-left: auto; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none;
  border: 1px solid var(--border); border-radius: var(--r-sm); padding: 3px 10px;
  display: inline-flex; align-items: center; gap: 5px; position: relative;
}
.bar-btn:hover { color: var(--text); border-color: var(--border); }
.bar-btn.open { color: var(--text); background: var(--panel2); }
.bar-btn.help { margin-left: 0; border-radius: 50%; width: 24px; height: 24px; padding: 0; justify-content: center; }
.bar-btn .dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--accent); display: inline-block;
}
.pop {
  position: absolute; top: 30px; right: 0; z-index: 30;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
}
.notes-pop { width: min(560px, 90%); }
.help-pop { width: min(520px, 90%); font-size: 12px; color: var(--muted); line-height: 1.8; }
.help-line b { color: var(--accent); font-weight: normal; }
.pop-cap { font-size: 11px; color: var(--faint); margin: 6px 0 4px; }
.pop-cap:first-child { margin-top: 0; }
.notes-area {
  width: 100%; min-height: 60px;
  background: var(--panel2); color: var(--muted);
  border: 1px dashed var(--border); border-radius: var(--r-sm);
  padding: 6px 10px; font-family: Consolas, Menlo, monospace;
  font-size: 11px; line-height: 1.6; resize: vertical; outline: none;
}

/* ---- 规则卡片(两行式) ---- */
.rows { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px; }
.rule-card {
  padding: 9px 12px; background: var(--panel2);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.rule-card.raw { opacity: 0.8; border-style: dashed; cursor: pointer; }
.row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.row-sub {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border);
}
.repl-sub { margin-top: 4px; padding-top: 0; border-top: none; padding-left: 18px; }
.mode-sel {
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  font-size: 12px; padding: 4px 6px; outline: none; flex: 0 0 auto;
}
/* 联想输入框宽度自适应: field-sizing 按内容撑开(Chrome 152+), 限上下限。
 * flex 必须是 0 0 auto —— 给 grow 会把自适应宽度重新拉满整行 */
.row-core { flex: 0 0 auto; min-width: 0; }
.row-core :deep(input),
.chip-add :deep(input),
.test-in :deep(input) {
  field-sizing: content; min-width: 80px !important; max-width: 340px; width: auto;
}
.del-sub { border-top: none; margin-top: 6px; padding-top: 0; }
.del-mark { font-size: 11px; color: var(--danger, #c05050); }
.del-mark b { font-weight: 500; }
.row-core :deep(input) { width: 100%; }
.keep-sel { flex: 0 0 auto; }
.suffix {
  width: 96px; background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 6px; font-size: 11px; font-family: Consolas, Menlo, monospace; outline: none;
}
.arr { color: var(--faint); font-size: 13px; }
.lab { font-size: 11px; color: var(--faint); flex: 0 0 auto; }
.chips, .chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: Consolas, Menlo, monospace; font-size: 11px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 2px 8px;
}
.chip .x { color: var(--faint); cursor: pointer; font-weight: normal; }
.chip .x:hover { color: var(--text); }
.chip-add { flex: 0 0 auto; }
.chip-add :deep(input) { min-width: 0; width: 100%; padding: 3px 6px; font-size: 11px; }
.test-in { flex: 0 0 auto; }
.test-in :deep(input) { min-width: 0; width: 100%; }
.row-core :deep(input) { min-width: 0; }
.test-out .bad { color: var(--danger, #c05050); }
.h-sec { font-size: 11px; color: var(--faint); margin: 8px 0 2px; }
.h-sec:first-child { margin-top: 0; }
.h-sec b { color: var(--text); font-weight: 500; }
.help-pop code {
  font-family: Consolas, Menlo, monospace; font-size: 11px;
  background: var(--panel2); border-radius: 4px; padding: 0 5px;
}
.raw-badge {
  font-size: 10px; color: var(--warn, #c8862a);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; flex: 0 0 auto;
}
.raw-text { font-family: Consolas, Menlo, monospace; font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.raw-hint { color: var(--faint); font-size: 11px; margin-left: auto; flex: 0 0 auto; }
.empty { color: var(--faint); font-size: 12px; padding: 10px 4px; }
.add { align-self: flex-start; }
.row-del { margin-left: auto; flex: 0 0 auto; }

/* ---- 测试条 ---- */
.tester {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; padding: 8px 10px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm);
  flex: 0 0 auto;
}
.lab { font-size: 11px; color: var(--muted); white-space: nowrap; }
.test-in { flex: 0 0 auto; }
.test-out { font-size: 11px; color: var(--text); }
.test-out b { color: var(--accent); font-family: Consolas, Menlo, monospace; font-weight: normal; }
.test-out .ok { color: var(--ok, #3d9970); }
.u { border-bottom: 1px dotted var(--faint); }
</style>
