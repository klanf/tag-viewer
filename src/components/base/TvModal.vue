<script setup>
/**
 * 弹窗 —— 旧版有 .bl-mask / .catm-mask / .cart-mask / .mask 四套遮罩样式
 * 和 openBlacklist/closeBlacklist、openCatMgr/closeCatMgr... 一堆成对的开关函数。
 * 这里统一成一个组件: 传 v-model 控制显隐, 内容走插槽。
 */
import { watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  /** sm | md | lg | xl */
  size: { type: String, default: 'md' },
  /** 点遮罩是否关闭(默认关; 编辑类弹窗建议设 false 防误触丢内容) */
  maskClosable: { type: Boolean, default: true },
  /** 锁滚动: 大弹窗列表内滚时, 阻止滚轮穿透到页面 */
  lockScroll: { type: Boolean, default: true },
  /* 遮罩层级。默认 250 低于光箱(300) —— 在光箱里开的弹窗必须传更高的值,
     否则整个弹窗被压在光箱后面, 用户点到的全是光箱的「点空白关闭」(2026-10-01 用户实测踩中)。 */
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
    <Transition name="tv-modal">
      <div v-if="modelValue" class="mask" :style="{ zIndex }" @click="onMask" @wheel.stop>
        <div :class="['box', `s-${size}`]" role="dialog" aria-modal="true">
          <div v-if="title || $slots.header" class="head">
            <slot name="header"><b>{{ title }}</b></slot>
            <button class="x" title="关闭 (Esc)" type="button" @click="close">×</button>
          </div>
          <div class="body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="foot">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 250;
  background: var(--mask);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  backdrop-filter: blur(2px);
}
.box {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  display: flex; flex-direction: column;
  max-height: 90vh;
  width: 100%;
}
.s-sm { max-width: 420px; }
.s-md { max-width: 620px; }
.s-lg { max-width: 880px; }
.s-xl { max-width: 1200px; }

.head {
  display: flex; align-items: center; gap: 10px;
  font-size: 15px; font-weight: 600;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.x {
  margin-left: auto; color: var(--muted); font-size: 22px; line-height: 1;
  padding: 0 4px; border-radius: 4px;
}
.x:hover { color: var(--text); background: var(--panel2); }

.body { padding: 14px 18px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.foot {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid var(--border); flex: 0 0 auto;
}

/* 进出场 */
.tv-modal-enter-active, .tv-modal-leave-active { transition: opacity .16s ease; }
.tv-modal-enter-from, .tv-modal-leave-to { opacity: 0; }
.tv-modal-enter-active .box, .tv-modal-leave-active .box { transition: transform .16s ease; }
.tv-modal-enter-from .box, .tv-modal-leave-to .box { transform: scale(.97) translateY(-6px); }
</style>
