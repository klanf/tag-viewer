/**
 * 扫描 worker —— 元数据解析挪出主进程
 * =====================================
 * scanFolder 的「逐张解析」(extractImagePrompt 读 PNG 头 + promptToTags 切标签)
 * 是纯 CPU 同步代码, 图片多时在主进程里跑会把事件循环占死 —— 所有 IPC
 * (缩略图、状态查询、窗口响应)全部卡住, 表现就是「进去扫描就卡死」。
 *
 * png.js 只依赖 node:fs、prompt.js 零依赖, 都能直接进 worker_threads。
 * 这里每解析若干张就 postMessage 一次进度, 主进程转发给渲染端画进度条;
 * 全部解析完发 { type:'done', results }(与 files 下标一一对应)。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { extractImagePrompt } from './png.js'
import { promptToTags, dedupeTags } from './prompt.js'

const { files } = workerData || {}
if (!Array.isArray(files)) {
  parentPort.postMessage({ type: 'error', message: 'workerData.files 缺失' })
  process.exit(1)
}

const results = new Array(files.length)
let done = 0
let lastTick = Date.now()

for (let i = 0; i < files.length; i++) {
  let tags = []
  let src = ''
  try {
    const r = extractImagePrompt(files[i])
    src = r.source
    tags = r.text ? dedupeTags(promptToTags(r.text)) : []
  } catch { /* 单张读失败不影响整批 —— 与主进程原行为一致 */ }
  results[i] = { tags, source: src }
  done++

  // 进度上报节流: 每 120ms 一条, 避免消息风暴
  const now = Date.now()
  if (now - lastTick > 120 || i === files.length - 1) {
    lastTick = now
    parentPort.postMessage({ type: 'progress', done, total: files.length })
  }
}

parentPort.postMessage({ type: 'done', results })
