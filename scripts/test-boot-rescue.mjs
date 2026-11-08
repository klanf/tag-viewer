/**
 * 启动遮罩的「自救入口」回归测试
 * ================================
 * 守的是 2026-11-08 那次线上事故的**后半段**:
 *   2.4.0 因为知识包没打进安装包, 新用户一开机就停在错误页 —— 而错误页上
 *   一个能救命的按钮都没有(顶栏被全屏遮罩盖着, 「检查更新」只长在设置弹窗里)。
 *   同一个遮罩在**加载中**那一态更是连按钮都没有: 主进程一旦卡在某个同步段
 *   (库被另一实例/反推进程占着、数据目录在掉线的网盘上), 界面就永久停在
 *   第一帧 0%, 用户只能强杀, 还以为是"更新把软件搞坏了"。
 *
 * 所以这里断言三件事(全部读**真实 DOM**, 不读源码字符串):
 *   ① 加载中就有「检查更新」入口(右下角常驻, 带版本号);
 *   ② 45 秒没有任何进度变化后, 自动摆出「看着像卡住了」的面板 + 三个自救按钮;
 *   ③ 落到失败态之后, 右下角入口仍然在(任何 "进不去" 的状态都能自己升级)。
 *
 * 「卡住」用主进程的 TV_LOAD_DELAY_MS 钩子人为造 —— 真机上这种卡是外部原因
 * (杀毒扫描 / 网盘掉线 / db 被占), 不可能稳定复现, 只能显式造。
 *
 * 用法: node scripts/test-boot-rescue.mjs
 *       (会弹一个真实窗口, 全程约 60s, 结束时自己关掉)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { ROOT, freePort, sleep } from './harness.mjs'
import { findElectron, electronEnv } from './electron-path.mjs'

/** 人为延迟首载 —— 必须 > 遮罩的卡住阈值(45s), 再留点余量给渲染 */
const LOAD_DELAY_MS = 52000
const STUCK_AFTER_S = 45

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/* ---------------- 沙箱: 空数据目录(全新用户的处境) ---------------- */
const WORK = path.join(ROOT, '.e2e-work', 'boot-rescue')
const DATA = path.join(WORK, 'empty-data')
const USER_DATA = path.join(WORK, 'userdata')
const LOG_DIR = path.join(WORK, 'logs')
const SHOTS = path.join(WORK, 'shots')
for (const d of [WORK, DATA, USER_DATA, LOG_DIR, SHOTS]) fs.mkdirSync(d, { recursive: true })
for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true })

/* ---------------- CDP 客户端(最小版, 与 test-nodata-boot.mjs 同路子) ---------------- */
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }

  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
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

/** 读遮罩现状: 阶段文案 / 是否有右下角入口 / 是否出了卡住面板 */
const PROBE = `
  const boot = document.querySelector('.boot')
  if (!boot) return { boot: false }
  const foot = document.querySelector('.boot .foot .link')
  const warn = document.querySelector('.boot .warn')
  const btns = [...document.querySelectorAll('.boot .btns button')].map((b) => b.innerText.trim())
  return {
    boot: true,
    text: boot.innerText,
    footText: foot ? foot.innerText.trim() : '',
    footDisabled: foot ? foot.disabled : null,
    version: (document.querySelector('.boot .foot .ver') || {}).innerText || '',
    warnText: warn ? warn.innerText.trim() : '',
    btns,
  }
`

const exe = findElectron()
const PORT = await freePort()
console.log(`[rescue] electron = ${exe}`)
console.log(`[rescue] 人为延迟首载 = ${LOAD_DELAY_MS}ms, 卡住阈值 = ${STUCK_AFTER_S}s`)
console.log(`[rescue] CDP 端口 = ${PORT}`)

const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '--disable-background-timer-throttling'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: electronEnv({
    TV_DATA_DIR: DATA,
    TV_LOG_DIR: LOG_DIR,
    TV_LOAD_DELAY_MS: String(LOAD_DELAY_MS),
    TV_E2E_NOFOCUS: '1',
  }),
})
let childExited = null
child.stdout.on('data', (b) => process.stdout.write(`[main] ${b}`))
child.stderr.on('data', (b) => process.stderr.write(`[main!] ${b}`))
child.on('exit', (code, sig) => { childExited = `code=${code} sig=${sig}` })

const t0 = Date.now()
try {
  const page = await findPage(PORT)
  ok('主进程没崩, 渲染进程可连', () => assert.equal(childExited, null, `主进程提前退出: ${childExited}`))

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  /* ---------- ① 加载中: 右下角就该有入口 ---------- */
  let loading = null
  for (let i = 0; i < 60; i++) {
    loading = await cdp.eval(PROBE)
    if (loading.boot && loading.footText) break
    await sleep(250)
  }
  ok('加载中遮罩渲染出来了', () => assert.ok(loading?.boot, '没有 .boot 遮罩'))
  ok('加载中就有「检查更新」入口(以前这一态一个按钮都没有)', () => {
    assert.equal(loading.footText, '检查更新', `实际: ${JSON.stringify(loading.footText)}`)
    assert.equal(loading.footDisabled, false, '按钮不该是禁用的')
  })
  ok('右下角还标了当前版本号(报障时能对上是哪一版)', () => {
    assert.match(loading.version, /^v\d+\.\d+\.\d+/, `实际: ${JSON.stringify(loading.version)}`)
  })
  ok('加载中的阶段文案不再谎报"解析标签文件"', () => {
    /* 首帧(app:progress)有可能在渲染层订阅之前就发出去了, 所以这里轮询到
     * 文案落定为止 —— 遮罩自己也有 api.status() 的兜底轮询(900ms 一拍)。 */
    assert.ok(!loading.text.includes('没有任何进展'), '45 秒还没到, 不该提前报警')
  })
  /* 阶段文案在首帧丢失时会是「正在准备」, 兜底轮询(900ms)之后必须落到真实阶段 */
  let phased = loading
  for (let i = 0; i < 12; i++) {
    if (/正在读取配置|正在核对标签来源|正在从标签库读取记录|正在解析标签文件/.test(phased.text)) break
    await sleep(300)
    phased = await cdp.eval(PROBE)
  }
  ok('阶段文案落到了真实阶段(而不是永远「正在准备」)', () => {
    assert.ok(/正在读取配置|正在核对标签来源|正在从标签库读取记录|正在解析标签文件/.test(phased.text),
      `实际文案:\n${phased.text.slice(0, 200)}`)
    /* 这条是本次改动的核心: 慢加载卡在「读配置/核对来源」时, 文案不能再说
     * "正在解析标签文件" —— 那句会把人往 txt/模型上带偏(2026-11-08 报障就是) */
    assert.ok(!phased.text.includes('正在解析标签文件'), `又谎报了:\n${phased.text.slice(0, 200)}`)
  })

  /* ---------- ② 45 秒没动静 -> 自动摆出"卡住"面板 ---------- */
  let stuck = null
  for (let i = 0; i < Math.ceil((STUCK_AFTER_S + 12) * 2); i++) {
    stuck = await cdp.eval(PROBE)
    if (stuck.warnText) break
    await sleep(500)
  }
  const waited = ((Date.now() - t0) / 1000).toFixed(1)
  ok(`卡住超过 ${STUCK_AFTER_S}s 后自动提示(实测 ${waited}s 时就报了)`, () => {
    assert.ok(stuck.warnText, '没有出现 .warn 面板 —— 用户仍然只有一个 0% 干等')
    assert.ok(/没有任何进展/.test(stuck.warnText), `实际: ${stuck.warnText.slice(0, 200)}`)
  })
  ok('卡住面板给了三个自救按钮(打开数据目录 / 重试 / 检查更新)', () => {
    const all = stuck.btns.join('|')
    for (const k of ['打开数据目录', '重试', '检查更新']) {
      assert.ok(all.includes(k), `缺「${k}」, 实际按钮: ${all}`)
    }
  })
  const shot = await cdp.shot(path.join(SHOTS, 'boot-rescue-stuck.png'))
  console.log(`  · 截图: ${shot}`)

  /* ---------- ③ 慢加载结束后落到失败态, 右下角入口仍在 ---------- */
  let errState = null
  for (let i = 0; i < 120; i++) {
    errState = await cdp.eval(PROBE)
    if (errState.text && /还没有登记图片文件夹|数据加载失败/.test(errState.text)) break
    await sleep(500)
  }
  ok('延迟结束后正常落到"还没有登记文件夹"引导(没有因为慢而误判)', () => {
    assert.ok(errState.text.includes('还没有登记图片文件夹'), `实际文案:\n${errState.text.slice(0, 300)}`)
  })
  ok('失败态右下角仍挂着「检查更新」(任何进不去的状态都能自救)', () => {
    assert.equal(errState.footText, '检查更新', `实际: ${JSON.stringify(errState.footText)}`)
  })
  ok('没有未捕获的渲染进程异常', () => assert.deepEqual(cdp.exceptions, []))
} finally {
  /* 只按本次 spawn 的 pid 杀(带 /T), 绝不按进程名 —— 本机还有别的 Electron 应用 */
  if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(600)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
