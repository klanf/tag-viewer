/**
 * 渲染进程访问主进程的唯一入口
 * ============================
 * 所有后端调用都从这里出去。做了四件事:
 *  1. 包一层 Promise, 把主进程返回的 { error } 变成真正的 reject ——
 *     调用处就能用 try/catch, 不用每次判断返回值里有没有 error 字段。
 *  2. 保留一个浏览器降级: 万一在浏览器里打开(dist 目录直接双击), window.tv 不存在,
 *     给出明确的报错而不是 "undefined is not a function"。
 *  3. 图片 URL 构造集中在这里 —— 与主进程 imageproto.js 成对, 改一边必须改另一边。
 *  4. 出口处统一 `toPlain()` 拆掉 Vue 的响应式代理 —— 否则一个 reactive 对象过桥
 *     就是 `An object could not be cloned.`, 见 toPlain 的注释。
 */

const tv = typeof window !== 'undefined' ? window.tv : null

export const isElectron = !!tv?.isElectron

export function thumbUrl(path, width = 400) {
  if (!path) return ''
  return tv ? tv.thumbUrl(path, width) : ''
}

export function fileUrl(path) {
  if (!path) return ''
  return tv ? tv.fileUrl(path) : ''
}

/**
 * 把载荷里的**响应式代理**拆成纯数据 —— 凡是要过桥的参数都得先过这里。
 * ==================================================================
 * 背景(2026-09-22 实测, 用户报「导出预设的时候报错」):
 *   `ipcRenderer.invoke` 走结构化克隆, 而 **Proxy 一律克隆不了**。页面里把
 *   Vue 的 reactive/ref 对象(或它**嵌套**的属性/数组)直接传过去, 就抛
 *   `An object could not be cloned.` —— 而且实测是**在 contextBridge 那层就抛了**:
 *   拿未授权的 channel 传纯对象能拿到我们自己的「未授权的 channel」,
 *   传 Proxy 则只拿到克隆失败 —— 说明 preload 里那个白名单检查压根没轮到执行。
 *   所以这道防线只能放在渲染进程这一侧, 放到 preload 已经太晚。
 *
 * 为什么"展开一层"救不了: `presets.value[i]` / `editing.value` 都是 reactive 代理,
 *   `{ ...p }` 展开出来的 `params` 仍是**嵌套代理**, 里面 `params.source` 还是代理。
 *
 * 只做"去代理 + 复制成纯对象/数组", 其他类型原样交出去:
 *   · Date / Map / Set / Buffer / TypedArray / 类实例 -> 不碰(结构化克隆本来就支持)
 *   · 函数 / Symbol -> 不碰, 让它们照旧**响亮地报错**, 不在这里静默吞掉
 * 用 WeakMap 兜住循环引用, 免得栈溢出。
 */
export function toPlain(v, seen = new WeakMap()) {
  if (v === null || typeof v !== 'object') return v
  // 裸传 ref 是常见手误, 而且 RefImpl 自带 dep/effect 链表 -> 克隆必炸。先取 .value。
  if (v.__v_isRef === true) return toPlain(v.value, seen)
  if (Array.isArray(v)) {
    if (seen.has(v)) return seen.get(v)
    const out = []
    seen.set(v, out)
    for (let i = 0; i < v.length; i++) out[i] = toPlain(v[i], seen)
    return out
  }
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return v
  if (seen.has(v)) return seen.get(v)
  const out = {}
  seen.set(v, out)
  for (const k of Object.keys(v)) out[k] = toPlain(v[k], seen)
  return out
}

/**
 * 调主进程。失败时 throw Error, message 是主进程给的错误文本。
 */
export async function call(channel, payload) {
  if (!tv) {
    throw new Error('未在 Electron 中运行 —— 请用 npm start 启动应用, 不要直接打开 dist/index.html')
  }
  const r = await tv.invoke(channel, toPlain(payload))
  if (r && typeof r === 'object' && r.error) {
    const err = new Error(r.error)
    err.code = r.code
    err.payload = r
    throw err
  }
  return r
}

/** 订阅主进程推送。返回退订函数。 */
export function onPush(channel, cb) {
  if (!tv) return () => {}
  return tv.on(channel, cb)
}

/* ------------------------------------------------------------ 分领域封装
   这些薄封装不是为了"少打字", 而是让调用处的语义明确:
   看到 `api.search({q})` 就知道在走搜索接口, 而不是一堆魔法字符串。 */

export const api = {
  // 应用 / 数据集
  status: () => call('app:status'),
  reload: () => call('app:reload'),
  appConfig: () => call('app:config'),
  pickDataDir: () => call('app:pickDataDir'),
  openPath: (target) => call('app:openPath', { target }),
  revealPath: (target) => call('app:revealPath', { target }),
  /** 图片右键菜单: 主进程弹原生菜单, 返回 { action: 'detail'|'toggle-fav'|null } */
  ctxMenu: (payload) => call('app:ctxMenu', payload),

  // 统计 / 搜索
  stats: (q) => call('stats:get', q),
  search: (q) => call('search:do', q),

  // 系列 / 角色
  series: (q) => call('series:get', q),
  seriesMeta: () => call('series:meta:get'),
  saveSeriesMeta: (body) => call('series:meta:post', body),
  characters: (q) => call('characters:get', q),

  // 标签
  suggest: (q) => call('suggest:get', q),
  allTags: (q) => call('tags:all', q),
  tagsForPath: (path) => call('tags:forPath', { path }),
  lightbox: (path) => call('lightbox:data', { path }),
  translate: (tags) => call('translate:get', { q: tags.join(',') }),

  // 规则
  blacklistGet: () => call('blacklist:get'),
  blacklistSave: (text) => call('blacklist:save', { text }),
  blacklistToggle: (tag) => call('blacklist:toggle', { tag }),
  replaceGet: () => call('replace:get'),
  replaceSave: (text) => call('replace:save', { text }),
  bgGet: () => call('bg:get'),
  rulesReload: () => call('rules:reload'),

  // 购物车历史
  cartHistory: () => call('cart:history'),
  cartDetail: (name) => call('cart:detail', { name }),
  cartSave: (name, cart) => call('cart:save', { name, cart }),
  cartDelete: (name) => call('cart:delete', { name }),
  cartRename: (oldName, newName) => call('cart:rename', { old_name: oldName, new_name: newName }),

  // 导出
  exportPreview: (q) => call('export:preview', q),
  exportSave: (q) => call('export:save', q),
  exportText: (q) => call('export:text', q),
  exportCart: (tags, opts) => call('export:cart', { tags, ...opts }),

  // 导出预设: 存好筛选条件+目标目录, 黑名单一变就自动覆盖导出一次
  exportPresets: () => call('export:preset:list'),
  exportPresetSave: (preset) => call('export:preset:save', preset),
  exportPresetDelete: (id) => call('export:preset:delete', { id }),
  exportPresetRun: (id) => call('export:preset:run', { id }),
  exportPresetFlush: () => call('export:preset:flush'),
  pickExportDir: () => call('export:preset:pickDir'),

  // 扫描
  pickFolder: (opts) => call('scan:pickFolder', opts),
  scanFolder: (q) => call('scan:folder', q),

  // 增量入库(磁盘 <-> tags.db 对齐)。run 是"启动即返回", 进度走 ingest:progress 推送。
  ingestStatus: () => call('ingest:status'),
  ingestRun: () => call('ingest:run'),
  ingestPause: () => call('ingest:pause'),

  // WD14 反推(消费 tag_queue, 写 tags_src='wd14')。同样是"启动即返回", 进度走 tagger:progress。
  // 缺 python / 模型时不是失败而是降级 —— status().degraded / config.missing 会说明缺什么。
  taggerStatus: () => call('tagger:status'),
  taggerConfig: () => call('tagger:config'),
  taggerRun: (opts) => call('tagger:run', opts),
  taggerPause: () => call('tagger:pause'),

  // 图片删除(移入系统回收站)
  trashImages: (paths) => call('image:trash', { paths }),

  // 文件夹登记表 —— 扫描夹与看板来源**共用一份**(真源是 tags.db 的 folders 表)。
  // folders(opts) 的 usage: 'scan'(默认, 扫描页) / 'source'(看板来源) / 'all'(全部登记过的)
  folders: (opts) => call('folders:list', opts),
  addFolder: (q) => call('folders:add', q),
  // 移出登记表: 只把用途开关归零, 不删库里的图片记录(误删可恢复)
  removeFolder: (path) => call('folders:remove', { path }),
  // 彻底清除: 连库里的图片记录一起删(高危, 调用方必须先二次确认)
  purgeFolder: (path) => call('folders:purge', { path }),
  updateFolder: (q) => call('folders:update', q),
  rescanFolder: (q) => call('folders:rescan', q),
  openFolder: (q) => call('folders:open', q),
  pruneFolders: () => call('folders:prune'),
  exportFolders: () => call('folders:export'),
  // 单个来源立即同步(只跑这一个目录)
  syncFolder: (q) => call('folders:sync', q),

  // 剪贴板
  copy: (text) => call('clipboard:write', { text }),

  // 诊断
  diag: () => call('diag:stats'),
  clearSearchCache: () => call('diag:clearSearchCache'),
  clearThumbs: () => call('diag:clearThumbs'),
}
