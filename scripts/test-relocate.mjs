/**
 * 「移动 = 改址」测试 —— 2026-10-04 根治"移动一张图卡几秒"
 * ==========================================================
 * 旧链路: 移动 -> kickAutoSync -> ingest 把新位置当**新图**入库(指纹里没有
 * 内容 hash, 换目录 = 全新图) -> 重新入队反推 -> onIngestDone 无条件
 * startLoad -> **整库数据集重建**(buildStats/buildSeriesIndex 两轮全库同步
 * CPU 循环) -> 主进程对 IPC"失联", 光箱翻页/tag 面板全在排队。
 *
 * 新链路: image:moveMany 对库里已有记录的图直接改址(relocateRecord) ——
 * 标签跟图走、ingest 规则 1 按指纹直接跳过、不重建不卡顿。
 *
 * 这里守的是改址本身的几条性质:
 *   ① 库记录 path/folder_id 改到新位置, tags/tags_src 一个字不动;
 *   ② 移动后的新指纹(mtime/size)落库 —— ingest 下次扫描按规则 1 直接跳过;
 *   ③ 内存镜像同步: recordByPath 新路径 O(1) 命中、旧路径查不到;
 *   ④ tag_queue 的 pending 条目跟着改名(不然反推消费时按旧路径找文件必 failed);
 *   ⑤ 库里没记录(库外图)返回 hit=false, 调用方走旧链路兜底;
 *   ⑥ 同路径/空路径的退化输入不动库。
 *
 * 跑法: npm run test:relocate
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 本用例自造数据目录, 不能被外面的 TV_DATA_DIR 抢走优先级
delete process.env.TV_DATA_DIR

const { initWorkspace } = await load('electron/core/workspace.js')
const store = await load('electron/core/store.js')
const folders = await load('electron/core/folders.js')
const dataset = await load('electron/core/dataset.js')
const ingest = await load('electron/core/ingest.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-relocate-'))
const DATA = path.join(WORK, 'data')
const DIR_A = path.join(WORK, 'pic-a')
const DIR_B = path.join(WORK, 'pic-b')
for (const d of [DATA, DIR_A, DIR_B]) fs.mkdirSync(d, { recursive: true })

initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: DATA })

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`) }
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`) }
const eq = (name, got, want) => (got === want ? ok(name, String(got)) : bad(name, `得到 ${got}, 期望 ${want}`))

const norm = (p) => store.normalizeImagePath(p)

/* ---------------------------------------------------------- 造库与夹具 */

const fa = await folders.addFolder({ path: DIR_A })
const fb = await folders.addFolder({ path: DIR_B })
eq('两个目录都登记成功', !fa.error && !fb.error, true)
folders.updateFolder({ path: DIR_A, as_source: true })
folders.updateFolder({ path: DIR_B, as_source: true })

const db = store.openDb()
const fidA = db.prepare('SELECT id FROM folders WHERE path = ?').get(norm(DIR_A)).id
const fidB = db.prepare('SELECT id FROM folders WHERE path = ?').get(norm(DIR_B)).id

// 库里一张已反推过的图(带标签+指纹), 挂在来源 A 下
const IMG_A = path.join(DIR_A, 'cat.png')
fs.writeFileSync(IMG_A, Buffer.from('fake-png-bytes-cat'))
const stA = fs.statSync(IMG_A)
db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone)
            VALUES (?, 0, '1girl, solo, blue_hair', ?, ?, ?, 'wd14', 0)`)
  .run(norm(IMG_A), fidA, stA.mtimeMs, stA.size)

// 反推队列里压着它自己的 pending(模拟"刚入库还没反推就被移走")
ingest.ensureQueueTable(db)
db.prepare(`INSERT INTO tag_queue (path, folder_id, src_id, size, mtime_ms, state, added_at)
            VALUES (?, ?, 0, 1, 1, 'pending', ?)`)
  .run(norm(IMG_A), fidA, Date.now())

// 数据集装载(SQLite 路线: 空 dataFiles = 不读 txt, 直接读全库)
const stats = await dataset.loadDataset(new Map())
eq('数据集从库里装载出 1 条记录', stats.records, 1)

/* ---------------------------------------------------- ①②③④ 正向改址 */

// 模拟用户在光箱里把图移动到 B: 磁盘真搬 + stat 新位置
fs.renameSync(IMG_A, path.join(DIR_B, 'cat.png'))
const IMG_B = path.join(DIR_B, 'cat.png')
const stB = fs.statSync(IMG_B)

const r = dataset.relocateRecord(IMG_A, IMG_B, fidB, { mtimeMs: stB.mtimeMs, size: stB.size })
eq('库里有记录 -> hit=true', r.hit, true)

const row = db.prepare('SELECT path, tags, tags_src, folder_id, mtime_ms, size FROM images WHERE folder_id = ?').get(fidB)
ok('① 记录已经改到新路径', row && row.path)
eq('  新 path = 目标目录下的文件', row?.path, norm(IMG_B))
eq('① 标签一个字不动', row?.tags, '1girl, solo, blue_hair')
eq('① tags_src 保留(wd14 已反推)', row?.tags_src, 'wd14')
eq('① folder_id 指向目标来源 B', Number(row?.folder_id), fidB)
eq('② 新指纹落库(mtime)', Number(row?.mtime_ms), stB.mtimeMs)
eq('② 新指纹落库(size)', Number(row?.size), stB.size)
eq('② 指纹与磁盘实际 stat 一致(规则 1 必然命中)',
  Number(row?.mtime_ms) === stB.mtimeMs && Number(row?.size) === stB.size, true)

const memB = dataset.recordByPath(norm(IMG_B))
const memA = dataset.recordByPath(norm(IMG_A))
ok('③ 内存镜像: 新路径 O(1) 命中', memB && memB.path)
eq('  内存记录的 path 已改', memB?.path, norm(IMG_B))
eq('③ 内存镜像: 旧路径查不到(不再拿旧位置当有效图)', memA, null)
eq('  内存标签跟着走', memB?.tags?.join(','), '1girl,solo,blue_hair')

const q = db.prepare("SELECT path, folder_id, state FROM tag_queue WHERE path = ?").get(norm(IMG_B))
ok('④ 队列 pending 条目跟着改名', q && q.path)
eq('  队列条目指向新路径', q?.path, norm(IMG_B))
eq('④ 队列条目 folder_id 也换到 B', Number(q?.folder_id), fidB)
eq('④ 旧路径在队列里查不到', db.prepare('SELECT COUNT(*) n FROM tag_queue WHERE path = ?').get(norm(IMG_A)).n, 0)

/* ------------------------------------------------------ ⑤ 库外图兜底 */

const miss = dataset.relocateRecord(path.join(DIR_A, 'ghost.png'), path.join(DIR_B, 'ghost.png'), fidB)
eq('⑤ 库里没记录 -> hit=false(调用方走旧链路入库)', miss.hit, false)

/* ------------------------------------------------------ ⑥ 退化输入 */

const same = dataset.relocateRecord(IMG_B, IMG_B, fidB)
eq('⑥ 同路径不改(没什么可改的)', same.hit, false)
const blank = dataset.relocateRecord('', path.join(DIR_B, 'x.png'), fidB)
eq('⑥ 空 from 不动库', blank.hit, false)
eq('⑥ 退化输入没产生任何副作用', db.prepare('SELECT COUNT(*) n FROM images').get().n, 1)

/* ---------------------------------------------------------- 收尾 */

// 必须显式关库: 句柄是模块级单例, 持有它就删不掉沙箱目录(Windows EBUSY)
store.closeDb()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
