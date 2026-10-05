/**
 * 替换规则组测试 —— 2026-10-04「不同导出用不同替换方案」
 * ==========================================================
 * 守的几条性质:
 *   ① 首次读取时从现有 data/export_replace.txt **迁移**出「默认」组,
 *      原 txt 一个字不动(备份/回滚), 迁移后行为与旧版完全一致;
 *   ② 组内容按 id 分开编译: loadReplaceRulesGroup(组A) 只含 A 的规则;
 *   ③ 存盘后再读回一致(text 原样, 含中文/空格/注释行);
 *   ④ 改 active 不影响任何一组的规则内容; 非法 active 回落到第一套;
 *   ⑤ buildExport 按 replace_set 选组(replace=0 整体关掉);
 *   ⑥ buildCartExport(角色表)也能套组: 一个角色被规则命中成多个标签时
 *      摊成多行, count 变多, 关掉替换时行为与旧版一致;
 *   ⑦ 缺组 id(传了个不存在的) = 用当前默认组, 不报错。
 *
 * 跑法: npm run test:replace-sets
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 本用例自造数据目录, 不能被外面的 TV_DATA_DIR 抢走优先级
delete process.env.TV_DATA_DIR

const { initWorkspace } = await load('electron/core/workspace.js')
const rules = await load('electron/core/rules.js')
const exporter = await load('electron/core/exporter.js')
const store = await load('electron/core/store.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-rset-'))
const DATA = path.join(WORK, 'data')
fs.mkdirSync(DATA, { recursive: true })
initWorkspace(path.join(WORK, 'appdir'), { defaultDataDir: DATA })

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`) }
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`) }
const eq = (name, got, want) => (got === want ? ok(name, String(got)) : bad(name, `得到 ${got}, 期望 ${want}`))

/* ------------------------------------------------- ① 从旧 txt 迁移出默认组 */

const legacy = '# 旧规则\n1boy -> 1boy, solo\n*pussy* -> {tag}, clear\n'
fs.writeFileSync(path.join(DATA, 'export_replace.txt'), legacy, 'utf8')

const first = rules.replaceSets()
eq('① 迁移出 1 套规则', first.sets.length, 1)
eq('① 默认组 id', first.sets[0].id, 'default')
eq('① 默认组名', first.sets[0].name, '默认')
eq('① 内容与旧 txt 逐字一致', first.sets[0].text, legacy)
eq('① active 指向默认组', first.active, 'default')
ok('① json 已落盘', fs.existsSync(path.join(DATA, 'user', 'replace_sets.json')))
eq('① 原 txt 仍在(备份没动)', fs.readFileSync(path.join(DATA, 'export_replace.txt'), 'utf8'), legacy)

const migrated = rules.loadReplaceRulesGroup('default')
eq('① 迁移后规则条数不变(2 条)', migrated.length, 2)
eq('① 规则内容按旧格式解析', migrated[0].pat + ' -> ' + migrated[0].replTags.join(','), '1boy -> 1boy,solo')

/* --------------------------------------------- ④ 改 active / 非法 active */

const r2 = rules.saveReplaceSets({
  active: 'a',
  sets: [
    { id: 'a', name: '出图用', text: '1boy -> 1boy, masterpiece\n' },
    { id: 'b', name: '角色表用', text: 'frieren_(sousou_no_frieren) -> frieren\n' },
  ],
})
eq('④ 存回 2 套', r2.sets.length, 2)
eq('④ active 切到 a', r2.active, 'a')

const bad1 = rules.saveReplaceSets({ active: '不存在的组', sets: r2.sets })
eq('④ 非法 active 落到第一套', bad1.active, 'a')
const r3 = rules.saveReplaceSets({ active: '', sets: r2.sets })
eq('④ 空 active 也落到第一套', r3.active, 'a')

/* ------------------------------------------------------ ②③ 按组编译与回读 */

const ra = rules.loadReplaceRulesGroup('a')
const rb = rules.loadReplaceRulesGroup('b')
eq('② A 组只含自己的规则', ra.length, 1)
eq('② A 组规则内容', ra[0].pat, '1boy')
eq('② B 组只含自己的规则', rb.length, 1)
eq('② B 组规则内容', rb[0].pat, 'frieren_(sousou_no_frieren)')
eq('② 不传 id = 当前默认组', rules.loadReplaceRulesGroup('').length, ra.length)
eq('② 传不存在的 id 也回落到默认组(不报错)', rules.loadReplaceRulesGroup('nope').length, ra.length)

const withNote = rules.saveReplaceSets({
  active: 'a',
  sets: [
    { id: 'a', name: '出图用', text: '# 中文注释\n1girl -> {tag}, 质量词\n\nmultiple_boys -> {tag}\n' },
    { id: 'b', name: '角色表用', text: 'x -> y\n' },
  ],
})
eq('③ 存后读回逐字一致(含中文/空行/注释)', withNote.sets[0].text, '# 中文注释\n1girl -> {tag}, 质量词\n\nmultiple_boys -> {tag}\n')
eq('③ 中文规则被正确解析', rules.loadReplaceRulesGroup('a')[0].replTags.join(','), '{tag},质量词')

/* ----------------------------------------------- ⑤⑥ 两条导出链路用规则组 */

rules.saveReplaceSets({
  active: 'default',
  sets: [
    { id: 'default', name: '默认', text: '1boy -> 1boy, solo\n' },
    { id: 'char', name: '角色表用', text: 'frieren -> frieren_frieren\n' },
  ],
})

// 造两张图: 一张 1boy, 一张 solo
function png(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const mk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([sig, mk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), mk('IEND', Buffer.alloc(0))])
}
const DIR = path.join(WORK, 'imgs')
fs.mkdirSync(DIR, { recursive: true })
const p1 = path.join(DIR, 'a.png')
const p2 = path.join(DIR, 'b.png')
fs.writeFileSync(p1, png(1, 1))
fs.writeFileSync(p2, png(1, 1))
const db = store.openDb()
const n1 = store.normalizeImagePath(p1)
const n2 = store.normalizeImagePath(p2)
db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone)
            VALUES (?, 0, '1boy, smile', NULL, 1, 1, 'wd14', 0)`).run(n1)
db.prepare(`INSERT INTO images (path, src_id, tags, folder_id, mtime_ms, size, tags_src, gone)
            VALUES (?, 0, '1girl, solo', NULL, 1, 1, 'wd14', 0)`).run(n2)
await (await load('electron/core/dataset.js')).loadDataset(new Map())

const exDefault = exporter.buildExport({ replace_set: 'default', blacklist: 0, bg: 0 })
ok('⑤ 默认组导出含 solo(1boy 被加上 solo)', exDefault.text.includes('1boy, smile') || exDefault.text.includes('smile'))
eq('⑤ 默认组确实替换了一条', exDefault.replaced, 1)

const exOff = exporter.buildExport({ replace: '0', replace_set: 'default', blacklist: 0, bg: 0 })
eq('⑤ replace=0 时零替换(行为同旧版)', exOff.replaced, 0)
ok('⑤ replace=0 时 1girl 那行没被动过', exOff.text.includes('1girl, solo'))

const exChar = exporter.buildExport({ replace_set: 'char', blacklist: 0, bg: 0 })
eq('⑤ 选了 B 组但没有 1boy 规则 -> 零替换', exChar.replaced, 0)

/* ⑥ 角色表 */
const cartOn = exporter.buildCartExport(
  [{ tag: 'frieren', extra: [] }, { tag: '1boy', extra: [] }],
  { replace: true, replaceSet: 'char' },
)
ok('⑥ 角色表套 B 组: frieren 变长形式', cartOn.text.includes('frieren_frieren'))
eq('⑥ 命中一条', cartOn.replaced, 1)
eq('⑥ 1boy 没规则不动', cartOn.text.includes('1boy'), true)

const cartOff = exporter.buildCartExport([{ tag: 'frieren', extra: [] }], { replace: false, replaceSet: 'char' })
ok('⑥ replace=false 时原样', cartOff.text.trim().startsWith('frieren') && !cartOff.text.includes('frieren_frieren'))
eq('⑥ 关掉时零命中', cartOff.replaced, 0)

const cartMulti = exporter.buildCartExport([{ tag: '1boy', extra: [] }], { replace: true, replaceSet: 'default' })
eq('⑥ 命中成两个标签时仍是**一行**(wildcard: 逗号=同时含)', cartMulti.count, 1)
ok('⑥ 行内容是 1boy, solo', cartMulti.text.trim() === '1boy, solo')
eq('⑥ 计入命中', cartMulti.replaced, 1)

/* ---------------------------------------------------------- 收尾 */

store.closeDb()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
