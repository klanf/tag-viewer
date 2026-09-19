/**
 * fileTransfer.js 自测 —— 临时目录里模拟真实搬移场景, 跑完即清理。
 * 用法: node scripts/test-fileTransfer.mjs
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { moveFile, uniqueDestination } from '../electron/core/fileTransfer.js'

const root = path.join(os.tmpdir(), `tv-move-test-${Date.now()}`)
const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`)
}

try {
  await fsp.mkdir(path.join(root, 'src'), { recursive: true })
  await fsp.mkdir(path.join(root, 'dst'), { recursive: true })

  // 1. 正常移动
  const a = path.join(root, 'src', 'a.jpg')
  await fsp.writeFile(a, 'aaa')
  let r = await moveFile(a, path.join(root, 'dst'))
  check('正常移动', r.ok && r.name === 'a.jpg', r.ok ? r.dest : r.error)
  check('源文件已不在', !(await fsp.access(a).then(() => true, () => false)))
  check('目标内容正确', (await fsp.readFile(r.dest, 'utf8')) === 'aaa')

  // 2. 同名自动改名(不覆盖)
  const b = path.join(root, 'src', 'a.jpg')
  await fsp.writeFile(b, 'bbb')
  r = await moveFile(b, path.join(root, 'dst'))
  check('同名自动改名', r.ok && r.name === 'a (2).jpg', r.ok ? r.name : r.error)
  const first = await fsp.readFile(path.join(root, 'dst', 'a.jpg'), 'utf8')
  check('原同名文件未被覆盖', first === 'aaa')

  // 3. 同目录拒动
  const c = path.join(root, 'dst', 'a.jpg')
  r = await moveFile(c, path.join(root, 'dst'))
  check('同目录拒动并给明确原因', !r.ok && /已经在该文件夹/.test(r.error), r.error)

  // 4. 源不存在
  r = await moveFile(path.join(root, 'src', 'ghost.jpg'), path.join(root, 'dst'))
  check('源文件不存在报错', !r.ok, r.error)

  // 5. 目标目录不存在时自动创建
  const d = path.join(root, 'src', 'd.png')
  await fsp.writeFile(d, 'ddd')
  r = await moveFile(d, path.join(root, 'dst', '子目录'))
  check('目标目录自动创建', r.ok && r.dest.includes(path.join('dst', '子目录')), r.ok ? r.dest : r.error)

  // 6. uniqueDestination 边界
  check('uniqueDestination 空目录返回原名',
    (await uniqueDestination(root, 'x.gif')).endsWith('x.gif'))
} finally {
  await fsp.rm(root, { recursive: true, force: true })
}

const fails = results.filter((x) => !x.pass)
console.log(`\n${results.length - fails.length}/${results.length} 通过`)
process.exit(fails.length ? 1 : 0)
