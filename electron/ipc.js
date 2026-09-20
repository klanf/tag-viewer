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
import { ipcMain, dialog, clipboard, shell, BrowserWindow, Menu, nativeImage } from 'electron'
import { getWorkspace, getSettings, saveSettings, dataFile } from './core/workspace.js'
import { bootstrap, status, whenReady } from './core/app-state.js'
import {
  getStats, doSearch, getSeries, getCharacters, getSeriesMeta, postSeriesMeta,
  getSuggest, getAllTags, getTagsForPath, getLightboxData, getTranslations,
} from './core/query.js'
import {
  blacklistText, blacklistRules, saveBlacklistText, toggleBlacklistTag,
  replaceText, saveReplaceText, loadReplaceRules, loadBgConfig, invalidateRuleCaches,
} from './core/rules.js'
import {
  historySummary, historyDetail, saveHistory, deleteHistory, renameHistory,
} from './core/cart.js'
import { buildExport, buildCartExport } from './core/exporter.js'
import { scanFolder, scanCacheStats, purgeScanCachePaths } from './core/scan.js'
import { runIngest, ingestStatus, pauseIngest, ingestState, queueStats } from './core/ingest.js'
import {
  runTagger, taggerStatus, pauseTagger, taggerConfig, taggerState,
} from './core/tagger.js'
import {
  listFolders, addFolder, removeFolder, updateFolder, rescanFolder, openFolder, pruneMissing,
  purgeFolder, exportFoldersJson,
} from './core/folders.js'
import { thumbStats, clearThumbs, thumbCacheSize } from './core/thumbs.js'
import { searchStats, clearSearchCache } from './core/search.js'
import { moveFile } from './core/fileTransfer.js'
import { ds, tagPoolSize } from './core/dataset.js'
import { charLibDiag } from './core/charlib.js'
import { translateInfo } from './core/translate.js'
import { resolveFavorites } from './core/favResolve.js'
import { flog } from './core/filelog.js'

const log = (...a) => console.log('[ipc]', ...a)

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
  'suggest:get', 'tags:all', 'tags:forPath', 'lightbox:data', 'translate:get',
  'export:preview', 'export:save', 'export:text', 'export:cart',
  'scan:folder',
  'folders:open', 'folders:add', 'folders:rescan',
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

/** 扫描元数据解析进度 -> 渲染端进度条(ScanView 订阅) */
function pushScanProgress(p) {
  mainWindow()?.webContents.send('scan:progress', p)
}

/** 后台增量同步进度 -> 渲染端顶栏 */
function pushIngestProgress(p) {
  mainWindow()?.webContents.send('ingest:progress', p)
}

/** WD14 反推进度 -> 渲染端(与同步共用右下角那根胶囊) */
function pushTaggerProgress(p) {
  mainWindow()?.webContents.send('tagger:progress', p)
}

export function registerIpc({ onReload, onIngestDone, onTaggerDone } = {}) {
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
      const { path: imgPath, name, tags, favable, favorited } = payload || {}
      if (!imgPath || typeof imgPath !== 'string') return { action: null }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { action: null }

      let chosen = null
      const copyText = (t) => { try { clipboard.writeText(String(t ?? '')) } catch { /* 忽略 */ } }
      const item = (label, id) => ({
        label,
        click: () => {
          chosen = { action: id }
          if (id === 'copy-image') {
            try { clipboard.writeImage(nativeImage.createFromPath(imgPath)) } catch { /* 图片读不到就算了 */ }
          } else if (id === 'open') { shell.openPath(imgPath) }
          else if (id === 'reveal') { shell.showItemInFolder(imgPath) }
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

      const template = [
        item('🖼️ 复制图片到剪贴板', 'copy-image'),
        item('🖥️ 用系统查看器打开', 'open'),
        item('📁 打开图片所在位置', 'reveal'),
        { label: '📤 移动到', submenu: moveSub },
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

      // ---- 菜单关闭后的收尾动作(搬移/弹目录选择框), 结果返回给渲染层弹提示 ----
      const act = chosen?.action
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

    // ---------------- 标签 ----------------
    'suggest:get': safe((raw) => getSuggest(raw)),
    'tags:all': safe((raw) => getAllTags(raw)),
    'tags:forPath': safe((raw) => getTagsForPath(raw)),
    'lightbox:data': safe((raw) => getLightboxData(raw)),
    'translate:get': safe((raw) => getTranslations(raw)),

    // ---------------- 规则(黑名单 / 替换 / 背景) ----------------
    'blacklist:get': safe(() => ({ rules: blacklistRules(), text: blacklistText() })),
    'blacklist:save': safe(({ text }) => saveBlacklistText(text)),
    'blacklist:toggle': safe(({ tag }) => toggleBlacklistTag(tag)),
    'replace:get': safe(() => ({ rules: loadReplaceRules(), text: replaceText() })),
    'replace:save': safe(({ text }) => saveReplaceText(text)),
    'bg:get': safe(() => loadBgConfig()),
    'rules:reload': safe(() => { invalidateRuleCaches(); return { ok: true } }),

    // ---------------- 购物车历史 ----------------
    'cart:history': safe(() => historySummary()),
    'cart:detail': safe(({ name }) => historyDetail(name)),
    'cart:save': safe(({ name, cart }) => saveHistory(name, cart)),
    'cart:delete': safe(({ name }) => deleteHistory(name)),
    'cart:rename': safe(({ old_name, new_name }) => renameHistory(old_name, new_name)),

    // ---------------- 导出 ----------------
    // 先算好, 再弹「另存为」; 用户取消时不会白算一遍
    'export:preview': safe((raw) => {
      const r = buildExport(raw)
      return { count: r.count, blocked: r.blocked, replaced: r.replaced, bgAdded: r.bgAdded, stripped: r.stripped || 0, ms: r.ms, suggestedName: r.suggestedName }
    }),
    'export:save': safe(async (raw) => {
      const r = buildExport(raw)
      const dlg = await dialog.showSaveDialog(mainWindow(), {
        title: '导出筛选结果',
        defaultPath: path.join(path.dirname(getWorkspace().dataDir), r.suggestedName),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      })
      if (dlg.canceled || !dlg.filePath) return { canceled: true, count: r.count }
      await fs.promises.writeFile(dlg.filePath, r.text, 'utf8')
      return { ok: true, path: dlg.filePath, count: r.count, bytes: Buffer.byteLength(r.text, 'utf8') }
    }),
    'export:text': safe((raw) => buildExport(raw)),
    'export:cart': safe(async ({ tags, spaces = true, save = true } = {}) => {
      const r = buildCartExport(tags || [], { spaces })
      if (!save) return r
      const dlg = await dialog.showSaveDialog(mainWindow(), {
        title: '导出购物车角色(wildcard)',
        defaultPath: path.join(path.dirname(getWorkspace().dataDir), r.suggestedName),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      })
      if (dlg.canceled || !dlg.filePath) return { canceled: true, count: r.count }
      await fs.promises.writeFile(dlg.filePath, r.text, 'utf8')
      return { ok: true, path: dlg.filePath, count: r.count }
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
          if (r && !r.skipped && !r.error) onIngestDone?.(r)
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
      runTagger({ onProgress: pushTaggerProgress, limit })
        .then((r) => {
          if (r && !r.skipped) onTaggerDone?.(r)
        })
        .catch((e) => flog('tagger-err', `${e?.stack || e}`))
      return { ok: true, started: true }
    }),
    'tagger:pause': safe(() => pauseTagger()),

    // ---------------- 文件夹登记表(扫描夹 + 看板来源 共用一份) ----------------
    // 真源是 tags.db 的 folders 表; scan_folders.json 降级为导出备份。
    //   usage: 'scan'(默认) 只给扫描页的文件夹库 / 'source' 看板来源 / 'all' 全部登记过的
    // 移出登记表只把用途开关归零, **不删库里的图片记录**(误删可恢复);
    // 真要连记录一起清掉是 folders:purge(高危, 界面必须二次确认)。
    'folders:list': safe((raw) => listFolders(raw || {})),
    'folders:add': safe((raw) => addFolder(raw, pushScanProgress)),
    'folders:remove': safe((raw) => removeFolder(raw)),
    'folders:purge': safe((raw) => purgeFolder(raw)),
    'folders:update': safe((raw) => updateFolder(raw)),
    'folders:rescan': safe((raw) => rescanFolder(raw, pushScanProgress)),
    'folders:open': safe((raw) => openFolder(raw, pushScanProgress)),
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
      const changed = st && !st.skipped && !st.error
        && (st.inserted || st.metaUpdated || st.goneSet || st.goneCleared)
      if (changed) onIngestDone?.()
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
      for (const p of list) {
        try {
          await shell.trashItem(p)
          trashed.push(p)
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
            trashed.push(p)
            flog('trash-warn', `trashItem 报错但文件已不在原位(按成功处理): ${p} — ${e?.message || e}`)
          } else {
            failed.push(p)
            flog('trash-err', `trashItem 真失败(文件仍在): ${p} — ${e?.message || e}`)
          }
        }
      }
      if (trashed.length) purgeScanCachePaths(trashed)
      return { ok: trashed.length > 0, trashed, failed }
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
export const PUSH_EVENTS = ['app:progress', 'app:reloaded', 'ingest:progress', 'tagger:progress']
