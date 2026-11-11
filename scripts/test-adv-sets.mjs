/**
 * 高级替换方案库回归(2026-11-09) —— npm run test:advsets
 * ========================================================
 * 守的是「多套方案存得住、导出真的认 adv_set」:
 *   ① 缺文件时建「默认」空方案(与旧行为一致, 不炸)
 *   ② save/读往返: cfg 白名单收敛(脏字段剥掉 / rates 类型收敛 / 中文名建 id)
 *   ③ cfg 留空 = 沿用库值(自动落盘只送当前方案, 其他方案不许被误清空)
 *   ④ exporter 认 adv_set: '@active' / 方案 id / '0'(全关) / 不存在(落回快照)
 *   ⑤ 负向控制: 不带 adv_set 的快照参数照旧生效(老预设兼容)
 *
 * 用法: node scripts/test-adv-sets.mjs   (需要沙箱库, 先跑一次 e2e)
 */
import nassert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.e2e-work', 'adv-sets')
const SANDBOX_DATA = path.join(ROOT, '.e2e-work', 'data')
process.env.TV_DATA_DIR = SANDBOX_DATA
process.env.TV_KNOWLEDGE_DIR ||= path.join(ROOT, 'knowledge')

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}
const assert = (c, m) => { if (!c) throw new Error(m) }

if (!fs.existsSync(path.join(SANDBOX_DATA, 'db', 'tags.db'))) {
  console.error(`缺少沙箱库: ${path.join(SANDBOX_DATA, 'db', 'tags.db')}\n先跑一次 scripts/e2e.mjs 让它准备好`)
  process.exit(2)
}

const { initWorkspace } = await import(pathToFileURL(path.join(ROOT, 'electron/core/workspace.js')).href)
initWorkspace(path.join(WORK, 'userdata'))
const { advSets, saveAdvSets, advSetById } = await import(pathToFileURL(path.join(ROOT, 'electron/core/adv-sets.js')).href)
const { loadConfig, resolveDataFiles } = await import(pathToFileURL(path.join(ROOT, 'electron/core/config.js')).href)
const { loadDataset } = await import(pathToFileURL(path.join(ROOT, 'electron/core/dataset.js')).href)
const { buildExport } = await import(pathToFileURL(path.join(ROOT, 'electron/core/exporter.js')).href)

await loadDataset(resolveDataFiles(loadConfig(), null), () => {})

const SETS_FILE = path.join(SANDBOX_DATA, 'adv_sets.json')   // dataFile() 基于 TV_DATA_DIR
// 每次从全空开始(上一轮测试的残留不影响断言)
fs.rmSync(SETS_FILE, { force: true })

console.log('\n=== ① 缺文件 → 建「默认」空方案 ===')
const first = advSets()
ok('缺文件 → 自动建默认方案并落盘', () => {
  nassert.equal(first.sets.length, 1, `应有 1 个方案, 实际 ${first.sets.length}`)
  nassert.equal(first.sets[0].id, 'adv-default', `id: ${first.sets[0].id}`)
  nassert.equal(first.active, 'adv-default')
  nassert.equal(first.sets[0].cfg.enabled, false, '默认方案应该是全空(enabled=false)')
  nassert.ok(fs.existsSync(SETS_FILE), '没落盘')
})

console.log('\n=== ② 存取往返 + cfg 收敛 ===')
const cfgA = {
  enabled: true,
  picked: ['pose', 'legwear'],
  rates: { pose: 1, legwear: 0.65, bogus: 'abc', neg: -3 },
  pins: [{ slot: 'headwear', word: 'hat' }, { slot: '', word: 'x' }, { slot: 'hair_color', word: '  ' }],
  pinFill: false,
  banned: ['eyewear', 'hair_len', 'hair_color', 'hairstyle'],
  nsfw: false,
  seed: 'seed-a',
  nl: { enabled: true, dims: ['pose', 'hair'], level: 'soft', poseView: false,
    stripPose: true, stripCostume: true, stripHair: true, seed: 'nl-a', junk: 1 },
  junkTop: 'dirty',
}
const saved = saveAdvSets({
  active: 'adv-A',
  sets: [
    { id: 'adv-default', name: '默认' },          // cfg 空 = 沿用库值(默认方案保持全空)
    { id: 'adv-A', name: '方案A', cfg: cfgA },
    { name: '鸟居方案' },                          // 新建: cfg 空 → 全空 cfg
  ],
})
ok('保存后读回: 3 个方案, active 指向 adv-A', () => {
  nassert.equal(saved.sets.length, 3, `实际 ${saved.sets.map((s) => s.name).join(',')}`)
  nassert.equal(saved.active, 'adv-A')
  const back = advSets()
  nassert.equal(back.active, 'adv-A')
  nassert.equal(back.sets.length, 3)
})
ok('cfg 白名单: 脏字段剥掉, rates 非法值剥掉', () => {
  const a = saved.sets.find((s) => s.id === 'adv-A')
  nassert.ok(!('junkTop' in a.cfg), '顶层脏字段没剥掉')
  nassert.ok(!('junk' in a.cfg.nl), 'nl 脏字段没剥掉')
  nassert.deepEqual(a.cfg.rates, { pose: 1, legwear: 0.65 }, `rates 收敛失败: ${JSON.stringify(a.cfg.rates)}`)
  nassert.equal(a.cfg.pins.length, 1, '空钉词行该被过滤')
  nassert.equal(a.cfg.pins[0].slot, 'headwear')
})
ok('inserts 收敛 + 三态互斥兜底(禁用 > 插入 > 随机)', () => {
  const r = saveAdvSets({ active: 'adv-A', sets: [
    { id: 'adv-A', name: '方案A', cfg: {
      ...cfgA,
      picked: ['pose', 'legwear', 'eyewear'],   // eyewear 同时出现在三张清单里
      inserts: ['eyewear', 'headwear'],
      banned: ['eyewear', 'hair_len'],
    } },
  ] })
  const a = r.sets.find((s) => s.id === 'adv-A')
  nassert.ok(!a.cfg.inserts.includes('eyewear'), '被禁用的槽不该留在 inserts')
  nassert.ok(!a.cfg.picked.includes('eyewear'), '被禁用的槽不该留在 picked')
  nassert.ok(!a.cfg.picked.includes('headwear'), '插入槽不该同时留在 picked')
  nassert.ok(!a.cfg.inserts.includes('hair_len'), '被禁用的槽不该留在 inserts(第二个)')
  nassert.deepEqual(a.cfg.inserts, ['headwear'], `inserts 收敛失败: ${JSON.stringify(a.cfg.inserts)}`)
})
ok('新建方案: 中文名生成稳定可读 id, cfg 落全空', () => {
  const b = saved.sets.find((s) => s.name === '鸟居方案')
  nassert.ok(b, '新建方案丢了')
  nassert.equal(b.id, 'adv-鸟居方案', `id: ${b.id}`)
  nassert.equal(b.cfg.enabled, false)
  nassert.equal(b.cfg.nl.level, 'sfw')
})
ok('cfg 留空 = 沿用库值(默认方案没被误清空)', () => {
  const d = saved.sets.find((s) => s.id === 'adv-default')
  nassert.equal(d.cfg.enabled, false, '默认方案 cfg 应保持全空')
  // 再存一次, 这次给默认方案塞点东西, 然后不带它的 cfg 存 —— 库值必须保留
  saveAdvSets({ active: 'adv-default', sets: [
    { id: 'adv-default', name: '默认', cfg: { ...cfgA, enabled: true } },
    { id: 'adv-A', name: '方案A' },              // 不带 cfg
  ] })
  const { sets } = advSets()
  const a = sets.find((s) => s.id === 'adv-A')
  nassert.equal(a.cfg.rates.legwear, 0.65, 'adv-A 的库值被误改了')
})

console.log('\n=== ④⑤ exporter 认 adv_set ===')
const BASE = { q: '1girl', max_rows: 40, spaces: '1' }
const linesOf = (r) => r.text.trim().split('\n').filter(Boolean)

// 负向控制①: 库里确实有 pose 词(方案里勾了随机 pose, 输出必须有可换的词)
const plain = buildExport({ ...BASE })
// 归一化比对: spaces='1' 时输出是空格、词表是下划线 —— 不归一就漏计
const norm = (t) => t.trim().toLowerCase().replace(/_/g, ' ')
const hasBare = (line, words) => line.split(', ').some((t) => words.has(norm(t)))
const poseWords = new Set(['standing', 'sitting', 'lying', 'kneeling', 'on back', 'arm up', 'arm behind back',
  'hands together', 'crossed legs', 'v arms', 'own hands together', 'looking at viewer', 'crying', 'smile',
  'open mouth', 'squatting', 'hand on own chest', 'head tilt'])
const poseLineCount = linesOf(plain).filter((l) => hasBare(l, poseWords)).length
ok('负向控制: 不带 adv_set 的快照参数照旧生效(老预设兼容)', () => {
  nassert.ok(poseLineCount > 0, `40 行里 0 行含 pose 词 —— 随机断言会假通过`)
  const snap = buildExport({ ...BASE, randomize: '1', randomize_slots: 'pose', randomize_seed: 's1' })
  nassert.ok(snap.randomized > 0, `快照参数没生效: randomized=${snap.randomized}`)
  const snap2 = buildExport({ ...BASE, randomize: '1', randomize_slots: 'pose', randomize_seed: 's1' })
  nassert.equal(linesOf(snap).join('\n'), linesOf(snap2).join('\n'), '同种子不可复现')
})

// 方案 id 直引: enabled + 随机 pose + 禁发型槽 + NL 发型句
ok('adv_set=<方案id>: 方案 cfg 生成同形参数并生效', () => {
  const r = buildExport({ ...BASE, adv_set: 'adv-A', randomize: '0', randomize_slots: '', ban_slots: '', nl_dims: '' })
  nassert.ok(r.randomized > 0, `方案里的随机 pose 没生效: randomized=${r.randomized}`)
  nassert.ok(r.slotBanned > 0, `方案里的禁用发型槽没生效: slotBanned=${r.slotBanned}`)
  nassert.ok(r.nl && r.nl.dims.includes('hair'), `方案里的 NL 维度没生效: ${JSON.stringify(r.nl?.dims)}`)
  nassert.equal(r.nl.level, 'soft', `档位没跟上方案: ${r.nl.level}`)
  // 方案里的 nl.poseView=false → 不该有机位句
  const withView = linesOf(r).filter((l) => /, seen (from|in) /.test(l)).length
  nassert.equal(withView, 0, `${withView} 行带机位句, 但方案里 poseView=false`)
})
ok('adv_set=@active: 跟随库里的 active 方案', () => {
  saveAdvSets({ active: 'adv-A', sets: advSets().sets.map((s) => ({ id: s.id, name: s.name })) })
  const r = buildExport({ ...BASE, adv_set: '@active' })
  nassert.ok(r.nl && r.nl.dims.includes('hair'), '@active 没跟到方案 A')
})
ok('adv_set=0: 连 NL 段一起全关(回执 nl=null 且不禁词)', () => {
  const r = buildExport({ ...BASE, adv_set: '0', randomize: '1', randomize_slots: 'pose', nl_dims: 'hair' })
  nassert.equal(r.randomized, 0, `adv_set=0 后随机还在: ${r.randomized}`)
  nassert.equal(r.slotBanned, 0, `adv_set=0 后还在禁词: ${r.slotBanned}`)
  nassert.equal(r.nl, null, `adv_set=0 后 NL 还开着: ${JSON.stringify(r.nl)}`)
})
ok('adv_set 指向不存在的方案 → 落回快照参数(不静默关闭)', () => {
  const r = buildExport({ ...BASE, adv_set: 'adv-ghost', randomize: '1', randomize_slots: 'pose', randomize_seed: 's9' })
  nassert.ok(r.randomized > 0, '快照参数没生效 —— 方案不存在时不该动行为')
})

console.log('\n=== ⑥ 插入槽(2026-11-09): 缺词从槽池补上 ===')
const { randomSlots } = await import(pathToFileURL(path.join(ROOT, 'electron/core/export-random.js')).href)
const eyewearWords = new Set(
  (randomSlots().find((s) => s.id === 'eyewear')?.words || []).map((w) => norm(w)),
)
const cntEyewear = (r) => linesOf(r).filter((l) => hasBare(l, eyewearWords)).length
// 专用方案: 只插 eyewear, 别的不碰; 留空 rates = 100% 必补
saveAdvSets({ active: 'adv-INS', sets: [
  { id: 'adv-INS', name: '插入测试', cfg: {
    enabled: true, picked: [], inserts: ['eyewear'], rates: {},
    pins: [], pinFill: true, banned: [], nsfw: true, seed: '',
    nl: { enabled: false, dims: [], level: 'sfw', poseView: true, stripPose: true, stripCostume: true, stripHair: true, seed: '' },
  } },
] })
ok('负向控制: 基线里 eyewear 词确实不是行行都有(否则"补上"是假通过)', () => {
  nassert.ok(eyewearWords.size > 0, 'randomSlots 里没拿到 eyewear 词表')
  const base = cntEyewear(buildExport({ ...BASE }))
  nassert.ok(base < 40, `基线 ${base}/40 行都含 eyewear —— 换个槽测插入`)
})
ok('插入槽(方案路径): 每行必现该槽词(100% 率)', () => {
  const r = buildExport({ ...BASE, adv_set: 'adv-INS' })
  nassert.equal(cntEyewear(r), 40, `插入后应 40/40 行含 eyewear, 实际 ${cntEyewear(r)}`)
  nassert.ok(r.randomized > 0, '插入没计入 randomized 回执')
})
/* 率/禁用/种子的变体走**快照参数**路径 —— adv_set 路径下方案 cfg 参数整体覆盖
 * raw, 传 insert_slots/ban_slots/randomize_seed 会被方案的值盖掉(设计如此:
 * 选了方案就该整套听方案的), 只有快照路径才能逐项变体。 */
ok('插入槽(快照路径): 每行必现该槽词', () => {
  const r = buildExport({ ...BASE, randomize: '1', randomize_slots: 'eyewear', insert_slots: 'eyewear', randomize_seed: 'ins1' })
  nassert.equal(cntEyewear(r), 40, `实际 ${cntEyewear(r)}`)
})
ok('插入率 0% → 不补(与基线一致)', () => {
  const base = cntEyewear(buildExport({ ...BASE }))
  const r = buildExport({ ...BASE, randomize: '1', randomize_slots: 'eyewear:0', insert_slots: 'eyewear:0', randomize_seed: 'ins2' })
  nassert.equal(cntEyewear(r), base, '率 0 还在补词')
})
ok('插入 × 禁用同槽 → 导出端兜底不补(防绕过剔除)', () => {
  const r = buildExport({ ...BASE, randomize: '1', randomize_slots: 'eyewear', insert_slots: 'eyewear', ban_slots: 'eyewear' })
  nassert.equal(cntEyewear(r), 0, '被禁用的槽还在补词 —— 绕过了剔除')
})
ok('插入同种子可复现', () => {
  const a = buildExport({ ...BASE, randomize: '1', randomize_slots: 'eyewear', insert_slots: 'eyewear', randomize_seed: 'ins3' })
  const b = buildExport({ ...BASE, randomize: '1', randomize_slots: 'eyewear', insert_slots: 'eyewear', randomize_seed: 'ins3' })
  nassert.equal(linesOf(a).join('\n'), linesOf(b).join('\n'), '同种子两次结果不同')
})

console.log('\n=== ⑦ 权重(2026-11-10): 钉词权重 / 槽位权重 ===')
/* 权重壳的判定: (tag:1.4) 这种形态(尾零会省掉)。spaces='1' 会把下划线换空格, 但括号与冒号原样,
 * 所以先剥壳再归一才能跟词表比。 */
const RE_W = /^\((.+):(\d+(?:\.\d+)?)\)$/
const bareOf = (t) => norm(String(t).replace(RE_W, '$1'))
const isWrapped = (t) => RE_W.test(String(t).trim())
const tokensOf = (line) => line.split(', ').map((t) => t.trim()).filter(Boolean)
const legwearPool = (randomSlots().find((s) => s.id === 'legwear')?.words || [])
ok('负向控制: legwear 池里确实有词(否则权重断言没意义)', () => {
  nassert.ok(legwearPool.length > 3, `legwear 池只有 ${legwearPool.length} 个词`)
})

// 钉词权重走**快照参数**(确定性最强): 每行必现同一个词, 直接看它有没有套壳
const pinWord = legwearPool[0]
ok('钉词权重: pin_slots=legwear:词@1.4 → 每行都是 (词:1.4), 不出现裸词', () => {
  const r = buildExport({ ...BASE, randomize: '1', pin_slots: `legwear:${pinWord}@1.4`, pin_fill: '1' })
  const lines = linesOf(r)
  const wrapped = `(${norm(pinWord)}:1.4)`
  const hit = lines.filter((l) => l.includes(wrapped)).length
  nassert.equal(hit, lines.length, `只有 ${hit}/${lines.length} 行带 ${wrapped}`)
  // 裸词不能一起出现(钉词阶段同槽只留一个词)
  const bareCnt = lines.reduce((n, l) => n + tokensOf(l).filter((t) => !isWrapped(t) && norm(t) === norm(pinWord)).length, 0)
  nassert.equal(bareCnt, 0, `还有 ${bareCnt} 个裸 ${pinWord}`)
})
ok('钉词权重缺省(=1) → 不加壳(老格式不变)', () => {
  const r = buildExport({ ...BASE, randomize: '1', pin_slots: `legwear:${pinWord}`, pin_fill: '1' })
  const lines = linesOf(r)
  const wrapped = lines.reduce((n, l) => n + tokensOf(l).filter((t) => isWrapped(t) && bareOf(t) === norm(pinWord)).length, 0)
  nassert.equal(wrapped, 0, `默认权重却套了壳: ${wrapped} 处`)
  nassert.ok(lines.every((l) => norm(l).includes(norm(pinWord))), '钉词没生效 —— 前置断言失败')
})
ok('钉词权重经方案库走通(adv_set 路径)', () => {
  saveAdvSets({ active: 'adv-W', sets: [
    { id: 'adv-W', name: '权重钉词', cfg: {
      enabled: true, picked: [], inserts: [], rates: {}, weights: {}, pins: [{ slot: 'legwear', word: pinWord, weight: 1.6 }],
      pinFill: true, banned: [], nsfw: true, seed: '',
      nl: { enabled: false, dims: [], level: 'sfw', poseView: true, stripPose: true, stripCostume: true, stripHair: true, seed: '' },
    } },
  ] })
  const r = buildExport({ ...BASE, adv_set: 'adv-W' })
  const wrapped = `(${norm(pinWord)}:1.6)`
  const hit = linesOf(r).filter((l) => l.includes(wrapped)).length
  nassert.equal(hit, linesOf(r).length, `方案里的钉词权重没生效: ${hit}/${linesOf(r).length}`)
})

/* 槽位权重: 换出来的词套壳。rate 100% 时该槽每个词都会被换, 所以输出里不该剩裸词;
 * 种子固定 = 完全可复现, 不存在偶发。 */
const legwearSet = new Set(legwearPool.map((w) => norm(w)))
const cntLegwear = (lines) => lines.reduce((n, l) => n + tokensOf(l).filter((t) => legwearSet.has(bareOf(t))).length, 0)
const cntWrappedLegwear = (lines) => lines.reduce((n, l) => n + tokensOf(l).filter((t) => isWrapped(t) && legwearSet.has(bareOf(t))).length, 0)
ok('负向控制: 基线里 legwear 词是行行都有的', () => {
  nassert.ok(cntLegwear(linesOf(plain)) > 0, '基线 0 个 legwear 词 —— 下面的权重断言会假通过')
})
ok('槽位权重: slot_weights=legwear:1.3 → 换出来的 legwear 词全部套壳, 一个裸词都不剩', () => {
  const r = buildExport({ ...BASE, randomize: '1', randomize_slots: 'legwear', slot_weights: 'legwear:1.3', randomize_seed: 'w1' })
  const lines = linesOf(r)
  const all = cntLegwear(lines)
  const wrapped = cntWrappedLegwear(lines)
  nassert.ok(all > 0, '输出里没有 legwear 词')
  nassert.equal(wrapped, all, `有 ${all - wrapped} 个 legwear 词没套壳(共 ${all})`)
  nassert.ok(lines.some((l) => l.includes(':1.3)')), '权重数值不对(应为 1.3)')
})
ok('槽位权重 =1 → 不加壳(与老行为逐字一致)', () => {
  const a = buildExport({ ...BASE, randomize: '1', randomize_slots: 'legwear', randomize_seed: 'w1' })
  const b = buildExport({ ...BASE, randomize: '1', randomize_slots: 'legwear', slot_weights: 'legwear:1', randomize_seed: 'w1' })
  nassert.equal(linesOf(a).join('\n'), linesOf(b).join('\n'), '权重 1 改变了输出')
})
ok('槽位权重非法值 → 忽略(不套壳, 不报错)', () => {
  const r = buildExport({ ...BASE, randomize: '1', randomize_slots: 'legwear', slot_weights: 'legwear:abc,,,:,', randomize_seed: 'w1' })
  nassert.equal(cntWrappedLegwear(linesOf(r)), 0, '非法权重也套了壳')
})

/* ================= 混合来源(2026-11-11) =================
 * 混合的配比要存得住, 且手改 json 写重了(同维度既挂 nl 又挂 mix)要能收敛 ——
 * 一个维度只能有一种供词方式, 否则导出端会同时剔槽又抽句, 产物自相矛盾。 */
console.log('\n=== 混合来源 ===')
ok('方案库存得住 mix 配比, 发型的图库段被抹成 0', () => {
  const first = advSets().sets[0]
  saveAdvSets({
    active: first.id,
    sets: [{
      id: first.id,
      name: first.name,
      cfg: {
        mix: {
          enabled: true,
          seed: 's1',
          ratios: { pose: { tag: 40, nl: 40, cd: 20 }, hair: { tag: 50, nl: 50, cd: 30 } },
        },
      },
    }],
  })
  const back = advSetById(first.id)
  nassert.ok(back?.cfg?.mix, '读回来没有 mix 段')
  nassert.equal(back.cfg.mix.enabled, true)
  nassert.deepEqual(back.cfg.mix.ratios.pose, { tag: 40, nl: 40, cd: 20 })
  nassert.equal(back.cfg.mix.ratios.hair.cd, 0, '发型没有图库池, cd 该被抹成 0')
})

ok('同维度既挂 nl 又挂 mix → 混合赢, 那个维度从 nl 里摘掉', () => {
  const first = advSets().sets[0]
  saveAdvSets({
    active: first.id,
    sets: [{
      id: first.id,
      name: first.name,
      cfg: {
        nl: { enabled: true, dims: ['pose', 'hair'], level: 'sfw' },
        mix: { enabled: true, ratios: { pose: { tag: 40, nl: 40, cd: 20 } } },
      },
    }],
  })
  const back = advSetById(first.id)
  nassert.deepEqual(back.cfg.nl.dims, ['hair'], `nl 该只剩 hair, 实际 ${JSON.stringify(back.cfg.nl.dims)}`)
  nassert.equal(back.cfg.nl.enabled, true, 'hair 还在用 nl, 不该整段关掉')
  nassert.ok(back.cfg.mix.ratios.pose, '混合段丢了')
})

ok('配比全 0 → 该维度不开混合(enabled 落 false)', () => {
  const first = advSets().sets[0]
  saveAdvSets({
    active: first.id,
    sets: [{
      id: first.id,
      name: first.name,
      cfg: { mix: { enabled: true, ratios: { pose: { tag: 0, nl: 0, cd: 0 } } } },
    }],
  })
  const back = advSetById(first.id)
  nassert.equal(back.cfg.mix.enabled, false, '全 0 还开着混合, 会白跑一遍 roll')
  nassert.equal(Object.keys(back.cfg.mix.ratios).length, 0)
})

console.log(`\n===== adv-sets: ${pass} 通过, ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
