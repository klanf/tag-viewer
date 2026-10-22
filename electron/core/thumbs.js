/**
 * 缩略图生成 + 磁盘缓存
 * =====================
 * 缓存文件名与 Python 版**完全一致**: md5(路径 + '|' + 宽度) + '_' + 宽度 + '.jpg'
 *   -> dataDir/.thumb_cache/ 里已有的 93MB 缓存可以直接复用, 不用重新生成。
 *
 * 生成用 Electron 内置的 nativeImage, 不引入任何原生模块(sharp / jimp 都不需要)。
 * nativeImage 只认 PNG / JPEG; webp/bmp/gif 会拿到空图, 这时返回 null,
 * 由调用方回退成「直接发原图」——与原 Python 版 PIL 失败时的行为一致。
 *
 * 生成**串行 + 逐张让出事件循环**(2026-10-22)
 * -------------------------------------------
 * nativeImage.createFromPath 是同步解码, 一张 24MP 的 PNG 就要 ~260ms。
 * 扫描页连翻几页时几百张缩略图同时到达, 原来的实现是让它们一起进主进程,
 * 事件循环被连续占死 —— 实测 IPC 延迟峰值 6.1 秒, 表现就是「翻页卡死」。
 * 现在请求进一条队列, 一次只解一张, 每张结束后 setImmediate 让出:
 * 缩略图/窗口状态/标签查询这些 IPC 都能插进来, 单次等待上限 = 一张图的解码时间。
 * 磁盘缓存的 stat/read 也改成异步(fs.promises), 命中缓存时同样不占主线程。
 *
 * pending 只装「真正在排队或正在生成」的 key, resolve 后立刻删掉 ——
 * 旧实现的 inflight 在异步函数体里自删, 但那个自删在 set 之前就执行完了,
 * 条目永远留在表里(实测翻页后 inflight 从 43 涨到 634), 这里一并修掉。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { nativeImage } from 'electron'
import { getWorkspace } from './workspace.js'

const pending = new Map()   // tp -> Promise<Buffer|null>, 排队中 + 生成中
const queue = []
let pumping = false
const stats = { hit: 0, built: 0, failed: 0, fallbackOriginal: 0 }

export function thumbDir() {
  return path.join(getWorkspace().dataDir, '.thumb_cache')
}

function thumbPath(srcPath, width) {
  const key = crypto.createHash('md5').update(`${srcPath}|${width}`, 'utf8').digest('hex')
  return path.join(thumbDir(), `${key}_${width}.jpg`)
}

/** 同步生成一张缩略图(nativeImage 解码无法脱离主进程)。队列保证一次只跑一个。 */
function generate(srcPath, width, tp) {
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
  }
}

function pump() {
  if (pumping || !queue.length) return
  pumping = true
  setImmediate(runOne)
}

function runOne() {
  const job = queue.shift()
  if (!job) { pumping = false; return }
  job.resolve(generate(job.srcPath, job.width, job.tp))
  setImmediate(runOne)
}

/**
 * 取缩略图 Buffer。命中缓存直接回; 没命中就进队列生成并落盘。
 * @returns {Promise<Buffer|null>} null = 生成不了(格式不支持/文件损坏), 调用方回退原图
 */
export async function getThumb(srcPath, width) {
  const tp = thumbPath(srcPath, width)

  let srcMt
  try {
    const st = await fsp.stat(srcPath)
    if (!st.isFile()) return null
    srcMt = st.mtimeMs
  } catch { return null }

  // 1) 磁盘缓存(且比原图新)
  try {
    const tpSt = await fsp.stat(tp)
    if (tpSt.isFile() && tpSt.mtimeMs >= srcMt) {
      stats.hit++
      return await fsp.readFile(tp)
    }
  } catch { /* 没缓存, 继续 */ }

  // 2) 同一张图并发请求时只生成一次
  const hit = pending.get(tp)
  if (hit) return hit

  const task = new Promise((resolve) => {
    queue.push({ srcPath, width, tp, resolve })
    pump()
  })
  pending.set(tp, task)
  try {
    return await task
  } finally {
    pending.delete(tp)
  }
}

export function thumbStats() { return { ...stats, inflight: pending.size } }

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
