/**
 * `tags_*.txt` 归档 —— 把旧账从数据目录里挪走, 让 `tags.db` 成为唯一真源
 * =====================================================================
 * 为什么要挪: 阶段 1~4 之后, 库是唯一真源, txt 只剩两个害处 ——
 *   ① `syncSources` 会把「配置里已拿掉的来源」从库里 DELETE, 于是 txt 的增删
 *      会反噬数据库(见方案 §5.4);
 *   ② 启动时每次都要 stat 一遍近 100MB 的 txt, 纯属浪费。
 *
 * **硬规则: 必须一次性全部移走, 绝不能挑着移。**
 *   只移一部分 → 剩下的 txt 仍被扫到 → 被移走的那些来源会被 DELETE(破坏性)。
 *   全部移走则来源集合为空 → `syncSources` 直接 early-return「跳过同步(不清库)」,
 *   DB 一个字节都不动(由 test:nodata / test:db-safety 守着)。
 *
 * 归档 = **同目录改名移动**(不删字节)。config 的 glob 是非递归 readdirSync,
 * 所以进了子目录 App 就看不见了; 想还原把文件移回来即可。
 *
 * 跑法:
 *   node scripts/archive-legacy-txt.mjs            # 干跑, 只报告不动文件(默认)
 *   node scripts/archive-legacy-txt.mjs --apply    # 真正移动, 并写归档清单
 *   node scripts/archive-legacy-txt.mjs --undo     # 从归档目录移回原位
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const APPLY = process.argv.includes('--apply')
const UNDO = process.argv.includes('--undo')
const ARCHIVE_PREFIX = '_legacy_归档_'

/* ------------------------------------------------------------------ 环境 */

const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace } = await load('electron/core/workspace.js')
const { loadConfig } = await load('electron/core/config.js')
const store = await load('electron/core/store.js')

initWorkspace(APP_DIR)

const cfg = loadConfig()
const dir = cfg.data_files_dir
if (!dir || !fs.existsSync(dir)) {
  console.error(`✗ 配置里的 data_files_dir 读不到: ${dir || '(空)'}`)
  console.error('  请先在设置里指定「标签文件目录」, 或检查 tag_viewer_config.json。')
  process.exit(2)
}

const already = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => n.startsWith(ARCHIVE_PREFIX))
  : []

/** 升序: 只保留同目录 rename, 保证不会跨盘(跨盘 rename 在 Windows 上会失败) */
function renameInPlace(from, to) {
  fs.renameSync(from, to)
}

function sha256(fp) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(fp))
  return h.digest('hex')
}

function listTxt(d) {
  let names = []
  try { names = fs.readdirSync(d).sort() } catch { names = [] }
  return names.filter((n) => n.startsWith('tags_') && n.endsWith('.txt'))
}

/* -------------------------------------------------------------- 撤销分支 */

if (UNDO) {
  if (!already.length) {
    console.error(`✗ ${dir} 下没有 ${ARCHIVE_PREFIX}* 目录, 没什么可还原的。`)
    process.exit(2)
  }
  const archDir = path.join(dir, already[already.length - 1])
  const files = listTxt(archDir)
  if (!files.length) {
    console.error(`✗ 归档目录是空的: ${archDir}`)
    process.exit(2)
  }
  for (const f of files) renameInPlace(path.join(archDir, f), path.join(dir, f))
  try { fs.rmSync(path.join(archDir, '归档清单.json'), { force: true }) } catch {}
  try { fs.rmdirSync(archDir) } catch {}
  console.log(`✓ 已还原 ${files.length} 个标签文件 -> ${dir}`)
  console.log(`  (归档目录已清空并移除: ${path.basename(archDir)})`)
  process.exit(0)
}

/* ---------------------------------------------------------------- 干跑报告 */

const files = listTxt(dir)
if (!files.length) {
  if (already.length) {
    console.log(`✓ 数据目录里已经没有待归档的 tags_*.txt —— 归档看起来已经做过了。`)
    console.log(`  归档目录: ${already.join(', ')}`)
    console.log(`  想还原: node scripts/archive-legacy-txt.mjs --undo`)
    process.exit(0)
  }
  console.error(`✗ ${dir} 下既没有 tags_*.txt, 也没有归档目录。`)
  process.exit(2)
}

/* 与库里 src 表逐项对账 —— 库是 txt 的忠实副本才敢移走 */
const db = store.openDb()
let srcRows = []
try { srcRows = db.prepare('SELECT name,file_path,bytes,mtime_ms,records FROM src').all() } catch { srcRows = [] }
const byName = new Map(srcRows.map((r) => [r.name, r]))
store.closeDb?.()

const plan = []
let mismatched = 0
for (const name of files) {
  const fp = path.join(dir, name)
  const st = fs.statSync(fp)
  const bare = name.replace(/^tags_/, '').replace(/\.txt$/, '')
  const isAgg = name === 'tags_all.txt'          // 汇总文件, app 本就忽略, 库里没有它的行
  const r = byName.get(bare)
  let verdict
  if (isAgg) verdict = '汇总文件(app 本就忽略)'
  else if (!r) { verdict = '✗ 库里没有这个来源'; mismatched++ }
  else if (st.size !== r.bytes) { verdict = `✗ 字节数不符(库 ${r.bytes})`; mismatched++ }
  else verdict = `✓ 与库一致 ${r.records} 条`
  plan.push({ name, fp, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), db_bytes: r?.bytes ?? null, db_records: r?.records ?? null, verdict })
}

const pad = (s, n) => String(s).padStart(n)
console.log(`数据目录: ${dir}`)
console.log(`待归档:   ${files.length} 个文件, 合计 ${(plan.reduce((a, p) => a + p.bytes, 0) / 1048576).toFixed(1)} MB\n`)
console.log('  文件'.padEnd(30) + '大小'.padStart(12) + '  判定')
console.log('  ' + '-'.repeat(74))
for (const p of plan) {
  console.log('  ' + p.name.padEnd(28) + pad((p.bytes / 1048576).toFixed(1) + ' MB', 12) + '  ' + p.verdict)
}

if (mismatched) {
  console.error(`\n✗ 有 ${mismatched} 个文件与库对不上 —— 先查清楚再归档, 不要动。`)
  process.exit(1)
}

if (!APPLY) {
  console.log('\n（干跑）没有移动任何文件。确认无误后执行:')
  console.log('  node scripts/archive-legacy-txt.mjs --apply')
  console.log('\n⚠️  归档的硬规则是「9 个一起移, 不能挑着移」: 只移一部分会让被移走的来源')
  console.log('    被 syncSources 从库里 DELETE。本工具只会整批移, 不会部分移。')
  process.exit(0)
}

/* ---------------------------------------------------------------- 执行归档 */

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const archDir = path.join(dir, `${ARCHIVE_PREFIX}${stamp}`)

if (already.length) {
  console.error(`✗ 数据目录里已存在归档目录: ${already.join(', ')}`)
  console.error('  先 --undo 还原, 或手动确认后再归档(避免把两批混在一起)。')
  process.exit(2)
}

console.log(`\n开始归档 -> ${archDir}`)
fs.mkdirSync(archDir, { recursive: true })

const moved = []
try {
  for (const p of plan) {
    renameInPlace(p.fp, path.join(archDir, p.name))
    moved.push(p)
    console.log(`  ✓ ${p.name}`)
  }
} catch (e) {
  console.error(`\n✗ 移动中途失败: ${e.message}`)
  console.error(`  正在把已移走的 ${moved.length} 个文件放回原位...`)
  for (const p of moved.slice().reverse()) {
    try { renameInPlace(path.join(archDir, p.name), p.fp) } catch (e2) { console.error(`    ✗ 放回失败 ${p.name}: ${e2.message}`) }
  }
  console.error('  已尽力回滚; 请人工核对后重试。')
  process.exit(1)
}

/* 清单: 记 sha256, 任何一天想确认"归档的那份就是当年那份"都能验 */
const manifest = {
  archivedAt: new Date().toISOString(),
  fromDir: dir,
  archiveDir: archDir,
  note: '旧账标签文件。真源已是 tags.db; 这些文本仅作历史备份, 确认无需保留后可删除。',
  files: plan.map((p) => ({
    name: p.name, bytes: p.bytes, mtimeMs: p.mtimeMs, sha256: sha256(path.join(archDir, p.name)),
    srcRecords: p.db_records, srcBytes: p.db_bytes,
  })),
}
fs.writeFileSync(path.join(archDir, '归档清单.json'), JSON.stringify(manifest, null, 2))

const left = listTxt(dir)
console.log(`\n✓ 归档完成: ${moved.length} 个文件 -> ${path.basename(archDir)}/`)
console.log(`  目录里剩余 tags_*.txt: ${left.length} 个${left.length ? ' (' + left.join(', ') + ')' : ''}`)
console.log(`  清单: ${path.join(archDir, '归档清单.json')}`)
console.log('\n下一步: 重启看板确认侧栏来源仍在(来源列表已改读库, 不依赖 txt)。')
console.log(`还原: node scripts/archive-legacy-txt.mjs --undo`)
if (left.length) {
  console.error('\n⚠️  注意: 目录里仍有 tags_*.txt —— 这违反「全移」规则, 请立即核实。')
  process.exit(1)
}
