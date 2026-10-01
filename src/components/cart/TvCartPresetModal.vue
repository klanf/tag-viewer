<script setup>
/**
 * 购物车自动导出 —— 独立弹窗
 * ==========================
 * 从购物车抽屉里的「⚙ 自动导出」进来。抽屉是全站的(任何视图都能唤起),
 * 而「导出预设」弹窗只挂在首页 —— 所以购物车这条必须有个自己的宿主,
 * 不然在扫描页/详情页开了抽屉就没法配置。
 *
 * 主体是共用组件 TvCartPresetSection.vue(「导出预设」弹窗里也内嵌了同一个),
 * 只在这里套一层 TvModal。
 */
import TvModal from '../base/TvModal.vue'
import TvCartPresetSection from './TvCartPresetSection.vue'

defineProps({ modelValue: { type: Boolean, default: false } })
defineEmits(['update:modelValue'])
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="🛒 购物车自动导出"
    size="lg"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <TvCartPresetSection />
  </TvModal>
</template>
