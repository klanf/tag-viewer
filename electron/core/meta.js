/**
 * 用户元数据 user_meta.json —— 系列分类 / 自定义分类 / 隐藏分类 / 自定义角色 / 自定义封面
 * + 角色纠正层(char_series / char_names / hidden_chars)
 * 与 Python 版共用同一份文件(默认在 dataDir 下)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
import { DEFAULT_CATEGORIES } from './dataset.js'

const NAME = 'user_meta.json'
/* 自定义封面单独一份(2026-10-24): 值是**本机图片的绝对路径**, 属于用户数据,
 * 不能跟着 user_meta.json 一起随仓库分发 —— 之前混在里面, 开源时把 644 条
 * 本机路径(含私有目录名)带进了 git 历史。现在走 DATA_ROUTE 落到 user/ 下,
 * 不进仓库; 老文件里的 custom_covers 在首次加载时自动搬过来并从原文件删掉。 */
const COVERS_NAME = 'user_covers.json'

function defaults() {
  return {
    categories: { ...DEFAULT_CATEGORIES },
    custom_categories: [],
    hidden_categories: [],
    custom_chars: {},
    // 自定义封面(2026-10-06): series[系列名] / chars[角色tag] -> 图片绝对路径。
    // 用户在系列页点卡片的 ⚙️ 从该系列/角色的图里挑的; 空段不占事。
    // 运行时由 user_covers.json 合并进来(见 loadUserMeta), 不落 user_meta.json。
    custom_covers: { series: {}, chars: {} },
    /* 角色纠正层(2026-10-21) —— 用户的判断压过自动来源(括号自述 / 角色库推导):
     *   char_series: { [tag]: 系列 }   把角色挪到指定系列(空值 = 恢复自动)
     *   char_names:  { [tag]: 显示名 } 卡片显示名覆盖(空值 = 恢复)
     *   hidden_chars: [tag...]         屏蔽推错的角色(系列页不出现, 也不参与系列计数)
     * 与 custom_chars 的区别: custom_chars 是"补角色", 这里是"纠正已有角色"。
     * 键统一小写(tag 大小写不敏感), char_names 的值保留原大小写。 */
    char_series: {},
    char_names: {},
    hidden_chars: [],
  }
}

/** 标签字典: key 统一小写; lowerValue 用于系列名(也是大小写不敏感的) */
function normTagMap(raw, { lowerValue = false } = {}) {
  const d = {}
  if (!raw || typeof raw !== 'object') return d
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') continue
    const key = String(k || '').trim().toLowerCase()
    const val = v.trim()
    if (!key || !val) continue
    d[key] = lowerValue ? val.toLowerCase() : val
  }
  return d
}

function normTagList(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean))]
}

function normCovers(raw) {
  const d = { series: {}, chars: {} }
  if (!raw || typeof raw !== 'object') return d
  for (const kind of ['series', 'chars']) {
    const sec = raw[kind]
    if (sec && typeof sec === 'object') {
      for (const [k, v] of Object.entries(sec)) {
        if (typeof v === 'string' && v.trim()) d[kind][k] = v.trim()
      }
    }
  }
  return d
}

function buildMeta(raw, d) {
  return {
    categories: raw.categories && typeof raw.categories === 'object'
      ? { ...d.categories, ...raw.categories } : d.categories,
    custom_categories: Array.isArray(raw.custom_categories) ? raw.custom_categories : [],
    hidden_categories: Array.isArray(raw.hidden_categories) ? raw.hidden_categories : [],
    custom_chars: raw.custom_chars && typeof raw.custom_chars === 'object' ? raw.custom_chars : {},
    custom_covers: d.custom_covers,
    char_series: normTagMap(raw.char_series, { lowerValue: true }),
    char_names: normTagMap(raw.char_names),
    hidden_chars: normTagList(raw.hidden_chars),
  }
}

/** 封面表: 没有文件返回 null(区别于"文件在但内容为空") */
function loadCovers() {
  try {
    const p = dataFile(COVERS_NAME)
    if (!fs.existsSync(p)) return null
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return normCovers(raw)
  } catch {
    return null
  }
}

function saveCovers(covers) {
  try {
    const p = dataFile(COVERS_NAME)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(normCovers(covers), null, 2), 'utf8')
    return true
  } catch (e) {
    saveCovers.lastError = e?.message || String(e)
    return false
  }
}
saveCovers.lastError = ''

function coversEmpty(c) {
  return !Object.keys(c.series || {}).length && !Object.keys(c.chars || {}).length
}

/** 老 user_meta.json 里的 custom_covers 搬走 + 从原文件删掉(只删这一个键) */
function migrateLegacyCovers(p, raw, covers) {
  if (!coversEmpty(covers)) saveCovers(covers)
  delete raw.custom_covers
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8')
  } catch {
    // 删不掉就下次再试; 无论如何不再把这份路径写回 user_meta.json
  }
}

export function loadUserMeta() {
  const p = dataFile(NAME)
  const d = defaults()
  let raw = null
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed === 'object') raw = parsed
    } catch {
      raw = null
    }
  }
  if (!raw) return d

  const covers = loadCovers()
  if (covers) {
    d.custom_covers = covers
    if (Object.prototype.hasOwnProperty.call(raw, 'custom_covers')) migrateLegacyCovers(p, raw, covers)
    return buildMeta(raw, d)
  }
  const legacy = normCovers(raw.custom_covers)
  d.custom_covers = legacy
  if (Object.prototype.hasOwnProperty.call(raw, 'custom_covers')) migrateLegacyCovers(p, raw, legacy)
  return buildMeta(raw, d)
}

export function saveUserMeta(meta) {
  try {
    const p = dataFile(NAME)
    // custom_covers 归 user_covers.json, 这里无论如何都不写回(否则本机路径又进 git)
    const body = { ...meta }
    delete body.custom_covers
    // 数据目录可能还没建(首次启动/换过 dataDir/沙箱测试): 直接 writeFile 是 ENOENT,
    // 而原来这里 catch 掉只 return false, 上层又把它当"存好了", 用户看到的就是
    // "点了没反应、也没报错"。先补目录、再把原因带出去。
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(body, null, 2), 'utf8')
    return true
  } catch (e) {
    saveUserMeta.lastError = e?.message || String(e)
    return false
  }
}
saveUserMeta.lastError = ''

/**
 * 增量合并更新: 顶层字段按 key 合并, custom_chars 按**系列**整体替换。
 * (早先是并集, 于是分类管理里删掉的角色下一次保存又会被加回来。)
 * 返回更新后的完整 meta。
 */
export function patchUserMeta(body) {
  const meta = loadUserMeta()
  if (!body || typeof body !== 'object') return { meta }

  if (body.categories && typeof body.categories === 'object') {
    Object.assign(meta.categories, body.categories)
  }
  if (Array.isArray(body.custom_categories)) meta.custom_categories = body.custom_categories
  if (Array.isArray(body.hidden_categories)) meta.hidden_categories = body.hidden_categories
  if (body.custom_chars && typeof body.custom_chars === 'object') {
    for (const [k, v] of Object.entries(body.custom_chars)) {
      if (!Array.isArray(v)) continue
      const arr = [...new Set(v.map((t) => String(t || '').trim()).filter(Boolean))]
      if (arr.length) meta.custom_chars[k] = arr
      else delete meta.custom_chars[k]
    }
  }
  // 角色纠正层: 空串 = 删除该条(恢复自动识别)
  for (const [field, opts] of [['char_series', { lowerValue: true }], ['char_names', {}]]) {
    const sec = body[field]
    if (!sec || typeof sec !== 'object') continue
    for (const [k, v] of Object.entries(sec)) {
      const key = String(k || '').trim().toLowerCase()
      if (!key) continue
      const val = typeof v === 'string' ? v.trim() : ''
      if (!val) delete meta[field][key]
      else meta[field][key] = opts.lowerValue ? val.toLowerCase() : val
    }
  }
  if (Array.isArray(body.hidden_chars)) meta.hidden_chars = normTagList(body.hidden_chars)
  // 自定义封面: path 为空串 = 清除该条(恢复自动挑选)。单独存 user_covers.json。
  let coversError = ''
  if (body.custom_covers && typeof body.custom_covers === 'object') {
    for (const kind of ['series', 'chars']) {
      const sec = body.custom_covers[kind]
      if (!sec || typeof sec !== 'object') continue
      for (const [k, v] of Object.entries(sec)) {
        const clean = String(v || '').trim()
        if (!clean) delete meta.custom_covers[kind][k]
        else meta.custom_covers[kind][k] = clean
      }
    }
    if (!saveCovers(meta.custom_covers)) coversError = `写入 user_covers.json 失败: ${saveCovers.lastError}`
  }
  const ok = saveUserMeta(meta)
  return { meta, ok: ok && !coversError, error: coversError || (ok ? '' : `写入 user_meta.json 失败: ${saveUserMeta.lastError}`) }
}
