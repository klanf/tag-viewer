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
import { blacklistMatcher, isBlockedFast, loadReplaceRules, loadReplaceRulesGroup, replaceTag, loadBgConfig, hasBgTagFast, viewTagMatcher, isViewFast } from './rules.js'
import { safetyExportStripper } from './safety.js'
import { exportSegSort } from './tagcats.js'

/**
 * 比较两个标签"是不是同一个"用的归一化键: 忽略大小写, 且把下划线/空格视作等价。
 * 库里存的是 best_quality, 用户在追加框里手打成 best quality, 其实是同一个标签。
 */
const tagKey = (t) => t.toLowerCase().replace(/[\s_]+/g, '_')

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
  // 段位模式(2026-10-16): 过滤 画师/角色/系列/meta, 人数排最前, 通用按大类归堆。
  // 做在**替换/补背景/追加之后**(替换后的新词按新文本分类, 天然一致), 空格转换之前。
  const segMode = raw.seg_mode === '1' || raw.seg_mode === true
  /* 追加标签 —— **UI 已于 2026-10-04 移除**(看板筛选区与预设编辑页的输入框都删了,
   * 用户判断"有替换规则就够了")。这段解析**故意留着**: 老预设文件里可能已经存过
   * append 字段, 直接删解析会让那些预设的追加行为**静默消失**、用户毫无察觉。
   * 现在没有 UI 能再产生新 append, 等确认没有老预设还在用之后可以整段删。
   * 原语义: 逗号分隔可多个, 每行**第一个 tag 前**插入; 已有同名 tag 的行不重复插;
   * 放在剔除/替换/补背景**之后**做, 保证追加的 tag 自己不会被黑名单/安全模式误伤。 */
  const appendRaw = typeof raw.append === 'string' ? raw.append : ''
  const appendTags = appendRaw.split(',').map((t) => t.trim()).filter(Boolean)

  const records = scopeRecords(p.srcSet, p.favs)
  const results = searchCached(
    records, p.searchTags, p.mode, p.match,
    p.excludeTags, p.excludeMatch, p.excludeChar,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join('|') : '',
  )

  const bl = useBl ? blacklistMatcher() : null
  // 替换规则组(2026-10-04): raw.replace_set 指定用哪一套, 空 = 当前默认组。
  // 传 replace=0 整体关掉(与旧行为一致)。见 rules.js replaceSets()。
  const replRules = useRp ? loadReplaceRulesGroup(String(raw.replace_set || '')) : []
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
  let appendAdded = 0
  let segStripped = 0

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

    if (appendTags.length) {
      // 去重口径: 跟"已有的标签"比 + 追加串内部自己也不重复。
      // 比的是归一化键(忽略大小写 / 下划线=空格), 所以 best_quality 与 best quality、
      // Masterpiece 与 masterpiece 都算同一个, 不会再插出一条肉眼重复的。
      const seen = new Set(tags.map(tagKey))
      const add = []
      for (const t of appendTags) {
        const k = tagKey(t)
        if (seen.has(k)) continue
        seen.add(k)
        add.push(t)
      }
      if (add.length) { appendAdded += add.length; tags = [...add, ...tags] }
    }

    if (segMode) {
      const before = tags.length
      tags = exportSegSort(tags)
      segStripped += before - tags.length
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
    appendAdded,
    segStripped,
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

/**
 * 购物车/角色表导出(2026-10-04 起支持替换规则组)
 * ------------------------------------------------------------------
 * 之前这里只做 escWildcard(括号转义 + 下划线转空格), 一点替换都不走 ——
 * 用户"不同导出不同方案"的需求里就包括角色表(比如把角色名批量改成另一种
 * 写法、或给每个角色加限定词)。现在:
 *   replace=0/'0'  整体关掉(默认开, 与图集导出口径一致)
 *   replace_set   选哪一套规则, 空 = 当前默认组
 * 替换对**主标签与附加标签都生效**, 且在归一化去重**之前**做 ——
 * 这样"替换后与原标签同名"的组合不会被去重吃掉(去重按 tagKey 归一)。
 */
export function buildCartExport(tags, { spaces = true, replace = true, replaceSet = '' } = {}) {
  const useRp = !(replace === false || replace === '0')
  const rules = useRp ? loadReplaceRulesGroup(String(replaceSet || '')) : []
  let replaced = 0
  const entries = (tags || []).map((t) =>
    (t && typeof t === 'object') ? t : { tag: t, extra: [] })
  const lines = entries.map((e) => {
    const extras = Array.isArray(e.extra) ? e.extra.filter((x) => String(x || '').trim()) : []
    /* 规则把一个标签变成多个时, 在**同一行内逗号展开** —— wildcard 的原生语义就是
     * "一行是一个搜索式, 逗号=同时含"(1boy -> 1boy, solo 应写成 `1boy, solo`)。
     * 摊成多行会变成两个独立搜索式, 语义不同, 不能这么干。
     * ⚠️ 命中判定不能看"结果条数": replaceTag 未命中时也返回长度 1 的 [tag],
     * 命中单值替换(如 frieren -> frieren_x)也是长度 1 —— 只有**内容变了或变多了**
     * 才算命中。这条判错会让"替换条数"统计永远是 0 或虚高。 */
    const replaced_ = rules.length ? replaceTag(e.tag, rules) : [e.tag]
    if (rules.length && (replaced_.length > 1 || replaced_[0] !== e.tag)) replaced++
    return [[...replaced_.map((x) => escWildcard(x, spaces)),
      ...extras.map((x) => escWildcard(x, spaces))].join(', ')]
  }).flat()
  return {
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
    replaced,
    suggestedName: 'roles_cart.txt',
  }
}
