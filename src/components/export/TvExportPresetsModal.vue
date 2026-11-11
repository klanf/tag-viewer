<script setup>
/**
 * 导出预设管理 —— 「ban 完自动导出」的配置台
 * ==========================================
 * 背景(2026-09-22 用户诉求): 每 ban 一个词条都要手动导出一次, 还得在
 * 「另存为」里挑目录, 纯重复劳动。于是把「筛选条件 + 目标目录/文件名」存成预设,
 * 黑名单**内容真的变了**就自动覆盖导出一次。
 *
 * 几个刻意的地方:
 *   · 预设里存的是**一份筛选快照**(来源可多选、搜索词、组合模式、各开关) ——
 *     不跟首页当前条件联动, 免得改一次筛选把自动导出结果带偏。
 *   · 「来源」可以自己勾, 不必等于首页当前来源(用户 2026-09-22 特别要求)。
 *   · 新建时用首页当前条件做初值(省得从零填), 之后就是快照。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvInput from '../base/TvInput.vue'
import TvSelect from '../base/TvSelect.vue'
import TvReplaceSetPicker from './TvReplaceSetPicker.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
import TvChip from '../base/TvChip.vue'
import TvSourceChips from '../filter/TvSourceChips.vue'
import TvCartPresetSection from '../cart/TvCartPresetSection.vue'
import TvTagSuggestInput from '../tag/TvTagSuggestInput.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { nfmt, bytes, dur, ts as fmtTs } from '@/utils/format.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 来源列表 [{name, images}] —— 与首页共用同一份统计 */
  sources: { type: Array, default: () => [] },
  totalImages: { type: Number, default: 0 },
  /** 首页当前筛选条件, 只用作「新建预设」的初值 */
  snapshot: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update:modelValue', 'changed'])

const ui = useUiStore()
const safety = useSafetyStore()

const presets = ref([])
const loading = ref(false)
const busy = ref('')          // 'run:<id>' / 'save' / 'del:<id>'
const editing = ref(null)     // 表单对象; null = 看列表
const formErr = ref('')

const MODE_OPTS = [{ value: 'any', label: '任一命中(any)' }, { value: 'all', label: '全部命中(all)' }]
const MATCH_OPTS = [{ value: 'contains', label: '包含(contains)' }, { value: 'exact', label: '完全相等(exact)' }]

const isNew = computed(() => !!editing.value && !presets.value.some((p) => p.id === editing.value.id))

/* ------------------------------------------------------------ 读取 */

/* 替换规则组(2026-10-04): 预设里存的是组 id, 界面上要显示组名 */
const setOptions = ref([{ value: '', label: '默认组' }])
const setName = (id) => setOptions.value.find((x) => x.value === id)?.label || ''
async function loadReplaceSets() {
  try {
    const r = await api.replaceSets()
    setOptions.value = [{ value: '', label: '默认组' },
      ...(r.sets || []).map((x) => ({ value: x.id, label: x.name }))]
  } catch { /* 读不到就用默认组 */ }
}

/* 高级替换方案库(2026-11-09): 预设里存方案 id(adv_set), 界面上显示方案名。
 * 2026-11-10 用户拍板:「跟随当前方案」不再作为新选项 —— 只选已有方案(或关掉)。
 * '@active' 只剩老预设遗留的显示位(和「旧版参数」同一待遇), 建议重存成具体方案。
 * '' = 老预设遗留的"旧版快照参数"(老预设没有 adv_set 字段, 走当年存的参数串)。 */
const ADV_OPTS_HEAD = [
  { value: '0', label: '不启用', hint: '导出完全不做随机/钉词/禁用/自然语言处理' },
]
const ADV_OPTS_TAIL = [
  { value: '@active', label: '跟随当前方案(老预设遗留)', hint: '这条预设存的还是「跟随当前方案」—— 建议选一套具体方案后重新保存' },
  { value: '', label: '旧版参数(老预设遗留)', hint: '这条预设是方案化之前存的, 按当年存的参数串导出; 建议选一套方案后重新保存' },
]
const advSetOptions = ref([...ADV_OPTS_HEAD, ...ADV_OPTS_TAIL])
async function loadAdvSets() {
  try {
    const r = await api.advSets.get()
    advSetOptions.value = [
      ...ADV_OPTS_HEAD,
      ...(r.sets || []).map((x) => ({ value: x.id, label: x.name, hint: `用方案「${x.name}」(方案在高级替换弹窗里维护)` })),
      ...ADV_OPTS_TAIL,
    ]
  } catch { /* 读不到就只给头尾两项 */ }
}

/** 安全档位只认 '0'..'4'(2026-11-10 去掉「跟随全局」): 老预设的 'follow' 就地折算成当前全局档 */
function safeLevelInit(v) {
  if (typeof v === 'string' && /^[0-4]$/.test(v)) return v
  return String(safety.maxLevel ?? 2)
}
/* 档位 chips 用安全模式设置弹窗同款可读标签 —— 不裸写 01234(2026-11-10 用户拍板) */
const SAFE_LEVELS_EXPORT = [
  { v: '4', label: '≤L4 · 全显示', hint: '阈值 4 = 基本不剔(所有等级的词都留下)' },
  { v: '3', label: '≤L3 · 藏极端', hint: '阈值 3 = 剔掉极端(L4)的词' },
  { v: '2', label: '≤L2 · 藏露骨', hint: '阈值 2 = 剔掉露骨(L3+)和极端(L4)的词' },
  { v: '1', label: '≤L1 · 藏暗示', hint: '阈值 1 = 剔掉明显暗示(L2+)以上的词' },
  { v: '0', label: '≤L0 · 只留常规', hint: '阈值 0 = 最严, 连擦边(L1)也剔, 只留常规词' },
]

async function load() {
  await loadReplaceSets()
  await loadAdvSets()
  await loadDirs()
  loading.value = true
  try {
    const r = await api.exportPresets()
    presets.value = r?.presets || []
  } catch (e) {
    ui.err('读取导出预设失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => {
  if (!v) { editing.value = null; return }
  editing.value = null
  load()
  loadDelay()
})

/* ---------------------------------------------------- 延迟(全局设置) */

/**
 * 「ban 完之后等多久才导」—— **全局一个值**, 不是每个预设各一份。
 * 起因(2026-09-24 用户诉求): 连着 ban 好几个标签时, 每个都各触发一次 3~4 秒的
 * 同步导出太磨人; 等几分钟, 中间所有改动合并成一次。
 *
 * 档位从主进程带回来(见 export:preset:state): 渲染层不自己写一份,
 * 免得两边漂移 —— 一边改了档位、另一边还按旧值显示, 用户会看到"选了 1 分钟却等 3 分钟"。
 */
const delayMs = ref(0)
const delayOpts = ref([])

async function loadDelay() {
  try {
    const s = await api.exportPresetState()
    delayMs.value = Number(s?.delayMs) || 0
    delayOpts.value = (s?.delayOptions || []).map((v) => ({ value: v, label: dur(v) }))
  } catch { /* 浏览器降级 / 主进程没注册: 不显示这一行就行 */ }
}

async function onDelayChange(v) {
  try {
    const r = await api.exportPresetDelay(v)
    delayMs.value = Number(r?.delayMs) || Number(v)
    ui.ok(`⏱ 已改成 ${dur(delayMs.value)} 后自动导出`, 2200)
  } catch (e) {
    ui.err('改延迟失败: ' + e.message)
    await loadDelay()          // 取回真实值, 免得界面停在没生效的选项上
  }
}

/* ------------------------------------------------------------ 表单 */

function blankParams() {
  const s = props.snapshot || {}
  return {
    source: Array.isArray(s.source) ? [...s.source] : [],
    q: s.q || '',
    mode: s.mode || 'any',
    match: s.match || 'contains',
    exclude: s.exclude || '',
    exclude_match: s.exclude_match || 'contains',
    exclude_char: s.exclude_char !== false,
    spaces: s.spaces !== false,
    blacklist: s.blacklist !== false,
    replace: s.replace !== false,
    bg: s.bg !== false,
    strip_char: !!s.strip_char,
    strip_view: !!s.strip_view,
    safe_only: !!s.safe_only,
    safe_level: safeLevelInit(s.safe_level),
    seg_mode: !!s.seg_mode,
    with_path: !!s.with_path,
    replace_set: typeof s.replace_set === 'string' ? s.replace_set : '',
    // 过滤组 / 随机替换(2026-10-29): 之前不在初值表里, 存预设会被静默剥掉(实锤的坑)
    // 2026-10-30 槽级粒度: randomize_slots; 老预设的 randomize_sections 同格式,
    // 打开编辑时直接并进 slots 字段(解析端两边都认, 存回就是新格式)
    groups: !!s.groups,
    randomize: !!s.randomize,
    randomize_nsfw: s.randomize_nsfw !== false,
    pin_fill: s.pin_fill !== false,
    randomize_slots: typeof s.randomize_slots === 'string' ? s.randomize_slots
      : typeof s.randomize_sections === 'string' ? s.randomize_sections
      : Array.isArray(s.randomize_slots) ? s.randomize_slots.join(',') : '',
    pin_slots: typeof s.pin_slots === 'string' ? s.pin_slots : '',
    ban_slots: typeof s.ban_slots === 'string' ? s.ban_slots : '',
    // 槽位权重(2026-11-10): 与 run 时的同名字段同位, 同样必须进初值表
    slot_weights: typeof s.slot_weights === 'string' ? s.slot_weights : '',
    randomize_seed: typeof s.randomize_seed === 'string' ? s.randomize_seed : '',
    // 高级替换方案(2026-11-09): '@active'=跟随当前 / '0'=不启用 / 方案 id / 空=老预设快照参数
    adv_set: typeof s.adv_set === 'string' ? s.adv_set : '',
    // 自然语言段(2026-11-08): 与随机替换同位, 同样必须进初值表 —— 漏了就会被
    // 存预设时静默剥掉(上面那条注释就是同一个坑)。
    nl_dims: typeof s.nl_dims === 'string' ? s.nl_dims : '',
    nl_level: typeof s.nl_level === 'string' ? s.nl_level : 'sfw',
    nl_strip_pose: s.nl_strip_pose !== false,
    nl_pose_view: s.nl_pose_view !== false,
    nl_strip_costume: s.nl_strip_costume !== false,
    nl_strip_hair: s.nl_strip_hair !== false,
    nl_seed: typeof s.nl_seed === 'string' ? s.nl_seed : '',
    // 语言与语料黑名单(2026-11-11): 之前漏了 nl_lang, 预设里选的中文导出会被静默丢掉
    nl_lang: s.nl_lang === 'zh' ? 'zh' : 'en',
    nl_ban: typeof s.nl_ban === 'string' ? s.nl_ban : '',
  }
}

/* 目标目录的默认值与"最近"(2026-10-04 用户反馈"导出地址要选两次太麻烦"):
 *   优先级 = 全局默认目录 > 上次选过的目录(lastPickDir) > 数据目录
 * 于是"新建预设"默认就带着一个能用的目录, 多数时候一句系统对话框都不用开。 */
const defDirs = ref({ defaultDir: '', lastDir: '', dataDir: '' })
async function loadDirs() {
  try { defDirs.value = await api.exportDirs() } catch { /* 读不到就用空 */ }
}
/** 最近用过的目录: 显式默认 > 上次选的 > 各预设现用目录(去重, 最多 8 个) */
const recentDirs = computed(() => {
  const out = []
  const seen = new Set()
  const push = (d) => {
    const v = String(d || '').trim()
    const k = v.toLowerCase()
    if (!v || seen.has(k)) return
    seen.add(k); out.push(v)
  }
  push(defDirs.value.defaultDir)
  push(defDirs.value.lastDir)
  for (const p of presets.value) push(p.dir)
  return out.slice(0, 8)
})
function useDir(d) {
  if (editing.value) editing.value.dir = d
}
async function pickDirAsDefault() {
  try {
    const r = await api.pickExportDir()
    if (r?.canceled || !r?.path) return
    defDirs.value = { ...defDirs.value, defaultDir: r.path }
    await api.exportDirSaveDefault(r.path)
    if (editing.value) editing.value.dir = r.path
    ui.ok('已设为全局默认目录(以后新建预选用它)', 2200)
  } catch (e) {
    ui.err('选择目录失败: ' + e.message)
  }
}
async function clearDefaultDir() {
  await api.exportDirSaveDefault('')
  defDirs.value = { ...defDirs.value, defaultDir: '' }
}

/** 文件名跟随预设名(用户手改过文件名后就不再自动跟随, 别把人起的名冲掉) */
const fileTouched = ref(false)
function onNameInput(v) {
  if (!editing.value) return
  editing.value.name = v
  if (!fileTouched.value) editing.value.file = defaultFileName(v)
}
function defaultFileName(name) {
  const t = String(name || '').trim()
  if (!t) return '筛选结果.txt'
  // 文件名非法字符替换(与主进程 safeFileName 同一套口径)
  return t.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60) + '.txt'
}

function startNew() {
  formErr.value = ''
  fileTouched.value = false
  const d = defDirs.value
  editing.value = {
    id: '',
    name: '',
    // 目录已经能用: 默认目录 > 上次选的 > 数据目录
    dir: d.defaultDir || d.lastDir || d.dataDir || '',
    file: '筛选结果.txt',
    auto: true,
    params: blankParams(),
  }
}

function startEdit(p) {
  formErr.value = ''
  fileTouched.value = false
  const params = { ...blankParams(), ...(p.params || {}) }
  params.safe_level = safeLevelInit(params.safe_level)   // 老预设的 'follow' 折算成具体档位
  editing.value = {
    id: p.id,
    name: p.name,
    dir: p.dir,
    file: p.file,
    auto: !!p.auto,
    params,
  }
}

async function pickDir() {
  try {
    const r = await api.pickExportDir()
    if (r?.canceled) return
    if (r?.path) editing.value.dir = r.path
  } catch (e) {
    ui.err('选择目录失败: ' + e.message)
  }
}

async function save() {
  const f = editing.value
  if (!f) return
  if (!f.dir) { formErr.value = '请先选一个目标目录'; return }
  busy.value = 'save'
  try {
    const r = await api.exportPresetSave({
      id: f.id || undefined,
      name: f.name,
      dir: f.dir,
      file: f.file,
      auto: f.auto,
      params: f.params,
    })
    presets.value = r?.presets || presets.value
    editing.value = null
    ui.ok(`✅ 已保存预设「${r?.preset?.name || f.name}」`, 2000)
    emit('changed')
  } catch (e) {
    formErr.value = e.message
  } finally {
    busy.value = ''
  }
}

/* ------------------------------------------------------------ 动作 */

async function runOne(p) {
  busy.value = 'run:' + p.id
  try {
    const r = await api.exportPresetRun(p.id)
    ui.ok(`✅ 已导出 ${nfmt(r.count)} 行 → ${r.path}`, 3200)
    await load()
    emit('changed')
  } catch (e) {
    ui.err(`导出「${p.name}」失败: ` + e.message)
    await load()
  } finally {
    busy.value = ''
  }
}

async function del(p) {
  if (!window.confirm(`删除预设「${p.name}」？\n(已经导出的文件不会被删)`)) return
  busy.value = 'del:' + p.id
  try {
    const r = await api.exportPresetDelete(p.id)
    presets.value = r?.presets || []
    ui.ok('已删除预设', 1600)
    emit('changed')
  } catch (e) {
    ui.err('删除失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}

/** 列表上的「黑名单变更后自动导出」开关: 就地存回去 */
async function toggleAuto(p, v) {
  p.auto = v
  try {
    const r = await api.exportPresetSave({ ...p, auto: v })
    presets.value = r?.presets || presets.value
    emit('changed')
    ui.toast(v ? `「${p.name}」已开启自动导出` : `「${p.name}」已关闭自动导出`, 'info', 1800)
  } catch (e) {
    p.auto = !v
    ui.err('切换失败: ' + e.message)
  }
}

/** 把列表里的绝对路径缩短一点显示(太长会撑爆弹窗) */
function shortDir(d) {
  const s = String(d || '')
  return s.length > 46 ? s.slice(0, 22) + '…' + s.slice(-20) : s
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="📤 导出预设"
    size="lg"
    :mask-closable="!editing"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <!-- ---------------- 列表 ---------------- -->
    <template v-if="!editing">
      <div class="tip">
        预设 = <b>一份筛选条件快照</b> + <b>目标目录/文件名</b>。
        勾了「黑名单变更后自动导出」的预设, 在你 ban / 取消 ban 之后
        <b>原地覆盖</b>导出一次, 不用再手动点导出。
      </div>

      <!-- 延迟: 全局设置。连着 ban 好几个标签时, 等一会再导 —— 只导一次 -->
      <div v-if="delayOpts.length" class="delayrow">
        <span class="lb">ban 完之后等</span>
        <TvSelect :model-value="delayMs" size="sm" :options="delayOpts" @update:model-value="onDelayChange" />
        <span class="faint">再自动导出(期间改多少次都只导一次)。改完<b>立刻生效</b>。</span>
      </div>
      <div class="faint delayrow-tip">
        等待期间首页侧栏会出现「待导出 mm:ss」角标 —— <b>点它一下可以跳过等待立刻导</b>;
        这时候关窗口也会先把这次导出跑完再退。
      </div>

      <div v-if="loading" class="muted">读取中...</div>
      <div v-else-if="!presets.length" class="muted">还没有预设 —— 点下面的「＋ 新建预设」开始。</div>

      <div v-else class="plist">
        <div v-for="p in presets" :key="p.id" class="prow" :class="{ on: p.auto }">
          <div class="phead">
            <span class="pname">{{ p.name }}</span>
            <span v-if="p.auto" class="tag-on">自动</span>
            <span v-if="p.params.source && p.params.source.length" class="tag-src">
              {{ p.params.source.length }} 个来源
            </span>
            <span v-if="p.params.q" class="tag-q" :title="p.params.q">🔍 {{ p.params.q }}</span>
            <span v-if="p.params.replace && setName(p.params.replace_set)" class="tag-set" :title="'替换规则组: ' + setName(p.params.replace_set)">🔁 {{ setName(p.params.replace_set) }}</span>
          </div>
          <div class="ppath" :title="p.dir + '\\' + p.file">
            {{ shortDir(p.dir) }}<span class="sep">\</span><b>{{ p.file }}</b>
          </div>
          <div class="pmeta">
            <template v-if="p.lastRunAt">
              上次 {{ p.lastTrigger === 'auto' ? '自动' : '手动' }}导出
              {{ fmtTs(p.lastRunAt) }} · <b>{{ nfmt(p.lastCount) }}</b> 行 · {{ bytes(p.lastBytes) }}
            </template>
            <template v-else>还没导出过</template>
            <span v-if="p.lastError" class="err">· ⚠ {{ p.lastError }}</span>
          </div>
          <div class="pacts">
            <label class="auto-sw" :title="'黑名单变更后自动导出'">
              <input
                type="checkbox"
                :checked="p.auto"
                @change="(e) => toggleAuto(p, e.target.checked)"
              >
              变更后自动导出
            </label>
            <TvButton size="xs" variant="secondary" :loading="busy === 'run:' + p.id" @click="runOne(p)">⬇ 立即导出</TvButton>
            <TvButton size="xs" variant="ghost" @click="startEdit(p)">✏ 编辑</TvButton>
            <TvButton size="xs" variant="ghost" :loading="busy === 'del:' + p.id" @click="del(p)">🗑</TvButton>
          </div>
        </div>
      </div>

      <div class="pfoot">
        <TvButton variant="primary" @click="startNew">＋ 新建预设</TvButton>
        <span class="faint">新建时用首页当前的筛选条件做初值(来源、搜索词、各开关)</span>
      </div>

      <!-- 购物车那条是**独立的一份预设**(只有一个, 也不需要筛选快照) ——
           跟上面这些共用同一个台面, 只是为了让"自动导出"只有一个地方可找。 -->
      <div class="csec">
        <div class="csec-t">
          🛒 购物车自动导出
          <span class="faint">（独立的一份，跟随购物车变化，与上面的筛选预设互不影响）</span>
        </div>
        <TvCartPresetSection />
      </div>
    </template>

    <!-- ---------------- 表单 ---------------- -->
    <template v-else>
      <div class="frow">
        <span class="lb">名称</span>
        <TvInput
          :model-value="editing.name"
          size="sm"
          placeholder="如: ComfyUI 提示词(文件名会跟着它变)"
          @input="onNameInput"
        />
      </div>

      <div class="fsec">
        <div class="fsec-t">📂 来源(可多选, 空 = 全部)</div>
        <TvSourceChips
          v-model="editing.params.source"
          :sources="sources"
          :total="totalImages"
        />
      </div>

      <div class="frow">
        <span class="lb">搜索标签</span>
        <!-- 2026-10-06: 换成看板同款的胶囊多词联想(敲逗号定格成胶囊, 选词追加/全选);
             联想范围跟着上面勾的**来源**走, 不是首页当前来源 -->
        <TvTagSuggestInput
          v-model="editing.params.q"
          multi
          :source="editing.params.source.join(',')"
          placeholder="如: 1girl, blue_archive / 中文: 蔚蓝档案 (留空 = 全部图片)"
        />
      </div>

      <div class="frow two">
        <div class="half">
          <span class="lb">组合模式</span>
          <TvSelect v-model="editing.params.mode" size="sm" :options="MODE_OPTS" />
        </div>
        <div class="half">
          <span class="lb">匹配方式</span>
          <TvSelect v-model="editing.params.match" size="sm" :options="MATCH_OPTS" />
        </div>
      </div>

      <div class="fsec">
        <div class="fsec-t">🧹 导出时套用</div>
        <div class="switches">
          <TvCheckbox v-model="editing.params.blacklist" label="剔除黑名单命中的标签" />
          <TvCheckbox v-model="editing.params.replace" label="套用替换规则" />
          <div v-if="editing.params.replace" class="setpick">
            <TvReplaceSetPicker
              v-model="editing.params.replace_set"
              always
              label="用哪套规则"
            />
            <span class="faint">(规则组在 🔁 替换规则弹窗里管理)</span>
          </div>
          <TvCheckbox v-model="editing.params.strip_char" label="剔除角色/系列标签" />
          <div>
            <TvCheckbox v-model="editing.params.safe_only" label="只导出安全模式的标签(剔除敏感tag)" title="每个标签串里去掉敏感标签(nude/sex 等), 行数不变; 词表即 data/safety_tags.txt; 敏感等级阈值用下面的 chips 选" />
            <div v-if="editing.params.safe_only" class="setpick">
              <span class="faint">敏感档位:</span>
              <TvChip
                v-for="lv in SAFE_LEVELS_EXPORT"
                :key="lv.v"
                :label="lv.label"
                :active="editing.params.safe_level === lv.v"
                :title="lv.hint"
                @click="editing.params.safe_level = lv.v"
              />
            </div>
          </div>
          <TvCheckbox v-model="editing.params.seg_mode" label="段位模式（只留内容 tag）" title="过滤画师/角色/系列/meta, 人数排最前, 通用按分类归堆 —— 给绘图管线随机抽注入用; 关掉则保持原始顺序" />
          <TvCheckbox v-model="editing.params.groups" label="过滤组去冲突(槽内单选+互斥)" title="导出前按槽位词典消解: 同槽位只留本地图片量最多的一个, 并消解裸足×无鞋这类互斥对; 仅对单人图生效, 群像原样保留" />
          <!-- 高级替换方案(2026-11-09): 整套配置(随机槽/插入槽/钉词/禁用槽/自然语言段)都在方案库里,
               预设只存"用哪一套" —— 与替换规则组同一模型。选择器也用同一款 chips 胶囊
               (TvReplaceSetPicker 同款交互): 原生 select 在弹窗容器里点不开是 2026-10-04 实锤的坑。
               老预设的参数串(adv_set 为空)仍被引擎认账, 但 UI 不再产生, 显示为"旧版参数"。 -->
          <div class="setpick">
            <span class="faint">🎲 高级替换方案(随机/插入/钉词/禁用/自然语言段整套):</span>
            <TvChip
              v-for="o in advSetOptions"
              :key="o.value || '@legacy'"
              :label="o.label"
              :active="editing.params.adv_set === o.value"
              :title="o.hint || ''"
              @click="editing.params.adv_set = o.value"
            />
          </div>
          <TvCheckbox v-model="editing.params.spaces" label="下划线转空格" />
          <TvCheckbox v-model="editing.params.with_path" label="每行带图片路径" />
        </div>
      </div>

      <div class="fsec">
        <div class="fsec-t">💾 导出到</div>
        <div class="dirrow">
          <TvInput
            v-model="editing.dir"
            size="sm"
            placeholder="目标目录(可直接粘贴路径, 或点右边按钮选)"
          />
          <TvButton size="sm" variant="secondary" @click="pickDir">📂 选择…</TvButton>
        </div>
        <div v-if="recentDirs.length" class="dirrow recent">
          <span class="rlab">最近</span>
          <TvChip
            v-for="d in recentDirs"
            :key="d"
            :label="d.split(/[\\/]/).pop() || d"
            :title="d"
            :active="editing.dir.toLowerCase() === d.toLowerCase()"
            @click="useDir(d)"
          />
          <TvButton size="xs" variant="ghost" @click="pickDirAsDefault">
            ⭐ 把选中的设为默认
          </TvButton>
          <TvButton v-if="defDirs.defaultDir" size="xs" variant="ghost" @click="clearDefaultDir">
            清除默认
          </TvButton>
        </div>
        <div class="dirrow">
          <TvInput
            v-model="editing.file"
            size="sm"
            placeholder="文件名, 如 筛选结果.txt"
            @input="fileTouched = true"
          />
        </div>
        <div class="faint">同名文件会被<b>原地覆盖</b>(写临时文件再改名, 下游不会读到半截)</div>
      </div>

      <div class="fsec">
        <TvCheckbox
          v-model="editing.auto"
          label="🔄 黑名单变更后自动导出到这个文件"
          title="你在标签页 ban / 取消 ban 一个词条后, 自动重新导出一次"
        />
      </div>

      <div v-if="formErr" class="err">{{ formErr }}</div>
    </template>

    <!-- 底部按钮: 列表态只关闭; 表单态是「返回 + 保存」 -->
    <template #footer>
      <TvButton v-if="editing" variant="secondary" @click="editing = null">返回</TvButton>
      <TvButton v-if="editing" variant="primary" :loading="busy === 'save'" @click="save">
        {{ isNew ? '💾 创建预设' : '💾 保存修改' }}
      </TvButton>
      <TvButton v-if="!editing" variant="secondary" @click="emit('update:modelValue', false)">关闭</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 12px; }
.tip b { color: var(--text); }
.muted { color: var(--muted); font-size: 12px; padding: 14px 0; }
.faint { color: var(--faint); font-size: 11px; }
.err { color: var(--danger, #d93025); font-size: 12px; margin-top: 8px; }

/* ---------------- 延迟(全局设置) ---------------- */
.delayrow { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.delayrow .lb { flex: 0 0 auto; }
.delayrow :deep(.tv-select) { flex: 0 0 110px; }
.delayrow-tip { display: block; margin-bottom: 12px; }

/* ---------------- 列表 ---------------- */
.plist { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto; padding-right: 2px; }
.prow {
  border: 1px solid var(--border); border-left: 3px solid var(--border);
  background: var(--panel2); border-radius: var(--r-sm);
  padding: 8px 10px;
}
.prow.on { border-left-color: var(--accent); }
.phead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pname { font-size: 13px; font-weight: 700; color: var(--text); }
.tag-on { font-size: 10px; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px; }
.tag-src { font-size: 10px; color: var(--char, #d19a00); }
.tag-q { font-size: 11px; color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-set { font-size: 10px; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.setpick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 2px 0 6px; }
/* 随机替换参数块(2026-10-29): 纵排的两行输入 + 一个开关, 借 setpick 的缩进 */
.rnd-preset { display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin-left: 22px; }
.rnd-preset > .faint { font-size: 11px; }
.recent { align-items: center; }
.recent .rlab { font-size: 12px; color: var(--muted); }
.faint { color: var(--faint); font-size: 11px; }
.ppath { font-size: 11px; color: var(--muted); margin-top: 4px; word-break: break-all; }
.ppath b { color: var(--text); }
.ppath .sep { padding: 0 1px; }
.pmeta { font-size: 11px; color: var(--muted); margin-top: 3px; }
.pmeta b { color: var(--accent); }
.pmeta .err { color: var(--danger, #d93025); }
.pacts { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.auto-sw {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--muted); cursor: pointer;
  margin-right: auto;
}
.pfoot { display: flex; align-items: center; gap: 10px; margin-top: 12px; }

/* ---------------- 购物车自动导出(独立一份预设) ---------------- */
.csec { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
.csec-t { font-size: 13px; color: var(--text); margin-bottom: 8px; }

/* ---------------- 表单 ---------------- */
.frow { margin-bottom: 10px; }
.frow.two { display: flex; gap: 10px; }
.frow.two .half { flex: 1 1 0; }
.lb { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.fsec { margin: 12px 0; }
.fsec-t { font-size: 12px; color: var(--text); margin-bottom: 6px; }
.switches { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.dirrow { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.dirrow > :first-child { flex: 1 1 auto; }
.safe-level-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.safe-level-row .lb { font-size: 12px; color: var(--muted); flex: 0 0 auto; }
</style>
