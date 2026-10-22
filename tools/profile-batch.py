# -*- coding: utf-8 -*-
"""
攒批推理收益实测（只读测量，不改任何业务逻辑）
================================================
回答一个问题: 把 tagger 从"一次一张"改成"攒 N 张一起推理"，到底能快多少?

做法: 把每张图的耗时拆成三段
    decode : Image.open + convert('RGB')      —— 纯 CPU, 磁盘 IO + PNG 解压
    prep   : preprocess_pixai (resize 448)    —— 纯 CPU
    run    : session.run(...)                 —— GPU/加速器
只有 run 这一段能被攒批摊薄, 前两段是每张都要付的固定成本。
所以"攒批能提速多少"完全取决于 run 占总耗时的比例。

用法:
    python tools/profile-batch.py                 # 默认 CUDA, 1216x832, 24 张
    python tools/profile-batch.py --provider cpu  # 对照 CPU 跑
    python tools/profile-batch.py --w 832 --h 1216 --n 32
"""
import argparse
import os
import sys
import time
import tempfile

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image

import tagger_serve as ts

MODEL = r'<local-path>'
CSV = r'<local-path>'


def make_images(n, w, h, d):
    """生成 n 张仿真尺寸的 PNG —— 噪声图, PNG 体积和解码开销接近真实出图"""
    rng = np.random.default_rng(7)
    paths = []
    for i in range(n):
        arr = rng.integers(0, 255, size=(h, w, 3), dtype=np.uint8)
        p = os.path.join(d, 'p%03d.png' % i)
        Image.fromarray(arr).save(p, compress_level=6)
        paths.append(p)
    return paths


def timed(fn, repeat):
    """跑 repeat 次, 返回平均毫秒"""
    fn()                       # warmup
    t0 = time.perf_counter()
    for _ in range(repeat):
        fn()
    return (time.perf_counter() - t0) / repeat * 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--provider', default='cuda')
    ap.add_argument('--w', type=int, default=1216)
    ap.add_argument('--h', type=int, default=832)
    ap.add_argument('--n', type=int, default=24, help='生成多少张图')
    ap.add_argument('--repeat', type=int, default=3, help='每种配置重复几轮取平均')
    args = ap.parse_args()

    d = tempfile.mkdtemp(prefix='tgprof-')
    paths = make_images(args.n, args.w, args.h, d)
    size_mb = os.path.getsize(paths[0]) / 1024 / 1024
    print('测试图: %d 张 %dx%d PNG, 单张约 %.2f MB (目录 %s)' % (args.n, args.w, args.h, size_mb, d))

    tg = ts.Tagger(MODEL, CSV, provider=args.provider)
    tg.load()
    print('provider: %s, 加载 %d ms, 标签 %d 条\n' % (tg.provider_used, tg.load_ms, len(tg.tags)))

    sess = tg.session
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    for o in sess.get_outputs():
        if len(o.shape) == 2 and o.shape[1] == len(tg.tags):
            out_name = o.name
            break

    # ---------- 1) 逐张: 三段各自的耗时 ----------
    def decode_only(p):
        im = Image.open(p)
        im = im.convert('RGB')
        im.close()

    def prep_only(p):
        im = Image.open(p).convert('RGB')
        x = ts.preprocess_pixai(im)
        im.close()
        return x

    def infer_one(p):
        im = Image.open(p).convert('RGB')
        x = ts.preprocess_pixai(im)
        sess.run([out_name], {in_name: x})
        im.close()

    t_decode = timed(lambda: [decode_only(p) for p in paths], args.repeat) / len(paths)
    t_prep_only = timed(lambda: [prep_only(p) for p in paths], args.repeat) / len(paths)
    t_one_total = timed(lambda: [infer_one(p) for p in paths], args.repeat) / len(paths)
    t_prep = t_prep_only - t_decode          # 预处理净耗时
    t_run1 = t_one_total - t_prep_only       # batch=1 的 run 净耗时

    print('【逐张】每张 %.1f ms  =  解码 %.1f + 预处理 %.1f + 推理(batch=1) %.1f'
          % (t_one_total, t_decode, t_prep, t_run1))
    print('       → 推理只占 %.0f%%, 其余 %.0f%% 是 CPU 侧的固定成本(攒批摊不掉)\n'
          % (t_run1 / t_one_total * 100, (t_one_total - t_run1) / t_one_total * 100))

    # ---------- 2) 攒批: 不同 batch 的 run 耗时 ----------
    xs = [ts.preprocess_pixai(Image.open(p).convert('RGB')) for p in paths]
    print('【攒批】run 段耗时 vs batch(仍是同样的图, 只是拼起来一起送进去)')
    print('  batch    run总ms    每张摊到ms    相当于逐张的')
    base = t_run1
    for b in (1, 2, 4, 8, 16, 32):
        if b > len(xs):
            continue
        batch = np.concatenate(xs[:b], axis=0)
        ms = timed(lambda: sess.run([out_name], {in_name: batch}), args.repeat)
        per = ms / b
        print('  %5d   %8.1f   %10.1f   %10.2fx' % (b, ms, per, base / per))

    # ---------- 3) 端到端: 处理 N 张的总墙钟时间 ----------
    print('\n【端到端】处理 %d 张的总时间(含解码+预处理, 这是用户真正感知的)' % len(paths))
    n = len(paths)
    t_seq = timed(lambda: [infer_one(p) for p in paths], args.repeat)

    def batched(b):
        for i in range(0, n, b):
            chunk = paths[i:i + b]
            ims = [Image.open(p).convert('RGB') for p in chunk]
            batch = np.concatenate([ts.preprocess_pixai(im) for im in ims], axis=0)
            sess.run([out_name], {in_name: batch})
            for im in ims:
                im.close()

    print('  batch    总ms    相比逐张    每张ms')
    for b in (1, 2, 4, 8, 16):
        if b > n:
            continue
        t = timed(lambda: batched(b), args.repeat)
        print('  %5d  %7.0f   %8.2fx   %7.1f' % (b, t, t_seq / t, t / n))

    print('\n注: 尾批不满时要么 padding(浪费算力) 要么单独跑(多一次 run 开销)。')
    print('测完记得删临时目录:', d)


if __name__ == '__main__':
    main()
