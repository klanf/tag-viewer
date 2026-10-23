/**
 * tag 查重 (2026-10-17): 两阶段找出「可能的重复图片组」
 *
 * 阶段① 候选生成 —— 全库两两比对是 5.7e9 对, 不可行。只让 df<=rareMax 的
 *   「罕见 tag」在同一张图内两两配对计数(罕见=信息量大, 1girl 这类高频词
 *   不参与, 也避免了 C(50000,2) 爆炸)。共享 >=minSharedRare 个罕见 tag 的
 *   图片对进入候选。真库 107,230 图实测 ~1s。
 * 阶段② 精确打分 —— 候选对算 IDF 加权 Jaccard:
 *     score = Σw(共享) / (Σw(A)+Σw(B)-Σw(共享)),  w = log(1+N/df)
 *   段位微调: 人数段(1girl)权重 ×0.2(信息量太低); meta ×0.5;
 *   双方都有角色 tag 且完全不交集 → score ×0.5(不同角色基本不是重复)。
 * 阶段③ 并查集把连通的对合成组(A≈B,B≈C → {A,B,C})。
 *
 * 扫描口径与看板数据集一致(gone=0 + 来源未注销, 2026-10-17);
 * 误报对(dupignore)在达标后、合并前剔除。
 * 每张图附 unsafe 0/1/2(安全模式标记, 与数据集同一套词表) —— 查重面板
 * 按它接安全模式过滤, 不让露骨内容从面板漏出去(2026-10-17 用户补充)。
 * 纯内存一次算完, 不落库不建索引。局限(诚实): tag 缺失或两图 tag 集差异大
 * 会漏检; 同图不同尺寸/裁剪版可能漏 —— 感知哈希是二期补充。
 */
import { openDb } from './store.js'
import { loadCats, catOf } from './tagcats.js'
import fs from 'node:fs'
// 安全模式标记: 与数据集同一套词表/判定(safetyMatcher 带 mtime 缓存), 给每张图
// 附 unsafe 0/1/2, 前端拿它接安全模式过滤(查重面板不该成为露骨内容的漏网之鱼)。
import { safetyMatcher, unsafeLevelOf } from './safety.js'
/** 单例缓存段位判定(catOf 内部有 memo, 这里只省 split 开销) */
const segCache = new Map()
function segOf(name) {
  let s = segCache.get(name)
  if (s === undefined) {
    s = String(catOf(name) || 'other').split(':')[0]
    segCache.set(name, s)
  }
  return s
}

/**
 * 文件创建/修改时间 —— 「组内保留规则」选创建时间时要按真实时间排。
 * 只对最终返回的组成员 stat(组数有上限), 失败就用库里的 mtime 兜底。
 */
function annotateTimes(groups) {
  const cache = new Map()
  const timesOf = (p) => {
    let v = cache.get(p)
    if (!v) {
      v = { bt: 0, mt: 0 }
      try {
        const st = fs.statSync(p)
        v = { bt: Math.round(st.birthtimeMs) || 0, mt: Math.round(st.mtimeMs) || 0 }
      } catch { /* 文件可能已被移走, 用库里的 mtime */ }
      cache.set(p, v)
    }
    return v
  }
  for (const g of groups) {
    for (const it of g.items) {
      const t = timesOf(it.path)
      it.bt = t.bt || it.mtime_ms || 0
      it.mt = t.mt || it.mtime_ms || 0
    }
  }
}

export function findDuplicateGroups(opts = {}) {
  const {
    rareMax = 50,        // df<=此值的 tag 视为「罕见」, 参与候选配对
    minSharedRare = 3,   // 候选门槛: 共享罕见 tag 数
    threshold = 0.85,    // 加权 Jaccard 阈值
    maxGroups = 2000,    // 返回组数上限(防极端库卡 UI); 真库 0.85 下实测 542 组
    ignorePairs = null,  // Set<string> "小id|大id" —— 用户标记过的误报对, 命中即跳过
    blockedPairs = null, // 其中属于「永久忽略」的那部分, 只用于把计数分开报给界面
  } = opts

  const t0 = Date.now()
  const db = openDb()
  // 列探测: px_w/px_h/size 等是追加列, 全新空库可能还没有(老库由迁移补齐)
  const cols = new Set(db.prepare('PRAGMA table_info(images)').all().map((c) => c.name))
  const dimSel = ['px_w', 'px_h', 'size', 'mtime_ms', 'img_src'].filter((c) => cols.has(c))
  const hasGone = cols.has('gone')
  // 可见性与 readRecords(看板数据集)保持同一口径(2026-10-17 用户拍板「只扫看板可见图」):
  //   gone=0 且 (folder_id 为空 或 所在文件夹没把「看板来源」注销)。
  // 不加这层会出现两类怪象: 来源已注销的图(光箱查不到 tag, 显示"库外图片")和
  // 文件早已搬走但 gone 没机会被 ingest 标记的幽灵记录(缩略图 404, 0×0)。
  const offFolders = (() => {
    try {
      return db.prepare('SELECT id FROM folders WHERE as_source = 0').all().map((r) => Number(r.id))
    } catch { return [] }   // 全新空库可能还没有 folders 表 —— 没有可见性概念, 直接扫
  })()
  const vis = offFolders.length
    ? ` AND (i.folder_id IS NULL OR i.folder_id NOT IN (${offFolders.map(() => '?').join(',')}))`
    : ''
  // 注册来源文件夹(优先级排序的单位): 全新空库可能还没有 folders 表 —— 没有就给 NULL
  const hasFolders = (() => {
    try {
      return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folders'`).get()
    } catch { return false }
  })()
  const rows = db
    .prepare(
      `SELECT i.id, i.path, i.tags${dimSel.length ? ', i.' + dimSel.join(', i.') : ''}${hasFolders ? ', f.path AS folder' : ', NULL AS folder'}
       FROM images i${hasFolders ? ' LEFT JOIN folders f ON f.id = i.folder_id' : ''}
       WHERE ${hasGone ? 'i.gone = 0 AND ' : ''}i.tags <> ''${vis}`
    )
    .all(...offFolders)

  // ── pass 1: tag 内联成数字 id + df 统计(内存从 3.2M 字符串降到 13k×4B) ──
  const idOf = new Map()
  const names = []
  const df = []
  const sm = safetyMatcher()        // 安全模式词表(带 mtime 缓存), 全库共用一次
  const unsafeArr = []
  const lists = rows.map((r, k) => {
    const tagArr = r.tags.split(',')
    unsafeArr[k] = unsafeLevelOf(tagArr, sm)
    const ids = new Set()
    for (const t of tagArr) {
      if (!t) continue
      let i = idOf.get(t)
      if (i === undefined) {
        i = names.length
        idOf.set(t, i)
        names.push(t)
        df.push(0)
      }
      ids.add(i)
    }
    return [...ids]
  })
  const N = lists.length
  for (const ids of lists) for (const i of ids) df[i]++

  // 每张图的角色 tag 集合(惩罚判定用) + 加权总分(缓存)
  const wArr = names.map((name, i) => {
    let w = Math.log(1 + N / Math.max(df[i], 1))
    const seg = segOf(name)
    if (seg === 'count') w *= 0.2
    else if (seg === 'meta') w *= 0.5
    return w
  })
  const charIds = new Set()
  for (let i = 0; i < names.length; i++) if (segOf(names[i]) === 'char') charIds.add(i)

  const sumW = new Float64Array(N)
  const charList = new Array(N)
  for (let k = 0; k < N; k++) {
    let s = 0
    const chars = []
    for (const i of lists[k]) {
      s += wArr[i]
      if (charIds.has(i)) chars.push(i)
    }
    sumW[k] = s
    charList[k] = chars
  }

  // ── pass 2: 罕见 tag 倒排索引 → 图片对共现计数 ──
  // 对每个罕见 tag, 它的图片列表里两两 +1: 总开销 Σ C(df,2), df≤50 时
  // 顶格 ~7408×1225=9e6, 真库实测 ~50 万次 —— counter[u,v] = u,v 共享的罕见 tag 数
  const inv = new Map() // tagId -> [图片行号...]
  for (let k = 0; k < N; k++) {
    for (const i of lists[k]) {
      if (df[i] <= rareMax) {
        let arr = inv.get(i)
        if (!arr) inv.set(i, (arr = []))
        arr.push(k)
      }
    }
  }
  const MAXID = 0x40000000 // 图片行号 < 2^30, 数字键 u*2^30+v(小者在前)
  const counter = new Map()
  for (const arr of inv.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const u = Math.min(arr[a], arr[b]), v = Math.max(arr[a], arr[b])
        const key = u * MAXID + v
        counter.set(key, (counter.get(key) || 0) + 1)
      }
    }
  }

  // ── pass 3: 候选对精确打分 + 阈值过滤 + 并查集 ──
  const parent = new Int32Array(N).map((_, i) => i)
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  function union(a, b) {
    a = find(a); b = find(b)
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
  }

  // 上面 pass2 用了 u*2^30+v 的乘法键(小行号在前), 与解码保持同一编码
  let nCandidates = 0
  let nIgnored = 0
  let nBlocked = 0
  const groups = []
  const bestPairShared = new Map() // root -> { tags:[], score }

  for (const [key, cnt] of counter) {
    if (cnt < minSharedRare) continue
    nCandidates++
    const a = Math.floor(key / MAXID)
    const b = key % MAXID
    // 加权 Jaccard: 共享权和 / (两边权和 - 共享权和)
    let sharedW = 0
    const small = lists[a].length <= lists[b].length ? lists[a] : lists[b]
    const big = small === lists[a] ? lists[b] : lists[a]
    const bigSet = new Set(big)
    const sharedNames = []
    for (const i of small) {
      if (bigSet.has(i)) {
        sharedW += wArr[i]
        sharedNames.push(i)
      }
    }
    const denom = sumW[a] + sumW[b] - sharedW
    if (denom <= 0) continue
    let score = sharedW / denom
    // 双方都有角色 tag 且零交集 → 减半(不同角色基本不是重复)
    if (charList[a].length && charList[b].length) {
      const sa = new Set(charList[a])
      if (!charList[b].some((i) => sa.has(i))) score *= 0.5
    }
    if (score < threshold) continue
    // 误报忽略(2026-10-17): 用户标记过的图片对直接跳过 —— 用 images.id 做键
    // (id 在「移动=改址」/重启间稳定; 按行号做键重启后就会错位)。
    if (ignorePairs && ignorePairs.size) {
      const ia = Number(rows[a].id)
      const ib = Number(rows[b].id)
      const pk = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`
      if (ignorePairs.has(pk)) {
        if (blockedPairs && blockedPairs.has(pk)) nBlocked++
        else nIgnored++
        continue
      }
    }
    union(a, b)
    sharedNames.sort((x, y) => wArr[y] - wArr[x])
    const root = find(a)
    const rec = bestPairShared.get(root)
    if (!rec || score > rec.score) {
      bestPairShared.set(root, {
        score,
        tags: sharedNames.slice(0, 10).map((i) => names[i]),
      })
    }
  }

  // ── 组装: root → 成员 ──
  const byRoot = new Map()
  for (let k = 0; k < N; k++) {
    const r = find(k)
    if (!bestPairShared.has(r)) continue // 不在任何达标组里
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(k)
  }

  for (const [root, members] of byRoot) {
    const items = members
      .map((k) => ({
        id: rows[k].id,
        path: rows[k].path,
        tags: rows[k].tags || '',          // 组内图自己的标签(右键收藏要快照用)
        folder: rows[k].folder || '',      // 注册的来源文件夹(优先级排序以它为单位, 不按子目录)
        px_w: rows[k].px_w || 0,
        px_h: rows[k].px_h || 0,
        size: rows[k].size || 0,
        mtime_ms: Number(rows[k].mtime_ms) || 0,
        img_src: String(rows[k].img_src || ''),
        unsafe: unsafeArr[k] || 0,
        best: false,
      }))
      .sort((x, y) => y.px_w * y.px_h - x.px_w * x.px_h || y.size - x.size)
    if (items.length) items[0].best = true // 保留建议: 分辨率最大(平手看文件大小)
    const meta = bestPairShared.get(root)
    groups.push({ score: meta.score, shared: meta.tags, items })
  }
  groups.sort((a, b) => b.score - a.score)
  const truncated = groups.length > maxGroups
  const outGroups = groups.slice(0, maxGroups)
  annotateTimes(outGroups)
  return {
    scanned: N,
    candidates: nCandidates,
    ignoredPairs: nIgnored,
    blockedPairs: nBlocked,
    groups: outGroups,
    truncated,
    elapsedMs: Date.now() - t0,
  }
}

/**
 * 「已忽略的图片组」(2026-10-23 用户需求: 能切过去看看忽略过哪些)
 * ================================================================
 * 忽略表只存 id 对, 这里把它还原成组给前端展示:
 *   1. id 对当边, 并查集合并(与扫描同款) —— 用户点「非重复」时是把整组两两
 *      都写进去的, 所以同一次忽略的图天然连通;
 *   2. 按 id 回库查 path/tags/尺寸/来源文件夹, 附 unsafe 标记(安全模式复用);
 *   3. 两端有任一行查不到的旧对(图已删 / 整库重导)不参与组, 计入 missingPairs。
 * 分数和共享 tag 当时没落盘, 这里现算组内**公共标签**顶上, 不假装有分数。
 */
export function findIgnoredGroups(ignorePairs = new Set()) {
  const t0 = Date.now()
  if (!ignorePairs || !ignorePairs.size) {
    return { groups: [], pairs: 0, missingPairs: 0, elapsedMs: Date.now() - t0 }
  }
  const db = openDb()
  const cols = new Set(db.prepare('PRAGMA table_info(images)').all().map((c) => c.name))
  const dimSel = ['px_w', 'px_h', 'size', 'mtime_ms', 'img_src'].filter((c) => cols.has(c))
  const hasGone = cols.has('gone')
  const hasFolders = (() => {
    try {
      return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folders'`).get()
    } catch { return false }
  })()

  const ids = new Set()
  for (const k of ignorePairs) {
    const [a, b] = String(k).split('|').map(Number)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) { ids.add(a); ids.add(b) }
  }
  if (!ids.size) return { groups: [], pairs: ignorePairs.size, missingPairs: ignorePairs.size, elapsedMs: Date.now() - t0 }

  const rows = []
  const arr = [...ids]
  for (let i = 0; i < arr.length; i += 400) {
    const chunk = arr.slice(i, i + 400)
    rows.push(...db.prepare(
      `SELECT i.id, i.path, i.tags${dimSel.length ? ', i.' + dimSel.join(', i.') : ''}${hasFolders ? ', f.path AS folder' : ', NULL AS folder'}
       FROM images i${hasFolders ? ' LEFT JOIN folders f ON f.id = i.folder_id' : ''}
       WHERE i.id IN (${chunk.map(() => '?').join(',')})${hasGone ? ' AND i.gone = 0' : ''}`
    ).all(...chunk))
  }

  const sm = safetyMatcher()
  const byId = new Map()
  for (const r of rows) {
    const tagArr = String(r.tags || '').split(',').filter(Boolean)
    byId.set(Number(r.id), {
      id: r.id,
      path: r.path,
      tags: r.tags || '',
      folder: r.folder || '',
      px_w: r.px_w || 0,
      px_h: r.px_h || 0,
      size: r.size || 0,
      mtime_ms: Number(r.mtime_ms) || 0,
      img_src: String(r.img_src || ''),
      unsafe: unsafeLevelOf(tagArr, sm) || 0,
      _tagSet: new Set(tagArr),
    })
  }

  const parent = new Map()
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n }
    return r
  }
  const union = (a, b) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb))
  }
  for (const id of byId.keys()) parent.set(id, id)

  let validPairs = 0
  for (const k of ignorePairs) {
    const [a, b] = String(k).split('|').map(Number)
    if (byId.has(a) && byId.has(b)) { union(a, b); validPairs++ }
  }

  const byRoot = new Map()
  for (const id of byId.keys()) {
    const r = find(id)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(id)
  }

  const groups = []
  for (const memberIds of byRoot.values()) {
    if (memberIds.length < 2) continue
    const items = memberIds.map((id) => byId.get(id))
    // 公共标签: 从最短的那张图的 tag 集开始过
    items.sort((x, y) => x._tagSet.size - y._tagSet.size)
    let common = new Set(items[0]._tagSet)
    for (const it of items.slice(1)) {
      common = new Set([...common].filter((t) => it._tagSet.has(t)))
      if (!common.size) break
    }
    items.sort((x, y) => y.px_w * y.px_h - x.px_w * x.px_h || y.size - x.size)
    groups.push({
      score: null,
      shared: [...common].slice(0, 12),
      ignored: true,
      items: items.map((it, i) => ({
        id: it.id,
        path: it.path,
        tags: it.tags,
        folder: it.folder,
        px_w: it.px_w,
        px_h: it.px_h,
        size: it.size,
        mtime_ms: it.mtime_ms,
        img_src: it.img_src,
        unsafe: it.unsafe,
        best: i === 0,
      })),
    })
  }
  groups.sort((a, b) => b.items.length - a.items.length)
  annotateTimes(groups)

  return {
    groups,
    pairs: ignorePairs.size,
    missingPairs: ignorePairs.size - validPairs,
    elapsedMs: Date.now() - t0,
  }
}
