/**
 * 配置读取 —— 兼容 Python 版那种「带 // 行注释的 JSON」。
 * 字段与原 tag_viewer_config.json 完全一致, 所以可以直接复用同一份文件:
 *   data_files_dir / data_file / data_files / translate_dir / port
 */
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspace } from './workspace.js'

/** 去掉 // 行注释后解析(配置里不会出现 URL, 所以简单文本处理足够) */
export function parseLooseJson(text) {
  const stripped = text.replace(/^\s*\/\/.*$/gm, '')
  try {
    return JSON.parse(stripped)
  } catch {
    // Windows 反斜杠路径: 路径里带中文目录名时, `\壁` 这类不是合法转义序列, 换成 / 再试
    try { return JSON.parse(stripped.replace(/\\/g, '/')) } catch { return {} }
  }
}

export function loadConfig() {
  const { configPath } = getWorkspace()
  if (!fs.existsSync(configPath)) return {}
  try {
    return parseLooseJson(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 解析多来源配置 -> Map<来源名, 文件路径>
 * 优先级: cliData > data_files_dir(扫 tags_*.txt) > data_files(对象/数组) > data_file
 *
 * 都没有时返回**空 Map**（改造前这里兜底成一个开发机上的绝对路径, 开源后毫无意义）。
 * 空 Map 不是错误状态, 两条下游都已经照顾到:
 *   · store.js 的 syncSources 见到空集会直接返回, **不会**把库里已有的来源删掉;
 *   · dataset.js 此时会走「从 tags.db 读」的路线 —— 配置丢了但本地索引还在, 照样能用;
 *   · 连库里也没有数据时, 由 dataset.js 抛「没有可用的标签数据」, 界面走空态引导。
 */
export function resolveDataFiles(cfg, cliData) {
  if (cliData) return new Map([[sourceNameFromPath(cliData), cliData]])

  const dir = cfg.data_files_dir
  if (dir && isDir(dir)) {
    const out = new Map()
    let names = []
    try { names = fs.readdirSync(dir).sort() } catch { names = [] }
    for (const name of names) {
      if (!name.startsWith('tags_') || !name.endsWith('.txt')) continue
      if (name === 'tags_all.txt') continue          // 汇总文件会与各来源重复
      const fp = path.join(dir, name)
      out.set(sourceNameFromPath(fp), fp)
    }
    if (out.size) return out
  }

  const d = cfg.data_files
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const out = new Map()
    for (const [k, v] of Object.entries(d)) if (v) out.set(String(k), String(v))
    if (out.size) return out
  }
  if (Array.isArray(d) && d.length) {
    const out = new Map()
    for (const fp of d) if (fp) out.set(sourceNameFromPath(fp), fp)
    if (out.size) return out
  }
  if (cfg.data_file) return new Map([[sourceNameFromPath(cfg.data_file), cfg.data_file]])

  return new Map()
}

/** tags_涩涩涩涩涩.txt -> 涩涩涩涩涩; 其他文件名则去掉扩展名 */
export function sourceNameFromPath(fp) {
  const base = path.basename(fp)
  let name = base.replace(/^tags_/, '')
  name = name.slice(0, name.length - path.extname(name).length)
  return name || base
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
