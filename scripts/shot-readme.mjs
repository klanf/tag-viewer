/**
 * README 截图 —— 复用 e2e 工具链的最小脚本(不是测试, 只出图)。
 *
 * 约束(用户要求):
 *   · 所有网格图只看「涩不了一点」这一个来源(首页点来源胶囊过滤);
 *   · 安全模式全程打开(沙箱 data/safety.json 预置 on:true, 启动前写好)。
 *
 * 沙箱与隔离完全复用 scripts/harness.mjs 的 ensureWorkDir:
 *   数据是真实库的副本, 截图过程不碰真实库。
 * 产出: docs/images/{home,lightbox,series,cart,sources}.png
 *
 * 用法: node scripts/shot-readme.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { findElectron, electronEnv } from './electron-path.mjs'
import { freePort, clearPageState, ensureWorkDir, sleep, ROOT } from './harness.mjs'

const OUT = path.join(ROOT, 'docs', 'images')
let PORT = Number(process.env.TV_CDP_PORT || 0)

/* ---- 以下 Cdp / findPage / waitFor / HELPERS 与 scripts/e2e.mjs 同源 ---- */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
        }
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.errors.push(`exception: ${d.exception?.description || d.text}`)
      }
    })
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)) }
      }, timeoutMs)
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }
  async shot(name) {
    const t0 = Date.now()
    try { await this.send('Page.bringToFront', {}, 3000) } catch { /* 不支持就算了 */ }
    // 把鼠标挪到角落: 悬停提示框(黑底 tag tooltip)会跟着光标走,
    // 光标停在页面中间时它正好卡在截图正中, 挡住内容(首轮实测踩到)。
    try {
      await this.send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: 2, y: 2, button: 'none' }, 5000)
      await sleep(400)
    } catch { /* 拿不到 Input 域就算了 */ }
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log(`[shot] ${name}.png  (${Date.now() - t0}ms)`)
  }
}

async function findPage(timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* devtools 端口还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端口没起来')
}

async function waitFor(cdp, expr, { timeout = 20000, interval = 250, label = expr } = {}) {
  const body = /\breturn\b/.test(expr) ? expr : `return ${expr}`
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try {
      last = await cdp.eval(body)
      if (last) return last
    } catch (e) { last = `err:${e.message}` }
    await sleep(interval)
  }
  throw new Error(`等待超时: ${label} (最后值: ${JSON.stringify(last)})`)
}

const HELPERS = `
window.__t = {
  click(sel, idx = 0) {
    const els = document.querySelectorAll(sel)
    if (!els[idx]) throw new Error('找不到元素 ' + sel + '[' + idx + ']')
    els[idx].click()
    return els.length
  },
  clickText(sel, txt) {
    const el = [...document.querySelectorAll(sel)].find(e => e.textContent.includes(txt))
    if (!el) throw new Error('找不到含「' + txt + '」的 ' + sel)
    el.click()
    return true
  },
  count(sel) { return document.querySelectorAll(sel).length },
  text(sel, idx = 0) {
    const el = document.querySelectorAll(sel)[idx]
    return el ? el.textContent.trim() : ''
  },
}
return true`

/* ------------------------------------------------------------ 主流程 */

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const work = ensureWorkDir()

  // 安全模式: 启动前就写好 on:true(应用启动时读 data/safety.json)
  const safetyPath = path.join(work.dataDir, 'safety.json')
  fs.writeFileSync(safetyPath, JSON.stringify({ on: true, level: 'core' }, null, 2), 'utf8')
  console.log('[shot] 安全模式已预置 on:true ->', safetyPath)

  const exe = findElectron()
  if (!PORT) PORT = await freePort()
  console.log('[shot] electron:', exe, '· CDP 端口', PORT)

  const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${work.userData}`], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: electronEnv({ TV_DATA_DIR: work.dataDir }),
  })
  let childExited = null
  child.stderr.on('data', (b) => process.stderr.write(`[main!] ${b}`))
  child.on('exit', (code, sig) => { childExited = `code=${code} sig=${sig}` })

  const page = await findPage()
  if (childExited) throw new Error(`主进程已退出(${childExited}) —— 连到了别的实例`)
  if (!/dist[\\/]index\.html/.test(page.url)) throw new Error(`连到的不是本项目窗口: ${page.url}`)
  console.log('[shot] 已连上:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  try {
    await sleep(600)
    await clearPageState(cdp) // 清残留 localStorage(安全状态在 data/safety.json, 不受影响)
    await waitFor(cdp, `!!document.querySelector('#app .hdr')`, { label: '顶栏出现', timeout: 30000 })
    await cdp.eval(HELPERS)
    await waitFor(cdp, `
      const s = await window.tv.invoke('app:status')
      return s.phase === 'ready'
    `, { label: '数据集 ready', timeout: 180000 })

    /* ---- 1. 看板: 来源胶囊「涩不了一点」+ 安全模式 ---- */
    await waitFor(cdp, `__t.count('.grid .card') > 0`, { label: '首页卡片', timeout: 60000 })
    // 安全模式确认: 界面开关必须是 on, 不是就点一下
    const safeOn = await cdp.eval(`return !!document.querySelector('.result-head .safe-tog.on')`)
    if (!safeOn) {
      await cdp.eval(`__t.click('.result-head .safe-tog .st-btn'); return true`)
      await sleep(600)
    }
    console.log('[shot] 安全模式 =', await cdp.eval(`return !!document.querySelector('.result-head .safe-tog.on')`))
    // 来源过滤
    await cdp.eval(`__t.clickText('.src-bar .tv-chip', '涩不了一点'); return true`)
    await sleep(1200)
    const srcState = await cdp.eval(`
      const chip = [...document.querySelectorAll('.src-bar .tv-chip')].find(e => e.textContent.includes('涩不了一点'))
      return { on: chip ? chip.className : 'missing', total: __t.text('.result-head b') }
    `)
    console.log('[shot] 来源胶囊「涩不了一点」:', JSON.stringify(srcState))
    await waitFor(cdp, `__t.count('.grid .card') > 0 && __t.count('.grid .tv-img.loaded') > 0`,
      { label: '过滤后缩略图', timeout: 60000 })
    await sleep(2000) // 再让一批缩略图落定
    await cdp.shot('home')

    /* ---- 2. 大图预览 ---- */
    await cdp.eval(`__t.click('.grid .card'); return true`)
    await waitFor(cdp, `!!document.querySelector('.lightbox')`, { label: 'lightbox 打开', timeout: 20000 })
    await sleep(2500) // 等大图 + 标签渲染
    await cdp.shot('lightbox')
    // 关闭: 先试 Escape, 不行就整页重载
    await cdp.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    `)
    await sleep(600)
    const lbOpen = await cdp.eval(`return !!document.querySelector('.lightbox')`)
    if (lbOpen) {
      await cdp.eval(`location.reload(); return true`)
      await waitFor(cdp, `!!document.querySelector('#app .hdr')`, { label: '重载后顶栏', timeout: 30000 })
      await cdp.eval(HELPERS)
      await waitFor(cdp, `
        const s = await window.tv.invoke('app:status')
        return s.phase === 'ready'
      `, { label: '重载后 ready', timeout: 180000 })
      await sleep(800)
    }

    /* ---- 3. 系列浏览 ---- */
    await cdp.eval(`__t.clickText('.hdr .nv', '系列'); return true`)
    await waitFor(cdp, `__t.count('.ecard') > 0`, { label: '系列卡片', timeout: 60000 })
    await sleep(2000)
    await cdp.shot('series')

    /* ---- 4. 购物车: 先从当前系列批量入车, 让购物车有内容 ---- */
    await cdp.eval(`
      const hit = document.querySelector('.ecard')
      hit.click()
      return true
    `)
    await waitFor(cdp, `__t.count('.ecard') > 0 && __t.text('.cat-bar .hint').includes('角色')`,
      { label: '角色列表', timeout: 40000 })
    await cdp.eval(`
      __t.clickText('.cat-bar .tv-btn', '选择导出')
      await new Promise(r => setTimeout(r, 600))
      __t.clickText('.cat-bar .tv-btn', '全选')
      await new Promise(r => setTimeout(r, 600))
      __t.clickText('.cat-bar .tv-btn', '全部加入购物车')
      await new Promise(r => setTimeout(r, 900))
      return true
    `)
    await cdp.eval(`__t.clickText('.hdr .nv', '购物车'); return true`)
    await waitFor(cdp, `__t.count('.ci') > 0`, { label: '购物车条目', timeout: 30000 })
    await sleep(1200)
    await cdp.shot('cart')

    /* ---- 5. 来源管理(从扫描页入口进) ---- */
    await cdp.eval(`location.hash = '#/scan'; return true`)
    await waitFor(cdp, `!!document.querySelector('[data-test="goto-sources"]')`,
      { label: '扫描页来源入口', timeout: 20000 })
    await cdp.eval(`document.querySelector('[data-test="goto-sources"]').click(); return true`)
    await waitFor(cdp, `__t.count('.source-view .rows .row') > 0`, { label: '来源登记表', timeout: 20000 })
    await sleep(800)
    await cdp.shot('sources')

    console.log('[shot] 全部完成 ->', OUT)
  } finally {
    try { ws.close() } catch { /* 忽略 */ }
    if (!childExited) child.kill()
    await sleep(800)
    if (!childExited) { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }
  }
}

main().catch((e) => {
  console.error('[shot] 失败:', e.message)
  process.exitCode = 1
})
