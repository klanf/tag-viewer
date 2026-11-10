<script setup>
/**
 * 高级替换弹窗(2026-10-30) —— 原导出菜单里的「随机替换」面板原位升级独立入口
 * ==========================================================================
 * 布局(2026-11-09 二改, 对齐替换规则编辑器): **左侧方案栏 + 右主区** ——
 *   左栏点方案名切换(不再是顶部下拉), 底部 新建/复制/改名/删除(内联输入与二次确认,
 *   不用 window.confirm —— 本弹窗还有钉词的原生 select, confirm 会搞坏它的下拉)。
 * 右主区三块:
 *   ① 槽位 —— 57 槽按九大区分组, 点 chip 循环 未选→🎲随机→➕插入→🚫禁用:
 *      随机 = 有词按率换(不补); 插入 = 随机的超集(有词换 + 没词从槽池补);
 *      禁用 = 整词删除。随机/插入的槽各一行换词率滑杆(插入槽一杆两用)。
 *   ② 钉词(必现) —— 该槽导出时必定是指定词, 优先于随机; 候选带「槽·大类」标识,
 *      手输词不在所选槽 → 黄牌警示, 词典外 → 灰牌"直接写入"
 *   ③ 自然语言段(2026-11-08)
 * 与钉词互斥: 同一槽既钉又禁 → 结构上就点不出来(cycle 跳过), 导出端另有护栏。
 *
 * 状态在 src/utils/advReplace.js(reactive 单例) —— 本弹窗只改它, 保存 = 校验+关窗;
 * 导出参数由 HomeView 的 advParams() 取同一份。
 */
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
// 钉词输入复用看板筛选同款联想框(2026-10-30 用户要求统一): localTags 传槽池词条,
// 下拉项带「槽·大类」标识 —— 与看板联想同一套交互(补全/高亮/防抖)
import TvTagSuggestInput from '../tag/TvTagSuggestInput.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import {
  adv, ensureAdvLoaded, advZh, slotMode, cycleSlotMode,
  addAdvPin, removeAdvPin, advPinCount, advConflicts, advPinConflicts,
  nlActive, nlPoolSize, nlTotalSize,
  switchAdvSet, addAdvSet, renameAdvSet, deleteAdvSet,
} from '@/utils/advReplace.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const ui = useUiStore()

watch(() => props.modelValue, (v) => {
  if (v) { ensureAdvLoaded(); setEditor.mode = ''; confirmDelSet.value = false }
})

/* ---------- ④ 自然语言段 ---------- */
/** 三个维度: 名称/说明按语料库真实来源写, 别让用户以为这是"又一个词库"。
 *  **说明里不写条数** —— 条数由右侧 chip 从语料库实时算(nlPoolSize), 写死在文案里
 *  迟早和 knowledge/nl-bank.json 对不上(2026-11-08 定稿时 pose 287→286 就漂过一次)。
 *  机位**不是维度**: 它跟着动作走(源库 1439 行是成套拍好的「动作 × 机位」),
 *  所以在动作下面当一个子开关, 不是一个平级 chip。 */
const NL_DIMS_UI = [
  { id: 'pose', zh: '动作姿势', hint: '具体动作的自然语言描述(手扶墙顶胯、单腿抬至肩高…)—— 标签池里只有 25 个粗粒度姿势词, 这是"动作雷同"的根子。抽到时会自动带上该动作的机位' },
  { id: 'costume', zh: '整套穿搭', hint: '成品搭配(上衣+下装+鞋+配饰一起抽) —— 比逐件随机拼更协调' },
  { id: 'hair', zh: '发型', hint: '发型形状描述(收腰感短发、蝴蝶剪层次发…)' },
]
const NL_LEVELS_UI = [
  { id: 'sfw', zh: '安全', hint: '只抽日常动作(站/坐/卧/跪/蹲/可爱手势)' },
  { id: 'soft', zh: '含性暗示', hint: '再加挤胸系 + 性感大胆系(不含性行为)' },
  { id: 'nsfw', zh: '全开', hint: '再加体位类(立位/正常位/后入位等)' },
]
const nlEmpty = computed(() => !adv.nlStats || adv.nlStats.empty)
const nlDimCnt = computed(() => {
  const d = (adv.nlStats?.dims || []).find((x) => x.id === 'pose')
  return d ? d.total : 0
})
function toggleNlDim(id) {
  const i = adv.nl.dims.indexOf(id)
  if (i >= 0) adv.nl.dims.splice(i, 1)
  else adv.nl.dims.push(id)
}

const slotsSorted = computed(() => adv.slots)   // 主进程已按「大区 → 词条数」排好
const emptySlots = computed(() => adv.loaded && !adv.slots.length)

/** ① 区按大区分组渲染(2026-11-08 用户要求)。
 *  以前 57 个槽按词条数一股脑平铺 —— 上装和天气、姿势和道具排在一起,
 *  跟光箱那套「① 数量与身份 / ② 头发 / …」的分类对不上。
 *  主进程的 randomSlots() 已经带上 sec/secZh 且按大区顺序排, 这里只做分组不重排。 */
const slotGroups = computed(() => {
  const out = []
  const idx = new Map()
  for (const s of adv.slots) {
    const key = s.sec || 'other'
    if (!idx.has(key)) {
      idx.set(key, out.length)
      out.push({ id: key, zh: s.secZh || '其他', slots: [] })
    }
    out[idx.get(key)].slots.push(s)
  }
  return out
})

/* ---------- ① 槽位: 随机/插入/禁用三态合一(2026-11-09) ---------- */
/** 原「①参与随机」+「③禁用槽」两区合并: 同一个槽在 未选→随机→插入→禁用 里
 *  循环, 数据上由 advReplace.setSlotMode 保证三张清单互斥。用户反馈: 两区分开
 *  时同一个槽名要在两套排布里各找一遍, 且「没词也补」的插入需求没处放。 */
const modeOf = (id) => slotMode(id)
const modeIcon = (id) => {
  const m = slotMode(id)
  return m === 'insert' ? '＋' : m === 'ban' ? '✕' : ''
}
const pinLocked = (id) => adv.pins.some((p) => p.slot === id && p.word.trim())
const modeTitle = (s) => {
  const base = {
    off: '点击 → 🎲 随机(有词按率换, 不会补词)',
    random: '再点 → ➕ 插入(= 随机 + 没词也从槽池抽一个补上; 率共用下面那条滑杆)',
    insert: '再点 → 🚫 禁用(该槽词全部不进导出)',
    ban: '再点 → 取消(不参与)',
  }[slotMode(s.id)] || ''
  const pinNote = pinLocked(s.id) ? '\n⚠ 该槽已钉词: 禁用态不可选(钉词优先), 随机/插入对钉词槽不生效' : ''
  return `${s.zh}(槽内 ${s.cnt} 词, 如: ${s.words.slice(0, 5).join(', ')}…)\n${base}${pinNote}`
}

/* ---------- ② 钉词 ---------- */
const pinQuery = (p) => String(p.word || '').trim().toLowerCase().replace(/\s+/g, '_')

/* 词归属缓存(word -> {slot, slotZh, sec}): 槽池标识与手输校验共用, 批量反查。
 * 必须 reactive —— 候选标识/校验文案从这读, Map 不触发重渲染, 反查回来界面不动 */
const infoCache = reactive({})
let lookupTimer = null
const pendingWords = new Set()
/** 批量查归属(词典反查走主进程, 250ms 合并同批词) */
function lookupWords(words) {
  const todo = words.filter((w) => w && !(w in infoCache) && !pendingWords.has(w))
  if (!todo.length) return
  todo.forEach((w) => pendingWords.add(w))
  clearTimeout(lookupTimer)
  lookupTimer = setTimeout(async () => {
    const batch = [...pendingWords].slice(0, 40)
    pendingWords.clear()
    try {
      const infos = await api.random.wordinfo(batch)
      for (const it of infos || []) infoCache[it.word.toLowerCase().replace(/\s+/g, '_')] = it
    } catch { /* 失败 = 缓存没有, 界面只少个标识不挡功能 */ }
  }, 250)
}
/* 已输词变化 → 补查归属 */
watch(() => adv.pins.map((p) => p.word).join('|'), () => {
  for (const p of adv.pins) { const w = pinQuery(p); if (w) lookupWords([w]) }
})

const infoOf = (w) => infoCache[String(w || '').toLowerCase().replace(/\s+/g, '_')]

/** 钉词联想池: 所选槽的词条映射成 TvTagSuggestInput 的 localTags 形态。
 *  slotZh 恒定(所选槽), sec 从归属缓存补(反查回来后重渲染自动补上)。 */
function pinPool(p) {
  const s = adv.slots.find((x) => x.id === p.slot)
  if (!s) return []
  return s.words.map((w) => ({ tag: w, slotZh: advZh(p.slot), sec: infoOf(w)?.sec || '' }))
}

/** 手输词校验(三级): ok=在所选槽 / warn=在词典但别的槽 / out=词典外; 空词=null */
function pinVerdictOf(p) {
  if (!p.slot) return null
  const w = pinQuery(p)
  if (!w) return null
  const it = infoOf(w)
  if (!it) return { level: 'pending', msg: '归属查询中…' }
  if (!it.slot) return { level: 'out', msg: '词典外 — 直接写入导出结果, 不参与槽位判断' }
  if (it.slot === p.slot) return { level: 'ok', msg: `✓ ${it.slotZh}·${it.sec}` }
  return { level: 'warn', msg: `⚠ 实际在「${it.slotZh}」≠ 所选「${advZh(p.slot)}」— 生效时按词典归属, 不进这个槽` }
}

onBeforeUnmount(() => { clearTimeout(lookupTimer) })

/* ---------- 方案栏(2026-11-09): 左侧栏点选切换, 编辑即自动落盘当前方案 ---------- */
const curSetName = computed(() => adv.sets.find((s) => s.id === adv.activeId)?.name || '')
/** 左栏当前方案的摘要行(与替换规则组栏的「N 条 · 编辑中」同款) */
const activeMeta = computed(() => {
  const parts = []
  if (adv.picked.length) parts.push(`随机 ${adv.picked.length}`)
  if (adv.inserts.length) parts.push(`插入 ${adv.inserts.length}`)
  if (advPinCount.value) parts.push(`钉词 ${advPinCount.value}`)
  if (adv.banned.length) parts.push(`禁用 ${adv.banned.length}`)
  if (adv.nl.enabled) parts.push('自然语言段')
  return parts.length ? `${parts.join(' · ')} · 编辑中` : '编辑中 · 未配置'
})
const setEditor = reactive({ mode: '', name: '' })   // mode: '' | new | copy | rename
function openSetEditor(mode) {
  setEditor.mode = mode
  setEditor.name = mode === 'rename'
    ? curSetName.value
    : mode === 'copy' ? `${curSetName.value}(副本)` : ''
}
function confirmSetEditor() {
  const nm = setEditor.name.trim()
  if (!nm) { setEditor.mode = ''; return }
  if (setEditor.mode === 'new') addAdvSet(nm, false)
  else if (setEditor.mode === 'copy') addAdvSet(nm, true)
  else if (setEditor.mode === 'rename') renameAdvSet(adv.activeId, nm)
  setEditor.mode = ''
}
/* 删除走**二次确认按钮**, 不弹 window.confirm —— 本弹窗还有钉词的原生 select,
 * confirm 的原生弹层会搞坏它的 GPU 合成状态, 之后下拉点不开(见替换规则编辑器同款注释) */
const confirmDelSet = ref(false)
function removeCurrentSet() {
  const cur = adv.sets.find((s) => s.id === adv.activeId)
  if (!cur) return
  if (adv.sets.length <= 1) { ui.err('最后一个方案删不掉 —— 想清空就直接把里面的勾都取消'); return }
  confirmDelSet.value = true
}
function reallyDelSet() {
  const id = adv.activeId
  confirmDelSet.value = false
  if (id) deleteAdvSet(id)
}

/* ---------- 保存 ---------- */
const saving = ref(false)
function save() {
  const conflicts = advPinConflicts.value
  if (conflicts.length) {
    // 2026-11-09: 拦截范围 = 既钉又禁 / 钉词×NL剔槽 / 插入×NL剔槽 ——
    // 钉词在导出端豁免禁用剔除; 插入会把被剔槽的词从池里补回来, 都等于绕过剔除
    ui.err(`这些槽与其他设置打架(钉词/插入 撞上 禁用/自然语言段剔除): ${conflicts.map((s) => advZh(s)).join('、')} —— 二选一, 改完再保存`)
    return
  }
  if (adv.nl.enabled && !adv.nl.dims.length) {
    ui.err('自然语言段开了但一个维度都没勾 —— 勾上「动作姿势 / 整套穿搭 / 发型」至少一个, 或者关掉这个开关')
    return
  }
  // 2026-11-09 三改: 保存**不再关窗**(对齐替换规则编辑器) —— 方案是边配边存的,
  // 用户点保存多半还想继续调; 关窗交给 取消/×/Esc。改动本身早就自动落盘了,
  // 保存按钮的语义就是"校验一遍 + 告诉你生效了什么"。
  const n1 = adv.picked.length, ni = adv.inserts.length, n2 = advPinCount.value, n3 = adv.banned.length
  const bits = []
  if (adv.enabled && (n1 || ni || n2 || n3)) {
    const parts = []
    if (n1) parts.push(`随机 ${n1} 槽`)
    if (ni) parts.push(`插入 ${ni} 槽`)
    if (n2) parts.push(`钉词 ${n2}`)
    if (n3) parts.push(`禁用 ${n3}`)
    bits.push(`高级替换 ${parts.join('·')}`)
  }
  if (nlActive.value) {
    const names = adv.nl.dims
      .map((d) => NL_DIMS_UI.find((x) => x.id === d)?.zh)
      .filter(Boolean).join('·')
    bits.push(`自然语言段 ${names}(${NL_LEVELS_UI.find((l) => l.id === adv.nl.level)?.zh})`)
  }
  if (bits.length) ui.ok(`✅ 导出时生效${curSetName.value ? `(方案「${curSetName.value}」)` : ''}: ${bits.join(' · ')}`, 2600)
  else ui.ok('高级替换与自然语言段都已关闭', 2000)
  saving.value = true
  setTimeout(() => { saving.value = false }, 300)
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="🎲 高级替换"
    size="xl"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="adv-grid">
      <!-- 左: 方案栏(2026-11-09 二改, 对齐替换规则编辑器的组栏 —— 点名字切换, 不再下拉) -->
      <aside class="side">
        <div class="side-cap">方案 · {{ adv.sets.length }} 套</div>
        <div class="side-list">
          <div
            v-for="x in adv.sets"
            :key="x.id"
            class="side-item"
            :class="{ on: x.id === adv.activeId }"
            :title="x.id === adv.activeId ? '当前方案, 改动自动保存' : '点击切换到这套方案(当前方案的改动已自动保存)'"
            @click="switchAdvSet(x.id)"
          >
            <div class="side-name">{{ x.name }}</div>
            <div class="side-meta">{{ x.id === adv.activeId ? activeMeta : '已保存方案' }}</div>
          </div>
        </div>
        <div class="side-ops">
          <template v-if="!setEditor.mode && !confirmDelSet">
            <TvButton size="xs" variant="ghost" @click="openSetEditor('new')">＋ 新建</TvButton>
            <TvButton size="xs" variant="ghost" title="复制当前方案的全部配置成一个新方案" @click="openSetEditor('copy')">⧉ 复制</TvButton>
            <TvButton size="xs" variant="ghost" @click="openSetEditor('rename')">✎ 改名</TvButton>
            <TvButton size="xs" variant="ghost" @click="removeCurrentSet">🗑 删除</TvButton>
          </template>
          <template v-else-if="setEditor.mode">
            <input
              v-model="setEditor.name"
              class="side-name-in"
              type="text"
              :placeholder="setEditor.mode === 'rename' ? '新名字' : '方案名'"
              @keyup.enter="confirmSetEditor"
            />
            <div class="side-ops-row">
              <TvButton size="xs" variant="primary" @click="confirmSetEditor">确定</TvButton>
              <TvButton size="xs" variant="ghost" @click="setEditor.mode = ''">取消</TvButton>
            </div>
          </template>
          <template v-else>
            <span class="warn-txt">删「{{ curSetName }}」? 配置一并删, 不可恢复</span>
            <div class="side-ops-row">
              <TvButton size="xs" variant="warn" @click="reallyDelSet">确定删</TvButton>
              <TvButton size="xs" variant="ghost" @click="confirmDelSet = false">算了</TvButton>
            </div>
          </template>
        </div>
      </aside>

      <!-- 右: 主区 -->
      <div class="main">
        <div class="tip">
          对导出的词条做四类处理(按序生效): <b>禁用槽删词 → 钉词定死 → 勾选槽随机换词 → 插入槽补词</b>。不在词槽词典里的词不参与, 原样保留。
          <br />
          第 ③ 区是另一种路数: 不换 tag, 而是在 prompt 末尾追加一句<b>自然语言</b>(动作·自带机位 / 穿搭 / 发型) —— tag 侧只有 25 个粗粒度姿势词,
          这里抽的是 {{ nlTotalSize('pose') }} 条具体动作句, 是"导出的图动作都差不多"的正解。
        </div>

        <!-- 总开关 -->
        <div class="mrow">
          <TvCheckbox
            v-model="adv.enabled"
            label="启用高级替换(导出时生效)"
            title="关掉 = 导出完全不看这里的配置, 等于没配过; 打开 = 每次导出都按下面的配置走"
          />
        </div>

        <!-- ① 槽位: 点 chip 循环 未选→随机→插入→禁用(2026-11-09 两区合一) -->
        <div class="zone">
          <div class="zh">① 槽位 <span class="zh-sub">点槽循环: 🎲随机(只换不补) → ➕插入(=随机+没词也补) → 🚫禁用(必删) → 取消</span></div>
      <div v-for="g in slotGroups" :key="g.id" class="slot-sec">
        <div class="slot-sec-t">{{ g.zh }}<span class="slot-sec-n">{{ g.slots.length }}</span></div>
        <div class="chips">
          <button
            v-for="s in g.slots"
            :key="s.id"
            type="button"
            class="chip"
            :class="`m-${modeOf(s.id)}`"
            :title="modeTitle(s)"
            @click="cycleSlotMode(s.id)"
          >{{ modeIcon(s.id) }}{{ s.zh }}<i class="chip-n">{{ s.cnt }}</i></button>
        </div>
      </div>
      <div v-if="emptySlots" class="empty">槽位清单加载失败, 关掉重开弹窗再试</div>
      <!-- 换词率滑杆行: 随机/插入的槽各一行(禁用不需要)。
           插入槽同一根滑杆两用: 有词时 = 换词率, 缺词时 = 补上的概率。 -->
      <template v-for="s in slotsSorted" :key="`r-${s.id}`">
        <div v-if="modeOf(s.id) === 'random' || modeOf(s.id) === 'insert'" class="rate">
          <span class="rate-lb">{{ s.zh }}</span>
          <input
            v-model.number="adv.rates[s.id]"
            class="rate-in"
            type="range"
            min="0"
            max="100"
            step="5"
            :title="modeOf(s.id) === 'insert'
              ? `「${s.zh}」插入率: 有词的图按此概率换成新词, 没词的图按此概率从槽池补一个`
              : `「${s.zh}」的换词率: 每个词有此概率被换成同槽位的新词; 100% = 必换`"
          />
          <span class="rate-v">{{ adv.rates[s.id] ?? 100 }}%</span>
        </div>
      </template>
      <div v-if="advConflicts.length" class="conflict">⚠ 既钉又禁: {{ advConflicts.map((s) => advZh(s)).join('、') }} —— 保存前二选一</div>
    </div>

    <!-- ② 钉词 -->
    <div class="zone pin-zone">
      <div class="zh">② 钉词(必现) <span class="zh-sub">该槽导出时必定是指定词, 优先于随机; 钉了的槽自动跳过随机</span></div>
      <div v-for="(p, i) in adv.pins" :key="`pin-${i}`" class="pin">
        <select v-model="p.slot" class="pin-slot" title="钉词放在哪个槽">
          <option value="" disabled>选槽…</option>
          <option v-for="s in slotsSorted" :key="s.id" :value="s.id">{{ s.zh }}</option>
        </select>
        <span class="pin-eq">必现</span>
        <span class="pin-word-box">
          <!-- 2026-10-30 复用看板筛选同款联想框: 槽池联想(带「槽·大类」标识), 手输词典外词也允许 -->
          <TvTagSuggestInput
            v-model="p.word"
            size="sm"
            :local-tags="p.slot ? pinPool(p) : []"
            :empty-text="p.slot ? '该槽池里没有匹配的词条(手输会直接写入导出结果)' : '先在左边选槽'"
            :disabled="!p.slot"
            @pick="lookupWords([pinQuery(p)])"
          />
          <span v-if="pinVerdictOf(p)" :class="['pin-verdict', `v-${pinVerdictOf(p).level}`]">{{ pinVerdictOf(p).msg }}</span>
        </span>
        <button type="button" class="pin-del" title="删掉这行钉词" @click="removeAdvPin(i)">×</button>
      </div>
      <TvButton size="xs" variant="ghost" class="pin-add" @click="addAdvPin">＋ 添加钉词</TvButton>
      <TvCheckbox
        v-model="adv.pinFill"
        label="原图没有该槽词条时, 自动补上钉词"
        title="「必现」语义: 原图整行都没有该槽的词, 也把钉词追加进导出结果"
      />
    </div>

    <!-- ③ 自然语言段(原 ④, 2026-11-09 禁用槽并入①区后编号前移) -->
    <div class="zone nl-zone">
      <div class="zh nl-t">
        ③ 自然语言段 <span class="zh-sub">追加在 prompt 末尾的一句话(动作自带机位 / 穿搭 / 发型), 抽 N 条就 N 条都不一样</span>
      </div>
      <div v-if="nlEmpty" class="empty">自然语言语料库缺失(安装包没带上 knowledge/nl-bank.json) —— 重装最新版即可</div>
      <template v-else>
        <TvCheckbox
          v-model="adv.nl.enabled"
          label="启用自然语言段(导出时追加到 prompt 后面)"
          :title="`把「动作/穿搭/发型」写成一句自然语言, 如: she is leaning back with both hands in her hair, she is wearing a black lace skirt`" 
        />
        <template v-if="adv.nl.enabled">
          <div class="chips">
            <button
              v-for="d in NL_DIMS_UI"
              :key="d.id"
              type="button"
              class="chip nl-chip"
              :class="{ on: adv.nl.dims.includes(d.id) }"
              :title="`${d.hint}\n当前档位可抽 ${nlPoolSize(d.id)} 条 / 语料全量 ${nlTotalSize(d.id)} 条(切档位可放开被闸门挡住的部分)`"
              @click="toggleNlDim(d.id)"
            >{{ d.zh }}<i class="chip-n">{{ nlPoolSize(d.id) }}<span
              v-if="nlPoolSize(d.id) < nlTotalSize(d.id)"
              class="chip-of"
            >/{{ nlTotalSize(d.id) }}</span></i></button>
          </div>
          <div class="nl-row">
            <span class="nl-lb">档位</span>
            <button
              v-for="lv in NL_LEVELS_UI"
              :key="lv.id"
              type="button"
              class="chip"
              :class="{ on: adv.nl.level === lv.id }"
              :title="lv.hint"
              @click="adv.nl.level = lv.id"
            >{{ lv.zh }}</button>
          </div>
          <div class="nl-row">
            <span class="nl-lb">语言</span>
            <button
              type="button"
              class="chip"
              :class="{ on: adv.nl.lang !== 'zh' }"
              title="英文原文 —— 源库就是英文动作句, 生成模型吃得最准"
              @click="adv.nl.lang = 'en'"
            >English</button>
            <button
              type="button"
              class="chip"
              :class="{ on: adv.nl.lang === 'zh' }"
              title="中文句子 —— 每条语料自带手工中文译文, 如「S形站姿・胯部侧顶，俯视视角，她穿着…」"
              @click="adv.nl.lang = 'zh'"
            >中文</button>
          </div>
          <TvCheckbox
            v-if="adv.nl.dims.includes('pose')"
            v-model="adv.nl.poseView"
            label="带上机位(正面视角 / 俯视 / 仰视…)"
            title="机位取该动作在源库里真实拍过的那几个(多数动作 5 个, 个别只有 4 个), 与动作成套出现 —— 所以是 she is X, seen from above 这一整句, 不是两句拼的。带机位时会剔掉原图的视角词; 关掉则只出动作句、视角 tag 保留"
          />
          <TvCheckbox
            v-if="adv.nl.dims.includes('pose')"
            v-model="adv.nl.stripPose"
            label="抽动作句时剔掉原图的动作词"
            title="剔的是**全部动作槽**(姿势 / 基础姿势 / 挑逗动作 / 体位), 不是只剔 pose —— 原图留一个 standing, 就和你抽到的 lying on her side 打架。默认剔掉, 想要两者并存就取消勾上"
          />
          <TvCheckbox
            v-if="adv.nl.dims.includes('costume')"
            v-model="adv.nl.stripCostume"
            label="抽穿搭句时剔掉原图的服装词"
            title="剔的是全部**单品槽**(上装/下装/内衣/腿饰/鞋/帽/手饰/配件/泳装/服装类型…) —— 穿搭句是从头到脚一整套, 原图留一个 school uniform 就和你抽到的整套穿搭打架。材质与穿着状态(partially unbuttoned 这类)是互补信息, **保留**。默认剔掉, 想要并存就取消勾上"
          />
          <TvCheckbox
            v-if="adv.nl.dims.includes('hair')"
            v-model="adv.nl.stripHair"
            label="抽发型句时剔掉原图的发型词"
            title="剔的是发型**形状槽**(长度/发色/发型) —— 原图留一个 long hair, 就和你抽到的 her hair is a short bob 打架。发绳/发卡(hair_tie/hair_acc)句子基本不提, **保留**。默认剔掉, 想要并存就取消勾上"
          />
          <input
            v-model="adv.nl.seed"
            class="seed nl-seed"
            type="text"
            placeholder="动作种子(留空 = 每次导出都不同)"
            title="固定后同样的筛选结果会得到同一批动作顺序, 可复现; 与上面的换词种子互相独立"
          />
          <div class="nl-hint">
            抽样是<b>发牌</b>不是掷骰: 当前档可抽 {{ nlPoolSize('pose') }} / 全量 {{ nlTotalSize('pose') }} 个动作,
            抽 60 条就 60 条互不相同。<b>机位跟动作成套</b> —— 源库 pose 索引 1439 行 = 288 个动作 × 5 个机位
            (作者逐张拍好的配对), 所以出的是 <code>she is X, seen from above</code> 一整句, 不会只剩半句机位。
            来源: anhao/ai-pose-gallery-zh + paipiange/nvzhuang(只用文字索引)
          </div>
        </template>
      </template>
    </div>

    <!-- 其他 -->
    <div class="zone other">
      <TvCheckbox
        v-model="adv.nsfw"
        label="随机候选含成人词库"
        title="关掉后随机候选池在构建期就剔除成人词(nsfwPools), 权重/重试都拉不回来 —— 低档绝不越界"
      />
      <input
        v-model="adv.seed"
        class="seed"
        type="text"
        placeholder="种子(留空 = 每次导出都不同)"
        title="固定种子时, 同样的筛选结果导出会得到完全相同的随机替换结果, 可复现"
      />
    </div>
      </div><!-- /.main -->
    </div><!-- /.adv-grid -->

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="saving" @click="save">💾 保存</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
/* ============ 网格: 左方案栏 + 右主区(2026-11-09 二改, 对齐替换规则编辑器) ============
 * 高度定死为「面板 90vh 减去头/脚/内边距」—— 两列各自 internal scroll:
 *   左栏 side-list 滚方案列表, 右侧 .main 滚配置区, 谁也不带着谁走。
 * (2026-11-09 三改: 之前只给 min-height, 整个 body 是滚动容器 —— 主区一滚方案栏跟着跑,
 *  用户实锤。TvModal 的 .body overflow:auto 管不到内部, 必须在这里把高度封顶。) */
.adv-grid {
  display: flex; align-items: stretch;
  /* .head ≈46 + .foot ≈55 + .body 上下 padding 28 ≈ 129, 取 130 */
  height: calc(90vh - 130px);
  min-height: 380px;
}
.side {
  flex: 0 0 190px; display: flex; flex-direction: column; overflow: hidden;
  border-right: 1px solid var(--border); padding-right: 12px; margin-right: 14px;
}
.side-cap { font-size: 11px; color: var(--faint); padding: 2px 6px 8px; flex: 0 0 auto; }
.side-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.side-item { border-radius: var(--r-sm); padding: 7px 10px; cursor: pointer; border: 1px solid transparent; }
.side-item:hover { background: var(--panel2); }
.side-item.on { background: var(--panel2); border-color: var(--accent); }
.side-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-meta { font-size: 11px; color: var(--faint); margin-top: 2px; }
.side-ops { flex: 0 0 auto; padding-top: 10px; border-top: 1px dashed var(--border); display: flex; flex-wrap: wrap; gap: 4px; }
.side-ops-row { display: flex; gap: 4px; width: 100%; }
.side-ops :deep(.btn) { padding-left: 6px; padding-right: 6px; }
.side-name-in {
  width: 100%; font-size: 12px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text); outline: none;
}
.side-name-in:focus { border-color: var(--accent); }
.warn-txt { font-size: 11px; color: var(--warn, #c8862a); }
.main { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

.tip { color: var(--muted); font-size: 12px; line-height: 1.7; margin-bottom: 8px; }
.tip b { color: var(--text); }
.mrow { margin-bottom: 8px; }

.zone { border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px 10px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
.zh { font-size: 12px; font-weight: 600; color: var(--text); }
.zh-sub { font-weight: normal; font-size: 11px; color: var(--faint); margin-left: 4px; }
.ban-t { color: var(--danger, #c05050); }

.chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 132px; overflow-y: auto; }
/* ① 区按大区分组(2026-11-08): 每组一片 chips, 组内不再各自滚动 ——
 * 否则 9 个组各带一条 132px 的滚动条, 一个区里九个滚动劫持, 滚轮根本没法用。 */
.slot-sec + .slot-sec { margin-top: 5px; }
.slot-sec-t { font-size: 10.5px; color: var(--faint); margin-bottom: 3px; }
.slot-sec-n { margin-left: 4px; opacity: 0.65; }
.slot-sec .chips { max-height: none; overflow: visible; }
.chip {
  display: inline-flex; align-items: center; gap: 2px;
  border: 1px solid var(--border); border-radius: 10px; padding: 2px 8px;
  background: var(--panel2); color: var(--muted); cursor: pointer; font-size: 11px;
}
/* 四态配色(2026-11-09): off 灰 / random 主色实心 / insert 绿实心+前缀＋ / ban 红实心+前缀✕。
 * 不靠文字说明区分状态 —— 扫一眼颜色就知道这槽是干嘛的。 */
.chip.m-random { background: var(--accent, #534ab7); border-color: var(--accent, #534ab7); color: #fff; }
.chip.m-insert { background: var(--ok, #3d9970); border-color: var(--ok, #3d9970); color: #fff; }
.chip.m-ban { background: var(--danger, #c05050); border-color: var(--danger, #c05050); color: #fff; text-decoration: line-through; }
.chip:disabled { opacity: 0.45; cursor: not-allowed; }
.chip-n { font-style: normal; font-size: 10px; opacity: 0.6; margin-left: 3px; }
.empty { font-size: 11px; color: var(--faint); }

.rate { display: flex; align-items: center; gap: 6px; }
.rate-lb { flex: 0 0 auto; font-size: 11px; color: var(--muted); min-width: 4em; }
.rate-in { flex: 1 1 auto; min-width: 0; height: 14px; accent-color: var(--accent, #534ab7); }
.rate-v { flex: 0 0 3em; text-align: right; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }

.pin { display: flex; align-items: flex-start; gap: 5px; }
.pin-slot {
  flex: 0 0 5.5em; font-size: 11px; padding: 3px 4px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text);
}
.pin-eq { flex: 0 0 auto; font-size: 11px; color: var(--faint); line-height: 24px; }
.pin-word-box { flex: 1 1 auto; min-width: 0; position: relative; }
.pin-verdict { display: block; font-size: 10.5px; line-height: 1.4; margin-top: 2px; }
.v-ok { color: var(--ok, #3d9970); }
.v-warn { color: var(--warn, #c8862a); }
.v-out { color: var(--faint); }
.v-pending { color: var(--faint); }
.pin-del {
  flex: 0 0 auto; width: 20px; height: 20px; line-height: 18px; padding: 0;
  border: 1px solid var(--border); border-radius: 50%;
  background: transparent; color: var(--faint); cursor: pointer; font-size: 12px;
}
.pin-del:hover { color: var(--danger, #a32d2d); border-color: var(--danger, #a32d2d); }
.pin-add { align-self: flex-start; }

.other { flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.seed {
  flex: 1 1 200px; max-width: 280px; font-size: 11px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text); outline: none;
}
.seed:focus { border-color: var(--accent); }
.conflict { font-size: 11px; color: var(--danger, #c05050); }

/* ④ 自然语言段(2026-11-08) */
.nl-t { color: var(--accent, #534ab7); }
.nl-chip.on { background: var(--ok, #3d9970); border-color: var(--ok, #3d9970); }
.nl-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.nl-lb { flex: 0 0 auto; font-size: 11px; color: var(--muted); margin-right: 2px; }
/* .seed 是给 .other 那个横向 flex 行写的(flex-basis 200px)。这里父容器是纵向,
 * 直接继承会把 flex-basis 当成高度 → 输入框变成 200px 高的黑块。所以显式复位。 */
.nl-seed { flex: 0 0 auto; width: 100%; max-width: 280px; height: auto; }
.nl-hint { font-size: 10.5px; line-height: 1.65; color: var(--faint); }
.nl-hint b { color: var(--muted); }
/* 分母: 当前档位 / 全量。只给"被闸门挡掉一部分"的维度显示, 全开时不冗余。 */
.chip-of { opacity: 0.45; }
</style>
