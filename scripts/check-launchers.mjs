/**
 * 启动脚本编码体检 —— 守住「双击没反应」这个坑
 * ============================================
 * cmd.exe / WSH 是按**当前 ANSI 代码页**读 .bat / .vbs 的, 不是按 UTF-8。
 * 本机 ACP=936(GBK), 所以这两个文件必须: 无 BOM + ANSI(GBK) 编码 + CRLF 换行。
 *
 * 2026-09-18 两种错法都踩过, 现象完全相同 —— 双击后什么都没发生:
 *   1) UTF-8 无 BOM + LF: cmd 按 GBK 解码中文注释, 乱码字节里混出命令
 *      分隔符, 整个脚本的控制流错位(if 块被跳过、set 没执行)。
 *   2) UTF-8 带 BOM + chcp 65001: BOM 让首行 `@echo off` 变成未知命令,
 *      且 cmd 读多字节字符跨缓冲区时会吞掉行首(`rem ... 之前是` -> `前是`),
 *      刷出一串"不是内部或外部命令"。
 *
 * 这个文件自带内容, 不依赖人工记得, 每次 build/e2e 都会跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = ['启动看板.bat', '启动看板.vbs']

export function checkLaunchers() {
  const problems = []
  for (const name of TARGETS) {
    const p = path.join(ROOT, name)
    if (!fs.existsSync(p)) {
      problems.push({ kind: `启动脚本缺失: ${name}` })
      continue
    }
    const buf = fs.readFileSync(p)

    // --- BOM ---
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      problems.push({ kind: `${name}: 带 UTF-8 BOM —— 首行会被解析成未知命令, 必须存成"无 BOM"` })
    } else if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
      problems.push({ kind: `${name}: 是 UTF-16 编码 —— cmd/WSH 读不了, 必须存成 ANSI(GBK)` })
    }

    // --- 换行 ---
    let crlf = 0
    for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 0x0d && buf[i + 1] === 0x0a) crlf++
    let lf = 0
    for (const b of buf) if (b === 0x0a) lf++
    const bare = lf - crlf
    if (bare > 0) {
      problems.push({ kind: `${name}: 有 ${bare} 处裸 LF 换行 —— 必须全部 CRLF(bat 用 LF 会让控制流错乱)` })
    }

    // --- 编码: 按 GBK 解出来不能有替换字符 ---
    const text = new TextDecoder('gbk', { fatal: false }).decode(buf)
    const bad = text.indexOf('\uFFFD')
    if (bad >= 0) {
      const line = text.slice(0, bad).split('\n').length
      problems.push({ kind: `${name}: 按 GBK 解码在第 ${line} 行出现乱码 —— 文件不是 ANSI(GBK), 中文提示会变成乱码字节` })
    }

    // --- 代码页自洽: ACP=936 时不要 chcp 65001 ---
    if (/^\s*chcp\s+65001/m.test(text)) {
      problems.push({ kind: `${name}: 里面有 "chcp 65001", 但文件本身是 GBK —— 二者必须择一, 混用会让中文输出乱码` })
    }
  }
  return problems
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const ps = checkLaunchers()
  if (ps.length) {
    console.log(`✗ 启动脚本体检发现 ${ps.length} 处问题:`)
    for (const p of ps) console.log(`  · ${p.kind}`)
    process.exit(1)
  }
  console.log('✓ 启动脚本体检通过: 无 BOM / ANSI(GBK) / 全 CRLF')
}
