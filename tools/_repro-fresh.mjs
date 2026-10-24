// 复现「绿色包新机首扫 0 入库」：全新数据目录 + 裸图 + 反推环境不可用
// 运行: node --experimental-sqlite tools/_repro-fresh.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(os.tmpdir(), 'tv-repro-data')
const IMGS = path.join(os.tmpdir(), 'tv-repro-imgs')
fs.rmSync(DATA, { recursive: true, force: true })
fs.rmSync(IMGS, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(IMGS, { recursive: true })
process.env.TV_DATA_DIR = DATA
if (process.argv.includes('--with-py')) {
  // 场景 B: 绿色包 v2.1.0 —— 包内自带 python + 模型, 反推应该真跑通
  const PKG = path.join(ROOT, 'release', 'TagViewer-绿色包-v2.1.0')
  process.env.TV_PYTHON = PKG + '/python/python.exe'
  process.env.TV_WD14_MODEL = PKG + '/models/wd-pixai-tagger-v0.9.onnx'
  process.env.TV_WD14_CSV = PKG + '/models/wd-pixai-tagger-v0.9.csv'
} else {
  // 场景 A: 旧绿色包在无 python 的新机上 —— 复现「扫描完成但 0 入库」
  process.env.TV_TAGGER_CMD = 'D:/__no_such__/python.exe -u x.py'   // 模拟「另一台机器没有 python」
}
process.env.TV_INGEST = ''                                        // 显式开门

// 造 3 张裸 PNG(无任何 tEXt 元数据) —— 手写最小 PNG(zlib + CRC32, 零依赖)
import zlib from 'node:zlib'
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function barePng(i) {
  const W = 64, H = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2  // 8bit RGB
  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++) {
    const off = y * (1 + W * 3)
    raw[off] = 0
    for (let x = 0; x < W; x++) {
      raw[off + 1 + x * 3] = (x * 4 + i * 40) % 256
      raw[off + 2 + x * 3] = (y * 4) % 256
      raw[off + 3 + x * 3] = 128
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
for (let i = 0; i < 3; i++) {
  fs.writeFileSync(path.join(IMGS, `bare-${i + 1}.png`), barePng(i))
}

const { initWorkspace } = await import('../electron/core/workspace.js')
initWorkspace(DATA, {})
const { addFolder } = await import('../electron/core/folders.js')
const { runIngest, ingestState, queueStats } = await import('../electron/core/ingest.js')
const { runTagger } = await import('../electron/core/tagger.js')

const r1 = await addFolder({ path: IMGS, as_source: true, as_scan: false, recursive: true })
console.log('[addFolder]', JSON.stringify(r1))

const stats = await runIngest({})
console.log('[ingest stats]', JSON.stringify(stats))
console.log('[queue]', JSON.stringify(queueStats()))

const t = await runTagger({})
console.log('[tagger]', JSON.stringify({ degraded: t.degraded, reason: t.reason, tagged: t.tagged, created: t.created }))
console.log('[queue after tagger]', JSON.stringify(queueStats()))

const dbRows = fs.existsSync(path.join(DATA, 'tags.db'))
console.log('[images 表行数]', dbRows ? '见下' : '(无 db)')
if (dbRows) {
  const { openDb } = await import('../electron/core/store.js')
  console.log('[images 表行数]', openDb().prepare('SELECT COUNT(*) n FROM images').get().n)
}
console.log('[ingestState.note]', ingestState.note)
