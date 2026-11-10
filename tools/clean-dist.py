"""tag-viewer-electron 构建/测试产物清理 —— 显式路径，不用通配符递归删。

预演: python clean_dist.py
执行: python clean_dist.py --go
"""
import os
import shutil
import sys

ROOT = r'D:\workbuddy\projects\tag-viewer-electron'

# (路径, 说明)  —— 全部是可重建或已下架的产物
TARGETS = [
    (rf'{ROOT}\dist\win-unpacked', 'electron-builder 解包中间产物（npm run dist 重建）'),
    (rf'{ROOT}\dist\update-v2.4.0', 'v2.4.0 分片（已从 Gitee 下架）'),
    (rf'{ROOT}\dist\TagViewer-Setup-2.4.0.exe', 'v2.4.0 安装包（缺知识包的坏包）'),
    (rf'{ROOT}\dist\TagViewer-Setup-2.4.0.exe.blockmap', 'v2.4.0 blockmap'),
    (rf'{ROOT}\dist\TagViewer-引导安装器-v2.4.0.exe', 'v2.4.0 引导安装器'),
    (r'D:\workbuddy\_tmp\tvrepro', '本轮调试临时目录（含真实库副本/复现脚本）'),
    (rf'{ROOT}\.e2e-work\export-dest', 'e2e 导出目标目录（跑测试重建）'),
    (rf'{ROOT}\.e2e-work\shots', 'e2e 截图（跑测试重建）'),
    (rf'{ROOT}\.e2e-work\menu-check', '菜单验证临时 userdata'),
    (rf'{ROOT}\.e2e-work\userdata', 'e2e userdata'),
]


def size_of(p):
    if os.path.isfile(p):
        return os.path.getsize(p)
    total = 0
    for base, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(base, f))
            except OSError:
                pass
    return total


go = '--go' in sys.argv
total = 0
print('=== 清理清单 ===')
for path, why in TARGETS:
    if not os.path.exists(path):
        print(f'  跳过（不存在）  {path}')
        continue
    sz = size_of(path)
    total += sz
    print(f'  {sz/1048576:8.1f} MB  {os.path.relpath(path, ROOT) if path.startswith(ROOT) else path}')
    print(f'             ↳ {why}')

print(f'\n合计可回收 {total/1048576:.1f} MB ({total/1073741824:.2f} GB)')

if not go:
    print('\n[预演] 未删除任何东西。加 --go 执行。')
    sys.exit(0)

print('\n=== 执行 ===')
freed = 0
for path, _ in TARGETS:
    if not os.path.exists(path):
        continue
    sz = size_of(path)
    try:
        if os.path.isfile(path):
            os.remove(path)
        else:
            shutil.rmtree(path)
        freed += sz
        print(f'  ✓ 已删 {os.path.basename(path)}  ({sz/1048576:.1f} MB)')
    except Exception as e:
        print(f'  ✗ 失败 {path}: {e}')

print(f'\n实际回收 {freed/1048576:.1f} MB')

# 删除后核对
print('\n=== 保留项核对 ===')
for p in [rf'{ROOT}\dist\update-v2.4.1', rf'{ROOT}\dist\TagViewer-Setup-2.4.1.exe',
          rf'{ROOT}\dist\TagViewer-引导安装器-v2.4.1.exe', rf'{ROOT}\data\models',
          rf'{ROOT}\node_modules']:
    print(f"  {'✓ 在' if os.path.exists(p) else '✗ 不见了'}  {os.path.basename(p)}")
