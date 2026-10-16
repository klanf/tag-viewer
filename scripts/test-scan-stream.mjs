/**
 * 流式扫描验证(2026-10-16) —— 纯 node, 不起 Electron
 * ====================================================
 * 守的性质:
 *   ① 首批先行: scanFolder 传 {firstBatch, onPartial, onFinal} 时, 大批次(fresh≥64)
 *      先返回前 firstBatch 张(out.streaming=true), 而不是等全部解析完
 *   ② 增量推送: onPartial 多次到达, batch 按 path 不重不漏, 累计 = rest 的全部
 *   ③ 全量收口: onFinal 的 out 与非流式结果形状一致(total/items/dimensions/统计)
 *   ④ 无重复: 返回的 items ∪ 所有 batch ∪ final.items 按 path 计数不重复
 *   ⑤ 缓存闭环: 第二次打开命中内存缓存, 一次性返回全量且不再 streaming
 *   ⑥ 兼容性: 不传 opts 时行为与旧版完全一致(一次性全量, 无 streaming 字段)
 *
 * 跑法: node scripts/test-scan-stream.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

delete process.env.TV_DATA_DIR

const { initWorkspace } = await load('electron/core/workspace.js')
const scan = await load('electron/core/scan.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-scanstream-'))
const DATA = path.join(WORK, 'data')
const PICS = path.join(WORK, 'pics')
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(PICS, { recursive: true })
initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: DATA })

// ---- 夹具: 300 张图(1x1 PNG 复制改名; 元数据为空也走全链路, 调度逻辑与真图无异) ----
const N = 300
const srcPng = path.join(ROOT, 'test-fixtures', 'scan-test', 'a1.png')
for (let i = 0; i < N; i++) {
  fs.copyFileSync(srcPng, path.join(PICS, `img_${String(i).padStart(4, '0')}.png`))
}

let pass = 0, fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label) }
  else { fail++; console.log('  ✗', label) }
}

// ---- ①②③④ 流式路径 ----
console.log('\n[流式] firstBatch=100, fresh=%d', N)
const partials = []
let finalOut = null
const r1 = await scan.scanFolder({ path: PICS, recursive: false }, null, {
  firstBatch: 100,
  onPartial: (p) => partials.push(p),
  onFinal: (out) => { finalOut = out },
  onError: (e) => console.log('  [onError]', e?.stack || e),
})
ok(r1?.streaming === true, '① 返回标记 streaming:true')
// ⚠️ r1.items 是后端仍在追加的**活数组**(后台续扫继续 push 同一个数组), 断言前先快照。
// 真实前端走 IPC 拿到的是 structured-clone 拷贝, 不存在这个问题。
const firstItems = r1.items.slice()
ok(Array.isArray(r1?.items) && firstItems.length === 100, `① 首批 ${firstItems.length} 张 = 100`)
ok(r1?.total === N, `① total ${r1?.total} = ${N}(全量文件数)`)
ok(firstItems.every((it) => it.px_w > 0 && it.px_h > 0), '① 首批每张都带像素尺寸(原地读头)')

// 等 onFinal(后台 worker 续扫是 fire-and-forget, 轮询等它收口; chunk 也在此期间到达)
for (let i = 0; i < 200 && !finalOut; i++) await new Promise((r) => setTimeout(r, 100))
ok(partials.length >= 1, `② onPartial 到达 ${partials.length} 次(≥1)`)
ok(!!finalOut, '③ onFinal 到达(后台续扫收口)')
ok(finalOut?.total === N && finalOut?.items?.length === N, `③ final 全量 ${finalOut?.items?.length} = ${N}`)
ok(finalOut?.streaming === undefined, '③ final 快照不带 streaming 标记')
ok(Array.isArray(finalOut?.shared_tags) && typeof finalOut?.distinct_prompts === 'number', '③ final 统计字段齐全')

// ④ 不重不漏(用首批**快照**对账 —— 活数组在轮询期间已被 chunk 填满, 不能直接遍历)
const all = new Map()
for (const it of firstItems) all.set(it.path, (all.get(it.path) || 0) + 1)
for (const p of partials) for (const it of p.items) all.set(it.path, (all.get(it.path) || 0) + 1)
const dup = [...all.values()].filter((n) => n > 1).length
ok(dup === 0, '④ 首批+所有批次之间无重复 path')
ok(all.size === N, `④ 合计覆盖 ${all.size} = ${N}(partial 与 final 之间不重不漏)`)
const batchSum = partials.reduce((a, p) => a + p.items.length, 0)
ok(batchSum === N - 100, `④ batch 累计 ${batchSum} = ${N - 100}(rest 全部送达)`)

// partial 的 done/total 单调
let mono = true, last = -1
for (const p of partials) { if (p.done <= last) mono = false; last = p.done }
ok(mono, '② partial.done 单调递增')

// ---- ⑤ 第二次打开: 内存缓存命中, 一次性全量 ----
console.log('\n[缓存] 第二次打开')
const r2 = await scan.scanFolder({ path: PICS, recursive: false }, null, {
  firstBatch: 100, onPartial: () => {}, onFinal: () => {},
})
ok(r2?.cached === true, '⑤ 命中内存缓存(cached:true)')
ok(r2?.streaming === undefined && r2?.items?.length === N, `⑤ 一次性返回全量 ${r2?.items?.length}, 不再流式`)

// ---- ⑥ 不传 opts: 行为与旧版一致 ----
console.log('\n[兼容] 不带流式参数(先失效缓存)')
scan.invalidateScanCache(PICS)
const r3 = await scan.scanFolder({ path: PICS, recursive: false, force: true }, null)
ok(r3?.streaming === undefined, '⑥ 无 streaming 标记(旧版行为)')
ok(r3?.items?.length === N && r3?.total === N, `⑥ 一次性全量 ${r3?.items?.length} = ${N}`)

console.log(`\n结果: ${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
