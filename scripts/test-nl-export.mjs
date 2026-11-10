/**
 * 自然语言段端到端回归(2026-11-08) —— npm run test:nlexport
 * ========================================================
 * 守的是「用户勾了自然语言，导出文件里真的有那句话，而且不雷同」。
 * 单元测试(test:nlbank)只验抽签器本身，这条走完整导出管线(exporter.js)。
 *
 * 断言:
 *   ① 不开 nl_dims 时输出与老版逐字一致(回归保护 —— 新功能不能动默认行为)
 *   ② nl_dims=pose: 每行末尾出现 "she is ...", 且 60 行动作互不相同
 *   ③ 回执的 nl.dup.rate === 0
 *   ④ 抽了动作句就把原图 pose/pose_base 词剔掉(否则 "standing" 与
 *      "lying on her side" 打架)
 *   ⑤ nl_dims=pose,costume,hair 三段齐全
 *   ⑥ nl_level=sfw 时抽不到 soft/nsfw 句
 *   ⑦ with_path 模式下前缀完好(路径 + ": " + 正文)
 *   ⑧ 穿搭/发型剔槽(2026-11-09): 抽穿搭句 → 13 个单品槽剔干净, 材质/穿着状态保留;
 *      抽发型句 → 长度/发色/发型剔干净, 发绳发卡保留; 两个开关 nl_strip_* 可关。
 * 负向控制: ④ 先断言"不开 nl 时这些行里确实有 pose 类 tag", 否则
 * "剔掉了" 可能只是因为库里本来就没有(⑧ 同样带负向控制)。
 */
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.e2e-work', 'nl-export')
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
  console.error(`缺少沙箱库: ${path.join(SANDBOX_DATA, 'db', 'tags.db')}\n` +
    '这是 e2e 用的真实库副本, 跑 scripts/e2e.mjs 之前会被准备好')
  process.exit(2)
}

const { initWorkspace } = await import(pathToFileURL(path.join(ROOT, 'electron/core/workspace.js')).href)
initWorkspace(path.join(WORK, 'userdata'))
const { loadConfig, resolveDataFiles } = await import(pathToFileURL(path.join(ROOT, 'electron/core/config.js')).href)
const { loadDataset } = await import(pathToFileURL(path.join(ROOT, 'electron/core/dataset.js')).href)
const { buildExport } = await import(pathToFileURL(path.join(ROOT, 'electron/core/exporter.js')).href)
const { safetyMatcher } = await import(pathToFileURL(path.join(ROOT, 'electron/core/safety.js')).href)

await loadDataset(resolveDataFiles(loadConfig(), null), () => {})
safetyMatcher()   // 预热, 免得第一次导出时把词典加载算进耗时

const BASE = { q: '1girl', max_rows: 60, spaces: '1' }
const linesOf = (r) => r.text.trim().split('\n').filter(Boolean)

console.log('\n=== 回归保护: 不启用时行为不变 ===')
const plain = buildExport({ ...BASE })
ok('nl_dims 为空 → 回执 nl 是 null', () => {
  assert(plain.nl === null, `期望 null, 实际 ${JSON.stringify(plain.nl)}`)
})

ok('nl_dims 为空 → 输出里没有自然语言分句', () => {
  const bad = linesOf(plain).filter((l) => /she is |she is wearing |her hair is /.test(l))
  assert(bad.length === 0, `${bad.length} 行含自然语言分句:\n${bad[0]}`)
})

console.log(`  （样本 ${plain.count} 行, 首行: ${linesOf(plain)[0]?.slice(0, 90)}…）`)

console.log('\n=== 动作段 ===')
const withPose = buildExport({ ...BASE, nl_dims: 'pose', nl_seed: 'e2e-pose' })
const poseLines = linesOf(withPose)

/* 期望值用同一个 seed 直接问抽签器要 —— 比正则从行里"猜"哪里是自然语言段可靠得多:
 * 自然语言句内部本身带逗号("..., one hand braced against the wall, hips pushed back"),
 * 而且 21% 的动作句是名词短语开头(不套 "she is"), 正则一切就错。 */
const { makeNlPicker } = await import(pathToFileURL(path.join(ROOT, 'electron/core/nl-bank.js')).href)
const expectPose = []
{
  const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'e2e-pose' })
  for (let i = 0; i < poseLines.length; i++) expectPose.push(p.pick(i).text)
}

ok('每行都在末尾追加了动作句(与抽签器逐行一致)', () => {
  const bad = poseLines.filter((l, i) => !l.endsWith(expectPose[i]))
  assert(bad.length === 0, `${bad.length}/${poseLines.length} 行对不上:\n  期望 …${expectPose[0]}\n  实际 …${bad[0]?.slice(-60)}`)
})

ok('60 行动作两两不同(这就是"不再雷同")', () => {
  const uniq = new Set(expectPose)
  assert(expectPose.every(Boolean), '有行取不到动作句')
  assert(uniq.size === expectPose.length,
    `${expectPose.length} 行只有 ${uniq.size} 个不同动作, 重复 ${expectPose.length - uniq.size} 条`)
})

ok('名词短语开头的动作句不套 "she is"(避免病句)', () => {
  const bad = expectPose.filter((s) => /^she is (?:both |one |her |hands |legs |arms )/.test(s))
  assert(bad.length === 0, `出现病句: ${bad[0]}`)
})

ok('回执报的批内重复率是 0', () => {
  assert(withPose.nl, '回执里没有 nl 段')
  assert(withPose.nl.picked === withPose.count, `picked ${withPose.nl.picked} ≠ count ${withPose.count}`)
  assert(withPose.nl.dup.dup === 0, `重复 ${withPose.nl.dup.dup} 条, rate=${withPose.nl.dup.rate}`)
})

console.log('\n=== 动作句与 tag 不打架 ===')
const { randomSlots } = await import(pathToFileURL(path.join(ROOT, 'electron/core/export-random.js')).href)
const poseSlotTags = new Set(
  (randomSlots().find((s) => s.id === 'pose')?.words || []).map((w) => w.toLowerCase().replace(/[_]+/g, ' '))
)
const hasPoseTag = (line) => stripNl(line).split(', ').some((t) => poseSlotTags.has(t.trim().toLowerCase()))

/**
 * 剥掉行尾的自然语言段, 只留 tag 部分。
 *
 * 为什么不能用正则"猜"起点: ① 自然语言句内部本身就带逗号
 * ("she is sitting upright with her chest out, leaning back"), ② 21% 的动作句是
 * 名词短语开头, 根本不带 "she is"。两种都会让句子碎片被当成 tag 命中(实测假阳性)。
 * 所以改成拿语料库**反着匹配**: 行尾能对上哪句就切哪句, 循环到切不动为止。
 */
const NL_SENTENCES = (() => {
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'nl-bank.json'), 'utf8'))
  const out = []
  for (const p of bank.pose || []) out.push(p.en, `she is ${p.en}`)
  // 机位不是维度了: bank.views 是 {中文角度: 英文句} 的映射表
  for (const v of Object.values(bank.views || {})) out.push(`seen ${v}`)
  for (const c of bank.costume || []) out.push(`she is wearing ${c.en}`)
  for (const h of bank.hair || []) out.push(`her hair is ${h.en}`)
  return out.sort((a, b) => b.length - a.length)   // 长的先试, 免得短句抢先截断
})()
function stripNl(line) {
  let cur = line
  for (let guard = 0; guard < 8; guard++) {
    const hit = NL_SENTENCES.find((s) => cur.endsWith(s) || cur.endsWith(`${s},`))
    if (!hit) break
    cur = cur.slice(0, cur.length - hit.length).replace(/[,\s]+$/, '')
  }
  return cur
}

ok('负向控制: 不开 nl 时这些行里确实有 pose 类 tag', () => {
  const n = linesOf(plain).filter(hasPoseTag).length
  assert(n > 0, '关掉 nl 也没找到 pose 类 tag —— 后面的"剔掉了"会变成假通过')
  console.log(`      不开 nl: ${n}/${plain.count} 行含 pose 类 tag`)
})

ok('开 nl 后原图 pose 类 tag 被剔除', () => {
  const n = poseLines.filter(hasPoseTag).length
  assert(n === 0, `还有 ${n} 行留着 pose 类 tag, 会和动作句冲突`)
})

ok('nl_strip_pose=0 可以关掉动作槽剔除(用户想两者都要时)', () => {
  const keep = buildExport({ ...BASE, nl_dims: 'pose', nl_seed: 'e2e-keep', nl_strip_pose: '0' })
  const n = linesOf(keep).filter(hasPoseTag).length
  assert(n > 0, '关掉剔除后 pose tag 还是没了 —— 开关没接上')
  // 机位默认还开着 → 视角槽照样该禁; 两个开关都关掉才应该一个词都不禁
  const off = buildExport({ ...BASE, nl_dims: 'pose', nl_seed: 'e2e-keep', nl_strip_pose: '0', nl_pose_view: '0' })
  assert(off.slotBanned === 0, `动作槽和机位都关掉后仍在禁词: ${off.slotBanned} 个`)
})

/* 剔的必须是**整个动作面**, 不是只有一个 pose 槽(2026-11-08 用户指出:
 * 「自然语言启用的话, 是不是应该把动作相关的槽位给替换了」)。
 * 动作类槽共 4 个: pose / pose_base / pose_risque / n_pos —— 后两个以前漏网。 */
const slotWords = (id) => new Set(
  (randomSlots().find((s) => s.id === id)?.words || []).map((w) => w.toLowerCase().replace(/_+/g, ' '))
)
const ACTION_SLOTS = ['pose', 'pose_base', 'pose_risque', 'n_pos']
const actionSet = new Set(ACTION_SLOTS.flatMap((id) => [...slotWords(id)]))
const hasActionTag = (line) => stripNl(line).split(', ').some((t) => actionSet.has(t.trim().toLowerCase()))
const risqueOnlySet = new Set([...slotWords('pose_risque'), ...slotWords('n_pos')])
const hasTagIn = (line, set) => stripNl(line).split(', ').some((t) => set.has(t.trim().toLowerCase()))

ok('负向控制: 不剔的话, 库里确有 pose_risque/n_pos 这类动作词', () => {
  const n = linesOf(plain).filter((l) => hasTagIn(l, risqueOnlySet)).length
  const nAll = linesOf(plain).filter(hasActionTag).length
  console.log(`      不开 nl: ${nAll}/${plain.count} 行含动作槽词, 其中 ${n} 行靠 pose_risque/n_pos 才算`)
  assert(nAll > 0, '一条动作槽词都没有 —— 后面的"剔干净了"会变成假通过')
})

ok('开 nl 后**全部**动作槽词都剔干净(不只 pose)', () => {
  const bad = poseLines.filter(hasActionTag)
  const leftover = [...new Set(bad.flatMap((l) => l.split(', ').filter((t) => actionSet.has(t.trim().toLowerCase()))))]
  assert(bad.length === 0, `还有 ${bad.length} 行留着动作槽词: ${leftover.join(', ')}`)
})

console.log('\n=== 机位(2026-11-08: 跟着动作成套, 不是独立维度) ===')
const viewSet = new Set([...slotWords('viewpoint'), ...slotWords('camera_angle')])
const shotSet = slotWords('shot_size')
const withView = buildExport({ ...BASE, nl_dims: 'pose', nl_seed: 'e2e-view' })
const lv = linesOf(withView)
const nPlainView = linesOf(plain).filter((l) => hasTagIn(l, viewSet)).length

ok('负向控制: 不开 nl 时这些行里确实有视角/机位 tag', () => {
  assert(nPlainView > 0, `60 行里一条视角 tag 都没有(${nPlainView}) —— 后面的断言会假通过`)
  console.log(`      不开 nl: ${nPlainView}/${plain.count} 行含视角/机位 tag`)
})

ok('每行都追加了机位句 "seen from …"', () => {
  const bad = lv.filter((l) => !/, seen from /.test(l))
  assert(bad.length === 0, `${bad.length} 行没有机位句:\n${bad[0]}`)
})

ok('开 nl 后原图视角/机位 tag 被剔除(不与机位句打架)', () => {
  const left = lv.filter((l) => hasTagIn(l, viewSet)).length
  assert(left === 0, `还有 ${left} 行留着视角 tag`)
})

ok('景别(shot_size)不受影响 —— 剔的是视角, 不是景别', () => {
  const a = linesOf(plain).filter((l) => hasTagIn(l, shotSet)).length
  const b = lv.filter((l) => hasTagIn(l, shotSet)).length
  console.log(`      含景别词的行: 不开 nl ${a} / 开 nl ${b}`)
  assert(a === b, `景别被误伤了: ${a} → ${b} (景别与机位正交, 不该动)`)
})

ok('nl_pose_view=0: 不出机位半句, 视角 tag 保留', () => {
  const keep = buildExport({ ...BASE, nl_dims: 'pose', nl_seed: 'e2e-view2', nl_pose_view: '0' })
  const ls = linesOf(keep)
  const withViewSentence = ls.filter((l) => /, seen from /.test(l)).length
  assert(withViewSentence === 0, `${withViewSentence} 行还带了机位句`)
  const n = ls.filter((l) => hasTagIn(l, viewSet)).length
  assert(n > 0, '关掉机位后视角 tag 也被剔了 —— 剔词条件没跟开关绑定')
})

console.log('\n=== 穿搭/发型剔槽(2026-11-09: 同语义面整批剔, 互补槽保留) ===')
const COSTUME_SLOTS = ['top', 'bottom', 'outfit', 'underwear', 'legwear', 'footwear',
  'headwear', 'handwear', 'accessory', 'eyewear', 'sleeves', 'swimwear', 'clothing_type']
const costumeSet = new Set(COSTUME_SLOTS.flatMap((id) => [...slotWords(id)]))
const costumeKeepSet = new Set(['cloth_mat', 'cloth_state_sfw', 'clothing_state'].flatMap((id) => [...slotWords(id)]))
const HAIR_SHAPE_SLOTS = ['hair_len', 'hair_color', 'hairstyle']
const hairShapeSet = new Set(HAIR_SHAPE_SLOTS.flatMap((id) => [...slotWords(id)]))
const hairKeepSet = new Set(['hair_tie', 'hair_acc'].flatMap((id) => [...slotWords(id)]))

const withCostume = buildExport({ ...BASE, nl_dims: 'costume', nl_seed: 'e2e-costume' })
const lc = linesOf(withCostume)
ok('负向控制: 不开 nl 时这些行里确实有服装单品词', () => {
  const n = linesOf(plain).filter((l) => hasTagIn(l, costumeSet)).length
  assert(n > 0, `${n} 行含服装单品词 —— 后面的"剔干净了"会变成假通过`)
  console.log(`      不开 nl: ${n}/${plain.count} 行含服装单品词`)
})
ok('抽穿搭句后全部单品槽词剔干净(school uniform 不再与 she is wearing 打架)', () => {
  const bad = lc.filter((l) => hasTagIn(l, costumeSet))
  const leftover = [...new Set(bad.flatMap((l) => l.split(', ').filter((t) => costumeSet.has(t.trim().toLowerCase()))))]
  assert(bad.length === 0, `还有 ${bad.length} 行留着单品词: ${leftover.slice(0, 6).join(', ')}`)
})
ok('材质/穿着状态槽保留(cloth_mat/cloth_state_sfw/clothing_state 是互补信息)', () => {
  const a = linesOf(plain).filter((l) => hasTagIn(l, costumeKeepSet)).length
  const b = lc.filter((l) => hasTagIn(l, costumeKeepSet)).length
  console.log(`      含互补槽词的行: 不开 nl ${a} / 开 nl ${b}`)
  assert(a === b, `互补槽被误伤了: ${a} → ${b}`)
})
ok('nl_strip_costume=0 可关掉单品槽剔除', () => {
  const keep = buildExport({ ...BASE, nl_dims: 'costume', nl_seed: 'e2e-ck', nl_strip_costume: '0' })
  const n = linesOf(keep).filter((l) => hasTagIn(l, costumeSet)).length
  assert(n > 0, '关掉剔除后单品词还是没了 —— 开关没接上')
})

const withHair = buildExport({ ...BASE, nl_dims: 'hair', nl_seed: 'e2e-hair' })
const lh = linesOf(withHair)
ok('负向控制: 不开 nl 时这些行里确实有发型形状词', () => {
  const n = linesOf(plain).filter((l) => hasTagIn(l, hairShapeSet)).length
  assert(n > 0, `${n} 行含发型形状词 —— 后面的"剔干净了"会变成假通过`)
  console.log(`      不开 nl: ${n}/${plain.count} 行含发型形状词`)
})
ok('抽发型句后长度/发色/发型三槽剔干净(long hair 不再与 her hair is a short bob 打架)', () => {
  const bad = lh.filter((l) => hasTagIn(l, hairShapeSet))
  const leftover = [...new Set(bad.flatMap((l) => l.split(', ').filter((t) => hairShapeSet.has(t.trim().toLowerCase()))))]
  assert(bad.length === 0, `还有 ${bad.length} 行留着发型形状词: ${leftover.slice(0, 6).join(', ')}`)
})
ok('发绳/发卡保留(hair_tie/hair_acc 句子不提, 是互补信息)', () => {
  const a = linesOf(plain).filter((l) => hasTagIn(l, hairKeepSet)).length
  const b = lh.filter((l) => hasTagIn(l, hairKeepSet)).length
  console.log(`      含发饰词的行: 不开 nl ${a} / 开 nl ${b}`)
  assert(a === b, `发饰被误伤了: ${a} → ${b}`)
})
ok('nl_strip_hair=0 可关掉发型槽剔除', () => {
  const keep = buildExport({ ...BASE, nl_dims: 'hair', nl_seed: 'e2e-hk', nl_strip_hair: '0' })
  const n = linesOf(keep).filter((l) => hasTagIn(l, hairShapeSet)).length
  assert(n > 0, '关掉剔除后发型词还是没了 —— 开关没接上')
})

console.log('\n=== 三维度全开 ===')
const all3 = buildExport({ ...BASE, max_rows: 30, nl_dims: 'pose,costume,hair', nl_seed: 'e2e-all' })
const l3 = linesOf(all3)
const expectAll = []
{
  const p = makeNlPicker({ dims: ['pose', 'costume', 'hair'], maxLevel: 'sfw', seed: 'e2e-all' })
  for (let i = 0; i < l3.length; i++) expectAll.push(p.pick(i).text)
}
ok('每行三段齐全(动作 + 穿搭 + 发型)', () => {
  const bad = l3.filter((l, i) => !l.endsWith(expectAll[i]))
  assert(bad.length === 0, `${bad.length} 行与抽签器对不上:\n  期望 …${expectAll[0]}\n  实际 …${bad[0]?.slice(-70)}`)
  const missing = expectAll.filter((t) => !t.includes('she is wearing ') || !t.includes('her hair is '))
  assert(missing.length === 0, `${missing.length} 行缺穿搭或发型段: ${missing[0]}`)
})
ok('三段的组合也互不相同', () => {
  const uniq = new Set(expectAll)
  assert(uniq.size === expectAll.length, `${expectAll.length} 行只有 ${uniq.size} 种组合`)
})
console.log(`  （样本: ${l3[0]?.slice(0, 200)}…）`)

console.log('\n=== 档位闸门 ===')
const { nlBankStats } = await import(pathToFileURL(path.join(ROOT, 'electron/core/nl-bank.js')).href)
const st = nlBankStats()
const softSet = new Set()
{
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'nl-bank.json'), 'utf8'))
  for (const it of bank.pose) if (it.level !== 'sfw') softSet.add(it.en)
}
ok(`sfw 档抽 60 条, 没有一条出自 soft/nsfw 句子(库里共 ${softSet.size} 条超档)`, () => {
  assert(softSet.size > 0, '库里没有超档句子 —— 闸门断言会假通过')
  // 精确比对动作段本身。不能用 includes: 安全句 "in a cat stretch, chest to the floor,
  // hips raised" 里就含着 nsfw 句 "chest to the floor, hips raised"(子串误判)。
  // 也不再用正则从行里抽 —— 21% 的动作句是名词短语开头(不套 "she is"), 直接拿
  // 抽签器同 seed 的期望句比原文最稳。
  const enOf = (t) => t.replace(/^she is /, '')
  const bad = expectPose.filter((t) => softSet.has(enOf(t)))
  assert(bad.length === 0, `${bad.length} 行抽到了超档句子: ${bad[0]}`)
})

console.log('\n=== 路径模式 ===')
const withPath = buildExport({ ...BASE, max_rows: 20, nl_dims: 'pose', nl_seed: 'e2e-path', with_path: '1' })
ok('with_path: 每行仍是 "路径: 正文", 动作句在路径之后', () => {
  const ls = linesOf(withPath)
  const pg = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'e2e-path' })
  const exp = ls.map((_, i) => pg.pick(i).text)
  // 路径本身带盘符冒号, 所以不能只按第一个冒号切 —— 认"图片扩展名 + 冒号 + 空格"
  // (先剥掉自然语言段再测, 否则动作句里的逗号/冒号会干扰)
  const bad = ls.filter((l, i) => !/\.(png|jpe?g|webp|gif|bmp|avif): \S/i.test(stripNl(l))
    || !l.endsWith(exp[i]))
  assert(bad.length === 0, `${bad.length} 行格式不对:\n${bad[0]}`)
})

console.log('\n=== 参数安全 ===')
ok('分页的 limit 不会截断导出(buildQuery 把一页的 limit 铺进了导出参数)', () => {
  /* 2026-11-08 真实踩到的坑: 给导出加条数上限时参数名叫 limit, 而前端 doExport
   * 直接拿 buildQuery() 的结果(带 limit = 一页 60 条)当导出参数 ⇒ 「导出」会
   * 静默变成「只导当前一页」。改成 max_rows 隔离。这条断言防止有人改回去。 */
  const r = buildExport({ q: 'speed_lines', limit: 60 })
  assert(r.count > 60, `limit=60 却只导出 ${r.count} 行 —— 导出被分页参数误伤了`)
})

console.log('\n=== 与随机换词共存 ===')
const both = buildExport({
  ...BASE, max_rows: 20, nl_dims: 'pose', nl_seed: 'e2e-both',
  randomize: '1', randomize_slots: 'hair_color:1,eyes_color:1', randomize_seed: 'x1',
})
ok('同时开随机换词 → 两套都生效, 动作仍不重复', () => {
  assert(both.randomized > 0, `随机换词没生效(replaced=${both.randomized})`)
  const ls = linesOf(both)
  const pg = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'e2e-both' })
  const exp = ls.map((_, i) => pg.pick(i).text)
  const bad = ls.filter((l, i) => !l.endsWith(exp[i]))
  assert(bad.length === 0, `${bad.length} 行动作句丢了或不符`)
  assert(new Set(exp).size === exp.length, '动作重复了')
  console.log(`      换词 ${both.randomized} 个 · 动作 ${new Set(exp).size} 种`)
})

fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\n===== nl-export: ${pass} 通过, ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
