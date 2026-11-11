#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从两个开源图库的**文字索引**生成自然语言语料库 knowledge/nl-bank.json
=====================================================================
数据源(只取文字元数据, 不分发任何图片):
  anhao/ai-pose-gallery-zh   data/pose-zh.json     姿势 1439 条(287 个唯一动作 × 视角)
                             data/portrait-zh.json 人像 1499 条(51 种发型)
                             data/costume-zh.json  服装 1407 套(1250 套唯一)
  代码 MIT; 图片版权归 ギア(@giaaibusi), 明确禁止打包倒卖 —— 所以本脚本**只读 json**。
  paipiange/nvzhuang         data.js 1407 条(与上面同源, 提供英文关键词)

用法:
  python tools/build-nl-bank.py --src D:/workbuddy/_tmp/gallery
  python tools/build-nl-bank.py --src <dir> --report     # 只打覆盖率, 不写文件
  python tools/build-nl-bank.py --download               # 现拉索引到临时目录再生成

产物: knowledge/nl-bank.json
  {
    meta:    {version, generatedAt, sources[], counts{}, coverage{}},
    pose:    [{zh, en, cat, level}],
    costume: [{zh, en, cat, kw, level}],
    hair:    [{zh, en, cat}],
  }
  level: sfw | soft | nsfw —— 导出端按档位闸门过滤(默认只出 sfw)。
"""
import argparse
import datetime
import io
import json
import os
import re
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BANK_DIR = os.path.join(ROOT, 'tools', 'nl-bank')
OUT = os.path.join(ROOT, 'knowledge', 'nl-bank.json')

RAW = 'https://raw.githubusercontent.com/{repo}/main/{path}'
SRC_FILES = {
    'pose': ('anhao/ai-pose-gallery-zh', 'data/pose-zh.json'),
    'portrait': ('anhao/ai-pose-gallery-zh', 'data/portrait-zh.json'),
    'costume': ('anhao/ai-pose-gallery-zh', 'data/costume-zh.json'),
    'nvz': ('paipiange/nvzhuang', 'data.js'),
}

# 源库 pose 的「角度」字段(2026-11-08 用户要求接入):
# 1439 行 = 288 个动作 × 5 个机位, 机位是**别人配好的成套组合**(同一个动作的 5 条
# 只差角度字段), 不像 tag 侧随机拼 viewpoint 词会撞(front + from_behind) ——
# 所以可以抽。作为独立维度(view), 每个 prompt 只出一句, 与动作句正交。
# 5 条全 sfw: 机位本身不带内容分级。
VIEW_TABLE = [
    ('正面', 'from the front', '正面'),
    ('侧面', 'from the side', '侧面'),
    ('斜侧', 'from a three-quarter angle', '斜侧'),
    ('俯视', 'from above', '俯视'),
    ('仰视', 'from below', '仰视'),
]



# 姿势分类 -> 档位。sfw 才允许在"安全档"导出时出现。
POSE_LEVEL = {
    '站姿': 'sfw', '坐姿': 'sfw', '跪立・四肢着地': 'sfw', '趴卧': 'sfw',
    '特殊': 'sfw', '跪立': 'sfw', '侧坐・女孩坐': 'sfw', '蹲姿': 'sfw',
    '前倾': 'sfw', '后仰・挺背': 'sfw', '扭身': 'sfw', '可爱系': 'sfw',
    '挤胸・强调事业线系': 'soft', '性感・大胆系': 'soft',
    '立位': 'nsfw', '贴脸系': 'nsfw', '正常位（传教士）': 'nsfw', '后入位': 'nsfw',
    '坐位': 'nsfw', '背向坐位': 'nsfw', '骑乘位': 'nsfw', '侧卧位': 'nsfw',
    '面对面坐位': 'nsfw', '立位贴身': 'nsfw', '坐位贴身': 'nsfw', '贴身': 'nsfw',
}


def load_json(p):
    with io.open(p, encoding='utf-8') as f:
        return json.load(f)


def read_src(src_dir, key):
    """读本地索引文件; nvzhuang 的 data.js 是 `const D = [...]` 形式。
    本地手工下载时常被改名(如 nvz-data.js), 所以按「原名 -> 别名」依次探。"""
    repo, path = SRC_FILES[key]
    base = os.path.basename(path)
    cands = [base]
    if key == 'nvz':
        cands += ['nvz-data.js', 'nvzhuang.js', 'data(1).js']
    fn = next((os.path.join(src_dir, c) for c in cands if os.path.exists(os.path.join(src_dir, c))), None)
    if not fn:
        raise SystemExit(f'缺少索引文件({base})，在 {src_dir} 下找不到；先跑 --download 或手工下载')
    raw = io.open(fn, encoding='utf-8').read()
    if key == 'nvz':
        m = re.search(r'const\s+D\s*=\s*(\[.*?\])\s*;', raw, re.S)
        if not m:
            raise SystemExit('data.js 解析失败(找不到 const D = [...])')
        return json.loads(m.group(1))
    return json.loads(raw)


def download(tmp):
    os.makedirs(tmp, exist_ok=True)
    for key, (repo, path) in SRC_FILES.items():
        url = RAW.format(repo=repo, path=path)
        fn = os.path.join(tmp, os.path.basename(path))
        print(f'  拉取 {repo}/{path} …', end='', flush=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'tag-viewer-nl-bank'})
        with urllib.request.urlopen(req, timeout=90) as r:
            data = r.read()
        with open(fn, 'wb') as f:
            f.write(data)
        print(f' {len(data) / 1024:.0f} KB')
    return tmp


# ---------------- 颜色剥离(2026-11-11 用户要求) ----------------
# 为什么做: 1250 条穿搭里 1219 条带颜色("象牙白针织衫・白色运动鞋"), 于是
#   ① 同一版型的深浅色变体在池里各占一条, 发牌抽出来「看着一样」;
#   ② 颜色写死在一整套里, 用户没法在方案层统一控制它跟 tag 侧颜色词的关系。
# 处理口径: 语料只描述**版型与材质**, 颜色交回 tag 侧。剥离后重复的条目合并。
#   服装走 build_costume 里**原子级跳过**(词表本来就是 color/material/style 分组, 精确无残留);
#   发型英文走下面的正则(翻译表里颜色是嵌进句子的), 中文走 hair-color-fix.json 对照表。
_COLOR_EN_HEADS = {
    'black', 'white', 'grey', 'gray', 'red', 'blue', 'green', 'yellow', 'orange',
    'purple', 'pink', 'brown', 'beige', 'ivory', 'cream', 'navy', 'khaki', 'olive',
    'gold', 'silver', 'bronze', 'copper', 'champagne', 'lavender', 'lilac', 'violet',
    'burgundy', 'maroon', 'wine', 'teal', 'turquoise', 'cyan', 'mint', 'coral', 'peach',
    'apricot', 'mustard', 'camel', 'taupe', 'charcoal', 'blonde', 'auburn', 'platinum',
    'hazel', 'chestnut', 'chocolate', 'cherry', 'multicolour', 'multicolor', 'iridescent',
}
_COLOR_EN_MODS = {
    'light', 'dark', 'deep', 'pale', 'soft', 'bright', 'pastel', 'vivid', 'warm', 'cool',
    'dusty', 'ashy', 'milky', 'milky-tea', 'mint', 'cherry', 'hazel', 'chestnut',
    'chocolate', 'wine', 'olive', 'rose', 'pearl', 'metallic', 'neon', 'two-tone',
}


def _alt(words):
    return '|'.join(sorted((re.escape(w) for w in words), key=len, reverse=True))


_COLOR_TOK = rf'(?:{_alt(_COLOR_EN_MODS)}|{_alt(_COLOR_EN_HEADS)})'
_COLOR_SEQ = rf'\b(?:{_COLOR_TOK}[\s-]+)*(?:{_alt(_COLOR_EN_HEADS)})\b'
# "a short bob in light milky-tea brown" → 整段尾巴连 in 一起删, 否则留下悬空的 "in"
_COLOR_TAIL = re.compile(rf'\s+(?:in|with)\s+{_COLOR_SEQ}\s*$', re.I)
# "in a sheer, airy colour" / "in a dark shade" —— 不点具体色但仍在说发色
_COLOR_VAGUE = re.compile(r'\s+in\s+an?\s+[\w\s,-]*?\b(?:colou?rs?|shades?|tones?)\b\s*$', re.I)
_COLOR_DARKHAIR = re.compile(r'\s+in\s+(?:dark|light)\s+hair\s*$', re.I)
_COLOR_ANY = re.compile(_COLOR_SEQ, re.I)


def _fix_article(seg):
    """颜色删掉后不定冠词要跟着首字母改: an ivory … → a frilled …"""
    m = re.match(r'^(a|an|A|An)\s+(\S+)', seg)
    if not m:
        return seg
    art, word = m.group(1), m.group(2)
    vowel = word[0].lower() in 'aeiou'
    want = 'an' if vowel else 'a'
    if art.lower() == want:
        return seg
    return re.sub(r'^\S+', want.capitalize() if art[0].isupper() else want, seg, count=1)


def strip_colors_en(s):
    """删掉英文句子里的颜色描述, 并修掉留下的空格/冠词/悬空介词。"""
    if not s:
        return s
    out = s
    for pat in (_COLOR_TAIL, _COLOR_VAGUE, _COLOR_DARKHAIR):
        out = pat.sub('', out)
    out = _COLOR_ANY.sub(' ', out)
    out = re.sub(r'\s{2,}', ' ', out)
    out = re.sub(r'\s+([,.;])', r'\1', out)
    out = re.sub(r',\s*,+', ',', out)
    # 删色后留下的空介词: "in mint beige with X" → "in with X"、"… bob in" → 悬空
    out = re.sub(r'\s+\b(?:in|with|of)\b\s+(?=(?:with|and)\b)', ' ', out, flags=re.I)
    out = re.sub(r'\s+\b(?:in|with|of)\b\s*(?=,|;|$)', '', out, flags=re.I)
    out = re.sub(r'\s{2,}', ' ', out)
    out = _tidy(out.strip(' ,'))
    return ', '.join(_fix_article(x.strip()) for x in out.split(',') if x.strip())


# ---------------- 服装: 原子词拆解拼装 ----------------
class Lex:
    """最长匹配优先的原子词表。中文顺序 颜色+材质+款式+单品 ≈ 英文同序, 直接拼。"""

    def __init__(self, lex):
        self.garment = sorted(lex['garment'].items(), key=lambda kv: -len(kv[0]))
        self.atoms = []
        for grp in ('color', 'material', 'style'):
            for zh, en in lex[grp].items():
                self.atoms.append((zh, en, grp))
        self.atoms.sort(key=lambda t: -len(t[0]))
        self.level_by_cat = lex.get('levelByCat', {})

    def split_garment(self, seg):
        for zh, en in self.garment:
            if seg.endswith(zh):
                return seg[:len(seg) - len(zh)], en
        return None, None

    def parse_mods(self, s):
        """贪婪最长匹配; 返回 (英文词列表, 剩余未识别串, 保留下来的中文修饰语)。

        颜色原子(词表 color 组)**照常消费但不进产物** —— 见文件头「颜色剥离」。
        「透明」虽然被词表归在 color 组, 说的是材质观感不是颜色, 照常保留。
        """
        out, kept, i, left = [], [], 0, ''
        while i < len(s):
            hit = None
            for zh, en, grp in self.atoms:
                if s.startswith(zh, i):
                    hit = (zh, en, grp)
                    break
            if not hit:
                left = s[i:]
                break
            is_color = hit[2] == 'color' and hit[0] != '透明'
            if hit[1] and not is_color:     # 词典里给空串 = 这个词不译(如「款」)
                out.append(hit[1])
            if not is_color:
                kept.append(hit[0])
            i += len(hit[0])
        return out, left, ''.join(kept)


def build_costume(cost, lex, nvz):
    """服装名 -> 英文短语。拼不出来就降级用英文关键词(nvz 的 キーワード)。

    颜色在 parse_mods 里就被丢掉了(见「颜色剥离」), 所以中文名也要同步抠掉那几段,
    否则 中文名与英文句对不上(nlTagIndex 按「・」逐段对齐, 段内颜色对不齐会串味)。
    """
    kw_by_id = {d['id']: d.get('キーワード', '') for d in nvz}
    out, fails = [], []
    seen = set()
    for c in cost:
        zh = c['服装名称'].strip()
        if zh in seen:
            continue
        seen.add(zh)
        parts, parts_zh = [], []
        ok = True
        for seg in zh.split('・'):
            seg = seg.strip()
            if not seg:
                continue
            mods, garment_en = lex.split_garment(seg)
            garment_zh = seg[len(mods or ''):]
            if garment_en is None:
                # 整段只有材质/颜色、没有单品(源数据里「・皮质」这种补充写法) ——
                # 能完整解析就当残留描述跳过, 解析不了才算这条拼不出来。
                _, left_only, _ = lex.parse_mods(seg)
                if left_only:
                    ok = False
                    break
                continue
            en_mods, left, mods_zh = lex.parse_mods(mods or '')
            if left:
                ok = False
                break
            phrase = ' '.join(en_mods + [garment_en])
            if phrase in parts:              # 「黑半身裙・白半身裙」剥色后是同一件, 别写两遍
                continue
            parts.append(phrase)
            parts_zh.append(mods_zh + garment_zh)
        if ok and parts:
            en = ', '.join(_with_article(p) for p in parts)
            zh = '・'.join(parts_zh)
        else:
            # 降级: 英文关键词原串(散词, 但至少是这条穿搭的真实描述), 颜色同样剥掉
            en = strip_colors_en(kw_by_id.get(c['id'], '').strip())
            if not en:
                fails.append(zh)
                continue
            fails.append(zh)
        cat = c.get('分类', '')
        level = lex.level_by_cat.get(cat, 'sfw')
        out.append({
            'zh': zh,
            'en': _tidy(en),
            'cat': cat,
            'kw': strip_colors_en(kw_by_id.get(c['id'], '')),
            'level': level,
        })
    return out, fails


# 复数形态的单品/配饰: 不加不定冠词("a jeans" 是错的)
PLURAL_HEADS = {
    'accessories', 'jewellery', 'sunglasses', 'gloves', 'earrings', 'jeans',
    'trousers', 'shorts', 'culottes', 'pumps', 'loafers', 'sneakers', 'sandals',
    'boots', 'tights', 'stockings', 'socks', 'heels',
}


def _with_article(p):
    """单个单品短语补不定冠词: 'black lace skirt' -> 'a black lace skirt'。
    最后一个是复数词(jeans/socks/sneakers…)就不加 —— 英文里没有 'a jeans'。"""
    p = p.strip()
    if not p:
        return p
    if re.match(r'^(a|an|some|a pair of)\b', p):
        return p
    head = p.split(' ')[-1]
    if head in PLURAL_HEADS:
        return p
    return ('an ' if p[0] in 'aeiou' else 'a ') + p


def _tidy(en):
    en = re.sub(r'\s+', ' ', en).strip().strip(',')
    # 连续重复词收敛(如 'long long skirt')
    words = en.split(' ')
    out = []
    for w in words:
        if out and out[-1] == w:
            continue
        out.append(w)
    return ' '.join(out)


# ---------------- 姿势 / 发型 ----------------
def build_view():
    """机位**映射表**(不是维度池) —— 源库「角度」字段的 5 个取值 → 英文句。

    2026-11-08 改法(对齐原项目 comfyui_plugin/nodes.py 的 `_build_pose_prompts`):
    机位是**动作的属性**, 不是可自由组合的独立维度。源库 1439 行 = 288 个动作 ×
    5 个机位, 是作者逐张拍好的成套配对; 拆成两维正交会造出源库不存在的组合
    (「M字开腿（坐位・双手后撑）」只有 4 个机位, 没有仰视), 也会让"只勾机位不勾
    动作"拼出 "seen from above" 这种没主语的残句。
    """
    return {zh: en for _src, en, zh in VIEW_TABLE}


def build_pose(pose, table):
    """按「分类 + 姿势名」查翻译表; 表里没有的直接报出来(不允许静默漏词)。

    去重按**英文句**做 —— 同一个动作名会跨分类重复出现(如「前倾・手扶膝」既在
    「站姿」也在「前倾」), 不合并的话池子里就有两条字面一样的句子, 发牌抽样会把
    它们当成两个不同动作发给两条 prompt。合并时档位取**更严**的那个, 免得去重
    把一条 nsfw 句吞进 sfw 池里。

    每条动作记下它在源库**真实拥有**的机位(`views`) —— 合并的两组动作要把机位
    并集起来。这样抽样时只会产出 1439 行里真实存在的「动作 × 机位」配对。
    """
    lv_rank = {'sfw': 0, 'soft': 1, 'nsfw': 2}
    by_en = {}
    order = []
    missing = []
    for p in pose:
        cat = p['分类']
        zh = p['姿势名称']
        en = (table.get(cat) or {}).get(zh)
        if not en:
            missing.append((cat, zh))
            continue
        level = POSE_LEVEL.get(cat, 'sfw')
        key = en.strip().lower()
        if key in by_en:
            cur = by_en[key]
            if lv_rank[level] > lv_rank[cur['level']]:
                cur['level'] = level
            cur['views'].add(p['角度'])
            continue
        item = {'zh': zh, 'en': en, 'cat': cat, 'level': level, 'views': {p['角度']}}
        by_en[key] = item
        order.append(item)
    # set → 按源库固定顺序(正面/侧面/斜侧/俯视/仰视)的数组, 产物可复现
    view_order = [zh for _src, _en, zh in VIEW_TABLE]
    for it in order:
        it['views'] = [v for v in view_order if v in it['views']]
    return order, missing


_ZH_COLOR_HINT = ('色', '黑发', '白发', '金发', '银发', '灰', '棕', '咖啡', '栗', '奶茶',
                  '薰衣草', '薄荷', '樱桃', '巧克力', '榛果')


def _zh_has_color(s):
    return any(h in s for h in _ZH_COLOR_HINT)


def build_hair(portrait, table, zh_fix=None):
    """发型英文/中文都剥掉颜色。中文没有词表可拆(整句是人写的名字), 走对照表
    `tools/nl-bank/hair-color-fix.json`; 表里没覆盖又仍带颜色词的, 收集起来报警,
    不允许静默留一条带色的句子进池子。"""
    zh_fix = zh_fix or {}
    out, missing, leftover = [], [], []
    for p in portrait:
        zh = p.get('发型名称')
        if not zh:
            continue
        cat = p.get('发长') or ''
        en = (table.get(cat) or {}).get(zh)
        if not en:
            # 发长分档可能与表里的分组名不同, 全表兜底找一次
            for grp in table.values():
                if isinstance(grp, dict) and zh in grp:
                    en = grp[zh]
                    break
        if not en:
            missing.append((cat, zh))
            continue
        en = strip_colors_en(en)
        zh2 = zh_fix.get(zh, zh)
        if _zh_has_color(zh2):
            leftover.append((cat, zh, zh2))
        item = {'zh': zh2, 'en': en, 'cat': cat, 'level': 'sfw'}
        if item not in out:
            out.append(item)
    return out, missing, leftover


def dedupe(items, dim):
    """剥掉颜色后可能撞句("黑蕾丝裙" / "白蕾丝裙" → 同一句) —— 同一 dim 里英文归一
    相同就合并: 保留首条, 档位取**更严**的(别把一条 nsfw 吞进 sfw 池), 机位取并集。"""
    rank = {'sfw': 0, 'soft': 1, 'nsfw': 2}
    view_order = [zh for _src, _en, zh in VIEW_TABLE]
    out, idx, merged = [], {}, 0
    for it in items:
        k = re.sub(r'\s+', ' ', it['en'].strip().lower())
        cur = idx.get(k)
        if cur is None:
            idx[k] = it
            out.append(it)
            continue
        merged += 1
        if rank.get(it.get('level', 'sfw'), 0) > rank.get(cur.get('level', 'sfw'), 0):
            cur['level'] = it['level']
        if dim == 'pose' and it.get('views'):
            vs = set(cur.get('views') or []) | set(it['views'])
            cur['views'] = [v for v in view_order if v in vs]
    return out, merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='', help='索引文件所在目录')
    ap.add_argument('--download', action='store_true', help='从 GitHub 现拉索引')
    ap.add_argument('--report', action='store_true', help='只打覆盖率报告, 不写产物')
    ap.add_argument('--out', default=OUT)
    a = ap.parse_args()

    src = a.src
    tmp = None
    if a.download or not src:
        tmp = tempfile.mkdtemp(prefix='nl-bank-')
        print('现拉索引到', tmp)
        src = download(tmp)

    pose_src = read_src(src, 'pose')
    portrait_src = read_src(src, 'portrait')
    costume_src = read_src(src, 'costume')
    nvz_src = read_src(src, 'nvz')

    pose_tbl = load_json(os.path.join(BANK_DIR, 'pose-zh-en.json'))
    hair_tbl = load_json(os.path.join(BANK_DIR, 'hair-zh-en.json'))
    hair_fix = load_json(os.path.join(BANK_DIR, 'hair-color-fix.json'))
    lex = Lex(load_json(os.path.join(BANK_DIR, 'garment-lexicon.json')))

    pose, pose_missing = build_pose(pose_src, pose_tbl)
    hair, hair_missing, hair_left = build_hair(portrait_src, hair_tbl, hair_fix)
    costume, costume_fail = build_costume(costume_src, lex, nvz_src)
    views = build_view()

    pose, pose_dup = dedupe(pose, 'pose')
    costume, costume_dup = dedupe(costume, 'costume')
    hair, hair_dup = dedupe(hair, 'hair')

    lv = {'sfw': 0, 'soft': 0, 'nsfw': 0}
    for it in pose:
        lv[it['level']] = lv.get(it['level'], 0) + 1

    combos = sum(len(it['views']) for it in pose)
    short = [it for it in pose if len(it['views']) < len(VIEW_TABLE)]
    cov = {
        'pose': {'src': len(pose_src), 'built': len(pose), 'missing': len(pose_missing), 'merged': pose_dup},
        'hair': {'src': len(portrait_src), 'built': len(hair), 'missing': len(hair_missing), 'merged': hair_dup},
        'costume': {'src': len(costume_src), 'built': len(costume), 'fallbackKw': len(costume_fail),
                    'merged': costume_dup},
        'view': {'actions': len(pose), 'combos': combos,
                 'full': len(pose) - len(short), 'partial': len(short)},
    }

    print()
    print('=== 生成结果 ===')
    print(f"  姿势  源 {len(pose_src):5d} -> 唯一 {len(pose):4d}  (缺翻译 {len(pose_missing)}, 剥色后合并 {pose_dup})  档位 {lv}")
    print(f"  发型  源 {len(portrait_src):5d} -> 唯一 {len(hair):4d}  (缺翻译 {len(hair_missing)}, 剥色后合并 {hair_dup})")
    print(f"  服装  源 {len(costume_src):5d} -> 唯一 {len(costume):4d}  (降级用关键词 {len(costume_fail)}, 剥色后合并 {costume_dup})")
    print(f"  机位  随动作成套: 组合数 {combos}  (满 5 机位 {len(pose) - len(short)} 个动作, 缺机位 {len(short)} 个)")
    for it in short:
        print(f"          缺: {it['zh']} 只有 {len(it['views'])} 个机位 ({'/'.join(it['views'])})")

    if pose_missing:
        print('\n  [缺姿势翻译]')
        for cat, zh in pose_missing[:40]:
            print(f'    {cat} | {zh}')
    if hair_missing:
        print('\n  [缺发型翻译]')
        for cat, zh in hair_missing[:20]:
            print(f'    {cat} | {zh}')
    if hair_left:
        print('\n  [发型中文仍带颜色词, 补 tools/nl-bank/hair-color-fix.json]')
        for cat, zh, zh2 in hair_left[:40]:
            print(f'    {cat} | {zh} -> {zh2}')
    if costume_fail:
        print(f'\n  [服装降级样例 前 20 / 共 {len(costume_fail)}]')
        for zh in costume_fail[:20]:
            print(f'    {zh}')


    if a.report:
        return 0
    if pose_missing or hair_missing:
        print('\n有缺翻译, 不写产物(先补齐 tools/nl-bank/*.json)')
        return 1
    if hair_left:
        print('\n有发型中文仍带颜色词, 不写产物(补 tools/nl-bank/hair-color-fix.json)')
        return 1

    bank = {
        'meta': {
            'version': 1,
            'generatedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
            'sources': [
                {'name': 'anhao/ai-pose-gallery-zh',
                 'url': 'https://github.com/anhao/ai-pose-gallery-zh',
                 'license': '代码 MIT；图片版权 ギア(@giaaibusi)，禁止打包倒卖 —— 本项目只取文字元数据，不分发图片'},
                {'name': 'paipiange/nvzhuang',
                 'url': 'https://github.com/paipiange/nvzhuang',
                 'license': 'MIT（提供服装英文关键词，本库不打包其图片）'},
            ],
            'counts': {'pose': len(pose), 'costume': len(costume), 'hair': len(hair),
                       'poseView': sum(len(it['views']) for it in pose)},
            'poseLevels': lv,
            'coverage': cov,
        },
        'pose': pose,
        'views': views,
        'costume': costume,
        'hair': hair,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with io.open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(bank, f, ensure_ascii=False, indent=1)
        f.write('\n')
    size = os.path.getsize(a.out)
    print(f'\n已写 {a.out}  {size / 1024:.0f} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
