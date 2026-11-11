/**
 * 安全模式 —— 按标签**等级**(0-4)隐藏内容
 * ====================================
 * **为什么按"标签集合"判, 而不是按 rating 字段**: 实测用户库里 `rating_*`
 * 标记 **0 张** —— WD14 反推模型(PixAI v0.9)不输出 danbooru 那套 rating 分类,
 * txt 时代也没写过。所以唯一可用的判据就是标签本身, 而"哪些标签算敏感、算几级"
 * 是个**口味问题**, 必须可编辑 —— 所以集合落在文本文件里, 不写死在代码里。
 *
 * 2026-10-28 等级统一(原 core/edge 两档 -> ANIMA 0-4 单一标尺):
 *   每个标签一个档位 0-4, 与 knowledge/tag_slots.json 的 level 同一把尺:
 *     L0 常规 / L1 擦边 / L2 明显暗示 / L3 露骨 / L4 极端
 *   一张图的 unsafe = 它所有标签的**最高档**; 展示层选一个"显示上限" maxLevel,
 *   unsafe > maxLevel 的图隐藏(不安全模式取反)。
 *
 * 档位来源(从高优先到低):
 *   1. safety_tags.txt 覆盖段 [L0]..[L4](用户手工维护, 支持 * 通配)
 *   2. 槽位词典 level 字段; NSFW 槽无 level 的按 4, 其余无 level 按 0
 * 旧 [core]/[edge] 文件首次读取时自动迁移改写: core->L4, edge->L2。
 *
 * 落地方式与 `rules.js` 的三件套一致:
 *   dataDir/safety_tags.txt   分段集合([L0]..[L4]), # 注释, 支持 * 通配
 *   dataDir/safety.json       { on, maxLevel, mode } —— **默认关闭**
 * 全部带 mtime 缓存: 在编辑器里改了文件, 下次读取自动生效, 不用重启。
 *
 * **只做展示层过滤**: 库里的 image 行一行不动, 统计数字也不重算 ——
 * 开关一关立刻全回来。
 *
 * 判定结果在**读数据集时**算一次(record.unsafe = 0..4), 前端只做数值比较,
 * 于是切换开关/档位**不需要重载数据集**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataFile } from './workspace.js'
import { BUNDLED_KNOWLEDGE_DIR } from './paths.js'

const TAGS_NAME = 'safety_tags.txt'
const STATE_NAME = 'safety.json'
const SECS = ['L0', 'L1', 'L2', 'L3', 'L4']

/** 默认 L4 段: 明确的裸露 / 性行为(旧 core 段) */
export const DEFAULT_CORE = [
  'nude', 'completely_nude', 'nipples', 'pussy', 'penis', 'sex', 'vaginal', 'anal',
  'cum', 'cum_in_pussy', 'anus', 'pussy_juice', 'bottomless', 'topless',
  'spread_pussy', 'areola_slip', 'masturbation', 'fellatio', 'orgasm',
]

/** 默认 L2 段(旧 edge 段): 擦边 / 内衣 / 打码标记 */
export const DEFAULT_EDGE = [
  'underwear', 'panties', 'no_panties', 'underwear_only', 'breasts_out',
  'cleavage', 'ass', 'thighhighs', 'swimsuit', 'bikini', 'lingerie',
  'bondage', 'sex_toy', 'pubic_hair', 'nipple_slip', 'covered_nipples',
  'censored', 'mosaic_censoring', 'uncensored',
]

/**
 * 内置兜底档位表(2026-11-11): 槽位词典没收、词表也没写的**毫无争议**敏感词。
 * ---------------------------------------------------------------
 * 起因(用户实测): 「≤L0 导出」漏出 small_penis / group_sex / imminent_vaginal
 * 这批 —— 它们在槽位表里要么词条缺失, 要么挂在 count/body_part 槽且
 * level=null(被刻意不收: "画里有胸≠暴露"的展示口径), levelOfTag 兜底 0 =
 * 常规, L0 阈值自然拦不住。摸底 80 个常见 danbooru NSFW 词, 当时 39 个漏。
 * 这里只收**语义上不可能中性**的词; 刻度对齐既有数据
 * (sex=3 / threesome=4 / nude·nipples=2 / panties=1)。
 * 与 safety_tags.txt 的关系: 覆盖段**永远优先**(levelOfTag 先查段再查这张表),
 * 用户写 [L0] 可以把其中任何词强行拉回常规。
 */
const BUILTIN_FLOOR = {
  /* L1 擦边 */
  bow_bikini: 1, shared_bathing: 1, bath: 1,
  /* 精确键压过 sex 词根误伤(mixed-sex 里的 sex 不是性行为) */
  'mixed-sex_bathing': 1, 'same-sex_bathing': 1,
  apron: 1, waist_apron: 1, white_apron: 1, maid_apron: 1, frilled_apron: 1,
  bodystocking: 1, torn_bodystocking: 1, sexy: 1,
  /* L2 明显暗示(与 nude / see-through 同级) */
  naked: 2, nude_filter: 2, nude_insert: 2,
  'see-through_legwear': 2, see_through_legwear: 2,
  erect_nipples: 2, puffy_nipples: 2,
  /* breasts 一族**刻意不算敏感**(2026-11-11 定案, 不许再改回去):
   * 它是体型描述, 命中 93% 的图 —— 收进敏感集等于把整个库藏起来。
   * 判断"露不露"看的是 nipples / topless / exposure 那些词, 不是胸围描述。 */
  /* 「扒开/没穿/透出」族 —— 比裸泳装(1)更露一级(2026-11-11 实测 L0 导出漏出) */
  bikini_bottom_aside: 2, bikini_top_lift: 2, bikini_under_clothes: 2,
  bikini_under_shorts: 2, unworn_bikini: 2, unworn_bikini_top: 2, unworn_bikini_bottom: 2,
  swimsuit_aside: 2, bra_lift: 2, bra_peek: 2, bra_visible_through_clothes: 2,
  panty_lift: 2, pantyhose_pull: 2, apron_lift: 2, male_underwear_pull: 2, male_underwear_peek: 2,
  /* naked_x = 只穿一件开襟衣物, 接近全裸(nude 同级) */
  naked_apron: 2, naked_shirt: 2, naked_jacket: 2, naked_kimono: 2, naked_towel: 2,
  naked_coat: 2, naked_hoodie: 2, naked_capelet: 2, naked_cape: 2, naked_sweater: 2,
  naked_ribbon: 2, naked_bandage: 2, naked_sheet: 2, naked_scarf: 2, naked_skirt: 2,
  naked_cloak: 2, naked_shoes: 2, naked_overalls: 2, naked_tabard: 2, nearly_naked_apron: 2,
  /* 暴露/暗示/审查标记 */
  clothed_male_nude_female: 2, clothed_female_nude_female: 2, clothed_male_nude_male: 2,
  topless: 2, topless_female: 2, topless_male: 2, bottomless: 2,
  assisted_exposure: 2, accidental_exposure: 2, underarms_exposed: 2,
  sexually_suggestive: 2, implied_sex: 2, implied_after_sex: 2, implied_fellatio: 2,
  implied_anal: 2, implied_masturbation: 2, implied_pregnancy: 2, pregnancy_test: 2,
  holding_pregnancy_test: 2,
  pubic_tattoo: 2, nippleless_clothes: 2, lewd: 2, erotic: 2,
  /* 词根规则盖不住的零散组合(2026-11-11 实测漏词) */
  panty_peek: 2, 'side-tie_peek': 2, pelvic_curtain_lift: 2, chest_lifted: 2,
  knees_pulled_to_the_shoulders: 2, exhibitionism: 2, voyeurism: 2,
  implied_futanari: 2, ahegao: 2, lifted_by_self: 2, smelling_clothes: 2,
  midriff_peek: 1,
  /* L3 露骨(与 sex / vaginal 同级) */
  small_penis: 3, erect_penis: 3, huge_penis: 3, penile: 3,
  testicles: 3, balls: 3, vulva: 3, labia: 3,
  penetration: 3, imminent_penetration: 3, imminent_vaginal: 3,
  imminent_fellatio: 3, just_the_tip: 3, titjob: 3, fellatio_invitation: 3,
  doggy_style: 3, doggystyle: 3, cowgirl_position: 3, plugged: 3, precum: 3,
  'onee-shota': 3, onee_shota: 3, lolicon: 3,
  crotchless_pants: 3,
  /* L4 极端(与 threesome / gangbang 同级) */
  group_sex: 4, orgy: 4, cum_on_face: 4, bestiality: 4, incest: 4,
  watersport: 4, golden_shower: 4, scat: 4, egg_laying: 4, birth: 4,
}

/**
 * 内置词根规则(2026-11-11 查漏补缺): 精确键列不过来的**变体大军**用词边界正则兜。
 * 起因: 用户给的 10 万行「L0 导出」实测里, bikini/swimsuit 有 40+ 变体
 * (string/frilled/side-tie/one-piece/highleg...), cum/penis/pussy/nipple 也有几十个
 * 组合词 —— 逐个列键既写不完也防不住新词。
 * 口径 = 词边界命中(下划线/串首尾为界), 刻度对齐既有数据:
 *   cum 族=3(cum 本体) / penis·pussy·nipple·testicle·erection 族=2(本体同级)
 *   bikini·swimsuit·panties·bra·underwear·fishnet·onsen·bathing 族=1(panties=1)
 * ⚠️ 正则都带词边界, cumulus/cumulonimbus/analog 这类前缀误伤不命中。
 * 优先级: 用户覆盖段 > 精确 dict(含 BUILTIN_FLOOR) > 这里的词根规则。
 */
const BUILTIN_WORD_RULES = [
  [/(?:^|_)censor(?:s|ed|ing)?(?=$|[_-])/, 2],                           // bar_censor/uncensored/mosaic_censoring...
  [/(?:^|_)cum(?:shot|_shot)?(?=$|[_-])/, 3],                            // cum_on_x/internal_cumshot/projectile_cum
  [/(?:^|_)ejaculat(?:e|ing|ion)(?=$|[_-])/, 3],                         // female_ejaculation/handsfree_ejaculation
  [/(?:^|_)orgasm(?=$|[_-])/, 3], [/(?:^|_)penetrat(?:e|ed|ion)(?=$|[_-])/, 3],
  [/(?:^|_)fellatio(?=$|[_-])/, 3], [/(?:^|_)anal(?=$|[_-])/, 3], [/(?:^|_)raped?(?=$|[_-])/, 3],
  [/(?:^|_)molest(?:e|ed|ion|ation)(?=$|[_-])/, 3], [/(?:^|_)tentacle(?:s)?(?=$|[_-])/, 3],
  [/(?:^|_)incest(?=$|[_-])/, 3], [/(?:^|_)shota(?=$|[_-])/, 3], [/(?:^|_)inflation(?=$|[_-])/, 3],
  [/(?:^|_)pussyjob(?=$|[_-])/, 3], [/(?:^|_)cumdump(?=$|[_-])/, 3],
  [/(?:^|_)sex(?=$|[_-])/, 3],                                           // thigh_sex/stealth_sex/armpit_sex
  [/(?:^|_)anus(?=$|[_-])/, 3], [/(?:^|_)labia(?=$|[_-])/, 3], [/(?:^|_)vulva(?=$|[_-])/, 3], [/(?:^|_)vagina(?=$|[_-])/, 3],
  [/(?:^|_)threesome(?=$|[_-])/, 4], [/(?:^|_)futanari(?=$|[_-])/, 3], [/(?:^|_)hump(?:ing)?(?=$|[_-])/, 3],
  [/(?:^|_)penis(?:es)?(?=$|[_-])/, 2], [/(?:^|_)pussy(?=$|[_-])/, 2], [/(?:^|_)clitor(?:is|al)?(?=$|[_-])/, 2],
  [/(?:^|_)testicle(?:s)?(?=$|[_-])/, 2], [/(?:^|_)erection(?=$|[_-])/, 2], [/(?:^|_)half-erect(?=$|[_-])/, 2],
  [/(?:^|_)nipple(?:s)?(?=$|[_-])/, 2], [/(?:^|_)areola(?:e)?(?=$|[_-])/, 2],
  [/(?:^|_)masturbat(?:e|ion)(?=$|[_-])/, 2], [/(?:^|_)handjob(?=$|[_-])/, 2], [/(?:^|_)titjob(?=$|[_-])/, 2], [/(?:^|_)paizuri(?=$|[_-])/, 2],
  [/(?:^|_)vibrator(?=$|[_-])/, 2], [/(?:^|_)dildo(?=$|[_-])/, 2], [/(?:^|_)sex_toy(?=$|[_-])/, 2],
  [/(?:^|_)pubic(?:_hair|_tattoo|_stubble)?(?=$|[_-])/, 2],
  [/(?:^|_)naked(?=$|[_-])/, 2], [/(?:^|_)nude(?=$|[_-])/, 2], [/(?:^|_)precum(?=$|[_-])/, 2],
  [/(?:^|_)peeing(?=$|[_-])/, 2], [/(?:^|_)urinat(?:e|ing|ion)(?=$|[_-])/, 2], [/(?:^|_)scat(?=$|[_-])/, 2],
  [/(?:^|_)bound(?=$|[_-])/, 3], [/(?:^|_)gag(?=$|[_-])/, 3], [/(?:^|_)blindfold(?=$|[_-])/, 2],
  [/(?:^|_)unworn(?=$|[_-])/, 2], [/(?:^|_)crotch(?=$|[_-])/, 2], [/(?:^|_)aroused(?=$|[_-])/, 2],
  [/(?:^|_)porn(?:ography)?(?=$|[_-])/, 2],
  /* 掀衣/扒衣动作族(x_aside/x_lift/x_pull/x_peek) —— 只认衣物词根, hair_lift/leg_lift
   * /zipper_pull_tab/wind_lift 这类中性组合不命中 */
  [/(?:clothing|clothes|kimono|leotard|sweater|shirt|shorts|strap|camisole|hoodie|jacket|thighhighs|buruma|thong|vest|sock|glove|fabric|babydoll)(?=_(?:aside|lift|pull|peek))/, 2],
  /* 动作在前、衣物在尾的变体: lifting_own_clothes / lifting_another's_clothes */
  [/lift(?:ing|ed)_(?:own_|her_|another'?s_)?(?:clothes|clothing|skirt|dress)(?=$|[_-])/, 2],
  [/(?:^|_)bikini(?=$|[_-])/, 1], [/(?:^|_)swimsuit(?=$|[_-])/, 1], [/(?:^|_)panties(?=$|[_-])/, 1], [/(?:^|_)panty(?=$|[_-])/, 1],
  [/(?:^|_)underwear(?=$|[_-])/, 1], [/(?:^|_)lingerie(?=$|[_-])/, 1], [/(?:^|_)fishnet(?:s)?(?=$|[_-])/, 1],
  [/(?:^|_)garter(?=$|[_-])/, 1], [/(?:^|_)pantyhose(?=$|[_-])/, 1], [/(?:^|_)bra(?=$|[_-])/, 1],
  [/(?:^|_)onsen(?=$|[_-])/, 1], [/(?:^|_)bath(?:ing|house|room|robe|tub|stool)?(?=$|[_-])/, 1],
  /* shower=淋浴(1); 负向后顾断言排除 meteor_shower(流星雨)/summer_shower(阵雨) 天气词 */
  [/(?:^|_)(?<!meteor_)(?<!summer_)shower(?:ing|_head)?(?=$|[_-])/, 1],
  [/(?:^|_)apron(?=$|[_-])/, 1], [/(?:^|_)bodystocking(?=$|[_-])/, 1],
]

/**
 * 词根规则的**源码形态**, 供前端镜像重建 RegExp(2026-11-11 修分叉)。
 * 用 `re.source` 反射而不是手抄字符串: 手抄一份 = 下一次改规则必然忘改另一半。
 * 前端 `compileWordRules()` 拿它 new RegExp, 两侧逐字同源。
 */
const BUILTIN_WORD_RULE_SRC = BUILTIN_WORD_RULES.map(([re, lv]) => [re.source, lv])

/** 词根规则源码表(IPC 下发给渲染层做镜像, 见 utils/safetyMatch.js) */
export function builtinWordRules() {
  return BUILTIN_WORD_RULE_SRC
}

const cache = {
  tags: { path: '', mtime: -1, value: null },
  state: { path: '', mtime: -1, value: null },
  dict: { mtime: -1, value: null },
}

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs } catch { return -1 }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

/** 首次使用时写出去的默认文件 —— 带说明, 让用户有个能直接改的起点 */
function defaultText() {
  return [
    '# 安全模式 —— 敏感标签等级集合',
    '# ==============================',
    '# 每行一个标签(Danbooru 写法: 小写、下划线), # 开头是注释, 支持 * 通配。',
    '# 段名 = 该标签的敏感等级(与槽位词典同一把尺):',
    '#   [L0] 常规 / [L1] 擦边 / [L2] 明显暗示 / [L3] 露骨 / [L4] 极端',
    '# 一张图的等级 = 它所有标签的最高档; 「显示上限」选 N 就藏掉 > N 级的图。',
    '# 这里写过的词**覆盖**词典档位; 写 [L0] 可以把词典里的敏感词强制拉回常规。',
    '# 改完保存即生效, 不用重启看板。',
    '#',
    '',
    '[L4]',
    ...DEFAULT_CORE,
    '',
    '[L2]',
    ...DEFAULT_EDGE,
    '',
  ].join('\n')
}

/** 旧版(core/edge 两档)文件 -> 新版(L0..L4)一次性迁移改写, 保留注释与空白 */
function migrateSections(text) {
  if (!/\[core\]|\[edge\]/i.test(text)) return null
  const out = text.split('\n').map((line) => {
    const s = line.trim()
    if (/^\[core\]$/i.test(s)) return line.replace(/\[core\]/i, '[L4]')
    if (/^\[edge\]$/i.test(s)) return line.replace(/\[edge\]/i, '[L2]')
    return line
  })
  return out.join('\n')
}

/** 确保集合文件存在 —— 不存在就写出默认内容(只写一次, 之后绝不覆盖用户的改动) */
function ensureTagsFile(p) {
  if (fs.existsSync(p)) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, defaultText(), 'utf8')
  } catch { /* 写不出去也不影响运行(读侧会回落到内置默认) */ }
}

/**
 * 解析集合文件 -> { L0:[], L1:[], L2:[], L3:[], L4:[] }。
 * 兼容旧段名 core->L4 / edge->L2(迁移失败时兜底, 正常路径已提前改写文件)。
 */
function parseSections(text) {
  const sec = {}
  for (const s of SECS) sec[s] = []
  let cur = 'L4'
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (t.startsWith('[') && t.endsWith(']')) {
      const name = t.slice(1, -1).trim().toLowerCase()
      if (name === 'core') cur = 'L4'
      else if (name === 'edge') cur = 'L2'
      else if (/^l[0-4]$/.test(name)) cur = name.toUpperCase()
      continue
    }
    sec[cur].push(t.toLowerCase())
  }
  return sec
}

function compile(list) {
  const exact = new Set()
  const pre = []
  const suf = []
  const con = []
  for (const r of list) {
    if (!r.includes('*')) exact.add(r)
    else if (r.startsWith('*') && r.endsWith('*') && r.length > 2) con.push(r.slice(1, -1))
    else if (r.startsWith('*')) suf.push(r.slice(1))
    else pre.push(r.slice(0, -1))
  }
  return { exact, pre, suf, con, raw: list }
}

/** 单标签是否命中某一段 */
function hitOne(tag, part) {
  if (part.exact.has(tag)) return true
  for (let i = 0; i < part.pre.length; i++) if (tag.startsWith(part.pre[i])) return true
  for (let i = 0; i < part.suf.length; i++) if (tag.endsWith(part.suf[i])) return true
  for (let i = 0; i < part.con.length; i++) if (tag.includes(part.con[i])) return true
  return false
}

/**
 * 槽位词典的档位表(mtime 缓存): { tag: level(2-4) }。
 *
 * ⚠️ **不能全量照抄 ANIMA 的 tag_levels**(2026-10-28 实测踩中): 那套数字里
 * `1girl` 也是 4 —— count 段的 section_max=4 是"分组权重副产品", 不是露骨度。
 * 直接抄会让「≤L0 上限」把整个库藏掉。所以只按槽位语义收:
 *   · NSFW 槽(n_ 前缀 / nsfw: 前缀) -> 至少 2(进了 NSFW 槽就至少"明显"), 有档用档,
 *     无档给 3(露骨; 宁可上限调高才看见, 也不悄悄漏出);
 *   · SFW 槽只收 level 1-2 的擦边词(wedgie/bra_lift 这批), ≥3 的(count 段
 *     混进来的 1girl 之类)一律不收;
 *   · 其余(breasts/underwear/thighhighs 这些 null 档体型服饰词)不进表 ——
 *     "画里有胸"不等于暴露(93% 命中的老坑), 要收用户在覆盖段里自己写。
 * 覆盖段(safety_tags.txt)永远压过这张表。
 */
function dictLevels() {
  const p = path.join(BUNDLED_KNOWLEDGE_DIR, 'tag_slots.json')
  const mt = mtimeOf(p)
  /* 2026-11-08 修复(安装版全新用户"进不去"的根因):
   * 文件不存在时 mtimeOf 返回 -1, 与 cache.dict 初值的 mtime(-1)相等 -> 缓存条件
   * 不成立 -> 直接把初值 value(null) 返回 -> levelOfTag 里 mat.dict[tag] 抛
   * "Cannot read properties of null (reading '1girl')" -> dataset 的 SQLite 路线
   * 整条报废, 界面只剩"反推一张都没落进库"的误导文案。
   * 触发条件: 打包时没带 knowledge/(v2.4.0 的 extraResources 就没有) —— 所有
   * 安装版新用户必崩, 开发态因为仓库里有 knowledge/ 一直看不出来。
   * 现在: 缓存命中要求 value 非空; 文件缺失就每次现算(statSync 一次, 可以忽略),
   * 读不到就走 out={} —— 只剩覆盖段(safety_tags.txt)兜底, 绝不返回 null。
   */
  if (!cache.dict.value || cache.dict.mtime !== mt) {
    const out = {}
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')).tags || {}
      for (const [t, rec] of Object.entries(raw)) {
        const slot = String(rec?.slot || '')
        const isN = slot.startsWith('n_') || slot.startsWith('nsfw:')
        let lv = 0
        if (isN) {
          lv = rec?.level == null ? 3 : Math.max(2, Math.min(4, Number(rec.level) || 0))
        } else {
          const n = Number(rec?.level)
          if (n >= 1 && n <= 2) lv = n
        }
        if (lv > 0) out[String(t).toLowerCase().replace(/[\s_]+/g, '_')] = lv
      }
    } catch { /* 词典缺失 -> 全部按 0, 只剩覆盖段兜底 */ }
    // 内置兜底表(2026-11-11): 只补槽位表没收的键, 槽位表显式给的档位优先
    for (const [t, lv] of Object.entries(BUILTIN_FLOOR)) {
      const k = String(t).toLowerCase().replace(/[\s_]+/g, '_')
      if (!(k in out)) out[k] = lv
    }
    cache.dict = { mtime: mt, value: out }
  }
  return cache.dict.value
}

/**
 * 取当前集合(带 mtime 缓存)。
 * @returns {{secs: {L0:..L4: compiled}, counts: {L0..L4}, dict: {tag: level}}}
 */
export function safetyMatcher() {
  const p = dataFile(TAGS_NAME)
  const mt = mtimeOf(p)
  if (cache.tags.path !== p || cache.tags.mtime !== mt) {
    ensureTagsFile(p)
    let text = readText(p)
    // 旧版 core/edge 文件: 就地迁移成 L4/L2 段名(保留注释), 写回后按新文件走
    const migrated = text ? migrateSections(text) : null
    if (migrated != null) {
      try { fs.writeFileSync(p, migrated, 'utf8') } catch { /* 写不进就当次兜底解析 */ }
      text = migrated
      cache.tags.mtime = -1
    }
    // 文件被删/读不到 -> 用内置默认, 保证功能不会因为少一个文件就失灵
    const sec = text ? parseSections(text) : parseSections(defaultText())
    const secs = {}
    const counts = {}
    for (const s of SECS) {
      secs[s] = compile(sec[s])
      counts[s] = sec[s].length
    }
    cache.tags = {
      path: p,
      mtime: cache.tags.mtime === -1 ? mtimeOf(p) : mt, // 迁移写回后重取, 否则反复重解析
      value: { secs, counts, dict: dictLevels() },
    }
  }
  return cache.tags.value
}

/** 单标签的敏感等级: 覆盖段(L0 优先) > 词典 > 0 */
export function levelOfTag(tag, m = null) {
  const mat = m || safetyMatcher()
  // memo(2026-11-11): 词根规则 ~50 条正则逐个试, 中性词最坏全跑完 —— 读库全量
  // 重算时百万级调用会拖秒。挂 matcher 单例上缓存; 原始串/归一键双键, 热路径
  // 重复形态直接命中跳过归一。
  let memo = mat._lvMemo
  if (!memo) memo = mat._lvMemo = new Map()
  let hit = memo.get(tag)
  if (hit !== undefined) return hit
  // 归一(2026-11-11): 小写 + 下划线/空格等价 —— 导出行产物是空格写法("group sex"),
  // 库/词典是下划线(group_sex), 不归一的话空格形态整列漏判(实测 L0 漏出)。
  const t = String(tag).toLowerCase().replace(/[\s_]+/g, '_')
  hit = memo.get(t)
  if (hit !== undefined) { memo.set(tag, hit); return hit }
  let lv
  let done = false
  for (const s of SECS) if (hitOne(t, mat.secs[s])) { lv = Number(s.slice(1)); done = true; break }
  if (!done) {
    // dict 恒为对象(见 dictLevels); 这里再兜一层, 免得将来别的构造路径漏了字段又炸整库
    const d = mat.dict || {}
    if (t in d) lv = d[t]
    else {
      // 词根规则兜底(2026-11-11): 变体大军(bikini/cum/penis 系几十个组合词)按词边界判
      lv = 0
      for (const [re, r] of BUILTIN_WORD_RULES) if (re.test(t)) { lv = r; break }
    }
  }
  memo.set(t, lv)
  memo.set(tag, lv)
  return lv
}

/**
 * 给一组标签打安全等级。
 * @returns {0..4} 图内所有标签的**最高档**
 *
 * 用**数值**而不是布尔: 读数据集时一次算好, 前端切上限只做比较,
 * 不需要重载八万行数据。
 */
export function unsafeLevelOf(tags, m = null) {
  const mat = m || safetyMatcher()
  let max = 0
  for (const t of tags) {
    const lv = levelOfTag(t, mat)
    if (lv > max) max = lv
    if (max === 4) break
  }
  return max
}

/**
 * 数值标记 -> 在「显示上限 maxLevel」下是否该隐藏。
 *   unsafe > maxLevel 的图藏(0-4 同一把尺; maxLevel=4 全显示)。
 *
 * 前端有一份等价实现(utils/format.js 的 hiddenBySafety) —— 前端不能 import
 * 主进程模块。改这里的判定规则时两边要一起改。
 */
export function hiddenAt(unsafe, maxLevel) {
  return (Number(unsafe) || 0) > (Number(maxLevel) || 0)
}

/**
 * 导出用的敏感标签剔除器 —— 口径**可按次指定, 缺省跟随 safety.json 的上限**:
 * levelOpt: '0'..'4'=档位阈值(剔 > 阈值 的词) / 'core'→2、'edge'→0(旧预设兼容)
 * / 'follow' 或空 = 跟随全局。与展示过滤共用同一份词表文件; 展示开关 on/off
 * 不影响这里(档位本身始终存在)。返回 (tag) => boolean, 供 exporter.js 逐标签调用。
 */
export function safetyExportStripper(levelOpt = '') {
  const globalMax = loadSafetyState().maxLevel
  const raw = String(levelOpt || '').trim().toLowerCase()
  let threshold
  if (raw === 'core') threshold = 2
  else if (raw === 'edge') threshold = 0
  else if (raw === 'follow' || raw === '') threshold = globalMax
  else {
    const n = parseInt(raw, 10)
    threshold = Number.isNaN(n) ? globalMax : Math.max(0, Math.min(4, n))
  }
  /* 匹配器**只取一次**(2026-11-11): safetyMatcher() 里带 fs.statSync 检查文件 mtime,
   * 放进逐标签的闭包里等于每张图每个标签都 stat 一次 —— 十万行 × 40 标签 = 400 万次
   * stat, 实测把一次预设导出从 6s 拖到 97s("ban 完自动导出卡死主进程"的真凶)。
   * 导出期间文件被改属于极端情况, 拿创建时的快照是可接受的(档位阈值本来也是快照)。 */
  const mat = safetyMatcher()
  return (tag) => {
    // 剥壳(2026-11-11): 库里混有 A1111 直出的加权形态 —— uncensored:2 / {cum...:1.5},
    // 不剥的话带尾巴的词查表必落空(实测 L0 导出漏 uncensored:2)。
    const t = String(tag)
      .replace(/^\{+|\}+$/g, '')                 // 花括号壳 {xxx:1.5}
      .replace(/[:：]\s*\d+(?:\.\d+)?\s*$/, '')  // 尾部权重 uncensored:2
    return levelOfTag(t, mat) > threshold
  }
}

/* ------------------------------------------------------------ 开关与档位 */

/* mode(2026-10-23):
 *   safe   = 正常口径, 隐藏超过显示上限的图
 *   unsafe = 「不安全模式」: **取反** —— 只显示超过上限的图, 其余全隐藏
 * 两者共用同一份等级标尺; 开关(on)仍是总闸, 关掉时两模式都不生效。 */
const DEFAULT_STATE = { on: false, maxLevel: 2, mode: 'safe' }

/** maxLevel 迁移: 旧 level 'core'->2 / 'edge'->0; 数字夹在 0-4 */
function normMaxLevel(raw) {
  if (raw === 'core') return 2
  if (raw === 'edge') return 0
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? DEFAULT_STATE.maxLevel : Math.max(0, Math.min(4, n))
}

/**
 * 开关与上限。**默认关闭** —— 实测上限调低会藏掉大半的图, 这种东西不能默认开。
 * 文件坏了/读不到也回落到默认关闭(宁可看不到过滤, 也不要突然少一半图)。
 */
export function loadSafetyState() {
  const p = dataFile(STATE_NAME)
  const mt = mtimeOf(p)
  if (cache.state.path !== p || cache.state.mtime !== mt) {
    let v = { ...DEFAULT_STATE }
    try {
      const raw = JSON.parse(readText(p) || '{}')
      v = {
        on: raw.on === true,
        maxLevel: normMaxLevel(raw.maxLevel ?? raw.level),
        mode: raw.mode === 'unsafe' ? 'unsafe' : 'safe',
      }
    } catch { /* 坏文件 -> 默认关闭 */ }
    cache.state = { path: p, mtime: mt, value: v }
  }
  return cache.state.value
}

export function saveSafetyState(patch = {}) {
  const cur = loadSafetyState()
  const next = {
    on: patch.on === undefined ? cur.on : patch.on === true,
    maxLevel: patch.maxLevel === undefined ? cur.maxLevel : normMaxLevel(patch.maxLevel),
    mode: patch.mode === undefined ? cur.mode : (patch.mode === 'unsafe' ? 'unsafe' : 'safe'),
  }
  fs.writeFileSync(dataFile(STATE_NAME), JSON.stringify(next, null, 2), 'utf8')
  cache.state.mtime = -1
  return { ok: true, ...next }
}

/* ------------------------------------------------------------ 集合编辑 */

/** 集合文件原文(给编辑弹窗) */
export function safetyText() {
  const p = dataFile(TAGS_NAME)
  ensureTagsFile(p)
  return readText(p)
}

export function saveSafetyText(text) {
  const p = dataFile(TAGS_NAME)
  fs.writeFileSync(p, String(text ?? ''), 'utf8')
  cache.tags.mtime = -1
  return { ok: true, ...safetySummary() }
}

/**
 * 单条标签加入 / 移出某个段 —— 保留文件里的注释与分组。
 * sec: 'L0'..'L4'。已在该段(且是精确条目) -> 删掉那一行; 否则追加到该段末尾。
 * 被判通配规则命中时**不动文件**, 只回一个 warning(必须手工改规则)。
 */
export function toggleSafetyTag(tag, sec = 'L4') {
  const p = dataFile(TAGS_NAME)
  const target = String(tag || '').trim().toLowerCase()
  if (!target) return { ok: false, error: 'empty tag' }
  const secName = SECS.includes(String(sec || '').toUpperCase()) ? String(sec).toUpperCase() : 'L4'
  ensureTagsFile(p)

  const lines = readText(p).split('\n')
  let secStart = -1
  let secEnd = lines.length
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.startsWith('[') && s.endsWith(']')) {
      const name = s.slice(1, -1).trim().toLowerCase()
      if (secStart < 0 && name === secName.toLowerCase()) { secStart = i; continue }
      if (secStart >= 0) { secEnd = i; break }
    }
    if (secStart >= 0 && s && !s.startsWith('#') && !s.includes('*') && s.toLowerCase() === target) {
      found = i
      break
    }
  }

  const mat = safetyMatcher()
  const part = mat.secs[secName]

  if (found >= 0) {
    lines.splice(found, 1)
    fs.writeFileSync(p, lines.join('\n'), 'utf8')
    cache.tags.mtime = -1
    return { ok: true, inSet: false, section: secName, ...safetySummary() }
  }

  if (hitOne(target, part)) {
    const rule = [...part.raw].find((r) => r.includes('*') && hitOne(target, compile([r]))) || ''
    return { ok: true, inSet: true, section: secName, wildcard: rule, ...safetySummary() }
  }

  // 追加到该段末尾(段不存在就在文件末尾补一个段头)
  if (secStart < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', `[${secName}]`, target)
  } else {
    let insertAt = secEnd
    while (insertAt > secStart + 1 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, target)
  }
  fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf8')
  cache.tags.mtime = -1
  return { ok: true, inSet: true, section: secName, ...safetySummary() }
}

/** 给界面用的一览: 各段多少条、开关与上限; 顺带下发词典档位表给前端镜像 */
export function safetySummary() {
  const m = safetyMatcher()
  const st = loadSafetyState()
  return {
    ...st,
    counts: { ...m.counts },
    words: Object.fromEntries(SECS.map((s) => [s, [...m.secs[s].raw]])),
    dictLevels: m.dict,
    // 词根规则(源码形态): 渲染层镜像必须与主进程同一套, 否则库外图(扫描页)
    // 的过滤结果和"隐藏 N 张"的数字会两边对不上(2026-11-11 修)。
    wordRules: BUILTIN_WORD_RULE_SRC,
    file: dataFile(TAGS_NAME),
  }
}

export function invalidateSafetyCache() {
  cache.tags.mtime = -1
  cache.state.mtime = -1
}
