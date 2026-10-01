/**
 * 应用级状态: 数据集加载进度 / 状态 / 主题
 * 对应原版的「页面一打开就 fetch /api/stats」那一层, 但把加载过程显式化了 ——
 * 原版是浏览器里看不到任何进度, 干等十来秒。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, onPush } from '@/utils/api.js'
import { LS, readLS, writeLS } from '@/utils/lskey.js'
import { useUiStore } from './useUiStore.js'
import { nfmt, dur } from '@/utils/format.js'

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
  /**
   * 「待导出」状态 —— 黑名单变更后的自动导出不再是立刻导, 而是排到一个延迟之后
   * (全局可配, 默认 3 分钟)。这中间界面必须看得见"还差多久", 否则用户会以为功能
   * 坏了(2026-09-24 加: 延迟从 1.5 秒变成几分钟, 静默等待的观感完全不同)。
   *
   * 主进程只在**排程那一刻**推一次(export:auto, kind='scheduled'), 倒计时在这里
   * 本地走 —— 不靠每秒推送: 3 分钟就是 180 次唤醒, 纯浪费。
   */
  const autoExport = ref({ pending: false, dueAt: 0, remainingMs: 0, autoCount: 0, delayMs: 0 })
  let autoTick = null

  function stopAutoTick() {
    if (autoTick) { clearInterval(autoTick); autoTick = null }
  }
  function startAutoTick() {
    if (autoTick) return
    autoTick = setInterval(() => {
      const left = Math.max(0, autoExport.value.dueAt - Date.now())
      autoExport.value = { ...autoExport.value, remainingMs: left }
      if (!left) stopAutoTick()      // 到点后主进程会推 result, 空转没必要
    }, 1000)
  }
  /** 主进程说"排上了" -> 记到期时间并开始倒计时 */
  function applyAutoSchedule(p) {
    autoExport.value = {
      pending: true,
      dueAt: Number(p?.dueAt) || 0,
      remainingMs: Math.max(0, (Number(p?.dueAt) || 0) - Date.now()),
      autoCount: Number(p?.autoCount) || autoExport.value.autoCount || 0,
      delayMs: Number(p?.delayMs) || autoExport.value.delayMs || 0,
    }
    startAutoTick()
    // 一批改动只在**第一次**排程时提示一次 —— 连 ban 十几个不该刷十几条 toast
    if (p?.fresh) {
      useUiStore().toast(`🚫 已排程自动导出（${dur(p?.delayMs)} 后 · 点侧栏角标可立刻导）`, 'info', 2800)
    }
  }
  /** 这一轮导完了(或不该等了) -> 撤掉待导出标记 */
  function clearAutoPending() {
    stopAutoTick()
    autoExport.value = { ...autoExport.value, pending: false, dueAt: 0, remainingMs: 0 }
  }
  /**
   * 主动拉一次排程状态。
   * 为什么需要: 排程推送可能发生在**页面加载之前**(主进程的定时器不等窗口), 光靠
   * onPush 会漏; 窗口关掉重开也是同一回事。
   */
  async function pullAutoState() {
    try {
      const s = await api.exportPresetState()
      if (s?.pending) applyAutoSchedule(s)
      else {
        clearAutoPending()
        autoExport.value = { ...autoExport.value, autoCount: s?.autoCount || 0, delayMs: s?.delayMs || 0 }
      }
      return s
    } catch { return null }   // 主进程还没注册/浏览器降级: 不打扰用户
  }
  /** 点侧栏角标: 跳过等待立刻导(没有排程时主进程会直接返回, 不会白跑一次) */
  async function flushAutoNow() {
    try {
      const r = await api.exportPresetFlushNow()
      if (r?.skipped) clearAutoPending()
      return r
    } catch (e) {
      useUiStore().err('立刻导出失败: ' + e.message)
      return null
    }
  }

  // 主题: 默认深色(与旧版一致, 也利于看图), 可切浅色
  const stored = typeof localStorage !== 'undefined' ? readLS(LS.theme.key) : ''
  const theme = ref(stored === 'light' ? 'light' : 'dark')

  function applyTheme() {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = theme.value
  }
  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    writeLS(LS.theme.key, theme.value)
    applyTheme()
  }
  applyTheme()

  const ready = computed(() => phase.value === 'ready')
  const loading = computed(() => phase.value === 'loading')
  const totalImages = computed(() => stats.value?.records ?? 0)

  /**
   * 黑名单变更 -> 自动导出的回执(主进程推 export:auto)。
   * 两种 kind(2026-09-24 起):
   *   · 'scheduled' —— 排上了, 还没导(延迟期间)。只更新倒计时, 不弹结果 toast。
   *   · 默认(结果)  —— 这一轮跑完了。说人话报一下: 成功就报导了几个预设、各多少行;
   *                    **失败必须明确报出来** —— 自动行为静默失败比没有更糟。
   */
  function notifyAutoExport(payload) {
    const ui = useUiStore()
    if (payload?.kind === 'scheduled') { applyAutoSchedule(payload); return }
    clearAutoPending()
    const results = payload?.results || []
    if (!results.length) {
      // 数据集还没就绪时主进程会推一条空结果 —— 得说清"这次还没导",
      // 但不能说成"这次不导了": 主进程已经挂上就绪后的补跑(exportPresets.armReadyRetry)
      if (payload?.reason === 'not-ready') {
        ui.warn('黑名单已更新, 数据还在加载 —— 加载完会立刻自动导出', 3600)
      }
      return
    }
    const oks = results.filter((r) => r.ok)
    const bads = results.filter((r) => !r.ok)
    if (bads.length && !oks.length) {
      ui.err(`自动导出失败: ${bads[0].name} · ${bads[0].error}`, 4200)
      return
    }
    const okMsg = oks.map((r) => `${r.name} ${nfmt(r.count)} 行`).join(' · ')
    if (bads.length) {
      ui.warn(`自动导出: ${okMsg}; 另有 ${bads.length} 个失败(${bads[0].name}: ${bads[0].error})`, 4600)
    } else {
      ui.ok(`✅ 黑名单已更新, 已自动导出: ${okMsg}`, 3400)
    }
  }

  /**
   * 购物车 -> 自动导出的回执(主进程推 cart:auto)。
   * 与上面那条黑名单的**刻意不一样**, 因为两者心态不同:
   *   · 黑名单是"我改完就该落地", 排上要给角标倒计时(用户会盯着);
   *   · 购物车是"顺手攒着的" —— 只在**排上那一刻**轻描淡写提一句(还是靠 fresh 去重,
   *     连续加十个角色只提示一次), 导完再报一行。购物车抽屉里的绿点/橙点负责显示
   *     当前是"已同步"还是"有更新待导", 不需要侧栏再挂一个角标。
   */
  function notifyCartAuto(payload) {
    const ui = useUiStore()
    if (payload?.kind === 'scheduled') {
      if (payload.fresh) {
        ui.toast(`🛒 购物车已更新 —— ${dur(payload.delayMs)}后自动导出（可在购物车里点「⚙ 自动导出」改）`, 'info', 3000)
      }
      return
    }
    const r = (payload?.results || [])[0]
    if (!r) return
    if (!r.ok) {
      // 自动行为**失败必须说出来** —— 静默失败比没有功能更糟
      ui.err(`购物车自动导出失败: ${r.error}`, 4200)
      return
    }
    ui.ok(`✅ 购物车已自动导出 ${nfmt(r.count)} 个角色`, 3000)
  }

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
    // 黑名单变更后的自动导出结果 —— 订阅放在 app store 里(而不是首页):
    // ban 大多发生在标签页 / 光箱, 那时首页可能压根没挂载。
    onPush('export:auto', (payload) => notifyAutoExport(payload))
    // 购物车自动导出的结果 —— 同样放这里: 加角色大多发生在详情页/光箱/系列页,
    // 那些时候购物车抽屉根本没开, 提示得由全局这一层来弹。
    onPush('cart:auto', (payload) => notifyCartAuto(payload))
    // 主进程主动要说的短句（目前只有右键「复制图片到剪贴板」动手前的那句进度：
    // toPNG 是同步的，一进同步段主进程就发不出任何消息，所以必须**先说后干**）。
    onPush('app:toast', (p) => ui.toast(p?.text || '', p?.tone || 'info', p?.dur ?? 1800))

    applyStatus(await api.status())
    // 主进程是页面 did-finish-load 之后才开始加载数据, 有可能这里已经 ready 了
    if (phase.value === 'idle') phase.value = 'loading'

    // 同步可能在页面渲染之前就已经开跑(它只等数据集就绪, 不等界面), 所以补拉一次
    try { ingest.value = await api.ingestStatus() } catch { /* 主进程还没注册, 忽略 */ }
    try { tagger.value = await api.taggerStatus() } catch { /* 同上 */ }
    // 同理: 待导出的排程可能是在这个窗口出现之前就排下的(主进程的定时器不等界面)
    void pullAutoState()

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
   * 手动让各视图重跑一次初始查询 —— 数据集本身没重载, 但主进程返回的记录里
   * 带了新的信息时用。目前唯一的调用点是**改了安全模式的敏感标签集合**:
   * 主进程会重算每条记录的 unsafe 标记(只遍历内存), 而渲染层手里是上一次的
   * 副本, 只有重新查一次才能拿到新标记。
   *
   * 不加进 applyStatus 那套(它是"数据换了一茬"的语义), 单独一个入口更清楚。
   */
  function bumpEpoch() { epoch.value++ }

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
    theme, ready, loading, totalImages, ingest, tagger, autoExport,
    init, reload, applyStatus, bumpEpoch, toggleTheme, applyTheme,
    ingestRun, ingestPause, taggerRun, taggerPause, taggerRefresh,
    pullAutoState, flushAutoNow, clearAutoPending,
  }
})
