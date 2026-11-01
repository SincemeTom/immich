# 法律与许可：这个 macOS 版本要注意什么

- 日期：2026-11-01
- 适用：`SincemeTom/immich` 仓库的 macOS 原生版（`mac/*` 分支、`v<版本>-mac.<序号>` 标签和对应的 `.pkg` 安装包）
- **这不是法律意见。** 下面是按各许可证原文和 Immich 官方说明整理的做法，适用于"免费、非商业地给自己、家人和朋友用"。如果要收费、给公司用或大范围公开发布，请先咨询律师。

## 一句话结论

可以发布，但要做到四件事：**写明是非官方版本、附上所有许可文本、提供源代码（包括第三方 GPL 组件的）、不提供担保**。这四件事已经做进了仓库和安装包（见"已经做了什么"）。真正需要你注意的风险只有一个：**人脸识别模型的许可只允许非商业研究用途**。

## 1. 我们分发了什么

| 分发的东西 | 在哪 | 涉及的许可 |
|---|---|---|
| 源代码（Immich + 我们的修改） | GitHub 公开仓库 | AGPL-3.0 |
| 安装包 `.pkg` | 自己保存、发给别人 | AGPL-3.0（Immich）+ 70 个第三方组件各自的许可 + 3 个机器学习模型的许可 |
| 运行起来的网页服务 | 用户自己的 Mac 上 | AGPL-3.0 第 13 条（通过网络使用修改版） |

## 2. Immich 本身：AGPL-3.0

Immich 以 GNU AGPL v3 发布（仓库根目录 `LICENSE`）。修改和再分发都允许，条件是：

| AGPL 的要求 | 我们怎么做到 |
|---|---|
| 保留版权声明和许可全文 | 仓库保留 `LICENSE`；安装包里有 `licenses/immich/LICENSE` |
| 修改版要显著标明"已修改"，并注明日期（第 5 条 a） | 首页 README 写明这是修改版；`macos/CHANGELOG.md` 写明每个版本改了什么、日期；git 历史记录每处修改 |
| 修改部分也以 AGPL 发布（第 5 条 c） | 全部修改都在这个公开仓库里，同样是 AGPL |
| 分发二进制时提供对应源代码（第 6 条） | 每个正式版有 git 标签，源码在 GitHub 公开；打包时还会把这个提交的源码打成压缩包，和安装包一起留档 |
| **通过网络给别人用修改版，也要让他们能拿到源码（第 13 条）** | 网页的"帮助"和"关于"里显示本版本的仓库、标签、提交，并链接到该提交的源码（`run-service` 设置 `IMMICH_THIRD_PARTY_SOURCE_URL` 等，上游专为第三方版本留的设置） |
| 不能附加额外限制 | 没有附加任何限制 |

## 3. 第三方组件：70 个

安装包为了不依赖 Homebrew，自带了 PostgreSQL、Node.js、Python、ffmpeg、libvips、ImageMagick 和它们用到的 60 多个库。打包时 `macos/package/collect_licenses.py` 自动整理出清单：

| 类型 | 数量 | 例子 | 义务 | 我们怎么做到 |
|---|---|---|---|---|
| 宽松许可（MIT、BSD、Apache-2.0、PostgreSQL、Unicode、ImageMagick 等） | 47 | PostgreSQL、Node.js、OpenSSL、libpng、Valkey | 附上许可全文；Apache 的还要带上 NOTICE 文件 | 安装后在 `~/Library/Application Support/Immich/current/licenses/`，按组件分目录 |
| **Copyleft**（GPL、LGPL、AGPL、MPL） | 23 | ffmpeg（含 x264、x265，GPL-3.0）、x265、fftw、gzip（GPL）；libvips、glib、cairo、pango、libheif（LGPL）；VectorChord（AGPL） | 附上许可全文，**并提供对应版本的源代码** | 许可全文同上；每次打包把这 23 个组件那个版本的源码下载下来（约 220 MB），和安装包一起留档（`sources-<版本>/`），清单里写明每个的源码地址 |
| 二选一许可 | — | VectorChord（AGPL-3.0 或 Elastic License 2.0） | 选一个遵守 | 选 AGPL-3.0，和 Immich 一致 |
| npm、Python 包 | 约 1000 | 服务端、网页、机器学习服务的依赖 | 附许可 | 它们自带的许可文件原样随包分发；另有清单 `npm-packages.md`、`python/packages.md` |

LGPL 还要求用户能替换这个库：这些库都是单独的动态库文件（`lib/*.dylib`），可以替换，满足要求。

GPL 组件和 Immich 只是放在同一个安装包里各自运行（"聚合"），不影响 Immich 本身的许可。

## 4. 机器学习模型：注意人脸模型

| 用途 | 模型 | 许可 | 结论 |
|---|---|---|---|
| 智能搜索 | XLM-Roberta-Large-ViT-H-14（OpenCLIP，LAION） | MIT | 可以自由使用、再分发 |
| 文字识别 | PP-OCRv6_medium（百度 PaddleOCR） | Apache-2.0 | 可以自由使用、再分发 |
| **人脸** | **buffalo_l（InsightFace）** | **"仅限非商业研究用途"** | **有风险，见下** |

InsightFace 的原文："The training data containing the annotation (and the models trained with these data) are available for non-commercial research purposes only."（代码是 MIT，但预训练模型不是。）商业授权要联系 `recognition-oss-pack@insightface.ai`。

- **Immich 官方本身就默认用这个模型**，全世界的自托管用户都在用，由 Immich 从 Hugging Face 下发。按字面，"非商业研究"不完全等于"家庭自用"，但家庭自用是非商业的，实际风险很低。
- **我们多做了一件事：把模型打进了安装包**，等于我们自己也在再分发它。只给自己和家人用时影响不大；如果要公开发布安装包，建议改成"安装包不带人脸模型，第一次使用时从 Immich 的 Hugging Face 下载"（和官方一样），这样再分发的就不是我们了。
- **任何商业用途**（公司内部使用、收费服务、卖装好的机器）都必须先取得 InsightFace 授权，或者关闭人脸识别。
- 安装包的许可页、`licenses/data/models.md` 里都写明了这一点。

## 5. 商标：Immich 名称和标志

"Immich"名称和标志属于 FUTO。官方 FAQ 对第三方的要求（针对转售商）：**不要冒充官方或暗示得到了官方认可**；转售商不要在网站和营销材料上展示他们的商标。

- 我们是免费、非商业的社区版本，不是转售。软件本身显示 Immich 的名字和标志是不可避免的（这就是 Immich 的界面）。
- 已经做的：首页、安装器欢迎页和许可页、网页"帮助"里的第三方信息、许可清单，都写明"**非官方，与 Immich 团队和 FUTO 无关，未经认可，不由其支持**"，并提醒遇到问题不要去官方反馈。
- 建议：不要用 Immich 的标志做自己的宣传；如果以后公开推广，给 `questions@immich.app` 发邮件说明情况，或者给这个版本另起一个名字（如"XX 相册，基于 Immich"）。

## 6. 不提供担保

AGPL 第 15、16 条：软件按"现状"提供，不提供担保，作者不对损失负责。首页、安装器许可页都写明了这一点，并提醒用户自己备份照片库和数据库（`immichctl` 的数据库备份、群晖快照）。

## 7. 其他

| 项目 | 情况 |
|---|---|
| 地理数据（照片地点反查） | 中文地名来自 immich-geodata-cn，GPL-3.0：许可原文和对应版本的源码已经随安装包附上、留档（`licenses/immich-geodata-cn/`）。它以 GeoNames 为底（CC BY 4.0，需要署名，已写在 `licenses/data/geodata.md`），国内地名由该项目通过高德和 Nominatim（OpenStreetMap，ODbL）的逆地理编码生成。高德的服务条款一般不允许转存、再分发它的数据：现在免费、非商业地分发问题不大，以后如果公开推广，要评估这一点，或者换成只用 OpenStreetMap 生成的数据。国界来自 Natural Earth，公共领域 |
| Apple 开发者签名 | 用你的 Developer ID 签名、公证后在 App Store 之外分发，符合 Apple 开发者协议；签名证书在你名下，证书过期不影响已发布的包（见 [RELEASING.md](RELEASING.md)） |
| 隐私 | 这个版本没有增加任何数据收集。上游本身会联网检查新版本、加载地图瓦片，可在 管理 → 设置 里关闭 |

## 8. 已经做了什么

安装器许可页、安装包里的 `licenses/`、网页里的源码链接从 **v3.3.5-mac.3** 起才有。已经发布的 mac.1、mac.2 补做了：两个版本的组件许可清单和 23 个 copyleft 组件的源码已经留档（`macos/package/releases/`），清单附在对应的 GitHub Release 上；这两个版本的源码就是仓库里的对应标签。

| 位置 | 内容 |
|---|---|
| 仓库首页 `README.md` | 开头加了中英文说明：非官方、许可、模型限制、不担保，链接到本文 |
| `macos/README.md` | 这个版本的说明：装什么、怎么装、去哪看许可 |
| 安装器 | 新增"许可"页（中英文），需要点"同意"；欢迎页写明非官方 |
| 安装包里的 `licenses/` | `THIRD-PARTY-NOTICES.md`（70 个组件的版本、许可、源码地址）+ 每个组件的许可全文 + npm / Python 包清单 + 模型、地理数据说明 |
| 打包时的源码留档 | `macos/package/build/sources-<版本>/`：Immich 本次提交和 23 个 copyleft 组件的源码；发布时和安装包一起复制到 `macos/package/releases/` |
| 网页"帮助 → 第三方资源"和"关于" | 指向本仓库、本版本的提交和文档 |
| `macos/CHANGELOG.md` | 每个版本的修改和日期 |

打包脚本找不到某个组件的许可、或者某个 copyleft 组件拿不到源码时会停下，不会打出缺许可的包。

## 9. 需要你决定的事

1. **人脸模型要不要继续打进安装包**：只自己和家人用，保持现状即可；要公开发布安装包，建议改为首次使用时下载（我可以改，代价是第一次装要联网下载约 190 MB）。
2. **源码和问题的联系方式**：许可清单里写的是"通过项目的 GitHub 页面索取"，但这个仓库现在没开 Issues。建议打开 Issues（仓库设置里勾选，或运行 `gh repo edit SincemeTom/immich --enable-issues`），或者在 README 里留一个邮箱。
3. **发布范围**：现在的做法适合免费、非商业分发。如果以后要商用或收费，需要找律师，并处理人脸模型授权和商标问题。
