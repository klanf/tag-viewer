/**
 * 路径栏状态 —— 每个"页面"把自己当前的层级写进来, TvPathBar 只显示当前路由那一份
 * =====================================================================
 * 为什么不用路由: 系列/扫描/tag 次级页是组件内部状态(不产生 history),
 * 路由里没有它们; 但路径栏要能显示「全部系列 > 系列 > 角色 > tag」。
 * 键用路由名: 留在 KeepAlive 里的页面各存一份, 切回来还是它离开时的层级;
 * 顶栏返回按钮也靠 has() 判断"这一页已经有路径栏了", 避免两个返回箭头。
 *
 * crumb 结构:
 *   { label, sub?, copy?, copyLabel?, onClick? }
 *   label   当前显示文字(系列显示中文, 没有中文就用英文)
 *   sub     跟在后面的浅色小字(系列英文名)
 *   copy    有值就显示 📋, 点了复制这段文字
 *   onClick 父级 crumb 的点击动作; 路径箭头也调用倒数第二级的 onClick
 *   back    可选: 只覆盖路径箭头的动作(父级 crumb 点击仍走 onClick) ——
 *           独立标签页的 parent 是「全部标签」, 箭头却要沿用旧的智能返回
 */
import { reactive } from 'vue'

const paths = reactive({})

export function usePathStore() {
  function set(owner, crumbs) {
    paths[owner] = Array.isArray(crumbs) ? crumbs : []
  }
  function clear(owner) {
    delete paths[owner]
  }
  function has(owner) {
    return Array.isArray(paths[owner]) && paths[owner].length > 0
  }
  return { paths, set, clear, has }
}
