/**
 * 增量入库 —— 让磁盘与 tags.db 对齐
 * ==================================
 * 方案: docs/数据源合并与增量入库方案.md §2.2 六条判定规则。
 *
 * **核心: DB 是准入闸门**(2026-09-20 用户纠正)。
 * 反推的充分条件不是「图内没有元数据」, 而是**「库里没有这张图的标签」**。
 * 实测: 涩不了一点的 9296 张图内都没有元数据, 但库里早已有 9202 条标签
 * (早期 PixAI 反推后直接合并进 tags_*.txt, 并未写回 PNG)——
 * 若按「无元数据就反推」设计, 会把近万张已经反推过的图整批重跑一遍。
 *
 * 规则落地(自上而下, 命中即止):
 *   1. 库有 + 指纹(mtime+size)一致        -> 跳过(不读图)
 *   2. 库有 + 指纹变了                    -> 重读元数据; 读到就覆盖, 读不到则保留原标签并重新入队
 *   3. 库无 + 图内**有**元数据            -> 直接入库(tags_src='meta'), **并且入队反推**(见下)
 *   4. 库无 + 图内**无**元数据            -> 入 tag_queue(等阶段 3 的反推管道消费)
 *   5. 库有 + 磁盘已不见                  -> gone=1(**保留记录**, 保护收藏与历史)
 *   6. 库有 gone=1 + 磁盘又出现           -> 清 gone, 按规则 2 处理
 *
 * **2026-10-02 语义变更(用户拍板): meta 图也要反推**。此前规则 3 只吃图内提示词、
 * 从不发给模型; 现在 meta 图同样入队, 反推结果**合并**进已有标签
 * (meta 部分永不丢, tags_src 变成 'meta+wd14', 见 tagger.js applyTags)。
 * 动机: 图内提示词是"作者写的原始串", WD14 给的才是规范化 danbooru 标签 ——
 * 角色高亮/标签搜索都以后者为准, 只吃 meta 会让带元数据的图永远缺角色标签。
 * 代价可控: 只有新图/图变了才重读重推(规则 1 照旧跳过), 存量 meta 图由
 * backfillMetaQueue 一次性补队。
 *
 * 首轮多一条「回填」: 从 txt 迁移过来的 legacy 行 mtime_ms/size **全是 NULL**
 * (迁移只搬数据, 不 stat 磁盘), 于是规则 1 在首轮永远不成立。所以第一次跑会
 * **只回填指纹、不读图** —— 实测 81648 张里 81646 走这条, 零读图零反推。
 * 这条回填是必须的, 否则"跳过"永远算不出来, 每次启动都要重读全部图片。
 *
 * 三个落点(职责不重叠):
 *   · images    —— **全部入册的图**(看板/搜索/系列的数据源; 含 v3 起的空标签占位行)
 *   · tag_queue —— **待反推的图**(裸图 + 待覆盖的 meta 图), 持久化在 DB, 进程重启不丢
 *   · folders   —— 登记表, 只有 as_source=1 的目录参与本流程
 *
 * as_scan=1 / as_source=0 的目录(如「只看新生成的 AI 图」那个)在这里**直接跳过** ——
 * 扫描页自己有增量缓存, 它不该被追平进标签库。
 */
import fs from 'node:fs'
import { openDb, normalizeImagePath, rebuildTags } from './store.js'
import { sortTagString } from './tagcats.js'
import { listImages, statAll, parseInWorker, sizeInWorker } from './scan.js'
import { flog } from './filelog.js'

/** 单轮同步的运行状态(IPC 与启动日志都读它) */
export const ingestState = {
  phase: 'idle',        // idle | running | done | error | skipped
  note: '',
  folder: '',           // 当前处理的目录
  folderIndex: 0,
  folderTotal: 0,
  done: 0,              // 当前阶段的进度
  total: 0,
  stats: null,          // 上一轮的统计(见 emptyStats)
  lastRunAt: 0,
  lastRunMs: 0,
  error: '',
  paused: false,
  running: false,
}

/** 每轮最多补多少张图片尺寸。
 *  全库八万张一次补完, 会让「同步」这一步从几秒变成一分钟往上, 用户会以为卡死。
 *  分批做: 进度条能走完、补过的行立刻生效、中途关掉也不丢已补的部分。
 *  3 万这个量级每轮多花十几秒 —— 只读 64KB 文件头, 不解码像素。 */
const DIM_FILL_MAX = 30000

function emptyStats() {
  return {
    folders: 0,        // 参与同步的目录数
    diskFiles: 0,      // 磁盘上枚举到的图(已去重)
    skipped: 0,        // 规则 1 + 首轮指纹回填: 一行未改
    statBackfilled: 0, // 只回填 mtime/size, 没读图(首轮为主)
    inserted: 0,       // 规则 3: 新入库(带元数据)
    metaUpdated: 0,    // 规则 2: 重读元数据后覆盖
    queued: 0,         // 规则 4: 裸图入队(含重新入队)
    goneSet: 0,        // 规则 5: 标记消失
    goneCleared: 0,    // 规则 6: 磁盘又出现, 清 gone
    readImages: 0,     // **真正读了图的张数** —— 反向验收的关键指标
    dimsBackfilled: 0, // 本轮补上的像素尺寸(只读文件头, 不算 readImages)
    dimsPending: 0,    // 还没补尺寸的行数(下轮同步接着补)
    ms: 0,
  }
}

/* ------------------------------------------------------------ tag_queue */

/**
 * 待反推队列。**建在这里而不是阶段 3** —— 阶段 2 就要往里写,
 * 表结构一带确定下来, 阶段 3 只加消费逻辑。
 *
 * 为什么持久化在 DB 而不是内存: 中断/退出后要能续跑, 而且「已入队」这个状态
 * 必须跨进程保留, 否则每次启动都会把同一批裸图重新读一遍再判一次。
 */
export function ensureQueueTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS tag_queue (
  path      TEXT PRIMARY KEY,
  folder_id INTEGER NOT NULL DEFAULT 0,
  src_id    INTEGER NOT NULL DEFAULT 0,
  size      INTEGER NOT NULL DEFAULT 0,
  mtime_ms  INTEGER NOT NULL DEFAULT 0,
  state     TEXT    NOT NULL DEFAULT 'pending',  -- pending | done | failed
  attempts  INTEGER NOT NULL DEFAULT 0,
  added_at  INTEGER NOT NULL DEFAULT 0,
  last_try  INTEGER NOT NULL DEFAULT 0,
  note      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_queue_state ON tag_queue(state, added_at);
`)
}

/**
 * 存量 meta 图一次性补队(2026-10-02 合并语义的配套迁移)。
 *
 * 改语义之前入库的 meta 图(实测 6575 张)从没进过队列 —— 得补一次, 否则只有
 * "今后新增/变更"的图才享受合并。用 meta 表(key='wd14_meta_backfill_v1')做
 * **一次性标记**: 补完就不再补。幂等性双保险:
 *   · 标记在 -> 直接跳过;
 *   · INSERT...SELECT ... ON CONFLICT(path) DO NOTHING -> 已在队列里的行不受扰
 *     (不会把 done/failed 重置成 pending, 也不重复计费)。
 * 门闸: TV_INGEST=0(测试/dev)直接跳过 —— 沙箱库的 folders 指向真实盘符,
 * 绝不能在测试里偷偷把真图塞进沙箱队列污染断言。
 *
 * @returns {{queued?:number, skipped?:boolean, reason?:string}}
 */
export function backfillMetaQueue(db = openDb()) {
  if (process.env.TV_INGEST === '0') return { skipped: true, reason: 'ingest-gate' }
  ensureQueueTable(db)
  const flag = db.prepare("SELECT value FROM meta WHERE key = 'wd14_meta_backfill_v1'").get()
  if (flag) return { skipped: true, reason: 'already-done' }
  const r = db.prepare(`
    INSERT INTO tag_queue (path, folder_id, src_id, size, mtime_ms, state, added_at)
    SELECT path, COALESCE(folder_id, 0), COALESCE(src_id, 0),
           COALESCE(size, 0), COALESCE(mtime_ms, 0), 'pending', ?
    FROM images WHERE gone = 0 AND tags_src = 'meta'
    ON CONFLICT(path) DO NOTHING
  `).run(Date.now())
  db.prepare("INSERT INTO meta (key, value) VALUES ('wd14_meta_backfill_v1', ?)").run(String(r.changes))
  flog('tagger', `存量 meta 补推: 入队 ${r.changes} 张`)
  return { queued: r.changes }
}

/**
 * 把**某个来源**里还没有标签的图补进 tag_queue(来源管理页「⚡ 反推」用)。
 *
 * 只挑「库里无标签」的行: 已经有标签的图不重复送进模型(白花推理时间)。
 * 已经在队列里的(含 done/failed)靠 ON CONFLICT DO NOTHING 跳过 —— 不把
 * failed 重置成 pending, 免得一张坏图被反复重试。
 *
 * @returns {{queued:number, reason?:string}}
 */
export function enqueueFolderUntagged(folderId, db = openDb()) {
  if (!folderId) return { queued: 0, reason: 'no-folder' }
  if (process.env.TV_INGEST === '0') return { queued: 0, reason: 'ingest-gate' }
  ensureQueueTable(db)
  const r = db.prepare(`
    INSERT INTO tag_queue (path, folder_id, src_id, size, mtime_ms, state, added_at)
    SELECT path, COALESCE(folder_id, 0), COALESCE(src_id, 0),
           COALESCE(size, 0), COALESCE(mtime_ms, 0), 'pending', ?
    FROM images
    WHERE gone = 0 AND folder_id = ?
      AND (tags IS NULL OR TRIM(tags) = '')
      AND NOT EXISTS (SELECT 1 FROM tag_queue q WHERE q.path = images.path)
  `).run(Date.now(), folderId)
  // 入队之后这个来源还剩多少待处理: 调用方靠它判断"这张来源到底有没有活干"
  const pending = Number(
    db.prepare("SELECT COUNT(*) AS n FROM tag_queue WHERE state='pending' AND folder_id = ?").get(folderId)?.n || 0,
  )
  flog('tagger', `按来源入队 folder=${folderId}: 新入 ${r.changes} 张, 待处理 ${pending} 张`)
  return { queued: r.changes, pending }
}

export function queueStats(db = openDb()) {
  try {
    ensureQueueTable(db)
    const g = (sql) => Number(db.prepare(sql).get()?.n || 0)
    return {
      pending: g("SELECT COUNT(*) AS n FROM tag_queue WHERE state='pending'"),
      failed: g("SELECT COUNT(*) AS n FROM tag_queue WHERE state='failed'"),
      done: g("SELECT COUNT(*) AS n FROM tag_queue WHERE state='done'"),
      total: g('SELECT COUNT(*) AS n FROM tag_queue'),
    }
  } catch (e) {
    return { pending: 0, failed: 0, done: 0, total: 0, error: e.message }
  }
}

/* ------------------------------------------------------------ 主流程 */

/** 某来源名对应的 src.id; 找不到返回 0(NOT NULL 列, 0 是安全哨兵) */
function srcIdFor(db, label) {
  if (!label) return 0
  const r = db.prepare('SELECT id FROM src WHERE name = ?').get(String(label))
  return r ? Number(r.id) : 0
}

function emit(onProgress, patch) {
  Object.assign(ingestState, patch)
  try { onProgress?.({ ...ingestState }) } catch { /* 进度回调出错不影响同步 */ }
}

/**
 * 跑一轮同步。**可重入保护**: 已在跑就返回 { skipped:true }。
 * @param {{onProgress?: (s:object)=>void, force?: boolean}} opts
 * @returns {Promise<object>} stats(失败时带 error)
 */
/**
 * @param {{onProgress?:Function, force?:boolean, dryRun?:boolean,
 *          only?: number|string}} opts
 *   `only` 限定只同步一个目录: 传 folders.id(推荐) 或 label 名。
 *   来源管理页的「单目录同步」用它 —— 否则点一个目录要把 8 个目录全扫一遍。
 */
export async function runIngest({ onProgress, force = false, dryRun = false, only = null } = {}) {
  if (ingestState.running) return { skipped: true, reason: 'busy' }
  ingestState.running = true
  ingestState.paused = false
  const t0 = Date.now()
  const stats = emptyStats()

  try {
    const db = openDb()
    ensureQueueTable(db)

    let folders = db.prepare('SELECT id, path, label, recursive FROM folders WHERE as_source = 1 ORDER BY id').all()
    if (only !== null && only !== undefined && only !== '') {
      const key = typeof only === 'number' ? Number(only) : String(only).toLowerCase()
      folders = folders.filter((f) => (typeof only === 'number'
        ? Number(f.id) === key
        : String(f.label).toLowerCase() === key || String(f.path).toLowerCase() === key))
      if (!folders.length) {
        const note = `没有匹配的看板来源: ${only}`
        emit(onProgress, { phase: 'done', note, stats, done: 0, total: 0 })
        ingestState.lastRunMs = Date.now() - t0
        ingestState.lastRunAt = Date.now()
        stats.note = note
        return stats
      }
    }
    stats.folders = folders.length
    if (!folders.length) {
      // 登记表里没有"看板来源" -> 没有可同步的东西。**不是错误**, 新装机器就是这状态。
      emit(onProgress, { phase: 'done', note: '登记表里没有 as_source=1 的目录, 跳过', stats, done: 0, total: 0 })
      ingestState.lastRunMs = Date.now() - t0
      ingestState.lastRunAt = Date.now()
      return stats
    }

    emit(onProgress, {
      phase: 'running', folderTotal: folders.length, folderIndex: 0,
      done: 0, total: 0, note: `开始同步 ${folders.length} 个登记目录`, stats,
    })

    for (let i = 0; i < folders.length; i++) {
      if (ingestState.paused) { emit(onProgress, { phase: 'skipped', note: '已被暂停' }); break }
      const f = folders[i]
      await syncOneFolder(db, f, stats, onProgress, i + 1, folders.length, dryRun)
    }

    if (!dryRun && (stats.inserted || stats.metaUpdated || stats.goneSet || stats.goneCleared)) {
      emit(onProgress, { phase: 'rebuild-tags', note: '重建标签字典 ...' })
      rebuildTags()
    }

    stats.ms = Date.now() - t0
    ingestState.stats = stats
    ingestState.lastRunMs = stats.ms
    ingestState.lastRunAt = Date.now()
    emit(onProgress, {
      phase: 'done',
      note: `${dryRun ? '[预演] ' : ''}完成: 新增 ${stats.inserted} · 更新 ${stats.metaUpdated} · 入队 ${stats.queued}`
        + ` · 标记消失 ${stats.goneSet} · 跳过 ${stats.skipped}(读图 ${stats.readImages} 张)`,
      stats, done: 1, total: 1,
    })
    flog('ingest', `完成 ${JSON.stringify(stats)}`)
    return stats
  } catch (e) {
    stats.ms = Date.now() - t0
    ingestState.error = e?.message || String(e)
    emit(onProgress, { phase: 'error', note: `同步失败: ${ingestState.error}`, stats })
    flog('ingest-err', `${e?.stack || e}`)
    return { ...stats, error: ingestState.error }
  } finally {
    ingestState.running = false
  }
}

/**
 * 同步一个登记目录。事务按目录切分(而不是整轮一个长事务):
 * 大目录的 stat 回填动辄上万行, 一个事务跨分钟会长时间拿写锁, App 侧查询会被拖。
 */
async function syncOneFolder(db, f, stats, onProgress, index, total, dryRun = false) {
  emit(onProgress, {
    phase: 'enum', folder: f.label || f.path, folderIndex: index, folderTotal: total,
    done: 0, total: 0, note: `枚举 ${f.label || f.path}`,
  })

  if (!fs.existsSync(f.path)) {
    emit(onProgress, { phase: 'enum', note: `⚠ 目录不存在, 跳过: ${f.path}` })
    flog('ingest', `目录不存在, 跳过: ${f.path}`)
    return
  }

  // ---- 1. 全量枚举 + 并发 stat(复用扫描页那套, 8 路并发) ----
  const files = await listImages(f.path, f.recursive !== 0)
  const statMap = await statAll(files)
  const disk = new Map()          // 规范化路径 -> { m, s }
  for (const fp of files) {
    const st = statMap.get(fp)
    if (!st) continue             // 刚被删/读不到: 当作不在磁盘上
    disk.set(normalizeImagePath(fp), { m: Math.round(st.m), s: st.s })
  }
  stats.diskFiles += disk.size

  emit(onProgress, { phase: 'compare', done: 0, total: disk.size, note: `比对 ${disk.size} 张` })

  // ---- 2. 读库内现状(按 folder_id, 迁移已保证无孤立行) ----
  const rows = db.prepare(
    'SELECT id, path, tags, mtime_ms, size, tags_src, gone, px_w FROM images WHERE folder_id = ?',
  ).all(f.id)
  const dbByPath = new Map(rows.map((r) => [r.path, r]))
  const queued = new Map(
    db.prepare('SELECT path, size, mtime_ms, state FROM tag_queue WHERE folder_id = ?')
      .all(f.id).map((r) => [r.path, r]),
  )

  // ---- 3. 分流 ----
  const statUpd = []      // [m, s, id] —— 首轮回填指纹, 不读图
  const goneUpd = []      // id —— 磁盘已不见
  const goneClr = []      // id —— 磁盘又出现
  const toRead = []       // { path, kind:'new'|'changed', id?, m, s }
  const dimFill = []      // [id, path] —— 「规则 1 真跳过」但还没尺寸的行(懒回填)
  let skipped = 0

  for (const [npath, d] of disk) {
    const r = dbByPath.get(npath)
    if (!r) {
      // 库里没有 -> 规则 3/4。**只要队列里有一条同指纹的记录就跳过**, 不重读。
      //
      // 条件刻意**不要求 state='pending'** (2026-09-20 收紧): 阶段 3 的反推会把
      // 跑通但没出标签的图标成 `done`(留 pending 会永远循环)。若这里只认 pending,
      // 那一行下轮就会被重新读图、重新入队、重新反推 —— 每轮白烧一张。
      // 认指纹而不是认状态, 语义也更准: "这张图我已经判过了, 而且它没变过"。
      // 图变了(mtime/size 不同)自然落到下面的 toRead, 会重新走一遍完整判定。
      const q = queued.get(npath)
      if (q && Number(q.mtime_ms) === d.m && Number(q.size) === d.s) {
        skipped++
        continue
      }
      toRead.push({ path: npath, kind: 'new', m: d.m, s: d.s })
      continue
    }
    const hadGone = Number(r.gone) === 1
    const hasFp = r.mtime_ms !== null && r.size !== null
    if (!hadGone && hasFp && Number(r.mtime_ms) === d.m && Number(r.size) === d.s) {
      skipped++                     // 规则 1: 真跳过, 一次图都不读
      // 唯一例外: 还没有尺寸。卡片要按真实比例渲染、系列封面要优先挑竖图,
      // 都得靠它 —— 只读文件头(不解码), 所以不记进 readImages 那个指标。
      // px_w 为 NULL = "从没试过"; 补过但读不到的会写成 0, 不再反复重试。
      if (r.px_w === null) {
        stats.dimsPending++
        if (dimFill.length < DIM_FILL_MAX) dimFill.push([r.id, npath])
      }
      continue
    }
    if (!hadGone && !hasFp) {
      statUpd.push([d.m, d.s, r.id])  // 首轮: 只补指纹
      if (r.px_w === null) {
        stats.dimsPending++
        if (dimFill.length < DIM_FILL_MAX) dimFill.push([r.id, npath])
      }
      stats.statBackfilled++
      skipped++
      continue
    }
    if (hadGone) goneClr.push(r.id)   // 规则 6: 先清 gone, 再按规则 2 走
    toRead.push({ path: npath, kind: 'changed', id: r.id, m: d.m, s: d.s })
  }

  for (const r of rows) {
    if (disk.has(r.path)) continue
    if (Number(r.gone) === 1) continue   // 已经是 gone, 不重复标
    goneUpd.push(r.id)                   // 规则 5
  }

  stats.skipped += skipped
  stats.goneSet += goneUpd.length
  stats.goneCleared += goneClr.length

  // ---- 4. 只对需要判定的图读元数据(worker 线程, 不占主进程事件循环) ----
  const parsed = new Map()
  if (toRead.length) {
    const paths = toRead.map((x) => x.path)
    stats.readImages += paths.length
    emit(onProgress, { phase: 'read', done: 0, total: paths.length, note: `读取元数据 ${paths.length} 张` })
    // 注意: 这里拿到的是**磁盘路径**, 与库里存的是同一个规范化写法,
    // 所以能直接拿它当 key 回填(下文用 parsed.get(item.path))。
    const res = await parseInWorker(paths, (p) => {
      if (p?.type === 'progress') emit(onProgress, { phase: 'read', done: p.done, total: p.total })
    })
    for (let i = 0; i < paths.length; i++) parsed.set(paths[i], res[i] || { tags: [], source: '' })
  }

  // ---- 4.5 懒回填像素尺寸(只读文件头, 与上面"读元数据"是两回事) ----
  // 为什么放在这里而不是塞进上面那次 worker: 上面只处理「新图 / 图变了」,
  // 而缺尺寸的是**已经跳过好几轮的老行**(规则 1 的"一次图都不读"恰恰是它们)。
  // 单独一批走 kind='size' 的 worker, 不解码像素, 也不进 readImages 指标。
  const dimRows = []      // [px_w, px_h, id]
  if (!dryRun && dimFill.length) {
    emit(onProgress, { phase: 'dims', done: 0, total: dimFill.length, note: `补图片尺寸 ${dimFill.length} 张` })
    const res = await sizeInWorker(dimFill.map((x) => x[1]), (p) => {
      if (p?.type === 'progress') emit(onProgress, { phase: 'dims', done: p.done, total: p.total })
    })
    for (let i = 0; i < dimFill.length; i++) {
      const s = res[i]
      // 拿不到就写 0(="试过了, 没有"), 而不是继续留 NULL —— 留 NULL 会让它
      // 每轮同步都被重新收进待补列表, 卡在那里永远出不来。
      dimRows.push([s ? Number(s.w) : 0, s ? Number(s.h) : 0, dimFill[i][0]])
    }
    stats.dimsBackfilled += dimRows.length
  }

  // ---- 5. 先算出落库计划(预演模式下就到此为止) ----
  const srcId = srcIdFor(db, f.label)
  const now = Date.now()
  const plan = { inserts: [], bareInserts: [], metaUpdates: [], fpUpdates: [], queue: [] }
  for (const item of toRead) {
    const p = parsed.get(item.path) || { tags: [], source: '' }
    const dim = p.dim || null          // worker 顺手读到的像素尺寸, 可能为 null
    const hasMeta = Array.isArray(p.tags) && p.tags.length > 0
    if (hasMeta) {
      /* 入库前按段位重排(2026-10-16): 顺序即存储顺序, 展示/导出直接按它走。
       * 分类器不可用时原样返回, 不挡入库。 */
      const tags = sortTagString(p.tags.join(','))
      if (item.kind === 'new') plan.inserts.push({ path: item.path, tags, m: item.m, s: item.s, dim })
      else plan.metaUpdates.push({ id: item.id, path: item.path, tags, m: item.m, s: item.s, dim })
    } else if (item.kind === 'changed') {
      // 裸图: 不动已有标签(legacy 值可能是世上唯一一份), 只更新指纹
      plan.fpUpdates.push({ id: item.id, m: item.m, s: item.s, dim })
    } else {
      // 2026-10-18 WD14 按需安装(v3): 全新裸图也落一行占位(tags='', tags_src='')
      // —— 否则没装反推的全新库 images 表是空的, 看板永远进不去(遮罩从后门把
      // 用户逼回强制下载)。占位行让看板立刻有图可显示(无胶囊), 等反推打上
      // 标签内容自然丰富; "已反推"计数(tagged_at IS NOT NULL)不受影响。
      plan.bareInserts.push({ path: item.path, m: item.m, s: item.s, dim })
    }
    // **无条件入队**: 裸图等反推打标; meta 图等 WD14 用反推结果覆盖(2026-10-18
    // v3 覆盖语义, applyTags 保证 tags_src 归一 'wd14')。文件没变的图走规则 1
    // 跳过, 不会反复入队 —— 只有新图/图变了才到这里。
    plan.queue.push({ path: item.path, m: item.m, s: item.s })
  }
  const ins = plan.inserts.length
  const bareIns = plan.bareInserts.length
  const metaUpd = plan.metaUpdates.length
  const qn = plan.queue.length

  // ---- 6. 一个目录一个事务落库 ----
  if (!dryRun) {
    db.exec('BEGIN')
    try {
      const stStmt = db.prepare('UPDATE images SET mtime_ms = ?, size = ? WHERE id = ?')
      for (const [m, s, id] of statUpd) stStmt.run(m, s, id)

      const goneStmt = db.prepare('UPDATE images SET gone = 1 WHERE id = ?')
      for (const id of goneUpd) goneStmt.run(id)

      const insStmt = db.prepare(`
        INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone, tagged_at, px_w, px_h)
        VALUES (?, ?, ?, ?, ?, ?, 'meta', 0, ?, ?, ?)
      `)
      // 尺寸拿不到就写 0(=未知): 卡片回落到 9/16 默认比例, 但不会被当成
      // "还没补过"每轮重读一遍。
      for (const x of plan.inserts) {
        insStmt.run(x.path, srcId, x.tags, f.id, x.m, x.s, now, x.dim?.w || 0, x.dim?.h || 0)
      }

      // 全新裸图占位行(2026-10-18 v3): tags 空、tags_src 空、tagged_at NULL
      // ("已反推"口数按 tagged_at IS NOT NULL 算, 占位行不会混进去)
      const bareStmt = db.prepare(`
        INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone, tagged_at, px_w, px_h)
        VALUES (?, ?, '', ?, ?, ?, '', 0, NULL, ?, ?)
      `)
      for (const x of plan.bareInserts) {
        bareStmt.run(x.path, srcId, f.id, x.m, x.s, x.dim?.w || 0, x.dim?.h || 0)
      }

      // 重读到了元数据 -> 覆盖(图内原生提示词永远优先)。
      const metaStmt = db.prepare(`
        UPDATE images SET tags = ?, tags_src = 'meta', mtime_ms = ?, size = ?, gone = 0,
                          tagged_at = ?, px_w = ?, px_h = ?
        WHERE id = ?
      `)
      for (const x of plan.metaUpdates) {
        metaStmt.run(x.tags, x.m, x.s, now, x.dim?.w || 0, x.dim?.h || 0, x.id)
      }

      // 重读**没**读到元数据 -> 只更新指纹 + 确认它还在磁盘上
      const fpStmt = db.prepare(
        'UPDATE images SET mtime_ms = ?, size = ?, gone = 0, px_w = ?, px_h = ? WHERE id = ?',
      )
      for (const x of plan.fpUpdates) fpStmt.run(x.m, x.s, x.dim?.w || 0, x.dim?.h || 0, x.id)

      // 规则 1 跳过的老行: 只补尺寸, 别的字段一个字都不动
      const dimStmt = db.prepare('UPDATE images SET px_w = ?, px_h = ? WHERE id = ?')
      for (const [w, h, id] of dimRows) dimStmt.run(w, h, id)

      // (2026-10-02 起 meta 图也入队, 不再有"有元数据就从队列里划掉"这回事 ——
      //  之前这行 qDel 是防"图被换成带元数据的版本后队列残留旧裸图记录",
      //  现在队列本来就要收它, 交给下面 queue.push 的 UPSERT 重置成 pending。)

      // 入队 = 把「已登记待反推」这个事实持久化, 避免下次启动再读一遍图
      const qStmt = db.prepare(`
        INSERT INTO tag_queue (path, folder_id, src_id, size, mtime_ms, state, added_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(path) DO UPDATE SET
          size     = excluded.size,
          mtime_ms = excluded.mtime_ms,
          state    = 'pending',
          note     = ''
      `)
      for (const x of plan.queue) qStmt.run(x.path, f.id, srcId, x.s, x.m, now)

      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
      throw e
    }
  }

  stats.inserted += ins + bareIns
  stats.metaUpdated += metaUpd
  stats.queued += qn
  emit(onProgress, {
    phase: 'folder-done', folderIndex: index, folderTotal: total,
    note: `${f.label || f.path}: 新增 ${ins + bareIns} · 更新 ${metaUpd} · 入队 ${qn} · 消失 ${goneUpd.length}`
      + (dimRows.length ? ` · 补尺寸 ${dimRows.length}` : ''),
  })
}

/* ------------------------------------------------------------ 对外控制 */

export function ingestStatus() {
  let queue = { pending: 0, failed: 0, done: 0, total: 0 }
  try { queue = queueStats() } catch { /* 库还没建好 */ }
  return { ...ingestState, queue }
}

export function pauseIngest() {
  if (!ingestState.running) return { ok: false, error: '当前没有在跑的同步' }
  ingestState.paused = true
  return { ok: true }
}
