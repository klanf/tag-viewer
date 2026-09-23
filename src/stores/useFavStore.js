/**
 * 收藏 —— 结构化记录(2026-09-19 升级, 与旧版 key 保持一致 -> 老数据自动迁移)
 * =========================================================================
 * 记录从纯路径字符串升级成对象: { path, name, tags, at }
 *   - name  文件名快照 —— 用户会在**应用外**(资源管理器)把图挪来挪去,
 *           路径随时可能失效, 文件名是找回的锚点
 *   - tags  收藏那一刻的标签快照 —— 扫描图不在标签库里, 收藏页要显示标签
 *           只能靠快照; 文件找得回时可重读刷新
 *   - at    收藏时间戳(收藏页按它倒序); 旧数据迁移进来是 0, 排在最后
 *
 * 路径容错(刻意保留的旧规则): isFav 精确匹配失败时用「文件名」兜底 ——
 * 用户的数据源目录改过名, 否则换个目录所有收藏就"集体失效"。原版踩过这个坑。
 *
 * 删除/移动都**不清**收藏记录(2026-09-19 用户拍板):
 *   - 移动(应用内): 立即改写为新路径(onMoved)
 *   - 移动(应用外): 路径失效, 收藏页打开时调 fav:resolve 按文件名在
 *     已知目录里找回, 找回即改写
 *   - 删除(进回收站): 记录保留, 卡片显示"文件已不在"
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { call } from '@/utils/api.js'
import { LS, readLS, writeLS } from '@/utils/lskey.js'

const baseName = (p) => String(p || '').split(/[\\/]/).pop() || ''

/** 旧格式(字符串数组) -> 新格式(对象数组); 容忍脏数据 */
function migrate(a) {
  if (!Array.isArray(a)) return []
  return a
    .map((r) => {
      if (typeof r === 'string') return { path: r, name: baseName(r), tags: [], at: 0 }
      if (r && typeof r === 'object' && r.path) {
        return {
          path: r.path,
          name: r.name || baseName(r.path),
          tags: Array.isArray(r.tags) ? r.tags : [],
          at: Number(r.at) || 0,
          /* 像素尺寸(2026-09-23 补)。**必须在这里带上** —— migrate 是
             「读 localStorage -> 新对象」的唯一入口, 少抄一个字段就等于每次
             重启都把尺寸丢掉, 于是每次打开收藏页都要重新补一次。 */
          px_w: Number(r.px_w) || 0,
          px_h: Number(r.px_h) || 0,
        }
      }
      return null
    })
    .filter(Boolean)
}

function load() {
  try {
    return migrate(JSON.parse(readLS(LS.favs.key) || '[]'))
  } catch { return [] }
}

export const useFavStore = defineStore('fav', () => {
  const list = ref(load())
  const onlyFav = ref(false)
  /** fav:resolve 正在跑(收藏页用它显示"正在找回…") */
  const resolving = ref(false)

  const count = computed(() => list.value.length)
  /** 纯路径数组(给后端「只看收藏」过滤用的还是老形状) */
  const paths = computed(() => list.value.map((r) => r.path))
  const basenames = computed(() => new Set(list.value.map((r) => r.name)))

  function persist() {
    writeLS(LS.favs.key, JSON.stringify(list.value))
  }

  /** 精确优先; 找不到就用文件名兜底(兼容数据源路径变化)。返回记录下标 */
  function indexOf(path) {
    let i = list.value.findIndex((r) => r.path === path)
    if (i >= 0) return i
    const b = baseName(path)
    return b ? list.value.findIndex((r) => r.name === b) : -1
  }
  function isFav(path) {
    if (!path) return false
    if (list.value.some((r) => r.path === path)) return true
    const b = baseName(path)
    return b ? basenames.value.has(b) : false
  }
  /**
   * 切换收藏。tags 是可选的标签快照(光箱/卡片手里有就传进来)。
   * src 是可选的来源记录 —— **手里有 item 就整条传进来**, 尺寸会顺手存下
   * (2026-09-23 加: 收藏记录没有尺寸, 收藏页网格就会回落 9/16, 横图被裁成竖条
   *  —— 与扫描页同一个 bug)。不传也行, 收藏页会调 dims:forPaths 补齐, 只是多一次 IPC。
   * 已收藏(含文件名兜底命中) -> 取消; 否则新增。
   */
  function toggle(path, tags, src) {
    const i = indexOf(path)
    if (i >= 0) {
      list.value.splice(i, 1)
      persist()
      return false
    }
    list.value.push({
      path,
      name: baseName(path),
      tags: Array.isArray(tags) ? tags.slice() : [],
      at: Date.now(),
      px_w: Number(src?.px_w) || 0,
      px_h: Number(src?.px_h) || 0,
    })
    persist()
    return true
  }

  /** 应用内移动: 立即把收藏改写到新位置(原来这里是把记录**摘掉**, 会丢收藏) */
  function onMoved(from, to) {
    if (!from || !to) return false
    const r = list.value.find((x) => x.path === from)
    if (!r) return false
    r.path = to
    r.name = baseName(to)
    persist()
    return true
  }

  /**
   * 按文件名找回失效的收藏(应用外移动的兜底)。
   * 主进程对每条记录先 existsSync, 失效的去已知目录(扫描文件夹/预设文件夹/
   * 数据目录/原父目录)递归搜同名文件, 命中就改写路径并重读标签快照。
   * 找不回的保持原样 —— 卡片上由「缩略图加载失败」标灰"文件已不在"。
   */
  async function resolveMissing() {
    if (!list.value.length || resolving.value) return []
    resolving.value = true
    try {
      const r = await call('fav:resolve', {
        items: list.value.map((x) => ({ path: x.path, name: x.name })),
      })
      const updates = Array.isArray(r?.updates) ? r.updates : []
      let n = 0
      for (const u of updates) {
        const rec = list.value.find((x) => x.path === u.from)
        if (!rec) continue
        if (u.found && u.found !== rec.path) {
          rec.path = u.found
          rec.name = baseName(u.found)
          if (Array.isArray(u.tags) && u.tags.length) rec.tags = u.tags
          n++
        }
      }
      if (n) persist()
      return updates
    } catch (err) {
      console.error('[fav] 找回失效收藏失败:', err)
      return []
    } finally {
      resolving.value = false
    }
  }

  /** 兼容旧调用(批量重置)。接受字符串数组或记录数组 */
  function setAll(arr) {
    list.value = migrate(Array.isArray(arr) ? arr : [])
    persist()
  }
  function clear() { list.value = []; persist() }

  /**
   * 补收藏记录的**像素尺寸** —— 与扫描页同一个 bug, 同一个修法(见 core/dims.js)。
   *
   * 收藏记录是"收藏那一刻"的快照 `{path,name,tags,at}`, 里面**没有尺寸**, 于是
   * 收藏页的网格回落 9/16, 横图被 `object-fit: cover` 裁成竖条(与扫描页一模一样,
   * 而且都是**静默**的)。这里按路径批量补一次, 结果**写回记录并持久化** ——
   * 以后打开收藏页不再请求第二次。
   *
   * 为什么在 FavView 的 onMounted 里 await 它: 那一处本来就是"找回失效收藏跑完才
   * ready、才渲染卡片"(见 ready)。排在一起就不会出现"先按 9/16 渲染一帧、尺寸到了
   * 再整体重排"的跳动。
   *
   * 失败不影响任何功能: 卡片回落 9/16(改动前的样子), 只是横图会被裁。
   * @returns {Promise<number>} 补成功几条
   */
  async function ensureDims() {
    const need = list.value.filter((r) => !(r.px_w > 0 && r.px_h > 0))
    if (!need.length) return 0
    try {
      const r = await call('dims:forPaths', { paths: need.map((x) => x.path) })
      const dims = Array.isArray(r?.dims) ? r.dims : []
      let filled = 0
      need.forEach((rec, i) => {
        const d = dims[i]
        if (d && d.w > 0 && d.h > 0) {
          rec.px_w = d.w
          rec.px_h = d.h
          filled++
        }
      })
      if (filled) persist()
      return filled
    } catch (e) {
      console.error('[fav] 补图片尺寸失败(卡片回落 9/16, 其它功能不受影响):', e)
      return 0
    }
  }

  return {
    list, onlyFav, count, paths, isFav, toggle, onMoved, resolveMissing, resolving,
    clear, setAll, indexOf, ensureDims,
  }
})
