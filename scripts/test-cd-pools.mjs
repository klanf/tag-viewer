/**
 * 图库组合池单元测试(2026-11-11) —— npm run test:cdpool
 * =====================================================
 * 守的是「第三套来源的数据是干净的、发牌真的不重复、双人条目默认不抽」。
 * 导出管线里的行为(剔槽 / 与 NL 互斥 / 追加位置)在 test:nlexport 里验。
 *
 * 为什么整串不拆已经写在 cd-pools.js 头部, 这里只验结果:
 *   ① 池子条数对得上(动作 ≥240 / 穿搭 ≥430)
 *   ② 串里没有权重壳( (covering_ears:1.3) 这种脏数据在构建期就该剥掉 )
 *   ③ 侧视变体(from_side/profile/side_view 三件套)没进池
 *   ④ 发牌: 连抽 100 次两两不同(池子 210 条, 远小于池子)
 *   ⑤ dual 默认不抽; allowDual=true 才抽得到
 *   ⑥ 跟本行已有 tag 重叠时换下一条(不删片段 —— 删了穿搭就散架)
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.TV_KNOWLEDGE_DIR ||= path.join(ROOT, 'knowledge')

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}
const assert = (c, m) => { if (!c) throw new Error(m) }

const { cdPoolsStats, makeCdPicker, CD_DIMS } = await import(
  pathToFileURL(path.join(ROOT, 'electron/core/cd-pools.js')).href)

const stats = cdPoolsStats()
const byId = Object.fromEntries(stats.dims.map((d) => [d.id, d]))

console.log('\n=== 池子完整性 ===')
ok('两个维度都在', () => assert(CD_DIMS.length === 2 && byId.pose && byId.outfit,
  JSON.stringify(stats)))
ok('动作 ≥240 条 / 穿搭 ≥430 条', () => {
  assert(byId.pose.total >= 240, `动作只有 ${byId.pose.total}`)
  assert(byId.outfit.total >= 430, `穿搭只有 ${byId.outfit.total}`)
})
ok('可抽数 = 总数 - 双人', () => {
  for (const d of stats.dims) {
    assert(d.available === d.total - d.dual, `${d.id}: ${d.available} != ${d.total}-${d.dual}`)
  }
})

const picker = makeCdPicker({ dims: ['pose', 'outfit'], seed: 'unit' })
const deals = []
for (let i = 0; i < 100; i++) deals.push(picker.pick(i))
const allTags = deals.flatMap((d) => d.tags.split(', '))

console.log('\n=== 串的干净程度 ===')
ok('没有权重壳', () => {
  // 只认 A1111 那种 (tag:1.3) 壳 —— `holding_bow_(weapon)` 是 danbooru 的消歧义写法, 是真 tag
  const bad = allTags.filter((t) => /^\(.+:\d+(?:\.\d+)?\)$/.test(t))
  assert(bad.length === 0, `带壳的有 ${bad.length} 个: ${bad.slice(0, 5).join(', ')}`)
})
ok('没有空 tag / 双逗号', () => {
  const bad = deals.filter((d) => /,\s*,|,\s*$|^\s*,/.test(d.tags) || /\s{2,}/.test(d.tags))
  assert(bad.length === 0, bad.slice(0, 2).map((b) => b.tags).join(' | '))
})
ok('侧视变体没进池(不会出现 from_side+profile+side_view 三件套)', () => {
  const bad = deals.filter((d) => {
    const t = new Set(d.tags.split(', '))
    return t.has('from_side') && t.has('profile') && t.has('side_view')
  })
  assert(bad.length === 0, bad.slice(0, 2).map((b) => b.tags).join(' | '))
})
ok('默认不抽双人条目(2girls 不该出现)', () => {
  const bad = allTags.filter((t) => /^(2girls|2boys|multiple_girls|\dboys)$/.test(t))
  assert(bad.length === 0, `出现 ${bad.length} 个: ${[...new Set(bad)].join(', ')}`)
})

console.log('\n=== 发牌 ===')
ok('连抽 100 次两两不同', () => {
  const seen = new Set()
  for (const d of deals) {
    assert(!seen.has(d.tags), `重复: ${d.tags}`)
    seen.add(d.tags)
  }
})
ok('同一 seed 可复现', () => {
  const a = makeCdPicker({ dims: ['pose'], seed: 'same' })
  const b = makeCdPicker({ dims: ['pose'], seed: 'same' })
  for (let i = 0; i < 20; i++) assert(a.pick(i).tags === b.pick(i).tags, `第 ${i} 条不一致`)
})
ok('两个维度都出串(pose + outfit 各一条)', () => {
  const d = deals[0]
  assert(d.parts.length === 2, `只出了 ${d.parts.length} 段`)
  assert(d.parts[0].dim === 'pose' && d.parts[1].dim === 'outfit', JSON.stringify(d.parts.map((p) => p.dim)))
})
ok('允许双人时才抽得到 2girls/2boys', () => {
  const p = makeCdPicker({ dims: ['pose'], seed: 'dual', allowDual: true })
  let hit = 0
  for (let i = 0; i < 250; i++) if (/\b(2girls|2boys|multiple_girls)\b/.test(p.pick(i).tags)) hit++
  assert(hit > 0, '开启 allowDual 后 250 次一条双人都没抽到')
})

console.log('\n=== 与本行已有 tag 去重 ===')
ok('行里已有 standing → 抽到的串里不再含它', () => {
  const p = makeCdPicker({ dims: ['pose'], seed: 'dedup' })
  for (let i = 0; i < 30; i++) {
    const got = p.pick(i, ['standing'])
    assert(!got.tags.split(', ').includes('standing'), `第 ${i} 条仍含 standing: ${got.tags}`)
  }
})
ok('整串保留: 抽到的每条都 ≥2 个 tag(没被拆成单词)', () => {
  for (const d of deals) assert(d.tags.split(', ').length >= 2, `太短: ${d.tags}`)
})

console.log(`\n[cdpool] ${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
