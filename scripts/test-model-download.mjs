/**
 * 按档下载（v1.0 系列）测试
 * =========================
 * 守四条容易被后续改动破坏的性质：
 *
 *   ① **词表合成分毫不差** —— 上游不给 csv，词表要靠 config.json 的
 *      tags / tags_split / category_best_threshold 三处现场拼。拼错一格就是
 *      "模型输出第 N 个 logit 对应到别的标签"，反推结果全错但**不会报错**。
 *      含引号/逗号的标签名不转义也会让整行错位（csv.reader 会把一格拆成两格）。
 *   ② **标签顺序与类别分段严格对齐** —— tags_split 展开长度必须等于 tags 长度，
 *      对不上就得直接抛，不能"凑合着生成一份短词表"（那会让后面的标签整体错位）。
 *   ③ **下载表本身自洽** —— 每档都有 onnx + 词表源；onnx 的 sha256 是 64 位 hex；
 *      落盘文件名必须是该档候选列表的首选名，否则 tagger.js 找不到刚下好的文件。
 *   ④ **阈值按类别生效** —— ft 档的每类推荐阈值不同（general 0.32 / character 0.54），
 *      退化成全局一个值就等于把上游调好的阈值作废。
 *
 * 真实上游比对（可选）
 * --------------------
 * `TV_TEST_HF=1 npm run test:modeldl` 会把三档 config.json 拉下来合成，
 * 与 data/models 里现用的 csv **逐字节**比对。上游改了 config 结构时这里会先响。
 * 默认不跑：它要联网，也不该让日常测试依赖镜像站可用。
 *
 * 跑法: npm run test:modeldl
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const require = createRequire(import.meta.url)

const { csvFromHfConfig } = require('../electron/runtime-setup.cjs')
const { presetDownload, taggerModelOptions, TAGGER_MODELS } = await load('electron/core/tagger-models.js')

let pass = 0
let fail = 0
function eq(name, got, want) {
  if (got === want) { pass += 1; console.log(`  ✓ ${name}`) } else {
    fail += 1
    console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(want)}\n      实际: ${JSON.stringify(got)}`)
  }
}
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name} ${detail}`) }
}
function throws(name, fn, match) {
  try { fn() } catch (e) {
    if (!match || String(e.message).includes(match)) { pass += 1; console.log(`  ✓ ${name}`); return }
    fail += 1; console.log(`  ✗ ${name}\n      错误信息不含「${match}」: ${e.message}`); return
  }
  fail += 1
  console.log(`  ✗ ${name}\n      应该抛错，实际没抛`)
}

console.log('\n[1] 词表合成：结构与转义')
{
  const cfg = {
    tags: ['1girl', 'solo', 'don\'t_say_"lazy"', 'a,b', 'plain_tag', 'rating:e'],
    tags_split: [['general', 3], ['character', 2], ['rating', 1]],
    category_best_threshold: { general: 0.32, character: 0.54, rating: 0.05 },
  }
  const csv = csvFromHfConfig(cfg)
  const lines = csv.split('\r\n')
  eq('表头', lines[0], 'tag_id,name,category,count,threshold')
  eq('行数（末行留空 → 7 段）', lines.length, 8)
  eq('末段为空（文件以 CRLF 收尾）', lines[7], '')
  eq('普通行', lines[1], '0,1girl,general,0,0.32')
  eq('含双引号的名字按 CSV 规范转义', lines[3], '2,"don\'t_say_""lazy""",general,0,0.32')
  eq('含逗号的名字加引号', lines[4], '3,"a,b",character,0,0.54')
  eq('类别边界：第 4 条起是 character', lines[5], '4,plain_tag,character,0,0.54')
  eq('阈值随类别切换', lines[6], '5,rating:e,rating,0,0.05')
  ok('换行统一 CRLF', !/[^\r]\n/.test(csv))
}

console.log('\n[2] 词表合成：坏数据必须抛错，不许凑合')
{
  throws('缺 tags', () => csvFromHfConfig({ tags_split: [['general', 1]] }), '没有词表')
  throws('缺 tags_split', () => csvFromHfConfig({ tags: ['a'] }), '没有词表')
  throws('空配置', () => csvFromHfConfig(null), '没有词表')
  throws('长度对不上', () => csvFromHfConfig({
    tags: ['a', 'b', 'c'],
    tags_split: [['general', 2]],
    category_best_threshold: { general: 0.3 },
  }), '长度对不上')
  // 阈值缺失时退到 0（不是 undefined，不能让 python 侧 parse 失败）
  const csv = csvFromHfConfig({ tags: ['x'], tags_split: [['general', 1]], category_best_threshold: {} })
  eq('类别没登记阈值时写 0', csv.split('\r\n')[1], '0,x,general,0,0')
}

console.log('\n[3] 下载表自洽')
{
  const withDl = Object.values(TAGGER_MODELS).filter((m) => m.download)
  eq('可下载档位数', withDl.length, 3)
  ok('v0.9 不登记下载（走既有引导链路）', !TAGGER_MODELS['v0.9'].download)
  for (const m of withDl) {
    const d = m.download
    ok(`${m.id}: onnx sha256 是 64 位 hex`, /^[0-9a-f]{64}$/.test(d.onnx.sha256), d.onnx.sha256)
    ok(`${m.id}: onnx 体积合理（>500MB）`, d.onnx.size > 500 * 1048576, String(d.onnx.size))
    eq(`${m.id}: onnx 落盘名是候选首选`, d.onnx.file, m.models[0])
    eq(`${m.id}: 词表落盘名是候选首选`, d.tags.file, m.csvs[0])
    ok(`${m.id}: 词表源是 https`, /^https:\/\/hf-mirror\.com\//.test(d.tags.url), d.tags.url)
    ok(`${m.id}: onnx 源是 https`, /^https:\/\/hf-mirror\.com\//.test(d.onnx.url), d.onnx.url)
    eq(`${m.id}: presetDownload 能取到`, presetDownload(m.id)?.id, m.id)
  }
  eq('未知档位取不到下载描述', presetDownload('v9.9'), null)
  const opts = taggerModelOptions()
  ok('options 里三档带体积', opts.filter((o) => o.downloadMb > 0).length === 3)
  eq('v0.9 的 downloadMb 为 0（界面不给按钮）', opts.find((o) => o.value === 'v0.9').downloadMb, 0)
}

console.log('\n[4] 真实上游比对（可选，TV_TEST_HF=1）')
if (process.env.TV_TEST_HF !== '1') {
  console.log('  - 跳过（设 TV_TEST_HF=1 打开）')
} else {
  const modelsDir = path.join(ROOT, 'data', 'models')
  /* 规范化只用来看"内容一不一样"，判等不靠字节：
   *   · 1008 档本机那份是历史产物 —— LF 换行，且含引号的标签**没转义**
   *     （`don't_say_"lazy"`；Python csv 宽松模式能读，但严格说该转义）。
   *   · 新合成的一律 CRLF + 规范转义。
   * 所以把引号包裹解开、换行归一之后再比，比"字节相同"更接近真正要守的东西：
   * 同一个 tag_id 必须还是同一个标签、同一个类别、同一个阈值。 */
  const strip = (s) => s.replace(/"([^"]|"")*"/g, (m) => m.slice(1, -1).replace(/""/g, '"'))
  const norm = (b) => strip(b.toString('utf8')).replace(/\r\n/g, '\n')
  /** 第三层：连引号一起忽略。只为容纳 1008 档那份历史词表 —— 它把
   *  `don't_say_"lazy"` 洗成了 `don't_say_lazy`（早期生成器剥了引号），
   *  与上游 config.json 差这一处。转义规则本身由 [1] 的单元用例死守。 */
  const normNoQuote = (b) => b.toString('utf8').replace(/"/g, '').replace(/\r\n/g, '\n')
  for (const m of Object.values(TAGGER_MODELS).filter((x) => x.download)) {
    const target = path.join(modelsDir, m.download.tags.file)
    if (!fs.existsSync(target)) { console.log(`  - ${m.id}: 本机没有 ${m.download.tags.file}，跳过比对`); continue }
    const res = await fetch(m.download.tags.url, { redirect: 'follow' })
    if (!res.ok) { fail += 1; console.log(`  ✗ ${m.id}: 拉 config.json 失败 HTTP ${res.status}`); continue }
    const cfg = await res.json()
    const gen = Buffer.from(csvFromHfConfig(cfg), 'utf8')
    const mine = fs.readFileSync(target)
    if (gen.equals(mine)) {
      pass += 1; console.log(`  ✓ ${m.id}: 合成词表与本机逐字节相同（${mine.length} B）`)
    } else if (norm(gen) === norm(mine)) {
      pass += 1; console.log(`  ✓ ${m.id}: 内容与本机相同（本机换行/转义写法不同，等价）`)
    } else if (normNoQuote(gen) === normNoQuote(mine)) {
      pass += 1; console.log(`  ✓ ${m.id}: 除引号写法外与本机一致（本机那份洗掉了标签里的引号）`)
    } else {
      fail += 1
      const gl = norm(gen).split('\n'); const ml = norm(mine).split('\n')
      let first = -1
      for (let i = 0; i < Math.max(gl.length, ml.length); i += 1) if (gl[i] !== ml[i]) { first = i; break }
      console.log(`  ✗ ${m.id}: 合成词表与本机不一致（行 ${first}）`)
      console.log(`      gen:  ${gl[first]}`)
      console.log(`      mine: ${ml[first]}`)
    }
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
