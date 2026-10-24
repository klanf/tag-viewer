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
  /** 剪贴板当前有没有图（clipboard.write 成功后置 true，clear 置 false） */
  clipboardImage: false,
  /** 强制覆盖 clipboard.has() 的返回（布尔）；不设则按 clipboardImage 推导。
   *  用来测「写完了但回读读不到」那条 —— 真机上那是 CF_DIBV5 没落地。 */
  clipboardHas: undefined,
  /** nativeImage 桩给的尺寸（模拟真机 getSize()） */
  imageSize: { width: 4, height: 4 },
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
    ctl.clipboardImage = false
    ctl.clipboardHas = undefined
    ctl.imageSize = { width: 4, height: 4 }
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

/**
 * 剪贴板桩 —— **刻意照着 Electron 44.3.0 的真身做**（2026-09-24 实测）：
 *   · `Object.keys(clipboard)` = clear / has / read / readText / write / writeText
 *     —— **没有 writeImage**。这个"缺方法"是事实，必须保留：谁把代码改回
 *     `clipboard.writeImage(...)`，用例就会红（那正是用户报的「点了没反应」的根因）。
 *   · `has()` / `read()` 返回 **Promise**（真机已是 W3C 异步语义）。
 *   · `write()` 只认 `[ClipboardItem]`；给别的形状 reject
 *     （真机原话：`clipboard.write expects an array of ClipboardItem`）。
 */
export class ClipboardItem {
  constructor(items = {}) {
    this.types = Object.keys(items)
    this.items = items
  }

  getType(type) { return Promise.resolve(this.items[type]) }
}

export const clipboard = {
  clear() {
    ctl.calls.push(['clipboard.clear'])
    ctl.clipboardImage = false
  },
  async has(fmt) {
    ctl.calls.push(['clipboard.has', fmt])
    return typeof ctl.clipboardHas === 'boolean' ? ctl.clipboardHas : ctl.clipboardImage === true
  },
  async read(fmt) {
    ctl.calls.push(['clipboard.read', fmt])
    return null
  },
  readText() { ctl.calls.push(['clipboard.readText']); return '' },
  write(items) {
    ctl.calls.push(['clipboard.write', items])
    if (!Array.isArray(items) || !items.every((i) => i instanceof ClipboardItem)) {
      return Promise.reject(new TypeError('clipboard.write expects an array of ClipboardItem'))
    }
    ctl.clipboardImage = true
    return Promise.resolve()
  },
  writeText(t) { ctl.calls.push(['clipboard.writeText', String(t)]) },
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
    /** 内容区尺寸(DIP)。右键菜单的落点要用它算, 见 ipc.js 的 clampMenuPos */
    this.contentSize = opts.__contentSize || [1560, 980]
    this.webContents = {
      on() {}, once() {}, openDevTools() {},
      // 主进程 → 渲染层的推送在这里留痕, 测试才能断言"提示真的发出去了"
      send(channel, payload) { ctl.calls.push(['webContents.send', channel, payload]) },
      setWindowOpenHandler() {},
      session: { webRequest: { onHeadersReceived() {} } },
    }
    ctl.windows.push(this)
  }
  static fromWebContents(wc) { return wc?.__win || null }
  static getAllWindows() { return ctl.windows }
  getContentSize() { return this.contentSize }
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
      popup(opts = {}) {
        // 落点要留痕: 「二级菜单飞到点不到的地方」那类问题只能靠断言 x/y 兜住
        ctl.calls.push(['menu.popup', { x: opts.x, y: opts.y, hasWindow: !!opts.window }])
        try {
          if (typeof ctl.pick === 'function') ctl.pick(template)
        } finally {
          // 真实 Electron 里 callback 在菜单关闭时触发; 这里同步触发,
          // 让 handler 里 `await new Promise(resolve => popup({callback: resolve}))` 立即返回
          if (typeof opts.callback === 'function') opts.callback()
        }
      },
      closePopup() {},
    }
  },
  setApplicationMenu(menu) { ctl.applicationMenu = menu },
  getApplicationMenu() { return ctl.applicationMenu || null },
  buildFromTemplateSync: null,
}

/**
 * nativeImage 桩。**照真机的事实做**：Electron 的解码器只认 PNG / JPEG，
 * webp / bmp / gif 会拿到**空图**（`isEmpty() === true`）——
 * 「复制图片」那条路必须自己拦住空图，否则真机上就是"不报错也不写进去"。
 * 尺寸由 `ctl.imageSize` 控制（默认 4×4），`toPNG()` 给一段带 PNG 文件头的假数据。
 */
const DECODABLE = /\.(png|jpe?g|jpe)$/i
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const nativeImage = {
  createFromPath: (p) => (DECODABLE.test(String(p))
    ? {
      __stubImage: p,
      isEmpty: () => false,
      getSize: () => ({ ...ctl.imageSize }),
      toPNG: () => Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.alloc(8, 1)]),
      toBitmap: () => Buffer.alloc((ctl.imageSize.width || 1) * (ctl.imageSize.height || 1) * 4),
    }
    : {
      __stubImage: p,
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    }),
  createEmpty: () => ({ __stubImage: null, isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
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
