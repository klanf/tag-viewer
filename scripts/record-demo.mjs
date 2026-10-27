/**
 * 介绍片 · 全屏录屏素材录制器
 * =============================
 * 目的：把「光箱 ban / 查重 / 购物车 / 系列墙」这些操作录成 **16:9 全屏** 素材，
 *       剪辑时整段切进 PPT 导出的视频里（不再放页面里的小窗口）。
 *
 * 为什么不用录屏软件手点：
 *   · 每条素材要和配音对齐（同一套动作、同样的落点），手点做不到可复现；
 *   · 素材必须满足两条硬条件：数据只来自「涩不了一点」、安全模式 edge 档 ——
 *     脚本里写死，跑之前还会断言一次；
 *   · 别的东西（通知、鼠标、桌面）不该进画面。
 *
 * 怎么拿到"看起来像真人操作"的画面：
 *   · 页面里注入一个**假光标**（pointer-events:none 的 SVG），用 rAF 补间移动；
 *   · 点击用 CDP 的 Input 域真派发（hover 态、mousePressed 都会真实触发），
 *     点击时在落点画一圈涟漪 —— 全屏录屏里这个比真鼠标还清楚；
 *   · 画面用 Page.startScreencast 抓帧（只抓页面，不含窗口边框 / 桌面 / 系统鼠标），
 *     带时间戳重排成 30fps，再用 ffmpeg 编码。
 *
 * 隔离：
 *   · 独立 userData + 数据副本（harness.ensureWorkDir），不碰用户真实库；
 *   · safety.json 每次写成 { on:true, level:'edge' }，和 README 截图同一套规矩。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/record-demo.mjs --only p04
 *   ... --only p04,p05 --scale 1600x900
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureWorkDir, clearPageState, freePort, sleep, ROOT } from './harness.mjs'
import { findElectron, electronEnv } from './electron-path.mjs'

const OUT = path.join(ROOT, 'docs', 'video', 'rec')
const FFMPEG = process.env.FFMPEG_PATH || [
  'D:/workbuddy/tools/bin/ffmpeg.exe',
  'F:/miniconda3/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
].find((p) => fs.existsSync(p)) || 'ffmpeg'

const args = process.argv.slice(2)
const argOf = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
const ONLY = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
let [VW, VH] = (argOf('scale', '1728x972')).split('x').map(Number)
const FPS = 30

/* ------------------------------------------------------------ CDP */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.log = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
        return
      }
      if (msg.method === 'Page.screencastFrame') this.onFrame?.(msg.params)
    })
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)) }
      }, timeoutMs)
    })
  }
  async eval(expr, timeoutMs = 60000) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
}

async function findPage(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((p) => p.type === 'page' && /dist[\\/]index\.html/.test(p.url))
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('等不到 app 页面')
}

/* ------------------------------------------------------------ 页面里的假光标 */
const CURSOR_JS = `
if (!window.__rec) {
  const css = document.createElement('style')
  css.id = '__rec_css'
  css.textContent = \`
    html, body, * { cursor: none !important; }
    /* 录屏时藏掉本机绝对路径：成片里不该出现 F:/Syncthing/... 这种目录结构 */
    .lb-path, .path-bar .disk, .scan-path { display: none !important; }
    /* 其余会带出本机目录的位置(2026-10-25 批量录制时补):
       导出预设那条 .ppath、预设表单的目录行、扫描夹卡片下面的路径副标题、
       来源管理的路径列(保留占位不塌布局, 只把字变成透明)。 */
    .prow .ppath, .box .dirrow { display: none !important; }
    /* 导出预设弹窗里那两块与旁白无关、又带本机目录的东西: 目标目录整段 + 购物车预设 */
    .box .fsec:has(.dirrow), .box .csec { display: none !important; }
    .dup .prio, .dup .fdir { display: none !important; }
    .grid.folders .ecard .en { visibility: hidden !important; }
    .cell.path-cell .p { visibility: hidden !important; }
    /* 图片卡片底下的文件名行(形如「新世界 / 某画师 / xxx_p0.png」)也带目录结构 */
    .grid .card .foot { visibility: hidden !important; }
    /* 设置抽屉的「外部程序」整段: 每行都是一个本机 exe 绝对路径, 与反推环境无关 */
    .drawer .settings > section:nth-of-type(3) { display: none !important; }
    /* 悬停卡片的英文标签气泡: 换页时鼠标底下正好生成一张卡, 气泡会糊在画面中间
       一两秒(还会盖住卡片), 片子里不需要这个信息 */
    .tip-bubble { display: none !important; }
    #__rec_cur { position: fixed; left: 0; top: 0; width: 24px; height: 24px; z-index: 2147483647;
      pointer-events: none; transform: translate(-3px, -3px);
      filter: drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
    #__rec_rip { position: fixed; left: 0; top: 0; width: 18px; height: 18px; z-index: 2147483646;
      pointer-events: none; border: 3px solid rgba(59,130,246,.95); border-radius: 50%;
      transform: translate(-50%,-50%) scale(.3); opacity: 0; }
  \`
  document.head.appendChild(css)
  const c = document.createElement('div')
  c.id = '__rec_cur'
  c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24">' +
    '<path d="M3 2l7.6 19 2.7-7.3 7.3-2.7z" fill="#fff" stroke="#1f2937" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  const rip = document.createElement('div'); rip.id = '__rec_rip'
  document.body.appendChild(c); document.body.appendChild(rip)

  const st = { x: innerWidth * 0.6, y: innerHeight * 0.7 }
  c.style.left = st.x + 'px'; c.style.top = st.y + 'px'

  window.__rec = {
    /** 元素的中心点（用视口坐标，CDP 输入也用这套坐标） */
    rect(sel, idx = 0) {
      const els = document.querySelectorAll(sel)
      const el = els[idx]
      if (!el) throw new Error('找不到元素 ' + sel + '[' + idx + '] · 命中 ' + els.length)
      let r = el.getBoundingClientRect()
      if (!r.width && !r.height) throw new Error('元素不可见 ' + sel)
      /* 滚出视口的元素: CDP 派发到负坐标等于没点（p09 第一版就是这么空点的）。
         先把元素滚到中间再量 —— scrollIntoView 是瞬时的, 不会多出一段动画。 */
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
        el.scrollIntoView({ block: 'center', inline: 'center' })
        r = el.getBoundingClientRect()
      }
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               w: Math.round(r.width), h: Math.round(r.height) }
    },
    text(sel, idx = 0) {
      const el = document.querySelectorAll(sel)[idx]
      return el ? el.textContent.trim() : ''
    },
    count(sel) { return document.querySelectorAll(sel).length },
    /** 补间移动：缓出，像人手的起停 */
    moveTo(x, y, ms = 620) {
      return new Promise((res) => {
        const sx = st.x, sy = st.y, t0 = performance.now()
        const ease = (t) => 1 - Math.pow(1 - t, 3)
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / ms), k = ease(t)
          st.x = sx + (x - sx) * k; st.y = sy + (y - sy) * k
          c.style.left = st.x + 'px'; c.style.top = st.y + 'px'
          if (t < 1) requestAnimationFrame(tick); else res({ x, y })
        }
        requestAnimationFrame(tick)
      })
    },
    moveToSel(sel, idx = 0, ms = 620) {
      const r = this.rect(sel, idx)
      return this.moveTo(r.x, r.y, ms)
    },
    ripple(x, y) {
      rip.style.left = x + 'px'; rip.style.top = y + 'px'
      rip.animate(
        [{ transform: 'translate(-50%,-50%) scale(.3)', opacity: .95 },
         { transform: 'translate(-50%,-50%) scale(2.6)', opacity: 0 }],
        { duration: 520, easing: 'ease-out' })
    },
  }
}
/* 原生 title 提示有两个坏处: 会带出本机绝对路径(文件夹卡/图片卡/路径列),
   又会在鼠标停够半秒后糊在画面中央两秒。录屏期间定期摘掉这些 title。 */
if (!window.__rec_title_killer) {
  window.__rec_title_killer = setInterval(() => {
    for (const el of document.querySelectorAll('.grid .card, .grid.folders .ecard, .cell.path-cell, .settings .mono, .prow .ppath')) {
      if (el.hasAttribute('title')) el.removeAttribute('title')
    }
  }, 200)
}
return true
`

/* ------------------------------------------------------------ 录制器 */
class Recorder {
  constructor(cdp) {
    this.cdp = cdp
    this.frames = []
    this.bytes = 0
    this.stack = []
  }
  async start() {
    this.frames = []
    this.bytes = 0
    this.cdp.onFrame = async ({ data, sessionId, metadata }) => {
      this.frames.push({ ts: metadata.timestamp, b64: data })
      this.bytes += data.length
      // 必须逐帧 ack：不 ack 的话 Chromium 发一两帧就停了（踩过）
      try { await this.cdp.send('Page.screencastFrameAck', { sessionId }) } catch { /* 收尾阶段 */ }
    }
    const r = await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
    })
    this.session = r
  }
  async stop() {
    await this.cdp.send('Page.stopScreencast')
    await sleep(120)
  }
  async encode(file) {
    const frames = this.frames
    if (frames.length < 3) throw new Error(`只抓到 ${frames.length} 帧`)
    const start = frames[0].ts, end = frames[frames.length - 1].ts
    const dur = Math.max(0.1, end - start)
    const want = Math.max(1, Math.round(dur * FPS))
    const picked = []
    let j = 0
    for (let i = 0; i < want; i++) {
      const t = start + i / FPS
      while (j + 1 < frames.length && frames[j + 1].ts <= t) j++
      picked.push(frames[j])
    }
    const ff = spawn(FFMPEG, [
      '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', file,
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    ff.stderr.on('data', (b) => { err += String(b) })
    for (const f of picked) {
      if (!ff.stdin.write(Buffer.from(f.b64, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r))
    }
    ff.stdin.end()
    const code = await new Promise((r) => ff.once('exit', r))
    if (code !== 0) throw new Error('ffmpeg 失败: ' + err.slice(-400))
    // 探一下成片尺寸，用来断言「确实是 16:9 的整屏」
    const probe = await new Promise((r) => {
      const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
      let s = ''
      p.stderr.on('data', (b) => { s += String(b) })
      p.once('exit', () => r(s))
    })
    const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(probe)
    return {
      dur: +(picked.length / FPS).toFixed(2), rawDur: +dur.toFixed(2), frames: frames.length,
      bytes: this.bytes, w: m ? +m[1] : 0, h: m ? +m[2] : 0,
    }
  }
}

/* ------------------------------------------------------------ 操作原语 */
function makeOps(cdp) {
  const T0 = { t: 0 }
  const log = []
  const mark = (what) => {
    log.push({ t: +(Date.now() - T0.t).toFixed(0), what })
  }
  const ops = {
    T0, log, mark,
    /** 停顿缩放：0.5~1。分镜里那些 1500~3200ms 的 wait 是给剪辑留的余量，
     *  但口播只有 window 秒 —— 余量留太多，最后一个动作就掉到窗口外面，观众看不到那一步。
     *  每条素材按实测配一个 dwell（见 docs/video/qa-rec.py），下限锁 600ms 免得糊成一闪而过。 */
    dwellScale: 1,
    async nav(route, readySel, timeout = 20000) {
      await cdp.eval(`location.hash = ${JSON.stringify(route)}; return true`)
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        try {
          if (await cdp.eval(`return !!document.querySelector(${JSON.stringify(readySel)})`)) {
            await sleep(350)
            mark(`nav ${route}`)
            return
          }
        } catch { /* 路由切换中 */ }
        await sleep(200)
      }
      throw new Error(`导航后等不到 ${readySel}`)
    },
    async wait(ms) {
      const d = Math.max(600, Math.round(ms * (ops.dwellScale || 1)))
      await sleep(d)
      mark(`wait ${ms}${d !== ms ? '→' + d : ''}`)
    },
    async hover(sel, idx = 0, ms = 620) {
      const r = await cdp.eval(`return await __rec.moveToSel(${JSON.stringify(sel)}, ${idx}, ${ms})`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
      await sleep(120)
      mark(`hover ${sel}`)
    },
    async click(sel, idx = 0, ms = 620) {
      const r = await cdp.eval(`return await __rec.moveToSel(${JSON.stringify(sel)}, ${idx}, ${ms})`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
      await sleep(140)
      await cdp.eval(`__rec.ripple(${r.x}, ${r.y}); return true`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(90)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 })
      mark(`click ${sel}`)
    },
    /** 点元素里的指定位置(fx/fy 0~1)。药丸的悬停浮层盖在右半段上, 点标签本体
     *  必须往左边缘偏 —— 点正中会落在 📋/🚫 上, 动作就成了复制。 */
    async clickAt(sel, idx = 0, fx = 0.5, fy = 0.5, ms = 620) {
      const r = await cdp.eval(`
        const el = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]
        if (!el) throw new Error('找不到元素 ' + ${JSON.stringify(sel)} + '[' + ${idx} + ']')
        let b = el.getBoundingClientRect()
        if (b.top < 0 || b.bottom > innerHeight) { el.scrollIntoView({ block: 'center' }); b = el.getBoundingClientRect() }
        const p = { x: Math.round(b.left + b.width * ${fx}), y: Math.round(b.top + b.height * ${fy}) }
        await __rec.moveTo(p.x, p.y, ${ms})
        return p
      `)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
      await sleep(140)
      await cdp.eval(`__rec.ripple(${r.x}, ${r.y}); return true`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(90)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 })
      mark(`clickAt ${sel} ${fx}`)
    },
    async clickText(sel, text, ms = 620) {
      const idx = await cdp.eval(`
        const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
        const i = els.findIndex((e) => e.textContent.includes(${JSON.stringify(text)}))
        if (i < 0) throw new Error('找不到含「' + ${JSON.stringify(text)} + '」的 ' + ${JSON.stringify(sel)})
        return i
      `)
      await ops.click(sel, idx, ms)
    },
    async scroll(sel, dy, ms = 700) {
      await cdp.eval(`
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) throw new Error('找不到滚动容器 ' + ${JSON.stringify(sel)})
        el.scrollBy({ top: ${dy}, behavior: 'smooth' })
        return true
      `)
      await sleep(ms)
      mark(`scroll ${sel} ${dy}`)
    },
    /* 打字：先点到输入框上（真鼠标按下抬起），再用 Input.insertText 一次性写入。
       insertText 走的是 Chromium 的 IME 提交路径，v-model 会像真人输入一样更新。 */
    async type(sel, text, idx = 0) {
      const r = await cdp.eval(`return __rec.rect(${JSON.stringify(sel)}, ${idx})`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
      await sleep(90)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(80)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(120)
      await cdp.send('Input.insertText', { text })
      mark(`type ${sel} = ${text}`)
    },
    /** 单键（Enter / Escape 之类），别用来打字 */
    async key(key) {
      const codes = { Enter: [13, 'Enter'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'] }
      const [vk, code] = codes[key] || [0, key]
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
      await sleep(40)
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
      mark(`key ${key}`)
    },
    /* 滚轮：ctrl=true 时给修饰键 2（Ctrl），用来驱动「Ctrl+滚轮缩放网格」。
       times 可以连发几档，一次补间只挪一次鼠标。 */
    async wheel(sel, dy, { ctrl = false, times = 1, gap = 90 } = {}) {
      const r = await cdp.eval(`return __rec.rect(${JSON.stringify(sel)})`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
      await sleep(80)
      for (let i = 0; i < times; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: dy, modifiers: ctrl ? 2 : 0,
        })
        await sleep(gap)
      }
      mark(`wheel ${sel} ${dy}x${times}${ctrl ? ' ctrl' : ''}`)
    },
    async eval(expr, what = 'eval') { const r = await cdp.eval(expr); mark(what); return r },
    /** 把假光标挪到空白处（不点击）。停在卡片上会挂出原生 title 提示，挡住半屏 */
    async park(fx = 0.5, fy = 0.82, ms = 420) {
      const r = await cdp.eval(`await __rec.moveTo(Math.round(innerWidth*${fx}), Math.round(innerHeight*${fy}), ${ms}); return true`)
      mark('park cursor')
      return r
    },
    /** 等元素出现（返回 false 表示超时，不抛异常，方便打诊断信息） */
    async waitSel(sel, timeout = 8000) {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        if (await cdp.eval(`return !!document.querySelector(${JSON.stringify(sel)})`)) return true
        await sleep(150)
      }
      return false
    },
  }
  return ops
}

/* ------------------------------------------------------------ 分镜（每条 = 一页的整段素材） */

/**
 * p05 的演示预设 —— 录之前现写一份干净的。
 * 为什么不在沙箱准备阶段写：`ensureWorkDir()` 每轮只从真实数据目录拷固定那几个状态文件，
 * user/ 目录不覆盖；但用户真实的预设可能带敏感来源名或目录。这里直接覆盖成一份演示用的，
 * 名字/筛选/段位开关都是片子里的说法，`dir` 指向沙箱里的一个真目录（虽然录屏里被 CSS 藏了，
 * 万一点了「立即导出」也不会写错地方）。
 * auto 先给 false：p04 在光箱里 ban 标签，若预设已开着自动导出，会当场触发一次导出/报错。
 */
function writeDemoPreset(work) {
  const dir = path.join(work.dataDir, 'export-demo')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now() - 3 * 60 * 1000
  const store = {
    version: 1,
    updated_at: Date.now(),
    autoDelayMs: 180000,
    presets: [{
      id: 'ep_demo01',
      name: 'ComfyUI 提示词',
      dir,
      file: 'ComfyUI 提示词.txt',
      auto: false,
      params: {
        source: ['涩不了一点'], q: '1girl', mode: 'any', match: 'contains',
        exclude: '', exclude_match: 'contains', exclude_char: true,
        spaces: true, blacklist: true, replace: true, bg: true,
        strip_char: true, strip_view: true, safe_only: true, seg_mode: true,
        with_path: false, replace_set: 'cat',
      },
      lastRunAt: now,
      lastCount: 2048,
      lastBytes: 118 * 1024,
      lastPath: path.join(dir, 'ComfyUI 提示词.txt'),
      lastTrigger: 'auto',
      lastError: '',
    }],
  }
  fs.writeFileSync(path.join(work.dataDir, 'user', 'export_presets.json'), JSON.stringify(store, null, 2))

  // 查重的「已忽略 / 永久忽略」也是落盘的: 不重置的话每录一次就吃掉一组真实数据，
  // 录到第三次面板就空了（还很难看出是脚本自己造的）
  const dup = { version: 2, pairs: [], blocked: [], updated_at: new Date().toISOString() }
  fs.writeFileSync(path.join(work.dataDir, 'user', 'dupcheck_ignore.json'), JSON.stringify(dup, null, 2))
}

/** 打开系列页，点进一个「角色够多」的作品，停在角色名单（p08/p10/p11 共用） */
async function openRichSeries(c, minChars = 6) {
  /* 先回看板再进系列: 上一镜可能把应用留在了某个系列的角色名单里。
     同一个路由下组件不会重建, 直接 nav('#/series') 等于"没动", 后面就会把
     一张角色卡当成系列卡点 —— 表现为「点进系列后等不到角色卡」。 */
  try { await c.nav('#/', '.grid .card', 25000) } catch (e) { console.log('[rec] 回看板失败(继续):', e.message) }
  await c.nav('#/series', '.series-view .grid .ecard', 25000)
  await c.wait(500)
  // 硬规矩: 只在「涩不了一点」这个来源里取素材（系列页默认是「全部」）
  try {
    await c.clickText('.src-bar .tv-chip', '涩不了一点', 600)
    await c.wait(1200)
  } catch (e) {
    console.log('[rec] 来源过滤失败(继续):', e.message)
  }
  const idx = await c.eval(`
    const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
    for (let i = 0; i < cards.length; i++) {
      const t = cards[i].querySelector('.nums')?.textContent || ''
      const m = /([\\d,]+) 角色/.exec(t)
      if (m && Number(m[1].replace(/,/g, '')) >= ${minChars}) return i
    }
    return 0
  `, 'pick rich series')
  await c.click('.series-view .grid .ecard', idx)
  const ok = await c.waitSel('.series-view .grid .ecard .cart-fab', 12000)
  if (!ok) throw new Error('点进系列后等不到角色卡')
  await c.wait(1200)
}

/** 按关键字打开一个指定系列，停在角色名单（片子要干净的素材，不能只挑「角色最多」那部） */
async function openSeriesByKw(c, kw) {
  try { await c.nav('#/', '.grid .card', 25000) } catch (e) { console.log('[rec] 回看板失败(继续):', e.message) }
  await c.nav('#/series', '.series-view .grid .ecard', 25000)
  await c.wait(500)
  try {
    await c.clickText('.src-bar .tv-chip', '涩不了一点', 600)
    await c.wait(1000)
  } catch (e) {
    console.log('[rec] 来源过滤失败(继续):', e.message)
  }
  await c.type('.cat-bar .kw input', kw)
  await c.wait(900)
  const n = await c.eval(`return document.querySelectorAll('.series-view .grid .ecard').length`, 'count series')
  if (!n) throw new Error('搜不到系列: ' + kw)
  await c.click('.series-view .grid .ecard', 0)
  if (!await c.waitSel('.series-view .grid .ecard .cart-fab', 12000)) throw new Error('点进系列后等不到角色卡')
  await c.wait(1000)
}

/** 系列 / 角色卡上的封面一律糊掉 —— 和 README 截图同一套办法（用户 2026-10-24 点头）。
 *  安全模式只管显示层，挡不住历史上自动挑好的封面；片子里只让名字和张数清楚。 */
async function blurCovers(c) {
  await c.eval(`
    if (!document.getElementById('__rec_blur_css')) {
      const st = document.createElement('style')
      st.id = '__rec_blur_css'
      st.textContent =
        'body.__rec_blur .ecard .tv-img{overflow:hidden}' +
        'body.__rec_blur .ecard .tv-img img{filter:blur(18px) saturate(.85);transform:scale(1.16)}' +
        /* 购物车里的角色缩略图也是「自动挑的封面」, 同一个处理 */
        'body.__rec_blur .cart-view .ci .thumb{overflow:hidden}' +
        'body.__rec_blur .cart-view .ci .thumb img{filter:blur(18px) saturate(.85);transform:scale(1.16)}' +
        /* 看板缩略图: p04/p05/p06/p07 的弹窗是压在「全部 84,380」上的,
           后面那面墙里有露点图; 这几条的重点是面板本身, 背景糊掉 */
        /* 图片网格一律糊掉：不再限定「首页」—— 光箱点标签后**就地叠的那一层**
           也是同一套 .grid .card（p03 的 f3 帧里那面墙就是漏网的），
           而安全模式 edge 档挡不住 breasts / midriff / fishnet 这类词。
           查重面板（.dup .item .thumb）和光箱主图（.lightbox）不在 .card 里，
           前者靠 prepare 的全年龄清场、后者靠名单挑图，都仍然显示原图。 */
        'body.__rec_blur .grid .card .tv-img{overflow:hidden}' +
        'body.__rec_blur .grid .card .tv-img img{filter:blur(18px) saturate(.85);transform:scale(1.16)}'
      document.head.appendChild(st)
    }
    document.body.classList.add('__rec_blur')
    return true
  `, 'blur covers')
}

/** 卡片悬停气泡（全局 .tip-bubble）在卡片被重排/销毁时收不回去 ——
 *  点进另一页后鼠标原地不动，新卡片会被算成"悬停着"，提示词就一直挂在画面中间。
 *  这里让当前所有卡片各发一次 mouseleave，store 收到就 hideTip。 */
async function hideTip(c) {
  await c.eval(`
    for (const el of document.querySelectorAll('.grid .card, .grid .ecard')) {
      el.dispatchEvent(new MouseEvent('mouseleave'))
    }
    return true
  `, 'hide tip')
}

/** 角色卡里「有图」的几张卡的下标（购物车演示用，避免加到 0 张的库内角色） */
async function pickCharCards(c, n = 3) {
  return c.eval(`
    const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
    const out = []
    for (let i = 0; i < cards.length && out.length < ${n}; i++) {
      const t = cards[i].querySelector('.nums')?.textContent || ''
      const m = /([\\d,]+) 张/.exec(t)
      if (!m || Number(m[1].replace(/,/g, '')) <= 0) continue
      if (!cards[i].querySelector('.cart-fab')) continue
      /* 「有图」得看**渲染出来**的那张：封面是自动挑的，演示库里有些角色的封面文件
         已经不存在（或被安全模式挡掉），入车后购物车就是一张纯黑占位卡 —— 观众看到的是 bug。
         所以只挑 img 真加载成功（complete && naturalWidth>0）的卡。 */
      const im = cards[i].querySelector('.tv-img img, img')
      if (!im || !im.complete || !im.naturalWidth) continue
      out.push(i)
    }
    return out
  `, 'pick char cards')
}

/** 角色名单里「图最多」的那张卡（p11 演示"点进去两步到图"用） */
async function pickRichCharCard(c) {
  return c.eval(`
    const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
    let best = 0, bestN = -1
    for (let i = 0; i < cards.length && i < 20; i++) {
      const b = cards[i].getBoundingClientRect()
      if (b.top < 130 || b.bottom > innerHeight - 30) continue
      const m = /([\\d,]+) 张/.exec(cards[i].querySelector('.nums')?.textContent || '')
      const n = m ? Number(m[1].replace(/,/g, '')) : 0
      if (n > bestN) { bestN = n; best = i }
    }
    return best
  `, 'pick rich char card')
}

/* ---------------------------------------------------------------- 共用取景 */
/** 光箱里有**两份** .lb-tags：前面那份是图内元数据（库内没这个词时点了只复制），
 *  后面那份才是全库标签（点了才开标签层）。先标记最后一份，后面都用这个选择器。 */
const MAIN_TAG_LIST = '.lightbox .lb-tags[data-rec="main"]'

const DEMO_SOURCE = '涩不了一点'

/* ---------------------------------------------------------------- 全年龄门禁 */
/**
 * 介绍片是公开物料，而**光箱里的原图不受安全模式遮挡**（edge 档只挡缩略图/封面/系列图），
 * 所以凡是要开光箱的镜头都得自己挑图。2026-10-25 QA 时 p15 就翻出一张紧身衣图。
 *
 * 这份名单比应用自带的 core/edge **更严**：那两份没有 breasts / thighs / bodystocking
 * 这类「不露骨但也不适合出现在宣传片里」的词。名单只用于录屏选图，
 * 不写进 safety_tags.txt —— 那样会把 demo 库藏掉八成，画面反而空了。
 */
const UNSAFE_TAGS = new Set([
  // 应用自己的 core 档
  'nude', 'completely_nude', 'nipples', 'pussy', 'penis', 'sex', 'vaginal', 'anal',
  'cum', 'cum_in_pussy', 'anus', 'pussy_juice', 'bottomless', 'topless', 'spread_pussy',
  'areola_slip', 'masturbation', 'fellatio', 'orgasm',
  // 应用自己的 edge 档
  'underwear', 'panties', 'no_panties', 'underwear_only', 'breasts_out', 'cleavage',
  'ass', 'thighhighs', 'swimsuit', 'bikini', 'lingerie', 'bondage', 'sex_toy',
  'pubic_hair', 'nipple_slip', 'covered_nipples', 'censored', 'mosaic_censoring', 'uncensored',
  // 宣传片额外收紧的
  'breasts', 'large_breasts', 'medium_breasts', 'small_breasts', 'huge_breasts',
  'perky_breasts', 'breast_squeeze', 'boobs', 'navel', 'midriff', 'bare_shoulders',
  'bareback', 'thighs', 'bare_thighs', 'thigh_strap', 'garter_straps', 'pantyhose',
  'bodystocking', 'leotard', 'unitard', 'catsuit', 'straitjacket', 'see_through',
  'skirt_lift', 'shirt_lift', 'dress_lift', 'top_lift', 'shorts_under_clothes',
  'spread_legs', 'legs_up', 'mound_of_venus', 'cameltoe', 'seductive', 'sexy',
  'provocative', 'eroge', 'ecchi', 'yuri', 'hardcore',
].filter((t) => !t.includes(' ')))
/** 前缀/包含式补充：white_panties、school_swimsuit、black_leotard 这类派生词。
 *  下划线是有意为之的护栏：'cum' 会误杀 cumulonimbus_cloud（积雨云），
 *  '_lift' 会误杀 wind_lift（风吹起头发），'anal' 会误杀 canal_boat —— 都是实测踩到的。 */
const UNSAFE_STEMS = [
  'breast', 'boob', 'nude', 'panties', 'underwear', 'lingerie', 'swimsuit', 'bikini',
  'pantyhose', 'bodystocking', 'leotard', 'cleavage', 'cameltoe', 'see-through',
  'see_through', 'thighhigh', 'topless', 'bottomless', 'nipple', 'pussy', 'penis',
  'sex_', '_sex', 'sexy', 'fellatio', 'masturbat', 'cunnilingus', 'erection',
  'paizuri', 'cum_', '_cum', 'genital', 'butt_', 'buttplug', 'vibrator',
  'anal_', '_anal', 'skirt_lift', 'shirt_lift', 'dress_lift', 'top_lift',
  'blouse_lift', 'sweater_lift', 'hoodie_lift', 'jacket_lift', 'uniform_lift',
]

/** 一个词算不算「不该进画面」 */
function isUnsuitableTag(t) {
  const s = String(t).toLowerCase().trim()
  return UNSAFE_TAGS.has(s) || UNSAFE_STEMS.some((k) => s.includes(k))
}

/** 页面里那段判据（两个 eval 共用，别抄两份） */
const CLEAN_FILTER_JS = `
  const EXACT = new Set(${JSON.stringify([...UNSAFE_TAGS])})
  const STEMS = ${JSON.stringify(UNSAFE_STEMS)}
  const bad = (t) => {
    const s = String(t).toLowerCase().trim()
    return EXACT.has(s) || STEMS.some((k) => s.includes(k))
  }
`

/**
 * 在 prepare（不入录像）里把整个 demo 库过一遍，把合格的图存成 window.__rec_clean。
 * 为什么不能等点开再看：光箱里的原图**已经显示在画面上了**，
 * "翻开一看不对再关掉"这个动作本身就是漏。
 */
async function planCleanCards(c, source = DEMO_SOURCE) {
  const r = await c.eval(`
    ${CLEAN_FILTER_JS}
    const clean = new Map()
    let err = '', total = 0, scanned = 0
    try {
      // demo 库 9,971 张，全扫一遍才够（limit 2000 分页）；这一步在 prepare 里，不入录像
      for (let off = 0; off < 12000; off += 2000) {
        const d = await window.tv.invoke('search:do', {
          q: '', mode: 'any', match: 'contains', exclude_char: '1',
          limit: 2000, offset: off, source: ${JSON.stringify(source)},
        })
        total = d.total || 0
        const page = d.results || []
        for (const it of page) {
          const tags = (it.tags || []).map((t) => String(t))
          if (!tags.length || tags.some(bad)) continue
          clean.set(it.path, tags.length)
        }
        scanned += page.length
        if (!page.length || scanned >= total) break
      }
    } catch (e) { err = String((e && e.message) || e) }
    window.__rec_clean = clean
    return { err, total, scanned, clean: clean.size }
  `, 'build all-ages pool')
  if (r.err) console.log('[rec] !! 全年龄名单构建失败（开光箱时会退回现场翻图）:', r.err)
  console.log(`[rec] 全年龄名单: 扫 ${r.scanned}/${r.total} 张 → 合格 ${r.clean} 张`)
  return r
}

/** 把名单和**当前已渲染的卡**对上（卡的 img src 是
 *  `tv://thumb/?p=<encodeURIComponent(路径)>&w=...`，路径能一比一还原）。 */
async function pickCleanCards(c) {
  return c.eval(`
    const clean = window.__rec_clean
    if (!clean || !(clean instanceof Map)) return { err: '没先跑 planCleanCards', hit: [], shown: 0, pool: 0, c: 0 }
    const wrap = document.querySelector('.home .grid-wrap') || document.scrollingElement
    const cards = [...document.querySelectorAll('.grid .card')]
    const hit = []
    for (let i = 0; i < cards.length; i++) {
      const img = cards[i].querySelector('img')
      const m = img && /[?&]p=([^&]+)/.exec(img.src || '')
      if (!m) continue
      let p = ''
      try { p = decodeURIComponent(m[1]) } catch { continue }
      const n = clean.get(p)
      if (n === undefined) continue
      const r = cards[i].getBoundingClientRect()
      hit.push({ i, n, c: Math.round(r.top), vis: r.top > 130 && r.bottom < innerHeight - 40 && r.width > 60 })
    }
    hit.sort((a, b) => (b.vis - a.vis) || (b.n - a.n))
    return { err: '', pool: clean.size, shown: cards.length, c: Math.round(wrap ? wrap.scrollTop : 0), hit: hit.slice(0, 8) }
  `, 'match all-ages pool to rendered cards')
}

/** 把「整张都在屏上」的候选滚进画面：卡片顶部离视口上沿还差 dy 就滚 dy。
 *  只动一次、动一小段，画面看着就是「往下翻了一下」，不是乱跳。 */
async function scrollToCandidate(c, cardTop) {
  await c.eval(`
    const wrap = document.querySelector('.home .grid-wrap') || document.scrollingElement
    wrap.scrollTop += ${Math.max(0, cardTop - 170)}
    return Math.round(wrap.scrollTop)
  `, 'scroll candidate into view')
  await c.wait(900)
}

/** 看板里挑一张「全年龄 + 标签够多」的卡开光箱（p03/p06/p11/p15 共用）。
 *  返回点开的卡片下标；一张都不合格就抛错（宁可录坏一条，也不把不该出现的图录进公开片）。 */
async function openHomeLightbox(c, minPills = 8) {
  const tried = new Set()
  // demo 库实测「全年龄」只占 ~8%（158/2000），一屏里期望命中 1~2 张；
  // 没有就往下滚一段再看，滚动是正常操作，比「点开一张不对再关掉」体面得多。
  for (let round = 0; round < 8; round++) {
    const pick = await pickCleanCards(c)
    if (pick.err) { console.log('[rec] !! ' + pick.err); break }
    const cand = pick.hit.filter((h) => h.vis && !tried.has(h.i))
    console.log(`[rec] 全年龄候选: 名单 ${pick.pool} / 已渲染 ${pick.shown} / 滚 ${pick.c} / 屏上合格 ${cand.length} 张 [${cand.map((h) => h.i + ':' + h.n).join(' ')}]`)
    if (!cand.length) {
      // 有合格图但只露了半张：先把它整张滚进来（比滚一屏省，画面上也只是动一小格）
      const near = pick.hit.filter((x) => !x.vis && !tried.has(x.i)).sort((a, b) => a.c - b.c)[0]
      if (near) { console.log(`[rec] 第 ${near.i} 张只露了半张(top ${near.c})，滚进来`); await scrollToCandidate(c, near.c); continue }
      // 屏上完全没有：滚一屏（滚不动说明到底了，报错停录）
      const before = pick.c
      await c.scroll('.home .grid-wrap', 780, 700)
      await c.wait(1200)
      const after = await c.eval(`const w = document.querySelector('.home .grid-wrap') || document.scrollingElement; return Math.round(w.scrollTop)`, 'scroll top')
      if (Math.abs(after - before) < 20) { console.log('[rec] !! 滚不动了(到底/被锁)，停止翻候选'); break }
      continue
    }
    const h = cand[0]
    tried.add(h.i)
    await c.click('.grid .card', h.i, 460)
    if (!await c.waitSel('.lightbox', 6000)) continue
    await c.wait(800)
    const info = await c.eval(`
      ${CLEAN_FILTER_JS}
      const lists = [...document.querySelectorAll('.lightbox .lb-tags')]
      const main = lists[lists.length - 1]
      if (!main) return { n: 0, bad: [] }
      main.dataset.rec = 'main'
      const tags = [...main.querySelectorAll('.pill')].map((p) => p.dataset.tag || '')
      return { n: tags.length, bad: tags.filter(bad) }
    `, 'mark main tag list + 复核名单')
    if (info.n >= minPills && !info.bad.length) {
      console.log('[rec] 光箱用第', h.i, '张, 标签', info.n, '个（全年龄）')
      return h.i
    }
    console.log('[rec] 第', h.i, '张复核不合格:', info.bad.length ? JSON.stringify(info.bad.slice(0, 4)) : `标签只有 ${info.n} 个`)
    await c.click('.lightbox .lb-close', 0, 320)
    await c.wait(600)
  }
  throw new Error('这一屏凑不够一张「标签够多又全年龄」的图')
}

/** 光箱标签区里挑一个「内容词」（不要 solo 这类元词、不要角色/系列），
 *  点药丸左边缘：悬停浮层（📋/🚫）盖在右半段，点正中会点成复制。 */
async function clickContentTag(c, sel, idx = 0, ms = 520) {
  const i = await c.eval(`
    const list = document.querySelector(${JSON.stringify(MAIN_TAG_LIST)})
    const pills = [...list.querySelectorAll('.pill:not(.k-char):not(.k-series):not(.banned)')]
    const prefer = ['long_hair', 'blue_sky', 'white_dress', 'dress', 'smile',
                    'looking_at_viewer', 'outdoors', 'school_uniform', 'hair_ornament']
    for (const p of prefer) {
      const j = pills.findIndex((x) => x.dataset.tag === p)
      if (j >= 0) return j
    }
    return ${idx}
  `, 'pick content tag pill')
  await c.clickAt(`${sel} .pill:not(.k-char):not(.k-series):not(.banned)`, i, 0.16, 0.5, ms)
  return i
}

/** 角色名单里连点 n 张卡的右上角入车（只挑「有图」的，0 张的库内角色入车很难看） */
async function addCharsToCart(c, n = 2) {
  const idxs = await pickCharCards(c, n)
  if (!idxs.length) throw new Error('角色名单里找不到有图的卡')
  console.log('[rec] 入车角色卡', JSON.stringify(idxs))
  for (const i of idxs) {
    await c.hover('.series-view .grid .ecard .cart-fab', i, 460)
    await c.wait(260)
    await c.click('.series-view .grid .ecard .cart-fab', i, 400)
    await c.wait(520)
  }
  return idxs
}

/** 系列墙：找一个「角色够多」的作品卡下标（排除当前正在看的这个） */
async function pickOtherSeries(c, minChars = 4) {
  return c.eval(`
    const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
    for (let i = 0; i < cards.length; i++) {
      const t = cards[i].querySelector('.nums')?.textContent || ''
      const m = /([\\d,]+) 角色/.exec(t)
      if (m && Number(m[1].replace(/,/g, '')) >= ${minChars}) return i
    }
    return 0
  `, 'pick other series')
}

/** 设置抽屉里按「左列文案」找一行并悬停（有 ⓘ 就停在 ⓘ 上，气泡才会出来）。
 *  行号不能写死：prepare 会把带本机路径的行 display:none（如 Python 行），
 *  按下标点就点到隐藏行上 ——  recorder 直接报「元素不可见」。 */
async function hoverSetting(c, kw, dwell = 1600, moveMs = 460) {
  const where = await c.eval(`
    for (const e of document.querySelectorAll('[data-rec-set]')) e.removeAttribute('data-rec-set')
    const rows = [...document.querySelectorAll('.drawer .settings .row')]
    const row = rows.find((r) => (r.querySelector('.k')?.textContent || '').includes(${JSON.stringify(kw)}))
    if (!row) return 'missing'
    row.scrollIntoView({ block: 'center' })
    const tip = row.querySelector('.itip')
    const el = tip || row
    el.setAttribute('data-rec-set', '1')
    return tip ? 'tip' : 'row'
  `, 'find setting ' + kw)
  if (where === 'missing') { console.log('[rec] !! 设置里找不到「' + kw + '」'); return false }
  await c.wait(260)
  await c.hover('[data-rec-set]', 0, moveMs)
  await c.wait(dwell)
  return true
}

/** 清空一个输入框。type() 是「点一下再插字」，光标落在原有文字后面，
 *  所以往填过的框里再 type 就是**追加**（p12 的测试条就是这么变成 1girlthigh_socks 的）。
 *  Vue 的 v-model 只认原生 setter，直接 el.value='' 不会触发更新。 */
async function clearInput(c, sel) {
  const ok = await c.eval(`
    const el = document.querySelectorAll(${JSON.stringify(sel)})[0]
    if (!el) return false
    const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set
    el.focus()
    if (set) set.call(el, ''); else el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `, 'clear ' + sel)
  if (!ok) console.log('[rec] !! 清空失败（没有这个输入框）:', sel)
  await c.wait(260)
  return ok
}

const SHOTS = [
  {
    id: 'p03',
    title: '看板：来源收窄 + 真实比例 + 中英文搜索 + 就地叠层',
    intro: 8.98,
    win: 24.24, dwell: 0.60,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(600)
      /* 这一镜的主角就是那面图墙，而安全模式 edge 档挡不住「breasts / midriff / pantyhose」
         这类词（应用的名单里确实没有它们）—— 缩略图会原样上镜。
         和 p04/p13/p15 同一套办法：封面一律糊掉，真实比例的排布照样看得清，
         内容却不会进公开片子。光箱里那张是走全年龄名单挑的，不受影响。 */
      await blurCovers(c)
      // 先把「涩不了一点」这一屏焐热（缩略图由主进程串行生成，正片里点完不该一排黑卡），
      // 再切回「全部」—— 点来源这一步留给正片：口播第一句就是「点一下就只看这个文件夹」，
      // 画面必须在切进来的那一刻真的去点它（2026-10-25 复盘：画外点掉 = 音画对不上）。
      try { await c.clickText('.src-bar .tv-chip', '涩不了一点', 600) } catch (e) {
        console.log('[rec] 来源预热失败(继续):', e.message)
      }
      await c.wait(1400)
      await c.scroll('.home .grid-wrap', 700, 700)
      await c.wait(1600)
      await c.scroll('.home .grid-wrap', -3000, 400)
      await c.wait(400)
      try { await c.clickText('.src-bar .tv-chip', '全部', 460) } catch (e) {
        console.log('[rec] 回「全部」失败(继续):', e.message)
      }
      await c.wait(1200)
      await planCleanCards(c)
    },
    async run(c) {
      // 1) 来源收窄（口播第一句）+ 真实比例图墙：点一下只看这个文件夹，再滚一屏
      await c.hover('.src-bar .tv-chip', 4, 420)
      await c.wait(300)
      await c.clickText('.src-bar .tv-chip', '涩不了一点', 460)
      await c.wait(1300)
      await c.scroll('.home .grid-wrap', 620, 900)
      await c.wait(800)
      await c.scroll('.home .grid-wrap', 460, 800)
      await c.wait(700)
      // 2) 搜索：中文词也能搜 —— 但走的是「联想」那条路（后端 zhIndex 反查英文标签），
      //    网格搜索本身只比英文标签，所以打中文后要**点联想项**，不是直接回车。
      //    词要挑「是译名的子串」的那种：补全按 zh.includes(输入) 匹配，
      //    敲「白头发」匹配不上译名「白发」，下拉是空的（2026-10-25 实测零命中）。
      await c.type('.panel .sug input', '白发')
      await c.wait(1700)
      const sug = await c.eval(`
        return [...document.querySelectorAll('.sug .drop .item')]
          .slice(0, 3).map((e) => (e.innerText || '').replace(/\\n+/g, ' ').trim())
      `, 'inspect zh suggestions')
      console.log('[rec] 中文联想:', JSON.stringify(sug))
      let picked = false
      try {
        await c.hover('.sug .drop .item', 0, 460)
        await c.click('.sug .drop .item', 0, 420)
        picked = true
      } catch (e) { console.log('[rec] !! 联想项点不到:', e.message) }
      if (!picked) {                       // 兜底：改成直接搜英文标签，画面别停在零结果上
        await clearInput(c, '.panel .sug input')
        await c.type('.panel .sug input', 'white_hair')
        await c.wait(1000)
      }
      await c.wait(900)
      await c.clickText('.btns .tv-btn', '搜索')
      await c.wait(2200)
      const hit = await c.eval(`return document.querySelectorAll('.grid .card').length`, 'search result count')
      console.log('[rec] 搜索命中', hit, '张')
      if (!hit) console.log('[rec] !! 搜索零结果（不中断，继续拍就地叠层）')
      await c.wait(900)
      await c.clickText('.btns .tv-btn', '清空')
      await c.wait(1400)
      // 3) 就地叠层：开光箱 → 点一个标签 → 当场按这个标签重筛一层，不退页面
      await openHomeLightbox(c)
      await c.wait(700)
      await clickContentTag(c, MAIN_TAG_LIST)
      if (!await c.waitSel('.tag-panel .grid .card', 10000)) {
        const st = await c.eval(`return {
          panel: !!document.querySelector('.tag-panel'),
          text: (document.querySelector('.tag-panel')?.innerText || '').slice(0, 160),
        }`)
        throw new Error('标签层没出图: ' + JSON.stringify(st))
      }
      await c.wait(900)
      try {
        await c.clickText('.tag-panel .ss-bar .tv-chip', '涩不了一点', 500)
        await c.wait(900)
      } catch (e) { console.log('[rec] 标签层来源过滤失败(继续):', e.message) }
      await c.hover('.tag-panel .tag-name', 0, 380)
      await c.wait(300)
      await c.scroll('.tag-panel .scroll', 420, 800)
      await c.wait(1000)
      // 4) 左上角返回一层：光箱原样拉回来（滚动位置没丢），再关掉
      await c.click('.pathbar .back', 0, 520)
      await c.wait(1600)
      // 不再点「关光箱」收尾：那一拍落在 24.1s，窗口只有 24.24s，切点正好把
      // 关闭动画切掉 —— 停在「返回一层后重新看见光箱」这一帧收场更干净。
    },
  },

  {
    id: 'p04',
    title: '系列墙：分类收口 → 点进作品 → 点进角色 → 图墙 + 入车 + ban + 缩放',
    intro: 6.98,
    win: 34.66, dwell: 0.72,
    async prepare(c) {
      try { await c.nav('#/', '.grid .card', 25000) } catch (e) { console.log('[rec] 回看板失败(继续):', e.message) }
      await c.nav('#/series', '.series-view .grid .ecard', 25000)
      await c.wait(800)
      try {
        await c.clickText('.src-bar .tv-chip', '涩不了一点', 600)
        await c.wait(1400)
      } catch (e) { console.log('[rec] 来源过滤失败(继续):', e.message) }
      // 三个分类的头两屏先翻一遍焐热封面，再把镜头放回原位（prepare 不进画面）
      for (const name of ['游戏', '动漫', '全部']) {
        try {
          await c.clickText('.cat-bar .tab', name, 0)
          await c.wait(900)
          await c.scroll('.series-view .body .scroll', 620, 300)
          await c.wait(1500)
          await c.scroll('.series-view .body .scroll', -3000, 200)
          await c.wait(350)
        } catch (e) { console.log('[rec] 封面预热跳过', name, e.message) }
      }
      await blurCovers(c)
      await c.eval(`localStorage.setItem('tv_grid_zoom', '1'); return true`, 'reset zoom')
      await c.wait(400)
    },
    async run(c) {
      // 1) 墙上停一拍：卡片直接把「多少个角色 / 多少张图」写在脸上
      await c.wait(700)
      const idx = await c.eval(`
        const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
        for (let i = 0; i < cards.length; i++) {
          const b = cards[i].getBoundingClientRect()
          const m = /([\\d,]+) 角色/.exec(cards[i].querySelector('.nums')?.textContent || '')
          if (b.top > 130 && b.bottom < innerHeight - 30 && m && Number(m[1].replace(/,/g, '')) >= 6) return i
        }
        return 0
      `, 'pick rich series to hover')
      await c.hover('.series-view .grid .ecard .nums', idx, 600)
      await c.wait(1000)
      // 2) 顶上按游戏 / 动漫 / Vtuber 收口：现场挑两个「真有点东西」的分类来回切
      const tabIdx = await c.eval(`
        const tabs = [...document.querySelectorAll('.cat-bar .tab')]
        const out = []
        for (let i = 1; i < tabs.length && out.length < 2; i++) {
          const m = /(\\d+)/.exec(tabs[i].textContent || '')
          if (m && Number(m[1]) >= 3) out.push(i)
        }
        return out
      `, 'pick category tabs')
      if (tabIdx.length < 2) throw new Error('分类 tab 不够: ' + JSON.stringify(tabIdx))
      for (const t of tabIdx) {
        await c.scroll('.series-view .body .scroll', -3000, 350)
        await c.click('.cat-bar .tab', t, 500)
        await c.wait(900)
        await c.scroll('.series-view .body .scroll', 560, 800)
        await c.wait(700)
      }
      await c.scroll('.series-view .body .scroll', -3000, 350)
      await c.click('.cat-bar .tab', 0, 500)
      await c.wait(800)
      // 3) 搜一个干净的作品进去（旁白说的「两步到图」）
      await c.type('.cat-bar .kw input', '芙莉莲')
      await c.wait(1700)
      await c.click('.series-view .grid .ecard', 0, 520)
      if (!await c.waitSel('.series-view .grid .ecard .cart-fab', 12000)) throw new Error('点进系列后等不到角色卡')
      await c.wait(1500)
      const richChar = await pickRichCharCard(c)
      await c.hover('.series-view .grid .ecard .nums', richChar, 500)
      await c.wait(700)
      // 4) 第二步：点角色 → 他名下全部图
      await c.click('.series-view .grid .ecard', richChar, 460)
      await c.park(0.55, 0.085, 260)
      if (!await c.waitSel('.series-view .grid .card', 9000)) throw new Error('点角色后没出图')
      await hideTip(c)
      await c.wait(400)
      await c.scroll('.series-view .body .scroll', 300, 700)
      await c.wait(900)
      await c.click('.pathbar .back', 0, 420)
      await c.wait(900)
      // 5) 右上角入车
      const cartIdx = await c.eval(`
        const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
        for (let i = 0; i < cards.length; i++) {
          const b = cards[i].getBoundingClientRect()
          if (b.top < 130 || b.bottom > innerHeight - 30) continue
          const m = /([\\d,]+) 张/.exec(cards[i].querySelector('.nums')?.textContent || '')
          if (m && Number(m[1].replace(/,/g, '')) > 0 && i !== ${richChar}) return i
        }
        return 1
      `, 'pick cart card')
      await c.hover('.series-view .grid .ecard .cart-fab', cartIdx, 460)
      await c.wait(300)
      await c.click('.series-view .grid .ecard .cart-fab', cartIdx, 420)
      await c.wait(1100)
      // 6) 识别错了 → ban 掉，不再出现
      const banIdx = await c.eval(`
        const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
        for (let i = 0; i < cards.length; i++) {
          if (i === ${richChar} || i === ${cartIdx}) continue
          const b = cards[i].getBoundingClientRect()
          if (b.top < 130 || b.bottom > innerHeight - 30) continue
          const m = /([\\d,]+) 张/.exec(cards[i].querySelector('.nums')?.textContent || '')
          if (m && Number(m[1].replace(/,/g, '')) > 0) return i
        }
        return 2
      `, 'pick ban card')
      await c.hover('.series-view .grid .ecard', banIdx, 360)
      await c.wait(260)
      await c.hover('.series-view .grid .ecard .more-btn', banIdx, 280)
      await c.wait(220)
      await c.click('.series-view .grid .ecard .ban-btn', banIdx, 280)
      if (!await c.waitSel('.mask .box .ban-ask', 5000)) throw new Error('ban 确认弹窗没开')
      await c.wait(700)
      try { await c.hover('.mask .box .foot .tv-btn', 0, 340) } catch (e) { console.log('[rec] 取消悬停跳过:', e.message) }
      await c.wait(400)
      await c.clickText('.mask .box .foot .tv-btn', '确认屏蔽', 380)
      await c.wait(1200)
      // 7) 整面墙 Ctrl+滚轮缩放 → 点徽标回 100%
      await c.wheel('.series-view .body .scroll', -120, { ctrl: true, times: 2, gap: 320 })
      await c.wait(700)
      await c.click('.zoom-badge', 0, 220)
      await c.wait(1500)
      // 8) 缩回 100% 后再顺着墙滚一段：这条素材要有「整面墙」的收尾，不能停在一帧上
      await c.scroll('.series-view .body .scroll', 820, 900)
      await c.wait(900)
      const endIdx = await c.eval(`
        const cards = [...document.querySelectorAll('.series-view .grid .ecard')]
        for (let i = 0; i < cards.length; i++) {
          const b = cards[i].getBoundingClientRect()
          if (b.top > 150 && b.bottom < innerHeight - 40) return i
        }
        return 0
      `, 'pick visible card for ending')
      await c.hover('.series-view .grid .ecard .nums', endIdx, 520)
      await c.wait(2500)
    },
  },

  {
    id: 'p06',
    title: '光箱：复制全部标签 → ban 一个词 → 点标签跳查',
    intro: 10.9,
    win: 31.1, dwell: 0.80,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(500)
      try { await c.clickText('.src-bar .tv-chip', '涩不了一点', 600) } catch (e) {
        console.log('[rec] 来源过滤失败(继续):', e.message)
      }
      await c.wait(1300)
      await blurCovers(c)
      // 提前把要用的那张图缓存进 renderer：正片里点开就是大图，不会黑一屏
      await c.scroll('.home .grid-wrap', 500, 600)
      await c.wait(1200)
      await c.scroll('.home .grid-wrap', -3000, 400)
      await c.wait(400)
      await planCleanCards(c)
    },
    async run(c) {
      await openHomeLightbox(c)
      await c.wait(900)
      const info = await c.eval(`return {
        pills: document.querySelectorAll(${JSON.stringify(MAIN_TAG_LIST)} + ' .pill').length,
        sets: [...document.querySelectorAll('.lightbox .lb-tools button')].map((b) => b.textContent.trim()),
      }`, 'inspect lightbox')
      console.log('[rec] lightbox', JSON.stringify(info))
      // 1) 一键复制这张图的全部标签（只进剪贴板，不写文件）
      await c.hover('.lb-copy-row .copy-split .cs-main', 0, 460)
      await c.wait(400)
      await c.click('.lb-copy-row .copy-split .cs-main', 0, 460)
      await c.wait(1600)
      // 2) ▾ 展开「复制过滤设置」：复用导出那套原语（去 ban / 剔角色系列 / 套用替换规则 / 只复制安全标签）
      await c.click('.lb-copy-row .copy-split .cs-arrow', 0, 380)
      if (!await c.waitSel('.cpy-panel .cpy-opt', 4000)) throw new Error('复制设置面板没出来')
      await c.wait(700)
      await c.hover('.cpy-panel .cpy-title', 0, 420)
      await c.wait(700)
      await c.click('.cpy-panel .cpy-opt', 1, 380)     // 剔角色/系列
      await c.wait(700)
      await c.click('.cpy-panel .cpy-opt', 3, 380)     // 套用替换规则 → 行内浮出「用哪套规则」下拉
      await c.wait(900)
      await c.hover('.cpy-panel .cpy-sel', 0, 420)
      await c.wait(600)
      await c.click('.cpy-panel .cpy-opt', 4, 380)     // 只复制安全标签
      await c.wait(700)
      // 按这套配置再复制一次（主按钮 = 当前勾选的过滤口径），菜单同时收起
      await c.click('.lb-copy-row .copy-split .cs-main', 0, 420)
      await c.wait(1500)
      // 3) 看到不想要的词：点带斜杠的圆圈 → 进黑名单
      await c.hover(`${MAIN_TAG_LIST} .pill:not(.k-char):not(.k-series):not(.banned)`, 0, 460)
      await c.wait(600)
      await c.click(`${MAIN_TAG_LIST} .pill:not(.k-char):not(.k-series):not(.banned) .acts .ban`, 0, 420)
      await c.wait(1500)
      const banned = await c.eval(`return {
        banned: document.querySelectorAll(${JSON.stringify(MAIN_TAG_LIST)} + ' .pill.banned').length,
        badge: (document.querySelector('.lightbox .badge.ban')?.innerText || '').replace(/\\n+/g, ' ').slice(0, 90),
      }`, 'inspect ban state')
      console.log('[rec] ban 后:', JSON.stringify(banned))
      await c.hover(`${MAIN_TAG_LIST} .pill.banned .st`, 0, 460)
      await c.wait(1000)
      // 4) 反过来：点一个标签 → 去看库里所有带这个标签的别的图
      await clickContentTag(c, MAIN_TAG_LIST)
      if (!await c.waitSel('.tag-panel .grid .card', 10000)) throw new Error('点标签没跳到图库')
      await c.wait(1000)
      try {
        await c.clickText('.tag-panel .ss-bar .tv-chip', '涩不了一点', 500)
        await c.wait(1000)
      } catch (e) { console.log('[rec] 跳查来源过滤失败(继续):', e.message) }
      await c.scroll('.tag-panel .scroll', 460, 800)
      await c.wait(900)
      await c.click('.pathbar .back', 0, 500)
      await c.wait(1000)
      // 5) 滚轮看下一张（这条素材顺便交代「光箱是整库的图流」）
      await c.wheel('.lb-zoom', 140, { times: 2, gap: 700 })
      await c.wait(1200)
      await c.click('.lightbox .lb-close', 0, 460)
      await c.wait(600)
    },
  },

  {
    id: 'p07',
    title: '标签从哪来：反推环境 + 缺角色系列的补识别',
    intro: 11.47,
    win: 27.43, dwell: 0.82,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(400)
      // 抽屉只盖住右半边，左边那面「全部 84,380」的墙一直在画面里 —— edge 档挡不住的女胸/腰露图
      // 会从抽屉边上露出来，先糊掉（本页重点是设置面板本身）
      await blurCovers(c)
      // 抽屉在开录前就拉开：第一帧直接是「反推环境」，不闪看板
      await c.click('[data-test="hdr-settings"]', 0, 0)
      if (!await c.waitSel('.drawer .settings', 6000)) throw new Error('设置抽屉没开')
      await c.eval(`
        for (const row of document.querySelectorAll('.drawer .settings .row')) {
          const k = (row.querySelector('.k')?.textContent || '').trim()
          if (k.startsWith('Python')) row.style.display = 'none'   // 本机解释器路径不进画面
        }
        return true
      `, 'redact python path')
      await c.wait(900)
    },
    async run(c) {
      // 1) 反推环境：后端 / 模型 / 阈值都在这一屏。
      //    按文案找行（见 hoverSetting），别用行号 —— Python 行已被 prepare 藏掉。
      await c.wait(1200)
      const rows = await c.eval(`
        return [...document.querySelectorAll('.drawer .settings .row')]
          .map((r, i) => ({ i, k: (r.querySelector('.k')?.textContent || '').trim().slice(0, 20) }))
          .filter((x) => x.k)
      `, 'inspect settings rows')
      console.log('[rec] rows', JSON.stringify(rows))
      // 旁白说到「1.4G 的模型 / 下完离线」时，鼠标正好停在讲这件事的 ⓘ 上
      await hoverSetting(c, '反推模型', 3000, 520)
      await hoverSetting(c, '置信度阈值', 2300)
      await hoverSetting(c, '实际后端', 1700)
      // 2) 先把下一屏（来源管理）路由切好，再关抽屉 —— 反过来会闪一下看板
      await c.nav('#/sources', '.source-view .row', 20000)
      await c.wait(1000)
      await c.click('.drawer .x', 0, 400)
      await c.wait(1000)
      // 3) 补识别：已进库但缺角色/系列的图，重新送模型
      //    只看统计、不点「开始补识别」—— 真跑起来会在后面的素材里冒进度胶囊和 toast。
      await c.clickText('.source-view .bar2 .tv-btn', '补识别', 450)
      if (!await c.waitSel('.mask .box .stat-row', 30000)) throw new Error('补识别统计没出来')
      await c.wait(1200)
      const st = await c.eval(`return (document.querySelector('.mask .box .stat-row')?.innerText || '').replace(/\\n+/g, ' | ')`)
      console.log('[rec] orphan stats:', st)
      // 停在「两档各多少张」这一屏收尾：这就是本页要讲的两个数字
      await c.hover('.mask .box .stat-row > .stat:first-child', 0, 700)
      await c.wait(1900)
      await c.hover('.mask .box .stat-row > .stat:nth-child(2)', 0, 600)
      await c.wait(1700)
      try {
        await c.hover('.mask .box .note-list li', 2, 600)   // 速度参考那一行
        await c.wait(2100)
      } catch (e) { console.log('[rec] 说明行悬停跳过:', e.message) }
      try {
        await c.hover('.mask .box .op-warn', 0, 520)         // 「本次将处理 N 张」
        await c.wait(1500)
      } catch (e) { console.log('[rec] 统计行悬停跳过:', e.message) }
      await c.clickText('.mask .box .foot .tv-btn', '取消', 450)
      await c.wait(1300)
    },
  },

  {
    id: 'p08',
    title: '文件怎么进来：扫描页边扫边进 + 来源管理定用途',
    intro: 12.72,
    win: 22.9, dwell: 0.86,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      // 扫描页的卡片也吃安全模式（TvImageCard 的 v-if="!hidden"），但 edge 档拦不住
      // breasts / midriff 这一类 —— 而这一屏讲的是「边扫边出」这个动作，不是某张图长什么样，
      // 所以缩略图一律糊掉。
      await blurCovers(c)
      // 沙箱登记表里需要一个扫描夹：临时把两张卡设成演示用（里世界有裸露封面，绝不进画面）
      const hit = await c.eval(`
        const list = await window.tv.invoke('folders:list', { usage: 'all' })
        const rows = list?.folders || []
        const out = []
        for (const n of ['新世界', '莱莎', '里世界']) {
          const f = rows.find((r) => String(r.path).endsWith(n))
          if (!f) continue
          const want = n !== '里世界'
          if (!!f.as_scan !== want) await window.tv.invoke('folders:update', { path: f.path, as_scan: want })
          if (!want) continue
          out.push({ name: n, total: f.stats?.total || f.images || 0 })
        }
        if (!out.length) throw new Error('找不到演示用的扫描夹目录')
        return out
      `, 'register demo scan folders')
      console.log('[rec] demo scan folders', JSON.stringify(hit))
      await c.nav('#/scan', '.scan-view .grid.folders .ecard', 30000)
      await c.wait(800)
      const idx = await c.eval(`
        const cards = [...document.querySelectorAll('.scan-view .grid.folders .ecard')]
        return cards.findIndex((e) => (e.textContent || '').includes('新世界'))
      `, 'find demo folder card')
      if (idx < 0) throw new Error('文件夹库里没有「新世界」')
      try {
        await c.click('.scan-view .grid.folders .ecard', idx, 0)
        if (await c.waitSel('.scan-view .grid.imgs .jcell', 30000)) {
          await c.wait(2500)
          await c.scroll('.scan-view .result-scroll', 600, 600)
          await c.wait(1500)
        }
      } catch (e) { console.log('[rec] 扫描夹预热跳过:', e.message) }
      await c.click('.pathbar .back', 0, 0)
      await c.wait(1200)
    },
    async run(c) {
      // 1) 文件夹库：一张卡 = 一个登记过的目录（路径副标题被录屏 CSS 藏掉）
      const folders = await c.eval(`return [...document.querySelectorAll('.scan-view .grid.folders .ecard')].slice(0, 4).map((e) => (e.innerText || '').replace(/\\n+/g, ' | ').slice(0, 70))`, 'inspect folders')
      console.log('[rec] folders', JSON.stringify(folders))
      const openIdx = await c.eval(`
        const cards = [...document.querySelectorAll('.scan-view .grid.folders .ecard')]
        return cards.findIndex((e) => (e.textContent || '').includes('新世界'))
      `, 'find open folder')
      await c.wait(600)
      await c.hover('.scan-view .grid.folders .ecard .thumb-box', Math.max(0, openIdx), 600)
      await c.wait(1500)
      // 2) 打开文件夹：第一批缩略图流式刷出来（边扫边进，不用等整库）
      await c.click('.scan-view .grid.folders .ecard', Math.max(0, openIdx), 500)
      if (!await c.waitSel('.scan-view .grid.imgs .jcell', 20000)) throw new Error('文件夹缩略图没刷出来')
      await c.wait(2000)
      await c.scroll('.scan-view .result-scroll', 480, 900)
      await c.wait(1600)
      await c.scroll('.scan-view .result-scroll', 420, 800)
      await c.wait(1500)
      // 3) 返回 → 来源管理：同一批目录挂的用途开关（来源 / 扫描 / 自动反推）
      await c.click('.pathbar .back', 0, 420)
      await c.wait(800)
      await c.click('[data-test="goto-sources"]', 0, 450)
      if (!await c.waitSel('.source-view .row', 12000)) throw new Error('来源管理没出列表')
      await c.wait(1500)
      const ri = await c.eval(`
        const rows = [...document.querySelectorAll('.source-view .row')]
        return rows.findIndex((e) => (e.textContent || '').includes('新世界'))
      `, 'find source row')
      await c.hover('.source-view .row', Math.max(0, ri), 520)
      await c.wait(1200)
      // 每行三盏开关: 来源 / 扫描 / 自动反推。旁白讲的就是「来源 vs 扫描夹」，
      // 所以这两盏来回亮一次；「自动反推」只悬停不点 —— 点了会真起一轮同步+反推，
      // 进度胶囊和 toast 会冒进后面的素材里。
      const base = Math.max(0, ri) * 3
      await c.hover('.source-view .cell.uses .tv-check', base, 460)
      await c.wait(1400)
      await c.hover('.source-view .cell.uses .tv-check', base + 1, 480)
      await c.wait(1500)
      await c.click('.source-view .cell.uses .tv-check', base + 1, 420)
      await c.wait(1300)
      await c.click('.source-view .cell.uses .tv-check', base + 1, 420)
      await c.wait(1100)
      // 「自动反推」那一盏只在旁白里提，不悬停也不点 —— 点了会真起一轮同步+反推，
      // 进度胶囊和 toast 会冒进后面的素材里；窗口只有 22.9s，这一拍也排不下了。
    },
  },

  {
    id: 'p09',
    title: '购物车：两个系列的角色凑一批 + 附加标签同行',
    intro: 16.06,
    win: 30.12, dwell: 0.68,
    async prepare(c) {
      await openRichSeries(c, 4)
      await blurCovers(c)
    },
    async run(c) {
      // 1) 第一个系列：挑两个角色入车（卡片金边 = 已入车）
      const a = await addCharsToCart(c, 2)
      if (a.length < 2) throw new Error('第一个系列凑不到两个有图的角色')
      await c.wait(700)
      // 2) 回系列墙，进**另一个**作品 —— 旁白讲的「一个系列的张三 + 另一个系列的李四」
      await c.click('.pathbar .back', 0, 460)
      await c.wait(900)
      await c.type('.cat-bar .kw input', '芙莉莲')
      await c.wait(1200)
      const n = await c.eval(`return document.querySelectorAll('.series-view .grid .ecard').length`, 'count filtered series')
      if (!n) throw new Error('搜不到「芙莉莲」的系列')
      await c.click('.series-view .grid .ecard', 0, 500)
      if (!await c.waitSel('.series-view .grid .ecard .cart-fab', 12000)) throw new Error('第二个系列等不到角色卡')
      await c.wait(1100)
      const b = await addCharsToCart(c, 2)
      if (!b.length) throw new Error('第二个系列没有有图的角色')
      // 3) 进购物车：按作品分组，两批角色并排
      await c.nav('#/cart', '.cart-view .group', 15000)
      await c.wait(2100)
      const g = await c.eval(`
        return [...document.querySelectorAll('.cart-view .group .g-head')].map((e) => (e.innerText || '').replace(/\\n+/g, ' ').slice(0, 40))
      `, 'inspect cart groups')
      console.log('[rec] groups', JSON.stringify(g))
      /* 购物车的封面是直连文件的缩略图，挑错角色时会是一张纯黑占位卡（看着像 bug）。
         这里数一下真的渲染出图有几张，不够就当场报出来，别等回看关键帧才发现。 */
      const thumbs = await c.eval(`
        const all = [...document.querySelectorAll('.cart-view .ci')]
        return { n: all.length, ok: all.filter((e) => { const im = e.querySelector('.thumb img'); return im && im.complete && im.naturalWidth }).length }
      `, 'cart thumbs')
      console.log('[rec] 购物车缩略图:', JSON.stringify(thumbs))
      if (thumbs.ok < thumbs.n) throw new Error(`购物车有 ${thumbs.n - thumbs.ok} 张黑卡（${thumbs.ok}/${thumbs.n}）`)
      await c.scroll('.cart-view .body', 260, 700)
      await c.wait(1100)
      // 4) 附加标签：跟角色写在**同一行**（另起一行会让随机节点抽出只有闭眼没角色的空提示词）
      await c.hover('.cart-view .ci', 0, 460)
      await c.wait(500)
      await c.click('.cart-view .ci .edit', 0, 420)
      if (!await c.waitSel('.mask .box .preview', 5000)) throw new Error('附加标签弹窗没开')
      await c.wait(700)
      await c.type('.mask .box input.tv-input', 'closed_eyes')
      await c.wait(1400)
      const prev = await c.eval(`return (document.querySelector('.mask .box .preview')?.innerText || '').replace(/\\n+/g, ' | ')`)
      console.log('[rec] preview:', prev)
      await c.hover('.mask .box .preview', 0, 460)
      await c.wait(900)
      await c.clickText('.mask .box .foot .tv-btn', '保存', 420)
      await c.wait(1400)
      // 5) 收尾：分组抬头 + 「导出 txt / 存为清单」这两个出口（光标停过去，正片由旁白收）
      await c.hover('.cart-view .group .g-head', 0, 500)
      await c.wait(1100)
      await c.scroll('.cart-view .body', -300, 600)
      await c.wait(800)
      await c.hover('.cart-view .head .tv-btn', 0, 500)
      await c.wait(1500)
    },
  },

  {
    id: 'p10',
    title: '导出预设：一套条件一键就绪',
    intro: 49.49,
    win: 13.07, dwell: 0.78,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(500)
      // 弹窗压在图墙上：背景糊掉，只让面板本身清楚
      await blurCovers(c)
    },
    async run(c) {
      // 1) 预设列表（演示预设只有一份，路径行被录屏 CSS 藏掉）
      await c.clickText('.lnk .tv-btn', '预设导出')
      if (!await c.waitSel('.prow', 6000)) throw new Error('预设列表没出来')
      await c.wait(1200)
      const info = await c.eval(`return {
        rows: document.querySelectorAll('.prow').length,
        head: (document.querySelector('.prow .phead')?.innerText || '').replace(/\\n+/g, ' | '),
        tags: [...document.querySelectorAll('.prow .phead .tag-src, .prow .phead .tag-q, .prow .phead .tag-set')].map((e) => e.textContent.trim()),
      }`, 'inspect preset')
      console.log('[rec] preset', JSON.stringify(info))
      // 2) 一行预设 = 一份筛选条件快照：徽章（来源/搜索词/规则组）就在行头上，
      //    窗口只有 13s，不再单独指一颗 —— 直接进编辑，把三样开关指全。
      await c.clickText('.prow .pacts .tv-btn', '编辑')
      await c.wait(1000)
      await c.scroll('.mask .box .body', 640, 800)
      await c.wait(900)
      await c.hover('.switches .tv-check', 0, 500)
      await c.wait(900)
      await c.hover('.switches .tv-check', 2, 500)
      await c.wait(900)
      await c.hover('.switches .tv-check', 4, 500)
      await c.wait(800)
      // 4) 列表里那盏「变更后自动导出」只指不动 —— 真开关留给 p15 当场演示，
      //    这里点了会排一次 3 分钟后的自动导出，Toast 会砸进后面几条素材里
      await c.clickText('.mask .box .foot .tv-btn', '返回')
      await c.wait(700)
      // 收尾停在列表里那盏「变更后自动导出」上 —— 旁白最后一句说的就是它。
      // 面板不再点「关闭」：窗口只有 13.07s，那一拍观众看不见，还白占收尾画面。
      await c.hover('.prow .auto-sw', 0, 500)
      await c.wait(1200)
    },
  },

  {
    id: 'p11',
    title: '黑名单两种模式：光箱 ban 这一个词 / 面板写一类词',
    intro: 35.54,
    win: 19.46, dwell: 0.58,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(500)
      // 黑名单那一屏是**大字正文**，不是背景：沙箱里的 export_blacklist.txt 是从真实库抄来的
      // 812 行，正片会滚到底，正好是 condom_on_penis / huge_nipples 这类词
      // （2026-10-25 抽帧 p11-f2 抓到）。图片糊掉挡不住文字 —— 这一镜先把沙箱黑名单换成
      // 「质量类 + 三种通配示例」，讲的还是同一件事（ban 一类词），但屏幕上没有不该
      // 出现在公开片里的词。只改 .e2e-work 沙箱，真实库那份一个字不动。
      await c.eval(`
        const demo = [
          '# 每行一条规则（用下划线），导出时自动剔除命中的标签',
          'lowres',
          'jpeg_artifacts',
          'watermark',
          'signature',
          'text',
          'bad_anatomy',
          'bad_hands',
          'extra_arms',
          'error',
          'cropped',
          'blurry',
          'simple_background',
          '# 前缀通配：bad_ 开头的一整类都跳掉',
          'bad_*',
          '# 后缀通配',
          '*_artist',
          '# 包含通配',
          '*watermark*',
        ].join('\\n')
        await window.tv.invoke('blacklist:save', { text: demo })
        const d = await window.tv.invoke('blacklist:get', {})
        return (d.text || '').split('\\n').length
      `, 'demo blacklist')
      try { await c.clickText('.src-bar .tv-chip', '涩不了一点', 600) } catch (e) {
        console.log('[rec] 来源过滤失败(继续):', e.message)
      }
      await c.wait(1300)
      await blurCovers(c)
      await planCleanCards(c)
    },
    async run(c) {
      // 1) 模式二「这一张的词」：光箱里点带斜杠的圆圈
      await openHomeLightbox(c)
      await c.wait(800)
      const before = await c.eval(`
        const list = document.querySelector(${JSON.stringify(MAIN_TAG_LIST)})
        const p = list.querySelector('.pill:not(.k-char):not(.k-series):not(.banned)')
        return p ? p.dataset.tag : ''
      `, 'tag to ban')
      console.log('[rec] ban 的词:', before)
      await c.hover(`${MAIN_TAG_LIST} .pill:not(.k-char):not(.k-series):not(.banned) .acts .ban`, 0, 480)
      await c.wait(600)
      await c.click(`${MAIN_TAG_LIST} .pill:not(.k-char):not(.k-series):not(.banned) .acts .ban`, 0, 420)
      await c.wait(1500)
      await c.hover(`${MAIN_TAG_LIST} .pill.banned`, 0, 460)
      await c.wait(1100)
      // 右侧「命中黑名单 N 个」那枚徽章不单独悬停了：窗口 19.46s，
      // 划掉的那个词已经说明「ban 进去了」，徽章在收尾那屏还看得见。
      await c.click('.lightbox .lb-close', 0, 440)
      await c.wait(800)
      // 2) 模式一「一类词」：打开黑名单面板（通配规则：前缀 / 后缀 / 包含）
      //    入口在导出那一排（.brow）里，不在 .lnk（.lnk 只有替换规则/预设导出/查重）
      await c.clickText('.brow .tv-btn', '黑名单', 450)
      if (!await c.waitSel('.mask .editor.tall', 6000)) throw new Error('黑名单面板没开')
      await c.wait(1100)
      await c.hover('.mask .tip', 0, 460)
      await c.wait(1600)
      const black = await c.eval(`
        const t = document.querySelector('.mask .editor.tall')
        t.scrollTop = t.scrollHeight
        return { lines: t.value.split('\\n').length, tail: t.value.split('\\n').filter(Boolean).slice(-3).join(' | ') }
      `, 'scroll blacklist to bottom')
      console.log('[rec] blacklist', JSON.stringify(black))
      await c.wait(1000)
      // 3) 手写一条通配（演示「一类词」的写法；按取消不落盘，不污染真实规则）
      await c.click('.mask .editor.tall', 0, 380)
      await c.wait(400)
      const typed = await c.eval(`
        const t = document.querySelector('.mask .editor.tall')
        t.focus()
        t.setSelectionRange(t.value.length, t.value.length)
        document.execCommand('insertText', false, '\\nshort_hair_*')
        return t.value.slice(-24)
      `, 'append wildcard')
      console.log('[rec] 追加通配:', typed)
      await c.wait(1700)
      await c.hover('.mask .editor.tall', 0, 420)
      await c.wait(900)
      // 常驻提示那一行写的就是「前缀 / 后缀 / 包含」三种通配 —— 旁白说到这一句时停在这
      try {
        await c.hover('.mask .tip div', 0, 460)
        await c.wait(1200)
      } catch (e) { console.log('[rec] 提示行悬停跳过:', e.message) }
      // 4) 两种模式配合起来的落点：导出时两类都会被跳过 —— 这里取消，不保存手写的词
      await c.clickText('.mask .box .foot .tv-btn', '取消', 420)
      await c.wait(1000)
    },
  },

  {
    id: 'p12',
    title: '替换规则：追加 / 换词 / 多组 / 权重 / 实时预览',
    intro: 8.88,
    win: 28.78, dwell: 0.72,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(500)
      await blurCovers(c)
    },
    async run(c) {
      // 1) 第一张卡就是「1girl → 1girl, cat_ears, cat_tail」
      await c.clickText('.lnk .tv-btn', '替换规则')
      if (!await c.waitSel('.rule-card', 6000)) throw new Error('规则编辑器没开')
      await c.wait(1300)
      const info = await c.eval(`return {
        sets: [...document.querySelectorAll('.side-item')].map((e) => e.querySelector('.side-name')?.textContent.trim()),
        cards: [...document.querySelectorAll('.rule-card')].slice(0, 4).map((e) => (e.innerText || '').replace(/\\n+/g, ' ').slice(0, 60)),
      }`, 'inspect rules')
      console.log('[rec] rules', JSON.stringify(info))
      await c.hover('.rule-card', 0, 500)
      await c.wait(1500)
      // 2) 底部实时预览：敲 1girl 就能看到「命中 → 追加猫耳猫尾」
      await c.type('.tester .test-in input', '1girl')
      await c.wait(2200)
      const t1 = await c.eval(`return (document.querySelector('.tester .test-out')?.innerText || '(空)').replace(/\\n+/g, ' ')`)
      console.log('[rec] tester 1girl:', t1)
      await c.hover('.tester .test-out', 0, 420)
      await c.wait(900)
      // 3) 权重壳：点替换标签的 chip → ＋ 两下 → (cat_ears:1.2)
      await c.click('.rule-card .row-sub .chip-tag', 0, 420)
      if (!await c.waitSel('.rule-card .w-pop', 4000)) throw new Error('权重气泡没出来')
      await c.wait(700)
      await c.click('.rule-card .w-pop .w-btn', 1, 320)
      await c.wait(500)
      await c.click('.rule-card .w-pop .w-btn', 1, 320)
      await c.wait(900)
      const wv = await c.eval(`return (document.querySelector('.rule-card .w-val')?.textContent || '').trim()`)
      console.log('[rec] 权重:', wv)
      await c.click('.rule-card .row-sub .chip-tag', 0, 360)
      await c.wait(500)
      // 4) 「换词」：加一条 thigh_socks → short_socks（原标签丢弃 = 整个换掉）
      await c.click('.rows .add', 0, 420)
      await c.wait(700)
      const last = await c.eval(`return document.querySelectorAll('.rule-card').length - 1`, 'last card index')
      const SRC = `.rows .rule-card:nth-of-type(${last + 1}) .row-top .chip-add input`
      await c.type(SRC, 'thigh_socks')
      await c.wait(900)
      await c.key('Enter')
      await c.wait(800)
      await c.type(SRC, 'thigh_socks')
      await c.wait(900)
      await c.key('Enter')
      await c.wait(900)
      const gotSrc = await c.eval(`
        const card = [...document.querySelectorAll('.rows .rule-card')].pop()
        return { chips: [...card.querySelectorAll('.row-top .chip')].map((c) => c.textContent.trim().replace(/×/, '')), mode: card.querySelector('.mode-sel')?.value }
      `, 'inspect new rule src')
      console.log('[rec] 新规则来源侧:', JSON.stringify(gotSrc))
      // 原标签改成「丢弃」，才叫「换」而不是「加」
      await c.eval(`
        const card = [...document.querySelectorAll('.rows .rule-card')].pop()
        const k = card.querySelector('.keep-sel')
        k.value = 'false'
        k.dispatchEvent(new Event('change', { bubbles: true }))
        return k.value
      `, 'set keep=丢弃')
      await c.wait(900)
      // 右侧「替换标签」那个输入框：不能用 `.rule-card:last-child` —— .rows 的最后一个
      // 子元素是下面那颗「＋ 添加规则」按钮，:last-child 一条都匹配不上。直接取最后一张卡。
      const marked = await c.eval(`
        const cards = [...document.querySelectorAll('.rows .rule-card')]
        const last = cards[cards.length - 1]
        const inp = last && last.querySelector('.repl-sub .chip-add input')
        if (!inp) return 0
        inp.setAttribute('data-rec-repl', '1')
        return cards.length
      `, 'mark repl input of new card')
      if (!marked) throw new Error('新规则卡的「替换标签」输入框没出来')
      await c.type('[data-rec-repl]', 'short_socks')
      await c.wait(900)
      await c.key('Enter')
      await c.wait(900)
      await c.clickText('.mask .box .foot .tv-btn', '保存', 460)
      await c.wait(1200)
      // 5) 存好的规则当场生效：测试条换词看「长袜 → 短袜」
      //    先清空 —— 上一段留着的 1girl 会和这个词粘成 "1girlthigh_socks"，
      //    于是「未命中任何规则」，画面里最该露脸的那一步就白拍了（2026-10-25 实测）。
      await clearInput(c, '.tester .test-in input')
      await c.type('.tester .test-in input', 'thigh_socks')
      await c.wait(2000)
      const t2 = await c.eval(`return (document.querySelector('.tester .test-out')?.innerText || '(空)').replace(/\\n+/g, ' ')`)
      console.log('[rec] tester thigh_socks:', t2)
      await c.hover('.tester .test-out', 0, 420)
      await c.wait(1000)
      // 6) 规则组：切到「默认」这套（同一句话不再命中），再切回来 —— 收尾画面停在这儿
      await c.click('.side-item', 1, 460)
      await c.wait(1100)
      await c.click('.side-item', 0, 460)
      await c.wait(1400)
      // 编辑器不再点「取消」：窗口 28.78s，切回规则组就是这一镜的最后一拍
    },
  },

  {
    id: 'p13',
    title: '查重：按标签重合分组 + 建议保留 + 永久忽略',
    intro: 15.22,
    win: 16.9, dwell: 0.85,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(500)
      await blurCovers(c)
      /* 开录前先清场（只动「忽略记录」，不删任何文件）。查重面板是**原图直显**
         —— 糊掉就没法比了，所以能不能上镜得由图自己说话：
         ① 破图组（文件早没了，画面上是「⚠ + 0×0」，像 bug）；
         ② 组里**任何一张**图的标签命中全年龄判据（和光箱用的同一份 UNSAFE 名单）；
         ③ 一条标签都没有的 —— 内容无从判断的图不进公开片子。
         注意判据不能只看「共享标签」：那只是两张图的交集，2026-10-25 QA 实测有一组
         交集里全是 elbow_gloves / pink_hair 这种无害词、图本身却是裸的，差点上了镜头。
         这些组先「非重复」挪出相似组列表，再把它们的忽略记录一并删掉 ——
         因为正片有一镜要点开「已忽略」看「删记录」，不清空的话那一屏全是刚挪走的图。
         安全模式没关、阈值没动，只是挑镜头。 */
      const unfitOf = `
        ${CLEAN_FILTER_JS}
        window.__rec_tagcache = window.__rec_tagcache || new Map()
        const tagsOf = async (p) => {
          if (window.__rec_tagcache.has(p)) return window.__rec_tagcache.get(p)
          let t = []
          try { const d = await window.tv.invoke('tags:forPath', { path: p }); t = (d && d.tags) || [] } catch (e) {}
          window.__rec_tagcache.set(p, t)
          return t
        }
        /* .item 的 title 第一行就是这张图的完整路径 */
        const unfit = async (g) => {
          if (g.querySelector('.thumb .bad')) return true
          const paths = [...g.querySelectorAll('.item')]
            .map((e) => (e.getAttribute('title') || '').split('\\n')[0].trim()).filter(Boolean)
          if (!paths.length) return false
          for (const p of paths) {
            const t = await tagsOf(p)
            if (!t.length || t.some(bad)) return true
          }
          return false
        }
      `
      /** 把当前视图里不合格的那批组按某个按钮（非重复 / 删记录）清掉，返回每轮清了几组 */
      async function sweep(btnRe) {
        const rounds = []
        for (let round = 0; round < 10; round++) {
          const n = await c.eval(`
            ${unfitOf}
            let hit = 0
            for (const g of document.querySelectorAll('.dup .grp')) {
              if (!await unfit(g)) continue
              const b = [...g.querySelectorAll('.gbtn')].find((e) => ${btnRe}.test(e.innerText || ''))
              if (b) { b.click(); hit++ }
            }
            return hit
          `, 'sweep ' + btnRe)
          rounds.push(n)
          if (!n) break
          await c.wait(1500)
        }
        return rounds
      }
      await c.clickText('.lnk .tv-btn', '查重', 460)
      if (!await c.waitSel('.dup .grp', 25000)) throw new Error('查重(清场)没出组')
      await c.wait(3000)
      const dropped = await sweep('/非重复/')
      const left = await c.eval(`return document.querySelectorAll('.dup .grp').length`, 'count groups')
      // 相似组里清干净了，再去「已忽略」把刚才挪走的记录删掉（这一步会让它们永久不再出现）
      await c.click('.dup .seg button', 1, 460)
      if (!await c.waitSel('.dup .grp .score.ig', 10000)) throw new Error('已忽略视图没出来')
      await c.wait(2500)
      const purged = await sweep('/删记录/')
      await c.click('.dup .seg button', 0, 460)
      await c.wait(1200)
      console.log(`[rec] p13 清场：相似组挪走 ${JSON.stringify(dropped)} 剩 ${left} 组；已忽略删掉 ${JSON.stringify(purged)} 条记录`)
      if (left < 3) throw new Error('清场后相似组不足 3 个，没法录')
      await c.click('.mask .box .x', 0, 300)
      await c.wait(900)
    },
    async run(c) {
      // 1) 面板一开就全库比一遍（转圈本身就是「比标签、不比像素」的画面）
      await c.clickText('.lnk .tv-btn', '查重')
      if (!await c.waitSel('.dup .grp', 20000)) {
        const err = await c.eval(`return (document.querySelector('.dup')?.innerText || '').slice(0, 200)`)
        throw new Error('查重没出组：' + err)
      }
      await c.wait(1200)
      const info = await c.eval(`return {
        groups: document.querySelectorAll('.dup .grp').length,
        score: (document.querySelector('.dup .grp .score')?.innerText || '').trim(),
        shared: [...document.querySelectorAll('.dup .grp .shared')].slice(0, 3).map((e) => (e.innerText || '').replace(/\\n+/g, ' ').slice(0, 80)),
      }`, 'inspect dup')
      console.log('[rec] dup', JSON.stringify(info))
      // 2) 重合了多少：分数徽章 + 这组共享的那些标签（「重合得越多越像」的画面）
      await c.hover('.dup .grp .score', 0, 460)
      await c.wait(1300)
      await c.hover('.dup .grp .shared', 0, 420)
      await c.wait(1500)
      // 3) ★ 是建议保留的那张（悬停能看理由）
      await c.hover('.dup .grp .bestmark', 0, 420)
      await c.wait(1200)
      await c.scroll('.dup .list', 420, 800)
      await c.wait(1200)
      // 4) 分错了 → 非重复（忽略一组误报）
      await c.clickText('.dup .grp .gbtn', '非重复')
      await c.wait(1100)
      // 5) 已忽略视图 + 删记录（只删记录，不删图）
      await c.click('.dup .seg button', 1)
      if (!await c.waitSel('.dup .grp .score.ig', 8000)) throw new Error('已忽略视图没出现')
      await c.wait(900)
      await c.clickText('.dup .grp .gbtn', '删记录')
      await c.wait(1000)
      // 收尾画面切回相似组，别停在「忽略记录被删空」那个界面上
      await c.click('.dup .seg button', 0)
      await c.wait(1200)
    },
  },

  {
    id: 'p15',
    title: '自动导出：ban 完不用点导出',
    intro: 26.81,
    win: 14.51, dwell: 0.50,
    async prepare(c) {
      await c.nav('#/', '.grid .card', 25000)
      await c.wait(500)
      try { await c.clickText('.src-bar .tv-chip', '涩不了一点', 600) } catch (e) {
        console.log('[rec] 来源过滤失败(继续):', e.message)
      }
      await c.wait(1200)
      await blurCovers(c)
      // 「ban 完之后等」调到最短档 1.5 秒：这是让演示能拍完的设置，不是要给观众看的动作，
      // 放在 prepare 里改（正片窗口只有 14.5s，面板里点一次下拉就要 3s）。
      await c.clickText('.lnk .tv-btn', '预设导出')
      if (!await c.waitSel('.delayrow select', 6000)) throw new Error('预设面板里没有延迟选择')
      await c.eval(`
        const s = document.querySelector('.delayrow select')
        s.value = '1500'
        s.dispatchEvent(new Event('change', { bubbles: true }))
        return s.value
      `, 'set delay 1.5s(备采)')
      await c.clickText('.mask .box .foot .tv-btn', '关闭')
      await c.wait(900)
      await planCleanCards(c)
    },
    async run(c) {
      // 1) 打开这一行的「变更后自动导出」
      await c.clickText('.lnk .tv-btn', '预设导出')
      if (!await c.waitSel('.prow', 6000)) throw new Error('预设列表没出来')
      await c.wait(700)
      await c.hover('.prow .auto-sw', 0, 380)
      await c.click('.prow .auto-sw', 0, 380)
      await c.wait(800)
      const on = await c.eval(`return !!document.querySelector('.prow .tag-on')`, 'auto badge')
      console.log('[rec] 自动档已开:', on)
      await c.clickText('.mask .box .foot .tv-btn', '关闭')
      await c.wait(600)
      // 2) 去光箱 ban 一个词 —— 这就是「改完黑名单」这个动作
      await openHomeLightbox(c)
      await c.hover(`${MAIN_TAG_LIST} .pill:not(.k-char):not(.k-series):not(.banned) .acts .ban`, 0, 380)
      await c.click(`${MAIN_TAG_LIST} .pill:not(.k-char):not(.k-series):not(.banned) .acts .ban`, 0, 360)
      await c.wait(700)
      await c.click('.lightbox .lb-close', 0, 360)
      // 3) 等它自己重导：Toast「已排程自动导出」→「已自动导出」，全程没人点导出
      //    用轮询而不是死等 3.2s —— 窗口只有 14.5s，多等的每一秒都是观众的空白
      if (!await c.waitSel('.toast, .tv-toast, .toasts > *', 9000)) console.log('[rec] !! 没等到自动导出 toast')
      const toast = await c.eval(`
        return [...document.querySelectorAll('.toast, .tv-toast, .toasts > *')].map((e) => (e.innerText || '').replace(/\\n+/g, ' ').slice(0, 70))
      `, 'inspect toast')
      console.log('[rec] toast:', JSON.stringify(toast))
      await c.wait(700)
      // 4) 回预设面板：上次导出那一行的时间戳已经变成「自动」
      await c.clickText('.lnk .tv-btn', '预设导出')
      await c.waitSel('.prow .pmeta', 6000)
      const meta = await c.eval(`return (document.querySelector('.prow .pmeta')?.innerText || '').replace(/\\n+/g, ' | ')`)
      console.log('[rec] pmeta:', meta)
      await c.hover('.prow .pmeta', 0, 400)
      // 面板不点「关闭」收尾：窗口 14.51s，那一拍掉在窗口外观众看不见，
      // 而且停在「时间戳=自动」这一行正好接住旁白最后一句。
    },
  },
]

/* ------------------------------------------------------------ 来源名脱敏 */
/**
 * 用户 2026-10-25 的原话：「来源列表里的文件夹名能换就换一套」。
 * 真实来源名（涩一点点 / 涩涩涩涩涩 / 里世界）会出现在看板左栏、来源管理页、
 * 预设快照里 —— 公开介绍片里不该出现这些。
 *
 * 做法：只改**沙箱库**里的显示名。folders.label 就是来源显示名
 * （sourceNameList → folderBaseName 优先取 label），src.name 是它的老键，
 * 两处一起改才不会让「按来源名回查目录」那条路断掉。
 * 「涩不了一点」保持原样：它是片子里要念的那个库名，也是每个镜头的来源筛选条件。
 * 磁盘上的目录、图片、真实库一个字节都不动。
 */
const SOURCE_RENAMES = {
  涩一点点: '素材库B',
  涩涩涩涩涩: '素材库C',
  里世界: '素材库D',
}

async function sanitizeSourceNames(dataDir) {
  const file = path.join(dataDir, 'tags.db')
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (e) {
    console.log('[rec] !! node:sqlite 不可用，跳过来源改名（成片会露出真实来源名）:', e.message)
    return
  }
  if (!fs.existsSync(file)) { console.log('[rec] !! 没有', file, '，跳过来源改名'); return }
  const db = new DatabaseSync(file)
  try {
    for (const [from, to] of Object.entries(SOURCE_RENAMES)) {
      const f = db.prepare('UPDATE folders SET label = ? WHERE label = ?').run(to, from)
      const s = db.prepare('UPDATE src SET name = ? WHERE name = ?').run(to, from)
      console.log(`[rec] 来源改名 ${from} -> ${to}（folders ${f.changes} 行 / src ${s.changes} 行）`)
    }
  } catch (e) {
    console.log('[rec] !! 来源改名失败（继续录，事后手工打码）:', e.message)
  } finally { db.close() }
}

/* ------------------------------------------------------------ 主流程 */
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const work = ensureWorkDir({ quiet: true })
  await sanitizeSourceNames(work.dataDir)
  // 硬条件：安全模式 edge 档常开
  fs.writeFileSync(path.join(work.dataDir, 'safety.json'),
    JSON.stringify({ on: true, level: 'edge', mode: 'safe' }, null, 2))
  // 导出预设的演示数据：auto 先关着，p05 里当场打开 ——
  // 不然 p04 一 ban 就会触发一次真导出，画面里乱闪
  writeDemoPreset(work)

  const port = await freePort()
  const child = spawn(findElectron(), [
    '.', `--remote-debugging-port=${port}`, `--user-data-dir=${work.userData}`,
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: electronEnv({ TV_DATA_DIR: work.dataDir }) })
  child.stderr.on('data', (b) => process.stderr.write(`[main!] ${b}`))

  let ws
  try {
    const page = await findPage(port)
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    // Browser.* 只在浏览器级会话上有；再开一条 ws 专门用来改真实窗口尺寸
    let bcdp = null
    try {
      const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      const bws = new WebSocket(ver.webSocketDebuggerUrl)
      await new Promise((res, rej) => {
        bws.addEventListener('open', res, { once: true })
        bws.addEventListener('error', rej, { once: true })
      })
      bcdp = new Cdp(bws)
      bcdp._ws = bws
    } catch (e) {
      console.log('[rec] 浏览器级会话不可用:', e.message)
    }
    // 16:9 视口：最终成片就是 1920x1080，录屏整段铺满
    // 只设 Emulation 时布局是 1728x972，但抓帧的表面尺寸仍跟窗口走（1560x925 → 1820x1080），
    // 所以先把真实窗口调成 16:9，再设同尺寸的 emulation，两头一致。
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      // 目标内容区：16:9，宽尽量到 1700（抓帧再放大到 1080p 时字更实），但不超出屏幕
      const scr = await cdp.eval(`return { aw: screen.availWidth, ah: screen.availHeight }`)
      for (let i = 0; i < 3; i++) {
        const m = await cdp.eval(`return { iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight }`)
        const chromeW = m.ow - m.iw, chromeH = m.oh - m.ih
        const wantW = Math.min(1700, scr.aw - chromeW)
        const wantH = Math.round(wantW * 9 / 16)
        if (Math.abs(m.iw - wantW) <= 1 && Math.abs(m.ih - wantH) <= 1) break
        const w = bcdp
          ? await bcdp.send('Browser.getWindowForTarget', { targetId: page.id }).catch(() => null)
          : null
        if (w) {
          await bcdp.send('Browser.setWindowBounds', {
            windowId: w.windowId, bounds: { width: wantW + chromeW, height: wantH + chromeH, windowState: 'normal' },
          })
        } else {
          // Electron 没实现 Browser.getWindowForTarget，退回渲染层的 resizeTo（改的是外框尺寸）
          await cdp.eval(`window.resizeTo(${wantW + chromeW}, ${wantH + chromeH}); return true`)
        }
        await sleep(600)
      }
      VW = await cdp.eval(`return innerWidth`)
      VH = await cdp.eval(`return innerHeight`)
      console.log('[rec] 真实窗口已调成', VW, 'x', VH)
    } catch (e) {
      console.log('[rec] 调窗口失败，退回固定视口:', e.message)
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VW, height: VH, deviceScaleFactor: 1, mobile: false,
      screenWidth: VW, screenHeight: VH,
    })
    // 光设 metrics 只改布局，抓帧的表面尺寸还跟着窗口走；SetVisibleSize 会把表面也改过来
    try { await cdp.send('Emulation.setVisibleSize', { width: VW, height: VH }) } catch (e) {
      console.log('[rec] setVisibleSize 不支持', e.message)
    }
    await sleep(400)
    // 先清一遍页面状态再注入假光标。
    // 购物车/收藏/网格缩放都存 localStorage，连着跑几次时上一条素材会留下
    // 三个角色 —— 剪辑时 p08 的购物车就不是从空开始（也修不了时长）。
    for (let i = 0; i < 120; i++) {
      try {
        if (await cdp.eval(`return !!document.querySelector('#app .hdr')`)) break
      } catch { /* 启动中 */ }
      await sleep(500)
    }
    try {
      const n = await clearPageState(cdp)
      console.log('[rec] 页面状态已清空, 清了', n, '个 localStorage 键')
    } catch (e) {
      console.log('[rec] 清页面状态失败(继续):', e.message)
    }
    await cdp.eval(CURSOR_JS, 10000)

    // 等首页就绪 + 首屏缩略图
    for (let i = 0; i < 120; i++) {
      try {
        if (await cdp.eval(`return document.querySelectorAll('.grid .card').length > 0`)) break
      } catch { /* 启动中 */ }
      await sleep(500)
    }
    await sleep(1200)
    console.log('[rec] viewport', JSON.stringify(await cdp.eval(`return {
      w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
      vw: visualViewport.width, vh: visualViewport.height,
      cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
      ow: outerWidth, oh: outerHeight, sw: screen.width, sh: screen.height,
    }`)))

    // 断言硬条件（问主进程拿安全模式状态，不靠界面文字猜）
    const saf = await cdp.eval(`return await window.tv.invoke('safety:get')`)
    console.log('[rec] safety:', JSON.stringify(saf))
    if (!saf || saf.on !== true || saf.level !== 'edge') {
      throw new Error(`安全模式不是 edge 档（当前 ${JSON.stringify(saf)}）—— 拒绝录制`)
    }

    const rec = new Recorder(cdp)
    const ops = makeOps(cdp)
    // DRY=1：只跑 prepare+run 的分镜逻辑，不抓帧不编码不出 mp4 ——
    // 用来在花 20 分钟录全套之前，先花 3 分钟确认每一步都点得动、挑得到图。
    const DRY = process.env.DRY === '1'
    if (process.env.PROBE === 'clean') {
      // PROBE=clean：不录像，只把 p03 里最没底的两步跑一遍 ——
      //   ① 中文词到底能不能出联想（后端 zhIndex 按「译名包含输入」匹配）
      //   ② 全年龄名单和屏上卡片能不能对上、点开的那张是否合格
      // 录一整条素材要几分钟，这里 60 秒就能判死这两步。
      await SHOTS.find((s) => s.id === 'p03').prepare(ops)
      for (const w of ['白发', '白色的头发', '双马尾', '白头发', 'white_hair']) {
        const r = await cdp.eval(`return await window.tv.invoke('suggest:get', { q: ${JSON.stringify(w)}, limit: 6, source: ${JSON.stringify(DEMO_SOURCE)} })`)
        console.log(`[probe] suggest ${w} -> ` + JSON.stringify((r.suggestions || []).slice(0, 4).map((s) => `${s.tag}|${s.zh}|${s.count}`)))
      }
      console.log(`[probe] suggest 白发(全库) -> ` + JSON.stringify(
        ((await cdp.eval(`return await window.tv.invoke('suggest:get', { q: '白发', limit: 8 })`)).suggestions || [])
        .slice(0, 6).map((s) => `${s.tag}|${s.zh}|${s.count}`)))
      console.log('[probe] 命中:', JSON.stringify(await pickCleanCards(ops)))
      try {
        console.log('[probe] openHomeLightbox 选中卡片', await openHomeLightbox(ops))
      } catch (e) {
        console.log('[probe] openHomeLightbox 失败:', e.message)
      }
      console.log('[rec] probe 结束'); return
    }
    // 增量录制：--only p07 这种单条重录不应该把别的条目从 manifest 里删掉
    const mf = path.join(OUT, 'manifest.json')
    const shotIds = new Set(SHOTS.map((s) => s.id))
    let prev = []
    try { prev = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { /* 第一次录 */ }
    const manifest = new Map(prev.filter((it) => shotIds.has(it.id)).map((it) => [it.id, it]))
    for (const shot of SHOTS) {
      if (ONLY.length && !ONLY.includes(shot.id)) continue
      console.log(`\n[rec] ${shot.id} ${shot.title}`)
      ops.log.length = 0
      ops.dwellScale = 1
      // 开录前先摆好起手位（剪辑切进来的那一帧就是这一页）
      if (shot.prepare) await shot.prepare(ops)
      await sleep(600)
      if (!DRY) await rec.start()
      ops.T0.t = Date.now()
      ops.dwellScale = shot.dwell || 1
      const runFrom = ops.log.length
      try {
        await shot.run(ops)
      } finally {
        ops.dwellScale = 1              // 收尾这拍是留给剪辑的尾巴，不该被压缩
        // 收尾多留一拍，剪辑时有余量；顺带把素材凑到「窗口 + 1.6s」，
        // 合成时只取前 window 秒，尾巴太短会被判「素材比窗口短」而用尾帧硬补。
        const last = ops.log.length ? ops.log[ops.log.length - 1].t : 0
        const pad = Math.max(700, Math.round((shot.win ? shot.win * 1000 + 1600 - last : 700)))
        await ops.wait(Math.min(pad, 6000))
        if (!DRY) await rec.stop()
      }
      if (DRY) {
        const run = ops.log.slice(runFrom).filter((e) => !/^wait |^park|^eval |^blur |^inspect|^match |^build /.test(e.what))
        const lt = run.length ? run[run.length - 1].t / 1000 : 0
        const over = shot.win ? lt - shot.win : 0
        console.log(`[dry] ${shot.id} 跑通：最后一个动作 ${lt.toFixed(1)}s / 窗口 ${shot.win || '?'}s (dwell=${shot.dwell || 1}) ${over > 0 ? '★ 超窗 ' + over.toFixed(1) + 's' : '✓ 余量 ' + (-over).toFixed(1) + 's'}`)
        // 动作时刻表：超窗时要知道是哪几步吃掉了秒数，不然只能瞎调 dwell
        console.log(run.map((e) => `      ${(e.t / 1000).toFixed(1).padStart(5)}s  ${e.what}`).join('\n'))
        continue
      }
      const mp4 = path.join(OUT, `${shot.id}.mp4`)
      // 留一张原始抓帧，用来核对"抓出来到底多大"
      fs.writeFileSync(path.join(OUT, `${shot.id}-first.jpg`), Buffer.from(rec.frames[0].b64, 'base64'))
      const info = await rec.encode(mp4)
      const item = { id: shot.id, title: shot.title, intro: shot.intro, file: mp4, ...info, log: ops.log.slice() }
      manifest.set(shot.id, item)
      // 单条失败时前面的成果不该丢: 每录完一条就落盘一次（最后再按 SHOTS 顺序整理）
      fs.writeFileSync(mf, JSON.stringify([...manifest.values()], null, 2))
      console.log(`[rec] ${shot.id} 完成 ${info.dur}s (墙钟 ${info.rawDur}s, ${info.frames} 帧, ${(info.bytes / 1e6).toFixed(1)}MB) -> ${mp4}`)
      // 抽三张关键帧方便人工核对
      for (const [i, t] of [0.2, 0.55, 0.85].entries()) {
        await new Promise((r) => {
          const p = spawn(FFMPEG, ['-y', '-ss', String((info.dur * t).toFixed(2)), '-i', mp4,
            '-frames:v', '1', path.join(OUT, `${shot.id}-f${i + 1}.png`)], { stdio: 'ignore' })
          p.once('exit', r)
        })
      }
    }
    // 按 SHOTS 顺序写回，缺的条目(还没录)不占位
    const out = SHOTS.filter((s) => manifest.has(s.id)).map((s) => manifest.get(s.id))
    fs.writeFileSync(mf, JSON.stringify(out, null, 2))
    console.log('[rec] manifest ->', mf, `(${out.length} 条: ${out.map((it) => it.id).join(' ')})`)
  } finally {
    try { ws?.close() } catch { /* 已关 */ }
    child.kill()
  }
}

main().catch((e) => { console.error('[rec] FAIL', e); process.exit(1) })
