> 原作者仓库：https://github.com/Ehytr/NcmGaplessPlayer

# GaplessPlayer · 网易云 3.1.x 分支

BetterNCM 插件：把「下一首」提前排到「这一首」的最后一个采样上，切歌间隙压到 0；
在它之上再补了 **首尾裁剪**（MP3 priming/padding）和 **等功率交叉淡入淡出**（0~12s，可选）。
本分支在上游（只支持 2.10.x）基础上新增 **3.1.x** 支持，2.10.x 行为与上游保持一致。

## 分支支持范围

| 客户端 | 支持 | 预载音质 | 说明 |
|---|---|---|---|
| 2.10.x | ✅ 上游原样 | 320k | 3.x 相关代码全部由 `isNcm3()` 门控，走不到 |
| **3.1.x** | ✅ **本分支新增**（实测 `3.1.42.205594`） | **320k**（拿不到时退 128k） | 需 BetterNCM 1.3.4 |
| 3.0.x | ⚠️ 未专门测试 | — | 补丁以 `APP_CONF.appver` 是否以 `3.` 开头为开关 |

安装：从 [Releases](https://github.com/AntsandIce/NcmGaplessPlayer/releases) 下载最新的
`gapless-player-1.3.1.plugin` → 放进 `C:\betterncm\plugins\` → 重启网易云。

## 版本一览

| 版本 | 要点 |
|---|---|
| **1.3.2** | 交叉曲线可选（对齐 `crossfade_line`）+ 可选高通扫频 + automix 探针（`window.__gpProbe`） |
| **1.3.1** | 流式听过的歌**补成缓冲**：切回来不重新拉流，也能当交叉的 B |
| 1.3.0 | **等功率交叉淡入淡出** 0~12s（默认关，`window.__gpXfade`） |
| 1.2.1 | 裁剪分层（填充必裁 / 作品静音默认不裁）+ 并发去重 + 字节缓存 / 最近缓冲 |
| 1.2.0 | **首尾裁剪**：MP3 priming / padding，接缝连那 ~25ms 静音也不留 |
| 1.1.0 | 3.1.x 适配（本分支起点） |

3.x 建议用**带启动参数**的快捷方式启动（否则每次启动都要先点一次播放）：

```
"C:\Program Files (x86)\CloudMusic\cloudmusic.exe" --autoplay-policy=no-user-gesture-required
```

实测加上这个参数后 `AudioContext` 一启动就是 `running`，全局热键也能直接起播，不再需要点鼠标。

想要**桌面歌词**的话，建议一并装 [RuLyric](https://github.com/BetterNCM/RuLyric)（同样放进 `C:\betterncm\plugins\`）——
网易云自带的桌面歌词由原生渲染，插件按住原生播放器后只能显示歌名（见「已知限制」）。

## 1.2.0 新增：首尾裁剪（P0）

MP3 是有损帧格式：编码器会在**开头补一段静音**（priming / encoder delay）、在**结尾补填充**（padding）。
解码出来是「静音 + 音乐 + 静音」，两首直接首尾相接，接缝处就还多出 ~25ms 空白 ——
这是「真无缝」的最后一段。1.2.0 起把它也削掉：

| 做法 | 说明 |
|---|---|
| 解析 | MP3 读 Xing/LAME 头里的 `delay` / `padding`；FLAC 读 STREAMINFO 的精确样本数 |
| **不硬裁** | 用解码后的波形自己验：**只裁真静音**（\|x\| < -80dBFS）。因为 Chromium 底层是 ffmpeg，**它可能已经裁过了** —— 照声明值硬裁会把真音乐切掉 |
| 封顶 | 每边最多 40ms（有 LAME 头）/ 20ms（没有 LAME 头）；**FLAC 不裁**（样本精确，多出来的是作者自己的静音） |
| 应用 | 起播和「预约下一首」都走裁剪后的时间轴：`start(when, offset, duration)`，上一首的最后一个**可听**采样 → 下一首的**第一个**可听采样 |
| 可观测 | 日志多一行 `[trim]`，其中 `Δ=` 就是「解码器到底裁没裁」的证据（Δ≈0 = 它已裁过；Δ≈delay+padding = 没裁） |
| 逃生开关 | 控制台 `window.__gpTrim = false`，**立刻生效**，不用出包 |

## 1.2.1：分层裁剪 + 去掉重复请求 / 重复下载

### 裁剪分两层（真机日志得出的结论）

实测（`C:\betterncm\gapless-player.log`）显示这台机器上 **Chromium 底层的 ffmpeg 已经把
MP3 的 priming / padding 裁干净了**：所有曲目 `Δ=0.0ms`、`首=0.0ms`。也就是说
「照 LAME 声明值硬裁」会切掉每首 13ms 的真音乐，而波形里还能探到的静音属于**作品自己**。

于是 1.2.1 把裁剪拆成两层：

| 层 | 内容 | 默认 |
|---|---|---|
| **填充** | 编码器/解码器残留的 priming / padding | **必裁**（接缝处不能有空白） |
| **作品静音** | 曲子自身首尾的静音（≤40ms） | **不裁**（Spotify 的 gapless 也只管填充） |

想要「连作品静音也削掉、接缝更紧」→ 控制台 `window.__gpTrimPad = true`（立刻生效）。
日志会把两笔分开写：`填充=首… 尾…ms（必裁）｜ 作品静音=首… 尾…ms（不裁，__gpTrimPad 未开）`。

### 两笔浪费（真机日志里看到的）

| 现象 | 修法 |
|---|---|
| 同一个 id 的 `player/url` 与 `song/detail` **各打两遍**（`setCurrentPlay` 抢着解析 + 预载又解析） | 并发合并（`once()`）：同一个 key 的请求只发一次，失败也立即清掉，不会把一次失败记成永久结论 |
| 同一首被反复预载（换槽 → 换回来），每次白下 5~6MB + 重解 ~600ms | ① **字节缓存**（最多 3 份，约 6MB/份）：跳过取址 + 下载；② **最近缓冲**（最多 2 首，合计 ≤160MB）：切回刚播过的歌时连解码都省掉 |

开关：`window.__gpBytesCache = false` 关掉字节缓存（省内存 / 排查用）。

## 1.3.0：交叉淡入淡出（P2，等功率，0~12s）

Spotify 的 crossfade 有两个要点：**等功率曲线**（不是线性）+ **0~12s 可调**。这里照做，
**默认关**（跟 Spotify 出厂一致：只做 gapless）。开启后：

```js
window.__gpXfade = 3   // 3 秒等功率交叉（< 0.5s 视为关，上限 12s；会记住，重启后还在）
window.__gpXfade = 0   // 关（默认）
```

| 做法 | 说明 |
|---|---|
| 等功率 | 淡出 `cos(θ·π/2)`、淡入 `sin(θ·π/2)`：中点各 -3dB、功率之和恒定。线性交叉中点会「塌一下」 |
| 提前起播 | B 不再排在 A 的结束采样上，而是提前 `xf` 秒起播；A 的 `onended` 仍是「切歌时刻」（UI 就在这一刻推进） |
| 独立增益 | 每个 source、以及流式元素，都各有一层自己的 gain，曲线只打在这层上 —— **绝不动主音量**（`S.gain` 是用户音量条） |
| 窗口自适应 | 3s 的交叉必须提前 3s 排 → 预约窗口从固定 1.5s 变成 `max(1.5, xf+0.4)`；只剩 1s 时自动缩短成 0.95s |
| 撤销复位 | 暂停 / 拖动 / 押错撤销时把 A 的增益拉回 1、B 拉回 0（否则 A 会一直留在小声） |
| 上限 | 12s；不足 0.5s 视为关（还不如硬接） |

日志：

```
[sched] ★ 交叉预约 ｜ A=<id_a> → B=<id_b> ｜ at=197.020 ｜ 还剩 3.20s ｜ 结束 at=200.020
        ｜ 模式=playorder ｜ 来源=缓冲 ｜ B裁剪=首0.0ms 尾0.0ms ｜ 交叉=3.00s（等功率）
```

边界：**B 必须已经预载成缓冲**才有交叉（`<audio>` 没法采样级调度）——没有预载就退回硬接，
和 v0.4.1 的行为一致；A 走流式时，A 这一侧的淡出仍然可用（元素也挂了增益）。

## 1.3.1：把「流式听过的歌」也补成缓冲

1.2.1 的两级缓存（字节缓存 / 最近缓冲）只在**缓冲路径**上生效 —— 而 `<audio>` 流式播放
**不产生 AudioBuffer**，元素被切走后什么都不剩。结果是「随机播放听过的歌再切回来」
还要从头拉一遍流（1~3s），也永远当不了交叉的 B。1.3.1 补上：

| 做法 | 说明 |
|---|---|
| 触发条件 | 这首**真的听了 ≥8 秒**（暂停不计）才补 —— 路过一首不为它付下载 |
| 做什么 | 后台用插件自己的取址链路下一份 + 解码，塞进「最近缓冲」（不碰预载槽） |
| 代价 | 一次 ~6MB 下载（这份内容本来也会被重放一遍）+ 一位缓冲内存 |
| 校验 | **和预载同一套试听校验**：付费/VIP 曲目只给 64s 片段 → 宁可放弃，也不把「半首」塞进缓存 |
| 开关 | `window.__gpPromote = false` |

日志：

```
[promote] 流式那首已听 9.0s → 后台补成缓冲 ｜ track=<id>
[promote] ★ 已补成缓冲（切回来秒开，也能当交叉的 B）｜ track=<id> ｜ 43.95 MB ｜ 耗时 812ms
```

补完之后，这首再切回来会命中 `[preload] ★ 复用刚播过的缓冲（不下载 / 不解码）`，
并且**可以当交叉的 B** 了（之前流式播过的歌做不到）。

## 1.3.2：交叉曲线可选 + 高通扫频 + automix 探针

### 交叉曲线（名字对齐客户端的 `crossfade_line` 枚举）

```js
window.__gpXfadeCurve = "equal"    // 默认：等功率（中点 -3dB）
window.__gpXfadeCurve = "linear"   // 线性（中点 -6dB，会塌一下，仅对比用）
window.__gpXfadeCurve = "s-line"   // smoothstep
window.__gpXfadeCurve = "r_s-line" // 端部更陡的 S
window.__gpXfadeCurve = "exp"      // 指数
window.__gpXfadeCurve = "step"     // 硬切式
```

名字故意和客户端 automix 的 `crossfade_line` 一致 —— 哪天能拿到它算好的计划，
`crossfade_line` 可以**直接透传**进来，不用再翻译一层。

### 高通扫频（DJ 过渡的招牌手法）

```js
window.__gpXfadeEq = true   // 默认关：会明显改变音色，得你说了算
```

交叉期间把**出场的 A** 从 20Hz 高通扫到 900Hz，把低频让给 B。
链路里给每个 source / 流式元素都常驻插了一个高通（平时 20Hz ≈ 直通，不改音色），
所以扫频是**零爆音**的 —— 不用断开正在响的节点再重连。

### automix 探针：为什么 P3 暂时没法「直接复用客户端」

实测（3.1.42.205594）：渲染层里有一整套 automix **决策库**（`AutomixEffectConfig0922` AB 实验、
`mix_strategy` / `crossfade_start_time` / `eq_type` / `tempo_values` 计划骨架、五种策略），
但**原生模块里一个计划字段都没有**（`mix_params` / `r_s-line` / `strategy_rhythm` 全 0 命中），
而且**除它自己那个 bundle 之外没有任何 chunk 引用它** —— 决策层目前是「悬空」的。

`window.__gpProbe = true` 会记录（只记录、不干预）：

- `abtest.getList` 的请求与回应（看 `AutomixEffectConfig0922` 有没有下发）；
- `audioplayer.*` 的**参数键名**：形状一变就打 `★ 形状变了`（比如突然多出 `mix_strategy`）；
- 没见过的命令名（比如 `audioplayer.setMixPlan`）。

这三条任意一条命中，就说明客户端把 automix 接上了 —— 那时再走「复用它的计划」这条路。

## 修了什么（相对上游 1.0.0）

| # | 现象 | 原因 / 修法 |
|---|---|---|
| 1 | BetterNCM 直接跳过插件，装了也不出现 | 3.x 只加载 manifest 里声明 `"ncm3-compatible": true` 的插件 → 补上该字段 |
| 2 | 预载永远失败：`[preload] 放弃 ｜ n is not a function` | `LibEAPIRequest` 靠扫描窗口函数源码定位请求函数，3.x 上第一个命中（id `1368`）是 **webpack 模块工厂**，缺 `__webpack_require__` 无法调用 → 改为插件自带取址链路 |
| 3 | 快播完时**跳一首**（严重时会跳回歌单头、两首之间 ping-pong） | 客户端推进后会拿**新曲目**的 `playId` 问 `audioplayer.getPlayedTime` / `getPlaybackInfo`；原生播放器被插件按住，只回 `{playedTime:0, result:false}` → 客户端判定"这首也播完了"再推一次。现由插件按自己引擎的真实状态自答这两个查询 |
| 4 | `[sched] 预约` 从不出现，完全没有无缝 | 3.x 报 `mode=playrandom`，上游对非顺序模式一律不预约。现在：顺序/列表循环直接预约；随机模式下**上一次预载预测命中**也允许预约，押错由 `abortSeam()` / `cancelSched()` 撤销 |
| 5 | 预载只有 128k | 3.x 的签名接口（`/player/url/v1`、`/weapi/...`）都返回 400 → 改用旧版免签名接口 `/api/song/enhance/player/url?br=320000`，经客户端原生网络层请求，自动带登录 cookie |
| 6 | 部分曲目「加载失败」 | 3.x 的 `musicurl` 是**加密 token**（不是 URL），少数曲目会让 `<audio>` 报 `MEDIA_ELEMENT_ERROR: Format error` → 出错时用自有地址重试一次，两次都失败才报错 |
| 7 | 付费/VIP 曲目在 64 秒处突然断掉 | 免签名接口对这类曲目只给**试听片段**。现用 `song/detail` 的权威时长校验（`size/br` 估算 + 解码时长双向比对），片段一律丢弃 → 退回不预载，由客户端播完整曲目 |
| 8 | 随机播放切歌有明显停顿（没有预载可命中） | 随机模式下客户端切歌前约 80 ms 才决定下一首，只能靠流式接力。现在收到 player.setCurrentPlay（比 load 早约 80–110 ms）就先预解析 320k 地址：地址已到手就直接起播，媒体错误重试也复用同一结果，间隙由约 0.5 s 压到约 0.2 s |

## 已知限制

- **随机播放无法稳定无缝**：客户端切歌前约 80 ms 才决定下一首，插件只能"押"。现在拿到 `setCurrentPlay` 就预解析地址、失败重试也复用该结果，间隙已从约 0.5 s 压到约 0.2 s；要 0 间隙请用**顺序播放 / 列表循环**。
- **流式那一首不做首尾裁剪**：`<audio>` 没法采样级定位，只能按原始时间轴播（缓冲路径才裁）。
- **没有 LAME 头的 MP3**（二次转码过）只能按波形裁，每边最多 20ms。
- **内存**：会额外留住「最近播过的 2 首」的播放缓冲（合计 ≤160MB，超了自动丢最旧的）。
  想省内存：`window.__gpBytesCache = false` 只关字节缓存；`window.__gpCache = false` 连最近缓冲一起关。
- **补缓冲要一次额外下载**：流式那首听够 8 秒后会在后台下一份（~6MB），换来切回来秒开。
  不想付这份流量：`window.__gpPromote = false`。
- **作品静音默认不裁**：`window.__gpTrimPad = true` 才连它一起削（更紧，但会切掉 ≤40ms 的作品静音）。
- **交叉默认关**：`window.__gpXfade = 3` 打开（0~12s，会记住）。B 必须是缓冲，
  所以随机播放（预载命中率低）时交叉基本不会出现。曲线用 `window.__gpXfadeCurve`，
  高通扫频用 `window.__gpXfadeEq = true`。
- **Automix 暂时做不了**（实测本机 3.1.42 的决策层是悬空的，详见 1.3.2 一节）。
  打开 `window.__gpProbe = true` 可以盯着它哪天被接上。
- **不带启动参数时需要点一次播放**：改用上面的 `--autoplay-policy=no-user-gesture-required` 启动参数后已不需要（已在 3.1.42 实测：`AudioContext` 启动即 `running`）。
- **桌面歌词只剩歌名**：应用内歌词页正常（跟着插件伪造的进度滚），但 3.x 的**桌面歌词由原生渲染**，插件把原生播放器按住后它拿不到播放位置。实测"把位置喂回原生"无效（原生暂停时根本不推进渲染）。需要桌面歌词请用 [RuLyric](https://github.com/BetterNCM/RuLyric) 等第三方自绘方案。
- **320k 依赖旧版免签名接口**，它随时可能被网易云关闭；关掉后自动退 128k 无缝，不影响播放。
- 付费/VIP 曲目若无权限，接口只会给试听片段 → 这类曲目没有无缝（仍能完整播放）。
- 插件依赖客户端内部接口（`channel.call` / `legacyNativeCmder`），**客户端升级随时可能失效**。
- 日志：`<BetterNCM profile>\gapless-player.log`（默认 `C:\betterncm\`）。
