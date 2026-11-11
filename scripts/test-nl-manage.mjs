/**
 * 自然语言语料「用户级管理」回归(2026-11-11) —— npm run test:nlmanage
 * ==================================================================
 * 守的是这一串承诺(少了任何一条, 界面上的"禁用"就是假的):
 *   ① 覆盖文件缺/坏时降级成空, 不抛(与知识包缺文件同思路)
 *   ② 增量改落得住: addIds/removeIds/addKeys/removeKeys/clear 各自生效
 *   ③ 幂等 + 归一: 同一条重复禁只有一份, 大小写/空格差异视为同一条
 *   ④ 列表口径: 禁掉的条 disabled=true 且 byId/byKeys 说得清来源;
 *      「只看已禁」= 服务端过滤(否则分页数对不上)
 *   ⑤ **抽句真的抽不到**(makeNlPicker 是唯一出口) —— 负向控制: 不禁时能抽到
 *   ⑥ 统计口径: disabled / disabledByLevel 与列表一致(界面"可抽 N"要扣它)
 *   ⑦ 与方案级关键词是**并集**(mergeNlBan), 且 exporter 真的把它传下去了
 *      —— 只测 picker 不测 exporter, 等于放过 v1 nl_lang 那个"参数在链路里丢了"的坑
 */
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.e2e-work', 'nl-manage')
const DATA = path.join(WORK, 'data')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.TV_DATA_DIR = DATA
process.env.TV_KNOWLEDGE_DIR ||= path.join(ROOT, 'knowledge')

const mod = (p) => import(pathToFileURL(path.join(ROOT, p)).href)
const { initWorkspace } = await mod('electron/core/workspace.js')
initWorkspace(path.join(WORK, 'userdata'))
const { loadNlOverrides, patchNlOverrides, mergeNlBan } = await mod('electron/core/nl-overrides.js')
const { nlList, nlBankStats, makeNlPicker, nlEntryKey } = await mod('electron/core/nl-bank.js')

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}
function assert(c, m) { if (!c) throw new Error(m) }
const fn = async (name, f) => {
  try { await f(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

const FILE = path.join(DATA, 'nl_overrides.json')
const reset = () => { try { fs.rmSync(FILE, { force: true }) } catch {} }

/* 生产路径上 nl:list 会把全局覆盖传进 nlList(见 ipc.js), 这里照样模拟 ——
 * 直接调 nlList 不传覆盖, 测的就不是用户实际看到的那份列表了。 */
function listGlob(q = {}) {
  const o = loadNlOverrides()
  return nlList({ ...q, banned: o.bannedKeys, bannedIds: o.bannedIds })
}
/** 翻页取全量(list 的 limit 上限 500, 拿一页就等于漏数据) */
function listAll(q = {}) {
  const out = []
  let off = 0
  let total = 0
  for (;;) {
    const d = listGlob({ ...q, offset: off, limit: 500 })
    total = d.total
    out.push(...d.items)
    if (out.length >= total || !d.items.length) return { items: out, total }
    off += d.items.length
  }
}

console.log('\n===== 自然语言语料管理 =====')

ok('① 缺文件时降级成空(不抛)', () => {
  reset()
  const o = loadNlOverrides()
  assert(Array.isArray(o.bannedIds) && o.bannedIds.length === 0, 'bannedIds 该是空数组')
  assert(Array.isArray(o.bannedKeys) && o.bannedKeys.length === 0, 'bannedKeys 该是空数组')
})

ok('① 文件坏了也降级成空(手改坏了不该让导出崩)', () => {
  fs.writeFileSync(FILE, '{ not json', 'utf8')
  const o = loadNlOverrides()
  assert(o.bannedIds.length === 0 && o.bannedKeys.length === 0, '坏文件该被当成空覆盖')
  reset()
})

/* 取三条真实语料当靶子(用真实数据, 不用编的 id —— 编的 id 测不出"列表里对不上") */
const sample = nlList({ dim: 'costume', offset: 0, limit: 3 }).items
assert(sample.length === 3, '语料库该能列出穿搭条目(检查 knowledge/nl-bank.json 在不在)')
const ids = sample.map((s) => s.id)

ok('② addIds 落盘: 文件是版本化 JSON, 读回三条', () => {
  reset()
  const r = patchNlOverrides({ addIds: ids })
  assert(r.ok, '保存该成功: ' + r.error)
  assert(fs.existsSync(FILE), 'nl_overrides.json 该被创建')
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  assert(raw.version === 1, '版本号该是 1')
  assert(raw.bannedIds.length === 3, `该存三条, 实际 ${raw.bannedIds.length}`)
  assert(loadNlOverrides().bannedIds.length === 3, '读回该是三条')
})

ok('③ 幂等: 重复禁同一条不翻倍', () => {
  patchNlOverrides({ addIds: ids })
  assert(loadNlOverrides().bannedIds.length === 3, '重复 add 不该多出来')
})

ok('③ 归一: 大小写/多空格与已存 id 视为同一条', () => {
  const messy = ids[0].toUpperCase().replace(' ', '   ')
  patchNlOverrides({ addIds: [messy] })
  assert(loadNlOverrides().bannedIds.length === 3, '仅大小写/空格不同不该算新条目')
})

await fn('④ 列表: 禁掉的三条 disabled=true + byId, 其它条不受影响(负向控制)', async () => {
  const d = listGlob({ dim: 'costume', offset: 0, limit: 60 })
  const hit = d.items.filter((x) => x.disabled)
  assert(hit.length === 3, `该正好三条被禁, 实际 ${hit.length}`)
  assert(hit.every((x) => x.byId && x.byKeys.length === 0), '禁用来源该是单条(byId)')
  assert(hit.every((x) => !x.byKeys.length), '不该被算成关键词禁用')
  const others = d.items.filter((x) => !x.disabled)
  assert(others.length > 0, '同页该还有没被禁的条目')
})

ok('④ 「只看已禁」= 服务端过滤, 总数等于禁用条数', () => {
  const d = listGlob({ dim: 'costume', offset: 0, limit: 500, disabledOnly: true })
  assert(d.total === 3, `只看已禁该是 3 条, 实际 ${d.total}`)
  assert(d.items.every((x) => x.disabled), '结果里不该混进没禁的')
})

ok('⑤ 抽句: 禁掉的句子一条都抽不到(300 次)', () => {
  const bannedSet = new Set(loadNlOverrides().bannedIds)
  const p = makeNlPicker({ dims: ['costume'], bannedIds: [...bannedSet], seed: 'nlmanage' })
  let bad = 0
  for (let i = 0; i < 300; i++) {
    const r = p.pick(i)
    const id = nlEntryKey('costume', r.parts[0].en)
    if (bannedSet.has(id)) bad++
  }
  assert(bad === 0, `300 次里抽到 ${bad} 次被禁的句子`)
})

ok('⑤ 负向控制: 不传 bannedIds 时这几条真的抽得到(证明不是假通过)', () => {
  const target = ids[0]
  const en = sample[0].en
  const p = makeNlPicker({ dims: ['costume'], seed: 'nlmanage' })
  let seen = 0
  for (let i = 0; i < 1200; i++) {
    if (p.pick(i).parts[0].en === en) seen++
  }
  assert(seen > 0, `不禁时该能抽到 ${target}, 1200 次一次都没出现 = 测试无效`)
})

ok('⑥ 统计: disabled 与列表一致(界面"可抽 N"靠它扣)', () => {
  const st = nlBankStats({ bannedIds: loadNlOverrides().bannedIds })
  const c = st.dims.find((d) => d.id === 'costume')
  assert(c.disabled === 3, `costume disabled 该是 3, 实际 ${c.disabled}`)
  const sum = Object.values(c.disabledByLevel).reduce((a, b) => a + b, 0)
  assert(sum === c.disabled, `disabledByLevel 之和该等于 disabled(${sum} vs ${c.disabled})`)
  assert(c.disabledByLevel.sfw > 0, '这三条是 sfw 档, 该计入 sfw 桶')
})

/* ---- 关键词层 ---- */
ok('② addKeys: 命中数与手工统计一致, 且列表说得清"被哪个词禁的"', () => {
  const r = patchNlOverrides({ addKeys: ['针织'] })
  assert(r.ok, '保存该成功: ' + r.error)
  assert(r.overrides.bannedKeys.includes('针织'), '关键词该进列表')
  const d = listAll({ dim: 'costume' })
  const byKey = d.items.filter((x) => x.byKeys.length)
  assert(byKey.length > 200, `「针织」该命中两百条以上, 实际 ${byKey.length}`)
  assert(byKey.every((x) => x.byKeys.includes('针织')), 'byKeys 该写明命中的是「针织」')
  // 手工口径(列表行不带 kw 字段, 所以只会比 byKeys 少 —— 只查中文/英文/分类)
  const manual = d.items.filter((x) => [x.zh, x.en, x.cat].some((h) => String(h).toLowerCase().includes('针织')))
  assert(manual.length > 0, '手工统计也该命中(中文译文里确实写了针织)')
  assert(manual.every((x) => x.disabled), '手工能查到的, 列表必须也标成禁用')
})

ok('⑥ 统计: 关键词 + 单条取并集(同一条不重复计数)', () => {
  const g = loadNlOverrides()
  const st = nlBankStats({ banned: g.bannedKeys, bannedIds: g.bannedIds })
  const c = st.dims.find((d) => d.id === 'costume')
  const d = listAll({ dim: 'costume' })
  const listedDisabled = d.items.filter((x) => x.disabled).length
  assert(c.disabled === listedDisabled,
    `统计 disabled=${c.disabled} 与列表禁用数 ${listedDisabled} 该相等(并集不能重复计)`)
  assert(c.banned > 0, 'banned 该反映关键词命中数(方案库界面仍在用)')
})

ok('② removeIds / removeKeys 精确回滚', () => {
  const before = loadNlOverrides()
  patchNlOverrides({ removeIds: [before.bannedIds[0]] })
  assert(loadNlOverrides().bannedIds.length === before.bannedIds.length - 1, '删一条该少一条')
  patchNlOverrides({ removeKeys: ['针织'] })
  assert(!loadNlOverrides().bannedKeys.includes('针织'), '关键词该被移除')
})

ok('② clear=all 清空两层', () => {
  patchNlOverrides({ addIds: ids, addKeys: ['knit'] })
  assert(loadNlOverrides().bannedIds.length > 0, '前置: 该有单条禁用')
  patchNlOverrides({ clear: 'all' })
  const o = loadNlOverrides()
  assert(o.bannedIds.length === 0 && o.bannedKeys.length === 0, 'clear all 该两层都清空')
})

/* ---- 与方案级关键词的并集 ---- */
ok('⑦ mergeNlBan: 全局关键词与方案关键词并集去重', () => {
  patchNlOverrides({ addKeys: ['针织', 'Knit'] })
  const g = loadNlOverrides()
  const m = mergeNlBan(g, '针织, sweater')
  assert(m.banned.filter((k) => k === '针织').length === 1, '同一个词只该出现一次')
  assert(m.banned.includes('sweater'), '方案关键词该并入')
  assert(m.banned.includes('knit'), '全局关键词该归一成小写')
  patchNlOverrides({ clear: 'all' })
})

ok('⑦ mergeNlBan: 方案关键词接受字符串/数组两种形态', () => {
  const a = mergeNlBan({ bannedKeys: ['x'], bannedIds: ['pose::a'] }, 'y，z')
  assert(a.banned.join(',') === 'x,y,z', `字符串形态该拆开: ${a.banned.join(',')}`)
  const b = mergeNlBan({ bannedKeys: [], bannedIds: [] }, ['y', 'z'])
  assert(b.banned.join(',') === 'y,z', '数组形态该直接用')
  assert(a.bannedIds[0] === 'pose::a', 'bannedIds 该原样透传')
})

ok('⑦ exporter 真的把 bannedIds 传给了 picker(防"参数在链路里丢了")', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/core/exporter.js'), 'utf8')
  assert(/mergeNlBan\(\s*loadNlOverrides\(\)/.test(src), 'exporter 该用 mergeNlBan 合并全局覆盖')
  assert(/bannedIds:\s*nlBanMerged\.bannedIds/.test(src), 'exporter 该把 bannedIds 交给 makeNlPicker')
})

ok('⑦ ipc 的统计通道同样合并两层(否则界面数字偏大)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/ipc.js'), 'utf8')
  assert(/'random:nlstats'[\s\S]{0,400}mergeNlBan/.test(src), 'random:nlstats 该合并全局覆盖')
  assert(/'nl:list'/.test(src) && /'nl:overrides:patch'/.test(src), '管理通道该已注册')
})

console.log(`\n===== nl-manage: ${pass} 通过, ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
