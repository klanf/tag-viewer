/**
 * 导出预设 + 「黑名单变更后自动导出」
 * ==================================
 * 用户诉求(2026-09-22): 每次 ban 完词条都要手动点导出、再在「另存为」里挑目录,
 * 纯重复劳动。这里把它变成: 预设里存好【来源 + 筛选参数 + 目标目录/文件名】,
 * 黑名单**内容真的变了**就按预设原地覆盖导出一次。
 *
 * 2026-09-24 改: 延迟从写死的 1.5s 变成**全局可配、默认 3 分钟**。
 *   起因(用户原话): "点击黑名单后过几分钟再自动导出, 因为有可能同时 ban 好几个,
 *   每个都导出有点耗时"。1.5s 防抖只能合并"同一瞬间"的连点, 而真实操作是
 *   隔几秒 ban 一个、连着 ban 十几个 —— 每个都各触发一次 3~4 秒的同步导出。
 *   顺带修掉一个真 bug: 上一轮还在跑时定时器到点, 这次改动会被静默丢弃
 *   (旧代码 `if (running) return {skipped:true}`), 现在标脏、跑完补一轮。
 *   排程状态机本身摘到了 ./exportScheduler.js(纯逻辑, 可单测假时钟)。
 *
 * 几个刻意的取舍:
 *   · 触发只认「黑名单内容真的变了」(指纹比对) —— 打开编辑器原样保存、连点
 *     多个 🚫 都只导一次, 不会因为"点了保存"就白跑一遍。
 *   · 写入走「临时文件 + rename」原子替换: 下游(ComfyUI 等)固定读这个文件,
 *     绝不能读到写了一半的内容。
 *   · **导出失败绝不影响 ban 本身** —— ban 是主操作, 导出是附带的;
 *     失败只把错误记进预设并回执, 不往上抛。
 *   · 延迟期间界面能看见"还差多久"(首页角标倒计时), 点一下跳过等待立刻导;
 *     关窗口前也会把待导的跑掉 —— 否则 3 分钟延迟下"ban 完就关窗"等于白改。
 *   · 预设存数据目录 `user/export_presets.json`(走 dataFile 路由表) ——
 *     e2e/冒烟沙箱有自己的一份数据目录, 不会污染真实预设。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataFile } from './workspace.js'
import { buildExport } from './exporter.js'
import { blacklistText } from './rules.js'
import { status, whenReady } from './app-state.js'
import { createScheduler, DELAY_OPTIONS, DEFAULT_DELAY_MS, normDelay } from './exportScheduler.js'

const FILE = 'export_presets.json'      // -> <dataDir>/user/export_presets.json
const VERSION = 1
const DEFAULT_FILE = '筛选结果.txt'

// 延迟档位与归一化在 exportScheduler.js(纯逻辑, 可单测)。
// 这里**再导出**一次: ipc.js 从本模块取(它不该关心排程器的内部结构)。
export { DELAY_OPTIONS }

/* ------------------------------------------------------------ 写盘 */

/**
 * 同步小睡 —— runPreset 是同步 API(IPC handler 直接返回值), 不能 await。
 * `Atomics.wait` 是主线程上唯一不烧 CPU 的同步等待。
 */
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  try { Atomics.wait(sleepBuf, 0, 0, ms) } catch { /* 不支持就算了, 只影响退避时长 */ }
}

/**
 * 原子替换(临时文件 -> 目标名), 但在 Windows 上得**有耐心**。
 * =========================================================
 * 2026-09-22 实测踩到(真机, 不是假想):
 *   自动导出时报 `EPERM: operation not permitted, rename
 *   '...preset-e2e.txt.tmp18424' -> '...preset-e2e.txt'`
 *
 * 原因不在我们的代码: 刚写完的那个 42MB 目标文件会被**别的进程短暂占住** ——
 * Windows Defender 实时扫描、搜索索引器都会去读一遍刚写出的文件。
 * POSIX 语义下 rename 覆盖是原子的、不会等; 而在 Windows 上替换已有目标时,
 * 只要对方句柄没带 FILE_SHARE_DELETE, 这次 rename 就整个失败。
 * 后果很糟: **一次瞬时冲突就把这次导出全丢掉** —— 文件还是旧的(用户以为导过了,
 * 而且界面上可能还显示"上次自动导出成功"), 同时 .tmp 垃圾留在目录里。
 *
 * 所以: 瞬时错误(EPERM/EACCES/EBUSY)退避重试几次(总计约 0.8s);
 * 仍然失败则清掉 .tmp(不留垃圾)再抛 —— 错误照旧记进预设的 lastError。
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
      sleepSync(60 * (i + 1))     // 60/120/180/240ms
    }
  }
}

/* ---------------------------------------------------------------- 存储 */

function filePath() {
  return dataFile(FILE)
}

function emptyStore() {
  return { version: VERSION, updated_at: 0, autoDelayMs: DEFAULT_DELAY_MS, presets: [] }
}

function readStore() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8')
    const j = JSON.parse(raw)
    // 容忍"直接写了个数组"的形态(手改文件时容易写成这样)
    const presets = Array.isArray(j) ? j : (Array.isArray(j?.presets) ? j.presets : [])
    // autoDelayMs 是 2026-09-24 加的: **老文件里没有这个字段 -> 直接退回默认 3 分钟**,
    // 不需要写迁移脚本(归一化函数就是兼容层)。
    return {
      version: VERSION,
      updated_at: j?.updated_at || 0,
      autoDelayMs: normDelay(j?.autoDelayMs),
      presets: presets.map(normPreset).filter(Boolean),
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(store) {
  const next = {
    version: VERSION,
    updated_at: Date.now(),
    autoDelayMs: normDelay(store.autoDelayMs),
    presets: store.presets,
  }
  const p = filePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  replaceFileWithRetry(tmp, p)
  return next
}

/* -------------------------------------------------------- 延迟设置(全局) */

/**
 * 当前生效的延迟 = 存档值(不合法就回默认 3 分钟)。
 *
 * ⚠️ 曾经在这里给环境变量 `TV_EXPORT_DELAY_MS` 开了个"永远优先"的口子(为了 e2e 快),
 * 2026-09-24 当天就撤掉了: 它让**界面开始骗人** —— 弹窗按存档值显示"3 分钟",
 * 而实际按环境变量 1.5 秒导; 用户在 e2e/dev 里改延迟也永远不生效(改完界面还回显改过的值)。
 * 正确做法是让**测试自己去改这个值**(e2e 在导出预设段落开头显式设成 1.5 秒并断言),
 * 而不是给产品代码留后门。
 */
export function getAutoDelayMs() {
  return readStore().autoDelayMs
}

/** 有几个"开着自动导出且设了目录"的预设(没有就不排空程) */
export function readAutoCount() {
  return readStore().presets.filter((p) => p.auto && p.dir).length
}

/** 改延迟。存档 + 立刻生效: 正在等的那一批要按新时长**重排**。 */
export function setAutoDelayMs(ms) {
  const store = readStore()
  store.autoDelayMs = normDelay(ms)
  writeStore(store)
  // 只有"正排着队等"的那批需要重排。
  // 正在跑时 (running) 不去 schedule —— 那会被 scheduler 记成 dirty,
  // 白白多导一轮(用户只是改个设置, 没改黑名单)。
  if (scheduler.getState().state === 'scheduled') scheduler.schedule()
  return { ok: true, delayMs: store.autoDelayMs, delayOptions: DELAY_OPTIONS }
}


/* ------------------------------------------------------------ 归一化 */

// replace_set = 用哪一套替换规则(2026-10-04 规则组); 空串 = 默认组。
// append 已于 10-04 移除 UI(用户改用替换规则), 但**留在白名单里**:
// 老预设文件里可能存过这个键, 归一化时丢掉它等于静默改掉老预设的行为。
const PARAM_STRS = ['q', 'exclude', 'sort', 'append', 'replace_set']
const PARAM_ENUMS = {
  mode: ['any', 'all'],
  match: ['contains', 'exact'],
  exclude_match: ['contains', 'exact'],
}
/** 这几个与首页/ buildExport 的默认值对齐: 缺省 = 开 */
const PARAM_BOOL_TRUE = ['exclude_char', 'spaces', 'blacklist', 'replace', 'bg']
const PARAM_BOOL_FALSE = ['with_path', 'strip_char', 'strip_view', 'safe_only', 'seg_mode']

/** 导出参数(等价于首页筛选条件)白名单归一化 —— 只留认识的键, 防脏数据进文件 */
export function normParams(raw = {}) {
  const out = {}
  for (const k of PARAM_STRS) out[k] = typeof raw[k] === 'string' ? raw[k].trim() : ''
  for (const [k, allow] of Object.entries(PARAM_ENUMS)) out[k] = allow.includes(raw[k]) ? raw[k] : allow[0]
  for (const k of PARAM_BOOL_TRUE) out[k] = raw[k] === undefined ? true : !!raw[k]
  for (const k of PARAM_BOOL_FALSE) out[k] = raw[k] === undefined ? false : !!raw[k]
  // 来源: 数组; 空数组 = 全部(与来源筛选条语义一致)
  out.source = Array.isArray(raw.source)
    ? raw.source.map((s) => String(s || '').trim()).filter(Boolean)
    : String(raw.source || '').split(',').map((s) => s.trim()).filter(Boolean)
  return out
}

/** 文件名消毒: Windows 非法字符 + 结尾的点/空格 */
export function safeFileName(s) {
  const t = String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim()
  if (!t) return ''
  return /\.[a-z0-9]{1,8}$/i.test(t) ? t : `${t}.txt`
}

function newId() {
  return 'ep_' + crypto.randomBytes(5).toString('hex')
}

function normPreset(raw) {
  if (!raw || typeof raw !== 'object') return null
  const p = {
    id: String(raw.id || newId()),
    name: String(raw.name || '').trim().slice(0, 60) || '未命名预设',
    dir: String(raw.dir || '').trim(),
    file: safeFileName(raw.file) || DEFAULT_FILE,
    auto: !!raw.auto,
    params: normParams(raw.params || {}),
    lastRunAt: Number(raw.lastRunAt) || 0,
    lastCount: Number(raw.lastCount) || 0,
    lastBytes: Number(raw.lastBytes) || 0,
    lastPath: String(raw.lastPath || ''),
    lastTrigger: String(raw.lastTrigger || ''),
    lastError: String(raw.lastError || ''),
  }
  return p
}

/* ------------------------------------------------------------ CRUD */

export function listPresets() {
  return readStore().presets
}

export function savePreset(raw = {}) {
  const store = readStore()
  const incoming = normPreset(raw)
  if (!incoming) throw new Error('预设数据无效')
  if (!incoming.dir) throw new Error('还没选目标目录')
  const i = store.presets.findIndex((p) => p.id === incoming.id)
  if (i >= 0) {
    // 保留上次运行信息(编辑预设不该把"上次导出 1,234 行"清掉)
    const old = store.presets[i]
    incoming.lastRunAt = old.lastRunAt
    incoming.lastCount = old.lastCount
    incoming.lastBytes = old.lastBytes
    incoming.lastPath = old.lastPath
    incoming.lastTrigger = old.lastTrigger
    incoming.lastError = old.lastError
    store.presets[i] = incoming
  } else {
    store.presets.push(incoming)
  }
  writeStore(store)
  return { ok: true, preset: incoming, presets: store.presets }
}

export function deletePreset(id) {
  const store = readStore()
  const before = store.presets.length
  store.presets = store.presets.filter((p) => p.id !== id)
  writeStore(store)
  return { ok: true, removed: before - store.presets.length, presets: store.presets }
}

/* ------------------------------------------------------------ 执行 */

/** 导出参数 -> buildExport 认识的请求体 */
function toExportQuery(params) {
  return {
    ...params,
    source: params.source.join(','),
    with_path: params.with_path ? '1' : '0',
    spaces: params.spaces ? '1' : '0',
    blacklist: params.blacklist ? '1' : '0',
    replace: params.replace ? '1' : '0',
    bg: params.bg ? '1' : '0',
    strip_char: params.strip_char ? '1' : '0',
    strip_view: params.strip_view ? '1' : '0',
    safe_only: params.safe_only ? '1' : '0',
    seg_mode: params.seg_mode ? '1' : '0',
    exclude_char: params.exclude_char ? '1' : '0',
  }
}

function patchRun(id, patch) {
  const store = readStore()
  const p = store.presets.find((x) => x.id === id)
  if (!p) return
  Object.assign(p, patch)
  writeStore(store)
}

/**
 * 跑一个预设: 算 -> 原子写盘 -> 记录结果。
 * 抛错时也会把错误写进预设的 lastError(界面上能看见"上次失败原因")。
 */
export function runPreset(id, { trigger = 'manual' } = {}) {
  const store = readStore()
  const preset = store.presets.find((p) => p.id === id)
  if (!preset) throw new Error('预设不存在(可能已被删除)')
  try {
    if (!preset.dir) throw new Error('预设没有设置目标目录')
    const r = buildExport(toExportQuery(preset.params))
    fs.mkdirSync(preset.dir, { recursive: true })
    const full = path.join(preset.dir, preset.file)
    const tmp = `${full}.tmp${process.pid}`
    fs.writeFileSync(tmp, r.text, 'utf8')
    // 原子替换: 下游(ComfyUI 等)固定读这个文件, 不会读到半截。
    // 走 replaceFileWithRetry —— Windows 上刚写出的文件可能被扫描器/索引器短暂占住,
    // 一次 EPERM 就把整次导出丢掉(详见上面那个函数的注释)。
    replaceFileWithRetry(tmp, full)
    const bytes = Buffer.byteLength(r.text, 'utf8')
    patchRun(id, {
      lastRunAt: Date.now(), lastCount: r.count, lastBytes: bytes,
      lastPath: full, lastTrigger: trigger, lastError: '',
    })
    return {
      ok: true, id, name: preset.name, path: full, count: r.count, bytes,
      blocked: r.blocked, bgAdded: r.bgAdded, stripped: r.stripped, ms: r.ms, trigger,
    }
  } catch (e) {
    patchRun(id, { lastRunAt: Date.now(), lastTrigger: trigger, lastError: e?.message || String(e) })
    throw e
  }
}

/* ------------------------------------------- 黑名单变更 -> 自动导出 */

export function fingerprint(text) {
  return crypto.createHash('sha1').update(String(text ?? '').replace(/\r\n/g, '\n').trim()).digest('hex')
}

/** 此刻黑名单内容的指纹(供 ipc 侧做"改前/改后"比对) */
export function blacklistFingerprint() {
  return fingerprint(blacklistText())
}

let notifier = null

/** 主进程把结果推给渲染层的回调(ipc.js 注册) */
export function setAutoNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null
}

/**
 * 真正跑一轮: 所有 auto 预设各导一次。
 * 数据集没就绪时**不导**(不能拿半份数据覆盖上一次的好结果), 但会挂补跑 —— 见 armReadyRetry。
 * 注意这里**不发通知**: 结果由排程器统一推(带 kind='result'), 免得两处各推一条。
 */
async function runAutoImpl() {
  const presets = readStore().presets.filter((p) => p.auto && p.dir)
  if (!presets.length) return { skipped: true, results: [] }
  if (status()?.phase !== 'ready') {
    armReadyRetry()
    return { skipped: true, reason: 'not-ready', phase: status()?.phase || 'unknown', results: [] }
  }
  retryPending = false          // 这一轮真跑了, 已排的补跑没有意义
  const results = []
  for (const p of presets) {
    try {
      results.push(runPreset(p.id, { trigger: 'auto' }))
    } catch (e) {
      // 单个预设失败不影响其它预设, 也不影响 ban
      results.push({ ok: false, id: p.id, name: p.name, error: e?.message || String(e), trigger: 'auto' })
    }
  }
  return { results }
}

/**
 * 排程器: 延迟多久导 / 期间又改了几次 / 正在导的时候又改一次怎么办。
 * 摘到 exportScheduler.js 是为了能用假时钟单测(scripts/test-export-presets.mjs)。
 */
export const scheduler = createScheduler({
  run: runAutoImpl,
  notify: (p) => notifier?.(p),
  getDelayMs: getAutoDelayMs,
  listAutoCount: readAutoCount,
})

/**
 * 黑名单改完之后调: 内容真的变了 -> 排一次自动导出(防抖合并)。
 * @param {string} prevFp 改动前调用 blacklistFingerprint() 拿到的值
 * @returns {{changed:boolean, scheduled:boolean, autoCount:number, dueAt:number, delayMs:number, fresh:boolean}}
 *   `fresh` = 这一批的第一次排程(渲染层只在这时候提示一次, 免得连 ban 刷屏)。
 */
export function afterBlacklistChange(prevFp) {
  const nowFp = blacklistFingerprint()
  if (nowFp === prevFp) {
    return { changed: false, scheduled: false, autoCount: 0, dueAt: 0, delayMs: 0, fresh: false }
  }
  const r = scheduler.schedule()
  return {
    changed: true,
    scheduled: !!r.scheduled,
    autoCount: r.autoCount || 0,
    dueAt: r.dueAt || 0,
    delayMs: r.delayMs || 0,
    fresh: !!r.fresh,
  }
}

/**
 * 数据集没就绪时, 这次自动导出不能就这么丢掉 —— 记一笔, 等就绪后补跑一次。
 *
 * 为什么需要: `blacklist:toggle` / `blacklist:save` **不在** ipc.js 的 DATA_CHANNELS 里
 * (它们不读数据集), 所以窗口刚起来、数据集还在加载的那一两秒里, 用户完全可以从
 * 黑名单编辑器存一次改动 —— 那次改动会走到下面的就绪守卫被挡掉。
 *
 * 守卫本身是对的(不能拿半份数据去覆盖上一次的好结果), 但"挡掉就永远不补"会让
 * 这次改动**白改**: 用户以为已经导过了, 实际文件还是旧的, 而且**没有任何提示**
 * (渲染层只在 not-ready 时 warn 一下, 之后就再没下文)。
 * 所以这里挂一次 whenReady 的尾钩: 就绪后补跑一次, 把该导的导掉。
 */
let retryArmed = false
let retryPending = false

function armReadyRetry() {
  retryPending = true
  if (retryArmed) return
  retryArmed = true
  whenReady().then(() => {
    retryArmed = false
    if (!retryPending) return
    retryPending = false
    // 走 flushNow 而不是 schedule: 数据已就绪, 没必要再等一个延迟;
    // 且它内部会先清掉待排程的定时器 —— 不会和定时器撞成"同一批导两次"。
    void scheduler.flushNow()
  }).catch(() => {
    // 数据集加载失败(phase='error') -> 补跑没有意义, 清干净
    retryArmed = false
    retryPending = false
  })
}

/**
 * 立刻把"排程中"的那次导掉 —— 首页角标点一下 / 关窗口前的收尾都走这里。
 * **没有排程就什么都不做**: 否则用户点了下空角标, 反而触发一次 3~4 秒的同步重活。
 */
export async function flushPendingNow() {
  if (!scheduler.hasPending()) return { ok: true, skipped: true, results: [] }
  const r = await scheduler.flushNow()
  return { ok: true, ...r }
}

/** 排程器当前状态(渲染层拉倒计时 / 关窗前判据) */
export function autoState() {
  return scheduler.getState()
}

/** 是否还有"排程中/正在跑"的自动导出(退出前 flush 的判据) */
export function hasPendingAuto() {
  return scheduler.hasPending()
}

/** 等待"排程中的自动导出"跑完(测试与关窗前的收尾用) */
export function flushAuto(timeoutMs = 8000) {
  return scheduler.waitIdle(timeoutMs)
}
