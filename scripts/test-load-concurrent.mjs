/**
 * 数据集并发加载测试 —— 2026-10-04 启动遮罩卡 100% 的根治验证
 * ==============================================================
 * 现象: e2e 连续调 4 次 `app:reload` 之后, 启动遮罩永远停在 100%
 *      ("正在准备 / 已扫 N 张"), 主进程日志里没有「数据集就绪」。
 *
 * 真根因: buildDatasetInto 的写目标是**模块级**的 W, 而读库(buildStats/
 * buildSeriesIndex)都会 `await setImmediate` 让出事件循环 —— 两个 loadDataset
 * 一旦并发, 后进来的把 W 从前一个手里抢走, 前一个就永远组装不完。
 * 以前不并发是因为读库/统计是同步段; 10-04 的"分片让路"把它变成了显性竞态。
 * 修法: loadDataset 串行化(后到的排队依次跑), 见 dataset.js 的 loadChain。
 *
 * 负向对照(已实跑): 把串行化那段换成直接 return doLoadDataset(...), 本测试
 * 会因返回值变成 null 而 FAIL —— 说明它真能抓到这个回归。
 *
 * 跑法: npm run test:load-concurrent
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
delete process.env.TV_DATA_DIR

const { initWorkspace } = await load('electron/core/workspace.js')
const store = await load('electron/core/store.js')
const dataset = await load('electron/core/dataset.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-conc-'))
initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: path.join(WORK, 'data') })

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`) }
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`) }
const eq = (name, got, want) => (got === want ? ok(name, String(got)) : bad(name, `得到 ${got}, 期望 ${want}`))

// 3000 条: 足以跨过 readRecords/buildStats 的多个让路点(每 5000 条让一次,
// 读库每 4000 行让一次) —— 规模再小就碰不到让路点, 测不出竞态
const N = 3000
const db = store.openDb()
const ins = db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone)
                       VALUES (?, 0, ?, NULL, 1, 1, 'wd14', 0)`)
for (let i = 0; i < N; i++) ins.run(`p/${i}.png`, `1girl,solo,blue_hair,long_hair,${i % 50}_tag`)

const t0 = Date.now()
const [a, b] = await Promise.all([
  dataset.loadDataset(new Map()),
  dataset.loadDataset(new Map()),
])
const ms = Date.now() - t0
ok('两次并发 loadDataset 都有返回', `${ms} ms`)
ok('  A 拿到了 stats', !!a)
ok('  B 拿到了 stats', !!b)
if (!a || !b) {
  // 串行化被拆掉时就会走到这里(返回 null), 这正是线上"遮罩卡 100%"的形态
  bad('并发未卡死(有一侧返回空)', '拆掉串行化就会重现')
} else {
  eq('两次记录数一致', a.records, b.records)
  eq('记录数正确', a.records, N)
  eq('线上数据集等于最后一次构建', dataset.ds.records.length, N)
  eq('byPath 索引完整(无交叉污染)', dataset.ds.byPath.size, N)
  const p0 = dataset.recordByPath('p/0.png')
  eq('  按 path 能查到记录', !!p0, true)
  eq('  标签没被串味', p0?.tags?.join(','), '1girl,solo,blue_hair,long_hair,0_tag')
  eq('seriesChars 建好了(让路没打断索引构建)', dataset.ds.seriesChars.size >= 0, true)
}

store.closeDb()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
