/**
 * 图片文件搬移 —— 右键菜单「移动到」背后的动作
 * ==============================================
 * 逻辑移植自壁纸切换器(electron-wallpaper/src/fileActions.js)的 transfer():
 *   · 只做「把一个文件从 A 弄到 B」, 返回结构化结果, 不抛异常给调用方;
 *   · 移动优先 rename(同盘瞬时完成), 跨盘(EXDEV)退化成 copy + unlink;
 *   · 目标目录有同名文件时自动改名成 `名字 (2).jpg`, 绝不静默覆盖。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 目标目录里已有同名文件时, 生成 `名字 (2).jpg` 这样的可用名。
 * 不覆盖是硬规则: 看板扫的是用户长期积累的图库, 一次静默覆盖无法挽回。
 */
export async function uniqueDestination(dir, fileName) {
  const ext = path.extname(fileName)
  const stem = path.basename(fileName, ext)
  let candidate = path.join(dir, fileName)
  for (let i = 2; i < 200; i += 1) {
    try {
      await fsp.access(candidate)
      candidate = path.join(dir, `${stem} (${i})${ext}`)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`)
}

/**
 * 移动文件到指定文件夹。
 * @param {string} imagePath 源文件绝对路径
 * @param {string} targetDir 目标文件夹
 * @returns {Promise<{ok: true, dest: string, name: string}|{ok: false, error: string}>}
 */
export async function moveFile(imagePath, targetDir) {
  if (!imagePath || !targetDir) return { ok: false, error: '参数不完整' }
  try {
    const stat = await fsp.stat(imagePath)
    if (!stat.isFile()) return { ok: false, error: '不是文件' }
  } catch (err) {
    return { ok: false, error: `源文件不可读: ${err.code || err.message}` }
  }

  // 已经在目标目录里就不动, 免得原地生成一个「xxx (2).jpg」
  if (path.dirname(path.resolve(imagePath)).toLowerCase() === path.resolve(targetDir).toLowerCase()) {
    return { ok: false, error: '这个文件已经在该文件夹里了' }
  }

  try {
    await fsp.mkdir(targetDir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `目标文件夹不可用: ${err.message}` }
  }

  const dest = await uniqueDestination(targetDir, path.basename(imagePath))
  try {
    try {
      await fsp.rename(imagePath, dest)
    } catch (err) {
      if (err.code === 'EXDEV') {
        // 跨盘(D: -> F:), rename 不成立, 退化成复制 + 删除
        await fsp.copyFile(imagePath, dest)
        await fsp.unlink(imagePath)
      } else if (err.code === 'EPERM' || err.code === 'EBUSY') {
        return { ok: false, error: '文件被占用(可能正被别的程序打开)' }
      } else {
        throw err
      }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
  return { ok: true, dest, name: path.basename(dest) }
}
