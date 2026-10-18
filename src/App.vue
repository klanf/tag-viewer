<script setup>
/**
 * 应用外壳
 * =========
 * 旧版的公共部分(顶栏、大图预览、toast、气泡)是每个 HTML 各抄一份;
 * 这里全部挂一次, 六个视图只管自己的内容。
 *
 * keep-alive 保留 首页/系列/标签/购物车/扫描 的状态 ——
 * 原版是六个独立页面, 每次进首页都要重新搜一遍; 现在切回来看板,
 * 结果与滚动位置都还在(搜索缓存本来就在主进程里)。
 * 扫描页 2026-09-19 加入: 原来切走再切回只剩文件夹列表, 看到一半的
 * 图片网格整个丢掉, 体验和其它页不一致。
 */
import { onMounted } from 'vue'
import TvAppHeader from '@/components/layout/TvAppHeader.vue'
import TvToastHost from '@/components/layout/TvToastHost.vue'
import TvBootOverlay from '@/components/layout/TvBootOverlay.vue'
import TvLightbox from '@/components/image/TvLightbox.vue'
import TvCartDrawer from '@/components/cart/TvCartDrawer.vue'
import TvFloatNav from '@/components/layout/TvFloatNav.vue'
import TvIngestBadge from '@/components/layout/TvIngestBadge.vue'
import TvSetupProgress from '@/components/layout/TvSetupProgress.vue'
import TvTaggerSetupModal from '@/components/layout/TvTaggerSetupModal.vue'
import TvSettingsModal from '@/components/layout/TvSettingsModal.vue'
import TvTrashConfirm from '@/components/image/TvTrashConfirm.vue'
import TvRulesEditorModal from '@/components/rules/TvRulesEditorModal.vue'
import { useAppStore } from '@/stores/useAppStore.js'
import { useRuleAddStore } from '@/stores/useRuleAddStore.js'
import { watch } from 'vue'

const app = useAppStore()
const ruleAdd = useRuleAddStore()
onMounted(() => app.init())
// 预填用完即清(关编辑器时), 避免下次从工具栏打开时又多插一行
watch(() => ruleAdd.open, (v) => { if (!v) ruleAdd.prefill = null })
</script>

<template>
  <div class="shell">
    <TvAppHeader />

    <main class="stage">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="['HomeView', 'SeriesView', 'TagsView', 'TagImagesView', 'CartView', 'ScanView', 'FavView']">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>

    <!-- 全局单例 -->
    <TvBootOverlay />
    <TvLightbox />
    <TvCartDrawer />
    <TvFloatNav />
    <TvIngestBadge />
    <TvSetupProgress />
    <TvTaggerSetupModal />
    <TvSettingsModal />
    <TvTrashConfirm />
    <!-- 标签右键「加进替换规则」的全局编辑器(prefill 预填一条 exact+保留) -->
    <TvRulesEditorModal v-model="ruleAdd.open" kind="replace" :prefill="ruleAdd.prefill" />
    <TvToastHost />
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* keep-alive 的组件根节点要能撑满 stage */
.stage > * { min-height: 0; }
</style>
