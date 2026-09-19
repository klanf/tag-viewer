/**
 * 数据集: 标签数据 -> 记录表, 并建好统计与系列/角色索引
 * ============================================================
 * 对应原 Python 版的 parse_records / build_stats / build_series_index。
 *
 * 数据来源(2026-09-18 起): **优先 SQLite**。
 *   tags_*.txt 只在「第一次建库」与「txt 被外部改动后重导」时被读到,
 *   平时启动直接读 dataDir/tags.db。这样:
 *     · 启动不再依赖 txt 文件在不在 / 是否可解析;
 *     · 标签数据有了结构化的权威副本(可 SQL 查、可增量更新);
 *     · 内存结构(records/byPath/tagCounter/...)与原实现完全一致,
 *       所以 query.js / search.js 一行都没改, 也能跟 Python 基线逐条对账。
 *   DB 不可用(如磁盘只读、node:sqlite 不可用)时自动回退成解析 txt。
 *
 * 与原版的其它差异(都是性能向的等价改写):
 *  1. 流式读取 + 手动切行, 边读边报进度 —— 原版一次性 readlines, 88MB 期间
 *     整个进程是黑盒; 现在能给出「已读 x 条」的进度, 首屏不用干等。
 *  2. **标签字符串池**(interning): 7 万张图 × 平均 40 个标签 ≈ 280 万个标签槽,
 *     但去重后只有约 1 万个不同标签。全部指向同一份字符串后, 内存从
 *     「280 万份字符串」降到「280 万个指针 + 1 万份字符串」。
 *  3. 额外建 `byPath` 索引, 把 lightbox/详情页的查找从 O(7万) 线性扫描变成 O(1)。
 *     (原版每次点图都要遍历全表找 path)
 */
import fs from 'node:fs'
import { streamTagFile } from './tagfile.js'
import { syncSources, readRecords, dbReady } from './store.js'
import { loadCharLib, libIsChar, libCharSeries, libIsCopyright, charLibDiag } from './charlib.js'

/** Danbooru 分类组名: 出现在 xxx_(group) 里时不是真实作品系列 */
export const NON_SERIES_GROUPS = new Set([
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

export const CATEGORY_LABELS = { game: '游戏', anime: '动漫', vtb: 'Vtuber', other: '其他' }

/** 常见系列 -> 游戏/动漫/Vtuber 的默认分类 */
export const DEFAULT_CATEGORIES = {
  blue_archive: 'game', genshin_impact: 'game', azur_lane: 'game',
  arknights: 'game', fate: 'game', 'honkai:_star_rail': 'game',
  honkai_impact: 'game', zenless_zone_zero: 'game', nikke: 'game',
  wuthering_waves: 'game', pokemon: 'game', granblue_fantasy: 'game',
  'princess_connect!': 'game', umamusume: 'game', kancolle: 'game',
  idolmaster: 'game', touhou: 'game', league_of_legends: 'game',
  overwatch: 'game', pgr: 'game', 'reverse:1999': 'game',
  elsword: 'game', neptunia: 'game', pso2: 'game',
  blue_archive_the_animation: 'game', 'nier:automata': 'game',
  nier: 'game', elden_ring: 'game', zelda: 'game',
  kingdom_hearts: 'game', xenoblade: 'game', sao: 'game',
  girls_und_panzer: 'anime', one_piece: 'anime', naruto: 'anime',
  chainsaw_man: 'anime', spy_x_family: 'anime', konosuba: 'anime',
  're:zero': 'anime', overlord: 'anime', dungeon_meshi: 'anime',
  sousou_no_frieren: 'anime', evangelion: 'anime',
  gochiusa: 'anime', maidragon: 'anime', darling_in_the_franxx: 'anime',
  machikado_mazoku: 'anime', needy_girl_overdose: 'game',
  no_game_no_life: 'anime', doki_doki_literature_club: 'game',
  hololive: 'vtb', nijisanji: 'vtb', vtuber: 'vtb',
  gawr_gura: 'vtb', minato_aqua: 'vtb', sakura_miko: 'vtb',
  shirakami_fubuki: 'vtb', tokoyami_towa: 'vtb', usada_pekora: 'vtb',
  "ninomae_ina'nis": 'vtb', natsuiro_matsuri: 'vtb', shishiro_botan: 'vtb',
  'la+_darknesss': 'vtb', tsukumo_sana: 'vtb', murasaki_shion: 'vtb',
  sakamata_chloe: 'vtb', houshou_marine: 'vtb', inugami_korone: 'vtb',
  nekomata_okayu: 'vtb', watson_amelia: 'vtb', nanashi_mumei: 'vtb',
  ceres_fauna: 'vtb', ookami_mio: 'vtb', shiranui_flare: 'vtb',
  akai_haato: 'vtb', tsunomaki_watame: 'vtb', mori_calliope: 'vtb',
  takanashi_kiara: 'vtb', himemori_luna: 'vtb', koseki_bijou: 'vtb',
  ouro_kronii: 'vtb', inui_toko: 'vtb', 'roboco-san': 'vtb',
  yuzuki_choco: 'vtb', an_gelei_nyange: 'vtb', hoshimachi_suisei: 'vtb',
  yukoku_kiriko: 'vtb', kurokami_fubuki: 'vtb', suzuhara_lulu: 'vtb',
  furen_e_lustario: 'vtb', lize_helesta: 'vtb', amane_kanata: 'vtb',
  elira_pendora: 'vtb', vestia_zeta: 'vtb', pavolia_reine: 'vtb',
  kobo_kanaeru: 'vtb', moona_hoshinova: 'vtb', anya_melfissa: 'vtb',
  pomu_rainpuff: 'vtb', finana_ryugu: 'vtb', millie_parfait: 'vtb',
  raora_panthera: 'vtb', nerissa_ravencroft: 'vtb', mococo_abyssgard: 'vtb',
  fuwawa_abyssgard: 'vtb', shiori_novella: 'vtb', kobayashi: 'anime',
}

const RE_CHAR_TAG = /^.+_\((.+)\)$/

/**
 * 从角色标签提取系列名; 非角色标签或分类组名返回 null。
 * 2026-09-18 起接入角色库(character_library.json): 无括号角色
 * (higuchi_madoka 这种)也能归到作品; 裸系列标签(genshin_impact)本身也算系列。
 */
export function seriesName(tag) {
  const m = RE_CHAR_TAG.exec(tag)
  if (m) {
    const s = m[1].toLowerCase()
    if (!NON_SERIES_GROUPS.has(s)) return s
    return libCharSeries(tag) || null      // 括号里是分类组词 -> 库里兜底
  }
  const libS = libCharSeries(tag)          // 无括号角色 -> 它所属的系列
  if (libS) return libS
  if (libIsCopyright(tag)) return String(tag).toLowerCase()   // 裸系列标签本身就是系列
  return null
}

/** 是否真正的角色标签(排除 xxx_(category) 分类写法; 无括号角色查角色库) */
export function isCharacterTag(tag) {
  const m = RE_CHAR_TAG.exec(tag)
  if (m) return !NON_SERIES_GROUPS.has(m[1].toLowerCase())
  return libIsChar(tag)
}

/** 是否裸系列标签(不带角色名的 copyright 写法, 如 genshin_impact) */
export function isCopyrightTag(tag) {
  if (RE_CHAR_TAG.exec(tag)) return false
  return libIsCopyright(tag)
}

/** 角色标签去掉末尾 _(系列) 后的短名 */
export function charShortName(tag) {
  return tag.replace(/_\([^)]*\)$/, '')
}

/** 系列分类的兜底推断: 先查手动/默认表, 再按前缀猜(game/anime/vtb) */
const PREFIX_CATEGORIES = [
  ['hololive', 'vtb'], ['nijisanji', 'vtb'], ['vocaloid', 'anime'],
  ['idolmaster', 'game'], ['uma_musume', 'game'], ['genshin', 'game'],
  ['honkai', 'game'], ['zenless', 'game'], ['arknights', 'game'],
  ['azur_lane', 'game'], ['granblue', 'game'], ['fate', 'game'],
  ['kancolle', 'game'], ['kantai', 'game'], ['touhou', 'game'],
  ['love_live', 'anime'], ['precure', 'anime'], ['gundam', 'anime'],
  ['danganronpa', 'game'], ['atelier', 'game'], ['fire_emblem', 'game'],
  ['pokemon', 'game'], ['digimon', 'anime'], ['initial_d', 'anime'],
]
export function guessCategory(name) {
  const n = String(name).toLowerCase()
  if (DEFAULT_CATEGORIES[n]) return DEFAULT_CATEGORIES[n]
  for (const [p, c] of PREFIX_CATEGORIES) if (n.startsWith(p)) return c
  return 'other'
}

// ---------------------------------------------------------------- 数据集状态

export const ds = {
  records: [],          // [{ path, tags: string[], ltags: string[], source: string }]
  sourceNames: [],
  byPath: new Map(),    // path -> record  (O(1) 替代原版的全表扫描)
  tagCounter: new Map(),
  seriesCounter: new Map(),
  seriesImgs: new Map(),   // series -> Set<recordIndex>
  seriesChars: new Map(),  // series -> Map<tag, Set<recordIndex>>
  loaded: false,
  loadMs: 0,
  stats: null,          // { files, records, tags, series }
  loadSource: '',       // 'db' | 'txt' —— 这一轮是从哪读的(诊断用)
  dbSync: null,         // { imported, skipped, removed, ms }

  // 来源过滤后的缓存
  _srcStats: new Map(),       // key -> [tagCounter, seriesCounter]
  _srcRecords: new Map(),     // key -> records[]
  _firstPath: new Map(),      // key -> Map<tag, path>
}

/** 标签字符串池: 同一个标签全库只保留一份字符串 */
const tagPool = new Map()
function intern(s) {
  let v = tagPool.get(s)
  if (v === undefined) { v = s; tagPool.set(s, v) }
  return v
}

export function tagPoolSize() { return tagPool.size }

// ---------------------------------------------------------------- 解析

/** 把一条记录塞进 ds(标签过一遍字符串池) */
function pushRecord(p, rawTags, srcName) {
  const tags = []
  const ltags = []
  for (const raw of rawTags) {
    const t = intern(raw)
    tags.push(t)
    ltags.push(intern(t.toLowerCase()))
  }
  if (!tags.length) return
  ds.records.push({ path: p, tags, ltags, source: srcName })
}

/**
 * 流式解析单个标签文件(只在建库/重建时走这条)。
 * @returns {Promise<number>} 该文件记录数
 */
async function parseFile(fp, srcName, onEach) {
  const res = await streamTagFile(fp, (rec) => {
    pushRecord(rec.path, rec.tags, srcName)
  }, (n, bytes) => { if (onEach) onEach(n, bytes) })
  return res.records
}

/**
 * 加载整个数据集。
 * @param {Map<string,string>} dataFiles  来源名 -> 文件路径
 * @param {(p:{phase:string, done:number, total:number, source?:string})=>void} onProgress
 */
export async function loadDataset(dataFiles, onProgress = () => {}) {
  const t0 = Date.now()
  ds.records = []
  ds.byPath = new Map()
  ds.sourceNames = [...dataFiles.keys()]
  ds.dbSync = null
  tagPool.clear()

  const files = [...dataFiles.entries()]
  const perFile = []
  let prefix = 0
  for (const [name, fp] of files) {
    let size = 0
    try { size = fs.statSync(fp).size } catch { size = 0 }
    perFile.push({ name, fp, size, prefix })
    prefix += size
  }
  const totalBytes = prefix || 1

  /* ---- 路线 A: SQLite(默认) ----
     syncSources 只在 txt 指纹变了时才真的读 txt; 平时这一步是空转。
     读回后得到的记录顺序与解析 txt 完全一致(images.id 自增 = 插入顺序)。 */
  try {
    onProgress({ phase: 'db-sync', done: 0, total: totalBytes })
    ds.dbSync = await syncSources(dataFiles, (p) => {
      onProgress({ phase: 'db', done: Math.round(totalBytes * 0.3), total: totalBytes, source: p.source, note: p.note })
    })

    onProgress({ phase: 'db-read', done: Math.round(totalBytes * 0.4), total: totalBytes })
    let last = 0
    readRecords((rec) => {
      pushRecord(rec.path, rec.tags, rec.source)
      const n = ds.records.length
      if (n - last >= 5000) {
        last = n
        onProgress({
          phase: 'db-read',
          done: Math.min(totalBytes, Math.round(totalBytes * (0.4 + 0.6 * (n / 71214)))),
          total: totalBytes,
          records: n,
        })
      }
    })
    if (ds.records.length) {
      ds.loadSource = 'db'
    } else {
      ds.loadSource = ''
    }
  } catch (e) {
    console.error('[dataset] SQLite 路径不可用, 回退解析 txt:', e?.message || e)
    ds.records = []
    ds.byPath = new Map()
    tagPool.clear()
    ds.dbSync = null
  }

  /* ---- 路线 B: 回退 —— 直接解析 txt ---- */
  if (!ds.records.length) {
    ds.loadSource = 'txt'
    onProgress({ phase: 'parse', done: 0, total: totalBytes })
    for (const f of perFile) {
      if (!fs.existsSync(f.fp)) {
        throw new Error(`找不到标签文件, 且标签库(tags.db)里也没有数据: ${f.fp}`)
      }
      let last = 0
      await parseFile(f.fp, f.name, (n, bytes) => {
        if (n - last >= 2000) {
          last = n
          onProgress({
            phase: 'parse',
            // 已完成的整文件字节 + 当前流已读字节(readline 按缓冲推进, 够平滑了)
            done: Math.min(f.prefix + (bytes || 0), totalBytes),
            total: totalBytes,
            source: f.name,
            records: ds.records.length,
          })
        }
      })
    }
  }

  if (!ds.records.length) {
    throw new Error('没有可用的标签数据: 标签库为空, 且配置里的 tags_*.txt 也读不到')
  }

  onProgress({ phase: 'stats', done: totalBytes, total: totalBytes, records: ds.records.length })

  // 角色库: 必须在 buildStats/buildSeriesIndex 之前就位(它们要查角色->系列)
  loadCharLib()

  // path -> record 索引(重复路径保留先出现的)
  ds.byPath = new Map()
  for (let i = 0; i < ds.records.length; i++) {
    const p = ds.records[i].path
    if (!ds.byPath.has(p)) ds.byPath.set(p, i)
  }

  buildStats()

  onProgress({ phase: 'series', done: totalBytes, total: totalBytes, records: ds.records.length })
  buildSeriesIndex()

  ds._srcStats.clear()
  ds._srcRecords.clear()
  ds._firstPath.clear()
  ds.loaded = true
  ds.loadMs = Date.now() - t0
  ds.stats = {
    files: files.length,
    records: ds.records.length,
    tags: ds.tagCounter.size,
    series: ds.seriesCounter.size,
    tagsInPool: tagPool.size,
    source: ds.loadSource,          // 'db' | 'txt'
    db: dbReady(),
    ms: ds.loadMs,
    charLib: charLibDiag(),
  }
  return ds.stats
}

function buildStats() {
  const tc = new Map()
  const sc = new Map()
  for (const r of ds.records) {
    for (const t of r.tags) {
      tc.set(t, (tc.get(t) || 0) + 1)
      const s = seriesName(t)
      if (s) sc.set(s, (sc.get(s) || 0) + 1)
    }
  }
  ds.tagCounter = tc
  ds.seriesCounter = sc
}

function buildSeriesIndex() {
  const si = new Map()
  const sc = new Map()
  for (let idx = 0; idx < ds.records.length; idx++) {
    for (const t of ds.records[idx].tags) {
      const s = seriesName(t)
      if (!s) continue
      let imgs = si.get(s)
      if (!imgs) { imgs = new Set(); si.set(s, imgs) }
      imgs.add(idx)
      // 只有真正的角色才进 系列->角色 索引 —— 裸系列标签(版权)归属了系列,
      // 但它自己不是"角色", 不能出现在系列详情页的角色列表里
      if (!isCharacterTag(t)) continue
      let chars = sc.get(s)
      if (!chars) { chars = new Map(); sc.set(s, chars) }
      let ids = chars.get(t)
      if (!ids) { ids = new Set(); chars.set(t, ids) }
      ids.add(idx)
    }
  }
  ds.seriesImgs = si
  ds.seriesChars = sc
}

// ---------------------------------------------------------------- 来源过滤

export function frozenKey(srcSet) {
  if (!srcSet || srcSet.size === 0) return ''
  return [...srcSet].sort().join('\u0000')
}

/** 按来源过滤后的记录表(带缓存) */
export function recordsFor(srcSet) {
  if (!srcSet || srcSet.size === 0) return ds.records
  const key = frozenKey(srcSet)
  let v = ds._srcRecords.get(key)
  if (!v) {
    v = ds.records.filter((r) => srcSet.has(r.source))
    ds._srcRecords.set(key, v)
  }
  return v
}

/** (tagCounter, seriesCounter, records) 三联组, 按来源组合缓存 */
export function statsFor(srcSet) {
  if (!srcSet || srcSet.size === 0) {
    return [ds.tagCounter, ds.seriesCounter, ds.records]
  }
  const key = frozenKey(srcSet)
  let v = ds._srcStats.get(key)
  if (!v) {
    const recs = recordsFor(srcSet)
    const tc = new Map()
    const sc = new Map()
    for (const r of recs) {
      for (const t of r.tags) {
        tc.set(t, (tc.get(t) || 0) + 1)
        const s = seriesName(t)
        if (s) sc.set(s, (sc.get(s) || 0) + 1)
      }
    }
    v = [tc, sc, recs]
    ds._srcStats.set(key, v)
  }
  return v
}

/**
 * { tag: 首个出现该 tag 的图片路径 } —— 给自定义系列找封面用。
 * 原版对每个自定义系列都扫一遍全表(119 个系列 = 119 × 7 万), 这里是
 * 「一次遍历 + 按来源组合缓存」。
 */
export function firstPathMap(srcSet) {
  const key = frozenKey(srcSet)
  let m = ds._firstPath.get(key)
  if (!m) {
    m = new Map()
    for (const rec of recordsFor(srcSet)) {
      const p = rec.path
      for (const t of rec.tags) if (!m.has(t)) m.set(t, p)
    }
    ds._firstPath.set(key, m)
  }
  return m
}

/** 按 path 取记录(O(1)) */
export function recordByPath(p) {
  const i = ds.byPath.get(p)
  return i === undefined ? null : ds.records[i]
}

/** 取索引集合的最小值(替代 Python 的 min(set)) */
export function minIdx(set) {
  let m = Infinity
  for (const i of set) if (i < m) m = i
  return m === Infinity ? 0 : m
}
