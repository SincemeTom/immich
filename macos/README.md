# Immich macOS 原生版（非官方）

在 Apple 芯片的 Mac 上直接运行 Immich，不需要 Docker。由社区开发者基于 [Immich](https://github.com/immich-app/immich) 修改，**与 Immich 团队和 FUTO 无关，未经其认可，也不由其提供支持**；这个版本的问题请不要去 Immich 官方反馈。

## 和官方 Docker 版相比

- 一个 `.pkg` 安装包装好全部组件（PostgreSQL、Valkey、Node.js、Python、ffmpeg、libvips……），开机自动运行
- 机器学习在神经网络引擎上运行；智能搜索默认用中英日多语言模型
- 视频转码用 Apple 媒体引擎
- 网页上挂载群晖 NFS 共享，可以把原图、缩略图、转码视频放到群晖
- 地点显示中文；没有位置的照片按前后拍的照片推断位置
- Apple Vision 内容分析：中文自动标签、截图、二维码；macOS 26 起视频里说的话可以搜索
- 共享相册分仅查看、可下载、可编辑、可管理四档权限
- 外部库查重、自动堆叠、视频旋转等改进

全部改动的汇总见 [FEATURES.md](FEATURES.md)，各版本内容见 [CHANGELOG.md](CHANGELOG.md)，每项改动的验证记录见 [verification/](verification/README.md)。

## 安装

- 需要：Apple 芯片（M1 及以后）的 Mac，macOS 15 或以上，至少 20 GB 可用空间（准备好模型后约占 16 GB）
- 用以后运行 Immich 的账号登录，双击 `Immich-<版本>.pkg`。安装约一两分钟，完成后打开 `http://localhost:2283` 创建管理员；机器学习模型随后在后台准备（约 10–15 分钟）
- 升级：直接安装新版本的安装包，数据都会保留
- 管理：终端里的 `immichctl status`、`immichctl logs`、`immichctl doctor`；卸载用 `immichctl uninstall`（保留数据）或加 `--purge`（照片库始终保留）
- 从源代码安装（开发用）：`macos/native/install.sh`

安装包的 SHA-256 校验值随安装包一起提供：`shasum -a 256 -c Immich-<版本>.pkg.sha256`。

## 许可

- Immich 和这个版本的全部修改都以 [GNU AGPL v3](../LICENSE) 发布，源代码就在这个仓库，每个正式版有对应标签
- 安装包还带有约 70 个第三方组件，各自按其许可分发；安装后的 `~/Library/Application Support/Immich/current/licenses/THIRD-PARTY-NOTICES.md` 列出全部组件、版本、许可和源码地址
- **人脸识别模型 buffalo_l（InsightFace）只允许非商业研究用途**，商业使用前须取得 InsightFace 授权或关闭人脸识别
- 按"现状"提供，不提供任何担保，请自行备份

详细说明见 [LEGAL.md](LEGAL.md)。发布流程见 [RELEASING.md](RELEASING.md)。

---

**English.** An unofficial native macOS build of [Immich](https://github.com/immich-app/immich): a self-contained
`.pkg` for Apple silicon Macs (macOS 15+), no Docker. It is not made, endorsed or supported by the Immich team or FUTO.
Licensed under the AGPL-3.0 like Immich; third-party licenses ship in the package (`licenses/`). The bundled face
recognition model (InsightFace buffalo_l) is for non-commercial research use only. No warranty. See
[LEGAL.md](LEGAL.md) (Chinese).
