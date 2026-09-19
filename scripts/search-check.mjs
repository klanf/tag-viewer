/**
 * 搜索口径对账 —— 不开 Electron, 直接跑主进程的纯数据层。
 * 用途: 首页显示的"条匹配"和 数据集总数 对不上时, 快速定位是哪个参数造成的。
 *
 * 用法: node scripts/search-check.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, ensureWorkDir } from './harness.mjs'

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)

process.env.TV_DATA_DIR = process.env.TV_DATA_DIR || ensureWorkDir({ quiet: true }).dataDir

const { initWorkspace } = await imp('electron/core/workspace.js')
const { bootstrap } = await imp('electron/core/app-state.js')
const { ds } = await imp('electron/core/dataset.js')
const { doSearch, getStats } = await imp('electron/core/query.js')

initWorkspace(path.join(ROOT, '.selftest-userdata'))
await bootstrap({ onProgress: () => {} })
console.log('数据集:', JSON.stringify(ds.stats))
console.log('数据源:', JSON.stringify(ds.sourceNames))
console.log('各源记录数:', JSON.stringify([...ds.records.reduce((m, r) => m.set(r.source, (m.get(r.source) || 0) + 1), new Map())]))

console.log('\n--- getStats 各种入参 ---')
for (const [name, p] of [
  ['{}', {}],
  ['{source:undefined}', { source: undefined }],
  ['{source:""}', { source: '' }],
  ['{source:"垃圾箱"}', { source: '垃圾箱' }],
]) {
  const s = getStats(p)
  console.log(`${String(s.total_images).padStart(7)} 张 | ${s.sources.length} 个来源 | ${JSON.stringify(s.sources.map((x) => x.name + ':' + x.images))}   <- ${name}`)
}

const cases = [
  ['裸查询(冒烟里用的)', { q: '', offset: 0, limit: 60, sort: 'random', seed: 1 }],
  ['首页口径(空筛选)', {
    q: '', mode: 'all', match: 'contains', exclude: '', exclude_char: '1',
    sort: 'random', offset: 0, limit: 60, seed: 1,
  }],
  ['首页口径 + source=undefined', {
    q: '', mode: 'all', match: 'contains', exclude: '', exclude_char: '1',
    sort: 'random', offset: 0, limit: 60, source: undefined, seed: 1,
  }],
  ['exclude_char 关', {
    q: '', mode: 'all', match: 'contains', exclude: '', exclude_char: '0',
    sort: 'random', offset: 0, limit: 60, seed: 1,
  }],
  ['mode=any', { q: '', mode: 'any', match: 'contains', sort: 'random', limit: 60, seed: 1 }],
  ['match=exact', { q: '', mode: 'all', match: 'exact', sort: 'random', limit: 60, seed: 1 }],
  ['带一个标签 1girl', { q: '1girl', mode: 'all', match: 'contains', sort: 'random', limit: 60, seed: 1 }],
]

for (const [name, params] of cases) {
  const t0 = Date.now()
  const r = doSearch(params)
  console.log(`${String(r.total).padStart(7)} 条 | 返回 ${r.returned} | ${Date.now() - t0}ms  ${name}`)
}
