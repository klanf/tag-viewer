/**
 * 用外部程序打开一个文件(右键「用其他程序打开」背后那一下)
 * ========================================================
 * 单独成模块是为了**能脱离 electron 单测** —— ipc.js 一 import 就整条 electron
 * 依赖链, 纯 node 里根本跑不起来, 而这段恰恰是最容易悄悄失效的地方。
 *
 * 两个硬要求:
 *   1. 成败必须**等真实事件**再结算。第一版 spawn 之后立刻 resolve(true),
 *      而 error 事件是异步晚到的(路径不存在 / 权限不足 / 不是可执行文件),
 *      于是失败被吞成"成功" —— 表现就是用户点了 Inpaint 完全没反应、连提示都没有
 *      (2026-10-16 实测反馈)。'spawn' 事件 = 系统真的拉起了进程, 才算成功。
 *   2. cwd 给 exe 所在目录。绿色版单 exe(Inpaint 这种)按相对路径找自己的资源,
 *      从应用目录起来会白启动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function spawnOpenWith(exe, imgPath) {
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const child = spawn(exe, [imgPath], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe),
      })
      child.on('error', (err) => done({ ok: false, error: err?.message || String(err) }))
      child.on('spawn', () => done({ ok: true }))
      child.unref()
      // 兜底: 极端情况两个事件都不来(系统策略拦下但不报错), 3 秒后按成功结算, 别把界面挂住
      setTimeout(() => done({ ok: true }), 3000)
    } catch (err) {
      done({ ok: false, error: err?.message || String(err) })
    }
  })
}

/** Inpaint 固定预置项(2026-10-16 用户指定); 不存在就不进菜单 */
// path-check-ignore: 这就是真实预置路径 —— 用户指定的外部程序位置, 本来就是要写死的
export const INPAINT_EXE = 'F:\\软件\\Inpaint_v9.1_x64.exe'

/**
 * Photoshop 自动探测(结果缓存): 只扫常见安装目录, 不碰注册表 —— 本机 reg.exe 已被
 * 安全策略拉黑, 文件系统扫描够用且够快(两级 readdir)。找不到返回 null。
 */
let psExeCache
export function detectPhotoshop() {
  if (psExeCache !== undefined) return psExeCache
  psExeCache = null
  // path-check-ignore: PS 官方默认安装根目录 + 本机软件盘, 探测目标本来就是固定盘符位置
  const roots = [
    'C:\\Program Files\\Adobe',
    'C:\\Program Files (x86)\\Adobe',
    // path-check-ignore: 本机习惯把绿色版装在 F:\软件 下(PS 可能并不在 Program Files)
    'F:\\软件',
    'D:\\Program Files\\Adobe',
  ]
  for (const root of roots) {
    let subs = []
    try { subs = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const d of subs.filter((x) => x.isDirectory() && /Adobe Photoshop/i.test(x.name))) {
      const direct = path.join(root, d.name, 'Photoshop.exe')
      try { if (fs.statSync(direct).isFile()) { psExeCache = direct; break } } catch { /* 下一个 */ }
      // 兼容子目录布局: Adobe Photoshop XXXX 里再套一层
      let inner = []
      try { inner = fs.readdirSync(path.join(root, d.name), { withFileTypes: true }) } catch { continue }
      for (const s of inner.filter((x) => x.isDirectory())) {
        const nested = path.join(root, d.name, s.name, 'Photoshop.exe')
        try { if (fs.statSync(nested).isFile()) { psExeCache = nested; break } } catch { /* 下一个 */ }
      }
      if (psExeCache) break
    }
    if (psExeCache) break
  }
  return psExeCache
}
