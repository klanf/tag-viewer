/**
 * 角色库(只读) —— character_library.json 的运行时缓存
 * =====================================================
 * 由 scripts/build-char-lib.mjs 离线生成, 落在 dataDir 下。
 * 解决两件事:
 *   1. 无括号角色标签(higuchi_madoka 这种)此前完全不被识别 ——
 *      光箱显示「未识别出系列/角色」、导出时混进普通标签;
 *   2. 这些角色没法归到作品, 系列页缺图少分类。
 * 数据来源: 2026-10-21 起以 v1.0 词表 + Danbooru 归属为主(只收有系列的角色),
 * 再继承旧库里自动来源的条目; 手工层 custom_chars 已清空, 只作兼容保留。
 * non_char 是库里判定的道具/概念标签(剑、花、棋子), 用来挡住"括号自述"兜底。
 * 类别信息见库文件的 stats 字段。
 *
 * 重新生成: node scripts/build-char-lib.mjs
 * 换库后重启看板即可(dataset 在加载时会重建系列索引)。
 * 用户在系列页补的角色(user_meta.custom_chars)加载时合并, 保存后 reloadCharLib()
 * 热刷新 —— 不必等 build-char-lib 重跑或重启。
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'

const state = {
  loaded: false,
  file: '',
  error: '',
  ms: 0,
  chars: new Map(),      // tag(小写) -> series(小写) | null(角色但系列未知)
  copyright: new Set(),  // 裸系列标签(小写)
  artists: new Set(),
  stats: null,           // 生成时的统计(诊断用)
  manual: 0,             // 运行时从 custom_chars 合并进来的角色数
  overrides: new Set(),  // user_meta.char_series 里出现的 tag(用户判断, 优先级最高)
  hidden: new Set(),     // user_meta.hidden_chars: 屏蔽的角色 tag
  nonChar: new Set(),    // 库判定为道具/概念标签的 xxx_(yyy): 括号兜底也不许认成角色
}

/** 在 dataset 加载前调用一次; 缺文件不致命 —— 退回纯括号解析的老行为 */
export function loadCharLib() {
  if (state.loaded) return
  state.loaded = true
  state.file = dataFile('character_library.json')
  const t0 = Date.now()
  try {
    const d = JSON.parse(fs.readFileSync(state.file, 'utf8'))
    for (const [t, v] of Object.entries(d.chars || {})) {
      const series = v && v.series ? String(v.series).toLowerCase() : null
      state.chars.set(String(t).toLowerCase(), series)
    }
    for (const t of d.copyright || []) state.copyright.add(String(t).toLowerCase())
    for (const t of d.artists || []) state.artists.add(String(t).toLowerCase())
    for (const t of d.non_char || d.nonChar || []) state.nonChar.add(String(t).toLowerCase())
    state.stats = d.stats || null
  } catch (e) {
    state.error = e?.message || String(e)
    console.error('[charlib] 角色库加载失败(按无角色库运行):', state.error)
  }
  mergeUserMeta()
  state.ms = Date.now() - t0
}

/**
 * 合并用户层。直接读 user_meta.json 而不 import meta.js ——
 * meta.js -> dataset.js -> charlib.js 会成环。
 *
 * 优先级(高 -> 低):
 *   1. char_series: 用户明确纠正的归属 —— 连括号自述也能压过, 这是"说得清"的判断;
 *   2. 括号写法 name_(series): 标签自己写着系列;
 *   3. custom_chars: 用户补的角色 / 兜底映射。但括号 tag 不被它覆盖 ——
 *      用户会把同一角色同时挂到 `1st_costume` 这类服装分组, 无条件覆盖会把
 *      系列识别改成服装名。
 * hidden_chars 单独记一份: 归属仍可查, 但 seriesName() 会返回 null, 不参与系列索引。
 */
function mergeUserMeta() {
  state.manual = 0
  state.overrides.clear()
  state.hidden.clear()
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(dataFile('user_meta.json'), 'utf8'))
  } catch {
    return
  }
  const cc = meta?.custom_chars
  if (cc && typeof cc === 'object') {
    const applied = new Set()
    for (const [series, list] of Object.entries(cc)) {
      if (!Array.isArray(list) || !series) continue
      const s = String(series).toLowerCase()
      for (const raw of list) {
        const t = String(raw || '').trim().toLowerCase()
        if (!t) continue
        if (state.chars.has(t) && RE_CHAR.test(t)) continue
        state.chars.set(t, s)
        applied.add(t)
      }
    }
    state.manual = applied.size
  }
  /* 用户纠正最后应用 —— 必须压过括号与 custom_chars。
   * 建 charlib 时的空值约定: 空串条目已在 meta.js 里删掉, 这里不会见到。 */
  const ov = meta?.char_series
  if (ov && typeof ov === 'object') {
    for (const [rawTag, rawSeries] of Object.entries(ov)) {
      const t = String(rawTag || '').trim().toLowerCase()
      const s = String(rawSeries || '').trim().toLowerCase()
      if (!t || !s) continue
      state.chars.set(t, s)
      state.overrides.add(t)
    }
  }
  if (Array.isArray(meta?.hidden_chars)) {
    for (const raw of meta.hidden_chars) {
      const t = String(raw || '').trim().toLowerCase()
      if (t) state.hidden.add(t)
    }
  }
}

const RE_CHAR = /^.+_\(.+\)$/

/** 保存 custom_chars 后热刷新角色库(不动 dataset 索引, 系列页自己会合并) */
export function reloadCharLib() {
  state.loaded = false
  state.chars.clear()
  state.copyright.clear()
  state.artists.clear()
  state.stats = null
  state.error = ''
  state.manual = 0
  state.overrides.clear()
  state.hidden.clear()
  state.nonChar.clear()
  loadCharLib()
}

/** 诊断用快照(diag:stats 会带出去) */
export function charLibDiag() {
  return {
    file: state.file,
    loaded: state.loaded,
    error: state.error,
    ms: state.ms,
    chars: state.chars.size,
    copyright: state.copyright.size,
    artists: state.artists.size,
    manual_applied: state.manual,
    overrides: state.overrides.size,
    hidden: state.hidden.size,
    non_char: state.nonChar.size,
    stats: state.stats,
  }
}

/** 是否库内角色(无括号写法靠这里识别) */
export function libIsChar(tag) {
  return state.chars.has(String(tag).toLowerCase())
}

/**
 * 全库角色按系列分组 —— 系列页用它在「显示无本地图的角色」开关下
 * 补出库里有、但本地还没出过图的角色(2026-10-21 取代 custom_chars 的展示作用)。
 * @returns {Map<string, string[]>} series(小写) -> tag[](小写)
 */
export function libCharsBySeries() {
  const out = new Map()
  for (const [t, s] of state.chars) {
    if (!s) continue
    let arr = out.get(s)
    if (!arr) { arr = []; out.set(s, arr) }
    arr.push(t)
  }
  return out
}

/**
 * 角色所属系列。
 * @returns {string|null|undefined} 系列 | 是角色但系列未知(null) | 不是角色(undefined)
 */
export function libCharSeries(tag) {
  const k = String(tag).toLowerCase()
  return state.chars.has(k) ? (state.chars.get(k) || null) : undefined
}

/** 是否裸系列标签(genshin_impact 这种不带角色名的 copyright 写法) */
export function libIsCopyright(tag) {
  return state.copyright.has(String(tag).toLowerCase())
}

/** 用户纠正的归属; undefined = 没纠正过(调用方继续走括号/角色库) */
export function libOverrideSeries(tag) {
  const k = String(tag).toLowerCase()
  return state.overrides.has(k) ? (state.chars.get(k) || undefined) : undefined
}

/** 是否被用户屏蔽(推错的角色) */
export function libIsHidden(tag) {
  return state.hidden.has(String(tag).toLowerCase())
}

/** 库里判定的"不是角色"标签(道具/概念/异常写法) —— 括号兜底也不能放行 */
export function libIsNonChar(tag) {
  return state.nonChar.has(String(tag).toLowerCase())
}
