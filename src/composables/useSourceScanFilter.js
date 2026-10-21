/**
 * 「来源 | 扫描夹」分段筛选 —— 标签页 / 标签图片页共用的**同一份**状态
 * ================================================================
 * 2026-10-21 标签页筛选重构: 旧版两条筛选行同时铺开靠灰掉另一条表达互斥,
 * 用户反馈"看不懂怎么个互斥法, UI 也丑", 点名要「(来源|扫描) 胶囊开关,
 * 点击切换下面的文件夹就跟着换」—— 这就是社区最成熟的 Segmented Control
 * 模式, 本模块把互斥语义做进状态里: **mode 是唯一的active维度**,
 * chips 行只渲染当前档的内容, 另一档的选择原样记忆不丢。
 *
 * 状态放在模块层(不是组件层): 标签列表页点进某标签的图片页, 筛选跟着过去 ——
 * "我刚在筛 新世界, 跳进 breasts 也该只看 新世界的" 才是顺的直觉。
 * 选择记忆(localStorage)沿用标签页原有的两个键, 档位单独一个新键。
 *
 * 两个消费方的数据管线不同, 本模块只管「选了什么」:
 *   · 标签列表页: source 档 -> allTags({source}); scan 档 -> scanTagList({paths})
 *   · 标签图片页: source 档 -> search({source});  scan 档 -> search({under}) 路径前缀
 */
import { ref, computed } from 'vue'
import { api } from '@/utils/api.js'
import { readLS, writeLS, LS } from '@/utils/lskey.js'

/* ---- 模块级状态: 整个应用就一份 ---- */
const splitLS = (k) => (readLS(k) || '').split(',').map((s) => s.trim()).filter(Boolean)

/** 当前档位: 'source' = 标签库来源 | 'scan' = 扫描文件夹 */
const mode = ref(readLS(LS.tagsFilterMode.key) === 'scan' ? 'scan' : 'source')
/** source 档选中的来源名 */
const srcSel = ref(splitLS(LS.tagsSources.key))
/** scan 档选中的文件夹路径(显示名可能重名, 按路径筛) */
const scanSel = ref(splitLS(LS.tagsScanFolders.key))

/** 扫描夹 chips 数据: 来自 folders 登记表(as_scan), count 用夹的图片数 */
const scanChips = ref([])          // [{name, images, value: path}]
const scanLoaded = ref(false)

function persist() {
  writeLS(LS.tagsFilterMode.key, mode.value)
  writeLS(LS.tagsSources.key, srcSel.value.join(','))
  writeLS(LS.tagsScanFolders.key, scanSel.value.join(','))
}

/** 拉一次扫描夹登记表(两个页面共用, 拉过就不再拉; 失败不挡页面)。
 * 计数不用登记表的 images —— 那是另一条链路写的, 纯扫描夹常常跟不上
 * (实测日期夹全显示 0, 缓存里明明有图, 用户拿这个报过"扫描很多都是 0")。
 * 这里对每个夹直接数缓存(scan:folderStats), 与筛选口径同源。 */
async function ensureScanChips() {
  if (scanLoaded.value) return
  scanLoaded.value = true
  try {
    const d = await api.folders()
    const scans = (d.folders || [])
      .filter((f) => f.as_scan)
      .map((f) => ({ name: f.name || f.label || f.path, images: f.images || 0, value: f.path }))
      .sort((a, b) => b.images - a.images)
    scanChips.value = scans
    // 缓存概况晚一步到也没关系: chips 先出, 数字随后修正
    api.scanFolderStats(scans.map((f) => f.value)).then((sts) => {
      const m = new Map((sts || []).map((s) => [s.path, s]))
      for (const c of scans) {
        const st = m.get(c.value)
        if (st) {
          c.images = st.images
          c.hit = st.hit
        }
      }
      scans.sort((a, b) => b.images - a.images)
      scanChips.value = [...scans]      // 换新引用触发响应式更新
    }).catch(() => { /* 老主进程没这条通道就沿用登记表数字 */ })
  } catch { /* 扫描服务没起也不挡页面 */ }
}

function setMode(v) {
  if (v === mode.value) return
  mode.value = v
  persist()
}
function setSrcSel(arr) { srcSel.value = arr; persist() }
function setScanSel(arr) { scanSel.value = arr; persist() }

const scanTotalImages = computed(() => scanChips.value.reduce((s, f) => s + (f.images || 0), 0))
const isScan = computed(() => mode.value === 'scan')

export function useSourceScanFilter() {
  return {
    // 状态(模块级单例, 两个页面读写同一份)
    mode, srcSel, scanSel, scanChips, scanTotalImages, isScan,
    setMode, setSrcSel, setScanSel, ensureScanChips,
  }
}
