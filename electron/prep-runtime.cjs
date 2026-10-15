/**
 * prep-runtime.cjs —— 引导安装器阶段的「运行环境准备」入口
 * =====================================================
 * 由 bootstrap 引导安装器在主安装器静默装完后调用：
 *   cmd:  set ELECTRON_RUN_AS_NODE=1 && <安装目录>\TagViewer.exe <resources>\app.asar\electron\prep-runtime.cjs
 * 复用 runtime-setup.cjs 的全部已验证逻辑（URL 白名单 / 断点续传 / SHA256 锚定 /
 * pip 清华源 / 半成品续装），把 Python 运行时与 WD14 模型在**安装阶段**就绪，
 * 用户首次打开 App 不用再等下载。
 *
 * 输出协议（引导器 nsExec::ExecToLog 会把 stdout 打进安装详情窗口）：
 *   STAGE <描述>            阶段性进度
 *   PROGRESS <file> <bytes> 下载进度（引导器可忽略，人在窗口看字节数即可）
 *   PREP-OK <python.exe>    成功
 *   PREP-FAIL <原因>        失败（stderr 也有一份堆栈），exit 1
 * 幂等：全部就绪时几秒内静默通过（csv 校验 + onnx 体积校验 + python 探活）。
 */
'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ensurePythonRuntime, ensureModel, pkgsOk, MODEL_FILES } = require('./runtime-setup.cjs');

function userDataDir() {
  // 与 Electron 默认一致: %APPDATA%\<productName>。productName 在 package.json = TagViewer
  return path.join(process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'), 'TagViewer');
}

async function patchSettings(userData, patch) {
  const p = path.join(userData, 'settings.json');
  let cur = {};
  try { cur = JSON.parse(await fsp.readFile(p, 'utf8')) || {}; } catch { /* 首次没有 */ }
  for (const [k, v] of Object.entries(patch)) if (v != null) cur[k] = v;
  await fsp.mkdir(userData, { recursive: true });
  await fsp.writeFile(p, JSON.stringify(cur, null, 2), 'utf8');
}

async function main() {
  const userData = userDataDir();
  const runtimeDir = path.join(userData, 'runtime');
  const modelsDir = path.join(userData, 'data', 'models');
  const stage = (s) => console.log('STAGE ' + s);
  const progress = (name, bytes) => console.log(`PROGRESS ${name} ${bytes}`);

  // ── 1. Python 运行时（embed + pip 依赖, ~150MB）──
  const pyExe = path.join(runtimeDir, 'python', 'python.exe');
  // probe 只验 "--version" 能跑; 半成品(exe 在但包没装齐)必须走修复分支,
  // 所以只有 pkgsOk 通过才把它列为可跳过的候选。
  const candidates = [];
  try {
    if (await fsp.stat(pyExe).then(() => true, () => false)) {
      if (await pkgsOk(pyExe)) candidates.push(pyExe);
      else console.log('STAGE 检测到不完整的 Python 环境, 进入修复/续装分支');
    }
  } catch { /* 不存在, 正常全新安装 */ }
  const py = await ensurePythonRuntime({
    destDir: runtimeDir,
    candidates,
    onStage: stage,
    onProgress: progress,
  });
  console.log(`STAGE Python 就绪: ${py.exe}`);

  // ── 2. WD14 模型 + 锚定版标签表（onnx 1.2GB ← hf-mirror; csv ← Gitee 附件）──
  const modelPath = path.join(modelsDir, MODEL_FILES[0].local);
  const csvPath = path.join(modelsDir, MODEL_FILES[1].local);
  const exists = async (p) => { try { const st = await fsp.stat(p); return st.isFile(); } catch { return false; } };
  // existsCheck 必须同步: ensureModel 内部直接读返回值的属性
  const existing = { modelPath: (await exists(modelPath)) ? modelPath : null,
                     csvPath: (await exists(csvPath)) ? csvPath : null };
  const model = await ensureModel({
    destDir: modelsDir,
    existsCheck: () => existing,
    onStage: stage,
    onProgress: progress,
  });
  console.log(`STAGE 模型就绪: ${model.modelPath}`);

  // ── 3. 写 settings.json.pythonPath, App 首启直接认到 ──
  await patchSettings(userData, { pythonPath: py.exe });
  console.log('STAGE settings.json 已写入 pythonPath');
  console.log(`PREP-OK ${py.exe}`);
}

main().catch((e) => {
  const msg = (e && e.message) || String(e);
  console.error('PREP-FAIL ' + msg);
  console.error((e && e.stack) || '');
  process.exit(1);
});
