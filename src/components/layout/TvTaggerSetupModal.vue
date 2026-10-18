<script setup>
/**
 * 「WD14 反推没有就绪」引导弹窗
 * =============================
 * 2026-10-02 之前, 反推环境不全只有右下角胶囊里一句"反推已跳过(原因)" ——
 * 没装过的人不知道那三个词是什么、要去哪下载、放哪个目录。降级不该是死胡同。
 *
 * 内容刻意**自包含**(不要求用户先去翻文档): 现状(缺什么) + 三步装法 + 放哪 + 怎么验证。
 * 下载地址与 docs/新手上手.md 同源 —— 改一处记得改另一处。
 *
 * 判定字段来自 tagger:status 的 config(静态可用性, 不拉起进程):
 *   config.missing = ['WD14 模型', '标签表', ...], config.available = missing 为空
 */
import { computed, ref, watch } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { useTaggerSetup } from '@/composables/useTaggerSetup.js'
import { api } from '@/utils/api.js'

const app = useAppStore()
const { open } = useTaggerSetup()

const cfg = computed(() => app.tagger?.config || null)
const missingText = computed(() => {
  const m = cfg.value?.missing || []
  return m.length ? m.join('、') : 'Python 环境 / WD14 模型 / 标签表'
})
/** 重新探测: 拉一次最新状态, 让"刚补完环境"的用户立刻看到变化 */
const rechecked = ref(false)
async function reprobe() {
  await app.taggerRefresh()
  rechecked.value = true
}
/** 一键下载: 主进程自动补齐 Python 运行时 + 模型(约 1.3GB), 进度直接画在弹窗里 */
const downloading = ref(false)
const setupP = computed(() => app.setup || {})
function mb(v) { const n = Number(v) || 0; return `${(n / 1048576).toFixed(1)} MB` }
async function oneClickDownload() {
  downloading.value = true
  try { await api.setupDownload() } catch { /* 失败走 error 推送 */ } finally { downloading.value = false }
}
/* 下载不再"跑起来就关弹窗让位小卡"(2026-10-15): 进度内嵌在本弹窗, 弹窗本身锁背景。
 * done → 重新探测并自动关; error → 弹窗里给「重试下载」。
 * 2026-10-18 按需安装 v3: 装完**自动反推补标**(用户拍板) —— 用户点横幅/提示条
 * 装好环境的那一刻, 队列里攒着的图(含本会话扫进来的无标签图)立刻开跑;
 * tagger:run 自带防重入, 重复调用无害。 */
watch(() => setupP.value.done, (d) => {
  if (!d) return
  reprobe()
  open.value = false
  api.taggerRun().catch(() => { /* 失败走 tagger-err 日志与胶囊状态 */ })
})
</script>

<template>
  <TvModal v-model="open" title="🪄 WD14 反推没有就绪" size="md">
    <div class="tagger-setup">
      <p class="lead">
        自动打标(WD14 反推)在这台机器上还跑不起来<template v-if="cfg && !cfg.available">：
        <b>缺 {{ missingText }}</b></template>。
        <b v-if="rechecked">仍缺: {{ missingText }} —— 放好文件后需要重启应用才生效。</b>
        不装也完全不影响其他功能, 只是扫描页不能给没有标签的图自动打标。
      </p>

      <ol class="steps">
        <li>
          <b>装 Python 3</b> —— 从
          <span class="mono">python.org</span> 下载安装(勾选「加入 PATH」),
          或者装 miniconda / anaconda 也行, 应用会自动在这几处找到它。
        </li>
        <li>
          <b>装推理库</b> —— 命令行执行
          <span class="mono">pip install onnxruntime</span>
          (CPU 版就能跑, 只是慢些; 有 N 卡可以换 <span class="mono">onnxruntime-gpu</span>)。
        </li>
        <li>
          <b>放模型文件</b>(约 1.27GB) —— 从 HuggingFace 仓库
          <span class="mono">deepghs/pixai-tagger-v0.9-onnx</span> 下载
          <span class="mono">model.onnx</span> 和
          <span class="mono">selected_tags.csv</span> 两个文件
          (直连打不开就把域名换成 <span class="mono">hf-mirror.com</span>),
          放进 <span class="mono">models</span> 文件夹 —— 项目目录下或数据目录下都可以,
          <b>不用改名</b>:
        </li>
      </ol>
      <pre class="tree">models/
├─ model.onnx         (或 wd-pixai-tagger-v0.9.onnx)
└─ selected_tags.csv  (或 wd-pixai-tagger-v0.9.csv)</pre>
      <p class="dim">
        数据目录可从顶栏菜单「打开数据目录」直达。放好后重启应用, 或点下面的「重新探测」。
      </p>
    </div>

    <!-- 下载进度内嵌(2026-10-15): 不再依赖右下角小卡 -->
    <div v-if="setupP.file || setupP.stage" class="dl">
      <div class="dl-stage">{{ setupP.stage || `正在下载: ${setupP.file}` }}</div>
      <template v-if="setupP.bytes">
        <div class="dl-bar"><div class="dl-fill" :style="{ width: `${setupP.pct || 0}%` }" /></div>
        <div class="dl-nums">{{ setupP.pct || 0 }}% · {{ mb(setupP.bytes) }} / {{ mb(setupP.total) }}</div>
      </template>
      <div v-if="setupP.error" class="dl-err">下载失败: {{ setupP.error }}</div>
    </div>

    <template #footer>
      <div class="foot">
        <span class="dim">彻底关掉自动反推: 环境变量 <span class="mono">TV_TAGGER=0</span></span>
        <TvButton v-if="setupP.error" variant="primary" @click="oneClickDownload">重试下载</TvButton>
        <template v-else>
          <TvButton :disabled="downloading" @click="reprobe">重新探测</TvButton>
          <TvButton variant="primary" :disabled="downloading" @click="oneClickDownload">
            {{ downloading ? '启动中…' : '⬇️ 一键下载（约 1.3GB）' }}
          </TvButton>
        </template>
      </div>
    </template>
  </TvModal>
</template>

<style scoped>
.tagger-setup { font-size: 13px; line-height: 1.7; }
.lead { margin: 0 0 10px; }
.lead b { color: var(--accent); }
.steps { margin: 0 0 10px; padding-left: 20px; }
.steps li { margin-bottom: 6px; }
.steps b { font-weight: 600; }
.mono {
  font-family: var(--mono, Consolas, monospace);
  font-size: 12px;
  background: var(--panel3);
  border-radius: 4px;
  padding: 1px 5px;
  word-break: break-all;
}
.tree {
  margin: 0 0 10px;
  padding: 8px 12px;
  background: var(--panel3);
  border-radius: var(--r-md, 8px);
  font-family: var(--mono, Consolas, monospace);
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}
.dim { color: var(--faint); font-size: 12px; }
.dl { margin-top: 12px; padding: 10px 12px; background: var(--panel3); border-radius: var(--r-md, 8px); }
.dl-stage { font-size: 12px; margin-bottom: 6px; }
.dl-bar { height: 6px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
.dl-fill { height: 100%; background: var(--accent); transition: width .25s ease; }
.dl-nums { font-size: 11px; color: var(--muted); margin-top: 5px; }
.dl-err { color: var(--danger); font-size: 12px; margin-top: 6px; word-break: break-all; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
</style>
