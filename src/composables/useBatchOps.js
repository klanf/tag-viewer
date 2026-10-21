/**
 * 图片批量操作(选择模式) —— 看板 / 标签图片页 / 系列图片层共用(2026-10-21)
 * ====================================================================
 * 交互与扫描页的选择模式逐条对齐(别改语义, 用户已经习惯了):
 *   · 工具栏「选择」进出; 选择模式下点击=勾选, Shift=区间选(按当前排序)
 *   · Ctrl+点击在浏览状态下也能直接勾(顺手进入选择模式)
 *   · Ctrl+A 全选 / Esc 退出 / Del 批量删除(onKey 由调用方挂 window,
 *     并自己判断"本页是否激活" —— 这几个视图都在 KeepAlive 白名单里)
 *   · 选择集按 path 记, 排序/筛选变化不影响已勾的
 *
 * 与扫描页(ScanView)的关系: 那边与 justified rows / 文件夹统计对账 / 路由守卫
 * 纠缠较深, 本轮没动 —— 这份是提炼出来的独立版, 后端出口完全一致
 * (image:moveMany / image:copyMany / useTrash), 联动共用同一对全局广播
 * ('tv:trashed' / 'tv:moved' -> useImageFeed 剔卡 + 光箱前进), 别再加一套。
 *
 * @param {Object} opts
 * @param {Function} opts.items     () => 当前网格渲染的条目数组(供 Shift 区间选/
 *                                    全选/反选), 元素要有 .path —— 传网格实际
 *                                    用的那份(含安全模式过滤后的), 区间选才和
 *                                    视觉顺序一致
 * @param {Function} opts.openImage (item) => 浏览模式下点卡片的动作(通常是开光箱)
 */
import { ref } from 'vue'
import { api } from '@/utils/api.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useTrash } from '@/composables/useTrash.js'

export function useBatchOps({ items, openImage }) {
  const ui = useUiStore()
  const fav = useFavStore()
  const trash = useTrash()
  const lb = useLightboxStore()

  const selectMode = ref(false)
  const selected = ref(new Set())     // path 集合
  const moving = ref(false)           // 批量移动进行中(锁弹窗与按钮)
  const copying = ref(false)          // 批量复制进行中
  const moveOpen = ref(false)         // 「移动到」目标选择弹窗
  const copyOpen = ref(false)         // 「复制到」目标选择弹窗
  const folders = ref([])             // MoveTargetModal 的登记文件夹(打开弹窗时懒加载)
  let lastSelIdx = -1                 // Shift 区间选的锚点(当前排序里的下标)

  function listOf() {
    const a = typeof items === 'function' ? items() : (items?.value || [])
    return Array.isArray(a) ? a : []
  }

  function toggleSelectMode() {
    selectMode.value = !selectMode.value
    if (!selectMode.value) clearSel()
    ui.toast(selectMode.value ? '☑ 选择模式: 点击勾选, Shift 区间, Ctrl+A 全选, Esc 退出' : '已退出选择模式', 'info', 1800)
  }

  function toggleSelect(it, ev) {
    const idx = listOf().findIndex((x) => x.path === it.path)
    if (ev?.shiftKey && lastSelIdx >= 0 && idx >= 0) {
      rangeTo(idx)
    } else {
      const s = new Set(selected.value)
      if (s.has(it.path)) s.delete(it.path)
      else s.add(it.path)
      selected.value = s
      lastSelIdx = idx
    }
  }

  /** 锚点 -> idx 的区间全部并入选中集(按当前排序; 卡片主体与勾选框共用) */
  function rangeTo(idx) {
    const [a, b] = lastSelIdx < idx ? [lastSelIdx, idx] : [idx, lastSelIdx]
    const s = new Set(selected.value)
    const list = listOf()
    for (let i = a; i <= b; i++) if (list[i]?.path) s.add(list[i].path)
    selected.value = s
  }

  function selectAll() {
    selected.value = new Set(listOf().map((it) => it.path).filter(Boolean))
  }

  function invertSel() {
    const s = new Set()
    for (const it of listOf()) if (it.path && !selected.value.has(it.path)) s.add(it.path)
    selected.value = s
  }

  function clearSel() {
    selected.value = new Set()
    lastSelIdx = -1
  }

  /** 卡片点击的唯一入口(TvImageCard/TvImageGrid @open 会把原生事件带出来):
   *  选择模式里点击=勾选(Shift=区间) / 浏览模式里 Ctrl=勾选并顺手进入选择模式。 */
  function onCardClick(it, ev) {
    if (selectMode.value) {
      toggleSelect(it, ev)
      return
    }
    if (ev && (ev.ctrlKey || ev.metaKey)) {
      selectMode.value = true
      toggleSelect(it, ev)
      return
    }
    openImage?.(it)
  }

  /* ---------------- 批量删除(复用 useTrash: 确认弹窗显示 N 张, tv:trashed 联动剔卡) ---------------- */
  function batchDelete() {
    const paths = [...selected.value]
    if (!paths.length) return
    trash.request(paths).then((trashedList) => {
      // 删成的从选择集里摘掉, 失败的留着可以再试
      const done = new Set(trashedList || [])
      selected.value = new Set([...selected.value].filter((p) => !done.has(p)))
    })
  }

  /* ---------------- 弹窗目标数据: 登记文件夹懒加载(预设/其他位置由弹窗自己拉) ---------------- */
  async function ensureFolders() {
    if (folders.value.length) return
    try {
      const d = await api.folders()
      folders.value = d.folders || []
    } catch { /* 拉不到也不挡弹窗 —— 里面还有预设和「其他位置」两条路 */ }
  }

  function openMove() {
    if (!selected.value.size) { ui.warn('先勾选至少一张图'); return }
    ensureFolders()
    moveOpen.value = true
  }

  function openCopy() {
    if (!selected.value.size) { ui.warn('先勾选至少一张图'); return }
    ensureFolders()
    copyOpen.value = true
  }

  /* ---------------- 批量移动 ----------------
   * 库内图: 后端「移动=改址」自动改 path/folder_id, 标签跟图走;
   * 库外图(扫描缓存里的): 文件照搬、扫描缓存作废, 库记录不动 —— 与扫描页同款语义。 */
  async function doMove(target) {
    if (!target?.path || moving.value) return
    const paths = [...selected.value]
    moving.value = true
    try {
      const r = await api.moveImages(paths, target.path)
      if (r?.error) { ui.err('移动失败: ' + r.error); return }
      const movedFrom = (r.moved || []).map((m) => m.from)
      // 收藏跟随改写到新位置(与右键单张移动同款), 失败的不动
      for (const m of r.moved || []) fav.onMoved(m.from, m.to)
      if (movedFrom.length) {
        // 广播 tv:moved: useImageFeed 把卡从网格剔除, 光箱把翻页序列同步掉
        window.dispatchEvent(new CustomEvent('tv:moved', { detail: { paths: movedFrom, dest: r.dest || '' } }))
      }
      if (r.failed?.length) ui.err(`${r.failed.length} 张移动失败(${r.failed[0]?.error || '未知原因'})`, 3600)
      if (movedFrom.length) ui.ok(`📤 已移动 ${movedFrom.length} 张到「${r.destName}」`, 'ok', 2600)
      if (r.sync?.started) ui.toast('后台正在把新位置入库并排队反推…', 'info', 2600)
      // 失败的留在选择集里, 成功的清掉; 弹窗关掉
      selected.value = new Set((r.failed || []).map((x) => x.path))
      moveOpen.value = false
    } catch (e) {
      ui.err('移动失败: ' + e.message)
    } finally {
      moving.value = false
    }
  }

  /* ---------------- 批量复制(原文件不动, 副本落目标目录; 不剔卡不改库) ---------------- */
  async function doCopy(target) {
    if (!target?.path || copying.value) return
    const paths = [...selected.value]
    copying.value = true
    try {
      const r = await api.copyImages(paths, target.path)
      if (r?.error) { ui.err('复制失败: ' + r.error); return }
      const done = (r.moved || []).length
      if (r.failed?.length) ui.err(`${r.failed.length} 张复制失败(${r.failed[0]?.error || '未知原因'})`, 3600)
      if (done) ui.ok(`📋 已复制 ${done} 张到「${r.destName}」`, 'ok', 2600)
      // 复制完就取消选中(与扫描页同款语义: 失败的留着可重试)
      selected.value = new Set((r.failed || []).map((x) => x.path))
      copyOpen.value = false
    } catch (e) {
      ui.err('复制失败: ' + e.message)
    } finally {
      copying.value = false
    }
  }

  /** Ctrl+A 全选 / Esc 退出 / Del 批量删除。
   *  调用方负责挂/卸 window 监听与"本页是否激活"的守卫(KeepAlive);
   *  这里只挡光箱/弹窗开着、非选择模式、以及焦点在输入框里的情况 ——
   *  看板的搜索框是高频输入区, Ctrl+A 全选文字不能被抢。 */
  function onKey(e) {
    if (lb.visible || moveOpen.value || copyOpen.value) return
    if (!selectMode.value) return
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const k = e.key?.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && k === 'a') {
      e.preventDefault()
      selectAll()
    } else if (e.key === 'Escape') {
      selectMode.value = false
      clearSel()
    } else if (e.key === 'Delete') {
      batchDelete()
    }
  }

  return {
    selectMode, selected, moving, copying, moveOpen, copyOpen, folders,
    toggleSelectMode, toggleSelect, selectAll, invertSel, clearSel,
    onCardClick, batchDelete, openMove, openCopy, doMove, doCopy, onKey,
  }
}
