# 群晖照片相册同步：开工前探测

- 分支：`mac/feat/synology-albums`
- 日期：2026-11-04
- 脚本：`macos/scripts/synology_photos_probe.py`（只读）
- 原始数据：留在仓库外（`~/Documents/immich-scratch/synology/`），这里只记结构和数量；字段结构见 [synology-probe-summary.json](synology-probe-summary.json)
- 结论：做同步要读的信息都能拿到。还差一项不来自接口：个人空间在 NAS 上的绝对路径，要由用户填写

## 数据

| 项目 | 结果 |
|---|---|
| 自己的相册 | 49 个，重名 0 个，类型都是 `normal`；接口返回的张数和实际读到的全部一致 |
| 相册里的照片和视频 | 16323 项，去掉跨相册重复后 16254 项 |
| 所有者 | 自己 13205 项；别人 3049 项（来自 3 个用户） |
| 别人共享给自己的相册 | 6 个，999 项（按原则不同步） |
| 共享空间（`SYNO.FotoTeam.*`） | 未启用 |

## 接口

| 要读什么 | 调用 | 说明 |
|---|---|---|
| 相册、成员和权限 | `SYNO.Foto.Browse.Album list v2`，`additional=["sharing_info","thumbnail","provider_count"]` | 一次调用就够，不用逐个相册读。`sharing_info.permission[]` 有 `id`（DSM 用户）、`db_id`（照片用户）、`role`、`type` |
| 相册里的照片 | `SYNO.Foto.Browse.Item list v1`，`album_id` | 16323 项都有 `filename`、`filesize`、`time`、`folder_id`、`owner_user_id` |
| 别人共享给自己的相册里的照片 | 同上，改用 `passphrase` | 用 `album_id` 读返回错误 609 |
| 文件夹路径 | `SYNO.Foto.Browse.Folder get v1`，`id` | `name` 是相对个人空间的路径 |
| 当前账号 | `SYNO.Foto.UserInfo me v1` | `id` 就是照片里的 `owner_user_id` |
| 可共享的用户 | `SYNO.Foto.Sharing.Misc list_user_group v1` | 15 个用户、1 个群组；只有 DSM 的 `id` 和名字 |

没用的调用：`SYNO.Foto.Sharing.Passphrase get v1` 返回空列表。

## 错误

101 次调用失败，都是预期内的：

| 次数 | 调用 | 错误码 | 含义 |
|---|---|---|---|
| 47 + 47 | `SYNO.Foto.Browse.Folder get` + `SYNO.FotoTeam.Browse.Folder get` | 642 + 801 | 47 个别人的文件夹读不了（共 149 个文件夹，读到 102 个，都是自己的） |
| 6 | `SYNO.Foto.Browse.Item list`（`album_id`） | 609 | 别人共享给自己的 6 个相册，改用 `passphrase` 后全部读到 |
| 1 | `SYNO.Foto.Sharing.Passphrase get` | 120 | 参数类型错；这个调用本来就没用 |

## 对同步的影响

### 对照片

- 自己的 13205 项都读得到文件夹路径。别人的 3049 项读不到路径，但文件名、大小、时间都有，只能走第二档。
- `time` 是**当地时间按 UTC 编码**，要和 Immich 的 `localDateTime` 比，不能和 `fileCreatedAt` 比。本机库里能对上的 52 张，差值 32 张是 0 秒、20 张是 -1 秒；和 `fileCreatedAt` 比差 8 小时。所以比时间要留 1 秒余量。
- 实况照片：42 张都是 Immich 的照片部分（带动态视频）对上群晖的 `live`，大小是照片文件的大小，不用另外处理视频。
- 本机 Immich 里只要文件名和群晖相同，大小就相同（52/52）。样本少，只说明这种比法目前没有误判。
- 自己的照片里有 79 对文件名、大小、时间全同，都在不同文件夹：同一文件存了两份。路径优先能分开；只靠第二档时无法区分，对上哪张都是同样内容。
- 文件名 + 大小 + 时间 和 文件名 + 大小 的重复数一样，时间在这批数据里没有多分辨出什么，仍然保留作校验。

### 共享和权限

共享关系能对应到 Immich 的五档：

| 群晖 `role` | 成员数（相册 × 人） | Immich |
|---|---|---|
| `view` | 75 | 仅查看 |
| `download` | 88 | 可下载 |
| `upload` | 69 | 可编辑 |

- 共享给了 14 个用户，都是单个用户（`type=user`），没有共享给群组的。
- 绑定账号时读 `UserInfo me` 拿到 `id`，就能和 `db_id`、`owner_user_id` 对上，不用比名字。
- `upload` 在群晖能否下载没验证；Immich 的可编辑能下载，也能移除自己加的照片。

### 别人的照片

相册里 3049 项别人的照片，所有者在该相册里全部是 `upload` 成员，看起来是他们自己加进来的。这和 Immich 编辑者把自己的照片加进相册是同一回事，所以：

- 只在这个所有者的 Immich 库里找，不碰其他人的照片；
- 只有他已绑定、并且已是这个相册的成员时才加；
- 否则列进同步报告。

### 公开链接

47 个相册有 `passphrase`：44 个 `public-view`，2 个 `public-download`，1 个 `private`；都没有密码和有效期。同步不会在 Immich 里建公开链接。

## 没验证的

- 相册 `version` 能否用来跳过没变的相册。
- NAS 上个人空间的绝对路径：接口只给相对路径。
- 时间比对只有 52 张、同一时区的样本。

端到端验证在 ROADMAP 里单独一项。
