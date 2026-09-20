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

/**
 * Electron 主进程需要的环境: 剔除执行层注入的 ELECTRON_RUN_AS_NODE, 否则它会被当成纯 Node 跑。
 *
 * 另外**默认关掉后台增量同步**(TV_INGEST=0): 测试与 dev 起的是同一份代码,
 * 而 e2e 沙箱里的 tag_viewer_config.json 是从真实数据目录拷来的 ——
 * 沙箱库会自动从 tags_*.txt 建出 folders 行(根目录是用户真实的盘符路径),
 * 于是"启动后台同步"会真的去 stat 用户 F 盘那 4 万多张图, 顺手把新增图写进沙箱库,
 * 把「5 images」「68,376 条结果」这类断言全部带偏, 还白扫几分钟磁盘。
 * 真实使用者走 `启动看板.bat` 直接起 electron, 不经这里, 所以默认是开的。
 * 想测同步行为就显式传 { TV_INGEST: '1' }。
 *
 * `TV_TAGGER=0` 一并默认关掉(阶段 3 起): 反推比同步更贵 —— 要拉 python 子进程 +
 * 加载 1.27GB 模型, 而且**会把标签写进沙箱库**。它的自启闸门本来就与 TV_INGEST 共用
 * (见 main.js 的 scheduleTagging), 这里显式写上是为了让意图可见、也方便单独开。
 */
export function electronEnv(extra = {}) {
  const env = { ...process.env, TV_INGEST: '0', TV_TAGGER: '0', ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
