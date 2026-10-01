<script setup>
/**
 * 编辑购物车条目的「附加标签」(2026-10-01)
 * ========================================
 * 场景: WD14 认不出来的角色(如 columbina_(genshin_impact))导出时想带上
 * closed_eyes 这类 tag —— 给条目追加附加标签, 导出时拼在**同一行**:
 *   `columbina (genshin impact), closed eyes`
 * 必须同行: wildcard 是整行随机抽一条, 若把 closed_eyes 单独放一行,
 * 就会抽到"没有角色只有闭眼"的空 prompt。
 *
 * 编辑的是 useCartStore 里那条记录本身 -> watch(items, deep) 自动持久化 +
 * 上报主进程重算自动导出指纹, 不需要再发任何事件。
 */
import { ref, watch, computed } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvInput from '../base/TvInput.vue'
import TvButton from '../base/TvButton.vue'
import { useCartStore, normExtra } from '@/stores/useCartStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 正在编辑的条目(null = 关闭) */
  item: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue'])

const cart = useCartStore()
const text = ref('')
const target = ref(null)      // 弹窗开着期间固定的条目快照(引用同一对象)

watch(() => props.modelValue, (v) => {
  if (v && props.item) {
    target.value = props.item
    text.value = (Array.isArray(props.item.extra) ? props.item.extra : []).join(', ')
  }
  if (!v) target.value = null
})

/** 预览导出行(与文件口径一致: 下划线转空格、括号转义) */
const preview = computed(() => {
  if (!target.value) return ''
  const esc = (t) => String(t).replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/_/g, ' ')
  const extras = normExtra(text.value)
  return [esc(target.value.tag), ...extras.map((x) => esc(x))].join(', ')
})

function save() {
  if (!target.value) { emit('update:modelValue', false); return }
  cart.setExtra(target.value.tag, text.value)
  emit('update:modelValue', false)
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="✏️ 附加标签(导出时拼在同一行)"
    size="sm"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <template v-if="target">
      <div class="tip">
        给 <b>{{ target.name || target.tag }}</b> 追加的 tag, 导出 wildcard 时拼在角色后面。
        <span class="faint">例: 给哥伦比亚加 closed_eyes, 抽到她时就自带闭眼。</span>
      </div>

      <TvInput
        v-model="text"
        label="附加标签(逗号分隔, 留空 = 不附加)"
        placeholder="如: closed_eyes, barefoot"
        spellcheck="false"
      />

      <div v-if="preview" class="preview">
        <span class="lab">导出该行效果</span>
        <code>{{ preview }}</code>
      </div>
    </template>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="success" @click="save">✅ 保存</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 10px; }
.tip b { color: var(--accent); }
.faint { color: var(--faint); }
.preview {
  margin-top: 10px; padding: 8px 10px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-md);
  font-size: 12px; line-height: 1.6;
}
.preview .lab { display: block; color: var(--muted); font-size: 11px; margin-bottom: 3px; }
.preview code { color: var(--accent2); word-break: break-all; }
</style>
