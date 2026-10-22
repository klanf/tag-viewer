#!/usr/bin/env node
/**
 * 构建角色库 character_library.json
 * ===================================
 * 目的: 看板需要把 xxx_(系列) 与无括号角色标签统一归到作品, 供系列页/光箱/
 * 导出判断"这是角色还是普通标签"。
 *
 * 数据来源(优先级从高到低):
 *   1. danbooru_v1_meta.json          —— 2026-10-21 对 v1.0 全量角色查的 Danbooru
 *                                        角色->系列 + 性别(女/男/怪物/未定)
 *   2. danbooru_char_series_full.json —— v0.9 时代查过的 3723 条角色->系列
 *   3. PixAI v1.0 CSV                 —— 角色/系列词表(8308 角色 / 2460 系列)
 *   4. tags.db 的 tags 表             —— 库内实际出现过的标签
 *   5. danbooru_cats.json / char_series.json —— 历史分类与 610 条共现映射
 *   6. 旧 character_library.json      —— 只继承 src != manual 的自动条目
 *
 * 手工层(user_meta.custom_chars)不再参与构建: 2026-10-21 用户要求清除手工
 * 添加的角色; 新角色一律来自 v1.0 CSV, 且只收女性、必须有系列。旧库里自动
 * 来源(括号/共现/API)的角色继续保留, 避免已有关键图失去系列归属 —— 但其中
 * v1.0 明确判成 general/style 的道具/概念标签(剑、花、棋子这类)和含 <...>
 * 的异常标签会剔掉, 它们本来就不该算角色。剔掉的这批同时写进 non_char 名单,
 * 让运行时的"括号自述"兜底也别再把它们当角色。
 *
 * 用法:
 *   node scripts/build-char-lib.mjs [--data-dir <dir>] [--csv <file>] [--out <file>]
 *
 * 产物结构:
 *   { version, generated_at, stats,
 *     chars:     { 标签: { series, src: "api|paren|cooccur" } },
 *     copyright: [裸系列标签...],
 *     artists:   [画师标签...] }
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localDataDir, localOldRoot } from './local-config.mjs'

const WINE = (p) => p.replace(/\\/g, '/')

const argv = process.argv.slice(2)
function argOf(flag, dflt) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const DATA_DIR = WINE(argOf('--data-dir', localDataDir()))
const OLD_ROOT = WINE(argOf('--old-root', localOldRoot()))
const V10_CSV = `${DATA_DIR}/models/pixai-tagger-v1.0-1008-fp16.csv`
const V09_CSV = OLD_ROOT ? `${OLD_ROOT}/model/wd-pixai-tagger-v0.9.csv` : `${DATA_DIR}/wd-pixai-tagger-v0.9.csv`
const CSV_PATH = WINE(argOf('--csv', fs.existsSync(V10_CSV) ? V10_CSV : V09_CSV))
const OUT_PATH = WINE(argOf('--out', `${DATA_DIR}/character_library.json`))
const META_PATH = `${OLD_ROOT}/danbooru_v1_meta.json`
const FULL_PATH = `${OLD_ROOT}/danbooru_char_series_full.json`

const RE_CHAR = /^(.+)_\((.+)\)$/
/** 与 dataset.js 的 NON_SERIES_GROUPS 对齐: 括号里是这些词的不是系列 */
const NON_SERIES_GROUPS = new Set([
  'general', 'character', 'copyright', 'artist', 'meta', 'rating',
  'symbol', 'medium', 'clothing', 'clothes', 'place', 'object', 'language',
  'spoiler', 'photobomb', 'copy', 'text', 'icon', 'logo', 'banner',
  'frame', 'panel', 'source', 'audio', 'video', 'file', 'link',
  'other', 'unknown', 'series', 'work', 'style', 'theme',
  'shape', 'color', 'colour', 'size', 'pattern', 'pose', 'type',
  'category', 'tag', 'group', 'cosplay', 'artwork', 'image',
  'food', 'animal', 'plant', 'vehicle', 'furniture', 'instrument',
  'nature', 'weather', 'sky', 'water', 'fire', 'light', 'dark',
  /* 下面这批由四份反推词表(v0.9 + v1.0 的 1008/336/672)统计得出:
   * 这些括号组名下**从来没有** character/copyright 标签, 全是道具、部位、
   * 材质、概念。缺了它们, xxx_(weapon) 这种就会被括号兜底当成作品系列。 */
  'weapon', 'polearm', 'projectile', 'sword', 'bow', 'armor', 'helmet',
  'scabbard', 'mecha', 'mask', 'headwear', 'headdress', 'hat', 'hair',
  'hairstyle', 'makeup', 'cosmetics', 'piercing', 'jewelry', 'ornament',
  'decoration', 'glowstick', 'container', 'bottle', 'cup', 'bowl',
  'vessel', 'toy', 'doll', 'statue', 'sculpture', 'machine', 'robot',
  'tool', 'hardware', 'software', 'computing', 'board_game', 'chess',
  'flower', 'fruit', 'gemstone', 'stone', 'tree', 'seaweed', 'organ',
  'anatomy', 'species', 'constellation', 'planet', 'element', 'gold',
  'emblem', 'font', 'letter', 'phrase', 'meme', 'original', 'western',
  'fandom', 'trend', 'topic', 'site', 'city', 'structure', 'geometry',
  'texture', 'substance', 'action', 'gesture', 'riding', 'summon',
  'cheerleading', 'hanetsuki', 'sport', 'expression', 'sex', 'sexual',
  'nonsexual', 'mtf', 'ftm', 'otf', 'aircraft', 'automobile', 'brand',
])
/** 仅用于"没有 Danbooru 映射"时的括号兜底: 1st_costume 这类服装/形态分组不算系列 */
const COSTUME_GROUP = /(^|_)(1st|2nd|3rd|4th|5th|costume|outfit|uniform|swimsuit|streetwear|casual|membership|alt|alternate)(_|$)/
/** 旧库自动层里被误收成角色的道具/概念标签: 括号组是通用类别, 不是作品 */
const NON_CHAR_GROUPS = new Set(['conducting', 'computer', 'legends', 'meme', 'music'])
/** 旧库自动层里不在 v1.0 词表、但明显不是角色的个别标签 */
const NON_CHAR_TAGS = new Set([
  'crisis_management_form_(machimazo)',
  'fairy_(sao)',
  'remodel_(kantai_collection)',
])
/** 旧库时代留下的系列别名 -> Danbooru 规范名 */
const SERIES_ALIAS = { fate: 'fate_(series)' }
const canonicalSeries = (s) => SERIES_ALIAS[s] || s
const isCharacterCandidate = (t) => {
  if (/[<>]/.test(t) || /^artist:/i.test(t)) return false
  if (NON_CHAR_TAGS.has(t)) return false
  const cat = csvCat.get(t)
  if (cat !== undefined) return cat === 4
  const m = RE_CHAR.exec(t)
  return !(m && NON_CHAR_GROUPS.has(m[2].toLowerCase()))
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/* ---------- 1. v1.0 / v0.9 CSV 词表 ---------- */
const csvCat = new Map()
const v1Chars = new Set()
const csvCopyright = new Set()
const catNum = { general: 0, artist: 1, copyright: 3, character: 4, meta: 5, rating: 9, style: 0 }
{
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  const lines = text.split(/\r?\n/)
  const header = (lines[0] || '').split(',')
  const idxName = Math.max(1, header.indexOf('name'))
  const idxCat = header.indexOf('category')
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cols = line.split(',')
    const name = cols[idxName]
    const rawCat = cols[idxCat]
    if (!name || rawCat === undefined) continue
    const cat = /^\d+$/.test(rawCat) ? Number(rawCat) : catNum[rawCat]
    if (cat === undefined) continue
    csvCat.set(name, cat)
    if (cat === 4) v1Chars.add(name)
    if (cat === 3) csvCopyright.add(name)
  }
}
console.log(`[1/5] CSV ${path.basename(CSV_PATH)}: ${csvCat.size} 条词表, 角色 ${v1Chars.size}, 系列 ${csvCopyright.size}`)

/* ---------- 2. 库内标签 ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'tags.db'), { readOnly: true })
const rows = db.prepare('SELECT name, cnt FROM tags').all()
db.close()
console.log(`[2/5] tags.db: ${rows.length} 个标签`)

/* ---------- 3. Danbooru 数据 ---------- */
const catsFile = readJson(path.join(OLD_ROOT, 'danbooru_cats.json')) || { cats: {} }
const cooccur = readJson(path.join(OLD_ROOT, 'danbooru_char_series.json')) || {}
const full = readJson(FULL_PATH) || {}
const meta = readJson(META_PATH) || {}
const cats = catsFile.cats || {}
console.log(`[3/5] Danbooru: cats ${Object.keys(cats).length} 条, 共现 ${Object.keys(cooccur).length} 条, full ${Object.keys(full).length} 条, v1 meta ${Object.keys(meta).length} 条`)

/* ---------- 4. 旧库: 只继承自动来源 ---------- */
const oldLib = readJson(OUT_PATH) || {}
const oldChars = oldLib.chars || {}
const oldAuto = new Map()
let oldManual = 0
for (const [t, v] of Object.entries(oldChars)) {
  if (!v) continue
  if (v.src === 'manual') { oldManual++; continue }
  oldAuto.set(t, v)
}
console.log(`[4/5] 旧库: 自动 ${oldAuto.size} 条, 手工 ${oldManual} 条(清除)`)

/* ---------- 5. 合成 ---------- */
const chars = Object.create(null)
const copyright = new Set(csvCopyright)
const artists = new Set()
const oldSeriesSet = new Set(Object.values(oldChars).map((v) => v && v.series).filter(Boolean).map((s) => String(s).toLowerCase()))
const stats = {
  db_tags: rows.length,
  old_auto: oldAuto.size,
  old_manual_removed: oldManual,
  old_nonchar_removed: 0,
  v1_chars: v1Chars.size,
  v1_added: 0, v1_male: 0, v1_monster: 0, v1_unknown: 0, v1_noseries: 0,
  local_kept: 0,
  db_extra: 0,
  remapped: 0,
  non_char: 0,
  char_paren: 0, char_bare: 0,
  manual: 0,
  copyright: 0, artists: 0,
  unknown_bare: 0,
}

const metaSeries = (t) => {
  const m = meta[t]
  if (m && m.series) return String(m.series).toLowerCase()
  const f = full[t]
  return f && f.series ? String(f.series).toLowerCase() : null
}
const seriesFromParen = (t) => {
  const m = RE_CHAR.exec(t)
  if (!m) return null
  const g = m[2].toLowerCase()
  if (NON_SERIES_GROUPS.has(g) || COSTUME_GROUP.test(g)) return null
  return (csvCopyright.has(g) || oldSeriesSet.has(g)) ? g : null
}
/** 括号里是服装/形态分组时, 去掉括号按本体角色查系列:
 *  hoshimachi_suisei_(streetwear) -> hoshimachi_suisei -> hololive */
const baseCharSeries = (t) => {
  const m = RE_CHAR.exec(t)
  return m ? metaSeries(m[1]) : null
}

// 5.1 旧库自动条目: 有 Danbooru 映射就用映射(修正 1st_costume/fate 这类旧名)
for (const [t, v] of oldAuto) {
  if (!isCharacterCandidate(t)) { stats.old_nonchar_removed++; continue }
  const api = metaSeries(t)
  const oldSeries = v.series ? String(v.series).toLowerCase() : null
  let s = api || oldSeries
  if (!api && s && COSTUME_GROUP.test(s)) s = baseCharSeries(t) || s
  if (!s) continue
  s = canonicalSeries(s)
  if (api && oldSeries && api !== oldSeries) stats.remapped++
  chars[t] = { series: s, src: api ? 'api' : (v.src || 'paren') }
  copyright.add(s)
}

// 5.2 v1.0 角色: 只补"女性 + 有系列"的新角色
for (const t of v1Chars) {
  if (chars[t]) continue
  const m = meta[t]
  const s = canonicalSeries(metaSeries(t) || seriesFromParen(t) || baseCharSeries(t))
  if (!s) { stats.v1_noseries++; continue }
  if (!m || !m.gender) { stats.v1_unknown++; continue }
  if (m.gender === 'male') { stats.v1_male++; continue }
  if (m.gender === 'monster') { stats.v1_monster++; continue }
  if (m.gender !== 'female') { stats.v1_unknown++; continue }
  chars[t] = { series: s, src: metaSeries(t) ? 'api' : 'paren' }
  copyright.add(s)
  stats.v1_added++
}

// 5.3 库内出现过、但 v1.0 词表没有的括号角色: 保留自动归属, 不让已有图掉系列
for (const { name } of rows) {
  const t = String(name)
  if (chars[t] || !RE_CHAR.test(t) || !isCharacterCandidate(t)) continue
  const s = canonicalSeries(metaSeries(t) || seriesFromParen(t) || baseCharSeries(t))
  if (s) {
    chars[t] = { series: s, src: metaSeries(t) ? 'api' : 'paren' }
    copyright.add(s)
    stats.db_extra++
  }
}

// 5.3b 本地已经有图、但被 5.2「只补女性」闸门挡掉的词表角色 —— 恢复归属用。
//      补充新角色只收女性(用户 2026-10-21 的要求), 但这批不是补充: 用户库里就有它们的图,
//      只是性别判定拿不准(Danbooru wiki 没写代词)。一刀切剔掉会让 kamisato_ayaka(676 张)
//      这种直接掉成「未识别出系列」, 属于把已有数据改坏了。
//      闸门: 词表判 character + Danbooru 查得到系列 + 性别不是男/怪物(这两类仍然剔)。
const localCnt = new Map(rows.map((r) => [String(r.name).toLowerCase(), Number(r.cnt) || 0]))
for (const t of v1Chars) {
  if (chars[t]) continue
  const m = meta[t]
  if (m && (m.gender === 'male' || m.gender === 'monster')) continue
  const s = canonicalSeries(metaSeries(t))
  if (!s) continue
  if (!(localCnt.get(t) > 0)) continue
  chars[t] = { series: s, src: 'local' }
  copyright.add(s)
  stats.local_kept++
}

// 5.4 历史分类里的画师/裸系列
for (const [t, cat] of Object.entries(cats)) {
  if (cat === 1) artists.add(t)
  else if (cat === 3) copyright.add(String(t).toLowerCase())
}
for (const [t, v] of Object.entries(cooccur)) {
  if (v && v.series) copyright.add(String(v.series).toLowerCase())
}

stats.char_paren = Object.keys(chars).filter((t) => RE_CHAR.test(t)).length
stats.char_bare = Object.keys(chars).length - stats.char_paren
stats.copyright = copyright.size
stats.artists = artists.size
/* 运行时括号兜底很天真: 只要 xxx_(yyy) 就认成角色。旧库里那批道具/概念标签
 * (剑、花、棋子、电脑外设)因此即使已从角色库剔掉, 还会靠括号把系列顶回来。
 * 名单直接取 v1.0 全部非角色/非系列的括号标签(约 1900 条), 这样新图第一次
 * 出现这些道具词时也不会被误认成角色。 */
const nonChar = new Set()
for (const [t, cat] of csvCat) {
  if (!RE_CHAR.test(t) || chars[t]) continue
  if (cat !== 4 && cat !== 3) nonChar.add(t.toLowerCase())
}
for (const { name } of rows) {
  const t = String(name)
  if (!RE_CHAR.test(t) || chars[t]) continue
  const cat = csvCat.get(t)
  const m = RE_CHAR.exec(t)
  if (NON_CHAR_TAGS.has(t) || /[<>]/.test(t) || /^artist:/i.test(t) ||
      (cat === undefined && NON_CHAR_GROUPS.has(m[2].toLowerCase()))) {
    nonChar.add(t.toLowerCase())
  }
}
stats.non_char = nonChar.size
for (const { name } of rows) {
  const t = String(name)
  if (RE_CHAR.test(t)) continue
  if (csvCat.get(t) === undefined && !chars[t]) stats.unknown_bare++
}

/* ---------- 落盘 ---------- */
const out = {
  version: 2,
  generated_at: new Date().toISOString(),
  generator: 'tag-viewer-electron/scripts/build-char-lib.mjs',
  data_dir: DATA_DIR,
  stats,
  chars,
  copyright: [...copyright].sort(),
  artists: [...artists].sort(),
  non_char: [...nonChar].sort(),
}
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
const tmp = OUT_PATH + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8')
fs.renameSync(tmp, OUT_PATH)

const withSeries = Object.values(chars).filter((v) => v.series).length
console.log(`\n[5/5] 完成 -> ${OUT_PATH}`)
console.log(`  角色合计 ${Object.keys(chars).length} (带系列 ${withSeries})`)
console.log(`  括号 ${stats.char_paren} / 无括号 ${stats.char_bare} / 旧库自动 ${stats.old_auto}(重映射 ${stats.remapped}) / 库里额外 ${stats.db_extra}`)
console.log(`  v1.0: 新增 ${stats.v1_added} · 男 ${stats.v1_male} · 怪物 ${stats.v1_monster} · 未定 ${stats.v1_unknown} · 无系列 ${stats.v1_noseries} · 本地有图恢复归属 ${stats.local_kept}`)
console.log(`  手工 ${stats.old_manual_removed} 条已清除 · 旧库误收的道具/概念标签 ${stats.old_nonchar_removed} 条已剔除 · 运行时禁用名单 ${stats.non_char} 条 · 裸系列 ${stats.copyright} · 画师 ${stats.artists} · 未分类裸标签 ${stats.unknown_bare}`)
