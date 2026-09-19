<script setup>
/**
 * 图片 —— 缩略图/原图 + 懒加载 + 失败自动重试
 * =========================================
 * 旧版这段逻辑在 common.js / index.html / series.html 各写了一遍(imgRetry 函数),
 * 行为是「最多重试 2 次, 退避 800ms/1600ms, 最终失败置灰」。
 * 原注释说明了为什么需要重试: 一页同时请求几十张缩略图, 服务端首次生成时会瞬时拥塞,
 * 个别请求失败就会留下"空白卡片"。
 *
 * 这里额外做了两件事:
 *   - 把每张图实际的请求宽度收敛到 400/300/200 三档, 与旧版 .thumb_cache 的
 *     命名完全对齐, 于是那份 93MB 缓存能直接被复用, 不用重新生成。
 *   - 加 IntersectionObserver 真正延迟请求, 旧版靠 loading="lazy" 也能懒加载,
 *     但瀑布流追加时首屏之外的图仍会被浏览器提前排队。
 */
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue'
import { thumbUrl, fileUrl } from '@/utils/api.js'

const props = defineProps({
  path: { type: String, required: true },
  /** 缩略图宽度; 传 0 表示直接要原图 */
  width: { type: Number, default: 400 },
  alt: { type: String, default: '' },
  /** 圆形头像等场景用 */
  contain: { type: Boolean, default: false },
  /** 网格里出现的图已经由容器保证在视口内, 可以关掉 IO */
  eager: { type: Boolean, default: false },
  /** 高宽比占位, 避免加载时布局跳动。默认与旧版卡片一致 9/16 */
  ratio: { type: String, default: '9 / 16' },
})

const emit = defineEmits(['loaded', 'failed'])

const root = ref(null)
const inView = ref(props.eager)
const src = ref('')
const retry = ref(0)
const failed = ref(false)
const loaded = ref(false)

let io = null
let timer = null

const baseSrc = computed(() => (
  props.width > 0 ? thumbUrl(props.path, props.width) : fileUrl(props.path)
))

function load(withCacheBust = false) {
  const b = baseSrc.value
  if (!b) return
  src.value = withCacheBust ? `${b}&_r=${Date.now()}` : b
}

function onError() {
  // 旧版语义: 最多重试 2 次, 退避 800ms / 1600ms
  if (retry.value >= 2) {
    failed.value = true
    emit('failed', props.path)
    return
  }
  const n = retry.value
  retry.value = n + 1
  clearTimeout(timer)
  timer = setTimeout(() => load(true), 800 * (n + 1))
}

function onLoad() {
  loaded.value = true
  failed.value = false
  emit('loaded', props.path)
}

function connect() {
  if (props.eager || !root.value || typeof IntersectionObserver === 'undefined') {
    inView.value = true
    return
  }
  io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      inView.value = true
      io?.disconnect()
      io = null
    }
  }, { rootMargin: '800px 0px' })
  io.observe(root.value)
}

onMounted(connect)
onBeforeUnmount(() => {
  io?.disconnect()
  clearTimeout(timer)
})

watch(baseSrc, () => {
  retry.value = 0
  failed.value = false
  loaded.value = false
  if (inView.value) load()
})
watch(inView, (v) => { if (v) load() })

/** 供父组件主动重试(例如服务端缩略图缓存清了) */
defineExpose({ retryLoad: () => { retry.value = 0; failed.value = false; load(true) } })
</script>

<template>
  <span
    ref="root"
    :class="['tv-img', { failed, loaded, contain }]"
    :style="{ aspectRatio: contain ? undefined : ratio }"
  >
    <img
      v-if="src && !failed"
      :src="src"
      :alt="alt"
      decoding="async"
      :class="{ contain }"
      @load="onLoad"
      @error="onError"
    >
    <span v-else-if="failed" class="bad" title="图片加载失败(重试 2 次后放弃)">⚠</span>
    <span v-else class="ph" />
  </span>
</template>

<style scoped>
.tv-img {
  display: block;
  position: relative;
  width: 100%;
  background: var(--img-bg);
  overflow: hidden;
}
img {
  width: 100%; height: 100%; display: block;
  object-fit: cover;
  transition: opacity .18s ease;
}
img.contain, .contain img { object-fit: contain; }
.tv-img.failed { background: var(--panel3); }
.bad {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--faint); font-size: 20px;
}
.ph { display: block; width: 100%; height: 100%; }
</style>
