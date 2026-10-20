<script setup>
/**
 * 网格缩放徽标 —— 与 useGridZoom.js 配套(2026-10-20)
 * 底部居中的小药丸: 显示当前缩放百分比, show 由调用方的 900ms 定时器控制淡入淡出,
 * 点击恢复 100%。光箱的缩放徽标是另一套(锚在图片左上), 不要混用。
 */
defineProps({
  zoom: { type: Number, default: 1 },
  show: { type: Boolean, default: false },
})
const emit = defineEmits(['reset'])
</script>

<template>
  <Transition name="zoomfade">
    <div
      v-if="show"
      class="zoom-badge"
      title="Ctrl+滚轮缩放网格 · 点击恢复 100%"
      @click="emit('reset')"
    >{{ Math.round(zoom * 100) }}%</div>
  </Transition>
</template>

<style scoped>
.zoom-badge {
  position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
  z-index: 70;
  background: rgba(10, 13, 18, .85); color: var(--text);
  font-size: 12px; padding: 5px 13px; border-radius: 999px;
  border: 1px solid var(--border);
  cursor: pointer; user-select: none;
}
.zoomfade-enter-active, .zoomfade-leave-active { transition: opacity .18s ease; }
.zoomfade-enter-from, .zoomfade-leave-to { opacity: 0; }
</style>
