/**
 * 给一批路径补**像素尺寸** —— 「卡片按真实比例排版」的前置条件
 * ============================================================================
 * 2026-09-23 补这一层的原因：卡片改成「按图片真实像素比渲染 + 自适应行高」之后，
 * **「这条记录有没有尺寸」直接决定了它在网格里长什么样**：
 *   有 px_w/px_h -> 格子按真实比例算宽（横图宽、竖图窄），一张都不裁；
 *   没有        -> 回落 9/16，横图被塞进竖格子、`object-fit: cover` 裁成竖条。
 *
 * 而"没有尺寸"这件事**不会报任何错**，只是悄悄退回改动前的样子 —— 用户报的
 * 「横图显示为竖图」就是这么来的：scan.js 组装 item 时只带了
 * path/name/tags/source/folder/mtime/size，**独独漏了 px_w/px_h**，于是扫描页
 * （全是库外图，库里没有行）一整页都按竖图排。收藏页同理（收藏记录是
 * `{path,name,tags,at}` 的快照，也没有尺寸）。
 *
 * 所以尺寸不是"顺手带的字段"，是**网格数据的必须项**。统一收到这个入口，
 * 两条来源按代价从小到大试：
 *
 *   1. **内存数据集**（ds.byPath，O(1)）：已经登记进库的图直接就有尺寸 —— 包括
 *      扫描页里那些"同时是看板来源"的目录，以及收藏里绝大多数图。一次磁盘 I/O
 *      都不用。八万条记录的 Map 查一次是几十纳秒，比读一次文件头（约 0.3~11ms）
 *      便宜好几个数量级。
 *   2. **读文件头**（imgsize.readImageSize，4KB/张，认不出就再读 64KB）：只对库里
 *      没有的图做。**批量跑在 worker 线程里** —— 几千张同步读会把主进程事件循环
 *      占死（所有 IPC 卡住 = 界面卡死），与 scanWorker 的既有理由完全一样。
 *
 * 认不出的一律给 `null`，调用方回落到 9/16（与 TvImageCard 的回落一致）。
 * **绝不猜**：显示一个错的尺寸比显示回落值更糟。
 *
 * 刻意**不做进程内记忆**：同一个路径的文件可能被换掉（Syncthing 同步 / 用户换图），
 * 记住旧尺寸就会一直用错的。要缓存的话由调用方按 (路径, mtime, size) 自己存
 * —— 扫描页就是这么做的（写进 scan_cache.json 的条目里），那是**有失效依据**的缓存。
 */
import { readImageSize } from './imgsize.js'
import { normalizeImagePath } from './store.js'
import { recordByPath } from './dataset.js'
import { sizeInWorker } from './imgWorker.js'

/**
 * 少于这么多张就**不值得起线程**（新线程的固定开销约等于读几十张文件头）。
 * 值与 scan.js 的 WORKER_THRESHOLD 一致，语义相同。
 */
const WORKER_THRESHOLD = 64

/**
 * 补尺寸。
 * @param {string[]} paths 文件路径（原样传入即可：大小写/斜杠不敏感，
 *                         查数据集时会按 store.js 的口径规范化）
 * @param {{useDataset?:boolean, onProgress?:(p:{done:number,total:number})=>void}} [opt]
 * @returns {Promise<Array<{w:number,h:number}|null>>} **与 paths 下标一一对应**；
 *   null = 库里没有 + 文件头认不出（调用方回落到 9/16）
 */
export async function dimsForPaths(paths, opt = {}) {
  const list = Array.isArray(paths) ? paths : []
  const out = new Array(list.length).fill(null)
  if (!list.length) return out

  const useDataset = opt.useDataset !== false
  const todo = []                 // 需要读文件头的下标

  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (!p) continue
    if (useDataset) {
      const rec = recordByPath(normalizeImagePath(p))
      // 0 = "不知道"（老库没回填 / 从 txt 建库），不能当尺寸用 —— 拿 0 算比例
      // 会得到 Infinity 或 0，布局直接塌掉。与 TvImageCard 的判据保持一致。
      if (rec && rec.px_w > 0 && rec.px_h > 0) {
        out[i] = { w: rec.px_w, h: rec.px_h }
        continue
      }
    }
    todo.push(i)
  }
  if (!todo.length) return out

  const files = todo.map((i) => list[i])

  /** 原地读（小批量用；worker 起不来时的兜底——但那条路会占住主进程，能不用就不用） */
  const readHere = () => files.map((f) => {
    try {
      const s = readImageSize(f)
      return s ? { w: s[0], h: s[1] } : null
    } catch { return null }
  })

  let res
  if (files.length >= WORKER_THRESHOLD) {
    try {
      res = await sizeInWorker(files, opt.onProgress)
    } catch (e) {
      // 线程起不来（打包环境异常）不能让"补尺寸"整个失败 —— 退回原地读，
      // 慢但不卡死到不可用。调用方拿到 null 也只是回落 9/16，不会出错。
      console.error('[dims] worker 读尺寸失败, 退回原地读:', e?.message || e)
      res = readHere()
    }
  } else {
    // 小批量原地读：几十张文件头是几毫秒，起线程的固定开销反而更贵
    res = readHere()
  }
  for (let k = 0; k < todo.length; k++) {
    const d = res?.[k]
    if (d && d.w > 0 && d.h > 0) out[todo[k]] = { w: d.w, h: d.h }
  }
  return out
}
