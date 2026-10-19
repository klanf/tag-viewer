/**
 * 替换规则语法模块(round-trip + 语义一致性)测试
 * ================================================
 * 核心不变式: 构建器 parse → serialize 出的文本, 经**后端** parseReplaceRules
 * 解析出的规则与原文本完全一致, 且 replaceTag 对样本标签的输出逐条相同 ——
 * 即「构建器看到的」就是「导出引擎执行的」, 不允许序列化悄悄改语义。
 * 后端 parseReplaceRules/replaceTag 是 oracle(它们是导出真正在跑的代码)。
 */
import assert from 'node:assert/strict'
import { parseRules, serializeRules, parseLine, serializeRow, MODE_OPTIONS, mergeRows, expandRows, parseWeight, withWeight, matchByMode } from '../src/utils/replaceGrammar.js'
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

console.log('⑤ 删除语义(2026-10-18): 替换侧为空 = 命中即删除')
ok('parseLine 识别删除行 → keep=del', () => {
  const r = parseLine('bad_tag ->')
  assert.deepEqual([r.mode, r.core, r.keep, r.repl], ['exact', 'bad_tag', 'del', []])
  const s = parseLine('*_wet -> ')
  assert.deepEqual([s.mode, s.core, s.keep], ['suf', '_wet', 'del'])
})
ok('serializeRow 删除行 round-trip 为 `pat ->`', () => {
  assert.equal(serializeRow({ mode: 'exact', core: 'bad_tag', keep: 'del', suffix: '', repl: [] }), 'bad_tag ->')
  const p = parseRules('bad_tag ->\nkeep_me -> good_tag')
  assert.equal(p.rows.length, 2)
  assert.equal(serializeRules({ headNotes: [], rows: p.rows, tailNotes: [] }), 'bad_tag ->\nkeep_me -> good_tag\n')
})
ok('后端 replaceTag 命中删除规则返回空数组(=删掉), 未命中原样', () => {
  const rules = parseReplaceRules('bad_tag ->\n*_wet ->')
  assert.deepEqual(replaceTag('bad_tag', rules), [])
  assert.deepEqual(replaceTag('skin_wet', rules), [])
  assert.deepEqual(replaceTag('fine_tag', rules), ['fine_tag'])
})
ok('删除规则在文本往返(构建器⇄原文)中语义不丢', () => {
  const REAL = '# 删掉不要的\nbad_tag ->\nkeep_me -> good_tag'
  const orig = parseReplaceRules(REAL)
  const rebuilt = parseReplaceRules(serializeRules(parseRules(REAL)))
  assert.equal(norm(rebuilt), norm(orig))
  assert.deepEqual(replaceTag('bad_tag', rebuilt), replaceTag('bad_tag', orig))
})

console.log('⑥ 同替换内容合并(2026-10-19): 一张卡管多个来源 tag, 文本层不变')
ok('parseRules 把 mode/keep/suffix/repl 相同的行合并进首行 extras', () => {
  const p = parseRules('boy -> male_focus\nmale -> male_focus\ngirl -> female_focus')
  assert.equal(p.rows.length, 2)
  assert.deepEqual([p.rows[0].core, p.rows[0].extras], ['boy', ['male']])
  assert.deepEqual([p.rows[1].core, p.rows[1].extras], ['girl', []])
})
ok('del 行同模式也合并(keep/suffix 参与分组)', () => {
  const p = parseRules('bad ->\nbad2 ->\n*_wet ->')
  assert.equal(p.rows.length, 2)
  assert.deepEqual(p.rows[0].extras, ['bad2'])
})
ok('serializeRules 展开 extras 回多行, 文本逐字 round-trip', () => {
  const REAL = 'boy -> male_focus\nmale -> male_focus\ngirl -> female_focus'
  assert.equal(serializeRules(parseRules(REAL)), REAL + '\n')
  // head 注释与规则行之间 serializeRules 恒补空行(既有行为), {tag} 恒排最前(既有行为)
  const WITH_NOTES = '# 注释\n\nboy -> male_focus\nmale -> male_focus\nkeep -> good_tag'
  assert.equal(serializeRules(parseRules(WITH_NOTES)), WITH_NOTES + '\n')
})
ok('expandRows 产物经后端解析与原文本语义逐条一致', () => {
  const REAL = 'boy -> male_focus\nmale -> male_focus\n@xx@ -> {tag}_s, a'
  const orig = parseReplaceRules(REAL)
  const rebuilt = parseReplaceRules(serializeRules(parseRules(REAL)))
  assert.equal(norm(rebuilt), norm(orig))
})
ok('mergeRows/expandRows 手工互逆', () => {
  const rows = [{ mode: 'exact', core: 'a', keep: true, suffix: '_s', repl: ['x'] }, { mode: 'exact', core: 'b', keep: true, suffix: '_s', repl: ['x'] }]
  const m = mergeRows(rows)
  assert.equal(m.length, 1)
  assert.deepEqual(m[0].extras, ['b'])
  const e = expandRows(m)
  assert.deepEqual(e.map((r) => r.core), ['a', 'b'])
  assert.ok(e.every((r) => !('extras' in r)))
})

/* ---- ⑥ 权重(2026-10-19): (tag:1.2) 社区写法, 存文本层 ---- */
ok('parseWeight 拆裸词与权重; 非权重形态 w=1', () => {
  assert.deepEqual(parseWeight('(red_hair:1.2)'), { tag: 'red_hair', w: 1.2 })
  assert.deepEqual(parseWeight('red_hair'), { tag: 'red_hair', w: 1 })
  assert.deepEqual(parseWeight('(frieren_(frieren):1.2)'), { tag: 'frieren_(frieren)', w: 1.2 })
})
ok('withWeight 包壳/去壳(1.0 = 裸词), 0.1 步进一位小数', () => {
  assert.equal(withWeight('red_hair', 1.2), '(red_hair:1.2)')
  assert.equal(withWeight('(red_hair:1.2)', 1), 'red_hair')
  assert.equal(withWeight('red_hair', 0.9), '(red_hair:0.9)')
  assert.equal(withWeight('red_hair', 1), 'red_hair')
})
ok('带权重的替换标签 round-trip: 文本逐字不变', () => {
  const TEXT = 'blue_hair -> (red_hair:1.2), solo\nwet ->\n'
  assert.equal(serializeRules(parseRules(TEXT)), TEXT)
})
ok('parseLine 行模型保住权重文本(repl 自由文本)', () => {
  const r = parseLine('blue_hair -> (red_hair:1.2), solo')
  assert.deepEqual(r.repl, ['(red_hair:1.2)', 'solo'])
  assert.equal(serializeRow(r), 'blue_hair -> (red_hair:1.2), solo')
})

/* ---- matchByMode(2026-10-19): 模式侧联想过滤的匹配口径 ---- */
ok('matchByMode 基本语义(大小写不敏感)', () => {
  assert.equal(matchByMode('boys', 'exact', 'boys'), true)
  assert.equal(matchByMode('Boys', 'exact', 'BOYS'), true)
  assert.equal(matchByMode('multiple_boys', 'exact', 'boys'), false)
  assert.equal(matchByMode('blue_hair', 'pre', 'blue_'), true)
  assert.equal(matchByMode('xxblue_x', 'pre', 'blue_'), false)
  assert.equal(matchByMode('long_hair', 'suf', '_hair'), true)
  assert.equal(matchByMode('hairy', 'suf', '_hair'), false)
  assert.equal(matchByMode('colorful', 'con', 'color'), true)
  assert.equal(matchByMode('xx_boy', 'seg', 'boy'), true)
  assert.equal(matchByMode('tomboy', 'seg', 'boy'), false)
  assert.equal(matchByMode('xx_boy_yy', 'seg', 'boy'), true)
  assert.equal(matchByMode('anything', 'exact', ''), false)
})
ok('matchByMode 与后端 patHit 口径一致(经 replaceTag 删除语义差分验证)', () => {
  const CASES = [
    ['exact', 'boys', ['boys', 'multiple_boys', '2boys', 'Boys']],
    ['pre', 'blue_', ['blue_hair', 'blue_eyes', 'xxblue_x']],
    ['suf', '_hair', ['long_hair', 'hair', 'hairy', 'red_hair']],
    ['con', 'color', ['colorful', 'skin_color', 'color', 'colo']],
    ['seg', 'boy', ['boy', 'xx_boy', 'boy_xx', 'xx_boy_yy', 'tomboy', 'boyish']],
  ]
  for (const [mode, core, tags] of CASES) {
    const rules = parseReplaceRules(serializeRow({ mode, core, keep: 'del', suffix: '', repl: [] }) + '\n')
    for (const t of tags) {
      const backendHit = replaceTag(t, rules).length === 0   // 删除规则命中 = 返回 []
      assert.equal(matchByMode(t, mode, core), backendHit, `${mode} "${core}" vs "${t}" 前后端口径不一致`)
    }
  }
})

ok('replaceTag 替换侧同时写 (uncensored:2) 与 uncensored 只出先到的', () => {
  const r = replaceTag('zzz', parseReplaceRules('zzz -> (uncensored:2), uncensored\n'))
  assert.deepEqual(r, ['(uncensored:2)'])
})

console.log(`\n通过 ${n} 项断言${process.exitCode ? '（有失败）' : ''}`)
