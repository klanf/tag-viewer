#!/usr/bin/env node
/**
 * safe-move —— 把某个来源目录里「不含敏感标签」的图挑出来，移到另一个文件夹
 * ============================================================================
 * 独立脚本，**不依赖 Electron**，与应用完全解耦（用户明确要求不在应用里做）。
 *
 * 判定依据: tags.db 里每张图的标签串。一张图的标签里**命中任一敏感标签** -> 判为敏感,
 * 留在原地; 否则判为安全, 待移动。
 *
 * 用法(默认 dry-run, 只看报告不动文件):
 *   node scripts/safe-move.mjs --from="<某个已登记的来源目录>"
 *   node scripts/safe-move.mjs --from="..." --to="..." --level=core
 *   node scripts/safe-move.mjs --from="..." --to="..." --level=core --apply
 *
 * 参数:
 *   --from=<目录>        必填。要筛选的来源目录（递归）
 *   --to=<目录>          目标目录; dry-run 可省略
 *   --level=strict|core|edge   敏感口径预设, 默认 core
 *                          strict = 只认 rating_explicit 这类显式标记(实测你库里是 0 张)
 *                          core   = 裸露 / 性行为 / 性器官
 *                          edge   = core + 擦边(泳装、内衣、大腿袜…)
 *   --tags=a,b,c         自定义敏感标签(给就用它, 忽略 --level)
 *   --extra=a,b,c        在 --level 基础上追加敏感标签
 *   --except=a,b,c       在 --level 基础上剔除(把误判的标签移出口径)
 *   --unknown=keep|move  库里查不到标签的文件怎么算, 默认 keep(不动)
 *   --flat               目标目录里拍平(不保留相对子目录结构)
 *   --apply              真正执行移动(不加就是 dry-run)
 *   --db=<path>          指定库路径, 默认 <repo>/data/tags.db
 *
 * 安全设计:
 *   · 默认 dry-run; --apply 才动文件
 *   · 目标已存在同名文件 -> **跳过并列出**, 绝不覆盖
 *   · 同一分区内用 rename(瞬时, 不重写数据); 跨分区才 copy+删除
 *   · 只读打开数据库副本, 不碰正在被应用使用的库
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

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
const list = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

/** 与 store.js normalizeImagePath 保持一致的路径写法: 正斜杠 + 盘符小写 */
function norm(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    .replace(/^([A-Za-z]):/, (m, c) => `${c.toLowerCase()}:`)
}

const LEVELS = {
  strict: ['rating_explicit', 'rating_questionable', 'explicit', 'nsfw'],
  core: [
    'rating_explicit', 'rating_questionable', 'explicit', 'nsfw',
    'nude', 'naked', 'nipples', 'areola', 'sex', 'pussy', 'penis', 'cum',
    'fellatio', 'oral', 'anal', 'masturbation', 'censored', 'pubic_hair', 'sex_toy',
  ],
  edge: [
    'rating_explicit', 'rating_questionable', 'explicit', 'nsfw',
    'nude', 'naked', 'nipples', 'areola', 'sex', 'pussy', 'penis', 'cum',
    'fellatio', 'oral', 'anal', 'masturbation', 'censored', 'pubic_hair', 'sex_toy',
    'cleavage', 'underwear', 'panties', 'swimsuit', 'bikini', 'ass', 'topless',
    'bottomless', 'cameltoe', 'spread_legs', 'ahegao', 'suggestive', 'see-through',
    'underboob', 'sideboob', 'lingerie', 'garter_belt', 'thighhighs',
  ],
}

const levelName = A.tags ? 'custom' : String(A.level || 'core')
if (!A.tags && !LEVELS[levelName]) {
  console.error(`未知的 --level=${levelName}（可选: strict / core / edge）`)
  process.exit(2)
}
let SENSITIVE = A.tags ? list(A.tags) : [...LEVELS[levelName]]
if (A.extra) SENSITIVE = [...new Set([...SENSITIVE, ...list(A.extra)])]
if (A.except) {
  const drop = new Set(list(A.except))
  SENSITIVE = SENSITIVE.filter((t) => !drop.has(t))
}
const SENS = new Set(SENSITIVE)

const FROM = norm(A.from)
if (!FROM) {
  console.error('必填: --from=<来源目录>')
  process.exit(2)
}
const TO = A.to ? norm(A.to) : ''
const APPLY = !!A.apply
const UNKNOWN_MOVE = String(A.unknown || 'keep') === 'move'
const FLAT = !!A.flat
const DB = A.db ? path.resolve(String(A.db)) : path.join(REPO, 'data', 'tags.db')

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

/* ------------------------------------------------------------ 库(只读副本) */

/** 应用可能正开着库(WAL), 直接只读打开会踩坑, 所以先 cp 一份再读 */
function openDbCopy(src) {
  if (!fs.existsSync(src)) return { db: null, note: `库不存在: ${src}` }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-move-'))
  const dst = path.join(tmp, 't.db')
  try {
    fs.copyFileSync(src, dst)
    for (const suf of ['-wal', '-shm']) {
      if (fs.existsSync(src + suf)) fs.copyFileSync(src + suf, dst + suf)
    }
    return { db: new DatabaseSync(dst, { readOnly: false }), note: '', tmp }
  } catch (e) {
    return { db: null, note: `复制库失败: ${e.message}`, tmp }
  }
}

const { db, note, tmp } = openDbCopy(DB)
let tagOf = () => null
if (db) {
  const stmt = db.prepare('SELECT tags FROM images WHERE path = ? ORDER BY id LIMIT 1')
  tagOf = (p) => {
    try { return stmt.get(p)?.tags ?? null } catch { return null }
  }
}

/* ------------------------------------------------------------ 枚举 */

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

/** 整词命中: tags 是 "a, b, c" 形式(逗号后可能有空格) */
function isSensitive(tags) {
  if (!tags) return null            // 库里没有 -> 未知
  const set = new Set(String(tags).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  for (const t of set) if (SENS.has(t)) return true
  return false
}

/* ------------------------------------------------------------ 主流程 */

const t0 = Date.now()
console.log('来源  :', FROM)
console.log('库    :', DB, note ? `(${note})` : '(只读副本)')
console.log('口径  :', `${levelName} · ${SENS.size} 个敏感标签`)
if (SENS.size <= 6) console.log('        ', [...SENS].join(', '))
console.log('目标  :', TO || '(dry-run 未指定)')
console.log('模式  :', APPLY ? '** APPLY —— 真的要移动文件 **' : 'dry-run(只看报告)')
console.log('')

if (!fs.existsSync(FROM)) {
  console.error('来源目录不存在:', FROM)
  process.exit(2)
}

const files = walk(FROM)
console.log(`枚举到图片 ${files.length} 张，正在逐张判定 ...`)

const safe = []
const unsafe = []
const unknown = []
let bytesSafe = 0
const sampleSens = new Map()

for (const f of files) {
  const tags = tagOf(f)
  const r = isSensitive(tags)
  if (r === null) { unknown.push(f); continue }
  if (r) {
    unsafe.push(f)
    for (const t of String(tags).split(',').map((s) => s.trim().toLowerCase())) {
      if (SENS.has(t)) sampleSens.set(t, (sampleSens.get(t) || 0) + 1)
    }
  } else {
    let sz = 0
    try { sz = fs.statSync(f).size } catch { /* 读不到当 0 */ }
    bytesSafe += sz
    safe.push({ path: f, size: sz })
  }
}

const GB = (n) => `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
console.log('')
console.log('=== 判定结果 ===')
console.log(`  安全(待移动) : ${String(safe.length).padStart(6)} 张  ${GB(bytesSafe)}`)
console.log(`  敏感(留原地) : ${String(unsafe.length).padStart(6)} 张`)
console.log(`  库中无标签   : ${String(unknown.length).padStart(6)} 张  ${UNKNOWN_MOVE ? '(按 --unknown=move 也会移动)' : '(默认不动)'}`)
if (unknown.length) console.log(`     例: ${unknown.slice(0, 3).join('  |  ')}`)

if (sampleSens.size) {
  const top = [...sampleSens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  console.log('  命中最多的敏感标签:', top.map(([t, n]) => `${t}(${n})`).join(' · '))
}

const toMove = UNKNOWN_MOVE ? [...safe, ...unknown.map((p) => ({ path: p, size: 0 }))] : safe

if (!TO) {
  console.log('\n未指定 --to，报告到此结束（加 --to=<目录> 再跑一次）')
} else {
  // 冲突预检：目标已存在同名 -> 跳过
  const clash = []
  for (const f of toMove) {
    const dest = destOf(f.path)
    if (fs.existsSync(dest)) clash.push(dest)
  }
  console.log('')
  console.log('=== 目标 ===')
  console.log('  ', TO, fs.existsSync(TO) ? '(已存在)' : '(将创建)')
  console.log(`  同名冲突将跳过: ${clash.length} 张`)
  if (clash.length) for (const c of clash.slice(0, 5)) console.log(`      ${c}`)

  if (!APPLY) {
    console.log('')
    console.log(`[dry-run] 预计移动 ${toMove.length - clash.length} 张 / ${GB(bytesSafe)}`)
    console.log('确认无误后加 --apply 真正执行。')
  } else {
    fs.mkdirSync(TO, { recursive: true })
    let moved = 0
    let skipped = 0
    const failed = []
    const sameDrive = path.parse(FROM).root.toLowerCase() === path.parse(TO).root.toLowerCase()
    for (const f of toMove) {
      const dest = destOf(f.path)
      if (fs.existsSync(dest)) { skipped++; continue }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        if (sameDrive) {
          fs.renameSync(f.path, dest)             // 同盘: 瞬时, 不重写数据
        } else {
          fs.copyFileSync(f.path, dest)           // 跨盘: 先拷后删
          fs.unlinkSync(f.path)
        }
        moved++
        if (moved % 500 === 0) console.log(`  ... 已移动 ${moved}`)
      } catch (e) {
        failed.push(`${f.path} -> ${e.message}`)
      }
    }
    console.log('')
    console.log('=== 完成 ===')
    console.log(`  已移动 ${moved} 张 · 跳过(冲突) ${skipped} 张 · 失败 ${failed.length} 张`)
    if (failed.length) for (const x of failed.slice(0, 10)) console.log('    x', x)
    console.log('')
    console.log('提醒: 库里的旧路径记录会在下次同步时标成 gone=1; 若目标目录也是登记来源,')
    console.log('      这 %d 张会作为"新路径"重新入库并可能重新跑一遍反推。', moved)
  }
}

function destOf(src) {
  const rel = FLAT ? path.basename(src) : path.relative(FROM, src).replace(/\\/g, '/')
  return path.join(TO, rel)
}

console.log(`\n耗时 ${Date.now() - t0} ms`)
if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ } }
db?.close()
