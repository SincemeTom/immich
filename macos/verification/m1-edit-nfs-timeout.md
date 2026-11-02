# M1 问题：NFS 照片库里编辑（旋转）图片，网页报"应用编辑失败"，实际已成功

- 正式版：`v3.3.5-mac.4`（`/Users/…/Immich/releases/3.3.5-mac.4`）
- 环境：照片库在 NFS 网络共享（群晖）上；服务器四个服务均正常（`immichctl status` 全 ok）
- 日期：2026-11-02
- 状态：**已修复**（`web/src/lib/utils/asset-rotate.ts`），见文末"修复"
- 结论：服务器端的编辑任务每次都成功，失败的是**网页前端的等待超时**。图片只等 30 秒，NFS 上编辑任务的读写要吃网络延迟，超过 30 秒前端就报错；任务本身不受影响，刷新后图片已是旋转后的。视频的等待是 300 秒，所以视频旋转（`m1-video-rotation.md` 的功能）从没报过错

## 现象

1. 网页里打开一张图片 → 旋转 → 保存，弹出「应用编辑失败」
2. 无论图片大小，全部报错
3. 报错后等一分钟刷新页面，图片**实际已经旋转成功**
4. 同样操作旋转视频，不报错，成功

## 日志

`immichctl logs server` 里，保存图片的时刻**没有任何错误**，整个 `server.log` 只有两类相关条目：

```
[Nest] 87550  - 11/02/2026, 3:33:23 PM   ERROR [Api:LoggingRepository~u9vrtvhn] Unknown error: RangeNotSatisfiableError: Range Not Satisfiable
RangeNotSatisfiableError: Range Not Satisfiable
    at createHttpError (.../send/index.js:866:7)
    ...

[Nest] 87525  - 11/02/2026, 4:06:59 PM     LOG [Microservices:MediaService] Video bced9898-... shown rotated 180°
```

**两条都不是本问题的原因**：

- `RangeNotSatisfiableError`（416）来自 `send` 模块（静态文件服务）。是浏览器带着过期的 `Range` 请求头去要一个已被替换、尺寸变了的文件（文件尺寸变了，旧的字节偏移越界）。属于次生噪音，编辑成功后查看器刷新资源时偶发，与本问题无关，也不会导致"应用编辑失败"这个提示。
- `Video … shown rotated 180°` 是视频旋转的**成功**日志（`server/src/services/media.service.ts` 的 `syncEditedVideo`）。

## 报错的真正来源

「应用编辑失败」是前端 toast（i18n 的 `editor_edits_applied_error`），抛出点有两处，逻辑相同：

- 编辑器里保存：`web/src/lib/managers/edit/edit-manager.svelte.ts` 的 `applyEdits`
- 查看时按 `R` 旋转：`web/src/lib/services/asset.service.ts` 的 `handleRotateAsset`

流程都是：

1. 调用 `editAsset` / `removeAssetEdits` API——**这一步总是成功**（服务器只写数据库并排队任务，`server/src/services/asset.service.ts` 的 `editAsset`）
2. 然后等 `AssetEditReadyV2` websocket 事件，**限时 `getEditTimeout(asset)`**——超时就进 catch，弹「应用编辑失败」

```ts
// web/src/lib/utils/asset-rotate.ts（修复前）
/** How long applying edits may take: a video's stream is copied anew, longer than an image's thumbnails, on a NAS more */
export const getEditTimeout = (asset: { type: AssetTypeEnum }) =>
  asset.type === AssetTypeEnum.Video ? 300_000 : 30_000;   // 图片只有 30 秒
```

## 根因

`AssetEditReadyV2` 事件在**后台任务完成后**才由 `server/src/services/job.service.ts` 的 `onDone`（`JobName.AssetEditThumbnailGeneration`）发出。这个任务（Editor 队列，`media.service.ts` 的 `handleAssetEditThumbnailGeneration`）做的是实际重活：

- 从照片库**读原图**并解码（live photo 还要同步处理动态视频）
- 重新生成并**写**编辑后的 preview、thumbnail、fullsize 多个文件（存储位置可能在网络盘，见 `m1-storage-locations.md`）
- 生成 thumbhash

照片库在 NFS 上时，这些读写每一次都付网络共享的延迟，**与图片大小基本无关**——小图同样要多次往返，轻松超过 30 秒。超时后前端报错，但任务照常完成，所以刷新后图片已经旋转好了。视频超时是 300 秒，同样的重活来得及，从不报错。

原注释里其实已经预见到（"on a NAS more"），只是图片仍然只给了 30 秒。

## 修复

`web/src/lib/utils/asset-rotate.ts`：图片和视频统一等 300 秒。

| 位置 | 改动 |
|---|---|
| `web/src/lib/utils/asset-rotate.ts` | `getEditTimeout` 不再区分类型，一律 `300_000`。两处调用方（编辑器保存、`R` 键旋转）都经过它，一处改动全部生效 |

等待变长没有副作用：事件到了就立即继续；只有真正失败时，错误提示会比以前晚出现（而以前 NFS 上是**必然**误报）。

### 已经装了正式版的机器

这是纯前端改动，重新构建 web 并替换安装目录里的 `build/www`（打包时就是从 `web/build` 拷过去的，见 `macos/package/build-release.sh`）：

```bash
pnpm --filter immich-web build
rsync -a --delete web/build/ "$HOME/Library/Application Support/Immich/releases/3.3.5-mac.4/build/www/"
immichctl restart server   # www 目录只在启动时检查
```

浏览器强制刷新（Cmd+Shift+R）后生效。升级到下一个版本包时此热修会被覆盖，正式解决靠本改动随版本发布。

## 验证

- 修复前（v3.3.5-mac.4）：NFS 库上旋转图片，大小图片全部报「应用编辑失败」；刷新后全部实际成功；视频不报错
- 待测试机复验：热修后 NFS 库上旋转大图、小图、实况照片各一次，30 秒内任务未完成时不再误报；本地库上行为不变
