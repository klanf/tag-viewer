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
import { fileURLToPath } from 'node:url'
import { registerScheme, registerHandler } from './imageproto.js'
import { registerIpc } from './ipc.js'
import { initWorkspace, getWorkspace } from './core/workspace.js'
import { resolveLogDir, setLogDir, logFile, readyFlag } from './core/paths.js'
import { bootstrap, status } from './core/app-state.js'
import { runIngest, queueStats } from './core/ingest.js'
import { runTagger, stopTagger, taggerState } from './core/tagger.js'
import { ds } from './core/dataset.js'
import { flushAuto, hasPendingAuto } from './core/exportPresets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''
const isDev = !!DEV_URL

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
      log('ok', `同步有改动(新增 ${st.inserted} / 更新 ${st.metaUpdated} / 消失 ${st.goneSet}), 重载数据集`)
      await startLoad()
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
      log('ok', `反推新增 ${st.tagged} 张标签, 重载数据集`)
      await startLoad()
    }
  } catch (e) {
    log('warn', `后台反推失败: ${e?.stack || e}`)
  }
}

let loading = false
/** 退出前 flush 自动导出时置真 —— 防止 before-quit 被自己递归触发 */
let quitting = false
async function startLoad() {
  if (loading) return
  loading = true
  try {
    const push = (p) => { if (win && !win.isDestroyed()) win.webContents.send('app:progress', p) }
    push({ phase: 'parse', done: 0, total: 1, percent: 0, records: 0 })
    const st = await bootstrap({ onProgress: push })
    // bootstrap() 自己会 catch(它返回 status() 而不是抛), 所以这里必须显式看 phase。
    // 否则加载失败也会走到下面那行, 记成 `[ok] 数据集就绪: null` —— launch.log 是双击
    // 启动时**唯一**的排障线索, 日志报 ok 比没有日志更坏(会把人往错误方向带)。
    if (st.phase === 'error') {
      log('warn', `数据集加载失败: ${st.error}`)
      log('warn', `dataDir=${st.workspace?.dataDir} configPath=${st.workspace?.configPath} (存在=${st.workspace?.configExists})`)
    } else {
      log('ok', `数据集就绪: ${JSON.stringify(ds.stats)}`)
      // 翻译库单独记一行 —— 2026-09-19 就因为没这行, "翻译整体消失" 只能靠肉眼发现:
      // 配置里的 translate_dir 指向一个早就被挪走的目录, 加载结果是 0 条, 而日志里
      // 一行字都没有, 看着像是"功能没做", 其实是路径失效。
      const tr = st.translate || {}
      const src = tr.dirSource === 'config' ? '配置'
        : tr.dirSource === 'auto' ? '数据目录自动发现'
          : '未启用'
      const line = `翻译库: WeiLin ${tr.weilin ?? 0} 条 + 本地补译 ${tr.local ?? 0} 条`
        + ` = ${tr.total ?? 0} 条 · 来源=${src}`
        + ` · dir=${(tr.dirs || []).join(' | ') || '（无）'}`
      if (tr.dirMissing) log('warn', `${line} —— 配置里的 translate_dir 不存在: ${tr.dirWanted}`)
      else if (!tr.weilin) log('warn', `${line} —— 一条 WeiLin 都没读到, 标签只会有本地补译的中文`)
      else log('ok', line)
    }
    if (win && !win.isDestroyed()) win.webContents.send('app:reloaded', st)
    if (st.phase !== 'error') scheduleIngest()
  } catch (e) {
    log('fatal', `数据集加载失败: ${e?.stack || e}`)
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:reloaded', { phase: 'error', error: e?.message || String(e) })
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
    initWorkspace(app.getPath('userData'), {
      defaultDataDir: path.join(app.getPath('userData'), 'data'),
    })
    const ws = getWorkspace()
    log('ok', `dataDir=${ws.dataDir}`)
    log('ok', `configPath=${ws.configPath} (存在=${ws.configExists})`)
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
      // 手动「立即同步」跑完: 内存里的数据集已经过期, 必须重载一次,
      // 否则看板数字和搜索索引还停在同步前(库是新的、界面是旧的)。
      onIngestDone: () => { startLoad(); scheduleTagging() },
      // 手动「反推」跑完: 同理, 新标签要进内存才看得见
      onTaggerDone: () => { startLoad() },
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('child-process-gone', (_e, d) => log('warn', `child-process-gone: ${JSON.stringify(d)}`))

/**
 * 退出前把"排程中的自动导出"跑完。
 * 场景: ban 完最后一个词条马上关窗口 —— 1.5s 防抖还没到期, 不 flush 就白按了一次。
 * 这里同步等一下(最多几秒), 保证落盘不半途而废。
 */
app.on('before-quit', (e) => {
  if (quitting || !gotLock) return
  if (!hasPendingAuto()) return
  e.preventDefault()
  quitting = true
  Promise.resolve(flushAuto()).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (!gotLock) return
  log('ok', '所有窗口已关闭, 退出')
  // 反推服务是独立子进程(python), Electron 不会连带把它带走 —— 不显式收掉
  // 就会留下一个常驻 1.27GB 模型的孤儿进程, 下次启动又起一个。
  try { stopTagger() } catch { /* 忽略 */ }
  app.quit()
})
