<script setup>
/**
 * 双图对比(2026-11-10) —— 用户反馈「双选图片后支持并排显示和滑动对比」。
 * 设计稿(用户截图): 深色全屏遮罩, 顶部居中一条工具条 [并排|滑动|交换|✕],
 *  滑动模式 = 两图叠放, 竖分割线 + 圆形把手拖动切分; 并排模式 = 左右各半。
 *
 * 入口: 扫描页多选恰好 2 张时批量工具条亮「🆚 对比」。选中顺序按当前排序,
 *  「交换」对调左右(找出哪边是基准看差异)。ESC 关闭, ←/→ 微调分割线。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { fileUrl } from '@/utils/api.js'

const props = defineProps({
  a: { type: String, required: true },
  b: { type: String, required: true },
})
const emit = defineEmits(['close'])

const mode = ref('slide')          // 'slide' | 'side'
const swapped = ref(false)
const pos = ref(50)                // 分割线位置(左图占 0~pos%)
const stage = ref(null)

const leftSrc = computed(() => fileUrl(swapped.value ? props.b : props.a))
const rightSrc = computed(() => fileUrl(swapped.value ? props.a : props.b))

/* ---- 滑动: 按住 stage 任意处拖动(不只是把手), 手感最好 ---- */
let dragging = false

function setFromEvent(e) {
  const r = stage.value?.getBoundingClientRect()
  if (!r || !r.width) return
  const p = ((e.clientX - r.left) / r.width) * 100
  pos.value = Math.min(100, Math.max(0, p))
}
function onDown(e) {
  if (mode.value !== 'slide' || e.button !== 0) return
  dragging = true
  // setPointerCapture 在合成事件/e2e 派发下会抛 NotFoundError(没有活跃指针),
  // 捕获即可 —— 抓不住顶多拖出 stage 断线, 不该炸整个组件
  try { stage.value?.setPointerCapture?.(e.pointerId) } catch { /* 无活跃指针, 忽略 */ }
  setFromEvent(e)
}
function onMove(e) { if (dragging) setFromEvent(e) }
function onUp() { dragging = false }

function onKey(e) {
  if (e.key === 'Escape') { emit('close'); return }
  if (mode.value !== 'slide') return
  if (e.key === 'ArrowLeft') pos.value = Math.max(0, pos.value - 2)
  if (e.key === 'ArrowRight') pos.value = Math.min(100, pos.value + 2)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="cmp-mask" @wheel.prevent>
    <!-- 顶部工具条(与设计稿一致: 居中悬浮) -->
    <div class="cmp-bar" data-test="cmp-bar">
      <div class="seg" role="tablist">
        <button :class="{ on: mode === 'side' }" title="左右并排各看一半" @click="mode = 'side'">并排</button>
        <button :class="{ on: mode === 'slide' }" title="叠放拖分割线对比(←/→ 微调)" @click="mode = 'slide'">滑动</button>
      </div>
      <button class="swap" title="左右交换" @click="swapped = !swapped">交换</button>
      <button class="x" title="关闭对比(ESC)" @click="emit('close')">✕</button>
    </div>

    <!-- 滑动模式: 右图垫底, 左图 clip-path 裁到分割线 -->
    <div
      v-if="mode === 'slide'"
      ref="stage"
      class="cmp-stage slide"
      data-test="cmp-stage"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <img class="base" :src="rightSrc" alt="" draggable="false">
      <img
        class="clip"
        :src="leftSrc"
        alt=""
        draggable="false"
        :style="{ clipPath: `inset(0 ${100 - pos}% 0 0)` }"
      >
      <div class="divider" :style="{ left: pos + '%' }"><i /></div>
    </div>

    <!-- 并排模式: 左右各半, 各自 contain -->
    <div v-else class="cmp-stage side" data-test="cmp-stage">
      <img :src="leftSrc" alt="" draggable="false">
      <img :src="rightSrc" alt="" draggable="false">
    </div>
  </div>
</template>

<style scoped>
.cmp-mask {
  position: fixed; inset: 0; z-index: 300;
  background: rgba(0, 0, 0, .88);
  display: flex; align-items: center; justify-content: center;
}
.cmp-bar {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  background: rgba(22, 22, 26, .92); border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 999px; padding: 5px 10px; z-index: 10;
}
.cmp-bar .seg { display: flex; background: rgba(255, 255, 255, .06); border-radius: 999px; padding: 2px; }
.cmp-bar .seg button {
  border: 0; background: transparent; color: rgba(255, 255, 255, .65);
  font-size: 12px; padding: 3px 12px; border-radius: 999px; cursor: pointer;
}
.cmp-bar .seg button.on { background: var(--accent, #4c8dff); color: #fff; }
.cmp-bar .swap, .cmp-bar .x {
  border: 0; background: transparent; cursor: pointer;
  color: rgba(255, 255, 255, .65); font-size: 12px; padding: 3px 8px; border-radius: 999px;
}
.cmp-bar .swap:hover, .cmp-bar .x:hover { color: #fff; background: rgba(255, 255, 255, .1); }

.cmp-stage { position: relative; user-select: none; }
.cmp-stage.slide {
  display: block; line-height: 0;
  cursor: ew-resize;
  touch-action: none;
}
.cmp-stage.slide .base {
  display: block; margin: auto;
  max-width: 94vw; max-height: 92vh;
  object-fit: contain;
}
.cmp-stage.slide .clip {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: contain;
  pointer-events: none;
}
.divider {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: rgba(255, 255, 255, .9); pointer-events: none;
}
.divider i {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, .5);
}
.cmp-stage.side {
  display: flex; gap: 8px; width: 94vw; height: 92vh;
  align-items: center; justify-content: center;
}
.cmp-stage.side img {
  flex: 1 1 0; min-width: 0; height: 100%;
  object-fit: contain; background: rgba(255, 255, 255, .03);
}
</style>
