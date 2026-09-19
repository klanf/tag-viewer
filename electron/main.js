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
import { ds } from './core/dataset.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''
const isDev = !!DEV_URL

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

let loading = false
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
    registerIpc({ onReload: () => { /* 数据集重载后由渲染进程自己重取 */ } })
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

app.on('window-all-closed', () => {
  if (!gotLock) return
  log('ok', '所有窗口已关闭, 退出')
  app.quit()
})
