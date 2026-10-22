/**
 * 查重误报忽略表(2026-10-17)
 * ============================
 * 用户在查重面板点了「非重复(忽略)」的图片对落在这里, 下次扫描同样的对
 * 不再出现。键是 images.id 的 "小id|大id" 字符串 —— id 在「移动=改址」与
 * 重启之间稳定; 唯一失效场景是整库推倒重导(db:import:force 后 id 重排),
 * 那时忽略表静默失效(最多恢复显示, 无害), 不做迁移。
 *
 * 存储: dataDir/user/dupcheck_ignore.json(路由见 paths.js DATA_ROUTE)。
 * 结构: { version: 1, pairs: ["12|345", ...], updated_at: ISO }
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'

const NAME = 'dupcheck_ignore.json'

let cache = null // { pairs: Set<string>, dirty: boolean }

function file() { return dataFile(NAME) }

function readRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (j && Array.isArray(j.pairs)) return j.pairs
  } catch { /* 不存在/损坏 -> 空表 */ }
  return []
}

function ensure() {
  if (!cache) cache = { pairs: new Set(readRaw()) }
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

function flush() {
  try {
    const dir = file().replace(/[\\/][^\\/]+$/, '')
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      pairs: [...ensure().pairs],
      updated_at: new Date().toISOString(),
    }, null, 1))
    fs.renameSync(tmp, file())
  } catch (e) {
    console.error('[dupignore] 写盘失败:', e?.message || e)
  }
}
