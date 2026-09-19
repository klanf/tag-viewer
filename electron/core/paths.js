/**
 * 路径解析 —— 全项目唯一真源
 * =============================
 * 为什么单独抽出来: 改造前仓库里有 **3 份等价的「默认数据目录」**
 * (workspace.js 的 LEGACY_DIR、selftest.mjs 的字面量、harness.mjs 的 realDataDir)
 * 和 **2 份日志目录实现**(main.js 与 core/filelog.js, 且对 TV_LOG_DIR 的语义还不一致)。
 * 改一处漏两处, 于是统一到这里, 其他地方只从这里取。
 *
 * ⚠️ 本模块**禁止 import electron**
 * =================================
 * scripts/selftest.mjs 与 scripts/db.mjs 会在**纯 Node(无 Electron)** 下 import
 * workspace.js, 而 workspace.js 会 import 本模块。一旦这里出现 `import 'electron'`,
 * 那两个脚本立刻挂 —— 而且 `npm run check` 的 preflight **发现不了**
 * ('electron' 是 npm 包, specifier 能解析成功, 只有运行时才炸)。
 * 所以凡是需要 Electron 才知道的值(app.isPackaged / app.getPath('userData')),
 * 一律由调用方**注入参数**传进来。
 *
 * 数据文件三分法
 * ==============
 * 见文件末尾的 KNOWLEDGE_FILES / USER_FILES / DERIVED_FILES —— 供下一轮的
 * electron-builder extraResources 与「知识包」生成使用, 也是 .gitignore 的依据。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录(本文件在 electron/core/ 下, 往上两级) */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 数据目录的默认名 —— 挂 <userData>/data 或 <仓库>/data */
export const DATA_DIR_NAME = 'data'

/* ------------------------------------------------------------------ dataDir */

/**
 * 解析数据目录。优先级: settings.json > 环境变量 > 调用方注入的默认值 > <appDir>/data
 *
 * 为什么默认是 <userData>/data 而不是某个开发机绝对路径:
 *   打包后 __dirname 在 asar 里, 写不进去; 而 userData 是每个用户各自的**可写**目录。
 *   开发期由 main.js 注入, 命令行工具由 scripts/local-config.mjs 注入。
 *
 * @param {{settingsDataDir?:string, envDataDir?:string, defaultDataDir?:string, appDir?:string}} o
 */
export function resolveDataDir({ settingsDataDir, envDataDir, defaultDataDir, appDir } = {}) {
  const cands = [
    settingsDataDir,
    envDataDir,
    defaultDataDir,
    appDir ? path.join(appDir, DATA_DIR_NAME) : '',
  ]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return path.resolve(c)
  }
  // 最后的兜底也是**仓库内相对路径**, 不是机器绝对路径 —— 开源后仍然成立
  return path.resolve(PROJECT_ROOT, DATA_DIR_NAME)
}

/** 配置文件名(带 // 行注释的宽松 JSON, 解析在 core/config.js 的 parseLooseJson) */
export const CONFIG_NAME = 'tag_viewer_config.json'

/** 解析数据源配置文件路径: settings > <dataDir>/tag_viewer_config.json */
export function resolveConfigPath({ settingsConfigPath, dataDir } = {}) {
  if (typeof settingsConfigPath === 'string' && settingsConfigPath.trim()) {
    return path.resolve(settingsConfigPath)
  }
  return path.resolve(dataDir || PROJECT_ROOT, CONFIG_NAME)
}

/* ------------------------------------------------------------------ logDir */

/** 启动日志文件名 / 就绪标记文件名(启动脚本按这两个名字找, 不要改) */
export const LOG_NAME = 'launch.log'
export const READY_NAME = 'ready.flag'

/**
 * 解析日志目录。
 *   1. TV_LOG_DIR 环境变量 —— **语义统一为「目录」**
 *      (改造前 main.js 当目录、core/filelog.js 当完整文件路径, 同一个变量两处不一致;
 *       一旦有人设了它, 两份日志会写到不同文件, 所以在这里定死为目录)
 *   2. 打包后 —— <userData>/logs
 *      打包后 __dirname 解析到 resources/app.asar/electron, 项目内 logs/ 落在只读区,
 *      appendFileSync 会静默失败(异常被 catch 吞掉), 排障能力直接归零。
 *   3. 开发期 —— <仓库>/logs
 *      **必须与原行为逐字一致**: 启动看板.bat / .vbs 靠 logs\ready.flag 判定启动成败,
 *      路径一变两个启动脚本就会误报"启动失败"。
 */
export function resolveLogDir({ envLogDir, isPackaged, userDataPath, projectRoot = PROJECT_ROOT } = {}) {
  if (typeof envLogDir === 'string' && envLogDir.trim()) return path.resolve(envLogDir)
  if (isPackaged && userDataPath) return path.join(userDataPath, 'logs')
  return path.join(projectRoot, 'logs')
}

/**
 * 日志目录的单例 —— main.js 在模块加载期算一次并 setLogDir(), 其他模块只读。
 * 这样解决三件事:
 *   ① main.js 里求值发生在 app ready **之前**, 不适合让其他模块各自去问 Electron;
 *   ② core/filelog.js 不必 import electron(否则会污染 scripts/stub 下的桩测试);
 *   ③ 两份实现合并成一份, 不会再各写各的。
 */
let _logDir = ''

export function setLogDir(dir) {
  _logDir = typeof dir === 'string' ? dir : ''
}

/** 未被 setLogDir 时(命令行工具/测试)回落到「仓库内 logs/」 */
export function getLogDir() {
  if (_logDir) return _logDir
  return resolveLogDir({ envLogDir: process.env.TV_LOG_DIR })
}

export const logFile = () => path.join(getLogDir(), LOG_NAME)
export const readyFlag = () => path.join(getLogDir(), READY_NAME)

/* ------------------------------------------------------- 数据文件三分法 */

/**
 * K 知识 —— 内容是"标签/角色/系列映射"这类知识, 不含图片, 是**可分发**的。
 * 下一轮做成知识包(带版本号, 见交接日志 P1)时的素材清单。
 * ⚠️ 授权待核实: weilin_data 目录名里带第三方署名, 来源与许可需在开源文档里写清。
 */
export const KNOWLEDGE_FILES = ['local_translations.json', 'character_library.json']
export const KNOWLEDGE_DIR_PREFIXES = ['weilin_data']

/**
 * U 用户数据 —— 用户个人的积累, **绝不出机器**。README 的隐私承诺就指这一组。
 */
export const USER_FILES = [
  'export_blacklist.txt',   // 屏蔽标签
  'export_replace.txt',     // 替换规则
  'export_bg.txt',          // 背景补全规则
  'user_meta.json',         // 用户元数据(收藏/备注)
  'cart_history.json',      // 购物车结算历史
  'scan_folders.json',      // 扫描文件夹收藏夹(含本机路径)
]
export const USER_DIRS = ['.thumb_cache']

/**
 * D 可再生派生物 —— 删掉能重建, 但**内含本机文件路径**。
 *   tags.db        : 由配置里的 tags_*.txt 同步生成(启动自动同步 / npm run db:import)
 *   scan_cache.json: 扫描结果缓存, 重扫即可重建
 * 所以不随仓库分发; 下一轮若要"知识数据内置随包", 必须从中**提炼**出
 * 只有标签/系列/角色、剥掉图片路径的子集, 不能整库外发。
 */
export const DERIVED_FILES = [
  'tags.db', 'tags.db-shm', 'tags.db-wal',
  'scan_cache.json',
]

/** 给一个数据目录下的文件名/目录名, 判断属于哪一类 */
export function classifyDataEntry(name) {
  const n = String(name || '')
  if (KNOWLEDGE_FILES.includes(n)) return 'knowledge'
  if (USER_FILES.includes(n) || USER_DIRS.includes(n)) return 'user'
  if (DERIVED_FILES.includes(n)) return 'derived'
  if (KNOWLEDGE_DIR_PREFIXES.some((p) => n.startsWith(p))) return 'knowledge'
  return 'unknown'
}
