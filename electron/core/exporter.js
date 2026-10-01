/**
 * 导出筛选结果 -> 纯文本
 * =======================
 * 与原 Python 版 _api/export 完全同序:
 *   筛选 -> 黑名单剔除 -> 替换规则 -> 补背景标签 -> 下划线转空格 -> 拼接
 *
 * 差异: 原版把结果当 HTTP 附件下载, 落盘位置由浏览器决定;
 * 这里改成 Electron 的原生「另存为」对话框, 用户能自己挑目录和文件名
 * (顺带解决了浏览器下载目录里堆一堆"筛选结果(1).txt"的问题)。
 */
import { recordsFor, frozenKey, isCharacterTag, isCopyrightTag } from './dataset.js'
import { parseQuery, scopeRecords, searchCached } from './search.js'
import { blacklistMatcher, isBlockedFast, loadReplaceRules, replaceTag, loadBgConfig, hasBgTagFast, viewTagMatcher, isViewFast } from './rules.js'
import { safetyExportStripper } from './safety.js'

export function buildExport(raw = {}) {
  const t0 = Date.now()
  const p = parseQuery(raw)
  const withPath = raw.with_path === '1' || raw.with_path === true
  const spaces = !(raw.spaces === '0' || raw.spaces === false)
  const useBl = !(raw.blacklist === '0' || raw.blacklist === false)
  const useRp = !(raw.replace === '0' || raw.replace === false)
  const useBg = !(raw.bg === '0' || raw.bg === false)
  // 剔除角色/系列标签(含无括号角色, 由角色库识别); 默认关闭, 与旧行为一致
  const stripChar = raw.strip_char === '1' || raw.strip_char === true
  // 剔除视角/机位标签(词表: data/export_view_tags.txt, 种子来自随机机位交接文档); 默认关闭
  const stripView = raw.strip_view === '1' || raw.strip_view === true
  // 只导出安全模式的标签 —— 逐行剔除敏感tag(口径跟随 safety.json 的档位); 默认关闭
  const safeOnly = raw.safe_only === '1' || raw.safe_only === true

  const records = scopeRecords(p.srcSet, p.favs)
  const results = searchCached(
    records, p.searchTags, p.mode, p.match,
    p.excludeTags, p.excludeMatch, p.excludeChar,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join('|') : '',
  )

  const bl = useBl ? blacklistMatcher() : null
  const replRules = useRp ? loadReplaceRules() : []
  let bg = null
  if (useBg) {
    const cfg = loadBgConfig()
    if (cfg.append.length) bg = cfg
  }
  const vm = stripView ? viewTagMatcher() : null
  const safeHit = safeOnly ? safetyExportStripper() : null

  const lines = []
  let blockedCount = 0
  let replacedCount = 0
  let bgAdded = 0
  let strippedCount = 0
  let viewStripped = 0
  let safeStripped = 0

  for (const r of results) {
    let tags = r.tags

    if (stripChar) {
      const kept = []
      for (const t of tags) {
        if (isCharacterTag(t) || isCopyrightTag(t)) strippedCount++
        else kept.push(t)
      }
      tags = kept
    }

    if (vm) {
      const kept = []
      for (const t of tags) {
        if (isViewFast(t, vm)) viewStripped++
        else kept.push(t)
      }
      tags = kept
    }

    if (safeHit) {
      const kept = []
      for (const t of tags) {
        if (safeHit(t)) safeStripped++
        else kept.push(t)
      }
      tags = kept
    }

    if (bl) {
      const kept = []
      for (const t of tags) {
        if (isBlockedFast(t, bl)) blockedCount++
        else kept.push(t)
      }
      tags = kept
    }

    if (replRules.length) {
      const next = []
      const seen = new Set()
      for (const t of tags) {
        for (const nt of replaceTag(t, replRules)) {
          if (nt !== t) replacedCount++
          if (!seen.has(nt)) { seen.add(nt); next.push(nt) }
        }
      }
      tags = next
    }

    if (bg && !hasBgTagFast(tags, bg)) {
      for (const b of bg.append) {
        if (!tags.includes(b)) { tags.push(b); bgAdded++ }
      }
    }

    if (spaces) tags = tags.map((t) => t.replace(/_/g, ' '))
    const s = tags.join(', ')
    lines.push(withPath ? `${r.path}: ${s}` : s)
  }

  const nameCore = p.searchTags.length
    ? p.searchTags.map((t) => t.replace(/[<>:"/\\|?*]/g, '_')).join('+')
    : 'all'

  return {
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
    blocked: blockedCount,
    replaced: replacedCount,
    bgAdded,
    stripped: strippedCount,
    viewStripped,
    safeStripped,
    ms: Date.now() - t0,
    suggestedName: `筛选_${nameCore}.txt`,
  }
}

/**
 * 购物车导出: 角色标签 -> wildcard 格式(转义括号、下划线转空格)。
 *
 * 2026-10-01 支持**条目级附加标签**: 条目可以是字符串, 也可以是
 * { tag, extra: ['closed_eyes', ...] } —— extra 逐个拼在同一行后面
 * (comma 分隔), 这样「哥伦比亚」导出就是 `columbina (genshin impact), closed eyes`。
 * 放同一行而不是单独一行, 是因为 wildcard 是**整行随机抽一条**, 单独一行会抽到
 * 「没有角色只有 closed eyes」的空 prompt。
 */
function escWildcard(t, spaces) {
  let s = String(t).replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  if (spaces) s = s.replace(/_/g, ' ')
  return s
}

export function buildCartExport(tags, { spaces = true } = {}) {
  const entries = (tags || []).map((t) =>
    (t && typeof t === 'object') ? t : { tag: t, extra: [] })
  const lines = entries.map((e) => {
    const extras = Array.isArray(e.extra) ? e.extra.filter((x) => String(x || '').trim()) : []
    return [escWildcard(e.tag, spaces),
      ...extras.map((x) => escWildcard(x, spaces))].join(', ')
  })
  return {
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
    suggestedName: 'roles_cart.txt',
  }
}
