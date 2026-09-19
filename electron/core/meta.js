/**
 * 用户元数据 user_meta.json —— 系列分类 / 自定义分类 / 隐藏分类 / 自定义角色
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
  }
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
  const ok = saveUserMeta(meta)
  return { meta, ok }
}
