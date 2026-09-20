/**
 * 渲染进程访问主进程的唯一入口
 * ============================
 * 所有后端调用都从这里出去。做了三件事:
 *  1. 包一层 Promise, 把主进程返回的 { error } 变成真正的 reject ——
 *     调用处就能用 try/catch, 不用每次判断返回值里有没有 error 字段。
 *  2. 保留一个浏览器降级: 万一在浏览器里打开(dist 目录直接双击), window.tv 不存在,
 *     给出明确的报错而不是 "undefined is not a function"。
 *  3. 图片 URL 构造集中在这里 —— 与主进程 imageproto.js 成对, 改一边必须改另一边。
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
 * 调主进程。失败时 throw Error, message 是主进程给的错误文本。
 */
export async function call(channel, payload) {
  if (!tv) {
    throw new Error('未在 Electron 中运行 —— 请用 npm start 启动应用, 不要直接打开 dist/index.html')
  }
  const r = await tv.invoke(channel, payload)
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
