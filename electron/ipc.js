/**
 * IPC 路由 —— 渲染进程唯一能触达主进程的入口
 * ==========================================
 * 原 Python 版的 22 个 HTTP 端点在这里一一对应成 IPC channel。
 * 所有 handler 都是 async 且返回纯 JSON 可序列化的对象;
 * 出错统一包成 { error: '...' } 往上层抛, 不用 try/catch 散落各处。
 *
 * 与原版的几个"降级为原生能力"的地方:
 *   scan:pickFolder  原版是另起一个 python 进程跑 tkinter 弹窗(还要 -topmost 抢焦点),
 *                    现在是 Electron 原生 dialog.showOpenDialog。
 *   export:save      原版走浏览器附件下载; 现在走原生「另存为」。
 *   clipboard:write  统一在主进程写系统剪贴板, 不再依赖 navigator.clipboard 的权限。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ipcMain, dialog, clipboard, shell, BrowserWindow, Menu, app } from 'electron'
import { getWorkspace, getSettings, saveSettings, dataFile, applyTaggerEnv } from './core/workspace.js'
import { bootstrap, status, whenReady } from './core/app-state.js'
import {
  getStats, doSearch, getSeries, getCharacters, getSeriesMeta, postSeriesMeta,
  getSuggest, getAllTags, getScanTagList, getScanTagImages, getTagsForPath, getLightboxData, getTranslations,
  getCoverCandidates, setCover,
} from './core/query.js'
import {
  blacklistText, blacklistRules, saveBlacklistText, toggleBlacklistTag,
  replaceText, saveReplaceText, loadReplaceRules, loadReplaceRulesGroup,
  replaceSets, saveReplaceSets, loadBgConfig, invalidateRuleCaches,
  testReplaceRules,
} from './core/rules.js'
import {
  historySummary, historyDetail, saveHistory, deleteHistory, renameHistory,
} from './core/cart.js'
import { buildExportAsync, buildCartExport, filterTagsLikeExport } from './core/exporter.js'
import {
  listPresets, savePreset, deletePreset, runPreset,
  blacklistFingerprint, afterBlacklistChange, setAutoNotifier, flushAuto,
  autoState, DELAY_OPTIONS, setAutoDelayMs, flushPendingNow,
} from './core/exportPresets.js'
import {
  cartPresetState, saveCartPreset, runCartPreset, notifyCartChanged,
  flushCartPendingNow, setCartNotifier,
} from './core/cartPreset.js'
import { scanFolder, scanCacheStats, purgeScanCachePaths, scanFolderStats } from './core/scan.js'
import { previewTagEdit, applyTagEdit } from './core/tagedit.js'
import { openDb } from './core/store.js'
import { loadCats, reloadCats, catOf } from './core/tagcats.js'
import { findDuplicateGroups } from './core/dupcheck.js'
import { loadIgnorePairs, addIgnorePairs, clearIgnorePairs } from './core/dupignore.js'
import { copyImageWithNotice, openWithDialog } from './core/clipboardImage.js'
import {
  runIngest, ingestStatus, pauseIngest, ingestState, queueStats, enqueueFolderUntagged,
} from './core/ingest.js'
import {
  runTagger, taggerStatus, pauseTagger, taggerConfig, taggerState,
} from './core/tagger.js'
import { orphanStats, requeueOrphans } from './core/orphans.js'
import {
  listFolders, addFolder, removeFolder, updateFolder, rescanFolder, openFolder, pruneMissing,
  purgeFolder, exportFoldersJson, refreshScanStats,
} from './core/folders.js'
import { thumbStats, clearThumbs, thumbCacheSize } from './core/thumbs.js'
import {
  safetySummary, saveSafetyState, safetyText, saveSafetyText, toggleSafetyTag,
} from './core/safety.js'
// ds/tagPoolSize 供旧逻辑用; recomputeSafety 只为读数据集里那两个敏感标记计数
// (安全模式界面要显示"开了会隐藏多少张"), 别拆成两行 import —— ESM 会因重复声明直接报错。
import { ds, tagPoolSize, recomputeSafety, relocateRecord } from './core/dataset.js'
import { searchStats, clearSearchCache } from './core/search.js'
import { moveFile, copyFile } from './core/fileTransfer.js'
import { spawnOpenWith, detectPhotoshop, INPAINT_EXE } from './core/externalApp.js'
import { charLibDiag } from './core/charlib.js'
import { translateInfo } from './core/translate.js'
import { resolveFavorites } from './core/favResolve.js'
import { dimsForPaths } from './core/dims.js'
import { flog } from './core/filelog.js'

const log = (...a) => console.log('[ipc]', ...a)

/**
 * 库内路径 -> Windows 原生路径(只给 shell API 用)
 * ================================================
 * 数据库 `images.path` 存的是正斜杠写法, fs.*(libuv)两种写法通吃,
 * 但 **shell API 只认反斜杠** —— 2026-09-20 隔离探针 A/B 实测(同目录同命名, 只换写法):
 *   · 反斜杠(磁盘枚举的原生写法)   三盘 trashItem 全部成功;
 *   · 正斜杠(DB 存的写法)          三盘全部 "Failed to parse path", 文件原地不动
 *     (Electron 内部走 IShellItem 解析, 正斜杠解析失败)。
 * 这就是"扫描页删除正常、库内删除全报文件被占用"的根因: 扫描页路径来自磁盘枚举,
 * 库内路径来自数据库, 之前被误判成"文件占用"。
 * 盘符顺手转大写(正斜杠+小写盘符的写法同样探针复现失败)。
 */
function toNativePath(p) {
  let s = String(p || '')
  if (/^[a-z]:/i.test(s)) s = s[0].toUpperCase() + s.slice(1)
  return path.normalize(s)          // / 与混写统一成 \
}

/** 统一包一层: 异常变成 { error } */
function safe(fn) {
  return async (event, payload) => {
    try {
      return await fn(payload ?? {}, event)
    } catch (e) {
      console.error('[ipc] handler 异常:', e)
      // 双击启动时 stdout 没人接, 必须落盘才能在 launch.log 里看到异常
      flog('ipc-err', `${e?.stack || e?.message || e}`)
      return { error: e?.message || String(e) }
    }
  }
}

/**
 * 需要"数据集已就绪"才能算的 channel。
 * 窗口是在数据加载**之前**就渲染出来的, 渲染进程一挂载就会发 stats:get / search:do,
 * 若此时直接算, 返回的是半份数据(总数偏小、来源计数几乎全 0), 而渲染进程拿到就存进
 * store, 不会再自己刷新 —— 界面上就永远显示那个偏小的数字。
 * 详见 core/app-state.js 里 whenReady() 的注释。
 */
const DATA_CHANNELS = new Set([
  'stats:get', 'search:do',
    'series:get', 'characters:get',
    'covers:candidates',
  'suggest:get', 'tags:all', 'tags:forPath', 'lightbox:data', 'translate:get', 'tags:scanList',
  'export:preview', 'export:save', 'export:text', 'export:cart',
  'scan:folder',
  'folders:open', 'folders:rescan',
  // folders:add 刻意不设门禁(2026-10-02): 它是空库的死锁解扣 —— 首次启动时库是空的,
  // bootstrap 必然失败, 门禁若把"登记第一个文件夹"也拦住, 空态就永远出不去
  // (绿色包用户实测踩中: 选完文件夹报"没有可用的标签数据")。登记与自动同步直接走
  // tags.db, 不读内存数据集, 无需等就绪。
])

/** 先等数据就绪, 再交给真正的 handler */
function gated(handler) {
  return async (event, payload) => {
    try {
      await whenReady()
    } catch (e) {
      return { error: e?.message || String(e) }
    }
    return handler(event, payload)
  }
}

function mainWindow() {
  return BrowserWindow.getAllWindows()[0] || null
}

/** 把文件夹存进「移动到」预设列表(按路径去重, 上限 50), 结果随 invoke 返回给渲染层弹 toast */
function addQuickFolderAndReturn(dirPath) {
  const clean = path.resolve(dirPath)
  const cur = Array.isArray(getSettings().quickFolders) ? getSettings().quickFolders : []
  if (cur.some((f) => f.path.toLowerCase() === clean.toLowerCase())) {
    return { action: 'quick-exists', result: { ok: false, error: '这个文件夹已经在预设里了' } }
  }
  const name = path.basename(clean) || clean
  saveSettings({ quickFolders: [...cur, { name, path: clean }] })
  return { action: 'quick-added', result: { ok: true, name } }
}

/**
 * 外部程序"启动后秒退"的通知出口: 这类失败发生在 invoke 已经回执之后,
 * 渲染层拿不到, 只能走 app:toast 推送(与复制图像那条路同一条通道)。
 */
function pushOpenWithFail(r) {
  const text = `⚠️ 程序启动后立刻退出: ${r?.error || '未知原因'}`
  flog('open-with', `late-fail ${r?.error || ''}`)
  mainWindow()?.webContents.send('app:toast', { text, tone: 'err', dur: 5000 })
}

/** 「用其他程序打开」的预置 + 最近使用合并清单(供二级菜单渲染) */
function openWithPresets() {
  const out = []
  const ps = detectPhotoshop()
  if (ps) out.push({ name: 'Photoshop', path: ps })
  if (fs.existsSync(INPAINT_EXE)) out.push({ name: 'Inpaint', path: INPAINT_EXE })
  // PS 没探测到时给一句说明(不然用户会以为"菜单漏了这一项")
  if (!ps) out.push({ name: 'Photoshop', path: '', missing: '未找到 Photoshop' })
  const recents = Array.isArray(getSettings().recentOpenWith) ? getSettings().recentOpenWith : []
  for (const r of recents) {
    if (!out.some((x) => x.path.toLowerCase() === r.path.toLowerCase())) out.push({ name: r.name, path: r.path })
  }
  return out
}

/** 用过的外部程序记进 MRU(去重、置顶、留 6 个), 下次二级菜单排前面 */
function recordRecentOpenWith(exe) {
  const clean = path.resolve(exe)
  const cur = Array.isArray(getSettings().recentOpenWith) ? getSettings().recentOpenWith : []
  const rest = cur.filter((a) => a.path.toLowerCase() !== clean.toLowerCase())
  saveSettings({ recentOpenWith: [{ name: path.basename(clean, '.exe'), path: clean }, ...rest] })
}


/**
 * 目录路径 -> 它所属(或就是)的登记文件夹记录; 没命中返回 null。
 * 用于 image:moveMany: 图搬进某个登记来源后要后台补同步。
 * 匹配规则: 盘符大小写/斜杠方向都归一, 目标 = 登记路径本身或其子目录。
 */
function findFolderByDir(dir) {
  const clean = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const want = clean(dir)
  if (!want) return null
  const rows = listFolders({ usage: 'all' }).folders || []
  return rows.find((f) => {
    const fp = clean(f.path)
    return fp && (want === fp || want.startsWith(`${fp}/`))
  }) || null
}

/** 扫描元数据解析进度 -> 渲染端进度条(ScanView 订阅) */
function pushScanProgress(p) {
  mainWindow()?.webContents.send('scan:progress', p)
}

/** 流式扫描(2026-10-16): 后台每解析完一批 / 全部扫完 -> 渲染端增量合并(ScanView 订阅) */
function pushScanPartial(p) {
  mainWindow()?.webContents.send('scan:partial', p)
}
function pushScanFinal(out) {
  mainWindow()?.webContents.send('scan:final', out)
}
/** 大文件夹流式扫描的参数包: 首批 100 张先返回, 后台续扫走增量推送 */
const SCAN_STREAM_OPTS = {
  firstBatch: 100,
  onPartial: pushScanPartial,
  onFinal: pushScanFinal,
}

/** 后台增量同步进度 -> 渲染端顶栏 */
function pushIngestProgress(p) {
  mainWindow()?.webContents.send('ingest:progress', p)
}

/** WD14 反推进度 -> 渲染端(与同步共用右下角那根胶囊) */
function pushTaggerProgress(p) {
  mainWindow()?.webContents.send('tagger:progress', p)
}

/**
 * 「刚被登记为看板来源」的目录, 自动补一次增量同步(2026-10-03 起反推不由它触发: 本会话攒队列, 重启由启动链路统一推)。
 *
 * 为什么必须补这一步: 把目录登记为来源只是**改名**(folders.as_source=1), 它不会让
 * 图片自动进库。真正的入库在 ingest, 而 ingest 只遍历 `as_source = 1` 的目录
 * (ingest.js 的 SQL) —— 两条路各走各的, 中间没人踢一脚, 于是"改了来源但库里
 * 一张图都没多、反推队列恒为空"。这正是 auto_tag 字段(建表时就有、一直没人消费)
 * 预留的那个位置。
 *
 * 两道闸, 缺一不可:
 *   · folder.auto_tag —— 用户可单独关掉"这个目录别自动反推";
 *   · `TV_INGEST=0` —— 与后台同步**共用同一个总闸**(main.js 的 scheduleIngest 同款)。
 *     这道必须留: 自动行为绝不能在测试/dev 里偷偷去 stat 用户真实盘符上的几万个文件,
 *     那正是 electron-path.mjs 默认设 TV_INGEST=0 要防的事。
 *
 * **绝不 await**: 首次同步是分钟级(要枚举目录下全部文件), 挂在这里等会把
 * 「改开关」这个动作卡住不返回。返回的是一个**同步判定**供调用方回执/断言,
 * 真跑在后台, 结果由 onIngestDone 接走(= startLoad 静默重载)。
 */
function kickAutoSync(folder, onIngestDone) {
  if (folder.auto_tag === false) {
    return { wanted: false, started: false, reason: 'auto-tag-off' }
  }
  if (process.env.TV_INGEST === '0') {
    return { wanted: true, started: false, reason: 'ingest-gate' }
  }
  runIngest({
    only: folder.id,
    onProgress: pushIngestProgress,
  })
    .then((st) => {
      if (!st || st.error) return
      if (st.skipped) {
        flog('auto-sync', `跳过(${st.reason || 'busy'}): ${folder.path}`)
        // 2026-10-03: skipped 也要接 onIngestDone —— 队列里可能压着上一轮
        // 入队的裸图(指纹相同 -> 全 skipped), 这时断了反推就没人消费队列。
        // scheduleTagging 自己会判队列空 -> 不拉模型, 代价为零。
      }
      // 即使这一轮没新增也照样走: 用户改来源的意图就是"纳进来并出标签", 队列里
      // 可能还压着上一轮没跑完的裸图 —— 2026-10-03 起 onIngestDone 只做 startLoad
      // 静默重载, 反推留给重启后的启动链路统一推。
      onIngestDone?.()
    })
    .catch((e) => flog('auto-sync-err', `${e?.stack || e}`))
  return { wanted: true, started: true, reason: '' }
}

export function registerIpc({ onReload, onIngestDone, onTaggerDone, onCheckUpdate, onSetupDownload } = {}) {
  // tagger:accel 的会话级缓存(见 handler 注释)
  let accelCache = null
  // 自动导出的结果(成功/失败)由主进程推给渲染层弹 toast。
  // 注册一次即可: 防抖到期时主窗口可能已经不是同一个, 所以每次都现取。
  setAutoNotifier((payload) => mainWindow()?.webContents.send('export:auto', payload))
  // 购物车自动导出的结果同理 —— 排程倒计时/结果都靠它。
  setCartNotifier((payload) => mainWindow()?.webContents.send('cart:auto', payload))

  const map = {
    // ---------------- 应用 / 数据集 ----------------
    'app:status': safe(() => status()),
    'app:reload': safe(async () => {
      const r = await bootstrap({
        onProgress: (p) => mainWindow()?.webContents.send('app:progress', p),
      })
      onReload?.()
      return r
    }),
    'app:config': safe(() => ({
      workspace: getWorkspace(),
      config: status().config,
      sources: status().sources,
    })),
    'app:pickDataDir': safe(async () => {
      const r = await dialog.showOpenDialog(mainWindow(), {
        title: '选择数据目录(含 export_blacklist.txt / user_meta.json 的目录)',
        properties: ['openDirectory'],
        defaultPath: getWorkspace().dataDir,
      })
      if (r.canceled || !r.filePaths.length) return { canceled: true }
      saveSettings({ dataDir: r.filePaths[0] })
      return { ok: true, dataDir: r.filePaths[0] }
    }),
    'app:openPath': safe(async ({ target }) => {
      const p = target || getWorkspace().dataDir
      const err = await shell.openPath(p)
      return err ? { error: err } : { ok: true }
    }),
    'app:revealPath': safe(({ target }) => {
      if (!target) return { error: 'no target' }
      shell.showItemInFolder(target)
      return { ok: true }
    }),

    // ---------------- 图片右键菜单 ----------------
    // 渲染层把「这张图有什么」(路径/标签/收藏态) 发过来, 主进程弹原生菜单。
    // 主进程能自己干的(复制图片/文本、系统查看器、资源管理器)当场干完;
    // 需要渲染层接手的(打开详情页/切换收藏)把 action 原样返回, 由调用方处理。
    'app:ctxMenu': safe(async (payload, event) => {
      const { path: rawPath, name, tags, favable, favorited } = payload || {}
      if (!rawPath || typeof rawPath !== 'string') return { action: null }
      // openPath / showItemInFolder 同 trashItem 一样是 shell API —— 只认反斜杠
      // (库内正斜杠路径上「打开」「在资源管理器中显示」会静默失败); fs 类调用顺带受益。
      const imgPath = toNativePath(rawPath)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { action: null }

      let chosen = null
      const copyText = (t) => { try { clipboard.writeText(String(t ?? '')) } catch { /* 忽略 */ } }
      const item = (label, id) => ({
        label,
        click: () => {
          chosen = { action: id }
          // ⚠️ 复制图像 / 打开方式**不在这里做**：
          //   · 复制图像是同步冻主进程的活儿（大图 toPNG 实测 5 秒），必须先推一句
          //     「正在复制…」再动手，而点击回调里没有机会让渲染层画一帧 —— 收尾放在
          //     菜单关闭之后（见下面的 copy-image 分支）。
          //   · 打开方式要另起进程，也想把成败回给渲染层弹提示。
          if (id === 'reveal') { shell.showItemInFolder(imgPath) }
          else if (id === 'copy-path') { copyText(imgPath) }
          else if (id === 'copy-name') { copyText(name || path.basename(imgPath)) }
          else if (id === 'copy-tags') { copyText(tags || '') }
          // toggle-fav / detail: 渲染层自己接手
        },
      })

      // 「移动到」子菜单: 预设文件夹(settings.json quickFolders) + 选其他文件夹 + 存预设。
      // 搬移/选目录都在菜单关闭后由本 handler 收尾, 结果随 invoke 返回给渲染层弹 toast。
      const quickFolders = Array.isArray(getSettings().quickFolders) ? getSettings().quickFolders : []
      const moveSub = quickFolders.map((f) => ({
        label: `${f.name}     ${f.path}`.slice(0, 96),
        click: () => { chosen = { action: 'move', target: f.path } },
      }))
      if (!moveSub.length) moveSub.push({ label: '(还没有预设文件夹)', enabled: false })
      else moveSub.push({ type: 'separator' })
      moveSub.push({
        label: '选择其他文件夹…',
        click: () => { chosen = { action: 'move-pick' } },
      })
      moveSub.push({ type: 'separator' })
      moveSub.push({
        label: '把当前文件夹存为预设',
        click: () => { chosen = { action: 'add-quick', target: path.dirname(imgPath) } },
      })
      moveSub.push({
        label: '添加预设文件夹…',
        click: () => { chosen = { action: 'add-quick-pick' } },
      })

      // 「用其他程序打开」二级菜单(2026-10-16): 预置(PS 自动探测 / Inpaint 固定路径)
      // + 最近使用(settings.recentOpenWith, MRU) + 底部「浏览…」兜底(原来的系统对话框)。
      const openWithSub = openWithPresets().map((a) => a.missing
        ? { label: `${a.name} —— ${a.missing}`, enabled: false }
        : {
          label: `${a.name}     ${a.path}`.slice(0, 96),
          click: () => { chosen = { action: 'openwith-exe', target: a.path } },
        })
      if (!openWithSub.length) openWithSub.push({ label: '(没有可用程序)', enabled: false })
      else openWithSub.push({ type: 'separator' })
      // 两根兜底: 自己挑 exe(拿得到路径 -> 能进 MRU, 下次排前面) 与系统原生对话框。
      // 分开是因为原生那个「选择应用」对话框**不告诉调用方用户选了谁**, 没法记;
      // 但它能列出 UWP/商店应用, 所以不能只留自己挑的那条。
      openWithSub.push({
        label: '选择其他程序…(会记住)',
        click: () => { chosen = { action: 'openwith-pick' } },
      })
      openWithSub.push({
        label: 'Windows 打开方式…',
        click: () => { chosen = { action: 'open-with' } },
      })

      // 「复制到」子菜单: 复用「移动到」同一份预设(quickFolders), 只复制不搬移。
      const copySub = quickFolders.map((f) => ({
        label: `${f.name}     ${f.path}`.slice(0, 96),
        click: () => { chosen = { action: 'copy', target: f.path } },
      }))
      if (!copySub.length) copySub.push({ label: '(还没有预设文件夹)', enabled: false })
      else copySub.push({ type: 'separator' })
      copySub.push({
        label: '选择其他文件夹…',
        click: () => { chosen = { action: 'copy-pick' } },
      })

      const template = [
        item('🖼️ 复制图片到剪贴板', 'copy-image'),
        { label: '🗂️ 用其他程序打开', submenu: openWithSub },
        item('📁 打开图片所在位置', 'reveal'),
        { label: '📤 移动到', submenu: moveSub },
        { label: '📋 复制到', submenu: copySub },
        { type: 'separator' },
        item('📋 复制文件路径', 'copy-path'),
        item('📝 复制文件名', 'copy-name'),
      ]
      if (typeof tags === 'string' && tags.length) {
        template.push(item('🏷️ 复制全部标签', 'copy-tags'))
      }
      template.push({ type: 'separator' })
      if (favable) template.push(item(favorited ? '★ 取消收藏' : '☆ 收藏', 'toggle-fav'))
      template.push(item('🗑 删除到回收站', 'trash'))

      /**
       * 原生菜单**点不到** —— CDP 只能驱动页面, 弹出来的 Menu 是操作系统的窗口,
       * e2e 里没有任何办法选中「📤 移动到 > 某个预设」(2026-09-19 踩到: 于是
       * 那条"移动后自动切下一张"的断言只能手动 dispatchEvent('tv:moved'),
       * 测的是消费端, 生产端完全没覆盖, 结果用户一用就反馈"还是不行")。
       *
       * 所以留一个环境变量开关: 设置后**跳过 popup**, 直接当成用户点了
       * 「移动到 <该目录>」。它只替换"点了哪一项"这一步 ——
       * 后面的 moveFile / 作废扫描缓存 / 返回 action='moved' 全走真实代码路径。
       * 只在测试进程里由 scripts/e2e.mjs 注入, 正常运行时不设。
       */
      const autoMove = process.env.TV_E2E_CTX_MOVE
      if (autoMove) {
        chosen = { action: 'move', target: autoMove }
      } else {
        // popup 的 callback 在菜单关闭时触发 —— invoke 会等到用户点完/关掉才 resolve
        await new Promise((resolve) => Menu.buildFromTemplate(template).popup({ window: win, callback: resolve }))
      }

      // ---- 菜单关闭后的收尾动作(搬移/弹目录选择框/复制图像), 结果返回给渲染层弹提示 ----
      const act = chosen?.action
      if (act === 'copy-image') {
        // 先把「正在复制图像（宽×高）…」推到界面上、让渲染层真的画一帧, 再进同步段。
        // 直接点完就干活的话, 大图那 5 秒里屏幕上没有任何变化 —— 用户以为没响应,
        // 这就是 2026-09-24 报的「点了没反应、粘贴不出来」的观感来源。
        const result = await copyImageWithNotice(imgPath, (text) => {
          mainWindow()?.webContents.send('app:toast', { text, tone: 'info', dur: 6000 })
        })
        return { action: 'copy-image', result, from: imgPath }
      }
      if (act === 'open-with') {
        return { action: 'open-with', result: await openWithDialog(imgPath), from: imgPath }
      }
      if (act === 'openwith-exe' && chosen.target) {
        // 外部程序"点了没反应"是最难排查的一类: 进程起没起来、参数对不对、起来了
        // 有没有秒退, 界面上一概看不出。每次都落一行日志(launch.log 的 open-with
        // 通道); "秒退"没有 invoke 回执可带, 只能从主进程直接推 toast。
        const r = await spawnOpenWith(chosen.target, imgPath, { notify: pushOpenWithFail })
        if (r.ok) recordRecentOpenWith(chosen.target)
        flog('open-with', `${r.ok ? 'ok' : 'FAIL'} exe=${chosen.target} file=${imgPath} pid=${r.pid || '-'}${r.ok ? '' : ` err=${r.error}`}`)
        return { action: 'open-with', result: { ...r, exe: chosen.target }, from: imgPath }
      }
      if (act === 'openwith-pick') {
        const pick = await dialog.showOpenDialog(win, {
          title: '选择用来打开图片的程序',
          properties: ['openFile'],
          filters: [{ name: '程序', extensions: ['exe'] }],
          // path-check-ignore: 打开文件框的默认落点, 写在 filters 之后
          defaultPath: 'C:\\Program Files',
        })
        if (pick.canceled || !pick.filePaths.length) return { action: null }
        const exe = pick.filePaths[0]
        if (!/\.exe$/i.test(exe)) {
          return { action: 'open-with', result: { ok: false, error: '只能选 .exe 程序' }, from: imgPath }
        }
        const r = await spawnOpenWith(exe, imgPath)
        if (r.ok) recordRecentOpenWith(exe)
        flog('open-with', `${r.ok ? 'ok' : 'FAIL'} exe=${exe} file=${imgPath}${r.ok ? '' : ` err=${r.error}`}`)
        return { action: 'open-with', result: { ...r, exe }, from: imgPath }
      }
      if (act === 'copy' && chosen.target) {
        const r = await copyFile(imgPath, chosen.target)
        return { action: r.ok ? 'copied' : 'copy-failed', result: r, from: imgPath }
      }
      if (act === 'copy-pick') {
        const pick = await dialog.showOpenDialog(win, {
          title: '复制图片到…',
          properties: ['openDirectory'],
          defaultPath: path.dirname(imgPath),
        })
        if (pick.canceled || !pick.filePaths.length) return { action: null }
        const r = await copyFile(imgPath, pick.filePaths[0])
        return { action: r.ok ? 'copied' : 'copy-failed', result: r, from: imgPath }
      }
      if (act === 'move' && chosen.target) {
        const r = await moveFile(imgPath, chosen.target)
        if (r.ok) purgeScanCachePaths([imgPath])
        return { action: r.ok ? 'moved' : 'move-failed', result: r, from: imgPath }
      }
      if (act === 'move-pick') {
        const pick = await dialog.showOpenDialog(win, {
          title: '移动图片到…',
          properties: ['openDirectory'],
          defaultPath: path.dirname(imgPath),
        })
        if (pick.canceled || !pick.filePaths.length) return { action: null }
        const r = await moveFile(imgPath, pick.filePaths[0])
        if (r.ok) purgeScanCachePaths([imgPath])
        return { action: r.ok ? 'moved' : 'move-failed', result: r, from: imgPath }
      }
      if (act === 'add-quick' && chosen.target) {
        return addQuickFolderAndReturn(chosen.target)
      }
      if (act === 'add-quick-pick') {
        const pick = await dialog.showOpenDialog(win, {
          title: '添加预设文件夹',
          properties: ['openDirectory'],
          defaultPath: path.dirname(imgPath),
        })
        if (pick.canceled || !pick.filePaths.length) return { action: null }
        return addQuickFolderAndReturn(pick.filePaths[0])
      }
      return chosen || { action: null }
    }),

    // ---------------- 统计 / 搜索 ----------------
    'stats:get': safe((raw) => getStats(raw)),
    'search:do': safe((raw) => doSearch(raw)),

    // ---------------- 系列 / 角色 ----------------
    'series:get': safe((raw) => getSeries(raw)),
    'series:meta:get': safe(() => getSeriesMeta()),
    'series:meta:post': safe((body) => postSeriesMeta(body)),
    'characters:get': safe((raw) => getCharacters(raw)),
    'covers:candidates': safe((raw) => getCoverCandidates(raw)),
    'covers:set': safe((raw) => setCover(raw)),

    // ---------------- 标签 ----------------
    'suggest:get': safe((raw) => getSuggest(raw)),
    'tags:all': safe((raw) => getAllTags(raw)),
    // 扫描文件夹的标签列表(2026-10-21): 数据源是扫描的持久缓存, 纯内存聚合
    'tags:scanList': safe((raw) => getScanTagList(raw)),
    // 扫描缓存里的「标签 -> 图片」(2026-10-21): 标签图片页扫描档 —— 纯扫描夹的图
    // 不进库, doSearch 筛不到, 从缓存出。不依赖数据集, 故不进 DATA_CHANNELS
    'scan:tagImages': safe((raw) => getScanTagImages(raw)),
    // 每个扫描文件夹自己的缓存概况(2026-10-21): 筛选 chips 的真实计数
    'scan:folderStats': safe((raw) => scanFolderStats(raw?.paths || [])),
    // tag 查重(2026-10-17): 两阶段相似度分组, 纯内存 2s 左右, 不落库。
    // 阈值走参数, 结果 { scanned, candidates, ignoredPairs, groups:[{score,shared,items}], elapsedMs }
    'dup:scan': safe((raw) => {
      const o = raw || {}
      return findDuplicateGroups({
        threshold: Number(o.threshold) > 0 ? Number(o.threshold) : 0.85,
        maxGroups: Number(o.maxGroups) > 0 ? Number(o.maxGroups) : 2000,
        ignorePairs: loadIgnorePairs(),
      })
    }),
    // 误报忽略(2026-10-17): 渲染层把整组两两 id 对发来, 持久化到 user/dupcheck_ignore.json
    'dup:ignore:add': safe((raw) => ({ added: addIgnorePairs(raw?.pairs || []) })),
    'dup:ignore:clear': safe(() => ({ removed: clearIgnorePairs() })),
    // 标签分类映射(2026-10-16): 展示端分组着色用。tags 字典的 cat 列是快照,
    // 空的(新词/分类器当时不可用)现场 classify 补 —— 保证映射永远可用。
    'tags:cats': safe(() => {
      const db = openDb()
      const out = {}
      for (const r of db.prepare("SELECT name, cat FROM tags WHERE cat != ''").all()) {
        out[r.name] = r.cat
      }
      const missing = db.prepare("SELECT name FROM tags WHERE cat = ''").all().map((r) => r.name)
      if (missing.length) {
        loadCats()
        for (const n of missing) {
          const c = catOf(n)
          out[n] = c
          db.prepare('UPDATE tags SET cat = ? WHERE name = ?').run(c, n)
        }
      }
      return { cats: out }
    }),
    // ---------------- 标签改名 / 删除(2026-10-01) ----------------
    // 预览只读; apply 走 tagedit.js(备份 -> 事务 -> rebuildTags), 改完顺手重载数据集
    // —— 否则库是新的、内存里是旧的, 界面看不到改完的效果(与反推后的重载同一理由)。
    'tags:edit:preview': safe(({ op, from, to, scopeTag } = {}) => previewTagEdit({ op, from, to, scopeTag })),
    'tags:edit:apply': safe(async ({ op, from, to, scopeTag } = {}) => {
      const r = applyTagEdit({ op, from, to, scopeTag })
      const st = await bootstrap({
        onProgress: (p) => mainWindow()?.webContents.send('app:progress', p),
      })
      onReload?.()
      // 与 main.js startLoad 同款: 重载完把新状态推给渲染层(顶栏计数/各 store 刷新)
      mainWindow()?.webContents.send('app:reloaded', st)
      return r
    }),
    'tags:forPath': safe((raw) => getTagsForPath(raw)),
    'lightbox:data': safe((raw) => getLightboxData(raw)),
    // 光箱「复制标签」的过滤管线(2026-10-19): 与导出同一套原语算视角/安全/替换。
    // 黑名单与角色系列在渲染层剔(光箱手里已有 ban_map / plain_tags)。
    'tags:filterCopy': safe((raw) => filterTagsLikeExport(raw?.tags || [], raw?.opts || {})),
    'translate:get': safe((raw) => getTranslations(raw)),

    // ---------------- 规则(黑名单 / 替换 / 背景) ----------------
    'blacklist:get': safe(() => ({ rules: blacklistRules(), text: blacklistText() })),
    // 保存 / 单条 ban-unban: 改完看一眼"内容是不是真的变了" —— 变了才排自动导出。
    // (原样保存一次、或点了 🚫 但被通配规则挡下, 都不该白跑一遍导出)
    'blacklist:save': safe(({ text }) => {
      const before = blacklistFingerprint()
      const r = saveBlacklistText(text)
      return { ...r, auto: afterBlacklistChange(before) }
    }),
    'blacklist:toggle': safe(({ tag }) => {
      const before = blacklistFingerprint()
      const r = toggleBlacklistTag(tag)
      return { ...r, auto: afterBlacklistChange(before) }
    }),
    'replace:get': safe(() => ({ rules: loadReplaceRules(), text: replaceText() })),
    'replace:save': safe(({ text }) => saveReplaceText(text)),
    /* 替换规则组(2026-10-04): 多套规则手动命名、导出时选哪一套。
       读接口顺带带上**编译好的默认组规则**, 好让前端显示"当前生效 N 条"。 */
    'replace:sets': safe(() => {
      const { active, sets } = replaceSets()
      return { active, sets, rules: loadReplaceRulesGroup(active) }
    }),
    'replace:sets:save': safe((body) => saveReplaceSets(body || {})),
    'bg:get': safe(() => loadBgConfig()),
    'rules:reload': safe(() => { invalidateRuleCaches(); return { ok: true } }),
    // 规则测试器(编辑器底部 🧪): 与导出引擎同一套代码算命中与替换结果
    'rules:test': safe((raw) => testReplaceRules(raw || {})),

    // ---------------- 安全模式(按标签集合隐藏露骨内容) ----------------
    /* 只做**展示层过滤**: 库里一行数据都不动, 统计数字也不重算 —— 开关关掉
       立刻全回来。标记在读数据集时就算好了(record.unsafe = 0/1/2), 所以这里
       切开关/切档位只是改一个 json, 不需要重载八万行数据。 */
    'safety:get': safe(() => ({
      ...safetySummary(),
      // 两个档位各会隐藏多少张(core 段命中数 / 仅 edge 段命中数)
      coreHit: ds.unsafeCore,
      edgeHit: ds.unsafeCore + ds.unsafeEdge,
      total: ds.records.length,
    })),
    'safety:set': safe((raw) => saveSafetyState(raw || {})),
    'safety:text': safe(() => ({ text: safetyText() })),
    // 改了集合必须**重算标记** —— record.unsafe 是读数据集时按当时的集合算的。
    // 只遍历内存(约 150ms), 不重读库; 前端拿新标记由渲染层 bump 一次版本号
    // 让各视图重查(见 useSafetyStore)。
    'safety:save': safe(({ text }) => {
      const r = saveSafetyText(text)
      const counts = recomputeSafety()
      return { ...r, ...counts }
    }),
    'safety:toggle': safe(({ tag, level }) => {
      const r = toggleSafetyTag(tag, level)
      const counts = recomputeSafety()
      return { ...r, ...counts }
    }),

    // ---------------- 购物车历史 ----------------
    'cart:history': safe(() => historySummary()),
    'cart:detail': safe(({ name }) => historyDetail(name)),
    'cart:save': safe(({ name, cart }) => saveHistory(name, cart)),
    'cart:delete': safe(({ name }) => deleteHistory(name)),
    'cart:rename': safe(({ old_name, new_name }) => renameHistory(old_name, new_name)),

    // ---------------- 购物车自动导出(单预设) ----------------
    // 渲染层的 useCartStore 每次变更都会报一次(六个入口共用这一条上报), 主进程
    // 拿它当"购物车有更新"的判据 —— 指纹没变就是空操作。
    'cart:changed': safe(({ tags } = {}) => notifyCartChanged(tags)),
    'cart:preset:get': safe(() => cartPresetState()),
    'cart:preset:save': safe((patch) => saveCartPreset(patch || {})),
    // 立即导出一次: tags 由调用方带上(渲染层那份是最新的, 主进程内存里可能还没有)
    'cart:preset:run': safe(({ tags } = {}) => runCartPreset({ tags, trigger: 'manual' })),
    // 跳过等待、立刻导掉排程中的那次(抽屉里的「立刻导」/ 关窗前收尾)
    'cart:preset:flushNow': safe(() => flushCartPendingNow()),

    // ---------------- 导出 ----------------
    // 先算好, 再弹「另存为」; 用户取消时不会白算一遍。
    // 全部走 buildExportAsync 分片管线(2026-10-20): 大结果集上不再占死主进程
    'export:preview': safe(async (raw) => {
      const r = await buildExportAsync(raw)
      return { count: r.count, blocked: r.blocked, replaced: r.replaced, bgAdded: r.bgAdded, stripped: r.stripped || 0, ms: r.ms, suggestedName: r.suggestedName }
    }),
    'export:save': safe(async (raw) => {
      const r = await buildExportAsync(raw)
      const dlg = await dialog.showSaveDialog(mainWindow(), {
        title: '导出筛选结果',
        defaultPath: path.join(path.dirname(getWorkspace().dataDir), r.suggestedName),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      })
      if (dlg.canceled || !dlg.filePath) return { canceled: true, count: r.count }
      await fs.promises.writeFile(dlg.filePath, r.text, 'utf8')
      return { ok: true, path: dlg.filePath, count: r.count, replaced: r.replaced, bytes: Buffer.byteLength(r.text, 'utf8') }
    }),
    'export:text': safe((raw) => buildExportAsync(raw)),

    // ---------------- 导出预设(黑名单变更后自动导出) ----------------
    'export:preset:list': safe(() => ({ presets: listPresets() })),
    'export:preset:save': safe((raw) => savePreset(raw)),
    'export:preset:delete': safe(({ id }) => deletePreset(id)),
    'export:preset:run': safe(({ id }) => runPreset(id, { trigger: 'manual' })),
    // 排程状态 + 延迟档位 —— 渲染层显示「待导出 mm:ss」倒计时与延迟下拉都靠它。
    // 档位从主进程带出去(而不是渲染层自己写一份), 免得两边漂移:
    // 一边改了档位、另一边还按旧值显示, 用户会看到"选了 1 分钟却等 3 分钟"。
    'export:preset:state': safe(() => ({ ...autoState(), delayOptions: DELAY_OPTIONS })),
    // 改全局延迟。立刻生效: 正排着队等的那批会按新时长重排(见 setAutoDelayMs)
    'export:preset:delay': safe(({ delayMs } = {}) => setAutoDelayMs(delayMs)),
    // 跳过等待、立刻导(首页角标点一下)。没有排程就是空操作, 不会白跑一次重活
    'export:preset:flushNow': safe(() => flushPendingNow()),
    // 等"排程中的自动导出"跑完 —— 关窗/换数据前收尾用, 保证落盘不半途而废
    'export:preset:flush': safe(async () => { await flushAuto(); return { ok: true } }),
    // 选目标目录: 与 scan:pickFolder 同一套"记住上次选的目录"行为
    'export:preset:pickDir': safe(async () => {
      const last = getSettings().lastPickDir
      const r = await dialog.showOpenDialog(mainWindow(), {
        title: '选择自动导出的目标文件夹',
        properties: ['openDirectory', 'createDirectory'],
        ...(last && fs.existsSync(last) ? { defaultPath: last } : {}),
      })
      if (r.canceled || !r.filePaths.length) return { canceled: true }
      saveSettings({ lastPickDir: r.filePaths[0] })
      return { ok: true, path: r.filePaths[0] }
    }),
    'export:cart': safe(async ({ tags, spaces = true, save = true, replace = true, replace_set = '' } = {}) => {
      // 角色表也能套替换规则组(2026-10-04): 一个角色被规则命中成多个标签时
      // buildCartExport 会摊成多行, count 随之变大
      const r = buildCartExport(tags || [], { spaces, replace, replaceSet: replace_set })
      if (!save) return r
      const dlg = await dialog.showSaveDialog(mainWindow(), {
        title: '导出购物车角色(wildcard)',
        defaultPath: path.join(path.dirname(getWorkspace().dataDir), r.suggestedName),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      })
      if (dlg.canceled || !dlg.filePath) return { canceled: true, count: r.count }
      await fs.promises.writeFile(dlg.filePath, r.text, 'utf8')
      return { ok: true, path: dlg.filePath, count: r.count, replaced: r.replaced }
    }),

    // ---------------- 扫描文件夹 ----------------
    'scan:pickFolder': safe(async (raw = {}) => {
      const props = raw.multi ? ['openDirectory', 'multiSelections'] : ['openDirectory']
      const last = getSettings().lastPickDir
      const r = await dialog.showOpenDialog(mainWindow(), {
        title: raw.title || '选择要扫描的文件夹',
        properties: props,
        // 记忆上次选择的目录: 上次选中的(或其所在盘符根)作为这次默认打开位置
        ...(last && fs.existsSync(last) ? { defaultPath: last } : {}),
      })
      if (r.canceled || !r.filePaths.length) return { canceled: true }
      // 记住这次选的目录, 下次对话框从这里打开
      saveSettings({ lastPickDir: r.filePaths[0] })
      // paths 总是数组; path 保留给老调用点(取第一个)
      return { path: r.filePaths[0], paths: r.filePaths }
    }),
    'scan:folder': safe((raw) => scanFolder(raw, pushScanProgress)),

    /* ---------------- 导出默认目录(2026-10-04) ----------------
     * 用户反馈"预设的导出地址要选两次太麻烦"。这里提供:
     *   · defaultDir —— 用户显式设定的全局默认目录(存在 settings.json)
     *   · lastDir    —— 上次在任一目录对话框里选过的路径(主进程一直在记 lastPickDir,
     *                   选一次目录就会刷新, 这里只是把它读出来给前端做默认值)
     * 前端拿它给"新建预设"预填, 大多数时候不用再开系统对话框。 */
    'export:dirs': safe(() => ({
      defaultDir: String(getSettings().exportDefaultDir || ''),
      lastDir: String(getSettings().lastPickDir || ''),
      dataDir: getWorkspace().dataDir || '',
    })),
    'export:dirs:saveDefault': safe(({ dir } = {}) => {
      const v = String(dir || '').trim()
      saveSettings({ exportDefaultDir: v })
      return { ok: true, defaultDir: v }
    }),

    // ---------------- 增量入库(磁盘 <-> tags.db 对齐) ----------------
    // 见 core/ingest.js 与方案 §2.2 的六条判定规则。**DB 是准入闸门** ——
    // 库里已有标签的图一次图都不读, 更不会重跑反推。
    // run 刻意"启动即返回": 首轮要枚举 4 万多个文件、耗时 1-2 分钟,
    // 让 invoke 挂着等会把界面拖住。完成后由 main.js 重载数据集并推 app:reloaded。
    'ingest:status': safe(() => ingestStatus()),
    'ingest:run': safe(async () => {
      if (ingestState.running) return { ok: false, error: '已有同步在跑' }
      runIngest({ onProgress: pushIngestProgress })
        .then((r) => {
          // 2026-10-03: 别再用 !r.skipped 拦 —— "全 skipped 但队列压着待反推"
          // 的轮次断了这里, 队列就没人消费了(另一台机器 633 张卡死的洞之一)。
          if (r && !r.error) onIngestDone?.(r)
        })
        .catch((e) => flog('ingest-err', `${e?.stack || e}`))
      return { ok: true, started: true }
    }),
    'ingest:pause': safe(() => pauseIngest()),

    // ---------------- WD14 反推(消费 tag_queue, 写 tags_src='wd14') ----------------
    // 与同步同样是"启动即返回": 模型要加载 1.27GB + 逐张推理, 首轮分钟级。
    // 缺 python / 模型时不是报错, 而是**降级**: 队列留着, 看板照常 —— 见 core/tagger.js。
    'tagger:status': safe(() => taggerStatus()),
    'tagger:config': safe(() => taggerConfig()),
    'tagger:run': safe(async (raw = {}) => {
      if (taggerState.running) return { ok: false, error: '已有反推在跑' }
      const limit = Math.max(0, parseInt(raw.limit, 10) || 0)
      /* 按来源反推(来源管理页「⚡ 反推」, 2026-10-16):
       * 先补入队 —— 这个来源里**库里还没标签**的图(已有标签的不重复送模型),
       * 再只跑这一个 folder_id。队列里压着别的来源时, 不让用户等全库跑完。 */
      let onlyFolderId = 0
      let queued = 0
      if (raw.folderId) {
        const fid = Number(raw.folderId)
        if (Number.isFinite(fid) && fid > 0) {
          onlyFolderId = fid
          try {
            const r = enqueueFolderUntagged(fid)
            queued = r.queued || 0
            // 一张都没补进去、队列里也没有这个来源的待处理行 -> 确实没活干,
            // 拉起服务也只是白加载 1.27GB 模型, 直接告诉用户。
            if (!r.pending) {
              return { ok: false, error: '这个来源没有待反推的图片(都已打过标签, 或还没同步入库)' }
            }
          } catch (e) {
            flog('tagger-err', `按来源入队失败: ${e?.stack || e}`)
          }
        }
      }
      runTagger({ onProgress: pushTaggerProgress, limit, onlyFolderId })
        .then((r) => {
          if (r && !r.skipped) onTaggerDone?.(r)
        })
        .catch((e) => flog('tagger-err', `${e?.stack || e}`))
      return { ok: true, started: true, queued, onlyFolderId }
    }),
    'tagger:pause': safe(() => pauseTagger()),

    /* 无角色/系列图片补识别(2026-10-21):
     * 先预览(只统计), 用户确认后再入队并立刻开跑。
     * 写回语义在 tagger.js applyTags: 可覆盖来源整体覆盖, legacy 只追加角色/系列。 */
    'tagger:orphans': safe((raw = {}) => orphanStats({
      includeLegacy: !!raw.includeLegacy,
      folderId: Number(raw.folderId) || 0,
    })),
    'tagger:requeue-orphans': safe(async (raw = {}) => {
      if (taggerState.running) return { ok: false, error: '已有反推在跑, 等它结束再补识别' }
      const r = requeueOrphans({
        includeLegacy: !!raw.includeLegacy,
        folderId: Number(raw.folderId) || 0,
      })
      if (!r.queued) return { ok: false, error: '没有需要补识别的图片' }
      runTagger({ onProgress: pushTaggerProgress, onlyOrphans: true })
        .then((x) => {
          if (x && !x.skipped) onTaggerDone?.(x)
        })
        .catch((e) => flog('tagger-err', `${e?.stack || e}`))
      return { ok: true, started: true, ...r }
    }),

    // ---------------- 设置弹窗(2026-10-15): 加速探测 / 偏好写入 / 检查更新 ----------------
    // 'tagger:accel': 探测当前反推解释器的 onnxruntime 加速能力(进程内有缓存 ——
    //   装包不会在会话中途变, 反复打开弹窗不重复跑子进程; 换了解释器则重探)。
    'tagger:accel': safe(async () => {
      const cfg = taggerConfig()
      const exe = cfg.pythonOnDisk ? cfg.python : (getSettings().pythonPath || '')
      if (!exe) return { ok: false, error: '还没有可用的 Python 解释器' }
      if (!accelCache || accelCache.exe !== exe) {
        const { detectAccelerators } = await import('./runtime-setup.cjs')
        accelCache = { exe, result: await detectAccelerators(exe) }
      }
      return {
        ...accelCache.result,
        exe: accelCache.exe,
        usedProvider: taggerStatus().provider || '',
      }
    }),
    // 'app:settings:set': 渲染层写反推偏好(provider 覆盖 / 阈值 / 模型预设), 白名单在 workspace.saveSettings
    'app:settings:set': safe((patch) => {
      const prevModel = String(getSettings().taggerModel || '')
      const next = saveSettings(patch || {})
      // 换了反推模型就立刻换分类词表(角色/系列索引), 不用等下一轮反推把服务拉起来。
      if (patch && patch.taggerModel !== undefined && String(next.taggerModel || '') !== prevModel) {
        try { reloadCats() } catch (e) { flog('tagger', `切换模型后分类重载失败: ${e?.message || e}`) }
      }
      const env = applyTaggerEnv()
      return { settings: next, env }
    }),
    // 'app:checkUpdate': 复用菜单 Help → 检查更新… 的完整流程(主进程弹窗交互);
    //    开发模式没有 updater, 回一句说明而不是报错。
    'app:checkUpdate': safe(async () => {
      if (!onCheckUpdate) return { ok: false, note: '当前是开发模式或绿色包，不支持应用内更新' }
      await onCheckUpdate()
      return { ok: true }
    }),
    'app:version': safe(() => ({ version: app.getVersion(), packaged: app.isPackaged })),
    // 引导弹窗「一键下载」—— 主进程自动补齐 Python 运行时 + WD14 模型,
    // 进度经 tagger:setup-progress 推给右下角 TvSetupProgress 卡片
    'tagger:setup-download': safe(async () => {
      if (!onSetupDownload) return { ok: false, note: '当前环境不支持自动下载' }
      await onSetupDownload()
      return { ok: true }
    }),

    // ---------------- 文件夹登记表(扫描夹 + 看板来源 共用一份) ----------------
    // 真源是 tags.db 的 folders 表; scan_folders.json 降级为导出备份。
    //   usage: 'scan'(默认) 只给扫描页的文件夹库 / 'source' 看板来源 / 'all' 全部登记过的
    // 移出登记表只把用途开关归零, **不删库里的图片记录**(误删可恢复);
    // 真要连记录一起清掉是 folders:purge(高危, 界面必须二次确认)。
    'folders:list': safe((raw) => listFolders(raw || {})),
    'folders:add': safe((raw) => addFolder(raw, pushScanProgress)),
    'folders:remove': safe((raw) => removeFolder(raw)),
    'folders:purge': safe((raw) => purgeFolder(raw)),
    // 改用途开关/改名/改递归。**只有"非来源 -> 来源"这一个跃迁**会附带自动同步:
    // 那是"把目录纳进标签库"的瞬间, 之后必须有人把 ingest 踢一脚(理由见 kickAutoSync)。
    // 其余改动(改名、只动 as_scan、本来就是来源)一律纯打补丁。
    'folders:update': safe((raw = {}) => {
      const r = updateFolder(raw)
      if (r?.error) return r
      if (r.folder?.as_source === true && r.prev?.as_source === false) {
        r.autoSync = kickAutoSync(r.folder, onIngestDone)
      }
      return r
    }),
    'folders:rescan': safe((raw) => rescanFolder(raw, pushScanProgress)),
    'folders:open': safe((raw) => openFolder(raw, pushScanProgress, SCAN_STREAM_OPTS)),
    // 文件夹卡片统计的后台刷新(2026-10-20): 逐夹增量对账 + 重写 stats_json,
    // 每夹完成与全部完成都推 folders:stats, 渲染端重拉列表即可
    'folders:refreshStats': safe(async (raw) => {
      const r = await refreshScanStats((p) => mainWindow()?.webContents.send('folders:stats', p), { only: raw?.only })
      mainWindow()?.webContents.send('folders:stats', { done: true, total: r?.total || 0 })
      return r
    }),
    'folders:prune': safe(() => pruneMissing()),
    'folders:export': safe(() => exportFoldersJson()),
    // 单个来源"立即同步": 只跑登记表里的这一个目录(不传 only 时是全量)
    'folders:sync': safe(async (raw = {}) => {
      const only = raw.id ? Number(raw.id) : (raw.path || raw.name || '')
      const st = await runIngest({
        only,
        onProgress: (p) => mainWindow()?.webContents.send('ingest:progress', p),
      })
      // 同步可能真的改了库(新增/消失), 内存里的数据集已经过期 —— 与
      // 「立即同步」按钮同一条规矩: 跑完必须重载, 否则看板数字停在同步前。
      // onIngestDone 必须无条件调(= startLoad 静默重载): 2026-10-03
      // 实锤, 只在 changed 时调的话, "全 skipped 但队列压着 N 张待反推"的轮次
      // 就没人接反推, 队列永远不消费(另一台机器 633 张卡死就是这个洞)。
      // startLoad 自己有 try/catch, 空库多跑一次只是多一行 warn, 无害。
      onIngestDone?.()
      return st
    }),

    // ---------------- 图片删除(移入系统回收站, 可还原) ----------------
    // 渲染层先弹确认(可关提示), 真正的删除在这里走 shell.trashItem。
    // 成功后把扫描缓存里这些图作废, 免得 5 分钟内重开文件夹又把已删的图列出来。
    'image:trash': safe(async ({ paths } = {}) => {
      const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p)
      if (!list.length) return { error: 'no paths' }
      const trashed = []
      const failed = []
      for (const raw of list) {
        // trashItem 只吃反斜杠(见 toNativePath 注释); 但**回执仍按调用方传来的原文** ——
        // 渲染层靠这些字符串把图从网格/光箱里剔除, 归一化成反斜杠就对不上号了。
        const p = toNativePath(raw)
        try {
          await shell.trashItem(p)
          trashed.push(raw)
        } catch (e) {
          /**
           * ⚠️ 「已进回收站却报错」的兜底 —— 2026-09-19 实测(隔离探针, 沙箱内外一致):
           *   · 非系统盘(D: / E: / F:)上, shell.trashItem 会在文件**已经移进回收站之后**
           *     才抛 "Operation was aborted"; 同一个文件在 C: 盘不抛。
           *   · 4/4 个探针文件都好好躺在对应盘的 $Recycle.Bin 里(解析 $I* 记的原路径
           *     并核对 $R* 内容, 内容完好) —— 也就是**错误回执, 但删除是成功的**。
           *
           * 把这个误报当成失败会连环出事: 渲染端弹「N 张删除失败(文件可能被占用)」,
           * 而且因为 trashed 为空, **不会广播 tv:trashed** -> 大图预览停在一张已经删掉的
           * 图上(空白占位), 网格里也留着一张坏缩略图。用户的图库几乎都在 D/E/F 盘,
           * 所以这个坑是必踩的。
           *
           * 判据只能落回磁盘: 原位置已经不存在 = 删除本来就成了, 别让回执说了算。
           * 只有原文件还在, 才算真失败(比如被别的进程占用)。
           */
          if (!fs.existsSync(p)) {
            trashed.push(raw)
            flog('trash-warn', `trashItem 报错但文件已不在原位(按成功处理): ${p} — ${e?.message || e}`)
          } else {
            failed.push(raw)
            flog('trash-err', `trashItem 真失败(文件仍在): ${p} — ${e?.message || e}`)
          }
        }
      }
      if (trashed.length) {
        purgeScanCachePaths(trashed)
        // 库记录同步标 gone=1(2026-10-17): 以前只删文件+作废扫描缓存, tags.db 里的行
        // 还停在 gone=0 —— 直接读库的功能(查重/统计)会把已删的图"复活"(重扫又冒出来)。
        // ingest 规则 6 是「库有 gone=1 + 磁盘又出现 → 清 gone」, 所以这里标了也不影响还原。
        // 路径按 原文/正斜杠/反斜杠 三种形态兜底匹配, 库里存的分隔符不赌。
        try {
          const db = openDb()
          const goneStmt = db.prepare('UPDATE images SET gone = 1 WHERE path = ?')
          let nGone = 0
          for (const p of trashed) {
            for (const v of new Set([p, p.replaceAll('\\', '/'), p.replaceAll('/', '\\')])) {
              nGone += goneStmt.run(v).changes
            }
          }
          if (nGone) flog('trash-info', `已把 ${nGone} 条库记录标 gone=1`)
        } catch (e) {
          flog('trash-err', '标记 gone 失败(文件已删, 库记录还在): ' + (e?.message || e))
        }
      }
      return { ok: trashed.length > 0, trashed, failed }
    }),

    // ---------------- 批量移动(扫描页选择模式) ----------------
    /* 循环复用 moveFile: 同盘 rename / 跨盘 copy+删 / **同名自动改名**(uniqueDestination,
       与单张右键移动同一条硬规则 —— 绝不静默覆盖)。逐张容错: 一张失败不拖累整批。
       收尾 purgeScanCachePaths 作废扫描缓存(否则 5 分钟内重开文件夹还会列出已搬走的图)。
       库外图(库里没记录)落到登记来源时, 兜底补一次增量同步 —— kickAutoSync 自己看
       folder.auto_tag 与 TV_INGEST 总闸, 测试/dev 里不会偷跑(2026-09-23 拍板)。 */
    'image:moveMany': safe(async ({ paths, target } = {}) => {
      const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p)
      if (!list.length || !target) return { error: '参数不完整' }
      const moved = []
      const failed = []
      for (const raw of list) {
        // 磁盘操作走反斜杠(toNativePath, 同 image:trash 的规矩);
        // **回执的 from 用调用方原文** —— 渲染层靠这些字符串从网格/光箱里剔除, 改写就对不上号。
        const p = toNativePath(raw)
        const r = await moveFile(p, target)
        if (r.ok) moved.push({ from: raw, to: r.dest, name: r.name })
        else failed.push({ path: raw, error: r.error })
      }
      if (moved.length) purgeScanCachePaths(moved.map((m) => m.from))
      let sync = null
      if (moved.length) {
        const folder = findFolderByDir(target)
        if (folder) {
          /* 「移动 = 改址」(2026-10-04): 库里已有记录的图, 记录原地改 path/folder_id
           * + 移动后 stat 到的新指纹 —— 标签跟图走, ingest 规则 1 直接跳过, 不产生
           * 新图、不重新入队反推, 也不触发整库数据集重建。
           *
           * 库里**没有**的图(扫描页的库外图 —— as_scan 目录本来就不入库)2026-10-04
           * 用户拍板: **什么都不干**。「移动了就移动了, 等重新打开的时候扫描再说」。
           * 旧兜底(对目标目录补 kickAutoSync)实测每移一张就: ingest 入新图+入队反推
           * → onIngestDone → 整库数据集重建 5 秒(launch.log 17:22:57~17:25:17 五连,
           * 85k 记录重建 4.9~5.5s/次) —— 这就是"移动一张图卡一会、tag 面板转圈"的
           * 全部来源。重启后的全量增量同步自然会把它入库, 那是正常的新图流程。 */
          const missed = []
          for (const m of moved) {
            let fp = null
            try {
              const st = fs.statSync(m.to)
              fp = { mtimeMs: st.mtimeMs, size: st.size }   // 原始浮点, 口径同 ingest
            } catch { /* stat 不到就保留原指纹, 让 ingest 规则 1 按旧值判 */ }
            const r = relocateRecord(m.from, m.to, folder.id, fp)
            if (!r.hit) missed.push(m)
          }
          // 库外图不再兜底入库 —— 零 ingest、零重建、零卡顿
          sync = {
            wanted: true,
            started: false,
            reason: missed.length ? 'relocated-partial-outside' : 'relocated',
            relocated: moved.length - missed.length,
            outside: missed.length,
          }
        }
      }
      return { ok: moved.length > 0, moved, failed, dest: target, destName: path.basename(target), sync }
    }),

    // ---------------- 批量复制(扫描页选择模式, 2026-10-16) ----------------
    /* 复制 = 原文件不动: 不 purgeScanCachePaths、不 relocateRecord、不补同步 ——
     * 副本不在库里, 等目标目录下次扫描/同步自然入库。逐张容错同 moveMany。 */
    'image:copyMany': safe(async ({ paths, target } = {}) => {
      const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p)
      if (!list.length || !target) return { error: '参数不完整' }
      const copied = []
      const failed = []
      for (const raw of list) {
        const p = toNativePath(raw)
        const r = await copyFile(p, target)
        if (r.ok) copied.push({ from: raw, to: r.dest, name: r.name })
        else failed.push({ path: raw, error: r.error })
      }
      return { ok: copied.length > 0, moved: copied, failed, dest: target, destName: path.basename(target) }
    }),

    // ---------------- 移动目标选择器的数据源(快速预设) ----------------
    /* 右键菜单的预设文件夹在主进程 settings.json 里, 渲染层的移动弹窗也要用同一份。
       addQuickFolderAndReturn 是右键菜单那条路的收尾函数, 直接复用(按路径去重, 上限 50)。 */
    'app:quickFolders': safe(() => ({
      quickFolders: Array.isArray(getSettings().quickFolders) ? getSettings().quickFolders : [],
    })),
    'app:quickFolders:add': safe(({ path: dir } = {}) => {
      if (!dir) return { error: 'no path' }
      const r = addQuickFolderAndReturn(dir)
      return r.result || { ok: false, error: '未知错误' }
    }),
    /* 光箱「快速移动」按钮条的管理弹窗(2026-09-29): 整表保存(改名/排序/删除/新增)。
       逐条清洗: 路径 resolve / 按路径去重(大小写不敏感, 与 add 同规矩) /
       名字兜底 basename / 上限 50(与 add 一致)。resolve 不了的条目直接丢。 */
    'app:quickFolders:set': safe(({ folders } = {}) => {
      const seen = new Set()
      const out = []
      for (const f of (Array.isArray(folders) ? folders : [])) {
        if (!f || typeof f.path !== 'string' || !f.path) continue
        try {
          const clean = path.resolve(f.path)
          const key = clean.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ name: String(f.name || '').trim() || path.basename(clean) || clean, path: clean })
        } catch { /* 非法路径条目丢弃 */ }
        if (out.length >= 50) break
      }
      saveSettings({ quickFolders: out })
      return { ok: true, quickFolders: out }
    }),

    // ---------------- 剪贴板 ----------------
    'clipboard:write': safe(({ text }) => {
      clipboard.writeText(String(text ?? ''))
      return { ok: true }
    }),

    // ---------------- 收藏找回 ----------------
    // 渲染层把收藏记录发来, 主进程逐条 existsSync; 失效的按文件名在已知目录
    // (扫描文件夹/预设文件夹/数据目录/原父目录)里搜, 命中即改写。
    // 见 core/favResolve.js —— 收藏页打开时调用, 尽力而为、限深限时。
    'fav:resolve': safe(({ items }) => resolveFavorites(Array.isArray(items) ? items : [])),

    // ---------------- 像素尺寸(网格按真实比例排版的前提) ----------------
    /* 收藏页的网格和扫描页一样是**库外图**: 收藏记录是 `{path,name,tags,at}` 的
       快照, 里面没有尺寸 -> 卡片回落 9/16 -> 横图被裁成竖条(与扫描页同一个 bug)。
       这里按路径批量补, 先查内存数据集(收藏里绝大多数图都登记过, 零 I/O),
       再批量读文件头(worker, 见 core/dims.js)。返回与入参**同序**。 */
    'dims:forPaths': safe(async ({ paths } = {}) => ({
      dims: await dimsForPaths(Array.isArray(paths) ? paths : []),
    })),

    // ---------------- 维护 / 诊断 ----------------
    'diag:stats': safe(() => ({
      dataset: ds.stats,
      tagPool: tagPoolSize(),
      charLib: charLibDiag(),
      search: searchStats(),
      thumbs: thumbStats(),
      thumbCache: thumbCacheSize(),
      translate: translateInfo(),
      scanCache: scanCacheStats(),
      ingest: ingestStatus(),
      tagQueue: queueStats(),
      tagger: taggerStatus(),
      memory: process.memoryUsage(),
      memoryMB: {
        rss: +(process.memoryUsage().rss / 1048576).toFixed(1),
        heapUsed: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
        external: +(process.memoryUsage().external / 1048576).toFixed(1),
      },
      uptimeSec: Math.round(process.uptime()),
    })),
    'diag:clearSearchCache': safe(() => { clearSearchCache(); return { ok: true } }),
    'diag:clearThumbs': safe(() => clearThumbs()),
    'diag:fileInfo': safe(({ name }) => {
      const p = dataFile(name)
      try {
        const st = fs.statSync(p)
        return { path: p, exists: true, size: st.size, mtime: st.mtimeMs }
      } catch {
        return { path: p, exists: false }
      }
    }),
  }

  for (const [ch, fn] of Object.entries(map)) {
    ipcMain.handle(ch, DATA_CHANNELS.has(ch) ? gated(fn) : fn)
  }
  log(`${Object.keys(map).length} 个 channel 已注册`)
}

/** 主进程主动推送的事件名(渲染进程用 tv.on 订阅) */
export const PUSH_EVENTS = ['app:progress', 'app:reloaded', 'ingest:progress', 'tagger:progress', 'export:auto', 'cart:auto', 'app:toast']
