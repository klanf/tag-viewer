/**
 * 右键菜单的「复制图片到剪贴板」+ 系统「打开方式」对话框
 * ======================================================
 * 2026-09-24 修的真 bug —— 这个功能此前 **100% 失效，而且一声不响**。
 *
 * 原来 ipc.js 的菜单里是这么一行：
 *     try { clipboard.writeImage(nativeImage.createFromPath(p)) } catch { /* 忽略 *\/ }
 * Electron 44.3.0（Chrome 152）的主进程 `clipboard` 已换成 W3C 语义，实测
 *     Object.keys(clipboard) = ['clear','has','read','readText','write','writeText']
 * —— **没有 `writeImage`**。所以那一行必然抛
 * `TypeError: clipboard.writeImage is not a function`，被外面那个空 catch 吞掉 ⇒
 * 用户看到的就是「点了没反应、粘贴不出来」，且连一句提示都没有。
 * 跟图片格式、大小都无关：**每一次点都这样**。
 *
 * 能用的写法只有一条：`write([new ClipboardItem({ 'image/png': Blob })])`。
 * Chromium 拿到 PNG 后会自己转成 CF_DIBV5 / CF_DIB / CF_BITMAP 一起放进系统剪贴板。
 * 本机实测（真实图；脚本在 per-monitor-wallpaper 仓库的 tools/tmp/verify-tagviewer-copy.js）：
 *     10000×6667 PNG ：toPNG **5326ms**（同步·主进程整段冻住）+ write 1762ms
 *      9500×6531 JPEG：toPNG **5864ms** + write 1714ms
 * 所以「先报进度、再进同步段」是硬要求：5 秒屏上毫无变化，用户就会以为没响应、
 * 切走再粘贴 —— 这正是「以前可以、现在不行」的真正观感来源（图变大了）。
 *
 * 为什么不做 CF_DIBV5 快路（绕过 toPNG，能把 6.6s 压到 ~1s）：
 * 那需要 koffi 之类的原生模块，而本项目从 thumbs.js 起就定下**不引原生模块**
 * （原生模块牵出 ABI / 打包 / 重装三件套）。本库实测 p50 = 4.7 MP、>12 MP 只占 7.8%，
 * 绝大多数图 toPNG 只要几百毫秒。要上快路时，照 per-monitor-wallpaper 那个仓库的
 * `src/clipboardWin.js`（BITMAPV5HEADER + 预乘 BGRA + GlobalAlloc/SetClipboardData）搬即可。
 *
 * 自证方式（本文件不引 koffi，所以只能用 Electron 自己的 API）：
 *   `await clipboard.has('image/png')` —— 实测可靠（clear 之后是 false，写完是 true）。
 *   ⚠️ 另外两条"看起来能自证"的路都**不行**，别再试第二遍：
 *     · `read('image/png')` 返回的不是 Buffer（实测「1 bytes」/`[ClipboardItem {}]`）；
 *     · `read()` 拿到的 ClipboardItem 能 `getType('image/png')` 取出真 PNG，但那份
 *       是 Chromium **重新编码**过的（实测：4706B 写进去 → 17345B 读回来，字节不同），
 *       大图重编码还要几秒 —— 比不了字节，成本也不划算。
 *   想要「载荷 ≥ 宽×高×4」这种硬证据只能用 koffi 量 GlobalSize：
 *   开发期已交叉核对过（66.7MP → CF_DIBV5 254.3 MiB，达标），
 *   脚本是 `per-monitor-wallpaper` 仓库的 `tools/tmp/verify-tagviewer-copy.js`（靠那边的 koffi + 启动器）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { clipboard, ClipboardItem, nativeImage } from 'electron'
import { readImageSize } from './imgsize.js'

/** 提示发出去之后留给渲染层「画一帧」的时间。下面 toPNG 是同步的，一进去就发不出东西了。 */
export const NOTICE_PAINT_MS = 80

/**
 * `clipboard.write()` 的死线。它返回 Promise，理论上可能永不 settle（Chromium 的
 * 剪贴板写入是延迟渲染的），没有死线就会永远挂着、菜单像死了一样。
 * 给到 20s 是因为**大图写入本身就要 1.6s+**（实测 1000×6667 那张 1662ms）——
 * 死线只能用来抓「永不返回」，不能把合法的慢写入剪掉。
 */
export const WRITE_TIMEOUT_MS = 20000

/**
 * 只读文件头估尺寸 —— **不解码**，几百字节的事。
 *
 * 用途：在冻住主进程之前先把「这张图多大」算出来，好让提示能写成
 * 「正在复制图像（10000×6667）…」。读不到头不是错误，返回 0 即可
 * （真正的失败由 copyImage 报）。
 *
 * @param {string} filePath
 * @returns {{width:number, height:number, mp:number}}
 */
export function planCopy(filePath) {
  try {
    const s = readImageSize(filePath)
    if (Array.isArray(s) && s[0] > 0 && s[1] > 0) {
      return { width: s[0], height: s[1], mp: Number(((s[0] * s[1]) / 1e6).toFixed(1)) }
    }
  } catch {
    // 头解析失败不算错误
  }
  return { width: 0, height: 0, mp: 0 }
}

/** 给 Promise 加死线，**永不抛**：返回 {status:'ok'|'error'|'timeout', value?, error?} */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => finish({ status: 'timeout' }), ms)
    Promise.resolve(promise).then(
      (value) => finish({ status: 'ok', value }),
      (err) => finish({ status: 'error', error: (err && err.message) || String(err) }),
    )
  })
}

/**
 * 剪贴板里现在有没有图（只读，不改内容）。
 * 只用 Electron 自己的 API —— 见文件头「自证方式」。
 */
export async function readImageStatus() {
  try {
    const has = await clipboard.has('image/png')
    return { has: has === true, error: '' }
  } catch (err) {
    return { has: false, error: err.message }
  }
}

/**
 * 复制图片**像素**（可以粘进 Word / 画图 / PS / 微信）。
 *
 * 这个方法**从不抛异常** —— 菜单点了却没提示，比报错更糟。
 * 返回 {ok:true, width, height, bytes, encodeMs, writeMs, totalMs, method, clipboard}
 * 或   {ok:false, error, width?, height?, encodeMs?, writeMs?}
 *
 * @param {string} filePath
 * @param {{writeTimeoutMs?:number}} [options] `writeTimeoutMs` 只给单测用（要验
 *        「write 永不返回」那条死线，真等 20s 太慢），正常调用不要传。
 */
export async function copyImage(filePath, options = {}) {
  const t0 = Date.now()
  try {
    if (!filePath) return { ok: false, error: '没有文件路径' }

    try {
      const st = await fsp.stat(filePath)
      if (!st.isFile()) return { ok: false, error: '这不是一个文件' }
    } catch (err) {
      return { ok: false, error: `文件已经读不到了（${err.code || err.message}）` }
    }

    const plan = planCopy(filePath)
    const img = nativeImage.createFromPath(filePath)

    // Electron 的解码器只认 PNG / JPEG。webp / bmp / gif 在这里会拿到**空图**，
    // 而空图写进剪贴板是「不抛错、也不写」—— 又是一次静默失败，必须自己拦住。
    if (img.isEmpty()) {
      return {
        ok: false,
        width: plan.width,
        height: plan.height,
        error: '这个格式解不出像素（Electron 的解码器只认 PNG / JPEG）'
          + ' —— 可以改用右键的「复制文件路径」，交给别的程序打开',
      }
    }

    const { width, height } = img.getSize()

    // ⚠️ 下面这句是**同步**的，66.7 MP 实测 5326ms，期间主进程整段冻住。
    const tPng = Date.now()
    const png = img.toPNG()
    const encodeMs = Date.now() - tPng
    if (!png || !png.length) {
      return { ok: false, width, height, encodeMs, error: '转 PNG 失败，没有可写入的数据' }
    }

    const tWrite = Date.now()
    const writeTimeoutMs = options.writeTimeoutMs || WRITE_TIMEOUT_MS
    const r = await withDeadline(
      clipboard.write([new ClipboardItem({
        'image/png': new Blob([png], { type: 'image/png' }),
      })]),
      writeTimeoutMs,
    )
    const writeMs = Date.now() - tWrite

    if (r.status === 'timeout') {
      return { ok: false, width, height, encodeMs, writeMs, error: `写入剪贴板超过 ${writeTimeoutMs / 1000}s 没返回` }
    }
    if (r.status === 'error') {
      return { ok: false, width, height, encodeMs, writeMs, error: `写入剪贴板报错：${r.error}` }
    }

    // 「write 没报错」≠「剪贴板里真有一张能粘的图」—— 回读一下再报成功。
    const after = await readImageStatus()
    if (!after.has) {
      return {
        ok: false, width, height, encodeMs, writeMs,
        error: `写完了但剪贴板里读不到图片${after.error ? `（${after.error}）` : ''}`,
      }
    }

    return {
      ok: true, width, height, bytes: png.length,
      encodeMs, writeMs, totalMs: Date.now() - t0,
      method: 'clipboard.write([ClipboardItem])', clipboard: after,
    }
  } catch (err) {
    return { ok: false, error: `复制图像时出错：${err.message}` }
  }
}

/**
 * 给右键菜单用的编排：**先报进度，再干活**。
 *
 * 为什么不能只 send 一下就完事：`createFromPath` / `toPNG` 都是同步的，主进程一进
 * 同步段就再也发不出任何东西。提示必须**先**交出去、并且让出一小段时间让渲染层真的
 * 把它画到屏幕上，然后才去冻 —— 用户报的「点了没反应」有一半就是这个：
 * 活儿其实在干，但屏幕上 5 秒没有任何变化，看起来就像没响应。
 *
 * @param {string} filePath
 * @param {(text:string)=>void} [notify] 同步回调，负责把提示送到界面上
 */
export async function copyImageWithNotice(filePath, notify) {
  const plan = planCopy(filePath)
  if (typeof notify === 'function') {
    notify(plan.width > 0
      ? `正在复制图像（${plan.width}×${plan.height}${plan.mp > 12 ? '，大图转码要几秒' : ''}）…`
      : '正在复制图像…')
    await new Promise((resolve) => { setTimeout(resolve, NOTICE_PAINT_MS) })
  }
  return copyImage(filePath)
}

/* ------------------------------------------------------------------ 打开方式 */

/**
 * 「用其他程序打开…」要跑的命令（纯函数，便于断言）。
 *
 * 走 `rundll32.exe shell32.dll,OpenAs_RunDLL <路径>`：那是 Windows 上
 * 「你要如何打开这个文件？」的经典入口，Electron 没有对应 API。
 *
 * 为什么不用 `SHOpenWithDialog`（shell32 里现代的那个）：它是**模态**的，
 * 直接调会把调用线程的消息循环卡到用户关掉对话框为止 —— 主进程一卡，
 * 看板的缩略图/进度推送全都停摆。另起一个进程就没这个问题，
 * 代价是拿不到返回值、首次弹出慢一秒左右。
 *
 * 用绝对路径而不是裸 `rundll32.exe`：不依赖 PATH 与环境变量，
 * 免得被别的目录里的同名程序抢走（拿不到就退回裸名字，交给系统去解析）。
 */
export function openWithCommand(filePath) {
  const args = ['shell32.dll,OpenAs_RunDLL', filePath]
  // 优先用 %SystemRoot% 拼绝对路径：不依赖 PATH 与当前目录，免得被别的同名程序抢走。
  // **不写死盘符**（项目预检会拦「硬编码绝对路径」，而且盘符本来也不该假设）——
  // 拼不出来就退回裸名字，交给系统按 PATH 解析。
  const sysRoot = process.env.SystemRoot || process.env.windir || ''
  if (sysRoot) {
    const abs = path.join(sysRoot, 'System32', 'rundll32.exe')
    try {
      if (fs.existsSync(abs)) return { exe: abs, args }
    } catch { /* 退裸名字 */ }
  }
  return { exe: 'rundll32.exe', args }
}

/**
 * 单测注入点：正常跑起来就是 `node:child_process` 的 spawn。
 *
 * 为什么要有这个东西：单测里**绝不能真的起进程** —— 那会在用户桌面上弹出真的
 * 「打开方式」对话框（本机实测确认对话框由 OpenWith.exe 画，会一直留在屏幕上）。
 * 所以把 spawn 挂在可替换的对象上，测试换成假的，且顺带能断言参数。
 * 正常代码不要碰它。
 */
export const openWithDeps = { spawn }

/**
 * 弹系统「打开方式」对话框。
 *
 * `detached + unref`：不让子进程挂在应用生命周期上 —— 关掉看板不该把用户
 * 刚打开的看图软件一起关掉。
 *
 * @param {string} filePath
 * @param {{spawn?:Function}} [deps] 单测注入用（缺省读 openWithDeps.spawn）
 * @returns {Promise<{ok:boolean, method?:string, error?:string}>}
 */
export async function openWithDialog(filePath, deps = {}) {
  const spawnFn = deps.spawn || openWithDeps.spawn
  if (!filePath) return { ok: false, error: '没有文件路径' }
  if (process.platform !== 'win32') return { ok: false, error: '「打开方式」对话框只有 Windows 有' }
  try {
    await fsp.access(filePath)
  } catch {
    return { ok: false, error: '文件已经不在了' }
  }

  const { exe, args } = openWithCommand(filePath)
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    try {
      // 实测（tools/probe-openwith.py，2026-09-24）：对话框**不是 rundll32 自己画的**，
      // 它只是把请求转给另一个 OpenWith.exe；rundll32 在调用方这里只有隐藏的
      // `RunDLL`/`IME` 辅助窗口，不阻塞我们的消息循环。所以 windowsHide 开不开都
      // 不影响对话框（两个取值各测一遍，窗口集合完全一样），这里显式写 false，
      // 免得以后有人误以为它管的是对话框。
      const child = spawnFn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', (err) => done({ ok: false, error: `调不出「打开方式」：${err.message}` }))
      if (typeof child.unref === 'function') child.unref()
      // 对话框由另一个进程画，我们这边只确认「拉起来了」
      setTimeout(() => done({ ok: true, method: 'OpenAs_RunDLL' }), 300)
    } catch (err) {
      done({ ok: false, error: err.message })
    }
  })
}
