/**
 * 自然语言语料库回归(2026-11-08) —— npm run test:nlbank
 * =====================================================
 * 这条测试守的是**效果承诺**, 不是"代码能跑":
 *   ① 语料库真的从两个开源图库生成出来了(姿势/服装/发型三个维度都有量)
 *   ② 档位闸门: nsfw=false 时 soft/nsfw 句子**一条都抽不出来**(构造期收敛)
 *   ③ 发牌式抽样: 抽 N 条(N ≤ 池子大小) **零重复** —— 这就是"动作不再雷同"
 *   ④ 只有超过池子大小才开始重复(且轮转, 不是随机撞)
 *   ⑤ seed 固定时整批可复现
 *   ⑥ 拼出来的句子通顺(带主语/动词, 不是 tag 串)
 *   ⑦ 缺知识包时降级成空库, 不抛(装机版漏打 knowledge/ 那次教训)
 * 负向控制: 把 maxLevel 放开到 nsfw, 断言 soft/nsfw 句**能**被抽到 ——
 * 否则闸门那 4 条断言可能只是因为池子里根本没有那些句子而"假通过"。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const WORK = path.join(ROOT, '.e2e-work', 'nl-bank')

let pass = 0, fail = 0
const ok = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }

async function main() {
  fs.mkdirSync(WORK, { recursive: true })
  const { makeNlPicker, nlBankStats, nlDupReport, splitNlBan, NL_DIMS } = await import('../electron/core/nl-bank.js')

  console.log('\n=== 语料库内容 ===')
  const st = nlBankStats()
  console.log(`  版本 v${st.version} · 生成于 ${st.generatedAt}`)
  for (const d of st.dims) {
    console.log(`  ${d.zh.padEnd(6)} 共 ${String(d.total).padStart(4)} 条  ` +
      `sfw ${String(d.byLevel.sfw || 0).padStart(3)} / soft ${String(d.byLevel.soft || 0).padStart(2)} / nsfw ${String(d.byLevel.nsfw || 0).padStart(2)}`)
  }

  ok('三个维度都有真实数据(不是空壳)', () => {
    assert(!st.empty, '语料库为空 —— 先跑 tools/build-nl-bank.py')
    const byId = Object.fromEntries(st.dims.map((d) => [d.id, d]))
    assert(byId.pose.total >= 280, `姿势只有 ${byId.pose.total} 条, 期望 ≥280`)
    /* 2026-11-11 剥色: 1250 → 931(319 条只是同一版型的换色变体, 合并后不再重复发牌) */
    assert(byId.costume.total >= 900, `服装只有 ${byId.costume.total} 条, 期望 ≥900`)
    assert(byId.hair.total >= 50, `发型只有 ${byId.hair.total} 条, 期望 ≥50`)
    assert(!byId.view, 'view 不该再是独立维度 —— 机位已改成 pose 的属性')
  })

  /* 颜色剥离(2026-11-11 用户要求): 语料只描述版型/材质, 颜色交回 tag 侧。
   * 守两件事: ① 真的剥干净了(英中都没有颜色词); ② 剥色后重复项合并了(不然池里
   * 会有一堆"同一套衣服换个颜色"的重复条目, 发牌抽出来看着一模一样)。 */
  ok('语料不带颜色描述, 且剥色后的重复项已合并', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge', 'nl-bank.json'), 'utf8'))
    const COLOR_EN = ['black', 'white', 'grey', 'gray', 'red', 'blue', 'green', 'yellow', 'orange',
      'purple', 'pink', 'brown', 'beige', 'ivory', 'cream', 'navy', 'khaki', 'olive', 'gold',
      'silver', 'champagne', 'lavender', 'burgundy', 'maroon', 'blonde', 'auburn', 'platinum',
      'mint', 'wine', 'cherry', 'chocolate', 'hazel', 'chestnut']
    const COLOR_ZH = ['象牙白', '奶油色', '薄荷绿', '藏青', '卡其色', '酒红', '橄榄绿', '奶茶色',
      '香槟色', '浅蓝', '深蓝', '浅粉', '浅灰', '深灰', '浅棕', '深棕', '银灰', '粉色', '灰色',
      '黑色', '白色', '棕色', '金色', '银色', '米色', '蓝色', '红色', '绿色', '黄色', '橙色',
      '紫色', '薰衣草', '黑发', '金发', '发色']
    const reEn = new RegExp(`\\b(${COLOR_EN.join('|')})\\b`, 'i')
    const bad = []
    for (const dim of ['costume', 'hair']) {
      for (const it of raw[dim]) {
        if (reEn.test(it.en)) bad.push(`${dim}:${it.en}`)
        else if (COLOR_ZH.some((c) => it.zh.includes(c))) bad.push(`${dim}:${it.zh}`)
      }
    }
    assert(!bad.length, `仍有带颜色的语料 ${bad.length} 条: ${bad.slice(0, 3).join(' | ')}`)
    const cov = raw.meta?.coverage || {}
    assert((cov.costume?.merged || 0) > 200, `服装剥色后应合并掉一大批重复条目, 实际 ${cov.costume?.merged}`)
    assert((cov.hair?.merged || 0) > 0, '发型应有合并(4 条「标准基础款」同句)')
  })

  ok('机位是动作的属性: 5 个角度值, 与动作组成 1400+ 条真实配对', () => {
    const pose = st.dims.find((d) => d.id === 'pose')
    assert(pose.views === 5, `机位角度应为 5 个, 实际 ${pose.views}`)
    assert(pose.combos > 1400, `动作×机位配对只有 ${pose.combos} 条, 期望 >1400(源库 1439 行)`)
    assert(pose.combos <= pose.total * pose.views,
      `配对 ${pose.combos} 超过 动作×5=${pose.total * pose.views}, 说明有机位是重复计入的`)
  })

  ok('姿势按档位分好了(sfw 是绝大多数, nsfw 单独隔开)', () => {
    const pose = st.dims.find((d) => d.id === 'pose')
    assert(pose.byLevel.sfw > 150, `sfw 只有 ${pose.byLevel.sfw} 条`)
    assert(pose.byLevel.nsfw > 30, `nsfw 只有 ${pose.byLevel.nsfw} 条 —— 分档可能失效`)
  })

  console.log('\n=== 档位闸门 ===')
  ok('maxLevel=sfw: 抽 200 条全是 sfw 句', () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'gate' })
    const levels = new Set()
    for (let i = 0; i < 200; i++) for (const part of p.pick(i).parts) levels.add(part.level)
    assert(levels.size === 1 && levels.has('sfw'), `出现了非 sfw 档: ${[...levels].join(',')}`)
  })

  ok('负向控制: maxLevel=nsfw 时确实能抽到 soft/nsfw 句(闸门不是假通过)', () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'nsfw', seed: 'gate2' })
    const levels = new Set()
    for (let i = 0; i < 300; i++) for (const part of p.pick(i).parts) levels.add(part.level)
    assert(levels.has('soft') || levels.has('nsfw'),
      `放开到 nsfw 也只抽到 sfw —— 说明池子里根本没有分档数据: ${[...levels].join(',')}`)
  })

  console.log('\n=== 发牌式抽样(核心) ===')
  // 池子大小从统计里读 —— 不写死数字(语料库增删后测试自己跟着走)
  const POSE_SFW = st.dims.find((d) => d.id === 'pose').byLevel.sfw || 0
  const DEAL_N = Math.min(100, POSE_SFW)
  ok(`抽 ${DEAL_N} 条(≤ sfw 池 ${POSE_SFW}) 动作两两不同 —— 这就是"不再雷同"`, () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'deal' })
    const seen = new Map()
    for (let i = 0; i < DEAL_N; i++) {
      const zh = p.pick(i).parts[0]?.zh
      assert(zh, `第 ${i} 条没抽到动作`)
      seen.set(zh, (seen.get(zh) || 0) + 1)
    }
    const dup = [...seen.entries()].filter(([, c]) => c > 1)
    assert(dup.length === 0, `有 ${dup.length} 个动作重复: ${dup.slice(0, 3).map(([k, c]) => `${k}×${c}`).join(', ')}`)
  })

  ok(`抽满池子(${POSE_SFW}) 仍然零重复`, () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'deal2' })
    const seen = new Set()
    for (let i = 0; i < POSE_SFW; i++) seen.add(p.pick(i).parts[0].zh)
    assert(seen.size === POSE_SFW, `${POSE_SFW} 次只抽到 ${seen.size} 个不同动作`)
  })

  ok(`超过池子才重复, 且是轮转(第 ${POSE_SFW + 1} 条落进第二轮)`, () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'deal3' })
    const first = new Set()
    for (let i = 0; i < POSE_SFW; i++) first.add(p.pick(i).parts[0].zh)
    const extra = p.pick(POSE_SFW).parts[0].zh
    assert(first.has(extra), '第二轮的第一条应该来自第一轮的池子(轮转)')
    const dealt = p.stats().pose.dealt
    assert(dealt === POSE_SFW + 1, `记账不对: ${dealt}`)
  })

  ok('三个维度同时抽: 穿搭/发型也各自不重复', () => {
    const p = makeNlPicker({ dims: ['pose', 'costume', 'hair'], maxLevel: 'sfw', seed: 'multi' })
    const sets = { pose: new Set(), costume: new Set(), hair: new Set() }
    for (let i = 0; i < 40; i++) {
      for (const part of p.pick(i).parts) sets[part.dim].add(part.zh)
    }
    for (const [dim, s] of Object.entries(sets)) {
      assert(s.size === 40, `${dim} 抽 40 条只有 ${s.size} 个不同值`)
    }
  })

  /* 机位是 2026-11-08 用户要求接的: 源库 1439 行 = 288 动作 × 5 机位, 机位是别人
   * 配好的成套组合, 所以能抽(而 tag 侧随机拼视角词会自相矛盾)。池子只有 5 条,
   * 必须靠"与动作正交"才不亏 —— 前 N 条动作不重复时, (动作, 机位) 组合也唯一。 */
  ok('动作自带机位: 50 条互不相同, 机位句合在同一句里', () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'pair' })
    const combos = new Set()
    const views = new Set()
    for (let i = 0; i < 50; i++) {
      const parts = p.pick(i).parts
      const pose = parts.find((x) => x.dim === 'pose')
      assert(pose, `第 ${i} 条没抽到动作: ${JSON.stringify(parts.map((x) => x.dim))}`)
      assert(pose.view, `第 ${i} 条没带机位 —— poseView 默认应为开`)
      combos.add(`${pose.zh}|${pose.view.zh}`)
      views.add(pose.view.zh)
    }
    assert(views.size === 5, `50 条只抽到 ${views.size} 个机位, 期望 5`)
    assert(combos.size === 50, `50 条里组合重复了 ${50 - combos.size} 条`)
  })

  ok('同一动作第二次被抽到时换机位(第二层发牌, 不是重掷骰子)', () => {
    // 池 177 条, 抽 354 条 ⇒ 每个动作出现 2 次; 同轮队列内机位必须不同
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'pair2' })
    const seen = new Map()
    for (let i = 0; i < 354; i++) {
      const pose = p.pick(i).parts.find((x) => x.dim === 'pose')
      if (!pose) continue
      const arr = seen.get(pose.zh) || []
      arr.push(pose.view?.zh)
      seen.set(pose.zh, arr)
    }
    let checked = 0
    for (const [zh, arr] of seen) {
      assert(arr.length <= 2, `${zh} 抽了 ${arr.length} 次, 发牌队列没轮转干净`)
      if (arr.length === 2) {
        assert(arr[0] && arr[1], `${zh} 有机位缺失`)
        assert(arr[0] !== arr[1], `${zh} 两次都发了同一个机位「${arr[0]}」`)
        checked++
      }
    }
    assert(checked > 100, `只验证到 ${checked} 个重复动作, 样本不对`)
  })

  ok('不发明源库没有的组合: 缺仰视的动作永远不会抽到仰视', () => {
    /* 源库 1439 行 = 288 动作 × 5 机位, 但「M字开腿（坐位・双手后撑）」只有 4 个机位(缺仰视)。
     * 如果把机位当成全局 5 条独立维度, 这个动作就会配上一个源库根本没拍过的仰视——
     * 这正是"成套抽取"和"正交相乘"的实际差别, 用断言钉住。 */
    // 注意: 名字相近的「M字开腿（坐位・双手扶膝）」是**另一个动作**, 它有 5 个机位,
    // 用 includes 匹配会把它混进来 —— 必须精确到括号里的那一个。
    const TARGET = 'M字开腿（坐位・双手后撑）'
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'missing-view' })
    const got = new Set()
    for (let i = 0; i < 800; i++) {
      const pose = p.pick(i).parts.find((x) => x.dim === 'pose')
      if (pose && pose.zh === TARGET) got.add(pose.view?.zh)
    }
    assert(got.size > 0, `800 条里一次都没抽到「${TARGET}」, 样本无效`)
    assert(got.size <= 4, `「${TARGET}」抽到 ${got.size} 个机位, 源库只有 4 个: ${[...got].join('/')}`)
    assert(!got.has('仰视'), `「${TARGET}」抽到了源库没有的仰视机位`)
    console.log(`      「${TARGET}」抽到的机位: ${[...got].join(' / ')}`)
  })

  ok('关掉 poseView: 只出动作句, 不带机位半句', () => {
    const t = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'nv', poseView: false }).pick(0).text
    assert(!/seen from /.test(t), `关掉机位还出了机位句: ${t}`)
  })

  console.log('\n=== 可复现 ===')
  ok('seed 固定: 两次跑出来的整批完全一致', () => {
    const a = makeNlPicker({ dims: ['pose', 'costume'], maxLevel: 'sfw', seed: 'repro' })
    const b = makeNlPicker({ dims: ['pose', 'costume'], maxLevel: 'sfw', seed: 'repro' })
    const la = [], lb = []
    for (let i = 0; i < 30; i++) { la.push(a.pick(i).text); lb.push(b.pick(i).text) }
    assert(la.join('|') === lb.join('|'), '同 seed 两次结果不一致')
  })

  ok('seed 不同: 整批顺序不同(但不是"全空")', () => {
    const a = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 's1' })
    const b = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 's2' })
    const la = [], lb = []
    for (let i = 0; i < 20; i++) { la.push(a.pick(i).text); lb.push(b.pick(i).text) }
    assert(la.join('|') !== lb.join('|'), '不同 seed 得到同一批 —— 种子没生效')
  })

  console.log('\n=== 句子质量 ===')
  ok('动作句带主语和动词(不是 tag 串)', () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'q' })
    const t = p.pick(0).text
    assert(/^she is /.test(t), `动作句应以 "she is " 开头: ${t}`)
    assert(t.split(' ').length >= 5, `句子太短: ${t}`)
    assert(!t.includes('_'), `句子里有下划线(说明混进了 tag): ${t}`)
  })

  ok('三档全开时是一句话(逗号连接, 三个分句)', () => {
    const p = makeNlPicker({ dims: ['pose', 'costume', 'hair'], maxLevel: 'sfw', seed: 'q2' })
    const t = p.pick(0).text
    assert(/she is /.test(t) && /she is wearing /.test(t) && /her hair is /.test(t),
      `三个分句不全: ${t}`)
    assert(t.split(', ').length >= 3, `分句数不对: ${t}`)
  })

  console.log('\n=== 批内体检 ===')
  ok('发牌抽 50 条 → 重复率 0', () => {
    const p = makeNlPicker({ dims: ['pose'], maxLevel: 'sfw', seed: 'dup' })
    const rows = []
    for (let i = 0; i < 50; i++) rows.push({ nlParts: p.pick(i).parts })
    const rep = nlDupReport(rows)
    assert(rep.n === 50, `统计条数 ${rep.n}`)
    assert(rep.dup === 0 && rep.rate === 0, `重复率应为 0, 实际 ${rep.rate}`)
  })

  ok('人为造重复 → 体检能抓到(负向控制)', () => {
    const fake = Array.from({ length: 10 }, () => ({ nlParts: [{ dim: 'pose', zh: '同一个动作' }] }))
    const rep = nlDupReport(fake)
    assert(rep.dup === 9, `应报 9 条多余重复, 实际 ${rep.dup}`)
    assert(rep.worst[0]?.cnt === 10, `最重复签名应为 10 次, 实际 ${rep.worst[0]?.cnt}`)
  })

  console.log('\n=== 降级 ===')
  const probe = path.join(WORK, 'probe-missing.mjs')
  const emptyDir = path.join(WORK, 'empty-knowledge')
  rmrf(emptyDir); fs.mkdirSync(emptyDir, { recursive: true })
  fs.writeFileSync(probe, `
import { makeNlPicker, nlBankStats } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'electron/core/nl-bank.js')).href)}
const st = nlBankStats()
const p = makeNlPicker({ dims: ['pose', 'costume', 'hair'], maxLevel: 'nsfw', seed: 'x' })
let threw = null
let text = ''
try { text = p.pick(0).text } catch (e) { threw = e.message }
console.log(JSON.stringify({ empty: st.empty, totals: st.totals, threw, text }))
`, 'utf8')
  const r = spawnSync(process.execPath, [probe], {
    cwd: ROOT,
    env: { ...process.env, TV_KNOWLEDGE_DIR: emptyDir },
    encoding: 'utf8',
  })
  ok('缺 nl-bank.json 时降级成空库, 不抛异常', () => {
    const m = /(\{.*\})/.exec(r.stdout || '')
    assert(m, `探针没输出 JSON:\n${r.stdout}\n${r.stderr}`)
    const j = JSON.parse(m[1])
    assert(j.empty === true, '空库时 empty 应为 true')
    assert(j.threw === null, `不该抛: ${j.threw}`)
    assert(j.text === '', `空库时应返回空串, 实际 ${JSON.stringify(j.text)}`)
  })

  /* nl 词索引(2026-11-10 二版): nlTagIndex 把句子拆成 tag 形态片段 ——
   * translate.js 拿它补中文, tagcats 拿它归 动作/服装/发型/机位(整句回译已退役) */
  const { nlTagIndex } = await import('../electron/core/nl-bank.js')
  ok('nl索引: 英文导出产物的片段都以 tag 形态入索引(动作/穿搭/发型/机位)', () => {
    const idx = nlTagIndex()
    const hit = (k, dim) => idx.get(k)?.dim === dim
    assert(hit('she_is_standing_in_a_soft_s-curve', 'pose'), '动作句首段应入索引')
    assert(hit('hips_pushed_out_to_one_side', 'pose'), '动作句第二段(逗号拆开)也应入索引')
    /* 剥色后是 "a frilled knit top"(ivory 已按用户要求从语料里清掉) */
    assert(hit('she_is_wearing_a_frilled_knit_top', 'costume'), '穿搭句应入索引')
    assert(hit('a_denim_mini_skirt', 'costume'), '穿搭枚举段也应入索引')
    assert(hit('her_hair_is_a_clean_basic_cut', 'hair'), '发型句应入索引')
    assert(hit('seen_from_above', 'view'), '机位段应入索引(dim=view)')
  })
  ok('nl索引: 中文导出产物同样入索引(en/zh 双向)', () => {
    const idx = nlTagIndex()
    assert([...idx.entries()].some(([k, v]) => v.dim === 'pose' && k.includes('形站姿')), '中文动作片段应入索引')
    assert(idx.get('俯视视角')?.dim === 'view', '中文机位应入索引')
    assert([...idx.values()].some((v) => v.dim === 'costume' && v.zh.includes('针织衫')), '中文穿搭应入索引')
  })
  ok('nl索引: 键与 promptToTags 的归一一致(小写+空格转下划线+剥首尾_)', () => {
    const idx = nlTagIndex()
    const key = '  She Is Standing In A Soft S-Curve  '.toLowerCase().replace(/\s+/g, '_').replace(/^_+|_+$/g, '')
    assert(idx.get(key)?.dim === 'pose', '大小写/空白打乱后的 tag 键应命中')
  })
  ok('nl索引: 每条都带中文 zh(翻译补丁的数据源)', () => {
    const idx = nlTagIndex()
    let n = 0
    for (const v of idx.values()) if (v.zh) n++
    assert(n === idx.size, `每条都该带 zh, 实际 ${n}/${idx.size}`)
    assert(idx.size > 1000, `索引规模该上千(286 动作×片段+1250 穿搭+54 发型+机位), 实际 ${idx.size}`)
  })
  /* 2026-11-10 实锤 bug: 中文语料用「・」分隔, 老代码按「，」拆 → 拆不出段 →
     **每个英文片段都被塞了整句中文**, 再叠加"首胜占位", a_headband 显示成
     "黑色丝绒吊带衫・红色长裤・毛绒靴子・包・发箍"(别人家整套穿搭)。
     修法: 段数一致逐段对齐; 对不齐才用本条整句当注脚。 */
  ok('nl索引: 片段级中文逐段对齐(不再把整句糊给每个片段)', () => {
    const idx = nlTagIndex()
    assert(idx.get('a_corseted_bralette')?.zh === '束腰胸衣',
      `a_corseted_bralette 应为"束腰胸衣", 实际 ${idx.get('a_corseted_bralette')?.zh}`)
    assert(idx.get('lace_frilled_ankle_socks')?.zh === '蕾丝荷叶边短袜',
      `lace_frilled_ankle_socks 应为"蕾丝荷叶边短袜", 实际 ${idx.get('lace_frilled_ankle_socks')?.zh}`)
    assert(idx.get('a_headband')?.zh === '发箍',
      `a_headband 应为"发箍"(曾被别条穿搭整句顶掉), 实际 ${idx.get('a_headband')?.zh}`)
    // 整句注脚只该出现在"中英段数对不上"的少数条目上, 占比过高说明对齐又坏了
    const dotted = [...idx.values()].filter((v) => (v.zh || '').includes('・')).length
    assert(dotted < idx.size * 0.15, `整句注脚不该泛滥(实测约 6%), 实际 ${dotted}/${idx.size}`)
  })
  ok('nl索引: 普通 danbooru tag 不在索引里(不会误翻)', () => {
    const idx = nlTagIndex()
    assert(!idx.has('1girl') && !idx.has('solo') && !idx.has('long_hair'), '普通 tag 不该混进 nl 索引')
  })

  /* 语料黑名单(2026-11-11 用户要求): "ban 掉有针织衫的句子" ——
   * 命中 en/zh/kw/cat 任一字段就整条剔除, 且剔除发生在**池子构建期**
   * (发牌队列里根本没有), 所以界面报的"可抽 N"和实际抽出的都对得上。 */
  ok('nl黑名单: 中文关键词整条剔除(针织衫)', () => {
    const all = nlBankStats({}).dims.find((d) => d.id === 'costume')
    const cut = nlBankStats({ banned: '针织衫' }).dims.find((d) => d.id === 'costume')
    assert(cut.banned > 0, `「针织衫」应命中一批穿搭, 实际 ${cut.banned}`)
    assert(cut.bannedByLevel.sfw === cut.banned, '该命中的都是 sfw 档(实测如此), 分桶要对')
    // 抽 60 条, 一条都不该再出现 knit
    const p = makeNlPicker({ dims: ['costume'], banned: ['针织'] })
    for (let i = 0; i < 60; i++) {
      const t = p.pick(i).text
      assert(!/knit/i.test(t), `被 ban 的穿搭漏进结果: ${t}`)
    }
    // 负向控制: 不 ban 时能抽到 —— 否则上一条断言只是"池子里本来没有"
    const p0 = makeNlPicker({ dims: ['costume'] })
    let hits = 0
    for (let i = 0; i < 60; i++) if (/knit/i.test(p0.pick(i).text)) hits++
    assert(hits > 0, '不 ban 时本该抽到 knit 穿搭(负向控制失败, 上面那条是假通过)')
    assert(cut.total === all.total, '黑名单只该影响命中数, 不该改 total')
  })
  ok('nl黑名单: 英文关键词 + 分隔符容错', () => {
    const en = nlBankStats({ banned: 'knit' }).dims.find((d) => d.id === 'costume')
    assert(en.banned > 0, `「knit」应命中, 实际 ${en.banned}`)
    // 中文逗号/分号/多余空格都要能拆
    assert(splitNlBan('针织衫，knit; sweater ').length === 3, '中文逗号/分号分隔要能拆')
    assert(splitNlBan('').length === 0 && splitNlBan(undefined).length === 0, '空输入应得空数组')
    // 没命中的关键词不能误伤
    assert(nlBankStats({ banned: 'zzz-not-exist' }).dims.every((d) => d.banned === 0), '无关词不该剔任何条')
  })

  rmrf(WORK)
  console.log(`\n===== nl-bank: ${pass} 通过, ${fail} 失败 =====`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了:', e)
  process.exit(1)
})
