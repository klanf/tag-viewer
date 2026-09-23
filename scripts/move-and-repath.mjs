#!/usr/bin/env node
/**
 * move-and-repath —— 按「安全模式」口径搬图片, 并同步改库里路径
 * ================================================================
 * 与 safe-move.mjs 的区别: safe-move 只动文件, 库里的旧路径要等下次同步
 * 被标 gone=1、新路径重新入库(还可能重跑反推)。这个脚本**搬完直接 UPDATE
 * 库里的 path / folder_id**, 标签、收藏、统计全部原样跟着走, 不产生任何
 * gone 行、不重新入队。
 *
 * 判定口径 = 应用「安全模式」本身:
 *   读 data/safety.json 的 level(core|edge) + data/safety_tags.txt 的
 *   [core]/[edge] 段(支持 * 通配), 与 electron/core/safety.js 逐字同语义。
 *   一张图的标签命中敏感段 -> 留在原地; 没命中 -> 安全, 移走。
 *
 * 前提(脚本会自查):
 *   · 应用必须已关闭(库是 WAL, 独占写)。用 BEGIN IMMEDIATE 试锁兜底。
 *   · 先跑 `npm run data:backup` 备份。
 *
 * 用法(默认 dry-run):
 *   node scripts/move-and-repath.mjs --from="F:/壁纸/桌面壁纸/待分类" --to="F:/壁纸/桌面壁纸/表世界"
 *   node scripts/move-and-repath.mjs --from=... --to=... --db=<库副本> --rehearse   (彩排改库)
 *   node scripts/move-and-repath.mjs --from=... --to=... --apply
 *
 * 行为细节:
 *   · 同盘 rename(瞬时); 目标已存在同名 -> 跳过(库不动, 文件留在原地)
 *   · 库里查不到标签的文件 -> 不动(--unknown=move 可改)
 *   · 断点续跑安全: 若上次 --apply 中途死掉(文件已挪、库没改), 重跑时会
 *     识别「旧路径不存在 + 新路径存在且 size 一致」的行, 只补库不再动文件
 *   · 库更新放在**单个事务**里, 全部成功才提交
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DATA = path.join(REPO, 'data')

/* ------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}
const A = parseArgs(process.argv.slice(2))

/** 与 store.js normalizeImagePath 一致: 正斜杠 + 盘符小写 */
function norm(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    .replace(/^([A-Za-z]):/, (m, c) => `${c.toLowerCase()}:`)
}

const FROM = norm(A.from)
const TO = norm(A.to)
const APPLY = !!A.apply
/** --rehearse: 走完整 --apply 流程但**不碰任何真实文件**, 库写到哪里由 --db 决定
 *  (给库副本用, 彩排 UPDATE 语义与行数) */
const REHEARSE = !!A.rehearse
const UNKNOWN_MOVE = String(A.unknown || 'keep') === 'move'
const DB = A.db ? path.resolve(String(A.db)) : path.join(DATA, 'tags.db')
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

if (!FROM || !TO) {
  console.error('必填: --from=<来源目录> --to=<目标目录>')
  process.exit(2)
}

/* ------------------------------------------------------------ 安全口径(与 electron/core/safety.js 同语义) */

function parseSections(text) {
  const sec = { core: [], edge: [] }
  let cur = 'core'
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    if (s.startsWith('[') && s.endsWith(']')) {
      cur = s.slice(1, -1).trim().toLowerCase() === 'edge' ? 'edge' : 'core'
      continue
    }
    sec[cur].push(s.toLowerCase())
  }
  return sec
}
function compile(list) {
  const exact = new Set(); const pre = []; const suf = []; const con = []
  for (const r of list) {
    if (!r.includes('*')) exact.add(r)
    else if (r.startsWith('*') && r.endsWith('*') && r.length > 2) con.push(r.slice(1, -1))
    else if (r.startsWith('*')) suf.push(r.slice(1))
    else pre.push(r.slice(0, -1))
  }
  return { exact, pre, suf, con }
}
function hitOne(tag, part) {
  if (part.exact.has(tag)) return true
  for (const p of part.pre) if (tag.startsWith(p)) return true
  for (const p of part.suf) if (tag.endsWith(p)) return true
  for (const p of part.con) if (tag.includes(p)) return true
  return false
}
function hitAny(tags, part) {
  for (const t of String(tags).split(',').map((s) => s.trim().toLowerCase())) {
    if (t && hitOne(t, part)) return true
  }
  return false
}

let LEVEL = 'core'
try { LEVEL = JSON.parse(fs.readFileSync(path.join(DATA, 'safety.json'), 'utf8')).level || 'core' } catch { /* 默认 core */ }
const sec = parseSections(fs.readFileSync(path.join(DATA, 'safety_tags.txt'), 'utf8'))
const core = compile(sec.core)
const edge = compile(sec.edge)
/** 是否敏感: core 档只看 core 段; edge 档 core+edge 都算 */
function isSensitive(tags) {
  if (tags == null) return null
  if (hitAny(tags, core)) return true
  if (LEVEL === 'edge' && hitAny(tags, edge)) return true
  return false
}

/* ------------------------------------------------------------ 打开库(要求独占) */

let db
try {
  db = new DatabaseSync(DB) // 应用没关的话 BEGIN IMMEDIATE 这步会失败
  db.exec('BEGIN IMMEDIATE')
  db.exec('ROLLBACK') // 只是试锁, 立刻放开
} catch (e) {
  console.error('打不开库(可能应用还开着/WAL 被占用):', e.message)
  console.error('先关掉看板应用, 并确认已跑过 npm run data:backup。')
  process.exit(2)
}

const folderByPath = db.prepare('SELECT id, path, as_source, as_scan FROM folders')
const folders = folderByPath.all()
const fromFolder = folders.find((f) => norm(f.path) === FROM)
const toFolder = folders.find((f) => norm(f.path) === TO)
if (!fromFolder) { console.error('来源目录不是已登记的 folder:', FROM); process.exit(2) }
if (!toFolder) { console.error('目标目录不是已登记的 folder:', TO); process.exit(2) }

/* ------------------------------------------------------------ --repair: 只补库 */

if (A.repair) {
  // 场景: 上次 --apply 在「搬文件阶段」中途被杀 —— 文件已挪、库还没改。
  // 从库侧出发, 找「旧路径文件已不在 + 新路径存在且 size 一致」的行补库。
  // ⚠️ 不重新判定敏感口径 —— 文件已经在新位置了, 只把库指向现实。
  const rows = db.prepare('SELECT id, path, size FROM images WHERE folder_id = ? AND gone = 0').all(fromFolder.id)
  const fix = []
  let stillThere = 0
  for (const r of rows) {
    if (fs.existsSync(r.path)) { stillThere++; continue }
    const dest = norm(path.join(TO, path.basename(r.path)))
    let st
    try { st = fs.statSync(dest) } catch { continue }
    if (st.size !== r.size) { console.error('  size 不一致, 跳过:', r.path); continue }
    fix.push({ src: r.path, dest })
  }
  console.log(`repair: 库行 ${rows.length} · 文件还在原地 ${stillThere} · 可补库 ${fix.length}`)
  if (!APPLY) {
    console.log('[dry-run] 加 --apply 执行补库(配合 --repair)。')
    db.close(); process.exit(0)
  }
  const uImg = db.prepare('UPDATE images SET path = ?, folder_id = ? WHERE path = ? AND folder_id = ?')
  const uQ = db.prepare('UPDATE tag_queue SET path = ?, folder_id = ? WHERE path = ?')
  db.exec('BEGIN IMMEDIATE')
  try {
    let i = 0; let q = 0
    for (const f of fix) {
      const r = uImg.run(f.dest, toFolder.id, f.src, fromFolder.id)
      if (r.changes !== 1) throw new Error(`images 未更新: ${f.src} changes=${r.changes}`)
      i += r.changes
      q += uQ.run(f.dest, toFolder.id, f.src).changes
    }
    db.exec('COMMIT')
    console.log(`补库完成: images ${i} 行 · tag_queue ${q} 行`)
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('!!! 补库失败已回滚:', e.message)
    db.close(); process.exit(1)
  }
  db.close()
  process.exit(0)
}

const tagStmt = db.prepare('SELECT tags FROM images WHERE path = ? ORDER BY id LIMIT 1')

/* ------------------------------------------------------------ 枚举来源目录 */

function walk(dir, out = []) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) out.push(norm(full))
  }
  return out
}

const t0 = Date.now()
console.log('来源  :', FROM, `(folder #${fromFolder.id})`)
console.log('目标  :', TO, `(folder #${toFolder.id})`)
console.log('口径  :', `safety.level = ${LEVEL} · core ${sec.core.length} 条 + edge ${sec.edge.length} 条`)
console.log('模式  :', REHEARSE ? '** REHEARSE —— 彩排: 只写库副本, 文件一律不动 **'
  : APPLY ? '** APPLY —— 真的搬文件 + 改库 **' : 'dry-run(只看报告)')
console.log('')

const files = walk(FROM)
console.log(`枚举到图片 ${files.length} 张`)

const plan = []        // { src, dest, row }
const staySensitive = []
const stayUnknown = []
const conflicts = []
const reconcile = []   // 上次中断的补库项: { src, dest, row }
let bytesSafe = 0

for (const src of files) {
  // ⚠️ 必须把 join 结果再 norm 一遍: Windows 的 path.join 会产出反斜杠,
  // 而库里的 path 是「正斜杠 + 小盘符」的规范形(normalizeImagePath 口径)
  const dest = norm(path.join(TO, path.basename(src)))
  const row = tagStmt.get(src)
  const sens = isSensitive(row ? row.tags : null)
  if (sens === null) { stayUnknown.push(src); continue }
  if (sens) { staySensitive.push(src); continue }
  if (fs.existsSync(dest)) {
    // 冲突: 除非是上次中断留下的补库场景(文件已在新位置)
    const dstat = fs.statSync(dest)
    const sstat = fs.existsSync(src) ? fs.statSync(src) : null
    if (!sstat) {
      const oldRow = db.prepare('SELECT id, size FROM images WHERE path = ? ORDER BY id LIMIT 1').get(src)
      if (oldRow && oldRow.size === dstat.size) { reconcile.push({ src, dest, row: oldRow }); continue }
    }
    conflicts.push(dest); continue
  }
  try { bytesSafe += fs.statSync(src).size } catch { /* 忽略 */ }
  plan.push({ src, dest, row: tagStmt.get(src) })
}

const GB = (n) => `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
console.log('')
console.log('=== 计划 ===')
console.log(`  安全(将移动) : ${String(plan.length).padStart(6)} 张  ${GB(bytesSafe)}`)
console.log(`  补库(上次中断): ${String(reconcile.length).padStart(6)} 行`)
console.log(`  敏感(留原地) : ${String(staySensitive.length).padStart(6)} 张`)
console.log(`  库中无标签   : ${String(stayUnknown.length).padStart(6)} 张  ${UNKNOWN_MOVE ? '(按 --unknown=move 也会移)' : '(不动)'}`)
console.log(`  同名冲突跳过 : ${String(conflicts.length).padStart(6)} 张`)
for (const c of conflicts.slice(0, 10)) console.log(`      冲突: ${c}`)
if (stayUnknown.length) for (const u of stayUnknown.slice(0, 3)) console.log(`      无标签: ${u}`)

if (!APPLY && !REHEARSE) {
  console.log('\n[dry-run] 确认无误后加 --apply 真正执行。')
  console.log(`耗时 ${Date.now() - t0} ms`)
  db.close()
  process.exit(0)
}

/* ------------------------------------------------------------ APPLY: 先搬文件 */

fs.mkdirSync(TO, { recursive: true })
const moved = []      // { src, dest }
let skipped = 0
const failed = []

for (const p of plan) {
  if (REHEARSE) { moved.push(p); continue }   // 彩排: 文件不动, 直接当搬成了
  try {
    fs.renameSync(p.src, p.dest)   // 同盘(F:/ -> F:/)
    moved.push(p)
    if (moved.length % 500 === 0) console.log(`  ... 已搬 ${moved.length}`)
  } catch (e) {
    failed.push(`${p.src} -> ${e.message}`)
  }
}
if (UNKNOWN_MOVE) {
  for (const src of stayUnknown) {
    const dest = norm(path.join(TO, path.basename(src)))
    if (fs.existsSync(dest)) { conflicts.push(dest); continue }
    if (REHEARSE) { moved.push({ src, dest, row: null }); continue }
    try {
      fs.renameSync(src, dest)
      const row = tagStmt.get(src) // 无标签, 可能无行
      moved.push({ src, dest, row: row ?? null })
    } catch (e) { failed.push(`${src} -> ${e.message}`) }
  }
}
console.log('')
console.log(`文件搬运完成: 移动 ${moved.length} · 跳过 ${conflicts.length} · 失败 ${failed.length}`)
for (const f of failed.slice(0, 10)) console.log('    x', f)
if (failed.length) {
  console.error('\n有失败项 —— 库更新照做(失败的文件本来就不动库), 请检查失败原因。')
}

/* ------------------------------------------------------------ APPLY: 单事务改库 */

const updImg = db.prepare('UPDATE images SET path = ?, folder_id = ? WHERE path = ? AND folder_id = ?')
const updQ = db.prepare('UPDATE tag_queue SET path = ?, folder_id = ? WHERE path = ?')

db.exec('BEGIN IMMEDIATE')
try {
  let imgChanged = 0
  let qChanged = 0
  const problems = []
  for (const p of [...moved, ...reconcile]) {
    const r = updImg.run(p.dest, toFolder.id, p.src, fromFolder.id)
    if (r.changes !== 1) problems.push(`images 未更新(期望 1 行): ${p.src} -> changes=${r.changes}`)
    imgChanged += r.changes
    qChanged += updQ.run(p.dest, toFolder.id, p.src).changes
  }
  if (problems.length) throw new Error(`库更新异常, 回滚: ${problems.slice(0, 5).join(' | ')}`)
  db.exec('COMMIT')
  console.log(`库更新已提交: images ${imgChanged} 行 · tag_queue ${qChanged} 行`)
} catch (e) {
  db.exec('ROLLBACK')
  console.error('!!! 库更新失败已回滚:', e.message)
  console.error('文件已搬但库没改 —— 直接**重跑本脚本**即可补库(断点续跑逻辑会识别)。')
  db.close()
  process.exit(1)
}

/* ------------------------------------------------------------ 校验 */

const v = {
  fromRows: db.prepare('SELECT COUNT(*) n FROM images WHERE folder_id = ? AND gone = 0').get(fromFolder.id).n,
  toRows: db.prepare("SELECT COUNT(*) n FROM images WHERE path LIKE ? || '/%' AND gone = 0").get(TO).n,
  toRowsFolder: db.prepare('SELECT COUNT(*) n FROM images WHERE folder_id = ? AND gone = 0').get(toFolder.id).n,
  backslash: db.prepare("SELECT COUNT(*) n FROM images WHERE path LIKE '%\\\\%'").get().n,
  staleOld: db.prepare("SELECT COUNT(*) n FROM images WHERE path LIKE ? || '/%' AND gone = 0").get(FROM).n,
  diskTo: 0,
}
try { v.diskTo = fs.readdirSync(TO).filter((f) => EXTS.has(path.extname(f).toLowerCase())).length } catch { /* 忽略 */ }

console.log('')
console.log('=== 校验 ===')
console.log(`  ${FROM} 剩余库行   : ${v.staleOld} (应 = 敏感 ${staySensitive.length} + 冲突 ${conflicts.length})`)
console.log(`  ${TO} 路径行(非gone): ${v.toRows}`)
console.log(`  folder #${toFolder.id} 行(非gone) : ${v.toRowsFolder} (应 = 搬入前 + ${moved.length})`)
console.log(`  库中含反斜杠的 path: ${v.backslash} (应为 0)`)
console.log(`  ${TO} 磁盘图片数   : ${v.diskTo}`)
const checkFolder = db.prepare('SELECT id FROM folders WHERE id = ?').get(toFolder.id)
console.log(`  目标 folder 仍是 #${checkFolder.id} (as_source=${toFolder.as_source}, as_scan=${toFolder.as_scan})`)

console.log('')
console.log(`耗时 ${Date.now() - t0} ms`)
db.close()
