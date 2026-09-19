<script setup>
/**
 * 结算历史 —— 导入 / 重命名 / 删除
 * ==============================
 * 对应旧版 cart.html 的 openHistory/importHistory/deleteHistory 与
 * series.html 的 histOpen/histRenameStart/histImport/histDelete(两份)。
 * 这里把「重命名」也补成正式按钮(旧版是在标题上双击才出现输入框, 不好发现)。
 */
import { ref, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvInput from '../base/TvInput.vue'
import TvState from '../base/TvState.vue'
import { api } from '@/utils/api.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { ts } from '@/utils/format.js'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])

const cart = useCartStore()
const ui = useUiStore()

const items = ref([])
const loading = ref(false)
const error = ref('')
const renaming = ref('')       // 正在重命名的旧名称
const renameText = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await api.cartHistory()
    items.value = d.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) { renaming.value = ''; load() } })

async function importOne(name) {
  if (!window.confirm(`将历史「${name}」的角色导入购物车?\n当前购物车内容将被覆盖`)) return
  try {
    const d = await api.cartDetail(name)
    if (d.error) { ui.err('导入失败: ' + d.error); return }
    cart.replaceAll(d.cart || {})
    emit('update:modelValue', false)
    ui.ok(`📥 已导入 ${Object.keys(d.cart || {}).length} 个角色, 可继续增删`, 2400)
  } catch (e) {
    ui.err('导入失败: ' + e.message)
  }
}

async function removeOne(name) {
  if (!window.confirm(`删除历史「${name}」?`)) return
  try {
    const d = await api.cartDelete(name)
    if (d.error) { ui.err('删除失败: ' + d.error); return }
    ui.ok('已删除')
    await load()
  } catch (e) {
    ui.err('删除失败: ' + e.message)
  }
}

function startRename(name) {
  renaming.value = name
  renameText.value = name
}

async function confirmRename() {
  const nn = renameText.value.trim()
  if (!nn || nn === renaming.value) { renaming.value = ''; return }
  try {
    const d = await api.cartRename(renaming.value, nn)
    if (d.error) { ui.err('重命名失败: ' + d.error); return }
    ui.ok('已重命名')
    renaming.value = ''
    await load()
  } catch (e) {
    ui.err('重命名失败: ' + e.message)
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="🕘 结算历史记录"
    size="lg"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">点击「导入」将该次结算的角色恢复到购物车继续编辑; 「删除」移除记录。</div>

    <TvState v-if="loading" state="loading" size="sm" inline />
    <TvState v-else-if="error" state="error" size="sm" :text="`加载失败: ${error}`" inline />
    <TvState
      v-else-if="!items.length"
      state="empty"
      size="sm"
      text="还没有结算记录, 先去购物车结算一次吧"
    />

    <div v-else class="hist-list">
      <div v-for="it in items" :key="it.name" class="hist-item">
        <template v-if="renaming === it.name">
          <TvInput v-model="renameText" size="sm" @enter="confirmRename" />
          <TvButton size="sm" variant="primary" @click="confirmRename">保存</TvButton>
          <TvButton size="sm" variant="ghost" @click="renaming = ''">取消</TvButton>
        </template>
        <template v-else>
          <div class="hist-info">
            <div class="hist-name">{{ it.name }}</div>
            <div class="hist-meta">{{ ts(it.created) }} · {{ it.count }} 个角色</div>
          </div>
          <div class="hist-actions">
            <TvButton size="xs" variant="success" @click="importOne(it.name)">📥 导入</TvButton>
            <TvButton size="xs" variant="secondary" @click="startRename(it.name)">✏️ 重命名</TvButton>
            <TvButton size="xs" variant="danger" @click="removeOne(it.name)">🗑 删除</TvButton>
          </div>
        </template>
      </div>
    </div>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; margin-bottom: 12px; line-height: 1.7; }
.hist-list { display: flex; flex-direction: column; gap: 8px; }
.hist-item {
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 10px 12px;
  display: flex; align-items: center; gap: 10px;
}
.hist-item:hover { border-color: var(--accent); }
.hist-info { flex: 1; min-width: 0; }
.hist-name { font-weight: 600; font-size: 13px; word-break: break-all; }
.hist-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
.hist-actions { display: flex; gap: 6px; flex-shrink: 0; }
</style>
