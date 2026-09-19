/**
 * 缩略图生成 + 磁盘缓存
 * =====================
 * 缓存文件名与 Python 版**完全一致**: md5(路径 + '|' + 宽度) + '_' + 宽度 + '.jpg'
 *   -> dataDir/.thumb_cache/ 里已有的 93MB 缓存可以直接复用, 不用重新生成。
 *
 * 生成用 Electron 内置的 nativeImage, 不引入任何原生模块(sharp / jimp 都不需要)。
 * nativeImage 只认 PNG / JPEG; webp/bmp/gif 会拿到空图, 这时返回 null,
 * 由调用方回退成「直接发原图」——与原 Python 版 PIL 失败时的行为一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { nativeImage } from 'electron'
import { getWorkspace } from './workspace.js'

const inflight = new Map()
const stats = { hit: 0, built: 0, failed: 0, fallbackOriginal: 0 }

export function thumbDir() {
  return path.join(getWorkspace().dataDir, '.thumb_cache')
}

function thumbPath(srcPath, width) {
  const key = crypto.createHash('md5').update(`${srcPath}|${width}`, 'utf8').digest('hex')
  return path.join(thumbDir(), `${key}_${width}.jpg`)
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs } catch { return -1 }
}

/**
 * 取缩略图 Buffer。命中缓存直接回; 没命中就现生成并落盘。
 * @returns {Promise<Buffer|null>} null = 生成不了(格式不支持/文件损坏), 调用方回退原图
 */
export async function getThumb(srcPath, width) {
  const tp = thumbPath(srcPath, width)
  const srcMt = mtime(srcPath)
  if (srcMt < 0) return null

  // 1) 磁盘缓存(且比原图新)
  try {
    const tpMt = fs.statSync(tp).mtimeMs
    if (tpMt >= srcMt) {
      stats.hit++
      return fs.readFileSync(tp)
    }
  } catch { /* 没缓存, 继续 */ }

  // 2) 同一张图并发请求时只生成一次
  const key = tp
  if (inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    try {
      const img = nativeImage.createFromPath(srcPath)
      if (img.isEmpty()) { stats.fallbackOriginal++; return null }

      const { width: w, height: h } = img.getSize()
      if (!w || !h) { stats.fallbackOriginal++; return null }

      let out = img
      if (w > width) {
        out = img.resize({ width, height: Math.max(1, Math.round((h * width) / w)), quality: 'good' })
      }
      const buf = out.toJPEG(82)
      if (!buf || !buf.length) { stats.failed++; return null }

      try {
        fs.mkdirSync(thumbDir(), { recursive: true })
        const tmp = `${tp}.${process.pid}.tmp`
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, tp)        // 原子替换, 避免半截文件被当成有效缓存
      } catch { /* 写缓存失败不影响本次返回 */ }

      stats.built++
      return buf
    } catch {
      stats.failed++
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

export function thumbStats() { return { ...stats, inflight: inflight.size } }

/** 清空缩略图缓存(设置页用) */
export function clearThumbs() {
  const dir = thumbDir()
  let n = 0
  let bytes = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f)
      try {
        const st = fs.statSync(fp)
        bytes += st.size
        fs.unlinkSync(fp)
        n++
      } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  stats.hit = stats.built = stats.failed = stats.fallbackOriginal = 0
  return { removed: n, bytes }
}

/** 缓存目录体积(设置页显示) */
export function thumbCacheSize() {
  const dir = thumbDir()
  let n = 0, bytes = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      try { bytes += fs.statSync(path.join(dir, f)).size; n++ } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return { files: n, bytes }
}
