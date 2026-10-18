/**
 * 替换规则语法模块(round-trip + 语义一致性)测试
 * ================================================
 * 核心不变式: 构建器 parse → serialize 出的文本, 经**后端** parseReplaceRules
 * 解析出的规则与原文本完全一致, 且 replaceTag 对样本标签的输出逐条相同 ——
 * 即「构建器看到的」就是「导出引擎执行的」, 不允许序列化悄悄改语义。
 * 后端 parseReplaceRules/replaceTag 是 oracle(它们是导出真正在跑的代码)。
 */
import assert from 'node:assert/strict'
import { parseRules, serializeRules, parseLine, serializeRow, MODE_OPTIONS } from '../src/utils/replaceGrammar.js'
import { parseReplaceRules, replaceTag } from '../electron/core/rules.js'

let n = 0
function ok(name, fn) {
  try { fn(); n++; console.log('  ✓', name) } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1 }
}

const norm = (rules) => JSON.stringify(rules)

console.log('① 单行双向')
ok('精确行 round-trip', () => {
  assert.equal(serializeRow(parseLine('red_hair -> a, b')), 'red_hair -> a, b')
})
ok('后缀行解析出 core', () => {
  const r = parseLine('*_hair -> {tag}, hair_focus')
  assert.equal(r.mode, 'suf'); assert.equal(r.core, '_hair')
  assert.equal(r.keep, true); assert.deepEqual(r.repl, ['hair_focus'])
})
ok('前缀/包含/整段', () => {
  assert.equal(parseLine('blue_* -> x').mode, 'pre')
  assert.equal(parseLine('*color* -> x').mode, 'con')
  assert.equal(parseLine('@boy@ -> {tag}, male_focus').mode, 'seg')
})
ok('保留+后缀 → {tag}_art', () => {
  assert.equal(serializeRow({ mode: 'exact', core: 'painting', keep: true, suffix: '_art', repl: [] }), 'painting -> {tag}_art')
})
ok('模式内嵌 * 落 raw(null)', () => {
  assert.equal(parseLine('a*b* -> x'), null)
})
ok('{tag} 出现两次落 raw', () => {
  assert.equal(parseLine('x -> {tag}, {tag}_y'), null)
})
ok('{tag} 在中间 → keep 且顺序统一(语义等价)', () => {
  const r = parseLine('*comment* -> illustration, {tag}')
  assert.equal(r.keep, true); assert.deepEqual(r.repl, ['illustration'])
  assert.equal(serializeRow(r), '*comment* -> {tag}, illustration')
})

console.log('② 整段注释收纳(用户拍板: 行间注释收集到尾部)')
const SRC = [
  '# 头部分组说明',
  '# ===== 风格类 =====',
  'painting -> {tag}, best_quality',
  '# 行间注释会被收纳',
  '*_hair -> {tag}, hair_focus',
  '',
  '# ===== 尾部备注 =====',
  'trailing note',
].join('\n')
ok('head/tail 收纳位置正确', () => {
  const p = parseRules(SRC)
  assert.equal(p.rows.length, 2)
  assert.ok(p.headNotes.join('\n').includes('头部分组说明'))
  assert.ok(p.tailNotes.join('\n').includes('行间注释'))
  assert.ok(p.tailNotes.join('\n').includes('尾部备注'))
})
ok('round-trip 后规则行一字不变', () => {
  const p = parseRules(SRC)
  const out = serializeRules(p)
  const before = parseReplaceRules(SRC)
  const after = parseReplaceRules(out)
  assert.equal(norm(after), norm(before))
})
ok('注释在 round-trip 中不丢', () => {
  const out = serializeRules(parseRules(SRC))
  assert.ok(out.includes('# 头部分组说明'))
  assert.ok(out.includes('# 行间注释会被收纳'))
  assert.ok(out.includes('# ===== 尾部备注 ====='))
})
ok('再 parse 一次幂等(serialize→parse→serialize 稳定)', () => {
  const once = serializeRules(parseRules(SRC))
  const twice = serializeRules(parseRules(once))
  assert.equal(norm(parseReplaceRules(twice)), norm(parseReplaceRules(once)))
})

console.log('③ 与导出引擎的语义一致性(oracle: 后端 replaceTag)')
const SAMPLES = ['blue_hair', '1boy', 'tomboy', 'oil_painting', 'watercolor_(medium)', 'red_hair', 'boy', 'boy_on_top']
ok('全部样本 tag 的替换结果逐条相同', () => {
  const orig = parseReplaceRules(SRC)
  const rebuilt = parseReplaceRules(serializeRules(parseRules(SRC)))
  for (const t of SAMPLES) {
    assert.deepEqual(replaceTag(t, rebuilt), replaceTag(t, orig), `样本 ${t} 结果不一致`)
  }
})
ok('keep=false 语义: 原标签被丢弃', () => {
  const row = { mode: 'exact', core: 'old_tag', keep: false, suffix: '', repl: ['new_tag'] }
  const rules = parseReplaceRules(serializeRules({ rows: [row] }))
  assert.deepEqual(replaceTag('old_tag', rules), ['new_tag'])
})
ok('整段 @boy@ 不误伤 tomboy(与手写文本同判)', () => {
  const rules = parseReplaceRules(serializeRules({ rows: [{ mode: 'seg', core: 'boy', keep: true, suffix: '', repl: ['male_focus'] }] }))
  assert.deepEqual(replaceTag('tomboy', rules), ['tomboy'])
  assert.deepEqual(replaceTag('xx_boy_yy', rules), ['xx_boy_yy', 'male_focus'])
})

console.log('④ 真实规则文件抽查(data/export_replace.txt 的历史形态)')
const REAL = [
  '# ===== 阴道插入类: 统一加透视 =====',
  'cleft_of_venus -> clitoral_hood, sparse_pubic_hair, (uncensored:2)',
  '@pussy@ -> {tag}, clitoral_hood, sparse_pubic_hair, (uncensored:2)',
  '*_painting -> {tag}, masterpiece, best_quality',
].join('\n')
ok('真实形态 round-trip 语义不变', () => {
  const orig = parseReplaceRules(REAL)
  const rebuilt = parseReplaceRules(serializeRules(parseRules(REAL)))
  assert.equal(norm(rebuilt), norm(orig))
  for (const t of ['cleft_of_venus', 'pussy', 'deep_pussy', 'oil_painting', 'xx']) {
    assert.deepEqual(replaceTag(t, rebuilt), replaceTag(t, orig), `样本 ${t}`)
  }
})
ok('含全角逗号的行(历史数据)不崩且保 raw', () => {
  // 用户旧文件里混过中文逗号 —— 后端按半角逗号切, 全角项会粘在标签里;
  // 语法模块不修数据, 只要求不丢不崩(解析不出就落 raw 原样保留)
  const p = parseRules('x -> a，b')
  assert.equal(p.rows.length + p.tailNotes.filter((l) => l.trim()).length, 1)
})
ok('MODE_OPTIONS 覆盖 5 种模式', () => {
  assert.deepEqual(MODE_OPTIONS.map((m) => m.value), ['exact', 'pre', 'suf', 'con', 'seg'])
})

console.log(`\n通过 ${n} 项断言${process.exitCode ? '（有失败）' : ''}`)
