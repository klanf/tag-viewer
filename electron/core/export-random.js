/**
 * 导出端随机替换(2026-10-28) —— 对导出管线的词条按大类随机换词
 * ============================================================
 * 与 random.js(独立抽签)的区别:
 *   random.js     = 从零生成一整条 prompt(pin/权重/密度二分那套)
 *   本模块        = 对**已有筛选结果**做"同槽 1:1 换词":
 *                   原图 1 个姿势词就换 1 个姿势词, 结构不变只换内容。
 *
 * 反查链: tag -> tag_slots.json{slot, sec} -> slot-pools.json{pools[slot]}
 *   - 不在词典里的词 / 槽没有池子 / 槽(或大类)没被勾选 → 保留原词
 *   - 勾选粒度(2026-10-30): 大类(sec) 或 槽(slot) 都能勾 —— "只抽袜子"这类需求
 *     必须到槽级(袜子词条散在 ⑥ 服装 和 高频补充 两个大类里, 大类粒度勾不出来);
 *     换词率同样按槽给, 槽没给率就回退看大类率, 都没有 = 必换(旧行为)。
 *   - 钉词(2026-10-30): pin_slots 指定"某槽必现某词" —— 阶段上排在随机**之前**,
 *     钉了的槽整槽定死、直接跳过随机(钉词优先, 随机抽完再覆盖是白算);
 *     同槽出现多个词只留第一个(防钉词在一条 prompt 里重复); pinFill 开着时
 *     原图缺该槽词也会把钉词补上去。
 *   - 换词率(2026-10-29): 每大类/槽一个 0~1 的换词概率, 每个词独立掷骰 ——
 *     0.65 = 该类六成半的词被换(借鉴 anima-wardrobe-v3 的 base_prob 语义:
 *     "随机"不等于"全换", 全换反而整批风味同质); 1 = 必换(旧行为)。
 *   - 禁用槽(2026-10-30): ban_slots 列出的槽, 原图词条里属于该槽的词**整词删除**
 *     —— 和换词率 0% 的区别: 0% 是保留原词不换, 禁用是连词都不出现。
 *     独立成 filterBannedSlots() 给 exporter 在**黑名单之后、替换规则之前**调,
 *     不塞进 makeRandomizer(只勾禁用不勾随机时 rnd 是 null, 禁用也得生效);
 *     钉了的槽豁免(同一槽既钉又禁是前端保存前要拦的冲突, 引擎只做防御)。
 *   - 档位闸门(2026-10-29): nsfw=false 时候选池在**构建期**就剔除 nsfwPools
 *     (wardrobe-v3 eligible_options 的"先收敛后加权"思路 —— 准入点唯一,
 *     权重永远拉不回超档词, 而不是抽完再扔)。
 *   - 查重记账是**本次导出批次内**的内存 Map(跨条目压重合), 不落盘:
 *     一批里 50 条 prompt 互相错开, 不会十条全抽到同一条裙子
 *   - seed 固定时派生种子逐条可复现; 留空 = 每次导出都不同
 *   - 管线位置: 钉词+随机排在替换规则/补背景之后、segMode 之前 —— 随机出的新词
 *     不会再被黑名单/过滤组误伤, 且 segMode 仍能对产物归堆排序
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BUNDLED_KNOWLEDGE_DIR } from './paths.js'

let _slots = null, _pools = null
/* 缺知识包时不能抛 —— 装出来的包漏打 knowledge/ 那轮(2026-11-08), 随机提示词页
 * 一打开就 ENOENT。降级成空表: 页面只是没有可选大类, 不影响其它功能。 */
function slots() {
  if (!_slots) {
    try { _slots = JSON.parse(readFileSync(path.join(BUNDLED_KNOWLEDGE_DIR, 'tag_slots.json'), 'utf8')).tags || {} }
    catch { _slots = {} }
  }
  return _slots
}
function pools() {
  if (!_pools) {
    try { _pools = JSON.parse(readFileSync(path.join(BUNDLED_KNOWLEDGE_DIR, 'slot-pools.json'), 'utf8')) }
    catch { _pools = { pools: {}, nsfwPools: {} } }
  }
  return _pools
}

/** 剥权重壳 + 归一(同 exporter.tagKey): (blue_eyes:1.2) / Blue Eyes -> blue_eyes */
function tagKey(t) {
  const bare = String(t).replace(/^\((.+):[\d.]+\)$/, '$1')
  return bare.toLowerCase().replace(/[\s_]+/g, '_')
}

/** sec id -> 展示名(去掉 ①② 这类序号前缀, 如 "① 数量与身份" -> "数量与身份") */
const secZh = (info) => String(info?.secZh || info?.sec || '').replace(/^[①-⑳⓪\s]+/, '') || info?.sec

/**
 * 可供勾选的大类清单(懒加载, knowledge 变动后重启生效)。
 * 只列"槽有池子"的大类 —— 没池子的大类勾了也没词可换。
 * @returns {Array<{id, zh, slots: string[]}>} 按词典出现顺序
 */
export function randomSections() {
  const sl = slots()
  const p = pools()
  const order = []
  const bySec = new Map()
  for (const [slot, arr] of Object.entries(p.pools)) {
    for (const e of arr) {
      const info = sl[e.tag]
      if (!info?.sec) continue
      if (!bySec.has(info.sec)) {
        bySec.set(info.sec, { id: info.sec, zh: secZh(info), slots: new Set() })
        order.push(info.sec)
      }
      bySec.get(info.sec).slots.add(slot)
    }
  }
  for (const [slot, arr] of Object.entries(p.nsfwPools || {})) {
    for (const e of arr) {
      const info = sl[e.tag]
      if (!info?.sec) continue
      if (!bySec.has(info.sec)) {
        bySec.set(info.sec, { id: info.sec, zh: secZh(info), slots: new Set() })
        order.push(info.sec)
      }
      bySec.get(info.sec).slots.add(slot)
    }
  }
  return order.map((id) => ({ id, zh: bySec.get(id).zh, slots: [...bySec.get(id).slots] }))
}

/** 槽 id -> 展示名。词典里没有槽的中文名, 这份映射就是 UI 文案的唯一来源;
 *  新槽没进映射就原样显示 id(能用, 只是不好看)。 */
const SLOT_ZH = {
  prop: '道具', accessory: '配饰', top: '上装', outfit: '全套服装', headwear: '头饰',
  legwear: '腿袜', bottom: '下装', underwear: '内衣', tail: '尾巴', footwear: '鞋',
  handwear: '手饰', feature: '身体特征', hairstyle: '发型', furniture: '家具',
  eyes_color: '瞳色', sleeves: '袖子', weather: '天气', horn: '角', eyewear: '眼镜',
  environment: '环境', pose_base: '基础姿势', hair_acc: '发饰', pose: '姿势',
  hair_color: '发色', emotion: '表情', hair_tie: '发带', viewpoint: '视角',
  cloth_mat: '服装材质', cloth_state_sfw: '服装状态', clothing_state: '服装状态',
  clothing_type: '服装类型', location: '地点', mouth: '嘴部', eye_gaze: '视线',
  figure: '体型', race: '种族', lighting: '光照', hair_len: '发长', wings: '翅膀',
  shot_size: '景别', camera_angle: '机位', camera_fx: '镜头特效', swimwear: '泳装',
  n_state: '状态', n_body: '身体', n_exposure: '暴露', n_cum: '体液',
  n_bondage: '束缚', n_pos: '体位', n_sex: '性行为', n_touch: '触碰',
}

/**
 * 可供勾选的槽清单(懒加载, knowledge 变动后重启生效)。
 * @returns {Array<{id, zh, cnt: number, words: string[]}>} 按词条数降序
 *   words = 槽池全部词条(安全池+成人池), 给前端钉词输入框做联想用。
 */
export function randomSlots() {
  const p = pools()
  const cnt = new Map()
  const words = new Map()
  const add = (slot, tag) => {
    if (!cnt.has(slot)) { cnt.set(slot, 0); words.set(slot, []) }
    cnt.set(slot, cnt.get(slot) + 1)
    words.get(slot).push(tag)
  }
  for (const [slot, arr] of Object.entries(p.pools)) for (const e of arr) add(slot, e.tag)
  for (const [slot, arr] of Object.entries(p.nsfwPools || {})) for (const e of arr) add(slot, e.tag)
  return [...cnt.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id, zh: SLOT_ZH[id] || id, cnt: n, words: words.get(id) }))
}

/**
 * 禁用槽过滤(2026-10-30): 删掉归属槽在 banned 集里的词。
 * 管线位置 = 黑名单之后、替换规则之前(见 exporter.js) —— 被禁的词不参与替换,
 * 也不会被替换规则改写成别的词留下来。
 * @param {string[]} tags
 * @param {Set<string>} banned 槽 id 集(legwear/headwear…)
 * @param {Set<string>} [pinnedSlots] 钉了词的槽 —— 豁免(钉词优先, 前端本就该拦这个组合)
 * @returns {{ tags: string[], banned: number, bySlot: Object<string,number> }}
 */
export function filterBannedSlots(tags, banned, pinnedSlots = new Set()) {
  const ban = banned instanceof Set ? banned : new Set(banned || [])
  if (!ban.size) return { tags, banned: 0, bySlot: {} }
  const sl = slots()
  const kept = []
  const bySlot = {}
  let n = 0
  for (const t of tags) {
    const info = sl[tagKey(t)]
    const slot = info?.slot
    if (!slot || !ban.has(slot) || pinnedSlots.has(slot)) { kept.push(t); continue }
    n++
    bySlot[slot] = (bySlot[slot] || 0) + 1
  }
  return { tags: kept, banned: n, bySlot }
}

/**
 * 词归属反查(2026-10-30, 钉词输入的分类标识用): 每个词在词典里的槽 + 大类中文名。
 * 输入词任意形态都行((white_thighhighs:1.2) / White Thighhighs 都认, 走 tagKey 归一);
 * 词典里没有的词返回 { slot: '', sec: '' } —— 前端拿这个显示"词典外, 直接写入"。
 * @param {string[]} words
 * @returns {Array<{word: string, slot: string, slotZh: string, sec: string}>} 与输入同序
 */
export function wordInfos(words) {
  const sl = slots()
  const out = []
  for (const w of Array.isArray(words) ? words : []) {
    const info = sl[tagKey(w)]
    out.push({
      word: String(w || ''),
      slot: info?.slot || '',
      slotZh: info?.slot ? (SLOT_ZH[info.slot] || info.slot) : '',
      sec: info ? secZh(info) : '',
    })
  }
  return out
}

// ---------- 可复现 RNG(与 random.js 同款) ----------
function mulberry32(seed) {
  let a = 0
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) | 0
  if (!a) a = 0x9e3779b9
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 造一个批次随机器。
 * @param {{sections?: Set<string>, slots?: Set<string>, pins?: Map<string,string>,
 *           pinFill?: boolean, seed: (string|number|null),
 *           rates?: Map<string,number>, nsfw?: boolean}} opts
 *   sections  参与随机的**大类** sec id 集(老参数, 保留兼容老预设)
 *   slots     参与随机的**槽** slot id 集(新粒度, 2026-10-30)
 *   pins      钉词表 slot -> 词(该槽必现指定词, 优先于随机)
 *   pinFill   原图缺钉词槽的词条时, 是否把钉词补上去(缺省 true = 补)
 *   rates     换词率表(slot id 或 sec id -> 0~1; 槽优先于大类), 缺省 = 1(必换, 旧行为)
 *   nsfw      是否允许从 nsfwPools 抽词(缺省 true = 允许, 旧行为)
 * @returns {{ randomize: (idx:number, tags:string[]) => {tags:string[], replaced:number, bySec: Object<string,number>} }}
 *   randomize 在每条导出行上调用一次; replaced = 实际换掉/钉上的词数;
 *   bySec = 按槽(或大类)分组的计数(id -> 个数), 供回执细分展示。
 */
export function makeRandomizer(opts = {}) {
  const secs = opts.sections instanceof Set ? opts.sections : new Set()
  const slotSet = opts.slots instanceof Set ? opts.slots : new Set()
  // 钉词表: 词归一成词典写法(小写 + 空格转下划线), 手输的词也能对上
  const pins = new Map()
  if (opts.pins instanceof Map) {
    for (const [slot, w] of opts.pins) {
      const key = String(w || '').trim().toLowerCase().replace(/\s+/g, '_')
      const sl = String(slot || '').trim()
      if (sl && key) pins.set(sl, key)
    }
  }
  const pinFill = opts.pinFill !== false
  if (!secs.size && !slotSet.size && !pins.size) {
    return { randomize: (_i, tags) => ({ tags, replaced: 0, bySec: {} }) }
  }

  const sl = slots()
  const p = pools()
  // 档位闸门: 在池子构建期收敛(先收敛后加权, 准入点唯一) ——
  // nsfw=false 时 nsfwPools 整个不进候选, 权重/重试都不可能把它拉回来。
  const allowNsfw = opts.nsfw !== false
  // 换词率表: 只认 0~1, 越界/非法一律按缺省 1(必换) —— 与 exporter 侧解析同一口径
  const rates = opts.rates instanceof Map ? opts.rates : new Map()
  // 槽给的率优先于大类(勾槽时槽率才生效; 老的大类勾选走 sec 分支)
  const rateOf = (slot, sec) => {
    const pick = (k) => {
      if (!rates.has(k)) return null
      const v = Number(rates.get(k))
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
    }
    return pick(slot) ?? pick(sec) ?? 1
  }
  // 词频缓存按槽懒建: {slot: [{tag, w}]}
  const slotCache = new Map()
  const poolOf = (slot) => {
    if (slotCache.has(slot)) return slotCache.get(slot)
    let arr = p.pools[slot] || []
    if (allowNsfw) {
      const nx = p.nsfwPools?.[slot]
      if (nx && nx.length) arr = arr.concat(nx)   // 安全池 + 成人池一起入候选
    }
    const built = arr.map((e) => ({ tag: e.tag, w: Math.pow(e.cnt || 1, 0.75) }))
    slotCache.set(slot, built)
    return built
  }

  // 批次内查重账(跨条目共享): 被抽越多次越难再被抽中
  const used = new Map()
  const useOf = (t) => used.get(t) || 0

  const RETRY = 5
  function pickFor(slot, selfKey, recordKeys, rng) {
    const arr = poolOf(slot)
    if (!arr.length) return null
    for (let i = 0; i <= RETRY; i++) {
      const W = arr.map((e) => e.w / (1 + useOf(e.tag)))
      let sum = W.reduce((a, b) => a + b, 0)
      let r = rng() * sum
      let hit = arr[arr.length - 1]
      for (let k = 0; k < arr.length; k++) { r -= W[k]; if (r <= 0) { hit = arr[k]; break } }
      const hitKey = tagKey(hit.tag)
      // 不抽回原词、也不抽本行已有的词(一换一换出重复没意义)
      if (hitKey !== selfKey && !recordKeys.has(hitKey)) return hit.tag
    }
    return null
  }

  return {
    randomize(idx, tags) {
      // seed 固定 → 每条派生可复现; 留空 → 每条独立随机
      const rng = opts.seed != null && String(opts.seed).length
        ? mulberry32(`${opts.seed}::export::${idx}`)
        : mulberry32(`${Date.now()}::${idx}::${Math.floor(Math.random() * 2 ** 31)}`)
      const recordKeys = new Set(tags.map(tagKey))
      let replaced = 0
      const bySec = {}
      const bump = (k) => { bySec[k] = (bySec[k] || 0) + 1 }

      // ---- ① 钉词阶段(先于随机): 钉了的槽整槽定死, 之后随机直接跳过这些槽 ----
      let work = tags
      if (pins.size) {
        const seen = new Set()   // 本行已钉过的槽(同槽只留一个词, 防钉词重复)
        const kept = []
        for (const t of tags) {
          const info = sl[tagKey(t)]
          const slot = info?.slot
          if (!slot || !pins.has(slot)) { kept.push(t); continue }
          const pw = pins.get(slot)
          if (seen.has(slot)) continue          // 同槽第二个词: 丢掉, 别让钉词出现两遍
          seen.add(slot)
          if (tagKey(pw) === tagKey(t)) { kept.push(t); continue }  // 本来就是钉词
          kept.push(pw)
          recordKeys.add(tagKey(pw))
          replaced++
          bump(slot)
        }
        // 补词: 原图整行都没有该槽的词 → 按开关把钉词追加到行尾
        if (pinFill) {
          for (const [slot, pw] of pins) {
            if (seen.has(slot) || recordKeys.has(tagKey(pw))) continue
            kept.push(pw)
            recordKeys.add(tagKey(pw))
            replaced++
            bump(slot)
          }
        }
        work = kept
      }

      // ---- ② 随机换词阶段(只动"勾了且没钉"的槽) ----
      const out = work.map((t) => {
        const key = tagKey(t)
        const info = sl[key]
        if (!info?.slot) return t
        if (pins.has(info.slot)) return t      // 钉词优先: 该槽已定死
        const inSlot = slotSet.has(info.slot)
        const inSec = secs.has(info.sec)
        if (!inSlot && !inSec) return t
        // 换词率掷骰: 每个词独立 —— rate<1 时保留原词也是一种"抽中"
        const rate = rateOf(info.slot, info.sec)
        if (rate <= 0) return t
        if (rate < 1 && rng() >= rate) return t
        const fresh = pickFor(info.slot, key, recordKeys, rng)
        if (!fresh || fresh === t) return t
        used.set(fresh, useOf(fresh) + 1)
        replaced++
        bump(inSlot ? info.slot : info.sec)
        recordKeys.add(tagKey(fresh))
        return fresh
      })
      return { tags: out, replaced, bySec }
    },
  }
}
