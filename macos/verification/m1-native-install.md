# M1-2 原生安装：一键脚本 + launchd

- 日期：2026-10-29
- 分支：`mac/feat/native-install`
- 结论：**通过**。脚本安装、launchd 托管的实例：端到端 **40/40**，从备份恢复 **3/3**，崩溃自动拉起、整体停止、升级保留数据都已验证

## 交付物（`macos/native/`）

| 文件 | 作用 |
|---|---|
| `install.sh` | 一键安装与升级：检查机器 → 装工具 → 编译 VectorChord → 构建发布目录 → 生成配置 → 注册 launchd → 启动 → 打印状态与主机检查 |
| `run-service` | launchd 实际执行的程序：按服务设置环境并在前台运行（`postgres` / `valkey` / `ml` / `server`） |
| `immichctl` | 日常管理：`status`、`start`/`stop`/`restart [服务]`、`logs [-f]`、`admin`（服务端管理命令，如重置管理员密码）、`psql`、`doctor`、`uninstall [--purge]` |

## 安装后的布局

```
~/Library/Application Support/Immich/
  bin/            run-service, immichctl
  config/         native.env（安装脚本写入，含随机数据库密码，600）
                  server.env（用户自己的 Immich 环境变量，可选）
                  valkey.conf
  data/postgres/  数据库（immich.conf 每次安装重写；自定义写 postgresql.override.conf）
  data/valkey/
  data/models/    机器学习模型与 CoreML 编译缓存
  releases/<版本>-<提交>/  node、server、build（网页、插件、geodata 链接）、ffmpeg、ml
  current -> releases/...
  shared/geodata/
  cache/src/      VectorChord 源码
~/Library/Logs/Immich/       install.log 与每个服务一个日志
~/Library/LaunchAgents/local.immich.{postgres,valkey,ml,server}.plist
~/Pictures/Immich            照片库（--library 可改）
```

## 关键设计

- **版本全部取自官方锁定**：Node、pnpm、jellyfin-ffmpeg、插件工具链用 `mise install --locked`（按 `mise.lock`）；VectorChord 版本从 `docker/docker-compose.yml` 的数据库镜像名读取；机器学习依赖用 `uv sync --frozen`。跟进上游版本时不需要改脚本。`mise.toml` 里与安装无关的工具（Java、Terraform 等）通过 `MISE_DISABLE_TOOLS` 排除。Java 下载超时曾导致 `mise install` 失败，这样处理后就不再依赖它。
- **发布目录 + `current` 链接**：每次安装构建一个新目录，服务停下后才切换链接，所以构建失败不影响正在运行的版本。保留当前和上一个版本，可以回退。
- **每个服务都在 launchd 下前台运行**：`KeepAlive` 负责崩溃后拉起，`ThrottleInterval` 10 秒防止反复重启刷屏；日志由 launchd 写入。
- **M0 发现的问题都在这里落实**：
  - PostgreSQL：`run-service` 设置 `LANG`/`LC_ALL`；launchd 停止服务时发 SIGTERM，而 PostgreSQL 收到 SIGTERM 会等所有连接断开（smart shutdown），所以转换成 SIGINT（fast shutdown），与官方镜像的 `STOPSIGNAL` 一致。
  - 机器学习服务直接用 uvicorn 单进程运行，不走 gunicorn fork（规避 M0 的 CoreML 崩溃）。
  - 服务端：设置 `DB_BIN_DIR`；PATH 中 GNU gzip 排在系统 gzip 之前；jellyfin-ffmpeg 放在 PATH 最前；`IMMICH_MACHINE_LEARNING_URL` 指向本机机器学习服务（作为网页设置的默认值，网页里仍可修改）。
  - sharp 源码编译后检查 `heif`、`jxl`、`dcraw` 三种格式都能读，onnxruntime 检查有 CoreML，任何一项不满足就停止安装，不会装出一个功能残缺的版本。
- **PostgreSQL 配置**照搬官方镜像的 `postgresql.ssd.conf`，只去掉 `effective_io_concurrency = 200`：macOS 没有 `posix_fadvise()`，PostgreSQL 在 macOS 上拒绝任何非 0 的值（实测报错）。只监听 `127.0.0.1`，不开 Unix 套接字，密码认证（scram-sha-256）。数据库用 ICU 排序（`en-US`），排序结果不随系统语言变化。
- **端口冲突检查**：端口被别的程序占用时直接报错，并告诉你用哪个参数换端口；被这个安装自己的服务占用（重装、升级时）则不算冲突。
- **`immichctl doctor`** 只检查、不修改系统设置：是否关闭休眠、断电后是否自动开机、是否自动登录（LaunchAgent 要登录后才运行）、防火墙、照片库是否可写。

## 验证

在一个与正式安装完全隔离的测试实例上进行（独立标签 `local.immich-test`、独立端口 2284/3004/5434/6381、安装目录 `Immich-test` 路径中带空格）。

| 项目 | 结果 |
|---|---|
| `shellcheck`（warning 级别）、系统 bash 3.2 语法检查 | 通过 |
| 首次安装 | 成功，四个服务全部健康。VectorChord 已存在故跳过编译；构建发布目录约 2 分钟，发布目录 1.2 GB |
| 端到端（`m0_e2e.py`，对 launchd 托管的实例） | **40/40** |
| 崩溃恢复：`kill -9` 机器学习服务、服务端 | launchd 分别在 2 秒、4 秒内拉起新进程，健康检查恢复 |
| 整体停止（`immichctl stop`） | 四个服务依次停止，测试实例没有任何残留进程 |
| exiftool 孤儿进程（M0 问题） | 服务端运行中启动的 exiftool 与服务端同属一个进程组，停止服务端时一并结束，**问题在 launchd 下不再出现** |
| 升级：只传 `--home` 重跑安装 | 端口、监听地址、照片库等设置全部从 `native.env` 沿用；构建新发布目录并切换；新旧两个发布目录都保留；35 个资产、智能搜索结果不变 |
| 从备份恢复（`m1_restore.py`，走网页使用的维护模式接口） | **3/3**：先备份，再删除一张照片，进入维护模式恢复；13 秒后退出维护模式，照片和它的搜索向量都回来了，恢复前自动做了恢复点备份 |
| 维护模式切换 | 服务端在自己的进程内重启到维护模式再回来，launchd 管理的进程号不变，不会被当成崩溃 |

## 已知限制

- **LaunchAgent 只在用户登录后运行**。机器重启后需要自动登录，`immichctl doctor` 会提示。开启了 FileVault 的机器不能自动登录，这时只能手动登录后 Immich 才启动；要彻底解决需要改成系统级服务（LaunchDaemon），放到 M3。
- 防火墙开启时，第一次有其他设备访问，macOS 会弹窗询问是否允许 `node` 接收连接，需要点允许。
- 视频转码仍用 CPU（VideoToolbox 在 M2）。
