/**
 * 扫描外部文件夹里的 AI 生成图, 读取元数据提示词
 * ==============================================
 * 移植自 Python 版 _api_scan_folder。几处刻意的改进:
 *
 *  1. **并发读元数据**。8 路并发(读文件是 IO, 并发不占 CPU)。
 *  2. **文件枚举也并发**。fs.promises.readdir 带 withFileTypes, 比 os.walk 少一层 stat。
 *  3. **持久增量缓存**(2026-09-18): dataDir/scan_cache.json 里给每个文件夹存
 *     `{ 规范化文件路径: { mtime, size, tags, source } }`。
 *     扫描 = 全量枚举 + 并发 stat, 与缓存逐条比对 ——
 *     没变的文件直接复用上次解析好的 tags(不读 PNG 头),
 *     只有新增/改动过的文件才真正解析, 已删除的自动剔除。
 *     几千张的文件夹「重开 / 重扫 / 重新添加」从几十秒降到几秒。
 *     force=true 只跳过内存 TTL 缓存(仍走增量); rebuild=true 才是彻底重读。
 *  4. **上限放开**(2026-09-18): 默认 limit 3000 -> 50000(硬上限 200000)。
 *     枚举永远全量, limit 只在返回时截断 —— 所以缓存键里不再掺 limit,
 *     shared_tags / distinct_prompts 也按全量统计, 不再被截断带偏。
 *
 * shared_tags / key_tags 的意义(原注释保留):
 *   整批共用的标签(出现在 ≥2/3 含提示词的图里)通常是工作流固定的基础提示词,
 *   对区分图片毫无信息量。卡片若按顺序取前 N 个, 会让人误以为「每张图标签都一样」。
 *   所以卡片的展示顺序是: 角色标签在最前(最有辨识度), 其后是这张图独有的内容标签。
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseInWorker, sizeInWorker } from './imgWorker.js'
import { extractImagePrompt, SCAN_IMG_EXTS } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'
import { isCharacterTag, seriesName } from './dataset.js'
import { dataFile } from './workspace.js'
import { dimsForPaths } from './dims.js'

const CONCURRENCY = 8
/** 新增/变化文件超过这个数就走 worker 线程解析(小批次原地跑, 起线程的固定开销不值得) */
const WORKER_THRESHOLD = 64

/**
 * 内存缓存 —— TTL 内的重复打开直接回, 连 stat 对账都省了。
 * 只缓存中等规模的结果(超过 CACHE_MAX_ITEMS 就放过, 免得常驻几十 MB)。
 */
const SCAN_CACHE = new Map()          // key -> { at, result }
const CACHE_TTL = 5 * 60 * 1000
const CACHE_MAX_ITEMS = 30000

/**
 * 缓存键里的路径必须**规范化** —— 同一个目录可能被写成 path-check-ignore
 * `X:/a/b`、`X:\a\b`、`X:\a\b\` 三种样子(X 代表盘符), 不归一化就会各存一份,
 * 缓存形同虚设。
 */
function normKeyPath(p) {
  let s = String(p ?? '').trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '')
  try { s = path.resolve(s) } catch { /* 非法路径就按原文用 */ }
  return s.toLowerCase()
}

/** 单个文件的规范化键(持久缓存的 entries 索引, Windows 大小写不敏感) */
function normFilePath(p) {
  try { return path.resolve(String(p)).toLowerCase() } catch { return String(p).toLowerCase() }
}

/** 丢掉某个目录(含其子目录写法)的所有内存缓存条目 */
export function invalidateScanCache(folder) {
  if (!folder) { SCAN_CACHE.clear(); return 0 }
  const p = normKeyPath(folder)
  let n = 0
  for (const k of [...SCAN_CACHE.keys()]) {
    if (k.startsWith(p + '|')) { SCAN_CACHE.delete(k); n++ }
  }
  return n
}

export function scanCacheStats() {
  return {
    entries: SCAN_CACHE.size,
    keys: [...SCAN_CACHE.keys()],
    persistFolders: PERSIST ? Object.keys(PERSIST.folders).length : 0,
  }
}

/* ---------------------------------------------------------------- 持久增量缓存 */

const PERSIST_NAME = 'scan_cache.json'
const PERSIST_VERSION = 1
const PERSIST_MAX_ENTRIES = 250000    // 超过就不落盘(防膨胀), 内存里照常工作
let PERSIST = null                    // { version, folders: { key: { at, entries } } }
let PERSIST_DIRTY = false
let PERSIST_TIMER = null

function loadPersist() {
  if (PERSIST) return PERSIST
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(PERSIST_NAME), 'utf8'))
    PERSIST = (d && d.version === PERSIST_VERSION && d.folders && typeof d.folders === 'object')
      ? { version: PERSIST_VERSION, folders: d.folders }
      : { version: PERSIST_VERSION, folders: {} }
  } catch {
    PERSIST = { version: PERSIST_VERSION, folders: {} }
  }
  return PERSIST
}

function schedulePersistSave() {
  PERSIST_DIRTY = true
  clearTimeout(PERSIST_TIMER)
  PERSIST_TIMER = setTimeout(persistSaveNow, 2000)   // 防抖: 连扫多个文件夹只写一次盘
}

function persistSaveNow() {
  clearTimeout(PERSIST_TIMER)
  PERSIST_TIMER = null
  if (!PERSIST_DIRTY || !PERSIST) return
  PERSIST_DIRTY = false
  let total = 0
  for (const f of Object.values(PERSIST.folders)) total += Object.keys(f.entries || {}).length
  if (total > PERSIST_MAX_ENTRIES) {
    console.warn(`[scan] 持久缓存条目过多(${total}), 本次跳过落盘`)
    return
  }
  const p = dataFile(PERSIST_NAME)
  const tmp = `${p}.tmp`
  fs.promises.writeFile(tmp, JSON.stringify(PERSIST), 'utf8')
    .then(() => fs.promises.rename(tmp, p))
    .catch((e) => console.warn('[scan] 持久缓存写盘失败:', e?.message || e))
}

/**
 * 把已删除的图片从缓存里作废(image:trash 成功后调用)。
 * 持久缓存逐条剔除; 内存缓存整个清空 —— 下次点开按增量对账, 秒级, 不亏。
 */
export function purgeScanCachePaths(paths) {
  const set = new Set((paths || []).filter(Boolean).map(normFilePath))
  if (!set.size) return 0
  let n = 0
  const P = loadPersist()
  for (const f of Object.values(P.folders)) {
    const entries = f.entries || {}
    for (const k of Object.keys(entries)) {
      if (set.has(k)) { delete entries[k]; n++ }
    }
  }
  if (n) schedulePersistSave()
  SCAN_CACHE.clear()
  return n
}

/* ---------------------------------------------------------------- 枚举 / stat */

export async function listImages(folder, recursive) {
  const files = []
  if (recursive) {
    const stack = [folder]
    while (stack.length) {
      const dir = stack.pop()
      let ents
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        if (e.isDirectory()) {
          if (!e.name.startsWith('.')) stack.push(path.join(dir, e.name))
        } else if (e.isFile()) {
          if (SCAN_IMG_EXTS.has(path.extname(e.name).toLowerCase())) {
            files.push(path.join(dir, e.name))
          }
        }
      }
    }
  } else {
    let ents = []
    try { ents = await fs.promises.readdir(folder, { withFileTypes: true }) } catch { return files }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      if (!e.isFile()) continue
      if (!SCAN_IMG_EXTS.has(path.extname(e.name).toLowerCase())) continue
      files.push(path.join(folder, e.name))
    }
  }
  return files
}

/** 并发 stat 全部文件 —— 增量对账的依据; stat 失败的(刚被删)不进结果 */
export async function statAll(files) {
  const map = new Map()      // fp -> { m: mtimeMs, s: size }
  let cursor = 0
  const workers = new Array(Math.min(CONCURRENCY, files.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = cursor++
      if (i >= files.length) return
      const fp = files[i]
      try {
        const st = await fs.promises.stat(fp)
        map.set(fp, { m: st.mtimeMs, s: st.size })
      } catch { /* 刚被删/读不到: 跳过 */ }
    }
  })
  await Promise.all(workers)
  return map
}

/* ---------------------------------------------------------------- worker 解析 */

/* parseInWorker / sizeInWorker 挪到了 imgWorker.js (2026-09-23) —— dims.js 也要用它,
   留在这里会形成 scan -> dims -> scan 的循环引用。这里原样再导出, 于是
   ingest.js 的 `import { parseInWorker, sizeInWorker } from './scan.js'` 一行都不用改。 */
export { parseInWorker, sizeInWorker } from './imgWorker.js'

/* ---------------------------------------------------------------- 主流程 */
/**
 * @param {object} raw  {path, recursive, limit, force, rebuild}
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 *   解析阶段进度回调(仅当走 worker 时触发); ipc 层用它把进度推给渲染端。
 */
export async function scanFolder(raw = {}, onProgress = null) {
  const folder = String(raw.path || '').trim().replace(/^"|"$/g, '')
  const recursive = raw.recursive !== '0' && raw.recursive !== false
  const limit = Math.min(Math.max(parseInt(raw.limit, 10) || 50000, 1), 200000)
  const rebuild = !!raw.rebuild

  let st
  try { st = await fs.promises.stat(folder) } catch { st = null }
  if (!st || !st.isDirectory()) return { error: 'folder not found', folder }

  const key = `${normKeyPath(folder)}|${recursive ? 1 : 0}`

  // 内存缓存: TTL 内直接回
  if (!raw.force && !raw.noCache && !rebuild) {
    const hit = SCAN_CACHE.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.result, cached: true }
  }

  const files = await listImages(folder, recursive)
  const statMap = await statAll(files)

  // ---- 增量对账: mtime+size 都没变的文件直接复用上次解析结果 ----
  const P = loadPersist()
  const bucket = P.folders[key] || (P.folders[key] = { at: 0, entries: {} })
  const entries = bucket.entries
  const keep = new Set()          // 本次枚举到的文件键(用于剔除已删除的)
  const reuse = new Map()         // fp -> { tags, source }(命中缓存)
  const fresh = []                // 需要(重新)解析的文件
  for (const fp of files) {
    const s = statMap.get(fp)
    if (!s) continue
    const k = normFilePath(fp)
    keep.add(k)
    const c = entries[k]
    if (!rebuild && c && c.m === s.m && c.s === s.s && Array.isArray(c.t)) {
      reuse.set(fp, { tags: c.t, source: c.src || '' })
    } else {
      fresh.push(fp)
    }
  }

  // ---- 只解析新增/变化的文件 ----
  const parsed = new Map()        // fp -> { tags, source }
  if (fresh.length >= WORKER_THRESHOLD && typeof onProgress === 'function') {
    // 大批次: worker 线程解析, 主进程事件循环不被占死 + 进度实时上报
    const results = await parseInWorker(fresh, onProgress)
    for (let i = 0; i < fresh.length; i++) parsed.set(fresh[i], results[i] || { tags: [], source: '' })
  } else {
    // 小批次(或没传进度回调): 原地解析 —— 原有 8 路并发写法, 读文件为主, 够用
    let cursor = 0
    const workers = new Array(Math.min(CONCURRENCY, fresh.length || 1)).fill(0).map(async () => {
      while (true) {
        const i = cursor++
        if (i >= fresh.length) return
        const fp = fresh[i]
        let tags = []
        let src = ''
        try {
          const r = extractImagePrompt(fp)
          src = r.source
          tags = r.text ? dedupeTags(promptToTags(r.text)) : []
        } catch { /* 单张读失败不影响整批 */ }
        parsed.set(fp, { tags, source: src })
      }
    })
    await Promise.all(workers)
  }

  // ---- 写回持久缓存(剔除已删除的文件) ----
  let changed = rebuild
  for (const fp of files) {
    const s = statMap.get(fp)
    if (!s) continue
    const r = parsed.get(fp)
    if (!r) continue
    const k = normFilePath(fp)
    const c = entries[k]
    if (!c || c.m !== s.m || c.s !== s.s || c.t !== r.tags) {
      entries[k] = { m: s.m, s: s.s, t: r.tags, src: r.source }
      changed = true
    }
  }
  for (const k of Object.keys(entries)) {
    if (!keep.has(k)) { delete entries[k]; changed = true }
  }
  bucket.at = Date.now()
  if (changed) schedulePersistSave()

  // ---- 组装 items(枚举顺序) ----
  const items = []
  let withPrompt = 0
  for (const fp of files) {
    const st = statMap.get(fp)
    if (!st) continue
    const r = reuse.get(fp) || parsed.get(fp)
    if (!r) continue
    if (r.tags.length) withPrompt++
    items.push({
      path: fp,
      name: path.basename(fp),
      tags: r.tags,
      source: r.source,
      folder: path.basename(path.dirname(fp)),
      /* 排序要用(2026-09-23): 扫描页的排序全在前端做, 而前端只有 name/folder 可排,
         想按时间或大小排就必须把 stat 里的这两项带过去。`statMap` 本来就为每个文件
         存了 m/s(见上面的 statSync), 所以这是纯白捡的, 不用额外读盘。 */
      mtime: st.m,
      size: st.s,
    })
  }

  // 整批共用标签(出现在 ≥2/3 含提示词的图里) —— 基于全量统计, 不受 limit 截断影响
  const nTagged = items.reduce((a, it) => a + (it.tags.length ? 1 : 0), 0)
  const sharedSet = new Set()
  const sharedTags = []
  if (nTagged >= 2) {
    const cnt = new Map()
    for (const it of items) {
      for (const t of it.tags) cnt.set(t, (cnt.get(t) || 0) + 1)
    }
    const thr = Math.max(2, Math.round(nTagged * 2 / 3))
    for (const [t, c] of cnt) if (c >= thr) sharedSet.add(t)
    for (const it of items) {
      for (const t of it.tags) {
        if (sharedSet.has(t) && !sharedTags.includes(t)) sharedTags.push(t)
      }
    }
  }

  for (const it of items) {
    const chars = it.tags.filter(isCharacterTag)
    it.chars = chars
    it.series = [...new Set(chars.map(seriesName).filter(Boolean))]
    it.shared = it.tags.filter((t) => sharedSet.has(t))
    it.key_tags = [...chars, ...it.tags.filter((t) => !sharedSet.has(t) && !chars.includes(t))]
  }

  // 整批到底有几种不同提示词 —— 很多目录是「同一提示词 + 换种子」刷出来的,
  // 那种情况下所有标签必然一致, 得让用户一眼分辨「读取失败」还是「本来就这样」
  const groups = new Map()
  for (const it of items) {
    if (!it.tags.length) continue
    const k = it.tags.join('\u0001')
    groups.set(k, (groups.get(k) || 0) + 1)
  }

  const truncated = items.length > limit
  const out = {
    folder,
    total: items.length,          // 全量文件数(未截断的)
    truncated,
    with_prompt: withPrompt,
    items: truncated ? items.slice(0, limit) : items,
    shared_tags: sharedTags,
    distinct_prompts: groups.size,
    recursive,
    limit,
    scanned_at: Date.now(),
  }

  /* ---- 像素尺寸: 网格按真实比例排版的**必须项**(2026-09-23 下午补) ----
   *
   * 漏了它就是这个 bug: **横图显示为竖图**。前端拿不到 px_w/px_h 会回落 9/16,
   * 于是每个格子都按竖图算宽, 横图被 `object-fit: cover` 裁成竖条 —— 而且
   * **一个错都不报**(尺寸是"有就用、没有就回落", 静默的)。上一版这里只带了
   * path/name/tags/source/folder/mtime/size, 正好把尺寸漏了。
   *
   * 尺寸从哪来（见 core/dims.js）: 先查内存数据集(库里已登记的图, 零 I/O),
   * 再批量读文件头。这里额外做两件事:
   *   · **已有的从持久缓存白捡** —— w/h 和 mtime/size 一起失效, 所以"同一个文件
   *     只读一次头", 重开/重扫目录不再读盘;
   *   · 读到的写回 entries + 标 changed, 让下一轮扫描变纯内存。
   *
   * 只对**将要返回的那批**做: 超过 limit 被截掉的图前端根本看不到, 不白读。
   * 实测口径（用户真库 8,599 张的目录）: 首扫读一遍, 之后重扫是 0 次读盘。
   */
  const needDims = []
  for (const it of out.items) {
    const c = entries[normFilePath(it.path)]
    if (c && c.w > 0 && c.h > 0) {
      it.px_w = c.w
      it.px_h = c.h
    } else {
      needDims.push(it)
    }
  }
  if (needDims.length) {
    const dims = await dimsForPaths(needDims.map((it) => it.path), {
      // 带 phase —— 前端据此把进度条文案从"正在扫描元数据"切成"正在读取图片尺寸",
      // 否则读尺寸那几秒会顶着"元数据"的字样, 看着像卡住了。
      onProgress: onProgress
        ? ({ done, total }) => onProgress({ done, total, phase: 'dims' })
        : undefined,
    })
    for (let i = 0; i < needDims.length; i++) {
      const d = dims[i]
      if (!d) continue                   // 读不到 -> 保持无尺寸, 前端回落 9/16
      const it = needDims[i]
      it.px_w = d.w
      it.px_h = d.h
      const c = entries[normFilePath(it.path)]
      if (c) { c.w = d.w; c.h = d.h; changed = true }
    }
  }

  if (changed) schedulePersistSave()
  if (items.length <= CACHE_MAX_ITEMS) SCAN_CACHE.set(key, { at: Date.now(), result: out })
  return out
}
