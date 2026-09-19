/**
 * 定位 electron.exe —— 候选顺序见 scripts/local-config.mjs 的 electronCandidates():
 *   TV_ELECTRON / TV_ELECTRON_DIST 环境变量
 *   -> local.config.json 的 electronDist(本机专属, 不进仓库)
 *   -> node_modules/electron/dist(标准位置)
 * 供 dev.mjs / run.mjs / probe-*.mjs 复用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { electronCandidates } from './local-config.mjs'

export function findElectron() {
  for (const c of electronCandidates()) {
    // 候选项可以写成 dist 目录(含 electron.exe)或直接指向 electron.exe
    const exe = c.toLowerCase().endsWith('.exe') ? c : path.join(c, 'electron.exe')
    if (fs.existsSync(exe)) return exe
  }
  throw new Error(
    '找不到 electron.exe。\n' +
    '  修法: 跑一次 `npm install`(会自动复用本机已有的 Electron 运行时),\n' +
    '        或设环境变量 TV_ELECTRON=<electron.exe 完整路径>,\n' +
    '        或把本机 dist 目录写进 local.config.json 的 electronDist(见 local.config.example.json)。'
  )
}

/** Electron 主进程需要的环境: 剔除执行层注入的 ELECTRON_RUN_AS_NODE, 否则它会被当成纯 Node 跑 */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
