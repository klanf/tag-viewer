import { ref } from 'vue'

/**
 * 「WD14 反推没有就绪」引导弹窗的开关
 * ====================================
 * 反推环境不全(缺 Python / 模型)时, 界面上有三处入口都能打开同一个弹窗:
 *   · 扫描页的常驻提示条(TvIngestBadge 管不到"还没开始跑"的静态缺失)
 *   · 右下角后台任务胶囊的降级摘要(TvIngestBadge —— 反推被跳过的那一刻)
 * 弹窗本体只挂一份(挂在 App.vue), 这里用**模块级** ref 做跨组件共享 ——
 * 不进 pinia: 它是纯 UI 状态, 与数据无关, 也不需要被任何视图订阅。
 */
const open = ref(false)

export function useTaggerSetup() {
  return { open }
}

export function openTaggerSetup() {
  open.value = true
}
