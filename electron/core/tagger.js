/**
 * WD14 反推管道 —— 消费 tag_queue
 * ================================
 * 方案: docs/数据源合并与增量入库方案.md §二阶段 3。
 *
 * 分工
 * ====
 *   Python 侧 (`tools/tagger_serve.py`) —— 只负责"看图说话": 常驻内存、收路径、吐标签。
 *   本文件                          —— 进程管理 + 队列消费 + 写库。
 * 分开的理由: 模型 1.27GB, 每次重开进程要反复反序列化(冷启动 15-40s); 而队列、
 * 事务、崩溃重启这些事在 Node 侧做顺手得多。
 *
 * 准入闸门仍然是 **DB**(与 ingest.js 同一条原则)
 * ------------------------------------------------
 * 队列里躺的都是 ingest 判定过的"库里没有该路径标签 + 图内也没有元数据"的裸图
 * (规则 4)。所以这里**只消费 pending 行**, 不再挨个读 PNG 判一遍 ——
 * 那等于把 ingest 已经付过的代价再付一次。但仍然保留一道便宜的防御性复查:
 * 万一某个路径这会儿已经有标签了(并发场景), 跳过它而不是覆盖。
 *
 * 写库的铁律: **只写 `tags_src='wd14'`, 永远不覆盖 meta/legacy**
 * ------------------------------------------------------------
 * 图内原生提示词(meta)是作者留下的唯一一份, 反推结果没资格盖它;
 * 旧 txt 的 legacy 值同理。所以写入前先看这一行现在是什么来源 ——
 * 是 wd14 才允许覆盖(重反推场景), 其余一律跳过。
 *
 * 可降级(这是本阶段唯一的新外部依赖, 必须在最坏情况下不拖垮主流程)
 * -------------------------------------------------------------
 * 找不到 python / 缺 onnxruntime / 没有模型文件 → 返回 `degraded:true`,
 * 队列原样留着, 看板一切照常。用户机器上没装 CUDA 也没关系: 服务自己退到 CPU。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { openDb, rebuildTags } from './store.js'
import { sortTagString } from './tagcats.js'
import { dataFile, getSettings, getWorkspace } from './workspace.js'
import { PROJECT_ROOT } from './paths.js'
import { ensureQueueTable, queueStats } from './ingest.js'
import { flog } from './filelog.js'

/** 失败重试上限 —— 到顶就标 failed, 不再无限重来 */
const MAX_ATTEMPTS = 3
/** 每多少张落一次库 —— 不是每张一个事务(60 张就是 60 次 fsync), 也不是全程一个(中断全丢) */
const FLUSH_EVERY = 20
/** 单张反推超时。CPU 兜底时单张 ~2s, 但大图 + 首次预热可能到 60s, 留足余量 */
const DEFAULT_INFER_TIMEOUT = 180000
/** 握手(探活)超时: 导 onnxruntime 约 1-3s, 但冷启动 + 杀软扫描可能到 20s */
const READY_TIMEOUT = 45000
/** 同一次运行里最多重启几次服务 —— 超过就认为环境坏了, 停止整轮 */
const MAX_RESTARTS = 3

const MODEL_BASENAME = 'wd-pixai-tagger-v0.9'
const MODEL_FILE = `${MODEL_BASENAME}.onnx`
const CSV_FILE = `${MODEL_BASENAME}.csv`
// HuggingFace 仓库(deepghs/pixai-tagger-v0.9-onnx)里的**原始文件名** ——
// 下载后不改名直接丢进 models/ 也要认(见 assetCandidates, 2026-10-02)
const MODEL_FILE_ORIG = 'model.onnx'
const CSV_FILE_ORIG = 'selected_tags.csv'

/* ------------------------------------------------------------ 状态 */

export const taggerState = {
  phase: 'idle',       // idle | probe | infer | rebuild-tags | done | error | skipped
  note: '',
  done: 0,
  total: 0,
  provider: '',        // CUDAExecutionProvider / DmlExecutionProvider / CPUExecutionProvider
  python: '',
  degraded: false,
  reason: '',          // 降级原因(给人看的一句话)
  error: '',
  restarts: 0,
  paused: false,
  running: false,
  lastRunAt: 0,
  lastRunMs: 0,
  stats: null,
}

function emptyStats() {
  return {
    queued: 0,           // 进队时 pending 总数
    picked: 0,           // 本轮取出的条数
    tagged: 0,           // 成功反推并写库
    created: 0,          // 其中"新插入 images 行"的数量
    updated: 0,          // 其中"覆盖已有 wd14 标签"的数量
    skippedExisting: 0,  // 防御性跳过: 路径这会儿已有 legacy/未知来源标签
    noResult: 0,         // 反推跑通但一条标签都没过阈值
    missing: 0,          // 磁盘上已不存在
    failed: 0,           // 单张失败(仍会重试)
    inferCalls: 0,       // **真正发给模型的张数** —— 反向验收的关键指标
    loadMs: 0,           // 模型加载耗时(不含在总耗时里单说, 它就是最慢的一环)
    ms: 0,
  }
}

function emit(onProgress, patch) {
  Object.assign(taggerState, patch)
  try { onProgress?.({ ...taggerState }) } catch { /* 进度回调出错不影响反推 */ }
}

/* ------------------------------------------------------------ 路径解析 */

/** 返回第一个存在于磁盘的候选 */
function firstExisting(list) {
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) continue
    try { if (fs.existsSync(p)) return path.resolve(p) } catch { /* 忽略 */ }
  }
  return ''
}

/**
 * 把一行命令拆成 argv(支持双引号包住带空格的路径)。
 * 不是完整 shell 解析 —— 我们只需要处理"程序装在带空格的目录里"这一种情况,
 * 它用双引号包住路径就够, 不需要变量展开 / 管道 / 重定向那一整套。
 */
function splitCommand(line) {
  const out = []
  let cur = ''
  let q = false
  for (const ch of String(line || '')) {
    if (ch === '"') { q = !q; continue }
    if (!q && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 解释器候选 —— 每一项是 `{ bin, pre, label }`:
 *   bin  可执行文件
 *   pre  我们那条脚本**之前**的参数(python 用 ['-u'] 关缓冲; 自定义命令可能已有别的)
 *   label 报错时给人看的写法
 *
 * 有 `TV_TAGGER_CMD` / `opts.cmd` 时**整条命令自定义**, 不再走 python 探测。
 * 这不是为了测试方便才存在的口子: 换个运行时、套一层 venv 包装脚本、
 * 或者 python 装在非标准位置, 都靠它一句话解决。测试里也用它挂一个 Node 桩替身
 * (JSON-lines 协议与语言无关, 这正是当初把它定成"纯文本逐行 JSON"的收益)。
 */
function commandCandidates(opts = {}) {
  const custom = opts.cmd || process.env.TV_TAGGER_CMD
  if (typeof custom === 'string' && custom.trim()) {
    const parts = splitCommand(custom)
    if (parts.length) return [{ bin: parts[0], pre: parts.slice(1), label: custom.trim() }]
  }
  const out = [], seen = new Set()
  const push = (p) => {
    if (typeof p !== 'string' || !p.trim()) return
    const v = p.trim()
    if (seen.has(v)) return
    seen.add(v)
    out.push({ bin: v, pre: ['-u'], label: v })
  }
  push(opts.python)
  push(process.env.TV_PYTHON)
  try { push(getSettings().pythonPath) } catch { /* 命令行工具可能没 initWorkspace */ }
  // 嵌入式运行时的**固定候选位**(settings.json 丢了/没写上也能自愈 —— 2026-10-15
  // 远端实测: prep 没把 pythonPath 落盘, 装好的运行时就没被找到, 全部候选全灭)。
  try { push(path.join(getWorkspace().appDir, 'runtime', 'python', 'python.exe')) } catch { /* 忽略 */ }

  // 包内自带解释器(绿色包 v2.1.0 起随包发 python/, embeddable + onnxruntime-directml)。
  // 排在显式配置之后 —— 用户在设置里指了 python 就尊重用户; 排在系统常见位置之前 ——
  // 包里带了就用包里的, 免依赖开箱即用。开发仓库里没有 python/ 目录, 这条是 no-op。
  // **NSIS 安装包没有这条**: python/ 不打进 asar(asar 里的 exe 根本 spawn 不了,
  // 2026-10-15 实测"握手超时"全是它), 只在绿色包目录布局下才有意义。
  if (!PROJECT_ROOT.endsWith('.asar')) {
    push(path.join(PROJECT_ROOT, 'python', 'python.exe'))
  }

  const home = process.env.USERPROFILE || process.env.HOME || ''
  // ProgramData 不写字面盘符 —— preflight 有一条"仓库里不许出现盘符绝对路径"的检查
  // (开源后它们指向别人的机器)。SystemDrive 是 Windows 自己给的环境变量(通常 C:)。
  const prog = process.env.ProgramData
    || (process.env.SystemDrive ? path.join(process.env.SystemDrive + path.sep, 'ProgramData') : '')
  const local = process.env.LOCALAPPDATA || ''
  if (home) {
    push(path.join(home, 'miniconda3', 'python.exe'))
    push(path.join(home, 'anaconda3', 'python.exe'))
  }
  if (prog) {
    push(path.join(prog, 'miniconda3', 'python.exe'))
    push(path.join(prog, 'anaconda3', 'python.exe'))
  }
  if (local) push(path.join(local, 'Programs', 'Python', 'Python313', 'python.exe'))

  push('python')
  push('py')
  return out
}

/** 模型 / 标签表候选。显式 > 环境变量 > 仓库内 models/ > 数据目录 models/。
 *  每个目录里**改名版与原始版都认**(原始版排后 —— 两种名字同时存在时, 认改名版)。 */
function assetCandidates(kind, opts = {}) {
  const file = kind === 'model' ? MODEL_FILE : CSV_FILE
  const orig = kind === 'model' ? MODEL_FILE_ORIG : CSV_FILE_ORIG
  const envKey = kind === 'model' ? 'TV_WD14_MODEL' : 'TV_WD14_CSV'
  const setKey = kind === 'model' ? 'wd14Model' : 'wd14Csv'
  const out = []
  const push = (p) => { if (typeof p === 'string' && p.trim()) out.push(String(p).trim()) }
  push(opts[kind])
  push(process.env[envKey])
  try { push(getSettings()[setKey]) } catch { /* 忽略 */ }
  const oldRoot = process.env.TV_OLD_ROOT
  if (oldRoot) push(path.join(oldRoot, 'model', file))
  push(path.join(PROJECT_ROOT, 'models', file))
  push(path.join(PROJECT_ROOT, 'models', orig))
  if (dataFile) {
    try {
      const dir = path.dirname(dataFile('tags.db'))
      push(path.join(dir, 'models', file))
      push(path.join(dir, 'models', orig))
    } catch { /* 忽略 */ }
  }
  return out
}

/**
 * 解析出本轮要用的配置。返回 `{ candidates, script, ... }` ——
 * **python 与模型都可能是一串候选**, 真正的挑选在 probeService() 里做
 * (只有把服务真拉起来、收到 ready 才知道这一组能不能用)。
 */
export function resolveTagger(opts = {}) {
  const script = firstExisting([
    opts.script,
    process.env.TV_TAGGER_SCRIPT,
    path.join(PROJECT_ROOT, 'tools', 'tagger_serve.py'),
  ])
  return {
    script,
    cmds: commandCandidates(opts),
    models: assetCandidates('model', opts),
    csvs: assetCandidates('csv', opts),
    provider: opts.provider || process.env.TV_TAGGER_PROVIDER || 'auto',
    threshold: Number(opts.threshold ?? process.env.TV_WD14_THRESHOLD ?? 0.35),
    charThreshold: Number(opts.charThreshold ?? process.env.TV_WD14_CHAR_THRESHOLD ?? 0.85),
    inferTimeout: Number(opts.inferTimeout ?? process.env.TV_TAGGER_TIMEOUT ?? DEFAULT_INFER_TIMEOUT),
  }
}

/** 供 UI / CLI 展示的"当前配置长什么样" */
export function taggerConfig(opts = {}) {
  const c = resolveTagger(opts)
  const model = firstExisting(c.models)
  const csv = firstExisting(c.csvs)
  // 解释器: 优先报"磁盘上真的存在"的那一个(conda 常规位置 / 用户指定),
  // 都不存在时退到 PATH 上的兜底名(python / py) —— 那个没法静态验证,
  // 所以另给一个 `pythonOnDisk` 让界面说实话。
  const onDisk = c.cmds.find((x) => /[\\/]/.test(x.bin) && firstExisting([x.bin]))
  const first = onDisk || c.cmds[0] || null
  return {
    script: c.script,
    scriptExists: !!c.script,
    python: first ? first.label : '',
    pythonOnDisk: !!onDisk,
    pythons: c.cmds.map((x) => x.label),
    model,
    csv,
    modelExists: !!model,
    csvExists: !!csv,
    provider: c.provider,
    // 静态能判定的三样: 服务脚本 + 模型 + 标签表。
    // **解释器刻意不算进来**: PATH 上那个 python 可能是 Windows 商店的占位程序
    // (本机就有), 静态看它"存在", 真跑起来连 onnxruntime 都导不进来。
    // 只有真拉起来、收到 ready 才知道这一组能不能用 —— 那是 probe 的活。
    available: !!(c.script && model && csv),
  }
}

/* ------------------------------------------------------------ 子进程 */

let proc = null
let seq = 0
const pending = new Map()      // id -> {resolve, reject, timer}
let buf = ''
let readyInfo = null           // 最近一次 ready 事件
let readyWaiters = []          // 等 ready 的 resolve 队列
let activeConfig = null
const logTail = []             // 子进程 stderr 的尾部若干行, 出错时回给人看

function pushTail(line) {
  const s = String(line || '').trim()
  if (!s) return
  logTail.push(s)
  if (logTail.length > 12) logTail.shift()
  // 落盘: 服务 stderr 是远端排障的唯一线索 —— UI 只显示最后一行,
  // 不写文件的话"另一台机器上 code=101 到底为什么"就永远查不了(2026-10-15 实测)。
  try { flog('tagger', `stderr: ${s}`) } catch { /* 忽略 */ }
}

function handleLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { pushTail(line); return }
  if (msg.event === 'ready') {
    readyInfo = msg
    const w = readyWaiters
    readyWaiters = []
    for (const r of w) r(msg)
    return
  }
  if (msg.event === 'loaded') {
    pushTail(`模型已加载 ${msg.ms}ms (provider=${msg.provider || '?'})`)
    if (msg.provider) taggerState.provider = msg.provider
    return
  }
  const id = msg.id
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  p.resolve(msg)
}

function attach(child) {
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    // 陈旧子进程的输出一律丢弃 —— 见下面 exit 处理里的同一段理由
    if (proc !== child) return
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) handleLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (proc !== child) return
    for (const l of String(chunk).split('\n')) pushTail(l)
  })
  child.on('error', (e) => {
    child.__spawnError = e?.message || String(e)   // 供 tried 信息区分"文件不存在"和"握手超时"
    if (proc === child) failAll(`反推服务启动失败: ${e.message}`)
  })
  /**
   * 所有清理动作都先判断 `proc === child`。
   *
   * 为什么必须判断: stopTagger() 只是发个 quit 并安排 800ms 后强杀, **不阻塞**;
   * 上层拿到控制权后可能立刻用新参数再拉一个服务。如果这时旧进程才退出,
   * 它的 exit 处理器会把刚建好的新进程的 proc 置空、把新请求全部 fail 掉 ——
   * 表现为"重启之后第一张图莫名报'服务已退出'"。用身份判断把陈旧的退出隔离掉。
   */
  child.on('exit', (code, signal) => {
    const stale = proc !== child
    const wasStopped = !!child.__stopped
    child.__exitCode = code   // 握手期硬崩的判据(startService 里据此退到 CPU 重试)
    if (!stale) {
      proc = null
      readyInfo = null
      failAll(`反推服务已退出(code=${code} signal=${signal || '-'})`)
    }
    if (!stale && !wasStopped) {
      pushTail(`服务异常退出 code=${code}`)
      flog('tagger', `服务异常退出 code=${code} signal=${signal}`)
    }
  })
}

function failAll(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.resolve({ ok: false, error: reason, __transport: true })
  }
  pending.clear()
  const w = readyWaiters
  readyWaiters = []
  for (const r of w) r(null)
}

function waitReady(timeoutMs) {
  if (readyInfo) return Promise.resolve(readyInfo)
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(null) } }, timeoutMs)
    readyWaiters.push((m) => { if (!done) { done = true; clearTimeout(t); resolve(m) } })
  })
}

/**
 * 拉起服务并等握手。**会依次尝试 (python, 模型) 的组合**:
 * 第一个能给出 `ready ok:true` 且模型/标签表都在的组合胜出。
 * 这样"PATH 上的 python 是商店占位程序""模型还没下载"这类情况都能自动越过。
 */
export async function startService(opts = {}, onLog) {
  const cfg = resolveTagger(opts)
  const model = firstExisting(cfg.models)
  const csv = firstExisting(cfg.csvs)
  const tried = []

  if (!cfg.script) {
    return { ok: false, reason: `找不到反推服务脚本(tools/tagger_serve.py)`, tried, cfg }
  }
  if (!model) {
    return { ok: false, reason: `找不到 WD14 模型(${MODEL_FILE})，请放到 <仓库>/models/ 或用 TV_WD14_MODEL 指定`, tried, cfg }
  }
  if (!csv) {
    return { ok: false, reason: `找不到标签表(${CSV_FILE})，请放到 <仓库>/models/ 或用 TV_WD14_CSV 指定`, tried, cfg }
  }

  for (const c of cfg.cmds) {
    const py = c.bin
    // 握手期硬崩(auto/DML 下 DirectML 设备初始化能直接把进程带走, python 侧
    // 的 except 兜不住)就退到 CPU 再试一次 —— 慢但能用, 好过永远 0%(2026-10-15 远端实测)。
    const providerAttempts = cfg.provider === 'cpu' ? ['cpu'] : [cfg.provider, 'cpu']
    for (const prov of providerAttempts) {
    buf = ''
    readyInfo = null
    logTail.length = 0
    const args = [...c.pre, cfg.script,
      '--model', model, '--csv', csv,
      '--provider', prov,
      '--threshold', String(cfg.threshold),
      '--char-threshold', String(cfg.charThreshold)]
    let child
    try {
      child = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      tried.push(`${c.label}: 启动失败 ${e.message}`)
      break
    }
    proc = child
    attach(child)
    const t0 = Date.now()
    const info = await waitReady(READY_TIMEOUT)
    if (!info) {
      const crashed = child.__exitCode != null && child.__exitCode !== 0
      // 三种失败分开报: spawn 失败(路径不存在/被占用) / 进程异常退出 / 真超时 ——
      // 此前全是"握手超时或无输出", 排障时根本分不清(2026-10-15 远端实测)
      const why = child.__spawnError ? `启动失败: ${child.__spawnError}`
        : crashed ? `进程异常退出(code=${child.__exitCode})` : '握手超时或无输出'
      tried.push(`${c.label}[${prov}]: ${why}${logTail.length ? ` (${logTail[logTail.length - 1]})` : ''}`)
      try { child.kill() } catch { /* 忽略 */ }
      proc = null
      // 没握手就崩了(不是超时挂着)且当前不是 CPU -> 换 CPU 再试; 否则下一个候选
      if (crashed && prov !== 'cpu') continue
      break
    }
    if (!info.ok) {
      tried.push(`${c.label}[${prov}]: ${info.error || '依赖不可用'}`)
      try { child.kill() } catch { /* 忽略 */ }
      proc = null
      continue
    }
    const provider = (info.providers || []).includes('CUDAExecutionProvider') && prov !== 'cpu'
      ? 'CUDAExecutionProvider' : 'CPUExecutionProvider'
    activeConfig = cfg
    flog('tagger', `服务已就绪 ${c.label} provider=${info.providers?.join('/') || '?'} 握手 ${Date.now() - t0}ms`)
    onLog?.(`反推服务已就绪(${c.label}, 握手 ${Date.now() - t0}ms)`)
    return { ok: true, python: py, model, csv, provider, providers: info.providers || [], tried, cfg }
    }
  }

  flog('tagger', `没有可用的反推解释器: ${JSON.stringify(tried)}`)
  return { ok: false, reason: tried.length ? tried[tried.length - 1] : '没有可用的 python', tried, cfg }
}

/** 已就绪的话直接用; 没起来就拉。**服务崩了这里会自动重启** */
async function ensureService(opts = {}) {
  if (proc && !proc.killed && readyInfo && readyInfo.ok) {
    return { ok: true, provider: taggerState.provider || readyInfo.providers?.[0] || '', python: taggerState.python }
  }
  if (proc) { try { proc.kill() } catch { /* 忽略 */ } ; proc = null }
  const r = await startService(opts)
  if (r.ok) {
    taggerState.provider = r.provider
    taggerState.python = r.python
  }
  return r
}

/**
 * 发一条请求。带超时 —— 没有超时的话, 一张损坏的图能让整轮永远挂住。
 */
function request(cmd, payload = {}, timeoutMs = DEFAULT_INFER_TIMEOUT) {
  if (!proc || proc.killed) return Promise.resolve({ ok: false, error: '反推服务未运行', __transport: true })
  const id = ++seq
  const line = JSON.stringify({ id, cmd, ...payload }) + '\n'
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: `请求超时(${timeoutMs}ms)`, __transport: true })
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    try { proc.stdin.write(line) } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      resolve({ ok: false, error: `写入失败: ${e.message}`, __transport: true })
    }
  })
}

/** 探活(不加载模型), 给状态接口和"能不能反推"的判断用 */
export async function probeTagger(opts = {}) {
  const r = await ensureService(opts)
  if (!r.ok) return { ok: false, reason: r.reason, tried: r.tried }
  const p = await request('probe', {}, 20000)
  return { ok: !!p.ok, python: r.python, model: r.model, csv: r.csv, provider: r.provider, providers: p.providers || r.providers }
}

/**
 * 收掉服务。**立即摘除引用, 不等子进程真的退出** ——
 * 调用方(测试 / 换参数重启 / 退出 App)拿回控制权后往往会马上再拉一个,
 * 若这里还把 proc 挂着, 新的一次 ensureService 会误判"服务还活着"而复用旧参数。
 */
export function stopTagger() {
  const p = proc
  proc = null
  readyInfo = null
  buf = ''
  failAll('反推服务已停止')
  if (!p) return
  p.__stopped = true
  try { p.stdin.write(JSON.stringify({ id: ++seq, cmd: 'quit' }) + '\n') } catch { /* 忽略 */ }
  // 优雅退出不给面子就强杀 —— 放走一个常驻 1.27GB 模型的孤儿进程比杀错更糟
  setTimeout(() => { try { if (!p.killed) p.kill() } catch { /* 忽略 */ } }, 800).unref?.()
}

/* ------------------------------------------------------------ 队列消费 */

/**
 * 标签合并 —— meta 部分在前、WD14 新增在后, 逗号分隔去重(大小写不敏感,
 * 保留先出现的大小写写法)。并集操作天然幂等: 同一张图反复合并结果稳定。
 */
function mergeTagStrings(cur, add) {
  const seen = new Set()
  const out = []
  for (const raw of `${cur},${add}`.split(',')) {
    const s = raw.trim()
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out.join(',')
}

/**
 * 写一条反推结果。
 *
 * 三件事按顺序: ①防御性复查 ②写 images ③结清队列。
 * 写回语义(2026-10-02 起, 用户拍板的合并方案):
 *   · tags_src='wd14'        -> 直接覆盖(反推结果可以刷新反推结果)
 *   · tags_src='meta'/'meta+wd14' -> **合并**(meta 部分永不丢, 来源标变 'meta+wd14')
 *   · legacy / 未知来源      -> 一律让路(skipped) —— 老手工导入的标签是孤本
 *
 * @returns {'created'|'updated'|'skipped'}
 */
function applyTags(db, row, tags, mtimeMs, size, now) {
  const p = row.path
  const cur = db.prepare('SELECT id, tags, tags_src FROM images WHERE path = ? ORDER BY id LIMIT 1').get(p)
  if (cur) {
    const src = String(cur.tags_src || '')
    const curTags = String(cur.tags || '')
    const hasTags = curTags.trim().length > 0
    if (hasTags && src !== 'wd14' && src !== 'meta' && src !== 'meta+wd14') return 'skipped'
    const nextTags = sortTagString(hasTags && src !== 'wd14' ? mergeTagStrings(curTags, tags) : tags)
    const nextSrc = hasTags && src !== 'wd14' ? 'meta+wd14' : 'wd14'
    db.prepare(`UPDATE images SET tags = ?, tags_src = ?, mtime_ms = ?, size = ?,
                gone = 0, tagged_at = ? WHERE id = ?`)
      .run(nextTags, nextSrc, mtimeMs, size, now, cur.id)
    return 'updated'
  }
  const srcId = Number(row.src_id) || 0
  db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone, tagged_at)
              VALUES (?, ?, ?, ?, ?, ?, 'wd14', 0, ?)`)
    .run(p, srcId, sortTagString(tags), Number(row.folder_id) || 0, mtimeMs, size, now)
  return 'created'
}

function setQueueState(db, p, state, attempts, note) {
  db.prepare('UPDATE tag_queue SET state = ?, attempts = ?, last_try = ?, note = ? WHERE path = ?')
    .run(state, attempts, Date.now(), String(note || ''), p)
}

/**
 * 跑一轮反推。
 *
 * @param {{onProgress?:(s:object)=>void, limit?:number, python?:string,
 *          model?:string, csv?:string, provider?:string}} opts
 * @returns {Promise<object>} stats
 */
export async function runTagger({ onProgress, limit = 0, onlyFolderId = 0, ...svcOpts } = {}) {
  if (taggerState.running) return { skipped: true, reason: 'busy' }
  taggerState.running = true
  taggerState.paused = false
  taggerState.degraded = false
  taggerState.reason = ''
  taggerState.error = ''
  taggerState.restarts = 0
  const t0 = Date.now()
  const stats = emptyStats()
  let restarts = 0

  try {
    const db = openDb()
    ensureQueueTable(db)

    const q0 = queueStats(db)
    stats.queued = q0.pending
    if (!q0.pending) {
      emit(onProgress, { phase: 'done', note: '没有待反推的图', stats, done: 1, total: 1 })
      taggerState.lastRunAt = Date.now()
      taggerState.lastRunMs = 0
      return stats
    }

    emit(onProgress, { phase: 'probe', note: '正在探测反推环境 ...', done: 0, total: 0, stats })
    const probe = await probeTagger(svcOpts)
    if (!probe.ok) {
      stats.degraded = true
      stats.reason = probe.reason || '反推环境不可用'
      stats.ms = Date.now() - t0
      emit(onProgress, {
        phase: 'done', degraded: true, reason: probe.reason,
        note: `反推不可用(${probe.reason})，${q0.pending} 张裸图留在队列里，看板照常可用`,
        stats, done: 1, total: 1,
      })
      flog('tagger', `降级: ${probe.reason}`)
      taggerState.lastRunAt = Date.now()
      taggerState.lastRunMs = stats.ms
      return stats
    }
    stats.provider = probe.provider
    emit(onProgress, {
      phase: 'infer', provider: probe.provider, python: probe.python,
      note: `开始反推(provider=${probe.provider})`, done: 0, total: 0, stats,
    })

    /* 只跑某个来源(来源管理页「⚡ 反推」): 加 folder_id 过滤。
     * 队列里压着别的来源的图时, 用户只想先看到这一个来源出标签 —— 不能让他等全库。 */
    const sql = onlyFolderId
      ? `SELECT path, folder_id, src_id, size, mtime_ms, attempts FROM tag_queue
                 WHERE state = 'pending' AND folder_id = ? ORDER BY added_at, path`
      : `SELECT path, folder_id, src_id, size, mtime_ms, attempts FROM tag_queue
                 WHERE state = 'pending' ORDER BY added_at, path`
    const all = onlyFolderId ? db.prepare(sql).all(onlyFolderId) : db.prepare(sql).all()
    const rows = limit > 0 ? all.slice(0, limit) : all
    stats.picked = rows.length
    emit(onProgress, { phase: 'infer', total: rows.length, done: 0, note: `反推 ${rows.length} 张` })

    const loadStart = Date.now()
    let firstDone = true
    let batch = []
    let flushedAny = false

    const flush = () => {
      if (!batch.length) return
      db.exec('BEGIN')
      try {
        for (const b of batch) {
          if (b.kind === 'tag') {
            b.result = applyTags(db, b.row, b.tags, b.mtime, b.size, b.now)
            if (b.result === 'created') stats.created++
            else if (b.result === 'updated') stats.updated++
            else stats.skippedExisting++
            setQueueState(db, b.row.path, 'done', b.attempts, '')
          } else if (b.kind === 'noresult') {
            // 跑通了但一条都没过阈值。**不能留 pending** —— 否则每次同步都会重新读这张图、
            // 再重新反推一遍, 永远循环。标 done 且不写 images(不制造空标签行)。
            setQueueState(db, b.row.path, 'done', b.attempts, '反推无结果')
          } else if (b.kind === 'missing') {
            setQueueState(db, b.row.path, 'failed', b.attempts, '磁盘上已不存在')
          } else if (b.kind === 'skip') {
            stats.skippedExisting++
            setQueueState(db, b.row.path, 'done', b.attempts, b.note)
          } else if (b.kind === 'fail') {
            const next = b.attempts + 1
            setQueueState(db, b.row.path, next >= MAX_ATTEMPTS ? 'failed' : 'pending', next, b.note)
          }
        }
        db.exec('COMMIT')
        flushedAny = true
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
        throw e
      } finally {
        batch = []
      }
    }

    for (let i = 0; i < rows.length; i++) {
      if (taggerState.paused) {
        emit(onProgress, { phase: 'infer', note: '已被暂停' })
        break
      }
      const row = rows[i]
      const base = path.basename(row.path)

      // ---- 防御性复查: legacy/未知来源的已有标签不碰(孤本); meta/meta+wd14/wd14
      //      都放行 —— wd14 覆盖, meta 与 meta+wd14 走合并(applyTags 里分流)。
      //      并发场景下队列里可能躺着一张"这会儿刚被别的路子打上 legacy 标签"的图。
      const cur = db.prepare('SELECT tags, tags_src FROM images WHERE path = ? ORDER BY id LIMIT 1').get(row.path)
      const curSrc = String(cur?.tags_src || '')
      if (cur && String(cur.tags || '').trim() && curSrc !== 'wd14' && curSrc !== 'meta' && curSrc !== 'meta+wd14') {
        batch.push({ kind: 'skip', row, attempts: Number(row.attempts) || 0, note: '已有标签, 跳过' })
        continue
      }
      if (!fs.existsSync(row.path)) {
        stats.missing++
        batch.push({ kind: 'missing', row, attempts: Number(row.attempts) || 0 })
        continue
      }

      stats.inferCalls++
      let res = await request('infer', { path: row.path }, activeConfig?.inferTimeout)

      // ---- 传输层失败(进程死了/超时) -> 重启一次再试, 只有一次 ----
      if (!res.ok && res.__transport) {
        pushTail(`传输失败: ${res.error}`)
        if (restarts < MAX_RESTARTS) {
          restarts++
          taggerState.restarts = restarts
          emit(onProgress, { phase: 'probe', note: `反推服务掉线, 正在重启(${restarts}/${MAX_RESTARTS}) ...` })
          const re = await ensureService(svcOpts)
          if (re.ok) {
            res = await request('infer', { path: row.path }, activeConfig?.inferTimeout)
          } else {
            res = { ok: false, error: `重启失败: ${re.reason}` }
          }
        }
        if (!res.ok && res.__transport) {
          // 重启也救不回来 -> 整轮停, 别把队列里每张图都拖一遍超时
          stats.failed++
          batch.push({ kind: 'fail', row, attempts: Number(row.attempts) || 0, note: String(res.error || '') })
          flush()
          stats.ms = Date.now() - t0
          emit(onProgress, {
            phase: 'error',
            note: `反推服务不稳定, 已中止本轮(${res.error})。已完成的 ${stats.tagged} 张已入库`,
            error: String(res.error || ''), stats,
          })
          taggerState.lastRunAt = Date.now()
          taggerState.lastRunMs = stats.ms
          return stats
        }
      }

      if (firstDone) {
        stats.loadMs = Math.max(0, Date.now() - loadStart)
        firstDone = false
      }
      // 服务在第一次 infer 时才会真正加载模型, 所以**实际 provider** 要以这里的回执为准。
      // 握手阶段那个是"可用列表", CUDA 可能因驱动/CUDA 版本不匹配而初始化失败退到 CPU。
      if (res.provider && res.provider !== stats.provider) {
        stats.provider = res.provider
        taggerState.provider = res.provider
      }

      if (!res.ok) {
        stats.failed++
        batch.push({ kind: 'fail', row, attempts: Number(row.attempts) || 0, note: String(res.error || '未知错误').slice(0, 200) })
      } else if (!res.tags || !res.tags.length) {
        stats.noResult++
        batch.push({ kind: 'noresult', row, attempts: Number(row.attempts) || 0 })
      } else {
        let st = null
        try { st = fs.statSync(row.path) } catch { st = null }
        const now = Date.now()
        batch.push({
          kind: 'tag', row, tags: res.tags.join(','), attempts: Number(row.attempts) || 0,
          mtime: st ? Math.round(st.mtimeMs) : (Number(row.mtime_ms) || 0),
          size: st ? st.size : (Number(row.size) || 0),
          now,
        })
        stats.tagged++
      }

      if (batch.length >= FLUSH_EVERY) flush()
      emit(onProgress, {
        phase: 'infer', done: i + 1, total: rows.length,
        note: `${i + 1}/${rows.length}  ${base}${res.ok && res.tags ? `  → ${res.tags.length} 个标签` : ''}`,
      })
    }

    flush()

    if (flushedAny && stats.tagged) {
      emit(onProgress, { phase: 'rebuild-tags', note: '重建标签字典 ...' })
      rebuildTags()
    }

    stats.ms = Date.now() - t0
    const parts = [
      `反推成功 ${stats.tagged}`,
      stats.updated ? `合并/覆盖 ${stats.updated}` : '',
      stats.noResult ? `无结果 ${stats.noResult}` : '',
      stats.skippedExisting ? `已有标签跳过 ${stats.skippedExisting}` : '',
      stats.missing ? `磁盘已无 ${stats.missing}` : '',
      stats.failed ? `失败 ${stats.failed}` : '',
      `模型加载 ${stats.loadMs}ms`,
    ].filter(Boolean)
    emit(onProgress, {
      phase: 'done', done: 1, total: 1, stats,
      note: `反推完成: ${parts.join(' · ')}（共 ${stats.ms}ms, provider=${stats.provider}）`,
    })
    flog('tagger', `完成 ${JSON.stringify(stats)}`)
    taggerState.lastRunAt = Date.now()
    taggerState.lastRunMs = stats.ms
    return stats
  } catch (e) {
    stats.ms = Date.now() - t0
    emit(onProgress, { phase: 'error', error: e?.message || String(e), note: `反推失败: ${e?.message || e}`, stats })
    flog('tagger-err', `${e?.stack || e}`)
    taggerState.lastRunAt = Date.now()
    taggerState.lastRunMs = stats.ms
    return { ...stats, error: e?.message || String(e) }
  } finally {
    taggerState.running = false
  }
}

/* ------------------------------------------------------------ 对外控制 */

export function taggerStatus() {
  let queue = { pending: 0, failed: 0, done: 0, total: 0 }
  try { queue = queueStats() } catch { /* 库还没建好 */ }
  const cfg = taggerConfig()
  // 「自己的 python」= 嵌入式运行时或 settings.pythonPath 在磁盘上(与 main.js
  // ensureRuntimeFlow 的 ownPython 同判)。裸 conda 不算 —— 它验证不了 onnxruntime
  // 能不能 import, 渲染层据此判定首启要不要进环境下载面板(2026-10-15 远端实测:
  // 只看 degraded 会在反推没跑过之前漏报, 选完文件夹直接卡死等打标)。
  let pythonOwned = false
  try {
    const appDir = getWorkspace().appDir
    pythonOwned = [path.join(appDir, 'runtime', 'python', 'python.exe'), getSettings().pythonPath]
      .some((p) => { try { return !!p && fs.existsSync(p) } catch { return false } })
  } catch { /* workspace 还没起来就当没有 */ }
  return {
    ...taggerState,
    queue,
    config: {
      python: cfg.python || '',
      pythonOnDisk: cfg.pythonOnDisk,
      pythonOwned,
      script: cfg.script || '',
      model: cfg.model || '',
      csv: cfg.csv || '',
      // "静态看着能不能反推"(不拉起进程)。真跑一轮时还会再探一次, 那里才是权威。
      available: cfg.available,
      missing: [
        !cfg.scriptExists ? '反推服务脚本' : '',
        !cfg.modelExists ? 'WD14 模型' : '',
        !cfg.csvExists ? '标签表' : '',
      ].filter(Boolean),
    },
  }
}

export function pauseTagger() {
  if (!taggerState.running) return { ok: false, error: '当前没有在跑的反推' }
  taggerState.paused = true
  return { ok: true }
}
