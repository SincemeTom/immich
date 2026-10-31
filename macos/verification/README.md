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
| M1-2 | 一键安装与 launchd 托管（分支 `mac/feat/native-install`） | [m1-native-install.md](m1-native-install.md) | 通过：端到端 40/40，从备份恢复 3/3，崩溃拉起、升级、卸载 |
| M1-3 | 第二台 Mac 从零安装（macOS 26.7）与真实照片库 | [m1-second-mac.md](m1-second-mac.md) | 通过：修复 SDK 问题后安装成功，完全不经过 Docker；真实上传 1204 个文件，4 分 11 秒全部处理完，0 失败。端到端脚本没跑完，备份恢复未复测 |
| M1-4 | 中文智能搜索模型 XLM-Roberta-Large-ViT-H-14 与模型预热（分支 `mac/feat/ml-warm-clip`） | [m1-clip-model.md](m1-clip-model.md) | 通过：中文 recall@1 从 6.7% 提高到 90.0%，英文不变；设为默认并在安装时预热；端到端 42/42，恢复 3/3，切换模型 3/3 与 5/5，预热中断后能续传 |
| M1-5 | 外部库（群晖）与手机备份：重复照片（分支 `mac/feat/external-checksum`） | [m1-external-dedupe.md](m1-external-dedupe.md) | 通过：修复前 5/5 复现，修复后 24/24。外部库改为按内容算指纹，手机备份不再重复上传；已有的重复归入"重复项"页面，默认保留外部库原件，相册和收藏随之合并。另外修复了上游的实况照片交叉配对 bug |
| M1-6 | 删除后清理缩略图和转码文件（分支 `mac/fix/offline-trash`） | [m1-delete-cleanup.md](m1-delete-cleanup.md) | 普通删除本来就能清理干净。修复外部库的离线文件清空回收站清不掉的问题，并防止群晖断开超过 30 天时照片被删。修复前 5 项失败，修复后 23/23 |
| M1-7 | macOS 网络宗卷授权（分支 `mac/fix/network-volume-permission`） | [m1-network-volume-permission.md](m1-network-volume-permission.md) | 通过：服务端从固定路径运行 node，只需点一次"允许"，升级后不再询问；ffmpeg 和 exiftool 继承 node 的授权；普通用户就能挂载 NFS |
| M1-8 | 网页上挂载群晖（分支 `mac/feat/network-shares`） | [m1-network-shares.md](m1-network-shares.md) | 通过：管理 → 网络共享里添加 NFS 共享并测试连接；开机自动挂载，群晖重启、断网、句柄失效后自动重连；建外部库时可直接选择；端到端 41/41 |
| M1-9 | 存储位置：缩略图、转码视频、备份和原图放群晖（分支 `mac/feat/storage-locations`） | [m1-storage-locations.md](m1-storage-locations.md) | 通过：管理 → 存储位置里设置，现有文件后台迁移并校验；群晖不在线时相关任务自动暂停、不会误写到 Mac、服务端照常启动，恢复后自动继续；外部库自动跳过 Immich 的目录；端到端 42/42 |
| M1-10 | 视频旋转、镜像，查看时一键旋转（分支 `mac/feat/video-rotate`） | [m1-video-rotation.md](m1-video-rotation.md) | 通过：视频可在编辑器里旋转、镜像（不能裁剪），只改写显示方向、不重新编码，几秒完成、无损；查看照片或视频时 `R` / `Shift+R` 旋转；播放、缩略图、下载、实时转码、重新转码后都正确，与照片编辑结果逐帧一致；端到端 49/49，浏览器 11/11 |
| 模型选型 | OCR 与人脸模型、阈值（分支 `mac/feat/ml-defaults`） | [m1-ml-models.md](m1-ml-models.md) | 通过：OCR 默认改为 PP-OCRv6_medium @1024（真实照片 57/58，原来 48/58；内存 9.0 → 6.6 GB）；人脸保持 buffalo_l；阈值实测后保持上游默认；CoreML 编译不了的模型自动改用 CPU |
| 问题 2 | 自动堆叠（分支 `mac/feat/auto-stack`） | [m1-auto-stack.md](m1-auto-stack.md) | 通过：每个用户在账户设置里开启，可选连拍、RAW+JPG、编辑版、相似照片（相似度 + 拍摄间隔）；上传和外部库扫描后自动执行；只加不删，移出的照片不再放回，可一键移除或重新堆叠；端到端 25/25 |
| RAW 预览 | RAW 照片预览默认用相机内嵌 JPG（分支 `mac/feat/raw-embedded-preview`） | [m1-raw-preview.md](m1-raw-preview.md) | 通过："优先使用嵌入式预览"默认打开，RAW 显示与相机 JPG 一致；升级和切换开关时只自动重做 RAW 的预览；端到端 11/11 |
| 默认设置 | 新安装、新用户按这台的配置（分支 `mac/feat/my-defaults`） | [m1-defaults.md](m1-defaults.md) | 通过：存储模板 `{{y}}/{{MM}}/{{filename}}`、文件夹/人物/回忆侧边栏、自动堆叠全部规则默认开启 |
| 反馈 | 外部库删除、共享卸载后子成员仍能访问 | [m1-external-library-member-feedback.md](m1-external-library-member-feedback.md) | **已修复**（分支 `mac/fix/external-library-delete`）：删库立即对所有人隐藏资产，不依赖后台任务；启动时和清除队列后都会补做删除；卸载共享时外部库资产标记离线、重新挂载后恢复；原图缺失返回 404 并说明原因。单元测试新增 7 项（修复前全部失败），端到端 19/19 |

## M3 安装包

| 编号 | 内容 | 记录 | 结论 |
|---|---|---|---|
| M3-1 | 不需要 Homebrew 的 .pkg（分支 `mac/feat/pkg`） | [m3-pkg.md](m3-pkg.md) | 通过：发布目录自带全部依赖（macOS 15+）；屏蔽 Homebrew 和外网后检查 17/17，新装端到端 36/36，接管一键安装版数据全部保留、端到端 36/36；装着 Homebrew 的 Mac 上也不会混加载 Homebrew 的库；4.9 GB 安装包已签名、经 Apple 公证（0 个问题）。图形界面安装待测试机验证 |

## M4 智能化

| 编号 | 内容 | 记录 | 结论 |
|---|---|---|---|
| M4-0 | 智能化方案：ANE 利用、Apple Vision、视频语音与画面搜索、夜间视觉语言模型、整句搜索 | [m4-intelligence-plan.md](m4-intelligence-plan.md) | 方案。已实测：现有模型全是 fp32，ANE 不能运行；人脸模型转 fp16 后在 ANE 上快 3 倍 |
| M4-1 | 模型用 fp16 在神经网络引擎上运行（分支 `mac/feat/ml-v2-ane`） | [m4-ml-ane.md](m4-ml-ane.md) | 通过：换成上游 v2 导出，智能搜索、人脸快约一倍，OCR 检测改为只用 ANE 再快近一倍；结果一致（中文 recall、人脸指标不变，OCR 真实照片 58/58），向量与原来余弦 ≥ 0.998，升级后不用重建索引；整机内存 +6.0 → +1.6 GB，模型目录 30 → 14 GB。顺带修复安装包里混装两个 OpenCV 的问题。新装、接管 42/42 |

## M2 视频转码用 Apple 硬件

| 编号 | 验证项 | 文件 | 结论 |
|---|---|---|---|
| M2 | VideoToolbox 转码（分支 `mac/feat/videotoolbox`） | [m2-videotoolbox.md](m2-videotoolbox.md) | 通过：端到端 17/17（真实 iPhone HDR、实况照片、2.7K 无人机视频及 10 种衍生格式），亮度、方向、帧数与软件一致；CPU 用量降 83%；长的高码率 H.264 单个转得慢约 1 倍。原生安装默认打开，一次转 2 个 |

## 风险跟踪

| 风险 | 状态 | 结论文件 |
|---|---|---|
| R1 VectorChord 在 macOS 上编译 | **解除**：照官方 macOS CI 编译，约 72 秒；召回率 100%；Immich 迁移全部通过 | [m0-postgres-vectorchord.md](m0-postgres-vectorchord.md) |
| R2 libvips 格式支持不如 Docker 镜像 | **解除**：Homebrew libvips + 源码编译 sharp，24 种素材全部通过 | [m0-libvips-sharp.md](m0-libvips-sharp.md) |
| R3 jellyfin-ffmpeg 的 macOS 版本 | **解除**：官方 `mise.lock` 已锁定 macOS arm64 版本，带 `tonemapx` 和 VideoToolbox，只依赖系统框架 | [m0-ffmpeg-videotoolbox.md](m0-ffmpeg-videotoolbox.md) |
| R4 gunicorn fork 与 CoreML | 出现过 1 次崩溃，之后未复现；改为单进程启动规避。M1-3 中未复现（机器学习服务的几次重启都是官方的空闲退出，退出码 0） | [m0-ml-coreml.md](m0-ml-coreml.md)、[m1-second-mac.md](m1-second-mac.md) |
| 新：`pg_dump` 路径写死为 Linux 位置 | **已修复**：新增 `DB_BIN_DIR` | [m1-db-backup.md](m1-db-backup.md) |
| 新：macOS 自带 gzip 让备份变成 0 字节却报告成功 | **已修复**：服务端拒绝空备份；原生部署必须带 GNU gzip | [m1-db-backup.md](m1-db-backup.md) |
| 新：没有 `LANG` 时 PostgreSQL 起不来 | 已确认，设置 `LC_ALL` 即可解决 | [m0-postgres-vectorchord.md](m0-postgres-vectorchord.md) |
| 新：命令行工具里没有 Homebrew PostgreSQL 用的 SDK 时，VectorChord 编译不过 | **已修复**（`0d7821e7b`）：用 `xcrun` 取本机 SDK，经 `pg_config` 包装脚本替换 `-isysroot`；包装脚本放在无空格路径 | [m1-second-mac.md](m1-second-mac.md) |
| 新：首次使用时模型下载太慢，服务端请求 300 秒超时 | **已修复**：安装时预热（下载可续传，再预编译 CoreML） | [m1-clip-model.md](m1-clip-model.md) |
| 新：Immich 默认的智能搜索模型只懂英文 | **已解决**：原生安装默认用 XLM-Roberta-Large-ViT-H-14；代价是约 14 GB 磁盘、约 7 GB 内存 | [m1-clip-model.md](m1-clip-model.md) |
| 新：模型下载中断后，服务会删掉整个模型目录从头下载 | **已规避**：预热先用 Hugging Face 续传下载 | [m1-clip-model.md](m1-clip-model.md) |
| 新：`tonemap_videotoolbox` 把真实 iPhone HDR 视频调亮 10%–19% | **已规避**：HDR 在 GPU 上解码、缩放，色调映射回到 CPU 用 `tonemapx`，亮度与软件版相差不到 0.3 | [m2-videotoolbox.md](m2-videotoolbox.md) |
| 新：媒体引擎解码高码率 H.264 只有约 150–190 帧/秒，单个视频比软件慢约 1 倍 | **接受**：CPU 省 95%；一次转 2 个时总吞吐与软件相当；可在网页里关掉 | [m2-videotoolbox.md](m2-videotoolbox.md) |
| 新：`immichctl` 经 `~/.local/bin` 链接运行时找不到安装目录 | **已修复**（`aa633c444`） | — |
| 新：外部库照片会被手机备份重复上传 | **已修复**：外部库按内容算指纹，上传查重同时查外部库 | [m1-external-dedupe.md](m1-external-dedupe.md) |
| 新（上游 bug）：实况照片同时在外部库和上传库时被交叉配对，清理重复后外部库照片的动态视频被删 | **已修复**：优先配本库的视频；扫描时纠正已经配错的 | [m1-external-dedupe.md](m1-external-dedupe.md) |
| 新：Immich 会往外部库目录写 `.xmp` 文件 | 上游原有行为，**待你决定**是否改为不写 | [m1-external-dedupe.md](m1-external-dedupe.md) |
| 新：外部库离线文件清空回收站清不掉，缩略图和转码文件一直留着 | **已修复** | [m1-delete-cleanup.md](m1-delete-cleanup.md) |
| 新（上游）：群晖断开超过回收站天数，照片记录连同相册、人脸被删 | **已修复**：外部库不能访问时不删离线照片 | [m1-delete-cleanup.md](m1-delete-cleanup.md) |
| 上游行为：读写挂载时，在 Immich 里删除外部库照片会删掉群晖上的原文件 | **已决定保持**：用 Immich 清理群晖库；Immich 回收站保留 30 天，建议群晖开快照 | [m1-delete-cleanup.md](m1-delete-cleanup.md) |
| 新：后台服务读网络盘要 macOS 授权，没点"允许"之前一直卡住；原来每次升级都要重新授权 | **已修复**：node 固定路径，只需授权一次 | [m1-network-volume-permission.md](m1-network-volume-permission.md) |
| RAW 照片在 Immich 里和相机 JPG 看起来不一样 | **已修复**：默认用相机内嵌的 JPG 做预览，升级时自动只重做 RAW 的预览 | [m1-raw-preview.md](m1-raw-preview.md) |
| 群晖外部库的照片不会自动堆叠 | **已完成**：连拍、RAW+JPG、编辑版、相似照片，每个用户自己设置 | [m1-auto-stack.md](m1-auto-stack.md) |
| 原来挂载群晖只能写 yml 或手动挂载 | **已完成**：网页上管理 NFS 共享 | [m1-network-shares.md](m1-network-shares.md) |
| 新：群晖重启后旧挂载的句柄失效，挂载还在但读不了 | **已修复**：每分钟检查发现后自动重新挂载 | [m1-network-shares.md](m1-network-shares.md) |
| Mac 磁盘小，原图、缩略图、转码视频只能放 Mac | **已完成**：网页上把它们放到群晖，Mac 只留数据库和模型 | [m1-storage-locations.md](m1-storage-locations.md) |
| 用户之间的隔离：非管理员能否只看到自己群晖目录里的照片 | **已审查并加固**：所有路径相关的操作只限管理员，照片按所有者隔离；补上模板越界、外部库误配给他人、从其他路径挂载时漏排除三处 | [m1-storage-locations.md](m1-storage-locations.md#用户之间的隔离分支-macfixuser-isolation) |
| 视频只能看、不能旋转；查看时也没有快捷旋转 | **已完成**：视频旋转和镜像；查看时按 `R` 旋转 | [m1-video-rotation.md](m1-video-rotation.md) |
| 上游不允许编辑实况照片，iPhone 的 HEIC 大多是实况，`R` 对它们无效 | **已完成**：实况照片可旋转、镜像，动态部分一起转；端到端（真实 iPhone 实况照片）23/23，浏览器 6/6 | [m1-video-rotation.md](m1-video-rotation.md) |
| 新（上游 bug）：读编辑列表时没按顺序，镜像和旋转同时存在时可能顺序颠倒 | **已修复** | [m1-video-rotation.md](m1-video-rotation.md) |
| 新（上游）：PP-OCRv5_server 在 CoreML 上编译失败，选了它 OCR 全部报错 | **已修复**：该模型自动改用 CPU | [m1-ml-models.md](m1-ml-models.md) |

## 后续事项

| 阶段 | 事项 |
|---|---|
| ~~M1~~ | ~~`pg_dump` / `psql` 路径可配置~~（已完成，见 M1-1） |
| ~~M1~~ | ~~机器学习服务单进程启动；launchd 配置（`LC_ALL`、`DB_BIN_DIR`、GNU gzip）；进程组管理；安装流程；补测从备份恢复~~（已完成，见 M1-2） |
| ~~M1~~ | ~~安装后预热机器学习模型~~（已完成，见 M1-4） |
| M1 | 第二台 Mac：切换到 XLM 并重建索引；补测数据库备份、从备份恢复，完整跑一遍端到端脚本 |
| ~~M2~~ | ~~VideoToolbox：SDR 走全硬件；HDR 走"硬件解码与缩放 + CPU `tonemapx` + 硬件编码"；校准 `-q:v`~~（已完成，见 M2） |
| M2 | 在浏览器里实际验证实时转码（网页播放时按需转码）走 VideoToolbox |
| ~~问题 2~~ | ~~自动堆叠：连拍、RAW+JPG、手机编辑版、高相似度~~（已完成） |
| 问题 2 | 在真实群晖照片上验证自动堆叠，确认相似度推荐值 |
| M1-5 | 在真实群晖 NFS 上用一个小目录验证一遍 |
| ~~提前~~ | ~~网页上挂载群晖（NFS）：添加、测试连接、状态、开机自动挂载、断线重连，建外部库时直接选择~~（已完成，见 M1-8） |
| 以后 | 网页上挂载 SMB 共享（密码存钥匙串） |
| M1-8 | 在真实群晖上验证网络共享，并确认群晖重启后句柄是否不变 |
| M1-9 | 在真实群晖上验证存储位置：NFS 写入文件的属主（Squash 为 admin）下各用户能否在 File Station 看到自己的 `Photos/Immich`；缩略图目录在机械硬盘 / SSD 缓存上的速度 |
| M3 | 打包 libvips 及其约 30 个依赖库，改写动态库引用路径；统一 `MACOSX_DEPLOYMENT_TARGET`；PostgreSQL 客户端工具与 GNU gzip 一并打包 |
| M3 | 模型随包提供（4.8 GB 下载内容即可；CoreML 编译产物和路径绑定，安装时在本机编译，约 2 分钟） |
| M3 | 系统级服务（LaunchDaemon），开机即运行，不依赖登录（FileVault 机器需要） |
| 跟进上游 | 上游 `main` 开始设置 `MACHINE_LEARNING_MODEL_REVISION: v2`，跟进到这个版本时 `run-service` 要同步设置 |
| ~~可选~~ | ~~OCR 单独走 CPU~~（不需要：v6_medium 用 CoreML 比 CPU 快 3.6 倍，见模型选型） |
