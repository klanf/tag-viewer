<script setup>
/**
 * 数据集加载遮罩 —— 一次性十几秒的等待, 必须让用户看见进度
 * ======================================================
 * 旧版浏览器里是纯白等(没有任何进度), 用户只能猜是不是卡死了。
 * 这里把主进程推上来的 parse/stats 进度画成进度条, 并在失败时把错误与
 * 数据目录直接摆出来(这是最常见的"起不来"原因: 配置里的路径不存在)。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TvButton from '../base/TvButton.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { nfmt, ms } from '@/utils/format.js'
import { api } from '@/utils/api.js'

const app = useAppStore()

/* 2026-11-08: 阶段文案补全 —— 遮罩靠 progress.phase 取词, 以前只认 4 个阶段,
 * 剩下的(同步/读库/系列索引)一律显示「正在准备」, 用户报障时说的现象就和日志
 * 对不上号(「卡在正在解析标签文件」其实是还没开始读库)。缺的词补齐。 */
const phaseText = computed(() => ({
  config: '正在读取配置与数据源',
  'db-sync': '正在核对标签来源',
  'db': '正在导入标签文件',
  'db-read': '正在从标签库读取记录',
  parse: '正在解析标签文件',
  stats: '正在统计标签与系列',
  series: '正在建立系列索引',
  translate: '正在载入翻译库',
  done: '完成',
}[app.progress.phase] || '正在准备'))

const pct = computed(() => Math.max(0, Math.min(100, app.progress.percent || 0)))

/* ---- 版本号 + 检查更新(2026-11-08) ----
 * 启动失败时顶栏被这层遮罩整个盖住, 用户既进不了设置弹窗、也点不到任何按钮,
 * 唯一的出路就是**升级到修复版**。所以遮罩右下角常驻一个检查更新入口。
 * 流程复用主进程的「检查更新…」(检查 → 确认下载 → 确认安装, 全是原生弹窗),
 * 渲染层只负责触发, 不重复实现下载/校验那一套。
 * 注意: 如果主进程的事件循环真被卡死了, 这个按钮也会没反应 —— 它救的是
 * 「加载失败但进程还活着」这一类, 那才是用户最常见的处境。 */
const ver = ref('')
const updBusy = ref(false)
const updErr = ref('')

async function checkUpd() {
  if (updBusy.value) return
  updBusy.value = true
  updErr.value = ''
  try { await api.checkUpdate() } catch (e) { updErr.value = e?.message || String(e) } finally { updBusy.value = false }
}

onMounted(() => {
  api.appVersion().then((r) => { ver.value = r?.version || '' }).catch(() => { /* 拿不到就不显示 */ })
})

/* ---- 「卡在 0% 却不给任何动静」(2026-11-08 用户反馈) ----
 * 进度条只认主进程推来的 app:progress。一旦主进程卡在某个同步段(库被另一实例
 * 占着 / 数据目录在掉线的磁盘或网盘 / 反推子进程还攥着 db), 界面就永久停在
 * 第一帧(parse 0%), 既没有进度也没有按钮 —— 用户只能强杀, 还以为是"更新坏了"。
 * 这里自己数"多久没动静", 超过阈值就把「可能卡住」和自救按钮摆出来。 */
const stuckSec = ref(0)
let lastSig = ''
const stuckTimer = setInterval(() => {
  if (app.ready) return
  const sig = [app.phase, app.progress.phase, app.progress.records, app.progress.percent, app.progress.source].join('|')
  if (sig !== lastSig) { lastSig = sig; stuckSec.value = 0; return }
  if (app.phase === 'loading') stuckSec.value++
}, 1000)
onBeforeUnmount(() => clearInterval(stuckTimer))
const stuck = computed(() => app.phase === 'loading' && stuckSec.value >= 45)

/**
 * 「一个数据源都还没配」和「配了但读不到」是两种完全不同的处境, 给的引导也该不一样:
 *   前者是新装/绿色包的正常起点  -> 不用碰任何文件, 直接选个文件夹登记, 马上开始
 *   后者是配置写错的排障问题    -> 告诉他去核对哪个字段
 * workspace.configExists 由主进程在 initWorkspace 时探明并随 app:status 下发。
 */
const noSourceYet = computed(() => app.workspace.configExists === false)

/** 首次登记: 就地选文件夹 -> 登记成看板来源(自动接同步与反推) -> 等第一批记录落库 -> 重新载入数据集 */
const picking = ref(false)
const pickErr = ref('')
/**
 * 登记后**入库是异步的** —— 登记完立刻 reload, images 表还是空的,
 * bootstrap 会误报"没有可用的标签数据"(2026-10-02 用户在绿色包实测踩中)。
 * 所以登记后主动拉一次同步, 然后轮询等第一批记录落库, 再进看板。
 */
const scanning = ref(false)
const scanNote = ref('')

async function startWithFolder() {
  if (picking.value) return
  picking.value = true
  pickErr.value = ''
  try {
    const picked = await api.pickFolder({ title: '选择一个装满图片的文件夹' })
    if (picked?.canceled) return
    const list = picked.paths || (picked.path ? [picked.path] : [])
    if (!list.length) return
    for (const p of list) {
      const r = await api.addFolder({ path: p, as_source: true, as_scan: false, recursive: true })
      if (r?.error) { pickErr.value = `${p}: ${r.error}`; return }
    }
    // 已在跑就静默跳过(登记跃迁本身会自动接同步; 这里兜底)
    api.ingestRun().catch(() => {})
    // 2026-10-18 WD14 按需安装(v3): 向导**不再强制装反推环境** —— 扫描照跑,
    // 自带提示词的图直接入库, 一批记录落库就放行进看板; 没有自带提示词的图
    // 等装了反推再打标(看板横幅会提示, 队列留着不会丢)。
    scanning.value = true
    try {
      const ok = await waitFirstRecords(10 * 60 * 1000)
      if (!ok) {
        // 2026-10-03: 别再把"入队等反推"误报成"没扫到图" —— 拉一次队列状态区分
        try {
          const st = await api.ingestStatus()
          const q = st?.queue || {}
          const total = Number(q.total) || 0
          if (total > 0) {
            pickErr.value = `已扫到 ${total} 张图并在后台处理中（已完成 ${Number(q.done) || 0} 张）—— 处理继续在后台跑，完成后重新打开即可`
          } else {
            pickErr.value = '扫描完成但没找到支持的图片 —— 确认这个文件夹里真的有图片，然后点「重试」'
          }
        } catch { pickErr.value = '扫描未产生入库记录 —— 确认文件夹里有图片后重新选择，或重启应用' }
        return
      }
      await reload()
    } finally {
      scanning.value = false
    }
  } catch (e) {
    pickErr.value = String(e?.message || e)
  } finally {
    picking.value = false
    scanning.value = false
  }
}

/* ---- 反推环境面板已移除(2026-10-18 WD14 按需安装 v3) ----
 * 首启不再强制下载 Python+模型(约 1.4GB): 向导只管登记+扫描+进看板,
 * 反推环境的安装走看板横幅/扫描页提示条 -> TvTaggerSetupModal(一键下载,
 * 进度画在弹窗里, 装完自动反推)。这里不掺和环境的事。 */

/** 轮询 ingest:status, 等到 stats.inserted > 0(第一批图真正落库)或超时。
 *  完成判定: lastRunAt 晚于我们的起点 && 已不在跑 —— 说明这一轮扫完了。
 *  2026-10-15: 放行条件 done≥10 改成 done≥1(用户拍板"环境好了立即放行") ——
 *  反推出第一张就进看板, 剩下的在后台继续跑完。 */
function waitFirstRecords(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const SYNC_RUNNING = new Set(['running', 'enum', 'compare', 'read', 'dims', 'folder-done', 'rebuild-tags'])
  let startedAt = 0
  let taggerKicked = false
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const st = await api.ingestStatus()
        const ins = Number(st?.stats?.inserted) || 0
        const q = st?.queue || {}
        const done = Number(q.done) || 0
        const total = Number(q.total) || 0
        const running = !!(st?.running || SYNC_RUNNING.has(st?.phase))
        /* 新装机引导流程要自己拉反推(2026-10-03): 全局的 onIngestDone 已不再自动
         * scheduleTagging(移动一张图不该为 1 张裸图加载模型), 但"登记文件夹首扫"
         * 的下一步就是反推 —— 队列建出来了、反推没在跑, 就拉一次(tagger:run 自带
         * 防重入), 否则裸图场景永远等不到 done≥10, 10 分钟后误报超时。 */
        if (!taggerKicked && total > 0) {
          taggerKicked = true
          api.taggerRun().catch(() => {})
        }
        if (ins > 0) {
          scanNote.value = `正在扫描入库… 已入库 ${ins} 张`
          resolve(true)
          return
        }
        if (done >= 1) {
          scanNote.value = `正在反推打标… 已入库 ${done} / ${total} 张`
          resolve(true)
          return
        }
        if (total > 0) scanNote.value = `已扫到 ${total} 张图，正在反推打标… 已入库 ${done} 张`
        else if (!running && Number(st?.lastRunAt || 0) > startedAt) { resolve(false); return }
        else scanNote.value = '正在扫描入库…'
      } catch { /* 主进程忙, 下一拍再看 */ }
      if (Date.now() > deadline) { resolve(false); return }
      setTimeout(tick, 500)
    }
    api.ingestStatus()
      .then((s0) => { startedAt = Number(s0?.lastRunAt) || 0 })
      .catch(() => {})
      .finally(tick)
  })
}

async function reveal() {
  try { await api.openPath(app.workspace.dataDir) } catch { /* 忽略 */ }
}
async function reload() {
  try { await app.reload() } catch { /* 错误已进 store */ }
}

/* ---- 反推暂态放行(2026-10-03) ----
 * 库里 folders 有行、队列压着裸图、images 还是 0 → 数据集加载 phase=error,
 * 错误文案是 dataset.js 的"…正在打标队列里等待反推入库"。这是**暂态**不是死局:
 * 反推在后台跑, 队列 done≥1 时重载数据集就能进看板, 反推继续在后台跑完。
 * 若反推一直没动(降级 = 环境没好), 直接进环境下载面板 —— 不再让用户干等 90 秒。 */
const taggingWait = computed(() => app.phase === 'error' && /打标队列|等待反推/.test(app.error || ''))
const tagQ = ref({ done: 0, total: 0, pending: 0, failed: 0 })
const tagWarn = ref('')
const tagPct = computed(() => {
  const { done, total } = tagQ.value
  return total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
})
let tagPollStarted = false

function startTagPoll() {
  if (tagPollStarted) return
  tagPollStarted = true
  let lastDone = -1
  let stallSince = Date.now()
  let envKicked = false
  let reloadFails = 0
  const tick = async () => {
    if (app.ready || !taggingWait.value) return          // 已放行 / 状态已变, 停
    try {
      const st = await api.ingestStatus()
      const q = st?.queue || {}
      tagQ.value = {
        done: Number(q.done) || 0, total: Number(q.total) || 0,
        pending: Number(q.pending) || 0, failed: Number(q.failed) || 0,
      }
      if (tagQ.value.done !== lastDone) {
        lastDone = tagQ.value.done
        stallSince = Date.now()
        tagWarn.value = ''
      } else if (tagQ.value.pending > 0 && Date.now() - stallSince > 90 * 1000) {
        const ts = await api.taggerStatus().catch(() => null)
        if (ts?.degraded) tagWarn.value = `反推未在运行: ${ts.reason || '未知原因'}（队列里的图不会丢；可在看板横幅或扫描页安装反推环境后接着跑）`
      }
      // 2026-10-18 WD14 按需安装(v3): 放行判定加 stats.inserted —— 未装反推时
      // 队列永远没有 done, 但扫描落库的行(含无标签图)已经够进看板了,
      // 不能让用户对着 0% 打标进度干等。
      const ins = Number(st?.stats?.inserted) || 0
      if (tagQ.value.done >= 1 || ins > 0) {
        await reload()
        if (app.ready) return                            // 放行成功, 遮罩随 app.ready 消失
        // 2026-10-17 (远端用户"1000/1000 读完都进不去"): 队列全 done 且没有
        // pending 了还进不去 = 不会再有新标签产出(dataset 那边已是终态错误),
        // 再一秒一刷只会把真实错误顶掉 —— 试 3 次就停, 让错误文案露出来。
        reloadFails++
        if (tagQ.value.pending === 0 && tagQ.value.total > 0 && reloadFails >= 3) return
      }
    } catch { /* 主进程忙, 下一拍再看 */ }
    setTimeout(tick, 1000)
  }
  tick()
}
watch(taggingWait, (v) => { if (v) startTagPoll() }, { immediate: true })
</script>

<template>
  <Teleport to="body">
    <div v-if="!app.ready" class="boot">
      <div class="box">
        <div class="logo">🎨</div>
        <div class="ttl">Tag 可视化看板</div>

        <template v-if="app.phase === 'error'">
          <!-- 反推暂态: 图已入队、正在后台打标 —— 给进度条, done≥1 自动放行进看板 -->
          <template v-if="taggingWait">
            <div class="err" style="color: var(--accent);">🖼️ 图片已全部扫到，正在反推打标</div>
            <div class="bar"><div class="fill" :style="{ width: `${tagPct}%` }" /></div>
            <div class="nums">
              <span>{{ tagPct }}%</span>
              <span>已入库 {{ nfmt(tagQ.done) }} / {{ nfmt(tagQ.total) }} 张</span>
              <span v-if="tagQ.failed" style="color: var(--danger);">失败 {{ nfmt(tagQ.failed) }}</span>
            </div>
            <div class="hint">
              反推在后台跑，反推出第一批标签即自动进入看板，之后反推继续在后台完成。<br>
              期间关掉窗口也没关系，下次启动会接着跑（队列不会丢）。
            </div>
            <div v-if="tagWarn" class="err2">{{ tagWarn }}</div>
            <div class="btns">
              <TvButton variant="secondary" @click="reveal">打开数据目录</TvButton>
              <TvButton variant="secondary" @click="reload">重试</TvButton>
            </div>
          </template>

          <template v-else-if="noSourceYet">
            <div class="err">👋 还没有登记图片文件夹</div>
            <pre class="msg">{{ app.error }}</pre>

            <!-- 首次使用: 不用碰任何配置文件, 选个文件夹登记就开跑 -->
            <div class="hint">
              点下面的按钮选一个装满图的文件夹，登记后自动扫描入库。<br>
              图片自带提示词(ComfyUI / A1111 等)会直接入库；没有提示词的图，之后在看板横幅里一键安装 WD14 反推即可自动打标。<br>
              中文标签已内置，开箱即用。数据目录: <code>{{ app.workspace.dataDir || '(未设置)' }}</code>
            </div>
            <div v-if="pickErr" class="err2">{{ pickErr }}</div>
            <div class="btns">
              <TvButton variant="primary" :loading="picking || scanning" @click="startWithFolder">
                📁 选择图片文件夹，马上开始
              </TvButton>
              <TvButton variant="secondary" title="配置/文件修好后, 不用重启应用直接重载" @click="reload">↻ 重试</TvButton>
            </div>
            <div v-if="scanning" class="hint">{{ scanNote }}（完成后自动进入看板）</div>
            <div class="btns">
              <TvButton variant="secondary" @click="reveal">打开数据目录</TvButton>
            </div>
          </template>

          <template v-else>
            <div class="err">❌ 数据加载失败</div>
            <pre class="msg">{{ app.error }}</pre>
            <div class="hint">
              数据目录: <code>{{ app.workspace.dataDir || '(未设置)' }}</code><br>
              检查 <code>tag_viewer_config.json</code> 里的 <code>data_files_dir</code> 是否存在。
            </div>
            <div class="btns">
              <TvButton variant="primary" @click="reveal">打开数据目录</TvButton>
              <TvButton variant="secondary" title="修好被占用的库/盘符后不用重启应用" @click="reload">↻ 重试</TvButton>
            </div>
          </template>
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
          <template v-if="stuck">
            <div class="warn">
              ⏳ 已经 {{ stuckSec }} 秒没有任何进展 —— 常见原因: 数据库被另一个实例/反推进程占着、
              数据目录在掉线的磁盘或网盘上、或者磁盘正在被别的程序吃满。<br>
              可以先「重试」一次; 反复不行就用「检查更新」装最新修复版, 再把 logs/launch.log 发我。
            </div>
            <div class="btns">
              <TvButton variant="secondary" @click="reveal">打开数据目录</TvButton>
              <TvButton variant="secondary" @click="reload">↻ 重试</TvButton>
              <TvButton variant="primary" :loading="updBusy" @click="checkUpd">检查更新</TvButton>
            </div>
          </template>
        </template>

        <div v-if="app.loadMs && app.ready" class="hint">上次加载耗时 {{ ms(app.loadMs) }}</div>
      </div>

      <!-- 右下角常驻的救命入口: 任何「进不去」的状态下都能自己升级 -->
      <div class="foot">
        <span v-if="ver" class="ver">v{{ ver }}</span>
        <button class="link" :disabled="updBusy" @click="checkUpd">
          {{ updBusy ? '正在检查更新…' : '检查更新' }}
        </button>
      </div>
      <div v-if="updErr" class="foot-err">{{ updErr }}</div>
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
.err2 { color: var(--danger); font-size: 11px; margin-top: 10px; word-break: break-all; }
.msg {
  text-align: left; white-space: pre-wrap; word-break: break-all;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 10px; font-size: 11px; color: var(--danger); max-height: 160px; overflow: auto;
}
.btns { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.warn {
  margin-top: 14px; padding: 9px 11px;
  background: var(--warn-soft, rgba(184, 117, 20, .12));
  border: 1px solid var(--warn, #b87514);
  border-left-width: 3px; border-radius: var(--r-sm);
  color: var(--warn, #b87514); font-size: 11px; line-height: 1.75; text-align: left;
}

/* 右下角的常驻救援入口(版本号 + 检查更新) */
.foot {
  position: fixed; right: 18px; bottom: 14px;
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; color: var(--faint);
}
.foot .ver { color: var(--faint); }
.foot .link {
  background: transparent; color: var(--muted);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 4px 10px; font-size: 11px; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.foot .link:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.foot .link:disabled { opacity: .6; cursor: default; }
.foot-err {
  position: fixed; right: 18px; bottom: 44px;
  max-width: 300px; text-align: right;
  color: var(--danger); font-size: 11px; word-break: break-all;
}
</style>
