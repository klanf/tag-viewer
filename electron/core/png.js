import { promptToTags } from './prompt.js'

/**
 * 从图片内嵌元数据里还原 AI 生成提示词
 * ====================================
 * 移植自旧版 Python 工具里的 extract_meta.py + tag_viewer_server.py。
 * 支持的来源与判定顺序:
 *   1. ComfyUI  —— prompt / workflow JSON, 走节点图解析(见下)
 *   2. ComfyUI  —— 通用兜底: 收集所有"可能的提示词字符串"取最长
 *   3. A1111 / Forge / SD.Next —— tEXt 'parameters', 取 'Negative prompt:' 之前
 *   4. NovelAI  —— Comment / Description 里的 JSON .prompt
 *   5. InvokeAI —— invokeai_metadata 里的 .positive_prompt
 *
 * ComfyUI 节点解析要点(踩过的坑都在这儿):
 *   * CLIPTextEncode 的 text 可能是「字面量字符串」也可能是「[nodeId, slot] 引用」。
 *     只有引用型才是拼装后的正面提示词; 字面量的那个往往是负面。
 *   * 所以要遍历全部 CLIPTextEncode, 解析引用取最长的那条, 不能"取第一个"。
 *   * ShowText|pysssss 保存了运行时的最终文本, 是唯一能捞回 FillRoles 角色串、
 *     外部 txt 内容的途径。但要防止误取"显示负面提示词的那个" —— 用
 *     「比 baseline 长 且 baseline 里 ≥8 字符的片段有一半以上能在它里面找到」来判定。
 *
 * 与原 Python 版的一处**有意修正**: iTXt 块的解析。
 * 原实现 `k,_,rest = data.partition(0)` 后又对 rest[2:] 做 partition(0), 只切了
 * languageTag, 剩下的 translatedKeyword\0text 被整体当成正文 —— 于是这类图片读出来的
 * 提示词前面会挂一段垃圾。这里按 PNG 规范正确跳过 languageTag 与 translatedKeyword。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const SCAN_IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

/** zlib 解压(zTXt / 压缩 iTXt 的正文); 坏数据返回 null */
function inflateOrNull(buf) {
  try { return zlib.inflateSync(buf) } catch { return null }
}

/**
 * 读 PNG 的 tEXt / iTXt 文本块 -> { 关键字: 内容 }
 * 用 fd + 定位读, 不把整张图读进内存(原图动辄几 MB)。
 * 遇到第一个 IDAT 就停 —— 图像数据之后不可能再有文本块。
 */
export function readPngTextChunks(filePath, maxBytes = 8 << 20) {
  const out = {}
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const sig = Buffer.alloc(8)
    if (fs.readSync(fd, sig, 0, 8, null) !== 8 || !sig.equals(PNG_SIG)) return out

    const head = Buffer.alloc(8)
    let read = 8
    const data = Buffer.alloc(Math.min(maxBytes, 4 << 20))

    while (read < maxBytes) {
      const n = fs.readSync(fd, head, 0, 8, read)
      if (n < 8) break
      read += 8
      const length = head.readUInt32BE(0)
      const ctype = head.toString('latin1', 4, 8)

      if (ctype === 'IDAT') break                       // 图像数据开始, 收工
      if (length > maxBytes || length < 0) break        // 异常长度, 防跑飞

      if (ctype === 'tEXt' || ctype === 'iTXt' || ctype === 'zTXt') {
        let buf = data
        if (length > data.length) buf = Buffer.alloc(length)
        const got = fs.readSync(fd, buf, 0, length, read)
        const chunk = buf.subarray(0, got)
        read += length + 4                              // + CRC
        try {
          if (ctype === 'tEXt') {
            const z = chunk.indexOf(0)
            if (z > 0) {
              out[chunk.toString('latin1', 0, z)] = chunk.toString('utf8', z + 1)
            }
          } else if (ctype === 'zTXt') {
            // zTXt: keyword\0 compression_method(1字节, 0=zlib) 压缩数据。
            // ComfyUI 的大块 workflow JSON 常用这种写入 —— 2026-10-20 起解压支持,
            // 之前一律跳过, 外来图会"识别不出元数据"。
            const z = chunk.indexOf(0)
            if (z > 0 && chunk[z + 1] === 0) {
              const raw = inflateOrNull(chunk.subarray(z + 2))
              if (raw) out[chunk.toString('latin1', 0, z)] = raw.toString('utf8')
            }
          } else {
            const z = chunk.indexOf(0)
            if (z <= 0) continue
            const key = chunk.toString('latin1', 0, z)
            const compFlag = chunk[z + 1]
            // iTXt: keyword\0 flag method langTag\0 translatedKeyword\0 text
            let p = z + 3
            const gt = chunk.indexOf(0, p)               // languageTag 结束
            if (gt < 0) continue
            p = gt + 1
            const gp = chunk.indexOf(0, p)               // translatedKeyword 结束
            if (gp < 0) continue
            if (compFlag === 0) {
              out[key] = chunk.toString('utf8', gp + 1)
            } else {
              // 压缩 iTXt(压的是 translatedKeyword\0 之后的正文): 同样解压
              const raw = inflateOrNull(chunk.subarray(gp + 1))
              if (raw) out[key] = raw.toString('utf8')
            }
          }
        } catch { /* 单个块坏了不影响其他块 */ }
      } else {
        read += length + 4                              // 其他块整体跳过
      }
    }
  } catch {
    /* 读不了就当没有元数据 */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
  }
  return out
}

// ---------------------------------------------------------- ComfyUI 节点图解析

/** 把输入值解析成字符串: 字面量直接用, [nodeId, slot] 引用则递归求值 */
function resolveText(val, nodes, depth = 0) {
  if (typeof val === 'string') return val
  if (depth > 10) return ''
  if (Array.isArray(val) && val.length === 2 && (typeof val[0] === 'number' || typeof val[0] === 'string')) {
    const node = nodes[String(val[0])]
    if (!node) return ''
    return resolveNode(node, nodes, depth + 1)
  }
  return ''
}

function weilinTempStr(ins) {
  const raw = ins?.temp_str
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let arr
  try { arr = JSON.parse(raw) } catch { return '' }
  if (!Array.isArray(arr)) return ''
  const out = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    if (it.isLoraTag) continue                        // <lora:xxx:0.8> 不是提示词标签
    const t = it.text
    if (typeof t !== 'string' || !t.trim()) continue
    // 纯标点词条丢弃: 没有任何字母数字且不含下划线
    if (!/[\p{L}\p{N}_]/u.test(t)) continue
    out.push(t.trim())
  }
  return out.join(', ')
}

const PASSTHROUGH_TEXT_NODES = new Set([
  'StringConstantMultiline', 'Int', 'Float', 'PrimitiveFloat',
  'PrimitiveString', 'Seed', 'PrimitiveInt',
])

function resolveNode(node, nodes, depth) {
  const ct = node.class_type || ''
  const ins = node.inputs || {}

  if (ct === 'CLIPTextEncode') return resolveText(ins.text, nodes, depth + 1)
  if (PASSTHROUGH_TEXT_NODES.has(ct)) {
    const v = ins.string ?? ins.Number ?? ins.value ?? ins.seed ?? ''
    return String(v)
  }
  if (ct === 'JoinStringMulti') {
    const n = parseInt(ins.inputcount ?? 1, 10) || 1
    const delim = typeof ins.delimiter === 'string' ? ins.delimiter : ''
    const parts = []
    for (let i = 1; i <= n; i++) parts.push(resolveText(ins[`string_${i}`] ?? '', nodes, depth + 1))
    return parts.join(delim)
  }
  if (ct === 'WeiLinPromptUIWithoutLora') {
    const s = weilinTempStr(ins)
    if (s) return s
    return resolveText(ins.positive ?? '', nodes, depth + 1)
  }
  if (ct === 'FillRoles') {
    // 真正调用 FillRoles 需要 ComfyUI 的 fill_roles_node 模块(随整合包走),
    // 独立应用里拿不到 —— 与原 Python 版一致: 返回空, 让 ShowText 兜底捞回角色串。
    return ''
  }
  if (ct === 'CR Text Blacklist') return resolveText(ins.text, nodes, depth + 1)
  if (ct === 'ShowText|pysssss') return resolveText(ins.text_0, nodes, depth + 1)

  for (const k of ['text', 'string', 'positive', 'prompt']) {
    if (k in ins && (typeof ins[k] === 'string' || Array.isArray(ins[k]))) {
      return resolveText(ins[k], nodes, depth + 1)
    }
  }
  return ''
}

/**
 * 挑出「拼装后最完整」的 ShowText|pysssss 文本。
 * 要求比 baseline 更长, 且 baseline 里长度 ≥8 的片段有一半以上能在它里面找到 ——
 * 否则可能抓到的只是显示负面提示词的那个 ShowText。
 */
function showTextBest(d, baseline) {
  if (!baseline) return ''
  const frags = baseline.split(/[,\n]/).map((f) => f.trim()).filter((f) => f.length >= 8)
  if (!frags.length) return ''
  const need = Math.max(1, Math.floor(frags.length / 2))
  let best = ''
  for (const node of Object.values(d)) {
    if (!node || typeof node !== 'object') continue
    if (node.class_type !== 'ShowText|pysssss') continue
    const t0 = (node.inputs || {}).text_0
    if (typeof t0 !== 'string' || t0.length <= baseline.length) continue
    let hit = 0
    for (const f of frags) if (t0.includes(f)) hit++
    if (hit >= need && t0.length > best.length) best = t0
  }
  return best
}

/** ComfyUI: 从 prompt JSON 里还原正面提示词 */
function comfyPositiveFromPromptJson(d) {
  let base = ''
  for (const node of Object.values(d)) {
    if (!node || typeof node !== 'object') continue
    if (node.class_type !== 'CLIPTextEncode') continue
    const t = (node.inputs || {}).text
    if (Array.isArray(t)) {
      const s = resolveText(t, d)
      if (s.length > base.length) base = s
    }
  }
  return showTextBest(d, base) || base
}

/** ComfyUI: 通用兜底 —— 收集全部"可能的提示词字符串"取最长的 */
function comfyPositiveGeneric(chunks) {
  let best = ''
  const consider = (c) => {
    if (typeof c !== 'string') return
    const s = c.trim()
    if (s.length > best.length) best = s
  }
  for (const key of ['prompt', 'workflow']) {
    const raw = chunks[key]
    if (!raw) continue
    let d
    try { d = JSON.parse(raw) } catch { continue }
    if (!d || typeof d !== 'object') continue

    if (Array.isArray(d.nodes)) {
      // workflow(UI 格式)
      for (const n of d.nodes) {
        if (!n || typeof n !== 'object') continue
        const wv = n.widgets_values || []
        if (n.type === 'ShowText|pysssss') {
          for (const v of wv) consider(v)
        } else if (n.type === 'CLIPTextEncode') {
          if (typeof wv[0] === 'string') consider(wv[0])
        } else if (n.type === 'WeiLinPromptUIWithoutLora') {
          for (const v of wv) {
            if (typeof v === 'string' && v.trimStart().startsWith('[')) consider(weilinTokensRaw(v))
          }
        }
      }
    } else {
      // prompt(API 格式)
      for (const n of Object.values(d)) {
        if (!n || typeof n !== 'object') continue
        const ct = n.class_type
        const ins = n.inputs || {}
        if (ct === 'ShowText|pysssss') consider(ins.text_0)
        else if (ct === 'CLIPTextEncode') consider(ins.text)
        else if (ct === 'WeiLinPromptUIWithoutLora') {
          if (typeof ins.temp_str === 'string') consider(weilinTokensRaw(ins.temp_str))
        }
      }
    }
  }
  return best.length > 3 ? best : ''
}

/** 通用兜底里那份 WeiLin temp_str 解析(不做标点过滤, 与原版一致) */
function weilinTokensRaw(raw) {
  let arr
  try { arr = JSON.parse(raw) } catch { return '' }
  if (!Array.isArray(arr)) return ''
  const out = []
  for (const it of arr) {
    if (it && typeof it === 'object' && !it.isLoraTag) {
      const t = it.text
      if (typeof t === 'string' && t.trim()) out.push(t.trim())
    }
  }
  return out.join(', ')
}

/** 负面提取用的 WeiLin 解析: 保留 lora 词条(2026-11-10: 有用户把 lora 塞进负面元数据) */
function weilinTokensKeepLora(raw) {
  let arr
  try { arr = JSON.parse(raw) } catch { return '' }
  if (!Array.isArray(arr)) return ''
  const out = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const t = it.text
    if (typeof t === 'string' && t.trim()) out.push(t.trim())
  }
  return out.join(', ')
}

// ---------------------------------------------------------------- 负面提示词 + LoRA(2026-11-10)

const LORA_RE = /<lora:([^:<>]+):([+-]?[\d.]+)(?::[^>]*)?>/gi

/** 从正/负面原文里收 <lora:名字:权重>(含可选第三段 block weight); 同名只留首个(正面优先)。
 *  权重保留原始写法(0.80 不折成 0.8), 复制出去要跟作者写的一字一样。 */
function collectLoras(texts) {
  const out = []
  const seen = new Set()
  for (const { label, text } of texts) {
    if (!text) continue
    for (const m of text.matchAll(LORA_RE)) {
      const name = m[1].trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, weight: m[2], src: label })
    }
  }
  return out
}

/** A1111 parameters 串里的负面段: 'Negative prompt:' 起到设置行(Steps:/Seed: 等)前 */
function a1111Negative(parameters) {
  const i = parameters.indexOf('Negative prompt:')
  if (i < 0) return ''
  const rest = parameters.slice(i + 'Negative prompt:'.length)
  const m = rest.match(/\n\s*(?:Steps|Size|Seed|Model|Sampler|CFG scale|Denoising|Clip skip|Version|Hashes|Schedule|Noise Schedule|Eta)\b[^:\n]*:/)
  return (m ? rest.slice(0, m.index) : rest).trim()
}

/** 数字权重收敛成短写法: 节点里的 strength 常带浮点尾数(0.7500000000000001), 收敛到 0.75 */
function fmtNodeWeight(w) {
  if (typeof w === 'number') return String(+w.toPrecision(6))
  return String(w)
}

/** 节点级 LoRA 收集(2026-11-10): ComfyUI 的 lora 常常不写进提示词文本, 而是走加载器节点挂,
 *  提示词原文里根本搜不到 <lora:...> —— 要认两类节点:
 *   - LoraLoader 系(LoraLoader / LoraLoaderModelOnly / 其他 *lora* 类): inputs.lora_name + strength_model
 *   - rgthree Power Lora Loader: inputs.lora_N = {on, lora, strength}, on:false 的没参与生成, 跳过
 *  API 格式(prompt 块, 对象图)和 UI 格式(workflow 块, nodes 数组 + widgets_values)都认。 */
function collectNodeLoras(chunks) {
  const out = []
  const push = (name, weight) => {
    if (!name || typeof name !== 'string') return
    const n = name.replace(/\\/g, '/').split('/').pop().replace(/\.safetensors$/i, '').trim()
    if (!n) return
    out.push({ name: n, weight: fmtNodeWeight(weight), src: '节点' })
  }
  const grabInputs = (ins) => {
    if (!ins || typeof ins !== 'object') return
    if (typeof ins.lora_name === 'string' && ins.lora_name) {
      push(ins.lora_name, ins.strength_model ?? ins.strength_clip ?? ins.strength)
      return
    }
    for (const [k, v] of Object.entries(ins)) {
      if (k === 'PowerLoraLoaderHeaderWidget') continue
      if (v && typeof v === 'object' && typeof v.lora === 'string' && 'strength' in v) {
        if (v.on === false) continue
        push(v.lora, v.strength)
      }
    }
  }
  for (const key of ['prompt', 'workflow']) {
    const raw = chunks[key]
    if (!raw) continue
    let d
    try { d = JSON.parse(raw) } catch { continue }
    if (!d || typeof d !== 'object') continue
    if (Array.isArray(d.nodes)) {
      for (const n of d.nodes) {
        if (!n || typeof n !== 'object' || !/lora/i.test(String(n.type || ''))) continue
        if (/Power\s*Lora/i.test(String(n.type))) {
          for (const v of n.widgets_values || []) {
            if (v && typeof v === 'object' && typeof v.lora === 'string' && 'strength' in v) {
              if (v.on === false) continue
              push(v.lora, v.strength)
            }
          }
        } else if (typeof (n.widgets_values || [])[0] === 'string') {
          push(n.widgets_values[0], n.widgets_values[1])   // LoraLoader UI 格式: [lora_name, sm, sc]
        } else {
          grabInputs(n.inputs)
        }
      }
    } else {
      for (const n of Object.values(d)) {
        if (!n || typeof n !== 'object' || !/lora/i.test(String(n.class_type || ''))) continue
        grabInputs(n.inputs)
      }
    }
  }
  return out
}

/** ComfyUI prompt JSON(API 格式): 找采样器节点, 顺着 negative 链取负面文本 */
function comfyNegativeFromPromptJson(d) {
  for (const n of Object.values(d)) {
    if (!n || typeof n !== 'object') continue
    if (!/Sampler/i.test(String(n.class_type || ''))) continue
    const neg = (n.inputs || {}).negative
    if (!Array.isArray(neg) || !neg.length) continue
    const target = d[String(neg[0])]
    if (!target || typeof target !== 'object') continue
    const ins = target.inputs || {}
    const ct = String(target.class_type || '')
    if (typeof ins.text === 'string' || Array.isArray(ins.text)) return resolveText(ins.text, d)
    if (ct === 'ShowText|pysssss' && typeof ins.text_0 === 'string') return ins.text_0
    if (/WeiLin/.test(ct) && typeof ins.temp_str === 'string') return weilinTokensKeepLora(ins.temp_str)
  }
  return ''
}

/** ComfyUI 通用兜底: 收全部候选文本, 剔除「内容在正面里出现过」的, 取最长的当负面 */
function comfyNegativeGeneric(chunks, positive) {
  const frags = positive ? positive.split(/[,\n]/).map((f) => f.trim()).filter((f) => f.length >= 8) : []
  const candidates = []
  const consider = (s) => { if (typeof s === 'string' && s.trim()) candidates.push(s.trim()) }
  for (const key of ['prompt', 'workflow']) {
    const raw = chunks[key]
    if (!raw) continue
    let d
    try { d = JSON.parse(raw) } catch { continue }
    if (!d || typeof d !== 'object') continue
    if (Array.isArray(d.nodes)) {
      for (const n of d.nodes) {
        if (!n || typeof n !== 'object') continue
        const wv = n.widgets_values || []
        if (n.type === 'ShowText|pysssss') { for (const v of wv) consider(v) }
        else if (n.type === 'CLIPTextEncode' && typeof wv[0] === 'string') consider(wv[0])
        else if (n.type === 'WeiLinPromptUIWithoutLora') {
          for (const v of wv) {
            if (typeof v !== 'string' || !v.trim()) continue
            if (v.trimStart().startsWith('[')) consider(weilinTokensKeepLora(v))
            else consider(v)
          }
        }
      }
    } else {
      for (const n of Object.values(d)) {
        if (!n || typeof n !== 'object') continue
        const ct = n.class_type
        const ins = n.inputs || {}
        if (ct === 'ShowText|pysssss') consider(ins.text_0)
        else if (ct === 'CLIPTextEncode' && typeof ins.text === 'string') consider(ins.text)
        else if (ct === 'WeiLinPromptUIWithoutLora' && typeof ins.temp_str === 'string') consider(weilinTokensKeepLora(ins.temp_str))
      }
    }
  }
  let best = ''
  for (const c of candidates) {
    if (positive && c === positive.trim()) continue
    if (positive && c.includes(positive.trim())) continue
    // 正面里 ≥8 字符的片段在候选里占一半以上 = 它就是正面, 跳过
    if (frags.length) {
      let hit = 0
      for (const f of frags) if (c.includes(f)) hit++
      if (hit >= Math.max(1, Math.floor(frags.length / 2))) continue
    }
    if (c.length > best.length) best = c
  }
  return best
}

/** 提示词里各 tag 的权重(2026-11-10 光箱展示用): (tag:1.2) / (tag:1.2:0.8) → '1.2' / '1.2:0.8'。
 *  名字归一化与 promptToTags 同一套(剥权重括号/还原转义/下划线化), key 直接对上展示层的 tag。
 *  无权重的词条不进表(展示层权重开关关掉或没有时 pill 照旧)。
 * @returns {Record<string, string>} tag -> 权重写法(保留作者原样, 0.80 不折 0.8) */
export function promptTagWeights(prompt) {
  const out = {}
  if (typeof prompt !== 'string' || !prompt) return out
  for (const raw of prompt.split(',')) {
    const part = raw.trim()
    const m = /^\((.+?):([\d.]+)(?::([\d.]+))?\)$/.exec(part)
    if (!m) continue
    const w = m[3] ? `${m[2]}:${m[3]}` : m[2]
    // 名字部分走 promptToTags 归一化(它自己会剥外层权重括号/还原转义括号/转下划线)
    const t = promptToTags(m[1])[0]
    if (t && !(t in out)) out[t] = w
  }
  return out
}

// ------------------------------------------------------------------ 对外接口

const SOURCE_LABELS = {
  comfyui: 'ComfyUI',
  a1111: 'A1111 / Forge',
  novelai: 'NovelAI',
  invokeai: 'InvokeAI',
}

export function sourceLabel(src) { return SOURCE_LABELS[src] || '' }

/**
 * 提取正面提示词。
 * @returns {{ text: string, source: string }} source 为 '' 表示没识别出元数据
 */
export function extractImagePrompt(filePath) {
  const { text, source } = extractImageMeta(filePath)
  return { text, source }
}

/**
 * 完整元数据提取(2026-11-10): 正面 + 负面 + LoRA 清单, 只读一次 PNG 文本块。
 * 热路径(扫描 worker)仍用 extractImagePrompt —— 语义同旧版, 零额外成本;
 * 光箱单图打开才走这里(负面/LoRA 只有详情展示需要)。
 * 2026-11-10 二版: nl 回译从这撤了(meta_nl 整句匹配退役) —— nl 词的中文/分类
 * 改由 nl-bank 片段索引供给(translate.js 补中文 + tagcats 归类), 胶囊自己长中文。
 * @returns {{ text, source, negative, loras: [{name, weight, src}] }}
 */
export function extractImageMeta(filePath) {
  const chunks = readPngTextChunks(filePath)
  if (!Object.keys(chunks).length) return { text: '', source: '', negative: '', loras: [] }

  const positive = extractPositiveFromChunks(chunks)
  const negative = extractNegativeFromChunks(chunks, positive.text)
  // 内联 <lora:...>(文本里写的)优先, 节点级(加载器挂的)兜底 —— 同名只留前者
  const inline = collectLoras([{ label: '正面', text: positive.text }, { label: '负面', text: negative }])
  const seen = new Set(inline.map((l) => l.name.toLowerCase()))
  const loras = [...inline]
  for (const l of collectNodeLoras(chunks)) {
    const key = l.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    loras.push(l)
  }
  return { ...positive, negative, loras }
}

function extractPositiveFromChunks(chunks) {
  // 0) 自建 SaveImageEx 节点写入的「本张实际使用的提示词」—— 最可信, 优先。
  //    与 prompt/workflow 两块不同, 它记的是链路**算出来的结果**而非节点入参,
  //    所以对"提示词随机生成"的工作流也能给出真值。老图没有这个块, 自动落到下面。
  const pt = (chunks.prompt_text || '').trim()
  if (pt) return { text: pt, source: 'comfyui' }

  // 1) ComfyUI 节点图(最精确)
  if (chunks.prompt) {
    try {
      const d = JSON.parse(chunks.prompt)
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const txt = comfyPositiveFromPromptJson(d)
        if (txt) return { text: txt, source: 'comfyui' }
      }
    } catch { /* 落到通用兜底 */ }
  }

  // 2) ComfyUI 通用兜底
  const generic = comfyPositiveGeneric(chunks)
  if (generic) return { text: generic, source: 'comfyui' }

  // 3) A1111 / Forge / SD.Next
  const p = chunks.parameters
  if (p) {
    const i = p.indexOf('Negative prompt:')
    const pos = (i >= 0 ? p.slice(0, i) : p).trim()
    if (pos) return { text: pos, source: 'a1111' }
  }

  // 4) NovelAI
  for (const key of ['Comment', 'Description']) {
    const c = (chunks[key] || '').trim()
    if (!c.startsWith('{')) continue
    try {
      const d = JSON.parse(c)
      if (d && typeof d === 'object' && d.prompt) {
        return { text: String(d.prompt).trim(), source: 'novelai' }
      }
    } catch { /* 继续 */ }
  }

  // 5) InvokeAI
  const im = chunks.invokeai_metadata
  if (im) {
    try {
      const d = JSON.parse(im)
      if (d && typeof d === 'object' && d.positive_prompt) {
        return { text: String(d.positive_prompt).trim(), source: 'invokeai' }
      }
    } catch { /* 继续 */ }
  }

  return { text: '', source: '' }
}

function extractNegativeFromChunks(chunks, positiveText) {
  // 3) A1111 / Forge / SD.Next: parameters 串的负面段
  const p = chunks.parameters
  if (p && p.includes('Negative prompt:')) return a1111Negative(p)

  // 4) NovelAI: Comment JSON 的 negative_prompt
  for (const key of ['Comment']) {
    const c = (chunks[key] || '').trim()
    if (!c.startsWith('{')) continue
    try {
      const d = JSON.parse(c)
      if (d && typeof d === 'object' && d.negative_prompt) return String(d.negative_prompt).trim()
    } catch { /* 继续 */ }
  }

  // 5) InvokeAI
  const im = chunks.invokeai_metadata
  if (im) {
    try {
      const d = JSON.parse(im)
      if (d && typeof d === 'object' && d.negative_prompt) return String(d.negative_prompt).trim()
    } catch { /* 继续 */ }
  }

  // 0/1/2) ComfyUI: 先顺采样器 negative 链(最准), 再走候选剔除兜底
  if (chunks.prompt) {
    try {
      const d = JSON.parse(chunks.prompt)
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const neg = comfyNegativeFromPromptJson(d)
        if (neg) return neg
      }
    } catch { /* 落兜底 */ }
  }
  return comfyNegativeGeneric(chunks, positiveText)
}
