/**
 * 高级替换(2026-10-30)共享状态 —— 2026-11-09 方案化
 * =============================================================
 * 原来这套状态长在 HomeView 里(随机替换面板), 升级成独立弹窗后 HomeView 和
 * TvAdvancedReplaceModal 都要用 —— 拆成模块级 reactive 单例, 两边 import 同一份。
 *
 * 2026-11-09 起改成**方案库**模型(照替换规则组的模子):
 *   - 配置不再会话级失忆, 落盘在 user/adv_sets.json({active, sets:[{id,name,cfg}]})
 *   - adv reactive = 「当前选中方案」的可编辑副本, 弹窗编辑它
 *   - 编辑**自动落盘**(deep watch + debounce) —— "保存"按钮只做校验+关窗,
 *     不存在"改了没保存"的中间态, 导出永远用方案库里已落盘的内容
 *   - 导出预设里可选哪一套(参数 adv_set; '@active'=跟随当前方案, '0'=不启用)
 *
 * 槽/大类清单从主进程拉一次缓存住(random:slots / random:sections)。
 */
import { reactive, computed, watch } from 'vue'
import { api } from './api.js'

export const adv = reactive({
  enabled: false,        // 总开关: 关了导出完全不碰随机/钉词/禁用
  picked: [],            // 参与随机的槽 id(原图有词 → 按率换)
  inserts: [],           // 插入槽 id(2026-11-09: 原图没词 → 按率从槽池抽词补上; 有词行为同随机)
  rates: {},             // 槽 id -> 换词率(0~100), 缺 100 = 必换(插入槽兼任插入率)
  pins: [],              // 钉词行 [{slot, word}]
  pinFill: true,         // 原图缺该槽词时补上钉词
  banned: [],            // 禁用槽 id(原图该槽的词整词删除)
  nsfw: true,            // 候选池是否含成人词库
  seed: '',              // 种子, 空 = 每次导出都不同
  // 自然语言段(2026-11-08): 从 knowledge/nl-bank.json 抽「动作/穿搭/发型」短句
  // 追加到 prompt 末尾。tag 侧只有 25 个粗粒度姿势词, 这里是几百条具体动作句(条数
  // 随档位变化, 一律由 nlPoolSize/nlTotalSize 从语料库实时算) —— 发牌式抽样, 前 N 条两两不同。
  nl: {
    enabled: false,
    dims: ['pose'],      // 勾的维度: pose 动作 / costume 穿搭 / hair 发型
    level: 'sfw',        // sfw | soft | nsfw
    lang: 'en',          // 句子语言: en(默认) | zh(每条语料自带的手工中文译文)
    poseView: true,      // 动作句带机位(源库成套的「正面视角/俯视…」), 剔 viewpoint/camera_angle
    stripPose: true,     // 抽了动作句 → 剔原图全部动作槽(pose/pose_base/pose_risque/n_pos)
    stripCostume: true,  // 抽了穿搭句 → 剔原图全部单品槽(13 个, 见 exporter.js NL_STRIP_SLOTS)
    stripHair: true,     // 抽了发型句 → 剔 hair_len/hair_color/hairstyle
    seed: '',
  },
  nlStats: null,         // 主进程下发的语料库概况 {dims, totals, empty}
  slots: [],             // 槽清单 [{id, zh, cnt, words}] —— 主进程下发
  sections: [],          // 大类清单(给老回执的 sec id 做中文映射)
  loaded: false,
  // ---- 方案库(2026-11-09) ----
  sets: [],              // [{id, name}] —— 弹窗方案栏的下拉项(cfg 在主进程, 不整份搬过来)
  activeId: '',          // 当前方案 id
  setsLoaded: false,     // 方案库是否拉成功过(失败下次开弹窗重试)
})

/* ================= 方案库: 载入 / 写回 / 增删改名 ================= */

let loadSeq = 0
let loading = false          // 程序性赋值(载入方案/清单)期间压住自动落盘
let saveTimer = null

/** adv reactive -> 落盘 cfg(rates 0~100 -> 0~1; 只收有效钉词行) */
function cfgFromAdv() {
  const rates = {}
  for (const [k, v] of Object.entries(adv.rates)) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0 && n <= 100) rates[k] = Math.max(0, n) / 100
  }
  return {
    enabled: !!adv.enabled,
    picked: [...adv.picked],
    inserts: [...adv.inserts],
    rates,
    pins: adv.pins.filter((p) => p.slot && p.word.trim()).map((p) => ({ slot: p.slot, word: p.word.trim() })),
    pinFill: adv.pinFill !== false,
    banned: [...adv.banned],
    nsfw: adv.nsfw !== false,
    seed: String(adv.seed || ''),
    nl: {
      enabled: adv.nl.enabled !== false,
      dims: [...adv.nl.dims],
      level: ['sfw', 'soft', 'nsfw'].includes(adv.nl.level) ? adv.nl.level : 'sfw',
      lang: adv.nl.lang === 'zh' ? 'zh' : 'en',
      poseView: adv.nl.poseView !== false,
      stripPose: adv.nl.stripPose !== false,
      stripCostume: adv.nl.stripCostume !== false,
      stripHair: adv.nl.stripHair !== false,
      seed: String(adv.nl.seed || ''),
    },
  }
}

/** 落盘 cfg -> adv reactive(rates 0~1 -> 0~100 取整) */
function applyCfgToAdv(cfg = {}) {
  loading = true
  try {
    adv.enabled = cfg.enabled === true
    adv.picked = Array.isArray(cfg.picked) ? [...cfg.picked] : []
    adv.inserts = Array.isArray(cfg.inserts) ? cfg.inserts.filter((s) => typeof s === 'string' && s) : []
    adv.rates = {}
    for (const [k, v] of Object.entries(cfg.rates || {})) {
      const n = Number(v)
      if (Number.isFinite(n)) adv.rates[k] = Math.round(Math.min(1, Math.max(0, n)) * 100)
    }
    adv.pins = Array.isArray(cfg.pins) ? cfg.pins.map((p) => ({ slot: p.slot, word: p.word })) : []
    adv.pinFill = cfg.pinFill !== false
    adv.banned = Array.isArray(cfg.banned) ? [...cfg.banned] : []
    adv.nsfw = cfg.nsfw !== false
    adv.seed = String(cfg.seed || '')
    // 不变式兜底: 同一槽只能处于一种模式(禁用 > 插入 > 随机)。
    // 正常编辑走 setSlotMode 不会撞; 这里拦的是手改 json / 旧版本残留数据。
    const inBan = new Set(adv.banned)
    const inIns = new Set(adv.inserts)
    adv.picked = adv.picked.filter((s) => !inBan.has(s) && !inIns.has(s))
    adv.inserts = adv.inserts.filter((s) => !inBan.has(s))
    const n = cfg.nl || {}
    adv.nl.enabled = n.enabled === true && (Array.isArray(n.dims) && n.dims.length > 0)
    adv.nl.dims = Array.isArray(n.dims) ? [...n.dims] : []
    adv.nl.level = ['sfw', 'soft', 'nsfw'].includes(n.level) ? n.level : 'sfw'
    adv.nl.lang = n.lang === 'zh' ? 'zh' : 'en'
    adv.nl.poseView = n.poseView !== false
    adv.nl.stripPose = n.stripPose !== false
    adv.nl.stripCostume = n.stripCostume !== false
    adv.nl.stripHair = n.stripHair !== false
    adv.nl.seed = String(n.seed || '')
  } finally { loading = false }
}

/** 把整份方案列表(当前 adv 内容作为 activeId 的 cfg)整存落盘 */
async function persistSets(activeId = adv.activeId) {
  const sets = adv.sets.map((s) => ({
    id: s.id,
    name: s.name,
    cfg: s.id === activeId ? cfgFromAdv() : undefined,  // undefined = 主进程沿用库里的
  }))
  const saved = await api.advSets.save({ active: activeId, sets })
  adv.sets = (saved?.sets || []).map((s) => ({ id: s.id, name: s.name }))
  adv.activeId = saved?.active || activeId
}

/** 编辑自动落盘(debounce 600ms) —— 弹窗里任何勾选/拖率/改词都最终落盘 */
function schedulePersist() {
  if (loading || !adv.setsLoaded) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { persistSets().catch(() => {}) }, 600)
}
watch(
  () => [adv.enabled, adv.picked, adv.inserts, adv.rates, adv.pins, adv.pinFill, adv.banned, adv.nsfw, adv.seed, adv.nl],
  schedulePersist,
  { deep: true },
)

/** 槽/大类清单 + 方案库懒加载(第一次打开弹窗才拉; 失败允许重试) */
export async function ensureAdvLoaded() {
  const my = ++loadSeq
  const jobs = []
  if (!adv.loaded) {
    jobs.push(
      Promise.all([
        api.random.slots(), api.random.sections(), api.random.nlstats().catch(() => null),
      ]).then(([slots, secs, nl]) => {
        if (my !== loadSeq) return
        adv.slots = slots || []
        adv.sections = secs || []
        adv.nlStats = nl
        adv.loaded = true
      }),
    )
  }
  if (!adv.setsLoaded) {
    jobs.push(api.advSets.get().then(({ active, sets }) => {
      if (my !== loadSeq) return
      adv.sets = (sets || []).map((s) => ({ id: s.id, name: s.name }))
      adv.activeId = active || sets?.[0]?.id || ''
      // 以库里的 active 方案为准载入(会话内未落盘的临时编辑被覆盖 —— 方案库是唯一事实源)
      const cur = (sets || []).find((s) => s.id === adv.activeId)
      applyCfgToAdv(cur?.cfg)
      adv.setsLoaded = true
    }).catch(() => {}))
  }
  await Promise.all(jobs).catch(() => {})
}

/** 切换方案: 先把当前编辑写回旧方案落盘, 再载入新方案 */
export async function switchAdvSet(id) {
  if (id === adv.activeId || !adv.setsLoaded) return
  clearTimeout(saveTimer)
  const old = adv.activeId
  loading = true
  try {
    // ① 当前编辑写回旧方案(active 暂指旧方案, 库里列表沿用, 只换 old 的 cfg)
    const cur = await api.advSets.get()
    await api.advSets.save({
      active: old,
      sets: (cur?.sets || []).map((s) => (s.id === old ? { id: s.id, name: s.name, cfg: cfgFromAdv() } : { id: s.id, name: s.name })),
    })
    // ② 从库里取新方案内容, active 指过去
    const again = await api.advSets.get()
    const next = (again?.sets || []).find((s) => s.id === id)
    adv.activeId = id
    adv.sets = (again?.sets || []).map((s) => ({ id: s.id, name: s.name }))
    applyCfgToAdv(next?.cfg)
    await api.advSets.save({
      active: id,
      sets: (again?.sets || []).map((s) => ({ id: s.id, name: s.name })),
    })
  } catch { adv.activeId = old }
  finally { loading = false }
}

/** 新建方案(copy = 是否复制当前方案内容), 成功返回新方案 id */
export async function addAdvSet(name, copy = false) {
  const nm = String(name || '').trim()
  if (!nm || !adv.setsLoaded) return null
  clearTimeout(saveTimer)
  loading = true
  try {
    const { sets } = await api.advSets.get()
    const cfg = copy ? cfgFromAdv() : undefined
    const saved = await api.advSets.save({
      active: adv.activeId,
      sets: [...(sets || []).map((s) => ({ id: s.id, name: s.name })), { name: nm, cfg }],
    })
    const created = (saved?.sets || []).find((s) => s.name === nm)
    adv.sets = (saved?.sets || []).map((s) => ({ id: s.id, name: s.name }))
    if (created) {
      adv.activeId = created.id
      applyCfgToAdv(created.cfg)     // 复制内容时载入副本; 全新空方案 cfg 是 undefined → 全空
    }
    return created?.id || null
  } finally { loading = false }
}

/** 重命名方案 */
export async function renameAdvSet(id, name) {
  const nm = String(name || '').trim()
  if (!nm || !adv.setsLoaded) return
  clearTimeout(saveTimer)
  loading = true
  try {
    const { sets, active } = await api.advSets.get()
    const saved = await api.advSets.save({
      active,
      sets: (sets || []).map((s) => (s.id === id ? { id: s.id, name: nm } : { id: s.id, name: s.name })),
    })
    adv.sets = (saved?.sets || []).map((s) => ({ id: s.id, name: s.name }))
  } finally { loading = false }
}

/** 删除方案(至少留一个; 删的是当前方案就切到第一个) */
export async function deleteAdvSet(id) {
  if (!adv.setsLoaded) return
  clearTimeout(saveTimer)
  loading = true
  try {
    const { sets, active } = await api.advSets.get()
    const rest = (sets || []).filter((s) => s.id !== id)
    if (rest.length === (sets || []).length) return
    const nextActive = active === id ? rest[0]?.id : active
    const saved = await api.advSets.save({
      active: nextActive,
      sets: rest.map((s) => ({ id: s.id, name: s.name })),
    })
    adv.sets = (saved?.sets || []).map((s) => ({ id: s.id, name: s.name }))
    if (active === id) {
      adv.activeId = saved?.active || rest[0]?.id || ''
      const cur = (saved?.sets || []).find((s) => s.id === adv.activeId)
      applyCfgToAdv(cur?.cfg)
    }
  } finally { loading = false }
}

/** 槽/大类 id -> 中文名(回执细分用; 槽优先, 老的大类 id 兜底) */
export function advZh(id) {
  return adv.slots.find((x) => x.id === id)?.zh
    || adv.sections.find((x) => x.id === id)?.zh
    || id
}

/** 换词率参数串: 勾的槽拼成 "legwear:0.65,pose"(率 100% 时省略率段 = 老格式)。
 * 插入槽也在里面 —— 插入的「有词 → 换」复用同一条随机管线, 率表同一份。 */
export const advSlotsParam = computed(() => [...adv.picked, ...adv.inserts].map((id) => {
  const r = Number(adv.rates[id])
  return (Number.isFinite(r) && r >= 0 && r < 100) ? `${id}:${Math.max(0, r / 100).toFixed(2)}` : id
}).join(','))

/** 钉词参数串: "legwear:white_thighhighs,headwear:hat"(只收槽和词都填了的行) */
export const advPinsParam = computed(() => adv.pins
  .filter((p) => p.slot && p.word.trim())
  .map((p) => `${p.slot}:${p.word.trim().toLowerCase().replace(/\s+/g, '_')}`)
  .join(','))

/** 禁用槽参数串: "headwear,eyewear" */
export const advBanParam = computed(() => adv.banned.join(','))

/** 插入槽参数串(与 advSlotsParam 同格式): 率兼任「缺词补上的概率」, 缺省必补 */
export const advInsertParam = computed(() => adv.inserts.map((id) => {
  const r = Number(adv.rates[id])
  return (Number.isFinite(r) && r >= 0 && r < 100) ? `${id}:${Math.max(0, r / 100).toFixed(2)}` : id
}).join(','))

/** 有效钉词行数(统计展示用) */
export const advPinCount = computed(() => adv.pins.filter((p) => p.slot && p.word.trim()).length)

/** 槽互斥: 既钉又禁 = 冲突(保存/导出前拦) */
export const advConflicts = computed(() => {
  const pinSlots = new Set(adv.pins.filter((p) => p.slot && p.word.trim()).map((p) => p.slot))
  return adv.banned.filter((s) => pinSlots.has(s))
})

/**
 * 自然语言段**实际会剔掉的槽**(与 exporter.js 的 NL_STRIP_SLOTS 同口径, 2026-11-09)。
 * 钉词与 NL 剔槽互斥: 钉了的槽在导出端**豁免**禁用剔除(filterBannedSlots 的护栏),
 * 于是「钉 pose 词 + NL 勾动作」= 原图动作词留着、又追加 NL 动作句 —— 打架。
 * 保存前必须把这类组合拦下, 所以这里复算一份清单给冲突检查用。
 */
const NL_STRIP_MAP = {
  pose: ['pose', 'pose_base', 'pose_risque', 'n_pos'],
  view: ['viewpoint', 'camera_angle'],
  costume: ['top', 'bottom', 'outfit', 'underwear', 'legwear', 'footwear',
    'headwear', 'handwear', 'accessory', 'eyewear', 'sleeves', 'swimwear', 'clothing_type'],
  hair: ['hair_len', 'hair_color', 'hairstyle'],
}
export function nlStripSlots() {
  if (!nlActive.value) return []
  const out = new Set()
  if (adv.nl.dims.includes('pose')) {
    if (adv.nl.stripPose) for (const s of NL_STRIP_MAP.pose) out.add(s)
    if (adv.nl.poseView) for (const s of NL_STRIP_MAP.view) out.add(s)
  }
  if (adv.nl.dims.includes('costume') && adv.nl.stripCostume) {
    for (const s of NL_STRIP_MAP.costume) out.add(s)
  }
  if (adv.nl.dims.includes('hair') && adv.nl.stripHair) {
    for (const s of NL_STRIP_MAP.hair) out.add(s)
  }
  return [...out]
}

/** 钉词冲突槽 = 既钉又禁 + 既钉/既插又被 NL 剔(都拦, 保存前二选一)。
 * 插入 × NL 剔槽也是打架: NL 把该槽词删干净了, 插入又从池子里补一个回来 ——
 * 等于绕过了剔除, 所以一并拦。 */
export const advPinConflicts = computed(() => {
  const pinSlots = new Set(adv.pins.filter((p) => p.slot && p.word.trim()).map((p) => p.slot))
  const insSlots = new Set(adv.inserts)
  const hits = new Set(advConflicts.value)
  for (const s of nlStripSlots()) {
    if (pinSlots.has(s) || insSlots.has(s)) hits.add(s)
  }
  return [...hits]
})

/** 开关是否带着任何实际配置(决定导出参数里 randomize 是 1 还是 0) */
export const advActive = computed(() => adv.picked.length > 0 || adv.inserts.length > 0
  || advPinCount.value > 0 || adv.banned.length > 0)

/** 自然语言段是否真的会生效(至少勾一个维度、语料库非空) */
export const nlActive = computed(() => adv.nl.dims.length > 0
  && Array.isArray(adv.nlStats?.dims) && !adv.nlStats.empty)

/** 某个维度在当前档位下有多少条可抽(界面显示"可抽 N 条") */
export function nlPoolSize(dim) {
  const d = (adv.nlStats?.dims || []).find((x) => x.id === dim)
  if (!d) return 0
  const order = ['sfw', 'soft', 'nsfw']
  const upto = order.indexOf(adv.nl.level)
  return order.slice(0, upto + 1).reduce((n, lv) => n + (d.byLevel[lv] || 0), 0)
}

/**
 * 某个维度的**全量**条数(不分档位)。
 *
 * 只显示"可抽 N"会让人以为库里只有 N 条 —— 2026-11-08 用户看到 pose 显示 177
 * 就问"不是 1439 条吗"。界面上必须同时给分母, 否则"档位闸门"会被读成"语料只有这么多"。
 */
export function nlTotalSize(dim) {
  const d = (adv.nlStats?.dims || []).find((x) => x.id === dim)
  return d ? (d.total || 0) : 0
}

/**
 * 槽位模式(2026-11-09): 同一个槽在「未选/随机/插入/禁用」里四选一,
 * 点 chip 循环切换 —— ①参与随机与③禁用槽合并成一个区的数据基础。
 *   off     不参与
 *   random  原图有词 → 按率换(原「参与随机」)
 *   insert  导出必须含该槽: 有词 → 按率换; 没词 → 按率从槽池抽词补上
 *   ban     原图该槽的词整词删除(原「禁用槽」)
 */
export function slotMode(id) {
  if (adv.banned.includes(id)) return 'ban'
  if (adv.inserts.includes(id)) return 'insert'
  if (adv.picked.includes(id)) return 'random'
  return 'off'
}

const MODE_ORDER = ['off', 'random', 'insert', 'ban']

/** 把槽设到指定模式(先从三张清单全摘掉再挂 —— 保证同一时刻只在一张清单里) */
export function setSlotMode(id, mode) {
  for (const list of [adv.picked, adv.inserts, adv.banned]) {
    const i = list.indexOf(id)
    if (i >= 0) list.splice(i, 1)
  }
  if (mode === 'random' || mode === 'insert') {
    ;(mode === 'random' ? adv.picked : adv.inserts).push(id)
    if (adv.rates[id] === undefined) adv.rates[id] = 100
  } else if (mode === 'ban') {
    adv.banned.push(id)
  }
}

/** 点 chip: 循环到下一态。钉了有效词的槽禁用态不可选(钉词优先, 禁用与之互斥) —— 自动跳过 */
export function cycleSlotMode(id) {
  const pinned = adv.pins.some((p) => p.slot === id && p.word.trim())
  let next = MODE_ORDER[(MODE_ORDER.indexOf(slotMode(id)) + 1) % MODE_ORDER.length]
  if (next === 'ban' && pinned) next = 'off'
  setSlotMode(id, next)
}

/* 兼容旧调用(HomeView 等处): 勾选 = 在随机与未选之间切换; 禁用 = 在禁用与未选之间切换 */
export function toggleAdvSlot(id) {
  setSlotMode(id, slotMode(id) === 'random' ? 'off' : 'random')
}

export function toggleAdvBan(id) {
  setSlotMode(id, slotMode(id) === 'ban' ? 'off' : 'ban')
}

export function addAdvPin() { adv.pins.push({ slot: '', word: '' }) }
export function removeAdvPin(i) { adv.pins.splice(i, 1) }

/**
 * 导出参数(HomeView 的 exportParams / doExport / presetSnapshot 共用)。
 * 2026-11-09 方案化: 导出统一走方案库(adv_set='@active'), exporter 拿方案 cfg
 * 生成同形参数 —— 这里的快照参数是给**不带 adv_set 的老预设**兜底的, 语义保留。
 */
export function advParams() {
  return {
    adv_set: '@active',
    randomize: adv.enabled && advActive.value ? '1' : '0',
    randomize_slots: advSlotsParam.value,
    insert_slots: advInsertParam.value,
    pin_slots: advPinsParam.value,
    pin_fill: adv.pinFill ? '1' : '0',
    ban_slots: advBanParam.value,
    randomize_nsfw: adv.nsfw ? '1' : '0',
    randomize_seed: adv.seed.trim(),
    // 自然语言段(勾了维度即生效, 与随机换词互不影响; 空 = 不启用)
    nl_dims: nlActive.value ? adv.nl.dims.join(',') : '',
    nl_level: adv.nl.level,
    nl_lang: adv.nl.lang === 'zh' ? 'zh' : 'en',
    nl_strip_pose: adv.nl.stripPose ? '1' : '0',
    nl_pose_view: adv.nl.poseView ? '1' : '0',
    nl_strip_costume: adv.nl.stripCostume ? '1' : '0',
    nl_strip_hair: adv.nl.stripHair ? '1' : '0',
    nl_seed: adv.nl.seed.trim(),
  }
}
