/**
 * 安全模式的**前端标签匹配镜像**
 * ==============================
 * 主进程 `electron/core/safety.js` 里有一份同样规则的实现(读 `dataDir/safety_tags.txt`
 * 算成 exact/前缀/后缀/包含四组, 再按词典档位表给标签定 0-4 级)。
 *
 * **为什么前端还要再来一份**: 库里那些图的安全标记是读数据集时在主进程算好的
 * (`record.unsafe`), 前端只做数值比较就行 —— 但**扫描页的图是库外的**, 它们的标签是
 * 现场从 PNG 元数据解析出来的, 库里根本没有这一行, 也就没有 `unsafe`。要在扫描页也能
 * "一键过滤", 只能在渲染层按同一套规则现算。
 *
 * ⚠️ 两边的规则必须逐字一致: 改判定语义时 `core/safety.js` 与这里要一起改。
 *    单测(folds)里用同一批标签交叉验证两边的结论 —— 只靠"看起来一样"迟早会分叉。
 */

/**
 * 把标签列表编译成四组, 便于 O(1)/O(少量) 判定。
 * 拆开是为了性能: 一张图约 40 个标签, 精确匹配走 Set, 只有带 * 的少数规则才逐个比较。
 * @param {string[]} list
 * @returns {{exact:Set<string>, pre:string[], suf:string[], con:string[], raw:string[]}}
 */
export function compileRules(list) {
  const exact = new Set()
  const pre = []
  const suf = []
  const con = []
  for (const raw of list || []) {
    const r = String(raw || '').trim().toLowerCase()
    if (!r) continue
    if (!r.includes('*')) exact.add(r)
    else if (r.startsWith('*') && r.endsWith('*') && r.length > 2) con.push(r.slice(1, -1))
    else if (r.startsWith('*')) suf.push(r.slice(1))
    else pre.push(r.slice(0, -1))
  }
  return { exact, pre, suf, con, raw: list || [] }
}

/** 单标签是否命中某一段(与主进程 hitOne 一致) */
export function hitOne(tag, part) {
  if (!part) return false
  if (part.exact.has(tag)) return true
  for (let i = 0; i < part.pre.length; i++) if (tag.startsWith(part.pre[i])) return true
  for (let i = 0; i < part.suf.length; i++) if (tag.endsWith(part.suf[i])) return true
  for (let i = 0; i < part.con.length; i++) if (tag.includes(part.con[i])) return true
  return false
}

/**
 * 词根规则：主进程把 `BUILTIN_WORD_RULES` 的**正则源码**下发（`safety:get` 的 wordRules），
 * 这里重建 RegExp。**不要手抄一份规则表** —— 抄了下次改主进程必忘改这里，
 * 两侧一分叉，"隐藏 N 张"的数字就会骗人（2026-11-11 实测发生：主进程词根规则
 * 已上线，前端镜像还只有 secs+dict，penetration_test 主进程判 3、前端判 0）。
 * @param {Array<[string, number]>} list [[patternSource, level], ...]
 * @returns {Array<[RegExp, number]>}
 */
export function compileWordRules(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const it of list) {
    if (!Array.isArray(it) || it.length < 2) continue
    try { out.push([new RegExp(it[0]), Number(it[1]) || 0]) } catch { /* 坏规则跳过, 不炸整页 */ }
  }
  return out
}

/**
 * 单标签的敏感等级(0-4) —— 与主进程 `levelOfTag` **逐字等价**。
 * matcher = { secs: {0..4: compiled}, dict: {tag: level}, wordRules: [[RegExp, lv]] }:
 *   覆盖段(检查顺序 L0->L4, 先命中先算) > 词典表 > 词根规则 > 0。
 *
 * ⚠️ 归一(`[\\s_]` -> `_`)必须与主进程一致：PNG 元数据里是空格写法
 * ("group sex")，库与词典是下划线，不归一会整列漏判。
 */
export function tagLevelOf(tag, matcher) {
  const t = String(tag).toLowerCase().replace(/[\s_]+/g, '_')
  for (let lv = 0; lv <= 4; lv++) {
    const part = matcher?.secs?.[lv]
    if (part && hitOne(t, part)) return lv
  }
  const d = matcher?.dict
  if (d && Object.prototype.hasOwnProperty.call(d, t)) return d[t]
  const wr = matcher?.wordRules
  if (Array.isArray(wr)) {
    for (let i = 0; i < wr.length; i++) if (wr[i][0].test(t)) return wr[i][1]
  }
  return 0
}

/**
 * 给一组标签打安全等级 —— 与主进程 `unsafeLevelOf` 等价。
 * @returns {0..4} 图内所有标签的**最高档**
 */
export function unsafeOfTags(tags, matcher) {
  let max = 0
  for (const t of tags || []) {
    const lv = tagLevelOf(t, matcher)
    if (lv > max) max = lv
    if (max === 4) break
  }
  return max
}

/**
 * 一个列表里**各档位**各有多少张 -> `{ hist:[5], total }`。
 *
 * 口径必须与主进程（dataset.js 的 unsafeHist / query.js 的 unsafeCountOf）
 * **逐字一致**：「显示上限 N 会隐藏多少张」= sum(hist[N+1..4])。
 * 这个数是"安全模式开关上那个 −N"的来源，算错了不会崩，只会**骗人**：
 * 开关上写着 −3、实际藏掉 5 张。所以 test:visual 里拿 `hiddenBySafety` 逐条对了一遍。
 *
 * 刻意收一个 `unsafeOf` 取值函数而不是直接读 `item.unsafe`：库内记录是数值直读，
 * 库外图（扫描页 / 收藏快照）得按标签现算 —— 两种取值方式共用这一份计数逻辑。
 *
 * `total` 不是命中数, 是给「不安全模式」算补集用的: 该模式隐藏 = total - 敏感数。
 *
 * @param {Array} list
 * @param {(item:any)=>number} unsafeOf 取一张图的敏感等级 0..4
 * @returns {{hist:number[], total:number}}
 */
export function countHits(list, unsafeOf) {
  const arr = Array.isArray(list) ? list : []
  const hist = [0, 0, 0, 0, 0]
  for (const it of arr) {
    const u = Number(unsafeOf(it)) || 0
    if (u > 0 && u <= 4) hist[u]++
  }
  return { hist, total: arr.length }
}
