# M4 问题：模型预热期间设置人物封面，网页一直不变、再点报错，过一会儿才发现其实已经设置成功

- 版本：`3.3.5-mac.5`（`releases/3.3.5-mac.5`），这台 MacBook Pro（M4 Pro，macOS 26.7）的本机测试环境
- 日期：2026-11-02
- 状态：**待修复**
- 结论：用户是在刚装完 `.pkg`、后台还在准备模型的那一分多钟里操作的。这段时间 server 只开 API、不跑任务（M4 为 600 秒超时加的设计，见 [m4-pkg-postinstall-timeout.md](m4-pkg-postinstall-timeout.md)），所以：
  1. 第一次设置封面**其实成功了**：数据库立刻改了，生成封面的任务也排上了队，只是要等预热结束才会执行。网页拿到的还是旧图。
  2. 预热结束时 server 要重启一次才能带上任务处理。任务在新 server 起来后约 1 秒完成，并发出"封面已更新"的 WebSocket 通知；但浏览器的连接这时还在重连，**通知丢了**，网页不会自己刷新。
  3. 第二次点击正好落在 server 重启的那几秒里，请求没到 server，所以报错。（这条是推断，见下文）
  4. 之后刷新或重新进入页面，人物的 `updatedAt` 已经变了，新封面才显示出来。

## 现象（用户描述）

在人物页面选了一张照片设为封面，等了很久封面没变；又设置了一次，提示失败；过一会儿再看，封面其实已经换好了。

## 时间线

来源：`~/Library/Logs/Immich/install.log`、`warm.log`、`server.log`、`ml-warm.log`，Valkey 里 `immich_bull:thumbnailGeneration:events` 事件流，数据库 `person` 表。

| 时间 | 事件 | 来源 |
|---|---|---|
| 22:28:39 | 安装 `3.3.5-mac.5`，开始启动服务 | `install.log` |
| 22:29:42 | server（pid 23007）以**只开 API** 的方式启动：`IMMICH_WORKERS_EXCLUDE=microservices` | `server.log`；`run-service` 第 141–143 行 |
| 22:29:43 | 后台开始预热模型 | `install.log`、`warm.log` |
| 22:30:12 | `WARN [Api:JobRepository] No microservices worker is connected. Background jobs will not be processed until one is running.` 浏览器的 WebSocket 连上 | `server.log` |
| **22:30:35.317** | **第一次设置封面：任务 12475 `PersonGenerateThumbnail` 入队**。说明 `PUT /api/people/:id` 已经成功（`PersonService.update` 先改数据库，再入队） | 事件流 `added` |
| 22:30:41 | 浏览器的 WebSocket 断开又连上（`bZzq…` → `ldcz…`），连的仍是 23007 | `server.log` |
| 22:30:52 | 模型全部加载完，预热进入收尾 | `ml-warm.log` |
| 约 22:30:52 – 22:31:00 | `warm_end` 停掉 23007、再启动完整的 server：**这几秒内 2283 端口没有进程在听** | `immichctl` 第 358–367 行；23007 最后一行日志 22:30:41，新进程 22:31:00 才开始监听 |
| 22:31:00 | 新的 server 起来：API（pid 27120）开始监听，任务进程（pid 27097）启动 | `server.log` |
| **22:31:00.707** | 任务 12475 开始执行（在队列里等了 25.4 秒） | 事件流 `active` |
| 22:31:01.001 | 新封面写入数据库：`person.updatedAt = 22:31:01.001`，缩略图文件修改时间 22:31:01 | `person` 表；`thumbs/…/9530dbb1-….jpeg` |
| **22:31:01.009** | 任务完成，`JobService` 发出 `on_person_thumbnail` | 事件流 `completed`；`job.service.ts` 第 126–129 行 |
| 22:31:01 | 浏览器的 WebSocket 连上新 API（`SpfK…`）——**和通知几乎同时，大概率在通知之后才加入用户的房间** | `server.log`（只精确到秒） |
| 22:31:02 | 又断开，再连上（`R7bU…`） | `server.log` |
| 22:31:01 | 预热结束 | `warm.log` |

整晚只有这一个 `PersonGenerateThumbnail` 任务（12475），**第二次点击没有产生任务**，也就是第二个请求没有成功执行到 `PersonService.update` 的入队那一步。

## 原因分析

### 1. 第一次点了没反应：任务在等预热结束

- `PersonService.update`（`server/src/services/person.service.ts` 第 273–289 行）先更新 `person.faceAssetId`，再把 `PersonGenerateThumbnail` 排进 `ThumbnailGeneration` 队列，然后马上返回新的 person。
- 网页（`web/src/routes/(user)/people/[personId]/…/+page.svelte` 第 161 行）把返回值赋给 `person`，封面地址 `thumbnailData` 是由 `person.updatedAt` 派生的（第 75 行），所以地址变了、浏览器重新请求了一次封面。
- 但这时文件还没重新生成，`GET /people/:id/thumbnail` 返回的仍是**旧图**。之后这个 `<img>` 的地址不再变化，旧图会一直显示，直到收到 `on_person_thumbnail` 通知（第 111–115 行），或者页面重新加载。
- 预热期间没有任务进程，任务只能等。这是 M4 有意的设计（`run-service` 第 135–138 行），README 里写的也是"预热期间服务器只开 API，网页和 App 可用，任务排队"。**但网页上没有任何提示**，用户只会看到"点了没用"。

这次等了 25 秒，是因为预热只剩最后几十秒。首次安装或换模型时预热要 8 分钟以上（[m4-pkg-postinstall-timeout.md](m4-pkg-postinstall-timeout.md)），那段时间里设置封面、合并人物、上传照片都会出现"成功了但看不到结果"。

（`ThumbnailGeneration` 队列积压的问题已经由 `job.repository.ts` 第 268–271 行的 `lifo: true` 处理了：这次队列是空的，等待完全来自预热。）

### 2. 任务完成了网页也不更新：通知在 server 重启时丢了

- 任务完成时，任务进程通过 Valkey 适配器把 `on_person_thumbnail` 发给该用户的所有 WebSocket 连接。
- 预热结束时 `warm_end` 会停掉旧 server、启动新 server（`immichctl` 第 364–366 行）。浏览器的旧连接随旧进程断开，socket.io 自动重连，连上新 API 后还要做一次登录校验才加入用户的房间。
- 任务在新进程起来后 **0.3 秒**就开始执行，**1 秒内**就完成并发出了通知；浏览器的新连接也是 22:31:01 才建立。日志只精确到秒，但从顺序看，通知几乎一定是在连接加入房间之前发出的，socket.io 不会补发错过的消息。
- 网页在 WebSocket 重连后（`web/src/lib/stores/websocket.ts` 第 65–68 行的 `WebsocketConnect`）也不会重新拉取人物信息。

所以封面再也不会自己更新，要靠用户刷新。

### 3. 第二次点击报错：多半落在 server 重启的空档里（推断）

- 第二次点击没有产生任务，说明请求没有在任何一个 server 上成功执行。
- 旧 API（23007）在 22:30:52 之后被停掉，新 API（27120）22:31:00 才开始监听。用户"等了很久"后再点，时间正好可能落在这 8 秒左右的空档里：请求连不上，网页显示"无法设置封面"。
- 当前日志级别不记录每个 HTTP 请求，400 这类业务错误 server 也不写日志，所以**无法从日志确认**第二次请求的时间和返回码。如果第二次是在 22:31:00 之后点的，那它应该成功并产生第二个任务，但事件流里没有，这也支持"落在空档里"的推断。
- 下次复现时请记下网页提示的原文，或者打开浏览器开发者工具的"网络"面板看 `PUT /api/people/…` 的状态码（连不上一般是 `Failed to fetch` 或 502/503）。

### 4. 过一会儿看到已经成功

数据库里封面在 22:31:01 就已经更新。刷新页面或重新进入后，`person.updatedAt` 是 22:31:01.001，封面地址变了，浏览器重新请求就拿到了新图。

## 影响范围

不只是人物封面。预热期间（每次安装 `.pkg`、升级、换模型都会有）：

- **会"成功但看不到结果"的操作**：设置人物封面、合并人物后的封面、上传照片后的缩略图、编辑（旋转、裁剪）后的缩略图、重新识别人脸等，凡是靠任务和 WebSocket 通知来更新界面的操作。
- **预热结束的那几秒**：所有 API 请求都会失败，WebSocket 通知可能丢失。
- 正式环境首次安装时预热要 8–12 分钟，碰上的概率比这次高得多。

## 建议修复（供开发参考）

1. **网页提示"模型准备中"**（建议必做）：服务端已经知道自己处于 `warm-up` 模式（`run/server-workers`），可以在 `/api/server/features` 或 `/api/server/about` 里带出来。网页顶部显示一条横幅："正在准备机器学习模型，后台任务（缩略图、人物封面、搜索等）会在完成后自动处理"。设置封面成功的提示也改成"已设置，封面稍后更新"。
2. **WebSocket 重连后补刷新**（建议必做）：
   - 人物页面在 `WebsocketConnect` 时重新拉一次 `getPerson`，如果 `updatedAt` 变了就更新封面地址；人物列表页同理。
   - 或者更通用：任务进程启动后，先等 API 那边的 WebSocket 至少过几秒（或者等客户端重新连上）再开始处理队列；不过这只能缓解，补刷新才是可靠的。
3. **预热结束时尽量不让 API 断开**：
   - 现在是先停旧 server 再起新的，中间有约 8 秒没有任何进程监听 2283。可以先启动一个只跑任务的进程（`IMMICH_WORKERS_INCLUDE=microservices`），再决定是否重启 API；或者让 API 和任务进程分成两个 LaunchAgent，预热结束时只启动任务那一个，API 完全不重启。
   - 第二种做法同时解决了第 2、3 条：API 不重启，浏览器的 WebSocket 不断，通知也就不会丢。
4. **网页在 server 重启时给出明确提示**：网页已经有 `serverRestarting`（`websocket.ts` 第 58、71 行），可以在 `warm_end` 重启前由 server 发出 `AppRestartV1`，让网页显示"服务正在重启"并在恢复后自动刷新，而不是让用户的操作失败。
5. **测试**：在预热期间（`immichctl warm` 运行中）用网页设置人物封面，预热结束后不刷新页面，确认封面在几秒内自动更新；并在 `warm_end` 重启期间连续发 `PUT /api/people/:id`，确认要么成功、要么有明确的提示。

## 复现方法

1. `immichctl warm`（或安装一次 `.pkg`），等 `server.log` 出现 `No microservices worker is connected`。
2. 打开某个人物页面，"选择封面"，选一张照片：提示成功，但封面不变。
3. 等预热结束（`warm.log` 出现 `done`），**不要刷新页面**：封面仍然不变。
4. 刷新页面：新封面出现。
5. 在第 3 步预热快结束时（`ml-warm.log` 出现最后几个 `Preloading`）连续点设置封面，可以复现报错。

查任务的实际执行时间（这次分析用的方法）：

```bash
V="$HOME/Library/Application Support/Immich/current/valkey/bin/valkey-cli"
"$V" -p 6379 --raw XREVRANGE immich_bull:thumbnailGeneration:events + - COUNT 40
```
