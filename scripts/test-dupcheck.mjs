/**
 * dupcheck 查重测试(2026-10-17) —— 纯 Node, 临时库, 不启 Electron
 * 覆盖: 相同 tag 集合成组 / 链式合并(A≈B,B≈C) / 不同角色惩罚把 D 排除 /
 *       无关图不误报 / gone 与空 tags 排除 / as_source=0 文件夹排除 /
 *       ignorePairs 误报忽略 / best=最大分辨率 / 阈值敏感性 / 共享 tag 列表按权重排序 /
 *       unsafe 安全模式标记(2026-10-17)
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

console.log('④ 可见性: 来源已注销文件夹(as_source=0)的图不参与(2026-10-17)')
db.prepare(
  `INSERT INTO folders (id, path, label, as_source, as_scan) VALUES (2, ?, 'hidden', 0, 0)`
).run(P('hidden-root'))
db.prepare(
  `INSERT INTO images (path, src_id, folder_id, tags, tags_src, gone, px_w, px_h, size)
   VALUES (?, 0, 2, ?, 'test', 0, 900, 900, 900)`
).run(P('i-hidden.png'), base5)
r = dupcheck.findDuplicateGroups({ threshold: 0.65 })
ok('隐藏文件夹里的幽灵图被排除: scanned 仍=6', () => assert.equal(r.scanned, 6))
ok('结果里没有 i-hidden', () => assert.ok(!groupOf(r, 'i-hidden.png')))
db.prepare('UPDATE folders SET as_source = 1 WHERE id = 2').run()
r = dupcheck.findDuplicateGroups({ threshold: 0.65 })
ok('开关打开后同一张图恢复参与: scanned=7', () => assert.equal(r.scanned, 7))
ok('items 带注册文件夹与 tags(优先级/右键收藏用, 2026-10-17)', () => {
  const g = groupOf(r, 'i-hidden.png')
  const it = g.items.find((x) => path.basename(x.path) === 'i-hidden.png')
  assert.equal(it.folder, P('hidden-root'))
  assert.ok(it.tags.includes(KA))
  assert.ok(typeof it.unsafe === 'number')
})
db.prepare('UPDATE folders SET as_source = 0 WHERE id = 2').run()
r = dupcheck.findDuplicateGroups({ threshold: 0.65 })

console.log('⑤ 误报忽略: ignorePairs 命中的图片对跳过')
const idOfName = {}
for (const row of db.prepare('SELECT id, path FROM images').all()) {
  idOfName[path.basename(row.path)] = Number(row.id)
}
const efKey = [idOfName['e.png'], idOfName['f.png']].sort((a, b) => a - b).join('|')
r = dupcheck.findDuplicateGroups({ threshold: 0.65, ignorePairs: new Set([efKey]) })
ok('忽略 {e,f} 对后该组消失', () => assert.ok(!groupOf(r, 'e.png') && !groupOf(r, 'f.png')))
ok('其他组不受影响: {a,b,c} 仍在', () => assert.deepEqual(groupIds(r), ['a.png+b.png+c.png']))
ok('ignoredPairs 计数=1', () => assert.equal(r.ignoredPairs, 1))
r = dupcheck.findDuplicateGroups({ threshold: 0.65, ignorePairs: new Set(['999999|1000000']) })
ok('未命中的忽略对不影响结果', () => assert.deepEqual(groupIds(r).sort(), ['a.png+b.png+c.png', 'e.png+f.png']))
ok('未命中时 ignoredPairs=0', () => assert.equal(r.ignoredPairs, 0))

console.log('⑥ 安全模式标记: 每张图带 unsafe(2026-10-17 用户补充)')
// 在此前断言跑完后再插敏感图, 免得动前面所有 scanned 计数
ins.run(P('s1.png'), 'nude,silver_hair,long_hair', 0, 500, 500, 100)
ins.run(P('s2.png'), 'nude,silver_hair,long_hair', 0, 500, 500, 100)
r = dupcheck.findDuplicateGroups({ threshold: 0.65 })
ok('s1/s2 成组且 unsafe=1(nude 命中默认 core 段)', () => {
  const g = groupOf(r, 's1.png')
  assert.ok(g, '应成组')
  assert.deepEqual(g.items.map((it) => it.unsafe).sort(), [1, 1])
})
ok('干净图 unsafe=0', () => {
  const g = groupOf(r, 'a.png')
  assert.ok(g.items.every((it) => it.unsafe === 0))
})

console.log('⑥b 已忽略组还原: 只存 id 对, 也能还原成可展示的组(2026-10-23)')
{
  const ids = ['a.png', 'b.png', 'c.png'].map((n) => idOfName[n])
  const pairs = new Set()
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.add([ids[i], ids[j]].sort((x, y) => x - y).join('|'))
    }
  }
  let ig = dupcheck.findIgnoredGroups(pairs)
  ok('三张图的两个忽略对并成一组', () => {
    assert.equal(ig.groups.length, 1)
    assert.deepEqual(
      ig.groups[0].items.map((it) => path.basename(it.path)).sort(),
      ['a.png', 'b.png', 'c.png'],
    )
  })
  ok('还原的组带 unsafe / folder / 公共标签(安全模式与排序复用)', () => {
    const g = ig.groups[0]
    assert.ok(g.ignored === true)
    assert.ok(g.items.every((it) => typeof it.unsafe === 'number'))
    assert.ok(g.items.every((it) => typeof it.folder === 'string'))
    assert.ok(g.shared.includes(KA), g.shared.join(','))
  })
  ok('保留建议 = 分辨率最大, 且组内按分辨率排序', () => {
    const g = ig.groups[0]
    assert.equal(path.basename(g.items[0].path), 'a.png')
    assert.equal(g.items[0].best, true)
    assert.ok(g.items.slice(1).every((it) => !it.best))
  })
  ok('pairs / missingPairs 口径正确(对不上现存图的旧对计入 missing)', () => {
    assert.equal(ig.pairs, 3)
    assert.equal(ig.missingPairs, 0)
    ig = dupcheck.findIgnoredGroups(new Set([...pairs, '999999|1000000']))
    assert.equal(ig.pairs, 4)
    assert.equal(ig.missingPairs, 1)
    assert.equal(ig.groups.length, 1)
  })
  const dupignore = await load('electron/core/dupignore.js')
  dupignore.addIgnorePairs([...pairs])
  ok('忽略对落盘可回读', () => assert.equal(dupignore.loadIgnorePairs().size, 3))
  ok('恢复一组 = 只删这组内的对(按 id 集合)', () => {
    assert.equal(dupignore.removeIgnorePairsByIds([ids[0], ids[1]]), 1)
    assert.equal(dupignore.loadIgnorePairs().size, 2)
  })
  dupignore.clearIgnorePairs()
}

console.log('⑦ 空库/无候选安全')
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
