<script setup>
/**
 * 数据集加载遮罩 —— 一次性十几秒的等待, 必须让用户看见进度
 * ======================================================
 * 旧版浏览器里是纯白等(没有任何进度), 用户只能猜是不是卡死了。
 * 这里把主进程推上来的 parse/stats 进度画成进度条, 并在失败时把错误与
 * 数据目录直接摆出来(这是最常见的"起不来"原因: 配置里的路径不存在)。
 */
import { computed } from 'vue'
import TvButton from '../base/TvButton.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { nfmt, ms } from '@/utils/format.js'
import { api } from '@/utils/api.js'

const app = useAppStore()

const phaseText = computed(() => ({
  parse: '正在解析标签文件',
  stats: '正在统计标签与系列',
  translate: '正在载入翻译库',
  done: '完成',
}[app.progress.phase] || '正在准备'))

const pct = computed(() => Math.max(0, Math.min(100, app.progress.percent || 0)))

/**
 * 「一个数据源都还没配」和「配了但读不到」是两种完全不同的处境, 给的引导也该不一样:
 *   前者是新装/换机器的正常起点  -> 告诉他去哪儿放配置文件
 *   后者是配置写错的排障问题    -> 告诉他去核对哪个字段
 * workspace.configExists 由主进程在 initWorkspace 时探明并随 app:status 下发。
 */
const noSourceYet = computed(() => app.workspace.configExists === false)

async function reveal() {
  try { await api.openPath(app.workspace.dataDir) } catch { /* 忽略 */ }
}
async function reload() {
  try { await app.reload() } catch { /* 错误已进 store */ }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="!app.ready" class="boot">
      <div class="box">
        <div class="logo">🎨</div>
        <div class="ttl">Tag 可视化看板</div>

        <template v-if="app.phase === 'error'">
          <div class="err">{{ noSourceYet ? '👋 还没有配置标签数据源' : '❌ 数据加载失败' }}</div>
          <pre class="msg">{{ app.error }}</pre>
          <div class="hint">
            数据目录: <code>{{ app.workspace.dataDir || '(未设置)' }}</code><br>
            <template v-if="noSourceYet">
              这个目录下还没有 <code>tag_viewer_config.json</code>。<br>
              建一个, 用 <code>data_files_dir</code> 指向存放 <code>tags_*.txt</code> 的目录,<br>
              然后点「重试」即可。
            </template>
            <template v-else>
              检查 <code>tag_viewer_config.json</code> 里的 <code>data_files_dir</code> 是否存在。
            </template>
          </div>
          <div class="btns">
            <TvButton variant="primary" @click="reload">重试</TvButton>
            <TvButton variant="secondary" @click="reveal">打开数据目录</TvButton>
          </div>
        </template>

        <template v-else>
          <div class="phase">{{ phaseText }}</div>
          <div class="bar"><div class="fill" :style="{ width: `${pct}%` }" /></div>
          <div class="nums">
            <span>{{ pct }}%</span>
            <span v-if="app.progress.records">已读 {{ nfmt(app.progress.records) }} 条</span>
            <span v-if="app.progress.source" class="faint">{{ app.progress.source }}</span>
          </div>
          <div class="hint">
            正在从本地标签库(tags.db)读入全部记录 —— 之后同一进程内搜索是毫秒级的。
          </div>
        </template>

        <div v-if="app.loadMs && app.ready" class="hint">上次加载耗时 {{ ms(app.loadMs) }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.boot {
  position: fixed; inset: 0; z-index: 600;
  background: var(--bg);
  display: flex; align-items: center; justify-content: center;
}
.box {
  width: 460px; max-width: 90vw;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  padding: 26px 26px 22px;
  text-align: center;
}
.logo { font-size: 34px; }
.ttl { font-size: 17px; font-weight: 600; margin: 6px 0 18px; }

.phase { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.bar {
  height: 8px; background: var(--panel2); border-radius: 4px; overflow: hidden;
}
.fill {
  height: 100%; border-radius: 4px;
  background: linear-gradient(90deg, var(--bar-from), var(--accent));
  transition: width .25s ease;
}
.nums {
  display: flex; gap: 12px; justify-content: center;
  font-size: 11px; color: var(--muted); margin-top: 8px;
}
.faint { color: var(--faint); }
.hint { color: var(--faint); font-size: 11px; line-height: 1.8; margin-top: 14px; }
.hint code { color: var(--accent); }

.err { color: var(--danger); font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.msg {
  text-align: left; white-space: pre-wrap; word-break: break-all;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 10px; font-size: 11px; color: var(--danger); max-height: 160px; overflow: auto;
}
.btns { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
</style>
