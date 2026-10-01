<script setup>
/**
 * 购物车条目 —— 抽屉与购物车页共用
 * ==============================
 * 旧版这段 innerHTML 在 series.html 的 renderCart() 和 cart.html 的 render() 里
 * 各写了一遍, 连缩略图宽度(200)都要对两次。
 */
import { computed } from 'vue'
import TvImage from '../base/TvImage.vue'

const props = defineProps({
  item: { type: Object, required: true },
  /** 紧凑模式(抽屉里用, 横向排列) */
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['remove', 'open', 'edit'])

const thumb = computed(() => props.item.thumb || '')
/** 附加标签(如给哥伦比亚追加 closed_eyes): 有就显示在系列行里, 让"这行导出会带啥"一眼可见 */
const extras = computed(() => (Array.isArray(props.item.extra) ? props.item.extra : []))
</script>

<template>
  <div :class="['ci', { compact }]" :title="item.tag" @click="emit('open', item)">
    <div class="thumb">
      <TvImage v-if="thumb" :path="thumb" :width="200" ratio="9 / 16" :alt="item.name" />
      <div v-else class="ph" />
    </div>
    <div class="info">
      <div class="name">{{ item.name || item.tag }}</div>
      <div class="meta">
        <span v-if="item.series" class="series">{{ item.series }}</span>
        <b>{{ item.images }}</b> 张
        <span v-if="extras.length" class="extras" :title="`导出时附加: ${extras.join(', ')}`">＋{{ extras.join(' ＋') }}</span>
      </div>
    </div>
    <button class="edit" title="编辑附加标签(导出时拼在这一行后面)" @click.stop="emit('edit', item)">✏️</button>
    <button class="del" title="从购物车移除" @click.stop="emit('remove', item.tag)">✕</button>
  </div>
</template>

<style scoped>
.ci {
  position: relative;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  cursor: pointer;
  display: flex;
  flex-direction: column;
}
.ci:hover { border-color: var(--accent); }

.ci.compact {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 6px;
}
.ci.compact .thumb { width: 44px; flex: 0 0 44px; }
.ci.compact .thumb :deep(.tv-img) { border-radius: 4px; }

.ph { aspect-ratio: 9 / 16; background: var(--img-bg); }

.info { padding: 7px 10px 9px; min-width: 0; }
.ci.compact .info { padding: 0; flex: 1; }
.name {
  font-size: 13px; font-weight: 600; color: var(--text);
  word-break: break-all; line-height: 1.35;
}
.ci.compact .name { font-size: 12px; }
.meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.meta b { color: var(--accent); }
.series {
  display: inline-block; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  vertical-align: bottom;
}

.del {
  position: absolute; top: 6px; right: 6px;
  width: 24px; height: 24px; border-radius: 5px;
  background: rgba(10, 13, 18, .85);
  color: var(--danger); font-size: 13px; line-height: 1;
  opacity: 0; transition: opacity var(--t-fast);
}
.ci:hover .del { opacity: 1; }
.del:hover { background: var(--danger); color: #fff; }
.ci.compact .del { position: static; flex: 0 0 auto; opacity: .55; background: transparent; }
.ci.compact .del:hover { opacity: 1; background: var(--danger-soft); }

/* 附加标签编辑按钮: 与 ✕ 同排, 往左错开; 有附加时常态半可见(不然没人发现这功能) */
.edit {
  position: absolute; top: 6px; right: 34px;
  width: 24px; height: 24px; border-radius: 5px;
  background: rgba(10, 13, 18, .85);
  font-size: 12px; line-height: 1;
  opacity: 0; transition: opacity var(--t-fast);
}
.ci:hover .edit { opacity: 1; }
.edit:hover { background: var(--accent); }
.ci.compact .edit { position: static; flex: 0 0 auto; opacity: .55; background: transparent; }
.ci.compact .edit:hover { opacity: 1; }

.extras {
  display: inline-block; max-width: 100%;
  color: var(--accent2); font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  vertical-align: bottom;
}
</style>
