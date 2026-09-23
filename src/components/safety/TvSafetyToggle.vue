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
 */
import { ref } from 'vue'
import TvButton from '../base/TvButton.vue'
import TvSafetyModal from './TvSafetyModal.vue'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { nfmt } from '@/utils/format.js'

defineProps({
  /** 只显示盾牌图标(工具栏太挤时用) */
  iconOnly: { type: Boolean, default: false },
})

const safety = useSafetyStore()
const ui = useUiStore()
const showSet = ref(false)
const busy = ref(false)

async function toggle() {
  busy.value = true
  try {
    const next = !safety.on
    await safety.set({ on: next })
    if (next) {
      const n = safety.hiddenCount
      ui.toast(n
        ? `🛡 安全模式已开 · 已隐藏 ${nfmt(n)} 张(${safety.level} 档)`
        : '🛡 安全模式已开(当前集合没命中任何图)', 'ok', 2600)
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
    <span v-if="safety.on && !iconOnly" class="st-cnt" :title="`当前档位(${safety.level})下会隐藏的张数`">
      −{{ nfmt(safety.hiddenCount) }}
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
</style>
