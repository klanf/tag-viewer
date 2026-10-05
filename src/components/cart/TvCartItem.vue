<script setup>
/**
 * 购物车条目 —— 抽屉与购物车页共用
 * ==============================
 * 旧版这段 innerHTML 在 series.html 的 renderCart() 和 cart.html 的 render() 里
 * 各写了一遍, 连缩略图宽度(200)都要对两次。
 *
 * 缩略图自愈(2026-10-02 用户两点要求):
 *   ① 加载失败(文件被移走/删了, 卡片挂 ⚠) -> 按标签搜一批候选图, 逐张换着试,
 *      成功一张就 setThumb 写回 store —— 下次进来直接就是好图;
 *   ② 当前 thumb 是横图 -> 有真竖图(h > w)就换成最接近 3:4 的那张并写回
 *     ("默认最好显示竖图")。候选挑选与后端 coverIdx 同判据(|w/h - 0.75| 最小)。
 * 搜索走标签详情页同一出口 api.search({ q: tag, match: 'contains' }), 每个条目
 * 只在"需要换图"时才发一次请求并缓存候选, 不是常驻轮询。
 */
import { ref, computed, watch } from 'vue'
import TvImage from '../base/TvImage.vue'
import { api } from '@/utils/api.js'
import { useCartStore } from '@/stores/useCartStore.js'

const cart = useCartStore()

const props = defineProps({
  item: { type: Object, required: true },
  /** 紧凑模式(抽屉里用, 横向排列) */
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['remove', 'open', 'edit'])

/** 当前实际展示的缩略图: 默认跟 item.thumb, 主动换图后以本地为准 */
const cur = ref(props.item.thumb || '')
const rootEl = ref(null)
let swapped = false          // 本会话已主动换过(防"换完又评估"循环)
let cands = null             // 候选缓存: 懒取一次
let ci = 0                   // 失败轮换游标(候选里第几张)
let swapping = false         // onLoaded/onFailed 共用锁

watch(() => props.item.thumb, (v) => { if (!swapped) cur.value = v || '' })

const thumb = computed(() => cur.value)
/** 附加标签(如给哥伦比亚追加 closed_eyes): 有就显示在系列行里, 让"这行导出会带啥"一眼可见 */
const extras = computed(() => (Array.isArray(props.item.extra) ? props.item.extra : []))

/* ---- 候选图 ---- */
async function fetchCands() {
  if (cands) return cands
  try {
    const d = await api.search({ q: props.item.tag, match: 'contains', limit: 60 })
    cands = (d?.results || []).filter((r) => r?.path)
  } catch { cands = [] }
  return cands
}
/** 在候选里挑"最接近 3:4 的真竖图"(h 必须 > w, 否则宁可不换) */
function bestPortrait(exclude) {
  let best = ''
  let bs = Infinity
  for (const r of cands || []) {
    const w = Number(r.px_w) || 0
    const h = Number(r.px_h) || 0
    if (!(w > 0 && h > 0) || h <= w || r.path === exclude) continue
    const s = Math.abs(w / h - 0.75)
    if (s < bs) { bs = s; best = r.path }
  }
  return best
}
function commitSwap(p) {
  swapped = true
  cur.value = p
  cart.setThumb(props.item.tag, p)   // 写回: 下次进来直接就是这张, 不用再搜
}

/** 图片加载成功: 已经是竖图/方图就不折腾; 横图才尝试换竖图 */
async function onLoaded() {
  if (swapped || swapping) return
  const img = rootEl.value?.querySelector('img')
  const w = img?.naturalWidth || 0
  const h = img?.naturalHeight || 0
  if (!w || !h || h >= w) return
  swapping = true
  try {
    await fetchCands()
    const p = bestPortrait(cur.value)
    if (p) commitSwap(p)
  } finally { swapping = false }
}

/** 图片加载失败(重试 2 次后): 换下一张候选; 一张都没有就空占位, 别挂着 ⚠ */
async function onFailed() {
  if (swapping) return
  swapping = true
  try {
    const list = await fetchCands()
    while (ci < list.length) {
      const p = list[ci++].path
      if (p === cur.value) continue
      commitSwap(p)
      return                          // 换上了, 成败交给下一轮 loaded/failed
    }
    cur.value = ''
  } finally { swapping = false }
}
</script>

<template>
  <div :class="['ci', { compact }]" :title="item.tag" @click="emit('open', item)">
    <div ref="rootEl" class="thumb">
      <TvImage
        v-if="thumb"
        :path="thumb"
        :width="200"
        ratio="9 / 16"
        :alt="item.name"
        @loaded="onLoaded"
        @failed="onFailed"
      />
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
