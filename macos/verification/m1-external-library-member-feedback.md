# 反馈：外部库删除、共享卸载后，子成员仍能看到照片

- 日期：2026-10-31
- 分支与运行版本：`mac/develop`，`3.3.5-40b7a4da3`（运行版本与 HEAD 一致）
- 状态：**问题确认，未修复**。本文只记录现象、证据和根因，没有改代码

## 测试场景

| 项目 | 值 |
|---|---|
| 子成员 | XuSiying（`6326ebb5-cedd-4ca0-8b79-cd3a0167b496`），非管理员，00:34 创建 |
| 网络共享 | OdileXsy（`f2b37902…`，群晖 `/volume1/homes/OdileXsy/Photos`，NFS），挂载在 `~/Library/Application Support/Immich/mounts/OdileXsy` |
| 外部库 | `05dde471-3b32-4137-ab8c-91e82363dbb0`，属于 XuSiying，导入路径 `…/mounts/OdileXsy`，00:42:14 创建，扫描入库 22460 个资产 |
| 存储位置 | 缩略图、预览图、转码视频放在**另一个共享** TestCache（`mounts/TestCache/TestImmich/…`） |

操作：挂载共享，建外部库，子成员能正常浏览（通过）→ 02:10:16 删除外部库 → 之后在网络共享页卸载 OdileXsy → 子成员**仍能浏览这个库的照片**。

## 问题 1：删除外部库后照片还在

### 现象

库已经标记为删除，但它的资产一个都没有处理：

| 项目 | 值 |
|---|---|
| `library.deletedAt` | 2026-10-31 02:10:16 |
| 资产总数 | 22460 |
| `status = active` | 22460 |
| `deletedAt` 不为空 | 0 |
| `isOffline` | 0 |

到 02:44 复查时数字没变，日志里也没有这个库的 `Deleting library`（之前删除的库 `3fb85e23` 在 22:33:08 有这一行，删得很正常）。

### 证据：删库任务在队列暂停期间消失了

外部库删除分两步（`server/src/services/library.service.ts`）：

1. `delete()`（L368）：先软删除库，只写 `library.deletedAt`，**不碰资产**；然后把 `LibraryDelete` 任务放进 `library` 队列。
2. `handleDeleteLibrary()`（L380）：等任务执行时，才把资产的 `deletedAt` 设成当前时间，并逐个安排 `AssetDelete`。

所以资产会不会消失，完全取决于第 2 步的任务有没有执行。Valkey 里 `immich_bull:library:events` 的记录（已换算成本地时间）：

| 时间 | 事件 |
|---|---|
| 02:08:02 | `library` 队列 **paused** |
| 02:10:16 | 任务 22650（`LibraryDelete`，`{"id":"05dde471…"}`）added → waiting |
| 02:12:52 | `library` 队列 **resumed** |
| 之后 | 只有任务 11062 完成，随后 drained。**任务 22650 再也没有 active / completed / failed** |

现在任务 22650 的键 `immich_bull:library:22650` 已经不存在，也不在 `wait`、`paused`、`active`、`prioritized`、`delayed`、`completed`、`failed` 任何一个集合里。默认任务选项是 `removeOnFail: false`（`config.repository.ts` L290），如果它失败过，应该会留在 `failed` 里。所以它不是执行失败，而是**没执行就被移除了**。

这段时间只有 `library` 队列有 paused / resumed 事件。存储位置自动暂停的状态是 `pausedQueues: []`，日志里也没有 `Storage location … cannot be used … Paused`。所以暂停不是存储位置功能触发的，**最可能是在网页「管理 → 任务」里手动暂停了外部库队列，并点了「清除」**。「清除」调用的是 `queue.drain()`（`job.repository.ts` L175），会删掉所有等待中的任务，删库任务也在其中。

> 需要确认：02:08–02:12 之间是否在「任务」页暂停并清除过「外部库」队列。默认日志级别 `log` 不记录这些操作，所以日志里查不到。

附带发现：02:06 服务端重启过一次，`library` 队列留下 7 个 `LibraryAssetChecksum` 失败任务，原因是 `job stalled more than allowable limit`。`postgres.log` 在 02:06:27 也有连接中断的记录，和这次重启对应。

### 根因

- **删除的效果全靠一个异步任务**。库只是软删除，资产要等 `LibraryDelete` 执行才会进回收站。只要任务被清除、丢失或者一直排不上，子成员就会一直看到这些照片。
- **任务丢了只能等到半夜才补**。补偿靠 `LibraryDeleteCheck`（`handleQueueCleanup`，L224），它会重新安排所有待删除的库，但只在每天 0 点的定时扫描或手动「扫描全部外部库」时才执行，服务启动时不检查。
- **访问权限不看库的状态**。`access.repository.ts` 完全没有 library 相关的条件，资产能不能看只看资产本身和它的所有者。库删了，但资产没动，就照样能看。

## 问题 2：卸载共享后照片还能浏览

### 现象

| 项目 | 状态 |
|---|---|
| 共享 OdileXsy | `enabled: false`，不在系统挂载列表里；`mounts/OdileXsy` 是空目录 |
| 原图 | **打不开**：日志在 02:20:50、02:24:04、02:24:32 有 `ERROR [Api:LoggingRepository] Unknown error: ENOENT … mounts/OdileXsy/….MOV`，接口返回 500 |
| 缩略图 / 预览图 / 转码视频 | **都还在**：10149 张缩略图、10149 张预览图、421 个转码视频，放在仍然挂着的 TestCache 共享上，抽查都存在 |
| 资产 `isOffline` | 全部为 `false` |

所以子成员看到的时间线、点开后的大图和视频播放，用的都是 TestCache 上的派生文件，跟 OdileXsy 挂没挂载无关。只有「下载原图」「查看原图」会报错。

### 根因

- **卸载共享不会通知外部库**。`network-share.service.ts` 的 `unmountShare()`（L290）只是写 `enabled: false` 并执行 `umount`，没有标记离线，也没有触发扫描。`update()` 改连接参数时也一样。只有 `delete()`（L302）会检查有没有外部库在用这个共享，有就拒绝删除。
- **扫描时找不到导入路径，只会跳过**。`handleQueueSyncFiles`（L784 起）发现没有可用的导入路径时，只打印 `No valid import paths found` 并返回 `Skipped`，不会把这个库的资产标记为离线。而且这个库已经软删除了，之后也不会再被扫描（02:18:35 那次扫描只处理了管理员的库 `a42437ae`）。
- **派生文件和原图不在同一个地方**。存储位置把缩略图、预览图和转码视频放在别的共享上，原图所在的共享卸载了，浏览体验也几乎不受影响。
- **原图丢失时返回 500，而不是 404**。`ENOENT` 被当成未知错误抛出去，网页只会显示加载失败，看不出是共享没挂载。

## 修复建议

按优先级：

1. **删库时立即隐藏资产，不依赖队列**。在 `delete()` 里同步执行 `updateByLibraryId(id, { deletedAt: now })`，或者至少把资产标记为离线、不可见；后台任务只负责真正删除记录和清理派生文件。这样任务丢了，也只是清理晚一点，子成员不会再看到照片。
2. **启动时补偿待删除的库**。服务启动（或 `library` 队列恢复）时就执行一次 `LibraryDeleteCheck`，不要只等每天 0 点。
3. **清除队列时保留删库任务**。「清除」只应该清掉可以重来的任务（扫描、校验和）；`LibraryDelete` 这类会改变数据状态的任务应该保留，或者清除后自动重新安排。至少在网页上加一句提示。
4. **卸载或停用共享时，把相关外部库的资产标记为离线**。`unmountShare()`、`update()`（`enabled: false` 或重新连接失败时）找出导入路径在这个共享下的库，把资产设为 `isOffline = true`；重新挂载后再扫描一次恢复上线。这样也和「群晖断开时照片进回收站但不删除」的现有逻辑（M1-6）一致。
5. **`handleQueueSyncFiles` 找不到导入路径时，区分「共享没挂载」和「路径确实删了」**。共享没挂载时把资产标记为离线；路径确实删了再按原逻辑处理。
6. **原图不存在时返回 404**，并在日志里写清楚是哪个共享没挂载。

建议补的端到端测试：

- 删除外部库后，子成员和管理员立即看不到这些资产（不等后台任务）。
- 暂停 `library` 队列 → 删库 → 清除队列 → 恢复：资产仍然不可见，重启服务后库被清理掉。
- 卸载共享后，该共享上外部库的资产全部离线，子成员看不到；重新挂载后恢复。
- 缩略图放在另一个共享时，卸载原图共享后同样不可见。
- 原图共享未挂载时，下载原图返回 404。

## 当前状态与临时处理

- 库 `05dde471…` 仍是「已软删除、资产全在」的状态。**今晚 0 点的 `LibraryDeleteCheck` 会重新安排删除**，之后资产会进回收站，再按回收站规则清理（`deleteOnDisk: false`，不会删群晖上的原图）。
- 想马上处理：在网页「管理 → 任务」里确认「外部库」队列没有暂停，然后对「外部库」点一次「全部」（扫描全部外部库）。`handleQueueScanAll` 会先安排一次 `LibraryDeleteCheck`（`library.service.ts` L587），把这个库的删除重新放进队列。**这次不要再点「清除」。**
- 卸载 OdileXsy 后，这个库的派生文件（TestCache 上约 2 万个缩略图、预览图和 421 个转码视频）会在库被真正删除后一起清理。
