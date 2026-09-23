/**
 * 只读**文件头**拿图片像素尺寸
 * ============================
 * 为什么需要它(2026-09-23): 卡片一律 9/16 的固定比例 + `object-fit: cover`,
 * 于是横图被裁成竖条。实测用户库里横图占 **50%**(垃圾桶/新世界/里世界/表世界
 * 四个来源全是横图, 一万四千多张) —— 这不是边角情况。
 *
 * 要"按图片真实比例渲染"就必须先知道每张图的宽高。三条路里:
 *   · nativeImage.createFromPath().getSize()  —— 要**整图解码**, 八万张不现实,
 *     而且非 PNG/JPEG 会直接拿到空图(见 thumbs.js 顶部的说明);
 *   · 前端 naturalWidth/naturalHeight          —— 只覆盖"已经加载过"的图, 首帧
 *     必然跳动, 而且拿不到尺寸就算不出系列封面该挑哪张;
 *   · **读文件头**                             —— 64KB 以内就有答案, 不解码像素。
 * 所以走第三条。
 *
 * 各格式的尺寸都在固定位置(不需要解析整图):
 *   PNG   : offset 16/20, big-endian uint32(IHDR 块紧随 8 字节签名)
 *   JPEG  : 扫 SOFn 段(0xFFC0~0xFFCF, 排除 DHT/DAC/C4/C8/CC), 高在前宽在后
 *   GIF   : offset 6/8, little-endian uint16
 *   WEBP  : VP8X 的 24 位宽高 / VP8 的 14 位 / VP8L 的位打包
 *   BMP   : offset 18/22, little-endian int32(负数表示 top-down, 取绝对值)
 *
 * 认不出来的一律返回 null —— **绝不猜**。调用方要么保留旧值, 要么回落到
 * 默认比例(9/16)。宁可回到改动前的行为, 也不要显示一个错的尺寸。
 */
import fs from 'node:fs'

/** 先读这么多。PNG(24B)/GIF(10B)/WEBP(30B)/BMP(26B) 的尺寸全在里面,
 *  JPEG 的 SOF 通常也紧跟 APP0/APP1 —— 4KB 够覆盖绝大多数图。 */
const HEAD_SMALL = 4096
/** 兜底窗口。JPEG 带大段 EXIF/ICC 时 SOF 会被顶到几 KB 之后, 这时才读这么多。
 *  实测: 一律读 64KB 时每张 ~11ms(八万张 16 分钟); 先 4KB 能砍掉大部分
 *  读取量 —— 而尺寸字段本来就在文件头上。 */
const HEAD_BIG = 64 * 1024

/**
 * @param {string} file 图片路径
 * @returns {[number, number]|null} [宽, 高]; 读不到/认不出返回 null
 */
export function readImageSize(file) {
  if (!file) return null
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(HEAD_SMALL)
    const n = fs.readSync(fd, head, 0, head.length, 0)
    const small = head.subarray(0, n)
    const quick = sizeFromBuffer(small)
    if (quick) return quick
    // 只有 JPEG 才值得再读一遍大的; 其他格式到这个位置就是"认不出来"了。
    if (small.length > 2 && small[0] === 0xff && small[1] === 0xd8) {
      const big = Buffer.alloc(HEAD_BIG)
      const m = fs.readSync(fd, big, 0, big.length, 0)
      return sizeFromBuffer(big.subarray(0, m))
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
  }
}

/**
 * 从一段文件头里解析尺寸。**与 readImageSize 分开** —— worker 侧批量处理时
 * 可以复用自己的读盘逻辑, 也方便单测直接喂 Buffer。
 * @param {Buffer} b
 * @returns {[number, number]|null}
 */
export function sizeFromBuffer(b) {
  if (!b || b.length < 10) return null

  // ---- PNG ----
  if (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') {
    const w = b.readUInt32BE(16)
    const h = b.readUInt32BE(20)
    return w > 0 && h > 0 ? [w, h] : null
  }

  // ---- JPEG ----
  if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b)

  // ---- GIF ----
  const gif = b.toString('latin1', 0, 3)
  if (gif === 'GIF') {
    const w = b.readUInt16LE(6)
    const h = b.readUInt16LE(8)
    return w > 0 && h > 0 ? [w, h] : null
  }

  // ---- WEBP ----
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF'
      && b.toString('latin1', 8, 12) === 'WEBP') {
    const fmt = b.toString('latin1', 12, 16)
    if (fmt === 'VP8X') {
      // 24 位宽高, 存的是"实际值 - 1"
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
      return [w, h]
    }
    if (fmt === 'VP8 ') {
      // 有损: 帧头里两个 14 位(小数部分占高位, 要掩掉)
      const w = b.readUInt16LE(26) & 0x3fff
      const h = b.readUInt16LE(28) & 0x3fff
      return w > 0 && h > 0 ? [w, h] : null
    }
    if (fmt === 'VP8L') {
      // 无损: 14 位宽 + 14 位高打包在 4 字节里(同样 -1)
      const bits = b.readUInt32LE(21)
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
    }
    return null
  }

  // ---- BMP ----
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    const w = b.readInt32LE(18)
    const h = b.readInt32LE(22)
    // 高度为负 = 像素自顶向下存, 只是内存布局差异, 尺寸取绝对值
    return w !== 0 && h !== 0 ? [Math.abs(w), Math.abs(h)] : null
  }

  return null
}

/** JPEG: 逐段跳, 直到遇到 SOFn 帧头 —— 尺寸就在它里面 */
function jpegSize(b) {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }          // 填充字节, 继续找标记
    const marker = b[i + 1]
    if (marker === 0xff) { i++; continue }        // 连续 0xFF 是填充
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue } // 无长度字段
    // SOF0~SOF15 里, C4(DHT)/C8(JPG)/CC(DAC) 不是帧头 —— 它们不含尺寸
    if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = b.readUInt16BE(i + 5)
      const w = b.readUInt16BE(i + 7)
      return w > 0 && h > 0 ? [w, h] : null
    }
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null                       // 长度非法 -> 文件坏了
    i += 2 + len
  }
  return null
}

/** 把尺寸归一化成 CSS `aspect-ratio` 能用的字符串; 缺任一维返回空串 */
export function ratioOf(w, h) {
  const W = Number(w || 0)
  const H = Number(h || 0)
  if (!(W > 0) || !(H > 0)) return ''
  return `${W} / ${H}`
}
