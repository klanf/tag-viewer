<script setup>
/**
 * 图片卡片 —— 首页 / 系列页 / 标签页 / 扫描页共用的网格单元
 * ======================================================
 * 旧版这些卡片在 4 个地方各写了一遍 innerHTML, 差异只有:
 *   - 首页多一个 ☆ 收藏按钮
 *   - 扫描页多一个"来源"角标, 标签区换成 key_tags 高亮角色标签
 *   - 系列/标签页没有收藏按钮
 * 所以这里把「收藏按钮」「角标」「标签渲染方式」都做成可选 props。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TvImage from '../base/TvImage.vue'
import { clipTags, shortPath, ratioOf } from '@/utils/format.js'
import { useImageCtxMenu } from '@/composables/useImageCtxMenu.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'

const props = defineProps({
  /** {path, tags} 或扫描页的 {path, tags, source, key_tags, chars} */
  item: { type: Object, required: true },
  /** 缩略图宽度(200/300/400 三档, 与旧版 .thumb_cache 命名对齐) */
  thumbWidth: { type: Number, default: 400 },
  /** 显示 ☆ 收藏按钮 */
  favable: { type: Boolean, default: false },
  favorited: { type: Boolean, default: false },
  /** 显示右下角来源角标(扫描页用) */
  showSource: { type: Boolean, default: false },
  /** 相似度角标(0~1, 0 = 不渲染) —— 库内命中页用, 其他网格不传即无变化 */
  sim: { type: Number, default: 0 },
  /** 标签展示方式: head=前 N 个 / keys=角色标签高亮 + 独有标签(扫描页) */
  tagMode: { type: String, default: 'head' },
  /** 标签中文映射(可选): keys 模式下有就显示中文, 没有回退英文原文 */
  tagZhMap: { type: Object, default: () => ({}) },
  /** head 模式显示几个 */
  tagLimit: { type: Number, default: 8 },
  /** 卡片底部显示什么: path | name | none */
  footnote: { type: String, default: 'path' },
  /** 悬停气泡里显示几个标签 */
  tipLimit: { type: Number, default: 14 },
  /** 选择模式下的勾选态 */
  selectable: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  /**
   * 「这张卡片随时可以勾」—— 扫描页第十八轮(2026-10-22)重设计的开关。
   * 打开后浏览态也会渲染勾选框(hover 才显形, 平时不糊满屏), 点它就由父组件决定
   * 干什么(扫描页 = 顺手进选择模式并勾上这一张), 同时启用长按卡片进选择模式。
   * 默认关: 首页/系列/标签/收藏那几个网格行为一字不变。
   */
  pickable: { type: Boolean, default: false },
  /**
   * 自适应行高网格(justified rows)里使用。
   * 那种布局下**高度由容器给**(每个单元格上的 `--img-h` = 这一行的行高), 所以图不能再
   * 自己声明 aspect-ratio, 否则两个高度会打架 —— 传 'auto' 就是"不设比例约束"。
   * 宽度仍由单元格宽度决定, 而那个宽度本来就是"行高 × 宽高比"算出来的, 于是图一张不裁。
   */
  fill: { type: Boolean, default: false },
})
const emit = defineEmits(['open', 'toggle-fav', 'toggle-select', 'long-press', 'hover', 'move', 'leave'])

const path = computed(() => props.item.path || '')

/**
 * 图片区显示比例 —— 按**图片真实像素比**渲染(2026-09-23)。
 *
 * 原来这里一律 9/16 + `object-fit: cover`, 横图会被裁成竖条。实测用户库里
 * 横图占一半(壁纸那几个来源一万四千多张全是横的), 不是边角情况。
 *
 * 尺寸来自 DB 的 px_w/px_h(ingest 读文件头写入), 所以**是渲染前就知道的**,
 * 不存在"等图片加载出来量一下再改比例"那种首帧跳动。还拿不到尺寸的行
 * (老库没回填 / 文件读不到) 回落到 '9 / 16' —— 与改动前完全一致。
 *
 * 用不上新 prop: item 里已经带着尺寸, 首页/系列/标签/扫描四个网格一行都不用改,
 * 跟「上次看过的高亮框」那条一样, 以后新视图只要用这张卡片就自动带上。
 */
const ratio = computed(() => ratioOf(props.item.px_w, props.item.px_h) || '9 / 16')

/** 失效收藏: prop 显式传, 或数据里带 _missing 标记(网格不用加新的透传 prop) */
const isMissing = computed(() => props.missing || !!props.item._missing)

/* 上次在光箱里看过的那张 -> 红色呼吸框(跟随光箱翻页实时移动, 关掉后保留)。
 * 直接读光箱 store 而不是加 prop: 首页/系列/标签/扫描四个网格一行都不用改,
 * 以后新视图只要用这张卡片就自动带上这个行为。 */
const lb = useLightboxStore()
const isLastViewed = computed(() => !!lb.lastPath && lb.lastPath === path.value)

/* 安全模式: 开启时命中敏感标签的卡片**整个不渲染**。
 * 放在卡片这一层而不是各视图的列表里 —— 首页/系列/标签/扫描/收藏五个网格
 * 一处都不用改, 以后新视图只要用这张卡就自动带上(跟上面那个高亮框同一个思路)。
 * 只影响展示: 数据集、统计数字、库里的一行都不动, 关掉开关立刻全回来。 */
const safety = useSafetyStore()
const hidden = computed(() => safety.isHidden(props.item))

/* 高亮框持久化后的"找回"一步: 应用重启(或翻页/进文件夹后高亮那张第一次被渲染)时,
 * 自动把它滚进视野居中, 然后清掉 scrollPending —— 只滚这一次, 之后不再打扰。
 * 光箱 close() 里的滚动(block:'nearest')负责"关掉就回到原地"; 这里负责
 * "重启/首次渲染时主动找到它"。 */
const rootEl = ref(null)
onMounted(() => {
  if (isLastViewed.value && lb.scrollPending) {
    lb.scrollPending = false
    rootEl.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }
})

/* 卡片悬停提示 = 「点这里会发生什么」的唯一说明书。
 * 扫描页去掉顶部「☑ 选择」按钮后(pickable), 怎么开始批量选图只能靠这一句话讲清,
 * 所以它比其它网格多说两条: 勾选框在哪、长按也行。 */
const hint = computed(() => {
  if (isMissing.value) return '文件已不在原位置 —— 可能把图移走了; 收藏已保留, 打开收藏页时会按文件名自动找回'
  if (props.selectable) return '点击勾选/取消 · Shift 连选上一张到这张'
  if (props.pickable) {
    return `${isLastViewed.value ? '上次看到这张(红色呼吸框) · ' : ''}点击预览大图 · 左上角勾选框或按住 0.5 秒 = 开始批量选择`
  }
  return isLastViewed.value ? '上次看到这张(红色呼吸框) · 点击预览大图与标签' : '点击预览大图与标签'
})

const tags = computed(() => props.item.tags || [])

const tipText = computed(() => {
  const t = tags.value
  if (!t.length) return '(无标签)'
  return clipTags(t, props.tipLimit)
})

/** 扫描页的 key_tags 展示: 角色标签单独着色, 其余是"这张图独有"的内容标签 */
const keyParts = computed(() => {
  const z = (t) => props.tagZhMap[t] || t
  const key = (props.item.key_tags || []).map(z)
  const nChar = (props.item.chars || []).length
  return { head: key.slice(0, nChar).join(', '), rest: key.slice(nChar, nChar + 12).join(', ') }
})

const footText = computed(() => {
  if (props.footnote === 'none') return ''
  if (props.footnote === 'name') return props.item.name || ''
  return shortPath(path.value)
})

/* 来源角标文案(2026-10-20 看板接入): 两类调用方字段名不同 ——
 *   · 扫描页 item.source = 图内元数据来源('comfyui' 等);
 *   · 看板记录 item.source 被「来源名」占用, 元数据来源在 item.imgSrc。
 * 有 imgSrc 字段就用它(看板; '' = 读过没元数据, 不显示), 没有就回退旧的
 * item.source(扫描页等老调用方一行不用改)。 */
const srcBadge = computed(() => (
  props.item.imgSrc !== undefined ? String(props.item.imgSrc || '') : String(props.item.source || '')
))

const hasTags = computed(() => tags.value.length > 0)

/* 右键菜单: 复制图片/标签/路径、打开所在位置、详情页、收藏(主进程弹原生菜单) */
const ctxMenu = useImageCtxMenu()
function onCtx(e) {
  ctxMenu.open(e, {
    path: path.value,
    tags: tags.value,
    name: props.item.name,
    favable: props.favable,
    favorited: props.favorited,
    /* 右键收藏也要带上尺寸 —— 收藏记录没有尺寸的话, 收藏页网格会回落 9/16
       把横图裁成竖条(与扫描页同一个 bug, 2026-09-23) */
    px_w: props.item.px_w,
    px_h: props.item.px_h,
  })
}

/* ---------------- 长按卡片(pickable 网格专属, 2026-10-22) ----------------
 * 为什么要有它: 顶部那颗「☑ 选择」按钮这一轮被去掉了(用户嫌三段横向折返), 于是
 * 「我怎么开始批量选图」变成必须靠现场发现。勾选框要 hover 才显形, 而长按是这个
 * 屏幕上人人都会试的直觉手势 —— 它补的就是那份可发现性。
 *
 * 三条必须做对, 不然会变成"随便点个图就进了选择模式"或者"长按完大图也弹出来了":
 *  · 位移超过 10px 立刻取消 —— 用户在拖动网格/滚动时不该触发;
 *  · 触发后**吞掉紧随其后的那次 click**(标志位 + 兜底定时清除), 否则 mouseup 会
 *    正常派发 click, 走到 @open 就把大图打开了;
 *  · 只认主键(button 0), 右键要继续走系统菜单。
 * 阈值 500ms 是刻意选长的: 比"犹豫一下的正常点击"明显更久, 误触代价才可控。
 *
 * ⚠️ move/up 监听挂在 **window** 上而不是卡片上: 手指按住后往旁边拖(正是"我在滚网格
 * 不是想长按"的那个动作), 指针一旦移出卡片, 卡片自己的 pointermove 就再也收不到了,
 * 取消逻辑会失灵、松手点也接不住 —— 按下那一刻临时挂到 window, 收尾即摘。 */
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10
/** 松手后 click 紧随其后(同一毫秒级), 给这一点点余量纯粹是保险: 万一这次没有 click
 *  (被 pointercancel 吃掉 / 元素刚好被网格移除), 标志位也不能永久挂着。
 * ⚠️ 这个"兜底"必须从**松手那一刻**起算, 不能从长按触发那一刻起算 —— 长按触发后用户
 * 想按多久就按多久, 从 500ms 起算的固定窗口会被"按住 2 秒再松手"直接穿过去:
 *  那时 click 落在标志位早已复位之后, 于是大图被打开、刚勾上的那张还被点掉(实测踩过)。 */
const CLICK_FALLBACK_MS = 350
const pressing = ref(false)
const swallowClick = ref(false)
let lpTimer = null
let lpClear = null
let lpOrigin = null

function onPointerMove(e) {
  if (!lpOrigin) return
  if (Math.abs(e.clientX - lpOrigin.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - lpOrigin.y) > LONG_PRESS_SLOP) lpRelease()
}

/** 手势结束(松手 / 取消 / 拖出门槛 / 组件卸载)。长按**触发**时不叫这个 —— 见 onPointerDown 注释。 */
function lpRelease() {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null }
  pressing.value = false
  lpOrigin = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', lpRelease)
  window.removeEventListener('pointercancel', lpRelease)
  if (swallowClick.value && !lpClear) {
    lpClear = setTimeout(() => { swallowClick.value = false; lpClear = null }, CLICK_FALLBACK_MS)
  }
}

function onPointerDown(e) {
  if (!props.pickable || e.button !== 0) return
  lpRelease()
  swallowClick.value = false     // 新的一次按下: 上一轮"待吞的 click"就此作废
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', lpRelease)
  window.addEventListener('pointercancel', lpRelease)
  lpOrigin = { x: e.clientX, y: e.clientY }
  pressing.value = true
  lpTimer = setTimeout(() => {
    lpTimer = null               // 计时器已经跳了, 后面松手时不必再 clear
    pressing.value = false       // 按压态到此为止, 但手还按着
    swallowClick.value = true    // 松手会带来一个 click, 必须吞掉
    // ⚠️ 这里**不能**调 lpRelease(): 一调就把 pointerup 监听摘了, 兜底定时器改从
    // 「触发」起算 350ms, 于是"按住 2 秒再松手"的 click 落在复位之后 —— 大图照开、
    // 刚勾上的那张还被点掉(r18 实测踩过)。留着 pointerup, 松手时才真正收工。
    emit('long-press', props.item, e)
  }, LONG_PRESS_MS)
}

function onClick(e) {
  if (swallowClick.value) {
    swallowClick.value = false
    if (lpClear) { clearTimeout(lpClear); lpClear = null }
    return
  }
  emit('open', props.item, e)
}

onBeforeUnmount(lpRelease)
</script>

<template>
  <div
    v-if="!hidden"
    ref="rootEl"
    :class="['card', { selected, 'has-sel': selectable, pickable, pressing, 'last-viewed': isLastViewed, 'is-missing': isMissing }]"
    :title="hint"
    @click="onClick"
    @contextmenu="onCtx"
    @pointerdown="onPointerDown"
    @mouseenter="emit('hover', { text: tipText, event: $event })"
    @mousemove="emit('move', $event)"
    @mouseleave="emit('leave')"
  >
    <!-- 发整个 item: 收藏记录要存标签快照, 只有 path 不够(2026-09-19) -->
    <button
      v-if="favable"
      :class="['fav', { on: favorited }]"
      :title="favorited ? '取消收藏' : '收藏'"
      @click.stop="emit('toggle-fav', item)"
    >{{ favorited ? '★' : '☆' }}</button>

    <!-- pickable(扫描页)时浏览态也渲染, 但靠 CSS 只在 hover/按压时显形;
         @pointerdown.stop: 手指/鼠标落在这个小框上就不该再启动卡片的长按计时, 否则
         按住勾选框 0.5 秒会既触发长按又触发点击, 一张卡被勾上又取消。 -->
    <span
      v-if="selectable || pickable"
      :class="['ckbox', { 'pick-hint': pickable && !selectable }]"
      @pointerdown.stop
      @click.stop="emit('toggle-select', item, $event)"
    >
      <input type="checkbox" :checked="selected" @click.stop="emit('toggle-select', item, $event)">
    </span>

    <!-- 失效收藏不请求缩略图: 路径已失效, 请求必然 404(还会打红 e2e 的控制台总闸) -->
    <TvImage v-if="!isMissing" :path="path" :width="thumbWidth" :ratio="fill ? 'auto' : ratio" :alt="item.name || path" />
    <span v-else class="tv-img gone-ph" :style="{ aspectRatio: fill ? 'auto' : ratio }" />

    <span v-if="showSource && srcBadge" class="src" :title="`图内元数据来源: ${srcBadge}`">{{ srcBadge }}</span>
    <span
      v-if="sim > 0"
      class="sim"
      :title="`与源图相似度 ${(sim * 100).toFixed(1)}%${item.simShared ? ` · 共享 ${item.simShared} 个词条` : ''}`"
    >{{ (sim * 100).toFixed(1) }}%</span>

    <!-- 标签区 -->
    <div v-if="tagMode === 'keys'" class="tags keys">
      <template v-if="!hasTags">
        <span class="none">(无提示词元数据)</span>
      </template>
      <template v-else-if="!keyParts.head && !keyParts.rest">
        <span class="none">(标签与本批其他图相同)</span>
      </template>
      <template v-else>
        <span v-if="keyParts.head" class="ch">{{ keyParts.head }}</span>
        <span v-if="keyParts.head && keyParts.rest"> · </span>
        <span>{{ keyParts.rest }}</span>
      </template>
    </div>
    <div v-else class="tags">
      {{ tags.slice(0, tagLimit).join(', ') }}
    </div>

    <div v-if="footText" class="foot" :title="path">{{ footText }}</div>
    <span v-if="isMissing" class="gone">文件已不在</span>
    <slot />
  </div>
</template>

<style scoped>
.card {
  position: relative;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.card:hover { border-color: var(--accent); }
.card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft) inset; }

/* 上次看过的图(光箱关掉后靠它找回位置): 红色描边 + 会呼吸的红色光晕。
 * 用独立的 --lastview 令牌(不是 --accent2 绿) —— 绿和缩略图撞色, 见 tokens.css 里的说明。
 * 与悬停/选中的蓝色、收藏的黄星、失效灰都区分得开。
 * 放在 :hover 规则之后 —— 悬停变蓝是瞬时反馈, 红框是持久标记, 红框优先。
 *
 * 呼吸(2026-09-20 用户反馈): 原来只是"一圈浅浅的绿描边 + 淡淡光晕", 在 150px 的
 * 卡片网格里不够抓眼, 关掉光箱后常常一眼扫不到刚才那张。改成光晕强弱循环 ——
 * 会动的东西才拉得住视线。静态的描边(border-color)不参与动画 —— 它保证
 * 任何一帧都认得出"就是这张"。另外**谷底那一档必须也够亮**: 第一版把谷底设成
 * 跟原来差不多淡的光晕, 定格截图一看, 等于有一半时间是"没加效果"的样子,
 * 所以两档只在"明显 / 更明显"之间起伏, 不再是"看不见 → 明显"。
 *
 * 两端 box-shadow 的**层数与顺序必须一致**(都是"内描边 + 外发光"两层),
 * 否则列表长度不同, 浏览器不做插值, 呼吸会退化成硬跳。
 */
@keyframes tv-lastviewed-breathe {
  0%, 100% {
    box-shadow: 0 0 0 2px var(--lastview-glow-dim) inset, 0 0 10px var(--lastview-glow-dim);
  }
  50% {
    box-shadow: 0 0 0 2px var(--lastview-glow) inset, 0 0 18px var(--lastview-glow);
  }
}
.card.last-viewed {
  border-color: var(--lastview);
  /* 这一行的 box-shadow 是**兜底**: 动画一旦不生效(旧内核 / 被下面的 media query
   * 关掉)也还有静态光晕, 不至于退回"只有一圈细边"。给的是谷底那一档 */
  box-shadow: 0 0 0 2px var(--lastview-glow-dim) inset, 0 0 10px var(--lastview-glow-dim);
  animation: tv-lastviewed-breathe 1.8s ease-in-out infinite;
}
.card.last-viewed:hover { border-color: var(--lastview); }

/* 系统开了"减少动态效果"就别呼吸了 —— 只留静态红框。
 * 定位能力一点不丢(靠 border-color + 兜底光晕), 只是不动。 */
@media (prefers-reduced-motion: reduce) {
  .card.last-viewed { animation: none; }
}

/* 失效收藏: 整卡去色 + 角标, 记录保留(找回/还原后自动恢复正常显示) */
.card.is-missing { opacity: .45; }
.card.is-missing img { filter: grayscale(1); }
.gone {
  position: absolute; top: 6px; left: 6px; z-index: 5;
  background: rgba(10, 13, 18, .85); color: var(--muted);
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  border: 1px solid var(--border);
}
.gone-ph {
  /* 比例由模板的 :style 给(跟随该图真实尺寸) —— 这里不要写死 9/16,
     否则"文件已不在"的横图占位会跟正常卡片的比例对不上 */
  display: block; width: 100%;
  background: var(--panel3);
}

/* ☆ 收藏: 平时隐藏, 悬停才出现(除非已收藏) */
.fav {
  position: absolute; top: 6px; right: 6px; z-index: 5;
  width: 30px; height: 30px; border-radius: 7px;
  background: rgba(10, 13, 18, .75);
  color: var(--muted); font-size: 16px; line-height: 1;
  opacity: 0; transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.card:hover .fav { opacity: 1; }
.fav.on { opacity: 1; color: var(--fav); }
.fav:hover { background: var(--fav-soft); color: var(--fav); }

.ckbox {
  position: absolute; top: 8px; left: 8px; z-index: 5;
  width: 22px; height: 22px; border-radius: 5px;
  background: rgba(10, 13, 18, .7);
  display: flex; align-items: center; justify-content: center;
  transition: opacity var(--t-fast), transform var(--t-fast);
}
.ckbox input { accent-color: var(--accent); width: 14px; height: 14px; pointer-events: none; }

/* 浏览态(pickable 网格)先藏起来: 满屏小方框比"少一个入口"更吵(用户 2026-10-22 明确否掉常显)。
   鼠标一进这张卡片就显形 —— 指针能落到框上, 说明它必然已在卡片内, 不存在"点了一个看不见的框"。
   按住卡片(pressing)时也提前亮, 让"正在长按"这件事看得见。 */
.ckbox.pick-hint { opacity: 0; }
.card:hover .ckbox.pick-hint,
.card.pressing .ckbox.pick-hint { opacity: 1; }
.card.pressing .ckbox { transform: scale(1.18); }
/* 长按会顺带选中底部文件名 → 干脆禁选; 卡片本来就不是拿来复制文字的 */
.card.pickable { user-select: none; }

/* 来源角标: 左上角 —— 以前在左下角, 正好压住标签区的提示词文字。
   选择模式下勾选框也占左上角, 徽标往右让一格。
   pickable 网格**浏览态也让好**: 只在 hover 那一瞬间挪 30px 会跳, 不如常驻。 */
.src {
  position: absolute; top: 6px; left: 6px; z-index: 4;
  background: rgba(10, 13, 18, .8); color: var(--accent2);
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  max-width: calc(100% - 12px); overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis;
}
.card.has-sel .src, .card.pickable .src { left: 36px; }

/* 相似度角标(库内命中页): 与来源角标同位置, 但那一页不传 showSource, 不会撞 */
.sim {
  position: absolute; top: 6px; left: 6px; z-index: 4;
  background: rgba(10, 13, 18, .82); color: var(--ok, #58c46a);
  font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
  border: 1px solid rgba(88, 196, 106, .35);
}
.card.has-sel .sim, .card.pickable .sim { left: 36px; }

.tags {
  font-size: 10px; color: var(--muted);
  padding: 4px 8px 2px;
  max-height: 28px; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis;
}
.tags.keys { white-space: normal; max-height: 42px; line-height: 1.35; }
.tags .ch { color: var(--seg-char); font-weight: 700; }
.tags .none { color: var(--faint); font-style: italic; }

.foot {
  font-size: 9px; color: var(--faint);
  padding: 0 8px 5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
</style>
