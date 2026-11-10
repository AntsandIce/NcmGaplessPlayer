# GaplessPlayer 一键安装

双击 **`安装 GaplessPlayer.cmd`** 即可。

它会按顺序做四件事：

1. 找到网易云音乐的安装目录（运行中的进程 / 卸载注册表 / 常见路径）；
2. 如果没装 BetterNCM：从 [std-microblock/chromatic](https://github.com/std-microblock/chromatic)
   下载对应架构的 DLL（x64 用 `BetterNCMII.dll`、x86 用 `BetterNCMII86.dll`），
   改名成 `msimg32.dll` 放进网易云目录；
3. 把 `gapless-player-*.plugin` 复制进 BetterNCM 的数据目录（`C:\betterncm\plugins`
   或 `%USERPROFILE%\betterncm\plugins`，自动判断）；
4. 关闭并重新启动网易云（可用 `-NoRestart` 关掉）。

## 需要管理员权限

写网易云安装目录要管理员。双击 `.cmd` 后脚本会自己提权（UAC 点“是”）。

## 可选参数

```powershell
# 只看要做什么，不下载不写文件
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun

# 手动指定网易云目录 / 插件文件
powershell -ExecutionPolicy Bypass -File .\install.ps1 -CloudMusicPath "D:\CloudMusic"
powershell -ExecutionPolicy Bypass -File .\install.ps1 -PluginPath ".\gapless-player-1.20.0.plugin"

# 已装 BetterNCM 但想重装（会备份旧的 msimg32.dll）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ForceBetterNcm

# 让 BetterNCM 官方安装器来装（GUI，兼容性由它判断；3.x 客户端推荐）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -UseOfficialInstaller

# 装完不自动启动网易云
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoRestart
```

## 说明

- 插件优先用本目录里的 `*.plugin`（离线可用）；没有才去 GitHub Releases 下载最新版。
- 安装日志写到 `%TEMP%\gapless-player-install.log`。
- BetterNCM 要求网易云 **≥ 2.10.2**；版本太低脚本会提示。
- 默认走「下载官方 DLL → 改名 msimg32.dll」的直装法；3.x 客户端如果重启后没出现插件管理器，
  改用 `-UseOfficialInstaller` 让官方安装器判断兼容版本。
- 装完在网易云「设置 → BetterNCM」里应能看到 **GaplessPlayer**。
