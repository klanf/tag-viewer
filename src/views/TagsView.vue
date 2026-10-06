<script setup>
/**
 * 标签浏览 —— 原 tags.html
 * =======================
 * 只剩一级: 标签列表(🚫 切换黑名单 / 点标签去它的图片列表)。
 *
 * 「某个标签的图片」2026-09-20 拆成了**下一级子页面** `/tags/:tag`
 * (见 TagImagesView.vue) —— 原来它是本组件里的第二级状态, 地址栏只带 `?tag=`,
 * 浏览器后退得按两次才退得出标签页。现在 点标签 = 路由跳转, 层级是真的。
 *
 * 2026-10-06 三件(用户需求):
 *   · **去分页改滚动加载** —— 页码器和「每页」选择框撤掉, 滚到底自动补下一批
 *     (每批 300)。旧版"上万 pill 一次进 DOM 会卡"的担心依然成立, 所以照旧渐进
 *     加载, 只是翻页动作换成了滚动。
 *   · **「🚫 隐藏已ban」胶囊开关**(默认开, 记忆在 localStorage `tv_tags_hide_banned`)
 *     —— 过滤走**服务端**(getAllTags 的 hide_banned), total 是真实的可见数,
 *     接口顺带报被滤掉多少个; 开关一翻重拉列表(批量大, 毫秒级)。
 *   · **安全模式对词条生效** —— 开着 🛡 时, 敏感词(命中 core/edge 集合的标签名)
 *     从列表里藏掉。走**客户端过滤**(复用 useSafetyStore 的判定), 跟着工具栏开关
 *     即时生效, 不用重拉; 词和图口径同源(同一份 safety_tags.txt)。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TvTagList from '@/components/tag/TvTagList.vue'
import TvTagSuggestInput from '@/components/tag/TvTagSuggestInput.vue'
import TvButton from '@/components/base/TvButton.vue'
import TvChip from '@/components/base/TvChip.vue'
import TvState from '@/components/base/TvState.vue'
import TvSafetyToggle from '@/components/safety/TvSafetyToggle.vue'
import { useUiStore } from '@/stores/useUiStore.js'
import { useSafetyStore } from '@/stores/useSafetyStore.js'
import { api } from '@/utils/api.js'
import { readLS, writeLS, LS } from '@/utils/lskey.js'
import { nfmt } from '@/utils/format.js'

const ui = useUiStore()
const router = useRouter()
const safety = useSafetyStore()

const kw = ref('')
const BATCH = 300
const total = ref(0)          // 服务端可见总数(已按 hide_banned 过滤)
const bannedHidden = ref(0)   // 服务端报的被滤掉的已 ban 数
const tags = ref([])          // 已加载的(服务端过滤后)
const loading = ref(false)
const error = ref('')
const hideBanned = ref(readLS(LS.tagsHideBanned.key) !== '0')   // 默认隐藏

/* ---------------- 安全模式: 敏感词从列表藏掉(客户端, 即时生效) ---------------- */
const visibleTags = computed(() => {
  if (!safety.on) return tags.value
  return tags.value.filter((t) => !safety.isHidden({ tags: [t.tag] }))
})
/** 当前档位下藏掉了多少个词(只统计已加载的那批) */
const safetyHidden = computed(() =>
  safety.on ? tags.value.length - visibleTags.value.length : 0)

/* ---------------- 滚动加载 ---------------- */
const scrollEl = ref(null)
/** initialized: 首批没落地前 done 必须是 false —— 否则 0>=0 会把首屏加载挡死 */
const initialized = ref(false)
const done = computed(() => initialized.value && tags.value.length >= total.value)

function nearBottom() {
  const el = scrollEl.value
  if (!el) return false
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 240
}

async function loadMore(force = false) {
  if (loading.value || done.value) return
  if (!force && scrollEl.value && !nearBottom()) return   // force: 搜索/切开关的重拉, 不看位置
  loading.value = true
  error.value = ''
  try {
    const d = await api.allTags({
      q: kw.value.trim(),
      offset: tags.value.length,
      limit: BATCH,
      hide_banned: hideBanned.value ? '1' : '',
    })
    total.value = d.total || 0
    bannedHidden.value = d.bannedHidden || 0
    if (d.tags?.length) tags.value.push(...d.tags)
    initialized.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
  // 批次落完还在底部(首屏没填满), 继续补 —— done 会兜住循环
  if (!force && !done.value && !error.value) loadMore()
}

/** 搜索 / 切换隐藏已ban: 清空重拉。
 * ⚠️ 必须 force —— 清空后 DOM 还没刷新, nearBottom() 读到旧滚动高度会拒绝加载,
 * 列表就永远空着(实测抓过)。 */
function reload() {
  tags.value = []
  initialized.value = false
  scrollEl.value?.scrollTo({ top: 0 })
  loadMore(true)
}

function onKwSubmit() { reload() }
/* 默认值也落盘: 让键从第一次运行就存在(断言/排查都好认), 不等第一次切换 */
writeLS(LS.tagsHideBanned.key, hideBanned.value ? '1' : '0')
watch(hideBanned, (v) => {
  writeLS(LS.tagsHideBanned.key, v ? '1' : '0')
  reload()
})

/* ---------------- 交互 ---------------- */
/** 点标签 = 去下一级子页面看它的图(路由跳转, 可后退) */
function showImages(tag) {
  if (!tag) return
  router.push({ name: 'tag-images', params: { tag } })
}

/**
 * 🚫 切换: 就地更新那一条, 不重拉列表(与旧版一致)。
 * 「隐藏已ban」开着时, ban 上的那条按语义应从列表消失(它已经是"已ban"了);
 * 取消 ban 的入口在关掉开关之后(开关开着根本看不见它)。
 */
async function toggleBan(tag) {
  try {
    const r = await api.blacklistToggle(tag)
    if (r.action === 'wildcard') {
      ui.warn(r.warning || `该标签被通配规则 ${r.ban_rule} 命中, 需在黑名单里手动修改`, 4000)
      return
    }
    if (r.banned && hideBanned.value) {
      tags.value = tags.value.filter((t) => t.tag !== tag)
      total.value = Math.max(0, total.value - 1)
      bannedHidden.value++
      ui.ok(`🚫 已 ban 并隐藏: ${tag}`, 'info', 1600)
      return
    }
    const it = tags.value.find((t) => t.tag === tag)
    if (it) {
      it.banned = !!r.banned
      it.ban_rule = r.banned ? tag.toLowerCase() : ''
    }
    ui.ok(r.banned ? `🚫 已 ban: ${tag}` : `已取消 ban: ${tag}`, 'info', 1600)
  } catch (e) {
    ui.err('操作失败: ' + e.message)
  }
}

onMounted(() => {
  safety.ensureLoaded()
  loadMore()
})
</script>
<template>
  <div class="tags-view">
    <div class="head">
      <div class="crumb">
        <span class="now">全部标签</span>
      </div>
      <span class="spacer" />
    </div>

    <div class="panel body">
      <div class="bar">
        <div class="kw">
          <TvTagSuggestInput
            v-model="kw"
            placeholder="搜索标签... (Enter 搜索)"
            @submit="onKwSubmit"
            @pick="onKwSubmit"
          />
        </div>
        <TvButton size="sm" variant="primary" @click="onKwSubmit">搜索</TvButton>
        <TvChip
          :label="hideBanned ? '🚫 已ban已隐藏' : '🚫 已ban可见'"
          :active="hideBanned"
          :title="hideBanned
            ? '已 ban 的词条已从列表隐藏(记忆在本地, 重启仍生效); 点一下显示它们(灰色删除线)'
            : '已 ban 的词条正以灰色删除线显示; 点一下把它们藏起来'"
          @click="hideBanned = !hideBanned"
        />
        <span class="hint">共 {{ nfmt(total) }} 个标签</span>
        <span v-if="hideBanned && bannedHidden > 0" class="hint faint banned-hint">已隐藏 {{ nfmt(bannedHidden) }} 个已 ban</span>
        <span v-if="safetyHidden > 0" class="hint faint safety-hint">🛡 已隐藏 {{ nfmt(safetyHidden) }} 个敏感词</span>
        <span class="hint faint">点标签看它的图片 · 🚫 = 导出时剔除 · 灰色删除线 = 已 ban</span>
        <TvSafetyToggle />
      </div>

      <div ref="scrollEl" class="scroll" @scroll="loadMore">
        <TvState v-if="loading && !tags.length" state="loading" text="加载中..." />
        <TvState v-else-if="error && !tags.length" state="error" :text="`加载失败: ${error}`" />
        <TvTagList
          v-else
          :tags="visibleTags"
          show-ban
          show-count
          action="filter"
          empty-text="没有匹配的标签(可能被「隐藏已ban」或安全模式藏掉了)"
          @click="({ tag }) => showImages(tag)"
          @ban="toggleBan"
          @hover="({ zh, event }) => ui.showTip(zh, event)"
          @leave="ui.hideTip"
        />
        <div v-if="loading && tags.length" class="more-hint">加载中...</div>
        <div v-else-if="done && tags.length" class="more-hint">到底了 · 共 {{ nfmt(total) }} 个标签</div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.tags-view {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px;
  overflow: hidden;
}
.head { display: flex; align-items: center; flex: 0 0 auto; }
.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
.crumb .now { color: var(--text); }
.spacer { flex: 1 1 auto; }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
.kw { width: 300px; }
.hint { color: var(--muted); font-size: 12px; }
.faint { color: var(--faint); }
.scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
.more-hint { color: var(--faint); font-size: 11px; text-align: center; padding: 10px 0 4px; }
</style>
