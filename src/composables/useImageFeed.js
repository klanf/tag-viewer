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
import { ref, computed, shallowRef } from 'vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

export function useImageFeed(opts = {}) {
  const ui = useUiStore()

  const infinite = ref(!!opts.infinite)
  const pageSize = ref(opts.pageSize || 60)

  const results = shallowRef([])
  const total = ref(0)
  /* 当前查询范围内两档各会隐藏多少张 —— 后端算好的(见 core/query.js 的 unsafeCountOf)。
     刻意与 offset/limit 无关: 翻页时这个数不变, 安全模式那个数字才不会随滚动跳。 */
  const unsafe = ref({ core: 0, edge: 0 })
  const offset = ref(0)
  const page = ref(1)
  const loading = ref(false)
  const error = ref('')
  const loadedOnce = ref(false)

  // 当前查询(除 offset/limit 外的一切)
  let query = {}

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
  const hasMore = computed(() => offset.value + results.value.length < total.value)

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
      const d = await api.search(params(0))
      results.value = d.results || []
      total.value = d.total || 0
      unsafe.value = d.unsafe || { core: 0, edge: 0 }
      loadedOnce.value = true
    } catch (e) {
      error.value = e.message
      results.value = []
      total.value = 0
      unsafe.value = { core: 0, edge: 0 }
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
      const d = await api.search(params(offset.value))
      results.value = d.results || []
      total.value = d.total || 0
      unsafe.value = d.unsafe || { core: 0, edge: 0 }
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
    const next = offset.value + results.value.length
    loading.value = true
    try {
      const d = await api.search(params(next))
      results.value = [...results.value, ...(d.results || [])]
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
    unsafe.value = { core: 0, edge: 0 }
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
