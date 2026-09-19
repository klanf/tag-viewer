/**
 * 硬编码路径守卫 —— 把"去硬编码"变成可回归的约束
 * ================================================
 * 背景: 这个项目原本散着 8 处开发机绝对路径(默认数据目录 3 处、日志目录 2 处、
 * 脚本候选路径 2 处、夹具输出目录 1 处), 是靠人工 grep 一轮轮清的。
 * 人工清的东西会随着下一次改动长回来 —— 所以固化成本检查, 接进 npm run check。
 *
 * 判定: 源码里出现**盘符绝对路径**(`X:\` / `X:/`)、`%USERPROFILE%`、`C:/Users/`
 * 一律算命中, 除非:
 *   · 该行(或其上方 3 行内)写着 `path-check-ignore`  —— 用于"这就是个示例文本"的场合
 *   · 整个文件登记在 scripts/paths-allowlist.json 里(需要写理由)
 *
 * 为什么盘符前要加 negative lookbehind:
 *   否则 `https://` 里的 `s:/`、`file://` 里的 `e:/`、`tv://` 里的 `v:/` 都会被误判。
 *   加上 `(?<![A-Za-z0-9_$:])` 之后, 只有真正的"盘符开头"才算。
 *
 * 不扫什么(以及为什么):
 *   · *.md / 交接日志 / README —— 文档里写路径示例是合法的, 也是必要的
 *   · data/       —— 用户数据, 本来就含本机路径, 且不进仓库
 *   · logs/ .e2e-work/ node_modules/ dist/ —— 运行期产物 / 依赖 / 构建输出
 *   · *.example.json —— 示例模板, 里面的路径就是给人照抄的
 *
 * 负向对照(改完请手动确认一次):
 *   往 electron/core/workspace.js 里临时插一行 `const P = 'D:/tmp/x'`,
 *   `npm run check` 必须**变红**并指出该行; 删掉后必须变绿。否则这检查只是装饰。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫描范围 */
const SCAN_DIRS = ['electron', 'scripts', 'src']
/** 根目录下这几个扩展名的文件也扫(.bat/.vbs 里同样可能有本机路径) */
const ROOT_EXT = ['.bat', '.vbs']
const EXTS = ['.js', '.mjs', '.cjs', '.vue', '.json', '.py', '.bat', '.vbs']

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.e2e-work', '.selftest-userdata',
  'logs', 'data',
])
/** 豁免文件(整文件粒度) —— 全在这里是因为它们本身就是"机器配置"或"示例" */
const SKIP_FILES = new Set([
  'paths-allowlist.json',
  'local.config.json',
  'local.config.example.json',
])

/** 行内豁免标记: 命中行或其上方 LOOKBACK 行内出现它, 就跳过 */
const IGNORE_MARK = 'path-check-ignore'
const LOOKBACK = 3

/** 盘符绝对路径 / 环境变量写法。negative lookbehind 用来躲开 https:// file:// tv:// */
const PATTERNS = [
  { re: /(?<![A-Za-z0-9_$:])[A-Za-z]:[\\/]/g, label: '盘符绝对路径' },
  { re: /%USERPROFILE%/g, label: 'USERPROFILE 环境变量' },
]

function allowlist() {
  try {
    const p = path.join(ROOT, 'scripts', 'paths-allowlist.json')
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out)
    } else if (EXTS.includes(path.extname(e.name))) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

function collectFiles() {
  const files = SCAN_DIRS.flatMap((d) => {
    const p = path.join(ROOT, d)
    return fs.existsSync(p) ? walk(p) : []
  })
  // 根目录的启动脚本
  for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (name.isFile() && ROOT_EXT.includes(path.extname(name.name))) {
      files.push(path.join(ROOT, name.name))
    }
  }
  return files.filter((f) => !SKIP_FILES.has(path.basename(f)))
}

/**
 * @returns {{file?:string, kind:string}[]}  与 preflight 的 problems 同构
 */
export function checkPaths() {
  const allowed = allowlist()
  const problems = []

  for (const f of collectFiles()) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    if (allowed[rel]) continue

    let lines
    try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/) } catch { continue }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes(IGNORE_MARK)) continue
      // 上方 LOOKBACK 行内有豁免标记也放行(Vue 模板里注释放不进属性列表, 只能放上一行)
      let exempt = false
      for (let k = Math.max(0, i - LOOKBACK); k < i; k++) {
        if (lines[k].includes(IGNORE_MARK)) { exempt = true; break }
      }
      if (exempt) continue

      for (const { re, label } of PATTERNS) {
        re.lastIndex = 0
        const m = re.exec(line)
        if (!m) continue
        problems.push({
          file: f,
          spec: `第 ${i + 1} 行`,
          kind: `硬编码路径(${label}): ${line.trim().slice(0, 100)}`,
        })
        break
      }
    }
  }
  return problems
}

/** 允许单独跑: npm run test:paths */
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const problems = checkPaths()
  if (problems.length) {
    console.log(`✗ 硬编码路径检查发现 ${problems.length} 处:`)
    for (const p of problems) {
      console.log(`  · ${path.relative(ROOT, p.file).replace(/\\/g, '/')}  ${p.spec}  ${p.kind}`)
    }
    console.log('\n  若是"示例文本"而非真实路径, 在该行(或上方 3 行内)写 path-check-ignore;')
    console.log('  若是整个文件都要豁免, 登记到 scripts/paths-allowlist.json 并写明理由。')
  } else {
    console.log(`✓ 硬编码路径检查通过: ${collectFiles().length} 个文件里没有盘符绝对路径`)
  }
  process.exit(problems.length ? 1 : 0)
}
