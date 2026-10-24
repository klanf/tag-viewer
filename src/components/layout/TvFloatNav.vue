<script setup>
/**
 * 全局浮动导航(右下角): ↑ 回到顶部
 * ================================
 * 六个视图的滚动容器各不相同(各自 panel 内滚), 这里不逐个登记 ——
 * 用捕获阶段的 window scroll 事件直接拿「最后滚动的那个容器」,
 * 谁在滚就滚谁回去, 视图零改动。
 *
 * 2026-10-23: 返回键按用户要求搬去**左上角**(TvAppHeader 的 .back-btn),
 * 这里只留「回到顶部」。光箱打开时本键隐藏(光箱自己有关闭 × 与 Esc)。
 *
 * 2026-10-24: 右下角改成一竖列 —— 页面自己的浮动键(看板 🎲)占最下格时,
 * 本键按 floatLift 往上让一格, 否则正好盖住它(用户报)。
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { floatLift } from '@/composables/useFloatCorner.js'

const router = useRouter()
const lb = useLightboxStore()
const showTop = ref(false)

let lastScroller = null

function onScroll(e) {
  lastScroller = e.target
  const t = e.target
  const st = (t === document || t === document.documentElement)
    ? (window.scrollY || document.documentElement.scrollTop || 0)
    : (t?.scrollTop || 0)
  showTop.value = st > 240
}

function toTop() {
  const el = lastScroller
  if (el && el !== document && typeof el.scrollTo === 'function') {
    el.scrollTo({ top: 0, behavior: 'smooth' })
  } else {
    (document.scrollingElement || document.documentElement)?.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 路由切换: 回顶状态重置(旧容器可能已隐藏)
watch(() => router.currentRoute.value, () => {
  showTop.value = false
  lastScroller = null
})

onMounted(() => window.addEventListener('scroll', onScroll, true))
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll, true))
</script>

<template>
  <Transition name="fnav">
    <div v-if="showTop && !lb.visible" class="float-nav" :style="{ bottom: `${26 + floatLift}px` }">
      <button class="fbtn" title="回到顶部" @click="toTop">↑</button>
    </div>
  </Transition>
</template>

<style scoped>
.float-nav {
  /* right 21: 让 42px 的本键与看板 44px 的 🎲 圆心落在同一条竖线上 */
  position: fixed; right: 21px; bottom: 26px; z-index: 220;
}
.fbtn {
  width: 42px; height: 42px; border-radius: 50%;
  background: var(--panel); border: 1px solid var(--border);
  color: var(--text); font-size: 18px; line-height: 1;
  box-shadow: var(--shadow-2);
  display: flex; align-items: center; justify-content: center;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.fbtn:hover { border-color: var(--accent); transform: translateY(-1px); }
.fnav-enter-active, .fnav-leave-active { transition: opacity .15s ease, transform .15s ease; }
.fnav-enter-from, .fnav-leave-to { opacity: 0; transform: translateY(8px); }
</style>
