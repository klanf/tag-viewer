<script setup>
/**
 * 抽屉 —— 从右侧滑出的侧栏(设置页用)
 * ===================================
 * TvModal 是居中弹窗, 适合短表单; 设置项一多, 居中弹窗就显得拥挤。
 * 抽屉占满高度、按行铺开, 更像"一页纸", 也不会把背后的网格整个盖住。
 *
 * 交互与 TvModal 对齐: 点遮罩 / Esc 关闭, 滚动不穿透。
 */
import { watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  /** 面板宽度(px); 小屏自动收到 94vw */
  width: { type: Number, default: 560 },
  maskClosable: { type: Boolean, default: true },
  zIndex: { type: Number, default: 250 },
})
const emit = defineEmits(['update:modelValue', 'close'])

function close() {
  emit('update:modelValue', false)
  emit('close')
}

function onMask(e) {
  if (props.maskClosable && e.target === e.currentTarget) close()
}

function onKey(e) {
  if (e.key === 'Escape' && props.modelValue) {
    e.stopPropagation()
    close()
  }
}

watch(() => props.modelValue, (v) => {
  if (v) window.addEventListener('keydown', onKey, true)
  else window.removeEventListener('keydown', onKey, true)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="tv-drawer">
      <div v-if="modelValue" class="drawer-mask" :style="{ zIndex }" @click="onMask" @wheel.stop>
        <div class="drawer" :style="{ width: `min(${width}px, 94vw)` }" role="dialog" aria-modal="true">
          <div class="dhead">
            <slot name="header"><b>{{ title }}</b></slot>
            <button class="x" title="关闭 (Esc)" type="button" @click="close">×</button>
          </div>
          <div class="dbody">
            <slot />
          </div>
          <div v-if="$slots.footer" class="dfoot">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-mask {
  position: fixed; inset: 0; z-index: 250;
  background: var(--mask);
  display: flex; justify-content: flex-end;
  backdrop-filter: blur(2px);
}
.drawer {
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  display: flex; flex-direction: column;
  max-width: 100vw;
}
.dhead {
  display: flex; align-items: center; gap: 10px;
  font-size: 15px; font-weight: 600;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.x {
  margin-left: auto; color: var(--muted); font-size: 22px; line-height: 1;
  padding: 0 4px; border-radius: 4px;
}
.x:hover { color: var(--text); background: var(--panel2); }
.dbody { padding: 16px 20px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.dfoot {
  display: flex; gap: 8px; justify-content: flex-end; align-items: center;
  padding: 12px 20px; border-top: 1px solid var(--border); flex: 0 0 auto;
}

.tv-drawer-enter-active, .tv-drawer-leave-active { transition: opacity .18s ease; }
.tv-drawer-enter-active .drawer, .tv-drawer-leave-active .drawer { transition: transform .18s ease; }
.tv-drawer-enter-from, .tv-drawer-leave-to { opacity: 0; }
.tv-drawer-enter-from .drawer, .tv-drawer-leave-to .drawer { transform: translateX(24px); }
</style>
