<script setup>
/**
 * ⓘ 说明气泡
 * ===========
 * 设置页里那些"三行起步"的说明文字不再常驻, 收进这个小圆点: 悬停看、点一下钉住。
 *
 * 气泡 Teleport 到 body 并算 fixed 坐标 —— 抽屉正文是 overflow:auto, 直接塞在行内
 * 会被裁掉半截; fixed 也不会把下面的控件顶开(用户之前抱怨过浮层盖住内容)。
 */
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'

const props = defineProps({
  /** 气泡宽度(px), 小屏自动收窄 */
  width: { type: Number, default: 300 },
})

const wrap = ref(null)
const btn = ref(null)
const bubble = ref(null)
const open = ref(false)
const pinned = ref(false)
const pos = ref({ left: 0, top: 0, width: 300 })
let hideTimer = null

function place() {
  const b = btn.value
  if (!b) return
  const r = b.getBoundingClientRect()
  const w = Math.max(200, Math.min(props.width, window.innerWidth - 24))
  const h = bubble.value?.offsetHeight || 120
  // 优先放右边; 右边不够就翻到左边; 再按视口夹一下
  let left = r.right + 10
  if (left + w > window.innerWidth - 12) left = Math.max(12, r.left - w - 10)
  const top = Math.min(Math.max(12, r.top - 6), Math.max(12, window.innerHeight - h - 12))
  pos.value = { left, top, width: w }
}

async function show() {
  clearTimeout(hideTimer)
  open.value = true
  await nextTick()
  place()
}

function cancelHide() {
  clearTimeout(hideTimer)
}

function hideSoon() {
  if (pinned.value) return
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => { open.value = false }, 140)
}

function toggle() {
  pinned.value = !pinned.value
  if (pinned.value) show()
  else { open.value = false }
}

function onDocPointer(e) {
  if (!pinned.value) return
  if (wrap.value?.contains(e.target) || bubble.value?.contains(e.target)) return
  pinned.value = false
  open.value = false
}

function onKey(e) {
  if (e.key !== 'Escape' || !open.value) return
  pinned.value = false
  open.value = false
}

watch(open, (v) => {
  if (v) {
    window.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
  } else {
    window.removeEventListener('pointerdown', onDocPointer, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', place, true)
    window.removeEventListener('resize', place)
  }
})

onBeforeUnmount(() => {
  clearTimeout(hideTimer)
  window.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
})
</script>

<template>
  <span ref="wrap" class="itip-wrap" @mouseenter="show" @mouseleave="hideSoon">
    <button
      ref="btn"
      class="itip"
      type="button"
      :class="{ on: open }"
      aria-label="说明"
      :aria-expanded="open"
      @click.stop="toggle"
    >i</button>
    <Teleport to="body">
      <Transition name="itip-fade">
        <div
          v-if="open"
          ref="bubble"
          class="itip-bubble"
          :style="{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px' }"
          @mouseenter="cancelHide"
          @mouseleave="hideSoon"
        >
          <slot />
          <span v-if="pinned" class="itip-pin">点空白处关闭</span>
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.itip-wrap { display: inline-flex; align-items: center; }
.itip {
  width: 15px; height: 15px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--panel3);
  color: var(--muted); font-size: 10px; line-height: 1; font-style: italic;
  font-family: Georgia, serif; cursor: pointer; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}
.itip:hover, .itip.on { color: var(--accent); border-color: var(--accent); }
.itip-bubble {
  position: fixed; z-index: 420;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  box-shadow: var(--shadow-2);
  color: var(--text); font-size: 12px; line-height: 1.7;
  padding: 10px 12px;
  max-height: 60vh; overflow: auto;
}
.itip-bubble :deep(b) { color: var(--text); }
.itip-bubble :deep(.mono) {
  font-family: var(--mono, Consolas, monospace); font-size: 11px;
  background: var(--panel3); border-radius: 4px; padding: 0 4px;
}
.itip-pin {
  display: block; margin-top: 6px; padding-top: 6px;
  border-top: 1px dashed var(--border);
  font-size: 10px; color: var(--faint);
}
.itip-fade-enter-active, .itip-fade-leave-active { transition: opacity .12s ease; }
.itip-fade-enter-from, .itip-fade-leave-to { opacity: 0; }
</style>
