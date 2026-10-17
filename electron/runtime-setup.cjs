'use strict';

/**
 * 反推环境按需引导（打包版专用，首次安装时拉取）
 * ==============================================
 * 设计原则（2026-10-15 用户拍板）：安装包保持精简，Python 与 WD14 模型都**不进包**，
 * 由应用在「检测到本地没有」时引导下载；更新/重装场景天然跳过 —— 探测到现成
 * 解释器或模型文件就什么都不做。
 *
 * 两条下载线：
 *   1. Python 运行时：嵌入式 Python（华为云镜像，~11MB）→ Expand-Archive 解压
 *      → 开 _pth 的 site → get-pip.py → pip 装 numpy + onnxruntime-directml（清华源）。
 *      成功后由调用方把 exe 路径写进 TV_PYTHON 环境变量 + settings.json 的 pythonPath。
 *   2. WD14 模型：hf-mirror 直拉 deepghs/pixai-tagger-v0.9-onnx 的 model.onnx +
 *      selected_tags.csv（原名即 tagger.js 候选所认），断点续传 + SHA256 校验，
 *      落到 <数据目录>/models/。哈希锚点取自本机 2026-08-29 的文件（见 MODEL_FILES）；
 *      若上游仓库更新了文件导致校验失败，提示用户手动下载（docs/新手上手.md 三步）。
 *
 * 复用 updater.cjs 的网络层（requestBuffer/downloadToFile/sha256File，已 21 条单测覆盖），
 * 这里只换 allowedUrl 白名单（镜像站）。
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { downloadToFile, requestBuffer, sha256File } = require('./updater.cjs');

const PY_VERSION = '3.11.9';
const PY_ZIP_URL = `https://mirrors.huaweicloud.com/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple';
// onnxruntime-directml 钉 1.19.2: 2026-10-15 实测 1.24.4 的 DML EP 对
// wd-pixai-tagger-v0.9.onnx 分区失败("Failed to find node output ... logits"),
// 整模型静默回落 CPU; 1.19.2 DML 初始化成功, 推理结果与 CPU 一致(47 标签相同),
// 热身单张 1.78s(CPU 2.00s)。
const PY_PACKAGES = ['numpy', 'onnxruntime-directml==1.19.2', 'pillow'];

const MODEL_BASE_URL = 'https://hf-mirror.com/deepghs/pixai-tagger-v0.9-onnx/resolve/main';
// csv 不从 HF 拉: 2026-10-15 实测上游把 selected_tags.csv 原地换成了新列序
// (id,tag_id,name,category,count,ips), 而 tagger_serve.py 按旧列序(无前置 id)定位,
// 混用会 153/153 noResult。改为从**我们自己的 Gitee Release** 拉锚定版
// (v2.2.0 附件, 401399B / sha256 2e44dd16…), 上游再怎么变都不影响。
// 2026-10-17 起该 csv 已随包内置(extraResources -> resources/models/)，
// ensureModel 优先复制内置副本，下载只作兜底 —— 安装完只需要下 onnx 模型。
const CSV_URL = 'https://gitee.com/klanf/tag-viewer/releases/download/v2.2.0/wd-pixai-tagger-v0.9.csv';
const MODEL_FILES = [
  {
    remote: 'model.onnx',
    local: 'wd-pixai-tagger-v0.9.onnx',
    url: `${MODEL_BASE_URL}/model.onnx`,
    size: 1271365854,
    sha256: 'a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657',
  },
  {
    remote: 'wd-pixai-tagger-v0.9.csv',
    local: 'wd-pixai-tagger-v0.9.csv',
    url: CSV_URL,
    size: 401399,
    sha256: '2e44dd16bf5bd31c89aede514e4252f79ef1fd8f25301ee93606d7c903643e83',
  },
];

function allowedRuntimeUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const okHosts = [
    'gitee.com', 'hf-mirror.com', 'huggingface.co', 'hf.co',
    'mirrors.huaweicloud.com', 'bootstrap.pypa.io',
  ];
  return okHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))
    || url.hostname.endsWith('.gitee.com')
    || url.hostname.endsWith('.hf.co');
}

function execFile(cmd, args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.destroy(new Error(`命令超时: ${cmd}`)), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} 退出码 ${code}\n${(err || out).slice(-400)}`));
    });
  });
}

/** 逐个探测候选解释器：能跑 --version 且输出像 python 才算。返回第一个可用的。 */
async function probePython(cmds) {
  for (const bin of cmds) {
    if (!bin || (!bin.includes('\\') && !bin.includes('/'))) continue; // PATH 裸名跳过（商店占位程序陷阱）
    try {
      const out = await execFile(bin, ['--version'], { timeoutMs: 15_000 });
      if (/python\s*\d/i.test(out)) return { bin, version: out.replace(/^[^\d]*/, '').trim() };
    } catch { /* 下一个 */ }
  }
  return null;
}

async function retry3(fn, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await fn(); } catch (err) { lastErr = err; }
  }
  throw new Error(`${label} 重试 3 次仍失败: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

/** 依赖包是否齐(numpy + onnxruntime-directml 可导入) —— exe 存在 ≠ 环境可用,
 *  上一轮 pip 装到一半应用退出的话, 这里必须能识别出来续装。 */
async function hasPip(exe) {
  try {
    await execFile(exe, ['-m', 'pip', '--version'], { timeoutMs: 30_000 });
    return true;
  } catch { return false; }
}

async function pkgsOk(exe) {
  try {
    await execFile(exe, ['-c', 'import numpy, onnxruntime'], { timeoutMs: 60_000 });
    return true;
  } catch { return false; }
}

/**
 * 确保 Python 运行时可用。已有可用解释器时直接返回（更新/重装场景零开销）。
 * @returns {{exe: string, fresh: boolean, version: string}}
 */
async function ensurePythonRuntime({ destDir, candidates, onStage = () => {}, onProgress = () => {} }) {
  // 2026-10-15 修正: 候选不能只看 --version —— 一个没装 onnxruntime 的裸
  // miniconda 也会被判"可用 Python"而跳过安装(远端实测: 引导永远补不上运行时)。
  // 候选必须过 pkgsOk(真跑 import numpy+onnxruntime)才算数。
  let found = null
  for (const bin of candidates || []) {
    if (!bin || (!bin.includes('\\') && !bin.includes('/'))) continue // PATH 裸名跳过（商店占位程序陷阱）
    if (await pkgsOk(bin)) {
      let version = ''
      try { version = (await execFile(bin, ['--version'], { timeoutMs: 15_000 })).replace(/^[^\d]*/, '').trim() } catch { /* 有包就行 */ }
      found = { bin, version }
      break
    }
  }
  if (found) {
    onStage(`已检测到可用 Python（${found.version}），跳过安装`);
    return { exe: found.bin, fresh: false, version: found.version };
  }

  const pyDir = path.join(destDir, 'python');
  const exe = path.join(pyDir, 'python.exe');
  const exeReady = await probePython([exe]);
  if (exeReady && (await pkgsOk(exe))) {
    onStage('已检测到内置 Python（依赖完整），跳过安装');
    return { exe, fresh: false, version: PY_VERSION };
  }

  await fsp.mkdir(destDir, { recursive: true });

  if (!exeReady) {
    // 1. 下载嵌入式 Python zip（~11MB, 直接进内存; zip 由上游签名版本固定, 解压即校验）
    onStage(`下载嵌入式 Python ${PY_VERSION}（约 11MB）…`);
    const zipBuf = await retry3(() => requestBuffer(PY_ZIP_URL, {
      allowedUrl: allowedRuntimeUrl,
      maxBytes: 30 * 1024 * 1024,
    }), '下载 Python');
    const zipPath = path.join(destDir, `python-${PY_VERSION}-embed-amd64.zip`);
    await fsp.writeFile(zipPath, zipBuf);

    // 2. 解压（Windows 自带 Expand-Archive, 不引第三方 zip 依赖）
    onStage('解压 Python…');
    await execFile('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${pyDir}" -Force`,
    ]);

    // 3. 开 _pth（嵌入式默认锁死 sys.path, 不开 site 装不了包）
    onStage('配置 sys.path…');
    const pthFile = (await fsp.readdir(pyDir)).find((f) => f.endsWith('._pth'));
    if (!pthFile) throw new Error(`解压目录里找不到 ._pth 文件: ${pyDir}`);
    const pthPath = path.join(pyDir, pthFile);
    let pth = await fsp.readFile(pthPath, 'utf8');
    pth = pth.replace(/^#import site/m, 'import site');
    if (!pth.includes('Lib/site-packages')) pth += '\nLib/site-packages\n';
    await fsp.writeFile(pthPath, pth, 'utf8');
  } else {
    onStage('内置 Python 已在, 检查依赖包…');
  }

  // 4. pip + 依赖包（与解释器解耦: 上一轮半途而废的安装, 这里按缺口续装）
  if (!(await pkgsOk(exe))) {
    if (!(await hasPip(exe))) {
      onStage('安装 pip…');
      const getPipPath = path.join(destDir, 'get-pip.py');
      const pipBuf = await retry3(() => requestBuffer(PIP_URL, {
        allowedUrl: allowedRuntimeUrl,
        maxBytes: 4 * 1024 * 1024,
      }), '下载 get-pip.py');
      await fsp.writeFile(getPipPath, pipBuf);
      await execFile(exe, [getPipPath, '--no-warn-script-location', '-i', PIP_INDEX]);
    }
    onStage(`安装依赖包（${PY_PACKAGES.join(' + ')}，约 130MB）…`);
    await execFile(exe, [
      '-m', 'pip', 'install', '--no-warn-script-location',
      '-i', PIP_INDEX, ...PY_PACKAGES,
    ], { timeoutMs: 20 * 60_000 });
  }

  if (!(await pkgsOk(exe))) throw new Error('内置 Python 依赖包安装后自检失败');
  await fsp.rm(path.join(destDir, `python-${PY_VERSION}-embed-amd64.zip`), { force: true }).catch(() => {});
  return { exe, fresh: true, version: PY_VERSION };
}

/**
 * 确保 WD14 模型与标签表在位。文件已存在（任意候选位）时不重复下载。
 * @returns {{modelPath: string, csvPath: string, fresh: boolean}}
 */
/**
 * 校验已存在的模型/标签表是否与锚定值一致。csv 全量 SHA(400KB 瞬时),
 * onnx 只比体积(stat, 1.2GB 哈希太贵)。
 * @returns {Promise<string|null>} null=有效; 否则返回问题描述
 */
async function modelIntegrityIssue(modelPath, csvPath) {
  const onnx = MODEL_FILES[0], csv = MODEL_FILES[1];
  try {
    const st = await fsp.stat(modelPath);
    if (st.size !== onnx.size) return `onnx 体积 ${st.size} != ${onnx.size}`;
  } catch { return 'onnx 不可读'; }
  try {
    const st = await fsp.stat(csvPath);
    if (st.size !== csv.size) return `csv 体积 ${st.size} != ${csv.size}`;
    if ((await sha256File(csvPath)) !== csv.sha256) return 'csv SHA256 不匹配';
  } catch { return 'csv 不可读'; }
  return null;
}

async function ensureModel({ destDir, existsCheck, onStage = () => {}, onProgress = () => {} }) {
  const existing = existsCheck ? existsCheck() : null;

  /** 随包内置副本(2026-10-17): extraResources 把锚定版 csv 打进 resources/models/。
   *  安装版在 process.resourcesPath/models/ 下能找到; dev 环境没有, 返回 null 走原路。 */
  const bundledModelPath = (file) => {
    const resDir = process.resourcesPath;
    if (!resDir || !file) return null;
    return path.join(resDir, 'models', file.local);
  };

  /** 内置副本校验+落位: SHA 全量比对(401KB 瞬时), 匹配则复制进数据目录当已下载。
   *  不匹配/不存在返回 null, 调用方回落网络下载 —— 内置副本损坏不应堵死安装。 */
  const tryBundledCopy = async (file) => {
    const src = bundledModelPath(file);
    if (!src) return null;
    try {
      const st = await fsp.stat(src);
      if (st.size !== file.size) return null;
      if ((await sha256File(src)) !== file.sha256) return null;
      const dest = path.join(destDir, file.local);
      await fsp.mkdir(destDir, { recursive: true });
      await fsp.copyFile(src, dest);
      onStage(`${file.local} 使用安装包内置副本，免下载`);
      return dest;
    } catch { return null; }
  };

  // 已存在 ≠ 有效。2026-10-15 实测: 旧构建把上游 597KB 新列序 csv 下到了固定文件名,
  // 新构建只按"存在"跳过就会永远用坏文件 → 153/153 noResult 复现。
  // 经 modelIntegrityIssue 校验(csv 体积+SHA / onnx 体积), 不合格的挪走重下。
  const quarantine = async (p, why) => {
    const bad = `${p}.bad-${Date.now()}`;
    await fsp.rename(p, bad).catch(() => {});
    onStage(`${path.basename(p)} 校验不通过(${why}), 挪走后重新下载`);
  };

  if (existing && existing.modelPath && existing.csvPath) {
    const why = await modelIntegrityIssue(existing.modelPath, existing.csvPath);
    if (!why) {
      onStage('已检测到 WD14 模型，跳过下载');
      return { modelPath: existing.modelPath, csvPath: existing.csvPath, fresh: false };
    }
    if (why.startsWith('onnx')) await quarantine(existing.modelPath, why);
    if (why.startsWith('csv')) await quarantine(existing.csvPath, why);
  }

  await fsp.mkdir(destDir, { recursive: true });
  const results = {};
  const issue = existing && existing.modelPath && existing.csvPath
    ? await modelIntegrityIssue(existing.modelPath, existing.csvPath) : null;
  const have = {
    [MODEL_FILES[0].local]: existing && existing.modelPath && !(issue || '').startsWith('onnx')
      ? existing.modelPath : null,
    [MODEL_FILES[1].local]: existing && existing.csvPath && !(issue || '').startsWith('csv')
      ? existing.csvPath : null,
  };
  for (const file of MODEL_FILES) {
    if (have[file.local]) {
      onStage(`${file.local} 已在位，跳过`);
      results[file.local] = have[file.local];
      continue;
    }
    // 内置副本优先(2026-10-17): csv 已随包, 命中则免网络; 未命中(旧包/dev)回落下载
    const bundled = await tryBundledCopy(file);
    if (bundled) {
      results[file.local] = bundled;
      continue;
    }
    const dest = path.join(destDir, file.local);
    onStage(`下载 ${file.local}（${(file.size / 1048576).toFixed(0)}MB，断点续传）…`);
    await retry3(() => downloadToFile(file.url, dest, file.size, {
      allowedUrl: allowedRuntimeUrl,
      timeoutMs: 60_000,
      onProgress: (bytes) => onProgress(file.local, bytes),
    }), `下载 ${file.local}`);
    const hash = await sha256File(dest);
    if (hash !== file.sha256) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      throw new Error(`${file.local} SHA256 校验失败 —— 上游文件可能已更新，请按 docs/新手上手.md 手动下载`);
    }
    results[file.local] = dest;
  }
  return {
    modelPath: results[MODEL_FILES[0].local],
    csvPath: results[MODEL_FILES[1].local],
    fresh: true,
  };
}
/**
 * 探测某个 python 的 onnxruntime 加速能力(设置弹窗用)。
 * @returns {Promise<{ok: boolean, version?: string, providers?: string[], error?: string}>}
 */
async function detectAccelerators(exe) {
  const code = [
    'import json',
    'try:',
    "    import onnxruntime as ort",
    "    print(json.dumps({'ok': True, 'version': ort.__version__,",
    "                      'providers': list(ort.get_available_providers())}))",
    'except Exception as e:',
    "    print(json.dumps({'ok': False, 'error': str(e)}))",
  ].join('\n');
  try {
    const out = await execFile(exe, ['-c', code], { timeoutMs: 60_000 });
    const j = JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
    return j;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  MODEL_BASE_URL,
  MODEL_FILES,
  PY_VERSION,
  PY_ZIP_URL,
  allowedRuntimeUrl,
  detectAccelerators,
  ensureModel,
  ensurePythonRuntime,
  modelIntegrityIssue,
  pkgsOk,
  probePython,
};
