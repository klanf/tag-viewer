/**
 * 用户偏好(跨页面共享)
 *  - bg_auto: 「缺背景时补背景标签」开关, 导出/复制都跟着它走
 *  - pageSize: 图片网格每页数量
 * 键名统一 `tv_*`(见 utils/lskey.js); 旧版的 tagviewer_* 会在第一次读到时
 * 自动搬到新键, 所以用户之前的选择不会丢。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { LS, readLS, writeLS } from '@/utils/lskey.js'

export const usePrefsStore = defineStore('prefs', () => {
  const bgAuto = ref(readLS(LS.bgAuto.key, LS.bgAuto.old) !== '0')          // 默认开
  const gridPageSize = ref(60)
  const trashAsk = ref(readLS(LS.trashAsk.key, LS.trashAsk.old) !== '0')    // 默认每次删除前询问
  /**
   * 系列页「显示无本地图的角色」(2026-10-06) —— 默认关。
   * 开着时角色列表(和系列列表的角色数统计)会带上 danbooru 补全的 0 图角色,
   * 这些角色可以入购物车但没有图可看; 默认关是为了列表干净、口径与旧版一致。
   */
  const seriesShowZero = ref(readLS(LS.seriesShowZero.key) === '1')
  /**
   * 批量拉封面「只要单人图(solo)」(2026-10-22) —— 默认**开**。
   * 群像/对打图当角色封面经常认不出是谁, 用户点名要默认带上; 关掉的选择也记住,
   * 下次不会又自己打开。
   */
  const coverSolo = ref(readLS(LS.coverSolo.key) !== '0')

  watch(bgAuto, (v) => writeLS(LS.bgAuto.key, v ? '1' : '0'))
  watch(trashAsk, (v) => writeLS(LS.trashAsk.key, v ? '1' : '0'))
  watch(seriesShowZero, (v) => writeLS(LS.seriesShowZero.key, v ? '1' : '0'))
  watch(coverSolo, (v) => writeLS(LS.coverSolo.key, v ? '1' : '0'))

  /**
   * 光箱「复制标签」的过滤配置(2026-10-19) —— JSON 存 localStorage, 读时过白名单。
   * ban/char/view/safe/replace 五个开关 + safe_level 口径 + replace_set 规则组。
   * 默认 = 旧「全部标签」模式: 只剔角色/系列, 其余全关(行为与改造前一致)。
   */
  const COPY_DEF = Object.freeze({
    ban: false, char: true, view: false, safe: false, safe_level: 'follow', replace: false, replace_set: '',
  })
  function readCopyFilters() {
    const raw = readLS(LS.lbCopyFilters.key)
    if (!raw) return { ...COPY_DEF }
    try {
      const o = JSON.parse(raw) || {}
      return {
        ban: o.ban === true,
        char: o.char !== false,
        view: o.view === true,
        safe: o.safe === true,
        safe_level: ['follow', 'core', 'edge'].includes(o.safe_level) ? o.safe_level : 'follow',
        replace: o.replace === true,
        replace_set: typeof o.replace_set === 'string' ? o.replace_set : '',
      }
    } catch { return { ...COPY_DEF } }
  }
  const lbCopyFilters = ref(readCopyFilters())
  watch(lbCopyFilters, (v) => writeLS(LS.lbCopyFilters.key, JSON.stringify(v)), { deep: true })

  /**
   * 排序记忆 —— 每个页面各记各的(见 utils/lskey.js 的 sort* 说明)。
   * 取值一律**过白名单**: localStorage 是用户能随手改的地方, 存进去一个视图不认的值
   * 会让排序静默失效(而且很难看出是"记住了个坏值"), 所以认不出来的就回落默认。
   */
  const SORT_OK = {
    sortHome: ['random', 'path', 'time'],
    sortScan: ['name', 'name_desc', 'folder', 'time_desc', 'time_asc', 'size_desc', 'size_asc', 'tags_desc'],
    sortSeries: ['path', 'time', 'random'],
    sortTagImgs: ['path', 'time', 'random'],
    sortSeriesChars: ['name', 'name_desc', 'images', 'images_asc'],
  }
  function pickSort(key, def) {
    const v = readLS(LS[key].key)
    return SORT_OK[key].includes(v) ? v : def
  }
  const sortHome = ref(pickSort('sortHome', 'random'))
  const sortScan = ref(pickSort('sortScan', 'name'))
  const sortSeries = ref(pickSort('sortSeries', 'path'))
  const sortTagImgs = ref(pickSort('sortTagImgs', 'path'))
  const sortSeriesChars = ref(pickSort('sortSeriesChars', 'name'))
  watch(sortHome, (v) => writeLS(LS.sortHome.key, v))
  watch(sortScan, (v) => writeLS(LS.sortScan.key, v))
  watch(sortSeries, (v) => writeLS(LS.sortSeries.key, v))
  watch(sortTagImgs, (v) => writeLS(LS.sortTagImgs.key, v))
  watch(sortSeriesChars, (v) => writeLS(LS.sortSeriesChars.key, v))

  /** 系列页图片每页数量 —— 只认 UI 提供的三档, 坏值回落 60 */
  const PAGE_SIZES = [60, 120, 240]
  const storedPageSize = Number(readLS(LS.seriesImgPageSize.key))
  const seriesImgPageSize = ref(PAGE_SIZES.includes(storedPageSize) ? storedPageSize : 60)
  watch(seriesImgPageSize, (v) => writeLS(LS.seriesImgPageSize.key, v))

  /**
   * 勾选状态下且该图缺背景 -> 追加背景补全标签(与导出行为一致)。
   * index / series / tags / cart / detail 五个地方都要用, 所以放在这里。
   */
  function maybeAddBg(list, needsBg, bgAppend) {
    if (!bgAuto.value || !needsBg || !(bgAppend || []).length) return list
    const out = list.slice()
    for (const b of bgAppend) if (!out.includes(b)) out.push(b)
    return out
  }

  return {
    bgAuto, gridPageSize, trashAsk, maybeAddBg, seriesShowZero, lbCopyFilters, coverSolo,
    sortHome, sortScan, sortSeries, sortTagImgs, sortSeriesChars, seriesImgPageSize,
  }
})
