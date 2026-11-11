/**
 * char-db 组合池（2026-11-11）—— 「动作 / 穿搭」的**第三套**来源
 * ==========================================================
 * 三套并列，同一维度内互斥（UI 上点一个会自动关掉另外两套）：
 *   1. tag 槽位池   slot-pools.json   单词 + 词频加权掷骰   粗粒度兜底
 *   2. 自然语言句   nl-bank.json      整句、发牌           Anima 吃自然语言
 *   3. 本池         cd-pools.json     **tag 组合串**、发牌   一条 = 一套完整写法
 *
 * 为什么整串、不拆单词（拆了会撞的三堵墙）：
 *   - `withWeight()` 是整词套壳，多 tag 词会拼成 `(a, b:1.2)`，语法非法
 *   - `pickFor()` 的去重拿整串 key 比对本行已有 tag，串里的单词重了认不出
 *   - `tag_slots.json` 只覆盖 3754 个词，动作 253/367、穿搭 416/546 分不进槽
 * 所以这条路线**不进随机引擎**（不参与掷骰/权重/批内压重），抽出来直接**并进
 * tag 段** —— tag 串本来就是逗号分隔，并进去即合法，权重/去重/排序全都不用管。
 * （2026-11-11 用户定：不再另成"末尾追加一段"，它在产物里和槽位词没区别。）
 *
 * 抽法同样是**发牌**（和 nl-bank 一致）：洗牌队列抽一张出一张，抽完重洗。
 * 因此同一批导出里前 N 条动作两两不同，而不是"随机 N 次里撞几次"。
 *
 * 数据来源：本地「1027 张二次元换装图库」data/items.js（只取文字元数据），
 * 由 tools/build-cd-pools.py 生成 knowledge/cd-pools.json。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BUNDLED_KNOWLEDGE_DIR } from './paths.js'

export const CD_DIMS = ['pose', 'outfit']
const DIM_ZH = { pose: '图库动作', outfit: '图库穿搭' }

/** 一条串里的 tag 归一（小写 + 空格→下划线），用于跟本行已有 tag 比对 */
const keyOf = (t) => String(t || '').trim().toLowerCase().replace(/[\s_]+/g, '_')

let _bank = null
/** 缺知识包时不能抛（v2.4.0 的教训）—— 降级成空池 */
function bank() {
  if (_bank) return _bank
  try {
    _bank = JSON.parse(readFileSync(path.join(BUNDLED_KNOWLEDGE_DIR, 'cd-pools.json'), 'utf8'))
  } catch {
    _bank = { _meta: { counts: { pose: 0, outfit: 0 } }, pose: [], outfit: [] }
  }
  for (const d of CD_DIMS) if (!Array.isArray(_bank[d])) _bank[d] = []
  return _bank
}

/** 知识包更新后重读 */
export function reloadCdPools() { _bank = null }

/** 界面用：每个维度多少条、其中多少条是双人（默认不抽） */
export function cdPoolsStats() {
  const b = bank()
  const dims = CD_DIMS.map((id) => {
    const all = b[id]
    const dual = all.filter((it) => it.dual).length
    return { id, zh: DIM_ZH[id], total: all.length, dual, available: all.length - dual }
  })
  return {
    version: b._meta?.schema || '',
    generatedAt: b._meta?.generatedAt || '',
    dims,
    empty: dims.every((d) => d.total === 0),
  }
}

/** 候选池：默认剔掉 dual（含 2girls 等人数 tag，会和原图的 1girl 打架） */
function poolOf(dim, allowDual) {
  return (bank()[dim] || []).filter((it) => allowDual || !it.dual)
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

function shuffle(arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

/**
 * 造一个批次抽串器。
 * @param {{dims?: string[], seed?: string|number|null, allowDual?: boolean}} opts
 *   dims      要抽的维度（缺省 ['pose']）
 *   seed      固定则整批可复现
 *   allowDual 是否抽含人数 tag 的条目（缺省 false）
 * @returns {{
 *   active: string[],
 *   pick: (idx: number, rowKeys?: Set<string>|string[]) => {tags: string, parts: Array<{dim, zh, cat, id}>},
 *   stats: () => Object<string, {pool: number, dealt: number}>,
 * }}
 */
export function makeCdPicker(opts = {}) {
  const dims = (Array.isArray(opts.dims) ? opts.dims : []).filter((d) => CD_DIMS.includes(d))
  const active = (dims.length ? dims : ['pose'])
    .slice()
    .sort((a, b) => CD_DIMS.indexOf(a) - CD_DIMS.indexOf(b))
  const allowDual = opts.allowDual === true
  const seedBase = opts.seed != null && String(opts.seed).length
    ? String(opts.seed)
    : `${Date.now()}::${Math.floor(Math.random() * 2 ** 31)}`

  const queues = new Map()
  const dealt = new Map()
  const rngOf = (dim, round) => mulberry32(`${seedBase}::cd::${dim}::${round}`)

  /** 抽一条；跟本行 tag 有重叠就换下一条（整串保留，不删片段 —— 删了穿搭就散架） */
  const RETRY = 5
  function takeOne(dim, rowKeys) {
    for (let i = 0; i <= RETRY; i++) {
      let q = queues.get(dim)
      if (!q || !q.order.length) {
        const pool = poolOf(dim, allowDual)
        if (!pool.length) return null
        const round = (q?.round || 0) + 1
        q = { order: shuffle(pool, rngOf(dim, round)), round, pool: pool.length }
        queues.set(dim, q)
      }
      const hit = q.order.shift()
      if (!hit) return null
      const keys = String(hit.tags || '').split(',').map(keyOf).filter(Boolean)
      if (!keys.length) continue
      if (rowKeys && rowKeys.size && keys.some((k) => rowKeys.has(k))) continue
      dealt.set(dim, (dealt.get(dim) || 0) + 1)
      return hit
    }
    return null
  }

  return {
    active,
    /**
     * 只抽**一个维度** —— 混合模式下每个维度各自决定来源, 谁被图库池选中就只找它要一条。
     * @param {number} idx 行号(派生 rng 用)
     * @param {string} dim pose | outfit (调用方负责把语义面的 costume 翻成 outfit)
     * @param {Set<string>|string[]} [rowKeys] 本行已有 tag 归一键(查重用)
     * @returns {{tags: string, part: {dim, zh, cat, id, tags}}|null}
     */
    pickDim(idx = 0, dim = 'pose', rowKeys) {
      if (!CD_DIMS.includes(dim)) return null
      const keys = rowKeys instanceof Set ? rowKeys
        : new Set((rowKeys || []).map(keyOf).filter(Boolean))
      const it = takeOne(dim, keys)
      if (!it) return null
      return {
        tags: it.tags,
        part: { dim, zh: it.zh || '', cat: it.cat || '', id: it.id || '', tags: it.tags },
      }
    },
    /** 该维度有没有可抽的条目(混合模式先问一句, 免得"剔了槽却抽不出串") */
    avail(dim) {
      return CD_DIMS.includes(dim) && poolOf(dim, allowDual).length > 0
    },
    /**
     * @param {number} idx 行号，只用来派生 rng
     * @param {Set<string>|string[]} [rowKeys] 本行已有的 tag 归一键（查重用）
     * @returns {{tags: string, parts: Array<{dim, zh, cat, id}>}}
     */
    pick(idx = 0, rowKeys) {
      const keys = rowKeys instanceof Set ? rowKeys
        : new Set((rowKeys || []).map(keyOf).filter(Boolean))
      const parts = []
      for (const dim of active) {
        const it = takeOne(dim, keys)
        if (!it) continue
        parts.push({ dim, zh: it.zh || '', cat: it.cat || '', id: it.id || '', tags: it.tags })
        for (const k of String(it.tags).split(',')) keys.add(keyOf(k))
      }
      return { tags: parts.map((p) => p.tags).join(', '), parts }
    },
    stats() {
      const out = {}
      // 混合模式下维度是 pickDim 逐个取的, 抽过的维度也要报(否则回执缺池子大小)
      const dims = [...new Set([...active, ...dealt.keys()])]
        .sort((a, b) => CD_DIMS.indexOf(a) - CD_DIMS.indexOf(b))
      for (const dim of dims) {
        const q = queues.get(dim)
        out[dim] = {
          pool: q?.pool || poolOf(dim, allowDual).length,
          dealt: dealt.get(dim) || 0,
        }
      }
      return out
    },
  }
}
