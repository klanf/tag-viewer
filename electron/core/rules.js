/**
 * 导出规则三件套: 黑名单 / 替换规则 / 背景补全
 * ============================================
 * 三个文件都在 dataDir 下, 与 Python 版共用同一份:
 *   export_blacklist.txt   每行一条, 支持 * 通配, # 为注释
 *   export_replace.txt     每行 '模式 -> 替换标签(可多个,逗号分隔)'
 *   export_bg.txt          [kw] 段=背景检测关键词, [append] 段=缺背景时追加的标签
 *
 * 全部带 mtime 缓存 —— 用户在编辑器里改了文件, 下次读取自动生效, 不用重启。
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'

const cache = {
  blacklist: { path: '', mtime: -1, value: null },
  replace: { path: '', mtime: -1, value: null },
  bg: { path: '', mtime: -1, value: null },
}

const BL_NAME = 'export_blacklist.txt'
const RP_NAME = 'export_replace.txt'
const BG_NAME = 'export_bg.txt'

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs } catch { return -1 }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

// ---------------------------------------------------------------- 黑名单

function rawBlacklistRules() {
  const text = readText(dataFile(BL_NAME))
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s && !s.startsWith('#')) out.push(s.toLowerCase())
  }
  return out
}

/** 是否命中黑名单(逐条比对版, 规则少或用得上精确语义时用) */
export function isBlocked(tag, rules) {
  if (!rules || !rules.length) return false
  const t = tag.toLowerCase()
  for (const rule of rules) {
    if (rule.startsWith('*') && rule.endsWith('*') && rule.length > 2) {
      if (t.includes(rule.slice(1, -1))) return true
    } else if (rule.startsWith('*')) {
      if (t.endsWith(rule.slice(1))) return true
    } else if (rule.endsWith('*')) {
      if (t.startsWith(rule.slice(0, -1))) return true
    } else if (t === rule) return true
  }
  return false
}

/**
 * 快速匹配器: 把规则拆成 exact 集合 + 前缀/后缀/包含元组。
 * 全量标签(约 1 万个)逐个跑 isBlocked 是 O(n×m); 拆开之后
 * 精确命中走 Set、通配走 startswith(tuple)/endswith(tuple), 快数倍。
 */
export function blacklistMatcher() {
  const p = dataFile(BL_NAME)
  const mt = mtimeOf(p)
  if (cache.blacklist.path !== p || cache.blacklist.mtime !== mt) {
    const rules = rawBlacklistRules()
    const exact = new Set()
    const pre = []
    const suf = []
    const con = []
    const parts = []
    for (const r of rules) {
      if (!r.includes('*')) {
        exact.add(r)
      } else if (r.startsWith('*') && r.endsWith('*') && r.length > 2) {
        const c = r.slice(1, -1)
        con.push(c)
        parts.push(escapeRe(c))
      } else if (r.startsWith('*')) {
        const s = r.slice(1)
        suf.push(s)
        parts.push(escapeRe(s) + '$')
      } else {
        const s = r.slice(0, -1)
        pre.push(s)
        parts.push('^' + escapeRe(s))
      }
    }
    cache.blacklist = {
      path: p, mtime: mt,
      value: {
        rules,
        exact,
        pre, suf, con,
        regex: parts.length ? new RegExp(parts.map((x) => `(?:${x})`).join('|')) : null,
      },
    }
  }
  return cache.blacklist.value
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 用 blacklistMatcher() 的结果快速判断单条标签是否被 ban */
export function isBlockedFast(tag, bl) {
  if (!bl) return false
  const t = tag.toLowerCase()
  if (bl.exact.has(t)) return true
  for (let i = 0; i < bl.pre.length; i++) if (t.startsWith(bl.pre[i])) return true
  for (let i = 0; i < bl.suf.length; i++) if (t.endsWith(bl.suf[i])) return true
  for (let i = 0; i < bl.con.length; i++) if (t.includes(bl.con[i])) return true
  return false
}

/** { tag: {banned, rule} } —— 给 lightbox/详情页做灰态与 🚫 切换 */
export function buildBanMap(tags) {
  const bl = blacklistMatcher()
  const out = {}
  for (const t of tags) {
    const tl = t.toLowerCase()
    if (bl.exact.has(tl)) {
      out[t] = { banned: true, rule: tl }
    } else if (bl.regex && bl.regex.test(tl)) {
      out[t] = { banned: true, rule: bl.rules.find((r) => isBlocked(t, [r])) || '' }
    } else {
      out[t] = { banned: false, rule: '' }
    }
  }
  return out
}

/** 当前黑名单原文(编辑弹窗用) */
export function blacklistText() {
  return readText(dataFile(BL_NAME))
}

export function blacklistRules() { return rawBlacklistRules() }

export function saveBlacklistText(text) {
  fs.writeFileSync(dataFile(BL_NAME), String(text ?? ''), 'utf8')
  cache.blacklist.mtime = -1
  return { ok: true, rules: rawBlacklistRules() }
}

/**
 * 单条标签 ban / unban —— 保留文件里的注释与分组格式。
 * 已 ban 且是精确规则 -> 删掉那一行;
 * 被通配规则命中 -> 返回 warning(必须手动改规则);
 * 未 ban -> 追加一条精确规则。
 */
export function toggleBlacklistTag(tag) {
  const p = dataFile(BL_NAME)
  const target = String(tag || '').trim()
  if (!target) return { error: 'empty tag' }

  const text = readText(p)
  const lines = text ? text.split('\n') : []

  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s && !s.startsWith('#') && !s.includes('*') && s.toLowerCase() === target.toLowerCase()) {
      idx = i
      break
    }
  }

  let banned, action
  if (idx >= 0) {
    lines.splice(idx, 1)
    banned = false
    action = 'unbanned'
  } else {
    const wild = rawBlacklistRules().filter((r) => r.includes('*'))
    if (isBlocked(target, wild)) {
      const hit = wild.find((r) => isBlocked(target, [r])) || ''
      fs.writeFileSync(p, lines.join('\n'), 'utf8')
      cache.blacklist.mtime = -1
      return {
        ok: true, banned: true, action: 'wildcard', ban_rule: hit,
        warning: `该标签被通配规则 ${hit} 命中, 需在黑名单里手动修改`,
      }
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push(target)
    banned = true
    action = 'banned'
  }

  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8')
  cache.blacklist.mtime = -1
  return { ok: true, banned, action, rules: rawBlacklistRules() }
}

// ---------------------------------------------------------------- 替换规则

/** [{ pat, replTags }] —— 例: *boy -> [boy, shota] (1boy/2boy/boy 都会命中) */
export function loadReplaceRules() {
  const p = dataFile(RP_NAME)
  const mt = mtimeOf(p)
  if (cache.replace.path !== p || cache.replace.mtime !== mt) {
    const out = []
    for (const line of readText(p).split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('->')
      if (i < 0) continue
      const pat = s.slice(0, i).trim().toLowerCase()
      const replTags = s.slice(i + 2).split(',').map((x) => x.trim()).filter(Boolean)
      if (pat && replTags.length) out.push({ pat, replTags })
    }
    cache.replace = { path: p, mtime: mt, value: out }
  }
  return cache.replace.value
}

/** 对单个标签套用替换规则, 返回替换后的标签数组(未命中则原样返回它) */
export function replaceTag(tag, rules) {
  const out = []
  for (const { pat, replTags } of rules) {
    let hit = false
    if (pat.startsWith('*') && pat.endsWith('*') && pat.length > 2) {
      hit = tag.toLowerCase().includes(pat.slice(1, -1))
    } else if (pat.startsWith('*')) {
      hit = tag.toLowerCase().endsWith(pat.slice(1))
    } else if (pat.endsWith('*')) {
      hit = tag.toLowerCase().startsWith(pat.slice(0, -1))
    } else {
      hit = tag.toLowerCase() === pat
    }
    if (hit) for (const r of replTags) if (!out.includes(r)) out.push(r)
  }
  return out.length ? out : [tag]
}

export function replaceText() { return readText(dataFile(RP_NAME)) }

export function saveReplaceText(text) {
  fs.writeFileSync(dataFile(RP_NAME), String(text ?? ''), 'utf8')
  cache.replace.mtime = -1
  return { ok: true, rules: loadReplaceRules() }
}

// ---------------------------------------------------------------- 背景补全

/**
 * 解析 [kw] / [append] 两段。
 * 命中任一 kw 视为「已有背景」, 否则在导出/复制时追加 append 里的标签,
 * 防止 AI 把背景画成白底。
 */
export function loadBgConfig() {
  const p = dataFile(BG_NAME)
  const mt = mtimeOf(p)
  if (cache.bg.path !== p || cache.bg.mtime !== mt) {
    const kw = []
    const append = []
    let section = 'kw'
    for (const line of readText(p).split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      if (s.startsWith('[') && s.endsWith(']')) {
        section = s.slice(1, -1).trim().toLowerCase()
        continue
      }
      if (section === 'kw') kw.push(s.toLowerCase())
      else append.push(s)
    }
    const exact = new Set()
    const pre = []
    const suf = []
    const con = []
    for (const r of kw) {
      if (!r.includes('*')) exact.add(r)
      else if (r.startsWith('*') && r.endsWith('*') && r.length > 2) con.push(r.slice(1, -1))
      else if (r.startsWith('*')) suf.push(r.slice(1))
      else pre.push(r.slice(0, -1))
    }
    cache.bg = {
      path: p, mtime: mt,
      value: { kw, append, exact, pre, suf, con },
    }
  }
  return cache.bg.value
}

/** 标签列表里是否已经有背景/场景类标签(命中任一即返回 true) */
export function hasBgTagFast(tags, bg) {
  if (!bg || !bg.kw.length) return true
  for (const t of tags) {
    const tl = t.toLowerCase()
    if (bg.exact.has(tl)) return true
    for (let i = 0; i < bg.pre.length; i++) if (tl.startsWith(bg.pre[i])) return true
    for (let i = 0; i < bg.suf.length; i++) if (tl.endsWith(bg.suf[i])) return true
    for (let i = 0; i < bg.con.length; i++) if (tl.includes(bg.con[i])) return true
  }
  return false
}

/** 规则文件的外部改动可能不更新 mtime 精度, 提供手动失效 */
export function invalidateRuleCaches() {
  cache.blacklist.mtime = -1
  cache.replace.mtime = -1
  cache.bg.mtime = -1
}
