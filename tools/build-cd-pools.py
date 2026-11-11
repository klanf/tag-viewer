#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从本地「1027 张二次元换装图库」(char-db) 生成 knowledge/cd-pools.json
=====================================================================
这是**第三套**动作/穿搭池，与另外两套并列：
  1. tag 槽位池（slot-pools.json，单词 + 词频加权掷骰）—— 粗粒度兜底
  2. 自然语言语料（nl-bank.json，整句自然语言）—— 发牌，Anima 吃自然语言
  3. 本文件（cd-pools.json，**tag 组合串**）—— 发牌，一条就是一套完整写法

为什么是「整串」而不是拆成单词:
  一条动作 = `standing, hands on hips`（2~9 个 tag 的组合），一套穿搭 =
  `serafuku, sailor collar, blue sailor collar, red neckerchief, pleated skirt`。
  灌进单词槽池会撞三堵墙：`withWeight()` 给整串套 `(a, b:1.2)` 是非法的、
  `pickFor()` 的去重认不出串里的单词、`tag_slots.json` 有 253/367(动作) 和
  416/546(穿搭) 的 tag 根本分不进槽。所以这条路线**不进随机引擎**（不参与掷骰、
  权重、批内压重），抽出来直接**并进 tag 段**——tag 串本来就是逗号分隔，并进去
  即合法，权重/去重/排序全都不用管。（2026-11-11 用户定：不再另成"末尾追加一段"。）

清洗规则:
  - 动作库 281 条里有 35 条 `-s` 侧视变体 = 本体 + `from_side, profile, side view`
    （实测 35/35 完全吻合）→ 默认剔除，否则会和机位槽打架。
  - `(covering_ears:1.3)` 这类带权重壳的脏 tag → 剥壳。
  - 串里含 `2girls` / `1boy` 等人数 tag 的条目 → 标记 dual=true，**保留但默认不抽**
    （抽了会和原图的 `1girl` 打架；用户要双人动作时再开）。
  - 会被导出端分段排序当噪声剔掉的词（身份词 `hero` / `valkyrie`、`hood` 等被判成
    角色名）→ 构建期剥掉，否则产物里会**静默少一个词**。名单见 SEG_BLOCKED。

用法:
  python tools/build-cd-pools.py
  python tools/build-cd-pools.py --src "F:/网盘资源/1027 张二次元换装图库/data/items.js" --report
产物: knowledge/cd-pools.json
"""
import argparse
import datetime
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'knowledge', 'cd-pools.json')
DEFAULT_SRC = 'F:/网盘资源/1027 张二次元换装图库/data/items.js'

# 侧视变体带的机位词（用于自检：剥掉这些之后应该等于某条本体）
CAM_TAGS = {'from_side', 'profile', 'side_view'}
# 人数类 tag —— 命中即标 dual（一条 prompt 里只会有一个 count 槽的词）
COUNT_TAG = re.compile(r'^(1girl|2girls|3girls|multiple_girls|1boy|2boys|multiple_boys|'
                       r'1other|solo|1dog|1cat)$')
SHELL = re.compile(r'^\((.+?):\d+(?:\.\d+)?\)$')
# 会被导出端 exportSegSort() 当画师/角色/系列/meta 剔掉的词。原图 tag 里那些是噪声，
# 该剔；但组合串里的这些词是**有意选的**（`hero, armor, breastplate, cape, sword`
# 少了 hero 就散了），而 exportSegSort 只认字符串、分不清来源 —— 所以构建期剥掉，
# 让产物里不出现"该有却没有"的静默缺词。名单由 scripts/test-cd-pools.mjs 的
# 「池里没有会被分段排序吃掉的词」断言守着：换源数据后冒出新词那条断言会红。
SEG_BLOCKED = {
    'female', 'sparkle', 'hero', 'hood', 'adventurer', 'valkyrie', 'unicorn',
}


def tags_of(s):
    """逗号串 → tag 列表（空格归一成下划线），顺手剥权重壳 + 去空 + 去重保序"""
    out = []
    seen = set()
    for raw in str(s or '').split(','):
        t = raw.strip()
        if not t:
            continue
        m = SHELL.match(t)
        if m:
            t = m.group(1).strip()
        t = re.sub(r'\s+', '_', t.lower())
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def build(src_path):
    body = io.open(src_path, encoding='utf-8').read()
    items = json.loads(body[body.index('['):body.rindex(']') + 1])

    stat = {'src': len(items), 'dropped_side': 0, 'dropped_dup': 0,
            'shell_stripped': 0, 'seg_stripped': 0, 'dual': 0}
    pose, outfit = [], []
    seen_pose, seen_outfit = set(), set()

    for it in items:
        kind = it.get('set')
        if kind not in ('pose', 'outfit'):
            continue
        iid = str(it.get('id') or '')
        raw = it.get('full') or it.get('tags') or ''
        if kind == 'pose' and iid.endswith('-s'):
            stat['dropped_side'] += 1
            continue
        if '(' in str(raw):
            stat['shell_stripped'] += 1
        tags = tags_of(raw)
        if not tags:
            continue
        blocked = [t for t in tags if t in SEG_BLOCKED]
        if blocked:
            stat['seg_stripped'] += len(blocked)
            tags = [t for t in tags if t not in SEG_BLOCKED]
            if not tags:
                stat['dropped_dup'] += 1
                continue
        key = ', '.join(tags)
        row = {
            'id': iid,
            'zh': str(it.get('zh') or ''),
            'cat': str(it.get('cat') or ''),
            'tags': key,
        }
        if kind == 'pose':
            if key in seen_pose:
                stat['dropped_dup'] += 1
                continue
            seen_pose.add(key)
            dual = any(COUNT_TAG.match(t) for t in tags)
            if dual:
                stat['dual'] += 1
                row['dual'] = True
            pose.append(row)
        else:
            if key in seen_outfit:
                stat['dropped_dup'] += 1
                continue
            seen_outfit.add(key)
            outfit.append(row)

    # 自检：每条侧视变体剥掉机位词后，都应该在某条本体里出现过
    poses_all = [i for i in items if i.get('set') == 'pose']
    bases = {frozenset(tags_of(i.get('full'))) for i in poses_all if not str(i.get('id')).endswith('-s')}
    side_ok = sum(1 for i in poses_all if str(i.get('id')).endswith('-s')
                  and frozenset(set(tags_of(i.get('full'))) - CAM_TAGS) in bases)

    return {
        '_meta': {
            'schema': 'tag-viewer/cd-pools@1',
            'generatedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
            'source': 'char-db-1027（本地「1027 张二次元换装图库」data/items.js，只取文字元数据）',
            'note': '整串 tag 组合池：不进随机引擎，抽出来直接并进 tag 段（不再末尾追加）。'
                    'dual=true 的条目含人数 tag（2girls 等），默认不抽。',
            'counts': {'pose': len(pose), 'poseDual': stat['dual'], 'outfit': len(outfit)},
        },
        'pose': pose,
        'outfit': outfit,
    }, stat, side_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--report', action='store_true', help='只打统计，不写文件')
    a = ap.parse_args()

    if not os.path.exists(a.src):
        print('源文件不存在: %s' % a.src, file=sys.stderr)
        return 2
    data, stat, side_ok = build(a.src)
    counts = data['_meta']['counts']
    print('动作 %d 条（其中双人 %d）· 穿搭 %d 条' % (counts['pose'], counts['poseDual'], counts['outfit']))
    print('丢弃：侧视变体 %d · 重复整串 %d · 剥权重壳 %d · 剥会被分段排序吃掉的词 %d'
          % (stat['dropped_side'], stat['dropped_dup'], stat['shell_stripped'], stat['seg_stripped']))
    print('自检：侧视变体剥机位词后 == 本体 %d/%d' % (side_ok, stat['dropped_side']))
    if a.report:
        return 0
    with io.open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    print('写入 %s（%.1f KB）' % (a.out, os.path.getsize(a.out) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
