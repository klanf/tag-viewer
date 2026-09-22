/**
 * 测试脚手架公用件
 * =================
 * e2e.mjs / smoke.mjs 都用得到, 所以抽出来:
 *   · ensureWorkDir()  —— 准备项目内的工作目录(数据副本 / 扫描夹 / userData / 截图)
 *   · freePort()       —— 每次随机取空闲调试端口, 避免连到机器上残留的旧实例
 *   · clearPageState() —— 把 localStorage/sessionStorage 清空后重载页面
 *   · sleep()
 *
 * 为什么"清状态"是在页面里做, 而不是删 userData 目录:
 *   1) 删目录会被安全策略按文件数拦截(leveldb 跑几轮就攒到 50+ 个小文件),
 *      脚本里做整目录删除是给自己找麻烦;
 *   2) 更关键的是 —— 真正会污染断言的只有 localStorage(主题/收藏/购物车/
 *      补背景开关/搜索历史)。Cache、GPUCache 那些留着反而启动更快。
 *   3) 这个目录里没有"必须从零"的东西, 所以清页面状态就够了。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { localDataDir } from './local-config.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 端到端测试的工作目录(全部在项目内, 且被 .gitignore 排除)
 * =========================================================
 * 为什么不在外面随便找个目录: 之前夹具放在项目外的临时目录下, 那个目录
 * 一看就是"临时目录", 谁清理一下测试就跑不起来了 —— 而且报错会是"数据集加载失败"
 * 之类完全指不到原因的话。现在全部落在项目内:
 *
 *   .e2e-work/data/      数据副本(测试会往里写: ban 标签、购物车、结算历史)
 *                        另: 标签库 tags.db 也落在这里 —— 首轮会导入一次 71k 条,
 *                        之后指纹没变就跳过导入, 所以第二轮起启动快很多。
 *                        **weilin_data\* 翻译库也在这里**(递归拷, 见 STATE_DIRS):
 *                        没有它就没法验证"翻译真的加载出来了"。
 *   .e2e-work/export-dest/ 导出预设的目标目录(预设自动导出的落盘位置, 42MB 级;
 *                        **是证据, 不是脏数据**), 由 e2e 的 7.5 节使用并断言
 *   .e2e-work/scan/      扫描页用的 5 张测试图(从 test-fixtures/ 复制)
 *   .e2e-work/moved-dest/ 右键「移动到」的目标目录(搬文件用, 内容不清理)
 *   .e2e-work/userdata/  独立的 Electron userData(单实例锁 + localStorage 都干净)
 *   .e2e-work/shots/     断言截图
 *
 * **数据副本是从真实数据目录"复制"出来的**, 不是软链、也不共享 ——
 * 测试怎么改都污染不到用户真实积累的黑名单/购物车。
 */
export const WORK = path.join(ROOT, '.e2e-work')

/**
 * 递归拷贝目录(覆盖同名文件, **不删除**目标里多出来的东西)。
 *
 * ⚠️ 别用 `fs.cpSync(from, to, { recursive: true })` —— 在本机 Node 22.22.2 上
 * 拷贝**目录**会让进程直接硬崩: 退出码 3221226505(0xC0000409, fail-fast),
 * 而且崩得太干脆, stdout 缓冲区里已经写好的东西**全部丢失** ——
 * 现象就是"脚本一声不响地退出, 退出码 127, 没有任何输出", 极难查。
 * 实测(2026-09-19): cpSync 整个目录 ✗ / cpSync 单个文件 ✓ / copyFileSync 逐个拷 ✓,
 * 三种对照确认问题出在 cpSync 的目录递归分支上。
 * 所以这里手写一遍: mkdir + copyFileSync, 用的是被验证过没问题的路径。
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name)
    const b = path.join(to, e.name)
    if (e.isDirectory()) copyTree(a, b)
    else fs.copyFileSync(a, b)
  }
}

/** 需要从真实数据目录复制过来的"状态文件"(存在才拷, 逐文件覆盖) */
const STATE_FILES = [
  'tag_viewer_config.json',
  'export_blacklist.txt',
  'export_replace.txt',
  'export_bg.txt',
  'user_meta.json',
  'cart_history.json',
  'local_translations.json',
  // 角色库(由 scripts/build-char-lib.mjs 生成的知识文件)。
  // 必须带上 —— 少了它扫描页的 key_tags/角色高亮、系列页的角色识别都会降级运行
  // (2026-09-19 实测: 缺它时系列数从 386 掉到 244、charLib 直接 ENOENT 报错),
  // 于是那一批断言其实没测到"带角色库"的真实路径。
  'character_library.json',
]

/**
 * 需要从真实数据目录递归复制过来的**目录**(存在才拷, 逐文件覆盖, 不做删除)。
 *
 * weilin_data* —— WeiLin 标签翻译库(SQLite)。**必须带上**:
 *   2026-09-19 实测, 少了它以后 e2e 里 `[diag] 翻译库` 一直是
 *   `{"weilin":0,"total":4072}`, 而"标签: 带中文翻译"那条断言只要求 withZh > 0,
 *   靠 local_translations.json 就能满足 —— 于是整整一轮"翻译整体丢失"的故障
 *   (配置里的 translate_dir 指向已失效的路径)在测试里毫无反应, 300 个标签里
 *   只有 4 个有中文也照样全绿。带上它之后, e2e 才能真的守住"翻译库加载成功"。
 */
const STATE_DIRS = ['weilin_data']

/**
 * 真实数据目录 —— 夹具从这里复制。
 * 优先 TV_REAL_DATA_DIR, 其次本机 local.config.json 的 dataDir, 最后仓库内 data/。
 * (改造前这里也和 workspace.js 各自写死了一份"原 Python 版目录"的等价路径)
 */
export function realDataDir() {
  return process.env.TV_REAL_DATA_DIR || localDataDir()
}

/**
 * 把工作目录准备好。**只做 mkdir + 逐文件覆盖写, 不做任何删除** ——
 * 所以不会碰到执行环境的批量删除保护(见 README 里的说明)。
 *
 * 状态分三类:
 *   继承的(从真实目录拷)  配置/黑名单/替换/背景/元数据/购物车/本地翻译
 *   自带的(从夹具拷)      扫描夹的 5 张测试图
 *   种子的(仅缺失时)      tags.db —— 从真实库 VACUUM INTO 一份(见 1.9 的理由)
 *   重置的(写成空档)      scan_folders.json —— 测试自己产生的, 必须每轮清零,
 *                        否则断言会受上一轮残留影响(见下面的注释)
 *
 * @returns {{ dataDir: string, scanDir: string, userData: string, shotsDir: string, seeded: string[], reset: string[] }}
 */
export function ensureWorkDir({ quiet = false } = {}) {
  const dataDir = path.join(WORK, 'data')
  const scanDir = path.join(WORK, 'scan')
  const userData = path.join(WORK, 'userdata')
  const shotsDir = path.join(WORK, 'shots')
  // 「移动到」的目标目录: e2e 用 TV_E2E_CTX_MOVE 让主进程跳过原生菜单直接搬到这里。
  // 只 mkdir 不清理内容 —— 断言认的是"这一轮那个文件名在不在", 不依赖目录是否为空。
  const movedDest = path.join(WORK, 'moved-dest')
  for (const d of [dataDir, scanDir, movedDest, userData, shotsDir]) fs.mkdirSync(d, { recursive: true })

  // 1) 状态文件: 从真实数据目录取, 保证测的是"用户真实的规则规模"(454 条黑名单那种)
  const src = realDataDir()
  const seeded = []
  for (const f of STATE_FILES) {
    const from = path.join(src, f)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(dataDir, f))
    seeded.push(f)
  }
  if (!seeded.includes('tag_viewer_config.json')) {
    throw new Error(
      `找不到真实数据目录里的 tag_viewer_config.json（找的是 ${src}）。\n` +
      '  这是测试夹具的来源。可用 TV_REAL_DATA_DIR=<目录> 指定别处。',
    )
  }

  // 1.5) 知识目录: 递归拷贝(weilin_data* 翻译库)。只覆盖不删除 ——
  //      与上面"状态文件"同一套规矩, 这样才不会被批量删除保护拦下。
  for (const prefix of STATE_DIRS) {
    let names = []
    try { names = fs.readdirSync(src) } catch { names = [] }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const from = path.join(src, name)
      try { if (!fs.statSync(from).isDirectory()) continue } catch { continue }
      copyTree(from, path.join(dataDir, name))
      seeded.push(`${name}/`)
    }
  }

  // 2) 扫描用的 5 张测试图: 项目自带(test-fixtures/scan-test), 每次覆盖过去
  const fixSrc = path.join(ROOT, 'test-fixtures', 'scan-test')
  if (fs.existsSync(fixSrc)) {
    for (const f of fs.readdirSync(fixSrc)) {
      fs.copyFileSync(path.join(fixSrc, f), path.join(scanDir, f))
    }
  }

  // 3) 之后几步是"测试自己会写的运行期状态": **覆盖成空档, 不删除**(保持"只用写不用删"的性质)。
  const reset = []

  // 3.5) userData/settings.json —— **隔离的关键一环**, 必须显式写。
  //
  // 为什么不能只靠 spawn 时传 TV_DATA_DIR: workspace.js 的解析优先级是
  //   settings.json > TV_DATA_DIR > <userData>/data
  // 只要 userData 下已有一份 settings.json(早期排查脚本留下的,
  // 里面写的是真实数据目录), 它就会**压过** TV_DATA_DIR ——
  // 2026-09-19 实测踩到: e2e 跑了半天其实一直在读写用户的真实 data/,
  // 于是"测试写坏也污染不到真实数据"这句承诺是失效的, 而且
  // scan_folders.json 的"每轮清零"也没生效。
  // 所以这里直接把 settings.json 覆盖成指向沙箱, 让隔离不依赖环境变量。
  const settingsPath = path.join(userData, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({
    dataDir,
    firstRunDone: true,   // 别让后续的首启向导在测试里弹出来
  }, null, 2), 'utf8')
  reset.push('userdata/settings.json')

  // scan_folders.json 是「扫描页收藏夹」—— 上一轮跑完会留下一条记录,
  //    导致下一轮「首次进入是空列表」的断言失败(实测: 第二遍跑就挂在这里)。
  //    它不属于用户数据(STATE_FILES 里故意没有它), 所以每次从空开始是对的。
  const scanFolders = path.join(dataDir, 'scan_folders.json')
  fs.writeFileSync(scanFolders, JSON.stringify({ version: 1, folders: [] }, null, 2), 'utf8')
  reset.push('scan_folders.json')

  // 登记表(folders)现在住在 tags.db 里, 而沙箱库是**跨轮复用**的
  //   (首轮导入 7 万条之后就靠指纹跳过, 所以第二轮起启动快得多)。
  //   测试会在扫描页加/删文件夹 —— 那些行留在库里, 下一轮的
  //   「文件夹库: 首次进入是空列表」会直接失败, 和当年 scan_folders.json
  //   一模一样的坑, 只是换了个地方。
  //   复位方式: 还原成"由配置推导出来的状态" —— 沙箱配置里的
  //   data_files_dir 只有 tags_*.txt(没有 scan_folders.json 的登记),
  //   于是正确的初始态就是"每个有记录的 src 一行 as_source=1 / as_scan 全 0"。
  //   顺序很重要: **先按 src 把 as_source 打回来, 再删剩下的**
  //   —— 来源页/扫描页的子测试会因为中途失败而留下"已移出(as_source=0)"的行,
  //   若先删就把这条登记整行删掉了, 下一轮沙箱会少一整个来源。
  //   库不存在(第一次跑, 还没建) 时跳过。
  const sandboxDb = path.join(dataDir, 'tags.db')

  /**
   * 1.9) 沙箱标签库的**冷启动种子** —— 只在沙箱库不存在时, 从真实库拷一份。
   *
   * 为什么不能继续让它从 `tags_*.txt` 重建(2026-09-20 改的, 两个理由都是实测出来的):
   *
   *   · **归档之后就重建不出来了**。真实 txt 已移进 `_legacy_归档_*`, 沙箱库一旦被删
   *     (手工清理 .e2e-work 就会), 整轮 e2e 直接挂在"数据集加载失败"上 —— 而原因
   *     藏在准备阶段, 现象却在断言里, 很难指。
   *
   *   · **从 txt 重建会丢掉全部 `gone` 标记**。txt 是历史快照, 里面还留着早已从磁盘
   *     删掉的图; 于是卡片照样去渲染它们 → 缩略图 404 → 把「运行期无 JS 异常」
   *     这条总闸**随机**顶红(实测每轮换一张图, 不是固定那张, 所以一直被当成"闪烁"
   *     而没被追下去)。真实库经过增量入库, `gone` 是准的(实测 44 行, 沙箱那份是 0 行)。
   *
   * 用 `VACUUM INTO` 而不是直接拷文件: 真实库跑在 WAL 模式, 单拷主文件可能与 `-wal`
   * 不一致; VACUUM INTO 出来的是一致快照。失败就退回逐文件拷贝(含 -wal/-shm)。
   */
  if (!fs.existsSync(sandboxDb)) {
    const realDb = path.join(src, 'tags.db')
    if (fs.existsSync(realDb)) {
      try {
        const d = new DatabaseSync(realDb)
        d.exec('PRAGMA busy_timeout = 5000')
        d.exec(`VACUUM INTO '${sandboxDb.replace(/'/g, "''")}'`)
        d.close()
        seeded.push('tags.db(冷启动种子 <- 真实库, VACUUM INTO)')
      } catch (e) {
        console.warn(`[harness] VACUUM INTO 失败(${e.message}), 退回逐文件拷贝`)
        for (const suf of ['', '-wal', '-shm']) {
          if (fs.existsSync(realDb + suf)) fs.copyFileSync(realDb + suf, sandboxDb + suf)
        }
        seeded.push('tags.db(冷启动种子 <- 真实库, 文件拷贝)')
      }
    } else {
      console.warn(`[harness] 真实库不存在(${realDb}) —— 本轮沙箱标签库要靠自己从 txt 重建`)
    }
  }

  if (fs.existsSync(sandboxDb)) {
    try {
      const db = new DatabaseSync(sandboxDb)
      db.exec('PRAGMA busy_timeout = 5000')
      const off = db.prepare('UPDATE folders SET as_scan = 0 WHERE as_scan <> 0').run()
      const back = db.prepare(`UPDATE folders SET as_source = 1
                                WHERE as_source = 0
                                  AND label IN (SELECT name FROM src WHERE records > 0)`).run()
      const del = db.prepare('DELETE FROM folders WHERE as_source = 0').run()
      db.close()
      reset.push(`tags.db:folders(复位扫描 ${off.changes} 行, 找回来源 ${back.changes} 行, 删除测试夹 ${del.changes} 行)`)
    } catch (e) {
      // 复位失败不该让整轮测试挂掉 —— 但要吭声, 否则下一轮的空列表断言失败
      // 会变成"莫名其妙"(实测过这类: 现象在断言, 原因在准备阶段)。
      console.warn(`[harness] 复位沙箱登记表失败: ${e.message}`)
    }
  }

  if (!quiet) {
    console.log(`[harness] 工作目录 ${WORK}`)
    console.log(`[harness]   数据副本 <- ${src}  (${seeded.length} 个状态文件)`)
    console.log(`[harness]   扫描夹   <- test-fixtures/scan-test`)
    console.log(`[harness]   已重置   ${reset.join(', ')}`)
  }
  return { dataDir, scanDir, movedDest, userData, shotsDir, seeded, reset }
}

/** 找一个当前空闲的 TCP 端口(监听 0 让系统分配, 拿到号就关掉) */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

/**
 * 清空页面状态并重载, 返回清掉的 key 数。
 *
 * @param {object} cdp    需要有一个 eval(src) 方法(内部包 async IIFE)
 * @param {string} readySel  重载完成后用来判定"页面回来了"的选择器
 */
export async function clearPageState(cdp, readySel = '#app .hdr') {
  let n = -1
  try {
    n = await cdp.eval(`const n = localStorage.length; localStorage.clear(); sessionStorage.clear(); return n`)
  } catch { /* 页面还没就绪也无所谓, 重载后本来就是干净的 */ }

  try {
    await cdp.eval(`setTimeout(() => location.reload(), 20); return true`)
  } catch { /* 上下文即将销毁 */ }

  await sleep(900)
  // 重载会重建执行上下文, 头几次 eval 可能报 "Execution context was destroyed", 重试即可
  for (let i = 0; i < 40; i++) {
    try {
      if (await cdp.eval(`return !!document.querySelector(${JSON.stringify(readySel)})`)) return n
    } catch { /* 上下文重建中 */ }
    await sleep(300)
  }
  throw new Error(`重载后等不到页面就绪(${readySel})`)
}
