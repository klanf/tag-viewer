<script setup>
/**
 * 随机抽签弹层 —— pin 固定 + 段级权重窗口 + 查重降权
 * ============================================================
 * 引擎在主进程(electron/core/random.js), CLI(scripts/random-prompt.mjs)与本弹层共用。
 *
 * 界面只暴露最常用的一层: 段级权重滑条(0=永不 / 1=默认 / 3=必现) + pin 输入 +
 * 词条数瞄准 + 档位。细槽与槽内选项级的权重留给 CLI 的 --profile(JSON) 进阶玩家。
 */
import { ref, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvChip from '../base/TvChip.vue'
import { api } from '@/utils/api.js'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])

const SEG_LABEL = {
  hair: '头发/特征', face: '表情', outfit: '服饰', pose: '姿势',
  camera: '镜头', scene: '场景', nsfw: 'NSFW',
}
const W_TICKS = [
  { v: 0, label: '0 不出' },
  { v: 1, label: '1 默认' },
  { v: 2, label: '2 偏好' },
  { v: 3, label: '3 必现' },
]

const meta = ref(null)
const busy = ref(false)
const note = ref('')
const err = ref('')
const results = ref([])
const warns = ref([])
// 抽签参数
const n = ref(3)
const level = ref(0)
const tagsTarget = ref('')
const pinText = ref('')
const seedText = ref('')
const segW = ref({})      // seg -> 0..3(空缺 = 默认 1)
const copied = ref('')

watch(() => props.modelValue, async (v) => {
  if (!v) return
  err.value = ''
  note.value = ''
  results.value = []
  warns.value = []
  if (!meta.value) {
    try { meta.value = await api.random.meta() } catch (e) { err.value = e.message }
  }
})

function parsePins() {
  return pinText.value.split(/[,，|]/).map((s) => s.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean)
}

async function draw() {
  busy.value = true
  err.value = ''
  note.value = ''
  copied.value = ''
  try {
    const profile = { sections: {} }
    for (const [k, v] of Object.entries(segW.value)) {
      if (v !== 1 && Number.isFinite(Number(v))) profile.sections[k] = Number(v)
    }
    const r = await api.random.draw({
      n: Math.max(1, Math.min(50, parseInt(n.value) || 1)),
      level: level.value,
      pins: parsePins(),
      profile,
      tagsTarget: tagsTarget.value ? parseInt(tagsTarget.value) : null,
      seed: seedText.value ? seedText.value : null,
      save: true,
    })
    if (r.error) { err.value = r.error; return }
    results.value = r.results || []
    warns.value = r.warns || []
    if (!results.value.length) note.value = '没有抽出内容 —— 检查权重是否全调成了 0'
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}

async function copyOne(i) {
  const text = results.value[i]?.tags.join(', ') || ''
  await api.clipboard.copy(text)
  copied.value = `#${i + 1}`
  setTimeout(() => { if (copied.value === `#${i + 1}`) copied.value = '' }, 1500)
}

async function copyAll() {
  const text = results.value.map((r) => r.tags.join(', ')).join('\n')
  await api.clipboard.copy(text)
  copied.value = 'all'
  setTimeout(() => { if (copied.value === 'all') copied.value = '' }, 1500)
}

async function resetCounts() {
  try {
    await api.random.resetCounts()
    note.value = '查重记账已清零 —— 下次抽签不再受历史影响'
  } catch (e) { note.value = `清零失败: ${e.message}` }
}
</script>

<template>
  <TvModal v-model="props.modelValue" title="随机抽签" size="lg" :mask-closable="false">
    <div class="rd">
      <!-- 参数区 -->
      <div class="row">
        <span class="lab">条数</span>
        <input v-model="n" class="tin num" type="number" min="1" max="50" />
        <span class="lab">档位</span>
        <select v-model.number="level" class="tin">
          <option :value="0">0 全年龄</option>
          <option :value="1">1 擦边</option>
          <option :value="2">2 明显</option>
          <option :value="3">3 露骨</option>
          <option :value="4">4 不限</option>
        </select>
        <span class="lab" title="瞄准的词条数(±2), 留空不控制">词条数</span>
        <input v-model="tagsTarget" class="tin num" type="number" min="6" max="60" placeholder="自动" />
        <span class="lab" title="固定种子可复现; 留空每次随机">种子</span>
        <input v-model="seedText" class="tin seed" placeholder="随机" />
      </div>
      <div class="row">
        <span class="lab">固定 pin</span>
        <input
          v-model="pinText"
          class="tin grow"
          placeholder="逗号分隔, 如: standing, hands_in_pocket —— 冲突会报错不静默替换"
          @keydown.enter="draw"
        />
      </div>

      <!-- 权重窗口(段级) -->
      <div class="sec-title">权重窗口（0 = 该段不出 · 3 = 必现）</div>
      <div class="seg-grid">
        <div v-for="seg in (meta?.sections || [])" :key="seg" class="seg-row">
          <span class="seg-name">{{ SEG_LABEL[seg] || seg }}</span>
          <div class="ticks">
            <button
              v-for="t in W_TICKS"
              :key="t.v"
              class="tick"
              :class="{ on: (segW[seg] ?? 1) === t.v }"
              :title="t.label"
              @click="segW[seg] = t.v"
            >{{ t.v }}</button>
          </div>
        </div>
      </div>

      <div class="actions">
        <TvButton variant="primary" :disabled="busy" @click="draw">{{ busy ? '抽取中…' : '🎲 抽签' }}</TvButton>
        <TvButton variant="ghost" :disabled="!results.length" @click="copyAll">{{ copied === 'all' ? '✓ 已全部复制' : '复制全部' }}</TvButton>
        <TvButton variant="ghost" size="sm" title="清空查重记账(历史用过的词不再被降权)" @click="resetCounts">清零查重</TvButton>
        <span v-if="note" class="note">{{ note }}</span>
      </div>

      <p v-if="err" class="err">{{ err }}</p>
      <p v-for="w in warns" :key="w" class="warn">{{ w }}</p>

      <!-- 结果区 -->
      <div v-if="results.length" class="results">
        <div v-for="(r, i) in results" :key="i" class="result">
          <div class="r-head">
            <span class="r-no">#{{ i + 1 }}</span>
            <span class="r-n">{{ r.tags.length }} 词</span>
            <TvButton variant="ghost" size="sm" @click="copyOne(i)">{{ copied === '#' + (i + 1) ? '✓ 已复制' : '复制' }}</TvButton>
          </div>
          <div class="r-tags">{{ r.tags.join(', ') }}</div>
          <div v-if="r.notes.length" class="r-notes">{{ r.notes.join(' · ') }}</div>
        </div>
      </div>
    </div>
  </TvModal>
</template>

<style scoped>
.rd { display: flex; flex-direction: column; gap: 10px; min-height: 320px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lab { font-size: 12px; color: var(--tv-text-2, #888); white-space: nowrap; }
.tin { padding: 4px 8px; border: 1px solid var(--tv-border, #ccc); border-radius: 6px; background: transparent; color: inherit; font-size: 13px; }
.tin.num { width: 64px; }
.tin.seed { width: 110px; }
.tin.grow { flex: 1; min-width: 260px; }
.sec-title { font-size: 12px; font-weight: 500; color: var(--tv-text-2, #888); margin-top: 4px; }
.seg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
.seg-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.seg-name { font-size: 13px; }
.ticks { display: flex; gap: 4px; }
.tick {
  width: 30px; height: 22px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--tv-border, #ccc); background: transparent; color: inherit; font-size: 12px;
}
.tick.on { background: var(--tv-accent, #4a7dff); color: #fff; border-color: transparent; }
.actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.note { font-size: 12px; color: var(--tv-ok, #3a3); }
.err { margin: 0; font-size: 12px; color: var(--tv-danger, #c33); white-space: pre-wrap; }
.warn { margin: 0; font-size: 12px; color: var(--tv-warn, #a80); }
.results { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--tv-border, #ccc); padding-top: 10px; max-height: 320px; overflow-y: auto; }
.result { padding: 8px 10px; border: 1px solid var(--tv-border, #ccc); border-radius: 8px; }
.r-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.r-no { font-size: 12px; font-weight: 500; color: var(--tv-text-2, #888); }
.r-n { font-size: 11px; color: var(--tv-text-3, #aaa); flex: 1; }
.r-tags { font-size: 13px; line-height: 1.6; word-break: break-all; }
.r-notes { margin-top: 4px; font-size: 11px; color: var(--tv-text-3, #aaa); }
</style>
