<script setup>
/**
 * 安全模式开关 —— 工具栏上的那个小控件, 每个"能看到图片的地方"都放一个
 * ==================================================================
 * 用户的原话是"我需要可以看到图片的地方都要加个安全模式的开关, 打开就一键过滤掉"。
 * 所以它必须满足两条:
 *   1. **开关本身随处可得** —— 不用先跳到标签页去开;
 *   2. **按一下真的就过滤掉了** —— 不是只改了个标志位。
 *
 * 为什么把"开关 + 设置入口"做成一个组件而不是各页面各写一遍:
 *   - 开关状态是**全局的**(存在 `dataDir/safety.json`, 由主进程持有), 所以任何一处
 *     打开/关掉, 其它页面立刻同步 —— 前提是大家用的都是同一个 store;
 *   - 设置台(档位 / 编辑集合)只有一份实现( TvSafetyModal ), 各页面各自 `v-model`
 *     一份 show 状态就行, 重复写会跑偏。
 *
 * 打开时给一条 toast 报"隐藏了多少张": 图**突然少了一半**而不给任何反馈, 用户会以为
 * 出了 bug(实测 core 档就是会藏掉 58%)。
 *
 * ------------------------------------------------------ 数字的口径(2026-09-23)
 * 用户反馈两件事, 促成了 `counts` 这个 prop:
 *
 *   · "这边的数字能不能根据不同的来源显示被隐藏的数字"
 *   · "然后这个数字我不点这个按钮好像就默认是 0"
 *
 * 之前那个 `−45,603` 是**整个库**的统计(主进程读数据集时算好的 coreHit) —— 进哪个
 * 来源、翻到哪一页都是同一个大数, 对"这个来源到底藏了多少张"没有回答能力。现在:
 *
 *   1. **谁有"当前列表"谁就把 counts 传进来**。看板 / 系列 / 标签图片 / 扫描页(图片层) /
 *      收藏页传各自当前那批图的两档命中数, 于是切来源胶囊、进文件夹、换系列, 数字跟着变。
 *   2. **不传就回落整个库** —— 标签页、详情页、扫描页的**文件夹列表层**压根没有
 *      "当前图片列表"这个概念, 此时 title 里写明是"整个库", 不冒充当前范围。
 *   3. **开关关着也显示**(淡色) —— 用户抱怨的正是"不点这个按钮数字就默认是 0":
 *      以前 `v-if="safety.on"` 让关掉时数字直接消失, 在打开之前根本不知道会少多少张。
 *
 * 数字为 0 时不显示 —— `−0` 是纯噪声。
 */
import { ref, computed } from 'vue'
import TvButton from '../base/TvButton.vue'
import TvSafetyModal from './TvSafetyModal.vue'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { nfmt } from '@/utils/format.js'

const props = defineProps({
  /** 只显示盾牌图标(工具栏太挤时用) */
  iconOnly: { type: Boolean, default: false },
  /**
   * **当前列表范围**下两档各会隐藏多少张: `{ core, edge }`。
   * 口径与主进程的 `coreHit` / `edgeHit` 一致 —— `core` = 只命中 core 段的条数,
   * `edge` = edge 档会隐藏的总数(即 core + 仅 edge)。
   * 不传 = 这个页面没有"当前图片列表", 回落整个库的统计。
   */
  counts: { type: Object, default: null },
})

const safety = useSafetyStore()
const ui = useUiStore()
const showSet = ref(false)
const busy = ref(false)

/** 有没有"当前范围"这个概念 —— 决定 title 怎么写, 也决定数字从哪来 */
const hasScope = computed(() => !!props.counts && typeof props.counts.core === 'number')

/** 当前档位下、当前范围里会隐藏的张数 */
const shown = computed(() => {
  const c = props.counts
  if (hasScope.value) return (safety.level === 'edge' ? c.edge : c.core) || 0
  return safety.hiddenCount
})

const scopeTip = computed(() => (hasScope.value ? '当前列表' : '整个库'))

const cntTip = computed(() => (safety.on
  ? `${scopeTip.value}里已隐藏 ${nfmt(shown.value)} 张(${safety.level} 档)`
  : `${scopeTip.value}里有 ${nfmt(shown.value)} 张命中「${safety.level}」档 · 打开后被隐藏`))

async function toggle() {
  busy.value = true
  try {
    const next = !safety.on
    await safety.set({ on: next })
    if (next) {
      const n = shown.value
      ui.toast(n
        ? `🛡 安全模式已开 · ${scopeTip.value}隐藏 ${nfmt(n)} 张(${safety.level} 档)`
        : '🛡 安全模式已开(当前范围没命中任何图)', 'ok', 2600)
    } else {
      ui.toast('安全模式已关 · 全部图片回来了', 'info', 1800)
    }
  } catch (e) {
    ui.err('切换安全模式失败: ' + e.message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="safe-tog" :class="{ on: safety.on }">
    <button
      class="st-btn"
      :title="safety.on
        ? `安全模式已开(${safety.level} 档) · 点一下关掉, 全部图片立刻回来`
        : '安全模式: 打开后按标签集合隐藏露骨内容(只影响显示, 不动库里的数据)'"
      :disabled="busy"
      @click="toggle"
    >
      <span class="st-ico">🛡</span>
      <span v-if="!iconOnly">安全{{ safety.on ? '已开' : '模式' }}</span>
    </button>
    <button
      class="st-set"
      title="安全模式设置: 档位与敏感标签集合"
      @click="showSet = true"
    >⚙</button>
    <!-- 关着也显示(淡色) = "打开会隐藏这么多"的预览 —— 见文件头第 3 条 -->
    <span v-if="!iconOnly && shown > 0" class="st-cnt" :title="cntTip">
      −{{ nfmt(shown) }}
    </span>
  </span>
  <TvSafetyModal v-model="showSet" />
</template>

<style scoped>
.safe-tog {
  display: inline-flex; align-items: center; gap: 2px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--panel2); overflow: hidden;
}
.safe-tog.on { border-color: var(--accent); background: var(--accent-soft); }
.st-btn {
  display: inline-flex; align-items: center; gap: 5px;
  background: none; border: 0; cursor: pointer;
  color: var(--text); font-size: 12px; font-family: inherit;
  padding: 4px 8px;
}
.safe-tog.on .st-btn { color: var(--accent); font-weight: 500; }
.st-btn:disabled { opacity: .6; cursor: default; }
.st-ico { font-size: 13px; line-height: 1; }
.st-set {
  background: none; border: 0; border-left: 1px solid var(--border);
  color: var(--muted); cursor: pointer; font-size: 12px;
  padding: 4px 6px; line-height: 1;
}
.st-set:hover { color: var(--accent); }
.st-cnt {
  font-size: 11px; color: var(--accent); padding-right: 7px;
  font-variant-numeric: tabular-nums;
}
/* 关着时的数字是"预览值", 用弱色, 免得跟"已经藏了"混为一谈 */
.safe-tog:not(.on) .st-cnt { color: var(--muted); }
</style>
