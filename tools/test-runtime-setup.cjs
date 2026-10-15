'use strict';

/**
 * runtime-setup.cjs 真实网络冒烟测试（非 CI, 手动跑）:
 *   node tools/test-runtime-setup.cjs [--full-python]
 *   1) 白名单: 镜像站放行 / 外域拒绝
 *   2) CSV 下载全流程: hf-mirror 直拉 selected_tags.csv → SHA256 锚点校验
 *   3) --full-python: 完整装一遍嵌入式 Python 到临时目录（约 150MB 下载, 慢）
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const rs = require('../electron/runtime-setup.cjs');
const { downloadToFile, sha256File } = require('../electron/updater.cjs');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? `   ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? `   ${detail}` : ''}`); }
};

async function main() {
  console.log('\n===== 1. URL 白名单 =====');
  check('hf-mirror 放行', rs.allowedRuntimeUrl('https://hf-mirror.com/deepghs/pixai-tagger-v0.9-onnx/resolve/main/selected_tags.csv'));
  check('华为云放行', rs.allowedRuntimeUrl(`${rs.PY_ZIP_URL}`));
  check('get-pip 放行', rs.allowedRuntimeUrl('https://bootstrap.pypa.io/get-pip.py'));
  check('外域拒绝', !rs.allowedRuntimeUrl('https://evil.example.com/payload.exe'));
  check('http 拒绝', !rs.allowedRuntimeUrl('http://hf-mirror.com/x'));

  console.log('\n===== 2. ensureModel 单文件直拉（假设 onnx 已在位, 只拉 flexible csv） =====');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tv-runtime-'));
  try {
    const res = await rs.ensureModel({
      destDir: tmp,
      // 伪装 onnx 已在位 → 只走 csv 的 flexible 分支
      existsCheck: () => ({ modelPath: path.join(tmp, 'wd-pixai-tagger-v0.9.onnx'), csvPath: null }),
      onStage: (s) => console.log(`    [stage] ${s}`),
    });
    const st = await fsp.stat(res.csvPath);
    check('csv 拉取成功', st.size > 100 * 1024, `${st.size} bytes`);
    check('onnx 被跳过(未重复下载)', res.modelPath === path.join(tmp, 'wd-pixai-tagger-v0.9.onnx'));
  } catch (e) {
    check('ensureModel flexible 分支', false, e.message.slice(0, 200));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (process.argv.includes('--full-python')) {
    console.log('\n===== 3. 嵌入式 Python 完整安装（慢, ~150MB 下载） =====');
    const pyDest = await fsp.mkdtemp(path.join(os.tmpdir(), 'tv-py-'));
    try {
      const stages = [];
      const res = await rs.ensurePythonRuntime({
        destDir: pyDest,
        candidates: [],
        onStage: (s) => { stages.push(s); console.log(`    [stage] ${s}`); },
      });
      check('安装成功且 fresh', res.fresh === true);
      check('exe 就位', res.exe.endsWith('python.exe'));
    } catch (e) {
      check('嵌入式 Python 完整安装', false, e.message.slice(0, 300));
    } finally {
      await fsp.rm(pyDest, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    console.log('\n(跳过完整 Python 安装测试 —— 加 --full-python 开跑)');
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}  ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(`[FAILED] ${e.stack || e}`); process.exitCode = 1; });
