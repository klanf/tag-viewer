/**
 * 删除图片(移入系统回收站) —— 右键菜单 / Del 键 / 光箱共用的入口
 * ==============================================================
 * 流程: request(paths)
 *   -> prefs.trashAsk ? 弹确认框(可勾「不再询问」) : 直接执行
 *   -> api.trashImages  主进程 shell.trashItem(系统回收站, 可还原) + 作废扫描缓存
 *   -> 广播 'tv:trashed' 自定义事件, 各视图自己把图从列表里剔除。
 * 确认弹窗本体是 TvTrashConfirm.vue(挂在 App.vue 的全局单例)。
 *
 * state 是模块级单例 —— 弹窗组件与各调用方看到的是同一份。
 */
import { reactive } from 'vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'

const state = reactive({
  open: false,
  paths: [],
  noAsk: false,
  _resolve: null,
})

async function execute(list) {
  const ui = useUiStore()
  try {
    const r = await api.trashImages(list)
    const trashed = r?.trashed || []
    if (r?.failed?.length) ui.err(`${r.failed.length} 张删除失败(文件可能被占用)`, 3600)
    if (trashed.length) {
      ui.ok(`🗑 已把 ${trashed.length} 张图移入回收站`)
      // 收藏记录**保留**(2026-09-19 用户拍板): 文件进回收站但收藏不摘,
      // 收藏页上标灰"文件已不在"; 万一从回收站还原, 收藏还在。
      // 通知各视图剔除网格/光箱里的这张图
      window.dispatchEvent(new CustomEvent('tv:trashed', { detail: { paths: trashed } }))
    }
    return trashed
  } catch (e) {
    ui.err('删除失败: ' + e.message)
    return []
  }
}

export function useTrash() {
  /** 请求删除。返回 Promise<string[]>: 实际删掉的路径(取消/全失败 = []) */
  function request(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
    if (!list.length) return Promise.resolve([])
    const prefs = usePrefsStore()
    if (!prefs.trashAsk) return execute(list)
    return new Promise((resolve) => {
      state.paths = list
      state.noAsk = false
      state.open = true
      state._resolve = resolve
    })
  }

  /** 确认弹窗点了「删除」 */
  function confirm() {
    state.open = false
    const resolve = state._resolve
    state._resolve = null
    const list = [...state.paths]
    if (state.noAsk) {
      const prefs = usePrefsStore()
      prefs.trashAsk = false
    }
    resolve?.(execute(list))
  }

  /** 确认弹窗点了「取消」/ Esc / 关闭 */
  function cancel() {
    state.open = false
    state._resolve?.([])
    state._resolve = null
  }

  return { state, request, confirm, cancel }
}
