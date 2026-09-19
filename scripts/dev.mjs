/**
 * 开发模式: 起 Vite dev server, 再把它的地址通过 VITE_DEV_SERVER_URL 传给 Electron。
 * 渲染进程改代码即时热更, 主进程/预加载改了需要手动重启(脚本会提示)。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findElectron, electronEnv } from './electron-path.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = findElectron()
const VITE_PORT = Number(process.env.TV_DEV_PORT || 5178)
const DEV_URL = `http://localhost:${VITE_PORT}`

console.log('[tag-viewer] electron:', exe)

// 1) 先起 vite, 等它就绪
const vite = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
)

let started = false
const onViteOut = (buf) => {
  const s = buf.toString()
  process.stdout.write(s)
  if (!started && /Local:\s+http/.test(s)) {
    started = true
    startElectron()
  }
}
vite.stdout.on('data', onViteOut)
vite.stderr.on('data', (b) => process.stderr.write(b))
// 兜底: 10s 还没解析出地址也硬起
setTimeout(() => { if (!started) { started = true; startElectron() } }, 10000)

function startElectron() {
  const child = spawn(exe, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: electronEnv({ VITE_DEV_SERVER_URL: DEV_URL }),
  })
  child.on('exit', (code) => {
    vite.kill()
    process.exit(code ?? 0)
  })
}

process.on('SIGINT', () => { try { vite.kill() } catch {} process.exit(0) })
