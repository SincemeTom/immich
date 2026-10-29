# M1-1 数据库备份：`DB_BIN_DIR` 与空备份检测

- 日期：2026-10-29
- 分支：`mac/feat/pg-bin-path`（基于 `mac/develop`）
- 结论：**通过**。全原生端到端 **40/40**，数据库备份可用，并且备份文件内容经过校验

## 问题

M0 端到端测试里数据库备份失败（见 [m0-e2e.md](m0-e2e.md)），原因是服务端把 `pg_dump` / `psql` 的路径写死成 Debian 镜像中的位置：`/usr/lib/postgresql/<主版本>/bin/`。

修好路径后又发现第二个问题，而且**更危险**：

- 服务端把 `pg_dump` 的输出交给 `gzip --rsyncable` 压缩。macOS 自带的 gzip（Apple gzip 457）不认识 `--rsyncable`，打印用法后 **以退出码 0 退出**，不产生任何输出。
- 服务端只看退出码，于是把一个 **0 字节的文件**改名为正式备份，日志写 `Database Backup Success`，网页里也会列出这个备份。
- 用户会以为自己有备份。"从备份恢复"之前服务端也会先做一个恢复点备份（`restore-point-`），这个恢复点同样会是空的。

M0 的端到端检查一开始也被骗过了（只检查"有没有新文件"），所以这次把检查改成了下载并解开备份、核对内容。

## 改动（官方代码，共 6 个文件）

| 文件 | 改动 |
|---|---|
| `server/src/dtos/env.dto.ts` | 新增环境变量 `DB_BIN_DIR`，必须是绝对路径 |
| `server/src/repositories/config.repository.ts` | 新增 `database.binDir` |
| `server/src/services/database-backup.service.ts` | 1. 设置了 `DB_BIN_DIR` 就从该目录找 `pg_dump` / `pg_dumpall` / `psql`；没设置时**完全保持原行为**（Docker 部署不受影响）。2. 改名前检查临时文件大小，为 0 就报错 `Backup file is empty` 并删除临时文件 |
| `server/src/repositories/config.repository.spec.ts` | 新增 2 个测试：读取 `DB_BIN_DIR`；拒绝相对路径 |
| `server/src/services/database-backup.service.spec.ts` | 新增 3 个测试：使用 `DB_BIN_DIR` 中的 `pg_dump`；设置 `DB_BIN_DIR` 后仍检查 PostgreSQL 版本；空备份会失败且不改名 |
| `docs/docs/install/environment-variables.md` | 在 Database 表里登记 `DB_BIN_DIR`，并注明客户端工具的主版本必须不低于数据库 |

PostgreSQL 版本检查（14–18）原样保留：即使指定了目录，也不会用不支持的版本去备份。

### 为什么空备份检测放在官方代码里，而不是只在 Mac 版装 GNU gzip

装 GNU gzip 只解决 Mac 这一种情况。服务端的根本问题是"工具退出码为 0 就当作成功"，任何环境里工具链出问题都可能被它掩盖。gzip 的输出即使输入为空也至少有 20 字节，所以 0 字节一定代表失败，这个判断不会误报。两处改动都通用，适合一起提给官方。

## 验证

### 官方检查（`server/`）

| 检查 | 结果 |
|---|---|
| 单元测试（vitest，全量） | 105 个文件，**2328 通过**（1 个预期失败，与改动前相同） |
| 类型检查（`tsc --noEmit`） | 通过 |
| eslint（改动的 5 个文件，`--max-warnings 0`） | 通过 |
| prettier（全部改动文件） | 通过 |
| OpenAPI | 不涉及（环境变量不出现在接口定义里），无需重新生成 |

### 真实环境

1. **只有 Apple gzip 时**（临时 `brew unlink gzip`）：触发备份后日志为 `Database Backup Failure: Error: Backup file is empty`，备份目录里**没有任何文件**。修复前这里会留下一个 0 字节的"成功"备份。
2. **装上 GNU gzip 1.15**（`brew install gzip`）后，在全新实例上跑端到端测试（`macos/scripts/m0_e2e.py`）：**40/40 通过**。
   - 备份 `immich-db-backup-20261029T164245-v3.3.5-pg17.11.sql.gz`：压缩后 18.1 MB，解压后 44.5 MB SQL，包含 `pg_dump` 的结束标记，以及 `asset`、`smart_search`（CLIP 向量）、`asset_face` 三张表的数据。
   - M0 已用同样的参数验证过恢复：恢复到新库 0 个错误，数据和 `vchordrq` 索引完整（见 [m0-e2e.md](m0-e2e.md)）。

## 对后续的要求

- 原生部署必须设置 `DB_BIN_DIR`（Homebrew 下为 `/opt/homebrew/opt/postgresql@17/bin`；M3 打包后指向 `.app` 内的目录）。
- 必须带 **GNU gzip**，并且在 PATH 里排在 `/usr/bin` 前面。M3 打包时 gzip 要和 PostgreSQL 客户端工具一起放进 `.app`。`m0-check-env.sh` 已加入这一项检查。
- 网页上的"从备份恢复"这次还没有端到端测过。它走的是同一套 `psql` 路径和恢复点备份，M1 做一键安装时补上测试。
