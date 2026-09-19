/**
 * 模板绑定检查 —— 找出「模板里引用了、但 <script setup> 里根本没定义」的名字
 * =======================================================================
 * 为什么需要这个:
 *
 * 2026-09-18 踩过一次。给大图预览加「上一张/下一张」时, 首页/系列页/标签页三个
 * 视图的模板里都写了 `@open="(it) => lb.open(it.path, { list: imgPaths })"`,
 * 但**只有扫描页真的定义了 `imgPaths`**。另外三个视图里 `imgPaths` 是 undefined。
 *
 * 后果:
 *   · 不报错、不崩 —— `<script setup>` 编译出来是 `$setup.imgPaths`, 取不到就是
 *     undefined, 传入 `{ list: undefined }`, store 回退成单张列表;
 *   · **生产构建里连 Vue 的警告都没有**(开发期那句
 *     "Property "imgPaths" was accessed during render but is not defined on instance"
 *     带 __DEV__ 判断, `vite build` 会整段摇掉) —— 所以 e2e 里
 *     "运行期无 Vue 警告" 这条断言也拦不住它;
 *   · 表现只是「翻页按钮不出现」, 看起来像功能没做, 不像 bug。
 * 是 e2e 的「左右翻页按钮已渲染 = 2」把它抓出来的。
 *
 * 原理:
 *   Vue 编译器在 `prefixIdentifiers` 下, **能解析到 setup 绑定**的名字会编译成
 *   `$setup.xxx`, **解析不到**的会编译成 `_ctx.xxx`。所以只要拿 `compileScript`
 *   给出的 bindings 当 bindingMetadata 去编译模板, 再扫产物里有没有 `_ctx.<名字>`,
 *   就能精确指出模板引用了哪些不存在的绑定。
 *
 * 这是**静态**检查, 不需要起 Electron, 几秒钟跑完, 已接进 preflight。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 只查这些目录下的 .vue */
const SCAN_DIRS = ['src']

/** 允许缺少的例外: 名字 -> 为什么(这些是 Vue 运行时提供的, 不在 setup 里) */
const ALLOW = new Map([
  // Vue 内置($ 开头的一律跳过, 这里只列非 $ 开头的)
])

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

/**
 * 取模板里所有「解析不到 setup 绑定」的引用。
 * @returns {{ name: string, line: number }[]}
 */
function unresolvedBindings(file) {
  const source = fs.readFileSync(file, 'utf8')
  const { descriptor, errors } = parse(source, { filename: file })
  if (errors?.length) throw new Error(`SFC 解析报错: ${errors[0].message}`)
  if (!descriptor.template) return []

  // 1) 拿到 <script setup> 导出的绑定表(变量/函数/import 进来的组件都算)
  let bindings = {}
  if (descriptor.scriptSetup || descriptor.script) {
    const id = 'tvcheck'
    const script = compileScript(descriptor, { id, inlineTemplate: false, genDefaultAs: '__sfc__' })
    bindings = script.bindings || {}
  }

  // 2) 用这份绑定表编译模板 —— 能解析的走 $setup, 解析不到的落 _ctx
  const tpl = compileTemplate({
    id: 'tvcheck',
    filename: file,
    source: descriptor.template.content,
    compilerOptions: {
      bindingMetadata: bindings,
      prefixIdentifiers: true,
      // 不生成 source map, 但保留位置信息
      mode: 'module',
    },
  })

  const out = []
  const seen = new Set()
  // 模板块内容在 .vue 文件里的起始行 —— 报错要报文件行号, 不是模板块内行号
  const tplStartLine = descriptor.template.loc.start.line
  // _ctx.foo / _ctx['foo'] 两种都可能出现
  const reDot = /_ctx\.([A-Za-z_$][\w$]*)/g
  const reIdx = /_ctx\["([^"]+)"\]/g
  for (const re of [reDot, reIdx]) {
    let m
    while ((m = re.exec(tpl.code))) {
      const name = m[1]
      if (name.startsWith('$')) continue            // $slots / $attrs / $emit / $event ...
      if (ALLOW.has(name)) continue
      if (seen.has(name)) continue
      seen.add(name)
      // 反查它在模板里的行号, 再换算成 .vue 文件里的行号
      const idx = descriptor.template.content.indexOf(name)
      const line = idx < 0 ? 0 : tplStartLine + descriptor.template.content.slice(0, idx).split('\n').length - 1
      out.push({ name, line })
    }
  }
  return out
}

/**
 * 返回 problems 数组(与 preflight 的其它检查同构: { file, kind }),
 * 空数组 = 全部干净。可以直接被 preflight 收进去一起报。
 */
export function checkTemplates() {
  const files = SCAN_DIRS.flatMap((d) => {
    const p = path.join(ROOT, d)
    return fs.existsSync(p) ? walk(p) : []
  }).sort()

  const problems = []
  for (const f of files) {
    let bad
    try {
      bad = unresolvedBindings(f)
    } catch (e) {
      problems.push({ file: f, kind: `解析失败: ${e.message}` })
      continue
    }
    for (const b of bad) {
      problems.push({
        file: f,
        kind: `模板引用了未定义的名字 「${b.name}」` + (b.line ? `（.vue 第 ${b.line} 行）` : ''),
      })
    }
  }
  problems.count = files.length          // 附带回文件数, 给单跑时的输出用
  return problems
}

function main() {
  const problems = checkTemplates()
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
  if (problems.length) {
    console.log(`✗ 模板绑定检查: 发现 ${problems.length} 处问题`)
    for (const p of problems) console.log(`  · ${rel(p.file)}  ->  ${p.kind}`)
    return 1
  }
  console.log(`✓ 模板绑定检查: ${problems.count} 个组件, 模板里没有引用未定义的 setup 绑定`)
  return 0
}

// 直接跑 / 被 import 都行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}
