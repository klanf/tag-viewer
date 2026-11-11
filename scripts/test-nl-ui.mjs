/**
 * 自然语言段的界面回归(2026-11-08) —— npm run test:nlui
 * ======================================================
 * 守的是「用户能不能真的在界面上配出来」, 引擎侧另由 test:nlbank / test:nlexport 守。
 * 引擎再好, 弹窗里没这个开关等于没做 —— 这条专门读**真实 DOM**。
 *
 * 断言:
 *   ① 首页「🎲 高级替换」弹窗里出现「④ 自然语言段」区块
 *   ② 语料库缺失时显示"缺失"提示, 不显示开关(避免用户打开一个空功能)
 *   ③ ① 槽位面板里出现三个 📝 语料行(自然语言动作/穿搭/发型), 与 tag 槽并列, 带可抽条数
 *   ④ 点 📝 行能开关维度(点开自动打开总开关); 勾了之后同面 tag 槽变灰
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
/* 方案库跨轮累积(STATE.md 记过): adv_sets.json 不清会把「默认」方案堆成十几行钉词,
 * 于是"点灰槽三态前进一格"这类断言会因起始态/钉词不同而随机变红。每轮从干净方案开始。 */
for (const f of ['adv_sets.json', 'nl_overrides.json']) {
  fs.rmSync(path.join(DATA, f), { force: true })
}

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
  ok('弹窗里有「③ 自然语言段」区块（图库组合串已并进 tag 段, 不再叫追加段）', () => {
    assert.ok(zone.hasZone, `没找到 .zone 里的自然语言段。正文片段:\n${(zone.text || '').slice(0, 120)}`)
    assert.match(zone.text, /自然语言/, '区块标题没提自然语言')
    assert.match(zone.text, /🎬|图库/, '没说明图库组合串已并进 tag 段')
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
  /* 语料统计是**异步**拉的(random:nlstats): 弹窗一打开就取 DOM, chip 上的条数还是 0。
   * 2026-11-11 改版: 维度的勾选从 ③ 区搬到了 ① 槽位面板(📝 行), 这里改成在槽位区轮询。 */
  const on = await cdp.eval(`
    const slotZone = () => [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const nlZone = () => {
      const hits = [...document.querySelectorAll('.zone')].filter((el) => (el.innerText || '').includes('自然语言段'))
      return hits.length ? hits[hits.length - 1] : null
    }
    /* 界面上读状态(不 import 模块 —— 走的是打包后的 dist, 没有 dev server 时读不到) */
    const stateOf = () => {
      const nz = nlZone()
      const cb = nz && (nz.querySelector('input[type="checkbox"]') || nz.querySelector('.tv-check'))
      const inner = cb ? (cb.tagName === 'INPUT' ? cb : cb.querySelector('input') || cb) : null
      return {
        enabled: inner ? inner.checked : null,
        dims: [...document.querySelectorAll('.nl-tag')].map((el) => el.innerText.replace(/\\d+$/, '').trim()),
      }
    }
    let z = slotZone()
    if (!z) return { none: true, zones: document.querySelectorAll('.zone').length }
    let chips = []
    for (let i = 0; i < 30; i++) {
      chips = [...z.querySelectorAll('.tk-chip.nl')]
      if (chips.length >= 3 && chips.every((c) => /[1-9]/.test(c.innerText))) break
      await new Promise((r) => setTimeout(r, 300))
      z = slotZone() || z
    }
    // 上轮方案可能留了维度 —— 先把勾着的全点掉(点最后一个会自动关总开关), 再从"关"点成"开"
    for (let i = 0; i < 3; i++) {
      const onChip = [...z.querySelectorAll('.tk-chip.nl')].find((c) => c.classList.contains('on'))
      if (!onChip) break
      onChip.click()
      await new Promise((r) => setTimeout(r, 250))
    }
    const pose = [...z.querySelectorAll('.tk-chip.nl')].find((c) => /动作/.test(c.innerText))
    if (!pose) return { noPose: [...z.querySelectorAll('.tk-chip.nl')].map((c) => c.innerText) }
    pose.click()
    await new Promise((r) => setTimeout(r, 400))
    const z3 = nlZone()
    return {
      chips: [...z.querySelectorAll('.tk-chip.nl')].map((c) => c.innerText.trim()),
      levels: z3 ? [...z3.querySelectorAll('.chip')].filter((c) => /安全|性暗示|全开/.test(c.innerText)).map((c) => c.innerText.trim()) : [],
      hint: (z3 && (z3.querySelector('.nl-hint') || {}).innerText) || '',
      poseView: z3 ? ([...z3.querySelectorAll('.tv-check')].map((c) => (c.innerText || '').trim()).find((t) => /带上机位/.test(t)) || '') : '',
      ...stateOf(),
    }
  `)
  ok('① 槽位面板里有三个 📝 语料行(与 tag 槽并列), 且带可抽条数', () => {
    assert.ok(!on?.none, `没找到①槽位区: ${JSON.stringify(on)}`)
    assert.equal(on.chips.length, 3, `📝 行实际: ${JSON.stringify(on.chips)}`)
    const nums = on.chips.map((c) => Number((/\d+/.exec(c.replace(/📝/g, '')) || [])[0]))
    assert.ok(nums.every((n) => n > 0), `有维度可抽 0 条: ${JSON.stringify(on.chips)}`)
    assert.ok(on.enabled, `点 📝 行应自动打开自然语言段 (state: ${JSON.stringify(on)})`)
    assert.deepEqual(on.dims, ['动作姿势'], `状态行该只显示动作(实际 ${JSON.stringify(on.dims)})`)
    console.log(`      语料行: ${on.chips.join(' · ')}`)
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

  /* 截图前先滚到 ① 区 —— 📝 语料行现在跟 tag 槽并排, 截出来才能人眼核对
   * (断言都过了但人眼啥也看不见, 等于没有证据)。scrollIntoView 滚的是弹窗内部容器。 */
  await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    if (z) z.scrollIntoView({ block: 'start' })
    await new Promise((r) => setTimeout(r, 350))
    return true
  `)
  await cdp.shotOf('[role="dialog"]', path.join(SHOTS, 'nl-slot-rows.png'))

  /* ---------- 档位放开后池子变大(证明闸门真的在换池子, 不是摆设) ---------- */
  const before = ((on.chips.find((c) => /动作/.test(c)) || '').match(/\d+/) || [])[0]
  await cdp.eval(clickByText('.zone .chip', '全开'))
  await sleep(300)
  const afterAll = await cdp.eval(`
    const pick = () => [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    let z = pick()
    for (let i = 0; i < 10; i++) {
      const chips = z ? [...z.querySelectorAll('.tk-chip.nl')].map((c) => c.innerText.trim()) : []
      if (chips.length) return chips
      await new Promise((r) => setTimeout(r, 200))
      z = pick() || z
    }
    return []
  `)
  const afterN = (((afterAll.find((c) => /动作/.test(c)) || '').match(/\d+/) || [])[0])
  ok(`切到「全开」后动作可抽条数变大(${before} → ${afterN})`, () => {
    assert.ok(afterAll.length > 0, `切档后没读到 chip: ${JSON.stringify(afterAll)}`)
    assert.ok(Number(afterN) > Number(before), `条数没变: ${before} → ${afterN}`)
  })
  // 切回安全档, 免得后面的保存把 nsfw 带出去
  await cdp.eval(clickByText('.zone .chip', '安全'))
  await sleep(200)

  /* ---------- 勾了 📝 行 → 同面 tag 槽变灰; 点灰槽 = 自动切回 tag 池(B 方案) ---------- */
  const cover = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const nlZone = () => {
      const hits = [...document.querySelectorAll('.zone')].filter((el) => (el.innerText || '').includes('自然语言段'))
      return hits.length ? hits[hits.length - 1] : null
    }
    // 上一步切档位会重渲染, 等灰态落位再点
    let covered = []
    for (let i = 0; i < 20; i++) {
      covered = [...z.querySelectorAll('.chip.covered')].map((c) => c.innerText.trim())
      if (covered.length) break
      await new Promise((r) => setTimeout(r, 150))
    }
    const gray = [...z.querySelectorAll('.chip.covered')].find((c) => /基础姿势/.test(c.innerText))
    const baseEl = [...z.querySelectorAll('.chip')].find((c) => /基础姿势/.test(c.innerText))
    const cls = (s) => ((String(s).match(/m-(off|random|insert|ban)/) || [])[1] || '')
    const ORDER = ['off', 'random', 'insert', 'ban']
    const beforeClass = baseEl ? baseEl.className : ''
    if (gray) gray.click()
    // 点完 = 取消接管 + 该槽进三态的下一格(夹具库跨轮复用, 起始态不一定是 off)
    let baseClass = ''
    for (let i = 0; i < 20; i++) {
      const base = [...z.querySelectorAll('.chip')].find((c) => /基础姿势/.test(c.innerText))
      baseClass = base ? base.className : ''
      if (cls(baseClass) !== cls(beforeClass)) break
      await new Promise((r) => setTimeout(r, 150))
    }
    const expectMode = ORDER[(ORDER.indexOf(cls(beforeClass)) + 1) % ORDER.length]
    const nz = nlZone()
    const cb = nz && (nz.querySelector('input[type="checkbox"]') || nz.querySelector('.tv-check'))
    const inner = cb ? (cb.tagName === 'INPUT' ? cb : cb.querySelector('input') || cb) : null
    return {
      covered,
      left: [...z.querySelectorAll('.chip.covered')].length,
      dims: [...document.querySelectorAll('.nl-tag')].map((el) => el.innerText.replace(/\\d+$/, '').trim()),
      enabled: inner ? inner.checked : null,
      expectMode,
      baseClass,
      toast: [...document.querySelectorAll('[class*="toast"]')].map((t) => t.innerText).join(' | '),
    }
  `)
  ok('勾了「📝 自然语言动作」→ 同面 tag 动作槽变灰(接管显性化)', () => {
    assert.ok(cover.covered.length >= 3, `该有三个动作槽变灰, 实际 ${JSON.stringify(cover.covered)}`)
    console.log(`      变灰: ${cover.covered.join(' · ')}`)
  })
  ok('点灰槽 = 关掉自然语言接管 + 该槽三态前进一格(不用再跑去别处找开关)', () => {
    assert.equal(cover.left, 0, `还有 ${cover.left} 个灰槽 —— 点了没切回来: ${JSON.stringify(cover)}`)
    assert.deepEqual(cover.dims, [], `状态行里还留着维度: ${JSON.stringify(cover.dims)}`)
    assert.equal(cover.enabled, false, `维度清空后总开关该自动关: ${JSON.stringify(cover)}`)
    assert.ok(cover.baseClass.includes(`m-${cover.expectMode}`),
      `基础姿势没进下一态(期望 m-${cover.expectMode}): "${cover.baseClass}"`)
    assert.match(cover.toast || '', /自然语言|tag 池/, `没提示切回来了: ${JSON.stringify(cover.toast)}`)
    console.log(`      ${cover.toast}`)
  })

  /* ---------- 一个维度都不剩 → 总开关自动关掉(不再产生"开了但没选"的非法态) ---------- */
  const cleared = await cdp.eval(`
    return {
      dims: [...document.querySelectorAll('.nl-tag')].map((el) => el.innerText.replace(/\\d+$/, '').trim()),
      stateText: ([...document.querySelectorAll('.nl-state')][0] || {}).innerText || '',
    }
  `)
  ok('维度清空后状态行提示"去 ① 槽位里点 📝 那一行"(不再是两处配的空白态)', () => {
    assert.equal(cleared.dims.length, 0, `状态行还有维度: ${JSON.stringify(cleared)}`)
    assert.match(cleared.stateText, /未选|📝/, `状态行没给指引: ${JSON.stringify(cleared)}`)
  })

  /* ---------- 勾回动作 → 保存成功 ---------- */
  const saved = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const chip = [...z.querySelectorAll('.tk-chip.nl')].find((c) => /动作/.test(c.innerText))
    if (!chip) return { noChip: true }
    chip.click()
    await new Promise((r) => setTimeout(r, 200))
    const btn = [...document.querySelectorAll('.tv-btn')].find((b) => b.innerText.includes('保存'))
    if (!btn) return { noSaveBtn: true, btns: [...document.querySelectorAll('.tv-btn')].map((b) => b.innerText.trim()) }
    btn.click()
    await new Promise((r) => setTimeout(r, 600))
    return {
      toast: [...document.querySelectorAll('[class*="toast"]')].map((t) => t.innerText).join(' | '),
      dot: !!document.querySelector('.lnk-dot'),
    }
  `)
  ok('勾回「动作姿势」后保存成功, 并提示自然语言段已生效', () => {
    assert.ok(!saved?.noChip, '没找到动作 chip')
    assert.match(saved.toast || '', /自然语言段/, `实际: ${JSON.stringify(saved)}`)
    assert.ok(saved.dot, `首页「高级替换」按钮上没出现"已启用"小圆点 (实际: ${JSON.stringify(saved)})`)
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
    const slotZone = () => [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const nlZone = () => {
      const hits = [...document.querySelectorAll('.zone')].filter((el) => (el.innerText || '').includes('自然语言段'))
      return hits.length ? hits[hits.length - 1] : null
    }
    // 重开弹窗后内容还要一帧才渲染完, waitFor 只等 [role=dialog] —— 这里等 📝 行落位
    let z = slotZone()
    let chips = []
    for (let i = 0; i < 20; i++) {
      z = slotZone() || z
      chips = z ? [...z.querySelectorAll('.tk-chip.nl')] : []
      if (chips.length >= 3) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (chips.length < 3) {
      return { noChips: chips.length, text: ((z && z.innerText) || '').replace(/\\s+/g, ' ').slice(0, 160) }
    }
    const labels = () => {
      const nz = nlZone()
      return nz ? [...nz.querySelectorAll('.tv-check')].map((c) => (c.innerText || '').trim()) : []
    }
    const costume = chips.find((c) => /穿搭/.test(c.innerText))
    const hair = chips.find((c) => /发型/.test(c.innerText))
    if (!costume || !hair) return { noDimChip: chips.map((c) => c.innerText.trim()) }
    costume.click()
    await new Promise((r) => setTimeout(r, 250))
    const withCostume = labels()
    hair.click()
    await new Promise((r) => setTimeout(r, 250))
    const withBoth = labels()
    hair.click(); costume.click()   // 还原成只勾动作
    await new Promise((r) => setTimeout(r, 200))
    return {
      costumeStrip: withCostume.find((t) => /服装词/.test(t)) || '',
      hairStrip: withBoth.find((t) => /发型词/.test(t)) || '',
    }
  `)
  ok('穿搭/发型各有「剔除原图词」子开关(与动作同款)', () => {
    assert.ok(!strips?.noChips && !strips?.noDimChip, `没拿到维度 chip: ${JSON.stringify(strips)}`)
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
      soft: [...document.querySelectorAll('.soft')].map((el) => el.innerText.replace(/\s+/g, ' ')).join(' | '),
    }
  `)
  /* 口径变更(2026-11-10, 见 TvAdvancedReplaceModal.save 里的注释):
   * 「钉词 × NL 剔槽」**不再拦保存** —— 钉了的槽在导出端本来就豁免剔除(pinnedSlots),
   * 钉词优先, 语义上没冲突。现在只给一条软提示。旧断言还在要求"拦下 + 二选一 toast"。 */
  ok('钉了动作槽词 + NL 勾动作 → 不拦保存, 只给软提示(钉词优先)', () => {
    assert.ok(!pinC?.noAdd && !pinC?.noPin, `钉词行没建起来: ${JSON.stringify(pinC)}`)
    assert.ok(!/钉了词|二选一/.test(pinC.toast || ''), `还在硬拦保存(已改成软提示): ${pinC.toast}`)
    assert.match(pinC.soft || '', /钉词优先|不拦保存/, `软提示: ${JSON.stringify(pinC)}`)
    console.log(`      软提示: ${pinC.soft}`)
  })

  /* ---------- 🎬 图库组合池(第三套, 2026-11-11) ----------
   * 2026-11-11 晚: 伪槽从 chips 流里搬进 ① 区底部的「整段接管」块(.tk-chip),
   * 所以查元素要同时看 .chip(真槽) 与 .tk-chip(接管), 否则找不到。 */
  const cdUi = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const chips = () => [...z.querySelectorAll('.chip, .tk-chip')]
    const byText = (re) => chips().find((c) => re.test(c.innerText))
    const nlPose = byText(/自然语言动作/)
    const cdPose = byText(/图库动作/)
    const cdFit = byText(/图库穿搭/)
    const snapshot = () => ({
      cdOn: cdPose ? cdPose.className.includes('on') : null,
      nlOn: nlPose ? nlPose.className.includes('on') : null,
      covered: [...z.querySelectorAll('.chip.covered')].length,
    })
    // 若 NL 动作还开着, 先点掉 —— 断言互斥才干净
    if (nlPose && nlPose.className.includes('on')) { nlPose.click(); await new Promise((r) => setTimeout(r, 300)) }
    const before = snapshot()
    if (cdPose) cdPose.click()
    await new Promise((r) => setTimeout(r, 450))
    const after = snapshot()
    // 再点一次取消, 回到干净态(不影响后面)
    if (cdPose && cdPose.className.includes('on')) cdPose.click()
    await new Promise((r) => setTimeout(r, 300))
    const back = snapshot()
    return {
      hasPose: !!cdPose, hasFit: !!cdFit,
      poseText: cdPose ? cdPose.innerText.replace(/\\s+/g, ' ') : '',
      fitText: cdFit ? cdFit.innerText.replace(/\\s+/g, ' ') : '',
      before, after, back,
    }
  `)
  ok('① 区「整段接管」块里有 🎬 图库动作 / 🎬 图库穿搭, 带可抽条数', () => {
    assert.ok(cdUi.hasPose && cdUi.hasFit, `缺行: ${JSON.stringify(cdUi)}`)
    assert.match(cdUi.poseText, /图库动作\s*\d+/, `动作行没有条数: ${cdUi.poseText}`)
    assert.match(cdUi.fitText, /图库穿搭\s*\d+/, `穿搭行没有条数: ${cdUi.fitText}`)
  })
  ok('点 🎬 图库动作 → 该行点亮, 同面 tag 槽变灰(接管显性化)', () => {
    assert.equal(cdUi.after.cdOn, true, `点了没亮: ${JSON.stringify(cdUi.after)}`)
    assert.ok(cdUi.after.covered > 0, 'tag 槽没变灰 —— 接管关系没显性化')
  })
  ok('再点一次取消 → 灰槽回来(不留半接管态)', () => {
    assert.equal(cdUi.back.cdOn, false, `没取消: ${JSON.stringify(cdUi.back)}`)
    assert.equal(cdUi.back.covered, 0, `还有 ${cdUi.back.covered} 个灰槽没恢复`)
  })

  /* 留一张「接管中」的截图 —— 断言只能证明状态对, 布局好不好看还得人眼核对
     (2026-11-11 用户反馈"都混在一起了", 有图为证才谈得上改没改好)。 */
  const shotTake = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    if (z) z.scrollIntoView({ block: 'start' })
    const b = [...z.querySelectorAll('.tk-chip.cd')].find((c) => /图库动作/.test(c.innerText))
    if (b && !b.classList.contains('on')) b.click()
    await new Promise((r) => setTimeout(r, 400))
    return {
      on: !!b && b.classList.contains('on'),
      badge: [...z.querySelectorAll('.sec-take')].map((el) => el.innerText.trim()),
    }
  `)
  ok('接管开启后, 被接管的分组标题挂着「接管中」标(整片灰不再是黑箱)', () => {
    assert.ok(shotTake.badge.length > 0, `没挂标: ${JSON.stringify(shotTake)}`)
    console.log(`      分组标: ${shotTake.badge.join(' / ')}`)
  })
  await cdp.shotOf('[role="dialog"]', path.join(SHOTS, 'nl-takeover-on.png'))
  // 复位, 别给后面留半接管态
  await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const b = [...z.querySelectorAll('.tk-chip.cd')].find((c) => /图库动作/.test(c.innerText))
    if (b && b.classList.contains('on')) b.click()
    await new Promise((r) => setTimeout(r, 300))
    return true
  `)

  /* ---------- 🔀 混合来源(2026-11-11) ----------
   * 混合 = 每条按配比抽一个来源(槽池/语料/图库), 一行仍只出一套。
   * UI 上要能: ① 看到开关与当前配比 ② 开后能改三段数字 ③ 槽是**半灰**不是全灰
   * ④ 点半灰槽能整面交回 tag 池。 */
  const mixUi = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const chipOf = (re) => [...z.querySelectorAll('.tk-chip')].find((c) => re.test(c.innerText))
    const mixPose = chipOf(/混合/)
    if (!mixPose) return { has: false }
    for (const b of z.querySelectorAll('.tk-chip.on')) { b.click(); await new Promise((r) => setTimeout(r, 180)) }
    const before = {
      covered: z.querySelectorAll('.chip.covered').length,
      mixed: z.querySelectorAll('.chip.mixed').length,
    }
    mixPose.click()
    await new Promise((r) => setTimeout(r, 420))
    const row = mixPose.closest('.tk-row')
    const inputs = [...row.querySelectorAll('.tk-mix input')]
    const after = {
      on: mixPose.className.includes('on'),
      text: mixPose.innerText.replace(/\\s+/g, ' '),
      nInputs: inputs.length,
      vals: inputs.map((i) => i.value),
      mixed: z.querySelectorAll('.chip.mixed').length,
      covered: z.querySelectorAll('.chip.covered').length,
      badge: [...z.querySelectorAll('.sec-take')].map((e) => e.innerText.trim()),
    }
    if (inputs.length >= 3) {
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
      set(inputs[0], '70'); set(inputs[1], '30'); set(inputs[2], '0')
      await new Promise((r) => setTimeout(r, 420))
    }
    const changed = {
      text: mixPose.innerText.replace(/\\s+/g, ' '),
      vals: inputs.map((i) => i.value),
      sum: row.querySelector('.tk-mix-sum') ? row.querySelector('.tk-mix-sum').innerText.trim() : '',
    }
    return { has: true, before, after, changed, faces: [...z.querySelectorAll('.tk-chip')].filter((c) => /混合/.test(c.innerText)).length }
  `)
  ok('① 区三面都有 🔀 混合 chip(姿势/服装/头发)', () => {
    assert.ok(mixUi.has, `没找到混合 chip: ${JSON.stringify(mixUi)}`)
    assert.equal(mixUi.faces, 3, `混合 chip 应有 3 个, 实际 ${mixUi.faces}`)
  })
  ok('点 🔀 → 点亮 + 展开三段配比(槽池/语料/图库)', () => {
    assert.equal(mixUi.after.on, true, `点了没亮: ${JSON.stringify(mixUi.after)}`)
    assert.equal(mixUi.after.nInputs, 3, `配比输入应有 3 个, 实际 ${mixUi.after.nInputs}`)
    assert.match(mixUi.after.text, /混合\s*\d+\/\d+\/\d+/, `chip 上没显示配比: ${mixUi.after.text}`)
  })
  ok('混合态下同面 tag 槽是**半灰**(mixed), 不是全灰(covered)', () => {
    assert.ok(mixUi.after.mixed > 0, '混合没让槽变半灰 —— 用户看不出来这一面只在部分行生效')
    assert.equal(mixUi.after.covered, 0, `不该有全灰槽(混合不是整段接管): ${mixUi.after.covered}`)
    console.log(`      分组标: ${mixUi.after.badge.join(' / ')}`)
  })
  ok('改配比 → chip 文案与输入框同步(70/30/0)', () => {
    assert.match(mixUi.changed.text, /70\/30\/0/, `chip 没跟着变: ${mixUi.changed.text}`)
    assert.deepEqual(mixUi.changed.vals, ['70', '30', '0'], JSON.stringify(mixUi.changed.vals))
    assert.match(mixUi.changed.sum, /100/, `合计显示不对: ${mixUi.changed.sum}`)
  })

  // 留一张混合态的实拍(配比刚被改成 70/30/0, 正好能看出"槽池优先")
  await cdp.shotOf('[role="dialog"]', path.join(SHOTS, 'nl-mix-on.png'))

  const mixSlotClick = await cdp.eval(`
    const z = [...document.querySelectorAll('.zone')].find((el) => (el.innerText || '').includes('① 槽位'))
    const mixPose = [...z.querySelectorAll('.tk-chip')].find((c) => /混合/.test(c.innerText))
    const slot = [...z.querySelectorAll('.chip.mixed')][0]
    if (!slot) return { hasSlot: false }
    slot.click()
    await new Promise((r) => setTimeout(r, 450))
    return {
      hasSlot: true,
      mixOn: mixPose.classList.contains('on'),
      mixed: z.querySelectorAll('.chip.mixed').length,
      toast: document.body.innerText.includes('已关掉'),
    }
  `)
  ok('点半灰槽 → 关掉这一面的混合、槽恢复(与 B 方案同款手感)', () => {
    assert.ok(mixSlotClick.hasSlot, '没有半灰槽可点')
    assert.equal(mixSlotClick.mixOn, false, `点完混合还开着: ${JSON.stringify(mixSlotClick)}`)
    assert.equal(mixSlotClick.mixed, 0, `还有 ${mixSlotClick.mixed} 个半灰槽没恢复`)
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
