/**
 * 增量入库 CLI —— 磁盘与 tags.db 对齐
 * =====================================
 *   node scripts/ingest.mjs              实跑一轮(会写库)
 *   node scripts/ingest.mjs --plan       只预演, 不写任何东西
 *   node scripts/ingest.mjs --json       只输出 JSON(给断言用)
 *   node scripts/ingest.mjs --only <名字>  只同步 label 匹配的目录(调试用)
 *
 * 与 App 启动时的后台同步**是同一份实现**(electron/core/ingest.js),
 * 命令行这里只是换个入口调它 —— 不复制逻辑, 否则两边迟早跑偏。
 *
 * 为什么要有这个 CLI: 首轮同步要枚举 4 万多个文件、耗时 1-2 分钟,
 * 在 App 里只能靠"事后看日志", 出问题时没法逐步验证。这里能先把计划
 * 打出来(读了哪些图、要插多少行)再决定要不要真写。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const args = process.argv.slice(2)
const DRY = args.includes('--plan') || args.includes('--dry-run')
const JSON_ONLY = args.includes('--json')
const onlyIdx = args.indexOf('--only')
const ONLY = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').toLowerCase() : ''

const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace } = await load('electron/core/workspace.js')
const ingest = await load('electron/core/ingest.js')
const store = await load('electron/core/store.js')

initWorkspace(APP_DIR)

const out = (s = '') => { if (!JSON_ONLY) console.log(s) }

function mb(n) { return (n / 1048576).toFixed(1) + ' MB' }

out(`库文件: ${store.dbPath()}`)
out(`模式  : ${DRY ? '预演(不写库)' : '实跑(写库)'}${ONLY ? `  仅目录=${ONLY}` : ''}`)
out('')

// --only 是调试用的临时开关: 只留匹配的目录再交给 runIngest
if (ONLY) {
  const db = store.openDb()
  const rows = db.prepare('SELECT * FROM folders WHERE as_source=1 ORDER BY id').all()
  const keep = rows.filter((r) => String(r.label || '').toLowerCase().includes(ONLY)
    || String(r.path).toLowerCase().includes(ONLY))
  // 把不匹配的临时改成 as_source=0, 跑完恢复 —— 直接改库比给 runIngest 加参数更省事,
  // 且异常路径下有 try/finally 兜底。
  const flip = db.prepare('UPDATE folders SET as_source = ? WHERE id = ?')
  const others = rows.filter((r) => !keep.includes(r))
  try {
    for (const r of others) flip.run(0, r.id)
    await run()
  } finally {
    for (const r of others) flip.run(1, r.id)
  }
} else {
  await run()
}

async function run() {
  const t0 = Date.now()
  const stats = await ingest.runIngest({
    dryRun: DRY,
    onProgress: (s) => {
      if (JSON_ONLY) return
      if (s.phase === 'folder-done' || s.phase === 'enum' || s.phase === 'read') {
        if (s.note) out(`  · ${s.note}`)
      }
    },
  })

  const q = ingest.queueStats()
  const info = store.dbInfo()

  if (JSON_ONLY) {
    console.log(JSON.stringify({ stats, queue: q, db: {
      images: info.images, tags: info.tags, gone: info.gone,
      folders: info.folders, byTagsSrc: info.byTagsSrc,
    } }, null, 2))
    return
  }

  out('')
  out('=== 结果 ===')
  out(`  参与目录      ${stats.folders}`)
  out(`  磁盘图数      ${stats.diskFiles}`)
  out(`  跳过(未变)    ${stats.skipped}   其中首轮补指纹 ${stats.statBackfilled}`)
  out(`  真正读图      ${stats.readImages} 张   <- 反向验收就看这个数`)
  out(`  新增入库      ${stats.inserted}   (tags_src='meta')`)
  out(`  重读覆盖      ${stats.metaUpdated}`)
  out(`  入队待反推    ${stats.queued}`)
  out(`  标记消失      ${stats.goneSet}   磁盘又出现 ${stats.goneCleared}`)
  out(`  耗时          ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  out('')
  out('=== 库现状 ===')
  out(`  images        ${info.images}`)
  out(`  tags 字典     ${info.tags}`)
  out(`  gone=1        ${info.gone}`)
  out(`  库体积        ${mb(info.bytes)}`)
  out(`  tags_src      ${JSON.stringify(info.byTagsSrc)}`)
  out(`  待反推队列    pending=${q.pending} failed=${q.failed} done=${q.done}`)
}
