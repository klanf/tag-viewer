/**
 * 批量自动拉封面(2026-10-22)
 * ==========================
 * 干的事: 给一批角色/系列, 各自去 Danbooru / Safebooru 搜同名标签, 取人气最高的
 * 那张安全图, 下载到 data/char_covers/user_picks/, 写成自定义封面。
 * 等价于「打开换封面弹窗 → 点网上挑 → 点第一张 → 关掉」重复 N 次。
 *
 * 为什么放在主进程做成后台任务, 而不是渲染层 for 循环 await:
 *  1. 渲染层循环一旦用户切页/关弹窗就断了(第十一轮那个「下载中关窗不刷新」就是
 *     这类生命周期耦合的产物), 而批量任务动辄几十分钟, 不能赌界面还在;
 *  2. 下载/写盘本来就在主进程, 循环放这边少 N 次 IPC 往返;
 *  3. 进度推送、取消、状态补拉可以直接照抄 tagger/ingest 这套已经跑通的模式。
 *
 * 四个必须写清楚的取舍:
 *  · **单并发 + 每目标之间歇一下**。本机到这两个站是抖链路(实测同一请求上一轮 1s、
 *    下一轮 10s 握手超时), 并发拉会互相抢那条窄管子, 只会把超时率抬高。
 *  · **跳过已有自定义封面 = 天然可续跑**。中途取消或断网后再点一次, 已经拉好的
 *    那些不会再下一遍(它们现在有封面了), 任务从断点接着往下走。
 *  · **只取每标签采样范围内分数最高的那张**(每目标翻 2 页)。批量场景要的是"每个角色有张
 *    能看的封面", 不是挑图; 真要挑就走弹窗。"人气"到此已经是匿名接口能给的最好答案 ——
 *    实测两个站都不给匿名请求做服务端排序, 翻得越深越接近真人气, 但也更吃那条抖链路。
 *  · **跑着的时候可以追加**(2026-10-22 用户反馈「切到另一个系列就加不进来了」)。
 *    所以内部是一个队列而不是一个 for 循环: runAutoCovers 变成**同步**函数 ——
 *    没在跑就开泵, 在跑就只往队列里塞, 立刻告诉渲染层"排进去几个/为什么排不进"。
 *    渲染层原来那条 IPC 不 await 这个 Promise(要跑几十分钟), 于是后端返回的
 *    `{error}` 永远到不了界面; 改同步之后这个老坑一并填了。
 */
import { booruBestPosts, booruDownload } from './booru.js'
import { setCover } from './query.js'
import { loadUserMeta } from './meta.js'

const GAP_MS = 600               // 两个目标之间的喘息(限流 + 让出主进程)
const RETRY_DELAY_MS = 2500
const MAX_TARGETS = 3000         // 单次任务上限(含追加): 再大就该拆成几批, 别让一个任务占死链路
/** 每个目标翻几页再挑(见 fetchOneFor): 1 页就只能看见最新的, 2 页是"值不值"的折中 */
const SCAN_PAGES = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 去重/查封面表用的键: custom_covers 原样存键, 大小写并不严格一致, 一律归一 */
const lower = (s) => String(s || '').toLowerCase()
const keyOf = (t) => `${t.kind}:${lower(t.key)}`

const st = {
  running: false,
  cancelRequested: false,
  total: 0,
  done: 0,
  ok: 0,
  skipped: 0,
  failed: 0,
  /** 队列里还没开始的条数(追加会涨、轮到一个就减): 界面用它说"还有 N 个排队" */
  queued: 0,
  current: '',
  startedAt: 0,
  /** 结束时刻(含取消): 右下角那根胶囊要在"同步/反推/在线封面"三个后台任务里
   *  挑一个显示, 都没在跑时按**结束时间更晚**的那个 —— 没有这个字段就没法比。 */
  finishedAt: 0,
  elapsedMs: 0,
  finished: false,
  cancelled: false,
  source: '',
  rating: '',
  solo: false,
  /** 最近几条失败(给 UI 一句人话), 只留 5 条, 不撑爆推送体积 */
  errors: [],
}

/** 待处理目标: 每条自带 source/rating/solo —— 追加时可能换了图源/分级, 不能共用一份 */
let queue = []
/** 已在队列里(含正在下载)的键; 处理完就移除, 于是"失败后再点一次"能重试 */
const seenPending = new Set()
/** 本次任务累计接受的目标数(含追加), 用来卡 MAX_TARGETS */
let accepted = 0
/** 开跑前拍一张封面表的快照, 之后本次新拉到的也写进来(见 runAutoCovers) */
let hasCustom = new Map()
let skipCustom = true
let emit = () => {}

function snapshot(extra = {}) {
  return {
    running: st.running,
    total: st.total,
    done: st.done,
    ok: st.ok,
    skipped: st.skipped,
    failed: st.failed,
    queued: st.queued,
    current: st.current,
    elapsedMs: Date.now() - st.startedAt,
    finishedAt: st.finishedAt,
    finished: st.finished,
    cancelled: st.cancelled,
    source: st.source,
    rating: st.rating,
    solo: st.solo,
    errors: st.errors.slice(-5),
    ...extra,
  }
}

function push() {
  try { emit(snapshot()) } catch { /* 渲染层没了也不该拖垮任务 */ }
}

/**
 * 启动或追加。**同步返回** —— 于是 ipc 能把 {error}/{added} 真实送回渲染层。
 * 回包 = 最新状态快照 + `added`(这一次真正排进队列几条) + `started`(是不是开了新一批)。
 * ⚠️ 不要再放一个 `ok: true` 进来: 快照里 `ok` 是"成功拉到的条数", 同名会把布尔覆盖成数字。
 * @param raw {targets:[{kind:'chars'|'series', key, label?}], kind?, source, rating, solo, skipCustom}
 * @param opts.onProgress 由 ipc.js 传入(推送到渲染层), 每个目标一次 + 追加时一次
 * @returns {{error?:string, added?:number, started?:boolean, note?:string, ...state}}
 */
export function runAutoCovers(raw = {}, opts = {}) {
  emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}

  const kind = raw.kind === 'series' ? 'series' : 'chars'
  /* targets 给 [{kind,key}] —— 混合两层也支持(比如从「全部」口径来的系列+角色)。
   * 每条自己的 kind 优先于顶层 kind。 */
  let list = (Array.isArray(raw.targets) ? raw.targets : [])
    .map((t) => ({
      kind: t?.kind === 'series' ? 'series' : t?.kind === 'chars' ? 'chars' : kind,
      key: String(t?.key || '').trim(),
      label: String(t?.label || '').trim(),
    }))
    .filter((t) => t.key)
  if (!list.length) return { error: '没有要处理的角色/系列' }

  const source = raw.source === 'safebooru' ? 'safebooru' : 'danbooru'
  const rating = ['g', 's', 'all'].includes(raw.rating) ? raw.rating : 'g'
  /* solo(只要单人图): 批量拉封面时加这一条, 挡掉"两人对打/群像里混一个"的图 ——
   * 那种图当角色封面经常认不出是谁(第十一轮脚本盲选踩过)。匿名时它会占掉
   * Danbooru 两个标签额度里的一个, 于是 rating 只能回到本地筛(见 booru.js)。 */
  const solo = raw.solo === true

  /* ---------- 已经在跑: 追加 ---------- */
  if (st.running) {
    if (st.cancelRequested) return { error: '正在停止中，等这一条收尾后再加' }
    /* 同一个键只要还在排队/下载中就不重复塞; 已经处理完的不拦(失败的可重试,
     * 成功的会被 skipCustom 跳过, 不会白下载)。 */
    const before = list.length
    list = list.filter((t) => !seenPending.has(keyOf(t)))
    if (!list.length) {
      return {
        ...snapshot(), added: 0,
        note: before ? '这些已经在这批的队列里了' : '没有要处理的角色/系列',
      }
    }
    if (accepted + list.length > MAX_TARGETS) {
      return { error: `这一批(含排队)最多 ${MAX_TARGETS} 个，先等它跑掉一些或拆成两批` }
    }
    for (const t of list) {
      t.source = source
      t.rating = rating
      t.solo = solo
      queue.push(t)
      seenPending.add(keyOf(t))
    }
    accepted += list.length
    st.total += list.length
    st.queued = queue.length
    /* 面板上那三个"当前口径"跟着最近一次追加走: 用户刚换过图源/分级,
     * 下一件就按新的来, 显示旧的会自相矛盾。 */
    st.source = source
    st.rating = rating
    st.solo = solo
    push()
    return { ...snapshot(), added: list.length }
  }

  /* ---------- 没在跑: 开一批 ---------- */
  /* 单次请求内部也可能带重复(选中与口径交叠), 先去掉 */
  const seen = new Set()
  list = list.filter((t) => {
    const k = keyOf(t)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (list.length > MAX_TARGETS) return { error: `一次最多 ${MAX_TARGETS} 个，先筛小一点的范围` }

  skipCustom = raw.skipCustom !== false
  /* 开跑前拍一张封面表的快照: 「已经有封面没」是判据, 但每条都读一次 user_meta.json
   * 太浪费(批量场景几百次同步读盘)。续跑靠的是这份快照 + 本次新写进去的那些。 */
  const meta0 = loadUserMeta()
  hasCustom = new Map()
  for (const [k, v] of Object.entries(meta0.custom_covers?.chars || {})) hasCustom.set(`chars:${lower(k)}`, v)
  for (const [k, v] of Object.entries(meta0.custom_covers?.series || {})) hasCustom.set(`series:${lower(k)}`, v)

  queue = list.map((t) => ({ ...t, source, rating, solo }))
  seenPending.clear()
  for (const t of queue) seenPending.add(keyOf(t))
  accepted = queue.length

  Object.assign(st, {
    running: true, cancelRequested: false, total: queue.length, done: 0, ok: 0,
    skipped: 0, failed: 0, queued: queue.length, current: '', startedAt: Date.now(),
    finishedAt: 0, finished: false, cancelled: false, source, rating, solo, errors: [],
  })
  push()

  /* 不 await: 任务可能跑几十分钟, 调用方(invoke)要的是一个"已启动" */
  pump().catch((e) => {
    st.errors.push(`批任务异常: ${e?.message || e}`)
    st.failed++
    finish()
  })
  return { ...snapshot(), started: true, added: 0 }
}

/** 队列泵: 一条一条来(单并发, 见文件头), 中途追加的下一条就能接上 */
async function pump() {
  while (queue.length && !st.cancelRequested) {
    const t = queue.shift()
    st.queued = queue.length
    st.current = t.label || t.key
    push()

    if (skipCustom && hasCustom.has(keyOf(t))) {
      /* 处理完才从"在队列里"摘掉: 正在下载的这条也不该被重复追加 */
      seenPending.delete(keyOf(t))
      st.skipped++
      st.done++
      push()
      continue
    }

    const r = await fetchOneFor(t)
    seenPending.delete(keyOf(t))
    if (r.ok) {
      st.ok++
      hasCustom.set(keyOf(t), r.path)
    } else if (r.skipped) {
      st.skipped++
    } else {
      st.failed++
      st.errors.push(`${t.label || t.key}: ${r.error}`)
    }
    st.done++
    push()
    if (st.cancelRequested) break
    await sleep(GAP_MS)
  }

  finish()
}

function finish() {
  st.cancelled = st.cancelRequested
  st.running = false
  st.finished = true
  st.finishedAt = Date.now()
  st.current = ''
  if (st.cancelRequested) queue = []
  st.queued = queue.length
  push()
}

/** 单个目标: 搜 -> 依次试前几张 -> 下载 -> 设封面。任何一步站点的抖动都不该终止整批。 */
async function fetchOneFor(t) {
  const { source, rating, solo } = t
  const query = solo ? `${t.key} solo` : t.key
  let found = null
  for (let attempt = 0; attempt < 2 && !found; attempt++) {
    /* 用 booruBestPosts 而不是单次搜索: 匿名接口只按**最新**返回(实测 order=score 不生效),
     * 只翻一页的话, "人气最高"其实等于"最新 40 张里分最高的", 小众角色常常是 2 分那种。
     * 多翻一页就多说一句人话, 代价是每个目标多一次请求 —— 批量场景可以接受。 */
    const s = await booruBestPosts({ source, tags: query, rating, pages: SCAN_PAGES })
    if (s.error) {
      /* 429/403 这类"歇会儿再来"的一次重试就够; 连不上(ENOTFOUND/超时)重试也常成 ——
       * 抖链路实测就是这样。两次都失败就记失败, 整批继续。 */
      if (attempt === 0) { await sleep(RETRY_DELAY_MS); continue }
      return { ok: false, error: s.error }
    }
    found = (s.posts || []).filter((p) => p.sample || p.file || p.preview)
  }
  if (!found || !found.length) return { ok: false, skipped: true, error: '没搜到合适的图' }

  for (const p of found.slice(0, 3)) {
    if (st.cancelRequested) return { ok: false, skipped: true, error: '已停止' }
    const dl = await booruDownload({
      source: p.source_site || source,
      url: p.sample || p.file || p.preview,
      tag: t.key,
      post_id: p.id,
    })
    if (dl.error) continue
    const set = setCover({ kind: t.kind, key: t.key, path: dl.path })
    if (set.error || set.ok === false) return { ok: false, error: set.error || '封面没写进 user_meta.json' }
    return { ok: true, path: dl.path, post_id: p.id }
  }
  return { ok: false, error: '前几张都没下载成功' }
}

export function autoCoversState() {
  return snapshot()
}

/** 取消是" cooperative ": 当前这一条下载完才停, 不打断已经发出去的请求; 队列里没开始的作废 */
export function cancelAutoCovers() {
  if (!st.running) return { ok: true, ...snapshot() }
  st.cancelRequested = true
  return { ok: true, ...snapshot() }
}
