/**
 * 过滤组引擎 v1 —— 词条管线第二层(纯函数, 零依赖)
 * ====================================================
 * 输入一图词条串 + 槽位词典 + 规则包, 输出过滤后的词条与逐条 drop 理由。
 * 上游: knowledge/tag_slots.json(槽位归类, scripts/build-tag-slots.mjs 产物)
 * 下游: filterTagsLikeExport 的第四段 / 未来随机重组层的喂料
 *
 * v1 规则类型:
 *   keepOne —— 同槽位多词条只留一个(legwear/eyes_color 这类"单选槽"),
 *              胜者按本地图片量(cnt)选, 平票取列表序。
 *   mutex   —— 显式互斥组(跨槽位矛盾, 如 standing×sitting、foot_focus×full_body),
 *              组内出现 2+ 个只留胜者。
 *
 * v1 生效范围: **仅单人图**(solo 或 1girl/1boy 且无多人标记)。
 * 群像图多人各穿各的, 槽内去重必误杀 —— 一律跳过(这是数据探针定的铁律,
 * .e2e-work/probe-slot-collide.mjs 可复跑验证)。
 *
 * 有意不做进 keepOne 的槽位(探针证明是合法共存, 去重=误杀):
 *   underwear(bra+panties 互补) / top·bottom(叠加穿) / emotion·expression
 *   / accessory·hair_acc(多件饰品) / body_part·feature / environment / prop
 */

const MULTI_MARKERS = new Set([
  'multiple_girls', 'multiple_boys', '2girls', '3girls', '4girls', '5girls',
  '6+girls', '2boys', '3boys', '4boys', '5boys', '6+boys',
])

/** 单人图判定: 有 1girl/1boy 主体且没有任何多人标记 */
export function isSoloImage(tags) {
  return (tags.includes('1girl') || tags.includes('1boy'))
    && !tags.some((t) => MULTI_MARKERS.has(t))
}

/**
 * 过滤组主入口
 * @param {string[]} tags     单图词条(已 trim)
 * @param {object} ctx
 *   - slots:  { tag: { slot, fieldZh, level, ... } }   槽位词典(tags 层)
 *   - counts: { tag: number }                          本地图片量(胜者权重)
 *   - rules:  { keepOne: [{slot, exempt?, strategy?}], mutex: [{all, name?}] }
 * @returns {{ tags: string[], drops: {tag,reason,kept}[], changed: boolean }}
 */
export function applyFilterGroups(tags, ctx = {}) {
  const { slots = {}, counts = {}, rules = {} } = ctx
  const drops = []
  if (!isSoloImage(tags)) return { tags, drops, changed: false }

  const present = new Set(tags)
  /** 胜者挑选: cnt 大者赢, 平票取数组序(=规则/词典的稳定顺序) */
  const pickWinner = (arr) => {
    let best = arr[0], bestCnt = counts[best] ?? -1
    for (const t of arr) {
      const c = counts[t] ?? -1
      if (c > bestCnt) { best = t; bestCnt = c }
    }
    return best
  }

  // ---- 1. keepOne: 槽内去重 ----
  const slotOf = (t) => slots[t]?.slot || ''
  for (const rule of rules.keepOne || []) {
    const members = tags.filter((t) => slotOf(t) === rule.slot)
    if (members.length < 2) continue
    const exempt = new Set(rule.exempt || [])
    const pool = members.filter((t) => !exempt.has(t))
    if (pool.length < 2) continue   // 豁免后只剩一个 → 没得去
    const winner = pickWinner(pool)
    for (const t of pool) {
      if (t !== winner) drops.push({ tag: t, reason: `keepOne:${rule.slot}`, kept: winner })
    }
  }

  // ---- 2. mutex: 显式互斥组 ----
  for (const rule of rules.mutex || []) {
    const group = (rule.all || []).filter((t) => present.has(t))
    if (group.length < 2) continue
    const winner = pickWinner(group)
    for (const t of group) {
      if (t !== winner) drops.push({ tag: t, reason: `mutex:${rule.name || rule.all.join('+')}`, kept: winner })
    }
  }

  if (!drops.length) return { tags, drops, changed: false }
  // 同一 tag 可能同时命中 keepOne 和 mutex —— 只记首条, 防重复计数(输出无影响, dropSet 本来就收敛)
  const seen = new Set()
  const uniq = drops.filter((d) => !seen.has(d.tag) && seen.add(d.tag))
  const dropSet = new Set(uniq.map((d) => d.tag))
  return { tags: tags.filter((t) => !dropSet.has(t)), drops: uniq, changed: true }
}
