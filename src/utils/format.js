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

/**
 * 时长(给人看的) —— 用于「多久后自动导出」这类文案。
 * 1500 -> "1.5 秒", 60000 -> "1 分钟", 180000 -> "3 分钟"
 * (与上面的 ms() 分工不同: ms() 是量耗时用的 "12.34 s", 这个是人话)
 */
export function dur(v) {
  const n = Math.max(0, Number(v) || 0)
  if (n < 60000) {
    const s = n / 1000
    return `${Number.isInteger(s) ? s : s.toFixed(1)} 秒`
  }
  const m = n / 60000
  return `${Number.isInteger(m) ? m : m.toFixed(1)} 分钟`
}

export function ts(v) {
  const d = new Date(Number(v) || 0)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只保留最后两段路径, 卡片上显示用(完整路径太长) */
/**
 * 像素尺寸 -> CSS `aspect-ratio` 字符串; 有任一维缺失/非法就返回**空串**。
 *
 * 消费方一律写成 `ratioOf(w, h) || '9 / 16'`: 回落值必须与改动前完全一致,
 * 这样"老库还没回填尺寸 / 文件头读不出来"的那些图, 行为一点不变 ——
 * 引入新特性时最怕的就是顺手把老路径也改了。
 */
export function ratioOf(w, h) {
  const W = Number(w) || 0
  const H = Number(h) || 0
  return (W > 0 && H > 0) ? `${W} / ${H}` : ''
}

/**
 * 安全模式判定 —— 与主进程 `core/safety.js` 的 `hiddenAt` 是**同一套语义**。
 * 前端不能 import 主进程模块, 所以这里有一份等价实现; 改判定规则时两边必须一起改。
 *
 *   unsafe 0 = 干净            -> 两档都不藏
 *   unsafe 1 = 命中 core 段    -> 两档都藏
 *   unsafe 2 = 只命中 edge 段  -> 只有 edge 档藏, core 档放行
 *
 * 用数值比较而不是在前端重跑标签匹配: 标记是**读数据集时**在主进程算好的
 * (见 dataset.js 的 pushRecord), 于是切开关/切档位只是换个 0/1/2 的比较,
 * 八万行数据一行都不用重载。
 */
export function hiddenBySafety(unsafe, level) {
  const u = Number(unsafe) || 0
  if (u <= 0) return false
  return u === 1 || level === 'edge'
}

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
  /* 下面这批由四份反推词表(v0.9 + v1.0 的 1008/336/672)统计得出:
   * 这些括号组名下**从来没有** character/copyright 标签, 全是道具、部位、
   * 材质、概念。缺了它们, xxx_(weapon) 这种就会被括号兜底当成作品系列。 */
  'weapon', 'polearm', 'projectile', 'sword', 'bow', 'armor', 'helmet',
  'scabbard', 'mecha', 'mask', 'headwear', 'headdress', 'hat', 'hair',
  'hairstyle', 'makeup', 'cosmetics', 'piercing', 'jewelry', 'ornament',
  'decoration', 'glowstick', 'container', 'bottle', 'cup', 'bowl',
  'vessel', 'toy', 'doll', 'statue', 'sculpture', 'machine', 'robot',
  'tool', 'hardware', 'software', 'computing', 'board_game', 'chess',
  'flower', 'fruit', 'gemstone', 'stone', 'tree', 'seaweed', 'organ',
  'anatomy', 'species', 'constellation', 'planet', 'element', 'gold',
  'emblem', 'font', 'letter', 'phrase', 'meme', 'original', 'western',
  'fandom', 'trend', 'topic', 'site', 'city', 'structure', 'geometry',
  'texture', 'substance', 'action', 'gesture', 'riding', 'summon',
  'cheerleading', 'hanetsuki', 'sport', 'expression', 'sex', 'sexual',
  'nonsexual', 'mtf', 'ftm', 'otf', 'aircraft', 'automobile', 'brand',
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

/* ---------------- 通用大类配色(2026-10-17) ----------------
 * 通用段的韦林大类各占一个专属色相, 用于分组小节标题着色 + pill 左边条。
 * 序号对应 tokens.css 的 --sub-h1..--sub-h11, 三处(这里/标题/边条)必须同源。
 * 没进表的大类(含"其他")不着色, 维持中性灰。 */
export const GENERAL_SUB_HUE = {
  '人物': 1, '服饰': 2, '汉服': 3, '表情动作': 4, '物品': 5,
  '场景': 6, '环境': 7, '画面': 8, '镜头': 9, '魔法系': 10,
}
/** 取大类色相序号(0 = 不着色) */
export function subHueNo(sub) {
  return GENERAL_SUB_HUE[String(sub || '')] || 0
}
