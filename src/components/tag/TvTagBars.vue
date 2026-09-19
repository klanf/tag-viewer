<script setup>
/**
 * 横向条形图列表(高频标签 / 系列分布)
 * 旧版 renderBars() 在 index.html 里手搓 DOM, 这里改成纯模板。
 * 百分比以**第一项**(数量最多)为基准, 与旧版一致 —— 不是以总和为基准,
 * 否则 top1 也只是一根短条, 视觉上比不出差距。
 */
const props = defineProps({
  /** [{tag, count}] */
  data: { type: Array, default: () => [] },
  maxHeight: { type: String, default: '420px' },
  emptyText: { type: String, default: '暂无数据' },
})
const emit = defineEmits(['pick'])
</script>

<template>
  <div v-if="data.length" class="bars" :style="{ maxHeight }">
    <div
      v-for="it in data"
      :key="it.tag"
      class="row"
      :title="it.tag"
      @click="emit('pick', it.tag)"
    >
      <div class="label">{{ it.tag }}</div>
      <div class="track">
        <div class="bar" :style="{ width: `${(it.count / data[0].count * 100).toFixed(1)}%` }" />
      </div>
      <div class="num">{{ it.count.toLocaleString() }}</div>
    </div>
  </div>
  <div v-else class="empty">{{ emptyText }}</div>
</template>

<style scoped>
.bars {
  display: flex; flex-direction: column; gap: 3px;
  overflow-y: auto; padding-right: 4px;
}
.row { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
.row:hover .bar { filter: brightness(1.25); }
.row:hover .label { color: var(--text); }
.label {
  width: 132px; text-align: right; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 0 0 auto;
}
.track {
  flex: 1; min-width: 0;
  background: var(--panel2); border-radius: 3px; height: 16px; overflow: hidden;
}
.bar {
  height: 100%; min-width: 2px; border-radius: 3px;
  background: linear-gradient(90deg, var(--bar-from), var(--accent));
  transition: width .25s ease;
}
.num {
  width: 48px; color: var(--muted); font-size: 11px; text-align: right;
  flex: 0 0 auto;
}
.empty { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
</style>
