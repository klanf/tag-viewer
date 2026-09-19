/** 生产模式启动: 先 vite build, 再用 Electron 加载 dist/ */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findElectron, electronEnv } from './electron-path.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = findElectron()
const args = process.argv.slice(2)

console.log('[tag-viewer] electron:', exe)

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: ROOT, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
    p.on('error', reject)
  })
}

// 需要先构建渲染进程(除非显式跳过)
const skipBuild = process.env.TV_SKIP_BUILD === '1'
if (!skipBuild) {
  console.log('[tag-viewer] vite build ...')
  await run(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])
}

const child = spawn(exe, ['.', ...args], { cwd: ROOT, stdio: 'inherit', env: electronEnv() })
child.on('exit', (code) => process.exit(code ?? 0))
