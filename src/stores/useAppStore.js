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

    applyStatus(await api.status())
    // 主进程是页面 did-finish-load 之后才开始加载数据, 有可能这里已经 ready 了
    if (phase.value === 'idle') phase.value = 'loading'

    // 同步可能在页面渲染之前就已经开跑(它只等数据集就绪, 不等界面), 所以补拉一次
    try { ingest.value = await api.ingestStatus() } catch { /* 主进程还没注册, 忽略 */ }

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

  return {
    phase, error, progress, stats, translate, workspace, config, sourcesInfo, loadMs, epoch,
    theme, ready, loading, totalImages, ingest,
    init, reload, applyStatus, toggleTheme, applyTheme,
  }
})
