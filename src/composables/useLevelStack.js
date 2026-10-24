/**
 * 来源页「就地叠一层」的层级栈 —— 看板 / 系列 / 扫描三页共用
 * ========================================================
 * 在某一层的图集光箱里点标签(或系列药丸)时不换路由、不切 tab, 而是在当前页
 * 往上叠一层; 每层各存一份「打开这一层时的光箱现场(哪张图 + 翻页列表)」,
 * 左上角返回箭头只退一层并把那一层的光箱原样拉回来。
 *
 * 层的三种 kind:
 *   tag    —— 该标签的图片(TagImagesPanel)
 *   series —— 该系列的角色列表(TvSeriesCharsPanel), 点角色再往上叠一层 tag
 *   meta   —— 库内命中相似图(MetaHitsPanel), 源图路径记在 lv.meta 上
 *
 * meta 层是 2026-10-24 用户报「从扫描的叠层里点库内命中, 返回直接回文件夹、
 * 路径全丢」后补的: 之前走路由跳 /meta-hits, ScanView 会被卸载, 整栈跟着没了。
 * 现在与 tag/series 一样就地摊开 —— 路径接一层, 返回只退一层并恢复光箱。
 *
 * 之前这套逻辑在看板/系列/扫描里各抄了一遍(那份只能装 tag 层)。系列层要装
 * 第三种面板, 三份一起改更容易漏, 所以搬成一个 composable。
 */
import { ref, computed, nextTick } from 'vue'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

export function useLevelStack(options = {}) {
  /** 系列层的路径栏文案: 有中文名的宿主可以传 (name) => 中文名 */
  const seriesLabel = options.seriesLabel || ((name) => String(name || ''))
  const lb = useLightboxStore()
  let seq = 0
  /** @type {import('vue').Ref<Array<{id:number, kind:'tag'|'series'|'meta', tag?:string, series?:string, meta?:string, from:{imgPath:string,list:string[]|null}|null}>>} */
  const levels = ref([])
  const topLevel = computed(() => levels.value[levels.value.length - 1] || null)
  const curTag = computed(() => (topLevel.value?.kind === 'tag' ? topLevel.value.tag : ''))
  const curSeries = computed(() => (topLevel.value?.kind === 'series' ? topLevel.value.series : ''))
  const curMeta = computed(() => (topLevel.value?.kind === 'meta' ? topLevel.value.meta : ''))

  function push(kind, key) {
    if (!key) return
    levels.value.push({
      id: ++seq,
      kind,
      [kind]: String(key),
      /* 光箱此刻还开着(药丸是先叫宿主、再 close): 记下这一层返回时要恢复的图和翻页列表 */
      from: lb.path ? { imgPath: lb.path, list: lb.list.length > 1 ? [...lb.list] : null } : null,
    })
  }
  const openTagPage = (tag) => push('tag', tag)
  const openSeriesPage = (series) => push('series', series)
  /** 光箱「库内命中」徽章: 就地叠一层相似图页(源图路径) */
  const openMetaPage = (src) => push('meta', src)

  function restoreFrom(lv) {
    const f = lv?.from
    if (!f?.imgPath) return
    /* 等这一层收起、来源网格渲染回来再开, 不然光箱会被同一帧的渲染盖住 */
    nextTick(() => lb.open(f.imgPath, { list: f.list || [f.imgPath] }))
  }
  /** 返回箭头: 退一层并恢复开那一层时的光箱 */
  function backOneLevel() {
    restoreFrom(levels.value.pop())
  }
  /** 点祖先 crumb: 直接回到那一层, 不恢复光箱 */
  function goLevel(i) {
    if (i < 0 || i >= levels.value.length - 1) return
    levels.value.splice(i + 1)
  }
  /** 回到第一层打开时的光箱(系列/扫描页点角色·文件夹 crumb 用) */
  function backToRoot() {
    const first = levels.value[0]
    levels.value = []
    restoreFrom(first)
  }
  /** 回根页: 整栈清空, 不恢复光箱 */
  function clearLevels() { levels.value = [] }
  /** 当前层的标签被删除: 只收起这一层, 不恢复光箱 */
  function popLevel() { levels.value.pop() }
  /** 当前层改了标签名: 只换栈顶, 路径栏跟着变 */
  function renameTopLevel(tag) {
    if (topLevel.value?.kind === 'tag') topLevel.value.tag = String(tag)
  }

  /** 栈里各层对应的面包屑: 栈顶不能点(带复制), 祖先层点了直接跳过去 */
  function levelCrumbs(stack) {
    return stack.map((lv, i) => {
      const last = i === stack.length - 1
      let base
      if (lv.kind === 'meta') {
        base = { label: '库内命中相似图' }
      } else if (lv.kind === 'series') {
        const label = seriesLabel(lv.series)
        // 中文名当主文字、tag 本体留在小字与 📋 上 —— 与系列页那条 crumb 同一套写法,
        // 也让"这一层到底是哪个系列"在路径栏里一眼可认(测试也按这个核对)
        base = { label, sub: label === lv.series ? '' : lv.series, copy: lv.series, copyLabel: '系列名' }
      } else {
        base = { label: lv.tag, copy: lv.tag, copyLabel: '标签名' }
      }
      return last ? base : { ...base, onClick: () => goLevel(i), back: backOneLevel }
    })
  }

  return {
    levels, topLevel, curTag, curSeries, curMeta,
    openTagPage, openSeriesPage, openMetaPage,
    restoreFrom, backOneLevel, goLevel, backToRoot, clearLevels, popLevel, renameTopLevel,
    levelCrumbs,
  }
}
