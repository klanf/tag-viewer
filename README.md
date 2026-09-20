# TagViewer (Electron + Vue 3 重构版)

WD14 标签可视化看板 —— 由原来的「Python `http.server` + 8 个手写 HTML 页面」重构为
**单进程 Electron 应用 + Vue 3 组件化前端**。

- **数据目录可配置**：黑名单、替换规则、收藏备注、购物车历史、翻译库、`tags.db`、
  缩略图缓存都放在同一个「数据目录」里。解析优先级：
  `settings.json` > 环境变量 `TV_DATA_DIR` > `<userData>/data`（新装机器的默认值）。
  详见下方「路径与数据目录」。
- 标签数据会**导入一份 SQLite 库**（`tags.db`，在数据目录下）当索引用 ——
  首轮导入一次，之后靠指纹跳过。**库现在是唯一真源**（`folders` 表管「有哪些目录、
  各自什么用途」），`tags_*.txt` 已降级为一次性的导入介质 / 可导出的备份。
- 运行时**不再需要 Python**：原来的 22 个 HTTP 端点全部变成 IPC channel。
- **图片与元数据彻底分离**：图片始终留在你自己的磁盘上，应用只读本机文件、
  不做任何上传。设计上可对外分发的是「知识」（标签翻译 / 系列角色映射），不含图片；
  当前仓库里**一个数据文件都没有**（见 `.gitignore` 的说明与 `data/*.example.json` 模板）。

---

## 快速开始

```bat
双击「启动看板.bat」          :: 或 启动看板.vbs（不弹黑框）
```

首次在这台机器之外的环境部署时：

```bat
npm install        :: 自动把本机已有的 Electron 运行时硬链过来，不重新下载 100+MB
npm run build      :: 构建前端到 dist/
npm start          :: 启动（等价于双击启动脚本）
```

> `npm install` 的“复用本机已有运行时”这一步靠 `scripts/local-config.mjs` 找候选目录。
> 找不到就会退回官方下载；也可以自己写一份 `local.config.json`（模板见
> `local.config.example.json`）把本机路径填进去，该文件不进仓库。

| 命令 | 作用 |
|---|---|
| `npm start` | 构建好的版本直接启动 |
| `npm run dev` | Vite dev server + Electron 热更新（改前端不用重新构建） |
| `npm run check` | 静态预检：import 可解析 + IPC channel 两侧一致 + 启动脚本编码 + 模板绑定无遗漏 + **源码里没有硬编码绝对路径** |
| `npm run build` | 预检 + 构建 |
| `npm run smoke` | **30 秒冒烟**：起一个实例，报告落在哪个视图、首屏多少卡片、有无 JS 报错 |
| `npm run e2e` | 预检 + 构建 + **132 条断言的端到端验证**（详见下文） |
| `npm run test:ipc` | 主进程 IPC handler 单测（10 条，无需窗口） |
| `npm run test:transfer` | 文件搬移逻辑单测（9 条） |
| `npm run test:db-safety` | **数据安全**：空数据源绝不清空 `tags.db`（26 条） |
| `npm run test:nodata` | **空数据目录启动降级**：不崩、不白屏、给出可操作引导（12 条，会弹一次窗口） |
| `npm run test:paths` | 单独跑硬编码路径检查 |
| `npm run selftest` | 只跑主进程数据层，与 Python 版逐项对账（不需要 Electron） |
| `npm run search:check` | 搜索/统计口径对账：不同参数下各返回多少条 |
| `npm run db:info` | 看标签库现状（条数、来源表、文件大小、有没有过期） |
| `npm run db:import` | 把 `tags_*.txt` 增量灌进 `tags.db`（指纹未变则跳过） |
| `npm run db:import:force` | 忽略指纹全量重建 |
| `npm run db:verify` | **逐条比对**库与 txt 是否完全一致 |
| `npm run db:export` | 把库导回 `tags_*.txt` 格式（用于回归旧版） |
| `npm run db:reset` | 删掉 `tags.db`（下次启动会自动重建） |
| `npm run test:folders` | 登记表单测：路径归一 / 两个用途开关互不干扰 / 移出可恢复（47 条，无需窗口） |
| `npm run test:ingest` | 增量同步单测：指纹跳过 / 裸图入队不入库 / 删图标 gone（46 条） |
| `npm run test:tagger` | WD14 反推管道单测（59 条）。用 JSON-lines 桩替身，**不加载 1.27GB 模型** |
| `npm run folders:export` | 把登记表（`folders` 表）导出成 `folders.json` 备份 |
| `npm run txt:archive` | **归档 `tags_*.txt`（默认干跑）**：列清单 + 与库逐项对账，对不上就拒跑 |
| `npm run txt:archive:apply` | 同上，真正整批移进 `_legacy_归档_<日期>/`（同目录改名，可还原） |
| `npm run txt:archive:undo` | 把归档的 `tags_*.txt` 整批移回原位 |
| `npm run data:backup` | 给 `tags.db` 打一份带日期的备份 |
| `npm run data:plan` | 只看数据目录的重排计划（不动文件） |
| `npm run data:lint` | 检查数据目录布局有没有待搬的文件 |
| `npm run check:templates` | 单独跑模板绑定检查（找出模板里引用了、但 `<script setup>` 没定义的名字） |
| `npm run prune:dist` | 检查 `dist/assets` 里有没有过期产物（默认只报告） |
| `npm run prune:dist:apply` | 同上，并在数量安全时真的删除 |

---

## 路径与数据目录

全项目的路径解析只有一个真源：`electron/core/paths.js`（零 Electron 依赖，纯函数 + 调用方注入）。
其它模块一律从这里取，不再各算各的 —— 之前有 3 份等价的「默认数据目录」和 2 份日志目录实现，
改一处漏两处。

### 数据目录

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `settings.json` 的 `dataDir` | 真实设置文件在 `<userData>/settings.json`（Windows: `%APPDATA%\TagViewer\`） |
| 2 | 环境变量 `TV_DATA_DIR` | 适合脚本/多套数据切换 |
| 3 | `<userData>/data` | **新装机器的默认值**，一定是可写目录 |

数据目录里放什么，按「能不能对外分发」分三类（见 `paths.js` 的
`KNOWLEDGE_FILES` / `USER_FILES` / `DERIVED_FILES`）：

| 类别 | 文件 | 会不会随仓库分发 |
|---|---|---|
| **知识** | `local_translations.json`、`character_library.json`、`weilin_data*/` | 设计上可分发（不含图片），但**来源与授权需先核实**，当前一律不进仓库 |
| **用户数据** | `export_blacklist.txt`、`export_replace.txt`、`export_bg.txt`、`user_meta.json`、`cart_history.json`、`folders.json`、`.thumb_cache/` | **绝不出机器** |
| **可再生派生物** | `tags.db`、`scan_cache.json` | 不进仓库。都内嵌本机文件路径，将来若要随包分发必须先从里面**提炼**出纯标签/系列/角色子集 |

数据目录不存在时会自动创建。里面没有任何标签数据时，应用不会崩，而是显示
「还没有配置标签数据源」并告诉你把 `tag_viewer_config.json` 放哪（见 `TvBootOverlay`）。

### 数据源：真源是 `tags.db`，不是 txt

**一句话**：`tags.db` 的 `folders` 表是「有哪些目录、它们各自的用途」的唯一真源；
`tags_*.txt` 与 `scan_folders.json` 都已降级为**一次性的导入介质 / 可导出的备份**。

```
磁盘目录 ──(登记)──> folders 表 ──(增量同步)──> images 表 ──> 界面
                        ▲                          ▲
              「来源管理」页可增删改          tags_*.txt 只是首次导入的来源
```

`folders` 表里两个独立开关决定一个目录的用途：

| 开关 | 含义 | 图片去哪 |
|---|---|---|
| `as_source=1` | **看板来源** | 进 `images`、进统计、可被搜索 |
| `as_scan=1` | **扫描夹** | 只在扫描页浏览，**不进库** |
| 两个都是 0 | 已移出登记表 | 行还留着，开关打回来即可恢复（库里的记录一条不掉） |

同一个目录可以两个都开（如既是来源又是扫描夹）。「只看 AI 新生成图」这类目录应当
**只开扫描夹** —— 它不该被追平进标签库。

**怎么加/删来源**：顶栏 →「🗄️ 来源」。添加即登记 + 扫描；「移出」只注销用途（可恢复）；
「彻底清除」才会连库里的图片记录一起删（高危，需二次确认，磁盘文件始终不动）。

#### `tag_viewer_config.json` 现在是什么

数据目录下的 `tag_viewer_config.json`，模板见 `data/tag_viewer_config.example.json`。
这个文件允许 `//` 整行注释。三个来源字段（`data_files_dir` / `data_files` / `data_file`）
现在只用于**首次灌库**：库里已经有数据之后，它们不再决定「有哪些来源」。

- 配置里的 `tags_*.txt` 若指纹（size + mtime）没变，启动时是**空转**，一行都不读；
- 配置读不出来（文件丢失/损坏）时得到一个空数据源 —— 此时应用继续从 `tags.db` 读，
  **并且不会把库里已有的来源和图片删掉**（这条有专门测试守着，见 `test:db-safety`）；
- 把 `tags_*.txt` 全部移走也是安全的：来源集合为空时同步直接早退，一个字节都不动，
  而来源列表读的是 `folders` 表，所以界面上的来源一个不少。

> ⚠️ **要移走 `tags_*.txt` 就必须 9 个一起移**，不能挑着移。原因见
> `docs/数据源合并与增量入库方案.md` §5.4：旧的 `syncSources` 会把「配置里已拿掉的
> 来源」从库里 DELETE，只移一部分会让剩下那些 txt 对应的来源被清理掉。
>
> 归档有现成命令（**默认干跑**，只报告不动文件；它会先把每个 txt 与库逐项对账，
> 对不上就拒跑）：
>
> ```bat
> npm run txt:archive          :: 干跑：列清单 + 与库对账
> npm run txt:archive:apply    :: 整批改名移进 _legacy_归档_<日期>/（可还原）
> npm run txt:archive:undo     :: 整批移回原位
> ```
>
> 归档是**同目录改名移动**，不删字节；归档目录里的东西要不要删由你自己决定。

`folders.json`（旧名 `scan_folders.json`，由 `paths.js` 路由到 `data/user/`）
只是登记表的**导出备份**，用 `npm run folders:export` 生成，随时可以重新导出；
真源丢了也不会因此丢来源。

翻译库（`translate_dir`）是另一条独立的解析规则，**默认留空就行**：

| `translate_dir` | 行为 |
|---|---|
| 留空 `""`（推荐） | 自动在数据目录下找 `weilin_data*` —— 把翻译库整个丢进数据目录就能用，不必写绝对路径 |
| 填绝对路径 | 用指定的那个目录；**路径失效时会自动回落到上面的自动发现**，并在 `launch.log` 里记一条 `warn` |
| 两种都找不到 | 不启用翻译，界面只显示英文标签（不会崩） |

`weilin_data*` 被 `paths.js` 归为「知识目录」（`KNOWLEDGE_DIR_PREFIXES`），
所以放在数据目录里就等于被认领 —— 这也是它跟 `local_translations.json`、
`character_library.json` 一样被 `.gitignore` 排除、只随「知识包」分发的原因。

每次启动都会在 `launch.log` 里留一行翻译库的实际加载结果，例如：

```
[ok] 翻译库: WeiLin 7540 条 + 本地补译 4072 条 = 11580 条 · 来源=数据目录自动发现 · dir=...\data\weilin_data(...)
```

WeiLin 读到 0 条、或配置里的路径不存在，这一行会变成 `[warn]` —— 这样「翻译整体消失」
就不用靠肉眼去发现了。

### 日志

| 场景 | 日志目录 |
|---|---|
| 开发期（`npm start` / 双击启动脚本） | `<仓库>/logs/`，写 `launch.log` 与 `ready.flag` |
| 打包后 | `<userData>/logs/` —— 打包后 `__dirname` 在只读的 asar 里，项目内 `logs/` 写不进去 |
| 覆盖 | 环境变量 `TV_LOG_DIR`（语义是**目录**） |

两个启动脚本靠 `<仓库>/logs/ready.flag` 判断「窗口是不是真的起来了」，所以开发期这条路径不能变。
渲染进程的报错会经主进程转发进同一份日志（`[render]` / `[ipc-err]` 前缀）。

### 本机专属配置

开源后仓库里不能出现任何开发机的绝对路径。凡是「只有这台机器才成立」的值，
写进 `local.config.json`（**已被 `.gitignore` 排除**，模板见 `local.config.example.json`）：

| 键 | 用途 | 等价环境变量 |
|---|---|---|
| `electronDist[]` | Electron 运行时候选目录（复用本机已有 dist，免下载 100+MB） | `TV_ELECTRON` / `TV_ELECTRON_DIST` |
| `dataDir` | 命令行工具（selftest / db / harness）默认数据目录 | `TV_DATA_DIR` |
| `oldRoot` | 旧版 Python 工具根目录，只有 `build:char-lib` 的迁移路径用得到 | `TV_OLD_ROOT` |

### 硬编码路径守卫

`scripts/check-paths.mjs`（已接进 `npm run check`）会扫描 `electron/`、`scripts/`、`src/`
与根目录启动脚本，出现盘符绝对路径（`X:\` / `X:/`）、`%USERPROFILE%` 即报错。两条例外：

- 该行（或其**上方 3 行内**）写着 `path-check-ignore` —— 用于「这就是个示例文本」的场合；
- 文件登记在 `scripts/paths-allowlist.json` 里并写明理由（整文件粒度）。

---

## 为什么要重构（原版的实际痛点）

| 原版的做法 | 问题 | 现在 |
|---|---|---|
| 6 个 HTML 各抄一份顶栏 / 大图预览 / toast / 跟随气泡 | 改一处要改 6 遍，漏一处就行为不一致 | 全部在 `App.vue` 挂一次，视图只管自己内容 |
| 标签 pill 的渲染逻辑散在 5 个页面里 | 中文、计数、ban 态、点击行为各写各的 | `TvTagPill` / `TvTagList` 一处实现，5 个页面复用 |
| 分页与无限滚动是两套代码 | 语义还不太一样 | `useImageFeed` 一个 composable 收敛 |
| 浏览器里白等十几秒（无进度） | 用户以为卡死 | 主进程推送进度 + `TvBootOverlay` |
| 后端靠 `pythonw` 常驻 8080 端口 | 多一个运行时、约 780MB 内存 | 同进程内 IPC，无端口、无 HTTP |
| 剪贴板/另存为/选文件夹靠浏览器能力 | 权限与焦点问题（tkinter 弹窗还要强行置顶抢焦点） | Electron 原生 `clipboard` / `dialog` |

---

## 目录结构

```
tag-viewer-electron/
├─ electron/                     主进程（Node，无框架）
│  ├─ main.js                    窗口 + 菜单 + 启动编排
│  ├─ preload.cjs                contextBridge 桥（白名单制，sandbox 下必须 CJS）
│  ├─ ipc.js                     40 个 channel 的路由 + 数据就绪门禁
│  ├─ imageproto.js              tv:// 协议（缩略图 / 原图 / 探活）
│  └─ core/                      纯数据层，不认识 IPC 也不认识窗口
│     ├─ workspace.js            数据目录定位（默认指向原 Python 版目录）
│     ├─ config.js               读带 // 注释的 JSON 配置
│     ├─ tagfile.js              tags_*.txt 的逐行解析（两条加载路径共用）
│     ├─ store.js                tags.db（SQLite）读写 + 源文件指纹
│     ├─ dataset.js              加载数据集（优先读库，失败回退 txt）+ 系列/角色索引
│     ├─ search.js               搜索 + 结果缓存 + 排序（含随机种子）
│     ├─ query.js                22 个业务查询（stats/search/series/tags/...）
│     ├─ rules.js                黑名单 / 替换 / 背景补全
│     ├─ translate.js            node:sqlite 读 WeiLin 翻译库 + 本地补充
│     ├─ thumbs.js               nativeImage 缩略图 + 磁盘缓存
│     ├─ png.js                  PNG tEXt/iTXt 元数据解析（ComfyUI/A1111/NAI/InvokeAI）
│     ├─ prompt.js               提示词 → 标签
│     ├─ scan.js                 扫描文件夹（带内存缓存）+ 共用标签分析
│     ├─ folders.js              文件夹登记表（folders 表 = 来源 + 扫描夹）
│     ├─ ingest.js               增量入库：磁盘 <-> tags.db 对齐（六条判定规则）
│     ├─ tagger.js               WD14 反推管道（消费 tag_queue，可降级）
│     ├─ exporter.js             导出（纯标签 / 带路径 / 购物车）
│     ├─ meta.js · cart.js       用户元数据 / 购物车历史
│     └─ app-state.js            启动编排 + whenReady() 门禁
├─ tools/tagger_serve.py         WD14 反推常驻服务（JSON-lines over stdio）
├─ src/                          渲染进程（Vue 3 + Pinia + vue-router）
│  ├─ components/base/           11 个基础件（TvButton/TvInput/TvSelect/TvModal/TvImage/...）
│  ├─ components/tag/            4 个标签件（TagPill/TagList/TagBars/TagSuggestInput）
│  ├─ components/image/          3 个图片件（ImageCard/ImageGrid/Lightbox）
│  ├─ components/series/         TvEntityCard（系列/角色通用卡）
│  ├─ components/cart/           4 个购物车件（Drawer/Item/Checkout/History）
│  ├─ components/rules/          规则编辑器 + 分类管理
│  ├─ components/filter/         来源筛选条
│  ├─ components/layout/         顶栏 / 启动遮罩 / toast / 后台任务胶囊
│  ├─ views/                     8 个视图，与旧版页面一一对应（+ 来源管理）
│  ├─ stores/                    7 个 Pinia store
│  ├─ composables/               图片流 / 搜索历史
│  ├─ utils/                     IPC 封装 / 格式化 / localStorage 键名登记表
│  └─ styles/tokens.css          设计变量（唯一一处颜色/间距/字号来源）
├─ test-fixtures/scan-test/      扫描页测试图 5 张（纯色 PNG + 内嵌生成参数）
├─ scripts/                      构建、启动与验证脚本
├─ .e2e-work/                    测试工作目录（自动生成, 已 gitignore）
├─ 启动看板.bat / .vbs            双击启动（vbs 不弹黑框）
└─ README.md
```

代码量：主进程 3269 行 / 前端组件 3477 行（29 个组件）/ 视图+状态 2691 行。

---

## 组件复用（本次重构的重点）

原来重复的写法收敛成这些组件，**同一个组件在多处复用**：

| 组件 | 复用在哪些地方 |
|---|---|
| `TvTagPill` | 首页大图预览、详情页、标签页、购物车结算预览、扫描页 |
| `TvTagList` | 大图预览、详情页、扫描页标签区 |
| `TvImageGrid` | 首页（分页）、系列图片（无限滚动）、标签图片、扫描结果 |
| `TvImageCard` | 同上 4 处，`favable` / `selectable` 两个开关切换模式 |
| `TvSourceChips` | 首页、系列页、标签页 |
| `TvEntityCard` | 系列列表、角色列表（`selectable` 进入多选模式） |
| `TvRulesEditorModal` | 黑名单、标签替换（同一组件两套配置） |
| `TvComboBox` | 分类管理里的系列/分类选择 |
| `TvTagSuggestInput` | 首页筛选框（带历史 + 中英文补全） |

事件契约统一用 `props` 进 / `emit` 出：`TvImageCard` 只对外发
`open` / `toggle-fav` / `toggle-select`，页面自己决定跳哪儿 —— 所以同一个格子
在首页是"开大图"、在系列页是"勾选"。

---

## 后端能力对照（HTTP → IPC）

`preload.cjs` 的白名单就是完整清单（40 个 channel），关键映射：

| 原 HTTP | 现在 | 说明 |
|---|---|---|
| `/api/stats` | `stats:get` | 统计 + 各来源图片数 |
| `/api/search` | `search:do` | 搜索 + 分页 + 排序（含随机种子） |
| `/api/series` `/api/characters` | `series:get` `characters:get` | 系列/角色索引 |
| `/api/series_meta` (GET/POST) | `series:meta:get` `series:meta:post` | 自定义分类/角色/隐藏 |
| `/api/alltags` | `tags:all` | 标签浏览（含 ban 态、中文） |
| `/api/suggest` | `suggest:get` | 中英文补全 |
| `/api/tags` `/api/lightbox` | `tags:forPath` `lightbox:data` | 单图标签（库外图回退读 PNG 元数据） |
| `/api/translate` | `translate:get` | 中文翻译 |
| `/api/blacklist` `/api/replace` `/api/bg` | `blacklist:*` `replace:*` `bg:get` | 规则读写 |
| `/api/export` `/api/export_cart` | `export:preview` `export:save` `export:text` `export:cart` | 导出（原生另存为） |
| `/api/cart_history*` | `cart:history` `cart:detail` `cart:save` `cart:delete` `cart:rename` | 结算历史 |
| `/api/scan` `/api/scan_pick` | `scan:folder` `scan:pickFolder` | 扫描（选目录走原生对话框） |
| — | `folders:*` | 扫描文件夹「收藏夹」的增删改查（新增） |
| `/api/image` | `tv://thumb/?p=…&w=…` `tv://file/?p=…` | 自定义协议代替 HTTP 图片端点 |
| `navigator.clipboard` | `clipboard:write` | 主进程写系统剪贴板 |

---

## 2026-09-18 三项优化

### 1. 大图预览：滚轮翻页 + 点空白关闭

旧版要点开下一张必须「关掉 → 找图 → 再点」，看一批图就是几十次点击。

| 交互 | 实现要点 |
|---|---|
| **滚轮 / 触控板上下滑** | 累计 `deltaY` 到 55px 才切一张，切完进 190ms 冷却。**不能按事件直接切** —— 触控板一次滑动会连发几十个 `deltaY≈3` 的事件，那样会"飞"过去。停手 120ms 没攒够就清零 |
| **点图片区任何空白** | 关闭（`.lb-img-wrap` 整片，含图片本身）。侧栏 `@click.stop`，因为那边要点标签 |
| **← / → / PgUp / PgDn** | 翻页；**Esc** 关闭。光标在输入框里时不抢键 |
| **点遮罩边缘 / ✕** | 关闭 |
| **底部「‹ n / m ›」** | 显示当前位置，箭头可点；不在列表里（库外图）就整块不显示 |
| **左右浮动大箭头** | 到首/尾自动禁用 |

翻页的前提是知道"当前这批图是什么"。所以 `lightbox.open(path, { list })` 新增第二个参数，
各页面把 `feed.items.map(i => i.path)` 传进去；翻页时**按 path 而不是下标**做竞态保护 ——
切图快时慢请求回来会覆盖新图，`load()` 里比对 `path.value !== p` 就丢弃过期结果。

**顺手补的一个显示问题**：外部图片的 ban 命中。实测扫描页的库外图 0% 命中黑名单是**正常的**
（它们的标签来自画师自己的 PNG 元数据，跟库内 71k 张不同源；库内约 25% 命中），
但界面上「没有提示」和「没适配」长得一样。现在光箱里显式给出两种状态之一：
`🚫 命中黑名单 N 个` 或 `✅ 本图无标签命中黑名单`，前者 hover 能看到具体是哪几个词。

### 2. 扫描页 → 文件夹库（两级）

原来每次都要「重新选目录 / 重新粘路径 → 扫描」，目录一多就是体力活。

```
文件夹卡片列表                    ┌ 点进去 ─┐             图片网格(二级)
[📁 涩一点点]  [📁 ai图\26_09_18]  ──────────→   面包屑 ‹ 全部文件夹 / 涩一点点
 含提示词 412 · 8 种提示词 · 封面            共用基础标签 2 个: 1girl, halo
 ✏️ 改名  🗑 移除 ← hover 才出现             [缩略图网格, 点开进大图预览]
```

- 索引落在数据目录的 `scan_folders.json`（`electron/core/folders.js`）。
  **只存路径 + 上次统计 + 封面，不存图片清单** —— 清单可能几千条，又大又容易过期；
  点开时现扫，且 `scan.js` 有内存缓存，第二次点开是秒开。
- 粘贴路径回车 = 添加（自动扫一遍并入库）；同一路径重复添加 = **刷新**，不会产生第二条。
- 移除记录**只删记录，绝不动磁盘上的文件**。
- 路径不存在时卡片标「路径失效」，不会崩。

### 3. 标签数据落 SQLite

> 📌 这一节记录的是 **2026-09-18 当时**的形态。此后 `tags.db` 已经从"索引"升级为
> **唯一真源**（`tags_*.txt` 变成可归档的导入介质），见上面「数据源」一节。
> 下表里的「现在」指的是 09-18 那次改动，不是今天的最终形态。

`tags_*.txt`（88MB、71,214 行）每次启动都要重新流式解析一遍。现在启动直接读
`tags.db`（`node:sqlite`，与翻译库同一套机制）：

| | 旧（每次都解析 txt） | 现在（读库） |
|---|---|---|
| 启动耗时 | 1,546 ms | **1,120 ms** |
| 数据源 | txt 是唯一真源 | txt 仍是真源，库是**带指纹的索引** |

- **指纹判失效**：每个 `tags_*.txt` 记（大小 + mtime），没变就整表跳过；变了才重新导入该源。
- **失败自动回退**：库不存在 / 打不开 / 表结构不对 → 直接走原来的 txt 解析路径，功能不受影响。
- **可回归**：`npm run db:export` 能把库导回 txt 格式；`npm run db:reset` 删库后下次启动自动重建。
- **逐条对账过**：`npm run db:verify` 把库和 txt 一条条比，71,214 条标签全一致（0 差异）。

---

## 验证

### 怎么跑

```bat
npm run e2e
```

它做三件事：静态预检 → 构建 → 用 CDP 驱动**真实运行的 Electron**逐视图断言。
不需要 Playwright（本机只有三样依赖，不想为一次验证再拉一整套浏览器）。

**数据隔离**：测试**自建工作目录 `.e2e-work/`**（项目内，已 gitignore），跑之前会把真实数据目录
里的 8 个状态文件（配置/黑名单/替换/背景/元数据/购物车/本地翻译/**角色库**）**复制**一份过去 ——
过程中会写文件的操作（ban 标签、购物车、结算历史）全都落在副本里，
不会污染用户真实积累的黑名单/购物车。同样地用独立的 `--user-data-dir`。

> ⚠️ 隔离靠的是**显式写一份 `<userData>/settings.json` 指向副本**，不能只靠 `TV_DATA_DIR`：
> `workspace.js` 的优先级是 `settings.json > TV_DATA_DIR`，只要 userData 下残留一份别的
> `settings.json`，环境变量就会被压过去，测试会**安静地读写用户的真实数据目录**。
> 2026-09-19 实测踩到过这个（早期排查脚本留下的 settings.json），已修。

```
.e2e-work/
├─ data/       数据副本（从真实数据目录复制，测试的写入落在这里）
├─ scan/       扫描页用的 5 张测试图（来自 test-fixtures/scan-test/）
├─ userdata/   独立的 Electron userData（单实例锁 + localStorage 都是干净的）
│              settings.json 每轮被覆盖成指向上面的 data/ —— 隔离的关键
└─ shots/      断言截图（16 张，文件名固定，每次覆盖）
```

扫描用的测试图是**项目自带**的（`test-fixtures/scan-test/`，5 张 400 字节的纯色 PNG，
分别带 ComfyUI / A1111 元数据、一张无元数据、两张提示词相同），
所以除了「真实数据目录」这一份，测试不依赖任何外部路径（真实数据目录按
`TV_REAL_DATA_DIR` > `local.config.json` 的 `dataDir` > 仓库内 `data/` 依次找）。

### 断言覆盖（132 条，全部通过）

> 下表是 **2026-09-18 基线（69 条）** 的快照，"实测值"一列反映当时的数据规模。
> 此后陆续加了增量同步 / WD14 反推 / 来源管理三组断言，加上光箱绿框的呼吸动画
> 1 条，总数到 **132 条**，
> 但下面这些**老断言仍在跑、仍然全绿**，只是数字没再逐格更新。

| 视图 | 关键断言 | 实测值 |
|---|---|---|
| 启动 | 数据集加载完成 / 规模 / 加载来源 | 71,214 张 / 11,019 标签 / 227 系列 · 1,120 ms · `source=db` |
| — | 运行期无 JS 异常 / Vue 警告 | 0 条 |
| 看板 | 首屏卡片数 / 匹配总数 / 分页条 / 高频标签 / 来源条 | 60 张 · 71,214 · 6 个页码 · 60 行 · 8 个来源 |
| — | 关键词搜索 | 71,214 → 1,014 |
| — | 换一批（随机种子）真的换了图 | 首图路径改变 |
| — | 来源筛选 | 垃圾桶 7,085 条 |
| — | 黑名单编辑器读到规则 | 454 条规则 / 7,921 字符 |
| 大图预览 | 标签 pill / 4 个复制按钮 / tv:// 缩略图 | 59~70 个 · 4 · 加载成功 |
| — | **列表上下文可翻页**（断言改成"先问数据再对 UI"） | 2 个箭头 · 角色区渲染行数 == 数据项数 |
| 系列 | 列表 / 分类 tab / 中文搜索 / 角色列表 / 排序 | 244 个系列 · 5 个分类 · 「蔚蓝」命中 2 个 · 149 个角色 |
| — | 选择模式批量入购物车 | 选中 149 → 角标 149 |
| — | **无限滚动真的会追加** | 60 → 120 |
| — | 分类管理三个页签 + 下拉 | 3 页签 / 2 下拉 |
| 标签 | 列表 / 中文 / 计数 / ban 态 / ban 可切换且能还原 | 300 个 · 300 有中文 · 84 已在 ban |
| — | 点标签进图片 | 64,832 条 |
| 购物车 | 条目 / 结算弹窗默认名 / 结算历史 | 149 个角色 · `2026-09-18 09:51` · 4 条历史 |
| 文件夹库 | 空列表 → 添加卡片 → 重复添加不重复 / 角标 / 工具按钮 | 1 张 · 3 种提示词 · 含提示词 4 · 2 个按钮 |
| — | 二级页图片网格 / 面包屑 / 分页条 | 5 张 · 面包屑 1 · 第 1/1 页 |
| 扫描 | 5 张图 / 4 张含提示词 / 3 种提示词 / 共用标签 / 来源角标 | 全部命中，共用基础标签 `1girl, halo` |
| — | 库外图可预览（标记「库外图片」） | comfyui · 9 标签 |
| — | 光箱：滚轮切下一张 / 切回上一张 / 方向键翻页 / 点空白关闭 / 点侧栏不关 | `1/5 → 2/5 → 1/5 → 2/5` |
| 详情 | 路由可直达并渲染 | 41 个标签，图片加载成功 |
| 主题 | 深色 ↔ 浅色 | dark → light，背景 `rgb(244,246,250)` |
| 来源管理 | 进得去 / 行数对得上 / 两个用途开关独立 / 移出后行还在且图不掉 / 恢复成功 / 导出 json | 9 行 · 8 来源 + 1 扫描夹 · 移出→恢复 · 导出 9 条 |
| 增量同步 | `ingest:status` 可调 / `diag` 有诊断 / **测试环境绝不自动跑** | `phase=idle` · 队列全 0 |
| 反推 | `tagger:status` 可调 / `diag` 有诊断 / **测试环境绝不自动跑** / 静态配置三项都在 | `phase=idle` · script+model+csv 都在 |
| 光箱删除 | **删除后不再请求那张已进回收站的图**（删除窗口 + 整轮总账两条，失败时带调用栈） | 0 条 · 0 条 |
| 光箱绿框 | 跟随翻页实时移动 / 关掉后仍在 / 点它直接回到那张 / 重启后从 localStorage 恢复 / **挂的真是呼吸动画**（防样式被写回静态描边） | 恰好 1 张 · `tv-lastviewed-breathe-*` |

截图落在 `.e2e-work/shots/`（17 张，覆盖每个视图 + 浅色主题）。
`npm run smoke` 的截图是同目录的 `00-smoke.png`；`--route=/sources` 可定点截某个视图，
`--eval="<js>"` 能在截图前先把状态摆好（例如绿框要先开一张图再关掉光箱才出现），
`--name=<名字>` 指定文件名。这类"重页面"的截图只有 smoke 靠得住 —— e2e 的截图
对图片网格会卡满 60s 超时。

**测试是幂等的**：连跑两遍都是 132/132。为此 `harness` 每轮会把沙箱的登记表复位
（先清两个用途开关、按 `src.records>0` 把真实来源打回来、再删测试自己加的目录 ——
顺序不能反，否则会把真实来源当测试夹删掉）。

沙箱的 `tags.db` **跨轮复用**；只在它不存在时，才从真实库 `VACUUM INTO` 一份当种子。
**不再从 `tags_*.txt` 重建** —— txt 是历史快照、没有 `gone` 标记，卡片会照样去渲染
磁盘上早已删掉的图，缩略图 404 会把「运行期无 JS 异常」**随机**顶红（实测每轮换一张图，
所以长期被当成闪烁）。真实库经过增量入库，`gone` 才是准的。

### 主进程性能与内存（e2e 结束时实测）

```
搜索缓存: 265 命中 / 81 未命中, 中位 23ms, 最大 137ms
缩略图:   265 命中 / 81 新建 / 0 失败, 磁盘缓存 1,355 个文件 46.6MB
翻译库:   11,372 条（WeiLin 7,540 + 本地 3,864）
内存:     RSS 268.1MB / heap 122.4MB / external 7.1MB
```

对比原 Python 版常驻约 780MB（含解释器）—— 这是去掉 Python 运行时之后最直观的收益。

---

## 六个踩过的坑（已修，留档备忘）

### 1. 窗口比数据先到，首屏数字偏小

窗口是**在数据集加载之前**就渲染出来的（否则会有十几秒白屏）。于是渲染进程挂载
首页时会立刻发 `stats:get` / `search:do` —— 那时 `ds.records` 只填了一半，
返回的快照自然偏小（实测显示 2,599 而不是 71,214，来源计数几乎全是 0），
而渲染进程拿到就存进 store，**之后再也不会自己刷新**，得手动点一次「搜索」才恢复。

修法两层：
- 主进程：数据类 channel 一律先 `await whenReady()` 再算（见 `app-state.js`）；
  加载结束后再统一作废派生缓存一次。
- 渲染进程：`useAppStore` 增加 `epoch`，数据从 loading 变 ready 就 +1，
  首页 watch 它重跑一次初始查询（这样菜单里的「重新加载数据」也能自动刷新已挂载的视图）。

### 2. 固定调试端口会连到旧实例

e2e 原本用固定端口 9223。只要机器上还有一份之前手工起的实例在监听，
`findPage()` 就会连到**那只旧窗口**上：初始路由不对、卡片数是别的视图的数字、
找不到首页的输入框……一路断言全挂，而新起的进程因为单实例锁已经退出了。
表现完全是"代码有问题"，实际代码没问题。

修法：每次随机取空闲端口 + 独立 userData + 校验连上的 URL 属于本项目 +
主进程早退就立刻报错。**看到"测试莫名其妙全挂"先怀疑连错实例。**

### 3. 构建产物不许攒着（否则构建直接失败）

`vite build` 默认 `emptyOutDir: true`：每次构建先把 `dist/` 清空重建。
在本机这撞上了执行环境的批量删除保护 —— 要删的文件超过 50 个就报
`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，构建直接红掉。

修法是**让构建不再需要删除**：`emptyOutDir: false` + 关掉文件名内容哈希
（`assets/[name].js` 固定名）。对本机 `file://` 加载的 Electron 应用来说，
内容哈希本来就没有价值 —— 没有 HTTP 缓存要绕，没有"必须换文件名"的理由。
改完之后每次构建是覆盖而不是先删后建，`dist/assets` 恒为 24 个文件，
连跑多次也不会变大（已实测）。历史上带哈希的旧产物用 `npm run prune:dist` 收拾。

### 4. 模板引用了未定义的绑定 —— **在生产构建里完全静默**

做「滚轮翻页 + 文件夹库」时踩的，值得单独留档，因为它是**最贵的一类 bug**：
不报错、不崩溃、连警告都没有，表现只是"某个按钮不出现"，看着像功能没做。

两个实例，都是同一个成因：

| 文件 | 模板里写了 | 实际情况 | 后果 |
|---|---|---|---|
| `HomeView` / `SeriesView` / `TagsView` | `lb.open(it.path, { list: imgPaths })` | 三个视图都**没定义 `imgPaths`**（只有 `ScanView` 定义了） | 传进去是 `undefined` → 光箱不知道"下一张是谁" → 翻页箭头/滚轮/方向键全都不出现 |
| `SeriesView` | `@load-more="onLoadMore"` | 没定义（应该是 `imgFeed.loadMore`） | **无限滚动一直是坏的**，滚到底永远不加载 |

**为什么没有立刻发现**：`<script setup>` 编译出来取不到的名字是 `$setup.xxx` → `undefined`，
不抛错；而开发期那句
`Property "imgPaths" was accessed during render but is not defined`
带 `__DEV__` 判断，`vite build` 会整段摇掉 —— 所以 e2e 里
「运行期无 Vue 警告」这条断言根本拦不住它。更糟的是当时那条无限滚动断言写的是
`after >= before + 0`（等于不比），于是 bug 又藏了一轮。

**修法（两层）**：

1. 代码：三个视图补上 `imgPaths` + `watch` 同步；`onLoadMore` → `imgFeed.loadMore`；
   断言改成 `after > before`。
2. **加了静态守卫 `scripts/check-templates.mjs`**，已接进 `npm run check` / `build`。
   原理很直接：Vue 编译器在 `prefixIdentifiers` 下，**能解析到 setup 绑定**的名字编译成
   `$setup.xxx`，**解析不到**的编译成 `_ctx.xxx`。所以拿 `compileScript` 给出的 `bindings`
   当 `bindingMetadata` 去编译模板，再扫产物里有没有 `_ctx.<名字>`，就能精确点名。
   几秒钟跑完，不用起 Electron（实测：故意把 `imgPaths` 写成 `imgPathsTYPO`，
   立刻报 `src/views/HomeView.vue -> 模板引用了未定义的名字 「imgPathsTYPO」（.vue 第 333 行）`）。

### 5. 测试自己不是幂等的（第二次跑必挂）

`e2e` 第一次跑 68/68 全绿，**第二次跑必挂一条**：`文件夹库: 首次进入是空列表 — 1 张`。
原因不是代码 —— 是上一轮测试把「扫描页收藏夹」`scan_folders.json` 写进数据副本，
留下的那条记录让"首次进入应该是空的"这个前提不再成立。

同理，首页大图预览那条断言原本假设"第一张图一定有角色/系列标签"，
但**首页默认排序是随机**（`sort = ref('random')` + 随机 seed），
所以第一张每启动一次都不一样 —— 实测第一遍 0 行 FAIL、第二遍 2 行 PASS。

修法：
- `harness` 每轮把 `scan_folders.json` **覆盖成空档**（只写不删，不碰批量删除保护）；
- 光箱断言改成**先问数据、再对 UI**：用 `lightbox:data` 查出这张图按定义该有几行，
  不满足就顺着列表往后翻（顺便验证翻页真的在换图），断言变成"渲染行数 == 数据项数"。

**判据是连跑两遍**：现在 71/71 × 2 全绿。只跑一遍就宣称通过的测试，等于没测。

### 6. e2e 的「数据隔离」曾经是失效的 —— 测试一直在读写用户的真实数据

`harness.ensureWorkDir()` 的注释写着「测试怎么改都污染不到用户真实积累的黑名单/购物车」，
但 2026-09-19 实测发现**这句承诺根本不成立**：`.e2e-work/userdata/` 里残留着一份早期排查脚本
写的 `settings.json`，里面 `dataDir` 指向**真实数据目录**。而 `workspace.js` 的解析优先级是

```
settings.json  >  TV_DATA_DIR  >  <userData>/data
```

`e2e.mjs` spawn 时只传了 `TV_DATA_DIR` —— 于是被那份 settings.json **悄悄地压掉了**。
后果是双重的，而且都很隐蔽：

- 测试写的 ban 标签 / 购物车 / 结算历史**全落在用户真实数据里**；
- `harness` 辛辛苦苦「每轮把 `scan_folders.json` 覆盖成空档」也没生效（它重置的是副本）。

**为什么不容易发现**：日志里只打一行 `[ok] dataDir=...\data` —— 复制出来的副本和真实目录
在日志里长得几乎一样，不逐字比对根本看不出来。

**修法**：隔离不能只靠环境变量，`ensureWorkDir()` 现在会**显式写**一份
`<userData>/settings.json`，把 `dataDir` 钉死到副本上（写，不删）。同时补上
`character_library.json` —— 少了它，扫描页的 key_tags/角色高亮、系列页的角色识别
都会降级（实测系列数从 386 掉到 244，`charLib` 直接 ENOENT），那批断言等于没测到真实路径。

**教训**：测试的隔离性必须**自己有一条断言**（或至少显式写死关键路径），
靠"我传了环境变量"是不够的 —— 只要优先级链上还有更高优先级的来源，隔离就是纸糊的。

---

## 与旧版共存 / 回滚

- 旧版仍在 `../tag_viewer/`，`tag_viewer.bat start` 照旧可用。
- 新版只**读**数据文件；写操作（黑名单、元数据、购物车历史）写的是同一批文件，
  所以两边的规则/收藏是共享的 —— 这是刻意的，避免出现两套数据。
- 想回滚：直接用旧版启动脚本即可，新版没有改动任何原有文件格式。
- `.thumb_cache` 共用：新版按同样的哈希命名写入，旧版也能直接读到，不重复占空间。
- ⚠️ **例外：`tags_*.txt` 一归档，旧版就看不到来源了**（旧版靠扫这个目录里
  `tags_*.txt` 的文件名来认识来源，新版改读库里的 `folders` 表）。
  真要回滚到旧版，先 `npm run txt:archive:undo` 把它们移回来。
  反过来，新版**不依赖**这些 txt，归档之后照样用。

## 已知差异 / 后续可做

| 项 | 现状 |
|---|---|
| 打包成 exe | 目前靠 `启动看板.bat` 直接调 Electron 运行时；如需单文件分发再加 electron-builder |
| 数据目录切换 | `electron/core/workspace.js` 支持 `TV_DATA_DIR` 环境变量；UI 里还没有入口 |
| 系列页滚动位置 | 面包屑返回时恢复了列表数据，但滚动位置尚未逐层还原 |
| 文件夹库的排序/搜索 | 目前按「添加时间倒序」；还没有排序与筛选 |
