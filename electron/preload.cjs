/**
 * preload —— 渲染进程与主进程之间唯一的桥
 * ======================================
 * 渲染进程开了 contextIsolation + sandbox, 拿不到 Node, 也读不了文件,
 * 只能通过 window.tv 暴露的这几个方法说话。
 *
 * 注意: 这个文件必须是 CommonJS(.cjs)。sandbox 模式下的 preload 不支持 ESM,
 * 而项目 package.json 是 "type": "module", 所以扩展名不能写成 .js。
 */
const { contextBridge, ipcRenderer } = require('electron')

/**
 * 允许的 channel 白名单 —— 即使渲染进程被注入了脚本, 也只能调到这些能力,
 * 不能拿 ipcRenderer 去乱调。
 */
const CHANNELS = new Set([
  // 应用 / 数据集
  'app:status', 'app:reload', 'app:config', 'app:pickDataDir', 'app:openPath', 'app:revealPath',
  'app:ctxMenu', 'app:quickFolders', 'app:quickFolders:add', 'app:quickFolders:set',
  // 统计 / 搜索
  'stats:get', 'search:do',
  // 系列 / 角色
  'series:get', 'series:meta:get', 'series:meta:post', 'characters:get',
  // 自定义封面(2026-10-06): 系列卡/角色卡 ⚙️ 挑封面
  'covers:candidates', 'covers:set',
  // 标签
  'suggest:get', 'tags:all', 'tags:forPath', 'lightbox:data', 'translate:get',
  'tags:edit:preview', 'tags:edit:apply',
  // 标签分类映射(2026-10-16 展示分组用)
  'tags:cats',
  // tag 查重(2026-10-17)
  'dup:scan',
  'dup:ignore:add', 'dup:ignore:clear',
  // 规则
  'blacklist:get', 'blacklist:save', 'blacklist:toggle',
  'replace:get', 'replace:save', 'bg:get', 'rules:reload',
  // 替换规则组(2026-10-04): 多套规则手动命名、导出时选
  'replace:sets', 'replace:sets:save',
  // 导出默认目录(2026-10-04): 预填预设的目标目录, 省得每次开系统对话框
  'export:dirs', 'export:dirs:saveDefault',
  // 安全模式(按标签集合隐藏露骨内容; 只做展示层过滤)
  'safety:get', 'safety:set', 'safety:text', 'safety:save', 'safety:toggle',
  // 购物车历史
  'cart:history', 'cart:detail', 'cart:save', 'cart:delete', 'cart:rename',
  // 购物车自动导出(单预设): 上报变更 + 配置读写 + 立即导
  'cart:changed', 'cart:preset:get', 'cart:preset:save', 'cart:preset:run', 'cart:preset:flushNow',
  // 导出
  'export:preview', 'export:save', 'export:text', 'export:cart',
  // 导出预设(黑名单变更后自动导出)
  'export:preset:list', 'export:preset:save', 'export:preset:delete',
  'export:preset:run', 'export:preset:flush', 'export:preset:pickDir',
  // 延迟可配 + 待导出倒计时/立刻导出(2026-09-24)
  'export:preset:state', 'export:preset:delay', 'export:preset:flushNow',
  // 扫描
  'scan:pickFolder', 'scan:folder',
  // 增量入库(磁盘 <-> tags.db 对齐)
  'ingest:status', 'ingest:run', 'ingest:pause',
  // WD14 反推(消费 tag_queue)
  'tagger:status', 'tagger:config', 'tagger:run', 'tagger:pause',
  // 设置弹窗(2026-10-15): 加速探测 / 偏好写入 / 检查更新 / 版本号
  'tagger:accel', 'app:settings:set', 'app:checkUpdate', 'app:version',
  'tagger:setup-download',
  // 图片删除(移入回收站) / 批量移动(扫描页选择模式)
  'image:trash', 'image:moveMany', 'image:copyMany',
  // 收藏找回(按文件名搜已知目录)
  'fav:resolve',
  'dims:forPaths',
  // 文件夹登记表(扫描夹 + 看板来源 共用一份, 真源是 tags.db 的 folders 表)
  'folders:list', 'folders:add', 'folders:remove', 'folders:update',
  'folders:rescan', 'folders:open', 'folders:prune',
  'folders:purge', 'folders:export', 'folders:sync',
  // 剪贴板
  'clipboard:write',
  // 诊断
  'diag:stats', 'diag:clearSearchCache', 'diag:clearThumbs', 'diag:fileInfo',
])

/**
 * 主进程 → 渲染进程的单向推送。
 * ⚠️ 不在这个集合里的 channel，`on()` 会**静默**返回一个空退订函数（不报错），
 * 于是"主进程发了、界面没反应"。加推送通道时**两边都要改**（这里是白名单，
 * 消费端在 src/stores/useAppStore.js 的 init()）。
 */
const PUSH = new Set([
  'app:progress', 'app:reloaded', 'scan:progress', 'ingest:progress',
  'tagger:progress', 'export:auto', 'cart:auto',
  // 主进程主动要说的短句（右键「复制图片到剪贴板」动手前的进度提示）
  'app:toast',
  // 反推环境下载进度（Python 运行时 / WD14 模型, TvSetupProgress 卡片消费）
  'tagger:setup-progress',
  // 流式扫描（2026-10-16）: 大文件夹扫到首批就能进, 后台每批推进度、扫完全量修正
  'scan:partial', 'scan:final',
])

/** 自定义协议的 URL 构造 —— 与 imageproto.js 的解析必须成对 */
function thumbUrl(p, w = 400) {
  if (!p) return ''
  return `tv://thumb/?p=${encodeURIComponent(p)}&w=${w}`
}
function fileUrl(p) {
  if (!p) return ''
  return `tv://file/?p=${encodeURIComponent(p)}`
}

contextBridge.exposeInMainWorld('tv', {
  /** 调主进程能力。channel 不在白名单内直接报错, 不静默失败。 */
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) {
      return Promise.reject(new Error(`未授权的 channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },

  /** 订阅主进程推送(加载进度/重载通知/扫描元数据进度)。返回退订函数。 */
  on(channel, cb) {
    if (!PUSH.has(channel)) return () => {}
    const fn = (_e, data) => cb(data)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.removeListener(channel, fn)
  },

  thumbUrl,
  fileUrl,

  /** 渲染进程可以据此知道自己在 Electron 里(而不是浏览器里), 用来做能力降级 */
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
