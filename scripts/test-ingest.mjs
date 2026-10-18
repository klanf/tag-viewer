/**
 * 增量入库测试 —— 方案 §2.2 的六条判定规则逐条守
 * =================================================
 * 这是阶段 2 的核心测试。它要守住的**不是"能跑"**, 而是这几条容易被后续改动破坏的性质:
 *
 *   ① **已入库的图一次都不读** —— 「图内无元数据」不等于「库里没标签」。
 *      实测 涩不了一点 的 9296 张图内全无元数据, 但库里早有 9202 条标签
 *      (早期反推后直接合并进 txt, 没写回 PNG)。谁把准入条件改回"无元数据就反推",
 *      就会被这里的 `readImages === 0` 抓住。
 *   ② **首轮只回填指纹、不读图** —— legacy 行的 mtime/size 是 NULL,
 *      没有这一步「跳过」永远算不出来, 每次启动都要重读 8 万张。
 *   ③ **as_scan=1 / as_source=0 的目录完全不碰** —— 那是"只看新生成的 AI 图"的
 *      扫描夹, 追平进标签库是错的。
 *   ④ **重读不到元数据时不清空已有标签** —— 旧 txt 的 legacy 值可能是唯一一份。
 *   ⑤ 消失/复活(gone) 的来回都要能走通。
 *
 * 跑法: npm run test:ingest
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

const { initWorkspace } = await load('electron/core/workspace.js')
const store = await load('electron/core/store.js')
const ingest = await load('electron/core/ingest.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-ingest-'))
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

/* ---------------------------------------------------------- 造最小 PNG */

/** 拼一个 chunk: 长度 + 类型 + 数据 + CRC(读取端不校验 CRC, 填零即可) */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

/**
 * 最小 PNG: 签名 + 可选 tEXt(prompt_text) + IDAT。
 * png.js 的 readPngTextChunks 遇到 IDAT 就停, 所以后面不需要 IEND ——
 * 这里造的是"结构上够真、体积最小"的夹具, 不是能渲染的图。
 */
function makePng(promptText) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = chunk('IHDR', Buffer.alloc(13))
  const parts = [sig, ihdr]
  if (promptText) {
    parts.push(chunk('tEXt', Buffer.concat([
      Buffer.from('prompt_text\u0000', 'latin1'),
      Buffer.from(promptText, 'utf8'),
    ])))
  }
  parts.push(chunk('IDAT', Buffer.alloc(64)))
  return Buffer.concat(parts)
}

/** 写文件并把 mtime 显式推到指定时刻 —— 不能靠"写入自然改 mtime", 那分辨率不受控 */
function writeImg(dir, name, promptText, ageSec = 0) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, makePng(promptText))
  const t = new Date(Date.now() - ageSec * 1000)
  fs.utimesSync(p, t, t)
  return p
}

// 规范化路径(与 store 同一套规则): 磁盘路径 -> 库里存的写法
const norm = (p) => store.normalizeImagePath(p)

/** 跑一轮并静音进度 */
const run = (opts = {}) => ingest.runIngest(opts)

/* ---------------------------------------------------------- 建登记表 */

console.log('\n[0] 建登记表: 一个看板来源 + 一个纯扫描夹')
{
  const db = store.openDb()
  ingest.ensureQueueTable(db)
  db.prepare(`INSERT INTO folders (path, label, as_source, as_scan, recursive, added_at)
              VALUES (?, ?, 1, 0, 1, ?)`).run(norm(IMG_DIR), 'imgs', Date.now())
  db.prepare(`INSERT INTO folders (path, label, as_source, as_scan, recursive, added_at)
              VALUES (?, ?, 0, 1, 1, ?)`).run(norm(SCAN_ONLY), '26_09_18', Date.now())
  const rows = db.prepare('SELECT id, label, as_source, as_scan FROM folders ORDER BY id').all()
  eq('folders 两条', rows.length, 2)
  eq('参与同步的只有 1 个', db.prepare('SELECT COUNT(*) n FROM folders WHERE as_source=1').get().n, 1)
}

/* ---------------------------------------------------------- 造图 */

console.log('\n[1] 第一轮: 新增分流 + 扫描夹被完全忽略')
{
  writeImg(IMG_DIR, 'a.png', '1girl, solo, smile', 300)
  writeImg(IMG_DIR, 'b.png', '', 300)                  // 裸图 -> 入队
  writeImg(IMG_DIR, 'c.png', 'hatsune_miku, blue_hair', 300)
  writeImg(SCAN_ONLY, 'd.png', 'should, never, enter', 300)

  const st = await run()
  eq('读图 3 张(只有 imgs 里的)', st.readImages, 3)
  eq('入库 3 张(meta 2 + 裸图占位 1)', st.inserted, 3)
  eq('入队 3 张(裸图 1 + meta 2)', st.queued, 3)
  eq('跳过 0', st.skipped, 0)
  eq('消失 0', st.goneSet, 0)

  const db = store.openDb()
  eq('库内 images 3 行', db.prepare('SELECT COUNT(*) n FROM images').get().n, 3)
  eq('meta 2 行', db.prepare("SELECT COUNT(*) n FROM images WHERE tags_src='meta'").get().n, 2)
  eq('裸图占位 1 行(tags 空)', (() => {
    const r = db.prepare('SELECT tags, tags_src FROM images WHERE path=?').get(norm(path.join(IMG_DIR, 'b.png')))
    return r && String(r.tags) === '' && String(r.tags_src) === '' ? 'ok' : `bad:${JSON.stringify(r)}`
  })(), 'ok')
  eq('a 的标签', db.prepare('SELECT tags FROM images WHERE path=?').get(norm(path.join(IMG_DIR, 'a.png'))).tags,
    '1girl,solo,smile')
  eq('folder_id 已写入', db.prepare('SELECT COUNT(*) n FROM images WHERE folder_id IS NULL').get().n, 0)

  const q = db.prepare('SELECT path, state FROM tag_queue').all()
  eq('队列 3 条(a/b/c)', q.length, 3)
  eq('三条全是 pending', q.filter((x) => x.state === 'pending').length, 3)
  eq('b.png 在队列', q.some((x) => path.basename(x.path) === 'b.png'), true)

  // 扫描夹的图必须**从未**进库 —— 连队列都不能有
  eq('扫描夹未入库', db.prepare(`SELECT COUNT(*) n FROM images WHERE path LIKE '%d.png'`).get().n, 0)
  eq('扫描夹未入队', db.prepare(`SELECT COUNT(*) n FROM tag_queue WHERE path LIKE '%d.png'`).get().n, 0)
}

console.log('\n[2] 第二轮: 完全空转, 一张图都不读(核心反向断言)')
{
  const st = await run()
  eq('读图 0 张', st.readImages, 0)
  // 参与同步的只有 imgs 那 3 张(扫描夹压根不进这条流程), 且全都该跳过:
  // a/c 已入库且指纹一致, b 在队列里待反推
  eq('3 张全部跳过', st.skipped, 3)
  eq('新增 0', st.inserted, 0)
  eq('入队 0', st.queued, 0)
  eq('首轮已回填完指纹, 这轮不再回填', st.statBackfilled, 0)
  eq('耗时 < 1s', st.ms < 1000, true)
}

console.log('\n[3] 规则 2: 图被换成裸图 -> 重新入队, 但**不清空**已有标签')
{
  const a = path.join(IMG_DIR, 'a.png')
  fs.writeFileSync(a, makePng(''))            // 元数据没了
  const t = new Date(Date.now() - 100 * 1000)
  fs.utimesSync(a, t, t)

  const st = await run()
  eq('读图 1 张', st.readImages, 1)
  eq('覆盖数 0(读不到元数据, 不该覆盖)', st.metaUpdated, 0)
  eq('重新入队 1 张', st.queued, 1)

  const db = store.openDb()
  const row = db.prepare('SELECT tags, tags_src FROM images WHERE path=?').get(norm(a))
  eq('原有标签被保护', row.tags, '1girl,solo,smile')
  eq('tags_src 没被改成空', row.tags_src, 'meta')
  eq('a 重新进了队列', db.prepare('SELECT COUNT(*) n FROM tag_queue WHERE path=?').get(norm(a)).n, 1)
}

console.log('\n[4] 规则 5: 磁盘上删掉 -> 标记 gone, 记录保留')
{
  const c = path.join(IMG_DIR, 'c.png')
  fs.rmSync(c)

  const st = await run()
  eq('标记消失 1', st.goneSet, 1)
  const db = store.openDb()
  const row = db.prepare('SELECT tags, gone FROM images WHERE path=?').get(norm(c))
  eq('记录还在', !!row, true)
  eq('标签还在', row.tags, 'hatsune_miku,blue_hair')
  eq('gone=1', Number(row.gone), 1)

  // gone 的行不该出现在运行时读取里(dataset 走 readRecords)
  let seen = 0
  await store.readRecords((r) => { if (r.path === norm(c)) seen++ })
  eq('readRecords 不再返回它', seen, 0)
}

console.log('\n[5] 规则 6: 图又出现 -> 清 gone 并重读元数据')
{
  const c = path.join(IMG_DIR, 'c.png')
  writeImg(IMG_DIR, 'c.png', 'hatsune_miku, long_hair', 50)

  const st = await run()
  eq('清 gone 1', st.goneCleared, 1)
  eq('重读覆盖 1', st.metaUpdated, 1)
  const db = store.openDb()
  const row = db.prepare('SELECT tags, gone, tags_src FROM images WHERE path=?').get(norm(c))
  eq('gone 清零', Number(row.gone), 0)
  eq('标签更新为新的', row.tags, 'hatsune_miku,long_hair')
  eq('tags_src 仍为 meta', row.tags_src, 'meta')
  eq('总数未变(没有重复插入)', db.prepare('SELECT COUNT(*) n FROM images').get().n, 3)
  eq('c 重新入队(meta 变更也要补反推)', db.prepare('SELECT COUNT(*) n FROM tag_queue WHERE path=?').get(norm(c)).n, 1)
}

console.log('\n[6] 幂等: 再跑一轮, 什么都不该发生')
{
  const st = await run()
  eq('读图 0', st.readImages, 0)
  eq('新增 0 / 更新 0 / 入队 0 / 消失 0',
    st.inserted + st.metaUpdated + st.queued + st.goneSet, 0)
  eq('跳过 3', st.skipped, 3)
}

console.log('\n[7] 预演模式: 只算不写')
{
  const e = path.join(IMG_DIR, 'e.png')
  writeImg(IMG_DIR, 'e.png', 'new_one, solo', 10)
  const db = store.openDb()
  const before = db.prepare('SELECT COUNT(*) n FROM images').get().n

  const st = await run({ dryRun: true })
  eq('预演也读图(要判定有无元数据)', st.readImages, 1)
  eq('预演报告新增 1', st.inserted, 1)
  eq('库未变', db.prepare('SELECT COUNT(*) n FROM images').get().n, before)
  eq('e.png 未入库', db.prepare('SELECT COUNT(*) n FROM images WHERE path=?').get(norm(e)).n, 0)
}

console.log('\n[8] backfillMetaQueue: 存量 meta 一次性补队 + 标记幂等 + TV_INGEST 门闸')
{
  const db = store.openDb()
  // 直接插一张"改语义前就在库里"的 meta 图(不走 ingest, 所以队列里没有它;
  // 磁盘上故意不造文件 —— backfill 只读库, 不影响任何后续用例)
  db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone)
              VALUES (?, 1, 'old_meta_only_tag', 1, 111, 222, 'meta', 0)`)
    .run(norm(path.join(IMG_DIR, 'zz-backfill-only.png')))

  const r1 = ingest.backfillMetaQueue(db)
  eq('补队 1 张', r1.queued, 1)
  eq('进了队列且 pending',
    db.prepare('SELECT state FROM tag_queue WHERE path=?').get(norm(path.join(IMG_DIR, 'zz-backfill-only.png'))).state,
    'pending')

  const r2 = ingest.backfillMetaQueue(db)
  eq('第二次跳过(标记已打)', r2.skipped, true)

  // 门闸: TV_INGEST=0(测试/dev)绝不偷跑 —— 清掉标记再验
  db.prepare("DELETE FROM meta WHERE key='wd14_meta_backfill_v1'").run()
  process.env.TV_INGEST = '0'
  const r3 = ingest.backfillMetaQueue(db)
  eq('TV_INGEST=0 时不补', r3.skipped, true)
  delete process.env.TV_INGEST
}

// 必须显式关库: store.js 的句柄是模块级单例, 持有它就删不掉沙箱目录
// (Windows 上表现为 EBUSY: resource busy or locked ... tags.db)
store.closeDb()
fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
