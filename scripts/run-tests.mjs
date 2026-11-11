/**
 * 测试分层 runner（2026-11-11）
 * =============================
 * 起因：34 个测试脚本串行跑一遍 ≥123s，3 个重型（起 Electron / 全库导出）各 20s+。
 * 每次改代码都全量跑 = 每轮白等 2~4 分钟，于是"基线红不红"根本没时间确认。
 *
 * 分两层：
 *   fast  —— 纯逻辑/内存级：不起 Electron、不读全库。**并发跑**，目标 <15s。
 *   heavy —— 起 Electron / CDP / 全库导出：**串行跑**（并发只会互相抢 CPU，
 *            实测 8 路并发比串行更慢，而且重型测试互相拖到超时）。
 *
 * 用法：
 *   node scripts/run-tests.mjs            # = --fast
 *   node scripts/run-tests.mjs --fast
 *   node scripts/run-tests.mjs --heavy
 *   node scripts/run-tests.mjs --all      # fast 先跑，红了也继续跑 heavy（要全貌）
 *   TV_TEST_JOBS=8 node ... --fast        # 覆盖并发度
 *
 * 新增测试脚本后**不用改这里**：scripts/test-*.mjs 自动发现，只有重型才需要登记到 HEAVY。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = path.join(ROOT, 'scripts')

/**
 * 重型测试白名单 —— 判定标准：**起 Electron 实例 / CDP 连窗口 / 读全库或造大文件**。
 * 只放这些，其余一律归 fast（新脚本默认进 fast，跑慢了再加到这里）。
 */
const HEAVY = new Set([
  'test-boot-rescue.mjs',        // 起 Electron + TV_LOAD_DELAY_MS 造慢加载
  'test-adv-sets.mjs',           // 20s+，方案库全链路
  'test-export-async-equiv.mjs', // 全库导出 ×2 路径做等价对比
  'test-nl-ui.mjs',              // 真实窗口 + CDP + 截图
  'test-nl-export.mjs',          // 导出管线 ×大量抽样
  'test-series-search.mjs',      // 9.7s，跨 seriesChars 全量搜索
  'test-cart-preset.mjs',        // 5.8s
  'test-first-run.mjs',          // 首次启动全流程
  'test-nodata-boot.mjs',        // 空数据启动
  'test-translate-dir.mjs',      // 翻译库
  'test-visual.mjs',             // 4.2s，含扫描/尺寸实测
])

const mode = (process.argv.find((a) => /^--(fast|heavy|all)$/.test(a)) || '--fast').slice(2)
const JOBS = Math.max(1, Number(process.env.TV_TEST_JOBS) || Math.min(4, os.cpus().length))

const all = fs.readdirSync(SCRIPTS).filter((f) => /^test-.*\.mjs$/.test(f)).sort()
const fastFiles = all.filter((f) => !HEAVY.has(f))
const heavyFiles = all.filter((f) => HEAVY.has(f))

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [path.join('scripts', file)], {
      cwd: ROOT,
      env: { ...process.env, TV_TEST_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => resolve({ file, code, ms: Date.now() - t0, out }))
    p.on('error', (e) => resolve({ file, code: -1, ms: Date.now() - t0, out: `${out}\n${e.message}` }))
  })
}

async function pool(files, n) {
  const results = []
  let idx = 0
  const workers = Array.from({ length: Math.min(n, files.length) }, async () => {
    for (;;) {
      const i = idx++
      if (i >= files.length) return
      const r = await runOne(files[i])
      results.push(r)
      const mark = r.code === 0 ? '✓' : '✗'
      console.log(`  ${mark} ${r.file.replace(/^test-|\.mjs$/g, '').padEnd(26)} ${String(r.ms + 'ms').padStart(7)}`)
      // 失败才打输出（成功时安静，日志才有用）
      if (r.code !== 0) {
        const tail = r.out.trim().split('\n').slice(-14).join('\n')
        console.log(tail.split('\n').map((l) => `      ${l}`).join('\n'))
      }
    }
  })
  await Promise.all(workers)
  return results
}

function summarize(label, rs, ms) {
  const bad = rs.filter((r) => r.code !== 0)
  console.log(`\n${label}: ${rs.length - bad.length}/${rs.length} 通过 · ${(ms / 1000).toFixed(1)}s`
    + (bad.length ? ` · 失败: ${bad.map((r) => r.file).join(', ')}` : ''))
  return bad.length
}

let failed = 0
if (mode === 'fast' || mode === 'all') {
  console.log(`[fast] ${fastFiles.length} 个脚本 · 并发 ${JOBS} 路`)
  const t0 = Date.now()
  failed += summarize('[fast]', await pool(fastFiles, JOBS), Date.now() - t0)
}
if (mode === 'heavy' || mode === 'all') {
  console.log(`\n[heavy] ${heavyFiles.length} 个脚本 · 串行（起 Electron/全库导出，并发会互相拖死）`)
  const t0 = Date.now()
  failed += summarize('[heavy]', await pool(heavyFiles, 1), Date.now() - t0)
}

process.exit(failed ? 1 : 0)
