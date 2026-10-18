<script setup>
/**
 * WD14 反推安装横幅(2026-10-18 按需安装 v3)
 * =========================================
 * 未装反推环境 && 库里有图 && 用户没点过「不再提示」时, 在看板右栏顶部
 * 显示一条**非模态**横幅 —— 这是 WD14 安装引导唯一会主动出现的形态,
 * 打断性提示(遮罩/弹窗)在 v3 里已全部移除。
 *
 * · 点击「安装反推」→ 打开全局 TvTaggerSetupModal(一键下载+进度+装完自动反推)
 * · 「暂不」    -> settings.wd14Prompt='later'  本会话不再弹, 下次启动可再弹
 * · 「不再提示」-> settings.wd14Prompt='never'  永久静默(扫描页提示条/光箱小字仍在)
 * · 会话去重用**模块级**标记 —— 组件随路由反复挂载也不会重弹(同 useTaggerSetup 模式)
 * · 挂点: 看板就绪 + totalImages 变化(首扫落库/后台同步完成 = "库里有图"刚成立的时刻)
 */
import { onMounted, ref, watch } from 'vue'
import TvButton from '../base/TvButton.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { openTaggerSetup } from '@/composables/useTaggerSetup.js'
import { api } from '@/utils/api.js'

const app = useAppStore()
const visible = ref(false)
const checking = ref(false)

/** 模块级会话去重: 只要这个进程里弹过一次(不管用户点了什么), 就不再弹 */
const shownThisSession = { value: false }

/** 环境未就绪判定 —— 与旧向导的 envNeeded 同源, 用静态 config:
 *  degraded 要真跑过一次反推才置位, 选完文件夹那一刻永远是 false。 */
function envMissing(ts) {
  if (!ts) return false
  const c = ts.config || {}
  return ts.degraded === true || c.available === false || c.pythonOwned === false
}

async function check() {
  if (shownThisSession.value || visible.value || checking.value) return
  if (!app.ready || !(app.totalImages > 0)) return          // 库里没图不弹
  if (String(app.settings?.wd14Prompt || '') === 'never') return
  checking.value = true
  try {
    const ts = await api.taggerStatus().catch(() => null)
    if (envMissing(ts)) {
      visible.value = true
      shownThisSession.value = true
    }
  } finally {
    checking.value = false
  }
}

async function remember(v) {
  visible.value = false
  try { await app.setSetting('wd14Prompt', v) } catch { /* setSetting 有乐观更新兜底 */ }
}

function install() {
  visible.value = false
  openTaggerSetup()
}

/* 一键下载完成(用户从横幅/弹窗装好了) → 收横幅, 顺便标记本会话已处理 */
watch(() => app.setup?.done, (d) => {
  if (d) {
    visible.value = false
    shownThisSession.value = true
  }
})

onMounted(() => {
  check()
  watch(() => app.totalImages, () => check())
})
</script>

<template>
  <div v-if="visible" class="wd14-banner" data-test="wd14-banner">
    <span class="ico">🪄</span>
    <span class="txt">
      看板里的图还没打上反推标签 —— 当前显示的是图片自带提示词（部分图可能没有）。
      安装 <b>WD14 反推</b>后自动打标入库，标签更丰富（风格 / 人物特征 / 构图）。
    </span>
    <span class="sp" />
    <div class="acts">
      <TvButton variant="primary" size="sm" @click="install">安装反推</TvButton>
      <TvButton variant="secondary" size="sm" title="本会话不再弹出，下次启动可再提示" @click="remember('later')">暂不</TvButton>
      <TvButton variant="ghost" size="sm" title="永久不再弹出（扫描页提示条与光箱入口仍可用）" @click="remember('never')">不再提示</TvButton>
    </div>
  </div>
</template>

<style scoped>
.wd14-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; margin-bottom: 10px;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-md, 8px);
  font-size: 12px; line-height: 1.6;
}
.ico { font-size: 16px; flex: none; }
.txt { color: var(--muted); }
.txt b { color: var(--accent); font-weight: 500; }
.sp { flex: 1; }
.acts { display: flex; gap: 6px; flex: none; }
</style>
