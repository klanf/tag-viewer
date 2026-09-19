/**
 * 主进程文件日志 —— 与 main.js 的 log() 同一个 launch.log
 * =====================================================
 * main.js 里的 log() 是启动期专用(含 initLog 清文件), 不适合被其他模块 import
 * (会形成 main <-> 模块 的循环依赖)。这里独立实现一份: 同一个文件、同一种行格式,
 * 让 IPC handler 异常也能落盘 —— 双击启动时 stdout 没人接, console.error 会静默消失。
 *
 * 日志目录由 core/paths.js 的单例提供: main.js 在启动最早期就 setLogDir() 过了,
 * 这里只管取。这样做的两个原因:
 *   · 本模块不 import electron —— 否则 scripts/stub 下的桩测试会连带着挂;
 *   · 改造前这里自己算了一遍(且把 TV_LOG_DIR 当成完整文件路径, 与 main.js 的
 *     「当目录」语义冲突), 同一个变量两个解释, 属于隐性 bug, 现在合并成一份。
 */
import fs from 'node:fs'
import { logFile } from './paths.js'

export function flog(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}`
  try { fs.appendFileSync(logFile(), line + '\n') } catch { /* 日志失败不能拖垮业务 */ }
  try { process.stdout.write(line + '\n') } catch { /* 无控制台时忽略 */ }
}
