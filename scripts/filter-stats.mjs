#!/usr/bin/env node
/**
 * 过滤组全库统计 —— 规则上真库跑一遍, 看影响面再决定接不接 UI
 * 运行: node scripts/filter-stats.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { applyFilterGroups } from '../electron/core/tagfilter.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const db = new DatabaseSync(path.join(REPO, 'data/tags.db'), { readOnly: true })
const slots = JSON.parse(readFileSync(path.join(REPO, 'knowledge/tag_slots.json'), 'utf8')).tags
const rules = JSON.parse(readFileSync(path.join(REPO, 'knowledge/filter-rules.json'), 'utf8'))
const counts = {}
for (const r of db.prepare('SELECT name, cnt FROM tags').all()) counts[r.name] = r.cnt

const ctx = { slots, counts, rules }
const byReason = new Map()     // reason -> { images: Set<未用>, drops, byTag: Map }
let scanned = 0, solo = 0, changed = 0, totalDrops = 0

const rows = db.prepare('SELECT tags FROM images WHERE gone=0').all()
for (const r of rows) {
  scanned++
  const tags = r.tags.split(',').map((s) => s.trim()).filter(Boolean)
  if (!tags.length) continue
  const before = tags.includes('1girl') || tags.includes('1boy')
  const { drops, changed: ch } = applyFilterGroups(tags, ctx)
  if (before) solo++
  if (!ch) continue
  changed++
  totalDrops += drops.length
  for (const d of drops) {
    if (!byReason.has(d.reason)) byReason.set(d.reason, { n: 0, byTag: new Map() })
    const b = byReason.get(d.reason)
    b.n++
    b.byTag.set(d.tag, (b.byTag.get(d.tag) || 0) + 1)
  }
}

console.log(`全库 ${scanned} 图 | 单人图 ${solo} | 被过滤组改动 ${changed} 图 (${(changed / scanned * 100).toFixed(1)}%) | 共 drop ${totalDrops} 词条\n`)
console.log('== 按规则统计 ==')
for (const [reason, b] of [...byReason.entries()].sort((a, c) => c[1].n - a[1].n)) {
  console.log(`${reason.padEnd(46)} drop ${String(b.n).padStart(6)}`)
  const top = [...b.byTag.entries()].sort((a, c) => c[1] - a[1]).slice(0, 5)
  console.log('    Top:', top.map(([t, n]) => `${t}(${n})`).join(', '))
}
