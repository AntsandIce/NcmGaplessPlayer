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

## 4. 排查建议

- 关键日志：`[sched] 预约 / 认领`、`[end] ★ 自然播完 → 无缝交接`、`[preload] 320k 接口`、`[nafetch]`。
- 有停顿：
  1. 看 `播法=`：`流式` 表示预载没命中（随机播放或接口失败）→ 用顺序/列表循环复核；
  2. 看有没有 `[sched] 预约`：没有 = 门槛没过（模式 / 预测 / 时间窗）；
  3. 看 `[preload]` 是否出现 `320k 接口`，失败会自动退 128k。
- 一次结束推进两首：确认 `getPlayedTime` / `getPlaybackInfo` 被插件接管（结束窗口内应有「自答」记录）。
- 上线验证：`node test/harness.js` → `通过 291 项，失败 0 项`（与上游基线一致）。