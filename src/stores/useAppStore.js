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

/** 2026-10-01 扩成 5 套: dark(默认) / light / eye(护眼绿) / paper(纸墨) / ocean(深海蓝)。
 *  变量组全在 styles/tokens.css, 每套一个 html[data-theme=...] 覆盖块;
 *  dark:true 的两套在「深浅快捷互换」里当暗色侧。 */
/* 2026-10-01 五套; 2026-10-02 扩成七套且色板顺序浅色系在前(用户不喜欢深色):
   eye / light / paper / peach / lavender + dark / ocean。
   dot 用**主色**而不是底色 —— 浅色系底全是近白, 拿底色当圆点根本分不清。 */
export const APP_THEMES = [
  { key: 'eye',      label: '护眼绿', dot: '#2f6d52', dark: false },
  { key: 'light',    label: '浅色',   dot: '#3573b9', dark: false },
  { key: 'paper',    label: '纸墨',   dot: '#9c6a2b', dark: false },
  { key: 'peach',    label: '蜜桃',   dot: '#bd5d3a', dark: false },
  { key: 'lavender', label: '薰衣草', dot: '#6f5bb5', dark: false },
  { key: 'dark',     label: '深色',   dot: '#1e2229', dark: true },
  { key: 'ocean',    label: '深海蓝', dot: '#17202f', dark: true },
]
const THEME_KEYS = APP_THEMES.map((t) => t.key)

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

  /* ---- 封面(2026-10-22) ----
   * coverTick: 主进程每次写盘成功都会广播 cover:changed, 这里只把它变成一个自增的
   * "版本号"。为什么不用弹窗的 emit('saved') 通知刷新: 用户在「下载中」关掉弹窗时,
   * 写盘照样完成了但那句 emit 丢了 —— 于是封面只能重启才显示。订阅全局推送就与
   * 弹窗生死无关, 而且购物车/系列页两处都能收到。
   * autoCover: 批量自动拉封面的运行状态(主进程后台任务, 进度走 covers:auto:progress)。 */
  const coverTick = ref(0)
  const autoCover = ref(null)

  /* ---- 标签分类映射(2026-10-16, 展示分组着色) ----
   * { tag: cat } —— cat 形如 'count'/'char'/'series'/'artist'/'meta'/'other'/'general:服饰'。
   * 主进程在 tags:cats 一次给全(字典 1.3 万条, 几百 KB); 数据重载后拉一次即可。
   * 字典之外的新词查不到 -> catOf 返回 'other' 兜底, 下次重载后自然补上。 */
  const tagCats = ref({})
  const catsLoaded = ref(false)
  async function loadTagCats() {
    try {
      const r = await api.tagsCats()
      if (r?.cats) { tagCats.value = r.cats; catsLoaded.value = true }
    } catch { /* 分类映射拉不到不致命: 展示端回落 other */ }
  }
  const SEG_LABEL = {
    count: '人数', char: '角色', series: '系列', artist: '画师',
    meta: 'Meta', other: '其他', general: '通用',
  }
  function catOf(tag) { return tagCats.value[tag] || 'other' }
  function segOf(tag) { return (catOf(tag).split(':')[0]) || 'other' }
  function subOf(tag) { return (catOf(tag).split(':') || [])[1] || '' }
  function segLabel(seg) { return SEG_LABEL[seg] || seg }

  /* ---- settings.json 的渲染层缓存 ----
   * 前端只读展示偏好(groupedTags 等); 写仍走设置弹窗的 api.settingsSet。
   * 这里用 settingsSet({}) 当只读查询用(它返回当前 settings 且空 patch 不改任何值),
   * 与 TvSettingsModal 的读法保持同一通道, 免得再加一条只读 IPC。 */
  const settings = ref({})
  async function pullSettings() {
    try {
      const r = await api.settingsSet({})
      if (r?.settings) settings.value = r.settings
    } catch { /* 读不到就用默认值 */ }
  }
  /** 写单个展示偏好并同步本地缓存(groupedTags / showBannedTags 这类即时开关用),
   *  免得每个开关各抄一遍 settingsSet + 回填。
   *  乐观更新: 先改本地缓存让开关**立即生效**, 再落盘对账 —— 不等 IPC 回包,
   *  否则主进程旧版(白名单没这个键)静默丢 patch 时开关看起来就是"点了没反应"。 */
  async function setSetting(key, value) {
    settings.value = { ...settings.value, [key]: value }
    try {
      const r = await api.settingsSet({ [key]: value })
      if (r?.settings) settings.value = r.settings
    } catch { /* 落盘失败先维持乐观值, 下次 pullSettings 校正 */ }
  }
  /**
   * 反推环境搭建进度(Python 运行时 / WD14 模型下载)。主进程在「现在下载」确认后
   * 通过 tagger:setup-progress 推结构化消息:
   *   { probe: {needPython, needModel} } —— **纯探测**(boot 后 4 秒推一次), 不驱动卡片
   *   { stage }                          —— 阶段文本(探测/解压/校验…)
   *   { file, bytes, total, pct }        —— 某文件字节级下载进度
   *   { done: true, stage }              —— 全部完成
   *   { error }                          —— 失败(主进程另发 toast)
   * 下载失败主进程走 toast 报错, 这里只负责"进行中/完成"的可视化。
   * 组件侧在 done 后停留几秒再收起(见 TvSetupProgress)。
   *
   * 2026-10-16 拆分: probe 单独放 setupProbe —— 以前 probe 也写进 setup, 于是
   * 一台环境已经齐全的机器上, probe 点亮了「反推环境准备中…」卡片却永远等不到
   * done(探测之后根本没有下载), 卡片**永久驻留**在右下角(另一台机器实测)。
   */
  const setup = ref(null)
  const setupProbe = ref(null)
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

  // 主题: 默认深色(与旧版一致, 也利于看图)。旧 localStorage 里只可能存过 dark/light,
  // 其它一律回落 dark —— 不认的值别硬上, 免得哪天改了主题名单后旧值把整站打回无样式。
  const stored = typeof localStorage !== 'undefined' ? readLS(LS.theme.key) : ''
  const theme = ref(THEME_KEYS.includes(stored) ? stored : 'dark')

  function applyTheme() {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = theme.value
  }
  function setTheme(t) {
    if (!THEME_KEYS.includes(t) || t === theme.value) return
    theme.value = t
    writeLS(LS.theme.key, t)
    applyTheme()
  }
  /* 深浅快捷互换(色板之外的快速路径): 暗色系(dark/ocean) -> light, 亮色系 -> dark */
  function toggleTheme() {
    const isDark = APP_THEMES.find((t) => t.key === theme.value)?.dark
    setTheme(isDark ? 'light' : 'dark')
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
    // 进度推送来自 taggerState, 不含 config/queue —— 直接替换会让设置弹窗里的
    // 模型路径瞬间变空、误报"未找到"(2026-10-21 实测: 开机自动反推期间打开设置)。
    onPush('tagger:progress', (p) => {
      const prev = tagger.value || {}
      tagger.value = { ...prev, ...p, config: p.config || prev.config, queue: p.queue || prev.queue }
    })
    // 黑名单变更后的自动导出结果 —— 订阅放在 app store 里(而不是首页):
    // ban 大多发生在标签页 / 光箱, 那时首页可能压根没挂载。
    onPush('export:auto', (payload) => notifyAutoExport(payload))
    // 购物车自动导出的结果 —— 同样放这里: 加角色大多发生在详情页/光箱/系列页,
    // 那些时候购物车抽屉根本没开, 提示得由全局这一层来弹。
    onPush('cart:auto', (payload) => notifyCartAuto(payload))
    // 主进程主动要说的短句（目前只有右键「复制图片到剪贴板」动手前的那句进度：
    // toPNG 是同步的，一进同步段主进程就发不出任何消息，所以必须**先说后干**）。
    onPush('app:toast', (p) => useUiStore().toast(p?.text || '', p?.tone || 'info', p?.dur ?? 1800))
    // 反推环境搭建进度 —— 挂全局层: 下载发生时用户可能停在任意页面。
    // probe 走单独的 ref: 它只是"缺不缺东西"的一次探测, 不该点亮下载卡片。
    onPush('tagger:setup-progress', (p) => {
      if (p && p.probe && !p.stage && !p.done && !p.error && !p.file) {
        setupProbe.value = p.probe
        return
      }
      setup.value = p || null
    })
    // 封面写盘成功 -> 自增版本号。订阅放全局层: 发起方(换封面弹窗/批量任务)和
    // 显示方(系列页/购物车抽屉)不在同一个组件里, 而且弹窗可能已经被关掉了。
    onPush('cover:changed', () => { coverTick.value++ })
    onPush('covers:auto:progress', (p) => { autoCover.value = p })

    applyStatus(await api.status())
    void pullSettings()
    // 主进程是页面 did-finish-load 之后才开始加载数据, 有可能这里已经 ready 了
    if (phase.value === 'idle') phase.value = 'loading'

    // 同步可能在页面渲染之前就已经开跑(它只等数据集就绪, 不等界面), 所以补拉一次
    try { ingest.value = await api.ingestStatus() } catch { /* 主进程还没注册, 忽略 */ }
    try { tagger.value = await api.taggerStatus() } catch { /* 同上 */ }
    // 批量拉封面同理: 任务是在主进程跑的, 界面重开/切页之后要能把进度条接回来
    try { autoCover.value = await api.coversAutoState() } catch { /* 忽略 */ }
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
    if (phase.value === 'ready') {
      if (!wasReady) {
        // 首次就绪 / 手动重载(loading -> ready): 各视图从头初始化
        epoch.value++
        void loadTagCats()
      } else {
        // ready -> ready: 后台静默重载(同步/反推完成后)推上来的 —— 界面一直
        // 是可用的, 不能像 loading 那样全量重置视图。数据真的变了(记录数/标签数/
        // 系列数)才 bump 一次 epoch 让各视图重查; 移动/删除引起的卡片剔除已由
        // tv:moved / tv:trashed 事件在前端处理过, 不需要再惊动。
        const s0 = stats.value, s1 = st.stats
        if (s1 && (!s0 || s0.records !== s1.records || s0.tags !== s1.tags || s0.series !== s1.series)) {
          epoch.value++
          void loadTagCats()
        }
      }
    }
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

  /**
   * 批量自动拉封面(2026-10-22): 主进程后台任务, 启动即返回, 之后全靠
   * covers:auto:progress 推送更新状态 —— 所以发起的页面切走/关掉都不影响。
   * targets: [{kind:'chars'|'series', key, label}]
   *
   * **跑着的时候也能调**: 主进程会把它排进当前这批的队列(见 coverfetch.js),
   * 回包带 queued 条数。所以这里不能再拦 `running` —— 拦了就等于"切个系列
   * 就加不进来了"(用户 2026-10-22 的原话)。
   */
  async function autoCoverRun(targets, opts = {}) {
    if (!targets?.length) return { error: '没有要处理的角色' }
    const wasRunning = !!autoCover.value?.running
    // 只有开新一批才本地点亮: 追加时已有真实进度, 覆盖成 done=0 会闪一下
    if (!wasRunning) {
      autoCover.value = { running: true, total: targets.length, done: 0, ok: 0, failed: 0, skipped: 0, queued: targets.length, current: '准备中 ...', errors: [] }
    }
    const r = await api.coversAutoRun({
      targets,
      source: opts.source || 'danbooru',
      rating: opts.rating || 'g',
      // solo(只要单人图): 加一个标签条件, 匿名时 Danbooru 的 2 标签额度会被占满(见 booru.js)
      solo: !!opts.solo,
      skipCustom: opts.skipCustom !== false,
    })
    if (r?.error) {
      if (!wasRunning) autoCover.value = { ...(autoCover.value || {}), running: false, current: '' }
      return r
    }
    // 回包本身就是最新快照(含 total/queued): 先落上, 后续推送继续覆盖
    if (r && typeof r.total === 'number') autoCover.value = r
    return r
  }

  async function autoCoverCancel() {
    try { autoCover.value = await api.coversAutoCancel() } catch { /* 忽略 */ }
    return autoCover.value
  }

  async function autoCoverRefresh() {
    try { autoCover.value = await api.coversAutoState() } catch { /* 忽略 */ }
    return autoCover.value
  }

  return {
    phase, error, progress, stats, translate, workspace, config, sourcesInfo, loadMs, epoch,
    theme, setTheme, ready, loading, totalImages, ingest, tagger, setup, setupProbe, autoExport,
    coverTick, autoCover, autoCoverRun, autoCoverCancel, autoCoverRefresh,
    init, reload, applyStatus, bumpEpoch, toggleTheme, applyTheme,
    ingestRun, ingestPause, taggerRun, taggerPause, taggerRefresh,
    pullAutoState, flushAutoNow, clearAutoPending,
    // 标签分类(2026-10-16): tagCats 映射 + 分段查询助手
    tagCats, catsLoaded, loadTagCats, catOf, segOf, subOf, segLabel,
    settings, pullSettings, setSetting,
  }
})
