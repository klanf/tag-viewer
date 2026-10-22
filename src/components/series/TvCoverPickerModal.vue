<script setup>
/**
 * 封面挑选弹窗 —— 系列卡 / 角色卡的「🖼 自定义封面」（2026-10-06）
 * 「网上挑」页签（2026-10-22）：本地图不够用的角色（库里有角色名但一张图都没有），
 * 在这里直接去 Danbooru / Safebooru 搜该角色 → 点中意的一张 → 主进程下载原图落
 * data/char_covers/user_picks/ → 走和本地挑图完全相同的 coverSet 保存链路。
 *   · 候选由主进程 covers:candidates 给出 —— 与列表页同口径: 来源过滤照常,
 *     安全模式开着时只返回该档位下可见的图(用户拍板: 挑选窗只出安全图)。
 *   · 当前是自定义封面时, 候选里对应那张会打上「当前」标记; 「恢复默认」
 *     清掉覆盖, 回到自动挑选(安全感知的比例择优)。
 *   · 保存成功后 emit('saved'), 父组件负责刷新列表拿新封面。
 *   · 「网上挑」默认页签仍是本地: 打开弹窗就自动搜远端既慢又白跑, 也让既有
 *     的本地候选断言(DOM 结构)发生变化 —— 远端只在点到那个页签时才请求。
 */
import { ref, watch, computed } from 'vue'
import TvModal from '../base/TvModal.vue'
import TvButton from '../base/TvButton.vue'
import TvState from '../base/TvState.vue'
import TvImage from '../base/TvImage.vue'
import { api, remoteImageUrl } from '@/utils/api.js'
import { useUiStore } from '@/stores/useUiStore.js'
import { nfmt } from '@/utils/format.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 'series' | 'chars' */
  kind: { type: String, default: 'series' },
  /** 系列名 / 角色代表 tag */
  entityKey: { type: String, default: '' },
  /** chars 时必传: 角色所在的系列(候选与角色卡同口径) */
  series: { type: String, default: '' },
  /** 弹窗标题里显示的名字 */
  title: { type: String, default: '' },
  /** 与页面同一份来源过滤 */
  source: { type: String, default: '' },
  /** 当前的封面路径(用于在候选里标「当前」; 自动挑选的封面也传进来) */
  current: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const ui = useUiStore()
const tab = ref('local')
const loading = ref(false)
const error = ref('')
const items = ref([])
const total = ref(0)
const capped = ref(false)
const busy = ref('')

const head = computed(() => `🖼 自定义封面 — ${props.title || (props.kind === 'series' ? '系列' : '角色')}`)

async function load() {
  if (!props.entityKey) return
  loading.value = true
  error.value = ''
  try {
    const d = await api.coverCandidates({
      kind: props.kind,
      key: props.entityKey,
      series: props.series,
      source: props.source || undefined,
    })
    items.value = d.candidates || []
    total.value = d.total || 0
    capped.value = !!d.capped
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (v) => {
  if (!v) return
  tab.value = 'local'
  webError.value = ''
  webPosts.value = []
  webSearched.value = false
  webPage.value = 1
  /* 搜索框预填该角色/系列的 tag: 用户点开基本就是想找它, 少打一遍字 */
  webTags.value = props.entityKey || ''
  load()
})

// ------------------------------------------------------------ 网上挑封面

const WEB_LIMIT = 24
const webSource = ref('danbooru')
const webTags = ref('')
const webRating = ref('g')
/** solo(只要单人图)—— 与标签框里手写 "solo" 等价, 但批量挑封面的人不知道要写什么 */
const webSolo = ref(false)
const webLoading = ref(false)
const webError = ref('')
const webPosts = ref([])
const webPage = ref(1)
const webHasMore = ref(false)
const webSearched = ref(false)
/** 上一次搜索实际拿到的排序方式: 'score'=站方人气(要 Key) / 'score_local'=本地在这批里排的 */
const webOrder = ref('score_local')
/** Danbooru 配没配 Key(null=还没问过)。这句话关系到"能不能既要 solo 又要站方排序" */
const booruKeyed = ref(null)
/** 远程缩略图: 拼成 tv://remote/?u=… 让主进程代拉(渲染进程直连会被 CDN 403), 见 imageproto.js */
function imgChainOf(p) { return [p.preview, p.sample, p.file].filter(Boolean) }
function thumbOf(p) {
  const c = imgChainOf(p)
  const u = c[Math.min(p.imgStep || 0, c.length - 1)] || ''
  /* r= 只是让 <img> 认为换了地址真的重发一次请求, 协议那边忽略这个参数 */
  return u ? remoteImageUrl(u) + (p.imgRetry ? `&r=${p.imgRetry}` : '') : ''
}
/** 本机到这两个站是抖链路: 先原地重试一次, 还失败才退档到更大的一档(一退就是 88KB) */
function onThumbErr(p) {
  if (!p.imgRetry) { p.imgRetry = 1; return }
  p.imgRetry = 0
  p.imgStep = (p.imgStep || 0) + 1
  if (p.imgStep >= imgChainOf(p).length) p.imgFail = true
}

async function webLoad(page = 1) {
  let tags = String(webTags.value || '').trim()
  if (!tags) { webError.value = '先输入要搜的标签'; return }
  /* 勾了 solo 就别再往标签串里塞第二个 solo —— tagList 会去重, 但串起来给用户看的那行字会变脏 */
  if (webSolo.value && !/(^|\s)solo($|\s)/.test(tags.toLowerCase())) tags = `${tags} solo`
  webLoading.value = true
  webError.value = ''
  try {
    const d = await api.booruSearch({
      source: webSource.value, tags, page, limit: WEB_LIMIT, rating: webRating.value,
    })
    if (d?.error) {
      webError.value = d.error
      if (page === 1) webPosts.value = []
      webSearched.value = true
      return
    }
    webOrder.value = d.order || 'score_local'
    if (typeof d.credentialed === 'boolean' && webSource.value === 'danbooru') booruKeyed.value = d.credentialed
    const fresh = (d.posts || []).map((p) => ({ ...p, ukey: `${p.source_site}-${p.id}` }))
    if (page === 1) {
      webPosts.value = fresh
    } else {
      const seen = new Set(webPosts.value.map((p) => p.ukey))
      webPosts.value = webPosts.value.concat(fresh.filter((p) => !seen.has(p.ukey)))
    }
    webPage.value = page
    webHasMore.value = (d.posts || []).length >= (d.limit || WEB_LIMIT)
    webSearched.value = true
  } catch (e) {
    webError.value = e.message
  } finally {
    webLoading.value = false
  }
}

function switchTab(t) {
  tab.value = t
  if (t !== 'web') return
  /* 每次走到「网上挑」都重新问一遍凭据(以前问过一次就缓存): 用户很可能就是**在这个弹窗开着
   * 的时候**去设置里存了 Key, 缓存会让下面那句提示继续说"匿名", 看着像没生效(2026-10-22)。 */
  api.booruAuthGet().then((r) => { booruKeyed.value = !!r?.hasKey }).catch(() => { booruKeyed.value = false })
  if (!webSearched && !webLoading) webLoad(1)
}

/** 点一张远程图 = 下载 + 设为封面, 与本地 pick 同一条保存链路(差别只在图从哪来) */
async function pickWeb(p) {
  if (busy.value) return
  busy.value = 'web:' + p.id
  try {
    /* 取 sample(站点缩放版, 封面尺寸足够)而不是原图: 本机到这两个站是时通时断的
     * 慢链路(实测同一请求上一轮 1s、下一轮 10s 握手超时), 原图动辄几 MB 会一直转圈。
     * 没有 sample 才退回 file/preview。 */
    const dl = await api.booruDownload({
      source: p.source_site,
      url: p.sample || p.file || p.preview,
      tag: props.entityKey,
      post_id: p.id,
    })
    if (dl?.error) { ui.err('下载失败: ' + dl.error); return }
    const r = await api.coverSet({ kind: props.kind, key: props.entityKey, path: dl.path })
    if (r?.error) { ui.err(r.error); return }
    ui.ok('✅ 已把网上挑的图设为封面', 1800)
    emit('saved', dl.path)
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('设置失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}

async function pick(path) {
  if (busy.value) return
  busy.value = path
  try {
    const r = await api.coverSet({ kind: props.kind, key: props.entityKey, path })
    if (r?.error) { ui.err(r.error); return }
    ui.ok(`✅ 已设为自定义封面`, 1800)
    /* saved 带上所选路径: 购物车那边要同步写回自己的 thumb(系列页忽略该参数) */
    emit('saved', path)
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('设置失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}

async function reset() {
  if (busy.value) return
  busy.value = '__reset__'
  try {
    const r = await api.coverSet({ kind: props.kind, key: props.entityKey, path: '' })
    if (r?.error) { ui.err(r.error); return }
    ui.ok('已恢复自动挑选封面', 1800)
    emit('saved', '')                   // 空串 = 恢复自动挑选(购物车据此重新补挑)
    emit('update:modelValue', false)
  } catch (e) {
    ui.err('恢复失败: ' + e.message)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <TvModal
    :model-value="modelValue"
    :title="head"
    size="lg"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="tabs">
      <button :class="['tab', { on: tab === 'local' }]" data-tab="local" @click="switchTab('local')">
        📁 本地图<template v-if="total"> ({{ nfmt(total) }})</template>
      </button>
      <button :class="['tab', { on: tab === 'web' }]" data-tab="web" @click="switchTab('web')">
        🌐 网上挑
      </button>
    </div>

    <div v-show="tab === 'local'">
      <div class="tip">
        点一张图设为该{{ kind === 'series' ? '系列' : '角色' }}的封面; 封面只在列表里当缩略图用,
        不影响图片本身。<template v-if="source">候选已按当前来源过滤。</template>
        <template v-if="capped">候选较多, 这里只列前 {{ nfmt(items.length) }} 张(共 {{ nfmt(total) }})。</template>
      </div>

      <TvState v-if="loading" state="loading" text="加载候选图..." />
      <TvState v-else-if="error" state="error" :text="`加载失败: ${error}`" />
      <TvState v-else-if="!items.length" state="empty" text="没有可选的图(可能都被安全模式藏掉了); 试试「🌐 网上挑」" />
      <div v-else class="cgrid">
        <button
          v-for="c in items"
          :key="c.path"
          :class="['cand', { cur: c.path === current }]"
          :data-path="c.path"
          :data-cur="c.path === current ? '1' : '0'"
          :title="c.path === current ? '当前封面' : '点一下设为封面'"
          :disabled="!!busy"
          @click="pick(c.path)"
        >
          <TvImage :path="c.path" :width="150" ratio="3 / 4" />
          <span v-if="c.path === current" class="cur-tag">当前</span>
        </button>
      </div>
    </div>

    <div v-if="tab === 'web'" class="web">
      <div class="wbar">
        <select v-model="webSource" class="wsel" data-field="source" :disabled="webLoading">
          <option value="danbooru">Danbooru</option>
          <option value="safebooru">Safebooru</option>
        </select>
        <input
          v-model="webTags"
          class="win"
          data-field="tags"
          placeholder="标签, 空格是与(如 usada_pekora solo)"
          @keyup.enter="webLoad(1)"
        />
        <select v-model="webRating" class="wsel" data-field="rating" :disabled="webLoading">
          <option value="g">仅安全级</option>
          <option value="s">放开敏感</option>
          <option value="all">不限分级</option>
        </select>
        <label class="wsolo" data-field="solo" title="只要单人图(一个角色的那种), 挡掉群像/对打图">
          <input v-model="webSolo" type="checkbox" :disabled="webLoading" />
          只要单人图
        </label>
        <TvButton variant="primary" :loading="webLoading" @click="webLoad(1)">搜索</TvButton>
      </div>
      <div class="tip">
        图来自 {{ webSource === 'danbooru' ? 'Danbooru' : 'Safebooru' }}, 点一张会下载该站的展示尺寸存到
        <code>data/char_covers/user_picks/</code> 再设为封面 —— 这批图<b>不进标签库</b>, 只当封面用。
        这两个站本机时通时断, 搜不到/连不上就换另一个源再试。
        <template v-if="booruKeyed === false && webSource === 'danbooru'">
          🔑 现在是<b>匿名</b>访问: 一次最多带 <b>2 个普通标签</b>(勾了「只要单人图」正好用满 —— <code>rating:g</code>
          这类不占额度, 但再加第三个普通标签站点会报错), 而且<b>站方人气排序不生效</b>, 只能在这几十张里本地比分数。
          在 <b>设置 → 在线封面</b> 填 Danbooru 的 API Key 两处都放开。<b>Safebooru 是免登录的站, 不需要 Key。</b>
        </template>
      </div>

      <TvState v-if="webLoading && !webPosts.length" state="loading" text="正在搜远程图..." />
      <TvState v-else-if="webError && !webPosts.length" state="error" :text="`搜索失败: ${webError}`" />
      <TvState v-else-if="webSearched && !webPosts.length" state="empty" text="这个标签在该站没有符合分级的图, 换个标签或放开分级" />
      <div v-else class="cgrid">
        <button
          v-for="p in webPosts"
          :key="p.ukey"
          class="cand webcand"
          :data-post-id="p.id"
          :data-rating="p.rating"
          :title="`#${p.id} · ${p.width}x${p.height} · 赞 ${p.score} — 点一下下载并设为封面`"
          :disabled="!!busy"
          @click="pickWeb(p)"
        >
          <img :src="thumbOf(p)" loading="lazy" alt="" @error="onThumbErr(p)" />
          <span v-if="p.imgFail" class="fail-tag">图没拉到<br>可直接点下载</span>
          <span v-if="p.rating && p.rating !== 'g'" class="cur-tag rate">{{ p.rating }}</span>
          <span v-if="busy === 'web:' + p.id" class="cur-tag">下载中</span>
        </button>
      </div>

      <div v-if="webHasMore && webPosts.length" class="wmore">
        <TvButton variant="ghost" :loading="webLoading" @click="webLoad(webPage + 1)">加载更多</TvButton>
        <span class="muted">已列 {{ nfmt(webPosts.length) }} 张</span>
      </div>
      <!-- 排序口径说实话(2026-10-22 三次改口, 以实测为准):
           原先写"danbooru 服务端按人气排", 但拿 order=score 等七个值实测**匿名**请求, 返回的
           id 序列一模一样 —— 这个站没登录就不理 order。所以没配 Key 时是"本地排已翻到的那些",
           越往后翻分数越高的图才可能出现; 配了 Key 才轮到站方人气(booru.js 会带 order=score)。
           写成"按人气"会让用户以为第一屏就是名图。 -->
      <div v-if="webPosts.length" class="worder muted">
        <template v-if="webOrder === 'score'">站方按人气(score)从高到低返回 —— 第 {{ webPosts.length }} 张起是续页</template>
        <template v-else>已翻到的 {{ webPosts.length }} 张里按得分从高到低（这两个站的匿名接口都不接受服务端排序）</template>
      </div>
    </div>

    <template #footer>
      <TvButton variant="ghost" :loading="busy === '__reset__'" @click="reset">🔄 恢复自动挑选</TvButton>
      <TvButton variant="secondary" @click="emit('update:modelValue', false)">关闭</TvButton>
    </template>
  </TvModal>
</template>

<style scoped>
.tabs { display: flex; gap: 6px; margin-bottom: 10px; border-bottom: 1px solid var(--border); }
.tab {
  padding: 6px 12px; border: 0; border-bottom: 2px solid transparent; background: none;
  color: var(--muted); font: inherit; font-size: 13px; cursor: pointer;
}
.tab:hover { color: var(--fg); }
.tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.tip { color: var(--muted); font-size: 12px; margin-bottom: 10px; line-height: 1.7; }
.tip code { font-size: 11px; background: var(--panel2); padding: 1px 5px; border-radius: 4px; }
.wbar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.wsel, .win {
  background: var(--panel2); color: var(--fg); border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: 6px 8px; font: inherit; font-size: 13px;
}
.win { flex: 1 1 240px; min-width: 180px; }
.wsolo {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; white-space: nowrap;
}
.wsolo input { accent-color: var(--accent); cursor: pointer; }
.wsolo:hover { color: var(--accent); }
.wmore { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.muted { color: var(--muted); font-size: 12px; }
.cgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
  max-height: 54vh;
  overflow-y: auto;
  padding: 2px;
}
.cand {
  position: relative;
  padding: 0; border: 2px solid var(--border); border-radius: var(--r-sm);
  background: var(--panel2); cursor: pointer; overflow: hidden;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.cand:hover { border-color: var(--accent); transform: translateY(-1px); }
.cand.cur { border-color: var(--accent2); }
.cand:disabled { cursor: default; opacity: .6; }
.webcand img {
  display: block; width: 100%; height: auto; aspect-ratio: 3 / 4; object-fit: cover;
  background: #0d1117;
}
.fail-tag {
  position: absolute; inset: 0; z-index: 2;
  display: grid; place-content: center; gap: 2px; text-align: center;
  font-size: 11px; line-height: 1.6; color: var(--muted);
  background: var(--panel2);
}
.cur-tag {
  position: absolute; top: 4px; left: 4px; z-index: 3;
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: rgba(10, 13, 18, .82); color: var(--accent2);
}
.rate { color: #e8a0a0; }
</style>
