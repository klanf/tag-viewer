/**
 * metaSimilar 0 命中诊断 —— 不开 Electron, 分段打印管线各站。
 * 用法: TV_DATA_DIR=<真实数据目录> node scripts/metasim-diag.mjs [图片路径]
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './harness.mjs'

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)

const { initWorkspace } = await imp('electron/core/workspace.js')
const { bootstrap } = await imp('electron/core/app-state.js')
const { getLightboxData, matchMetaTags } = await imp('electron/core/query.js')
const { getMetaSimilar } = await imp('electron/core/metasim.js')
const { parseQuery, scopeRecords, searchCached, frozenKey } = await imp('electron/core/search.js')

initWorkspace(path.join(ROOT, '.selftest-userdata'))
await bootstrap({ onProgress: () => {} })

const srcPath = process.argv[2]
if (!srcPath) {
  console.log('用法: node scripts/metasim-diag.mjs <图片完整路径>')
  process.exit(1)
}

console.log('== 站点 1: getLightboxData ==')
const d = getLightboxData({ path: srcPath })
const metaTags = Array.isArray(d?.meta_tags) ? d.meta_tags : []
console.log('meta_source:', d?.meta_source, '| meta_tags:', metaTags.length, '| error:', d?.error || '-')
console.log('前10词条:', metaTags.slice(0, 10).join(', '))

console.log('\n== 站点 2: matchMetaTags ==')
const { hits } = matchMetaTags({ tags: metaTags })
const entries = Object.values(hits).filter((h) => h && h.tag)
console.log('命中:', entries.length, '/', metaTags.length)
console.log('真词条:', entries.map((h) => `${h.tag}(${h.count})`).slice(0, 20).join(', '))

if (entries.length) {
  console.log('\n== 站点 3: parseQuery/scopeRecords/searchCached ==')
  const realTags = [...new Set(entries.map((h) => h.tag))]
  const p = parseQuery({ q: realTags.join(','), mode: 'any', match: 'exact' })
  console.log('searchTags:', p.searchTags.length, '| mode:', p.mode, '| match:', p.match, '| excludeTags:', p.excludeTags?.length || 0)
  const records = scopeRecords(p.srcSet, p.favs)
  console.log('scopeRecords:', records.length)
  const results = searchCached(
    records, p.searchTags, p.mode, p.match, p.excludeTags, p.excludeMatch, false,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join('|') : '',
  )
  console.log('searchCached:', results.length)
  if (results.length) {
    const want = p.searchTags
    const r0 = results[0]
    console.log('首条字段: ltags?', Array.isArray(r0.ltags), '| tags?', Array.isArray(r0.tags))
    const set = new Set(r0.ltags || r0.tags)
    let n = 0
    for (const w of want) if (set.has(w)) n++
    console.log('首条重合:', n, '/', want.length)
  }
}

console.log('\n== 站点 4: getMetaSimilar 整链 ==')
const t0 = Date.now()
const r = getMetaSimilar({ path: srcPath, offset: 0, limit: 10 })
console.log(`${Date.now() - t0}ms | total=${r.total} | hitTags=${r.hitTags?.length} | metaCount=${r.metaCount} | maxHits=${r.maxHits}`)
if (r.error) console.log('error:', r.error)
