# M4 问题：v2 模型的 .pkg 安装显示"安装失败"（postinstall 超过 600 秒被系统终止）

- 安装包：`Immich-3.3.5-dev-a559bb0f5.pkg`（`mac/develop` 的 `a559bb0f5`，含 M4-1 的 v2 模型）
- 机器：MacBook Pro，Apple M4 Pro，macOS 26.7；在已装 `3.3.5-0c376d526` 的实例上用 Installer 图形界面升级
- 日期：2026-11-01
- 状态：**已修复**（分支 `mac/fix/pkg-background-warm`，正式版 `v3.3.5-mac.2`），见文末"修复"
- 结论：Installer 只给 `postinstall` 600 秒。postinstall 同步跑完了整个模型预热，v2 第一次准备要将近 8 分钟，加上前面的步骤超过了 10 分钟，脚本被系统终止，Installer 报"安装失败"。实际上 Immich 已经升级好并在运行，失败的只是收尾步骤

## 现象

Installer 最后弹出："安装器遇到了一个错误，导致安装失败。请联系软件生产企业以获得帮助。"

## 日志

`/var/log/install.log`（只保留本次安装的行，去掉了颜色代码）：

```
11:27:03 package_script_service[48189]: PackageKit: Executing script "postinstall" in /tmp/PKInstallSandbox.iLSib4/Scripts/io.github.sincemetom.immich.3UM2Ip
11:27:04 ./postinstall: immich postinstall: installing 3.3.5-a559bb0f5-standalone for <用户> (/Users/<用户>)
11:27:08 ./postinstall: immich postinstall: model clip/XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k/v2: installed
11:27:08 ./postinstall: immich postinstall: model ocr/PP-OCRv6_medium/v2: installed
11:27:08 ./postinstall: immich postinstall: model facial-recognition/buffalo_l/v2: installed
11:27:09 ./postinstall: ==> Starting Immich
11:27:24 ./postinstall:   postgres: running
11:27:27 ./postinstall:   valkey: running
11:28:21 ./postinstall:   ml: running
11:29:15 ./postinstall:   server: running
11:29:15 ./postinstall: ==> Preparing the machine learning models
11:37:03 package_script_service[48189]: PackageKit: Terminating PKInstallTask(pid:48190). Task has exceeded its 600 seconds of runtime.
11:37:04 installd[1197]: PackageKit: Install Failed: Error Domain=PKInstallErrorDomain Code=112 "运行软件包"Immich-3.3.5-dev-a559bb0f5.pkg"的脚本时出错。" UserInfo={NSFilePath=./postinstall, ...}
11:37:05 Installer[47742]: 'Install Failed' UI displayed message:'安装器遇到了一个错误，导致安装失败。请联系软件生产企业以获得帮助。'.
```

关键是这一行：`Task has exceeded its 600 seconds of runtime`。脚本本身没有出错，是运行超时被终止的。

## 时间线

| 时间 | 步骤 | 用时 |
|---|---|---|
| 11:27:03 – 11:27:09 | 放置模型、配置、注册 LaunchAgent | 6 秒 |
| 11:27:09 – 11:29:15 | 启动四个服务（ml 54 秒，server 54 秒） | 2 分 6 秒 |
| 11:29:15 – 11:32:35 | 预热：智能搜索 文字、图像 | 3 分 20 秒 |
| 11:32:35 – 11:32:50 | 预热：人脸检测、识别 | 15 秒 |
| 11:32:50 – 11:35:46 | 预热：OCR 检测，7 种尺寸 | 2 分 56 秒 |
| 11:35:46 – 11:36:56 之后 | 预热：OCR 识别，12 种尺寸 | 1 分 10 秒以上 |
| **11:37:03** | **到 600 秒，Installer 终止 postinstall** | — |
| 11:37:17 – 11:37:24 | `immichctl warm` 的退出处理重新拉起 ml 和 server，两边都报 healthy | — |

时间来源：`/var/log/install.log`、`~/Library/Logs/Immich/ml-warm.log`、`ml.log`、`server.log`。

预热每准备一个计算图都会比较"CoreML 自选"和"只用 ANE"两种方式（`ml-warm.log` 里的 `Preparing: ...: ALL x ms, Neural Engine alone y ms`），一共 24 个计算图。这是 M4-1 新增的步骤（`immich_ml/sessions/prepare.py`），每个图都要多编译、多测一次。

## 根因

1. **postinstall 同步跑完整个预热。** 调用链是 `postinstall` → `configure.sh` → `immichctl warm`（升级时）或 `immichctl clip-model`（新库，内部也会预热），见 `macos/native/configure.sh` 第 351–357 行。
2. **v2 第一次准备比以前慢得多。** 以前 main 导出的 CoreML 编译约 2 分钟（`m3-pkg.md`）。v2 要把所有计算图重新编译一遍，再比较运行单元：
   - 这次实测 7 分 48 秒以上
   - M4-1 新装测试测到 7 分 53 秒（`m4-ml-ane.md`）
   - 目标机 M4 16 GB 估算要 8–12 分钟

   加上启动服务的约 2 分钟，**无论新装还是升级，都会超过 600 秒**。在目标机上只会更慢，每次都会失败。
3. **测试时没有经过 Installer。** M4-1 测"新装"的方式是"放好模型，直接运行发布目录里的 `configure.sh`"，没有 Installer 的时间限制。`m3-pkg.md` 也记着"图形界面安装……在这台 Mac 上没有真正跑过"。

## 实际状态：升级其实已经完成

被终止时，预热的最后一个计算图刚刚做完，旧导出也已经删了。

| 项目 | 状态 | 依据 |
|---|---|---|
| 运行的版本 | ✅ `3.3.5-a559bb0f5-standalone` | `current` 链接；`immichctl status` 中四个服务都是 ok |
| v2 模型 | ✅ 三个模型都有完成标记，24 个 CoreML 计算图清单都在 | `data/models/*/*/v2/.immich-native-downloaded`、`*/coreml/*/manifest.json` |
| 删除旧导出 | ✅ 已删除，模型目录里只剩 `v2` | 智能搜索 11 GB、人脸 707 MB、OCR v6 2.0 GB，与 `m4-ml-ane.md` 相同 |
| CoreML 系统缓存 | ✅ 已清理，剩 1.0 GB | `~/Library/Caches/python` |
| **删除更早的发布目录** | ❌ 没执行，现在留着 3 个（应该 2 个），多占 1.4 GB | `configure.sh` 第 360–367 行在预热之后，没跑到；`releases/3.3.5-d9e2f6180-standalone` 还在 |
| **postinstall 清理暂存目录** | ❌ 留下了 `/Library/Application Support/Immich/pkg/3.3.5-a559bb0f5-standalone/models/...` 空目录树 | postinstall 的 `trap cleanup EXIT` 没生效 |
| `/usr/local/bin/immichctl` 链接 | ✅ 上一次安装时已经建好，不受影响；**全新安装时这一步不会执行** | postinstall 第 82–87 行在 `configure.sh`（第 80 行）之后 |
| 自动打开网页 | ❌ 没执行。全新安装时用户看不到创建管理员的页面 | postinstall 第 91 行 |
| 安装回执 | ❌ 没更新：`pkgutil --pkg-info io.github.sincemetom.immich` 的 install-time 仍是上一次（2026-10-31 18:51） | — |

**风险最大的是全新安装**：Installer 报失败，网页没打开，`immichctl` 不在 PATH 上，而服务其实已经在跑。用户很可能以为装坏了，把它删掉再装，或者去找 Docker。

## 建议修复（供开发参考）

1. **把预热移出 postinstall**（必须做）。
   - postinstall 调用 `configure.sh --no-warm`，只做配置和启动，保证几十秒内结束。
   - 预热改为在用户会话里后台运行。比如用一次性的 LaunchAgent（`local.immich.warm`，`RunAtLoad`，跑完 `immichctl warm` 后删掉自己），这样关掉 Installer、注销、重启后都还能继续或重来。
   - 新库需要的 `clip-model` 设置也要拆开：设置写入数据库这一步留在 postinstall，预热放到后台。
   - 预热没完成时 server 的请求会等模型准备（这正是 M1-4 加预热的原因：首次请求 300 秒超时），要确认后台预热期间导入的任务不会大量失败。或者让 `immichctl status` 显示"模型准备中"。
2. **安装完成页和网页上说明模型还在后台准备**，以及大概要多久、去哪看进度（`immichctl status` 或 `~/Library/Logs/Immich/ml-warm.log`）。
3. **postinstall 收尾步骤不依赖前面成功**：先建 `immichctl` 链接、打开网页、清理暂存，再做耗时的事；或者让 `configure.sh` 在下次运行时补做发布目录清理。
4. **测试加上真实的 Installer 安装**：`sudo installer -pkg … -target /`，或图形界面，在目标机 M4 16 GB 上跑新装和升级各一次，记录 postinstall 用时，要求远低于 600 秒（比如 120 秒以内）。
5. 可选：比较运行单元的结果（ALL 和只用 ANE 选哪个）只和芯片型号、计算图有关。可以在打包时按芯片算好放进清单，安装时少测一轮。但 CoreML 编译本身仍然要在本机做，第 1 点还是要做。

## 已经装上的机器怎么处理

服务已经正常运行，不用重装。下面是清理没做完的部分（可选）：

```bash
# 更早的发布目录：保留 current 和上一个（0c376d526），删掉 d9e2f6180
rm -rf ~/Library/Application\ Support/Immich/releases/3.3.5-d9e2f6180-standalone
# postinstall 没清掉的暂存目录（里面只有空文件夹）
sudo rm -rf "/Library/Application Support/Immich"
```

以后再用同一个 .pkg 重装不会再超时：模型已经准备好了，再次预热只需几秒。

## 修复

分支 `mac/fix/pkg-background-warm`，已合入 `mac/develop`，正式版 `v3.3.5-mac.2`。

| 位置 | 改动 |
|---|---|
| `postinstall` | 调用 `configure.sh --warm-in-background`，只做配置和启动；之后建 `immichctl` 链接、打开网页，**不再依赖前面成功**（失败时也建链接，按实际结果退出） |
| `configure.sh --warm-in-background` | 启动服务前先登记一次性 LaunchAgent `<label>.warm`（还不启动），服务器因此以"只开 API"方式启动；不启动 ml（预热会接管它的端口，之后由预热启动）；最后启动这个 LaunchAgent。发布目录清理、链接等收尾步骤照常执行 |
| `immichctl warm --background` / `--agent` | LaunchAgent 在用户会话里运行 `immichctl warm`，成功后删除自己；关掉 Installer、注销都不影响；中途重启 Mac 或失败，下次登录重来 |
| 预热期间的服务器 | `run-service` 看到预热标记，以 `IMMICH_WORKERS_EXCLUDE=microservices` 启动服务器：网页、App、上传、建管理员都正常，缩略图、智能搜索、人脸、OCR 等任务**排队等待**（不会因为连不上机器学习服务而失败）；预热完成后重启一次服务器（约半分钟），任务自动开始。`install.sh` 的前台预热也改成这样，升级时网页不再中断。（之后改为：服务器照常完整运行、预热结束不重启，只暂停智能搜索、人脸检测、文字识别队列，见 [m4-person-cover-during-warmup.md](m4-person-cover-during-warmup.md)） |
| `immichctl status` | 预热进行中显示"models: being prepared"，失败显示怎么重试；`immichctl logs warm` 看进度 |
| 安装器完成页 | 说明模型在后台准备、大约多久、期间哪些功能要等 |

测试中顺带发现并修复的三个问题：

1. **预热进行中再次安装**（以为装坏了重装）：第二次 `configure.sh` 报 `Bootstrap failed: 5`，旧预热的收尾还在重启服务。现在先通知旧预热"后面还有一次"（它就不再恢复服务），等它真正退出，再开始新的。
2. **中途停止预热会多留一份 2.8 GB 的 CPU 模型**：一起发 SIGTERM 时，编译 CoreML 的子进程先死，服务以为"CoreML 编译不了"，转去准备 CPU 版本。现在未完成就停止时整组直接结束；预热完成后，CoreML 版本旁边多出来的 CPU 版本也会删除（真正只能用 CPU 的模型没有 CoreML 版本，不受影响）。
3. `immichctl` 从 `run-service` 文本里读模型版本，在测试沙箱里读空，误把 v2 当成旧导出并清掉 CoreML 系统缓存。现在改为问 `run-service model-revision`。

### 测试（这台 M4 Pro，自带依赖的发布目录，屏蔽 Homebrew、不能联网）

| 场景 | 结果 |
|---|---|
| 新装（按 postinstall 的方式） | `configure.sh` **44 秒**结束（原来 10 分钟以上）；预热期间服务器只开 API、能访问；预热期间上传的照片被接收、15 秒后仍无缩略图、任务在排队；后台预热 9 分 25 秒完成并删除 LaunchAgent；服务器恢复任务处理，那张照片随后有了缩略图、能被智能搜索找到；没有下载模型；没有用到 Homebrew；端到端 **42/42** |
| 接管一键安装版 | `configure.sh` **40 秒**；照片、人脸、搜索索引、文字、用户、设置前后一致；预热期间上传同上；端到端前后都是 **42/42** |
| 预热进行到 90 秒时再装一次 | 第二次 `configure.sh` 31 秒、成功；旧预热停止，新预热 7 分 19 秒完成；服务器恢复正常；发布目录保留两个；没有遗留的半成品或 CPU 副本 |

没有在这台 Mac 上跑真实的 Installer（需要管理员密码）。**请在测试机上用新包再装一次**（图形界面或 `sudo installer -pkg Immich-3.3.5-mac.2.pkg -target /`），看 `/var/log/install.log` 里 `immich postinstall: configure.sh: exit 0 after N s`，N 应在 1–2 分钟以内。

### 已经装了 a559bb0f5 的机器

直接装 mac.2 即可：模型已经准备好，后台预热只需一分钟左右；多出来的发布目录也会在这次安装时清掉。`/Library/Application Support/Immich` 下的空目录仍可用 `sudo rm -rf` 删除。
