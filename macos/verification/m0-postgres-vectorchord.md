# M0-2 PostgreSQL + VectorChord

- 日期：2026-10-29
- 结论：**通过**。风险 R1（VectorChord 在 macOS 上编译）解除

## 版本

| 组件 | 原生（本次） | 官方 Docker（`v3.3.5`） | 服务端要求（`server/src/constants.ts`） |
|---|---|---|---|
| PostgreSQL | 17.11（Homebrew `postgresql@17`） | 14 | `>=14.0.0` |
| VectorChord | 0.4.3（源码编译） | 0.4.3 | `>=0.3 <2` |
| pgvector | 0.8.7（Homebrew `pgvector`） | 0.8.x | `>=0.5 <1` |

选 PostgreSQL 17 而不是 14：服务端支持，Homebrew 维护更久，VectorChord 官方 macOS CI 也覆盖 14 和 17 两个版本。

## 编译 VectorChord 0.4.3

完全照搬 VectorChord 官方仓库 `.github/workflows/check.yml` 中的 `psql_macos` 任务（macOS 15，aarch64）：

```bash
brew install llvm@18 rustup
rustup toolchain install nightly-2025-06-08 --profile minimal   # 源码中 rust-toolchain.toml 指定的版本
cargo install cargo-make --locked
git clone --depth 1 --branch 0.4.3 https://github.com/tensorchord/VectorChord.git
cd VectorChord
export CC=$(brew --prefix llvm@18)/bin/clang
export PGRX_PG_CONFIG_PATH=$(brew --prefix postgresql@17)/bin/pg_config
cargo make build -o ./build/raw        # M4 Pro 上约 72 秒
make PG_CONFIG=$PGRX_PG_CONFIG_PATH install   # Homebrew 目录属于当前用户，不需要 sudo
```

产物是 `vchord.dylib`（arm64），以及 `vchord.control` 和各版本的升级 SQL。

## 功能验证

测试实例由 `macos/scripts/m0-pg.sh` 管理（端口 5433，`shared_preload_libraries = 'vchord'`，初始化参数和 Docker 一样带 `--data-checksums`）。

1. `CREATE EXTENSION vchord CASCADE` 成功，同时自动装上了 `vector`。
2. 10 万条 512 维单位向量（与 CLIP ViT-B-32 的向量规格一致），用和服务端相同的 `vchordrq` 索引参数建索引（`server/src/utils/database.ts`，lists=500，4 线程）：
   - 建索引 18.0 秒，索引大小 286 MB
   - 执行计划确认走了 `Index Scan using m0_vec_idx`
   - 50 次查询（probes=10）共 40 毫秒，**recall@10 = 100%**
3. Immich 服务端连这个库启动：**101 个数据库迁移全部成功**，没有发现表结构差异（`No schema drift detected`），`clip_index` 和 `face_index` 都是 `vchordrq` 索引。端到端结果见 [m0-e2e.md](m0-e2e.md)。

## 发现的问题

### 1. 不设置 locale 时 PostgreSQL 起不来

- 现象：`FATAL: postmaster became multithreaded during startup`，提示设置 `LC_ALL`。
- 原因：`LANG` 为空时（IDE 终端、launchd 启动的进程都是这样），Homebrew 版 PostgreSQL 会向 macOS 查询系统语言，这一步会在主进程里启动线程。
- 处理：启动时设置 `LC_ALL=en_US.UTF-8`（已写进 `m0-pg.sh`）。**M1 的 launchd 配置必须带上这个环境变量。**

### 2. 数据库备份调用 `pg_dump` 的路径写死成 Linux 位置

见 [m0-e2e.md](m0-e2e.md)。这是目前唯一一个必须改官方代码的地方。
