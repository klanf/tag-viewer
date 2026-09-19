/**
 * 标签文件(tags_*.txt)的行解析 —— 数据集加载与 SQLite 导入共用
 * ==========================================================
 * 这个模块被两处用到, 所以单独抽出来, 避免 dataset.js 与 store.js 互相 import:
 *   1. dataset.js 的「从 txt 加载」(DB 尚未建立时的首次导入 / 回退路径)
 *   2. store.js   的「把 txt 灌进 SQLite」
 *
 * 逐行格式:  <图片路径>: <标签1>, <标签2>, ...
 *   · 冒号后可能没有空格(`path:tag1,tag2`), 也要认
 *   · 路径里本身可能带冒号(盘符 F:) —— 所以找的是「: 」或第一个『后面不像路径的』冒号。
 *     原版 Python 的写法是 split(':', 1), 即按**第一个**冒号切; 这里保持一致:
 *     先找 ': ' 形式的; 找不到再按第一个 ':' 切。
 */
import fs from 'node:fs'
import readline from 'node:readline'

/** 按第一个冒号切; 认 ': ' 与 ':' 两种写法 */
export function splitTagLine(line) {
  const i = line.indexOf(': ')
  if (i >= 0) return [line.slice(0, i), line.slice(i + 2)]
  const j = line.indexOf(':')
  if (j < 0) return null
  return [line.slice(0, j), line.slice(j + 1)]
}

/**
 * 解析一行 -> { path, tags: string[] } | null
 * 空行 / 无冒号 / 空路径 / 空标签都返回 null。
 */
export function parseTagLine(line) {
  if (!line || !line.trim()) return null
  const parts = splitTagLine(line)
  if (!parts) return null
  const p = parts[0].trim()
  if (!p) return null
  const tagStr = parts[1]
  const tags = []
  let start = 0
  // 手写切分比 split(',') 快, 也避免正则; 标签本身不会含逗号(格式约定)
  for (let i = 0; i <= tagStr.length; i++) {
    if (i === tagStr.length || tagStr.charCodeAt(i) === 44 /* , */) {
      const t = tagStr.slice(start, i).trim()
      start = i + 1
      if (t) tags.push(t)
    }
  }
  if (!tags.length) return null
  return { path: p, tags }
}

/**
 * 流式逐行读取一个标签文件。
 * @param {string} fp
 * @param {(rec: {path: string, tags: string[]}) => void} onRecord
 * @param {(n: number, bytes: number) => void} [onEach]  每 N 条回调一次(进度)
 * @returns {Promise<{records: number, bytes: number}>}
 */
export async function streamTagFile(fp, onRecord, onEach) {
  const stream = fs.createReadStream(fp, { encoding: 'utf8', highWaterMark: 1 << 20 })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let n = 0
  for await (const raw of rl) {
    const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw
    const rec = parseTagLine(line)
    if (!rec) continue
    onRecord(rec)
    n++
    if (onEach) onEach(n, stream.bytesRead)
  }
  return { records: n, bytes: stream.bytesRead }
}

/** 一次读完整文件(只在文件不大或需要随机访问时用) */
export function readTagFileSync(fp) {
  const out = []
  const text = fs.readFileSync(fp, 'utf8')
  for (const line of text.split('\n')) {
    const rec = parseTagLine(line)
    if (rec) out.push(rec)
  }
  return out
}
