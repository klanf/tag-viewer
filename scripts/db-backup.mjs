/**
 * tags.db 一致性备份
 * =================
 * 直接 `cp` 一个正在被 App 使用的 SQLite 库**不安全** —— 复制过程中若有写入，
 * 得到的是撕裂的副本（WAL 模式下尤其明显）。这里用 `VACUUM INTO`，
 * 它在事务层做快照，**即使 App 正在跑也能拿到一致的备份**。
 *
 * 用法:
 *   node scripts/db-backup.mjs                # 备份到 data/tags.db.bak-<日期>，已存在则跳过
 *   node scripts/db-backup.mjs --force        # 覆盖已存在的备份
 *   node scripts/db-backup.mjs --suffix pre-v2 # 自定义后缀 → data/tags.db.bak-pre-v2
 *   node scripts/db-backup.mjs --list         # 只列出现有备份
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TV_DATA_DIR
  ? path.resolve(process.env.TV_DATA_DIR)
  : path.join(ROOT, 'data');
const SRC = path.join(DATA_DIR, 'tags.db');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const LIST = argv.includes('--list');
const sufIdx = argv.indexOf('--suffix');
const stamp = sufIdx >= 0
  ? argv[sufIdx + 1]
  : new Date().toISOString().slice(0, 10).replace(/-/g, '');

const BAK = path.join(DATA_DIR, `tags.db.bak-${stamp}`);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function listBackups() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('tags.db.bak-'))
    .map((f) => {
      const p = path.join(DATA_DIR, f);
      const st = fs.statSync(p);
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

if (LIST) {
  const all = listBackups();
  console.log(`数据目录: ${DATA_DIR}`);
  if (!all.length) console.log('(没有备份)');
  for (const b of all) {
    console.log(`  ${b.name.padEnd(32)} ${mb(b.size).padStart(9)}  ${new Date(b.mtime).toLocaleString('zh-CN')}`);
  }
  process.exit(0);
}

if (!fs.existsSync(SRC)) {
  console.error(`✗ 源库不存在: ${SRC}`);
  process.exit(1);
}

if (fs.existsSync(BAK) && !FORCE) {
  console.log(`· 备份已存在，跳过: ${path.relative(ROOT, BAK)}  (${mb(fs.statSync(BAK).size)})`);
  console.log('  要覆盖请加 --force');
  process.exit(0);
}

const db = new DatabaseSync(SRC);
db.exec('PRAGMA busy_timeout=15000');

// 备份前先记录库内数字，便于事后核对「备份是不是同一时刻的状态」
const before = {
  images: db.prepare('select count(*) c from images').get().c,
  tags: db.prepare('select count(*) c from tags').get().c,
  src: db.prepare('select count(*) c from src').get().c,
};

const t0 = Date.now();
db.exec(`VACUUM INTO '${BAK.replace(/\\/g, '/')}'`);
const ms = Date.now() - t0;
db.close();

// 验证备份可打开且数字一致 —— 不做验证的备份等于没有备份
const chk = new DatabaseSync(BAK, { readOnly: true });
const after = {
  images: chk.prepare('select count(*) c from images').get().c,
  tags: chk.prepare('select count(*) c from tags').get().c,
  src: chk.prepare('select count(*) c from src').get().c,
};
const integrity = chk.prepare('PRAGMA integrity_check').get();
chk.close();

const same = JSON.stringify(before) === JSON.stringify(after);
console.log(`✓ 备份完成: ${path.relative(ROOT, BAK)}  ${mb(fs.statSync(BAK).size)}  用时 ${ms}ms`);
console.log(`  源库   images=${before.images} tags=${before.tags} src=${before.src}`);
console.log(`  备份   images=${after.images} tags=${after.tags} src=${after.src}`);
console.log(`  一致性 ${same ? '✓ 数字完全一致' : '✗ 数字不一致，备份不可信'}`);
console.log(`  integrity_check = ${integrity.integrity_check}`);
if (!same || integrity.integrity_check !== 'ok') process.exit(1);
