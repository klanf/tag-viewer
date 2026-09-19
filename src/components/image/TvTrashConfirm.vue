<script setup>
/**
 * 删除确认弹窗 —— 全局单例(挂在 App.vue), 由 useTrash().state 驱动
 * ============================================================
 * 右键菜单 / Del 键 / 光箱删除都汇到 useTrash().request(),
 * 关了「以后不再询问」后(存 prefs, localStorage 持久化)不再弹, 直接进回收站。
 */
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvCheckbox from '../base/TvCheckbox.vue'
import { useTrash } from '@/composables/useTrash.js'
import { basename } from '@/utils/format.js'

const trash = useTrash()
const { state } = trash
</script>

<template>
  <TvModal
    :model-value="state.open"
    title="🗑 删除图片"
    size="sm"
    :mask-closable="false"
    @close="trash.cancel()"
  >
    <p class="q">把 <b>{{ state.paths.length }}</b> 张图片移入系统回收站?</p>
    <ul class="names">
      <li v-for="p in state.paths.slice(0, 6)" :key="p">{{ basename(p) }}</li>
      <li v-if="state.paths.length > 6" class="more">… 等共 {{ state.paths.length }} 张</li>
    </ul>
    <p class="note">文件会进 Windows 回收站, 需要时可以还原; 看板列表与扫描缓存同步移除。</p>
    <TvCheckbox v-model="state.noAsk" label="以后不再询问(直接删除)" />
    <template #footer>
      <TvButton variant="secondary" @click="trash.cancel()">取消</TvButton>
      <TvButton variant="primary" @click="trash.confirm()">删除</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.q { font-size: 13px; margin-bottom: 8px; }
.q b { color: var(--danger); font-size: 15px; }
.names {
  margin: 0 0 8px; padding: 8px 12px;
  background: var(--panel2); border-radius: var(--r-sm);
  font-size: 11px; color: var(--muted);
  max-height: 132px; overflow: auto;
  word-break: break-all;
}
.names .more { color: var(--faint); font-style: italic; }
.note { font-size: 11px; color: var(--faint); margin-bottom: 10px; }
</style>
