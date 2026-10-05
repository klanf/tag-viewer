/**
 * 工作目录与运行时设置
 * =====================
 * 两类路径要分清:
 *   - appDir (userData): 本应用自己的设置, 存 settings.json
 *   - dataDir: 用户积累下来的黑名单 / 替换规则 / 背景补全 / 用户元数据 /
 *     购物车历史 / 缩略图缓存 / 翻译库 / 标签库。
 *
 * 解析优先级(具体实现在 paths.js, 这里是唯一真源的唯一调用方):
 *   dataDir:  settings.json > TV_DATA_DIR 环境变量 > (main.js 开 allowPortable 时)
 *             与应用同目录的可写 data/(绿色包数据随包走) > 调用方注入的默认值 > <appDir>/data
 *   config :  settings.json.configPath > <dataDir>/tag_viewer_config.json
 *
 * 改造说明(2026-09-19): 原来这里有个 `LEGACY_DIR = '<开发机绝对路径>'` 兜底,
 * 开源后它指向别人的机器; 而且那个目录在本机其实**已经空了**(只剩 static/ 与几个
 * py/bat), 真数据早就迁到本项目的 data/ 下。现在默认值改成 <userData>/data,
 * 由 main.js / scripts/local-config.mjs 注入, 本模块不再知道任何机器绝对路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataDir, resolveConfigPath, resolveDataFilePath } from './paths.js'

const state = {
  appDir: '',
  dataDir: '',
  configPath: '',
  settings: {},
  /** 启动时数据目录尚不存在(被下面 ensureDir 新建了) —— 首启向导的判据之一 */
  dataDirMissing: false,
  /** 数据源配置文件是否已存在 —— 没有它就没有任何标签数据 */
  configExists: false,
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }) } catch { /* 忽略 */ }
}

/**
 * 由 main.js 在 app.whenReady() 之后调用一次。
 *
 * @param {string} appDir userData 目录
 * @param {{defaultDataDir?:string}} [opts]
 *   defaultDataDir: settings.json 与环境变量都没指定 dataDir 时用它。
 *   main.js 传 <userData>/data; 命令行工具(selftest/db)传仓库内 data/。
 *   **必须由调用方注入** —— 本模块不能 import electron(见 paths.js 顶部注释)。
 */
export function initWorkspace(appDir, opts = {}) {
  state.appDir = appDir
  ensureDir(appDir)

  const settingsPath = path.join(appDir, 'settings.json')
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (!settings || typeof settings !== 'object') settings = {}
  } catch { settings = {} }
  state.settings = settings

  const dataDir = resolveDataDir({
    settingsDataDir: settings.dataDir,
    envDataDir: process.env.TV_DATA_DIR,
    defaultDataDir: opts.defaultDataDir,
    appDir: state.appDir,
    // 绿色包/仓库开发的 portable 模式: 与应用同目录的可写 data/ 优先(仅 main.js 开启,
    // CLI 工具与测试不传 —— 否则自造数据目录的测试会被仓库内真实的 data/ 抢走)
    allowPortable: opts.allowPortable === true,
  })
  state.dataDir = dataDir
  state.configPath = resolveConfigPath({
    settingsConfigPath: settings.configPath,
    dataDir,
  })

  // 顺序重要: 先记下"当时存不存在", 再创建 —— 建完再判断永远是 false
  state.dataDirMissing = !dirExists(dataDir)
  state.configExists = fs.existsSync(state.configPath)
  ensureDir(dataDir)

  return getWorkspace()
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

export function getWorkspace() {
  return {
    appDir: state.appDir,
    dataDir: state.dataDir,
    configPath: state.configPath,
    dataDirMissing: state.dataDirMissing,
    configExists: state.configExists,
  }
}

export function getSettings() {
  return state.settings
}

/** 合并写入 settings.json(只允许白名单字段, 避免渲染进程塞任意值进来) */
export function saveSettings(patch) {
  const next = { ...state.settings }
  for (const k of ['dataDir', 'configPath', 'lastPickDir']) {
    if (patch[k] === undefined) continue
    next[k] = patch[k] === null ? '' : String(patch[k])
  }
  // firstRunDone: 首次启动向导是否已完成。本轮只做读写与持久化(还没有向导界面),
  // 下一轮做设置页/向导时直接用它判断"要不要自动跳过去引导", 免得再加一个字段。
  if (patch.firstRunDone !== undefined) {
    next.firstRunDone = !!patch.firstRunDone
  }
  // quickFolders: 右键「移动到」的预设文件夹, [{ name, path }] 数组, 只留两个字段
  if (Array.isArray(patch.quickFolders)) {
    next.quickFolders = patch.quickFolders
      .filter((f) => f && typeof f.path === 'string' && f.path)
      .slice(0, 50)
      .map((f) => ({
        name: String(f.name || f.path.split(/[\\/]+/).pop() || f.path),
        path: String(f.path),
      }))
  }
  state.settings = next
  fs.writeFileSync(path.join(state.appDir, 'settings.json'),
    JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 数据目录下的文件路径 —— **全项目唯一的数据文件入口**。
 *
 * 分类到子目录的规则不在这里, 在 paths.js 的 DATA_ROUTE(见那里的注释):
 * 文件该放 kb/ user/ rules/ cache/ 还是根, 只有那一张表说了算。
 * 本函数只负责把它拼成绝对路径, 并处理**兼容期回退**:
 * 新位置没有、旧位置(根目录)还有时, 继续用旧的那份 —— 于是"接上路由"
 * 与"真的搬文件"可以分两步走, 中间中断也不会文件找不到。
 *
 * 未登记的名字(如 tags.db / tag_viewer_config.json)原样留在根目录。
 */
export function dataFile(name) {
  return resolveDataFilePath(state.dataDir, name)
}

/** 数据目录此刻是否真的存在(注意 initWorkspace 会主动创建它) */
export function dataDirExists() {
  return dirExists(state.dataDir)
}

/** 是否该走首次启动引导: 用户没标记过完成 且 目前没有可用的数据源配置 */
export function isFirstRun() {
  return !state.settings.firstRunDone || !state.configExists
}
