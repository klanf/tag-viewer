<script setup>
/**
 * 导出预设管理 —— 「ban 完自动导出」的配置台
 * ==========================================
 * 背景(2026-09-22 用户诉求): 每 ban 一个词条都要手动导出一次, 还得在
 * 「另存为」里挑目录, 纯重复劳动。于是把「筛选条件 + 目标目录/文件名」存成预设,
 * 黑名单**内容真的变了**就自动覆盖导出一次。
 *
 * 几个刻意的地方:
 *   · 预设里存的是**一份筛选快照**(来源可多选、搜索词、组合模式、各开关) ——
 *     不跟首页当前条件联动, 免得改一次筛选把自动导出结果带偏。
 *   · 「来源」可以自己勾, 不必等于首页当前来源(用户 2026-09-22 特别要求)。
 *   · 新建时用首页当前条件做初值(省得从零填), 之后就是快照。
 */
import { ref, computed, watch } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvInput from '../base/TvInput.vue'
import TvSelect from '../base/TvSelect.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
import TvSourceChips from '../filter/TvSourceChips.vue'
import TvCartPresetSection from '../cart/TvCartPresetSection.vue'
import { api } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { nfmt, bytes, dur, ts as fmtTs } from '@/utils/format.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 来源列表 [{name, images}] —— 与首页共用同一份统计 */
  sources: { type: Array, default: () => [] },
  totalImages: { type: Number, default: 0 },
  /** 首页当前筛选条件, 只用作「新建预设」的初值 */
  snapshot: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update:modelValue', 'changed'])

const ui = useUiStore()

const presets = ref([])
const loading = ref(false)
const busy = ref('')          // 'run:<id>' / 'save' / 'del:<id>'
const editing = ref(null)     // 表单对象; null = 看列表
const formErr = ref('')

const MODE_OPTS = [{ value: 'any', label: '任一命中(any)' }, { value: 'all', label: '全部命中(all)' }]
const MATCH_OPTS = [{ value: 'contains', label: '包含(contains)' }, { value: 'exact', label: '完全相等(exact)' }]

const isNew = computed(() => !!editing.value && !presets.value.some((p) => p.id === editing.value.id))

/* ------------------------------------------------------------ 读取 */

async function load() {
  loading.value = true
  try {
    const r = await api.exportPresets()
    presets.value = r?.presets || []
  } catch (e) {
    ui.err('读取导出预设失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => {
  if (!v) { editing.value = null; return }
  editing.value = null
  load()
  loadDelay()
})

/* ---------------------------------------------------- 延迟(全局设置) */

/**
 * 「ban 完之后等多久才导」—— **全局一个值**, 不是每个预设各一份。
 * 起因(2026-09-24 用户诉求): 连着 ban 好几个标签时, 每个都各触发一次 3~4 秒的
 * 同步导出太磨人; 等几分钟, 中间所有改动合并成一次。
 *
 * 档位从主进程带回来(见 export:preset:state): 渲染层不自己写一份,
 * 免得两边漂移 —— 一边改了档位、另一边还按旧值显示, 用户会看到"选了 1 分钟却等 3 分钟"。
 */
const delayMs = ref(0)
const delayOpts = ref([])

async function loadDelay() {
  try {
    const s = await api.exportPresetState()
    delayMs.value = Number(s?.delayMs) || 0
    delayOpts.value = (s?.delayOptions || []).map((v) => ({ value: v, label: dur(v) }))
  } catch { /* 浏览器降级 / 主进程没注册: 不显示这一行就行 */ }
}

async function onDelayChange(v) {
  try {
    const r = await api.exportPresetDelay(v)
    delayMs.value = Number(r?.delayMs) || Number(v)
    ui.ok(`⏱ 已改成 ${dur(delayMs.value)} 后自动导出`, 2200)
  } catch (e) {
    ui.err('改延迟失败: ' + e.message)
    await loadDelay()          // 取回真实值, 免得界面停在没生效的选项上
  }
}

/* ------------------------------------------------------------ 表单 */

function blankParams() {
  const s = props.snapshot || {}
  return {
    source: Array.isArray(s.source) ? [...s.source] : [],
    q: s.q || '',
    mode: s.mode || 'any',
    match: s.match || 'contains',
    exclude: s.exclude || '',
    exclude_match: s.exclude_match || 'contains',
    exclude_char: s.exclude_char !== false,
    spaces: s.spaces !== false,
    blacklist: s.blacklist !== false,
    replace: s.replace !== false,
    bg: s.bg !== false,
    strip_char: !!s.strip_char,
    strip_view: !!s.strip_view,
    safe_only: !!s.safe_only,
    with_path: !!s.with_path,
  }
}

function startNew() {
  formErr.value = ''
  editing.value = {
    id: '',
    name: '',
    dir: '',
    file: '筛选结果.txt',
    auto: true,
    params: blankParams(),
  }
}

function startEdit(p) {
  formErr.value = ''
  editing.value = {
    id: p.id,
    name: p.name,
    dir: p.dir,
    file: p.file,
    auto: !!p.auto,
    params: { ...blankParams(), ...(p.params || {}) },
  }
}

async function pickDir() {
  try {
    const r = await api.pickExportDir()
    if (r?.canceled) return
    if (r?.path) editing.value.dir = r.path
  } catch (e) {
    ui.err('选择目录失败: ' + e.message)
  }
}

async function save() {
  const f = editing.value
  if (!f) return
  if (!f.dir) { formErr.value = '请先选一个目标目录'; return }
  busy.value = 'save'
  try {
    const r = await api.exportPresetSave({
      id: f.id || undefined,
      name: f.name,
      dir: f.dir,
      file: f.file,
      auto: f.auto,
      params: f.params,
    })
    presets.value = r?.presets || presets.value
    editing.value = null
    ui.ok(`✅ 已保存预设「${r?.preset?.name || f.name}」`, 2000)
    emit('changed')
  } catch (e) {
    formErr.value = e.message
  } finally {
    busy.value = ''
  }
}

/* ------------------------------------------------------------ 动作 */

async function runOne(p) {
  busy.value = 'run:' + p.id
  try {
    const r = await api.exportPresetRun(p.id)
    ui.ok(`✅ 已导出 ${nfmt(r.count)} 行 → ${r.path}`, 3200)
    await load()
    emit('changed')
  } catch (e) {
    ui.err(`导出「${p.name}」失败: ` + e.message)
    await load()
  } finally {
    busy.value = ''
  }
}

async function del(p) {
  if (!window.confirm(`删除预设「${p.name}」？\n(已经导出的文件不会被删)`)) return
  busy.value = 'del:' + p.id
  try {
    const r = await api.exportPresetDelete(p.id)
    presets.value = r?.presets || []
    ui.ok('已删除预设', 1600)
    emit('changed')
  } catch (e) {
    ui.err('删除失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}

/** 列表上的「黑名单变更后自动导出」开关: 就地存回去 */
async function toggleAuto(p, v) {
  p.auto = v
  try {
    const r = await api.exportPresetSave({ ...p, auto: v })
    presets.value = r?.presets || presets.value
    emit('changed')
    ui.toast(v ? `「${p.name}」已开启自动导出` : `「${p.name}」已关闭自动导出`, 'info', 1800)
  } catch (e) {
    p.auto = !v
    ui.err('切换失败: ' + e.message)
  }
}

/** 把列表里的绝对路径缩短一点显示(太长会撑爆弹窗) */
function shortDir(d) {
  const s = String(d || '')
  return s.length > 46 ? s.slice(0, 22) + '…' + s.slice(-20) : s
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    title="📤 导出预设"
    size="lg"
    :mask-closable="!editing"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <!-- ---------------- 列表 ---------------- -->
    <template v-if="!editing">
      <div class="tip">
        预设 = <b>一份筛选条件快照</b> + <b>目标目录/文件名</b>。
        勾了「黑名单变更后自动导出」的预设, 在你 ban / 取消 ban 之后
        <b>原地覆盖</b>导出一次, 不用再手动点导出。
      </div>

      <!-- 延迟: 全局设置。连着 ban 好几个标签时, 等一会再导 —— 只导一次 -->
      <div v-if="delayOpts.length" class="delayrow">
        <span class="lb">ban 完之后等</span>
        <TvSelect :model-value="delayMs" size="sm" :options="delayOpts" @update:model-value="onDelayChange" />
        <span class="faint">再自动导出(期间改多少次都只导一次)。改完<b>立刻生效</b>。</span>
      </div>
      <div class="faint delayrow-tip">
        等待期间首页侧栏会出现「待导出 mm:ss」角标 —— <b>点它一下可以跳过等待立刻导</b>;
        这时候关窗口也会先把这次导出跑完再退。
      </div>

      <div v-if="loading" class="muted">读取中...</div>
      <div v-else-if="!presets.length" class="muted">还没有预设 —— 点下面的「＋ 新建预设」开始。</div>

      <div v-else class="plist">
        <div v-for="p in presets" :key="p.id" class="prow" :class="{ on: p.auto }">
          <div class="phead">
            <span class="pname">{{ p.name }}</span>
            <span v-if="p.auto" class="tag-on">自动</span>
            <span v-if="p.params.source && p.params.source.length" class="tag-src">
              {{ p.params.source.length }} 个来源
            </span>
            <span v-if="p.params.q" class="tag-q" :title="p.params.q">🔍 {{ p.params.q }}</span>
          </div>
          <div class="ppath" :title="p.dir + '\\' + p.file">
            {{ shortDir(p.dir) }}<span class="sep">\</span><b>{{ p.file }}</b>
          </div>
          <div class="pmeta">
            <template v-if="p.lastRunAt">
              上次 {{ p.lastTrigger === 'auto' ? '自动' : '手动' }}导出
              {{ fmtTs(p.lastRunAt) }} · <b>{{ nfmt(p.lastCount) }}</b> 行 · {{ bytes(p.lastBytes) }}
            </template>
            <template v-else>还没导出过</template>
            <span v-if="p.lastError" class="err">· ⚠ {{ p.lastError }}</span>
          </div>
          <div class="pacts">
            <label class="auto-sw" :title="'黑名单变更后自动导出'">
              <input
                type="checkbox"
                :checked="p.auto"
                @change="(e) => toggleAuto(p, e.target.checked)"
              >
              变更后自动导出
            </label>
            <TvButton size="xs" variant="secondary" :loading="busy === 'run:' + p.id" @click="runOne(p)">⬇ 立即导出</TvButton>
            <TvButton size="xs" variant="ghost" @click="startEdit(p)">✏ 编辑</TvButton>
            <TvButton size="xs" variant="ghost" :loading="busy === 'del:' + p.id" @click="del(p)">🗑</TvButton>
          </div>
        </div>
      </div>

      <div class="pfoot">
        <TvButton variant="primary" @click="startNew">＋ 新建预设</TvButton>
        <span class="faint">新建时用首页当前的筛选条件做初值(来源、搜索词、各开关)</span>
      </div>

      <!-- 购物车那条是**独立的一份预设**(只有一个, 也不需要筛选快照) ——
           跟上面这些共用同一个台面, 只是为了让"自动导出"只有一个地方可找。 -->
      <div class="csec">
        <div class="csec-t">
          🛒 购物车自动导出
          <span class="faint">（独立的一份，跟随购物车变化，与上面的筛选预设互不影响）</span>
        </div>
        <TvCartPresetSection />
      </div>
    </template>

    <!-- ---------------- 表单 ---------------- -->
    <template v-else>
      <div class="frow">
        <span class="lb">名称</span>
        <TvInput v-model="editing.name" size="sm" placeholder="如: ComfyUI 提示词" />
      </div>

      <div class="fsec">
        <div class="fsec-t">📂 来源(可多选, 空 = 全部)</div>
        <TvSourceChips
          v-model="editing.params.source"
          :sources="sources"
          :total="totalImages"
        />
      </div>

      <div class="frow">
        <span class="lb">搜索标签</span>
        <TvInput v-model="editing.params.q" size="sm" placeholder="逗号分隔, 如: blue_archive, 1girl (留空 = 全部图片)" />
      </div>

      <div class="frow two">
        <div class="half">
          <span class="lb">组合模式</span>
          <TvSelect v-model="editing.params.mode" size="sm" :options="MODE_OPTS" />
        </div>
        <div class="half">
          <span class="lb">匹配方式</span>
          <TvSelect v-model="editing.params.match" size="sm" :options="MATCH_OPTS" />
        </div>
      </div>

      <div class="frow">
        <span class="lb">排除标签</span>
        <TvInput v-model="editing.params.exclude" size="sm" placeholder="逗号分隔 (留空 = 不排除)" />
      </div>

      <div class="fsec">
        <div class="fsec-t">🧹 导出时套用</div>
        <div class="switches">
          <TvCheckbox v-model="editing.params.blacklist" label="剔除黑名单命中的标签" />
          <TvCheckbox v-model="editing.params.replace" label="套用替换规则" />
          <TvCheckbox v-model="editing.params.bg" label="缺背景时补背景标签" />
          <TvCheckbox v-model="editing.params.strip_char" label="剔除角色/系列标签" />
          <TvCheckbox v-model="editing.params.strip_view" label="剔除视角/机位标签" title="去掉 from behind / high angle / dutch angle 等视角机位类标签, 词表 data/export_view_tags.txt 可自行增删" />
          <TvCheckbox v-model="editing.params.safe_only" label="只导出安全模式的标签" title="每个标签串里剔除敏感tag(口径跟随安全模式档位 core/edge), 行数不变" />
          <TvCheckbox v-model="editing.params.spaces" label="下划线转空格" />
          <TvCheckbox v-model="editing.params.with_path" label="每行带图片路径" />
          <TvCheckbox v-model="editing.params.exclude_char" label="排除词也命中带括号标签" />
        </div>
      </div>

      <div class="fsec">
        <div class="fsec-t">💾 导出到</div>
        <div class="dirrow">
          <TvInput v-model="editing.dir" size="sm" placeholder="目标目录 (点右边按钮选)" />
          <TvButton size="sm" variant="secondary" @click="pickDir">📂 选择…</TvButton>
        </div>
        <div class="dirrow">
          <TvInput v-model="editing.file" size="sm" placeholder="文件名, 如 筛选结果.txt" />
        </div>
        <div class="faint">同名文件会被<b>原地覆盖</b>(写临时文件再改名, 下游不会读到半截)</div>
      </div>

      <div class="fsec">
        <TvCheckbox
          v-model="editing.auto"
          label="🔄 黑名单变更后自动导出到这个文件"
          title="你在标签页 ban / 取消 ban 一个词条后, 自动重新导出一次"
        />
      </div>

      <div v-if="formErr" class="err">{{ formErr }}</div>
    </template>

    <!-- 底部按钮: 列表态只关闭; 表单态是「返回 + 保存」 -->
    <template #footer>
      <TvButton v-if="editing" variant="secondary" @click="editing = null">返回</TvButton>
      <TvButton v-if="editing" variant="primary" :loading="busy === 'save'" @click="save">
        {{ isNew ? '💾 创建预设' : '💾 保存修改' }}
      </TvButton>
      <TvButton v-if="!editing" variant="secondary" @click="emit('update:modelValue', false)">关闭</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin-bottom: 12px; }
.tip b { color: var(--text); }
.muted { color: var(--muted); font-size: 12px; padding: 14px 0; }
.faint { color: var(--faint); font-size: 11px; }
.err { color: var(--danger, #d93025); font-size: 12px; margin-top: 8px; }

/* ---------------- 延迟(全局设置) ---------------- */
.delayrow { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.delayrow .lb { flex: 0 0 auto; }
.delayrow :deep(.tv-select) { flex: 0 0 110px; }
.delayrow-tip { display: block; margin-bottom: 12px; }

/* ---------------- 列表 ---------------- */
.plist { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto; padding-right: 2px; }
.prow {
  border: 1px solid var(--border); border-left: 3px solid var(--border);
  background: var(--panel2); border-radius: var(--r-sm);
  padding: 8px 10px;
}
.prow.on { border-left-color: var(--accent); }
.phead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pname { font-size: 13px; font-weight: 700; color: var(--text); }
.tag-on { font-size: 10px; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px; }
.tag-src { font-size: 10px; color: var(--char, #d19a00); }
.tag-q { font-size: 11px; color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ppath { font-size: 11px; color: var(--muted); margin-top: 4px; word-break: break-all; }
.ppath b { color: var(--text); }
.ppath .sep { padding: 0 1px; }
.pmeta { font-size: 11px; color: var(--muted); margin-top: 3px; }
.pmeta b { color: var(--accent); }
.pmeta .err { color: var(--danger, #d93025); }
.pacts { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.auto-sw {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--muted); cursor: pointer;
  margin-right: auto;
}
.pfoot { display: flex; align-items: center; gap: 10px; margin-top: 12px; }

/* ---------------- 购物车自动导出(独立一份预设) ---------------- */
.csec { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
.csec-t { font-size: 13px; color: var(--text); margin-bottom: 8px; }

/* ---------------- 表单 ---------------- */
.frow { margin-bottom: 10px; }
.frow.two { display: flex; gap: 10px; }
.frow.two .half { flex: 1 1 0; }
.lb { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.fsec { margin: 12px 0; }
.fsec-t { font-size: 12px; color: var(--text); margin-bottom: 6px; }
.switches { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.dirrow { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.dirrow > :first-child { flex: 1 1 auto; }
</style>
