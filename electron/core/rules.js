/**
 * 导出规则三件套: 黑名单 / 替换规则 / 背景补全
 * ============================================
 * 三个文件都在 dataDir 下, 与 Python 版共用同一份:
 *   export_blacklist.txt   每行一条, 支持 * 通配, # 为注释
 *   export_replace.txt     每行 '模式 -> 替换标签(可多个,逗号分隔)'
 *                          替换侧里写 {tag} 表示"命中时的原标签", 用来做追加/改写:
 *                            *_hair   -> {tag}, hair_focus      (保留原标签 + 追加)
 *                            painting -> {tag}_style            (原标签改写, 见 replaceTag)
 *                          替换侧为空('模式 ->') = 命中即删除该标签(2026-10-18)
 *
 * 通配两种写法(黑名单 / 替换规则 / 视角词表 三处通用):
 *   *  星号 = 纯子串语义 —— 下划线只是普通字符, 所以 *boy* 会连 tomboy/boyish/xxxboy 一起命中
 *   @  整段 = 按 _ 切段后逐段比, 段内也能用 *(不能跨段):
 *            @boy@     boy / boy_xx / xx_boy / xx_boy_yy 命中; tomboy/boyish/xxxboy 不命中
 *            @boy*@    段以 boy 开头     @*hair@  段以 hair 结尾     @*color*@  段含 color
 *       (# 是注释前缀, 所以段的界符用 @)
 *   export_bg.txt          [kw] 段=背景检测关键词, [append] 段=缺背景时追加的标签
 *
 * 全部带 mtime 缓存 —— 用户在编辑器里改了文件, 下次读取自动生效, 不用重启。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
import { unwrapWeight } from './tagcats.js'

const cache = {
  blacklist: { path: '', mtime: -1, value: null },
  bg: { path: '', mtime: -1, value: null },
  view: { path: '', mtime: -1, value: null },
}
// 替换规则改成**按组**缓存(2026-10-04): Map<setId, {text, value}>,
// text 一致就复用编译结果 —— 存盘/改组名后调用方 clear 一下即可。
const replaceCache = new Map()

const BL_NAME = 'export_blacklist.txt'
const RP_NAME = 'export_replace.txt'
const BG_NAME = 'export_bg.txt'
const RS_NAME = 'replace_sets.json'

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
    if (isSegPat(rule)) {
      if (segHit(t, rule.slice(1, -1))) return true
    } else if (rule.startsWith('*') && rule.endsWith('*') && rule.length > 2) {
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
 * 快速匹配器共用的编译: 规则拆成 exact 集合 + 前缀/后缀/包含元组 + 合并正则。
 * 全量标签(约 1 万个)逐个跑 isBlocked 是 O(n×m); 拆开之后
 * 精确命中走 Set、通配走 startswith(tuple)/endswith(tuple), 快数倍。
 */
function compileFast(rules) {
  const exact = new Set()
  const pre = []
  const suf = []
  const con = []
  const seg = []
  const parts = []
  for (const r of rules) {
    if (isSegPat(r)) {
      // 整段规则不能落进 exact(它本身不含 *), 必须单独一档
      const inner = r.slice(1, -1)
      seg.push(inner)
      parts.push(segRe(inner))
    } else if (!r.includes('*')) {
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
  return {
    rules,
    exact,
    pre, suf, con, seg,
    regex: parts.length ? new RegExp(parts.map((x) => `(?:${x})`).join('|')) : null,
  }
}

export function blacklistMatcher() {
  const p = dataFile(BL_NAME)
  const mt = mtimeOf(p)
  if (cache.blacklist.path !== p || cache.blacklist.mtime !== mt) {
    cache.blacklist = { path: p, mtime: mt, value: compileFast(rawBlacklistRules()) }
  }
  return cache.blacklist.value
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 一个字符串对一条通配模式(精确/前缀/后缀/包含)的匹配 */
function wildHit(s, pat) {
  if (pat.startsWith('*') && pat.endsWith('*') && pat.length > 2) return s.includes(pat.slice(1, -1))
  if (pat.startsWith('*')) return s.endsWith(pat.slice(1))
  if (pat.endsWith('*')) return s.startsWith(pat.slice(0, -1))
  return s === pat
}

/** '@xxx@' = "整段"匹配: 按 _ 切段逐段比, 段内还能用 * (但不能跨段)。# 是注释前缀, 故用 @ 当界符 */
function isSegPat(pat) { return pat.length > 2 && pat.charAt(0) === '@' && pat.endsWith('@') }
function segHit(lowerTag, inner) { return lowerTag.split('_').some((seg) => wildHit(seg, inner)) }

/** 段模式转正则片段: @boy@ -> (?:^|_)boy(?:_|$); 段内的 * 不能跨段, 用 [^_]* */
function segRe(inner) { return '(?:^|_)' + inner.split('*').map(escapeRe).join('[^_]*') + '(?:_|$)' }

/** compileFast 产物的单标签快速命中(不做空格/下划线归一, 调用方自己决定) */
function fastHit(t, m) {
  if (m.exact.has(t)) return true
  for (let i = 0; i < m.pre.length; i++) if (t.startsWith(m.pre[i])) return true
  for (let i = 0; i < m.suf.length; i++) if (t.endsWith(m.suf[i])) return true
  for (let i = 0; i < m.con.length; i++) if (t.includes(m.con[i])) return true
  for (let i = 0; i < m.seg.length; i++) if (segHit(t, m.seg[i])) return true
  return false
}

/** 用 blacklistMatcher() 的结果快速判断单条标签是否被 ban */
export function isBlockedFast(tag, bl) {
  if (!bl) return false
  return fastHit(String(tag).toLowerCase(), bl)
}

// ---------------------------------------------------------------- 视角/机位词表

const VIEW_NAME = 'export_view_tags.txt'

/**
 * 默认词表: 《随机机位交接文档》(2026-09-23) 第 3 节 —— bsk 相机控制(节点 405)
 * 产出的全部分档 tag。提示词里写的空格形态(from behind)在库里是下划线形态,
 * 匹配时两侧都试(isViewFast)。`left` 档输出的 tag 是 "from right", 不是笔误。
 *
 * 额外补 `from_side`: 不在文档第 3 节里(插件只输出 from_left/from_right), 但
 * **WD14 反推自己会写 from_side**(实测库里 2,834 张), 且对端把背景池里的
 * `from side` 也一并当视角词删了 → 两侧口径对齐, 故收进种子。
 * 其余实测 0 张的条目(from_front / from_left / from_right / high_angle /
 * low_angle / eye-level / medium_shot / extreme_close-up / aerial_view /
 * directly_above / directly_below)保留无害: 一旦提示词元数据里带了就顺手剔掉。
 * ⚠️ `full_body` 在库里 23,574 张, 它同时是"构图类"常用词, 勾上剔除视角会一起剔掉 ——
 * 这是文档第 3 节景别档的原义, 不需要就整行删掉。
 *
 * 2026-09-26 补: 交接文档「任务派发·景别词」的 10 个词对账后补齐 4 个缺口
 * (cowboy_shot / upper_body / lower_body / very_wide_shot) —— 对端背景池已按
 * 该清单清洗, 本机导出不再剔就会经 Syncthing 把词回灌进池子。
 */
export const DEFAULT_VIEW_TAGS = [
  'from_front', 'from_behind', 'from_left', 'from_right', 'from_side',
  'directly_above', 'from_above', 'aerial_view', 'high_angle', 'eye-level',
  'low_angle', 'from_below', 'directly_below',
  'extreme_close-up', 'close-up', 'medium_shot', 'full_body', 'wide_shot',
  'very_wide_shot', 'cowboy_shot', 'upper_body', 'lower_body',
  'dutch_angle',
]

function defaultViewText() {
  return [
    '# 导出剔除「视角/机位」标签 —— 词表',
    '# ================================',
    '# 勾选「导出剔除视角/机位标签」时, 命中这里任一条的标签不会出现在导出结果里。',
    '# 每行一条(小写/下划线写法), 支持 * 通配, # 开头是注释; 改完保存即生效, 不用重启。',
    '#',
    '# 词表种子来自《随机机位交接文档》第 3 节(bsk 相机控制节点 405 的全部分档):',
    '#   方位  from_front / from_behind / from_left / from_right',
    '#   高度  directly_above / from_above / aerial_view / high_angle / eye-level',
    '#         / low_angle / from_below / directly_below',
    '#   景别  extreme_close-up / close-up / medium_shot / full_body / wide_shot',
    '#         / very_wide_shot / cowboy_shot / upper_body / lower_body',
    '#         (后 4 条为 2026-09-26 交接文档「任务派发·景别词」补齐)',
    '#   斜角  dutch_angle',
    '# 另补 from_side: WD14 反推自己会写它(库里实测 2,834 张), 对端背景池也已按视角词清理。',
    '# ⚠️ full_body 在库里 23,574 张, 属于"构图类"常用词, 不想要就整行删掉。',
    '# 注意: 机位插件 left 档输出的 tag 是 "from right"(相机在左=画面从右看), 没写错。',
    '# 405 的 config 以后加了新分档/改了措辞, 这里(或交接文档)记得同步。',
    '',
    ...DEFAULT_VIEW_TAGS,
    '',
  ].join('\n')
}

/** 首次使用时写出去(带词表来源说明), 之后绝不覆盖用户的改动 */
function ensureViewFile(p) {
  if (fs.existsSync(p)) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, defaultViewText(), 'utf8')
  } catch { /* 写不出去也不影响导出(读侧回落空规则) */ }
}

function rawViewRules() {
  const p = dataFile(VIEW_NAME)
  ensureViewFile(p)
  const out = []
  for (const line of readText(p).split('\n')) {
    const s = line.trim().toLowerCase()
    if (!s || s.startsWith('#')) continue
    out.push(s)
    // 词表里写空格形态("from behind")也认 —— 转成下划线形态再收一条
    const u = s.replace(/ /g, '_')
    if (u !== s) out.push(u)
  }
  return out
}

/** 视角/机位词表匹配器(与黑名单同一套编译, 独立缓存, mtime 变了自动重读) */
export function viewTagMatcher() {
  const p = dataFile(VIEW_NAME)
  const mt = mtimeOf(p)
  if (cache.view.path !== p || cache.view.mtime !== mt) {
    cache.view = { path: p, mtime: mt, value: compileFast(rawViewRules()) }
  }
  return cache.view.value
}

/**
 * 用 viewTagMatcher() 的结果快速判断单条标签是否命中视角词表。
 * 比黑名单多一步: 提示词侧的标签可能带**空格**(meta 来源的图原样存了
 * "from behind"), 词表是下划线形态 —— 空格转下划线再试一次。
 */
export function isViewFast(tag, vm) {
  if (!vm) return false
  const t = String(tag).toLowerCase()
  if (fastHit(t, vm)) return true
  const u = t.replace(/ /g, '_')
  return u !== t && fastHit(u, vm)
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

/* ------------------------------------------------------------------
 * 规则组(2026-10-04): 一份规则不够用了 —— 用户不同导出目的要不同替换方案
 * (给 ComfyUI 出图补质量词 / 传 Danbooru 的清洗版 / 角色表专用...)。
 * 存法: user/replace_sets.json = { active, sets: [{id, name, text}] }。
 *
 * 迁移: 首次读时 json 不存在, 就把现有 data/export_replace.txt 的内容建成
 * 「默认」组并落盘。**原 txt 一个字都不动**(留着当备份/回滚), 行为也完全不变。
 * ------------------------------------------------------------------ */

const DEFAULT_SET_ID = 'default'

/** 文本 -> [{pat, replTags}]; 行格式与旧 txt 一模一样(兼容)。导出供语法模块测试当 oracle
 *  删除语义(2026-10-18): 替换侧为空(`pat ->`) = 命中即删除该标签(replTags=[]) */
export function parseReplaceRules(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('->')
    if (i < 0) continue
    const pat = s.slice(0, i).trim().toLowerCase()
    const replTags = s.slice(i + 2).split(',').map((x) => x.trim()).filter(Boolean)
    if (pat) out.push({ pat, replTags })
  }
  return out
}

function writeSets(obj) {
  const p = dataFile(RS_NAME)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  try { fs.renameSync(tmp, p) } catch { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8') }
}

/** 全部规则组 + 当前默认组; 缺文件时从旧 txt 迁移出「默认」组 */
export function replaceSets() {
  const p = dataFile(RS_NAME)
  let raw = null
  try { raw = JSON.parse(readText(p)) } catch { raw = null }
  const sets = []
  const seen = new Set()
  for (const s of (Array.isArray(raw?.sets) ? raw.sets : [])) {
    const id = String(s?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    sets.push({ id, name: String(s?.name || id).trim() || id, text: String(s?.text ?? '') })
  }
  if (!sets.length) {
    sets.push({ id: DEFAULT_SET_ID, name: '默认', text: readText(dataFile(RP_NAME)) })
    writeSets({ active: DEFAULT_SET_ID, sets })
  }
  let active = String(raw?.active || '').trim()
  if (!sets.some((s) => s.id === active)) active = sets[0].id
  return { active, sets }
}

/** 存整套规则组; 返回落盘后的结构(前端拿它刷新) */
export function saveReplaceSets(body = {}) {
  const cur = replaceSets()
  const incoming = Array.isArray(body.sets) ? body.sets : cur.sets
  const sets = []
  const seen = new Set()
  for (const s of incoming) {
    const name = String(s?.name || '').trim() || String(s?.id || '').trim()
    if (!name) continue
    // id 允许留空(新建组): 用名字生成, 重名再加后缀 —— 稳定且可读
    let id = String(s?.id || '').trim() || `set_${name.replace(/\s+/g, '_').slice(0, 24)}`
    while (seen.has(id)) id = `${id}_x`
    seen.add(id)
    sets.push({ id, name, text: String(s?.text ?? '') })
  }
  if (!sets.length) return { error: '至少要保留一套替换规则' }
  let active = String(body.active || '').trim()
  if (!sets.some((s) => s.id === active)) active = sets.find((s) => s.id === cur.active)?.id || sets[0].id
  writeSets({ active, sets })
  replaceCache.clear()
  return { active, sets }
}

/** 按组 id 取编译好的规则; id 空/找不到 = 当前默认组 */
export function loadReplaceRulesGroup(setId = '') {
  const { active, sets } = replaceSets()
  const set = sets.find((s) => s.id === setId) || sets.find((s) => s.id === active) || sets[0]
  if (!set) return []
  const hit = replaceCache.get(set.id)
  if (hit && hit.text === set.text) return hit.value
  const value = parseReplaceRules(set.text)
  replaceCache.set(set.id, { text: set.text, value })
  return value
}

/** 兼容旧调用点: 现在的"默认组"就是以前的单份规则 */
export function loadReplaceRules() { return loadReplaceRulesGroup('') }

/** 替换侧里的 {tag} 占位符 = 命中时的原标签(大小写不敏感) */
const TAG_PLACEHOLDER = /\{tag\}/gi

/**
 * 对单个标签套用替换规则, 返回替换后的标签数组(未命中则原样返回它)
 *
 * 替换侧可以写 {tag} 引用"命中的原标签", 于是同一条规则既能改前缀通配又能留住原值:
 *   *_hair    -> {tag}, hair_focus    =>  blue_hair 变成 blue_hair, hair_focus
 *   painting  -> {tag}_art            =>  painting  变成 painting_art
 *   *comment* -> illustration, {tag}  =>  画风词归并到统一标签, 原词保留
 * 模式侧还可以写 @xxx@ 表示"xxx 是独立的一段"(@ 是界符, # 是注释):
 *   @boy@     -> {tag}, male_focus   =>  只有 boy/boy_xx/xx_boy/xx_boy_yy 会加, tomboy 不会
 *
 * 不写 {tag} 时是纯替换(原标签被丢掉), 与旧行为完全一致。
 */
/** 单个模式对单标签的命中判断(replaceTag 与规则测试器共用, 保证口径一致) */
function patHit(tag, pat) {
  if (isSegPat(pat)) return segHit(tag.toLowerCase(), pat.slice(1, -1))
  if (pat.startsWith('*') && pat.endsWith('*') && pat.length > 2) return tag.toLowerCase().includes(pat.slice(1, -1))
  if (pat.startsWith('*')) return tag.toLowerCase().endsWith(pat.slice(1))
  if (pat.endsWith('*')) return tag.toLowerCase().startsWith(pat.slice(0, -1))
  return tag.toLowerCase() === pat
}

export function replaceTag(tag, rules) {
  const out = []
  // 去重按剥权重壳归一(2026-10-19): 替换侧同时写 (uncensored:2) 与 uncensored
  // 只出先到的那个 —— 与导出管线的去重口径一致
  const seenOut = new Set()
  let del = false
  for (const { pat, replTags } of rules) {
    if (!patHit(tag, pat)) continue
    // 删除规则(替换侧为空): 命中即整个删掉, 后面的规则不再看
    if (!replTags.length) { del = true; break }
    for (const r of replTags) {
      // 用函数式替换, 免得原标签里的 $& / $1 被当成替换模式吃掉
      const v = r.replace(TAG_PLACEHOLDER, () => tag)
      const dk = unwrapWeight(v).toLowerCase()
      if (!seenOut.has(dk)) { seenOut.add(dk); out.push(v) }
    }
  }
  if (del) return []
  return out.length ? out : [tag]
}

/** 兼容旧调用点: 读/写**当前默认组**的规则正文(等价于单份规则时代的语义) */
export function replaceText() {
  const { active, sets } = replaceSets()
  return (sets.find((s) => s.id === active) || sets[0])?.text || ''
}

/**
 * 规则测试器(2026-10-18, 编辑器底部的 🧪): 与导出引擎**同一套代码**算,
 * 返回命中了哪些规则、替换成什么 —— 保证「测试显示的」就是「导出会发生的」。
 * 未命中时 result=[原标签] 与 replaceTag 语义一致。
 */
export function testReplaceRules(raw = {}) {
  const tag = String(raw.tag || '').trim()
  if (!tag) return { error: 'empty tag' }
  const rules = loadReplaceRulesGroup(String(raw.setId || ''))
  const hits = []
  for (const { pat, replTags } of rules) {
    if (patHit(tag, pat)) hits.push({ pat, replTags })
  }
  return { tag, hits, result: replaceTag(tag, rules) }
}

export function saveReplaceText(text) {
  const { active, sets } = replaceSets()
  const next = sets.map((s) => (s.id === active ? { ...s, text: String(text ?? '') } : s))
  return saveReplaceSets({ active, sets: next })
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
  cache.bg.mtime = -1
  replaceCache.clear()   // 替换规则现在是按组缓存(text 一致才复用), 整表清掉最稳
}
