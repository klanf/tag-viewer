/**
 * tagcats 分类器测试(2026-10-16) —— 纯 Node, 不启 Electron
 * 覆盖: 段位判定 / 韦林大类 / 裸名角色→系列 / school_uniform 污染护栏 /
 *       稳定排序 / sortTagString 幂等 / 导出段位过滤 / 字典 cat 回填
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const load = async (p) => await import(new URL(`../${p}`, import.meta.url))
const tagcats = await load('electron/core/tagcats.js')
const store = await load('electron/core/store.js')
const workspace = await load('electron/core/workspace.js')
const exportPresets = await load('electron/core/exportPresets.js')

let n = 0
function ok(name, fn) {
  try { fn(); console.log('  ✓', name); n++ }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1 }
}
async function okA(name, fn) {
  try { await fn(); console.log('  ✓', name); n++ }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1 }
}

/* ---------- ① 注入数据源做确定性单测(不依赖本机文件) ---------- */
tagcats.injectForTest({
  weilin: new Map([
    ['silver hair', '人物'], ['thighhighs', '服饰'], ['school uniform', '服饰'],
  ]),
  chars: new Set(['frieren', 'kazusa_(blue_archive)', 'miko_(blue_archive)']),
  series: new Set(['blue_archive']),
  bare: new Map([['kazusa', new Set(['blue_archive'])], ['miko', new Set(['blue_archive', 'hololive'])]]),
})

console.log('① classify 段位判定')
ok('人数: 1girl/2girls/solo/multiple_girls', () => {
  for (const t of ['1girl', '2girls', '3boys', '6+girls', '1other', 'solo', 'multiple_girls']) {
    assert.equal(tagcats.classify(t).seg, 'count', t)
  }
})
ok('画师: @开头', () => assert.equal(tagcats.classify('@nnn yryr').seg, 'artist'))
ok('括号角色 + 系列内嵌', () => {
  const c = tagcats.classify('kazusa_(blue_archive)')
  assert.equal(c.seg, 'char'); assert.equal(c.series, 'blue_archive')
})
ok('括号里是分类组名的不算角色(smile_(medium))', () => {
  assert.notEqual(tagcats.classify('smile_(medium)').seg, 'char')
})
ok('裸名角色(WD14 词表直收, 如 frieren) -> char', () =>
  assert.equal(tagcats.classify('frieren').seg, 'char'))
ok('裸名角色(括号反推) -> char + 唯一系列', () => {
  const c = tagcats.classify('kazusa')
  assert.equal(c.seg, 'char'); assert.equal(c.series, 'blue_archive')
})
ok('裸名对应多个系列 -> char 但系列留空(歧义不猜)', () => {
  const c = tagcats.classify('miko')
  assert.equal(c.seg, 'char'); assert.equal(c.series, '')
})
ok('系列名本体 -> series', () => assert.equal(tagcats.classify('blue_archive').seg, 'series'))
ok('韦林分类(空格/下划线两变体都能命中)', () => {
  assert.equal(tagcats.classify('silver_hair').sub, '人物')
  assert.equal(tagcats.classify('thighhighs').sub, '服饰')
})
ok('meta: highres/year/score_*', () => {
  for (const t of ['highres', 'absurdres', 'year_2026', 'score_9', 'masterpiece']) {
    assert.equal(tagcats.classify(t).seg, 'meta', t)
  }
})
ok('规则兜底: 镜头/画面/表情动作/物品/场景/环境', () => {
  assert.equal(tagcats.classify('upper_body').sub, '镜头')
  assert.equal(tagcats.classify('white_background').sub, '画面')
  assert.equal(tagcats.classify('looking_at_viewer').sub, '表情动作')
  assert.equal(tagcats.classify('umbrella').sub, '物品')   // holding 类动词归动作, 纯物品词才归物品
  assert.equal(tagcats.classify('classroom').sub, '场景')
  assert.equal(tagcats.classify('night_sky').sub, '环境')
})
ok('实在没接住 -> other(宁可漏分不错分)', () => {
  assert.equal(tagcats.classify('wtf_random_xyz_qq').seg, 'other')
})

console.log('② 排序语义')
ok('官方段位顺序: 人数→角色→系列→画师→通用→meta→other', () => {
  const out = tagcats.sortTags(['highres', 'blue_archive', '@artist', 'silver_hair', 'kazusa_(blue_archive)', '1girl', 'zzz_unknown'])
  assert.deepEqual(out, ['1girl', 'kazusa_(blue_archive)', 'blue_archive', '@artist', 'silver_hair', 'highres', 'zzz_unknown'])
})
ok('同段内保持原相对顺序(稳定)', () => {
  const out = tagcats.sortTags(['smile', 'silver_hair', 'sitting'])
  assert.deepEqual(out, ['silver_hair', 'smile', 'sitting'])   // 人物(服饰?) — silver_hair=人物 先于 动作; smile/sitting 同为动作保持原序
})
ok('sortTagString: 顺序没变时原串原样返回(字节级不动)', () => {
  const s = '1girl,solo'
  assert.equal(tagcats.sortTagString(s), s)
})
ok('sortTagString: 乱序串被重排', () => {
  const out = tagcats.sortTagString('highres,1girl,silver_hair')
  assert.equal(out, '1girl,silver_hair,highres')
})

console.log('③ 导出段位模式')
ok('exportSegSort: 滤掉 画师/角色/系列/meta, 人数排最前', () => {
  const out = tagcats.exportSegSort(['1girl', 'kazusa_(blue_archive)', 'blue_archive', '@nnn_yryr', 'highres', 'smile', 'school_uniform'])
  assert.deepEqual(out, ['1girl', 'school_uniform', 'smile'])
})
ok('normParams/toExportQuery 带上 seg_mode(默认关)', () => {
  const p1 = exportPresets.normParams({})
  assert.equal(p1.seg_mode, false)
  const p2 = exportPresets.normParams({ seg_mode: true })
  assert.equal(p2.seg_mode, true)
})

console.log('④ 字典 cat 回填(临时库, 不碰真实数据)')
await okA('rebuildTags 写 cat + ensureTagCats 幂等补齐', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cats-'))
  workspace.initWorkspace(tmp, { defaultDataDir: path.join(tmp, 'data') })
  const db = store.openDb()
  // path-check-ignore: 下一行 SQL 里的盘符是测试夹具假路径(冒号后随便写的), 不是真机路径
  db.prepare("INSERT INTO images (path, src_id, tags) VALUES ('x:/a.png', 0, '1girl,silver_hair,kazusa_(blue_archive)')").run()
  const r = store.rebuildTags()
  assert.equal(r.tags, 3)
  const rows = db.prepare('SELECT name, cat FROM tags ORDER BY name').all()
  const catOf = Object.fromEntries(rows.map((x) => [x.name, x.cat]))
  assert.equal(catOf['1girl'], 'count')
  assert.equal(catOf['kazusa_(blue_archive)'], 'char')
  assert.equal(catOf['silver_hair'], 'general:人物')
  // 模拟"字典里有行 cat 是空的"(老库/中断场景): 清掉一条再 ensure
  db.prepare("UPDATE tags SET cat = '' WHERE name = '1girl'").run()
  store._resetTagCatsMemo()   // openDb 时 memo 已置位, 测试里重置让它真正执行
  const filled = store.ensureTagCats(db)
  assert.ok(filled.filled >= 1, '至少补了 1 行')
  assert.equal(db.prepare("SELECT cat FROM tags WHERE name='1girl'").get().cat, 'count')
  store.closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

console.log('⑤ 与 dataset.js 的 NON_SERIES_GROUPS 一致性(防复制漂移)')
await okA('两份排除集合内容一致', async () => {
  const dataset = await load('electron/core/dataset.js')
  const a = dataset.NON_SERIES_GROUPS
  // tagcats 里不导出集合, 用行为等价校验: 每个组名都不被判成角色括号系列
  for (const g of a) {
    const c = tagcats.classify(`someone_(${g})`)
    assert.notEqual(c.seg, 'char', g)
  }
})

console.log(`\n结果: ${n} 通过${process.exitCode ? ' / 有失败' : ' / 0 失败'}`)
