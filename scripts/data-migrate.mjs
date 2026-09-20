/**
 * 数据源合并 —— 迁移与自查
 * ==========================
 * 干三件事, 可分开跑:
 *   ① schema v1 -> v2: 建 folders 表 + 给 images 补列(folder_id/mtime_ms/size/
 *      tags_src/gone/tagged_at), 把 8 个 tags_*.txt 来源落成 folders 记录
 *   ② 路径规范化: 全库统一分隔符 + 盘符小写, 并处理由此产生的重复行
 *   ③ (可选 --layout) 把 data/ 根目录的文件搬进 kb/ user/ rules/ cache/
 *
 * 设计上"接路由"与"搬文件"是分开的: dataFile() 带兼容回退(新位置没有就继续读
 * 根目录那份), 所以 ③ 可以晚做、可以中断, 中途不会出现文件找不到。
 *
 * 用法:
 *   node scripts/data-migrate.mjs              # 看计划 + 真正执行 ①②
 *   node scripts/data-migrate.mjs --dry-run    # 只看计划, 一个字节都不改
 *   node scripts/data-migrate.mjs --check      # 同 --dry-run(别名)
 *   node scripts/data-migrate.mjs --layout     # 执行 ①② 并搬文件
 *   node scripts/data-migrate.mjs --layout --dry-run
 *
 * 安全: 动数据前用 VACUUM INTO 做一致性备份(见 store.backupDb), 备份校验不过就
 * **拒绝迁移** —— 迁移是可选动作, 数据可回退不是。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run') || argv.includes('--check')
const LAYOUT = argv.includes('--layout')

const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace, getWorkspace, dataFile } = await load('electron/core/workspace.js')
const P = await load('electron/core/paths.js')
const store = await load('electron/core/store.js')

initWorkspace(APP_DIR)
const { dataDir } = getWorkspace()
const DB = store.dbPath()

const line = (s = '') => console.log(s)
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/') || p

line(`数据目录: ${dataDir}`)
line(`数据库  : ${rel(DB)}${fs.existsSync(DB) ? '  ' + mb(fs.statSync(DB).size) : '  (不存在)'}`)
line('')

if (!fs.existsSync(DB)) {
  line('数据库不存在 —— 没有可迁移的东西。先启动一次应用或跑 npm run db:import。')
  process.exit(0)
}

/* ------------------------------------------------------------ 对账模式 */

const AUDIT = argv.includes('--audit')

if (AUDIT) {
  // 拿"迁移前"的备份跟当前库对账。备份 = schema 还没有 folders 表的那一份。
  const cands = fs.readdirSync(dataDir)
    .filter((f) => f.startsWith('tags.db.bak-'))
    .map((f) => ({ f, p: path.join(dataDir, f), m: fs.statSync(path.join(dataDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)

  const hasTable = (db, t) => {
    try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) } catch { return false }
  }

  let pre = null
  for (const c of cands) {
    let d
    try { d = new DatabaseSync(c.p, { readOnly: true }) } catch { continue }
    if (!hasTable(d, 'folders')) { pre = { ...c, db: d }; break }
    d.close()
  }

  if (!pre) {
    line('✗ 找不到"迁移前"的备份(schema 无 folders 表的那一份), 无法对账。')
    process.exit(1)
  }

  const cur = new DatabaseSync(DB, { readOnly: true })
  const bakImages = pre.db.prepare('SELECT id, path, tags FROM images ORDER BY id').all()
  const curByPath = new Map()
  for (const r of cur.prepare('SELECT path, tags FROM images').all()) curByPath.set(r.path, r)

  // 按规范化路径分组: 单行组必须逐条原样存在; 多行组按"保留 id 最大"合并
  const groups = new Map()
  for (const r of bakImages) {
    const n = store.normalizeImagePath(r.path)
    if (!groups.has(n)) groups.set(n, [])
    groups.get(n).push(r)
  }
  const singleGroups = []
  const dupGroups = []
  for (const [n, rows] of groups) (rows.length > 1 ? dupGroups : singleGroups).push([n, rows])

  const lost = []                       // 单行组: 路径没了 或 标签变了 —— 都是真问题
  for (const [n, rows] of singleGroups) {
    const hit = curByPath.get(n)
    if (!hit) lost.push({ kind: '路径丢失', path: n })
    else if (hit.tags !== rows[0].tags) lost.push({ kind: '标签被改', path: n })
  }

  const dupIssues = []                  // 重复组: 保留行必须与备份里"最后一条"一致
  const discarded = []                  // 被合并掉的整行(审计要留的原貌)
  for (const [n, rows] of dupGroups) {
    const keep = rows[rows.length - 1]
    for (const r of rows.slice(0, -1)) discarded.push({ path: n, droppedId: r.id, keptId: keep.id, droppedTags: r.tags })
    const hit = curByPath.get(n)
    if (!hit) dupIssues.push({ kind: '路径丢失', path: n })
    else if (hit.tags !== keep.tags) dupIssues.push({ kind: '保留行标签与备份末条不一致', path: n })
  }

  const curExtra = [...curByPath.keys()].filter((p) => !groups.has(p))

  line('=== 迁移对账(迁移前备份 vs 当前库) ===')
  line(`  备份文件          : ${pre.f}  (schema 无 folders 表 = 迁移前)`)
  line(`  备份 images       : ${bakImages.length}`)
  line(`  规范化后唯一路径   : ${groups.size}   (${dupGroups.length} 组重复, 合并掉 ${discarded.length} 行)`)
  line(`  当前 images       : ${cur.prepare('SELECT COUNT(*) AS n FROM images').get().n}`)
  line('')
  line(`  单行组 ${singleGroups.length} 条 —— 路径丢失 / 标签被改 : ${lost.length}   期望 0`)
  line(`  重复组 ${dupGroups.length} 组 —— 保留行与原末条不符     : ${dupIssues.length}   期望 0`)
  line(`  当前库多出的路径(备份里没有的) : ${curExtra.length}   期望 0`)
  for (const m of [...lost, ...dupIssues].slice(0, 10)) line(`    · [${m.kind}] ${m.path}`)
  for (const m of curExtra.slice(0, 10)) line(`    · [多出] ${m}`)
  if (discarded.length) {
    line('')
    line('  被合并掉的整行(同路径多条记录, 保留 id 最大者):')
    for (const d of discarded) line(`    · 丢 id=${d.droppedId} 留 id=${d.keptId}  ${d.path}`)
  }

  const verdict = lost.length === 0 && dupIssues.length === 0 && curExtra.length === 0
  line('')
  line(verdict
    ? `✓ 对账通过: 除 ${discarded.length} 行同路径合并外一条未丢, 无标签被改`
    : `✗ 对账不通过: 单行组问题 ${lost.length} / 重复组问题 ${dupIssues.length} / 多出 ${curExtra.length}`)

  // 迁移报告若缺失(早期脚本没落盘), 用对账结果补出来 —— 审计痕迹不能没有
  const repFile = path.join(dataDir, 'cache', 'migration-report-v1-to-v2.json')
  if (discarded.length && !fs.existsSync(repFile)) {
    fs.mkdirSync(path.dirname(repFile), { recursive: true })
    fs.writeFileSync(repFile, JSON.stringify({
      at: new Date().toISOString(),
      from: 1,
      to: 2,
      backup: pre.p,
      note: '由 --audit 事后补齐: 迁移当初未落盘报告',
      counts: {
        pathRows: bakImages.length,
        pathUnique: groups.size,
        pathDropped: discarded.length,
      },
      droppedRows: discarded,
    }, null, 2), 'utf8')
    line(`  (已补齐迁移报告: ${rel(repFile)})`)
  }

  pre.db.close()
  cur.close()
  process.exit(verdict ? 0 : 1)
}

/* ------------------------------------------------------------ 计划(只读) */

const ro = new DatabaseSync(DB, { readOnly: true })

function scalar(sql, ...a) {
  try { return Number(ro.prepare(sql).get(...a)?.n || 0) } catch { return 0 }
}

const ver = (() => {
  try { return Number(ro.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0) } catch { return 0 }
})()
const hasFolders = (() => {
  try { return !!ro.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folders'").get() } catch { return false }
})()

line('=== 当前状态 ===')
line(`  schema_version : ${ver}${ver >= 2 ? ' (已是最新)' : ` -> 将迁移到 ${2}`}`)
line(`  images         : ${scalar('SELECT COUNT(*) AS n FROM images')}`)
line(`  tags           : ${scalar('SELECT COUNT(*) AS n FROM tags')}`)
line(`  src            : ${scalar('SELECT COUNT(*) AS n FROM src')}`)
line(`  folders 表     : ${hasFolders ? '已有' : '没有(将新建)'}`)
line('')

// 路径规范化计划
const normPlan = (() => {
  const rows = ro.prepare('SELECT id, path FROM images').all()
  let need = 0
  const seen = new Map()
  const collide = []
  for (const r of rows) {
    const n = store.normalizeImagePath(r.path)
    if (n !== r.path) need++
    const prev = seen.get(n)
    if (prev !== undefined) collide.push([n, prev, r.id])
    else seen.set(n, r.id)
  }
  return { rows: rows.length, need, unique: seen.size, collide }
})()

line('=== 路径规范化计划 ===')
line(`  ${normPlan.rows} 行中 ${normPlan.need} 行写法不规范(混写分隔符 / 盘符大小写)`)
line(`  规范化后唯一路径 ${normPlan.unique} 条, 需要去重 ${normPlan.collide.length} 行`)
for (const [n, drop, keep] of normPlan.collide.slice(0, 5)) {
  line(`    · 丢 id=${drop} 留 id=${keep}  ${n}`)
}
line('')

// folders 计划
const folderPlan = (() => {
  if (ver < 2) {
    // v1: 从 src + images.path 反查(临时表都没有, 直接用现有列)
    const out = []
    const scanRaw = (() => {
      try {
        const p = dataFile('scan_folders.json')
        if (!fs.existsSync(p)) return []
        const d = JSON.parse(fs.readFileSync(p, 'utf8'))
        return Array.isArray(d?.folders) ? d.folders : []
      } catch { return [] }
    })()
    const scanNorm = new Map(scanRaw.map((f) => [store.normalizeImagePath(f.path), f]))
    for (const s of ro.prepare('SELECT id, name FROM src ORDER BY id').all()) {
      const root = store.folderRootOfSrc(ro, s.id)
      if (!root) continue
      out.push({ path: root, label: s.name, as_source: 1, as_scan: scanNorm.has(root) ? 1 : 0 })
    }
    const known = new Set(out.map((f) => f.path))
    for (const f of scanRaw) {
      const p = store.normalizeImagePath(f.path)
      if (p && !known.has(p)) out.push({ path: p, label: f.label || '', as_source: 0, as_scan: 1 })
    }
    return out
  }
  return ro.prepare('SELECT path, label, as_source, as_scan FROM folders ORDER BY id').all()
})()

line('=== folders 计划(来源登记表) ===')
line(`  共 ${folderPlan.length} 条`)
for (const f of folderPlan) {
  const use = [f.as_source ? '看板来源' : null, f.as_scan ? '扫描夹' : null].filter(Boolean).join(' + ') || '(无用途)'
  line(`    ${String(f.label || '(无名)').padEnd(14)} ${use.padEnd(12)} ${f.path}`)
}
line('')

// 目录重排计划
const layoutPlan = (() => {
  const out = []
  const names = [...Object.keys(P.DATA_ROUTE), ...Object.keys(P.DATA_DIR_ROUTE)]
  for (const name of names) {
    const from = path.join(dataDir, name)
    if (!fs.existsSync(from)) continue
    const target = path.join(dataDir, P.dataRelPath(name))
    out.push({ name, from, to: target, same: target === from })
  }
  for (const e of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (P.KNOWLEDGE_DIR_PREFIXES.some((p) => e.name.startsWith(p))) {
      const from = path.join(dataDir, e.name)
      const target = path.join(dataDir, P.dataRelPath(e.name))
      out.push({ name: e.name, from, to: target, same: target === from, dir: true })
    }
  }
  return out
})()

line('=== data/ 目录重排计划 ===')
if (!layoutPlan.length) line('  (没有需要搬的条目)')
for (const m of layoutPlan) {
  const state = fs.existsSync(m.to) ? '✗ 目标已存在, 跳过' : '待搬'
  line(`  ${String(m.name).padEnd(34)} ${state}`)
  line(`      ${rel(m.from)}  ->  ${rel(m.to)}`)
}
line('')

ro.close()

if (DRY) {
  line('--dry-run: 以上只是计划, 未做任何修改。')
  process.exit(0)
}

/* ------------------------------------------------------------ 执行 */

line('=== 开始迁移 ===')
const t0 = Date.now()
// 用 openRawDb: 迁移必须由**这里**显式触发, 否则 openDb() 会先悄悄迁完,
// runMigrations() 再调就成了空转, 报告全丢(踩过一次)。
const db = store.openRawDb()
const mig = store.runMigrations(db, ({ note }) => line(`  · ${note}`))
if (mig.changed) {
  line(`  迁移完成: v${mig.from} -> v${mig.to}${mig.fresh ? ' (全新库)' : ''}  ${Date.now() - t0}ms`)
  if (mig.backup) line(`  备份: ${rel(mig.backup)}`)
  if (mig.report) {
    const r = mig.report
    line(`  tags_src 回填 legacy : ${r.legacy} 行`)
    line(`  路径规范化           : ${r.paths.rows} -> ${r.paths.unique} 条唯一`)
    line(`  去重(保留 id 大的)   : ${r.paths.dropped.length} 行`)
    line(`  folder_id 关联       : ${r.linked} 行`)
    line(`  folders 记录         : ${r.folders.length} 条`)
    if (r.paths.dropped.length) line(`  ⚠ 被丢掉的整行已存进迁移报告, 可查可回滚`)
  }
  if (mig.reportFile) line(`  迁移报告: ${rel(mig.reportFile)}`)
} else {
  line(`  schema 已是最新(v${mig.from}), 无需迁移`)
}

/* 目录重排 */
if (LAYOUT) {
  line('')
  line('=== 执行 data/ 目录重排 ===')
  let moved = 0
  let skipped = 0
  for (const m of layoutPlan) {
    if (m.same) { skipped++; continue }
    if (fs.existsSync(m.to)) {
      line(`  · 跳过(目标已存在): ${m.name}`)
      skipped++
      continue
    }
    try {
      fs.mkdirSync(path.dirname(m.to), { recursive: true })
      fs.renameSync(m.from, m.to)     // 同卷改名 = 不重写字节, 可秒回滚
      line(`  ✓ ${rel(m.from)}  ->  ${rel(m.to)}`)
      moved++
    } catch (e) {
      line(`  ✗ ${m.name}: ${e.message}`)
    }
  }
  line(`  搬迁 ${moved} 个, 跳过 ${skipped} 个`)
}

/* ------------------------------------------------------------ 收尾核对 */

line('')
line('=== 迁移后核对 ===')
const info = store.dbInfo()
line(`  schema_version : ${info.schemaVersion}`)
line(`  images         : ${info.images}`)
line(`  tags           : ${info.tags}`)
line(`  folders        : ${info.folders} (看板来源 ${info.foldersAsSource} / 扫描夹 ${info.foldersAsScan})`)
line(`  gone / 已反推  : ${info.gone} / ${info.tagged}`)
line(`  tags_src 分布  : ${(info.byTagsSrc || []).map((r) => `${r.k}=${r.n}`).join(', ')}`)
store.closeDb()
