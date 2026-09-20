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
 *   点标签本体   = **跳去标签页看这个标签的图片**(/tags?tag=xxx)
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
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import TvButton from '../base/TvButton.vue'
import TvTagList from '../tag/TvTagList.vue'
import TvTagPill from '../tag/TvTagPill.vue'
import TvState from '../base/TvState.vue'
import TvImage from '../base/TvImage.vue'
import { useLightboxStore } from '@/stores/useLightboxStore.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { useImageCtxMenu } from '@/composables/useImageCtxMenu.js'
import { useTrash } from '@/composables/useTrash.js'
import { fileUrl } from '@/utils/api.js'

const lb = useLightboxStore()
const ui = useUiStore()
const router = useRouter()

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

/**
 * 点标签 = 去标签页看这个标签的图片(与标签页里点标签是同一个入口)。
 *
 * 两件必须做的事:
 *   · 先 lb.close() —— 光箱是 Teleport 到 body 的, 不关就会盖在新路由的页面上
 *   · 库外图片(扫描夹/收藏里那些没进过库的)要打个招呼: 它们自己不在结果里,
 *     跳过去看到的是"标签库中含有这个名字的图", 不说一句会以为是跳错了
 */
function gotoTag(tag) {
  if (!tag) return
  const external = !!lb.data?.external
  lb.close()
  router.push({ path: '/tags', query: { tag } })
  if (external) {
    ui.toast(`「${tag}」· 这张图不在标签库中, 下面是库里含该标签的图`, 'info', 2800)
  }
}

/* ---------------- 滚轮翻页 ----------------
   触控板一次滑动会连发几十个 wheel 事件(每个 deltaY 很小), 直接按事件切图会"飞"过去。
   所以累计到阈值才切一次, 切完进冷却期 —— 与大多数看图软件的手感一致。 */
const WHEEL_STEP = 55       // 累计到这么多像素算一次翻页
const WHEEL_COOL = 190      // 两次翻页之间的最小间隔(ms)
let wheelAcc = 0
let wheelLock = 0
let wheelTimer = null

function onWheel(e) {
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
    <div v-if="lb.visible" class="lightbox" @click="lb.close()">
      <span class="lb-close" title="关闭 (Esc)" @click.stop="lb.close()">&times;</span>

      <!-- 左右翻页箭头: 挂在图片区内部, 锚定图片两侧 ——
           以前锚定整个视口, 侧栏(标签列表)开着时右箭头正好压在标签上 -->
      <div class="lb-main">
        <div
          class="lb-img-wrap"
          @click="onImgAreaClick"
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

        <!-- 大图: width=0 -> 走 tv://file 原图, 流式返回, 支持 Range -->
        <TvImage :path="lb.path" :width="0" ratio="auto" :alt="lb.path" contain @loaded="preheat" />

          <div v-if="lb.inList" class="lb-pos" title="当前图片在列表中的位置" @click.stop>
            <span class="nav" :class="{ off: !lb.canPrev }" @click.stop="lb.prev()">&lsaquo;</span>
            <b>{{ lb.pos }}</b> / {{ lb.count }}
            <span class="nav" :class="{ off: !lb.canNext }" @click.stop="lb.next()">&rsaquo;</span>
          </div>
          <div class="lb-hint">滚轮 / ← → 切换 · Del 删除 · 点击图片和侧栏以外区域关闭</div>
        </div>

        <div class="lb-side" @click.stop>
          <div class="lb-copy-row">
            <TvButton size="sm" variant="primary" title="只复制普通标签(剔除角色/系列)" @click="lb.copyPlain()">
              📋 复制全部标签
            </TvButton>
            <TvButton size="sm" variant="secondary" title="复制普通标签, 剔除被 ban 的(与导出一致)" @click="lb.copyNoBan()">
              🚫 去ban
            </TvButton>
            <TvButton size="sm" variant="secondary" title="复制完整标签(含角色/系列)" @click="lb.copyRaw()">
              含角色
            </TvButton>
            <TvButton
              size="sm"
              variant="fav"
              :active="lb.isFav"
              :title="lb.isFav ? '取消收藏' : '收藏这张图'"
              @click="lb.toggleFav()"
            >{{ lb.isFav ? '★ 已收藏' : '☆ 收藏' }}</TvButton>
          </div>

          <div class="lb-path" :title="lb.path">{{ lb.path }}</div>

          <div class="lb-badges">
            <span v-if="external" class="badge" title="这张图不在标签库里, 标签是从图片元数据(PNG tEXt / A1111 / ComfyUI)现场解析的">
              库外图片 · {{ promptSource || '未知来源' }}
            </span>
            <span v-if="lb.needBg" class="badge warn" title="该图缺背景/场景标签, 复制时会自动追加背景标签">
              🌄 缺背景 · 复制时补 {{ lb.bgAppend.join('/') }}
            </span>
            <!-- ban 命中数: 明确区分「没适配」和「这张图确实没有黑名单词」 -->
            <span
              v-if="!lb.loading && lb.bannedTags.length"
              class="badge ban"
              :title="`命中黑名单: ${lb.bannedTags.join(', ')}`"
            >
              🚫 命中黑名单 {{ lb.bannedTags.length }} 个 · 点标签上的 🚫 可单条取消
            </span>
            <span
              v-else-if="!lb.loading && lb.sortedTags.length"
              class="badge dim"
              title="已按 export_blacklist.txt 逐条比对, 本图没有任何标签命中(不是没适配)"
            >
              ✅ 本图无标签命中黑名单
            </span>
          </div>

          <TvState v-if="lb.loading" state="loading" size="sm" text="加载标签..." inline />
          <TvState v-else-if="lb.error" state="error" size="sm" :text="lb.error" inline />

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
                  @click="gotoTag(c.tag)"
                  @copy="copyTag"
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

            <!-- 全部标签: 角色在前; 点标签=去看该标签的图, 📋=复制, 🚫=切换黑名单 -->
            <TvTagList
              class="lb-tags"
              :tags="lb.sortedTags"
              :zh-map="lb.zhMap"
              :ban-map="lb.data?.ban_map || {}"
              show-ban
              copyable
              chars-first
              action="filter"
              size="sm"
              @click="({ tag }) => gotoTag(tag)"
              @copy="copyTag"
              @ban="lb.toggleBan"
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
  /* 2026-09-19: 点图片不再关闭(容易误关), 所以去掉原来的 zoom-out 光标 */
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
}

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
.lb-copy-row :deep(.tv-btn) { flex: 1 1 auto; }

.lb-path {
  font-size: 10px; color: var(--faint); word-break: break-all;
  line-height: 1.5; max-height: 46px; overflow: auto;
}
.lb-badges { display: flex; flex-direction: column; gap: 4px; }
.badge {
  font-size: 10px; padding: 3px 7px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent);
}
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.ban { background: var(--danger-soft, rgba(239, 68, 68, .14)); color: var(--danger); }
.badge.dim { background: var(--panel3); color: var(--muted); }

.lb-meta { display: flex; flex-direction: column; gap: 6px; }
.lb-meta-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.lb-meta-label { font-size: 11px; color: var(--muted); flex: 0 0 auto; }
.lb-nometa { font-size: 11px; color: var(--muted); }

.lb-tags {
  flex: 1 1 auto; min-height: 0;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  align-content: flex-start;
  overflow-y: auto;
}
</style>
