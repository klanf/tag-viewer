/**
 * 用户元数据 user_meta.json —— 系列分类 / 自定义分类 / 隐藏分类 / 自定义角色 / 自定义封面
 * 与 Python 版共用同一份文件(默认在 dataDir 下)。
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'
import { DEFAULT_CATEGORIES } from './dataset.js'

const NAME = 'user_meta.json'

function defaults() {
  return {
    categories: { ...DEFAULT_CATEGORIES },
    custom_categories: [],
    hidden_categories: [],
    custom_chars: {},
    // 自定义封面(2026-10-06): series[系列名] / chars[角色tag] -> 图片绝对路径。
    // 用户在系列页点卡片的 ⚙️ 从该系列/角色的图里挑的; 空段不占事。
    custom_covers: { series: {}, chars: {} },
  }
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

export function loadUserMeta() {
  const p = dataFile(NAME)
  const d = defaults()
  if (!fs.existsSync(p)) return d
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object') return d
    return {
      categories: raw.categories && typeof raw.categories === 'object'
        ? { ...d.categories, ...raw.categories } : d.categories,
      custom_categories: Array.isArray(raw.custom_categories) ? raw.custom_categories : [],
      hidden_categories: Array.isArray(raw.hidden_categories) ? raw.hidden_categories : [],
      custom_chars: raw.custom_chars && typeof raw.custom_chars === 'object' ? raw.custom_chars : {},
      custom_covers: normCovers(raw.custom_covers),
    }
  } catch {
    return d
  }
}

export function saveUserMeta(meta) {
  try {
    fs.writeFileSync(dataFile(NAME), JSON.stringify(meta, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 增量合并更新(深度合并 custom_chars, 避免整表替换冲掉别的系列)。
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
      const cur = meta.custom_chars[k] || []
      meta.custom_chars[k] = [...new Set([...cur, ...v])]
    }
  }
  // 自定义封面: path 为空串 = 清除该条(恢复自动挑选)
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
  }
  const ok = saveUserMeta(meta)
  return { meta, ok }
}
