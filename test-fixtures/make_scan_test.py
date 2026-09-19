"""
生成 e2e 用的测试图片 —— 手工拼最小 PNG, 内嵌各种来源的提示词元数据。
不依赖 PIL, 这样在任何 Python 上都跑得起来。

产出目录: 默认 <本脚本同级>/scan-test, 可用 --out 指定
  a1.png / a2.png  ComfyUI 节点图, 提示词**完全相同**(用于验证"同提示词换种子"的识别)
  a3.png           ComfyUI 节点图, 换成另一个角色
  a4.png           A1111 parameters 格式
  a5.png           纯图, 无任何元数据
"""
import argparse
import json
import os
import struct
import zlib
from pathlib import Path

# 默认落在脚本旁边(仓库内), 不再写死开发机绝对路径
DEFAULT_OUT = str(Path(__file__).resolve().parent / 'scan-test')


def chunk(ctype: bytes, data: bytes) -> bytes:
    return (struct.pack('>I', len(data)) + ctype + data
            + struct.pack('>I', zlib.crc32(ctype + data) & 0xffffffff))


def write_png(path, texts=(), rgb=(200, 90, 120)):
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    raw = b'\x00' + bytes(rgb)
    idat = zlib.compress(raw)
    body = sig + chunk(b'IHDR', ihdr)
    for k, v in texts:
        body += chunk(b'tEXt', k.encode('latin1') + b'\x00' + v.encode('utf-8'))
    body += chunk(b'IDAT', idat) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(body)


def comfy(text: str, negative: str = 'lowres, bad anatomy, worst quality'):
    """最小可用的 ComfyUI 节点图: 一个正向 CLIPTextEncode + 一个负向"""
    return json.dumps({
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': negative}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'text': text}},
        '9': {'class_type': 'SaveImage', 'inputs': {'filename_prefix': 'e2e_test'}},
    }, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser(description='生成 e2e 测试图片')
    ap.add_argument('--out', default=DEFAULT_OUT, help='产出目录(默认: 脚本同级 scan-test/)')
    OUT = ap.parse_args().out
    os.makedirs(OUT, exist_ok=True)
    P1 = ('masterpiece, best quality, 1girl, hoshino \\(blue archive\\), halo, '
          'pink hair, smile, outdoors, day, sky, clouds')
    P2 = ('masterpiece, best quality, 1girl, arona \\(blue archive\\), halo, '
          'blue hair, sitting, indoors, window')
    P3 = ('best quality, 1girl, shiroko \\(blue archive\\), wolf ears, '
          'grey hair, standing, night, city')

    write_png(f'{OUT}/a1.png', [('prompt', comfy(P1))])
    write_png(f'{OUT}/a2.png', [('prompt', comfy(P1))], rgb=(190, 100, 130))
    write_png(f'{OUT}/a3.png', [('prompt', comfy(P2))], rgb=(90, 140, 200))
    write_png(f'{OUT}/a4.png', [('parameters',
                                P3 + '\nNegative prompt: lowres, bad hands\n'
                                'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, '
                                'Seed: 1234567890, Size: 832x1216, Model: animagineXL')])
    write_png(f'{OUT}/a5.png', [])          # 无元数据

    for f in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, f)
        print(f'{f}  {os.path.getsize(p)} bytes')
    print('OUT =', OUT)


if __name__ == '__main__':
    main()
