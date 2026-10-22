/**
 * 安全模式 —— 按标签集合隐藏露骨内容
 * ====================================
 * **为什么按"标签集合"判, 而不是按 rating 字段**: 实测用户库里 `rating_*`
 * 标记 **0 张** —— WD14 反推模型(PixAI v0.9)不输出 danbooru 那套 rating 分类,
 * txt 时代也没写过。所以唯一可用的判据就是标签本身, 而"哪些标签算敏感"是个
 * **口味问题**, 必须可编辑 —— 所以集合落在文本文件里, 不写死在代码里。
 *
 * 两档口径, 实测在用户库 77,727 张可见图上:
 *   core  19 个"明确的裸露/性行为"           -> 命中 45,366 张 (58.4%)
 *   edge  在 core 之上再加 19 个擦边/内衣/打码 -> 命中 69,919 张 (90.0%)
 *
 * ⚠️ **刻意没有收录 `breasts` 系列**(实测 breasts 命中 77,437 张 = 93% 的图):
 * "画里有胸"不等于暴露, 二次元图里几乎人人都有; 收进去等于把整个库藏起来。
 * 同理 `thighhighs`(21,965) 这类只是"口味偏擦边"的服饰标签放在 edge 段 ——
 * 用户可以整行删掉, 退出 edge 口径。
 *
 * 落地方式与 `rules.js` 的三件套一致:
 *   dataDir/safety_tags.txt   两段式集合([core] / [edge]), # 注释, 支持 * 通配
 *   dataDir/safety.json       { on, level } —— **默认关闭**
 * 全部带 mtime 缓存: 在编辑器里改了文件, 下次读取自动生效, 不用重启。
 *
 * **只做展示层过滤**: 库里的 image 行一行不动, 统计数字也不重算 ——
 * 开关一关立刻全回来。
 *
 * 判定结果在**读数据集时**算一次(record.unsafe = 0/1/2), 前端只做数值比较,
 * 于是切换开关/档位**不需要重载数据集**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'

const TAGS_NAME = 'safety_tags.txt'
const STATE_NAME = 'safety.json'

/** 默认 core 段: 明确的裸露 / 性行为 */
export const DEFAULT_CORE = [
  'nude', 'completely_nude', 'nipples', 'pussy', 'penis', 'sex', 'vaginal', 'anal',
  'cum', 'cum_in_pussy', 'anus', 'pussy_juice', 'bottomless', 'topless',
  'spread_pussy', 'areola_slip', 'masturbation', 'fellatio', 'orgasm',
]

/** 默认 edge 段(在 core 之上追加): 擦边 / 内衣 / 打码标记 */
export const DEFAULT_EDGE = [
  'underwear', 'panties', 'no_panties', 'underwear_only', 'breasts_out',
  'cleavage', 'ass', 'thighhighs', 'swimsuit', 'bikini', 'lingerie',
  'bondage', 'sex_toy', 'pubic_hair', 'nipple_slip', 'covered_nipples',
  'censored', 'mosaic_censoring', 'uncensored',
]

const cache = {
  tags: { path: '', mtime: -1, value: null },
  state: { path: '', mtime: -1, value: null },
}

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs } catch { return -1 }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

/** 首次使用时写出去的默认文件 —— 带说明, 让用户有个能直接改的起点 */
function defaultText() {
  return [
    '# 安全模式 —— 敏感标签集合',
    '# =============================',
    '# 每行一个标签(Danbooru 写法: 小写、下划线), # 开头是注释, 支持 * 通配。',
    '# 改完保存即生效, 不用重启看板。',
    '#',
    '# [core] 明确的裸露 / 性行为。默认档, 实测会隐藏约 58% 的图。',
    '# [edge] 在 core 之上追加擦边 / 内衣 / 打码标记。更严, 实测隐藏约 90%。',
    '#',
    '# ⚠️ 刻意没收录 breasts / large_breasts 这类"体型"标签: "画里有胸"不等于',
    '#    暴露, 二次元图里几乎人人都有(实测 breasts 命中 93% 的图), 收进去',
    '#    等于把整个库藏起来。thighhighs 这类只是口味偏擦边的也放在 edge 段,',
    '#    不认这个口径就整行删掉。',
    '',
    '[core]',
    ...DEFAULT_CORE,
    '',
    '[edge]',
    ...DEFAULT_EDGE,
    '',
  ].join('\n')
}

/** 确保集合文件存在 —— 不存在就写出默认内容(只写一次, 之后绝不覆盖用户的改动) */
function ensureTagsFile(p) {
  if (fs.existsSync(p)) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, defaultText(), 'utf8')
  } catch { /* 写不出去也不影响运行(读侧会回落到内置默认) */ }
}

/**
 * 解析集合文件 -> 每段拆成 exact Set + 三种通配。
 * 拆开是为了性能: 判一张图时它的标签数约 40, 走 Set 命中是 O(1),
 * 只有带 * 的少数规则才逐个 startsWith/endsWith/includes。
 */
function parseSections(text) {
  const sec = { core: [], edge: [] }
  let cur = 'core'
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    if (s.startsWith('[') && s.endsWith(']')) {
      const name = s.slice(1, -1).trim().toLowerCase()
      cur = name === 'edge' ? 'edge' : 'core'
      continue
    }
    sec[cur].push(s.toLowerCase())
  }
  return sec
}

function compile(list) {
  const exact = new Set()
  const pre = []
  const suf = []
  const con = []
  for (const r of list) {
    if (!r.includes('*')) exact.add(r)
    else if (r.startsWith('*') && r.endsWith('*') && r.length > 2) con.push(r.slice(1, -1))
    else if (r.startsWith('*')) suf.push(r.slice(1))
    else pre.push(r.slice(0, -1))
  }
  return { exact, pre, suf, con, raw: list }
}

/** 单标签是否命中某一段 */
function hitOne(tag, part) {
  if (part.exact.has(tag)) return true
  for (let i = 0; i < part.pre.length; i++) if (tag.startsWith(part.pre[i])) return true
  for (let i = 0; i < part.suf.length; i++) if (tag.endsWith(part.suf[i])) return true
  for (let i = 0; i < part.con.length; i++) if (tag.includes(part.con[i])) return true
  return false
}

/**
 * 取当前集合(带 mtime 缓存)。
 * @returns {{core: object, edge: object, coreCount: number, edgeCount: number}}
 */
export function safetyMatcher() {
  const p = dataFile(TAGS_NAME)
  const mt = mtimeOf(p)
  if (cache.tags.path !== p || cache.tags.mtime !== mt) {
    ensureTagsFile(p)
    const text = readText(p)
    // 文件被删/读不到 -> 用内置默认, 保证功能不会因为少一个文件就失灵
    const sec = text ? parseSections(text) : { core: DEFAULT_CORE, edge: DEFAULT_EDGE }
    const core = compile(sec.core)
    const edge = compile(sec.edge)
    cache.tags = {
      path: p,
      mtime: mtimeOf(p),      // ensureTagsFile 之后重新取, 否则第一次会反复重解析
      value: {
        core, edge,
        coreCount: core.exact.size + core.pre.length + core.suf.length + core.con.length,
        edgeCount: edge.exact.size + edge.pre.length + edge.suf.length + edge.con.length,
      },
    }
  }
  return cache.tags.value
}

/**
 * 给一组标签打安全标记。
 * @returns {0|1|2} 0=干净 / 1=命中 core / 2=只命中 edge 段
 *
 * 用**数值**而不是布尔: 读数据集时一次算好两种档位的结果, 前端切档只做比较,
 * 不需要重载八万行数据。
 */
export function unsafeLevelOf(tags, m = null) {
  const mat = m || safetyMatcher()
  if (!mat.coreCount && !mat.edgeCount) return 0
  for (const t of tags) {
    const tl = t.toLowerCase()
    if (hitOne(tl, mat.core)) return 1
  }
  for (const t of tags) {
    if (hitOne(t.toLowerCase(), mat.edge)) return 2
  }
  return 0
}

/**
 * 数值标记 -> 在某个档位下是否该隐藏。
 *   unsafe=0  干净            -> 两档都不藏
 *   unsafe=1  命中 core 段    -> 两档都藏(core 是默认档, edge 是更严档)
 *   unsafe=2  只命中 edge 段  -> **只有 edge 档藏**, core 档放行
 *
 * 前端有一份等价实现(utils/format.js 的 hiddenBySafety) —— 前端不能 import
 * 主进程模块。改这里的判定规则时两边要一起改。
 */
export function hiddenAt(unsafe, level) {
  const u = Number(unsafe) || 0
  if (u <= 0) return false
  return u === 1 || level === 'edge'
}

/**
 * 导出用的敏感标签剔除器 —— 口径**可按次指定, 缺省跟随 safety.json 的档位**:
 * levelOpt='core'/'edge' 时用传入档位(预设导出可逐预设选), 其余值跟随全局。
 * 与「安全模式」的展示过滤共用同一份词表文件; 展示开关 on/off 不影响这里
 * (档位本身始终存在)。返回 (tag) => boolean, 供 exporter.js 逐标签调用。
 */
export function safetyExportStripper(levelOpt = '') {
  const globalLevel = loadSafetyState().level === 'edge' ? 'edge' : 'core'
  const level = levelOpt === 'core' || levelOpt === 'edge' ? levelOpt : globalLevel
  const m = safetyMatcher()
  const parts = level === 'edge' ? [m.core, m.edge] : [m.core]
  return (tag) => {
    const t = String(tag).toLowerCase()
    for (const p of parts) if (hitOne(t, p)) return true
    return false
  }
}

/* ------------------------------------------------------------ 开关与档位 */

/* mode(2026-10-23):
 *   safe   = 正常口径, 隐藏命中敏感标签的图
 *   unsafe = 「不安全模式」: **取反** —— 只显示命中敏感标签的图, 其余全隐藏
 * 两者共用同一份档位(core/edge)与词表; 开关(on)仍是总闸, 关掉时两模式都不生效。 */
const DEFAULT_STATE = { on: false, level: 'core', mode: 'safe' }

/**
 * 开关与档位。**默认关闭** —— 实测 core 档会藏掉 58% 的图, 这种东西不能默认开。
 * 文件坏了/读不到也回落到默认关闭(宁可看不到过滤, 也不要突然少一半图)。
 */
export function loadSafetyState() {
  const p = dataFile(STATE_NAME)
  const mt = mtimeOf(p)
  if (cache.state.path !== p || cache.state.mtime !== mt) {
    let v = { ...DEFAULT_STATE }
    try {
      const raw = JSON.parse(readText(p) || '{}')
      v = {
        on: raw.on === true,
        level: raw.level === 'edge' ? 'edge' : 'core',
        mode: raw.mode === 'unsafe' ? 'unsafe' : 'safe',
      }
    } catch { /* 坏文件 -> 默认关闭 */ }
    cache.state = { path: p, mtime: mt, value: v }
  }
  return cache.state.value
}

export function saveSafetyState(patch = {}) {
  const cur = loadSafetyState()
  const next = {
    on: patch.on === undefined ? cur.on : patch.on === true,
    level: patch.level === undefined ? cur.level : (patch.level === 'edge' ? 'edge' : 'core'),
    mode: patch.mode === undefined ? cur.mode : (patch.mode === 'unsafe' ? 'unsafe' : 'safe'),
  }
  fs.writeFileSync(dataFile(STATE_NAME), JSON.stringify(next, null, 2), 'utf8')
  cache.state.mtime = -1
  return { ok: true, ...next }
}

/* ------------------------------------------------------------ 集合编辑 */

/** 集合文件原文(给编辑弹窗) */
export function safetyText() {
  const p = dataFile(TAGS_NAME)
  ensureTagsFile(p)
  return readText(p)
}

export function saveSafetyText(text) {
  const p = dataFile(TAGS_NAME)
  fs.writeFileSync(p, String(text ?? ''), 'utf8')
  cache.tags.mtime = -1
  return { ok: true, ...safetySummary() }
}

/**
 * 单条标签加入 / 移出某个段 —— 保留文件里的注释与分组。
 * 已在该段(且是精确条目) -> 删掉那一行; 否则追加到该段末尾。
 * 被判通配规则命中时**不动文件**, 只回一个 warning(必须手工改规则)。
 */
export function toggleSafetyTag(tag, level = 'core') {
  const p = dataFile(TAGS_NAME)
  const target = String(tag || '').trim().toLowerCase()
  if (!target) return { ok: false, error: 'empty tag' }
  const sec = level === 'edge' ? 'edge' : 'core'
  ensureTagsFile(p)

  const lines = readText(p).split('\n')
  let secStart = -1
  let secEnd = lines.length
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.startsWith('[') && s.endsWith(']')) {
      const name = s.slice(1, -1).trim().toLowerCase()
      if (secStart < 0 && name === sec) { secStart = i; continue }
      if (secStart >= 0) { secEnd = i; break }
    }
    if (secStart >= 0 && s && !s.startsWith('#') && !s.includes('*') && s.toLowerCase() === target) {
      found = i
      break
    }
  }

  const mat = safetyMatcher()
  const part = sec === 'edge' ? mat.edge : mat.core
  const other = sec === 'edge' ? mat.core : mat.edge

  if (found >= 0) {
    lines.splice(found, 1)
    fs.writeFileSync(p, lines.join('\n'), 'utf8')
    cache.tags.mtime = -1
    return { ok: true, inSet: false, section: sec, ...safetySummary() }
  }

  if (hitOne(target, part)) {
    const rule = [...part.raw].find((r) => r.includes('*') && hitOne(target, compile([r]))) || ''
    return { ok: true, inSet: true, section: sec, wildcard: rule, ...safetySummary() }
  }
  if (hitOne(target, other)) {
    return {
      ok: true, inSet: true, section: sec === 'edge' ? 'core' : 'edge',
      note: `该标签已属于 ${sec === 'edge' ? 'core' : 'edge'} 段`, ...safetySummary(),
    }
  }

  // 追加到该段末尾(段不存在就在文件末尾补一个段头)
  if (secStart < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', `[${sec}]`, target)
  } else {
    let insertAt = secEnd
    while (insertAt > secStart + 1 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, target)
  }
  fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf8')
  cache.tags.mtime = -1
  return { ok: true, inSet: true, section: sec, ...safetySummary() }
}

/** 给界面用的一览: 两段各多少条、开关与档位 */
export function safetySummary() {
  const m = safetyMatcher()
  const st = loadSafetyState()
  return {
    ...st,
    coreCount: m.coreCount,
    edgeCount: m.edgeCount,
    core: [...m.core.raw],
    edge: [...m.edge.raw],
    file: dataFile(TAGS_NAME),
  }
}

export function invalidateSafetyCache() {
  cache.tags.mtime = -1
  cache.state.mtime = -1
}
