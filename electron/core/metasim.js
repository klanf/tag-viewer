/**
 * 图内元数据 -> 库内「命中相似图」(2026-10-21)
 * ==============================================
 * 用户语义澄清(二次): 光箱 meta 模式那枚「库内命中 n/m」徽章, 点击应该
 * **把命中的库内图片显示出来** —— 而不是把 n 个词条塞进看板筛选框
 * (n 个热词 any 命中 = 差不多全库, 等于什么都没筛, 用户当场否掉)。
 *
 * 「像不像」的度量: 一张库内图与源图的**重合词条数** —— 命中的库内真词条
 * 里, 有几个出现在这张库内图的标签里。重合越多排越前, 第一屏就是
 * 「库里与这张最像的图」: 10 个词条全重合的排最前, 只撞到 1 个冷门词的沉底。
 *
 * 独立成文件的原因: query.js 正与另一条工作线(角色库)共改, 新逻辑挤进去
 * 每次提交都得外科手术拆 hunk; 本文件只依赖各模块的**导出面**
 * (matchMetaTags / getLightboxData 来自 query.js, 搜索管线来自 search.js),
 * 单文件零纠缠。
 *
 * 管线: getLightboxData(meta_tags) -> matchMetaTags(精确+骨架两级) ->
 * 去重出库内真词条 -> searchCached(exact / any / excludeChar=false, 让
 * ganyu_(genshin_impact) 这类带括号词条既参与命中也参与计数) ->
 * 逐图数重合 -> 降序分页。
 */
import { parseQuery, scopeRecords, searchCached, frozenKey } from './search.js'
import { getLightboxData, matchMetaTags } from './query.js'

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
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
 * @param {{path:string, offset?:number, limit?:number}} raw
 * @returns {{total:number, offset:number, returned:number, results:Array,
 *            hitTags:string[], metaCount:number, srcPath:string, maxHits:number,
 *            unsafe:{core:number, edge:number}}}
 */
export function getMetaSimilar(raw = {}) {
  const srcPath = String(raw.path || '')
  const offset = clampInt(raw.offset, 0, 0, 10_000_000)
  const limit = clampInt(raw.limit, 60, 1, 2000)
  const empty = { total: 0, offset, returned: 0, results: [], hitTags: [], metaCount: 0, srcPath, maxHits: 0 }
  if (!srcPath) return empty

  const d = getLightboxData({ path: srcPath })
  const metaTags = Array.isArray(d?.meta_tags) ? d.meta_tags : []
  if (!metaTags.length) return empty

  const { hits } = matchMetaTags({ tags: metaTags })
  const realTags = [...new Set(Object.values(hits).map((h) => h && h.tag).filter(Boolean))]
  if (!realTags.length) return { ...empty, metaCount: metaTags.length }

  const p = parseQuery({ q: realTags.join(','), mode: 'any', match: 'exact' })
  const records = scopeRecords(p.srcSet, p.favs)
  // excludeChar 必须为 false: searchRecords 默认把带 () 的标签整体剔除,
  // 而骨架匹配捞回来的真词条恰恰多是 ganyu_(genshin_impact) 这类 ——
  // 剔掉它们, 角色图会从命中集里消失, 重合计数也缺角色这一票。
  const results = searchCached(
    records, p.searchTags, p.mode, p.match, p.excludeTags, p.excludeMatch, false,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join('|') : '',
  )

  // 逐图数重合: 真词条出现在 ltags(全量小写标签)里记一票。
  // searchCached 命中缓存时返回的是**同一批记录对象**(数组是副本、对象不是),
  // _simHits 记在对象上, 翻页/加载更多直接白捡, 只有首次搜索真算一遍。
  // 用 Set 而不是 indexOf: 7 万图 × 73 词 × 逐词扫标签数组是上亿次比较,
  // Set 一遍构建 + 73 次 has 是千万级, 差着两个数量级。
  const want = p.searchTags
  for (const r of results) {
    if (typeof r._simHits === 'number') continue
    const set = new Set(r.ltags || r.tags)
    let n = 0
    for (let i = 0; i < want.length; i++) if (set.has(want[i])) n++
    r._simHits = n
  }
  results.sort((a, b) => b._simHits - a._simHits)   // V8 sort 稳定, 同分保持库序

  const page = results.slice(offset, offset + limit)
  return {
    total: results.length,
    offset,
    returned: page.length,
    results: page,
    hitTags: realTags,
    metaCount: metaTags.length,
    srcPath,
    maxHits: results.length ? results[0]._simHits : 0,
    unsafe: unsafeCountOf(results),
  }
}
