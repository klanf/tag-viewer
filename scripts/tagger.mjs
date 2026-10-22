/**
 * WD14 反推 CLI —— 消费 tag_queue, 给裸图打标签写进 tags.db
 * ========================================================
 *   node scripts/tagger.mjs                实跑一轮(会写库)
 *   node scripts/tagger.mjs --limit 5      只跑 5 张(先拿个快赢 / 试环境)
 *   node scripts/tagger.mjs --status       只看环境与队列, 不跑
 *   node scripts/tagger.mjs --json         只输出 JSON(给断言用)
 *   node scripts/tagger.mjs --python <exe> 指定解释器
 *
 * 与 App 启动时的后台反推**是同一份实现**(electron/core/tagger.js),
 * 命令行这里只是换个入口调它 —— 不复制逻辑, 否则两边迟早跑偏。
 *
 * 为什么要有这个 CLI: 反推要拉 python 子进程 + 加载 1.27GB 模型, 出问题时
 * 在 App 里只能靠"事后看日志"。这里能先把环境探明白(找到哪个 python、模型在不在、
 * CUDA 能不能用), 再用 --limit 拿几张试, 最后才整批跑。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir, localConfig, applyLocalEnv } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const args = process.argv.slice(2)
const JSON_ONLY = args.includes('--json')
const STATUS_ONLY = args.includes('--status')
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Math.max(0, parseInt(args[limitIdx + 1], 10) || 0) : 0
const pyIdx = args.indexOf('--python')
const PY = pyIdx >= 0 ? String(args[pyIdx + 1] || '') : ''

const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()
// 本机专属的 python / 模型位置写在 local.config.json 里(不进仓库)。
// 命令行这边显式注入成 TV_* 环境变量, 与 App 走的是同一套(见 core/tagger.js 的候选解析),
// 免得 CLI 与 App 因为探测顺序不同而挑到两个不同的解释器 / 找不到模型。
applyLocalEnv()
if (!PY && typeof localConfig().pythonPath === 'string') {
  process.env.TV_PYTHON ||= localConfig().pythonPath
}

const { initWorkspace } = await load('electron/core/workspace.js')
const tagger = await load('electron/core/tagger.js')
const store = await load('electron/core/store.js')

initWorkspace(APP_DIR)

const out = (s = '') => { if (!JSON_ONLY) console.log(s) }
const svcOpts = PY ? { python: PY } : {}

out(`库文件: ${store.dbPath()}`)

if (STATUS_ONLY) {
  const st = tagger.taggerStatus()
  if (JSON_ONLY) { console.log(JSON.stringify(st, null, 2)); process.exit(0) }
  out('')
  out('=== 反推环境 ===')
  out(`  模型预设      ${st.config.modelPresetLabel || st.config.modelPreset || '(未定)'}`)
  out(`  服务脚本      ${st.config.script || '(未找到)'}`)
  out(`  python        ${st.config.python || '(未探测到)'}`)
  out(`  WD14 模型     ${st.config.model || '(未找到)'}`)
  out(`  标签表        ${st.config.csv || '(未找到)'}`)
  out(`  预处理        ${st.config.preprocess || 'auto'}`)
  out(`  可用          ${st.config.available ? '是' : `否 —— 缺 ${st.config.missing.join(' / ')}`}`)
  out('')
  out('=== 队列 ===')
  out(`  pending=${st.queue.pending} failed=${st.queue.failed} done=${st.queue.done}`)
  out('')
  out(`探活: ${JSON.stringify(await tagger.probeTagger(svcOpts))}`)
  tagger.stopTagger()
  process.exit(0)
}

const t0 = Date.now()
const stats = await tagger.runTagger({
  limit: LIMIT,
  ...svcOpts,
  onProgress: (s) => {
    if (JSON_ONLY) return
    if (s.phase === 'infer' && s.total) {
      if (s.done === s.total || s.done % 10 === 0) out(`  · ${s.done}/${s.total}  ${s.note || ''}`)
    } else if (s.note) {
      out(`  · ${s.note}`)
    }
  },
})

const info = store.dbInfo()
tagger.stopTagger()

if (JSON_ONLY) {
  console.log(JSON.stringify({ stats, db: {
    images: info.images, tags: info.tags, gone: info.gone, byTagsSrc: info.byTagsSrc,
  } }, null, 2))
  process.exit(stats.error ? 1 : 0)
}

out('')
if (stats.degraded) {
  out('=== 已降级(不是错误) ===')
  out(`  原因          ${stats.reason}`)
  out(`  队列里 ${stats.queued} 张裸图留着, 看板与同步一切照常`)
} else {
  out('=== 结果 ===')
  out(`  队列待反推    ${stats.queued}   本轮取出 ${stats.picked}`)
  out(`  发给模型      ${stats.inferCalls} 张   <- 反向验收就看这个数`)
  out(`  反推成功      ${stats.tagged}   (新插入 ${stats.created} / 覆盖旧 wd14 ${stats.updated})`)
  out(`  无结果        ${stats.noResult}`)
  out(`  已有标签跳过  ${stats.skippedExisting}`)
  out(`  磁盘已不见    ${stats.missing}`)
  out(`  失败          ${stats.failed}`)
  out(`  provider      ${stats.provider || '(未上报)'}   模型加载 ${stats.loadMs}ms`)
  out(`  耗时          ${(Date.now() - t0) / 1000}s`)
}
out('')
out('=== 库现状 ===')
const q2 = tagger.taggerStatus().queue
out(`  images        ${info.images}`)
out(`  tags 字典     ${info.tags}`)
out(`  tags_src      ${JSON.stringify(info.byTagsSrc)}`)
out(`  队列          pending=${q2.pending} failed=${q2.failed} done=${q2.done}`)
