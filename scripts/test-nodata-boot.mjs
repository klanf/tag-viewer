/**
 * 空数据目录下的启动降级测试
 * ============================
 * 守的是**全新用户第一次打开**这条路 —— 这也是开源发布后最多人走的那条:
 * 机器上一个标签文件都没有, 没有登记过任何文件夹, 数据目录是空的。
 *
 * 要求(缺一不可):
 *   1. 主进程不能崩, 窗口要真的显示出来(不是白屏、不是"双击没反应");
 *   2. 不能把空当成"用户把来源都删了"去清库 —— 由 scripts/test-db-safety.mjs 单独守;
 *   3. 界面要给出**可操作的引导**(就地选个文件夹登记就能开始),
 *      而不是只甩一句技术错误、更不是教新用户去写配置文件。
 *
 * 第 3 条靠读 DOM 上的实际文案来断言, 不是读源码里的字符串 —— 免得改了模板还以为过了。
 *
 * 用法: node scripts/test-nodata-boot.mjs   (会短暂弹出一个真实窗口, 结束时自己关掉)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { ROOT, freePort, sleep } from './harness.mjs'
import { findElectron, electronEnv } from './electron-path.mjs'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/* ---------------- 沙箱: 一个**空**的数据目录 ----------------
 * 注意不要把 WORK 整个删掉重来: .e2e-work/userdata 里是 leveldb,
 * 跑几轮就攒到 50+ 个小文件, 整目录删除会被执行环境的批量删除保护拦下。
 * 这里只需要保证"数据目录里没有东西", 逐个文件清即可。
 */
const WORK = path.join(ROOT, '.e2e-work', 'nodata')
const DATA = path.join(WORK, 'empty-data')
const USER_DATA = path.join(WORK, 'userdata')
for (const d of [WORK, DATA, USER_DATA]) fs.mkdirSync(d, { recursive: true })
for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true })
ok('准备: 数据目录是空的', () => assert.deepEqual(fs.readdirSync(DATA), []))

/* ---------------- CDP 客户端(最小版, 与 e2e.mjs 同路子: 不用 Playwright) ---------------- */
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.exceptions = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== undefined) {
        const p = this.pending.get(m.id)
        if (p) {
          this.pending.delete(m.id)
          m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
        }
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(m.params?.exceptionDetails?.exception?.description || 'unknown')
      }
    })
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
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
    } catch { /* devtools 端口还没起来 */ }
    await sleep(250)
  }
  throw new Error(`CDP 端口没起来(port=${port})`)
}

/* ---------------- 起应用 ---------------- */
const exe = findElectron()
const PORT = await freePort()
// TV_LOG_DIR 指到沙箱里, 免得把这次"故意失败"的启动日志写进项目 logs/ 混淆视听
const LOG_DIR = path.join(WORK, 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
console.log(`[nodata] electron = ${exe}`)
console.log(`[nodata] 空数据目录 = ${DATA}`)
console.log(`[nodata] CDP 端口  = ${PORT}`)

const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: electronEnv({ TV_DATA_DIR: DATA, TV_LOG_DIR: LOG_DIR }),
})
let childExited = null
child.stdout.on('data', (b) => process.stdout.write(`[main] ${b}`))
child.stderr.on('data', (b) => process.stderr.write(`[main!] ${b}`))
child.on('exit', (code, sig) => { childExited = `code=${code} sig=${sig}` })

let cdp = null
try {
  const page = await findPage(PORT)
  ok('主进程没崩, 渲染进程可连', () => {
    assert.equal(childExited, null, `主进程提前退出: ${childExited}`)
  })
  ok('连到的是本项目的窗口', () => {
    assert.match(page.url, /dist[\\/]index\.html/, `实际 url: ${page.url}`)
  })

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')

  // 等加载器把失败态渲染出来(数据集解析失败是异步的)
  const bootText = await (async () => {
    for (let i = 0; i < 100; i++) {
      const t = await cdp.eval("return document.querySelector('.boot') ? document.body.innerText : ''")
      if (t && (t.includes('数据加载失败') || t.includes('还没有登记图片文件夹'))) return t
      await sleep(300)
    }
    return await cdp.eval("return document.body.innerText")
  })()

  ok('窗口不是白屏(遮罩出来了)', () => assert.ok(bootText.length > 0, 'boot 遮罩没有渲染出任何文字'))
  ok('走的是"还没登记文件夹"的引导, 而不是笼统报错', () => {
    assert.ok(bootText.includes('还没有登记图片文件夹'), `实际文案:\n${bootText.slice(0, 300)}`)
    assert.ok(!bootText.includes('❌ 数据加载失败'), '空的配置不该落到笼统错误分支')
  })
  ok('引导是一键即用的: 有「选择图片文件夹」入口, 不再教人写配置文件', () => {
    assert.ok(bootText.includes('选择图片文件夹'), `实际文案:\n${bootText.slice(0, 300)}`)
    assert.ok(!bootText.includes('tags_*.txt'), '新用户引导里不该再出现 tags_*.txt 话术')
  })
  ok('引导里给出了出错的数据目录(可操作)', () => {
    assert.ok(bootText.includes('数据目录'), '缺"数据目录"提示')
    assert.ok(bootText.replace(/\//g, '\\').includes(DATA.replace(/\//g, '\\')), '提示里没有指向真实的数据目录')
  })
  ok('引导里有「重试」「打开数据目录」按钮', () => {
    assert.ok(bootText.includes('重试') && bootText.includes('打开数据目录'))
  })
  ok('没有未捕获的渲染进程异常', () => {
    assert.deepEqual(cdp.exceptions, [])
  })

  // 主进程侧: 就绪标记要写出来(启动脚本就是靠它判成败的)
  const flag = path.join(LOG_DIR, 'ready.flag')
  const have = await (async () => {
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(flag)) return true
      await sleep(200)
    }
    return false
  })()
  ok('写出了就绪标记(启动脚本会判为"起来了")', () => assert.ok(have, `缺 ${flag}`))

  const log = fs.existsSync(path.join(LOG_DIR, 'launch.log'))
    ? fs.readFileSync(path.join(LOG_DIR, 'launch.log'), 'utf8')
    : ''
  ok('日志里记下了 phase=error 的原因', () => {
    assert.ok(/没有可用的标签数据|数据集加载失败|error/i.test(log), '日志里没有失败原因')
  })
  ok('日志里没有 fatal(没有崩溃)', () => {
    assert.ok(!/\[fatal\]/.test(log), `日志里有 fatal:\n${log.split('\n').filter((l) => l.includes('[fatal]')).join('\n')}`)
  })
} finally {
  /* ---------------- 收尾: 只按 PID 杀, 绝不按进程名 ----------------
   * 本机同时跑着壁纸切换器等多个 Electron 应用, taskkill /IM electron.exe
   * 会误杀用户的小工具(踩过)。这里用本次 spawn 出来的 pid + /T(连带子进程)。
   */
  if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(600)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
