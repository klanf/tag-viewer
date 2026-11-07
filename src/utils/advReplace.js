/**
 * 高级替换(2026-10-30)共享状态
 * =============================
 * 原来这套状态长在 HomeView 里(随机替换面板), 升级成独立弹窗后 HomeView 和
 * TvAdvancedReplaceModal 都要用 —— 拆成模块级 reactive 单例, 两边 import 同一份,
 * 不搞 prop/v-model 中转(槽清单 57 项 + 率表 + 钉词行 + 禁用槽, prop 传太啰嗦)。
 *
 * 生命周期: 会话级(刷新/重启归零, 与首页其他导出选项同口径)。
 * 槽/大类清单从主进程拉一次缓存住(random:slots / random:sections)。
 */
import { reactive, computed } from 'vue'
import { api } from './api.js'

export const adv = reactive({
  enabled: false,        // 总开关: 关了导出完全不碰随机/钉词/禁用
  picked: [],            // 参与随机的槽 id
  rates: {},             // 槽 id -> 换词率(0~100), 缺 100 = 必换
  pins: [],              // 钉词行 [{slot, word}]
  pinFill: true,         // 原图缺该槽词时补上钉词
  banned: [],            // 禁用槽 id(原图该槽的词整词删除)
  nsfw: true,            // 候选池是否含成人词库
  seed: '',              // 种子, 空 = 每次导出都不同
  slots: [],             // 槽清单 [{id, zh, cnt, words}] —— 主进程下发
  sections: [],          // 大类清单(给老回执的 sec id 做中文映射)
  loaded: false,
})

let loadSeq = 0
/** 槽/大类清单懒加载(第一次打开弹窗才拉; 失败允许重试) */
export async function ensureAdvLoaded() {
  if (adv.loaded) return
  const my = ++loadSeq
  try {
    const [slots, secs] = await Promise.all([api.random.slots(), api.random.sections()])
    if (my !== loadSeq) return
    adv.slots = slots || []
    adv.sections = secs || []
    adv.loaded = true
  } catch { /* 下次打开弹窗再试 */ }
}

/** 槽/大类 id -> 中文名(回执细分用; 槽优先, 老的大类 id 兜底) */
export function advZh(id) {
  return adv.slots.find((x) => x.id === id)?.zh
    || adv.sections.find((x) => x.id === id)?.zh
    || id
}

/** 换词率参数串: 勾的槽拼成 "legwear:0.65,pose"(率 100% 时省略率段 = 老格式) */
export const advSlotsParam = computed(() => adv.picked.map((id) => {
  const r = Number(adv.rates[id])
  return (Number.isFinite(r) && r >= 0 && r < 100) ? `${id}:${Math.max(0, r / 100).toFixed(2)}` : id
}).join(','))

/** 钉词参数串: "legwear:white_thighhighs,headwear:hat"(只收槽和词都填了的行) */
export const advPinsParam = computed(() => adv.pins
  .filter((p) => p.slot && p.word.trim())
  .map((p) => `${p.slot}:${p.word.trim().toLowerCase().replace(/\s+/g, '_')}`)
  .join(','))

/** 禁用槽参数串: "headwear,eyewear" */
export const advBanParam = computed(() => adv.banned.join(','))

/** 有效钉词行数(统计展示用) */
export const advPinCount = computed(() => adv.pins.filter((p) => p.slot && p.word.trim()).length)

/** 槽互斥: 既钉又禁 = 冲突(保存/导出前拦) */
export const advConflicts = computed(() => {
  const pinSlots = new Set(adv.pins.filter((p) => p.slot && p.word.trim()).map((p) => p.slot))
  return adv.banned.filter((s) => pinSlots.has(s))
})

/** 开关是否带着任何实际配置(决定导出参数里 randomize 是 1 还是 0) */
export const advActive = computed(() => adv.picked.length > 0 || advPinCount.value > 0 || adv.banned.length > 0)

export function toggleAdvSlot(id) {
  const i = adv.picked.indexOf(id)
  if (i >= 0) adv.picked.splice(i, 1)
  else { adv.picked.push(id); if (adv.rates[id] === undefined) adv.rates[id] = 100 }
}

export function toggleAdvBan(id) {
  const i = adv.banned.indexOf(id)
  if (i >= 0) adv.banned.splice(i, 1)
  else adv.banned.push(id)
}

export function addAdvPin() { adv.pins.push({ slot: '', word: '' }) }
export function removeAdvPin(i) { adv.pins.splice(i, 1) }

/** 导出参数(HomeView 的 exportParams / doExport / presetSnapshot 共用) */
export function advParams() {
  return {
    randomize: (adv.enabled && advActive.value) ? '1' : '0',
    randomize_slots: advSlotsParam.value,
    pin_slots: advPinsParam.value,
    pin_fill: adv.pinFill ? '1' : '0',
    ban_slots: advBanParam.value,
    randomize_nsfw: adv.nsfw ? '1' : '0',
    randomize_seed: adv.seed.trim(),
  }
}
