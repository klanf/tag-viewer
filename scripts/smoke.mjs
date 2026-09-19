/**
 * 冒烟检查(30 秒级) —— 只回答一个问题:
 * "新起的实例到底落在哪个视图, 首屏有多少卡片"。
 * 完整断言在 scripts/e2e.mjs; 这个脚本用于改完代码后快速回看, 免得跑几分钟的全量。
 *
 * 用法: node scripts/smoke.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findElectron, electronEnv } from './electron-path.mjs'
import { freePort, clearPageState, ensureWorkDir, sleep, ROOT } from './harness.mjs'

const KEEP = process.argv.includes('--keep')

async function main() {
  const work = ensureWorkDir()
  /**
   * 默认跑数据副本(可写, 不会碰用户真实积累);
   * 想验证"正式配置能不能起来", 显式传空的 TV_DATA_DIR:
   *   TV_DATA_DIR= node scripts/smoke.mjs
   * 这时应用会去读 tag_viewer_config.json 里配的数据目录(也就是旧版那套)。
   */
  const DATA_DIR = process.env.TV_DATA_DIR === undefined ? work.dataDir : process.env.TV_DATA_DIR
  const USER_DATA = work.userData
  const SHOTS = work.shotsDir
  const exe = findElectron()
  const port = await freePort()
  console.log('[smoke] 数据目录 =', DATA_DIR || '(走配置文件)')

  const child = spawn(exe, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${USER_DATA}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: electronEnv(DATA_DIR ? { TV_DATA_DIR: DATA_DIR } : {}),
  })
  let exited = null
  child.stderr.on('data', (b) => process.stderr.write(b))
  child.on('exit', (c, s) => { exited = `code=${c} sig=${s}` })

  let page = null
  for (let i = 0; i < 120 && !page; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { /* 等端口 */ }
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('CDP 端口没起来')
  if (exited) throw new Error(`主进程退出了(${exited}) —— 连到的是别的实例`)
  console.log('[smoke] page.url =', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  let id = 0
  const pending = new Map()
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id === undefined) {
      // 页面里的异常/报错要收下来 —— 元素数不对时, 真正的原因通常在这一行里
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?')
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        pageErrors.push(`[${m.params.type}] ` + m.params.args.map((a) => a.description || a.value).join(' '))
      }
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id
    pending.set(myId, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  await send('Runtime.enable')

  const evalJs = async (src) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${src} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
    return r.result.value
  }

  try {
    // 清掉上一轮残留的 localStorage 再重载, 保证起点确定(见 harness.mjs 说明)
    console.log('[smoke] 清空页面状态:', await clearPageState({ eval: evalJs }), '个 key')

    // 装一个 invoke 监听器 —— 页面自己发的请求参数看不到的话, "总数对不上"这类
    // 问题就只能靠猜。contextBridge 暴露的对象通常是不可写的, 所以先试, 失败不致命。
    const tapped = await evalJs(`
      try {
        const orig = window.tv.invoke.bind(window.tv)
        window.__calls = []
        window.tv.invoke = (ch, p) => {
          let short = p
          try { short = JSON.parse(JSON.stringify(p ?? null)) } catch { /* 保留原样 */ }
          if (short && short.fav && short.fav.length) short.fav = '[' + short.fav.length + ' paths]'
          window.__calls.push([ch, short])
          return orig(ch, p)
        }
        return 'ok'
      } catch (e) { return 'fail: ' + e.message }
    `)
    console.log('[smoke] invoke 监听器:', tapped)

    // 等数据集 ready
    for (let i = 0; i < 180; i++) {
      const s = await evalJs(`const s = await window.tv.invoke('app:status'); return s.phase`)
      if (s === 'ready' || s === 'error') { console.log('[smoke] 数据集 phase =', s); break }
      await sleep(500)
    }
    await sleep(1500)

    // 手动触发一次搜索, 顺便把页面实际发出的查询参数录下来
    await evalJs(`
      const btn = [...document.querySelectorAll('.btns .tv-btn')].find(b => b.textContent.includes('搜索'))
      if (btn) btn.click()
      await new Promise(r => setTimeout(r, 1600))
      return !!btn
    `)
    const info = await evalJs(`
      const out = {
        hash: location.hash,
        lsKeys: Object.keys(localStorage),
        navActive: (document.querySelector('.hdr .nv.active') || {}).textContent || '',
        cards: document.querySelectorAll('.grid .card').length,
        srcChips: document.querySelectorAll('.src-bar .tv-chip').length,
        bars: document.querySelectorAll('.bars .row').length,
        pager: document.querySelectorAll('.pager .page').length,
        total: (document.querySelector('.result-head b') || {}).textContent || '',
        sugInput: !!document.querySelector('.sug input'),
        thhumb: document.querySelectorAll('.grid .tv-img.loaded').length,
        hdrBtns: document.querySelectorAll('.hdr .tv-btn').length,
        headText: (document.querySelector('.result-head') || {}).textContent || '',
        srcActive: (document.querySelector('.src-bar .tv-chip.active .lb') || document.querySelector('.src-bar .tv-chip.active') || {}).textContent || '',
        calls: (window.__calls || []).slice(0, 6),
      }
      // IPC 直连体检: 页面元素为 0 时, 到底是"渲染没出来"还是"IPC 就失败了"
      // channel 名以 preload.cjs 的白名单为准(preload 与 ipc.js 必须一一对应)
      try {
        const s = await window.tv.invoke('stats:get', {})
        out.statsKeys = Object.keys(s || {}).slice(0, 14)
        out.statsSources = (s && s.sources ? s.sources.length : -1)
        out.statsTotal = (s && (s.total_images ?? s.records)) ?? null
      } catch (e) { out.statsErr = e.message }
      try {
        const r = await window.tv.invoke('search:do', { q: '', offset: 0, limit: 60, sort: 'random', seed: 1 })
        out.searchKeys = Object.keys(r || {}).slice(0, 14)
        out.searchTotal = (r && r.total) ?? null
        out.searchLen = (r && r.results ? r.results.length : -1)
      } catch (e) { out.searchErr = e.message }
      return out
    `)
    console.log('[smoke]', JSON.stringify(info, null, 2))
    if (pageErrors.length) {
      console.log('[smoke] 页面错误/警告:')
      for (const e of pageErrors.slice(0, 12)) console.log('   ', e.split('\n')[0])
    } else {
      console.log('[smoke] 页面无错误/警告')
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(SHOTS, { recursive: true })
    fs.writeFileSync(path.join(SHOTS, '00-smoke.png'), Buffer.from(shot.data, 'base64'))
    console.log('[smoke] 截图:', path.join(SHOTS, '00-smoke.png'))
  } finally {
    if (!KEEP) {
      try { ws.close() } catch { /* 忽略 */ }
      await sleep(400)
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 忽略 */ }
    }
  }
}

main().catch((e) => { console.error('[smoke] 失败:', e.message); process.exit(1) })
