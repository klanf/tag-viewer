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
 *   · 组头「删其余」 = 一键删掉组内非★项
 *   · ★保留优先级**可自定义**: 跨文件夹按「保留优先级」拖拽排序(越前越优先保留);
 *     同文件夹看文件名(带画师信息 名字+uid/pid 的优先); 再看分辨率(2026-10-17)
 *   · 组头「非重复」 = 误报忽略 —— 整组两两 id 对持久化, 下次扫描不再出现
 *   · 安全模式(2026-10-17 用户补充): 面板结果也过安全模式审查 —— 每张图带
 *     unsafe 标记(主进程算), 开着 🛡 时敏感图/只剩一张的组整个不显示
 * 删除后的组内剪枝统一监听 'tv:trashed'(与各视图同一套广播)。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import TvImage from '@/components/base/TvImage.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { api } from '@/utils/api.js'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useTrash } from '@/composables/useTrash.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'

const open = defineModel({ type: Boolean, default: false })
const lightbox = useLightboxStore()
const trash = useTrash()
const ui = useUiStore()
/** 安全模式: 面板结果与看板同一套审查(展示层过滤, 关掉立刻全回来) */
const safety = useSafetyStore()

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
  } catch (e) {
    error.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

watch(open, (v) => { if (v && !result.value) run() })
watch(threshold, () => { if (open.value) run() })

/* ---------------- 安全模式审查 ----------------
 * 每张图带主进程算好的 unsafe 0/1/2(与看板数据集同一套词表), 这里按当前
 * 开关/档位过滤: 敏感图剔除后组内不足 2 张的整组隐藏。展示层过滤 ——
 * 关掉开关立刻全回来, 不动结果数据本身。 */
const rawGroups = computed(() => result.value?.groups || [])
const safetyView = computed(() => {
  const gs = rawGroups.value
  if (!safety.on) return { list: gs, hiddenGroups: 0, hiddenItems: 0 }
  let hg = 0
  let hi = 0
  const list = []
  for (const g of gs) {
    const vis = g.items.filter((it) => !safety.isHidden(it))
    if (vis.length < 2) { hg++; hi += g.items.length; continue }
    hi += g.items.length - vis.length
    list.push({ ...g, items: vis })
  }
  return { list, hiddenGroups: hg, hiddenItems: hi }
})
const groups = computed(() => safetyView.value.list)

/* ---------------- 保留优先级(可自定义, 2026-10-17) ----------------
 * 「删其余」删谁留谁, 用户说了算:
 *   1) 跨文件夹: 拖拽「保留优先级」排序 —— 越靠前的文件夹里的图越优先保留;
 *   2) 同文件夹: 文件名带画师信息(名字 + uid/pid, pixiv 式命名)的优先保留;
 *   3) 前两条打平: 分辨率大的保留(平手看文件大小)。
 * 文件夹顺序持久化在 localStorage(纯展示层偏好, 不值得过 IPC 落盘)。 */
const PRIO_LS_KEY = 'tv.dup.folderPriority'
function loadFolderOrder() {
  try { return JSON.parse(localStorage.getItem(PRIO_LS_KEY) || '[]') } catch { return [] }
}
const folderOrder = ref(loadFolderOrder())
watch(folderOrder, (v) => {
  try { localStorage.setItem(PRIO_LS_KEY, JSON.stringify(v)) } catch { /* 隐私模式等, 存不进就算了 */ }
}, { deep: true })

const dirOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '' : p.slice(0, i)
}
const baseOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}
/** 目录显示名: 最多两级, 太长的前面省略 */
function shortDir(d) {
  const seg = String(d).split(/[\\/]/).filter(Boolean)
  if (!seg.length) return '(根目录)'
  return (seg.length > 2 ? '…' : '') + seg.slice(-2).join('\\')
}
/** 文件名的「画师信息分」: pixiv 式 名字+id 3 分; 有长数字(可能 id) 2 分; 裸图名 0 分 */
function fileScore(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '')
  if (/^[\w\u4e00-\u9fa5.\-]+[\s_\-]*\d{5,}(_p\d+)?$/i.test(base)) return 3
  if (/\d{5,}/.test(base)) return 2
  return 0
}

/** 当前结果里出现过的文件夹(去重, 按首次出现), 用户排过的按手动顺序提前 */
const folderChips = computed(() => {
  const seen = []
  const seenSet = new Set()
  for (const g of rawGroups.value) {
    for (const it of g.items) {
      const d = dirOf(it.path)
      const k = d.toLowerCase()
      if (!seenSet.has(k)) { seenSet.add(k); seen.push(d) }
    }
  }
  const idxOf = (d) => folderOrder.value.findIndex((x) => String(x).toLowerCase() === d.toLowerCase())
  const ordered = seen.filter((d) => idxOf(d) >= 0)
  const rest = seen.filter((d) => idxOf(d) < 0)
  ordered.sort((a, b) => idxOf(a) - idxOf(b))
  return [...ordered, ...rest]
})
const rankOf = computed(() => {
  const m = new Map()
  folderChips.value.forEach((d, i) => m.set(d.toLowerCase(), i))
  return m
})

/* 拖拽排序: dragstart 记起点, 拖到哪格就插到哪; 拖过一次 = 全部文件夹纳入手动排序 */
let dragFrom = -1
const dropAt = ref(-1)
function onDragStart(i, e) {
  dragFrom = i
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', String(i)) } catch { /* 老引擎无所谓 */ }
  }
}
function onDropAt(i) {
  const from = dragFrom
  dragFrom = -1
  dropAt.value = -1
  if (from < 0 || from === i) return
  const arr = [...folderChips.value]
  const moved = arr.splice(from, 1)[0]
  arr.splice(i, 0, moved)
  folderOrder.value = arr
}

/** 面板真正渲染的组: 安全模式过滤 -> 组内按保留优先级排序(第 1 名 = ★) */
const decorated = computed(() => {
  const rk = rankOf.value
  return groups.value.map((g, gi) => {
    const items = g.items.map((it) => {
      const dir = dirOf(it.path)
      const base = baseOf(it.path)
      return {
        ...it, dir, base,
        fk: rk.get(dir.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
        fs: fileScore(base),
        px: (it.px_w || 0) * (it.px_h || 0),
      }
    })
    items.sort((a, b) =>
      a.fk - b.fk || b.fs - a.fs || b.px - a.px
      || (b.size || 0) - (a.size || 0) || (a.path < b.path ? -1 : 1))
    return { ...g, _key: `${items[0]?.id}-${gi}`, items }
  })
})

/** ★ 的理由(悬停提示): 说清楚为什么留它不留别的 */
function keepWhy(items) {
  const a = items[0]
  const b = items[1]
  if (!a || !b) return '建议保留'
  if (a.fk !== b.fk) return `建议保留: 所在文件夹优先级更高(${shortDir(a.dir)})`
  if (a.fs !== b.fs) return a.fs >= 3 ? '建议保留: 文件名带画师信息(名字+uid/pid)' : '建议保留: 文件名更像画师命名'
  return '建议保留: 分辨率最大'
}

/* ---------------- 删除(单张 / 组级) ---------------- */
async function delOne(path) {
  if (trash.state.open) return   // 确认弹窗开着时不再叠加请求(与光箱 Del 同款防重入)
  const trashed = await trash.request([path])
  pruneTrashed(trashed)
}
/** 组级: 删掉非★项(优先级第 1 名不动) */
async function delRest(g) {
  if (trash.state.open) return
  if (!g.items.length) return
  const paths = g.items.slice(1).map((it) => it.path)
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
async function ignoreGroup(g) {
  // 注意: g 可能是安全模式/排序产生的副本, 不能拿面板下标直接捅 result ——
  // 用组内首图 id 反查它在原始结果里的真身。
  const idx = result.value?.groups?.findIndex((rg) => rg.items[0]?.id === g.items[0]?.id) ?? -1
  if (idx < 0) return
  const pairs = []
  for (let a = 0; a < g.items.length; a++) {
    for (let b = a + 1; b < g.items.length; b++) {
      pairs.push([g.items[a].id, g.items[b].id])
    }
  }
  try {
    await api.dupIgnoreAdd(pairs)
    result.value.groups.splice(idx, 1)
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

/** 打开光箱: 组内图片按「保留优先级」顺序翻页(第 1 名在前) */
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
      <!-- 工具条: 控件一行对齐(inline 下拉不再把标签顶到上一行) -->
      <div class="bar">
        <TvSelect v-model="threshold" inline size="sm" label="相似度" :options="THRESHOLD_OPTIONS" />
        <TvButton size="sm" variant="secondary" :loading="loading" @click="run">↻ 重新扫描</TvButton>
        <span v-if="result" class="sum">
          扫描 {{ result.scanned.toLocaleString() }} 张 ·
          <b>{{ groups.length }}</b> 组
          <span v-if="safetyView.hiddenGroups" class="sfthide" title="开着安全模式, 命中敏感标签的图/组不显示">（🛡 隐藏 {{ safetyView.hiddenGroups }} 组）</span>
          <template v-if="result.truncated">（已达上限，可提高阈值）</template>
          · {{ (result.elapsedMs / 1000).toFixed(1) }}s
        </span>
        <span class="spacer" />
        <TvSafetyToggle />
        <span
          v-if="ignoredTotal > 0"
          class="igchip"
          title="标记为「非重复」的误报已从结果扣除; 点右侧按钮全部恢复显示"
        >
          已忽略 {{ ignoredTotal }} 项
          <button class="ig-undo" type="button" @click="unignoreAll">↩ 恢复</button>
        </span>
      </div>

      <!-- 保留优先级: 跨文件夹拖拽排序(只在一个组跨多个文件夹时才有得排) -->
      <div v-if="folderChips.length > 1" class="prio">
        <span class="plab" title="拖动调整顺序: 越靠前的文件夹里的图越优先保留">↕ 保留优先级</span>
        <div class="chips">
          <span
            v-for="(d, i) in folderChips"
            :key="d"
            class="chip"
            :class="{ over: dropAt === i }"
            draggable="true"
            :title="`${i + 1}. ${d}`"
            @dragstart="onDragStart(i, $event)"
            @dragend="dragFrom = -1; dropAt = -1"
            @dragover.prevent="dropAt = i"
            @drop.prevent="onDropAt(i)"
          ><b>{{ i + 1 }}</b>{{ shortDir(d) }}</span>
        </div>
        <TvButton size="xs" variant="ghost" title="清除手动排序(回到默认出现顺序)" @click="folderOrder = []">↺</TvButton>
        <span class="phint">越前越优先保留; 同文件夹内文件名带画师信息(名字+uid/pid)的优先, 再看分辨率</span>
      </div>
      <div v-else class="hintline">
        ★ = 建议保留 · 悬停缩略图 🗑 删单张 · 组头「删其余」删非★项 · 「非重复」忽略误报 —— 都进系统回收站/可还原
      </div>

      <div v-if="error" class="err">扫描失败：{{ error }}</div>
      <div v-else-if="loading && !result" class="empty">正在比对全库标签…（约 2 秒）</div>
      <div v-else-if="result && !groups.length" class="empty">
        {{
          safetyView.hiddenGroups
            ? `发现的相似组都被安全模式隐藏了（${safetyView.hiddenGroups} 组 / ${safetyView.hiddenItems} 张）—— 关掉 🛡 可见`
            : '这个阈值下没有发现相似组 —— 试试调低阈值'
        }}
      </div>

      <div v-else class="list">
        <div v-for="g in decorated" :key="g._key" class="grp">
          <div class="ghead">
            <span class="score" :class="{ hi: g.score >= 0.999 }">{{ (g.score * 100).toFixed(1) }}%</span>
            <span class="cnt">{{ g.items.length }} 张</span>
            <span v-if="g.shared?.length" class="shared" :title="g.shared.join(', ')">
              共享: <i v-for="t in g.shared.slice(0, 6)" :key="t">{{ t }}</i>
            </span>
            <span class="gacts">
              <button class="gbtn" type="button" title="这组不是重复图 —— 忽略后下次扫描不再出现" @click="ignoreGroup(g)">🚫 非重复</button>
              <button class="gbtn danger" type="button" title="删除组内除★(优先级第1名)外的所有图(进系统回收站)" @click="delRest(g)">🗑 删其余</button>
            </span>
          </div>
          <div class="items">
            <div
              v-for="(it, ii) in g.items"
              :key="it.id"
              class="item"
              :title="`${it.path}\n${it.px_w}×${it.px_h}${it.size ? ' · ' + fmtSize(it.size) : ''}`"
            >
              <div class="thumb">
                <TvImage :path="it.path" :width="200" ratio="1 / 1" @click="openItem(g, it)" />
                <button
                  class="del"
                  type="button"
                  title="删除这张(进系统回收站, 可还原)"
                  @click.stop="delOne(it.path)"
                >🗑</button>
                <span v-if="ii === 0" class="bestmark" :title="keepWhy(g.items)">★</span>
                <span v-else class="rank" :title="`保留优先级第 ${ii + 1} 名`">{{ ii + 1 }}</span>
              </div>
              <div class="meta" @click="openItem(g, it)">
                <span class="fname" :title="it.path">{{ it.base }}</span>
                <span class="fdir" :title="it.dir">{{ shortDir(it.dir) }}</span>
                <span class="dims">{{ it.px_w }}×{{ it.px_h }}<template v-if="it.size"> · {{ fmtSize(it.size) }}</template></span>
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
/* 工具条: 全部控件同一行内垂直居中, 不再有"标签顶到上一行"的错位 */
.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bar :deep(.tv-select.inline select) { min-width: 150px; }
.sum { color: var(--muted); font-size: 12px; }
.sum b { color: var(--accent); }
.sfthide { color: var(--muted); }
.spacer { flex: 1 1 auto; }
.phint, .hintline { color: var(--muted); font-size: 11px; }
.hintline { line-height: 1.6; }
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

/* 保留优先级行: 标签 + 可拖拽文件夹链 + 重置 */
.prio { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plab { font-size: 12px; color: var(--muted); white-space: nowrap; }
.chips { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text, inherit);
  background: var(--panel3, rgba(128,128,128,.15));
  border: 1px solid var(--border, rgba(128,128,128,.25));
  border-radius: 999px; padding: 2px 9px;
  cursor: grab; user-select: none; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip:active { cursor: grabbing; }
.chip b {
  font-size: 10px; line-height: 1; flex: none;
  background: var(--accent); color: var(--on-accent, #fff);
  border-radius: 999px; padding: 2px 5px;
}
.chip.over { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.phint { flex-basis: 100%; }

.list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.grp {
  border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 8px; padding: 8px 10px;
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
  width: 150px; border: 1px solid var(--border, rgba(128,128,128,.25)); border-radius: 6px;
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
/* 非保留项: 左上角灰色小名次(让"为什么它排第 N"看得见) */
.rank {
  position: absolute; top: 6px; left: 6px; z-index: 2;
  min-width: 16px; height: 16px; border-radius: 999px; padding: 0 4px;
  background: rgba(10, 13, 18, .6); color: rgba(255,255,255,.85);
  font-size: 10px; line-height: 16px; text-align: center;
  pointer-events: none;
}
/* 文件名 / 所在文件夹 / 尺寸: 全省略号, 悬停 title 里给全路径 */
.meta { display: flex; flex-direction: column; gap: 1px; padding: 4px 6px 5px; }
.fname {
  font-size: 11px; color: var(--text, inherit);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fdir {
  font-size: 10px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dims { font-size: 10px; color: var(--muted); }
</style>
