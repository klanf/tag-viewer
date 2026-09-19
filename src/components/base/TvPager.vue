<script setup>
/** 分页条 —— 首页与标签浏览页共用(旧版 renderPager / renderTagPager 是两份拷贝) */
import { computed } from 'vue'
import { pagerPages } from '@/composables/useImageFeed.js'

const props = defineProps({
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 60 },
  /** 最多显示多少个数字按钮后折叠(0 = 不限制) */
  compactAfter: { type: Number, default: 0 },
})
const emit = defineEmits(['goto'])

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))))
const items = computed(() => pagerPages(props.page, totalPages.value))
</script>

<template>
  <div v-if="totalPages > 1" class="pager">
    <button class="page nav" :disabled="page <= 1" title="上一页" @click="emit('goto', page - 1)">‹</button>
    <template v-for="it in items" :key="it.key">
      <span v-if="it.type === 'gap'" class="page ellipsis">…</span>
      <button
        v-else
        :class="['page', { active: it.page === page }]"
        @click="emit('goto', it.page)"
      >{{ it.page }}</button>
    </template>
    <button class="page nav" :disabled="page >= totalPages" title="下一页" @click="emit('goto', page + 1)">›</button>
  </div>
</template>

<style scoped>
.pager {
  display: flex; gap: 4px; flex-wrap: wrap; justify-content: center;
  margin-top: 12px;
}
.page {
  min-width: 30px; height: 28px; padding: 0 6px;
  background: var(--panel2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  font-size: 12px;
}
.page:hover:not(:disabled) { border-color: var(--accent); }
.page.active { background: var(--accent); color: var(--on-accent); font-weight: 700; border-color: var(--accent); }
.page.ellipsis { border: none; background: transparent; color: var(--muted); cursor: default; }
.page.nav { font-size: 14px; font-weight: 700; }
.page:disabled { opacity: .4; cursor: not-allowed; }
</style>
