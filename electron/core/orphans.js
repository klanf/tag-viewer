/**
 * 无角色/系列图片补识别
 * =====================
 * 2026-10-21 用户需求: 「对没有系列、没有角色的图片重新识别」。
 *
 * 两档来源, 写回语义完全不同(见 tagger.js 的 applyTags):
 *   · wd14 / meta / meta+wd14 —— 标签本来就可被反推覆盖, 直接重跑并整体覆盖;
 *   · legacy(旧看板导入) —— 原标签是孤本, **只把新识别出的角色/系列追加进去**,
 *     不清空原标签。
 *
 * 只挑「活着的、有标签的」图: 空标签图本来就是队列的活, 不该混进来;
 * gone=1 的图磁盘上已经没了, 入队只会白跑一趟。
 */
import { openDb } from './store.js'
import { ensureQueueTable } from './ingest.js'
import { isCharOrSeries } from './tagcats.js'

const OVERWRITABLE = new Set(['wd14', 'meta', 'meta+wd14'])

function isOrphan(tags) {
  for (const t of String(tags || '').split(',')) {
    if (t.trim() && isCharOrSeries(t)) return false
  }
  return true
}

/**
 * 扫一遍库, 分出「可覆盖重跑」与「legacy 只补角色」两堆。
 * @param {{includeLegacy?:boolean, folderId?:number}} [opts]
 */
function scan({ includeLegacy = false, folderId = 0 } = {}) {
  const db = openDb()
  const where = ["COALESCE(gone,0) = 0", "TRIM(COALESCE(tags,'')) <> ''"]
  const args = []
  if (folderId) { where.push('folder_id = ?'); args.push(Number(folderId)) }
  const rows = db.prepare(`
    SELECT id, path, folder_id, src_id, size, mtime_ms, tags,
           COALESCE(tags_src,'') AS tags_src
    FROM images
    WHERE ${where.join(' AND ')}
  `).all(...args)

  const seen = new Set()
  const picks = []
  let overwritable = 0
  let legacy = 0
  for (const r of rows) {
    if (seen.has(r.path)) continue
    seen.add(r.path)
    if (!isOrphan(r.tags)) continue
    const canOverwrite = OVERWRITABLE.has(r.tags_src)
    if (canOverwrite) overwritable++
    else legacy++
    if (canOverwrite || includeLegacy) {
      picks.push({ ...r, mode: canOverwrite ? 'orphan' : 'merge' })
    }
  }
  return { total: seen.size, overwritable, legacy, picks }
}

/** 设置弹窗/来源页预检: 只统计, 不动队列 */
export function orphanStats(opts = {}) {
  const s = scan(opts)
  return {
    total: s.overwritable + s.legacy,
    overwritable: s.overwritable,
    legacy: s.legacy,
    included: s.picks.length,
    includeLegacy: !!opts.includeLegacy,
    folderId: Number(opts.folderId) || 0,
  }
}

/**
 * 把选中的图压回 tag_queue(pending), 供 runTagger({onlyOrphans:true}) 消费。
 * 已在队列里的行会被重置为 pending —— 这正是「重新识别」的语义。
 */
export function requeueOrphans({ includeLegacy = false, folderId = 0 } = {}) {
  const s = scan({ includeLegacy, folderId })
  if (!s.picks.length) return { queued: 0, overwritable: s.overwritable, legacy: s.legacy }

  const db = openDb()
  ensureQueueTable(db)
  const now = Date.now()
  const ins = db.prepare(`
    INSERT INTO tag_queue (path, folder_id, src_id, size, mtime_ms, state, attempts, added_at, last_try, note, mode)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      state = 'pending', attempts = 0, added_at = excluded.added_at,
      last_try = 0, note = excluded.note, mode = excluded.mode
  `)
  db.exec('BEGIN')
  try {
    for (const r of s.picks) {
      const merge = r.mode === 'merge'
      ins.run(r.path, Number(r.folder_id) || 0, Number(r.src_id) || 0,
        Number(r.size) || 0, Number(r.mtime_ms) || 0, now,
        merge ? '旧标签补角色' : '无角色补识别', r.mode)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  return { queued: s.picks.length, overwritable: s.overwritable, legacy: s.legacy }
}
