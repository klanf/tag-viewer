// 词条管线第三层 · 导出随机变体 CLI (v1 验证版)
// 定位(2026-10-27 与用户对齐的设计):
//   随机性长在「筛选→导出」主链路上, 当导出的后处理, 不是独立抽签机。
//   输入一段原型词条(或一份筛选导出 txt), 产出 N 组变体:
//   · 角色词/系列词剥离(角色层由购物车那头管)
//   · 本体锁定: 人数/发色/发型/瞳色/种族/体型保留原型
//   · 可变大类(服饰/姿势表情/机位景别/场景光线):
//       原型槽有词 → 90% 保留该槽数量个词(从池子按权抽, 原型词软降权), 10% 槽空
//       原型槽没词 → 按全库密度概率补词(库里 16% 图有手套, 变体就 16% 出手套)
//   · 反比软降权: 词权 = cnt^0.75 / max(集内出现率, 0.02)
//       「又是站立」在图组里占 60% → 变体里被压到约 1/10 权重
//   · 词典没记录的词一律保留原型(不认识的动它才危险)
//   · 组装后过过滤组去冲突(复用 applyFilterGroups)
// 用法:
//   node scripts/variant-prompt.mjs --tags="1girl, white_dress, standing, full_body" --n 3
//   node scripts/variant-prompt.mjs --file=export.txt --n 3 --out=out_random.txt
//   node scripts/variant-prompt.mjs --file=export.txt --n 3 --level=1 --seed=7 --show
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { applyFilterGroups } from '../electron/core/tagfilter.mjs'
import { safetyExportStripper } from '../electron/core/safety.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pools = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/slot-pools.json'), 'utf8'))
const slots = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/tag_slots.json'), 'utf8')).tags
const rules = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/filter-rules.json'), 'utf8'))
const counts = {}
for (const p of [pools.pools, pools.nsfwPools]) {
  for (const arr of Object.values(p)) for (const e of arr) counts[e.tag] = e.cnt
}
// 角色/系列词表(剥离用) —— 只读快
const db = new DatabaseSync(path.join(ROOT, 'data/tags.db'), { readOnly: true })
const personWords = new Set(
  db.prepare("SELECT name FROM tags WHERE kind IN ('char','copyright')").all().map((r) => r.name))

// ---------- 参数(支持 --k=v 与 --k v) ----------
const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i++) {
  const m = argv[i].match(/^--([\w-]+)(?:=(.+))?$/)
  if (!m) continue
  if (m[2] !== undefined) args[m[1]] = m[2]
  else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args[m[1]] = argv[i + 1]; i++ }
  else args[m[1]] = true
}
const N = Math.max(1, parseInt(args.n) || 1)
const MAX_LEVEL = parseInt(args.level) || 0
const SEED = args.seed != null ? String(args.seed) : null
const SHOW = args.show === true
const KEEP_P = args.keep != null ? Math.min(1, Math.max(0, parseFloat(args.keep))) : 0.9
const SAFE = args.safe !== '0'   // 全年龄变体默认开安全剥离(--safe=0 关)
// NSFW 片段启发: 只作用于词典没收录的 unknown 词(有档位的走抽签端门槛)。
// safety 词表是整词/前后缀匹配, Danbooru 复合词(spreading_own_pussy 等)会漏, 这里兜底
const NSFW_PAT = new RegExp('(^|_)(' + [
  'pussy', 'nipples', 'penis', 'cum', 'semen', 'nude', 'naked', 'defloration',
  'areolae', 'censor', 'orgasm', 'anal', 'masturbat', 'erect', 'sex', 'rape',
  'topless', 'bottomless', 'exposed', 'penetrat', 'fellatio', 'cunnilingus', 'ejaculat',
].join('|') + ')')

// 原型: --file 每行一组, 或 --tags 单组
let lines
if (args.file) {
  lines = readFileSync(path.resolve(args.file), 'utf8').split(/\r?\n/)
} else if (typeof args.tags === 'string') {
  lines = [args.tags]
} else {
  console.error('需要 --tags="..." 或 --file=<txt>(每行一组词条)')
  process.exit(1)
}
const protos = lines
  .map((s) => s.trim()).filter(Boolean)
  .map((s) => s.split(',').map((x) => norm(x)).filter(Boolean))
function norm(s) {
  s = s.trim().toLowerCase().replace(/\s+/g, '_')
  s = s.replace(/[:][\d.]+$/, '')                     // 剥尾部权重 :1.2
  // 括号平衡的 tag(如 painting_(object))的括号是名字一部分, 不剥;
  // 只有明显失衡((tag:1.2) 剥完权重剩下的)才补齐尾部
  const open = (s.match(/\(/g) || []).length, close = (s.match(/\)/g) || []).length
  if (open !== close) s = s.replace(/[\])]+$/, '')
  return s.replace(/^[[(]+/, '')
}

// ---------- 集内出现率(反比降权的分母) ----------
const corpusN = protos.length
const corpusFreq = {}
for (const tags of protos) for (const t of new Set(tags)) corpusFreq[t] = (corpusFreq[t] || 0) + 1
for (const k of Object.keys(corpusFreq)) corpusFreq[k] /= corpusN
const freqOf = (t) => corpusFreq[t] || 0

// ---------- 槽位 → 输出段排序(与 random-prompt 同口径) ----------
const SEG = (s) => {
  if (s === 'count') return 0
  if (['hair_len', 'hair_color', 'hairstyle', 'hair_tie', 'hair_acc', 'eyes_color', 'race',
    'wings', 'tail', 'horn', 'feature', 'figure'].includes(s)) return 2
  if (['emotion', 'mouth', 'eye_gaze'].includes(s)) return 4
  if (['outfit', 'top', 'bottom', 'legwear', 'socks', 'footwear', 'handwear', 'underwear',
    'swimwear', 'clothing_type', 'cloth_state_sfw', 'clothing_state', 'cloth_mat',
    'headwear', 'accessory', 'eyewear', 'sleeves'].includes(s)) return 3
  if (['pose', 'pose_base', 'pose_stance', 'pose_risque'].includes(s)) return 4.5
  if (['shot_size', 'camera_angle', 'camera_fx', 'viewpoint'].includes(s)) return 5
  if (['location', 'environment', 'weather', 'furniture', 'prop', 'lighting'].includes(s)) return 6
  return 7
}
// 本体锁定槽(保留原型, 不参与随机)
const LOCK = new Set(['count', 'hair_len', 'hair_color', 'hairstyle', 'hair_tie', 'hair_acc',
  'eyes_color', 'race', 'wings', 'tail', 'horn', 'feature', 'figure', 'skin'])

// 槽位 → 池子索引(变体抽词用); NSFW 槽位名单单独记
const poolBySlot = {}
const nsfwSlots = new Set(Object.keys(pools.nsfwPools))
for (const p of [pools.pools, pools.nsfwPools]) {
  for (const [s, arr] of Object.entries(p)) {
    poolBySlot[s] ||= []
    poolBySlot[s].push(...arr)
  }
}

function mulberry32(seed) {
  let a = 0
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) | 0
  if (!a) a = 0x9e3779b9
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 加权抽 k 个不重复: 权 = cnt^0.75 / 集内出现率^damp —— 反比软降权
// damp 默认 0.5(频率开方): 集内 80% 的词权约压 9 倍、60% 约 6 倍, 够偏冷门又不至于赶尽杀绝;
// --damp=1 回到严格反比(高频词几乎绝迹)
const DAMP = args.damp != null ? parseFloat(args.damp) : 0.5
function pickK(arr, k, rng) {
  const W = arr.map((e) => Math.pow(counts[e.tag] || 1, 0.75) / Math.pow(Math.max(freqOf(e.tag), 0.02), DAMP))
  const out = [], used = new Set()
  for (let n = 0; n < k && used.size < arr.length; n++) {
    let sum = 0
    for (let i = 0; i < arr.length; i++) if (!used.has(i)) sum += W[i]
    let r = rng() * sum
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue
      r -= W[i]
      if (r <= 0) { used.add(i); out.push(arr[i]); break }
    }
  }
  return out
}

// ---------- 变体一组 ----------
const MULTI = new Set(['multiple_girls', 'multiple_boys', '2girls', '3girls', '4girls', '5girls',
  '6+girls', '2boys', '3boys', '4boys', '5boys', '6+boys'])
function variant(proto, rng) {
  const kept = [], notes = []
  // 群像不抽签: 多人各穿各的, 槽位去重/重抽必误杀, 原样保留
  if (proto.some((t) => MULTI.has(t))) return { tags: proto.slice(), dropped: [], notes: [['群像·跳过', '']] }
  const bySlot = {}                                  // slot -> 原型词[]
  for (const t of proto) {
    const rec = slots[t]
    if (personWords.has(t)) { notes.push([t, '角色层剥离']); continue }
    if (!rec || !rec.slot || LOCK.has(rec.slot)) { kept.push(t); if (rec?.slot) notes.push([t, '锁定/未识别·保留']) }
    else (bySlot[rec.slot] ||= []).push(t)
  }
  // 可变槽: 原型有词 → KEEP_P 概率保留等量词(重抽), 否则槽空; 原型没词 → 密度概率补词
  // 整套服装类槽(2026-10-28 A3 修复): 保量重抽会把 bikini+one-piece_swimsuit 这类
  // 同义组合原样复制成冗余 —— 重抽数量一律压 1, 且 outfit/swimwear 两槽合计只留
  // 先抽中的那 1 个(连衣泳衣×分体泳衣这类叠加不是变体想要的表达)。
  const K1 = new Set(['outfit', 'swimwear'])
  let outfitDrawn = false
  const drawn = []
  for (const [s, words] of Object.entries(bySlot)) {
    const isN = nsfwSlots.has(s)
    const pool = (poolBySlot[s] || []).filter((e) =>
      // NSFW 槽: 档位缺失按最严(4)处理, 防止 levels 表没收录的词在 level=0 漏出
      isN ? ((e.level ?? 4) <= MAX_LEVEL)
          : (e.level == null || e.level <= MAX_LEVEL))
    if (words.length) {
      const k = K1.has(s) ? 1 : words.length
      if (rng() < KEEP_P && pool.length && !(K1.has(s) && outfitDrawn)) {
        for (const e of pickK(pool, k, rng)) drawn.push([e.tag, s])
        if (K1.has(s)) outfitDrawn = true
        for (const w of words) notes.push([w, `重抽(${s})`])
      } else {
        for (const w of words) notes.push([w, `${s}·槽空`])
      }
    } else {
      const d = pools.density[s] ?? 0
      if (rng() < d && pool.length && !(K1.has(s) && outfitDrawn)) {
        drawn.push([pickK(pool, 1, rng)[0].tag, s])
        if (K1.has(s)) outfitDrawn = true
      }
    }
  }
  // 未在词典且非角色的 unknown 词已进 kept; 全年龄模式下两道兜底:
  // ① safety 词表剥离(用户词表) ② NSFW 片段启发(词典/词表都没收录的 Danbooru NSFW 词)
  if (SAFE && MAX_LEVEL === 0) {
    const strip = safetyExportStripper('core')
    for (let i = kept.length - 1; i >= 0; i--) {
      const t = kept[i]
      const known = slots[t] && slots[t].level != null   // 词典有档位的交给抽签端门槛, 不在这里双杀
      if (!known && (strip(t) || NSFW_PAT.test(t))) { notes.push([t, '安全剥离']); kept.splice(i, 1) }
    }
  }
  let tags = kept.concat(drawn.map((d) => d[0]))
  const f = applyFilterGroups(tags, { slots, counts, rules, forceSolo: true })
  tags = f.tags
  tags.sort((a, b) => SEG(slots[a]?.slot) - SEG(slots[b]?.slot))
  return { tags, dropped: f.drops, notes }
}

const rng = SEED ? mulberry32(SEED) : mulberry32(Math.floor(Math.random() * 2 ** 31))
const outLines = []
protos.forEach((proto, li) => {
  const protoStr = proto.join(', ')
  outLines.push(protoStr)
  if (protos.length > 1 || SHOW) console.log(`原型#${li + 1}: ${protoStr}`)
  for (let i = 0; i < N; i++) {
    const { tags, dropped, notes } = variant(proto, rng)
    outLines.push(tags.join(', '))
    console.log(`  变体${i + 1}: ${tags.join(', ')}`)
    if (SHOW) {
      if (dropped.length) console.log(`    [过滤组] 剔除: ${dropped.map((d) => d.tag + '(' + d.rule + ')').join(', ')}`)
      const changed = notes.filter(([, why]) => why !== '锁定/未识别·保留')
      if (changed.length) console.log(`    [动过] ${changed.map(([t, w]) => t + '→' + w).join(', ')}`)
    }
  }
})
if (args.out) {
  writeFileSync(path.resolve(args.out), outLines.join('\n') + '\n')
  console.log(`\n已写出 ${outLines.length} 行(含原型) → ${path.resolve(args.out)}`)
}
