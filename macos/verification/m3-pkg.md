# M3 安装包：不需要 Homebrew 的 .pkg

- 分支：`mac/feat/pkg`
- 结论：**通过**。发布目录完全自带依赖，在这台 Mac 上屏蔽 Homebrew 和外网后，新装与接管都通过了端到端测试；`Immich-3.3.5-d9e2f6180.pkg` 已签名、**经 Apple 公证（0 个问题）并装订**。真正的图形界面安装要在测试机上做（见"测试机上怎么测"）。

## 用户看到的

双击 `Immich-<版本>.pkg` → 欢迎页（中文）→ 输入管理员密码 → 安装，最后一步准备模型约 2 分钟 → 自动打开 `http://localhost:2283` 创建管理员账号。

- 不需要 Homebrew、Xcode、命令行工具、Docker，也不联网：智能搜索、人脸、文字识别模型都在安装包里。
- 为**当前登录的用户**安装，和一键安装版一样以 LaunchAgent 运行，数据在 `~/Library/Application Support/Immich`。
- 已经装过一键安装版：直接接管，数据库、设置、照片库、外部库、网络共享都保留，上一个版本留着可回退。
- `immichctl` 放在 `/usr/local/bin`，新终端里直接可用。
- 升级：装新版本的 .pkg。卸载：`immichctl uninstall [--purge]`，它会提示删掉 `.pkg` 在安装目录之外加的两样东西（`/usr/local/bin/immichctl` 和安装记录）要用的 `sudo` 命令。

## 系统要求

**Apple 芯片、macOS 15.0 或以上**。原因：发布目录里来自 Homebrew 的库（libvips 和它的 76 个依赖、ICU、Valkey）是 Homebrew 为 macOS 15 编译的，最低就是 15.0。自己编译的部分（PostgreSQL、pgvector、VectorChord、sharp）也固定按 15.0 编译，否则编译器会按构建机的 15.6 来，15.0–15.5 就装不了。构建脚本统计所有 Mach-O 文件要求的最高系统版本，写进发布目录，安装包和 `configure.sh` 都按它检查。M4 Mac mini 出厂就是 macOS 15，不受影响。

## 结构

| 文件 | 作用 |
|---|---|
| `macos/package/build-release.sh` | 构建自带依赖的发布目录（1.4 GB） |
| `macos/package/bundle_dylibs.py` | 把发布目录里所有 Mach-O 文件用到的非系统库复制进 `lib/`，改成相对路径引用 |
| `macos/package/check-release.sh` | 屏蔽 Homebrew 后逐项运行发布目录；`--signed` 时再检查每个文件的签名 |
| `macos/package/stage_models.py` | 准备安装包里的模型：与服务自己下载的文件逐个核对 |
| `macos/package/build-pkg.sh` | 签名、打包、公证、装订，一条命令出 .pkg |
| `macos/package/scripts/postinstall` | 安装后以 root 运行：把发布目录和模型交给当前登录用户，再以该用户身份运行 `configure.sh` |
| `macos/native/configure.sh` | 从 `install.sh` 拆出来的配置和启动部分，一键安装和 .pkg 共用 |

### 发布目录里有什么

| 部分 | 来源 |
|---|---|
| 服务端、网页、插件 | 和 `install.sh` 一样构建 |
| node、jellyfin-ffmpeg | `mise.lock` 锁定的版本，本身就不依赖别的库 |
| sharp + libvips | 用 Homebrew 的 libvips 编译（能读 HEIC、JPEG XL、相机 RAW）；libvips、它的 heif / jxl / magick 模块、ImageMagick 的 130 个解码器及其依赖全部复制进来，共 84 个库 |
| PostgreSQL 17.11 + pgvector 0.8.7 + VectorChord 0.4.3 | 从源码编译，版本与 Homebrew 的一致（接管一键安装版的数据库要求版本一致）；ICU 79、lz4、zstd 复制进来 |
| Valkey、GNU gzip | 复制 Homebrew 的（数据库备份要用 GNU gzip 的 `--rsyncable`） |
| Python 3.12 + 机器学习 | uv 的独立版 CPython，依赖直接装进去（不用 venv，venv 的解释器是指向本机 uv 的链接） |
| 地理数据 | 构建时下载 |

## 做的过程中发现并解决的问题

| 问题 | 解决 |
|---|---|
| Homebrew 的 libvips 按编译时的路径找模块，ImageMagick 按 `.la` 文件里写的 Homebrew 路径找解码器。没装 Homebrew 时会退回发布目录里的，所以屏蔽测试能通过；**装着 Homebrew 时（比如用过一键安装的 Mac）会把 Homebrew 的 libvips、glib、ImageMagick 也加载进来**，同一进程里两份，可能崩溃 | 服务端设 `VIPSHOME` 等环境变量；`.la` 文件改为"未安装"，只从自己所在目录加载。修复后在装着 Homebrew 的这台 Mac 上加载 0 个 Homebrew 的库（修复前 148 个）。这一项已加入发布目录检查 |
| `configure.sh` 在它要移动的发布目录里运行，移动后找不到同目录的 `run-service`（`.pkg` 安装会失败） | 移动后改用新位置；`/tmp` 是链接，比较前先取真实路径 |
| 打包要用的模型不能只看服务端默认值：服务端默认的智能搜索模型只懂英文，新装时 `configure.sh` 才换成多语言的 | 智能搜索模型取 `configure.sh` 的默认值，人脸和 OCR 取服务端默认值 |
| OCR 模型 Hugging Face 上没有（仓库里只有 `.gitattributes`），服务是从 RapidOCR 的地址下载的 | 模型准备脚本按同样的地址和 SHA-256 核对 |
| CoreML 把编译好的模型缓存在 `~/Library/Caches/<进程名>`（默认模型约 10 GB）。独立版 Python 进程名是 `python3`，一键安装版是 `python`，接管后会重新编译一份、旧的那份永远留着 | 独立版也用 `python` 这个名字启动，接管后沿用原来的缓存 |
| `configure.sh --check-only` 会清空正在运行的安装的 `install.log` | 只检查时不新建日志 |
| 我自己的 shell 里 `CC` 指向 Homebrew 的 clang 18 | 构建脚本固定用 Apple 的 clang |

## 测试

### 发布目录检查（`check-release.sh`）

在临时目录里复制一份发布目录（同时验证移动后能用），用沙盒配置文件让 Homebrew、`/usr/local`、`~/.local`（uv 的 Python）、Rust 工具链、构建缓存和源码仓库都不可读：

| 项目 | 结果 |
|---|---|
| 547 个 Mach-O 文件只加载发布目录里或 macOS 自带的库 | 通过，0 个问题 |
| PostgreSQL：ICU 建库、预加载 VectorChord 启动、建 Immich 用到的 7 个扩展、VectorChord 索引和搜索、ICU 排序、`pg_dump` + `gzip --rsyncable` | 全部通过 |
| Valkey | 通过 |
| sharp 读 14 种样本：HEIC、JPEG XL、AVIF、DNG、NEF、CR2、WebP、PNG、TIFF、GIF、JPEG 2000、SVG、BMP、PSD | 全部通过 |
| 装着 Homebrew 时加载的 Homebrew 库 | 0 个（发布目录里的 213 个） |
| onnxruntime 有 CoreML；机器学习服务能加载 | 通过 |
| ffmpeg 有 VideoToolbox 编码器和 `tonemapx`；ffprobe；gzip | 通过 |

16/16 通过。

### 端到端（`macos/scripts/m3_standalone.sh`）

每个服务都通过沙盒启动：Homebrew 等不可读，**除本机外不能联网**（不能偷偷下载模型）。测试替换的只是测试副本里的 `run-service`，从第一次启动起就在沙盒里。

**新装**（和 postinstall 一样：模型放好，然后运行发布目录里的 `configure.sh`）：

| 项目 | 结果 |
|---|---|
| `configure.sh` | 通过，190 秒（含模型准备 1 分 50 秒） |
| PostgreSQL 用发布目录自己的 | 通过 |
| 没有下载任何模型 | 通过 |
| 22 个进程（含 PostgreSQL 后端、服务端子进程）没有打开任何 Homebrew 的文件 | 通过，端到端前后各查一次 |
| `m0_e2e.py`：注册、上传全部测试格式和 3 段视频（含 4K HDR）、缩略图、元数据、人脸、OCR、中文智能搜索、转码、数据库备份 | **36/36** |

**接管**（先用 Homebrew 的 PostgreSQL 和一键安装版的发布目录装一个，跑一遍端到端存进数据；再用自带依赖的发布目录运行 `configure.sh`）：

| 项目 | 结果 |
|---|---|
| 一键安装式安装（新的 `configure.sh` + Homebrew 的 PostgreSQL）+ 端到端 | 通过，36/36（也验证了拆分后的 `install.sh` 流程） |
| 接管 | 通过，153 秒 |
| PostgreSQL 换成发布目录自己的；端口和照片库路径不变 | 通过 |
| 照片 31、人脸 1、搜索向量 26、OCR 文字 37、用户 1、设置（哈希）全部一致 | 通过 |
| 上一个版本保留，可回退 | 通过 |
| 没有打开任何 Homebrew 的文件 | 通过 |
| 在接管后的数据上再跑端到端 | **36/36** |

### 测试机脚本的回退

接管测试之后要能回到一键安装版。`1-disable-native.sh` 现在会保存接管时会被改写的东西（`native.env`、`run-service`、`immichctl`、当前版本），`3-restore.sh` 放回去。在临时实例上走了一遍：一键安装式安装 → 关闭 → 用自带依赖的版本接管（运行正常）→ `immichctl uninstall` → 恢复：回到原版本、Homebrew 的 PostgreSQL，服务全部正常。

## 打包与公证

`macos/package/build-pkg.sh` 一条命令：构建发布目录 → 准备模型 → 签名 → 签名后再跑一遍发布目录检查 → 打包 → 公证 → 装订。

| 项目 | 结果 |
|---|---|
| 安装包 | `Immich-3.3.5-d9e2f6180.pkg`，4.9 GB（5,239,657,441 字节），安装后占 6 GB（模型准备后再加约 10 GB 的 CoreML 编译缓存） |
| SHA-256 | `699ae3f15978d3c233f3ebc7b67536f1ad00517aa05a49b7579562080e7b7d41` |
| 模型 | 智能搜索 XLM-Roberta-Large-ViT-H-14（4.80 GB）、人脸 buffalo_l（0.19 GB）、OCR PP-OCRv6_medium（0.14 GB，SHA-256 已核对），全部取自这台 Mac，没有下载 |
| 签名 | 547 个 Mach-O 文件全部 Developer ID Application 签名、强化运行时、安全时间戳；node 加 JIT 权限；安装包 Developer ID Installer 签名 |
| 签名后的发布目录检查 | 17/17（多了签名一项） |
| 公证 | Accepted，"Ready for distribution"，**0 个问题**，539 个票据；上传加审核约 30 分钟 |
| 装订、Gatekeeper | `stapler validate` 通过；`spctl`：accepted，Notarized Developer ID |
| 安装器 | 只允许 Apple 芯片、macOS 15.0 及以上；中文和英文欢迎页、结束页 |

### 这一轮发现并修好的

| 问题 | 解决 |
|---|---|
| 第二次构建时 VectorChord 链接失败：cargo 沿用了上次的编译结果，里面写着上一个发布目录的 `postgres` 路径 | 每次都从头编译 VectorChord |
| 签名后"装着 Homebrew 时不加载它的库"这项检查失效：强化运行时会忽略 `DYLD_PRINT_LIBRARIES`，什么都不输出，检查也就恒为通过 | 改为在进程解码完所有样本后用 `lsof` 看它实际映射的文件：签名后的发布目录加载 211 个自己的库、0 个 Homebrew 的库 |
| 这项检查同时发现 libexif 会读 Homebrew 里它的中文翻译文件（`.mo`，编译时写死的路径） | 只是消息文字，不是代码，没装 Homebrew 时不存在、消息改为英文，不影响运行；检查改为只统计库，另外列出读了几个数据文件 |
| 安装包里有 sharp 编译留下的 8 个 `.o` 目标文件和 makefile（也被签了名） | 构建时只保留 sharp 实际加载的模块（下次构建生效，这个安装包里还带着，无害） |
| 每个文件都带 `com.apple.provenance` 扩展属性，安装包里因此多了 `._` 条目 | 这是 macOS 自己加的，`xattr -c` 也删不掉，安装时还原为扩展属性，无害 |

### 第二版：`Immich-3.3.5-0c376d526.pkg`

包含测试机反馈的修复（外部库删除立即生效、卸载共享时标记离线、原图缺失返回 404，见 [m1-external-library-member-feedback.md](m1-external-library-member-feedback.md)）。

| 项目 | 结果 |
|---|---|
| 大小 | 4.9 GB（5,238,251,473 字节） |
| SHA-256 | `18295e5bbfb67d29f88c05f8fe913cedfc4ef5d1dd80a6b5989c3d84d3642037` |
| 签名后的发布目录检查 | 17/17；Mach-O 文件 539 个（上一版的 8 个 sharp 编译中间文件已去掉） |
| 公证 | Accepted，0 个问题；已装订，Gatekeeper：Notarized Developer ID |

第一版 `Immich-3.3.5-d9e2f6180.pkg` 已删除。

## 正式版

| 分支 / 标签 | 用途 |
|---|---|
| `mac/develop` | 日常开发，功能分支合到这里；从这里打的包是**开发版**：`Immich-3.3.5-dev-<提交>.pkg`，安装器里显示 `3.3.5-dev+<提交>` |
| `mac/main` | 正式版分支，只从 `mac/develop` 合入测试过的版本 |
| `v<上游版本>-mac.<序号>` | 正式版标签，如 `v3.3.5-mac.1`；从**干净的**标签检出打的包才是**正式版**：`Immich-3.3.5-mac.1.pkg`，发布目录名 `3.3.5-mac.1`，安装器内部版本 `3.3.5.1`（按序号递增） |

发布步骤：

```bash
git checkout mac/main && git merge --no-ff mac/develop
git tag -a v3.3.5-mac.2 -m "说明"
git push origin mac/main v3.3.5-mac.2
macos/package/build-pkg.sh            # 检出在标签上、没有改动时自动按正式版打包
git checkout mac/develop
```

第一个正式版：**`Immich-3.3.5-mac.1.pkg`**（标签 `v3.3.5-mac.1`，提交 `421a56db3`），4.9 GB，SHA-256 `3c735d6ad97a798cd4d7ad3332f556fbb475c1a98716221fac3be7a53e543630`，公证通过，发布目录检查 17/17。内容与正式环境已装好的 r2 开发版相同（只多了文档和打包脚本的改动），正式环境不必重装，下次升级时用正式版即可。

正式版签名、公证后连同 `.sha256` 复制到 `macos/package/releases/`（不进 git，`build/` 以后可能被清空）。安装包有 4.9 GB，超过 GitHub Release 单文件 2 GB 的上限，请另外备份。标签的版本号必须和 `server/package.json` 一致，否则构建会停下。

**证书过期不影响已发布的包**：签名带 Apple 的安全时间戳，公证票据也已装订进安装包，证书（2027-11-29 到期）过期后，之前打的包照样能装、装好的程序照样能运行；只有证书被吊销才会失效。证书过期后只是不能再打**新**包，届时在开发者后台续一张 Developer ID 证书即可。钥匙串里的两张证书请导出 `.p12` 备份。

## 测试机上怎么测

```bash
cd ~/Documents/immich && git pull
cd macos/scripts/test-machine
./1-disable-native.sh            # 测接管；测全新安装加 --fresh
./2-hide-homebrew.sh
# 新开终端窗口，双击 Immich-<版本>.pkg 安装
```

要看的：安装过程中没有报错；结束时自动打开网页；照片、人物、相册、外部库都在（接管时）；上传一张 HEIC 和一段视频，缩略图和播放正常；搜索"猫"之类的中文能搜到；`immichctl status` 四个服务都是 ok；`immichctl doctor`。

测完恢复：

```bash
immichctl uninstall              # 测的是接管：保留数据，一键安装版要用
# immichctl uninstall --purge    # 测的是全新安装
./3-restore.sh
```

## 限制

- 图形界面安装（Installer、postinstall 以 root 运行、交给登录用户、自动打开网页）在这台 Mac 上没有真正跑过：这台 Mac 上运行着你正在用的 Immich，postinstall 会接管它。postinstall 里调用的 `configure.sh` 已经按同样方式测过，剩下的部分要在测试机上验证。
- 安装需要有人登录在屏幕前（LaunchAgent 要在用户会话里运行），远程用 `sudo installer` 而没人登录时会失败并说明原因。
- 发布目录里的 Homebrew 库来自构建机当时的 Homebrew，升级 Homebrew 后重新打包，版本会跟着变。PostgreSQL、pgvector 的版本也取构建机 Homebrew 的版本，以保证能接管用同一台构建机装出来的一键安装版。
