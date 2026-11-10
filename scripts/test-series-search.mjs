/**
 * 系列页「搜角色」回归(2026-11-10) —— npm run test:chars
 * ======================================================
 * 守的是 searchCharacters(query.js) 的口径: 系列页那个搜索框除了系列还要搜**角色**,
 * 敲角色名(中/英文)直接出角色卡, 点了就进它的图集。
 *
 * 断言:
 *   ① 负向控制: 夹具里有角色, 且取到的角色能按自己的名字搜回来(否则后面的断言是空转)
 *   ② 英文/短名命中; 别名(alt)命中
 *   ③ 中文命中(取翻译库的真实中文, 没有翻译就自适应跳过并打日志)
 *   ④ 系列名命中 → 该系列的角色出现在结果里
 *   ⑤ 空词不返回全库; limit 生效(total 是全量, characters 被截断)
 *   ⑥ 字段完整性 + 屏蔽角色(hidden_chars)不出现
 *
 * 用法: node scripts/test-series-search.mjs   (需要沙箱库, 先跑一次 e2e)
 */
import nassert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.e2e-work', 'ss-search')
const SANDBOX_DATA = path.join(ROOT, '.e2e-work', 'data')
process.env.TV_DATA_DIR = SANDBOX_DATA
process.env.TV_KNOWLEDGE_DIR ||= path.join(ROOT, 'knowledge')

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

if (!fs.existsSync(path.join(SANDBOX_DATA, 'db', 'tags.db'))) {
  console.error(`缺少沙箱库: ${path.join(SANDBOX_DATA, 'db', 'tags.db')}\n先跑一次 scripts/e2e.mjs 让它准备好`)
  process.exit(2)
}

const { initWorkspace } = await import(pathToFileURL(path.join(ROOT, 'electron/core/workspace.js')).href)
initWorkspace(path.join(WORK, 'userdata'))
const { loadConfig, resolveDataFiles } = await import(pathToFileURL(path.join(ROOT, 'electron/core/config.js')).href)
const { loadDataset } = await import(pathToFileURL(path.join(ROOT, 'electron/core/dataset.js')).href)
const { loadTranslations, translateMap } = await import(pathToFileURL(path.join(ROOT, 'electron/core/translate.js')).href)
const { getSeries, getCharacters, searchCharacters } = await import(pathToFileURL(path.join(ROOT, 'electron/core/query.js')).href)
const { loadUserMeta } = await import(pathToFileURL(path.join(ROOT, 'electron/core/meta.js')).href)

const cfg = loadConfig()
await loadDataset(resolveDataFiles(cfg, null), () => {})
loadTranslations(cfg.translate_dir || '')

console.log('\n=== 夹具 ===')
const se = getSeries({})
const series = (se.series || []).find((s) => s.characters > 0)
if (!series) { console.error('沙箱库里没有带角色的系列 —— 夹具问题, 无法测'); process.exit(2) }
const chars = getCharacters({ series: series.name }).characters || []
const target = chars[0]
const short = String(target.tag).replace(/_\(.+\)$/, '')
console.log(`  系列: ${series.name} (${series.characters} 角) · 探针角色: ${target.tag} (${target.images} 图)`)

console.log('\n=== ① 负向控制 ===')
ok('夹具里有角色(否则所有命中断言都是空转)', () => {
  nassert.ok(chars.length > 0, `${series.name} 一个角色都没有`)
  nassert.ok(short.length >= 3, `短名太短, 不适合当探针: ${short}`)
})

console.log('\n=== ② 英文 / 短名 / 别名 ===')
ok('按短名搜得到该角色, series 字段指回原系列', () => {
  const r = searchCharacters({ q: short })
  const hit = r.characters.find((c) => c.tag === target.tag || (c.alt || []).includes(target.tag)
    || c.tag === short)
  nassert.ok(hit, `搜「${short}」没命中 ${target.tag}(共 ${r.total} 条)`)
  nassert.equal(hit.series, series.name, `series 字段不对: ${hit.series}`)
})
ok('按完整标签搜得到(带括号的角色名)', () => {
  const r = searchCharacters({ q: String(target.tag).toLowerCase() })
  nassert.ok(r.characters.some((c) => c.tag === target.tag), `搜「${target.tag}」没命中`)
})
ok('大小写不敏感', () => {
  const a = searchCharacters({ q: short.toUpperCase() })
  const b = searchCharacters({ q: short.toLowerCase() })
  nassert.equal(a.total, b.total, `大写 ${a.total} / 小写 ${b.total}`)
})

console.log('\n=== ③ 中文 ===')
const zh = translateMap().get(String(target.tag).toLowerCase()) || ''
console.log(`  探针中文: ${zh || '(翻译库里没有)'}`)
if (zh && zh.length >= 2) {
  const frag = zh.slice(0, 2)
  ok(`按中文片段搜得到(「${frag}」)`, () => {
    const r = searchCharacters({ q: frag })
    nassert.ok(r.total > 0, `搜「${frag}」0 条`)
    nassert.ok(r.characters.some((c) => c.tag === target.tag || (c.alt || []).includes(target.tag)),
      `「${frag}」命中的 ${r.total} 条里没有 ${target.tag}`)
  })
} else {
  console.log('  (跳过中文断言: 该角色在翻译库里没有中文名)')
}

console.log('\n=== ④ 系列名 ===')
ok('按系列名搜 → 该系列的角色都在结果里', () => {
  const r = searchCharacters({ q: series.name, limit: 200 })
  const mine = r.characters.filter((c) => c.series === series.name)
  nassert.ok(mine.length > 0, `搜系列「${series.name}」没带出它的角色(共 ${r.total} 条)`)
})

console.log('\n=== ⑤ 空词 / limit ===')
ok('空词不返回全库', () => {
  const r = searchCharacters({ q: '   ' })
  nassert.equal(r.total, 0)
  nassert.equal(r.characters.length, 0)
})
ok('limit 生效: characters 被截断, total 仍是全量', () => {
  const all = searchCharacters({ q: short, limit: 200 })
  const few = searchCharacters({ q: short, limit: 1 })
  nassert.equal(few.total, all.total, 'total 不该被 limit 影响')
  nassert.ok(few.characters.length <= 1, `limit=1 却回了 ${few.characters.length} 条`)
})

console.log('\n=== ⑥ 字段完整性 / 屏蔽角色 ===')
ok('每条结果都齐全(tag/series/images/thumb)', () => {
  const r = searchCharacters({ q: short, limit: 200 })
  for (const c of r.characters) {
    nassert.ok(c.tag && typeof c.tag === 'string', 'tag 缺失')
    nassert.ok(c.series && typeof c.series === 'string', `${c.tag} 缺 series`)
    nassert.ok(Number.isFinite(c.images) && c.images > 0, `${c.tag} images=${c.images}`)
    nassert.ok(typeof c.thumb === 'string', `${c.tag} 缺 thumb`)
    nassert.ok(Array.isArray(c.alt), `${c.tag} alt 不是数组`)
  }
})
const hidden = (loadUserMeta().hidden_chars || []).map((t) => String(t).toLowerCase())
if (hidden.length) {
  ok('屏蔽角色不出现在搜索结果里', () => {
    const r = searchCharacters({ q: short, limit: 200 })
    const bad = r.characters.filter((c) => hidden.includes(String(c.tag).toLowerCase())
      || (c.alt || []).some((t) => hidden.includes(String(t).toLowerCase())))
    nassert.equal(bad.length, 0, `泄漏了屏蔽角色: ${bad.map((c) => c.tag).join(',')}`)
  })
} else {
  console.log('  (跳过屏蔽断言: 沙箱 user_meta 里没有 hidden_chars)')
}

console.log(`\n===== series-search: ${pass} 通过, ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
