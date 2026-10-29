# 验证结论

本目录存放 macOS 原生部署各阶段的技术验证结论。每个验证项一个文件，命名为 `<阶段>-<主题>.md`。验证用的脚本在 `macos/scripts/`。

基线：官方 `v3.3.5`；验证机器 Apple M4 Pro，64 GB，macOS 15.6。

## M0 技术验证：结论

**通过，可以进入 M1。** 所有组件都能在 Apple Silicon 上原生运行，不需要 Docker。服务端不改代码就能启动并完成全部核心功能，只有数据库备份需要补丁（已在 M1-1 完成）。

| 编号 | 验证项 | 文件 | 结论 |
|---|---|---|---|
| M0-0 | 本机工具链（arm64） | [m0-env.md](m0-env.md) | 通过 |
| M0-1 | 机器学习服务原生运行与 CoreML 加速 | [m0-ml-coreml.md](m0-ml-coreml.md) | 通过（崩溃问题已有规避方案） |
| M0-2 | PostgreSQL 17 + VectorChord 0.4.3 | [m0-postgres-vectorchord.md](m0-postgres-vectorchord.md) | 通过 |
| M0-3 | libvips / sharp 图片格式支持 | [m0-libvips-sharp.md](m0-libvips-sharp.md) | 通过（sharp 必须源码编译） |
| M0-4 | jellyfin-ffmpeg 与 VideoToolbox | [m0-ffmpeg-videotoolbox.md](m0-ffmpeg-videotoolbox.md) | 通过 |
| M0-5 | 端到端（全原生） | [m0-e2e.md](m0-e2e.md) | 39/40，数据库备份需补丁（已在 M1-1 修复） |

## M1 原生跑通

| 编号 | 验证项 | 文件 | 结论 |
|---|---|---|---|
| M1-1 | 数据库备份：`DB_BIN_DIR` 与空备份检测（分支 `mac/feat/pg-bin-path`） | [m1-db-backup.md](m1-db-backup.md) | 通过，端到端 40/40 |

## 风险跟踪

| 风险 | 状态 | 结论文件 |
|---|---|---|
| R1 VectorChord 在 macOS 上编译 | **解除**：照官方 macOS CI 编译，约 72 秒；召回率 100%；Immich 迁移全部通过 | [m0-postgres-vectorchord.md](m0-postgres-vectorchord.md) |
| R2 libvips 格式支持不如 Docker 镜像 | **解除**：Homebrew libvips + 源码编译 sharp，24 种素材全部通过 | [m0-libvips-sharp.md](m0-libvips-sharp.md) |
| R3 jellyfin-ffmpeg 的 macOS 版本 | **解除**：官方 `mise.lock` 已锁定 macOS arm64 版本，带 `tonemapx` 和 VideoToolbox，只依赖系统框架 | [m0-ffmpeg-videotoolbox.md](m0-ffmpeg-videotoolbox.md) |
| R4 gunicorn fork 与 CoreML | 出现过 1 次崩溃，之后未复现；改为单进程启动规避 | [m0-ml-coreml.md](m0-ml-coreml.md) |
| 新：`pg_dump` 路径写死为 Linux 位置 | **已修复**：新增 `DB_BIN_DIR` | [m1-db-backup.md](m1-db-backup.md) |
| 新：macOS 自带 gzip 让备份变成 0 字节却报告成功 | **已修复**：服务端拒绝空备份；原生部署必须带 GNU gzip | [m1-db-backup.md](m1-db-backup.md) |
| 新：没有 `LANG` 时 PostgreSQL 起不来 | 已确认，设置 `LC_ALL` 即可解决 | [m0-postgres-vectorchord.md](m0-postgres-vectorchord.md) |

## 后续事项

| 阶段 | 事项 |
|---|---|
| ~~M1~~ | ~~`pg_dump` / `psql` 路径可配置~~（已完成，见 M1-1） |
| M1 | 机器学习服务单进程启动；安装后预热模型 |
| M1 | launchd 配置：PostgreSQL 设置 `LC_ALL`；服务端设置 `DB_BIN_DIR`，PATH 中 GNU gzip 排在 `/usr/bin` 前 |
| M1 | 进程管理器按进程名（`immich` / `immich-api`）和端口管理服务端；服务端单独成为一个进程组，停止时整组发信号（否则会留下孤儿 exiftool 进程） |
| M1 | 安装流程：`pnpm install` 之后源码编译 sharp；准备 geodata、网页文件、插件 |
| M1 | 端到端补测网页上的"从备份恢复" |
| M2 | VideoToolbox：SDR 走全硬件；HDR 走"硬件解码与缩放 + CPU `tonemapx` + 硬件编码"；校准 `-q:v` |
| M3 | 打包 libvips 及其约 30 个依赖库，改写动态库引用路径；统一 `MACOSX_DEPLOYMENT_TARGET`；PostgreSQL 客户端工具与 GNU gzip 一并打包 |
| 可选 | OCR 单独走 CPU（CoreML 对 OCR 没有提速） |
