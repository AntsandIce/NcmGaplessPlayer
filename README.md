> 原作者仓库：[Ehytr/NcmGaplessPlayer](https://github.com/Ehytr/NcmGaplessPlayer)

# GaplessPlayer · 网易云 3.1.x 分支

一个 [BetterNCM](https://github.com/std-microblock/BetterNCM) 插件：把「下一首」提前排到「这一首」的
最后一个采样上，切歌间隙压到 **0**。本分支在上游（只支持 2.10.x）基础上加了 **3.1.x 支持**，
并补了首尾裁剪、交叉淡入淡出。

- **真无缝**：`start(when, offset, duration)` 采样级预约，不是「淡入淡出遮缝」
- **首尾裁剪**：MP3 的 priming / padding 按波形验过再裁，接缝连那 ~25ms 静音都不留
- **交叉淡入淡出**：0~12s 等功率（曲线可选 / 可选高通扫频），默认关
- **不重复下载**：下一首提前下好，听过的不再重下、不再重解
- **可观测**：每层都有日志和开关，出问题能定位到底层

## 支持范围

| 客户端 | 支持 | 预载音质 |
|---|---|---|
| 2.10.x | ✅ 上游原样 | 320k |
| **3.1.x** | ✅ 本分支（实测 `3.1.42.205594`，需 BetterNCM 1.3.4） | 320k（拿不到退 128k） |

## 安装

1. 到 **[Releases](https://github.com/AntsandIce/NcmGaplessPlayer/releases)** 下载最新的 `gapless-player-*.plugin`；
2. 放进 `C:\betterncm\plugins\`；
3. 重启网易云。

**建议用带启动参数的快捷方式启动**（否则每次启动都要先点一次播放）：

```
"C:\Program Files (x86)\CloudMusic\cloudmusic.exe" --autoplay-policy=no-user-gesture-required
```

想要**桌面歌词**的话建议一并装 [RuLyric](https://github.com/BetterNCM/RuLyric)：
网易云自带的桌面歌词由原生渲染，插件按住原生播放器后它只剩歌名。

## 开关（控制台一行，立刻生效）

| 开关 | 作用 | 默认 |
|---|---|---|
| `window.__gpXfade = 3` | 交叉淡入淡出时长（0~12s，**会记住**） | 关 |
| `window.__gpXfadeCurve = "s-line"` | 交叉曲线：`equal` / `linear` / `s-line` / `r_s-line` / `exp` / `step` | `equal` |
| `window.__gpXfadeEq = true` | 交叉时高通扫频（20→900Hz） | 关 |
| `window.__gpTrimPad = true` | 连「作品静音」也裁（接缝更紧） | 关 |
| `window.__gpTrim = false` | 完全关掉首尾裁剪 | 开 |
| `window.__gpPromote = false` | 不把流式那首补成缓冲（省流量） | 开 |
| `window.__gpCache` / `window.__gpBytesCache = false` | 关全部缓存 / 只关字节缓存（省内存） | 开 |
| `window.__gpSeamless = false` | 关掉采样级预约（退回等 UI） | 开 |
| `window.__gpStream = false` | 强制走缓冲路径（排查跨域静音用） | 开 |
| `window.__gpNativeAll = true` | 播放整条交回原生播放器（逃生） | 关 |
| `window.__gpProbe = true` | automix 探针（诊断用，见 Releases 说明） | 关 |

## 已知限制

- **随机播放无法稳定无缝**：客户端切歌前约 80ms 才决定下一首，插件只能「押」
  （间隙已从约 0.5s 压到约 0.2s）。要 0 间隙请用**顺序播放 / 列表循环**。
- **交叉默认关**，且 B 必须是已预载的缓冲 —— 随机播放时基本不会出现。
- **Automix（接拍过渡）暂未实现**：实测 3.1.42 客户端里它的决策层是悬空的（无消费者、无分析数据源），
  详情见 [v1.3.2 的 Release 说明](https://github.com/AntsandIce/NcmGaplessPlayer/releases/tag/v1.3.2)。
- **流式那一首不做首尾裁剪**（`<audio>` 没有采样级定位）；无 LAME 头的 MP3 只能按波形裁，每边 ≤20ms。
- **内存 / 流量**：最近缓冲最多留 2 首（≤160MB）；流式曲目听够 8s 会补一份（~6MB/首）。都可用开关关掉。
- **320k 依赖旧版免签名接口**，可能被网易云关掉；关掉后自动退 128k，不影响播放。
- 付费/VIP 曲目若无权限，接口只给试听片段 → 这类曲目没有无缝（仍能完整播放）。
- 插件依赖客户端内部接口（`channel.call` / `legacyNativeCmder`），**客户端升级可能失效**。

## 版本与更新日志

每个版本的详细改动（含真机日志、设计取舍、验证数字）都在
**[Releases](https://github.com/AntsandIce/NcmGaplessPlayer/releases)**。

- 开发过程与「为什么这么做」：[docs/DEVLOG.md](docs/DEVLOG.md)
- 真机实测记录与排查手册：[docs/verification.md](docs/verification.md)
- 运行日志：`C:\betterncm\gapless-player.log`
