# M0-0 本机工具链

- 日期：2026-10-29
- 检查脚本：`macos/scripts/m0-check-env.sh`
- 结论：**进行中**

## arm64 Homebrew

- 原有 Homebrew 在 `/usr/local`，为 Intel 版本（Rosetta），不用于本项目，但保留不动。
- 已新装 arm64 Homebrew：`/opt/homebrew`（Homebrew 7.0.11，`brew config` 显示 `macOS: 15.6-arm64`、`Rosetta 2: false`）。
- `~/.zprofile` 已加入 `eval "$(/opt/homebrew/bin/brew shellenv)"`，使 `/opt/homebrew/bin` 在 PATH 中排在 `/usr/local/bin` 前面。

## 官方固定的版本

来自仓库根目录的 `mise.toml` / `mise.lock`（`v3.3.5`）：

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.22.1 | 同 `.nvmrc` |
| pnpm | 11.27.1 | 同 `package.json` 的 `packageManager` |
| jellyfin-ffmpeg | 7.1.3-6 | `mise.lock` 已锁定 macOS arm64 构建 `jellyfin-ffmpeg_7.1.3-6_portable_macarm64-gpl.tar.xz` 及其 sha256 |

## 依赖安装记录

（待补充）
