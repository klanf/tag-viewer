/**
 * 文件夹登记表测试 —— 阶段 4 的 enabler
 * ====================================
 * 改造前「扫描夹」和「看板来源」是两本账(scan_folders.json / tags_*.txt 的文件名),
 * 现在都是 `folders` 表里的一行。这个测试守的是**合并之后才成立的那几条性质**:
 *
 *   ① 一个目录只有一个身份 —— 同一目录用反斜杠/大写盘符再加一次, 不该多出一行。
 *      这条最容易坏: 只要有一处忘了过 normFolderPath, 就会出现"改了一行、
 *      列表读的是另一行"的鬼影。
 *   ② 移出登记表 = 开关归零, **行还在** —— 误删要能一键恢复, 且库里的图片
 *      记录一条都不能掉(掉了看板上会出现一个空名字的来源)。
 *   ③ 彻底清除才是真删 —— 而且只删库里的记录, 磁盘文件一个都不动。
 *   ④ 用途开关各自独立 —— as_scan 的目录不能被当成看板来源(反之亦然)。
 *   ⑤ 导出备份(user/folders.json)与库内的行一一对应。
 *
 * 跑法: npm run test:folders
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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-folders-'))
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

function seed(dir, n, withPrompt = 1) {
  for (let i = 0; i < n; i++) {
    const t = i < withPrompt ? `1girl, solo, tag_${i}` : ''
    fs.writeFileSync(path.join(dir, `p${i}.png`), makePng(t))
  }
}

seed(DIR_A, 3, 2)
seed(DIR_B, 1, 0)

const norm = (p) => store.normalizeImagePath(p)
const listScan = () => folders.listFolders({ usage: 'scan' }).folders
const listSource = () => folders.listFolders({ usage: 'source' }).folders
const listAll = () => folders.listFolders({ usage: 'all' }).folders

/* ---------------------------------------------------------- [1] 添加 */

console.log('\n[1] 添加一个扫描夹(扫描页的老用法)')
{
  const r = await folders.addFolder({ path: DIR_A })
  eq('添加成功', r.ok, true)
  eq('是新增', r.added, true)
  eq('默认 as_scan=1', r.folder.as_scan, true)
  eq('默认 as_source=0(不会因为在扫描页点一下就变成看板来源)', r.folder.as_source, false)
  eq('扫到 3 张', r.folder.stats.total, 3)
  eq('其中 2 张含提示词', r.folder.stats.with_prompt, 2)

  eq('扫描夹列表 1 条', listScan().length, 1)
  eq('看板来源列表 0 条', listSource().length, 0)
  eq('卡片带 name(取 label 或目录名)', listScan()[0].name, path.basename(DIR_A))
}

/* ---------------------------------------------------------- [2] 路径归一 */

console.log('\n[2] 路径写法归一 —— 同一个目录不能长出两行')
{
  // 反斜杠 + 大写盘符(Windows 弹窗/粘贴进来的原始形态)
  const messy = String(DIR_A).toUpperCase()
  const r = await folders.addFolder({ path: messy })
  eq('识别为已存在, 不是新增', r.added, false)
  eq('登记表仍然只有 1 行', listAll().length, 1)
  eq('normFolderPath 与 normalizeImagePath 同一套', folders.normFolderPath(DIR_A), norm(DIR_A))

  const up = await folders.addFolder({ path: DIR_B })
  eq('第二个目录是新增', up.added, true)
  eq('登记表 2 行', listAll().length, 2)

  const db = store.openDb()
  eq('库里的 path 全是正斜杠', db.prepare(`SELECT COUNT(*) n FROM folders WHERE path LIKE '%\\%'`).get().n, 0)
}

/* ---------------------------------------------------------- [3] 改用途 */

console.log('\n[3] 用途开关: 扫描夹 <-> 看板来源')
{
  const r = folders.updateFolder({ path: DIR_B, as_source: true, label: '壁纸来源' })
  eq('更新成功', r.ok, true)
  eq('as_source 已打开', r.folder.as_source, true)
  eq('as_scan 保持 1(追加用途, 不是替换)', r.folder.as_scan, true)
  eq('改名生效(列表里的 name 跟着变)', listSource()[0].name, '壁纸来源')

  const names = store.sourceNameList()
  eq('来源名单里有它', names.includes('壁纸来源'), true)
  eq('来源名单只有 1 个', names.length, 1)

  // 只看不进的目录不该出现在来源名单里
  eq('纯扫描夹不在来源名单', names.includes(path.basename(DIR_A)), false)
}

/* ---------------------------------------------------------- [4] 入库图数 */

console.log('\n[4] 卡片/列表要显示的「库内图数」')
{
  const db = store.openDb()
  const fid = db.prepare('SELECT id FROM folders WHERE path = ?').get(norm(DIR_B)).id
  db.prepare('INSERT INTO images (path, src_id, folder_id, tags, tags_src) VALUES (?,0,?,?,\'meta\')')
    .run(norm(path.join(DIR_B, 'p0.png')), fid, '1girl,solo')
  eq('DIR_B 的图数 = 1', listAll().find((f) => f.path === norm(DIR_B)).images, 1)
  eq('DIR_A 的图数 = 0', listAll().find((f) => f.path === norm(DIR_A)).images, 0)
}

/* ---------------------------------------------------------- [5] 移出登记表 */

console.log('\n[5] 移出登记表: 开关归零, 行还在, 图片记录不掉')
{
  const r = folders.removeFolder({ path: DIR_B })
  eq('移出成功', r.ok, true)
  eq('已不在看板来源列表', listSource().length, 0)
  eq('已不在扫描夹列表', listScan().map((f) => f.path).includes(norm(DIR_B)), false)
  eq('但行还在(可恢复)', listAll().length, 2)

  const db = store.openDb()
  eq('图片记录没被删', db.prepare('SELECT COUNT(*) n FROM images WHERE folder_id = ?')
    .get(db.prepare('SELECT id FROM folders WHERE path = ?').get(norm(DIR_B)).id).n, 1)
  eq('来源名单也不再有它', store.sourceNameList().includes('壁纸来源'), false)

  const back = folders.updateFolder({ path: DIR_B, as_source: true, as_scan: true })
  eq('恢复: 打回开关即可', back.folder.as_source, true)
  eq('恢复后行列里回来', listSource().length, 1)
}

/* ---------------------------------------------------------- [6] 导出备份 */

console.log('\n[6] 导出备份')
{
  const r = folders.exportFoldersJson()
  eq('导出成功', r.ok, true)
  eq('导出 2 条', r.folders, 2)
  eq('落在路由后的位置(user/folders.json)', r.file.replace(/\\/g, '/').endsWith('/user/folders.json'), true)

  const disk = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  eq('文件里的条数', disk.folders.length, 2)
  eq('文件与库同名同路径', disk.folders.map((f) => f.path).join('|'), listAll().map((f) => f.path).join('|'))
}

/* ---------------------------------------------------------- [7] 彻底清除 */

console.log('\n[7] 彻底清除(高危): 只删库内记录, 不动磁盘')
{
  const r = folders.purgeFolder({ path: DIR_B })
  eq('清除成功', r.ok, true)
  eq('报告删掉 1 张记录', r.purged.images, 1)

  const db = store.openDb()
  eq('登记行已删', db.prepare('SELECT COUNT(*) n FROM folders WHERE path = ?').get(norm(DIR_B)).n, 0)
  eq('图片记录已删', db.prepare(`SELECT COUNT(*) n FROM images WHERE path LIKE '%p0.png'`).get().n, 0)
  eq('磁盘文件还在', fs.existsSync(path.join(DIR_B, 'p0.png')), true)
  eq('登记表剩 1 行', listAll().length, 1)
}

/* ---------------------------------------------------------- [8] 边界 */

console.log('\n[8] 边界: 不存在的目录 / 空路径 / 未登记')
{
  const a = await folders.addFolder({ path: path.join(WORK, 'not-there') })
  eq('目录不存在 -> 明确报错', /不存在/.test(a.error || ''), true)

  const b = await folders.addFolder({ path: '   ' })
  eq('空路径 -> empty path', b.error, 'empty path')

  const c = folders.updateFolder({ path: path.join(WORK, 'not-there') })
  eq('改未登记的目录 -> not in list', c.error, 'not in list')

  const d = folders.removeFolder({ path: path.join(WORK, 'not-there') })
  eq('移出未登记的目录 -> not in list', d.error, 'not in list')
}

/* ---------------------------------------------------------- 收尾 */

// 必须显式关库: store.js 的句柄是模块级单例, 持有它就删不掉沙箱目录
// (Windows 上表现为 EBUSY: resource busy or locked ... tags.db)
store.closeDb()
fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
