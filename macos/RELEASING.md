# 发布流程

每个正式版都对应一个 git 标签，标签一经发布就不再移动、不再删除。

## 版本号、分支和标签

| 分支 / 标签 | 用途 |
|---|---|
| `mac/feat/*`、`mac/fix/*` | 功能和修复分支，测试通过后合入 `mac/develop` |
| `mac/develop` | 日常开发；从这里打的包是**开发版**：`Immich-3.3.5-dev-<提交>.pkg`，安装器里显示 `3.3.5-dev+<提交>`，只用于测试 |
| `mac/main` | 正式版分支，只从 `mac/develop` 合入测试过的版本；也是仓库首页的默认分支 |
| `v<上游版本>-mac.<序号>` | 正式版标签（附注标签），如 `v3.3.5-mac.2`。从**干净的**标签检出打的包才是正式版：`Immich-3.3.5-mac.2.pkg`，发布目录名 `3.3.5-mac.2`，安装器内部版本 `3.3.5.2` |

- 上游版本必须和 `server/package.json` 一致，否则构建会停下。合入上游新版本（比如 3.4.0）后序号从 1 重新开始：`v3.4.0-mac.1`。
- 已发布的版本有问题：**不要改标签**，修好后发下一个序号。

已发布的正式版：

| 标签 | 日期 | 内容 |
|---|---|---|
| `v3.3.5-mac.1` | 2026-10-31 | 第一个正式版 |
| `v3.3.5-mac.2` | 2026-11-01 | 模型在神经网络引擎上运行；模型改为后台准备。**有缺陷**：Installer 在进程表靠前时安装失败，请用 mac.3 |
| `v3.3.5-mac.3` | 2026-11-01 | 修复 mac.2 的安装失败；许可页、第三方许可清单、源码留档 |
| `v3.3.5-mac.4` | 2026-11-01 | 照片地点显示中文（国内到乡镇、街道） |

每个版本的详细内容见 [CHANGELOG.md](CHANGELOG.md)。

## 步骤

### 1. 发布前

- [ ] 要发布的修改都已合入 `mac/develop`，每个都有验证记录（`macos/verification/`）
- [ ] 在 [CHANGELOG.md](CHANGELOG.md) 里写好这个版本：日期、新功能、修复、已知问题、升级注意事项
- [ ] 从 `mac/develop` 打一个开发版（`macos/package/build-pkg.sh`），在**测试机上用 Installer 真实安装**：
  - 全新安装一次、在旧版本上升级一次
  - `/var/log/install.log` 里 `immich postinstall: configure.sh: exit 0 after N s`，N 远小于 600（Installer 的时限）
  - 后台准备模型完成（`immichctl status` 不再显示 `models: being prepared`），网页、上传、搜索、人脸正常
- [ ] 这台 Mac 上跑 `macos/scripts/m3_standalone.sh <发布目录> <模型目录> both`，全部通过
- [ ] `macos/package/tests/postinstall-pipes.sh` 通过（安装脚本在进程很多、Installer 排在前面时也不出错）

### 2. 打标签

```bash
git checkout mac/main && git merge --no-ff mac/develop -m "Merge branch 'mac/develop' into mac/main: v3.3.5-mac.3"
git tag -a v3.3.5-mac.3 -m "v3.3.5-mac.3: 一句话说明"
git push origin mac/main mac/develop v3.3.5-mac.3
```

### 3. 打包

```bash
git status --short --untracked-files=no   # 必须为空，否则打出来是 -dirty 的开发版
macos/package/build-pkg.sh                # 检出在标签上时自动按正式版打包，签名并公证（约 45 分钟）
git checkout mac/develop
```

产物在 `macos/package/build/`：

| 文件 | 内容 |
|---|---|
| `Immich-3.3.5-mac.3.pkg` | 安装包（约 4.7 GB），已签名、公证 |
| `Immich-3.3.5-mac.3.pkg.sha256` | 校验值 |
| `sources-3.3.5-mac.3/` | 本次提交的 Immich 源码和 23 个 GPL/LGPL 组件的源码（约 220 MB），许可要求随二进制提供，见 [LEGAL.md](LEGAL.md) |

安装包里的 `licenses/` 由打包脚本自动生成；缺任何一个组件的许可或源码时构建会停下。

### 4. 检查

```bash
cd macos/package/build
spctl --assess --type install Immich-3.3.5-mac.3.pkg           # 无输出、退出码 0
pkgutil --check-signature Immich-3.3.5-mac.3.pkg | head -4      # Developer ID Installer: Tao Wang；trusted by the Apple notary service
xcrun stapler validate Immich-3.3.5-mac.3.pkg                  # The validate action worked!
shasum -a 256 -c Immich-3.3.5-mac.3.pkg.sha256                 # OK
```

### 5. 留档

```bash
cp -c macos/package/build/Immich-3.3.5-mac.3.pkg{,.sha256} macos/package/releases/
cp -cR macos/package/build/sources-3.3.5-mac.3 macos/package/releases/
```

`macos/package/releases/` 不进 git（`build/` 以后可能被清空）。安装包、`.sha256` 和 `sources-*` 三样一起再备份一份到别处（群晖、网盘），**至少保留 3 年**（GPL 对源码提供期限的要求）。

### 6. GitHub Release

每个标签在 GitHub 上建一个 Release，写上更新说明，附上 `.sha256`：

```bash
gh release create v3.3.5-mac.3 --repo SincemeTom/immich --draft --title "v3.3.5-mac.3" \
  --notes-file <这个版本在 CHANGELOG.md 里的那一段> macos/package/releases/Immich-3.3.5-mac.3.pkg.sha256
# 在网页上检查草稿，再点 Publish
```

安装包有 4.7 GB，超过 GitHub 每个文件 2 GB 的上限，不能放在 Release 里。如果要对外提供下载，放到网盘或自己的服务器，在 Release 说明里写上链接和 SHA-256。

### 7. 发布后

- [ ] 测试机、正式环境装上新版本，`immichctl status` 正常
- [ ] `macos/verification/README.md` 里相关问题标为"已修复（v3.3.5-mac.3）"

## 证书

签名带 Apple 的安全时间戳，公证票据也已装订进安装包。证书（2027-11-29 到期）过期后，之前打的包照样能装、装好的程序照样能运行；只有证书被吊销才会失效。证书过期后只是不能再打**新**包，届时在开发者后台续一张 Developer ID 证书即可。钥匙串里的两张证书（Developer ID Application、Developer ID Installer）请导出 `.p12` 备份。
