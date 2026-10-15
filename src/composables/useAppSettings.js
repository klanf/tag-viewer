import { ref } from 'vue'

/**
 * 「设置」弹窗的开关
 * ==================
 * 与 useTaggerSetup 同款: 模块级 ref 跨组件共享, 不进 pinia(纯 UI 状态)。
 * 入口: 顶栏 ⚙️ 按钮。
 */
const open = ref(false)

export function useAppSettings() {
  return { open }
}

export function openAppSettings() {
  open.value = true
}
