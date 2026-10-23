/**
 * Danbooru API 凭据(2026-10-22)
 * ============================
 * 为什么要这个东西: 匿名调 Danbooru 的 dapi 有三道墙, 实测都撞过 ——
 *   ① 一次只允许 **2 个标签**(所以 `角色 + solo + rating` 这种组合匿名根本发不出去);
 *   ② **完全忽略 order 参数**(七个取值返回同一批最新图, 于是"按人气挑封面"只能在
 *      本地那几十张里排, 小众角色经常排到 2 分的图);
 *   ③ 限流严, 渲染层直连 CDN 还会被 Cloudflare 403(见 booru.js 的代拉注释)。
 * 用户登录后这三个限制都放开, 所以值得给一个填 Key 的入口。
 *
 * 为什么**不**存进 settings.json: `app:settings:set` 的回包是整个 settings 对象,
 * 渲染层开机 `pullSettings()` 也会把它整份缓存进 store —— 密钥跟着每条设置读写到处跑。
 * 单独一个文件 + 只回「有没有配 / 用户名」的摘要, 明文密钥始终留在主进程。
 * Safebooru 是无需登录的站, 没有 Key 这一说, 所以这里只管 danbooru 一家。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspace } from './workspace.js'

const FILE_NAME = 'booru_auth.json'

function authFile() {
  const { appDir } = getWorkspace()
  return appDir ? path.join(appDir, FILE_NAME) : ''
}

/** @returns {{login: string, apiKey: string}} 没配过就是两个空串 */
export function readBooruAuth() {
  const p = authFile()
  if (!p) return { login: '', apiKey: '' }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { login: String(j.login || ''), apiKey: String(j.apiKey || '') }
  } catch { return { login: '', apiKey: '' } }
}

/** 任意一组用户名 + Key -> Basic 头; 没配齐返回 null */
export function authHeaderOf(login, apiKey) {
  if (!login || !apiKey) return null
  return 'Basic ' + Buffer.from(`${login}:${apiKey}`, 'utf8').toString('base64')
}

/** 给 fetch 用的 Authorization 头; 没配齐返回 null(调用方据此决定"匿名形状"的请求) */
export function danbooruAuthHeader() {
  const { login, apiKey } = readBooruAuth()
  return authHeaderOf(login, apiKey)
}

/**
 * 把「界面上当前填的」和「磁盘上已存的」合成一份 —— 测试连接用。
 * 某个字段留空 = 沿用已存的那个; 两个都填 = 用界面上这份(哪怕还没点保存)。
 */
export function resolveBooruAuth(raw = {}) {
  const cur = readBooruAuth()
  return {
    login: String(raw?.login || '').trim() || cur.login,
    apiKey: String(raw?.apiKey || '').trim() || cur.apiKey,
  }
}

/** 只回摘要 —— 这个返回值会过 IPC 到渲染层, 绝不能带明文密钥 */
export function booruAuthSummary() {
  const { login, apiKey } = readBooruAuth()
  return { login, hasKey: !!apiKey }
}

/**
 * 写入。语义要能配合界面上那个「读不回原 Key」的输入框:
 *   · 某个字段留空 = 沿用已存的那个(用户只想改用户名时不必重贴 Key);
 *   · `{ clear: true }` = 删除凭据文件, 回到匿名。
 * @returns {{ok: true, login: string, hasKey: boolean}|{error: string}}
 */
export function writeBooruAuth(raw = {}) {
  const p = authFile()
  if (!p) return { error: '工作目录还没初始化，凭据没地方存' }
  const cur = readBooruAuth()
  if (raw.clear === true) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch (e) { return { error: `清除失败: ${e?.message || e}` } }
    return { ok: true, login: '', hasKey: false }
  }
  const login = (String(raw.login || '').trim() || cur.login).slice(0, 64)
  const apiKey = (String(raw.apiKey || '').trim() || cur.apiKey).slice(0, 200)
  if (!login || !apiKey) return { error: '用户名和 API Key 要一起填（只填一个等于没配）' }
  try {
    fs.writeFileSync(p, JSON.stringify({ login, apiKey }, null, 2), 'utf8')
  } catch (e) {
    return { error: `写入失败: ${e?.message || e}` }
  }
  return { ok: true, login, hasKey: true }
}
