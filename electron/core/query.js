/**
 * 查询 API —— 对应原 Python 版的一整套 _api_* 处理函数
 * ==================================================
 * 每个函数都是纯数据进 / 纯数据出, 不认识 HTTP 也不认识 IPC,
 * 这样主进程的 ipc 路由和将来可能的 CLI 都能直接复用。
 */
import fs from 'node:fs'
import {
  ds, statsFor, recordsFor, firstPathMap, recordByPath,
  seriesName, isCharacterTag, isCopyrightTag, charShortName, CATEGORY_LABELS, guessCategory,
} from './dataset.js'
import { loadUserMeta, patchUserMeta } from './meta.js'
import { loadSafetyState, hiddenAt } from './safety.js'
import { blacklistMatcher, isBlocked, isBlockedFast, buildBanMap, loadBgConfig, hasBgTagFast } from './rules.js'
import { translateMap, translateMany, zhIndex } from './translate.js'
import { parseQuery, scopeRecords, searchCached, applySort, frozenKey } from './search.js'
import { extractImagePrompt } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'
import { openDb } from './store.js'

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

/**
 * 当前结果集里两档各会隐藏多少张 —— 给安全模式开关上那个数字用(2026-09-23)。
 *
 * 为什么非得在后端算: 看板 / 系列 / 标签图片三页走的是**分页**的 feed
 * (useImageFeed), 前端手里只有已加载的那几十张。拿它算出来的数字会随着往下滚
 * 不断变大, 看着像在跳。而这里 `results` 是**筛选 + 排序后的全量**, 一次遍历就准。
 *
 * 计数与 offset/limit 无关, 但每次翻页都会再调一次 doSearch —— 所以按"结果数组
 * 引用"用 WeakMap 记忆: `searchCached` 命中时返回的是同一个数组, 翻页就白捡;
 * `applySort` 是 in-place 的, 引用也不变。只有带文件名过滤时会 filter 出新数组
 * (少数路径), 那种情况多扫一遍也就是一次线性遍历。
 *
 * 口径与 ipc 的 `coreHit` / `edgeHit` 逐字一致(见 safety.js 的 hiddenAt):
 *   core = 只命中 core 段的条数; edge = edge 档会隐藏的总数(= core + 仅命中 edge 的)。
 */
const unsafeMemo = new WeakMap()
function unsafeCountOf(results) {
  let v = unsafeMemo.get(results)
  if (v) return v
  let core = 0
  let edge = 0
  for (const r of results) {
    const u = r.unsafe
    if (u === 1) core++
    else if (u === 2) edge++
  }
  v = { core, edge: core + edge }
  unsafeMemo.set(results, v)
  return v
}

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

  let page = results.slice(offset, offset + limit)
  // exists=1(2026-10-06): 只返回磁盘上还存在的图 —— 购物车挑封面/自愈换图用它,
  // 不然会挑到一条库里有记录但文件已被移走/删掉的图, 换上去就是一张 404。
  // 只过滤当前页(≤limit 条), statSync 开销有上界; total 口径不变(仍是库内命中数)。
  if (raw.exists === 1 || raw.exists === '1' || raw.exists === true) {
    page = page.filter((r) => { try { return fs.statSync(r.path).isFile() } catch { return false } })
  }
  return {
    total: results.length,
    offset,
    returned: page.length,
    results: page,
    sort: p.sort,
    /* 当前条件(来源 / 搜索 / 标签 / 文件名过滤)下两档各会隐藏多少张。
       注意它与 offset/limit **无关** —— 前端翻页时这个数不会变, 数字才不会跳。 */
    unsafe: unsafeCountOf(results),
  }
}

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

// ---------------------------------------------------------------- 系列 / 角色

/**
 * 从一组记录下标里挑**封面** —— 挑被裁得最少的那张。
 *
 * 旧行为是 `minIdx(ids)`, 即"id 最小的那张", 完全不看横竖; 而卡片容器是固定的
 * 3/4(见 TvEntityCard), 封面一旦是横图就会被 `object-fit: cover` 裁掉大半。
 * 实测用户库里横图占一半(壁纸那几个来源全是横的), 撞上的概率不低。
 *
 * 新判据: 谁的长宽比离 **0.75(= 容器 3/4)** 最近谁当封面。在"竖图为主"的
 * 目录里这个规则自然选出竖图 —— 因为竖图离 0.75 更近, 不需要额外写一条
 * "优先竖图"的特例。同分时取下标最小的(等于老的"最早入库的当封面"),
 * 保证同一批数据下封面是稳定的、不会每次请求换一张。
 *
 * 没有尺寸的行(老库还没回填)记 Infinity —— **不参与竞争**, 但仍然可以作为
 * 兜底; 万一整组都没有尺寸, 结果与改动前完全一致(退回 min id)。
 */
function coverIdx(ids) {
  // 安全模式开着时, 先把会被藏的记录剔出封面候选池(2026-10-06): 系列卡/角色卡的
  // 封面不能是一张用户在安全模式下根本看不见的图。**整池都被藏才回落全池** ——
  // 封面空着比露出一张敏感图更糟(反正图集点进去也看不见它)。
  let pool = ids
  const st = loadSafetyState()
  if (st.on) {
    const lvl = st.level === 'edge' ? 'edge' : 'core'
    const safe = []
    for (const i of ids) {
      const r = ds.records[i]
      if (r && !hiddenAt(r.unsafe, lvl)) safe.push(i)
    }
    if (safe.length) pool = safe
  }
  let best = -1
  let bestScore = Infinity
  for (const i of pool) {
    const r = ds.records[i]
    if (!r) continue
    const w = Number(r.px_w) || 0
    const h = Number(r.px_h) || 0
    // 越小越"接近容器比例"。无尺寸 = Infinity, 只在别人也都没有时胜出。
    const score = (w > 0 && h > 0) ? Math.abs(w / h - 0.75) : Infinity
    // 同分取下标最小的 —— **显式比较**, 不依赖 Set 的遍历顺序
    // (seriesImgs / seriesChars 里的下标集合不保证升序)。
    if (best < 0 || score < bestScore || (score === bestScore && i < best)) {
      bestScore = score
      best = i
    }
  }
  return best < 0 ? 0 : best
}

export function getSeries(raw = {}) {
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const meta = loadUserMeta()
  /** 「显示无本地图的角色」开关: 关(默认)时 0 图补全角色不计角色数、纯 0 图系列不出现 */
  const withZero = !!raw.withZero
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
    // 角色数按**合并后**的组数算(见 mergeCharVariants) —— 不然列表页写 9 个角色、
    // 点进详情页只有 6 张卡, 两处对不上
    const groups = mergeCharVariants(ds.seriesChars.get(name) || new Map())
    const groupsShown = new Map()
    for (const [short, g] of groups) {
      let ids = g.ids
      if (srcSet) {
        ids = new Set()
        for (const i of g.ids) if (srcOk(i)) ids.add(i)
        if (!ids.size) continue
      }
      groupsShown.set(short, ids.size)
    }
    // 合并 custom_chars 里该系列下的补充角色 —— 不算上的话, 列表页的角色数/图片数
    // 会和该系列详情页对不上
    const extraAll = (meta.custom_chars[name] || []).filter((t) => !groups.has(charShortName(t)))
    // 开关关(默认): 0 图的补全角色不计入角色数 —— 与 getCharacters 的过滤同一口径,
    // 不然列表页写 20 个角色、点进详情页只有 6 张卡(老坑, 见 mergeCharVariants 注释)
    const extra = withZero ? extraAll : extraAll.filter((t) => (tagCounter.get(t) || 0) > 0)
    let extraImgs = 0
    for (const t of extra) extraImgs += tagCounter.get(t) || 0

    items.push({
      name,
      images: ids.size + extraImgs,
      characters: groupsShown.size + extra.length,
      // 自定义封面(用户在卡片 ⚙️ 里挑的)优先; 没设才走自动挑选(安全感知)
      thumb: meta.custom_covers?.series?.[name] || ds.records[ids.size ? coverIdx(ids) : 0].path,
      category: cats[name] || guessCategory(name),
    })
    seen.add(name)
  }

  // 自定义系列(不在系列索引里, 但用户在元数据里手动加过角色的)
  const extraNames = Object.keys(meta.custom_chars).filter((n) => !seen.has(n))
  const fpm = extraNames.length ? firstPathMap(srcSet) : null
  for (const name of extraNames) {
    const tags = meta.custom_chars[name]
    const shownTags = withZero ? tags : tags.filter((t) => (tagCounter.get(t) || 0) > 0)
    // 开关关且该系列一个有图的角色都没有 -> 整个系列跳过(纯补全系列默认不出现)
    if (!shownTags.length) continue
    let real = 0
    let thumb = ''
    for (const t of tags) {
      real += tagCounter.get(t) || 0
      if (!thumb) thumb = fpm.get(t) || ''
    }
    items.push({
      name, images: real, characters: shownTags.length,
      thumb: meta.custom_covers?.series?.[name] || thumb,
      category: cats[name] || guessCategory(name), custom: true,
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

/**
 * 同一角色的两种 tag 写法合并(2026-10-04)
 * ==============================================
 * WD14 对同一个角色有时打短名(`frieren`)、有时打带作品的全名
 * (`frieren_(sousou_no_frieren)`), 而 charlib 两种写法**都**登记成角色
 * (chars 表里 frieren=src:cooccur, frieren_(...)=src:paren) ->
 * seriesChars 里就是两个 key -> 系列页同一个角色出现两张卡。
 * 用户 10-04 实测: 芙莉莲 249 张 + frieren 17 张、菲伦 504 + 蕨类植物 92、
 * 奥拉 19 + 光环 10 —— 一共 9 个"角色"里 3 个是重复的。
 *
 * 合并口径: 同一系列内按**短名**分组。
 *   · 代表 tag 优先取带括号的完整形式 —— 完整形式跨系列无歧义, 而且它才是
 *     「角色表」该有的样子(用户要导出的就是 `frieren_(sousou_no_frieren)`,
 *     而不是裸的 `frieren`)。只有短名存在时才用短名。
 *   · alt 带回其余写法: 角色图集那边用 exact 多 tag 搜索, 把两种写法的图一次收齐
 *     (用短名做 contains 会顺带命中别的作品角色, exact 不会)。
 *   · 张数相加, 缩略图从合并后的集合里挑(按记录顺序, 与原口径一致)。
 *
 * @param {Map<string, Set<number>>} chars seriesChars 的一项
 * @returns {Map<string, {tags: string[], ids: Set<number>}>} 短名 -> 组
 */
export function mergeCharVariants(chars) {
  const groups = new Map()
  for (const [tag, idSet] of chars) {
    const short = charShortName(tag)
    let g = groups.get(short)
    if (!g) { g = { tags: [], ids: new Set() }; groups.set(short, g) }
    g.tags.push(tag)
    for (const i of idSet) g.ids.add(i)
  }
  return groups
}

/** 组 -> 代表 tag + alt 列表(代表优先带括号的完整形式) */
function charRep(g) {
  const full = g.tags.find((t) => t !== charShortName(t))
  const rep = full || g.tags[0]
  return { rep, alt: g.tags.filter((t) => t !== rep) }
}

export function getCharacters(raw = {}) {
  const series = typeof raw.series === 'string' ? raw.series : ''
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const meta = loadUserMeta()
  /** 「显示无本地图的角色」开关: 默认隐藏 images===0 的补全角色(与 getSeries 同参数同口径) */
  const withZero = !!raw.withZero
  const ccov = meta.custom_covers?.chars || {}
  const chars = ds.seriesChars.get(series) || new Map()
  const items = []
  const okCache = new Map()
  const srcOk = (idx) => {
    if (!srcSet) return true
    let v = okCache.get(idx)
    if (v === undefined) { v = srcSet.has(ds.records[idx].source); okCache.set(idx, v) }
    return v
  }

  for (const [, g] of mergeCharVariants(chars)) {
    let ids = g.ids
    if (srcSet) {
      ids = new Set()
      for (const i of g.ids) if (srcOk(i)) ids.add(i)
      if (!ids.size) continue
    }
    const { rep, alt } = charRep(g)
    items.push({
      tag: rep,
      alt,
      name: charShortName(rep),
      images: ids.size,
      // 自定义封面优先(用户在卡片 ⚙️ 里挑的); 没设才走自动挑选(安全感知)
      thumb: ccov[rep] || ds.records[coverIdx(ids)].path,
    })
  }

  // 用户手动补的角色(库里可能没有这个标签 -> 0 张图)
  const [tagCounter, , ] = statsFor(srcSet)
  const recs = recordsFor(srcSet)
  const groups = mergeCharVariants(chars)
  for (const tag of meta.custom_chars[series] || []) {
    // 跟"合并后"的组比, 不是跟原始 chars 比 —— 否则用户补的 `frieren` 会跟
    // 合并组(代表 tag = frieren_(sousou_no_frieren)) 又撞出一张重复卡
    if (groups.has(charShortName(tag))) continue
    const c = tagCounter.get(tag) || 0
    let thumb = ''
    if (c > 0) {
      for (const rec of recs) {
        if (rec.tags.includes(tag)) { thumb = rec.path; break }
      }
    }
    items.push({ tag, alt: [], name: charShortName(tag), images: c, thumb: ccov[tag] || thumb })
  }

  const shown = withZero ? items : items.filter((it) => it.images > 0)
  shown.sort((a, b) => b.images - a.images || a.name.localeCompare(b.name, 'en'))
  return { series, total: shown.length, characters: shown }
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
  // 上限 50 → 200: 下拉「全选」一次要拿全当前词的匹配(如「发」能带出几十个发色/发型)
  const limit = Math.min(clampInt(raw.limit, 12, 1, 200), 200)
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
  // 标签页「隐藏已ban」开关(默认开, 前端持久化) —— 服务端过滤, total 才是真实的可见数
  const hideBanned = raw.hide_banned === '1' || raw.hide_banned === 1 || raw.hide_banned === true

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

  // ban 标记打在**全量**上再切页: hide_banned 的 total / bannedHidden 才算得对
  // (原来只标记返回页 —— 一万条 exact-Set 查找是微秒级, 不差这点)
  let bannedCount = 0
  for (const it of items) {
    const tl = it.tag.toLowerCase()
    if (bl.exact.has(tl)) {
      it.banned = true
      it.ban_rule = tl
    } else if (bl.regex && bl.regex.test(tl)) {
      it.banned = true
      it.ban_rule = bl.rules.find((r) => isBlocked(it.tag, [r])) || ''
    }
    if (it.banned) { bannedCount++; continue }
    const zh = tr.get(tl)
    if (zh) it.zh = zh
  }
  const visible = hideBanned ? items.filter((it) => !it.banned) : items
  const total = visible.length
  const page = limit > 0 ? visible.slice(offset, offset + limit) : visible

  return { total, offset, returned: page.length, tags: page, bannedHidden: bannedCount }
}

// ---------------------------------------------------------------- 自定义封面

/**
 * 封面候选图(系列页卡片 ⚙️ 挑封面用, 2026-10-06)。
 * kind='series': 该系列(名)下的全部图; kind='chars': 该角色(代表 tag)的图 ——
 * 与角色卡同口径(合并 alt 写法; 手动补的角色按标签 exact 全库找)。
 * 来源过滤照常; 安全模式开着时只返回该档位下可见的图(用户拍板: 挑选窗只出安全图)。
 * 按库内记录顺序返回, 上限 200 条(超出部分只计数, 前端有 total 提示)。
 */
export function getCoverCandidates(raw = {}) {
  const kind = raw.kind === 'chars' ? 'chars' : 'series'
  const key = String(raw.key || '').trim()
  if (!key) return { candidates: [], total: 0 }
  const series = typeof raw.series === 'string' ? raw.series : ''
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const st = loadSafetyState()
  const lvl = st.level === 'edge' ? 'edge' : 'core'

  let ids = []
  if (kind === 'series') {
    ids = [...(ds.seriesImgs.get(key) || [])]
  } else {
    for (const [, g] of mergeCharVariants(ds.seriesChars.get(series) || new Map())) {
      const { rep, alt } = charRep(g)
      if (rep === key || (alt || []).includes(key)) { ids = [...g.ids]; break }
    }
    if (!ids.length) {
      // 手动补的角色(库里可能没有该标签): 全库按标签 exact 找
      for (let i = 0; i < ds.records.length; i++) {
        if (ds.records[i].tags.includes(key)) ids.push(i)
      }
    }
  }

  const okCache = new Map()
  const srcOk = (idx) => {
    if (!srcSet) return true
    let v = okCache.get(idx)
    if (v === undefined) { v = srcSet.has(ds.records[idx].source); okCache.set(idx, v) }
    return v
  }

  const CAP = 200
  const out = []
  let total = 0
  for (const i of ids) {
    const r = ds.records[i]
    if (!r) continue
    if (!srcOk(i)) continue
    if (st.on && hiddenAt(r.unsafe, lvl)) continue
    // 磁盘上已不存在的图不当候选(2026-10-06): 挑上去就是 404, 挑选窗里也不该出现
    try { if (!fs.statSync(r.path).isFile()) continue } catch { continue }
    total++
    if (out.length < CAP) out.push({ path: r.path, px_w: r.px_w || 0, px_h: r.px_h || 0 })
  }
  return { candidates: out, total, capped: total > out.length }
}

/** 设/清自定义封面。path 空串 = 清除该条(恢复自动挑选)。 */
export function setCover(raw = {}) {
  const kind = raw.kind === 'chars' ? 'chars' : 'series'
  const key = String(raw.key || '').trim()
  if (!key) return { error: '缺少 key' }
  const pth = String(raw.path || '').trim()
  if (pth && !recordByPath(pth)) return { error: '该图片不在当前库里: ' + pth }
  const r = patchUserMeta({ custom_covers: { [kind]: { [key]: pth } } })
  return { ok: r.ok !== false, covers: r.meta?.custom_covers }
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

/**
 * 库内但不在内存数据集的图(2026-10-17 兜底): 记录在 tags.db 里好好的, 只是
 * 所在文件夹把「看板来源」注销了(as_source=0) -> ds.byPath 查不到 -> 光箱把它
 * 当库外图, 明明有 tag 却显示"库外图片 · 未知来源"。这里按 path 直查一次库
 * (gone=0), 查到就按正常库内图渲染 —— 与查重「只扫可见图」的决定互补:
 * 查重不再捞出这类图, 但收藏页/历史入口等路径万一碰到, 标签也不会丢。
 */
function dbTagsByPath(p) {
  try {
    const row = openDb().prepare('SELECT tags, tags_src FROM images WHERE path = ? AND gone = 0').get(p)
    if (!row || !row.tags) return null
    const tags = String(row.tags).split(',').map((t) => t.trim()).filter(Boolean)
    if (!tags.length) return null
    return { tags, tagsSrc: String(row.tags_src || '') }
  } catch { return null }
}

/** lightbox 用的结构化数据: 角色 / 系列 / 全部标签(已滤掉 Danbooru 分类噪声)
 *  2026-10-18: 附带 tags_src 供来源徽章(图片自带 / 反推入库 / 自带+反推 / 手工导入) */
export function getLightboxData(raw = {}) {
  const p = typeof raw.path === 'string' ? raw.path : ''
  if (!p) return { error: 'not found' }

  const rec = recordByPath(p)
  if (rec) {
    return packLightbox(p, rec.tags, rec.tagsSrc)
  }

  // 兜底①: 库内记录但来源被隐藏(见 dbTagsByPath 注释)
  const dbTags = dbTagsByPath(p)
  if (dbTags) return packLightbox(p, dbTags.tags, dbTags.tagsSrc)

  // 兜底②: 库外图片(「扫描文件夹」里的 AI 生成图) —— 直接读图片元数据。
  // 注意: 即使没有任何元数据也要回 200 语义, 否则前端拿不到结构, lightbox 直接空白。
  if (fs.existsSync(p)) {
    const { text, source } = extractImagePrompt(p)
    const tags = text ? promptToTags(text) : []
    return { ...packLightbox(p, tags), external: true, prompt_source: source }
  }
  return { error: 'not found' }
}

function packLightbox(p, tags, tagsSrc = '') {
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
    tags_src: String(tagsSrc || ''),
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
