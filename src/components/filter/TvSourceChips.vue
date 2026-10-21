<script setup>
/**
 * 来源筛选条 —— 首页 / 标签页 / 扫描页共用
 * ========================================
 * 语义与原版一致(别改, 用户已经习惯了):
 *   空数组 = 全部; 点单个来源 = 累加多选; 再点一次 = 取消; 点「全部」= 重置。
 * 选超过 1 个时末尾补一个"已选 N 个来源"的提示胶囊(原版是硬塞进 DOM 的)。
 *
 * 2026-10-21 两处扩展(标签页接入时):
 *   · label 可自定义(标签页的第二条筛选是扫描文件夹, 不是"来源")
 *   · sources 条目支持 {name, images, value} —— value 缺省等于 name。
 *     扫描文件夹要按**路径**筛选(显示名可能重名), modelValue 里存的就是 value。
 *
 * 溢出行为: 来源一多单行放不下, 旧版折行会顶开工具栏; 现在单行 + 横向滚动,
 * 滚轮悬停直接横滚, 两端渐隐提示还有内容。不溢出时外观与折行版完全一致。
 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import TvChip from '../base/TvChip.vue'

const props = defineProps({
  /** [{name, images, value?}] */
  sources: { type: Array, default: () => [] },
  /** 选中的值数组(缺省等于 name); 空 = 全部 */
  modelValue: { type: Array, default: () => [] },
  /** 「全部」胶囊上显示的总数 */
  total: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
  label: { type: String, default: '📂 来源:' },
  /**
   * 是否显示「管理」入口(2026-10-16)。只在首页用。
   * 背景: 曾经试图让**整排胶囊**都跳来源管理, 结果把「点来源 = 筛选」这个
   * 每天都要用的动作覆盖掉了(用户当场反馈"原来的筛选来源功能就被覆盖了")。
   * 改成标题行右侧一个小入口, 二者互不干扰 —— 胶囊继续筛, 入口负责跳。
   */
  manage: { type: Boolean, default: false },
  /**
   * 平嵌模式(2026-10-21): 去掉自己的卡片壳(边框/底色/内边距), 让调用方把
   * 分段开关和 chips 行装进**同一张卡片** —— 标签页的「来源|扫描夹」组合条
   * 就是这个用法。独立成条时不传, 外观与从前完全一致。
   */
  flat: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'change', 'manage'])

const isAll = computed(() => !props.modelValue.length)
const valOf = (s) => (s.value !== undefined ? s.value : s.name)

function isActive(s) {
  return props.modelValue.includes(valOf(s))
}

function toggle(s) {
  const v = valOf(s)
  const next = props.modelValue.includes(v)
    ? props.modelValue.filter((n) => n !== v)
    : [...props.modelValue, v]
  emit('update:modelValue', next)
  emit('change', next)
}

/* ---- 溢出检测 + 渐隐: 内容放不下才进入滚动形态 ---- */
const chipsEl = ref(null)
const overflow = ref(false)     // 有内容被裁掉
const atStart = ref(true)
const atEnd = ref(true)
let ro = null

function measure() {
  const el = chipsEl.value
  if (!el) return
  const over = el.scrollWidth > el.clientWidth + 1
  overflow.value = over
  atStart.value = el.scrollLeft <= 1
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
}

function onScroll() { measure() }

/** 滚轮悬停直接横滚(纵向滚轮映射到横向; 已到头时放行给页面滚动) */
function onWheel(e) {
  const el = chipsEl.value
  if (!el || el.scrollWidth <= el.clientWidth || !e.deltaY) return
  const before = el.scrollLeft
  el.scrollLeft += e.deltaY
  if (el.scrollLeft !== before) e.preventDefault()
}

onMounted(() => {
  ro = new ResizeObserver(measure)
  if (chipsEl.value) ro.observe(chipsEl.value)
  measure()
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div class="src-bar" :class="{ flat }">
    <span class="lb">{{ label }}</span>
    <div
      ref="chipsEl"
      class="chips"
      :class="{ 'fade-l': overflow && !atStart, 'fade-r': overflow && !atEnd }"
      @scroll="onScroll"
      @wheel="onWheel"
    >
      <TvChip
        label="全部"
        :count="total"
        :active="isAll"
        @click="emit('update:modelValue', []); emit('change', [])"
      />
      <TvChip
        v-for="s in sources"
        :key="valOf(s)"
        :label="s.name"
        :count="s.images"
        :active="isActive(s)"
        @click="toggle(s)"
      />
      <span v-if="modelValue.length > 1" class="more">已选 {{ modelValue.length }} 个</span>
      <span v-if="loading" class="more">统计中...</span>
    </div>
    <!-- 管理入口: 靠右单独一颗, 与筛选胶囊拉开距离, 不参与筛选语义 -->
    <button
      v-if="manage"
      class="manage"
      type="button"
      title="来源管理: 登记目录、开关用途、追平"
      @click="emit('manage')"
    >🗄️ 管理</button>
  </div>
</template>

<style scoped>
.src-bar {
  display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}
/* 平嵌: 卡片壳交给外层组合条, 这里只留一行 chips */
.src-bar.flat {
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  flex: 1 1 auto;
  min-width: 0;
}
.lb { color: var(--muted); font-size: 12px; margin-right: 2px; flex: 0 0 auto; }
/* 滚动容器: 单行, 溢出横向滚; 细滚动条(悬停才显形一点) */
.chips {
  display: flex; align-items: center; gap: 6px;
  flex: 1 1 auto; min-width: 0;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
  padding: 1px 0;                       /* 给 chip 聚焦态描边留 1px, 不被 overflow 裁掉 */
}
.chips > * { flex: 0 0 auto; }
/* 两端渐隐: 只在真有内容被裁掉的那一侧显形(不是常驻, 免得内容贴边时被误糊) */
.chips.fade-l {
  mask-image: linear-gradient(to right, transparent 0, #000 18px, #000 100%);
}
.chips.fade-r {
  mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 18px), transparent 100%);
}
.chips.fade-l.fade-r {
  mask-image: linear-gradient(to right, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
}
.more { color: var(--muted); font-size: 11px; opacity: .7; padding: 0 4px; flex: 0 0 auto; }
/* 管理入口推到最右, 与筛选胶囊视觉分离 —— 免得被当成"又一个可点的来源" */
.manage {
  margin-left: auto; flex: 0 0 auto;
  font-size: 12px; line-height: 1; cursor: pointer;
  color: var(--muted); background: transparent;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  padding: 4px 11px;
}
.manage:hover { color: var(--accent); border-color: var(--accent); }
</style>
