/**
 * 随机提示词抽签 —— 核心引擎(CLI 与看板 UI 共用)
 * ============================================================
 * 从 scripts/random-prompt.mjs 提出来的纯逻辑层, 语义与 ANIMA 对齐:
 *
 *   · pin(lock 语义): 固定 tag 直接落位, 该槽跳过随机; 同槽/互斥报错
 *   · 三层权重 sections/fields/options: 0-3, 默认 1.0, 相乘生效
 *       0 = 永不; 3 = 必现(短路, 不被密度压掉); 档位判定独立于权重
 *   · 查重: used-counts 记账, 选词权重 × 1/(1+已用次数);
 *       全同检测最近 20 条, 重抽 ≤5 次(派生种子, seed 固定逐字节可复现)
 *   · 密度二分: tagsTarget 给定时对密度系数二分 8 轮, 瞄准 N±2
 *
 * 知识文件(knowledge/slot-pools.json 等)懒加载并缓存; 打包态在 asar 里
 * 也能 readFileSync。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFilterGroups } from './tagfilter.mjs'
import { dataFile } from './workspace.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let _pools = null, _slots = null, _rules = null, _countsIdx = null
function pools() {
  if (!_pools) _pools = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/slot-pools.json'), 'utf8'))
  return _pools
}
function slots() {
  if (!_slots) _slots = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/tag_slots.json'), 'utf8')).tags
  return _slots
}
function rules() {
  if (!_rules) _rules = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/filter-rules.json'), 'utf8'))
  return _rules
}
/** tag -> cnt 词频索引(keepOne 挑胜者 + pin 存在性校验用) */
function countsIdx() {
  if (!_countsIdx) {
    const m = {}
    const p = pools()
    for (const tbl of [p.pools, p.nsfwPools]) {
      for (const arr of Object.values(tbl)) for (const e of arr) m[e.tag] = e.cnt
    }
    _countsIdx = m
  }
  return _countsIdx
}

// ---------- 查重记账(dataDir/random-used-counts.json) ----------
const RECENT_MAX = 20
function ledgerFile() { return dataFile('random-used-counts.json') }
let _ledger = null
function ledger() {
  if (!_ledger) {
    _ledger = { counts: {}, recent: [] }
    try {
      const raw = JSON.parse(readFileSync(ledgerFile(), 'utf8'))
      if (raw && typeof raw === 'object') _ledger = { counts: raw.counts || {}, recent: raw.recent || [] }
    } catch { /* 没有就空账 */ }
  }
  return _ledger
}
function saveLedger() {
  try {
    const f = ledgerFile()
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(ledger(), null, 1))
  } catch { /* 记账失败不拖垮抽签 */ }
}
export function randomLedger() {
  const l = ledger()
  return { counts: { ...l.counts }, recent: [...l.recent], total: Object.keys(l.counts).length }
}
export function randomResetCounts() {
  _ledger = { counts: {}, recent: [] }
  saveLedger()
  return randomLedger()
}

// ---------- 权重表(三层) ----------
export const W_MIN = 0, W_MAX = 3, W_DEF = 1
export const SEG_NAMES = ['hair', 'face', 'outfit', 'pose', 'camera', 'scene', 'nsfw']
export const BASE_PROB_DEF = 0.65

/** 归一三层权重表: 认不出的键丢弃并告警(ANIMA validate_weights 同款, 告警不报错) */
export function normalizeWeights(raw = {}) {
  const p = pools()
  const warns = []
  const w = { sections: {}, fields: {}, options: {} }
  const num = (v) => {
    const f = parseFloat(v)
    return Number.isFinite(f) ? Math.max(W_MIN, Math.min(W_MAX, f)) : null
  }
  for (const k of Object.keys(raw.sections || {})) {
    const f = num(raw.sections[k])
    if (f == null) { warns.push(`sections.${k} 不是数字, 已忽略`); continue }
    if (!SEG_NAMES.includes(k)) { warns.push(`段「${k}」不存在(可用: ${SEG_NAMES.join('/')})`); continue }
    w.sections[k] = f
  }
  for (const k of Object.keys(raw.fields || {})) {
    const f = num(raw.fields[k])
    if (f == null) { warns.push(`fields.${k} 不是数字, 已忽略`); continue }
    if (!(k in p.pools) && !(k in p.nsfwPools)) { warns.push(`槽「${k}」不在池子里`); continue }
    w.fields[k] = f
  }
  for (const [slot, sub] of Object.entries(raw.options || {})) {
    if (!sub || typeof sub !== 'object') continue
    if (!(slot in p.pools) && !(slot in p.nsfwPools)) { warns.push(`选项槽「${slot}」不在池子里`); continue }
    for (const [tag, v] of Object.entries(sub)) {
      const f = num(v)
      if (f == null) { warns.push(`options.${slot}.${tag} 不是数字, 已忽略`); continue }
      w.options[slot] = w.options[slot] || {}
      w.options[slot][tag.toLowerCase()] = f
    }
  }
  return { weights: w, warns }
}

// ---------- 槽位 → 段(权重窗口第一层)与输出排序 ----------
export function segName(s) {
  if (!s || s === 'count') return null            // 基础段不参与权重
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
  const name = segName(s)
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
function deriveSeed(seed, scope, n) { return `${seed}::${scope}::${n}` }

// ---------- pin 预检 ----------
/** 返回错误文案数组(空 = 通过)。同槽双钉 / 互斥都是硬错误。 */
export function pinConflicts(pins) {
  const errs = []
  const cs = countsIdx(), sl = slots()
  for (const t of pins) {
    if (!(t in cs)) errs.push(`pin 的「${t}」不在随机池里(未归槽或超档), 无法固定`)
  }
  const slotOf = {}
  for (const t of pins) {
    const s = sl[t]?.slot || '(无槽)'
    if (slotOf[s]) errs.push(`pin 冲突: 「${slotOf[s]}」与「${t}」同属槽位 ${s}, 一槽只能钉一个`)
    else slotOf[s] = t
  }
  if (pins.length > 1 && !errs.length) {
    const pre = applyFilterGroups(pins.slice(), { slots: sl, counts: cs, rules: rules(), forceSolo: false })
    if (pre.drops.length) errs.push('pin 之间存在冲突: ' + pre.drops.map((d) => `${d.tag}(${d.rule})`).join(', '))
  }
  return errs
}

// ---------- 加权抽一个 ----------
function pick(arr, slot, rng, led, weights) {
  const opts = weights.options?.[slot] || {}
  // options 0 = 该词永不出现; 全剔光则 fail-open 保留原池
  const usable = arr.filter((e) => (opts[e.tag.toLowerCase()] ?? W_DEF) > 0)
  const cand = usable.length ? usable : arr
  const W = cand.map((e) => {
    const optW = opts[e.tag.toLowerCase()] ?? W_DEF
    const used = led.counts[e.tag] || 0
    return Math.pow(e.cnt, 0.75) * (optW >= W_MAX ? 1 : optW) / (1 + used)
  })
  let sum = W.reduce((a, b) => a + b, 0), r = rng() * sum
  for (let i = 0; i < cand.length; i++) { r -= W[i]; if (r <= 0) return cand[i] }
  return cand[cand.length - 1]
}

// ---------- 抽一手 ----------
function drawOnce(rng, ratio, ctx, notes) {
  const { weights, level, pins, char } = ctx
  const p = pools()
  const drawn = {}
  const out = ['1girl', 'solo']
  if (char) out.push(char)
  for (const t of pins) {
    const s = slots()[t]?.slot
    if (s && !drawn[s]) drawn[s] = { tag: t, pinned: true, cnt: countsIdx()[t] || 1 }
  }
  const drawSlot = (s, arr) => {
    if (drawn[s] || !arr.length) return
    const seg = segName(s)
    const sw = seg ? (weights.sections[seg] ?? W_DEF) : W_DEF
    const fw = weights.fields[s] ?? W_DEF
    if (sw <= 0 || fw <= 0) { notes.push(`${s}: 权重 0 跳过`); return }
    const must = fw >= W_MAX
    const d = (p.density?.[s] ?? 0) * ratio
    if (!must && rng() > Math.min(1, d * sw * fw)) return
    drawn[s] = pick(arr, s, rng, ledger(), weights)
  }
  for (const [s, arr] of Object.entries(p.pools)) {
    drawSlot(s, arr.filter((e) => e.level == null || e.level <= level))
  }
  if (level > 0) {
    for (const [s, arr0] of Object.entries(p.nsfwPools)) {
      drawSlot(s, arr0.filter((e) => e.level != null && e.level <= level))
    }
  }
  let tags = out.concat(Object.values(drawn).map((e) => e.tag))
  const f = applyFilterGroups(tags, { slots: slots(), counts: countsIdx(), rules: rules(), forceSolo: true })
  tags = f.tags
  for (const d of f.drops) notes.push(`[过滤组] 剔除 ${d.tag}(${d.rule})`)
  tags.sort((a, b) => {
    const sa = a === char ? 1 : SEG_NUM(slots()[a]?.slot), sb = b === char ? 1 : SEG_NUM(slots()[b]?.slot)
    return sa - sb
  })
  return { tags, drawn }
}

const DEDUP_RETRY = 5
function drawWithDedup(ctx, baseSeed, scope, ratio, notes0, batchSeen) {
  for (let i = 0; i <= DEDUP_RETRY; i++) {
    const notes = [...notes0]
    const got = drawOnce(mulberry32(deriveSeed(baseSeed, scope, i)), ratio, ctx, notes)
    const key = got.tags.join(', ')
    const dup = ledger().recent.includes(key) || (batchSeen && batchSeen.includes(key))
    if (i < DEDUP_RETRY && dup) {
      notes.push(`与最近输出全同, 重抽(${i + 1}/5)`)
      continue
    }
    if (i === DEDUP_RETRY && dup) {
      got.notes = notes.concat('⚠️ 重抽 5 次仍与最近输出全同, 放行')
      return got
    }
    got.notes = notes
    return got
  }
}

// ---------- 对外主入口 ----------
/**
 * @param {object} opts
 *   n=1 条数; level=0 档位; seed=null 种子; pins=[] 固定 tag;
 *   profile={} 三层权重(原始对象, 内部归一); tagsTarget=null 词条数瞄准;
 *   char=null 角色锚定 tag; save=true 记账; baseProb=0.65(预留)
 * @returns {{ results:[{tags,notes,pinned}], warns:[], ledger }}
 */
export function randomDraw(opts = {}) {
  const n = Math.max(1, Math.min(200, parseInt(opts.n) || 1))
  const level = Math.max(0, parseInt(opts.level) || 0)
  const pins = Array.isArray(opts.pins) ? opts.pins.map((s) => String(s).trim()).filter(Boolean) : []
  const char = opts.char ? String(opts.char) : null
  const save = opts.save !== false
  const tagTarget = Number.isFinite(parseInt(opts.tagsTarget)) ? parseInt(opts.tagsTarget) : null
  const { weights, warns } = normalizeWeights(opts.profile || {})
  if (!save) { /* 只抽不记: 用一次性空账 */ _ledger = { counts: {}, recent: [] } }

  const pinErrs = pinConflicts(pins)
  if (pinErrs.length) {
    if (!save) _ledger = null
    return { error: pinErrs.join('\n'), results: [], warns }
  }

  const ctx = { weights, level, pins, char }
  const batchSeen = []                    // 本批已出的 prompt(save=false 时也参与去重)
  const results = []
  for (let i = 0; i < n; i++) {
    // 每条混入序号: 固定 seed 时 n>1 也能各不相同(仍是可复现的派生)
    const baseSeed = opts.seed != null ? `${opts.seed}#${i}` : Math.floor(Math.random() * 2 ** 31)
    let got
    if (tagTarget != null) {
      // 密度二分 8 轮(派生种子), 瞄准 N±2, 再走查重
      let rLo = 0.05, rHi = 1.8, best = null
      for (let attempt = 0; attempt < 8; attempt++) {
        const ratio = attempt === 0 ? 1.0 : Math.round((rLo + rHi) / 2 * 1000) / 1000
        const notes = []
        const { tags } = drawOnce(mulberry32(deriveSeed(baseSeed, 'density', attempt)), ratio, ctx, notes)
        const score = Math.abs(tags.length - tagTarget)
        if (!best || score < best.score) best = { score, ratio }
        if (score <= 2) break
        if (tags.length < tagTarget) rLo = ratio; else rHi = ratio
        if (Math.abs(rHi - rLo) < 1e-3) break
      }
      got = drawWithDedup(ctx, baseSeed, 'density', best.ratio, [`[密度] 目标 ${tagTarget}±2 @ ${best.ratio}`], batchSeen)
    } else {
      got = drawWithDedup(ctx, baseSeed, 'plain', 1.0, [], batchSeen)
    }
    results.push({ tags: got.tags, notes: got.notes || [], pinned: pins })
    batchSeen.push(got.tags.join(', '))
    if (save) {
      for (const t of got.tags) ledger().counts[t] = (ledger().counts[t] || 0) + 1
      ledger().recent.push(got.tags.join(', '))
      if (ledger().recent.length > RECENT_MAX) ledger().recent = ledger().recent.slice(-RECENT_MAX)
    }
  }
  if (save) saveLedger()
  else _ledger = null
  return { results, warns, ledger: randomLedger() }
}

/** UI 元数据: 段列表 + 每段槽位与池子大小(权重面板用) */
export function randomMeta() {
  const p = pools()
  const slotsBySection = {}
  for (const s of Object.keys(p.pools)) {
    const seg = segName(s) || 'base'
    (slotsBySection[seg] = slotsBySection[seg] || []).push({ slot: s, n: p.pools[s].length })
  }
  for (const s of Object.keys(p.nsfwPools || {})) {
    (slotsBySection.nsfw = slotsBySection.nsfw || []).push({ slot: s, n: (p.nsfwPools[s] || []).length })
  }
  return {
    sections: SEG_NAMES,
    slotsBySection,
    nsfwSlots: Object.keys(p.nsfwPools || {}),
    pinPool: Object.keys(countsIdx()).length,
  }
}
