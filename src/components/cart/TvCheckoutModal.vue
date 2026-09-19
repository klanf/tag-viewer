<script setup>
/**
 * 结算弹窗 —— 命名 -> 导出 wildcard -> 存历史 -> 清空
 * ================================================
 * 旧版 cart.html 的 openCheckout/doCheckout 与 series.html 的
 * checkoutOpen/checkoutDo 是两份实现(默认名格式、导出格式都要各维护一次)。
 * 现在动作全在 useCartStore().checkout(), 这里只负责取名与反馈。
 */
import { ref, watch, computed } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvInput from '../base/TvInput.vue'
import TvButton from '../base/TvButton.vue'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'done'])

const cart = useCartStore()
const ui = useUiStore()

const name = ref('')
const busy = ref(false)

const count = computed(() => cart.count)

/** 默认名: 与旧版一致的「YYYY-MM-DD HH:MM」 */
function defaultName() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

watch(() => props.modelValue, (v) => {
  if (v) { name.value = defaultName(); busy.value = false }
})

async function doCheckout() {
  const n = name.value.trim()
  if (!n) { ui.warn('请填写历史记录名称'); return }
  busy.value = true
  try {
    const r = await cart.checkout(n)
    if (r.canceled) { ui.toast('已取消导出', 'info'); return }
    if (r.error) { ui.err(r.error); return }
    ui.ok(`✅ 已结算 ${r.count} 个角色并存入历史: ${n}`, 2600)
    emit('update:modelValue', false)
    emit('done', r)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="💳 结算购物车"
    size="sm"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      结算后: 导出标签(wildcard) → 保存到历史记录 → 清空购物车<br>
      历史记录支持自定义命名, 之后可导入继续增删。<br>
      当前购物车 <b>{{ count }}</b> 个角色。
    </div>

    <TvInput v-model="name" label="历史记录名称(可自定义)" placeholder="如: 蓝档案泳装组 2026-08-31" />

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="warn" :loading="busy" @click="doCheckout">✅ 确认结算</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 6px; }
.tip b { color: var(--accent); }
</style>
