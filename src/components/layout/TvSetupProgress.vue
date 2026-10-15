<script setup>
/**
 * 反推环境搭建进度卡（全局悬浮，右下角）
 * =======================================
 * 主进程在「现在下载」确认后推 tagger:setup-progress：
 *   { stage }                    —— 阶段文本
 *   { file, bytes, total, pct }  —— 文件字节级下载进度（高频，卡片只显示最新一帧）
 *   { done: true, stage }        —— 完成
 * 完成后停留 4s 自动收起；失败主进程走 toast，这里不重复报错。
 */
import { computed, ref, watch } from 'vue'
import { useAppStore } from '@/stores/useAppStore'

const app = useAppStore()

/**
 * ⚠️ 只认「真在下载/准备」的载荷。
 * 主进程 boot 后 4 秒会推一次 `{ probe: {...} }`(纯探测, 告诉向导缺不缺 Python/模型),
 * 那不是一次下载 —— 但以前这里没区分, probe 也会把卡片点亮, 而 probe 之后
 * **永远不会再来 done**, 于是卡片显示「反推环境准备中…」**永久挂在右下角**。
 * 2026-10-16 另一台机器实测截图就是这个现象(本机因为环境齐全会很快被
 * done 覆盖, 所以一直没暴露)。
 * 规则: 有 stage / file / bytes / pct / error 任一才算真的在准备; 只有 probe 的不算。
 */
const p = computed(() => app.setup)
const meaningful = computed(() => {
  const v = p.value
  if (!v) return false
  if (v.done) return true
  return !!(v.stage || v.file || v.bytes || v.pct || v.error)
})
const visible = computed(() => meaningful.value)

/** done 后挂几秒再消失 */
const lingerUntil = ref(0)
const lingerNow = ref(Date.now())
watch(() => p.value?.done, (d) => {
  if (d) lingerUntil.value = Date.now() + 4000
  else lingerUntil.value = 0
})

/**
 * 兜底看门狗: 最后一条进度到现在超过 3 分钟且没等到 done, 就把卡片收掉。
 * 网络卡死 / 主进程异常退出下载流程时, 至少不会让一块永远不动的卡片一直占着屏幕
 * (真在下载时 onProgress 是持续推的, 不会误收)。
 */
const lastPushAt = ref(Date.now())
watch(p, () => { lastPushAt.value = Date.now() }, { deep: false })
setInterval(() => { lingerNow.value = Date.now() }, 500)
const stale = computed(() => Date.now() - lastPushAt.value > 3 * 60 * 1000)
const show = computed(() => {
  if (!visible.value) return false
  if (p.value?.error) return false            // 失败走 toast, 卡片不再占位(与顶部注释一致)
  if (lingerNow.value < lingerUntil.value) return true
  if (p.value?.done) return false
  return !stale.value
})

const hasBytes = computed(() => typeof p.value?.bytes === 'number' && p.value?.total > 0)
const pct = computed(() => p.value?.pct ?? 0)
const mb = (n) => (n / 1048576).toFixed(hasBytes.value && p.value.total > 100000000 ? 0 : 1)
const label = computed(() => {
  if (p.value?.file) return `正在下载 ${p.value.file}`
  return p.value?.stage || '反推环境准备中…'
})
</script>

<template>
  <Transition name="setup-card">
    <div v-if="show" class="tv-setup" role="status" aria-live="polite">
      <div class="tv-setup__head">
        <span class="tv-setup__label">{{ label }}</span>
        <span v-if="hasBytes" class="tv-setup__pct">{{ pct }}%</span>
      </div>
      <div v-if="hasBytes" class="tv-setup__bar">
        <div class="tv-setup__fill" :style="{ width: pct + '%' }" />
      </div>
      <div v-if="hasBytes" class="tv-setup__dim">
        {{ mb(p.bytes) }} / {{ mb(p.total) }} MB · 断点续传，中断不丢进度
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.tv-setup {
  position: fixed;
  right: 20px;
  bottom: 76px;
  z-index: 90;
  width: 300px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--tv-surface, #fff);
  border: 1px solid var(--tv-border, #e0e0e0);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  pointer-events: none; /* 纯展示, 不挡下面的点击 */
}
.tv-setup__head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.tv-setup__label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tv-setup__pct { font-variant-numeric: tabular-nums; color: var(--tv-accent, #4a7dff); }
.tv-setup__bar {
  height: 6px; margin-top: 8px; border-radius: 3px;
  background: var(--tv-border, #e8e8e8); overflow: hidden;
}
.tv-setup__fill {
  height: 100%; border-radius: 3px;
  background: var(--tv-accent, #4a7dff);
  transition: width 0.3s ease;
}
.tv-setup__dim { margin-top: 6px; font-size: 11px; color: var(--tv-dim, #999); }
.setup-card-enter-active, .setup-card-leave-active { transition: opacity 0.25s, transform 0.25s; }
.setup-card-enter-from, .setup-card-leave-to { opacity: 0; transform: translateY(8px); }
</style>
