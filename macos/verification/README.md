# 验证结论

本目录存放 macOS 原生部署各阶段的技术验证结论。每个验证项一个文件，命名为 `<阶段>-<主题>.md`。

基线：分支 `mac/feat/m0-spike`，基于官方 `v3.3.5`；验证机器 Apple M4 Pro，64 GB，macOS 15.6。

## M0 技术验证

| 编号 | 验证项 | 文件 | 状态 |
|---|---|---|---|
| M0-0 | 本机工具链（arm64） | [m0-env.md](m0-env.md) | 进行中 |
| M0-1 | 机器学习服务原生运行与 CoreML 加速 | [m0-ml-coreml.md](m0-ml-coreml.md) | 通过（有规避方案） |
| M0-2 | PostgreSQL + VectorChord | — | 未开始 |
| M0-3 | libvips / sharp 图片格式支持 | — | 未开始 |
| M0-4 | jellyfin-ffmpeg（`tonemapx`、VideoToolbox） | — | 未开始 |

## 风险跟踪

| 风险 | 状态 | 结论文件 |
|---|---|---|
| R1 VectorChord 在 macOS 上编译 | 待验证 | — |
| R2 libvips 格式支持不如 Docker 镜像 | 待验证 | — |
| R3 jellyfin-ffmpeg 的 macOS 版本 | 待验证 | — |
| R4 gunicorn fork 与 CoreML | 出现 1 次崩溃，未再复现；改单进程启动规避 | [m0-ml-coreml.md](m0-ml-coreml.md) |
