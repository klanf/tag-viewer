/**
 * 大图预览(lightbox) —— 全站唯一实例
 * ==================================
 * 旧版把 openLB() 在 common.js / index.html / series.html / tags.html / scan.html
 * 里各抄了一份(还各自维护一套 lbTags/lbBanMap 全局变量)。这里收成一个 store,
 * 任何视图只要调用 lightbox.open(path, { list }) 就行。
 *
 * 四个复制按钮的语义(沿用旧版, 别改):
 *  复制全部标签  —— 只复制 general 标签, 剔除角色/系列(xxx_(系列))那些
 *  去ban        —— general 且未被黑名单命中
 *  含角色       —— 完整标签(含角色/系列)
 *  收藏         —— 切换该图收藏状态
 *
 * 2026-09-18 加：**列表上下文**。open() 可以顺手把「当前视图的图片顺序」传进来,
 * 于是光箱里就能滚轮/方向键翻页(第 n / 共 m 张), 不用关掉再点下一张。
 * 传进来的列表只在光箱存活期间使用, 关闭即清空 —— 免得视图切走后还留着旧数组。
 */
import { defineStore } from 'pinia'
import { ref, computed, nextTick } from 'vue'
import { api } from '@/utils/api.js'
import { useUiStore } from './useUiStore.js'
import { useFavStore } from './useFavStore.js'
import { usePrefsStore } from './usePrefsStore.js'
import { normTags, hasSeriesSuffix } from '@/utils/format.js'
import { LS, readLS, writeLS, removeLS } from '@/utils/lskey.js'

/**
 * 模块级单例标志 —— 'tv:trashed' / 'tv:moved' 的订阅只挂一次。
 * 放在 defineStore 外面: setup 每个应用只跑一次, 但 dev 热更新会重跑,
 * 少了这个守卫就会挂上第二份监听(现象是删一张图连跳两张)。
 */
let goneBound = false

/** lastPath 的 localStorage key(全站键名见 utils/lskey.js) */
function readLastPath() {
  return readLS(LS.lightboxLast.key) || ''
}
function writeLastPath(p) {
  if (p) writeLS(LS.lightboxLast.key, p)
  else removeLS(LS.lightboxLast.key)
}

export const useLightboxStore = defineStore('lightbox', () => {
  const ui = useUiStore()
  const fav = useFavStore()
  const prefs = usePrefsStore()

  const visible = ref(false)
  const loading = ref(false)
  const path = ref('')
  const data = ref(null)          // { char_tags, series, all_tags, ban_map, needs_bg, bg_append, external, prompt_source,
                                  //   meta_prompt, meta_tags, meta_source }  ← 2026-10-20 双源三件套
  const zhMap = ref({})
  const error = ref('')

  /** 当前视图的图片顺序(翻页用); 只在光箱打开期间有效 */
  const list = ref([])
  const index = ref(-1)

  /**
   * 「已知消失」的路径 —— **只用于拦住 preheat 的预读**, 整个会话保留。
   *
   * 这道的必要性(2026-09-20 用「记录器 + 调用栈」定位到的真实链路):
   *   扫描页删掉一张图 → 它在**收藏页**的记录是**刻意保留**的(卡片标灰"文件已不在",
   *   这是产品决策)。从收藏页打开光箱时, 翻页列表里就有这张已进回收站的图,
   *   于是 preheat 去预读相邻那张 → 请求一个不存在的文件 → 控制台一条 404,
   *   把「运行期无 JS 异常」这条总闸顶红。
   *
   * 两条边界必须写清楚, 否则修法会跑偏:
   *   · **只拦 preheat**(纯预读优化, 拦掉最多是首次翻页慢一点), 不用它过滤 list ——
   *     收藏页那份列表本来就该包含"记录还在、文件没了"的条目, 滤掉会让
   *     光箱的「第 n / 共 m 张」从 1/2 变成 1/1, 等于悄悄改了翻页语义。
   *   · **不随 close() 清空** —— 一关一开就把知识擦了, 上面那条链路照样会复现
   *     (实测就是这么漏过去的)。同名文件被重新放回来的话, 代价也只是少一次预读,
   *     真正要看它时 TvImage 该请求还是会请求。
   */
  const gonePaths = new Set()
  /** 这个路径是不是已经被删/移走了(光箱不该再为它做预读) */
  const isGone = (p) => !!p && gonePaths.has(p)

  /**
   * 最近一次在光箱里看过的图 —— close() 时不清空, 且**持久化到 localStorage**:
   * 重启应用后红框还标在那张图上(2026-09-19 用户拍板做持久化)。
   * 光箱开着时它实时跟着翻页走, 网格上的高亮也随之移动。
   */
  const lastPath = ref(readLastPath())

  /**
   * "还没为 lastPath 滚动过" 标志 —— 应用启动时为 true(刚从 localStorage 恢复,
   * 还没帮用户滚到那张)。带红框的卡片第一次被渲染出来时(TvImageCard onMounted)
   * 自动滚到它并把标志清掉; 光箱 close() 里的滚动也会清掉它。
   * 不持久化: 它只描述"本次运行内滚没滚过"。
   */
  const scrollPending = ref(!!lastPath.value)

  /** 角色标签排在前, 其余保持原顺序 */
  const sortedTags = computed(() => {
    const d = data.value
    if (!d) return []
    const chars = d.char_tags || []
    const others = (d.all_tags || []).filter((t) => !chars.includes(t))
    return [...chars, ...others]
  })

  const needBg = computed(() => !!data.value?.needs_bg)
  const bgAppend = computed(() => data.value?.bg_append || [])
  const isFav = computed(() => (path.value ? fav.isFav(path.value) : false))

  /* ---------------- 翻页状态 ---------------- */

  const count = computed(() => list.value.length)
  /** 从 1 数起的位置; 不在列表里(库外图/单张)时为 0 */
  const pos = computed(() => (index.value >= 0 ? index.value + 1 : 0))
  const canPrev = computed(() => index.value > 0)
  const canNext = computed(() => index.value >= 0 && index.value < list.value.length - 1)
  /** 列表里有没有这张图 —— 没有就不要显示 "n / m", 免得误导 */
  const inList = computed(() => count.value > 1 && index.value >= 0)

  /** 命中黑名单的标签(给光箱做「本图被 ban 了几个」的提示) */
  const bannedTags = computed(() => {
    const bm = data.value?.ban_map || {}
    return (data.value?.all_tags || []).filter((t) => bm[t]?.banned)
  })

  /* ---------------- 打开 / 关闭 / 翻页 ---------------- */

  /**
   * @param {string} p            图片路径
   * @param {{list?: string[]}} [opts]  list=当前视图的图片顺序(可选)
   */
  async function open(p, opts) {
    const l = Array.isArray(opts?.list) ? opts.list.filter(Boolean) : null
    let target = p
    if (l && l.length) {
      list.value = l
      const i = l.indexOf(p)
      index.value = i >= 0 ? i : -1
      if (i < 0) target = p            // 传进来的图不在列表里: 照常打开, 只是没有翻页
    } else {
      list.value = p ? [p] : []
      index.value = p ? 0 : -1
    }
    if (!target) return
    await load(target)
  }

  /** 加载一张图的标签数据。切图很快时, 慢请求回来会覆盖新图 —— 用 path 比对丢弃过期结果 */
  async function load(p) {
    path.value = p
    lastPath.value = p        // 高亮跟着走: 开着光箱翻页, 网格上的红框实时移动
    writeLastPath(p)          // 持久化: 重启后红框还在, 并在卡片首次渲染时自动滚过去
    visible.value = true
    loading.value = true
    error.value = ''
    data.value = null
    zhMap.value = {}

    try {
      const d = await api.lightbox(p)
      if (path.value !== p) return          // 用户已经翻到别的图了
      data.value = d
      // 翻译要等拿到标签列表之后才能查, 所以是第二步
      const tags = d.all_tags || []
      if (tags.length) {
        try {
          const m = await api.translate(tags)
          if (path.value === p) zhMap.value = m
        } catch { /* 没有翻译库也能用 */ }
      }
      // 图内元数据那套标签也送翻译(2026-10-20 双源): 只有切到「图内元数据·分类」
      // 才消费, 这里先备好 —— 不额外加 IPC, 查表是内存操作。
      const mtags = d.meta_tags || []
      if (mtags.length) {
        try {
          const m = await api.translate(mtags)
          if (path.value === p) zhMap.value = { ...zhMap.value, ...m }
        } catch { /* 同上 */ }
      }
    } catch (e) {
      if (path.value === p) error.value = e.message
    } finally {
      if (path.value === p) loading.value = false
    }
  }

  /* 翻页意图合并(2026-10-03): 主进程被同步读库阻塞时, load 里的 IPC 一直不回来,
   * 旧实现每个 keydown 都立刻 index++ 再 await —— 卡顿里按 N 次方向键 = 连跳 N 张,
   * 卡顿一结束"残存指令"直接跳到很后面的图。
   * 现在翻页进行中再按键, 不挪 index, 只把**最后一次按的方向**记进 pending
   * (覆盖不累计 —— 用户最后按的是左就该往左), 当前 load 回来后补翻这一张。
   * 键盘/滚轮/按钮全部入口都收敛在 go, 一处覆盖。 */
  let navBusy = false
  let navPending = 0

  /** 相对当前位置跳 delta 张; 越界返回 false(进行中受理意图返回 true) */
  async function go(delta) {
    if (navBusy) {
      navPending = delta
      return true
    }
    navBusy = true
    try {
      const i = index.value + delta
      if (i < 0 || i >= list.value.length) return false
      index.value = i
      await load(list.value[i])
      /* 卡顿/慢请求结束 —— 补执行积压的那一次 */
      if (navPending) {
        const j = index.value + navPending
        navPending = 0
        if (j >= 0 && j < list.value.length) {
          index.value = j
          await load(list.value[j])
        }
      }
      return true
    } finally {
      navBusy = false
      navPending = 0   // 未消费的意图随本次 go 一起丢弃, 不许跨页残留
    }
  }

  const next = () => go(1)
  const prev = () => go(-1)

  /** 跳到列表里第 n 张(从 0 数) */
  async function jump(n) {
    const i = Math.max(0, Math.min(n, list.value.length - 1))
    if (i === index.value) return false
    index.value = i
    await load(list.value[i])
    return true
  }

  /** 视图追加了新数据(无限滚动)后刷新列表, 并按 path 重新定位 */
  function setList(arr) {
    const l = Array.isArray(arr) ? arr.filter(Boolean) : []
    if (!l.length) return
    /* 守卫(2026-10-03): 新列表里**没有当前正在看的图**就不动 list/index。
     * 没有这道防线的两个真实事故:
     *   · 跨视图污染 —— 光箱全站唯一, 但视图的 imgPaths watch 在 KeepAlive
     *     休眠下依然活跃: 用户在扫描页光箱里看图, 后台看板因 epoch++ 重查,
     *     把看板的列表塞进来(当前图不在其中 -> index=-1) -> 用户再移走一张,
     *     removeCurrent 因 index=-1 清空列表 -> close() —— 表现为"反推/移动
     *     一下, 光箱自己关了"。
     *   · 换血踢人 —— 看板开着光箱时 epoch++ -> initHome 重置随机种子重查,
     *     当前图不在新一批里 -> 翻页列表被换成无关的图。
     * 保留旧列表的代价只是"翻页顺序还是上一批的", 用户至少能把手里这批看完;
     * 视图自己的新列表在光箱下次 open 时自然生效。 */
    if (path.value && !l.includes(path.value)) return
    list.value = l
    index.value = l.indexOf(path.value)
  }

  /**
   * 当前图已被删除(进回收站) —— 从列表里剔除并自动跳到相邻一张。
   * 列表空了就直接关闭。返回 true 表示还停在光箱里, false 表示已关闭。
   */
  async function removeCurrent() {
    if (path.value) gonePaths.add(path.value)      // 记账: 之后不给它做预读
    if (index.value >= 0 && index.value < list.value.length) {
      list.value.splice(index.value, 1)
    } else {
      list.value = []
      index.value = -1
    }
    if (!list.value.length) { close(); return false }
    const ni = Math.min(Math.max(index.value, 0), list.value.length - 1)
    index.value = ni
    await load(list.value[ni])
    return true
  }

  /* ---------------- 「图没了」-> 自动前进 ----------------
   * 'tv:trashed'(useTrash 删到回收站) 与 'tv:moved'(右键菜单「移动到」) 广播的
   * 都是「已经不在这个文件夹里」的路径。光箱自己订阅这两个事件来推进, 而不是
   * 指望每个入口都记得调一次 removeCurrent():
   *   · Del 键那条路以前是显式调的 —— 所以只有它是对的;
   *   · 右键菜单的「删除到回收站 / 移动到」只广播事件, 没人接手, 于是光箱会
   *     停在一张已经被搬走的图上, 表现为一个空白占位(2026-09-19 反馈的 bug)。
   *
   * 订阅放在 store 里而不是 TvLightbox 组件里: list / index / path 都是 store 的
   * 状态, "自我修复" 就该跟着状态走 —— 首页 / 系列 / 标签 / 扫描四个视图共用
   * 同一个光箱, 于是这四处一次全修好, 以后新增入口也不会再漏。
   */
  function onGone(e) {
    if (!visible.value || !path.value) return
    const gone = e?.detail?.paths
    if (!Array.isArray(gone) || !gone.length) return
    // 被删/被移走的一律记账 —— 哪怕动的不是当前这张(下面会 return),
    // 之后 preheat 也不该再去预读它
    for (const p of gone) if (p) gonePaths.add(p)
    if (!gone.includes(path.value)) return          // 动的是别的图, 光箱原地不动
    removeCurrent().catch((err) => console.error('[lightbox] 删除/移动后自动前进失败:', err))
  }

  if (typeof window !== 'undefined' && !goneBound) {
    goneBound = true
    window.addEventListener('tv:trashed', onGone)
    window.addEventListener('tv:moved', onGone)
  }

  /* ---------------- 「点标签跳子页面」的记忆 ----------------
   * 2026-09-20 用户需求: 在光箱里点标签跳去 /tags/:tag 后, 按浮动返回键要
   * **回到刚才的页面并把光箱恢复出来**(定位到刚才那张图, 翻页列表也在)。
   * 光箱跳走时必须先 close()(不然 Teleport 的遮罩盖在新页面上), 状态就没了 ——
   * 所以跳走前把"当前图 + 翻页列表"记在这里, 子页面的返回键回来时取走恢复。
   * 记忆带 tag 名: 子页面只消费"自己这个标签"的跳转记忆, 手动导航到别的
   * 标签子页面按返回不会错误地拉起光箱。模块级变量, 不进 localStorage ——
   * 刷新后丢了就退化为"只回页面不恢复", 无害。
   *
   * 只服务**路由跳转**(独立标签页)。看板/系列/扫描的就地 tag 页可以逐层往下叠,
   * 每层现场由宿主自己快照(见各视图的 tagLevels), 不共用这份单例记忆。 */
  let lastJump = null

  /** 光箱点标签跳走之前调: 记住当前图和翻页列表。
   *  key 一般就是标签名; 「库内命中」页用 `meta:<图片路径>` 这种自带前缀的 key,
   *  与真标签名不会撞。 */
  function rememberJump(tag) {
    lastJump = {
      tag,
      imgPath: path.value,
      list: list.value.length > 1 ? [...list.value] : null,
    }
  }

  /** 子页面返回时调: 是从这个标签跳过来的才给, 并清掉(一次性) */
  function takeJump(tag) {
    if (!lastJump || lastJump.tag !== tag) return null
    const j = lastJump
    lastJump = null
    return j
  }

  function close() {
    visible.value = false
    data.value = null
    path.value = ''
    list.value = []
    index.value = -1    // gonePaths 故意不清 —— 见它的注释: 清了会让"收藏页保留了已删记录"那条链路再撞 404
    // lastPath 故意不清(见上面的注释)。这里再帮一把:
    //   1) 广播 'tv:lb-closed' —— 有的视图是累加分页/窗口分页, 高亮那张可能还没
    //      渲染出来, 视图自己决定要不要把分页补齐(ScanView 就补);
    //   2) nextTick 后把高亮那张卡滚进可视区(block:'nearest' = 已可见就不动, 不会跳屏)。
    // 事件是同步广播的, 视图补页的渲染会排在同一次 flush 里, 所以这里的
    // nextTick 回调一定能看到补齐后的 DOM。
    if (lastPath.value && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tv:lb-closed', { detail: { path: lastPath.value } }))
      /* 滚不到(卡片还没挂载/这页此刻没显示)时**不能**把 scrollPending 抹掉:
         抹了就等于"这次一定要滚过去", 之后卡片挂回来了反而没人负责滚 ——
         叠层里切走再切回就再也定位不到上次那张(2026-10-24 用户报的第三条)。
         留着由 TvImageCard 挂载时自己认。 */
      nextTick(() => { if (revealLastViewed({ block: 'nearest' })) scrollPending.value = false })
    }
  }

  /**
   * 把「上次看到这张」那张卡滚进视野 —— 只有**真的看得见**的卡片才算数
   * (叠层底下那层是 v-show 藏起来的, offsetParent 为 null, 拿它滚等于白滚)。
   * 返回是否真的滚了, 调用方据此决定要不要接着恢复自己的滚动位置。
   */
  function revealLastViewed({ block = 'center', clearPending = false } = {}) {
    if (!lastPath.value || visible.value || typeof document === 'undefined') return false
    const el = [...document.querySelectorAll('.card.last-viewed')].find((e) => e.offsetParent !== null)
    if (!el) return false
    el.scrollIntoView({ block, behavior: 'smooth' })
    if (clearPending) scrollPending.value = false
    return true
  }

  /* ---------------- 复制 ---------------- */

  function maybeAddBg(l) {
    return prefs.maybeAddBg(l, needBg.value, bgAppend.value)
  }

  /** general 标签(剔除角色/系列) —— 主进程已按角色库算好 plain_tags, 老数据走括号规则兜底 */
  function generalTags() {
    const d = data.value
    if (!d) return []
    if (Array.isArray(d.plain_tags)) return d.plain_tags
    return (d.all_tags || []).filter((t) => !hasSeriesSuffix(t))
  }

  async function copyPlain() {
    await ui.copy(normTags(maybeAddBg(generalTags())).join(', '))
  }

  async function copyNoBan() {
    const banMap = data.value?.ban_map || {}
    const tags = generalTags().filter((t) => !(banMap[t] || {}).banned)
    const removed = (data.value?.all_tags || []).length - tags.length
    const note = (prefs.bgAuto && needBg.value && bgAppend.value.length)
      ? `, 补背景 ${bgAppend.value.join('/')}` : ''
    await ui.copy(tags.length ? normTags(maybeAddBg(tags)).join(', ') : '')
    ui.ok(`✅ 已复制(剔除 ${removed} 个被 ban/角色/系列 标签${note})`)
  }

  async function copyRaw() {
    await ui.copy(normTags(maybeAddBg(data.value?.all_tags || [])).join(', '))
  }

  /**
   * 按过滤配置复制(2026-10-19 复制设置面板):
   *   ban / 角色·系列 在本地剔(ban_map / plain_tags 光箱手里现成);
   *   视角 / 安全 / 替换 走主进程 tags:filterCopy —— 与导出同一套原语, 不漂移。
   * 主进程没有这条通道(老版本没重启)时退回本地原始标签照常复制, 只报一句。
   */
  async function copyFiltered(cfg = {}) {
    const d = data.value
    if (!d) return
    const base = cfg.char ? generalTags() : (d.all_tags || []).slice()
    let tags = base
    let banCut = 0
    if (cfg.ban) {
      const banMap = d.ban_map || {}
      tags = base.filter((t) => {
        const hit = (banMap[t] || {}).banned
        if (hit) banCut++
        return !hit
      })
    }
    let out = tags
    let counts = null
    try {
      const r = await api.tagsFilterCopy({
        tags,
        opts: {
          replace_set: cfg.replace_set || '',
          view: !!cfg.view,
          safe: !!cfg.safe,
          safe_level: cfg.safe_level || '',
        },
      })
      if (r?.error) throw new Error(r.error)
      out = r.tags || tags
      counts = r.counts || null
    } catch (e) {
      ui.err(`过滤通道不可用(${e.message}), 已按本地标签复制`)
    }
    const bgOn = prefs.bgAuto && needBg.value && bgAppend.value.length
    await ui.copy(normTags(maybeAddBg(out, needBg.value, bgAppend.value)).join(', '))
    const parts = []
    if (banCut) parts.push(`去ban ${banCut}`)
    if (counts?.view) parts.push(`视角 ${counts.view}`)
    if (counts?.safe) parts.push(`安全 ${counts.safe}`)
    if (counts?.replaced) parts.push(`替换 ${counts.replaced}`)
    if (bgOn) parts.push(`补背景 ${bgAppend.value.join('/')}`)
    ui.ok(parts.length ? `✅ 已复制(${parts.join(' · ')})` : '✅ 已复制')
  }

  /* ---------------- ban / 收藏 ---------------- */

  /** 返回 'banned' | 'unbanned' | 'wildcard' | 'error' */
  async function toggleBan(tag) {
    try {
      const r = await api.blacklistToggle(tag)
      if (r.action === 'wildcard') {
        ui.warn(r.warning || `该标签被通配规则 ${r.ban_rule} 命中, 需在黑名单里手动修改`, 4000)
        return 'wildcard'
      }
      // 就地更新 ban_map, 不用重新拉整份数据
      if (data.value?.ban_map) {
        data.value.ban_map[tag] = { banned: !!r.banned, rule: r.banned ? tag.toLowerCase() : '' }
      }
      ui.ok(r.banned ? `🚫 已 ban: ${tag}` : `已取消 ban: ${tag}`)
      return r.banned ? 'banned' : 'unbanned'
    } catch (e) {
      ui.err('操作失败: ' + e.message)
      return 'error'
    }
  }

  /** 把当前图里所有命中黑名单的标签一次性列出(给「全部取消 ban」用) */
  async function unbanAll(banned) {
    let n = 0
    for (const t of banned || []) {
      try {
        const r = await api.blacklistToggle(t)
        if (r.banned === false) {
          n++
          if (data.value?.ban_map) data.value.ban_map[t] = { banned: false, rule: '' }
        }
      } catch { /* 单条失败不中断 */ }
    }
    if (n) ui.ok(`已取消 ${n} 个标签的 ban`, 1800)
    else ui.warn('这些标签都由通配规则命中, 需在黑名单里改规则', 3000)
    return n
  }

  function toggleFav() {
    if (!path.value) return
    // 把当前标签一起存进收藏(扫描图不在标签库, 收藏页显示标签只能靠这份快照)
    const added = fav.toggle(path.value, sortedTags.value)
    ui.ok(added ? '★ 已收藏' : '已取消收藏', 1200)
  }

  return {
    visible, loading, path, data, zhMap, error,
    sortedTags, needBg, bgAppend, isFav, bannedTags,
    list, index, count, pos, canPrev, canNext, inList, lastPath, scrollPending,
    open, close, revealLastViewed, next, prev, go, jump, setList, removeCurrent, isGone,
    rememberJump, takeJump,
    copyPlain, copyNoBan, copyRaw, copyFiltered, toggleBan, unbanAll, toggleFav, maybeAddBg,
  }
})
