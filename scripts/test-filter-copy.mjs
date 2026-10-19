/**
 * 光箱「复制标签」过滤管线 filterTagsLikeExport 的行为测试
 * =========================================================
 * 与导出 buildExport 同一批原语(视角/安全/替换), 单图标签数组进、过滤后数组出。
 * 跑法: node scripts/test-filter-copy.mjs (自带临时数据目录, 不碰真实数据)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ---- 造临时数据目录: 词表/规则组/safety 全部手写, 与真实数据隔离 ---- */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-filtercopy-'))
process.env.TV_DATA_DIR = DATA
fs.writeFileSync(path.join(DATA, 'export_view_tags.txt'), '# 视角\nfrom above\nstanding\n')
fs.writeFileSync(path.join(DATA, 'safety_tags.txt'), '[core]\nnude\nnipples\n[edge]\nlingerie\nswimsuit\n')
fs.writeFileSync(path.join(DATA, 'replace_sets.json'), JSON.stringify({
  active: 'g1',
  sets: [{ id: 'g1', name: '测试组', text: 'blue_hair -> red_hair\nwet ->\n@multi@ -> a, b\n@w1@ -> (red_hair:1.2)\n@w2@ -> red_hair\n' }],
}))

import { initWorkspace } from '../electron/core/workspace.js'
initWorkspace(path.join(DATA, 'app'))
import { filterTagsLikeExport } from '../electron/core/exporter.js'

let n = 0
function ok(name, fn) {
  n++
  try { fn(); console.log(`  ✅ ${name}`) } catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const T = ['1girl', 'blue_hair', 'standing', 'from above', 'wet', 'nude', 'swimsuit', 'multi']

ok('全关 = 原样返回(不排序不重排)', () => {
  const r = filterTagsLikeExport(['b', 'a'], {})
  assert.deepEqual(r.tags, ['b', 'a'])
  assert.deepEqual(r.counts, { view: 0, safe: 0, replaced: 0 })
})

ok('视角剔除: 空格形态与下划线形态都命中', () => {
  const r = filterTagsLikeExport(['1girl', 'from above', 'from_above', 'standing'], { view: true })
  assert.deepEqual(r.tags, ['1girl'])
  assert.equal(r.counts.view, 3)
})

ok('安全剔除 core 档: nude 命中, swimsuit(edge) 保留', () => {
  const r = filterTagsLikeExport(['1girl', 'nude', 'swimsuit'], { safe: true, safe_level: 'core' })
  assert.deepEqual(r.tags, ['1girl', 'swimsuit'])
  assert.equal(r.counts.safe, 1)
})

ok('安全剔除 edge 档: core+edge 都命中', () => {
  const r = filterTagsLikeExport(['nude', 'lingerie', '1girl'], { safe: true, safe_level: 'edge' })
  assert.deepEqual(r.tags, ['1girl'])
  assert.equal(r.counts.safe, 2)
})

ok('安全档缺省(follow)走全局默认档(core): nude 剔, edge 词留', () => {
  const r = filterTagsLikeExport(['nude', 'swimsuit', '1girl'], { safe: true, safe_level: '' })
  assert.deepEqual(r.tags, ['1girl', 'swimsuit'])
  assert.equal(r.counts.safe, 1)
})

ok('替换规则: 改写 + 删除语义(wet ->) + 一变多(集合断言, 顺序交给 sortTags 测)', () => {
  const r = filterTagsLikeExport(T, { replace: true, replace_set: 'g1' })
  assert.equal(r.counts.replaced, 4)   // blue_hair 改写 + wet 删 + multi 变两条(计 2)
  assert.equal(r.tags.includes('wet'), false)
  for (const t of ['1girl', 'red_hair', 'a', 'b', 'standing', 'from above', 'nude', 'swimsuit']) {
    assert.ok(r.tags.includes(t), `缺 ${t}`)
  }
})

ok('替换产物 sortTags 归位: 新词不留在原位', () => {
  // red_hair 替换后应参与分类重排, 而不是留在 blue_hair 原来的下标
  const r = filterTagsLikeExport(['zzz_last', 'blue_hair'], { replace: true, replace_set: 'g1' })
  assert.ok(r.tags.includes('red_hair'))
  assert.deepEqual(r.tags, ['red_hair', 'zzz_last'])
})

ok('组合: 视角 -> 安全 -> 替换 按序生效, 计数分账', () => {
  const r = filterTagsLikeExport(T, { view: true, safe: true, safe_level: 'edge', replace: true, replace_set: 'g1' })
  assert.deepEqual(r.tags.slice().sort(), ['1girl', 'a', 'b', 'red_hair'])
  assert.equal(r.counts.view, 2)       // standing + from above
  assert.equal(r.counts.safe, 2)       // nude + swimsuit
  assert.equal(r.counts.replaced, 4)   // blue_hair + wet + multi 变两条
})

ok('replace=false 整体关(与缺省区分留给调用方)', () => {
  const r = filterTagsLikeExport(['blue_hair'], { replace: false })
  assert.deepEqual(r.tags, ['blue_hair'])
  assert.equal(r.counts.replaced, 0)
})

ok('空数组/缺参不炸', () => {
  assert.deepEqual(filterTagsLikeExport([], { view: true, safe: true }).tags, [])
  assert.deepEqual(filterTagsLikeExport(undefined).tags, [])
})

/* ---- 权重(2026-10-19): (tag:1.2) 排序按裸词归位, 去重保带权重版 ---- */
ok('权重产物 sortTags 归位到裸词同段位(排序后再加权的语义)', () => {
  const r = filterTagsLikeExport(['zzz_last', 'w1'], { replace: true, replace_set: 'g1' })
  // zzz_last -> (red_hair:1.2) 应排在 other 段的 zzz_last 前面(人物/通用段), 而不是队尾
  assert.deepEqual(r.tags, ['(red_hair:1.2)', 'zzz_last'])
})
ok('裸词与带权重版去重归一: 保留先到的带权重版', () => {
  const r = filterTagsLikeExport(['w1', 'w2'], { replace: true, replace_set: 'g1' })
  assert.deepEqual(r.tags, ['(red_hair:1.2)'])
  assert.equal(r.counts.replaced, 2)
})

console.log(`\n通过 ${n} 项断言${process.exitCode ? '（有失败）' : ''}`)
