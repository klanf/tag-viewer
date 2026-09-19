/**
 * 数据安全回归测试 —— 空数据源**绝不能**清空标签库
 * ==================================================
 * 这条测试守的是一个真实的、静默的数据丢失路径(2026-09-19 复现并修掉):
 *
 *   store.js 的 syncSources() 末尾有"配置里已经拿掉的来源就从库里删掉"的逻辑,
 *   目的是让"移除某个来源"能生效。问题在于它**无法区分**下面两件事:
 *     a) 用户真的把来源都删了                -> 该删
 *     b) 数据源配置读不到 / 解析失败 / 里面写的目录不存在  -> 绝不该删
 *   两者在实现里都表现为"dataFiles 是空集合"。
 *
 * 而 (b) 在本项目里是**很容易发生**的: 上一版 config.js 在解析不出来时会兜底成
 * 一个写死在开发机上的绝对路径, 那个路径在别人机器上必然不存在 -> statSync 失败
 * -> 走 continue 跳过导入 -> 然后删除循环把库里 8 个来源 / 81650 张图全删掉。
 *
 * 所以这条测试做两件事:
 *   1. 空集合(含 undefined/null) 调用 -> 库里数据必须原样还在, removed 必须为空;
 *   2. **正向对照**: 传入一个真正的非空来源列表时, "移除已删除来源"的语义必须仍然生效
 *      —— 防止"为了安全把功能改废"。
 *
 * 负向对照(改完请手动确认一次): 把 store.js 里 syncSources 开头那段
 * `if (!dataFiles || dataFiles.size === 0) { ... return ... }` 注释掉, 再跑本测试,
 * 第 1 组断言必须变红。否则它只是装饰。
 *
 * 纯 Node 运行(不启 Electron): node scripts/test-db-safety.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
/** 支持同步/异步断言; 断言里抛出也算失败, 不让整个用例组崩掉 */
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
/** 调用被测方法并把异常也变成"一个有值的返回", 便于继续断言后续用例 */
async function call(fn) {
  try { return { value: await fn(), threw: null } }
  catch (e) { return { value: undefined, threw: e } }
}

/* ---------------- 沙箱 ---------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-dbsafety-'))
const DATA = path.join(tmp, 'data')
const APP = path.join(tmp, 'userdata')
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(APP, { recursive: true })
process.env.TV_DATA_DIR = DATA

const { initWorkspace } = await import('../electron/core/workspace.js')
initWorkspace(APP, { defaultDataDir: DATA })

const store = await import('../electron/core/store.js')
const { resolveDataFiles } = await import('../electron/core/config.js')

/* ---------------- 夹具: 一个 3 条的来源 ----------------
 * 路径故意写成相对形式: 标签文件里的路径只是个字符串, 落地时不要求绝对路径,
 * 同时也免得多出几处会被 scripts/check-paths.mjs 盯上的假路径。
 */
const srcA = path.join(tmp, 'tags_alpha.txt')
fs.writeFileSync(srcA, [
  'pics/a1.png: 1girl, solo, smile',
  'pics/a2.png: 1boy, sword',
  'pics/a3.png: 1girl, hat',
].join('\n') + '\n', 'utf8')

const srcB = path.join(tmp, 'tags_beta.txt')
fs.writeFileSync(srcB, 'pics/b1.png: cat, sitting\n', 'utf8')

console.log('\n[1] 先灌两个来源进库')
const r0 = await store.syncSources(new Map([['alpha', srcA], ['beta', srcB]]))
await ok('导入 2 个来源', () => assert.deepEqual([...r0.imported].sort(), ['alpha', 'beta']))

let info = store.dbInfo()
await ok('库里 2 个来源', () => assert.equal(info.sources, 2))
await ok('库里 4 张图', () => assert.equal(info.images, 4))
await ok('库里有标签', () => assert.ok(info.tags > 0))

console.log('\n[2] 关键: 空数据源不得清库')
const before = store.dbInfo()
for (const [label, empty] of [['空 Map', new Map()], ['undefined', undefined], ['null', null]]) {
  const { value: r, threw } = await call(() => store.syncSources(empty))
  await ok(`syncSources(${label}) 不抛异常`, () => assert.equal(threw, null, threw ? String(threw.message) : ''))
  await ok(`syncSources(${label}) 报 emptySources`, () => assert.equal(r?.emptySources, true))
  await ok(`syncSources(${label}) removed 为空`, () => assert.deepEqual(r?.removed, []))
  await ok(`syncSources(${label}) imported 为空`, () => assert.deepEqual(r?.imported, []))
}
const after = store.dbInfo()
await ok('图片数没变(空源没清库)', () => assert.equal(after.images, before.images))
await ok('来源数没变(空源没清库)', () => assert.equal(after.sources, before.sources))
await ok('标签数没变', () => assert.equal(after.tags, before.tags))

console.log('\n[3] 无配置时 resolveDataFiles 返回空集, 且不含任何机器路径')
const emptyCfg = resolveDataFiles({}, null)
await ok('resolveDataFiles({}) 是空 Map', () => {
  assert.ok(emptyCfg instanceof Map)
  assert.equal(emptyCfg.size, 0)
})
await ok('resolveDataFiles({data_files_dir:"不存在的目录"}) 也是空 Map', () => {
  const m = resolveDataFiles({ data_files_dir: path.join(tmp, 'no-such-dir') }, null)
  assert.equal(m.size, 0)
})

console.log('\n[4] 正向对照: 非空来源时"移除已删除来源"的语义仍要生效')
// 只传 beta, alpha 应当被删掉 —— 这是原本就有的正常功能, 不能被安全守卫改废
const r1 = await store.syncSources(new Map([['beta', srcB]]))
await ok('alpha 被移除', () => assert.deepEqual(r1.removed, ['alpha']))
info = store.dbInfo()
await ok('来源数降到 1', () => assert.equal(info.sources, 1))
await ok('图片数降到 1', () => assert.equal(info.images, 1))

console.log('\n[5] 来源文件读不到时(=路径失效), 不得牵连其他来源')
const r2 = await store.syncSources(new Map([['beta', srcB], ['gone', path.join(tmp, 'missing.txt')]]))
await ok('读不到的来源不报 removed', () => assert.deepEqual(r2.removed, []))
await ok('beta 仍在库里', () => assert.equal(store.dbInfo().images, 1))

/* ---------------- 收尾 ---------------- */
store.closeDb()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
