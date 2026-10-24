<script setup>
/**
 * 存为清单弹窗(2026-10-24 由「结算」改名)
 * =======================================
 * 「结算」这个词让人以为在付款, 实际是「把当前选角存成一份可以切回来的清单」。
 * 动作全在 useCartStore().saveList(), 这里只负责取名、两个勾选与反馈。
 *
 * 旧版固定三步(导出 → 存历史 → 清空), 现在两步都可关:
 *   · 同时导出 wildcard —— 不导出就纯存清单, 不动磁盘
 *   · 保存后清空购物车 —— 不清空可以接着在里面调
 */
import { ref, watch, computed } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvInput from '../base/TvInput.vue'
import TvButton from '../base/TvButton.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'done'])

const cart = useCartStore()
const ui = useUiStore()

const name = ref('')
const busy = ref(false)
const alsoExport = ref(true)
const clearAfter = ref(true)

const count = computed(() => cart.count)

/** 默认名: 「YYYY-MM-DD HH:MM」 —— 同名会覆盖旧清单, 时间戳天然不会撞 */
function defaultName() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

watch(() => props.modelValue, (v) => {
  if (v) {
    name.value = defaultName()
    busy.value = false
    alsoExport.value = true
    clearAfter.value = true
  }
})

async function doSave() {
  const n = name.value.trim()
  if (!n) { ui.warn('请填写清单名称'); return }
  if (!cart.count) { ui.warn('购物车是空的, 先加几个角色'); return }
  const cnt = cart.count
  busy.value = true
  try {
    const r = await cart.saveList(n, { exportFile: alsoExport.value, clear: clearAfter.value })
    if (r.canceled) { ui.toast('已取消导出, 清单没有保存', 'info'); return }
    if (r.error) { ui.err(r.error); return }
    const tail = [
      `已存为清单「${n}」· ${cnt} 个角色`,
      r.exported ? '已导出 txt' : '',
      r.cleared ? '购物车已清空' : '',
    ].filter(Boolean).join(' · ')
    ui.ok(`✅ ${tail}`, 2800)
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
    title="💾 存为清单"
    size="sm"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      把购物车里的 <b>{{ count }}</b> 个角色存成一份<b>清单</b> ——
      之后在「📁 我的清单」里点「载入」就能切回来继续增删。<br>
      <span class="faint">清单只是角色名单, 不是文件; 想让 ComfyUI 用上, 勾下面的「同时导出」。</span>
    </div>

    <TvInput
      v-model="name"
      label="清单名称"
      placeholder="如: 蓝档案泳装组"
      title="同名会覆盖原来那份清单"
    />

    <div class="opts">
      <TvCheckbox
        v-model="alsoExport"
        label="同时导出 wildcard txt"
        title="存清单的同时弹「另存为」导一份 txt; 取消导出窗口 = 这次什么都不存"
      />
      <TvCheckbox
        v-model="clearAfter"
        label="保存后清空购物车"
        title="清空只是腾出购物车, 清单已经存好了; 关掉可以存完接着调"
      />
    </div>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="busy" @click="doSave">💾 存为清单</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 6px; }
.tip b { color: var(--accent); }
.faint { color: var(--faint); font-size: 11px; }
.opts { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
</style>
