/**
 * 应用级状态: 数据集加载进度 / 状态 / 主题
 * 对应原版的「页面一打开就 fetch /api/stats」那一层, 但把加载过程显式化了 ——
 * 原版是浏览器里看不到任何进度, 干等十来秒。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, onPush } from '@/utils/api.js'

const THEME_KEY = 'tv_theme'

export const useAppStore = defineStore('app', () => {
  const phase = ref('idle')          // idle | loading | ready | error
  const error = ref('')
  const progress = ref({ percent: 0, phase: '', records: 0, source: '' })
  const stats = ref(null)
  const translate = ref(null)
  const workspace = ref({ dataDir: '', configPath: '' })
  const config = ref({})
  const sourcesInfo = ref([])
  const loadMs = ref(0)
  const started = ref(false)
  /**
   * 增量同步(磁盘 <-> tags.db)的运行状态。
   * 由主进程在 app 就绪后延迟自启一次(见 electron/main.js 的 scheduleIngest),
   * 也可以点界面上的按钮手动跑。phase: idle | running | enum | compare | read |
   * folder-done | rebuild-tags | done | error | skipped
   */
  const ingest = ref(null)
  /**
   * WD14 反推(消费 tag_queue)的运行状态。由主进程在同步结束后按队列非空自动起一次,
   * 也可手动跑。phase: idle | probe | infer | rebuild-tags | done | error
   * 缺 python/模型时是 `degraded` 而不是 error —— 队列留着, 看板照用。
   */
  const tagger = ref(null)
  /**
   * 数据集版本号 —— 每次"从 loading 变成 ready"就 +1。
   * 视图用它来决定"要不要重跑一次初始查询":
   *   窗口先渲染、数据后到, 视图挂载时发的第一次查询可能发生在数据就绪之前
   *   (主进程侧虽然已经会先等 ready, 但"重新加载数据"另算一次), 有了这个号,
   *   视图就能在数据真正换了一茬之后自动刷新, 不用用户手动点搜索。
   */
  const epoch = ref(0)

  // 主题: 默认深色(与旧版一致, 也利于看图), 可切浅色
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : ''
  const theme = ref(stored === 'light' ? 'light' : 'dark')

  function applyTheme() {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = theme.value
  }
  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, theme.value)
    applyTheme()
  }
  applyTheme()

  const ready = computed(() => phase.value === 'ready')
  const loading = computed(() => phase.value === 'loading')
  const totalImages = computed(() => stats.value?.records ?? 0)

  /** 首次进入时调一次: 拉状态 + 订阅进度推送 */
  async function init() {
    if (started.value) return
    started.value = true

    onPush('app:progress', (p) => {
      progress.value = p
      if (p.phase && p.phase !== 'done') phase.value = 'loading'
    })
    onPush('app:reloaded', (st) => {
      applyStatus(st)
    })
    onPush('ingest:progress', (p) => { ingest.value = p })
    onPush('tagger:progress', (p) => { tagger.value = p })

    applyStatus(await api.status())
    // 主进程是页面 did-finish-load 之后才开始加载数据, 有可能这里已经 ready 了
    if (phase.value === 'idle') phase.value = 'loading'

    // 同步可能在页面渲染之前就已经开跑(它只等数据集就绪, 不等界面), 所以补拉一次
    try { ingest.value = await api.ingestStatus() } catch { /* 主进程还没注册, 忽略 */ }
    try { tagger.value = await api.taggerStatus() } catch { /* 同上 */ }

    // 兜底轮询: 万一某个推送丢了, 也别让界面永远停在"加载中"
    const timer = setInterval(async () => {
      if (phase.value === 'ready' || phase.value === 'error') { clearInterval(timer); return }
      try { applyStatus(await api.status()) } catch { /* 忽略 */ }
    }, 900)
  }

  function applyStatus(st) {
    if (!st) return
    if (st.progress) progress.value = st.progress
    const wasReady = phase.value === 'ready'
    phase.value = st.phase || phase.value
    if (!wasReady && phase.value === 'ready') epoch.value++
    error.value = st.error || ''
    if (st.stats) stats.value = st.stats
    if (st.translate) translate.value = st.translate
    if (st.workspace) workspace.value = st.workspace
    if (st.config) config.value = st.config
    if (st.sources) sourcesInfo.value = st.sources
    if (st.loadMs) loadMs.value = st.loadMs
  }

  async function reload() {
    phase.value = 'loading'
    progress.value = { percent: 0, phase: 'parse', records: 0, source: '' }
    applyStatus(await api.reload())
  }

  /**
   * 手动触发后台任务。
   *
   * ⚠️ 这几个 action 之前**不存在**(2026-09-20 修): 徽标里的「再同步一次」
   * 写的是 `app.ingestRun()`, 而 store 从来没导出过这个名字 —— pinia 上取到
   * undefined, 调用直接抛 TypeError, 又被徽标那圈 `try{}catch{}` 吞掉。
   * 表现是"点了没反应, 也不报错", 极难发现。所以这里补上真实实现,
   * 让调用点写的就是它实际调的东西。
   */
  const RUNNING_PHASES = new Set([
    'running', 'enum', 'compare', 'read', 'folder-done', 'rebuild-tags', 'probe', 'infer',
  ])

  async function ingestRun() {
    if (ingest.value && RUNNING_PHASES.has(ingest.value.phase)) return { ok: false, error: '已在同步' }
    // 立刻置成进行中, 让徽标在第一个推送到达之前就显示出来(否则有 1-2 秒空档)
    ingest.value = { ...(ingest.value || {}), phase: 'running', note: '正在启动同步 ...', done: 0, total: 0 }
    return api.ingestRun()
  }

  async function ingestPause() { return api.ingestPause() }

  async function taggerRun(opts) {
    if (tagger.value && RUNNING_PHASES.has(tagger.value.phase)) return { ok: false, error: '已在反推' }
    tagger.value = { ...(tagger.value || {}), phase: 'probe', note: '正在启动反推 ...', done: 0, total: 0 }
    return api.taggerRun(opts)
  }

  async function taggerPause() { return api.taggerPause() }

  async function taggerRefresh() {
    try { tagger.value = await api.taggerStatus() } catch { /* 忽略 */ }
    return tagger.value
  }

  return {
    phase, error, progress, stats, translate, workspace, config, sourcesInfo, loadMs, epoch,
    theme, ready, loading, totalImages, ingest, tagger,
    init, reload, applyStatus, toggleTheme, applyTheme,
    ingestRun, ingestPause, taggerRun, taggerPause, taggerRefresh,
  }
})
