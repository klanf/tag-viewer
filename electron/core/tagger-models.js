/**
 * 反推模型预设 —— 兼容模式的选择表
 * =================================
 * 2026-10-21 用户拍板: 反推模型做成可选, **默认必须是 v0.9**(新装反推环境也下 v0.9),
 * v1.0 作为实验选项留着试。原因: v0.9 已验证稳定、448px 快; v1.0 词表大很多
 * (30,877 tag, 尤其 Nikke 角色从 9 个涨到 52 个) 但 1008px、CPU/DML 上明显更慢。
 *
 * 每个预设声明四样东西, 别的模块只读这张表, 不再各自硬编码文件名:
 *   · 模型 / 标签表的**候选文件名**(按同名词干成对, 改名版和社区常见名都认)
 *   · 预处理模式(pixai448 = 固定拉伸; rescale_pad = 保持比例 + 黑边补方)
 *   · 展示文案与是否实验性
 *
 * `taggerModel` 的设置语义:
 *   '' / 'auto' -> 跟随旧配置(优先 TV_WD14_MODEL 等显式路径, 否则 v0.9)
 *   'v0.9' / 'v1.0' -> 明确指定, 只找该预设的文件(缺了就报缺, 不偷偷退回另一个)
 *
 * ⚠️ 本模块保持纯数据 + 纯函数, 不 import workspace/paths —— tagcats.js 与
 * tagger.js 都要用它, 任何一边的路径依赖都可能绕成环。
 */

export const DEFAULT_TAGGER_MODEL = 'v0.9'

/**
 * 文件名数组按**同名词干**对齐: models[i] 与 csvs[i] 是一对。
 * 目录搜索时成对取第一个两边都在的组合, 避免"v1.0 模型配 v0.9 词表"。
 */
export const TAGGER_MODELS = Object.freeze({
  'v0.9': Object.freeze({
    id: 'v0.9',
    name: 'PixAI Tagger v0.9',
    shortLabel: 'v0.9',
    label: 'PixAI Tagger v0.9（默认 · 稳定）',
    note: '13,461 个标签 · 448px · 单张约 0.15s（CUDA）',
    experimental: false,
    preprocess: 'pixai448',
    models: [
      'wd-pixai-tagger-v0.9.onnx',
      'model.onnx',
    ],
    csvs: [
      'wd-pixai-tagger-v0.9.csv',
      'selected_tags.csv',
    ],
  }),
  'v1.0': Object.freeze({
    id: 'v1.0',
    name: 'PixAI Tagger v1.0',
    shortLabel: 'v1.0',
    label: 'PixAI Tagger v1.0（实验 · 30,877 标签）',
    note: '30,877 个标签 · 1008px · 角色词表约 2.3 倍, CPU/DML 上明显更慢',
    experimental: true,
    preprocess: 'rescale_pad',
    models: [
      'pixai-tagger-v1.0-1008-fp16.onnx',
      'pixai-tagger-v1.0-1008.onnx',
      'pixai-tagger-v1.0.onnx',
      'wd-pixai-tagger-v1.0.onnx',
    ],
    csvs: [
      'pixai-tagger-v1.0-1008-fp16.csv',
      'pixai-tagger-v1.0-1008.csv',
      'pixai-tagger-v1.0.csv',
      'wd-pixai-tagger-v1.0.csv',
    ],
  }),
  /* 2026-10-21 社区微调的小尺寸档(deepghs/HentaiSL 的 336-ft / 672-ft ONNX)。
   * 词表与 1008 完全一样, 只是输入网格小、阈值另有一套(ft 档更严)。
   * 336-ft 的 ONNX 是静态 batch=2, tagger_serve 会把单张复制成两行再取第一行;
   * 实测 DirectML 0.17s/张, 是 DML 上唯一能批量跑的 v1.0 档。
   * 672-ft 在 CUDA 上 0.26s/张, 但 DirectML 反而要约 14s/张 —— 只在 N 卡环境推荐。 */
  'v1.0-336': Object.freeze({
    id: 'v1.0-336',
    name: 'PixAI Tagger v1.0 336',
    shortLabel: 'v1.0-336',
    label: 'PixAI Tagger v1.0 336-ft（快速 · 批量）',
    note: '30,877 标签 · 336px 微调 · 实测 DirectML 0.17s/张, CPU 5.8s；角色召回略低于 1008',
    experimental: true,
    preprocess: 'rescale_pad',
    models: [
      'pixai-tagger-v1.0-336-ft-fp16.onnx',
      'pixai-tagger-v1.0-336-ft.onnx',
      'pixai-tagger-v1.0-336.onnx',
    ],
    csvs: [
      'pixai-tagger-v1.0-336-ft.csv',
      'pixai-tagger-v1.0-336.csv',
    ],
  }),
  'v1.0-672': Object.freeze({
    id: 'v1.0-672',
    name: 'PixAI Tagger v1.0 672',
    shortLabel: 'v1.0-672',
    label: 'PixAI Tagger v1.0 672-ft（实验 · 仅 CUDA 快）',
    note: '30,877 标签 · 672px 微调 · 实测 CUDA 0.26s/张, DirectML 约 14s/张',
    experimental: true,
    preprocess: 'rescale_pad',
    models: [
      'pixai-tagger-v1.0-672-ft-fp16.onnx',
      'pixai-tagger-v1.0-672-ft.onnx',
      'pixai-tagger-v1.0-672.onnx',
    ],
    csvs: [
      'pixai-tagger-v1.0-672-ft.csv',
      'pixai-tagger-v1.0-672.csv',
    ],
  }),
})

/** 设置值归一化。认不出 / 空 -> ''(自动), 不强行塞默认值 —— 旧自定义路径要靠自动模式继续生效 */
export function normalizeTaggerModel(v) {
  const s = String(v || '').trim().toLowerCase().replace(/_/g, '-')
  if (!s || s === 'auto' || s === 'default') return ''
  if (s === 'v1.0-336' || s === 'v1-336' || s === '1.0-336' || s === '336' || s === 'v1.0-336-ft') return 'v1.0-336'
  if (s === 'v1.0-672' || s === 'v1-672' || s === '1.0-672' || s === '672' || s === 'v1.0-672-ft') return 'v1.0-672'
  if (s === 'v1' || s === '1' || s === '1.0' || s === 'v1.0' || s === 'v1.0-1008' || s === '1008') return 'v1.0'
  if (s === 'v0.9' || s === '0.9' || s === 'v09' || s === '448') return 'v0.9'
  return ''
}

export function taggerModelInfo(v) {
  const id = normalizeTaggerModel(v)
  return id ? TAGGER_MODELS[id] : null
}

/** 给设置弹窗的下拉框用(不含 auto —— 界面自己拼一项"自动") */
export function taggerModelOptions() {
  return Object.values(TAGGER_MODELS).map((m) => ({
    value: m.id,
    label: m.label,
    note: m.note,
    experimental: m.experimental,
    default: m.id === DEFAULT_TAGGER_MODEL,
  }))
}

/**
 * 由实际解析到的模型文件名反推预设 —— 用于"自动模式"下告诉界面现在跑的是哪一档,
 * 也用于防止预设与实际文件不一致时用错预处理。
 */
export function presetIdForModelPath(modelPath) {
  if (!modelPath) return ''
  const base = String(modelPath).split(/[\\/]/).pop().toLowerCase()
  for (const m of Object.values(TAGGER_MODELS)) {
    if (m.models.some((n) => n.toLowerCase() === base)) return m.id
  }
  return ''
}

export function preprocessForPreset(presetId) {
  const m = TAGGER_MODELS[normalizeTaggerModel(presetId)]
  return m ? m.preprocess : 'auto'
}
