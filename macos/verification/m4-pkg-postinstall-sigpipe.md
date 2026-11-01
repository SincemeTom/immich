# M4 问题：`Immich-3.3.5-mac.2.pkg` 安装失败（postinstall 找安装用户时被 SIGPIPE 终止）

- 安装包：`Immich-3.3.5-mac.2.pkg`（标签 `v3.3.5-mac.2`，`d72888b40`）
- 机器：MacBook Pro，Apple M4 Pro，macOS 26.7；在运行着 `3.3.5-a559bb0f5` 的实例上用 Installer 图形界面升级，Immich 当时正在处理任务队列
- 日期：2026-11-01
- 状态：**已修复**（分支 `mac/fix/pipefail-early-readers`，正式版 `v3.3.5-mac.3`），见文末"修复"
- 结论：postinstall 第 29–30 行用 `ps -axo user=,comm= | awk '… { print $1; exit }'` 找打开 Installer 的用户。awk 一找到就退出，`ps` 后面还没写完的输出就收到 SIGPIPE，退出码 141；脚本开了 `set -euo pipefail`，于是在第一条日志之前就退出了。**这次什么都没有安装**，原来的版本继续运行，不受影响。和 [m4-pkg-postinstall-timeout.md](m4-pkg-postinstall-timeout.md) 的 600 秒超时是两回事

## 现象

Installer 报"安装器遇到了一个错误，导致安装失败"。和上次不同的是，这次几秒钟就失败了。

## 日志

`/var/log/install.log`：

```
18:42:25 package_script_service[48189]: PackageKit: Executing script "postinstall" in /tmp/PKInstallSandbox.3G5w16/Scripts/io.github.sincemetom.immich.75HAJH
18:42:32 package_script_service[48189]: PackageKit: Hosted team responsible for script has been cleared.
18:42:32 installd[1197]: PackageKit: Install Failed: Error Domain=PKInstallErrorDomain Code=112 "运行软件包"Immich-3.3.5-mac.2.pkg"的脚本时出错。" UserInfo={NSFilePath=./postinstall, ...}
```

**postinstall 一行输出都没有。** 正常情况下它的第一条日志（第 32 行）是 `immich postinstall: Installer opened by: …`，上午那次安装就有这一行。这次没有，说明脚本在第 32 行之前就退出了。

这 7 秒基本花在 `trap cleanup EXIT` 上：退出时删除暂存的 payload（136,555 个文件，5.6 GB）。

## 当时的状态

| 项目 | 状态 |
|---|---|
| `~/Library/Application Support/Immich/releases/` | 没有 `3.3.5-mac.2`，`current` 仍指向 `3.3.5-a559bb0f5-standalone` |
| `~/Library/Logs/Immich/install.log` | 没更新（还是 11:29），`configure.sh` 没有运行 |
| 模型 | 三个 v2 模型完好，都有完成标记 |
| 服务 | 四个都是 ok，继续运行旧版本 |
| 暂存目录 `/Library/Application Support/Immich/pkg/3.3.5-mac.2` | 已被 cleanup 删除 |
| 安装回执 | 没更新（install-time 仍是 2026-10-31 18:51） |

payload 的路径（`pkg/3.3.5-mac.2/{release,models}`）和脚本里的 `RELEASE_ID="3.3.5-mac.2"` 一致，不是路径对不上的问题。

## 根因

`macos/package/scripts/postinstall` 第 8 行和第 29–30 行（`e2944b857` 引入）：

```bash
set -euo pipefail
...
installer_user="$(ps -axo user=,comm= \
  | awk '$2 == "/System/Library/CoreServices/Installer.app/Contents/MacOS/Installer" && $1 != "root" { print $1; exit }')"
```

1. `ps` 按 PID 顺序输出。这台 Mac 当时有 857 个进程，输出 89 KB，超过管道缓冲区（64 KB）。
2. Installer 的 PID 是 50565，排在中间；Immich 正在干活，后面还有很多 PID 更大的进程（ml 99579、一批 ffmpeg 9xxxx）。awk 读到 Installer 那行就 `exit`，`ps` 再写就收到 SIGPIPE，退出码 141。
3. `pipefail` 让整条管道的退出码变成 141，赋值语句随之失败，`set -e` 让脚本立刻退出。
4. 退出码 141 传给 Installer，Installer 报安装失败。

**为什么上午的安装没出问题**：那次 Installer 的 PID 是 47742，当时几乎是最大的 PID，后面剩下的输出很少，awk 退出前 `ps` 已经写完了。所以这个问题会不会出现，取决于 Installer 的 PID 在进程表里排在哪：机器开着越多进程、PID 回绕过一轮、Immich 正在转码（会起很多新进程），就越容易失败。正式环境的 Mac mini 长期运行、跑满任务时，失败的概率很高。

## 复现（在这台 Mac 上，普通用户即可）

和 postinstall 完全相同的写法，只是换成匹配进程表里不同位置的进程：

```bash
for target in /sbin/launchd "$(ps -axo comm= | sed -n '200p')" "$(ps -axo comm= | tail -1)"; do
  /bin/bash -c 'set -euo pipefail; u="$(ps -axo user=,comm= | awk -v t="$1" "\$2 == t { print \$1; exit }")"; echo "ok ($u)"' sh "$target" \
    || echo "FAILED, exit $?"
done
```

| 匹配的进程 | 在进程表中的位置 | 结果 |
|---|---|---|
| `/sbin/launchd` | 第 1 个 | **FAILED, exit 141**（10 次中 10 次） |
| `/usr/libexec/aned` | 第 200 个 | **FAILED, exit 141** |
| `/bin/zsh` | 最后一个 | ok |

## 建议修复

让 awk 读完全部输入，不要中途 `exit`：

```bash
installer_user="$(ps -axo user=,comm= \
  | awk '$2 == "/System/Library/CoreServices/Installer.app/Contents/MacOS/Installer" && $1 != "root" && !found { print $1; found = 1 }')"
```

另外建议：

1. **测试要覆盖 Installer 不在进程表末尾的情况**：例如先起几百个 `sleep` 进程，再 `sudo installer -pkg …`；或者单独测上面这段，确认匹配第 1 个进程时也能通过。
2. **postinstall 开头先打一行日志**（比如 `log "started"`），再做任何可能失败的事。再出类似问题时，日志里至少能看出脚本跑起来了。
3. **用 `trap 'log "failed at line $LINENO: exit $?"' ERR` 记下失败的位置。** 这次就是因为没有任何输出，才需要解开安装包逐行排查。

### 同样写法的其他位置（已检查，目前不会出问题）

| 位置 | 写法 | 结论 |
|---|---|---|
| `macos/native/configure.sh` 第 134 行、`immichctl` 第 40 行 | `launchctl print … \| awk '… exit }'` | 输出约 1.7 KB，一次就全部写进管道，awk 退出前写端已经结束；在这台 Mac 上 20 次都通过。不过属于同一类隐患，建议一起改成不提前 `exit` |
| `immichctl` 第 182、185 行 | `pmset -g \| awk '… exit }'` | 输出很小，同上 |
| `configure.sh` 第 142 行等 | `… \| head -1` | 输出只有一两行，不会触发 |

## 已经装着旧版本的机器

这次安装没有改动任何东西，旧版本照常运行。等修复后的安装包出来再装就行。在那之前，用户没法通过 Installer 升级：重试的结果取决于当时的进程表，可能这次失败、下次又成功。

## 修复

按建议改为让 awk 读完全部输入，并把同一类写法全部改掉：

| 位置 | 改动 |
|---|---|
| `postinstall` 找安装用户 | 改为函数 `first_user_running`，awk 用 `!found` 只取第一个匹配、读完全部输入 |
| `postinstall` 开头 | 第一行先记日志 `immich postinstall: started: <版本>`；`trap ERR` 记下失败的行号和退出码 |
| `configure.sh`、`immichctl` 里 `launchctl print \| awk … exit`、`pmset -g \| awk … exit` | 同样改为读完全部输入 |
| `lsof … \| head -1`、`sort -V \| head -1`、`find … \| head -3` | 改为 `sed -n 1p` / `sed -n 1,3p`（sed 读完全部输入） |
| `find … \| grep -q .`（4 处）、`curl … \| grep -q pong`、`socketfilterfw … \| grep -q enabled` | `find` 加 `-print -quit`，最多输出一行；另外两处改为 `grep … >/dev/null` |

回归测试 `macos/package/tests/postinstall-pipes.sh`：先起 1000 个进程，让 `ps` 输出超过 64 KB（这次 113 KB），再找进程表靠前的当前用户进程（`loginwindow`），各跑 20 次：

| | 失败 |
|---|---|
| mac.2 的写法 | **20/20**（复现了问题） |
| `first_user_running` | **0/20** |

测试同时检查旧写法确实失败过，否则视为测试无效（说明进程表不够大，没有触发条件）。
