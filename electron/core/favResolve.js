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
  const roots = new Set()
  for (const r of items) {
    if (r?.path) {
      const parent = path.dirname(r.path)
      if (fs.existsSync(parent)) roots.add(parent)     // 原父目录: 可能只是同目录改名
    }
  }
  try {
    for (const f of listFolders().folders || []) {
      if (f?.path && fs.existsSync(f.path)) roots.add(f.path)
    }
  } catch { /* 扫描夹列表读不到就算了 */ }
  for (const q of quick) {
    if (q?.path && fs.existsSync(q.path)) roots.add(q.path)
  }
  if (ws?.dataDir && fs.existsSync(ws.dataDir)) roots.add(ws.dataDir)

  const updates = []
  for (const it of items) {
    if (!it?.path) continue
    // 1) 原路径还在 -> 什么都不用做
    if (fs.existsSync(it.path)) continue

    // 2) 失效 -> 按文件名搜
    const want = (it.name || path.basename(it.path) || '').toLowerCase()
    const found = []
    if (want) {
      for (const root of roots) {
        if (found.length || Date.now() > deadline) break
        searchTree(root, want, found, deadline)
      }
    }
    if (found.length) {
      const fp = found[0]
      updates.push({ from: it.path, found: fp, tags: refreshTags(fp) })
    } else {
      updates.push({ from: it.path, found: null })
    }
  }
  return { updates, scannedRoots: roots.size }
}
