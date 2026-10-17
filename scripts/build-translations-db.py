#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把三个翻译源合并成一个内置库 assets/translations.db
====================================================
源(优先级从低到高, 后者覆盖前者):
  1. knowledge/weilin_data(雷昂_Lion@bilibil)/userdatas_zh_CN_danbooru.db
     (danbooru_tag 表: tag -> translate)
  2. knowledge/weilin_data(雷昂_Lion@bilibil)/userdatas_zh_CN_tags.db
     (tag_tags 表: text -> desc)
  3. data/local_translations.json  (AI 补译, 5487 条, 运行时 tagedit 还会继续写它)

输出 schema:
  CREATE TABLE translations(en TEXT PRIMARY KEY, zh TEXT NOT NULL, src TEXT)
    -- src: 'weilin_danbooru' | 'weilin_tags' | 'local'
  CREATE TABLE tag_cats(en TEXT PRIMARY KEY, grp TEXT NOT NULL)
    -- 韦林人工分类(2026-10-17 并入): userdatas_zh_CN_tags.db 的
    -- tag_tags -> tag_subgroups -> tag_groups 三表联查(~5583 条)。
    -- 随包分发后, 没装韦林插件的用户也能拿到完整分类(tagcats.js 回落读这里)。

运行时(electron/core/translate.js)直接读这个真实文件 —— 不走 asar,
node:sqlite 的原生 sqlite3 打不开 asar 虚拟路径, 这正是 2.2.0 包里翻译
整体消失的根因。源文件(knowledge/ 两个 db)保留在仓库里作存档, 不再打包。

用法: python scripts/build-translations-db.py [--check]
  --check  只比对现有 translations.db 是否与源一致(幂等, 给 CI/预检用)
"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEILIN_DIR = ROOT / "knowledge" / "weilin_data(雷昂_Lion@bilibil)"
LOCAL_JSON = ROOT / "data" / "local_translations.json"
OUT = ROOT / "assets" / "translations.db"

JOBS = [
    ("userdatas_zh_CN_danbooru.db", "danbooru_tag", "tag", "translate", "weilin_danbooru"),
    ("userdatas_zh_CN_tags.db", "tag_tags", "text", "desc", "weilin_tags"),
]


def collect():
    """返回 {en_lower: (zh, src)}, 后写的覆盖先写的。"""
    merged = {}
    for fname, table, kcol, vcol, src in JOBS:
        fp = WEILIN_DIR / fname
        if not fp.exists():
            sys.exit(f"源缺失: {fp}")
        con = sqlite3.connect(f"file:{fp.as_posix()}?mode=ro", uri=True)
        try:
            rows = con.execute(f"SELECT {kcol}, {vcol} FROM {table}").fetchall()
        finally:
            con.close()
        n = 0
        for k, v in rows:
            if not k or not v:
                continue
            merged[str(k).strip().lower()] = (str(v), src)
            n += 1
        print(f"  {fname}: {n} 条")
    if LOCAL_JSON.exists():
        d = json.loads(LOCAL_JSON.read_text(encoding="utf-8"))
        n = 0
        for k, v in d.items():
            if k and v and isinstance(v, str):
                merged[str(k).strip().lower()] = (v, "local")
                n += 1
        print(f"  local_translations.json: {n} 条 (覆盖层)")
    return merged


def collect_cats():
    """韦林人工分类: {text: 组名}, 来自 tag_tags -> tag_subgroups -> tag_groups。"""
    fp = WEILIN_DIR / "userdatas_zh_CN_tags.db"
    if not fp.exists():
        sys.exit(f"源缺失: {fp}")
    con = sqlite3.connect(f"file:{fp.as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT t.text AS text, g.name AS grp "
            "FROM tag_tags t "
            "JOIN tag_subgroups s ON s.id_index = t.subgroup_id "
            "JOIN tag_groups g ON g.id_index = s.group_id"
        ).fetchall()
    finally:
        con.close()
    cats = {}
    for text, grp in rows:
        if text and grp:
            cats[str(text).strip()] = str(grp)
    return cats


def build():
    merged = collect()
    cats = collect_cats()
    OUT.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(OUT)
    try:
        con.execute("DROP TABLE IF EXISTS translations")
        con.execute(
            "CREATE TABLE translations("
            "en TEXT PRIMARY KEY, zh TEXT NOT NULL, src TEXT NOT NULL)"
        )
        con.executemany(
            "INSERT OR REPLACE INTO translations(en, zh, src) VALUES (?, ?, ?)",
            [(k, zh, src) for k, (zh, src) in merged.items()],
        )
        con.execute("DROP TABLE IF EXISTS tag_cats")
        con.execute("CREATE TABLE tag_cats(en TEXT PRIMARY KEY, grp TEXT NOT NULL)")
        con.executemany(
            "INSERT OR REPLACE INTO tag_cats(en, grp) VALUES (?, ?)",
            list(cats.items()),
        )
        con.commit()
    finally:
        con.close()
    size = OUT.stat().st_size
    print(f"写入 {OUT.relative_to(ROOT)}: 翻译 {len(merged)} 条 + 分类 {len(cats)} 条, {size:,} B")


def check():
    """输出库与重新合并的结果是否一致(条数 + 抽样)。"""
    merged = collect()
    cats = collect_cats()
    con = sqlite3.connect(f"file:{OUT.as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT en, zh, src FROM translations").fetchall()
        cats_db = dict(con.execute("SELECT en, grp FROM tag_cats").fetchall())
    finally:
        con.close()
    db = {k: (zh, src) for k, zh, src in rows}
    if len(db) != len(merged):
        print(f"不一致: db={len(db)} 条, 源合并={len(merged)} 条")
        return 1
    diff = [(k, db.get(k), merged[k]) for k in merged if db.get(k) != merged[k]]
    if diff:
        print(f"内容不一致 {len(diff)} 条, 例: {diff[:3]}")
        return 1
    if cats_db != cats:
        diffc = {k for k in set(cats_db) | set(cats) if cats_db.get(k) != cats.get(k)}
        print(f"分类不一致 {len(diffc)} 条, 例: {list(diffc)[:3]}")
        return 1
    print(f"一致: 翻译 {len(db)} 条 + 分类 {len(cats_db)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv else build() or 0)
