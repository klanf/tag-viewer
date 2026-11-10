/**
 * 造一个"小库"给界面测试用(2026-11-08) —— 不是产品功能, 是测试夹具
 * ==================================================================
 * 为什么要它: UI 测试要等首页首载完成(启动遮罩退出)才能点按钮。拿真实库
 * (11 万张 / 137 MB) 喂进去, 首载要几十秒, 而且截图永远拍在遮罩上 ——
 * 断言过了但看不出界面长什么样。
 *
 * 做法: 复制全部表结构 + 维度表(tags/folders/src/meta)全量, images 只取前 N 行,
 * tag_queue 清空(那是反推排队的残留, 界面测试不需要)。
 *
 * 用法: node scripts/make-ui-fixture.mjs <源 db> <目标 db> [行数=800]
 * 被 test-nl-ui.mjs 直接 import 调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function makeSmallDb(srcDb, dstDb, limit = 800) {
  fs.mkdirSync(path.dirname(dstDb), { recursive: true })
  for (const f of [dstDb, `${dstDb}-wal`, `${dstDb}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true })
  }
  const src = new DatabaseSync(srcDb, { readOnly: true })
  const dst = new DatabaseSync(dstDb)

  // 1) 表结构 + 索引
  const objs = src.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY (type='table') DESC, name"
  ).all()
  for (const o of objs) {
    try { dst.exec(o.sql) } catch { /* 索引依赖的表还没建就跳过, 下面不会重试 */ }
  }

  const counts = {}
  // 2) 维度表全量(它们很小, 而且界面要靠它们算分类/文件夹)
  const FULL = ['tags', 'folders', 'src', 'meta']
  for (const t of FULL) {
    const has = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
    if (!has) continue
    const rows = src.prepare(`SELECT * FROM "${t}"`).all()
    insertRows(dst, t, rows)
    counts[t] = rows.length
  }
  // 3) images 只取前 N 行 —— 用主键序, 保证可复现
  const imgRows = src.prepare('SELECT * FROM images LIMIT ?').all(limit)
  insertRows(dst, 'images', imgRows)
  counts.images = imgRows.length

  src.close()
  dst.exec('PRAGMA journal_mode=DELETE')
  dst.close()
  return { path: dstDb, counts, sizeMB: +(fs.statSync(dstDb).size / 1048576).toFixed(1) }
}

function insertRows(db, table, rows) {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const ph = cols.map(() => '?').join(',')
  const st = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph})`)
  db.exec('BEGIN')
  try {
    for (const r of rows) st.run(...cols.map((c) => (r[c] === undefined ? null : r[c])))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

if (process.argv[1] && process.argv[1].endsWith('make-ui-fixture.mjs')) {
  const [, , src, dst, n] = process.argv
  if (!src || !dst) {
    console.error('用法: node scripts/make-ui-fixture.mjs <源 db> <目标 db> [行数]')
    process.exit(2)
  }
  const r = makeSmallDb(src, dst, Number(n) || 800)
  console.log(`已生成 ${r.path}  ${r.sizeMB} MB`)
  console.log('  行数:', JSON.stringify(r.counts))
}
