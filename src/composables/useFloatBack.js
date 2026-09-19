/**
 * 浮动导航「返回上一页」的智能分发
 * ==================================
 * 有些页面的层级是组件内部状态, 不走路由(如扫描页: 文件夹列表 -> 图片网格
 * 是同一个 /scan 里的 level 切换)。这种页面对 history.back() 来说是透明的 ——
 * 按返回会跳过列表直接回到上一个路由(首页), 不是用户期望的「回到上一级」。
 *
 * 各视图用 useFloatBack 注册一个处理器: 返回 true = "这一步我来处理了",
 * 浮动导航就不再 router.back(); 都不处理才走路由回退。
 * 后挂载的视图先被询问(栈顶优先), 组件卸载自动注销。
 */
import { onMounted, onBeforeUnmount } from 'vue'

const stack = []

export function useFloatBack(handler) {
  onMounted(() => stack.push(handler))
  onBeforeUnmount(() => {
    const i = stack.indexOf(handler)
    if (i >= 0) stack.splice(i, 1)
  })
}

/** 依次询问处理器; 有接手的返回 true, 全都不接返回 false */
export function runFloatBack() {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]()) return true
    } catch (e) {
      console.warn('[fnav] handler error:', e)
    }
  }
  return false
}
