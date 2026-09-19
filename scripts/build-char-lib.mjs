#!/usr/bin/env node
/**
 * 构建角色库 character_library.json
 * ===================================
 * 目的: 看板此前只认 xxx_(系列) 这种带括号的角色标签, 像 higuchi_madoka
 * 这种无括号写法既不算角色、也没法归到作品, 导致:
 *   · 系列/角色识别显示「未识别出系列/角色」
 *   · 导出/复制「普通标签」时角色标签混进去
 * 本脚本把三份离线数据 + (可选)danbooru API 合成一个角色库:
 *   1. tags.db 的 tags 表          —— 库内实际出现过的标签与次数
 *   2. danbooru_cats.json          —— 此前对库内标签做过的一轮 danbooru 分类扫描
 *   3. danbooru_char_series.json   —— 此前用 related_tag API 推出的 610 条 角色->系列
 *   4. wd-pixai-tagger-v0.9.csv    —— PixAI 模型词表(13461 条, 带 danbooru 类别)
 *   5. user_meta.json.custom_chars —— 用户在系列页手动补充的角色
 *
 * 用法:
 *   node scripts/build-char-lib.mjs [--data-dir <dir>] [--api] [--out <file>]
 *   --api  联网补漏(danbooru 直连, 需要代理; 离线跑完缺的部分会留空)
 *
 * 产物结构:
 *   { version, generated_at, stats,
 *     chars:     { 标签: { series: "系列|null", src: "paren|cooccur|api|manual|noseries" } },
 *     copyright: [裸系列标签...],
 *     artists:   [画师标签...] }
 *
 * 2026-09-18 实测(离线): 库内 11136 标签 -> 角色 1971(带系列 1971),
 * 其中无括号角色 610 条全部有系列映射; 无类别且 CSV 也没有的裸标签 804 条
 * 按 general 处理(其中 0 条是 CSV 认定的角色)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localDataDir, localOldRoot } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const WINE = (p) => p.replace(/\\/g, '/')

const argv = process.argv.slice(2)
function argOf(flag, dflt) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const hasFlag = (flag) => argv.includes(flag)

// 默认值来自 local.config.json / TV_DATA_DIR（见 scripts/local-config.mjs），
// 仓库里不再出现任何开发机绝对路径。
const DATA_DIR = WINE(argOf('--data-dir', localDataDir()))
/** 旧版 Python 工具根目录 —— 只有迁移/对账路径用得到, 没配置就为空 */
const OLD_ROOT = WINE(argOf('--old-root', localOldRoot()))
const CSV_PATH = WINE(argOf('--csv', OLD_ROOT ? `${OLD_ROOT}/model/wd-pixai-tagger-v0.9.csv` : path.join(DATA_DIR, 'wd-pixai-tagger-v0.9.csv')))
const OUT_PATH = WINE(argOf('--out', `${DATA_DIR}/character_library.json`))
const USE_API = hasFlag('--api')

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
])

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/* ---------- 1. 库内标签 ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'tags.db'), { readOnly: true })
const rows = db.prepare('SELECT name, cnt FROM tags').all()
db.close()
console.log(`[1/5] tags.db: ${rows.length} 个标签`)

/* ---------- 2/3. 此前的 danbooru 分类扫描 + 角色->系列映射 ---------- */
const catsFile = readJson(path.join(OLD_ROOT, 'danbooru_cats.json')) || { cats: {} }
const cooccur = readJson(path.join(OLD_ROOT, 'danbooru_char_series.json')) || {}
const cats = catsFile.cats || {}
console.log(`[2/5] danbooru_cats.json: ${Object.keys(cats).length} 条类别;  char_series.json: ${Object.keys(cooccur).length} 条映射`)

/* ---------- 4. PixAI CSV 词表 ---------- */
const csvCat = new Map()
{
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.lastIndexOf(',')
    const j = line.indexOf(',')
    if (i < 0 || j < 0 || i <= j) continue
    const name = line.slice(j + 1, i).trim()
    const cat = parseInt(line.slice(i + 1), 10)
    if (name && !Number.isNaN(cat)) csvCat.set(name, cat)
  }
}
console.log(`[3/5] PixAI CSV: ${csvCat.size} 条词表`)

/** 类别解析顺序: cats(历史扫描) > CSV(模型词表) */
const catOf = (t) => (cats[t] !== undefined ? cats[t] : csvCat.get(t))

/* ---------- 5. 用户手动补充的角色(user_meta.json.custom_chars) ---------- */
const manualChars = new Map() // tag -> series
{
  const meta = readJson(path.join(DATA_DIR, 'user_meta.json'))
  const cc = meta?.custom_chars || {}
  for (const [series, list] of Object.entries(cc)) {
    for (const t of Array.isArray(list) ? list : []) manualChars.set(String(t), String(series))
  }
  console.log(`[4/5] user_meta.json: ${manualChars.size} 条手动角色`)
}

/* ---------- 合成 ---------- */
const chars = Object.create(null)
const copyright = new Set()
const artists = new Set()
const stats = {
  db_tags: rows.length,
  char_paren: 0, char_bare: 0, char_bare_no_series: 0,
  manual: 0, copyright: 0, artists: 0,
  unknown_bare: 0,
  api_queried: 0, api_failed: 0,
}

for (const { name, cnt } of rows) {
  const t = String(name)
  const m = RE_CHAR.exec(t)
  const cat = catOf(t)

  if (m) {
    const group = m[2].toLowerCase()
    if (NON_SERIES_GROUPS.has(group)) {
      if (cat === 1) artists.add(t)
      else if (cat === 3) copyright.add(t)
      else stats.unknown_bare += 0     // 括号分类组, 不计入
      continue
    }
    // 括号写法: 系列直接取括号(运行时本来就能解析, 写进来是为了统一走库查询)
    chars[t] = { series: group, src: 'paren' }
    stats.char_paren++
    continue
  }

  // 无括号标签
  if (cat === 1) { artists.add(t); continue }
  if (cat === 3) { copyright.add(t); continue }
  if (cat === 4 || manualChars.has(t)) {
    const s = cooccur[t]?.series || manualChars.get(t) || null
    if (s) {
      chars[t] = { series: String(s).toLowerCase(), src: manualChars.has(t) && !cooccur[t] ? 'manual' : 'cooccur' }
      stats.char_bare++
    } else {
      chars[t] = { series: null, src: 'noseries' }
      stats.char_bare++
      stats.char_bare_no_series++
    }
    continue
  }
  if (cat === undefined) stats.unknown_bare++
}

// 旧映射里还有而库里没出现的(比如标签曾经存在后来删了): 也收进来, 不影响正确性
for (const [t, v] of Object.entries(cooccur)) {
  if (!chars[t] && !RE_CHAR.exec(t)) {
    chars[t] = { series: String(v.series || '').toLowerCase() || null, src: 'cooccur' }
    stats.char_bare++
  }
  if (v.series) copyright.add(String(v.series).toLowerCase())
}
for (const [t, s] of manualChars) {
  if (!chars[t]) { chars[t] = { series: String(s).toLowerCase(), src: 'manual' }; stats.char_bare++; stats.manual++ }
}
stats.copyright = copyright.size
stats.artists = artists.size

/* ---------- 可选: 联网补漏 ---------- */
if (USE_API) {
  const targets = Object.entries(chars).filter(([, v]) => !v.series).map(([t]) => t)
  const unknown = rows.map((r) => String(r.name)).filter((t) => catOf(t) === undefined && !RE_CHAR.exec(t))
  console.log(`[api] 需要 related_tag 的角色: ${targets.length};  类别未知的裸标签: ${unknown.length}`)
  const UA = { 'User-Agent': 'tagviewer/1.0 (local research)' }
  const fetchJson = async (url, retry = 3) => {
    for (let i = 0; i < retry; i++) {
      try {
        const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) })
        if (r.ok) return await r.json()
      } catch { /* 重试 */ }
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)))
    }
    return null
  }
  // 5.1 类别补漏: /tags.json?search[name_comma]=a,b,c...
  for (let i = 0; i < unknown.length; i += 40) {
    const chunk = unknown.slice(i, i + 40)
    const d = await fetchJson('https://danbooru.donmai.us/tags.json?search[name_comma]=' + encodeURIComponent(chunk.join(',')))
    if (Array.isArray(d)) for (const t of d) if (t?.name) cats[t.name] = t.category
    process.stdout.write(`\r[api] 类别 ${Math.min(i + 40, unknown.length)}/${unknown.length}`)
  }
  console.log()
  // 5.2 角色补系列: related_tag 取 cosine 最高的 category=3
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const d = await fetchJson('https://danbooru.donmai.us/related_tag.json?query=' + encodeURIComponent(t) + '&limit=50')
    let best = null
    if (d && Array.isArray(d.related_tags)) {
      for (const rt of d.related_tags) {
        const tag = rt?.tag || {}
        if (tag.category !== 3) continue
        if ((rt.frequency ?? 0) < 0.5) continue
        const cs = rt.cosine_similarity ?? 0
        if (!best || cs > best[1]) best = [tag.name, cs]
      }
    }
    if (best) { chars[t] = { series: best[0], src: 'api' }; stats.api_queried++ }
    else stats.api_failed++
    if ((i + 1) % 25 === 0) console.log(`[api] related_tag ${i + 1}/${targets.length}  命中 ${stats.api_queried}`)
    await new Promise((res) => setTimeout(res, 350))   // 控速, 别把公共 API 打爆
  }
}

/* ---------- 落盘 ---------- */
const out = {
  version: 1,
  generated_at: new Date().toISOString(),
  generator: 'tag-viewer-electron/scripts/build-char-lib.mjs',
  data_dir: DATA_DIR,
  stats,
  chars,
  copyright: [...copyright].sort(),
  artists: [...artists].sort(),
}
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
const tmp = OUT_PATH + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8')
fs.renameSync(tmp, OUT_PATH)

const withSeries = Object.values(chars).filter((v) => v.series).length
console.log(`\n[5/5] 完成 -> ${OUT_PATH}`)
console.log(`  角色合计 ${Object.keys(chars).length} (带系列 ${withSeries})`)
console.log(`  其中: 括号写法 ${stats.char_paren} / 无括号 ${stats.char_bare}(无系列 ${stats.char_bare_no_series}) / 手动 ${stats.manual}`)
console.log(`  裸系列(copyright) ${stats.copyright} · 画师 ${stats.artists} · 未分类裸标签 ${stats.unknown_bare}`)
if (USE_API) console.log(`  API 补漏: 命中 ${stats.api_queried} / 失败 ${stats.api_failed}`)
