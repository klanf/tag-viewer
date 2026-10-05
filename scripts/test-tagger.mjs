/**
 * WD14 反推管道测试 —— 阶段 3 的核心测试
 * =======================================
 * 它要守住的**不是"能跑"**, 而是这几条容易被后续改动破坏的性质:
 *
 *   ① **meta 部分永不丢(2026-10-02 合并语义)** —— meta 图也反推, 但原生标签必须
 *      原样保留、WD14 新标签并进去(tags_src 变 'meta+wd14')。谁把"反推覆盖一切"
 *      写进去, 就会被"a.png 的原生标签原样留在合并结果里"这条抓住。
 *   ② **tagger 只消费队列, 不自造工作** —— 发给模型的每张图都必须是 ingest
 *      判定过的(裸图或待合并的 meta 图), 队列外的一次都不发。
 *   ③ **反推写完库, 下一轮同步不再重读 PNG** —— 指纹是这时写进去的, 漏了它
 *      每次启动都要把那批图重读一遍。
 *   ④ **防御性复查真的会拦住 legacy 标签** —— 并发场景下队列里可能躺着一张
 *      这会儿已经被迁移/手工打了 legacy 标签的图, 那时必须跳过而不是污染。
 *   ⑤ **服务崩了要自己重启并接着跑** —— python 子进程崩溃是常态(显存、驱动、坏图)。
 *   ⑥ **缺依赖时降级而不是报错** —— 队列原样留着, 看板照常。
 *   ⑦ **反推无结果的行要结清** —— 留 pending 会让它每轮被重读+重推, 永远循环。
 *
 * 怎么在没有模型的情况下测
 * ------------------------
 * 协议是**纯文本逐行 JSON**, 与语言无关。于是这里写一个 Node 桩替身
 * (`TV_TAGGER_CMD=node fake.mjs`) 冒充服务: 几毫秒一条, 还能按需"崩溃一次"。
 * 真模型的路子由 `npm run tagger -- --limit 3` 在真实库上单独验(它要 1.27GB 模型,
 * 不适合塞进单元测试)。
 *
 * 跑法: npm run test:tagger
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Windows 上动态 import 必须给 file:// URL, 直接拼盘符路径会被 ESM loader 拒掉
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 本用例自造数据目录, 不能被外面的 TV_DATA_DIR 抢走优先级
delete process.env.TV_DATA_DIR
// 反推的候选解析会读这些环境变量, 先清干净, 免得外面跑过真模型留下的值漏进来
for (const k of ['TV_PYTHON', 'TV_TAGGER_CMD', 'TV_TAGGER_SCRIPT', 'TV_WD14_MODEL', 'TV_WD14_CSV']) {
  delete process.env[k]
}

const { initWorkspace } = await load('electron/core/workspace.js')
const store = await load('electron/core/store.js')
const ingest = await load('electron/core/ingest.js')
const tagger = await load('electron/core/tagger.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-tagger-'))
const DATA = path.join(WORK, 'data')
const IMG_DIR = path.join(WORK, 'imgs')
const SCAN_ONLY = path.join(WORK, 'scanonly')
for (const d of [DATA, IMG_DIR, SCAN_ONLY]) fs.mkdirSync(d, { recursive: true })

initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: DATA })

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`) }
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`) }
const eq = (name, got, want) => (got === want ? ok(name, String(got)) : bad(name, `得到 ${got}, 期望 ${want}`))

/* ---------------------------------------------------------- 桩服务 */

const FAKE = path.join(WORK, 'fake_tagger.mjs')
const FAKE_LOG = path.join(WORK, 'fake_calls.log')
const FAKE_CNT = FAKE_LOG + '.cnt'

/**
 * 桩服务的计数**落盘**而不是放内存: 崩溃重启后是个新进程, 内存里的计数会归零,
 * 于是 `crash-once` 会变成"每次调用都崩"的死循环 —— 那就测不出重启恢复了。
 */
fs.writeFileSync(FAKE, `// 测试桩: 冒充 tools/tagger_serve.py (JSON-lines 协议与语言无关)
import fs from 'node:fs'
const LOG = process.env.TV_FAKE_LOG || ''
const CNT = LOG + '.cnt'
const MODE = process.env.TV_FAKE_MODE || 'ok'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let n = 0
try { n = Number(fs.readFileSync(CNT, 'utf8')) || 0 } catch { n = 0 }
out({ event: 'ready', ok: true, providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'], model: true, csv: true, pid: process.pid })
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const id = msg.id
    if (msg.cmd === 'probe') { out({ id, ok: true, providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'], model: true, csv: true }); continue }
    if (msg.cmd === 'ping') { out({ id, ok: true, pong: true }); continue }
    if (msg.cmd === 'quit') { out({ id, ok: true, bye: true }); process.exit(0) }
    if (msg.cmd !== 'infer') { out({ id, ok: false, error: 'unknown' }); continue }
    n += 1
    fs.writeFileSync(CNT, String(n))
    if (LOG) fs.appendFileSync(LOG, msg.path + '\\n')
    if (MODE === 'crash-once' && n === 1) process.exit(7)   // 第一次就崩, 看上层会不会重启
    if (MODE === 'empty') { out({ id, ok: true, path: msg.path, tags: [], text: '', ms: 1, provider: 'CUDAExecutionProvider' }); continue }
    const base = String(msg.path).split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, '')
    const tags = ['fake_tag', 'name_' + base]
    out({ event: 'loaded', ms: 1, provider: 'CUDAExecutionProvider', tags: 2 })
    out({ id, ok: true, path: msg.path, tags, text: tags.join(', '), ms: 1, provider: 'CUDAExecutionProvider' })
  }
})
`, 'utf8')

const MODEL = path.join(WORK, 'wd-pixai-tagger-v0.9.onnx')
const CSV = path.join(WORK, 'wd-pixai-tagger-v0.9.csv')
fs.writeFileSync(MODEL, 'not-a-real-model')
fs.writeFileSync(CSV, 'not-a-real-csv')

/** 让 tagger.js 用 Node 桩替身跑 —— 命令行覆盖是给"换运行时/换包装脚本"留的正规口子 */
function useFake(mode = 'ok') {
  process.env.TV_TAGGER_CMD = `"${process.execPath}" "${FAKE}"`
  process.env.TV_TAGGER_SCRIPT = FAKE
  process.env.TV_WD14_MODEL = MODEL
  process.env.TV_WD14_CSV = CSV
  process.env.TV_FAKE_LOG = FAKE_LOG
  process.env.TV_FAKE_MODE = mode
  tagger.stopTagger()
}
function resetFakeLog() {
  fs.rmSync(FAKE_LOG, { force: true })
  fs.rmSync(FAKE_CNT, { force: true })
}
/** 桩服务收到过的路径(按顺序) */
function fakeCalls() {
  try { return fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}

/* ---------------------------------------------------------- 造最小 PNG */

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}
function makePng(promptText) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', Buffer.alloc(13))]
  if (promptText) {
    parts.push(chunk('tEXt', Buffer.concat([
      Buffer.from('prompt_text\u0000', 'latin1'),
      Buffer.from(promptText, 'utf8'),
    ])))
  }
  parts.push(chunk('IDAT', Buffer.alloc(64)))
  return Buffer.concat(parts)
}
function writeImg(dir, name, promptText, ageSec = 0) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, makePng(promptText))
  const t = new Date(Date.now() - ageSec * 1000)
  fs.utimesSync(p, t, t)
  return p
}

const norm = (p) => store.normalizeImagePath(p)
const dbGet = (sql, ...a) => store.openDb().prepare(sql).get(...a)
const dbAll = (sql, ...a) => store.openDb().prepare(sql).all(...a)

/* ---------------------------------------------------------- 建登记表 */

console.log('\n[0] 建登记表: 一个看板来源 + 一个纯扫描夹')
{
  const db = store.openDb()
  ingest.ensureQueueTable(db)
  db.prepare(`INSERT INTO folders (path, label, as_source, as_scan, recursive, added_at)
              VALUES (?, ?, 1, 0, 1, ?)`).run(norm(IMG_DIR), 'imgs', Date.now())
  db.prepare(`INSERT INTO folders (path, label, as_source, as_scan, recursive, added_at)
              VALUES (?, ?, 0, 1, 1, ?)`).run(norm(SCAN_ONLY), '26_09_18', Date.now())
  eq('参与同步的目录 1 个', dbGet('SELECT COUNT(*) n FROM folders WHERE as_source=1').n, 1)
}

/* ---------------------------------------------------------- 第一轮 */

console.log('\n[1] 同步: 带元数据的直接入库, 裸图入队, meta 图也入队(等合并)')
const A = writeImg(IMG_DIR, 'a.png', 'hatsune_miku, blue_hair', 300)
const B = writeImg(IMG_DIR, 'b.png', '', 300)
const C = writeImg(IMG_DIR, 'c.png', '', 300)
writeImg(SCAN_ONLY, 'd.png', '', 300)          // 扫描夹 -> 不进这条流程
{
  const st = await ingest.runIngest({})
  eq('入库 1 张(自带元数据)', st.inserted, 1)
  eq('入队 3 张(裸图 2 + meta 1)', st.queued, 3)
  eq('队列 pending=3', ingest.queueStats().pending, 3)
  eq('扫描夹的图没入队', dbGet(`SELECT COUNT(*) n FROM tag_queue WHERE path LIKE '%d.png'`).n, 0)
}

/* ---------------------------------------------------------- 正常反推 */

console.log('\n[2] 反推: 裸图打标入库; meta 图合并(原生标签保留 + WD14 并入)')
useFake('ok')
resetFakeLog()
const t1 = await tagger.runTagger({})
{
  eq('取出的条数 3(a/b/c, meta 也入队)', t1.picked, 3)
  eq('真正发给模型 3 张', t1.inferCalls, 3)
  eq('反推成功 3', t1.tagged, 3)
  eq('新插入 images 行 2(裸图 b/c)', t1.created, 2)
  eq('合并更新 1(a)', t1.updated, 1)
  eq('provider 以回执为准(CUDA)', t1.provider, 'CUDAExecutionProvider')

  const rb = dbGet('SELECT tags, tags_src FROM images WHERE path=?', norm(B))
  eq('b 的标签', rb.tags, 'fake_tag,name_b')
  eq('b 的来源标 wd14', rb.tags_src, 'wd14')
  eq('c 的来源标 wd14', dbGet('SELECT tags_src FROM images WHERE path=?', norm(C)).tags_src, 'wd14')

  // ---- 铁律 ①(合并语义): meta 部分原样保留, WD14 标签并进去 ----
  const ra = dbGet('SELECT tags, tags_src FROM images WHERE path=?', norm(A))
  eq('a = 原生标签在前 + 反推新增在后', ra.tags, 'hatsune_miku,blue_hair,fake_tag,name_a')
  eq('a 的来源标 meta+wd14', ra.tags_src, 'meta+wd14')

  // ---- 铁律 ②: 只发队列里的(a/b/c), 队列外的一次不发 ----
  const calls = fakeCalls()
  eq('模型共收到 3 次调用', calls.length, 3)
  eq('a.png 也发了(合并语义)', calls.some((p) => p.includes('a.png')), true)
  eq('d.png(扫描夹) 从未发给模型', calls.some((p) => p.includes('d.png')), false)

  eq('队列已结清', ingest.queueStats().pending, 0)
  eq('队列 done=3', ingest.queueStats().done, 3)
  eq('库里 images 3 行', dbGet('SELECT COUNT(*) n FROM images').n, 3)
}

console.log('\n[3] 幂等: 再跑一轮反推, 一次调用都不该发出')
{
  resetFakeLog()
  const st = await tagger.runTagger({})
  eq('没有可取出的条目', st.picked, 0)
  eq('发给模型 0 张', st.inferCalls, 0)
  eq('桩服务没被调用', fakeCalls().length, 0)
}

console.log('\n[4] 反推写完库之后, 下一轮同步不再重读 PNG(铁律 ③)')
{
  const st = await ingest.runIngest({})
  eq('读图 0 张', st.readImages, 0)
  eq('3 张全部跳过', st.skipped, 3)
  eq('没有新增/入队', st.inserted + st.queued, 0)
}

/* ---------------------------------------------------------- 防御性复查 */

console.log('\n[5] 防御性复查: 队列里的图已经有 legacy 标签 -> 跳过, 不污染(铁律 ④)')
{
  const db = store.openDb()
  // 人为制造"并发场景": 队列里塞一条, 但库里这张图已经有了 legacy 标签
  db.prepare('UPDATE images SET tags=?, tags_src=? WHERE path=?')
    .run('legacy_kept_tag', 'legacy', norm(C))
  // 人为制造"并发场景": 队列里塞一条 pending, 但库里这张图已经有了 legacy 标签。
  // 用 UPSERT 是因为 c.png 上次反推后队列里已经有一条 done 行(结清状态保留着)。
  db.prepare(`INSERT INTO tag_queue (path, folder_id, src_id, size, mtime_ms, state, added_at)
              VALUES (?, 1, 0, ?, ?, 'pending', ?)
              ON CONFLICT(path) DO UPDATE SET state='pending', note=''`)
    .run(norm(C), fs.statSync(C).size, Math.round(fs.statSync(C).mtimeMs), Date.now())

  resetFakeLog()
  const st = await tagger.runTagger({})
  eq('发出 0 次调用', st.inferCalls, 0)
  eq('记了一次"已有标签跳过"', st.skippedExisting, 1)
  eq('legacy 标签没被覆盖', dbGet('SELECT tags FROM images WHERE path=?', norm(C)).tags, 'legacy_kept_tag')
  eq('队列那条被结清', dbGet('SELECT state FROM tag_queue WHERE path=?', norm(C)).state, 'done')

  // 复位成 wd14, 免得影响后面的用例
  db.prepare('UPDATE images SET tags=?, tags_src=? WHERE path=?').run('fake_tag,name_c', 'wd14', norm(C))
  db.prepare('DELETE FROM tag_queue WHERE path=?').run(norm(C))
}

/* ---------------------------------------------------------- 服务崩溃 */

console.log('\n[6] 服务崩溃: 自动重启并接着跑完(铁律 ⑤)')
{
  writeImg(IMG_DIR, 'e.png', '', 100)
  writeImg(IMG_DIR, 'f.png', '', 100)
  const st0 = await ingest.runIngest({})
  eq('新入队 2 张', st0.queued, 2)

  useFake('crash-once')
  resetFakeLog()
  const st = await tagger.runTagger({})
  eq('重启过(restarts >= 1)', tagger.taggerState.restarts >= 1, true)
  eq('两张都推成功', st.tagged, 2)
  eq('e/f 都进了库', dbGet(`SELECT COUNT(*) n FROM images WHERE path LIKE '%e.png' OR path LIKE '%f.png'`).n, 2)
  eq('队列清空', ingest.queueStats().pending, 0)
}

/* ---------------------------------------------------------- 反推无结果 */

console.log('\n[7] 反推无结果: 结清队列但不写空标签行(铁律 ⑦)')
{
  writeImg(IMG_DIR, 'g.png', '', 50)
  await ingest.runIngest({})
  eq('g 入队', ingest.queueStats().pending, 1)

  useFake('empty')
  resetFakeLog()
  const st = await tagger.runTagger({})
  eq('记了一次"无结果"', st.noResult, 1)
  eq('没有写库', st.tagged, 0)
  eq('g 没有进 images(不造空标签行)', dbGet(`SELECT COUNT(*) n FROM images WHERE path LIKE '%g.png'`).n, 0)
  eq('队列已结清(留 pending 会每轮重推)', ingest.queueStats().pending, 0)
  eq('留了说明', dbGet(`SELECT note FROM tag_queue WHERE path LIKE '%g.png'`).note, '反推无结果')

  // 关键: 再同步一轮, 这张图**不能**被重新读/重新入队 —— 否则就是每轮白烧一次
  const st2 = await ingest.runIngest({})
  eq('再次同步不重读 g', st2.readImages, 0)
  eq('g 没有重新入队', ingest.queueStats().pending, 0)
}

/* ---------------------------------------------------------- 降级 */

console.log('\n[8] 降级: 找不到模型 -> 不报错, 队列原样留着(铁律 ⑥)')
{
  useFake('ok')
  writeImg(IMG_DIR, 'h.png', '', 20)
  await ingest.runIngest({})
  const pendingBefore = ingest.queueStats().pending
  eq('h 入队', pendingBefore, 1)

  // 把模型指到一个不存在的文件 —— 这就是"用户机器上没装模型"的样子
  process.env.TV_WD14_MODEL = path.join(WORK, 'no-such-model.onnx')
  tagger.stopTagger()
  resetFakeLog()

  const st = await tagger.runTagger({})
  eq('标了降级', st.degraded, true)
  eq('没写任何东西', st.tagged, 0)
  eq('桩服务没被调用', fakeCalls().length, 0)
  eq('队列原样留着', ingest.queueStats().pending, pendingBefore)
  eq('不该抛异常(error 为空)', String(st.error || ''), '')
  eq('状态里的原因提到了模型', /模型/.test(tagger.taggerState.reason), true)

  // 恢复
  process.env.TV_WD14_MODEL = MODEL
  tagger.stopTagger()
}

console.log('\n[9] 静态配置自检 + 暂停语义')
{
  const cfg = tagger.taggerConfig()
  eq('脚本存在', cfg.scriptExists, true)
  eq('模型存在', cfg.modelExists, true)
  eq('标签表存在', cfg.csvExists, true)
  eq('静态可用', cfg.available, true)

  const paused = await tagger.pauseTagger()
  eq('没在跑时暂停给出明确失败', paused.ok, false)
  eq('失败原因可读', typeof paused.error === 'string' && paused.error.length > 0, true)

  const st = tagger.taggerStatus()
  eq('status 带队列信息', typeof st.queue.pending, 'number')
  eq('status 带配置信息', typeof st.config.available, 'boolean')
}

console.log('\n[9.5] 原始名兼容: 只放 HuggingFace 原始文件名(model.onnx / selected_tags.csv)也认')
{
  const MODEL_NAME_ONNX = 'wd-pixai-tagger-v0.9.onnx'   // 应用首选的改名版(与 tagger.js 的 MODEL_FILE 一致)
  // 显式指定的候选优先 —— 先摘掉, 才能验"落在目录候选上的原始名"
  delete process.env.TV_WD14_MODEL
  delete process.env.TV_WD14_CSV
  const modelsDir = path.join(DATA, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  // 内容无所谓, 静态配置只验"文件存在"
  fs.writeFileSync(path.join(modelsDir, 'model.onnx'), 'stub')
  fs.writeFileSync(path.join(modelsDir, 'selected_tags.csv'), 'tag_id,name,category,count')

  const cfg = tagger.taggerConfig()
  eq('原始名模型被认出', cfg.modelExists, true)
  eq('原始名标签表被认出', cfg.csvExists, true)
  eq('不改名也静态可用', cfg.available, true)

  // 两种名字同时存在时, 认改名版 —— 显式语义要稳
  fs.writeFileSync(path.join(modelsDir, MODEL_NAME_ONNX), 'stub')
  const cfg2 = tagger.taggerConfig()
  eq('改名版优先于原始版', path.basename(cfg2.model), MODEL_NAME_ONNX)

  fs.rmSync(modelsDir, { recursive: true, force: true })
  const cfg3 = tagger.taggerConfig()
  eq('删掉后回到不可用', cfg3.available, false)
}

/* ---------------------------------------------------------- 收尾 */

tagger.stopTagger()
// 必须显式关库: store.js 的句柄是模块级单例, 持有它就删不掉沙箱目录
// (Windows 上表现为 EBUSY: resource busy or locked ... tags.db)
store.closeDb()
// 桩服务可能还在退出路上, 给它一拍再删目录, 否则偶发 EBUSY
await new Promise((r) => setTimeout(r, 300))
fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
