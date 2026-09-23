/**
 * 扫描 worker —— 元数据解析 / 尺寸读取挪出主进程
 * =============================================
 * scanFolder 的「逐张解析」(extractImagePrompt 读 PNG 头 + promptToTags 切标签)
 * 是纯 CPU 同步代码, 图片多时在主进程里跑会把事件循环占死 —— 所有 IPC
 * (缩略图、状态查询、窗口响应)全部卡住, 表现就是「进去扫描就卡死」。
 *
 * png.js 只依赖 node:fs、prompt.js 零依赖、imgsize.js 同样零依赖,
 * 都能直接进 worker_threads。这里每解析若干张就 postMessage 一次进度,
 * 主进程转发给渲染端画进度条; 全部处理完发 { type:'done', results }
 * (与 files 下标一一对应)。
 *
 * 两种模式(由 workerData.kind 决定):
 *   'meta'(默认) —— 读图内提示词元数据 + 顺手带上像素尺寸。ingest 的
 *                   「新图/图变了」走这条。
 *   'size'       —— **只读文件头拿宽高**, 不解码像素、不碰元数据。
 *                   ingest 给老库懒回填 px_w/px_h 走这条: 全库八万张,
 *                   按 64KB/张读文件头, 几十秒能跑完, 而且不占主进程。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { extractImagePrompt } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'
import { readImageSize } from './imgsize.js'

const { files, kind = 'meta' } = workerData || {}
if (!Array.isArray(files)) {
  parentPort.postMessage({ type: 'error', message: 'workerData.files 缺失' })
  process.exit(1)
}

const results = new Array(files.length)
let done = 0
let lastTick = Date.now()

/** 进度上报节流: 每 120ms 一条, 避免消息风暴 */
function tick(i) {
  const now = Date.now()
  if (now - lastTick > 120 || i === files.length - 1) {
    lastTick = now
    parentPort.postMessage({ type: 'progress', done, total: files.length })
  }
}

if (kind === 'size') {
  for (let i = 0; i < files.length; i++) {
    // 读不到 / 格式认不出 -> null。调用方据此保留旧值, 绝不写 0 冒充尺寸。
    const s = readImageSize(files[i])
    results[i] = s ? { w: s[0], h: s[1] } : null
    done++
    tick(i)
  }
} else {
  for (let i = 0; i < files.length; i++) {
    let tags = []
    let src = ''
    let dim = null
    try {
      const r = extractImagePrompt(files[i])
      src = r.source
      tags = r.text ? dedupeTags(promptToTags(r.text)) : []
    } catch { /* 单张读失败不影响整批 —— 与主进程原行为一致 */ }
    try {
      // 尺寸单独读一次文件头。这张图刚刚已经 open 过一遍, 缓存多半还热。
      const s = readImageSize(files[i])
      if (s) dim = { w: s[0], h: s[1] }
    } catch { /* 拿不到尺寸不影响元数据解析 */ }
    results[i] = { tags, source: src, dim }
    done++
    tick(i)
  }
}

parentPort.postMessage({ type: 'done', results })
