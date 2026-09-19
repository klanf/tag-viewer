<script setup>
/**
 * 全局浮动导航(右下角): ← 返回上一页 / ↑ 回到顶部
 * ===============================================
 * 六个视图的滚动容器各不相同(各自 panel 内滚), 这里不逐个登记 ——
 * 用捕获阶段的 window scroll 事件直接拿「最后滚动的那个容器」,
 * 谁在滚就滚谁回去, 视图零改动。
 * 返回按钮: vue-router 每次跳转会把上一条路由写进 history.state.back,
 * 有值(= 有得退)才显示; 首页冷启动进来没有, 不显示。
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { runFloatBack } from '@/composables/useFloatBack.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

const router = useRouter()
const lb = useLightboxStore()
const showTop = ref(false)
const showBack = ref(false)

let lastScroller = null

function onScroll(e) {
  lastScroller = e.target
  const t = e.target
  const st = (t === document || t === document.documentElement)
    ? (window.scrollY || document.documentElement.scrollTop || 0)
    : (t?.scrollTop || 0)
  showTop.value = st > 240
}

function refreshBack() {
  showBack.value = !!window.history.state?.back
}

function back() {
  // 光箱(大图预览)打开时: 返回 = 关闭光箱回到图片网格, 再点才走路由/层级回退。
  // 光箱遮罩(z-index 300)平时盖住本导航(z-index 220), 打开时本导航提升到 350 常驻右下。
  if (lb.visible) { lb.close(); return }
  // 视图自己的层级(如扫描页的文件夹列表 -> 图片)优先于路由回退
  if (runFloatBack()) return
  router.back()
}

function toTop() {
  const el = lastScroller
  if (el && el !== document && typeof el.scrollTo === 'function') {
    el.scrollTo({ top: 0, behavior: 'smooth' })
  } else {
    (document.scrollingElement || document.documentElement)?.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 路由切换: 回顶状态重置(旧容器可能已隐藏), back 可用性按新 history.state 算
watch(() => router.currentRoute.value, () => {
  refreshBack()
  showTop.value = false
  lastScroller = null
})

onMounted(() => {
  window.addEventListener('scroll', onScroll, true)
  refreshBack()
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll, true))
</script>

<template>
  <Transition name="fnav">
    <div v-if="showBack || showTop || lb.visible" class="float-nav" :class="{ above: lb.visible }">
      <button v-if="showBack || lb.visible" class="fbtn" title="返回上一页" @click="back">←</button>
      <button v-if="showTop && !lb.visible" class="fbtn" title="回到顶部" @click="toTop">↑</button>
    </div>
  </Transition>
</template>

<style scoped>
.float-nav {
  position: fixed; right: 22px; bottom: 26px; z-index: 220;
  /* column-reverse: 返回按钮永远钉在右下角, 回顶按钮出现时叠在它正上方 */
  display: flex; flex-direction: column-reverse; gap: 8px;
}
/* 光箱(z-index 300)打开时浮到它之上, 返回按钮常驻右下不被遮住 */
.float-nav.above { z-index: 350; }
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
