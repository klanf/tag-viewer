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
import { blacklistMatcher, isBlockedFast, loadReplaceRules, replaceTag, loadBgConfig, hasBgTagFast } from './rules.js'

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

  const lines = []
  let blockedCount = 0
  let replacedCount = 0
  let bgAdded = 0
  let strippedCount = 0

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
    ms: Date.now() - t0,
    suggestedName: `筛选_${nameCore}.txt`,
  }
}

/** 购物车导出: 角色标签 -> wildcard 格式(转义括号、下划线转空格) */
export function buildCartExport(tags, { spaces = true } = {}) {
  const lines = tags.map((t) => {
    let s = t.replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    if (spaces) s = s.replace(/_/g, ' ')
    return s
  })
  return {
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
    suggestedName: 'roles_cart.txt',
  }
}
