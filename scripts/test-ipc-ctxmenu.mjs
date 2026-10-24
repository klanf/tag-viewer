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
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

register('./stub/electron-loader.mjs', import.meta.url)

const { ctl, clipboard: stubClipboard, ClipboardItem, BrowserWindow } = await import('./stub/electron.mjs')
const { initWorkspace } = await import('../electron/core/workspace.js')
const { registerIpc } = await import('../electron/ipc.js')
const { readImageSize } = await import('../electron/core/imgsize.js')
const { copyImage, openWithDialog, openWithCommand, openWithDeps } =
  await import('../electron/core/clipboardImage.js')
const { spawnOpenWith } = await import('../electron/core/externalApp.js')

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
/**
 * 窗口桩要带 getContentSize —— 右键菜单现在自己算落点( ipc.js 的 clampMenuPos):
 * 二级菜单往右飞, 只按鼠标位置弹会飞到点不到的地方(2026-10-23 用户反馈)。
 */
const fakeEvent = (size = [1560, 980]) => ({ sender: { __win: { id: 'stub-win', getContentSize: () => size } } })

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

/* ---------------- 2026-10-23: 三个二级菜单「点了没反应、选不中」的两道闸 ----------------
 * 复盘: 二级菜单是**往右飞**的。标签里塞了完整路径之后它实测有 585px 宽(本机量的),
 * 一级 + 二级要 800 多 px; 在窄屏或窗口靠右右键时整块飞出可点区域, 于是
 * 顶层项能点、二级项选不中。修法两条: 标签只留名字(路径进 toolTip) + 落点自己算。
 * 下面两个用例就是这两条的回归闸, 谁改回去谁红。 */
await ta('二级菜单的标签里不许出现盘符路径(窄 = 点得到), 路径改放 toolTip', async () => {
  let tpl = []
  ctl.pick = (t) => { tpl = t }
  await handler(fakeEvent(), { path: path.join(srcDir, 'x.png'), name: 'x.png' })
  const flat = tpl.filter((i) => Array.isArray(i.submenu)).flatMap((i) => i.submenu)
  assert.ok(flat.length >= 4, `二级菜单是空的? ${JSON.stringify(flat.map((i) => i.label))}`)
  const wide = flat.filter((i) => /[A-Za-z]:[\\/]/.test(String(i.label)))
  assert.deepEqual(wide.map((i) => i.label), [], `这些二级项把路径写进了标签: ${JSON.stringify(wide.map((i) => i.label))}`)
  const tooLong = flat.filter((i) => String(i.label).length > 42)
  assert.deepEqual(tooLong.map((i) => i.label), [], `二级项标签过长(>42 字符): ${JSON.stringify(tooLong.map((i) => i.label))}`)
  const preset = tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.toolTip === presetDir)
  assert.ok(preset, '预设文件夹项没把路径放进 toolTip')
})

await ta('带鼠标坐标来 → 落点被收进窗口内(整块一级+二级都放得下)', async () => {
  ctl.calls = []
  ctl.pick = () => {}
  await handler(fakeEvent([1560, 980]), { path: path.join(srcDir, 'x.png'), name: 'x.png', x: 1500, y: 900 })
  const call = ctl.calls.find((c) => c[0] === 'menu.popup')
  assert.ok(call, 'popup 没被调用')
  const { x, y } = call[1]
  assert.ok(x < 1500, `光标在 1500 却原样用了: x=${x} —— 没往左收`)
  assert.ok(y < 900, `光标在 900 却原样用了: y=${y} —— 没往上收`)
  assert.ok(x >= 0 && y >= 0, `落点算到窗口外了: ${x},${y}`)
})

await ta('没带坐标的调用方 → 不设 x/y, 仍旧交给系统按鼠标位置弹', async () => {
  ctl.calls = []
  ctl.pick = () => {}
  await handler(fakeEvent(), { path: path.join(srcDir, 'x.png'), name: 'x.png' })
  const call = ctl.calls.find((c) => c[0] === 'menu.popup')
  assert.equal(call[1].x, undefined, `不该有 x: ${JSON.stringify(call[1])}`)
  assert.equal(call[1].y, undefined, `不该有 y: ${JSON.stringify(call[1])}`)
})

await ta('选预设文件夹 → 文件真的被移走, 且返回 moved', async () => {
  const img = path.join(srcDir, 'a.png')
  fs.writeFileSync(img, 'png-bytes')
  ctl.pick = (tpl) => {
    const move = tpl.find((i) => i.label === '📤 移动到')
    const hit = move.submenu.find((i) => i.toolTip === presetDir)
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
    move.submenu.find((i) => i.toolTip === presetDir).click()
  }
  const r = await handler(fakeEvent(), { path: img, name: 'a.png' })
  assert.equal(r.action, 'moved')
  assert.ok(fs.existsSync(path.join(presetDir, 'a (2).png')), '没有生成改名后的文件')
  assert.equal(fs.readFileSync(path.join(presetDir, 'a.png'), 'utf8'), 'png-bytes', '原名文件被覆盖了')
})

await ta('选「选择其他文件夹…」→ 走 dialog, 取消则 nothing', async () => {
  const img = path.join(srcDir, 'b.png')
  fs.writeFileSync(img, 'b')
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '📂 选择其他文件夹…').click()
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
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '📂 选择其他文件夹…').click()
  ctl.openDialog = () => ({ canceled: false, filePaths: [fresh] })
  const r = await handler(fakeEvent(), { path: img, name: 'c.png' })
  assert.equal(r.action, 'moved', `意外 action: ${r.action} (${r.result?.error})`)
  assert.ok(fs.existsSync(path.join(fresh, 'c.png')), '新目录里没有文件')
})

await ta('选到图片自己所在的目录 → 拒绝原地生成 (2)', async () => {
  const img = path.join(srcDir, 'g.png')
  fs.writeFileSync(img, 'g')
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '📂 选择其他文件夹…').click()
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
  ctl.pick = (tpl) => tpl.find((i) => i.label === '📤 移动到').submenu.find((i) => i.label === '⭐ 把当前文件夹存为预设').click()
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
  let tips = []
  ctl.pick = (tpl) => { tips = tpl.find((i) => i.label === '📤 移动到').submenu.map((i) => String(i.toolTip || '')) }
  await handler(fakeEvent(), { path: img, name: 'f.png' })
  assert.ok(tips.some((l) => l === srcDir), `菜单里没有新预设: ${JSON.stringify(tips)}`)
})

console.log('\n[2.5] 复制图片到剪贴板 / 用其他程序打开（2026-09-24 修的那个「点了没反应」）')
console.log('     根因: Electron 44.3.0 的主进程 clipboard **没有 writeImage 这个方法**')
console.log('     (实测只有 clear/has/read/readText/write/writeText), 原来那行必然抛')
console.log('     TypeError, 而它外面套着空 catch ⇒ 100% 静默失效、零提示。')
console.log('     这组用例把「桩里也没有 writeImage」当成事实来用: 谁改回去就红。')

/* 造一张**真 PNG**：planCopy 要读文件头拿尺寸，所以必须是真实字节 */
const pngFixture = fileURLToPath(new URL('../test-fixtures/scan-test/a1.png', import.meta.url))
const copySrc = path.join(srcDir, 'copy-me.png')
fs.copyFileSync(pngFixture, copySrc)
const realSize = readImageSize(copySrc)
assert.ok(realSize && realSize[0] > 0, '夹具 PNG 读不出尺寸，后面的断言没意义')
ctl.imageSize = { width: realSize[0], height: realSize[1] }   // 桩的 getSize 与真文件头对齐
new BrowserWindow()                                           // 主进程推送要有窗口才发得出去

/** 按标签点菜单项（找不到就断言失败，而不是静默什么都不点） */
const pickLabel = (label) => (tpl) => {
  const it = tpl.find((i) => i.label === label)
  assert.ok(it, `菜单里没有「${label}」`)
  it.click()
}

/** 深两层按标签点菜单项 —— 二级菜单(2026-10-16「用其他程序打开」改版)的子项在 submenu 里 */
const pickDeep = (label) => (tpl) => {
  for (const it of tpl) {
    if (it.label === label) { it.click(); return }
    if (Array.isArray(it.submenu)) {
      const hit = it.submenu.find((s) => s.label === label)
      if (hit) { hit.click(); return }
    }
  }
  assert.ok(false, `菜单(含二级)里没有「${label}」`)
}

await ta('「🗂️ 用其他程序打开」是二级菜单: 含「Windows 打开方式…」, 旧的系统查看器已移除(2026-10-16 改版)', () => {
  let tpl0 = []
  ctl.pick = (tpl) => { tpl0 = tpl }
  handler(fakeEvent(), { path: copySrc, name: 'copy-me.png' })
  const openWith = tpl0.find((i) => i.label === '🗂️ 用其他程序打开')
  assert.ok(openWith, `菜单缺少该项: ${JSON.stringify(tpl0.map((i) => i.label || i.type))}`)
  assert.ok(Array.isArray(openWith.submenu), '「用其他程序打开」不是二级菜单')
  assert.ok(openWith.submenu.some((i) => i.label === '🪟 Windows 打开方式…'), '二级菜单里没有「Windows 打开方式…」')
  assert.ok(!tpl0.some((i) => i.label === '🖥️ 用系统查看器打开'), '「用系统查看器打开」应该已经移除了')
})

await ta('点「复制图片到剪贴板」→ 真的 write([ClipboardItem(image/png)])，不再调不存在的 writeImage', async () => {
  ctl.calls = []
  ctl.pick = pickLabel('🖼️ 复制图片到剪贴板')
  const r = await handler(fakeEvent(), { path: copySrc, name: 'copy-me.png' })
  assert.equal(r.error, undefined, `handler 抛错: ${r.error}`)
  assert.equal(r.action, 'copy-image', `意外 action: ${r.action}`)
  assert.equal(r.result?.ok, true, `复制没成功: ${r.result?.error}`)
  assert.equal(r.result.width, realSize[0], '返回的宽度不是这张图的')
  assert.equal(r.result.height, realSize[1])

  const w = ctl.calls.find((c) => c[0] === 'clipboard.write')
  assert.ok(w, 'clipboard.write 没被调用')
  const item = w[1][0]
  assert.ok(item instanceof ClipboardItem, '传的不是 ClipboardItem 数组（真机会直接 reject）')
  assert.deepEqual(item.types, ['image/png'])
  assert.equal(item.items['image/png'].type, 'image/png', 'Blob 的 MIME 不对')
  assert.ok(!ctl.calls.some((c) => c[0] === 'clipboard.writeImage'), '又调了不存在的 clipboard.writeImage')
})

await ta('「正在复制图像…」提示必须**先**推给界面（大图 toPNG 实测 5s，先干后说等于没响应）', () => {
  const iSend = ctl.calls.findIndex((c) => c[0] === 'webContents.send' && c[1] === 'app:toast'
    && /正在复制图像/.test(String(c[2]?.text)))
  const iWrite = ctl.calls.findIndex((c) => c[0] === 'clipboard.write')
  assert.ok(iSend >= 0, '没有推 app:toast 进度提示')
  assert.ok(iWrite >= 0, '没有 clipboard.write')
  assert.ok(iSend < iWrite, '提示在写入之后才发 —— 主进程那时已经冻住了，界面根本画不出来')
  assert.match(String(ctl.calls[iSend][2].text), new RegExp(`${realSize[0]}×${realSize[1]}`), '提示里没带尺寸')
})

await ta('回读不到图 → 报失败（“写完了”不等于“剪贴板里真有一张图”）', async () => {
  ctl.clipboardHas = false          // 模拟 CF_DIBV5 没落地
  ctl.calls = []
  ctl.pick = pickLabel('🖼️ 复制图片到剪贴板')
  const r = await handler(fakeEvent(), { path: copySrc, name: 'copy-me.png' })
  assert.equal(r.result?.ok, false, '回读不到却报了成功')
  assert.match(r.result.error, /读不到图片/)
  ctl.clipboardHas = undefined
})

await ta('webp/bmp/gif（nativeImage 解不出）→ 明确报错，不许"静默什么都没写"', async () => {
  const wp = path.join(srcDir, 'format.webp')
  fs.writeFileSync(wp, 'webp-bytes')
  ctl.calls = []
  ctl.pick = pickLabel('🖼️ 复制图片到剪贴板')
  const r = await handler(fakeEvent(), { path: wp, name: 'format.webp' })
  assert.equal(r.result?.ok, false, '空图居然报了成功')
  assert.match(r.result.error, /只认 PNG \/ JPEG/)
  assert.ok(!ctl.calls.some((c) => c[0] === 'clipboard.write'), '空图还去写剪贴板了')
})

await ta('clipboard.write 被 reject（真机原话 expects an array of ClipboardItem）→ 失败带原因', async () => {
  const orig = stubClipboard.write
  stubClipboard.write = () => Promise.reject(new TypeError('clipboard.write expects an array of ClipboardItem'))
  try {
    ctl.pick = pickLabel('🖼️ 复制图片到剪贴板')
    const r = await handler(fakeEvent(), { path: copySrc, name: 'copy-me.png' })
    assert.equal(r.result?.ok, false)
    assert.match(r.result.error, /expects an array of ClipboardItem/)
  } finally { stubClipboard.write = orig }
})

await ta('write 永不 settle → 有死线兜底（注入 150ms，真等 20s 太慢）', async () => {
  const orig = stubClipboard.write
  stubClipboard.write = () => new Promise(() => {})
  try {
    const r = await copyImage(copySrc, { writeTimeoutMs: 150 })
    assert.equal(r.ok, false, '永不返回却报了成功')
    assert.match(r.error, /没返回/)
  } finally { stubClipboard.write = orig }
})

await ta('openWithCommand: shell32.dll,OpenAs_RunDLL + 盘符绝对路径的 rundll32', () => {
  // path-check-ignore 下面是**示例路径**，只为断言纯函数的拼装结果，不是真实位置
  const sample = 'D:/x/y.png'
  const { exe, args } = openWithCommand(sample)
  assert.equal(args[0], 'shell32.dll,OpenAs_RunDLL')
  assert.equal(args[1], sample)
  assert.match(exe, /rundll32\.exe$/i, `exe 不是 rundll32: ${exe}`)
  if (process.env.SystemRoot) {
    assert.ok(/^[A-Za-z]:\\/.test(exe), `有 SystemRoot 却没拼出绝对路径: ${exe}`)
    // path-check-ignore 这一行是在**断言源码里没把盘符写死**，本身不是硬编码路径
    assert.ok(!/^C:\\Windows/i.test(exe) || /^C:\\Windows/i.test(process.env.SystemRoot), '把盘符写死了')
  }
})

await ta('点二级菜单「Windows 打开方式…」→ detached 子进程 + 参数对（用假 spawn，单测绝不真弹对话框）', async () => {
  const seen = []
  const orig = openWithDeps.spawn
  openWithDeps.spawn = (exe, args, opts) => { seen.push({ exe, args, opts }); return { on() {}, unref() {} } }
  try {
    ctl.pick = pickDeep('🪟 Windows 打开方式…')
    const r = await handler(fakeEvent(), { path: copySrc, name: 'copy-me.png' })
    assert.equal(r.action, 'open-with', `意外 action: ${r.action}`)
    assert.equal(r.result?.ok, true, `失败: ${r.result?.error}`)
    assert.equal(seen.length, 1, `起了 ${seen.length} 次进程`)
    assert.equal(seen[0].args[0], 'shell32.dll,OpenAs_RunDLL')
    assert.equal(seen[0].args[1], copySrc, '传给对话框的不是这张图')
    assert.equal(seen[0].opts.detached, true, '必须 detached: 关掉看板不该顺手关掉用户的看图软件')
    assert.equal(seen[0].opts.stdio, 'ignore')
  } finally { openWithDeps.spawn = orig }
})

await ta('「打开方式」起进程失败 → 返回原因（菜单点了不能没反应）', async () => {
  const orig = openWithDeps.spawn
  openWithDeps.spawn = () => {
    const h = {}
    return {
      on: (ev, fn) => {
        h[ev] = fn
        // spawn 的失败是**异步**报的（真机也是这样），所以只能在 on('error') 上兑现
        if (ev === 'error') setTimeout(() => fn(new Error('ENOENT')), 10)
      },
      unref() {},
    }
  }
  try {
    const r = await openWithDialog(copySrc)
    assert.equal(r.ok, false, 'EXISTING: 起进程失败却报了成功')
    assert.match(r.error, /ENOENT/)
  } finally { openWithDeps.spawn = orig }
})

await ta('「用其他程序打开」必须 windowsHide:false（2026-10-23 真机破案的根因）', async () => {
  // true 会让 Node 在 STARTUPINFO 里带 STARTF_USESHOWWINDOW + SW_HIDE，Qt 系程序
  // (Inpaint) 照办：窗口建好、位置正常，但永远不给 WS_VISIBLE
  // → 「进程有、任务栏有、屏幕上什么都没有」。谁改回 true 这条就红。
  const seen = []
  const fakeSpawn = (exe, args, opts) => {
    seen.push({ exe, args, opts })
    const h = new EventEmitter()
    h.unref = () => {}
    setTimeout(() => h.emit('spawn'), 0)   // 真机的 spawn 事件也是异步到的
    return h
  }
  // path-check-ignore: 下面两行是**假路径**(spawn 已被换成 fakeSpawn, 不会真去拉进程),
  // 只是要断言 cwd 取的是 exe 所在目录 —— 绿色版单 exe 从别处起来会白启动
  const fakeExe = 'F:\\软件\\Inpaint_v9.1_x64.exe'
  const fakeDir = 'F:\\软件'
  const r = await spawnOpenWith(fakeExe, copySrc, { spawn: fakeSpawn })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].opts.windowsHide, false, 'windowsHide 被改回 true 了 —— 外部程序会隐形启动')
  assert.equal(seen[0].opts.cwd, fakeDir, 'cwd 不是 exe 所在目录(绿色版会白启动)')
  assert.equal(seen[0].args[0], copySrc, '传进去的不是这张图')
  assert.equal(r.ok, true, `没等到 spawn 事件: ${JSON.stringify(r)}`)
})

console.log('\n[2b] 外部程序清单(2026-10-24 用户要求: 删掉「未找到 Photoshop」占位项, 列表放进设置页管)')
/* 这份清单从「每次现拼(预置+MRU)」改成 settings.openWithApps 里的一份用户数据:
 *   · 菜单只渲染它, 而且只渲染**文件还在**的那些 —— 不许再挂 `enabled:false` 的说明行
 *   · 「➕ 选择程序加进列表…」选中的程序**永久**进列表
 * 下面这几个用例把这三条钉住; 跑完会把 settings.json 恢复成开头的样子, 不影响后面的段。 */
const settingsFile = path.join(appDir, 'settings.json')
const owReset = (extra = {}) => {
  fs.writeFileSync(settingsFile, JSON.stringify({
    dataDir,
    quickFolders: [{ name: '预设目标', path: presetDir }],
    ...extra,
  }, null, 2))
  initWorkspace(appDir)
}
/** 打开右键菜单, 拿到「🗂️ 用其他程序打开」的子菜单 */
const openWithSub = async () => {
  let tpl = []
  ctl.pick = (t) => { tpl = t }
  await handler(fakeEvent(), { path: path.join(srcDir, 'ow.png'), name: 'ow.png' })
  const item = tpl.find((i) => i.label === '🗂️ 用其他程序打开')
  assert.ok(item && Array.isArray(item.submenu), `没有「用其他程序打开」二级菜单: ${JSON.stringify(tpl.map((i) => i.label || i.type))}`)
  return item.submenu
}

await ta('第一次读清单会把老配置(recentOpenWith)迁进来并落盘, 子菜单里没有任何占位灰项', async () => {
  const ghost = path.join(presetDir, '不存在的程序.exe')
  owReset({ recentOpenWith: [{ name: 'Ghost', path: ghost }] })
  const sub = await openWithSub()
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.ok(Array.isArray(written.openWithApps), '迁移后没把 openWithApps 写进 settings.json')
  assert.ok(written.openWithApps.some((a) => a.path.toLowerCase() === ghost.toLowerCase()), `老配置没迁进来: ${JSON.stringify(written.openWithApps)}`)
  assert.ok(written.openWithApps.every((a) => a.path), `清单里有空路径(占位项的来源): ${JSON.stringify(written.openWithApps)}`)
  assert.ok(!sub.some((i) => /未找到|⚠️/.test(String(i.label))), `子菜单里又挂出了占位说明项: ${JSON.stringify(sub.map((i) => i.label))}`)
  assert.ok(!sub.some((i) => i.enabled === false && String(i.label).startsWith('▶️')), '有程序被灰着列进来了')
  assert.ok(!sub.some((i) => i.toolTip === ghost), '文件不存在的程序不该上菜单')
})

await ta('openWithApps: 提交的顺序就是菜单顺序 · 路径大小写重复被去掉 · 不存在的不上菜单', async () => {
  const realExe = path.join(presetDir, 'real.exe')
  fs.writeFileSync(realExe, 'MZ')
  const gone = path.join(presetDir, 'gone.exe')
  owReset()
  const set = ctl.handlers.get('app:openWithApps:set')
  const r = await set({}, { apps: [
    { name: '已卸载的程序', path: gone },
    { name: '真程序', path: realExe },
    { name: '重复项', path: realExe.toUpperCase() },
  ] })
  assert.equal(r.ok, true, `保存失败: ${JSON.stringify(r)}`)
  assert.deepEqual(r.apps.map((a) => a.name), ['已卸载的程序', '真程序'], `顺序/去重不对: ${JSON.stringify(r.apps)}`)
  assert.equal(r.apps.find((a) => a.name === '真程序').exists, true, '存在的程序该标 exists:true')
  assert.equal(r.apps.find((a) => a.name === '已卸载的程序').exists, false, '缺文件的程序该标 exists:false(设置页要能看到并删掉)')
  const labels = (await openWithSub()).filter((i) => String(i.label).startsWith('▶️')).map((i) => i.label)
  assert.deepEqual(labels, ['▶️ 真程序'], `菜单只该列文件还在的那个: ${JSON.stringify(labels)}`)
})

await ta('菜单里「➕ 选择程序加进列表…」挑中的程序永久进列表(单测只 spawn 一个假 .exe, 不会拉起真程序)', async () => {
  const newExe = path.join(presetDir, 'paint.exe')
  fs.writeFileSync(newExe, 'MZ')       // 不是真 PE: CreateProcess 会失败 -> 回执 ok:false, 但登记照样生效
  owReset({ openWithApps: [{ name: '真程序', path: path.join(presetDir, 'real.exe') }] })
  ctl.openDialog = () => ({ canceled: false, filePaths: [newExe] })
  ctl.pick = (tpl) => {
    const hit = tpl.find((i) => i.label === '🗂️ 用其他程序打开').submenu.find((i) => String(i.label).startsWith('➕'))
    assert.ok(hit, '子菜单里没有「➕ 选择程序加进列表…」')
    hit.click()
  }
  const r = await handler(fakeEvent(), { path: path.join(srcDir, 'ow.png'), name: 'ow.png' })
  ctl.openDialog = null
  assert.equal(r.action, 'open-with')
  assert.equal(r.result.added, true, `没报"已加进列表": ${JSON.stringify(r.result)}`)
  const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).openWithApps
  assert.deepEqual(stored.map((a) => a.name), ['真程序', 'paint'], `列表没追加/顺序变了: ${JSON.stringify(stored)}`)
})

await ta('设置页「＋ 添加程序」→ app:openWithApps:add 只登记不启动; 取消则列表不动', async () => {
  const another = path.join(presetDir, 'viewer.exe')
  fs.writeFileSync(another, 'MZ')
  owReset({ openWithApps: [] })
  const add = ctl.handlers.get('app:openWithApps:add')
  ctl.calls = []
  ctl.openDialog = () => ({ canceled: false, filePaths: [another] })
  const r = await add({}, {})
  ctl.openDialog = null
  assert.equal(r.canceled, false)
  assert.equal(r.added, true, `没算加进去了: ${JSON.stringify(r)}`)
  assert.deepEqual(r.apps.map((a) => a.path), [another], `清单不对: ${JSON.stringify(r.apps)}`)
  assert.equal(r.apps[0].exists, true, '刚加的程序该标存在')
  assert.equal(ctl.calls.filter((c) => c[0] === 'spawn').length, 0, '添加时不该启动程序')
  const c = await add({}, {})          // ctl.openDialog=null → 模拟用户取消
  assert.equal(c.canceled, true, `取消也改动了列表: ${JSON.stringify(c)}`)
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).openWithApps.map((a) => a.path), [another], '取消后列表被写脏了')
})

await ta('清单为空时子菜单只留两条入口, 并且有一句人话', async () => {
  owReset({ openWithApps: [] })
  const sub = await openWithSub()
  assert.ok(sub.some((i) => String(i.label).startsWith('➕')), '缺「加进列表」入口')
  assert.ok(sub.some((i) => i.label === '🪟 Windows 打开方式…'), '缺系统原生「打开方式」兜底')
  assert.ok(sub.some((i) => /列表为空/.test(String(i.label))), `空列表没给说明: ${JSON.stringify(sub.map((i) => i.label))}`)
})

owReset()   // 恢复成开头那份设置, 后面 [3] 段还依赖 quickFolders 预设

console.log('\n[3] image:trash / shell API 只认反斜杠(2026-09-20 真机 bug)')
console.log('     库内正斜杠路径此前被 trashItem 以 "Failed to parse path" 拒收,')
console.log('     表面上是「文件被占用」—— 隔离探针 A/B 已实锤是分隔符问题。')
await ta('正斜杠路径(库内写法) -> 传给 trashItem 的是反斜杠, 文件真被删掉', async () => {
  const img = path.join(srcDir, 'trash-fwd.png')
  fs.writeFileSync(img, 'trash-me')
  const fwd = img.split('\\').join('/')            // 全正斜杠(库内 images.path 的写法)
  ctl.calls = []
  const trash = ctl.handlers.get('image:trash')
  const r = await trash({}, { paths: [fwd] })
  const call = ctl.calls.find((c) => c[0] === 'shell.trashItem')
  assert.ok(call, 'shell.trashItem 没被调用')
  assert.ok(!call[1].includes('/'), `传给 trashItem 的仍是正斜杠: ${call[1]}`)
  assert.ok(/^[A-Z]:\\/.test(call[1]), `盘符没转大写/不是盘符开头: ${call[1]}`)
  assert.ok(!fs.existsSync(img), '文件还在原位(没删掉)')
  assert.deepEqual(r.trashed, [fwd], '回执必须保留调用方原文(渲染层靠它对号剔除网格)')
  assert.equal(r.failed.length, 0, `误报失败: ${JSON.stringify(r.failed)}`)
})

await ta('小写盘符 + 反斜杠 -> 盘符统一成大写后照样删', async () => {
  const img = path.join(srcDir, 'trash-lower.png')
  fs.writeFileSync(img, 'trash-me-2')
  const lower = img.replace(/^[A-Z]:/, (s) => s.toLowerCase())
  ctl.calls = []
  const trash = ctl.handlers.get('image:trash')
  const r = await trash({}, { paths: [lower] })
  assert.equal(r.failed.length, 0, `误报失败: ${JSON.stringify(r.failed)}`)
  assert.ok(!fs.existsSync(img), '文件还在原位')
  const call = ctl.calls.find((c) => c[0] === 'shell.trashItem')
  assert.equal(call[1][0], img[0], `盘符大小写被改动: ${call[1]}`)
})

await ta('右键菜单「📁 打开图片所在位置」也走反斜杠(系统查看器已移除, showItemInFolder 是菜单里仅剩的 shell 打开)', async () => {
  const img = path.join(srcDir, 'ctx-shell.png')
  fs.writeFileSync(img, 'shell-me')
  const fwd = img.split('\\').join('/')
  ctl.calls = []
  // 不设 ctl.pick -> 菜单构建后没人选, 但 reveal 是构建时记录、click 时触发的,
  // 所以这里手动找到对应项点掉
  ctl.pick = (tpl) => {
    tpl.find((i) => i.label === '📁 打开图片所在位置').click()
  }
  await handler(fakeEvent(), { path: fwd, name: 'ctx-shell.png' })
  const op = ctl.calls.find((c) => c[0] === 'shell.showItemInFolder')
  assert.ok(op, 'shell.showItemInFolder 没被调用')
  assert.ok(!String(op[1]).includes('/'), `收到的仍是正斜杠: ${op[1]}`)
})

/* ---------------- 汇总 ---------------- */
/* 清理临时目录包一层容错: 断言全过时, rmSync 偶发的 EBUSY(杀软/索引服务
 * 短暂占用新建的 tags.db)不该把全绿的测试染红 —— %TEMP% 里的残留系统自会清。 */
try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 环境噪音, 忽略 */ }
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
