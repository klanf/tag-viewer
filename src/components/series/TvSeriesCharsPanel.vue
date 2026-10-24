<script setup>
/**
 * 系列角色列表面板 —— 一个系列下的所有角色
 * ======================================
 * 用在两处:
 *   · 看板 / 系列 / 扫描里的「就地叠一层」(光箱点系列药丸): 顶部 tab 不动,
 *     路径栏接一层, 左上角返回箭头退回上一层(即开这一层时的光箱那一页)
 *   · 组件自身与系列页的角色层是同一套口径(api.characters + 翻译 + 无图角色开关)
 *
 * 这里只保留"挑角色"这条动线需要的东西: 搜索 / 排序 / 无图角色 / 缩放 / 点卡片。
 * 封面、纠正、联网拉图、批量入车那些动作仍归系列页 —— 面板上不摆按钮,
 * 免得出现"点了没反应"的灰按钮。
 */
import { ref, computed, watch } from 'vue'
import TvEntityCard from '@/components/series/TvEntityCard.vue'
import TvInput from '@/components/base/TvInput.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvState from '@/components/base/TvState.vue'
import { useGridZoom } from '@/composables/useGridZoom.js'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { api } from '@/utils/api.js'
import { stripZhSeries } from '@/utils/format.js'

const props = defineProps({
  /** 系列标签本体(形如 blue_archive), 也就是库里那个 copyright tag */
  series: { type: String, default: '' },
  /** 这一层是否正在看(宿主是 KeepAlive 里的页面) */
  active: { type: Boolean, default: true },
})
/** 点角色卡片: 由宿主再往上叠一层「该角色的图」 */
const emit = defineEmits(['open-char'])

const src = useSourceStore()
const prefs = usePrefsStore()
const safety = useSafetyStore()
const ui = useUiStore()

const chars = ref([])
const charZh = ref({})
const zh = ref('')
const kw = ref('')
const sort = ref(prefs.sortSeriesChars)
const loading = ref(false)
const error = ref('')

const { zoom: cardZoom, onWheel: onCardWheel } = useGridZoom()
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(150 * cardZoom.value)}px, 1fr))`,
}))

/** 与系列页同一套匹配口径: 英文名 / 完整标签 / 别名 / 中文名(剥掉系列尾巴的也算) */
const shown = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const arr = chars.value.filter((c) => {
    if (!q) return true
    const z = charZh.value[c.tag] || ''
    return [c.name, c.tag, ...(c.alt || []), z, stripZhSeries(z)]
      .filter(Boolean)
      .some((s) => String(s).toLowerCase().includes(q))
  })
  const s = sort.value
  if (s === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  else if (s === 'name_desc') arr.sort((a, b) => b.name.localeCompare(a.name, 'en'))
  else if (s === 'images_asc') arr.sort((a, b) => a.images - b.images)
  else arr.sort((a, b) => b.images - b.images)
  return arr
})

const emptyText = computed(() => {
  if (error.value) return `加载失败: ${error.value}`
  if (kw.value.trim()) return `没有匹配「${kw.value.trim()}」的角色`
  return `系列「${props.series}」下没有识别到角色`
})

async function load() {
  if (!props.series) return
  loading.value = true
  error.value = ''
  try {
    const d = await api.characters({ series: props.series, source: src.param, withZero: prefs.seriesShowZero })
    chars.value = d.characters || []
    const need = [props.series, ...chars.value.map((c) => c.tag)]
    try {
      const m = await api.translate(need)
      charZh.value = { ...charZh.value, ...m }
      zh.value = m[props.series] || ''
    } catch { /* 没有翻译库也能用 */ }
  } catch (e) {
    error.value = e.message
    chars.value = []
  } finally {
    loading.value = false
  }
}

/* 面板是"一层一个实例"(:key=层 id), 所以 series 一定在挂载时就有值 */
watch(() => props.series, (v) => { if (v) load() }, { immediate: true })
watch(sort, (v) => { prefs.sortSeriesChars = v })
/* 口径变了要重查(开关与系列页共用同一份 prefs, 这边跟着走才不会看到两份不一样的人数)。
 * 藏着(被上层叠层盖住)的时候不查, 只记一笔 stale —— 露脸时再补, 见 TagImagesPanel 里
 * 同款注释: 退回一层就重新查询会把用户刚回到的那层刷没。 */
let stale = false
const reroll = () => { if (props.active) load(); else stale = true }
watch(() => prefs.seriesShowZero, reroll)
watch(() => src.selected.slice(), reroll)
/* 封面是主进程按当前安全档位挑的, 档位一变卡片图要重拿 */
watch(() => `${safety.on}|${safety.level}`, reroll)
watch(() => props.active, (v) => { if (v && stale) { stale = false; load() } })

function openChar(c) {
  if (!c?.tag) { ui.warn('这个角色没有可跳转的标签', 2000); return }
  emit('open-char', c)
}
</script>

<template>
  <div class="chars-panel" data-test="chars-panel">
    <div class="panel body">
      <div class="bar">
        <span class="name">{{ zh || series }}<span v-if="zh" class="en">{{ series }}</span></span>
        <b class="cnt">{{ chars.length }}</b>
        <span class="hint">个角色<template v-if="kw.trim()">, 匹配 <b>{{ shown.length }}</b> 个</template></span>
        <span class="hint faint">点角色 = 往下叠一层看它的图 · 左上角返回退回上一层</span>
        <span class="spacer" />
        <TvInput
          v-model="kw"
          size="sm"
          clearable
          placeholder="🔍 搜索角色(中/英文)"
          class="kw"
        />
        <label class="zero-tog" title="显示 danbooru 补全的、本地没有图片的角色">
          <input v-model="prefs.seriesShowZero" type="checkbox" />
          无图角色
        </label>
        <TvSelect
          v-model="sort"
          size="sm"
          inline
          label="排序"
          :options="[
            { value: 'name', label: '名字 A-Z' },
            { value: 'name_desc', label: '名字 Z-A' },
            { value: 'images', label: '图片最多' },
            { value: 'images_asc', label: '图片最少' },
          ]"
        />
      </div>

      <div class="scroll" @wheel="onCardWheel">
        <TvState v-if="loading" state="loading" text="加载中..." />
        <TvState v-else-if="!shown.length" state="empty" :text="emptyText" />
        <div v-else class="grid" :style="gridStyle">
          <TvEntityCard
            v-for="c in shown"
            :key="c.tag"
            :title="stripZhSeries(charZh[c.tag]) || c.name"
            :subtitle="stripZhSeries(charZh[c.tag]) ? c.name : ''"
            :thumb="c.thumb"
            :images="c.images"
            :characters="null"
            :in-cart="null"
            :badge="c.images === 0 ? (c.fromLibrary ? '库内角色' : '仅手动补充') : ''"
            badge-tone="warn"
            :thumb-width="300"
            data-test="char-card"
            @open="openChar(c)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chars-panel {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
}
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.name { font-size: 14px; font-weight: 600; color: var(--text); }
.name .en {
  font-size: 11px; font-style: italic; font-weight: 400;
  color: var(--muted); margin-left: 6px;
}
.cnt { color: var(--accent); font-size: 16px; }
.hint { color: var(--muted); font-size: 12px; }
.hint b { color: var(--accent2); }
.faint { color: var(--faint); }
.kw { max-width: 260px; }
.kw :deep(.tv-input) { padding: 4px 8px; font-size: 12px; }
.zero-tog {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--muted); cursor: pointer;
  user-select: none; white-space: nowrap;
}
.zero-tog input { accent-color: var(--accent); cursor: pointer; }
.zero-tog:hover { color: var(--accent); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  align-content: start;
}
</style>
