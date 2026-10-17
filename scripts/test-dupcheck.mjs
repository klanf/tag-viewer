/**
 * dupcheck 查重测试(2026-10-17) —— 纯 Node, 临时库, 不启 Electron
 * 覆盖: 相同 tag 集合成组 / 链式合并(A≈B,B≈C) / 不同角色惩罚把 D 排除 /
 *       无关图不误报 / gone 与空 tags 排除 / best=最大分辨率 / 阈值敏感性 /
 *       共享 tag 列表按权重排序
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const load = async (p) => await import(new URL(`../${p}`, import.meta.url))
const workspace = await load('electron/core/workspace.js')
const store = await load('electron/core/store.js')
const dupcheck = await load('electron/core/dupcheck.js')

let n = 0
function ok(name, fn) {
  try { fn(); console.log('  ✓', name); n++ }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1 }
}

/* ---------- 构造临时库 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-test-'))
workspace.initWorkspace(tmp, { defaultDataDir: path.join(tmp, 'data') })
const db = store.openDb()

const P = (name) => path.join(tmp, 'img', name).replaceAll('\\', '/')
const ins = db.prepare(
  `INSERT INTO images (path, src_id, folder_id, tags, tags_src, gone, px_w, px_h, size)
   VALUES (?, 0, 1, ?, 'test', ?, ?, ?, ?)`
)
const KA = 'kazusa_(blue_archive)', MI = 'miko_(blue_archive)', BA = 'blue_archive',
      SU = 'school_uniform', SM = 'smile', ONE = '1girl'
const base5 = [KA, BA, SU, SM, ONE].join(',')
const rows = [
  ['a.png', base5, 0, 2000, 2000, 900],
  ['b.png', base5 + ',outdoors', 0, 1000, 1000, 500],
  ['c.png', base5 + ',classroom', 0, 500, 500, 300],
  ['d.png', [MI, BA, SU, SM, ONE].join(','), 0, 3000, 3000, 800],
  ['e.png', 'holo,wolf,tail', 0, 800, 600, 100],
  ['f.png', 'holo,wolf,tail', 0, 100, 100, 10],
  ['g-gone.png', base5, 1, 4000, 4000, 999],   // gone=1: 必须被排除
  ['h-empty.png', '', 0, 100, 100, 1],          // 空 tags: 必须被排除
]
for (const [p, tags, gone, w, h, size] of rows) ins.run(P(p), tags, gone, w, h, size)

function groupIds(r) {
  return r.groups.map((g) => g.items.map((it) => path.basename(it.path)).sort().join('+'))
}
function groupOf(r, name) {
  return r.groups.find((g) => g.items.some((it) => path.basename(it.path) === name))
}

/* ---------- 断言 ---------- */
console.log('① 基本扫描口径')
let r = dupcheck.findDuplicateGroups({ threshold: 0.65 })
ok('gone=1 与空 tags 都被排除: scanned=6', () => assert.equal(r.scanned, 6))
ok('耗时在合理量级(<5s)', () => assert.ok(r.elapsedMs < 5000, String(r.elapsedMs)))

console.log('② 分组正确性 (threshold=0.65)')
ok('恰分两组: {e,f} 与 {a,b,c}', () => {
  assert.deepEqual(groupIds(r).sort(), ['a.png+b.png+c.png', 'e.png+f.png'])
})
ok('e/f 相同 tag 集合 → score=1', () => {
  const g = groupOf(r, 'e.png')
  assert.ok(Math.abs(g.score - 1) < 1e-9, String(g.score))
})
ok('保留建议 = 分辨率最大(a.png 2000²)', () => {
  const g = groupOf(r, 'a.png')
  assert.equal(g.items[0].best, true)
  assert.equal(path.basename(g.items[0].path), 'a.png')
  assert.ok(g.items.every((it, i) => i === 0 || !it.best))
})
ok('链式合并: b-c 直连 0.558<0.7 但经 a 连通仍同组', () => {
  const g = groupOf(r, 'b.png')
  assert.deepEqual(g.items.map((it) => path.basename(it.path)).sort(), ['a.png', 'b.png', 'c.png'])
})
ok('不同角色惩罚: d.png 不与 a/b/c 同组', () => {
  const g = groupOf(r, 'a.png')
  assert.ok(!g.items.some((it) => path.basename(it.path) === 'd.png'))
})
ok('d.png 自身不成组(单元素组不返回)', () => {
  assert.ok(!groupOf(r, 'd.png'))
})
ok('无关图不误报: holo/wolf/tail 只与 e/f 同组', () => {
  const g = groupOf(r, 'e.png')
  assert.deepEqual(g.items.map((it) => path.basename(it.path)).sort(), ['e.png', 'f.png'])
})
ok('共享 tag 按权重排序(角色 tag 最前)', () => {
  const g = groupOf(r, 'a.png')
  assert.equal(g.shared[0], KA)
  assert.ok(g.shared.length >= 5)
})

console.log('③ 阈值敏感性')
r = dupcheck.findDuplicateGroups({ threshold: 0.95 })
ok('threshold=0.95 只剩完全相同的 {e,f}', () => assert.deepEqual(groupIds(r), ['e.png+f.png']))
r = dupcheck.findDuplicateGroups({ threshold: 0.3 })
ok('threshold=0.3 时 d 仍不并入(惩罚后 0.276<0.3; 无惩罚本应 0.552 并入)', () => {
  const g = groupOf(r, 'a.png')
  assert.ok(!g.items.some((it) => path.basename(it.path) === 'd.png'))
})
r = dupcheck.findDuplicateGroups({ threshold: 0.2 })
ok('threshold=0.2 时 d 并入 → {a,b,c,d} 一组(惩罚只在低阈值放开)', () => {
  const g = groupOf(r, 'a.png')
  assert.deepEqual(g.items.map((it) => path.basename(it.path)).sort(), ['a.png', 'b.png', 'c.png', 'd.png'])
})

console.log('④ 空库/无候选安全')
ok('全新空库不炸', () => {
  store.closeDb()   // 库句柄是单例, 先关再换 workspace 才真的指向新目录
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-empty-'))
  workspace.initWorkspace(tmp2, { defaultDataDir: path.join(tmp2, 'data') })
  const r2 = dupcheck.findDuplicateGroups({})
  assert.deepEqual(r2.groups, [])
  assert.equal(r2.scanned, 0)
})

console.log(`\n共 ${n} 项断言通过`)
if (process.exitCode) process.exit(process.exitCode)
