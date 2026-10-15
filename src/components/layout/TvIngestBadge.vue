<script setup>
/**
 * 后台任务提示 —— 右下角小胶囊
 * =============================
 * 目前有两个后台任务共用这根胶囊(谁在跑显示谁, 都不在跑显示最近结束的那个):
 *   · 增量同步 —— 磁盘与 tags.db 对齐(见 electron/core/ingest.js)
 *   · WD14 反推 —— 消费 tag_queue, 给裸图打标签(见 electron/core/tagger.js)
 *
 * 为什么必须让用户看得见: 这两个过程都会在**启动后自动**跑, 首轮分别是
 * "枚举几万个文件" 与 "加载 1.27GB 模型再逐张推理"。如果界面上什么都不发生,
 * 会被当成卡死 —— 与当初「双击没反应」是同一类体验问题。
 *
 * 为什么不做成弹窗/遮罩: 两者都不阻塞使用, 用户完全可以边看边等。
 * 所以只占右下角一根胶囊, 跑完显示几秒摘要就自己消失。
 *
 * 位置刻意放在浮动导航(bottom 26 / z-index 220)之上, 两者不重叠。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { nfmt } from '@/utils/format.js'
import { openTaggerSetup } from '@/composables/useTaggerSetup.js'

const app = useAppStore()

/** 完成/失败后的摘要保留时长: 太短看不清数字, 太长挡视线 */
const LINGER_MS = 6000

/** 哪些 phase 算"还在跑"。同步与反推的 phase 名不重叠, 合成一张表更省事 */
const RUNNING_PHASES = new Set([
  'running', 'enum', 'compare', 'read', 'folder-done', 'rebuild-tags',   // 同步
  'probe', 'infer',                                                     // 反推
])

const show = ref(false)
const linger = ref(false)          // 当前展示的是"完成后的摘要"而不是进行中的进度
const dismissed = ref(false)
let timer = null

/**
 * 选一个要展示的任务。
 * 优先"正在跑的"; 都结束了就选**结束时间更晚**的那个 —— 否则同步先跑完、
 * 反推还在跑的时候, 胶囊会错误地停在同步的摘要上。
 */
const task = computed(() => {
  const ig = app.ingest
  const tg = app.tagger
  const rIg = !!ig && RUNNING_PHASES.has(ig.phase)
  const rTg = !!tg && RUNNING_PHASES.has(tg.phase)
  if (rTg) return { kind: 'tag', s: tg }
  if (rIg) return { kind: 'sync', s: ig }
  const a = ig ? Number(ig.lastRunAt) || 0 : -1
  const b = tg ? Number(tg.lastRunAt) || 0 : -1
  if (b > a) return { kind: 'tag', s: tg }
  if (ig) return { kind: 'sync', s: ig }
  return { kind: 'tag', s: tg }
})

const kind = computed(() => task.value.kind)
const s = computed(() => task.value.s || {})
const isTag = computed(() => kind.value === 'tag')
const running = computed(() => RUNNING_PHASES.has(s.value.phase))
const failed = computed(() => s.value.phase === 'error')
/** 反推特有的"没坏, 只是这条路走不通" —— 缺 python / 模型时是它 */
const degraded = computed(() => isTag.value && !!s.value.degraded)

const SYNC_PHASE_TEXT = {
  running: '正在比对',
  enum: '正在枚举',
  compare: '正在比对',
  read: '正在读取元数据',
  'folder-done': '同步中',
  'rebuild-tags': '正在重建标签字典',
}
const TAG_PHASE_TEXT = {
  probe: '正在探测反推环境',
  infer: '正在反推标签',
  'rebuild-tags': '正在重建标签字典',
}
const title = computed(() => (isTag.value ? TAG_PHASE_TEXT : SYNC_PHASE_TEXT)[s.value.phase] || (isTag.value ? '反推' : '同步'))

/** 当前阶段的百分比。没有 total 时退化成"第 n / m 个目录"(同步)或不定进度(反推探活) */
const pct = computed(() => {
  const v = s.value
  if (v.total > 0) return Math.max(0, Math.min(100, Math.round((v.done / v.total) * 100)))
  if (v.folderTotal > 0) return Math.max(0, Math.min(100, Math.round((v.folderIndex / v.folderTotal) * 100)))
  return 0
})

const st = computed(() => s.value.stats || null)

function clearTimer() {
  if (timer) { clearTimeout(timer); timer = null }
}

watch(
  () => [kind.value, s.value.phase, s.value.running, s.value.lastRunAt],
  ([, phase]) => {
    clearTimer()
    if (RUNNING_PHASES.has(phase)) {
      // 新一轮开始: 覆盖掉上一轮的摘要状态
      dismissed.value = false
      linger.value = false
      show.value = true
      return
    }
    if (phase === 'done') {
      if (!dismissed.value) {
        linger.value = true
        show.value = true
        timer = setTimeout(() => { show.value = false; linger.value = false }, LINGER_MS)
      }
      return
    }
    if (phase === 'error') {
      // 出错就停在那儿, 由用户关掉 —— 自动消失会把唯一的线索也带走
      linger.value = true
      show.value = true
      return
    }
    show.value = false
  },
  { immediate: true, deep: false },
)

function close() {
  clearTimer()
  dismissed.value = true
  show.value = false
  linger.value = false
}

async function runNow() {
  try {
    if (isTag.value) await app.taggerRun()
    else await app.ingestRun()
  } catch { /* 失败时主进程会推 error 状态 */ }
}

/**
 * 停止本次任务(2026-10-16): 后端早就有了 pauseTagger / pauseIngest —— 循环每处理
 * 一张就检查标志位, 置位后处理完当前这张就收工, **剩余留在队列里**, 下次点
 * 「再反推一次」接着跑(不是丢弃、不是清空队列表)。以前这个能力没有任何界面
 * 入口, 用户只能干等或者重启 —— 现在进行中的胶囊上直接给按钮。
 */
const stopping = ref(false)
async function stopNow() {
  if (stopping.value) return
  stopping.value = true
  try {
    const r = isTag.value ? await app.taggerPause() : await app.ingestPause()
    if (r && r.ok === false) useUiStore().warn(r.error || '没有正在跑的任务')
  } catch { /* 主进程会推状态 */ } finally {
    stopping.value = false
  }
}

onBeforeUnmount(clearTimer)
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="ingest-badge" :class="{ err: failed }">
      <!-- 进行中: 标题 + 进度条 + 当前对象 -->
      <template v-if="!linger">
        <div class="row">
          <span class="dot" />
          <b>{{ title }}</b>
          <span v-if="s.folderTotal" class="fld">{{ s.folderIndex }}/{{ s.folderTotal }}</span>
          <span v-else-if="s.total" class="fld">{{ nfmt(s.done) }}/{{ nfmt(s.total) }}</span>
          <button
            v-if="running"
            class="x stop"
            :disabled="stopping"
            :title="`停止本次${isTag ? '反推' : '同步'}(已处理的会保留, 剩下的留在队列里下次接着跑)`"
            @click="stopNow"
          >⏹</button>
          <button class="x" title="收起(任务会继续)" @click="close">✕</button>
        </div>
        <div class="bar"><i :style="{ width: pct + '%' }" /></div>
        <div class="note">
          {{ s.folder || '' }}<template v-if="!isTag && !s.folder && s.total"> · {{ nfmt(s.done) }}/{{ nfmt(s.total) }}</template>
        </div>
      </template>

      <!-- 完成/失败: 摘要 -->
      <template v-else>
        <div class="row">
          <b v-if="failed" class="bad">{{ isTag ? '❌ 反推失败' : '❌ 同步失败' }}</b>
          <b v-else-if="degraded" class="warn">⚠️ 反推已跳过</b>
          <b v-else class="good">{{ isTag ? '✅ 反推完成' : '✅ 同步完成' }}</b>
          <button class="x" @click="close">✕</button>
        </div>

        <!-- 降级: 不是错误, 只是这台机器上没条件反推 -->
        <template v-if="degraded">
          <div class="note wrap">{{ s.note }}</div>
          <!-- 2026-10-02: 降级不该是死胡同 —— 给一条能走通的路(弹「怎么装」引导) -->
          <div class="note dim"><a href="#" @click.prevent="openTaggerSetup">没有反推环境? 看看怎么装 →</a></div>
        </template>

        <div v-else-if="failed" class="note wrap">{{ s.note }}</div>

        <template v-else-if="st && isTag">
          <div class="note">
            反推成功 <b>{{ st.tagged }}</b>
            <template v-if="st.updated"> · 覆盖旧反推 <b>{{ st.updated }}</b></template>
            <template v-if="st.noResult"> · 无结果 <b>{{ st.noResult }}</b></template>
            <template v-if="st.failed"> · 失败 <b>{{ st.failed }}</b></template>
          </div>
          <div class="note dim">
            <template v-if="st.provider">provider {{ st.provider === 'CUDAExecutionProvider' ? 'CUDA' : 'CPU' }} · </template>
            模型加载 {{ (st.loadMs / 1000).toFixed(1) }}s · 耗时 {{ (st.ms / 1000).toFixed(1) }}s
          </div>
        </template>

        <template v-else-if="st">
          <div class="note">
            新增 <b>{{ st.inserted }}</b> · 更新 <b>{{ st.metaUpdated }}</b>
            · 待反推 <b>{{ st.queued }}</b> · 消失 <b>{{ st.goneSet }}</b>
          </div>
          <div class="note dim">
            跳过 {{ nfmt(st.skipped) }} 张(只读了 {{ st.readImages }} 张) · {{ (st.ms / 1000).toFixed(1) }}s
          </div>
        </template>

        <div class="note dim">
          <a href="#" @click.prevent="runNow">{{ isTag ? '再反推一次' : '再同步一次' }}</a>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ingest-badge {
  position: fixed; right: 22px; bottom: 96px; z-index: 230;
  width: 268px;
  padding: 10px 12px 9px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  font-size: 12px;
  color: var(--text);
  animation: ib-in .18s ease-out;
}
.ingest-badge.err { border-color: var(--danger); }
@keyframes ib-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.row { display: flex; align-items: center; gap: 6px; }
.row b { font-weight: 600; }
.row b.good { color: var(--accent2); }
.row b.bad { color: var(--danger); }
.row b.warn { color: var(--warn, var(--accent)); }
.fld { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.x {
  margin-left: auto; background: none; border: 0; cursor: pointer;
  color: var(--faint); font-size: 12px; padding: 0 2px; line-height: 1;
}
.fld + .x { margin-left: 6px; }
.x:hover { color: var(--text); }
/* 停止按钮: 与「收起」并排, 用 danger 色区分(收起只是隐藏, 停止是真中断) */
.x.stop { margin-left: 6px; color: var(--danger); font-size: 11px; }
.x.stop:hover { color: var(--danger); filter: brightness(1.2); }
.x.stop:disabled { opacity: .5; cursor: default; }

.bar {
  margin: 7px 0 5px; height: 4px; border-radius: 2px;
  background: var(--panel3); overflow: hidden;
}
.bar i {
  display: block; height: 100%; width: 0;
  background: var(--accent); transition: width var(--t-mid);
}

.note {
  color: var(--muted); font-size: 11px; line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 降级/失败的原因是给人看的一句话, 截断了就没用了 —— 这两处允许折两行 */
.note.wrap { white-space: normal; }
.note.dim { color: var(--faint); }
.note b { color: var(--text); font-variant-numeric: tabular-nums; }
.note a { color: var(--accent); text-decoration: none; }
.note a:hover { text-decoration: underline; }

.dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
  animation: ib-pulse 1.2s ease-in-out infinite; flex: none;
}
@keyframes ib-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
</style>
