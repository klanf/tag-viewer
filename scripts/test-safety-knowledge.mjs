/**
 * 知识包缺失时的降级测试(2026-11-08)
 * ================================
 * 守的是 v2.4.0 装出去的那次事故: 打包没带 `knowledge/`, 安装版全新用户
 * 第一次反推落库 -> 读数据集 -> `safety.js` 的 dictLevels 返回 null ->
 * `levelOfTag` 里 `mat.dict[tag]` 抛 `Cannot read properties of null (reading '1girl')`
 * -> dataset 的 SQLite 路线整条报废, 界面只显示"反推一张标签都没落进库"。
 *
 * 开发态永远复现不了(knowledge/ 就在仓库里), 所以这里用 TV_KNOWLEDGE_DIR
 * 指到一个空目录来模拟"装出来的包没有知识包"。
 *
 * 两条断言:
 *   1. 缺知识包: 不崩(unsafeLevelOf 有返回), dict 是空对象而不是 null,
 *      且 safety_tags.txt 覆盖段仍然生效(nude 还是 L4) —— 降级不能连覆盖段一起丢;
 *   2. 知识包在位: dict 非空 —— 否则说明 extraResources 那条路又没生效。
 *
 * 用法: node scripts/test-safety-knowledge.mjs
 *       (两趟各起一个子进程 —— BUNDLED_KNOWLEDGE_DIR 是模块级 const, 同进程换不了)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { ROOT } from './harness.mjs'

const WORK = path.join(ROOT, '.e2e-work', 'knowledge-guard')
const EMPTY_KB = path.join(WORK, 'empty-kb')
const DATA = path.join(WORK, 'data')

/** 子进程探针: 以指定 knowledge 目录跑一次 safety 判定, 结果打到 stdout
 *  (动态 import + 绝对 file URL —— 探针写在 .e2e-work 下, 相对路径会解析错) */
const PROBE = `
const { pathToFileURL } = await import('node:url')
const root = pathToFileURL(process.env.PROBE_ROOT).href
const { initWorkspace } = await import(root + '/electron/core/workspace.js')
const { safetyMatcher, unsafeLevelOf } = await import(root + '/electron/core/safety.js')
initWorkspace(process.env.PROBE_APP)
const m = safetyMatcher()
const dict = m.dict
console.log(JSON.stringify({
  dictIsNull: dict === null,
  dictSize: dict ? Object.keys(dict).length : -1,
  one: unsafeLevelOf(['1girl', 'solo', 'long_hair']),
  nude: unsafeLevelOf(['nude']),
}))
`

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

function probeCase(knowledgeDir) {
  const script = path.join(WORK, 'probe.mjs')
  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(script, PROBE, 'utf8')
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROBE_ROOT: ROOT,
      TV_KNOWLEDGE_DIR: knowledgeDir,
      PROBE_APP: path.join(WORK, 'app'),
      TV_DATA_DIR: DATA,
    },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`探针退出码 ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
  try { return JSON.parse(line) }
  catch { throw new Error(`探针输出不可解析: ${line}`) }
}

console.log('知识包缺失（模拟装出来的包没带 knowledge/）')
fs.mkdirSync(EMPTY_KB, { recursive: true })
fs.rmSync(DATA, { recursive: true, force: true })
const missing = probeCase(EMPTY_KB)
ok('不崩, 且拿到判定结果', () => {
  assert.ok(Number.isFinite(missing.one), `1girl 判定不是数字: ${missing.one}`)
  assert.equal(missing.one, 0)
})
ok('dict 是非 null 对象(2026-11-11 起空包时还剩内置兜底表, 不再是 0 条)', () => {
  assert.equal(missing.dictIsNull, false)
  assert.ok(missing.dictSize > 0, `dict 条数 ${missing.dictSize}`)
  // 内置兜底表条数(~47): 槽位词典缺失时 small_penis 这批仍该有档位
  assert.ok(missing.dictSize < 200, `空包时 dict 不该有几千条, 实际 ${missing.dictSize}`)
})
ok('覆盖段仍生效（nude = L4）', () => assert.equal(missing.nude, 4))

console.log('知识包在位（仓库内 knowledge/）')
fs.rmSync(DATA, { recursive: true, force: true })
const full = probeCase(path.join(ROOT, 'knowledge'))
ok('dict 非空', () => {
  assert.equal(full.dictIsNull, false)
  assert.ok(full.dictSize > 0, `dict 条数 ${full.dictSize}`)
})
ok('普通图仍判 L0', () => assert.equal(full.one, 0))

console.log(`\n${fail === 0 ? '全部通过' : '有失败'} — ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
