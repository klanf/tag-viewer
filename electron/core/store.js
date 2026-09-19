/**
 * 标签索引库(SQLite) —— tags.db
 * =============================
 * 目的: **不再把 tags_*.txt 当作日常数据源**。
 *   · txt 只在「第一次建库」和「txt 被外部改动后重新导入」时读;
 *   · 平时启动直接读 DB(带索引, 顺序与 txt 完全一致);
 *   · 需要给 Python 版或别的脚本用时, 用 exportToTxt() 从 DB 写回 txt —— 数据不会锁死在库里。
 *
 * 为什么表里把标签存成一段文本(而不是规范化的 image_tags 多对多):
 *   内存里的查询逻辑(dataset.js 的 records/tagCounter/seriesIndex)一行都没改,
 *   它需要的就是「按插入顺序拿到每张图的标签数组」。text 列一次顺序扫描就能重建,
 *   而 7 万行 × 40 标签 ≈ 280 万行 join 反而更慢。
 *   标签字典与出现次数单独存在 `tags` 表里, 需要纯 SQL 查询时够用。
 *
 * 顺序保证: images.id 是自增的, 插入顺序 = 源顺序 + 文件内顺序,
 * 所以 `ORDER BY images.id` 读回来的记录序列与原 txt 解析**逐条一致**
 * (这是能跟 Python 基线对账的前提)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataFile } from './workspace.js'
import { streamTagFile } from './tagfile.js'

const DB_NAME = 'tags.db'
const SCHEMA_VERSION = 1
/** 读回内存时的分块大小 —— 一次性 .all() 会把 80+MB 文本全摆进内存 */
const READ_CHUNK = 4000

let dbHandle = null

export function dbPath() { return dataFile(DB_NAME) }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS src (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,     -- 来源名(去掉 tags_ 前缀的文件名)
  file_path   TEXT    NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  records     INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS images (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  path   TEXT    NOT NULL,
  src_id INTEGER NOT NULL,
  tags   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_images_src ON images(src_id);
CREATE INDEX IF NOT EXISTS idx_images_path ON images(path);
CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT    NOT NULL,
  cnt   INTEGER NOT NULL DEFAULT 0,
  kind  TEXT    NOT NULL DEFAULT ''      -- char=角色标签 / other=普通
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
`

/** 打开(必要时创建)数据库; 同一进程内复用同一个句柄 */
export function openDb() {
  if (dbHandle) return dbHandle
  const p = dbPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const db = new DatabaseSync(p)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (!v) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }
  dbHandle = db
  return db
}

export function closeDb() {
  if (!dbHandle) return
  try { dbHandle.close() } catch { /* 忽略 */ }
  dbHandle = null
}

/** 库是否存在且非空 */
export function dbReady() {
  const p = dbPath()
  if (!fs.existsSync(p)) return { exists: false, images: 0, path: p }
  try {
    const db = openDb()
    const r = db.prepare('SELECT COUNT(*) AS n FROM images').get()
    return { exists: true, images: Number(r?.n || 0), path: p }
  } catch (e) {
    return { exists: true, images: 0, path: p, error: e.message }
  }
}

/* ------------------------------------------------------------------ 导入 */

export function sourceRows() {
  const db = openDb()
  return db.prepare('SELECT * FROM src').all()
}

/**
 * 把 txt 源同步进库: 指纹(size + mtime)没变的跳过, 变了的整源重导,
 * 配置里已删除的源从库里删掉。
 *
 * ⚠️ dataFiles 为空时**直接返回, 什么都不删**
 * ==========================================
 * 下面那段"配置里没有的源就删掉"是为了让移除来源能生效。但"配置读不到"和
 * "用户真的把来源都删了"是两件完全不同的事, 而在空集合上二者无法区分:
 *   · 数据源配置文件缺失 / 解析失败(新装机器、配置文件损坏、上一版那处
 *     指向别人机器的兜底路径失效) -> 解析结果就是空 Map;
 *   · 此时若照常执行删除循环, 会把库里**所有来源和全部图片**删干净。
 * 实测过这条路径: tags.db 里有 8 个来源 / 81650 张图, 一旦空源就全没了,
 * 而且库是**可再生**的, 用户不会立刻发现, 属于最难查的一类数据丢失。
 * 所以空源时提前返回, 让上层走"没有可用的标签数据"的空态引导。
 *
 * @returns {{imported: string[], skipped: string[], removed: string[], ms: number, emptySources?: boolean}}
 */
export async function syncSources(dataFiles, onProgress = () => {}) {
  const t0 = Date.now()
  if (!dataFiles || dataFiles.size === 0) {
    onProgress({ phase: 'db', note: '配置里没有数据源 —— 跳过同步(不清库)' })
    return { imported: [], skipped: [], removed: [], ms: Date.now() - t0, emptySources: true }
  }

  const db = openDb()
  const known = new Map(sourceRows().map((r) => [r.name, r]))
  const imported = []
  const skipped = []
  const removed = []

  for (const [name, fp] of dataFiles.entries()) {
    let st
    try { st = fs.statSync(fp) } catch { st = null }
    if (!st) { onProgress({ phase: 'db', note: `跳过(读不到): ${name}` }); continue }

    const cur = known.get(name)
    const same = cur
      && cur.file_path === fp
      && Number(cur.bytes) === st.size
      && Number(cur.mtime_ms) === Math.round(st.mtimeMs)

    if (same) { skipped.push(name); continue }

    onProgress({ phase: 'db', source: name, note: `导入 ${name} ...` })
    await importSource(db, name, fp, st, onProgress)
    imported.push(name)
  }

  // 配置里已经拿掉的来源 -> 从库里删掉(否则会读到陈旧数据)
  for (const r of known.values()) {
    if (dataFiles.has(r.name)) continue
    db.prepare('DELETE FROM images WHERE src_id = ?').run(r.id)
    db.prepare('DELETE FROM src WHERE id = ?').run(r.id)
    removed.push(r.name)
  }

  if (imported.length || removed.length) rebuildTags()

  return { imported, skipped, removed, ms: Date.now() - t0 }
}

/** 单个源: 先清空旧数据, 再在**一个事务**里灌进去 */
async function importSource(db, name, fp, st, onProgress) {
  const old = db.prepare('SELECT id FROM src WHERE name = ?').get(name)
  if (old) db.prepare('DELETE FROM images WHERE src_id = ?').run(old.id)

  const srcId = (() => {
    if (old) {
      db.prepare('UPDATE src SET file_path=?, bytes=?, mtime_ms=?, records=0, imported_at=? WHERE id=?')
        .run(fp, st.size, Math.round(st.mtimeMs), Date.now(), old.id)
      return old.id
    }
    const r = db.prepare('INSERT INTO src (name, file_path, bytes, mtime_ms, records, imported_at) VALUES (?,?,?,?,0,?)')
      .run(name, fp, st.size, Math.round(st.mtimeMs), Date.now())
    return Number(r.lastInsertRowid)
  })()

  const ins = db.prepare('INSERT INTO images (path, src_id, tags) VALUES (?, ?, ?)')
  let n = 0
  db.exec('BEGIN')
  try {
    const res = await streamTagFile(fp, (rec) => {
      ins.run(rec.path, srcId, rec.tags.join(','))
      n++
    }, (count) => {
      if (count % 5000 === 0) {
        onProgress({ phase: 'db', source: name, records: count, note: `导入 ${name}: ${count} 条` })
      }
    })
    n = res.records
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }

  db.prepare('UPDATE src SET records = ? WHERE id = ?').run(n, srcId)
  return n
}

/** 重建标签字典 + 出现次数(导入之后调用一次) */
export function rebuildTags() {
  const db = openDb()
  const t0 = Date.now()
  const cnt = new Map()
  const chars = new Map()
  const stmt = db.prepare('SELECT tags FROM images')
  for (const row of stmt.iterate()) {
    const s = row.tags || ''
    let start = 0
    for (let i = 0; i <= s.length; i++) {
      if (i === s.length || s.charCodeAt(i) === 44) {
        const t = s.slice(start, i).trim()
        start = i + 1
        if (!t) continue
        cnt.set(t, (cnt.get(t) || 0) + 1)
      }
    }
  }
  // 角色标签: xxx_(系列) 且不是 danbooru 分类组 —— 与 dataset.isCharacterTag 同规则,
  // 这里不 import dataset.js 以免循环依赖, 用同一套正则 + 同一个排除集合
  const NON_SERIES = NON_SERIES_GROUPS_REF
  const RE_CHAR = /^.+_\((.+)\)$/
  for (const t of cnt.keys()) {
    const m = RE_CHAR.exec(t)
    if (m && !NON_SERIES.has(m[1].toLowerCase())) chars.set(t, 1)
  }

  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM tags')
    const ins = db.prepare('INSERT INTO tags (name, cnt, kind) VALUES (?, ?, ?)')
    for (const [t, c] of cnt) ins.run(t, c, chars.has(t) ? 'char' : 'other')
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  return { tags: cnt.size, chars: chars.size, ms: Date.now() - t0 }
}

/**
 * 分块顺序读出所有记录(按 images.id = 插入顺序)。
 * @param {(rec: {path: string, source: string, tags: string[]}) => void} onRecord
 */
export function readRecords(onRecord, onProgress = () => {}) {
  const db = openDb()
  const srcNames = new Map(db.prepare('SELECT id, name FROM src').all().map((r) => [Number(r.id), r.name]))
  const chunk = db.prepare(`
    SELECT i.id AS id, i.path AS path, i.src_id AS src_id, i.tags AS tags
    FROM images i WHERE i.id > ? ORDER BY i.id LIMIT ?
  `)
  let lastId = 0
  let n = 0
  for (;;) {
    const rows = chunk.all(lastId, READ_CHUNK)
    if (!rows.length) break
    for (const r of rows) {
      lastId = Number(r.id)
      const s = r.tags || ''
      const tags = []
      let start = 0
      for (let i = 0; i <= s.length; i++) {
        if (i === s.length || s.charCodeAt(i) === 44) {
          const t = s.slice(start, i).trim()
          start = i + 1
          if (t) tags.push(t)
        }
      }
      if (!tags.length) continue
      onRecord({ path: r.path, source: srcNames.get(Number(r.src_id)) || '', tags })
      n++
    }
    onProgress({ phase: 'db-read', records: n })
  }
  return n
}

/* ------------------------------------------------------------------ 维护 */

export function dbInfo() {
  const p = dbPath()
  let bytes = 0
  let wal = 0
  try { bytes = fs.statSync(p).size } catch { /* 无库 */ }
  try { wal = fs.statSync(p + '-wal').size } catch { /* 无 wal */ }
  try {
    const db = openDb()
    const g = (sql) => Number(db.prepare(sql).get()?.n || 0)
    return {
      path: p,
      bytes,
      walBytes: wal,
      sources: db.prepare('SELECT COUNT(*) AS n FROM src').get()?.n || 0,
      images: g('SELECT COUNT(*) AS n FROM images'),
      tags: g('SELECT COUNT(*) AS n FROM tags'),
      charTags: g("SELECT COUNT(*) AS n FROM tags WHERE kind='char'"),
      sourceList: db.prepare('SELECT name, records, bytes, mtime_ms, imported_at FROM src ORDER BY name').all(),
    }
  } catch (e) {
    return { path: p, bytes, walBytes: wal, error: e.message }
  }
}

/** 把库里的数据写回 tags_<来源名>.txt —— 保留"数据不被锁进 DB"的退路 */
export function exportToTxt(outDir, onProgress = () => {}) {
  const db = openDb()
  const dir = outDir || path.dirname(dbPath())
  fs.mkdirSync(dir, { recursive: true })
  const srcs = db.prepare('SELECT id, name FROM src ORDER BY id').all()
  const written = []
  const chunk = db.prepare('SELECT id, path, tags FROM images WHERE src_id = ? AND id > ? ORDER BY id LIMIT ?')
  for (const s of srcs) {
    const out = []
    let last = 0
    for (;;) {
      const rows = chunk.all(s.id, last, READ_CHUNK)
      if (!rows.length) break
      for (const r of rows) {
        last = Number(r.id)
        out.push(`${r.path}: ${r.tags}`)
      }
    }
    const fp = path.join(dir, `tags_${s.name}.txt`)
    fs.writeFileSync(fp, out.join('\n') + (out.length ? '\n' : ''), 'utf8')
    written.push({ name: s.name, file: fp, records: out.length })
    onProgress({ source: s.name, records: out.length })
  }
  return { dir, written }
}

/** 整库重建(删掉数据库文件重来) */
export function resetDb() {
  closeDb()
  const p = dbPath()
  for (const f of [p, p + '-wal', p + '-shm']) {
    try { fs.rmSync(f, { force: true }) } catch { /* 忽略 */ }
  }
  return { ok: true, path: p }
}

/**
 * danbooru 分类组名的排除集合 —— 与 dataset.js 的 NON_SERIES_GROUPS 必须一致。
 * 这里复制一份而不是 import, 是因为 dataset.js 会 import 本模块(不能反向依赖)。
 * 两边由 scripts/selftest.mjs 的一致性检查把守。
 */
const NON_SERIES_GROUPS_REF = new Set([
  'general', 'character', 'copyright', 'artist', 'meta', 'rating',
  'symbol', 'medium', 'clothing', 'clothes', 'place', 'object', 'language',
  'spoiler', 'photobomb', 'copy', 'text', 'icon', 'logo', 'banner',
  'frame', 'panel', 'source', 'audio', 'video', 'file', 'link',
  'other', 'unknown', 'series', 'work', 'style', 'theme',
  'shape', 'color', 'colour', 'size', 'pattern', 'pose', 'type',
  'category', 'tag', 'group', 'cosplay', 'artwork', 'image',
  'food', 'animal', 'plant', 'vehicle', 'furniture', 'instrument',
  'nature', 'weather', 'sky', 'water', 'fire', 'light', 'dark',
])
