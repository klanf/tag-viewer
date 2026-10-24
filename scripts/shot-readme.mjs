/**
 * README 截图 —— 复用 e2e 工具链的最小脚本(不是测试, 只出图)。
 *
 * 约束(用户要求):
 *   · 安全模式全程打开, 而且必须是 **edge 档**(core 档实测还留着透衫/uncensored 那类,
 *     首页截图翻过一次车 —— 公开 README 上不能出现);
 *   · 所有网格图只看「涩不了一点」这一个来源;
 *   · **出图前一律过一遍脱敏**: DOM 里任何 `X:\...` / `X:/...` 绝对路径、
 *     以及来源登记表里的真实路径, 全部换成 `图库/<末段>`。截图是二进制,
 *     事后 grep 抓不到, 所以必须在按快门之前洗掉(2026-10-24 发现已发布的
 *     老 sources.png 把整行本机绝对路径带出去了)。
 *
 * 沙箱与隔离完全复用 scripts/harness.mjs 的 ensureWorkDir:
 *   数据是真实库的副本, 截图过程不碰真实库。
 * 产出: docs/images/*.jpg (1600x1000, jpeg q82)
 *
 * 用法: node scripts/shot-readme.mjs [只拍这几个名字, 逗号分隔]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { findElectron, electronEnv } from './electron-path.mjs'
import { freePort, clearPageState, ensureWorkDir, sleep, ROOT } from './harness.mjs'

const OUT = path.join(ROOT, 'docs', 'images')
const ONLY = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean)
let PORT = Number(process.env.TV_CDP_PORT || 0)
/** main() 跑起来后才有的上下文(沙箱目录), 供各个 shot 取用 */
const CTX = { scanDir: '' }
/** 公开截图用的系列(封面相对干净), 可用 SHOT_SERIES 临时换着试 */
const SERIES_KW = process.env.SHOT_SERIES || '原神'
/** 系列墙截图用的来源过滤(空 = 不过滤) */
const SOURCE_KW = process.env.SHOT_SOURCE || ''
/** 标签页截图用的搜索词(全量标签墙里成人向词太多, 不适合放公开 README) */
const TAG_KW = process.env.SHOT_TAG_KW || 'flower'
/** 网格类截图统一只看这一个来源(相对最干净的一档) */
const SRC = process.env.SHOT_SRC || '涩不了一点'
/**
 * 替换规则弹窗的演示内容 —— 沙箱副本里那份是他真实在用的规则, 里面全是成人向标签,
 * 绝对不能进公开 README(2026-10-24 逐张查验时抓到)。截图前把沙箱里这份覆盖掉,
 * 真实库不受影响(数据本来就是 .e2e-work 的副本)。
 */
const DEMO_RULES = {
  active: 'cat',
  sets: [
    {
      id: 'cat',
      name: '猫耳插件',
      text: [
        '# 导出替换规则',
        '# 每行一条: 模式 -> 替换后的标签(可多个, 逗号分隔)',
        '# 模式通配同黑名单: *boy 后缀 / 1* 前缀 / *color* 包含 / 无通配=精确',
        '# 例: 凡是单人图都追加猫耳猫尾, 出图时不用手打',
        '1girl -> {tag}, cat_ears, cat_tail',
        '1boy -> {tag}, cat_ears, cat_tail',
        '@school_uniform@ -> {tag}, cat_ears, bell',
        '',
        '# 替换侧留空 = 命中即删除该标签(颜色词由黑名单兜, 这里演示删词)',
        'red_hair ->',
        'blue_hair ->',
      ].join('\n'),
    },
    {
      id: 'default',
      name: '默认',
      text: '# 导出替换规则\n# 这一套留空, 导出时挑它就是「不改写」\n',
    },
  ],
}

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
  /** 出图前洗一遍页面: 绝对路径 / 登记表里的真实文件夹路径 → `图库/<末段>` */
  async scrub() {
    const n = await this.eval(`
      const list = await window.tv.invoke('folders:list')
      const rows = Array.isArray(list) ? list : (list?.folders || list?.list || [])
      const paths = new Set()
      const labels = new Set()
      for (const f of rows) {
        const p = f.path || f.dir || ''
        if (p) {
          paths.add(String(p))
          const base = String(p).replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop()
          if (base) labels.add(base)
        }
        if (f.label) labels.add(String(f.label))
      }
      // 沙箱里 folders 表被 harness 清空了, 来源名(卡片副标题的前缀)改从界面胶囊上取
      for (const chip of document.querySelectorAll('.src-bar .tv-chip')) {
        const t = (chip.textContent || '').replace(/[\\s,\\d]+$/g, '').trim()
        if (t && t !== '全部' && !/垃圾桶/.test(t)) labels.add(t)
      }
      // 长路径先替换, 免得短的先吃掉一半
      const sorted = [...paths].sort((a, b) => b.length - a.length)
      const byLen = [...labels].sort((a, b) => b.length - a.length)
      const tail = (p) => p.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || '本地图库'
      const clean = (s) => {
        if (!s) return s
        let out = s
        for (const p of sorted) out = out.split(p).join('图库/' + tail(p))
        // 卡片副标题写的是「本地夹名\\文件名」这种相对名, 没有盘符, 上面那条兜不住
        for (const L of byLen) {
          out = out.split(L + '\\\\').join('图库/').split(L + '/').join('图库/')
        }
        // 界面里显示的是「相对路径」(本地夹名\\文件名), 甚至被 JS 截断成 …xxx\\ ——
        // 登记表里没有这些短名时, 用「反斜杠一定是路径」这条通吃
        out = out.replace(/[^\\\\\\s]*\\\\/g, '图库/')
        // 兜底: 登记表没覆盖到的盘符路径(导出目标、图内元数据里的路径等)
        out = out.replace(/[A-Za-z]:[\\\\/][^\\s"',;:|)\\]]*/g, (m) => '图库/' + tail(m))
        out = out.replace(/[A-Za-z]:[\\\\/]/g, '图库/')
        out = out.split('图库/图库/').join('图库/')
        return out
      }
      const isHidden = (el) => el.tagName === 'SCRIPT' || el.tagName === 'STYLE'
      let hits = 0
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      const missed = []
      while ((node = tw.nextNode())) {
        const host = node.parentElement
        if (!host || isHidden(host)) continue
        const v = clean(node.nodeValue)
        if (v !== node.nodeValue) { node.nodeValue = v; hits++ }
        else if ((node.nodeValue.includes('\\\\') || node.nodeValue.includes('/')) && !node.nodeValue.trim().startsWith('图库/')) {
          missed.push(node.nodeValue.trim().slice(0, 60))
        }
      }
      for (const el of document.querySelectorAll('[title], [alt], [placeholder], [value]')) {
        for (const attr of ['title', 'alt', 'placeholder']) {
          const cur = el.getAttribute(attr)
          const v = clean(cur)
          if (cur && v !== cur) { el.setAttribute(attr, v); hits++ }
        }
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const v = clean(el.value)
          if (v !== el.value) { el.value = v; hits++ }
        }
      }
      return { hits, labels: [...labels], missed: missed.slice(0, 6), rows: rows.length }
    `)
    if (process.env.SHOT_DEBUG) {
      console.log('[scrub] folders:list rows =', n.rows, 'labels =', JSON.stringify(n.labels))
      if (n.missed.length) console.log('[scrub] 未洗掉的含斜杠文本:', JSON.stringify(n.missed))
    }
    if (n.hits) console.log(`[shot] 脱敏: 洗掉 ${n.hits} 处路径文本`)
    return n
  }
  async shot(name, { blur = '' } = {}) {
    const t0 = Date.now()
    // 角色封面是历史上自动挑的、存在库里, 安全模式只管显示层, 挡不住已经存下的封面。
    // 所以这两张图单独把封面糊掉 —— 界面照常看得清, 内容不上 README(用户 2026-10-24 点头的方案)。
    if (blur) {
      await this.eval(`
        const st = document.createElement('style')
        st.id = '__shot_blur'
        st.textContent = ${JSON.stringify(blur)} + ' { overflow: hidden; } ' + ${JSON.stringify(blur + ' img')} +
          ' { filter: blur(18px) saturate(.85); transform: scale(1.16); }'
        document.head.appendChild(st)
        return true
      `)
      await sleep(250)
    }
    try { await this.send('Page.bringToFront', {}, 3000) } catch { /* 不支持就算了 */ }
    // 把鼠标挪到角落: 悬停提示框(黑底 tag tooltip)会跟着光标走,
    // 光标停在页面中间时它正好卡在截图正中, 挡住内容(首轮实测踩到)。
    try {
      await this.send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: 2, y: 2, button: 'none' }, 5000)
      await sleep(400)
    } catch { /* 拿不到 Input 域就算了 */ }
    await this.scrub()
    if (process.env.SHOT_DEBUG) {
      // 截图里偶尔冒出一个不属于本页的浮层(悬停气泡 / toast), 按类名猜不如直接问 DOM
      const floats = await this.eval(`
        const out = []
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el)
          if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
          if (Number(cs.zIndex || 0) < 5) continue
          const r = el.getBoundingClientRect()
          if (r.width < 40 || r.height < 20 || r.top > innerHeight || r.bottom < 0) continue
          out.push(cs.position + ' z=' + cs.zIndex + ' ' + el.className +
            ' [' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + '] ' +
            (el.textContent || '').trim().slice(0, 40))
        }
        return out.slice(0, 12).join('\\n')
      `)
      console.log('[shot] 浮层探针:\n' + floats)
    }
    // title 只是悬停提示, 截图里本来就不该出现; 留着它, Chrome 的原生 tooltip
    // 会跟着上一张截图残留的悬停位置冒出来(实测挂在 chars.jpg 中间)。
    await this.eval(`
      for (const el of document.querySelectorAll('[title]')) el.removeAttribute('title')
      return true
    `)
    const r = await this.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 82, captureBeyondViewport: false,
    })
    const file = path.join(OUT, `${name}.jpg`)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    if (blur) {
      await this.eval(`document.getElementById('__shot_blur')?.remove(); return true`)
    }
    const kb = Math.round(fs.statSync(file).size / 1024)
    console.log(`[shot] ${name}.jpg  ${kb}KB  (${Date.now() - t0}ms)`)
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
  nav(txt) { __t.clickText('.hdr .nv', txt) },
  /** 系列墙 → 挑一张「角色数 > 0」的作品点进去。返回系列名, 方便日志。
   *  kw: 先在系列搜索框里过滤(库里的封面是历史挑的, 安全模式只管显示层,
   *  所以公开截图要挑一个封面干净的系列)。 */
  async openSeriesWithChars(kw = '') {
    __t.nav('系列')
    await new Promise(r => setTimeout(r, 1500))
    if (kw) {
      const inp = document.querySelector('.series-view input[placeholder*="搜索系列"]')
      if (!inp) throw new Error('找不到系列搜索框')
      inp.value = kw
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 1200))
    }
    const el = [...document.querySelectorAll('.series-view .ecard')].find(e => {
      const t = e.querySelector('.nums .ch')?.textContent || ''
      return parseInt(t.replace(/\\D/g, ''), 10) > 0
    })
    if (!el) throw new Error('系列墙里没有带角色数的卡片')
    const name = (el.querySelector('.name')?.textContent || '').trim()
    el.click()
    return name
  },
  /** 保证停在「某个系列的角色页」上 —— 已经在角色页就直接用, 别重复点(点不了系列墙) */
  async ensureCharsView(kw = '') {
    // 已经在角色页就沿用(上一张 shot 用的就是同一个系列), 别去点已经不存在的系列墙
    if (__t.text('.series-view').includes('选择导出')) return '已在角色页(沿用)'
    return await __t.openSeriesWithChars(kw)
  },
  esc() {
    for (const t of [document, window]) {
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
  },
  /** 关掉一切浮层: 遮罩点空白 + Esc, 回到"裸页面"。
   *  注意抽屉(TvDrawer)用的是 .drawer-mask, 不是 .mask —— 漏掉它会让设置抽屉
   *  一路挂在后面几张截图上(实测 scan/sources 两张全拍成了设置页)。 */
  async closeOverlays() {
    for (let i = 0; i < 4; i++) {
      if (!document.querySelector('.mask, .lightbox, .drawer-mask')) return true
      __t.esc()
      const x = document.querySelector('.lightbox .lb-close, .mask .x, .drawer .dhead .x')
      if (x) x.click()
      await new Promise(r => setTimeout(r, 500))
    }
    return !document.querySelector('.mask, .lightbox, .drawer-mask')
  },
}
return true`

/** 每个视图: 走到那个界面 -> 等渲染 -> shot。顺序有依赖, 别乱调。 */
const SHOTS = [
  {
    name: 'home',
    desc: '看板: 来源胶囊 + 安全模式',
    async run(cdp) {
      await waitFor(cdp, `__t.count('.home .grid .card') > 0`, { label: '首页卡片', timeout: 60000 })
      // 档位由启动前的 data/safety.json 决定(edge), 这里只核对, 不点界面
      const lv = await cdp.eval(`
        const s = await window.tv.invoke('safety:get')
        return JSON.stringify(s)
      `)
      console.log('[shot] safety:get =', lv)
      await cdp.eval(`__t.clickText('.src-bar .tv-chip', ${JSON.stringify(SRC)}); return true`)
      await sleep(1200)
      await waitFor(cdp, `__t.count('.home .grid .card') > 0 && __t.count('.home .grid .tv-img.loaded') > 0`,
        { label: '过滤后缩略图', timeout: 60000 })
      // WD14 引导横幅别出现在门面图里
      const banner = await cdp.eval(`
        if (document.querySelector('.wd14-banner')) { __t.clickText('.wd14-banner .acts .tv-btn', '暂不'); return true }
        return false
      `)
      console.log('[shot] WD14 横幅已收起 =', banner)
      await sleep(2500)
      await cdp.shot('home')
    },
  },
  {
    name: 'tags',
    desc: '标签库列表(搜一个中性词: 全量标签墙里成人向词太多, 不上 README)',
    async run(cdp) {
      await cdp.eval(`__t.nav('标签'); return true`)
      await waitFor(cdp, `__t.count('.tags-view .tag-list .pill') > 0`, { label: '标签列表', timeout: 40000 })
      // 全量标签墙里一堆成人向词, 公开 README 不放这种; 搜一个中性词,
      // 既演示「中英对照 + 计数 + 已ban隐藏」, 又不用把库里的成人词汇拍进去
      await cdp.eval(`
        const inp = document.querySelector('.tags-view .kw input')
        if (!inp) throw new Error('找不到标签搜索框')
        inp.value = ${JSON.stringify(TAG_KW)}
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      `)
      await sleep(400)
      const before = await cdp.eval(`return __t.count('.tags-view .tag-list .pill')`)
      await cdp.eval(`__t.clickText('.tags-view .bar .tv-btn', '搜索'); return true`)
      const after = await waitFor(cdp,
        `const n = __t.count('.tags-view .tag-list .pill'); return n > 0 && n !== ${before} ? n : false`,
        { label: '搜索结果', timeout: 40000 })
      console.log(`[shot] 标签搜索 ${TAG_KW}: ${before} -> ${after}, 首个 =`,
        await cdp.eval(`return __t.text('.tags-view .tag-list .pill')`))
      await sleep(1200)
      await cdp.shot('tags')
    },
  },
  {
    name: 'taggrid',
    desc: '点标签 → 就地叠一层的标签图集',
    async run(cdp) {
      await cdp.eval(`
        const pills = [...document.querySelectorAll('.tags-view .tag-list .pill')]
        const i = pills.findIndex(p => p.textContent.trim().startsWith('long_hair'))
        pills[i < 0 ? 0 : i].click()
        return i
      `)
      await waitFor(cdp, `__t.count('.tag-panel') > 0 && __t.count('.tag-panel .grid .card') > 0`,
        { label: '标签图集', timeout: 40000 })
      // 和看板一样只拍这个来源, 免得图墙上混进不该上 README 的东西
      await cdp.eval(`__t.clickText('.tag-panel .tv-chip', ${JSON.stringify(SRC)}); return true`)
      await sleep(2500)
      await waitFor(cdp, `__t.count('.tag-panel .tv-img.loaded') > 0`, { label: '图集缩略图', timeout: 40000 })
      await sleep(2000)
      await cdp.shot('taggrid')
    },
  },
  {
    name: 'lightbox',
    desc: '大图预览: 中英双标签 + 逐 tag 操作',
    async run(cdp) {
      await cdp.eval(`__t.click('.tag-panel .grid .card'); return true`)
      await waitFor(cdp, `!!document.querySelector('.lightbox')`, { label: 'lightbox', timeout: 20000 })
      await waitFor(cdp, `__t.count('.lightbox .lb-tags .pill') > 3`, { label: '标签渲染', timeout: 30000 })
      await sleep(2500)
      await cdp.shot('lightbox')
      await cdp.eval(`__t.closeOverlays(); return true`)
      await sleep(600)
    },
  },
  {
    name: 'series',
    desc: '系列浏览: 作品墙',
    async run(cdp) {
      await cdp.eval(`__t.nav('系列'); return true`)
      await waitFor(cdp, `__t.count('.series-view .ecard') > 0`, { label: '系列卡片', timeout: 60000 })
      if (SOURCE_KW) {
        await cdp.eval(`__t.clickText('.src-bar .tv-chip', ${JSON.stringify(SOURCE_KW)}); return true`)
        await sleep(2500)
      }
      await sleep(2000)
      await cdp.shot('series', { blur: '.series-view .ecard .tv-img' })
    },
  },
  {
    name: 'chars',
    desc: '点进作品 → 该系列的角色页(带 🛒)',
    async run(cdp) {
      const name = await cdp.eval(`return await __t.ensureCharsView(${JSON.stringify(SERIES_KW)})`)
      console.log('[shot] 进入系列:', name)
      await waitFor(cdp, `__t.count('.series-view .cat-bar') > 0 && __t.text('.series-view').includes('选择导出')`,
        { label: '角色页工具条', timeout: 60000 })
      await waitFor(cdp, `__t.count('.series-view .grid .ecard') > 0`, { label: '角色卡', timeout: 60000 })
      await sleep(2200)
      await cdp.shot('chars', { blur: '.series-view .ecard .tv-img' })
    },
  },
  {
    name: 'cart',
    desc: '角色购物车 / 我的清单',
    async run(cdp) {
      // 每条 shot 之间页面会复位到看板, 所以这里自己走一遍「进系列 → 全选 → 入车」
      await cdp.eval(`return await __t.ensureCharsView(${JSON.stringify(SERIES_KW)})`)
      await waitFor(cdp, `__t.text('.series-view').includes('选择导出')`, { label: '角色页工具条', timeout: 60000 })
      await sleep(800)
      await cdp.eval(`__t.clickText('.series-view .cat-bar .tv-btn', '选择导出'); return true`)
      await sleep(700)
      await cdp.eval(`__t.clickText('.series-view .cat-bar .tv-btn', '全选'); return true`)
      await sleep(700)
      await cdp.eval(`__t.clickText('.series-view .cat-bar .tv-btn', '全部加入购物车'); return true`)
      await sleep(1500)
      await cdp.eval(`__t.nav('购物车'); return true`)
      await waitFor(cdp, `__t.count('.cart-view .groups .group') > 0`, { label: '购物车分组', timeout: 40000 })
      await waitFor(cdp, `__t.count('.cart-view .tv-img.loaded') > 0`, { label: '购物车缩略图', timeout: 40000 })
      await sleep(2000)
      await cdp.shot('cart', { blur: '.cart-view .tv-img' })
    },
  },
  {
    name: 'dup',
    desc: '按标签查重: 一组疑似重复 + 保留建议',
    async run(cdp) {
      await cdp.eval(`__t.nav('看板'); return true`)
      await waitFor(cdp, `__t.count('.home .grid .card') > 0`, { label: '回看板', timeout: 40000 })
      await cdp.eval(`__t.clickText('.home .lnk .tv-btn', '查重'); return true`)
      await waitFor(cdp, `!!document.querySelector('.dup')`, { label: '查重面板', timeout: 20000 })
      await waitFor(cdp, `__t.count('.dup .grp') > 0 || __t.text('.dup .bar').includes('0')`,
        { label: '查重出组', timeout: 120000 })
      await sleep(2500)
      await cdp.shot('dup')
      await cdp.eval(`__t.closeOverlays(); return true`)
      await sleep(600)
    },
  },
  {
    name: 'presets',
    desc: '导出预设: 黑名单 / 替换 / 段位 / 自动导出',
    async run(cdp) {
      await cdp.eval(`__t.clickText('.home .lnk .tv-btn', '预设导出'); return true`)
      await waitFor(cdp, `!!document.querySelector('.mask .box')`, { label: '预设弹窗', timeout: 20000 })
      await sleep(1500)
      await cdp.shot('presets')
      await cdp.eval(`__t.closeOverlays(); return true`)
      await sleep(600)
    },
  },
  {
    name: 'rules',
    desc: '替换规则编辑器(左侧规则组 + 底部测试器)',
    async run(cdp) {
      await cdp.eval(`__t.clickText('.home .lnk .tv-btn', '替换规则'); return true`)
      await waitFor(cdp, `__t.count('.mask .box .side-item') > 0 || __t.count('.mask .box textarea') > 0`,
        { label: '规则编辑器', timeout: 20000 })
      await sleep(1200)
      await cdp.shot('rules')
      await cdp.eval(`__t.closeOverlays(); return true`)
      await sleep(600)
    },
  },
  {
    name: 'settings',
    desc: '设置抽屉',
    async run(cdp) {
      // 抽屉只盖住右边 600px, 左边那 1000px 会拍进背景 —— 先回到看板并按 SRC 过滤,
      // 别让它挂在标签图集那面墙上(首轮实测拍到了不该上 README 的东西)
      await cdp.eval(`__t.nav('看板'); return true`)
      await waitFor(cdp, `__t.count('.home .grid .card') > 0`, { label: '回看板', timeout: 40000 })
      await cdp.eval(`__t.clickText('.src-bar .tv-chip', ${JSON.stringify(SRC)}); return true`)
      await sleep(1800)
      await cdp.eval(`document.querySelector('[data-test="hdr-settings"]').click(); return true`)
      await waitFor(cdp, `!!document.querySelector('.settings')`, { label: '设置抽屉', timeout: 20000 })
      await sleep(1200)
      await cdp.shot('settings')
      await cdp.eval(`__t.closeOverlays(); return true`)
      await sleep(600)
    },
  },
  {
    name: 'scan',
    desc: '扫描页: 文件夹库',
    async run(cdp) {
      // 沙箱每轮都会把 folders 表清零, 这里把夹具目录登记回来(项目内沙箱路径, 不含私人信息)
      const reg = await cdp.eval(`
        const r = await window.tv.invoke('folders:add',
          { path: ${JSON.stringify(CTX.scanDir)}, as_source: true, as_scan: true, recursive: false })
        return JSON.stringify({ error: r?.error || null, keys: Object.keys(r || {}) })
      `)
      console.log('[shot] folders:add =', reg)
      // 只登记一个夹具夹的话, 这一页就只有一张卡片, 空得像是坏了。
      // 再把库里几个「小」来源同时登记成扫描夹(数量大的会现算缩略图, 会卡截图),
      // 路径仍然只留在沙箱 DB 里, 出图前一律走 scrub()
      const extra = await cdp.eval(`
        // folders:list 默认只给「扫描夹」那一档, 要显式要 source 档才有候选
        const list = await window.tv.invoke('folders:list', { usage: 'source' })
        const rows = Array.isArray(list) ? list : (list?.folders || list?.list || [])
        const cands = rows.filter(f => f.path && !f.as_scan && f.images > 0 && f.images <= 1500)
          .sort((a, b) => a.images - b.images)
          .slice(0, 2)
        const log = []
        for (const f of cands) {
          const r = await window.tv.invoke('folders:add',
            { path: f.path, as_source: true, as_scan: true, recursive: false })
          log.push((r?.ok ? 'ok ' : 'x  ') + f.name + '(' + f.images + ')')
        }
        return log.join(', ') || '无候选(共 ' + rows.length + ' 行)'
      `)
      console.log('[shot] 扫描页补登记:', extra)
      await cdp.eval(`location.hash = '#/scan'; return true`)
      await waitFor(cdp, `__t.count('.scan-view .grid.folders .ecard') > 0`,
        { label: '扫描夹列表', timeout: 40000 })
      await sleep(4000)
      await cdp.shot('scan')
    },
  },
  {
    name: 'sources',
    desc: '来源管理(路径已脱敏)',
    async run(cdp) {
      await waitFor(cdp, `!!document.querySelector('[data-test="goto-sources"]')`,
        { label: '扫描页来源入口', timeout: 20000 })
      await cdp.eval(`document.querySelector('[data-test="goto-sources"]').click(); return true`)
      await waitFor(cdp, `__t.count('.source-view .rows .row') > 0`, { label: '来源登记表', timeout: 20000 })
      await sleep(800)
      await cdp.shot('sources')
    },
  },
]

/* ------------------------------------------------------------ 主流程 */

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const work = ensureWorkDir()
  CTX.scanDir = work.scanDir

  // 安全模式: 启动前就写好 on:true + edge(应用启动时读 data/safety.json)
  const safetyPath = path.join(work.dataDir, 'safety.json')
  fs.writeFileSync(safetyPath, JSON.stringify({ on: true, level: 'edge' }, null, 2), 'utf8')
  console.log('[shot] 安全模式已预置 on:true level:edge ->', safetyPath)

  // 替换规则换成中性演示稿(沙箱副本, 真实库那份没动)
  const rulesPath = path.join(work.dataDir, 'user', 'replace_sets.json')
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true })
  fs.writeFileSync(rulesPath, JSON.stringify(DEMO_RULES, null, 2), 'utf8')
  console.log('[shot] 替换规则已换成演示稿 ->', rulesPath)

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
  // 统一出图尺寸: 不管窗口实际开多大, 都按 1600x1000 视口截
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  } catch { /* 老版本不支持就算了 */ }

  const wanted = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.name)) : SHOTS
  const failed = []
  try {
    await sleep(600)
    await clearPageState(cdp) // 清残留 localStorage(安全状态在 data/safety.json, 不受影响)
    await waitFor(cdp, `!!document.querySelector('#app .hdr')`, { label: '顶栏出现', timeout: 30000 })
    await cdp.eval(HELPERS)
    await waitFor(cdp, `
      const s = await window.tv.invoke('app:status')
      return s.phase === 'ready'
    `, { label: '数据集 ready', timeout: 180000 })

    const safeState = await cdp.eval(`
      const on = !!document.querySelector('.result-head .safe-tog.on')
      return { on, txt: __t.text('.result-head .safe-tog') }
    `)
    console.log('[shot] 安全模式 =', JSON.stringify(safeState))

    for (const s of wanted) {
      console.log(`\n[shot] ── ${s.name} · ${s.desc}`)
      try {
        await s.run(cdp)
      } catch (e) {
        failed.push(`${s.name}: ${e.message}`)
        console.error(`[shot] ✗ ${s.name} 失败: ${e.message}`)
        // 尽量把界面复位到看板, 别让一个视图失败拖垮后面全部
        try {
          await cdp.eval(`__t.closeOverlays(); return true`)
          await cdp.eval(`location.hash = '#/'; return true`)
          await sleep(800)
        } catch { /* 算了 */ }
      }
    }
    console.log(`\n[shot] 完成 ${wanted.length - failed.length}/${wanted.length} 张 -> ${OUT}`)
    if (cdp.errors.length) console.warn('[shot] 页面异常:', cdp.errors.slice(0, 5))
    if (failed.length) { console.warn('[shot] 失败清单:', failed); process.exitCode = 1 }
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
