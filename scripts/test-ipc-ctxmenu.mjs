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
import { fileURLToPath } from 'node:url'

register('./stub/electron-loader.mjs', import.meta.url)

const { ctl, clipboard: stubClipboard, ClipboardItem, BrowserWindow } = await import('./stub/electron.mjs')
const { initWorkspace } = await import('../electron/core/workspace.js')
const { registerIpc } = await import('../electron/ipc.js')
const { readImageSize } = await import('../electron/core/imgsize.js')
const { copyImage, openWithDialog, openWithCommand, openWithDeps } =
  await import('../electron/core/clipboardImage.js')

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
  assert.ok(openWith.submenu.some((i) => i.label === 'Windows 打开方式…'), '二级菜单里没有「Windows 打开方式…」')
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
    ctl.pick = pickDeep('Windows 打开方式…')
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
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
