/**
 * 标签库(tags.db)维护脚本
 * =========================
 *   node scripts/db.mjs info            看库里有什么(来源、条数、体积)
 *   node scripts/db.mjs import [--force]  把配置里的 tags_*.txt 同步进库
 *   node scripts/db.mjs export [目录]      把库里的数据写回 tags_*.txt
 *   node scripts/db.mjs reset           删库重建(下次启动会重新导入)
 *   node scripts/db.mjs verify          与 txt 逐条比对(校验导入无损)
 *
 * 平时**不需要跑这个** —— 应用启动时会自动同步(指纹没变就是空转)。
 * 只有"改了 txt 想立刻生效"或"想验证库与 txt 一致"时才手动跑。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localDataDir } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { initWorkspace } = await load('electron/core/workspace.js')
const { loadConfig, resolveDataFiles } = await load('electron/core/config.js')
const store = await load('electron/core/store.js')
const { streamTagFile } = await load('electron/core/tagfile.js')

// 与真实应用用同一个 userData(这样能读到 settings.json 里改过的 dataDir);
// 没有 settings 或里面没写 dataDir 时, 回落到 TV_DATA_DIR / 本机 local.config.json / 仓库内 data/。
const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TagViewer')
  : path.join(ROOT, '.selftest-userdata')
process.env.TV_DATA_DIR ||= localDataDir()
initWorkspace(APP_DIR)
const cfg = loadConfig()
const dataFiles = resolveDataFiles(cfg)

const cmd = (process.argv[2] || 'info').toLowerCase()
const arg = process.argv[3]

function mb(n) { return (n / 1048576).toFixed(1) + ' MB' }
function line(s = '') { console.log(s) }

if (cmd === 'info') {
  const info = store.dbInfo()
  line(`库文件 : ${info.path}`)
  if (info.error) { line(`状态   : 读取失败 -> ${info.error}`); process.exit(0) }
  line(`体积   : ${mb(info.bytes)}${info.walBytes ? ` (+WAL ${mb(info.walBytes)})` : ''}`)
  line(`来源数 : ${info.sources}`)
  line(`图片数 : ${info.images}`)
  line(`标签数 : ${info.tags} (其中角色标签 ${info.charTags})`)
  line()
  line('来源明细:')
  for (const s of info.sourceList || []) {
    line(`  ${String(s.name).padEnd(16)} ${String(s.records).padStart(7)} 条   txt ${mb(s.bytes).padStart(9)}   导入于 ${new Date(s.imported_at).toLocaleString('zh-CN')}`)
  }
  line()
  line('配置里的 txt 源:')
  for (const [name, fp] of dataFiles) {
    const ok = fs.existsSync(fp)
    line(`  ${name.padEnd(16)} ${ok ? '' : '(读不到) '}${fp}`)
  }
}

if (cmd === 'import') {
  const force = arg === '--force' || process.argv.includes('--force')
  if (force) { store.resetDb(); line('已清库, 开始全量导入...') }
  const t0 = Date.now()
  const r = await store.syncSources(dataFiles, (p) => {
    if (p.note) process.stdout.write(`\r  ${p.note}`.padEnd(70))
  })
  process.stdout.write('\r'.padEnd(71) + '\r')
  line(`导入完成: 新导入 [${r.imported.join(', ') || '无'}] / 跳过 [${r.skipped.join(', ') || '无'}] / 移除 [${r.removed.join(', ') || '无'}]`)
  line(`耗时 ${Date.now() - t0} ms`)
  const info = store.dbInfo()
  line(`库内现有 ${info.images} 张 / ${info.tags} 个标签, 体积 ${mb(info.bytes)}`)
}

if (cmd === 'export') {
  const dir = arg && !arg.startsWith('--') ? arg : undefined
  const t0 = Date.now()
  const r = store.exportToTxt(dir, (p) => { if (p.source) process.stdout.write(`\r  已写 ${p.source}: ${p.records} 条`.padEnd(70)) })
  process.stdout.write('\r'.padEnd(71) + '\r')
  line(`已导出到 ${r.dir}`)
  for (const w of r.written) line(`  tags_${w.name}.txt  ${w.records} 条`)
  line(`耗时 ${Date.now() - t0} ms`)
}

if (cmd === 'reset') {
  const r = store.resetDb()
  line(`已删除 ${r.path} (及其 WAL/SHM)；下次启动会自动从 txt 重建`)
}

if (cmd === 'verify') {
  // 从库里读出来, 与直接解析 txt 的结果逐条比对 —— 证明导入没有丢/改数据
  //
  // ⚠️ 两边都必须先过 normalizeImagePath
  // ==================================
  // 库里存的是**规范化后**的路径(统一正斜杠 + 盘符小写), 而 txt 是**未规范化**
  // 的原文(实测 81650 行里 10436 行是混写的)。直接比会对每个来源都报"第 1 条不同",
  // 看着像导入丢失, 其实只是盘符大小写与混写分隔符的差别 —— 误报一次就
  // 再也没人信这个检查, 所以这里必须与 store.normalizeImagePath 用同一套规则。
  //
  // 另外要套用与迁移**相同的去重规则**: 同一个规范化路径只算一条(保留最后出现的那条),
  // 否则 txt 里同路径重复的行会与库里的单条对不上(实测只有 涩涩涩涩涩 的 2 行)。
  const bySrc = new Map()
  // ⚠️ 只比 `tags_src='legacy'` 的记录, 且**不过滤 gone**
  // ==================================================
  // 库里现在住着三类来源(见 core/ingest.js):
  //   legacy —— 从 txt 导入的, **只有它属于本检查的范围**;
  //   meta   —— 增量入库写进来的(磁盘上新增、图自带提示词), 本来就不在任何 txt 里,
  //             混进来比对就是自己给自己造误报;
  //   wd14   —— 反推得到的, 同理(阶段 3)。
  // 而 gone=1 的行仍然在库里(tags 一个字节没改), txt 是历史快照也不会少这一行,
  // 所以这里**不能**加 gone=0 —— 加了反而会把"磁盘上被删掉"误报成"导入丢失"。
  // 直查 SQL 而不走 store.readRecords: 后者是给运行时加载用的, 语义上只看 gone=0。
  {
    const db = store.openDb()
    const rows = db.prepare(`
      SELECT i.path AS path, s.name AS source, i.tags AS tags
      FROM images i JOIN src s ON s.id = i.src_id
      WHERE i.tags_src = 'legacy'
      ORDER BY i.id
    `).all()
    for (const r of rows) {
      if (!bySrc.has(r.source)) bySrc.set(r.source, [])
      bySrc.get(r.source).push({
        path: store.normalizeImagePath(r.path),
        tags: String(r.tags || '').split(',').map((t) => t.trim()).filter(Boolean).join('\u0001'),
      })
    }
    line(`库内 legacy 记录: ${rows.length} 条(其余 tags_src 不参与本检查)\n`)
  }
  // 按「路径 -> 标签」比较, 而不是按下标逐位比
  // ==========================================
  // 这个检查的职责是"导入**无损**" —— 无损是集合性质, 不是位置性质。
  // 按下标比会被两件与丢失无关的事误伤:
  //   · 行序漂移: 有的来源的行是**跨多次导入累积**的(实测 涩涩涩涩涩 里同一个
  //     规范化路径的行 id 相隔两万多, 说明来自两代导入), 库内顺序本就不等于
  //     txt 当前行序;
  //   · 规范化合并: txt 里同路径的重复行在库里只剩一条。
  // 所以主判定用 Map 求差集(丢/多/标签被改), 行序漂移只作为提示报出来。
  let total = 0, mismatch = 0, driftOnly = 0
  for (const [name, fp] of dataFiles) {
    if (!fs.existsSync(fp)) { line(`跳过 ${name}: txt 读不到`); continue }
    const a = bySrc.get(name) || []
    const raw = []
    await streamTagFile(fp, (rec) => raw.push({ path: store.normalizeImagePath(rec.path), tags: rec.tags.join('\u0001') }))
    const dedup = new Map()
    for (const r of raw) dedup.set(r.path, r)     // 后写覆盖先写 = 保留最后一条, 与迁移一致
    const b = [...dedup.values()]
    total += b.length
    const collapsed = raw.length - b.length

    const aMap = new Map(a.map((x) => [x.path, x.tags]))
    const bMap = new Map(b.map((x) => [x.path, x.tags]))
    const missing = [...bMap.keys()].filter((p) => !aMap.has(p))        // txt 有、库没有
    const extra = [...aMap.keys()].filter((p) => !bMap.has(p))          // 库有、txt 没有
    const changed = [...bMap.keys()].filter((p) => aMap.has(p) && aMap.get(p) !== bMap.get(p))
    const lost = missing.length + extra.length + changed.length

    if (lost) {
      mismatch++
      line(`✗ ${name}: txt ${raw.length} 条${collapsed ? `(规范化去重后 ${b.length})` : ''} / 库 ${a.length} 条`)
      for (const p of missing.slice(0, 3)) line(`    · txt 有但库没有: ${p}`)
      for (const p of extra.slice(0, 3)) line(`    · 库有但 txt 没有: ${p}`)
      for (const p of changed.slice(0, 3)) line(`    · 标签不一致: ${p}`)
      if (lost > 9) line(`    … 共 ${lost} 条差异`)
      continue
    }
    // 集合一致, 再看行序
    const sameOrder = a.length === b.length && a.every((x, i) => x.path === b[i].path)
    if (sameOrder) {
      line(`✓ ${name}: ${b.length} 条逐条一致${collapsed ? `(txt ${raw.length} 条, 规范化合并 ${collapsed} 条)` : ''}`)
    } else {
      driftOnly++
      line(`✓ ${name}: ${b.length} 条内容一致(行序与 txt 不同 —— 该来源的行是多次导入累积的, 不影响数据)`)
    }
  }
  line(mismatch ? `\n有 ${mismatch} 个来源不一致` : `\n全部无损(共 ${total} 条)${driftOnly ? `; ${driftOnly} 个来源行序有漂移` : ''}`)
  process.exit(mismatch ? 1 : 0)
}

store.closeDb()
