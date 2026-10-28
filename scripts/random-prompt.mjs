// 词条管线第三层 · 随机重组抽签 CLI (v2 · pin + 三层权重 + 查重降权 + 密度二分)
// 用法:
//   node scripts/random-prompt.mjs --n 5                    # 自由抽签 5 组
//   node scripts/random-prompt.mjs --char=hoshino_(blue_archive) --n 3
//   node scripts/random-prompt.mjs --level=2 --n 3          # 放开到 2 级
//   node scripts/random-prompt.mjs --seed=42 --show         # 固定种子复现 + 显示抽取报告
//   node scripts/random-prompt.mjs --pin=standing,kneeling --n 3   # 固定 tag 再随机
//   node scripts/random-prompt.mjs --profile=random-profile-example.json --n 3
//   node scripts/random-prompt.mjs --tags=20 --n 4          # 词条数瞄准 20(±2) 二分收敛
//   node scripts/random-prompt.mjs --reset-counts           # 清零查重记账
//
// 权重语义(对齐 ANIMA): sections/fields/options 三级, 0-3, 默认 1.0, 相乘生效
//   0 = 永不出现; 3 = 必现(短路, 不被密度缩放压掉); 档位判定独立于权重
// 查重: 每词已用次数 → 选词权重 × 1/(1+已用次数); 全同检测最近 20 条
// 密度: --tags=N 时对密度系数做二分(8 轮, 派生种子保逐字节可复现)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFilterGroups } from '../electron/core/tagfilter.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pools = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/slot-pools.json'), 'utf8'))
const profiles = JSON.parse(readFileSync(path.join(ROOT, '.e2e-work/char-profiles.json'), 'utf8'))
const slots = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/tag_slots.json'), 'utf8')).tags
const rules = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/filter-rules.json'), 'utf8'))
// 词频表给 keepOne 挑胜者用(池子里现成)
const counts = {}
for (const p of [pools.pools, pools.nsfwPools]) {
  for (const arr of Object.values(p)) for (const e of arr) counts[e.tag] = e.cnt
}

// ---------- 参数(支持 --k=v 与 --k v 两种形态) ----------
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
const MAX_LEVEL = parseInt(args.level) || 0          // 0=全年龄 1=擦边 2+ 显性
const SEED = args.seed != null ? String(args.seed) : null
const SHOW = args.show === true
const CHAR = typeof args.char === 'string' ? args.char : null
if (CHAR && !profiles[CHAR]) {
  console.error(`角色档案里没有「${CHAR}」(891 个可用, 见 .e2e-work/char-profiles.json)`)
  process.exit(1)
}
const profile = CHAR ? profiles[CHAR] : null

// ---------- 查重记账(默认 .e2e-work/used-counts.json, --counts= 可换) ----------
const COUNTS_FILE = path.resolve(ROOT, typeof args.counts === 'string' ? args.counts : '.e2e-work/used-counts.json')
const NO_COUNTS = args['no-counts'] === true
let ledger = { counts: {}, recent: [] }
if (args['reset-counts'] === true) {
  writeLedger()
  console.log(`查重记账已清零: ${COUNTS_FILE}`)
  process.exit(0)
} else if (!NO_COUNTS && existsSync(COUNTS_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(COUNTS_FILE, 'utf8'))
    if (raw && typeof raw === 'object') ledger = { counts: raw.counts || {}, recent: raw.recent || [] }
  } catch { /* 损坏就当空账, 不阻断 */ }
}
function writeLedger() {
  if (NO_COUNTS) return
  const dir = path.dirname(COUNTS_FILE)
  if (!existsSync(dir)) {
    import('node:fs').then((fs) => fs.mkdirSync(dir, { recursive: true }))
  }
  writeFileSync(COUNTS_FILE, JSON.stringify(ledger, null, 1))
}

// ---------- 权重表(三层) ----------
const W_MIN = 0, W_MAX = 3, W_DEF = 1
const BASE_PROB = args.prob != null ? Math.max(0.05, Math.min(1, parseFloat(args.prob))) : 0.65
let weights = { sections: {}, fields: {}, options: {} }
const weightWarn = []
if (typeof args.profile === 'string') {
  try {
    // 允许 // 行注释(与 local-config 同款宽容度)
    const raw = JSON.parse(readFileSync(path.resolve(ROOT, args.profile), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
    for (const scope of ['sections', 'fields']) {
      if (raw[scope] && typeof raw[scope] === 'object') {
        for (const [k, v] of Object.entries(raw[scope])) {
          const f = parseFloat(v)
          if (Number.isFinite(f)) weights[scope][k] = Math.max(W_MIN, Math.min(W_MAX, f))
          else weightWarn.push(`${scope}.${k} 不是数字, 已忽略`)
        }
      }
    }
    if (raw.options && typeof raw.options === 'object') {
      for (const [slot, sub] of Object.entries(raw.options)) {
        if (!sub || typeof sub !== 'object') continue
        for (const [tag, v] of Object.entries(sub)) {
          const f = parseFloat(v)
          if (Number.isFinite(f)) {
            weights.options[slot] = weights.options[slot] || {}
            weights.options[slot][tag.toLowerCase()] = Math.max(W_MIN, Math.min(W_MAX, f))
          }
        }
      }
    }
  } catch (e) {
    console.error(`权重配置读取失败(${args.profile}): ${e.message}, 按全默认 1.0 继续`)
  }
}
const SEG_NAMES = ['hair', 'face', 'outfit', 'pose', 'camera', 'scene', 'nsfw']
// 引用了不存在的段/槽 → 告警不报错(ANIMA validate_weights 同款)
for (const k of Object.keys(weights.sections)) if (!SEG_NAMES.includes(k)) weightWarn.push(`段「${k}」不存在(可用: ${SEG_NAMES.join('/')})`)
for (const k of Object.keys(weights.fields)) if (!(k in pools.pools) && !(k in pools.nsfwPools)) weightWarn.push(`槽「${k}」不在池子里`)
for (const k of Object.keys(weights.options)) if (!(k in pools.pools) && !(k in pools.nsfwPools)) weightWarn.push(`选项槽「${k}」不在池子里`)

// ---------- pin(lock 语义) ----------
const PIN_TAGS = typeof args.pin === 'string' && args.pin.trim()
  ? args.pin.split(/[,|]/).map((s) => s.trim()).filter(Boolean) : []
for (const t of PIN_TAGS) {
  if (!(t in counts)) {
    console.error(`pin 的「${t}」不在随机池里(未归槽或超档), 无法固定`)
    process.exit(1)
  }
}
const PIN_SLOTS = new Set(PIN_TAGS.map((t) => slots[t]?.slot).filter(Boolean))
// pin 同槽冲突: 一槽只能钉一个(standing+sitting 同属 pose 类) —— 直接报错不静默替换
const slotOf = {}
for (const t of PIN_TAGS) {
  const s = slots[t]?.slot || '(无槽)'
  if (slotOf[s]) {
    console.error(`pin 冲突: 「${slotOf[s]}」与「${t}」同属槽位 ${s}, 一槽只能钉一个`)
    process.exit(1)
  }
  slotOf[s] = t
}
// pin 互斥预检: 只把 pin 们过一遍过滤组, 被裁掉即互斥, 同样报错
if (PIN_TAGS.length > 1) {
  const pre = applyFilterGroups(PIN_TAGS.slice(), { slots, counts, rules, forceSolo: false })
  if (pre.drops.length) {
    console.error('pin 之间存在冲突, 拒绝执行:\n  ' + pre.drops.map((d) => `${d.tag}(${d.rule})`).join(', '))
    process.exit(1)
  }
}

// ---------- 槽位 → 段名与输出排序 ----------
// SEG_NAME: 抽取用的段(权重窗口第一层); SEG_NUM: 输出排序(压轴序)
function SEG_NAME(s) {
  if (s === 'count') return null                       // 基础段不参与权重
  if (['hair_len', 'hair_color', 'hairstyle', 'hair_tie', 'hair_acc', 'eyes_color', 'race',
    'wings', 'tail', 'horn', 'feature', 'figure'].includes(s)) return 'hair'
  if (['emotion', 'mouth', 'eye_gaze'].includes(s)) return 'face'
  if (['outfit', 'top', 'bottom', 'legwear', 'socks', 'footwear', 'handwear', 'underwear',
    'swimwear', 'clothing_type', 'cloth_state_sfw', 'clothing_state', 'cloth_mat',
    'headwear', 'accessory', 'eyewear', 'sleeves'].includes(s)) return 'outfit'
  if (['pose', 'pose_base', 'pose_stance', 'pose_risque'].includes(s)) return 'pose'
  if (['shot_size', 'camera_angle', 'camera_fx', 'viewpoint'].includes(s)) return 'camera'
  if (['location', 'environment', 'weather', 'furniture', 'prop', 'lighting'].includes(s)) return 'scene'
  return 'nsfw'
}
const SEG_NUM = (s) => {
  if (s === 'count') return 0
  const name = SEG_NAME(s)
  return ({ hair: 2, face: 4, outfit: 3, pose: 4.5, camera: 5, scene: 6, nsfw: 7 })[name] ?? 7
}

// ---------- 可复现 RNG + 派生种子 ----------
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
// 派生种子: 多轮重抽(二分/查重)每轮独立播种, seed>=0 时整体逐字节可复现
function deriveSeed(seed, scope, n) {
  return `${seed}::${scope}::${n}`
}

// 加权抽一个: cnt^0.75 压扁头部 × 选项权重 × 查重降权 1/(1+已用次数)
function pick(arr, slot, rng) {
  const opts = weights.options[slot] || {}
  // 选项权重 0 = 该词永不出现, 先剔出候选; 全剔光则 fail-open 保留原池
  const usable = arr.filter((e) => (opts[e.tag.toLowerCase()] ?? W_DEF) > 0)
  const cand = usable.length ? usable : arr
  const W = cand.map((e) => {
    const optW = opts[e.tag.toLowerCase()] ?? W_DEF
    const used = ledger.counts[e.tag] || 0
    return Math.pow(e.cnt, 0.75) * (optW >= W_MAX ? 1 : optW) / (1 + used)
  })
  let sum = W.reduce((a, b) => a + b, 0), r = rng() * sum
  for (let i = 0; i < cand.length; i++) { r -= W[i]; if (r <= 0) return cand[i] }
  return cand[cand.length - 1]
}

// ---------- 抽一手(ratio=密度系数) ----------
function drawOnce(rng, ratio, notes) {
  const drawn = {}                                   // slot -> entry
  const out = ['1girl', 'solo']
  if (CHAR) out.push(CHAR)
  // 锚定特征直接落位
  for (const [s, a] of Object.entries(profile || {})) drawn[s] = { tag: a.tag, anchored: true, cnt: counts[a.tag] || 1 }
  // pin(lock 语义): 值由上游(pin 参数)给定, 该槽跳过随机
  for (const t of PIN_TAGS) {
    const s = slots[t]?.slot
    if (s && !drawn[s]) drawn[s] = { tag: t, pinned: true, cnt: counts[t] || 1 }
  }
  const drawSlot = (s, arr, poolTable) => {
    if (drawn[s] || !arr.length) return
    const seg = SEG_NAME(s)
    const sw = seg ? (weights.sections[seg] ?? W_DEF) : W_DEF
    const fw = weights.fields[s] ?? W_DEF
    if (sw <= 0 || fw <= 0) { notes.push(`${s}: 权重 0 跳过`); return }
    const must = fw >= W_MAX                          // 上限短路 = 必现, 不被密度压掉
    const d = (poolTable.density?.[s] ?? 0) * ratio
    if (!must && rng() > Math.min(1, d * sw * fw)) return
    drawn[s] = pick(arr, s, rng)
  }
  for (const [s, arr] of Object.entries(sfwPools)) drawSlot(s, arr, pools)
  // NSFW 槽位: 仅当 --level 放开时参与(密度用同一张表, 池子按档位过滤)
  if (MAX_LEVEL > 0) {
    for (const [s, arr0] of Object.entries(pools.nsfwPools)) {
      const arr = arr0.filter((e) => e.level != null && e.level <= MAX_LEVEL)
      drawSlot(s, arr, pools)
    }
  }
  // 组装 → 过滤组去冲突(槽内互斥/跨槽矛盾/群像跳过这里不适用, forceSolo)
  let tags = out.concat(Object.values(drawn).map((e) => e.tag))
  const f = applyFilterGroups(tags, { slots, counts, rules, forceSolo: true })
  tags = f.tags
  for (const d of f.drops) notes.push(`[过滤组] 剔除 ${d.tag}(${d.rule})`)
  // 按段排序
  tags.sort((a, b) => {
    const sa = a === CHAR ? 1 : SEG_NUM(slots[a]?.slot), sb = b === CHAR ? 1 : SEG_NUM(slots[b]?.slot)
    return sa - sb
  })
  return { tags, drawn }
}

// 查重重抽: 全同检测最近 20 条, 最多 5 次(派生种子, 可复现)
function drawWithDedup(baseSeed, attemptScope) {
  for (let i = 0; i <= 5; i++) {
    const notes = []
    const { tags, drawn } = drawOnce(mulberry32(deriveSeed(baseSeed, attemptScope, i)), 1, notes)
    if (i < 5 && ledger.recent.includes(tags.join(', '))) {
      notes.push(`与最近输出全同, 重抽(${i + 1}/5)`)
      if (SHOW) for (const n of notes) console.log(`   ${n}`)
      continue
    }
    return { tags, drawn, notes }
  }
}
// 5 次仍全同 → 放行并警告(最后一次的结果已在循环里返回不了, 单独兜底)
function drawOnceFinal(baseSeed, scope) {
  const notes = []
  const { tags, drawn } = drawOnce(mulberry32(deriveSeed(baseSeed, scope, 5)), 1, notes)
  if (ledger.recent.includes(tags.join(', '))) notes.push('⚠️ 重抽 5 次仍与最近输出全同, 放行')
  return { tags, drawn, notes }
}

// ---------- 密度二分(--tags=N 时启用, 8 轮, 瞄准 N±2) ----------
const TAG_TARGET = parseInt(args.tags)
const doBisect = Number.isFinite(TAG_TARGET)
let ratio = 1.0
const bisectNotes = []

// SFW 池按档位过滤: ANIMA 会把 level≥2 的词放在 SFW 槽里(after_sex/panty_pull 等)
const sfwPools = {}
for (const [s, arr] of Object.entries(pools.pools)) {
  sfwPools[s] = arr.filter((e) => e.level == null || e.level <= MAX_LEVEL)
}

for (let i = 0; i < N; i++) {
  const baseSeed = SEED ?? Math.floor(Math.random() * 2 ** 31)
  let result
  if (doBisect) {
    // 每条独立二分: 密度系数夹逼目标词条数(派生种子, seed 固定时逐字节可复现)
    let rLo = 0.05, rHi = 1.8, best = null
    for (let attempt = 0; attempt < 8; attempt++) {
      ratio = attempt === 0 ? 1.0 : Math.round((rLo + rHi) / 2 * 1000) / 1000
      const notes = []
      const { tags } = drawOnce(mulberry32(deriveSeed(baseSeed, 'density', attempt)), ratio, notes)
      const n = tags.length
      const score = Math.abs(n - TAG_TARGET)
      if (!best || score < best.score) best = { score, tags, ratio }
      if (score <= 2) break
      if (n < TAG_TARGET) rLo = ratio; else rHi = ratio
      if (Math.abs(rHi - rLo) < 1e-3) break
    }
    bisectNotes.push(`#${i + 1}: 词条 ${best.tags.length}/${TAG_TARGET} @ 密度 ${best.ratio}`)
    // 用最优 ratio 再走一遍完整链路(查重/报告)
    let r = null
    for (let k = 0; k <= 5; k++) {
      const notes = []
      const got = drawOnce(mulberry32(deriveSeed(baseSeed, 'density', 8 + k)), best.ratio, notes)
      if (k < 5 && ledger.recent.includes(got.tags.join(', '))) { notes.push(`与最近输出全同, 重抽(${k + 1}/5)`); continue }
      r = { ...got, notes }
      break
    }
    if (!r) {
      const notes = []
      const got = drawOnce(mulberry32(deriveSeed(baseSeed, 'density', 13)), best.ratio, notes)
      notes.push('⚠️ 重抽 5 次仍与最近输出全同, 放行')
      r = { ...got, notes }
    }
    result = r
  } else {
    result = drawWithDedup(baseSeed, 'plain') || drawOnceFinal(baseSeed, 'plain')
  }

  const { tags, notes } = result
  console.log((N > 1 ? `${i + 1}. ` : '') + tags.join(', '))
  if (SHOW) {
    for (const n of notes) console.log(`   ${n}`)
    if (PIN_TAGS.length) console.log(`   [pin] ${PIN_TAGS.join(', ')}`)
    if (doBisect) console.log(`   [密度] 目标 ${TAG_TARGET}±2`)
  }
  // 记账: 只记本次真正输出的词
  if (!NO_COUNTS) {
    for (const t of tags) ledger.counts[t] = (ledger.counts[t] || 0) + 1
    ledger.recent.push(tags.join(', '))
    if (ledger.recent.length > 20) ledger.recent = ledger.recent.slice(-20)
  }
}
if (SHOW) {
  for (const w of weightWarn) console.log(`   [权重告警] ${w}`)
  for (const b of bisectNotes) console.log(`   [二分] ${b}`)
}
if (!NO_COUNTS) writeLedger()
