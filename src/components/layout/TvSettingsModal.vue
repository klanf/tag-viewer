<script setup>
/**
 * 「设置」弹窗(2026-10-15)
 * ========================
 * 三件事:
 *   1. 反推后端可视化: 当前实际用的推理后端(CUDA > DirectML > CPU 链上命中的那个)
 *      + onnxruntime 探测结果 + 想要 CUDA 加速的提示与装法
 *   2. 检查更新入口(复用菜单 Help → 检查更新… 的主进程弹窗流程)
 *   3. 可自定义项: 推理后端覆盖 / 置信度阈值(总 + 角色) —— 落 settings.json,
 *      下一次反推生效(服务每次反推重新拉起, 读当次 env)
 * 偏好回读复用 app:settings:set 空补丁(白名单无命中 = 等价无操作落盘, 顺带返回 settings)。
 */
import { ref, reactive, watch } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvSelect from '@/components/base/TvSelect.vue'
import { useAppSettings } from '@/composables/useAppSettings.js'
import { useAppStore } from '@/stores/useAppStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { api } from '@/utils/api.js'

const { open } = useAppSettings()
const app = useAppStore()
const ui = useUiStore()

const version = ref('')
const packed = ref(true)
const accel = ref(null)          // tagger:accel 结果 { ok, version, providers, error, usedProvider }
const probing = ref(false)
const checking = ref(false)
const saving = ref(false)

const prefs = reactive({
  provider: 'auto',
  threshold: 0.35,
  charThreshold: 0.85,
})

const PROVIDER_OPTIONS = [
  { value: 'auto', label: '自动（CUDA > DirectML > CPU）' },
  { value: 'cuda', label: '强制 CUDA（N 卡，需 onnxruntime-gpu）' },
  { value: 'dml', label: '强制 DirectML（N/A/I 卡 + 核显）' },
  { value: 'cpu', label: '强制 CPU（最慢但零依赖）' },
]

const PROVIDER_LABEL = {
  CUDAExecutionProvider: 'CUDA',
  DmlExecutionProvider: 'DirectML',
  CPUExecutionProvider: 'CPU',
  TensorrtExecutionProvider: 'TensorRT',
}

/** 每次打开都重拉: 版本 / 加速探测 / 当前偏好 / 反推状态 */
async function loadAll() {
  probing.value = true
  try {
    const [v, a] = await Promise.all([
      api.appVersion().catch(() => null),
      api.taggerAccel().catch((e) => ({ ok: false, error: e.message })),
      // Python 字段读 app.tagger.config.python —— 不刷新的话显示的是启动时的旧值,
      // 首启下载完环境的机器会一直显示"未配置"(2026-10-15 用户截图实测)
      app.taggerRefresh().catch(() => null),
    ])
    if (v) { version.value = v.version; packed.value = v.packaged }
    accel.value = a
    const r = await api.settingsSet({}).catch(() => null)
    if (r?.settings) {
      prefs.provider = r.settings.taggerProvider || 'auto'
      prefs.threshold = r.settings.taggerThreshold ?? 0.35
      prefs.charThreshold = r.settings.taggerCharThreshold ?? 0.85
    }
  } finally {
    probing.value = false
  }
}

watch(open, (v) => { if (v) loadAll() })

async function save() {
  saving.value = true
  try {
    await api.settingsSet({
      taggerProvider: prefs.provider,
      taggerThreshold: Number(prefs.threshold),
      taggerCharThreshold: Number(prefs.charThreshold),
    })
    ui.ok('已保存 —— 下一次反推生效', 'info', 2600)
  } catch (e) {
    ui.err(e.message || String(e))
  } finally {
    saving.value = false
  }
}

async function checkUpdate() {
  checking.value = true
  try { await api.checkUpdate() } catch (e) { ui.err(e.message || String(e)) }
  finally { checking.value = false }
}

async function copyCudaCmd() {
  try {
    await navigator.clipboard.writeText('pip install onnxruntime-gpu')
    ui.ok('命令已复制', 'info', 1600)
  } catch { ui.err('复制失败，请手动输入') }
}

const usedProvider = () => {
  const p = accel.value?.usedProvider
  return p ? (PROVIDER_LABEL[p] || p) : ''
}
const hasCuda = () => !!accel.value?.providers?.includes('CUDAExecutionProvider')
</script>

<template>
  <TvModal v-model="open" title="⚙️ 设置" size="md">
    <div class="settings">
      <!-- ── 反推环境 ── -->
      <section>
        <h3>反推环境</h3>
        <div class="row">
          <span class="k">当前实际后端</span>
          <span class="v">
            <span v-if="usedProvider()" class="chip on">{{ usedProvider() }}</span>
            <span v-else class="chip">尚未运行过反推</span>
            <span class="dim">优先级 CUDA &gt; DirectML &gt; CPU，自动命中第一个可用</span>
          </span>
        </div>
        <div class="row">
          <span class="k">onnxruntime</span>
          <span v-if="probing" class="v">探测中…</span>
          <span v-else-if="accel?.ok" class="v">
            v{{ accel.version }} · 可用后端:
            <span class="mono">{{ (accel.providers || []).map((p) => PROVIDER_LABEL[p] || p).join(' / ') || '无' }}</span>
          </span>
          <span v-else class="v">
            <span class="warn">探测失败: {{ accel?.error || '还没有可用的 Python 解释器' }}</span>
            <span class="dim">（可先在扫描页完成反推环境引导）</span>
          </span>
        </div>
        <p v-if="accel?.ok && !hasCuda()" class="tip">
          💡 <b>想要 CUDA 加速？</b>当前环境没有 CUDA 后端。命令行执行
          <span class="mono">pip install onnxruntime-gpu</span>
          <button class="linkbtn" type="button" @click="copyCudaCmd">复制命令</button>
          —— 需要 NVIDIA 显卡 + CUDA 12 运行库；装好后的<b>首次反推</b>会有几分钟内核编译，之后比
          DirectML 更快。不装也完全能用，DirectML 对多数场景已经够快。
        </p>
        <p v-else-if="accel?.ok && hasCuda()" class="tip ok">✓ 检测到 CUDA 后端 —— 推理已优先走 NVIDIA 显卡。</p>

        <div class="row">
          <span class="k">后端覆盖</span>
          <span class="v grow"><TvSelect v-model="prefs.provider" :options="PROVIDER_OPTIONS" /></span>
        </div>
        <div class="row">
          <span class="k">置信度阈值</span>
          <span class="v inline">
            总 <input v-model.number="prefs.threshold" class="num" type="number" min="0.01" max="0.95" step="0.05" />
            角色 <input v-model.number="prefs.charThreshold" class="num" type="number" min="0.05" max="0.99" step="0.05" />
            <span class="dim">越低标签越多越杂，越高越保守；0.35 / 0.85 为默认</span>
          </span>
        </div>
        <div class="row">
          <span class="k">Python</span>
          <span class="v">
            <span class="mono">{{ app.tagger?.config?.python || '未配置' }}</span>
            <span v-if="app.tagger?.config?.python && !app.tagger?.config?.pythonOwned" class="dim">（候选自动探测）</span>
            <span v-else-if="app.tagger?.config?.python" class="dim">（嵌入式运行时）</span>
          </span>
        </div>
      </section>

      <!-- ── 通用 ── -->
      <section>
        <h3>通用</h3>
        <div class="row">
          <span class="k">当前版本</span>
          <span class="v inline">
            v{{ version || '?' }} <span v-if="!packed" class="dim">（开发模式）</span>
            <TvButton size="sm" variant="secondary" :disabled="checking" @click="checkUpdate">
              {{ checking ? '检查中…' : '检查更新' }}
            </TvButton>
          </span>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="foot">
        <span class="dim">反推设置在下一次反推时生效</span>
        <TvButton variant="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</TvButton>
      </div>
    </template>
  </TvModal>
</template>

<style scoped>
.settings { font-size: 13px; line-height: 1.7; }
section { margin-bottom: 14px; }
section:last-child { margin-bottom: 0; }
h3 {
  margin: 0 0 8px; font-size: 12px; font-weight: 700;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
}
.row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 7px; }
.k { flex: 0 0 88px; color: var(--muted); font-size: 12px; padding-top: 3px; }
.v { flex: 1 1 auto; min-width: 0; }
.v.grow { display: flex; }
.v.inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  background: var(--panel3); color: var(--muted); font-size: 12px; font-weight: 600;
  margin-right: 8px;
}
.chip.on { background: var(--accent-soft); color: var(--accent); }
.mono {
  font-family: var(--mono, Consolas, monospace); font-size: 12px;
  background: var(--panel3); border-radius: 4px; padding: 1px 5px; word-break: break-all;
}
.tip {
  margin: 4px 0 10px; padding: 8px 12px;
  background: var(--panel3); border-radius: var(--r-md, 8px); font-size: 12px;
}
.tip.ok { color: var(--accent); }
.num {
  width: 64px; padding: 3px 6px; font-size: 12px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.linkbtn {
  border: none; background: none; color: var(--accent);
  cursor: pointer; font-size: 12px; padding: 0 4px; text-decoration: underline;
}
.dim { color: var(--faint); font-size: 11px; margin-left: 6px; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.warn { color: var(--danger, #c0392b); }
</style>
