// 词条管线第三层 · 随机重组抽签 CLI
// 核心引擎已抽到 electron/core/random.js(与看板 UI 的「随机抽签」弹层共用)。
// 这里只管命令行参数解析与输出。
//
// 用法:
//   node scripts/random-prompt.mjs --n 5                    # 自由抽签 5 组
//   node scripts/random-prompt.mjs --char=hoshino_(blue_archive) --n 3
//   node scripts/random-prompt.mjs --level=2 --n 3          # 放开到 2 级
//   node scripts/random-prompt.mjs --seed=42 --show         # 固定种子复现 + 显示抽取报告
//   node scripts/random-prompt.mjs --pin=standing --n 3     # 固定 tag 再随机
//   node scripts/random-prompt.mjs --profile=random-profile.example.json --n 3
//   node scripts/random-prompt.mjs --tags=20 --n 4          # 词条数瞄准 20(±2) 二分收敛
//   node scripts/random-prompt.mjs --reset-counts           # 清零查重记账
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initWorkspace } from '../electron/core/workspace.js'
import { randomDraw, randomResetCounts, randomLedger, pinConflicts } from '../electron/core/random.js'

initWorkspace(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'), {
  defaultDataDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'),
  allowPortable: true,
})

// ---------- 参数(支持 --k=v 与 --k v 两种形态) ----------
const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i++) {
  const m = argv[i].match(/^--([\w-]+)(?:=(.+))?$/)
  if (!m) continue
  if (m[2] !== undefined) args[m[1]] = m[2]
  else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args[m[1]] = argv[i + 1]; i++ }
  else args[m[1]] = true
}
const N = Math.max(1, parseInt(args.n) || 1)
const MAX_LEVEL = parseInt(args.level) || 0          // 0=全年龄 1=擦边 2+ 显性
const SEED = args.seed != null ? String(args.seed) : null
const SHOW = args.show === true
const CHAR = typeof args.char === 'string' ? args.char : null
const NO_COUNTS = args['no-counts'] === true

if (args['reset-counts'] === true) {
  randomResetCounts()
  console.log('查重记账已清零')
  process.exit(0)
}

// 权重配置(JSONC, 允许 // 行注释)
let profile = {}
if (typeof args.profile === 'string') {
  try {
    profile = JSON.parse(readFileSync(path.resolve(args.profile), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  } catch (e) {
    console.error(`权重配置读取失败(${args.profile}): ${e.message}, 按全默认 1.0 继续`)
  }
}

// pin 预检(引擎里也会查, 这里提前报错退出)
const PINS = typeof args.pin === 'string' && args.pin.trim()
  ? args.pin.split(/[,|]/).map((s) => s.trim()).filter(Boolean) : []
const pinErrs = pinConflicts(PINS)
if (pinErrs.length) {
  console.error(pinErrs.join('\n'))
  process.exit(1)
}

const res = randomDraw({
  n: N,
  level: MAX_LEVEL,
  seed: SEED,
  pins: PINS,
  char: CHAR,
  profile,
  tagsTarget: args.tags != null ? parseInt(args.tags) : null,
  save: !NO_COUNTS,
})
if (res.error) {
  console.error(res.error)
  process.exit(1)
}

res.results.forEach((r, i) => {
  console.log((N > 1 ? `${i + 1}. ` : '') + r.tags.join(', '))
  if (SHOW) {
    for (const n0 of r.notes) console.log(`   ${n0}`)
    if (PINS.length) console.log(`   [pin] ${PINS.join(', ')}`)
  }
})
if (SHOW) {
  for (const w of res.warns) console.log(`   [权重告警] ${w}`)
  const led = randomLedger()
  console.log(`   [记账] ${Object.keys(led.counts).length} 个词, 最近 ${led.recent.length} 条`)
}
