/**
 * 购物车自动导出(cartPreset.js) 自测 —— 纯 Node, 不启 Electron、不碰真实数据目录。
 * 用法: node scripts/test-cart-preset.mjs
 *
 * 为什么值得单独测: 这套"内容变了才导 / 攒一会再导 / 跑着的时候又改了不能丢 /
 * 清空不算更新"的判据全是**看不见的状态**, 界面上只反映最终结果 ——
 * 出错了就是"文件悄悄是旧的", 而用户以为已经导过了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.tmpdir(), `tv-cartpreset-${Date.now()}`)
const APP_DIR = path.join(root, 'app')
const DATA_DIR = path.join(root, 'data')
const DEST = path.join(root, 'dest')
fs.mkdirSync(APP_DIR, { recursive: true })
fs.mkdirSync(DEST, { recursive: true })

const { initWorkspace } = await import('../electron/core/workspace.js')
initWorkspace(APP_DIR, { defaultDataDir: DATA_DIR })

const {
  notifyCartChanged, cartPresetState, saveCartPreset, runCartPreset, flushCartPendingNow,
  DELAY_OPTIONS, DEFAULT_DELAY_MS,
} = await import('../electron/core/cartPreset.js')

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FILE = 'cart-e2e.txt'
const full = () => path.join(DEST, FILE)
const read = () => (fs.existsSync(full()) ? fs.readFileSync(full(), 'utf8') : null)
const mtime = () => (fs.existsSync(full()) ? fs.statSync(full()).mtimeMs : 0)

/* ---------------- 1. 默认值 ---------------- */

const st0 = cartPresetState()
check('默认: 未开启 / 文件名为 roles_cart.txt / 延迟 30 秒',
  st0.enabled === false && st0.file === 'roles_cart.txt' && st0.delayMs === DEFAULT_DELAY_MS,
  `enabled=${st0.enabled} file=${st0.file} delay=${st0.delayMs}`)
check('默认: active=false(没开关也没目录)', st0.active === false && st0.synced === true)

/* ---------------- 2. 开开关但没目录 -> 变更不排程 ---------------- */

saveCartPreset({ enabled: true })
const r2 = notifyCartChanged(['saori_(blue_archive)'])
check('开了开关但没设目录: 变更也不排程',
  r2.changed === true && r2.scheduled === false && r2.reason === 'off',
  `changed=${r2.changed} scheduled=${r2.scheduled} reason=${r2.reason}`)

/* ---------------- 3. 设目录 + 延迟 1.5 秒 -> 变更排程, 到点自动落盘 ---------------- */

const st3 = saveCartPreset({ dir: DEST, file: FILE, delayMs: 1500 })
check('设目录后立刻导了一份(不用等延迟)', read() !== null && st3.active === true,
  st3.active ? `已落盘 ${JSON.stringify((read() || '').trim())}` : `active=${st3.active}`)
check('内容 = wildcard 格式(括号转义 + 下划线转空格)',
  read() === 'saori \\(blue archive\\)\n', JSON.stringify(read()))
check('落盘后状态标为"已同步"', cartPresetState().synced === true)

const m1 = mtime()
const r4 = notifyCartChanged(['saori_(blue_archive)', 'hoshino_(blue_archive)'])
check('新增角色: changed=true 且排上了', r4.changed === true && r4.scheduled === true,
  `changed=${r4.changed} scheduled=${r4.scheduled}`)
check('排上了但还没到点: 文件还是旧的',
  mtime() === m1 && (read() || '').split('\n').filter(Boolean).length === 1,
  `文件 ${(read() || '').split('\n').filter(Boolean).length} 行`)
await sleep(1900)
check('延迟到点后自动落盘, 两行都在',
  (read() || '').split('\n').filter(Boolean).length === 2, JSON.stringify(read()))

/* ---------------- 4. 同一份内容重复上报 -> 不导 ---------------- */

const m2 = mtime()
const r5 = notifyCartChanged(['saori_(blue_archive)', 'hoshino_(blue_archive)'])
check('内容没变: changed=false, 不排程', r5.changed === false && r5.scheduled === false)
await sleep(1800)
check('内容没变: 文件确实没被重写', mtime() === m2)

/* ---------------- 5. 顺序敏感(移出再放回来也算变了) ---------------- */

const r6 = notifyCartChanged(['hoshino_(blue_archive)', 'saori_(blue_archive)'])
check('顺序变了 = 内容变了(文件行序真的会变)', r6.changed === true && r6.scheduled === true)
await flushCartPendingNow()
check('立刻导: 行序与上报顺序一致',
  (read() || '').split('\n').filter(Boolean)[0] === 'hoshino \\(blue archive\\)', JSON.stringify(read()))

/* ---------------- 6. 清空不导(结算是"导出 -> 存历史 -> 清空") ---------------- */

const beforeEmpty = read()
const m3 = mtime()
const r7 = notifyCartChanged([])
check('清空: 不算更新, 也不排程',
  r7.changed === false && r7.scheduled === false && r7.reason === 'empty',
  `reason=${r7.reason}`)
const flushed = await flushCartPendingNow()
check('清空后"立刻导"是空操作(没有待导的)', flushed?.skipped === true, JSON.stringify(flushed))
check('清空**没有**把下游那份文件清成空', read() === beforeEmpty && mtime() === m3,
  JSON.stringify(read()))

/* ---------------- 7. 清空再加回同一批 -> 判定为"没更新"(文件本来就已经是这批) ---------------- */

const r8 = notifyCartChanged(['hoshino_(blue_archive)', 'saori_(blue_archive)'])
check('清空后把同一批加回来: 仍视为已同步(不白导一遍)',
  r8.changed === false && r8.scheduled === false, JSON.stringify(r8))

/* ---------------- 8. 关开关 -> 变更不再排程 ---------------- */

saveCartPreset({ enabled: false })
const r9 = notifyCartChanged(['hoshino_(blue_archive)', 'saori_(blue_archive)', 'shiroko_(blue_archive)'])
check('关掉开关后变更不排程', r9.scheduled === false && r9.reason === 'off', JSON.stringify(r9))
check('关掉开关: active=false', cartPresetState().active === false)

/* ---------------- 9. 重新打开开关 -> 当场补导一份(不等延迟) ---------------- */

const m4 = mtime()
const st10 = saveCartPreset({ enabled: true })
check('重新打开开关: 当场导了一份', mtime() > m4, `active=${st10.active}`)
check('打开开关那次导的是最新那份(3 行)',
  (read() || '').split('\n').filter(Boolean).length === 3, JSON.stringify(read()))
check('lastTrigger 记成 enable', st10.lastTrigger === 'enable', st10.lastTrigger)

/* ---------------- 10. 排程期间连改: 只导一次, 且导的是最后那份 ---------------- */

const m5 = mtime()
notifyCartChanged(['a_(x)'])
notifyCartChanged(['a_(x)', 'b_(x)'])
notifyCartChanged(['a_(x)', 'b_(x)', 'c_(x)'])
check('连改三次: 只排一次(防抖合并)', cartPresetState().pending === true)
await sleep(1900)
check('到点导的是**最后**那份(3 行, 不是 a 那一份)',
  mtime() > m5 && (read() || '').split('\n').filter(Boolean).length === 3, JSON.stringify(read()))

/* ---------------- 11. 手动导出: 开关关着也能导, 且用调用方给的 tags ---------------- */

saveCartPreset({ enabled: false })
const manual = runCartPreset({ tags: ['manual_only_(x)'] })
check('手动导出: 开关关着也照导', manual?.ok === true && read() === 'manual only \\(x\\)\n',
  JSON.stringify(manual))
let emptyErr = ''
try { runCartPreset({ tags: [] }) } catch (e) { emptyErr = e.message }
check('手动导出: 购物车空时给明确错误', /空/.test(emptyErr), emptyErr)

/* ---------------- 12. 脏数据容错 ---------------- */

fs.writeFileSync(path.join(DATA_DIR, 'user', 'cart_preset.json'),
  JSON.stringify({ enabled: 'yes', file: 'a/b:c*.txt', delayMs: 12345 }), 'utf8')
const st12 = cartPresetState()
check('手改脏 json: 非法延迟回落默认、文件名消毒',
  st12.delayMs === DEFAULT_DELAY_MS && !/[\\/:*]/.test(st12.file) && st12.file.endsWith('.txt'),
  `delay=${st12.delayMs} file=${st12.file}`)
check('延迟档位来自主进程(渲染层不自己写一份)', DELAY_OPTIONS.length >= 4 && st12.delayOptions === DELAY_OPTIONS)

/* ---------------- 收尾 ---------------- */

fs.rmSync(root, { recursive: true, force: true })
const bad = results.filter((r) => !r.pass)
console.log(`\n===== cartPreset 自测: ${results.length - bad.length}/${results.length} 通过 =====`)
if (bad.length) {
  for (const b of bad) console.log(`  FAIL  ${b.name}  ${b.extra}`)
  process.exitCode = 1
}
