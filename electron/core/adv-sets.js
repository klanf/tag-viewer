/**
 * 高级替换方案库(2026-11-09) —— 照替换规则组(replace_sets.json)的模子
 * ==========================================================================
 * 一份高级替换配置不够用了: 用户不同导出目的要不同方案(ComfyUI 出图挂 NSFW 池 /
 * Danbooru 清洗版 / 某个角色表专用…), 于是方案化, 预设里选哪一套。
 *
 * 存法: user/adv_sets.json = { active, sets: [{id, name, cfg}] }
 *   cfg = { enabled, picked, inserts, rates, weights, pins, pinFill, banned, nsfw, seed, nl }
 *   pins 每项 = {slot, word, weight}(权重 2026-11-10 起, 缺省 1 = 不加壳)
 *   nl  = { dims, level, poseView, stripPose, stripCostume, stripHair, seed }
 *
 * 迁移: 首次读时 json 不存在, 建一个全空「默认」组落盘 —— 与旧行为完全一致
 * (旧版高级替换配置本来就只存在渲染层内存里, 重启即失, 没有存量可迁移)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'

const ADV_SETS_NAME = 'adv_sets.json'
const DEFAULT_SET_ID = 'adv-default'

const emptyCfg = () => ({
  enabled: false,
  picked: [],
  inserts: [],
  rates: {},
  weights: {},           // 槽 id -> 权重(2026-11-10): 换/补出来的词套 (tag:w), 缺省 1 = 不加壳
  pins: [],
  pinFill: true,
  banned: [],
  nsfw: true,
  seed: '',
  nl: {
    enabled: false,
    dims: [],
    level: 'sfw',
    lang: 'en',
    poseView: true,
    stripPose: true,
    stripCostume: true,
    stripHair: true,
    seed: '',
    banned: '',
  },
  // 图库组合池(2026-11-11): 第三套来源(char-db 的 tag 组合串), 与 nl 同维度互斥
  cd: {
    enabled: false,
    dims: [],          // pose | outfit
    dual: false,       // 是否抽含人数 tag 的双人条目
    seed: '',
  },
})

/** 任意输入 -> 合法 cfg(字段逐个收敛, 类型不对就落默认值) */
function normCfg(raw) {
  const d = emptyCfg()
  if (!raw || typeof raw !== 'object') return d
  const out = { ...d }
  out.enabled = raw.enabled === true
  out.picked = Array.isArray(raw.picked) ? raw.picked.map((s) => String(s).trim()).filter(Boolean) : []
  const insRaw = Array.isArray(raw.inserts) ? raw.inserts.map((s) => String(s).trim()).filter(Boolean) : []
  if (raw.rates && typeof raw.rates === 'object' && !Array.isArray(raw.rates)) {
    const rates = {}
    for (const [k, v] of Object.entries(raw.rates)) {
      const n = Number(v)
      if (k && Number.isFinite(n) && n >= 0 && n <= 1) rates[k] = n
    }
    out.rates = rates
  }
  out.pins = Array.isArray(raw.pins)
    ? raw.pins
        .map((p) => {
          const w = Number(p?.weight)
          return {
            slot: String(p?.slot || '').trim(),
            word: String(p?.word || '').trim(),
            // 权重(2026-11-10): 0.05~2 之外一律按 1(不加壳), 免得手改 json 出一个 50 倍词
            weight: Number.isFinite(w) && w > 0 ? Math.min(2, Math.max(0.05, w)) : 1,
          }
        })
        .filter((p) => p.slot && p.word)
    : []
  // 槽位权重(2026-11-10): 0.05~2, 非数字丢掉; 1 = 不加壳(不落冗余键)
  if (raw.weights && typeof raw.weights === 'object' && !Array.isArray(raw.weights)) {
    const ws = {}
    for (const [k, v] of Object.entries(raw.weights)) {
      const n = Number(v)
      if (k && Number.isFinite(n) && n > 0 && Math.abs(n - 1) > 1e-3) ws[k] = Math.min(2, Math.max(0.05, n))
    }
    out.weights = ws
  }
  out.pinFill = raw.pinFill !== false
  out.banned = Array.isArray(raw.banned) ? raw.banned.map((s) => String(s).trim()).filter(Boolean) : []
  // 插入槽(2026-11-09): 原图缺词也从槽池补一个, 与 picked/banned 三态互斥。
  // 收敛时顺手做互斥兜底: 禁用 > 插入 > 随机, 同槽只留一个(手改 json / 旧数据也能被纠正)。
  const banSet = new Set(out.banned)
  out.inserts = [...new Set(insRaw)].filter((s) => !banSet.has(s))
  out.picked = out.picked.filter((s) => !banSet.has(s) && !out.inserts.includes(s))
  out.nsfw = raw.nsfw !== false
  out.seed = typeof raw.seed === 'string' ? raw.seed : ''
  if (raw.nl && typeof raw.nl === 'object') {
    const n = { ...d.nl }
    n.enabled = raw.nl.enabled === true
    n.dims = Array.isArray(raw.nl.dims)
      ? raw.nl.dims.map((s) => String(s).trim()).filter((s) => ['pose', 'costume', 'hair'].includes(s))
      : []
    n.level = ['sfw', 'soft', 'nsfw'].includes(raw.nl.level) ? raw.nl.level : 'sfw'
    n.lang = raw.nl.lang === 'zh' ? 'zh' : 'en'
    n.poseView = raw.nl.poseView !== false
    n.stripPose = raw.nl.stripPose !== false
    n.stripCostume = raw.nl.stripCostume !== false
    n.stripHair = raw.nl.stripHair !== false
    n.seed = typeof raw.nl.seed === 'string' ? raw.nl.seed : ''
    // 语料黑名单: 原样存字符串(逗号分隔), 解析在 nl-bank.splitNlBan 一处做
    n.banned = typeof raw.nl.banned === 'string'
      ? raw.nl.banned
      : (Array.isArray(raw.nl.banned) ? raw.nl.banned.join(',') : '')
    out.nl = n
  }
  if (raw.cd && typeof raw.cd === 'object') {
    const c = { ...d.cd }
    c.enabled = raw.cd.enabled === true
    c.dims = Array.isArray(raw.cd.dims)
      ? raw.cd.dims.map((s) => String(s).trim()).filter((s) => ['pose', 'outfit'].includes(s))
      : []
    c.dual = raw.cd.dual === true
    c.seed = typeof raw.cd.seed === 'string' ? raw.cd.seed : ''
    // 同一维度内三套互斥: NL 占了该维度就让给 NL(UI 也这么拦, 这里是手改 json 的兜底)
    if (c.enabled && out.nl.enabled && out.nl.dims.length) {
      c.dims = c.dims.filter((x) => !out.nl.dims.includes(x))
      if (!c.dims.length) c.enabled = false
    }
    out.cd = c
  }
  return out
}

function writeSets(obj) {
  const p = dataFile(ADV_SETS_NAME)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  try { fs.renameSync(tmp, p) } catch { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8') }
}

/** 全部方案 + 当前方案 id; 缺文件时建全空「默认」组落盘 */
export function advSets() {
  const p = dataFile(ADV_SETS_NAME)
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { raw = null }
  const sets = []
  const seen = new Set()
  for (const s of (Array.isArray(raw?.sets) ? raw.sets : [])) {
    const id = String(s?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    sets.push({ id, name: String(s?.name || id).trim() || id, cfg: normCfg(s?.cfg) })
  }
  if (!sets.length) {
    sets.push({ id: DEFAULT_SET_ID, name: '默认', cfg: emptyCfg() })
    writeSets({ active: DEFAULT_SET_ID, sets })
  }
  let active = String(raw?.active || '').trim()
  if (!sets.some((s) => s.id === active)) active = sets[0].id
  return { active, sets }
}

/** 按 id 取方案(找不到返回 null, 调用方自行落回默认行为) */
export function advSetById(id) {
  const t = String(id || '').trim()
  if (!t) return null
  const { sets } = advSets()
  return sets.find((s) => s.id === t) || null
}

/**
 * 整存方案库。body: { active, sets: [{id?, name, cfg?}] }
 * id 留空 = 新建方案, 用名字生成稳定可读的 id(重名加后缀)。
 * **cfg 留空(undefined) = 沿用库里同 id 方案的现值** —— 前端自动落盘只送当前
 * 编辑方案的 cfg, 其余方案不该被碰; 真正的新建项库里没有同 id, 落回全空 cfg。
 * 返回落盘后的结构(前端拿它刷新), 与 replaceSets 的 saveReplaceSets 同款交互。
 */
export function saveAdvSets(body = {}) {
  const cur = advSets()
  const incoming = Array.isArray(body.sets) ? body.sets : cur.sets
  const sets = []
  const seenId = new Set()
  const seenName = new Set()
  for (const s of incoming) {
    const name = String(s?.name || '').trim() || String(s?.id || '').trim()
    if (!name || seenName.has(name)) continue
    let id = String(s?.id || '').trim()
    // 新建(id 空): 名字当 id 的可读底子, 撞了加序号 —— 重命名不换 id, 引用不失效
    if (!id || seenId.has(id)) id = `adv-${name}`
    let base = id
    for (let i = 2; seenId.has(id); i++) id = `${base}-${i}`
    seenId.add(id)
    seenName.add(name)
    const keep = s?.cfg === undefined ? cur.sets.find((x) => x.id === id)?.cfg : undefined
    sets.push({ id, name, cfg: keep !== undefined ? keep : normCfg(s?.cfg) })
  }
  if (!sets.length) sets.push({ id: DEFAULT_SET_ID, name: '默认', cfg: emptyCfg() })
  let active = String(body?.active || '').trim()
  if (!sets.some((s) => s.id === active)) active = sets[0].id
  const out = { active, sets }
  writeSets(out)
  return out
}
