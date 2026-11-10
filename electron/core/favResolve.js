/**
 * 按文件名找回失效的收藏
 * ========================
 * 用户会把收藏的图在**应用外**(资源管理器/Syncthing)挪来挪去 —— 收藏记录里的
 * 路径随时可能失效, 但文件名不变。这里对失效记录做一次定向搜索:
 *
 *   搜索根 = 扫描文件夹(scan_folders.json) + 预设文件夹(settings.quickFolders)
 *          + 数据目录(dataDir) + 原记录的父目录(可能只是改名没挪窝)
 *
 *   规则: 文件名相等(不区分大小写)即命中; 递归但**限深限总时长**, 拿到全部
 *   命中就收工 —— 找回是尽力而为, 不能为了找一张图把整块盘翻一遍。
 *
 * 命中的记录顺带重读一次 PNG 元数据刷新标签快照(文件回来了, 标签以文件为准)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspace, getSettings } from './workspace.js'
import { listFolders } from './folders.js'
import { extractImagePrompt } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'

const MAX_DEPTH = 6                 // 目录深度上限
const TIME_BUDGET_MS = 4000         // 整次调用的搜索时间预算
const SKIP = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git'])

/** 递归收集目录树下与目标文件名(小写)相等的文件; 限深限时报到就收 */
function searchTree(root, wantLower, found, deadline) {
  if (found.length >= 3 || Date.now() > deadline) return
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  const dirs = []
  for (const ent of entries) {
    if (SKIP.has(ent.name.toLowerCase())) continue
    const full = path.join(root, ent.name)
    if (ent.isFile()) {
      if (ent.name.toLowerCase() === wantLower) found.push(full)
      if (found.length >= 3) return
    } else if (ent.isDirectory()) {
      dirs.push(full)
    }
  }
  for (const d of dirs) {
    if (found.length >= 3 || Date.now() > deadline) return
    searchTree(d, wantLower, found, deadline)
  }
}

/** 重新读一次图片元数据, 返回标签快照(读不到就空数组) */
function refreshTags(fp) {
  try {
    const r = extractImagePrompt(fp)
    return r?.text ? dedupeTags(promptToTags(r.text)) : []
  } catch { return [] }
}

/**
 * @param {Array<{path:string, name:string}>} items 收藏记录(渲染层原样发来)
 * @returns {{updates: Array<{from:string, found:string|null, tags?:string[]}>}}
 */
export function resolveFavorites(items = []) {
  const ws = getWorkspace()
  const quick = Array.isArray(getSettings().quickFolders) ? getSettings().quickFolders : []
  const deadline = Date.now() + TIME_BUDGET_MS

  // 搜索根集合(去重 + 只留存在的目录)
  //
  // **顺序就是优先级**(2026-11-08 修): 原来的顺序把最小的 dataDir 排最后,
  // 登记的大图库先把预算吃光, dataDir 根本没机会被搜到。改成「便宜的先搜」。
  //
  // **按根遍历而不是按条目遍历**(2026-11-10 修): 原来逐条目串行、4 秒预算整段共享 ——
  // 前面那条搜不到的(真删了的图)会把后面条目的预算全吃光: e2e 实锤, 收藏 [a2(已删),
  // a1(被挪走)] 里 a2 先把 20 个登记根走完, 轮到 a1 时 deadline 已过 -> a1 被误标
  // 「文件已不在」。改成按根走: 每个根里把**所有还没找回的条目**都搜一遍, 便宜根
  // (原父目录/dataDir/快捷目录)先扫完一轮, 大图库根放第二遍 —— a1 这类「文件就在
  // dataDir 根上」的命中不再被前面的死条目饿死。
  const cheapRoots = new Set()    // 小: 原父目录 + 数据目录 + 快捷目录
  const costlyRoots = new Set()   // 大: 登记过的真实图库, 只该在便宜根都没命中时才搜
  for (const r of items) {
    if (r?.path) {
      const parent = path.dirname(r.path)
      if (fs.existsSync(parent)) cheapRoots.add(parent)  // 原父目录: 可能只是同目录改名
    }
  }
  // 数据目录: 文件最少、命中概率最高(应用自己搬进去的东西都在这儿)
  if (ws?.dataDir && fs.existsSync(ws.dataDir)) cheapRoots.add(ws.dataDir)
  // 用户手挑的常用目录: 数量少, 通常也小
  for (const q of quick) {
    if (q?.path && fs.existsSync(q.path)) cheapRoots.add(q.path)
  }
  try {
    // usage:'all' —— 找回是"尽力而为"的搜索, 登记过的目录(看板来源 + 扫描夹 +
    // 已注销的/已移出的)都算搜索根, 不能只认扫描夹那一档。
    for (const f of listFolders({ usage: 'all' }).folders || []) {
      if (f?.path && fs.existsSync(f.path)) costlyRoots.add(f.path)
    }
  } catch { /* 登记表读不到就算了 */ }

  // 待找回清单(原路径还在的直接跳过)
  const pending = []
  for (const it of items) {
    if (!it?.path) continue
    if (fs.existsSync(it.path)) continue                       // 1) 原路径还在, 什么都不用做
    const want = (it.name || path.basename(it.path) || '').toLowerCase()
    if (want) pending.push({ it, want, found: [] })            // 2) 失效 -> 按文件名搜
  }

  // 一轮 = 沿一个根把所有未命中的条目都搜一遍; 命中的当场收兵
  const runPass = (rootSet) => {
    for (const root of rootSet) {
      const alive = pending.filter((p) => !p.found.length)
      if (!alive.length || Date.now() > deadline) return
      for (const p of alive) searchTree(root, p.want, p.found, deadline)
    }
  }
  runPass(cheapRoots)
  runPass(costlyRoots)

  const updates = pending.map((p) => (
    p.found.length
      ? { from: p.it.path, found: p.found[0], tags: refreshTags(p.found[0]) }
      : { from: p.it.path, found: null }
  ))
  return { updates, scannedRoots: cheapRoots.size + costlyRoots.size }
}
