<script setup>
/**
 * 我的清单 —— 载入 / 重命名 / 删除(2026-10-24 由「结算历史记录」改名)
 * ==================================================================
 * 存下来的不是"历史流水", 而是一份份可以切回来的角色名单:
 *   · 载入 = 把这份清单的角色放进购物车(替换当前内容)
 *   · 与购物车内容完全一致的那份挂「当前」角标(store 里的 activeList, 内容一改就取消)
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
  const tail = cart.count ? `\n当前购物车里的 ${cart.count} 个角色会被替换` : ''
  if (!window.confirm(`载入清单「${name}」?${tail}`)) return
  try {
    const d = await api.cartDetail(name)
    if (d.error) { ui.err('载入失败: ' + d.error); return }
    cart.replaceAll(d.cart || {})
    cart.setActiveList(name)
    emit('update:modelValue', false)
    ui.ok(`📥 已载入清单「${name}」(${Object.keys(d.cart || {}).length} 个角色), 可继续增删`, 2600)
  } catch (e) {
    ui.err('载入失败: ' + e.message)
  }
}

async function removeOne(name) {
  if (!window.confirm(`删除清单「${name}」? (购物车里的角色不受影响)`)) return
  try {
    const d = await api.cartDelete(name)
    if (d.error) { ui.err('删除失败: ' + d.error); return }
    if (cart.activeList === name) cart.setActiveList('')
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
  const old = renaming.value
  try {
    const d = await api.cartRename(old, nn)
    if (d.error) { ui.err('重命名失败: ' + d.error); return }
    if (cart.activeList === old) cart.setActiveList(nn)
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
    title="📁 我的清单"
    size="lg"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      「载入」把这份清单的角色放进购物车继续增删; 「重命名 / 删除」只动清单本身,
      不碰购物车、也不删任何图片。
    </div>

    <TvState v-if="loading" state="loading" size="sm" inline />
    <TvState v-else-if="error" state="error" size="sm" :text="`加载失败: ${error}`" inline />
    <TvState
      v-else-if="!items.length"
      state="empty"
      size="sm"
      text="还没有清单 —— 去购物车点「💾 存为清单」"
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
            <div class="hist-name">
              {{ it.name }}
              <span v-if="cart.activeList === it.name" class="cur">当前</span>
            </div>
            <div class="hist-meta">{{ ts(it.created) }} · {{ it.count }} 个角色</div>
          </div>
          <div class="hist-actions">
            <TvButton size="xs" variant="success" @click="importOne(it.name)">📥 载入</TvButton>
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
.cur {
  margin-left: 6px; padding: 1px 6px; border-radius: var(--r-pill);
  font-size: 10px; font-weight: 500; color: var(--accent); background: var(--accent-soft);
}
.hist-actions { display: flex; gap: 6px; flex-shrink: 0; }
</style>
