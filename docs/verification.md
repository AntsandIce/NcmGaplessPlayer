# 3.x 实测记录

环境：Windows 10 19045 x64 ｜ 网易云音乐 `3.1.42.205594` ｜ BetterNCM `1.3.4` ｜ 本分支

> 摘录时曲目 id 已换成占位符（`<id>`），并去掉了本机路径与账号信息。
> 文中 `[gate]` / `[diag]` 是排查期临时加的诊断日志，**正式版已移除**。

---

## 1. 修掉「跳歌」：事件契约重写前后

### 修前：一次结束推进两首（第二首常常是歌单头）

```
[call] ▶ player.setCurrentPlay ｜ 第 1 次 ｜ args=[<id3>]      ← 正确下一首
[diag] audioplayer.getPlaybackInfo ← 请求 ｜ 距 end 222ms
[call] ▶ player.setCurrentPlay ｜ 第 2 次 ｜ args=[<id1>]      ← 又推一次 = 跳歌
```

某些状态下会演变成 ping-pong（每秒来回切，每切一次都重新 load）：

```
setCurrentPlay → <id3>
setCurrentPlay → <id1>
setCurrentPlay → <id3>
setCurrentPlay → <id1>
```

### 根因（实抓的契约）

原生播放器被插件按住（暂停/未加载），客户端拿**新曲目**的 `playId` 查询时，原生只能回：

```
getPlayedTime   {playId:"<id>_XXXXXX"} → {playedAudioTime:0, playedTime:0, result:false}
getPlaybackInfo {playId:"<id>_XXXXXX"} → {… playedTime:0, playId:"", result:false}
```

`result:false` 的含义是「播放器里没有这首在播」→ 客户端判定该曲目也结束了 → 再推进一次。

### 修后：插件自答 + 只有一次推进

```
23:57:10.760 [end] ★ 自然播完 ｜ 本曲累计播放 12361ms
23:57:10.784 audioplayer.getPlayedTime ★自答(结束窗口内) ｜ <id>_HXPFRF ｜ 171365ms/171365ms
23:57:10.792 audioplayer.getPlaybackInfo ★自答(结束窗口内) ｜ <id>_HXPFRF ｜ 171365ms/171365ms
23:57:10.885 [call] ▶ player.setCurrentPlay ｜ 第 1 次 ｜ args=[<id_next>]   ← 只推一次
```

自答内容：

```jsonc
// getPlayedTime
{ "playedAudioTime": <当前毫秒>, "playedTime": <当前毫秒>, "result": true }

// getPlaybackInfo
{ "playId": "<请求里的 playId>", "playedTime": <当前毫秒>, "playedPercent": <%>,
  "result": true, "deviceAudioFormat": { channels, samplerate, samplesize },
  "playAudioFormat": { … }, "cdnUsed": false, "preloadWholeCached": false, … }
```

不认识的 `playId` 仍然放行给原生（保持原行为）。

---

## 2. 预载：从 0% 成功到 320k

### 修前

```
[preload] 能力探测 ｜ LibEAPIRequest=无 ｜ 请求函数可用=null
[preload] 放弃（不影响播放）｜ track=<id> ｜ n is not a function
```

原因：3.x 上 `LibEAPIRequest` 用源码特征扫描窗口树，命中的 `1368` 其实是 **webpack 模块工厂**，
调用时缺 `__webpack_require__` → `n is not a function`。

### 修后（320k 免签名接口）

```
[preload] LibEAPI 不可用（n is not a function）→ 试 320k 免签名接口
[preload] 320k 接口 ★ br=320000 ｜ size=6620517 ｜ type=mp3
[fetch] ★ 6.31 MB ｜ 2884ms
[preload] ★★ 预载就绪（下一首）｜ track=<id> ｜ 165.5s ｜ 60.59 MB ｜ 耗时 4617ms
```

音质核对：`6,620,517 B / 165.5 s ≈ 320 kbps`（旧兜底 `outer/url`：`2,743,946 B / 171.4 s ≈ 128 kbps`）。

接口对比实测：

| 请求 | 需要签名 | 返回 |
|---|---|---|
| `/api/song/enhance/player/url/v1?ids=[id]&br=320000` | 是 | `{"msg":"参数错误","code":400}` |
| `/weapi/song/enhance/player/url` | 是 | 空响应 |
| **`/api/song/enhance/player/url?ids=[id]&br=320000`** | **否** | `{"data":[{"url":"http://m701.music.126.net/…","br":320000,"size":6859799,…}]}` |
| `/song/media/outer/url?id=<id>.mp3` | 否 | 音频字节（128k） |

---

## 3. 无缝：预约门槛

### 修前：随机播放下一律不预约

```
[gate] sched=- ready=true paused=false stream=true buf=false src=false offNext=false
       cur=<id> next=<id_next> pre=[id=<id_next>,st=ready,why=下一首]
       mode=playrandom streak=0 left=0.59      ← 时间窗命中，仍被模式门槛拒绝
```

### 修后策略

| 播放模式 | 是否预约 |
|---|---|
| `playonce` / `playorder`（顺序、列表循环） | 直接预约 |
| 读不到模式（3.x 某些场景） | 信任「预载槽 == 列表下一首 且 ready」 |
| `playrandom`（随机） | 仅当**上一次「预载下一首」预测命中**（`hitStreak >= 1`） |
| 押错 / 用户拖动 / 换歌单 | 撤销预约（`abortSeam` / `cancelSched`） |

### 参照：2.10.13 上的完整交接（同一份代码，未走 3.x 分支）

```
22:57:12.535 [sched] 预约 ｜ A=<id_a> → B=<id_b> ｜ at=394.628 ｜ 还剩 1.49s ｜ 模式=playonce ｜ 来源=缓冲
22:57:14.018 [end] ★ 自然播完 → 无缝交接 ｜ A=<id_a> → B=<id_b> ｜ 来源=缓冲
22:57:14.131 [call] ▶ audioplayer.load …                ← UI 晚 113ms 才来
22:57:14.132 [sched] 认领 ｜ track=<id_b> ｜ 已在播（不重启）｜ duration=170.38s
22:57:14.134 [play] ★ 无缝认领 → 补发 onPlayState(1)（不重启）
```

---

## 4. 首尾裁剪（v1.2.0 的 P0，v1.2.1 起分层）

### 真机实测结论（v1.2.0 首跑，6 条 `[trim]`）

```
[trim] track=3363273168 ｜ 编码=mp3 ｜ LAME delay=576 pad=864 ｜ 解码器已裁（Δ=0.0ms）
       → 探到的都是作品静音 ｜ 理论=120.000s ｜ 解码=120.000s
       ｜ 填充=首0.0 尾0.0ms（必裁）｜ 作品静音=首0.0 尾40.0ms（不裁，__gpTrimPad 未开）｜ 可听=120.000s
[trim] track=3363273167 ｜ 编码=mp3 ｜ LAME delay=576 pad=1304 ｜ 解码器已裁（Δ=-0.0ms）…
       ｜ 填充=首0.0 尾0.0ms（必裁）｜ 作品静音=首0.0 尾0.0ms（不裁…）｜ 可听=148.960s
```

- **所有曲目 Δ=0.0ms、首=0.0ms** → 这台机器上 Chromium（ffmpeg）**已经把 priming / padding 裁干净了**；
- 唯一那条 `尾=40.0ms` 是**作品自身的静音**（Δ=0 说明填充早已去掉），不是编码器填充；
- 所以 `[trim]` 在这台机器上平时「不裁任何东西」是**正确行为**，不是没生效。

### 两层裁剪

| 层 | 是什么 | 默认 | 日志标记 |
|---|---|---|---|
| 填充 | 编码器/解码器残留的 priming / padding | **必裁** | `填充=首… 尾…ms（必裁）` |
| 作品静音 | 曲子自身首尾的静音（≤40ms） | **不裁** | `作品静音=…（不裁，__gpTrimPad 未开）` |

`Δ=` 是「解码时长 - LAME 理论时长」，用来判断解码器裁没裁：

| Δ | 含义 | 归到哪一层 |
|---|---|---|
| ≈ 0（几毫秒内） | Chromium 已经裁过了 | 探到的静音 → **作品静音** |
| ≈ (delay+padding)/sr | 解码器没裁 | 前一段 → **填充**，剩下的 → 作品静音 |
| 其它 / 没有 LAME 头 | 无法区分 | 按波形裁，每边 ≤20ms（当作填充） |

`编码=flac` → 样本数精确，**一律不裁**（多出来的静音是作者自己的）。

### 怎么判断它生效了

1. **顺序播放**两首接得上的歌（有连续鼓点/尾音的最佳），听接缝；
2. 看 `[sched] 预约` 那一行有没有 `B裁剪=`，以及 `[trim]` 里 `填充=` / `作品静音=` 各是多少；
3. 想确认「是不是插件干的」：
   - `window.__gpTrim = false` —— 完全关掉裁剪；
   - `window.__gpTrimPad = true` —— 连作品静音也削（接缝更紧）。
   两者都**立刻生效**，不用重启。

### 已知不裁的地方

- **流式那一首**：`<audio>` 没法采样级定位，只能按原始时间轴播（日志里不会有它的 `[trim]`）；
- 首尾本来就是音乐（没有静音）的曲目：裁不到东西，这是对的。

---

## 4b. 重复请求 / 重复下载（v1.2.1）

真机日志里能看到三笔浪费，现在都收掉了：

| 日志里长什么样 | 现在 |
|---|---|
| 同一个 id 的 `320k 接口` / `song/detail` **各两遍** | 并发合并成一次（`once()`） |
| 同一首被反复预载（换槽 → 换回来），每次 `[fetch] ★ 5.69 MB` | `[preload] ★ 字节缓存命中 → 跳过取址 + 下载` |
| 切回刚播过的歌还要重新下载 + 解码 | `[preload] ★ 复用刚播过的缓冲（不下载 / 不解码）` |

开关：`window.__gpBytesCache = false` 关掉字节缓存（省内存 / 排查用）。

---

## 4c. 交叉淡入淡出（v1.3.0 的 P2）

### 默认是关的（和 Spotify 出厂一致）

```
[xfade] 交叉淡入淡出=关 ｜ 开启方式：控制台 window.__gpXfade = 3（0~12s，会记住）
```

开起来：控制台敲 `window.__gpXfade = 3`（3 秒等功率交叉）。**会记住**，重启后还在；
`window.__gpXfade = 0` 关掉；`< 0.5s` 视为关；`> 12s` 夹到 12s。

### 日志长什么样

```
[sched] ★ 交叉预约 ｜ A=<id_a> → B=<id_b> ｜ at=197.020 ｜ 还剩 3.20s ｜ 结束 at=200.020
        ｜ 模式=playorder ｜ 来源=缓冲 ｜ B裁剪=首0.0ms 尾0.0ms ｜ 交叉=3.00s（等功率）
[end] ★ 自然播完 → 无缝交接 ｜ A=<id_a> → B=<id_b> ｜ 来源=缓冲 ｜ 交叉=3.00s
```

- `at=197.020` 是 **B 的起播时刻**（= 结束时刻 - 交叉时长），不是结束时刻；
- `结束 at=200.020` 才是切歌时刻（UI 在这一刻推进、`[end]` 在这一刻发）；
- 没开交叉时日志是 `[sched] 预约 … 交叉=关`，`at` 就等于结束时刻（v0.4.1 行为）。

### 怎么判断它生效了

1. 要有**预载命中**（顺序播放 / 列表循环）—— B 必须是缓冲，`<audio>` 没法采样级调度；
2. 日志出现 `★ 交叉预约`，且 `at` 比 `结束 at` 早「交叉时长」；
3. 耳朵上：接缝处不应该有「硬切」，也不应该有音量塌陷（那是线性交叉的毛病）。

### 边界

| 情况 | 行为 |
|---|---|
| 只剩 1s 但设了 12s | 自动缩成 0.95s（`交叉=0.95s`） |
| 暂停 / 拖动 / 押错 | 撤销预约并把增益复位（A→1，B→0），B 被停掉 |
| B 没预载上 | 退回硬接（和 v0.4.1 一样） |
| A 走流式 | A 这一侧的淡出仍然可用（元素也挂了增益） |

---

## 4d. 流式那首补成缓冲（v1.3.1）

1.2.1 的两级缓存只覆盖缓冲路径；`<audio>` 流式播放不产生 `AudioBuffer`，所以
「随机播放听过的歌再切回来」仍要重新拉流。1.3.1 起：

- 流式那一首**真的听了 ≥8 秒**（暂停不计）→ 后台用插件自己的取址链路下一份 + 解码，
  放进「最近缓冲」；
- 之后切回来 → `[preload] ★ 复用刚播过的缓冲（不下载 / 不解码）`，并且**能当交叉的 B**；
- 付费/VIP 的 64s 试听片段**一律拒绝入库**（宁可放弃，也不能下次播半首）；
- 开关：`window.__gpPromote = false`。

日志：

```
[promote] 流式那首已听 9.0s → 后台补成缓冲 ｜ track=<id>
[promote] ★ 已补成缓冲（切回来秒开，也能当交叉的 B）｜ track=<id> ｜ 43.95 MB ｜ 耗时 812ms
[promote] 放弃（不影响播放）｜ track=<id> ｜ 解码时长 64.0s 短于实际 158.6s（试听片段），不补
```

排查提示：只在 `播法=流式` 的曲目上出现；如果一直没看到 `[promote]`，
先看心跳里的 `播法=` 是不是 `缓冲`（缓冲路径本来就不需要补）。

---

## 5. 排查建议

- 关键日志：`[sched] 预约 / 认领`、`[end] ★ 自然播完 → 无缝交接`、`[preload] 320k 接口`、`[nafetch]`。
- 有停顿：
  1. 看 `播法=`：`流式` 表示预载没命中（随机播放或接口失败）→ 用顺序/列表循环复核；
  2. 看有没有 `[sched] 预约`：没有 = 门槛没过（模式 / 预测 / 时间窗）；
  3. 看 `[preload]` 是否出现 `320k 接口`，失败会自动退 128k。
- 一次结束推进两首：确认 `getPlayedTime` / `getPlaybackInfo` 被插件接管（结束窗口内应有「自答」记录）。
- 上线验证：`node test/harness.js` → `通过 393 项，失败 0 项`（含裁剪 81、去重 82、缓存 83、交叉 84、补缓冲 85）。
  变异测试：`node test/mutate.js` → `变异点 84 个，抓住 84 个，漏网 0 个`。