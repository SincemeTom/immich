# M0-0 本机工具链

- 日期：2026-10-29
- 检查脚本：`macos/scripts/m0-check-env.sh`
- 结论：**通过**

## arm64 Homebrew

- 原有 Homebrew 在 `/usr/local`，为 Intel 版本（Rosetta），不用于本项目，但保留不动。
- 已新装 arm64 Homebrew：`/opt/homebrew`（Homebrew 7.0.11，`brew config` 显示 `macOS: 15.6-arm64`、`Rosetta 2: false`）。
- `~/.zprofile` 已加入 `eval "$(/opt/homebrew/bin/brew shellenv)"`，使 `/opt/homebrew/bin` 在 PATH 中排在 `/usr/local/bin` 前面。

## 官方固定的版本

来自仓库根目录的 `mise.toml` / `mise.lock`（`v3.3.5`）：

| 工具 | 官方版本 | 本机 | 说明 |
|---|---|---|---|
| Node.js | 24.22.1 | 24.22.2（`node@24`） | 只差补丁版本 |
| pnpm | 11.27.1 | 11.27.1（corepack） | 同 `package.json` 的 `packageManager` |
| Python（机器学习） | 3.12 | 3.12.16（uv，arm64） | |
| jellyfin-ffmpeg | 7.1.3-6 | 7.1.3-6 | `mise.lock` 已锁定 macOS arm64 构建及 sha256 |

## 依赖安装记录

全部使用 arm64 Homebrew：

```bash
brew install postgresql@17 pgvector valkey vips exiftool pkg-config rustup node@24
brew install llvm@18                       # 编译 VectorChord 用
rustup toolchain install nightly-2025-06-08 --profile minimal
cargo install cargo-make --locked
corepack enable pnpm --install-directory /opt/homebrew/opt/node@24/bin
```

| 组件 | 版本 |
|---|---|
| PostgreSQL | 17.11 |
| pgvector | 0.8.7 |
| VectorChord | 0.4.3（源码编译） |
| Valkey | 9.1.3 |
| libvips | 8.18.7 |
| exiftool | 已安装，但服务端使用 npm 包 `exiftool-vendored` 自带的版本 |

jellyfin-ffmpeg 不走 Homebrew，直接下载官方锁定的版本（见 [m0-ffmpeg-videotoolbox.md](m0-ffmpeg-videotoolbox.md)）。

## 环境注意

- IDE 终端和 launchd 启动的进程中 `LANG` 为空，会导致 PostgreSQL 起不来，见 [m0-postgres-vectorchord.md](m0-postgres-vectorchord.md)。
- `rustup` 是 keg-only，需要把 `/opt/homebrew/opt/rustup/bin` 加进 PATH。
