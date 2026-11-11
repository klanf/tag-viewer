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
  weights: {},           // 槽 id -> 权重(0.1~2.0, 2026-11-10), 1 = 不加壳; 换/补出来的词套 (tag:w)
  pins: [],              // 钉词行 [{slot, word, weight, auto}] —— auto = 槽是词归属自动填的
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
    // 语料黑名单(2026-11-11): 逗号分隔关键词(中/英), 命中整条语料即剔除。
    // 例: "针织衫, knit" —— 不想让"她穿着针织衫"这类整套穿搭进池子。
    banned: '',
  },
  nlStats: null,         // 主进程下发的语料库概况 {dims, totals, empty}
  // 图库组合池(2026-11-11): 第三套来源 —— char-db 的「动作/穿搭」tag 组合串
  // (一条 = 一套完整写法, 如 "standing, hands on hips")。不拆单词、不进随机引擎,
  // 与 NL 一样在导出末尾整段追加。**同一维度内与 NL 互斥**(点这个自动关那个)。
  cd: {
    enabled: false,
    dims: [],            // pose 动作 / outfit 穿搭
    dual: false,         // 是否抽含 2girls 等人数 tag 的双人条目
    seed: '',
  },
  cdStats: null,         // {dims:[{id, zh, total, dual, available}], empty}
  /* 混合来源(2026-11-11): 同一维度内不再"整面二选一", 而是**逐行**按配比 roll ——
     这一行由 tag 池 / 语料句 / 图库串里的哪一套供词是抽出来的, 但一行只出一套。
     键用 nl 的语义面口径(pose/costume/hair), 值 = 三段权重 0-100。 */
  mix: {
    enabled: false,
    ratios: {},          // { pose: {tag:40, nl:40, cd:20}, costume: {...} }
    seed: '',
  },
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
  /* 权重(2026-11-10): 只存非 1 的槽 —— 1 是"不加壳"的缺省, 存进去只会让 json 长胖,
   * 而且没法从"没有这个键"和"显式 1"里分辨用户意图(其实也没区别)。 */
  const weights = {}
  for (const [k, v] of Object.entries(adv.weights)) {
    const n = Number(v)
    if (!k || !Number.isFinite(n) || n <= 0) continue
    const w = Math.min(2, Math.max(0.05, n))
    if (Math.abs(w - 1) > 1e-3) weights[k] = Number(w.toFixed(2))
  }
  return {
    enabled: !!adv.enabled,
    picked: [...adv.picked],
    inserts: [...adv.inserts],
    rates,
    weights,
    pins: adv.pins.filter((p) => p.slot && p.word.trim()).map((p) => {
      const w = Math.min(2, Math.max(0.05, Number(p.weight) || 1))
      return { slot: p.slot, word: p.word.trim(), weight: Math.abs(w - 1) > 1e-3 ? Number(w.toFixed(2)) : 1 }
    }),
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
      banned: String(adv.nl.banned || ''),
    },
    cd: {
      enabled: adv.cd.enabled === true && adv.cd.dims.length > 0,
      dims: [...adv.cd.dims],
      dual: adv.cd.dual === true,
      seed: String(adv.cd.seed || ''),
    },
    mix: {
      enabled: adv.mix.enabled === true && Object.keys(adv.mix.ratios).length > 0,
      ratios: JSON.parse(JSON.stringify(adv.mix.ratios || {})),
      seed: String(adv.mix.seed || ''),
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
    adv.weights = {}
    for (const [k, v] of Object.entries(cfg.weights || {})) {
      const n = Number(v)
      if (k && Number.isFinite(n) && n > 0) adv.weights[k] = Math.min(2, Math.max(0.05, n))
    }
    adv.pins = Array.isArray(cfg.pins)
      ? cfg.pins.map((p) => {
          const w = Number(p.weight)
          // _seenWord: 弹窗用它判断"词是不是刚被改过"(改过才重新自动归类), 不落盘
          return { slot: p.slot, word: p.word, weight: Number.isFinite(w) && w > 0 ? w : 1, auto: false, _seenWord: p.word }
        })
      : []
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
    adv.nl.banned = typeof n.banned === 'string'
      ? n.banned
      : (Array.isArray(n.banned) ? n.banned.join(',') : '')
    const c = cfg.cd || {}
    adv.cd.enabled = c.enabled === true && Array.isArray(c.dims) && c.dims.length > 0
    adv.cd.dims = Array.isArray(c.dims) ? c.dims.filter((x) => ['pose', 'outfit'].includes(x)) : []
    adv.cd.dual = c.dual === true
    adv.cd.seed = String(c.seed || '')
    const m = cfg.mix || {}
    adv.mix.enabled = m.enabled === true && !!m.ratios && typeof m.ratios === 'object'
    adv.mix.ratios = {}
    for (const dim of ['pose', 'costume', 'hair']) {
      const r = (m.ratios || {})[dim]
      if (!r || typeof r !== 'object') continue
      const num = (v) => {
        const x = Number(v)
        return Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 0
      }
      const w = { tag: num(r.tag), nl: num(r.nl), cd: dim === 'hair' ? 0 : num(r.cd) }
      if (w.tag + w.nl + w.cd > 0) adv.mix.ratios[dim] = w
    }
    adv.mix.seed = String(m.seed || '')
    if (!Object.keys(adv.mix.ratios).length) adv.mix.enabled = false
    // 手改 json 的兜底: 同一维度被 NL 占了就让给 NL(UI 点选时也会互斥);
    // 混合占的维度同样要从 nl/cd 里摘掉 —— 一个维度不能既固定来源又逐行 roll
    if (adv.cd.enabled && adv.nl.enabled && adv.nl.dims.length) {
      adv.cd.dims = adv.cd.dims.filter((x) => !adv.nl.dims.includes(x))
      if (!adv.cd.dims.length) adv.cd.enabled = false
    }
    if (adv.mix.enabled) {
      const mixed = Object.keys(adv.mix.ratios)
      adv.nl.dims = adv.nl.dims.filter((x) => !mixed.includes(x))
      if (!adv.nl.dims.length) adv.nl.enabled = false
      adv.cd.dims = adv.cd.dims.filter((x) => !mixed.includes(x === 'outfit' ? 'costume' : x))
      if (!adv.cd.dims.length) adv.cd.enabled = false
    }
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
  () => [adv.enabled, adv.picked, adv.inserts, adv.rates, adv.weights, adv.pins, adv.pinFill, adv.banned, adv.nsfw, adv.seed, adv.nl],
  schedulePersist,
  { deep: true },
)

/** 槽/大类清单 + 方案库懒加载(第一次打开弹窗才拉; 失败允许重试) */
export async function ensureAdvLoaded() {
  const my = ++loadSeq
  const jobs = []
  /* 语料统计**每次打开都重拉**(2026-11-11): 标签页里可能刚禁了几条句子,
     缓存的分母/可抽数就偏大。读 JSON + 遍历 1600 条, 毫秒级, 不值得做失效判断。 */
  jobs.push(
    api.random.nlstats(String(adv.nl.banned || ''))
      .then((nl) => { if (my === loadSeq && nl) adv.nlStats = nl })
      .catch(() => {}),
  )
  // 图库组合池条数(静态文件, 每次打开重拉也无所谓: 读 74KB JSON)
  jobs.push(
    api.random.cdstats()
      .then((cd) => { if (my === loadSeq && cd) adv.cdStats = cd })
      .catch(() => {}),
  )
  if (!adv.loaded) {
    jobs.push(
      Promise.all([api.random.slots(), api.random.sections()])
        .then(([slots, secs]) => {
          if (my !== loadSeq) return
          adv.slots = slots || []
          adv.sections = secs || []
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

/* 语料黑名单改了 → 让主进程重算「可抽 / 已剔」条数(400ms 防抖: 输入框逐字敲不该刷 IPC)。
 * 初次 ensureAdvLoaded 拉的 stats 不带 ban(那时方案还没载入), 由这里补一次。 */
let nlStatsTimer = null
watch(() => adv.nl.banned, () => {
  clearTimeout(nlStatsTimer)
  nlStatsTimer = setTimeout(() => {
    api.random.nlstats(String(adv.nl.banned || ''))
      .then((s) => { if (s) adv.nlStats = s })
      .catch(() => {})
  }, 400)
})

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

/** 钉词参数串: "legwear:white_thighhighs@1.2,headwear:hat"(只收槽和词都填了的行)。
 *  @权重(2026-11-10): 只在不是 1 的时候挂尾巴 —— 1 = 不加壳, 与老格式完全等价。 */
export const advPinsParam = computed(() => adv.pins
  .filter((p) => p.slot && p.word.trim())
  .map((p) => {
    const w = Math.min(2, Math.max(0.05, Number(p.weight) || 1))
    const tail = Math.abs(w - 1) > 1e-3 ? `@${w.toFixed(2)}` : ''
    return `${p.slot}:${p.word.trim().toLowerCase().replace(/\s+/g, '_')}${tail}`
  })
  .join(','))

/** 禁用槽参数串: "headwear,eyewear" */
export const advBanParam = computed(() => adv.banned.join(','))

/** 插入槽参数串(与 advSlotsParam 同格式): 率兼任「缺词补上的概率」, 缺省必补 */
export const advInsertParam = computed(() => adv.inserts.map((id) => {
  const r = Number(adv.rates[id])
  return (Number.isFinite(r) && r >= 0 && r < 100) ? `${id}:${Math.max(0, r / 100).toFixed(2)}` : id
}).join(','))

/** 槽位权重参数串(2026-11-10): "legwear:1.2,pose:0.8" —— 非 1 的槽才进串 */
export const advWeightsParam = computed(() => [...adv.picked, ...adv.inserts]
  .map((id) => {
    const w = slotWeightOf(id)
    return Math.abs(w - 1) > 1e-3 ? `${id}:${w.toFixed(2)}` : ''
  })
  .filter(Boolean)
  .join(','))

/** 槽的权重(1 = 不加壳) */
export function slotWeightOf(id) {
  const n = Number(adv.weights[id])
  return Number.isFinite(n) && n > 0 ? Math.min(2, n) : 1
}

/** 设槽权重: 0.1~2.0, 落 1 就把键删掉(缺省即 1, 不占 json) */
export function setSlotWeight(id, v) {
  const n = Number(v)
  if (!id) return
  if (!Number.isFinite(n) || n <= 0) { delete adv.weights[id]; return }
  const w = Math.min(2, Math.max(0.1, n))
  if (Math.abs(w - 1) < 1e-3) delete adv.weights[id]
  else adv.weights[id] = Number(w.toFixed(2))
}

/** 钉词行的权重(缺省 1 = 不加壳) */
export function pinWeightOf(p) {
  const n = Number(p?.weight)
  return Number.isFinite(n) && n > 0 ? Math.min(2, n) : 1
}

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
export const NL_STRIP_MAP = {
  pose: ['pose', 'pose_base', 'pose_risque', 'n_pos'],
  view: ['viewpoint', 'camera_angle'],
  costume: ['top', 'bottom', 'outfit', 'underwear', 'legwear', 'footwear',
    'headwear', 'handwear', 'accessory', 'eyewear', 'sleeves', 'swimwear', 'clothing_type'],
  hair: ['hair_len', 'hair_color', 'hairstyle'],
}
export function nlStripSlots() {
  const out = new Set()
  if (nlActive.value) {
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
  }
  /* 图库组合池(第三套)接管的是**同一批槽**(导出端也是同一张表), 所以并进这里 ——
     界面上的灰槽、钉词/插入的软提示都跟着一起准。 */
  if (adv.cd.enabled) {
    if (adv.cd.dims.includes('pose')) for (const s of NL_STRIP_MAP.pose) out.add(s)
    if (adv.cd.dims.includes('outfit')) for (const s of NL_STRIP_MAP.costume) out.add(s)
  }
  return [...out]
}

/**
 * 钉词冲突 = **既钉又禁**(同槽), 只在手改 json / 旧数据里可能出现。
 *
 * 2026-11-10 大改(用户实锤): 原来这里把「钉词 × 自然语言段剔槽」也算冲突, 于是
 * 「钉一双鞋 + 开着穿搭句剔除」就被拦下报"打架" —— 可钉子本来就是**用户点名要的东西**,
 * 导出端 filterBannedSlots 早就给钉了的槽开了豁免(pinnedSlots), 语义上钉词优先,
 * 根本不该拦。现在这类重叠降级成软提示(见 advStripSoftNotes), 保存照过。
 */
export const advPinConflicts = computed(() => {
  const pinSlots = new Set(adv.pins.filter((p) => p.slot && p.word.trim()).map((p) => p.slot))
  return adv.banned.filter((s) => pinSlots.has(s))
})

/**
 * 软提示(不拦保存): 这些槽会被自然语言段剔除, 而用户又在上面钉词/插入。
 *   · pin    钉词 —— 导出时钉词槽豁免剔除, 该槽**只留钉词**(随机阶段先整槽定死), 正常生效
 *   · insert 插入 —— 导出端会把这类插入槽删掉(rndBan 里的一律不补词), 等于不生效,
 *             所以要明确告诉用户"想补词就关掉该维度的剔除开关"
 */
export const advStripSoftNotes = computed(() => {
  const strip = new Set(nlStripSlots())
  if (!strip.size) return []
  const out = []
  for (const p of adv.pins) {
    if (p.slot && p.word.trim() && strip.has(p.slot)) out.push({ slot: p.slot, kind: 'pin' })
  }
  for (const s of adv.inserts) if (strip.has(s)) out.push({ slot: s, kind: 'insert' })
  return out
})

/** 开关是否带着任何实际配置(决定导出参数里 randomize 是 1 还是 0) */
export const advActive = computed(() => adv.picked.length > 0 || adv.inserts.length > 0
  || advPinCount.value > 0 || adv.banned.length > 0)

/** 自然语言段是否真的会生效(至少勾一个维度、语料库非空) */
export const nlActive = computed(() => adv.nl.dims.length > 0
  && Array.isArray(adv.nlStats?.dims) && !adv.nlStats.empty)

/** 某个维度在当前档位下有多少条可抽(界面显示"可抽 N 条")。
 *  扣的是 **disabled**(关键词黑名单 + 标签页里的单条禁用) —— 只用 banned 会漏算后者。 */
export function nlPoolSize(dim) {
  const d = (adv.nlStats?.dims || []).find((x) => x.id === dim)
  if (!d) return 0
  const order = ['sfw', 'soft', 'nsfw']
  const upto = order.indexOf(adv.nl.level)
  const inLevel = (lv) => order.slice(0, upto + 1).includes(lv)
  const all = Object.entries(d.byLevel || {}).reduce((n, [lv, c]) => n + (inLevel(lv) ? c : 0), 0)
  const cut = Object.entries(d.disabledByLevel || d.bannedByLevel || {})
    .reduce((n, [lv, c]) => n + (inLevel(lv) ? c : 0), 0)
  return Math.max(0, all - cut)
}

/** 某个维度在当前档位下被禁用(关键词 + 单条)剔掉了多少条(界面显示"已剔 N 条") */
export function nlBannedSize(dim) {
  const d = (adv.nlStats?.dims || []).find((x) => x.id === dim)
  if (!d) return 0
  const order = ['sfw', 'soft', 'nsfw']
  const upto = order.indexOf(adv.nl.level)
  const src = d.disabledByLevel || d.bannedByLevel || {}
  return order.slice(0, upto + 1).reduce((n, lv) => n + (src[lv] || 0), 0)
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

/* ================= 图库组合池(2026-11-11, 第三套) ================= */

/** 有维度勾选且池子非空 —— 与 nlActive 同形, UI 用它决定 chip 亮不亮 */
export const cdActive = computed(() => adv.cd.dims.length > 0
  && Array.isArray(adv.cdStats?.dims) && !adv.cdStats.empty)

/** 某维度当前**可抽**条数(不含双人条目, 除非开了 dual) */
export function cdPoolSize(dim) {
  const d = (adv.cdStats?.dims || []).find((x) => x.id === dim)
  if (!d) return 0
  return adv.cd.dual ? (d.total || 0) : (d.available || 0)
}

/** 某维度**全量**条数(界面分母, 同 nlTotalSize 的理由: 只显示可抽会被读成"就这么多") */
export function cdTotalSize(dim) {
  const d = (adv.cdStats?.dims || []).find((x) => x.id === dim)
  return d ? (d.total || 0) : 0
}

/* ================= 混合来源(2026-11-11, 同一维度的第四种状态) =================
 * tag 池(默认) / 📝 语料 / 🎬 图库 / 🔀 混合 —— 混合不是"三套各抽一条", 而是
 * **逐行 roll 一次**: 这一行这个维度由谁供词是抽出来的, 所以一行仍然只有一套。
 * 键用 nl 的语义面口径(pose/costume/hair), 图库那边 costume 叫 outfit。 */
export const MIX_DIMS = ['pose', 'costume', 'hair']
export const MIX_CD_FACE = { pose: 'pose', costume: 'outfit', hair: '' }

/** 该维度是否处于混合态 */
export function mixOn(dim) {
  return adv.mix.enabled === true && !!adv.mix.ratios[dim]
}

/** 该维度的配比(没设过就给默认值; 发型没有图库池, 那一段恒 0) */
export function mixRatioOf(dim) {
  const r = adv.mix.ratios[dim]
  if (r) return { tag: r.tag, nl: r.nl, cd: dim === 'hair' ? 0 : r.cd }
  return dim === 'hair' ? { tag: 50, nl: 50, cd: 0 } : { tag: 40, nl: 40, cd: 20 }
}

/** 混合占用的槽 —— 界面上画成**半灰**: 这些槽只在 roll 到 tag 池的那几行里还有效 */
export function mixStripSlots() {
  if (adv.mix.enabled !== true) return []
  const out = new Set()
  if (adv.mix.ratios.pose) for (const s of NL_STRIP_MAP.pose) out.add(s)
  if (adv.mix.ratios.costume) for (const s of NL_STRIP_MAP.costume) out.add(s)
  if (adv.mix.ratios.hair) for (const s of NL_STRIP_MAP.hair) out.add(s)
  return [...out]
}

/** 开/关某维度的混合 —— 同维度的 📝 与 🎬 让位(一个维度只能有一种供词方式) */
export function toggleMixDim(dim) {
  if (!MIX_DIMS.includes(dim)) return
  if (adv.mix.ratios[dim]) {
    delete adv.mix.ratios[dim]
    if (!Object.keys(adv.mix.ratios).length) adv.mix.enabled = false
    return
  }
  adv.mix.ratios[dim] = mixRatioOf(dim)
  adv.mix.enabled = true
  if (adv.nl.dims.includes(dim)) {
    adv.nl.dims = adv.nl.dims.filter((x) => x !== dim)
    if (!adv.nl.dims.length) adv.nl.enabled = false
  }
  const cdDim = MIX_CD_FACE[dim]
  if (cdDim && adv.cd.dims.includes(cdDim)) {
    adv.cd.dims = adv.cd.dims.filter((x) => x !== cdDim)
    if (!adv.cd.dims.length) adv.cd.enabled = false
  }
}

/** 改混合配比(0-100 取整); 三段全 0 没有意义, 兜底回 100/0/0 */
export function setMixRatio(dim, src, val) {
  const r = adv.mix.ratios[dim]
  if (!r || !['tag', 'nl', 'cd'].includes(src)) return
  const n = Math.max(0, Math.min(100, Math.round(Number(val) || 0)))
  r[src] = n
  if (r.tag + r.nl + r.cd <= 0) r.tag = 100
}

/**
 * 切换某维度的图库池开关 —— **同一维度内三套互斥**: 开了图库就把 NL 里同维度关掉
 * (反过来 NL 那边关图库), 因为两者都是"整段接管", 同时开会写出两套动作/穿搭。
 */
export function toggleCdDim(dim) {
  if (!['pose', 'outfit'].includes(dim)) return
  const on = adv.cd.dims.includes(dim)
  if (on) {
    adv.cd.dims = adv.cd.dims.filter((x) => x !== dim)
    if (!adv.cd.dims.length) adv.cd.enabled = false
    return
  }
  adv.cd.dims = [...adv.cd.dims, dim]
  adv.cd.enabled = true
  if (adv.nl.dims.includes(dim)) {
    adv.nl.dims = adv.nl.dims.filter((x) => x !== dim)
    if (!adv.nl.dims.length) adv.nl.enabled = false
  }
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
    delete adv.weights[id]      // 禁用的槽不再出词, 权重留着只会让 json 长草
  } else {
    delete adv.weights[id]
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

export function addAdvPin() { adv.pins.push({ slot: '', word: '', weight: 1, auto: true, _seenWord: '' }) }
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
    slot_weights: advWeightsParam.value,
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
    nl_ban: adv.nl.banned.trim(),
    // 图库组合池段(第三套): 同一维度与 NL 互斥, 导出端还会再让一次
    cd_dims: cdActive.value ? adv.cd.dims.join(',') : '',
    cd_dual: adv.cd.dual ? '1' : '0',
    cd_seed: adv.cd.seed.trim(),
    // 混合来源: "pose:40/40/20;costume:40/40/20" —— 三段恒为 tag/语料/图库
    mix_dims: (adv.mix.enabled === true && Object.keys(adv.mix.ratios).length)
      ? Object.entries(adv.mix.ratios)
        .map(([d, r]) => `${d}:${r.tag}/${r.nl}/${d === 'hair' ? 0 : r.cd}`)
        .join(';')
      : '',
    mix_seed: String(adv.mix.seed || '').trim(),
  }
}
