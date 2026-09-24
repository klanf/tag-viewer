"""实测 rundll32 OpenAs_RunDLL 的输出到底在哪里。

v1 的教训：rundll32 进程自己只有隐藏的 `RunDLL` / `IME` 辅助窗口（那是 rundll32 的
壳，不是对话框），**别对它发 WM_CLOSE**。现代 Windows 的「你要如何打开这个文件？」
是 OpenWith.exe / dllhost.exe 画的另一个进程。

v2 的判据：
  1. 开跑前记下 OpenWith / dllhost 的 PID 集合（差值 = 本次新起的）；
  2. 轮询所有顶层**可见**窗口，只报标题含「打开方式 / Open with / 你要如何」的；
  3. 收尾只关「本次新起进程」的窗口 / 结束本次新起的进程 —— 不碰任何别的东西。
"""
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

user32 = ctypes.WinDLL('user32', use_last_error=True)
WM_CLOSE = 0x0010
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

TITLE_KEYS = ('打开方式', 'Open with', '你要如何', 'How do you want to open')


def top_windows():
    out = []

    def cb(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        wpid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        out.append((hwnd, wpid.value, cls.value, title.value))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def pids_by_name(names):
    """用 tasklist 拿进程清单（不按名字杀，只用来看「新起了谁」）"""
    try:
        r = subprocess.run(['tasklist', '/fo', 'csv', '/nh'], capture_output=True, text=True,
                           encoding='gbk', errors='replace', timeout=20)
    except Exception as e:
        print('  tasklist 失败:', e)
        return {}
    found = {}
    for line in r.stdout.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() in names:
            found.setdefault(parts[0].lower(), set()).add(parts[1])
    return found


def main(path):
    before = pids_by_name({'openwith.exe', 'dllhost.exe', 'rundll32.exe'})
    print('开跑前 openwith/dllhost/rundll32 的 PID:',
          {k: sorted(v) for k, v in before.items()})

    print('\n--- 起进程 ---')
    p = subprocess.Popen(['rundll32.exe', 'shell32.dll,OpenAs_RunDLL', path])
    print('  rundll32 pid =', p.pid)

    hit = []
    for i in range(40):                       # 最多等 10s
        time.sleep(0.25)
        for hwnd, pid, cls, title in top_windows():
            if title and any(k in title for k in TITLE_KEYS):
                hit.append((hwnd, pid, cls, title))
        if hit:
            print(f'  第 {i * 0.25:.2f}s 找到对话框')
            break

    after = pids_by_name({'openwith.exe', 'dllhost.exe', 'rundll32.exe'})
    new_pids = {}
    for k, v in after.items():
        d = v - before.get(k, set())
        if d:
            new_pids[k] = sorted(d)
    print('  本次新起的进程:', new_pids)
    print('  rundll32 自己还活着 =', p.poll() is None)

    if not hit:
        print('  ⚠️ 10s 内没有任何「打开方式」对话框')
    for hwnd, pid, cls, title in hit:
        print(f'  对话框 hwnd={hwnd} pid={pid} 类={cls!r} 标题={title!r}')

    # 收尾 1：只关标题命中的对话框
    for hwnd, pid, cls, title in hit:
        print(f'  → WM_CLOSE 对话框 hwnd={hwnd} (pid={pid})')
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    time.sleep(1.0)

    # 收尾 2：本次新起的进程，按 PID 结束（只动新起的这些）
    for name, pids in new_pids.items():
        for pid in pids:
            print(f'  → taskkill 本次新起进程 {name} pid={pid}')
            subprocess.run(['taskkill', '/PID', pid, '/T', '/F'], capture_output=True)

    # 收尾 3：rundll32 自己
    if p.poll() is None:
        print(f'  → taskkill rundll32 pid={p.pid}')
        subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)
    print('  rundll32 最终 status =', p.poll())
    time.sleep(0.3)
    left = [w for w in top_windows() if w[3] and any(k in w[3] for k in TITLE_KEYS)]
    print('  残留的「打开方式」对话框:', left)


if __name__ == '__main__':
    t = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'test-fixtures', 'scan-test', 'a1.png')
    print('目标文件:', t, '存在 =', os.path.exists(t))
    main(t)
