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
  const data = ref(null)          // { char_tags, series, all_tags, ban_map, needs_bg, bg_append, external, prompt_source }
  const zhMap = ref({})
  const error = ref('')

  /** 当前视图的图片顺序(翻页用); 只在光箱打开期间有效 */
  const list = ref([])
  const index = ref(-1)

  /**
   * 最近一次在光箱里看过的图 —— close() 时不清空, 且**持久化到 localStorage**:
   * 重启应用后绿框还标在那张图上(2026-09-19 用户拍板做持久化)。
   * 光箱开着时它实时跟着翻页走, 网格上的高亮也随之移动。
   */
  const lastPath = ref(readLastPath())

  /**
   * "还没为 lastPath 滚动过" 标志 —— 应用启动时为 true(刚从 localStorage 恢复,
   * 还没帮用户滚到那张)。带绿框的卡片第一次被渲染出来时(TvImageCard onMounted)
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
    lastPath.value = p        // 高亮跟着走: 开着光箱翻页, 网格上的绿框实时移动
    writeLastPath(p)          // 持久化: 重启后绿框还在, 并在卡片首次渲染时自动滚过去
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
    } catch (e) {
      if (path.value === p) error.value = e.message
    } finally {
      if (path.value === p) loading.value = false
    }
  }

  /** 相对当前位置跳 delta 张; 越界返回 false */
  async function go(delta) {
    const i = index.value + delta
    if (i < 0 || i >= list.value.length) return false
    index.value = i
    await load(list.value[i])
    return true
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
    list.value = l
    index.value = l.indexOf(path.value)
  }

  /**
   * 当前图已被删除(进回收站) —— 从列表里剔除并自动跳到相邻一张。
   * 列表空了就直接关闭。返回 true 表示还停在光箱里, false 表示已关闭。
   */
  async function removeCurrent() {
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
    if (!gone.includes(path.value)) return          // 动的是别的图, 光箱原地不动
    removeCurrent().catch((err) => console.error('[lightbox] 删除/移动后自动前进失败:', err))
  }

  if (typeof window !== 'undefined' && !goneBound) {
    goneBound = true
    window.addEventListener('tv:trashed', onGone)
    window.addEventListener('tv:moved', onGone)
  }

  function close() {
    visible.value = false
    data.value = null
    path.value = ''
    list.value = []
    index.value = -1
    // lastPath 故意不清(见上面的注释)。这里再帮一把:
    //   1) 广播 'tv:lb-closed' —— 有的视图是累加分页/无限滚动, 高亮那张可能还没
    //      渲染出来, 视图自己决定要不要把分页补齐(ScanView 就补);
    //   2) nextTick 后把绿框卡滚进可视区(block:'nearest' = 已可见就不动, 不会跳屏)。
    // 事件是同步广播的, 视图补页的渲染会排在同一次 flush 里, 所以这里的
    // nextTick 回调一定能看到补齐后的 DOM。
    if (lastPath.value && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tv:lb-closed', { detail: { path: lastPath.value } }))
      nextTick(() => {
        document.querySelector('.card.last-viewed')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
      scrollPending.value = false   // 已经滚过了, 卡片挂载时不要再滚一次
    }
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
    ui.ok(added ? '★ 已收藏' : '已取消收藏', 'ok', 1200)
  }

  return {
    visible, loading, path, data, zhMap, error,
    sortedTags, needBg, bgAppend, isFav, bannedTags,
    list, index, count, pos, canPrev, canNext, inList, lastPath, scrollPending,
    open, close, next, prev, go, jump, setList, removeCurrent,
    copyPlain, copyNoBan, copyRaw, toggleBan, unbanAll, toggleFav, maybeAddBg,
  }
})
