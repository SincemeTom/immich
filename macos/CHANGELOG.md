# 更新记录

Immich macOS 原生版（非官方）的各个版本。版本号是 `<上游 Immich 版本>-mac.<序号>`，每个版本对应一个 git 标签，发布流程见 [RELEASING.md](RELEASING.md)。这个版本基于上游 Immich 修改，改动的验证记录在 [verification/](verification/README.md)。

## 未发布

**新功能**

- 照片地点显示中文，国内到乡镇、街道一级："上海市 闵行区 江川路街道 / 上海市 / 中国"（原来是"Jiangchuanlu / Shanghai / China"），也能用中文地名搜索。数据来自 immich-geodata-cn（GPL-3.0，`macos/native/geodata.sh`）；国外的国家名是中文，城市名除日本外仍是英文
- 升级后服务端自动导入新数据（几秒）；已有照片的地名要在 管理 → 任务 → 提取元数据 点一次"全部"才会更新，新照片不用

## v3.3.5-mac.3（2026-11-01）

基于上游 v3.3.5。

**修复**

- mac.2 的安装包在 Installer 里几秒就报"安装失败"、什么都没装：安装脚本找安装用户时，`ps` 的输出超过管道缓冲区、读取一方提前退出，脚本收到 SIGPIPE 退出。是否出现取决于 Installer 在进程表里的位置，机器越忙越容易失败（[m4-pkg-postinstall-sigpipe.md](verification/m4-pkg-postinstall-sigpipe.md)）。同类写法全部改掉；安装脚本开头先记日志，失败时记下行号

**许可与声明**

- 安装器新增许可页（中英文），欢迎页写明这是非官方版本
- 安装包附带全部第三方组件的许可全文和清单（`licenses/`），打包时一并留档 GPL、LGPL 组件的源代码
- 网页"帮助"和"关于"里指向这个版本自己的源代码（具体提交）和文档
- 首页、`macos/README.md`、[LEGAL.md](LEGAL.md)：许可、模型限制、商标、不担保

## v3.3.5-mac.2（2026-11-01）

基于上游 v3.3.5。

**新功能**

- 机器学习模型改用上游的 v2 导出：在本机转成 fp16，交给神经网络引擎（ANE）运行。智能搜索、人脸快约一倍，OCR 的文字检测再快近一倍；整台 Mac 多占的内存从 6.0 GB 降到 1.6 GB；搜索、人脸、OCR 的结果与原来一致（[m4-ml-ane.md](verification/m4-ml-ane.md)）
- 升级后原来的搜索索引和人脸分组照常使用，不用重建；旧模型及其编译缓存在准备好新模型后自动删除（约 20 GB）

**修复**

- 安装器报"安装失败"：准备模型超过了 Installer 给安装脚本的 600 秒。改为在后台准备，安装约一分钟结束；准备期间网页、App、上传正常，缩略图、搜索、人脸、文字识别排队，准备好后自动处理（[m4-pkg-postinstall-timeout.md](verification/m4-pkg-postinstall-timeout.md)）
- 安装包里混装了两个 OpenCV，16 位模型下人脸和文字识别全部失败（3.3.5-mac.1 用的是 32 位模型，不受影响）
- 模型还在准备时再装一次会出错；中途停止准备会多留一份 2.8 GB 的 CPU 版模型

**升级注意**

- 从 mac.1 升级：第一次准备新模型约 10–15 分钟（M4），期间服务器会重启一次

## v3.3.5-mac.1（2026-10-31）

基于上游 v3.3.5，第一个正式版。

- 不需要 Docker、Homebrew 的 `.pkg` 安装包：自带 PostgreSQL、VectorChord、Valkey、Node.js、Python、ffmpeg、libvips 等全部依赖；可接管一键安装版的数据（[m3-pkg.md](verification/m3-pkg.md)）
- 机器学习用 CoreML；智能搜索默认用中英日多语言模型 XLM-Roberta-Large-ViT-H-14，安装时预先准备好模型（[m1-clip-model.md](verification/m1-clip-model.md)）
- 视频转码用 Apple 媒体引擎（VideoToolbox），HDR 亮度与软件转码一致（[m2-videotoolbox.md](verification/m2-videotoolbox.md)）
- 网页上挂载群晖 NFS 共享，开机自动挂载、断线自动重连；缩略图、转码视频、备份、原图可以放到群晖（[m1-network-shares.md](verification/m1-network-shares.md)、[m1-storage-locations.md](verification/m1-storage-locations.md)）
- 外部库：按内容查重，不再被手机备份重复上传；群晖断开时不删照片记录；删除外部库立即对所有成员生效
- 用户隔离加固：路径相关的操作只限管理员，非管理员只能访问分配给自己的外部库
- 自动堆叠（连拍、RAW+JPG、编辑版、相似照片）；RAW 默认用相机内嵌预览；视频和实况照片可旋转、镜像
- 修复上游问题：数据库备份路径和空备份、实况照片配对错误、编辑顺序、PP-OCRv5_server 在 CoreML 上编译失败等
