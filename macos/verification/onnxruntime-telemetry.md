# onnxruntime 遥测：跟进上游 v3.3.6

- 分支：`mac/develop`（合入上游 `v3.3.6`）
- 日期：2026-11-06
- 结论：Mac 版用的 onnxruntime 1.30.0（PyPI 的 macOS arm64 包）自带遥测，会把设备和模型使用情况发给微软，mac.1 到 mac.11 都受影响。上游 v3.3.6 在 `immich_ml` 包加载时设置 `ORT_DISABLE_TELEMETRY=1`；Mac 版另外在 `run-service`、打包和安装脚本里也设置了这个变量，没有加载 `immich_ml` 就调用 onnxruntime 的地方也覆盖到。实测改后不再写遥测库。从 `v3.3.6-mac.1` 起生效

## 上游的说明

> Unfortunately we missed that onnxruntime enabled telemetry by default in a recent release, resulting in the ML container automatically sending anonymous metric data to Microsoft.

上游的修复（#32956）：
- `machine-learning/immich_ml/__init__.py`：`os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")`；
- Docker 镜像自己编译的 onnxruntime 加 `--no_telemetry`。Mac 版用的是 PyPI 的包，不经过这一步。

## Mac 版也受影响

| 查的内容 | 结果 |
|---|---|
| 安装包里的 `libonnxruntime.1.30.0.dylib` | 带 `core/platform/posix/telemetry.cc`、Microsoft 1DS 事件库，上报地址 `https://mobile.events.data.microsoft.com/OneCollector/1.0`，读取 `ORT_DISABLE_TELEMETRY` |
| 本机（mac.7 正在运行） | `~/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/`：`deviceid` 10-29 创建，`onnxruntime.db` 一直在写（最后一次 11-06 12:12），里面 230 条待发事件，最早 11-04 18:47 |
| 事件内容（只读副本） | Mac 型号、芯片（Apple M4 Pro）、系统版本、内存、设备 ID；用了哪些执行器（CoreML / CPU），模型文件名（如 `model_fp16.rw-4399fe210056.onnx`），会话创建、模型加载耗时、推理性能。**没有照片内容和照片路径** |
| 已经发出去多少 | 查不出来。库里只剩还没发的，早于 11-04 的事件已经不在了，应该是发出去了 |

## 改了什么

| 地方 | 做法 |
|---|---|
| `immich_ml/__init__.py`（上游） | 加载包时设置变量。机器学习服务（`uvicorn immich_ml.main:app`）、模型准备（`ml-warm`）、打包时的 `stage_models.py` 都会先加载这个包 |
| `macos/native/run-service` | `ml`、`ml-warm` 启动前就设置变量，不依赖 Python 代码 |
| `build-release.sh`、`native/install.sh` | 设置变量。它们会运行 `python -c 'import onnxruntime …'` 查有没有 CoreML，这一步不经过 `immich_ml` |
| `check-release.sh` | 设置变量；新增一项检查：不带这个变量、只加载发布包里的 `immich_ml`，变量必须变成 `1`。所以发布包里的 `immich_ml` 如果没带上游修复，打包会在检查这一步停下 |

## 实测

每种情况都用一个全新的临时 HOME，用 mac.7 的 Python 和 onnxruntime 1.30.0，在 CPU 上建一个会话（CLIP 文字模型）：

| 情况 | 遥测库 |
|---|---|
| 只调 `get_available_providers()`（打包检查就是这样） | **写了**，3 条 |
| 直接建会话（对照） | **写了**，9 条 |
| 先加载 v3.3.5 的 `immich_ml` 再建会话 | **写了**，9 条 |
| 先加载 v3.3.6 的 `immich_ml` 再建会话 | 没有 |
| 设置 `ORT_DISABLE_TELEMETRY=1` 再建会话 | 没有 |

`check-release.sh` 新增的那项检查：用合并后的 `immich_ml` 输出 `ORT_DISABLE_TELEMETRY=1`；换成 v3.3.5 的 `immich_ml` 时报 `AssertionError: None`。

服务器单元测试 2862 项通过（合并后，只有版本号变化）。

## 升级后

- 升级到 `v3.3.6-mac.1` 并重启服务后，就不会再写遥测库。
- 以前留下的遥测目录可以删掉：`~/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/`（安装包不会自动删，它在用户目录里，可能也有别的程序在用）。
- 同一层的 `deviceid`（2024-06）是别的微软开发工具留的，与 Immich 无关。
