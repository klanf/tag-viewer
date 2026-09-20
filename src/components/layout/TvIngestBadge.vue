<script setup>
/**
 * 增量同步提示 —— 右下角小胶囊
 * =============================
 * 磁盘与 tags.db 对齐(见 electron/core/ingest.js)在 app 就绪后**自动**跑一次,
 * 首轮要枚举几万个文件、读几百张图的元数据。这个过程必须让用户看得见:
 * 否则"启动后磁盘转了十几秒、界面上什么也没发生"会被当成卡死 —— 与当初
 * 「双击没反应」是同一类体验问题。
 *
 * 为什么不做成弹窗/遮罩: 同步不阻塞使用, 用户完全可以边看边等。
 * 所以只占右下角一根胶囊, 跑完显示几秒摘要就自己消失。
 *
 * 位置刻意放在浮动导航(bottom 26 / z-index 220)之上, 两者不重叠。
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { nfmt } from '@/utils/format.js'

const app = useAppStore()

/** 完成/失败后的摘要保留时长: 太短看不清数字, 太长挡视线 */
const LINGER_MS = 6000

const show = ref(false)
const linger = ref(false)          // 当前展示的是"完成后的摘要"而不是进行中的进度
const dismissed = ref(false)
let timer = null

const s = computed(() => app.ingest || {})
const running = computed(() => ['running', 'enum', 'compare', 'read', 'folder-done', 'rebuild-tags'].includes(s.value.phase))
const failed = computed(() => s.value.phase === 'error')

const PHASE_TEXT = {
  running: '正在比对',
  enum: '正在枚举',
  compare: '正在比对',
  read: '正在读取元数据',
  'folder-done': '同步中',
  'rebuild-tags': '正在重建标签字典',
}

const title = computed(() => PHASE_TEXT[s.value.phase] || '同步')

/** 当前阶段的百分比。枚举/比对阶段没有 total 时退化成"第 n / m 个目录" */
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
  () => [s.value.phase, s.value.running],
  ([phase, isRunning]) => {
    clearTimer()
    if (isRunning) {
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
  try { await app.ingestRun() } catch { /* 失败时主进程会推 error 状态 */ }
}

onBeforeUnmount(clearTimer)
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="ingest-badge" :class="{ err: failed }">
      <!-- 进行中: 标题 + 进度条 + 当前目录 -->
      <template v-if="!linger">
        <div class="row">
          <span class="dot" />
          <b>{{ title }}</b>
          <span v-if="s.folderTotal" class="fld">{{ s.folderIndex }}/{{ s.folderTotal }}</span>
          <button class="x" title="收起(同步会继续)" @click="close">✕</button>
        </div>
        <div class="bar"><i :style="{ width: pct + '%' }" /></div>
        <div class="note">
          {{ s.folder || '' }}<template v-if="s.total"> · {{ nfmt(s.done) }}/{{ nfmt(s.total) }}</template>
        </div>
      </template>

      <!-- 完成/失败: 摘要 -->
      <template v-else>
        <div class="row">
          <b :class="failed ? 'bad' : 'good'">{{ failed ? '❌ 同步失败' : '✅ 同步完成' }}</b>
          <button class="x" @click="close">✕</button>
        </div>
        <div v-if="failed" class="note">{{ s.note }}</div>
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
          <a href="#" @click.prevent="runNow">再同步一次</a>
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
.fld { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.x {
  margin-left: auto; background: none; border: 0; cursor: pointer;
  color: var(--faint); font-size: 12px; padding: 0 2px; line-height: 1;
}
.fld + .x { margin-left: 6px; }
.x:hover { color: var(--text); }

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
