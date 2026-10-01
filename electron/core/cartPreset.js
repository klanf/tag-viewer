/**
 * 购物车自动导出（单预设）
 * =======================
 * 用户诉求(2026-09-29):「给购物车也加个类似筛选的预设功能, 不过这个主要是检测当前购物车,
 * 如果当前购物车有更新, 就导出一份当前购物车到指定路径, 这个预设只需要一个」。
 *
 * 与 exportPresets.js(黑名单那条) 是亲兄弟: 同样是「内容真的变了 -> 延迟合并 -> 原子覆盖写」,
 * 区别只有三点 —— 触发源是**购物车**、**只有一个预设**(没有列表/多份筛选快照)、
 * 内容走 buildCartExport(wildcard) 而不是 buildExport(筛选结果)。
 *
 * 四条刻意的取舍（都跟用户确认过）:
 *   · 内容 = wildcard txt, 与「导出全部」逐字一致(同一个 buildCartExport) ——
 *     下游 ComfyUI 读的是固定路径的 wildcard 文件, 格式不能自作主张。
 *   · **购物车被清空不导** —— 清空不算"更新", 保留上一次的文件。
 *     理由: 「结算」= 导出 -> 存历史 -> 清空, 若把清空也当更新, 就会**把下游那份
 *     文件悄悄清成空** —— 而用户刚结完的那批可能还在被 ComfyUI 使用。
 *   · 触发挂**渲染层的 useCartStore watch**(每次变更把 tags 全量报过来), 而不是逐个入口挂钩子。
 *     于是六个入口一次全覆盖: 标签详情页「角色」区 pill / 光箱 pill / 系列页卡片与批量加入 /
 *     购物车页与抽屉的删除清空 / 结算后自动清空 / 历史载入(replaceAll) 整体替换。
 *     以后再加新入口也不会漏。
 *   · 排程器是**本文件自带的精简版**, 没有复用 exportScheduler.js ——
 *     那份当时属于另一条还没提交的工作线, 引用它会逼着把别人的半成品一起提交。
 *     语义完全照抄(idle/scheduled/running + dirty 补跑), 等那条线落地后两边可以合并成一份。
 *
 * ⚠️ 与「立即导出(manual)」的分工: manual 直接跑、**不发推送**(调用方拿返回值自己弹 toast),
 *    免得一次操作弹两条。排程到点/关窗前 flush 才走推送(cart:auto)。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataFile } from './workspace.js'
import { buildCartExport } from './exporter.js'

const FILE = 'cart_preset.json'         // -> <dataDir>/user/cart_preset.json
const VERSION = 1
const DEFAULT_FILE = 'roles_cart.txt'

/**
 * 延迟档位。**与黑名单那条各存各的** —— 用户明确要"只一个预设", 那它的延迟就该是
 * 这个预设自己的属性, 而不是全局第二个旋钮(容易搞混"我改的是哪个")。
 * 白名单化的理由同 exportScheduler.js: 这个值会落在用户能手改的 json 里。
 */
export const DELAY_OPTIONS = [1500, 30000, 60000, 180000, 300000, 600000]
/** 默认 30 秒: 购物车这份文件只有几十行(写盘几乎不耗时), 攒一下只是为了别一边挑角色一边写 */
export const DEFAULT_DELAY_MS = 30000

export function normDelay(v) {
  const n = Number(v)
  return DELAY_OPTIONS.includes(n) ? n : DEFAULT_DELAY_MS
}

/* ------------------------------------------------------------ 小工具 */

/**
 * 同步小睡 —— runCartPreset 是同步 API(IPC handler 直接返回值), 不能 await。
 * `Atomics.wait` 是主线程上唯一不烧 CPU 的同步等待。
 */
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  try { Atomics.wait(sleepBuf, 0, 0, ms) } catch { /* 不支持就算了, 只影响退避时长 */ }
}

/**
 * 原子替换(临时文件 -> 目标名) + 瞬时错误退避重试。
 * 与 exportPresets.js 里那个是同一套(Windows 上刚写出的文件会被 Defender / 搜索索引器
 * 短暂占住, 一次 EPERM 就把整次导出丢掉: 文件还是旧的, 而界面上可能还显示"上次成功")。
 * 没有抽公共模块是因为那边正被另一条线改着, 这里先自带一份。
 */
function replaceFileWithRetry(tmp, full, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.renameSync(tmp, full)
      return
    } catch (e) {
      const transient = e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EBUSY'
      if (!transient || i === tries - 1) {
        try { fs.unlinkSync(tmp) } catch { /* 清不掉也别把真正的错误盖掉 */ }
        throw e
      }
      sleepSync(60 * (i + 1))       // 60/120/180/240ms
    }
  }
}

/** 文件名消毒: Windows 非法字符 + 结尾的点/空格; 没有扩展名就补 .txt */
export function safeFileName(s) {
  const t = String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim()
  if (!t) return ''
  return /\.[a-z0-9]{1,8}$/i.test(t) ? t : `${t}.txt`
}

/* ------------------------------------------------------------ 存储 */

function filePath() {
  return dataFile(FILE)
}

function normPreset(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: !!r.enabled,
    dir: String(r.dir || '').trim(),
    file: safeFileName(r.file) || DEFAULT_FILE,
    delayMs: normDelay(r.delayMs),
    lastRunAt: Number(r.lastRunAt) || 0,
    lastCount: Number(r.lastCount) || 0,
    lastBytes: Number(r.lastBytes) || 0,
    lastPath: String(r.lastPath || ''),
    lastTrigger: String(r.lastTrigger || ''),
    lastError: String(r.lastError || ''),
    /**
     * 上次**真正导出成功**时购物车的指纹。判"有没有更新"就是拿它比 ——
     * 落盘的好处: 重启后不会因为"内存里没有指纹"而把同一份购物车白导一遍。
     * 导出失败时**不写**它, 所以下次改动会重新排程(不会因为一次失败就永久卡住)。
     */
    lastFingerprint: String(r.lastFingerprint || ''),
  }
}

function emptyStore() {
  return { version: VERSION, updated_at: 0, preset: normPreset({}) }
}

function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    // 容忍"整个文件就是预设本体"的写法(手改文件时容易少一层 preset)
    return { version: VERSION, updated_at: j?.updated_at || 0, preset: normPreset(j?.preset ?? j) }
  } catch {
    return emptyStore()
  }
}

function writeStore(store) {
  const next = { version: VERSION, updated_at: Date.now(), preset: store.preset }
  const p = filePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  replaceFileWithRetry(tmp, p)
  return next
}

/* ------------------------------------------------------------ 指纹 */

/**
 * 购物车指纹。**顺序敏感** —— 导出的 wildcard 文件就是按 list 顺序逐行写的,
 * 同一个角色"移出再放回来"会让文件行序变化, 那就是内容真的变了, 该重导。
 * 条目级附加标签(2026-10-01)也算内容: extra 变了导出的行文本就变了。
 * 接受字符串(旧调用方)或 {tag, extra} 对象, 统一归一成对象再哈希。
 */
export function fingerprint(tags) {
  const arr = (Array.isArray(tags) ? tags : []).map((t) => {
    if (t && typeof t === 'object') {
      const extra = Array.isArray(t.extra) ? t.extra.map(String) : []
      return `${String(t.tag)}\u001f${extra.join('\u001f')}`
    }
    return String(t)
  })
  return crypto.createHash('sha1').update(arr.join('\n')).digest('hex')
}

/* ------------------------------------------------------------ 排程器(精简版) */

let lastTags = []      // 渲染层最近一次报来的购物车条目({tag, extra}或字符串; 内存态, 不落盘)
let notifier = null

let state = 'idle'     // idle | scheduled | running
let timer = null
let dueAt = 0
let dirty = false      // running 期间又变更过 -> 跑完补一轮
let running = null     // flush 要能"等当前这轮跑完"

function clearWait() {
  if (timer) { clearTimeout(timer); timer = null }
  dueAt = 0
}

function isActive() {
  const p = readStore().preset
  return !!(p.enabled && p.dir)
}

function push(payload) {
  try { notifier?.(payload) } catch { /* 推送失败不能影响导出本身 */ }
}

export function hasPendingCart() {
  return !!timer || state === 'running' || dirty
}

/**
 * 排一次(防抖合并): 每次改动都重算到期时间 —— 用户要的是"停手之后再导"。
 * @returns {{scheduled:boolean, coalesced?:boolean, fresh?:boolean, dueAt?:number, delayMs?:number, reason?:string}}
 */
function schedule() {
  if (!lastTags.length) return { scheduled: false, reason: 'empty' }
  if (!isActive()) return { scheduled: false, reason: 'off' }
  if (state === 'running') {
    dirty = true                                   // 不许丢: 跑完自动补一轮
    return { scheduled: true, coalesced: true, reason: 'busy' }
  }
  const fresh = state === 'idle'
  clearWait()
  const delayMs = Math.max(0, Number(readStore().preset.delayMs) || 0)
  state = 'scheduled'
  dueAt = Date.now() + delayMs
  timer = setTimeout(() => {
    timer = null
    dueAt = 0
    void fire('timer')
  }, delayMs)
  push({ kind: 'scheduled', dueAt, delayMs, fresh, count: lastTags.length })
  return { scheduled: true, fresh, dueAt, delayMs }
}

/** 渲染层报来"购物车变了"。返回的 changed 是给调用方做提示用的。 */
export function notifyCartChanged(tags) {
  const arr = (Array.isArray(tags) ? tags : []).map((t) =>
    (t && typeof t === 'object') ? t : String(t))
  lastTags = arr

  // 清空: 不导、也不留待导的排程 —— 否则定时器到点会把下游那份文件清成空。
  // 同时**不动 lastFingerprint**: 等用户把同一批角色加回来时, 指纹与"上次导出"一致,
  // 判定为"没更新", 也就不会白导一遍(文件里本来就已经是这批)。
  if (!arr.length) {
    clearWait()
    return { changed: false, scheduled: false, reason: 'empty', count: 0 }
  }

  const changed = fingerprint(arr) !== readStore().preset.lastFingerprint
  if (!changed) return { changed: false, scheduled: false, count: arr.length }
  const r = schedule()
  return { changed: true, count: arr.length, ...r }
}

/* ------------------------------------------------------------ 执行 */

function patchRun(patch) {
  const store = readStore()
  Object.assign(store.preset, patch)
  writeStore(store)
}

/**
 * 跑一次: 算 -> 原子写盘 -> 记录结果。
 * 抛错时把原因写进预设的 lastError(界面上能看见"上次为什么没导成")。
 */
function runOnce(trigger) {
  const p = readStore().preset
  try {
    if (!p.dir) throw new Error('还没设置目标目录')
    if (!lastTags.length) throw new Error('购物车是空的')
    const r = buildCartExport(lastTags, { spaces: true })
    fs.mkdirSync(p.dir, { recursive: true })
    const full = path.join(p.dir, p.file)
    const tmp = `${full}.tmp${process.pid}`
    fs.writeFileSync(tmp, r.text, 'utf8')
    replaceFileWithRetry(tmp, full)
    const bytes = Buffer.byteLength(r.text, 'utf8')
    patchRun({
      lastRunAt: Date.now(), lastCount: r.count, lastBytes: bytes,
      lastPath: full, lastTrigger: trigger, lastError: '',
      lastFingerprint: fingerprint(lastTags),
    })
    return { ok: true, path: full, count: r.count, bytes, trigger }
  } catch (e) {
    patchRun({ lastRunAt: Date.now(), lastTrigger: trigger, lastError: e?.message || String(e) })
    throw e
  }
}

/** 跑一轮(定时器到点 / flush 都走这里)。同一时刻只允许一轮。 */
async function fire(trigger) {
  if (state === 'running') { dirty = true; return { skipped: true, reason: 'busy' } }
  clearWait()
  if (!lastTags.length) {
    state = 'idle'
    push({ kind: 'result', at: Date.now(), trigger, results: [], skipped: true, reason: 'empty' })
    return { skipped: true, reason: 'empty' }
  }
  state = 'running'
  dirty = false
  running = (async () => {
    let payload
    try {
      payload = runOnce(trigger)
    } catch (e) {
      // 导出失败绝不能往上抛: 改购物车是主操作、导出是附带的
      payload = { ok: false, error: e?.message || String(e), trigger }
    }
    state = 'idle'
    push({ kind: 'result', at: Date.now(), trigger, results: [payload] })
    const again = dirty
    dirty = false
    if (again) schedule()          // 补跑: 上一轮跑的时候用户又改了购物车
    return payload
  })()
  try {
    return await running
  } finally {
    running = null
  }
}

/**
 * 立即导出一次（用户点「立即导出」）。
 * · 开关关着也允许导 —— 这是主动动作，只要设了目录就该照办。
 * · tags 由调用方带上（渲染层手里那份是最新的）：**不能只信 lastTags** ——
 *   刚开窗还没改过购物车时内存里是空的，而用户明明看着购物车里有东西。
 * · 不发推送，结果由调用方弹 toast。
 */
export function runCartPreset({ tags, trigger = 'manual' } = {}) {
  if (Array.isArray(tags)) {
    lastTags = tags.map((t) => (t && typeof t === 'object') ? t : String(t))
  }
  clearWait()
  return runOnce(trigger)
}

/**
 * 跳过等待、立刻把"排程中的那次"导掉。
 * 两个调用方: 抽屉里的「立刻导」 / 关窗口前的收尾。
 * **没有排程就什么都不做** —— 否则用户点一下空按钮反而触发一次写文件。
 */
export async function flushCartPendingNow() {
  if (!hasPendingCart()) return { ok: true, skipped: true }
  clearWait()
  dirty = false
  return fire('manual')
}

/** 取消待排程（关掉开关 / 清空购物车）。不打断正在跑的那一轮。 */
export function cancelCartPending() {
  clearWait()
  dirty = false
}

/* ------------------------------------------------------------ 配置 */

/** 主进程把结果推给渲染层的回调(ipc.js 注册) */
export function setCartNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null
}

export function cartPresetState() {
  const p = readStore().preset
  const fp = lastTags.length ? fingerprint(lastTags) : ''
  return {
    ...p,
    delayOptions: DELAY_OPTIONS,
    active: !!(p.enabled && p.dir),         // 真的会在变更时自动导
    cartCount: lastTags.length,
    /** 当前购物车是否与"上次导出"一致(false = 有更新还没导出去) */
    synced: !lastTags.length ? true : fp === p.lastFingerprint,
    pending: hasPendingCart(),
    running: state === 'running',
    dueAt,
    remainingMs: timer ? Math.max(0, dueAt - Date.now()) : 0,
  }
}

/**
 * 改配置(局部 patch)。三件事顺带处理:
 *   1. 刚打开开关 / 换了目录 -> **立刻导一份**。否则用户对着一个空目录等 30 秒，
 *      或者以为"开了开关文件就有了"。失败只记 lastError，不打断保存本身。
 *   2. 关掉开关 -> 取消待排程（用户明确表示不要了）。
 *   3. 延迟改了立刻生效: 正排着队的按新时长重排。
 */
export function saveCartPreset(patch = {}) {
  const store = readStore()
  const before = store.preset
  const next = normPreset({ ...before, ...patch })
  store.preset = next
  writeStore(store)

  const activeBefore = !!(before.enabled && before.dir)
  const activeNow = !!(next.enabled && next.dir)
  const dirChanged = !!next.dir && before.dir !== next.dir

  if (!activeNow) {
    cancelCartPending()
  } else if ((!activeBefore || dirChanged) && lastTags.length) {
    try { runOnce('enable') } catch { /* 失败记进 lastError, 不往上抛 */ }
  } else if (before.delayMs !== next.delayMs && state === 'scheduled') {
    schedule()                              // 重排，等价于"立刻生效"
  }
  return cartPresetState()
}
