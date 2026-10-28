<script setup>
/**
 * 槽位归类选择器(2026-10-28 光箱手动归类)
 * =========================================
 * 「这个 tag 分错组了 / 我想让它单独一组」的出口: 光箱标签悬停出 🏷 图标,
 * 点开这个弹层, 从现有槽位里挑一个(或输入新分组名), 写进
 * dataDir/tag_slot_overrides.json —— knowledge/tag_slots.json 是构建产物
 * (重跑 build-tag-slots.mjs 会覆盖), 所以手动归类必须落独立的用户层文件,
 * 主进程在 tags:cats 下发时覆盖合并。
 *
 * 生效路径: app.setTagSlot 成功后就地更新 tagSlots 缓存 -> TvTagList 的分组
 * computed 重排, 不用重拉 tags:cats、更不用重启。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvChip from '../base/TvChip.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  tag: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const app = useAppStore()
const ui = useUiStore()
const q = ref('')
const custom = ref('')
const busy = ref(false)
const note = ref('')

/** 标签当前分组(含手动归类后的新值) */
const current = computed(() => app.slotOf(props.tag))

const list = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const arr = app.slotMeta || []
  if (!kw) return arr
  return arr.filter((s) => s.slot.toLowerCase().includes(kw) || (s.zh || '').toLowerCase().includes(kw))
})

watch(() => props.modelValue, (v) => { if (v) { q.value = ''; custom.value = ''; note.value = '' } })

async function apply(slot, zh = '') {
  if (!props.tag || busy.value) return
  if (slot) slot = slot.trim()
  busy.value = true
  note.value = ''
  try {
    await app.setTagSlot(props.tag, slot, zh)
    ui.ok(slot ? `「${props.tag}」已归到「${zh || slot}」` : `「${props.tag}」已取消手动归类`, 2200)
    emit('update:modelValue', false)
  } catch (e) {
    note.value = `归类失败: ${e.message}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="🏷 手动归类"
    size="md"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="sp">
      <p class="cur">
        标签 <b class="tg">{{ tag }}</b> 当前分组:
        <b>{{ current || '(无 · 落在粗大类兜底桶)' }}</b>
      </p>

      <input v-model="q" class="q" placeholder="搜索现有分组(头饰/腿袜/姿势/景别...)" :disabled="busy">

      <div class="chips">
        <TvChip
          v-for="s in list"
          :key="s.slot"
          :label="s.zh || s.slot"
          :active="current === (s.zh || s.slot)"
          @click="apply(s.slot, s.zh)"
        />
        <span v-if="!list.length" class="none">没有匹配的分组</span>
      </div>

      <div class="row">
        <input
          v-model="custom"
          class="q"
          placeholder="或输入一个新分组名(如 机甲细节)"
          :disabled="busy"
          @keyup.enter="apply(custom, custom)"
        >
        <TvButton size="sm" variant="primary" :disabled="busy || !custom.trim()" @click="apply(custom, custom)">
          归到这里
        </TvButton>
      </div>

      <div class="row">
        <TvButton size="sm" :disabled="busy" @click="apply('')">取消手动归类(回到词典默认)</TvButton>
        <span class="faint">手动归类存于 data/tag_slot_overrides.json, 重新构建词典不会覆盖</span>
      </div>

      <p v-if="note" class="note">{{ note }}</p>
    </div>
  </TvModal>
</template>

<style scoped>
.sp { display: flex; flex-direction: column; gap: 10px; }
.cur { margin: 0; font-size: 12px; color: var(--muted); }
.cur .tg { color: var(--text); }
.cur b { color: var(--accent); }
.q {
  height: 28px; padding: 0 9px; font-size: 12px;
  background: var(--panel3); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 300px; overflow-y: auto; }
.none { color: var(--faint); font-size: 11px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row .q { flex: 1; min-width: 180px; }
.faint { color: var(--faint); font-size: 11px; }
.note {
  margin: 0; font-size: 11px; color: var(--err, #d05a5a);
  background: var(--panel3); border-radius: var(--r-sm); padding: 6px 8px;
}
</style>
