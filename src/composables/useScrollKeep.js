/**
 * 「切走再切回, 停在离开时的地方」—— KeepAlive 视图共用
 * ====================================================
 * DOM 被 KeepAlive 摘下来再插回去, 滚动层的 scrollTop 会归零, 用户回来只能从头顶重新看。
 * 存的时刻**必须**用路由离开守卫: onDeactivated 触发时元素已经离开 document,
 * querySelector 扑空(扫描页 2026-09-19 就是这么踩的, 那边至今自己存)。
 *
 * 回到本页时先滚到「上次看到这张」(光箱留下的红框那张) —— 那才是用户要找的位置;
 * 这一页没有那张(比如他是在扫描页看的图)才退回离开时的滚动位置。
 */
import { nextTick, onActivated } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

/** @param {string} sel 这一页真正在滚的那个容器的选择器 */
export function useScrollKeep(sel) {
  const lb = useLightboxStore()
  let saved = 0
  /* 叠层改成"全挂载 + 只露栈顶"之后, 同一选择器会命中好几个(底层 + 每一层各一个):
     只认当前**看得见**的那一个, 不然存/滚的都是藏在底下的第一层(2026-10-24)。
     display:none 的子树 offsetParent 为 null, 正好当判据。 */
  const box = () => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null)
  onBeforeRouteLeave(() => {
    const b = box()
    if (b) saved = b.scrollTop
  })
  onActivated(() => {
    nextTick(() => {
      if (lb.revealLastViewed()) return
      const b = box()
      if (b && saved) b.scrollTo({ top: saved })
    })
  })
  return { scrollTop: () => saved }
}
