/**
 * 标签库(tags.db)维护脚本
 * =========================
 *   node scripts/db.mjs info            看库里有什么(来源、条数、体积)
 *   node scripts/db.mjs import [--force]  把配置里的 tags_*.txt 同步进库
 *   node scripts/db.mjs export [目录]      把库里的数据写回 tags_*.txt
 *   node scripts/db.mjs reset           删库重建(下次启动会重新导入)
 *   node scripts/db.mjs verify          与 txt 逐条比对(校验导入无损)
 *
 * 平时**不需要跑这个** —— 应用启动时会自动同步(指纹没变就是空转)。
 * 只有"改了 txt 想立刻生效"或"想验证库与 txt 一致"时才手动跑。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { initWorkspace } = await load('electron/core/workspace.js')
const { loadConfig, resolveDataFiles } = await load('electron/core/config.js')
const store = await load('electron/core/store.js')
const { streamTagFile } = await load('electron/core/tagfile.js')

// 与真实应用用同一个 userData(这样能读到 settings.json 里改过的 dataDir);
// 没有 settings 或里面没写 dataDir 时, 回落到 TV_DATA_DIR / 本机 local.config.json / 仓库内 data/。
const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()
initWorkspace(APP_DIR)
const cfg = loadConfig()
const dataFiles = resolveDataFiles(cfg)

const cmd = (process.argv[2] || 'info').toLowerCase()
const arg = process.argv[3]

function mb(n) { return (n / 1048576).toFixed(1) + ' MB' }
function line(s = '') { console.log(s) }

if (cmd === 'info') {
  const info = store.dbInfo()
  line(`库文件 : ${info.path}`)
  if (info.error) { line(`状态   : 读取失败 -> ${info.error}`); process.exit(0) }
  line(`体积   : ${mb(info.bytes)}${info.walBytes ? ` (+WAL ${mb(info.walBytes)})` : ''}`)
  line(`来源数 : ${info.sources}`)
  line(`图片数 : ${info.images}`)
  line(`标签数 : ${info.tags} (其中角色标签 ${info.charTags})`)
  line()
  line('来源明细:')
  for (const s of info.sourceList || []) {
    line(`  ${String(s.name).padEnd(16)} ${String(s.records).padStart(7)} 条   txt ${mb(s.bytes).padStart(9)}   导入于 ${new Date(s.imported_at).toLocaleString('zh-CN')}`)
  }
  line()
  line('配置里的 txt 源:')
  for (const [name, fp] of dataFiles) {
    const ok = fs.existsSync(fp)
    line(`  ${name.padEnd(16)} ${ok ? '' : '(读不到) '}${fp}`)
  }
}

if (cmd === 'import') {
  const force = arg === '--force' || process.argv.includes('--force')
  if (force) { store.resetDb(); line('已清库, 开始全量导入...') }
  const t0 = Date.now()
  const r = await store.syncSources(dataFiles, (p) => {
    if (p.note) process.stdout.write(`\r  ${p.note}`.padEnd(70))
  })
  process.stdout.write('\r'.padEnd(71) + '\r')
  line(`导入完成: 新导入 [${r.imported.join(', ') || '无'}] / 跳过 [${r.skipped.join(', ') || '无'}] / 移除 [${r.removed.join(', ') || '无'}]`)
  line(`耗时 ${Date.now() - t0} ms`)
  const info = store.dbInfo()
  line(`库内现有 ${info.images} 张 / ${info.tags} 个标签, 体积 ${mb(info.bytes)}`)
}

if (cmd === 'export') {
  const dir = arg && !arg.startsWith('--') ? arg : undefined
  const t0 = Date.now()
  const r = store.exportToTxt(dir, (p) => { if (p.source) process.stdout.write(`\r  已写 ${p.source}: ${p.records} 条`.padEnd(70)) })
  process.stdout.write('\r'.padEnd(71) + '\r')
  line(`已导出到 ${r.dir}`)
  for (const w of r.written) line(`  tags_${w.name}.txt  ${w.records} 条`)
  line(`耗时 ${Date.now() - t0} ms`)
}

if (cmd === 'reset') {
  const r = store.resetDb()
  line(`已删除 ${r.path} (及其 WAL/SHM)；下次启动会自动从 txt 重建`)
}

if (cmd === 'verify') {
  // 从库里读出来, 与直接解析 txt 的结果逐条比对 —— 证明导入没有丢/改数据
  const bySrc = new Map()
  store.readRecords((rec) => {
    if (!bySrc.has(rec.source)) bySrc.set(rec.source, [])
    bySrc.get(rec.source).push({ path: rec.path, tags: rec.tags.join('\u0001') })
  })
  let total = 0, mismatch = 0
  for (const [name, fp] of dataFiles) {
    if (!fs.existsSync(fp)) { line(`跳过 ${name}: txt 读不到`); continue }
    const a = bySrc.get(name) || []
    const b = []
    await streamTagFile(fp, (rec) => b.push({ path: rec.path, tags: rec.tags.join('\u0001') }))
    total += b.length
    const same = a.length === b.length && a.every((x, i) => x.path === b[i].path && x.tags === b[i].tags)
    if (!same) {
      mismatch++
      line(`✗ ${name}: 库 ${a.length} 条 / txt ${b.length} 条`)
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (!a[i] || !b[i] || a[i].path !== b[i].path || a[i].tags !== b[i].tags) {
          line(`    第 ${i + 1} 条不同:`)
          line(`      库 : ${a[i] ? a[i].path + ' | ' + a[i].tags.slice(0, 120) : '(缺)'}`)
          line(`      txt: ${b[i] ? b[i].path + ' | ' + b[i].tags.slice(0, 120) : '(缺)'}`)
          break
        }
      }
    } else {
      line(`✓ ${name}: ${b.length} 条逐条一致`)
    }
  }
  line(mismatch ? `\n有 ${mismatch} 个来源不一致` : `\n全部一致(共 ${total} 条)`)
  process.exit(mismatch ? 1 : 0)
}

store.closeDb()
