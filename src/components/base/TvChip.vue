<script setup>
/** 小胶囊标签: 来源筛选条 / 分类管理里的分类芯片都用它 */
const props = defineProps({
  label: { type: String, default: '' },
  count: { type: [Number, String], default: null },
  active: { type: Boolean, default: false },
  /** 可移除(右上角 ✕) */
  removable: { type: Boolean, default: false },
  /** 不可点击的纯展示态 */
  readonly: { type: Boolean, default: false },
  tone: { type: String, default: '' },   // '' | accent | warn | danger | ok
})
const emit = defineEmits(['click', 'remove'])
</script>

<template>
  <span
    :class="['tv-chip', tone && `t-${tone}`, { active, readonly }]"
    :title="label"
    @click="!readonly && emit('click', $event)"
  >
    <slot>{{ label }}</slot>
    <span v-if="count !== null && count !== ''" class="n">{{ typeof count === 'number' ? count.toLocaleString() : count }}</span>
    <span v-if="removable" class="rm" title="移除" @click.stop="emit('remove')">✕</span>
  </span>
</template>

<style scoped>
.tv-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 12px; border-radius: var(--r-pill);
  font-size: 12px; cursor: pointer;
  background: var(--panel2); color: var(--muted);
  border: 1px solid var(--border);
  white-space: nowrap; max-width: 100%;
  transition: all var(--t-fast);
}
.tv-chip:hover { border-color: var(--accent); color: var(--text); }
.tv-chip.active {
  background: var(--accent); color: var(--on-accent);
  border-color: var(--accent); font-weight: 600;
}
.n { opacity: .72; font-size: 11px; }
.tv-chip.readonly { cursor: default; }
.tv-chip.readonly:hover { border-color: var(--border); color: var(--muted); }
.rm {
  margin-left: 2px; font-size: 10px; opacity: .7;
  padding: 0 2px; border-radius: 3px;
}
.rm:hover { opacity: 1; background: rgba(255, 80, 80, .22); }
.t-accent { border-color: var(--accent); color: var(--accent); }
.t-warn { border-color: var(--warn); color: var(--warn); }
.t-danger { border-color: var(--danger); color: var(--danger); }
.t-ok { border-color: var(--accent2); color: var(--accent2); }
</style>
