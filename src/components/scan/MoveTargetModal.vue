<script setup>
/**
 * 批量移动的目标选择弹窗(扫描页选择模式)
 * ========================================
 * 为什么不用右键那种原生 Menu: 原生 Menu 是操作系统窗口, e2e(CDP) 点不到
 * (README 坑 18 的教训), 而且批量场景下弹窗能同时展示预设+登记文件夹两份清单。
 *
 * 数据源三份:
 *   · quickFolders —— 主进程 settings.json 的「移动到」预设(与右键菜单同一份);
 *   · folders      —— 已登记的文件夹(扫描页的 folders 登记表, 由父组件传入);
 *   · 其他位置…    —— 系统目录选择框(api.pickFolder), 选完先停在"已选择"行,
 *                     用户可顺手「存为预设」再移动, 也可以直接移动。
 *
 * 选择即行动: 点预设/登记文件夹立刻 emit('pick', target) —— 父组件关弹窗跑
 * image:moveMany。同名冲突由后端自动改名(见 ipc.js image:moveMany 注释)。
 */
import { ref, watch } from 'vue'
import TvModal from '@/components/base/TvModal.vue'
import TvButton from '@/components/base/TvButton.vue'
import { api } from '@/utils/api.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 移动多少张(只用来显示标题) */
  count: { type: Number, default: 0 },
  /** 已登记的文件夹记录(folders 登记表, 父组件已有, 不再重复请求) */
  folders: { type: Array, default: () => [] },
  /** 父组件正在执行移动时锁住弹窗按钮 */
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'pick'])

const quick = ref([])
const picked = ref(null)          // 「其他位置」选出来的 { path, name }
const picking = ref(false)
const saving = ref(false)
const loading = ref(false)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  picked.value = null
  loading.value = true
  try {
    const d = await api.quickFolders()
    quick.value = Array.isArray(d?.quickFolders) ? d.quickFolders : []
  } catch {
    quick.value = []
  } finally {
    loading.value = false
  }
})

async function pickOther() {
  picking.value = true
  try {
    const r = await api.pickFolder({ multi: false, title: '移动到哪个文件夹?' })
    if (r?.canceled) return
    const p = r?.paths?.[0] || r?.path
    if (p) picked.value = { path: p, name: p.split(/[\\/]/).filter(Boolean).pop() || p }
  } finally {
    picking.value = false
  }
}

async function savePreset() {
  if (!picked.value) return
  saving.value = true
  try {
    const r = await api.addQuickFolder(picked.value.path)
    if (r?.error) return
    const d = await api.quickFolders()
    quick.value = Array.isArray(d?.quickFolders) ? d.quickFolders : []
  } finally {
    saving.value = false
  }
}

function choose(t) {
  if (props.busy) return
  emit('pick', t)
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    :title="`📤 移动 ${count} 张图片到…`"
    size="md"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="mt-body">
      <div class="sec">
        <div class="sec-t">⭐ 快速预设</div>
        <div v-if="!quick.length" class="empty">还没有预设 —— 从右键菜单「添加预设文件夹」或下面「其他位置」加一个</div>
        <button
          v-for="f in quick"
          :key="f.path"
          class="row"
          type="button"
          :disabled="busy"
          @click="choose(f)"
        >
          <span class="nm">{{ f.name }}</span>
          <span class="pth">{{ f.path }}</span>
        </button>
      </div>

      <div class="sec">
        <div class="sec-t">📂 已登记的文件夹</div>
        <div v-if="!folders.filter((f) => f.exists).length" class="empty">(没有可用的登记文件夹)</div>
        <button
          v-for="f in folders.filter((f) => f.exists)"
          :key="f.path"
          class="row"
          type="button"
          :disabled="busy"
          @click="choose(f)"
        >
          <span class="nm">
            {{ f.name || f.path }}
            <span v-if="f.as_source" class="badge">来源</span>
            <span v-if="f.as_scan" class="badge scan">扫描</span>
          </span>
          <span class="pth">{{ f.path }}</span>
        </button>
      </div>

      <div v-if="picked" class="sec picked-sec">
        <div class="sec-t">✅ 已选择(来自「其他位置」)</div>
        <div class="picked-row">
          <span class="nm">{{ picked.name }}</span>
          <span class="pth">{{ picked.path }}</span>
          <TvButton size="sm" variant="ghost" :loading="saving" :disabled="busy" @click="savePreset">
            存为预设
          </TvButton>
          <TvButton size="sm" variant="primary" :loading="busy" @click="choose(picked)">
            移动到这里
          </TvButton>
        </div>
      </div>
    </div>

    <template #footer>
      <TvButton variant="secondary" :loading="picking" :disabled="busy" @click="pickOther">
        📁 其他位置…
      </TvButton>
      <span class="foot-hint">同名文件会自动改名(如「xxx (2).jpg」), 不会覆盖</span>
    </template>
  </TvModal>
</template>

<style scoped>
.mt-body { max-height: 46vh; overflow-y: auto; padding-right: 4px; }
.sec { margin-bottom: 14px; }
.sec-t { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.empty { color: var(--faint); font-size: 12px; padding: 6px 2px; }

.row, .picked-row {
  display: flex; align-items: center; gap: 10px; width: 100%;
  text-align: left; padding: 7px 10px; margin-bottom: 4px;
  border-radius: var(--r-sm); background: var(--panel3);
  border: 1px solid transparent; cursor: pointer;
}
.row:hover { border-color: var(--accent); }
.row:disabled { opacity: .55; cursor: default; }
.nm { flex: 0 1 auto; font-size: 13px; color: var(--text); display: flex; align-items: center; gap: 6px; }
.pth {
  flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left;
}
.badge {
  font-size: 10px; padding: 1px 5px; border-radius: 999px;
  background: var(--accent-soft, var(--panel3)); color: var(--accent);
}
.badge.scan { color: var(--muted); }

.picked-sec .picked-row { border-color: var(--accent); }
.foot-hint { color: var(--faint); font-size: 11px; margin-left: auto; }
</style>
