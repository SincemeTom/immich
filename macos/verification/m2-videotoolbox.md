# M2 视频转码用 VideoToolbox（Apple 媒体引擎）

- 日期：2026-10-30
- 分支：`mac/feat/videotoolbox`
- 结论：**通过**。服务端新增硬件加速选项 `videotoolbox`，网页设置里可选，原生安装默认打开。端到端 17/17：14 个视频（真实 iPhone HDR、实况照片、2.7K 无人机视频，以及 10 种衍生格式）全部转码成功，画面方向、帧数、亮度都和软件转码一致。转同一批视频，CPU 用量从 297 CPU 秒降到 51 CPU 秒（降 83%）。代价是长时间、高码率的 H.264 视频单个转得慢（6 分钟的无人机视频从 26 秒变成 51 秒）

## 改了什么

官方代码（相对 `v3.3.5`）：

| 文件 | 改动 |
|---|---|
| `server/src/enum.ts`、`constants.ts` | 新增 `TranscodeHardwareAcceleration.VideoToolbox`，支持 H.264、HEVC 两种目标编码 |
| `server/src/utils/media.ts` | 新增 `VideoToolboxSwDecodeConfig`（CPU 解码和滤镜，硬件编码）和 `VideoToolboxHwDecodeConfig`（硬件解码、缩放，硬件编码） |
| `open-api/…`、`packages/sdk/…` | 接口枚举多一个值，由 `sync-open-api` 和 `oazapfts` 生成，和手改结果逐字一致 |
| `web/…/FFmpegSettings.svelte`、`i18n/{en,zh_Hans,zh_Hant}.json` | 设置 → 视频转码 → 硬件加速里多一个"VideoToolbox（仅适用于 macOS）" |
| `server/src/services/{media,transcoding}.service.spec.ts` | 新增 16 个单元测试 |

原生部署（`macos/`）：

| 文件 | 改动 |
|---|---|
| `immichctl video-accel [videotoolbox\|disabled]` | 查看或切换；切到 `videotoolbox` 时，如果网页里没改过"同时转码数"，就设为 2；然后重启服务端 |
| `install.sh` | 新照片库，或第一次升级到这个版本的旧照片库，自动执行 `video-accel videotoolbox`。之后不再改：Immich 只保存和默认值不同的设置，安装脚本分不清"用户在网页里选了关闭"和"从没设置过" |

## 生成的 ffmpeg 命令

以 iPhone 竖拍的 HLG HDR 视频为例（Immich 默认：H.264、720p、CRF 23、hable 色调映射）：

```
-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -noautorotate
-vf scale_vt=w=1280:h=720:format=p010,hwdownload,format=p010le,tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p
-c:v h264_videotoolbox -q:v 54 -g 256
```

| 源视频 | 滤镜 |
|---|---|
| SDR 8 位，需要缩小 | `scale_vt=w=…:h=…` |
| SDR 10 位 | `scale_vt=[w=…:h=…:]format=nv12` |
| HDR（HLG、PQ） | `scale_vt=[w=…:h=…:]format=p010,hwdownload,format=p010le,tonemapx=…`（解码、缩放在 GPU 上，色调映射回到 CPU） |
| 关闭"硬件解码"时 | 与软件转码完全相同的 CPU 滤镜，只换编码器 |

要点：

- **`scale_vt` 不认 `-2`**，宽高必须算成准确的偶数。用 `-noautorotate` 保留存储方向，按存储尺寸缩放，输出保留旋转标记（和其它硬件加速的做法一致）。
- **画质参数**：VideoToolbox 没有 CRF，用 `-q:v`（1–100，越大越好），取 `100 − 2 × CRF`（见下文校准）。设置了最大码率时加 `-maxrate` 和 `-bufsize`（2 倍）。
- **固定关键帧间隔**（网页实时转码的 HLS 分段需要）：VideoToolbox 没有对应选项，用 `-force_key_frames expr:gte(n,n_forced*GOP)`。
- **失败回退**沿用 Immich 原有逻辑：硬件解码失败 → 软件解码 + 硬件编码 → 完全软件。

## 画质校准：CRF 与 `-q:v` 的对应

同一段真实视频先按软件路径做成无损 720p 参考，再用不同参数编码，比较 XPSNR（Y 通道，越高越好）：

| 视频 A（iPhone HLG 竖拍） | 码率 | XPSNR | | 视频 B（iPhone HLG） | 码率 | XPSNR |
|---|---|---|---|---|---|---|
| libx264 CRF 18 | 9984k | 28.84 | | libx264 CRF 18 | 10059k | 32.24 |
| `-q:v 65` | 8105k | 28.99 | | `-q:v 62`（≈64） | 5039k | 31.70 |
| libx264 CRF 23 | 5618k | 27.95 | | libx264 CRF 23 | 5358k | 30.91 |
| `-q:v 55`（≈54） | 5030k | 28.30 | | `-q:v 57`（≈54） | 3942k | 31.13 |
| libx264 CRF 28 | 2971k | 26.81 | | libx264 CRF 28 | 2363k | 29.20 |
| `-q:v 40`（≈44） | 2215k | 26.64 | | `-q:v 47`（≈44） | 2018k | 29.29 |

`hevc_videotoolbox` 和 libx265 的对应关系相同（视频 A：x265 CRF 23 为 27.49，`-q:v 52` 为 27.35，`-q:v 57` 为 27.77）。所以取 `100 − 2 × CRF`：CRF 23 → 54。同样画质下，VideoToolbox 的文件通常还更小（下面的端到端测试中小 20%–45%）。

另外测了码率上限：`-q:v 54 -maxrate 2000k -bufsize 4000k` 平均 1332k、任意 1 秒最高 1500k，能守住上限。

## HDR 色调映射：为什么回到 CPU

M0 用合成素材发现 `tonemap_videotoolbox`（在 Metal 上做色调映射）和 Immich 的 CPU 版 `tonemapx` 结果不一致。这次用 3 段真实 iPhone HLG 视频，以 Immich 现在的软件结果为参考（平均亮度 0–255）：

| 视频 | 参考亮度 | 混合方案（GPU 缩放 + CPU `tonemapx`） | GPU `lum` | GPU `max` | GPU `rgb` | GPU `itp` |
|---|---|---|---|---|---|---|
| IMG_5560 | 87.3 | **87.5** | 100.9 | 97.7 | 100.3 | 101.4 |
| IMG_5585 | 110.4 | **110.7** | 126.4 | 121.6 | 125.9 | 127.0 |
| IMG_5576 | 94.6 | **94.8** | 112.4 | 106.3 | 110.9 | 113.3 |

全 GPU 的 4 种模式都比参考亮 10%–19%，看起来发白。视频的缩略图也是用 CPU `tonemapx` 生成的，如果转码用 GPU 做，同一个视频的缩略图和播放画面亮度会不一样。混合方案与参考相差不到 0.3，所以 HDR 走混合方案。代价是 HDR 的 CPU 用量比全 GPU 高（10 秒片段 1.7 CPU 秒，全 GPU 0.2 CPU 秒），但仍只有软件路径的 1/5。

## 硬件能解码什么（M4 Pro）

| 源格式 | VideoToolbox 解码 |
|---|---|
| H.264 8 位、**10 位**、**4:4:4** | 支持 |
| HEVC 8 位、10 位（HLG、PQ） | 支持 |
| VP9、AV1、ProRes 422 HQ | 支持 |
| MPEG-4 Part 2（老相机 AVI） | 支持 |
| MJPEG | 不支持，服务端自动回退到软件解码 + 硬件编码 |

## 速度与 CPU

### 单个视频的瓶颈：H.264 硬件解码

无人机视频（2720×1530 H.264，25 帧/秒，37 Mbps）的前 60 秒（1500 帧）：

| 方式 | 耗时 | 帧率 | CPU 秒 |
|---|---|---|---|
| 只解码，CPU | 2.69 s | 558 | 29.2 |
| 只解码，VideoToolbox | 9.79 s | **153** | 3.0 |
| 软件路径（libx264 ultrafast） | 3.64 s | 412 | 40.1 |
| VideoToolbox 全硬件 | 8.11 s | 185 | **1.9** |
| CPU 解码 + 缩放，VideoToolbox 编码 | 3.37 s | 445 | 34.5 |

瓶颈是媒体引擎解码高码率 H.264 本身，编码参数（`-prio_speed`、码率模式、改用 HEVC）都不影响速度。"CPU 解码 + 硬件编码"虽然快，却几乎不省 CPU，失去了用硬件的意义。iPhone 的 HEVC 视频则没有这个问题，全硬件和软件一样快甚至更快。

### 媒体引擎可以并行

同一段 60 秒无人机视频同时转多份：

| 同时转 | VideoToolbox 总帧率 | 软件总帧率 |
|---|---|---|
| 1 | 190 | 397 |
| 2 | **384** | 412 |
| 3 | 432 | 403 |

软件路径一份就把 CPU 跑满，再多并发也没用；媒体引擎同时转 2 份时吞吐翻倍，和整颗 CPU 的速度相当。所以启用 VideoToolbox 时把"同时转码数"设为 2。

## 端到端（`macos/scripts/m2_videotoolbox.py`）

在隔离的测试实例上（`local.immich-m2`，端口 2285/3005/5435/6382），素材由 `macos/scripts/m2-samples.sh` 生成：从照片库取 4 个真实视频，再从中衍生出 10 种格式。关闭机器学习，同一批视频先按 Immich 默认（软件、一次 1 个）转一遍，再按原生安装的默认（VideoToolbox、一次 2 个）转一遍，然后通过 API 下载两份结果逐个对比。

| 轮次 | 耗时 | Mac 整机 CPU 平均占用（开始前空闲时 13%） | 高出空闲的 CPU 秒 |
|---|---|---|---|
| 软件，一次 1 个 | 34 s | 93% | 297 |
| VideoToolbox，一次 2 个 | 59 s | 21% | **51** |

| 视频 | 源 | 输出（显示尺寸） | 亮度（软件） | 与软件的 SSIM | 大小（软件） | 耗时（软件） | 走的路径 |
|---|---|---|---|---|---|---|---|
| real-iphone-hlg-long.mov | HEVC 10 位 HLG，竖拍 31 秒 | 720×1280 | 88.3（88.1） | 0.950 | 32.6 MB（46.1） | 4 s（2） | 全硬件 |
| real-iphone-hlg.mov | 同上，4 秒 | 720×1280 | 97.3（97.2） | 0.958 | 3.6 MB（5.4） | 1 s（0） | 全硬件 |
| real-iphone-live.mov | 实况照片的动态部分 | 720×1280 | 94.6（94.4） | 0.953 | 1.0 MB（1.8） | 0 s（0） | 全硬件 |
| real-drone-2.7k.mp4 | H.264 2.7K，6 分 7 秒，1.7 GB | 1280×720 | 144.7（144.7） | 0.963 | 173.5 MB（264.1） | **51 s（26）** | 全硬件 |
| derived-hdr10-4k.mp4 | HEVC 10 位 PQ 4K | 1280×720 | 154.0（153.8） | 0.937 | 5.9 MB（7.3） | 1 s（1） | 全硬件 |
| derived-h264-4k60-rotated.mp4 | H.264 4K 60 帧，旋转 90° | 720×1280 | 149.0（149.0） | 0.957 | 3.6 MB（6.3） | 1 s（1） | 全硬件 |
| derived-h264-10bit.mp4 | H.264 High 10 | 1280×720 | 149.4（148.8） | 0.962 | 3.1 MB（4.6） | 1 s（0） | 全硬件 |
| derived-odd-444.mp4 | H.264 4:4:4，1279×719 | 1280×720 | 148.8（148.8） | 0.964 | 2.9 MB（4.5） | 1 s（0） | 全硬件 |
| derived-hevc-sdr.mp4 | HEVC 8 位 | 1280×720 | 148.7（148.7） | 0.962 | 3.0 MB（4.4） | 1 s（0） | 全硬件 |
| derived-vp9.webm | VP9 | 1280×720 | 148.8（148.8） | 0.962 | 3.2 MB（4.7） | 1 s（0） | 全硬件 |
| derived-av1.mp4 | AV1 | 1280×720 | 148.9（148.9） | 0.962 | 3.0 MB（4.5） | 1 s（1） | 全硬件 |
| derived-prores.mov | ProRes 422 HQ | 1280×720 | 148.2（148.7） | 0.960 | 3.3 MB（4.7） | 1 s（1） | 全硬件 |
| derived-mpeg4.avi | MPEG-4 Part 2 | 640×480 | 148.4（148.8） | 0.950 | 1.4 MB（2.0） | 0 s（0） | 全硬件 |
| derived-mjpeg.avi | MJPEG 4:2:2 | 640×480 | 154.5（154.6） | 0.945 | 2.0 MB（2.3） | 0 s（0） | 硬件解码失败 → 软件解码 + 硬件编码 |

- 检查项：用 VideoToolbox 开始；没有退回完全软件；只有 MJPEG 回退到软件解码；输出 H.264；显示尺寸和软件版一致；帧数相差不超过 1；亮度相差不超过 2；SSIM 不低于 0.9。全部通过。
- SSIM 0.94–0.96 是两种不同编码器各自有损压缩之间的差别，不是画面错误；画质的对比看上面的 XPSNR 校准。
- 耗时是日志里的秒级时间，并发时互相有影响，只看量级。第二轮总耗时由无人机视频决定（它一个就占 51 秒，其余视频在另一路里并行转完）。

## 单元测试

服务端 2344 个测试全部通过（新增 16 个），`tsc`、eslint、prettier 通过。故意把画质换算改错 1，有 4 个新测试失败，说明测试确实在检查。网页端 svelte-check 和 prettier 通过；网页 eslint 在这台机器上对任何 `.svelte` 文件都崩溃（`tscompat` 插件读不到 `Class`），未修改的文件也一样，与本次改动无关。

## 取舍与默认值

| | 软件（Immich 默认） | VideoToolbox（原生安装默认） |
|---|---|---|
| CPU 用量 | 转码时 CPU 跑满 | 约为软件的 1/6；SDR 视频接近 0 |
| 单个 iPhone 视频 | 快 | 一样快 |
| 单个长的高码率 H.264（无人机、相机） | 快 | 约慢 1 倍 |
| 成批视频的总吞吐 | CPU 上限 | 一次 2 个时与软件相当 |
| 同等画质的文件大小 | — | 小 20%–45% |
| 转码期间缩略图、人脸、搜索索引 | 和转码抢 CPU | 基本不受影响 |

原生部署的目的就是把 M4 的硬件用起来，把 CPU 留给机器学习和缩略图，所以默认用 VideoToolbox。主要拍长时间相机或无人机视频、又希望单个视频尽快转完的用户，可以在网页里改回"已禁用"，或运行 `immichctl video-accel disabled`。

## 后续

- 实时转码（网页播放时按需转码）用的是同一套命令，单元测试覆盖了，但没有在浏览器里实际播放验证。
- HDR 的色调映射如果以后要全放到 GPU 上，需要先让 `tonemap_videotoolbox` 的结果和 `tonemapx` 一致（亮度差在 1% 以内），并且视频缩略图也改用同一个滤镜。
