<script setup>
/**
 * 按钮 —— 全站按钮样式的唯一来源
 * 旧版有 .btn-search / .btn-export / .home / .bl-save / .bl-cancel / .btn / .btn-checkout
 * / .btn-danger / .btn-history / .float-btn 十来种各自为政的类名, 这里是它们的统一抽象。
 */
const props = defineProps({
  variant: { type: String, default: 'secondary' },   // primary | success | secondary | ghost | danger | warn | fav
  size: { type: String, default: 'md' },             // xs | sm | md | lg
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  title: { type: String, default: '' },
  type: { type: String, default: 'button' },
})

defineEmits(['click'])
</script>

<template>
  <button
    :class="['tv-btn', `v-${variant}`, `s-${size}`, { block, active, loading }]"
    :disabled="disabled || loading"
    :title="title || undefined"
    :type="type"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" class="spin" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.tv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  font-weight: 600;
  white-space: nowrap;
  transition: filter var(--t-fast), border-color var(--t-fast),
              background var(--t-fast), color var(--t-fast);
  line-height: 1.2;
}
.tv-btn:disabled { opacity: .5; cursor: not-allowed; }
.tv-btn:not(:disabled):hover { filter: brightness(1.12); }
.tv-btn.block { width: 100%; }

/* 尺寸 */
.s-xs { padding: 3px 8px; font-size: 11px; }
.s-sm { padding: 5px 10px; font-size: 12px; }
.s-md { padding: 8px 12px; font-size: 13px; }
.s-lg { padding: 10px 18px; font-size: 14px; }

/* 变体 */
.v-primary { background: var(--accent); color: var(--on-accent); }
.v-success { background: var(--accent2); color: #0b1c12; }
.v-secondary { background: var(--panel2); color: var(--text); border-color: var(--border); }
.v-secondary:not(:disabled):hover { border-color: var(--accent); filter: none; }
.v-ghost { background: transparent; color: var(--muted); }
.v-ghost:not(:disabled):hover { color: var(--text); background: var(--panel2); filter: none; }
.v-danger { background: var(--danger); color: #2a0b08; }
.v-warn { background: var(--warn); color: #2a1c05; }
.v-fav { background: var(--panel2); color: var(--fav); border-color: var(--border); }
.v-fav:not(:disabled):hover { border-color: var(--fav); filter: none; }
.v-fav.active { background: var(--fav); color: #1a1408; border-color: var(--fav); }

/* 转圈 */
.spin {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: tv-spin .7s linear infinite;
}
@keyframes tv-spin { to { transform: rotate(360deg); } }
</style>
