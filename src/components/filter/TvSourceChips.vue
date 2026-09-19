<script setup>
/**
 * 来源筛选条 —— 首页 / 标签页 / 扫描页共用
 * ========================================
 * 语义与原版一致(别改, 用户已经习惯了):
 *   空数组 = 全部; 点单个来源 = 累加多选; 再点一次 = 取消; 点「全部」= 重置。
 * 选超过 1 个时末尾补一个"已选 N 个来源"的提示胶囊(原版是硬塞进 DOM 的)。
 */
import { computed } from 'vue'
import TvChip from '../base/TvChip.vue'

const props = defineProps({
  /** [{name, images}] */
  sources: { type: Array, default: () => [] },
  /** 选中的来源名数组; 空 = 全部 */
  modelValue: { type: Array, default: () => [] },
  /** 「全部」胶囊上显示的总数 */
  total: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'change'])

const isAll = computed(() => !props.modelValue.length)

function isActive(name) {
  return name === '全部' ? isAll.value : props.modelValue.includes(name)
}

function toggle(name) {
  const next = name === '全部'
    ? []
    : (props.modelValue.includes(name)
        ? props.modelValue.filter((n) => n !== name)
        : [...props.modelValue, name])
  emit('update:modelValue', next)
  emit('change', next)
}
</script>

<template>
  <div class="src-bar">
    <span class="lb">📂 来源:</span>
    <TvChip
      label="全部"
      :count="total"
      :active="isActive('全部')"
      @click="toggle('全部')"
    />
    <TvChip
      v-for="s in sources"
      :key="s.name"
      :label="s.name"
      :count="s.images"
      :active="isActive(s.name)"
      @click="toggle(s.name)"
    />
    <span v-if="modelValue.length > 1" class="more">已选 {{ modelValue.length }} 个来源</span>
    <span v-if="loading" class="more">统计中...</span>
  </div>
</template>

<style scoped>
.src-bar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}
.lb { color: var(--muted); font-size: 12px; margin-right: 2px; flex: 0 0 auto; }
.more { color: var(--muted); font-size: 11px; opacity: .7; padding: 0 4px; }
</style>
