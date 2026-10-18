/**
 * 替换规则「行模型 ↔ 文本」双向转换 —— 规则构建器的数据层
 * =========================================================
 * 文本格式(与后端 parseReplaceRules 逐字兼容, 见 electron/core/rules.js):
 *   模式 -> 标签1, 标签2          # 注释
 *   模式: 精确 x / 前缀 x* / 后缀 *x / 包含 *x* / 整段 @x@
 *   替换侧 {tag} = 命中时的原标签; {tag}_art = 原标签加后缀
 *
 * 行模型(构建器每行一条):
 *   { mode:'exact'|'pre'|'suf'|'con'|'seg', core:'boy',   // 不含任何通配符
 *     keep:true, suffix:'', repl:['male_focus'] }         // keep → 替换侧带 {tag}
 * 无法用行模型无损表达的行(模式里嵌 * / {tag} 出现多次等)收进 mode:'raw'
 * 原样保留 —— **绝不丢语义**, 只是那种行要回「原文模式」改。
 *
 * 注释收纳(2026-10-18 用户拍板): 构建器顶部/尾部各留一个注释编辑区;
 * 行与行之间的注释在解析时**收集到尾部**, 序列化时写在规则后面 —— 不丢, 但不挡行。
 */

/** 单行文本 → 行模型; 无法表达返回 null(调用方落 raw)
 *  删除语义(2026-10-18): 替换侧为空(`pat ->`) = 命中即删除该标签, 行模型 keep:'del' */
export function parseLine(s) {
  const i = s.indexOf('->')
  if (i < 0) return null
  const pat = s.slice(0, i).trim().toLowerCase()
  if (!pat) return null

  // 模式侧 → (mode, core); core 里还剩 * 就是表达不了的形态
  let mode = 'exact'
  let core = pat
  if (pat.length > 2 && pat.startsWith('@') && pat.endsWith('@')) {
    mode = 'seg'; core = pat.slice(1, -1)
  } else if (pat.startsWith('*') && pat.endsWith('*') && pat.length > 2) {
    mode = 'con'; core = pat.slice(1, -1)
  } else if (pat.startsWith('*')) {
    mode = 'suf'; core = pat.slice(1)
  } else if (pat.endsWith('*')) {
    mode = 'pre'; core = pat.slice(0, -1)
  }
  if (!core || core.includes('*')) return null

  const replTags = s.slice(i + 2).split(',').map((x) => x.trim()).filter(Boolean)

  // 替换侧为空 = 删除规则
  if (!replTags.length) return { mode, core, keep: 'del', suffix: '', repl: [] }

  // 替换侧 → (keep, suffix, repl); {tag} 出现一次以内才可表达
  const nPh = replTags.join(',').match(/\{tag\}/gi)?.length || 0
  if (nPh > 1) return null
  const keep = nPh === 1
  const repl = []
  let suffix = ''
  for (const t of replTags) {
    const m = t.match(/^\{tag\}(.*)$/i)
    if (m) suffix = m[1]
    else repl.push(t)
  }
  return { mode, core, keep, suffix, repl }
}

/** 行模型 → 单行文本(keep:'del' 序列化为 `pat ->`, 与后端删除语义同一份真源) */
export function serializeRow(row) {
  if (row.mode === 'raw') return row.text
  let pat = row.core
  if (row.mode === 'seg') pat = `@${row.core}@`
  else if (row.mode === 'con') pat = `*${row.core}*`
  else if (row.mode === 'suf') pat = `*${row.core}`
  else if (row.mode === 'pre') pat = `${row.core}*`
  if (row.keep === 'del') return `${pat} ->`
  const replTags = row.keep ? [`{tag}${row.suffix || ''}`, ...row.repl] : [...row.repl]
  return `${pat} -> ${replTags.join(', ')}`
}

/**
 * 整段文本 → { headNotes, rows, tailNotes }
 *   headNotes: 第一条规则行之前的注释/空行(含文件头的分组说明)
 *   tailNotes: 行间注释统一收集到这里 + 规则行之后的所有内容
 */
export function parseRules(text) {
  const headNotes = []
  const rows = []
  const tailNotes = []
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    const isRule = s && !s.startsWith('#') && s.includes('->') && parseLine(s)
    if (isRule) {
      rows.push(parseLine(s))
      continue
    }
    // 注释/空行/表达不了的行
    if (s && !s.startsWith('#') && s.includes('->')) {
      tailNotes.push(line)   // 规则形态但解析不了 → 原样进尾部, 不丢
    } else if (!rows.length) {
      headNotes.push(line)   // 还没出现规则行 → 属于文件头
    } else {
      tailNotes.push(line)
    }
  }
  return { headNotes, rows, tailNotes }
}

/** { headNotes, rows, tailNotes } → 整段文本(与 parseRules 语义互逆, raw 行原样) */
export function serializeRules({ headNotes = [], rows = [], tailNotes = [] } = {}) {
  const head = headNotes.join('\n')
  const body = rows.map(serializeRow).filter(Boolean).join('\n')
  const tail = tailNotes.join('\n')
  const parts = []
  if (head.trim()) parts.push(head.replace(/\n+$/, '') + '\n')
  if (body) parts.push(body)
  if (tail.trim()) parts.push((parts.length ? '\n' : '') + tail.replace(/^\n+/, ''))
  return parts.join('\n') + (parts.length ? '\n' : '')
}

/** 类型下拉的选项(构建器行用) */
export const MODE_OPTIONS = [
  { value: 'exact', label: '精确', hint: 'tag 完全一致才命中', example: 'red_hair' },
  { value: 'pre', label: '前缀', hint: '以 … 开头', example: 'blue_*' },
  { value: 'suf', label: '后缀', hint: '以 … 结尾', example: '*_hair' },
  { value: 'con', label: '包含', hint: '包含 … 即命中', example: '*color*' },
  { value: 'seg', label: '整段', hint: '按 _ 切段逐段比, tomboy 不会误命中 @boy@', example: '@boy@' },
]
