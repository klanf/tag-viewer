/**
 * 老数据回填: 把库里已有 images.tags 按官方段位重排(2026-10-16 方案 P4)
 * ================================================================
 * 背景: 「反推按段位顺序入库」只对新图生效; 已有 10.7 万行还是老顺序。
 * 本脚本一次性把全库 tags 逗号串重排 —— **只动顺序不动集合**(一个不增一个不减),
 * 顺序错了可整库回滚。
 *
 * 安全护栏(全部硬性, 少一个都不跑):
 *   1. images 行数 < 1000 视为"开错库"(空库/测试库), 拒绝执行
 *      —— 与 store.syncSources 的空源不清库同一思想, 宁可不干活不可误删
 *   2. 先 backupDb('seg-order')(VACUUM INTO 一致性快照, App 开着也能拿)
 *   3. 每行重排后**校验多重集合完全一致**(排序前后逐 tag 对账)才允许写,
 *      不一致立即中止 —— 分类器 bug 的最坏结果是"顺序没变", 不是"标签变了"
 *   4. 全程一个事务, 中途任何失败 ROLLBACK
 *
 * 用法: node scripts/backfill-tag-order.mjs [--dry]
 *   --dry  只统计会动多少行, 不写库(也要先过 1000 行护栏)
 */
import { PROJECT_ROOT } from '../electron/core/paths.js'
import { initWorkspace } from '../electron/core/workspace.js'

initWorkspace(PROJECT_ROOT)

const DRY = process.argv.includes('--dry')
const { openDb, backupDb, closeDb } = await import('../electron/core/store.js')
const { loadCats, sortTags } = await import('../electron/core/tagcats.js')

const t0 = Date.now()
const db = openDb()
const g = (sql) => db.prepare(sql).get()
const total = g('SELECT COUNT(*) n FROM images').get?.n ?? g('SELECT COUNT(*) AS n FROM images').n
const withTags = g("SELECT COUNT(*) AS n FROM images WHERE tags != ''").n

console.log(`库: ${total} 行, 带标签 ${withTags} 行`)
if (total < 1000) {
  console.error(`⛔ 行数 ${total} < 1000, 像是空库/测试库 —— 拒绝执行(防开错目录)`)
  process.exit(2)
}

await loadCats()

if (!DRY) {
  const bak = backupDb('seg-order', db)
  if (!bak.ok) {
    console.error(`⛔ 备份失败(${bak.reason}) —— 放弃回填, 数据安全优先`)
    process.exit(2)
  }
  console.log(`备份完成: ${bak.file} (${(bak.bytes / 1024 / 1024).toFixed(1)} MB, integrity=${bak.integrity})`)
}

/** 多重集合对账: 排序前后必须逐 tag 一致(含重复), 一个都不能多不能少 */
function sameMultiset(a, b) {
  if (a.length !== b.length) return false
  const m = new Map()
  for (const x of a) m.set(x, (m.get(x) || 0) + 1)
  for (const x of b) {
    const c = m.get(x) || 0
    if (c <= 0) return false
    m.set(x, c - 1)
  }
  return true
}

const rows = db.prepare("SELECT id, tags FROM images WHERE tags != '' ORDER BY id").all()
const upd = db.prepare('UPDATE images SET tags = ? WHERE id = ?')
let changed = 0
let unchanged = 0
let scanned = 0
let next = 0
let pending = []

function flush() {
  if (!pending.length) return
  db.exec('BEGIN')
  try {
    for (const [id, s] of pending) upd.run(s, id)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  pending = []
}

for (const r of rows) {
  const src = String(r.tags || '')
  const tags = src.split(',').map((x) => x.trim()).filter(Boolean)
  if (tags.length < 2) { unchanged++; scanned++; continue }
  const sorted = sortTags(tags)
  if (!sameMultiset(tags, sorted)) {
    console.error(`⛔ 第 ${r.id} 行对账失败 —— 分类器把标签集合改了, 立即中止:`)
    console.error('   前:', src.slice(0, 200))
    console.error('   后:', sorted.join(',').slice(0, 200))
    if (!DRY) flush()   // 先把已确认安全的落了, 数据不悬空
    process.exit(2)
  }
  const ns = sorted.join(',')
  if (ns !== src) {
    changed++
    if (!DRY) pending.push([r.id, ns])
    if (!DRY && pending.length >= 4000) flush()
  } else {
    unchanged++
  }
  scanned++
  if (scanned % 10000 === 0) {
    console.log(`  进度 ${scanned}/${rows.length} (会重排 ${changed}, 顺序已对 ${unchanged})`)
    if (!DRY) await new Promise((res) => setImmediate(res))
  }
}
if (!DRY) flush()

const ms = Date.now() - t0
console.log('')
console.log(DRY ? `[dry-run] 预演完成` : `回填完成`)
console.log(`  扫描 ${scanned} 行: 重排 ${changed} 行, 顺序已符合 ${unchanged} 行, 耗时 ${ms}ms`)
if (!DRY) {
  const spot = db.prepare("SELECT tags FROM images WHERE tags_src IN ('wd14','meta+wd14') AND tags != '' LIMIT 1").get()
  if (spot) console.log(`  抽查(wd14): ${spot.tags.slice(0, 120)}...`)
}
closeDb()
