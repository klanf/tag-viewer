/**
 * 首次登记链路测试(空数据 -> 一键首启)
 * ======================================
 * 守的是 2026-10-02 绿色包用户实测踩中的死锁: 空库时 bootstrap 失败,
 * IPC 的「数据就绪门禁」把 folders:add 也拦住 -> 第一个文件夹永远登记不进去,
 * 引导页选完文件夹又报"没有可用的标签数据"。
 *
 * 修法: folders:add 移出 DATA_CHANNELS(登记与同步直接走 tags.db, 不读内存数据集);
 * 引导页(TvBootOverlay.startWithFolder)登记后显式 ingest:run 并等第一批记录落库再 reload。
 * 本测试走的就是这条完整链路(与引导页同参同序):
 *   空数据启动 -> folders:add(5 张夹具图) -> ingest:run -> 轮询 inserted>0
 *   -> app:reload -> app:status 必须 ready 且 records>0
 *
 * 用法: node scripts/test-first-run.mjs   (会短暂弹出一个真实窗口, 结束时自己关掉)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { findElectron, electronEnv } = await load('scripts/electron-path.mjs')
const { freePort } = await load('scripts/harness.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  — ' + extra}`)
  cond ? pass++ : fail++
}

/* ---------------- CDP 客户端(与 e2e.mjs 同路子) ---------------- */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)   // Node 22+ 内置
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
    const c = new Cdp(ws)
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (m.id !== undefined && c.pending.has(m.id)) {
        const p = c.pending.get(m.id)
        c.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
    })
    return c
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
}

async function findPage(port, timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch { /* 端口没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端口没起来')
}

/* ---------------- 沙箱: 全空的数据目录 ---------------- */
const WORK = path.join(ROOT, '.e2e-work', 'first-run')
const DATA = path.join(WORK, 'empty-data')
const USER_DATA = path.join(WORK, 'userdata')
const FOLDER = path.join(ROOT, 'test-fixtures', 'scan-test')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
if (!fs.existsSync(path.join(FOLDER, 'a1.png'))) {
  console.error('✗ 夹具缺失: 先生成 test-fixtures/scan-test(见 make_scan_test.py)')
  process.exit(1)
}

const exe = findElectron()
const PORT = await freePort()
const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  // TV_INGEST=1: 生产形态没有这道闸门, 测试里也要放开(electronEnv 默认关)
  env: electronEnv({ TV_DATA_DIR: DATA, TV_LOG_DIR: path.join(WORK, 'logs'), TV_INGEST: '1' }),
})
let childExited = null
child.on('exit', (code, sig) => { childExited = `code=${code} sig=${sig}` })

let failHard = false
try {
  const page = await findPage(PORT)
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  // 1. 空数据启动 -> 引导页的一键首启入口
  let boot = ''
  for (let i = 0; i < 60; i++) {
    boot = await cdp.eval("return document.querySelector('.boot') ? document.body.innerText : ''").catch(() => '')
    if (boot.includes('选择图片文件夹')) break
    await sleep(400)
  }
  ok('空数据启动走到引导页, 且是一键首启的文案', boot.includes('选择图片文件夹'),
    boot.slice(0, 80).replace(/\s+/g, ' '))
  ok('引导不再教新用户写配置文件', !boot.includes('tags_*.txt'))

  // 2. 登记夹具目录(与引导页 addFolder 同参) —— 门禁修复前这里会被 whenReady 拒掉
  const add = await cdp.eval(`return await window.tv.invoke('folders:add', ${JSON.stringify({ path: FOLDER, as_source: true, as_scan: false, recursive: true })})`)
  ok('空库也能登记文件夹(门禁不再拦截)', !add?.error, JSON.stringify(add?.error || {}).slice(0, 120))

  // 3. 显式拉同步(与引导页同款兜底; 登记跃迁的自动接同步不覆盖全新行)
  const run = await cdp.eval(`return await window.tv.invoke('ingest:run')`)
  ok('ingest:run 已受理', !!run?.started, JSON.stringify(run || {}).slice(0, 80))

  // 4. 等第一批记录落库(与引导页 waitFirstRecords 同款判定)
  let ins = 0
  for (let i = 0; i < 120; i++) {
    const st = await cdp.eval(`return await window.tv.invoke('ingest:status')`)
    ins = Number(st?.stats?.inserted) || 0
    if (ins > 0) break
    await sleep(500)
  }
  ok('第一批记录落库(inserted>0)', ins > 0, `inserted=${ins}`)

  // 5. reload -> ready 且有数据(修前是 phase=error 的死循环)
  await cdp.eval(`return await window.tv.invoke('app:reload')`)
  let st = null
  for (let i = 0; i < 60; i++) {
    st = await cdp.eval(`return await window.tv.invoke('app:status')`)
    if (st?.phase === 'ready') break
    await sleep(400)
  }
  ok('重载后数据集 ready(死锁解除)', st?.phase === 'ready', `phase=${st?.phase} error=${st?.error || ''}`)
  ok('看板有数据了', Number(st?.stats?.records) > 0, `records=${st?.stats?.records}`)
  ok('主进程没有中途退出', childExited === null, childExited || '')
} catch (e) {
  console.log(`  ✗ 测试异常: ${e.message}`)
  failHard = true
} finally {
  if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(500)
  }
}
console.log(`\n结果: ${pass} 通过 / ${fail + (failHard ? 1 : 0)} 失败`)
process.exit(fail || failHard ? 1 : 0)
