<script setup>
/**
 * 替换规则组选择器(2026-10-04)
 * ---------------------------------------------
 * 三个导出入口(看板导出菜单 / 预设编辑表单 / 购物车抽屉与购物车页)共用这一个组件。
 * 规则组本身在 🔁 替换规则弹窗里维护; 这里只读列表 + 点选。
 *
 * **为什么用 chips 而不是 TvSelect(原生 <select>)**:
 * 原生 select 的下拉弹窗由 GPU 合成, 在 Electron + 弹窗容器(CSS transform/遮罩)
 * 组合下会出现"点开了点不动/弹到别处"的问题(2026-10-04 用户实测: 规则组下拉
 * 之后点不开)。chips 就是普通 span + click, 没有这层依赖; 而组数本来是个位数,
 * 横排点选比下拉更快。
 *
 * **只有一套规则时整条不渲染** —— 多数用户只有一套, 多一排 chips 纯属噪声。
 */
import { ref, onMounted } from 'vue'
import TvChip from '../base/TvChip.vue'
import { api } from '@/utils/api.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: '替换规则' },
  /** 强制显示(只有一套时也显示) —— 编辑预设这种"告诉用户存在这套规则"的场合 */
  always: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'loaded'])

const sets = ref([])
const failed = ref(false)
const loaded = ref(false)

onMounted(async () => {
  try {
    const r = await api.replaceSets()
    sets.value = r.sets || []
    // 首次拿到就把当前选中纠正成真实存在的 id(空串 = 默认组)
    if (!sets.value.some((s) => s.id === props.modelValue)) {
      emit('update:modelValue', r.active || sets.value[0]?.id || '')
    }
  } catch {
    failed.value = true      // 读不到就整条隐藏, 绝不让导出入口因为一个选择器挂掉
  } finally {
    loaded.value = true
    emit('loaded', sets.value)
  }
})
</script>

<template>
  <div v-if="loaded && !failed && (always || sets.length > 1)" class="setpick">
    <span v-if="label" class="lb">{{ label }}</span>
    <TvChip
      v-for="s in sets"
      :key="s.id"
      :label="s.name"
      :active="modelValue === s.id"
      @click="emit('update:modelValue', s.id)"
    />
  </div>
</template>

<style scoped>
.setpick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lb { font-size: 12px; color: var(--muted); }
</style>
