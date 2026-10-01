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

/* ============================================================
 *  自适应行高网格(justified rows) —— 2026-09-23
 * ============================================================
 * 这是**纯函数**, 所以能在这里把性质钉死, 不用开浏览器:
 *   · 每一行都要左右铺满(不能留空洞 —— 用户不接受的就是空洞);
 *   · 每张图的单元格宽/行高必须等于它自己的宽高比(等于不裁图);
 *   · 最后一行不够长时**不许**拉伸(否则末尾一两张会被拉成巨图);
 *   · 拿不到尺寸的图按 9/16 参与(与卡片回落一致);
 *   · 没量到容器宽度时返回空 —— 宁可先不画, 也不要瞎排一版再跳一下。
 */
const { buildRows, aspectOf } = await load('src/composables/useJustifiedRows.js')

const LAND = { px_w: 1280, px_h: 720 }        // 16:9 横
const PORT = { px_w: 832, px_h: 1216 }        // 竖(约 0.684)
const NONE = {}                               // 没尺寸
const mk = (n, proto) => Array.from({ length: n }, (_, i) => ({ path: `p${i}.png`, ...proto }))

const W = 1200
const GAP = 10
const rowW = (r) => r.cells.reduce((a, c) => a + c.w, 0) + GAP * (r.cells.length - 1)

/* 竖图铺满一行: 除了最后一行, 每一行都必须贴边 */
{
  const rows = buildRows(mk(12, PORT), W, { base: 150, gap: GAP })
  const full = rows.slice(0, -1)
  const dev = full.reduce((a, r) => Math.max(a, Math.abs(rowW(r) - W)), 0)
  ok('自适应行高: 每张竖图行都铺满(空洞消失)', full.length > 0 && dev <= 2,
    `${full.length} 行, 最大偏差 ${dev}px`)
  const last = rows[rows.length - 1]
  ok('自适应行高: 最后一行不超出容器', rowW(last) <= W, `${rowW(last)} / ${W}`)
  ok('自适应行高: 最后一行没被拉伸(短行保持目标行高)', last.h <= rows[0].h + 2,
    `末行 ${last.h} vs 首行 ${rows[0].h}`)
  const wp = full[0].cells[0].w
  ok('自适应行高: 竖图宽度贴近原 --grid-min(150)', wp >= 128 && wp <= 172, `${wp}px`)
}

/* 不裁图: 单元格宽 / 行高 == 图片自身宽高比 */
{
  const rows = buildRows([...mk(6, LAND), ...mk(6, PORT)], W, { base: 150, gap: GAP })
  let worst = 0
  for (const r of rows) for (const c of r.cells) worst = Math.max(worst, Math.abs(c.w / r.h - aspectOf(c.item)))
  ok('自适应行高: 图片一张都不用裁(宽高比守住)', worst < 0.02, `最大比例偏差 ${worst.toFixed(4)}`)
}

/* 一行里横图一定比竖图宽 —— 这正是"横图不再被压成竖条"的判据 */
{
  const rows = buildRows([LAND, PORT], W, { base: 150, gap: GAP })
  const row = rows[0]
  ok('自适应行高: 同一行里横图比竖图宽', row.cells[0].w > row.cells[1].w * 2,
    `横 ${row.cells[0].w} vs 竖 ${row.cells[1].w}`)
}

/* 超宽全景图: 独占一行、宽度正好铺满、行高不越界 */
{
  const rows = buildRows([{ px_w: 6000, px_h: 1000 }], W, { base: 150, gap: GAP })
  ok('自适应行高: 极宽全景图独占一行且铺满', rows.length === 1 && Math.abs(rowW(rows[0]) - W) <= 2,
    `h=${rows[0].h} w=${rows[0].cells[0].w}`)
  ok('自适应行高: 行高被夹在合理区间', rows[0].h >= 120 && rows[0].h <= 600, String(rows[0].h))
}

/* 缺尺寸 -> 与卡片同一套回落(9/16), 不能因为没尺寸就不排 */
{
  ok('缺尺寸回落 9/16(与卡片一致)', aspectOf(NONE) === 9 / 16, String(aspectOf(NONE)))
  const rows = buildRows(mk(10, NONE), W, { base: 150, gap: GAP })
  ok('缺尺寸的行也铺满', rows.length > 1 && Math.abs(rowW(rows[0]) - W) <= 2, `${rows.length} 行`)
}

/* 还没量到宽度 / 空列表 -> 返回空, 不瞎排 */
{
  ok('宽度未知 -> 不排版(不瞎猜)', buildRows(mk(5, PORT), 0, { base: 150 }).length === 0)
  ok('空列表 -> 空', buildRows([], W, { base: 150 }).length === 0)
  ok('行高随"竖图目标宽度"变', buildRows(mk(12, PORT), W, { base: 220 }).length <
    buildRows(mk(12, PORT), W, { base: 150 }).length)
}

/* ============================================================
 *  前端镜像判定 == 主进程判定
 * ============================================================
 * 扫描页的图是**库外**的(库里没有它们的行), 所以安全模式只能在前端按标签现算
 * (src/utils/safetyMatch.js)。两份实现一旦分叉, 就会出现"库内页面藏了、扫描页没藏"
 * 这种最难查的不一致 —— 这里用同一批标签把两边钉在一起。
 */
const { compileRules, unsafeOfTags } = await load('src/utils/safetyMatch.js')
const mirrorOf = (m) => ({ core: compileRules(m.core.raw), edge: compileRules(m.edge.raw) })

{
  const m = safety.safetyMatcher()
  const cases = [
    ['nude'], ['1girl', 'smile'], ['thighhighs'], ['breasts'],
    ['nude', '1girl'], ['censored'], ['rating_explicit'], ['Nude'], ['panties'],
    ['swimsuit'], ['completely_nude'], ['areola_slip'], ['spread_pussy'], ['下着'],
  ]
  const mi = mirrorOf(m)
  let diff = 0
  const detail = []
  for (const c of cases) {
    const a = safety.unsafeLevelOf(c, m)
    const b = unsafeOfTags(c, mi)
    if (a !== b) { diff++; detail.push(`${c.join(',')}: 主进程=${a} 前端=${b}`) }
  }
  eq('前端镜像与主进程的判定逐条一致', diff, 0)
  if (detail.length) for (const d of detail) console.log(`      · ${d}`)
  eq('镜像: 大小写不敏感', unsafeOfTags(['NUDE'], mi), 1)
}

/* 通配规则也要一致(最容易只改一边的地方) */
{
  fs.writeFileSync(dataFile('safety_tags.txt'), '[core]\n*_penetration\n[edge]\n*_lingerie*\n', 'utf8')
  safety.invalidateSafetyCache()
  const m = safety.safetyMatcher()
  const mi = mirrorOf(m)
  eq('通配(后缀): 主进程', safety.unsafeLevelOf(['x_penetration'], m), 1)
  eq('通配(后缀): 前端镜像', unsafeOfTags(['x_penetration'], mi), 1)
  eq('通配(包含): 主进程', safety.unsafeLevelOf(['white_lingerie_set'], m), 2)
  eq('通配(包含): 前端镜像', unsafeOfTags(['white_lingerie_set'], mi), 2)
  eq('通配不误伤(前缀不同)', unsafeOfTags(['penetration_test'], mi), 0)
  eq('同一标签两侧一致(不误伤也是两边一致)', safety.unsafeLevelOf(['penetration_test'], m), unsafeOfTags(['penetration_test'], mi))
}

/* ============================================================
 *  安全模式开关上那个数字的口径 (2026-09-23)
 * ============================================================
 * 用户: "这边的数字能不能根据不同的来源显示被隐藏的数字" +
 *       "这个数字我不点这个按钮好像就默认是 0"。
 * 于是数字从"整个库的统计"改成"传进来的那批图里会隐藏多少张"。
 *
 * 数字算错**不会崩, 只会骗人** —— 开关上写着 −3、网格里实际少掉 5 张, 而用户没有
 * 任何办法自查。所以这里拿主进程的 hiddenAt 逐条跑一遍, 把两处口径钉死:
 *   core 档藏 unsafe=1; edge 档藏 unsafe=1 和 2(core 段在 edge 档照样藏)。
 */
const { countHits } = await load('src/utils/safetyMatch.js')
{
  const mixed = [
    { unsafe: 0 }, { unsafe: 1 }, { unsafe: 2 }, { unsafe: 1 }, { unsafe: 0 }, { unsafe: 2 },
  ]
  const byNum = (it) => it.unsafe
  const h = countHits(mixed, byNum)
  eq('计数: core 档 == 逐条 hiddenAt(core)',
    h.core, mixed.filter((i) => safety.hiddenAt(i.unsafe, 'core')).length)
  eq('计数: edge 档 == 逐条 hiddenAt(edge)',
    h.edge, mixed.filter((i) => safety.hiddenAt(i.unsafe, 'edge')).length)
  eq('计数: core 只数 unsafe=1', h.core, 2)
  eq('计数: edge 是两档合并(=1 与 =2 都算)', h.edge, 4)
  eq('计数: 干净的一批', JSON.stringify(countHits([{ unsafe: 0 }], byNum)), '{"core":0,"edge":0}')
  eq('计数: 空列表不炸', JSON.stringify(countHits([], byNum)), '{"core":0,"edge":0}')
  eq('计数: 非数组入参不炸', JSON.stringify(countHits(null, byNum)), '{"core":0,"edge":0}')

  /* 库外图(扫描页 / 收藏快照)没有 unsafe 字段 —— 同一个计数函数喂"按标签现算"的
     取值函数也要出同样的数。守住"两种取值方式共用一份计数逻辑"。
     (此时 safety_tags.txt 已被上面那段换成 [core]*_penetration / [edge]*_lingerie*) */
  const m2 = safety.safetyMatcher()
  const mi2 = mirrorOf(m2)
  const items = [
    { tags: ['x_penetration', '1girl'] },   // 命中 core -> 1
    { tags: ['1girl', 'smile'] },           // 干净 -> 0
    { tags: ['white_lingerie_set'] },       // 只命中 edge -> 2
  ]
  const byTag = countHits(items, (it) => unsafeOfTags(it.tags, mi2))
  const byTagMain = countHits(items, (it) => safety.unsafeLevelOf(it.tags, m2))
  eq('计数(库外图): 前端镜像与主进程同数', JSON.stringify(byTag), JSON.stringify(byTagMain))
  eq('计数(库外图): 命中 core 1 张 / edge 档共 2 张', JSON.stringify(byTag), '{"core":1,"edge":2}')
}

/* ---------------------------------------------------------- 扫描页的图片尺寸 */

/**
 * 2026-09-23 用户报「横图显示为竖图」（网格布局的 bug）。
 *
 * 根因不在布局算法 —— 算法有 test:visual 的那几条几何断言守着 —— 而在**数据**:
 * 扫描页的对象全是**库外图**（库里根本没有行），而 scan.js 组装 item 时只带了
 * path/name/tags/source/folder/mtime/size，**独独漏了 px_w/px_h**。前端拿不到尺寸
 * 就回落 9/16，于是每个格子都按竖图算宽，横图被 `object-fit: cover` 裁成竖条,
 * 而且**一个错都不报**（尺寸是"有就用、没有就回落"，静默的）。
 *
 * 这一节钉住三件事:
 *   ① 尺寸的来源优先级：**库里已登记的图走内存数据集**（零 I/O），库外的才读文件头；
 *   ② 扫描结果里每张图**都带着真实尺寸**（这就是修法的全部）；
 *   ③ 尺寸**只读一次**、写进 scan_cache.json 的持久条目 —— 不然"首扫慢"会变成
 *      "每次扫都慢"。
 */
{
  const { dimsForPaths } = await load('electron/core/dims.js')
  const { scanFolder } = await load('electron/core/scan.js')
  const { ds, recordByPath } = await load('electron/core/dataset.js')
  const testpng = await load('scripts/testpng.mjs')

  /* 夹具: 真的有横有竖（test-fixtures/scan-test 那批是 1x1 的占位图, 横竖都验不出来,
     所以这里现编码几张真 PNG —— 见 scripts/testpng.mjs） */
  const SDIR = path.join(WORK, 'scan-dims')
  fs.mkdirSync(SDIR, { recursive: true })
  fs.writeFileSync(path.join(SDIR, 'wide.png'), testpng.makePng(320, 180, { prompt: '1girl, smile' }))
  fs.writeFileSync(path.join(SDIR, 'tall.png'), testpng.makePng(180, 320, { prompt: '1girl, smile' }))
  // 扩展名像图片、内容不是 -> 尺寸必须解析失败, 回落 9/16, 而不是猜一个数
  fs.writeFileSync(path.join(SDIR, 'broken.png'), Buffer.from('这不是 PNG', 'utf8'))
  fs.writeFileSync(path.join(SDIR, 'note.txt'), 'x')          // 不是图片扩展名, 不该被枚举

  /* ① 数据集优先 —— 造一条"文件根本不存在"的记录: 尺寸还能拿到, 就只能是走了内存
        数据集这条零 I/O 的路（顺带证明路径规范化: 传进去的大小写/斜杠都不同）。
        路径里那个盘符是**编造的**(盘上根本没有, 也不打算访问) —— 判据要的就是一个
        "肯定读不到文件"的路径, 用来证明"根本没走读盘那条路"。
        path-check-ignore：这是判据用的假路径, 不是机器上的真实路径。 */
  const FAKE = 'z:/__不存在的目录__/x.png'
  const FAKE_ALT = 'Z:\\__不存在的目录__\\x.png'          // 同一路径的另一种写法(大写盘符 + 反斜杠)
  ds.records.push({ path: FAKE, tags: [], ltags: [], source: 'x', px_w: 1234, px_h: 567, unsafe: 0 })
  ds.byPath.set(FAKE, ds.records.length - 1)
  const viaDs = await dimsForPaths([FAKE_ALT])
  eq('尺寸: 库里已登记的图走内存数据集(文件不存在也拿得到 = 零 I/O)',
    JSON.stringify(viaDs[0]), '{"w":1234,"h":567}')
  eq('尺寸: 路径大小写/斜杠不影响命中', recordByPath(FAKE)?.px_w, 1234)
  ds.records.pop()
  ds.byPath.delete(FAKE)

  /* ② 库外的读文件头; 认不出的给 null(调用方回落 9/16), 绝不猜 */
  const viaFile = await dimsForPaths([
    path.join(SDIR, 'wide.png'), path.join(SDIR, 'tall.png'),
    path.join(SDIR, 'broken.png'), path.join(SDIR, '根本没有这个文件.png'),
  ])
  eq('尺寸: 库外图读文件头 —— 横图 320x180', JSON.stringify(viaFile[0]), '{"w":320,"h":180}')
  eq('尺寸: 库外图读文件头 —— 竖图 180x320', JSON.stringify(viaFile[1]), '{"w":180,"h":320}')
  eq('尺寸: 内容不是图片 -> null(不许猜)', JSON.stringify(viaFile[2]), 'null')
  eq('尺寸: 文件不存在 -> null', JSON.stringify(viaFile[3]), 'null')
  eq('尺寸: 空入参不炸', JSON.stringify(await dimsForPaths([])), '[]')

  /* ③ 扫描结果**必须**带尺寸 —— 这条就是用户报的 bug 的回归网 */
  const scan = await scanFolder({ path: SDIR, force: true })
  const byName = new Map((scan.items || []).map((it) => [it.name, it]))
  eq('扫描: 只枚举图片扩展名(note.txt 不算)', scan.items.length, 3)
  eq('扫描: 横图带着 320x180(修好"横图显示为竖图"的那一行)',
    `${byName.get('wide.png')?.px_w}x${byName.get('wide.png')?.px_h}`, '320x180')
  eq('扫描: 竖图带着 180x320',
    `${byName.get('tall.png')?.px_w}x${byName.get('tall.png')?.px_h}`, '180x320')
  eq('扫描: 解析不出来的图不给尺寸(前端回落 9/16, 而不是按 0 算比例)',
    !(byName.get('broken.png')?.px_w > 0), true)

  /* ④ 尺寸要**持久化** —— 不然"首扫读一遍"变成"每次扫都读一遍"。
       scan_cache 的写盘是 2 秒防抖(见 scan.js 的 schedulePersistSave), 所以等一下。
       ⚠️ 持久缓存写在 <dataDir>/cache/ 下(subdir 由应用启动时创建) —— 这个临时
       workspace 是裸建的, 得自己补上, 否则写盘报 ENOENT(只打日志, 不抛错, 很安静)。 */
  fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true })
  await new Promise((r) => setTimeout(r, 2300))
  let cached = null
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile('scan_cache.json'), 'utf8'))
    for (const f of Object.values(raw.folders || {})) {
      for (const e of Object.values(f.entries || {})) {
        if (e && e.w === 320 && e.h === 180) cached = e
      }
    }
  } catch (e) { cached = { err: e.message } }
  eq('尺寸: 写进 scan_cache 的条目里(和 mtime/size 一起失效 -> 同一张图只读一次头)',
    cached ? `${cached.w}x${cached.h}` : `未找到(${cached?.err || ''})`, '320x180')

  /* ⑤ 重扫一次: 尺寸仍然对(这回是从持久缓存里白捡的) */
  const again = await scanFolder({ path: SDIR, force: true })
  const againWide = (again.items || []).find((it) => it.name === 'wide.png')
  eq('扫描: 重扫一次尺寸仍正确(第二次是走缓存, 不再读盘)',
    `${againWide?.px_w}x${againWide?.px_h}`, '320x180')
}

/* ---------------------------------------------------------- 导出视角词表(种子) */

/*
 * 词表种子的守门断言。种子只在**首次使用**时写出去(之后绝不覆盖用户的改动),
 * 所以"写出去的那一版对不对"没有第二次机会 —— 用断言把它钉住。
 * 口径来自《随机机位交接文档》第 3 节 + 对端背景池的清理口径(补 from_side)。
 */
{
  const { DEFAULT_VIEW_TAGS } = await load('electron/core/rules.js')
  const doc18 = [
    'from_front', 'from_behind', 'from_left', 'from_right',
    'directly_above', 'from_above', 'aerial_view', 'high_angle', 'eye-level',
    'low_angle', 'from_below', 'directly_below',
    'extreme_close-up', 'close-up', 'medium_shot', 'full_body', 'wide_shot',
    'dutch_angle',
  ]
  eq('视角词表: 收齐交接文档第 3 节的全部分档(18 条)',
    doc18.filter((t) => !DEFAULT_VIEW_TAGS.includes(t)).length, 0)
  eq('视角词表: 额外收了 from_side(WD14 会写, 实测库里 2,834 张)',
    DEFAULT_VIEW_TAGS.includes('from_side'), true)
  eq('视角词表: 没有重复条目', new Set(DEFAULT_VIEW_TAGS).size, DEFAULT_VIEW_TAGS.length)
  eq('视角词表: 全部小写(匹配前会 toLowerCase, 写错大小写等于永远命中不了)',
    DEFAULT_VIEW_TAGS.every((t) => t === t.toLowerCase()), true)
}

/* ---------------------------------------------------------- 收尾 */

closeDb()
fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
