/**
 * 主进程 IPC handler 自动化测试 —— 无需启动 Electron 窗口
 * ======================================================
 * 跑法: node scripts/test-ipc-ctxmenu.mjs
 *
 * 覆盖「右键菜单 → 移动到」这条链路的真实执行:
 *   菜单构建 → 选中菜单项 → 搬文件 → 作废扫描缓存 → 返回 action
 * 之前漏了一个 import(fileTransfer.js) 就只能在应用里手点才发现, 这个测试能立刻抓到。
 */
import { register } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

register('./stub/electron-loader.mjs', import.meta.url)

const { ctl } = await import('./stub/electron.mjs')
const { initWorkspace } = await import('../electron/core/workspace.js')
const { registerIpc } = await import('../electron/ipc.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}
async function ta(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

/* ---------------- 环境搭建 ---------------- */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-ipc-'))
const appDir = path.join(root, 'app')
const dataDir = path.join(root, 'data')
const srcDir = path.join(root, '图片源')
const presetDir = path.join(root, '预设目标')
for (const d of [appDir, dataDir, srcDir, presetDir]) fs.mkdirSync(d, { recursive: true })

fs.writeFileSync(path.join(appDir, 'settings.json'), JSON.stringify({
  dataDir,
  quickFolders: [{ name: '预设目标', path: presetDir }],
}, null, 2))

initWorkspace(appDir)
registerIpc()

const handler = ctl.handlers.get('app:ctxMenu')
const fakeEvent = () => ({ sender: { __win: { id: 'stub-win' } } })

console.log(`\n注册 channel 数: ${ctl.handlers.size}`)

/* ---------------- 用例 ---------------- */
console.log('\n[1] app:ctxMenu / 移动到预设文件夹')
await ta('菜单里有「📤 移动到」且含预设项', () => {
  ctl.pick = () => {}
  const seen = {}
  ctl.pick = (tpl) => { seen.labels = tpl.map((i) => i.label || i.type) }
  handler(fakeEvent(), { path: path.join(srcDir, 'x.png'), name: 'x.png' })
  assert.ok(seen.labels.includes('📤 移动到'), '菜单缺少「移动到」')
})

await ta('选预设文件夹 → 文件真的被移走, 且返回 moved', async () => {
  const img = path.join(srcDir, 'a.png')
  fs.writeFileSync(img, 'png-bytes')
  ctl.pick = (tpl) => {
    const move = tpl.find((i) => i.label === '📤 移动到')
    const hit = move.submenu.find((i) => String(i.label).includes(presetDir))
    assert.ok(hit, '预设文件夹不在子菜单里')
    hit.click()
  }
  const r = await handler(fakeEvent(), { path: img, name: 'a.png', tags: '1girl, solo', favable: true, favorited: false })
  assert.equal(r.error, undefined, `handler 抛错: ${r.error}`)
  assert.equal(r.action, 'moved')
  assert.ok(fs.existsSync(path.join(presetDir, 'a.png')), '目标目录里没有文件')
  assert.ok(!fs.existsSync(img), '源文件还在')
})

await ta('同名文件自动改名, 不覆盖', async () => {
  const img = path.join(srcDir, 'a.png')
  fs.writeFileSync(img, 'second-bytes')
  ctl.pick = (tpl) => {
    const move = tpl.find((i) => i.label === '📤 移动到')
    move.submenu.find((i) => String(i.label).includes(presetDir)).click()
  }
  const r = await handler(fakeEvent(), { path: img, name: 'a.png' })
  assert.equal(r.action, 'moved')
  assert.ok(fs.existsSync(path.join(presetDir, 'a (2).png')), '没有生成改名后的文件')
  assert.equal(fs.readFileSync(path.join(presetDir, 'a.png'), 'utf8'), 'png-bytes', '原名文件被覆盖了')
})

await ta('选「选择其他文件夹…」→ 走 dialog, 取消则 nothing', async () => {
  const img = path.join(srcDir, 'b.png')
  fs.writeFileSync(img, 'b')
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '选择其他文件夹…').click()
  ctl.openDialog = null // 取消
  const r = await handler(fakeEvent(), { path: img, name: 'b.png' })
  assert.equal(r.action, null)
  assert.ok(fs.existsSync(img), '取消后不该动文件')
})

await ta('选「选择其他文件夹…」→ 确定后搬进所选目录', async () => {
  const img = path.join(srcDir, 'b.png')
  ctl.openDialog = () => ({ canceled: false, filePaths: [presetDir] })
  const r = await handler(fakeEvent(), { path: img, name: 'b.png' })
  assert.equal(r.action, 'moved')
  assert.ok(fs.existsSync(path.join(presetDir, 'b.png')))
})

await ta('目标目录不存在 → 自动创建后搬入', async () => {
  const img = path.join(srcDir, 'c.png')
  fs.writeFileSync(img, 'c')
  const fresh = path.join(root, '全新目录')
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '选择其他文件夹…').click()
  ctl.openDialog = () => ({ canceled: false, filePaths: [fresh] })
  const r = await handler(fakeEvent(), { path: img, name: 'c.png' })
  assert.equal(r.action, 'moved', `意外 action: ${r.action} (${r.result?.error})`)
  assert.ok(fs.existsSync(path.join(fresh, 'c.png')), '新目录里没有文件')
})

await ta('选到图片自己所在的目录 → 拒绝原地生成 (2)', async () => {
  const img = path.join(srcDir, 'g.png')
  fs.writeFileSync(img, 'g')
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '选择其他文件夹…').click()
  ctl.openDialog = () => ({ canceled: false, filePaths: [srcDir] })
  const r = await handler(fakeEvent(), { path: img, name: 'g.png' })
  assert.equal(r.action, 'move-failed', `意外 action: ${r.action}`)
  assert.ok(fs.existsSync(img), '原文件不见了')
  assert.ok(!fs.existsSync(path.join(srcDir, 'g (2).png')), '原地生成了 (2) 副本')
})

console.log('\n[2] app:ctxMenu / 其他菜单项')
await ta('复制文件路径 → 写进剪贴板', async () => {
  const img = path.join(srcDir, 'd.png')
  fs.writeFileSync(img, 'd')
  ctl.calls = []
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📋 复制文件路径').click()
  await handler(fakeEvent(), { path: img, name: 'd.png' })
  assert.deepEqual(ctl.calls.find((c) => c[0] === 'clipboard.writeText'), ['clipboard.writeText', img])
})

await ta('「把当前文件夹存为预设」→ 真的写进 settings.json(白名单没丢)', async () => {
  const img = path.join(srcDir, 'e.png')
  fs.writeFileSync(img, 'e')
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '把当前文件夹存为预设').click()
  const r = await handler(fakeEvent(), { path: img, name: 'e.png' })
  assert.equal(r.error, undefined, `handler 抛错: ${r.error}`)
  assert.match(String(r.action), /^quick-/, `意外 action: ${r.action}`)
  // 关键: 从磁盘回读 —— 若 workspace.js 的 saveSettings 白名单漏了 quickFolders, 这里会红
  const saved = JSON.parse(fs.readFileSync(path.join(appDir, 'settings.json'), 'utf8'))
  assert.ok(
    Array.isArray(saved.quickFolders) && saved.quickFolders.some((f) => f.path === srcDir),
    `settings.json 里没落盘: ${JSON.stringify(saved.quickFolders)}`,
  )
})

await ta('新增的预设立刻出现在下一次菜单里(读回生效)', async () => {
  const img = path.join(srcDir, 'f.png')
  fs.writeFileSync(img, 'f')
  let labels = []
  ctl.pick = (tpl) => { labels = tpl.find((i) => i.label === '📤 移动到').submenu.map((i) => String(i.label)) }
  await handler(fakeEvent(), { path: img, name: 'f.png' })
  assert.ok(labels.some((l) => l.includes(srcDir)), `菜单里没有新预设: ${JSON.stringify(labels)}`)
})

/* ---------------- 汇总 ---------------- */
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
