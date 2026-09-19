<script setup>
/**
 * 规则编辑器 —— 黑名单 / 替换规则共用一个弹窗
 * ==========================================
 * 旧版是两块几乎一模一样的 DOM(.bl-mask + textarea + 保存/取消),
 * 只有标题、提示文案、两个接口不同。这里用 kind 区分。
 *
 * 规则语法(两侧一致, 用户已经习惯):
 *   精确  red_hair      后缀  *_hair      前缀  blue_*      包含  *color*
 *   # 开头是注释; 替换规则写成 模式 -> 替换后(可多个, 逗号分隔)
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** blacklist | replace */
  kind: { type: String, default: 'blacklist' },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const ui = useUiStore()

const text = ref('')
const rules = ref([])
const bg = ref(null)
const loading = ref(false)
const saving = ref(false)

const isBlack = computed(() => props.kind === 'blacklist')
const title = computed(() => (isBlack.value ? '🚫 导出黑名单' : '🔁 导出替换规则'))

const tips = computed(() => (isBlack.value
  ? ['每行一条规则(用下划线), 导出时自动剔除命中的标签',
     'red_hair 精确 · *_hair 后缀 · blue_* 前缀 · *color* 包含 · # 注释']
  : ['每行一条: 模式 -> 替换后的标签(替换后可跟多个, 逗号分隔)',
     '通配同黑名单: *boy -> boy, shota 会把 1boy/2boy/boy 都替换成 boy, shota',
     '精确 red_hair -> brown_hair · # 注释']))

const placeholder = computed(() => (isBlack.value
  ? 'red_hair\n*_hair\n# 这是注释'
  : '*boy -> boy, shota\n1girl -> girl, adult'))

async function load() {
  loading.value = true
  try {
    const r = isBlack.value ? await api.blacklistGet() : await api.replaceGet()
    text.value = r.text || ''
    rules.value = r.rules || []
    // 背景补全配置顺带显示出来(只读) —— 否则用户改完黑名单
    // 会奇怪"为什么复制还是自动补了 scenery"
    if (!bg.value) { try { bg.value = await api.bgGet() } catch { bg.value = null } }
  } catch (e) {
    ui.err('读取规则失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v) load() })

async function save() {
  saving.value = true
  try {
    const r = isBlack.value
      ? await api.blacklistSave(text.value)
      : await api.replaceSave(text.value)
    if (r?.error) { ui.err('保存失败: ' + r.error); return }
    rules.value = r?.rules || rules.value
    await api.rulesReload()
    ui.ok('✅ 已保存, 立即生效', 2000)
    emit('saved')
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('保存失败: ' + e.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    :title="title"
    size="md"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      <div v-for="(t, i) in tips" :key="i">{{ t }}</div>
    </div>

    <div v-if="loading" class="loading">读取中...</div>
    <textarea
      v-else
      v-model="text"
      class="editor"
      spellcheck="false"
      :placeholder="placeholder"
    />

    <div class="stat">
      当前生效 <b>{{ rules.length }}</b> 条规则
      <template v-if="bg && bg.append && bg.append.length">
        · 🌄 缺背景时补 <b>{{ bg.append.join('/') }}</b>
        <span class="faint">(有 {{ (bg.have || []).length }} 个判定标签)</span>
      </template>
    </div>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="saving" @click="save">💾 保存</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 10px; }
.editor {
  width: 100%;
  min-height: 300px;
  background: var(--panel2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 1.65;
  resize: vertical;
  outline: none;
}
.editor:focus { border-color: var(--accent); }
.loading { color: var(--muted); font-size: 12px; padding: 20px 0; }
.stat { color: var(--muted); font-size: 11px; margin-top: 10px; }
.stat b { color: var(--accent); }
.faint { color: var(--faint); }
</style>
