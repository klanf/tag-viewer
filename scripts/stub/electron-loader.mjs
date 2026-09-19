/**
 * ESM 加载钩子 —— 把 `import ... from 'electron'` 重定向到本目录的桩
 * ==================================================================
 * 纯 Node 里没有 electron 模块, 所以主进程代码没法直接 import。
 * 这个 resolve 钩子只在 specifier 恰好是 'electron' 时短路成桩文件,
 * 其余导入一律走 Node 默认解析。
 *
 * 用法(必须在 import 业务代码之前调用, 且用动态 import):
 *   import { register } from 'node:module'
 *   register('./stub/electron-loader.mjs', import.meta.url)
 *   const { registerIpc } = await import('../electron/ipc.js')
 */
const STUB_URL = new URL('./electron.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: STUB_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
