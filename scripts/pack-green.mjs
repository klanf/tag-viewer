/**
 * 绿色分发包打包 —— 免安装, 解压即用
 * ===================================
 * 产物: release/<包名>-v<version>/ 目录 + 同名 .zip, 两种变体(--variant):
 *   full  -> TagViewer-点击即用包-v<version>   模型 + Python 环境 + Electron 全带
 *   basic -> TagViewer-基础包-v<version>       不带 1.27GB 模型, 用户按使用说明自己下
 *            (Python/onnxruntime 环境两个包都带 —— 基础包用户只差「下模型」这一步)
 *
 * 带什么(白名单, 按"用户拿到就能跑"取舍):
 *   启动看板.bat / .vbs            双击启动(字节级复制 —— 编码有专门检查, 别动)
 *   package.json                   Electron 靠它的 main 找到主进程
 *   electron/                      主进程源码(纯 Node, 零外部 npm 依赖)
 *   dist/                          已构建的前端(要求先 npm run build, 本脚本会查新旧)
 *   node_modules/electron/dist     Electron 运行时本体(压缩前 ~370MB, 包体积大头)
 *   knowledge/                     内置翻译库(含来源与授权说明)
 *   tools/tagger_serve.py          WD14 反推服务
 *   python/                        嵌入式 Python + numpy + onnxruntime-directml(反推环境,
 *                                  两个变体都带; 找不到 python.exe 源就跳过并回退"自己装"文案)
 *   models/                        WD14 模型(1.27GB, 仅 full 带上; 找不到或 basic/--no-model 跳过)
 *   docs/新手上手.md + README.md + data/tag_viewer_config.example.json
 *   使用说明.txt                   本脚本生成(按变体生成对应内容)
 *
 * 绝不带什么(打完包逐项自检, 有一项在包里就拒跑):
 *   用户数据(data/ 除 *.example.json)、local.config.json、logs/、.git、
 *   .e2e-work/、src/(运行不需要源码)、交接日志.md、docs/内部方案文档
 *
 * 不用 fs.cpSync —— preflight 明令禁止(Windows 上行为不可靠), 全部手写递归复制。
 * 另外 process.noAsar 必须开着: 要搬运的 electron dist 里有 .asar 文件,
 * 而 ELECTRON_RUN_AS_NODE 下 fs 包装层会把 *.asar 路径当档案解析(实测 ENOENT)。
 *
 * 数据目录: main.js 开了 allowPortable —— 解压后首次运行用包内 data/, 数据随包走。
 *
 * 用法: node scripts/pack-green.mjs [--variant basic|full] [--out <目录>] [--allow-stale] [--no-model]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { localOldRoot } from './local-config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 本脚本要把 node_modules/electron/dist/** 整个搬走, 里面就有 .asar 文件 ——
// 而在 ELECTRON_RUN_AS_NODE=1 下跑脚本时, Electron 的 fs 包装层会把一切 *.asar
// 路径当成档案去解析(实测 copyFileSync 直接 ENOENT)。process.noAsar 是官方逃生门:
// 对本脚本而言, 所有文件都是普通字节, 永远不需要读 asar。
process.noAsar = true
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version

const argv = process.argv.slice(2)
const allowStale = argv.includes('--allow-stale')
const noModel = argv.includes('--no-model')
const outIdx = argv.indexOf('--out')
const outRoot = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, 'release')
// --variant basic|full: basic 不带模型(用户按使用说明自己下), 默认 full 全带。
// 两种写法都认: "--variant basic" 和 "--variant=basic"(等号写法踩过: indexOf 只认空格分隔)。
const varIdx = argv.indexOf('--variant')
const variant = varIdx >= 0
  ? argv[varIdx + 1]
  : (argv.find((a) => a.startsWith('--variant=')) || '').split('=')[1] || 'full'
if (!['basic', 'full'].includes(variant)) {
  console.error(`✗ 未知变体 "${variant}" —— 只认 basic / full`)
  process.exit(1)
}
const basic = variant === 'basic'
const NAME = `${basic ? 'TagViewer-基础包' : 'TagViewer-点击即用包'}-v${VERSION}`
const DEST = path.join(outRoot, NAME)

/* ------------------------------------------------ 拷贝工具(不用 cpSync) */

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function copyTree(src, dest, { skip } = {}) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(ent.name)) continue
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyTree(s, d, { skip })
    else if (ent.isFile()) fs.copyFileSync(s, d)
  }
}

function countFiles(dir) {
  let n = 0
  let bytes = 0
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      const r = countFiles(p)
      n += r.n
      bytes += r.bytes
    } else {
      const st = fs.statSync(p)
      n += 1
      bytes += st.size
    }
  }
  return { n, bytes }
}

/* ------------------------------------------------ 0. dist 新旧检查 */

const distIndex = path.join(ROOT, 'dist', 'index.html')
if (!fs.existsSync(distIndex)) {
  console.error('✗ dist/index.html 不存在 —— 先执行 npm run build 再打包')
  process.exit(1)
}
if (!allowStale) {
  let newest = { ms: 0, file: '' }
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { scan(p); continue }
      if (!/\.(vue|js|mjs|css)$/.test(e.name)) continue
      const ms = fs.statSync(p).mtimeMs
      if (ms > newest.ms) newest = { ms, file: p }
    }
  }
  scan(path.join(ROOT, 'src'))
  if (newest.ms > fs.statSync(distIndex).mtimeMs) {
    console.error('✗ 构建产物已过期(dist 比 src 旧), 打出来的包测的是旧界面:')
    console.error(`    ${path.relative(ROOT, newest.file).replace(/\\/g, '/')}`)
    console.error('  请先 npm run build; 确认无碍可加 --allow-stale。')
    process.exit(1)
  }
}

/* ------------------------------------------------ 1. 复制白名单 */

fs.rmSync(DEST, { recursive: true, force: true })
fs.mkdirSync(DEST, { recursive: true })
console.log(`[pack] 目标: ${DEST}`)

for (const f of ['启动看板.bat', '启动看板.vbs', 'package.json', 'README.md']) {
  copyFile(path.join(ROOT, f), path.join(DEST, f))
}
copyTree(path.join(ROOT, 'electron'), path.join(DEST, 'electron'))
copyTree(path.join(ROOT, 'dist'), path.join(DEST, 'dist'))
copyTree(path.join(ROOT, 'knowledge'), path.join(DEST, 'knowledge'))
copyTree(path.join(ROOT, 'node_modules', 'electron', 'dist'), path.join(DEST, 'node_modules', 'electron', 'dist'))
copyFile(path.join(ROOT, 'tools', 'tagger_serve.py'), path.join(DEST, 'tools', 'tagger_serve.py'))
copyFile(path.join(ROOT, 'docs', '新手上手.md'), path.join(DEST, 'docs', '新手上手.md'))
copyFile(path.join(ROOT, 'data', 'tag_viewer_config.example.json'), path.join(DEST, 'data', 'tag_viewer_config.example.json'))

/* ------------------------------------------------ 1.5 WD14 模型(默认带上) */

// 找模型的顺序: 仓库 models/ > local.config 的 oldRoot/model(开发机的模型住处)。
// 包里放成首选改名版(models/wd-pixai-tagger-v0.9.*), tagger.js 的候选清单正好认它。
let modelNote = basic ? '未带上(基础包, 见使用说明的模型下载)' : '未带上(--no-model)'
let modelBundled = false
const modelSrcDirs = [path.join(ROOT, 'models')]
const oldRoot = localOldRoot()
if (oldRoot) modelSrcDirs.push(path.join(oldRoot, 'model'))
if (noModel || basic) {
  console.log(`[pack] ${basic ? '基础包' : '--no-model'}: 跳过模型(反推要用户自己下 1.27GB, 见使用说明)`)
} else {
  const dstModels = path.join(DEST, 'models')
  fs.mkdirSync(dstModels, { recursive: true })
  const grab = (names, destName) => {
    for (const dir of modelSrcDirs) {
      if (!dir) continue
      for (const n of names) {
        const p = path.join(dir, n)
        if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(dstModels, destName)); return p }
      }
    }
    return ''
  }
  const onnx = grab(['wd-pixai-tagger-v0.9.onnx', 'model.onnx'], 'wd-pixai-tagger-v0.9.onnx')
  const csv = grab(['wd-pixai-tagger-v0.9.csv', 'selected_tags.csv'], 'wd-pixai-tagger-v0.9.csv')
  modelBundled = !!(onnx && csv)
  if (modelBundled) {
    modelNote = `已内置(来自 ${path.dirname(onnx)})`
  } else {
    console.error('[pack] ⚠️ 没找齐 WD14 模型文件, 这个包不带模型(找过: '
      + modelSrcDirs.filter(Boolean).join(' , ')
      + ')\n    反推需要用户自己下载; 重新打包前把模型放进仓库 models/ 或确认 oldRoot 可用')
  }
  console.log(`[pack] 模型: ${modelNote}`)
}

/* ------------------------------------------------ 1.6 包内 Python(两个变体都带) */

// tagger.js 认 <包>/python/python.exe(embeddable + numpy + onnxruntime-directml)。
// 源的寻找顺序: 仓库 python/ > 上一版绿色包里现成的那份(v2.1.0 起~)。
// 找不到就跳过, 使用说明回退成"自己装 Python + pip install onnxruntime"的旧文案。
const pySrcCandidates = [
  path.join(ROOT, 'python'),
  path.join(outRoot, 'TagViewer-绿色包-v2.1.0', 'python'),
]
const pySrc = pySrcCandidates.find((p) => fs.existsSync(path.join(p, 'python.exe')))
let pythonBundled = false
if (pySrc) {
  console.log(`[pack] Python 环境 <- ${pySrc}`)
  copyTree(pySrc, path.join(DEST, 'python'))
  pythonBundled = true
} else {
  console.error('[pack] ⚠️ 没找到嵌入式 Python, 包不带反推环境(用户要自己装 Python + onnxruntime)')
}

/* ------------------------------------------------ 2. 生成使用说明(带 BOM, 老记事本也认) */

const modelSection = basic
  ? [
    '· WD14 反推模型没打进这个包(1.27GB, 给包瘦身)。想用「扫描页自动打标」需要自己下载:',
    '  1. 打开 https://hf-mirror.com/deepghs/pixai-tagger-v0.9-onnx (HuggingFace 镜像站,',
    '     国内直连不用梯子), 下载两个文件: model.onnx 和 selected_tags.csv;',
    '  2. 在本文件夹里新建 models\\ 文件夹, 把两个文件放进去(原名即可, 不用改名);',
    '  3. 重启本应用即生效。不弄也不影响看板/购物车/收藏等其余功能。',
    '',
  ]
  : [
    '· 中文标签、WD14 打标模型都已内置。',
    '',
  ]
const pythonSection = pythonBundled
  ? [
    '· 反推用的 Python 和 onnxruntime 也已内置(包内 python\\ 文件夹), 不用再装任何东西。',
  ]
  : [
    '· 想自动打标还差两样: Python 3 和 onnxruntime(命令行 pip install onnxruntime);',
    '  打开「扫描」页会有「看看怎么装」的逐步引导。不装也不影响其他功能。',
  ]

const note = [
  `TagViewer ${basic ? '基础包' : '点击即用包'} —— 使用说明`,
  '============================',
  '',
  '1. 解压到任意「可写」的本地目录。',
  '2. 双击「启动看板.bat」启动(「启动看板.vbs」不弹黑框)。',
  '3. 第一次打开会请你选一个装满图的文件夹 —— 选中就自动扫描入库, 不用碰任何配置文件。',
  '',
  ...modelSection,
  ...pythonSection,
  '· 你的数据(图库记录/收藏/规则)默认就存在包内 data\\ 文件夹 —— 换电脑把整个文件夹拷走即可。',
  '· 卸载 = 删掉这个文件夹(会连 data\\ 一起删, 想保留图库记录就先备份它)。',
  '· 详细说明见 docs/新手上手.md。所有数据都在你自己电脑上, 不上传任何东西。',
  '',
].join('\r\n')
fs.writeFileSync(path.join(DEST, '使用说明.txt'), '\ufeff' + note, 'utf8')

/* ------------------------------------------------ 3. 黑名单自检(一项存在即拒) */

const mustNotExist = [
  'data/tags.db', 'data/tags.db-wal', 'data/tags.db-shm', 'data/user', 'data/scan_cache.json',
  'local.config.json', 'logs', '.git', '.e2e-work', 'src', 'scripts',
  '交接日志.md', 'docs/数据源合并与增量入库方案.md', 'node_modules/electron/index.js',
]
const bad = mustNotExist.filter((rel) => fs.existsSync(path.join(DEST, rel)))
if (bad.length) {
  console.error('✗ 包里出现了不该分发的东西, 已停止(目录保留供检查):')
  for (const b of bad) console.error(`    ${b}`)
  process.exit(1)
}

const mustExist = [
  '启动看板.bat', '启动看板.vbs', 'package.json',
  'dist/index.html', 'electron/main.js', 'electron/preload.cjs',
  'node_modules/electron/dist/electron.exe',
  'knowledge/README.md', 'tools/tagger_serve.py', 'docs/新手上手.md', '使用说明.txt',
  'knowledge/weilin_data(雷昂_Lion@bilibil)/userdatas_zh_CN_danbooru.db',
]
if (pythonBundled) {
  mustExist.push('python/python.exe', 'python/Lib/site-packages/onnxruntime')
}
if (modelBundled) {
  mustExist.push('models/wd-pixai-tagger-v0.9.onnx', 'models/wd-pixai-tagger-v0.9.csv')
}
const missing = mustExist.filter((rel) => !fs.existsSync(path.join(DEST, rel)))
if (missing.length) {
  console.error('✗ 包里缺了关键文件:')
  for (const m of missing) console.error(`    ${m}`)
  process.exit(1)
}

/* ------------------------------------------------ 4. 压缩 */

const { n, bytes } = countFiles(DEST)
const gb = (v) => (v / 1024 / 1024).toFixed(1) + ' MB'
console.log(`[pack] 目录完成: ${n} 个文件, ${gb(bytes)}`)

const zipPath = path.join(outRoot, `${NAME}.zip`)
fs.rmSync(zipPath, { force: true })
let zipped = false
try {
  // Windows 10 1803+ 自带 bsdtar: -a 按扩展名出 zip, 文件名按 UTF-8 记
  // (Compress-Archive 在 PS5.1 下中文条目名按本机代码页记, 换机器解压会乱码)。
  // ⚠️ 必须 cwd=outRoot + 相对文件名: bsdtar 把参数里的 "D:\" 冒号当远程主机名
  // ("tar: Cannot connect to D: resolve failed"), 上一版就是这么哑火的。
  const r = spawnSync('tar', ['-a', '-cf', `${NAME}.zip`, '-C', '.', NAME], { cwd: outRoot, stdio: 'inherit' })
  zipped = r.status === 0 && fs.existsSync(zipPath)
  if (!zipped) console.error(`[pack] tar 失败(status=${r.status}/${r.error?.code}), 可手动压缩目录`)
} catch (e) {
  console.error(`[pack] tar 不可用(${e.message}), 可手动压缩目录`)
}
if (zipped) {
  console.log(`[pack] zip: ${zipPath} (${gb(fs.statSync(zipPath).size)})`)
}
console.log('[pack] 完成。自测建议: 把 zip 拷到别的目录解压, 双击「启动看板.bat」。')
