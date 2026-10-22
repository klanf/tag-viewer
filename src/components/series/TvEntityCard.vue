<script setup>
/**
 * 实体卡片 —— 系列 / 角色共用一张卡
 * ================================
 * 旧版 series.html 里「系列列表」「角色列表」两套 innerHTML 各写了一遍,
 * 字段其实一样(缩略图 + 主名 + 英文名 + 图片数), 只有角标内容与按钮不同。
 * 这里统一成一张卡, 差异走 props/插槽。
 */
import { computed, ref } from 'vue'
import TvImage from '../base/TvImage.vue'
import coverDefault from '@/assets/cover-default.svg'

/** 没有封面时的默认占位图(2026-10-06): 安全模式藏掉封面 / 库外图没扫出来 都用它 */

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
  /** 显示「设封面」按钮(系列页两张卡都开; 与购物车按钮同款悬停显形) */
  coverable: { type: Boolean, default: false },
  /** 显示「纠正」按钮(角色卡: 改名 / 挪系列 / 屏蔽) */
  editable: { type: Boolean, default: false },
  /** 显示「联网拉一张封面」按钮(角色卡, 2026-10-22)。fetching 时按钮变加载态并禁用 */
  fetchable: { type: Boolean, default: false },
  fetching: { type: Boolean, default: false },
  /** 无封面时的占位文案 */
  phText: { type: String, default: '暂无封面' },
})
const emit = defineEmits(['open', 'toggle-cart', 'toggle-select', 'cover', 'edit', 'fetch'])

const hasThumb = computed(() => !!props.thumb)
/* 卡片右上角原来一列摆 4 个按钮(🛒/🖼/✏️/🌐), 用户 2026-10-22 反馈"图标太多了"→ 合并成一个入口;
 * 气泡先挂右上角(压住脸)→ 挪右下角(还是盖住照片下半)→ 最终按用户第三轮反馈**离开图片区**,
 * 放到「26,120 张 · 239 角色」那一行的右端, 展开方式照光箱标签胶囊(行内滑出图标)。
 * **四个按钮的 class 名一个都没改, 而且始终在 DOM 里** —— e2e 与 UI 测试是按
 * .cart-btn/.cover-btn/.edit-btn/.fetch-btn 找元素并直接 .click() 的; 若改成
 * v-if 把动作收起来, 这些断言会集体变成"找不到元素"的假失败。 */
const menuOpen = ref(false)
const cartable = computed(() => props.inCart !== null)
const hasActions = computed(() => cartable.value || props.coverable || props.editable || props.fetchable)
/** 触发卡片上的任何动作时收起钉住态, 否则点了菜单项气泡还挂着 */
function act(name) {
  menuOpen.value = false
  emit(name)
}
</script>

<template>
  <div
    :class="['ecard', { dim, selected, 'has-sel': selectable, 'in-cart': inCart }]"
    :title="subtitle || title"
    @click="emit('open')"
  >
    <span v-if="badge" :class="['badge', `b-${badgeTone}`]">{{ badge }}</span>

    <!--
      缩略图区: 只放图 + 选择框, 动作入口在下面的文字行里
    -->
    <div class="thumb-box">
      <TvImage v-if="hasThumb" :path="thumb" :width="thumbWidth" ratio="3 / 4" :alt="title" />
      <div v-else class="ph">
        <img :src="coverDefault" alt="" class="ph-img">
        <span class="ph-txt">{{ phText }}</span>
      </div>

      <span v-if="selectable" class="ckbox" @click.stop="emit('toggle-select')">
        <input type="checkbox" :checked="selected" @click.stop="emit('toggle-select')">
      </span>
    </div>

    <div class="txt">
      <div class="name" :title="title">{{ title || subtitle }}</div>
      <div v-if="subtitle && title" class="en" :title="subtitle">{{ subtitle }}</div>
      <!--
        动作入口挂在「26,120 张 · 239 角色」这一行的右端, **不再压在照片上**
        (2026-10-22 用户第三轮反馈: 气泡不管挂右上角还是右下角, 半透明底一盖住图就糊)。
        展开方式抄光箱标签胶囊 TvTagPill 的 .acts: 图标浮层**绝对定位盖在本行右端**,
        底色与卡片同色, 从右侧 translateX 滑入 —— 因为它绝对定位, 展开时卡片几何一点不变,
        不会重演 pill 那条"宽度变了 -> 被挤到下一行 -> hover 丢失 -> 抽搐"的死循环。
        两种状态常亮: 已加车 -> 金色 ✓、正在拉 -> …
      -->
      <div class="nums">
        <span>{{ images.toLocaleString() }} 张</span>
        <span v-if="characters !== null" class="ch">{{ characters }} 角色</span>

        <span
          v-if="hasActions && !selectable"
          :class="['more', { open: menuOpen, busy: fetching }]"
        >
          <button
            :class="['more-btn', { 'is-cart': inCart }]"
            :title="fetching ? '正在联网拉封面…' : '更多操作'"
            @click.stop="menuOpen = !menuOpen"
          >{{ fetching ? '…' : (inCart ? '✓' : '...') }}</button>

          <span class="acts">
            <!--
              四个按钮的 class 名一个没改、且始终在 DOM 里(测试按 .cart-btn/.cover-btn/
              .edit-btn/.fetch-btn 找元素直接 .click())。文字标签没了 -> 说明全交给 title。
            -->
            <button
              v-if="cartable"
              :class="['cart-btn', 'ic', { on: inCart }]"
              :title="inCart ? '移出购物车' : '加入购物车'"
              @click.stop="act('toggle-cart')"
            ><svg viewBox="0 0 24 24"><path d="M3 5h2l2.1 8.6a2 2 0 0 0 2 1.6h7.3a2 2 0 0 0 2-1.5L20.5 8H6.2"/><circle cx="10" cy="19.4" r="1.4"/><circle cx="17" cy="19.4" r="1.4"/></svg></button>

            <button v-if="coverable" class="cover-btn ic" title="挑一张当封面" @click.stop="act('cover')"
            ><svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.4 15.6l-4.5-4.5-8.4 8.6"/></svg></button>

            <button v-if="editable" class="edit-btn ic" title="纠正这个角色(改名 / 挪系列 / 屏蔽)" @click.stop="act('edit')"
            ><svg viewBox="0 0 24 24"><path d="M4 20l1.1-4.1L15.6 5.4a2.2 2.2 0 0 1 3.1 3.1L8.2 19 4 20z"/><path d="M13.6 7.4l3.1 3.1"/></svg></button>

            <button
              v-if="fetchable"
              :class="['fetch-btn', 'ic', { busy: fetching }]"
              :disabled="fetching"
              title="联网拉封面：去 Danbooru / Safebooru 搜这个标签，取翻到的图里得分最高的一张"
              @click.stop="act('fetch')"
            ><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.3-3.6-8.5s1.2-6.1 3.6-8.5z"/></svg></button>
          </span>
        </span>
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

/* ---- .thumb-box: 只装图片区, 给选择框(.ckbox)当定位锚 ----
 * 2026-10-22 第三轮反馈之后, 动作入口已经**搬出图片区**(见下面 .more/.acts), 这里不再挂任何东西 ——
 * 气泡不管挂右上角还是右下角, 只要压在照片上就会糊住脸。 */
.thumb-box { position: relative; }

/* ── 动作入口: 抄光箱标签胶囊 TvTagPill 的 .acts(2026-10-22 用户点名「和光箱的 tag 的展开一样」) ──
 * .more 绝对定位在 .nums 行尾 -> 展开时卡片宽度与网格几何**完全不变**, 不会重演 pill 那条
 * "宽度变了 -> 被 flex-wrap 挤到下一行 -> hover 丢失 -> 收拢弹回 -> 又悬停"的抽搐死循环。
 * .acts 再绝对定位盖在 .more 上方(往左伸出), 底色与卡片同色 -> 视觉上图标滑进来"替换"了 ... */
.more {
  position: absolute; right: 0; top: -3px; bottom: -3px; z-index: 3;
  display: inline-flex; align-items: center;
}
.more-btn {
  height: 17px; min-width: 20px; padding: 0 4px;
  border-radius: var(--r-sm);
  background: transparent; border: 1px solid transparent;
  color: var(--faint); font-size: 11px; line-height: 1;
  transition: color var(--t-fast), border-color var(--t-fast);
}
.ecard:hover .more-btn { color: var(--muted); }
.more-btn:hover { color: var(--accent); border-color: var(--accent); }
/* 已加车 / 正在拉取 -> 常亮: 这两种是"卡片现在的状态", 不能等悬停才看得见 */
.more-btn.is-cart { color: #f2c14e; border-color: rgba(242, 193, 78, .55); }
.more.busy .more-btn { color: var(--accent2); border-color: var(--accent2); }

.acts {
  position: absolute; right: 0; top: 0; bottom: 0; z-index: 4;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 0 1px 0 9px;
  background: var(--panel2);          /* 与卡片同底色, 盖住行尾文字没有接缝 */
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateX(6px);         /* 从右侧轻滑入 */
  transition: transform .18s ease-out, opacity .18s ease-out, visibility .18s;
}
/* 触发范围是 .more 而不是整张卡: 图标条约 77px(4×13 + 3×5 + 左右内边距),
 * 而「26,120 张 239 角色」这一行本身也就 80px —— 若"悬停卡片就展开", 鼠标扫过卡片
 * 就把张数整个盖没了(等于用一个"看不清"换来另一个)。pill 那边同理: 触发的是它自己那段。
 * .acts 是 .more 的子元素 -> 鼠标从入口滑到图标上时 .more:hover 一直保持, 没有断档。 */
.more:hover .acts, .more.open .acts, .acts:focus-within {
  opacity: 1; visibility: visible; pointer-events: auto; transform: none;
}

/* 13px 单色描边图标, currentColor 着色(与光箱标签的 .ic 同一规格)。
 * 文字标签没了 -> 说明一律走 title; 四个 class 名沿用旧版, 测试按它们找元素直接 .click()。 */
.ic {
  display: inline-flex; width: 13px; height: 13px; flex: 0 0 auto;
  background: transparent; color: var(--muted); cursor: pointer;
  transition: color var(--t-fast);
}
.ic svg {
  width: 100%; height: 100%;
  fill: none; stroke: currentColor; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round;
}
.cart-btn:hover, .cover-btn:hover { color: var(--accent); }
.edit-btn:hover { color: var(--warn); }
.fetch-btn:hover { color: var(--accent2); }
/* 已加车时按钮留着并变金色, 再点一次就是取消(SeriesView 走 cart.toggle) */
.cart-btn.on { color: #f2c14e; }
.fetch-btn.busy { color: var(--accent2); cursor: progress; }
.fetch-btn:disabled { opacity: .85; cursor: progress; }

.ckbox {
  position: absolute; top: 8px; left: 8px; z-index: 5;
  width: 22px; height: 22px; border-radius: 5px;
  background: rgba(10, 13, 18, .7);
  display: flex; align-items: center; justify-content: center;
}
.ckbox input { accent-color: var(--accent); width: 14px; height: 14px; pointer-events: none; }

.ph {
  aspect-ratio: 3 / 4;
  position: relative;
  display: flex; align-items: center; justify-content: center;
  background: var(--img-bg);
  flex-direction: column;
  gap: 6px;
}
.ph-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .5; }
.ph-txt {
  position: relative; z-index: 1;
  color: var(--faint); font-size: 11px;
  background: rgba(10, 13, 18, .55);
  padding: 2px 8px; border-radius: 4px;
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
  /* 动作入口(.more)绝对定位在这一行的右端 —— 见上面 .acts 的注释 */
  position: relative;
  display: flex; gap: 8px; font-size: 10px; color: var(--faint); margin-top: 2px;
}
.nums .ch { color: var(--seg-char); }
</style>
