/**
 * 查询 API —— 对应原 Python 版的一整套 _api_* 处理函数
 * ==================================================
 * 每个函数都是纯数据进 / 纯数据出, 不认识 HTTP 也不认识 IPC,
 * 这样主进程的 ipc 路由和将来可能的 CLI 都能直接复用。
 */
import fs from 'node:fs'
import {
  ds, statsFor, recordsFor, firstPathMap, recordByPath, minIdx,
  seriesName, isCharacterTag, isCopyrightTag, charShortName, CATEGORY_LABELS, guessCategory,
} from './dataset.js'
import { loadUserMeta, patchUserMeta } from './meta.js'
import { blacklistMatcher, isBlocked, isBlockedFast, buildBanMap, loadBgConfig, hasBgTagFast } from './rules.js'
import { translateMap, translateMany, zhIndex } from './translate.js'
import { parseQuery, scopeRecords, searchCached, applySort, frozenKey } from './search.js'
import { extractImagePrompt } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'

// ---------------------------------------------------------------- 统计

let srcCountCache = null
function sourceCounts() {
  if (srcCountCache) return srcCountCache
  const m = new Map()
  for (const r of ds.records) m.set(r.source, (m.get(r.source) || 0) + 1)
  srcCountCache = m
  return m
}
export function invalidateSourceCounts() { srcCountCache = null }

export function getStats(raw = {}) {
  const srcSet = parseQuery(raw).srcSet
  const [tagCounter, seriesCounter, records] = statsFor(srcSet)

  const topTags = topN(tagCounter, 60).map(([tag, count]) => ({ tag, count }))
  const topSeries = topN(seriesCounter, 40).map(([tag, count]) => ({ tag, count }))

  const counts = sourceCounts()
  const sources = ds.sourceNames.map((name) => ({ name, images: counts.get(name) || 0 }))

  return {
    total_images: records.length,
    total_tags: tagCounter.size,
    total_series: seriesCounter.size,
    top_tags: topTags,
    top_series: topSeries,
    sources,
  }
}

function topN(map, n) {
  const arr = [...map.entries()]
  arr.sort((a, b) => b[1] - a[1])
  return arr.slice(0, n)
}

// ---------------------------------------------------------------- 搜索

export function doSearch(raw = {}) {
  const p = parseQuery(raw)
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 60, 1, 2000)
  // 文件名子串过滤(大小写不敏感) —— 如 "Anima-" 找 ComfyUI 生成的图
  const nameQ = String(raw.name || '').trim().toLowerCase()
  const records = scopeRecords(p.srcSet, p.favs)

  let results = searchCached(
    records, p.searchTags, p.mode, p.match,
    p.excludeTags, p.excludeMatch, p.excludeChar,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join('|') : '',
  )
  if (nameQ) results = results.filter((r) => r.path.toLowerCase().indexOf(nameQ) >= 0)
  const seedKey = [p.searchTags.join(','), p.mode, p.match, p.sort, nameQ].join('|')
  applySort(results, p.sort, seedKey, p.seed)

  const page = results.slice(offset, offset + limit)
  return {
    total: results.length,
    offset,
    returned: page.length,
    results: page,
    sort: p.sort,
  }
}

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

// ---------------------------------------------------------------- 系列 / 角色

export function getSeries(raw = {}) {
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const meta = loadUserMeta()
  const cats = meta.categories
  const [tagCounter, , filtered] = statsFor(srcSet)

  const items = []
  const seen = new Set()
  const okCache = new Map()
  const srcOk = (idx) => {
    if (!srcSet) return true
    let v = okCache.get(idx)
    if (v === undefined) {
      v = srcSet.has(ds.records[idx].source)
      okCache.set(idx, v)
    }
    return v
  }

  for (const [name, idSet] of ds.seriesImgs) {
    let ids = idSet
    if (srcSet) {
      ids = new Set()
      for (const i of idSet) if (srcOk(i)) ids.add(i)
      if (!ids.size) continue
    }
    let chars = ds.seriesChars.get(name) || new Map()
    if (srcSet) {
      const m = new Map()
      for (const [t, cids] of chars) {
        const kept = new Set()
        for (const i of cids) if (srcOk(i)) kept.add(i)
        if (kept.size) m.set(t, kept)
      }
      chars = m
    }
    // 合并 custom_chars 里该系列下的补充角色 —— 不算上的话, 列表页的角色数/图片数
    // 会和该系列详情页对不上
    const extra = (meta.custom_chars[name] || []).filter((t) => !chars.has(t))
    let extraImgs = 0
    for (const t of extra) extraImgs += tagCounter.get(t) || 0

    items.push({
      name,
      images: ids.size + extraImgs,
      characters: chars.size + extra.length,
      thumb: ds.records[ids.size ? minIdx(ids) : 0].path,
      category: cats[name] || guessCategory(name),
    })
    seen.add(name)
  }

  // 自定义系列(不在系列索引里, 但用户在元数据里手动加过角色的)
  const extraNames = Object.keys(meta.custom_chars).filter((n) => !seen.has(n))
  const fpm = extraNames.length ? firstPathMap(srcSet) : null
  for (const name of extraNames) {
    const tags = meta.custom_chars[name]
    let real = 0
    let thumb = ''
    for (const t of tags) {
      real += tagCounter.get(t) || 0
      if (!thumb) thumb = fpm.get(t) || ''
    }
    items.push({
      name, images: real, characters: tags.length,
      thumb, category: cats[name] || guessCategory(name), custom: true,
    })
  }

  items.sort((a, b) => b.images - a.images)

  const catCounts = {}
  for (const it of items) catCounts[it.category] = (catCounts[it.category] || 0) + 1

  return {
    total: items.length,
    series: items,
    categories: catCounts,
    category_labels: CATEGORY_LABELS,
    custom_categories: meta.custom_categories,
    hidden_categories: meta.hidden_categories,
    _debug: { filtered: filtered.length },
  }
}

export function getCharacters(raw = {}) {
  const series = typeof raw.series === 'string' ? raw.series : ''
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const chars = ds.seriesChars.get(series) || new Map()
  const items = []
  const okCache = new Map()
  const srcOk = (idx) => {
    if (!srcSet) return true
    let v = okCache.get(idx)
    if (v === undefined) { v = srcSet.has(ds.records[idx].source); okCache.set(idx, v) }
    return v
  }

  for (const [tag, idSet] of chars) {
    let ids = idSet
    if (srcSet) {
      ids = new Set()
      for (const i of idSet) if (srcOk(i)) ids.add(i)
      if (!ids.size) continue
    }
    items.push({
      tag,
      name: charShortName(tag),
      images: ids.size,
      thumb: ds.records[minIdx(ids)].path,
    })
  }

  // 用户手动补的角色(库里可能没有这个标签 -> 0 张图)
  const meta = loadUserMeta()
  const [tagCounter, , ] = statsFor(srcSet)
  const recs = recordsFor(srcSet)
  for (const tag of meta.custom_chars[series] || []) {
    if (chars.has(tag)) continue
    const c = tagCounter.get(tag) || 0
    let thumb = ''
    if (c > 0) {
      for (const rec of recs) {
        if (rec.tags.includes(tag)) { thumb = rec.path; break }
      }
    }
    items.push({ tag, name: charShortName(tag), images: c, thumb })
  }

  items.sort((a, b) => b.images - a.images)
  return { series, total: items.length, characters: items }
}

export function getSeriesMeta() { return loadUserMeta() }

export function postSeriesMeta(body) {
  const r = patchUserMeta(body)
  if (r.ok === false) return { error: '保存失败' }
  return r.meta
}

// ---------------------------------------------------------------- 自动补全

export function getSuggest(raw = {}) {
  const kw = String(raw.q || '').trim().toLowerCase()
  const limit = Math.min(clampInt(raw.limit, 12, 1, 50), 50)
  if (!kw) return { suggestions: [] }

  const p = parseQuery(raw)
  const [statsMap] = statsFor(p.srcSet)
  const tr = translateMap()
  const idx = zhIndex()

  const hits = []
  for (const [t, c] of statsMap) {
    const tl = t.toLowerCase()
    if (tl.startsWith(kw) || tl.includes(kw)) {
      hits.push([t, c, tr.get(tl) || '', tl.startsWith(kw) ? 1 : 0])
    }
  }
  for (const [zh, tags] of idx) {
    if (!zh.includes(kw)) continue
    for (const t of tags.slice(0, 2)) {       // 一个中文词最多带 2 个标签, 免得刷屏
      const c = statsMap.get(t)
      if (c === undefined) continue
      hits.push([t, c, zh, 0])
    }
  }
  // 前缀命中优先, 其次按图片数
  hits.sort((a, b) => (b[3] - a[3]) || (b[1] - a[1]))

  const seen = new Set()
  const out = []
  for (const [t, c, zh] of hits) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push({ tag: t, zh, count: c })
    if (out.length >= limit) break
  }
  return { suggestions: out }
}

// ---------------------------------------------------------------- 标签浏览

export function getAllTags(raw = {}) {
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 120, 0, 1_000_000)
  const kw = String(raw.q || '').trim().toLowerCase()

  const p = parseQuery(raw)
  const [statsMap] = statsFor(p.srcSet)
  const tr = translateMap()
  const bl = blacklistMatcher()

  const items = []
  for (const [t, c] of statsMap) {
    if (kw && !t.toLowerCase().includes(kw)) continue
    items.push({ tag: t, count: c })
  }
  items.sort((a, b) => b.count - a.count)
  const total = items.length
  const page = limit > 0 ? items.slice(offset, offset + limit) : items

  for (const it of page) {
    const tl = it.tag.toLowerCase()
    if (bl.exact.has(tl)) {
      it.banned = true
      it.ban_rule = tl
    } else if (bl.regex && bl.regex.test(tl)) {
      it.banned = true
      it.ban_rule = bl.rules.find((r) => isBlocked(it.tag, [r])) || ''
    }
    const zh = tr.get(tl)
    if (zh) it.zh = zh
  }

  return { total, offset, returned: page.length, tags: page }
}

// ---------------------------------------------------------------- 单图标签

function bgInfoFor(tags, hasTags) {
  const bg = loadBgConfig()
  return {
    needs_bg: (hasTags === false ? false : true) && !!bg.append.length && !hasBgTagFast(tags, bg),
    bg_append: bg.append,
  }
}

export function getTagsForPath(raw = {}) {
  const p = typeof raw.path === 'string' ? raw.path : ''
  const rec = p ? recordByPath(p) : null
  if (!rec) return { error: 'not found' }
  return {
    path: rec.path,
    tags: rec.tags,
    ban_map: buildBanMap(rec.tags),
    source: rec.source,
    ...bgInfoFor(rec.tags),
  }
}

/** lightbox 用的结构化数据: 角色 / 系列 / 全部标签(已滤掉 Danbooru 分类噪声) */
export function getLightboxData(raw = {}) {
  const p = typeof raw.path === 'string' ? raw.path : ''
  if (!p) return { error: 'not found' }

  const rec = recordByPath(p)
  if (rec) {
    return packLightbox(p, rec.tags)
  }

  // 回退: 库外图片(「扫描文件夹」里的 AI 生成图) —— 直接读图片元数据。
  // 注意: 即使没有任何元数据也要回 200 语义, 否则前端拿不到结构, lightbox 直接空白。
  if (fs.existsSync(p)) {
    const { text, source } = extractImagePrompt(p)
    const tags = text ? promptToTags(text) : []
    return { ...packLightbox(p, tags), external: true, prompt_source: source }
  }
  return { error: 'not found' }
}

function packLightbox(p, tags) {
  const charTags = tags.filter(isCharacterTag)
  // 系列: 从全部标签里解析(角色的所属系列 + 裸系列标签), 不再只看带括号的角色
  const series = []
  const seen = new Set()
  for (const t of tags) {
    const s = seriesName(t)
    if (s && !seen.has(s)) { seen.add(s); series.push(s) }
  }
  // 普通标签 = 剔除角色 + 裸系列标签(渲染层「复制全部标签」直接用这份)
  const plainTags = tags.filter((t) => !isCharacterTag(t) && !isCopyrightTag(t))
  return {
    path: p,
    char_tags: charTags,
    series,
    all_tags: tags,
    plain_tags: plainTags,
    ban_map: buildBanMap(tags),
    ...bgInfoFor(tags, tags.length > 0),
  }
}

// ---------------------------------------------------------------- 翻译

export function getTranslations(raw = {}) {
  const q = String(raw.q || '')
  const tags = q.split(',').map((t) => t.trim()).filter(Boolean)
  return translateMany(tags)
}

// 导出: 见 exporter.js
export { isBlockedFast, dedupeTags, promptToTags }
