/**
 * 数据目录布局测试 —— data/ 子目录路由 + 兼容期回退
 * ================================================
 * 守两件事:
 *   ① paths.js 的路由表把该搬的文件都登记了, 且**没有**把 tags.db 这类
 *      刻意留根的文件也搬走;
 *   ② workspace.js 的 dataFile() 在"新位置还没生成"时能回退到根目录的旧文件
 *      —— 这是"先接路由、后搬文件"能分两步做的全部依据。回退一旦坏了,
 *      迁移中途重启就会表现为"所有设置凭空丢失"。
 *
 * 跑法: npm run test:layout
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  DATA_ROUTE, DATA_SUBDIRS, dataRelPath, isRouted, classifyDataEntry,
} from '../electron/core/paths.js'
import { initWorkspace, dataFile } from '../electron/core/workspace.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 本用例自己造数据目录, 绝不能被外面的 TV_DATA_DIR 抢走优先级
delete process.env.TV_DATA_DIR

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`) }
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`) }
const eq = (name, got, want) => (got === want ? ok(name, String(got)) : bad(name, `得到 ${got}, 期望 ${want}`))

/** 用 ascii 的临时目录, 避开 Windows 上中文路径 + 反斜杠的转义噪声 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-layout-'))

console.log('\n[1] 路由表: 登记的名字都进了正确的子目录')
{
  const expect = {
    'local_translations.json': 'kb',
    'character_library.json': 'kb',
    'user_meta.json': 'user',
    'cart_history.json': 'user',
    'scan_folders.json': 'user',
    'export_bg.txt': 'rules',
    'export_blacklist.txt': 'rules',
    'export_replace.txt': 'rules',
    'scan_cache.json': 'cache',
  }
  for (const [name, sub] of Object.entries(expect)) {
    const rel = dataRelPath(name).replace(/\\/g, '/')
    eq(`${name} -> ${sub}/`, rel.split('/')[0], sub)
  }
  // 路由表的每一项都必须能对上 DATA_SUBDIRS 里的真实目录名
  const known = new Set(Object.values(DATA_SUBDIRS))
  let allOk = true
  for (const [name, r] of Object.entries(DATA_ROUTE)) {
    if (!known.has(DATA_SUBDIRS[r.kind])) { bad(`${name} 的 kind=${r.kind} 在 DATA_SUBDIRS 里没有`); allOk = false }
    if (classifyDataEntry(name) === 'unknown') { bad(`${name} 登记了路由, 但 classifyDataEntry 认不出它`); allOk = false }
  }
  if (allOk) ok('路由表与 DATA_SUBDIRS / classifyDataEntry 三方一致')
}

console.log('\n[2] 刻意留根的文件不許被搬走')
{
  for (const name of ['tags.db', 'tags.db-wal', 'tags.db-shm', 'tag_viewer_config.json']) {
    eq(`${name} 留在根`, dataRelPath(name), name)
    eq(`${name} isRouted=false`, isRouted(name), false)
  }
}

console.log('\n[3] weilin_data* 按前缀归 kb(目录名带第三方署名, 不能写死全名)')
{
  for (const name of ['weilin_data(雷昂_Lion@bilibil)', 'weilin_data(测试用)']) {
    const rel = dataRelPath(name).replace(/\\/g, '/')
    eq(`${name} -> kb/`, rel, `kb/${name}`)
  }
  eq('.thumb_cache -> cache/', dataRelPath('.thumb_cache').replace(/\\/g, '/'), 'cache/.thumb_cache')
}

console.log('\n[4] 改名: scan_folders.json 的目标名是 folders.json')
{
  eq('dataRelPath 用新名', dataRelPath('scan_folders.json').replace(/\\/g, '/'), 'user/folders.json')
}

console.log('\n[5] dataFile() 兼容期回退(核心)')
{
  const dataDir = path.join(WORK, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: dataDir })

  // 5.1 两边都没有 -> 报新位置(写入方据此新建)
  eq('都没有 -> 新位置', dataFile('user_meta.json'), path.join(dataDir, 'user', 'user_meta.json'))

  // 5.2 只有根目录的老文件 -> 回退到它(这就是迁移前的老机器状态)
  fs.writeFileSync(path.join(dataDir, 'user_meta.json'), '{}', 'utf8')
  eq('只有根 -> 回退到根', dataFile('user_meta.json'), path.join(dataDir, 'user_meta.json'))

  // 5.3 新位置有了 -> 新位置优先
  fs.mkdirSync(path.join(dataDir, 'user'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'user', 'user_meta.json'), '{}', 'utf8')
  eq('两边都有 -> 新位置优先', dataFile('user_meta.json'), path.join(dataDir, 'user', 'user_meta.json'))

  // 5.4 未登记的名字永远在根, 且不因上面任何事受影响
  eq('tags.db 永远在根', dataFile('tags.db'), path.join(dataDir, 'tags.db'))

  // 5.5 返回值不能含混写分隔符 —— 这次迁移要修的正是这个
  const p = dataFile('user_meta.json')
  const mixed = p.includes('/') && p.includes('\\')
  if (mixed) bad('返回值出现混写分隔符', p)
  else ok('返回值分隔符统一', p)
}

console.log('\n[6] 回退不改变"没登记就不动"的行为')
{
  const weird = ['随便一个.json', 'a.txt']
  for (const n of weird) eq(`未登记 ${n} 原样`, dataFile(n), path.join(WORK, 'data', n))
}

fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
