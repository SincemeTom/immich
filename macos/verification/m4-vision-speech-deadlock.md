# M4 问题：内容分析并发调高后 `immich-vision` 卡死，10 个任务一直"正在运行"

- 版本：`3.3.5-mac.5`，正式服 Mac mini（Apple M4，10 核，16 GB，macOS 26.6.2）
- 日期：2026-11-02 发现，2026-11-03 在打包机（M4 Pro，12 核，macOS 27.2）复现并修复
- 状态：**已修复**（`immich-vision` 4，服务端 `VisionRepository`），v3.3.5-mac.6
- 结论：并发转写的视频数一到 CPU 核心数，`immich-vision` 就整个卡死，不是内存不足，也不是服务崩溃。提取视频声音时调用的是阻塞的 `AVAssetReaderTrackOutput.copyNextSampleBuffer()`，它占着 Swift 并发的工作线程等数据，而这个线程池每个核心只有一个线程。服务端每个转写请求的超时固定 30 分钟，所以网页上 10 个任务挂了半小时；超时时又把 helper 和其他请求一起停掉，10 个同时失败。

## 现象（用户描述）

正式服跑内容分析，看到 ANE 没跑满，先后把内容分析的并发调到 2、5、10，之后"管理 → 任务"里内容分析一直显示 10 个正在运行，不再往下走。半小时后 10 个任务自己清零，点"全部"后又正常运行。

## 时间线（正式服诊断包 `immich-diag-20261102-231429`）

| 时间 | 事件 | 来源 |
|---|---|---|
| 22:32:54 | 升级到 mac.5 后启动，`immich-vision` pid 79032 | `server.log` |
| 22:35:08 – 22:37:57 | 用户保存了 4 次任务设置（并发 2 → 5 → 10，诊断时是 5） | `server.log` 的 `SystemConfigService` |
| 22:36:57 前后 | 并发 10，正好全是视频：10 个转写请求同时在 helper 里提取声音 | `unified.log` 里 10 个 `FAQ Offline Mixer` 实例 |
| **22:37:14.542** | helper 的系统日志在同一毫秒全部停住，之后 30 分钟没有一行。各视频停在不同位置（0.9 s、15 s、42 s……） | `unified.log` |
| 23:06:57 | `婚纱照/结婚视频.mp4` 的请求到 1800 s 超时，服务端停掉 helper，其余 9 个随之报 `immich-vision stopped (a request timed out)` | `server.log` |
| 23:12:11 | 用户点"全部"，新 helper（pid 82604）以并发 5 正常运行，约每秒 16 个 | `server.log`，Valkey 事件流 |

排除：没有崩溃报告、没有 jetsam；诊断时内存空闲 60%，helper 约 500 MB；server、ml、postgres、valkey 进程号整晚没变。

## 原因

`immich-vision` 用 Swift 并发同时处理收到的请求（`withTaskGroup`，每个请求一个子任务）。子任务跑在 Swift 的协作线程池上，**池里的线程数等于 CPU 核心数**（正式服 10，打包机 12），不会因为线程被阻塞而增加。

语音转写的第一步 `extractAudio` 在子任务里同步循环调用 `copyNextSampleBuffer()`。它会阻塞所在线程，等 AVFoundation 解码出下一段数据（正式服采样：`copyNextSampleBuffer → FigSemaphoreWaitRelative → __psynch_cvwait`）。同时转写的视频一多，协作线程全被这些等待占满；而解码要往下走，还需要在同一个线程池里调度的工作（`loadTracks` 等 async 调用的后续、转写结果的回调），这些工作再也拿不到线程，于是所有请求互相等待，进程卡死。

另外，主线程一直阻塞在 `readLine()` 读 stdin。只要服务端不关 stdin，主线程就不会空出来，需要在主线程回调的系统框架工作也永远不会执行。这次没有证据表明它参与了死锁，但一并改掉。

服务端（`server/src/repositories/vision.repository.ts`）：

- 转写请求的超时固定 30 分钟（`SPEECH_TIMEOUT`），卡死后要等满 30 分钟才发现。
- 一个请求超时就 `stop()` helper，`failPending` 让所有其他请求一起失败。
- 服务端不限制同时发出的转写请求数，并发设多少，helper 就同时转写多少。

## 复现（打包机，12 核）

用正式版的 helper，同时发 N 个转写请求、不关 stdin（和服务端一样），看能返回几个：

| N | 修复前（helper 3） | 修复后（helper 4） |
|---|---|---|
| 1 | 1/1，0.3 s | — |
| 4 | 4/4，4.4 s | — |
| 8 | 8/8，4.9 s | — |
| 10 | 10/10，5.0 s | — |
| 11 | 11/11，5.1 s | — |
| **12** | **0/12，50 s 未返回（卡死）** | 12/12，5.9 s |
| 13 | 0/13，卡死 | — |
| 16 | 0/16，卡死 | — |
| 24 | 0/24，240 s 未返回 | 24/24，15.9 s |
| 48 | — | 48/48，28.1 s |

正好在 N = 核心数时卡死，N = 核心数 − 1 时正常。正式服 10 核，所以并发 10 时卡住、5 时正常。

修复后另测：

- 10 个视频和 20 张照片同时发：照片全部在 0.2 s 返回，没有被排队转写的视频挡住；视频 5.9 s 全部完成。
- 同一段视频（`IMG_5583.mov`）修复前后的转写文字完全一致。

测试工具：`stress.mjs`（node，用 Immich 自带的 node 运行），放在 `~/Documents/immich-scratch/vision-stress/`，不入库。用法：`node stress.mjs HELPER N 超时秒数 视频路径列表文件 [照片路径]`。

> 注：在 hardened runtime 签名的 helper 上 `lldb` 附加不上去；对本地编译的版本附加时 debugserver 卡住，之后系统的 `python3`（xcrun 转发）每次启动都进入 U 状态，`kill -9` 也结束不了，写这份文档时仍未恢复。排查这类问题用 `sample` 和上面的测试工具，不要用 lldb 附加。

## 修复

### `immich-vision`（版本 3 → 4，`macos/vision/immich-vision.swift`）

1. **声音的读取移出协作线程池**：`extractAudio` 先用 async 的 `loadTracks` 找到音轨，再把阻塞的读取循环（`readAudio`）放到专用的 `DispatchQueue`（`immich-vision.audio`，并发队列）上执行，子任务通过 continuation 等待结果，不占协作线程。
2. **同时转写最多 2 个**（`SPEECH_AT_ONCE`）：`Slots` actor 排队，等待时不占线程。每个转写要几百 MB 内存，还要共用 ANE，同时跑更多也不会更快。照片请求不受限制。
3. **stdin 改为异步读取**（`FileHandle.standardInput.bytes.lines`），主线程不再阻塞；任务组改为 `withDiscardingTaskGroup`，完成的请求立即释放（原来的 `withTaskGroup` 会一直保留子任务的结果，直到进程退出）。

### 服务端

1. **服务端也限制同时发出的转写请求为 2 个**（`VisionRepository` 的 `Slots`，与 helper 一致）。其余的在服务端排队，**超时从真正发给 helper 时开始算**，排队时间不算进去。
2. **超时按视频时长算**：`speechTimeout(duration)` = 10 分钟 + 视频时长，最多 2 小时（`content-analysis.service.ts`）。1 分钟的视频 11 分钟超时，不再固定等 30 分钟。为此 `getForContentAnalysis` 多查了 `asset.duration`。
3. **一个请求超时，不再连带其他请求失败**：超时的请求失败，helper 被换掉（`SIGKILL`），它手上的其他请求**重新发给新的 helper 一次**，各自重新计时。已经重发过一次又卡住的才失败，避免某个文件反复把 helper 卡死。helper 意外退出时同样处理。
4. 用户设置的内容分析并发不变；调高并发现在只会让更多照片同时分析，视频转写始终最多 2 个。

## 测试

- 单元测试：
  - `server/src/repositories/vision.repository.spec.ts`（新增，4 项）：用一个假的 helper 脚本模拟"收到某个请求后不再应答"：
    - 超时后换 helper，其余请求在新 helper（不同 pid）上完成；
    - 重发后又卡住的请求失败；
    - 同时最多 2 个转写，超时从发出时算（6 个 50 ms 的转写、每个 120 ms 超时，全部完成）。
  - `content-analysis.service.spec.ts`：转写超时 = 10 分钟 + 时长；`speechTimeout` 上限 2 小时。
  - 共 28/28 通过；`tsc`、`eslint`、`prettier` 通过。
- helper 压力测试：见上面的复现表。
- 待做：mac.6 的端到端测试（m3），以及在正式服上把内容分析并发设为 10，跑一批视频，确认不再卡住。

## 对用户的建议

- 内容分析的并发设 5 左右即可。调高主要加快照片；视频转写固定 2 个一起跑。
- ANE 跑不满是正常的：解码声音、预处理图片都在 CPU 上，这部分才是瓶颈。
