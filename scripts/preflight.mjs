/**
 * 静态预检 —— 抓 Node ESM 在真正 import 时才会暴露的两类低级错误
 * =============================================================
 * 起因: imageproto.js 里写了 `import { getThumb } from './thumbs.js'`
 * (实际在 ./core/thumbs.js), vite 只管渲染进程, 这个错要等 Electron
 * 启动时才炸, 报出来的还是 "App threw an error during load", 排查挺绕。
 *
 * 这里只做五件事, 但能挡住绝大多数"一启动就挂 / 静默不工作":
 *   1. 每个相对 import 的目标文件是否真的存在
 *   2. 从目标模块 import 的具名导出是否存在
 *   3. preload 白名单与 ipc.js 注册表是否一一对应       (见 checkChannels)
 *   4. 启动脚本的编码/换行符是否正确                    (见 check-launchers.mjs)
 *   5. 模板里有没有引用 <script setup> 未定义的名字       (见 check-templates.mjs)
 *   6. 源码里有没有写死的盘符绝对路径                    (见 check-paths.mjs)
 * 不解析语法树, 用正则在源码上扫 —— 对这些规整的模块文件足够准, 且零依赖。
 * (第 5 项用了 Vue 官方编译器, 因为"未定义绑定"只有编译期才看得出来)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLaunchers } from './check-launchers.mjs'
import { checkTemplates } from './check-templates.mjs'
import { checkPaths } from './check-paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      walk(p, out)
    } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs') || e.name.endsWith('.cjs')) {
      out.push(p)
    }
  }
  return out
}

function exportsOf(src) {
  const set = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
    set.add(m[1])
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (t) set.add(t)
    }
  }
  if (/export\s+default/.test(src)) set.add('default')
  if (/export\s*\*/.test(src)) set.add('*')
  return set
}

/**
 * channel 白名单与注册表必须一一对应
 * ==================================
 * preload.cjs 里的 CHANNELS 是渲染进程能调的"能力清单", ipc.js 里的 map 是
 * 主进程实际注册的 handler。两边只要差一个名字, 表现就是渲染进程调用直接抛
 * 「未授权的 channel: xxx」—— 错误信息不提是谁没对齐, 得两边对着看才能发现。
 * 所以把它做成启动前就能报出来的检查。
 */
function extractQuotedSet(src, marker) {
  const i = src.indexOf(marker)
  if (i < 0) return null
  const j = src.indexOf('])', i)
  if (j < 0) return null
  const body = src.slice(i, j)
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

/**
 * 禁用「会静默崩掉整个进程」的 API
 * =================================
 * `fs.cpSync(from, to, { recursive: true })` 在本机 Node 22.22.2 上拷贝**目录**时
 * 会让进程硬崩: 退出码 3221226505(0xC0000409, fail-fast)。要命的是它崩得毫无征兆 ——
 * stdout 缓冲区里已经写好的东西**全部丢失**, 外面只能看到一个"退出码 127、零输出"的
 * 脚本。2026-09-19 加 e2e 翻译库夹具时踩到, 排查了大半天才定位到这一行。
 * (对照实验: cpSync 整个目录 ✗ / cpSync 单个文件 ✓ / copyFileSync 逐个拷 ✓)
 *
 * 换成 `scripts/harness.mjs` 里的 copyTree(), 或自己 mkdir + copyFileSync。
 */
export function checkBannedApis(files = walk(path.join(ROOT, 'scripts')).concat(walk(path.join(ROOT, 'electron')))) {
  const problems = []
  const banned = [
    // why 文案里故意不写出那个调用的字面形式 —— 否则这条检查会把自己也扫出来(踩过一次)
    { re: /\bfs\.cpSync\s*\(/, why: 'cpSync 递归拷贝目录会静默硬崩进程(退出码 0xC0000409)', use: 'copyTree() 或 mkdir + copyFileSync' },
  ]
  for (const f of files) {
    if (!/\.(mjs|js|cjs)$/.test(f)) continue
    const src = fs.readFileSync(f, 'utf8')
    for (const b of banned) {
      if (!b.re.test(src)) continue
      // 允许在注释里提到它(本项目到处在讲这个坑)
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (!b.re.test(codeOnly)) continue
      problems.push({ file: f, kind: `禁用 API: ${b.why} → 改用 ${b.use}` })
    }
  }
  return problems
}

export function checkChannels() {
  const preloadPath = path.join(ROOT, 'electron', 'preload.cjs')
  const ipcPath = path.join(ROOT, 'electron', 'ipc.js')
  if (!fs.existsSync(preloadPath) || !fs.existsSync(ipcPath)) return []

  const allowed = extractQuotedSet(fs.readFileSync(preloadPath, 'utf8'), 'const CHANNELS = new Set([')
  const ipcSrc = fs.readFileSync(ipcPath, 'utf8')
  const registered = new Set([...ipcSrc.matchAll(/^ {4}'([^']+)':\s*safe\(/gm)].map((m) => m[1]))
  if (!allowed || !registered.size) return []

  const problems = []
  for (const ch of registered) {
    if (!allowed.has(ch)) problems.push({ kind: `ipc.js 注册了但 preload 白名单里没有(渲染进程调不到): ${ch}` })
  }
  for (const ch of allowed) {
    if (!registered.has(ch)) problems.push({ kind: `preload 白名单里有但 ipc.js 没注册(调用会报 handler 未注册): ${ch}` })
  }
  // 推送事件单独一组(用 tv.on 订阅)
  const push = extractQuotedSet(fs.readFileSync(ipcPath, 'utf8'), "PUSH_EVENTS = [")
  const pushAllowed = extractQuotedSet(fs.readFileSync(preloadPath, 'utf8'), 'const PUSH = new Set([')
  if (push && pushAllowed) {
    for (const ch of push) if (!pushAllowed.has(ch)) problems.push({ kind: `推送事件 ipc.js 会发但 preload 未放行: ${ch}` })
  }
  return problems
}

export function preflight({ dirs = ['electron', 'scripts', 'src'] } = {}) {
  const files = dirs.flatMap((d) => {
    const p = path.join(ROOT, d)
    return fs.existsSync(p) ? walk(p) : []
  })
  const cache = new Map()
  const expOf = (f) => {
    if (!cache.has(f)) cache.set(f, exportsOf(fs.readFileSync(f, 'utf8')))
    return cache.get(f)
  }

  const problems = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const re = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?)\s*from\s*['"](\.[^'"]+)['"]/g
    for (const m of src.matchAll(re)) {
      const spec = m[1]
      const target = path.resolve(path.dirname(f), spec)
      const cands = [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`, path.join(target, 'index.js')]
      const hit = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
      if (!hit) {
        problems.push({ file: f, spec, kind: '文件不存在' })
        continue
      }
      if (!hit.endsWith('.js') && !hit.endsWith('.mjs') && !hit.endsWith('.cjs')) continue
      // 只核对具名导入
      const named = /import\s*\{([^}]+)\}\s*from/.exec(m[0])
      if (!named) continue
      const set = expOf(hit)
      if (set.has('*')) continue
      for (const raw of named[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim()
        if (!name) continue
        if (!set.has(name)) {
          problems.push({ file: f, spec, kind: `缺少具名导出: ${name}`, target: hit })
        }
      }
    }
  }

  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
  problems.push(...checkChannels())
  problems.push(...checkLaunchers())
  problems.push(...checkTemplates())
  problems.push(...checkPaths())
  problems.push(...checkBannedApis(files))
  if (problems.length) {
    console.log(`✗ 预检发现 ${problems.length} 处问题:`)
    for (const p of problems) {
      console.log(p.file ? `  · ${rel(p.file)}  ->  ${p.spec || ''}   ${p.kind}` : `  · ${p.kind}`)
    }
  } else {
    console.log(`✓ 预检通过: ${files.length} 个文件的所有相对 import 都能解析, `
      + 'IPC channel 两侧一致, 启动脚本编码正确, 模板绑定无遗漏, 源码里没有硬编码绝对路径, '
      + '没有用会静默崩进程的 fs.cpSync')
  }
  return problems
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(preflight().length ? 1 : 0)
}
