/**
 * 图片右键菜单 —— 网格卡片与大图预览共用的封装
 * ==============================================
 * 菜单本体是主进程弹的原生 Menu(见 ipc.js 的 app:ctxMenu),
 * 剪贴板 / 资源管理器 / 系统查看器那些动作主进程直接干完;
 * 这里接手渲染层才能干的事: 切换收藏 / 删除到回收站(确认弹窗)。
 */
import { api } from '@/utils/api.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useTrash } from '@/composables/useTrash.js'
import { basename } from '@/utils/format.js'

export function useImageCtxMenu() {
  const fav = useFavStore()
  const ui = useUiStore()
  const trash = useTrash()

  /**
   * @param {MouseEvent} e  原生 contextmenu 事件(内部会 preventDefault)
   * @param {{path: string, tags?: string[], name?: string,
   *          favable?: boolean, favorited?: boolean}} ctx
   *
   * 注意: 这里**不负责**推进大图预览。删除/移动成功后只广播
   * 'tv:trashed' / 'tv:moved', 由 useLightboxStore 订阅这两个事件来决定
   * 光箱是前进还是关闭 —— 网格卡片和大图预览共用这一个出口, 不要再加
   * 一个 "当前在光箱里" 的开关参数(以前那个 inLightbox 就是这么来的, 传了没人读)。
   */
  async function open(e, ctx) {
    if (!ctx?.path) return
    e.preventDefault()
    try {
      const r = await api.ctxMenu({
        path: ctx.path,
        name: ctx.name || basename(ctx.path),
        tags: Array.isArray(ctx.tags) && ctx.tags.length ? ctx.tags.join(', ') : '',
        favable: !!ctx.favable,
        favorited: !!ctx.favorited,
      })
      const action = r?.action
      if (action === 'toggle-fav') {
        const added = fav.toggle(ctx.path, Array.isArray(ctx.tags) ? ctx.tags : [], ctx)
        ui.ok(added ? '★ 已收藏' : '已取消收藏', 'ok', 1200)
      } else if (action === 'trash') {
        // 删除到回收站: 确认弹窗(useTrash)负责, 删完 'tv:trashed' 事件通知各视图
        await trash.request([ctx.path])
      } else if (action === 'moved') {
        // 主进程已把文件移走并作废扫描缓存; 这里同步 UI:
        // 收藏**改写**到新位置(原来这里是把记录摘掉 —— 用户每次移动都丢收藏, 2026-09-19 修);
        // 广播 'tv:moved' 让各视图把图从列表里剔除
        const dest = r.result?.name || ''
        ui.ok(`📤 已移动到 ${dest}`, 'ok', 2400)
        fav.onMoved(ctx.path, r.result?.dest || '')
        window.dispatchEvent(new CustomEvent('tv:moved', {
          detail: { paths: [ctx.path], dest: r.result?.dest || '' },
        }))
      } else if (action === 'move-failed') {
        ui.err('移动失败: ' + (r.result?.error || '未知原因'), 3600)
      } else if (action === 'quick-added') {
        ui.ok(`已保存预设文件夹: ${r.result?.name || ''}`, 'ok', 2400)
      } else if (action === 'quick-exists') {
        ui.err(r.result?.error || '文件夹已在预设里', 2400)
      } else if (action === 'copy-image') {
        // 主进程已经把像素写完了(过程中推的「正在复制图像…」在 app:toast 那条路上)。
        // 成败都必须报出来: 以前这里什么都不做, 而主进程那行 clipboard.writeImage
        // 抛的 TypeError 被空 catch 吃掉 ⇒ 用户点了完全没反应(2026-09-24 修)。
        const res = r.result || {}
        if (res.ok) {
          const secs = res.totalMs >= 1000 ? `（${(res.totalMs / 1000).toFixed(1)}s）` : ''
          ui.ok(`📋 已复制图像 ${res.width}×${res.height}${secs}`, 'ok', 2400)
        } else {
          ui.err('复制图像失败: ' + (res.error || '未知原因'), 4600)
        }
      } else if (action === 'copied') {
        // 复制到(2026-10-16 新增): 原文件不动, 副本落在新位置 —— 不剔除卡片、不广播
        ui.ok(`📋 已复制到 ${r.result?.name || ''}`, 'ok', 2400)
      } else if (action === 'copy-failed') {
        ui.err('复制失败: ' + (r.result?.error || '未知原因'), 3600)
      } else if (action === 'open-with') {
        // 成功了不打扰(对话框自己会弹出来); 只报失败, 免得"点了没反应"
        if (!r.result?.ok) ui.err(r.result?.error || '调不出「打开方式」', 3600)
      }
    } catch (err) {
      // console.error 会被主进程转发进 logs/launch.log([render] 行), 方便排查
      console.error('[ctxMenu] 右键菜单失败:', err)
      ui.err('右键菜单失败: ' + err.message)
    }
  }

  return { open }
}
