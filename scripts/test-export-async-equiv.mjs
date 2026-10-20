// 验证: buildExport(同步)与 buildExportAsync(分片异步)输出完全一致(2026-10-20 卡死修复)
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace } = await import(pathToFileURL(path.join(ROOT, 'electron/core/workspace.js')).href)
initWorkspace(path.join(ROOT, '.selftest-userdata'))
const { loadConfig, resolveDataFiles } = await import(pathToFileURL(path.join(ROOT, 'electron/core/config.js')).href)
const { loadDataset } = await import(pathToFileURL(path.join(ROOT, 'electron/core/dataset.js')).href)
const { buildExport, buildExportAsync } = await import(pathToFileURL(path.join(ROOT, 'electron/core/exporter.js')).href)

await loadDataset(resolveDataFiles(loadConfig(), null), () => {})

let fails = 0
const ok = (c, n) => { console.log(c ? `  ok  ${n}` : `FAIL  ${n}`); if (!c) fails++ }

for (const q of [
  { q: '1girl', limit: 500 },
  { q: '1girl', replace: '1', blacklist: '1', bg: '1', seg_mode: '1', with_path: '1' },
  { q: 'genshin_impact', replace: '1', safe_only: '1', safe_level: 'edge' },
]) {
  const a = buildExport(q)
  const b = await buildExportAsync(q, { chunk: 37 })
  const same = a.text === b.text && a.count === b.count && a.blocked === b.blocked
    && a.replaced === b.replaced && a.bgAdded === b.bgAdded && a.segStripped === b.segStripped
    && a.stripped === b.stripped && a.suggestedName === b.suggestedName
  ok(same, `输出一致 (${a.count} 行, replaced=${a.replaced}, segStripped=${a.segStripped})`)
}

process.exit(fails ? 1 : 0)
