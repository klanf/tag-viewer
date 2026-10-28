// 词条管线第三层 · 随机重组抽签 CLI (v1 验证版)
// 用法:
//   node scripts/random-prompt.mjs --n 5                    # 自由抽签 5 组
//   node scripts/random-prompt.mjs --char=hoshino_(blue_archive) --n 3
//   node scripts/random-prompt.mjs --level=2 --n 3          # 放开到 2 级
//   node scripts/random-prompt.mjs --seed=42 --show         # 固定种子复现 + 显示槽位拆解
import { readFileSync } from 'node:fs'
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

// ---------- 槽位 → 输出段排序(ANIMA 式) ----------
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
  return 7   // NSFW 段压轴
}

// ---------- 可复现 RNG ----------
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

// 加权抽一个: cnt^0.75 压扁头部(纯自然分布会让黑白发刷屏)
function pick(arr, rng) {
  const W = arr.map((e) => Math.pow(e.cnt, 0.75))
  let sum = W.reduce((a, b) => a + b, 0), r = rng() * sum
  for (let i = 0; i < arr.length; i++) { r -= W[i]; if (r <= 0) return arr[i] }
  return arr[arr.length - 1]
}

// ---------- 抽一手 ----------
function draw(rng) {
  const drawn = {}                                   // slot -> entry
  const out = ['1girl', 'solo']
  if (CHAR) out.push(CHAR)
  // 锚定特征直接落位
  for (const [s, a] of Object.entries(profile || {})) drawn[s] = { tag: a.tag, anchored: true, cnt: counts[a.tag] || 1 }
  // 各槽位按密度决定是否出词, 再加权抽一个
  for (const [s, arr] of Object.entries(sfwPools)) {
    if (drawn[s]) continue
    const d = pools.density[s] ?? 0
    if (rng() > d || !arr.length) continue
    drawn[s] = pick(arr, rng)
  }
  // NSFW 槽位: 仅当 --level 放开时参与(密度用同一张表, 池子按档位过滤)
  if (MAX_LEVEL > 0) {
    for (const [s, arr0] of Object.entries(pools.nsfwPools)) {
      const arr = arr0.filter((e) => e.level != null && e.level <= MAX_LEVEL)
      if (drawn[s] || !arr.length) continue
      if (rng() > (pools.density[s] ?? 0)) continue
      drawn[s] = pick(arr, rng)
    }
  }
  // 组装 → 过滤组去冲突(槽内互斥/跨槽矛盾/群像跳过这里不适用, forceSolo)
  let tags = out.concat(Object.values(drawn).map((e) => e.tag))
  const f = applyFilterGroups(tags, { slots, counts, rules, forceSolo: true })
  tags = f.tags
  // 按段排序
  tags.sort((a, b) => {
    const sa = a === CHAR ? 1 : SEG(slots[a]?.slot), sb = b === CHAR ? 1 : SEG(slots[b]?.slot)
    return sa - sb
  })
  return { tags, dropped: f.drops, drawn }
}

const rng = SEED ? mulberry32(SEED) : mulberry32(Math.floor(Math.random() * 2 ** 31))
// SFW 池同样按档位过滤: ANIMA 会把 level≥2 的词放在 SFW 槽里(after_sex/panty_pull 等)
const sfwPools = {}
for (const [s, arr] of Object.entries(pools.pools)) {
  sfwPools[s] = arr.filter((e) => e.level == null || e.level <= MAX_LEVEL)
}
for (let i = 0; i < N; i++) {
  const { tags, dropped } = draw(rng)
  console.log((N > 1 ? `${i + 1}. ` : '') + tags.join(', '))
  if (SHOW && dropped.length) console.log(`   [过滤组] 剔除: ${dropped.map((d) => d.tag + '(' + d.rule + ')').join(', ')}`)
}
