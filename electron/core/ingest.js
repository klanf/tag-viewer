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
 *   3. 库无 + 图内**有**元数据            -> 直接入库(tags_src='meta')
 *   4. 库无 + 图内**无**元数据            -> 入 tag_queue(等阶段 3 的反推管道消费)
 *   5. 库有 + 磁盘已不见                  -> gone=1(**保留记录**, 保护收藏与历史)
 *   6. 库有 gone=1 + 磁盘又出现           -> 清 gone, 按规则 2 处理
 *
 * 首轮多一条「回填」: 从 txt 迁移过来的 legacy 行 mtime_ms/size **全是 NULL**
 * (迁移只搬数据, 不 stat 磁盘), 于是规则 1 在首轮永远不成立。所以第一次跑会
 * **只回填指纹、不读图** —— 实测 81648 张里 81646 走这条, 零读图零反推。
 * 这条回填是必须的, 否则"跳过"永远算不出来, 每次启动都要重读全部图片。
 *
 * 三个落点(职责不重叠):
 *   · images    —— **有标签的图**(看板/搜索/系列的数据源)
 *   · tag_queue —— **待反推的裸图**, 持久化在 DB, 进程重启不丢
 *   · folders   —— 登记表, 只有 as_source=1 的目录参与本流程
 *
 * as_scan=1 / as_source=0 的目录(如「只看新生成的 AI 图」那个)在这里**直接跳过** ——
 * 扫描页自己有增量缓存, 它不该被追平进标签库。
 */
import fs from 'node:fs'
import { openDb, normalizeImagePath, rebuildTags } from './store.js'
import { listImages, statAll, parseInWorker } from './scan.js'
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
export async function runIngest({ onProgress, force = false, dryRun = false } = {}) {
  if (ingestState.running) return { skipped: true, reason: 'busy' }
  ingestState.running = true
  ingestState.paused = false
  const t0 = Date.now()
  const stats = emptyStats()

  try {
    const db = openDb()
    ensureQueueTable(db)

    const folders = db.prepare('SELECT id, path, label, recursive FROM folders WHERE as_source = 1 ORDER BY id').all()
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
    'SELECT id, path, tags, mtime_ms, size, tags_src, gone FROM images WHERE folder_id = ?',
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
      continue
    }
    if (!hadGone && !hasFp) {
      statUpd.push([d.m, d.s, r.id])  // 首轮: 只补指纹
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

  // ---- 5. 先算出落库计划(预演模式下就到此为止) ----
  const srcId = srcIdFor(db, f.label)
  const now = Date.now()
  const plan = { inserts: [], metaUpdates: [], fpUpdates: [], queue: [] }
  for (const item of toRead) {
    const p = parsed.get(item.path) || { tags: [], source: '' }
    const hasMeta = Array.isArray(p.tags) && p.tags.length > 0
    if (hasMeta) {
      const tags = p.tags.join(',')
      if (item.kind === 'new') plan.inserts.push({ path: item.path, tags, m: item.m, s: item.s })
      else plan.metaUpdates.push({ id: item.id, path: item.path, tags, m: item.m, s: item.s })
    } else {
      // 裸图: 不动已有标签(legacy 值可能是世上唯一一份), 只更新指纹 + 入队
      if (item.kind === 'changed') plan.fpUpdates.push({ id: item.id, m: item.m, s: item.s })
      plan.queue.push({ path: item.path, m: item.m, s: item.s })
    }
  }
  const ins = plan.inserts.length
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
        INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone, tagged_at)
        VALUES (?, ?, ?, ?, ?, ?, 'meta', 0, ?)
      `)
      for (const x of plan.inserts) insStmt.run(x.path, srcId, x.tags, f.id, x.m, x.s, now)

      // 重读到了元数据 -> 覆盖(图内原生提示词永远优先)。
      const metaStmt = db.prepare(`
        UPDATE images SET tags = ?, tags_src = 'meta', mtime_ms = ?, size = ?, gone = 0, tagged_at = ?
        WHERE id = ?
      `)
      for (const x of plan.metaUpdates) metaStmt.run(x.tags, x.m, x.s, now, x.id)

      // 重读**没**读到元数据 -> 只更新指纹 + 确认它还在磁盘上
      const fpStmt = db.prepare('UPDATE images SET mtime_ms = ?, size = ?, gone = 0 WHERE id = ?')
      for (const x of plan.fpUpdates) fpStmt.run(x.m, x.s, x.id)

      // 已有元数据 -> 不必再反推(可能之前入过队, 比如图被换成了带元数据的版本)
      const qDel = db.prepare('DELETE FROM tag_queue WHERE path = ?')
      for (const x of plan.inserts) qDel.run(x.path)
      for (const x of plan.metaUpdates) qDel.run(x.path)

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

  stats.inserted += ins
  stats.metaUpdated += metaUpd
  stats.queued += qn
  emit(onProgress, {
    phase: 'folder-done', folderIndex: index, folderTotal: total,
    note: `${f.label || f.path}: 新增 ${ins} · 更新 ${metaUpd} · 入队 ${qn} · 消失 ${goneUpd.length}`,
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
