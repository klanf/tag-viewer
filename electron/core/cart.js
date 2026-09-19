/**
 * 结算历史 cart_history.json
 * { items: [{ name, created(ms), cart: { tag: {tag,name,series,thumb,images,t} } }] }
 * 与 Python 版共用同一份文件 —— 旧历史可以直接导入继续增删。
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'

const NAME = 'cart_history.json'

export function loadHistory() {
  const p = dataFile(NAME)
  const empty = { items: [] }
  if (!fs.existsSync(p)) return empty
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!d || typeof d !== 'object' || !Array.isArray(d.items)) return empty
    return d
  } catch {
    return empty
  }
}

function save(data) {
  try {
    fs.writeFileSync(dataFile(NAME), JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 按时间倒序的摘要列表(不含完整 cart, 免得一次传太大) */
export function historySummary() {
  const items = [...loadHistory().items]
  items.sort((a, b) => (b.created || 0) - (a.created || 0))
  return {
    items: items.map((it) => ({
      name: it.name || '',
      created: it.created || 0,
      count: Object.keys(it.cart || {}).length,
    })),
  }
}

/** 按名称取一条历史的完整 cart */
export function historyDetail(name) {
  const it = loadHistory().items.find((x) => x.name === name)
  if (!it) return { error: 'not found' }
  return { name, cart: it.cart || {} }
}

/** 保存/覆盖一条历史(name 重复视为对同一命名重新结算) */
export function saveHistory(name, cart) {
  const n = String(name || '').trim()
  if (!n || !cart || typeof cart !== 'object' || !Object.keys(cart).length) {
    return { error: 'name 或 cart 无效' }
  }
  const hist = loadHistory()
  const items = hist.items.filter((it) => it.name !== n)
  items.push({ name: n, created: Date.now(), cart })
  if (!save({ items })) return { error: '保存失败' }
  return { ok: true }
}

export function deleteHistory(name) {
  const n = String(name || '').trim()
  if (!n) return { error: 'empty name' }
  const hist = loadHistory()
  hist.items = hist.items.filter((it) => it.name !== n)
  if (!save(hist)) return { error: '保存失败' }
  return { ok: true }
}

/** 改名; 新名与已有冲突则报错 */
export function renameHistory(oldName, newName) {
  const a = String(oldName || '').trim()
  const b = String(newName || '').trim()
  if (!a || !b) return { error: 'name 不能为空' }
  if (a === b) return { ok: true }
  const hist = loadHistory()
  if (hist.items.some((it) => it.name === b)) return { error: `名称「${b}」已存在`, code: 409 }
  const it = hist.items.find((x) => x.name === a)
  if (!it) return { error: `找不到「${a}」`, code: 404 }
  it.name = b
  if (!save(hist)) return { error: '保存失败' }
  return { ok: true }
}
