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
import { syncSources, readRecords, dbReady, sourceNameList, openDb, normalizeImagePath } from './store.js'
import { loadCharLib, libIsChar, libCharSeries, libIsCopyright, charLibDiag } from './charlib.js'
import { unsafeLevelOf, safetyMatcher } from './safety.js'

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
  records: [],          // [{ path, tags, ltags, source, px_w, px_h, unsafe }]
                        //   px_w/px_h: 像素尺寸(0=未知, 卡片回落到 9/16 默认比例)
                        //   unsafe:    0=干净 / 1=命中敏感标签的 core 段 / 2=只命中 edge 段
                        //              —— 读数据集时算一次, 前端切档只做比较, 不重载数据
  unsafeCore: 0,        // 命中 core 段的条数 —— core 档开启时会隐藏这么多
  unsafeEdge: 0,        // 只命中 edge 段的条数 —— edge 档比 core 档再多隐藏这么多
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

/**
 * 双缓冲的**写目标**(2026-10-03)。
 * 平时 = ds 本身; loadDataset 重载期间指向 fresh 副本 —— 构建全程不碰线上 ds,
 * 期间所有查询(搜索/导出/详情)继续读到旧数据, 界面完全可用; 成功后一次原子
 * 换血, 失败则整份丢弃。pushRecord/buildStats/buildSeriesIndex 一律写 W。
 */
let W = ds

export function tagPoolSize() { return tagPool.size }

/**
 * 按**当前**标签集合重算所有记录的安全标记。
 *
 * 用在: 用户在界面上改了敏感标签集合之后。只遍历内存里的 tags(八万条约 150ms),
 * 比重新读一遍库(几秒)便宜得多 —— 而且不需要碰磁盘上的任何一行数据。
 * 逐条 Set 查询, 顺带把两个计数重算出来给界面显示。
 */
export function recomputeSafety() {
  const m = safetyMatcher()
  ds.unsafeCore = 0
  ds.unsafeEdge = 0
  for (const r of ds.records) {
    const u = unsafeLevelOf(r.ltags, m)
    r.unsafe = u
    if (u === 1) ds.unsafeCore++
    else if (u === 2) ds.unsafeEdge++
  }
  return { core: ds.unsafeCore, edge: ds.unsafeEdge, total: ds.records.length }
}

// ---------------------------------------------------------------- 解析

/** 把一条记录塞进 ds(标签过一遍字符串池)
 * @param {string} p 路径
 * @param {string[]} rawTags 标签
 * @param {string} srcName 来源名
 * @param {{w:number,h:number}|null} [dims] 像素尺寸; 从 txt 建库时没有(留 0)
 * @param {string} [tagsSrc] 标签来源(meta=自带 / wd14=反推 / meta+wd14=历史合并 / legacy=手工)
 * @param {string} [imgSrc] 图内元数据来源(comfyui/a1111/...); 卡片生成器徽章用 */
function pushRecord(p, rawTags, srcName, dims = null, tagsSrc = '', imgSrc = '') {
  const tags = []
  const ltags = []
  for (const raw of rawTags) {
    const t = intern(raw)
    tags.push(t)
    ltags.push(intern(t.toLowerCase()))
  }
  /* 2026-10-18 WD14 按需安装(v3): 无标签的图不再在这里丢掉 —— 看板允许显示
   * 没有标签的图(这是"没装反推也能正常进看板"的前提), 装好反推打上标签后
   * 内容自然丰富。 */
  const unsafe = unsafeLevelOf(ltags)
  if (unsafe === 1) W.unsafeCore++
  else if (unsafe === 2) W.unsafeEdge++
  W.records.push({
    path: p,
    tags,
    ltags,
    source: srcName,
    // 标签来源徽章用: ''(txt 建库路径没有这层信息) / meta / wd14 / meta+wd14 / legacy
    tagsSrc: String(tagsSrc || ''),
    // 0 = 不知道(老库还没回填 / 从 txt 建库来的)。消费方必须把 0 当"未知",
    // 回落到默认比例 —— 拿 0 算比例会得到 Infinity 或 0, 布局直接塌掉。
    px_w: Number(dims?.w) || 0,
    px_h: Number(dims?.h) || 0,
    // 图内元数据来源('comfyui' 等): 卡片生成器徽章。与 records.source(看板
    // 「来源名」)是两回事 —— 名字刻意错开, 别合并。
    imgSrc: String(imgSrc || ''),
    unsafe,
  })
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
  /* 串行化(2026-10-04): buildDatasetInto 的写目标是**模块级**的 W, 而下面
   * readRecords / buildStats / buildSeriesIndex 都会 `await setImmediate` 让出
   * 事件循环 —— 两个 loadDataset 一旦并发, 后进来的会在前一个正写着的 half 上
   * 把 W 抢走, 结果先来的那次永远组装不完(启动遮罩就永远停在 100%)。
   * 以前不并发是因为读库/统计都是同步段; 分片让路把它变成了显性竞态。
   * 串行化: 后到的排队等前一个跑完再依次执行(不丢弃 —— 每次调用都是一次
   * 明确的重载请求, e2e 的"连续 reload 四次"要的就是这个)。 */
  const run = loadChain.then(
    () => doLoadDataset(dataFiles, onProgress),
    () => doLoadDataset(dataFiles, onProgress),
  )
  loadChain = run.then(() => {}, () => {})
  return run
}

/** 上一次 loadDataset 的尾巴; 只用来排队, 不看它的结果 */
let loadChain = Promise.resolve()

async function doLoadDataset(dataFiles, onProgress = () => {}) {
  const t0 = Date.now()
  /* ---- 双缓冲(2026-10-03) ----
   * 旧行为: 先清空 ds 再读库 —— 后台重载的十几秒里所有查询读到的都是空表,
   * 界面"闪空"。现在在 fresh 副本上构建, 全程不碰线上 ds:
   *   · 构建期间一切查询继续拿到旧数据(移动一张图触发的后台重载不再打断浏览);
   *   · 成功后 Object.assign 一次原子换血;
   *   · 失败则整份丢弃, 线上数据毫发无损(旧行为会把 ds 留在半空状态)。
   * tagPool 不再 clear: 旧 records 还引用着池内字符串, 且重复构建 intern 的
   * 是同样的值(池收敛), 清了只会让新旧记录的同名标签变成不同实例。 */
  const fresh = {
    records: [], byPath: new Map(), sourceNames: [...dataFiles.keys()],
    dbSync: null, unsafeCore: 0, unsafeEdge: 0,
    tagCounter: new Map(), seriesCounter: new Map(),
    seriesImgs: new Map(), seriesChars: new Map(),
    loaded: false, loadMs: 0, stats: null, loadSource: '',
    _srcStats: new Map(), _srcRecords: new Map(), _firstPath: new Map(),
  }
  W = fresh
  try {
    return await buildDatasetInto(fresh, dataFiles, onProgress, t0)
  } finally {
    W = ds   // 无论成败都把写目标拨回线上(fresh 已在成功路径 commit / 失败路径丢弃)
  }
}

/** 真正的构建过程: 写目标全程指向 fresh(调用方已把 W 指过去) */
async function buildDatasetInto(fresh, dataFiles, onProgress, t0) {
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
    fresh.dbSync = await syncSources(dataFiles, (p) => {
      onProgress({ phase: 'db', done: Math.round(totalBytes * 0.3), total: totalBytes, source: p.source, note: p.note })
    })

    onProgress({ phase: 'db-read', done: Math.round(totalBytes * 0.4), total: totalBytes })
    let last = 0
    // readRecords 现在是 async(每块让出事件循环, 后台重载不再卡死光箱翻页) —— 必须 await
    await readRecords((rec) => {
      pushRecord(rec.path, rec.tags, rec.source, { w: rec.px_w, h: rec.px_h }, rec.tagsSrc, rec.imgSrc)
      const n = W.records.length
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
    if (W.records.length) {
      fresh.loadSource = 'db'
    }
  } catch (e) {
    console.error('[dataset] SQLite 路径不可用, 回退解析 txt:', e?.message || e)
    W.records = []
    W.byPath = new Map()
    W.unsafeCore = 0
    W.unsafeEdge = 0
    fresh.dbSync = null
  }

  /* ---- 路线 B: 回退 —— 直接解析 txt ---- */
  if (!W.records.length) {
    fresh.loadSource = 'txt'
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
            records: W.records.length,
          })
        }
      })
    }
  }

  if (!W.records.length) {
    // 2026-10-03: 区分"真没登记"和"已登记但图还在打标队列里"(全新机器裸图
    // 场景) —— 后者是**暂态**, 不是错误文案该吓唬人的样子(旧文案让用户以为
    // 扫描失败"一张图都没入库")。反推消费完队列、tags 落库后, 下一轮 startLoad
    // 自然就绪。
    // 2026-10-17 (远端用户反馈"1000/1000 读完都进不去"): 队列全 done 却一条
    // 标签都没落库是**终态**不是暂态 —— "反推无结果"也标 done(防循环, 刻意
    // 不写 images), 全库都无结果时旧文案会让启动遮罩把它当暂态无限重试。
    // 2026-10-18 WD14 按需安装(v3): 无标签的图现在**会进数据集**(readRecords
    // 不再跳过), 所以这个分支只剩"扫描还没落第一批行"和"全部行都不可见"
    // 两种情况 —— 未装反推的全新库也能正常进看板, 不会再被队列卡死。
    let foldersN = 0, pendingN = 0, doneN = 0, failedN = 0
    try {
      const db = openDb()
      foldersN = Number(db.prepare('SELECT COUNT(*) AS n FROM folders').get()?.n || 0)
      const q = db.prepare(`
        SELECT
          SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM tag_queue`).get() || {}
      pendingN = Number(q.pending) || 0
      doneN = Number(q.done) || 0
      failedN = Number(q.failed) || 0
    } catch { /* 库还没建好, 按真没登记处理 */ }
    if (foldersN > 0 && pendingN + doneN + failedN > 0) {
      if (pendingN > 0) {
        // 文案保留"打标队列"字样 —— 启动遮罩靠它识别"暂态自动重试"
        throw new Error(`已登记 ${foldersN} 个文件夹, ${pendingN} 张图在打标队列里等待入库 —— 第一批记录落库后看板就会亮起来`)
      }
      // 终态: 队列跑完了却没产出。文案刻意避开"打标队列/等待反推"字样 ——
      // 启动遮罩靠这两个词识别"暂态自动重试", 命中了就会变成无限 reload 循环。
      throw new Error(
        `反推已经跑完(出标签 ${doneN + failedN} 张, 其中失败 ${failedN} 张), 但这批图一张标签都没能落进库 —— ` +
        `常见原因: 图片不是动漫风格(WD14 模型对真人照片基本没有输出)、图片损坏, 或反推环境有问题。` +
        `换一个含动漫图的文件夹试试; 若确认是动漫图, 请带着 logs/launch.log 反馈`
      )
    }
    throw new Error('没有可用的标签数据: 标签库还是空的, 也还没有登记任何图片文件夹')
  }

  /* ---- 来源清单: 以**登记表**为准, 不再看 tags_*.txt 的文件名 ----
     阶段 4 之前这里是 `[...dataFiles.keys()]`, 于是"有哪些来源"取决于
     data_files_dir 里躺着几个 txt —— txt 一归档, 来源筛选条立刻空掉,
     而库里的记录一条没少。现在来源的定义回到登记表(folders.as_source=1),
     txt 退化成一次性的导入介质。
     必须在**同步之后**取: 全新库是靠导入 txt 才建出 folders 行的(见 store.js
     的 importSource), 导入前查登记表会得到空列表。
     取不到(比如完全没建库、走的 txt 解析路线)就退回 dataFiles 的名字 ——
     这条兜底让"配置里有 txt 但 DB 不可用"的老路径仍然能用。 */
  try {
    const names = sourceNameList()
    if (names.length) fresh.sourceNames = names
  } catch { /* 保持 dataFiles 的名字 */ }

  onProgress({ phase: 'stats', done: totalBytes, total: totalBytes, records: W.records.length })

  // 角色库: 必须在 buildStats/buildSeriesIndex 之前就位(它们要查角色->系列)
  loadCharLib()

  // path -> record 索引(重复路径保留先出现的)
  W.byPath = new Map()
  for (let i = 0; i < W.records.length; i++) {
    const p = W.records[i].path
    if (!W.byPath.has(p)) W.byPath.set(p, i)
  }
  // 让一次事件循环: byPath 8.5 万条 Map.set 也要一两百 ms, 别跟后面的统计挤在一起
  await new Promise((r) => setImmediate(r))

  /* buildStats/buildSeriesIndex 是重建里最重的两段(85k 记录 × 每张几十个标签的
   * 全库同步循环, 实测 4.9~5.5s/次)。**分片让路**(每 5000 条让出一次事件循环,
   * 与 readRecords 同款): 让路期间查询走的是旧 ds(双缓冲, fresh 没换血前线上
   * 数据一致), 光箱/看板的 IPC 不再挂 5 秒 —— startLoad 由反推完成/重启/手动
   * 同步触发时, 用户界面只顿一下而不是卡死。 */
  await buildStats()

  onProgress({ phase: 'series', done: totalBytes, total: totalBytes, records: W.records.length })
  await buildSeriesIndex()

  W.loaded = true
  W.loadMs = Date.now() - t0
  W.stats = {
    // 「来源数」= 登记表里 as_source=1 的目录数。原来这里是 tags_*.txt 的文件个数 ——
    // txt 归档后它会变成 0, 而来源其实一个不少, 于是这个数字只是日志噪声。
    files: W.sourceNames.length,
    records: W.records.length,
    tags: W.tagCounter.size,
    series: W.seriesCounter.size,
    tagsInPool: tagPool.size,
    source: W.loadSource,           // 'db' | 'txt'
    db: dbReady(),
    ms: W.loadMs,
    charLib: charLibDiag(),
  }

  /* ---- 原子换血: 一次性覆盖线上 ds ----
   * fresh 的三个来源缓存 map 是全新的空表(旧缓存随旧记录一起作废)。 */
  Object.assign(ds, fresh)
  return ds.stats
}

async function buildStats() {
  const tc = new Map()
  const sc = new Map()
  let n = 0
  for (const r of W.records) {
    for (const t of r.tags) {
      tc.set(t, (tc.get(t) || 0) + 1)
      const s = seriesName(t)
      if (s) sc.set(s, (sc.get(s) || 0) + 1)
    }
    // 分片让路(见 loadDataset 调用点注释): 重建期间保住 IPC 响应
    if (++n % 5000 === 0) await new Promise((r2) => setImmediate(r2))
  }
  W.tagCounter = tc
  W.seriesCounter = sc
}

async function buildSeriesIndex() {
  const si = new Map()
  const sc = new Map()
  for (let idx = 0; idx < W.records.length; idx++) {
    for (const t of W.records[idx].tags) {
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
    // 分片让路(见 loadDataset 调用点注释): 重建期间保住 IPC 响应
    if ((idx + 1) % 5000 === 0) await new Promise((r) => setImmediate(r))
  }
  W.seriesImgs = si
  W.seriesChars = sc
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

/**
 * 「移动 = 改址」(2026-10-04): 图在磁盘上被搬走后, 库记录**原地**改 path/folder_id
 * 到新位置 —— 标签、反推状态、尺寸全跟着走; ingest 下次扫到新路径时发现记录已存在
 * 且指纹吻合(规则 1), 自然 skipped: 不产生"新图"、不重新入队反推。
 *
 * 为什么必须有这一步: 旧链路「移动 = 新图入库 + kick 全目录 ingest + onIngestDone
 * 无条件 startLoad」—— startLoad 是**整库数据集重建**, buildStats/buildSeriesIndex
 * 是两轮全库×全标签的同步 CPU 循环, 代价跟库大小成正比、与移动张数无关。主进程
 * 忙重建期间所有 IPC 排队, 光箱翻页查询(tag 面板)挂起转圈 —— 这就是"只移动一张图
 * 就卡几秒"的根源(2026-10-03 的 readRecords 让路只救了读库段, 救不了重建段)。
 * 改址后移动 = 一行 UPDATE + 内存两个键, 连 ingest 都不用跑。
 *
 * · fp(移动后对新路径 stat 的 {mtimeMs, size})带上一起写: 跨盘 copy 即便 mtime
 *   有变, 记录也与**当前磁盘状态**严格吻合, 规则 1 照样命中; 不传则保留原指纹。
 *   注意必须存 stat 的原始浮点值 —— ingest 磁盘侧比对的就是 st.mtimeMs 原值,
 *   取整反而会让规则 1 判不中。
 * · src_id 刻意不动: 它挂的是 txt 源身份, sourceNameList/来源筛选都按它算,
 *   改了会动摇看板的来源名单。图换了目录但"出身"不变, 显示名走旧来源, 可接受。
 * · tag_queue 的 pending 条目顺带改名 —— 不然反推消费时按旧 path 找文件必然 failed。
 *   (目标 path 恰好已在队列里会撞主键: 吞掉即可, 那条目本来就在。)
 * · 内存镜像只在**库提交成功后**同步, 只动 records[i].path 和 byPath 两个键 ——
 *   标签没变, stats/系列索引/字符串池全不用碰, byPath 的 O(1) 查询继续成立。
 *
 * @returns {{hit: boolean}} hit=false = 库里没有这条记录(库外图, 调用方走旧链路兜底)
 */
export function relocateRecord(from, to, folderId, fp = null) {
  const f = normalizeImagePath(from)
  const t = normalizeImagePath(to)
  if (!f || !t || f === t) return { hit: false }
  try {
    const db = openDb()
    const row = db.prepare('SELECT id FROM images WHERE path = ?').get(f)
    if (!row) return { hit: false }
    const fid = Number(folderId) || 0
    if (fp) {
      db.prepare('UPDATE images SET path = ?, folder_id = ?, mtime_ms = ?, size = ? WHERE id = ?')
        .run(t, fid, fp.mtimeMs, fp.size, Number(row.id))
    } else {
      db.prepare('UPDATE images SET path = ?, folder_id = ? WHERE id = ?').run(t, fid, Number(row.id))
    }
    try {
      db.prepare("UPDATE tag_queue SET path = ?, folder_id = ? WHERE path = ? AND state = 'pending'")
        .run(t, fid, f)
    } catch { /* 队列表未建 / 目标 path 已在队列撞主键: 都无妨 */ }
  } catch {
    // 目标 path 已有别的记录(唯一性冲突)等极端情况: 放弃改址, 调用方走旧链路兜底
    return { hit: false }
  }
  /* ---- 内存镜像(能走到这里 = 库已提交) ---- */
  const idx = ds.byPath.get(f)
  if (idx !== undefined && ds.records[idx] && ds.records[idx].path === f) {
    ds.byPath.delete(f)
    ds.records[idx].path = t
    ds.byPath.set(t, idx)
  }
  return { hit: true }
}

/** 取索引集合的最小值(替代 Python 的 min(set)) */
export function minIdx(set) {
  let m = Infinity
  for (const i of set) if (i < m) m = i
  return m === Infinity ? 0 : m
}
