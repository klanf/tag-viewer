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
// 钉词输入复用看板筛选同款联想框(2026-10-30 用户要求统一, 2026-11-10 再统一一次):
// 走**全局联想**(suggest:get, 带中文翻译与 槽·大类 标识), 不再只给所选槽的池子 ——
// 用户实锤「钉词那边没有翻译, 也不支持中文输入」。全局联想里词条本来就带 zh, 中英文都能搜。
import TvTagSuggestInput from '../tag/TvTagSuggestInput.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import {
  adv, ensureAdvLoaded, advZh, slotMode, cycleSlotMode,
  addAdvPin, removeAdvPin, advPinCount, advConflicts, advPinConflicts, advStripSoftNotes,
  slotWeightOf, setSlotWeight, pinWeightOf,
  nlActive, nlPoolSize, nlTotalSize, nlBannedSize, nlStripSlots, NL_STRIP_MAP,
  cdActive, cdPoolSize, cdTotalSize, toggleCdDim,
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
/* 维度的勾选搬到了 ① 槽位面板(📝 行), 这里只保留文案表(save/状态行/hover 说明都要用) */

/* ---------- 语料黑名单(2026-11-11) ----------
 * 「不想让针织衫进池子」这类诉求没法靠档位/维度解决 —— 档位管尺度, 维度管语义面,
 * 都太粗。给一个关键词黑名单: 命中 en/zh/kw/cat 任一字段就**整条语料**剔除
 * (一条穿搭就是"她穿着 A、B、C"一整套, 删片段会剩半套)。
 * 剔除在池子构建期做(见 nl-bank.js poolOf), 界面显示的"可抽 N 条"就是真实数。 */
const nlBanKeys = computed(() => String(adv.nl.banned || '')
  .split(/[,，;；]/).map((s) => s.trim()).filter(Boolean))
const NL_DIM_ZH = { pose: '动作', costume: '穿搭', hair: '发型' }
/** 已勾维度里被剔了多少、还剩多少 —— 让用户看见"我要的没进去"和"别剔光了" */
const nlBanHint = computed(() => {
  if (!nlBanKeys.value.length) return null
  const dims = adv.nl.dims.length ? adv.nl.dims : ['pose', 'costume', 'hair']
  const rows = dims.map((d) => {
    const left = nlPoolSize(d)
    return { zh: NL_DIM_ZH[d] || d, cut: nlBannedSize(d), left, dead: left === 0 }
  })
  return { text: rows.filter((r) => r.cut > 0).map((r) => `${r.zh}剔 ${r.cut} 剩 ${r.left}`).join(' · '), rows }
})
const nlBanDead = computed(() => !!nlBanHint.value?.rows.some((r) => r.dead))

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
  // 伪槽(📝/🎬)不再混进 chips 流 —— 2026-11-11 用户反馈"都混在一起了":
  // 真槽是"抽词/换词", 伪槽是"整面交出控制权", 两件事混在一行里只能靠颜色猜。
  // 现在它们单独渲染成 ① 区底部的「整段接管」块(见 takeoverRows)。
  return out
})

/** ① 区底部「整段接管」: 每一面一行, 列出这一面有哪些接管方式(📝 语料句 / 🎬 图库组合串)。
 *  只在**有接管方式**的面上出现(发型只有 NL, 没有图库)。 */
const takeoverRows = computed(() => {
  const faces = [
    { sec: 'pose', items: [
      { kind: 'nl', dim: 'pose', zh: '📝 自然语言动作' },
      { kind: 'cd', dim: 'pose', zh: '🎬 图库动作' },
    ] },
    { sec: 'outfit', items: [
      { kind: 'nl', dim: 'costume', zh: '📝 自然语言穿搭' },
      { kind: 'cd', dim: 'outfit', zh: '🎬 图库穿搭' },
    ] },
    { sec: 'hair', items: [
      { kind: 'nl', dim: 'hair', zh: '📝 自然语言发型' },
    ] },
  ]
  return faces.map((f) => ({
    sec: f.sec,
    zh: slotGroups.value.find((g) => g.id === f.sec)?.zh || f.sec,
    items: f.items.map((it) => (it.kind === 'nl'
      ? {
          ...it,
          cnt: nlPoolSize(it.dim),
          total: nlTotalSize(it.dim),
          on: adv.nl.dims.includes(it.dim),
          title: nlRowTitleByDim(it.dim),
          toggle: () => toggleNlRow(it.dim),
        }
      : {
          ...it,
          cnt: cdPoolSize(it.dim),
          total: cdTotalSize(it.dim),
          on: cdActive.value && adv.cd.dims.includes(it.dim),
          title: cdRowTitleByDim(it.dim),
          toggle: () => toggleCdRow(it.dim),
        })),
  }))
})

/** 伪槽开关: 勾上 = 开 NL 段 + 该维度; 取消 = 去掉该维度, 一个维度都不剩就整段关掉
 *  (否则保存时会报「开了但一个维度都没勾」)。 */
function toggleNlRow(dim) {
  const i = adv.nl.dims.indexOf(dim)
  if (i >= 0) {
    adv.nl.dims.splice(i, 1)
    if (!adv.nl.dims.length) adv.nl.enabled = false
    return
  }
  adv.nl.dims.push(dim)
  adv.nl.enabled = true
  // 同维度三套互斥: 开了 NL 就把图库池的同维度关掉(反之见 toggleCdRow)
  const cdDim = dim === 'costume' ? 'outfit' : dim
  if (adv.cd.dims.includes(cdDim)) {
    adv.cd.dims = adv.cd.dims.filter((x) => x !== cdDim)
    if (!adv.cd.dims.length) adv.cd.enabled = false
  }
}

/** 图库池那一行: 直接复用 advReplace 的 toggleCdDim(里面已经做了与 NL 的互斥) */
function toggleCdRow(dim) {
  toggleCdDim(dim)
}

/** 点灰槽 = **自动切回 tag 池**(用户选的 B 方案): 先关掉接管它的那一层, 再循环三态。
 *  「那一层」可能是 NL 句, 也可能是图库组合池(第三套) —— 谁开着就关谁。
 *  机位槽(viewpoint/camera_angle)归「带上机位」管, 关的是那个子开关, 不是整个动作维度。 */
function onSlotClick(id) {
  if (isCovered(id)) {
    const k = coverOwnerOf(id)
    if (k === 'view') {
      adv.nl.poseView = false
      ui.ok('已关掉「带上机位」, 视角 tag 交回槽位控制', 2200)
    } else if (k && coversByCd(id)) {
      toggleCdDim(cdDimOf(k))
      ui.ok(`已关掉「图库${CD_DIM_ZH[cdDimOf(k)] || cdDimOf(k)}」, 这些槽改由 tag 池控制`, 2400)
    } else if (k) {
      const i = adv.nl.dims.indexOf(k)
      if (i >= 0) adv.nl.dims.splice(i, 1)
      if (!adv.nl.dims.length) adv.nl.enabled = false
      ui.ok(`已关掉「自然语言${NL_DIM_ZH[k] || k}」, 这些槽改由 tag 池控制`, 2400)
    }
  }
  cycleSlotMode(id)
}

/* ---------- ① 整段接管(📝 语料句 / 🎬 图库组合串, 2026-11-11) ----------
 * 需求演进: 第一版「姿势大区有 3 个槽, 自然语言那份也该在这儿选」→ 做成与真槽并列的 chip;
 * 第二版「可读性不好, 都混在一起了」→ 真槽和接管本来是两件事(抽词/换词 vs 整面交出
 * 控制权), 混在一条 chip 流里只能靠颜色猜。现在拆成 ① 区底部的独立块, 每面一行。
 * 它们**不是真槽**(没有词条归属/池子/钉词/权重), 只做开关, 不进三态循环 ——
 * 互斥逻辑一行没改: 导出端 NL_STRIP_SLOTS 早在开启时把同面 tag 槽整批 ban 掉,
 * 这里只是把那件事显性化(槽变灰 + 点一下就切回来)。 */
const NL_DIM_LABEL = { pose: '自然语言动作', costume: '自然语言穿搭', hair: '自然语言发型' }
const CD_DIM_LABEL = { pose: '图库动作', outfit: '图库穿搭' }
/** 伪槽的悬停说明 —— 条数从语料库实时算(别写死) */
function nlRowTitleByDim(dim) {
  const on = adv.nl.dims.includes(dim)
  const size = nlPoolSize(dim)
  const all = nlTotalSize(dim)
  const body = on
    ? '已接管这一面的 tag 槽(导出时整槽剔除) —— 点一下取消, 交回 tag 池'
    : `点一下 = 这一面追加一句「${NL_DIM_LABEL[dim] || dim}」自然语言, tag 槽由它接管(不必再手动关)`
  return `${NL_DIM_LABEL[dim] || dim}: 当前档位可抽 ${size} 条 / 全量 ${all} 条\n${body}`
}
/** 被接管的槽 → 归属(pose/costume/hair 三个维度 + view 机位半边) */
function coverOwnerOf(slotId) {
  for (const [k, arr] of Object.entries(NL_STRIP_MAP)) if (arr.includes(slotId)) return k
  return null
}
/** 当前真正会被剔掉的槽(与导出端同口径) */
const stripSet = computed(() => new Set(nlStripSlots()))
const isCovered = (id) => stripSet.value.has(id)

/* ---------- ① 图库组合池(第三套, 2026-11-11) ----------
 * char-db 的「动作/穿搭」是 **tag 组合串**(一条 = 一套完整写法), 不拆单词、不进
 * 随机引擎, 抽出来直接并进 tag 段。它也是最省事的一套: 没有池子/钉词/权重, 只做一个
 * 开关; 同面 tag 槽同样由它接管(导出端剔的是同一批槽)。
 * 同一维度内与 NL **互斥** —— 点这个自动关那个, 否则会写出两套动作。 */
const CD_DIM_ZH = { pose: '动作', outfit: '穿搭' }
/** NL 维度名 → 图库维度名(costume ↔ outfit 是同一件事的两种叫法) */
const cdDimOf = (k) => (k === 'costume' ? 'outfit' : k)
/** 这个槽当前是不是被**图库池**接管(而不是 NL 句) —— 点灰槽时要知道关哪一层 */
function coversByCd(slotId) {
  const k = coverOwnerOf(slotId)
  if (!k || k === 'view') return false
  return adv.cd.enabled && adv.cd.dims.includes(cdDimOf(k))
}
/** 这一面现在被谁接管(给分组标题挂个标 —— 不然整组槽全灰, 看着像坏了没人知道为什么) */
const SEC_NL_DIM = { pose: 'pose', outfit: 'costume', hair: 'hair' }
function secTakeover(secId) {
  const dim = SEC_NL_DIM[secId]
  if (!dim) return null
  if (cdActive.value && adv.cd.dims.includes(cdDimOf(dim))) {
    return { kind: 'cd', text: `🎬 图库${CD_DIM_ZH[cdDimOf(dim)] || ''} 接管中` }
  }
  if (adv.nl.dims.includes(dim)) return { kind: 'nl', text: '📝 自然语言接管中' }
  return null
}
/** 灰槽说明里的「谁接管」(NL 与图库两套都可能) */
function coverLabel(slotId) {
  if (coversByCd(slotId)) {
    const d = cdDimOf(coverOwnerOf(slotId))
    return `🎬 图库${CD_DIM_ZH[d] || d}`
  }
  return `📝 ${NL_DIM_LABEL[coverOwnerOf(slotId)] || '自然语言段'}`
}
/** 图库接管那一行的悬停说明 */
function cdRowTitleByDim(dim) {
  const on = cdActive.value && adv.cd.dims.includes(dim)
  const size = cdPoolSize(dim)
  const all = cdTotalSize(dim)
  const body = on
    ? '已接管这一面的 tag 槽(导出时整槽剔除) —— 点一下取消, 交回 tag 池'
    : `点一下 = 这一面的 tag 槽改成从图库里抽一整套(整串并进 tag 段);`
      + '与「自然语言」同维度互斥, 会互相顶掉'
  return `${CD_DIM_LABEL[dim] || dim}: 可抽 ${size} 条 / 全量 ${all} 条(一条 = 一套完整 tag 组合)\n${body}`
}

/* ---------- ① 槽位: 随机/插入/禁用三态合一(2026-11-09) ---------- *//** 原「①参与随机」+「③禁用槽」两区合并: 同一个槽在 未选→随机→插入→禁用 里
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
  if (!todo.length) { autoFillPinSlots(); return }
  todo.forEach((w) => pendingWords.add(w))
  clearTimeout(lookupTimer)
  lookupTimer = setTimeout(async () => {
    const batch = [...pendingWords].slice(0, 40)
    pendingWords.clear()
    try {
      const infos = await api.random.wordinfo(batch)
      for (const it of infos || []) infoCache[it.word.toLowerCase().replace(/\s+/g, '_')] = it
    } catch { /* 失败 = 缓存没有, 界面只少个标识不挡功能 */ }
    autoFillPinSlots()          // 反查回来 → 把还没归类的钉词行补上槽
  }, 250)
}

const infoOf = (w) => infoCache[String(w || '').toLowerCase().replace(/\s+/g, '_')]

/**
 * 自动归类(2026-11-10 用户要求: 「只能先选分类再选提示词, 要支持输入提示词自动选择分类」)。
 * 只填 `auto` 标记为真的行 —— 用户手动选过槽的行(auto=false)不擅自改, 那是他自己的判断。
 */
function autoFillPinSlots() {
  for (const p of adv.pins) {
    if (!p.auto) continue
    const it = infoOf(pinQuery(p))
    if (it?.slot && p.slot !== it.slot) p.slot = it.slot
  }
}

/** 输入框里选中一条联想: 候选自带 slot(后端 suggest 已补) → 直接定类, 不必再反查 */
function onPinPick(p, item) {
  if (item?.slot) { p.slot = item.slot; p.auto = true; return }
  lookupWords([pinQuery(p)])
}

/** 槽下拉手选 = 关掉自动归类(否则下一次反查回来会把用户的选择顶掉) */
function onPinSlotChange(p) { p.auto = false }

/* 词变了 → 重新走一次自动归类(敲的是另一个词, 分类就该跟着换)。
 * 逐行比 _seenWord: 只有**自己这一行**的词变了才把 auto 置真 —— 否则删掉一行会让后面
 * 所有行错位比较, 把用户手选的槽也一起重置掉。 */
watch(() => adv.pins.map((p) => p.word).join('\u0001'), () => {
  for (const p of adv.pins) {
    if (p._seenWord === p.word) continue
    p._seenWord = p.word
    p.auto = true
  }
  const words = adv.pins.map((p) => pinQuery(p)).filter(Boolean)
  if (!words.length) return
  autoFillPinSlots()     // 缓存里已有时立刻生效, 没有就等反查回来
  lookupWords(words)
})

/** 手输词校验(三级): ok=在所选槽 / warn=在词典但别的槽 / out=词典外; 空词=null */
function pinVerdictOf(p) {
  const w = pinQuery(p)
  if (!w) return null
  const it = infoOf(w)
  if (!it) return { level: 'pending', msg: '归属查询中…' }
  if (!p.slot) return { level: 'warn', msg: '⚠ 还没定槽 — 手动选一个, 否则这条钉词不生效(引擎按槽替换)' }
  if (!it.slot) {
    // 词典外的词照样能钉: 引擎按**槽**替换, 不看词在不在池子里
    return { level: 'out', msg: `词典外 — 原样写入导出结果(钉进「${advZh(p.slot)}」槽)` }
  }
  if (it.slot === p.slot) {
    const wv = pinWeightOf(p)
    return { level: 'ok', msg: `✓ ${it.slotZh}·${it.sec}${Math.abs(wv - 1) > 1e-3 ? ` · 权重 ${wv}` : ''}` }
  }
  return {
    level: 'warn',
    msg: `⚠ 实际在「${it.slotZh}」≠ 当前「${advZh(p.slot)}」— 点右边改过来`,
    fix: it.slot,
  }
}

function applyFixSlot(p, slot) { if (slot) { p.slot = slot; p.auto = true } }

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
    // 只剩「既钉又禁」这一种硬冲突(同槽既要某词必现、又要整槽词全删, 逻辑上不可能)
    ui.err(`这些槽既钉了词又被禁用: ${conflicts.map((s) => advZh(s)).join('、')} —— 二选一, 改完再保存`)
    return
  }
  /* 2026-11-10: 「钉词 / 插入 撞上自然语言段剔除」**不再拦保存** ——
   * 钉了的槽在导出端本来就豁免剔除(pinnedSlots), 钉词优先, 语义上没冲突。
   * 原来是这里报了"打架"让用户一头雾水(他只想钉一双鞋)。只在下面给软提示。 */
  const noSlot = adv.pins.filter((p) => p.word.trim() && !p.slot)
  if (noSlot.length) {
    ui.err(`钉词「${noSlot.map((p) => p.word.trim()).join('、')}」还没定槽 —— 输入框里选中一条联想会自动归类, 查不到就手动选一个(引擎按槽替换, 没槽等于没钉)`)
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
    if (nlBanKeys.value.length) bits.push(`黑名单 ${nlBanKeys.value.length} 词`)
  }
  if (cdActive.value) {
    const names = adv.cd.dims.map((d) => CD_DIM_ZH[d]).filter(Boolean).join('·')
    bits.push(`图库池 ${names}(${adv.cd.dims.reduce((n, d) => n + cdPoolSize(d), 0)} 条可抽)`)
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
          第 <b>① 区末行</b>有两类"不换 tag、只追加"的路数, 同一维度只能开一个:
          <b>📝 自然语言</b>(从语料库抽一句人话, 动作自带机位 / 整套穿搭 / 发型) 和
          <b>🎬 图库组合</b>(从 char-db 抽一条 tag 组合串, 如 <code>standing, hands on hips</code>) ——
          tag 侧动作池只有二十来个粗粒度词, 这里能抽 {{ nlTotalSize('pose') }} 条动作句 / {{ cdTotalSize('pose') }} 条动作组合, 是"导出的图动作都差不多"的正解。
          勾了任一条, 同面的 tag 槽会变灰(导出时整槽剔除); 点灰槽就切回 tag 池。
        </div>

        <!-- 总开关 -->
        <div class="mrow">
          <TvCheckbox
            v-model="adv.enabled"
            label="启用高级替换(导出时生效)"
            title="关掉 = 导出完全不看这里的配置, 等于没配过; 打开 = 每次导出都按下面的配置走"
          />
        </div>

        <!-- ① 槽位: 上=抽词/换词的真槽, 下=整面交出控制权的接管(2026-11-11 拆块) -->
        <div class="zone">
          <div class="zh">① 槽位 <span class="zh-sub">点一下循环切换状态</span></div>
          <div class="legend">
            <span class="lg"><i class="dot d-off" />未选</span>
            <span class="lg"><i class="dot d-random" />🎲 随机 —— 有词按率换, 不补</span>
            <span class="lg"><i class="dot d-insert" />＋ 插入 —— 随机 + 没词也补</span>
            <span class="lg"><i class="dot d-ban" />✕ 禁用 —— 整词删掉</span>
          </div>
      <div v-for="g in slotGroups" :key="g.id" class="slot-sec">
        <div class="slot-sec-t">
          {{ g.zh }}<span class="slot-sec-n">{{ g.slots.length }}</span>
          <span
            v-if="secTakeover(g.id)"
            class="sec-take"
            :class="secTakeover(g.id).kind"
          >{{ secTakeover(g.id).text }}</span>
        </div>
        <div class="chips">
          <button
            v-for="s in g.slots"
            :key="s.id"
            type="button"
            class="chip"
            :class="[`m-${modeOf(s.id)}`, { covered: isCovered(s.id) }]"
            :title="isCovered(s.id)
              ? `${s.zh} —— 当前被「${coverLabel(s.id)}」接管, 导出时整槽剔除。\n点一下 = 关掉它, 这个槽改回 tag 池(并进入 🎲 随机)`
              : modeTitle(s)"
            @click="onSlotClick(s.id)"
          >
            {{ modeIcon(s.id) }}{{ s.zh }}<i class="chip-n">{{ s.cnt }}</i>
          </button>
        </div>
      </div>
      <div v-if="emptySlots" class="empty">槽位清单加载失败, 关掉重开弹窗再试</div>

      <!-- 整段接管: 与上面的真槽是**两件事** —— 上面是抽词/换词, 这里是把这一面的
           控制权整体交出去。分开渲染, 不再靠 chip 颜色猜(2026-11-11 用户反馈)。 -->
      <div v-if="takeoverRows.length" class="takeover">
        <div class="tk-hd">
          <b>整段接管</b>
          <span>勾上 → 这一面的 tag 槽不再抽取(变灰), 由它整段顶掉; 点灰槽可随时切回</span>
        </div>
        <div v-for="r in takeoverRows" :key="r.sec" class="tk-row">
          <span class="tk-face">{{ r.zh }}</span>
          <div class="tk-chips">
            <button
              v-for="it in r.items"
              :key="`${it.kind}:${it.dim}`"
              type="button"
              class="tk-chip"
              :class="[it.kind, { on: it.on }]"
              :title="it.title"
              @click="it.toggle()"
            >
              {{ it.zh }}<i class="chip-n">{{ it.cnt }}<span v-if="it.cnt < it.total" class="chip-of">/{{ it.total }}</span></i>
            </button>
          </div>
        </div>
      </div>
      <!-- 换词率滑杆行: 随机/插入的槽各一行(禁用不需要)。
           插入槽同一根滑杆两用: 有词时 = 换词率, 缺词时 = 补上的概率。
           2026-11-10: 每行多一个「权重」—— 换/补出来的词套 (词:1.2) 壳, 空/1 = 不加。 -->
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
          <label
            class="rate-w"
            :title="`「${s.zh}」换出来的词带多少权重(0.1~2.0)。1 = 不加权重; 1.2 会写成 (词:1.2)`"
          >
            权重
            <input
              class="rate-w-in"
              type="number"
              min="0.1"
              max="2"
              step="0.05"
              placeholder="1"
              :value="slotWeightOf(s.id)"
              @change="setSlotWeight(s.id, $event.target.value)"
            />
          </label>
        </div>
      </template>
      <div v-if="advConflicts.length" class="conflict">⚠ 既钉又禁: {{ advConflicts.map((s) => advZh(s)).join('、') }} —— 保存前二选一</div>
      <div v-if="advStripSoftNotes.length" class="soft">
        ℹ 自然语言段会剔掉这些槽: {{ advStripSoftNotes.map((n) => `${advZh(n.slot)}(${n.kind === 'pin' ? '钉词优先, 照常生效' : '插入会被跳过'})`).join('、') }}
        —— 不拦保存
      </div>
    </div>

    <!-- ② 钉词 -->
    <div class="zone pin-zone">
      <div class="zh">② 钉词(必现) <span class="zh-sub">该槽导出时必定是指定词, 优先于随机; 钉了的槽自动跳过随机 —— 中英文都能输入, 选中即自动归类</span></div>
      <div v-for="(p, i) in adv.pins" :key="`pin-${i}`" class="pin">
        <span class="pin-word-box">
          <!-- 2026-11-10: 不再先选槽再搜词 —— 输入优先, 联想走全局(带中文翻译),
               选中的候选自带槽归属就自动填进右边的下拉; 手选的槽不会被自动顶掉。 -->
          <TvTagSuggestInput
            v-model="p.word"
            size="sm"
            :limit="10"
            placeholder="输入提示词(中/英文都行), 如 白丝 / thighhighs"
            empty-text="词典里没有匹配的词条 —— 手输任意词也行, 但要手动选一个槽"
            @pick="(tag, item) => onPinPick(p, item)"
          />
          <span v-if="pinVerdictOf(p)" :class="['pin-verdict', `v-${pinVerdictOf(p).level}`]">
            {{ pinVerdictOf(p).msg }}
            <button
              v-if="pinVerdictOf(p).fix"
              type="button"
              class="fix-ln"
              @click="applyFixSlot(p, pinVerdictOf(p).fix)"
            >改为「{{ advZh(pinVerdictOf(p).fix) }}」</button>
          </span>
        </span>
        <span class="pin-arrow" title="自动归类自词典归属; 手动选过就不再被自动改">→</span>
        <select
          v-model="p.slot"
          class="pin-slot"
          :class="{ auto: p.auto && p.slot }"
          title="钉词放在哪个槽(必填)。输入框里选中联想会自动填; 查不到就手动选一个"
          @change="onPinSlotChange(p)"
        >
          <option value="">自动分类…</option>
          <option v-for="s in slotsSorted" :key="s.id" :value="s.id">{{ s.zh }}</option>
        </select>
        <label class="pin-w" :title="`给这个钉词加权重(0.1~2.0), 导出成 (词:权重); 1 = 不加权重`">
          <input v-model.number="p.weight" class="pin-w-in" type="number" min="0.1" max="2" step="0.05" placeholder="1" />
        </label>
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
        ③ 自然语言段 <span class="zh-sub">选中的那一句追加在 prompt 末尾(🎬 图库组合串是 tag, 在 ① 里选, 不占这一段)</span>
      </div>
      <div v-if="nlEmpty" class="empty">自然语言语料缺失(安装包没带上 knowledge/nl-bank.json) —— 重装最新版即可</div>
      <template v-else>
        <!-- 2026-11-11: 维度 chip 搬到 ① 槽位面板里了(📝 自然语言动作/穿搭/发型),
             这里只留"选了哪些"的状态行 + 档位/语言/剔除/黑名单这些**参数**。 -->
        <div class="nl-state">
          <span class="nl-lb">当前维度</span>
          <template v-if="adv.nl.dims.length || (adv.cd.enabled && adv.cd.dims.length)">
            <span v-for="d in adv.nl.dims" :key="d" class="nl-tag">{{ NL_DIMS_UI.find((x) => x.id === d)?.zh }}<i class="chip-n">{{ nlPoolSize(d) }}</i></span>
            <span v-for="d in (adv.cd.enabled ? adv.cd.dims : [])" :key="`cd-${d}`" class="nl-tag cd">{{ CD_DIM_ZH[d] }}<i class="chip-n">{{ cdPoolSize(d) }}</i></span>
          </template>
          <span v-else class="empty">未选 —— 去上面 ① 槽位里点 📝(语料句) 或 🎬(图库组合串) 那一行</span>
        </div>
        <TvCheckbox
          v-model="adv.nl.enabled"
          label="启用自然语言段(导出时追加到 prompt 后面)"
          :title="`勾上面的 📝 行会自动打开这里; 关掉 = 整段不追加(维度选择保留)。例: she is leaning back with both hands in her hair, she is wearing a lace skirt`"
        />
        <template v-if="adv.nl.enabled">
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
          <div class="nl-row nl-ban-row">
            <span class="nl-lb">本方案不要</span>
            <input
              v-model="adv.nl.banned"
              class="seed nl-ban-in"
              type="text"
              placeholder="本方案额外不要的关键词, 逗号分隔(如: 针织)"
              title="只对当前方案生效; 命中的语料整句剔除(中英文都行 —— 查英文原文、中文译文、源库关键词与分类名)。一条穿搭是一整套(A+B+C), 所以整条剔除, 不会剩半套。**要所有方案都不抽**: 去标签页工具栏的「📝 自然语言语料」里禁用, 那是全局层"
            />
          </div>
          <div v-if="nlBanHint" class="nl-hint nl-ban-hint" :class="{ dead: nlBanDead }">
            <template v-if="nlBanHint.text">{{ nlBanHint.text }}</template>
            <template v-else>「{{ nlBanKeys.join('、') }}」没命中任何语料 —— 换个词试试(穿搭是整句, 查 "针织" 比 "针织衫" 更容易命中)</template>
            <span v-if="nlBanDead" class="dead-t">⚠ 有维度被剔光了, 这批抽不出句子 —— 去掉几个关键词</span>
          </div>
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
.slot-sec + .slot-sec { margin-top: 8px; }
/* 分组标题加强(2026-11-11): 原来 10.5px + faint, 比 chip 还弱 —— 一眼扫下去分不出组,
   整个 ① 区糊成一片。现在加粗 + 左侧色条 + 拉大组间距。 */
.slot-sec-t {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 4px;
}
.slot-sec-t::before {
  content: ''; width: 2px; height: 10px; border-radius: 1px; flex: none;
  background: color-mix(in srgb, var(--faint) 55%, transparent);
}
.slot-sec-n { margin-left: 2px; font-size: 10px; font-weight: normal; color: var(--faint); }
/* 整组被接管时的标记 —— 不然一片灰没人知道是被谁接管的(2026-11-11) */
.sec-take {
  margin-left: 4px; padding: 0 6px; border-radius: 8px;
  font-size: 10px; font-weight: normal; line-height: 15px;
}
.sec-take.nl { color: var(--accent, #534ab7); border: 1px solid color-mix(in srgb, var(--accent, #534ab7) 55%, var(--border)); }
.sec-take.cd { color: #c07a2c; border: 1px solid color-mix(in srgb, #c07a2c 55%, var(--border)); }
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
/* 三态图例(2026-11-11): 把「🎲/＋/✕ 各是什么」从区标题那行长句子里挪出来。
   标题留一句话, 图例给色点 —— 一眼扫色比读句子快。 */
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 10.5px; color: var(--faint); }
.lg { display: inline-flex; align-items: center; gap: 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--border); flex: none; }
.dot.d-off { background: var(--panel2); }
.dot.d-random { background: var(--accent, #534ab7); border-color: var(--accent, #534ab7); }
.dot.d-insert { background: var(--ok, #3d9970); border-color: var(--ok, #3d9970); }
.dot.d-ban { background: var(--danger, #c05050); border-color: var(--danger, #c05050); }

/* 整段接管(2026-11-11): 与上面的真槽**块级分隔** —— 真槽是"抽词/换词", 这里是
   "把这一面的控制权整体交出去", 两件事混在一条 chip 流里只能靠颜色猜。 */
.takeover {
  margin-top: 12px; padding: 8px 10px 9px 12px; border-radius: var(--r-sm);
  border: 1px dashed var(--border); background: var(--panel2);
  border-left: 3px solid color-mix(in srgb, var(--accent, #534ab7) 55%, var(--border));
  display: flex; flex-direction: column; gap: 7px;
}
.tk-hd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.tk-hd b { font-size: 11.5px; font-weight: 600; color: var(--text); }
.tk-hd span { font-size: 10.5px; color: var(--faint); }
.tk-row { display: flex; align-items: center; gap: 10px; }
.tk-face {
  width: 62px; flex: none; text-align: right;
  font-size: 11px; color: var(--faint);
}
.tk-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.tk-chip {
  display: inline-flex; align-items: center; justify-content: space-between; min-width: 168px;
  border: 1px solid var(--border); border-radius: 6px; padding: 3px 9px;
  background: var(--panel); color: var(--muted);
  font-size: 11px; cursor: pointer; line-height: 1.4;
}
.tk-chip.nl { border-color: color-mix(in srgb, var(--accent, #534ab7) 50%, var(--border)); }
.tk-chip.cd { border-color: color-mix(in srgb, #c07a2c 50%, var(--border)); }
.tk-chip.nl.on { background: var(--accent, #534ab7); border-color: var(--accent, #534ab7); color: #fff; }
.tk-chip.cd.on { background: #c07a2c; border-color: #c07a2c; color: #fff; }
/* 被接管的 tag 槽: 灰掉 + 删除线, **仍可点** —— 点一下 = 关掉接管方,
   该槽改回 tag 池(B 方案)。不做 disabled, 否则用户得先跑去别处找开关。 */
.chip.covered { opacity: 0.35; text-decoration: line-through; }
.chip.covered:hover { opacity: 0.72; }
.nl-state { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; }
.nl-tag {
  display: inline-flex; align-items: center; padding: 1px 7px; font-size: 11px;
  border: 1px solid var(--accent, #534ab7); border-radius: 10px;
  color: var(--accent, #534ab7); background: transparent;
}
.nl-tag.cd { border-color: #c07a2c; color: #a8641f; }
.empty { font-size: 11px; color: var(--faint); }

.rate { display: flex; align-items: center; gap: 6px; }
.rate-lb { flex: 0 0 auto; font-size: 11px; color: var(--muted); min-width: 4em; }
.rate-in { flex: 1 1 auto; min-width: 0; height: 14px; accent-color: var(--accent, #534ab7); }
.rate-v { flex: 0 0 3em; text-align: right; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
/* 权重(2026-11-10): 与滑杆同一行, 窄输入 —— 只在需要时改, 平时一律 1(占位符) */
.rate-w {
  flex: 0 0 auto; display: flex; align-items: center; gap: 3px;
  font-size: 10.5px; color: var(--faint); cursor: help;
}
.rate-w-in {
  width: 3.4em; font-size: 11px; padding: 2px 4px; text-align: center;
  border: 1px solid var(--border); border-radius: 5px;
  background: var(--panel2); color: var(--text); outline: none;
}
.rate-w-in:focus { border-color: var(--accent); }

.pin { display: flex; align-items: flex-start; gap: 5px; }
.pin-slot {
  flex: 0 0 6.4em; font-size: 11px; padding: 3px 4px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text);
}
/* 自动归类填上的槽用主色描边 —— 一眼看出"这个分类是猜的, 不是我自己选的" */
.pin-slot.auto { border-color: var(--ok, #3d9970); color: var(--ok, #3d9970); }
.pin-arrow { flex: 0 0 auto; font-size: 11px; color: var(--faint); line-height: 24px; }
.pin-eq { flex: 0 0 auto; font-size: 11px; color: var(--faint); line-height: 24px; }
.pin-word-box { flex: 1 1 auto; min-width: 0; position: relative; }
.pin-verdict { display: block; font-size: 10.5px; line-height: 1.4; margin-top: 2px; }
.v-ok { color: var(--ok, #3d9970); }
.v-warn { color: var(--warn, #c8862a); }
.v-out { color: var(--faint); }
.v-pending { color: var(--faint); }
.fix-ln {
  margin-left: 4px; padding: 0 4px; font-size: 10px; line-height: 15px;
  border: 1px solid var(--warn, #c8862a); border-radius: 4px;
  background: transparent; color: var(--warn, #c8862a); cursor: pointer;
}
.fix-ln:hover { background: var(--warn, #c8862a); color: #fff; }
.pin-w { flex: 0 0 auto; padding-top: 1px; cursor: help; }
.pin-w-in {
  width: 3.4em; font-size: 11px; padding: 3px 4px; text-align: center;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text); outline: none;
}
.pin-w-in:focus { border-color: var(--accent); }
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
/* 软提示(不拦保存): 钉词/插入 与自然语言段剔除重叠时的说明 */
.soft { font-size: 10.5px; line-height: 1.6; color: var(--warn, #c8862a); }

/* ④ 自然语言段(2026-11-08) */
.nl-t { color: var(--accent, #534ab7); }
.nl-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.nl-lb { flex: 0 0 auto; font-size: 11px; color: var(--muted); margin-right: 2px; }
/* .seed 是给 .other 那个横向 flex 行写的(flex-basis 200px)。这里父容器是纵向,
 * 直接继承会把 flex-basis 当成高度 → 输入框变成 200px 高的黑块。所以显式复位。 */
.nl-seed { flex: 0 0 auto; width: 100%; max-width: 280px; height: auto; }
.nl-hint { font-size: 10.5px; line-height: 1.65; color: var(--faint); }
.nl-hint b { color: var(--muted); }
/* 语料黑名单: 输入框吃掉整行剩余宽度(关键词可能挺长, "针织衫, knit, sweater") */
.nl-ban-in { flex: 1 1 200px; width: auto; max-width: none; min-width: 0; height: auto; }
.nl-ban-hint { margin-top: 1px; }
.nl-ban-hint.dead { color: var(--danger, #c05050); }
.dead-t { display: block; margin-top: 2px; }
/* 分母: 当前档位 / 全量。只给"被闸门挡掉一部分"的维度显示, 全开时不冗余。 */
.chip-of { opacity: 0.45; }
</style>
