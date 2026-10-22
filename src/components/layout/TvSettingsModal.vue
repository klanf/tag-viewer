<script setup>
/**
 * 「设置」抽屉(2026-10-15, 2026-10-23 改抽屉式)
 * ==============================================
 * 三块:
 *   1. 反推环境: 实际后端 / onnxruntime 探测 / 模型 / 阈值 / Python
 *   2. 在线封面(Danbooru 凭据)
 *   3. 通用: 标签分组 / 版本与更新
 *
 * 2026-10-23 用户反馈"显示有点混乱" —— 改成右侧抽屉, 说明性长文字统一收进
 * 标签旁的 ⓘ 气泡(悬停看、点一下钉住), 每一行只留"当前值 + 控件"。
 * 偏好回读复用 app:settings:set 空补丁(白名单无命中 = 等价无操作落盘, 顺带返回 settings)。
 */
import { ref, reactive, watch, computed } from 'vue'
import TvDrawer from '@/components/base/TvDrawer.vue'
import TvInfoTip from '@/components/base/TvInfoTip.vue'
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
  model: 'auto',
  provider: 'auto',
  threshold: 0.35,
  charThreshold: 0.85,
  groupedTags: true,
})

/* Danbooru 凭据(2026-10-22): 主进程只回摘要(hasKey/login), 所以这里**读不回原 Key**。
 * 因此这一节的保存/清除是独立按钮, 不跟底部「保存设置」混 —— 混在一起的话,
 * 「输入框是空的」到底是"没改"还是"要删掉"就说不清了。 */
const auth = reactive({ login: '', apiKey: '' })
const authState = ref({ login: '', hasKey: false })
const authBusy = ref(false)
const authMsg = ref('')
const authMsgTone = ref('dim')
/* 读凭据这件事本身失败(而不是"没配过")要能区分开: 主进程还是旧版时 preload 的白名单里
 * 没有 booru:auth:*, invoke 直接抛「未授权的 channel」—— 那时界面若照样显示"匿名访问",
 * 用户就会以为是自己没填对, 实际是这个应用实例根本没这段代码(2026-10-22 排查用户"保存了还是匿名")。 */
const authReadErr = ref('')

/** 能不能保存: 两个都填了, 或者只改用户名但 Key 早就存过(留空=沿用) */
const authReady = computed(() => {
  const l = auth.login.trim()
  return !!((l && auth.apiKey.trim()) || (l && authState.value.hasKey))
})
const authNeed = computed(() => {
  if (auth.login.trim() && auth.apiKey.trim()) return ''
  if (auth.login.trim() && authState.value.hasKey) return ''
  if (!auth.login.trim()) return '还差用户名'
  return '还差 API Key'
})

async function loadAuth() {
  try {
    const r = await api.booruAuthGet()
    authState.value = { login: r?.login || '', hasKey: !!r?.hasKey }
    auth.login = r?.login || ''
    authReadErr.value = ''
  } catch (e) {
    authReadErr.value = e?.message || String(e)
  }
}

async function saveAuth() {
  /* 半填时**按钮照点、点下去给一句解释**, 不要把按钮禁掉: 灰按钮点了没反应,
   * 用户分不清是"卡住了"还是"没保存成功"(这个用户被这类坑报过好几次)。 */
  if (!authReady.value) {
    authMsgTone.value = 'warn'
    authMsg.value = `${authNeed.value}：用户名和 API Key 要一起填（只填一个等于没配），这次没保存`
    return false
  }
  authBusy.value = true
  authMsg.value = ''
  try {
    const r = await api.booruAuthSet({ login: auth.login, apiKey: auth.apiKey })
    authState.value = { login: r?.login || '', hasKey: !!r?.hasKey }
    auth.apiKey = ''                      // 存完就清空输入框, 别让明文留在界面上
    authMsgTone.value = 'ok'
    authMsg.value = r?.hasKey ? '已保存（只存在本机主进程目录）' : '已清除，回到匿名访问'
    return true
  } catch (e) {
    authMsgTone.value = 'warn'
    authMsg.value = e.message || String(e)
    return false
  } finally { authBusy.value = false }
}

async function clearAuth() {
  authBusy.value = true
  authMsg.value = ''
  try {
    await api.booruAuthSet({ clear: true })
    auth.apiKey = ''
    authState.value = { login: '', hasKey: false }
    auth.login = ''
    authMsgTone.value = 'ok'
    authMsg.value = '已清除，联网挑图回到匿名档'
  } catch (e) {
    authMsgTone.value = 'warn'
    authMsg.value = e.message || String(e)
  } finally { authBusy.value = false }
}

/** 测试 = 发一条"匿名必定被拒"的三标签查询, 成不成一目了然(见 booru.js 的 booruAuthTest) */
async function testAuth() {
  authBusy.value = true
  authMsg.value = ''
  try {
    const r = await api.booruAuthTest()
    if (r?.ok) {
      authMsgTone.value = 'ok'
      authMsg.value = r.credentialed
        ? `✓ 通了 —— 三标签查询被接受，排序用上了站方人气(order=score)`
        : `✓ 通了，但这是匿名结果（Key 没保存或只填了一半）`
    } else {
      authMsgTone.value = 'warn'
      authMsg.value = `✕ ${r?.error || '测试失败'}`
    }
  } catch (e) {
    authMsgTone.value = 'warn'
    authMsg.value = `✕ ${e.message || String(e)}`
  } finally { authBusy.value = false }
}

const MODEL_FALLBACK = [
  { value: 'v0.9', label: 'PixAI Tagger v0.9（默认 · 稳定）' },
  { value: 'v1.0', label: 'PixAI Tagger v1.0（实验 · 30,877 标签）' },
  { value: 'v1.0-336', label: 'PixAI Tagger v1.0 336-ft（快速 · 批量）' },
  { value: 'v1.0-672', label: 'PixAI Tagger v1.0 672-ft（实验 · 仅 CUDA 快）' },
]
const MODEL_IDS = ['v0.9', 'v1.0', 'v1.0-336', 'v1.0-672']
const modelOptions = computed(() => {
  const presets = app.tagger?.config?.presets
  const list = Array.isArray(presets) && presets.length ? presets : MODEL_FALLBACK
  return [{ value: 'auto', label: '自动（跟随旧配置 / 默认 v0.9）' }, ...list]
})

const baseName = (p) => String(p || '').split(/[\\/]/).pop()
const expectedHint = computed(() => {
  if (prefs.model === 'v1.0-336') return 'pixai-tagger-v1.0-336-ft-fp16.onnx + 同名 .csv'
  if (prefs.model === 'v1.0-672') return 'pixai-tagger-v1.0-672-ft-fp16.onnx + 同名 .csv'
  if (prefs.model === 'v1.0') return 'pixai-tagger-v1.0-1008-fp16.onnx + 同名 .csv'
  return 'wd-pixai-tagger-v0.9.onnx + .csv'
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
  authMsg.value = ''
  try {
    const [v, a] = await Promise.all([
      api.appVersion().catch(() => null),
      api.taggerAccel().catch((e) => ({ ok: false, error: e.message })),
      // Python 字段读 app.tagger.config.python —— 不刷新的话显示的是启动时的旧值,
      // 首启下载完环境的机器会一直显示"未配置"(2026-10-15 用户截图实测)
      app.taggerRefresh().catch(() => null),
      loadAuth(),
    ])
    if (v) { version.value = v.version; packed.value = v.packaged }
    accel.value = a
    const r = await api.settingsSet({}).catch(() => null)
    if (r?.settings) {
      prefs.model = MODEL_IDS.includes(r.settings.taggerModel) ? r.settings.taggerModel : 'auto'
      prefs.provider = r.settings.taggerProvider || 'auto'
      prefs.threshold = r.settings.taggerThreshold ?? 0.35
      prefs.charThreshold = r.settings.taggerCharThreshold ?? 0.85
      prefs.groupedTags = r.settings.groupedTags !== false
    }
  } finally {
    probing.value = false
  }
}

watch(open, (v) => { if (v) loadAll() })

async function save() {
  saving.value = true
  try {
    /* 底部这个「保存设置」以前**只管反推那几项**, 凭据要单独点上面的「保存凭据」。
     * 2026-10-22 用户就是填完 Key 点的这个按钮 —— 看到"已保存"以为成了, 其实磁盘上
     * 什么都没写(全盘搜不到 booru_auth.json), 于是"保存了 Key 搜索还是匿名"。
     * 两个按钮管两件事是设计问题: 框里填了凭据就顺手一起存, 不让用户猜哪个管哪段。 */
    const credsPending = !!(auth.login.trim() || auth.apiKey.trim())
    const r = await api.settingsSet({
      taggerModel: prefs.model === 'auto' ? '' : prefs.model,
      taggerProvider: prefs.provider,
      taggerThreshold: Number(prefs.threshold),
      taggerCharThreshold: Number(prefs.charThreshold),
      groupedTags: prefs.groupedTags,
    })
    if (r?.settings) app.settings = r.settings   // 展示开关立即生效(光箱/详情页读它)
    // 模型/阈值变了, 下一次反推会重启服务; 这里刷新状态让文件路径与缺失提示立刻更新
    await app.taggerRefresh().catch(() => null)
    if (credsPending) {
      const ok = await saveAuth()
      if (ok) ui.ok('已保存（含 Danbooru 凭据）', 'info', 2600)
      else ui.err('设置已保存，但凭据没存上：' + authMsg.value)
    } else {
      ui.ok('已保存，下一次反推生效', 'info', 2200)
    }
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
  <TvDrawer v-model="open" title="⚙️ 设置" :width="600">
    <div class="settings">
      <!-- ── 反推环境 ── -->
      <section>
        <h3>反推环境</h3>

        <div class="row">
          <span class="k">
            实际后端
            <TvInfoTip>
              每次反推会按 <b>CUDA &gt; DirectML &gt; CPU</b> 的顺序自动挑第一个可用后端。
              这里显示的是最近一次反推真正用上的那个 —— 没跑过反推时为空。
            </TvInfoTip>
          </span>
          <span class="v">
            <span v-if="usedProvider()" class="chip on">{{ usedProvider() }}</span>
            <span v-else class="chip">尚未运行过反推</span>
          </span>
        </div>

        <div class="row">
          <span class="k">
            onnxruntime
            <TvInfoTip>
              <b>想要 CUDA 加速？</b>命令行执行
              <span class="mono">pip install onnxruntime-gpu</span>
              <button class="linkbtn" type="button" @click="copyCudaCmd">复制命令</button><br>
              需要 NVIDIA 显卡 + CUDA 12 运行库；装好后的<b>首次反推</b>会有几分钟内核编译，
              之后比 DirectML 更快。不装也完全能用，DirectML 对多数场景已经够快。
            </TvInfoTip>
          </span>
          <span v-if="probing" class="v">探测中…</span>
          <span v-else-if="accel?.ok" class="v inline">
            v{{ accel.version }} · 可用后端:
            <span class="mono">{{ (accel.providers || []).map((p) => PROVIDER_LABEL[p] || p).join(' / ') || '无' }}</span>
            <span v-if="!hasCuda()" class="warn">没有 CUDA 后端（点 ⓘ 看装法）</span>
            <span v-else class="oktxt">✓ CUDA 已就绪</span>
          </span>
          <span v-else class="v">
            <span class="warn">探测失败: {{ accel?.error || '还没有可用的 Python 解释器' }}</span>
            <span class="dim">可先在扫描页完成反推环境引导</span>
          </span>
        </div>

        <div class="row">
          <span class="k">
            反推模型
            <TvInfoTip :width="320">
              <template v-if="prefs.model === 'v1.0'">
                <b>v1.0 是实验档</b>：词表 30,877 个（v0.9 的 2.3 倍，Nikke 等新角色覆盖更好），
                但输入是 1008px —— CUDA 单张约 1.2s，CPU / DirectML 会慢到几十秒。模型与同名
                <span class="mono">.csv</span> 放进 <span class="mono">&lt;数据目录&gt;/models/</span> 即可，
                无需重装环境。词表自带逐标签推荐阈值，上面的「置信度阈值」只对没有自带阈值的标签生效。
              </template>
              <template v-else-if="prefs.model === 'v1.0-336'">
                <b>336-ft 是批量首选</b>：同一份 30,877 标签词表，输入缩到 336px。
                本机实测 DirectML <b>0.17 秒/张</b>、CUDA 约 0.19 秒/张、CPU 约 5.8 秒/张 ——
                DirectML 终于能跑批量了。代价是角色召回略低于 1008（6 张 Nikke 小样本 4/8 vs 5/8），
                细节标签也少一些。模型与同名 <span class="mono">.csv</span> 放进
                <span class="mono">&lt;数据目录&gt;/models/</span>，词表自带推荐阈值。
              </template>
              <template v-else-if="prefs.model === 'v1.0-672'">
                <b>672-ft 只在 CUDA 上值得用</b>：本机实测 CUDA 约 0.26 秒/张，但 DirectML 约 14 秒/张
                （这个尺寸的图 DirectML 跑不动）。没有 N 卡请选 336-ft 或 1008；有 N 卡且想要比 1008
                快、比 336 细一点时再选它。
              </template>
              <template v-else>
                <b>默认档</b>：v0.9 输入 448px，词表约 13k，速度与召回最稳，适合大多数机器。
                v1.0 系列词表更大（30,877），对冷门角色覆盖更好，但更吃显卡。
              </template>
            </TvInfoTip>
          </span>
          <span class="v grow"><TvSelect v-model="prefs.model" :options="modelOptions" /></span>
        </div>

        <div class="row">
          <span class="k">模型文件</span>
          <span class="v inline">
            <template v-if="app.tagger?.config?.model">
              <span class="mono">{{ baseName(app.tagger.config.model) }}</span>
              <span class="chip on">{{ app.tagger.config.modelPresetLabel }}</span>
              <span class="dim">预处理 {{ app.tagger.config.preprocess }}</span>
            </template>
            <span v-else class="warn">未找到 —— 需要 {{ expectedHint }}</span>
            <span v-if="app.tagger?.config?.missing?.length" class="warn">
              （缺 {{ app.tagger.config.missing.join(' / ') }}）
            </span>
          </span>
        </div>

        <div class="row">
          <span class="k">
            后端覆盖
            <TvInfoTip>
              一般保持「自动」即可。只有在自动选择不符合预期时才强制指定：
              <b>CUDA</b> 需要 NVIDIA 显卡与 onnxruntime-gpu；<b>DirectML</b> 适配 N/A/I 卡与核显；
              <b>CPU</b> 最慢但零依赖。
            </TvInfoTip>
          </span>
          <span class="v grow"><TvSelect v-model="prefs.provider" :options="PROVIDER_OPTIONS" /></span>
        </div>

        <div class="row">
          <span class="k">
            置信度阈值
            <TvInfoTip>
              低于阈值的标签直接丢掉。分两档：<b>总</b>管普通标签，<b>角色</b>单独一档
              （角色词误报代价更高，默认更保守）。越低标签越多越杂，越高越保守；
              <b>0.35 / 0.85</b> 为默认。带推荐阈值的词表（v1.0 系列）优先用词表自带值。
            </TvInfoTip>
          </span>
          <span class="v inline">
            总 <input v-model.number="prefs.threshold" class="num" type="number" min="0.01" max="0.95" step="0.05" />
            角色 <input v-model.number="prefs.charThreshold" class="num" type="number" min="0.05" max="0.99" step="0.05" />
          </span>
        </div>

        <div class="row">
          <span class="k">
            Python
            <TvInfoTip>
              反推脚本运行在这个解释器上。优先用应用自带/下载的嵌入式运行时；
              显示「候选自动探测」表示还没绑定，首次反推时会从系统里找可用的 Python。
            </TvInfoTip>
          </span>
          <span class="v">
            <span class="mono">{{ app.tagger?.config?.python || '未配置' }}</span>
            <span v-if="app.tagger?.config?.python && !app.tagger?.config?.pythonOwned" class="dim">候选自动探测</span>
            <span v-else-if="app.tagger?.config?.python" class="dim">嵌入式运行时</span>
          </span>
        </div>
      </section>

      <!-- ── 在线封面(Danbooru) ── -->
      <section>
        <h3>
          在线封面（Danbooru）
          <TvInfoTip :width="340">
            <b>怎么拿 Key</b>：登录 <span class="mono">danbooru.donmai.us</span> → 右上角头像 →
            <b>My Account → API Keys</b> → Add（只填一个 Name 就能生成）→ 复制那串 Key 回来。<br>
            填了之后有三处实打实的区别：<b>①一次能带更多普通标签</b>（匿名只给 2 个普通标签额度，
            <span class="mono">角色 + solo + 画师</span> 这种就超了；实测 <span class="mono">rating:g</span>
            这类元标签不占额度）；<b>②按站方人气排序</b>（匿名的 order 参数完全被忽略，
            只能在最新那几十张里本地比分数，小众角色常挑到 2 分的图）；<b>③限流宽松、少被 Cloudflare 拦</b>。<br>
            🔓 <b>Safebooru 不需要 Key</b> —— 它是免登录的公开全年龄站，这个设置只管 Danbooru 一家。<br>
            🔒 这串 Key 只写进本机的 <span class="mono">booru_auth.json</span>（应用自己的用户数据目录），
            不进数据目录、不进仓库、界面也读不回来原值；不想用了点「清除」回到匿名。<br>
            ⌨️ <b>用户名和 Key 要成对填</b>（Danbooru 的 Key 必须跟登录名一起用，只填一个等于没配）；
            填完点「保存凭据」或下面的「保存设置」都算数，看「当前状态」变成
            <b>已配置 你的用户名</b> 才算真存上了。
          </TvInfoTip>
        </h3>

        <div class="row">
          <span class="k">当前状态</span>
          <span class="v inline">
            <span v-if="authReadErr" class="chip err">读取失败</span>
            <span v-else-if="authState.hasKey" class="chip on">已配置 {{ authState.login }}</span>
            <span v-else class="chip">匿名访问</span>
            <span v-if="authReadErr" class="dim">主进程没这段代码（{{ authReadErr }}）—— 这个实例是旧版，重启应用才有凭据功能</span>
            <span v-else class="dim">只影响「挑封面 / 批量拉封面」联网取图</span>
          </span>
        </div>
        <div class="row">
          <span class="k">用户名</span>
          <span class="v grow"><input v-model="auth.login" class="txt" type="text" autocomplete="off" spellcheck="false" placeholder="Danbooru 登录名" /></span>
        </div>
        <div class="row">
          <span class="k">API Key</span>
          <span class="v grow"><input v-model="auth.apiKey" class="txt" type="password" autocomplete="off" spellcheck="false" :placeholder="authState.hasKey ? '已保存过，留空表示不改动' : '粘贴 Key'" /></span>
        </div>
        <div class="row">
          <span class="k">&nbsp;</span>
          <span class="v inline">
            <TvButton size="sm" variant="primary" :disabled="authBusy"
              :title="authNeed ? authNeed + '：用户名和 Key 要一起填，只填一个等于没配' : '只写本机，不进数据目录'"
              @click="saveAuth">
              {{ authBusy ? '处理中…' : '保存凭据' }}
            </TvButton>
            <TvButton size="sm" variant="secondary" :disabled="authBusy" @click="testAuth">测试连接</TvButton>
            <TvButton v-if="authState.hasKey" size="sm" variant="secondary" :disabled="authBusy" @click="clearAuth">清除</TvButton>
            <span v-if="authNeed && !authMsg" class="dim">{{ authNeed }}</span>
            <span v-if="authMsg" :class="['authmsg', authMsgTone]">{{ authMsg }}</span>
          </span>
        </div>
      </section>

      <!-- ── 通用 ── -->
      <section>
        <h3>通用</h3>
        <div class="row">
          <span class="k">
            标签分组
            <TvInfoTip>
              标签按语义分类分组展示（人数 → 角色 → 系列 → 服饰/表情动作…）。
              关掉即回到纯平铺；保存后立即生效。
            </TvInfoTip>
          </span>
          <span class="v inline">
            <label class="chk">
              <input v-model="prefs.groupedTags" type="checkbox" />
              按分类分组展示
            </label>
          </span>
        </div>
        <div class="row">
          <span class="k">当前版本</span>
          <span class="v inline">
            v{{ version || '?' }} <span v-if="!packed" class="dim">开发模式</span>
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
  </TvDrawer>
</template>

<style scoped>
.settings { font-size: 13px; line-height: 1.7; }
section { margin-bottom: 18px; }
section:last-child { margin-bottom: 0; }
h3 {
  display: flex; align-items: center; gap: 6px;
  margin: 0 0 10px; font-size: 12px; font-weight: 700;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
}
.row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.k {
  flex: 0 0 100px; color: var(--muted); font-size: 12px; padding-top: 3px;
  display: inline-flex; align-items: center; gap: 5px;
}
.v { flex: 1 1 auto; min-width: 0; }
.v.grow { display: flex; }
.v.inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  background: var(--panel3); color: var(--muted); font-size: 12px; font-weight: 600;
  margin-right: 8px;
}
.chip.on { background: var(--accent-soft); color: var(--accent); }
.chip.err { background: var(--warn-soft, rgba(192, 57, 43, .16)); color: var(--danger, #c0392b); }
.mono {
  font-family: var(--mono, Consolas, monospace); font-size: 12px;
  background: var(--panel3); border-radius: 4px; padding: 1px 5px; word-break: break-all;
}
.num {
  width: 64px; padding: 3px 6px; font-size: 12px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.txt {
  flex: 1 1 auto; min-width: 0; max-width: 320px;
  padding: 4px 8px; font-size: 12px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.authmsg { font-size: 12px; }
.authmsg.ok { color: var(--accent); }
.authmsg.warn { color: var(--danger, #c0392b); }
.linkbtn {
  border: none; background: none; color: var(--accent);
  cursor: pointer; font-size: 12px; padding: 0 4px; text-decoration: underline;
}
.dim { color: var(--faint); font-size: 11px; margin-left: 6px; }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.chk input { accent-color: var(--accent); }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.warn { color: var(--danger, #c0392b); font-size: 11px; }
.oktxt { color: var(--accent); font-size: 11px; }
</style>
