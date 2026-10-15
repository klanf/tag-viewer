/**
 * 标签中英翻译
 * ============
 * 两个来源, 后者只补前者没有的:
 *   1. WeiLin 标签库(SQLite): userdatas_zh_CN_danbooru.db / danbooru_tag
 *                              userdatas_zh_CN_tags.db    / tag_tags
 *   2. local_translations.json: 用户自己用 translate_missing.py 跑出来的 AI 补译
 *
 * SQLite 用 **node:sqlite**(Electron 44 内置, 依赖 Node 24)。这是选它的原因:
 *   原生模块 better-sqlite3 需要按 Electron ABI 重编译(electron-rebuild),
 *   sql.js 要额外带一个 1.5MB 的 wasm。内置模块两者都不需要。
 *   实测(Electron 44.3.0 / Node 24.20.0): 读 danbooru_tag 6000 行 OK。
 *
 * 目录从哪来(2026-09-19 修)
 * -------------------------
 * 以前只认配置里的 `translate_dir` 绝对路径, 而且目录不存在时**静默返回空 Map**。
 * 于是把 weilin_data 挪个位置(或换台机器), 翻译就整体消失: 界面只剩纯英文标签,
 * 没有任何报错、日志里也没有一行记录 —— 实测就是这么丢的, 排查了半天。
 * 现在:
 *   ① 配置里的路径有效          -> 用它(优先, 允许指到数据目录外面)
 *   ② 配置为空 / 路径不存在     -> 在**数据目录下**自动找 `weilin_data*`
 *      (paths.js 的 KNOWLEDGE_DIR_PREFIXES 早就把这类目录定义为"知识目录",
 *       所以放进数据目录就该直接被认出来, 不需要用户再手写一遍绝对路径)
 *   ③ 数据目录也没有            -> 回落**内置统一库** translations.db(scripts/
 *      build-translations-db.py 在构建期把 WeiLin 两个库 + local_translations.json
 *      合成的一个 SQLite, extraResources 随包发) —— 新装机器零配置就有中文标签
 *   ④ 连内置库都读不到           -> 不启用翻译, 并把 dirMissing 标成 true
 * 实际用了哪个目录、配置里的路径是不是失效了, 都通过 translateInfo() 如实报出去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataFile, getWorkspace } from './workspace.js'
import { BUNDLED_TRANSLATIONS_DB, BUNDLED_KNOWLEDGE_DIR, KNOWLEDGE_DIR_PREFIXES } from './paths.js'

const state = {
  map: new Map(),        // 小写标签 -> 中文
  zhIndex: null,         // 中文 -> [标签] 懒构建(给中文输入补全用)
  sources: { weilin: 0, local: 0 },
  loaded: false,
  error: '',
  /** 实际用到的 WeiLin 目录(可能 0 个 / 1 个 / 多个) */
  dirs: [],
  /** 配置里写的那个路径(原样, 可能为空或已失效) —— 排障时要能看到它 */
  dirWanted: '',
  /** 配置写了路径但那个目录不存在 —— 界面/日志据此提示"翻译库没找到" */
  dirMissing: false,
  /** 这批目录是怎么定下来的: 'config'(配置有效) | 'auto'(自动发现) | 'bundled'(仓库内置) | 'none' */
  dirSource: 'none',
}

function openReadOnly(p) {
  return new DatabaseSync(p, { readOnly: true })
}

/**
 * 从 WeiLin 的两个库里读出 英文 -> 中文, 多个目录合并(先出现的优先)。
 * 目录不存在的情况不在这里判 —— 调用方已经解析过了(见 resolveWeiLinDirs)。
 */
function loadWeiLin(dirs) {
  const out = new Map()
  for (const dir of dirs) loadWeiLinInto(out, dir)
  return out
}

function loadWeiLinInto(out, dir) {
  if (!dir || !isDir(dir)) return
  const jobs = [
    ['userdatas_zh_CN_danbooru.db', 'danbooru_tag', 'tag', 'translate'],
    ['userdatas_zh_CN_tags.db', 'tag_tags', 'text', 'desc'],
  ]
  for (const [file, table, kcol, vcol] of jobs) {
    const fp = path.join(dir, file)
    if (!fs.existsSync(fp)) continue
    let db
    try {
      db = openReadOnly(fp)
      const rows = db.prepare(`SELECT ${kcol} AS k, ${vcol} AS v FROM ${table}`).all()
      for (const r of rows) {
        if (r.k && r.v) out.set(String(r.k).toLowerCase(), String(r.v))
      }
    } catch (e) {
      state.error = `${path.join(dir, file)}: ${e.message}`
    } finally {
      try { db?.close() } catch { /* 忽略 */ }
    }
  }
  return out
}

function loadLocal() {
  const p = dataFile('local_translations.json')
  if (!fs.existsSync(p)) return new Map()
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!d || typeof d !== 'object') return new Map()
    const m = new Map()
    for (const [k, v] of Object.entries(d)) {
      if (k && v && typeof v === 'string') m.set(k.toLowerCase(), v)
    }
    return m
  } catch {
    return new Map()
  }
}

/**
 * 内置统一翻译库(assets/translations.db, 构建期由 scripts/build-translations-db.py
 * 把 WeiLin 两个库 + local_translations.json 合成一张表)。作为最底层的兜底:
 * 用户没配也没放任何 weilin_data* 时, 新装机器开箱就有中文。
 * 真实文件(打包后经 extraResources 落在 resources/ 下), 不在 asar 里 ——
 * node:sqlite 的原生 sqlite3 打不开 asar 虚拟路径, 2.2.0 首发就是踩的这个坑。
 */
function loadBundledDb(fp = BUNDLED_TRANSLATIONS_DB) {
  if (!fp || !fs.existsSync(fp)) return null
  let db
  try {
    db = new DatabaseSync(fp, { readOnly: true })
    const rows = db.prepare('SELECT en, zh FROM translations').all()
    const m = new Map()
    for (const r of rows) {
      if (r.en && r.zh) m.set(String(r.en).toLowerCase(), String(r.zh))
    }
    return m
  } catch (e) {
    state.error = `${fp}: ${e.message}`
    return null
  } finally {
    try { db?.close() } catch { /* 忽略 */ }
  }
}

/**
 * 在某个目录下找 weilin_data* 子目录(paths.js 的 KNOWLEDGE_DIR_PREFIXES 约定)。
 * 排序后返回, 保证多台机器/多次启动的结果稳定。找到几个就返回几个 ——
 * 允许用户把翻译库拆成多个 weilin_data(...) 目录放进来。
 */
function findWeiLinDirsIn(baseDir) {
  if (!baseDir) return []
  let names = []
  try { names = fs.readdirSync(baseDir).sort() } catch { return [] }
  const out = []
  for (const n of names) {
    if (!KNOWLEDGE_DIR_PREFIXES.some((p) => n.startsWith(p))) continue
    const fp = path.join(baseDir, n)
    if (isDir(fp)) out.push(fp)
  }
  return out
}

function findWeiLinDirsInDataDir() {
  return findWeiLinDirsIn(getWorkspace().dataDir)
}

/**
 * 决定这次要用哪些 WeiLin 目录。
 *   ① 配置路径有效        -> 只用配置里那个(人家明确指定了, 就不要自作主张再合并别的)
 *   ② 否则自动发现        -> 用数据目录下的 weilin_data*
 *   ③ 数据目录没有        -> 回落到仓库内置的 knowledge/(BUNDLED_KNOWLEDGE_DIR,
 *                            随仓库分发的那份, 见 knowledge/README.md) —— 新装机器零配置
 *   ④ 连内置都没有        -> []
 *
 * @param {string} translateDir 配置里的 translate_dir
 * @param {{autoDetect?: boolean, bundledDir?: string}} [opts]
 *   autoDetect=false 时严格按配置来(②③都跳过, 给测试用);
 *   bundledDir 可注入替换(测试用它扮演"内置也没有")。
 * @returns {{dirs: string[], source: 'config'|'auto'|'bundled'|'none', wanted: string, missing: boolean}}
 */
export function resolveWeiLinDirs(translateDir, { autoDetect = true, bundledDir = BUNDLED_KNOWLEDGE_DIR } = {}) {
  const wanted = String(translateDir || '').trim()
  if (wanted && isDir(wanted)) {
    return { dirs: [wanted], source: 'config', wanted, missing: false }
  }
  if (autoDetect) {
    const auto = findWeiLinDirsInDataDir()
    if (auto.length) return { dirs: auto, source: 'auto', wanted, missing: !!wanted }
    const bundled = findWeiLinDirsIn(bundledDir)
    if (bundled.length) return { dirs: bundled, source: 'bundled', wanted, missing: !!wanted }
  }
  return { dirs: [], source: 'none', wanted, missing: !!wanted }
}

/**
 * @param {string} translateDir 配置里的 translate_dir(绝对路径), 空则去数据目录里自动找
 * @param {{autoDetect?: boolean}} [opts] autoDetect=false 时严格按配置来(给测试用)
 */
export function loadTranslations(translateDir, opts = {}) {
  const r = resolveWeiLinDirs(translateDir, opts)
  state.error = ''                       // 每次加载都是一次全新解析, 不留上一轮的错
  // 合并优先级: 内置统一库(兜底) < 用户 weilin 目录(覆盖) < local_translations.json(活补译)
  const bundled = r.dirs.length ? null : loadBundledDb(opts.bundledDb)
  const weilin = loadWeiLin(r.dirs)
  const local = loadLocal()
  const map = new Map(bundled || [])
  let added = 0
  for (const [k, v] of weilin) {
    if (!map.has(k)) { map.set(k, v); added++ }
  }
  let localAdded = 0
  for (const [k, v] of local) {
    if (!map.has(k)) { map.set(k, v); localAdded++ }
  }
  state.map = map
  state.zhIndex = null
  state.sources = {
    weilin: weilin.size,
    bundled: bundled ? bundled.size : 0,
    local: local.size,
    localAdded,
  }
  // 内置库兜底生效时, dirs 报库文件路径, 来源仍标 'bundled'(界面显示"仓库内置")
  state.dirs = r.dirs.length ? r.dirs : (bundled ? [opts.bundledDb || BUNDLED_TRANSLATIONS_DB] : [])
  state.dirSource = r.dirs.length ? r.source : (bundled ? 'bundled' : 'none')
  state.dirWanted = r.wanted
  state.dirMissing = r.missing && !bundled
  // 配置里写了路径但不存在 —— 这是最容易被忽略的一种坏法(不说话就少一半翻译),
  // 所以即使自动发现救回来了, 也要留下 error 文案让人知道该去改配置。
  if (r.missing) {
    const note = `translate_dir 不存在: ${r.wanted}`
    state.error = state.error ? `${note}; ${state.error}` : note
  }
  state.loaded = true
  return state.sources
}

export function translateMap() { return state.map }
export function translateInfo() {
  const { dataDir } = getWorkspace()
  return {
    loaded: state.loaded,
    total: state.map.size,
    ...state.sources,
    error: state.error,
    dataDir,
    // 实际用了哪里的翻译库 —— 界面上"翻译怎么没了"这类问题全靠这三个字段定位
    dirs: state.dirs,
    dirSource: state.dirSource,
    dirWanted: state.dirWanted,
    dirMissing: state.dirMissing,
  }
}

/** 查一个标签的中文(原样返回原名, 找不到就不返回) */
export function translateOne(tag) {
  return state.map.get(String(tag).toLowerCase()) || ''
}

/** 批量查: { 原标签: 中文 } —— 只含查到的 */
export function translateMany(tags) {
  const out = {}
  for (const t of tags) {
    const zh = state.map.get(String(t).toLowerCase())
    if (zh) out[t] = zh
  }
  return out
}

/** 中文 -> 标签 反向索引(懒构建一次) */
export function zhIndex() {
  if (state.zhIndex) return state.zhIndex
  const idx = new Map()
  for (const [tag, zh] of state.map) {
    if (!zh) continue
    const k = zh.toLowerCase()
    let arr = idx.get(k)
    if (!arr) { arr = []; idx.set(k, arr) }
    arr.push(tag)
  }
  state.zhIndex = idx
  return idx
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
