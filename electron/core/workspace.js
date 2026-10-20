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
  // recentOpenWith: 右键「用其他程序打开」二级菜单的最近使用列表, [{ name, path }]。
  // MRU 语义: 调用方已把最新项放最前, 这里只做去重 + 截断(留 6 个, 菜单别太长)。
  if (Array.isArray(patch.recentOpenWith)) {
    const seen = new Set()
    next.recentOpenWith = patch.recentOpenWith
      .filter((a) => a && typeof a.path === 'string' && a.path && !seen.has(a.path.toLowerCase()) && seen.add(a.path.toLowerCase()))
      .slice(0, 6)
      .map((a) => ({ name: String(a.name || a.path.split(/[\\/]+/).pop() || a.path), path: String(a.path) }))
  }
  // 反推偏好(2026-10-15 设置弹窗): 推理后端覆盖(auto/cuda/dml/cpu) + 置信度阈值。
  // 落 settings.json; 进程内环境变量由 applyTaggerEnv() 同步, 下一次反推生效。
  if (patch.taggerProvider !== undefined) {
    const v = String(patch.taggerProvider)
    next.taggerProvider = ['auto', 'cuda', 'dml', 'cpu'].includes(v) ? v : 'auto'
  }
  if (patch.taggerThreshold !== undefined) {
    const v = Number(patch.taggerThreshold)
    if (Number.isFinite(v)) next.taggerThreshold = Math.min(0.95, Math.max(0.01, v))
  }
  if (patch.taggerCharThreshold !== undefined) {
    const v = Number(patch.taggerCharThreshold)
    if (Number.isFinite(v)) next.taggerCharThreshold = Math.min(0.99, Math.max(0.05, v))
  }
  // groupedTags: 标签展示按分类分组(2026-10-16)。纯展示偏好, 默认开。
  if (patch.groupedTags !== undefined) next.groupedTags = !!patch.groupedTags
  // showBannedTags: 光箱/详情页是否显示被 ban 的标签(2026-10-16)。默认开(与旧行为一致)。
  if (patch.showBannedTags !== undefined) next.showBannedTags = !!patch.showBannedTags
  // lbTagSet: 光箱抽屉显示哪套标签(2026-10-20 双源)。'db'=标签库(反推) / 'meta'=图内元数据。
  if (patch.lbTagSet !== undefined) next.lbTagSet = patch.lbTagSet === 'meta' ? 'meta' : 'db'
  // lbMetaMode: 图内元数据集的显示模式(2026-10-20)。'cats'=分类段位 / 'raw'=原文整段。
  if (patch.lbMetaMode !== undefined) next.lbMetaMode = patch.lbMetaMode === 'raw' ? 'raw' : 'cats'
  // wd14Prompt: WD14 安装横幅的记忆三态(2026-10-18 按需安装 v3)。
  // unset=可弹 / later=暂不(下会话可再弹) / never=永久静默(横幅不弹, 常驻入口仍在)。
  if (patch.wd14Prompt !== undefined) {
    const v = String(patch.wd14Prompt)
    next.wd14Prompt = ['unset', 'later', 'never'].includes(v) ? v : 'unset'
  }
  state.settings = next
  fs.writeFileSync(path.join(state.appDir, 'settings.json'),
    JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 把反推偏好同步进本进程环境变量(tagger_serve.py 在 spawn 时读 env)。
 * main.js 启动时调一次; 设置弹窗保存后也调 —— 服务是每次反推重新拉起的,
 * 所以下一次反推自然用上新值, 不用重启应用。
 * 返回本次实际生效的值(给设置弹窗回显)。
 */
export function applyTaggerEnv() {
  const s = state.settings || {}
  if (s.taggerProvider) process.env.TV_TAGGER_PROVIDER = s.taggerProvider
  if (s.taggerThreshold !== undefined) process.env.TV_WD14_THRESHOLD = String(s.taggerThreshold)
  if (s.taggerCharThreshold !== undefined) process.env.TV_WD14_CHAR_THRESHOLD = String(s.taggerCharThreshold)
  return {
    provider: process.env.TV_TAGGER_PROVIDER || 'auto',
    threshold: Number(process.env.TV_WD14_THRESHOLD ?? 0.35),
    charThreshold: Number(process.env.TV_WD14_CHAR_THRESHOLD ?? 0.85),
  }
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
