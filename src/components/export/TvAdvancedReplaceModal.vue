<script setup>
/**
 * 高级替换弹窗(2026-10-30) —— 原导出菜单里的「随机替换」面板原位升级独立入口
 * ==========================================================================
 * 三区:
 *   ① 参与随机(槽 chips + 每槽换词率滑杆) —— 勾了的槽导出时同槽 1:1 换新词
 *   ② 钉词(必现) —— 该槽导出时必定是指定词, 优先于随机; 候选带「槽·大类」标识,
 *      手输词不在所选槽 → 黄牌警示, 词典外 → 灰牌"直接写入"
 *   ③ 禁用槽 —— 原图该槽的词整词删除(与换词率 0% 的"保留"相反)
 * 与钉词互斥: 同一槽既钉又禁 → 保存时拦截(引擎侧钉词豁免禁用, 只做防御)。
 *
 * 状态在 src/utils/advReplace.js(reactive 单例) —— 本弹窗只改它, 保存 = 校验+关窗;
 * 导出参数由 HomeView 的 advParams() 取同一份。
 */
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
// 钉词输入复用看板筛选同款联想框(2026-10-30 用户要求统一): localTags 传槽池词条,
// 下拉项带「槽·大类」标识 —— 与看板联想同一套交互(补全/高亮/防抖)
import TvTagSuggestInput from '../tag/TvTagSuggestInput.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import {
  adv, ensureAdvLoaded, advZh, toggleAdvSlot, toggleAdvBan,
  addAdvPin, removeAdvPin, advPinCount, advConflicts,
} from '@/utils/advReplace.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const ui = useUiStore()

watch(() => props.modelValue, (v) => { if (v) ensureAdvLoaded() })

const slotsSorted = computed(() => adv.slots)   // 主进程已按词条数降序
const emptySlots = computed(() => adv.loaded && !adv.slots.length)

/* ---------- ② 钉词 ---------- */
const pinQuery = (p) => String(p.word || '').trim().toLowerCase().replace(/\s+/g, '_')

/* 词归属缓存(word -> {slot, slotZh, sec}): 槽池标识与手输校验共用, 批量反查。
 * 必须 reactive —— 候选标识/校验文案从这读, Map 不触发重渲染, 反查回来界面不动 */
const infoCache = reactive({})
let lookupTimer = null
const pendingWords = new Set()
/** 批量查归属(词典反查走主进程, 250ms 合并同批词) */
function lookupWords(words) {
  const todo = words.filter((w) => w && !(w in infoCache) && !pendingWords.has(w))
  if (!todo.length) return
  todo.forEach((w) => pendingWords.add(w))
  clearTimeout(lookupTimer)
  lookupTimer = setTimeout(async () => {
    const batch = [...pendingWords].slice(0, 40)
    pendingWords.clear()
    try {
      const infos = await api.random.wordinfo(batch)
      for (const it of infos || []) infoCache[it.word.toLowerCase().replace(/\s+/g, '_')] = it
    } catch { /* 失败 = 缓存没有, 界面只少个标识不挡功能 */ }
  }, 250)
}
/* 已输词变化 → 补查归属 */
watch(() => adv.pins.map((p) => p.word).join('|'), () => {
  for (const p of adv.pins) { const w = pinQuery(p); if (w) lookupWords([w]) }
})

const infoOf = (w) => infoCache[String(w || '').toLowerCase().replace(/\s+/g, '_')]

/** 钉词联想池: 所选槽的词条映射成 TvTagSuggestInput 的 localTags 形态。
 *  slotZh 恒定(所选槽), sec 从归属缓存补(反查回来后重渲染自动补上)。 */
function pinPool(p) {
  const s = adv.slots.find((x) => x.id === p.slot)
  if (!s) return []
  return s.words.map((w) => ({ tag: w, slotZh: advZh(p.slot), sec: infoOf(w)?.sec || '' }))
}

/** 手输词校验(三级): ok=在所选槽 / warn=在词典但别的槽 / out=词典外; 空词=null */
function pinVerdictOf(p) {
  if (!p.slot) return null
  const w = pinQuery(p)
  if (!w) return null
  const it = infoOf(w)
  if (!it) return { level: 'pending', msg: '归属查询中…' }
  if (!it.slot) return { level: 'out', msg: '词典外 — 直接写入导出结果, 不参与槽位判断' }
  if (it.slot === p.slot) return { level: 'ok', msg: `✓ ${it.slotZh}·${it.sec}` }
  return { level: 'warn', msg: `⚠ 实际在「${it.slotZh}」≠ 所选「${advZh(p.slot)}」— 生效时按词典归属, 不进这个槽` }
}

onBeforeUnmount(() => { clearTimeout(lookupTimer) })

/* ---------- 保存 ---------- */
const saving = ref(false)
function save() {
  const conflicts = advConflicts.value
  if (conflicts.length) {
    ui.err(`这些槽既钉了词又禁用了: ${conflicts.map((s) => advZh(s)).join('、')} —— 钉词和禁用二选一, 改完再保存`)
    return
  }
  emit('update:modelValue', false)
  const n1 = adv.picked.length, n2 = advPinCount.value, n3 = adv.banned.length
  if (adv.enabled && (n1 || n2 || n3)) {
    const parts = []
    if (n1) parts.push(`随机 ${n1} 槽`)
    if (n2) parts.push(`钉词 ${n2}`)
    if (n3) parts.push(`禁用 ${n3}`)
    ui.ok(`✅ 高级替换已生效: ${parts.join(' · ')}`, 2200)
  } else {
    ui.ok('高级替换已关闭(总开关没开)', 2000)
  }
  saving.value = true
  setTimeout(() => { saving.value = false }, 300)
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="🎲 高级替换"
    size="lg"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tip">对导出的词条做三类处理(按序生效): <b>禁用槽删词 → 钉词定死 → 勾选槽随机换词</b>。不在词槽词典里的词不参与, 原样保留。</div>

    <!-- 总开关 -->
    <div class="mrow">
      <TvCheckbox
        v-model="adv.enabled"
        label="启用高级替换(导出时生效)"
        title="关掉 = 导出完全不看这里的配置, 等于没配过; 打开 = 每次导出都按下面的配置走"
      />
    </div>

    <!-- ① 参与随机 -->
    <div class="zone">
      <div class="zh">① 参与随机 <span class="zh-sub">勾选槽的词同槽 1:1 换新词, 结构不变只换内容</span></div>
      <div class="chips">
        <button
          v-for="s in slotsSorted"
          :key="s.id"
          type="button"
          class="chip"
          :class="{ on: adv.picked.includes(s.id) }"
          :title="`槽内 ${s.cnt} 个词条, 如: ${s.words.slice(0, 5).join(', ')}…`"
          @click="toggleAdvSlot(s.id)"
        >{{ s.zh }}<i class="chip-n">{{ s.cnt }}</i></button>
      </div>
      <div v-if="emptySlots" class="empty">槽位清单加载失败, 关掉重开弹窗再试</div>
      <template v-for="s in slotsSorted" :key="`r-${s.id}`">
        <div v-if="adv.picked.includes(s.id)" class="rate">
          <span class="rate-lb">{{ s.zh }}</span>
          <input
            v-model.number="adv.rates[s.id]"
            class="rate-in"
            type="range"
            min="0"
            max="100"
            step="5"
            :title="`「${s.zh}」的换词率: 每个词有此概率被换成同槽位的新词; 100% = 必换`"
          />
          <span class="rate-v">{{ adv.rates[s.id] ?? 100 }}%</span>
        </div>
      </template>
    </div>

    <!-- ② 钉词 -->
    <div class="zone pin-zone">
      <div class="zh">② 钉词(必现) <span class="zh-sub">该槽导出时必定是指定词, 优先于随机; 钉了的槽自动跳过随机</span></div>
      <div v-for="(p, i) in adv.pins" :key="`pin-${i}`" class="pin">
        <select v-model="p.slot" class="pin-slot" title="钉词放在哪个槽">
          <option value="" disabled>选槽…</option>
          <option v-for="s in slotsSorted" :key="s.id" :value="s.id">{{ s.zh }}</option>
        </select>
        <span class="pin-eq">必现</span>
        <span class="pin-word-box">
          <!-- 2026-10-30 复用看板筛选同款联想框: 槽池联想(带「槽·大类」标识), 手输词典外词也允许 -->
          <TvTagSuggestInput
            v-model="p.word"
            size="sm"
            :local-tags="p.slot ? pinPool(p) : []"
            :empty-text="p.slot ? '该槽池里没有匹配的词条(手输会直接写入导出结果)' : '先在左边选槽'"
            :disabled="!p.slot"
            @pick="lookupWords([pinQuery(p)])"
          />
          <span v-if="pinVerdictOf(p)" :class="['pin-verdict', `v-${pinVerdictOf(p).level}`]">{{ pinVerdictOf(p).msg }}</span>
        </span>
        <button type="button" class="pin-del" title="删掉这行钉词" @click="removeAdvPin(i)">×</button>
      </div>
      <TvButton size="xs" variant="ghost" class="pin-add" @click="addAdvPin">＋ 添加钉词</TvButton>
      <TvCheckbox
        v-model="adv.pinFill"
        label="原图没有该槽词条时, 自动补上钉词"
        title="「必现」语义: 原图整行都没有该槽的词, 也把钉词追加进导出结果"
      />
    </div>

    <!-- ③ 禁用槽 -->
    <div class="zone ban-zone">
      <div class="zh ban-t">③ 禁用槽 <span class="zh-sub">原图该槽的词整词删除 —— 既不随机也不出现(与换词率 0% 的"保留"相反)</span></div>
      <div class="chips">
        <button
          v-for="s in slotsSorted"
          :key="`b-${s.id}`"
          type="button"
          class="chip ban"
          :class="{ on: adv.banned.includes(s.id) }"
          :disabled="adv.pins.some((p) => p.slot === s.id && p.word.trim())"
          :title="adv.pins.some((p) => p.slot === s.id && p.word.trim())
            ? `「${s.zh}」已钉词, 与禁用互斥 —— 先删掉这行钉词再禁`
            : `勾上后, 原图词条里属于「${s.zh}」槽的词全部不进导出结果`"
          @click="toggleAdvBan(s.id)"
        >{{ s.zh }}<i class="chip-n">{{ s.cnt }}</i></button>
      </div>
      <div v-if="advConflicts.length" class="conflict">⚠ 既钉又禁: {{ advConflicts.map((s) => advZh(s)).join('、') }} —— 保存前二选一</div>
    </div>

    <!-- 其他 -->
    <div class="zone other">
      <TvCheckbox
        v-model="adv.nsfw"
        label="随机候选含成人词库"
        title="关掉后随机候选池在构建期就剔除成人词(nsfwPools), 权重/重试都拉不回来 —— 低档绝不越界"
      />
      <input
        v-model="adv.seed"
        class="seed"
        type="text"
        placeholder="种子(留空 = 每次导出都不同)"
        title="固定种子时, 同样的筛选结果导出会得到完全相同的随机替换结果, 可复现"
      />
    </div>

    <template #footer>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">取消</TvButton>
      <TvButton variant="primary" :loading="saving" @click="save">💾 保存</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.7; margin-bottom: 8px; }
.tip b { color: var(--text); }
.mrow { margin-bottom: 8px; }

.zone { border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px 10px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
.zh { font-size: 12px; font-weight: 600; color: var(--text); }
.zh-sub { font-weight: normal; font-size: 11px; color: var(--faint); margin-left: 4px; }
.ban-t { color: var(--danger, #c05050); }

.chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 132px; overflow-y: auto; }
.chip {
  display: inline-flex; align-items: center; gap: 2px;
  border: 1px solid var(--border); border-radius: 10px; padding: 2px 8px;
  background: var(--panel2); color: var(--muted); cursor: pointer; font-size: 11px;
}
.chip.on { background: var(--accent, #534ab7); border-color: var(--accent, #534ab7); color: #fff; }
.chip.ban.on { background: var(--danger, #c05050); border-color: var(--danger, #c05050); }
.chip:disabled { opacity: 0.45; cursor: not-allowed; }
.chip-n { font-style: normal; font-size: 10px; opacity: 0.6; margin-left: 3px; }
.empty { font-size: 11px; color: var(--faint); }

.rate { display: flex; align-items: center; gap: 6px; }
.rate-lb { flex: 0 0 auto; font-size: 11px; color: var(--muted); min-width: 4em; }
.rate-in { flex: 1 1 auto; min-width: 0; height: 14px; accent-color: var(--accent, #534ab7); }
.rate-v { flex: 0 0 3em; text-align: right; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }

.pin { display: flex; align-items: flex-start; gap: 5px; }
.pin-slot {
  flex: 0 0 5.5em; font-size: 11px; padding: 3px 4px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text);
}
.pin-eq { flex: 0 0 auto; font-size: 11px; color: var(--faint); line-height: 24px; }
.pin-word-box { flex: 1 1 auto; min-width: 0; position: relative; }
.pin-verdict { display: block; font-size: 10.5px; line-height: 1.4; margin-top: 2px; }
.v-ok { color: var(--ok, #3d9970); }
.v-warn { color: var(--warn, #c8862a); }
.v-out { color: var(--faint); }
.v-pending { color: var(--faint); }
.pin-del {
  flex: 0 0 auto; width: 20px; height: 20px; line-height: 18px; padding: 0;
  border: 1px solid var(--border); border-radius: 50%;
  background: transparent; color: var(--faint); cursor: pointer; font-size: 12px;
}
.pin-del:hover { color: var(--danger, #a32d2d); border-color: var(--danger, #a32d2d); }
.pin-add { align-self: flex-start; }

.other { flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.seed {
  flex: 1 1 200px; max-width: 280px; font-size: 11px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel2); color: var(--text); outline: none;
}
.seed:focus { border-color: var(--accent); }
.conflict { font-size: 11px; color: var(--danger, #c05050); }
</style>
