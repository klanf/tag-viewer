/**
 * 本机专属配置（**不进仓库**）
 * ================================
 * 开源后仓库里不能出现任何开发机的绝对路径。但开发时又确实需要指向本机的
 * Electron 运行时 / 数据目录 / 旧版工具根目录。折中:
 *
 *   机器专属的值  ->  local.config.json   (被 .gitignore 排除)
 *   仓库里留下的  ->  local.config.example.json (模板, 入库)
 *
 * 优先级: 环境变量 > local.config.json > 各脚本自己的**仓库内相对**默认值
 *
 * 改造前这些值是硬编码在各脚本里的(共 8 处), 现在只有这一个来源。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const LOCAL_CONFIG_NAME = 'local.config.json'
const FILE = path.join(ROOT, LOCAL_CONFIG_NAME)

let _cache = null

/** 读 local.config.json（允许 // 行注释；不存在或解析失败一律当空对象） */
export function localConfig() {
  if (_cache) return _cache
  let obj = {}
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed
  } catch { /* 没有这个文件是正常情况(开源用户 / 新克隆) */ }
  _cache = obj
  return obj
}

/** 测试用: 丢掉缓存, 让下次调用重新读盘 */
export function resetLocalConfig() {
  _cache = null
}

/**
 * 数据目录 —— 供 selftest / db / harness 等命令行工具使用。
 * 环境变量沿用 TV_DATA_DIR（与 electron/core/workspace.js 同一个名字, 不要另起一个）。
 */
export function localDataDir() {
  const env = process.env.TV_DATA_DIR
  if (env && env.trim()) return path.resolve(env)
  const cfg = localConfig().dataDir
  if (typeof cfg === 'string' && cfg.trim()) return path.resolve(cfg)
  return path.join(ROOT, 'data')
}

/**
 * electron.exe 候选列表（按顺序试）
 *   TV_ELECTRON      —— 直接指向 electron.exe
 *   local.config.json 的 electronDist —— 可以是 dist 目录, 也可以是含 dist 的上层目录
 *   node_modules/electron/dist —— npm install + postinstall 后的标准位置
 */
export function electronCandidates() {
  const out = []
  const env = process.env.TV_ELECTRON || process.env.TV_ELECTRON_DIST
  if (env && env.trim()) out.push(path.resolve(env))

  const cfg = localConfig().electronDist
  for (const p of [].concat(cfg || [])) {
    if (typeof p === 'string' && p.trim()) out.push(path.resolve(p))
  }
  out.push(path.join(ROOT, 'node_modules', 'electron', 'dist'))
  return out
}

/** 旧版 Python 工具根目录（只有 scripts/build-char-lib.mjs 的迁移路径用得到） */
export function localOldRoot() {
  const env = process.env.TV_OLD_ROOT
  if (env && env.trim()) return path.resolve(env)
  const cfg = localConfig().oldRoot
  if (typeof cfg === 'string' && cfg.trim()) return path.resolve(cfg)
  return ''
}

/**
 * 把 local.config.json 里的机器专属值导出成 `TV_*` 环境变量。
 *
 * 为什么绕一道环境变量, 而不是让用到的模块直接读这个文件
 * ------------------------------------------------------
 * `electron/core/*` 是**打包后也要跑**的代码, 它不能依赖 `scripts/`
 * (打包产物里根本没有这个目录, import 会直接炸)。而环境变量在两种形态下都成立:
 * 开发期由这里注入, 打包后由用户自己设(或写进 settings.json)。
 * 已经存在的环境变量不覆盖 —— 命令行临时指定的优先级最高。
 *
 * 调用点:
 *   · scripts/tagger.mjs 等 CLI —— 直接调
 *   · electron/main.js —— 仅开发期(`!app.isPackaged`)在启动最前面调一次
 */
export function applyLocalEnv(env = process.env) {
  const c = localConfig()
  const map = {
    TV_OLD_ROOT: c.oldRoot,       // 旧版工具根目录(WD14 模型就住在它的 model/ 下)
    TV_PYTHON: c.pythonPath,      // 反推用的 python 解释器
    TV_WD14_MODEL: c.wd14Model,   // 显式覆盖模型路径(一般不必填, 有 oldRoot 就够)
    TV_WD14_CSV: c.wd14Csv,
  }
  const applied = []
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string' || !v.trim()) continue
    if (env[k] && String(env[k]).trim()) continue
    env[k] = v.trim()
    applied.push(k)
  }
  return applied
}
