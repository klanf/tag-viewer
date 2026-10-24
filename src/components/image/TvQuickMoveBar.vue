<script setup>
/**
 * 光箱「快速移动」按钮条(2026-09-29 用户需求)
 * =========================================
 * 用户在扫描页看图的流水线原来是: 看一张 -> 右键 -> 移动 -> 鼠标找文件夹 -> 点 —— 太累。
 * 这里把绑定的路径直接铺成一排小按钮: 点一下 = 当前图移过去, 光箱自动前进到下一张。
 *
 * 自动前进**不是本组件做的**: 移动成功后广播 'tv:moved', useLightboxStore 订阅它
 * 剔掉当前图并前进 —— 与右键菜单「移动到」/ 批量移动同一条出口, 别再另做一套。
 *
 * 数字键 1~9 对应前 9 个按钮(光箱原有 Esc/箭头/Del 之外的空闲键位), 超过 9 个的
 * 路径折叠成「+N」(鼠标点得到, 快捷键够不着)。管理弹窗整表编辑(改名/排序/删除/添加),
 * 保存走 app:quickFolders:set —— 与右键菜单「移动到」/ 批量移动弹窗**共用同一份**
 * settings.json quickFolders, 一处管理三处生效, 刻意不做第二份清单。
 *
 * 2026-10-01 两态: 收起 = 一个 SVG 圆钮(FAB), 点开展开成胶囊按钮条, ‹ 收回。
 * 2026-10-01 晚重做 UI + 修「收起态没法拖」:
 *   · FAB 自己吃 pointerdown —— **移动 ≥5px 判拖动**(松手落位存 localStorage),
 *     **原地松手判点击**走 @click 展开。拖完那次合成 click 用 suppressClick 吞掉,
 *     否则拖完松手会"顺手"把条展开。e2e 的 el.click() 只发 click 不发 pointer,
 *     所以展开逻辑必须留在 click 里, pointer 这边只负责拖与吞。
 *   · 展开条整条空白处都能拖(容器 pointerdown 里排除按钮/输入框/把手),
 *     把手 ⠿ 单独分流: 点击=收起, 按住=拖(见下方 gripDown)。
 * 位置(pos)两态共用: 拖过的位置收起后圆钮也落在那儿。每次开光箱重新收起 ——
 * 不持久化展开态, 免得「忘了收」变成常驻挡图。
 */
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvInput from '@/components/base/TvInput.vue'
import { api } from '@/utils/api.js'
import { useFavStore } from '@/stores/useFavStore.js'
import { useUiStore } from '@/stores/useUiStore.js'

const props = defineProps({
  /** 当前光箱里的图(要移走的那张); 光箱没开时本组件整个不挂载 */
  path: { type: String, default: '' },
})
const fav = useFavStore()
const ui = useUiStore()

/* ---- 悬浮条位置: 默认底部居中, 可拖动, 记忆到 localStorage ----
 * pos 为 null 时走 CSS 默认定位(底部居中); 一旦拖过就切到绝对坐标并存档。 */
const barEl = ref(null)
const pos = ref(null)          // { x, y } = 视口坐标(left/top)
const POS_LS = 'lb-qm-pos'
/* 收起/展开两态: 光箱每次打开都从收起态开始(见顶部注释) */
const expanded = ref(false)

function clampPos(p) {
  const w = barEl.value?.offsetWidth || 42
  const h = barEl.value?.offsetHeight || 42
  return {
    x: Math.min(Math.max(p.x, 8), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(p.y, 8), Math.max(8, window.innerHeight - h - 8)),
  }
}
function loadPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_LS))
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos.value = clampPos(p)
  } catch { /* 坏数据就当没存过 */ }
}
function savePos() {
  try { localStorage.setItem(POS_LS, JSON.stringify(pos.value)) } catch { /* 存不进就下次还在默认位 */ }
}

/* ---- 展开条的拖动(原有逻辑, 容器级) ---- */
let drag = null
function dragStart(e) {
  if (e.button !== 0) return
  const r = barEl.value.getBoundingClientRect()
  pos.value = { x: r.left, y: r.top }      // 从 CSS 默认位切到绝对坐标
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
  window.addEventListener('pointermove', dragMove)
  window.addEventListener('pointerup', dragEnd)
  e.preventDefault()
}
function dragMove(e) {
  if (drag) pos.value = clampPos({ x: e.clientX - drag.dx, y: e.clientY - drag.dy })
}
function dragEnd() {
  drag = null
  window.removeEventListener('pointermove', dragMove)
  window.removeEventListener('pointerup', dragEnd)
  savePos()
}
/** 容器级拖动入口: 点在按钮/输入框/把手上不拖(把手有自己的「拖 vs 点收起」分流),
 * 空白处都算。 */
function barDown(e) {
  if (e.target.closest('button, input, a, .qm-grip')) return
  dragStart(e)
}

/* ---- 收起态 FAB 的「拖 vs 点」分流 ---- */
let fab = null               // { sx, sy, r, moved }
let suppressClick = false
function fabDown(e) {
  if (e.button !== 0) return
  suppressClick = false
  fab = { sx: e.clientX, sy: e.clientY, r: barEl.value.getBoundingClientRect(), moved: false }
  window.addEventListener('pointermove', fabMove)
  window.addEventListener('pointerup', fabUp)
}
function fabMove(e) {
  if (!fab) return
  const dx = e.clientX - fab.sx
  const dy = e.clientY - fab.sy
  if (!fab.moved && Math.hypot(dx, dy) < 5) return   // 死区: 手抖不算拖
  fab.moved = true
  if (!pos.value) pos.value = { x: fab.r.left, y: fab.r.top }
  pos.value = clampPos({ x: fab.r.left + dx, y: fab.r.top + dy })
}
function fabUp() {
  if (fab?.moved) {
    suppressClick = true     // 这次松手的合成 click 是"拖完", 不许它再展开
    savePos()
  }
  fab = null
  window.removeEventListener('pointermove', fabMove)
  window.removeEventListener('pointerup', fabUp)
}
function fabClick() {
  if (suppressClick) { suppressClick = false; return }
  toggleExpand()
}

/* ---- 展开态把手 ⠿ 的「拖 vs 点」分流(2026-10-02 用户要求) ----
 * 之前把手只是个视觉提示, 展开条又几乎被按钮铺满, 用户实际找不到能拖的地方
 * ("展开后就不能移动了")。现在把把手做成正经把手:
 *   · 按住 + 移动 ≥5px = 拖动整条(与 FAB 同一套阈值逻辑);
 *   · 原地松手 = 点击 -> 收起工具条(不用再去瞄右端那个 ‹)。
 * barDown 里已把 .qm-grip 排除, 两套 pointer 处理不会同时挂上。 */
let grip = null               // { sx, sy, r, moved }
function gripDown(e) {
  if (e.button !== 0) return
  grip = { sx: e.clientX, sy: e.clientY, r: barEl.value.getBoundingClientRect(), moved: false }
  window.addEventListener('pointermove', gripMove)
  window.addEventListener('pointerup', gripUp)
  e.preventDefault()
}
function gripMove(e) {
  if (!grip) return
  const dx = e.clientX - grip.sx
  const dy = e.clientY - grip.sy
  if (!grip.moved && Math.hypot(dx, dy) < 5) return   // 死区: 手抖不算拖
  grip.moved = true
  if (!pos.value) pos.value = { x: grip.r.left, y: grip.r.top }
  pos.value = clampPos({ x: grip.r.left + dx, y: grip.r.top + dy })
}
function gripUp() {
  if (grip?.moved) {
    savePos()
  } else {
    toggleExpand()         // 原地松手 = 点击把手 -> 收起
  }
  grip = null
  window.removeEventListener('pointermove', gripMove)
  window.removeEventListener('pointerup', gripUp)
}

function onResize() { if (pos.value) pos.value = clampPos(pos.value) }

/* 收起/展开切换: 展开后的条比圆钮宽得多, 已存过的 pos 可能把宽条顶出视口右缘 ——
 * 等 DOM 更新拿到真实宽度再 clamp 一次。 */
async function toggleExpand() {
  expanded.value = !expanded.value
  if (expanded.value && pos.value) {
    await nextTick()
    pos.value = clampPos(pos.value)
  }
}

const folders = ref([])
const busy = ref(false)        // 正在移动(锁按钮 + 数字键, 防连点重复移动)
const showMgr = ref(false)
const draft = ref([])          // 管理弹窗的本地草稿, 点「保存」才落盘
const saving = ref(false)

async function reload() {
  try {
    const d = await api.quickFolders()
    folders.value = Array.isArray(d?.quickFolders) ? d.quickFolders : []
  } catch { folders.value = [] }
}

async function moveTo(f) {
  if (busy.value || !props.path || !f?.path) return
  busy.value = true
  const from = props.path
  try {
    // 注意 target 是**目录字符串**(image:moveMany 的约定, ScanView 传的也是 target.path)
    const r = await api.moveImages([from], f.path)
    if (r?.ok) {
      const m = r.moved?.[0]
      ui.ok(`📤 已移动到 ${m?.name || f.name}`, 1800)
      // 收藏跟着挪到新位置(同右键移动的口径); 广播让各视图剔除 + 光箱前进
      fav.onMoved(from, m?.to || '')
      window.dispatchEvent(new CustomEvent('tv:moved', {
        detail: { paths: [from], dest: m?.to || '' },
      }))
    } else {
      ui.err('移动失败: ' + (r?.failed?.[0]?.error || r?.error || '未知原因'), 3600)
    }
  } catch (e) {
    ui.err('移动失败: ' + e.message, 3600)
  } finally {
    busy.value = false
  }
}

/* 数字键 1~9 = 前 9 个按钮。监听挂 window 上(与 TvLightbox 的 onKey 同一套约定):
   焦点在输入框里不抢; 管理弹窗开着时不响应(正在编辑的就是这份列表)。
   2026-10-02 用户要求: **收起态也响应** —— 不展开就能按数字直接移走当前图,
   配合 FAB 收起态, 全程可以不展开这个条。 */
function onKey(e) {
  if (showMgr.value || busy.value) return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  const i = '123456789'.indexOf(e.key)
  if (i < 0 || i >= folders.value.length) return
  e.preventDefault()
  moveTo(folders.value[i])
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  void loadPos()
  void reload()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('pointermove', dragMove)
  window.removeEventListener('pointerup', dragEnd)
  window.removeEventListener('pointermove', fabMove)
  window.removeEventListener('pointerup', fabUp)
})

/* ---- 管理弹窗 ---- */
function openMgr() {
  draft.value = folders.value.map((f) => ({ ...f }))
  showMgr.value = true
}
function up(i) {
  const d = draft.value
  if (i > 0) { const t = d[i - 1]; d[i - 1] = d[i]; d[i] = t }
}
function down(i) {
  const d = draft.value
  if (i < d.length - 1) { const t = d[i + 1]; d[i + 1] = d[i]; d[i] = t }
}
function del(i) { draft.value.splice(i, 1) }
async function addFolder() {
  const r = await api.pickFolder({ multi: false, title: '绑定哪个文件夹?' })
  if (r?.canceled) return
  const p = r?.paths?.[0] || r?.path
  if (p) draft.value.push({ name: String(p).split(/[\\/]/).filter(Boolean).pop() || p, path: p })
}
async function saveMgr() {
  saving.value = true
  try {
    const r = await api.saveQuickFolders(draft.value)
    if (r?.ok) {
      folders.value = r.quickFolders || []
      showMgr.value = false
      ui.ok('已保存快速移动路径', 1600)
    } else {
      ui.err('保存失败: ' + (r?.error || '未知原因'), 3200)
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- 悬浮工具条: fixed 定位浮在图片上方; 收起 = SVG 圆钮(可拖可点), 展开 = 毛玻璃胶囊。
       DOM 上仍挂在 .lb-side 里 —— 它自带 @click.stop, 点工具条不会误关光箱。 -->
  <div
    ref="barEl"
    class="lb-qm"
    :class="{ placed: !!pos, mini: !expanded }"
    :style="pos ? { left: pos.x + 'px', top: pos.y + 'px' } : null"
    data-test="lb-quickmove"
  >
    <Transition name="qm-pop" mode="out-in">
      <!-- 收起态: 圆钮, 按住可拖、原地点开展开 -->
      <button
        v-if="!expanded"
        key="fab"
        class="qm-fab"
        type="button"
        data-test="qm-fab"
        title="快速移动: 点击展开路径条 · 按住可直接拖动位置"
        @pointerdown="fabDown"
        @click="fabClick"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M13 11.2l3.6 2.4-3.6 2.4v-1.6h-2.8v-1.6h2.8z" fill="currentColor" stroke="none" />
        </svg>
      </button>

      <!-- 展开态: 毛玻璃胶囊。把手 ⠿: 点击=收起, 按住=拖动整条 -->
      <div v-else key="bar" class="qm-bar">
        <span
          class="qm-grip"
          data-test="qm-grip"
          title="点击收起工具条 · 按住拖动位置"
          @pointerdown="gripDown"
        >⠿</span>
        <div class="qm-btns">
          <button
            v-for="(f, i) in folders.slice(0, 9)"
            :key="f.path"
            class="qm-btn"
            type="button"
            :disabled="busy"
            :title="`${f.path}${i < 9 ? `（快捷键 ${i + 1}）` : ''}`"
            :data-test="`qm-btn-${i + 1}`"
            @click="moveTo(f)"
          ><i v-if="i < 9" class="k">{{ i + 1 }}</i>{{ f.name }}</button>
          <button
            v-if="folders.length > 9"
            class="qm-btn more"
            type="button"
            disabled
            :title="folders.slice(9).map((f) => f.path).join('\n')"
          >+{{ folders.length - 9 }}</button>
          <button
            v-if="!folders.length"
            class="qm-btn add"
            type="button"
            data-test="qm-add"
            title="绑定常用路径, 以后一键移动"
            @click="openMgr"
          >＋ 绑定路径</button>
          <button
            class="qm-btn gear"
            type="button"
            data-test="qm-gear"
            title="管理快速移动路径(添加 / 改名 / 排序 / 删除)"
            @click="openMgr"
          >⚙</button>
        </div>
        <button
          class="qm-x"
          type="button"
          data-test="qm-collapse"
          title="收起工具条(拖过的位置会记住)"
          @click="toggleExpand"
        >‹</button>
      </div>
    </Transition>

    <!-- 收起态悬停提示: 跟在圆钮右侧浮出 -->
    <span v-if="!expanded" class="qm-tip" aria-hidden="true">快速移动 · 按住拖动</span>

    <TvModal
      :model-value="showMgr"
      title="⚙ 快速移动路径"
      size="sm"
      :z-index="400"
      @update:model-value="showMgr = $event"
    >
      <div class="mgr" data-test="qm-mgr">
        <div v-if="!draft.length" class="mgr-empty">还没有绑定任何路径 —— 点下面「添加文件夹」</div>
        <div v-for="(f, i) in draft" :key="i" class="mgr-row">
          <span class="no">{{ i + 1 }}</span>
          <TvInput v-model="f.name" size="sm" class="nm" title="按钮上显示的名字" />
          <span class="pth" :title="f.path">{{ f.path }}</span>
          <span class="acts">
            <button type="button" :disabled="i === 0" title="上移" @click="up(i)">↑</button>
            <button type="button" :disabled="i === draft.length - 1" title="下移" @click="down(i)">↓</button>
            <button type="button" class="rm" title="删除这条" @click="del(i)">✕</button>
          </span>
        </div>
      </div>
      <template #footer>
        <TvButton variant="secondary" @click="addFolder">📁 添加文件夹…</TvButton>
        <span class="foot-hint">与右键菜单「移动到」共用同一份预设</span>
        <TvButton variant="primary" :loading="saving" data-test="qm-mgr-save" @click="saveMgr">保存</TvButton>
      </template>
    </TvModal>
  </div>
</template>

<style scoped>
/* 悬浮工具条: 默认底部居中(78px —— 底下已有页码 10px / 操作提示 48px 两层, 别压住);
   拖过后 .placed 切绝对坐标(inline style 接管 left/top)。
   .mini = 收起态: 容器缩成圆钮, 不铺底色。 */
.lb-qm {
  position: fixed; left: 50%; bottom: 78px; transform: translateX(-50%);
  z-index: 5;
  display: flex; align-items: center;
  max-width: min(78vw, 920px);
}
.lb-qm.placed { bottom: auto; transform: none; }
.lb-qm.mini { background: transparent; }

/* 收起态圆钮: SVG 图标 + 半透明毛玻璃底, 不抢图; hover 提亮并轻微放大 */
.qm-fab {
  width: 40px; height: 40px; padding: 0;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: var(--accent);
  border: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(8px) saturate(1.15);
  cursor: grab; touch-action: none; user-select: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .22);
  transition: transform var(--t-fast) ease, border-color var(--t-fast) ease, background var(--t-fast) ease;
}
.qm-fab:hover { border-color: var(--accent); background: color-mix(in srgb, var(--panel) 92%, transparent); transform: scale(1.06); }
.qm-fab:active { cursor: grabbing; }

/* 悬停提示: 圆钮右侧浮出 */
.qm-tip {
  position: absolute; left: calc(100% + 10px); top: 50%;
  transform: translateY(-50%) translateX(-4px);
  white-space: nowrap;
  padding: 4px 10px; border-radius: var(--r-sm);
  background: var(--panel); border: 1px solid var(--border);
  color: var(--muted); font-size: 12px; pointer-events: none;
  opacity: 0; transition: opacity var(--t-fast) ease, transform var(--t-fast) ease;
  z-index: 6;
}
.lb-qm.mini:hover .qm-tip { opacity: 1; transform: translateY(-50%) translateX(0); }

/* 展开态胶囊: 毛玻璃底, 空白处可拖 */
.qm-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px 6px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  border: 1px solid var(--border);
  box-shadow: 0 6px 24px rgba(0, 0, 0, .18);
  cursor: default; user-select: none;
}

.qm-grip {
  flex: 0 0 auto; padding: 2px 4px;
  color: var(--faint); font-size: 13px; line-height: 1;
  cursor: grab;
}
.qm-grip:active { cursor: grabbing; }

.qm-btns { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }

.qm-btn {
  position: relative;
  display: inline-flex; align-items: center; gap: 5px;
  max-width: 100%;
  padding: 4px 11px; border-radius: 999px;
  background: var(--panel3); color: var(--text);
  border: 1px solid transparent; cursor: pointer;
  font-size: 12px; line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: border-color var(--t-fast) ease, background var(--t-fast) ease;
}
.qm-btn:hover { border-color: var(--accent); background: var(--accent-soft); }
.qm-btn:disabled { opacity: .55; cursor: default; }
.qm-btn .k {
  font-style: normal; font-size: 9px; line-height: 1;
  min-width: 15px; height: 15px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0 3px; border-radius: 999px;
  background: var(--accent-soft, var(--panel2)); color: var(--accent);
  flex: 0 0 auto;
}
.qm-btn.gear, .qm-btn.add { color: var(--muted); }
.qm-btn.more { color: var(--faint); cursor: help; }

/* 收起按钮: 细箭头, hover 提亮 */
.qm-x {
  flex: 0 0 auto; width: 22px; height: 22px; padding: 0;
  border-radius: 50%;
  color: var(--faint); font-size: 14px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.qm-x:hover { color: var(--text); background: var(--panel3); }

/* 展开/收起过渡: 快进快出, 不拖泥带水 */
.qm-pop-enter-active, .qm-pop-leave-active { transition: opacity .13s ease, transform .13s ease; }
.qm-pop-enter-from, .qm-pop-leave-to { opacity: 0; transform: scale(.88); }

/* 管理弹窗 */
.mgr { max-height: 46vh; overflow-y: auto; padding-right: 4px; }
.mgr-empty { color: var(--faint); font-size: 12px; padding: 8px 2px; }
.mgr-row {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 6px; margin-bottom: 4px;
  border-radius: var(--r-sm); background: var(--panel3);
}
.mgr-row .no { flex: 0 0 auto; font-size: 11px; color: var(--faint); width: 14px; text-align: right; }
.mgr-row .nm { flex: 0 0 130px; }
.mgr-row .pth {
  flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: rtl; text-align: left;
}
.mgr-row .acts { flex: 0 0 auto; display: flex; gap: 3px; }
.mgr-row .acts button {
  width: 22px; height: 22px; padding: 0;
  border: 1px solid var(--panel2); border-radius: var(--r-sm);
  background: var(--panel2); color: var(--muted); cursor: pointer; font-size: 11px;
}
.mgr-row .acts button:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.mgr-row .acts button:disabled { opacity: .4; cursor: default; }
.mgr-row .acts .rm:hover { color: var(--danger, #e5484d); border-color: var(--danger, #e5484d); }
.foot-hint { color: var(--faint); font-size: 11px; margin-right: auto; }
</style>
