<script setup>
/**
 * 分段控件(Segmented Control) —— iOS/材料设计里最成熟的「互斥二选一」模式
 * ================================================================
 * 2026-10-21 标签页筛选重构时落地的通用件: 旧版把「来源」「扫描夹」两条筛选
 * 同时铺出来靠"灰掉另一条"表达互斥, 用户反馈看不懂也不好看 —— 改成一个胶囊
 * 开关, 点哪边哪边生效, 下面的 chips 行跟着换内容。
 *
 * 泛型设计(不绑定具体业务):
 *   options = [{ value, label, title? }], v-model = 当前选中的 value。
 *   样式就是用户点名的样子: 一个圆角胶囊, 滑块式的选中态(选中段实底反白)。
 */
import { computed } from 'vue'

const props = defineProps({
  /** [{value, label, title?}] */
  options: { type: Array, required: true },
  modelValue: { type: String, default: '' },
  /** 无障碍标签 */
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'change'])

const current = computed(() => {
  const v = props.modelValue
  return props.options.some((o) => o.value === v) ? v : (props.options[0]?.value ?? '')
})

function pick(v) {
  if (v === current.value) return
  emit('update:modelValue', v)
  emit('change', v)
}
</script>

<template>
  <div class="seg" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="tab"
      class="seg-opt"
      :class="{ on: o.value === current }"
      :title="o.title || ''"
      :aria-selected="o.value === current"
      @click="pick(o.value)"
    >{{ o.label }}</button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex; align-items: center; flex: 0 0 auto;
  background: var(--panel3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  padding: 2px;
  gap: 2px;
}
.seg-opt {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  font-size: 12px; line-height: 1; color: var(--muted);
  padding: 5px 12px; border-radius: var(--r-pill);
  white-space: nowrap;
  transition: background .12s ease, color .12s ease;
}
.seg-opt:hover { color: var(--text); }
.seg-opt.on {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.seg-opt:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
</style>
