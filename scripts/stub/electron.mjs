/**
 * electron 模块桩 —— 让主进程代码在「纯 Node」下也能被加载并真实调用
 * ==================================================================
 * 为什么需要: electron/ipc.js 有 40+ 个 handler, 但以前只能靠「启动应用 + 手点」
 * 来验证。改坏一个变量名(比如漏了个 import)在 `node --check` 下完全看不出来,
 * 要等用户点到那个菜单才报错。有了这个桩, 就能在测试里直接 invoke handler:
 *
 *   register('./stub/electron-loader.mjs', import.meta.url)   // 拦 'electron' 导入
 *   const { ctl } = await import('./stub/electron.mjs')       // 拿控制面板
 *   const { registerIpc } = await import('../electron/ipc.js')
 *   registerIpc()
 *   ctl.pick = (tpl) => tpl.find((i) => i.label === '...').click()
 *   const r = await ctl.handlers.get('app:ctxMenu')(fakeEvent, payload)
 *
 * 注意: 桩只实现主进程真正用到的那一小部分 API(见下面导出), 不做行为模拟。
 */

import fs from 'node:fs'

/** 控制面板: 测试通过它设桩 / 读副作用 */
export const ctl = {
  /** ipcMain.handle 注册进来的 channel -> handler */
  handlers: new Map(),
  /** 菜单选择器: (template) => void, 在里面挑一项并调它的 click() */
  pick: null,
  /** 覆盖 dialog.showOpenDialog 的返回; null = 模拟用户取消 */
  openDialog: null,
  /** 覆盖 dialog.showSaveDialog 的返回 */
  saveDialog: null,
  /** 覆盖 dialog.showMessageBox 的返回 */
  messageBox: null,
  /** shell / clipboard 这类外部副作用调用流水: [api, ...args] */
  calls: [],
  /** 被 new 出来的窗口 */
  windows: [],
  /** 收集到的日志 */
  logs: [],
  /** 重置(每个测试用例开头调一次) */
  reset() {
    ctl.handlers.clear()
    ctl.pick = null
    ctl.openDialog = null
    ctl.saveDialog = null
    ctl.messageBox = null
    ctl.calls = []
    ctl.logs = []
  },
}

export const ipcMain = {
  handle(channel, fn) { ctl.handlers.set(channel, fn) },
  removeHandler(channel) { ctl.handlers.delete(channel) },
  on() {},
  once() {},
}

export const ipcRenderer = {
  invoke: async () => undefined,
  on() {}, once() {}, removeListener() {}, send() {},
}

export const contextBridge = { exposeInMainWorld() {} }

export const app = {
  isPackaged: false,
  commandLine: { appendSwitch() {} },
  getPath: (name) => `/tmp/tv-stub/${name}`,
  getVersion: () => '0.0.0-stub',
  getName: () => 'TagViewer-stub',
  setName() {},
  on() {}, once() {}, off() {},
  whenReady: async () => {},
  quit() {},
  exit() {},
  relaunch() {},
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock() {},
  setAppUserModelId() {},
  getAppMetrics: () => [],
  disableHardwareAcceleration() {},
}

function dialogResult(over) {
  return { canceled: true, filePaths: [], ...over }
}

export const dialog = {
  async showOpenDialog(...args) {
    const r = typeof ctl.openDialog === 'function' ? ctl.openDialog(...args) : ctl.openDialog
    return dialogResult(r)
  },
  async showSaveDialog(...args) {
    const r = typeof ctl.saveDialog === 'function' ? ctl.saveDialog(...args) : ctl.saveDialog
    return dialogResult(r)
  },
  async showMessageBox(...args) {
    if (typeof ctl.messageBox === 'function') return ctl.messageBox(...args)
    return { response: 0, checkboxChecked: false, ...ctl.messageBox }
  },
  showErrorBox(title, content) { ctl.calls.push(['dialog.showErrorBox', title, content]) },
}

export const clipboard = {
  writeText(t) { ctl.calls.push(['clipboard.writeText', String(t)]) },
  writeImage(img) { ctl.calls.push(['clipboard.writeImage', img]) },
  readText: () => '',
}

export const shell = {
  async openPath(p) { ctl.calls.push(['shell.openPath', p]); return '' },
  showItemInFolder(p) { ctl.calls.push(['shell.showItemInFolder', p]) },
  async openExternal(p) { ctl.calls.push(['shell.openExternal', p]) },
  // 与真实语义对齐: 成功 = 文件离开原位(测试里直接删掉, 真机是进回收站)。
  // 不删的话 image:trash 的 existsSync 兜底会把它判成"真失败", 用例没法往下走。
  async trashItem(p) {
    ctl.calls.push(['shell.trashItem', p])
    try { fs.unlinkSync(p) } catch { /* 已不在 = 也算成功 */ }
  },
  beep() {},
}

export class BrowserWindow {
  constructor(opts = {}) {
    this.opts = opts
    this.webContents = {
      on() {}, once() {}, send() {}, openDevTools() {},
      setWindowOpenHandler() {},
      session: { webRequest: { onHeadersReceived() {} } },
    }
    ctl.windows.push(this)
  }
  static fromWebContents(wc) { return wc?.__win || null }
  static getAllWindows() { return ctl.windows }
  show() {} hide() {} focus() {} restore() {} close() {} destroy() {}
  isMinimized() { return false }
  isVisible() { return true }
  loadFile() { return Promise.resolve() }
  loadURL() { return Promise.resolve() }
  setMenu() {} setMenuBarVisibility() {}
}

/** 菜单桩: buildFromTemplate 返回的对象在 popup 时把控制权交给 ctl.pick */
export const Menu = {
  buildFromTemplate(template) {
    return {
      template,
      popup({ callback } = {}) {
        try {
          if (typeof ctl.pick === 'function') ctl.pick(template)
        } finally {
          // 真实 Electron 里 callback 在菜单关闭时触发; 这里同步触发,
          // 让 handler 里 `await new Promise(resolve => popup({callback: resolve}))` 立即返回
          if (typeof callback === 'function') callback()
        }
      },
      closePopup() {},
    }
  },
  setApplicationMenu(menu) { ctl.applicationMenu = menu },
  getApplicationMenu() { return ctl.applicationMenu || null },
  buildFromTemplateSync: null,
}

export const nativeImage = {
  createFromPath: (p) => ({ __stubImage: p, isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }),
  createEmpty: () => ({ __stubImage: null, isEmpty: () => true }),
  createFromBuffer: () => ({ __stubImage: 'buffer', isEmpty: () => false }),
}

export const protocol = {
  handle() {},
  registerSchemesAsPrivileged() {},
}

export const net = {
  async fetch() { throw new Error('stub: net.fetch 未实现') },
}

export const screen = {
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1040 } }),
  getAllDisplays: () => [],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
}

export const nativeTheme = { shouldUseDarkColors: false, on() {} }
export const globalShortcut = { register: () => true, unregisterAll() {} }
export const powerMonitor = { on() {} }
export const Notification = class { static isSupported() { return false } show() {} }
export const Tray = class { setToolTip() {} setContextMenu() {} on() {} destroy() {} }

export default {
  ctl, app, ipcMain, ipcRenderer, contextBridge, dialog, clipboard, shell,
  BrowserWindow, Menu, nativeImage, protocol, net, screen, nativeTheme,
  globalShortcut, powerMonitor, Notification, Tray,
}
