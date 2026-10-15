# -*- coding: utf-8 -*-
# 直接复用 tagger_serve.py 的 Tagger 封装做端到端推理验证
import sys, io
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"<local-path>")
import tagger_serve as ts

MODEL = r"<local-path>"
CSV   = r"<local-path>"

tg = ts.Tagger(MODEL, CSV, provider="dml", threshold=0.35, char_threshold=0.85)
print("deps_ok:", tg.deps_ok())
tg.load()
print("provider:", tg.provider_used)

for p in sys.argv[1:]:
    r = tg.infer(p)
    print("----", p)
    print("type:", type(r).__name__, "n:", len(r))
    print("top:", r[:15])
