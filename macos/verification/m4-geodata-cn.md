# M4：照片地点显示中文（immich-geodata-cn）

- 日期：2026-11-01
- 机器：M4 Pro 64 GB，macOS 15.6
- 状态：**通过**，v3.3.5-mac.4 起
- 改动：`macos/native/geodata.sh`（新），`install.sh`、`build-release.sh` 改用它；`check-release.sh`、`m0_e2e.py` 加检查；`collect_licenses.py` 附上许可和源码

## 问题

照片详情里的地点是英文："Jiangchuanlu / Shanghai / China"。原生版和官方镜像一样用 GeoNames 的英文数据（`cities500.txt` 等）。

以前 Docker 版用 [immich-geodata-cn](https://github.com/ZingLix/immich-geodata-cn) 的补丁：替换 `/build/geodata`，再用它的 `i18n-iso-countries` 替换国家名。上游 2026-09 的 #30199 改为从 `countryInfo.txt` 读国家名，不再用 `i18n-iso-countries`，所以老补丁的国家名那部分已经无效。

## 做法

- immich-geodata-cn 的 `release-2026-08-10` 里，`countryInfo.txt` 的国家名已经是中文（CN 中国、JP 日本、US 美国），和新版服务端读国家名的方式兼容，**不用改服务端代码**，只换数据
- 选 `geodata_admin_2_admin_3_admin_4`（地级 区县 乡镇），即以前补丁的"三级地址"：第一行"上海市 闵行区 江川路街道"，第二行省（`admin1`）"上海市"，第三行"中国"
- `geodata.sh DIR`：下载这个版本的 zip（20 MB，固定 tag 和 sha256，和 GitHub 公布的 digest 一致），检查 6 个文件都在，写 `source.txt`，整个目录替换；已经是这个版本时什么都不做
- 服务端在 `geodata-date.txt` 变化时下次启动自动重新导入；已有照片的地名要重新提取元数据

## 结果

各版本数据对同一组坐标给出的结果（与服务端相同的算法：`cities500` 里最近的一个，25 km 内）：

| 坐标 | 原来（GeoNames） | admin_2_admin_3_admin_4（采用） | admin_2_admin_3 |
|---|---|---|---|
| 江川路（31.02, 121.40） | Jiangchuanlu / Shanghai / China | 上海市 闵行区 江川路街道 / 上海市 / 中国 | 上海市 闵行区 / 上海市 / 中国 |
| 人民广场 | — | 上海市 黄浦区 南京东路街道 / 上海市 | 上海市 黄浦区 |
| 昆山周市 | — | 苏州市 昆山市 周市镇 / 江苏省 | 苏州市 昆山市 |
| 东京新宿 | — | 新宿区 / 东京都 / 日本 | 同左 |
| 纽约 | — | 威活肯 / 新泽西州 / 美国 | 同左 |

这台 Mac 的实际库：换数据、重启服务端，2.4 秒导入 246768 条。98 张带 GPS 的照片按新数据：

| 原来 | 现在 |
|---|---|
| Manzhouli / Inner Mongolia / China（84 张） | 呼伦贝尔市 满洲里市 兴华街道 / 内蒙古自治区 / 中国 |
| Jiangchuanlu / Shanghai / China（4 张） | 上海市 闵行区 梅陇镇 / 上海市 / 中国 |
| Zabaykal'sk / Zabaykalskiy (Transbaikal) Kray / Russia（10 张） | Zabaykal'sk / Zabaykalskiy (Transbaikal) Kray / 俄罗斯 |

- 那 4 张显示梅陇镇：数据里每个乡镇只有一个点，取最近的点，边界附近会落到相邻的乡镇。该项目的 `_full` 版按边界判断更准，但 zip 大 2.8 倍、导入更慢，暂不用
- 国外只有国家名是中文；城市名除日本外仍是 GeoNames 的英文

## 测试

- `geodata.sh`：新目录下载（4 秒）、再次运行跳过、替换旧的 GeoNames 目录，都正常
- `check-release.sh` 新增"geodata"一项：6 个文件都在，上海闵行的坐标查出"闵行区 / 上海市 / 中国"
- `m0_e2e.py` 新增一项：上传一张带 GPS（江川路）的照片，服务端提取元数据后地点是"上海市 闵行区 江川路街道 / 上海市 / 中国"。`m3_standalone.sh` 的全新安装、接管两种情况都会跑到它

## 许可

immich-geodata-cn 是 GPL-3.0：安装包附上许可原文（`licenses/immich-geodata-cn/LICENSE`），打包时留档该 tag 的源码。数据底子是 GeoNames（CC BY 4.0），国内地名由该项目用高德和 Nominatim 生成，见 [LEGAL.md](../LEGAL.md)。

## 升级

已有照片：**管理 → 任务 → 提取元数据 → 全部**。新照片不用。
