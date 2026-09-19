/** 格式化与字符串小工具 */

export function nfmt(n) {
  const v = Number(n) || 0
  return v.toLocaleString('zh-CN')
}

export function bytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`
  return `${(v / 1073741824).toFixed(2)} GB`
}

export function ms(v) {
  const n = Number(v) || 0
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`
}

export function ts(v) {
  const d = new Date(Number(v) || 0)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只保留最后两段路径, 卡片上显示用(完整路径太长) */
export function shortPath(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/)
  return parts.length > 1 ? parts.slice(-2).join('\\') : p
}

export function basename(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** 截断标签串, 超过 n 个用 "..." 收尾 */
export function clipTags(tags, n) {
  const arr = tags || []
  const head = arr.slice(0, n).join(', ')
  return arr.length > n ? `${head}, ...` : head
}

/** 下划线转空格(SD 提示词更自然的写法) */
export function normTag(t) { return String(t).replace(/_/g, ' ') }
export function normTags(list) { return (list || []).map(normTag) }

/* ---------------- 角色/系列标签判定(与后端 dataset.js 保持一致) ---------------- */
const NON_SERIES_GROUPS = new Set([
  'general', 'character', 'copyright', 'artist', 'meta', 'rating',
  'symbol', 'medium', 'clothing', 'clothes', 'place', 'object', 'language',
  'spoiler', 'photobomb', 'copy', 'text', 'icon', 'logo', 'banner',
  'frame', 'panel', 'source', 'audio', 'video', 'file', 'link',
  'other', 'unknown', 'series', 'work', 'style', 'theme',
  'shape', 'color', 'colour', 'size', 'pattern', 'pose', 'type',
  'category', 'tag', 'group', 'cosplay', 'artwork', 'image',
  'food', 'animal', 'plant', 'vehicle', 'furniture', 'instrument',
  'nature', 'weather', 'sky', 'water', 'fire', 'light', 'dark',
])

const RE_CHAR = /^.+_\((.+)\)$/

/** 带 _(系列) 的写法 */
export function hasSeriesSuffix(t) {
  return RE_CHAR.test(String(t))
}

/** 是否是真正的角色标签(排除 xxx_(general) 这类 Danbooru 分类) */
export function isCharTag(t) {
  const m = RE_CHAR.exec(String(t))
  if (!m) return false
  return !NON_SERIES_GROUPS.has(m[1].toLowerCase())
}

/** 角色标签去掉末尾 _(系列) */
export function charShortName(t) {
  return String(t).replace(/_\([^)]*\)$/, '')
}

/** 翻译结果形如「莉央(blue_archive)」, 去掉末尾的系列括号 */
export function stripZhSeries(zh) {
  return String(zh || '').replace(/\s*\([^()]*\)$/, '')
}
