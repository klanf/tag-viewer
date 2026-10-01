/**
 * tagedit.js 副本彩排 —— 临时目录造库, 验证改名/删除/范围删除/子串不误伤/去重合并。
 * 跑法: node --experimental-sqlite scripts/test-tagedit.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-tagedit-'))
process.env.TV_DATA_DIR = tmp

// ⚠️ 必须先 initWorkspace: workspace.js 的 dataDir 由它裁决, 不初始化 dataDir=''
//    -> dataFile('tags.db') 落成相对路径 -> 在 CWD 里静默建了个空库(踩过)。
const { initWorkspace } = await import('../electron/core/workspace.js')
initWorkspace(tmp, {})

// schema 一律用 store 自己的 openDb 建(完整 SCHEMA + 迁移), 测试里别手写最小表 ——
// 手写的缺列表会让 store 的迁移炸在半路(踩过: no such column: src_id)。
const { openDb, closeDb } = await import('../electron/core/store.js')
const seed = openDb()
seed.exec(`
  CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY, path TEXT, tags TEXT, gone INTEGER DEFAULT 0);
  DELETE FROM images; DELETE FROM tags;
`)
const ins = seed.prepare('INSERT INTO images (path, src_id, tags) VALUES (?, 0, ?)')
ins.run('a.png', 'frieren, closed_eyes, fern_(sousou_no_frieren)')
ins.run('b.png', 'fern_(sousou_no_frieren), ubel_(sousou_no_frieren)')
ins.run('c.png', 'frieren')
ins.run('d.png', 'fern_(sousou_no_frieren), closed_eyes')
ins.run('e.png', 'frieren, fern_(sousou_no_frieren)')   // 两者都有 -> 改名时去重
ins.run('f.png', 'columbina_(genshin_impact), closed_eyes')
ins.run('g.png', 'closed_eyes')

const { previewTagEdit, applyTagEdit } = await import('../electron/core/tagedit.js')

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name} ${extra}`) }
}
/** 只读探针: 每次新开连接(前面踩过: 旧闭包拿着已 close 的连接 -> database is not open) */
const { DatabaseSync } = await import('node:sqlite')
const probe = () => new DatabaseSync(path.join(tmp, 'tags.db'), { readOnly: true })
const row = (p, con) => con.prepare('SELECT tags FROM images WHERE path = ?').get(p)?.tags

// 1) 预览
const p1 = previewTagEdit({ op: 'rename', from: 'frieren', to: 'frieren_(sousou_no_frieren)' })
check('预览改名 frieren = 3 张', p1.count === 3, `got ${p1.count}`)
check('预览: 目标不存在 existsTarget=0', p1.existsTarget === 0)
const p2 = previewTagEdit({ op: 'delete', from: 'closed_eyes', scopeTag: 'columbina_(genshin_impact)' })
check('预览范围删除 = 1 张', p2.count === 1, `got ${p2.count}`)

// 2) 改名: 子串不得误伤 fern_(sousou_no_frieren) / ubel_(...)
const r1 = applyTagEdit({ op: 'rename', from: 'frieren', to: 'frieren_(sousou_no_frieren)' })
check('改名命中 3 行', r1.changed === 3, `got ${r1.changed}`)
check('备份文件已生成', !!r1.backup && fs.existsSync(r1.backup), String(r1.backup))
{
  const con = probe()
  check('e.png 两写法并存 -> 去重成单份', row('e.png', con) === 'frieren_(sousou_no_frieren), fern_(sousou_no_frieren)', row('e.png', con))
  check('b.png 不受影响(子串保护)', row('b.png', con) === 'fern_(sousou_no_frieren), ubel_(sousou_no_frieren)', row('b.png', con))
  const tgt = con.prepare("SELECT name, cnt, kind FROM tags WHERE name = 'frieren_(sousou_no_frieren)'").get()
  check('tags 总表: 新名 cnt=3 kind=char', JSON.stringify(tgt) === JSON.stringify({ name: 'frieren_(sousou_no_frieren)', cnt: 3, kind: 'char' }), JSON.stringify(tgt))
  check('tags 总表: 裸名已消失', !con.prepare("SELECT 1 FROM tags WHERE name = 'frieren'").get(), '')
  con.close()
}

// 3) 范围删除: 只删同时含范围标签的图上的 closed_eyes
const r2 = applyTagEdit({ op: 'delete', from: 'closed_eyes', scopeTag: 'columbina_(genshin_impact)' })
check('范围删除只命中 1 行(哥伦比亚那张)', r2.changed === 1, `got ${r2.changed}`)
{
  const con = probe()
  check('a.png 的 closed_eyes 还在', row('a.png', con).includes('closed_eyes'), row('a.png', con))
  check('f.png 的 closed_eyes 已删', !row('f.png', con).includes('closed_eyes'), row('f.png', con))
  check('g.png 的 closed_eyes 还在(不在范围)', row('g.png', con) === 'closed_eyes', row('g.png', con))
  con.close()
}

// 4) 全库删除
const r3 = applyTagEdit({ op: 'delete', from: 'closed_eyes' })
check('全库删除命中剩余 3 行', r3.changed === 3, `got ${r3.changed}`)
{
  const con = probe()
  check('closed_eyes 从 tags 总表消失', !con.prepare("SELECT 1 FROM tags WHERE name = 'closed_eyes'").get(), '')
  con.close()
}

console.log(`\n${pass} pass / ${fail} fail @ ${tmp}`)
closeDb()   // store 单例连接不关, Windows 上 rmSync 会 EBUSY
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
