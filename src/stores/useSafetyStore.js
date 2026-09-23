/**
 * 安全模式 —— 按标签集合隐藏露骨内容（只做展示层过滤）
 * ====================================================
 * 开关与档位由主进程持有（`dataDir/safety.json`），标签集合在
 * `dataDir/safety_tags.txt`（两段式，用户可直接编辑）。这里只是镜像 + 判定。
 *
 * **为什么可以随便开关**：每张图的敏感标记（`record.unsafe` = 0/1/2）是
 * 主进程**读数据集时一次算好**的，前端只做数值比较 —— 于是切开关、切档位
 * 都不需要重载八万行数据，库里的一行也不会变。关掉立刻全回来。
 *
 * **库外图（扫描页）没有那个标记**：它们的标签是现场从 PNG 元数据解析的，库里没有
 * 对应行。所以这里还对"没有 unsafe 字段"的 item 用前端镜像规则**现算**一遍
 * （见 utils/safetyMatch.js）—— 这样"能看到图片的地方"就都能过滤，不只在库内页面。
 * 逐张现算会有开销（一张图约 40 个标签），用 WeakMap 按"标签数组引用 + 规则代次"记忆。
 *
 * 默认是**关闭**：实测 core 档会藏掉 58% 的图，这种东西不能默认开。
 */
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { call } from '@/utils/api.js'
import { hiddenBySafety } from '@/utils/format.js'
import { compileRules, unsafeOfTags, countHits as countHitsOf } from '@/utils/safetyMatch.js'
import { useAppStore } from './useAppStore.js'

export const useSafetyStore = defineStore('safety', () => {
  const on = ref(false)
  const level = ref('core')        // core | edge
  const coreHit = ref(0)           // core 档会隐藏多少张
  const edgeHit = ref(0)           // edge 档会隐藏多少张
  const total = ref(0)             // 数据集总条数(用来算占比)
  const core = ref([])             // core 段的标签(界面展示)
  const edge = ref([])             // edge 段的标签
  const loaded = ref(false)

  /** 编译后的规则(库外图现算用) + 代次(规则一变, 记忆就作废) */
  const matcher = computed(() => ({ core: compileRules(core.value), edge: compileRules(edge.value) }))
  let gen = 0
  let tagsMemo = new WeakMap()
  watch([core, edge], () => { gen++; tagsMemo = new WeakMap() })

  function apply(d) {
    if (!d) return
    on.value = d.on === true
    level.value = d.level === 'edge' ? 'edge' : 'core'
    coreHit.value = Number(d.coreHit) || 0
    edgeHit.value = Number(d.edgeHit) || 0
    total.value = Number(d.total) || 0
    if (Array.isArray(d.core)) core.value = d.core
    if (Array.isArray(d.edge)) edge.value = d.edge
  }

  async function load() {
    try {
      apply(await call('safety:get'))
      loaded.value = true
    } catch (e) {
      console.error('[safety] 读取安全模式配置失败:', e)
    }
  }

  /* **规则表必须自己拉一次** —— 别把"加载"这件事交给某个弹窗。
   *
   * 2026-09-23 踩到: load() 原来只在 TvSafetyModal 打开时调用。于是**没打开过设置台**
   * 的用户手里是 core=[] / edge=[]，`compileRules([])` 得到的是**空规则** ——
   * 库外图（扫描页那些 / 收藏里的标签快照）的安全判定**恒为 0**：开关看着能开能关、
   * toast 也报，实际对那批图毫无作用，且不报任何错。库内图不受影响（它们用主进程算好的
   * `unsafe` 字段），所以问题只藏在"前端镜像判定"这条路上，特别难发现 ——
   * 是 e2e 里"关着也显示的数字应该是 1、结果读到 0"把它翻出来的。
   * 顺带修掉另一个: 重启后 `on` / `level`（存在 safety.json 里）也读不出来。
   *
   * 并发调用只发一次请求。 */
  let pending = null
  function ensureLoaded() {
    if (loaded.value) return Promise.resolve()
    if (!pending) pending = load().finally(() => { pending = null })
    return pending
  }
  // store 第一次被某个组件拿到时就发请求(不等 await —— 谁需要谁 await ensureLoaded)
  ensureLoaded()

  /** 改开关 / 档位（写主进程的 safety.json，并同步本地镜像）
   *  —— **不需要**重查列表: 记录的 unsafe 标记没变, 只是这里的 on/level 变了,
   *  卡片上的 computed 自己会重算。 */
  async function set(patch) {
    apply(await call('safety:set', patch || {}))
  }

  async function loadText() {
    const r = await call('safety:text')
    return r?.text || ''
  }

  /* 下面两个是**改集合**（不只是切档位），所以多一步:
   * 主进程会重算所有记录的 unsafe 标记, 而渲染层手里是上一次查询的副本 ——
   * 得让各视图重查一次才拿得到新标记(不会重载数据集, 只是重跑当前查询)。 */
  async function saveText(text) {
    const r = await call('safety:save', { text })
    apply(r)
    await load()
    useAppStore().bumpEpoch()
    return r
  }

  async function toggleTag(tag, level) {
    const r = await call('safety:toggle', { tag, level })
    await load()
    useAppStore().bumpEpoch()
    return r
  }

  /** 当前档位下会隐藏的张数 */
  const hiddenCount = computed(() => (level.value === 'edge' ? edgeHit.value : coreHit.value))
  const hiddenPct = computed(() => (total.value ? (hiddenCount.value / total.value) * 100 : 0))

  /**
   * 一张图的敏感级别 0/1/2。
   *  - 库内记录: 直接用主进程算好的 `unsafe`（读数据集时一次算好，切档只做数值比较）
   *  - 库外图(扫描页): 没有这个字段 -> 用前端镜像规则按它的标签现算
   */
  function unsafeOf(item) {
    if (!item) return 0
    if (typeof item.unsafe === 'number') return item.unsafe
    const tags = item.tags
    if (!Array.isArray(tags) || !tags.length) return 0
    const hit = tagsMemo.get(tags)
    if (hit && hit.gen === gen) return hit.u
    const u = unsafeOfTags(tags, matcher.value)
    tagsMemo.set(tags, { gen, u })
    return u
  }

  /** 一张图在当前设置下是否该隐藏；卡片/视图都调它 */
  function isHidden(item) {
    if (!on.value || !item) return false
    return hiddenBySafety(unsafeOf(item), level.value)
  }

  /**
   * 过滤一个列表。**关闭时原样返回同一个数组引用**（不是副本）——
   * 各视图把它包在 computed 里，返回同一引用才不会被下游误判成"数据变了"。
   */
  function filterItems(list) {
    const arr = Array.isArray(list) ? list : []
    if (!on.value || !arr.length) return arr
    return arr.filter((it) => !isHidden(it))
  }

  /**
   * 一个列表里**两档各会隐藏多少张** → `{ core, edge }`。
   *
   * 与 `filterItems` 的关键区别：**不看 `on`**。开关关着也算 —— 这正是用户要的
   * "我还没打开这个开关的时候，也应该看得到打开会少多少张"（以前关掉时开关上的
   * 数字直接消失，看着就像 0）。口径与主进程的 coreHit/edgeHit 逐字一致：
   *   · core = 只命中 core 段的条数（core 档会藏这么多）
   *   · edge = edge 档会藏的总数（= core + 仅命中 edge 的，因为 core 段在 edge 档也藏）
   *
   * 一次遍历同时出两个数：切档位时不用重算（视图里把它包 computed，只有列表
   * 引用变 / 规则变才重跑）。判定走 `unsafeOf` —— 库内记录是数值直读，
   * 库外图（扫描页/收藏快照）才现算标签，且有 WeakMap 记忆。
   */
  function countHits(list) {
    return countHitsOf(list, unsafeOf)
  }

  return {
    on, level, coreHit, edgeHit, total, core, edge, loaded,
    load, ensureLoaded, set, loadText, saveText, toggleTag, hiddenCount, hiddenPct,
    isHidden, unsafeOf, filterItems, countHits,
  }
})
