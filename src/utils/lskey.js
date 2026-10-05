/**
 * localStorage 键名 —— 全站统一 `tv_*` 前缀
 * ==========================================
 * 改造前是混着的: `tv_theme` / `tv_favs` / `tv_cart` / `tv_lb_last` 已经是新前缀,
 * 而 `tagviewer_bg_auto` / `tagviewer_trash_ask` / `tagviewer_hist` 还在沿用旧版
 * 网页版的命名。三处各自 `localStorage.getItem(写死的字符串)`, 于是没有一处能回答
 * "这个应用到底往 localStorage 里存了什么" —— 清理、调试、迁移都得靠全局搜字符串。
 *
 * 兼容策略(与项目里其它地方的"兼容期回退"同一套):
 *   读 -> 先找新键; 没有就找旧键, **读到就搬到新键并删掉旧键**(一次性迁移);
 *   写 -> 只写新键。
 * 所以老用户的选择不会丢, 而下一轮再进来时旧键已经不存在了。
 */

/** 读一个键, 带上旧键名的兼容迁移 */
export function readLS(key, oldKey = '') {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return v
    if (!oldKey) return null
    const legacy = localStorage.getItem(oldKey)
    if (legacy === null) return null
    localStorage.setItem(key, legacy)
    localStorage.removeItem(oldKey)     // 搬完就删, 免得两边各写各的
    return legacy
  } catch { return null }               // 隐私模式 / 配额满: 当作没有
}

export function writeLS(key, value) {
  try { localStorage.setItem(key, String(value)) } catch { /* 忽略 */ }
}

export function removeLS(key) {
  try { localStorage.removeItem(key) } catch { /* 忽略 */ }
}

/**
 * 全站 localStorage 键名登记表 —— 新增/改名时改这里, 不要在调用点写字符串。
 * 键名以 `tv_` 开头; `old` 是改造前的旧名(没有就不写)。
 */
export const LS = Object.freeze({
  theme: { key: 'tv_theme' },
  favs: { key: 'tv_favs' },
  cart: { key: 'tv_cart' },
  lightboxLast: { key: 'tv_lb_last' },
  bgAuto: { key: 'tv_bg_auto', old: 'tagviewer_bg_auto' },
  trashAsk: { key: 'tv_trash_ask', old: 'tagviewer_trash_ask' },
  searchHistory: { key: 'tv_search_hist', old: 'tagviewer_hist' },
  /**
   * 扫描页筛选框的历史 —— **故意和上面那条分开存**。
   * 首页搜的是一条条完整查询(可能带 mode/exclude 那套语法), 扫描页筛的是
   * "这个夹里出现过的标签", 两者的词表根本不是一回事: 混在一起的话,
   * 在首页搜过的词会跑到扫描页的下拉里, 而在扫描页筛过的标签名又会污染首页历史。
   */
  searchHistoryScan: { key: 'tv_search_hist_scan' },
  /** 购物车/角色表导出用哪套替换规则(2026-10-04 规则组); 空 = 默认组 */
  cartReplaceSet: { key: 'tv_cart_replace_set' },
  /**
   * 排序记忆(2026-09-23 用户要求: "每次进去都要点一下排序")。
   * **四个页面各存各的** —— 首页常年在"随机"、扫描页常年按修改时间, 混用一个键
   * 就会互相盖掉, 等于没记住。
   */
  sortHome: { key: 'tv_sort_home' },
  sortScan: { key: 'tv_sort_scan' },
  sortSeries: { key: 'tv_sort_series' },
  sortTagImgs: { key: 'tv_sort_tagimgs' },
})
