<script setup>
/**
 * 批量操作条(选择模式) —— 看板 / 标签图片页 / 系列图片层共用(2026-10-21)
 * ====================================================================
 * 与扫描页的 batch-bar 同款交互; 那边连着 e2e data-test 没动, 这份是新抽取
 * 的独立展示组件: 状态与动作全部来自 useBatchOps, 这里只管摆按钮。
 */
import TvButton from '@/components/base/TvButton.vue'

defineProps({
  /** 已勾选张数 */
  count: { type: Number, default: 0 },
  moving: { type: Boolean, default: false },
  copying: { type: Boolean, default: false },
})
const emit = defineEmits(['sel-all', 'sel-invert', 'sel-clear', 'exit', 'move', 'copy', 'del'])
</script>

<template>
  <div class="batch-bar">
    <span class="bcnt">已选 <b>{{ count }}</b> 张</span>
    <TvButton size="sm" variant="ghost" title="勾选当前列表的全部图片" @click="emit('sel-all')">全选</TvButton>
    <TvButton size="sm" variant="ghost" @click="emit('sel-invert')">反选</TvButton>
    <TvButton size="sm" variant="ghost" :disabled="!count" @click="emit('sel-clear')">清空</TvButton>
    <TvButton size="sm" variant="ghost" title="退出选择模式(同时清空已选)" @click="emit('exit')">✕ 退出</TvButton>
    <span class="spacer" />
    <TvButton size="sm" variant="primary" :disabled="!count" :loading="moving" @click="emit('move')">📤 移动到…</TvButton>
    <TvButton size="sm" variant="secondary" :disabled="!count" :loading="copying" @click="emit('copy')">📋 复制到…</TvButton>
    <TvButton size="sm" variant="danger" :disabled="!count" title="移入系统回收站(可还原)" @click="emit('del')">🗑 删除</TvButton>
  </div>
</template>

<style scoped>
.batch-bar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 6px 10px; margin-bottom: 10px;
  background: var(--panel2); border: 1px solid var(--border);
  border-radius: var(--r-sm);
  flex: 0 0 auto;
}
.bcnt { font-size: 12px; color: var(--muted); margin-right: 4px; }
.bcnt b { color: var(--accent); font-size: 14px; }
.spacer { flex: 1 1 auto; }
</style>
