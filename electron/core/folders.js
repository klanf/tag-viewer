/**
 * 扫描文件夹「收藏夹」—— 扫描过的目录会被记下来, 下次直接点开
 * ============================================================
 * 旧版(以及本重构的第一版)每次都要重新选目录 / 重新粘路径再扫一遍,
 * 目录一多就变成体力活。这里把「扫过的文件夹」持久化到 dataDir 下的
 * `scan_folders.json`, 成为一个可以一直往里加、点开即看的列表。
 *
 * 只存**轻量索引**(路径 + 上次扫描的统计 + 封面), 不存图片清单 ——
 * 清单可能有几千条, 存下来既大又容易过期; 点开时用 scanFolder 现取,
 * 且带内存缓存(见 scan.js), 所以第二次点开是秒开。
 *
 * 注意: 删除一条记录**只删记录, 绝不动磁盘上的文件**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
import { scanFolder, invalidateScanCache } from './scan.js'

const NAME = 'scan_folders.json'
const VERSION = 1

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/** 规范化路径: 去首尾引号/空白, 统一分隔符, 去掉末尾反斜杠 */
export function normFolderPath(p) {
  let s = String(p ?? '').trim().replace(/^"|"$/g, '').trim()
  if (!s) return ''
  s = path.resolve(s).replace(/[\\/]+$/, '')
  return s
}

function emptyDb() {
  return { version: VERSION, folders: [] }
}

function loadRaw() {
  const p = dataFile(NAME)
  if (!fs.existsSync(p)) return emptyDb()
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!d || typeof d !== 'object' || !Array.isArray(d.folders)) return emptyDb()
    return {
      version: d.version || VERSION,
      folders: d.folders.filter((f) => f && typeof f.path === 'string' && f.path),
    }
  } catch {
    return emptyDb()
  }
}

function saveRaw(db) {
  const p = dataFile(NAME)
  fs.writeFileSync(p, JSON.stringify(db, null, 2), 'utf8')
  return p
}

function statsOf(r) {
  const items = r.items || []
  return {
    total: r.total || 0,                        // 枚举到的文件数(可能被上限截断)
    truncated: !!r.truncated,
    with_prompt: r.with_prompt || 0,
    distinct_prompts: r.distinct_prompts || 0,
    shared_count: (r.shared_tags || []).length,
    files: items.length,
  }
}

/** 封面: 优先"有提示词的第一张", 否则第一张 */
function pickCover(r) {
  const items = r.items || []
  const hit = items.find((it) => it.tags && it.tags.length) || items[0]
  return hit?.path || ''
}

function decorate(f) {
  const exists = isDir(f.path)
  return {
    ...f,
    name: f.label || path.basename(f.path) || f.path,
    exists,
  }
}

/** 列表(带 exists 标记, 不读盘上的图片) */
export function listFolders() {
  const db = loadRaw()
  return {
    file: dataFile(NAME),
    folders: db.folders.map(decorate),
  }
}

/** 找一个记录(不 decorate) */
function find(db, p) {
  return db.folders.find((f) => f.path.toLowerCase() === p.toLowerCase())
}

/** 新增或更新一条记录(按路径去重, 大小写不敏感) */
function upsert(db, p, patch) {
  const now = Date.now()
  let rec = find(db, p)
  if (!rec) {
    rec = {
      path: p,
      label: '',
      added_at: now,
      last_scan: 0,
      recursive: true,
      stats: null,
      cover: '',
      note: '',
    }
    db.folders.push(rec)
  }
  Object.assign(rec, patch)
  return rec
}

/**
 * 添加(或刷新)一个文件夹 —— 会真的扫一遍, 把统计与封面记下来。
 * 同一个路径重复添加 = 刷新, 不会产生第二条记录。
 */
export async function addFolder(raw = {}, onProgress = null) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  if (!isDir(p)) return { error: `文件夹不存在: ${p}` }

  const recursive = raw.recursive !== false && raw.recursive !== '0'
  const r = await scanFolder({ path: p, recursive, force: true }, onProgress)
  if (r?.error) return { error: r.error }

  const db = loadRaw()
  const existed = !!find(db, p)
  const rec = upsert(db, p, {
    recursive,
    last_scan: Date.now(),
    stats: statsOf(r),
    cover: pickCover(r),
  })
  if (raw.label !== undefined) rec.label = String(raw.label || '')
  saveRaw(db)

  return { ok: true, added: !existed, folder: decorate(rec), result: r }
}

/** 只删记录, 不动磁盘 */
export function removeFolder(raw = {}) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  const db = loadRaw()
  const i = db.folders.findIndex((f) => f.path.toLowerCase() === p.toLowerCase())
  if (i < 0) return { error: 'not in list' }
  const [gone] = db.folders.splice(i, 1)
  saveRaw(db)
  invalidateScanCache(gone.path)
  return { ok: true, removed: decorate(gone) }
}

/** 改显示名(note 可空) */
export function updateFolder(raw = {}) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  const db = loadRaw()
  const rec = find(db, p)
  if (!rec) return { error: 'not in list' }
  if (raw.label !== undefined) rec.label = String(raw.label || '').slice(0, 120)
  if (raw.note !== undefined) rec.note = String(raw.note || '').slice(0, 300)
  if (raw.recursive !== undefined) rec.recursive = raw.recursive !== false && raw.recursive !== '0'
  saveRaw(db)
  return { ok: true, folder: decorate(rec) }
}

/** 重新扫描(强制, 忽略缓存)并更新统计 */
export async function rescanFolder(raw = {}, onProgress = null) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  if (!isDir(p)) return { error: `文件夹不存在: ${p}` }
  const db = loadRaw()
  const rec = find(db, p)
  if (!rec) return { error: 'not in list' }

  const recursive = raw.recursive !== undefined
    ? (raw.recursive !== false && raw.recursive !== '0')
    : rec.recursive
  const r = await scanFolder({ path: p, recursive, force: true }, onProgress)
  if (r?.error) return { error: r.error }

  rec.recursive = recursive
  rec.last_scan = Date.now()
  rec.stats = statsOf(r)
  rec.cover = pickCover(r)
  saveRaw(db)
  return { ok: true, folder: decorate(rec), result: r }
}

/**
 * 打开一个文件夹(取图片清单)。
 * 默认走 scan.js 的内存缓存 —— 点过第二次就是秒开; raw.refresh=true 强制重扫。
 */
export async function openFolder(raw = {}, onProgress = null) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  if (!isDir(p)) return { error: `文件夹不存在: ${p}` }

  const db = loadRaw()
  const rec = find(db, p)
  const recursive = raw.recursive !== undefined
    ? (raw.recursive !== false && raw.recursive !== '0')
    : (rec ? rec.recursive : true)

  const r = await scanFolder({
    path: p,
    recursive,
    limit: raw.limit,
    force: !!raw.refresh,
  }, onProgress)
  if (r?.error) return { error: r.error }

  // 顺手更新统计与"上次打开时间"(封面只在还没有时补)
  if (rec) {
    rec.last_scan = Date.now()
    rec.stats = statsOf(r)
    if (!rec.cover) rec.cover = pickCover(r)
    saveRaw(db)
  }

  return {
    ...r,
    folder_record: rec ? decorate(rec) : null,
    cached: !!r.cached,
  }
}

/** 批量检查哪些路径还在(启动时刷新一下列表的可用性) */
export function pruneMissing() {
  const db = loadRaw()
  const gone = db.folders.filter((f) => !isDir(f.path))
  return { missing: gone.map((f) => f.path) }
}

export function foldersFile() { return dataFile(NAME) }
