/**
 * 数据目录自查 —— data/ 的布局与库结构是否合规矩
 * ================================================
 * 守三类问题:
 *   ① 该搬没搬: 已在 paths.js 路由表里登记、但还躺在 data/ 根目录的文件
 *      (兼容期回退让它们"还能用", 所以不修也不会报错 —— 正因为不报错, 才要主动查)
 *   ② 不认识的条目: 既没登记、又不是刻意留根的, 出现在根目录或子目录里
 *      (可能是新的临时产物, 也可能是有人手工塞进来的东西)
 *   ③ 库结构: schema 版本 / folders 登记表 / 路径是否已规范化 / 有无无效 folders 行
 *
 * 用法:
 *   node scripts/data-lint.mjs             # 报告(有问题时退出码 1)
 *   node scripts/data-lint.mjs --quiet     # 只在有问题时输出
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const QUIET = process.argv.includes('--quiet')

const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace, getWorkspace } = await load('electron/core/workspace.js')
const P = await load('electron/core/paths.js')
const store = await load('electron/core/store.js')

initWorkspace(APP_DIR)
const { dataDir } = getWorkspace()

const problems = []
const notes = []
const say = (s = '') => { if (!QUIET) console.log(s) }

/** 刻意留在 data/ 根的条目 —— 与 paths.js 的路由注释同源 */
const ROOT_OK = new Set([
  'tags.db', 'tags.db-shm', 'tags.db-wal',
  'tag_viewer_config.json',
  'tags.db.bak-20260920', 'tags.db.bak-pre-v2', 'tags.db.bak-v1',   // 备份: 名字带日期, 单独放行
])
const ROOT_OK_PREFIX = ['tags.db.bak-', 'tag_viewer_config.example.json']

const isRootOk = (name) => ROOT_OK.has(name) || ROOT_OK_PREFIX.some((p) => name.startsWith(p))

say(`数据目录: ${dataDir}`)
say('')

if (!fs.existsSync(dataDir)) {
  console.log(`✗ 数据目录不存在: ${dataDir}`)
  process.exit(1)
}

const entries = fs.readdirSync(dataDir, { withFileTypes: true })
const subdirs = new Set(Object.values(P.DATA_SUBDIRS))

say('=== 目录结构 ===')
const seenDirs = []
for (const e of entries) {
  if (!e.isDirectory()) continue
  seenDirs.push(e.name)
  const routed = P.dataRelPath(e.name)
  if (subdirs.has(e.name)) { say(`  ✓ ${e.name}/  (规范子目录)`); continue }
  if (routed !== e.name) {
    problems.push(`目录「${e.name}」按路由表应搬到 ${routed} —— 还在根目录`)
    say(`  ✗ ${e.name}/  应搬到 ${routed}`)
  } else if (isRootOk(e.name)) {
    say(`  · ${e.name}/  (刻意留根)`)
  } else {
    problems.push(`目录「${e.name}」既不是规范子目录、也没有路由登记 —— 出现在根目录`)
    say(`  ? ${e.name}/  未登记`)
  }
}

say('')
say('=== 根目录文件 ===')
for (const e of entries) {
  if (e.isDirectory()) continue
  const routed = P.dataRelPath(e.name)
  if (routed !== e.name) {
    problems.push(`文件「${e.name}」按路由表应搬到 ${routed} —— 还在根目录(兼容期回退能读, 但不算迁完)`)
    say(`  ✗ ${e.name}  应搬到 ${routed}`)
  } else if (isRootOk(e.name)) {
    say(`  ✓ ${e.name}  (刻意留根)`)
  } else {
    problems.push(`文件「${e.name}」未登记路由, 也不在允许留根的名单里`)
    say(`  ? ${e.name}  未登记`)
  }
}

say('')
say('=== 子目录内容 ===')
for (const d of subdirs) {
  const p = path.join(dataDir, d)
  if (!fs.existsSync(p)) { say(`  · ${d}/  不存在(还没用到)`); continue }
  const inner = fs.readdirSync(p)
  say(`  ✓ ${d}/  ${inner.length} 项: ${inner.slice(0, 6).join(', ')}${inner.length > 6 ? ' …' : ''}`)
  // 反向检查: 登记到别的子目录的文件不该出现在这里
  for (const name of inner) {
    const want = P.dataRelPath(name)
    if (want !== name && !want.startsWith(d + '/')) {
      problems.push(`「${d}/${name}」按路由表应在 ${want} —— 放错子目录了`)
      say(`    ✗ ${name} 应在 ${want}`)
    }
  }
}

say('')
say('=== 数据库 ===')
const dbFile = path.join(dataDir, 'tags.db')
if (!fs.existsSync(dbFile)) {
  notes.push('没有 tags.db(还没导入过数据)')
  say('  · 没有 tags.db')
} else {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
  const ver = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0)

  if (ver >= 2 && has('folders')) say(`  ✓ schema_version = ${ver}, folders 表存在`)
  else problems.push(`schema_version = ${ver}${has('folders') ? '' : ', folders 表缺失'} —— 迁移没跑完?`)

  if (has('images')) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM images').get().n
    const notNorm = db.prepare("SELECT COUNT(*) AS n FROM images WHERE path LIKE '%\\%'").get().n
    if (notNorm === 0) say(`  ✓ ${total} 条路径全部已规范化(无混写分隔符)`)
    else problems.push(`${notNorm} 条路径未规范化(含反斜杠) —— 差集比对会冒出假新增`)

    const cols = new Set(db.prepare('PRAGMA table_info(images)').all().map((r) => r.name))
    const wantCols = ['folder_id', 'mtime_ms', 'size', 'tags_src', 'gone', 'tagged_at']
    const missing = wantCols.filter((c) => !cols.has(c))
    if (!missing.length) say(`  ✓ images 的 v2 列齐全`)
    else problems.push(`images 缺列: ${missing.join(', ')}`)

    const bySrc = db.prepare("SELECT COALESCE(tags_src,'(空)') AS k, COUNT(*) AS n FROM images GROUP BY k").all()
    say(`  · tags_src 分布: ${bySrc.map((r) => `${r.k}=${r.n}`).join(', ')}`)
    const noSrc = bySrc.find((r) => r.k === '(空)')
    if (noSrc) problems.push(`${noSrc.n} 行没有 tags_src —— 迁移未覆盖`)
  }

  if (has('folders')) {
    const fs_ = db.prepare('SELECT * FROM folders ORDER BY id').all()
    say(`  · folders ${fs_.length} 条 (看板来源 ${fs_.filter((f) => f.as_source).length} / 扫描夹 ${fs_.filter((f) => f.as_scan).length})`)
    for (const f of fs_) {
      if (!f.as_source && !f.as_scan) problems.push(`folders「${f.label || f.path}」两个用途都是 0 —— 登记了却不用于任何地方`)
      if (f.path.includes('\\')) problems.push(`folders「${f.label || f.path}」的 path 未规范化: ${f.path}`)
    }
    const orphan = db.prepare('SELECT COUNT(*) AS n FROM images WHERE folder_id IS NULL').get().n
    if (orphan) notes.push(`${orphan} 行 images 没有 folder_id 归属`)
    say(`  · 无归属图片: ${orphan} 行`)
  }
  db.close()
}

say('')
if (notes.length) {
  say('=== 提示(不算问题) ===')
  for (const n of notes) say(`  · ${n}`)
  say('')
}

if (problems.length) {
  console.log(`✗ data:lint 发现 ${problems.length} 处问题:`)
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}
console.log('✓ data:lint 通过: 目录布局与库结构都合规矩')
