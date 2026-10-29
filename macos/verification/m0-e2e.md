# M0-5 端到端：原生服务端 + 原生数据库 + 原生机器学习

- 日期：2026-10-29
- 结论：**通过（40 项检查通过 39 项）**。唯一失败的是数据库备份，原因已确认，修复列为 M1 的第一个补丁
- 更新：已在 M1 修复，端到端 40/40，见 [m1-db-backup.md](m1-db-backup.md)。修复过程中还发现 macOS 自带 gzip 会让备份变成 0 字节却报告成功
- 脚本：`macos/scripts/m0_e2e.py`（只通过公开 API 操作，和用户使用的方式一样）

## 环境

全程不使用 Docker，所有组件都是 arm64 原生进程：

| 组件 | 启动方式 | 端口 |
|---|---|---|
| PostgreSQL 17.11 + VectorChord 0.4.3 | `macos/scripts/m0-pg.sh start` | 5433 |
| Valkey 9.1.3 | `valkey-server --port 6380` | 6380 |
| 机器学习服务（CoreML，单进程） | `uvicorn immich_ml.main:app` | 3003 |
| Immich 服务端 v3.3.5（Node 24，sharp 已源码编译） | `macos/scripts/m0-server.sh` | 2283 |
| jellyfin-ffmpeg 7.1.3-6 | 放在 PATH 最前面 | — |
| geodata、网页文件 | `macos/scripts/m0-build-data.sh` → `IMMICH_BUILD_DATA` | — |

服务端唯一需要的特殊配置是环境变量：`IMMICH_BUILD_DATA`（代替容器里的 `/build`）和 `IMMICH_MEDIA_LOCATION`（代替 `/data`）。**不需要改任何官方代码就能启动。**

## 流程

1. 在全新实例上注册管理员，并在系统设置里把机器学习地址改成 `http://127.0.0.1:3003`。
2. 上传 30 个文件：`e2e/test-assets/formats` 下的全部 24 个格式素材、3 张功能素材（人像、日文招牌、游隼），以及 3 段合成视频（4K HLG、4K PQ、1080p SDR）。
3. 等待所有后台任务完成：元数据提取、缩略图、动态照片视频提取、视频转码、CLIP 向量、人脸检测与识别、OCR、重复检测、反向地理编码。
4. 逐项检查。

## 结果

| 检查项 | 结果 |
|---|---|
| 服务端能连上机器学习服务 | 通过 |
| 30 个文件上传 | 通过 |
| 后台任务完成 | 通过。首次运行 172 秒（大部分时间是 CoreML 首次编译模型）；编译缓存存在时为 12 秒 |
| 每个文件：预览图、thumbhash、EXIF 尺寸（视频另查能否播放） | **30/30 通过**。相机型号都能正确读出，例如 Canon EOS 70D、FUJIFILM X100V、RICOH GR III、SONY ILCE-7M2、Google Pixel 8a |
| 人脸识别（portrait.jpg） | 通过，识别出 1 张人脸 |
| OCR（japanese-shop.jpg） | 通过：`海, 营業中, KIRIN, 取极店` |
| 智能搜索 "a bird of prey" | 通过，游隼排第一 |
| 4K HLG / PQ 视频转码 | 通过：输出 H.264 720p，色彩转为 bt709（色调映射生效） |
| 1080p H.264 视频 | 通过：默认策略（`required`）下原片编码已被接受，按官方行为不转码，直接播放原片 |
| **数据库备份** | **失败**，见下文 |

另外从服务端日志确认：动态照片（Pixel、Samsung）里的视频被提取并转码；反向地理编码正常工作（229,324 条地名数据，252 个国家名）。

## 数据库备份失败

服务端日志：

```
ERROR [Microservices:DatabaseBackupService] Database Backup Failure: Error: spawn /usr/lib/postgresql/17/bin/pg_dump ENOENT
```

原因：`server/src/services/database-backup.service.ts` 第 218 行把 `pg_dump` / `psql` 的路径写死成了 Debian 的安装位置：

```ts
bin: `/usr/lib/postgresql/${databaseMajorVersion}/bin/${bin}`,
```

这和最初看代码时的判断一致。**影响**：自动备份、手动备份，以及网页上的"从备份恢复"（用 `psql`）在 Mac 上都不能用。

**修复已验证可行**：用 Homebrew 的 `pg_dump`，按服务端完全相同的参数（`--clean --if-exists`）备份，再恢复到新库，0 个错误；资产、CLIP 向量、人脸数据以及 `vchordrq` 索引全部完整恢复。所以只要让服务端能找到正确的程序路径即可。

**M1 补丁方案**（`mac/feat/pg-bin-path`）：新增环境变量（如 `IMMICH_PG_BIN_DIR`），优先用它指定的目录；没设置时保持原来的 Debian 路径，Docker 部署的行为不变。顺带补上对应的单元测试。这个改动是通用的，适合提给官方。

## 其他发现

- **服务端会改写进程名**（变成 `immich`、`immich-api`），按命令行去 `pkill` 找不到旧进程。旧的 API 进程残留时，新进程报 `EADDRINUSE` 后退出，但外面看起来服务"正常响应"，只是网页内容是空的。`m0-server.sh` 已改为按进程名和端口停止旧进程。M1 的进程管理器必须处理这个问题。
- **停止服务端后留下孤儿 exiftool 进程**：服务端通过 `exiftool-vendored` 常驻 2 个 `perl exiftool -stay_open` 子进程。服务端被停止后，这些子进程没有退出，父进程变成 1（launchd）；每重启一次就多留 2 个。容器里由 `tini` 作为 1 号进程统一回收，原生部署没有这一层。**M1 的进程管理器必须让服务端单独成为一个进程组，停止时向整个进程组发信号。**
- **网页目录是否存在只在启动时检查**：`IMMICH_BUILD_DATA/www` 是启动后才放进去的话，网页不会生效，必须重启服务端。
- 插件目录（`build/plugins/immich-plugin-core`）在 M0 没有准备，服务端只报一个警告，不影响核心功能。M1 要按 `server/Dockerfile` 中 `plugins` 阶段的做法补上（需要 extism 工具链）。
- 测试脚本本身的教训：Immich 会清理已完成和已失败任务的计数，所以"失败任务数为 0"不能说明没有失败，必须逐个功能检查结果。
