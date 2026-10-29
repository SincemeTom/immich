# M1-3 第二台 Mac：从零安装与真实照片库

- 日期：2026-10-29 至 2026-10-30
- 分支：`mac/develop`（修复提交 `0d7821e7b`，已推送）
- 结论：**通过**。在一台从没装过任何组件的 Mac 上，一键安装脚本修了 SDK 问题后跑通；完全不经过 Docker。用户自己上传 1204 个真实文件（4.5 GB），4 分 11 秒全部处理完，没有任何失败
- 范围说明：端到端脚本 `m0_e2e.py` 这次**没有跑完**（见"未验证"），所以不能写作 40/40；下面每一项都是单独查过的

## 机器

| 项目 | 值 |
|---|---|
| 芯片、内存 | Apple M4 Pro，48 GB |
| 系统 | macOS 26.7（25G229） |
| Xcode | 26.3，`xcode-select` 指向 Xcode.app |
| 命令行工具 | `/Library/Developer/CommandLineTools` 存在，但只有 13.3、14.4 两个旧 SDK，**没有 `MacOSX26.sdk`** |
| 安装前状态 | 只有 Homebrew 和系统 Python；没有 mise、uv、Node、PostgreSQL、libvips；没有 Docker |
| 网络 | 很慢，大文件约 10–280 KB/s |

和 M1-2 那台机器（M4 Pro，64 GB，macOS 15.6，VectorChord 已编译好）相比，这台机器能暴露"从零安装"和"SDK 不对"两种情况。

## 发现并修复的问题

### VectorChord 编译时找不到系统头文件

现象：`cargo make build` 失败，`'stdio.h' file not found`、`'setjmp.h' file not found`，同时有警告 `no such sysroot directory: '/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk'`。

原因：

- Homebrew 的 PostgreSQL 是用命令行工具里的 `MacOSX26.sdk` 编译的，这个路径被写进了 `pg_config --cppflags`（`-isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk`）。
- pgrx 把这些参数**原样**交给 clang（`pgrx-bindgen-0.14.1/src/build.rs` 的 `extra_bindgen_clang_args`；路径不存在时只打印一条警告）。
- 这台机器的命令行工具里没有这个 SDK，Homebrew 的 clang 自己又不会去找 Xcode 的 SDK，于是一个系统头文件都找不到。`/usr/bin/clang` 没问题，因为它会自己问 `xcrun`。
- 只设置环境变量 `SDKROOT` **不够**：命令行里的 `-isysroot` 优先级更高。

修复（`macos/native/install.sh`）：

1. 检查本机的第一步就用 `xcrun --show-sdk-path` 取本机实际的 SDK，取不到就停止并提示 `xcode-select --install`。
2. 编译 VectorChord 时经过一个 `pg_config` 包装脚本：调用真正的 `pg_config`，把输出里的 `-isysroot <路径>` 换成本机的 SDK。`PGRX_PG_CONFIG_PATH` 和 `make PG_CONFIG=` 都指向它。

### 包装脚本的路径不能带空格

第一版把包装脚本放在 `~/Library/Application Support/Immich/cache/pg_config`，编译通过了，但 `make install` 失败（先是 BSD `cp` 打印用法，换成 GNU `cp` 后报 `missing destination file operand`）。

原因：VectorChord 的 Makefile 写的是 `cp -r ./build/raw/pkglibdir/. $(shell $(PG_CONFIG) --pkglibdir)`，`$(PG_CONFIG)` 没加引号，`Application Support` 被拆成两个参数，`cp` 就少了目标目录。

修复：包装脚本放在 `mktemp -d "${TMPDIR:-/tmp}/immich-pgconfig.XXXXXX"` 里（路径里没有空格），装完就删。

**更正**：当时一度以为是 macOS 自带的 `cp` 不支持 `cp -r`，还给脚本加了 `coreutils`。后来实测 `/bin/cp -r` 完全正常，真正原因只是空格，所以提交前把 `coreutils` 撤掉了。最终提交只有上面两处改动（`install.sh` 增加 19 行、删除 2 行）。

### 这个修复的验证

- 修好后完整跑了一遍安装：VectorChord 0.4.3 编译并安装到 `/opt/homebrew/lib/postgresql@17`。
- 撤掉 `coreutils` 后，只用 `/bin/cp`，通过包装脚本重新执行了一次 `make install`：成功。数据库没有重启，`vchord` 扩展版本 0.4.3，向量查询能返回结果。
- 系统自带的 bash 3.2 语法检查通过。
- **`shellcheck` 没跑**（这台机器没装）。
- **撤掉 `coreutils` 后没有从头完整重装一遍**；编译那一步走的是同一个包装脚本，已经验证过。

## 安装

最后一次（成功的）安装，各步骤开始的时间：

| 步骤 | 开始 | 耗时 | 说明 |
|---|---|---|---|
| 检查本机、Homebrew 工具 | 23:23:16 | 4 秒 | 前几次失败的运行已经装好了 |
| mise 锁定版本 | 23:23:20 | 0 秒 | 同上 |
| VectorChord 0.4.3 | 23:23:20 | 54 秒 | Rust 工具链和 `cargo-make` 已在前几次运行里装好 |
| 构建发布目录 | 23:24:14 | 44 分钟 | 大部分时间在下载：JS 依赖、Python 依赖、geodata（约 14 MB 的 `cities500.zip` 下载了十几分钟） |
| 配置、注册 launchd、启动 | 00:08:45 | 39 秒 | 新建数据库集群和 `immich` 库 |

第一次运行（Homebrew 装 70 多个依赖、mise 下载 Node/pnpm/ffmpeg、编译 `cargo-make`）在网速慢的情况下大约用了 35 分钟，之后才卡在 VectorChord。加上几次重试，从零开始总共大约 1 小时 45 分钟。时间主要花在网络上，网速正常的机器应该快很多。

安装脚本的几道检查都通过了：

- sharp（按本机 libvips 编译）能读的格式：`jpeg png webp tiff magick openslide ppm fits gif svg heif pdf vips jp2 jxl rad dcraw`，包括必需的 `heif`、`jxl`、`dcraw`
- onnxruntime 1.30.0 的执行后端：`CoreMLExecutionProvider AzureExecutionProvider CPUExecutionProvider`

### 装好之后

| 项目 | 值 |
|---|---|
| 发布目录 | `3.3.5-b74164da6-dirty-20261029232414`，1.2 GB（`dirty` 是因为构建时 `install.sh` 还有没提交的修改） |
| 组件版本 | Node 24.22.1，pnpm 11.27.1，PostgreSQL 17.11（Homebrew），VectorChord 0.4.3，Valkey 9.1.3，libvips 8.18.7，jellyfin-ffmpeg 7.1.3-6，Python 3.12.16 |
| 数据库 | 330 MB（含 1200 多个资产的数据） |
| 机器学习模型与 CoreML 缓存 | 3.0 GB（`data/models`） |
| 照片库 | `~/Pictures/Immich`：`upload/`（原件）、`thumbs/`（缩略图、预览图）、`encoded-video/`、`library/`、`profile/`、`backups/` |

`immichctl doctor`：休眠已关闭、照片库可写（2 项通过）；3 条提醒：断电后不会自动开机、没有自动登录、防火墙开着（第一次有手机连进来要点允许 `node`）。

### 确实没有用 Docker

本机没有 `docker` 命令、Docker Desktop 或 OrbStack。四个端口上的进程都是 arm64 原生程序：

| 端口 | 进程 |
|---|---|
| 2283 | `immich-api`（服务端改过进程名，本体是发布目录里的 Node） |
| 3003 | 发布目录里的 `ml/venv/bin/python`（uvicorn 单进程） |
| 5432 | `/opt/homebrew/opt/postgresql@17/bin/postgres` |
| 6379 | `/opt/homebrew/bin/valkey-server` |

`node`、`python3.12`、`postgres`、`valkey-server`、`ffmpeg` 用 `file` 看都是 `Mach-O 64-bit executable arm64`。

## 功能验证

### 测试素材（端到端脚本跑了一半）

`m0_e2e.py` 注册了管理员 `m0@immich.local`，上传了 `e2e/test-assets` 里的 26 张图片；这台机器上没有那 3 段合成视频。后来因为智能搜索队列卡住（原因见"首次使用时请求超时"），脚本被手动停掉。之后单独检查：

| 项目 | 结果 |
|---|---|
| 登录 | 通过 |
| 缩略图、预览图 | 通过 |
| 人脸检测（portrait.jpg） | 通过，1 张人脸 |
| 智能搜索 "a bird of prey" | 通过，`prairie_falcon.jpg` 排第一 |

### 真实照片库：用户上传 1204 个文件

用户从网页上传，主要是 iPhone 16 拍的照片、实况照片和视频。

| 时间点 | 时刻 |
|---|---|
| 第一个文件上传 | 01:11:46 |
| 最后一个文件上传 | 01:15:41 |
| 最后一项处理（OCR）完成 | 01:15:57 |

**4 分 11 秒全部处理完。** 处理一路跟着上传走，最后一个文件传完 16 秒后就结束了，瓶颈在上传，服务端没有积压。

| 项目 | 结果 |
|---|---|
| 入库 | 1202 个资产（比 1204 少 2 个，可能是和库里已有文件内容相同被跳过；数据库里没有记录，无法确认）：786 张照片、37 段视频、379 张实况照片（视频部分），共 4.5 GB |
| 元数据、缩略图、预览图、thumbhash | 所有可见资产都齐 |
| 视频转码 | 37/37 |
| 实况照片配对 | 379 对，视频部分自动隐藏 |
| 智能搜索、人脸、OCR、重复检测 | 全部完成：294 张人脸，2325 行文字 |
| 任务队列（17 个，在 Valkey 里直接查） | 全部清空，失败数 0 |
| 服务端日志 01:11–01:16 | 0 条 ERROR / WARN |

检查方法：不看任务计数（Immich 会清掉已完成和已失败任务的计数，见 [m0-e2e.md](m0-e2e.md)），直接查数据库：`asset_job_status` 的各个时间戳、`asset_file` 里的 thumbnail / preview / encoded_video、`smart_search`、`asset_face`、`asset_ocr`。

被隐藏的实况照片视频里有 325 个没有缩略图，这是官方行为：隐藏资产不生成缩略图（`server/src/services/media.service.ts` 第 201 行）。

**漏了 1 张，不在这一批里**：01:02 那一小批里的 `IMG_5890.HEIC` 已经和 `IMG_5890.mov` 配对成实况照片，但没有做智能搜索、人脸和 OCR，日志里也没有报错。它的缩略图在 01:05:42 被重新生成过一次；服务端只有在上传时生成缩略图，才会接着安排这三项（`server/src/services/job.service.ts` 第 168 行）。是什么触发了这次重新生成没查到。补救：网页「管理 → 任务」里对这三项各点一次「缺失」。**明天确认一下补上了没有。**

### 硬件加速

| 功能 | 用的硬件 | 依据 |
|---|---|---|
| 机器学习（智能搜索、人脸、OCR） | **CoreML**（神经网络引擎 / GPU / CPU，由 CoreML 分配） | ML 日志里执行后端第一个是 `CoreMLExecutionProvider`；`immich_ml/sessions/ort.py` 设置了 `MLComputeUnits: "ALL"`。有的模型不是整个跑在 CoreML 上，例如 313 个节点里 285 个交给 CoreML，剩下的回到 CPU |
| 视频转码 | **CPU** | 服务端日志 `Transcoding video ... without hardware acceleration`。官方只支持 NVENC、QSV、VAAPI、RKMPP（`server/src/enum.ts` 的 `TranscodeHardwareAcceleration`），没有 VideoToolbox，网页里也选不到 |
| 缩略图 | CPU（libvips） | 和官方 Docker 版一样 |

## 机器学习服务反复重启：不是故障

launchd 记录这个服务运行过 6 次（今晚在 00:40、00:52、01:01、01:09、01:27 各重启一次），容易被当成 M0 记录过的 CoreML 崩溃（风险 R4）。查下来不是：

- 每次重启前日志里都是 `Shutting down due to inactivity.`，launchd 记录的退出码是 0，`~/Library/Logs/DiagnosticReports` 里没有崩溃报告。
- 这是官方设计：300 秒没有请求，服务就自己退出，把模型占的内存还给系统（`machine-learning/immich_ml/main.py` 的 `idle_shutdown_task`，`config.py` 里 `model_ttl = 300`）。Docker 里由 gunicorn 拉起，这里由 launchd 的 `KeepAlive` 拉起。
- 空闲时只占 126 MB。重启后第一个请求要重新加载模型，CoreML 编译缓存已经在本地，所以只多几秒。
- 00:30 以后，服务端日志里和机器学习有关的失败、不健康记录是 0。上传 1204 个文件的过程中正好重启过一次（01:09），没有请求失败。

**不改。** 想让它一直不退出，可以设置 `MACHINE_LEARNING_MODEL_TTL=0`，代价是空闲时也占着几 GB 内存；不过 `run-service` 目前没有给机器学习服务读用户配置的入口，真要做得先改脚本。

R4（gunicorn fork 与 CoreML 崩溃）这次没有复现，单进程 uvicorn 的规避方案继续有效。

## 首次使用时请求超时（真问题，未修）

刚装好第一次用时，服务端日志在 00:15:18、00:20:19、00:25:20 各有一批 `fetch failed`，间隔正好 5 分钟，智能搜索因此卡了十几分钟。

原因：机器学习服务收到第一个请求时才开始下载模型（约 1.7 GB），网速慢时一个请求要等很久；服务端等了 300 秒就放弃，过一会儿重试，又要再等 5 分钟。模型下载完以后再也没出现过。

修法：安装脚本最后主动预热，先把模型下载好、CoreML 编译好，再告诉用户可以用。这一项本来就在 [README.md](README.md) 的后续事项里（"安装后预热机器学习模型"），**是明天可以做的第一件事**。

## 使用中确认的事

- **实况照片没有动画**：iPhone 实况照片是一张 HEIC 加一段约 2 秒的 MOV，靠文件里相同的 `ContentIdentifier` 配对（`server/src/services/metadata.service.ts` 的 `linkLivePhotos`）。只传 HEIC 就只显示静态图。用手机 App 上传，或者在「照片」App 里用「导出未修改的原件」，就能拿到两个文件。不管先传哪个，补传另一个后都会自动配对。官方行为，和 Mac 版无关。
- **改密码**：头像 → 账户设置 → 密码。改邮箱：管理 → 用户 → 编辑。忘记密码：`immichctl admin reset-admin-password`。
- **缩略图位置**：`<照片库>/thumbs/<用户ID>/<ID 前两位>/<第 3–4 位>/<资产ID>_thumbnail.webp` 和 `_preview.jpeg`，因为 `run-service` 把 `IMMICH_MEDIA_LOCATION` 设成了照片库。Immich 不能单独设置缩略图的位置；缩略图丢了可以在「任务」里重新生成。

## 未验证

| 项目 | 原因 | 之前的结论 |
|---|---|---|
| 端到端 40/40 | 脚本中途停掉；这台机器上没有 3 段合成视频 | M1-2：40/40 |
| 数据库备份、从备份恢复 | 脚本没跑到这一步，也没有手动测 | M1-1、M1-2：通过，恢复 3/3 |
| HDR 视频色调映射 | 没有合成视频；真实照片库里的 37 段视频都转码了，但没逐个看颜色 | M0：通过 |
| 崩溃拉起、升级、卸载 | 没测 | M1-2：通过 |
| `shellcheck` | 没装 | M1-2：通过（改动前的脚本） |

## 当前状态（留给明天）

- 实例在运行：http://192.168.100.136:2283，四个服务都由 launchd 托管，状态正常。
- 管理员是测试脚本注册的 `m0@immich.local`，用户已经改了密码；邮箱可能还没改。库里还有 26 张测试图片可以删掉。
- 代码：`mac/develop` 是干净的，修复提交 `0d7821e7b` 已推送到 `origin`。
- 在运行的发布目录名带 `dirty`，是用修复的中间版本构建的。下次跑 `install.sh` 会用干净的提交构建一个新的发布目录，并保留这个旧的以便回退。

## 下一步

1. 安装后预热机器学习模型（修"首次使用时请求超时"）。
2. 补测这台机器上的数据库备份和从备份恢复，可以在网页上手动做；最好也在这里把 `m0_e2e.py` 完整跑一遍。
3. 确认 `IMG_5890.HEIC` 补上了智能搜索、人脸和 OCR。
4. 进入 M2：转码走 VideoToolbox。
