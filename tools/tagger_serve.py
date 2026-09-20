# -*- coding: utf-8 -*-
r"""
WD14 反推常驻服务 (tagger_serve) —— JSON-lines over stdio
=========================================================
给 Electron 侧当**子进程**用: 模型常驻内存, 逐张图接收请求、返回标签。
阶段 3 的队列消费逻辑全在 `electron/core/tagger.js`, 这里只负责"看图说话"。

为什么必须是常驻进程
--------------------
模型 1.27GB。像旧脚本那样"每批图重开一次进程"要反复反序列化 ONNX
(实测冷启动 20-40s), 于是 60 张裸图会被模型加载时间整个吞掉。改成常驻后
单张 ≈180ms(CUDA), 总耗时反而由模型加载主导。

协议(逐行 JSON, 一行一个对象)
------------------------------
  入 (stdin)
    {"id":1,"cmd":"probe"}                    只探活: 导依赖 + 查模型文件, 不加载模型
    {"id":2,"cmd":"infer","path":"F:/a.png"}  单张反推
    {"id":3,"cmd":"ping"}                     心跳
    {"id":4,"cmd":"quit"}                     退出(收到即回执后结束)
  出 (stdout) —— **stdout 上除了 JSON 行不许有任何别的东西**
    {"event":"ready","provider":"CUDAExecutionProvider","model":true,"csv":true}
    {"event":"loaded","ms":1840}              模型首次加载完成(懒加载)
    {"id":2,"ok":true,"path":"...","tags":[...],"text":"1girl, solo","ms":181}
    {"id":2,"ok":false,"error":"..."}
  日志一律走 stderr —— 混进 stdout 会让 JS 侧的逐行 JSON 解析当场报废。

`probe` 刻意**不加载模型**: 启动看板时我们要在几秒内知道"这条路能不能走",
而不是先干等 30 秒。模型留给第一次 infer 时懒加载, 加载完补一条 loaded 事件。

自包含说明(与方案的偏离, 已记录)
--------------------------------
方案原写「外面包一层 `png_meta_backfill.py`, 复用它的 load_model / infer / csv 解析」。
实际改成**自包含**: 那两支旧脚本住在开发机的 `<local-path>`,
本项目正在准备开源(阶段 1 已经把 `LEGACY_DIR` 这类机器绝对路径全部拆掉),
再引入一个指向别人机器的 `sys.path` 依赖与方向相反。这里把
`classify_images_by_wd14.py` 的 preprocess / infer_tags / load_labels 三条**逐行等价**
搬过来, 算法与阈值默认值保持一致 —— 这样历史反推出来的 9000 多条标签
与今天新增的标签才是同一套口径。旧脚本保持原样, 一个字节都不动。

用法(一般不用手敲, 由 electron/core/tagger.js 拉起)
    python -u tools/tagger_serve.py --model <onnx> --csv <csv> [--provider auto]
"""
import argparse
import csv
import json
import os
import sys
import time
import traceback

# Windows 下 stdout 默认走系统 ANSI 代码页(中文机器是 gbk), 输出含中文路径的
# JSON 会直接抛 UnicodeEncodeError; 换行也必须是 \n, 否则 JS 侧按 \n 切行会留下 \r。
try:
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    sys.stderr.reconfigure(encoding='utf-8')
    # stdin 也要显式指定 —— Windows 上 Python 默认走 ANSI 代码页(cp936),
    # 而 JS 侧写进来的是 UTF-8。不指定的话含中文的图片路径会被解错。
    sys.stdin.reconfigure(encoding='utf-8')
except Exception:
    pass


# ============================================================ CUDA 运行库定位

_CUDA_DLL_READY = False


def prepare_cuda_dlls():
    """把 pip 装的 `nvidia-*` 运行库目录挂进 DLL 搜索路径 —— **不开这一步 CUDA 必挂**。

    实测(本机 conda python + onnxruntime 1.22): `ort.get_available_providers()` 里
    明明列着 CUDAExecutionProvider, 但真正建会话时报

        Error loading "…\\onnxruntime\\capi\\onnxruntime_providers_cuda.dll"
        which depends on "cublasLt64_12.dll" which is missing

    因为 CUDA/cuDNN 是以 pip 包形式装在 `site-packages/nvidia/*/bin` 的, 那些目录
    **不在 PATH 上**, 也不在 Windows 的 DLL 搜索路径里。挂上之后 provider 从 CPU
    变成 CUDAExecutionProvider(本机 2.0s/张 -> ~0.19s/张, 十倍)。

    失败一律静默: 用户机器上没装 nvidia-* 包时这段什么都不做, 会话自动退到 CPU,
    只是慢一点, 不该因此整条管道报废。
    """
    global _CUDA_DLL_READY
    if _CUDA_DLL_READY:
        return []
    _CUDA_DLL_READY = True
    dirs = []
    try:
        import site
        roots = list(site.getsitepackages() or [])
        try:
            roots.append(site.getusersitepackages())
        except Exception:
            pass
        for root in roots:
            if not root or not os.path.isdir(root):
                continue
            nv = os.path.join(root, 'nvidia')
            if not os.path.isdir(nv):
                continue
            for name in sorted(os.listdir(nv)):
                for sub in ('bin', 'lib'):
                    p = os.path.join(nv, name, sub)
                    if os.path.isdir(p):
                        dirs.append(p)
    except Exception as e:
        log('扫描 nvidia 运行库目录失败: %s' % e)
        return []
    for p in dirs:
        try:
            os.add_dll_directory(p)
        except Exception:
            pass
    if dirs:
        os.environ['PATH'] = os.pathsep.join(dirs + [os.environ.get('PATH', '')])
        log('已挂载 %d 个 CUDA 运行库目录' % len(dirs))
    return dirs


def out(obj):
    """往 stdout 写一行 JSON —— 全文件只有这一处允许碰 stdout"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + '\n')
    sys.stderr.flush()


# ============================================================ 标签表 / 预处理

def load_labels(csv_path):
    """读 WD14 CSV -> (标签列表, general 起始索引, character 起始索引)

    与 classify_images_by_wd14.load_labels 逐行等价:
      · 第 3 列(category) '0' = general, '4' = character, '9' = rating
      · general/character 的**起始下标**用作分段边界, rating 段整体不参与
    """
    tags = []
    general_index = None
    character_index = None
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        next(reader)                     # 跳过表头
        for row in reader:
            if len(row) < 3:
                continue
            if general_index is None and row[2] == '0':
                general_index = len(tags)
            elif character_index is None and row[2] == '4':
                character_index = len(tags)
            tags.append(row[1])
    if general_index is None:
        general_index = len(tags)
    if character_index is None:
        character_index = len(tags)
    return tags, general_index, character_index


def preprocess(image, height):
    """WD14 风格: 等比缩放到最长边=height + 白底居中补方, 返回 (1,H,W,3) float32 BGR

    与经典实现逐行等价 —— 注意是 **BGR**(`arr[:, :, ::-1]`), 归一化由模型内部自带。
    单张裸图与历史那 9000 多张走的是同一条预处理, 换成 RGB 会让分数整体漂移。
    """
    import numpy as np
    from PIL import Image
    ratio = float(height) / max(image.size)
    new_size = tuple(int(x * ratio) for x in image.size)
    image = image.resize(new_size, Image.LANCZOS)
    square = Image.new('RGB', (height, height), (255, 255, 255))
    square.paste(image, ((height - new_size[0]) // 2, (height - new_size[1]) // 2))
    arr = np.array(square).astype(np.float32)
    arr = arr[:, :, ::-1]                # RGB -> BGR
    return np.expand_dims(arr, 0)


def preprocess_pixai(image):
    """PixAI 官方预处理: 直接拉伸 448x448 + normalize(0.5) + RGB, 返回 (1,3,448,448)

    本机用的就是 PixAI 版模型(`wd-pixai-tagger-v0.9.onnx`), 所以这条才是主路径;
    保留 WD14 分支是为了让换成标准 WD14 模型时也能直接跑。
    """
    import numpy as np
    from PIL import Image
    im = image.resize((448, 448), Image.BILINEAR)
    arr = np.array(im).astype(np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    return np.transpose(arr, (2, 0, 1))[None, ...]


def infer_tags(session, image, tags, general_index, character_index,
               threshold, character_threshold):
    """推理单张 -> [(标签名, 分数, 是否角色标签)], 已按阈值过滤, 不含 rating

    自动兼容 NHWC(标准 WD14)与 NCHW(PixAI)两种输入布局 —— 看输入张量第 2 维是不是 3。
    输出张量的选择同样做了兜底: 优先名字像概率的, 其次宽度等于标签数的,
    最后才退到"宽度 > 1000 的那个", 避免误选 embedding 特征输出。
    """
    import numpy as np
    inp = session.get_inputs()[0]
    shape = inp.shape
    if len(shape) == 4 and shape[1] == 3:
        height = shape[2]                # NCHW -> PixAI
        is_nchw = True
    else:
        height = shape[1]                # NHWC -> WD14
        is_nchw = False
    x = preprocess_pixai(image) if is_nchw else preprocess(image, height)

    input_name = inp.name
    n_tags = len(tags)
    output_name = None
    for o in session.get_outputs():
        if len(o.shape) == 2 and o.shape[1] == n_tags:
            output_name = o.name
            if o.name.lower() in ('prediction', 'probabilities', 'probability', 'probs'):
                break
    if output_name is None:
        for o in session.get_outputs():
            if len(o.shape) == 2 and o.shape[1] > 1000:
                output_name = o.name
                break
    if output_name is None:
        output_name = session.get_outputs()[0].name

    probs = session.run([output_name], {input_name: x})[0][0]
    # 部分导出的模型给的是未归一化 logits(有 >1 或 <0 的值), 补一次 sigmoid
    if np.max(probs) > 1.0 or np.min(probs) < 0.0:
        probs = 1.0 / (1.0 + np.exp(-probs))

    result = []
    for i, prob in enumerate(probs):
        if i < general_index:
            continue                     # rating 段: 不参与
        is_char = i >= character_index
        th = character_threshold if is_char else threshold
        if prob > th:
            result.append((tags[i], float(prob), is_char))
    return result


# ============================================================ 模型会话(懒加载)

class Tagger(object):
    def __init__(self, model, csv_path, provider='auto', threshold=0.35, char_threshold=0.85):
        self.model = model
        self.csv_path = csv_path
        self.provider = provider
        self.threshold = threshold
        self.char_threshold = char_threshold
        self.session = None
        self.tags = None
        self.general_index = None
        self.character_index = None
        self.provider_used = ''
        self.loaded = False
        self.load_ms = 0

    def deps_ok(self):
        """探活用: 只导依赖, 不碰模型。import onnxruntime 约 1-3 秒"""
        try:
            import numpy  # noqa: F401
            import PIL     # noqa: F401
            import onnxruntime as ort
        except Exception as e:
            return False, '缺少依赖: %s' % e
        avail = ort.get_available_providers()
        if not avail:
            return False, 'onnxruntime 没有可用 provider'
        return True, ''

    def _pick_providers(self):
        import onnxruntime as ort
        avail = ort.get_available_providers()
        want = {
            'cuda': 'CUDAExecutionProvider',
            'cpu': 'CPUExecutionProvider',
        }
        if self.provider in want:
            chain = [want[self.provider]]
        else:
            # auto: CUDA 优先, 拿不到就 CPU —— 用户机器上装的是 CPU 版 onnxruntime 时
            # 不该整条管道报废, 只是慢一些(单张 ~1.2s, 60 张也就一分多钟)
            chain = ['CUDAExecutionProvider', 'CPUExecutionProvider']
        picked = [p for p in chain if p in avail]
        if not picked:
            picked = [avail[0]]
        return picked, avail

    def load(self):
        """加载模型 + 标签表(幂等)。第一次 infer 时触发"""
        if self.loaded:
            return
        prepare_cuda_dlls()
        import onnxruntime as ort
        t0 = time.time()
        if not os.path.isfile(self.model):
            raise RuntimeError('模型不存在: %s' % self.model)
        if not os.path.isfile(self.csv_path):
            raise RuntimeError('标签表不存在: %s' % self.csv_path)
        self.tags, self.general_index, self.character_index = load_labels(self.csv_path)
        providers, avail = self._pick_providers()
        so = ort.SessionOptions()
        so.log_severity_level = 3        # 关掉 onnxruntime 的 INFO 噪音(它默认往 stderr 刷)
        try:
            self.session = ort.InferenceSession(self.model, sess_options=so, providers=providers)
        except Exception:
            # 指定 provider 失败(驱动/CUDA 版本不匹配)时退到 CPU 再试一次
            log('provider %s 初始化失败, 退到 CPU' % providers)
            self.session = ort.InferenceSession(
                self.model, sess_options=so, providers=['CPUExecutionProvider'])
        self.provider_used = self.session.get_providers()[0] if self.session.get_providers() else '?'
        self.loaded = True
        self.load_ms = int((time.time() - t0) * 1000)
        log('模型已加载: %s, provider=%s, %d ms, 标签 %d 条'
            % (os.path.basename(self.model), self.provider_used, self.load_ms, len(self.tags)))
        # 也往 stdout 发一条事件: JS 侧要靠它把"实际用了哪个 provider"显示出来。
        # 光看 available_providers 是不够的 —— CUDA 可能因驱动不匹配而初始化失败退到 CPU。
        out({'event': 'loaded', 'ms': self.load_ms,
             'provider': self.provider_used, 'tags': len(self.tags)})

    def infer(self, path):
        from PIL import Image
        self.load()
        im = Image.open(path)
        im = im.convert('RGB')           # 与历史实现一致: alpha 直接丢, 不做黑白底合成
        try:
            found = infer_tags(self.session, im, self.tags, self.general_index,
                               self.character_index, self.threshold, self.char_threshold)
        finally:
            try:
                im.close()
            except Exception:
                pass
        found.sort(key=lambda x: -x[1])
        # 角色标签排在最前(与看板的展示顺序、历史 prompt_text 的写法一致)
        chars = [n for n, s, c in found if c]
        gens = [n for n, s, c in found if not c]
        return chars + gens


# ============================================================ 主循环

def handle(tg, msg):
    cmd = str(msg.get('cmd') or '')
    if cmd == 'ping':
        return {'ok': True, 'pong': True, 'loaded': tg.loaded}
    if cmd == 'probe':
        ok, err = tg.deps_ok()
        _, avail = tg._pick_providers() if ok else ([], [])
        return {
            'ok': bool(ok),
            'error': err,
            'model': os.path.isfile(tg.model),
            'csv': os.path.isfile(tg.csv_path),
            'modelPath': tg.model,
            'csvPath': tg.csv_path,
            'loaded': tg.loaded,
            'providers': avail,
        }
    if cmd == 'infer':
        path = str(msg.get('path') or '')
        if not path:
            return {'ok': False, 'error': '缺少 path'}
        t0 = time.time()
        try:
            tags = tg.infer(path)
        except Exception as e:
            return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e),
                    'trace': traceback.format_exc()[-1200:]}
        return {'ok': True, 'path': path, 'tags': tags,
                'text': ', '.join(tags), 'ms': int((time.time() - t0) * 1000)}
    if cmd == 'quit':
        return {'ok': True, 'bye': True}
    return {'ok': False, 'error': '未知命令: %s' % cmd}


def main():
    ap = argparse.ArgumentParser(description='WD14 反推常驻服务 (JSON-lines over stdio)')
    ap.add_argument('--model', required=True, help='WD14/PixAI onnx 模型路径')
    ap.add_argument('--csv', required=True, help='标签表 csv 路径')
    ap.add_argument('--provider', choices=['auto', 'cuda', 'cpu'], default='auto')
    ap.add_argument('--threshold', type=float, default=0.35, help='普通标签阈值')
    ap.add_argument('--char-threshold', type=float, default=0.85, help='角色标签阈值')
    args = ap.parse_args()

    tg = Tagger(args.model, args.csv, args.provider, args.threshold, args.char_threshold)

    # 握手: 先探活, 让 JS 侧几秒内就知道这条路能不能走(不加载模型)
    ok, err = tg.deps_ok()
    _, avail = tg._pick_providers() if ok else ([], [])
    out({
        'event': 'ready',
        'ok': bool(ok),
        'error': err,
        'model': os.path.isfile(tg.model),
        'csv': os.path.isfile(tg.csv_path),
        'providers': avail,
        'pid': os.getpid(),
    })
    if not ok:
        # 依赖缺失时**不退进程**: 让 JS 侧能拿到明确的 error 文本(而不是"子进程退出 code=1"),
        # 并继续接受 ping/probe。真正该做的降级判断在 JS 侧。
        log('依赖不可用: %s' % err)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            out({'id': None, 'ok': False, 'error': '请求不是合法 JSON: %s' % e})
            continue
        if not isinstance(msg, dict):
            out({'id': None, 'ok': False, 'error': '请求必须是 JSON 对象'})
            continue
        rid = msg.get('id')
        try:
            res = handle(tg, msg)
        except Exception as e:
            res = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e),
                   'trace': traceback.format_exc()[-1200:]}
        res['id'] = rid
        out(res)
        if str(msg.get('cmd')) == 'quit':
            break
    log('tagger_serve 退出')


if __name__ == '__main__':
    main()
