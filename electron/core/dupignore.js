/**
 * 查重误报忽略表(2026-10-17, 2026-10-24 加永久忽略)
 * ==================================================
 * 两档语义:
 *   · pairs  = 「🚫 非重复」忽略的图对 —— 不在相似组里出现, 但会列在「已忽略」里, 可逐组恢复;
 *   · blocked = 「🗑 删记录」永久删掉的图对 —— 查重里任何地方都不再出现, 只能整体恢复。
 * 用户判定一组确实不重复后, 不希望它一直占着「已忽略」列表, 所以需要第二档(2026-10-24 用户需求)。
 * 键是 images.id 的 "小id|大id" 字符串 —— id 在「移动=改址」与重启之间稳定;
 * 唯一失效场景是整库推倒重导(db:import:force 后 id 重排), 那时记录静默失效(最多恢复显示, 无害)。
 *
 * 存储: dataDir/user/dupcheck_ignore.json(路由见 paths.js DATA_ROUTE)。
 * 结构: { version: 2, pairs: ["12|345", ...], blocked: [...], updated_at: ISO }
 * 老文件没有 blocked 字段 -> 当空表读, 向后兼容。
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'

const NAME = 'dupcheck_ignore.json'

let cache = null // { pairs: Set<string>, blocked: Set<string> }

function file() { return dataFile(NAME) }

function readRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return {
      pairs: Array.isArray(j?.pairs) ? j.pairs : [],
      blocked: Array.isArray(j?.blocked) ? j.blocked : [],
    }
  } catch { /* 不存在/损坏 -> 空表 */ }
  return { pairs: [], blocked: [] }
}

function ensure() {
  if (!cache) {
    const raw = readRaw()
    cache = { pairs: new Set(raw.pairs), blocked: new Set(raw.blocked) }
  }
  return cache
}

/** 规范化一对 id 为 "小|大" 键; 非法输入返回 null */
export function pairKey(a, b) {
  const x = Number(a), y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === y) return null
  return x < y ? `${x}|${y}` : `${y}|${x}`
}

/** 当前全部忽略键(只读副本) */
export function loadIgnorePairs() {
  return new Set(ensure().pairs)
}

/** 当前全部永久忽略键(只读副本); 扫描时与 loadIgnorePairs() 取并集 */
export function loadBlockedPairs() {
  return new Set(ensure().blocked)
}

/** 批量加入; 元素是 [idA, idB] 或 "a|b" 字符串。返回实际新增数 */
export function addIgnorePairs(list = []) {
  const c = ensure()
  let n = 0
  for (const it of list) {
    const k = Array.isArray(it) ? pairKey(it[0], it[1])
      : (typeof it === 'string' && /^\d+\|\d+$/.test(it) ? it : null)
    if (!k || c.pairs.has(k)) continue
    c.pairs.add(k)
    n++
  }
  if (n) flush()
  return n
}

/** 清空; 返回清掉的数量 */
export function clearIgnorePairs() {
  const c = ensure()
  const n = c.pairs.size
  c.pairs.clear()
  if (n) flush()
  return n
}

/**
 * 恢复一组: 只删「两端都在给定 id 集合里」的对。
 * 用 id 集合而不是让前端生成两两组合, 入参更小, 也能顺手清掉组内遗留的旧对。
 */
export function removeIgnorePairsByIds(ids = []) {
  const set = new Set((ids || []).map(Number).filter((n) => Number.isFinite(n)))
  if (set.size < 2) return 0
  const c = ensure()
  let n = 0
  for (const k of [...c.pairs]) {
    const [a, b] = k.split('|').map(Number)
    if (set.has(a) && set.has(b)) {
      c.pairs.delete(k)
      n++
    }
  }
  if (n) flush()
  return n
}

/**
 * 「🗑 删记录」: 把这一组从已忽略里删掉, 并把组内**所有两两组合**写进永久忽略。
 * 不只搬走现有的对 —— 用户可能先恢复过其中几条, 补全组合才能保证这组以后不再冒出来。
 * @returns {{removed:number, added:number, blocked:number}}
 */
export function blockIgnorePairsByIds(ids = []) {
  const set = new Set((ids || []).map(Number).filter((n) => Number.isFinite(n)))
  const c = ensure()
  if (set.size < 2) return { removed: 0, added: 0, blocked: c.blocked.size }
  let removed = 0
  let added = 0
  for (const k of [...c.pairs]) {
    const [a, b] = k.split('|').map(Number)
    if (set.has(a) && set.has(b)) {
      c.pairs.delete(k)
      removed++
    }
  }
  const arr = [...set]
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const k = pairKey(arr[i], arr[j])
      if (!k || c.blocked.has(k)) continue
      c.blocked.add(k)
      added++
    }
  }
  if (removed || added) flush()
  return { removed, added, blocked: c.blocked.size }
}

/** 恢复全部永久忽略(已忽略那份不受影响) */
export function clearBlockedPairs() {
  const c = ensure()
  const n = c.blocked.size
  c.blocked.clear()
  if (n) flush()
  return n
}

function flush() {
  try {
    const dir = file().replace(/[\\/][^\\/]+$/, '')
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({
      version: 2,
      pairs: [...ensure().pairs],
      blocked: [...ensure().blocked],
      updated_at: new Date().toISOString(),
    }, null, 1))
    fs.renameSync(tmp, file())
  } catch (e) {
    console.error('[dupignore] 写盘失败:', e?.message || e)
  }
}
