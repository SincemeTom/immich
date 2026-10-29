# M0-3 libvips / sharp 图片格式支持

- 日期：2026-10-29
- 结论：**通过**。风险 R2 解除，前提是 sharp 必须从源码编译、连接 Homebrew 的 libvips

## 关键发现：sharp 的预编译包缺格式

npm 安装 sharp 时默认用自带的预编译 libvips（`@img/sharp-libvips-darwin-arm64`），它支持的输入格式是：

```
jpeg png webp tiff gif svg heif vips
```

**不支持 JXL 和相机 RAW**。官方 Docker 镜像也不用这个预编译包，而是从源码编译 sharp、连接镜像里自带的 libvips（`server/Dockerfile` 第 42 行）。原生部署必须照做。

## 做法

```bash
brew install vips                     # 8.18.7，带 libheif、libjxl、libraw、libuhdr、openjpeg 等
cd server && pnpm install --frozen-lockfile
# 官方已在 pnpm-workspace.yaml 中为 sharp 注入 node-addon-api 和 node-gyp
SHARP_FORCE_GLOBAL_LIBVIPS=true pnpm --config.verify-deps-before-run=false \
  --dir <sharp 包目录> exec npm run build    # 约 50 秒
```

编译后 sharp 连接的是 `/opt/homebrew/opt/vips/lib/libvips-cpp.42.dylib`，输入格式变成：

```
jpeg png webp tiff magick openslide ppm fits gif svg heif pdf vips jp2 jxl rad dcraw
```

链接时有 `building for macOS-11.0, but linking with dylib ... built for newer version 15.0` 的警告，只是最低系统版本的声明不一致，不影响运行。M3 打包时统一设置 `MACOSX_DEPLOYMENT_TARGET` 即可消除。

## 验证

### 1. libvips 命令行（`macos/scripts/m0-vips-formats.sh`）

用 `e2e/test-assets/formats` 下的全部 24 个素材，生成 1440 预览图和 250 缩略图：**24/24 成功**。

### 2. 服务端实际代码路径（`macos/scripts/m0-sharp-probe.sh`）

直接调用服务端的 `MediaRepository`（`decodeImage`、`generateThumbnail`、`generateThumbhash`），参数与缩略图任务的默认值一致（Display P3 色域、1440 JPEG 预览、250 WebP 缩略图）：**25/25 测试通过**。

| 类别 | 文件 | 读取器 |
|---|---|---|
| AVIF | 8bit-sRGB、10bit-HDR-P3 | heifload |
| HEIC | iPhone 7、Samsung One UI 6（动态照片） | heifload |
| JPEG XL | 8bit-sRGB、16bit-HDR-P3 | jxlload |
| Ultra HDR JPEG | Pixel 6 Pro、Pixel 8a（动态照片） | uhdrload |
| 相机 RAW | Canon CR2 ×3、Fujifilm RAF、Nikon NEF ×2、Panasonic RW2、Ricoh DNG、Sony ARW ×2 | dcrawload |
| 其他 | JPEG、PNG、WebP | 对应读取器 |

最慢的是 Fujifilm X100V 压缩 RAF（2600 万像素），约 1.7 秒；其余 RAW 0.3–0.6 秒。

## 对后续阶段的影响

- M1：安装脚本里要在 `pnpm install` 之后加一步 sharp 源码编译。
- M3：打包时 libvips 和它的约 30 个依赖库都要打进 `.app`，并改写动态库引用路径。这是打包工作量的主要部分。
