#!/usr/bin/env node
/**
 * 构建槽位词典 v1 —— 词条管线第一步
 *
 * 数据源:
 *   1. ANIMA Wardrobe presets/anima_v3_pools.json   15段/55字段/987选项, 每个选项=[中文, danbooru tag串]
 *   2. ANIMA Wardrobe presets/anima_v3_levels.json  tag_levels: 每个tag的NSFW档位(0-4)
 *   3. tags.db kind='other'                         本地词表(带图片计数, cat 列已有本项目粗分类)
 *
 * 产物:
 *   knowledge/tag_slots.json   { tag: { slot, fieldZh, sec, secZh, zh, level } }
 *   .e2e-work/slot-coverage.json  覆盖率报告
 *
 * 运行: node scripts/build-tag-slots.mjs [--wardrobe <路径>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = path.resolve(import.meta.dirname, '..')
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([\w-]+)=(.+)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
// Wardrobe 仓库路径走环境变量(preflight 禁硬编码盘符路径);
// 默认指向本机克隆位, 换机器时设 TV_WARDROBE_DIR 即可
const WARDROBE = args.wardrobe || process.env.TV_WARDROBE_DIR
if (!WARDROBE || !existsSync(WARDROBE)) {
  console.error(`缺少 ANIMA Wardrobe 仓库: 请设 TV_WARDROBE_DIR=<仓库路径> 或 --wardrobe=<路径>`)
  process.exit(1)
}

// ---------- 1. ANIMA 种子词典 ----------
const pools = JSON.parse(readFileSync(path.join(WARDROBE, 'presets/anima_v3_pools.json'), 'utf8'))
const levels = JSON.parse(readFileSync(path.join(WARDROBE, 'presets/anima_v3_levels.json'), 'utf8'))
const tagLevel = levels.tag_levels || {}          // { tag: 档位数字 }

const byTag = new Map()                           // tag -> {slot, fieldZh, sec, secZh, zh, level}
let optionCount = 0
const put = (tag, rec) => {
  if (!tag || tag.startsWith('@')) return
  if (!byTag.has(tag)) byTag.set(tag, rec)
  const us = tag.replace(/ /g, '_')               // ANIMA 空格写法 -> 本地下划线写法 双向索引
  if (!byTag.has(us)) byTag.set(us, rec)
}
for (const sec of pools.sections) {
  const secZh = sec.title || sec.id
  for (const fld of sec.fields) {
    for (const [zh, en] of fld.opts || []) {
      optionCount++
      for (const t of String(en).split(',')) {
        const tag = t.trim().toLowerCase()
        if (!tag) continue
        const rec = { slot: fld.key, fieldZh: fld.lab, sec: sec.id, secZh, zh, level: tagLevel[tag] ?? null }
        put(tag, rec)
      }
    }
  }
}
console.log(`ANIMA 词典: ${optionCount} 选项 → ${byTag.size} 个去重 tag`)

// ---------- 1b. ANIMA NSFW 词表 (v2 新增) ----------
// anima_v3_nsfw.py 经 .e2e-work/dump-nsfw.py 导出: 16 分类(裸露/透视/半脱/裁剪/
// 恋物/性爱/玩具/捆绑/体液/群体/极端...), 每分类 label+level+tags+patterns
const nsfw = JSON.parse(readFileSync(path.join(REPO, '.e2e-work/anima-nsfw-dump.json'), 'utf8'))
let nsfwNew = 0, nsfwLevelFilled = 0
for (const [cat, t] of Object.entries(nsfw.tables)) {
  for (const tag of t.tags) {
    const key = tag.trim().toLowerCase()
    if (!key) continue
    const exist = byTag.get(key)
    if (exist) {
      if (exist.level == null && t.level != null) { exist.level = t.level; nsfwLevelFilled++ }
      continue
    }
    const rec = { slot: 'nsfw:' + cat, fieldZh: t.label, sec: 'nsfw', secZh: 'NSFW 分级', zh: t.label, level: t.level }
    put(key, rec); nsfwNew++
  }
}
// 擦边词(suggestive 集合, 无分类归属) —— 只补 level=1, 不抢已有槽位
for (const tag of nsfw.suggestive) {
  const key = tag.trim().toLowerCase()
  const exist = byTag.get(key)
  if (!exist) { put(key, { slot: 'nsfw:suggestive', fieldZh: '擦边', sec: 'nsfw', secZh: 'NSFW 分级', zh: '擦边', level: 1 }); nsfwNew++ }
  else if (exist.level == null) { exist.level = 1; nsfwLevelFilled++ }
}
console.log(`NSFW 词表: 新增 ${nsfwNew} tag, 补档位 ${nsfwLevelFilled} 个 → 总 ${byTag.size}`)

// ---------- 1c. 高频手工归槽 (v2) ----------
// ANIMA 词表没覆盖、但属于机械可判的高频 danbooru tag。格式: [slot, fieldZh, zh, level?]
// body_part/clothing 等槽位键是本项目自定(词表底座), 与 ANIMA 槽位命名空间并存
const EXTRA = {
  // 人体部位 (general:人物)
  'breasts': ['body_part', '胸部', '乳房'], 'thighs': ['body_part', '腿部', '大腿'],
  'navel': ['body_part', '躯干', '肚脐'], 'collarbone': ['body_part', '躯干', '锁骨'],
  'feet': ['body_part', '腿部', '脚'], 'toes': ['body_part', '腿部', '脚趾'],
  'soles': ['body_part', '腿部', '脚底'], 'stomach': ['body_part', '躯干', '腹部'],
  'legs': ['body_part', '腿部', '双腿'], 'ass': ['body_part', '臀部', '臀部', 1],
  'penis': ['body_part', '生殖器', '阴茎', 2], 'armpits': ['body_part', '上肢', '腋下'],
  'shoulders': ['body_part', '上肢', '肩膀'], 'hands': ['body_part', '上肢', '手'],
  'arms': ['body_part', '上肢', '手臂'], 'elbows': ['body_part', '上肢', '手肘'],
  'knees': ['body_part', '腿部', '膝盖'], 'hips': ['body_part', '臀部', '胯部'],
  'waist': ['body_part', '躯干', '腰'], 'back': ['body_part', '躯干', '背部'],
  'neck': ['body_part', '头部', '脖子'], 'face': ['body_part', '头部', '脸'],
  'lips': ['body_part', '头部', '嘴唇'], 'teeth': ['body_part', '头部', '牙齿'],
  'tongue': ['body_part', '头部', '舌头'], 'earrings': ['accessory', '饰品', '耳环'],
  // 服饰/配件 (general:服饰)
  'hair_ornament': ['headwear', '头饰', '发饰'], 'hair_flower': ['headwear', '头饰', '发花'],
  'halo': ['headwear', '头饰', '光环'], 'long_sleeves': ['sleeves', '袖长', '长袖'],
  'short_sleeves': ['sleeves', '袖长', '短袖'], 'sleeveless': ['sleeves', '袖长', '无袖'],
  'thighhighs': ['legwear', '腿袜', '过膝袜'], 'pantyhose': ['legwear', '腿袜', '连裤袜'],
  'kneehighs': ['legwear', '腿袜', '及膝袜'], 'socks': ['legwear', '腿袜', '袜子'],
  'underwear': ['underwear', '内衣层', '内衣'], 'panties': ['underwear', '内衣层', '内裤'],
  'bra': ['underwear', '内衣层', '胸罩'], 'lingerie': ['underwear', '内衣层', '情趣内衣', 1],
  'bow': ['accessory', '饰品', '蝴蝶结'], 'ribbon': ['accessory', '饰品', '缎带'],
  'jewelry': ['accessory', '饰品', '珠宝'], 'necklace': ['accessory', '饰品', '项链'],
  'gloves': ['handwear', '手部服饰', '手套'], 'white_shirt': ['top', '上装', '白衬衫'],
  'black_shirt': ['top', '上装', '黑衬衫'], 'no_shoes': ['footwear', '鞋袜', '光脚无鞋'],
  'barefoot': ['footwear', '鞋袜', '赤足'], 'high_heels': ['footwear', '鞋袜', '高跟鞋'],
  // 场景/画面/动作/镜头
  'indoors': ['location', '场所', '室内'], 'outdoors': ['location', '场所', '室外'],
  'mosaic_censoring': ['censorship', '审查', '马赛克'], 'censored': ['censorship', '审查', '有码'],
  'uncensored': ['censorship', '审查', '无码'], 'bar_censor': ['censorship', '审查', '色条打码'],
  'holding': ['interact', '持物动作', '拿着'], 'holding_hands': ['interact', '持物动作', '手牵手'],
  'solo_focus': ['focus', '镜头焦点', '单人焦点'],
}
let extraNew = 0, extraUpgraded = 0
for (const [tag, [slot, fieldZh, zh, level]] of Object.entries(EXTRA)) {
  const exist = byTag.get(tag)
  if (exist) {   // 已有(如 ANIMA 带过) → 只在缺档位时补
    if (exist.level == null && level != null) { exist.level = level; extraUpgraded++ }
    continue
  }
  byTag.set(tag, { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null })
  byTag.set(tag.replace(/ /g, '_'), { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null })
  extraNew++
}
console.log(`高频手工归槽: 新增 ${extraNew}, 补档位 ${extraUpgraded} → 总 ${byTag.size}`)

// ---------- 1d. 颜色×基础词 模式归槽 (v2) ----------
// danbooru 高频模式: black_gloves / white_panties / blue_eyes ... = 颜色前缀 + 基础词。
// 对词典里每个基础词批量生成颜色变体, 继承 slot/level, zh=颜色zh+基础zh。
const COLOR_ZH = { black: '黑', white: '白', red: '红', blue: '蓝', aqua: '水色',
  grey: '灰', gray: '灰', brown: '棕', green: '绿', orange: '橙', pink: '粉',
  purple: '紫', yellow: '黄', transparent: '透明' }
const COLOR_KEYS = new Set(Object.keys(COLOR_ZH))
const isColorVar = (k) => COLOR_KEYS.has(k.split(/[_ ]/)[0])
let colorVar = 0
for (const [base, rec] of [...byTag]) {
  const us = base.replace(/ /g, '_')
  if (us !== base && byTag.has(us)) continue        // 只从下划线规范形展开一份
  if (isColorVar(us)) continue                       // 不做颜色套颜色
  if (rec.sec === 'nsfw') continue                   // NSFW 分类语义对颜色变体不成立(如 "black nudity")
  for (const [c, cz] of Object.entries(COLOR_ZH)) {
    for (const v of [`${c}_${us}`, `${c} ${us}`]) {
      if (!byTag.has(v)) { byTag.set(v, { ...rec, zh: cz + (rec.zh || '') }); colorVar++ }
    }
  }
}
console.log(`颜色变体展开: +${colorVar} → 总 ${byTag.size}`)

// ---------- 1e. 环境/发型发色/身体特征/杂物 批量归槽 (v2) ----------
// ANIMA pools 没收录、但 tags.db 高频且机械可判的, 自建槽位键。格式: [slot, fieldZh, zh, level?]
const EXTRA2 = {
  // 环境 (general:环境)
  'sky': ['environment', '环境', '天空'], 'day': ['environment', '环境', '白天'],
  'night': ['environment', '环境', '夜晚'], 'sunset': ['environment', '环境', '日落'],
  'night_sky': ['environment', '环境', '夜空'], 'starry_sky': ['environment', '环境', '星空'],
  'cloud': ['environment', '环境', '云'], 'cloud_sky': ['environment', '环境', '多云天'],
  'blue_sky': ['environment', '环境', '蓝天'], 'water': ['environment', '环境', '水体'],
  'tree': ['environment', '环境', '树'], 'grass': ['environment', '环境', '草地'],
  'forest': ['environment', '环境', '森林'], 'rain': ['environment', '环境', '雨天'],
  'snow': ['environment', '环境', '雪'], 'nature': ['environment', '环境', '自然'],
  // 发色/发型 (general:人物)
  'grey_hair': ['hair_color', '发色', '灰发'], 'multicolored_hair': ['hair_color', '发色', '多色发'],
  'colored_inner_hair': ['hair_color', '发色', '挑染内层'],
  'ponytail': ['hairstyle', '发型', '马尾'], 'ahoge': ['hairstyle', '发型', '呆毛'],
  'braid': ['hairstyle', '发型', '麻花辫'], 'sidelocks': ['hairstyle', '发型', '鬓发'],
  // 身体特征 (general:人物)
  'tail': ['feature', '非人特征', '尾巴'], 'horns': ['feature', '非人特征', '角'],
  'mole': ['feature', '身体特征', '痣'], 'animal_ears': ['feature', '非人特征', '兽耳'],
  'animal_ear_fluff': ['feature', '非人特征', '兽耳绒毛'], 'wings': ['feature', '非人特征', '翅膀'],
  'fang': ['feature', '身体特征', '獠牙'], 'toenails': ['body_part', '腿部', '脚趾甲'],
  'cleft_of_venus': ['body_part', '生殖器', '阴丘', 2], 'female_pubic_hair': ['body_part', '生殖器', '女性体毛', 2],
  // 服饰/画面/道具杂项
  'swimsuit': ['clothing_type', '服装类型', '泳装'], 'hat': ['headwear', '头饰', '帽子'],
  'detached_sleeves': ['sleeves', '袖长', '分离袖'], 'bare_legs': ['legwear', '腿袜', '裸腿'],
  'official_alternate_costume': ['costume_meta', '官方换装', '官方异装'],
  'flower': ['prop', '道具', '花'], 'bed': ['furniture', '家具场景', '床'],
  'heart': ['graphic', '画面元素', '心形符号'], 'lens_flare': ['photo', '摄影效果', '镜头光晕'],
}
let e2New = 0
for (const [tag, [slot, fieldZh, zh, level]] of Object.entries(EXTRA2)) {
  if (byTag.has(tag)) continue
  const rec = { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null }
  byTag.set(tag, rec); byTag.set(tag.replace(/_/g, ' '), rec); e2New++
}
console.log(`环境/特征批归槽: 新增 ${e2New} → 总 ${byTag.size}`)

// ---------- 1f. 后缀模式: <色>_eyes / <色>_hair (v2) ----------
// ANIMA 眼色选项没有 pink 等, 颜色前缀规则也帮不了 bare "eyes" 不在词典的情况 → 直接按尾词判
const EYE_ZH = '瞳', HAIR_ZH = '发'
let suffixN = 0
for (const [c, cz] of Object.entries(COLOR_ZH)) {
  for (const [suffix, slot, fieldZh, tailZh] of [['eyes', 'eyes_color', '眼色', EYE_ZH], ['hair', 'hair_color', '发色', HAIR_ZH]]) {
    for (const v of [`${c}_${suffix}`, `${c} ${suffix}`]) {
      if (!byTag.has(v)) { byTag.set(v, { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh: cz + tailZh, level: null }); suffixN++ }
    }
  }
}
console.log(`眼色/发色后缀规则: +${suffixN}`)

// ---------- 1g. 第二批手工归槽: 榜单新暴露的高频词 (v2) ----------
const EXTRA3 = {
  'black_footwear': ['footwear', '鞋袜', '黑鞋'], 'foot_focus': ['focus', '镜头焦点', '足部焦点'],
  'symbol-shaped_pupils': ['eyes_detail', '瞳孔细节', '符号形瞳孔'],
  'pointy_ears': ['feature', '非人特征', '尖耳'], 'cat_ears': ['feature', '非人特征', '猫耳'],
  'fake_animal_ears': ['feature', '非人特征', '假兽耳'], 'two-tone_hair': ['hair_color', '发色', '双色发'],
  'hair_over_one_eye': ['hairstyle', '发型', '发遮单眼'], 'hair_spread_out': ['hairstyle', '发型', '头发散开'],
  'erection': ['nsfw:arousal', '生理反应', '勃起', 2], 'saliva': ['nsfw:fluid', '体液', '唾液', 1],
  'skindentation': ['body_detail', '身体细节', '压痕'], 'breasts_apart': ['body_detail', '身体细节', '乳分离'],
  'covered_navel': ['clothing_state', '遮露状态', '遮住肚脐'],
  'centered': ['composition', '构图', '居中构图'], 'simple_background': ['background', '背景', '简洁背景'],
  'white_background': ['background', '背景', '白背景'], 'ocean': ['environment', '环境', '海洋'],
  'plant': ['prop', '道具', '植物'], 'food': ['prop', '道具', '食物'],
  'alternate_costume': ['costume_meta', '官方换装', '私服异装'],
  'bowtie': ['accessory', '饰品', '领结'], 'detached_collar': ['accessory', '饰品', '分离领'],
  'collared_shirt': ['top', '上装', '有领衬衫'], 'sailor_collar': ['accessory', '饰品', '水手领'],
  'see-through_clothes': ['nsfw:see_through', '透视', '透视服装', 1],
  'virtual_youtuber': ['identity', '身份', '虚拟主播'],
  'arm_up': ['pose', '姿势', '举臂'],
}
let e3New = 0
for (const [tag, [slot, fieldZh, zh, level]] of Object.entries(EXTRA3)) {
  if (byTag.has(tag)) continue
  const rec = { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null }
  byTag.set(tag, rec); byTag.set(tag.replace(/_/g, ' '), rec); e3New++
}
console.log(`第二批手工归槽: 新增 ${e3New} → 总 ${byTag.size}`)

// ---------- 1h. 第三批手工归槽: 收口高频尾巴 (v2) ----------
const EXTRA4 = {
  'shoes': ['footwear', '鞋袜', '鞋'], 'elbow_gloves': ['handwear', '手部服饰', '长手套'],
  'wrist_cuffs': ['handwear', '手部服饰', '腕套'], 'collar': ['accessory', '饰品', '颈环'],
  'apron': ['clothing_type', '服装类型', '围裙'], 'leotard': ['clothing_type', '服装类型', '紧身衣'],
  'japanese_clothes': ['ethnic_wear', '民族服饰', '和服类'], 'chinese_clothes': ['ethnic_wear', '民族服饰', '中华风'],
  'wide_sleeves': ['sleeves', '袖长', '宽袖'], 'thighband_pantyhose': ['legwear', '腿袜', '大腿环连裤袜'],
  'rabbit_ears': ['feature', '非人特征', '兔耳'], 'fox_ears': ['feature', '非人特征', '狐耳'],
  'demon_horns': ['feature', '非人特征', '魔角'], 'sparse_pubic_hair': ['body_part', '生殖器', '稀疏体毛', 2],
  'male_pubic_hair': ['body_part', '生殖器', '男性体毛', 2], 'clitoral_hood': ['body_part', '生殖器', '阴蒂包皮', 2],
  'toenail_polish': ['body_part', '腿部', '脚趾甲油'],
  'medium_shot': ['shot_size', '景别', '中景'], 'foreshortening': ['technique', '画法', '透视缩短法'],
  'sunlight': ['lighting', '光照', '日光'],
  'arm_support': ['pose', '姿势', '手臂支撑'],
  'foot_out_of_frame': ['framing', '出画', '脚出画'], 'feet_out_of_frame': ['framing', '出画', '双脚出画'],
  ':d': ['expression', '表情', '咧嘴笑'], 'open_mouth': ['expression', '表情', '张嘴'],
  'clothed_female_nude_male': ['nsfw:cfnm', '裸露差', '女衣男裸', 2],
  'pelvic_curtain': ['nsfw:censorship_alt', '遮挡物', '骨盆帘', 1],
}
let e4New = 0
for (const [tag, [slot, fieldZh, zh, level]] of Object.entries(EXTRA4)) {
  if (byTag.has(tag)) continue
  const rec = { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null }
  byTag.set(tag, rec); byTag.set(tag.replace(/_/g, ' '), rec); e4New++
}
console.log(`第三批手工归槽: 新增 ${e4New} → 总 ${byTag.size}`)

// ---------- 1i. 显示名覆写 (v2.1) ----------
// 前面各段的合并规则都是"先到先得", 有些 tag 被 NSFW 词表/ANIMA 字段名带偏,
// 直接当光箱分组标题会很难看。这里强制覆写(唯一一段允许覆盖已有记录的)。
// fieldZh = 光箱「粗类·细分」标题; slot = 未来过滤组引擎的槽位键。
const OVERRIDE = {
  // lace_trim 被 NSFW 词表归到 fetish(暴露癖/情境) → 实际就是蕾丝花边, 归材质
  'lace_trim':       ['cloth_mat', '材质', '蕾丝边'],
  // garter_straps 来自 ANIMA「腿上」字段, 标题太怪 → 并入腿袜组
  'garter_straps':   ['legwear', '腿袜', '吊袜带'],
  // bare_shoulders 被 NSFW 词表标成 裁剪/镂空 → 显示为「露肩」更贴切(档位保留)
  'bare_shoulders':  ['nsfw:cutout', '露肩', '裸肩'],
  // 光箱服饰组高频兜底漏网(截图实见): 补齐
  'veil':            ['headwear', '头饰', '头纱'],
  'side-tie_panties': ['underwear', '内衣层', '侧系内裤'],
  'bow_panties':     ['underwear', '内衣层', '蝴蝶结内裤'],
}
let ovN = 0
for (const [tag, [slot, fieldZh, zh]] of Object.entries(OVERRIDE)) {
  const rec = { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: null }
  // 保留已有 level(覆写只动分组显示, 不动分级档位)
  const exist = byTag.get(tag)
  if (exist) rec.level = exist.level
  const oldSlot = exist?.slot
  byTag.set(tag, rec); byTag.set(tag.replace(/_/g, ' '), rec)
  // 颜色变体(1d)在覆写前展开, 会继承旧槽位标签 → 同步扫掉(以旧 slot 判定, 防误伤)
  if (oldSlot) {
    for (const [k, v] of byTag) {
      if (k !== tag && v?.slot === oldSlot && (k.endsWith('_' + tag) || k.endsWith(' ' + tag.replace(/_/g, ' ')))) {
        byTag.set(k, { ...rec, zh: v.zh })
      }
    }
  }
  ovN++
}
console.log(`显示名覆写: ${ovN} 条`)

// ---------- 2. tags.db 本地词表 ----------
// cat 列已有本项目的粗分类: general:人物/服饰/场景/环境/物品/画面/表情动作/镜头 + count/meta/other
// 词典策略: 粗分类(已有) 做第一层, ANIMA 字段槽位做第二层细化
const db = new DatabaseSync(path.join(REPO, 'data/tags.db'), { readOnly: true })
const rows = db.prepare("SELECT name, cnt, cat FROM tags WHERE kind='other' ORDER BY cnt DESC").all()
const classified = rows.filter(r => /^general:|^count$/.test(r.cat))
console.log(`本地词表: ${rows.length} 个 | 已粗分类: ${classified.length} | 未分类(other): ${rows.length - classified.length}`)

// ---------- 3. 覆盖率: ANIMA 细槽位能细化多少已分类词条 ----------
const matched = [], unmatched = []
for (const r of classified) {
  const hit = byTag.get(r.name)
  if (hit) matched.push({ tag: r.name, cnt: r.cnt, cat: r.cat, ...hit })
  else unmatched.push({ tag: r.name, cnt: r.cnt, cat: r.cat })
}
console.log(`已分类词条被 ANIMA 细化: ${matched.length}/${classified.length} (${(matched.length / classified.length * 100).toFixed(1)}%)`)
console.log(`按图片量(已分类词条总cnt): ${(matched.reduce((s, m) => s + m.cnt, 0) / classified.reduce((s, r) => s + r.cnt, 0) * 100).toFixed(1)}%`)
for (const c of ['general:服饰', 'general:人物', 'general:表情动作', 'general:场景', 'general:环境', 'general:物品', 'general:画面', 'general:镜头', 'count']) {
  const all = classified.filter(r => r.cat === c)
  const m = all.filter(r => byTag.has(r.name))
  if (all.length) console.log(`  ${c}: ${m.length}/${all.length} 细化 (${(m.length / all.length * 100).toFixed(0)}%)`)
}

console.log('\n未细化 Top30 (按图片量, 人工补 ANIMA 槽位的工作清单):')
unmatched.slice(0, 30).forEach(u => console.log(`  ${u.cat}  ${u.tag} (${u.cnt})`))

// ---------- 4. 落盘 ----------
const out = {}
for (const m of matched) {
  out[m.tag] = { slot: m.slot, fieldZh: m.fieldZh, sec: m.sec, secZh: m.secZh, zh: m.zh, level: m.level }
}
mkdirSync(path.join(REPO, 'knowledge'), { recursive: true })
mkdirSync(path.join(REPO, '.e2e-work'), { recursive: true })
writeFileSync(path.join(REPO, 'knowledge/tag_slots.json'), JSON.stringify({
  _meta: {
    schema: 'tag-viewer/tag-slots@1', built_by: 'scripts/build-tag-slots.mjs',
    seed_source: 'ANIMA Wardrobe v3 pools.json (MIT)',
    note: 'slot=ANIMA细槽位(可空), 本项目粗分类见 tags.db tags.cat',
    tags: Object.keys(out).length,
    classified_total: classified.length
  },
  tags: out
}, null, 1))
writeFileSync(path.join(REPO, '.e2e-work/slot-coverage.json'), JSON.stringify({
  matched: matched.map(m => [m.tag, m.cnt, m.cat, m.slot]),
  unmatchedTop: unmatched.slice(0, 500)
}))
console.log(`\n已写 knowledge/tag_slots.json (${Object.keys(out).length} tags) 与覆盖率报告`)
