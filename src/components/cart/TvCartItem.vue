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
 *
 * 安全模式(2026-10-06): 🛡 开着时, 若当前 thumb 是会被藏的图, 就地换成候选里
 * 第一张可见的 —— **只换显示, 不写回**(展示层过滤, 关掉安全模式原图就回来);
 * 候选里一张可见的都没有就显示默认占位封面。搜索结果自带 unsafe 标记, 判定
 * 与其它页面同一份口径(safety.isHidden)。
 * 同轮补两处(用户反馈"封面要竖图、要符合安全模式"):
 *   ① 自愈换图(横图换竖图/失败轮换)原来**不看安全**, 会把被藏的图写回 store
 *      -> 挑候选时先把会被藏的剔掉(安全开着才剔, 关着行为不变);
 *   ② 光箱/标签页 pill 入车的条目**没有 thumb**, 一直是占位图 -> 进购物车后
 *      补挑一次(同判据: 最接近 3:4 的真竖图), 挑到就写回。
 * 中文名兜底(2026-10-06): 系列页入车时 name 存的是英文短名(charShortName),
 * 翻译在视图层没跟过来 -> 显示时按 tag 现查一次翻译库(存量条目也吃到)。
 * 横图残留的三个根因(2026-10-06 第二次反馈): ①候选池只有 60 张(按路径排),
 * 池里可能一张竖图都没有 -> 扩到 200; ②安全模式的显示换图取"第一张可见的",
 * 不管横竖 -> 改成可见池里也挑竖图; ③(历史)自愈不看安全, 已在上一轮修。
 * 换封面 🖼(2026-10-06): 复用系列页的 TvCoverPickerModal(kind='chars'),
 * 点一张 = 设为该角色的自定义封面(系列页角色卡同步换), 购物车 thumb 同步写回;
 * 恢复自动挑选 = 清自定义封面 + 清 thumb 重新按竖图补挑。
 */
import { ref, computed, watch, onMounted } from 'vue'
import TvImage from '../base/TvImage.vue'
import TvCoverPickerModal from '../series/TvCoverPickerModal.vue'
import { api } from '@/utils/api.js'
import { stripZhSeries } from '@/utils/format.js'
import { useCartStore } from '@/stores/useCartStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import coverDefault from '@/assets/cover-default.svg'

const cart = useCartStore()
const safety = useSafetyStore()

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
let safetySwapped = false    // 安全模式换过显示图(期间 onLoaded/onFailed 别插手)
let cands = null             // 候选缓存: 懒取一次
let ci = 0                   // 失败轮换游标(候选里第几张)
let swapping = false         // onLoaded/onFailed 共用锁

watch(() => props.item.thumb, (v) => { if (!swapped) cur.value = v || '' })

const thumb = computed(() => cur.value)

/* ---- 安全模式: 封面是被藏的图就换成可见的(只换显示) ---- */
async function applySafetyThumb() {
  if (!safety.on) {
    if (safetySwapped) { safetySwapped = false; if (!swapped) cur.value = props.item.thumb || '' }
    return
  }
  if (!cur.value) return                 // 已经是占位
  const list = await fetchCands()
  const hit = list.find((r) => r.path === cur.value)
  if (hit && !safety.isHidden(hit)) return
  const safe = list.filter((r) => !safety.isHidden(r))
  safetySwapped = true
  // 换上的显示图也要**竖图优先**(2026-10-06 用户实测: 换成了第一张可见的, 结果是横图)
  cur.value = bestPortraitOf(safe, cur.value) || safe[0]?.path || ''
  //                                        ^ 一张可见的都没有 -> 空串 = 默认占位封面
}
watch(() => `${safety.on}|${safety.level}`, applySafetyThumb)

/* ---- 中文名兜底: 入车时的 name 可能是英文短名, 显示时现查一次翻译 ---- */
const nameZh = ref('')
onMounted(async () => {
  /* 挂载时 🛡 可能**已经开着** —— watch 不带 immediate 不会开火, 而购物车 thumb
   * 是直连文件 URL, 不像网格走搜索过滤, 被藏的图会原样显示出来(2026-10-06
   * 用户质询抓到的回归: 第七轮改 onMounted 时把这条检查弄丢过)。 */
  await applySafetyThumb()
  healEmpty()
  const tag = props.item.tag
  if (!tag) return
  try {
    const m = await api.translate([tag])
    const zh = stripZhSeries(m?.[tag] || '')
    if (zh && zh !== tag) nameZh.value = zh
  } catch { /* 没翻译库也能用 */ }
})
/** 附加标签(如给哥伦比亚追加 closed_eyes): 有就显示在系列行里, 让"这行导出会带啥"一眼可见 */
const extras = computed(() => (Array.isArray(props.item.extra) ? props.item.extra : []))

/* ---- 候选图 ---- */
async function fetchCands() {
  if (cands) return cands
  try {
    // 200 与后端 covers:candidates 的 CAP 同档: 60 张按路径排前 60 的池子
    // 经常一张竖图都没有, 换竖图就"永远换不动"(2026-10-06 用户实测横图残留的根因之一)。
    // exists=1: 磁盘上已不存在的图不当候选 —— 换上去就是一张 404。
    const d = await api.search({ q: props.item.tag, match: 'contains', limit: 200, exists: 1 })
    cands = (d?.results || []).filter((r) => r?.path)
  } catch { cands = [] }
  return cands
}
/** 候选挑选池: 安全模式开着时, 会被藏的图不参与挑选(别把看不见的图写回 store) */
function visibleCands() {
  if (!safety.on || !cands) return cands || []
  return cands.filter((r) => !safety.isHidden(r))
}
/** 在指定池里挑"最接近 3:4 的真竖图"(h 必须 > w, 否则宁可不换) */
function bestPortraitOf(pool, exclude) {
  let best = ''
  let bs = Infinity
  for (const r of pool) {
    const w = Number(r.px_w) || 0
    const h = Number(r.px_h) || 0
    if (!(w > 0 && h > 0) || h <= w || r.path === exclude) continue
    const s = Math.abs(w / h - 0.75)
    if (s < bs) { bs = s; best = r.path }
  }
  return best
}
function bestPortrait(exclude) {
  return bestPortraitOf(visibleCands(), exclude)
}
function commitSwap(p) {
  swapped = true
  cur.value = p
  cart.setThumb(props.item.tag, p)   // 写回: 下次进来直接就是这张, 不用再搜
}

/* ---- 手动换封面(2026-10-06, 与系列页 🖼 同款) ----
 * 挑选窗复用 TvCoverPickerModal(kind='chars'): 候选与系列页同口径(来源过滤 +
 * 安全档位过滤), 点一张 = 设为该角色的自定义封面(custom_covers.chars) ——
 * **系列页的角色卡与购物车一起换**(用户认可的统一口径), 购物车这边同步写回 thumb。
 * 「恢复自动挑选」清掉自定义封面后, 购物车清 thumb 重新按竖图补挑。 */
const showCover = ref(false)
function onCoverSaved(p) {
  if (p) { commitSwap(p); return }
  cart.clearThumb(props.item.tag)
  swapped = false
  safetySwapped = false
  ci = 0
  cands = null
  cur.value = ''
  healEmpty()
}

/** 图片加载成功: 已经是竖图/方图就不折腾; 横图才尝试换竖图。
 *  ⚠️ 安全模式换上的显示图不参与自愈(那是展示层的事, 别把它的选择写回 store) */
async function onLoaded() {
  if (swapped || swapping || safetySwapped) return
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

/** 无封面补挑: pill 入车的条目没有 thumb(一直占位图), 进购物车后补挑一次 */
async function healEmpty() {
  if (cur.value || swapped) return
  swapping = true
  try {
    await fetchCands()
    const p = bestPortrait('')
    if (p) commitSwap(p)
  } finally { swapping = false }
}

/** 图片加载失败(重试 2 次后): 换下一张候选; 一张都没有就空占位, 别挂着 ⚠ */
async function onFailed() {
  if (swapping || safetySwapped) return
  swapping = true
  try {
    const list = await fetchCands()
    while (ci < list.length) {
      const r = list[ci++]
      if (safety.on && safety.isHidden(r)) continue   // 被藏的图不换上来
      if (r.path === cur.value) continue
      commitSwap(r.path)
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
      <div v-else class="ph">
        <img :src="coverDefault" alt="" class="ph-img">
        <span class="ph-txt">封面已隐藏</span>
      </div>
    </div>
    <div class="info">
      <div class="name">{{ nameZh || item.name || item.tag }}</div>
      <div class="meta">
        <span v-if="item.series" class="series">{{ item.series }}</span>
        <b>{{ item.images }}</b> 张
        <span v-if="extras.length" class="extras" :title="`导出时附加: ${extras.join(', ')}`">＋{{ extras.join(' ＋') }}</span>
      </div>
    </div>
    <button class="edit" title="编辑附加标签(导出时拼在这一行后面)" @click.stop="emit('edit', item)">✏️</button>
    <button class="cover" title="换这张封面图" @click.stop="showCover = true">🖼️</button>
    <button class="del" title="从购物车移除" @click.stop="emit('remove', item.tag)">✕</button>
    <TvCoverPickerModal
      v-model="showCover"
      kind="chars"
      :entity-key="item.tag"
      :series="item.series || ''"
      :title="nameZh || item.name || item.tag"
      :current="cur"
      @saved="onCoverSaved"
    />
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

.ph { aspect-ratio: 9 / 16; background: var(--img-bg); position: relative; }
.ph-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .5; }
.ph-txt {
  position: absolute; z-index: 1; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  color: var(--faint); font-size: 11px; white-space: nowrap;
  background: rgba(10, 13, 18, .55);
  padding: 2px 8px; border-radius: 4px;
}

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

/* 换封面按钮: 与 ✏️/✕ 同排再往左一格(与系列卡 🖼 的布局呼应) */
.cover {
  position: absolute; top: 6px; right: 62px;
  width: 24px; height: 24px; border-radius: 5px;
  background: rgba(10, 13, 18, .85);
  font-size: 12px; line-height: 1;
  opacity: 0; transition: opacity var(--t-fast);
}
.ci:hover .cover { opacity: 1; }
.cover:hover { background: var(--accent); }
.ci.compact .cover { position: static; flex: 0 0 auto; opacity: .55; background: transparent; }
.ci.compact .cover:hover { opacity: 1; }

.extras {
  display: inline-block; max-width: 100%;
  color: var(--accent2); font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  vertical-align: bottom;
}
</style>
