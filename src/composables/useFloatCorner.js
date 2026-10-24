import { computed, ref } from 'vue'

/**
 * 右下角浮动键是**一竖列**, 不是各写各的坐标
 * ==========================================
 * 最下面一格留给页面自己的浮动键(目前只有看板的 🎲 换一批), 「↑ 回到顶部」和
 * 「在线封面」胶囊依次往上让一格。以前三者各自写死 bottom, 🎲 与 ↑ 正好重叠
 * 42px 全盖上(2026-10-24 用户报)。
 *
 * 步长 = 🎲 的 44px + 8px 间距; 基座 26 / 96 沿用原来的坐标, 不动别处观感。
 */
export const FLOAT_STEP = 52

const baseTaken = ref(false)

/** 这一页最下面一格被自己的浮动键占了 —— 页面挂载/切换时声明一次 */
export function setFloatBaseTaken(on) {
  baseTaken.value = !!on
}

/** 让位量(px): 消费方加到自己原来的 bottom 上 */
export const floatLift = computed(() => (baseTaken.value ? FLOAT_STEP : 0))
