/**
 * 标签改名 / 删除(2026-10-01 新功能)
 * ==================================
 * 用户诉求: WD14 认不出来的角色写法不对(裸 frieren 应为 frieren_(sousou_no_frieren)),
 * 以及「只删某些图上的标签」(哥伦比亚图上的 closed_eyes) —— 手工改库不可复现,
 * 这里做成两个纯操作 + 三重保险:
 *
 *   1. **先预览**: 返回会命中多少张图, 界面确认后再执行。
 *   2. **先备份**: applyTagEdit 每次执行前 backupDb() 一份 tags.db
 *      (store.js 的现成机制, 时间戳后缀, 不会覆盖旧备份)。
 *   3. **事务写入**: images 逐行改完立即 rebuildTags() 重算 tags 总表
 *      (cnt 与 kind 都从 images 重新推导, kind 里的"括号=角色"正则自动把
 *      frieren_(sousou_no_frieren) 认成 char —— 这正是改名想要的效果)。
 *
 * **为什么不用 SQL REPLACE / LIKE 匹配**:
 *   · REPLACE 暴力子串替换会把 `fern_(sousou_no_frieren)` 之类含 `frieren` 的
 *     长标签一起毁掉 —— 必须按**逗号 token 精确匹配**;
 *   · LIKE 的 `%`/`_` 通配符又恰是标签里的常客(下划线), 转义规则防不住所有手滑。
 * 所以预览与执行都是**全量行读进内存、JS 里按 token 精确比对**(与 dataset.js 的
 * 解析口径一致: 按逗号拆、trim; 4 万行毫秒级, 不值得写 SQL 微操)。
 *
 * 连带同步(改名时): 翻译库 key(local_translations.json)与角色库 key
 * (character_library.json 的 chars) —— 两个都是「key=标签名」的字典, 改名不改 key
 * 就等于翻译/角色档案丢失。删除不做这两步(留下的孤儿 key 无害)。
 */
import fs from 'node:fs'
import { dataFile } from './workspace.js'
import { openDb, backupDb, rebuildTags } from './store.js'
import { blacklistText, saveBlacklistText } from './rules.js'

const TAG = 'tag-edit'

/** 逗号 token 精确读写 images.tags 列(与 store.js 解析口径一致) */
function tokensOf(s) {
  return String(s || '').split(',').map((t) => t.trim()).filter(Boolean)
}

/**
 * 预览: 返回 { count: 会命中的图片数(gone=0), existsTarget: 改名目标已存在的标记 }。
 */
export function previewTagEdit({ op, from, to, scopeTag } = {}) {
  const f = String(from || '').trim()
  const s = String(scopeTag || '').trim()
  if (!f) throw new Error('缺少要修改的标签名')
  if (op === 'rename') {
    const t = String(to || '').trim()
    if (!t) throw new Error('缺少改名后的标签名')
    if (t === f) throw new Error('新旧标签名相同')
  }
  const db = openDb()
  let count = 0
  const rows = db.prepare('SELECT tags FROM images WHERE gone = 0').all()
  for (const r of rows) {
    const toks = tokensOf(r.tags)
    if (!toks.includes(f)) continue
    if (s && !toks.includes(s)) continue
    count++
  }
  let existsTarget = 0
  if (op === 'rename') {
    existsTarget = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE name = ?').get(String(to).trim()).n
  }
  return { count, existsTarget }
}

/**
 * 执行修改。返回 { changed: 实际改写的图片行数, backup: 备份文件路径, tagsStat, synced }。
 * - rename: 把每行的 from token 换成 to; 若该行本来就有 to, 只去掉 from(防重复 token)。
 * - delete: 把 from token 从行里拿掉; scopeTag 给定时只动「同时含 scopeTag」的行。
 * 改完 images 后统一 rebuildTags()(全量重算, 26k 标签毫秒级, 不值得做增量合并)。
 */
export function applyTagEdit({ op, from, to, scopeTag } = {}) {
  const f = String(from || '').trim()
  const t = String(to || '').trim()
  const s = String(scopeTag || '').trim()
  if (!f) throw new Error('缺少要修改的标签名')
  if (op === 'rename' && (!t || t === f)) throw new Error('改名目标为空或与原名相同')

  // backupDb 同名会跳过(设计如此, 防重复备份) -> 后缀必须带时间戳, 每次都留新档
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupRes = backupDb(`tag-edit-${stamp}`)
  const backup = backupRes?.file || ''

  const db = openDb()
  const rows = db.prepare('SELECT id, tags FROM images').all()

  db.exec('BEGIN')
  let changed = 0
  try {
    const upd = db.prepare('UPDATE images SET tags = ? WHERE id = ?')
    for (const r of rows) {
      const toks = tokensOf(r.tags)
      if (!toks.includes(f)) continue
      if (op === 'delete' && s && !toks.includes(s)) continue
      let next
      if (op === 'rename') {
        const seen = new Set()
        next = []
        for (const tok of toks) {
          let v = tok === f ? t : tok
          if (seen.has(v)) continue          // 行里本来就有 to -> 只去掉 from
          seen.add(v)
          next.push(v)
        }
      } else {
        next = toks.filter((tok) => tok !== f)
      }
      const joined = next.join(', ')
      if (joined !== String(r.tags || '')) { upd.run(joined, r.id); changed++ }
    }

    if (op === 'rename') {
      // tags 总表: 整体改名(目标已存在也无所谓, rebuildTags 会合并计数)
      db.prepare('UPDATE tags SET name = ? WHERE name = ?').run(t, f)
    }

    /* 连带: 黑名单里的**精确行**(改名时) —— 黑名单支持通配, 只同步恰好等于原名的行,
       通配规则(如 frier*)不动: 用户写通配就是想按模式匹配, 替他改语义反而危险。 */
    if (op === 'rename') {
      try {
        const text = blacklistText()
        const lines = text.split('\n')
        let hit = false
        const next = lines.map((ln) => {
          if (ln.trim() === f) { hit = true; return ln.replace(f, t) }
          return ln
        })
        if (hit) saveBlacklistText(next.join('\n'))
      } catch { /* 黑名单读不到就跳过, 不挡主流程 */ }
    }

    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  }

  // 重建 tags 总表(cnt/kind 全量重算) —— 必须在 COMMIT 之后, rebuildTags 自己开事务
  const tagsStat = rebuildTags()

  /* 连带 JSON 字典(改名时): key 改了 value 不动。写前各自留一份 .bak(一次性,
     不轮转 —— 这两个文件平时没人动, 真要翻旧账时 git/回收站都兜得住)。 */
  let synced = {}
  if (op === 'rename') {
    synced = renameJsonKey(f, t)
  }

  return { changed, backup, tagsStat, synced }
}

/** 翻译库 + 角色库的 key 改名。返回 { translations: 'renamed'|'absent', charlib: 同左 } */
function renameJsonKey(from, to) {
  const out = {}
  for (const [name, key] of [['translations', 'local_translations.json'], ['charlib', 'character_library.json']]) {
    const p = dataFile(key)
    try {
      if (!fs.existsSync(p)) { out[name] = 'absent'; continue }
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (!(from in j) || to in j) { out[name] = 'absent'; continue }
      fs.copyFileSync(p, `${p}.bak-${TAG}`)
      const next = {}
      for (const [k, v] of Object.entries(j)) next[k === from ? to : k] = v
      const tmp = `${p}.tmp${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      fs.renameSync(tmp, p)
      out[name] = 'renamed'
    } catch (e) {
      out[name] = `error: ${e?.message || e}`
    }
  }
  return out
}
