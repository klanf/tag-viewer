/**
 * 批量解析的 worker 入口 —— 元数据解析 / 只读尺寸
 * =================================================
 * 从 scan.js 拆出来（2026-09-23 下午）的原因：**「读尺寸」现在有两个消费者** ——
 * scan.js（扫描页要按真实比例排版）和 dims.js（统一补尺寸的入口，收藏页也走它）。
 * 如果 dims.js 去 import scan.js，就和 scan.js → dims.js 形成循环引用；把这段
 * 纯 worker 管道单独放一层，两边都只依赖它，依赖图是干净的树。
 *
 * 为什么必须进 worker：extractImagePrompt / readImageSize 都是**同步**代码，几千张
 * 在主进程里跑会把事件循环占死 —— 所有 IPC（缩略图、状态查询、窗口响应）全部卡住，
 * 表现就是「进去扫描就卡死」「点收藏页没反应」。与原来 scan.js 里的理由完全一样。
 *
 * 两种模式（由 workerData.kind 决定，实现在 scanWorker.js）：
 *   'meta'（默认）—— 读图内提示词元数据 + 顺手带上像素尺寸。
 *   'size'        —— **只读文件头拿宽高**，不解码像素、不碰元数据。
 */
import { Worker } from 'node:worker_threads'

/**
 * @param {string[]} files 文件路径（保持下标一一对应）
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 * @param {'meta'|'size'} [kind]
 * @returns {Promise<Array<{tags:string[],source:string,dim:object|null}|{w:number,h:number}|null>>}
 *   meta 模式: { tags, source, dim }
 *   size 模式: { w, h } 或 null（读不到 / 格式认不出 —— 调用方保留旧值，别写 0 冒充）
 */
export function parseInWorker(files, onProgress, kind = 'meta') {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./scanWorker.js', import.meta.url), {
      workerData: { files, kind },
    })
    w.on('message', (m) => {
      if (m?.type === 'progress') {
        try { onProgress(m) } catch { /* 进度回调出错不影响扫描 */ }
      } else if (m?.type === 'done') {
        w.unref()
        resolve(m.results || [])
      } else if (m?.type === 'error') {
        reject(new Error(m.message || 'scan worker error'))
      }
    })
    w.on('error', reject)
    w.on('exit', (code) => {
      if (code !== 0) reject(new Error(`scan worker 异常退出(code=${code})`))
    })
  })
}

/**
 * 只读尺寸的批量入口 —— ingest 给老库懒回填 px_w/px_h 走这条，
 * dims.js 给库外图（扫描页 / 收藏）补尺寸也走这条。
 * @returns {Promise<Array<{w:number,h:number}|null>>} 与 files 下标一一对应。
 *   null = 文件读不到 / 格式认不出 —— 调用方**保留旧值**，别写 0 冒充尺寸。
 */
export function sizeInWorker(files, onProgress) {
  return parseInWorker(files, onProgress, 'size')
}
