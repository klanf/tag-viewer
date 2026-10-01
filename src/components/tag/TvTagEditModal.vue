<script setup>
/**
 * 标签改名 / 删除弹窗(2026-10-01)
 * ================================
 * 入口: 标签详情页(/tags/:tag)头部的 ✏️ —— 正在看哪个标签就编辑哪个。
 *
 * 两种操作(主进程 core/tagedit.js 实现, 三重保险: 预览 -> 备份 -> 事务):
 *   · **改名**: 全库把该标签换成新名(逗号 token 精确匹配, 不会误伤含它的长标签),
 *     顺带同步翻译库/角色库的 key、tags 总表; kind 由"括号=角色"正则重算 ——
 *     frieren -> frieren_(sousou_no_frieren) 改完自动变成角色标签并归对系列。
 *   · **删除**: 可留空全删; 也可填一个「范围标签」只删同时含有它的图 ——
 *     例: 范围=columbina_(genshin_impact) 删 closed_eyes, 全库其他 closed_eyes 不动。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvInput from '../base/TvInput.vue'
import TvButton from '../base/TvButton.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 正在编辑的标签名 */
  tag: { type: String, default: '' },
  /** 该标签当前的图数(详情页手头就有, 顺手展示) */
  count: { type: Number, default: null },
})
const emit = defineEmits(['update:modelValue', 'renamed', 'deleted'])

const ui = useUiStore()

const op = ref('rename')          // rename | delete
const to = ref('')
const scopeTag = ref('')
const preview = ref(null)         // { count, existsTarget }
const busy = ref(false)

watch(() => props.modelValue, (v) => {
  if (v) {
    op.value = 'rename'
    to.value = ''
    scopeTag.value = ''
    preview.value = null
    busy.value = false
  }
})

const canGo = computed(() => {
  if (!props.tag) return false
  if (op.value === 'rename') return !!to.value.trim() && to.value.trim() !== props.tag
  return true
})

async function doPreview() {
  busy.value = true
  try {
    preview.value = await api.tagsEditPreview({
      op: op.value,
      from: props.tag,
      to: to.value.trim(),
      scopeTag: scopeTag.value.trim(),
    })
  } catch (e) {
    ui.err(e.message)
  } finally {
    busy.value = false
  }
}

async function doApply() {
  busy.value = true
  try {
    const r = await api.tagsEditApply({
      op: op.value,
      from: props.tag,
      to: to.value.trim(),
      scopeTag: scopeTag.value.trim(),
    })
    const syncNote = r.synced?.translations === 'renamed' ? ', 翻译/角色库已同步' : ''
    if (op.value === 'rename') {
      ui.ok(`✅ 已改名 ${props.tag} → ${to.value.trim()}(命中 ${r.changed} 张图${syncNote})`, 'ok', 4200)
      emit('renamed', to.value.trim())
    } else {
      ui.ok(`✅ 已删除「${props.tag}」(命中 ${r.changed} 张图${r.scopeTag ? `, 范围=${r.scopeTag}` : ''})`, 'ok', 4200)
      emit('deleted')
    }
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('执行失败: ' + e.message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    :title="`✏️ 编辑标签: ${tag}`"
    size="sm"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">
      <template v-if="count !== null">当前 <b>{{ count }}</b> 张图带这个标签。</template>
      改动会先<b>备份 tags.db</b> 再事务写入, 出问题可回滚。
    </div>

    <div class="ops">
      <label :class="['op', { on: op === 'rename' }]">
        <input v-model="op" type="radio" value="rename"> ✏️ 改名(全库替换)
      </label>
      <label :class="['op', { on: op === 'delete' }]">
        <input v-model="op" type="radio" value="delete"> 🗑 删除(可圈范围)
      </label>
    </div>

    <template v-if="op === 'rename'">
      <TvInput
        v-model="to"
        label="改成(逗号 token 精确替换, 不会误伤包含它的长标签)"
        :placeholder="`如: ${tag}_(某系列)`"
        spellcheck="false"
      />
      <p class="note">
        改名后 tags 总表 / 翻译 / 角色库一并同步; 新名带 <code>xxx_(系列)</code> 括号
        就会自动识别为角色标签并归到对应系列。
      </p>
    </template>

    <template v-else>
      <TvInput
        v-model="scopeTag"
        label="范围标签(留空 = 全库都删; 填了 = 只删同时含有它的图)"
        placeholder="如: columbina_(genshin_impact)"
        spellcheck="false"
      />
    </template>

    <div v-if="preview" class="pv">
      将命中 <b>{{ preview.count }}</b> 张图
      <span v-if="op === 'rename' && preview.existsTarget" class="warn">
        (目标名已存在 —— 执行后两边计数会合并)
      </span>
    </div>

    <template #footer>
      <TvButton variant="secondary" :disabled="busy" @click="doPreview">🔢 预览影响</TvButton>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton :variant="op === 'rename' ? 'success' : 'danger'" :loading="busy" :disabled="!canGo" @click="doApply">
        {{ op === 'rename' ? '✅ 执行改名' : '🗑 执行删除' }}
      </TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 10px; }
.tip b { color: var(--accent); }
.ops { display: flex; gap: 8px; margin-bottom: 12px; }
.op {
  flex: 1; display: flex; align-items: center; gap: 6px;
  padding: 7px 10px; font-size: 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-md);
  cursor: pointer;
}
.op.on { border-color: var(--accent); color: var(--accent); }
.note { color: var(--faint); font-size: 11px; line-height: 1.7; margin: 8px 0 0; }
.note code { color: var(--accent2); }
.pv {
  margin-top: 10px; padding: 7px 10px; font-size: 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-md);
}
.pv b { color: var(--accent); }
.pv .warn { color: var(--warn); }
</style>
