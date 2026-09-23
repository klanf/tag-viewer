/**
 * 一次性回填图片像素尺寸 (px_w / px_h)
 * =====================================
 * 卡片要按图片真实比例渲染、系列封面要挑"被裁得最少"的那张, 都得先知道每张图
 * 多宽多高。新入库的图 ingest 会自己带上尺寸, 这个脚本是给**老库**补历史的。
 *
 * 日常其实不需要它 —— ingest 每轮会顺手补 3 万张(见 ingest.js 的 DIM_FILL_MAX),
 * 多点几次「同步」也能补齐。这个脚本的价值是**一次跑完**、而且在命令行能看清
 * 数字(补了多少 / 补不到多少 / 为什么补不到)。
 *
 * 用法:
 *   node scripts/backfill-dims.mjs                     # 只统计, 一个字都不写
 *   node scripts/backfill-dims.mjs --apply             # 真的写库
 *   node scripts/backfill-dims.mjs --data-dir=<存放 tags.db 的目录>
 *
 * ⚠️ **跑之前先关掉看板**。SQLite 允许多进程写, 但这个脚本会一口气 UPDATE
 * 几万行 —— 跟应用同时写只会互相等锁, 还可能把应用的 WAL 撑大。默认只读的
 * 预演模式可以随时跑, 不影响应用。
 *
 * 只读**文件头 64KB**, 不解码像素, 所以八万张也就一分钟量级。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readImageSize } from '../electron/core/imgsize.js'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : ''
}

const ROOT = path.resolve(import.meta.dirname, '..')
const dataDir = path.resolve(argOf('--data-dir') || path.join(ROOT, 'data'))
const dbFile = path.join(dataDir, 'tags.db')

/** 一次 UPDATE 多少行就提交 —— 太大时中断会白跑一批, 太小又慢 */
const BATCH = 2000
/** 预演模式抽多少张试读, 用来估算"真跑能补上多少" */
const SAMPLE = 200

if (!fs.existsSync(dbFile)) {
  console.error(`找不到数据库: ${dbFile}`)
  console.error('用 --data-dir=<存放 tags.db 的目录> 指定位置。')
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 8000')

/* ---- 1. 确保列存在(与 store.js 的 ADDITIVE_COLS 是同一件事) ---- */
const colsOf = () => new Set(db.prepare('PRAGMA table_info(images)').all().map((r) => r.name))
let cols = colsOf()
for (const c of ['px_w', 'px_h']) {
  if (!cols.has(c)) {
    if (!APPLY) {
      console.log(`[预演] 缺列 ${c} —— --apply 时会由脚本补上(ALTER TABLE ADD COLUMN)`)
    } else {
      db.exec(`ALTER TABLE images ADD COLUMN ${c} INTEGER`)
      console.log(`已补列 ${c}`)
    }
  }
}
if (APPLY) cols = colsOf()
/* 老库 + 预演时列还不存在, 那就不能拿 px_w 去筛 —— 全部算作待回填。
 * 用变量拼 SQL 而不是 try/catch 兜语法错误: 后者会把真正的 SQL 错误也一起吞掉。 */
const hasPx = cols.has('px_w') && cols.has('px_h')
const pickWhere = hasPx ? ' WHERE px_w IS NULL' : ''

/* ---- 2. 盘点 ---- */
const g = (sql) => Number(db.prepare(sql).get()?.n || 0)
const total = g('SELECT COUNT(*) AS n FROM images')
const gone = g('SELECT COUNT(*) AS n FROM images WHERE gone = 1')
const missing = hasPx ? g('SELECT COUNT(*) AS n FROM images WHERE px_w IS NULL') : total
const hasDim = total - missing

console.log(`库文件   : ${dbFile}`)
console.log(`总行数   : ${total.toLocaleString()}`)
console.log(`已有尺寸 : ${hasDim.toLocaleString()}`)
console.log(`待回填   : ${missing.toLocaleString()}(其中已标记消失 gone=1 的 ${gone.toLocaleString()} 行磁盘上多半已不在)`)
console.log(APPLY ? '\n模式     : **写出**(--apply)' : '\n模式     : 预演(只读; 加 --apply 才写)')

if (!missing) {
  console.log('\n没有待回填的行, 收工。')
  db.close()
  process.exit(0)
}

if (!APPLY) {
  /* ---- 预演: 抽一批试读, 估算命中率与耗时 ---- */
  const rows = db.prepare(
    `SELECT id, path FROM images${pickWhere} ORDER BY id LIMIT ?`,
  ).all(SAMPLE)
  let ok = 0
  let miss = 0
  const t0 = Date.now()
  const fails = []
  for (const r of rows) {
    const s = readImageSize(r.path)
    if (s) ok++
    else { miss++; if (fails.length < 5) fails.push(r.path) }
  }
  const ms = Date.now() - t0
  const rate = rows.length ? ok / rows.length : 0
  console.log(`\n抽样试读 ${rows.length} 张: 读到 ${ok}, 读不到 ${miss}(${(rate * 100).toFixed(1)}% 命中)`)
  if (fails.length) {
    console.log('读不到的样例:')
    for (const f of fails) console.log(`  ${f}`)
  }
  console.log(`预计可补 ~${Math.round(missing * rate).toLocaleString()} 行,`
    + ` 耗时 ~${Math.round((missing * (ms / Math.max(rows.length, 1))) / 1000)} 秒`)
  console.log('\n确认无误后加 --apply 真跑(记得先关掉看板)。')
  db.close()
  process.exit(0)
}

/* ---- 3. 真跑: 分批读 + 分批写 ---- */
const upd = db.prepare('UPDATE images SET px_w = ?, px_h = ? WHERE id = ?')
const pick = db.prepare(`SELECT id, path FROM images${pickWhere} ORDER BY id LIMIT ?`)
let filled = 0
let unreadable = 0
let lastId = 0
const t0 = Date.now()

for (;;) {
  const rows = pick.all(BATCH)
  if (!rows.length) break
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const s = readImageSize(r.path)
      if (s) {
        upd.run(s[0], s[1], r.id)
        filled++
      } else {
        // 读不到(文件不在了 / 格式认不出) 写 0 = "试过了, 未知"。
        // 留 NULL 的话下轮 ingest 会把它再收进待补列表, 永远出不来。
        upd.run(0, 0, r.id)
        unreadable++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  lastId = rows[rows.length - 1].id
  const done = filled + unreadable
  const pct = ((done / missing) * 100).toFixed(1)
  process.stdout.write(`\r  已处理 ${done.toLocaleString()}/${missing.toLocaleString()} (${pct}%)`
    + ` · 补到 ${filled.toLocaleString()} · 读不到 ${unreadable.toLocaleString()}   `)
  if (rows.length < BATCH) break
}
console.log('')

const sec = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n完成, 用时 ${sec}s`)
console.log(`  写入尺寸 ${filled.toLocaleString()} 行`)
console.log(`  标记未知 ${unreadable.toLocaleString()} 行(写 0, 不会再被当成待回填)`)
const left = hasPx ? g('SELECT COUNT(*) AS n FROM images WHERE px_w IS NULL') : 0
console.log(`  剩余待回填 ${left.toLocaleString()} 行`)
if (lastId) console.log(`  (本批处理到的最大 id: ${lastId})`)
console.log('\n回到看板点一次「同步」即可让新尺寸生效(数据已经落库, 只是内存里的数据集需要重载)。')

db.close()
