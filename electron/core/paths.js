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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录(本文件在 electron/core/ 下, 往上两级) */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 仓库内置的「知识」目录 —— 随仓库分发的那份 WeiLin 翻译库住这里
 * (来源与授权见 knowledge/README.md)。数据目录下自动发现不到 weilin_data* 时,
 * translate.js 回落到这里, 让新装机器**零配置**就有中文标签。
 */
export const BUNDLED_KNOWLEDGE_DIR = path.join(PROJECT_ROOT, 'knowledge')

/**
 * 内置统一翻译库(scripts/build-translations-db.py 把 WeiLin 两个库 +
 * local_translations.json 合成的一个 SQLite)。打包后经 extraResources 落在
 * resources/ 下 —— **必须读这个真实文件**, asar 里的虚拟路径 node:sqlite 的
 * 原生 sqlite3 打不开(2.2.0 首发翻译整体消失的根因)。开发态回落仓库 assets/。
 */
export function bundledTranslationsDb() {
  const packed = process.resourcesPath ? path.join(process.resourcesPath, 'translations.db') : ''
  if (packed && fs.existsSync(packed)) return packed
  return path.join(PROJECT_ROOT, 'assets', 'translations.db')
}
export const BUNDLED_TRANSLATIONS_DB = bundledTranslationsDb()

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
 * @param {{settingsDataDir?:string, envDataDir?:string, defaultDataDir?:string, appDir?:string, allowPortable?:boolean}} o
 *   allowPortable: 仅 main.js(绿色包/仓库开发形态)开启 —— 与应用同目录存在**可写**的
 *   data/ 就优先用它(数据随包走, 删文件夹即卸载)。显式配置(settings.json/TV_DATA_DIR)
 *   仍然优先; CLI 工具与测试不传, 解析行为不变。electron-builder 打包态下同目录在
 *   asar 里, 可写探测必然失败, 自动回落 <userData>/data, 无需分支。
 */
export function resolveDataDir({ settingsDataDir, envDataDir, defaultDataDir, appDir, allowPortable } = {}) {
  const cands = [
    settingsDataDir,
    envDataDir,
    allowPortable && dirWritable(path.join(PROJECT_ROOT, DATA_DIR_NAME))
      ? path.join(PROJECT_ROOT, DATA_DIR_NAME)
      : '',
    defaultDataDir,
    appDir ? path.join(appDir, DATA_DIR_NAME) : '',
  ]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return path.resolve(c)
  }
  // 最后的兜底也是**仓库内相对路径**, 不是机器绝对路径 —— 开源后仍然成立
  return path.resolve(PROJECT_ROOT, DATA_DIR_NAME)
}

/** 目录存在、是目录、且真能创建/删除文件(asar 与只读位置都过不了这一关) */
function dirWritable(p) {
  try {
    if (!fs.statSync(p).isDirectory()) return false
    const probe = path.join(p, `.tv-write-probe-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
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
 * WeiLin 翻译库(2026-10-02)已随仓库内置在 knowledge/, 来源与授权现状写在
 * knowledge/README.md —— 目录名里的第三方署名原样保留, 权利人要求即移除。
 */
export const KNOWLEDGE_FILES = ['local_translations.json', 'character_library.json']
export const KNOWLEDGE_DIR_PREFIXES = ['weilin_data']

/**
 * U 用户数据 —— 用户个人的积累, **绝不出机器**。README 的隐私承诺就指这一组。
 */
export const USER_FILES = [
  'export_blacklist.txt',   // 屏蔽标签
  'export_view_tags.txt',   // 视角/机位剔除词表(种子来自随机机位交接文档)
  'export_replace.txt',     // 替换规则
  'export_bg.txt',          // 背景补全规则
  'user_meta.json',         // 用户元数据(收藏/备注)
  'cart_history.json',      // 购物车结算历史
  'export_presets.json',    // 导出预设(自动导出用)
  'scan_folders.json',      // 扫描文件夹收藏夹(含本机路径)
  'dupcheck_ignore.json',   // 查重误报忽略表(图片对)
  'cart_preset.json',       // 购物车自动导出预设(DATA_ROUTE 登记过, 分类表此前漏登记)
  'replace_sets.json',      // 替换规则组(同上)
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

/* ------------------------------------------------- 数据目录的子目录路由 */

/**
 * 为什么要有路由表
 * ================
 * 改造前 data/ 根目录平铺着 15 个条目(7 个 json/txt + 缩略图目录 + 翻译目录 + 库),
 * 光看目录名分不清「哪些是用户积累的、哪些删了能重建、哪些将来要给别人」——
 * 而这三类东西的**处置方式完全不同**(备份谁 / 能不能删 / 开源时带不带)。
 * 分类知识本来就在上面的三分法里, 只是没落到磁盘上。
 *
 * 于是这里把分类变成**唯一的路由表**, 由 workspace.js 的 dataFile() 独占使用。
 * 全项目的数据文件读写都经过 dataFile(), 所以路由表一改, 所有读点自动跟着走
 * (不需要去 20 个调用点里逐个改路径)。
 *
 * 刻意留在根目录的
 * ================
 * `tags.db`(+ -wal/-shm) 与 `tag_viewer_config.json` 不登记:
 *   · tags.db 是唯一真源且体积大、每次启动都开, 留根省得嵌套;
 *   · config 是"启动时还不知道数据目录在哪"就要读的文件, 必须能按固定名字找到。
 */
export const DATA_SUBDIRS = Object.freeze({
  knowledge: 'kb',
  user: 'user',
  rules: 'rules',
  derived: 'cache',
})

/**
 * 裸文件名 -> 归属。`as` = 迁移时顺便改名(旧名继续可读, 见下面 resolve)
 *
 * 键是**改造前的旧名字** —— 兼容期里旧名字必须一直是有效入参,
 * 调用点不必知道文件搬去了哪。
 */
export const DATA_ROUTE = Object.freeze({
  // K 知识: 内容是标签翻译/角色映射, 不含图片, 将来作为「知识包」分发
  'local_translations.json': { kind: 'knowledge' },
  'character_library.json': { kind: 'knowledge' },
  // U 用户数据: 用户自己的积累, 绝不出机器
  'user_meta.json': { kind: 'user' },
  'cart_history.json': { kind: 'user' },
  // 导出预设(含目标目录这类本机路径) -> user/export_presets.json
  'export_presets.json': { kind: 'user' },
  // 购物车自动导出预设(单份, 同样含目标目录这类本机路径) -> user/cart_preset.json
  'cart_preset.json': { kind: 'user' },
  // 替换规则组(2026-10-04, 多套规则手动命名、导出时选) -> user/replace_sets.json
  'replace_sets.json': { kind: 'user' },
  // 登记表: 真源是 tags.db 的 folders 表, 这份 json 降级为「导出备份 + 首次导入源」
  'scan_folders.json': { kind: 'user', as: 'folders.json' },
  // 查重误报忽略表(2026-10-17): 图片对 id 键, 用户个人判断, 归 U 用户数据
  'dupcheck_ignore.json': { kind: 'user' },
  // U 规则: 导出词表
  'export_bg.txt': { kind: 'rules' },
  'export_blacklist.txt': { kind: 'rules' },
  'export_view_tags.txt': { kind: 'rules' },
  'export_replace.txt': { kind: 'rules' },
  // D 派生: 删了能重建, 但内含本机路径
  'scan_cache.json': { kind: 'derived' },
})

/** 目录类的搬迁(阈值低、只有两个) */
export const DATA_DIR_ROUTE = Object.freeze({
  '.thumb_cache': { kind: 'derived' },
})

/**
 * 一个名字(文件或目录)在 data/ 下的**目标相对路径**。
 * 未登记的名字原样返回(留在根) —— 这是刻意行为, 不是遗漏。
 */
export function dataRelPath(name) {
  const n = String(name || '')
  if (!n) return n
  const hit = DATA_ROUTE[n] || DATA_DIR_ROUTE[n]
  if (hit) {
    const file = DATA_ROUTE[n] ? (hit.as || n) : n
    return `${DATA_SUBDIRS[hit.kind]}/${file}`
  }
  // weilin_data*(翻译库)按前缀归 kb —— 目录名带第三方署名, 不能写死全名
  if (KNOWLEDGE_DIR_PREFIXES.some((p) => n.startsWith(p))) {
    return `${DATA_SUBDIRS.knowledge}/${n}`
  }
  return n
}

/** 这个名字是否登记过(会搬 / 会改名) */
export function isRouted(name) {
  const n = String(name || '')
  return !!(DATA_ROUTE[n] || DATA_DIR_ROUTE[n]
    || KNOWLEDGE_DIR_PREFIXES.some((p) => n.startsWith(p)))
}

/**
 * 解析数据文件的实际路径 —— **兼容期回退**在这里。
 *
 * 新位置存在 -> 用新位置; 新位置没有但根目录还有 -> 继续用根目录那份。
 * 于是"改代码"和"搬文件"可以分开做: 先把路由接上(行为零变化), 再跑
 * scripts/data-migrate.mjs 把文件搬过去, 搬完自动切到新位置, 中途任何一步
 * 中断都不会出现"文件找不到"。
 *
 * @param {string} dataDir
 * @param {string} name      裸文件名(旧名或新名都行)
 * @param {(p:string)=>boolean} [exists] 便于测试注入
 */
export function resolveDataFilePath(dataDir, name, exists) {
  const n = String(name || '')
  const full = (rel) => path.join(dataDir || '.', rel)
  const primary = full(dataRelPath(n))
  if (!isRouted(n)) return primary          // 没登记 -> 就在根, 没什么可回退的
  const has = exists || ((p) => {
    try { return fs.existsSync(p) } catch { return false }
  })
  if (has(primary)) return primary
  const legacy = full(n)
  if (legacy !== primary && has(legacy)) return legacy
  return primary                            // 两边都没有 -> 报新位置(写入方据此新建)
}
