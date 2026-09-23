/**
 * 文件夹登记表 —— **扫描夹 / 看板来源 共用的一份**
 * ================================================
 * 改造前的两本账:
 *   · 扫描页的"文件夹库"  -> dataDir/scan_folders.json
 *   · 看板的"来源"        -> 由 config.data_files_dir 里 tags_*.txt 的文件名隐式决定
 * 于是同一件事有两个身份: 在扫描页加一个目录, 看板不知道; 想给看板加来源,
 * 得去跑外部 Python 脚本生成 tags_<名>.txt 再重启 —— **项目里根本没有入口**。
 *
 * 现在两者都是 `folders` 表里的一行, 靠两个独立开关区分用途:
 *   · `as_source=1` -> 参与标签库(图片进 images、进看板统计、可被搜索)
 *   · `as_scan=1`   -> 仅浏览(扫描页能打开看图, 不进库)
 * 可以同时为 1(如 Syncthing/Download 下的「涩不了一点」), 也可以都是 0 ——
 * 那是**已移出登记表**的目录: 行还留着, 于是"误删"只要把开关打回来就恢复,
 * 而它库里的图片记录一条都不会掉。
 *
 * `scan_folders.json` 降级为两个用途, 都在本文件里:
 *   ① 一次性导入源 —— 由 store.js 的 v1→v2 迁移读一次(见 buildFoldersFromSources)
 *   ② 导出备份     —— exportFoldersJson() 写回, 保留"数据不被锁进 DB"的退路
 *
 * 只存**轻量索引**(路径 + 上次扫描的统计 + 封面), 不存图片清单 ——
 * 清单可能有几千条, 存下来既大又容易过期; 点开时用 scanFolder 现取,
 * 且带内存缓存(见 scan.js), 所以第二次点开是秒开。
 *
 * 注意: 移出登记表**只动登记表, 绝不动磁盘上的文件**, 也不删库里的图片记录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
import { scanFolder, invalidateScanCache } from './scan.js'
import { openDb, normalizeImagePath, upsertFolder, folderRows, folderBaseName, folderNameMap } from './store.js'

/** 兼容期的文件名 —— 现在由 paths.js 的 DATA_ROUTE 路由到 user/folders.json */
const NAME = 'scan_folders.json'
const VERSION = 1

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/**
 * 规范化目录路径: 去首尾引号/空白, 转绝对路径, 统一分隔符, 去掉末尾斜杠。
 *
 * 最后一步必须落在 `normalizeImagePath` —— 它与 `images.path` 的存储形态、
 * 与磁盘枚举、与迁移共用同一个实现。登记表里存的是正斜杠 + 小写盘符,
 * 而 Windows 弹窗/粘贴进来的路径是反斜杠 + 大写盘符: 不做这一步, 同一个目录
 * 会以两种写法各占一行, 而且切换用途时"改了 A 行、列表读的是 B 行"。
 */
export function normFolderPath(p) {
  let s = String(p ?? '').trim().replace(/^"|"$/g, '').trim()
  if (!s) return ''
  try { s = path.resolve(s) } catch { /* 非法路径原样尝试 */ }
  s = normalizeImagePath(s).replace(/\/+$/, '')
  // 盘符根(只到盘符那一段)去掉末尾斜杠后就成了一个不像路径的短串, 补回来
  return /^[a-z]:$/i.test(s) ? `${s}/` : s
}

function safeParse(json) {
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : null } catch { return null }
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

/**
 * DB 行 -> 前端用的对象。
 * 字段名保持与旧版 scan_folders.json 的记录**逐字相同**(last_scan / stats / cover),
 * 因为扫描页的模板与断言都在按这些名字取; 新字段(用途开关 / 入库图数)往后加。
 */
function decorate(row) {
  return {
    id: Number(row.id),
    path: row.path,
    label: row.label || '',
    // 显示名: 优先调用方给的名字(列表走 folderNameMap, 带重名消歧), 否则 label,
    // 再否则文件夹名。**必须与 store.js 的来源名同口径** —— 界面上叫「表世界」、
    // 看板来源条里却没有它, 就是这个口径曾经分叉造成的。
    name: row.name || folderBaseName(row.path, row.label),
    as_source: !!row.as_source,
    as_scan: !!row.as_scan,
    auto_tag: !!row.auto_tag,
    recursive: !!row.recursive,
    added_at: Number(row.added_at) || 0,
    last_scan: Number(row.last_scan_ms) || 0,
    cover: row.cover || '',
    note: row.note || '',
    stats: row.stats_json ? safeParse(row.stats_json) : null,
    images: Number(row.images || 0),          // 库内已有的图片记录数
    tagged: Number(row.tagged || 0),          // 其中由 WD14 反推来的(tags_src='wd14')
    exists: isDir(row.path),
  }
}

/** 一个目录的库内图片数(单行查询用, 不做全表 GROUP BY) */
function imagesOf(db, id) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM images WHERE folder_id = ?').get(id)?.n || 0)
}

function rowByPath(db, p) {
  return db.prepare('SELECT * FROM folders WHERE path = ?').get(p) || null
}

/** tag_queue 是 ingest.js 懒建的(阶段 2 之前的老库没有这张表), 查它之前先确认存在 */
function hasTable(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) } catch { return false }
}

/**
 * 列表(带 exists 标记, 不读盘上的图片)。
 *
 * @param {{usage?: 'scan'|'source'|'all'}} opts
 *   'scan'(默认) = 扫描页的文件夹库; 'source' = 看板来源; 'all' = 全部登记过的
 */
export function listFolders({ usage = 'scan' } = {}) {
  const db = openDb()
  // 名字整表算一次再发下去: 重名消歧要看到**全部**目录才判得准(只看当前 usage
  // 的子集, 同一个文件夹名在两个列表里会得到两个名字)。
  const nameOf = folderNameMap(db)
  return {
    file: dataFile(NAME),
    folders: folderRows(db, { usage }).map((r) => decorate({ ...r, name: nameOf.get(Number(r.id)) })),
  }
}

/**
 * 添加(或刷新)一个文件夹 —— 会真的扫一遍, 把统计与封面记下来。
 * 同一个路径重复添加 = 刷新, 不会产生第二条记录。
 *
 * 用途开关的默认值刻意分两种:
 *   · `as_scan`  缺省视为 true —— 这个函数历史上就是"扫描页加文件夹"的入口
 *   · `as_source` 缺省视为 false(新目录) / 保持原值(已登记) —— 一个目录能不能
 *     进标签库是**重决定**, 不该因为"在扫描页点了一下"就悄悄变成看板来源
 */
export async function addFolder(raw = {}, onProgress = null) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  if (!isDir(p)) return { error: `文件夹不存在: ${p}` }

  const db = openDb()
  const before = rowByPath(db, p)
  const recursive = raw.recursive !== undefined
    ? (raw.recursive !== false && raw.recursive !== '0')
    : (before ? !!before.recursive : true)

  const r = await scanFolder({ path: p, recursive, force: true }, onProgress)
  if (r?.error) return { error: r.error }

  upsertFolder(db, {
    path: p,
    label: raw.label !== undefined ? String(raw.label || '') : String(before?.label || ''),
    as_source: raw.as_source !== undefined
      ? !!raw.as_source
      : (before ? !!before.as_source : false),
    as_scan: raw.as_scan !== undefined ? !!raw.as_scan : true,
    recursive,
    auto_tag: raw.auto_tag !== undefined ? !!raw.auto_tag : (before ? !!before.auto_tag : true),
    last_scan_ms: Date.now(),
    stats: statsOf(r),
    cover: pickCover(r),
  })
  const row = rowByPath(db, p)
  return { ok: true, added: !before, folder: decorate({ ...row, images: imagesOf(db, row.id) }), result: r }
}

/**
 * 移出登记表 —— **只注销用途开关, 不动磁盘、不删库里的图片记录**。
 *
 * 为什么不是 DELETE 那一行: 删掉行之后, 那些 `folder_id` 指向它的图片
 * 会在看板上显示成一个空名字的来源(既筛不到也藏不掉), 而且"误删"就真的
 * 找不回来了。留行 + 两个开关归零 = 界面上消失, 库里的关联完好, 打回开关即恢复。
 * 想连图片记录一起清掉的, 是另一个高危操作(见 purgeFolder)。
 */
export function removeFolder(raw = {}) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  const db = openDb()
  const row = rowByPath(db, p)
  if (!row) return { error: 'not in list' }
  upsertFolder(db, { path: p, as_source: false, as_scan: false })
  invalidateScanCache(p)
  return { ok: true, removed: decorate({ ...rowByPath(db, p), images: imagesOf(db, row.id) }) }
}

/**
 * 彻底清除 —— 高危: 删掉该目录的**全部图片记录**(含标签)以及登记行。
 *
 * 磁盘上的文件一个都不动, 但库里的标签会没, 而且 tags_*.txt 若已归档就没法重建。
 * 界面上必须二次确认。
 */
export function purgeFolder(raw = {}) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  const db = openDb()
  const row = rowByPath(db, p)
  if (!row) return { error: 'not in list' }
  const imgs = imagesOf(db, row.id)
  db.exec('BEGIN')
  try {
    if (hasTable(db, 'tag_queue')) db.prepare('DELETE FROM tag_queue WHERE folder_id = ?').run(row.id)
    db.prepare('DELETE FROM images WHERE folder_id = ?').run(row.id)
    db.prepare('DELETE FROM folders WHERE id = ?').run(row.id)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  invalidateScanCache(p)
  return { ok: true, purged: { path: p, images: imgs } }
}

/**
 * 改登记字段: 显示名 / 备注 / 递归 / 两个用途开关 / 反推开关。
 * 已注销(两个开关都是 0)的行也能改 —— 那正是"恢复"的用法。
 */
export function updateFolder(raw = {}) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  const db = openDb()
  const row = rowByPath(db, p)
  if (!row) return { error: 'not in list' }

  const patch = { path: p }
  if (raw.label !== undefined) patch.label = String(raw.label || '').slice(0, 120)
  if (raw.note !== undefined) patch.note = String(raw.note || '').slice(0, 300)
  if (raw.recursive !== undefined) patch.recursive = raw.recursive !== false && raw.recursive !== '0'
  if (raw.auto_tag !== undefined) patch.auto_tag = raw.auto_tag !== false && raw.auto_tag !== '0'
  if (raw.as_source !== undefined) patch.as_source = raw.as_source !== false && raw.as_source !== '0'
  if (raw.as_scan !== undefined) patch.as_scan = raw.as_scan !== false && raw.as_scan !== '0'
  // 改前快照: 调用方要靠它判"非来源 -> 来源"这个**跃迁**(ipc.js 的 folders:update
  // 拿它决定要不要自动补一次同步)。只看改后的值分不出"刚被登记"和"本来就是来源、
  // 这次只改了别的字段" —— 后者再去同步一遍纯属白扫盘。
  const prev = decorate({ ...row, images: imagesOf(db, row.id) })
  upsertFolder(db, patch)

  // 从"扫描夹"这个用途里拿掉了 -> 那份扫描缓存没必要留着(它会挡住下次重扫)
  if (patch.as_scan === false) invalidateScanCache(p)

  const after = rowByPath(db, p)
  return { ok: true, folder: decorate({ ...after, images: imagesOf(db, after.id) }), prev }
}

/** 重新扫描(强制, 忽略缓存)并更新统计 */
export async function rescanFolder(raw = {}, onProgress = null) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  if (!isDir(p)) return { error: `文件夹不存在: ${p}` }
  const db = openDb()
  const rec = rowByPath(db, p)
  if (!rec) return { error: 'not in list' }

  const recursive = raw.recursive !== undefined
    ? (raw.recursive !== false && raw.recursive !== '0')
    : !!rec.recursive
  const r = await scanFolder({ path: p, recursive, force: true }, onProgress)
  if (r?.error) return { error: r.error }

  upsertFolder(db, {
    path: p, recursive, last_scan_ms: Date.now(), stats: statsOf(r), cover: pickCover(r),
  })
  return { ok: true, folder: decorate({ ...rowByPath(db, p), images: imagesOf(db, rec.id) }), result: r }
}

/**
 * 打开一个文件夹(取图片清单)。
 * 默认走 scan.js 的内存缓存 —— 点过第二次就是秒开; raw.refresh=true 强制重扫。
 */
export async function openFolder(raw = {}, onProgress = null) {
  const p = normFolderPath(raw.path)
  if (!p) return { error: 'empty path' }
  if (!isDir(p)) return { error: `文件夹不存在: ${p}` }

  const db = openDb()
  const rec = rowByPath(db, p)
  const recursive = raw.recursive !== undefined
    ? (raw.recursive !== false && raw.recursive !== '0')
    : (rec ? !!rec.recursive : true)

  const r = await scanFolder({
    path: p,
    recursive,
    limit: raw.limit,
    force: !!raw.refresh,
  }, onProgress)
  if (r?.error) return { error: r.error }

  // 顺手更新统计与"上次打开时间"(封面只在还没有时补)
  if (rec) {
    upsertFolder(db, {
      path: p,
      last_scan_ms: Date.now(),
      stats: statsOf(r),
      ...(rec.cover ? {} : { cover: pickCover(r) }),
    })
  }

  return {
    ...r,
    folder_record: rec ? decorate({ ...rowByPath(db, p), images: imagesOf(db, rec.id) }) : null,
    cached: !!r.cached,
  }
}

/** 批量检查哪些路径还在(启动时刷新一下列表的可用性) */
export function pruneMissing() {
  const db = openDb()
  const rows = folderRows(db, { usage: 'all' })
  return { missing: rows.filter((f) => !isDir(f.path)).map((f) => f.path) }
}

/**
 * 把登记表导出成 `user/folders.json` —— 保留"数据不被锁进 DB"的退路。
 * 与 store.js 的 exportToTxt 同一个思路: 库里是真源, 文件是可带走的副本。
 */
export function exportFoldersJson() {
  const db = openDb()
  const folders = folderRows(db, { usage: 'all' }).map((r) => ({
    id: Number(r.id),
    path: r.path,
    label: r.label || '',
    as_source: !!r.as_source,
    as_scan: !!r.as_scan,
    recursive: !!r.recursive,
    auto_tag: !!r.auto_tag,
    added_at: Number(r.added_at) || 0,
    last_scan: Number(r.last_scan_ms) || 0,
    cover: r.cover || '',
    note: r.note || '',
    stats: r.stats_json ? safeParse(r.stats_json) : null,
  }))
  const file = dataFile(NAME)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: VERSION, exported_at: Date.now(), folders }, null, 2), 'utf8')
  return { ok: true, file, folders: folders.length }
}

export function foldersFile() { return dataFile(NAME) }
