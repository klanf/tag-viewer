<script setup>
/**
 * 实体卡片 —— 系列 / 角色共用一张卡
 * ================================
 * 旧版 series.html 里「系列列表」「角色列表」两套 innerHTML 各写了一遍,
 * 字段其实一样(缩略图 + 主名 + 英文名 + 图片数), 只有角标内容与按钮不同。
 * 这里统一成一张卡, 差异走 props/插槽。
 */
import { computed } from 'vue'
import TvImage from '../base/TvImage.vue'

const props = defineProps({
  /** 主标题(中文名 / 角色短名) */
  title: { type: String, default: '' },
  /** 副标题(英文 tag)，斜体小字 */
  subtitle: { type: String, default: '' },
  /** 缩略图绝对路径; 为空则显示占位 */
  thumb: { type: String, default: '' },
  /** 图片数 */
  images: { type: Number, default: 0 },
  /** 角色数(系列卡才有) */
  characters: { type: Number, default: null },
  /** 左上角角标文字 */
  badge: { type: String, default: '' },
  badgeTone: { type: String, default: 'accent' },   // accent | ok | warn
  /** 已加入购物车 -> 显示 ✓ */
  inCart: { type: Boolean, default: false },
  /** 是否可勾选(选择模式) */
  selectable: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  /** 隐藏分类: 整体降透明度 */
  dim: { type: Boolean, default: false },
  /** 缩略图宽度档位 */
  thumbWidth: { type: Number, default: 300 },
})
const emit = defineEmits(['open', 'toggle-cart', 'toggle-select'])

const hasThumb = computed(() => !!props.thumb)
</script>

<template>
  <div
    :class="['ecard', { dim, selected, 'has-sel': selectable, 'in-cart': inCart }]"
    :title="subtitle || title"
    @click="emit('open')"
  >
    <span v-if="badge" :class="['badge', `b-${badgeTone}`]">{{ badge }}</span>

    <button
      v-if="inCart !== null && !selectable && !inCart"
      :class="['cart-btn', { on: inCart }]"
      title="加入购物车"
      @click.stop="emit('toggle-cart')"
    >🛒</button>

    <span v-if="selectable" class="ckbox" @click.stop="emit('toggle-select')">
      <input type="checkbox" :checked="selected" @click.stop="emit('toggle-select')">
    </span>

    <TvImage v-if="hasThumb" :path="thumb" :width="thumbWidth" ratio="3 / 4" :alt="title" />
    <div v-else class="ph">无预览图</div>

    <div class="txt">
      <div class="name" :title="title">{{ title || subtitle }}</div>
      <div v-if="subtitle && title" class="en" :title="subtitle">{{ subtitle }}</div>
      <div class="nums">
        <span>{{ images.toLocaleString() }} 张</span>
        <span v-if="characters !== null" class="ch">{{ characters }} 角色</span>
      </div>
    </div>

    <slot />
  </div>
</template>

<style scoped>
.ecard {
  position: relative;
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.ecard:hover { border-color: var(--accent); }
.ecard.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft) inset; }
.ecard.dim { opacity: .42; }

/* 已加入购物车: 图片周围金色高亮一圈 —— 光一个 ✓ 按钮不够显眼 */
.ecard.in-cart {
  border-color: #f2c14e;
  box-shadow: 0 0 0 2px rgba(242, 193, 78, .55), 0 0 16px rgba(242, 193, 78, .30);
}
.ecard.in-cart:hover { border-color: #ffd76a; }

.badge {
  position: absolute; top: 6px; left: 6px; z-index: 4;
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: rgba(10, 13, 18, .82);
}
.badge.b-accent { color: var(--accent); }
.badge.b-ok { color: var(--accent2); }
.badge.b-warn { color: var(--warn); }

.cart-btn {
  position: absolute; top: 6px; right: 6px; z-index: 5;
  width: 28px; height: 28px; border-radius: 7px;
  background: rgba(10, 13, 18, .75);
  color: var(--muted); font-size: 14px; line-height: 1;
  opacity: 0; transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.ecard:hover .cart-btn { opacity: 1; }
.cart-btn.on { opacity: 1; color: var(--accent2); }
.cart-btn:hover { background: var(--accent2-soft); color: var(--accent2); }

.ckbox {
  position: absolute; top: 8px; left: 8px; z-index: 5;
  width: 22px; height: 22px; border-radius: 5px;
  background: rgba(10, 13, 18, .7);
  display: flex; align-items: center; justify-content: center;
}
.ckbox input { accent-color: var(--accent); width: 14px; height: 14px; pointer-events: none; }

.ph {
  aspect-ratio: 3 / 4;
  display: flex; align-items: center; justify-content: center;
  background: var(--img-bg); color: var(--faint); font-size: 11px;
}

.txt { padding: 6px 8px 8px; }
.name {
  font-size: 12px; font-weight: 600; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.en {
  font-size: 10px; color: var(--muted); font-style: italic;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nums {
  display: flex; gap: 8px; font-size: 10px; color: var(--faint); margin-top: 2px;
}
.nums .ch { color: var(--char); }
</style>
