/**
 * 标签分类器 —— 官方段位 + 韦林大类 + 规则兜底
 * ================================================
 * 需求来源(2026-10-16, 用户拍板的完整方案):
 *   · 展示按 Anima 官方推荐段位: 人数 → 角色 → 系列 → 画师 → 通用(细分) → meta → 其他
 *   · 通用细分用韦林库的人工分类(服饰/表情动作/画面/环境/场景/物品/镜头/汉服/魔法系/人物)
 *   · 裸名角色(没带括号的角色名)靠 WD14 词表反向建索引补系列归属
 *   · 分类是「展示/导出时热算 + 入库时排序」用, **不往 images 行里写分类字段**
 *
 * 数据源三级(命中即止, 越前越可信):
 *   1. 规则硬判: 人数(1girl/solo)、画师(@开头)、括号角色 xxx_(series)
 *   2. 韦林分类库: 3,628 条人工整理(经 translate.js 同款目录发现机制定位)
 *   3. WD14 词表: category=4 的 3,720 个角色 tag → 裸名→系列反向索引 + 系列名集合
 *   4. 关键词规则兜底 → 都没接住 = other
 *
 * ⚠️ 依赖纪律: 本模块会被 store.js import, **不能反向 import dataset/store**
 * (它们互相引用会成环)。NON_SERIES_GROUPS 在此复制一份, 与 store.js/dataset.js
 * 的副本由测试把守一致性。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataFile } from './workspace.js'
import { PROJECT_ROOT } from './paths.js'
import { resolveWeiLinDirs } from './translate.js'

/* ------------------------------------------------------------ 段位定义 */

/** 展示段位(顺序即 rank): 数值越小越靠前 */
export const SEGS = ['count', 'char', 'series', 'artist', 'general', 'meta', 'other']
const SEG_RANK = Object.fromEntries(SEGS.map((s, i) => [s, i]))

/** 通用细分的展示顺序 —— 韦林组名(或规则子类名) → 次序 */
const SUB_ORDER = [
  '人物', '服饰', '汉服', '表情动作', '物品', '场景', '环境', '画面', '镜头', '魔法系',
]
const SUB_RANK = new Map(SUB_ORDER.map((n, i) => [n, i]))

/**
 * danbooru 分类组名排除集合 —— 与 dataset.js 的 NON_SERIES_GROUPS / store.js 的
 * NON_SERIES_GROUPS_REF 保持同一份内容(不能 import, 会成环)。
 * `xxx_(general)` 这种"括号里是分类组名"的**不是**角色 tag(如 smile_(medium))。
 */
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

/* ------------------------------------------------------------ 词表规则 */

/** 人数段: 1girl / 2girls / 3boys / 6+girls / 1other / solo / multiple_girls */
const RE_COUNT = /^(\d{1,3}\+?(girls?|boys?|others?)|solo|multiple_(girls|boys|others?))$/

/** meta 段: 画质/年份/分辨率/分级/来源水印类 —— 出图管线自己控制, 展示时单独归堆 */
const RE_META = /^year[_ ]?\d+s?(_\(style\))?|^(highres|absurdres|lowres|normal_?(quality|res)|masterpiece|best_quality|worst_quality|great_quality|good_quality|score_\d+|general|sensitive|questionable|explicit|newest|oldest|commentary(_request)?|bad_id|bad_twitter_id|bad_pixiv_id|ai_generated|generated|4k|8k|16k)$/

/** 规则兜底的子类判定(顺序即优先级: 越具体的越先) */
const RE_RULES = [
  ["镜头", /(upper[_ ]body|lower[_ ]body|close-?up|portrait|from[_ ](above|behind|below|side)|wide[_ ]shot|pov|dutch[_ ]angle|cowboy[_ ]shot|full[_ ]?body|cropped|head[_ ]rest|fisheye|selfie)/],
  ["画面", /(background|monochrome|greyscale|grayscale|lighting|light[_ ]rays|lens|chromatic|bokeh|depth[_ ]of[_ ]field|contrast|colorful|pastel|glow(ing)?|backlighting|vignette|film_?grain|(_|^)halo$|mosaic|bar[_ ]censor|censor|uncensor|^centered$|(_|^)heart$|symbol)/],
  ["服饰", /(uniform|dress|skirt|shirt|pants|shorts|sock|thighhighs|glove|hat|cap|shoe|boot|footwear|jacket|scarf|necktie|apron|bikini|swimsuit|_bra$|^bra$|panties|panty$|costume|cloak|cape|armor|hood|sleeve|ribbon|lace|frills|jewel|earring|glasses|mask|belt|button|pocket|kimono|yukata|leotard|poncho|cardigan|sweater|vest|necklace|choker|hairband|headband|headphones|earphones|tiara|crown|veil|underwear|bare[_ ]shoulders|off[_ ]shoulder|open[_ ]clothes|clothes[_ ](lift|pull|grab|writing|around|off)|detached[_ ]collar|see-?through|(_|^)bow$|topless|bottomless|(_|^)nude($|_)|only_)/],
  ["人物", /(^|_)(thighs?|feet|toes?|stomach|legs?|soles|cleavage|anus|nipples?|clitoris|cleft[_ ]of[_ ]venus|areolae|navel|pussy|crotch|groin|buttocks|hips?|shoulders?|elbow|wrist|heel|ankle|torso|ribs?|spine|armpits?|cheeks?|chin|forehead|neck|back|chest|(_|^)butt($|_)|(_|^)abs$)|(_|^)hair($|_)|(_|^)eyes?$|bangs|ponytail|twintail|braid|ahoge|breast|penis|pussy|(_|^)ass($|_)|skin|(_|^)ears?$|(_|^)tail$|(_|^)horn|(_|^)wing|fang|muscle|armpit|eyebrow|eyelash|mole|freckle|blonde|brunette|(_|^)white_hair|(_|^)black_hair|(_|^)brown_hair|(_|^)blue_eyes|(_|^)red_eyes|(_|^)green_eyes|(_|^)purple_eyes|(_|^)golden_eyes|heterochromia|collarbone|erection|lactation|virtual[_ ]youtuber|(_|^)elf$|(_|^)demon(_|$)|(_|^)angel$/],
  ["表情动作", /(smil|laugh|cry|tears|angry|blush|surprised|shocked|sitting|standing|lying|kneel|crouch|holding|looking|walking|running|waving|(_|^)arm|[_ ]hands$|^hands|lean|pout|wink|open_mouth|closed_mouth|shushing|salute|clap|peace_?sign|v_?shaped|^(sex|vaginal|anal|oral|blowjob|handjob|footjob|paizuri|missionary|doggy[_ ]style|girl[_ ]on[_ ]top|boy[_ ]on[_ ]top|reverse[_ ]cowboy|hetero|yaoi|yuri|futanari|group[_ ]sex|threesome|gangbang|cum|semen|fellatio|cunnilingus|intercourse|riding|mounting)$|(_|^)sex($|_)|(_|^)job$)/],
  ["物品", /(phone|book|bag|umbrella|cup|bottle|food|cake|gift|box|chair|table|bed|desk|car|bicycle|motorcycle|sword|gun|knife|staff|wand|tablet|laptop|camera|piano|guitar|violin|teddy|doll|pillow|blanket|towel|mirror|clock|lamp|candle|teapot|tray)/],
  ["场景", /(classroom|outdoors|indoors|beach|city|street|forest|mountain|river|lake|sea|ocean|(_|^)room$|^room|kitchen|school|library|shrine|temple|park|rooftop|balcony|bridge|station|cafe|shop|market|field|garden|pool|onsen|bath)/],
  ["环境", /(^sky|[_ ]sky$|night|daytime|sunset|sunrise|cloud|rain|snow|wind|fire|water|light$|dark$|star|moon|sun$|weather|summer|winter|autumn|spring|galaxy|nebula|aurora)/],
]

/* ------------------------------------------------------------ 状态与数据源 */

const state = {
  loaded: false,
  /** 归一化 tag -> 韦林组名(人物/服饰/...) */
  weilin: new Map(),
  /** 归一化完整角色名集合(来自 WD14 词表 category=4) */
  charSet: new Set(),
  /** 归一化系列名集合(角色括号里的内容) */
  seriesSet: new Set(),
  /** 裸角色名 -> 系列名集合(用户拍板: 裸名角色也要能归段) */
  bareToSeries: new Map(),
  info: { weilin: 0, chars: 0, series: 0, bare: 0, source: 'none' },
}

/** 归一化: 小写。韦林库混用空格/下划线, 库里存的是下划线 —— 两种变体都查。 */
function norm(t) { return String(t || '').trim().toLowerCase() }
const variants = (t) => {
  const s = norm(t)
  if (!s) return []
  const a = s.includes('_') ? s.replace(/_/g, ' ') : s.replace(/ /g, '_')
  return a === s ? [s] : [s, a]
}

/**
 * 加载分类数据源(同步, 幂等, 进程内一次)。
 * 必须同步: classify 在入库/展示路径上是纯同步调用, 异步装载会造成
 * "前几批用空表分类"的竞态(2026-10-16 test:ingest 实测踩过)。SQLite 只读
 * + CSV 解析都是本地快读(实测几十 ms), 阻塞可接受。失败不抛 ——
 * 分类是增强, 不能因为它挂掉主流程, 数据源缺哪个就靠下一级兜底。
 * @param {{weilinDirs?: string[], csvPath?: string}} [opts] 测试可注入; 缺省自动发现
 */
export function loadCats(opts = {}) {
  if (state.loaded) return state.info
  state.loaded = true   // 先置位防递归/重入; 内部失败信息记进 info
  try { loadWeiLinCats(opts.weilinDirs) } catch (e) { state.info.weilinError = e.message }
  try { loadWd14Chars(opts.csvPath) } catch (e) { state.info.csvError = e.message }
  state.info.source = state.info.weilin || state.info.chars ? 'weilin+csv' : 'rules'
  return state.info
}

/** 韦林分类库: tag_tags(text) → tag_subgroups → tag_groups(组名) */
function loadWeiLinCats(dirsOverride) {
  // resolveWeiLinDirs 返回 {dirs, source, ...} 对象, 不是数组(2026-10-16 踩)
  const dirs = dirsOverride || (resolveWeiLinDirs(null)?.dirs) || []
  const map = state.weilin
  for (const dir of dirs) {
    const dbPath = path.join(dir, 'userdatas_zh_CN_tags.db')
    if (!fs.existsSync(dbPath)) continue
    let db
    try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { continue }
    try {
      const rows = db.prepare(`
        SELECT t.text AS text, g.name AS grp
        FROM tag_tags t
        JOIN tag_subgroups s ON s.id_index = t.subgroup_id
        JOIN tag_groups g ON g.id_index = s.group_id
      `).all()
      for (const r of rows) {
        if (!r.text || !r.grp) continue
        for (const v of variants(r.text)) if (!map.has(v)) map.set(v, r.grp)
      }
    } finally { try { db.close() } catch { /* 只读连接, 关不掉就算了 */ } }
  }
  state.info.weilin = map.size
}

/**
 * WD14 词表: category=4 是角色列。
 *   · charSet  <- 完整角色名(带括号)
 *   · seriesSet<- 括号里的系列名
 *   · bareToSeries <- 裸角色名 -> 系列集合(用户点名的"裸名角色"问题就在这解)
 */
function loadWd14Chars(csvPathOverride) {
  const cands = [
    csvPathOverride,
    process.env.TV_WD14_CSV || '',
    dataFile(path.join('models', 'wd-pixai-tagger-v0.9.csv')),
    dataFile(path.join('models', 'selected_tags.csv')),
    path.join(PROJECT_ROOT, 'data', 'models', 'wd-pixai-tagger-v0.9.csv'),
    path.join(PROJECT_ROOT, 'models', 'selected_tags.csv'),
  ].filter(Boolean)
  const fp = cands.find((p) => fs.existsSync(p))
  if (!fp) return
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/)
  const generalSet = new Set()   // 词表里的通用 tag —— 用来挡"角色括号内容是普通词"的污染
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    if (c.length < 3) continue
    const name = c[1].trim()
    if (!name) continue
    if (c[2].trim() === '0') generalSet.add(norm(name))
  }
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    if (c.length < 3) continue
    const name = c[1].trim()
    if (!name || c[2].trim() !== '4') continue
    const k = norm(name)
    state.charSet.add(k)
    const m = /^(.+)_\((.+)\)$/.exec(k)
    if (m) {
      const inner = m[2]
      /* 关键护栏(2026-10-16 实测发现): 括号内容本身是词表通用 tag 的不算系列
       * —— `xxx_(school_uniform)` 这类"同一角色的服装变体"在词表里一大把,
       * 不挡的话 school_uniform 会被当成一个"系列"。 */
      if (!NON_SERIES_GROUPS.has(inner) && !generalSet.has(inner)) {
        state.seriesSet.add(inner)
        const bare = m[1]
        if (!state.bareToSeries.has(bare)) state.bareToSeries.set(bare, new Set())
        state.bareToSeries.get(bare).add(inner)
      }
    }
  }
  state.info.chars = state.charSet.size
  state.info.series = state.seriesSet.size
  state.info.bare = state.bareToSeries.size
}

/* ------------------------------------------------------------ 分类 */

/**
 * 分类一个标签。
 * @returns {{seg: 'count'|'char'|'series'|'artist'|'general'|'meta'|'other', sub: string, series: string}}
 *   sub = 通用细分的组名(仅 general 有); series = 命中的系列名(仅 char 有, 可能空=多系列歧义)
 */
export function classify(tag) {
  if (!state.loaded) loadCats()   // 兜底: 直接调 classify 的路径也要有数据源
  const t = String(tag || '').trim()
  if (!t) return { seg: 'other', sub: '', series: '' }
  const k = norm(t)

  if (RE_COUNT.test(k)) return { seg: 'count', sub: '', series: '' }
  if (k.startsWith('@')) return { seg: 'artist', sub: '', series: '' }

  // 括号角色: xxx_(series) —— 括号里是分类组名的除外
  const m = /^(.+)_\((.+)\)$/.exec(k)
  if (m && !NON_SERIES_GROUPS.has(m[2])) {
    return { seg: 'char', sub: '', series: m[2] }
  }

  // 系列名本体(WD14 角色括号内容, 已挡掉普通词) —— 必须排在韦林**之前**:
  // 韦林库里部分系列名(genshin impact 等)被归在画面/场景等组, 语义上它们是系列
  if (state.seriesSet.has(k)) return { seg: 'series', sub: '', series: '' }

  // 韦林人工分类(两个变体都试)
  for (const v of variants(t)) {
    const g = state.weilin.get(v)
    if (g) return { seg: 'general', sub: g, series: '' }
  }

  // WD14 词表里的裸名角色(词表里有一批不带括号的 category=4 条目, 如 frieren)
  if (state.charSet.has(k)) return { seg: 'char', sub: '', series: '' }
  // 裸名角色(括号角色反推出来的裸名): 一个裸名只对应一个系列时连系列一起给出
  if (state.bareToSeries.has(k)) {
    const sSet = state.bareToSeries.get(k)
    const series = sSet.size === 1 ? [...sSet][0] : ''
    return { seg: 'char', sub: '', series }
  }

  if (RE_META.test(k)) return { seg: 'meta', sub: '', series: '' }

  // 规则兜底
  for (const [sub, re] of RE_RULES) {
    if (re.test(k)) return { seg: 'general', sub, series: '' }
  }
  return { seg: 'other', sub: '', series: '' }
}

/** 一个 tag 的完整排序键: [段位, 子类序(仅 general), 原顺序] —— 数值越小越靠前 */
function sortKeyOf(tag) {
  const c = classify(tag)
  if (c.seg === 'general') return [SEG_RANK.general, SUB_RANK.get(c.sub) ?? SUB_ORDER.length]
  return [SEG_RANK[c.seg], 0]
}

/**
 * 按段位重排(稳定: 同段位内保持原相对顺序 —— 比如韦林没收录但规则归了同一类的,
 * 或置信度顺序, 都不折腾)。
 * @param {string[]} tags
 */
export function sortTags(tags) {
  if (!Array.isArray(tags) || tags.length < 2) return tags
  const keyed = tags.map((t, i) => ({ t, k: sortKeyOf(t), i }))
  let sorted = false
  keyed.sort((a, b) => (a.k[0] !== b.k[0] ? a.k[0] - b.k[0] : a.k[1] - b.k[1]) || a.i - b.i)
  for (let i = 0; i < keyed.length; i++) {
    if (keyed[i].t !== tags[i]) { sorted = true; break }
  }
  return sorted ? keyed.map((x) => x.t) : tags
}

/** 逗号串进出(入库前重排的便捷入口) —— 顺序没变时原串返回, 保留原始字节形态 */
export function sortTagString(s) {
  const str = String(s || '')
  if (!str.trim()) return str
  const tags = str.split(',').map((x) => x.trim()).filter(Boolean)
  if (tags.length < 2) return str
  const sorted = sortTags(tags)
  return sorted === tags ? str : sorted.join(',')
}

/**
 * 导出段位模式(2026-10-16, 用户拍板): TagViewer 只出「内容 tag」。
 *   过滤: 画师@ + 角色 + 系列 + meta(画质在提取层本来就被滤, 天然没有)
 *   保留: 人数(1girl/solo)排最前 -> 通用按大类归堆 -> 未收录进 other 照常导出
 * 只滤顺序不变集合的语义在 sortTags 里(稳定排序, 同段内保持原相对顺序)。
 * @param {string[]} tags
 */
export function exportSegSort(tags) {
  if (!Array.isArray(tags) || !tags.length) return tags
  const kept = tags.filter((t) => {
    const seg = classify(t).seg
    return seg !== 'artist' && seg !== 'char' && seg !== 'series' && seg !== 'meta'
  })
  return sortTags(kept)
}

/** 字典行的 cat 值: seg 或 seg:sub(通用细分) —— 展示端拿它直接归堆 */
export function catOf(tag) {
  const c = classify(tag)
  return c.sub ? `${c.seg}:${c.sub}` : c.seg
}

/** 展示端消费用的整表: { tag -> cat } */
export function catMap() {
  const out = {}
  for (const [k] of state.weilin) out[k] = catOf(k)
  for (const k of state.charSet) if (!(k in out)) out[k] = catOf(k)
  return out
}

export function catsInfo() { return { ...state.info, loaded: state.loaded } }

/** 测试/特殊环境注入数据源(绕过文件系统) */
export function injectForTest({ weilin, chars, series, bare } = {}) {
  if (weilin) { state.weilin = weilin; state.info.weilin = weilin.size }
  if (chars) { state.charSet = chars; state.info.chars = chars.size }
  if (series) { state.seriesSet = series; state.info.series = series.size }
  if (bare) { state.bareToSeries = bare; state.info.bare = bare.size }
  state.loaded = true
}

/* ------------------------------------------------------- 杂项 */

/** 给日志/设置页看的一句话概况 */
export function describe() {
  const i = state.info
  return `韦林分类 ${i.weilin} 条 · WD14角色 ${i.chars} · 系列 ${i.series} · 裸名索引 ${i.bare} · 来源=${i.source}`
}
