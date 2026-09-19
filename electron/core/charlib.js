/**
 * 角色库(只读) —— character_library.json 的运行时缓存
 * =====================================================
 * 由 scripts/build-char-lib.mjs 离线生成, 落在 dataDir 下。
 * 解决两件事:
 *   1. 无括号角色标签(higuchi_madoka 这种)此前完全不被识别 ——
 *      光箱显示「未识别出系列/角色」、导出时混进普通标签;
 *   2. 这些角色没法归到作品, 系列页缺图少分类。
 * 数据来源: 此前的 danbooru related_tag 推导(610) + user_meta 手动角色
 * + 括号写法的统一收录。类别信息见库文件的 stats 字段。
 *
 * 重新生成: node scripts/build-char-lib.mjs [--api 联网补漏]
 * 换库后重启看板即可(dataset 在加载时会重建系列索引)。
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
    state.stats = d.stats || null
  } catch (e) {
    state.error = e?.message || String(e)
    console.error('[charlib] 角色库加载失败(按无角色库运行):', state.error)
  }
  state.ms = Date.now() - t0
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
    stats: state.stats,
  }
}

/** 是否库内角色(无括号写法靠这里识别) */
export function libIsChar(tag) {
  return state.chars.has(String(tag).toLowerCase())
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
