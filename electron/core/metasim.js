/**
 * 图内元数据 -> 库内「命中相似图」(2026-10-21, 晚间定稿=全命中)
 * ==============================================
 * 语义三次澄清的演进:
 *   v1 塞词条进看板筛选(any) —— 任一命中=全库, 被否;
 *   v2 跳命中页按「重合词条数」降序 —— 排序有价值但 any 总数≈全库, 用户仍困惑;
 *   v3(本版) **全命中(AND)**: 剔掉角色/系列词 + 机位/视角词之后, 剩下的词条
 *   必须**全部**出现在库内图标签里才算命中。用户的原话: "我的意思应该是
 *   全命中才行吧, 当然要把角色和机位的 tag 都去掉才行"。
 *
 * 为什么剔角色和机位: 源图的角色词(莱莎)库内同角色图天然全含、机位词
 * (cowboy_shot/from_behind...)与"像不像"无关, 留着它们全命中永远凑不齐;
 * 剔掉后剩下的服装/场景/构图词全含的图, 才是"同款元素齐全"。
 *
 * 全命中 0 张时降级兜底: 按重合词条数降序给"最接近的"(any 超集一趟算出,
 * 前端出档位 chips 收窄), 并带 fallback 标记 —— 不让页面死白。
 *
 * 独立成文件的原因: query.js 正与另一条工作线(角色库)共改, 本文件只依赖
 * 各模块的**导出面**(query.js / search.js / charlib.js / rules.js), 零纠缠。
 */
import { parseQuery, scopeRecords, searchCached, frozenKey } from './search.js'
import { getLightboxData, matchMetaTags } from './query.js'
import { libIsChar, libIsCopyright } from './charlib.js'
import { viewTagMatcher, isViewFast } from './rules.js'

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

/* 角色/系列词判定: 裸写法(reisalin_stout)与括号写法(ganyu_(genshin_impact))
 * 都要认 —— meta 原文两种形态都有。括号形态剥尾巴再查一次角色/系列表。 */
function isCharish(t) {
  if (libIsChar(t) || libIsCopyright(t)) return true
  const m = t.match(/^(.+?)_\([^)]*\)$/)
  return !!(m && (libIsChar(m[1]) || libIsCopyright(m[1])))
}

/* 与 query.js 的 unsafeCountOf 同口径(那边是模块私有)。复制一份 10 行的
 * 实现换来与共改文件零耦合 —— 语义若有分岔, 真库测试会抓出来。 */
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

/**
 * @param {{path:string, offset?:number, limit?:number, min?:number}} raw
 * @returns {{total:number, grand:number, offset:number, returned:number, results:Array,
 *            hitTags:string[], metaCount:number, usedCount:number,
 *            stripChar:number, stripView:number, allTotal:number, fallback:boolean,
 *            srcPath:string, maxHits:number, over:Array, unsafe:{core:number,edge:number}}}
 */
export function getMetaSimilar(raw = {}) {
  const srcPath = String(raw.path || '')
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 60, 1, 2000)
  /* min 只在全命中 0 张的降级态有意义: 只看重合 >= min 词的图。0 = 不过滤。 */
  const min = clampInt(raw.min, 0, 0, 10_000)
  const empty = {
    total: 0, grand: 0, offset, returned: 0, results: [], hitTags: [],
    metaCount: 0, usedCount: 0, stripChar: 0, stripView: 0, allTotal: 0,
    fallback: false, srcPath, maxHits: 0, over: [],
  }
  if (!srcPath) return empty

  const d = getLightboxData({ path: srcPath })
  const metaTags = Array.isArray(d?.meta_tags) ? d.meta_tags : []
  if (!metaTags.length) return empty

  /* ① 剔角色/系列 + 机位/视角(小写归一后逐条判定) */
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

  /* ② 剩余词条 -> 库内真词条(精确+骨架两级匹配链, meta 原文未必是库规范形) */
  const { hits } = matchMetaTags({ tags: used })
  const realTags = [...new Set(Object.values(hits).map((h) => h && h.tag).filter(Boolean))]
  if (!realTags.length) {
    return { ...empty, metaCount: metaTags.length, usedCount: used.length, stripChar, stripView }
  }

  /* ③ 一趟 any 搜索(exact, excludeChar=false 让括号角色词参与) ——
   * 全命中集与降级集都是它的子集, 不用二次搜。 */
  const p = parseQuery({ q: realTags.join(','), mode: 'any', match: 'exact' })
  const records = scopeRecords(p.srcSet, p.favs)
  const results = searchCached(
    records, p.searchTags, p.mode, p.match, p.excludeTags, p.excludeMatch, false,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join(' | ') : '',
  ).filter((r) => r.path !== srcPath)   // 剔掉源图自己: 库内反推词与原提示词几乎一致, 自己永远排第一(2026-10-21)

  // 逐图数重合: 真词条出现在 ltags(全量小写标签)里记一票。
  // searchCached 命中缓存时返回的是**同一批记录对象**(数组是副本、对象不是),
  // _simHits 记在对象上, 翻页/加载更多直接白捡, 只有首次搜索真算一遍。
  // ⚠️ 缓存键必须带 srcPath: 同一条库内记录给不同源图算出的重合数不同,
  // 只看 typeof 会把上一张源图的账静默搬到这一张(2026-10-21 补)。
  // 用 Set 而不是 indexOf: 7 万图 × 73 词 × 逐词扫标签数组是上亿次比较,
  // Set 一遍构建 + 73 次 has 是千万级, 差着两个数量级。
  const want = p.searchTags
  for (const r of results) {
    if (r._simKey === srcPath && typeof r._simHits === 'number') continue
    const set = new Set(r.ltags || r.tags)
    let n = 0
    for (let i = 0; i < want.length; i++) if (set.has(want[i])) n++
    r._simHits = n
    r._simKey = srcPath
  }
  results.sort((a, b) => b._simHits - a._simHits)   // V8 sort 稳定, 同分保持库序

  const base = {
    offset, returned: 0, hitTags: realTags, metaCount: metaTags.length,
    usedCount: used.length, stripChar, stripView, srcPath, unsafe: unsafeCountOf(results),
  }

  /* ④a 全命中: 重合数 == 真词条数(全部都含)。升序档位/降级语义都不需要。 */
  const allList = results.filter((r) => r._simHits >= want.length)
  if (allList.length) {
    const page = allList.slice(offset, offset + limit)
    return {
      ...base,
      total: allList.length, grand: allList.length, returned: page.length,
      results: page, allTotal: allList.length, fallback: false,
      maxHits: want.length, over: [],
    }
  }

  /* ④b 全命中 0 张 -> 降级: 按重合降序给"最接近的"。
   * 分布(降序阈值 -> 张数): 直方图 + 后缀累加, O(n) 一趟; <2 词不出档。 */
  const hist = new Map()
  for (const r of results) hist.set(r._simHits, (hist.get(r._simHits) || 0) + 1)
  const over = []
  let acc = 0
  for (const t of [...hist.keys()].sort((a, b) => b - a)) {
    if (t < 2) break
    acc += hist.get(t)
    over.push({ min: t, count: acc })
  }
  const filtered = min > 0 ? results.filter((r) => r._simHits >= min) : results
  const page = filtered.slice(offset, offset + limit)
  return {
    ...base,
    total: filtered.length, grand: results.length, returned: page.length,
    results: page, allTotal: 0, fallback: true,
    maxHits: results.length ? results[0]._simHits : 0, over,
  }
}
