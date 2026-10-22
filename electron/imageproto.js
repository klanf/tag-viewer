/**
 * 自定义协议 tv:// —— 替代原 Python 版的 /api/image
 * =================================================
 * 三种用途:
 *   tv://thumb/?p=<encoded 绝对路径>&w=400   缩略图(磁盘缓存, image/jpeg)
 *   tv://file/?p=<encoded 绝对路径>          原图(流式返回, 支持 Range, 大图不占内存)
 *   tv://ping/                                探活
 *
 * 为什么不用 file://:
 *   渲染进程开了 contextIsolation + sandbox, 不该直接读任意本地文件;
 *   走自定义协议可以在主进程集中做「路径必须存在 / 必须在白名单根目录下」的校验,
 *   同时 file:// 下 Chromium 对 Range 请求与缓存头的控制很差, 大图会完整读进内存。
 *
 * URL 里的路径用 encodeURIComponent 编码。Windows 路径含 `#` `+` `空格` `中文`,
 * 编码后 `#`->%23 / `+`->%2B, 经 searchParams 解码能原样还原。
 */
import fs from 'node:fs'
import path from 'node:path'
import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { getThumb } from './core/thumbs.js'
import { booruImageBuffer } from './core/booru.js'

export const SCHEME = 'tv'

/** 必须在 app ready 之前调用 */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ])
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml',
}

const notFound = (msg) => new Response(msg, { status: 404, headers: { 'Content-Type': 'text/plain' } })

export function registerHandler() {
  protocol.handle(SCHEME, async (request) => {
    let url
    try { url = new URL(request.url) } catch { return notFound('bad url') }

    if (url.hostname === 'ping') {
      return new Response('pong', { headers: { 'Content-Type': 'text/plain' } })
    }

    /* 远程缩略图代拉(2026-10-22): 渲染层 <img src="https://cdn.donmai.us/…"> 会被
     * Cloudflare 403(主进程同一个 URL 是 200, 差在请求头), 所以网上挑封面一律走这里。
     * 主机白名单在 booruImageBuffer 里, 不给渲染层开「加载任意远端 URL」。 */
    if (url.hostname === 'remote') {
      const r = await booruImageBuffer(url.searchParams.get('u') || '')
      if (r.error) {
        return new Response(r.error, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
      return new Response(r.buf, {
        headers: {
          'Content-Type': r.ct,
          'Content-Length': String(r.buf.length),
          'Cache-Control': 'max-age=86400',
        },
      })
    }

    const p = url.searchParams.get('p')
    if (!p) return notFound('missing p')

    // 安全校验: 必须是个存在的普通文件, 且不能是目录
    let st
    try { st = await fs.promises.stat(p) } catch { return notFound('not found') }
    if (!st.isFile()) return notFound('not a file')

    if (url.hostname === 'thumb') {
      const w = Math.max(16, Math.min(2048, parseInt(url.searchParams.get('w') || '400', 10) || 400))
      const buf = await getThumb(p, w)
      if (buf) {
        return new Response(buf, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': String(buf.length),
            'Cache-Control': 'max-age=604800',
          },
        })
      }
      // 生成不了(webp/bmp/gif/损坏) -> 落到下面发原图
    }

    // 原图: 交给 Electron 的 net 直接流式读, Range / ETag / 缓存头都是现成的
    const res = await net.fetch(pathToFileURL(p).toString())
    const headers = new Headers(res.headers)
    const ct = MIME[path.extname(p).toLowerCase()]
    if (ct) headers.set('Content-Type', ct)
    headers.set('Cache-Control', 'max-age=86400')
    return new Response(res.body, { status: res.status, headers })
  })
}
