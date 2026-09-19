/**
 * 提示词 -> 标签列表
 * ================
 * 移植自 import_png_tags.parse_tags。规则:
 *   - 只滤两类: 质量词(masterpiece/best_quality/...)、@开头的画师串。
 *     其余内容标签(day / sunlight / uncensored / sparse pubic hair ...)全部保留。
 *   - 去权重: (xxx:1.2) / (xxx:1.2:0.8) -> xxx
 *   - 括号分两种, 不能一起删:
 *       未转义的 ( ) 是权重括号 -> 删掉;
 *       转义的 \( \) 是标签本身的组成部分(如 hoshino \(blue archive\)) -> 还原成真括号。
 *     这条踩过坑: 一律 re.sub(/[()]/g,'') 会把 hoshino_(blue_archive) 压成
 *     hoshino_blue_archive, 角色/系列就再也认不出来。
 *   - 空格 -> 下划线, 去重保序。
 */

const QUALITY_TAGS = new Set([
  'masterpiece', 'best_quality', 'high_quality', 'worst_quality', 'low_quality',
  'newest', 'high_resolution', 'aesthetic', 'excellent', 'safe', 'absurdres',
])

const RE_WEIGHT = /^\((.+?)(?::[\d.]+){1,2}\)$/
const RE_QUALITY_NUM = /^(score|year)_?\d*$/

/**
 * 判断一个 part 是否是「danbooru 式词尾括号 tag」(如 kazusa_(blue_archive))。
 * 特征: 括号平衡、未转义括号不在词头(词头的 (xxx) 是强调权重)、无权重冒号(:1.2)。
 * ComfyUI 的 CLIP 语法不解析括号权重 —— 它写出的角色 tag 括号是字面字符,
 * 不能像 A1111 那样一律剥掉(剥了角色就再也认不出来, 2026-09-18 实测 kazusa)。
 */
function isDanbooruParenTag(s) {
  if (!s.includes('(')) return false
  if (s.trimStart().startsWith('(')) return false
  if (/:[\d.]/.test(s.replace(/\\[()]/g, ''))) return false
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth < 0) return false }
  }
  return depth === 0
}

export function promptToTags(prompt) {
  const tags = []
  if (typeof prompt !== 'string' || !prompt) return tags

  const seen = new Set()
  for (const raw of prompt.split(',')) {
    let part = raw.trim()
    if (!part) continue

    const m = RE_WEIGHT.exec(part)
    if (m) part = m[1].trim()
    if (!part) continue
    if (part.startsWith('@')) continue                      // 画师串
    if (part.includes('<lora:')) continue                   // LoRA 标记

    if (isDanbooruParenTag(part)) {
      // 词尾式 tag 括号(kazusa_(blue_archive) / kazusa_(band)_(blue_archive)):
      // 保留括号原样, 只还原转义写法 —— 这些括号是 tag 的组成部分, 不是权重
      part = part.replace(/\\\(/g, '(').replace(/\\\)/g, ')')
      part = part.replace(/\\/g, '')
    } else {
      // 先删未转义的括号(权重强调), 再把转义括号还原
      part = part.replace(/(?<!\\)[()]/g, '')
      part = part.replace(/\\\(/g, '(').replace(/\\\)/g, ')')
      part = part.replace(/\\/g, '')
    }
    part = part.replace(/\s+/g, '_').replace(/^_+|_+$/g, '')
    if (!part) continue

    const low = part.toLowerCase()
    if (QUALITY_TAGS.has(low) || RE_QUALITY_NUM.test(low)) continue
    if (seen.has(part)) continue
    seen.add(part)
    tags.push(part)
  }
  return tags
}

/** 去重保序 —— 工作流常把同一标签写两遍(基础串一次、内容段再一次) */
export function dedupeTags(tags) {
  const seen = new Set()
  const out = []
  for (const t of tags) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
