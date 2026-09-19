<script setup>
/** 空状态 / 加载态 / 错误态三合一, 免得每个列表各写一遍 */
const props = defineProps({
  /** empty | loading | error */
  state: { type: String, default: 'empty' },
  text: { type: String, default: '' },
  /** 追加的详细说明(富文本用插槽) */
  size: { type: String, default: 'md' },
  /** 内联: 不撑开高度(嵌在小面板里) */
  inline: { type: Boolean, default: false },
})
</script>

<template>
  <div :class="['tv-state', state, `s-${size}`, { inline }]">
    <span v-if="state === 'loading'" class="spin" />
    <template v-if="state === 'error'">
      <span class="ico">⚠</span>
      <span>{{ text || '出错了' }}</span>
    </template>
    <template v-else-if="state === 'loading'">
      <span>{{ text || '加载中...' }}</span>
    </template>
    <template v-else>
      <slot>{{ text || '没有匹配的内容' }}</slot>
    </template>
  </div>
</template>

<style scoped>
.tv-state {
  color: var(--muted); font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  gap: 8px; text-align: center;
  padding: 40px 12px;
  flex-direction: column;
}
.tv-state.inline { padding: 14px 8px; }
.tv-state.s-sm { padding: 18px 8px; font-size: 12px; }
.tv-state.error { color: var(--danger); }
.ico { font-size: 18px; }
.spin {
  width: 16px; height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: tv-spin .75s linear infinite;
}
@keyframes tv-spin { to { transform: rotate(360deg); } }
</style>
