/**
 * 图内元数据 -> 库内「命中相似图」
 * ==============================================
 * 语义演进:
 *   v1 塞词条进看板筛选(any) —— 任一命中=全库, 被否;
 *   v2 跳命中页按「重合词条数」降序 —— 排序有价值但 any 总数≈全库, 用户仍困惑;
 *   v3 **全命中(AND)**: 剔掉角色/系列词 + 机位/视角词之后, 剩下的词条必须全含;
 *   v4(本版, 2026-10-24 用户拍板「要的就是查重的形式」): **与查重同一套打分** ——
 *     剔角色/机位后, 用 IDF 加权 Jaccard 给每张库内图打相似度, 阈值以上按分数排序。
 *     全命中是这套打分的极端档(阈值=1), 0 张时不再需要"降级"一说。
 *
 * 为什么剔角色和机位: 源图的角色词(莱莎)库内同角色图天然全含、机位词
 * (cowboy_shot/from_behind...)与"像不像"无关, 留着它们只会把分数撑大。
 * 现在**两侧都剔**: 候选图自己的角色/机位词也不进分母, 否则角色词多的图
 * (反推/人写提示词两种来源)会被无端判低。
 *
 * 打分口径抄 core/dupcheck.js, 唯一差别是: 查重是"全库两两配对", 这里是
 * "一张源图 vs 候选集"。候选集来自剔完之后的词条做一次 any 搜索(保证至少
 * 共享一词, 不可能再漏), 再逐个算:
 *     score = Σw(共享) / (Σw(源) + Σw(候选) - Σw(共享)),  w = log(1 + N/df)
 * 段位微调也照抄: 人数段(count) ×0.2、meta ×0.5 —— 1girl/solo 之类到处都是,
 * 不降权会让"都是单人图"这种无信息匹配拿到高分。
 *
 * 独立成文件的原因: query.js 正与另一条工作线(角色库)共改, 本文件只依赖
 * 各模块的**导出面**(query.js / search.js / charlib.js / rules.js / dataset.js),
 * 零纠缠。
 *
 * 可选的收窄口径(2026-10-24 用户要求与标签图片页一致): `source` 只要某个来源,
 * `under` 只要某个扫描夹(路径前缀)。两者都在打分之前把候选集缩小, 分数口径不变。
 */
import { parseQuery, scopeRecords, searchCached, frozenKey } from './search.js'
import { statsFor } from './dataset.js'
import { getLightboxData, matchMetaTags } from './query.js'
import { libIsChar, libIsCopyright } from './charlib.js'
import { viewTagMatcher, isViewFast } from './rules.js'
import { catOf } from './tagcats.js'

/** 默认阈值 0.4 —— 实测(2026-10-24 沙箱): 同批近重复图互查得分 0.34~0.62、
 * 通常排第 1~2; 查重那种 0.85 在这条链上永远 0 张(源是提示词、库是反推标签,
 * 写法与覆盖率天然对不齐)。0.4 能留住真正的"同款", 又不会把泛泛的同场景算进来。 */
const DEFAULT_THRESHOLD = 0.4
/** 低于这个分的组合根本不入缓存 —— UI 最低档 0.2 */
const SCORE_FLOOR = 0.2

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

function clampScore(v, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(0.05, Math.min(1, n))
}

/* 角色/系列词判定: 裸写法(reisalin_stout)与括号写法(ganyu_(genshin_impact))
 * 都要认 —— meta 原文两种形态都有。括号形态剥尾巴再查一次角色/系列表。 */
function isCharish(t) {
  if (libIsChar(t) || libIsCopyright(t)) return true
  if (!t.includes('(')) return false          // 括号兜底先看有没有括号, 省掉全库正则
  const m = t.match(/^(.+?)_\([^)]*\)$/)
  return !!(m && (libIsChar(m[1]) || libIsCopyright(m[1])))
}

/* 段位判定缓存(与 dupcheck.js 同口径: 人数段/count 与 meta 段降权) */
const segCache = new Map()
function segOf(name) {
  let s = segCache.get(name)
  if (s === undefined) {
    s = String(catOf(name) || 'other').split(':')[0]
    segCache.set(name, s)
  }
  return s
}

/** 一次请求内复用的权重函数: 同一个 tag 只算一次 log */
function makeWeights(tc, N) {
  const memo = new Map()
  return (tag) => {
    let w = memo.get(tag)
    if (w !== undefined) return w
    const df = tc.get(tag) || 1
    w = Math.log(1 + N / df)
    const seg = segOf(tag)
    if (seg === 'count') w *= 0.2
    else if (seg === 'meta') w *= 0.5
    memo.set(tag, w)
    return w
  }
}

/* 候选图的"剔完之后的权和"缓存在记录对象上。记录对象由数据集持有, 数据集
 * 重载会换一批新对象, 所以用 records 数组当版本令牌(WeakMap 不会漏内存)。 */
const tokCache = new WeakMap()
function tokenOf(records) {
  let t = tokCache.get(records)
  if (!t) tokCache.set(records, (t = {}))
  return t
}

function candSumW(r, wOf, vm, token) {
  if (r._simTok === token && typeof r._simSumW === 'number') return r._simSumW
  let s = 0
  for (const t of (r.ltags || r.tags || [])) {
    if (isCharish(t) || isViewFast(t, vm)) continue
    s += wOf(t)
  }
  r._simTok = token
  r._simSumW = s
  return s
}

/* 打分结果按 源图 缓存: 翻页/换阈值都不用重算(阈值只是过滤, 不重排)。
 * key 只放 srcPath —— 来源过滤换的是 records 数组对象, 天然分桶。 */
const scoredCache = new WeakMap()
const SCORE_CACHE_MAX = 8

/* 扫描夹过滤 —— 与 core/query.js 的 under 同口径(2026-10-21): / 统一分隔、
 * 小写、尾部补 /, 防「ai」吞掉同前缀的兄弟目录「ai2」。
 * 注意它只能作用在**候选列表**上, 不能塞进 searchCached 的 records: 那个缓存的
 * key 里没有 records/under, 传进去的过滤后数组会被同 tag 的未过滤缓存顶掉
 * (实测: 筛一个不存在的文件夹仍返回 2 张)。所以 searchCached 始终喂全量
 * scopeRecords, 前缀过滤放在它返回之后, 与 query.js 完全一致。 */
function underPrefixes(rawUnder) {
  return String(rawUnder || '')
    .split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/')
}

function isUnder(pth, prefixes) {
  const np = String(pth).replace(/\\/g, '/').toLowerCase()
  return prefixes.some((pf) => np.startsWith(pf))
}

/* 过滤后的候选数组按 (records, 前缀组合) 缓存住**数组身份**: 打分缓存
 * (scoredCache) 与候选图的权和缓存都靠身份分桶, 每次现 filter 会把它们全部
 * 打散、翻页时重算 2 秒。数据集重载会换 records 数组, 这份缓存自动跟着失效。 */
const underCache = new WeakMap()
function recordsUnder(records, prefixes) {
  if (!prefixes.length) return records
  const key = prefixes.join('|')
  let m = underCache.get(records)
  if (!m) underCache.set(records, (m = new Map()))
  let arr = m.get(key)
  if (!arr) {
    arr = records.filter((r) => isUnder(r.path, prefixes))
    m.set(key, arr)
  }
  return arr
}

/* 与 query.js 的 unsafeCountOf 同口径(那边是模块私有)。 */
function unsafeOfRecords(arr) {
  let core = 0
  let edge = 0
  for (const r of arr) {
    const u = r.unsafe
    if (u === 1) core++
    else if (u === 2) edge++
  }
  return { core, edge: core + edge }
}

/**
 * @param {{path:string, offset?:number, limit?:number, threshold?:number,
 *          source?:string, under?:string}} raw  source/under = 来源|扫描夹口径
 * @returns {{total:number, candTotal:number, offset:number, returned:number,
 *            results:Array, hitTags:string[], metaCount:number, usedCount:number,
 *            stripChar:number, stripView:number, threshold:number, maxScore:number,
 *            srcPath:string, unsafe:{core:number,edge:number}}}
 */
export function getMetaSimilar(raw = {}) {
  const srcPath = String(raw.path || '')
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 60, 1, 2000)
  const threshold = clampScore(raw.threshold, DEFAULT_THRESHOLD)
  const empty = {
    total: 0, candTotal: 0, offset, returned: 0, results: [], hitTags: [],
    metaCount: 0, usedCount: 0, stripChar: 0, stripView: 0, threshold,
    maxScore: 0, srcPath, unsafe: { core: 0, edge: 0 },
  }
  if (!srcPath) return empty

  const d = getLightboxData({ path: srcPath })
  const metaTags = Array.isArray(d?.meta_tags) ? d.meta_tags : []
  if (!metaTags.length) return empty

  /* ① 源图侧: 剔角色/系列 + 机位/视角(小写归一后逐条判定) */
  const vm = viewTagMatcher()
  const used = []
  let stripChar = 0
  let stripView = 0
  for (const t of metaTags) {
    const low = String(t).toLowerCase().trim()
    if (!low) continue
    if (isCharish(low)) { stripChar++; continue }
    if (isViewFast(low, vm)) { stripView++; continue }
    used.push(low)
  }

  /* ② 剩余词条 -> 库内真词条(精确+骨架两级匹配链, meta 原文未必是库规范形)。
   * 只有库里真实存在的词条才能参与相似度: 库里没有的写法任何图都不会有,
   * 留在分母里只会无端把分数压低。 */
  const { hits } = matchMetaTags({ tags: used })
  const realTags = [...new Set(Object.values(hits).map((h) => h && h.tag).filter(Boolean))]
  if (!realTags.length) {
    return { ...empty, metaCount: metaTags.length, usedCount: 0, stripChar, stripView }
  }

  /* ③ 口径: source = 来源档, under = 扫描夹档(与标签图片页的分段筛选同一套参数)。
   * 扫描夹按路径前缀过滤库内记录 —— 库外的图本来也没有库内标签, 不可能参与打分。 */
  const p = parseQuery({ q: realTags.join(','), mode: 'any', match: 'exact', source: raw.source })
  const all = scopeRecords(p.srcSet, p.favs)
  const prefixes = underPrefixes(raw.under)
  const records = recordsUnder(all, prefixes)
  const tok = tokenOf(all)

  /* ④ 打分(按源图缓存): 权重走全库 df, 候选图也用同一套权重。
   * N 用**未筛**的库内规模, 换扫描夹时同一张图的分数不变(只换候选范围)。 */
  let scored = scoredCache.get(records)?.get(srcPath)
  if (!scored) {
    const [tc] = statsFor(p.srcSet)
    const N = Math.max(all.length, 1)
    const wOf = makeWeights(tc, N)
    let results = searchCached(
      all, p.searchTags, p.mode, p.match, p.excludeTags, p.excludeMatch, false,
      frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join(' | ') : '',
    ).filter((r) => r.path !== srcPath)   // 剔掉源图自己: 库内反推词与原提示词几乎一致, 自己永远排第一
    if (prefixes.length) results = results.filter((r) => isUnder(r.path, prefixes))

    const srcW = new Map(realTags.map((t) => [t, wOf(t)]))
    let srcSumW = 0
    for (const w of srcW.values()) srcSumW += w

    scored = []
    for (const r of results) {
      const set = new Set(r.ltags || r.tags)
      let sharedW = 0
      let sharedN = 0
      for (const t of realTags) {
        if (!set.has(t)) continue
        sharedW += srcW.get(t)
        sharedN++
      }
      if (!sharedN) continue
      const denom = srcSumW + candSumW(r, wOf, vm, tok) - sharedW
      if (denom <= 0) continue
      const score = sharedW / denom
      if (score < SCORE_FLOOR) continue
      scored.push({ r, score, sharedN })
    }
    scored.sort((a, b) => b.score - a.score)

    let bucket = scoredCache.get(records)
    if (!bucket) scoredCache.set(records, (bucket = new Map()))
    if (bucket.size >= SCORE_CACHE_MAX) bucket.delete(bucket.keys().next().value)
    bucket.set(srcPath, scored)
  }

  /* ⑤ 阈值过滤 -> 分页。阈值档之间只是过滤, 排序已定, 换档零重算。 */
  const pass = scored.filter((x) => x.score >= threshold)
  const page = pass.slice(offset, offset + limit)

  return {
    total: pass.length,
    candTotal: scored.length,
    offset,
    returned: page.length,
    results: page.map((x) => ({
      ...x.r,
      sim: Math.round(x.score * 1000) / 1000,
      simShared: x.sharedN,
    })),
    hitTags: realTags,
    metaCount: metaTags.length,
    usedCount: realTags.length,
    stripChar,
    stripView,
    threshold,
    maxScore: scored.length ? Math.round(scored[0].score * 1000) / 1000 : 0,
    srcPath,
    unsafe: unsafeOfRecords(pass.map((x) => x.r)),
  }
}

