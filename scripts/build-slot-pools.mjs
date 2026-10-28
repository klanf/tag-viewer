// 词条管线第三层 · 前置: 槽位池 + 角色本体档案
// 产物:
//   knowledge/slot-pools.json   每槽位词条池(带图片量权重/NSFW档位) + 槽位密度
//   .e2e-work/char-profiles.json  每角色的锚定特征票选(发色/瞳色/种族…)
// 运行: node scripts/build-slot-pools.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = path.resolve(import.meta.dirname, '..')
const dict = JSON.parse(readFileSync(path.join(REPO, 'knowledge/tag_slots.json'), 'utf8')).tags

// 参与抽签的槽位白名单(按输出段排序用同一张表, 见 random-prompt.mjs)
// NSFW 槽位也入池, 但带 level, 抽签端按 --level 门槛过滤
const DRAW_SLOTS = new Set([
  // 外观
  'hair_color', 'hair_len', 'hairstyle', 'hair_tie', 'hair_acc', 'eyes_color',
  'figure', 'race', 'wings', 'tail', 'horn', 'feature',
  // 表情
  'emotion', 'mouth', 'eye_gaze',
  // 服饰
  'outfit', 'top', 'bottom', 'legwear', 'socks', 'footwear', 'handwear',
  'underwear', 'swimwear', 'clothing_type', 'cloth_state_sfw', 'clothing_state',
  'cloth_mat', 'headwear', 'accessory', 'eyewear', 'sleeves',
  // 姿势
  'pose', 'pose_base', 'pose_stance', 'pose_risque',
  // 镜头
  'shot_size', 'camera_angle', 'camera_fx', 'viewpoint',
  // 场景
  'location', 'environment', 'weather', 'furniture', 'prop', 'lighting',
  // NSFW(带档位)
  'n_exposure', 'n_state', 'n_pos', 'n_touch', 'n_sex', 'n_bondage', 'n_cum', 'n_body',
  'nsfw:nudity', 'nsfw:undressed', 'nsfw:cutout', 'nsfw:see_through', 'nsfw:suggestive',
])
// 角色锚定槽位: 本体特征, 抽到角色就锁死
export const ANCHOR_SLOTS = ['hair_color', 'eyes_color', 'hair_len', 'race', 'wings', 'tail', 'horn']

const db = new DatabaseSync(path.join(REPO, 'data/tags.db'), { readOnly: true })

// ---------- 1. 槽位池: tags 表(带图片量 cnt) ∩ 词典槽位 ----------
const tagRows = db.prepare("SELECT name, cnt, cat FROM tags WHERE kind='other' AND cnt >= 20").all()
const pools = {}, nsfwPools = {}
let poolN = 0
for (const r of tagRows) {
  const rec = dict[r.name]
  if (!rec || !rec.slot || !DRAW_SLOTS.has(rec.slot)) continue
  const entry = { tag: r.name, cnt: r.cnt, level: rec.level ?? null }
  if (rec.slot.startsWith('nsfw:') || rec.slot.startsWith('n_')) {
    ;(nsfwPools[rec.slot] ||= []).push(entry)
  } else {
    ;(pools[rec.slot] ||= []).push(entry)
  }
  poolN++
}
for (const p of [pools, nsfwPools]) for (const k of Object.keys(p)) p[k].sort((a, b) => b.cnt - a.cnt)
console.log(`槽位池: ${poolN} 词条 → ${Object.keys(pools).length} 个 SFW 槽 + ${Object.keys(nsfwPools).length} 个 NSFW 槽`)

// ---------- 2. 单人图扫描: 槽位密度 + 角色锚定票选 ----------
const charNames = new Set(db.prepare("SELECT name FROM tags WHERE cat='char'").all().map((r) => r.name))
const MULTI = ['multiple_girls', 'multiple_boys', '2girls', '3girls', '4girls', '5girls', '6+girls',
  '2boys', '3boys', '4boys', '5boys', '6+boys']
const ANCHOR_SLOTS_SET = new Set(ANCHOR_SLOTS)

const slotSolo = {}
let soloTotal = 0
const charVotes = {}   // char -> slot -> tag -> votes
let imgN = 0
const rows = db.prepare('SELECT tags FROM images WHERE gone=0').all()
for (const r of rows) {
  imgN++
  const tags = r.tags.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (MULTI.some((m) => tags.includes(m))) continue
  if (!tags.includes('1girl') && !tags.includes('1boy')) continue
  // 是单人图
  soloTotal++
  const chars = tags.filter((t) => charNames.has(t))
  const seen = new Set()
  for (const t of tags) {
    const rec = dict[t]
    if (!rec || !rec.slot) continue
    const s = rec.slot
    if (!seen.has(s)) { seen.add(s); slotSolo[s] = (slotSolo[s] || 0) + 1 }
    if (chars.length === 1 && ANCHOR_SLOTS_SET.has(s)) {
      ;((charVotes[chars[0]] ||= {})[s] ||= {})
      charVotes[chars[0]][s][t] = (charVotes[chars[0]][s][t] || 0) + 1
    }
  }
}
const density = {}
for (const s of Object.keys(slotSolo)) density[s] = +(slotSolo[s] / soloTotal).toFixed(3)

// ANIMA「腿上」(socks) 与自建 legwear 是同一语义类(v2.1 词典已确认),
// 不合并的话抽签端会同时抽出 thighhighs + white_thighhighs 这类冗余
if (pools.socks) {
  const seen = new Set((pools.legwear ||= []).map((e) => e.tag))
  for (const e of pools.socks) if (!seen.has(e.tag)) { seen.add(e.tag); pools.legwear.push(e) }
  delete pools.socks
  density.legwear = Math.max(density.legwear || 0, density.socks || 0)
  delete density.socks
  pools.legwear.sort((a, b) => b.cnt - a.cnt)
  console.log(`槽位合并: socks → legwear (密度取 max)`)
}
console.log(`单人图 ${soloTotal}/${imgN}, 槽位密度算完, 角色档案 ${Object.keys(charVotes).length} 个`)

// 票选 → 档案: 只保留占比 >= 0.55 的"本体特征"(占比低说明这特征不固定, 不锚定)
const profiles = {}
for (const [c, slots] of Object.entries(charVotes)) {
  const prof = {}
  for (const [s, votes] of Object.entries(slots)) {
    const total = Object.values(votes).reduce((a, b) => a + b, 0)
    const [best, n] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]
    if (n / total >= 0.55 && n >= 3) prof[s] = { tag: best, share: +(n / total).toFixed(2) }
  }
  if (Object.keys(prof).length) profiles[c] = prof
}
console.log(`锚定特征成型: ${Object.keys(profiles).length} 个角色有稳定本体特征`)

// ---------- 3. 落盘 ----------
mkdirSync(path.join(REPO, 'knowledge'), { recursive: true })
mkdirSync(path.join(REPO, '.e2e-work'), { recursive: true })
writeFileSync(path.join(REPO, 'knowledge/slot-pools.json'), JSON.stringify({
  _meta: { schema: 'tag-viewer/slot-pools@1', built: new Date().toISOString(), soloTotal, minCnt: 20 },
  density, pools, nsfwPools,
}, null, 1))
writeFileSync(path.join(REPO, '.e2e-work/char-profiles.json'), JSON.stringify(profiles, null, 1))
console.log(`已写 knowledge/slot-pools.json 与 .e2e-work/char-profiles.json`)
