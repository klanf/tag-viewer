/**
 * 清理 dist 里的过期产物
 * =======================
 * 背景: vite.config 现在用**固定文件名**构建, 所以正常构建是覆盖而不是重建,
 * dist/assets 的文件数恒定。但历史上(改用固定名之前)留下的带哈希文件会一直躺在那里,
 * 加上将来若某个 chunk 被删掉, 它的旧文件也不会自己消失。这个脚本负责收拾这些残留。
 *
 * 安全约束: 一次删太多文件会撞上执行环境的批量删除保护, 所以这里**先数再删**,
 * 超过上限只报告不动手 —— 让人来确认, 而不是把保护绕过去。
 *
 * 用法:
 *   node scripts/prune-dist.mjs          只报告(默认, 预演)
 *   node scripts/prune-dist.mjs --apply  真的删(文件数在上限内时)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const ASSETS = path.join(DIST, 'assets')
const APPLY = process.argv.includes('--apply')

/** 单次删除上限 —— 与执行环境的保护阈值保持一致, 别调高 */
const MAX_DELETE = 40

/**
 * 判定"过期"的规则 —— 刻意做得**保守**, 宁可留下也不误删
 * ==================================================
 * 只删这一种: `Name-<8位哈希>.js/css` 且同目录下存在**去掉哈希版本**的 `Name.js/css`。
 *
 * 第一版我按"从 index.html 里抓 assets 引用"来找被引用的文件, 结果是错的:
 * vite 的 `base: './'` 会把 chunk 引用写成相对路径 `./HomeView.js`,
 * 正则匹配不到, 于是 24 个**正在用**的文件被判成过期 —— 再执行 --apply 就把 dist 删空。
 * 换个思路: 不去猜"谁在被引用"(容易猜错), 只认"带哈希的旧命名的确已经被固定名取代"
 * 这一种铁证。不匹配这个模式的文件一律不动。
 */
const HASHED = /^(.+)-[A-Za-z0-9_-]{8}\.(js|css|png|jpg|svg|woff2?)$/

if (!fs.existsSync(ASSETS)) {
  console.log('· dist/assets 不存在, 先跑一次 npm run build')
  process.exit(0)
}

const all = fs.readdirSync(ASSETS)
const present = new Set(all)
const stale = all.filter((f) => {
  const m = HASHED.exec(f)
  return !!m && present.has(`${m[1]}.${m[2]}`)
})

console.log(`dist/assets: 共 ${all.length} 个文件, 其中"带哈希且已有固定名替代"的旧产物 ${stale.length} 个`)
for (const f of stale.slice(0, 20)) console.log(`   · ${f}`)
if (stale.length > 20) console.log(`   ... 其余 ${stale.length - 20} 个`)

if (!stale.length) {
  console.log('✓ 没有过期产物')
  process.exit(0)
}
if (!APPLY) {
  console.log('\n当前是预演模式, 没有删任何东西。确认后执行:')
  console.log('   node scripts/prune-dist.mjs --apply')
  process.exit(0)
}
if (stale.length > MAX_DELETE) {
  console.log(`\n✗ 过期文件 ${stale.length} 个, 超过单次上限 ${MAX_DELETE} —— 不代劳, 请手工清理。`)
  process.exit(1)
}

// 单个文件逐个删: 走的不是"整目录批量删除"那条路, 可控且可回滚
let n = 0
for (const f of stale) {
  fs.rmSync(path.join(ASSETS, f), { force: true })
  n++
}
console.log(`\n✓ 已删除 ${n} 个过期文件`)
