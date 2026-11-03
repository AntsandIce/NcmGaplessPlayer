> 原作者仓库：https://github.com/Ehytr/NcmGaplessPlayer

# GaplessPlayer · 网易云 3.1.x 分支

BetterNCM 插件：把「下一首」提前排到「这一首」的最后一个采样上，切歌间隙压到 0。
本分支在上游（只支持 2.10.x）基础上新增 **3.1.x** 支持，2.10.x 行为与上游保持一致。

## 分支支持范围

| 客户端 | 支持 | 预载音质 | 说明 |
|---|---|---|---|
| 2.10.x | ✅ 上游原样 | 320k | 3.x 相关代码全部由 `isNcm3()` 门控，走不到 |
| **3.1.x** | ✅ **本分支新增**（实测 `3.1.42.205594`） | **320k**（拿不到时退 128k） | 需 BetterNCM 1.3.4 |
| 3.0.x | ⚠️ 未专门测试 | — | 补丁以 `APP_CONF.appver` 是否以 `3.` 开头为开关 |

安装：从 Release 下载 `gapless-player-1.1.0.plugin` → 放进 `C:\betterncm\plugins\` → 重启网易云。

3.x 建议用**带启动参数**的快捷方式启动（否则每次启动都要先点一次播放）：

```
"C:\Program Files (x86)\CloudMusic\cloudmusic.exe" --autoplay-policy=no-user-gesture-required
```

实测加上这个参数后 `AudioContext` 一启动就是 `running`，全局热键也能直接起播，不再需要点鼠标。

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

## 已知限制

- **随机播放无法稳定无缝**：客户端切歌前约 80 ms 才决定下一首，插件只能"押"。现在拿到 `setCurrentPlay` 就预解析地址、失败重试也复用该结果，间隙已从约 0.5 s 压到约 0.2 s；要 0 间隙请用**顺序播放 / 列表循环**。
- **不带动画参数启动时需要点一次播放**：改用上面的 `--autoplay-policy=no-user-gesture-required` 启动参数后已不需要（本轮已实测）。
- **网易云原生歌词会失效**（插件接管了播放链），可换用 [RuLyric](https://github.com/BetterNCM/RuLyric) 等第三方歌词。
- **320k 依赖旧版免签名接口**，它随时可能被网易云关闭；关掉后自动退 128k 无缝，不影响播放。
- 付费/VIP 曲目若无权限，接口只会给试听片段 → 这类曲目没有无缝（仍能完整播放）。
- 插件依赖客户端内部接口（`channel.call` / `legacyNativeCmder`），**客户端升级随时可能失效**。
- 日志：`<BetterNCM profile>\gapless-player.log`（默认 `C:\betterncm\`）。
