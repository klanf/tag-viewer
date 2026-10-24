// 复现「另一台机器」死锁场景(修复后): folders=1 + tag_queue pending>0 + images=0
// 期望: bootstrap 返回 phase='error' 且错误文案是新的「打标队列等待反推」版
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA = path.join(os.tmpdir(), 'tv-deadlock-fix')
const IMGS = path.join(os.tmpdir(), 'tv-deadlock-fix-imgs')
fs.rmSync(DATA, { recursive: true, force: true })
fs.rmSync(IMGS, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(IMGS, { recursive: true })

// 造 3 张裸 PNG —— 手写最小 PNG(zlib + CRC32, 零依赖), 与 _repro-fresh.mjs 同款
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

process.env.TV_DATA_DIR = DATA
process.env.TV_INGEST = ''            // 开总闸
process.env.TV_TAGGER_CMD = 'D:/__no_such__/python.exe -u x.py'  // 无 python(与远端一致)

const { initWorkspace } = await import('../electron/core/workspace.js')
initWorkspace(DATA)
const { addFolder } = await import('../electron/core/folders.js')
const r1 = await addFolder({ path: IMGS, as_source: true, as_scan: false, recursive: true })
if (r1.error) { console.log('[addFolder] FAIL', r1.error); process.exit(1) }

const { runIngest } = await import('../electron/core/ingest.js')
const st = await runIngest({})
console.log('[ingest]', JSON.stringify({ diskFiles: st.diskFiles, inserted: st.inserted, queued: st.queued, skipped: st.skipped }))

// —— 此刻状态 = 远端机器 session2 boot 时的库状态 ——
const { bootstrap } = await import('../electron/core/app-state.js')
const boot = await bootstrap({})
console.log('[bootstrap] phase =', boot.phase)
console.log('[bootstrap] error =', boot.error)

const okMsg = /打标队列/.test(boot.error || '')
console.log(okMsg ? '[PASS] 新文案生效(区分暂态)' : '[FAIL] 文案未生效')
process.exit(okMsg ? 0 : 2)
