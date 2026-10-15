/**
 * Electron 主进程入口
 * ===================
 * 启动顺序(顺序有讲究):
 *   1. registerSchemesAsPrivileged  —— 必须在 app ready **之前**, 否则 tv:// 拿不到 standard/secure 特权
 *   2. app.whenReady
 *   3. initWorkspace(userData)      —— 读出 dataDir(默认指向原 Python 版目录, 共享黑名单/元数据/缩略图缓存)
 *   4. 创建窗口并加载页面
 *   5. registerHandler / registerIpc
 *   6. **等页面 did-finish-load 之后**再开始加载数据集 ——
 *      解析 88MB 标签文件会占满主进程事件循环, 先让它同步干完会导致窗口空白几秒;
 *      放到窗口渲染出来之后再跑, 用户至少能看到加载界面和实时进度。
 */
import { app, BrowserWindow, Menu, shell, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { registerScheme, registerHandler } from './imageproto.js'
import { registerIpc } from './ipc.js'
import { initWorkspace, getWorkspace, getSettings, applyTaggerEnv } from './core/workspace.js'
import { resolveLogDir, setLogDir, logFile, readyFlag } from './core/paths.js'
import { bootstrap, status } from './core/app-state.js'
import { runIngest, queueStats, backfillMetaQueue } from './core/ingest.js'
import { runTagger, stopTagger, taggerState, taggerConfig } from './core/tagger.js'
import { ds } from './core/dataset.js'
import { flushPendingNow, hasPendingAuto } from './core/exportPresets.js'
import { flushCartPendingNow, hasPendingCart } from './core/cartPreset.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''
const isDev = !!DEV_URL

/* ---- 检查更新(Gitee Release 分片) ----
 * updater.cjs 是从 electron-wallpaper 项目原样移植的已验证实现(逐行同源,
 * 只改了仓库常量): 切片下载 + SHA256 校验 + 合并 + 跑安装包, 断点续传。
 * 清单由 tools/prepare-update.cjs 生成、随 Release 附件上传。
 * 仅打包态启用: 开发态/绿色包不检查(绿色包用户看 README 自己换新包)。
 * 进度走现有 app:toast 通道, 不动渲染层。
 */
let updater = null
let lastProgressToast = 0

function toast(text, tone = 'info', dur = 3000) {
  if (win && !win.isDestroyed()) win.webContents.send('app:toast', { text, tone, dur })
}

function setupUpdater() {
  if (!app.isPackaged || isDev) return
  // 反推服务脚本: asar 里的路径 python 进程读不了, extraResources 里那份才是真的。
  // tagger.js 的脚本候选里 TV_TAGGER_SCRIPT 排第一, 这里注入即可, 不动 core。
  const serveScript = path.join(process.resourcesPath, 'tools', 'tagger_serve.py')
  if (fs.existsSync(serveScript)) process.env.TV_TAGGER_SCRIPT = serveScript
  const { UpdateService } = require('./updater.cjs')
  updater = new UpdateService({
    currentVersion: app.getVersion(),
    updatesDir: path.join(app.getPath('userData'), 'updates'),
    spawnInstaller: (installerPath, args) => {
      const child = spawn(installerPath, args, { detached: true, stdio: 'ignore' })
      child.unref()
    },
    onState: (snap) => {
      // 下载进度按 20% 节流提示, 避免刷屏; 完成由手动流程的弹窗负责
      if (snap.status === 'downloading' && snap.percent - lastProgressToast >= 20) {
        lastProgressToast = snap.percent
        toast(`正在下载更新… ${snap.percent}%`, 'info', 2500)
      }
    },
  })
  updater.cleanupOld().catch(() => {})
  // 启动静默检查一次, 有更新只弹一条 toast, 不打断看图
  updater.check().then((snap) => {
    if (snap.status === 'available') {
      toast(`发现新版本 v${snap.latestVersion}，菜单「帮助 → 检查更新…」可升级`, 'info', 6000)
    }
  }).catch(() => {})
}

/* ---- 反推环境按需引导（Python / WD14 模型, 打包版首次安装） ----
 * 安装包刻意精简: 两样都不进包。应用启动后探测(taggerConfig 静态判定 + runtime-setup
 * 真跑 --version), 缺什么引导下什么 —— 更新/重装时环境都在, 弹窗都不会出现, 天然区分。
 * python 装好后: TV_PYTHON 注入本次会话 + settings.json 落 pythonPath 供以后会话。
 * 模型从 hf-mirror 直拉(断点续传+SHA256 锚点), 落数据目录 models/(tagger 候选认原名)。
 * 支持安装器或快捷方式带 --download-model 直进下载(跳过确认弹窗)。
 */
let runtimeOfferSkipped = false
let runtimeBusy = false

function patchSettings(patch) {
  const p = path.join(app.getPath('userData'), 'settings.json')
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 首次没有 */ }
  if (!cur || typeof cur !== 'object') cur = {}
  try { fs.writeFileSync(p, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`, 'utf8') } catch { /* 只读等异常场景忽略 */ }
}

async function ensureRuntimeFlow({ force = false } = {}) {
  if (!app.isPackaged || isDev || runtimeBusy) return
  if (!force && runtimeOfferSkipped) return
  const cfg = taggerConfig()
  const needPython = !cfg.pythonOnDisk
  // "存在"≠"有效": 旧构建可能把上游变列序的 597KB csv 下到了固定文件名。
  // 这里用 modelIntegrityIssue(csv 体积+SHA / onnx 体积)兜住, 坏文件进下载分支被挪走重下。
  let needModel = !(cfg.modelExists && cfg.csvExists)
  if (!needModel) {
    const why = await require('./runtime-setup.cjs').modelIntegrityIssue(cfg.model, cfg.csv)
    if (why) { log('warn', `模型文件校验不通过: ${why}, 进入重新下载分支`); needModel = true }
  }
  if (!needPython && !needModel) return

  if (!force) {
    const missing = [
      needPython ? 'Python 运行时（嵌入式版 + 反推依赖包，约 150MB）' : '',
      needModel ? `WD14 反推模型（${(1271365854 / 1048576 / 1024).toFixed(2)}GB，从 hf-mirror 下载，支持断点续传）` : '',
    ].filter(Boolean)
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: '反推环境', buttons: ['现在下载', '暂不'], defaultId: 0, cancelId: 1,
      message: 'WD14 反推环境未就绪',
      detail: `还差:\n  · ${missing.join('\n  · ')}\n\n现在下载吗? 也可以以后在扫描页看「看看怎么装」手动配置。`,
    })
    if (response !== 0) { runtimeOfferSkipped = true; return }
  }

  runtimeBusy = true
  try {
    const { ensurePythonRuntime, ensureModel } = require('./runtime-setup.cjs')
    if (needPython) {
      const res = await ensurePythonRuntime({
        destDir: path.join(app.getPath('userData'), 'runtime'),
        candidates: cfg.pythons,
        onStage: (s) => toast(s, 'info', 5000),
      })
      process.env.TV_PYTHON = res.exe
      patchSettings({ pythonPath: res.exe })
      toast(`Python 就绪: ${res.exe}`, 'info', 4000)
    }
    if (needModel) {
      const ws = getWorkspace()
      let lastPct = 0
      const res = await ensureModel({
        destDir: path.join(ws.dataDir, 'models'),
        existsCheck: () => ({ modelPath: cfg.modelExists ? cfg.model : null, csvPath: cfg.csvExists ? cfg.csv : null }),
        onStage: (s) => toast(s, 'info', 5000),
        onProgress: (name, bytes) => {
          const size = name.endsWith('.csv') ? 401399 : 1271365854
          const pct = Math.min(100, Math.floor((bytes * 100) / size))
          if (pct >= lastPct + 10) { lastPct = pct; toast(`正在下载 ${name}… ${pct}%`, 'info', 2500) }
        },
      })
      toast(`WD14 模型就绪: ${res.modelPath}`, 'info', 5000)
    }
    dialog.showMessageBox(win, {
      type: 'info', title: '反推环境',
      message: '反推环境配置完成。',
      detail: '新下载的模型/解释器从下次反推起生效; 正在跑的扫描页刷新一下即可看到状态更新。',
    })
  } catch (e) {
    log('warn', `反推环境引导失败: ${e?.stack || e}`)
    dialog.showMessageBox(win, {
      type: 'warning', title: '反推环境', message: '环境下载未完成',
      detail: `${e?.message || e}\n\n可稍后重试(重新打开应用会再次询问), 或按 docs/新手上手.md 手动配置。`,
    })
  } finally {
    runtimeBusy = false
  }
}

/** 手动「检查更新…」: 检查 → 确认下载 → 确认安装, 全程主进程弹窗 */async function checkForUpdateManually() {
  if (!updater) {
    dialog.showMessageBox(win, {
      type: 'info', title: '检查更新',
      message: '当前是开发模式或绿色包，不支持应用内更新。',
      detail: '绿色包更新：下载新版精简包后替换旧目录（数据目录不受影响）。',
    })
    return
  }
  const snap = await updater.check({ manual: true })
  if (snap.status === 'error') {
    dialog.showMessageBox(win, { type: 'warning', title: '检查更新', message: '检查更新失败', detail: snap.error })
    return
  }
  if (snap.status !== 'available') {
    dialog.showMessageBox(win, { type: 'info', title: '检查更新', message: `已是最新版本（v${snap.latestVersion}）` })
    return
  }
  const sizeMb = (snap.totalBytes / 1048576).toFixed(0)
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title: '检查更新', buttons: ['下载更新', '以后再说'], defaultId: 0, cancelId: 1,
    message: `发现新版本 v${snap.latestVersion}（当前 v${app.getVersion()}）`,
    detail: `安装包约 ${sizeMb} MB，下载完成后会提示重启安装。${snap.releaseNotes ? `\n\n${snap.releaseNotes.slice(0, 500)}` : ''}`,
  })
  if (response !== 0) return
  lastProgressToast = 0
  const done = await updater.download()
  if (done.status !== 'ready') {
    dialog.showMessageBox(win, { type: 'warning', title: '检查更新', message: '下载更新失败', detail: done.error })
    return
  }
  const { response: doInstall } = await dialog.showMessageBox(win, {
    type: 'question', title: '检查更新', buttons: ['重启并安装', '稍后'], defaultId: 0, cancelId: 1,
    message: '更新包下载完成，校验通过。',
    detail: '点击「重启并安装」将退出应用并运行安装程序。',
  })
  if (doInstall !== 0) return
  const installed = await updater.install()
  if (installed.status !== 'installing') {
    dialog.showMessageBox(win, { type: 'warning', title: '检查更新', message: '启动安装程序失败', detail: installed.error })
    return
  }
  app.quit()
}

/**
 * 开发期先注入本机专属配置(local.config.json, 不进仓库)。
 * =====================================================
 * WD14 反推需要知道"本机的 python 在哪、模型在哪", 而 `electron/core/*` 是
 * **打包后也要跑**的代码 —— 它不能 import `scripts/local-config.mjs`
 * (打包产物里没有 scripts/)。所以那层薄封装把值导出成 `TV_*` 环境变量
 * (见 scripts/local-config.mjs 的 applyLocalEnv), 这里在最早的时机调一次即可。
 *
 * 打包后跳过: 用户机器上由环境变量或 settings.json 提供, 缺了就降级(反推不跑,
 * 看板照常), 这是设计好的行为, 不是故障。
 */
if (!app.isPackaged) {
  try {
    const { applyLocalEnv } = await import('../scripts/local-config.mjs')
    const applied = applyLocalEnv()
    if (applied.length) console.log('[env] 本机配置已注入:', applied.join(', '))
  } catch { /* 没有这个文件是正常情况(开源用户 / 新克隆) */ }
}

/* ---- 启动日志 ----
 * 双击 bat/vbs 启动时没有控制台, 早期错误(缺模块/协议注册失败/权限)会静默消失,
 * 表现成"双击没反应"。这里把关键节点同步落到 logs\, 启动脚本据此判断成败并原样摊给用户。
 * 用 appendFileSync 而不是流 —— 启动期日志量极小, 且进程崩溃时不丢尾巴。
 *
 * 目录解析交给 core/paths.js(路径唯一真源), 它同时负责三件事:
 *   1. TV_LOG_DIR 的语义定死为「目录」。改造前 core/filelog.js 把它当成完整文件路径,
 *      同一个变量两处不一致 —— 一旦有人设了它, 两份日志会写到不同文件。
 *   2. 打包后自动改到 <userData>/logs。打包后 __dirname 在 resources/app.asar/electron 里,
 *      项目内 logs/ 落在只读区, appendFileSync 会静默失败(异常被下面的 catch 吞掉),
 *      排障能力直接归零。
 *   3. 开发期仍然是**项目内 logs/**, 与原行为逐字一致 —— 启动看板.bat / .vbs 靠
 *      logs\ready.flag 判定启动成败, 路径一变两个启动脚本就会误报"启动失败"。
 *
 * app.getPath('userData') 在 ready 之前虽然可用, 但这里是"绝不能抛异常"的位置
 * (抛了就双击没反应), 所以整体包一层 try。
 */
const LOG_DIR = (() => {
  try {
    return resolveLogDir({
      envLogDir: process.env.TV_LOG_DIR,
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
      projectRoot: path.join(__dirname, '..'),
    })
  } catch {
    return path.join(__dirname, '..', 'logs')
  }
})()
setLogDir(LOG_DIR)
const LOG_PATH = logFile()
const READY_FLAG = readyFlag()

function log(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}`
  try { fs.appendFileSync(LOG_PATH, line + '\n') } catch { /* 日志失败不能拖垮启动 */ }
  try { process.stdout.write(line + '\n') } catch { /* 无控制台时忽略 */ }
}

// 就绪标记: 启动脚本轮询它来判断"窗口是不是真的起来了"
function markReady(how) {
  try {
    fs.writeFileSync(READY_FLAG, `pid=${process.pid}\nhow=${how}\nat=${new Date().toISOString()}\n`)
  } catch { /* ignore */ }
}

function initLog() {
  try {
    fs.rmSync(LOG_PATH, { force: true })
    fs.rmSync(READY_FLAG, { force: true })
    fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch { /* ignore */ }
  log('boot', `pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`)
  log('boot', `argv=${JSON.stringify(process.argv.slice(1))}`)
  log('boot', `cwd=${process.cwd()}`)
  log('boot', `dev=${isDev} logDir=${LOG_DIR}`)
}

initLog()

// 主进程级异常: 不打日志的话, 双击启动的失败就是完全静默的
process.on('uncaughtException', (e) => {
  log('fatal', `uncaughtException: ${e?.stack || e}`)
})
process.on('unhandledRejection', (e) => {
  log('fatal', `unhandledRejection: ${e?.stack || e}`)
})

// ---- 1. 协议特权(必须早于 ready) ----
try {
  registerScheme()
  log('ok', 'registerScheme')
} catch (e) {
  log('fatal', `registerScheme 失败: ${e?.stack || e}`)
  throw e
}

// 单实例: 重复启动就把已有窗口唤到前面, 不另开一个吃内存的进程
// 注意: 拿不到锁时要**真的停下来** —— 否则下面的 whenReady 仍会建出一个窗口,
// 短暂出现两个实例(自动化脚本连 CDP 时还会连错那个旧的)。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  log('warn', '已有实例在运行, 本次不再开窗口(已有窗口会被唤到前面)')
  // 已有实例属于"启动成功"的一种, 同样打标记, 免得启动脚本误报失败
  markReady('second-instance')
  app.quit()
}

let win = null

function createWindow() {
  log('ok', 'createWindow')
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f6fa',
    title: 'WD14 标签看板',
    icon: path.join(__dirname, 'build', 'icon.ico'),   // 窗口/任务栏图标
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    log('ok', 'BOOT OK — 窗口已显示')
    markReady('window-shown')
  })

  // 渲染进程崩溃 / 加载失败都要留痕, 否则用户只看到白屏或没反应
  win.webContents.on('render-process-gone', (_e, d) => log('fatal', `render-process-gone: ${JSON.stringify(d)}`))
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log('fatal', `did-fail-load code=${code} desc=${desc} url=${url}`),
  )
  win.webContents.on('console-message', (...a) => {
    // Electron 35+ 传单个事件对象; 旧签名是 (event, level, message, line, sourceId)
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0]
      ? a[0]
      : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] }
    const lv = typeof d.level === 'string' ? d.level : (Number(d.level) >= 2 ? 'error' : 'info')
    if (lv === 'error' || lv === 'warning') {
      log('render', `${d.sourceId || d.source || ''}:${d.lineNumber ?? d.line ?? ''} [${lv}] ${d.message}`)
    }
  })

  // 外链一律丢给系统浏览器, 不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const ok = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!ok) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  if (isDev) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // ---- 6. 页面渲染出来之后才开始吃 CPU 的活 ----
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => startLoad(), 60)
  })

  win.on('closed', () => { win = null })
}

/* ---- 后台增量同步(磁盘 <-> tags.db) ----
 * 方案见 docs/数据源合并与增量入库方案.md §2.2。这里只负责"什么时候跑":
 *   · 等数据集**先就绪**再跑 —— 两者都要读 tags.db, 且同步会写库+改内存快照,
 *     叠在一起启动会互相踩(启动期本来就在读 8 万行)。
 *   · 延迟 3s 起, 让窗口先画出来、用户能立刻操作。
 *   · 只有真的改动了东西才重载数据集 —— 第二遍起同步基本是空转(绝大多数图
 *     指纹没变, 连图都不读), 没必要白白重读一遍。
 *   · TV_INGEST=0 可关(测试/dev 默认关, 见 scripts/electron-path.mjs 的注释)。
 */
let ingestStarted = false
function scheduleIngest() {
  if (ingestStarted) return
  if (process.env.TV_INGEST === '0') {
    log('ok', '后台增量同步已关闭(TV_INGEST=0)')
    return
  }
  ingestStarted = true
  setTimeout(() => { runIngestOnce() }, 3000)
}

async function runIngestOnce() {
  const push = (p) => { if (win && !win.isDestroyed()) win.webContents.send('ingest:progress', p) }
  try {
    log('ok', '后台增量同步开始')
    const st = await runIngest({ onProgress: push })
    log('ok', `后台增量同步结束: ${JSON.stringify(st)}`)
    const changed = st && !st.skipped && !st.error
      && (st.inserted || st.metaUpdated || st.goneSet || st.goneCleared)
    if (changed) {
      log('ok', `同步有改动(新增 ${st.inserted} / 更新 ${st.metaUpdated} / 消失 ${st.goneSet}), 静默重载数据集`)
      await startLoad({ quiet: true })
    }
  } catch (e) {
    log('warn', `后台增量同步失败: ${e?.stack || e}`)
  }
  // 同步会把新的裸图放进 tag_queue, 这里顺手接上反推。
  // 放在同步**之后**(而不是并行)是有意的: 反推要先把队列建出来, 而且模型加载
  // 会吃掉十几秒 CPU/GPU —— 跟枚举几万个文件抢资源只会让两边都变慢。
  scheduleTagging()
}

/* ------------------------------------------------------------ WD14 反推自启 */

/**
 * 反推自启 —— 只在"队列里真有东西"时才拉起服务。
 *
 * 为什么必须看队列: 拉起反推服务意味着加载 1.27GB 模型(+首次推理预热),
 * 而绝大多数日子队列是空的(实测第二轮同步后队列 0 张)。为了一个空队列
 * 每次启动都花十几秒和一大块显存, 是纯粹的浪费。
 *
 * 与同步共用 `TV_INGEST=0` 这个总闸(测试/dev 默认关, 见 scripts/electron-path.mjs):
 * 沙箱库的 folders 行指向用户真实盘符, 反推一旦漏跑就会把标签写进沙箱库并污染断言。
 * 另外留一个独立的 `TV_TAGGER=0` 用于"只想关反推、同步照跑"。
 */
let tagTimer = null

function scheduleTagging(delay = 1500) {
  if (process.env.TV_TAGGER === '0' || process.env.TV_INGEST === '0') {
    log('ok', '后台反推已关闭(TV_TAGGER=0 / TV_INGEST=0)')
    return
  }
  clearTimeout(tagTimer)
  tagTimer = setTimeout(runTagOnce, delay)
}

async function runTagOnce() {
  tagTimer = null
  if (taggerState.running) return
  let pending = 0
  try { pending = queueStats().pending } catch { /* 库还没建好 */ }
  if (!pending) return                       // 队列空 -> 不拉进程、不加载模型
  const push = (p) => { if (win && !win.isDestroyed()) win.webContents.send('tagger:progress', p) }
  try {
    log('ok', `后台反推开始(队列 ${pending} 张)`)
    const st = await runTagger({ onProgress: push })
    log('ok', `后台反推结束: ${JSON.stringify(st)}`)
    if (st && st.tagged) {
      // 反推把新标签写进了库 -> 内存里的数据集已经过期, 必须重载, 否则
      // 界面看不到刚反推出来的标签(库是新的、界面是旧的)。
      // quiet: 用户正在浏览/管理图片, 后台重载不该盖全屏遮罩(2026-10-03)。
      log('ok', `反推新增 ${st.tagged} 张标签, 静默重载数据集`)
      await startLoad({ quiet: true })
    }
  } catch (e) {
    log('warn', `后台反推失败: ${e?.stack || e}`)
  }
}

let loading = false
/** 退出前 flush 自动导出时置真 —— 防止 before-quit 被自己递归触发 */
let quitting = false
/**
 * 数据集加载。
 * @param {{quiet?: boolean}} [opts]
 *   quiet=true: 后台触发的重载(同步/反推/标签编辑完成后), **不推全屏进度** ——
 *   渲染端保持 ready、界面完全可操作, 完成后 app:reloaded 带新 stats 原地刷新
 *   (2026-10-03: 旧行为是移动一张图 -> 同步完成 -> 全屏遮罩十几秒, 反推完成
 *   再来一遍, 用户根本没法用)。启动首载 / 菜单 Ctrl+R 等用户主动加载仍走
 *   全屏进度。数据侧由 dataset.js 的双缓冲保证: 重载期间查询读到旧数据, 不闪空。
 */
async function startLoad(opts = {}) {
  const quiet = !!opts.quiet
  if (loading) return
  loading = true
  try {
    const push = quiet
      ? () => {}
      : (p) => { if (win && !win.isDestroyed()) win.webContents.send('app:progress', p) }
    push({ phase: 'parse', done: 0, total: 1, percent: 0, records: 0 })
    const st = await bootstrap({ onProgress: push })
    // bootstrap() 自己会 catch(它返回 status() 而不是抛), 所以这里必须显式看 phase。
    // 否则加载失败也会走到下面那行, 记成 `[ok] 数据集就绪: null` —— launch.log 是双击
    // 启动时**唯一**的排障线索, 日志报 ok 比没有日志更坏(会把人往错误方向带)。
    if (st.phase === 'error') {
      log('warn', `数据集加载失败: ${st.error}`)
      log('warn', `dataDir=${st.workspace?.dataDir} configPath=${st.workspace?.configPath} (存在=${st.workspace?.configExists})`)
      if (quiet && win && !win.isDestroyed()) {
        // 后台静默重载失败: 界面维持原状(继续用旧数据), 只弹一条全局提示 ——
        // 别把还能用的界面打成全屏错误页; 下一轮同步/反推成功会再次重载。
        win.webContents.send('app:toast', { text: `后台数据重载失败: ${st.error}`, tone: 'err', dur: 6000 })
      }
    } else {
      log('ok', `数据集就绪: ${JSON.stringify(ds.stats)}`)
      // 翻译库单独记一行 —— 2026-09-19 就因为没这行, "翻译整体消失" 只能靠肉眼发现:
      // 配置里的 translate_dir 指向一个早就被挪走的目录, 加载结果是 0 条, 而日志里
      // 一行字都没有, 看着像是"功能没做", 其实是路径失效。
      const tr = st.translate || {}
      const src = tr.dirSource === 'config' ? '配置'
        : tr.dirSource === 'auto' ? '数据目录自动发现'
          : tr.dirSource === 'bundled' ? '仓库内置'
            : '未启用'
      const line = `翻译库: WeiLin ${tr.weilin ?? 0} 条 + 本地补译 ${tr.local ?? 0} 条`
        + ` = ${tr.total ?? 0} 条 · 来源=${src}`
        + ` · dir=${(tr.dirs || []).join(' | ') || '（无）'}`
      if (tr.dirMissing) log('warn', `${line} —— 配置里的 translate_dir 不存在: ${tr.dirWanted}`)
      else if (!tr.weilin) log('warn', `${line} —— 一条 WeiLin 都没读到, 标签只会有本地补译的中文`)
      else log('ok', line)
    }
    if (win && !win.isDestroyed() && !(quiet && st.phase === 'error')) win.webContents.send('app:reloaded', st)
    if (st.phase !== 'error') {
      // 存量 meta 图一次性补推(2026-10-02 合并语义配套): 改语义前入库的 meta 图
      // 从没进过反推队列, 首次启动补队一次(meta 表打标记, 之后启动直接跳过)。
      // 放在 scheduleIngest 之前 —— 这样首轮同步结束接上反推时, 队列已经齐了。
      try {
        const bf = backfillMetaQueue()
        if (bf.queued) log('ok', `存量 meta 图补推: 已入队 ${bf.queued} 张, 由后台反推逐步合并`)
      } catch (e) {
        log('warn', `存量 meta 补推失败(不影响启动): ${e?.message || e}`)
      }
    }
    // scheduleIngest 必须无条件执行 —— 2026-10-03 实锤: 全新库 + 已登记文件夹 +
    // 0 images 时, 数据集加载 phase=error, 若把同步关在 phase!=='error' 里面,
    // 就没人跑 ingest、也没人接 scheduleTagging, tag_queue 里的裸图永远没人
    // 消费 -> images 永远 0 -> 数据集永远 error = 死锁(另一台机器 633 张全卡死)。
    // 同步只是"磁盘 <-> tags.db 对齐", 不依赖数据集就绪; 就算库真坏了,
    // runIngestOnce 自己有 try/catch, 最多 warn 一行。
    scheduleIngest()
  } catch (e) {
    log('fatal', `数据集加载失败: ${e?.stack || e}`)
    if (win && !win.isDestroyed()) {
      if (quiet) {
        // 同 error 分支: 后台重载失败不动界面, toast 一声
        win.webContents.send('app:toast', { text: `后台数据重载失败: ${e?.message || e}`, tone: 'err', dur: 6000 })
      } else {
        win.webContents.send('app:reloaded', { phase: 'error', error: e?.message || String(e) })
      }
    }
  } finally {
    loading = false
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '重新加载数据', accelerator: 'CmdOrCtrl+R', click: () => startLoad() },
        { label: '打开数据目录', click: () => shell.openPath(getWorkspace().dataDir) },
        { label: '打开设置文件', click: () => shell.openPath(getWorkspace().configPath) },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            const st = status()
            const d = st.stats || {}
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: `WD14 标签看板 v${app.getVersion()}`,
              detail: [
                `Electron ${process.versions.electron} / Node ${process.versions.node} / Chromium ${process.versions.chrome}`,
                '',
                st.workspace.dataDir ? `数据目录: ${st.workspace.dataDir}` : '',
                `标签文件: ${st.sources.length} 个来源`,
                d.records ? `共 ${d.records.toLocaleString()} 张图片 / ${d.tags?.toLocaleString()} 个标签 / ${d.series?.toLocaleString()} 个系列` : '数据尚未加载',
                d.ms ? `上次加载耗时: ${(d.ms / 1000).toFixed(2)}s` : '',
              ].filter(Boolean).join('\n'),
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()   // 双击启动器唤起: show 强制把隐藏/被遮的窗口拉回可见, 再聚焦
    win.focus()
  }
})

app.whenReady().then(() => {
  if (!gotLock) return
  log('ok', `app ready, userData=${app.getPath('userData')}`)

  try {
    // defaultDataDir 由这里注入(workspace.js 不能 import electron, 见 core/paths.js 顶部):
    // 没有 settings.json / TV_DATA_DIR 时数据目录取 <userData>/data —— 每个用户各自的**可写**目录,
    // 而不是改造前那个指向开发机的绝对路径。开发期本机由 settings.json 指向项目内 data/,
    // 行为不变; 新装用户则由下一轮的首次启动向导来选定。
    // allowPortable(2026-10-02): 与应用同目录存在可写 data/ 时优先用它 —— 绿色包的数据
    // 随包走(删文件夹即卸载), 仓库开发态同样命中。显式配置仍最优先, 打包态(asar)自动回落。
    initWorkspace(app.getPath('userData'), {
      defaultDataDir: path.join(app.getPath('userData'), 'data'),
      allowPortable: true,
    })
    const ws = getWorkspace()
    log('ok', `dataDir=${ws.dataDir}`)
    log('ok', `configPath=${ws.configPath} (存在=${ws.configExists})`)
    // 内置翻译库不再首启复制(2026-10-15 起): 三个源在构建期合成 assets/translations.db,
    // 经 extraResources 落在 resources/ 下, app-state 加载时由 translate.js 直接读
    // 真实文件 —— 不复制、不进 asar(node:sqlite 打不开 asar 虚拟路径, 2.2.0 踩过)。
    // 反推偏好(provider 覆盖 / 阈值)同步进环境变量, tagger_serve 每次 spawn 都会读到
    const env = applyTaggerEnv()
    log('ok', `反推偏好: provider=${env.provider} threshold=${env.threshold} char=${env.charThreshold}`)
  } catch (e) {
    log('fatal', `initWorkspace 失败: ${e?.stack || e}`)
    try { dialog.showErrorBox('TagViewer 启动失败', `初始化工作区失败:\n\n${e?.stack || e}`) } catch { /* ignore */ }
    app.quit()
    return
  }

  try {
    registerHandler()
    registerIpc({
      onReload: () => { /* 数据集重载后由渲染进程自己重取 */ },
      // 设置弹窗「检查更新」按钮 —— 复用菜单 Help → 检查更新… 的完整流程(主进程弹窗)
      onCheckUpdate: () => { checkForUpdateManually() },
      // 同步跑完: 内存里的数据集已经过期, 必须重载一次, 否则看板数字和搜索
      // 索引还停在同步前(库是新的、界面是旧的)。quiet(2026-10-03): 移动一张图
      // 就会走这条链路, 全屏遮罩会打断浏览 —— 后台双缓冲重载, 完成后原地刷新。
      // ⚠️ 这里**不再接 scheduleTagging**(2026-10-03 用户拍板): 移动一张图就为
      // 1 张裸图加载 1.27GB 模型, 还弹进度胶囊打扰看图 —— 本次会话新入队的
      // 裸图攒着, 下次启动由启动链路(runIngestOnce -> scheduleTagging)统一推。
      // 主动入口保留: 顶栏胶囊「再反推一次」/ 扫描页手动反推 / 新装机引导流程。
      onIngestDone: () => { startLoad({ quiet: true }) },
      // 手动「反推」跑完: 新标签要进内存才看得见
      onTaggerDone: () => { startLoad({ quiet: true }) },
    })
    buildMenu()
    log('ok', 'ipc / protocol / menu 注册完成')
  } catch (e) {
    log('fatal', `初始化 IPC/协议失败: ${e?.stack || e}`)
    try { dialog.showErrorBox('TagViewer 启动失败', `注册 IPC/协议失败:\n\n${e?.stack || e}`) } catch { /* ignore */ }
    app.quit()
    return
  }

  createWindow()
  setupUpdater()
  // 反推环境引导: 错开启动高峰(数据加载在跑), 4 秒后再探测;
  // 触发直进下载: 环境变量 TV_DOWNLOAD_MODEL=1(安装器/启动器注入 —— 打包版会把
  // 命令行里的自定义 --开关 当成未知 Electron 选项拒掉, 实测 bad option, 所以用环境变量)。
  const wantModelNow = process.argv.includes('--download-model') || process.env.TV_DOWNLOAD_MODEL === '1'
  setTimeout(() => {
    ensureRuntimeFlow({ force: wantModelNow }).catch((e) => log('warn', `runtime flow 异常: ${e?.stack || e}`))
  }, wantModelNow ? 1500 : 4000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('child-process-gone', (_e, d) => log('warn', `child-process-gone: ${JSON.stringify(d)}`))

/**
 * 退出前把"排程中的自动导出"跑完。
 * 场景: ban 完最后一个词条马上关窗口 —— 延迟还没到期, 不 flush 就白按了一次。
 *
 * 2026-09-24 改: 延迟可配(默认 3 分钟)之后, 原来那套"等它自己到期(最多 8 秒)再退"
 * 必然超时 —— 结果是**这次改动永远不会导出**, 而用户以为已经导过了。
 * 所以改成**取消定时器、当场跑掉**: 代价是关窗口时可能多等几秒(导出是同步重活),
 * 换来的是"最后一次改动一定落地"。
 *
 * 2026-09-29: 购物车自动导出那条同理 —— 加完角色就关窗, 延迟(默认 30 秒)还没到,
 * 不 flush 就等于没开这个功能。两条线各 flush 各的, 互不影响。
 */
app.on('before-quit', (e) => {
  if (quitting || !gotLock) return
  const pendingAuto = hasPendingAuto()
  const pendingCart = hasPendingCart()
  if (!pendingAuto && !pendingCart) return
  e.preventDefault()
  quitting = true
  // 两条线各 flush 各的(购物车那份就是几十行, 基本不用等)
  Promise.resolve()
    .then(() => (pendingAuto ? flushPendingNow() : null))
    .then(() => (pendingCart ? flushCartPendingNow() : null))
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (!gotLock) return
  log('ok', '所有窗口已关闭, 退出')
  // 反推服务是独立子进程(python), Electron 不会连带把它带走 —— 不显式收掉
  // 就会留下一个常驻 1.27GB 模型的孤儿进程, 下次启动又起一个。
  try { stopTagger() } catch { /* 忽略 */ }
  app.quit()
})
