> 原作者仓库：[Ehytr/NcmGaplessPlayer](https://github.com/Ehytr/NcmGaplessPlayer)

# GaplessPlayer · 网易云 3.1.x 分支

一个 [BetterNCM](https://github.com/std-microblock/BetterNCM) 插件：把「下一首」提前排到「这一首」的
最后一个采样上，切歌间隙压到 **0**。本分支在上游（只支持 2.10.x）基础上加了 **3.1.x 支持**，
并补了首尾裁剪、交叉淡入淡出。

- **真无缝**：`start(when, offset, duration)` 采样级预约，不是「淡入淡出遮缝」
- **首尾裁剪**：MP3 的 priming / padding 按波形验过再裁，接缝连那 ~25ms 静音都不留
- **过渡风格**：干净 / 轻过渡 / DJ 三档，**按播放模式自动选**（也可手动改）
- **拍点对齐**：自带 BPM/拍点分析，交叉起点与 B 的入点都落在拍上（不做变速，不改变音高）
- **不重复下载**：下一首提前下好，听过的不再重下、不再重解；没下完时先预开流，接缝不留长空档
- **有界面**：右下角「♪」→ 设置面板（分段控件 / 拨动开关）；一行状态告诉你现在谁在播、过渡怎么定的

## 支持范围

| 客户端 | 支持 | 预载音质 |
|---|---|---|
| 2.10.x | ✅ 上游原样 | 320k |
| **3.1.x** | ✅ 本分支（实测 `3.1.42.205594`，需 BetterNCM 1.3.4） | 320k（拿不到退 128k） |

## 安装

1. 到 **[Releases](https://github.com/AntsandIce/NcmGaplessPlayer/releases)** 下载最新的 `gapless-player-*.plugin`
   （同一个 Release 里还附带可选依赖 **`LibEAPIRequest.plugin`**，建议一起下）；
2. 两个 `.plugin` 都放进 `C:\betterncm\plugins\`；
3. 重启网易云。

装好之后不用点播放、不用改快捷方式：插件会自己接管。**右下角「♪」** 打开设置面板。

关于 `LibEAPIRequest`：它是取址/预载用的依赖。**不装也能播**，但 2.10.x 上会取不到地址 →
退化成纯流式（没有预载、也就没有采样级接缝）；3.1.x 有免签名接口兜底，不装也能预载。

想要**桌面歌词**的话建议一并装 [RuLyric](https://github.com/BetterNCM/RuLyric)：
网易云自带的桌面歌词由原生渲染，插件按住原生播放器后它只剩歌名。

## 过渡风格（推荐先看这个）

面板里三选一，**默认按播放模式自动选**：

| 风格 | 实际是 | 什么时候会自动选它 |
|---|---|---|
| 干净 | 0s，采样级无缝 | 顺序 / 列表循环 / 单曲循环（专辑连听不该交叉） |
| 轻过渡 | 2.5s 等功率 | 随机播放 / 心动模式 |
| DJ | 3s + 高通扫频 + s 曲线 | 手动选 |

手动选过就**记住**（重启仍在）；想回到自动：控制台 `gaplessPlayer.setStyle(...)` 或直接在面板里切。
显式设过时长（`__gpXfade`）优先级最高，不会被风格覆盖。

**拍点对齐**：有交叉时，插件会自己算两首歌的 BPM 与拍点（分析的是已经解码好的缓冲，
不额外下载），然后做两件事：

1. **交叉起点**吸到 A 的最近一拍（偏移 ≤ 半拍）；
2. 给 **B 选入点**：跳过它开头的空白/留白，落在第一拍上（最多跳 6 秒，超了就老实从 0 开始）；
   **干净风格（0s 交叉）也会跳过开头空白**，只是不做拍点对齐 —— 免得接缝处留个 1~2 秒的洞。

两首 BPM 八度折算后偏差 >6% 就不硬对齐（拍点本来就不同步）。**不做变速**，所以音高不会被改。

## 开关（控制台一行，立刻生效）

| 开关 | 作用 | 默认 |
|---|---|---|
| `window.__gpStyle = "light"` | 过渡风格：`clean` / `light` / `dj`（会记住） | **智能** |
| `window.__gpXfade = 3` | 直接指定交叉时长（0~12s，会记住，**优先级最高**） | — |
| `window.__gpXfadeCurve` / `__gpXfadeEq` | 曲线 / 高通扫频（风格已包含，一般不用手动） | 跟随风格 |
| `window.__gpTrim = false` | 完全关掉首尾裁剪 | 开 |
| `window.__gpAutoMix = false` | 关掉拍点对齐（不分析、不对齐） | 开 |
| `window.__gpPromote = false` | 不把流式那首补成缓冲（省流量） | 开 |
| `window.__gpCache` / `window.__gpBytesCache = false` | 关全部缓存 / 只关字节缓存（省内存） | 开 |
| `window.__gpSeamless = false` | 关掉采样级预约（退回等 UI） | 开 |
| `window.__gpStream = false` | 强制走缓冲路径（排查跨域静音用） | 开 |
| `window.__gpNativeAll = true` | 播放整条交回原生播放器（逃生） | 关 |
| `window.__gpProbe = true` | automix 探针（诊断用，见 Releases 说明） | 关 |

也可以用脚本接口（面板就是用它们）：

```js
gaplessPlayer.status()          // 一行状态
gaplessPlayer.setStyle("dj")    // 切风格
gaplessPlayer.xfade()           // {sec, curve, eq, source}
gaplessPlayer.clearCache()      // 清缓存
gaplessPlayer.openPanel()       // 开/关面板
```

## 已知限制

- **拍点对齐不做变速**：只对齐「A 的交叉起点」和「B 的入点」，**不会**把两首拉成同一 BPM
  （那要时间拉伸，Web Audio 的 `playbackRate` 会变调）。没鼓点 / 自由节奏 / 置信度低时不硬贴，
  自动退回普通交叉。
- **Automix 目前是「无变速版」**：拍点分析（BPM/锚点）+ 交叉起点对齐 + B 入点已经做了；
  还差 **tempo 对齐**（±6% 变速对拍，需要 WSOLA 这类保音高拉伸）。
  另外实测 3.1.42 客户端自带的 automix 决策层是悬空的（没有消费者、也没有分析数据源），
  所以这块只能自己算 —— 背景见 [v1.3.2 的 Release 说明](https://github.com/AntsandIce/NcmGaplessPlayer/releases/tag/v1.3.2)。
- **B 没缓冲完就一定没有无缝**：采样级接缝只认完整的解码缓冲（Web Audio 没有流式 buffer 源）。
  这一版会把 B 的流提前预开，把没有预载时的空档从约 500ms 压短，但**不等于无缝**。
- **随机播放无法稳定无缝**：客户端切歌前约 80ms 才决定下一首，插件只能「押」
  （间隙已从约 0.5s 压到约 0.2s）。要 0 间隙请用**顺序播放 / 列表循环**。
- **交叉与拍点对齐需要 B 是缓冲**：随机播放时预载命中率低，交叉也会少出现；
  不过流式那首听够 8 秒会被补成缓冲（v1.3.1），再回到它时就能参与交叉。
- **不装 `LibEAPIRequest.plugin`**：2.10.x 上取不到地址 → 没有预载、没有采样级接缝（仍能播）；
  3.1.x 有免签名接口兜底，不受影响。
- **流式那一首不做首尾裁剪**（`<audio>` 没有采样级定位）；无 LAME 头的 MP3 只能按波形裁，每边 ≤20ms。
- **内存 / 流量**：最近缓冲最多留 2 首（≤160MB）；流式曲目听够 8s 会补一份（~6MB/首）。都可用开关或面板关掉。
- **320k 依赖旧版免签名接口**，可能被网易云关掉；关掉后自动退 128k，不影响播放。
- **本次启动的第一首是原生播的**：那首没有无缝/交叉，点击任意位置后接管（autoplay 策略所限）。
- 付费/VIP 曲目若无权限，接口只给试听片段 → 这类曲目没有无缝（仍能完整播放）。
- 插件依赖客户端内部接口（`channel.call` / `legacyNativeCmder`），**客户端升级可能失效**。

## 版本与更新日志

每个版本的详细改动（含真机日志、设计取舍、验证数字）都在
**[Releases](https://github.com/AntsandIce/NcmGaplessPlayer/releases)**。

- 开发过程与「为什么这么做」：[docs/DEVLOG.md](docs/DEVLOG.md)
- 真机实测记录与排查手册：[docs/verification.md](docs/verification.md)
- 运行日志：`C:\betterncm\gapless-player.log`
