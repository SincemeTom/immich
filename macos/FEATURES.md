# 做了哪些事情

这个版本基于上游 Immich `v3.3.5`。下面按主题列出改了什么，每项后面是验证记录（`verification/`）。按版本的变化见 [CHANGELOG.md](CHANGELOG.md)，没做完的在文末。

截至 `v3.3.5-mac.6`（2026-11-03）。

## 1. 不用 Docker，在 Mac 上直接运行

| 做了什么 | 记录 |
|---|---|
| 技术验证：机器学习（CoreML）、PostgreSQL 17 + VectorChord、libvips、jellyfin-ffmpeg 都能在 Apple 芯片上原生运行，服务端不改代码就能跑通 | [verification/README.md](verification/README.md#m0-技术验证结论) |
| 一键安装（`install.sh`）和 launchd 托管：开机运行、崩溃拉起、升级、卸载；管理命令 `immichctl`（`status`、`logs`、`doctor`、`psql`、`uninstall`） | [m1-native-install.md](verification/m1-native-install.md) |
| `.pkg` 安装包：自带 PostgreSQL、Valkey、Node.js、Python、ffmpeg、libvips 等全部依赖，不需要 Homebrew，macOS 15 及以上；能接管一键安装版的数据 | [m3-pkg.md](verification/m3-pkg.md) |
| 安装不超时：模型改在后台准备，安装约一分钟结束；准备期间网页、App、上传照常，智能搜索、人脸、文字识别等模型就绪后再做 | [m4-pkg-postinstall-timeout.md](verification/m4-pkg-postinstall-timeout.md)、[m4-person-cover-during-warmup.md](verification/m4-person-cover-during-warmup.md) |
| 安装脚本在进程多时不再失败（管道提前退出的 SIGPIPE） | [m4-pkg-postinstall-sigpipe.md](verification/m4-pkg-postinstall-sigpipe.md) |
| 数据库备份：`pg_dump` 路径可配置（`DB_BIN_DIR`），拒绝 0 字节的空备份 | [m1-db-backup.md](verification/m1-db-backup.md) |
| 签名、Apple 公证；许可页、第三方许可清单、GPL 组件源码留档 | [RELEASING.md](RELEASING.md)、[LEGAL.md](LEGAL.md) |
| 新安装、新用户的默认设置：存储模板 `{{y}}/{{MM}}/{{filename}}`、侧边栏、自动堆叠 | [m1-defaults.md](verification/m1-defaults.md) |

## 2. 用好 Mac 的硬件

| 做了什么 | 记录 |
|---|---|
| 机器学习用 CoreML；模型转 fp16 在神经网络引擎（ANE）上运行，智能搜索、人脸快约一倍，内存多占从 6.0 GB 降到 1.6 GB | [m0-ml-coreml.md](verification/m0-ml-coreml.md)、[m4-ml-ane.md](verification/m4-ml-ane.md) |
| 中文智能搜索：默认用 XLM-Roberta-Large-ViT-H-14，中文 recall@1 从 6.7% 提到 90% | [m1-clip-model.md](verification/m1-clip-model.md) |
| OCR 默认 PP-OCRv6_medium（真实照片 57/58，原来 48/58）；CoreML 编译不了的模型自动改用 CPU | [m1-ml-models.md](verification/m1-ml-models.md) |
| 视频转码用 Apple 媒体引擎（VideoToolbox），CPU 用量降 83%，HDR 亮度与软件转码一致 | [m2-videotoolbox.md](verification/m2-videotoolbox.md) |

## 3. 和群晖（NAS）一起用

| 做了什么 | 记录 |
|---|---|
| 网页上挂载 NFS 共享：测试连接、开机自动挂载、群晖重启或断网后自动重连，建外部库时直接选 | [m1-network-shares.md](verification/m1-network-shares.md) |
| 存储位置：原图、缩略图、转码视频、备份可以放群晖；群晖不在线时相关任务暂停，不会写到 Mac 上 | [m1-storage-locations.md](verification/m1-storage-locations.md) |
| 网络宗卷授权只需点一次"允许"，升级后不再问 | [m1-network-volume-permission.md](verification/m1-network-volume-permission.md) |
| 外部库按内容查重，手机备份不再重复上传；已有的重复进"重复项" | [m1-external-dedupe.md](verification/m1-external-dedupe.md) |
| 群晖断开超过回收站天数，不再删掉照片记录（连同相册、人脸）；离线文件的缩略图能清理 | [m1-delete-cleanup.md](verification/m1-delete-cleanup.md) |
| 删除外部库、卸载共享后，其他成员立即看不到；重新挂载后恢复 | [m1-external-library-member-feedback.md](verification/m1-external-library-member-feedback.md) |
| 照片在 NAS 上时编辑保存不再误报失败 | [m1-edit-nfs-timeout.md](verification/m1-edit-nfs-timeout.md) |
| 服务器统计可以计入外部库的用量（默认关闭，配额只算上传的） | [CHANGELOG.md](CHANGELOG.md)（mac.5） |
| 服务器总量包括网络共享（同一个存储卷只算一次，没连上的不算）；左下角显示自己的用量（上传 + 外部图库），上限是配额或服务器总量；管理后台列出本机和每个共享 | [m1-storage-space.md](verification/m1-storage-space.md) |

## 4. 照片整理

| 做了什么 | 记录 |
|---|---|
| 自动堆叠：连拍、RAW+JPG、编辑版、相似照片，每个用户自己设置；封面选美学分高的一张 | [m1-auto-stack.md](verification/m1-auto-stack.md) |
| RAW 默认用相机内嵌的 JPG 做预览，和相机里看到的一样 | [m1-raw-preview.md](verification/m1-raw-preview.md) |
| 视频、实况照片可以旋转、镜像（不重新编码）；查看时按 `R` 旋转 | [m1-video-rotation.md](verification/m1-video-rotation.md) |
| 地点显示中文，国内到乡镇、街道，可以按中文地名搜索 | [m4-geodata-cn.md](verification/m4-geodata-cn.md) |
| 没有位置的照片按前后 1 小时内拍的照片推断位置，标记"推断"，可清除 | [m4-location-inference.md](verification/m4-location-inference.md) |
| 内容分析（Apple Vision，不用下载模型）：中文自动标签、截图、二维码、美学分；macOS 26 起视频里说的话可搜索，识别文档、镜头脏污 | [m4-vision-research.md](verification/m4-vision-research.md)、[m4-vision-content.md](verification/m4-vision-content.md)、[m4-vision-speech-deadlock.md](verification/m4-vision-speech-deadlock.md) |
| 人物：新识别的人物可以默认隐藏；"隐藏未命名的人物"对全部生效；设特色照片后头像马上换 | [CHANGELOG.md](CHANGELOG.md)（mac.5） |

## 5. 多人使用

| 做了什么 | 记录 |
|---|---|
| 用户隔离：路径相关的操作只限管理员，非管理员只能访问分配给自己的外部库 | [m1-storage-locations.md](verification/m1-storage-locations.md#用户之间的隔离分支-macfixuser-isolation) |
| 共享相册权限：仅查看、可下载、可编辑、可管理、所有者五档；兼容官方手机 App | [m4-album-permissions.md](verification/m4-album-permissions.md) |

## 6. 修掉的上游问题

- 实况照片同时在外部库和上传库时被交叉配对，清理重复后外部库照片的动态视频被删（[m1-external-dedupe.md](verification/m1-external-dedupe.md)）
- 读编辑列表时没按顺序，镜像和旋转同时存在时可能颠倒（[m1-video-rotation.md](verification/m1-video-rotation.md)）
- PP-OCRv5_server 在 CoreML 上编译失败，OCR 全部报错（[m1-ml-models.md](verification/m1-ml-models.md)）
- `pg_dump` 路径写死为 Linux 位置；macOS 自带 gzip 让备份变成 0 字节却报成功（[m1-db-backup.md](verification/m1-db-backup.md)）
- 模型下载中断后整个模型目录被删掉重下（[m1-clip-model.md](verification/m1-clip-model.md)）

## 7. 发布记录

| 版本 | 日期 | 主要内容 |
|---|---|---|
| `v3.3.5-mac.1` | 2026-10-31 | 第一个正式版：`.pkg`、CoreML、中文搜索、VideoToolbox、群晖、外部库、自动堆叠、视频旋转 |
| `v3.3.5-mac.2` | 2026-11-01 | 模型在神经网络引擎上运行，后台准备模型（有安装失败的缺陷） |
| `v3.3.5-mac.3` | 2026-11-01 | 修复 mac.2 的安装失败；许可和源码留档 |
| `v3.3.5-mac.4` | 2026-11-01 | 地点显示中文 |
| `v3.3.5-mac.5` | 2026-11-02 | Apple Vision 内容分析；人物、编辑保存的修复；用量统计计入外部库 |
| `v3.3.5-mac.6` | 2026-11-03 | 位置推断、共享相册权限；视频语音识别卡死、模型准备期间重启的修复 |

## 8. 还没做

**要在真实环境验证**（需要群晖或第二台 Mac）

- 在真实群晖上验证网络共享（群晖重启后句柄是否不变）、存储位置（文件属主、File Station 可见、缩略图速度）、小目录外部库
- 在真实群晖照片上确认自动堆叠的相似度推荐值
- 第二台 Mac：切换到中文搜索模型并重建索引，补测备份、恢复和完整端到端
- 浏览器里实际验证实时转码走 VideoToolbox
- 测试机用 Installer 图形界面真实安装、升级

**等你决定**

- Immich 会往外部库目录写 `.xmp` 文件，要不要改成不写（[m1-external-dedupe.md](verification/m1-external-dedupe.md)）

**智能化方案剩下的**（[m4-intelligence-plan.md](verification/m4-intelligence-plan.md)；已完成 A1 神经网络引擎、A3 Apple Vision、B2 视频语音）

| 顺序 | 内容 |
|---|---|
| 1 | B1 + B3：视频按场景抽多帧建搜索索引，识别关键帧里的文字 |
| 2 | A2：评估 FG-CLIP 2，中文更好才换 |
| 3 | D2：按 GPS 自动整理旅行、事件 |
| 4 | C1：夜间用视觉语言模型给照片写中文描述 |
| 5 | D1、D3、D4：整句搜索、精选、宠物 |

**以后**

- 网页上挂载 SMB 共享（密码存钥匙串）
- 系统级服务（LaunchDaemon），不登录也运行（FileVault 机器需要）
- 跟进上游新版本（上游 `main` 开始设置 `MACHINE_LEARNING_MODEL_REVISION: v2`，届时 `run-service` 要同步）
