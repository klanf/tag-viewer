/**
 * 导出筛选结果 -> 纯文本
 * =======================
 * 与原 Python 版 _api/export 完全同序:
 *   筛选 -> 黑名单剔除 -> 替换规则 -> 补背景标签 -> 下划线转空格 -> 拼接
 *
 * 差异: 原版把结果当 HTTP 附件下载, 落盘位置由浏览器决定;
 * 这里改成 Electron 的原生「另存为」对话框, 用户能自己挑目录和文件名
 * (顺带解决了浏览器下载目录里堆一堆"筛选结果(1).txt"的问题)。
 */
import { recordsFor, frozenKey, isCharacterTag, isCopyrightTag } from './dataset.js'
import { parseQuery, scopeRecords, searchCached } from './search.js'
import { blacklistMatcher, isBlockedFast, loadReplaceRules, loadReplaceRulesGroup, replaceTag, loadBgConfig, hasBgTagFast, viewTagMatcher, isViewFast } from './rules.js'
import { safetyExportStripper } from './safety.js'
import { exportSegSort, sortTags, unwrapWeight } from './tagcats.js'
import { applyFilterGroups } from './tagfilter.mjs'
import { makeRandomizer, filterBannedSlots } from './export-random.js'
import { advSets } from './adv-sets.js'
import { makeNlPicker, nlDupReport, NL_DIMS, NL_LEVELS } from './nl-bank.js'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_KNOWLEDGE_DIR } from './paths.js'
import { openDb } from './store.js'

/**
 * 比较两个标签"是不是同一个"用的归一化键: 忽略大小写, 且把下划线/空格视作等价。
 * 库里存的是 best_quality, 用户在追加框里手打成 best quality, 其实是同一个标签。
 */
const tagKey = (t) => t.toLowerCase().replace(/[\s_]+/g, '_')

/**
 * 方案 cfg -> 与首页 advParams() 同形的参数对象(2026-11-09)。
 * exporter 的 rnd/nl 参数解析只认参数串形态, 方案选出来先摊平成同样的串,
 * 后续管线一行都不用动。rates 库里存 0~1, 串里也是 0~1(1 省略 = 必换, 老格式)。
 */
function advSetParams(cfg = {}) {
  const slots = (Array.isArray(cfg.picked) ? cfg.picked : []).map((id) => {
    const r = Number(cfg.rates?.[id])
    return (Number.isFinite(r) && r >= 0 && r < 1) ? `${id}:${r.toFixed(2)}` : id
  }).join(',')
  // 插入槽(2026-11-09): 有词→换 复用 randomize_slots(率表同一份), 这里只发补词清单
  const inserts = (Array.isArray(cfg.inserts) ? cfg.inserts : []).map((id) => {
    const r = Number(cfg.rates?.[id])
    return (Number.isFinite(r) && r >= 0 && r < 1) ? `${id}:${r.toFixed(2)}` : id
  }).join(',')
  const slotsAll = [slots, inserts].filter(Boolean).join(',')
  const pins = (Array.isArray(cfg.pins) ? cfg.pins : [])
    .map((pt) => `${pt.slot}:${String(pt.word).toLowerCase().replace(/\s+/g, '_')}`)
    .join(',')
  const ban = (Array.isArray(cfg.banned) ? cfg.banned : []).join(',')
  const nl = cfg.nl || {}
  const hasCfg = (cfg.picked?.length || cfg.inserts?.length || pins || ban)
  return {
    randomize: (cfg.enabled === true && hasCfg) ? '1' : '0',
    randomize_slots: slotsAll,
    insert_slots: inserts,
    pin_slots: pins,
    pin_fill: cfg.pinFill !== false ? '1' : '0',
    ban_slots: ban,
    randomize_nsfw: cfg.nsfw !== false ? '1' : '0',
    randomize_seed: String(cfg.seed || ''),
    nl_dims: (nl.enabled === true && Array.isArray(nl.dims) && nl.dims.length) ? nl.dims.join(',') : '',
    nl_level: ['sfw', 'soft', 'nsfw'].includes(nl.level) ? nl.level : 'sfw',
    nl_strip_pose: nl.stripPose !== false ? '1' : '0',
    nl_pose_view: nl.poseView !== false ? '1' : '0',
    nl_strip_costume: nl.stripCostume !== false ? '1' : '0',
    nl_strip_hair: nl.stripHair !== false ? '1' : '0',
    nl_seed: String(nl.seed || ''),
  }
}

function exportCore(raw = {}) {
  const t0 = Date.now()
  const p = parseQuery(raw)
  const withPath = raw.with_path === '1' || raw.with_path === true
  const spaces = !(raw.spaces === '0' || raw.spaces === false)
  const useBl = !(raw.blacklist === '0' || raw.blacklist === false)
  const useRp = !(raw.replace === '0' || raw.replace === false)
  const useBg = !(raw.bg === '0' || raw.bg === false)
  // 剔除角色/系列标签(含无括号角色, 由角色库识别); 默认关闭, 与旧行为一致
  const stripChar = raw.strip_char === '1' || raw.strip_char === true
  // 剔除视角/机位标签(词表: data/export_view_tags.txt, 种子来自随机机位交接文档); 默认关闭
  const stripView = raw.strip_view === '1' || raw.strip_view === true
  // 只导出安全模式的标签 —— 逐行剔除敏感tag(口径跟随 safety.json 的档位); 默认关闭
  const safeOnly = raw.safe_only === '1' || raw.safe_only === true
  // 过滤组(2026-10-27 词条管线第二层): 槽内单选+互斥消解, 仅单人图生效; 默认关闭
  const useGroups = raw.groups === '1' || raw.groups === true
  // 段位模式(2026-10-16): 过滤 画师/角色/系列/meta, 人数排最前, 通用按大类归堆。
  // 做在**替换/补背景/追加之后**(替换后的新词按新文本分类, 天然一致), 空格转换之前。
  const segMode = raw.seg_mode === '1' || raw.seg_mode === true
  // 随机替换(2026-10-28 导出端随机化): 勾选大类/槽内的词 1:1 换池子里的新词。
  //   randomize          '1' 开
  //   randomize_sections 大类串, 每段 "id" 或 "id:换词率" —— "hair:0.65,face"
  //                      (2026-10-29 起支持换词率, 0~1; 老格式 "hair,face" = 全 1 必换;
  //                      非法数字/越界一律按 1, 与引擎 rateOf 同口径)
  //   randomize_slots    槽串, 格式同上 —— "legwear:0.65,pose"(2026-10-30 槽级粒度,
  //                      "只抽袜子"这类需求必须到槽; 老大类串继续认, 两边可混用)
  //   pin_slots          钉词串, 每段 "槽:词" —— "legwear:white_thighhighs";
  //                      钉了的槽必现指定词, 优先于随机(见 export-random.js 阶段①)
  //   pin_fill           '1'/'0' 原图缺钉词槽词条时是否补上; 缺省 = '1'(补)
  //   ban_slots          禁用槽串, 逗号分隔槽 id —— "headwear,eyewear"(2026-10-30):
  //                      原图词条里属于这些槽的词**整词删除**(与换词率 0% 的"保留"相反)。
  //                      位置在黑名单之后、替换规则之前(见下方 filterBannedSlots 调用);
  //                      只勾禁用不勾随机/钉词也生效 —— 所以它不走 rnd 变量, 独立判断。
  //   randomize_nsfw     '1'/'0' 是否允许从成人词库(nsfwPools)抽词; 缺省 = '1'(旧行为)
  //   randomize_seed     留空 = 每次导出都不同; 填了 = 同筛选结果可复现
  /* 高级替换方案(2026-11-09): adv_set 指定用哪一套方案(user/adv_sets.json)。
   *   '@active' = 跟随当前方案(首页导出默认); '0' = 不启用(连 NL 段一起关);
   *   方案 id   = 指定方案; 空/方案不存在 = 走老快照参数(老预设兼容, 行为不变)。
   * 方案 cfg 覆盖 randomize/pin/ban/nl 全部同形参数 —— 预设页不再手输这些串。 */
  const advSetId = String(raw.adv_set || '').trim()
  let advRaw = raw
  if (advSetId === '0') {
    advRaw = { ...raw, randomize: '0', randomize_slots: '', pin_slots: '', ban_slots: '',
      randomize_seed: '', nl_dims: '' }
  } else if (advSetId) {
    const { active, sets } = advSets()
    const set = advSetId === '@active'
      ? (sets.find((s) => s.id === active) || null)
      : (sets.find((s) => s.id === advSetId) || null)
    if (set) advRaw = { ...raw, ...advSetParams(set.cfg) }
    // 方案不存在(被删了?) → 不动, 走快照参数 —— 与"预设引用的替换规则组被删"同一处理
  }
  const rndOn = advRaw.randomize === '1' || advRaw.randomize === true
  const rndSecs = new Set()
  const rndSlots = new Set()
  const rndRates = new Map()
  // 大类串和槽串同格式, 混在一张率表里没冲突(sec id 带①/空格, slot id 是纯小写)
  const parseIdRate = (rawStr, into) => {
    for (const part of String(rawStr || '').split(',')) {
      const t = part.trim()
      if (!t) continue
      const m = t.match(/^([^:]+)(?::([\d.]+))?$/)
      if (!m) continue
      const id = m[1].trim()
      if (!id) continue
      into.add(id)
      if (m[2] !== undefined) {
        const v = Number(m[2])
        if (Number.isFinite(v)) rndRates.set(id, Math.max(0, Math.min(1, v)))
      }
    }
  }
  parseIdRate(advRaw.randomize_sections, rndSecs)
  parseIdRate(advRaw.randomize_slots, rndSlots)
  // 插入槽串(2026-11-09): 与 randomize_slots 同格式(id 或 id:率), 率 = 缺词时补上的概率。
  // 插入槽同时并进 rndSlots/rndRates —— 「有词 → 换」复用同一条随机管线, 不另写一份。
  const rndInserts = new Map()
  {
    const insSet = new Set()
    parseIdRate(advRaw.insert_slots, insSet)
    for (const id of insSet) {
      rndSlots.add(id)
      rndInserts.set(id, rndRates.get(id) ?? 1)   // 没写率 = 必补
    }
  }
  // 钉词串: "槽:词" —— indexOf(':') 而不是正则, 词本身可以带冒号以外的任何字符
  const rndPins = new Map()
  for (const part of String(advRaw.pin_slots || '').split(',')) {
    const t = part.trim()
    if (!t) continue
    const i = t.indexOf(':')
    if (i <= 0) continue
    const slot = t.slice(0, i).trim()
    const w = t.slice(i + 1).trim()
    if (slot && w) rndPins.set(slot, w)
  }
  const rndPinFill = !(advRaw.pin_fill === '0' || advRaw.pin_fill === false)
  // 禁用槽串: 纯槽 id 列表, 没有率段
  const rndBan = new Set()
  for (const part of String(advRaw.ban_slots || '').split(',')) {
    const t = part.trim()
    if (t) rndBan.add(t)
  }
  const rndSeed = advRaw.randomize_seed != null ? String(advRaw.randomize_seed).trim() : ''
  const rndNsfw = !(advRaw.randomize_nsfw === '0' || advRaw.randomize_nsfw === false)

  /* 自然语言段(2026-11-08): 从 knowledge/nl-bank.json 抽「动作/穿搭/发型」短句,
   * 追加在 tag 串后面。tag 只能表达粗粒度姿势(池子里就 25 个词), 而这两个开源
   * 图库给的是几百条具体动作的自然语言描述 —— Anima 这类模型直接吃得下。
   *   nl_dims      "pose,costume,hair" 的任意组合; 空 = 不启用
   *   nl_level     sfw(默认) | soft | nsfw —— 档位闸门在池子构建期收敛
   *   nl_pos       after(默认) | before —— 自然语言段放 tag 串后面还是前面
   *   nl_lang      en(默认) | zh —— 句子语言; 语料每条自带手工中文译文, zh 只是选用
   *   nl_strip_pose '0' 可关: 抽了动作句 → 剔原图**全部动作槽**
   *                (pose/pose_base/pose_risque/n_pos), 否则 "standing" 会和
   *                "lying on her side" 打架(默认开)
   *   nl_pose_view '0' 可关: 动作句是否带机位。机位**不是独立维度**, 它取该动作在
   *                源库里真实拍过的那几个(对齐原项目 _build_pose_prompts 的
   *                「{角度}视角，动作：{名称}」成套口径)。带机位时剔
   *                viewpoint/camera_angle —— 同一件事两个说法; 景别(shot_size)不动
   *   nl_strip_costume '0' 可关: 抽了穿搭句 → 剔原图全部**单品槽**(13 个, 见下),
   *                否则 "school uniform" 会和 "she is wearing gym clothes" 打架(默认开)
   *   nl_strip_hair '0' 可关: 抽了发型句 → 剔 hair_len/hair_color/hairstyle,
   *                否则 "long hair" 会和 "her hair is a short bob" 打架(默认开)
   *   nl_seed      留空 = 每次不同(与 randomize_seed 独立, 免得只想换动作却把换词也锁死)
   * 抽法是**发牌**不是掷骰(见 nl-bank.js): 同一批里前 N 条动作两两不同。 */
  const nlDims = String(advRaw.nl_dims || '')
    .split(',').map((s) => s.trim()).filter((d) => NL_DIMS.includes(d))
  const nlOn = nlDims.length > 0
  const nlLevel = NL_LEVELS.includes(String(advRaw.nl_level || '')) ? String(advRaw.nl_level) : 'sfw'
  const nlPos = String(raw.nl_pos || 'after') === 'before' ? 'before' : 'after'
  // 句子语言(2026-11-10): 'en'(默认) | 'zh' —— 语料每条自带手工中文译文, 这里只是选用哪个
  const nlLang = String(advRaw.nl_lang || '') === 'zh' ? 'zh' : 'en'
  const nlStripPose = !(advRaw.nl_strip_pose === '0' || advRaw.nl_strip_pose === false)
  const nlPoseView = !(advRaw.nl_pose_view === '0' || advRaw.nl_pose_view === false)
  const nlStripCostume = !(advRaw.nl_strip_costume === '0' || advRaw.nl_strip_costume === false)
  const nlStripHair = !(advRaw.nl_strip_hair === '0' || advRaw.nl_strip_hair === false)

  /* 抽了自然语言句 → 把原图**同一语义面的槽整批剔掉**, 不是只剔一个词。
   * 以前只剔 pose/pose_base(2 个), 实际动作类槽有 4 个, pose_risque 与 n_pos 会漏网,
   * 于是 prompt 里同时出现 "standing" 和 "she is lying on her side" —— 用户 2026-11-08 指出。
   * 机位同理: "seen from above" 与 viewpoint/camera_angle 是同一件事;
   * shot_size(景别) 不算 —— 景别与机位正交, 由相机插件管。
   * 穿搭(2026-11-09): NL 句是「从头到脚一整套」(上衣+裙+外套+袜+鞋+配饰),
   * 与原图单品槽同语义面, 整批剔(含 clothing_type 这种整体类型词);
   * **保留** cloth_mat / cloth_state_sfw / clothing_state —— 材质与穿着状态
   * ("partially unbuttoned")句子不提, 是互补信息不是重复面, 剔了反而丢内容。
   * 发型: NL 句描述长度+造型+发色, 剔 hair_len/hair_color/hairstyle 三个形状槽;
   * **保留** hair_tie / hair_acc(发绳发卡) —— 句子基本不提配件, 同为互补信息。 */
  const NL_STRIP_SLOTS = {
    pose: ['pose', 'pose_base', 'pose_risque', 'n_pos'],
    view: ['viewpoint', 'camera_angle'],
    costume: ['top', 'bottom', 'outfit', 'underwear', 'legwear', 'footwear',
      'headwear', 'handwear', 'accessory', 'eyewear', 'sleeves', 'swimwear', 'clothing_type'],
    hair: ['hair_len', 'hair_color', 'hairstyle'],
  }
  if (nlOn) {
    if (nlDims.includes('pose')) {
      if (nlStripPose) for (const slot of NL_STRIP_SLOTS.pose) rndBan.add(slot)
      // 机位是 pose 的附属: 出了机位半句就得剔视角槽, 关掉机位则视角 tag 保留
      if (nlPoseView) for (const slot of NL_STRIP_SLOTS.view) rndBan.add(slot)
    }
    if (nlDims.includes('costume') && nlStripCostume) {
      for (const slot of NL_STRIP_SLOTS.costume) rndBan.add(slot)
    }
    if (nlDims.includes('hair') && nlStripHair) {
      for (const slot of NL_STRIP_SLOTS.hair) rndBan.add(slot)
    }
  }
  const nlp = nlOn
    ? makeNlPicker({ dims: nlDims, maxLevel: nlLevel, seed: advRaw.nl_seed || null, poseView: nlPoseView, lang: nlLang })
    : null

  // 插入槽 × 禁用/NL 剔槽的兜底(UI 冲突检查已拦, 这里再挡一层): 被剔的槽不补词,
  // 否则 NL 把动作词删干净、插入又从池里塞一个回来, 等于绕过了剔除。
  for (const s of rndBan) rndInserts.delete(s)

  const rnd = rndOn && (rndSecs.size || rndSlots.size || rndPins.size || rndInserts.size)
    ? makeRandomizer({
        sections: rndSecs, slots: rndSlots, pins: rndPins, pinFill: rndPinFill,
        seed: rndSeed || null, rates: rndRates, nsfw: rndNsfw, inserts: rndInserts,
      })
    : null
  /* 追加标签 —— **UI 已于 2026-10-04 移除**(看板筛选区与预设编辑页的输入框都删了,
   * 用户判断"有替换规则就够了")。这段解析**故意留着**: 老预设文件里可能已经存过
   * append 字段, 直接删解析会让那些预设的追加行为**静默消失**、用户毫无察觉。
   * 现在没有 UI 能再产生新 append, 等确认没有老预设还在用之后可以整段删。
   * 原语义: 逗号分隔可多个, 每行**第一个 tag 前**插入; 已有同名 tag 的行不重复插;
   * 放在剔除/替换/补背景**之后**做, 保证追加的 tag 自己不会被黑名单/安全模式误伤。 */
  const appendRaw = typeof raw.append === 'string' ? raw.append : ''
  const appendTags = appendRaw.split(',').map((t) => t.trim()).filter(Boolean)

  const records = scopeRecords(p.srcSet, p.favs)
  let results = searchCached(
    records, p.searchTags, p.mode, p.match,
    p.excludeTags, p.excludeMatch, p.excludeChar,
    frozenKey(p.srcSet), p.favs.length ? p.favs.slice().sort().join('|') : '',
  )
  /* 文件名 / 图内元数据来源过滤(2026-10-24): 列表页筛出来的张数与导出必须同口径 ——
     筛出 100 张却导出 300 行是最糟的一种"看起来成功"。同 doSearch, 两者都只能在
     缓存结果上过滤(searchCached 的 key 不含它们)。 */
  const nameQ = String(raw.name || '').trim().toLowerCase()
  if (nameQ) results = results.filter((r) => r.path.toLowerCase().indexOf(nameQ) >= 0)
  const imgSrc = String(raw.img_src || '').trim().toLowerCase()
  if (imgSrc) results = results.filter((r) => String(r.imgSrc || '').toLowerCase() === imgSrc)

  /* 条数上限(2026-11-08): 老版没有这个参数 —— 导出永远全量。
   * 参数名特意叫 max_rows 而不是 limit: 前端 buildQuery() 带的是列表分页的
   * limit(一页 60 条), doExport 直接把它铺进导出参数 —— 若这里认 limit,
   * 「导出」会静默变成「只导当前一页」。改名隔离, 不碰老调用链。 */
  const expLimit = Number(raw.max_rows) > 0 ? Math.floor(Number(raw.max_rows)) : 0
  if (expLimit && results.length > expLimit) results = results.slice(0, expLimit)

  const bl = useBl ? blacklistMatcher() : null
  // 替换规则组(2026-10-04): raw.replace_set 指定用哪一套, 空 = 当前默认组。
  // 传 replace=0 整体关掉(与旧行为一致)。见 rules.js replaceSets()。
  const replRules = useRp ? loadReplaceRulesGroup(String(raw.replace_set || '')) : []
  let bg = null
  if (useBg) {
    const cfg = loadBgConfig()
    if (cfg.append.length) bg = cfg
  }
  const vm = stripView ? viewTagMatcher() : null
  const safeHit = safeOnly ? safetyExportStripper(String(raw.safe_level || '')) : null

  let blockedCount = 0
  let replacedCount = 0
  let bgAdded = 0
  let strippedCount = 0
  let viewStripped = 0
  let safeStripped = 0
  let appendAdded = 0
  let segStripped = 0
  let groupsStripped = 0
  let randomized = 0
  const rndBySec = {}   // 换词/钉词计数(id -> 个数, 键=槽 id 或大类 id), 回执细分用
  let slotBanned = 0    // 禁用槽删除的词数(2026-10-30), 回执展示用
  const slotBannedBy = {}
  let recIdx = 0          // 随机替换的派生种子序号(按导出行计, 与异步分片无关)
  const nlRows = []       // 自然语言段的抽取记录, 给 finish() 算批内雷同体检

  /** 单条记录 -> 一行文本(副作用: 顺带累加各类计数)。
   *  抽成闭包是给同步/分片异步两个包装共用同一套管线(2026-10-20) ——
   *  自动导出之前整条管线同步占死主进程, 大库上几秒钟界面假死。 */
  const processRecord = (r) => {
    let tags = r.tags

    if (stripChar) {
      const kept = []
      for (const t of tags) {
        if (isCharacterTag(t) || isCopyrightTag(t)) strippedCount++
        else kept.push(t)
      }
      tags = kept
    }

    if (vm) {
      const kept = []
      for (const t of tags) {
        if (isViewFast(t, vm)) viewStripped++
        else kept.push(t)
      }
      tags = kept
    }

    if (safeHit) {
      const kept = []
      for (const t of tags) {
        if (safeHit(t)) safeStripped++
        else kept.push(t)
      }
      tags = kept
    }

    if (useGroups) {
      const gctx = groupsCtx()
      if (gctx) {
        const res = applyFilterGroups(tags, gctx)
        groupsStripped += res.drops.length
        tags = res.tags
      }
    }

    if (bl) {
      const kept = []
      for (const t of tags) {
        // ban 的口径 = 原样串 + 剥权重壳归一键 双查:
        //   原样串保住老口径(黑名单条目里万一有空格形态也照旧命中);
        //   归一键补上 A1111 元数据直出的 (cat_ears:1.6) 加权形态 ——
        //   不剥壳的话 ban 掉裸词也拦不住它(2026-10-29 e2e 实锤: probe=(cat ears:1.6))
        const raw = String(t).toLowerCase()
        if (isBlockedFast(raw, bl) || isBlockedFast(tagKey(unwrapWeight(t)), bl)) blockedCount++
        else kept.push(t)
      }
      tags = kept
    }

    // 禁用槽(2026-10-30): 黑名单之后、替换规则之前 —— 被禁的词不参与替换,
    // 不会被替换规则改写成别的词留下来。钉了的槽豁免(前端保存前拦冲突, 这里只防御)。
    // 只勾禁用、不勾随机/钉词也要生效 —— 所以判断的是 rndBan.size, 不看 rnd
    // (2026-11-08: 自然语言段抽动作句时会自动往 rndBan 里塞 pose/pose_base,
    //  那条路径同样没有开随机, 所以这里不能再用 rndOn 门控)。
    if (rndBan.size) {
      const res = filterBannedSlots(tags, rndBan, new Set(rndPins.keys()))
      if (res.banned) {
        slotBanned += res.banned
        for (const [slot, n] of Object.entries(res.bySlot || {})) slotBannedBy[slot] = (slotBannedBy[slot] || 0) + n
        tags = res.tags
      }
    }

    if (replRules.length) {
      const next = []
      // 去重键按剥权重壳归一 —— red_hair 与 (red_hair:1.2) 算同一个, 先到先得
      const seen = new Set()
      for (const t of tags) {
        const nt = replaceTag(t, replRules)
        // 删除规则: 返回空数组 = 该标签整个去掉, 也计入替换数
        if (!nt.length) { replacedCount++; continue }
        for (const v of nt) {
          if (v !== t) replacedCount++
          const dk = tagKey(unwrapWeight(v))
          if (!seen.has(dk)) { seen.add(dk); next.push(v) }
        }
      }
      tags = next
      // 替换产物按分类段位重排(sortTags 稳定, 未替换的原序列不变) ——
      // 否则"blue_hair -> shota"这类改写会留在原 tag 的位置上, 导出顺序
      // 与光箱看到的分类排序对不上(2026-10-18 用户实测)
      tags = sortTags(tags)
    }

    // 权重壳去重(2026-10-19): 裸词与 (裸词:权重) 算同一个, 先到先得 ——
    // 图源标签本身同时含 uncensored 与 (uncensored:2)(A1111 元数据直出常见)时,
    // 不开替换也不会插出肉眼重复; 顺带把 case/下划线变体的重复也收敛掉
    {
      const seen = new Set()
      const kept = []
      for (const t of tags) {
        const dk = tagKey(unwrapWeight(t))
        if (!seen.has(dk)) { seen.add(dk); kept.push(t) }
      }
      tags = kept
    }

    if (bg && !hasBgTagFast(tags, bg)) {
      const bgSeen = new Set(tags.map((t) => tagKey(unwrapWeight(t))))
      for (const b of bg.append) {
        const bk = tagKey(unwrapWeight(b))
        if (!bgSeen.has(bk)) { bgSeen.add(bk); tags.push(b); bgAdded++ }
      }
    }

    if (appendTags.length) {
      // 去重口径: 跟"已有的标签"比 + 追加串内部自己也不重复。
      // 比的是归一化键(忽略大小写 / 下划线=空格 / 剥权重壳), 所以 best_quality 与
      // best quality、Masterpiece 与 masterpiece、uncensored 与 (uncensored:2) 都算同一个。
      const seen = new Set(tags.map((t) => tagKey(unwrapWeight(t))))
      const add = []
      for (const t of appendTags) {
        const k = tagKey(unwrapWeight(t))
        if (seen.has(k)) continue
        seen.add(k)
        add.push(t)
      }
      if (add.length) { appendAdded += add.length; tags = [...add, ...tags] }
    }

    // 随机替换(导出端随机化): 在替换规则/黑名单/补背景/追加之后 ——
    // 随机出的新词不会再被这些过滤步误伤; 排在 segMode 之前, 产物仍能归堆排序。
    // 1:1 语义: 原图该大类有 N 个词就换 N 个(同槽同量), prompt 结构不动。
    if (rnd) {
      const res = rnd.randomize(recIdx, tags)
      randomized += res.replaced
      for (const [sec, n] of Object.entries(res.bySec || {})) rndBySec[sec] = (rndBySec[sec] || 0) + n
      tags = res.tags
    }

    // 自然语言段: 抽在随机换词之后 —— 换词已经把 tag 侧收敛完, 这里的动作句才是最终描述。
    // 发牌式抽样见 nl-bank.js: 同一批里前 N 条动作互不相同。
    let nlText = ''
    let nlParts = null
    if (nlp) {
      const got = nlp.pick(recIdx, nlLang)
      nlText = got.text
      if (got.parts.length) nlParts = got.parts
    }
    recIdx++

    if (segMode) {
      const before = tags.length
      tags = exportSegSort(tags)
      segStripped += before - tags.length
    }

    if (spaces) tags = tags.map((t) => t.replace(/_/g, ' '))
    const s = tags.join(', ')
    const body = nlText
      ? (nlPos === 'before' ? `${nlText}, ${s}` : (s ? `${s}, ${nlText}` : nlText))
      : s
    if (nlParts) nlRows.push({ nlParts, tags })
    return withPath ? `${r.path}: ${body}` : body
  }

  const nameCore = p.searchTags.length
    ? p.searchTags.map((t) => t.replace(/[<>:"/\\|?*]/g, '_')).join('+')
    : 'all'

  const finish = () => ({
    blocked: blockedCount,
    replaced: replacedCount,
    bgAdded,
    stripped: strippedCount,
    viewStripped,
    safeStripped,
    appendAdded,
    segStripped,
    groupsStripped,
    randomized,
    randomizedBy: rndBySec,
    slotBanned,
    slotBannedBy,
    // 自然语言段回执: 抽了几个维度、批内重复率多少(发牌式抽样下应为 0, 超过池子才 >0)
    nl: nlOn
      ? {
          dims: nlp.active,
          level: nlLevel,
          picked: nlRows.length,
          dup: nlDupReport(nlRows),
          dealt: nlp.stats(),
        }
      : null,
    ms: Date.now() - t0,
    suggestedName: `筛选_${nameCore}.txt`,
  })

  return { results, processRecord, finish }
}

/** 同步版(一次性跑完) —— 手动「另存为」预览等单次调用。 */
export function buildExport(raw = {}) {
  const c = exportCore(raw)
  const lines = []
  for (const r of c.results) lines.push(c.processRecord(r))
  return {
    ...c.finish(),
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
  }
}

/**
 * 分片异步版(2026-10-20): 每 chunk 条让出一次事件循环(setImmediate),
 * 大库上跑自动导出期间光箱翻页/缩略图/一切 IPC 都还活着 —— 与 readRecords
 * 那套「分片让路」同一个思路。结果与 buildExport 完全一致(同一套管线)。
 */
export async function buildExportAsync(raw = {}, opts = {}) {
  const chunk = Math.max(1, Number(opts.chunk) || 1000)
  const c = exportCore(raw)
  const lines = []
  let i = 0
  for (const r of c.results) {
    lines.push(c.processRecord(r))
    if (++i % chunk === 0) await new Promise((res) => setImmediate(res))
  }
  return {
    ...c.finish(),
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
  }
}

/**
 * 购物车导出: 角色标签 -> wildcard 格式(转义括号、下划线转空格)。
 *
 * 2026-10-01 支持**条目级附加标签**: 条目可以是字符串, 也可以是
 * { tag, extra: ['closed_eyes', ...] } —— extra 逐个拼在同一行后面
 * (comma 分隔), 这样「哥伦比亚」导出就是 `columbina (genshin impact), closed eyes`。
 * 放同一行而不是单独一行, 是因为 wildcard 是**整行随机抽一条**, 单独一行会抽到
 * 「没有角色只有 closed eyes」的空 prompt。
 */
function escWildcard(t, spaces) {
  let s = String(t).replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  if (spaces) s = s.replace(/_/g, ' ')
  return s
}

/**
 * 购物车/角色表导出(2026-10-04 起支持替换规则组)
 * ------------------------------------------------------------------
 * 之前这里只做 escWildcard(括号转义 + 下划线转空格), 一点替换都不走 ——
 * 用户"不同导出不同方案"的需求里就包括角色表(比如把角色名批量改成另一种
 * 写法、或给每个角色加限定词)。现在:
 *   replace=0/'0'  整体关掉(默认开, 与图集导出口径一致)
 *   replace_set   选哪一套规则, 空 = 当前默认组
 * 替换对**主标签与附加标签都生效**, 且在归一化去重**之前**做 ——
 * 这样"替换后与原标签同名"的组合不会被去重吃掉(去重按 tagKey 归一)。
 */
export function buildCartExport(tags, { spaces = true, replace = true, replaceSet = '', groups = false } = {}) {
  const useRp = !(replace === false || replace === '0')
  const rules = useRp ? loadReplaceRulesGroup(String(replaceSet || '')) : []
  // 过滤组(2026-10-27): 只作用于**附加标签**——主角色标签绝不能被槽位规则吃掉。
  // 每行 = 一个角色的完整提示词, 天然单人语境 → forceSolo(行里没有 1girl 标记)。
  const gctx = groups ? groupsCtx() : null
  let groupsCut = 0
  let replaced = 0
  const entries = (tags || []).map((t) =>
    (t && typeof t === 'object') ? t : { tag: t, extra: [] })
  const lines = entries.map((e) => {
    let extras = Array.isArray(e.extra) ? e.extra.filter((x) => String(x || '').trim()) : []
    if (gctx && extras.length) {
      const res = applyFilterGroups(extras, { ...gctx, forceSolo: true })
      groupsCut += res.drops.length
      extras = res.tags
    }
    /* 规则把一个标签变成多个时, 在**同一行内逗号展开** —— wildcard 的原生语义就是
     * "一行是一个搜索式, 逗号=同时含"(1boy -> 1boy, solo 应写成 `1boy, solo`)。
     * 摊成多行会变成两个独立搜索式, 语义不同, 不能这么干。
     * ⚠️ 命中判定不能看"结果条数": replaceTag 未命中时也返回长度 1 的 [tag],
     * 命中单值替换(如 frieren -> frieren_x)也是长度 1 —— 只有**内容变了或变多了**
     * 才算命中。这条判错会让"替换条数"统计永远是 0 或虚高。 */
    const replaced_ = rules.length ? replaceTag(e.tag, rules) : [e.tag]
    if (rules.length && (replaced_.length > 1 || replaced_[0] !== e.tag)) replaced++
    return [[...replaced_.map((x) => escWildcard(x, spaces)),
      ...extras.map((x) => escWildcard(x, spaces))].join(', ')]
  }).flat()
  return {
    text: lines.join('\n') + (lines.length ? '\n' : ''),
    count: lines.length,
    replaced,
    groupsCut,
    suggestedName: 'roles_cart.txt',
  }
}

/**
 * 单图「复制标签」过滤管线(2026-10-19 光箱复制设置面板)
 * 与 buildExport 用**同一批原语**, 但只处理一张图的标签数组:
 *   视角剔除 -> 安全剔除 -> 替换规则(+ sortTags 归位)
 * 黑名单/角色系列的剔除留在渲染层(光箱手里已有 ban_map 和 plain_tags)。
 * 顺序等价的理由: 这几步都是纯删除, 替换是唯一的改写步 —— 两条路径里替换都排最后,
 * 且替换产物都不再回查黑名单/视角/安全(buildExport 里它们也排在替换之前)。
 * opts: { replace_set, view, safe, safe_level, replace } —— replace=false 整体关, 其余缺省=关
 * 返回 { tags, counts: { view, safe, replaced } }
 */
/**
 * 过滤组上下文(2026-10-27 词条管线第二层) —— 懒加载+缓存:
 *   slots  = knowledge/tag_slots.json(槽位词典, build-tag-slots.mjs 产物)
 *   rules  = knowledge/filter-rules.json(keepOne 槽位 + mutex 互斥组)
 *   counts = tags 表的本地图片量(keep-one 胜者权重)
 * 任一文件缺失/损坏 → 返回 null, 过滤组段静默跳过(与 slots 下发同一降级哲学)。
 */
let groupsCtxCache = null
function groupsCtx() {
  if (groupsCtxCache !== null) return groupsCtxCache
  try {
    const slots = JSON.parse(fs.readFileSync(path.join(BUNDLED_KNOWLEDGE_DIR, 'tag_slots.json'), 'utf8')).tags || {}
    const rules = JSON.parse(fs.readFileSync(path.join(BUNDLED_KNOWLEDGE_DIR, 'filter-rules.json'), 'utf8'))
    const counts = {}
    for (const r of openDb().prepare('SELECT name, cnt FROM tags').all()) counts[r.name] = r.cnt
    groupsCtxCache = { slots, counts, rules }
  } catch { groupsCtxCache = false }
  return groupsCtxCache
}

export function filterTagsLikeExport(tags, opts = {}) {
  let out = (tags || []).slice()
  const counts = { view: 0, safe: 0, replaced: 0, groups: 0 }

  const vm = opts.view ? viewTagMatcher() : null
  if (vm) {
    const kept = []
    for (const t of out) {
      if (isViewFast(t, vm)) counts.view++
      else kept.push(t)
    }
    out = kept
  }

  const safeHit = opts.safe ? safetyExportStripper(String(opts.safe_level || '')) : null
  if (safeHit) {
    const kept = []
    for (const t of out) {
      if (safeHit(t)) counts.safe++
      else kept.push(t)
    }
    out = kept
  }

  // ---- 过滤组(词条管线第二层): 槽内单选 + 互斥消解, 仅单人图生效 ----
  // 排在替换之前 —— 本段是纯删除, 与视角/安全同列; 替换是唯一改写步, 保持压轴。
  if (opts.groups) {
    const gctx = groupsCtx()
    if (gctx) {
      const res = applyFilterGroups(out, gctx)
      counts.groups = res.drops.length
      out = res.tags
    }
  }

  const rules = opts.replace === false ? [] : loadReplaceRulesGroup(String(opts.replace_set || ''))
  if (rules.length) {
    const next = []
    // 去重键按剥权重壳归一(同 buildExport)
    const seen = new Set()
    for (const t of out) {
      const nt = replaceTag(t, rules)
      // 删除规则: 返回空数组 = 该标签整个去掉, 也计入替换数(与 buildExport 同口径)
      if (!nt.length) { counts.replaced++; continue }
      for (const v of nt) {
        if (v !== t) counts.replaced++
        const dk = tagKey(unwrapWeight(v))
        if (!seen.has(dk)) { seen.add(dk); next.push(v) }
      }
    }
    // 替换产物按分类段位重排 —— 同 buildExport 的"导出顺序与光箱一致"理由
    out = sortTags(next)
  }

  // 权重壳去重(同 buildExport, 2026-10-19): 源列表本身同时含裸词与带权版
  // (A1111 元数据直出)时也收敛, 先到先得 —— 不依赖替换规则开关
  {
    const seen = new Set()
    const kept = []
    for (const t of out) {
      const dk = tagKey(unwrapWeight(t))
      if (!seen.has(dk)) { seen.add(dk); kept.push(t) }
    }
    out = kept
  }

  return { tags: out, counts }
}
