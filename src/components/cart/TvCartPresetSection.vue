<script setup>
/**
 * 购物车自动导出 —— 配置面板(只有一份预设)
 * ========================================
 * 用户诉求(2026-09-29):「检测当前购物车, 如果当前购物车有更新, 就导出一份当前购物车
 * 到指定路径, 这个预设只需要一个」。
 *
 * 这个组件只有一份实现、两个宿主:
 *   · TvCartPresetModal.vue —— 从购物车抽屉里的「⚙ 自动导出」进来(任何视图都能开)
 *   · TvExportPresetsModal.vue —— 内嵌在「导出预设」弹窗里, 跟黑名单那条预设同一个台面
 * 拆成"宿主 + 主体"是因为抽屉是全站的、而导出预设弹窗只挂在首页 —— 只有一份 UI 才不会漂移。
 *
 * 状态的三个来源:
 *   1. 进面板时拉一次 api.cartPreset()
 *   2. 每次改配置(开关/目录/文件名/延迟)后拉一次(主进程是唯一真源, 不本地乐观更新)
 *   3. 主进程推 cart:auto 时拉一次(排上/导完都要刷新"还剩多久 / 上次导出")
 * 待导出期间每秒本地走一次倒计时(不靠每秒推送 —— 3 分钟就是 180 次唤醒, 纯浪费)。
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import TvButton from '../base/TvButton.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
import TvInput from '../base/TvInput.vue'
import TvSelect from '../base/TvSelect.vue'
import { api, onPush } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { nfmt, shortPath, ts } from '@/utils/format.js'

/**
 * 两个本地小格式化。
 * ⚠️ 不复用 format.js 的 dur(): 那个是隔壁那条还没提交的线加的(购物车这条不去依赖它的
 * 半成品), 而且它给的是人话时长("1.5 秒"), 排程倒计时要的是 mm:ss。
 */
function humanDelay(v) {
  const n = Math.max(0, Number(v) || 0)
  if (n < 60000) {
    const s = n / 1000
    return `${Number.isInteger(s) ? s : s.toFixed(1)} 秒`
  }
  const m = n / 60000
  return `${Number.isInteger(m) ? m : m.toFixed(1)} 分钟`
}
function mmss(v) {
  const t = Math.max(0, Math.round((Number(v) || 0) / 1000))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

const ui = useUiStore()
const cart = useCartStore()

const s = ref(null)
const loading = ref(true)
const busy = ref(false)
const fileDraft = ref('')
const fileFocus = ref(false)     // 正在输入文件名时别被刷新冲掉草稿
const left = ref(0)              // 本地倒计时(ms)
let tick = null
let offPush = null

const enabled = computed(() => !!s.value?.enabled)
const dir = computed(() => s.value?.dir || '')
const delayMs = computed(() => Number(s.value?.delayMs) || 0)
const delayOpts = computed(() => (s.value?.delayOptions || []).map((v) => ({ value: v, label: humanDelay(v) })))
const pending = computed(() => !!s.value?.pending)
const running = computed(() => !!s.value?.running)

/** 一句话说清"现在什么情况" —— 这块最容易让人以为功能坏了(排程期间文件本来就不会变) */
const statusText = computed(() => {
  if (!enabled.value) return '未开启'
  if (!dir.value) return '还没选目标目录 —— 变更后不会导'
  if (running.value) return '正在导出…'
  if (pending.value) return `待导出(还剩 ${mmss(left.value)})`
  /* 空不空看**渲染层手里这份**购物车: 主进程的 cartCount 要等它收到一次
     cart:changed 才有值(开窗时没有改动就是 0), 拿它判会误报「购物车是空的」。 */
  if (!cart.count) return '购物车是空的'
  return s.value?.synced ? '已同步' : '购物车有更新，等待导出'
})
const statusTone = computed(() => {
  if (!enabled.value || !dir.value) return 'off'
  if (!cart.count) return 'off'
  if (running.value || pending.value) return 'wait'
  return s.value?.synced ? 'ok' : 'warn'
})

const lastText = computed(() => {
  const v = s.value
  if (!v?.lastRunAt) return '还没导出过'
  const head = `${ts(v.lastRunAt)} · ${nfmt(v.lastCount)} 行`
  return v.lastTrigger === 'enable' ? `${head}（打开开关时自动导的）` : head
})

async function load() {
  try {
    s.value = await api.cartPreset()
    // 用户正在输入框里打字时别把草稿冲掉
    if (!fileFocus.value) fileDraft.value = s.value?.file || ''
    left.value = Number(s.value?.remainingMs) || 0
  } catch (e) {
    ui.err('读取购物车预设失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

async function save(patch, okMsg = '') {
  busy.value = true
  try {
    s.value = await api.cartPresetSave(patch)
    left.value = Number(s.value?.remainingMs) || 0
    fileDraft.value = s.value?.file || ''
    if (okMsg) ui.ok(okMsg, 2000)
  } catch (e) {
    ui.err('保存失败: ' + e.message)
    await load()                 // 取回真实值, 免得界面停在没生效的状态上
  } finally {
    busy.value = false
  }
}

const onToggle = (v) => save({ enabled: v }, v ? '🛒 已开启购物车自动导出' : '已关闭购物车自动导出')

async function pickDir() {
  try {
    const r = await api.pickExportDir()
    if (r?.canceled) return
    await save({ dir: r.path }, '已设置目标目录')
  } catch (e) { ui.err('选目录失败: ' + e.message) }
}

async function openDir() {
  if (!dir.value) return
  try { await api.openPath(dir.value) } catch (e) { ui.err(e.message) }
}

const saveFile = () => {
  if (fileDraft.value.trim() === (s.value?.file || '')) return
  save({ file: fileDraft.value })
}

/** 移开焦点就落盘(用户改完文件名往往直接去点别的, 不会敲回车) */
function onFileBlur() {
  fileFocus.value = false
  saveFile()
}

/** 立即导出一次: 把渲染层手里最新的购物车带上去 —— 主进程内存里那份可能还没有(刚开窗) */
async function runNow() {
  busy.value = true
  try {
    const r = await api.cartPresetRun(cart.list.map((c) => c.tag))
    ui.ok(`✅ 已导出 ${nfmt(r?.count || 0)} 个角色(wildcard)`, 2400)
    await load()
  } catch (e) {
    ui.err('导出失败: ' + e.message)
    await load()
  } finally {
    busy.value = false
  }
}

async function flushNow() {
  busy.value = true
  try {
    await api.cartPresetFlushNow()
  } catch (e) { ui.err('立刻导出失败: ' + e.message) } finally { busy.value = false }
}

function startTick() {
  if (tick) return
  tick = setInterval(() => {
    left.value = Math.max(0, left.value - 1000)
    if (!left.value) { clearInterval(tick); tick = null; void load() }
  }, 1000)
}

onMounted(() => {
  void load()
  startTick()
  // 主进程排上/导完都会推 —— 结果 toast 由 useAppStore 统一弹, 这里只刷新面板
  offPush = onPush('cart:auto', () => { void load(); startTick() })
})
onBeforeUnmount(() => {
  if (tick) { clearInterval(tick); tick = null }
  offPush?.()
})
</script>

<template>
  <div class="cps">
    <div v-if="loading" class="muted">读取中...</div>
    <template v-else>
      <div class="row">
        <TvCheckbox isSwitch :model-value="enabled" label="购物车有更新就自动导出" @change="onToggle" />
        <span class="st" :class="statusTone">{{ statusText }}</span>
      </div>

      <div class="row">
        <span class="lb">目标目录</span>
        <span class="path" :title="dir">{{ dir ? shortPath(dir) : '（还没选）' }}</span>
        <TvButton size="sm" :loading="busy" @click="pickDir">选择…</TvButton>
        <TvButton size="sm" variant="secondary" :disabled="!dir" @click="openDir">打开</TvButton>
      </div>

      <div class="row">
        <span class="lb">文件名</span>
        <span class="fwrap" @focusout="onFileBlur">
          <TvInput
            v-model="fileDraft"
            size="sm"
            placeholder="roles_cart.txt"
            title="下游 ComfyUI 读的就是这个文件名 —— 改了要同步改那边的 wildcard 节点"
            @focus="fileFocus = true"
            @enter="saveFile"
            @update:model-value="fileFocus = true"
          />
        </span>
        <span class="faint">wildcard 格式，与「⬇ 导出 txt」一字不差</span>
      </div>

      <div class="row">
        <span class="lb">改完之后等</span>
        <TvSelect
          size="sm"
          :model-value="delayMs"
          :options="delayOpts"
          @update:model-value="(v) => save({ delayMs: v }, `⏱ 已改成 ${humanDelay(v)} 后再导`)"
        />
        <span class="faint">再导出（期间改多少次都只导一次）</span>
      </div>

      <div class="row">
        <TvButton size="sm" variant="primary" :loading="busy" :disabled="!dir || !cart.count" @click="runNow">
          ⬇ 立即导出一次
        </TvButton>
        <TvButton v-if="pending" size="sm" variant="warn" @click="flushNow">跳过等待，立刻导</TvButton>
        <span class="faint">当前购物车 {{ cart.count }} 个角色</span>
      </div>

      <div class="last">
        <div>上次导出：{{ lastText }}</div>
        <div v-if="s?.lastPath" class="p" :title="s.lastPath">{{ shortPath(s.lastPath) }}</div>
        <div v-if="s?.lastError" class="bad">⚠ 上次失败：{{ s.lastError }}</div>
      </div>

      <div class="tip">
        内容就是购物车里的<b>角色标签</b>（一行一个 wildcard，如
        <code>saori \(blue archive\)</code>）。<b>清空购物车不会导出</b> —— 免得存清单
        （导出 → 存清单 → 自动清空）顺手把下游那份文件清成空的。
      </div>
    </template>
  </div>
</template>

<style scoped>
.cps { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.lb { color: var(--muted); flex: 0 0 auto; }
.fwrap { flex: 1 1 150px; min-width: 130px; }
.path {
  flex: 1 1 160px; min-width: 0;
  padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--panel2); color: var(--text);
  font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.st { margin-left: auto; font-size: 11px; padding: 2px 8px; border-radius: var(--r-pill); }
.st.off  { color: var(--faint);  background: var(--panel2); }
.st.ok   { color: var(--accent2); background: var(--accent2-soft); }
.st.wait { color: var(--warn);   background: var(--warn-soft); }
.st.warn { color: var(--warn);   background: var(--warn-soft); }

.last { font-size: 11px; color: var(--muted); border-top: 1px dashed var(--border); padding-top: 6px; }
.last .p { color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.last .bad { color: var(--danger); }
.tip {
  font-size: 11px; color: var(--faint); line-height: 1.7;
  border-top: 1px dashed var(--border); padding-top: 6px;
}
.tip code { background: var(--panel2); padding: 0 4px; border-radius: 4px; color: var(--muted); }
.muted { color: var(--muted); font-size: 12px; }
.faint { color: var(--faint); font-size: 11px; }
</style>
