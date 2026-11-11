/**
 * 安全档位内置兜底表回归测试(2026-11-11)
 * ========================================
 * 守的是用户实测撞上的漏词事故: 「≤L0 导出」漏出 small_penis / group_sex /
 * imminent_vaginal 这批 —— 槽位词典要么没收要么挂在 count/body_part
 * 槽 level=null(展示口径刻意不收), levelOfTag 兜底 0 = 常规, L0 阈值拦不住。
 * 摸底 80 个常见 danbooru NSFW 词, 修复前 39 个为 0。
 *
 * ⚠️ breasts 一族**不在此列**(2026-11-11 用户定案): 它是体型描述, 命中 93% 的图,
 *    收进敏感集等于把整个库藏起来。判断"露不露"看 nipples / topless / exposure。
 *
 * 断言:
 *   1. 之前漏的 39 个词现在全部 level > 0(内置兜底表生效);
 *   2. 中性词(1girl / feet / onsen / scenery...)仍然 L0, 不被误剔;
 *   3. 用户两条真实导出串过 L0 剔除器: 敏感词全剔、中性词全留;
 *   4. 覆盖段优先级不变(safety_tags.txt 写过的词压过内置表)。
 *
 * 用法: node scripts/test-safety-floor.mjs
 */
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const { levelOfTag, safetyExportStripper } = await import('../electron/core/safety.js')

/* 修复前 levelOfTag=0(漏)、修复后必须 >0 的词单(2026-11-11 摸底名单) */
const WERE_LEAKING = [
  'erect_penis', 'small_penis', 'huge_penis', 'testicles', 'balls', 'cum_on_face',
  'group_sex', 'orgy', 'onee-shota', 'onee_shota', 'imminent_penetration',
  'imminent_vaginal', 'imminent_fellatio', 'just_the_tip', 'titjob', 'naked',
  'bestiality', 'incest', 'lolicon', 'egg_laying', 'birth', 'labia', 'precum',
  'fellatio_invitation', 'doggy_style', 'cowgirl_position', 'penetration',
  'penile', 'vulva', 'erect_nipples', 'puffy_nipples', 'see-through_legwear',
  'nude_filter', 'nude_insert', 'plugged', 'golden_shower', 'watersport', 'scat',
]
const NEUTRAL = [
  '1girl', '1boy', '2boys', 'multiple_boys', 'solo', 'hetero', 'feet', 'navel',
  'toes', 'soles', 'toenails', 'nose_blush', 'grin', 'steam', 'sunlight', 'day',
  'indoors', 'room', 'moon', 'in_water', 'petals', 'rock', 'highres',
  'scenery', 'ai-generated', 'japanese_clothes', 'looking_at_viewer',
  'open_mouth', 'collarbone', 'low_twintails', 'hanging_light', 'big_belly',
  /* 体型描述族: 刻意不判敏感(2026-11-11 定案, 见文件头) */
  'breasts', 'big_breasts', 'small_breasts', 'large_breasts',
  /* 词边界防误伤守卫(2026-11-11 查漏补缺轮) */
  'cumulonimbus_cloud', 'big_cumulus_clouds', 'analog_clock', 'unisex',
  'meteor_shower', 'summer_shower', 'zipper_pull_tab', 'hair_lift', 'leg_lift',
]

ok('摸底名单: 修复前漏的词现在全部有档位', () => {
  const still = WERE_LEAKING.filter((w) => levelOfTag(w) === 0)
  assert.deepEqual(still, [], `仍是 0(会漏)的词: ${still.join(', ')}`)
})

ok('档位刻度对齐(small_penis=3 / group_sex=4 / breasts=0 / bow_bikini=1)', () => {
  assert.equal(levelOfTag('small_penis'), 3)
  assert.equal(levelOfTag('group_sex'), 4)
  // breasts = 0 是**有意为之**(体型词不算敏感), 不是漏判 —— 别把它加回兜底表
  assert.equal(levelOfTag('breasts'), 0)
  assert.equal(levelOfTag('bow_bikini'), 1)
})

ok('中性词不被误剔(1girl/2boys/feet/onsen... 仍 L0)', () => {
  const hit = NEUTRAL.filter((w) => levelOfTag(w) !== 0)
  assert.deepEqual(hit, [], `不该有档位的词: ${hit.map((w) => `${w}=${levelOfTag(w)}`).join(', ')}`)
})

ok('用户真实导出串过 L0 剔除器: 敏感词全剔', () => {
  const strip0 = safetyExportStripper('0')
  const line1 = ['multiple_boys', '1girl', '2boys', 'shota', 'small_penis', 'breasts', 'sparse_pubic_hair', 'bow_bikini', 'japanese_clothes', 'see-through_legwear', 'steam', 'clitoral_hood', 'group_sex', 'hetero', 'she_is_standing_on_tiptoe_with_both_arms_raised_in_a_v', 'her_hair_is_a_medium-long_wavy_wolf_cut', 'seen_from_the_side', 'shared_bathing', 'sunlight', 'day', 'uncensored', 'highres', 'scenery', 'onee-shota', 'ai-generated']
  const line2 = ['1girl', '1boy', 'shota', 'small_penis', 'feet', 'navel', 'toes', 'breasts', 'open_mouth', 'soles', 'spread_navel', 'collarbone', 'low_twintails', 'toenails', 'nose_blush', 'see-through_legwear', 'grin', 'hands_on_own_stomach', 'hetero', 'she_is_standing_with_one_leg_lifted_behind_her', 'her_hair_is_a_butterfly-cut_layered_style_in_hazel_brown', 'seen_from_above', 'indoors', 'room', 'bathing', 'onsen', 'moon', 'in_water', 'hanging_light', 'looking_at_viewer', 'solo_focus', 'onee-shota', 'petals_on_liquid', 'partially_submerged', 'imminent_penetration', 'imminent_vaginal', 'just_the_tip', 'petals', 'implied_pregnancy', 'big_belly', 'testicles', 'rock']
  for (const [i, line] of [line1, line2].entries()) {
    const kept = line.filter((t) => !strip0(t))
    const bad = kept.filter((t) => levelOfTag(t) > 0)
    assert.deepEqual(bad, [], `行${i + 1} 仍漏: ${bad.join(', ')}`)
  }
})

ok('覆盖段优先级不变(uncensored 在词表 L2 段, 压过兜底表)', () => {
  // 用户 data/safety_tags.txt 的 [L2] 段里写了 uncensored —— 兜底表里没有它,
  // 这里守的是"段命中优先于 dict"这条老规则不被 BUILTIN_FLOOR 合并顺序破坏
  assert.equal(levelOfTag('uncensored'), 2)
  assert.equal(levelOfTag('nude'), 4)   // 默认 L4 段的老词
})

/* ---- 2026-11-11 查漏补缺(10 万行真实 L0 导出全量扫描) ---- */

ok('空格/下划线归一: 空格写法("group sex")与下划线同档', () => {
  // 事故: 导出行产物是空格写法, levelOfTag 只小写不归一, 兜底表空格形态整列漏判
  for (const [sp, ul] of [['group sex', 'group_sex'], ['small penis', 'small_penis'], ['shared bathing', 'shared_bathing'], ['see-through legwear', 'see-through_legwear'], ['string bikini', 'string_bikini']])
    assert.equal(levelOfTag(sp), levelOfTag(ul), `${sp} 应与 ${ul} 同档`)
})

ok('权重尾巴剥壳: uncensored:2 / {massive_cum_inflation:1.5} 判级不落空', () => {
  const strip0 = safetyExportStripper('0')
  assert.equal(strip0('uncensored:2'), true, 'A1111 直出的 uncensored:2 应被 L0 剔除')
  assert.equal(strip0('{massive_cum_inflation:1.5}'), true, '花括号壳应剥掉后按 cum 词根判')
  assert.equal(strip0('lewd:1.3'), true)
})

ok('词根规则: 变体大军按词边界判级(40+ bikini 变体等)', () => {
  // L1 泳装/内衣族(onsen/bathing 场景擦边 2026-11-11 升档; mixed/same-sex 精确键压过 sex 词根)
  for (const w of ['string_bikini', 'frilled_bikini', 'side-tie_bikini_bottom', 'one-piece_swimsuit', 'school_swimsuit', 'white_bikini', 'fishnets', 'onsen', 'mixed-sex_bathing', 'same-sex_bathing', 'apron', 'bathroom'])
    assert.equal(levelOfTag(w), 1, `${w} 应为 L1`)
  // L2 性器/暗示族
  for (const w of ['pussy_peek', 'penis_grab', 'licking_penis', 'nipple_piercing', 'pubic_tattoo', 'naked_shirt', 'naked_kimono', 'clothing_aside', 'kimono_pull', 'unworn_skirt', 'lifted_by_self', 'exhibitionism', 'implied_sex'])
    assert.equal(levelOfTag(w), 2, `${w} 应为 L2`)
  // L3 露骨族(veiny_penis=2 与 penis 本体同级, 不在此列)
  for (const w of ['cum_on_clothes', 'internal_cumshot', 'female_ejaculation', 'deep_penetration', 'tentacle_sex', 'thigh_sex', 'emotionless_sex', 'imminent_rape', 'sleep_molestation', 'futanari_pov', 'table_humping'])
    assert.equal(levelOfTag(w), 3, `${w} 应为 L3`)
  assert.equal(levelOfTag('veiny_penis'), 2, 'penis 本体=2, 变体对齐')
  assert.equal(levelOfTag('clitoral_stimulation'), 2, 'clitoris 本体=2, 变体对齐')
  // L4
  assert.equal(levelOfTag('fff_threesome'), 4)
})

ok('词边界不误伤: cumulus/analog/meteor_shower/summer_shower 等', () => {
  for (const w of ['cumulonimbus_cloud', 'big_cumulus_clouds', 'analog_clock', 'analogous_colors', 'meteor_shower', 'summer_shower', 'sudden_summer_shower', 'weightlifting', 'carousel', 'luggage', 'grapes', 'cucumber', 'zipper', 'zipper_pull_tab', 'hair_lift', 'leg_lift', 'wind_lift', 'peeking', 'armpit_peek', 'unisex'])
    assert.equal(levelOfTag(w), 0, `${w} 是中性词, 不该有档位`)
})

ok('10 万行真实导出高频漏词全数有档位(词频 Top)', () => {
  for (const w of ['shared_bathing', 'mixed-sex_bathing', 'same-sex_bathing', 'after_bathing', 'string_bikini', 'frilled_bikini', 'side-tie_bikini_bottom', 'cum_on_clothes', 'internal_cumshot', 'long_labia', 'pubic_tattoo', 'nipple_stimulation', 'bikini_bottom_aside', 'animal_penis', 'female_ejaculation', 'large_penis', 'multiple_penises', 'large_areolae', 'nipple_tweak', 'swimsuit_aside', 'egg_vibrator', 'deep_penetration', 'bikini_bottom_only', 'cum_on_tongue', 'female_orgasm', 'imminent_vaginal', 'nipple_piercing', 'inflation', 'clothed_male_nude_female', 'bikini_skirt', 'naked_shirt', 'pussy_peek', 'penis_grab', 'pubic_hair_peek', 'after_anal', 'projectile_cum', 'highleg_bikini', 'pussy_juice_puddle', 'untied_bikini', 'naked_kimono', 'licking_penis', 'wet_swimsuit', 'school_swimsuit', 'naked_towel', 'after_fellatio', 'nipple-to-nipple', 'competition_swimsuit', 'naked_apron', 'surrounded_by_penises', 'holding_sex_toy', 'exhibitionism'])
    assert.ok(levelOfTag(w) > 0, `${w} 仍为 L0(会漏)`)
})

console.log(`\n===== safety-floor: ${pass} 通过, ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
