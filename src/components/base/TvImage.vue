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
 *
 * 缩略图还要过一道全局闸门(2026-10-22): 一次翻多页会有几百张卡片同时进视口,
 * 请求全部压给主进程就把事件循环占死。缩略图(带 width)先向 thumbQueue 申请
 * 槽位, 同时最多 4 个在飞; 卡片卸载/换图时把排队项撤回。原图(width=0, 光箱)
 * 默认不排队 —— 一次只有一张, 不该排在缩略图后面; 但查重面板会同时挂很多张
 * 原图, 那里显式传 origGate, 走原图专用闸门(2 并发)并收窄懒加载预取范围。
 */
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue'
import { thumbUrl, fileUrl } from '@/utils/api.js'
import { acquireThumbSlot, acquireOrigSlot } from '@/utils/thumbQueue.js'

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
  /** 原图(width=0)也走限流队列 —— 查重面板这类一次挂很多原图的场景用 */
  origGate: { type: Boolean, default: false },
  /** 懒加载预取范围; 原图体积大, 查重面板会收窄到 300px */
  rootMargin: { type: String, default: '800px 0px' },
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

/* ---- 缩略图闸门状态 ---- */
const HOLD_MAX_MS = 20000     // 兜底: 20s 没等到 load/error 也要还槽, 免得 4 个槽全被挂死
let alive = true
let requestSeq = 0            // 选中/换图后自增, 晚到的槽位授权直接作废
let wait = null               // { promise, cancel } 排队项
let heldRelease = null        // 已拿到的槽位(load/error/卸载时归还)
let holdTimer = null

const baseSrc = computed(() => (
  props.width > 0 ? thumbUrl(props.path, props.width) : fileUrl(props.path)
))

function load(withCacheBust = false) {
  const b = baseSrc.value
  if (!b) return
  src.value = withCacheBust ? `${b}&_r=${Date.now()}` : b
}

function cancelWait() {
  wait?.cancel()
  wait = null
}

function releaseSlot() {
  clearTimeout(holdTimer)
  holdTimer = null
  const r = heldRelease
  heldRelease = null
  if (r) r()
}

/** 发起一次加载: 缩略图走缩略图队, 原图默认直放、origGate 时走原图队 */
function requestLoad(withCacheBust = false) {
  cancelWait()
  releaseSlot()
  const slot = props.width > 0
    ? acquireThumbSlot()
    : (props.origGate ? acquireOrigSlot() : null)
  if (!slot) { load(withCacheBust); return }
  const my = ++requestSeq
  wait = slot
  slot.promise.then((release) => {
    if (!alive || my !== requestSeq) { release(); return }
    wait = null
    heldRelease = release
    holdTimer = setTimeout(releaseSlot, HOLD_MAX_MS)
    load(withCacheBust)
  })
}

/** 已经在排队/已经拿到槽/已经在加载的, 不要重复发起; 没进视口的也别发起 */
function requestIfIdle() {
  if (!alive || !inView.value || wait || heldRelease || src.value) return
  requestLoad()
}

function onError() {
  releaseSlot()                 // 退避期间不占槽
  // 旧版语义: 最多重试 2 次, 退避 800ms / 1600ms
  if (retry.value >= 2) {
    failed.value = true
    emit('failed', props.path)
    return
  }
  const n = retry.value
  retry.value = n + 1
  clearTimeout(timer)
  timer = setTimeout(() => requestLoad(true), 800 * (n + 1))
}

function onLoad() {
  releaseSlot()
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
  }, { rootMargin: props.rootMargin })
  io.observe(root.value)
}

onMounted(() => {
  connect()
  requestIfIdle()
})
onBeforeUnmount(() => {
  alive = false
  io?.disconnect()
  clearTimeout(timer)
  cancelWait()
  releaseSlot()
})

watch(baseSrc, () => {
  retry.value = 0
  failed.value = false
  loaded.value = false
  requestSeq++                 // 上一轮还没兑现的授权作废
  cancelWait()
  releaseSlot()
  if (inView.value) requestLoad()
})
watch(inView, (v) => { if (v) requestLoad() })

/** 供父组件主动重试(例如服务端缩略图缓存清了) */
defineExpose({ retryLoad: () => { retry.value = 0; failed.value = false; requestLoad(true) } })
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
