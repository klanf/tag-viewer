<script setup>
/**
 * 「相似图查重」面板(2026-10-17)
 * ==============================
 * 依据: 两阶段 tag 相似度 —— 罕见 tag 共现出候选 + IDF 加权 Jaccard 打分 +
 * 并查集成组(算法在 electron/core/dupcheck.js, 真库 107k 图 ~2s)。
 * 扫描口径与看板可见图一致(gone=0 + 来源未注销), 幽灵记录/隐藏来源不掺和。
 *
 * 处理能力(2026-10-17 用户拍板):
 *   · 每张缩略图悬停 🗑 = 单张删(系统回收站, 走全局确认弹窗)
 *   · 组头「删其余」 = 一键删掉组内非★项(保留分辨率最大的建议保留张)
 *   · 组头「非重复」 = 误报忽略 —— 整组两两 id 对持久化, 下次扫描不再出现
 *   · 「定位下一批」 = 只高亮+滚动定位 N 组, 不做任何批量删除(辅助逐组人工过)
 * 删除后的组内剪枝统一监听 'tv:trashed'(与各视图同一套广播)。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvImage from '@/components/base/TvImage.vue'
import { api } from '@/utils/api.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useTrash } from '@/composables/useTrash.js'
import { useUiStore } from '@/stores/useUiStore.js'

const open = defineModel({ type: Boolean, default: false })
const lightbox = useLightboxStore()
const trash = useTrash()
const ui = useUiStore()

const loading = ref(false)
const error = ref('')
const result = ref(null)          // { scanned, candidates, ignoredPairs, groups, truncated, elapsedMs }
const threshold = ref(0.85)

const THRESHOLD_OPTIONS = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65].map((v) => ({
  value: v, label: `≥ ${v}（${v >= 0.9 ? '严格' : v >= 0.8 ? '均衡' : '宽松'}）`,
}))

async function run() {
  loading.value = true
  error.value = ''
  try {
    result.value = await api.dupScan({ threshold: threshold.value })
    resetFocus()
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

watch(open, (v) => { if (v && !result.value) run() })
watch(threshold, () => { if (open.value) run() })

/* ---------------- 批次定位(只高亮不删) ---------------- */
const groups = computed(() => result.value?.groups || [])
const BATCH_OPTIONS = [5, 10, 20, 50].map((n) => ({ value: n, label: `每次 ${n} 组` }))
const batch = ref(10)
const focusStart = ref(-1)        // 当前高亮批的起始组下标; -1 = 还没开始
const grpEls = []                 // 组 DOM 元素(定位滚动用)

function resetFocus() {
  focusStart.value = -1
  grpEls.length = 0
}
function setGrpEl(el, i) { if (el) grpEls[i] = el }

/** 定位下一批: 从上一批末尾(或头)往下取 N 组, 高亮 + 滚过去 */
function locateNextBatch() {
  const n = groups.value.length
  if (!n) return
  const start = focusStart.value < 0 ? 0 : Math.min(focusStart.value + batch.value, n - 1)
  focusStart.value = start
  // 等 DOM 类名挂上再滚, 滚动目标取批内第一组
  requestAnimationFrame(() => {
    grpEls[start]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}
function isFocused(gi) {
  return focusStart.value >= 0 && gi >= focusStart.value && gi < focusStart.value + batch.value
}

/* ---------------- 删除(单张 / 组级) ---------------- */
async function delOne(path) {
  if (trash.state.open) return   // 确认弹窗开着时不再叠加请求(与光箱 Del 同款防重入)
  const trashed = await trash.request([path])
  pruneTrashed(trashed)
}
/** 组级: 删掉非★项(建议保留的那张不动) */
async function delRest(g) {
  if (trash.state.open) return
  const paths = g.items.filter((it) => !it.best).map((it) => it.path)
  if (!paths.length) { ui.toast('这组只有一张, 没有可删的', 'info'); return }
  const trashed = await trash.request(paths)
  pruneTrashed(trashed)
}

/** 'tv:trashed' 与删除回执统一走这里: 剪掉组内已删项, 剩不足 2 张的组整个移除 */
function pruneTrashed(trashed) {
  if (!trashed?.length || !result.value) return
  const gone = new Set(trashed)
  result.value.groups = result.value.groups
    .map((g) => ({ ...g, items: g.items.filter((it) => !gone.has(it.path)) }))
    .filter((g) => g.items.length >= 2)
}
function onTrashed(e) { pruneTrashed(e?.detail?.paths) }
window.addEventListener('tv:trashed', onTrashed)
onBeforeUnmount(() => window.removeEventListener('tv:trashed', onTrashed))

/* ---------------- 误报忽略(持久化) ---------------- */
const ignoredAdded = ref(0)       // 本次会话里新忽略的组数(配合 result.ignoredPairs 展示)
/** 整组两两 id 对 -> 主进程落盘; 本地立即剪掉这组 */
async function ignoreGroup(g, gi) {
  const pairs = []
  for (let a = 0; a < g.items.length; a++) {
    for (let b = a + 1; b < g.items.length; b++) {
      pairs.push([g.items[a].id, g.items[b].id])
    }
  }
  try {
    await api.dupIgnoreAdd(pairs)
    result.value.groups.splice(gi, 1)
    ignoredAdded.value++
    ui.toast(`已忽略这组(${pairs.length} 对), 下次扫描不再出现`, 'ok')
  } catch (e) {
    ui.err('忽略失败: ' + (e?.message || e))
  }
}
const ignoredTotal = computed(() => (result.value?.ignoredPairs || 0) + ignoredAdded.value)
/** 恢复 = 清空忽略表并重扫(之前忽略的全部回来) */
async function unignoreAll() {
  try {
    const r = await api.dupIgnoreClear()
    ignoredAdded.value = 0
    ui.toast(`已恢复 ${r?.removed || 0} 对误报记录, 重新扫描中…`, 'ok')
    await run()
  } catch (e) {
    ui.err('恢复失败: ' + (e?.message || e))
  }
}

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
          <b>{{ groups.length }}</b> 组
          <template v-if="result.truncated">（已达上限，可提高阈值）</template>
          · {{ (result.elapsedMs / 1000).toFixed(1) }}s
        </span>
        <span
          v-if="ignoredTotal > 0"
          class="igchip"
          title="标记为「非重复」的误报已从结果扣除; 点右侧按钮全部恢复显示"
        >
          已忽略 {{ ignoredTotal }} 项
          <button class="ig-undo" type="button" @click="unignoreAll">↩ 恢复</button>
        </span>
      </div>

      <div v-if="groups.length" class="bar2">
        <TvSelect v-model="batch" label="定位批量" :options="BATCH_OPTIONS" />
        <TvButton size="sm" :disabled="!groups.length" @click="locateNextBatch">
          📍 定位{{ focusStart < 0 ? '第一批' : '下一批' }}
        </TvButton>
        <span v-if="focusStart >= 0" class="sum">
          高亮第 {{ focusStart + 1 }}–{{ Math.min(focusStart + batch, groups.length) }} 组 / 共 {{ groups.length }} 组
        </span>
        <span class="hint">
          ★ = 建议保留 · 悬停缩略图 🗑 删单张 · 组头「删其余」删非★项 · 「非重复」忽略误报 —— 都进系统回收站/可还原
        </span>
      </div>

      <div v-if="error" class="err">扫描失败：{{ error }}</div>
      <div v-else-if="loading && !result" class="empty">正在比对全库标签…（约 2 秒）</div>
      <div v-else-if="result && !groups.length" class="empty">
        这个阈值下没有发现相似组 —— 试试调低阈值
      </div>

      <div v-else class="list">
        <div
          v-for="(g, gi) in groups"
          :key="`${g.items[0]?.id}-${gi}`"
          :ref="(el) => setGrpEl(el, gi)"
          class="grp"
          :class="{ focused: isFocused(gi) }"
        >
          <div class="ghead">
            <span class="score" :class="{ hi: g.score >= 0.999 }">{{ (g.score * 100).toFixed(1) }}%</span>
            <span class="cnt">{{ g.items.length }} 张</span>
            <span v-if="g.shared?.length" class="shared" :title="g.shared.join(', ')">
              共享: <i v-for="t in g.shared.slice(0, 6)" :key="t">{{ t }}</i>
            </span>
            <span class="gacts">
              <button class="gbtn" type="button" title="这组不是重复图 —— 忽略后下次扫描不再出现" @click="ignoreGroup(g, gi)">🚫 非重复</button>
              <button class="gbtn danger" type="button" title="删除组内除★建议保留外的所有图(进系统回收站)" @click="delRest(g)">🗑 删其余</button>
            </span>
          </div>
          <div class="items">
            <div
              v-for="it in g.items"
              :key="it.id"
              class="item"
              :title="`${it.path}\n${it.px_w}×${it.px_h} ${fmtSize(it.size)}`"
            >
              <div class="thumb">
                <TvImage :path="it.path" :width="200" ratio="1 / 1" @click="openItem(g, it)" />
                <button
                  class="del"
                  type="button"
                  title="删除这张(进系统回收站, 可还原)"
                  @click.stop="delOne(it.path)"
                >🗑</button>
                <span v-if="it.best" class="bestmark" title="组内分辨率最大, 建议保留">★</span>
              </div>
              <div class="meta" @click="openItem(g, it)">
                <span>{{ it.px_w }}×{{ it.px_h }}</span>
                <span v-if="it.size">{{ fmtSize(it.size) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </TvModal>
</template>

<style scoped>
.dup { display: flex; flex-direction: column; gap: 10px; min-height: 420px; }
.bar, .bar2 { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sum { color: var(--muted); font-size: 12px; }
.sum b { color: var(--accent); }
.hint { margin-left: auto; color: var(--muted); font-size: 12px; }
.err { color: var(--danger); font-size: 13px; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; }

/* 已忽略误报提示 chip */
.igchip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--muted);
  background: var(--panel3, rgba(128,128,128,.15));
  border-radius: 999px; padding: 2px 10px;
}
.ig-undo {
  border: none; background: none; cursor: pointer;
  color: var(--accent); font-size: 12px; padding: 0;
}
.ig-undo:hover { text-decoration: underline; }

.list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.grp {
  border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 8px; padding: 8px 10px;
  transition: border-color .25s ease, box-shadow .25s ease;
}
/* 批次定位高亮: 只标边界, 不影响阅读 */
.grp.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
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
.gacts { margin-left: auto; display: inline-flex; gap: 6px; flex: 0 0 auto; }
.gbtn {
  border: 1px solid var(--border, rgba(128,128,128,.25)); background: none;
  color: var(--muted); font-size: 11px; padding: 2px 8px; border-radius: 6px;
  cursor: pointer; white-space: nowrap;
}
.gbtn:hover { color: var(--text, inherit); border-color: var(--accent); }
.gbtn.danger:hover { color: var(--danger); border-color: var(--danger); }

.items { display: flex; gap: 8px; flex-wrap: wrap; }
.item {
  width: 132px; border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 6px;
  background: none; overflow: hidden; text-align: left; cursor: pointer;
}
.item:hover { border-color: var(--accent); }
.item :deep(.tv-img) { display: block; width: 100%; }
.thumb { position: relative; }
/* 悬停单张删除: 右上角小圆钮, 不挤压布局 */
.thumb .del {
  position: absolute; top: 4px; right: 4px; z-index: 2;
  width: 24px; height: 24px; border-radius: 50%;
  border: none; cursor: pointer;
  background: rgba(10, 13, 18, .72); color: #fff; font-size: 12px; line-height: 1;
  opacity: 0; transition: opacity .15s ease;
  display: flex; align-items: center; justify-content: center;
}
.item:hover .del, .thumb .del:focus-visible { opacity: 1; }
.thumb .del:hover { background: var(--danger, #ef4444); }
/* 建议保留: 左上角常驻金★ */
.bestmark {
  position: absolute; top: 4px; left: 4px; z-index: 2;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--fav, #f59e0b); color: #fff; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.meta {
  display: flex; justify-content: space-between; gap: 4px; padding: 4px 6px;
  font-size: 11px; color: var(--muted);
}
</style>
