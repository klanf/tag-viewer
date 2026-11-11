/**
 * 元数据角色优先(2026-11-11) —— npm run test:metachars
 * =====================================================
 * 用户诉求: ComfyUI 图的角色以**图内提示词**为准, 提示词没有角色才回落到反推。
 * 起因是实测反推会认歪 —— 抽样 40 张里 16 张的角色集合与提示词不一致
 * (漏认 / 把同作品的别人一起认上 / 把服装形态认成角色)。
 *
 * 本测试守四件事:
 *   ① 入库时把元数据角色单独存进 images.meta_chars(不随反推覆盖 tags 而丢失);
 *   ② 反推覆盖 tags 之后, 加载数据集时角色仍以 meta_chars 为准(反推多认的整批剔掉);
 *   ③ 负向控制: meta_chars 为空 -> 反推的角色照旧生效(不能把所有图都变成无角色);
 *   ④ 老行懒回填: img_src 已知但 meta_chars 还是 NULL 的, 一轮同步后补上;
 *      legacy 行的**标签一个字都不动**(只补这两列)。
 *
 * 跑法: npm run test:metachars
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 自造数据目录, 不能被外面的 TV_DATA_DIR 抢走
delete process.env.TV_DATA_DIR

const { initWorkspace } = await load('electron/core/workspace.js')
const store = await load('electron/core/store.js')
const ingest = await load('electron/core/ingest.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-metachars-'))
const DATA = path.join(WORK, 'data')
const IMG_DIR = path.join(WORK, 'imgs')
for (const d of [DATA, IMG_DIR]) fs.mkdirSync(d, { recursive: true })
initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: DATA })

let pass = 0, fail = 0
const ok = (n, extra = '') => { pass++; console.log(`  ✓ ${n}${extra ? '  — ' + extra : ''}`) }
const bad = (n, extra = '') => { fail++; console.log(`  ✗ ${n}${extra ? '  — ' + extra : ''}`) }
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want)
  ? ok(n, JSON.stringify(got)) : bad(n, `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`))

/* ------------------------------------------------------------ 造最小 PNG */

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

/** 签名 + IHDR + 可选 tEXt(prompt_text) + IDAT(遇到 IDAT 就停, 不用 IEND) */
function makePng(promptText) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', Buffer.alloc(13))]
  if (promptText) {
    parts.push(chunk('tEXt', Buffer.concat([
      Buffer.from('prompt_text\u0000', 'latin1'),
      Buffer.from(promptText, 'utf8'),
    ])))
  }
  parts.push(chunk('IDAT', Buffer.alloc(64)))
  return Buffer.concat(parts)
}

function writeImg(name, promptText) {
  const p = path.join(IMG_DIR, name)
  fs.writeFileSync(p, makePng(promptText))
  return p
}

const norm = (p) => store.normalizeImagePath(p)
const run = (opts = {}) => ingest.runIngest(opts)
const rowOf = (p) => store.openDb().prepare('SELECT * FROM images WHERE path = ?').get(norm(p))

/* ------------------------------------------------------------ 建登记表 */

console.log('\n[0] 建登记表')
let FOLDER_ID = 0
{
  const db = store.openDb()
  ingest.ensureQueueTable(db)
  db.prepare(`INSERT INTO folders (path, label, as_source, as_scan, recursive, added_at)
              VALUES (?, ?, 1, 0, 1, ?)`).run(norm(IMG_DIR), 'imgs', Date.now())
  FOLDER_ID = Number(db.prepare('SELECT id FROM folders WHERE path = ?').get(norm(IMG_DIR)).id)
  eq('登记 1 个看板来源', db.prepare('SELECT COUNT(*) n FROM folders WHERE as_source=1').get().n, 1)
}

/* ------------------------------------------------- [1] 入库写 meta_chars */

console.log('\n[1] 入库: 元数据里的角色单独存一列')
const A = writeImg('a.png', '1girl, hoshino_(blue_archive), halo, blue_sky, solo')
const B = writeImg('b.png', '')            // 裸图: 没有元数据
{
  await run()
  const a = rowOf(A)
  eq('a.png 走元数据入库', a.tags_src, 'meta')
  eq('a.png 的 meta_chars 是提示词里的角色', store.parseMetaChars(a.meta_chars), ['hoshino_(blue_archive)'])
  eq('a.png img_src 认成 comfyui', a.img_src, 'comfyui')
  const b = rowOf(B)
  eq('b.png(无元数据) meta_chars 是空数组', store.parseMetaChars(b.meta_chars), [])
}

/* ------------------------------------- [2] 反推覆盖 tags 后角色仍以元数据为准 */

console.log('\n[2] 反推覆盖 tags -> 加载数据集时角色仍以 meta_chars 为准')
{
  const db = store.openDb()
  // 模拟 WD14 反推覆盖: 多认了同作品的另一个角色(真实故障形态)
  db.prepare(`UPDATE images SET tags = ?, tags_src = 'wd14' WHERE path = ?`).run(
    '1girl, hoshino_(blue_archive), shiroko_(blue_archive), halo, blue_sky', norm(A),
  )
  eq('反推覆盖没动 meta_chars', store.parseMetaChars(rowOf(A).meta_chars), ['hoshino_(blue_archive)'])

  const { loadConfig, resolveDataFiles } = await load('electron/core/config.js')
  const { loadDataset, ds } = await load('electron/core/dataset.js')
  await loadDataset(resolveDataFiles(loadConfig(), null), () => {})

  const rec = ds.records.find((r) => r.path === norm(A))
  const chars = rec.tags.filter((t) => /\(/.test(t))
  eq('多认的角色被剔掉, 只留元数据那个', chars, ['hoshino_(blue_archive)'])
  ok('非角色标签原样保留', rec.tags.includes('halo') && rec.tags.includes('blue_sky'))

  const sc = ds.seriesChars.get('blue_archive') || new Map()
  eq('系列索引里只有元数据角色', [...sc.keys()], ['hoshino_(blue_archive)'])
  eq('该角色的图数', sc.get('hoshino_(blue_archive)').size, 1)
}

/* --------------------------------------------------- [3] 负向控制: 回落反推 */

console.log('\n[3] 负向控制: 元数据没有角色 -> 反推角色照旧生效')
{
  const C = writeImg('c.png', '1girl, halo, blue_sky')     // 有元数据但没有角色词
  await run()
  const c = rowOf(C)
  eq('c.png 元数据无角色', store.parseMetaChars(c.meta_chars), [])
  const db = store.openDb()
  db.prepare(`UPDATE images SET tags = ?, tags_src = 'wd14' WHERE path = ?`).run(
    '1girl, hoshino_(blue_archive), halo', norm(C),
  )

  const { loadConfig, resolveDataFiles } = await load('electron/core/config.js')
  const { loadDataset, ds } = await load('electron/core/dataset.js')
  await loadDataset(resolveDataFiles(loadConfig(), null), () => {})
  const rec = ds.records.find((r) => r.path === norm(C))
  ok('反推认出的角色还在', rec.tags.includes('hoshino_(blue_archive)'))
}

/* ------------------------------------------------- [4] 老行懒回填 + legacy 不动 */

console.log('\n[4] 老行懒回填: 只补 img_src/meta_chars, legacy 标签一个字都不动')
{
  const D = writeImg('d.png', '1girl, aris_(blue_archive), halo')
  const E = writeImg('e.png', '1girl, miyako_(blue_archive), halo')
  const st = (p) => { const s = fs.statSync(p); return { m: Math.round(s.mtimeMs), s: s.size } }
  const db = store.openDb()
  // d: 已有反推标签、img_src 已知、meta_chars 还没补(NULL)
  db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone,
              tagged_at, px_w, px_h, img_src, meta_chars)
              VALUES (?, 0, ?, ?, ?, ?, 'wd14', 0, ?, 1, 1, 'comfyui', NULL)`)
    .run(norm(D), '1girl, aris_(blue_archive), neru_(blue_archive)', FOLDER_ID, st(D).m, st(D).s, Date.now())
  // e: legacy 孤本(手工导入的标签), 元数据里的角色与标签完全不同
  db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone,
              tagged_at, px_w, px_h, img_src, meta_chars)
              VALUES (?, 0, ?, ?, ?, ?, 'legacy', 0, NULL, 1, 1, NULL, NULL)`)
    .run(norm(E), '1girl, some_manual_tag, another_manual_tag', FOLDER_ID, st(E).m, st(E).s)

  const before = String(rowOf(E).tags)
  await run()
  eq('d.png 补上了元数据角色', store.parseMetaChars(rowOf(D).meta_chars), ['aris_(blue_archive)'])
  eq('d.png 的标签没被这一趟改动', rowOf(D).tags, '1girl, aris_(blue_archive), neru_(blue_archive)')
  eq('e.png(legacy) 标签一字未动', rowOf(E).tags, before)
  eq('e.png 也补上了元数据角色(文件里确实有)', store.parseMetaChars(rowOf(E).meta_chars), ['miyako_(blue_archive)'])
  // 补过一次就不再是候选: 再来一轮不应该重复读
  const again = await run()
  eq('第二轮不再重复补(候选已空)', again.metaCharsBackfilled, 0)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0)
