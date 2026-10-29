# M0-1 机器学习服务：原生运行与 CoreML 加速

- 分支：`mac/feat/m0-spike`（基于 `v3.3.5`）
- 机器：Apple M4 Pro，64 GB，macOS 15.6
- 日期：2026-10-29
- 结论：**通过（有一个已知问题，已有规避方案）**

## 结论摘要

| 项目 | 状态 | 结论 |
|---|---|---|
| 机器学习服务原生运行 + CoreML | 通过 | 不改官方代码即可运行；人脸识别吞吐提升约 1.8 倍，并让出约一半 CPU |
| R4：gunicorn fork 与 CoreML 的兼容性 | 出现过 1 次崩溃，之后未复现 | 正式部署改用单进程启动，规避该问题 |

## 1. 本机环境

运行 `macos/scripts/m0-check-env.sh` 的结果：

- 本机原有的 Homebrew 装在 `/usr/local`，是 **Intel 版本（通过 Rosetta 运行）**，`/usr/local/bin/python3` 也是 x86_64。在 Intel 版环境下，onnxruntime 拿不到 CoreML，原生库的性能也会打折扣，**不能用于本项目**。已另装 arm64 Homebrew（`/opt/homebrew`），见 [`m0-env.md`](m0-env.md)。
- `uv` 和 uv 管理的 Python 3.12 都是 arm64，可以直接用。

## 2. 机器学习服务

安装：在 `machine-learning/` 目录下，用 arm64 的 Python 3.12 执行 `uv sync --frozen --extra cpu`。

- onnxruntime 1.30.0 可用的加速方式：`CoreMLExecutionProvider`、`CPUExecutionProvider`。代码会自动选用 CoreML，**不需要改任何代码**。
- 官方单元测试：176 个通过，5 个跳过。

### 2.1 单请求延迟（每个输入跑 5 次，取中位数）

测试脚本：`macos/scripts/m0_ml_bench.py run/compare`。测试图片来自 `e2e/test-assets`，模型使用服务端默认值（`ViT-B-32__openai`、`buffalo_l`、`PP-OCRv5_mobile`）。

| 任务 | CPU | CoreML | 提速倍数 | 结果一致性 |
|---|---|---|---|---|
| CLIP 图像编码 | 18.3 ms | 21.7 ms | 0.84 倍 | 余弦相似度 1.0000 |
| CLIP 文本编码 | 8.1 ms | 4.9 ms | 1.65 倍 | 余弦相似度 1.0000 |
| 人脸检测 + 识别 | 55.7 ms | 22.9 ms | 2.43 倍 | 人脸数相同，特征向量余弦相似度 1.0000 |
| OCR | 312 ms | 356 ms | 0.88 倍 | 有差异，见 2.3 |

### 2.2 4 路并发吞吐（每项 200 个请求）

测试脚本：`m0_ml_bench.py load`。这一项更接近服务端实际跑批量任务的情况。

| 任务 | CPU 吞吐 | CoreML 吞吐 | CPU 平均占用核数 | CoreML 平均占用核数 |
|---|---|---|---|---|
| CLIP 图像编码 | 68.8 张/秒 | 82.7 张/秒 | 4.6 | 3.1 |
| 人脸 | 41.3 张/秒 | 73.2 张/秒 | 5.0 | 2.4 |
| OCR | 11.1 张/秒 | 10.7 张/秒 | 5.6 | 3.6 |

结论：
- M4 Pro 的 CPU 本身就很快，CoreML 主要的好处是**吞吐更高、占用的 CPU 更少**，省下的 CPU 可以留给缩略图生成和视频转码。
- OCR 用 CoreML 吞吐没有提升。原因是 OCR 的识别模型被 CoreML 拆成了很多段（日志显示：313 个节点被分成 29 段，其中 285 个节点能由 CoreML 执行），每段之间都要在 CPU 和 GPU 之间来回切换。后续可以考虑 **OCR 单独走 CPU**，这需要一个小补丁，让不同模型可以分别指定加速方式。
- 首次加载模型时 CoreML 需要先编译：OCR 约 15 秒，人脸约 5 秒。编译结果缓存在 `<模型缓存目录>/<模型>/coreml/` 下，之后再加载就很快。

### 2.3 OCR 结果差异

- `japanese-shop.jpg`：CPU 识别出 4 行，CoreML 识别出 3 行，少了一行置信度刚过阈值（0.866）的"リン"。
- `book-beside-flowers.jpg`：16 行中有 11 行完全相同，其余 5 行只有个别字符不同（如 `arsi` / `arivi`）。
- 这是 GPU 用半精度累加带来的正常误差（相关参数 `AllowLowPrecisionAccumulationOnGPU=1`），不影响搜索。如果后续要求和 Docker 版的结果逐字一致，可以 OCR 单独走 CPU。

### 2.4 风险 R4：CoreML 崩溃

- **现象**：第一次用官方入口（`python -m immich_ml`，即 gunicorn 主进程 fork 出 uvicorn 工作进程）运行 CLIP 图像编码时，工作进程崩溃退出（SIGABRT）。报错是 MetalPerformanceShaders 的断言失败：`Compiler encountered XPC_ERROR_CONNECTION_INVALID`。gunicorn 随后自动拉起了新的工作进程，但那一次请求失败了。
- **复现情况**：
  - 不经过 fork、单进程直接运行：全部任务首次编译和后续运行都正常。
  - 回到 gunicorn 入口：在保留编译缓存的情况下跑 1 轮，以及清空 CoreML 编译缓存后再跑 3 轮（`macos/scripts/m0-ml-repro-crash.sh gunicorn 3`），**都没有再崩溃**。
- **推测（未证实）**：问题出在 fork 出来的进程**第一次**通过 XPC 调用系统的 Metal 编译服务时。崩溃之后，系统级的 Metal 缓存（`$(getconf DARWIN_USER_CACHE_DIR)/com.apple.metal`）已经写好，所以后面无法再复现。全新安装、或者系统更新导致缓存失效时，可能会再次出现。
- **对策**：
  1. 原生部署时用单进程启动机器学习服务（官方配置本来就是 `workers=1`，gunicorn 在这里只负责进程管理，去掉它不影响性能），由 launchd 或我们的进程管理器负责崩溃后自动重启。
  2. 安装完成后先预热一次（预加载默认模型，生成编译缓存）。
  3. 如需彻底确认，可以清空上面那个系统 Metal 缓存目录后再复现。这会影响本机其他应用的着色器缓存，所以这次没做。

## 3. 后续事项

1. M1 中机器学习服务改为单进程启动，由进程管理器负责崩溃重启；安装后预热默认模型。
2. 评估"按模型分别指定加速方式"的补丁（OCR 走 CPU），视 M1 实测再定。

## 附：脚本

| 脚本 | 用途 |
|---|---|
| `macos/scripts/m0-check-env.sh` | 检查工具链：是否为 arm64、是否缺失依赖、ffmpeg 和 libvips 支持的能力 |
| `macos/scripts/m0-ml-serve.sh coreml\|cpu [端口]` | 原生启动机器学习服务（`cpu` 模式强制只用 CPU，作为对照） |
| `macos/scripts/m0_ml_bench.py run\|compare\|load` | 测单请求延迟、对比两次结果的一致性、测并发吞吐和 CPU 占用 |
| `macos/scripts/m0-ml-repro-crash.sh gunicorn\|single [轮数]` | 清空 CoreML 编译缓存后复现崩溃 |

模型缓存默认放在 `~/Library/Caches/immich-m0/`（约 3.7 GB），可以用环境变量 `MACHINE_LEARNING_CACHE_FOLDER` 改位置。
