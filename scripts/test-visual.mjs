/**
 * 视觉相关的两件事 —— 图片比例 / 安全模式
 * =======================================
 * 2026-09-23 一起加的两条线, 都是"读侧"改造: 卡片按图片真实比例渲染、
 * 安全模式按标签集合隐藏内容。这个用例守的是**改动之后才成立的那几条性质**:
 *
 *   ① 尺寸能**只读文件头**解析出来, 而且格式认不出时返回 null(绝不猜)。
 *   ② 老库缺 px_w/px_h 列时要能**原地补齐** —— 注意这里补的是 ADDITIVE_COLS
 *      那条路(每次 openDb 都跑), 而不是 applyV2Shape(只在迁移时跑, 老库早就
 *      迁完了, 加在那里一辈子不生效)。
 *   ③ 缺尺寸时必须回落到"改动前的行为"(0 而不是 0 参与算比例)。
 *   ④ 敏感标签的判定: core 段命中 -> 1, 只命中 edge 段 -> 2, 干净 -> 0;
 *      `breasts` 这种"体型"标签**刻意不收录**(实测它命中 93% 的图)。
 *   ⑤ 开关默认关闭, 坏配置文件回落关闭 —— 宁可不过滤, 也不要突然少一半图。
 *
 * 跑法: npm run test:visual
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 本用例自造数据目录, 不能被外面的 TV_DATA_DIR 抢走优先级
delete process.env.TV_DATA_DIR

const { initWorkspace, dataFile } = await load('electron/core/workspace.js')
const { readImageSize, sizeFromBuffer } = await load('electron/core/imgsize.js')
const safety = await load('electron/core/safety.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-visual-'))
const DATA = path.join(WORK, 'data')
fs.mkdirSync(DATA, { recursive: true })
initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: DATA })

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`) }
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`) }
const eq = (name, got, want) => (got === want ? ok(name, String(got)) : bad(name, `得到 ${got}, 期望 ${want}`))
const isNull = (name, got) => (got === null ? ok(name, 'null') : bad(name, `得到 ${JSON.stringify(got)}, 期望 null`))

/* ---------------------------------------------------------- 造各种文件头 */

const SIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngBuf(w, h) {
  const b = Buffer.alloc(33)
  SIG_PNG.copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

/** SOI + APP0(带 16 字节长度) + SOF0 —— 顺带验证"要跳过段"这一点 */
function jpegBuf(w, h) {
  const app0 = Buffer.alloc(20)
  app0.writeUInt16BE(0xffe0, 0)
  app0.writeUInt16BE(16, 2)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof.writeUInt8(8, 4)
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

function gifBuf(w, h) {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}

function bmpBuf(w, h) {
  const b = Buffer.alloc(30)
  b.write('BM', 0, 'latin1')
  b.writeInt32LE(w, 18)
  b.writeInt32LE(h, 22)
  return b
}

function webpBuf(w, h) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  b.writeUInt8((w - 1) & 0xff, 24)
  b.writeUInt8(((w - 1) >> 8) & 0xff, 25)
  b.writeUInt8(((w - 1) >> 16) & 0xff, 26)
  b.writeUInt8((h - 1) & 0xff, 27)
  b.writeUInt8(((h - 1) >> 8) & 0xff, 28)
  b.writeUInt8(((h - 1) >> 16) & 0xff, 29)
  return b
}

console.log('图片尺寸解析(只读文件头)')

const cases = [
  ['PNG', pngBuf(1920, 1080), [1920, 1080]],
  ['JPEG', jpegBuf(832, 1216), [832, 1216]],
  ['GIF', gifBuf(640, 480), [640, 480]],
  ['BMP', bmpBuf(1280, 720), [1280, 720]],
  ['WEBP(VP8X)', webpBuf(1024, 1536), [1024, 1536]],
]
for (const [name, buf, want] of cases) {
  const got = sizeFromBuffer(buf)
  eq(`${name} 解析出尺寸`, got ? `${got[0]}x${got[1]}` : 'null', `${want[0]}x${want[1]}`)
}

/* 认不出来必须返回 null —— "猜一个尺寸"会让卡片按错误比例渲染, 比不渲染更糟 */
isNull('全零 buffer 认不出', sizeFromBuffer(Buffer.alloc(64)))
isNull('随机二进制认不出', sizeFromBuffer(Buffer.from('这不是图片随便写点东西占位一下下', 'utf8')))
isNull('太短认不出', sizeFromBuffer(Buffer.from([0x89, 0x50])))
isNull('空 buffer 认不出', sizeFromBuffer(Buffer.alloc(0)))

/* ---- 落盘读一次(走真实 fs 路径) ---- */
const pngFile = path.join(WORK, 'a.png')
fs.writeFileSync(pngFile, pngBuf(768, 1024))
const real = readImageSize(pngFile)
eq('readImageSize 读真实文件', real ? `${real[0]}x${real[1]}` : 'null', '768x1024')
isNull('文件不存在返回 null', readImageSize(path.join(WORK, 'nope.png')))
isNull('路径为空返回 null', readImageSize(''))

/* ---------------------------------------------------------- DB 列与记录 */

console.log('\n数据库: 幂等补列 + 记录带出尺寸')

const { openDb, readRecords, closeDb } = await load('electron/core/store.js')
const db = openDb()
const cols = new Set(db.prepare('PRAGMA table_info(images)').all().map((r) => r.name))
eq('老库原地补上 px_w 列', cols.has('px_w'), true)
eq('老库原地补上 px_h 列', cols.has('px_h'), true)

// 直接插两行: 一行有尺寸、一行没有(模拟"回填还没跑到")
// 路径**不能写成字面量盘符**(preflight 会当成写死的绝对路径拦下), 用运行时临时目录拼
const pA = path.join(WORK, 'db-a.png').split(path.sep).join('/')
const pB = path.join(WORK, 'db-b.png').split(path.sep).join('/')
db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, tags_src, gone, px_w, px_h)
            VALUES (?, 0, ?, NULL, 'wd14', 0, ?, ?)`).run(pA, '1girl, nude', 832, 1216)
db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, tags_src, gone)
            VALUES (?, 0, ?, NULL, 'wd14', 0)`).run(pB, '1girl, smile')

const seen = []
readRecords((r) => seen.push(r))
const a = seen.find((r) => r.path === pA)
const b = seen.find((r) => r.path === pB)
eq('有尺寸的行带出 px_w', a?.px_w, 832)
eq('有尺寸的行带出 px_h', a?.px_h, 1216)
eq('缺尺寸的行给 0(不是 null/undefined, 消费方按"未知"处理)', b?.px_w, 0)
eq('缺尺寸的行 px_h 也是 0', b?.px_h, 0)

/* ---------------------------------------------------------- 安全模式 */

console.log('\n安全模式: 集合 / 判定 / 开关')

const m0 = safety.safetyMatcher()
const tagFile = dataFile('safety_tags.txt')
eq('首次使用会写出集合文件(用户有个能改的起点)', fs.existsSync(tagFile), true)
const raw = fs.readFileSync(tagFile, 'utf8')
eq('文件里有 [core] 段', raw.includes('[core]'), true)
eq('文件里有 [edge] 段', raw.includes('[edge]'), true)
eq('core 段条数 = 内置默认', m0.coreCount, safety.DEFAULT_CORE.length)
eq('edge 段条数 = 内置默认', m0.edgeCount, safety.DEFAULT_EDGE.length)

eq('命中 core 段 -> 1', safety.unsafeLevelOf(['1girl', 'nude', 'smile']), 1)
eq('只命中 edge 段 -> 2', safety.unsafeLevelOf(['1girl', 'underwear']), 2)
eq('干净标签 -> 0', safety.unsafeLevelOf(['1girl', 'looking_at_viewer']), 0)
/* 这条是要害: breasts 命中 93% 的图, 收进集合等于把整个库藏起来 */
eq('breasts 这种"体型"标签刻意不算敏感', safety.unsafeLevelOf(['1girl', 'breasts']), 0)
/* core 比 edge 严: 只命中 edge 的图在 core 档不该藏 */
eq('只命中 edge 的图在 core 档放行', safety.hiddenAt(2, 'core'), false)
eq('只命中 edge 的图在 edge 档隐藏', safety.hiddenAt(2, 'edge'), true)
eq('命中 core 的图两档都隐藏', safety.hiddenAt(1, 'core') && safety.hiddenAt(1, 'edge'), true)
eq('干净的两档都不隐藏', safety.hiddenAt(0, 'core') || safety.hiddenAt(0, 'edge'), false)

/* 单条增删: 保留文件里的注释与分组 */
const t1 = safety.toggleSafetyTag('test_tag_xyz', 'core')
eq('加入一条 -> 在集合里', t1.inSet, true)
eq('加入后 core 条数 +1', t1.coreCount, m0.coreCount + 1)
eq('加入的标签立刻能判命中', safety.unsafeLevelOf(['test_tag_xyz']), 1)
const t2 = safety.toggleSafetyTag('test_tag_xyz', 'core')
eq('再 toggle -> 移出', t2.inSet, false)
eq('移出后条数回到原值', t2.coreCount, m0.coreCount)
eq('移出后不再命中', safety.unsafeLevelOf(['test_tag_xyz']), 0)
eq('反复增删后注释还在(没把用户的分组格式洗掉)',
  fs.readFileSync(tagFile, 'utf8').includes('# 安全模式'), true)

/* 通配规则 */
safety.toggleSafetyTag('*bikini_like*', 'core')
eq('通配规则能命中', safety.unsafeLevelOf(['red_bikini_like_thing']), 1)
eq('被通配命中的标签不重复写入(只回 warning)',
  safety.toggleSafetyTag('red_bikini_like_thing', 'core').wildcard, '*bikini_like*')
safety.toggleSafetyTag('*bikini_like*', 'core')

/* 开关与档位 */
eq('默认关闭', safety.loadSafetyState().on, false)
eq('默认档位 core', safety.loadSafetyState().level, 'core')
safety.saveSafetyState({ on: true, level: 'edge' })
eq('开关注入后读回', safety.loadSafetyState().on, true)
eq('档位注入后读回', safety.loadSafetyState().level, 'edge')
safety.saveSafetyState({ on: false, level: 'core' })
eq('关掉后读回', safety.loadSafetyState().on, false)

/* 坏配置必须回落到"关闭" —— 不能因为一个坏文件就悄悄过滤掉一半图 */
fs.writeFileSync(dataFile('safety.json'), '{这不是 json', 'utf8')
safety.invalidateSafetyCache()
eq('坏配置文件 -> 回落关闭', safety.loadSafetyState().on, false)
eq('坏配置文件 -> 回落 core 档', safety.loadSafetyState().level, 'core')

/* 集合文件被删 -> 用内置默认, 功能不失灵(但不是偷偷改用户的东西) */
fs.writeFileSync(dataFile('safety_tags.txt'), '', 'utf8')
safety.invalidateSafetyCache()
eq('集合文件空了 -> 判定仍可用(内置默认兜底)', safety.unsafeLevelOf(['nude']), 1)

/* ---------------------------------------------------------- 收尾 */

closeDb()
fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
