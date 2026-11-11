/**
 * 自然语言语料的**用户级管理**(2026-11-11)
 * ==========================================
 * 为什么单独一份文件, 不塞进高级替换的方案库 cfg:
 *   方案库是"导出时用哪套参数", 一条 cfg 只对当前方案生效; 而用户要的是
 *   "这条穿搭我永远不要" —— 换个方案、重开应用都该作数。入口在**标签页**
 *   (那里根本不知道当前选的是哪个导出方案), 所以只能是全局层。
 *
 * 与方案库的关系是**并集**, 不是替代:
 *   全局 nl_overrides.json(bannedIds / bannedKeys)
 *   + 当前方案 cfg.nl.banned(关键词)
 *   → 导出时一起交给 makeNlPicker。老方案里的黑名单不会因为这次的改动失效。
 *
 * 两种禁用粒度:
 *   bannedIds  —— 单条语料(条目 id = "<dim>::<en 归一>"), 精确到句
 *   bannedKeys —— 关键词, 命中 en/zh/kw/cat 任一即整条剔除(见 nl-bank.bannedHit)
 * 为什么都落到"整条": 一条 costume 就是"她穿着 A、B、C"一整套, 删片段留半套。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
// id 规则与 nl-bank 的列表/抽句共用一份实现, 这里只做读写与归一
import { nlEntryKey } from './nl-bank.js'

export { nlEntryKey }

const NAME = 'nl_overrides.json'

function normId(v) {
  const s = String(v || '').trim().toLowerCase()
  const i = s.indexOf('::')
  if (i <= 0) return ''
  return `${s.slice(0, i)}::${s.slice(i + 2).replace(/[\s_]+/g, ' ').trim()}`
}

function normKeys(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[,，;；]/)
  return [...new Set(arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
}

export function emptyOverrides() { return { bannedIds: [], bannedKeys: [] } }

function norm(raw) {
  const o = emptyOverrides()
  if (!raw || typeof raw !== 'object') return o
  if (Array.isArray(raw.bannedIds)) {
    o.bannedIds = [...new Set(raw.bannedIds.map(normId).filter(Boolean))]
  }
  o.bannedKeys = normKeys(raw.bannedKeys)
  return o
}

/** 读全局覆盖。文件缺失/损坏一律降级成空(和 nl-bank 缺知识包同思路, 不能抛) */
export function loadNlOverrides() {
  try {
    const p = dataFile(NAME)
    if (!fs.existsSync(p)) return emptyOverrides()
    return norm(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch {
    return emptyOverrides()
  }
}

function write(o) {
  try {
    const p = dataFile(NAME)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ version: 1, ...norm(o) }, null, 2), 'utf8')
    return { ok: true, error: '' }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 增量改覆盖(前端只发改动的部分, 不做整体覆盖 —— 两个窗口同时开也不会互相回滚)。
 *   { addIds, removeIds, addKeys, removeKeys, clear: 'ids'|'keys'|'all' }
 * @returns {{ok: boolean, error: string, overrides: {bannedIds: string[], bannedKeys: string[]}}}
 */
export function patchNlOverrides(body = {}) {
  const o = loadNlOverrides()
  const ids = new Set(o.bannedIds)
  const keys = new Set(o.bannedKeys)

  const addIds = Array.isArray(body.addIds) ? body.addIds : []
  for (const v of addIds) { const k = normId(v); if (k) ids.add(k) }
  const remIds = Array.isArray(body.removeIds) ? body.removeIds : []
  for (const v of remIds) { const k = normId(v); if (k) ids.delete(k) }
  for (const k of normKeys(body.addKeys)) keys.add(k)
  for (const k of normKeys(body.removeKeys)) keys.delete(k)

  if (body.clear === 'ids') ids.clear()
  else if (body.clear === 'keys') keys.clear()
  else if (body.clear === 'all') { ids.clear(); keys.clear() }

  const next = { bannedIds: [...ids], bannedKeys: [...keys] }
  const w = write(next)
  return { ok: w.ok, error: w.error, overrides: next }
}

/**
 * 把全局覆盖 + 方案级关键词合成 picker 的参数。
 * 导出链路只有一个拼装点(见 exporter.js), 所以口径统一在这里。
 * @param {{bannedKeys?: string[]}} global
 * @param {string|string[]} setBanned 当前方案的关键词黑名单
 */
export function mergeNlBan(global, setBanned) {
  const g = global && Array.isArray(global.bannedKeys) ? global.bannedKeys : []
  const s = Array.isArray(setBanned) ? setBanned : String(setBanned || '').split(/[,，;；]/)
  return {
    bannedIds: Array.isArray(global?.bannedIds) ? global.bannedIds : [],
    banned: [...new Set([...g, ...s.map((x) => String(x).trim().toLowerCase()).filter(Boolean)])],
  }
}
