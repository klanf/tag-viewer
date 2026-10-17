<script setup>
/**
 * 「相似图查重」面板(2026-10-17)
 * ==============================
 * 依据: 两阶段 tag 相似度 —— 罕见 tag 共现出候选 + IDF 加权 Jaccard 打分 +
 * 并查集成组(算法在 electron/core/dupcheck.js, 真库 107k 图 ~2s)。
 * 结果**只展示不动文件**: 每组标出分辨率最大的「建议保留」, 处理由用户逐组决定。
 * 阈值可调(改完自动重扫); 分数 1.0 = tag 集合完全一致, 基本就是同一张图的两份拷贝。
 */
import { ref, watch } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvImage from '@/components/base/TvImage.vue'
import { api } from '@/utils/api.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'

const open = defineModel({ type: Boolean, default: false })
const lightbox = useLightboxStore()

const loading = ref(false)
const error = ref('')
const result = ref(null)          // { scanned, candidates, groups, truncated, elapsedMs }
const threshold = ref(0.85)
const scannedAt = ref(0)          // 阈值变更后避免重复自动扫的标记

const THRESHOLD_OPTIONS = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65].map((v) => ({
  value: v, label: `≥ ${v}（${v >= 0.9 ? '严格' : v >= 0.8 ? '均衡' : '宽松'}）`,
}))

async function run() {
  loading.value = true
  error.value = ''
  try {
    result.value = await api.dupScan({ threshold: threshold.value })
    scannedAt.value = threshold.value
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

watch(open, (v) => { if (v && !result.value) run() })
watch(threshold, () => { if (open.value) run() })

/** 打开光箱: 组内图片按「建议保留在前」的顺序翻页 */
function openItem(group, item) {
  const list = group.items.map((it) => it.path)
  lightbox.open(item.path, { list })
}

function fmtSize(n) {
  if (!n) return ''
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}
</script>

<template>
  <TvModal v-model="open" title="🔎 相似图查重" size="xl">
    <div class="dup">
      <div class="bar">
        <TvSelect v-model="threshold" label="相似度阈值" :options="THRESHOLD_OPTIONS" />
        <TvButton size="sm" :loading="loading" @click="run">↻ 重新扫描</TvButton>
        <span v-if="result" class="sum">
          扫描 {{ result.scanned.toLocaleString() }} 张 ·
          <b>{{ result.groups.length }}</b> 组
          <template v-if="result.truncated">（已达上限，可提高阈值）</template>
          · {{ (result.elapsedMs / 1000).toFixed(1) }}s
        </span>
        <span class="hint">
          ★ = 建议保留（组内分辨率最大）· 面板只做展示，不会动任何文件
        </span>
      </div>

      <div v-if="error" class="err">扫描失败：{{ error }}</div>
      <div v-else-if="loading && !result" class="empty">正在比对全库标签…（约 2 秒）</div>
      <div v-else-if="result && !result.groups.length" class="empty">
        这个阈值下没有发现相似组 —— 试试调低阈值
      </div>

      <div v-else class="list">
        <div v-for="(g, gi) in result.groups" :key="gi" class="grp">
          <div class="ghead">
            <span class="score" :class="{ hi: g.score >= 0.999 }">{{ (g.score * 100).toFixed(1) }}%</span>
            <span class="cnt">{{ g.items.length }} 张</span>
            <span v-if="g.shared?.length" class="shared" :title="g.shared.join(', ')">
              共享: <i v-for="t in g.shared.slice(0, 6)" :key="t">{{ t }}</i>
            </span>
          </div>
          <div class="items">
            <button
              v-for="it in g.items"
              :key="it.id"
              class="item"
              type="button"
              :title="`${it.path}\n${it.px_w}×${it.px_h} ${fmtSize(it.size)}`"
              @click="openItem(g, it)"
            >
              <TvImage :path="it.path" :width="200" ratio="1 / 1" />
              <span class="meta">
                <b v-if="it.best" class="best">★ 建议保留</b>
                <span>{{ it.px_w }}×{{ it.px_h }}</span>
                <span v-if="it.size">{{ fmtSize(it.size) }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </TvModal>
</template>

<style scoped>
.dup { display: flex; flex-direction: column; gap: 10px; min-height: 420px; }
.bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sum { color: var(--muted); font-size: 12px; }
.sum b { color: var(--accent); }
.hint { margin-left: auto; color: var(--muted); font-size: 12px; }
.err { color: var(--danger); font-size: 13px; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; }

.list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.grp { border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 8px; padding: 8px 10px; }
.ghead { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.score {
  font-weight: 700; font-size: 13px; padding: 1px 8px; border-radius: 10px;
  background: var(--panel3, rgba(128,128,128,.15));
}
.score.hi { background: var(--danger-soft, rgba(239,68,68,.14)); color: var(--danger); }
.cnt { font-size: 12px; color: var(--muted); }
.shared { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shared i {
  font-style: normal; color: var(--ok, #3f9d63); background: rgba(63,157,99,.1);
  border-radius: 4px; padding: 0 4px; margin-right: 4px;
}
.items { display: flex; gap: 8px; flex-wrap: wrap; }
.item {
  width: 132px; border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 6px;
  background: none; padding: 0; cursor: pointer; overflow: hidden; text-align: left;
}
.item:hover { border-color: var(--accent); }
.item :deep(.tv-img) { display: block; width: 100%; }
.meta {
  display: flex; flex-direction: column; gap: 1px; padding: 4px 6px;
  font-size: 11px; color: var(--muted);
}
.best { color: var(--fav, #f59e0b); }
</style>
