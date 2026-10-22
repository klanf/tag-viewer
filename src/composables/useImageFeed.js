/**
 * 图片流 —— 分页 / 无限滚动两种模式合一
 * =====================================
 * 旧版这套逻辑抄了两份: common.js 里的 loadImages(opts) 和 index.html 里的
 * doSearch/buildQuery/renderPager。两边的分页语义还不完全一样
 * (series/tags 用无限滚动, index 用页码分页)。这里用一个 composable 收敛:
 *
 *   const feed = useImageFeed({ infinite: true })
 *   feed.search({ q: 'blue_archive' })
 *   feed.loadMore()
 *   feed.goto(3)
 *
 * 内部只有一份 offset / pageSize / results 状态, 页面不用再自己算页码。
 */
import { ref, computed, shallowRef, onMounted, onBeforeUnmount } from 'vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

export function useImageFeed(opts = {}) {
  const ui = useUiStore()

  const infinite = ref(!!opts.infinite)
  const pageSize = ref(opts.pageSize || 60)
  /**
   * 自定义取数器(2026-10-21): 默认走 api.search(库内); 传了就按它取。
   * 标签图片页的扫描档用它换到 scan:tagImages —— 纯扫描夹的图不进库,
   * 返回形状与 search 对齐({total, results, unsafe}), 分页/加载更多全不用改。
   * **传函数而不是传静态配置**: 档位(来源|扫描夹)是运行时切的, 每次调用
   * 现场决定走哪条管线。
   */
  const fetcher = typeof opts.fetcher === 'function' ? opts.fetcher : null
  const doFetch = (p) => (fetcher ? fetcher(p) : api.search(p))

  const results = shallowRef([])
  const total = ref(0)
  /* 当前查询范围内两档各会隐藏多少张 —— 后端算好的(见 core/query.js 的 unsafeCountOf)。
     刻意与 offset/limit 无关: 翻页时这个数不变, 安全模式那个数字才不会随滚动跳。 */
  const unsafe = ref({ core: 0, edge: 0, total: 0 })
  const offset = ref(0)
  const page = ref(1)
  const loading = ref(false)
  const error = ref('')
  const loadedOnce = ref(false)

  // 当前查询(除 offset/limit 外的一切)
  let query = {}

  /* ---------------- 「图没了」-> 从列表里剔除 ----------------
   * 删到回收站(useTrash, 广播 'tv:trashed')与右键菜单「移动到」(广播 'tv:moved')
   * 都是**全局事件**: 谁要联动谁自己订阅。扫描页(自己一份列表)订阅了, 光箱(store)
   * 也订阅了, 但看板 / 标签图片 / 系列页的图片流**没人订阅** ——
   * 于是"文件真搬走了, 界面上那张还杵着"(2026-09-29 用户报)。
   *
   * 修在这一层: 上面三个视图都走 useImageFeed, 一次全覆盖; 以后新视图只要用
   * useImageFeed 就自带这个联动。
   *
   * ⚠️ **不走 useImageFeed 的列表视图要自己订阅这两个事件** —— 收藏页就是自己处理的,
   *    而且语义不同: 收藏**记录保留**、卡片标灰"文件已不在", 不是从列表里剔除。
   */
  function dropGone(paths) {
    const gone = new Set(Array.isArray(paths) ? paths : [])
    if (!gone.size || !results.value.length) return 0
    let n = 0
    for (const r of results.value) if (gone.has(r.path)) n++
    if (!n) return 0
    results.value = results.value.filter((r) => !gone.has(r.path))
    /* 计数只减**真的从本列表里拿掉**的张数: 若减 gone.size, 删掉的图不在当前筛选里时
       会越减越少, 出现"已加载 60 / 共 57"这种荒唐值。少减的那几次数不清会让 M 略偏大,
       下次 search 自然修正 —— 宁可偏大也不能偏成负数。 */
    total.value = Math.max(0, total.value - n)
    return n
  }
  const onGone = (e) => dropGone(e?.detail?.paths)
  onMounted(() => {
    window.addEventListener('tv:trashed', onGone)
    window.addEventListener('tv:moved', onGone)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('tv:trashed', onGone)
    window.removeEventListener('tv:moved', onGone)
  })

  /* 从后端**累计**取回多少条 —— 与"本地剔掉了几张"无关(见下面的 dropGone):
     loadMore 的下一页起点与 hasMore 的判据都用它, 不用 results.length。
     少了这个, 本地剔掉几张之后下一页起点会**往回退**, 重复拉已经看过的图。 */
  const fetched = ref(0)

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
  const hasMore = computed(() => offset.value + fetched.value < total.value)

  function params(off) {
    return {
      ...query,
      offset: off,
      limit: pageSize.value,
    }
  }

  /** 从头开始搜 */
  async function search(q) {
    if (q !== undefined) query = { ...q }
    offset.value = 0
    page.value = 1
    loading.value = true
    error.value = ''
    try {
      const d = await doFetch(params(0))
      results.value = d.results || []
      total.value = d.total || 0
      unsafe.value = d.unsafe || { core: 0, edge: 0, total: 0 }
      fetched.value = results.value.length
      loadedOnce.value = true
    } catch (e) {
      error.value = e.message
      results.value = []
      total.value = 0
      unsafe.value = { core: 0, edge: 0, total: 0 }
      fetched.value = 0
    } finally {
      loading.value = false
    }
  }

  /** 只换查询条件, 其余不变 */
  async function setQuery(patch) {
    query = { ...query, ...patch }
    await search()
  }

  /** 翻到第 p 页(分页模式) */
  async function goto(p) {
    const target = Math.max(1, Math.min(p, totalPages.value))
    offset.value = (target - 1) * pageSize.value
    page.value = target
    loading.value = true
    error.value = ''
    try {
      const d = await doFetch(params(offset.value))
      results.value = d.results || []
      total.value = d.total || 0
      unsafe.value = d.unsafe || { core: 0, edge: 0, total: 0 }
      fetched.value = results.value.length
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  /** 追加下一页(无限滚动模式) */
  async function loadMore() {
    if (loading.value) return
    if (!hasMore.value) return
    const next = offset.value + fetched.value
    loading.value = true
    try {
      const d = await doFetch(params(next))
      results.value = [...results.value, ...(d.results || [])]
      fetched.value += (d.results || []).length
      total.value = d.total || 0
      /* 追加页也会带这个数 —— 它与 offset 无关, 值跟第一页一样, 所以数字不会跳 */
      unsafe.value = d.unsafe || unsafe.value
    } catch (e) {
      ui.err('加载更多失败: ' + e.message)
    } finally {
      loading.value = false
    }
  }

  /** 换一批: 只在 random 排序下有意义(换随机种子) */
  let seed = Date.now()
  async function shuffle() {
    seed = Date.now()
    await setQuery({ sort: 'random', seed })
  }

  function reset() {
    results.value = []
    total.value = 0
    fetched.value = 0
    unsafe.value = { core: 0, edge: 0, total: 0 }
    offset.value = 0
    page.value = 1
    loadedOnce.value = false
    error.value = ''
  }

  /** 收藏变化后就地刷新当前页(旧版是重发一次请求, 这里同样重发, 保证 total 准确) */
  async function refresh() {
    if (infinite.value) await search()
    else await goto(page.value)
  }

  return {
    infinite, pageSize, results, total, unsafe, offset, page, loading, error, loadedOnce,
    totalPages, hasMore,
    search, setQuery, goto, loadMore, shuffle, reset, refresh,
    /** 暴露只读查询快照, 导出时要用同一套参数 */
    getQuery: () => ({ ...query, sort: query.sort, seed }),
    setPageSize: (n) => { pageSize.value = n },
  }
}

/**
 * 生成分页条要显示的页码: 首页 / 末页 / 当前页±1, 中间用省略号。
 * 与旧版 renderPager 完全一致的取法 —— 别改成"显示 5 个连续页码",
 * 用户习惯的是这一种。
 */
export function pagerPages(current, totalPages) {
  const set = new Set(
    [1, totalPages, current - 1, current, current + 1].filter((p) => p >= 1 && p <= totalPages),
  )
  const sorted = [...set].sort((a, b) => a - b)
  const out = []
  let prev = 0
  for (const p of sorted) {
    if (p - prev > 1) out.push({ type: 'gap', key: `gap-${p}` })
    out.push({ type: 'page', page: p, key: `p-${p}` })
    prev = p
  }
  return out
}
