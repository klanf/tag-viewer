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
  'underwear': ['underwear', '内衣层', '内衣'], 'panties': ['underwear', '内衣层', '内裤', 1],
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
  // 腿袜类槽位统一: ANIMA「腿上」(socks) 与自建 legwear 是同一语义类,
  // 劈成两半会让过滤组 keep-one 跨槽失效(黑连裤袜×过膝袜去不了重)
  'pantyhose':       ['legwear', '腿袜', '连裤袜'],
  'kneehighs':       ['legwear', '腿袜', '及膝袜'],
  'single_thighhigh': ['legwear', '腿袜', '单边过膝袜'],
  // fang 被 ANIMA 归「嘴部」→ 实际是非人特征, 獠牙×张嘴合法共存
  'fang':            ['feature', '非人特征', '獠牙'],
  // on_bed 被 ANIMA 归「基础姿势」→ 站床上×on_back 合法共存, 归家具场景
  'on_bed':          ['furniture', '家具场景', '在床上'],
  // outdoors 被 ANIMA NSFW 词表归 fetish(公开暴露情境) → 对本项目就是「室外」,
  // 纯 SFW 场景词; NSFW 合并先占坑导致手工批(skip-if-exist)永远抢不回, 只能在这覆写
  'outdoors':        ['location', '场所', '室外'],
  // 尾巴系归一 tail 槽(原 tail 本体被劈在 feature, 装饰品散落 unknown → 变体端 8 个尾巴词并存)
  'tail':            ['tail', '尾部', '尾巴'],
  'tail_ribbon':     ['tail', '尾部', '尾饰带'],
  'tail_bow':        ['tail', '尾部', '尾结'],
  'tail_bell':       ['tail', '尾部', '尾铃'],
  'tail_ornament':   ['tail', '尾部', '尾饰'],
  'tail_ring':       ['tail', '尾部', '尾环'],
  'multiple_tails':  ['tail', '尾部', '多条尾巴'],
  'two_tails':       ['tail', '尾部', '双尾'],
  'nekomata':        ['race', '种族', '猫又'],
  // 花类归 prop(变体端 rose×3 并存)
  'rose':            ['prop', '手持物', '玫瑰'],
  'pink_rose':       ['prop', '手持物', '粉玫瑰'],
  'purple_rose':     ['prop', '手持物', '紫玫瑰'],
  'white_rose':      ['prop', '手持物', '白玫瑰'],
  'red_rose':        ['prop', '手持物', '红玫瑰'],
  'blue_rose':       ['prop', '手持物', '蓝玫瑰'],
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

// ---------- 1j. 词典 v3: 未识别 Top 榜归槽 (2026-10-27) ----------
// 来源: .e2e-work 全库探针未识别 Top 220, 手工归槽。skip-if-exist。
// 新开槽位: wings 尾巴tail 角horn 种族race 美甲nails 眼镜eyewear
//           机位角度camera_angle 镜头效果camera_fx 水中状态water_state
//           n_male(男角/年龄体型) n_touch(性接触) n_sex(性行为) n_bondage(束缚) meta(元信息)
const EXTRA_V3 = {
  // --- 服饰/穿着状态 ---
  'wet': ['clothing_state', '遮露状态', '湿身'],
  'wet_clothes': ['clothing_state', '遮露状态', '湿衣物'],
  'strapless': ['cloth_state_sfw', '穿着方式', '抹胸式'],
  'partially_unbuttoned': ['cloth_state_sfw', '穿着方式', '半解扣'],
  'strap_slip': ['clothing_state', '遮露状态', '肩带滑落'],
  'clothing_aside': ['clothing_state', '遮露状态', '拨开衣物'],
  'lifting_own_clothes': ['clothing_state', '遮露状态', '自撩衣物'],
  'revealing_clothes': ['clothing_state', '遮露状态', '暴露着装'],
  'underwear_only': ['underwear', '内衣层', '仅穿内衣'],
  'bra': ['underwear', '内衣层', '胸罩'],
  'lace-trimmed_bra': ['underwear', '内衣层', '蕾丝胸罩'],
  'lingerie': ['underwear', '内衣层', '情趣内衣'],
  'panties_under_pantyhose': ['underwear', '内衣层', '丝袜内裤'],
  'torn_pantyhose': ['legwear', '腿袜', '破洞连裤袜'],
  'thighlet': ['legwear', '腿袜', '腿环袜'],
  'bridal_gauntlets': ['handwear', '手部服饰', '婚纱手套'],
  'fingerless_gloves': ['handwear', '手部服饰', '露指手套'],
  'sleeves_past_wrists': ['sleeves', '袖长', '袖子盖手'],
  'puffy_short_sleeves': ['sleeves', '袖长', '短泡泡袖'],
  'necktie': ['accessory', '饰品', '领带'],
  'neckerchief': ['accessory', '饰品', '领巾'],
  'bell': ['accessory', '饰品', '铃铛'],
  'neck_bell': ['accessory', '饰品', '颈铃'],
  'sash': ['accessory', '饰品', '腰带饰'],
  'belt': ['accessory', '饰品', '皮带'],
  'obi': ['accessory', '饰品', '和服带'],
  'tassel': ['accessory', '饰品', '流苏'],
  'chain': ['accessory', '饰品', '锁链'],
  'bag': ['accessory', '饰品', '包袋'],
  // --- 服装类型/款式 ---
  'frilled_dress': ['outfit', '整套服装', '褶边连衣裙'],
  'maid_apron': ['outfit', '整套服装', '女仆围裙'],
  'frilled_apron': ['outfit', '整套服装', '褶边围裙'],
  'white_apron': ['outfit', '整套服装', '白围裙'],
  'coat': ['top', '上装外套', '大衣'],
  'pants': ['bottom', '下装', '长裤'],
  'plaid_skirt': ['bottom', '下装', '格纹裙'],
  'string_bikini': ['swimwear', '泳装', '细绳比基尼'],
  'frilled_bikini': ['swimwear', '泳装', '褶边比基尼'],
  'side-tie_bikini_bottom': ['swimwear', '泳装', '侧系比基尼'],
  'playboy_bunny': ['clothing_type', '服装类型', '兔女郎装'],
  'strapless_leotard': ['clothing_type', '服装类型', '抹胸紧身衣'],
  'black_leotard': ['clothing_type', '服装类型', '黑色紧身衣'],
  'striped_clothes': ['cloth_mat', '材质花色', '条纹衣物'],
  'plaid_clothes': ['cloth_mat', '材质花色', '格纹衣物'],
  'floral_print': ['cloth_mat', '材质花色', '花朵印花'],
  'clothing_cutout': ['nsfw:cutout', '裁剪镂空', '衣物镂空'],
  // --- 头部/发型/发饰 ---
  'sidelocks': ['hairstyle', '发型', '鬓发'],
  'two_side_up': ['hairstyle', '发型', '双侧垂发'],
  'crossed_bangs': ['hairstyle', '发型', '刘海交叉'],
  'hair_intakes': ['hairstyle', '发型', '鬓角发束'],
  'floating_hair': ['hairstyle', '发型', '飘动头发'],
  'hair_flowing_over': ['hairstyle', '发型', '长发飘垂'],
  'low_twintails': ['hair_tie', '扎法', '低双马尾'],
  'single_braid': ['hair_tie', '扎法', '单麻花辫'],
  'single_side_bun': ['hair_tie', '扎法', '单侧发包'],
  'single_hair_bun': ['hair_tie', '扎法', '单发包'],
  'one_side_up': ['hair_tie', '扎法', '单侧扎发'],
  'x_hair_ornament': ['hair_acc', '发饰', 'X形发饰'],
  'butterfly_hair_ornament': ['hair_acc', '发饰', '蝴蝶发饰'],
  'scrunchie': ['hair_acc', '发饰', '布艺发圈'],
  'eyewear_on_head': ['eyewear', '眼镜', '头顶眼镜'],
  'hood': ['headwear', '头饰', '兜帽'],
  'black_hat': ['headwear', '头饰', '黑帽'],
  'white_hat': ['headwear', '头饰', '白帽'],
  'black_headwear': ['headwear', '头饰', '黑色头饰'],
  'white_headwear': ['headwear', '头饰', '白色头饰'],
  // --- 妆容/身体细节 ---
  'tattoo': ['feature', '非人特征', '纹身'],
  'piercing': ['feature', '非人特征', '穿孔饰品'],
  'mole_on_breast': ['feature', '非人特征', '胸痣'],
  'pregnant': ['feature', '非人特征', '怀孕'],
  'fingernails': ['body_part', '躯干', '手指甲'],
  'blue_nails': ['nails', '美甲', '蓝色美甲'],
  'black_nails': ['nails', '美甲', '黑色美甲'],
  'pink_nails': ['nails', '美甲', '粉色美甲'],
  'purple_nails': ['nails', '美甲', '紫色美甲'],
  'forehead': ['body_part', '躯干', '额头'],
  'midriff': ['body_part', '躯干', '露腰腹'],
  // --- 非人特征: 翅膀/尾巴/角/种族 ---
  'low_wings': ['wings', '翅膀', '低位翅膀'],
  'feathered_wings': ['wings', '翅膀', '羽翼'],
  'demon_wings': ['wings', '翅膀', '恶魔翼'],
  'angel_wings': ['wings', '翅膀', '天使翼'],
  'black_wings': ['wings', '翅膀', '黑翼'],
  'white_wings': ['wings', '翅膀', '白翼'],
  'cat_tail': ['tail', '尾巴', '猫尾'],
  'fox_tail': ['tail', '尾巴', '狐尾'],
  'rabbit_tail': ['tail', '尾巴', '兔尾'],
  'demon_tail': ['tail', '尾巴', '恶魔尾'],
  'fake_tail': ['tail', '尾巴', '假尾巴'],
  'black_horns': ['horn', '角', '黑角'],
  'extra_ears': ['feature', '非人特征', '额外耳朵'],
  'cat_girl': ['race', '种族特征', '猫娘'],
  'fox_girl': ['race', '种族特征', '狐娘'],
  'demon_girl': ['race', '种族特征', '魔族娘'],
  'elf': ['race', '种族特征', '精灵'],
  'faceless': ['feature', '非人特征', '无脸'],
  // --- 表情/嘴部/眼神 ---
  'one_eye_closed': ['emotion', '情绪', '眨单眼'],
  'trembling': ['emotion', '情绪', '颤抖'],
  'ahegao': ['emotion', '情绪', '阿黑颜'],
  ':o': ['emotion', '情绪', '惊讶张口'],
  'upper_teeth_only': ['mouth', '嘴部', '只露上牙'],
  'mouth_hold': ['mouth', '嘴部', '口衔物'],
  'bright_pupils': ['eyes_color', '瞳色', '亮瞳'],
  // --- 姿势/动作 ---
  'knees_up': ['pose', '姿势', '跪坐抬膝'],
  'knees_together_feet_apart': ['pose', '姿势', '膝并脚分'],
  'hand_up': ['pose', '姿势', '举手'],
  'feet_up': ['pose', '姿势', '双脚翘起'],
  'kneepits': ['pose', '姿势', '腘窝抱膝'],
  'presenting_foot': ['pose', '姿势', '抬脚展示'],
  'spread_toes': ['pose', '姿势', '张开脚趾'],
  'bent_over': ['pose_base', '基础姿势', '弯腰俯身'],
  'partially_submerged': ['water_state', '水中状态', '半身浸水'],
  'wading': ['water_state', '水中状态', '涉水'],
  'bathing': ['water_state', '水中状态', '入浴中'],
  // --- 机位/镜头/构图 ---
  'low_angle': ['camera_angle', '机位角度', '低机位'],
  'high_angle': ['camera_angle', '机位角度', '高机位'],
  'from_front': ['camera_angle', '机位角度', '正面视角'],
  'from_left': ['camera_angle', '机位角度', '左侧视角'],
  'from_right': ['camera_angle', '机位角度', '右侧视角'],
  'blurry_foreground': ['camera_fx', '镜头效果', '前景虚化'],
  'cross-section': ['meta', '元信息', '剖面视图'],
  'scenery': ['composition', '构图', '纯风景'],
  // --- 场景/环境/道具 ---
  'on_couch': ['furniture', '家具场景', '在沙发上'],
  'on_floor': ['furniture', '家具场景', '在地上'],
  'on_desk': ['furniture', '家具场景', '在桌上'],
  'on_chair': ['furniture', '家具场景', '在椅子上'],
  'school_desk': ['furniture', '家具场景', '课桌'],
  'cloudy_sky': ['weather', '天气氛围', '多云'],
  'horizon': ['environment', '环境', '地平线'],
  'sand': ['environment', '环境', '沙地'],
  'grass': ['environment', '环境', '草地'],
  'tiles': ['environment', '环境', '瓷砖'],
  'tile_floor': ['environment', '环境', '瓷砖地面'],
  'wooden_floor': ['environment', '环境', '木地板'],
  'building': ['environment', '环境', '建筑物'],
  'palm_tree': ['environment', '环境', '棕榈树'],
  'petals': ['prop', '环境道具', '花瓣'],
  'white_flower': ['prop', '环境道具', '白花'],
  'purple_flower': ['prop', '环境道具', '紫花'],
  'red_flower': ['prop', '环境道具', '红花'],
  'blue_flower': ['prop', '环境道具', '蓝花'],
  'potted_plant': ['prop', '环境道具', '盆栽'],
  'stuffed_toy': ['prop', '环境道具', '毛绒玩具'],
  'stuffed_animal': ['prop', '环境道具', '毛绒玩偶'],
  'lamp': ['prop', '环境道具', '灯具'],
  'cellphone': ['prop', '环境道具', '手机'],
  'smartphone': ['prop', '环境道具', '智能手机'],
  'holding_phone': ['prop', '持物动作', '持手机'],
  'bottle': ['prop', '环境道具', '瓶子'],
  'drinking_glass': ['prop', '环境道具', '玻璃杯'],
  'holding_cup': ['prop', '持物动作', '持杯'],
  'holding_food': ['prop', '持物动作', '持食物'],
  'weapon': ['prop', '环境道具', '武器'],
  'holding_weapon': ['prop', '持物动作', '持武器'],
  'bird': ['fauna', '动物', '鸟'],
  'bug': ['fauna', '动物', '虫'],
  'butterfly': ['fauna', '动物', '蝴蝶'],
  // --- 元信息 ---
  'highres': ['meta', '元信息', '高分辨率'],
  'ai-generated': ['meta', '元信息', 'AI 生成'],
  'signature': ['meta', '元信息', '签名'],
  // --- 人数/男角描述 ---
  '3girls': ['count', '人数构成', '三人女性'],
  'shota': ['n_male', '男角体型', '正太'],
  'loli': ['n_male', '男角体型', '萝莉'],
  'dark-skinned_male': ['n_male', '男角体型', '深肤色男'],
  'faceless_male': ['n_male', '男角体型', '无脸男'],
  // --- 鞋袜 ---
  'white_footwear': ['footwear', '鞋袜', '白鞋'],
  'unworn_shoes': ['footwear', '鞋袜', '未上脚鞋'],
  'single_shoe': ['footwear', '鞋袜', '单鞋'],
  // --- NSFW: 暴露/身体/行为 ---
  'sideboob': ['n_exposure', '暴露重点', '侧乳'],
  'underboob': ['n_exposure', '暴露重点', '下乳'],
  'areola_slip': ['n_exposure', '暴露重点', '乳晕滑出'],
  'covered_nipples': ['n_exposure', '暴露重点', '遮乳'],
  'partially_visible_vulva': ['n_exposure', '暴露重点', '私处半露'],
  'pantyshot': ['n_exposure', '暴露重点', '内裤走光'],
  'panty_pull': ['n_exposure', '暴露重点', '拉扯内裤'],
  'hanging_breasts': ['n_exposure', '暴露重点', '垂乳'],
  'covering_privates': ['censorship', '审查', '遮挡私处'],
  'between_breasts': ['n_pos', '互动姿势', '夹胸'],
  'breast_press': ['n_pos', '互动姿势', '乳压'],
  'm_legs': ['n_pos', '互动姿势', 'M 腿'],
  'cowgirl_position': ['n_pos', '互动姿势', '骑乘位'],
  'doggystyle': ['n_pos', '互动姿势', '后入位'],
  'groping': ['n_touch', '性接触', '猥亵'],
  "grabbing_another's_breast": ['n_touch', '性接触', '抓胸'],
  'grabbing_from_behind': ['n_touch', '性接触', '背后擒抱'],
  'happy_sex': ['n_sex', '性行为', '阴道性爱'],
  'rape': ['n_sex', '性行为', '强暴'],
  'oral': ['n_sex', '性行为', '口交'],
  'yuri': ['n_sex', '性行为', '百合'],
  'interracial': ['n_sex', '性行为', '跨种族'],
  'masturbation': ['n_sex', '性行为', '自慰'],
  'object_insertion': ['n_sex', '性行为', '插入异物'],
  'sex_toy': ['n_sex', '性行为', '性玩具'],
  'vibrator': ['n_sex', '性行为', '跳蛋'],
  'dildo': ['n_sex', '性行为', '假阳具'],
  'condom': ['n_sex', '性行为', '安全套'],
  'public_indecency': ['nsfw:fetish', '暴露情境', '公然猥亵'],
  'bdsm': ['n_bondage', '束缚', 'BDSM'],
  'bondage': ['n_bondage', '束缚', '捆绑'],
  'restrained': ['n_bondage', '束缚', '被束缚'],
  'bound': ['n_bondage', '束缚', '被绑'],
  'testicles': ['body_part', '躯干', '睾丸'],
  'veiny_penis': ['body_part', '躯干', '青筋阴茎'],
  'urethra': ['n_body', '私密细节', '尿道'],
  'colored_pubic_hair': ['n_body', '私密细节', '染色阴毛'],
  'facial': ['n_cum', '精液表现', '颜射'],
  'ejaculation': ['n_cum', '精液表现', '射精'],
  'cum_on_body': ['n_cum', '精液表现', '射在身上'],
  'cum_overflow': ['n_cum', '精液表现', '精液溢出'],
  'cumdrip': ['n_cum', '精液表现', '滴精'],
  'cum_on_legs': ['n_cum', '精液表现', '射在腿上'],
  'cum_on_hair': ['n_cum', '精液表现', '射在发上'],
  'after_vaginal': ['n_state', '状态', '事后'],
}
let e4n = 0
for (const [tag, [slot, fieldZh, zh]] of Object.entries(EXTRA_V3)) {
  if (byTag.has(tag)) continue
  byTag.set(tag, { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: null })
  byTag.set(tag.replace(/_/g, ' '), { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: null })
  e4n++
}
console.log(`词典v3 Top榜归槽: 新增 ${e4n} → 总 ${byTag.size}`)

// ---------- 2. tags.db 本地词表 ----------
// cat 列已有本项目的粗分类: general:人物/服饰/场景/环境/物品/画面/表情动作/镜头 + count/meta/other
// 词典策略: 粗分类(已有) 做第一层, ANIMA 字段槽位做第二层细化
const db = new DatabaseSync(path.join(REPO, 'data/tags.db'), { readOnly: true })
const rows = db.prepare("SELECT name, cnt, cat FROM tags WHERE kind='other' ORDER BY cnt DESC").all()
const classified = rows.filter(r => /^general:|^count$/.test(r.cat))
console.log(`本地词表: ${rows.length} 个 | 已粗分类: ${classified.length} | 未分类(other): ${rows.length - classified.length}`)

// ---------- 2b. 词典 v4: 尾词模式批量归槽 (2026-10-28) ----------
// 来源: 未归槽 136.6 万实例的分布统计 —— cnt>=20 的 5325 词占其中 98%+,
// 且大头是「颜色/花色 × 基础词」「部位 × 服饰」这类机械模式, 不值得逐个手写。
// 策略: 规则表按序首中(具体在前、泛化在后), 只碰 byTag 还没有的词 ——
// 前面 ANIMA/NSFW/手工批先到先得, v4 纯兜底。zh 优先取 WeiLin 内置翻译库,
// 缺了用「颜色zh + 基础词zh」拼, 再缺留空(UI 端会回落到翻译管线/英文原词)。
// ⚠️ SFW 槽的擦边词必须给 level(wedgie/dress_pull → 1): 变体端 SFW 池对
//    level=null 放行, 不给档位会在全年龄变体里漏出; NSFW 槽反而不用 ——
//    档位缺失按最严(4)处理, 天然安全。
const weiLin = (() => {
  try {
    const tdb = new DatabaseSync(path.join(REPO, 'assets/translations.db'), { readOnly: true })
    const m = new Map(tdb.prepare('SELECT en, zh FROM translations').all()
      .map((r) => [String(r.en).toLowerCase(), String(r.zh)]))
    tdb.close()
    return m
  } catch { return new Map() }
})()

// NSFW/擦边显式批(先于模式规则): 模式规则兜不住语义的, 在这里点名。
// NSFW 槽(n_bondage/n_exposure/n_touch)不给 level → 变体端按最严档, 全年龄零漏出;
// clothing_state/body_detail 是 SFW 槽, 擦边词必须写 level。
const V4_NSFW = {
  'rope': ['n_bondage', '束缚', '绳'],
  'frogtie': ['n_bondage', '束缚', '蛙式捆绑'],
  'bound_torso': ['n_bondage', '束缚', '绑上身'],
  'bound_legs': ['n_bondage', '束缚', '绑腿'],
  'crotch_rope': ['n_bondage', '束缚', '股绳', 2],
  'wiffle_gag': ['n_bondage', '束缚', '口塞球'],
  'panty_lift': ['clothing_state', '遮露状态', '拉内裤', 1],
  'wedgie': ['clothing_state', '遮露状态', '内裤拉扯', 1],
  'dress_pull': ['clothing_state', '遮露状态', '拉裙摆', 1],
  'dress_lift': ['clothing_state', '遮露状态', '撩裙', 1],
  'kimono_lift': ['clothing_state', '遮露状态', '撩和服', 1],
  'skirt_lift': ['clothing_state', '遮露状态', '撩裙', 1],
  'nude_cover': ['n_exposure', '裸露', '遮羞裸露', 1],
  'ass_visible_through_thighs': ['n_exposure', '裸露', '袜缝露臀', 1],
  'grabbing_own_breast': ['n_touch', '性接触', '自摸胸', 1],
  'butt_crack': ['body_detail', '身体细节', '臀缝', 1],
  'thick_eyebrows': ['body_detail', '身体细节', '粗眉'],
  'yokozuwari': ['pose', '姿势', '跪坐'],
  'knee_up': ['pose', '姿势', '抬膝'],
  'arms_behind_head': ['pose', '姿势', '双手枕后'],
  'arm_behind_head': ['pose', '姿势', '手臂枕后'],
  'leg_grab': ['interact', '持物动作', '抓腿'],
  'torso_grab': ['interact', '持物动作', '抓上身'],
  'absurdly_long_hair': ['hair_len', '发长', '极长发'],
  'goat_horns': ['horn', '角', '羊角'],
  'ear_piercing': ['accessory', '饰品', '耳钉'],
  'bandaid': ['accessory', '饰品', '创可贴'],
  'anklet': ['accessory', '饰品', '脚链'],
  'mask': ['headwear', '头饰', '面具'],
  'hat_flower': ['headwear', '头饰', '花帽'],
  'mechanical_halo': ['headwear', '头饰', '机械光环'],
  'white_wrist_cuffs': ['handwear', '手部服饰', '白腕套'],
  'shirt_tucked_in': ['cloth_state_sfw', '穿着方式', '塞衣角'],
  'fine_fabric_emphasis': ['cloth_mat', '材质', '布料质感强调'],
  'multicolored_clothes': ['clothing_type', '服装类型', '多色服装'],
  'waist_apron': ['clothing_type', '服装类型', '腰围裙'],
  'ass_focus': ['focus', '镜头焦点', '臀部焦点'],
  'cum_on_stomach': ['n_cum', '精液表现', '射在腹上'],
  'petite': ['figure', '体型', '娇小'],
  'nose_blush': ['emotion', '表情', '红鼻'],
  'skin_fang': ['feature', '非人特征', '皮肤獠牙'],
  ':q': ['expression', '表情', '嘟嘴'],
  'fruit': ['prop', '食物道具', '水果'],
  'head_on_pillow': ['furniture', '家具场景', '头枕枕头'],
  'star_(sky)': ['environment', '环境', '星空点点'],
  'moon': ['environment', '环境', '月亮'],
  'pool': ['environment', '环境', '泳池'],
  'panties_around_one_leg': ['underwear', '内衣层', '内裤褪至单腿', 1],
  'id_card': ['prop', '道具', '证件卡'],
  'goggles': ['eyewear', '眼镜', '护目镜'],
  'goggles_on_head': ['eyewear', '眼镜', '护目镜(头顶)'],
  'aviator_sunglasses': ['eyewear', '眼镜', '蛤蟆镜'],
  'sunglasses': ['eyewear', '眼镜', '太阳镜'],
  'sun': ['environment', '环境', '太阳'],
  'summer': ['environment', '环境', '夏天'],
  'round_window': ['environment', '环境', '圆窗'],
  'window_blinds': ['environment', '环境', '百叶窗'],
  'sliding_doors': ['environment', '环境', '拉门'],
  'loaded_interior': ['background', '背景', '复杂室内背景'],
  'room': ['location', '场所', '房间'],
  'rock': ['prop', '道具', '石头'],
  'logo': ['meta', '元信息', '标志'],
  'pornography': ['meta', '元信息', '色情刊物'],
  'drinking_straw': ['prop', '餐饮道具', '吸管'],
  'drink': ['prop', '餐饮道具', '饮料'],
  'spoon': ['prop', '餐饮道具', '勺子'],
  'can': ['prop', '餐饮道具', '罐装饮料'],
  'energy_drink': ['prop', '餐饮道具', '能量饮料'],
  'monster_energy': ['prop', '餐饮道具', '魔爪饮料'],
  'nissin_cup_noodle': ['prop', '餐饮道具', '日清杯面'],
  'choko_(cup)': ['prop', '餐饮道具', '酒杯'],
  'tokkuri': ['prop', '道具', '清酒壶'],
  'shide': ['prop', '道具', '纸垂'],
  'kadomatsu': ['prop', '道具', '门松'],
  'kagami_mochi': ['prop', '道具', '镜饼'],
  'teruterubouzu': ['prop', '道具', '晴天娃娃'],
  'bamboo': ['prop', '道具', '竹子'],
  'book_stack': ['prop', '道具', '书堆'],
  'sword': ['prop', '武器道具', '剑'],
  'fishing_rod': ['prop', '道具', '钓鱼竿'],
  'shovel': ['prop', '道具', '铲子'],
  'selfie_stick': ['prop', '道具', '自拍杆'],
  'globe': ['prop', '道具', '地球仪'],
  'stylus': ['prop', '道具', '触控笔'],
  'sticky_note': ['prop', '道具', '便利贴'],
  'fish_tank': ['prop', '道具', '鱼缸'],
  'sand_castle': ['prop', '海滩道具', '沙堡'],
  'sand_sculpture': ['prop', '海滩道具', '沙雕'],
  'american_flag': ['prop', '道具', '美国国旗'],
  'italian_flag': ['prop', '道具', '意大利国旗'],
  'swim_ring': ['prop', '泳具道具', '游泳圈'],
  'innertube': ['prop', '泳具道具', '泳圈'],
  'snorkel': ['prop', '泳具道具', '呼吸管'],
  'picnic_basket': ['prop', '道具', '野餐篮'],
  'sunscreen': ['prop', '道具', '防晒霜'],
  'shade': ['prop', '道具', '遮阳伞'],
  'wet_towel': ['prop', '道具', '湿毛巾'],
  'towel_on_head': ['headwear', '头饰', '顶毛巾'],
  'ball': ['prop', '运动道具', '球'],
  'food_in_mouth': ['mouth', '嘴部', '含食'],
  ';d': ['expression', '表情', '眨眼笑'],
  'drunk': ['emotion', '表情', '醉态'],
  'back-to-back': ['pose', '姿势', '背靠背'],
  'arm_across_waist': ['pose', '姿势', '手臂环腰'],
  'hand_on_leg': ['pose', '姿势', '手放腿上'],
  'braided_bun': ['hairstyle', '发型', '辫子盘头'],
  'cow_ears': ['feature', '非人特征', '牛耳'],
  'cow_horns': ['horn', '角', '牛角'],
  'cow_tail': ['tail', '尾部', '牛尾'],
  'cow_girl': ['race', '种族', '牛娘'],
  'kitsune': ['race', '种族', '狐娘'],
  'kyuubi': ['race', '种族', '九尾狐'],
  // NSFW 露骨/擦边显式批二(unknown 启发正则会兜变体端, 但词典归槽才是正道)
  'spreading_own_pussy': ['n_exposure', '裸露', '自掰'],
  'half-spread_pussy': ['n_exposure', '裸露', '半张开'],
  'spread_pussy': ['n_exposure', '裸露', '张开'],
  'pussy_juice_trail': ['n_body', '私密细节', '爱液痕'],
  'pussy_focus': ['n_exposure', '裸露', '私部焦点'],
  'disembodied_penis': ['n_body', '私密细节', '悬空阴茎'],
  'invisible_penis': ['n_body', '私密细节', '隐形阴茎'],
  'anal_object_insertion': ['n_sex', '性行为', '物插入'],
  'anal_tail': ['n_state', '状态', '肛塞尾'],
  'chocolate_on_breasts': ['n_state', '状态', '巧克力涂胸', 1],
  'chocolate_on_body': ['n_state', '状态', '巧克力涂身', 1],
  'chocolate_on_face': ['n_state', '状态', '巧克力涂脸', 1],
  'heart-shaped_chocolate': ['prop', '食物道具', '心形巧克力'],
  'oppai_loli': ['n_male', '年龄体型', '巨乳萝莉'],
  'bodypaint': ['n_body', '私密细节', '人体彩绘'],
  // 人物/身体/发型高频
  'eyes_visible_through_hair': ['hairstyle', '发型', '发透眼'],
  'one_eye_covered': ['hairstyle', '发型', '单眼遮发'],
  'hair_ears': ['hairstyle', '发型', '发做耳形'],
  'feather_hair': ['hairstyle', '发型', '羽毛发饰'],
  'split-color_hair': ['hair_color', '发色', '分色发'],
  'mole_under_mouth': ['body_detail', '身体细节', '嘴下痣'],
  'perky_breasts': ['body_detail', '身体细节', '挺乳'],
  'flat_ass': ['body_detail', '身体细节', '平臀'],
  'skinny': ['figure', '体型', '骨感'],
  'tan': ['skin', '肤色', '小麦色'],
  'dark-skinned_female': ['skin', '肤色', '深色肌肤'],
  'teacher': ['identity', '身份', '教师'],
  'astronaut': ['identity', '身份', '宇航员'],
  'toe_ring': ['accessory', '饰品', '脚趾环'],
  'button_eyes': ['eyes_color', '眼色', '扣子眼'],
  'heart-shaped_eyes': ['emotion', '表情', '心形眼'],
  'low_neckline': ['cloth_state_sfw', '穿着方式', '低领口'],
  'wrong_foot': ['cloth_state_sfw', '穿着方式', '鞋穿反脚'],
  'folded': ['cloth_state_sfw', '穿着方式', '叠放'],
  'horn_flower': ['headwear', '头饰', '角上花'],
  // other 类高频杂词
  'okobo': ['footwear', '鞋袜', '厚木屐'],
  'sakazuki': ['prop', '餐饮道具', '酒盏'],
  'christmas_present': ['prop', '道具', '圣诞礼物'],
  'cage': ['prop', '道具', '笼子'],
  'rug': ['furniture', '家具场景', '地毯'],
  'veranda': ['location', '场所', '外廊'],
  'porch': ['location', '场所', '门廊'],
  'stone_lantern': ['prop', '道具', '石灯笼'],
  'multiple_torii': ['prop', '道具', '连排鸟居'],
  'under_tree': ['location', '场所', '树下'],
  'against_tree': ['location', '场所', '靠树'],
  'tree_stump': ['prop', '道具', '树桩'],
  'midair': ['location', '场所', '半空'],
  'flight_deck': ['location', '场所', '飞行甲板'],
  'jar': ['prop', '道具', '罐子'],
  ':t': ['expression', '表情', '吐舌'],
  'dated': ['meta', '元信息', '日期水印'],
  'cable_knit': ['cloth_mat', '材质', '麻花针织'],
  'coconut': ['prop', '食物道具', '椰子'],
  // other 类 NSFW 收口(不给 level = 变体端按最严, 全年龄零漏出)
  'female_masturbation': ['n_sex', '性行为', '自慰'],
  'defloration': ['n_sex', '性行为', '破处'],
  'sexual_coaching': ['n_sex', '性行为', '性指导'],
  'vaginal_object_insertion': ['n_sex', '性行为', '物插入(阴)'],
  'futa_with_female': ['n_sex', '性行为', '扶她×女'],
  'reach-around': ['n_touch', '性接触', '手交(后)'],
  'pee': ['n_body', '私密细节', '排尿'],
  'ovum': ['n_body', '私密细节', '卵子'],
  'nudist': ['n_exposure', '裸露', '裸体主义'],
  'gagged': ['n_bondage', '束缚', '被塞口'],
  'hogtie': ['n_bondage', '束缚', '四肢捆绑'],
  'gag_harness': ['n_bondage', '束缚', '口枷具'],
  'shibari_over_clothes': ['n_bondage', '束缚', '衣上紧缚'],
  'bra_lift': ['clothing_state', '遮露状态', '撩胸罩', 1],
  'pantyhose_pull': ['clothing_state', '遮露状态', '拉连裤袜', 1],
  'dilation_tape': ['n_state', '状态', '扩拉胶带'],
  'bisexual_female': ['n_state', '状态', '双性恋(女)'],
  'breath': ['n_state', '状态', '呼气', 1],
  'heavy_breathing': ['n_state', '状态', '喘息'],
  // other 类 SFW 收口
  'rabbit_girl': ['race', '种族', '兔娘'],
  'meadow': ['environment', '环境', '草地'],
  'wet_floor': ['environment', '环境', '湿地反光'],
  'column': ['environment', '环境', '柱子'],
  'reflective_floor': ['environment', '环境', '反光地板'],
  'earth_(planet)': ['environment', '环境', '地球'],
  'contrail': ['graphic', '画面元素', '航迹云'],
  'spoken_question_mark': ['graphic', '画面元素', '对话问号'],
  'graffiti': ['graphic', '画面元素', '涂鸦'],
  'feathers': ['prop', '花羽道具', '羽毛'],
  'white_feathers': ['prop', '花羽道具', '白羽毛'],
  'rose_petals': ['prop', '花羽道具', '玫瑰花瓣'],
  'plum_blossoms': ['prop', '花羽道具', '梅花'],
  'petals_on_liquid': ['prop', '花羽道具', '水面花瓣'],
  'yellow_flower': ['prop', '花羽道具', '黄花'],
  'dove': ['animal', '动物', '鸽子'],
  'white_bird': ['animal', '动物', '白鸟'],
  'light_bulb': ['prop', '道具', '灯泡'],
  'electrical_outlet': ['prop', '道具', '电源插座'],
  'aircraft': ['prop', '载具道具', '飞行器'],
  'airplane': ['prop', '载具道具', '客机'],
  'keyhole': ['prop', '道具', '钥匙孔'],
  'ai_ai_gasa': ['prop', '道具', '相合伞'],
  'drink_can': ['prop', '餐饮道具', '罐装饮料'],
  'strawberry': ['prop', '食物道具', '草莓'],
  'one-piece_thong': ['outfit', '整套服装', '连体丁字裤'],
  'bride': ['identity', '身份', '新娘'],
  'material_growth': ['meta', '元信息', '材质溢出(AI瑕疵)'],
  '3d': ['meta', '元信息', '3D'],
  'patreon_username': ['meta', '元信息', '赞助者水印'],
  'copyright_name': ['meta', '元信息', '版权署名'],
  'product_placement': ['meta', '元信息', '商品植入'],
}
let v4NsfwN = 0
for (const [tag, [slot, fieldZh, zh, level]] of Object.entries(V4_NSFW)) {
  if (byTag.has(tag)) continue
  byTag.set(tag, { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null })
  byTag.set(tag.replace(/_/g, ' '), { slot, fieldZh, sec: 'extra', secZh: '高频补充', zh, level: level ?? null })
  v4NsfwN++
}

// 模式规则表: [整词正则, slot, fieldZh, level?] —— 按序首中, 越具体越靠前。
// 槽位键全部复用既有命名空间(变体端 SEG 排序/过滤组 keepOne 直接认识),
// 新开的 animal/print/electronics 只影响光箱分组小节, 变体端按 unknown 保留(安全)。
const V4_RULES = [
  [/^(?:[2-9]\d?|6\+)(?:girls|boys)$/, 'count', '人数'],
  [/(?:^|_)(?:volleyball|beachball|soccer_ball|basketball|tennis_ball)$/, 'prop', '运动道具'],
  [/^(?:cat|dog|fish|bird|seagull|chick|crab|rabbit|mouse|frog|bat|fox|wolf|bear|butterfly|animal|mushroom|horse|pig|sheep|deer|monkey|hamster|penguin)$/, 'animal', '动物'],
  [/(?:^|_)(?:bikini|one[-_]piece_swimsuit|swimsuit|costume|uniform)$/, 'outfit', '整套服装'],
  [/(?:^|_)(?:dress|gown|sundress|kimono)$/, 'outfit', '整套服装'],
  [/(?:^|_)(?:cap|hat|helmet|headdress|headgear|headband|headphones|earmuffs|crown|tiara|diadem|beret|bonnet|veil|halo|beanie)$/, 'headwear', '头饰'],
  [/^(?:cap|hat|headwear)_/, 'headwear', '头饰'],
  [/^hair(?:_ornament|_flower|_bow|_ribbon|_clip|_pin|clip|band|_band)$/, 'headwear', '头饰'],
  [/(?:^|_)headwear$/, 'headwear', '头饰'],
  [/(?:^|_)eyewear$/, 'eyewear', '眼镜'],
  [/(?:^|_)(?:footwear|boots|shoes|sandals|sneakers|pumps|loafers|slippers|tabi)$/, 'footwear', '鞋袜'],
  [/(?:^|_)(?:gloves|mittens)$/, 'handwear', '手部服饰'],
  [/(?:^|_)wrist_/, 'handwear', '手部服饰'],
  [/(?:^|_)(?:thighhighs|pantyhose|kneehighs|stockings|socks|legwarmers|leggings|tights|legwear|garter)$/, 'legwear', '腿袜'],
  [/(?:^|_)(?:pants|skirt|shorts|trousers)$/, 'bottom', '下装'],
  [/(?:^|_)(?:shirt|blouse|jacket|coat|hoodie|sweater|cardigan|vest|leotard|bodysuit|capelet|shawl|poncho)$/, 'top', '上装外套'],
  [/(?:^|_)sleeves$/, 'sleeves', '袖长'],
  [/(?:^|_)(?:panties|bra|underwear|lingerie)$/, 'underwear', '内衣层', 1],
  [/(?:^|_)(?:earrings|necklace|choker|necktie|neckerchief|bowtie|ribbon|brooch|pendant|amulet|whistle|o-ring|magatama|collar|belt|scrunchie)$/, 'accessory', '饰品'],
  [/(?:^|_)around_neck$/, 'accessory', '饰品'],
  [/(?:^|_)(?:cross|anchor|star)$/, 'accessory', '饰品'],
  [/(?:^|_)(?:braid|twintails|ponytail|ahoge|sidelocks|ringlets|antenna_hair|bangs)$/, 'hairstyle', '发型'],
  [/(?:^|_)ears$/, 'feature', '非人特征'],
  [/(?:^|_)tail$/, 'tail', '尾部'],
  [/(?:^|_)horns?$/, 'horn', '角'],
  [/(?:^|_)(?:sword|katana|knife|axe|spear)$/, 'prop', '武器道具'],
  [/(?:^|_)flag$/, 'prop', '旗帜道具'],
  [/(?:^|_)?(?:paper|papers|pen|quill|chalk|scroll)$/, 'prop', '文具纸张'],
  [/(?:^|_)flower$/, 'prop', '花羽道具'],
  [/^hair_over_(?:one_)?breast[s]?$/, 'hairstyle', '发型'],
  [/(?:^|_)(?:bun|braided_bun)$/, 'hairstyle', '发型'],
  [/(?:^|_)nails$/, 'nails', '美甲'],
  [/(?:^|_)pupils$/, 'eyes_color', '眼色'],
  [/(?:^|_)background$/, 'background', '背景'],
  [/(?:^|_)(?:censoring|censor)$/, 'censorship', '审查'],
  [/(?:^|_)(?:chair|stool|couch|sofa|table|desk|bench|tatami|shelf)$/, 'furniture', '家具场景'],
  [/(?:^|_)(?:lamp|light)$/, 'lighting', '光照'],
  // 餐饮器具用「词尾」匹配(不带 ^|_ 前缀要求) —— teacup/drink 这类连写复合词才吃得到
  [/(?:cup|bottle|teapot|mug|tray|saucer|bowl|plate|spoon|straw)$/, 'prop', '餐饮道具'],
  [/(?:^|_)box$/, 'prop', '箱盒道具'],
  [/^stuffed_|^plush_/, 'prop', '玩偶道具'],
  [/^inflatable_/, 'prop', '充气道具'],
  [/^beach_/, 'prop', '海滩道具'],
  [/^(?:figure|figurine)$/, 'prop', '手办道具'],
  [/(?:^|_)(?:computer|laptop|monitor|keyboard|tablet|controller|speaker|headset|clock|console|television|radio|tv|mouse)$/, 'electronics', '电子设备'],
  [/(?:^|_)(?:sake|cola|alcohol|wine|tea|coffee|watermelon|burger|sandwich|pizza|pocky)$/, 'prop', '食物道具'],
  [/(?:^|_)(?:valentine|easter|halloween)$/, 'weather', '节令天气'],
  [/(?:bubbles|bubble)$/, 'graphic', '画面元素'],
  [/^holding_|^hugging_/, 'interact', '持物动作'],
  [/^hand_on_own_/, 'pose', '姿势'],
  [/(?:^|_)(?:christmas|new_year|halloween|snowing|snowflakes|fireworks|hanabi)$/, 'weather', '节令天气'],
  [/(?:^|_)print$/, 'print', '印花'],
  [/\(symbol\)$/, 'graphic', '画面元素'],
  [/^light_(?:particles|rays)$/, 'graphic', '画面元素'],
  [/\(object\)$/, 'prop', '道具'],
  [/(?:^|_)bathing$/, 'location', '场所'],
]
const V4_MIN_CNT = 10
let v4New = 0, v4Skipped = 0
for (const r of rows) {
  if (r.cnt < V4_MIN_CNT || byTag.has(r.name)) continue
  let hit = null
  for (const [re, slot, fieldZh, level] of V4_RULES) {
    if (re.test(r.name)) { hit = { slot, fieldZh, level: level ?? null }; break }
  }
  if (!hit) { v4Skipped++; continue }
  // zh 三级回落: WeiLin → 颜色前缀拼词 → 空串
  let zh = weiLin.get(r.name) || ''
  if (!zh) {
    const m = r.name.match(/^(black|white|red|blue|aqua|grey|gray|brown|green|orange|pink|purple|yellow)_(.+)$/)
    const base = m && byTag.get(m[2])
    if (base?.zh) zh = { black: '黑', white: '白', red: '红', blue: '蓝', aqua: '水色', grey: '灰', gray: '灰', brown: '棕', green: '绿', orange: '橙', pink: '粉', purple: '紫', yellow: '黄' }[m[1]] + base.zh
  }
  const rec = { slot: hit.slot, fieldZh: hit.fieldZh, sec: 'extra', secZh: '高频补充', zh, level: hit.level }
  byTag.set(r.name, rec)
  byTag.set(r.name.replace(/_/g, ' '), rec)
  v4New++
}
console.log(`词典v4 模式归槽: 显式批 ${v4NsfwN} + 规则命中 ${v4New} (cnt>=${V4_MIN_CNT}, 规则未覆盖 ${v4Skipped} 个留给长尾) → 总 ${byTag.size}`)

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
// v3 起落盘改为「byTag ∩ 本地全词表」: 不再要求 cat 是 general:*/count,
// 否则 cat='other' 的 4540 个未粗分类词(如 wet/sidelocks/cowgirl_position)
// 即使手工归了槽也写不出去; cat 仍由 tags.db 管, 词典只管槽位细化
const localNames = new Set(db.prepare('SELECT name FROM tags').all().map((r) => r.name))
const out = {}
for (const [tag, rec0] of byTag) {
  if (!localNames.has(tag)) continue
  // socks(ANIMA「腿上」)与 legwear 是同一语义类, 落盘统一归 legwear:
  // 否则跨槽 keep-one(white_socks×black_thighhighs)管不到, 变体端会同时抽出两槽词
  const rec = rec0.slot === 'socks' ? { ...rec0, slot: 'legwear' } : rec0
  if (!out[tag]) out[tag] = { slot: rec.slot, fieldZh: rec.fieldZh, sec: rec.sec, secZh: rec.secZh, zh: rec.zh, level: rec.level }
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
