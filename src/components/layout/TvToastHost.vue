<script setup>
/**
 * 全局提示宿主 —— 顶部 toast + 跟随鼠标的标签气泡
 * ==============================================
 * 旧版这两个元素在每个 HTML 里都手写了一份 <div id="toast"> / <div id="tipBubble">,
 * 并且 moveTip() 也在 index.html / common.js / series.html 各抄一遍。
 * 现在只挂一次(App.vue 里), 任何地方调 ui.toast() / ui.showTip() 即可。
 */
import { useUiStore } from '@/stores/useUiStore.js'

const ui = useUiStore()
</script>

<template>
  <Teleport to="body">
    <!-- 顶部提示 -->
    <Transition name="tv-toast">
      <div v-if="ui.toastOn" :class="['toast', `t-${ui.toastTone}`]" role="status">
        {{ ui.toastText }}
      </div>
    </Transition>

    <!-- 跟随鼠标的标签气泡: 用 fixed 定位, 坐标由 store 算好(含边缘翻转) -->
    <div
      v-if="ui.tipOn && ui.tipText"
      class="tip-bubble"
      :style="{ left: `${ui.tipPos.x}px`, top: `${ui.tipPos.y}px` }"
    >{{ ui.tipText }}</div>
  </Teleport>
</template>

<style scoped>
.toast {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
  z-index: 400;
  max-width: 70vw;
  padding: 9px 20px;
  border-radius: var(--r-md);
  background: var(--toast-bg);
  color: #fff;
  font-size: 13px;
  box-shadow: var(--shadow-2);
  pointer-events: none;
  white-space: pre-line;
  text-align: center;
}
.toast.t-ok { background: var(--accent2); color: #08170e; }
.toast.t-err { background: var(--danger); color: #2a0b08; }
.toast.t-warn { background: var(--warn); color: #2a1c05; }

.tv-toast-enter-active, .tv-toast-leave-active { transition: opacity .18s ease, transform .18s ease; }
.tv-toast-enter-from, .tv-toast-leave-to { opacity: 0; transform: translate(-50%, -10px); }

.tip-bubble {
  position: fixed;
  z-index: 500;
  max-width: 340px;
  padding: 7px 11px;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-2);
  color: var(--text);
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
  pointer-events: none;
}
</style>
