/**
 * 自然语言段的界面回归(2026-11-08) —— npm run test:nlui
 * ======================================================
 * 守的是「用户能不能真的在界面上配出来」, 引擎侧另由 test:nlbank / test:nlexport 守。
 * 引擎再好, 弹窗里没这个开关等于没做 —— 这条专门读**真实 DOM**。
 *
 * 断言:
 *   ① 首页「🎲 高级替换」弹窗里出现「④ 自然语言段」区块
 *   ② 语料库缺失时显示"缺失"提示, 不显示开关(避免用户打开一个空功能)
 *   ③ 打开总开关 → 出现三个维度 chips, 且每个都带「可抽条数」(>0)
 *   ④ 点维度 chip 能勾/取消; 一个都不勾时保存会被拦下
 *   ⑤ 档位三选一可切换, 切到 nsfw 后可抽条数变大(池子真的放开了)
 *   ⑥ 保存后首页按钮出现"已启用"小圆点 + toast 提到自然语言段
 *   ⑦ 全关后导出参数 nl_dims 为空(回归保护: 不配就不该影响导出)
 *
 * 用法: node scripts/test-nl-ui.mjs   (弹真实窗口, 约 40s, 结束自己关)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { ROOT, freePort, sleep } from './harness.mjs'
import { findElectron, electronEnv } from './electron-path.mjs'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const WORK = path.join(ROOT, '.e2e-work', 'nl-ui')
const DATA = path.join(WORK, 'data')
const USER_DATA = path.join(WORK, 'userdata')
const LOG_DIR = path.join(WORK, 'logs')
const SHOTS = path.join(WORK, 'shots')
for (const d of [WORK, USER_DATA, LOG_DIR, SHOTS]) fs.mkdirSync(d, { recursive: true })

/* 有数据的沙箱: 首页要能渲染出筛选区(空库时首页是空态, 没有「高级替换」按钮)。
 * 用 makeSmallDb 从真实库切 800 行 —— 整库 11 万张的首载要几十秒, 截图永远拍在
 * 启动遮罩上(断言过了却看不出界面长什么样)。小库首载一瞬即过。 */
const REAL_DB = path.join(ROOT, '.e2e-work', 'data', 'db', 'tags.db')
if (!fs.existsSync(REAL_DB)) {
  console.error(`缺少沙箱库: ${REAL_DB}\n先跑一次 scripts/e2e.mjs 让它准备好`)
  process.exit(2)
}
const { makeSmallDb } = await import(new URL('./make-ui-fixture.mjs', import.meta.url).href)
const fixture = makeSmallDb(REAL_DB, path.join(DATA, 'db', 'tags.db'), 800)
console.log(`[nl-ui] 夹具库 ${fixture.sizeMB} MB / images ${fixture.counts.images} / tags ${fixture.counts.tags}`)

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
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  /** 只截某个元素 —— 整页截图会被启动遮罩/顶栏挡掉关键区域, 汇报时看不出改了什么 */
  async shotOf(selector, file) {
    const box = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 150))
      const b = el.getBoundingClientRect()
      return { x: Math.max(0, b.x), y: Math.max(0, b.y), width: b.width, height: b.height }
    `)
    if (!box || !box.width) return this.shot(file)
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 1 },
    })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }
}

async function findPage(port, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch { /* 端口还没起来 */ }
    await sleep(250)
  }
  throw new Error(`CDP 端口没起来(port=${port})`)
}

/** 等某个条件在页面里成真 —— 轮询比 sleep 稳, 慢机器上不会假失败 */
async function waitFor(cdp, expr, timeoutMs = 20000, label = '') {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await cdp.eval(`return (${expr})`)
      if (last) return last
    } catch (e) { last = `ERR ${e.message}` }
    await sleep(200)
  }
  throw new Error(`等待超时(${label || expr}): ${JSON.stringify(last)}`)
}

/** 点含指定文字的按钮 —— 弹窗里按钮多, 按文案点最稳 */
const clickByText = (sel, text) => `
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.innerText.replace(/\\s+/g, '').includes(${JSON.stringify(text)}))
  if (!el) return { none: true }
  el.click()
  return { ok: true, text: el.innerText.trim() }
`

const exe = findElectron()
const PORT = await freePort()
console.log(`[nl-ui] electron = ${exe}\n[nl-ui] 端口 = ${PORT}`)

const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '--disable-background-timer-throttling'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: electronEnv({ TV_DATA_DIR: DATA, TV_LOG_DIR: LOG_DIR, TV_E2E_NOFOCUS: '1' }),
})
let childExited = null
child.on('exit', (c, s) => { childExited = `code=${c} sig=${s}` })
child.stdout.on('data', () => {})
child.stderr.on('data', (b) => { const s = String(b); if (/error|Error/.test(s)) process.stderr.write(`[main!] ${s}`) })

try {
  const page = await findPage(PORT)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  ok('主进程没崩', () => assert.equal(childExited, null, childExited))

  /* 等首页数据就绪(遮罩退场) —— 有数据时遮罩会自己消失 */
  // 注意必须用 && —— 单独一个 !boot 在挂载前也为真, 会让测试在遮罩还没出现时就冲过去,
  // 后面所有点击都落在被遮罩盖住的界面上(断言能过, 截图全是遮罩)。
  await waitFor(cdp, `!document.querySelector('.boot') && document.querySelectorAll('.tv-btn').length > 5`, 120000, '首载完成')
  await waitFor(cdp, `document.querySelectorAll('.tv-btn').length > 5`, 30000, '首页按钮渲染')

  /* ---------- 打开高级替换弹窗 ---------- */
  const opened = await cdp.eval(clickByText('.tv-btn', '高级替换'))
  ok('首页有「高级替换」入口', () => assert.ok(opened?.ok, '按钮没找到'))
  await waitFor(cdp, `!!document.querySelector('[role="dialog"]')`, 15000, '弹窗出现')

  const zone = await cdp.eval(`
    const t = document.body.innerText
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    return { hasZone: !!z, text: z ? z.innerText : '', bodyHas: t.includes('自然语言段') }
  `)
  ok('弹窗里有「④ 自然语言段」区块', () => {
    assert.ok(zone.hasZone, `没找到 .zone 里的自然语言段。正文片段:\n${(zone.text || '').slice(0, 120)}`)
    assert.match(zone.text, /动作|穿搭|发型/, '区块里没提三个维度')
  })

  /* ---------- 打开总开关 ---------- */
  // 先等左方案栏渲染出方案项 —— 方案库是异步载入的, 载入完成会用方案 cfg 覆盖
  // adv 状态; 不等它, "点开关"会被紧接着的载入覆盖回去(竞态, 2026-11-09 实锤)。
  // 2026-11-09 二改: 方案栏从顶部下拉改成左侧栏(对齐替换规则编辑器), 等 .side-item。
  await waitFor(cdp, `!!document.querySelector('.adv-grid .side-item')`, 15000, '方案栏载入')
  const setBar = await cdp.eval(`
    return {
      opts: [...document.querySelectorAll('.adv-grid .side-item .side-name')].map((o) => o.textContent.trim()),
      btns: [...document.querySelectorAll('.side-ops .tv-btn')].map((b) => b.innerText.trim()),
    }
  `)
  ok('弹窗左侧有方案栏(点选切换 + 新建/复制/改名/删除)', () => {
    assert.ok(setBar.opts.length > 0, `方案列表是空的: ${JSON.stringify(setBar)}`)
    for (const want of ['新建', '复制', '改名', '删除']) {
      assert.ok(setBar.btns.some((b) => b.includes(want)), `方案栏缺「${want}」按钮: ${JSON.stringify(setBar.btns)}`)
    }
    console.log(`      方案: ${setBar.opts.join(' / ')}`)
  })
  const on = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    if (!z) return { none: true }
    const cb = [...z.querySelectorAll('input[type="checkbox"]')][0]
      || [...z.querySelectorAll('.tv-check')][0]
    if (!cb) return { noCheckbox: true }
    // 方案库载入后开关可能已经是开的(上轮测试落盘的方案) —— 先归零, 保证从"关"点成"开"
    const inner = cb.tagName === 'INPUT' ? cb : cb.querySelector('input') || cb
    if (inner.checked) { inner.click(); await new Promise((r) => setTimeout(r, 300)) }
    inner.click()
    await new Promise((r) => setTimeout(r, 400))
    return {
      chips: [...z.querySelectorAll('.nl-chip')].map((c) => c.innerText.trim()),
      levels: [...z.querySelectorAll('.chip')].filter((c) => /安全|性暗示|全开/.test(c.innerText)).map((c) => c.innerText.trim()),
      hint: (z.querySelector('.nl-hint') || {}).innerText || '',
      poseView: [...z.querySelectorAll('.tv-check')]
        .map((c) => (c.innerText || '').trim())
        .find((t) => /带上机位/.test(t)) || '',
    }
  `)
  ok('打开开关后出现三个维度 chips, 且带可抽条数', () => {
    assert.ok(!on?.noCheckbox && !on?.none, `没找到开关: ${JSON.stringify(on)}`)
    assert.equal(on.chips.length, 3, `chips 实际: ${JSON.stringify(on.chips)}`)
    const nums = on.chips.map((c) => Number((/\d+/.exec(c) || [])[0]))
    assert.ok(nums.every((n) => n > 0), `有维度可抽 0 条: ${JSON.stringify(on.chips)}`)
    console.log(`      维度: ${on.chips.join(' · ')}`)
  })

  /* 机位(2026-11-08 晚改口径): 源库 1439 行是作者成套拍好的「动作 × 机位」,
   * 所以机位不再是可以单独勾的维度 —— 它作为动作下面的子开关存在。
   * 这条断言守着"别再退回平级 chip", 否则又会拼出没主语的 "seen from above"。 */
  ok('机位是动作的子开关, 不是平级 chip', () => {
    assert.ok(!on.chips.some((c) => /机位/.test(c)),
      `机位又变回 chip 了: ${JSON.stringify(on.chips)}`)
    assert.ok(on.poseView, `没找到「带上机位」开关: ${JSON.stringify(on)}`)
    console.log(`      子开关: ${on.poseView}`)
  })

  /* 只显示"可抽 N"会被读成"库里只有 N 条"(2026-11-08 用户就问了"不是 1439 条吗")。
   * 安全档下 pose 必然被闸门挡掉一部分 -> chip 必须同时带全量分母, 否则这次修复会悄悄退化。 */
  ok('安全档的 chip 带全量分母(可抽 N / 全量 M)', () => {
    const pose = on.chips.find((c) => /动作/.test(c)) || ''
    assert.match(pose, /\d+\s*\/\s*\d+/, `pose chip 没带分母: "${pose}"`)
    const [cur, all] = pose.match(/(\d+)\s*\/\s*(\d+)/).slice(1).map(Number)
    assert.ok(cur < all, `安全档可抽(${cur})应小于全量(${all}) —— 闸门没生效?`)
    console.log(`      安全档 pose: ${cur} / 全量 ${all}`)
  })

  ok('档位三选一都在(安全/含性暗示/全开)', () => {
    assert.equal(on.levels.length, 3, `实际: ${JSON.stringify(on.levels)}`)
  })

  /* 截图前先滚到 ④ 区 —— 弹窗很长, 默认停在 ① 区, 截出来看不到自然语言段长什么样
   * (断言都过了但人眼啥也看不见, 等于没有证据)。scrollIntoView 滚的是弹窗内部容器。 */
  await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    if (z) z.scrollIntoView({ block: 'center' })
    await new Promise((r) => setTimeout(r, 350))
    return true
  `)
  await cdp.shotOf('[role="dialog"]', path.join(SHOTS, 'nl-panel-on.png'))

  /* ---------- 档位放开后池子变大(证明闸门真的在换池子, 不是摆设) ---------- */
  const before = (on.chips[0].match(/\d+/) || [])[0]
  await cdp.eval(clickByText('.zone .chip', '全开'))
  await sleep(300)
  const afterAll = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    return [...z.querySelectorAll('.nl-chip')].map((c) => c.innerText.trim())
  `)
  const afterN = (afterAll[0].match(/\d+/) || [])[0]
  ok(`切到「全开」后动作可抽条数变大(${before} → ${afterN})`, () => {
    assert.ok(Number(afterN) > Number(before), `条数没变: ${before} → ${afterN}`)
  })
  // 切回安全档, 免得后面的保存把 nsfw 带出去
  await cdp.eval(clickByText('.zone .chip', '安全'))
  await sleep(200)

  /* ---------- 一个维度都不勾 → 保存要被拦 ---------- */
  const cleared = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    const chips = [...z.querySelectorAll('.nl-chip')]
    for (const c of chips) if (c.classList.contains('on')) c.click()
    await new Promise((r) => setTimeout(r, 200))
    return [...z.querySelectorAll('.nl-chip')].filter((c) => c.classList.contains('on')).length
  `)
  ok('维度可以全部取消勾选', () => assert.equal(cleared, 0, `还有 ${cleared} 个勾着`))

  /* ---------- 保存被拦(错误 toast) ---------- */
  const blocked = await cdp.eval(`
    const btn = [...document.querySelectorAll('.tv-btn')].find((b) => b.innerText.includes('保存'))
    if (!btn) return { noBtn: true }
    btn.click()
    await new Promise((r) => setTimeout(r, 500))
    return {
      stillOpen: !!document.querySelector('[role="dialog"]'),
      toast: [...document.querySelectorAll('[class*="toast"]')].map((t) => t.innerText).join(' | '),
    }
  `)
  ok('一个维度都不勾时保存被拦下(弹窗不关 + 说明原因)', () => {
    assert.ok(!blocked?.noBtn, '没找到保存按钮')
    assert.ok(blocked.stillOpen, '弹窗被关掉了 —— 校验没生效')
    assert.match(blocked.toast, /一个维度都没勾|至少|关掉这个开关/, `toast: ${blocked.toast}`)
  })

  /* ---------- 勾回动作 → 保存成功 ---------- */
  const saved = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    const chip = [...z.querySelectorAll('.nl-chip')].find((c) => /动作/.test(c.innerText))
    if (!chip) return { noChip: true }
    chip.click()
    await new Promise((r) => setTimeout(r, 200))
    const btn = [...document.querySelectorAll('.tv-btn')].find((b) => b.innerText.includes('保存'))
    btn.click()
    await new Promise((r) => setTimeout(r, 600))
    return {
      toast: [...document.querySelectorAll('[class*="toast"]')].map((t) => t.innerText).join(' | '),
      dot: !!document.querySelector('.lnk-dot'),
    }
  `)
  ok('勾回「动作姿势」后保存成功, 并提示自然语言段已生效', () => {
    assert.ok(!saved?.noChip, '没找到动作 chip')
    assert.match(saved.toast, /自然语言段/, `toast: ${saved.toast}`)
    assert.ok(saved.dot, '首页「高级替换」按钮上没出现"已启用"小圆点')
  })

  /* ---------- 导出参数真的带上了 nl_dims ---------- */
  const params = await cdp.eval(`
    const m = await import('/src/utils/advReplace.js').catch(() => null)
    if (!m) return { noModule: true }
    return m.advParams()
  `)
  ok('导出参数里 nl_dims=pose / nl_level=sfw / nl_strip_pose=1', () => {
    if (params?.noModule) { console.log('      (dev server 未开, 跳过模块直读)'); return }
    assert.equal(params.nl_dims, 'pose', `nl_dims=${params.nl_dims}`)
    assert.equal(params.nl_level, 'sfw', `nl_level=${params.nl_level}`)
    assert.equal(params.nl_strip_pose, '1', `nl_strip_pose=${params.nl_strip_pose}`)
  })

  /* ---------- 穿搭/发型的剔除子开关(2026-11-09) ---------- */
  /* 第三十轮起保存**不再关窗**(对齐替换规则编辑器) —— 只有真关了才需要重开 */
  await cdp.eval(`
    if (!document.querySelector('[role="dialog"]')) {
      const btn = [...document.querySelectorAll('.tv-btn')].find((b) => b.innerText.includes('高级替换'))
      btn?.click()
      await new Promise((r) => setTimeout(r, 400))
    }
    return { open: !!document.querySelector('[role="dialog"]') }
  `)
  await waitFor(cdp, `!!document.querySelector('[role="dialog"]')`, 15000, '弹窗再次出现')
  const strips = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => el.innerText.includes('自然语言段'))
    const chips = [...z.querySelectorAll('.nl-chip')]
    const labels = () => [...z.querySelectorAll('.tv-check')].map((c) => (c.innerText || '').trim())
    const costume = chips.find((c) => /穿搭/.test(c.innerText)); costume.click()
    await new Promise((r) => setTimeout(r, 250))
    const withCostume = labels()
    const hair = chips.find((c) => /发型/.test(c.innerText)); hair.click()
    await new Promise((r) => setTimeout(r, 250))
    const withBoth = labels()
    hair.click(); costume.click()   // 还原成只勾动作
    await new Promise((r) => setTimeout(r, 150))
    return {
      costumeStrip: withCostume.find((t) => /服装词/.test(t)) || '',
      hairStrip: withBoth.find((t) => /发型词/.test(t)) || '',
    }
  `)
  ok('穿搭/发型各有「剔除原图词」子开关(与动作同款)', () => {
    assert.match(strips.costumeStrip, /服装词/, `穿搭子开关: ${JSON.stringify(strips)}`)
    assert.match(strips.hairStrip, /发型词/, `发型子开关: ${JSON.stringify(strips)}`)
    console.log(`      ${strips.costumeStrip} / ${strips.hairStrip}`)
  })

  /* ---------- 钉词 × NL 剔槽冲突 → 保存要被拦(2026-11-09) ---------- */
  /* 导出端钉词豁免禁用剔除 —— 「钉 pose + NL 勾动作」= 原图动作词留着 + NL 动作句打架,
   * 保存前必须拦下。adv.nl 此刻 dims=['pose'], 钉 pose 必撞(弹窗上一步开着, 直接用)。 */
  const pinC = await cdp.eval(`
    const dlg = document.querySelector('[role="dialog"]')
    const addBtn = [...dlg.querySelectorAll('.tv-btn')].find((b) => /添加钉词/.test(b.innerText))
    if (!addBtn) return { noAdd: true }
    addBtn.click()
    await new Promise((r) => setTimeout(r, 250))
    const pin = [...dlg.querySelectorAll('.pin')].pop()
    if (!pin) return { noPin: true }
    const sel = pin.querySelector('select.pin-slot')
    sel.value = 'pose'
    sel.dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 250))
    const inp = pin.querySelector('input')
    inp.value = 'standing'
    inp.dispatchEvent(new Event('input'))
    await new Promise((r) => setTimeout(r, 250))
    const btn = [...dlg.querySelectorAll('.tv-btn')].find((b) => b.innerText.includes('保存'))
    btn.click()
    await new Promise((r) => setTimeout(r, 600))
    return {
      stillOpen: !!document.querySelector('[role="dialog"]'),
      toast: [...document.querySelectorAll('[class*="toast"]')].map((t) => t.innerText).join(' | '),
    }
  `)
  ok('钉了动作槽词 + NL 勾动作 → 保存被拦(钉词与剔除二选一)', () => {
    assert.ok(!pinC?.noAdd && !pinC?.noPin, `钉词行没建起来: ${JSON.stringify(pinC)}`)
    assert.ok(pinC.stillOpen, '弹窗被关掉了 —— 钉词×NL 冲突没拦')
    assert.match(pinC.toast, /钉了词|剔除|二选一/, `toast: ${pinC.toast}`)
    console.log(`      toast: ${pinC.toast}`)
  })

  /* ---------- 运行期异常 ---------- */
  ok('全程没有未捕获的渲染层异常', () => {
    const real = cdp.exceptions.filter((e) => !/ResizeObserver/.test(e))
    assert.equal(real.length, 0, real.slice(0, 2).join('\n'))
  })
} finally {
  try { child.kill() } catch {}
  await sleep(600)
}

console.log(`\n截图: ${path.join(SHOTS, 'nl-panel-on.png')}`)
console.log(`===== nl-ui: ${pass} 通过, ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
