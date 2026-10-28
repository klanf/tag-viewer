<script setup>
/**
 * 安全模式设置台
 * ==============
 * 三件事: 开关 / 档位 / 改集合。
 *
 * 设计上的两个刻意取舍:
 *  1. **默认关闭**。实测 core 档会藏掉 58% 的图(edge 档 90%), 这种东西不能
 *     默认开 —— 打开与否必须由用户明确决定。
 *  2. 统计数字写得很显眼("会隐藏 N / M 张")。用户改一个标签就能看到影响多少张,
 *     否则调口径完全靠猜。
 *
 * 集合的两种改法都在这里: 点标签移出(适合微调), 或直接编辑原始文本(适合
 * 大改 / 加通配规则)。后者保存后会重算全部标记, 看板立刻按新集合显示。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
import TvChip from '../base/TvChip.vue'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { nfmt } from '@/utils/format.js'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])

const safety = useSafetyStore()
const busy = ref(false)
const note = ref('')
const text = ref('')
const showText = ref(false)
const newTag = ref('')
const newSec = ref('L4')

/** 等级标尺(与槽位词典同一把尺): 上限选 N, unsafe > N 的图藏 */
const LEVEL_CHIPS = [
  { lv: 4, label: '≤L4 · 全显示' },
  { lv: 3, label: '≤L3 · 藏极端(L4)' },
  { lv: 2, label: '≤L2 · 藏露骨(L3+)' },
  { lv: 1, label: '≤L1 · 藏暗示(L2+)' },
  { lv: 0, label: '≤L0 · 只留常规' },
]
const SEC_LABEL = {
  L0: '常规', L1: '擦边', L2: '明显暗示', L3: '露骨', L4: '极端',
}
const SEC_TONES = { L0: 'ok', L1: '', L2: 'warn', L3: 'warn', L4: 'danger' }

const pct = computed(() => (
  safety.total ? `${((safety.hiddenCount / safety.total) * 100).toFixed(1)}%` : '—'
))
const hintText = computed(() => (safety.mode === 'unsafe'
  ? '开启后只保留超过显示上限的图, 其余全部不渲染 —— 这是安全模式的取反。只影响显示, 库里的数据一行不动, 关掉立刻全回来。'
  : '开启后, 超过「显示上限」的图(图内任一标签的等级更高)在看板里不再渲染。等级与槽位词典同一把 0-4 的尺; 下面各段的标签会覆盖词典档位, 写 [L0] 可以把敏感词拉回常规。'))

watch(() => props.modelValue, async (v) => {
  if (!v) return
  note.value = ''
  showText.value = false
  busy.value = true
  try {
    await safety.load()
    text.value = await safety.loadText()
  } catch (e) {
    note.value = `读取失败: ${e.message}`
  } finally {
    busy.value = false
  }
})

async function onToggle(v) {
  try { await safety.set({ on: v }) } catch (e) { note.value = e.message }
}

async function setLevel(lv) {
  if (safety.maxLevel === lv) return
  try { await safety.set({ maxLevel: lv }) } catch (e) { note.value = e.message }
}

/** 切「安全 / 不安全」显示方式。
 *  选完却不开开关的话画面毫无变化, 用户会以为没生效 —— 所以一并打开过滤。 */
async function setMode(m) {
  if (safety.mode === m) return
  try {
    await safety.set({ mode: m, on: true })
    note.value = m === 'unsafe'
      ? '已切到「不安全模式」并开启 —— 现在只显示命中敏感标签的图'
      : '已切回「安全模式」并开启 —— 敏感图不再显示'
  } catch (e) {
    note.value = e.message
  }
}

async function toggleTag(tag, sec) {
  busy.value = true
  try {
    const r = await safety.toggleTag(tag, sec)
    if (r?.wildcard) {
      note.value = `「${tag}」是被通配规则 ${r.wildcard} 命中的 —— 要改得在下面的原始文本里改`
    } else if (r?.note) {
      note.value = r.note
    } else {
      note.value = `已${r?.inSet ? `加入 ${sec} 段` : '移出'}: ${tag}`
    }
    text.value = await safety.loadText()
  } catch (e) {
    note.value = `操作失败: ${e.message}`
  } finally {
    busy.value = false
  }
}

async function addTag() {
  const t = String(newTag.value || '').trim().toLowerCase().replace(/\s+/g, '_')
  if (!t) return
  await toggleTag(t, newSec.value)
  newTag.value = ''
}

async function saveText() {
  busy.value = true
  try {
    await safety.saveText(text.value)
    note.value = '集合已保存 · 标记已重算 · 看板立刻按新集合显示'
  } catch (e) {
    note.value = `保存失败: ${e.message}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="🛡 安全模式"
    size="lg"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="sf">
      <div class="top">
        <TvCheckbox
          :model-value="safety.on"
          :label="safety.on ? '已开启' : '已关闭（默认）'"
          :is-switch="true"
          @update:model-value="onToggle"
        />
        <p class="hint">{{ hintText }}</p>
      </div>

      <div class="row">
        <span class="lab">显示方式</span>
        <TvChip
          label="安全模式 · 隐藏敏感图"
          :active="safety.mode === 'safe'"
          @click="setMode('safe')"
        />
        <TvChip
          label="不安全模式 · 只显示敏感图（取反）"
          :active="safety.mode === 'unsafe'"
          @click="setMode('unsafe')"
        />
      </div>

      <div class="row">
        <span class="lab">显示上限</span>
        <TvChip
          v-for="c in LEVEL_CHIPS"
          :key="c.lv"
          :label="c.label"
          :active="safety.maxLevel === c.lv"
          @click="setLevel(c.lv)"
        />
      </div>

      <div class="stat">
        当前上限在<b>整个库</b>里会隐藏
        <b>{{ nfmt(safety.hiddenCount) }}</b> / {{ nfmt(safety.total) }} 张
        <span class="faint">（{{ pct }}）</span>
        <span v-if="safety.mode === 'unsafe'" class="faint">
          · 不安全模式下只保留超过上限的 {{ nfmt(safety.sensitiveCount) }} 张
        </span>
      </div>
      <!-- 这里的口径刻意是"整个库"(改集合看的是全局影响); 各页面工具栏上那个
           数字是"当前列表"的 —— 两者不是一回事, 所以把它写出来, 免得对不上时困惑。 -->
      <div class="tip-mini">
        工具栏上那个 −N 是<b>当前页面 / 当前来源</b>会隐藏的张数，跟这里的全库数字不同。
      </div>

      <section v-for="sec in ['L4', 'L3', 'L2', 'L1', 'L0']" :key="sec">
        <h4>
          [{{ sec }}] {{ (safety.secs[sec] || []).length }} 个标签
          <span class="faint">{{ SEC_LABEL[sec] }} · 点标签可移出</span>
        </h4>
        <div class="tags">
          <TvChip
            v-for="t in safety.secs[sec] || []"
            :key="`${sec}-${t}`"
            :label="t"
            removable
            :tone="SEC_TONES[sec]"
            @remove="toggleTag(t, sec)"
          />
        </div>
      </section>

      <div class="row add">
        <input
          v-model="newTag"
          class="tin"
          placeholder="加一个标签，如 nipples 或 *bikini*（支持 * 通配）"
          :disabled="busy"
          @keyup.enter="addTag"
        >
        <select v-model="newSec" class="tsel" :disabled="busy">
          <option v-for="sec in ['L0', 'L1', 'L2', 'L3', 'L4']" :key="sec" :value="sec">
            加到 {{ sec }}（{{ SEC_LABEL[sec] }}）
          </option>
        </select>
        <TvButton size="sm" :disabled="busy" @click="addTag">加入</TvButton>
      </div>

      <div class="row">
        <TvButton size="sm" :disabled="busy" @click="showText = !showText">
          {{ showText ? '收起原始文本' : '编辑原始文本（适合大改 / 加通配）' }}
        </TvButton>
      </div>

      <div v-if="showText" class="edit">
        <textarea v-model="text" class="tarea" spellcheck="false" :disabled="busy" />
        <div class="row">
          <TvButton size="sm" variant="primary" :disabled="busy" @click="saveText">保存并重算</TvButton>
          <span class="faint">文件: {{ safety.file || '(dataDir)/safety_tags.txt' }}</span>
        </div>
      </div>

      <p v-if="note" class="note">{{ note }}</p>
    </div>
  </TvModal>
</template>

<style scoped>
.sf { display: flex; flex-direction: column; gap: 12px; }
.top { display: flex; flex-direction: column; gap: 6px; }
.hint { margin: 0; font-size: 11px; color: var(--muted); line-height: 1.6; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lab { font-size: 11px; color: var(--muted); }
.stat { font-size: 13px; color: var(--text); }
.stat b { color: var(--warn); font-size: 15px; }
.faint { color: var(--faint); font-size: 11px; margin-left: 6px; }
/* 说明"工具栏那个数字是当前范围、这里是全库"那一行 —— 独占一行, 不跟着 .faint 的左缩进 */
.tip-mini { margin-top: 4px; font-size: 11px; color: var(--faint); line-height: 1.55; }
.tip-mini b { color: var(--muted); font-weight: 600; }
section h4 {
  margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--muted);
}
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.add .tin, .tsel {
  height: 26px; padding: 0 8px; font-size: 11px;
  background: var(--panel3); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.add .tin { flex: 1; min-width: 200px; }
.edit { display: flex; flex-direction: column; gap: 8px; }
.tarea {
  width: 100%; min-height: 220px; max-height: 380px; resize: vertical;
  font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.6;
  background: var(--panel3); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px;
}
.note {
  margin: 0; font-size: 11px; color: var(--accent2);
  background: var(--panel3); border-radius: var(--r-sm); padding: 6px 8px;
}
</style>
