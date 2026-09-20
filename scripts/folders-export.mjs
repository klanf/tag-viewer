/**
 * 登记表导出 —— 把 tags.db 的 folders 表写成 `user/folders.json`
 * ===========================================================
 * 与 `npm run db:export`(把标签写回 tags_*.txt)同一个思路:
 * 真源在库里, 但**要留一条把数据搬出来的路** —— 否则"数据锁死在 DB 里"
 * 就成了新的单点。
 *
 * 跑法:
 *   node scripts/folders-export.mjs            写文件, 打印摘要
 *   node scripts/folders-export.mjs --json     额外输出完整 json
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 与 db.mjs 同一套: 用真实用户的 userData 目录, 这样能读到 settings.json 里
// 改过的 dataDir; 没有就回落到 TV_DATA_DIR / 本机 local.config.json / 仓库内 data/。
const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()

const { initWorkspace } = await load('electron/core/workspace.js')
const folders = await load('electron/core/folders.js')

initWorkspace(APP_DIR)

const r = folders.exportFoldersJson()
console.log(`已导出 ${r.folders} 条登记记录 -> ${r.file}`)

const list = folders.listFolders({ usage: 'all' }).folders
const tag = (f) => [f.as_source ? '来源' : '', f.as_scan ? '扫描' : ''].filter(Boolean).join('+') || '(已移出)'
for (const f of list) {
  console.log(`  ${tag(f).padEnd(12)} ${String(f.images).padStart(6)} 张  ${f.name}  <- ${f.path}`)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(list, null, 2))
}
