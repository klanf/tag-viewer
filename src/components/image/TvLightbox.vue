<script setup>
/**
 * 大图预览 —— 全站唯一实例, 挂在 App.vue 上
 * ======================================
 * 旧版这套东西(遮罩 + 复制按钮 + 角色/系列区 + 标签区 + ban 切换 + 气泡)
 * 在 index.html / series.html / tags.html / scan.html 各写了一遍,
 * 连 lbTags / lbBanMap / lbNeedsBg 这些全局变量都是四份。
 *
 * 现在数据与动作全在 useLightboxStore 里, 组件只负责渲染:
 *   lightbox.open(path, { list })  ->  本组件自动出现
 *
 * 标签的交互(2026-09-20 调整, 与标签页对齐):
 *   点标签本体   = **跳去该标签的图片子页面**(/tags/xxx, 见 TagImagesView)
 *   点标签上 📋  = 复制这一个标签
 *   点标签上 🚫  = 切换黑名单(通配规则命中的只能去规则里改, 不允许单条取消)
 *   三个动作挤在一个 pill 上, 所以 📋/🚫 都是悬停才显形 —— 与旧版 🚫 的手感一致。
 *
 * 交互(2026-09-18 加):
 *   · 图片区滚轮           -> 上一张 / 下一张(累计阈值 + 冷却, 触控板不会连跳)
 *   · 点图片 / 侧栏        -> 不关闭(点大图特别容易误关, 与侧栏统一;
 *                             侧栏本来就不关, 因为要点标签)
 *   · 点图片四周黑边 / 暗色空白 -> 关闭(2026-09-19: 关闭区域太小, 除图片本体和
 *                             侧栏之外都算可点关区域); 右上角 × 与 Esc 照旧
 *   · ← / → / Esc          -> 翻页 / 关闭
 *   · 底部居中显示 "第 n / 共 m 张", 可点箭头
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import TvButton from '../base/TvButton.vue'
import TvTagList from '../tag/TvTagList.vue'
import TvTagPill from '../tag/TvTagPill.vue'
import TvState from '../base/TvState.vue'
import TvImage from '../base/TvImage.vue'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { usePrefsStore } from '@/stores/usePrefsStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useAppStore } from '@/stores/useAppStore.js'
import { useTagFavStore } from '@/stores/useTagFavStore.js'
import { useImageCtxMenu } from '@/composables/useImageCtxMenu.js'
import { useTrash } from '@/composables/useTrash.js'
import { useCharCart } from '@/composables/useCharCart.js'
import { openTaggerSetup } from '@/composables/useTaggerSetup.js'
import TvCopySplit from '../tag/TvCopySplit.vue'
import TvQuickMoveBar from './TvQuickMoveBar.vue'
import { api, fileUrl } from '@/utils/api.js'

const lb = useLightboxStore()
const ui = useUiStore()
const app = useAppStore()
const router = useRouter()
const charCart = useCharCart()
const tagFav = useTagFavStore()

/* 被 ban 标签的 显示/隐藏(2026-10-16): 选择记忆到设置(showBannedTags, 默认开),
 * 与详情页共用同一个偏好。徽章上的命中数不管藏不藏都显示, 不丢信息。 */
const showBanned = computed(() => app.settings.showBannedTags !== false)
function toggleShowBanned() { app.setSetting('showBannedTags', !showBanned.value) }

/* tag 详情页(大图)同样支持右键菜单(复制/收藏/删除等);
   Del 键删除当前图: 走 useTrash 确认流程(可关提示)。
   删完**不在这里**推进光箱 —— 推进统一由 store 订阅 'tv:trashed' 负责
   (见 useLightboxStore 的 onGone)。这里再调一次 removeCurrent() 会一次跳两张。 */
const ctxMenu = useImageCtxMenu()
const trash = useTrash()
async function delCurrent() {
  if (!lb.visible || !lb.path || trash.state.open) return
  await trash.request([lb.path])
}

const chars = computed(() => lb.data?.char_tags || [])
const series = computed(() => lb.data?.series || [])
const external = computed(() => !!lb.data?.external)
const promptSource = computed(() => lb.data?.prompt_source || '')

/* ── 双 tag 集(2026-10-20): 标签库(反推) | 图内元数据(作者原始提示词) ─────
 * v3 覆盖语义后库里只有反推结果, 图内原始串只能主进程现场读盘(lb.data.meta_*)。
 * 只有图内真有元数据时才出切换; 选择/显示模式记进 settings.json 跨会话生效。
 * meta 模式: 复制走自己的按钮(底部那排过滤复制永远作用于标签库), 无 ban/无跳转。 */
const META_SRC_LABEL = { comfyui: 'ComfyUI', a1111: 'A1111 / Forge', novelai: 'NovelAI', invokeai: 'InvokeAI' }
const hasMeta = computed(() => !!lb.data?.meta_source)
const metaTags = computed(() => lb.data?.meta_tags || [])
const metaPrompt = computed(() => lb.data?.meta_prompt || '')
const metaSrcLabel = computed(() => META_SRC_LABEL[lb.data?.meta_source] || lb.data?.meta_source || '')
const tagSet = computed(() => (hasMeta.value && app.settings.lbTagSet === 'meta') ? 'meta' : 'db')
function setTagSet(v) { app.setSetting('lbTagSet', v) }
const metaMode = computed(() => (app.settings.lbMetaMode === 'raw') ? 'raw' : 'cats')
function setMetaMode(v) { app.setSetting('lbMetaMode', v) }

/* ── meta 词条 -> 标签库命中(2026-10-21) ─────────────────────────
 * 跑图提示词的写法和库内规范化词条对不上(权重括号被剥/空格转下划线/
 * 转义差异), 拿原始词条直接跳 /tags/:xxx 大多落空。打开图片时把 meta
 * 词条整批丢给后端 matchMetaTags(精确 + 骨架两级匹配), 命中的 pill
 * 显示库内图片数、点击跳 /tags/库里真词条(复用现有筛选页); 未命中的
 * 灰化、点击退回复制 —— 多张图各查各的, 竞态用序号防串图。 */
const metaHits = ref({})
let metaHitSeq = 0
watch(() => lb.data?.meta_tags, async (tags) => {
  tags = tags || []
  if (!tags.length) { metaHits.value = {}; return }
  const seq = ++metaHitSeq
  try {
    const d = await api.matchMetaTags(tags)
    if (seq === metaHitSeq) metaHits.value = d.hits || {}
  } catch { if (seq === metaHitSeq) metaHits.value = {} }
}, { immediate: true })
const metaHitCount = computed(() => Object.keys(metaHits.value).length)

function metaJump(tag) {
  const h = metaHits.value[tag]
  if (h?.tag) { gotoTag(h.tag, true); return }
  /* 未命中: pill 是 copy 动作, 点了就复制(与 title 承诺一致) */
  ui.copy(tag).then(() => ui.ok('📋 已复制 · 库内没有这个标签', 'info', 1600))
}

/** 「库内命中 n/m」徽章点击(2026-10-21 三版定稿): 跳命中图片页 /meta-hits。
 *  v1 跳看板塞词条被否(任一命中=全库, 等于没筛); v2 用户澄清要**直接看
 *  命中的图片** —— 落 MetaHitsView, 按「与源图重合词条数」降序, 第一屏
 *  就是库里和这张最像的图。src 传当前图路径(query 传, 免 Windows 路径转义)。 */
function jumpMetaHits() {
  const p = lb.path          // 先取路径: close() 会把 path 清空, 先关后读 src 永远是 ''(2026-10-21 踩)
  if (!metaHitCount.value || !p) return
  lb.close()
  router.push({ name: 'meta-hits', query: { src: p } })
}
async function copyMetaPrompt() { await ui.copy(metaPrompt.value); ui.ok('✅ 已复制图内原始提示词') }
async function copyMetaTags() {
  await ui.copy(metaTags.value.join(', '))
  ui.ok(`✅ 已复制图内标签 ${metaTags.value.length} 个`)
}

/* 点图片区: 点在**图片本体**上不关(2026-09-19 定的, 防误关);
 * 点在四周黑边(letterbox)上算空白 -> 关(2026-09-19 追加: 关闭区域太小)。
 * img 是 object-fit: contain —— 元素盒子铺满整个图片区, 但可见内容只占中间
 * 一块, 所以要按 naturalWidth/Height 把"实际显示的矩形"算出来做命中测试。
 * 翻页按钮/位置指示自己带 @click.stop, 根本不会走到这里。 */
function onImgAreaClick(e) {
  e.stopPropagation()               // 图片区内的点击一律不冒泡到遮罩(遮罩点击=关)
  const img = e.target.closest('img')
  if (!img) { lb.close(); return }
  const r = img.getBoundingClientRect()
  const nw = img.naturalWidth || 0
  const nh = img.naturalHeight || 0
  if (!nw || !nh || !r.width || !r.height) { lb.close(); return }
  const scale = Math.min(r.width / nw, r.height / nh)
  const w = nw * scale
  const h = nh * scale
  const x = e.clientX - (r.left + (r.width - w) / 2)
  const y = e.clientY - (r.top + (r.height - h) / 2)
  if (x < 0 || y < 0 || x > w || y > h) lb.close()
}

/** 角色/系列区: 角色 pill 自己会把 _(系列) 尾巴收起来显示, 悬停看完整 */
const charPills = computed(() => chars.value.map((t) => ({ tag: t, zh: lb.zhMap[t] || '' })))

const seriesPills = computed(() => series.value.map((t) => ({ tag: t, zh: lb.zhMap[t] || '' })))

const noMeta = computed(() => !chars.value.length && !series.value.length)

function copyTag(tag) { ui.copy(tag) }

/* 复制(2026-10-19 二次简化): 主按钮就写「复制」, 按过滤面板的勾选配置复制;
 * 三个快捷档删了 —— 勾选项本身已能表达它们, 菜单里两套入口是重复功能。
 * 勾选状态记在 prefs.lbCopyFilters, 跨会话记忆。 */
const prefs = usePrefsStore()
const cfg = computed(() => prefs.lbCopyFilters)
const copyTitle = computed(() => {
  const on = []
  if (cfg.value.ban) on.push('去ban')
  if (cfg.value.char) on.push('剔角色/系列')
  if (cfg.value.view) on.push('剔视角/机位')
  if (cfg.value.replace) on.push('替换规则')
  if (cfg.value.safe) on.push(`安全标签(${cfg.value.safe_level === 'edge' ? 'edge' : cfg.value.safe_level === 'core' ? 'core' : '跟随全局'})`)
  return on.length ? `按当前过滤复制: ${on.join(' + ')}(下拉可调)` : '复制全部标签(下拉可调过滤)'
})
function doCopy() { lb.copyFiltered(prefs.lbCopyFilters) }

/* 过滤面板里的规则组下拉: 光箱打开时懒加载一次 */
const ruleSets = ref([])
const setsLoaded = ref(false)
watch(() => lb.visible, async (v) => {
  if (!v || setsLoaded.value) return
  setsLoaded.value = true
  const r = await api.replaceSets().catch(() => null)
  ruleSets.value = (r?.sets || []).map((s) => ({ id: s.id, name: s.name }))
})

/**
 * 点标签 = 去该标签的图片**子页面**(与标签页里点标签是同一个入口)。
 *
 * 两件必须做的事:
 *   · 先 lb.close() —— 光箱是 Teleport 到 body 的, 不关就会盖在新路由的页面上
 *   · 库外图片(扫描夹/收藏里那些没进过库的)要打个招呼: 它们自己不在结果里,
 *     跳过去看到的是"标签库中含有这个名字的图", 不说一句会以为是跳错了
 */
function gotoTag(tag, hit = false) {
  if (!tag) return
  const external = !!lb.data?.external
  lb.rememberJump(tag)   // 返回键要恢复光箱(定位到这张图 + 翻页列表), 先记下
  lb.close()
  router.push({ name: 'tag-images', params: { tag } })
  if (external) {
    ui.toast(`「${tag}」· 这张图不在标签库中, 下面是库里含该标签的图`, 'info', 2800)
  } else if (tagSet.value === 'meta' && !hit) {
    // meta 模式的标签来自作者原文, 未必是库里的规范化 tag —— 跳过去可能空列表
    ui.toast(`「${tag}」来自图内元数据 · 库里没有该标签时列表会是空的`, 'info', 2800)
  }
}

/* ---------------- 底部提示/位置指示 息屏(2026-10-08 用户需求) ----------------
   lb-hint(操作提示)和 lb-pos(n/m 指示)常年浮在图片下沿, 静止看图时嫌挡画面。
   手感(三次收敛): 控件**只**因光标进入图片区底部控件带而现形——画面乱晃、
   滚轮/方向键翻页都不惊动; 打开光箱也不再先闪 2.5s, 直接息屏态开局。
   进入底部带停 2.5s 照样淡出; 光标压在可点控件(lb-pos/翻页箭头/×)上不倒计时。 */
const IDLE_HIDE_MS = 2500
const BOTTOM_ZONE = 84    // lb-hint(bottom:48px) 顶缘往上再留余量
const controlsOn = ref(false)
let idleTimer = null

function pokeControls() {
  controlsOn.value = true
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { controlsOn.value = false }, IDLE_HIDE_MS)
}

function onMouseMove(e) {
  // 光标压在控件上: 常驻, 不倒计时(不然正要点箭头它先没了)
  if (e.target?.closest?.('.lb-pos, .lb-nav, .lb-close')) {
    controlsOn.value = true
    clearTimeout(idleTimer)
    return
  }
  // 仅底部控件带算"活动"
  const wrap = e.target?.closest?.('.lb-img-wrap')
  if (wrap && e.clientY >= wrap.getBoundingClientRect().bottom - BOTTOM_ZONE) {
    pokeControls()
    return
  }
  // 其余区域移动: 不现形; 控件若已可见(刚从底部带/sticky 移出), 按正常节奏息屏
  if (controlsOn.value) pokeControls()
}

watch(() => lb.visible, (v) => {
  clearTimeout(idleTimer)
  controlsOn.value = false   // 打开/关闭都从息屏态开局, 现形只归底部控件带管
})

/* ---------------- 滚轮: 翻页 / Ctrl+滚轮缩放(2026-10-20) ----------------
   普通滚轮 = 翻页。触控板一次滑动会连发几十个 wheel 事件(每个 deltaY 很小),
   直接按事件切图会"飞"过去 —— 所以累计到阈值才切一次, 切完进冷却期。
   按住 Ctrl = 调整图片大小(transform scale, 中心为锚, 12% 步进 0.25~6 倍;
   .prevent 已拦掉 Electron 的默认页面缩放)。切图自动复位, 双击图片也复位。 */
const WHEEL_STEP = 55       // 累计到这么多像素算一次翻页
const WHEEL_COOL = 190      // 两次翻页之间的最小间隔(ms)
let wheelAcc = 0
let wheelLock = 0
let wheelTimer = null

const zoom = ref(1)
const zoomStyle = computed(() => (zoom.value === 1 ? null : { transform: `scale(${zoom.value})` }))
watch(() => lb.path, () => { zoom.value = 1 })

function onWheel(e) {
  if (e.ctrlKey) {
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
    zoom.value = Math.min(6, Math.max(0.25, Math.round(zoom.value * f * 100) / 100))
    return
  }
  if (lb.count <= 1) return
  const now = Date.now()
  if (now < wheelLock) return
  wheelAcc += e.deltaY
  // 停手 120ms 没到阈值就清零, 免得慢慢滚攒出一次莫名其妙的跳转
  clearTimeout(wheelTimer)
  wheelTimer = setTimeout(() => { wheelAcc = 0 }, 120)
  if (Math.abs(wheelAcc) < WHEEL_STEP) return
  const dir = wheelAcc > 0 ? 1 : -1
  wheelAcc = 0
  wheelLock = now + WHEEL_COOL
  if (dir > 0) lb.next()
  else lb.prev()
}

/** 双击图片本体 = 复位缩放(点黑边关闭的单击逻辑不受影响) */
function onImgDblClick(e) {
  if (e.target.closest('img') && zoom.value !== 1) zoom.value = 1
}

/* ---------------- 键盘 ---------------- */
function onKey(e) {
  if (!lb.visible) return
  const el = document.activeElement
  const tag = (el?.tagName || '').toLowerCase()
  // 光标在输入框里时不要抢键(搜索框可能还残留焦点)
  if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
  if (e.key === 'Escape') { e.preventDefault(); lb.close() }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); lb.next() }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); lb.prev() }
  else if (e.key === 'Delete') { e.preventDefault(); delCurrent() }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearTimeout(wheelTimer)
  clearTimeout(idleTimer)
})

/* 预热相邻图: 原图走自定义协议流式返回, 提前拉一下翻页就没有空窗 */
function preheat() {
  if (!lb.visible) return
  for (const d of [1, -1]) {
    const i = lb.index + d
    const p = lb.list[i]
    // 跳过"已知消失"的 —— 删/移之后, 视图可能还会把一份刷新中的旧快照推回来,
    // 那时再预热就是在请求一个已经进回收站的文件(控制台留一条 404)
    if (p && !lb.isGone(p)) { const img = new Image(); img.src = fileUrl(p) }
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="lb.visible" class="lightbox" @click="lb.close()" @mousemove="onMouseMove">
      <span class="lb-close" title="关闭 (Esc)" @click.stop="lb.close()">&times;</span>

      <!-- 左右翻页箭头: 挂在图片区内部, 锚定图片两侧 ——
           以前锚定整个视口, 侧栏(标签列表)开着时右箭头正好压在标签上 -->
      <div class="lb-main">
        <div
          class="lb-img-wrap"
          :class="{ idle: !controlsOn }"
          @click="onImgAreaClick"
          @dblclick="onImgDblClick"
          @wheel.prevent="onWheel"
          @contextmenu="ctxMenu.open($event, { path: lb.path, tags: lb.sortedTags, favable: true, favorited: lb.isFav })"
        >
        <button
          v-if="lb.inList"
          class="lb-nav prev"
          :disabled="!lb.canPrev"
          title="上一张 (← / 滚轮上)"
          @click.stop="lb.prev()"
        >&lsaquo;</button>
        <button
          v-if="lb.inList"
          class="lb-nav next"
          :disabled="!lb.canNext"
          title="下一张 (→ / 滚轮下)"
          @click.stop="lb.next()"
        >&rsaquo;</button>

        <!-- 缩放容器: transform scale 中心锚(点黑边关闭的命中测试按 getBoundingClientRect 算, 缩放后依然成立) -->
        <div class="lb-zoom" :style="zoomStyle">
          <!-- 大图: width=0 -> 走 tv://file 原图, 流式返回, 支持 Range -->
          <TvImage :path="lb.path" :width="0" ratio="auto" :alt="lb.path" contain @loaded="preheat" />
        </div>

          <div v-if="lb.inList" class="lb-pos" title="当前图片在列表中的位置" @click.stop>
            <span class="nav" :class="{ off: !lb.canPrev }" @click.stop="lb.prev()">&lsaquo;</span>
            <b>{{ lb.pos }}</b> / {{ lb.count }}
            <span class="nav" :class="{ off: !lb.canNext }" @click.stop="lb.next()">&rsaquo;</span>
          </div>
          <div
            v-if="zoom !== 1"
            class="lb-zoom-badge"
            title="恢复 100%(双击图片也行)"
            @click.stop="zoom = 1"
          >{{ Math.round(zoom * 100) }}%</div>
          <div class="lb-hint">滚轮切换 · Ctrl+滚轮缩放 · Del 删除 · 点击图片和侧栏以外区域关闭</div>
        </div>

        <div class="lb-side" @click.stop>
          <div class="lb-copy-row">
            <TvCopySplit
              :current-title="copyTitle"
              @run="doCopy"
            >
              <template #menu-bottom>
                <div class="cpy-panel">
                  <div class="cpy-sep"></div>
                  <div class="cpy-title" title="勾选状态会记住; 主按钮按这里的配置复制">过滤设置(主按钮按这里复制)</div>
                  <label class="cpy-opt" title="剔除命中黑名单的标签">
                    <input v-model="cfg.ban" type="checkbox"> 去 ban
                  </label>
                  <label class="cpy-opt" title="剔除角色与系列标签(角色库识别)">
                    <input v-model="cfg.char" type="checkbox"> 剔角色/系列
                  </label>
                  <label class="cpy-opt" title="剔除视角/机位词表(data/export_view_tags.txt)命中的标签">
                    <input v-model="cfg.view" type="checkbox"> 剔视角/机位
                  </label>
                  <label class="cpy-opt" title="按替换规则组改写标签(替换产物按分类重排, 与导出一致)">
                    <input v-model="cfg.replace" type="checkbox"> 套用替换规则
                    <select v-if="cfg.replace" v-model="cfg.replace_set" class="cpy-sel">
                      <option value="">默认组</option>
                      <option v-for="s in ruleSets" :key="s.id" :value="s.id">{{ s.name }}</option>
                    </select>
                  </label>
                  <label class="cpy-opt" title="剔除安全词表命中的敏感标签(发帖/分享时用)">
                    <input v-model="cfg.safe" type="checkbox"> 只复制安全标签
                    <select v-if="cfg.safe" v-model="cfg.safe_level" class="cpy-sel">
                      <option value="follow">跟随全局档位</option>
                      <option value="core">core(明确裸露)</option>
                      <option value="edge">edge(再加擦边)</option>
                    </select>
                  </label>
                </div>
              </template>
            </TvCopySplit>
            <TvButton
              size="sm"
              variant="fav"
              :active="lb.isFav"
              :title="lb.isFav ? '取消收藏' : '收藏这张图'"
              @click="lb.toggleFav()"
            >{{ lb.isFav ? '★ 已收藏' : '☆ 收藏' }}</TvButton>
          </div>

          <!-- 快速移动按钮条(2026-09-29): 绑定的路径一排小按钮, 点一下移走当前图并自动前进;
               数字键 1~9 同样触发。移动出口与右键「移动到」同一条(tv:moved 广播)。 -->
          <TvQuickMoveBar :path="lb.path" />

          <div class="lb-path" :title="lb.path">{{ lb.path }}</div>

          <div class="lb-badges">
            <span v-if="external" class="badge" title="这张图不在标签库里, 标签是从图片元数据(PNG tEXt / A1111 / ComfyUI)现场解析的">
              库外图片 · {{ promptSource || '未知来源' }}
            </span>
            <span v-if="lb.needBg && tagSet === 'db'" class="badge warn" title="该图缺背景/场景标签, 复制时会自动追加背景标签">
              🌄 缺背景 · 复制时补 {{ lb.bgAppend.join('/') }}
            </span>
            <!-- ban 命中数: 明确区分「没适配」和「这张图确实没有黑名单词」;
                 旁边挂 显示/隐藏 开关(只在本图有命中时出现)。meta 集没有 ban 体系, 切走就藏 -->
            <span
              v-if="tagSet === 'db' && !lb.loading && lb.bannedTags.length"
              class="badge ban"
              :title="`命中黑名单: ${lb.bannedTags.join(', ')}`"
            >
              🚫 命中黑名单 {{ lb.bannedTags.length }} 个 · 点标签上的 🚫 可单条取消
            </span>
            <label
              v-if="tagSet === 'db' && !lb.loading && lb.bannedTags.length"
              class="ban-vis"
              :title="showBanned ? '隐藏被 ban 的标签' : '显示被 ban 的标签'"
            >
              <input type="checkbox" :checked="showBanned" @change="toggleShowBanned" />
              <span class="sw"></span>显示被 ban 标签
            </label>
            <span
              v-else-if="tagSet === 'db' && !lb.loading && lb.sortedTags.length"
              class="badge dim"
              title="已按 export_blacklist.txt 逐条比对, 本图没有任何标签命中(不是没适配)"
            >
              ✅ 本图无标签命中黑名单
            </span>
          </div>

          <!-- 双 tag 源切换(2026-10-20): 只在图内真有元数据时出现。
               底部那排「复制」永远作用于标签库; meta 集在自己的小节里复制 -->
          <div v-if="!lb.loading && hasMeta" class="lb-src-row">
            <div class="seg" role="tablist">
              <button :class="{ on: tagSet === 'db' }" title="反推入库的规范化 Danbooru 标签(tags.db)" @click="setTagSet('db')">标签库</button>
              <button :class="{ on: tagSet === 'meta' }" :title="`作者写在图里的原始提示词(${metaSrcLabel})`" @click="setTagSet('meta')">图内元数据</button>
            </div>
            <template v-if="tagSet === 'meta'">
              <div class="seg sub" role="tablist">
                <button :class="{ on: metaMode === 'cats' }" title="切成分标签并按段位归类(纯 tag 写法最好看)" @click="setMetaMode('cats')">分类</button>
                <button :class="{ on: metaMode === 'raw' }" title="一字不动展示原始提示词(自然语言/混合写法用)" @click="setMetaMode('raw')">原始</button>
              </div>
            </template>
          </div>

          <TvState v-if="lb.loading" state="loading" size="sm" text="加载标签..." inline />
          <TvState v-else-if="lb.error" state="error" size="sm" :text="lb.error" inline />

          <!-- 图内元数据模式 -->
          <template v-else-if="tagSet === 'meta'">
            <!-- 库内命中独立一行(2026-10-21 用户反馈: 挤在工具行里看不清):
                 点徽章 = 打开命中图片页(按重合词条数排序) -->
            <div v-if="metaMode === 'cats' && metaHitCount" class="meta-hit-row">
              <button
                class="meta-hit"
                type="button"
                :title="`看库里和这张图最像的: 按「重合词条数」降序排列; 单个词条直接点下面的标签`"
                @click="jumpMetaHits"
              >库内命中 {{ metaHitCount }}/{{ metaTags.length }} →</button>
            </div>
            <TvTagList
              v-if="metaMode === 'cats' && metaTags.length"
              class="lb-tags"
              :tags="metaTags"
              :zh-map="lb.zhMap"
              :ban-map="lb.data?.ban_map || {}"
              show-ban
              copyable
              :grouped="app.settings.groupedTags !== false"
              :hit-map="metaHits"
              size="sm"
              empty-text="图内元数据里没解析出标签"
              @click="({ tag }) => metaJump(tag)"
              @copy="copyTag"
              @ban="lb.toggleBan"
              @hover="({ zh, event }) => ui.showTip(zh, event)"
              @leave="ui.hideTip()"
              @mousemove="ui.moveTip($event)"
            />
            <div v-else-if="metaMode === 'cats'" class="lb-nometa">(图内元数据里没解析出标签)</div>
            <div v-else class="raw-wrap">
              <div class="raw-bar">
                <span class="raw-hint">作者原始提示词 · 一字未动</span>
                <TvButton size="sm" @click="copyMetaPrompt">📋 复制原文</TvButton>
              </div>
              <pre class="raw-prompt">{{ metaPrompt || '(空)' }}</pre>
            </div>
          </template>

          <!-- 标签库模式(默认, 与改动前一致) -->
          <template v-else>
            <!-- 角色 / 系列 -->
            <div v-if="!noMeta" class="lb-meta">
              <div v-if="charPills.length" class="lb-meta-row">
                <span class="lb-meta-label">👤 角色</span>
                <TvTagPill
                  v-for="c in charPills"
                  :key="c.tag"
                  :tag="c.tag"
                  :zh="c.zh"
                  variant="char"
                  size="sm"
                  action="filter"
                  copyable
                  cartable
                  :in-cart="charCart.cart.has(c.tag)"
                  @click="gotoTag(c.tag)"
                  @copy="copyTag"
                  @cart="(t) => charCart.toggle(t, c.zh)"
                  @mouseenter="ui.showTip(c.zh, $event)"
                  @mousemove="ui.moveTip($event)"
                  @mouseleave="ui.hideTip()"
                />
              </div>

              <div v-if="seriesPills.length" class="lb-meta-row">
                <span class="lb-meta-label">📂 系列</span>
                <TvTagPill
                  v-for="s in seriesPills"
                  :key="s.tag"
                  :tag="s.tag"
                  :zh="s.zh"
                  variant="series"
                  size="sm"
                  action="filter"
                  copyable
                  @click="gotoTag(s.tag)"
                  @copy="copyTag"
                  @mouseenter="ui.showTip(s.zh, $event)"
                  @mousemove="ui.moveTip($event)"
                  @mouseleave="ui.hideTip()"
                />
              </div>
            </div>
            <div v-else class="lb-nometa">(未识别出系列/角色)</div>

            <!-- 全部标签: 分组(设置可关)时按段位小节; 点标签=去看该标签的图, 📋=复制, 🚫=切换黑名单 -->
            <TvTagList
              class="lb-tags"
              :tags="lb.sortedTags"
              :zh-map="lb.zhMap"
              :ban-map="lb.data?.ban_map || {}"
              show-ban
              :hide-banned="!showBanned"
              copyable
              favable
              :fav-tags="tagFav.list"
              :grouped="app.settings.groupedTags !== false"
              chars-first
              action="filter"
              size="sm"
              @click="({ tag }) => gotoTag(tag)"
              @copy="copyTag"
              @ban="lb.toggleBan"
              @fav="tagFav.toggle"
              @hover="({ zh, event }) => ui.showTip(zh, event)"
              @leave="ui.hideTip()"
              @mousemove="ui.moveTip($event)"
            />
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed; inset: 0; z-index: 300;
  background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.lb-close {
  position: absolute; top: 12px; right: 20px; z-index: 4;
  font-size: 34px; line-height: 1; color: #fff; opacity: .7;
  cursor: pointer; user-select: none;
}
.lb-close:hover { opacity: 1; }

/* 左右翻页箭头: 挂在 .lb-img-wrap(图片区)里, 只浮在图片两侧, 不会压到右侧标签栏 */
.lb-nav {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 4;
  width: 52px; height: 88px; border-radius: 12px;
  background: rgba(10, 13, 18, .55); color: #fff;
  font-size: 40px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; user-select: none;
  transition: background var(--t-fast), opacity var(--t-fast);
}
.lb-nav:hover:not(:disabled) { background: rgba(10, 13, 18, .85); }
.lb-nav:disabled { opacity: .18; cursor: default; }
.lb-nav.prev { left: 34px; }
.lb-nav.next { right: 34px; }

.lb-main {
  display: flex; gap: 16px;
  width: 100%; height: 100%;
  max-width: 1800px;
  min-height: 0;
}

.lb-img-wrap {
  position: relative;
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;   /* Ctrl+滚轮放大后超出图片区的部分裁掉, 不压到侧栏/箭头 */
  /* 2026-09-19: 点图片不再关闭(容易误关), 所以去掉原来的 zoom-out 光标 */
}
.lb-zoom { width: 100%; height: 100%; }
.lb-zoom-badge {
  position: absolute; top: 10px; left: 12px; z-index: 5;
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  background: rgba(0, 0, 0, 0.55); color: #fff; cursor: pointer;
}
/* 大图不裁切、不撑破容器 */
.lb-img-wrap :deep(.tv-img) {
  width: 100%; height: 100%;
  background: transparent;
}
.lb-img-wrap :deep(img) { object-fit: contain; }

/* 位置指示: 图片底部居中 */
.lb-pos {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  background: rgba(10, 13, 18, .72); color: #fff;
  font-size: 12px; padding: 4px 12px; border-radius: 999px;
  user-select: none;
  transition: opacity .35s ease;
}
.lb-pos b { font-size: 13px; }
.lb-pos .nav {
  cursor: pointer; opacity: .85; font-size: 17px; line-height: 1;
  padding: 0 2px;
}
.lb-pos .nav:hover { opacity: 1; }
.lb-pos .nav.off { opacity: .25; cursor: default; }

.lb-hint {
  position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%);
  color: #fff; opacity: .42; font-size: 11px;
  pointer-events: none; user-select: none; white-space: nowrap;
  transition: opacity .35s ease;
}

/* 息屏(2026-10-08): 光标进入底部控件带才现形, 带内静止 2.5s 后淡出。
   lb-pos 隐藏时连 pointer-events 一起收掉, 防止"看不见但挡着点" */
.lb-img-wrap.idle .lb-pos { opacity: 0; pointer-events: none; }
.lb-img-wrap.idle .lb-hint { opacity: 0; }

.lb-side {
  flex: 0 0 var(--side-w);
  width: var(--side-w);
  display: flex; flex-direction: column; gap: 8px;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 12px;
}

.lb-copy-row { display: flex; gap: 6px; flex-wrap: wrap; }
/* 复制(两截按钮)与收藏等宽: 都是 1 1 0 平分整行, split 内部再让主按钮吃满 */
.lb-copy-row :deep(.copy-split),
.lb-copy-row :deep(.tv-btn) { flex: 1 1 0; }
.lb-copy-row :deep(.cs-main) { flex: 1 1 auto; }

/* 复制过滤设置面板(TvCopySplit 菜单底部插槽, 2026-10-19) */
.lb-copy-row :deep(.cs-menu) { min-width: 250px; }
.cpy-panel { padding: 4px 6px 6px; user-select: none; }
.cpy-sep { border-top: 1px solid var(--border); margin: 5px 2px; }
.cpy-title {
  font-size: 10px; color: var(--faint); margin: 2px 2px 5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cpy-opt {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text);
  padding: 4px 2px; cursor: pointer; border-radius: 4px;
  white-space: nowrap;
}
.cpy-opt:hover { background: var(--accent-soft); }
.cpy-opt input[type='checkbox'] { accent-color: var(--accent); margin: 0; flex: 0 0 auto; }
.cpy-sel {
  margin-left: auto; max-width: 130px;
  font-size: 11px; padding: 2px 4px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px;
}

.lb-path {
  font-size: 10px; color: var(--faint); word-break: break-all;
  line-height: 1.5;
  /* 2026-10-17: 去掉 max-height 截断 —— 长路径之前在 46px 处被拦腰剪断,
     用户看到"路径被遮盖住一半"。完整换行显示, 高度交给侧栏弹性布局消化。 */
}
.lb-badges { display: flex; flex-direction: column; gap: 4px; }
.badge {
  font-size: 10px; padding: 3px 7px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent);
}
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.ban { background: var(--danger-soft, rgba(239, 68, 68, .14)); color: var(--danger); }
.badge.dim { background: var(--panel3); color: var(--muted); }
/* 来源徽章(2026-10-18): 反推入库高亮, 自带/历史合并/手工导入走低调灰 */
.badge.src { align-self: flex-start; }
.badge.src[data-src='wd14'] { background: var(--accent-soft); color: var(--accent); }
.badge.src[data-src='meta'],
.badge.src[data-src='meta+wd14'],
.badge.src[data-src='legacy'] { background: var(--panel3); color: var(--muted); }
/* T2 兜底: 无标签图的小字入口 —— 虚线框弱化, 点击打开安装引导 */
a.badge.hint {
  background: var(--panel3); color: var(--accent);
  text-decoration: none; border: 1px dashed var(--border);
  cursor: pointer; align-self: flex-start;
}
a.badge.hint:hover { border-color: var(--accent); }
/* 被 ban 标签 显示/隐藏 开关(2026-10-16): 迷你 switch, 与徽章同排 */
.ban-vis {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; color: var(--muted);
  cursor: pointer; user-select: none; flex: 0 0 auto;
}
.ban-vis input { display: none; }
.ban-vis .sw {
  width: 22px; height: 12px; border-radius: 6px; background: var(--border);
  position: relative; transition: background var(--t-fast); flex: 0 0 auto;
}
.ban-vis .sw::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 8px; height: 8px; border-radius: 50%; background: #fff;
  transition: left var(--t-fast);
}
.ban-vis:has(input:checked) .sw { background: var(--accent2, #2f9e63); }
.ban-vis:has(input:checked) .sw::after { left: 12px; }

.lb-meta { display: flex; flex-direction: column; gap: 6px; }
.lb-meta-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.lb-meta-label { font-size: 11px; color: var(--muted); flex: 0 0 auto; }
.lb-nometa { font-size: 11px; color: var(--muted); }

/* 双 tag 源切换(2026-10-20): 一排分段按钮, 与设置页开关同一套观感 */
.lb-src-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg {
  display: inline-flex; border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; flex: 0 0 auto;
}
.seg button {
  border: none; background: transparent; color: var(--muted);
  font-size: 12px; padding: 4px 11px; cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--accent-soft, rgba(59, 130, 246, .15)); color: var(--accent); font-weight: 500; }
.seg.sub button { padding: 3px 9px; font-size: 11px; }
.src-name { font-size: 11px; color: var(--muted); }
/* 库内命中行(2026-10-21): 独立一行不跟工具行挤; 徽章是按钮 —— 点了进命中图片页 */
.meta-hit-row {
  display: flex; align-items: center; gap: 8px;
  flex: 0 0 auto; padding: 2px 0;
}
.meta-hit {
  font-size: 11px; color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 999px; padding: 2px 10px; white-space: nowrap;
  background: transparent; cursor: pointer;
  transition: background var(--t-fast), border-color var(--t-fast);
}
.meta-hit:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }

/* 原始模式: 等宽整段展示, 一字未动 */
.raw-wrap { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.raw-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.raw-hint { font-size: 11px; color: var(--muted); }
.raw-prompt {
  margin: 0; padding: 10px 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
  font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap; word-break: break-word;
  overflow: auto; min-height: 0; flex: 1 1 auto;
  user-select: text; cursor: text;
}

.lb-tags {
  flex: 1 1 auto; min-height: 0;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  align-content: flex-start;
  overflow-y: auto;
}
</style>
