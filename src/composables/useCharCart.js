/**
 * 角色标签 ⇄ 购物车 的公共入口
 * ============================
 * 光箱的角色 pill / 详情页标签列表的角色 pill 都挂 🛒, 两处共用这一份逻辑。
 *
 * 购物车条目原本来自系列浏览页(有完整的 name/series/thumb), 从标签进来时只能
 * 尽力补齐:
 *   · tag     = 完整角色标签(`saori_(blue_archive)` 这种), 与系列页同键, 两边互通
 *   · series  = 从标签的 _(xx) 尾巴提取; 没尾巴的裸角色名给空串
 *   · name    = 优先中文翻译(详情页/光箱都查过 zhMap), 没有就用去尾巴的英文名
 */
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { stripZhSeries } from '@/utils/format.js'

export function useCharCart() {
  const cart = useCartStore()
  const ui = useUiStore()

  function toggle(tag, zh = '') {
    const m = tag.match(/_\((.+)\)$/)
    // zh 形如「莉央(blue_archive)」, 剥掉系列尾巴再入车, 购物车条目名才干净
    const name = stripZhSeries(zh) || tag.replace(/_\(.+\)$/, '')
    const added = cart.toggle({ tag, name }, m ? m[1] : '')
    ui.ok(added ? `🛒 已加入购物车: ${name}` : `已移出购物车: ${name}`, 'info', 1600)
  }

  return { cart, toggle }
}
