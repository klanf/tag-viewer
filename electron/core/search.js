/**
 * 搜索 / 筛选 / 排序
 * ==================
 * 完全对齐原 Python 版 search_records 的语义:
 *   * match='contains' 时用「子串包含」, match 为其他值时用「完全相等」
 *   * mode='all' 要求所有搜索词都命中, 否则任一命中即可
 *   * exclude_char(默认开) 会把带括号的标签(xxx_(系列))整体剔除
 *   * 排除词按 exclude_match 决定「完全相等」还是「包含」
 *
 * 性能: 原版是纯 Python 循环扫 7 万条(实测 0.6~0.9s, 且持有 GIL 拖住并发的缩略图请求);
 * Node 里同样的循环是毫秒级, 但结果缓存还是保留 —— 翻页/换排序时能省掉重复扫描,
 * 也让「随机排序」的种子语义能稳定复现。
 */
import fs from 'node:fs'
import { recordsFor, frozenKey, recordByPath } from './dataset.js'

const CACHE_MAX = 8           // 缓存条目数(不是原版的 2 —— Node 里每份结果才几十 MB 引用)
const cache = new Map()
const stats = { hit: 0, miss: 0, searchMs: [] }

/** 与 Python 版 _norm 一致 */
function norm(term) {
  return String(term).toLowerCase()
    .replace(/\u2011/g, '-')
    .replace(/\\/g, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/ /g, '_')
}

/**
 * 核心筛选
 * @param {Array} records
 * @param {string[]} searchTags 已小写
 * @param {'any'|'all'} mode
 * @param {'contains'|string} match
 * @param {string[]} excludeTags
 * @param {'contains'|'exact'} excludeMatch
 * @param {boolean} excludeChar
 * @returns {{path:string,tags:string[]}[]}
 */
export function searchRecords(records, searchTags, mode, match,
  excludeTags = [], excludeMatch = 'contains', excludeChar = true) {
  const terms = excludeTags.filter((t) => String(t).trim()).map(norm)
  const wantAll = mode === 'all'
  const contains = match === 'contains'
  const exExact = excludeMatch === 'exact'
  const hasSearch = searchTags.length > 0
  const hasExclude = terms.length > 0
  const n = records.length
  const out = new Array(n)
  let w = 0

  for (let i = 0; i < n; i++) {
    const r = records[i]
    const tags = r.tags
    const ltags = r.ltags || tags

    if (hasSearch) {
      let hits = 0
      if (contains) {
        for (let s = 0; s < searchTags.length; s++) {
          const needle = searchTags[s]
          for (let t = 0; t < ltags.length; t++) {
            if (ltags[t].indexOf(needle) >= 0) { hits++; break }
          }
        }
      } else {
        for (let s = 0; s < searchTags.length; s++) {
          if (ltags.indexOf(searchTags[s]) >= 0) hits++
        }
      }
      if (wantAll ? hits !== searchTags.length : hits === 0) continue
    }

    // 结果里保留的标签(exclude_char + 排除词过滤后)
    let kept
    if (!excludeChar && !hasExclude) {
      kept = tags
    } else {
      kept = []
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]
        if (excludeChar && tag.indexOf('(') >= 0) continue
        if (hasExclude) {
          const tl = ltags[t] || tag.toLowerCase()
          let excluded = false
          for (let e = 0; e < terms.length; e++) {
            const term = terms[e]
            if (exExact ? tl === term : tl.indexOf(term) >= 0) { excluded = true; break }
          }
          if (excluded) continue
        }
        kept.push(tag)
      }
    }
    /* 结果必须带上**卡片渲染真正要用的字段**, 不能只挑 path/tags。
     * 2026-09-23 踩过一次: 卡片改成按 px_w/px_h 渲染真实比例后, 这里漏了尺寸字段,
     * 于是所有卡片**静默**回落到 9/16(横图又被裁成竖条), 一个错都不报 ——
     * 只有 e2e 那条"卡片比例不再是清一色 9/16"的断言抓到了。同理漏 `unsafe`
     * 会让安全模式永远筛不掉任何东西, 漏 `source` 会让卡片上的来源角标消失。
     * 所以这里改成 spread: **以后给记录加字段会自动带出来**, 不要再手写字段列表。 */
    out[w++] = { ...r, tags: kept }
  }
  out.length = w
  return out
}

function sig(srcKey, favKey, searchTags, mode, match, excludeTags, excludeMatch, excludeChar) {
  return [srcKey, favKey, searchTags.join('\u0001'), mode, match,
    excludeTags.join('\u0001'), excludeMatch, excludeChar ? 1 : 0].join('\u0002')
}

/** 带缓存版; 命中与否都返回**副本**, 因为调用方会就地排序/洗牌 */
export function searchCached(records, searchTags, mode, match,
  excludeTags = [], excludeMatch = 'contains', excludeChar = true,
  srcKey = '', favKey = '') {
  const key = sig(srcKey, favKey, searchTags, mode, match, excludeTags, excludeMatch, excludeChar)
  const hit = cache.get(key)
  if (hit) {
    stats.hit++
    cache.delete(key)
    cache.set(key, hit)          // LRU: 重新插到队尾
    return hit.slice()
  }
  stats.miss++
  const t0 = Date.now()
  const out = searchRecords(records, searchTags, mode, match, excludeTags, excludeMatch, excludeChar)
  const ms = Date.now() - t0
  stats.searchMs.push(ms)
  if (stats.searchMs.length > 40) stats.searchMs.shift()
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, out)
  return out.slice()
}

export function clearSearchCache() {
  cache.clear()
  stats.hit = 0
  stats.miss = 0
  stats.searchMs = []
}

export function searchStats() {
  const arr = stats.searchMs
  const sorted = [...arr].sort((a, b) => a - b)
  return {
    hit: stats.hit,
    miss: stats.miss,
    entries: cache.size,
    lastMs: arr.length ? arr[arr.length - 1] : 0,
    medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    samples: arr.length,
  }
}

// ------------------------------------------------------------------ 排序

/** 32 位整数种子 -> 可复现的伪随机(mulberry32), 等价于 Python 的 random.Random(seed) */
export function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

/**
 * 就地排序: path=文件顺序(不动) / time=修改时间新→旧 / time_asc=旧→新 /
 * random=固定种子洗牌 / name=文件名 A-Z / size=体积大→小 / dims=分辨率大→小。
 * time/time_asc/size 需要给每张图 stat 一次, 7 万次同步 stat 是这里唯一的开销点,
 * 所以只在真的选了这几档时才做; dims 直接用记录里的 px_w/px_h(扫描/入库时已带), 零 IO。
 */
export function applySort(results, sort, seedKey, seed) {
  if (sort === 'time' || sort === 'time_asc') {
    const mt = new Map()
    for (const r of results) {
      try { mt.set(r.path, fs.statSync(r.path).mtimeMs) } catch { mt.set(r.path, 0) }
    }
    if (sort === 'time') {
      results.sort((a, b) => (mt.get(b.path) || 0) - (mt.get(a.path) || 0))
    } else {
      results.sort((a, b) => (mt.get(a.path) || 0) - (mt.get(b.path) || 0))
    }
  } else if (sort === 'name') {
    // 文件名排序(不含目录段, 同名不同夹的挨在一起): localeCompare 走系统区域, 中文文件名也能排个大概
    const nm = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase()
    results.sort((a, b) => nm(a.path).localeCompare(nm(b.path), 'zh-Hans-CN', { numeric: true }))
  } else if (sort === 'size') {
    const sz = new Map()
    for (const r of results) {
      try { sz.set(r.path, fs.statSync(r.path).size) } catch { sz.set(r.path, 0) }
    }
    results.sort((a, b) => (sz.get(b.path) || 0) - (sz.get(a.path) || 0))
  } else if (sort === 'dims') {
    const px = (r) => (Number(r.px_w) || 0) * (Number(r.px_h) || 0)
    results.sort((a, b) => px(b) - px(a))
  } else if (sort === 'random') {
    const s = seed !== undefined && seed !== null && seed !== ''
      ? Number(seed)
      : hashString(seedKey)
    shuffle(results, seededRandom(s))
  }
  return results
}

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ------------------------------------------------------------------ 解析查询参数

/**
 * 把前端传来的原始查询对象规整成内部结构。
 * 支持 source / q / mode / match / exclude / exclude_match / exclude_char / sort / fav / seed
 */
export function parseQuery(raw = {}) {
  const q = (s) => (typeof s === 'string' ? s.trim() : '')
  // 中英文逗号都算分隔符: 历史里/手工输入可能留有全角逗号, 只按 ',' 切会把
  // 「a，b」当成一个整体标签 → contains 永远命不中, 表现成"搜不出来"
  const searchTags = q(raw.q)
    ? q(raw.q).split(/[,，]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    : []
  const excludeTags = q(raw.exclude)
    ? q(raw.exclude).split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    : []
  return {
    searchTags,
    mode: raw.mode === 'all' ? 'all' : 'any',
    match: raw.match === 'exact' ? 'exact' : 'contains',
    excludeTags,
    excludeMatch: raw.exclude_match === 'exact' ? 'exact' : 'contains',
    excludeChar: raw.exclude_char !== '0' && raw.exclude_char !== false,
    sort: ['time', 'time_asc', 'random', 'path', 'name', 'size', 'dims'].includes(raw.sort) ? raw.sort : 'path',
    seed: raw.seed,
    srcSet: parseSources(raw.source),
    favs: parseFavs(raw.fav),
  }
}

function toArray(v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** source 可以是数组, 也可以是逗号分隔的字符串 */
export function parseSources(raw) {
  const out = new Set()
  for (const v of toArray(raw)) {
    for (const s of String(v).split(',')) {
      const t = s.trim()
      if (t) out.add(t)
    }
  }
  return out.size ? out : null
}

export function parseFavs(raw) {
  const out = []
  for (const v of toArray(raw)) {
    const s = String(v).trim()
    if (s) out.push(s)
  }
  return out
}

/** 应用 source 过滤 + 收藏过滤, 返回记录表 */
export function scopeRecords(srcSet, favs) {
  let recs = recordsFor(srcSet)
  if (favs && favs.length) {
    const set = new Set(favs)
    recs = recs.filter((r) => set.has(r.path))
  }
  return recs
}

export { frozenKey, recordByPath }
