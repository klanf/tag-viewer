/**
 * 后端核心自检 —— 不启动 Electron, 直接用系统 Node 跑数据集加载与各查询,
 * 把关键数字打出来, 用于和 Python 版逐项对账。
 * 用法: node scripts/selftest.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 这里直接给它一个 userData; 里面没有 settings.json 时 workspace 会退回 TV_DATA_DIR,
// 所以先把 TV_DATA_DIR 定到本机数据目录(优先级: 环境变量 > local.config.json > 仓库内 data/)。
// 改造前这里写死的是原 Python 目录 —— 那个目录现在其实已经空了, 属于过期默认值。
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace } = await import(pathToFileURL(path.join(ROOT, 'electron/core/workspace.js')).href)
initWorkspace(path.join(ROOT, '.selftest-userdata'))

const { loadConfig, resolveDataFiles } = await import(pathToFileURL(path.join(ROOT, 'electron/core/config.js')).href)
const { loadDataset, ds, tagPoolSize } = await import(pathToFileURL(path.join(ROOT, 'electron/core/dataset.js')).href)
const { loadTranslations, translateInfo } = await import(pathToFileURL(path.join(ROOT, 'electron/core/translate.js')).href)
const { getStats, doSearch, getSeries, getCharacters, getSuggest, getAllTags, getLightboxData, getTagsForPath } = await import(pathToFileURL(path.join(ROOT, 'electron/core/query.js')).href)
const { buildExport } = await import(pathToFileURL(path.join(ROOT, 'electron/core/exporter.js')).href)
const { searchStats } = await import(pathToFileURL(path.join(ROOT, 'electron/core/search.js')).href)
const { loadBgConfig, loadReplaceRules, blacklistRules } = await import(pathToFileURL(path.join(ROOT, 'electron/core/rules.js')).href)

const out = {}
const cfg = loadConfig()
const dataFiles = resolveDataFiles(cfg, null)
console.log('数据文件:')
for (const [n, f] of dataFiles) console.log(`  [${n}] ${f}`)

const t0 = Date.now()
const st = await loadDataset(dataFiles, () => {})
const loadMs = Date.now() - t0
out.dataset = st
out.tagPool = tagPoolSize()
console.log('\n=== 数据集 ===')
console.log(`  图片数   : ${st.records.toLocaleString()}`)
console.log(`  不同标签 : ${st.tags.toLocaleString()}`)
console.log(`  系列数   : ${st.series.toLocaleString()}`)
console.log(`  标签池   : ${st.tagsInPool.toLocaleString()}`)
console.log(`  解析+索引: ${loadMs} ms`)
console.log(`  内存     : rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB / heapUsed ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`)

const ti = loadTranslations(cfg.translate_dir || '')
console.log('\n=== 翻译库 ===')
const tiFull = translateInfo()
console.log(`  WeiLin: ${ti.weilin} 条 / 本地补译文件: ${ti.local} 条(新增 ${ti.localAdded})`)
console.log(`  合计  : ${tiFull.total} 条`)
// 目录来源要说清楚 —— 否则"翻译怎么只剩一半"这种问题没法从输出里看出来
console.log(`  目录  : [${tiFull.dirSource}] ${tiFull.dirs.join(' | ') || '（没找到）'}`)
if (tiFull.dirMissing) console.log(`  ⚠ 配置里的 translate_dir 不存在: ${tiFull.dirWanted}`)
else if (cfg.translate_dir) console.log(`  (配置指定: ${cfg.translate_dir})`)
else console.log('  (配置留空 → 自动在数据目录里找 weilin_data*)')

out.translate = ti

console.log('\n=== 规则文件 ===')
const bl = blacklistRules()
const rp = loadReplaceRules()
const bg = loadBgConfig()
console.log(`  黑名单规则: ${bl.length} 条`)
console.log(`  替换规则  : ${rp.length} 条`)
console.log(`  背景关键词: ${bg.kw.length} 条 / 补全标签: ${bg.append.length} 条`)
out.rules = { blacklist: bl.length, replace: rp.length, bgKw: bg.kw.length, bgAppend: bg.append.length }

console.log('\n=== 统计 /api/stats ===')
const t1 = Date.now()
const stats = getStats({})
console.log(`  total_images: ${stats.total_images}  total_tags: ${stats.total_tags}  total_series: ${stats.total_series}  (${Date.now() - t1} ms)`)
console.log(`  top5 标签  : ${stats.top_tags.slice(0, 5).map((x) => `${x.tag}=${x.count}`).join(', ')}`)
console.log(`  top5 系列  : ${stats.top_series.slice(0, 5).map((x) => `${x.tag}=${x.count}`).join(', ')}`)
console.log(`  来源       : ${stats.sources.map((s) => `${s.name}=${s.images}`).join(', ')}`)
out.stats = { images: stats.total_images, tags: stats.total_tags, series: stats.total_series, sources: stats.sources }

console.log('\n=== 搜索 /api/search ===')
const cases = [
  { label: '空(全部)', q: {} },
  { label: 'q=1girl', q: { q: '1girl', limit: 60 } },
  { label: 'q=blue_archive mode=all', q: { q: 'blue_archive', mode: 'all', limit: 60 } },
  { label: 'q=hoshino match=exact', q: { q: 'hoshino', match: 'exact', limit: 60 } },
  { label: 'q=1girl + exclude=red_hair', q: { q: '1girl', exclude: 'red hair', limit: 60 } },
  { label: 'q=1girl sort=random seed=42', q: { q: '1girl', sort: 'random', seed: 42, limit: 60 } },
  { label: 'q=不存在的标签xyz', q: { q: 'zzz_nonexistent_tag_zzz', limit: 60 } },
]
out.search = []
for (const c of cases) {
  const t = Date.now()
  const r = doSearch(c.q)
  const ms = Date.now() - t
  console.log(`  ${c.label.padEnd(34)} -> total ${String(r.total).padStart(5)}  returned ${String(r.returned).padStart(3)}  ${ms} ms`)
  out.search.push({ ...c, total: r.total, returned: r.returned, ms })
}
console.log('  搜索缓存:', JSON.stringify(searchStats()))

console.log('\n=== 排序一致性(seed=42 两次结果应一致) ===')
const a = doSearch({ q: '1girl', sort: 'random', seed: 42, limit: 10 }).results.map((r) => r.path)
const b = doSearch({ q: '1girl', sort: 'random', seed: 42, limit: 10 }).results.map((r) => r.path)
console.log('  可复现:', JSON.stringify(a) === JSON.stringify(b) ? 'OK' : '失败')
out.seedStable = JSON.stringify(a) === JSON.stringify(b)

console.log('\n=== 系列 /api/series ===')
const t2 = Date.now()
const se = getSeries({})
console.log(`  total: ${se.total}  分类汇总: ${JSON.stringify(se.categories)}  (${Date.now() - t2} ms)`)
console.log(`  top5: ${se.series.slice(0, 5).map((s) => `${s.name}(${s.images}图/${s.characters}角/${s.category})`).join(', ')}`)
const custom = se.series.filter((s) => s.custom).length
console.log(`  自定义系列: ${custom}`)
out.series = { total: se.total, categories: se.categories, custom, ms: Date.now() - t2, top5: se.series.slice(0, 5) }

const topSeries = se.series[0]
console.log(`\n=== 角色 /api/characters?series=${topSeries.name} ===`)
const ch = getCharacters({ series: topSeries.name })
console.log(`  total: ${ch.total}`)
console.log(`  top3: ${ch.characters.slice(0, 3).map((c) => `${c.tag}(${c.images})`).join(', ')}`)
out.characters = { series: topSeries.name, total: ch.total, top3: ch.characters.slice(0, 3) }

console.log('\n=== 补全 /api/suggest ===')
for (const kw of ['blue', 'a', '蔚蓝']) {
  const t = Date.now()
  const r = getSuggest({ q: kw, limit: 12 })
  console.log(`  q=${kw.padEnd(6)} -> ${r.suggestions.length} 条  ${Date.now() - t} ms  ${r.suggestions.slice(0, 3).map((s) => `${s.tag}${s.zh ? '/' + s.zh : ''}(${s.count})`).join(', ')}`)
}

console.log('\n=== 全量标签 /api/alltags ===')
const t3 = Date.now()
const at = getAllTags({ limit: 120 })
console.log(`  total: ${at.total}  returned ${at.returned}  (${Date.now() - t3} ms)`)
console.log(`  被 ban 的前 3 条: ${at.tags.filter((x) => x.banned).slice(0, 3).map((x) => `${x.tag}<-${x.ban_rule}`).join(', ') || '(无)'}`)
console.log(`  带中文的前 3 条: ${at.tags.filter((x) => x.zh).slice(0, 3).map((x) => `${x.tag}=${x.zh}`).join(', ') || '(无)'}`)
out.alltags = { total: at.total, ms: Date.now() - t3, bannedShown: at.tags.filter((x) => x.banned).length, zhShown: at.tags.filter((x) => x.zh).length }

console.log('\n=== lightbox 数据 ===')
const samplePath = doSearch({ q: '1girl', limit: 1 }).results[0]?.path
console.log(`  样本: ${samplePath}`)
const lb = getLightboxData({ path: samplePath })
console.log(`  角色标签 ${lb.char_tags?.length} / 系列 ${JSON.stringify(lb.series)} / 全部标签 ${lb.all_tags?.length} / needs_bg=${lb.needs_bg}`)
out.lightbox = { path: samplePath, chars: lb.char_tags?.length, series: lb.series, tags: lb.all_tags?.length, needsBg: lb.needs_bg }

const tg = getTagsForPath({ path: samplePath })
console.log(`  /api/tags 标签数: ${tg.tags?.length}  ban_map 条数: ${Object.keys(tg.ban_map || {}).length}`)

console.log('\n=== 导出 ===')
const e1 = buildExport({ q: '1girl', limit: 60 })
console.log(`  纯标签: ${e1.count} 行 / ${e1.blocked} 个被 ban / ${e1.replaced} 次替换 / ${e1.bgAdded} 个补背景 / ${(Buffer.byteLength(e1.text) / 1048576).toFixed(2)} MB / ${e1.ms} ms`)
console.log(`  首行: ${e1.text.split('\n')[0].slice(0, 140)}`)
const e2 = buildExport({ q: '1girl', with_path: '1' })
console.log(`  带路径: ${e2.count} 行, 首行: ${e2.text.split('\n')[0].slice(0, 140)}`)
out.export = { plain: { count: e1.count, blocked: e1.blocked, replaced: e1.replaced, bgAdded: e1.bgAdded, ms: e1.ms }, withPath: e2.count }

console.log('\n=== 按来源过滤 ===')
for (const s of stats.sources.slice(0, 3)) {
  const r = doSearch({ q: '', source: s.name, limit: 1 })
  const stt = getStats({ source: s.name })
  console.log(`  ${s.name.padEnd(8)} -> search total ${r.total}, stats images ${stt.total_images}, tags ${stt.total_tags}`)
}
out.bySource = stats.sources.map((s) => ({ name: s.name, listed: s.images, searchTotal: doSearch({ source: s.name, limit: 1 }).total, statsImages: getStats({ source: s.name }).total_images }))

console.log('\n=== 汇总 JSON ===')
console.log(JSON.stringify(out, null, 2).slice(0, 4000))
