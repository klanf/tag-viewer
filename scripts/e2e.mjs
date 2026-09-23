/**
 * 端到端验证(e2e) —— 用 CDP 驱动真实运行的 Electron, 逐视图断言
 * ==============================================================
 * 为什么不用 playwright: 环境里只装了三样依赖, 不想为了一次验证再拉一整套浏览器。
 * Electron 自带 --remote-debugging-port, 用 Node 内置的 WebSocket 直接说 CDP 就够了。
 *
 * 数据隔离: 跑在**项目内**的 .e2e-work/data(真实数据目录的副本)上, 所以
 * 过程中会写文件的操作(ban 标签、购物车、结算历史)全都落在副本里,
 * 不会污染用户真实积累的黑名单/购物车。这一点很重要 —— 别改成真实目录。
 *
 * 用法:
 *   node scripts/e2e.mjs            # 全量
 *   node scripts/e2e.mjs --keep     # 跑完不关窗口(方便手动看)
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findElectron, electronEnv } from './electron-path.mjs'
import { freePort, clearPageState, ensureWorkDir, sleep, ROOT } from './harness.mjs'

/** 工作目录里的路径在 main() 开头由 ensureWorkDir() 定下来(全部落在项目内, 见 harness.mjs) */
let SHOTS = ''
let DATA_DIR = ''
let SCAN_DIR = ''
let USER_DATA = ''
/** 「移动到」的目标目录 —— 真实搬文件用, 每轮重建 */
let MOVED_DIR = ''
const KEEP = process.argv.includes('--keep')

/**
 * 跳过截图 —— 截图是给人看的辅助产物, 但它会**堵死整条 CDP 连接**。
 *
 * 2026-09-19 实测(第二次踩): 在系列页那屏(60 张要现建的 400px 缩略图)上
 * `Page.captureScreenshot` 卡满 60s, 异常虽然被 shot() 吞掉只记了条 warn,
 * 但同一个 websocket 上**后续所有 `Runtime.evaluate` 全都超时** ——
 * 结果是后面 60 多条断言一条都没跑到, 报告停在 31/32 并指向一个假故障
 * ("e2e 流程未中断 — Runtime.evaluate 超时"), 看起来像应用坏了。
 *
 * 所以: 只想验断言时用 `--no-shot`(或 `TV_NO_SHOT=1`), 需要截图交付再开。
 * (真正的修法是超时后重连 CDP, 那是另一件事, 先不在这里做。)
 */
const NO_SHOT = process.argv.includes('--no-shot') || process.env.TV_NO_SHOT === '1'

/**
 * 调试端口**每次随机取一个空闲的**, 不用固定值。原因(踩过一次, 很难查):
 * 固定端口时, 只要机器上还有一份之前的实例在监听(比如手工起过一次没关),
 * findPage() 就会连到那个**旧实例**上 —— 于是 e2e 一路断言全落在那只旧窗口上:
 * 初始路由不是首页、卡片数是别的视图的数字、找不到首页的输入框……
 * 而新起的进程因为单实例锁(app.requestSingleInstanceLock)直接退出了,
 * 表现成"测试脚本莫名其妙地全挂", 实际代码一点问题没有。
 * 端口随机 + userData 独立 => 旧实例永远不可能冒充新实例。
 */
let PORT = Number(process.env.TV_CDP_PORT || 0)

const results = []
let fails = 0
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) })
  if (!ok) fails++
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? `  — ${detail}` : ''}`)
}

/* ------------------------------------------------------------ CDP 客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.logs = []
    this.errors = []
    this.shots = []   // 截图结果(失败只记 warn, 不中断整轮 —— 见 shot())
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
      this.onEvent(msg)
    })
  }

  onEvent(msg) {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      const type = msg.params.type
      this.logs.push({ type, text })
      if (type === 'error' || /\[Vue warn\]/.test(text)) this.errors.push(`${type}: ${text}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      this.errors.push(`exception: ${d.exception?.description || d.text}`)
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      // 必须带上 url: 只报一句 "404 (Not Found)" 是查不出所以然的
      // (2026-09-19 为了这个 404 反复猜了好几轮)。
      const where = e.url ? ` @ ${String(e.url).slice(0, 180)}` : ''
      if (e.level === 'error') this.errors.push(`log: ${e.text}${where}`)
    }
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

  /** 在页面里求值; 表达式可以是 async IIFE(awaitPromise 打开) */
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

  /**
   * 截图 —— **只作诊断, 失败绝不能中断整轮**
   * =========================================
   * 2026-09-19 踩过: 在「标签点进图片」那一屏(68,376 条结果)截 10-tags-images 时
   * `Page.captureScreenshot` 卡满 60s 超时, 异常一路冒到最外层 catch,
   * 结果**后面 30 多条断言一条都没跑**, 报告只显示 39/40 —— 看上去像"功能坏了",
   * 实际是"截图超时把整轮掐了"。截图是给人看的辅助产物, 不该有这种权力。
   *
   * 超时本身的两个已知原因, 一并处理:
   *   1) 窗口被遮挡时 Chromium 可能不产帧 -> 先 bringToFront 把它放到前台;
   *   2) 主进程正忙(这一屏要现建 60 张 400px 缩略图) -> 超时只记一条 warn。
   */
  async shot(name) {
    if (NO_SHOT) return          // 见文件上方 NO_SHOT: 截图会堵死 CDP 连接
    const t0 = Date.now()
    try {
      try { await this.send('Page.bringToFront', {}, 3000) } catch { /* 不支持就算了 */ }
      const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.mkdirSync(SHOTS, { recursive: true })
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
      this.shots.push({ name, ok: true, ms: Date.now() - t0 })
    } catch (e) {
      this.shots.push({ name, ok: false, ms: Date.now() - t0, err: e.message })
      console.log(`[warn] 截图 ${name} 失败(${Date.now() - t0}ms): ${e.message} —— 不影响后面的断言`)
    }
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

/** 轮询页面里的条件, 返回最后一次的值 */
async function waitFor(cdp, expr, { timeout = 20000, interval = 200, label = expr } = {}) {
  // 表达式可以是单表达式, 也可以是多语句(自带 return)。
  // 这里必须判断一次: 给多语句强行加 `return ` 前缀时, `return` 后面的换行
  // 会触发 ASI —— 函数直接 return undefined, 后面几行变成死代码,
  // 表现为"条件永远不成立"却又不报错(踩过一次, 排查了半天)。
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

/* ------------------------------------------------------------ 页面小工具 */
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
  setInput(sel, val) {
    const el = document.querySelector(sel)
    if (!el) throw new Error('找不到输入框 ' + sel)
    el.focus()
    el.value = val
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  },
  pressEnter(sel) {
    const el = document.querySelector(sel)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  },
}
return true`

/* ------------------------------------------------------------ 主流程 */
/**
 * 构建产物守卫 —— 拦住"改了前端但忘了 build, 于是测的还是旧 bundle"。
 *
 * 2026-09-18 踩过: 改完三个视图的 `imgPaths` 后直接 `node scripts/e2e.mjs`,
 * 它**不会**重新构建(只有 `npm run e2e` 才会 preflight + build), 于是跑了两次
 * 全是旧产物, 白等两轮还误判成"改了没用"。
 *
 * 判据: 源码里最新的 mtime > dist/index.html 的 mtime 就说明产物过期。
 * 用 `--allow-stale` 可以跳过(CI 场景下有时确实只想跑一次纯前端测试)。
 */
function checkBuildFresh() {
  if (process.argv.includes('--allow-stale')) return
  const dist = path.join(ROOT, 'dist', 'index.html')
  if (!fs.existsSync(dist)) {
    console.error('✗ dist/index.html 不存在 —— 先执行 npm run build（或直接用 npm run e2e）')
    process.exit(1)
  }
  const distMs = fs.statSync(dist).mtimeMs
  let newest = { ms: 0, file: '' }
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { scan(p); continue }
      if (!/\.(vue|js|mjs|css)$/.test(e.name)) continue
      const ms = fs.statSync(p).mtimeMs
      if (ms > newest.ms) newest = { ms, file: p }
    }
  }
  if (fs.existsSync(path.join(ROOT, 'src'))) scan(path.join(ROOT, 'src'))
  if (newest.ms > distMs) {
    console.error('✗ 构建产物已过期，测的会是旧 bundle：')
    console.error(`    ${path.relative(ROOT, newest.file).replace(/\\/g, '/')} 比 dist/index.html 新`)
    console.error('  请用 npm run e2e（它会先 build），或手动 npm run build 后再跑；')
    console.error('  确定要测当前产物可加 --allow-stale。')
    process.exit(1)
  }
}

async function main() {
  checkBuildFresh()
  // 夹具: 项目内的工作目录, 数据副本从真实数据目录复制而来(测试写坏也污染不到真实数据)
  const work = ensureWorkDir()
  DATA_DIR = work.dataDir
  SCAN_DIR = work.scanDir
  USER_DATA = work.userData
  SHOTS = work.shotsDir
  // 截图文件名是固定的, 直接覆盖即可 —— 不做"整目录删掉重建"
  // (那种写法会碰上执行环境的批量删除保护, 而且没必要)
  fs.mkdirSync(SHOTS, { recursive: true })

  // 「移动到」的目标目录(由 harness 统一创建, 布局定义也在那边)。
  // 故意不清理内容 —— 断言只看这一轮搬进去的那个文件, 不靠目录是否为空。
  MOVED_DIR = work.movedDest

  const exe = findElectron()
  if (!PORT) PORT = await freePort()
  console.log('[e2e] electron:', exe)
  console.log('[e2e] 数据副本 =', DATA_DIR)
  console.log('[e2e] 扫描夹   =', SCAN_DIR)
  console.log('[e2e] 移动目标 =', MOVED_DIR)
  console.log('[e2e] userData =', USER_DATA)
  console.log('[e2e] CDP 端口 =', PORT)
  // userData 从不清整目录, 改成连上之后清 localStorage + 重载 —— 见 scripts/harness.mjs。

  const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // TV_E2E_CTX_MOVE: 让主进程的右键菜单跳过原生 popup, 直接当成用户点了
    //   「移动到 <MOVED_DIR>」—— 原生菜单 CDP 点不到, 但不点它就测不到生产端。
    env: electronEnv({ TV_DATA_DIR: DATA_DIR, TV_E2E_CTX_MOVE: MOVED_DIR }),
  })
  let childExited = null
  child.stdout.on('data', (b) => process.stdout.write(`[main] ${b}`))
  child.stderr.on('data', (b) => process.stderr.write(`[main!] ${b}`))
  child.on('exit', (code, sig) => { childExited = `code=${code} sig=${sig}` })

  const page = await findPage()
  console.log('[e2e] 已连上渲染进程:', page.url)
  // 连上的必须是**本次启动**的那个窗口: 主进程可能因单实例锁直接退出,
  // 这时端口上出现的一定是旧实例 —— 提前报错, 比后面几十条断言全挂好查得多。
  if (childExited) throw new Error(`主进程已退出(${childExited}) —— 端口上连到的是别的实例`)
  if (!/dist[\\/]index\.html/.test(page.url)) {
    throw new Error(`连到的不是本项目的窗口: ${page.url}`)
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')

  try {
    /* ---------------- 0. 环境诊断(连错实例 / 残留状态时一眼能看出来) ---------------- */
    await sleep(400)
    const env = await cdp.eval(`
      return {
        href: location.href,
        title: document.title,
        lsKeys: Object.keys(localStorage).sort(),
        hash: location.hash,
      }
    `)
    console.log('[e2e] 初始页面状态:', JSON.stringify(env))
    check('初始落在首页(没有残留路由)', env.hash === '' || env.hash === '#/' || env.hash === '#', `hash=${env.hash}`)

    // 把上一轮残留的 localStorage(主题/收藏/购物车/搜索历史)清掉再重载, 让断言有确定的起点
    const cleared = await clearPageState(cdp)
    console.log(`[e2e] 已清空页面状态并重载: 清掉 ${cleared} 个 key`)
    const fresh = await cdp.eval(`return Object.keys(localStorage)`)
    check('重载后 localStorage 为空', fresh.length === 0, `keys=${JSON.stringify(fresh)}`)

    /* ---------------- 1. 启动与数据集 ---------------- */
    await waitFor(cdp, `!!document.querySelector('#app .hdr')`, { label: '顶栏出现', timeout: 30000 })
    await cdp.eval(HELPERS)
    check('渲染进程挂载 + 顶栏渲染', true)

    const navCount = await cdp.eval(`return __t.count('.hdr .nv')`)
    check('顶栏导航项 = 7(含新增的收藏页与来源页)', navCount === 7, `实际 ${navCount}`)

    const phase = await waitFor(cdp, `
      const s = await window.tv.invoke('app:status')
      return s.phase === 'ready' ? 'ready' : (s.phase === 'error' ? 'error:' + s.error : '')
    `, { label: '数据集 ready', timeout: 180000 })
    check('数据集加载完成', phase === 'ready', String(phase))

    const st = await cdp.eval(`return await window.tv.invoke('app:status')`)
    check('数据集规模 > 0', (st.stats?.records || 0) > 0,
      `${st.stats?.records} 张 / ${st.stats?.tags} 标签 / ${st.stats?.series} 系列 · ${st.loadMs} ms`)

    /* ---------------- 2. 首页 ---------------- */
    await waitFor(cdp, `__t.count('.grid .card') > 0`, { label: '首页卡片', timeout: 60000 })
    const home = await cdp.eval(`
      return {
        cards: __t.count('.grid .card'),
        total: __t.text('.result-head b'),
        pager: __t.count('.pager .page'),
        // 首页是**无限滚动**(useImageFeed({ infinite: true })), 不是页码分页 ——
        // TvPager 只用在 TagsView。这里采的是"滚到底自动加载"的提示文本, 用来锁住这个设计。
        hint: __t.text('.result-head .nowrap'),
        bars: __t.count('.bars .row'),
        srcChips: __t.count('.src-bar .tv-chip'),
        imagesLoaded: __t.count('.grid .tv-img.loaded'),
      }
    `)
    check('首页: 首屏 60 张卡片', home.cards === 60, `实际 ${home.cards}`)
    check('首页: 匹配总数 > 0', Number(home.total.replace(/[^\d]/g, '')) > 0, `total=${home.total}`)
    /**
     * 首页的分页形态是**无限滚动**, 这里曾经断言 `.pager .page > 1` —— 那条是陈旧的:
     * HomeView 早就换成了 `useImageFeed({ infinite: true })`(提示文本"滚到底自动加载"),
     * 全仓只剩 TagsView 用 TvPager, 所以那条断言**永远不可能通过**, 等于一条假红线,
     * 会掩盖真正的问题。现在改成两条能真反映实现的:
     *   1. 没有页码条, 且有"滚到底自动加载"的提示 —— 锁住"首页不用页码分页"这个设计;
     *   2. 真的滚到底之后卡片数变多 —— 这才是无限滚动的行为断言。
     */
    check('首页: 无页码分页条 + 提示为无限滚动',
      home.pager === 0 && /滚到底自动加载/.test(home.hint),
      `页码按钮 ${home.pager} 个 · 提示「${home.hint}」`)
    check('首页: 高频标签条已渲染', home.bars > 0, `${home.bars} 行`)
    check('首页: 来源筛选条已渲染', home.srcChips > 1, `${home.srcChips} 个来源胶囊`)
    await cdp.shot('01-home')

    /* 无限滚动的行为断言: 把滚动容器推到底, 卡片数应当自己长上去 */
    await cdp.eval(`
      const w = document.querySelector('.grid-wrap')
      if (w) w.scrollTop = w.scrollHeight
      return true
    `)
    const grew = await waitFor(cdp, `__t.count('.grid .card') > ${home.cards}`,
      { label: '无限滚动追加下一页', timeout: 30000 })
    check('首页: 滚到底自动加载更多', !!grew, `${home.cards} -> ${grew} 张卡片`)
    await cdp.eval(`const w = document.querySelector('.grid-wrap'); if (w) w.scrollTop = 0; return true`)

    /* 缩略图真的能从 tv:// 协议读出来 */
    const thumbOk = await waitFor(cdp, `__t.count('.grid .tv-img.loaded') > 0`, { label: '缩略图加载', timeout: 30000 })
    check('tv:// 缩略图协议可用', !!thumbOk, `${(await cdp.eval(`return __t.count('.grid .tv-img.loaded')`))} 张已加载`)

    /* ---------------- 3. 大图预览 ---------------- */
    await cdp.eval(`__t.click('.grid .card'); return true`)
    await waitFor(cdp, `!!document.querySelector('.lightbox')`, { label: 'lightbox 打开', timeout: 20000 })
    /**
     * 等大图预览把标签渲染出来。
     *
     * 注意首页的默认排序是**随机**(HomeView 里 `sort = ref('random')` + 随机 seed),
     * 所以「第一张」每启动一次都不一样 —— 不能假设它一定带角色/系列标签。
     * 早期版本这里直接断言 `.lb-meta-row >= 1`, 于是隔三差五挂一次(实测:
     * 连跑两遍, 第一遍 0 行 FAIL, 第二遍 2 行 PASS), 属于测试自身的假设错误。
     *
     * 现在的做法是**先问数据、再对 UI**: 用 lightbox:data 查出这张图按定义该有几行
     * (角色 + 系列), 不满足就顺着列表往后翻(顺便验证翻页真的在换图), 找到为止;
     * 断言变成「渲染行数 == 数据里的行数」, 比"一定 >= 1"更强也更稳。
     */
    const LB_PROBE = `
      const n = __t.count('.lightbox .lb-tags .pill')
      if (!n) return 0
      let want = 0, rows = 0, hops = 0
      for (let i = 0; i < 20; i++) {
        const p = __t.text('.lightbox .lb-path')
        const d = await window.tv.invoke('lightbox:data', { path: p })
        want = ((d.char_tags || []).length) + ((d.series || []).length)
        rows = __t.count('.lightbox .lb-meta-row')
        if (want > 0) break
        const btn = document.querySelector('.lb-nav.next')
        if (!btn || btn.disabled) break
        btn.click()
        hops++
        await new Promise(r => setTimeout(r, 900))
      }
      return {
        tags: __t.count('.lightbox .lb-tags .pill'),
        chars: rows,
        want,
        hops,
        copyBtns: __t.count('.lightbox .lb-copy-row button'),
        charPills: __t.count('.lightbox .lb-meta-row .pill.k-char'),
        cartIcons: __t.count('.lightbox .lb-meta-row .pill .ct'),
        banned: __t.count('.lightbox .lb-tags .pill.banned'),
        actsOp: (() => {
          const el = document.querySelector('.lightbox .lb-tags .pill:not(.banned) .acts')
          if (!el) return 'none'
          const cs = getComputedStyle(el)
          return cs.opacity + '|' + cs.position
        })(),
        bannedSt: __t.count('.lightbox .lb-tags .pill.banned .st'),
        bannedBan: __t.count('.lightbox .lb-tags .pill.banned .acts .ban'),
        bannedActsOp: (() => {
          const el = document.querySelector('.lightbox .lb-tags .pill.banned .acts')
          return el ? getComputedStyle(el).opacity : 'none'
        })(),
        navs: __t.count('.lightbox .lb-nav'),
      }
    `
    const lb = await waitFor(cdp, LB_PROBE, { label: 'lightbox 标签', timeout: 45000 })
    check('大图预览: 标签 pill 已渲染', lb.tags > 0, `${lb.tags} 个`)
    check('大图预览: 复制拆成 主按钮+箭头, 加收藏共 3 个按钮', lb.copyBtns === 3, `实际 ${lb.copyBtns}`)
    check('大图预览: 列表里可翻页(随机序也能定位)', lb.navs === 2, `${lb.navs} 个箭头`)
    check('大图预览: 角色/系列区渲染数 == 数据里的项数', lb.want > 0 && lb.chars >= 1,
      `数据 ${lb.want} 项 / 渲染 ${lb.chars} 行 · 翻了 ${lb.hops} 张 · ${lb.tags} 个标签`)
    check('大图预览: 角色 pill 上挂着 🛒 购物车图标(2026-09-20 需求)',
      lb.charPills > 0 && lb.cartIcons >= lb.charPills,
      `角色 pill ${lb.charPills} 个 · 🛒 ${lb.cartIcons} 个(已入车会有浮层+内联两个)`)
    check('大图预览: 悬停动作浮层默认隐藏且绝对定位不占布局(2026-09-20 抽搐修复)',
      lb.actsOp === '0|absolute', `opacity|position=${lb.actsOp}`)
    check('大图预览: 已 ban pill 的 🚫 内联常驻(静态不随悬停伸缩; 本图无 banned 则视为满足)',
      lb.banned === 0 || lb.bannedSt === lb.banned,
      `banned=${lb.banned} · 内联🚫=${lb.bannedSt}`)
    check('大图预览: 已 ban pill 悬停浮层里仍有 🚫(取消入口不被浮层盖掉, 2026-09-20 回归)',
      lb.banned === 0 || lb.bannedBan === lb.banned,
      `banned=${lb.banned} · 浮层🚫=${lb.bannedBan}`)
    await cdp.shot('02-lightbox')

    /* 复制下拉真的能切到"去ban"并复制(用 main 进程读剪贴板核对):
     * 2026-09-20 起三个复制按钮收成 主按钮+箭头菜单, 点菜单项 = 切模式并立即复制。 */
    const clip = await cdp.eval(`
      __t.click('.lightbox .lb-copy-row .cs-arrow')
      await new Promise(r => setTimeout(r, 350))
      const mi = [...document.querySelectorAll('.lightbox .cs-menu .mi')]
        .find((e) => /去ban/.test(e.textContent))
      if (!mi) return { err: '菜单里没有去ban项', items: [...document.querySelectorAll('.lightbox .cs-menu .mi')].map((e) => e.textContent.trim()) }
      mi.click()
      await new Promise(r => setTimeout(r, 500))
      return await window.tv.invoke('clipboard:write', { text: '' })
    `)
    check('复制下拉: 菜单切到去ban并复制成功', !!clip?.ok && !clip?.err, JSON.stringify(clip).slice(0, 160))
    check('复制下拉: 菜单项选中后成为主按钮的当前模式',
      (await cdp.eval(`return __t.text('.lightbox .cs-main')`)).includes('去ban'), '')

    await cdp.eval(`document.querySelector('.lightbox .lb-close').click(); return true`)
    check('大图预览可关闭', !(await cdp.eval(`return !!document.querySelector('.lightbox')`)))

    /* ---------------- 4. 首页搜索 / 收藏筛选 / 换一批 ---------------- */
    const before = home.total
    await cdp.eval(`
      __t.setInput('.sug input', 'blue_archive')
      await new Promise(r => setTimeout(r, 300))
      __t.pressEnter('.sug input')
      return true
    `)
    await waitFor(cdp, `__t.text('.result-head b') !== ${JSON.stringify(before)}`, { label: '搜索结果变化', timeout: 30000 })
    const after = await cdp.eval(`return __t.text('.result-head b')`)
    check('首页: 关键词搜索生效', after !== before, `${before} -> ${after}`)

    await cdp.eval(`__t.click('.hdr .tv-btn', 0); return true`)   // ❤ 收藏筛选
    await sleep(800)
    const favOn = await cdp.eval(`return document.querySelector('.hdr .tv-btn.v-fav')?.classList.contains('active')`)
    check('首页: 「只看收藏」可切换', favOn === true, `active=${favOn}`)
    await cdp.eval(`__t.click('.hdr .tv-btn', 0); return true`)
    await sleep(600)

    await cdp.eval(`__t.setInput('.sug input', ''); return true`)
    await cdp.eval(`__t.pressEnter('.sug input'); return true`)
    await waitFor(cdp, `__t.count('.grid .card') > 0`, { label: '清空后重新搜索', timeout: 30000 })

    const p1 = await cdp.eval(`return __t.text('.grid .card .foot')`)
    await cdp.eval(`__t.clickText('.shuffle', '🎲'); return true`)
    await sleep(1200)
    const p2 = await cdp.eval(`return __t.text('.grid .card .foot')`)
    check('首页: 换一批(随机种子)生效', p1 !== p2, `${p1} -> ${p2}`)

    /* 来源筛选: 选第一个非「全部」的来源 */
    const srcFilter = await cdp.eval(`
      const chips = [...document.querySelectorAll('.src-bar .tv-chip')]
      const target = chips[1]
      if (!target) return null
      const name = target.textContent
      target.click()
      await new Promise(r => setTimeout(r, 1500))
      return { name, total: __t.text('.result-head b'), active: __t.count('.src-bar .tv-chip.active') }
    `)
    check('首页: 来源筛选生效', srcFilter && srcFilter.active === 1,
      srcFilter ? `${srcFilter.name} -> ${srcFilter.total} 条` : '没有来源可选')
    await cdp.eval(`
      const chips = [...document.querySelectorAll('.src-bar .tv-chip')]
      chips[0].click()
      await new Promise(r => setTimeout(r, 1200))
      return true
    `)

    /* ---------------- 5. 规则编辑器 ---------------- */
    const rules = await cdp.eval(`
      __t.clickText('.btns .tv-btn', '黑名单')
      await new Promise(r => setTimeout(r, 900))
      const ta = document.querySelector('.mask textarea')
      return ta ? { len: ta.value.length, stat: __t.text('.mask .stat'), lines: ta.value.split('\\n').filter(l=>l.trim() && !l.trim().startsWith('#')).length } : null
    `)
    check('黑名单编辑器: 能读到规则', rules && rules.len > 100, rules ? `${rules.lines} 条规则 / ${rules.len} 字符 · ${rules.stat}` : '没打开')
    await cdp.shot('03-rules')
    await cdp.eval(`document.querySelector('.mask .x').click(); return true`)

    /* ---------------- 6. 系列浏览 ---------------- */
    await cdp.eval(`__t.clickText('.hdr .nv', '系列'); return true`)
    await waitFor(cdp, `__t.count('.ecard') > 0`, { label: '系列卡片', timeout: 60000 })
    const seriesList = await cdp.eval(`
      return {
        cards: __t.count('.ecard'),
        cats: __t.count('.cat-bar .tv-tabs .tab'),
        thumbs: __t.count('.ecard .tv-img.loaded'),
        first: __t.text('.ecard .name'),
      }
    `)
    check('系列: 列表已渲染', seriesList.cards > 0, `${seriesList.cards} 个系列, 首个=${seriesList.first}`)
    check('系列: 分类 tab 已渲染', seriesList.cats > 1, `${seriesList.cats} 个分类`)
    await cdp.shot('04-series-list')

    /* 系列搜索(中文) */
    const zhHit = await cdp.eval(`
      __t.setInput('.cat-bar .tv-input', '蔚蓝')
      await new Promise(r => setTimeout(r, 700))
      return { n: __t.count('.ecard'), first: __t.text('.ecard .name') }
    `)
    check('系列: 中文搜索可用', zhHit.n > 0 && zhHit.n <= seriesList.cards,
      `「蔚蓝」-> ${zhHit.n} 个, 首个=${zhHit.first}`)
    await cdp.eval(`__t.setInput('.cat-bar .tv-input', ''); return true`)
    await sleep(600)

    /* 进入角色列表 */
    await cdp.eval(`
      const hit = [...document.querySelectorAll('.ecard')].find(e => e.textContent.includes('蔚蓝档案')) || document.querySelector('.ecard')
      hit.click()
      return true
    `)
    await waitFor(cdp, `__t.count('.ecard') > 0 && __t.text('.cat-bar .hint').includes('角色')`, { label: '角色列表', timeout: 40000 })
    const chars = await cdp.eval(`
      return { n: __t.count('.ecard'), hint: __t.text('.cat-bar .hint'), first: __t.text('.ecard .name'), thumbs: __t.count('.ecard .tv-img.loaded') }
    `)
    check('系列: 角色列表已渲染', chars.n > 0, `${chars.n} 个角色 · ${chars.hint} · 首个=${chars.first}`)
    await cdp.shot('05-series-chars')

    /* 角色排序 */
    const sorted = await cdp.eval(`
      const sel = [...document.querySelectorAll('.cat-bar select')].pop()
      sel.value = 'images'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 400))
      return __t.text('.ecard .name')
    `)
    check('系列: 角色排序可切换(图片最多)', !!sorted, `首个=${sorted}`)

    /* 选择模式 -> 全选 -> 加入购物车 */
    const cartAdd = await cdp.eval(`
      __t.clickText('.cat-bar .tv-btn', '选择导出')
      await new Promise(r => setTimeout(r, 300))
      __t.clickText('.cat-bar .tv-btn', '全选')
      await new Promise(r => setTimeout(r, 300))
      const sel = __t.count('.ecard.selected')
      __t.clickText('.cat-bar .tv-btn', '全部加入购物车')
      await new Promise(r => setTimeout(r, 900))
      const badge = __t.text('.hdr .nv .badge')
      return { sel, badge, toast: __t.text('.toast') }
    `)
    check('系列: 选择模式 + 批量入购物车', cartAdd.sel > 0 && Number(cartAdd.badge) >= cartAdd.sel,
      `选中 ${cartAdd.sel} 个 -> 角标 ${cartAdd.badge} · ${cartAdd.toast}`)
    await cdp.shot('06-series-select')

    /* 进入图片视图 */
    await cdp.eval(`
      const c = document.querySelector('.ecard')
      c.click()
      return true
    `)
    await waitFor(cdp, `__t.count('.grid .card') > 0`, { label: '角色图片', timeout: 60000 })
    const imgs = await cdp.eval(`return { cards: __t.count('.grid .card'), total: __t.text('.cnt') }`)
    check('系列: 角色图片(无限滚动)已渲染', imgs.cards > 0, `${imgs.total} 条匹配, 首屏 ${imgs.cards} 张`)
    await cdp.shot('07-series-images')

    /* 无限滚动: 滚到底应追加。
     * 别写成「滚一次 + 死等 2500ms」—— 滚动发生时容器可能还没到可滚动状态,
     * 或 IntersectionObserver 晚一拍回调, 于是偶发 60 -> 60 的假红。
     * 这里改成轮询: 反复滚到底, 直到卡片数增长或超时。 */
    const scrollRes = await cdp.eval(`
      const el = document.querySelector('.series-view .scroll')
      const start = __t.count('.grid .card')
      let n = start
      const t0 = Date.now()
      while (Date.now() - t0 < 15000) {
        el.scrollTop = el.scrollHeight
        await new Promise(r => setTimeout(r, 400))
        n = __t.count('.grid .card')
        if (n > start) break
      }
      return { start, n, ms: Date.now() - t0 }
    `)
    check('系列: 无限滚动会追加', scrollRes.n > scrollRes.start,
      `${scrollRes.start} -> ${scrollRes.n} (用 ${scrollRes.ms}ms)`)

    /* 分类管理 */
    await cdp.eval(`__t.clickText('.crumb .link', '全部系列'); return true`)
    await waitFor(cdp, `__t.count('.ecard') > 0`, { label: '回到系列列表', timeout: 40000 })
    const catMgr = await cdp.eval(`
      __t.clickText('.cat-bar .tv-btn', '分类管理')
      await new Promise(r => setTimeout(r, 1500))
      return { tabs: __t.count('.mask .tv-tabs .tab'), combos: __t.count('.mask .combo'), title: __t.text('.mask .head') }
    `)
    check('分类管理: 三个页签 + 下拉已渲染', catMgr.tabs === 3 && catMgr.combos >= 2,
      `${catMgr.tabs} 页签 / ${catMgr.combos} 下拉`)
    await cdp.shot('08-category-manager')
    await cdp.eval(`document.querySelector('.mask .x').click(); return true`)
    await sleep(400)
    /* 分类过滤 */
    const catFilter = await cdp.eval(`
      const tabs = [...document.querySelectorAll('.cat-bar .tv-tabs .tab')]
      const t = tabs[1]
      if (!t) return null
      t.click()
      await new Promise(r => setTimeout(r, 700))
      return { label: t.textContent, n: __t.count('.ecard'), active: __t.count('.cat-bar .tv-tabs .tab.active') }
    `)
    check('系列: 分类 tab 过滤生效', catFilter && catFilter.active === 1,
      catFilter ? `${catFilter.label} -> ${catFilter.n} 个系列` : '没有分类 tab')
    await cdp.eval(`__t.clickText('.cat-bar .tv-tabs .tab', '全部'); return true`)

    /* ---------------- 7. 标签浏览 ---------------- */
    await cdp.eval(`__t.clickText('.hdr .nv', '标签'); return true`)
    await waitFor(cdp, `__t.count('.tag-list .pill') > 0`, { label: '标签列表', timeout: 60000 })
    const tags = await cdp.eval(`
      return {
        n: __t.count('.tag-list .pill'),
        withZh: __t.count('.tag-list .pill .zh'),
        withCnt: __t.count('.tag-list .pill .cnt'),
        banned: __t.count('.tag-list .pill.banned'),
        tip: __t.text('.bar .hint'),
        totalText: __t.text('.bar .hint', 0),
      }
    `)
    check('标签: 列表已渲染', tags.n > 0, `${tags.n} 个标签 · ${tags.totalText}`)
    // 这里以前只要求 withZh > 0 —— 太弱了, 弱到"翻译库整体没加载"都测不出来:
    // 光靠 local_translations.json(4000 条冷门补译)就能凑出个位数, 实测 300 个标签里
    // 只有 4 个有中文(1.3%)也照样判定"带中文翻译 ✓"。而标签页列的是按使用量倒序的
    // 前 300 个最常见标签, 翻译库正常时覆盖率应该是压倒性的, 所以改用比例来守。
    const zhRate = tags.n ? tags.withZh / tags.n : 0
    check('标签: 中文覆盖率正常(不是只靠零星本地补译)', zhRate >= 0.5,
      `${tags.withZh}/${tags.n} = ${(zhRate * 100).toFixed(1)}% 有中文`)
    check('标签: 带使用计数', tags.withCnt > 0, `${tags.withCnt} 个有计数`)
    check('标签: 已 ban 状态可见', tags.banned > 0, `${tags.banned} 个已 ban`)
    await cdp.shot('09-tags')

    /* 点标签 -> 图片。2026-09-20 起这是**下一级子页面** /tags/xxx(独立路由),
       不是挂在标签列表上的 ?tag= —— 顺带把层级(H1 面包屑 / 后退一步 / 顶栏选中)钉住。 */
    await cdp.eval(`__t.click('.tag-list .pill'); return true`)
    await waitFor(cdp, `__t.count('.grid .card') > 0`, { label: '标签图片', timeout: 60000 })
    const tagImgs = await cdp.eval(`
      return {
        cards: __t.count('.grid .card'),
        total: __t.text('.cnt'),
        hash: decodeURIComponent(location.hash),
        isSub: !!document.querySelector('.tag-images-view'),
        parent: __t.text('.tag-images-view .crumb .link'),
        crumb: __t.text('.tag-images-view .crumb .now'),
        navOn: __t.text('.hdr .nv.on'),
      }
    `)
    check('标签: 点击进入该标签图片', tagImgs.cards > 0, `${tagImgs.total} 条 · ${tagImgs.cards} 张`)
    check('标签: 是独立子页面(路径形式 /tags/xxx, 不是 ?tag= 挂在列表上)',
      tagImgs.isSub && /#\/tags\/.+/.test(tagImgs.hash) && !tagImgs.hash.includes('?'),
      tagImgs.hash)
    check('标签: 子页面面包屑读作「全部标签 > 该标签」',
      tagImgs.parent === '全部标签' && !!tagImgs.crumb, `${tagImgs.parent} > ${tagImgs.crumb}`)
    check('标签: 子页面里顶栏「标签」保持选中(继承父导航)',
      (tagImgs.navOn || '').includes('标签'), tagImgs.navOn)
    await cdp.shot('10-tags-images')
    // 层级是真的: 浏览器后退一步就回标签列表(以前 ?tag= 是同一个页面, 得退两次)
    await cdp.eval(`history.back(); return true`)
    await waitFor(cdp, `__t.count('.tag-list .pill') > 0`, { label: '后退回标签列表', timeout: 20000 })
    const backOne = await cdp.eval(`return { hash: location.hash, isList: !!document.querySelector('.tags-view') }`)
    check('标签: 从子页面后退一步即回到标签列表(层级是真的)',
      backOne.isList && backOne.hash === '#/tags', backOne.hash)
    await sleep(400)

    /* 标签页内 ban 切换(写在副本数据目录里)
     * 注意: 浮层化之后 banned pill 的 🚫 是内联 .st、未 ban 的是浮层 .ban,
     * 点一下 DOM 就会换节点 —— 所以每一步都按 tag 文本重新抓当前节点。 */
    const banToggle = await cdp.eval(`
      const pick = () => [...document.querySelectorAll('.tag-list .pill')]
        .find(p => p.querySelector('.ban, .st'))
      const pill0 = pick()
      if (!pill0) return null
      const tagTxt = pill0.querySelector('.en').textContent
      const byTag = () => [...document.querySelectorAll('.tag-list .pill')]
        .find(p => p.querySelector('.en')?.textContent === tagTxt)
      const wasBanned = pill0.classList.contains('banned')
      ;(pill0.querySelector('.st') || pill0.querySelector('.ban')).click()
      await new Promise(r => setTimeout(r, 900))
      const p2 = byTag()
      const nowBanned = p2.classList.contains('banned')
      ;(p2.querySelector('.st') || p2.querySelector('.ban')).click()
      await new Promise(r => setTimeout(r, 900))
      const p3 = byTag()
      return { wasBanned, nowBanned, restored: p3.classList.contains('banned') }
    `)
    check('标签: 🚫 可切换 ban 且能还原',
      banToggle && banToggle.nowBanned !== banToggle.wasBanned && banToggle.restored === banToggle.wasBanned,
      JSON.stringify(banToggle))

    /* ---------------- 7.5 导出预设: ban 完自动导出 (2026-09-22) ---------------- */
    /*
     * 验的是"改了黑名单不用再手动点导出"这条链路, 全程落在测试工作目录里:
     *   预设存  .e2e-work/data/user/export_presets.json
     *   导出到  .e2e-work/export-dest/preset-e2e.txt
     * 证据用**真实文件内容**, 不靠界面文案:
     *   ban 一个真实存在的标签 -> 文件内容必须变, 且该标签消失;
     *   取消 ban            -> 内容必须**逐字节回到基线**(说明导出的确是黑名单的函数);
     *   关掉自动开关再 ban   -> 文件纹丝不动(负向控制)。
     */
    const EXPORT_DIR = path.join(path.dirname(DATA_DIR), 'export-dest')
    fs.mkdirSync(EXPORT_DIR, { recursive: true })
    const EXPORT_NAME = 'preset-e2e.txt'
    const EXPORT_PATH = path.join(EXPORT_DIR, EXPORT_NAME)
    const readExport = () => (fs.existsSync(EXPORT_PATH) ? fs.readFileSync(EXPORT_PATH, 'utf8') : '')
    /** 文件的"版本指纹"(mtime+size) —— 比读 42MB 全文便宜得多 */
    const statExport = () => {
      try { const s = fs.statSync(EXPORT_PATH); return `${s.mtimeMs}|${s.size}` } catch { return '' }
    }
    /**
     * 等文件内容变得 ≠ before(自动导出是"防抖 1.5s + 导出耗时", 得轮询)。
     *
     * 2026-09-22 改: 先用 stat 探、**只在真的变了之后**才读全文。
     * 原来每 400ms 读一次 42MB —— 既慢, 又让"刚被主进程写完的目标文件"更容易
     * 处在被占用的状态(实测那次 rename 就是 EPERM 挂掉的, 见 exportPresets 里的注释),
     * 等于测试自己给被测代码使绊子。
     */
    const waitExportChange = async (before, timeoutMs = 25000) => {
      const t0 = Date.now()
      let lastStat = statExport()
      while (Date.now() - t0 < timeoutMs) {
        await sleep(400)
        const st = statExport()
        if (st === lastStat) continue
        lastStat = st
        const now = readExport()
        if (now !== before) return { changed: true, waited: Date.now() - t0, text: now }
      }
      return { changed: false, waited: Date.now() - t0, text: readExport() }
    }
    /** 导出行里是否**整词**含有某个标签(不能拿子串判断, girl 会误命中 2girls) */
    const hasTag = (text, tag) => text.split('\n').some((l) => l.split(',').map((s) => s.trim()).includes(tag))
    /**
     * 导出内容里的标签是**空格形态**, 数据集/黑名单里存的是**下划线形态**。
     *
     * export 的默认参数 spaces=true 会把每个标签的 `_` 换成空格(buildExport 里那行
     * `tags.map(t => t.replace(/_/g, ' '))`), 于是:
     *   导出文件里看到 `looking at viewer`  ←→  tags.db 里是 `looking_at_viewer`(实测 68016 张)
     *   导出文件里看到 `open mouth`        ←→  tags.db 里是 `open_mouth`(实测 36143 张)
     *
     * 2026-09-22 踩到的坑(4 条断言假失败的真因):
     *   挑候选时从**导出内容**里取 token -> 拿到空格形态, 原样丢给 blacklist:toggle ->
     *   黑名单里写进一条 `looking at viewer`。而 isBlockedFast 拿**下划线形态**的标签去比对
     *   (它不做空格->下划线归一), 这条规则**永远不可能命中** -> ban 成了静默空操作。
     *   偏偏 afterBlacklistChange 只看"黑名单文本指纹变没变" —— 文本确实变了, 于是
     *   scheduled=true、自动导出照跑, 但导出内容**逐字节不变**;
     *   断言看到的就是"自动导出没被触发"(其实触发了: 手动导出/落盘/回执全都正常)。
     * 所以凡是拿导出 token 去操作**数据侧**(黑名单)的地方, 必须先转回下划线形态。
     */
    const asDatasetTag = (t) => String(t).replace(/ /g, '_')

    /*
     * 幂等: 先清掉上一轮可能残留的预设, 免得断言认错对象。
     *
     * 2026-09-22 加严: 原来只删名字以 `e2e` 开头的, 于是**任何别的**遗留预设
     * (比如手工探针建的 `probe 自动导出`)都会留在沙箱里 —— 它的 auto 开关也是开着的,
     * 直接把「全新一轮 e2e 到底该有几个 auto 预设」这个前提搞坏:
     *   · 首页角标变成「自动 2」(断言写的是自动 1) -> 失败
     *   · 弹窗列表第一行是别人的名字(断言要求名字里有 e2e) -> 失败
     * 所以判据加一条"目标目录落在这个沙箱里的一律清掉" —— 那是测试自己的地盘,
     * 用户真实预设的目标目录不在这里, 不会被误删。
     *
     * 路径判定放在 **Node 侧**做: 一是能在真 JS 里痛快地归一斜杠(手工探针存下来的
     * 目录用**正斜杠**、`path.join` 出来的用**反斜杠**, 不归一根本比不中),
     * 二是免得在 cdp.eval 的模板字符串里跟 `\\` 转义纠缠。
     */
    const listedPresets = await cdp.eval(`return (await window.tv.invoke('export:preset:list')).presets`)
    const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase()
    const SANDBOX = norm(path.dirname(EXPORT_DIR))
    const staleIds = (listedPresets || [])
      .filter((p) => p.name.startsWith('e2e') || norm(p.dir).startsWith(SANDBOX))
      .map((p) => p.id)
    const cleaned = await cdp.eval(`
      for (const id of ${JSON.stringify(staleIds)}) await window.tv.invoke('export:preset:delete', { id })
      const left = (await window.tv.invoke('export:preset:list')).presets
      return { left: left.length, names: left.map((p) => p.name) }
    `)
    cleaned.removed = staleIds.length

    const savedPreset = await cdp.eval(`
      const r = await window.tv.invoke('export:preset:save', {
        name: 'e2e 自动导出',
        dir: ${JSON.stringify(EXPORT_DIR)},
        file: ${JSON.stringify(EXPORT_NAME)},
        auto: true,
        params: { source: [], q: '', mode: 'any', match: 'contains', exclude: '',
          exclude_char: true, spaces: true, blacklist: true, replace: true, bg: true,
          strip_char: false, with_path: false },
      })
      return { id: r.preset.id, auto: r.preset.auto, count: r.presets.length }
    `)
    check('导出预设: 能保存(目标目录 + 参数快照 + 自动开关)',
      !!savedPreset?.id && savedPreset.auto === true,
      `清掉遗留预设 ${cleaned.removed} 个 · 现有 ${savedPreset?.count} 个`
      + (cleaned.names?.length ? ` · 清完还剩别人建的 ${cleaned.names.join('、')}` : ''))

    /*
     * 自动导出的**回执**必须收下来 —— 失败时"压根没触发"和"触发了但被就绪守卫跳过"
     * 在文件层面长得一模一样(目标文件 mtime 不动), 只有这条推送能区分:
     * 主进程两条路径都会推 —— 跑完推 {results}, 被跳过推 {phase}(见 exportPresets.runAuto)。
     * 2026-09-22 加: 上一轮 4 条断言失败时, 正是缺这份证据只能靠猜。
     */
    const tapAutoEvents = () => cdp.eval(`
      if (window.__offAuto) window.__offAuto()
      window.__autoEv = []
      window.__offAuto = window.tv.on('export:auto', (p) => window.__autoEv.push({
        at: p.at,
        skipPhase: p.phase || '',
        n: (p.results || []).length,
        trig: (p.results || []).map((r) => r.trigger || ''),
        err: (p.results || []).map((r) => r.error || '').filter(Boolean),
      }))
      return true
    `)
    const readAutoEvents = () => cdp.eval(`return { ev: window.__autoEv || [], phase: (await window.tv.invoke('app:status')).phase }`)
    const autoEvidence = async () => {
      const r = await readAutoEvents()
      return `${r.ev.length} 条回执(phase=${r.phase}) ${JSON.stringify(r.ev)}`
    }
    await tapAutoEvents()

    // 立即导出: 文件真的落盘, 行数与回执一致
    const presetRun = await cdp.eval(`return await window.tv.invoke('export:preset:run', { id: ${JSON.stringify(savedPreset.id)} })`)
    const baselineText = readExport()
    const baselineLines = baselineText.split('\n').filter((l) => l.trim()).length
    check('导出预设: 立即导出真的写到目标目录', !!presetRun?.ok && fs.existsSync(EXPORT_PATH),
      `${presetRun?.path || '没落盘'}`)
    check('导出预设: 回执行数 == 文件实际行数', presetRun?.count > 0 && presetRun.count === baselineLines,
      `回执 ${presetRun?.count} · 文件 ${baselineLines} 行`)
    const strayFiles = fs.readdirSync(EXPORT_DIR).filter((f) => f.startsWith('preset-e2e'))
    check('导出预设: 固定文件名原地覆盖(只留一个文件, 不堆副本)',
      strayFiles.length === 1, `目录里=${strayFiles.join(', ')}`)

    // 界面: 首页入口 + 弹窗列表
    await cdp.eval(`__t.clickText('.hdr .nv', '看板'); return true`)
    await sleep(900)
    const presetModal = await cdp.eval(`
      __t.clickText('.btns .tv-btn', '预设导出')
      await new Promise(r => setTimeout(r, 800))
      return {
        rows: __t.count('.mask .prow'),
        name: __t.text('.mask .pname'),
        autoOn: __t.count('.mask .auto-sw input:checked'),
        path: __t.text('.mask .ppath'),
        meta: __t.text('.mask .pmeta'),
      }
    `)
    check('导出预设: 弹窗列出预设(名字/目标文件/自动开关/上次导出)',
      presetModal.rows >= 1 && /e2e/.test(presetModal.name) && presetModal.autoOn >= 1
      && presetModal.path.includes(EXPORT_NAME) && /\d/.test(presetModal.meta),
      `${presetModal.name} · ${presetModal.meta.slice(0, 60)}`)
    await cdp.shot('12-export-presets')
    await cdp.eval(`document.querySelector('.mask .x').click(); return true`)
    await sleep(400)
    const homeBtnText = await cdp.eval(`return __t.text('.btns')`)
    check('导出预设: 首页按钮显示「自动 N」角标', /预设导出/.test(homeBtnText) && /自动\s*1/.test(homeBtnText),
      homeBtnText.slice(0, 90))

    // 自动导出: 挑一个**真实出现在导出内容里**的标签 ban 掉
    const blText = (await cdp.eval(`const r = await window.tv.invoke('blacklist:get'); return r.text || ''`)) || ''
    const freq = new Map()
    for (const line of baselineText.split('\n')) {
      for (const t of line.split(',').map((s) => s.trim())) if (t) freq.set(t, (freq.get(t) || 0) + 1)
    }
    // 导出内容里的形态(空格) —— 只用来读文件、算频次、断言
    const candidates = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t)
    // 黑名单/数据集里的形态(下划线) —— 只用来写黑名单、比对规则(见 asDatasetTag 的注释)
    const blSet = new Set(blText.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')))
    const alreadyBanned = (t) => blSet.has(asDatasetTag(t).toLowerCase())
    let probe = ''           // 导出内容形态(断言用)
    let probeTag = ''        // 数据集形态(操作黑名单用)
    let probeBanned = false
    let probeAuto = null     // blacklist:toggle 回执里的 auto(排程结果) —— 与回执推送互补的证据
    const tried = []         // 逐个候选的尝试结果: 失败时能一眼看出卡在哪一个、为什么
    for (const t of candidates) {
      // 已在黑名单里 -> toggle 语义相反(会把它解开), 跳过。
      // 注意比的是**下划线形态**: 早先用空格形态比, 对多词标签永远比不中。
      if (alreadyBanned(t)) { tried.push(`${t}:已在黑名单`); continue }
      const tag = asDatasetTag(t)
      const r = await cdp.eval(`return await window.tv.invoke('blacklist:toggle', { tag: ${JSON.stringify(tag)} })`)
      tried.push(`${tag}:${r?.action || '?'}`
        + (r?.auto ? `(changed=${r.auto.changed},sched=${r.auto.scheduled},autoN=${r.auto.autoCount})` : ''))
      if (r?.banned) { probe = t; probeTag = tag; probeBanned = true; probeAuto = r.auto || null; break }
    }
    check('导出预设: 前置条件 —— 找到真实存在的标签并 ban 成功', !!probe,
      `probe=${probe || '无'}(黑名单里写作 ${probeTag || '-'}) · 候选=${candidates.slice(0, 4).join('/')}`
      + ` · 尝试=[${tried.join(' | ')}]` + (probeAuto ? ` · 排程=${JSON.stringify(probeAuto)}` : ''))

    let afterBan = { changed: false, text: baselineText, waited: 0 }
    if (probeBanned) afterBan = await waitExportChange(baselineText)
    const evAfterBan = await autoEvidence()
    check('导出预设: ban 后**自动**导出覆盖了目标文件(1.5s 防抖后)',
      afterBan.changed, `等了 ${afterBan.waited}ms · ${evAfterBan}`)
    check('导出预设: 自动导出确实套用了新黑名单(probe 标签已从内容里消失)',
      !!probe && !hasTag(afterBan.text, probe), `probe=${probe} · 回执 ${evAfterBan}`)

    // 取消 ban -> 内容必须逐字节回到基线(证明导出结果就是黑名单的函数)
    if (probeBanned) {
      await cdp.eval(`return await window.tv.invoke('blacklist:toggle', { tag: ${JSON.stringify(probeTag)} })`)
    }
    const afterUnban = await waitExportChange(afterBan.text)
    check('导出预设: 取消 ban 后导出内容逐字节回到基线',
      afterUnban.changed && afterUnban.text === baselineText,
      `等了 ${afterUnban.waited}ms · 长度 ${afterUnban.text.length} vs ${baselineText.length} · ${await autoEvidence()}`)

    // 负向控制: 关掉自动开关, 再 ban 一个标签 -> 文件必须纹丝不动
    await cdp.eval(`
      const r = await window.tv.invoke('export:preset:list')
      const p = r.presets.find((x) => x.id === ${JSON.stringify(savedPreset.id)})
      await window.tv.invoke('export:preset:save', { ...p, auto: false })
      return true
    `)
    /*
     * 黑名单文本到这里已经变过两轮(ban probe / unban probe), 上面那份 blSet 是**旧的**。
     * 负向控制要挑的是"当前没被 ban 的词", 必须按**现在**的黑名单重算 ——
     * 复用旧快照正是上一版竞态的来源之一。
     */
    const blText2 = (await cdp.eval(`const r = await window.tv.invoke('blacklist:get'); return r.text || ''`)) || ''
    const blSet2 = new Set(blText2.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')))
    let probe2 = ''          // 导出内容形态
    let probe2Tag = ''       // 数据集形态
    for (const t of candidates) {
      if (t === probe || blSet2.has(asDatasetTag(t).toLowerCase())) continue
      const tag = asDatasetTag(t)
      const r = await cdp.eval(`return await window.tv.invoke('blacklist:toggle', { tag: ${JSON.stringify(tag)} })`)
      if (r?.banned) { probe2 = t; probe2Tag = tag; break }
    }
    const beforeNeg = readExport()
    await sleep(6000)                       // 远超防抖 + 导出耗时, 真触发了不可能不变
    const afterNeg = readExport()
    check('导出预设(负向): 关掉自动开关后 ban 不再触发导出',
      !!probe2 && afterNeg === beforeNeg,
      `probe2=${probe2 || '无'} · 文件${afterNeg === beforeNeg ? '未变' : '变了'}`)
    /*
     * 这条的语义 2026-09-22 修正(原来写反了):
     *   beforeNeg 是在 **ban probe2 之前**读的, 里面**本来就应该还有** probe2 ——
     *   原来断言写成 `!hasTag(beforeNeg, probe2)`, 那要求"文件里没有 probe2",
     *   即要求"导出已经跑过了", 与上一条(没跑)自相矛盾, 任何一轮都必挂。
     * 正确的证据是: probe2 仍在文件里 -> 说明这一轮 ban 之后确实没有任何导出落盘。
     */
    check('导出预设(负向): 上一条 ban 确实没有触发任何导出(probe2 仍在文件里)',
      !!probe2 && hasTag(beforeNeg, probe2), `probe2=${probe2 || '无'}`)
    if (probe2) await cdp.eval(`return await window.tv.invoke('blacklist:toggle', { tag: ${JSON.stringify(probe2Tag)} })`)

    // 收尾: 删除预设(顺便验删除接口), 导出文件留着当证据
    const presetDel = await cdp.eval(`return await window.tv.invoke('export:preset:delete', { id: ${JSON.stringify(savedPreset.id)} })`)
    const afterDel = await cdp.eval(`const r = await window.tv.invoke('export:preset:list'); return { n: r.presets.length }`)
    check('导出预设: 删除预设后再查列表里没有它',
      presetDel?.removed === 1 && afterDel.n === cleaned.left,
      `删 ${presetDel?.removed} · 剩 ${afterDel.n}`)

    /* ---------------- 7.6 导出预设: 走**真实界面**存一次 (2026-09-22) ----------------
     * 为什么单开一节: 上面那些断言全是拿**纯对象**直接打 window.tv.invoke,
     * 压根不经过 Vue 的响应式状态 —— 于是"在界面里点保存"这条路坏了整整一轮也没被测出来。
     *
     * 实测症状(用户报障「导出预设的时候报错的」): 点「💾 创建预设」弹
     *   `An object could not be cloned.`, 一条也存不进去。
     * 根因: `editing.value.params` / `presets.value[i].params` 都是 reactive **嵌套代理**,
     *   而 Proxy 过不了结构化克隆 —— 且是在 contextBridge 那层就抛(拿未授权 channel 传纯对象
     *   能拿到我们自己的报错, 传 Proxy 则只有克隆失败), 所以 preload 里补救已经太晚。
     *   修法在 src/utils/api.js 的 `toPlain()`(出口处统一拆代理)。
     * 这一节就是它的回归防线, 同时覆盖列表上那个 auto 开关(另一条同类路径)。
     */
    const uiPresetName = 'e2e-ui-预设'
    const uiSave = await cdp.eval(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const pick = (txt) => [...document.querySelectorAll('.mask .box input.tv-input')]
        .find(i => (i.placeholder || '').includes(txt))
      const setV = (el, v) => {   // Vue 的 v-model 认 input 事件, 直接改 value 不触发
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        s.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const out = { opened: false, form: false }
      const open = [...document.querySelectorAll('.btns .tv-btn')].find(b => b.textContent.includes('预设导出'))
      if (!open) return out
      open.click(); await sleep(800); out.opened = !!document.querySelector('.mask .box')
      const add = [...document.querySelectorAll('.mask .box .tv-btn')].find(b => b.textContent.includes('新建预设'))
      if (!add) return out
      add.click(); await sleep(500); out.form = !!document.querySelector('.mask .box .frow')
      const nameEl = pick('ComfyUI')
      const dirEl = pick('目标目录')
      out.foundName = !!nameEl; out.foundDir = !!dirEl
      if (!nameEl || !dirEl) return out
      setV(nameEl, ${JSON.stringify(uiPresetName)})
      setV(dirEl, ${JSON.stringify(EXPORT_DIR)})
      await sleep(200)
      const save = [...document.querySelectorAll('.mask .box .foot .tv-btn')]
        .find(b => b.textContent.includes('创建预设'))
      out.saveBtn = save ? save.textContent.trim() : ''
      if (!save) return out
      save.click(); await sleep(1600)
      const errEl = document.querySelector('.mask .box .err')
      out.formErr = errEl ? errEl.textContent.trim() : ''
      out.backToList = !document.querySelector('.mask .box .frow')
      out.rowNames = [...document.querySelectorAll('.mask .pname')].map(e => e.textContent.trim())
      return out
    `)
    check('导出预设(界面): 前置条件 —— 弹窗打开、表单可填、找得到保存按钮',
      uiSave.opened && uiSave.form && uiSave.foundName && uiSave.foundDir && !!uiSave.saveBtn,
      `弹窗=${uiSave.opened} 表单=${uiSave.form} 名称框=${uiSave.foundName} 目录框=${uiSave.foundDir} 按钮=${uiSave.saveBtn || '无'}`)
    /*
     * 核心回归点: 这条以前会挂 —— 页面上会挂出红字
     * `An object could not be cloned.` 且停在表单里(backToList=false)。
     */
    check('导出预设(界面): 点「创建预设」不报克隆错, 且回到列表',
      uiSave.formErr === '' && uiSave.backToList === true,
      uiSave.formErr ? `表单报错: ${uiSave.formErr}` : '表单无报错')
    check('导出预设(界面): 新建的预设出现在列表里',
      (uiSave.rowNames || []).includes(uiPresetName),
      `列表=${(uiSave.rowNames || []).join('、') || '空'}`)

    const uiSaved = await cdp.eval(`
      const r = await window.tv.invoke('export:preset:list')
      const p = r.presets.find(x => x.name === ${JSON.stringify(uiPresetName)})
      if (!p) return null
      const q = p.params || {}
      return { id: p.id, auto: p.auto, dir: p.dir, file: p.file,
        srcIsArr: Array.isArray(q.source), spaces: q.spaces, match: q.match, q: q.q }
    `)
    // 深拆代理最容易"顺手把数据也丢了"(比如把数组拆成普通对象), 所以逐字段验一遍
    check('导出预设(界面): 参数快照完整落库(数组还是数组, 开关没被拆丢)',
      !!uiSaved && uiSaved.srcIsArr === true && uiSaved.spaces === true
      && uiSaved.match === 'contains' && uiSaved.dir === EXPORT_DIR,
      JSON.stringify(uiSaved))

    // 列表上的 auto 开关走的是另一条同类路径(`{ ...p, auto }`, 嵌套代理照旧)
    const uiToggle = await cdp.eval(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const row = [...document.querySelectorAll('.mask .prow')]
        .find(e => e.textContent.includes(${JSON.stringify(uiPresetName)}))
      if (!row) return { row: false }
      const cb = row.querySelector('.auto-sw input')
      if (!cb) return { row: true, cb: false }
      const before = cb.checked
      cb.click(); await sleep(1500)
      const r = await window.tv.invoke('export:preset:list')
      const p = r.presets.find(x => x.name === ${JSON.stringify(uiPresetName)})
      const errEl = document.querySelector('.mask .box .err')
      return { row: true, cb: true, before, after: p ? p.auto : null,
        errText: errEl ? errEl.textContent.trim() : '' }
    `)
    check('导出预设(界面): 列表上的「变更后自动导出」开关能存回去',
      uiToggle.row === true && uiToggle.cb === true && uiToggle.before === true
      && uiToggle.after === false && uiToggle.errText === '',
      `开关 ${uiToggle.before} → ${uiToggle.after}` + (uiToggle.errText ? ` · 报错 ${uiToggle.errText}` : ''))

    const uiClean = await cdp.eval(`
      const r = await window.tv.invoke('export:preset:list')
      const p = r.presets.find(x => x.name === ${JSON.stringify(uiPresetName)})
      if (!p) return { removed: 0 }
      const d = await window.tv.invoke('export:preset:delete', { id: p.id })
      const x = document.querySelector('.mask .x')
      if (x) x.click()
      const after = await window.tv.invoke('export:preset:list')
      return { removed: d.removed, left: after.presets.length }
    `)
    check('导出预设(界面): 收尾 —— 删掉界面建的预设, 不给下一轮留残留',
      uiClean.removed === 1, `删 ${uiClean.removed} · 剩 ${uiClean.left}`)

    /*
     * 首页动作区的分层结构: 搜索独占一行 / 导出做成分裂按钮 / 替换+预设导出降级成文字链。
     *
     * 为什么必须断言: 「导出(带路径)」原来是独立按钮, 改版后**只从分裂按钮的下拉里进得去** ——
     * 谁顺手把那个菜单项删了, 这条 UI 路径就静默消失, 而别处一条断言都不会红。
     *
     * 这里刻意**不点**下拉里的两个导出项: 它们最终会走 dialog.showSaveDialog,
     * 原生模态框在 e2e 里没人关得掉, 整轮直接挂死。带路径的导出语义由 selftest 覆盖,
     * 这一节只保证「入口在、文案对、两个导出开关还绑着、展开不裁切」。
     */
    const homeBtns = await cdp.eval(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const out = {}
      const all = [...document.querySelectorAll('.btns .tv-btn')]
      out.pathBtnGone = !all.some(b => b.textContent.includes('带路径'))
      out.lnk = [...document.querySelectorAll('.btns .lnk .tv-btn')].map(b => b.textContent.trim())
      out.tipLinks = document.querySelectorAll('.tip a').length

      const left = document.querySelector('.left')
      left.scrollTop = left.scrollHeight        // 动作区在表单底部, 不滚到底测不到几何
      await sleep(300)
      const caret = document.querySelector('.btns .caret')
      out.caret = !!caret
      if (!caret) { left.scrollTop = 0; return out }
      caret.click(); await sleep(350)

      const menu = document.querySelector('.btns .menu')
      out.menuOpen = !!menu
      if (!menu) { left.scrollTop = 0; return out }

      out.items = [...menu.querySelectorAll('.mi .mt')].map(e => e.textContent.trim())
      out.checks = [...menu.querySelectorAll('.mopt .tv-check')].map(e => e.textContent.trim())
      out.emptyMenuBtn = [...menu.querySelectorAll('.mi .mh')].every(e => e.textContent.trim().length > 0)

      const box = menu.getBoundingClientRect()
      const row = document.querySelectorAll('.btns .brow')[1].getBoundingClientRect()
      const lr = left.getBoundingClientRect()
      out.sameWidthAsRow = Math.abs(box.width - row.width) < 1.5
      out.insidePanel = box.top >= lr.top - 0.5 && box.bottom <= lr.bottom + 0.5
        && box.left >= lr.left - 0.5 && box.right <= lr.right + 0.5
      out.inViewport = box.top >= 0 && box.bottom <= window.innerHeight
      out.caretRotated = !!menu.parentElement.querySelector('.chev.up')

      const cbs = [...menu.querySelectorAll('.mopt .tv-check')]
      out.cbBefore = cbs.map(e => e.classList.contains('on'))
      cbs.forEach((e) => e.click()); await sleep(300)
      out.cbAfter = cbs.map(e => e.classList.contains('on'))

      caret.click(); await sleep(300)            // 收尾: 关下拉, 别让遮罩挡住后面的步骤
      out.menuClosed = !document.querySelector('.btns .menu')
      left.scrollTop = 0
      return out
    `)
    check('首页动作区: 「导出(带路径)」不再占独立按钮, 已并入下拉',
      homeBtns.pathBtnGone === true, `文字链 = ${(homeBtns.lnk || []).join('、')}`)
    check('首页动作区: 分裂按钮下拉含两条导出方式 + 两个导出选项',
      homeBtns.caret === true && homeBtns.menuOpen === true
      && (homeBtns.items || []).length === 2
      && (homeBtns.items || []).join('').includes('带图片路径')
      && (homeBtns.checks || []).length === 2 && homeBtns.emptyMenuBtn === true,
      `项 = ${(homeBtns.items || []).join(' / ')} · 选项 = ${(homeBtns.checks || []).join(' / ')}`)
    check('首页动作区: 下拉与整排同宽且不被侧栏裁切',
      homeBtns.sameWidthAsRow === true && homeBtns.insidePanel === true && homeBtns.inViewport === true,
      `同宽=${homeBtns.sameWidthAsRow} 在侧栏内=${homeBtns.insidePanel} 在视口内=${homeBtns.inViewport}`)
    check('首页动作区: 箭头随展开态翻转(菜单是向上开的)',
      homeBtns.caretRotated === true, `chev.up = ${homeBtns.caretRotated}`)
    check('首页动作区: 两个导出开关挪进下拉后仍能切换',
      (homeBtns.cbAfter || []).length === 2
      && (homeBtns.cbAfter || []).every((v, i) => v !== (homeBtns.cbBefore || [])[i]),
      `${JSON.stringify(homeBtns.cbBefore)} → ${JSON.stringify(homeBtns.cbAfter)}`)
    check('首页动作区: 替换/预设导出降级为文字链, 且关下拉后不留遮罩',
      (homeBtns.lnk || []).length === 2 && homeBtns.lnk.some((t) => t.includes('替换'))
      && homeBtns.lnk.some((t) => t.includes('预设导出'))
      && homeBtns.menuClosed === true && homeBtns.tipLinks === 0,
      `${(homeBtns.lnk || []).join('、')} · menuClosed=${homeBtns.menuClosed} · tip 里的链接数=${homeBtns.tipLinks}`)

    /* ---------------- 8. 购物车 ---------------- */
    await cdp.eval(`__t.clickText('.hdr .nv', '购物车'); return true`)
    await waitFor(cdp, `__t.count('.ci') > 0`, { label: '购物车条目', timeout: 30000 })
    const cartView = await cdp.eval(`
      return {
        items: __t.count('.ci'),
        groups: __t.count('.group'),
        count: __t.text('.count'),
        btns: __t.count('.head .tv-btn'),
      }
    `)
    check('购物车: 条目已渲染', cartView.items > 0, `${cartView.count} · ${cartView.groups} 个系列分组`)
    await cdp.shot('11-cart')

    const checkout = await cdp.eval(`
      __t.clickText('.head .tv-btn', '结算')
      await new Promise(r => setTimeout(r, 600))
      const inp = document.querySelector('.mask .tv-input')
      return { open: !!inp, name: inp ? inp.value : '', title: __t.text('.mask .head') }
    `)
    check('购物车: 结算弹窗(带默认名)', checkout.open && /\d{4}-\d{2}-\d{2}/.test(checkout.name),
      `默认名=${checkout.name}`)
    await cdp.eval(`document.querySelector('.mask .x').click(); return true`)
    await sleep(400)

    const hist = await cdp.eval(`
      __t.clickText('.head .tv-btn', '历史记录')
      await new Promise(r => setTimeout(r, 1200))
      return { items: __t.count('.hist-item'), title: __t.text('.mask .head') }
    `)
    check('购物车: 结算历史可打开', hist.items > 0, `${hist.items} 条历史记录`)
    await cdp.shot('12-history')
    await cdp.eval(`document.querySelector('.mask .x').click(); return true`)
    await sleep(400)

    /* 侧边抽屉 */
    const drawer = await cdp.eval(`
      __t.clickText('.hdr .nv', '系列')
      await new Promise(r => setTimeout(r, 1500))
      return true
    `)
    check('导航回系列页', !!drawer)

    /* ---------------- 9. 扫描文件夹(文件夹库) ---------------- */
    await cdp.eval(`__t.clickText('.hdr .nv', '扫描'); return true`)
    await waitFor(cdp, `!!document.querySelector('.scan-view .tv-input')`, { label: '扫描页', timeout: 20000 })

    const scanEmpty = await cdp.eval(`return { cards: __t.count('.scan-view .grid.folders .ecard') }`)
    check('文件夹库: 首次进入是空列表', scanEmpty.cards === 0, `${scanEmpty.cards} 张`)

    // 粘贴路径 + 回车 = 添加(会自动扫描并入库)
    await cdp.eval(`
      __t.setInput('.scan-view .tv-input', ${JSON.stringify(SCAN_DIR)})
      await new Promise(r => setTimeout(r, 150))
      __t.pressEnter('.scan-view .tv-input')
      return true
    `)
    await waitFor(cdp, `__t.count('.scan-view .grid.folders .ecard') > 0`, { label: '文件夹卡片', timeout: 60000 })
    const lib = await cdp.eval(`
      return {
        cards: __t.count('.scan-view .grid.folders .ecard'),
        badge: __t.text('.scan-view .grid.folders .ecard .badge'),
        meta: __t.text('.scan-view .grid.folders .ecard .fmeta').replace(/\\s+/g, ' '),
        tools: __t.count('.scan-view .grid.folders .ecard .fbtns button'),
      }
    `)
    check('文件夹库: 添加后出现卡片', lib.cards === 1, `${lib.cards} 张`)
    check('文件夹库: 卡片带「N 种提示词」角标', /种提示词/.test(lib.badge), lib.badge)
    check('文件夹库: 卡片显示含提示词数量', /含提示词/.test(lib.meta), lib.meta)
    check('文件夹库: 卡片带 ✏️/🗑 两个工具按钮', lib.tools === 2, `${lib.tools} 个`)
    await cdp.shot('13a-scan-folders')

    // 重复添加同一个目录 -> 刷新, 不产生第二条
    await cdp.eval(`
      __t.setInput('.scan-view .tv-input', ${JSON.stringify(SCAN_DIR)})
      __t.pressEnter('.scan-view .tv-input')
      return true
    `)
    await sleep(2000)
    const dup = await cdp.eval(`return __t.count('.scan-view .grid.folders .ecard')`)
    check('文件夹库: 重复添加不产生重复卡片', dup === 1, `${dup} 张`)

    // 点开文件夹 -> 二级页面
    await cdp.eval(`__t.click('.scan-view .grid.folders .ecard'); return true`)
    await waitFor(cdp, `__t.count('.scan-view .grid.imgs .card') > 0`, { label: '文件夹内图片', timeout: 60000 })
    const scanRes = await cdp.eval(`
      return {
        cards: __t.count('.scan-view .grid.imgs .card'),
        // 二级页里已经没有 .info / .warn-box —— 见下面两条断言处的说明。
        // 这两种标注都是 .tags.keys .none 这一种元素, 靠文案区分, 所以按文本过滤。
        // ⚠️ 下面整段都在模板字符串里: 注释里**一个反引号都不能写**(连举例也不行)。
        //    反引号会把字符串提前收掉, 后面的散文当 JS 求值 -> TypeError,
        //    而 node --check 是查不出来的(语法仍合法)。2026-09-19 踩过:
        //    整个扫描段一条断言都跑不到, 报告只剩一句莫名其妙的 Runtime 报错。
        //    所以这里写死规矩: 注释里只准用书名号或单引号指代选择器。
        noMeta: [...document.querySelectorAll('.scan-view .grid.imgs .card .tags.keys .none')]
          .filter((e) => e.textContent.includes('无提示词元数据')).length,
        warn: __t.count('.scan-view .warn-box'),
        srcs: __t.count('.scan-view .grid.imgs .card .src'),
        keys: __t.count('.scan-view .grid.imgs .card .tags.keys'),
        chars: __t.count('.scan-view .grid.imgs .card .tags.keys .ch'),
        pager: __t.text('.scan-view .pager-bar .hint').replace(/\\s+/g, ' '),
        back: __t.count('.scan-view .crumb .link'),
      }
    `)
    check('扫描: 5 张图全部列出', scanRes.cards === 5, `${scanRes.cards} 张`)
    /**
     * 这两条原先断言 `.scan-view .info` 里的文案(「共 5 张图片, 其中 4 张含提示词元数据」/
     * 「3 种不同的提示词」/「全部图片共用的基础标签」)。那段文案**只存在于旧 Python 版**
     * (tag_viewer/static/scan.html), 重构时扫描页被改成「文件夹库(两级)」, 汇总信息搬到了
     * **一级的文件夹卡片**上(「N 种提示词」角标 + 「含提示词 4 · 共用 2」, 已由上面
     * 「文件夹库: …」那几条断言覆盖), 二级页里已无 .info / .warn-box 元素
     * —— 对应的 CSS 是重构留下的死代码。所以这两条断言**永远不可能通过**, 属于假红线。
     *
     * 改成断言二级页**真正渲染**的两个标注, 而且正好就是夹具 make_scan_test.py 特意造的场景:
     *   a5.png            纯图无元数据      -> 「(无提示词元数据)」
     *   a1.png / a2.png   提示词完全相同     -> 「(标签与本批其他图相同)」
     * (后者正是当初"同提示词换种子"那个 bug 的检测点, 比原来的汇总文案更贴近真实用途)
     */
    check('扫描: 无元数据的图有明确标注', scanRes.noMeta === 1,
      `${scanRes.noMeta} 张标注「(无提示词元数据)」`)
    /**
     * 这里原先断言卡片上出现「(标签与本批其他图相同)」。那条断言**永远不可能通过**,
     * 属于假红线 —— 2026-09-19 追查后确认:
     *   该标注的触发条件是「这张图的**所有**标签都是整批共用标签」
     *   (scan.js: 出现在 ≥ max(2, round(含提示词张数 × 2/3)) 张图里)。
     *   夹具是 a1/a2=P1、a3=P2、a4=P3、a5=无元数据 -> 含提示词 4 张 -> 阈值 3,
     *   而 P1 只出现 2 次, 够不到阈值; 于是 a1/a2 各自还剩"独有"标签,
     *   卡片走的是 key_tags 分支, 这条标注不可能渲染出来。
     *   (上一轮加这条断言时, 扫描段因为一个模板字符串的 bug 从来没跑到过, 所以没暴露。)
     *
     * 「同提示词换种子」这件事本身仍然被测到了, 而且测在更该测的地方 ——
     * **一级文件夹卡片**的「N 种提示词」角标: 4 张含提示词却只报 3 种,
     * 正好证明 a1/a2 被识别为同一个提示词(上面「文件夹库: 卡片带「N 种提示词」角标」已断言)。
     * 这里改成断言卡片真的走了 key_tags 分支(角色标签单独着色), 这是扫描页真正的展示逻辑。
     */
    check('扫描: 卡片走 key_tags 分支(角色标签单独着色)', scanRes.chars >= 1, `${scanRes.chars} 个角色高亮`)
    check('扫描: 来源角标已渲染', scanRes.srcs >= 4, `${scanRes.srcs} 个角标`)
    check('扫描: key_tags 展示模式生效', scanRes.keys === 5, `${scanRes.keys} 张卡片`)
    check('扫描: 二级页有分页条与面包屑', /共 5 张/.test(scanRes.pager) && scanRes.back >= 1, `${scanRes.pager} · 面包屑 ${scanRes.back}`)
    await cdp.shot('13b-scan-images')

    /* ---------------- 9b. 大图预览的交互(滚轮 / 键盘 / 点空白) ---------------- */
    const ext = await cdp.eval(`
      const card = [...document.querySelectorAll('.scan-view .grid.imgs .card')].find(c => c.textContent.includes('hoshino'))
      ;(card || document.querySelector('.scan-view .grid.imgs .card')).click()
      await new Promise(r => setTimeout(r, 2500))
      return {
        open: !!document.querySelector('.lightbox'),
        badge: __t.text('.lightbox .badge'),
        tags: __t.count('.lightbox .lb-tags .pill'),
        pos: __t.text('.lightbox .lb-pos').replace(/\\s+/g, ' '),
        navs: __t.count('.lightbox .lb-nav'),
        banNote: __t.count('.lightbox .badge.ban') + __t.count('.lightbox .badge.dim'),
        path: __t.text('.lightbox .lb-path'),
      }
    `)
    check('扫描: 库外图可预览', ext.open && ext.tags > 0, `badge=${ext.badge} · ${ext.tags} 标签`)
    check('光箱: 显示「第 n / 共 m 张」', /\/\s*5/.test(ext.pos), ext.pos)
    check('光箱: 左右翻页按钮已渲染', ext.navs === 2, `${ext.navs} 个`)
    check('光箱: ban 命中状态明确可见', ext.banNote >= 1, `${ext.banNote} 条提示`)
    await cdp.shot('13c-scan-lightbox')

    // 滚轮切下一张
    const wheelRes = await cdp.eval(`
      const before = __t.text('.lightbox .lb-path')
      document.querySelector('.lb-img-wrap')
        .dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 1400))
      return {
        before, after: __t.text('.lightbox .lb-path'),
        pos: __t.text('.lightbox .lb-pos').replace(/\\s+/g, ' '),
        still: !!document.querySelector('.lightbox'),
      }
    `)
    check('光箱: 滚轮切到下一张', wheelRes.still && wheelRes.before !== wheelRes.after && /2\s*\/\s*5/.test(wheelRes.pos), `${wheelRes.pos}`)

    // 滚轮往回
    const back = await cdp.eval(`
      const before = __t.text('.lightbox .lb-path')
      document.querySelector('.lb-img-wrap')
        .dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 1400))
      return { before, after: __t.text('.lightbox .lb-path'), pos: __t.text('.lightbox .lb-pos').replace(/\\s+/g, ' ') }
    `)
    check('光箱: 滚轮能切回上一张', back.before !== back.after && /1\s*\/\s*5/.test(back.pos), back.pos)

    // 方向键
    const keyRes = await cdp.eval(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise(r => setTimeout(r, 1300))
      return { pos: __t.text('.lightbox .lb-pos').replace(/\\s+/g, ' ') }
    `)
    check('光箱: 方向键 → 也能翻页', /2\s*\/\s*5/.test(keyRes.pos), keyRes.pos)

    // 点侧栏不该关闭
    const sideRes = await cdp.eval(`
      document.querySelector('.lb-side').click()
      await new Promise(r => setTimeout(r, 300))
      return { open: !!document.querySelector('.lightbox') }
    `)
    check('光箱: 点侧栏不会关闭(要点标签)', sideRes.open === true, '')

    // 点图片本体也不该关闭(2026-09-19 反馈: 点大图特别容易误关, 与侧栏统一)。
    // 必须带真实坐标: 光箱按 clientX/Y 判断落在图片内还是黑边,
    // element.click() 的坐标是 (0,0), 会被当成黑边 —— 那是下一条的事。
    const imgRes = await cdp.eval(`
      const img = document.querySelector('.lb-img-wrap img')
      const r = img.getBoundingClientRect()
      img.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }))
      await new Promise(r => setTimeout(r, 300))
      return { open: !!document.querySelector('.lightbox') }
    `)
    check('光箱: 点图片本体不会关闭(与侧栏一致)', imgRes.open === true, '')

    /* 高亮框(2026-09-19 反馈: 关掉光箱后记不住看到哪张了):
     * 高亮要跟随光箱翻页实时移动, 此时光箱停在第 2 张, 网格里应恰好一张带
     * .last-viewed, 且就是当前这张(扫描卡片的 .foot 是文件名)。 */
    const curBase = path.basename(await cdp.eval(`return __t.text('.lightbox .lb-path')`))
    const hl = await cdp.eval(`
      const cards = [...document.querySelectorAll('.grid.imgs .card.last-viewed')]
      return { n: cards.length, foot: cards[0]?.querySelector('.foot')?.textContent || '' }
    `)
    check('光箱: 网格高亮恰好一张(跟随翻页实时移动)', hl.n === 1, `${hl.n} 张`)
    check('光箱: 高亮的就是当前这张', hl.foot === curBase, `${hl.foot} · 期望 ${curBase}`)

    /* 颜色 + 呼吸(2026-09-20 用户反馈两轮: "只有浅浅一层边框不显眼, 加点呼吸特效",
     * 再"绿色还是有点不明显" -> 最终改红色)。
     * 这两条钉的都不是"好不好看":
     *   · 颜色 —— 抠 computed style 里的 rgb 三元组, 要求红通道压倒性领先。
     *     这条能抓住"又被改回绿/蓝"(那时 r < g, 直接红), 是颜色这件事的硬约束。
     *   · 呼吸 —— 钉"动画真的挂上了": 样式一旦被写回静态 box-shadow, 上面两条
     *     照旧全过(框还在, 位置也对), 只有这条会红。
     * 系统开了"减少动态效果"时 CSS 会主动关掉动画(见 TvImageCard 的 media query),
     * 那种情况放行, 否则这个套件会在开了该选项的机器上假红。
     * 注意动画名带 Vue scoped 的哈希后缀(tv-lastviewed-breathe-xxxxxxxx), 所以用 includes。 */
    const breathe = await cdp.eval(`
      const el = document.querySelector('.grid.imgs .card.last-viewed')
      const cs = el ? getComputedStyle(el) : null
      const anims = (el && el.getAnimations ? el.getAnimations() : [])
        .map((a) => a.animationName || '')
        .filter((n) => n.includes('lastviewed'))
      // 从 computed 的 border-color / box-shadow 里抠出所有 rgb 三元组
      const rgb = (s) => (String(s).match(/rgba?\\([^)]+\\)/g) || [])
        .map((c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number))
      return {
        n: anims.length,
        name: anims[0] || '',
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        border: cs ? cs.borderTopColor : '',
        shadow: cs ? cs.boxShadow : '',
        colors: cs ? [...rgb(cs.borderTopColor), ...rgb(cs.boxShadow)] : [],
      }
    `)
    const isRed = (c) => Array.isArray(c) && c.length >= 3 && c[0] > c[1] + 30 && c[0] > c[2] + 30
    check('光箱: 高亮是红色(描边与光晕都不是绿框)',
      breathe.colors.length > 0 && breathe.colors.every(isRed),
      `${breathe.border} · ${String(breathe.shadow).slice(0, 70)}`)
    check('光箱: 高亮框挂了呼吸动画(不是一圈静态描边)',
      breathe.n > 0 || breathe.reduced,
      breathe.reduced ? '(系统要求减少动态效果, 放行)' : `${breathe.n} 个 · ${breathe.name}`)

    // 黑边(letterbox)也算关闭区(2026-09-19 追加: 可关区域太小, 翻页按钮一带都要能关)。
    // 点 img 元素盒子的左上角 —— contain 的可见内容居中, 角落必然是黑边。
    const letterRes = await cdp.eval(`
      const img = document.querySelector('.lb-img-wrap img')
      const r = img.getBoundingClientRect()
      img.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2,
      }))
      await new Promise(r => setTimeout(r, 300))
      return { open: !!document.querySelector('.lightbox') }
    `)
    check('光箱: 点图片黑边(letterbox)关闭', letterRes.open === false, '')

    // 关掉后红框仍在; 点红框那张应能直接回到它
    const re = await cdp.eval(`
      const n = document.querySelectorAll('.grid.imgs .card.last-viewed').length
      document.querySelector('.grid.imgs .card.last-viewed').click()
      await new Promise(r => setTimeout(r, 1200))
      return { n, open: !!document.querySelector('.lightbox'), path: __t.text('.lightbox .lb-path') }
    `)
    check('光箱: 关掉后高亮仍在网格上(找回位置用)', re.n === 1, `${re.n} 张`)
    check('光箱: 点高亮那张直接回到它', re.open && path.basename(re.path) === curBase,
      `→ ${path.basename(re.path)} · 期望 ${curBase}`)

    // 暗色空白(遮罩本体)也是关闭区
    const blankRes = await cdp.eval(`
      document.querySelector('.lightbox').click()
      await new Promise(r => setTimeout(r, 400))
      return { open: !!document.querySelector('.lightbox') }
    `)
    check('光箱: 点暗色空白处关闭', blankRes.open === false, '')

    // lastPath 持久化: 关闭后应已写入 localStorage
    const stored = await cdp.eval(`return localStorage.getItem('tv_lb_last') || ''`)
    check('光箱: lastPath 已持久化到 localStorage', stored.endsWith(curBase),
      stored ? path.basename(stored) : '(空)')

    /* 持久化恢复(重启场景): 重载页面模拟重启 —— lastPath 要从 localStorage 恢复,
     * 重新打开这个文件夹时绿框直接就在(卡片挂载时还会自动滚过去一次)。
     * 注意重载会重建执行上下文, __t 助手要重新注入(与套件开头同一套路)。 */
    try { await cdp.eval(`setTimeout(() => location.reload(), 20); return true`) } catch { /* 上下文即将销毁 */ }
    await sleep(900)
    await waitFor(cdp, `!!document.querySelector('#app .hdr')`, { label: '重载后顶栏出现', timeout: 60000 })
    await cdp.eval(HELPERS)
    await waitFor(cdp, `!!document.querySelector('.scan-view')`, { label: '重载后回到扫描页', timeout: 60000 })
    await cdp.eval(`__t.click('.scan-view .grid.folders .ecard'); return true`)
    await waitFor(cdp, `__t.count('.scan-view .grid.imgs .card') > 0`, { label: '重载后打开文件夹', timeout: 60000 })
    const bootHl = await cdp.eval(`return { n: document.querySelectorAll('.grid.imgs .card.last-viewed').length }`)
    check('高亮: 重启(重载)后绿框从 localStorage 恢复', bootHl.n === 1, `${bootHl.n} 张`)

    /* ---------------- 9e. 扫描页的「按标签筛选」(2026-09-20) ----------------
     * 扫描出来的图是**库外图片**(标签从 PNG 元数据现场解析), 所以:
     *   · 筛选只能在前端做 —— 条件就是"这个夹里出现过的标签"
     *   · 搜索框的补全也只在**本地标签池**里找(拿标签名去查标签库补不出扫描夹特有的标签)
     * 夹具 test-fixtures/make_scan_test.py:
     *   a1/a2 = hoshino_(blue_archive) · a3 = arona_(blue_archive) · a4 = shiroko_(blue_archive)
     *   共用 halo / 1girl · a5 无元数据 -> 一个标签都没有, 永远筛不出来
     * 于是: hoshino -> 2 张, halo -> 3 张, hoshino + arona -> 0 张(多个词是 AND)。 */
    const filt = await cdp.eval(`
      const inp = document.querySelector('.scan-view .pager-bar .tag-filter input')
      if (!inp) return { err: '筛选框没渲染出来' }
      const setV = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      const type = async (v) => {
        setV.call(inp, v)
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r => setTimeout(r, 800))
      }
      const read = () => ({
        n: __t.count('.scan-view .grid.imgs .card'),
        hint: __t.text('.scan-view .pager-bar .hint').replace(/\\s+/g, ' '),
        empty: __t.count('.scan-view .tv-state.empty'),
      })
      await type('hosh')
      const drop = [...document.querySelectorAll('.scan-view .pager-bar .tag-filter .drop .item')]
        .map((e) => e.textContent)
      await type('hoshino')
      const one = read()
      // 带空格的输入: 筛选能出 4 张, 补全**也必须**给出候选 —— 补全若把整串当一个词,
      // 就会出现"一边筛出 4 张、一边说没有匹配的标签"(2026-09-20 截图里抓到的自相矛盾)
      await type('blue archive')
      const drop2 = [...document.querySelectorAll('.scan-view .pager-bar .tag-filter .drop .item')]
        .map((e) => e.textContent)
      const space = read()
      await type('hoshino arona')
      const and = read()
      await type('halo')
      const two = read()
      await type('')
      const cleared = read()
      return { err: '', drop, drop2, one, space, and, two, cleared }
    `)
    check('扫描: 标签筛选框已渲染', !filt.err, filt.err || '')
    check('扫描: 筛选 hoshino 只剩 2 张', filt.one?.n === 2, `${filt.one?.n} 张`)
    check('扫描: 筛选后提示写明匹配数(不再是"已加载 n / 共 m")',
      /筛选出\s*2\s*\/\s*共\s*5\s*张/.test(filt.one?.hint || ''), filt.one?.hint)
    check('扫描: 补全项来自本夹标签池(不查标签库)',
      (filt.drop || []).some((t) => t.includes('hoshino')), `${(filt.drop || []).length} 项: ${(filt.drop || [])[0] || ''}`)
    check('扫描: 带空格的词补全也有候选(与筛选同一套语义, 否则一边有结果一边说没有)',
      (filt.drop2 || []).length > 0, `${(filt.drop2 || []).length} 项: ${(filt.drop2 || [])[0] || ''}`)
    // 顺带验证"筛选"本身也认带空格的写法(它的分词与补全一致, 都是 AND)
    check('扫描: 用空格写法也能筛出 4 张(blue archive)',
      /筛选出\s*4\s*\/\s*共\s*5\s*张/.test(filt.space?.hint || ''), filt.space?.hint)
    check('扫描: 多词是 AND(没交集时给空态)',
      filt.and?.n === 0 && filt.and?.empty === 1, `${filt.and?.n} 张 · ${filt.and?.empty} 个空态`)
    check('扫描: 共用标签 halo 命中 3 张(含没元数据那张之外的a3)',
      filt.two?.n === 3, `${filt.two?.n} 张`)
    check('扫描: 清空筛选后恢复全量', filt.cleared?.n === 5, `${filt.cleared?.n} 张`)
    await cdp.shot('13d-scan-filter')

    /* ---------------- 9f. 筛选框的搜索历史(2026-09-20 需求) ----------------
     * "筛选框还是记住历史吧, 不过要和公用的区分开":
     *   · 扫描页筛选是**即时**的, 没有搜索按钮 —— 所以只能认"输入停稳了"
     *     (TvTagSuggestInput 的 remember: 停 1.2s 自动记一条)
     *   · 历史存**独立的键** tv_search_hist_scan, 首页那份 tv_search_hist 不能被打脏
     * 两条都要钉: 只测"记得住"会漏掉"串了键"(两边共用一个 key 时前者照样通过),
     * 只测"键不同"会漏掉"根本没记"(空数组也不相等)。
     * 夹具 5 张图: hoshino -> 2 张。 */
    const scanHist = await cdp.eval(`
      const inp = document.querySelector('.scan-view .pager-bar .tag-filter input')
      if (!inp) return { err: '筛选框没渲染出来' }
      const setV = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setV.call(inp, 'hoshino')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 1700))   // > remember 的 1.2s
      const scanRaw = localStorage.getItem('tv_search_hist_scan')
      const sharedRaw = localStorage.getItem('tv_search_hist')
      const n = __t.count('.scan-view .grid.imgs .card')
      // 清空 -> 聚焦: 空输入时下拉应该切到历史(这正是"记住历史"的可见效果)
      setV.call(inp, '')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.focus()
      await new Promise(r => setTimeout(r, 400))
      const head = __t.text('.scan-view .pager-bar .tag-filter .drop .h-head')
      const items = [...document.querySelectorAll('.scan-view .pager-bar .tag-filter .drop .item.h')]
        .map((e) => e.textContent.replace(/[🔍✕]/g, '').trim())
      // 点第一条历史 -> 应该直接把筛选条件填回去(2 张)
      const first = document.querySelector('.scan-view .pager-bar .tag-filter .drop .item.h')
      if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 700))
      return {
        err: '', n, head, items,
        scan: scanRaw ? JSON.parse(scanRaw) : null,
        shared: sharedRaw ? JSON.parse(sharedRaw) : null,
        value: inp.value,
        applied: __t.count('.scan-view .grid.imgs .card'),
      }
    `)
    check('扫描筛选历史: 停稳后自动记进独立键(tv_search_hist_scan)',
      Array.isArray(scanHist.scan) && scanHist.scan.includes('hoshino'),
      scanHist.err || JSON.stringify(scanHist.scan))
    check('扫描筛选历史: 没有写进首页那份公用历史(tv_search_hist)',
      Array.isArray(scanHist.shared) && !scanHist.shared.includes('hoshino'),
      JSON.stringify(scanHist.shared))
    check('扫描筛选历史: 空输入聚焦时下拉列出历史(并标明是扫描页那一份)',
      (scanHist.items || []).includes('hoshino') && /扫描页/.test(scanHist.head || ''),
      `${scanHist.head} · ${JSON.stringify(scanHist.items)}`)
    check('扫描筛选历史: 点历史条目直接填回筛选条件',
      scanHist.value === 'hoshino' && scanHist.applied === 2, `值=${scanHist.value} · ${scanHist.applied} 张`)

    // 复原: 清掉筛选(后面 keep-alive 那段要看的是"切走再切回网格还在")
    await cdp.eval(`
      const inp = document.querySelector('.scan-view .pager-bar .tag-filter input')
      const setV = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setV.call(inp, '')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.blur()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)

    /* keep-alive(2026-09-19 反馈: 扫描页切走再切回, 只剩文件夹列表):
     * ScanView 已加入 App.vue 的 KeepAlive 白名单 —— 切到看板再切回来,
     * 图片网格要原样还在(不再是文件夹列表)。 */
    await cdp.eval(`__t.clickText('.hdr .nv', '看板'); return true`)
    await waitFor(cdp, `!!document.querySelector('.home')`, { label: '切到看板', timeout: 20000 })
    await cdp.eval(`__t.clickText('.hdr .nv', '扫描'); return true`)
    await waitFor(cdp, `!!document.querySelector('.scan-view')`, { label: '切回扫描页', timeout: 20000 })
    const ka = await cdp.eval(`
      return {
        cards: __t.count('.scan-view .grid.imgs .card'),
        crumb: __t.text('.scan-view .crumb .now'),
      }
    `)
    check('扫描页: 切走再切回, 图片网格还在(keep-alive)', ka.cards > 0 && !!ka.crumb,
      `${ka.cards} 张 · 位置: ${ka.crumb}`)

    /* ---------------- 9c. 删掉当前图后光箱要自动前进(回归) ----------------
     * 回归点(2026-09-19 用户反馈): 右键菜单的「🗑 删除到回收站 / 📤 移动到别的文件夹」
     * 过去只广播 'tv:trashed' / 'tv:moved', 没有任何人推进光箱 —— 于是图已经被搬走,
     * 光箱还停在那张图上, 表现为一个空白占位。
     * 现在推进统一由 useLightboxStore 订阅这两个事件完成; 因此 Del 键那条路也改成
     * 只发删除请求、不再自己调 removeCurrent()(两处都做会一次跳两张)。
     *
     * 这里刻意走**真实删除**: Del -> 确认弹窗 -> 真进回收站 -> 真广播事件, 并且断言
     * 磁盘上那张图确实没了 —— 免得用假事件测出一个"看起来是绿的"结果。
     * 夹具由 harness 每轮重新覆盖, 删掉一张不影响下一轮。
     *
     * ⚠️ 故意删的是**第 2 张(a2)**而不是第 1 张: 文件夹封面取的是"第一张有标签的图"
     * (folders.js pickCover), 也就是 a1。删掉 a1 会让一级卡片的封面缩略图变成 404
     * (封面只在还没有时才补, 删除不会刷新它) —— 那是个**真实但很小**的遗留问题,
     * 与本段要测的东西无关, 却会把「运行期无 JS 异常」这条总闸一直顶红, 反而掩盖真问题。
     * 这里绕开它, 并在报告里单独记一笔。
     */
    const order = await cdp.eval(
      `return [...document.querySelectorAll('.scan-view .grid.imgs .card .foot')].map(e => e.title)`,
    )
    check('光箱: 能取到网格的完整图片顺序', order.length === 5 && order.every(Boolean), `${order.length} 张`)

    await cdp.eval(`
      __t.click('.scan-view .grid.imgs .card', 1)
      await new Promise(r => setTimeout(r, 1800))
      return true
    `)
    const lbo = await cdp.eval(
      `return { open: !!document.querySelector('.lightbox'), path: __t.text('.lightbox .lb-path') }`,
    )
    check('光箱: 打开的是第 2 张', lbo.open && lbo.path === order[1], path.basename(lbo.path || ''))

    // 收藏当前这张(a2) —— 9d 要验证「删除后收藏保留」。这里只点收藏, 删除在下面进行。
    await cdp.eval(`
      document.querySelector('.lb-side .tv-btn[title="收藏这张图"]').click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    const favA2 = await cdp.eval(
      `return !!document.querySelector('.lb-side .tv-btn[title="取消收藏"]')`,
    )
    check('光箱: 点 ☆ 收藏成功(按钮翻转为已收藏态)', favA2, '')

    // 真删当前图: Del -> 确认弹窗(trashAsk 默认开, localStorage 每轮清空) -> 点「删除」
    const delC = await cdp.eval(`
      window.__tvProbe = []
      window.addEventListener('tv:trashed', (e) => window.__tvProbe.push((e.detail && e.detail.paths) || null))
      /**
       * 图片请求记录器 —— 抓「删除之后还有谁在请求那张已经进回收站的图」。
       * 只挂 HTMLImageElement.prototype 的 src setter 就够了: 光箱主图(Vue 写 .src)
       * 与 preheat(new Image().src = ...) 都走它, 而且是**请求真的发出去**的那一刻,
       * 比去轮询 UI 状态可靠(幽灵请求只存在几十毫秒, 轮询抓不到)。
       * 记 stack 是为了红的时候能直接看出是谁发的。
       */
      window.__imgReq = []
      try {
        const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          get() { return d.get.call(this) },
          set(v) {
            try { window.__imgReq.push({ v: String(v), stack: String(new Error().stack || '') }) } catch {}
            return d.set.call(this, v)
          },
        })
      } catch (e) { window.__imgReq.push({ v: 'patch-fail: ' + e.message, stack: '' }) }
      // 记下"即将被删掉的那张"的文件名 —— 收尾处用它算幽灵请求总账(记录器一直活到那时)
      window.__delBase = (__t.text('.lightbox .lb-path') || '').split(/[\\\\/]/).pop()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      await new Promise(r => setTimeout(r, 900))
      const modal = __t.count('.mask .foot .tv-btn') >= 2
      if (modal) __t.clickText('.mask .foot .tv-btn', '删除')
      // trashItem 在 D 盘是"先搬进回收站、再抛 aborted", 耗时波动大 ——
      // 死等 800ms 会偶发抓空 toast(实测踩过一次), 改成轮询等它出现(最多 6s)。
      // 只认删除相关的 toast —— 上一步刚点过收藏, 「★ 已收藏」可能还在飞。
      let toast = null
      for (let i = 0; i < 40 && !toast; i++) {
        await new Promise(r => setTimeout(r, 150))
        toast = [...document.querySelectorAll('.toast')]
          .find((t) => /回收站|删除/.test(t.textContent || '')) || null
      }
      const toastText = toast ? toast.textContent.trim() : ''
      const toastTone = toast ? toast.className : ''
      await new Promise(r => setTimeout(r, 2000))
      return {
        modal, toastText, toastTone,
        probe: window.__tvProbe,
        imgReq: (window.__imgReq || []).slice(-40),
        path: __t.text('.lightbox .lb-path'),
        open: !!document.querySelector('.lightbox'),
        pos: __t.text('.lightbox .lb-pos').replace(/\\s+/g, ' '),
        cards: __t.count('.scan-view .grid.imgs .card'),
      }
    `)
    check('光箱: Del 会弹删除确认框(默认每次询问)', delC.modal === true, '')
    /**
     * 这条是 2026-09-19 挖出来的第二个根因, 必须钉住:
     * 非系统盘(D、E、F 盘)上 shell.trashItem 会在文件**已经进回收站之后**抛
     * "Operation was aborted"(C: 盘不抛)。以前 ipc.js 把它当失败 -> trashed 为空 ->
     * 既弹「删除失败(文件可能被占用)」又**不广播 tv:trashed**, 于是光箱停在一张
     * 已经删掉的图上 = 用户看到的那个空白占位。现在按"原位置是否还在"判定。
     * 所以这里同时断言: 提示是成功态, 且事件真的广播了当前这张。
     */
    check('光箱: 删除报的是成功(不是「删除失败」误报)', delC.toastTone.includes('t-ok'),
      `${delC.toastTone} · ${delC.toastText}`)
    check('光箱: 删除确实广播了 tv:trashed(且是当前这张)',
      Array.isArray(delC.probe) && delC.probe.length === 1 && delC.probe[0] && delC.probe[0][0] === order[1],
      JSON.stringify(delC.probe))
    check('光箱: 删除后自动切到下一张(不留占位)', delC.open && delC.path === order[2],
      `→ ${path.basename(delC.path || '')} · 期望 ${path.basename(order[2])}`)
    check('光箱: 位置指示跟着收缩到 2 / 4', /2\s*\/\s*4/.test(delC.pos), delC.pos)
    /**
     * 删除之后不许再对那张图发请求 —— 它已经进回收站了, 任何一次请求都是一条 404。
     *
     * 这条为什么必须专门钉: 前面那条「位置指示收缩到 2 / 4」**抓不到**这个 bug ——
     * 幽灵请求只活在几十毫秒的窗口里(视图先把刷新中的旧快照推回光箱、随后又推了新的一份),
     * 等断言跑到时列表已经恢复正常。之前只能靠全局的「运行期无 JS 异常」兜住,
     * 但那条的失败信息只有一句 404, 看不出是谁发的。
     * 现在直接观测"请求真的发出去"这个动作, 并在详情里带上调用栈。
     */
    const delBase = path.basename(order[1])
    const ghosts = (delC.imgReq || []).filter((r) => r.v.includes(delBase) && !/^patch-fail/.test(r.v))
    check('光箱: 删除后没有再请求那张已进回收站的图', ghosts.length === 0,
      ghosts.length ? `${ghosts.length} 条 · ${ghosts[0].stack.split('\n').slice(1, 4).join(' <- ')}` : '0 条')
    check('光箱: 被删的图同时从网格移除', delC.cards === 4, `${delC.cards} 张`)
    check('光箱: 磁盘上确实已删除(证明不是假事件)', !!order[1] && !fs.existsSync(order[1]), path.basename(order[1]))

    /* 反向对照 —— 广播「另一张图没了」, 光箱必须**原地不动**。
     * 少了这条, 一个"见到事件就往前跳"的错误实现也能让上面全绿。 */
    const nc = await cdp.eval(`
      const before = __t.text('.lightbox .lb-path')
      window.dispatchEvent(new CustomEvent('tv:trashed', {
        detail: { paths: [${JSON.stringify(order[4])}] },
      }))
      await new Promise(r => setTimeout(r, 1000))
      return {
        before,
        after: __t.text('.lightbox .lb-path'),
        open: !!document.querySelector('.lightbox'),
        cards: __t.count('.scan-view .grid.imgs .card'),
      }
    `)
    /* 反向对照只问一件事: 广播了「另一张图没了」之后, 光箱有没有原地不动。
     * 不在这里重复断言「当前是第几张」—— 那是上一条断言(order[2])的职责,
     * 混进来只会让「修复被关掉」时多红一条、把真实信号淹掉。 */
    check('光箱: 别的图没了时光箱原地不动(反向对照)',
      nc.open && nc.before === nc.after, path.basename(nc.after || ''))
    check('光箱: 反向对照里网格该少一张', nc.cards === 3, `${nc.cards} 张`)

    /* 用户反馈的另一半:「移动到别的文件夹」也要自动切下一张。
     *
     * ⚠️ 这条以前是**手动 dispatchEvent('tv:moved')** 的 —— 只验了消费端。
     * 2026-09-19 用户实测反馈"移动后还是不动", 才发现这个缺口: 生产端
     * (右键菜单 -> 主进程搬文件 -> 返回 action='moved' -> useImageCtxMenu 广播) 完全没覆盖。
     * 现在改成**走真实链路**: 在光箱图片上派发真的 contextmenu 事件, 触发
     * useImageCtxMenu.open -> api.ctxMenu(IPC) -> 主进程真的搬文件 -> 广播 tv:moved。
     * 原生菜单弹窗 CDP 点不到, 所以主进程侧由 TV_E2E_CTX_MOVE 跳过 popup
     * (只替换"点了哪一项", 后面全是真实代码) —— 见 electron/ipc.js 的注释。
     * 断言同时看两边: 光箱前进了 + 磁盘上文件真的从扫描夹搬到了目标目录。 */
    const mv = await cdp.eval(`
      window.__tvProbe = []
      window.addEventListener('tv:moved', (e) => window.__tvProbe.push((e.detail && e.detail.paths) || null))
      const before = __t.text('.lightbox .lb-path')
      const el = document.querySelector('.lightbox .lb-img-wrap')
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      // 真实搬文件 + IPC 往返, 用轮询等结果, 不写死 sleep(时序一抖就假红)
      let after = before
      const t0 = Date.now()
      while (Date.now() - t0 < 10000) {
        await new Promise(r => setTimeout(r, 200))
        after = __t.text('.lightbox .lb-path')
        if (after !== before) break
      }
      return {
        before,
        after,
        probe: window.__tvProbe,
        open: !!document.querySelector('.lightbox'),
        cards: __t.count('.scan-view .grid.imgs .card'),
      }
    `)
    check('光箱: 右键「移动到」后自动切下一张(真实菜单链路)', mv.open && mv.after === order[3],
      `→ ${path.basename(mv.after || '')} · 期望 ${path.basename(order[3])}`)
    check('光箱: 移动真的广播了 tv:moved(且是搬走的那张)',
      Array.isArray(mv.probe) && mv.probe.length === 1 && mv.probe[0] && mv.probe[0][0] === order[2],
      JSON.stringify(mv.probe))
    check('光箱: 移动是主进程真搬了文件(原位置已空)', !!order[2] && !fs.existsSync(order[2]),
      path.basename(order[2]))
    check('光箱: 目标目录里出现了这张图',
      !!order[2] && fs.existsSync(path.join(MOVED_DIR, path.basename(order[2]))),
      `期望 ${path.basename(order[2])}`)
    check('光箱: 移动后网格也少一张', mv.cards === 2, `${mv.cards} 张`)

    // 关掉光箱, 交还干净状态(后面还有别的视图要断言, 光箱是全屏遮罩)
    await cdp.eval(`
      document.querySelector('.lightbox .lb-close').click()
      await new Promise(r => setTimeout(r, 500))
      return true
    `)

    // 返回文件夹列表
    const backList = await cdp.eval(`
      __t.clickText('.scan-view .crumb .link', '全部文件夹')
      await new Promise(r => setTimeout(r, 600))
      return { cards: __t.count('.scan-view .grid.folders .ecard') }
    `)
    check('文件夹库: 可从二级返回列表', backList.cards === 1, `${backList.cards} 张`)

    /* ---------------- 9d. 收藏页(独立视图, 2026-09-19 新增) ----------------
     * 看板「只看收藏」只查**标签库**记录的精确路径 —— 扫描图不在库里, 用户收藏了
     * 也永远刷不出来(反馈原话: "在扫描里收藏的图不能显示")。现在收藏收拢到
     * 独立的 /favs 视图, 不依赖库。这段覆盖:
     *   1) 收藏记录结构化: {path, name, tags快照, at}; 扫描图的标签存快照
     *   2) 删除(进回收站)后记录**保留**(9c 删掉的 a2, 用户拍板不清)
     *   3) 应用外移动(直接动磁盘, 模拟资源管理器挪图) -> 收藏页打开时
     *      按文件名在已知目录里找回并改写路径
     *   4) 找不回的标灰「文件已不在」; 失效卡片不请求缩略图(不制造 404)
     * 目的地选 DATA_DIR: 它是 fav:resolve 的搜索根之一(数据目录), 且扫描页
     * 默认递归枚举 —— 挪进扫描夹子目录会污染下一轮的「共 5 张」断言。
     */
    await cdp.eval(`__t.click('.scan-view .grid.folders .ecard'); return true`)
    await waitFor(cdp, `__t.count('.scan-view .grid.imgs .card') > 0`, { label: '9d 再进文件夹', timeout: 60000 })
    await cdp.eval(`
      __t.click('.scan-view .grid.imgs .card', 0)
      await new Promise(r => setTimeout(r, 1800))
      document.querySelector('.lb-side .tv-btn[title="收藏这张图"]').click()
      await new Promise(r => setTimeout(r, 400))
      document.querySelector('.lightbox .lb-close').click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)

    const recsBefore = await cdp.eval(`return JSON.parse(localStorage.getItem('tv_favs') || '[]')`)
    check('收藏: 记录已结构化(path/name/tags/at), 共 2 条',
      Array.isArray(recsBefore) && recsBefore.length === 2
        && recsBefore.every((r) => r.path && r.name && Array.isArray(r.tags) && typeof r.at === 'number'),
      JSON.stringify(recsBefore.map((r) => r.name)))
    const a1Rec = recsBefore.find((r) => r.name === 'a1.png')
    check('收藏: a1 的标签快照存进了记录(扫描图不靠标签库)',
      Array.isArray(a1Rec?.tags) && a1Rec.tags.length > 0, `${a1Rec?.tags?.length || 0} 个标签`)
    const a2Kept = recsBefore.find((r) => r.name === 'a2.png')
    check('收藏: 删除(进回收站)后记录保留, 不再被摘掉', !!a2Kept, a2Kept?.path || '(无)')

    // 应用外移动 a1: 直接 rename, 不经过应用(与用户在资源管理器里挪图等价)
    const movedOut = path.join(DATA_DIR, 'a1.png')
    fs.renameSync(a1Rec.path, movedOut)
    check('收藏: 应用外移动已就位(原路径已空)', !fs.existsSync(a1Rec.path), path.basename(a1Rec.path))

    await cdp.eval(`__t.clickText('.hdr .nv', '收藏'); return true`)
    await waitFor(cdp, `!!document.querySelector('.favs-view')`, { label: '收藏页', timeout: 20000 })
    // 卡片在找回跑完才渲染(防止对失效路径发缩略图请求), 等它出图
    await waitFor(cdp, `__t.count('.favs-view .grid .card') > 0`, { label: '收藏卡片(找回完成后渲染)', timeout: 30000 })
    const favsRes = await cdp.eval(`
      const cards = [...document.querySelectorAll('.favs-view .grid .card')]
      return {
        n: cards.length,
        gone: cards.filter(c => c.querySelector('.gone')).length,
        names: cards.map(c => c.querySelector('.foot')?.textContent || ''),
      }
    `)
    check('收藏: 页面显示全部 2 条收藏(删除的也在)', favsRes.n === 2,
      `${favsRes.n} 张 · ${favsRes.names.join(', ')}`)
    check('收藏: 已删除的 a2 标灰「文件已不在」', favsRes.gone === 1, `${favsRes.gone} 张标灰`)
    const recsAfter = await cdp.eval(`return JSON.parse(localStorage.getItem('tv_favs') || '[]')`)
    const a1After = recsAfter.find((r) => r.name === 'a1.png')
    check('收藏: a1 被按文件名找回, 记录已改写到新位置',
      !!a1After && a1After.path === movedOut, a1After?.path || '(无)')
    check('收藏: 找回后标签快照仍在', Array.isArray(a1After?.tags) && a1After.tags.length > 0,
      `${a1After?.tags?.length || 0} 个`)

    // 从收藏页点开光箱(收尾: 光箱翻页列表 = 收藏结果)
    await cdp.eval(`
      __t.click('.favs-view .grid .card', 0)
      await new Promise(r => setTimeout(r, 1500))
      return true
    `)
    const favLb = await cdp.eval(
      `return { open: !!document.querySelector('.lightbox'), pos: __t.text('.lightbox .lb-pos') }`,
    )
    check('收藏: 点击卡片能打开光箱', favLb.open, favLb.pos)
    await cdp.eval(`
      document.querySelector('.lightbox .lb-close').click()
      await new Promise(r => setTimeout(r, 300))
      return true
    `)

    /* ---------------- 10. 详情页路由 ---------------- */
    // 详情页要一个**库内**路径(tagsForPath 只认标签库里的图), 所以回首页拿一张卡的完整路径
    await cdp.eval(`location.hash = '#/'; await new Promise(r=>setTimeout(r,1400)); return true`)
    await waitFor(cdp, `__t.count('.grid .card .foot') > 0`, { label: '首页卡片(取路径)', timeout: 30000 })
    const libPath = await cdp.eval(`return document.querySelector('.grid .card .foot').title`)
    check('能从卡片拿到完整路径', typeof libPath === 'string' && libPath.length > 6, libPath)

    await cdp.eval(`location.hash = '#/detail?path=' + encodeURIComponent(${JSON.stringify(libPath)}) ; return true`)
    await sleep(1600)
    const detailRes = await cdp.eval(`
      return {
        path: __t.text('.detail .path'),
        tags: __t.count('.detail .tag-list .pill'),
        btns: __t.count('.detail .btns .tv-btn'),
        img: __t.count('.detail .tv-img.loaded'),
      }
    `)
    check('详情页: 路由可直达并渲染', detailRes.tags > 0,
      `${detailRes.tags} 个标签, 图片加载=${detailRes.img}, path=${detailRes.path.slice(-40)}`)
    await cdp.shot('15-detail')

    /* ---------------- 11. 主题切换 ---------------- */
    const theme = await cdp.eval(`
      const before = document.documentElement.dataset.theme || 'dark'
      const btn = [...document.querySelectorAll('.hdr .tv-btn')].pop()
      btn.click()
      await new Promise(r => setTimeout(r, 500))
      const after = document.documentElement.dataset.theme
      const bg = getComputedStyle(document.body).backgroundColor
      return { before, after, bg }
    `)
    check('主题: 深色 <-> 浅色可切换', theme.before !== theme.after, `${theme.before} -> ${theme.after} (bg=${theme.bg})`)
    await cdp.eval(`location.hash = '#/'; await new Promise(r=>setTimeout(r,900)); return true`)
    await cdp.eval(`__t.click('.hdr .nv', 0); return true`)
    await sleep(1200)
    await cdp.shot('16-home-light')
    await cdp.eval(`[...document.querySelectorAll('.hdr .tv-btn')].pop().click(); return true`)
    await sleep(500)

    /* ---------------- 11b. 来源管理页(文件夹登记表) ----------------
     * 这一页是"来源不再写死"的落点: 来源与扫描夹是同一张表上的两个开关。
     * 守三件事:
     *   ① 页面读的是**登记表(tags.db 的 folders 表)**, 而不是 tags_*.txt 的文件名 ——
     *      断言直接 invoke folders:list 与界面上的行数对照;
     *   ② 「移出」只是把用途开关归零, **登记行还在** —— 这是"误删可恢复"的前提,
     *      也是它和「彻底清除」的区别;
     *   ③ 导出备份真的落盘。
     * 刻意**不点**「同步」: 那会去 stat 用户真实的 F 盘几万张图(沙箱配置里的
     * data_files_dir 指向真实目录), 与 TV_INGEST=0 要防的是同一件事。
     */
    await cdp.eval(`location.hash = '#/sources'; return true`)
    await waitFor(cdp, `!!document.querySelector('.source-view')`, { label: '来源管理页', timeout: 20000 })
    await waitFor(cdp, `__t.count('.source-view .rows .row') > 0`, { label: '登记表行', timeout: 20000 })

    const srcPage = await cdp.eval(`
      const row = document.querySelector('.source-view .rows .row')
      return {
        rows: __t.count('.source-view .rows .row'),
        cnt: __t.text('.source-view .cnt').replace(/\\s+/g, ' '),
        switches: __t.count('.source-view .row:first-child .uses .tv-check'),
        acts: __t.count('.source-view .row:first-child .acts .tv-btn'),
        navLabel: __t.text('.hdr .nv.on'),
        first: __t.text('.source-view .rows .row .nm'),
      }
    `)
    check('来源管理: 顶栏里能进到「来源」页', srcPage.navLabel.includes('来源'), srcPage.navLabel)
    check('来源管理: 列出的行数 = 登记表里的目录数', srcPage.rows >= 7, `${srcPage.rows} 行`)
    check('来源管理: 计数文案报出「N 个来源」', /\d+ 个来源/.test(srcPage.cnt), srcPage.cnt)
    check('来源管理: 每行三个独立开关(来源 / 扫描 / 自动反推)', srcPage.switches === 3, `${srcPage.switches} 个`)
    check('来源管理: 行上有同步/重扫/移出 等动作', srcPage.acts >= 3, `${srcPage.acts} 个`)

    /* 第三个开关的**可见性 + 几何**。三个开关横排后列宽必须跟着放宽, 否则会溢出到
     * 相邻列或被裁掉一截 —— 这类视觉回归断言读不到, 所以直接量外接矩形。 */
    const sw3 = await cdp.eval(`
      const row = document.querySelector('.source-view .rows .row')
      const group = row.querySelector('.uses')
      const items = [...group.querySelectorAll('.tv-check')]
      const last = items[items.length - 1]
      const gr = group.getBoundingClientRect()
      const lr = last.getBoundingClientRect()
      const panel = document.querySelector('.source-view .list-panel')
      return {
        n: items.length,
        label: last.textContent.replace(/\\s+/g, ''),
        inGroup: lr.left >= gr.left - 1 && lr.right <= gr.right + 1,
        panelOverflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : false,
      }
    `)
    check('来源管理: 第三个开关是「自动反推」', sw3.n === 3 && sw3.label.includes('自动反推'),
      `${sw3.n} 个 · 末位=${sw3.label}`)
    check('来源管理: 三个开关都落在本列内、整行没被撑出横向滚动(防"被裁掉半个")',
      sw3.inGroup && !sw3.panelOverflow, `在列内=${sw3.inGroup} · 面板溢出=${sw3.panelOverflow}`)

    // 界面点这个开关必须真写回库 —— auto_tag 此前是只读不用的死字段, 最易写成"只改界面"。
    // 注意 TvCheckbox 走 is-switch 时**没有 <input>**, 状态在 .on 类上、点击在 <label> 上 ——
    // 照搬"点 input.checked"那套会拿到 null(2026-09-23 踩过, 见本次提交说明)。
    const flipAutoTag = `__t.clickText('.source-view .rows .row .uses .tv-check', '自动反推'); return true`
    const readAutoTag = `
      const row = document.querySelector('.source-view .rows .row')
      const nm = row.querySelector('.nm').textContent.trim()
      const items = [...row.querySelectorAll('.uses .tv-check')]
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = (d.folders || []).find((x) => x.name === nm)
      return { name: nm, ui: items[items.length - 1].classList.contains('on'), db: f ? !!f.auto_tag : null }
    `
    await cdp.eval(flipAutoTag)
    await sleep(700)
    const atOff = await cdp.eval(readAutoTag)
    check('来源管理: 界面关掉「自动反推」真的写回库(不是只改界面)',
      atOff.db === false && atOff.ui === false, `${atOff.name} · DB auto_tag=${atOff.db} · 界面=${atOff.ui}`)

    await cdp.eval(flipAutoTag)
    await sleep(700)
    const atOn = await cdp.eval(readAutoTag)
    check('来源管理: 再点回来能从库里读回 true(开关是双向的, 不是一次性)',
      atOn.db === true && atOn.ui === true, `${atOn.name} · DB auto_tag=${atOn.db} · 界面=${atOn.ui}`)
    await cdp.shot('17-sources')

    // ① 「移出」= 用途开关归零, 登记行必须还在(图片记录也不掉)
    const firstName = srcPage.first
    const beforeRm = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = d.folders.find((x) => x.name === ${JSON.stringify(firstName)})
      return { images: f?.images || 0, id: f?.id || 0 }
    `)
    await cdp.eval(`
      const row = document.querySelector('.source-view .rows .row')
      const b = [...row.querySelectorAll('.acts .tv-btn')].find((x) => x.textContent.includes('移出'))
      b.click()
      return true
    `)
    await sleep(1800)
    const afterRm = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = d.folders.find((x) => x.name === ${JSON.stringify(firstName)})
      return {
        found: !!f, asSource: f?.as_source, asScan: f?.as_scan, images: f?.images || 0,
        visibleRows: __t.count('.source-view .rows .row'),
      }
    `)
    check('来源管理: 「移出」把两个用途开关归零', afterRm.found && !afterRm.asSource && !afterRm.asScan,
      `as_source=${afterRm.asSource} · as_scan=${afterRm.asScan}`)
    check('来源管理: 移出后登记行仍在库里(这是可恢复的前提)', afterRm.found, afterRm.found ? '行在' : '行被删了')
    check('来源管理: 移出不动库里的图片记录', afterRm.images === beforeRm.images,
      `${beforeRm.images} -> ${afterRm.images}`)
    check('来源管理: 移出的行默认从列表里隐藏', afterRm.visibleRows === srcPage.rows - 1,
      `${srcPage.rows} -> ${afterRm.visibleRows}`)

    // ② 勾「显示已移出的」-> 行回来 -> 「恢复」
    await cdp.eval(`__t.clickText('.source-view .bar2 .tv-check', '显示已移出的'); return true`)
    await sleep(700)
    const shown = await cdp.eval(`
      return { rows: __t.count('.source-view .rows .row'), off: __t.count('.source-view .rows .row.off') }
    `)
    check('来源管理: 勾上「显示已移出的」后行回来了', shown.rows >= srcPage.rows, `${shown.rows} 行 · ${shown.off} 行标为已移出`)

    // 找不到行/按钮时**返回标志而不是抛错** —— 抛错会顺着外层那个大 try 一路
    // 冲到 catch, 后面十几条断言(增量同步 / 反推 / diag)一条都跑不到, 现象是
    // 「流程未中断」失败而真因被埋掉(2026-09-20 踩过一次: 选择器写错把元素当
    // 选择器传给了 __t.text)。
    const clicked = await cdp.eval(`
      const row = [...document.querySelectorAll('.source-view .rows .row')]
        .find((r) => (r.querySelector('.nm')?.textContent || '').trim() === ${JSON.stringify(firstName)})
      if (!row) return { ok: false, reason: '找不到这一行' }
      const btns = [...row.querySelectorAll('.acts .tv-btn')]
      const b = btns.find((x) => x.textContent.trim() === '恢复')
      if (!b) return { ok: false, reason: '这一行没有「恢复」按钮', btns: btns.map((x) => x.textContent.trim()) }
      b.click()
      return { ok: true }
    `)
    check('来源管理: 已移出的行上给出「恢复」按钮', clicked.ok,
      clicked.ok ? '已点击' : `${clicked.reason}: ${(clicked.btns || []).join(' / ')}`)
    await sleep(1800)
    const restored = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = d.folders.find((x) => x.name === ${JSON.stringify(firstName)})
      return { asSource: !!f?.as_source, images: f?.images || 0 }
    `)
    check('来源管理: 打回开关即恢复(误删不再是事故)', restored.asSource === true, `as_source=${restored.asSource}`)
    check('来源管理: 恢复后图片记录依旧完整', restored.images === beforeRm.images,
      `${restored.images} 张`)

    // ③ 导出备份真的落到磁盘
    await cdp.eval(`__t.clickText('.source-view .bar2 .tv-btn', '导出备份'); return true`)
    await sleep(900)
    const exportFile = path.join(DATA_DIR, 'scan_folders.json')
    let exported = { ok: false, n: 0 }
    try {
      const j = JSON.parse(fs.readFileSync(exportFile, 'utf8'))
      exported = { ok: true, n: (j.folders || []).length }
    } catch { /* 没写出来 */ }
    check('来源管理: 导出备份把登记表写成了 json', exported.ok && exported.n >= 7,
      `${exportFile} · ${exported.n} 条`)

    /* ---------------- 11b-2. 改来源自动接同步 + 反推(2026-09-23) ----------------
     * 背景: 「把目录登记为来源」只是改个名字(folders.as_source=1), 它**不会**让图片进库 ——
     * 入库在 ingest, 而 ingest 只遍历 as_source=1 的目录, 两条路中间没人踢一脚, 于是
     * "改了来源但库里一张图都没多、反推队列恒为空"。`folders.auto_tag`(建表时就有、
     * 此前全仓库没有任何消费点)就是给这个补位留的钩子。
     *
     * 这里守四件事 —— 全部只看**判定**, 不看真跑:
     *   ① 非来源 -> 来源 且 auto_tag 开 => wanted=true;
     *   ② 同一跃迁在测试环境必须**止步于 TV_INGEST=0 闸门**(started=false) ——
     *      自动行为绝不能偷偷去 stat 用户真实盘符上的几万个文件, 这正是
     *      electron-path.mjs 默认设 TV_INGEST=0 要防的事;
     *   ③ 关掉 auto_tag 后同一跃迁不再 wanted;
     *   ④ 本来就是来源(无跃迁)时压根不返回 autoSync —— 否则改个名也会白扫一次盘。
     *
     * 被测对象**刻意挑沙箱里那个"只当扫描夹"的目录**(路径含 .e2e-work): 即使闸门
     * 将来失效, 最坏也只是扫了沙箱里那几张测试图, 不会碰用户的 F 盘。
     * 最后一条是这组断言的**负向控制**: 若真跑起了 ingest, 它会立刻红。
     */
    const autoCtx = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const all = d.folders || []
      const scanOnly = all.find((f) => !f.as_source && f.as_scan && /\\.e2e-work/i.test(f.path))
      const src = all.find((f) => f.as_source)
      return { scanOnly: scanOnly ? scanOnly.path : '', src: src ? src.path : '' }
    `)
    check('来源管理: 环境里有一个"只当扫描夹"的沙箱目录, 可安全地测跃迁', !!autoCtx.scanOnly,
      autoCtx.scanOnly || '找不到 —— 这条链路没法在不碰真实磁盘的前提下测')

    if (autoCtx.scanOnly) {
      const sp = JSON.stringify(autoCtx.scanOnly)

      const t1 = await cdp.eval(`
        const r = await window.tv.invoke('folders:update', { path: ${sp}, auto_tag: true, as_source: true })
        await window.tv.invoke('folders:update', { path: ${sp}, as_source: false })
        return { autoSync: r && r.autoSync ? r.autoSync : null, asSource: r && r.folder ? r.folder.as_source : null }
      `)
      check('来源管理: 登记为来源时自动接上同步(判定 wanted=true)', !!t1.autoSync && t1.autoSync.wanted === true,
        `${JSON.stringify(t1.autoSync)} · as_source=${t1.asSource}`)
      check('来源管理: 自动同步在测试环境止步于 TV_INGEST=0 闸门(没去扫真实磁盘)',
        !!t1.autoSync && t1.autoSync.started === false && t1.autoSync.reason === 'ingest-gate',
        JSON.stringify(t1.autoSync))

      const t2 = await cdp.eval(`
        await window.tv.invoke('folders:update', { path: ${sp}, auto_tag: false })
        const r = await window.tv.invoke('folders:update', { path: ${sp}, as_source: true })
        await window.tv.invoke('folders:update', { path: ${sp}, as_source: false, auto_tag: true })
        return { autoSync: r && r.autoSync ? r.autoSync : null }
      `)
      check('来源管理: 关掉「自动反推」后同一跃迁不再补同步',
        !!t2.autoSync && t2.autoSync.wanted === false && t2.autoSync.reason === 'auto-tag-off',
        JSON.stringify(t2.autoSync))

      const t3 = await cdp.eval(`
        const r = await window.tv.invoke('folders:update', { path: ${JSON.stringify(autoCtx.src)}, as_source: true })
        return { autoSync: r && r.autoSync ? r.autoSync : null }
      `)
      check('来源管理: 本来就是来源时不再触发(无跃迁即无 autoSync, 改个名不该白扫盘)',
        t3.autoSync === null, JSON.stringify(t3.autoSync))

      const ingestAfter = await cdp.eval(`return await window.tv.invoke('ingest:status')`)
      check('来源管理: 上面几次跃迁没真跑起 ingest(负向控制: 闸门是实的)',
        !ingestAfter.running && !ingestAfter.lastRunAt,
        `running=${ingestAfter.running} · lastRunAt=${ingestAfter.lastRunAt}`)

      // 收尾: 把那个扫描夹的 auto_tag 与用途复原(下一个断言/下一轮都依赖登记表原样)
      const restoredFolder = await cdp.eval(`
        const d = await window.tv.invoke('folders:list', { usage: 'all' })
        const f = (d.folders || []).find((x) => x.path === ${sp})
        return { as_source: !!f?.as_source, as_scan: !!f?.as_scan, auto_tag: !!f?.auto_tag }
      `)
      check('来源管理: 跃迁测试后目录状态已复原(不留残留给下一轮)',
        restoredFolder.as_source === false && restoredFolder.as_scan === true && restoredFolder.auto_tag === true,
        JSON.stringify(restoredFolder))
    }

    await cdp.eval(`location.hash = '#/'; await new Promise(r=>setTimeout(r,900)); return true`)

    /* ---------------- 11b-3. 空显示名的来源 & 「移出来源 = 从看板隐藏」(2026-09-23) ----------------
     * 用户报的两个现象:
     *   ① 新加的目录在扫描页显示成「表世界」, 看板的来源条里却**没有它** —— 它入库的 2970 张
     *      挤进一个名字为空串的分组: 计进「全部」, 却筛不到也藏不掉。
     *      根因: `folders.label` 是空串(扫描页「添加文件夹」根本不传 label, 界面上那个名字
     *      是 decorate() 用 basename 临时合成的, 所以 DB 里的空值在界面上看不出来),
     *      而 sourceNameList 的 SQL 写的是 `AND label <> ''` —— 被静默滤掉。
     *      label 同时是看板分组的键(readRecords 把它填进 record.source), 空串即隐身。
     *   ② 已经移出来源的目录(桌面壁纸)仍以来源身份留在来源条上 —— src 表兜底完全不看
     *      as_source, 把 txt 时代的老名字又补了回来。
     *
     * 修法是**读侧兜底 + 收窄可见性, 一行 images 都不改**:
     *   · 来源名 = label || 文件夹名(store.js 的 folderBaseName/folderNameMap, 两边同口径);
     *   · 可见性 = gone=0 且目录的 as_source 不是 0 —— 即用户选的
     *     「移出来源 = 从看板隐藏, 打回来立刻恢复」。
     *
     * 全部断言只动沙箱库, 跑完把开关复原(不留残留给下一轮)。
     */
    const emptyLabelCtx = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = (d.folders || []).find((x) => !x.label && x.as_scan && /\\.e2e-work/i.test(x.path))
      return f ? { path: f.path, name: f.name, label: f.label } : null
    `)
    check('来源管理: 有一个 label 为空串的沙箱目录可测"空显示名"', !!emptyLabelCtx,
      emptyLabelCtx ? `${emptyLabelCtx.name} · label=${JSON.stringify(emptyLabelCtx.label)}` : '找不到')

    if (emptyLabelCtx) {
      const ep = JSON.stringify(emptyLabelCtx.path)
      const en = JSON.stringify(emptyLabelCtx.name)
      const on = await cdp.eval(`
        await window.tv.invoke('folders:update', { path: ${ep}, as_source: true, auto_tag: false })
        await window.tv.invoke('app:reload', {})
        const st = await window.tv.invoke('stats:get', {})
        const hit = (st.sources || []).find((s) => s.name === ${en})
        await window.tv.invoke('folders:update', { path: ${ep}, as_source: false, auto_tag: true })
        await window.tv.invoke('app:reload', {})
        const st2 = await window.tv.invoke('stats:get', {})
        return { hit: hit || null, stillThere: (st2.sources || []).some((s) => s.name === ${en}) }
      `)
      check('来源管理: label 为空串的目录登记为来源后, 来源条里查得到它(名字落到文件夹名上)',
        !!on.hit && on.hit.name === emptyLabelCtx.name, JSON.stringify(on.hit))
      check('来源管理: 再注销掉它就从来源条里消失(不留空壳胶囊)', on.stillThere === false,
        `还在=${on.stillThere}`)
    }

    const hideCtx = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = (d.folders || []).find((x) => x.as_source && x.images > 0)
      return f ? { path: f.path, name: f.name, rows: f.images } : null
    `)
    check('来源管理: 有一个有图的来源目录, 可测「移出即从看板隐藏」', !!hideCtx,
      hideCtx ? `${hideCtx.name} · 库内 ${hideCtx.rows} 行` : '找不到')

    if (hideCtx) {
      const hp = JSON.stringify(hideCtx.path)
      const hn = JSON.stringify(hideCtx.name)
      const before = await cdp.eval(`
        const st = await window.tv.invoke('stats:get', {})
        const s = (st.sources || []).find((x) => x.name === ${hn})
        return { total: st.total_images, mine: s ? s.images : 0 }
      `)
      const off = await cdp.eval(`
        await window.tv.invoke('folders:update', { path: ${hp}, as_source: false })
        await window.tv.invoke('app:reload', {})
        const st = await window.tv.invoke('stats:get', {})
        const d = await window.tv.invoke('folders:list', { usage: 'all' })
        const f = (d.folders || []).find((x) => x.path === ${hp})
        return {
          total: st.total_images,
          hasChip: (st.sources || []).some((s) => s.name === ${hn}),
          rows: f ? f.images : -1,
        }
      `)
      check('来源管理: 移出来源后那些图从看板隐藏(「全部」的数字正好少了该来源的张数)',
        off.total === before.total - before.mine && before.mine > 0,
        `${before.total} -> ${off.total} (该来源在册 ${before.mine} 张)`)
      check('来源管理: 移出来源后它不再出现在来源条上', off.hasChip === false, `还在=${off.hasChip}`)
      check('来源管理: 但库里的图片记录一行没少(这才是"打回开关即恢复"的前提)',
        off.rows === hideCtx.rows, `库里 ${off.rows} 行`)

      const back = await cdp.eval(`
        await window.tv.invoke('folders:update', { path: ${hp}, as_source: true, auto_tag: false })
        await window.tv.invoke('folders:update', { path: ${hp}, auto_tag: true })
        await window.tv.invoke('app:reload', {})
        const st = await window.tv.invoke('stats:get', {})
        return { total: st.total_images, hasChip: (st.sources || []).some((s) => s.name === ${hn}) }
      `)
      check('来源管理: 打回来源后图与来源胶囊一起回来(可逆, 不是一次性破坏)',
        back.total === before.total && back.hasChip === true,
        `total=${back.total} · chip=${back.hasChip}`)
    }

    /* ③ 扫描页的卡片上要能分清两种"标签": 图内嵌的提示词 vs 库里存的图/反推结果。
     * 用户看「表世界」时以为"反推白跑了" —— 其实反推只写库、不写回 PNG, 而扫描页卡片
     * 那行显示的是**图内元数据**(裸图当然是 0)。补一行「库内 N 张 · 已反推 M」才分得清。
     *
     * 这一段顺带钉住扫描页的**列表刷新**(2026-09-23 补): ScanView 在 keep-alive 白名单里,
     * onMounted 一辈子只跑一次 —— 别处(来源页)改了用途开关, 切回扫描页看到的还是老清单,
     * 用户会以为"加了没用"。现在 onActivated 会重查一次, 所以下面**不点**「🔄 刷新列表」,
     * 直接断言"那张卡片自己出现了" —— 断言的就是这层刷新。 */
    const scanCtx = await cdp.eval(`
      const d = await window.tv.invoke('folders:list', { usage: 'all' })
      const f = (d.folders || []).find((x) => x.as_source && x.images > 0)
      if (!f) return null
      await window.tv.invoke('folders:update', { path: f.path, as_scan: true })
      return { path: f.path, name: f.name, rows: f.images }
    `)
    check('扫描页: 有一个"有图 + 已登记来源"的目录可挂成扫描夹', !!scanCtx,
      scanCtx ? `${scanCtx.name} · 库内 ${scanCtx.rows} 张` : '找不到')

    if (scanCtx) {
      await cdp.eval(`location.hash = '#/scan'; return true`)
      await waitFor(cdp, `!!document.querySelector('.scan-view')`, { label: '扫描页', timeout: 20000 })
      /* 扫描页在 KeepAlive 白名单里: 上一段测试进来过并停在**二级**(某个文件夹的图片
         列表), 现在切回来会原样恢复 —— 一级的文件夹网格压根不在 DOM 里, 直接等它必然
         超时。所以先退回一级(面包屑那个「全部文件夹」)。 */
      await cdp.eval(`
        if (!document.querySelector('.scan-view .grid.folders')) {
          const back = document.querySelector('.scan-view .crumb .link')
          if (back) back.click()
        }
        return true
      `)
      await waitFor(cdp, `!!document.querySelector('.scan-view .grid.folders')`,
        { label: '扫描页文件夹网格(一级)', timeout: 20000 })

      const wanted = JSON.stringify(scanCtx.name)
      /* 等卡片出现用**轮询**而不是 waitFor: waitFor 超时是抛异常, 会把整轮 e2e 打断;
         而"卡片没出现"恰恰是这里要判定的一件事, 该由 check 记成失败、然后继续往下跑。 */
      let appeared = false
      for (let i = 0; i < 50 && !appeared; i++) {
        appeared = await cdp.eval(`
          return [...document.querySelectorAll('.scan-view .grid.folders .ecard .name')]
            .some((n) => n.textContent.trim() === ${wanted})
        `)
        if (!appeared) await sleep(200)
      }
      check('扫描页: 切回扫描页时列表已刷新(别处刚挂的扫描夹立刻可见, 不用手点刷新)',
        appeared === true, `名叫「${scanCtx.name}」的卡片: ${appeared ? '找到了' : '没找到'}`)

      const scanCard = await cdp.eval(`
        const cards = [...document.querySelectorAll('.scan-view .grid.folders .ecard')]
        const c = cards.find((x) => (x.querySelector('.name')?.textContent || '').trim() === ${wanted})
        if (!c) return null
        return [...c.querySelectorAll('.fmeta')].map((m) => m.textContent.replace(/\\s+/g, ' ').trim())
      `)
      const libLine = (scanCard || []).find((t) => t.includes('库内')) || ''
      const libNum = Number(((libLine.match(/库内 ([\d,]+) 张/) || [])[1] || '').replace(/,/g, '') || NaN)
      check('扫描页: 卡片把「图内提示词」与「库内图片/已反推」分开显示(不再像"没有标签")',
        libNum === scanCtx.rows,
        `卡片上写着「${libLine}」 · 库里 ${scanCtx.rows} 行`)

      await cdp.eval(`
        await window.tv.invoke('folders:update', { path: ${JSON.stringify(scanCtx.path)}, as_scan: false })
        return true
      `)
    }

    /* 收尾: 回首页 —— 下面 11c 是"从首页卡片上点标签", 若停在这儿(扫描页)它一条都跑不到
     * (2026-09-23 二跑里标签跳转整段 11 条失败, 根因就是这里没回家)。 */
    await cdp.eval(`location.hash = '#/'; await new Promise(r=>setTimeout(r,900)); return true`)

    /* ---------------- 11c. 点标签跳去该标签的图片列表(2026-09-20 需求) ----------------
     * 光箱 / 详情页的标签: 点**标签本体** = 跳转, 点标签上的 📋 = 只复制那一个。
     *
     * 落点是**下一级子页面** /tags/xxx(2026-09-20 第二轮需求: "拆出来作为更深的子页面,
     * 就像标签页点 tag 跳转那样")。除了"跳对了", 还要钉住这几件与层级有关的事:
     *   · 地址栏是路径形式(不是 ?tag= 挂在标签列表上)
     *   · 面包屑「全部标签 > 该标签」, 页面根是 .tag-images-view
     *   · 标签名里的 `/` 不会被拆成两段路径(`bb_(fate/extra)` 这类真标签存在)
     *   · 旧的 ?tag= 地址仍能打开(重定向到子页面)
     * 点一下能"回到列表"不在这里测 —— 标签列表进子页面那条路在段 7 已测过(history.back)。
     *
     * 取标签名不能读 pill 的文本: 角色 pill 显示时会砍掉 _(系列) 尾巴; 也不能无脑读
     * title —— 被 ban 的 pill 的 title 是"已 ban(导出时剔除)"。所以挑一个 title 以
     * "点击查看该标签的图片"开头的 pill, 再从 title 里取完整标签名。 */
    const tagJump = await cdp.eval(`
      await new Promise(r => setTimeout(r, 700))
      const card = document.querySelector('.grid .card')
      if (!card) return { err: '首页没有卡片' }
      card.click()
      await new Promise(r => setTimeout(r, 2400))
      if (!document.querySelector('.lightbox')) return { err: '光箱没打开' }
      const pill = [...document.querySelectorAll('.lightbox .lb-tags .pill')]
        .find((p) => (p.getAttribute('title') || '').startsWith('点击查看该标签的图片'))
      if (!pill) return { err: '光箱里没有可用的标签 pill' }
      const tag = (pill.getAttribute('title') || '').split(': ').pop()
      const path = __t.text('.lightbox .lb-path')
      const hasCopyIcon = !!pill.querySelector('.cp')
      // ① 先点 📋: 应当**只复制、不跳转**(光箱还开着)
      pill.querySelector('.cp').click()
      await new Promise(r => setTimeout(r, 700))
      const afterCopy = { open: !!document.querySelector('.lightbox'), hash: location.hash }
      // ② 再点标签本体: 应当跳走, 光箱自己关掉
      pill.click()
      await new Promise(r => setTimeout(r, 2200))
      return {
        err: '', tag, path, hasCopyIcon, afterCopy,
        closed: !document.querySelector('.lightbox'),
        hash: decodeURIComponent(location.hash),
        isSub: !!document.querySelector('.tag-images-view'),
        crumb: __t.text('.tag-images-view .crumb .now'),
        parent: __t.text('.tag-images-view .crumb .link'),
        total: __t.text('.tag-images-view .bar .cnt'),
      }
    `)
    check('标签跳转: 光箱的标签上挂着 📋 复制图标', tagJump.hasCopyIcon === true,
      tagJump.err || (tagJump.hasCopyIcon ? '在' : '不在'))
    check('标签跳转: 点 📋 只复制不跳转(光箱还开着)',
      tagJump.afterCopy?.open === true && !(tagJump.afterCopy?.hash || '').includes('/tags/'),
      tagJump.afterCopy?.hash)
    check('标签跳转: 点标签本体跳到子页面 /tags/xxx 且光箱自动关闭',
      tagJump.closed === true && tagJump.isSub === true && /#\/tags\/.+/.test(tagJump.hash || ''),
      `${tagJump.hash} · 光箱关闭=${tagJump.closed} · 子页面=${tagJump.isSub}`)
    check('标签跳转: 子页面面包屑是「全部标签 > 该标签」',
      tagJump.parent === '全部标签' && tagJump.crumb === tagJump.tag,
      `${tagJump.parent} > ${tagJump.crumb} · 期望 ${tagJump.tag}`)
    check('标签跳转: 子页面确实查出了图(不是空列表)',
      Number(String(tagJump.total).replace(/[^0-9]/g, '') || 0) > 0, `${tagJump.total} 条`)

    /* 浮动返回 = 回来源页 + **把光箱恢复出来**(2026-09-20 用户需求):
     * 这一段就是从首页光箱点标签跳过来的, 所以按浮动导航的「←」应该回到首页,
     * 且光箱重新打开、停在当时那张图上。 */
    const lbRestore = await cdp.eval(`
      const fbtn = document.querySelector('.float-nav .fbtn')
      if (!fbtn) return { err: '浮动返回键没渲染' }
      fbtn.click()
      await new Promise(r => setTimeout(r, 1400))
      return {
        err: '',
        hash: location.hash,
        lbOpen: !!document.querySelector('.lightbox'),
        lbPath: __t.text('.lightbox .lb-path'),
      }
    `)
    check('标签跳转: 浮动返回回到来源页', !lbRestore.err && lbRestore.hash === '#/',
      lbRestore.err || lbRestore.hash)
    check('标签跳转: 返回后光箱恢复且停在当时那张图',
      lbRestore.lbOpen === true && lbRestore.lbPath === tagJump.path,
      `光箱=${lbRestore.lbOpen} · ${lbRestore.lbPath}`)
    // 光箱还开着 —— 关掉再继续后面的深链测试
    await cdp.eval(`document.querySelector('.lightbox .lb-close')?.click(); return true`)
    await new Promise(r => setTimeout(r, 700))

    // 深链: 直接进子页面地址, 也要停在同一标签上(路由参数是唯一真源)
    const deep = await cdp.eval(`
      location.hash = '#/'
      await new Promise(r => setTimeout(r, 900))
      location.hash = '#/tags/' + encodeURIComponent(${JSON.stringify(tagJump.tag || '')})
      await new Promise(r => setTimeout(r, 2000))
      return {
        crumb: __t.text('.tag-images-view .crumb .now'),
        cards: __t.count('.tag-images-view .grid .card'),
      }
    `)
    check('标签跳转: 直接访问子页面地址(深链)也停在同一标签',
      deep.crumb === tagJump.tag && deep.cards > 0, `${deep.crumb} · ${deep.cards} 张`)

    /* 标签名进的是**路径参数**, 里面可能有 `/` —— 库里真有 `bb_(fate/extra)`、
       `k/da_(league_of_legends)` 这类标签, 编码/还原一旦不对, 它们会被拆成两段路径
       (crash 或跳错页)。这里用人造标签验证这一层本身, 不依赖库里恰好有没有这样的图:
       面包屑能对上就说明 %2F 原样解回来了。 */
    const slash = await cdp.eval(`
      location.hash = '#/tags/' + encodeURIComponent('foo/bar_(baz)')
      await new Promise(r => setTimeout(r, 1500))
      return { crumb: __t.text('.tag-images-view .crumb .now'), hash: decodeURIComponent(location.hash) }
    `)
    check('标签子页面: 标签名里的 / 原样还原(不会被拆成两段路径)',
      slash.crumb === 'foo/bar_(baz)', `${slash.crumb} · ${slash.hash}`)

    /* 旧地址兼容: 2026-09-20 之前"点标签"的落点是 /tags?tag=xxx。老书签/老深链
       进来必须还能打开(路由上做了重定向), 而不是停在标签列表或白屏。 */
    const oldAddr = await cdp.eval(`
      location.hash = '#/tags?tag=' + encodeURIComponent(${JSON.stringify(tagJump.tag || '')})
      await new Promise(r => setTimeout(r, 2000))
      return {
        hash: decodeURIComponent(location.hash),
        crumb: __t.text('.tag-images-view .crumb .now'),
        cards: __t.count('.tag-images-view .grid .card'),
      }
    `)
    check('标签跳转: 旧地址 /tags?tag=xxx 仍能打开(重定向到子页面)',
      oldAddr.crumb === tagJump.tag && oldAddr.cards > 0
        && /#\/tags\/.+/.test(oldAddr.hash) && !oldAddr.hash.includes('?'),
      `${oldAddr.hash} · ${oldAddr.crumb} · ${oldAddr.cards} 张`)

    // 详情页的标签是同一个入口(该页标签查自标签库, 库外图在本页直接是 not found)
    const detJump = await cdp.eval(`
      location.hash = '#/detail?path=' + encodeURIComponent(${JSON.stringify(tagJump.path || '')})
      /* 轮询而不是死等 2s: 详情页的标签是进页后现查的, 前一步刚从"305 条结果的标签页"
         切过来, 主进程那一下不一定 2s 内回。等不到时把现场一起带回去(路径 + 页面文字
         前 200 字 + pill 数), 免得只看到一句"没有 pill"没法判断是慢还是跳错页。 */
      for (let i = 0; i < 40 && !document.querySelector('.detail .tag-list .pill'); i++) {
        await new Promise(r => setTimeout(r, 300))
      }
      const pill = [...document.querySelectorAll('.detail .tag-list .pill')]
        .find((p) => (p.getAttribute('title') || '').startsWith('点击查看该标签的图片'))
      if (!pill) return {
        err: '详情页没有可用的标签 pill',
        path: ${JSON.stringify(tagJump.path || '')},
        txt: ((document.querySelector('.detail') || {}).innerText || '(连 .detail 都没有)').slice(0, 200),
        pills: document.querySelectorAll('.detail .pill').length,
      }
      const tag = (pill.getAttribute('title') || '').split(': ').pop()
      pill.click()
      await new Promise(r => setTimeout(r, 2000))
      return { err: '', tag, hash: decodeURIComponent(location.hash), crumb: __t.text('.tag-images-view .crumb .now') }
    `)
    check('标签跳转: 详情页点标签也是同一个入口',
      detJump.err === '' && detJump.crumb === detJump.tag && /#\/tags\/.+/.test(detJump.hash || ''),
      detJump.err ? `${detJump.err} · path=${detJump.path} · pill=${detJump.pills} · ${detJump.txt}` : `${detJump.crumb} · ${detJump.hash}`)

    /* 详情页跳过来的返回: 回详情页, 且**不会**错误地拉起光箱
     * (详情页不是光箱入口, 没有 jump 记忆可消费)。 */
    const detBack = await cdp.eval(`
      document.querySelector('.float-nav .fbtn')?.click()
      await new Promise(r => setTimeout(r, 1400))
      return { hash: decodeURIComponent(location.hash), onDetail: !!document.querySelector('.detail'), lbOpen: !!document.querySelector('.lightbox') }
    `)
    check('标签跳转: 详情页跳来的子页面按返回回到详情页(不拉起光箱)',
      detBack.onDetail === true && detBack.lbOpen === false && detBack.hash.includes('/detail'),
      `${detBack.hash} · 详情页=${detBack.onDetail} · 光箱=${detBack.lbOpen}`)

    await cdp.eval(`location.hash = '#/'; await new Promise(r=>setTimeout(r,900)); return true`)

    /* ---------------- 12. 控制台健康度 ---------------- */
    /**
     * 只过滤两类**与本应用代码无关**的噪声, 不是"放行所有报错":
     *
     *  1) favicon 404 —— file:// 下必然出现。
     *  2) Electron/Chromium 自己的沙箱渲染进程引导失败:
     *       `Electron sandboxed_renderer.bundle.js script failed to run`
     *       `Cannot destructure property 'preloadScripts' of 'binding.startupData'`
     *     2026-09-19 定位: 触发条件是执行环境**拒绝** `<userData>/Session Storage/LOG.old`
     *     的写/删(实测本沙箱会拒, 报 "读/写/删 · 拒绝"), Chromium 的 sessionStorage 后端
     *     初始化失败 → 渲染进程引导脚本崩在 Electron 内部, 与 app 代码无关。
     *     证据: 用**完全相同的启动参数**做 4 组对照(A 裸启动 / B 仅 user-data-dir /
     *     C 仅调试端口 / D 两者=e2e 配置), 没有一组稳定复现; e2e 自己也是一遍有一遍没有。
     *
     * 过滤掉它之后并不是失去保护 —— 紧接着有一条**正面断言**证明 preload 真的生效
     * (window.tv.invoke 可调用)。那比"控制台不报错"更硬: 控制台干净但 IPC 桥没注入
     * 才是真正危险的情况, 而这条断言能抓到。
     */
    /**
     * 幽灵请求总账 —— 删除之后, 还有谁在请求那张已经进回收站的图?
     *
     * 为什么单独记这一笔: 上面(光箱删除那一段)已经断言过一次"删除后不再请求",
     * 但那只盯住删除那一刻的窗口。实测那条抓到的是 0 条, 而控制台里确实有 404 ——
     * 说明请求来自**更晚的段落**(收藏页会给收藏过的那张渲染卡片, 而它已经被删)。
     * 记录器从删除那一刻装好后一直活着, 所以这里能把真正的发起方连同调用栈抓出来,
     * 红的时候不用再猜是谁发的。
     */
    const ghost = await cdp.eval(`
      const base = window.__delBase || ''
      const all = window.__imgReq || []
      const hit = all.filter((r) => base && r.v.includes(base) && !/^patch-fail/.test(r.v))
      return {
        total: all.length, base, n: hit.length,
        detail: hit.slice(-2).map((r) => r.v.slice(-70) + ' || ' + r.stack.split('\\n').slice(1, 5).join(' <- ')),
      }
    `)
    check('幽灵请求总账: 删除后整轮都不再请求那张已进回收站的图', ghost.n === 0, JSON.stringify(ghost))

    const NOISE = /favicon|ERR_FILE_NOT_FOUND.*favicon|sandboxed_renderer\.bundle\.js|binding\.startupData/i
    const errs = cdp.errors.filter((e) => !NOISE.test(e))
    check('运行期无 JS 异常 / Vue 警告', errs.length === 0,
      errs.length ? `${errs.length} 条: ${errs.slice(0, 4).join(' | ')}` : `0 条(已滤掉 favicon 与 Electron 沙箱引导噪声 ${cdp.errors.length - errs.length} 条)`)

    /* preload 生效的正面证据 —— 与上面那条一起, 才是完整的健康度检查 */
    const bridge = await cdp.eval(`
      return {
        tv: typeof window.tv,
        invoke: typeof window.tv?.invoke,
        channels: Array.isArray(window.tv?.channels) ? window.tv.channels.length : null,
      }
    `)
    check('preload 的 window.tv 已注入且 invoke 可用', bridge.invoke === 'function',
      `window.tv=${bridge.tv} · invoke=${bridge.invoke} · channels=${bridge.channels}`)

    /* 主进程诊断信息 */
    const diag = await cdp.eval(`return await window.tv.invoke('diag:stats')`)
    console.log('\n[diag] 搜索缓存:', JSON.stringify(diag.search))
    console.log('[diag] 缩略图:', JSON.stringify(diag.thumbs), '缓存', JSON.stringify(diag.thumbCache))
    console.log('[diag] 翻译库:', JSON.stringify(diag.translate))
    /* 翻译库 —— 以前这里只 console.log 不断言, 于是"加载到 0 条"完全无声。
     * 2026-09-19: 配置里的 translate_dir 指向一个早就被挪走的目录, WeiLin 静默塌成 0 条,
     * 界面上所有标签都只剩英文。这两条断言就是钉住那一类故障的。 */
    check('翻译: WeiLin 库真的加载了(不是 0 条)', (diag.translate?.weilin || 0) > 0,
      `weilin=${diag.translate?.weilin} · 来源=${diag.translate?.dirSource}`
      + ` · dir=${(diag.translate?.dirs || []).join(' | ') || '（无）'}`)
    check('翻译: 配置里的 translate_dir 没指向失效路径', !diag.translate?.dirMissing,
      diag.translate?.dirMissing
        ? `失效路径: ${diag.translate.dirWanted}（已回落到数据目录, 但配置该改）`
        : `dirWanted=${diag.translate?.dirWanted || '（空, 走自动发现）'}`)
    console.log('[diag] 内存:', JSON.stringify(diag.memoryMB))

    /* 增量同步(阶段 2) —— IPC 通路 + 诊断字段 + 一条安全断言
     * ====================================================
     * 第三条是最有价值的: e2e 沙箱里的 tag_viewer_config.json 是从用户**真实**数据目录
     * 拷来的, 所以沙箱库会从 tags_*.txt 建出 folders 行、根目录指向用户真实的盘符。
     * 一旦"启动自启同步"在测试里漏开, 它会真的去 stat 用户几万张图、把新增图写进沙箱库,
     * 把「5 images」「68,376 条结果」这类断言全部带偏 —— 而且是**静默**带偏。
     * 靠 harness 注入的 TV_INGEST=0 挡住; 这条断言就是钉住那道闸门。 */
    const ig = await cdp.eval(`return await window.tv.invoke('ingest:status')`)
    check('增量同步: ingest:status 可调且带队列统计',
      !!ig && 'phase' in ig && !!ig.queue, `phase=${ig?.phase} · queue=${JSON.stringify(ig?.queue)}`)
    check('增量同步: diag 里有 ingest / tagQueue 两份诊断',
      !!diag.ingest && !!diag.tagQueue, `ingest.phase=${diag.ingest?.phase}`)
    check('增量同步: 测试环境未自动跑(绝不能去扫用户的真实磁盘)',
      ig?.phase === 'idle' && !ig?.lastRunAt && !ig?.running,
      `phase=${ig?.phase} · running=${ig?.running} · lastRunAt=${ig?.lastRunAt}`)

    /* WD14 反推(阶段 3) —— IPC 通路 + 同一道闸门
     * ==========================================
     * 反推比同步更危险: 它要拉 python 子进程 + 加载 1.27GB 模型, 而且**会把标签写进库**。
     * 沙箱库既然指向用户真实盘符, 漏跑一次就会往沙箱里塞进真实图片的标签。
     * 所以它同样受 TV_INGEST=0 / TV_TAGGER=0 挡着 —— 而且**队列为空时本就不该拉起服务**
     * (那条在 core/tagger.js 里, 由 test:tagger 单独守)。 */
    const tg = await cdp.eval(`return await window.tv.invoke('tagger:status')`)
    check('反推: tagger:status 可调且带队列与配置',
      !!tg && 'phase' in tg && !!tg.queue && !!tg.config,
      `phase=${tg?.phase} · queue=${JSON.stringify(tg?.queue)}`)
    check('反推: diag 里有 tagger 诊断',
      !!diag.tagger, `tagger.phase=${diag.tagger?.phase}`)
    check('反推: 测试环境未自动跑(绝不能加载模型去反推)',
      tg?.phase === 'idle' && !tg?.lastRunAt && !tg?.running,
      `phase=${tg?.phase} · running=${tg?.running} · lastRunAt=${tg?.lastRunAt}`)
    const tgc = await cdp.eval(`return await window.tv.invoke('tagger:config')`)
    check('反推: tagger:config 能报出静态配置(脚本/模型/标签表各自在不在)',
      !!tgc && 'scriptExists' in tgc && 'modelExists' in tgc && 'available' in tgc,
      `script=${tgc?.scriptExists} model=${tgc?.modelExists} csv=${tgc?.csvExists}`)
  } catch (e) {
    check('e2e 流程未中断', false, e.message)
    console.error(e)
  } finally {
    fs.writeFileSync(path.join(SHOTS, '_report.json'),
      JSON.stringify({
        results,
        fails,
        errors: [],
        // 截图失败不中断整轮, 但必须留在报告里, 否则"少了张图"没人知道
        shots: { total: cdp.shots.length, failed: cdp.shots.filter((s) => !s.ok) },
      }, null, 2), 'utf8')
    if (!KEEP) {
      try { ws.close() } catch { /* 忽略 */ }
      try { child.kill() } catch { /* 忽略 */ }
      await sleep(600)
      // 按 **PID** 收拾进程树 —— 绝不能按进程名杀 electron.exe:
      // 这台机器上还有壁纸切换器等别的 Electron 应用, 按名字杀会误伤(记录在案)。
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch { /* 忽略 */ }
    }
  }

  console.log(`\n===== e2e 结果: ${results.length - fails}/${results.length} 通过, ${fails} 失败 =====`)
  console.log('截图目录:', SHOTS)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
