/**
 * 自然语言语料库(2026-11-08) —— 「动作 / 穿搭 / 发型」短句池
 * ==========================================================
 * 为什么要有它:
 *   原来的随机替换只能在 tag 层面换词, 而姿势池只有 25 个粗粒度词
 *   (arm_up / standing / knee_up …) —— 抽 50 条必然撞车, 这就是"导出后
 *   动作姿势雷同"的根因。这两个开源图库提供的是**具体动作的自然语言描述**
 *   (286 个唯一动作, 如 "one hand braced against the wall, hips pushed back"),
 *   Anima 这类吃自然语言的模型能直接理解, 不需要翻译成伪 tag。
 *
 * 数据来源(只取文字元数据, 不分发图片):
 *   anhao/ai-pose-gallery-zh  姿势名 286 / 发型 54   代码 MIT, 图片版权 ギア
 *   paipiange/nvzhuang        服装英文关键词          MIT
 *   → 由 tools/build-nl-bank.py 生成 knowledge/nl-bank.json
 *
 * 抽法: **发牌, 不是掷骰**
 *   每个维度维护一个洗牌队列, 抽一张出一张, 抽完一轮重新洗牌。
 *   于是同一批导出里, 前 N 条的动作两两不同(N ≤ 池子大小), 而不是
 *   "随机 50 次里有 8 次撞到同一个"。批内去重是构造性保证, 不是概率性保证。
 *   超过池子大小才开始第二轮 —— 那时候重复不可避免, 但会**优先挑最久没用的**
 *   (队列轮转), 不会出现"十条里三条一样"。
 *
 * 档位闸门: level = sfw | soft | nsfw, 按 maxLevel 收敛后才进队列 ——
 *   准入点唯一, 后面的逻辑不可能把超档句子拉回来(与 export-random 同思路)。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BUNDLED_KNOWLEDGE_DIR } from './paths.js'

export const NL_DIMS = ['pose', 'costume', 'hair']
export const NL_LEVELS = ['sfw', 'soft', 'nsfw']

/** 条目 id —— 单条禁用/列表行都用它。
 *  en 在 pose/costume 里唯一, hair 有 4 条同句(不同分类), 同 id 一起禁用是可接受
 *  的语义(同一句英文, 禁它就是都不要)。加 dim 前缀避免跨维度撞车。
 *  定义在语料模块里(而不是 nl-overrides), 让「id 规则」只有一份实现。 */
export function nlEntryKey(dim, en) {
  const k = String(en || '').trim().toLowerCase().replace(/[\s_]+/g, ' ')
  return `${dim}::${k}`
}

/** 以这些词开头的动作句是**名词短语**(both hands behind her head / legs crossed …),
 *  直接追加成独立短语才通顺; 套 "she is" 会变成 "she is both hands behind her head"(病句)。
 *  2026-11-08 实测 286 条里有 60 条属于这一类。 */
const NOUN_START = new Set([
  'hands', 'hand', 'arms', 'arm', 'legs', 'leg', 'fingers', 'finger', 'wrists', 'wrist',
  'ankles', 'ankle', 'knees', 'knee', 'chest', 'face', 'back', 'hips', 'head', 'hair',
  'feet', 'toes', 'thighs', 'shoulders', 'elbows', 'palms', 'eyes', 'mouth', 'tongue',
  'belly', 'waist', 'breasts', 'one', 'both', 'her', 'legs', 'ears', 'neck',
])
const startsWithNoun = (s) => NOUN_START.has(String(s).trim().split(/\s+/)[0].toLowerCase())

/** 维度展示名 + 拼装模板(英文/中文) —— 模板决定了句子怎么读
 *  机位不是独立维度: 它跟着 pose 走(`she is <动作>, seen from above`), 因为源库
 *  1439 行是作者成套拍好的「动作 × 机位」, 拆成两维会造出源库没有的配对。
 *  tplZh(2026-11-10): 中文语料本身就是短句(「S形站姿・胯部侧顶」), 动作不用加主语;
 *  穿搭/发型要补谓语才成句。 */
const DIM_META = {
  pose: {
    zh: '动作姿势',
    tpl: (s) => (startsWithNoun(s) ? s : `she is ${s}`),
    tplZh: (s) => s,
  },
  costume: {
    zh: '整套穿搭',
    tpl: (s) => `she is wearing ${s}`,
    tplZh: (s) => `她穿着${s}`,
  },
  hair: {
    zh: '发型',
    tpl: (s) => `her hair is ${s}`,
    tplZh: (s) => `她的头发是${s}`,
  },
}

let _bank = null
/** 缺知识包时不能抛(装出来的包漏打 knowledge/ 那次教训) —— 降级成空库 */
function bank() {
  if (_bank) return _bank
  try {
    _bank = JSON.parse(readFileSync(path.join(BUNDLED_KNOWLEDGE_DIR, 'nl-bank.json'), 'utf8'))
  } catch {
    _bank = { meta: { counts: { pose: 0, costume: 0, hair: 0 } }, pose: [], costume: [], hair: [], views: {} }
  }
  for (const d of NL_DIMS) if (!Array.isArray(_bank[d])) _bank[d] = []
  return _bank
}

/** 知识包版本变了要重读(设置页下载/更新后) */
export function reloadNlBank() { _bank = null; _tagIndex = null }

/**
 * 语料库概况 —— 给设置页/导出弹窗显示"有多少条可用"。
 * pose 另给 combos: 动作数 × 各自真实机位 = 源库"动作 × 机位"配对总数(1429),
 * 界面上的"可抽 N 条"仍按**动作数**算 —— 一条 prompt 只出一个动作。
 * @param {{banned?: string|string[], bannedIds?: string[]}} [opts]
 *   banned     = 用户关键词黑名单, 命中数按档位分桶(bannedByLevel)
 *   bannedIds  = 全局单条禁用(标签页语料管理), 与关键词取并集算 disabled
 * @returns {{version, generatedAt, sources: string[], dims: Array<{id, zh, total, byLevel, banned, bannedByLevel, disabled, disabledByLevel, combos?, views?}>}}
 */
export function nlBankStats(opts = {}) {
  const b = bank()
  const keys = splitNlBan(opts.banned)
  const ids = new Set(
    (Array.isArray(opts.bannedIds) ? opts.bannedIds : [])
      .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
  )
  const dims = NL_DIMS.map((id) => {
    const byLevel = { sfw: 0, soft: 0, nsfw: 0 }
    const bannedByLevel = { sfw: 0, soft: 0, nsfw: 0 }
    const disabledByLevel = { sfw: 0, soft: 0, nsfw: 0 }
    for (const it of b[id]) {
      const lv = it.level || 'sfw'
      byLevel[lv] = (byLevel[lv] || 0) + 1
      const byKey = hitKeysOf(it, keys).length > 0
      const byId = ids.size > 0 && ids.has(nlEntryKey(id, it.en))
      if (byKey) bannedByLevel[lv] = (bannedByLevel[lv] || 0) + 1
      if (byKey || byId) disabledByLevel[lv] = (disabledByLevel[lv] || 0) + 1
    }
    const row = {
      id,
      zh: DIM_META[id].zh,
      total: b[id].length,
      byLevel,
      banned: Object.values(bannedByLevel).reduce((a, c) => a + c, 0),
      bannedByLevel,
      disabled: Object.values(disabledByLevel).reduce((a, c) => a + c, 0),
      disabledByLevel,
    }
    if (id === 'pose') {
      row.combos = b[id].reduce((n, it) => n + Math.max(1, (it.views || []).length), 0)
      row.views = Object.keys(b.views || {}).length
    }
    return row
  })
  return {
    version: b.meta?.version || 0,
    generatedAt: b.meta?.generatedAt || '',
    sources: (b.meta?.sources || []).map((s) => s.name),
    totals: b.meta?.counts || {},
    dims,
    empty: dims.every((d) => d.total === 0),
  }
}

/**
 * 语料列表(标签页「自然语言语料管理」的数据源) —— 分页 + 搜索 + 禁用状态。
 * @param {{dim?: string, level?: string, q?: string, offset?: number, limit?: number,
 *          banned?: string[], bannedIds?: string[]}} opts
 *   dim    '' = 全部; 'pose'|'costume'|'hair'
 *   level  '' = 全部档位(精确匹配, 不是"上限" —— 管理界面要看"露骨的有哪些")
 *   q      中英文子串, 命中 en/zh/kw/cat
 * @returns {{total, offset, limit, items: Array<{id, dim, dimZh, zh, en, cat, level, views, disabled, byId, byKeys}>}}
 */
export function nlList(opts = {}) {
  const dims = opts.dim && NL_DIMS.includes(opts.dim) ? [opts.dim] : NL_DIMS
  const level = NL_LEVELS.includes(opts.level) ? opts.level : ''
  const q = String(opts.q || '').trim().toLowerCase()
  const keys = splitNlBan(opts.banned)
  const ids = new Set(
    (Array.isArray(opts.bannedIds) ? opts.bannedIds : [])
      .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
  )
  const rows = []
  for (const dim of dims) {
    for (const it of bank()[dim]) {
      if (level && (it.level || 'sfw') !== level) continue
      if (q) {
        const hay = [it.en, it.zh, it.kw, it.cat].map((s) => String(s || '').toLowerCase())
        if (!hay.some((h) => h.includes(q))) continue
      }
      const id = nlEntryKey(dim, it.en)
      const byKeys = hitKeysOf(it, keys)
      const byId = ids.has(id)
      const disabled = byId || byKeys.length > 0
      // 「只看已禁」用于管理界面核对"我到底禁了哪些" —— 在服务端过滤, 分页才准
      if (opts.disabledOnly && !disabled) continue
      rows.push({
        id,
        dim,
        dimZh: DIM_META[dim].zh,
        zh: it.zh || '',
        en: it.en || '',
        cat: it.cat || '',
        level: it.level || 'sfw',
        views: Array.isArray(it.views) ? it.views.length : 0,
        disabled,
        byId,
        byKeys,
      })
    }
  }
  const offset = Math.max(0, Number(opts.offset) || 0)
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100))
  return { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) }
}

/**
 * 用户黑名单(2026-11-11): 逗号分隔的关键词, 命中**整条语料**即剔除。
 * 为什么整条而不是只删那个片段: 一条 costume 就是"她穿着 A、B、C"一整套,
 * 删掉片段会留下半套搭配(且句子模板 "she is wearing" 后面少件东西)。
 * @param {string|string[]} v 原始输入("针织衫, knit") 或已拆好的数组
 * @returns {string[]} 小写关键词
 */
export function splitNlBan(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，;；]/)
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
}

/** 一条语料**命中的关键词**(空数组 = 没命中) —— en/zh/kw/cat 任一字段包含即算。
 *  costume 的 kw 是源库自带英文关键词串(an ivory frilled knit top → "knit top"),
 *  查它比查整句 en 更容易命中"针织"这类词族。
 *  返回命中的词而不是布尔, 是为了管理界面能说清"这条为什么被禁"(因含「针织」)。 */
function hitKeysOf(it, keys) {
  if (!keys.length) return []
  const hay = [it.en, it.zh, it.kw, it.cat].map((s) => String(s || '').toLowerCase())
  return keys.filter((k) => hay.some((h) => h && h.includes(k)))
}

function bannedHit(it, keys) { return hitKeysOf(it, keys).length > 0 }

/**
 * 按档位取候选池。
 * maxLevel 之后的档位整批剔除(构造期收敛), 不在这里做"抽完再扔"。
 * banned 是用户黑名单关键词(见 splitNlBan), 同样在构建期剔除 —— 发牌队列里
 * 根本不会有被 ban 的句子, 界面报的"可抽 N 条"也就是真实可抽数。
 */
function poolOf(dim, maxLevel, banned, bannedIds) {
  const allow = NL_LEVELS.slice(0, Math.max(1, NL_LEVELS.indexOf(maxLevel) + 1))
  const keys = Array.isArray(banned) ? banned : []
  const ids = bannedIds instanceof Set ? bannedIds : new Set(bannedIds || [])
  return (bank()[dim] || [])
    .filter((it) => allow.includes(it.level || 'sfw')
      && !bannedHit(it, keys)
      && !(ids.size && ids.has(nlEntryKey(dim, it.en))))
}

function mulberry32(seed) {
  let a = 0
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) | 0
  if (!a) a = 0x9e3779b9
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates, 用给定 rng —— seed 固定时整批可复现 */
function shuffle(arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

/**
 * 造一个批次抽句器。
 * @param {{dims?: string[], maxLevel?: 'sfw'|'soft'|'nsfw', seed?: string|number|null, poseView?: boolean}} opts
 *   dims      要抽的维度(缺省 = ['pose']) —— 用户只想要动作时就只给 pose
 *   maxLevel  档位上限(缺省 'sfw' = 只出安全句); 'soft' 含性暗示; 'nsfw' 全开
 *   seed      固定则整批可复现; 留空每次不同
 *   poseView  动作句是否带机位(缺省 true) —— 机位取该动作**在源库里真实有的**那几个,
 *             所以产物永远能对上 1439 行里的某一条
 * @returns {{
 *   active: string[],
 *   pick: (idx: number) => {text: string, parts: Array<{dim: string, zh: string, en: string, view?: object}>},
 *   stats: () => Object<string, {pool: number, dealt: number}>,
 * }}
 */
export function makeNlPicker(opts = {}) {
  const dims = (Array.isArray(opts.dims) ? opts.dims : [])
    .filter((d) => NL_DIMS.includes(d))
  // 固定按 NL_DIMS 声明顺序拼句, 不随勾选先后变(旧版 view 独立维度时的遗留约束,
  // 留着是因为 costume/hair 谁先谁后同样会影响句子读起来顺不顺)
  const active = (dims.length ? dims : ['pose'])
    .slice()
    .sort((a, b) => NL_DIMS.indexOf(a) - NL_DIMS.indexOf(b))
  const maxLevel = NL_LEVELS.includes(opts.maxLevel) ? opts.maxLevel : 'sfw'
  const poseView = opts.poseView !== false
  const banned = splitNlBan(opts.banned)
  /* 全局单条禁用(标签页「自然语言语料管理」里禁的句子) —— 与关键词黑名单是
     并集关系: 关键词来自本方案 + 全局, 单条只来自全局(见 nl-overrides.js) */
  const bannedIds = new Set(
    (Array.isArray(opts.bannedIds) ? opts.bannedIds : [])
      .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
  )

  const seedBase = opts.seed != null && String(opts.seed).length
    ? String(opts.seed)
    : `${Date.now()}::${Math.floor(Math.random() * 2 ** 31)}`

  // 每个维度一条发牌队列: 抽到队头, 队空就重洗(洗牌时把上一轮整体打乱)
  const queues = new Map()
  const dealt = new Map()
  const rngOf = (dim, round) => mulberry32(`${seedBase}::nl::${dim}::${round}`)

  function takeOne(dim, idx) {
    let q = queues.get(dim)
    if (!q || !q.order.length) {
      const pool = poolOf(dim, maxLevel, banned, bannedIds)
      if (!pool.length) return null
      const round = (q?.round || 0) + 1
      const order = shuffle(pool, rngOf(dim, round))
      q = { order, round, pool: order.length }
      queues.set(dim, q)
    }
    const hit = q.order.shift()
    dealt.set(dim, (dealt.get(dim) || 0) + 1)
    return hit || null
  }

  /**
   * 给某个动作发一个机位 —— **第二层发牌**, 队列按动作各持一条。
   * 池子是该动作在源库里真实存在的机位数(285 个动作 5 个, 「M字开腿」4 个),
   * 所以不会产出源库没有的配对。批内动作不重复时这一层用不上轮转;
   * 批 > 286 条、同一动作第二次被抽到时, 才会换下一个机位。
   */
  const viewQueues = new Map()
  function takeView(item) {
    const list = Array.isArray(item.views) && item.views.length ? item.views : null
    if (!list) return null
    const key = item.en
    let q = viewQueues.get(key)
    if (!q || !q.order.length) {
      const round = (q?.round || 0) + 1
      q = { order: shuffle(list, rngOf(`view::${key}`, round)), round }
      viewQueues.set(key, q)
    }
    const zh = q.order.shift()
    return { zh, en: bank().views?.[zh] || zh }
  }

  return {
    active,
    /**
     * @param {number} idx 这次导出的行号 —— 只用来派生 rng, 不决定"抽第几张"
     * @param {string} lang 拼句语言: 'en'(默认) | 'zh'(每条语料自带的手工译文)
     * @returns {{text: string, parts: Array<{dim, zh, en, level?, view?}>}}
     */
    pick(idx = 0, lang = 'en') {
      const parts = []
      for (const dim of active) {
        const it = takeOne(dim, idx)
        if (!it) continue
        const part = { dim, zh: it.zh, en: it.en, level: it.level || 'sfw' }
        if (dim === 'pose' && poseView) {
          const vw = takeView(it)
          if (vw) part.view = vw
        }
        parts.push(part)
      }
      const zh = lang === 'zh'
      // 拼成一句话: 英文 "she is <动作>, seen from above, wearing <穿搭>, her hair is <发型>";
      // 中文 "S形站姿・胯部侧顶，俯视视角，她穿着…，她的头发是…" —— 各维度模板自己带
      // 主语/动词, 用逗号连起来就是通顺的自然语言段
      const text = parts.map((p) => {
        const meta = DIM_META[p.dim]
        if (zh) {
          const base = meta.tplZh(p.zh)
          return p.view ? `${base}，${p.view.zh}视角` : base
        }
        const base = meta.tpl(p.en)
        return p.view ? `${base}, seen ${p.view.en}` : base
      }).join(zh ? '，' : ', ')
      return { text, parts }
    },
    stats() {
      const out = {}
      for (const dim of active) {
        const q = queues.get(dim)
        const row = { pool: q?.pool || poolOf(dim, maxLevel, banned, bannedIds).length, dealt: dealt.get(dim) || 0 }
        // pose 的真实可发组合数 = 每个动作各带几个机位, 给回执/界面做说明
        if (dim === 'pose' && poseView) {
          row.combos = poolOf('pose', maxLevel, banned, bannedIds)
            .reduce((n, it) => n + Math.max(1, (it.views || []).length), 0)
        }
        out[dim] = row
      }
      return out
    },
  }
}

/**
 * nl 词索引(2026-11-10 第二版): 自然语言句子 → **tag 形态**片段索引。
 * --------------------------------------------------------------
 * 第一版是整句匹配(meta_nl, 光箱单开一个「自然语言」块显示中文) —— 用户反馈:
 * 句子既然能认出来, 就该直接在 tag 胶囊上给中文、归进 动作/服装/发型 分类,
 * 单开一个块是多余的。所以这版改成按**逗号片段**建索引:
 *
 *   键 = 片段的 tag 写法(小写 + 空格→下划线, 与 promptToTags 同一归一 ——
 *        导出的自然语言段被 promptToTags 重 parse 后就是这些键)
 *   值 = { dim, zh }   dim: pose|costume|hair|view
 *
 * en/zh 两种拼装产物都收(中文导出的图同样认得出)。机位跟着 pose 走,
 * 单独收 "seen_from_above" / "俯视视角" 这类片段。
 * 消费方: tagcats.classify(归类) + tags:cats 出口(分类映射) + translate.js(中文)。
 */
let _tagIndex = null
function normTagKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '_').replace(/^_+|_+$/g, '')
}
export function nlTagIndex() {
  if (_tagIndex) return _tagIndex
  const idx = new Map()
  /** 同一片段在多条语料里出现: dim 取首胜; zh 空值可被后来的具体值补上
   *  (先撞上"段数对不齐"的条目会写空, 后面遇到能对齐的条目就有资格补) */
  const put = (frag, dim, zh) => {
    const k = normTagKey(frag)
    if (!k) return
    const cur = idx.get(k)
    if (!cur) { idx.set(k, { dim, zh: zh || '' }); return }
    if (!cur.zh && zh) cur.zh = zh
  }
  /** 按「・」拆中文片段 —— **括号内的「・」不算分隔符**:
   *  "收腰感短发（长发尾・空气刘海）" 是一段括注, 不是两段。
   *  中文语料的分隔符只有「・」(实测 1451/1590 条), 从不用逗号/顿号 ——
   *  这正是 v1 按「，」拆拆不出段、把整句糊给每个片段的根因。 */
  const splitZh = (s) => {
    const out = []
    let buf = ''
    let depth = 0
    for (const ch of String(s || '')) {
      if (ch === '（' || ch === '(') depth++
      else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1)
      if (ch === '・' && depth === 0) { out.push(buf); buf = ''; continue }
      buf += ch
    }
    out.push(buf)
    return out.map((x) => x.trim()).filter(Boolean)
  }
  const b = bank()
  // 机位先落索引 —— 语义最明确, 别被后面语料里同名的中文片段抢位
  // (实测: 某些 pose 的中文片段正好是"俯视视角", 会把机位顶成 dim=pose)
  // en 走 "seen <en>", zh 走 "<zh>视角"(与 pick() 的拼法一致)
  for (const [zh, en] of Object.entries(b.views || {})) {
    put(`seen ${en}`, 'view', `${zh}视角`)
    put(`${zh}视角`, 'view', `${zh}视角`)
  }
  /** 收集全部条目(中英片段各自拆好), 分两遍落索引 —— 顺序很重要:
   *  先让"能逐段对齐"的条目占位(精度最高), 再给剩下的补注脚,
   *  这样 a_headband 只要在任何一条对齐语料里出现过, 拿到的就是"发箍",
   *  不会被某条对不齐的穿搭整句顶掉。 */
  const rows = []
  for (const dim of NL_DIMS) {
    const meta = DIM_META[dim]
    for (const it of b[dim]) {
      // 英文: 拼装后按逗号拆片段(与 promptToTags 的拆法一致) ——
      // "she is wearing X, Y, Z" 拆成 4 段, 每段都是一个独立 tag
      const enFrags = String(meta.tpl(it.en) || '').split(',').map((s) => s.trim()).filter(Boolean)
      const zhFrags = splitZh(meta.tplZh(it.zh))
      if (enFrags.length) rows.push({ dim, enFrags, zhFrags })
    }
  }
  // 第一遍: 段数一致 = 唯一可靠的对应关系, 逐段对齐(占语料 86%)
  for (const r of rows) {
    if (r.enFrags.length !== r.zhFrags.length) continue
    for (let i = 0; i < r.enFrags.length; i++) {
      put(r.enFrags[i], r.dim, r.zhFrags[i])
      // 中文片段也入索引(中文导出产物同样认得出); 值是**片段自己** ——
      // v1 这里塞整句, 于是 map 里出现"侧卧・强调腰线・单腿弯曲"→同一整句的自映射
      put(r.zhFrags[i], r.dim, r.zhFrags[i])
    }
  }
  // 第二遍: 段数对不上的(中文意译合并/拆分/语序重排), 只给"还没有中文"的片段
  // 补整句注脚 —— 是**这一条**的语义, 不会串到别人家(put 里 !cur.zh 才写)
  for (const r of rows) {
    if (r.enFrags.length === r.zhFrags.length) continue
    const note = r.zhFrags.join('・')
    if (!note) continue
    for (const f of r.enFrags) put(f, r.dim, note)
  }
  // 机位: en 走 "seen <en>", zh 走 "<zh>视角"(与 pick() 的拼法一致)
  // —— 已在函数开头先落, 这里不再重复
  _tagIndex = idx
  return idx
}

/**
 * 批内雷同体检 —— 导出完回执里报"这批到底有多像"。
 * 签名口径 = 各维度抽到的中文名(能反映语义), 没有自然语言段时退化成 tag 签名。
 * @param {Array<{nlParts?: Array<{dim,zh}>, tags?: string[]}>} rows
 * @returns {{n: number, dup: number, rate: number, worst: Array<{sig: string, cnt: number}>}}
 */
export function nlDupReport(rows) {
  const cnt = new Map()
  for (const r of rows) {
    const sig = (r.nlParts || []).map((p) => `${p.dim}:${p.zh}`).join('|') || (r.tags || []).slice(0, 8).join(',')
    if (!sig) continue
    cnt.set(sig, (cnt.get(sig) || 0) + 1)
  }
  const n = [...cnt.values()].reduce((a, b) => a + b, 0)
  const dup = [...cnt.values()].reduce((a, b) => a + Math.max(0, b - 1), 0)
  const worst = [...cnt.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sig, c]) => ({ sig, cnt: c }))
  return { n, dup, rate: n ? dup / n : 0, worst }
}
