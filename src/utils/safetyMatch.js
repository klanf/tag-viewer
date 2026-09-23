/**
 * 安全模式的**前端标签匹配镜像**
 * ==============================
 * 主进程 `electron/core/safety.js` 里有一份同样规则的实现(读 `dataDir/safety_tags.txt`
 * 算成 exact/前缀/后缀/包含四组, 再判一张图落在 core 段还是 edge 段)。
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
 * 给一组标签打安全标记 —— 与主进程 `unsafeLevelOf` 等价。
 * @returns {0|1|2} 0=干净 / 1=命中 core 段 / 2=只命中 edge 段
 */
export function unsafeOfTags(tags, matcher) {
  const core = matcher?.core
  const edge = matcher?.edge
  const arr = tags || []
  if (!core || !edge) return 0
  for (const t of arr) if (hitOne(String(t).toLowerCase(), core)) return 1
  for (const t of arr) if (hitOne(String(t).toLowerCase(), edge)) return 2
  return 0
}

/**
 * 一个列表里**两档各会隐藏多少张** → `{ core, edge }`。
 *
 * 口径必须与主进程的 `coreHit` / `edgeHit` **逐字一致**（见 safety.js 的 hiddenAt）：
 *   · core = 只命中 core 段的条数（core 档会藏这么多）
 *   · edge = edge 档会藏的总数（= core + 仅命中 edge 的 —— core 段在 edge 档照样藏）
 * 这两个数是"安全模式开关上那个 −N"的来源，算错了不会崩，只会**骗人**：
 * 开关上写着 −3、实际藏掉 5 张。所以 test:visual 里拿 `hiddenBySafety` 逐条对了一遍。
 *
 * 刻意收一个 `unsafeOf` 取值函数而不是直接读 `item.unsafe`：库内记录是数值直读，
 * 库外图（扫描页 / 收藏快照）得按标签现算 —— 两种取值方式共用这一份计数逻辑。
 *
 * @param {Array} list
 * @param {(item:any)=>number} unsafeOf 取一张图的敏感级别 0/1/2
 * @returns {{core:number, edge:number}}
 */
export function countHits(list, unsafeOf) {
  const arr = Array.isArray(list) ? list : []
  let core = 0
  let edge = 0
  for (const it of arr) {
    const u = unsafeOf(it)
    if (u === 1) core++
    else if (u === 2) edge++
  }
  return { core, edge: core + edge }
}
