# M0-4 jellyfin-ffmpeg 与 VideoToolbox

- 日期：2026-10-29
- 结论：**通过**。风险 R3 解除。VideoToolbox 编码可以直接用；GPU 色调映射结果与软件版不一致，**M2 先不用全 GPU 方案**

## 版本与来源

官方 `mise.toml` / `mise.lock` 已经锁定了 jellyfin-ffmpeg **7.1.3-6** 的 macOS arm64 构建及校验值：

```
jellyfin-ffmpeg_7.1.3-6_portable_macarm64-gpl.tar.xz
sha256:e024d5e78d5414e75f0181036cd21373fafb9270c72894dfd7dbda2572439820
```

下载后校验通过。`ffmpeg`、`ffprobe` 都是 arm64 单文件，`otool -L` 显示**只依赖系统框架**（VideoToolbox、Metal、AudioToolbox 等），打包时不用处理第三方动态库。

## 能力清单

| 类别 | 支持 |
|---|---|
| 硬件编码 | `h264_videotoolbox`、`hevc_videotoolbox`、`prores_videotoolbox` |
| 软件编码 | `libx264`、`libx265`、`libsvtav1`、`libvpx-vp9`、`libopus`、`aac` |
| 硬件解码 | `-hwaccel videotoolbox` |
| 滤镜 | `tonemapx`（Immich 现在用的 CPU 色调映射）、`scale_vt`、`tonemap_videotoolbox`、`transpose_vt`、`overlay_videotoolbox`、`zscale`、`thumbnail` |

## 转码对比（`macos/scripts/m0-ffmpeg-bench.sh`）

素材是合成的 15 秒片段（运动测试图案加时域噪声，模拟手机拍摄），用 Immich 默认参数转码：H.264、720p、CRF 23、`ultrafast`，HDR 用 hable 色调映射。

- `sw`：Immich 现在关闭硬件加速时的做法（libx264 + CPU 缩放 + `tonemapx`）
- `vt_enc`：解码和滤镜不变，只把编码换成 VideoToolbox（`-q:v 60`）
- `vt_full`：硬件解码 + `scale_vt` + `tonemap_videotoolbox` + 硬件编码

| 素材 | 方案 | 耗时 | 帧率 | CPU 时间 | 大小 | 与 sw 的 SSIM |
|---|---|---|---|---|---|---|
| 4K HEVC 10bit HLG | sw | 1.52 s | 296 | 15.5 s | 10.7 MB | — |
| | vt_enc | 1.59 s | 283 | 14.2 s | 5.4 MB | 0.9935 |
| | vt_full | 2.29 s | 197 | **1.1 s** | 3.4 MB | 0.8558 |
| 4K HEVC 10bit PQ | sw | 1.44 s | 312 | 15.0 s | 10.4 MB | — |
| | vt_enc | 1.54 s | 292 | 14.1 s | 5.1 MB | 0.9956 |
| | vt_full | 2.09 s | 215 | **0.6 s** | 4.4 MB | 0.7380 |
| 1080p H.264 SDR | sw | 1.34 s | 336 | 12.5 s | 16.4 MB | — |
| | vt_enc | 1.25 s | 360 | 10.5 s | 27.0 MB | 0.9655 |
| | vt_full | 2.26 s | 199 | **0.5 s** | 27.9 MB | 0.9594 |

### 结论

1. **单个视频的耗时差别不大**：M4 Pro 的 12 个 CPU 核用 libx264 `ultrafast` 转 720p 已经很快。
2. **真正的好处是省 CPU**：全 GPU 方案的 CPU 时间降到软件版的 **3%–7%**（15 秒 → 0.5–1.1 秒）。批量导入视频时，CPU 可以留给缩略图生成和机器学习，多个视频也能并行转。
3. **只把编码换成 VideoToolbox（vt_enc）几乎不省 CPU**：瓶颈在 CPU 解码 4K HEVC 和 `tonemapx`，不在编码。
4. **GPU 色调映射结果不一致**：`tonemap_videotoolbox` 用默认的 `tonemap_mode=itp` 时，PQ 画面明显偏亮（平均亮度 178.5，软件版 128.7）。换成 `max` 或 `rgb` 模式后接近很多：

   | 素材 | 模式 | 平均亮度（sw 为 128.7 / 124.9） | SSIM |
   |---|---|---|---|
   | PQ | itp（默认） | 178.5 | 0.7380 |
   | PQ | max | 124.7 | 0.9004 |
   | PQ | rgb | 127.1 | 0.8912 |
   | HLG | max | 120.2 | 0.9178 |
   | HLG | rgb | 121.2 | 0.9227 |

   但仍达不到 0.99。合成素材不能代表真实 HDR 画面，需要在 M2 里用真实的 iPhone/Pixel HDR 视频再做主观对比。
5. 码率控制：VideoToolbox 没有 CRF，`-q:v 60` 在 SDR 上的输出比 libx264 CRF 23 大 65%，M2 需要校准 `-q:v` 的取值。

### 使用注意

- `scale_vt` 不支持 `-2` 这种自动等比写法，宽高必须显式算好（偶数）。
- `tonemap_videotoolbox` 要求输入带 HDR 传输特性元数据；读到 `unknown` 时报 `Function not implemented`。
- 合成 HDR 素材时，libx265 必须在 `-x265-params` 里写 `transfer=...`，只设容器层的 `-color_trc` 不会写进码流。

## M2 建议方案

### HDR 混合方案（已实测）

硬件解码 + `scale_vt` 缩到 720p（保持 10 位 `p010`）→ `hwdownload` 回 CPU → `tonemapx`（和 Immich 现在的色调映射完全一样）→ 硬件编码：

```
-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld
-vf scale_vt=w=1280:h=720:format=p010,hwdownload,format=p010le,tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p
-c:v h264_videotoolbox -q:v 60
```

| 素材 | 耗时 | CPU 时间（sw） | 平均亮度（sw） | 与 sw 的 SSIM |
|---|---|---|---|---|
| 4K PQ | 2.31 s | **4.05 s**（15.0 s） | 128.5（128.7） | **0.9736** |
| 4K HLG | 2.32 s | **4.01 s**（15.5 s） | 124.8（124.9） | **0.9752** |

亮度与现有软件结果几乎一致，SSIM 的剩余差异主要来自编码器不同；CPU 时间约为软件版的 1/4。

### 结论

- **SDR 视频**：硬件解码 + `scale_vt` + 硬件编码（SSIM 0.96，CPU 时间约为软件版的 4%）。
- **HDR 视频**：用上面的混合方案，**作为 VideoToolbox 的默认 HDR 路径**。
- `tonemap_videotoolbox`（全 GPU）：等真实素材主观对比通过后，再作为可选项开放。
