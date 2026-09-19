/**
 * 应用启动编排: 读配置 -> 加载数据集 -> 载入翻译库
 * ================================================
 * 加载 88MB 标签文件 + 建系列索引是唯一一个「用户要等」的阶段, 所以拆出来单独管理,
 * 并且把进度通过回调抛给渲染进程显示。
 */
import fs from 'node:fs'
import { loadConfig, resolveDataFiles } from './config.js'
import { loadDataset, ds } from './dataset.js'
import { loadTranslations, translateInfo } from './translate.js'
import { invalidateRuleCaches } from './rules.js'
import { clearSearchCache } from './search.js'
import { invalidateSourceCounts } from './query.js'
import { getWorkspace } from './workspace.js'

export const appState = {
  phase: 'idle',        // idle | loading | ready | error
  config: {},
  dataFiles: new Map(),
  stats: null,
  translate: null,
  error: '',
  progress: { phase: '', done: 0, total: 1, percent: 0, records: 0, source: '' },
  lastLoadMs: 0,
}

function reportProgress(p, onProgress) {
  const percent = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
  appState.progress = { ...p, percent }
  onProgress?.(appState.progress)
}

/**
 * 等数据集就绪的 promise 工厂
 * ===========================
 * 为什么需要它(踩过一次, 表现很隐蔽):
 *   窗口是在数据集加载**之前**就渲染出来的(否则会有十几秒白屏), 于是渲染进程挂载
 *   HomeView 时会立刻发 stats:get / search:do —— 那时候 ds.records 只填了一半。
 *   返回的快照自然是错的(总数少一大截、来源计数几乎全 0), 而渲染进程只会把它
 *   存进 store, 之后再也不会自己刷新, 于是界面上永远显示一个偏小的数字,
 *   直到用户手动点一次「搜索」才恢复。
 *   所以: 数据类 channel 一律先等 ready, 再算结果。
 */
let readyWaiters = []

export function whenReady() {
  if (appState.phase === 'ready') return Promise.resolve()
  if (appState.phase === 'error') {
    return Promise.reject(new Error(appState.error || '数据集加载失败'))
  }
  return new Promise((resolve, reject) => {
    readyWaiters.push({ resolve, reject })
  })
}

function settleWaiters(err) {
  const ws = readyWaiters
  readyWaiters = []
  for (const w of ws) (err ? w.reject(err) : w.resolve())
}

/**
 * 全量加载。重复调用会先清空所有派生缓存, 保证一致性。
 * @param {{onProgress?: Function}} opts
 */
export async function bootstrap({ onProgress } = {}) {
  appState.phase = 'loading'
  appState.error = ''
  const t0 = Date.now()
  try {
    invalidateRuleCaches()
    clearSearchCache()
    invalidateSourceCounts()

    const cfg = loadConfig()
    appState.config = cfg
    const dataFiles = resolveDataFiles(cfg, null)
    appState.dataFiles = dataFiles

    await loadDataset(dataFiles, (p) => reportProgress(p, onProgress))

    const translateDir = cfg.translate_dir || ''
    const tInfo = loadTranslations(translateDir)
    appState.translate = translateInfo()

    appState.stats = ds.stats
    appState.lastLoadMs = Date.now() - t0
    // 再清一次: 派生缓存的 key 里没有"数据版本"这一维, 万一加载途中被谁读过一次
    // (比如某个将来新增的调用方没走 whenReady), 缓存里就会留下半份数据的快照。
    // 这里在数据定型后统一作废, 下次访问自然会按新数据重算。
    invalidateSourceCounts()
    clearSearchCache()
    appState.phase = 'ready'
    reportProgress({ phase: 'done', done: 1, total: 1, records: ds.records.length })
    settleWaiters(null)
    return status()
  } catch (e) {
    appState.phase = 'error'
    appState.error = e?.message || String(e)
    settleWaiters(new Error(appState.error))
    return status()
  }
}

export function status() {
  return {
    phase: appState.phase,
    error: appState.error,
    progress: appState.progress,
    stats: appState.stats,
    translate: appState.translate,
    loadMs: appState.lastLoadMs,
    workspace: getWorkspace(),
    config: {
      data_files_dir: appState.config.data_files_dir || '',
      data_file: appState.config.data_file || '',
      translate_dir: appState.config.translate_dir || '',
      port: appState.config.port ?? 8080,
    },
    sources: [...appState.dataFiles.entries()].map(([name, fp]) => {
      let size = 0
      try { size = fs.statSync(fp).size } catch { /* 忽略 */ }
      return { name, file: fp, size }
    }),
  }
}
