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
const p = computed(() => app.setup)
const visible = computed(() => !!p.value)

/** done 后挂几秒再消失 */
const lingerUntil = ref(0)
const lingerNow = ref(Date.now())
watch(() => p.value?.done, (d) => {
  if (d) lingerUntil.value = Date.now() + 4000
  else lingerUntil.value = 0
})
setInterval(() => { lingerNow.value = Date.now() }, 500)
const show = computed(() => visible.value && (lingerNow.value < lingerUntil.value || !p.value?.done))

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
