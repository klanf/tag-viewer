/**
 * 翻译库目录解析测试 —— 不启动 Electron, 直接用系统 Node 跑
 * =========================================================
 * 守的是 2026-09-19 那次"翻译整体掉了"的事故:
 *   data/tag_viewer_config.json 里的 `translate_dir` 指向
 *   `.../tag_viewer/weilin_data(雷昂_Lion@bilibil)`, 而那个目录早被挪进了数据目录,
 *   于是 WeiLin 静默加载 0 条 —— 界面上所有标签只剩英文, 不报错、日志里也没有一行。
 *
 * 现在规则是(见 electron/core/translate.js 的 resolveWeiLinDirs):
 *   ① 配置路径有效      -> 用配置的(config 优先, 允许指向数据目录外面)
 *   ② 配置空 / 路径失效 -> 在数据目录下自动找 weilin_data*(paths.js 的"知识目录"约定)
 *   ③ 都没有            -> 不启用, 且必须把 dirMissing 标出来, 不许静默
 *
 * 用法: node scripts/test-translate-dir.mjs
 * 沙箱: .e2e-work/translate-test/(每次只用写不用删, 建库时整文件覆盖)
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ROOT } from './harness.mjs'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const importCore = (rel) => import(pathToFileURL(path.join(ROOT, 'electron/core', rel)).href)

/* ---------------- 沙箱: 一个只含 weilin_data* 的数据目录 ---------------- */

const WORK = path.join(ROOT, '.e2e-work', 'translate-test')
const DATA = path.join(WORK, 'data')
const USER_DATA = path.join(WORK, 'userdata')
const WEILIN_NAME = 'weilin_data(测试用)'
const WEILIN_DIR = path.join(DATA, WEILIN_NAME)
const OTHER_DIR = path.join(WORK, '翻译库放这儿也能用')
/** 一个完全空的数据目录, 用来验"哪儿都找不到翻译库"这条降级路径 */
const EMPTY_DATA = path.join(WORK, 'empty-data')
for (const d of [WORK, DATA, USER_DATA, WEILIN_DIR, OTHER_DIR, EMPTY_DATA]) fs.mkdirSync(d, { recursive: true })

/** 造一个最小的 WeiLin 库: 只要表名/列名对得上, 逻辑就能被验证 */
const ROWS = [
  ['uncensored', '无码'],
  ['1girl', '一个女孩'],
  ['long_sleeves', '长袖'],
  ['looking_at_viewer', '看着观众'],
]
function makeDb(dir) {
  const fp = path.join(dir, 'userdatas_zh_CN_danbooru.db')
  fs.rmSync(fp, { force: true })          // 只删我们自己刚造的那一个文件
  const db = new DatabaseSync(fp)
  db.exec('CREATE TABLE danbooru_tag (tag TEXT, translate TEXT)')
  const ins = db.prepare('INSERT INTO danbooru_tag (tag, translate) VALUES (?, ?)')
  for (const [k, v] of ROWS) ins.run(k, v)
  db.close()
  return fp
}
makeDb(WEILIN_DIR)
makeDb(OTHER_DIR)

// workspace 必须在 import translate.js **之前**初始化 —— 自动发现要靠 getWorkspace().dataDir
const { initWorkspace } = await importCore('workspace.js')
const { resolveWeiLinDirs, loadTranslations, translateInfo, translateMany } = await importCore('translate.js')
initWorkspace(USER_DATA, { defaultDataDir: DATA })

// 一个确定不存在的目录, 用来扮演"配置里那个失效路径"。
// 用拼路径而不是写死盘符 —— preflight 会拦硬编码绝对路径(这条规则本身是对的)。
// 这个目录我们**从来不创建**, 所以下面这个前提断言同时也守住了"它确实是失效的"。
const BAD = path.join(WORK, '..', '不存在的翻译库', 'weilin_data(失效)')
assert.equal(fs.existsSync(BAD), false, `前提: 这个路径必须不存在(${BAD})`)

/* ---------------- 1. 目录解析规则 ---------------- */

console.log('目录解析:')

ok('配置留空 -> 自动发现数据目录下的 weilin_data*', () => {
  const r = resolveWeiLinDirs('')
  assert.equal(r.source, 'auto')
  assert.deepEqual(r.dirs, [WEILIN_DIR])
  assert.equal(r.missing, false)
})

ok('配置路径失效 -> 回落到自动发现, 并标出 missing', () => {
  const r = resolveWeiLinDirs(BAD)
  assert.equal(r.source, 'auto')
  assert.deepEqual(r.dirs, [WEILIN_DIR])
  assert.equal(r.missing, true, '必须标出"配置里那路径不存在", 否则又要静默了')
  assert.equal(r.wanted, BAD, 'dirWanted 要留着原路径, 排障时才知道该去改哪儿')
})

ok('配置路径有效 -> 用配置的, 不被自动发现抢走', () => {
  const r = resolveWeiLinDirs(OTHER_DIR)
  assert.equal(r.source, 'config')
  assert.deepEqual(r.dirs, [OTHER_DIR])
  assert.equal(r.missing, false)
})

ok('配置留空且 autoDetect=false -> 不启用(测试里要能关掉自动发现)', () => {
  const r = resolveWeiLinDirs('', { autoDetect: false })
  assert.equal(r.source, 'none')
  assert.deepEqual(r.dirs, [])
})

ok('配置失效且 autoDetect=false -> dirs 为空但 missing 仍为 true', () => {
  const r = resolveWeiLinDirs(BAD, { autoDetect: false })
  assert.equal(r.source, 'none')
  assert.deepEqual(r.dirs, [])
  assert.equal(r.missing, true)
})

/* ---------------- 2. 真的把翻译读出来 ---------------- */

console.log('翻译加载:')

ok('配置留空时能查到中文(端到端: 自动发现 -> 读 SQLite)', () => {
  loadTranslations('')
  const ti = translateInfo()
  assert.equal(ti.weilin, ROWS.length, `weilin=${ti.weilin} 应等于 ${ROWS.length}`)
  assert.equal(ti.dirSource, 'auto')
  assert.equal(translateMany(['1girl'])['1girl'], '一个女孩')
})

ok('配置路径失效时仍然查得到中文, 而且 error 里点名了那个坏路径', () => {
  loadTranslations(BAD)
  const ti = translateInfo()
  assert.equal(ti.weilin, ROWS.length)
  assert.equal(ti.dirMissing, true)
  assert.ok(ti.error.includes(BAD), `error 里应出现失效路径, 实际: ${ti.error}`)
  assert.equal(translateMany(['uncensored'])['uncensored'], '无码')
})

ok('配置路径有效 -> dirSource=config', () => {
  loadTranslations(OTHER_DIR)
  const ti = translateInfo()
  assert.equal(ti.weilin, ROWS.length)
  assert.equal(ti.dirSource, 'config')
  assert.equal(ti.dirMissing, false)
})

ok('两头都没有 -> 不崩, 只是没有翻译(而不是抛异常)', () => {
  // 换一个**空**数据目录重新初始化 workspace —— 自动发现也该一无所获
  initWorkspace(USER_DATA, { defaultDataDir: EMPTY_DATA })
  try {
    loadTranslations('')
    const ti = translateInfo()
    assert.equal(ti.weilin, 0)
    assert.equal(ti.dirSource, 'none')
    assert.equal(ti.dirMissing, false, '配置留空不算"路径失效"')
    assert.equal(ti.loaded, true, '没翻译也算"加载完毕", 不能卡在 loading')
  } finally {
    initWorkspace(USER_DATA, { defaultDataDir: DATA })   // 还原, 免得影响后续断言
  }
})

/* ---------------- 汇总 ---------------- */

console.log(`\n翻译目录解析: ${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
