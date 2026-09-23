/**
 * 生成真实可解码的 PNG —— 造「横图 / 竖图」测试夹具用
 * ============================================================================
 * 为什么需要它（2026-09-23）：`test-fixtures/scan-test/*.png` 全是 **1x1** 的
 * 占位图（读文件头得到的尺寸是 [1,1]）。想验"卡片按图片真实比例排版"，就必须
 * 有**真的有横有竖**的图 —— 1x1 是正方形，横竖都验不出来。
 *
 * 改 IHDR 里的宽高不算数：那会造出一张声称 320x180、实际只有 1 个像素的坏图，
 * 解码器会报错（缩略图加载失败反而把控制台断言顶红）。所以老老实实编码一张。
 *
 * 编码规则（PNG 是分块结构，这里只用三种块）：
 *   签名(8B) + IHDR(13B: 宽/高/位深/颜色类型/…) + IDAT(zlib 压缩的扫描线) + IEND
 *   每个块 = 4B 长度 + 4B 类型 + 数据 + 4B CRC32(对"类型+数据"算)
 *   Node ≥ 20.15 自带 `zlib.crc32`，不用自己写表（README 第 20 条踩过这个坑）。
 *
 * 颜色类型 2 = 真彩 RGB、位深 8；**每行前面要加一个 filter 字节(0=不过滤)**，
 * 漏了它整张图就废了。
 */
import zlib from 'node:zlib'

/** 拼一个 PNG 块：长度 + 类型 + 数据 + CRC32(类型+数据) */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(td) >>> 0, 0)
  return Buffer.concat([len, td, crc])
}

/**
 * 生成一张纯色 PNG。
 * @param {number} w 宽（像素）
 * @param {number} h 高（像素）
 * @param {{rgb?:[number,number,number], prompt?:string}} [opt]
 *   rgb    —— 纯色（默认红）
 *   prompt —— 写进 `prompt_text` 文本块。**这是应用认的第一优先级来源**
 *             （见 core/png.js 的 extractImagePrompt：prompt_text -> comfyui），
 *             逗号分隔的提示词会被 promptToTags 切成标签。不传就是"无元数据"的裸图。
 * @returns {Buffer}
 */
export function makePng(w, h, opt = {}) {
  if (!(w > 0) || !(h > 0)) throw new Error('makePng: 宽高必须是正数')
  const [r, g, b] = opt.rgb || [220, 60, 60]

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8      // 位深
  ihdr[9] = 2      // 颜色类型 2 = 真彩 RGB
  ihdr[10] = 0     // 压缩方式(固定 0)
  ihdr[11] = 0     // 过滤方式(固定 0)
  ihdr[12] = 0     // 隔行(0 = 不隔行)

  // 一行 = 1 字节 filter(0) + w 个 RGB 三元组
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(new Array(h).fill(row))

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]
  /* 文本块放在 IHDR 之后、IDAT 之前 —— PNG 规范里 tEXt 可以出现在任何块之间,
     但"数据块之前"是最不容易踩到解析器边角的位置。关键字与内容之间用 \0 分隔。 */
  if (opt.prompt) {
    parts.push(chunk('tEXt', Buffer.concat([
      Buffer.from('prompt_text\0', 'latin1'),
      Buffer.from(String(opt.prompt), 'latin1'),
    ])))
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw)))
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/**
 * 把 PNG **补齐到指定字节数** —— 在文件尾追加填充。
 *
 * 为什么要控制文件大小：扫描页的"按大小排序"断言要靠一批**明确的大小顺序**，
 * 而 PNG 压缩后的大小不好预测（纯色图压得极狠）。尾部追加是最省事的做法：
 * IEND 之后的内容属于"块外数据"，解码器一律忽略（浏览器/Chromium 的 PNG 解码
 * 都是这样），而应用的解析器是从头按块走的，根本不会看到它。
 *
 * ⚠️ 不要用"插入一个 tEXt 块"来凑大小 —— 那会让核心解析器多看到一个文本块，
 * 有可能被当成提示词来源（`chunks` 里多一项）。尾部填充完全没有这个副作用。
 *
 * @param {Buffer} buf makePng 的产物
 * @param {number} bytes 目标总字节数
 */
export function padToSize(buf, bytes) {
  if (buf.length > bytes) {
    throw new Error(`padToSize: 图本身已经 ${buf.length} 字节, 超过目标 ${bytes}`)
  }
  return Buffer.concat([buf, Buffer.alloc(bytes - buf.length, 0x20)])
}
