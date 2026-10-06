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
const SCHEMA_VERSION = 2
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

/* ------------------------------------------------------------ v2 schema */

/**
 * v2 新增: `folders` 表 —— 文件夹登记表, **取代** scan_folders.json 与
 * 配置里那份「tags_*.txt 出现在哪个目录」的隐式来源列表。
 *
 * 两个独立开关是要害(2026-09-20 用户澄清):
 *   as_source=1 → 参与标签库: 图片进 images、进看板统计、可被搜索
 *   as_scan=1   → 仅浏览: 扫描页能打开看图, **不进库**
 * 同一目录可以两者都是(如 Syncthing/Download 下的「涩不了一点」);
 * 而 ai图/26_09_18 这种**只看新生成的 AI 图**的目录是扫描夹, 必须
 * as_source=0 —— 它不该被追平进标签库。
 *
 * path 用 COLLATE NOCASE 的唯一索引: Windows 路径大小写不敏感, 只探针到
 * 盘符大小写不同也算同一目录, 不清洗就会长出两条一样目录的记录。
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS folders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- 规范化绝对路径 = 唯一身份
  label        TEXT    NOT NULL DEFAULT '',
  as_source    INTEGER NOT NULL DEFAULT 0,
  as_scan      INTEGER NOT NULL DEFAULT 0,
  recursive    INTEGER NOT NULL DEFAULT 1,
  auto_tag     INTEGER NOT NULL DEFAULT 1,
  added_at     INTEGER NOT NULL DEFAULT 0,
  last_scan_ms INTEGER NOT NULL DEFAULT 0,
  cover        TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_folders_use ON folders(as_source, as_scan);
`

/**
 * v2 之后**追加**的列: [表名, 列名, 定义]。
 *
 * 为什么不把它们塞进 SCHEMA_V2 就完事: 真实库早就跑完 v1→v2 迁移了,
 * 而 `runMigrations` 在 `cur >= SCHEMA_VERSION` 时**直接早退** ——
 * 早退之后 `applyV2Shape` 一次都不会再执行, 于是"往建表语句里补一列"
 * 对已经迁过的库完全无效(这正是加列最容易踩的坑)。
 *
 * 也不用"把 SCHEMA_VERSION 升到 3"来做: 版本号一动, 迁移路径会重跑
 * `backfillV2`, 而它里面的 `buildFoldersFromSources` 用的是
 * `as_scan = MAX(旧值, 新值)` —— 用户已经"移出登记表"的目录会被
 * scan_folders.json 里的旧记录**复活**。为了加一列付出这个代价不值得。
 *
 * 所以走"每次 openDb 幂等补列": 纯加列(带 DEFAULT), 老库原地补齐,
 * 不需要备份、不需要回填、也不会碰到任何既有数据。
 */
const ADDITIVE_COLS = [
  // folders 表: 上次扫描的汇总(卡片上的「N 种提示词 / 含提示词 M」)。
  // 真源是 DB 之后, 这份统计必须跟着登记表一起存 —— 否则卡片要么显示不出来,
  // 要么得为了几个数字把每个目录重新扫一遍。
  ['folders', 'stats_json', "TEXT NOT NULL DEFAULT ''"],
  // folders 表: 封面图的标签快照(JSON 数组, 2026-10-06)。列表时用**当前**安全规则
  // 现算这张封面会不会被藏 —— 只存"当时算好的档位"会在规则改了之后失真。
  // 老记录没有它(空串)不误伤, 重新扫描一次就有了。
  ['folders', 'cover_tags', "TEXT NOT NULL DEFAULT ''"],
  // images 表: 像素尺寸(2026-09-23)。卡片要按图片真实比例渲染, 系列封面要
  // 「优先挑竖图」, 两件事都得先知道每张图多宽多高。
  //
  // **必须加在这里, 不能只加进 IMAGES_V2_COLS** —— 后者由 applyV2Shape 执行,
  // 而 applyV2Shape 只在迁移路径上跑(runMigrations 在 cur >= SCHEMA_VERSION 时
  // 直接早退, 用户库早就迁完了)。这个坑跟下面注释里那段是同一个: "加列"和
  // "建表"不是一个执行时机, 写进建表语句里的列对老库一辈子不生效。
  // 加在这里 = 每次 openDb 都幂等检查一遍, 老库原地补齐。
  ['images', 'px_w', 'INTEGER'],
  ['images', 'px_h', 'INTEGER'],
]

/** v2 给 images 补的列: [列名, 定义]。缺哪个补哪个, 已有则跳过(幂等)。
 *
 * ⚠️ **v2 之后新加的列一律写进 ADDITIVE_COLS, 不要加在这个数组里** ——
 * 它由 applyV2Shape 执行, 而 applyV2Shape 只在迁移路径上跑; 用户库早就
 * 迁到 SCHEMA_VERSION 了, runMigrations 会直接早退, 加在这里对老库
 * **永远不生效**(2026-09-23 加 px_w/px_h 时确认过一次, 差一步就踩进去)。 */
const IMAGES_V2_COLS = [
  ['folder_id', 'INTEGER'],
  ['mtime_ms', 'INTEGER'],
  ['size', 'INTEGER'],
  ['tags_src', "TEXT"],          // meta=图内原生 / wd14=反推 / meta+wd14=原生+反推合并 / legacy=旧 txt
  ['gone', 'INTEGER DEFAULT 0'], // 磁盘上已不存在(灰显保留, 不删记录)
  ['tagged_at', 'INTEGER'],
]

/**
 * 图片路径规范化 —— 迁移、入库、磁盘枚举**必须共用这一个实现**。
 *
 * 为什么必须要它: 库里同一批图有两种写法, 实测 81650 行里 **10436 行**是
 * 混写的(目录段正斜杠 + 文件名前反斜杠, 形如
 * `…/涩一点点\26_07_24Anima_00091_.png`)。不统一的话,
 * 「磁盘有的是什么 / 库里有的是什么」这个差集比对会把同一张图算成两个来源,
 * 于是首轮同步冒出一堆假新增。
 *
 * 只做三件事, 不做大小写整体小写 —— 路径其余部分保留原样(Windows 虽然不区分,
 * 但显示出来还是用户自己的写法顺眼); 盘符统一小写, 这样 `F:` 与 `f:` 能对上。
 */
export function normalizeImagePath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  return s
    .replace(/\\/g, '/')          // 分隔符统一正斜杠
    .replace(/\/{2,}/g, '/')      // 折叠重复分隔符(UNC 前缀已在此类数据里绝迹)
    .replace(/^([A-Za-z]):/, (m, c) => `${c.toLowerCase()}:`)  // 盘符小写
}

/* ------------------------------------------------------------ 迁移与备份 */

/**
 * 一致性备份到 `<dataDir>/tags.db.bak-<suffix>`。
 *
 * 用 `VACUUM INTO` 而不是 `cp`: 前者在事务层做快照, **App 正开着也能拿到一致的
 * 副本**; 直接复制一个正在被写的 SQLite 文件会得到撕裂的副本(WAL 下尤其明显)。
 * 已存在则跳过(迁移只备份一次, 重启不会重复占盘)。
 */
export function backupDb(suffix = 'manual', db = null) {
  const src = dbPath()
  if (!fs.existsSync(src)) return { ok: false, reason: 'no-db', file: '' }
  const file = path.join(path.dirname(src), `tags.db.bak-${suffix}`)
  if (fs.existsSync(file)) {
    return { ok: true, skipped: true, file, bytes: fs.statSync(file).size }
  }
  const h = db || openRaw()
  const before = countAll(h)
  h.exec(`VACUUM INTO '${file.replace(/\\/g, '/')}'`)
  const chk = new DatabaseSync(file, { readOnly: true })
  let after = null
  let integrity = ''
  try {
    after = countAll(chk)
    integrity = chk.prepare('PRAGMA integrity_check').get()?.integrity_check || ''
  } finally { chk.close() }
  const same = JSON.stringify(before) === JSON.stringify(after)
  const ok = same && integrity === 'ok'
  if (!ok) return { ok: false, reason: 'verify-failed', file, before, after, integrity }
  return { ok: true, file, bytes: fs.statSync(file).size, before, after, integrity }
}

function countAll(db) {
  const g = (t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n || 0)
  return { images: g('images'), tags: g('tags'), src: g('src') }
}

function setSchemaVersion(db, v) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(v))
}

export function dbSchemaVersion() {
  const db = openDb()
  return Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value || 0)
}

/** 只建 v2 的形状(表 + 列 + 索引), 不搬数据。幂等。 */
function applyV2Shape(db) {
  db.exec(SCHEMA_V2)
  const cols = new Set(db.prepare('PRAGMA table_info(images)').all().map((r) => r.name))
  for (const [name, def] of IMAGES_V2_COLS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE images ADD COLUMN ${name} ${def}`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_gone ON images(gone)')
}

/**
 * 路径规范化 + 去重(全库一次)。
 *
 * 去重策略: 同一规范化路径只留 **id 最大**的那条(最后一次导入 = 最贴近文件
 * 当前内容), 被丢掉的整行写进报告 —— 不做静默删除。实测 81650 行里只有
 * 2 组碰撞(涩涩涩涩涩 的两张 ComfyUI 临时图, 同名但标签完全不同), 属边缘情形,
 * 但"丢数据不吭声"这种事一次都不能干。
 */
export function normalizeAllPaths(db, onProgress = () => {}) {
  const rows = db.prepare('SELECT id, path FROM images ORDER BY id').all()
  const seen = new Map()              // 规范化路径 -> 当前保留的 id(取最大)
  const collide = []                  // [规范路径, 被丢的 id, 保留的 id]
  const upd = db.prepare('UPDATE images SET path = ? WHERE id = ?')
  for (const r of rows) {
    const n = normalizeImagePath(r.path)
    const prev = seen.get(n)
    if (prev === undefined) {
      seen.set(n, r.id)
      if (n !== r.path) upd.run(n, r.id)
    } else {
      collide.push([n, prev, r.id])   // prev 的 id 更小 -> 丢它
      seen.set(n, r.id)
      if (n !== r.path) upd.run(n, r.id)
    }
  }
  // 收集被丢那几行的原貌(只有极少数, 按需取)
  const dropped = []
  const getRow = db.prepare('SELECT id, path, src_id, tags FROM images WHERE id = ?')
  const del = db.prepare('DELETE FROM images WHERE id = ?')
  for (const [n, dropId, keepId] of collide) {
    const row = getRow.get(dropId)
    if (row) dropped.push({ path: n, dropped: { ...row }, kept_id: keepId })
    del.run(dropId)
  }
  onProgress({ phase: 'migrate', note: `路径规范化: ${rows.length} 行 -> ${seen.size} 条唯一路径, 去重 ${dropped.length} 行` })
  return { rows: rows.length, unique: seen.size, dropped }
}

/** 每个 src 的「物理根目录」= 它的所有图片所属目录的公共前缀 */
export function folderRootOfSrc(db, srcId) {
  const dirs = db.prepare('SELECT path FROM images WHERE src_id = ?').all(srcId)
  if (!dirs.length) return ''
  const split = dirs.map((r) => normalizeImagePath(r.path).split('/').slice(0, -1))
  const first = split[0]
  let k = 0
  for (; k < first.length; k++) if (!split.every((a) => a[k] === first[k])) break
  return first.slice(0, k).join('/')
}

/** 读兼容期的 scan_folders.json(登记表的老家)。读不到就是空数组。 */
function readScanFoldersLegacy() {
  try {
    const p = dataFile('scan_folders.json')
    if (!fs.existsSync(p)) return []
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(d?.folders) ? d.folders : []
  } catch { return [] }
}

/**
 * 建/更新 folders 行:
 *   · 每个 src(来自 tags_*.txt) -> as_source=1, 物理根目录从 images.path 反查
 *   · scan_folders.json 里登记的目录 -> as_scan=1(已在 src 里的直接叠加),
 *     不在 src 里的(如 26_09_18) -> as_source=0 纯扫描夹
 * **目录一律从数据里反查, 不写死机器路径** —— 否则脚本就不可移植了。
 */
export function buildFoldersFromSources(db, onProgress = () => {}) {
  const scan = readScanFoldersLegacy()
  const scanNorm = new Map(scan.map((f) => [normalizeImagePath(f.path), f]))
  const now = Date.now()
  const up = db.prepare(`
    INSERT INTO folders (path, label, as_source, as_scan, recursive, added_at, last_scan_ms, cover, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      label        = CASE WHEN excluded.label <> '' THEN excluded.label ELSE folders.label END,
      as_source    = MAX(folders.as_source, excluded.as_source),
      as_scan      = MAX(folders.as_scan,   excluded.as_scan),
      recursive    = MAX(folders.recursive, excluded.recursive),
      last_scan_ms = MAX(folders.last_scan_ms, excluded.last_scan_ms),
      cover        = CASE WHEN excluded.cover <> '' THEN excluded.cover ELSE folders.cover END
  `)
  const made = []

  for (const s of db.prepare('SELECT id, name FROM src ORDER BY id').all()) {
    const root = folderRootOfSrc(db, s.id)
    if (!root) continue
    const legacy = scanNorm.get(root)
    up.run(root, String(s.name), 1, legacy ? 1 : 0,
      legacy ? (legacy.recursive === false ? 0 : 1) : 1,
      Number(legacy?.added_at) || now,
      Number(legacy?.last_scan) || 0,
      String(legacy?.cover || ''),
      String(legacy?.note || ''))
    made.push({ path: root, label: String(s.name), as_source: 1, as_scan: legacy ? 1 : 0 })
    if (root.split('/').length < 3) {
      onProgress({ phase: 'migrate', note: `⚠ 来源「${s.name}」的公共根目录过浅: ${root} —— 请人工确认` })
    }
  }

  // 只在 scan_folders.json 里、不在任何 src 里的目录 -> 纯扫描夹
  const known = new Set(db.prepare('SELECT path FROM folders').all().map((r) => normalizeImagePath(r.path)))
  for (const f of scan) {
    const p = normalizeImagePath(f.path)
    if (!p || known.has(p)) continue
    up.run(p, String(f.label || ''), 0, 1,
      f.recursive === false ? 0 : 1,
      Number(f.added_at) || now, Number(f.last_scan) || 0,
      String(f.cover || ''), String(f.note || ''))
    made.push({ path: p, label: String(f.label || ''), as_source: 0, as_scan: 1 })
  }

  onProgress({ phase: 'migrate', note: `folders 表: ${made.length} 条记录` })
  return made
}

/* ------------------------------------------------------- 登记表(folders) */

/**
 * 建/更新一条 folders 行 —— 登记表的**唯一写入口**。
 *
 * `path` 用 normalizeImagePath 规范化, 与 images.path / 磁盘枚举共用同一个实现,
 * 所以"同一个目录"在任何入口都落到同一行(NOCASE 唯一索引兜底盘符大小写差异)。
 *
 * 语义上刻意区分"这次要写什么"与"不要动什么":
 *   · label/cover/note: 非空才覆盖(空值通常意味着"这次没提供", 不是"清空")
 *   · as_source/as_scan: 显式传布尔才动 —— 否则会把用户刚关掉的开关又打开
 *   · recursive/auto_tag: 同上
 *   · last_scan_ms/stats_json: 只在显式传值时更新
 *
 * @param {object} db
 * @param {{path:string, label?:string, as_source?:boolean, as_scan?:boolean,
 *          recursive?:boolean, auto_tag?:boolean, last_scan_ms?:number,
 *          stats?:object|null, cover?:string, cover_tags?:string, note?:string, added_at?:number}} f
 * @returns {{id:number, path:string, created:boolean}}
 */
export function upsertFolder(db, f) {
  const p = normalizeImagePath(f.path)
  if (!p) return { id: 0, path: '', created: false }
  const now = Date.now()
  const cur = db.prepare('SELECT * FROM folders WHERE path = ?').get(p)

  if (!cur) {
    const r = db.prepare(`
      INSERT INTO folders (path, label, as_source, as_scan, recursive, auto_tag,
                           added_at, last_scan_ms, cover, cover_tags, note, stats_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      p,
      String(f.label || ''),
      f.as_source ? 1 : 0,
      f.as_scan ? 1 : 0,
      f.recursive === false ? 0 : 1,
      f.auto_tag === false ? 0 : 1,
      Number(f.added_at) || now,
      Number(f.last_scan_ms) || 0,
      String(f.cover || ''),
      String(f.cover_tags || ''),
      String(f.note || ''),
      f.stats ? JSON.stringify(f.stats) : '',
    )
    return { id: Number(r.lastInsertRowid), path: p, created: true }
  }

  const sets = []
  const args = []
  const put = (col, val) => { sets.push(`${col} = ?`); args.push(val) }
  if (f.label !== undefined && String(f.label) !== '') put('label', String(f.label).slice(0, 120))
  if (f.as_source !== undefined) put('as_source', f.as_source ? 1 : 0)
  if (f.as_scan !== undefined) put('as_scan', f.as_scan ? 1 : 0)
  if (f.recursive !== undefined) put('recursive', f.recursive ? 1 : 0)
  if (f.auto_tag !== undefined) put('auto_tag', f.auto_tag ? 1 : 0)
  if (f.last_scan_ms !== undefined) put('last_scan_ms', Number(f.last_scan_ms) || 0)
  if (f.stats !== undefined) put('stats_json', f.stats ? JSON.stringify(f.stats) : '')
  if (f.cover !== undefined && String(f.cover) !== '') put('cover', String(f.cover))
  if (f.cover_tags !== undefined) put('cover_tags', String(f.cover_tags || ''))
  if (f.note !== undefined) put('note', String(f.note).slice(0, 300))
  if (sets.length) {
    args.push(Number(cur.id))
    db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  }
  return { id: Number(cur.id), path: p, created: false }
}

/**
 * 登记表查询。usage:
 *   'source' = 看板来源(as_source=1) / 'scan' = 扫描夹(as_scan=1)
 *   'all'    = 全部(含"已移出登记表"的, 它们两个开关都是 0 —— 界面上可恢复)
 *
 * `hasImages` 顺带把"入库图数"算出来(来源管理页要显示), 用一次 GROUP BY 拿到,
 * 不要每行再单查一次(9 个文件夹 × 80k 行的库, 逐个查会明显卡)。
 */
export function folderRows(db, { usage = 'all' } = {}) {
  const where = usage === 'source' ? 'WHERE f.as_source = 1'
    : usage === 'scan' ? 'WHERE f.as_scan = 1'
      : ''
  return db.prepare(`
    SELECT f.*,
           COALESCE(c.n, 0) AS images,
           COALESCE(c.tagged, 0) AS tagged
      FROM folders f
      LEFT JOIN (
        SELECT folder_id, COUNT(*) AS n,
               SUM(CASE WHEN tags_src IN ('wd14', 'meta+wd14') THEN 1 ELSE 0 END) AS tagged
        FROM images GROUP BY folder_id
      ) c ON c.folder_id = f.id
      ${where}
     ORDER BY f.id
  `).all()
}

/**
 * 目录的**基础显示名**: label 优先, 留空则用文件夹名。
 *
 * 为什么必须有这层兜底 —— label 不只是"备注", 它同时是**看板分组的键**:
 * readRecords 把它填进 record.source, sourceNameList 把它当来源名。而"空 label"
 * 是完全合法的一种状态(扫描页「添加文件夹」就不传 label, 界面上的名字是
 * folders.js 的 decorate() 用 basename 临时合成的), 于是 DB 里的空串在界面上
 * **看不出来**。少了这层兜底, 新登记的目录会拿到一个空来源名: 图在库里、也计进
 * 「全部」, 却没有任何来源胶囊能筛到它 —— 2026-09-23 实测, 「表世界」的 2970 张
 * 就这么隐身了(它们全挤在一个名为空串的隐形分组里)。
 */
export function folderBaseName(path, label) {
  const l = String(label ?? '').trim()
  if (l) return l
  const s = String(path || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return (i >= 0 ? s.slice(i + 1) : s) || s
}

/**
 * folders.id -> 显示名。**一次算全表**, 让 sourceNameList 与 readRecords 拿到
 * 同一份名字 —— 两边算法只要不一致, record.source 就会对不上任何来源名。
 *
 * 重名要消歧: `x/桌面壁纸` 与 `x/桌面壁纸/桌面壁纸` 的 basename 都是「桌面壁纸」。
 * 来源名是筛选的键, 重复键会让两批图共用一个胶囊(选中一个等于选了两个)。
 * 先用父目录名区分, 再撞就缀上 id。
 */
export function folderNameMap(db) {
  const rows = db.prepare('SELECT id, path, label FROM folders ORDER BY id').all()
  const base = rows.map((r) => folderBaseName(r.path, r.label))
  const dup = new Map()
  for (const b of base) dup.set(b, (dup.get(b) || 0) + 1)
  const out = new Map()
  const taken = new Set()
  rows.forEach((r, i) => {
    let n = base[i]
    if (dup.get(n) > 1) {
      const parent = folderBaseName(String(r.path).replace(/[\\/][^\\/]*$/, ''), '')
      n = parent ? `${n} (${parent})` : n
      if (taken.has(n)) n = `${n} #${r.id}`
    }
    taken.add(n)
    out.set(Number(r.id), n)
  })
  return out
}

/**
 * 「看板来源」的名字清单 —— 侧栏来源筛选条 / 统计接口都用它。
 *
 * 阶段 4 之前这里读的是 `[...dataFiles.keys()]`(即 tags_*.txt 的文件名), 于是
 * **来源列表和真源绑死在 txt 上**: txt 一归档, 来源列表立刻空掉、来源筛选全废,
 * 而库里的记录其实一条没少。改成读登记表之后, 来源的定义回到"我登记了哪些目录",
 * txt 退化成一次性的导入介质。
 *
 * 兜底: 登记表里一条 as_source 都没有时(全新库还没导入过), 退回 src 表的名字 ——
 * 保证"刚导入完 txt、还没建 folders 行"的中间态也能正确显示来源。
 *
 * 另有一类"有 src 行但没有 folders 行"的遗留来源: 该 txt 导入时读到了 0 条
 * (实测过一次: 那个文件当时正被 Syncthing 半途写入), 指纹却记下了, 于是
 * 之后再也不会重导 —— `folderRootOfSrc` 从 0 张图反查不出目录, 登记行自然没建。
 * 这类来源按名字并进来(哪怕它是空的), 免得用户"明明有个来源却从列表里凭空消失"。
 */
export function sourceNameList(db = null) {
  const d = db || openDb()
  const nameOf = folderNameMap(d)
  const names = d.prepare('SELECT id FROM folders WHERE as_source = 1 ORDER BY id')
    .all().map((r) => nameOf.get(Number(r.id)))
    .filter((n) => !!n)
  if (names.length) {
    /* src 表的兜底: 只补**还有可见记录**的老来源。
       它的原意是「有 src 行、没有 folders 行」的遗留来源别凭空消失, 但 2026-09-23
       发现它会把**已经注销掉来源的目录**又拉回列表 —— 「桌面壁纸」被移出后仍然
       以来源身份出现(它的图也还在看板里), 用户看到的就是"移出没生效"。
       现在的判据: 该 src 名下的图, 是不是还有落在 as_source=1 的目录里(或压根
       没有目录行的遗留)。全被注销了就不再出现在来源条上 —— 语义与 readRecords
       的可见性判据严格一致, 免得出现"胶囊在、点进去 0 张"的空壳。 */
    const aliveSrcIds = new Set(d.prepare(`
      SELECT DISTINCT i.src_id AS id
      FROM images i LEFT JOIN folders f ON f.id = i.folder_id
      WHERE i.src_id > 0 AND (f.id IS NULL OR f.as_source = 1)
    `).all().map((r) => Number(r.id)))
    for (const r of d.prepare('SELECT id, name, records FROM src ORDER BY id').all()) {
      if (Number(r.records || 0) <= 0) continue
      if (!aliveSrcIds.has(Number(r.id))) continue
      if (!names.includes(String(r.name))) names.push(String(r.name))
    }
    return [...new Set(names)]
  }
  return d.prepare('SELECT name FROM src ORDER BY id').all().map((r) => String(r.name))
}

/** v1 -> v2 的数据搬运(在事务里跑) */
function backfillV2(db, onProgress) {
  // 老记录一律 legacy: 它们是从 tags_*.txt 导入的, 不是从图里读的、也不是反推的
  const legacy = db.prepare("UPDATE images SET tags_src = 'legacy' WHERE tags_src IS NULL OR tags_src = ''").run()
  onProgress({ phase: 'migrate', note: `tags_src 回填 legacy: ${legacy.changes} 行` })

  const paths = normalizeAllPaths(db, onProgress)
  const folders = buildFoldersFromSources(db, onProgress)

  // folder_id: 由 src_id 映射到 folders.id(label 就是来源名)
  const fidByName = new Map(db.prepare('SELECT id, label FROM folders').all().map((r) => [r.label, r.id]))
  let linked = 0
  for (const s of db.prepare('SELECT id, name FROM src ORDER BY id').all()) {
    const fid = fidByName.get(String(s.name))
    if (!fid) continue
    linked += db.prepare('UPDATE images SET folder_id = ? WHERE src_id = ?').run(fid, s.id).changes
  }
  onProgress({ phase: 'migrate', note: `folder_id 关联: ${linked} 行` })
  return { legacy: legacy.changes, paths, folders, linked }
}

let _migrateMemo = null

/**
 * 按 meta.schema_version 决定要不要迁移。幂等: 版本够了立刻返回。
 *
 * 全新库走"直接建 v2 形状"的短路 —— 没有历史数据要搬, 也就不需要备份。
 * v1 老库走完整路径, **先备份再动数据**; 整个搬运放在一个事务里,
 * SQLite 的 DDL 也在事务内, 所以中途失败是干净的"全有或全无"。
 */
export function runMigrations(db, onProgress = () => {}) {
  const cur = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value || 0)
  if (cur >= SCHEMA_VERSION) return { from: cur, to: cur, changed: false }
  if (_migrateMemo) return _migrateMemo

  if (cur === 0) {
    applyV2Shape(db)
    setSchemaVersion(db, SCHEMA_VERSION)
    _migrateMemo = { from: 0, to: SCHEMA_VERSION, changed: true, fresh: true }
    return _migrateMemo
  }

  const bak = backupDb(`v${cur}`, db)
  onProgress({ phase: 'migrate', note: `schema v${cur} -> v${SCHEMA_VERSION}; 备份 ${bak.ok ? '完成' : '失败: ' + bak.reason}` })
  if (!bak.ok) {
    // 备份失败就不动数据 —— 迁移是可选动作, 数据安全不是
    throw new Error(`迁移前备份失败(${bak.reason}), 已放弃迁移以免数据不可回退`)
  }

  db.exec('BEGIN')
  let report
  try {
    applyV2Shape(db)
    report = backfillV2(db, onProgress)
    setSchemaVersion(db, SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }
  // 迁移自己留审计痕迹 —— 不依赖调用方记得落盘。
  // 丢掉的行(路径规范化产生的重复)必须能查到原貌, 否则"去重"就成了静默删数据。
  const reportFile = writeMigrationReport(cur, SCHEMA_VERSION, report, bak)
  _migrateMemo = { from: cur, to: SCHEMA_VERSION, changed: true, backup: bak.file, report, reportFile }
  return _migrateMemo
}

/** 迁移报告落盘 —— 事后能查清"这次迁移到底动了什么、丢了哪几行" */
function writeMigrationReport(from, to, report, bak) {
  const file = path.join(path.dirname(dbPath()), 'cache', `migration-report-v${from}-to-v${to}.json`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      from,
      to,
      backup: bak?.file || '',
      counts: {
        legacyTagged: report.legacy,
        pathRows: report.paths.rows,
        pathUnique: report.paths.unique,
        pathDropped: report.paths.dropped.length,
        folderIdLinked: report.linked,
        folders: report.folders.length,
      },
      droppedRows: report.paths.dropped,
      folders: report.folders,
    }, null, 2), 'utf8')
    return file
  } catch { return '' }
}

/* ------------------------------------------------------------ 打开数据库 */

/** 打开库但**不做迁移** —— 迁移本身需要先有个句柄(备份也是) */
export function openRawDb() {
  return openRaw()
}

function openRaw() {
  if (dbHandle) return dbHandle
  const p = dbPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const db = new DatabaseSync(p)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // 迁移会做 ALTER TABLE + 全表 UPDATE, 需要短暂的写锁。App 可能正开着,
  // 没有 busy_timeout 时 DDL 会立刻抛 SQLITE_BUSY 而不是等一等。
  db.exec('PRAGMA busy_timeout = 15000')
  db.exec(SCHEMA)
  dbHandle = db
  return db
}

/**
 * 幂等补齐"追加列"。表还不存在时静默跳过(全新库的建表在 SCHEMA/SCHEMA_V2 里,
 * 而且 openDb 的调用顺序保证了这里跑之前迁移已经执行完)。
 */
function applyAdditiveCols(db) {
  for (const [table, name, def] of ADDITIVE_COLS) {
    let cols
    try { cols = db.prepare(`PRAGMA table_info(${table})`).all() } catch { continue }
    if (!cols.length) continue
    if (cols.some((c) => c.name === name)) continue
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`) } catch { /* 并发下别人加过了 */ }
  }
}

/** 打开(必要时创建)数据库并保证 schema 已是最新; 同一进程内复用同一个句柄 */
export function openDb() {
  const db = openRaw()
  runMigrations(db)
  applyAdditiveCols(db)
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

  const ins = db.prepare('INSERT INTO images (path, src_id, tags, tags_src, folder_id) VALUES (?, ?, ?, ?, ?)')
  const srcName = db.prepare('SELECT name FROM src WHERE id = ?').get(srcId)?.name
  const folderId = srcName
    ? db.prepare('SELECT id FROM folders WHERE label = ?').get(String(srcName))?.id ?? null
    : null
  let n = 0
  db.exec('BEGIN')
  try {
    const res = await streamTagFile(fp, (rec) => {
      // 入库就规范化 —— 与迁移、与磁盘枚举共用 normalizeImagePath, 三处必须一致
      ins.run(normalizeImagePath(rec.path), srcId, rec.tags.join(','), 'legacy', folderId)
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

  // txt 导入顺带把目录登记进 folders 表 —— 这一步是「来源列表改读 DB」的必要条件:
  // 全新库里 folders 表是空的(建表短路不走 backfillV2), 来源清单如果只认登记表,
  // 就只剩"先跑过 v1→v2 迁移的老库"能显示出源来。导入时顺手登记, 新旧库行为一致。
  // 已存在的行**不重设 as_source** —— 用户主动"移出登记表"过的目录不该被 txt 复活。
  const root = folderRootOfSrc(db, srcId)
  if (root) {
    const had = db.prepare('SELECT id FROM folders WHERE path = ?').get(normalizeImagePath(root))
    upsertFolder(db, { path: root, label: srcName || '', ...(had ? {} : { as_source: true }) })
  }
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
 *
 * ⚠️ async(2026-10-04): 整库 7 万行即使分块读, 同步连跑也是数秒级 —— 期间
 * 主进程事件循环完全卡死, 所有 IPC(光箱翻页/缩略图/搜索)全部排队, 界面表现
 * 为"卡住几秒动不了"。现在每读完一块(4000 行)就 setImmediate 让出一次事件
 * 循环, 积压的 IPC 得以插进来处理 —— 后台重载不再打断正在翻图的用户。
 * 消费方必须 await(返回 Promise<number>, n = 记录数)。
 */
export async function readRecords(onRecord, onProgress = () => {}) {
  const db = openDb()
  const srcNames = new Map(db.prepare('SELECT id, name FROM src').all().map((r) => [Number(r.id), r.name]))
  // 来源名兜底: 增量入库进来的记录不属于任何 txt 源(src_id=0),
  // 它们的来源应该由**目录显示名**决定(label 留空则用文件夹名, 见 folderBaseName)。
  // 少了这一层, 看板的来源列表里会冒出一组空名字, 而那些图既筛不到也藏不掉。
  const folderNames = folderNameMap(db)

  /* 可见性: 图还在库里(gone=0), 但它的目录已经把「看板来源」这个用途注销了 ——
     那就不再看板出现。这就是「移出来源 = 从看板隐藏, 打回开关即恢复」的实现:
     **一行 images 都不改**(所以是非破坏、可逆的, 也不与 gone 那套"文件不见了"
     的语义打架), 只在这里收窄一次。
     folder_id 为 0/NULL 的老记录不受影响 —— 那些是直接解析 txt 进来的遗留,
     根本没有目录行, 拿 as_source 判它们没有意义。 */
  const offIds = db.prepare('SELECT id FROM folders WHERE as_source = 0').all().map((r) => Number(r.id))
  const vis = offIds.length
    ? ` AND (i.folder_id IS NULL OR i.folder_id NOT IN (${offIds.map(() => '?').join(',')}))`
    : ''
  const chunk = db.prepare(`
    SELECT i.id AS id, i.path AS path, i.src_id AS src_id, i.folder_id AS folder_id,
           i.tags AS tags, i.px_w AS px_w, i.px_h AS px_h
    FROM images i WHERE i.id > ? AND i.gone = 0${vis} ORDER BY i.id LIMIT ?
  `)
  let lastId = 0
  let n = 0
  for (;;) {
    const rows = chunk.all(lastId, ...offIds, READ_CHUNK)
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
      onRecord({
        path: r.path,
        source: srcNames.get(Number(r.src_id))
          || folderNames.get(Number(r.folder_id))
          || '',
        tags,
        // 像素尺寸: 卡片按真实比例渲染 / 系列封面优先挑竖图的依据。
        // 老库回填之前这里是 null —— 消费方一律**回落到改动前的行为**,
        // 不要拿 0 或猜测值凑一个比例出来。
        px_w: r.px_w === null || r.px_w === undefined ? 0 : Number(r.px_w),
        px_h: r.px_h === null || r.px_h === undefined ? 0 : Number(r.px_h),
      })
      n++
    }
    onProgress({ phase: 'db-read', records: n })
    // 每块让出一次事件循环(见函数头注释) —— node:sqlite 是同步 API,
    // 不主动让路的话 7 万行连跑期间整个主进程对 IPC 是"失联"的。
    await new Promise((r) => setImmediate(r))
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
      schemaVersion: g("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'schema_version'"),
      sources: db.prepare('SELECT COUNT(*) AS n FROM src').get()?.n || 0,
      images: g('SELECT COUNT(*) AS n FROM images'),
      tags: g('SELECT COUNT(*) AS n FROM tags'),
      charTags: g("SELECT COUNT(*) AS n FROM tags WHERE kind='char'"),
      folders: g('SELECT COUNT(*) AS n FROM folders'),
      foldersAsSource: g('SELECT COUNT(*) AS n FROM folders WHERE as_source=1'),
      foldersAsScan: g('SELECT COUNT(*) AS n FROM folders WHERE as_scan=1'),
      gone: g('SELECT COUNT(*) AS n FROM images WHERE gone=1'),
      tagged: g('SELECT COUNT(*) AS n FROM images WHERE tagged_at IS NOT NULL'),
      byTagsSrc: db.prepare("SELECT COALESCE(tags_src,'(空)') AS k, COUNT(*) AS n FROM images GROUP BY k ORDER BY n DESC").all(),
      sourceList: db.prepare('SELECT name, records, bytes, mtime_ms, imported_at FROM src ORDER BY name').all(),
      folderList: db.prepare('SELECT id, path, label, as_source, as_scan, recursive, auto_tag FROM folders ORDER BY id').all(),
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
