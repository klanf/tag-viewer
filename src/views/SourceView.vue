<script setup>
/**
 * 来源管理 —— 文件夹登记表的界面
 * ================================
 * 改造前"来源"是**写死的**: config.data_files_dir 里躺着几个 tags_*.txt 就有几个来源,
 * 项目里没有添加/删除来源的入口 —— 想加一个来源得去跑外部 Python 脚本生成
 * `tags_<名>.txt`, 再重启看板。
 *
 * 现在"来源"与"扫描夹"都是 `folders` 表里的一行, 靠两个独立开关区分用途:
 *   · 看板来源(as_source) -> 图片进库、进统计、可被搜索
 *   · 扫描夹  (as_scan)   -> 扫描页能打开看图, 但不进库
 * 两者可同时打开(如「涩不了一点」), 也可以都关掉 —— 那是"移出登记表":
 * **行还留着**, 所以误删只要把开关打回来就恢复, 库里的图片记录一条都不会掉。
 *
 * ⚠️ 与扫描页的分工: 扫描页管"看", 这里管"登记与追平"。同一个目录在两处都能加,
 * 加进来的是同一条记录(不会出现两本账)。
 */
import { ref, computed, onMounted } from 'vue'
import TvInput from '@/components/base/TvInput.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvCheckbox from '@/components/base/TvCheckbox.vue'
import TvState from '@/components/base/TvState.vue'
import TvModal from '@/components/base/TvModal.vue'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSourceStore } from '@/stores/useSourceStore.js'
import { api } from '@/utils/api.js'
import { nfmt } from '@/utils/format.js'

const ui = useUiStore()
const srcStore = useSourceStore()

const list = ref([])
const loading = ref(false)
const err = ref('')
const kw = ref('')
const showRemoved = ref(false)

/* 新增 */
const manual = ref('')
const newAsSource = ref(true)
const newAsScan = ref(false)
const newRecursive = ref(true)
const adding = ref(false)
const addNote = ref('')

/* 改名(行内编辑) */
const editingPath = ref('')
const editName = ref('')

/* 彻底清除(高危, 必须二次确认) */
const purgeTarget = ref(null)
const purging = ref(false)

const busy = ref('')      // 正在操作的 path(按行禁用按钮)

const rows = computed(() => {
  const k = kw.value.trim().toLowerCase()
  let arr = list.value.filter((f) => showRemoved.value || f.as_source || f.as_scan)
  if (k) {
    arr = arr.filter((f) => (f.name || '').toLowerCase().includes(k)
      || (f.path || '').toLowerCase().includes(k))
  }
  // 生效的来源在前, 其次按库内图数; 同一档保持登记顺序(id 升序)稳定
  return arr.slice().sort((a, b) => (b.as_source - a.as_source) || (b.images - a.images))
})

const stats = computed(() => ({
  source: list.value.filter((f) => f.as_source).length,
  scan: list.value.filter((f) => f.as_scan).length,
  removed: list.value.filter((f) => !f.as_source && !f.as_scan).length,
  images: list.value.reduce((n, f) => n + f.images, 0),
}))

function fmtTime(ms) {
  if (!ms) return '从未'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const d = await api.folders({ usage: 'all' })
    list.value = d.folders || []
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

/** 改完之后: 刷新来源筛选条与数据集总量(看板上的数字与胶囊都由它们驱动) */
async function refreshAfterChange(msg) {
  if (msg) ui.ok(msg)
  await load()
  try { await srcStore.load() } catch { /* 数据集还没就绪时忽略 */ }
}

function replace(folder) {
  const i = list.value.findIndex((x) => x.path === folder.path)
  if (i >= 0) list.value[i] = folder
  else list.value = [...list.value, folder]
}

/* ---------------- 新增 ---------------- */

function addByPicker() {
  api.pickFolder({ multi: true, title: '选择要登记的文件夹(可多选)' }).then(async (picked) => {
    if (picked?.canceled) return
    await addMany(picked.paths || (picked.path ? [picked.path] : []))
  }).catch((e) => ui.err('打开文件夹选择框失败: ' + e.message))
}

async function addManual() {
  const p = manual.value.trim()
  if (!p) { ui.warn('先粘贴或输入一个文件夹路径'); return }
  const ok = await addMany([p])
  if (ok) manual.value = ''
}

async function addMany(paths) {
  if (!paths.length) return false
  adding.value = true
  addNote.value = ''
  let done = 0
  try {
    for (const p of paths) {
      addNote.value = `正在扫描并登记 ${++done}/${paths.length} ...`
      const r = await api.addFolder({
        path: p,
        as_source: newAsSource.value,
        as_scan: newAsScan.value,
        recursive: newRecursive.value,
      })
      if (r?.error) { ui.err(`${p}: ${r.error}`); continue }
      replace(r.folder)
    }
    await refreshAfterChange(`✅ 已登记 ${done} 个目录`)
    return true
  } finally {
    adding.value = false
    addNote.value = ''
  }
}

/* ---------------- 用途开关 / 改名 ---------------- */

async function setUse(f, key, val) {
  busy.value = f.path
  try {
    const r = await api.updateFolder({ path: f.path, [key]: val })
    if (r?.error) { ui.err(r.error); return }
    replace(r.folder)
    // 关掉"看板来源"意味着这个目录的图不再参与统计 —— 必须让来源条跟着变
    if (key === 'as_source') await refreshAfterChange()
  } finally { busy.value = '' }
}

function startRename(f) {
  editingPath.value = f.path
  editName.value = f.label || f.name
}

async function saveRename(f) {
  const next = editName.value.trim()
  editingPath.value = ''
  if (next === (f.label || '')) return
  busy.value = f.path
  try {
    const r = await api.updateFolder({ path: f.path, label: next })
    if (r?.error) { ui.err(r.error); return }
    replace(r.folder)
    // 来源名就是看板上的分组名 —— 改名之后筛选条与统计口径都得重取
    await refreshAfterChange(next ? `✅ 已改名为「${next}」` : '✅ 已清空显示名')
  } finally { busy.value = '' }
}

/* ---------------- 同步 / 重扫 / 移出 / 清除 ---------------- */

async function syncOne(f) {
  busy.value = f.path
  ui.toast(`开始同步「${f.name}」...`, 'info')
  try {
    const st = await api.syncFolder({ id: f.id })
    if (st?.error) { ui.err(st.error); return }
    const changed = (st.inserted || 0) + (st.metaUpdated || 0) + (st.goneSet || 0)
    await refreshAfterChange(changed
      ? `✅ 「${f.name}」同步完成: 新增/更新 ${changed} 张`
      : `「${f.name}」已是最新, 没有变化`)
  } catch (e) {
    ui.err('同步失败: ' + e.message)
  } finally { busy.value = '' }
}

async function rescan(f) {
  busy.value = f.path
  try {
    const r = await api.rescanFolder({ path: f.path })
    if (r?.error) { ui.err(r.error); return }
    replace(r.folder)
    ui.ok(`✅ 已重扫「${f.name}」`)
  } finally { busy.value = '' }
}

async function removeOne(f) {
  busy.value = f.path
  try {
    const r = await api.removeFolder(f.path)
    if (r?.error) { ui.err(r.error); return }
    replace(r.removed)
    await refreshAfterChange(`已移出登记表: ${f.name}(图片记录保留, 可恢复)`)
  } finally { busy.value = '' }
}

async function doPurge() {
  const f = purgeTarget.value
  if (!f) return
  purging.value = true
  try {
    const r = await api.purgeFolder(f.path)
    if (r?.error) { ui.err(r.error); return }
    purgeTarget.value = null
    await refreshAfterChange(`🔥 已清除「${f.name}」的 ${nfmt(r.purged.images)} 条图片记录`)
  } finally { purging.value = false }
}

async function exportBackup() {
  try {
    const r = await api.exportFolders()
    ui.ok(`✅ 已导出 ${r.folders} 条登记记录 -> ${r.file}`)
  } catch (e) { ui.err('导出失败: ' + e.message) }
}

async function reloadDataset() {
  try {
    ui.toast('正在重载看板数据 ...', 'info')
    await api.reload()
    await srcStore.load()
    ui.ok('✅ 看板数据已重载')
  } catch (e) { ui.err('重载失败: ' + e.message) }
}

async function openInExplorer(f) {
  try { await api.openPath(f.path) } catch (e) { ui.err(e.message) }
}

onMounted(load)
</script>

<template>
  <div class="source-view">
    <div class="panel bar-panel">
      <h2>🗂️ 来源管理</h2>
      <div class="tip">
        「来源」与「扫描夹」是同一份登记表(folders)上的两个开关 ——
        <b>来源</b>进标签库、参与统计与搜索；<b>扫描夹</b>只在扫描页浏览、不进库。<br>
        登记表存在 <code>tags.db</code> 里；<code>user/folders.json</code> 只是可导出的备份。
      </div>

      <div class="bar">
        <TvButton variant="primary" :loading="adding" @click="addByPicker">📁 添加目录(可多选)</TvButton>
        <div class="path">
          <TvInput
            v-model="manual"
            placeholder="或粘贴文件夹路径后回车"
            @enter="addManual"
          />
        </div>
        <TvCheckbox v-model="newRecursive" label="含子文件夹" />
        <TvCheckbox v-model="newAsSource" label="作为看板来源" />
        <TvCheckbox v-model="newAsScan" label="作为扫描夹" />
      </div>
      <div v-if="addNote" class="progress">⏳ {{ addNote }}</div>

      <div class="bar2">
        <TvInput v-model="kw" size="sm" placeholder="🔍 过滤(名字 / 路径)" class="kw" />
        <TvCheckbox v-model="showRemoved" label="显示已移出的" />
        <span class="spacer" />
        <span class="cnt">
          <b>{{ stats.source }}</b> 个来源 · <b>{{ stats.scan }}</b> 个扫描夹 ·
          入库 <b>{{ nfmt(stats.images) }}</b> 张
          <template v-if="stats.removed"> · 已移出 {{ stats.removed }}</template>
        </span>
        <TvButton size="sm" variant="secondary" :loading="loading" @click="load">🔄 刷新</TvButton>
        <TvButton size="sm" variant="secondary" title="把登记表导出成 user/folders.json" @click="exportBackup">💾 导出备份</TvButton>
        <TvButton size="sm" variant="secondary" title="改完来源后让看板立刻用上新数据" @click="reloadDataset">♻️ 重载看板</TvButton>
      </div>

      <div v-if="err" class="err">读取失败: {{ err }}</div>
    </div>

    <div class="panel list-panel">
      <TvState v-if="loading && !list.length" state="loading" text="正在读取登记表..." />
      <TvState
        v-else-if="!rows.length"
        state="empty"
        text="还没有登记任何目录 —— 点上面的「添加目录」开始"
      />
      <div v-else class="rows">
        <div v-for="f in rows" :key="f.path" :class="['row', { off: !f.as_source && !f.as_scan, dead: !f.exists }]">
          <div class="cell name">
            <template v-if="editingPath === f.path">
              <div class="rename">
                <TvInput v-model="editName" size="sm" placeholder="显示名(留空则用目录名)" @enter="saveRename(f)" />
                <TvButton size="xs" variant="primary" @click="saveRename(f)">✓</TvButton>
                <TvButton size="xs" variant="ghost" @click="editingPath = ''">✕</TvButton>
              </div>
            </template>
            <template v-else>
              <span class="nm" :title="f.label ? `显示名: ${f.label}` : '未自定义显示名'">{{ f.name }}</span>
              <button class="mini" title="改显示名" @click="startRename(f)">✏️</button>
            </template>
          </div>

          <div class="cell path-cell">
            <span class="p" :title="f.path">{{ f.path }}</span>
            <button class="mini" title="在资源管理器里打开" @click="openInExplorer(f)">📂</button>
          </div>

          <div class="cell uses">
            <TvCheckbox
              :model-value="f.as_source"
              :disabled="busy === f.path"
              is-switch
              label="来源"
              title="参与标签库: 图片进库、进看板统计、可被搜索"
              @update:model-value="(v) => setUse(f, 'as_source', v)"
            />
            <TvCheckbox
              :model-value="f.as_scan"
              :disabled="busy === f.path"
              is-switch
              label="扫描"
              title="仅浏览: 扫描页能打开看图, 但不进库"
              @update:model-value="(v) => setUse(f, 'as_scan', v)"
            />
          </div>

          <div class="cell num" title="库里属于这个目录的图片记录数">
            <b>{{ nfmt(f.images) }}</b><span>张</span>
          </div>

          <div class="cell time" :title="f.last_scan ? fmtTime(f.last_scan) : '还没扫描过'">
            {{ fmtTime(f.last_scan) }}
          </div>

          <div class="cell acts">
            <span v-if="!f.exists" class="tag warn">路径失效</span>
            <span v-else-if="!f.as_source && !f.as_scan" class="tag off">已移出</span>
            <TvButton
              v-if="f.as_source"
              size="xs"
              variant="secondary"
              :disabled="busy === f.path"
              title="只同步这一个目录(磁盘 -> 标签库)"
              @click="syncOne(f)"
            >⟳ 同步</TvButton>
            <TvButton
              size="xs"
              variant="secondary"
              :disabled="busy === f.path || !f.exists"
              title="重新扫描这个目录并更新统计与封面"
              @click="rescan(f)"
            >🔄 重扫</TvButton>
            <TvButton
              v-if="f.as_source || f.as_scan"
              size="xs"
              variant="ghost"
              :disabled="busy === f.path"
              title="移出登记表(图片记录保留, 可再打回来)"
              @click="removeOne(f)"
            >移出</TvButton>
            <template v-else>
              <TvButton size="xs" variant="primary" title="恢复为看板来源" @click="setUse(f, 'as_source', true)">恢复</TvButton>
              <TvButton size="xs" variant="danger" title="连库里的图片记录一起删掉(不可撤销)" @click="purgeTarget = f">清除</TvButton>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 彻底清除: 高危, 必须二次确认 -->
    <TvModal
      :model-value="!!purgeTarget"
      title="🔥 彻底清除这个目录的记录"
      size="sm"
      :mask-closable="false"
      @close="purgeTarget = null"
    >
      <p class="q">把 <b>{{ purgeTarget?.name }}</b> 在库里的 <b>{{ nfmt(purgeTarget?.images || 0) }}</b> 条图片记录(含标签)永久删除?</p>
      <p class="path-box">{{ purgeTarget?.path }}</p>
      <ul class="note-list">
        <li>磁盘上的图片文件 <b>一个都不会动</b>。</li>
        <li>删掉的是标签库里的记录 —— 若 <code>tags_*.txt</code> 已归档, 这批标签<b>无法重建</b>, 只能重新反推。</li>
        <li>只想让它在看板上消失, 请用「移出」(可恢复), 不要用这个。</li>
      </ul>
      <template #footer>
        <TvButton variant="secondary" @click="purgeTarget = null">取消</TvButton>
        <TvButton variant="danger" :loading="purging" @click="doPurge">确认清除</TvButton>
      </template>
    </TvModal>
  </div>
</template>

<style scoped>
.source-view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow: hidden;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}
.bar-panel { flex: 0 0 auto; padding: 12px 14px; }
.bar-panel h2 { font-size: 15px; margin-bottom: 6px; }
.tip { font-size: 11.5px; color: var(--muted); line-height: 1.7; margin-bottom: 10px; }
.tip b { color: var(--accent); }
.tip code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-size: 11px; }

.bar, .bar2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bar2 { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--border); }
.spacer { flex: 1; min-width: 0; }
.path { flex: 1 1 320px; min-width: 220px; }
.kw { width: 240px; }
.cnt { font-size: 11.5px; color: var(--muted); }
.cnt b { color: var(--accent); }
.progress { margin-top: 8px; font-size: 12px; color: var(--warn); }
.err { margin-top: 8px; font-size: 12px; color: var(--danger); }

.list-panel { flex: 1 1 auto; min-height: 0; overflow: auto; }
.rows { display: flex; flex-direction: column; }

.row {
  display: grid;
  grid-template-columns: minmax(150px, 1.1fr) minmax(220px, 2fr) 190px 84px 132px minmax(240px, auto);
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.row:last-child { border-bottom: none; }
.row:hover { background: var(--panel2); }
.row.off { opacity: .62; }
.row.dead .path-cell .p { text-decoration: line-through; color: var(--faint); }

.cell { min-width: 0; display: flex; align-items: center; gap: 6px; }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path-cell .p {
  color: var(--muted); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left;      /* 长路径优先露出末尾的目录名 */
}
.uses { gap: 12px; }
.rename { display: flex; align-items: center; gap: 4px; width: 100%; }
.num b { color: var(--accent); font-size: 13px; }
.num span { font-size: 10px; color: var(--faint); margin-left: 2px; }
.time { font-size: 11px; color: var(--faint); }
.acts { justify-content: flex-end; gap: 6px; }

.tag {
  font-size: 10px; padding: 2px 6px; border-radius: var(--r-pill);
}
.tag.warn { background: var(--warn-soft); color: var(--warn); }
.tag.off { background: var(--panel3); color: var(--faint); }

.mini {
  border: none; background: transparent; cursor: pointer;
  font-size: 12px; padding: 2px 4px; border-radius: 4px;
  color: var(--muted); line-height: 1;
}
.mini:hover { background: var(--panel3); }

.q { font-size: 13px; margin-bottom: 8px; }
.q b { color: var(--danger); }
.path-box {
  margin: 0 0 8px; padding: 7px 10px;
  background: var(--panel2); border-radius: var(--r-sm);
  font-size: 11px; color: var(--muted); word-break: break-all;
}
.note-list { margin: 0 0 10px; padding-left: 18px; font-size: 11.5px; color: var(--muted); line-height: 1.8; }
.note-list code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; }

@media (max-width: 1180px) {
  .row { grid-template-columns: minmax(130px, 1.2fr) minmax(140px, 1.4fr) 170px 70px minmax(200px, auto); }
  .time { display: none; }
}
</style>
