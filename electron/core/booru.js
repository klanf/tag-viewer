/**
 * Booru 在线搜图 —— 换封面弹窗里「从网上挑一张」的数据源
 * ======================================================
 * 为什么要有这个: 批量抓封面脚本(.e2e-work/fetch-danbooru-covers.mjs)是**脚本盲选**
 * —— 按分数前 200 挑第一张合格的, 用户看不到过程, 所以经常出现「这张根本看不出是谁」。
 * 这里给的是精修口: 渲染层把要搜的 tag 发来 → 出缩略图网格 → 用户点中意的那张 →
 * 主进程下载落盘 → 走和「本地挑图」完全同一条 setCover 链路。
 *
 * 两个源的实测差异(2026-10-22 按真实请求逐条验证, 别照文档想当然):
 *   · Danbooru  /posts.json, rating 是单字母(g/s/q/e), 分页用 page=,
 *                **匿名只允许 2 个普通标签**(第三个普通标签直接 422; 但 `rating:g`
 *                这类元标签不占额度 —— 实测), 而且匿名的 order 参数完全被忽略。
 *                填了 API Key 这两条都放开 —— 见 booru-auth.js。
 *   · Safebooru dapi(index.php?page=dapi&s=post&q=index&json=1), rating 是**整词**
 *                (general/questionable/explicit), **不支持 order:score**(传了返回空 body),
 *                分页用 **pid=(0 基)**, 无结果也是 HTTP 200 + 空 body —— 所以
 *                "不是 JSON 数组"既可能是被限流也可能是真没图, 只能一并当错误抛给界面。
 *   本机此刻的可达性: danbooru.donmai.us DNS 能解析但 TCP 连接超时(后台抓取因此停在
 *   330/5007), safebooru.org 通。所以默认源仍是 danbooru(词表准、分数排序好用),
 *   连不上时界面上换 Safebooru 即可 —— 不要在本模块里偷偷自动切源, 用户要看得见用的是哪个站。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
import { danbooruAuthHeader, authHeaderOf, resolveBooruAuth } from './booru-auth.js'

const UA = 'tag-viewer/1.0 (cover picker)'
const API_TIMEOUT_MS = 20000
const DL_TIMEOUT_MS = 60000
/** 下载体积上限: 封面再大也不该是几十 MB 的原图, 超了直接报错, 免得把磁盘/内存打满 */
const MAX_BYTES = 25 * 1024 * 1024

/**
 * 下载主机白名单 —— 只按**域名后缀**放行本站自己的图床, 不接受响应里给的其它主机,
 * 否则等于把「任意 URL 写盘」开给了远端(见 booruDownload 的注释)。
 */
const SOURCES = {
  danbooru: {
    label: 'Danbooru',
    api: (q) => `https://danbooru.donmai.us/posts.json?${q}`,
    hostSuffixes: ['donmai.us'],
    /* 20 → 40(2026-10-22 实测): 匿名 limit=40 和 60 都能正常返回, 官方文档写的匿名上限是 40。
     * 页长翻倍 = 人气排序多采样一倍, 请求数一个都没多。 */
    maxLimit: 40,
  },
  safebooru: {
    label: 'Safebooru',
    api: (q) => `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&${q}`,
    hostSuffixes: ['safebooru.org', 'donmai.us'],
    maxLimit: 100,
  },
}

export function booruSourceList() {
  return Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label }))
}

/** Danbooru 字母 / Safebooru 整词 -> 统一成字母, 界面只认 g/s/q/e */
const RATING_WORDS = { general: 'g', safe: 's', questionable: 'q', explicit: 'e' }
function normRating(r) {
  const s = String(r || '').toLowerCase()
  return RATING_WORDS[s] || (['g', 's', 'q', 'e'].includes(s) ? s : '')
}

const IMG_EXT_RE = /\.(jpe?g|png|webp|avif|gif)$/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** ugoira(Danbooru 的逐帧 zip)/mp4/webm 这些没有图片后缀, 靠这条排除 */
const VIDEO_EXT_RE = /\.(mp4|webm|zip|swf)$/i

/** 用户传的 tags 允许字符串或数组; 空格在 booru 查询里就是「与」 */
function tagList(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/)
  const out = []
  for (const t of arr) {
    const s = String(t || '').trim().toLowerCase()
    if (s && !out.includes(s)) out.push(s)
  }
  return out.slice(0, 6)
}

/** 空格编码成 `+` —— 两个站的 dapi 都按 `+` 分隔标签, %20 在 safebooru 那边不认 */
const encodeTags = (list) => list.map((t) => encodeURIComponent(t)).join('+')

/** 单个 post 归一化; 两个站字段名不同, 统一在这里做, 上面调用方不关心源 */
function normPost(source, p) {
  const file = String(p.file_url || '')
  const sample = String(p.sample_url || p.large_file_url || '')
  /* 缩略图字段两个站**不一样**, 取错会静默退到 sample: Danbooru 给的是
   * `preview_file_url`(cdn.donmai.us/180x180/…, 约 7KB), Safebooru 给的是
   * `preview_url`(thumbnails/…, 约 10KB)。2026-10-22 真机踩过: 只读 preview_url
   * 时 Danbooru 的 preview 恒空, 网格 20 张全去拉 88KB 的 sample, 把这条抖链路
   * 直接打死 —— 满屏破图。 */
  const preview = String(p.preview_url || p.preview_file_url || '')
  if (!file || VIDEO_EXT_RE.test(file)) return null
  if (!IMG_EXT_RE.test(file) && !IMG_EXT_RE.test(sample)) return null
  const tags = typeof p.tag_string === 'string'
    ? p.tag_string.split(/\s+/).filter(Boolean)
    : String(p.tags || '').split(/\s+/).filter(Boolean)
  return {
    id: Number(p.id) || 0,
    preview, sample, file,
    rating: normRating(p.rating),
    score: Number(p.score) || 0,
    width: Number(p.width) || Number(p.image_width) || 0,
    height: Number(p.height) || Number(p.image_height) || 0,
    ext: (file.match(IMG_EXT_RE) || sample.match(IMG_EXT_RE) || [null, 'jpg'])[1].toLowerCase(),
    tags,
    source_site: source,
  }
}

async function fetchJson(url, tries = 2, extraHeaders = null) {
  let res = null
  let lastErr = ''
  const sentAuth = !!extraHeaders?.Authorization
  const headers = sentAuth ? { 'User-Agent': UA, ...extraHeaders } : { 'User-Agent': UA }
  for (let i = 0; i < tries; i++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
      break
    } catch (e) {
      /* AbortSignal.timeout 只管「连上之后」, TCP 连不上是 undici 自己抛的
       * ConnectTimeoutError —— 本机到这两个站是**时通时断的慢链路**(实测: 同一句
       * Safebooru 请求, 上一轮 1 秒出图, 下一轮 10 秒握手超时; Danbooru 更是整天)。
       * 所以重试一次; 再不行才把错误交给界面, 让它提示换源。 */
      const code = e?.cause?.code || e?.name || ''
      lastErr = /TIMEOUT/i.test(code) ? '连接超时' : code === 'ENOTFOUND' ? '域名解析不了' : code || e?.message || '连接失败'
      res = null
      if (i + 1 < tries) await sleep(1200)
    }
  }
  if (!res) return { status: 0, error: `连不上该站(${lastErr}，已重试 ${tries} 次)。换个源再试：Danbooru 与 Safebooru 通不畅的时候不一样` }
  if (res.status === 429) return { status: 429, error: '该站限流中(HTTP 429)，歇一会儿再搜或换个源' }
  if (res.status === 401) {
    // 带了凭据还被 401 = Key 本身不对, 与"网络不通""匿名被拒"是三回事, 分开说
    return { status: 401, error: sentAuth
      ? '用户名与 API Key 不匹配(HTTP 401)：确认是 Danbooru 本人账号的 Key、复制时没带空格'
      : '该站要求提供凭据(HTTP 401)' }
  }
  if (res.status === 403) {
    // 填了 Key 还 403, 十有八九是用户名/密钥不匹配(或复制时带了空格), 说清楚点省得用户去猜网络
    return { status: 403, error: sentAuth
      ? '该站拒绝了这组凭据(HTTP 403)，检查设置里的用户名与 API Key 是否成对、有没有多复制空格'
      : '该站拒绝匿名访问(HTTP 403)，试试 Safebooru 源' }
  }
  if (res.status === 404) return { status: 404, error: '没这个标签(404)' }
  if (res.status === 422) {
    /* Danbooru 的 422 不是一个笼统的"参数错": 响应体里明确写了原因
     * (最常见是匿名超过 2 个普通标签: PostQuery::TagLimitError)。
     * 2026-10-24 用户真机只看到「HTTP 422」, 没法判断是凭据没生效还是网络改写,
     * 所以把站方的 message 和 error code 带出来。读 body 失败就退回状态码。 */
    let detail = ''
    try {
      const t = await res.text()
      try {
        const j = JSON.parse(t)
        const msg = String(j?.message || j?.error || '').trim()
        const code = String(j?.error || '').trim()
        detail = msg && code && code !== msg ? `${msg}（${code}）` : msg
      } catch { detail = t.trim().slice(0, 180) }
    } catch { /* body 读不到就只说状态码 */ }
    return { status: 422, error: detail ? `HTTP 422：${detail}` : 'HTTP 422（站点拒绝了这个查询，没给原因）' }
  }
  if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` }
  /* 读 body 也要包起来(2026-10-22): AbortSignal.timeout 覆盖的是整个请求, 头已经到手、
   * 正文还在慢慢吐的时候到点, 抛的是 res.text() 里的 TimeoutError。原先这一句在 try 外面,
   * 于是**界面拿到的是 IPC 异常**而不是"换个源再试"这句话 —— 表现是点了搜索之后满屏空白、
   * 主进程日志里一句 [ipc] handler 异常。慢链路上这比连不上更常发生。 */
  let text
  try {
    text = await res.text()
  } catch (e) {
    const code = e?.cause?.code || e?.name || ''
    return { status: 0, error: `读到一半断了(${/TIMEOUT/i.test(code) ? '超时' : code || '网络错误'})，换个源或稍后再试` }
  }
  if (!text.trim()) return { posts: [] }          // Safebooru 无结果 = 200 + 空 body
  let json
  try { json = JSON.parse(text) } catch {
    return { error: '返回的不是 JSON（多半是被限流或分页参数不对），稍后再试' }
  }
  if (!Array.isArray(json)) {
    // Danbooru 单页无结果时回 {} 或 <posts/> 形态, 不是错误
    return { posts: [] }
  }
  return { posts: json }
}

/**
 * 搜索。
 * raw: { source, tags, page=1, limit, rating='g' }
 * 返回 { source, label, posts:[归一化 post], order, credentialed, error? }
 *   order: 'score' 只在**配了 Danbooru API Key** 时出现(站方按人气返回), 否则 'score_local'
 *   credentialed: 这次请求带没带 Key(界面用它决定那句话怎么说)
 */
export async function booruSearch(raw = {}) {
  const source = SOURCES[raw.source] ? raw.source : 'danbooru'
  const cfg = SOURCES[source]
  const tags = tagList(raw.tags)
  if (!tags.length) return { error: '没有可搜的标签' }
  const page = Math.max(1, Number(raw.page) || 1)
  /* 不传 limit 就按各源允许的最大页长要 —— 反正排序只能在"这一批"里排, 一批多几张
   * 就等于人气判得准一点, 而请求数不变。 */
  const limit = Math.max(1, Math.min(cfg.maxLimit, Number(raw.limit) > 0 ? Number(raw.limit) : cfg.maxLimit))
  /* 界面传的 rating 是「最多放到哪一档」: g=只看安全级(默认), s=放开敏感, all=不限。
   * 之所以默认只出 g: 这个弹窗挂在系列/角色卡上, 手一抖点到就是封面位, 不该把
   * explicit 摊在候选第一屏。q(存疑) 归进 s 一档。 */
  const allow = raw.rating === 'all' ? null : raw.rating === 's' ? new Set(['g', 's', 'q']) : new Set(['g'])

  let list = tags
  /* 带 Key 与匿名的区别(2026-10-22 实测, 不是照文档抄的):
   *   · 标签额度: 匿名的 2 个额度**只算普通标签**, `rating:g` 这类元标签不占 —— 所以
   *     「角色 + solo」加上「rating:g」匿名也发得出去(实测 422 只出现在第三个普通标签);
   *     登录后额度放开, 才能写「角色 + solo + 画师 + rating」这种;
   *   · order=score: **匿名完全无效**(七个取值返回同一批最新图), 登录后才生效,
   *     这时候"人气"是站方排的, 不是我们在几十张里自己比的。 */
  /* authHeader 显式传 null = 强制匿名(测试连接用); 不传 = 读已保存的凭据。
   * 显式传入是为了让「测试连接」能测**界面上刚填、还没保存**的那一份 Key。 */
  const authHeader = source === 'danbooru'
    ? (raw.authHeader !== undefined ? raw.authHeader : danbooruAuthHeader())
    : null
  const credentialed = !!authHeader
  const ordinary = tags.filter((t) => !t.includes(':')).length
  const cap = source === 'danbooru' && !credentialed ? 2 : 6
  if (source === 'danbooru' && allow && allow.size === 1 && (credentialed || ordinary <= cap)) {
    list = [...list, `rating:${[...allow][0]}`]      // 只有单档(默认 g)能变成一个标签
  }
  /* 用户自己写的标签超过额度时**照原样发出去**, 让站点报错(422), 而不是在这里悄悄砍掉几个 ——
   * 砍了会把查询条件放宽(少一个 solo 就是完全不同的结果集), 用户看到的结果对不上他勾的选项。 */
  const ratingOnServer = list.length > tags.length
  /* 排序这件事: 匿名请求里 Danbooru 完全忽略 order 参数 —— 拿 order=score / score_desc /
   * _score / featured / quality / random / nday 七个值各发一遍, 返回的 id 序列一模一样
   * (都是最新那批), 说明这条参数没登录就不生效; Safebooru(Moebooru dapi)
   * 更是要么不认要么整页返空。所以**只有配了 Key 才发 order**, 界面上的那句话照实说。
   * 想让人气判得准一点而又不登录, 可行的是"每页多要几张 + 多翻几页再合起来排" —— 见 booruBestPosts。 */
  const orderParam = source === 'danbooru' && credentialed ? '&order=score' : ''
  const q = source === 'danbooru'
    ? `tags=${encodeTags(list)}&limit=${limit}&page=${page}${orderParam}`
    : `tags=${encodeTags(list)}&limit=${limit}&pid=${page - 1}`

  const r = await fetchJson(cfg.api(q), 2, authHeader ? { Authorization: authHeader } : null)
  if (r.error) {
    // 超额度被拒是"配 Key 就能解决"的那类失败, 补一句指路, 别让人以为网络坏了
    const over = source === 'danbooru' && !credentialed && ordinary > cap
    return {
      error: over ? `${r.error} —— Danbooru 匿名只允许 ${cap} 个普通标签(这次带了 ${ordinary} 个，rating: 这类不算)，去 设置 → 在线封面 填 API Key 就能放开` : r.error,
      source, label: cfg.label, credentialed, status: r.status || 0,
    }
  }

  let posts = r.posts.map((p) => normPost(source, p)).filter(Boolean)
  if (allow) posts = posts.filter((p) => allow.has(p.rating))
  // 两个源拿到的都是「最新一页」, 人气顺序全靠这里排 —— 所以"人气"只在采样范围内成立
  posts.sort((a, b) => b.score - a.score || b.id - a.id)
  return {
    source, label: cfg.label, posts, page, limit,
    /** 'score' = 站方按人气返回(需要 Key) / 'score_local' = 服务端只给最新, 分数是本批里本地排的 */
    order: source === 'danbooru' && credentialed ? 'score' : 'score_local',
    credentialed,
    /** 这次没登录、被匿名额度卡住的标签数(界面上用来解释"rating 只能本地筛") */
    anon_tag_cap: source === 'danbooru' && !credentialed ? cap : 0,
    filtered_client_side: source === 'danbooru' ? !ratingOnServer : true,
  }
}

/**
 * 「测试连接」(2026-10-22, 2026-10-24 调整)
 * ==========================================
 * 三标签查询是「匿名必定发不出去」的探针(匿名上限 2 个普通标签):
 *   · 200 -> 凭据真的生效;
 *   · 401 -> Authorization 确实发了, 但用户名/Key 不匹配;
 *   · 422 -> 站点仍按匿名处理 —— 可能是没带凭据、带了一份站方不认的凭据,
 *     也可能是换了网络/代理之后 Authorization 头在路上被丢了(2026-10-24 用户真机: 换网络后 422)。
 * 所以 422 时再用同一条凭据发一个**两标签**查询复核: 能通说明站点确实在做匿名判定,
 * 也就是这组 Key 没生效, 把网络/Key 两种可能都说清楚, 而不是只丢一个 HTTP 422。
 *
 * raw 支持 { login, apiKey }: 测的是界面上当前填的那份(即便还没点保存);
 * 留空的字段沿用已保存的。没有凭据时只测网络(两标签匿名合法), 不再把匿名当失败。
 */
export async function booruAuthTest(raw = {}) {
  const { login, apiKey } = resolveBooruAuth(raw)
  const header = authHeaderOf(login, apiKey)

  if (!header) {
    const anon = await booruSearch({
      source: 'danbooru', tags: ['1girl', 'solo'], rating: 'all', limit: 1, authHeader: null,
    })
    if (anon.error) return { ok: false, error: anon.error, credentialed: false, sentAuth: false, status: anon.status || 0 }
    return { ok: true, credentialed: false, sentAuth: false, hits: (anon.posts || []).length }
  }

  const s = await booruSearch({
    source: 'danbooru', tags: ['1girl', 'solo', 'long_hair'], rating: 'all', limit: 1, authHeader: header,
  })
  if (!s.error) {
    return {
      ok: true,
      credentialed: true,
      sentAuth: true,
      order: s.order,
      /** 返回条数 > 0 说明这条三标签查询被站方接受了(匿名会被截成两个标签或 403) */
      hits: (s.posts || []).length,
    }
  }
  if (s.status === 422) {
    const probe = await booruSearch({
      source: 'danbooru', tags: ['1girl', 'solo'], rating: 'all', limit: 1, authHeader: header,
    })
    if (!probe.error) {
      return {
        ok: false, credentialed: true, sentAuth: true, status: 422,
        error: `凭据没生效：站点仍按匿名处理（三标签查询被拒）。可能是当前网络/代理把登录信息丢了（刚换过网络尤其常见），或 Key 已失效、用户名与这个 Key 不配对 —— 先点「测试连接」重试一次，仍然这样就去 Danbooru 重新生成一个 Key。站点原话：${s.error}`,
      }
    }
  }
  return {
    ok: false, credentialed: true, sentAuth: true,
    status: s.status || 0, error: s.error,
  }
}

/**
 * 「尽量挑人气最高的那张」——批量自动拉封面用的, 因为单次 booruSearch 只够看见最新一页。
 * raw: { source, tags, rating, pages=2 }
 * 返回 { posts:[合并去重后按分数降序], sampled, errors:[每页的错误] }
 *
 * 为什么要多翻一页: 匿名接口只按最新返回, 一个只有 100 张图的小众角色, 第一页(最新 40 张)
 * 里最高分可能就是 2 分; 翻到第 2 页, 真正被赞多的那几张才进得来。**翻得越多越接近真人气,
 * 但每页都是一次抖链路上的请求**, 所以默认只 2 页, 且某一页失败不影响已经拿到的结果。
 */
export async function booruBestPosts(raw = {}) {
  const pages = Math.max(1, Math.min(4, Number(raw.pages) || 2))
  const byId = new Map()
  const errors = []
  for (let page = 1; page <= pages; page++) {
    const s = await booruSearch({ ...raw, page, limit: 0 })   // limit=0 -> 走各源的 maxLimit
    if (s.error) {
      errors.push(s.error)
      /* 第 1 页就没搜到: 直接返回错误(调用方要区分"连不上"和"没结果");
       * 后面的页失败: 拿已有结果就行, 不必因此判整批失败。 */
      if (!byId.size) return { error: s.error, posts: [], sampled: 0, errors }
      break
    }
    for (const p of s.posts || []) if (!byId.has(p.id)) byId.set(p.id, p)
    if (!(s.posts || []).length) break        // 翻到头了, 不必再请求
  }
  const posts = [...byId.values()].sort((a, b) => b.score - a.score || b.id - a.id)
  return { posts, sampled: posts.length, errors, source: posts[0]?.source_site || (raw.source === 'safebooru' ? 'safebooru' : 'danbooru') }
}

/**
 * Windows 文件名净化: `: * ? " < > |` 非法, 其中 `:` 会被 NTFS 当成备用数据流(ADS)
 * 分隔符 —— 标签里带冒号的角色(如 honkai:_star_rail)写出去会变成一个空壳文件 +
 * 一个隐藏数据流(批量抓取脚本已踩过)。另外防 `..`/绝对路径穿越, 因为 tag 来自渲染层。
 */
function safeFileTag(tag) {
  const s = String(tag || '').replace(/[:*?"<>|/\\]/g, '_').replace(/\.\./g, '_').trim()
  return (s || 'post').slice(0, 80)
}

function hostAllowed(url, cfg) {
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return cfg.hostSuffixes.some((suf) => h === suf || h.endsWith('.' + suf))
}

/**
 * 远程缩略图代拉 —— 渲染进程的 <img> **不许**直接连这两个站
 * =========================================================
 * 2026-10-22 真机定位: 主进程带自定义 UA 拉 `cdn.donmai.us/180x180/…` 是 200,
 * 渲染进程同一个 URL 拿到的是 **Cloudflare 403 + text/html**(CDP 抓到的响应头),
 * 于是满屏破图。差别只在请求头(UA/accept-language 那套是浏览器形状)。
 * 所以这里由主进程代拉, 渲染层只认 `tv://remote/?u=…`:
 *   · 走的是和 booruDownload 同一条已验证可用的 undici + 自定义 UA
 *   · 主机白名单复用一份逻辑, 不给渲染层开「加载任意远端 URL」的口子
 *   · CSP 因此不需要放行任何 https 远端主机
 * 缩略图很小但本机链路抖, 所以带一个内存缓存 + 同 URL 并发去重(20 张一起滚不会打爆)。
 */
const IMAGE_HOST_SUFFIXES = [...new Set(Object.values(SOURCES).flatMap((s) => s.hostSuffixes))]
const IMG_MAX_BYTES = 8 * 1024 * 1024
const IMG_TIMEOUT_MS = 25000
const IMG_CACHE_KEEP = 150

const imgCache = new Map()          // url -> Buffer(命中即重插, 近似 LRU)
const imgInflight = new Map()       // url -> Promise, 同一张图并发只发一次请求

function imageHostAllowed(url) {
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return IMAGE_HOST_SUFFIXES.some((suf) => h === suf || h.endsWith('.' + suf))
}

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }

/** @returns {Promise<{buf: Buffer, ct: string}|{error: string}>} */
export async function booruImageBuffer(rawUrl) {
  const url = String(rawUrl || '')
  if (!imageHostAllowed(url)) return { error: `图片主机不在白名单内: ${url.slice(0, 80)}` }
  const hit = imgCache.get(url)
  if (hit) { imgCache.delete(url); imgCache.set(url, hit); return { buf: hit, ct: MIME_BY_EXT[path.extname(new URL(url).pathname).toLowerCase()] || 'image/jpeg' } }
  if (imgInflight.has(url)) return imgInflight.get(url)

  const job = (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(IMG_TIMEOUT_MS) })
      if (!res.ok) return { error: `远端返回 HTTP ${res.status}` }
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) return { error: '远端返回空内容' }
      if (buf.length > IMG_MAX_BYTES) return { error: `图片太大(${Math.round(buf.length / 1048576)}MB)` }
      imgCache.set(url, buf)
      while (imgCache.size > IMG_CACHE_KEEP) imgCache.delete(imgCache.keys().next().value)
      const ct = MIME_BY_EXT[path.extname(new URL(url).pathname).toLowerCase()] || res.headers.get('content-type') || 'image/jpeg'
      return { buf, ct }
    } catch (e) {
      return { error: `拉图失败(${e?.cause?.code || e?.name || e?.message || '网络错误'})` }
    } finally {
      imgInflight.delete(url)
    }
  })()
  imgInflight.set(url, job)
  return job
}

/**
 * 这张图是不是「网上挑封面」下载下来的。
 * setCover() 本来要求图必须在库里(不然挑上去就是 404), 但 user_picks 这批**故意**
 * 不在库 —— 它们只是为了当封面而下载的远程图, 不该被扫进 tags.db。
 * 归一后再比前缀, 免得 `..`/斜杠写法混用绕过判断; 相对路径一律不认。
 */
export function isUserPickPath(p) {
  const s = String(p || '').trim()
  if (!s || !path.isAbsolute(s)) return false
  const norm = (x) => path.resolve(x).toLowerCase().replace(/[\\/]+$/, '')
  const base = norm(path.join(dataFile('char_covers'), 'user_picks'))
  const full = norm(s)
  return full.startsWith(base + path.sep)
}

/** 用户挑中的那张图落到 data/char_covers/user_picks/，返回库内约定的正斜杠绝对路径 */
export async function booruDownload(raw = {}) {
  const source = SOURCES[raw.source] ? raw.source : 'danbooru'
  const cfg = SOURCES[source]
  const url = String(raw.url || '')
  if (!hostAllowed(url, cfg)) return { error: `下载地址不在白名单内: ${url.slice(0, 80)}` }
  const postId = Number(raw.post_id) || 0
  const m = url.match(IMG_EXT_RE)
  if (!m) return { error: '不是可保存的图片地址' }

  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(DL_TIMEOUT_MS) })
  } catch (e) {
    const code = e?.cause?.code || e?.name || ''
    return { error: `下载连不上(${code || e?.message || '网络错误'})` }
  }
  if (!res.ok) return { error: `下载失败 HTTP ${res.status}` }
  const len = Number(res.headers.get('content-length')) || 0
  if (len > MAX_BYTES) return { error: `图片太大(${Math.round(len / 1048576)}MB)，换一张` }
  let buf
  try {
    buf = Buffer.from(await res.arrayBuffer())     // 传输中途断在这里也算未捕获异常
  } catch (e) {
    return { error: `下载中断(${e?.cause?.code || e?.message || e?.name})` }
  }
  if (buf.length > MAX_BYTES) return { error: `图片太大(${Math.round(buf.length / 1048576)}MB)，换一张` }

  // char_covers/ 没进 DATA_ROUTE 登记表 -> dataFile() 原样留在 data/ 根, 与批量抓取脚本同目录
  const dir = path.join(dataFile('char_covers'), 'user_picks')
  fs.mkdirSync(dir, { recursive: true })
  const name = `${safeFileTag(raw.tag)}_${postId || Date.now()}.${m[1].toLowerCase()}`
  const dest = path.join(dir, name)
  // 先写 .part 再改名: 中途断电/超时会留下半张图，而半张 jpg 会被 TvImage 当有效封面显示成破图
  const tmp = dest + '.part'
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, dest)
  return { path: dest.split(path.sep).join('/'), bytes: buf.length, post_id: postId, source }
}
