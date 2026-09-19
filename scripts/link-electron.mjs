/**
 * 把本机已有的 Electron 运行时「接」进 node_modules/electron。
 *
 * 为什么需要这步: electron 这个 npm 包本身只是个下载器 + 启动器,
 * 真正的 electron.exe 在 postinstall 阶段下载(约 110MB)。
 * 本机 D 盘已经有好几份完整的 Electron 44.3.0 dist, 没必要再下一份。
 *
 * 做法: 安装时用 --ignore-scripts 跳过下载, 然后本脚本把已有的 dist 目录
 *       复制/硬链到 node_modules/electron/dist, 并补上 path.txt。
 *       复制用硬链(junction 更省空间, 但跨盘符不行), 失败则退回复制。
 *
 * 候选来源(见 scripts/local-config.mjs): TV_ELECTRON_DIST 环境变量
 *   -> local.config.json 的 electronDist(本机专属, 不进仓库)
 *   -> <用户目录>/AppData/Local/electron/Cache(官方下载缓存)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { electronCandidates } from './local-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PKG_DIR = path.join(ROOT, 'node_modules', 'electron')
const TARGET = path.join(PKG_DIR, 'dist')
const QUIET = process.argv.includes('--quiet')

const log = (...a) => { if (!QUIET) console.log('[electron-link]', ...a) }

/** 判断一个目录是不是完整的 Electron dist */
function isDist(dir) {
  try {
    return fs.existsSync(path.join(dir, 'electron.exe'))
      && fs.existsSync(path.join(dir, 'version'))
  } catch { return false }
}

function readDistVersion(dir) {
  try { return fs.readFileSync(path.join(dir, 'version'), 'utf8').trim() } catch { return '' }
}

function readCandidates() {
  const out = [...electronCandidates()]
  // 官方下载缓存: 以前下载过 Electron 的机器会有这里, 顺手当最后一个候选
  out.push(path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'))
  return out
}

/** 复制目录(硬链优先; 失败退回逐文件复制) */
function copyTree(src, dst) {
  let linked = 0, copied = 0
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true })   // 每层都要建, 不能只建根
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, ent.name)
      const dp = path.join(d, ent.name)
      if (ent.isDirectory()) { walk(sp, dp); continue }
      if (!ent.isFile()) continue
      try {
        fs.linkSync(sp, dp)          // 硬链: 同一卷上不占额外空间
        linked++
      } catch {
        fs.copyFileSync(sp, dp)      // 跨卷 / 不支持硬链
        copied++
      }
    }
  }
  walk(src, dst)
  return { linked, copied }
}

function main() {
  if (isDist(TARGET)) {
    log('已就绪:', TARGET, '(v' + readDistVersion(TARGET) + ')')
    return
  }
  if (!fs.existsSync(PKG_DIR)) {
    log('还没装 electron 包, 先跑 npm install 再执行 npm run setup:electron')
    return
  }

  const wanted = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version } catch { return '' }
  })()

  for (const cand of readCandidates()) {
    if (!cand || !fs.existsSync(cand)) continue
    // 允许 candidates 直接指向 dist, 或指向包含 dist 的上层目录
    let dist = cand
    if (!isDist(dist) && isDist(path.join(cand, 'dist'))) dist = path.join(cand, 'dist')
    if (!isDist(dist)) continue

    const ver = readDistVersion(dist)
    if (wanted && ver && ver !== wanted) {
      log(`跳过 v${ver} (${dist}) —— 与 package.json 要求的 v${wanted} 不一致`)
      continue
    }
    log(`复用本机 Electron v${ver}: ${dist}`)
    try {
      const { linked, copied } = copyTree(dist, TARGET)
      fs.writeFileSync(path.join(PKG_DIR, 'path.txt'), 'electron.exe')
      log(`已接入 ${TARGET} (硬链 ${linked} 个文件, 复制 ${copied} 个)`)
      return
    } catch (e) {
      log('接入失败:', e.message, '—— 尝试下一个候选')
    }
  }

  // 兜底: 让 electron 包自己去下载
  log('没找到可复用的 Electron dist, 回退到官方下载(约 110MB)...')
  const inst = path.join(PKG_DIR, 'install.js')
  if (fs.existsSync(inst)) {
    const r = spawnSync(process.execPath, [inst], { stdio: 'inherit', cwd: PKG_DIR })
    if (r.status === 0 && isDist(TARGET)) { log('下载完成'); return }
  }
  log('⚠️  Electron 运行时不可用。可任选一种修法:')
  log('   1) 设 TV_ELECTRON_DIST=<完整 dist 目录> 后重跑 npm run setup:electron')
  log('   2) 在 local.config.json 的 electronDist 里加一条路径(模板见 local.config.example.json)')
  log('   3) 直接 npm rebuild electron 走官方下载')
}

main()
