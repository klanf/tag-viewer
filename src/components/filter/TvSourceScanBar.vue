<script setup>
/**
 * 「来源 | 扫描夹」组合筛选条 —— 标签页 / 标签图片页共用
 * =====================================================
 * 用户点名的形态(2026-10-21): 一颗分段胶囊(来源|扫描夹), 点哪边哪边生效,
 * 右边的 chips 行跟着换内容, 图片/标签列表跟着换数据源。旧版"两条筛选并排
 * 铺开 + 灰掉另一条"的互斥表达被证明没人看得懂, 由此退役。
 *
 * 状态真源是 useSourceScanFilter(模块级单例): 从标签列表点进某标签的图片页,
 * 档位和选择原样跟过去。本组件只负责渲染 + 上抛 change, 数据管线由页面自己接
 * (列表页走 allTags/scanTagList, 图片页走 search 的 source/under 参数)。
 */
import { onMounted } from 'vue'
import TvSegmented from '../base/TvSegmented.vue'
import TvSourceChips from './TvSourceChips.vue'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { useSourceScanFilter } from '@/composables/useSourceScanFilter.js'

const emit = defineEmits(['change'])
const srcStore = useSourceStore()
const f = useSourceScanFilter()

const segOptions = [
  { value: 'source', label: '来源', title: '按标签库的来源(登记为看板来源的文件夹)筛选' },
  { value: 'scan', label: '扫描夹', title: '按扫描文件夹筛选(数据来自扫描缓存)' },
]

function onChange() { emit('change') }

onMounted(() => {
  srcStore.load()          // 来源 chips 数据(stats 里的来源计数, 内部有就绪判断也无妨)
  f.ensureScanChips()      // 扫描夹 chips 数据(folders 登记表)
})
</script>

<template>
  <div class="ss-bar">
    <TvSegmented
      :options="segOptions"
      :model-value="f.mode.value"
      aria-label="筛选维度"
      @update:model-value="f.setMode($event); onChange()"
    />
    <!-- 只渲染当前档的 chips; 另一档的选择在 composable 里记着, 切回来还在 -->
    <TvSourceChips
      v-if="!f.isScan.value"
      flat
      label=""
      :model-value="f.srcSel.value"
      :sources="srcStore.list"
      :total="srcStore.totalImages"
      @update:model-value="f.setSrcSel($event); onChange()"
    />
    <TvSourceChips
      v-else
      flat
      label=""
      :model-value="f.scanSel.value"
      :sources="f.scanChips.value"
      :total="f.scanTotalImages.value"
      @update:model-value="f.setScanSel($event); onChange()"
    />
  </div>
</template>

<style scoped>
.ss-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: nowrap;
  padding: 7px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}
</style>
