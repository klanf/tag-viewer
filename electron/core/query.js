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
  rebuildSeriesIndex,
} from './dataset.js'
import { loadUserMeta, patchUserMeta } from './meta.js'
import { loadSafetyState, hiddenAt } from './safety.js'
import { blacklistMatcher, isBlocked, isBlockedFast, buildBanMap, loadBgConfig, hasBgTagFast } from './rules.js'
import { translateMap, translateMany, zhIndex } from './translate.js'
import { parseQuery, scopeRecords, searchCached, applySort, frozenKey } from './search.js'
import { extractImagePrompt } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'
import { openDb } from './store.js'
import { reloadCharLib, libCharsBySeries } from './charlib.js'
import { isUserPickPath } from './booru.js'
import { aggregateScanFolderTags, collectScanFolderImages } from './scan.js'

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
  /* total 不是"会隐藏多少张", 是给「不安全模式」算**补集**用的:
     该模式隐藏 = 总数 - 敏感数。前端把 total 一起收在 counts 里。 */
  v = { core, edge: core + edge, total: results.length }
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
  // 文件夹路径前缀过滤(2026-10-21): 标签图片页按扫描夹筛图。under = 逗号分隔的
  // 文件夹路径, 命中"图片路径在该文件夹(含子目录)下"。与 nameQ 一样在**缓存结果上**
  // 过滤 —— searchCached 的 key 不含 under, 把它塞进 records 会让不同前缀共享同一份
  // 缓存条目, 结果直接错; 放在缓存之后过滤则天然正确, total 也跟着变小(口径一致)。
  // 路径比较统一 / 分隔 + 小写(Windows 不区分大小写), 前缀补尾部 / 防止
  // 「ai」这个文件夹误吞同前缀兄弟目录「ai2」。
  const underRaw = String(raw.under || '').trim()
  if (underRaw) {
    const prefixes = underRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/')
    if (prefixes.length) {
      results = results.filter((r) => {
        const np = String(r.path).replace(/\\/g, '/').toLowerCase()
        return prefixes.some((pf) => np.startsWith(pf))
      })
    }
  }
  const seedKey = [p.searchTags.join(','), p.mode, p.match, p.sort, nameQ, underRaw].join('|')
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

/** user_meta.hidden_chars 的小写集合 */
function hiddenCharSet(meta) {
  return new Set((meta.hidden_chars || []).map((t) => String(t).toLowerCase()))
}

/**
 * custom_chars 按**有效系列**分组。
 * 平时就是登记键; 一旦 char_series 把这个 tag 挪走, 归目标系列 —— 于是
 * 「补出来的角色(包括 0 图)挪系列」只改纠正层, 不动 custom_chars, 撤销也干净。
 */
function customCharsBySeries(meta) {
  const out = new Map()
  const ov = meta.char_series || {}
  for (const [series, list] of Object.entries(meta.custom_chars || {})) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const t = String(raw || '').trim()
      if (!t) continue
      const target = ov[t.toLowerCase()] || series
      let arr = out.get(target)
      if (!arr) { arr = []; out.set(target, arr) }
      if (!arr.includes(t)) arr.push(t)
    }
  }
  return out
}

/** 卡片显示名: char_names 优先(按组的每个写法找), 否则回退短名 */
function displayNameOf(meta, tags, fallback) {
  const names = meta.char_names || {}
  for (const t of tags) {
    const v = names[String(t).toLowerCase()]
    if (v) return v
  }
  return fallback
}

export function getSeries(raw = {}) {
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const meta = loadUserMeta()
  const hidden = hiddenCharSet(meta)
  const customBySeries = customCharsBySeries(meta)
  const libBySeries = libCharsBySeries()
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
      if (g.tags.some((t) => hidden.has(t.toLowerCase()))) continue
      let ids = g.ids
      if (srcSet) {
        ids = new Set()
        for (const i of g.ids) if (srcOk(i)) ids.add(i)
        if (!ids.size) continue
      }
      groupsShown.set(short, ids.size)
    }
    // 合并补充角色 —— 用户补的(custom_chars) + 新角色库里 0 图的角色。
    // 按短名和已出图角色去重, 否则同一个角色会出现两张卡。
    const extraSeen = new Set()
    const extraList = []
    for (const t of customBySeries.get(name) || []) {
      const short = charShortName(t)
      if (extraSeen.has(short) || hidden.has(t.toLowerCase()) || groups.has(short)) continue
      extraSeen.add(short)
      extraList.push(t)
    }
    for (const [short, g] of libCharGroups(libBySeries.get(name) || [])) {
      if (extraSeen.has(short) || groups.has(short)) continue
      if (hidden.has(g.rep.toLowerCase())) continue
      extraSeen.add(short)
      extraList.push(g.rep)
    }
    // 开关关(默认): 0 图的补全角色不计入角色数 —— 与 getCharacters 的过滤同一口径,
    // 不然列表页写 20 个角色、点进详情页只有 6 张卡(老坑, 见 mergeCharVariants 注释)
    const extra = withZero ? extraList : extraList.filter((t) => (tagCounter.get(t) || 0) > 0)
    let extraImgs = 0
    for (const t of extra) extraImgs += tagCounter.get(t) || 0

    items.push({
      name,
      images: ids.size + extraImgs,
      characters: groupsShown.size + extra.length,
      // 自定义封面(用户在卡片 ⚙️ 里挑的)优先; 没设才走自动挑选(安全感知)
      thumb: meta.custom_covers?.series?.[name] || ds.records[ids.size ? coverIdx(ids) : 0].path,
      has_cover: !!meta.custom_covers?.series?.[name],
      category: cats[name] || guessCategory(name),
    })
    seen.add(name)
  }

  // 自定义系列(不在系列索引里, 但用户在元数据里手动加过角色的)
  const extraNames = [...customBySeries.keys()].filter((n) => !seen.has(n))
  const fpm = extraNames.length ? firstPathMap(srcSet) : null
  for (const name of extraNames) {
    const tags = (customBySeries.get(name) || []).filter((t) => !hidden.has(t.toLowerCase()))
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
      has_cover: !!meta.custom_covers?.series?.[name],
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

/**
 * 组 -> 代表 tag + alt 列表。
 * 排序: 括号里就是所属系列的完整写法(frieren_(sousou_no_frieren)) > 裸名(usada_pekora)
 * > 服装/形态写法(usada_pekora_(1st_costume)) —— 代表 tag 会被当成「角色表」里那一行
 * 和导出用的标签, 用服装名当代表等于往角色表里塞 `1st_costume`。
 */
function charRep(g) {
  const rank = (t) => {
    const short = charShortName(t)
    if (t === short) return 1
    const inner = t.slice(short.length + 2, -1).toLowerCase()
    const s = seriesName(t)
    return s && s === inner ? 2 : 0
  }
  let rep = g.tags[0]
  for (const t of g.tags) if (rank(t) > rank(rep)) rep = t
  return { rep, alt: g.tags.filter((t) => t !== rep) }
}

/** 角色库里的同角色多写法按短名合并; 代表优先裸名(usada_pekora 而非 1st_costume) */
function libCharGroups(tags) {
  const groups = new Map()
  for (const tag of tags) {
    const short = charShortName(tag)
    let g = groups.get(short)
    if (!g) { g = { rep: tag, tags: [] }; groups.set(short, g) }
    g.tags.push(tag)
    if (tag === short) g.rep = tag
  }
  return groups
}

export function getCharacters(raw = {}) {
  const series = typeof raw.series === 'string' ? raw.series : ''
  const p = parseQuery(raw)
  const srcSet = p.srcSet
  const meta = loadUserMeta()
  /** 「显示无本地图的角色」开关: 默认隐藏 images===0 的补全角色(与 getSeries 同参数同口径) */
  const withZero = !!raw.withZero
  const ccov = meta.custom_covers?.chars || {}
  const hidden = hiddenCharSet(meta)
  const customBySeries = customCharsBySeries(meta)
  const libBySeries = libCharsBySeries()
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
    if (g.tags.some((t) => hidden.has(t.toLowerCase()))) continue
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
      name: displayNameOf(meta, g.tags, charShortName(rep)),
      images: ids.size,
      // 自定义封面优先(用户在卡片 ⚙️ 里挑的); 没设才走自动挑选(安全感知)
      thumb: ccov[rep] || ds.records[coverIdx(ids)].path,
      // 「有没有自己设过封面」单独告诉渲染层: 批量拉封口的三个口径要用它筛
      // (thumb 字段分不出来 —— 自动挑的也有值)
      has_cover: !!ccov[rep],
    })
  }

  // 用户手动补的角色(库里可能没有这个标签 -> 0 张图), 按有效系列取
  const [tagCounter, , ] = statsFor(srcSet)
  const recs = recordsFor(srcSet)
  const groups = mergeCharVariants(chars)
  const seenExtra = new Set()
  for (const tag of customBySeries.get(series) || []) {
    const short = charShortName(tag)
    if (seenExtra.has(short)) continue
    seenExtra.add(short)
    if (hidden.has(tag.toLowerCase())) continue
    // 跟"合并后"的组比, 不是跟原始 chars 比 —— 否则用户补的 `frieren` 会跟
    // 合并组(代表 tag = frieren_(sousou_no_frieren)) 又撞出一张重复卡
    if (groups.has(short)) continue
    const c = tagCounter.get(tag) || 0
    let thumb = ''
    if (c > 0) {
      for (const rec of recs) {
        if (rec.tags.includes(tag)) { thumb = rec.path; break }
      }
    }
    items.push({
      tag, alt: [], name: displayNameOf(meta, [tag], charShortName(tag)),
      images: c, thumb: ccov[tag] || thumb, has_cover: !!ccov[tag],
    })
  }

  // 角色库里登记、但本地还没出过图的角色 —— 只在"显示无本地图角色"打开时列出,
  // 取代原来靠 custom_chars 才能看到 0 图角色的做法(2026-10-21)。
  for (const [short, g] of libCharGroups(libBySeries.get(series) || [])) {
    if (seenExtra.has(short) || groups.has(short)) continue
    const tag = g.rep
    if (hidden.has(tag.toLowerCase())) continue
    const c = tagCounter.get(tag) || 0
    if (!withZero && c === 0) continue
    let thumb = ''
    if (c > 0) {
      for (const rec of recs) {
        if (rec.tags.includes(tag)) { thumb = rec.path; break }
      }
    }
    items.push({
      tag, alt: g.tags.filter((t) => t !== tag),
      name: displayNameOf(meta, g.tags, charShortName(tag)),
      images: c, thumb: ccov[tag] || thumb, has_cover: !!ccov[tag], fromLibrary: true,
    })
  }

  const shown = withZero ? items : items.filter((it) => it.images > 0)
  shown.sort((a, b) => b.images - a.images || a.name.localeCompare(b.name, 'en'))
  return { series, total: shown.length, characters: shown }
}

export function getSeriesMeta() { return loadUserMeta() }

export async function postSeriesMeta(body) {
  const before = loadUserMeta()
  const r = patchUserMeta(body)
  if (r.ok === false) return { error: r.error || '保存失败' }
  // 影响"角色 -> 系列"的字段变了才重建索引: 补/挪/屏蔽角色都要让系列页立刻变,
  // 但只改分类/封面/显示名时不该白等一次 85k 条重建。
  const sig = (m) => JSON.stringify([m.custom_chars, m.char_series, m.hidden_chars])
  if (sig(before) !== sig(r.meta)) {
    reloadCharLib()
    await rebuildSeriesIndex()
  }
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

// --------------------------------------- 图内元数据 -> 标签库命中匹配(2026-10-21)

/**
 * 图内元数据标签在标签库(tag.db)里的命中匹配。
 *
 * 背景: 光箱「图内元数据」模式点了就跳 /tags/:tag, 但跑图提示词的词条和
 * 库内规范化词条不是一套写法 —— 权重括号被当强调剥掉(promptToTags)、
 * 空格转下划线、角色括号还有转义/不转义之分, 拿原始词条直接跳大多落空。
 * 「怎么找」收进后端, 匹配链先精确后骨架:
 *   1. 精确键: 库里有没有这个词条本身(小写归一);
 *   2. 骨架键: 双方都剥掉 - _ ( ) \ . 空格等符号只留字母数字再比 ——
 *     'ganyu_genshin_impact'(提示词括号被剥) 与 'ganyu_(genshin_impact)'
 *     (库内角色 tag) 骨架同为 ganyugenshinimpact, 一击命中;
 *     同骨架多候选取 count 最高的(最常用写法)。
 * 命中返回库内真 tag + 库内图片数(前端 pill 直接展示, 跳过去的列表不空);
 * 未命中不硬凑 —— 宁可不跳也不跳错。
 *
 * @param {{tags: string[]}} raw key=原始元数据词条
 * @returns {{hits: Record<string, {tag: string, count: number}>}}
 */
let _skelCache = null   // { ref: 全量 statsMap, idx: Map(骨架 -> [tag, count]) }
function libSkeletonIdx() {
  const [statsMap] = statsFor(null)     // 全部来源, 与标签库口径一致
  if (_skelCache && _skelCache.ref === statsMap) return _skelCache.idx
  const idx = new Map()
  for (const [t, c] of statsMap) {
    const s = String(t).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!s) continue
    const arr = idx.get(s)
    if (arr) { if (c > arr[1]) { arr[0] = t; arr[1] = c } }
    else idx.set(s, [t, c])
  }
  _skelCache = { ref: statsMap, idx }   // statsMap 换代(重扫/入库)自动重建
  return idx
}

export function matchMetaTags(raw = {}) {
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => String(t || '').trim()).filter(Boolean).slice(0, 300)
  const hits = {}
  if (!tags.length) return { hits }
  const [statsMap] = statsFor(null)
  for (const t of tags) {
    if (hits[t]) continue
    const low = t.toLowerCase()
    const c = statsMap.get(low) ?? statsMap.get(t)
    if (c !== undefined) { hits[t] = { tag: low, count: c }; continue }
    const sk = low.replace(/[^a-z0-9]/g, '')
    if (!sk) continue
    const cand = libSkeletonIdx().get(sk)
    if (cand) hits[t] = { tag: cand[0], count: cand[1] }
  }
  return { hits }
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
  const bannedCount = markBanAndZh(items, bl, tr)
  const visible = hideBanned ? items.filter((it) => !it.banned) : items
  const total = visible.length
  const page = limit > 0 ? visible.slice(offset, offset + limit) : visible

  return { total, offset, returned: page.length, tags: page, bannedHidden: bannedCount }
}

/** 给 [{tag,count}] 打 ban 标记 + 挂中文 —— getAllTags / getScanTagList 共用 */
function markBanAndZh(items, bl, tr) {
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
  return bannedCount
}

/**
 * 扫描文件夹的标签列表(2026-10-21) —— 标签页「按扫描夹筛选」的后端。
 *
 * 数据源是扫描的持久增量缓存(scan_cache.json): 每个条目在扫描时就用
 * promptToTags 规范化过了, 这里纯内存聚合, 不读任何图片文件。
 * 入参/返回形状与 getAllTags 对齐(q/offset/limit/hide_banned), 前端一套
 * 加载逻辑跑两种模式, 不用分支维护两份渲染。
 */
export function getScanTagList(raw = {}) {
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 120, 0, 1_000_000)
  const kw = String(raw.q || '').trim().toLowerCase()
  const hideBanned = raw.hide_banned === '1' || raw.hide_banned === 1 || raw.hide_banned === true
  const paths = String(raw.paths || '')
    .split(',').map((s) => s.trim()).filter(Boolean)

  // paths 为空 = 「全部」档: 聚合整个缓存(aggregateScanFolderTags 内部处理),
  // 原来直接返回 0 —— 「全部 37,492」的胶囊下标签列表却是空的, 名不副实
  const { counts, images, withTags, missing } = aggregateScanFolderTags(paths)
  const tr = translateMap()
  const bl = blacklistMatcher()

  const items = []
  for (const [t, c] of counts) {
    if (kw && !t.toLowerCase().includes(kw)) continue
    items.push({ tag: t, count: c })
  }
  items.sort((a, b) => b.count - a.count)

  const bannedCount = markBanAndZh(items, bl, tr)
  const visible = hideBanned ? items.filter((it) => !it.banned) : items
  const total = visible.length
  const page = limit > 0 ? visible.slice(offset, offset + limit) : visible

  return {
    total, offset, returned: page.length, tags: page, bannedHidden: bannedCount,
    scan: { images, withTags, missing },
  }
}

/**
 * 扫描缓存里的「标签 -> 图片」(2026-10-21) —— 标签图片页扫描档的后端。
 *
 * 纯扫描夹的图不进库, doSearch 怎么筛都是 0(实测: 选 26_10_14 得 0 条匹配)
 * —— 图只能从扫描缓存出: 条目 {path -> {m,s,t,src}}, t 是扫描时 promptToTags
 * 规范化好的标签。命中语义与库搜索的 contains/any 一致, 返回形状与 doSearch
 * 对齐({total, offset, returned, results, unsafe}), useImageFeed 换个 fetcher
 * 就能跑。results 条目 {path, m, s, tags} —— 卡片/光箱与扫描页同款通用
 * (无像素尺寸, 卡片比例回落 9/16, 与扫描页一致)。
 */
export function getScanTagImages(raw = {}) {
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 60, 1, 2000)
  const qTags = String(raw.q || '')
    .split(/[,，]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
  const paths = String(raw.paths || raw.under || '')
    .split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  // paths 为空 = 「全部」档: collectScanFolderImages 内部聚合整个缓存
  const items = collectScanFolderImages(paths, qTags)
  const sort = ['time', 'random'].includes(raw.sort) ? raw.sort : 'path'
  if (sort === 'time') {
    items.sort((a, b) => b.m - a.m)
  } else if (sort === 'random') {
    // 确定性洗牌: 同一 seed 同一顺序, 翻页/加载更多不跳
    let seed = Number(raw.seed) || 1
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[items[i], items[j]] = [items[j], items[i]]
    }
  } else {
    items.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
  }

  return {
    total: items.length,
    offset,
    returned: Math.min(limit, Math.max(0, items.length - offset)),
    results: items.slice(offset, offset + limit),
    /* 安全模式在渲染层按 tags 过滤(与扫描页同款)。total 让工具栏能算
       「不安全模式」下会隐藏多少张(总数 - 敏感数); 敏感数由渲染层按 tags 现算。 */
    unsafe: { core: 0, edge: 0, total: items.length },
  }
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
  /* 库内图才校验"记录存在"(挑到被移走的图会 404); 「网上挑封面」下载的 user_picks
   * 是**故意不进库**的远程图, 走 isUserPickPath 放行 —— 2026-10-22。 */
  if (pth && !recordByPath(pth) && !isUserPickPath(pth)) return { error: '该图片不在当前库里: ' + pth }
  const r = patchUserMeta({ custom_covers: { [kind]: { [key]: pth } } })
  // 写盘失败必须原样带出去(2026-10-22): 原先只回 ok:false、没有 error 字段,
  // 而 IPC 的 safe() 只把 {error} 变成 reject —— 于是"封面没存上"在界面上是静默的。
  if (r.ok === false) return { error: r.error || '写入 user_meta.json 失败' }
  // 带上 kind/key: 调用方(ipc.js)据此广播 cover:changed, 让各窗口刷新对的那一层
  return { ok: true, kind, key, path: pth, covers: r.meta?.custom_covers }
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

/** 图内元数据第二套标签(2026-10-20 光箱双源):
 * 实时读一次 PNG 文本块(文件头、IDAT 即停, 毫秒级)。v3 覆盖语义后反推会覆盖
 * 库里的 meta, 所以图内原始提示词**只能现场读盘**, 库里没有。
 * @returns {{meta_prompt:string, meta_tags:string[], meta_source:string}} */
function metaInfoFor(p) {
  try {
    if (!fs.existsSync(p)) return { meta_prompt: '', meta_tags: [], meta_source: '' }
    const { text, source } = extractImagePrompt(p)
    return {
      meta_prompt: String(text || ''),
      meta_tags: text ? promptToTags(text) : [],
      meta_source: String(source || ''),
    }
  } catch { return { meta_prompt: '', meta_tags: [], meta_source: '' } }
}

/** lightbox 用的结构化数据: 角色 / 系列 / 全部标签(已滤掉 Danbooru 分类噪声)
 *  2026-10-18: 附带 tags_src 供来源徽章(图片自带 / 反推入库 / 自带+反推 / 手工导入)
 *  2026-10-20: 附带 meta_* 三件套 —— 光箱抽屉「标签库 | 图内元数据」双源切换 */
export function getLightboxData(raw = {}) {
  const p = typeof raw.path === 'string' ? raw.path : ''
  if (!p) return { error: 'not found' }

  const rec = recordByPath(p)
  if (rec) {
    return { ...packLightbox(p, rec.tags, rec.tagsSrc), ...metaInfoFor(p) }
  }

  // 兜底①: 库内记录但来源被隐藏(见 dbTagsByPath 注释)
  const dbTags = dbTagsByPath(p)
  if (dbTags) return { ...packLightbox(p, dbTags.tags, dbTags.tagsSrc), ...metaInfoFor(p) }

  // 兜底②: 库外图片(「扫描文件夹」里的 AI 生成图) —— 直接读图片元数据。
  // 注意: 即使没有任何元数据也要回 200 语义, 否则前端拿不到结构, lightbox 直接空白。
  if (fs.existsSync(p)) {
    const { text, source } = extractImagePrompt(p)
    const tags = text ? promptToTags(text) : []
    return {
      ...packLightbox(p, tags),
      external: true,
      prompt_source: source,          // 旧字段, 「库外图片」徽章还在用
      meta_prompt: String(text || ''),
      meta_tags: tags,
      meta_source: String(source || ''),
    }
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
