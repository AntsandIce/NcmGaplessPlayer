# GaplessPlayer 开发日志（0.1.0 → 1.8.0）

> 面向使用者的安装与使用说明见 [README](../README.md)。

---

## ★ v1.8.0 —— 把 1.6/1.7 引入的 10 个问题收尾（含两条**被数据否定**的尝试）

做完 A/B/C 之后，我自己列了 10 个「新引入的问题」（#9~#18）。这一版逐条处理，
其中有两条**没能修成** —— 这里如实记下来，比假装修好更重要。

### #9 拉伸段与接续段的接缝 —— 先纠正我自己的判断

我原先写「接缝可能早 70ms」。**实测证明那是测试写错了**：我在验证台里拿硬编码的 3s 去比，
而实际的 `fadeSec` 会被「拍点对齐」微调成 2.9266s —— 拉伸段长度本来就跟它一致，
接缝一直落在 A 的结束时刻（`at + dur == endCtxTime`，误差 < 1ms）。

仍然做了一处**稳健性加固**：WSOLA 多取 0.25s 余量，再把输出**裁到正好 `fadeSec`**，
这样接缝不依赖「比例取整恰好相等」这个巧合。

### #10 头尾 BPM 不一致的曲子不再被判死

之前 `reconcileTempo` 把置信压到 0.15 → 那首歌此后再也不参与贴拍/拉伸。
现在改成：**BPM 用头窗，末拍位置也用「头窗锚点 + 头窗拍长」外推到结尾**，置信只打 0.85 折
（下限 0.2）。于是它仍然能参与对齐，只是不如头尾一致的歌那么硬。

### #11 BPM 对弱鼓点不敏感 —— **尝试两次，都被数据否掉**

- **多频带 onset**（加了 ~120Hz 低通一路，两路归一化后相加）：实测无改善 ——
  底鼓 0.95→0.95，慢起音弱鼓 0.84→0.82。原因是 200Hz 高通之后**鼓点的攻击瞬态仍然主导通量**，
  低频那一路只是冗余。→ **已回滚**。
- **半窗重试**（整窗置信低时拆两半再算）：在合成材料上根本触发不了（整窗置信一直接近 1），
  拿不到任何改善证据。→ **已回滚**（不留无法验证的复杂度）。

真机上看到的「尾窗 0.33」更可能是**尾窗那段没有稳定鼓点**，这个情形由 #10 覆盖了。
所以 #11 的结论是：**没有可验证的改法，不改**。

> 已知限制（沿用旧算法）：纯合成鼓组会落到 2/3 倍速（128 测成 84.6）。
> 真实曲目里这种歧义也偶发，属于 onset 自相关方法本身的局限。

### #12 交叉 >8s 也能拉伸

上限 8s → **12s**。实测（48kHz 立体声）：8s ≈ 91ms、12s ≈ 137ms，仍然落在「还剩 1.5~3 秒」
的调度窗口里。

### #13 长交叉 + 置信一般 → 不拉

比例误差在长窗口里会被放大（10 秒里 1% 就是 100ms）。所以 >6s 的交叉要求置信 ≥0.45，
否则宁可不贴 —— 理由会写进日志（`怕越拉越错`）。

### #14 内存可见 + 少留一份冗余

- 字节缓存 3 条 → **2 条**（省约 8MB；丢掉的那次命中由「最近缓冲」兜）；
- 心跳日志新增 `内存=NNMB`，把「当前 + 预载 + 最近缓冲 + 字节缓存」估出来，内存异常一眼可见；
- 另加 `gaplessPlayer.mem()`。

（试过「解码完成后就扔掉该曲的压缩字节」，会破坏 v1.2.1 的复用捷径 → **回滚**，
不当成优化留着。）

### #15 没有空闲槽时抢占「过期预开」

以前两个槽都占着就直接放弃预热（等于退回「等 canplay」）。现在会**抢占**那个
「既不是当前这首、也不是新目标」的过期预开槽 —— 双元素的价值才完整。

### #16 关掉字节缓存也不再失去快捷路径

`__gpBytesCache = false` 时，N+2 抓来的字节存进**内存里的单首槽**（`S.warmBytes`，只留最近一首），
成为下一首时照样命中、跳过取址 + 下载。

### #17 时钟漂移量化

流式那首的结束时刻是「`duration - currentTime`」推出来的。交接时把它量化打出来：
偏差 >150ms 才记一行 `[sched] ★ 结束时刻与预测差 …ms（媒体时钟/时长估算）→ 已按实际交接`。
不是新机制，而是**让漂移可见**。

### #18 面板去掉 C3 侦察按钮

C3 已结案，只读探针不再占面板（控制台仍可 `gaplessPlayer.probeNext / sqlq / sqlTables /
sqlPlaying / sqlPersist`）。

### 验收

```
node test/harness.js  → 通过 702 项，失败 0 项（新增第 100 段 8 项、第 101 段 12 项）
node test/mutate.js   → 变异点 146 个，抓住 146 个，漏网 0 个
```

---

## ★ v1.7.2 —— 结构性限制 #2 / #3 的修法

这两条之前被列在「改不了」里。其实能改，只是各有代价。

### #3 流式 B 也能交叉

**之前**：B 只有「已解码缓冲」才能排交叉；B 是流式时只能硬接（1.5.3 的预开流把空档压到 ~190ms）。

**现在**：1.6.0 的双元素池给了两个出声通道 → B 预开在**空闲槽**上，交叉时：

```
A 的 gain:  1 ──淡出──► 0        （A 可以自己就是缓冲，也可以是流式）
B 槽的 gain: 0 ──淡入──► 1        （B 是另一个 <audio>，此刻在放）
```

两条曲线都排在 `AudioParam` 上，时间精确到音频时钟 —— 不是「瞬间切换」，所以不会有爆音/断口。

踩到的三个点：

1. **B 槽在 bStart 之前必须静音**（`setValueAtTime(0, now)`），否则它会提前出声；
2. **`play()` 排不到未来**，所以用 `setTimeout` 在 bStart 前 20ms 拉起 —— 交叉有几百毫秒到几秒，
   这点定时误差听不出来；
3. 交接时走 `claimSeamless` 的**流式分支**（`bindActive` + `attachStreamEvents`，不重启元素），
   `onNaturalEnd` 里也要先认「流式 B」再走缓冲那一路。

### #2 首曲从原生手里接过来

**之前**：autoplay 策略下首曲由原生播放（ctx suspended），它的尾巴不归我们 → 切到第二首只能硬切。

**现在**：原生在响时，把客户端轮询 `getPlayedTime` / `getPlaybackInfo` 的回调**包一层**
（拦截器本来就支持 `S.__cbSwap` 把替换后的回调交给原生），顺手把「原生播到哪」记下来。
拿到手势后，一旦当前这首**解码完成**，就：

```
起点 = 原生位置 + 经过时间（原生 1× 播放，可外推）
起播 = 现在 + 30ms，偏移 = 起点 + 60ms 提前量   ← 提前 60ms 出声
紧接着 pauseNative()                            ← 同曲同位置短暂重叠，不留空档
```

于是首曲的尾巴归我们 → 「首曲 → 第二首」也能交叉/接拍。

**安全边界**（任何一条不满足就静默留给原生，绝不影响正在播的歌）：
没手势 / 原生没在响 / 当前这首没解码 / 位置不可信（>3s 未刷新）/ 位置太靠头（<0.5s）或太靠尾（最后 2s）。

★ 这里又踩了一次「冗余防御」：我在 `tryTakeoverCurrent` 里写了 `S.nativeRunning = false`，
但 `pauseNative()` 内部本来就置它 —— 变异体抓不住，于是**删掉自己那行**（不是补测试）。

### 验收

```
node test/harness.js  → 通过 673 项，失败 0 项（新增第 98 段 12 项、第 99 段 9 项）
node test/mutate.js   → 变异点 140 个，抓住 140 个，漏网 0 个
```

第 98 段盯：流式交叉排上、交叉时长、用的哪个槽、元素到点被拉起、增益曲线真的排了、
A 播完交接给流式 B、load 到达是「认领」而不是重启、关掉交叉时不排。
第 99 段盯：原生播到 60s 时点按 → 从 60s 接着放、日志写明原生位置、
没有原生位置时不接管、接管后 play 不再放给原生。

---
## ★ v1.7.0 —— C：WSOLA 保音高变速（真正的接拍对齐）

### 为什么还需要它

v1.5.0/1.5.1 只对齐了 **交叉起点** 和 **B 的入点**：两首 BPM 一样时够用，不一样时
交叉期间两边的鼓点还是会互相错开（1% 的差在 3 秒里就错 30ms，5% 直接错 150ms 以上）。

真正的做法是**把 B 加速/减速到 A 的速度**。但直接改 `playbackRate` 会**变调**，所以要用
「改时间不改音高」的算法 —— WSOLA（Waveform Similarity Overlap-Add）。

### 算法（`wsolaStretch`）

```
分帧 30ms / 合成跳距 15ms（50% 重叠）/ 分析跳距 = 合成跳距 × 速度
每一帧：在 ±6ms 内找一个「和上一帧应该接下去的位置」最相似的起点（互相关）
        → Hann 窗重叠相加 → 按权重归一化
相关性只在「降采样 4 倍的单声道」上算，找到的偏移同时套到左右声道（不会错位）
```

### 只拉交叉那一小段

整首拉伸是十亿级运算，没必要；交叉只用到 B 的开头：

```
取 B 的 headSrc = 交叉时长 × 比例 秒   →   WSOLA 拉成正好 fadeSec 秒
播完这段后，从 buffer 的 (入点 + headSrc) 处接回**未拉伸**的 B
接缝用 20ms 淡入盖住（同一首歌、相位差几毫秒 → 听不出来）
```

拉伸段是**独立的 source**（自己的 gain 链），所以 `cancelSched` / `abortSeamless` 时
必须一起 `stop()` —— 否则它会继续响（已实现并有断言）。

### JS 够不够快（结论：够，不需要 Worker）

| 场景（48kHz 立体声） | 帧数 | 耗时 |
|---|---|---|
| 交叉 3s | 195 | **49ms** |
| 交叉 8s | 518 | **91ms** |

只算交叉段，且在「还剩 1.5~3 秒」的调度窗口里做，主线程完全承受得住。
所以这一版**没有引入 Worker**（少一层复杂度，也避开 CEF 里 blob Worker 的 CSP 风险）。
如果以后把上限提到 12s 以上再考虑搬 Worker。

### 决策门槛

只有同时满足才拉：`|ratio-1| ≤ 6%`、两侧置信 ≥0.2、交叉 >0.3s、段长 ≤8s。
不满足就 `logVerbose` 记一句原因，然后走原来的普通交叉 —— **听感上只会更好，不会更差**。

### 验收

```
node test/harness.js  → 通过 652 项，失败 0 项（第 96 段纯函数 19 项 + 第 97 段调度 11 项）
node test/mutate.js   → 变异点 134 个，抓住 134 个，漏网 0 个
```

第 96 段测的是算法本身：长度与比例的对应、双声道等长、没有 NaN、能量守恒（±25%）、
静音进静音出、脉冲不被抹平、`stretchPlan` 各条拒绝理由。
第 97 段测接线：拉的时候真的排了**两段**、接续段正好接在拉伸段结束处、
起点 = 被消耗掉的 B 头部；差 25% 或没有交叉时**不拉**。

---
## ★ v1.6.1 —— B：N+2 只抓字节 + 头尾 BPM 收敛 + 一条日志降噪

### B：第二预载槽，但只存字节

无缝要 B 整首 **下载 + 解码**完。解一首 60~90MB，两首都解会撑爆；而压缩字节只要 7~10MB。
所以第二槽只抓字节：

```
maybePrefetchN2()：当前曲目就绪 → 抓 playlist[idx+2] 的字节 → cachePutBytes()
   ↓ 等它真的成为「下一首」
startPreload()：cacheGetBytes() 命中 → 跳过取址 + 下载（只剩解码 ~600ms）
```

边界：`preloadNextOff`（随机模式）直接跳过；列表末端不抓；换歌单时那首不在新列表 → abort。

### 头尾 BPM 不一致 → 以头窗为准

真机日志里出现过一首歌 `头窗 bpm=120.5 置信 0.65` / `尾窗 bpm=157.0 置信 0.33` —— 差 30%。
这种时候尾窗只有「相位」可信，BPM 不可信。`reconcileTempo()` 的规则：

1. 头/尾都算出来之后跑一次（幂等）；
2. 偏差 > 8% → `tail.bpm = head.bpm`、`tail.beatSec` 跟着换、末拍相位仍用尾窗锚点重算；
3. 同时把尾窗置信压到 ≤0.15 → `mixPlan` 退回 `plain`：**宁可不对齐，也不照错的 BPM 硬贴**。

★ 调用点只留一处（`beatGridNear` 结尾）。第一版我在三处都调了，结果「删掉任一处行为都不变」——
变异体永远抓不住，正好印证了之前的规矩：**冗余的防御等于没有防御**。

### 日志降噪

`[preload] LibEAPI 不可用（n is not a function）→ 试 320k 免签名接口` 在 3.x 上每次预载都会打，
属于已知常态 → 降级成 `logVerbose`。

### 验收

```
node test/harness.js  → 通过 621 项，失败 0 项（新增第 95 段）
node test/mutate.js   → 变异点 129 个，抓住 129 个，漏网 0 个
```

新增 `gaplessPlayer.beatGrid(trackId)` 便于排查「头尾不一致」（返回缓存里的 head/tail 网格）。

---
## ★ v1.6.0 —— A：双元素流水线（下一首在空闲槽里预热，切歌时接管）

### 为什么

C3 结案后，随机模式读不到「下一首是谁」，只能靠工程手段缩短接缝。而原来的实现有一个硬限制：

> **只有一个 `<audio>`** —— 它在给当前这首用时，下一首就**没法预热**（动它就断音）。
> 所以 1.5.3 的预开流只能在「当前这首走缓冲」时才生效；随机模式下当前这首恰恰在走流式，
> 于是最需要预热的场景反而不生效。

### 做法

把单元素换成**元素池**（按需扩到 2 个槽）：

- 每个槽 = `Audio` + `createMediaElementSource` + 自己的 `gain → highpass → 总线`；
- 「出声槽」由 `elActive` 指定，`S.el / S.mediaSrc / S.mediaGain / S.mediaFilter` 始终指向它；
- 预开时把 B 挂到**不是出声槽**的空闲槽上（`preload=auto`，它没在播所以天然静音）；
- 真切歌时 `adoptSlot = findPreopenSlot(curTrackId)`：
  - **不重设 src**（重设 = 重新下载），直接 `bindActive(adoptSlot)` 把它变成出声槽；
  - 同时把**上一个出声槽 `pause()`** —— 否则就是双声（真机上听着像两个声道各放一首）；
  - 若预开槽在我们挂监听前就已有 metadata，`attachStreamEvents` 会补一次 `onMeta()`。

### 踩到的点

1. **`ensureEl` 从「唯一元素」变成「池」**：`createMediaElementSource` 对同一个元素只能调一次，
   所以每个槽建一次、长期复用；`v0.4.0` 那条「不能重复建」的断言也跟着改成盯池化守卫。
2. **占位槽**：即使当前这首走缓冲（不需要元素），第一个槽也要建出来并 `bindActive(0)` 占位，
   否则「空闲槽」的判断会飘（第一版就踩了：预开落到了 slot 0，而 `S.el` 还是 null）。
3. **旧槽必须停**：`prevEl.pause()` 这行虽然小，但漏了就是双声；现在还有一行日志
   `[stream] 上一个槽已暂停（避免双声）` 供排查。

### 预期收益

- 随机模式：接缝从「等 `canplay`（真机约 500ms）」变成「只差一次 `play()`」；
- 流式那首也能做交叉淡入（两个元素可同时出声）—— 为 C 打基础。

### 验收

```
node test/harness.js  → 通过 610 项，失败 0 项（第 92 段重写为双元素语义，新增双声用例）
node test/mutate.js   → 变异点 124 个，抓住 124 个，漏网 0 个
```

第 92 段现在盯：预开落在**空闲槽**、出声槽完全没被碰、采用时**不重设 src / 不再 load()**、
补发 metadata、`onLoad` 发得出去、**旧槽被暂停**、换目标时只清预开槽不动正在播的那路。

---
## ★ v1.5.6 ~ v1.5.8 —— C3 第二轮：通道通了，但播放列表不在那条连接上

### 已经确认的事实（真机）

`storage.execsql` 这条通道**对我们开放**：

```
[sql] → SELECT name FROM sqlite_master WHERE type='table'
[sql] ← err=0 ｜ [{"name":"web_offline_track"},{"name":"web_playlist_order"},…]
```

（结果不是从 `channel.call` 的回调来的，而是走 `execsqldone` 回调 —— 所以两条得一起挂。）

但接着三个反证：

1. **`web_playlist_order` 不是随机序列**，它的建表语句是
   `(playlist_id BIGINT, field VARCHAR(40), order VARCHAR(40), PRIMARY KEY(playlist_id))`
   —— 那是「这张歌单按哪个字段、升序还是降序」的**排序偏好**。
2. 在 `sqlite_master` 里搜 `randomOrder` **零命中** ⇒ 这条连接里的库没有那一列。
3. 从客户端常量里挖出播放列表的真实表名 `{current:"currentPlayingList", last:"lastPlayingList"}`，
   直接查：`sqlite_master` 给了 `err=0 ｜ undefined`（没有这张表），
   `SELECT * FROM currentPlayingList` 给 `err=1`（no such table）。

⇒ **播放列表用的是另一条 sqlite 连接**（或另一个库文件）。`storage.execsql` 没有指定库名的参数，
   所以从这条通道读不到它。

### 这一段加的工具（都只读）

```js
gaplessPlayer.sqlTables()        // 找含 randomOrder / 名字像 order 的表，并打建表 SQL
gaplessPlayer.sqlTable("x")      // 某张表的结构 + 前 3 行
gaplessPlayer.sqlPlaying()       // 直接看 currentPlayingList（结构/前两行/行数）
gaplessPlayer.sqlPersist()       // persistentModel 表 + 试着解开 playingInfo
gaplessPlayer.sqlq("SELECT …")   // 任意只读 SQL
```

工程上的三个小改进：

- **结果完整输出**（截断 700 → 3000 字符），否则表名一多就看不全；
- **回调只注册一次** + `reqId → 待处理` 映射（原来是每查一次就多挂一个处理器，会积累）；
- 别人的查询结果会明确记一行 `[sql] 忽略一条不属于我们的结果`，不再静默。

### C3 最终判定（1.5.8 第三次探针，真机 19:35）

| 线索 | 实测结果 | 结论 |
|---|---|---|
| `currentPlayingList` / `lastPlayingList`（客户端常量里的真名） | `sqlite_master` 无此行，`SELECT` 报 `err=1 no such table` | 播放列表在**另一条 sqlite 连接**，`storage.execsql` 无库名参数 |
| `persistentModel` 表 | 内容是**页面缓存**（`page:artistDetail` / 330KB 的 artistTracks） | 与播放队列无关 |
| `window.frontendEncrypt` | keys = `beforeLoadRequest / afterLoadRequest / setOneCookie / getCookie / …` | 那是**网络请求/Cookie 钩子**，不是解密器 |
| `localStorage.playingInfo` | 488424 字符（806 首的体量），加密 | 没有解密入口就读不了 |
| `nm.playingList.getPlayingListData` / `nm.play.getNextSong` | 命令确实存在于 tinyapp 桥白名单，但渲染层 `channel.call` 一律回 `undefined` | 桥不通 |

⇒ **结论：随机播放的「下一首是谁」在渲染层拿不到。** 客户端的实现是
「DB 里 `randomOrder` 列排序」，而那张表在插件够不着的连接/库里。

保留的工具（都是只读、只在点按钮时才跑，零常驻开销）：
`sqlq()` / `sqlTables()` / `sqlTable()` / `sqlPlaying()` / `sqlPersist()` / `probeNext()`。
将来客户端换版本时，这套探针还能再问一次 —— 属于「留给未来的钩子」，不是死代码。

**所以随机模式下的无缝只能靠工程手段缓解**（提前预开流、双元素流水线等），
不再指望「读到随机序列」。C3 到此结案。
### 下一步（待定）

`persistentModel` 表 + `window.frontendEncrypt`（localStorage 里的 `playingInfo` 是十几 KB 密文，
很可能就是播放列表快照）。这两条里任意一条通了，随机播放的无缝就有解；都不通就得换思路。

### 验收

```
node test/harness.js  → 通过 601 项，失败 0 项（第 94 段累计 22 项）
node test/mutate.js   → 变异点 121 个，抓住 121 个，漏网 0 个
```

---
## ★ v1.5.5 —— C3 实测结论 + 找到真正的 DB 通道

### 探针实测（真机，随机播放，三次）

```
[next] nm.play.getNextSong   ← undefined
[next] nm.play.getPlayerMode ← undefined
[next] nm.play.getCurrentSong← undefined
[next] Database.getAllBy     ← undefined
[next] IndexedDB 共 1 个库: columnGrow（keyvaluepairs / local-forage-detect-blob-support）
[next] registeredCalls 共 73~75 个 ｜ 相关: （无）
[next] localStorage 共 193 个键（只有 playingInfo 等加密快照）
```

⚠️ `← undefined` ≠ `← 无响应`：**回调被立刻调用了、只是没有数据** → 原生侧不认识这些命令。
所以「tinyapp 桥的 `nm.play.getNextSong`」与「IndexedDB 直读」两条路都封死；
store 也没挂在 window 上（webpack 模块缓存闭包私有）。

### 但挖到了正门：播放列表 DB 走通道命令

```js
channel.call("storage.execsql", cb, [reqId, sqlText])
legacyNativeCmder.appendRegisterCall("execsqldone", "storage", function (reqId, errCode, value) {...})
```

而客户端的随机顺序就是「按 `randomOrder` 列排序」（切随机模式时整列重刷随机值）。
⇒ 只要这条通道对我们开放，一条 `SELECT resourceId, randomOrder FROM …` 就能拿到**整个随机序列**。

所以 1.5.5 加了两个只读入口：

```js
gaplessPlayer.sqlTables()        // 查 sqlite_master
gaplessPlayer.sqlq("SELECT …")   // 任意只读 SQL
```

面板 → 诊断 → **C3 SQL（只读）** 同效。判定：`← err=0 ｜ [...表名...]` = 通；
`← 无响应（1500ms）` = 对我们不开放（那 C3 就走不通，回退押注 + 预开流）。

### 又删了一处冗余

原本同时挂 `appendRegisterCall("execsqldone","storage",cb)` 和
`channel.registerCall("storage.onexecsqldone",cb)` 两条回调路径 —— 客户端自己只用前者。
留两条的后果是「删掉任一条行为都不变」，对应变异体永远抓不住 → 只留实际在用的那条。

### 验收

```
node test/harness.js  → 通过 588 项，失败 0 项（新增第 94 段 13 项）
node test/mutate.js   → 变异点 120 个，抓住 120 个，漏网 0 个
```

---
## ★ v1.5.4 —— C3 侦察：能不能问出「下一首是谁」

随机播放做不到无缝，根因不是 DSP，而是**不知道下一首是谁**（客户端切歌前约 80ms 才决定）。
这一版不改行为，只做侦察 —— 但静态分析阶段就已经挖到几条关键事实：

### 静态发现的四条线索

1. **随机顺序是"存起来的"，不是现掷骰子**：播放列表 DB 的每一行有个 `randomOrder` 列；
   切到随机模式时会调 `refreshRandomPlayingList` → `Database.updateBy {modifyByIndex:{name:"randomOrder",type:"random"}}`
   **整列重刷随机值**；点下一首时的顺序比较器就是按 `randomOrder` 排序（`f("randomOrder", …)`）。
   ⇒ 只要能读到那张表（或读到一个装着它的快照），**整个随机序列都是已知的**。
2. **渲染层还有个现成的「下一首随机结果」**：redux 动作 `setRandomNextInPlayingList`，
   payload 里直接带着 `resourceId`（渲染层还会把 `randomOrder` 写回该项）。
   ⇒ 能读到 store，就能直接拿到「下一次随机挑中的那首」。
3. **native 侧有正经的查询命令**：`nm.play.getNextSong` / `nm.play.getPreviousSong` /
   `nm.play.getCurrentSong` / `nm.play.getPlayerMode`（出现在客户端 tinyapp 桥的命令白名单里，
   事件侧还有 `nm.play.songChanged` / `nm.play.modeChanged`）。
   ⚠️ 但**渲染层 JS 从不调用它们**（全仓库只有白名单里那两处引用），所以
   `channel.call` 能不能路由过去，只能实测。
4. **store 没挂在 window 上**：webpack 运行时的模块缓存是闭包私有的
   （`!function(e){…var f={}…}`，`f` 就是模块缓存），`window` 上只有 `APP_CONF` / `cef` / `channel` 这些。
   ⇒ 「读 store」这条路需要额外手段，不能想当然。

### 所以做了个探针（只读、幂等）

`gaplessPlayer.probeNext()`（面板「诊断」里也有「查下一首（侦察）」按钮；开机设
`window.__gpProbeNext = true` 会自动跑一次）。它一次性问五件事并逐条记日志：

```
[next] ===== C3 侦察开始（只读）=====
[next] nm.play.getNextSong ← …（或「无响应（800ms）」）
[next] nm.play.getPlayerMode ← …
[next] nm.play.getCurrentSong ← …
[next] Database.getAllBy ← …
[next] IndexedDB 共 N 个库: …        ← 有库就会接着列每个库的表名
[next]   <db> → 表: current, last
[next] localStorage 共 N 个键
[next] registeredCalls 共 N 个 ｜ 相关: …
```

判定表（拿到日志就能直接定下一步）：

| 观察 | 结论 |
|---|---|
| `nm.play.getNextSong ← {…}` 有内容 | **最好情况**：随机也能无缝（提前拿到下一首 id → 提前取址/预载） |
| `IndexedDB` 里有 `current` 表 | 直接用 IndexedDB 读 `randomOrder` 排序 → 自己算下一首（不依赖任何桥） |
| `Database.getAllBy ← {…}` 有行 | 同上，但走客户端的 DB 命令 |
| 全都「无响应」且没有 `current` 表 | 这条路封死 → 退回「押注/双槽预载」，或转向「流式灌块 + 猜」 |

### 验收

```
node test/harness.js  → 通过 575 项，失败 0 项（新增第 93 段 17 项）
node test/mutate.js   → 变异点 117 个，抓住 117 个，漏网 0 个
```

★ 探针代码全是 `typeof indexedDB === "undefined"` 之类的守卫：缺什么就记「不可用」，不许抛错
（验证台就是缺 DOM / 缺 indexedDB 的环境，正好当「最坏情况」的回归）。

---
## ★ v1.5.3 —— 没预载完也先「预开」下一首的流

### 前提回顾

无缝（采样级接缝）硬性要求 B **整首下载完 + 解码完** —— `AudioBufferSourceNode` 只能播完整的
`AudioBuffer`，Web Audio 没有「流式 buffer 源」。所以 B 没就绪时只能退回流式接力，代价是
`el.src = url` → 等 `canplay` → 出声，真机约 **500ms 空档**。

### 这一版做的事

那 500ms 里，B 的歌其实**已经在路上了**（预载槽 `status=pending`，地址也解析出来了）。
所以提前把 `<audio>` 的 `src` 挂上、让它自己缓冲；等真切歌时 `canplay` 往往已经满足。

三条安全边界（缺一不可）：

1. **当前这首不走流式** —— 那个 `<audio>` 正被当前这首用着，动它就直接断音；
2. B 的预载槽是 **pending** 且**地址已解析**（`slot.url`，本版新增记录）—— `ready` 不需要流，
   `failed` 不值得试；
3. 不是「整条交回原生」的逃生状态。

### 两个必须处理的坑（都是测试逼出来的）

1. **3.x 的 `musicurl` 是加密 token，不是 URL** —— 所以「复用」不能比字符串，要比
   **是不是同一首**（`S.preopenTrackId === S.curTrackId`）。第一版按字符串比，3.x 上永远不会命中。
2. **顺手清理会把正要用的那份清掉** —— 切歌时 `loadSong` 会先 `dropPreload()`（这首改走流式），
   而 `dropPreload` 里加了「预载作废 → 清预开」；结果预开刚建好就被清。
   → `dropPreload(why, { keepPreopen: true })`，并且所有清理路径都加一条守卫：
   **正在播/即将播那一首的预开不许清**（`S.preopenTrackId !== S.curTrackId`）。
   顺序也很要命：`startStream` 里 `attachStreamEvents()` 在 `apply()` **之前**跑，
   补发 `onMeta` 会触发 `afterReady → maybePreload`，那一步就会去清预开 —— 守卫正是为了它。

### 附带的一个小修

预开的元素可能在**我们挂监听之前**就已经 `loadedmetadata` 了（等了 1 秒以上很常见）。
`attachStreamEvents()` 末尾补一次：`readyState >= 1` 且确实是预开的那首 → 直接 `onMeta()`，
否则会一直等一个不会再来的事件（表现为「流式起播卡住」）。

### 验收

```
node test/harness.js  → 通过 558 项，失败 0 项（新增第 92 段 22 项）
node test/mutate.js   → 变异点 113 个，抓住 113 个，漏网 0 个
```

第 92 段覆盖：窗口内预开（A 缓冲 / B pending）、预开时才建 `<audio>` 且只建一个、
真切歌复用（src 不重设、不再 `load()`、补发 metadata、`onLoad` 发得出去）、
当前在流式时**不**预开、换预载目标时清掉预开并撤 src。

★ 还有一处**自我删减**：`maybePreopenNext` 里原本也判了一次 `S.stream`，但 `preopenStream` 内部已经守住了 ——
删掉外层判断行为完全不变（对应的变异体永远抓不住），那就删掉，只留内层那道闸，
并把它暴露成 `gaplessPlayer.preopen()` 让测试**直接**打这条守卫（否则它也只是「看不见的保险」）。

★ 为了让用例成立，验证台补了两处基础设施：`createEnv({ document })` 注入假 DOM（上一版为面板加的）、
以及假 `<audio>` 的 `removeAttribute("src")` 现在真的会清空 `src`（否则测不出「撤掉预开」）。

---

## ★ v1.5.2 —— 面板重做 + 让「默认开」看得见 + 干净风格也跳过开头空白

### ① 设置面板重做（排版与控件）

原来那版面板是"能点就行"：原生 `checkbox`、原生 `select`、光秃秃的按钮，和客户端 UI 放一起很扎眼。
这一版改了四件事：

- **一次性注入一段 `<style>`**（不打外部文件、不改客户端 CSS），全部类名加 `gp-` 前缀，
  并用 `all:unset` 把按钮/输入框的浏览器默认样式清掉 —— 否则客户端自己的全局样式会渗进来；
- **分段控件**取代"三个并排按钮"：`干净 | 轻过渡 | DJ`，选中态是亮蓝胶囊；
- **拨动开关**取代 `checkbox`（`.gp-sw` + 内部圆点位移），和 iOS/Android 的习惯一致；
- **信息分层**：标题（带版本胶囊）→ 状态行（等宽数字、可换行）→ 三个分区（过渡风格 / 播放行为 / 缓存）
  → 折叠的「诊断」。滑杆换成自绘 track/thumb，右下角按钮也从"半透明 G"换成玻璃质感的 ♪。

面板是**自绘 DOM**，不依赖客户端 DOM 结构（BetterNCM 1.3.4 没有插件设置页 API）。
`typeof document === "undefined"` 的守卫保留着，所以验证台（无 DOM）照样能跑。

验证台新增第 91 段：用一个**极简假 DOM**（只覆盖面板真正用到的那点 API）跑通
「注入按钮 → 打开面板 → 点分段 → 拨开关 → 拖滑杆 → 收起」，并断言样式只注入一次。

### ② 把默认值摆到台面上

状态行加了 `拍点=开（已分析 N 段）`。原因很简单：拍点对齐**本来就是默认开**的，
但只有在「有交叉 + 算得出拍点」时才有可见效果，不少人会以为它是关的。
现在打开面板一眼能看到它开着、分析了几段。

顺带回答"还有哪些开关该默认开"：其余基本都是**开了会改音色**（高通扫频）、
**改作者意图**（裁作品静音）或**纯诊断**（探针/强制缓冲/交回原生），不适合默认开。
真正的默认值改进只有一个 —— 见下。

### ③ 干净风格（0s 交叉）也跳过 B 开头的空白

这是这一版最有价值的一处：以前「跳过 B 开头空白」只在**有交叉**时生效，
所以顺序播放（默认干净风格）遇到前奏有 1~2 秒留白的歌，接缝处就是一段安静 —— 听感上等于留了个洞，
和"无缝"的初衷正好相反。

现在 `pickBEntry(..., { silenceOnly: true })` 在没有交叉时也会跑，但**只做一件事**：
跳过检测到的**真静音**（≥100ms，且必须在 6s 上限内量得完）。**不做拍点对齐** ——
没有交叉就没有拍点关系，多吃一个整拍等于白吃歌。
`S.startOffset` 会跟着变成跳过量，进度条从空白之后开始。

### 验收

```
node test/harness.js  → 通过 536 项，失败 0 项（第 90 段 +6、新增第 91 段 13 项）
node test/mutate.js   → 变异点 108 个，抓住 108 个，漏网 0 个
```

★ 这轮踩到的坑：给面板加的几个变异体第一次跑出「验证台没跑起来」——
因为第 91 段直接 `doc.head.children[0].textContent`，样式没注入时就是 `undefined.textContent`，
整个验证台崩掉（而不是报红）。改成安全取值（`(x || {}).textContent || ""`）后才正常判红。

## ★ v1.5.1 —— B 的入点：跳过空白、落在拍上

### 为什么

v1.5.0 只对齐了 **A 的淡出起点**；B 仍然永远从 0 开始。于是交叉可能：

- 落在 B 的**半拍中间**（听起来像"抢进来"）；
- 落在 B 开头那段**空气声/留白**里（很多歌前奏就是 1~2 秒的空白或极弱的环境声）——
  交叉期间听到空气声是最差的入点，比硬接还难受。

这一版只做**决策**，不动任何 DSP：给 B 选一个入点（缓冲时间轴上的偏移），
然后 `src.start(bStart, 入点, 剩余时长)`。

### 规则（三步，都是保守的）

1. **先看空白**：用 trim 那套真静音检测（-80dBFS）量 B 开头；
   有空白就优先跳到空白之后的第一拍。
   ⚠️ **只跳「量得完」的空白**：检测扫到上限（`cap`）就返回上限，那种情况说明空白比上限还长 ——
   硬跳会把自己扔进空白中间，所以宁可不跳（第一版就是这里错了，测试当场抓到）。
2. **再对齐拍点**：取 ≥ 该点的第一个拍；如果起点本来就贴着上一拍（差 ≤60ms），
   **不为对齐再吃一个整拍**（否则"本来就在拍上"的曲目也会被白吃 0.5s）。
3. **跳太多就放弃**：上限 `min(6s, B 的一半)`，超了就老实从可听起点开始。

### 交接时的连带改动（容易漏）

B 从入点进场后，`S.startOffset` 必须是**入点**而不是 0 —— 否则交接那一刻进度会跳回 0:00，
而且 `position()` 与实际播放位置差一个入点。连带三处一起改：

- 交接：`S.startOffset = sc.startOffset`；
- 兜底重启节点（"结束时刻估晚了"）：用 `sc.bufOffset` / `sc.playDur` 而不是 trim/整首；
- 日志：`[sched]` 那行加 `B入点=+xxxms`，另有一行专门的 `[automix] B 入点 → …`。

### 验收

```
node test/harness.js  → 通过 497 项，失败 0 项（新增第 90 段 16 项）
node test/mutate.js   → 变异点 102 个，抓住 102 个，漏网 0 个
```

第 90 段覆盖：贴拍不跳 / 离拍跳到第一拍 / 1.5s 空白优先跳 / 空白超上限不硬跳 /
没网格不跳 / 调度时真的用了入点（`src.start` 的 off/dur、`[sched]` 带 B入点）/
交接后进度从入点开始（不是 0）。

## ★ v1.5.0 —— 拍点分析 + 无变速的拍点对齐（Automix 第一步）

### 动机与边界（重要）

用户找到了 [Convx](https://github.com/cosmictasterdev-creator/Convx)（Android 版 YT Music 客户端，
GPL-3.0），里面有完整的 Automix：`dj/BeatTracker`（纯 DSP）、`DjMixPlanner`（档位判定）、
`smart/TransitionPlanner`（入点/丢弃预算），还有 ML 版 `beat_this_u8.onnx`。

但**我们插件是 MIT，它的 automix 文件是 GPL-3.0 / AGPL-3.0**（`smart/*` 从 Orchard 移植，
头部写明 AGPLv3-or-later）→ **不能抄代码**。所以这一版是 **clean-room**：
只按公开做法（onset 通量 → 自相关 → 梳状折叠 → 相位锚定）自己写，不复制它的表达。

另外两个环境事实决定了做法：
- 客户端是 **CEF 91 / Chromium 91**（`libcef.dll` 实测 91.2.3+chromium-91.0.4472.169）：
  WASM 有，但**没有 SharedArrayBuffer**（缺 COOP/COEP）→ onnxruntime-web 只能单线程、且可能被 CSP 挡 → **不走 ML**；
- Web Audio 只有 `playbackRate`（会变调）→ **这一版不做变速**，只做「把交叉起点对齐到拍点」。

### 算法（全部跑在已经解码好的 AudioBuffer 上，零额外下载）

1. 单声道 + 4:1 抽取到 ~11kHz（只要包络，音质无所谓）
2. 一阶高通 ~200Hz（突出瞬态；不压低频的话包络会被糊住）
3. 每 ~11.6ms 一帧取能量 → 正向差分 → **减去 0.6s 局部均值** = onset 通量
4. 通量自相关，滞后区间对应 **40~220 BPM**
5. **梳状评分**（基本周期的整数倍处也该有峰）压掉倍/半速误判，再折回 80~180 BPM
6. 在周期上扫相位，拍点处通量最集中的相位 = **锚点**
7. 置信度 = (拍点均值 − 全局均值) / (两者之和)，落在 [0,1]

**成本控制**：每次只算 **两段 20s 窗口**（头窗给 B 的入点、尾窗给 A 的接缝），
缓存进 `S.beatCache[trackId|head|tail]`，在「预载就绪 / 缓冲就绪」时算一次。
真机 5 分钟的歌也就读 ~11M 个 float，一次 30~60ms。

### 决策与用法（无变速版）

```
mixPlan(A, B)：BPM 用 0.5/1/2 倍折算到最接近 A 的那个 → 偏差 ≤6% 才算「同步」
  置信 ≥0.45 → full ／ ≥0.2 → smart ／ 其它 → plain（不硬对齐）
对齐：交叉起点 = A 的可听时长 − 交叉时长，把它吸到最近一拍（位移 ≤ 半拍），
     位移反向加到交叉时长上（A 的结束时刻不动，只让淡出变长/变短一点点）
```

日志两行：

```
[beat] track=<id> ｜ 尾窗 ｜ bpm=120.0 ｜ 锚点=178.00s ｜ 置信=0.95 ｜ 末拍=199.99s
[automix] A=120.0bpm/置信0.95 B=120.0bpm/置信0.95 → full（八度折算后偏差 0.0%） ｜ 拍点对齐 200ms（交叉 3.20→3.00s）
```

开关：`window.__gpAutoMix = false` 关掉（面板的「诊断」里也有）。

### 踩到的坑

- 断言写成 `"[beat] 头窗"`，而日志是 `[beat] track=… ｜ 头窗` —— **又一次「断言跟着文案一起失效」**
  （上一版是 `[sched] 预约` vs `[sched] ★ 交叉预约`）。这已经是第三次同类问题了，
  以后新增日志的断言一律只匹配**稳定的字段片段**（如 `｜ 头窗`、`预约 ｜`），不匹配整句开头。
- 合成节拍轨（click track）当基准非常好用：**节拍是已知真值**，能直接断言 BPM 误差与锚点误差；
  真机曲目只能听感验证。

### 验收

```
node test/harness.js  → 通过 479 项，失败 0 项（新增第 89 段 22 项）
node test/mutate.js   → 变异点 98 个，抓住 98 个，漏网 0 个
```

第 89 段覆盖：120/90/150 BPM 检测误差、锚点落点、相位偏移、静音不给网格、
八度折算（120 vs 60 = 同步）、低置信退回 plain、缺网格退回 plain、吸附范围、
解码后自动分析、调度时出判定、`lastPlan()` 可取。

## ★ v1.4.0 —— 过渡风格智能默认 + 状态行 + 设置面板

起因是一句反问：**「控制台开关，哪些能提升体验？」** 想清楚后的结论是 ——
**大部分开关不该由用户碰，真正提升体感的是「默认值 + 可见状态 + 一个像样的入口」**。
于是三件事一起做：

### ① 过渡风格（三档）+ 按播放模式智能默认

用户不该懂「等功率 / 曲线 / 扫频」。只给三档：

| 风格 | 实际是 | 自动选它的条件 |
|---|---|---|
| 干净 | 0s（采样级无缝） | 顺序 / 列表循环 / 单曲循环 —— 专辑连听不该交叉 |
| 轻过渡 | 2.5s 等功率 | 随机播放 / 心动模式 —— 前后没有专辑连续性 |
| DJ | 3s + 高通扫频 + s 曲线 | 只在手动选时 |

**智能默认用的信号是 `NM_SETTING_PLAYER.mode`** —— 这是我们唯一可靠拿到的上下文
（3.x 实测能读到 `playrandom`）。拿不到模式时按「干净」处理（宁可不交叉）。

优先级（`effectiveXfade()` 一个函数收口）：

```
window.__gpXfade（显式时长，会记住）> 用户选的风格（会记住）> 智能默认（每次现算）
曲线/扫频：window.__gpXfadeCurve/__gpXfadeEq（显式）> 风格预设 > 默认
```

`source` 字段（`explicit` / `style:dj` / `auto:light`）同时进日志和面板 —— 用户一眼能看出
"现在为什么是这个值"，这比任何说明文档都省事。

### ② 状态行：回答最容易困惑的三件事

```
[status] 引擎=Web Audio ｜ 过渡=2.5s · equal · auto:light ｜ 缓存=2 首/96.3 MB ｜ 预载命中=87%（13/15）
```

- **引擎=** 现在是原生在放还是插件在放（「第一首没无缝」时最需要）；
- **过渡=** 生效值 + 来源（显式/风格/智能）；
- **缓存 / 预载命中=** 让「为什么卡」「吃多少内存」有据可查。

启动写一行，心跳里也带着；面板里每秒刷。

### ③ 设置面板（右下角「G」）

BetterNCM 1.3.4 **没有插件设置页 API**（`msimg32.dll` 里只有 `betterncm_native.{app,fs}`、
`betterncm.app.readConfig`、`utils.waitForElement`、`betterncmFetch`），所以自己注入一个
fixed 的浮层：右下角 26px 半透明「G」→ 面板。

面板内容：状态行、过渡风格三按钮、时长滑杆、曲线下拉、三个开关（扫频 / 裁作品静音 / 补缓冲）、
缓存占用 + 清空、折叠的「诊断」（强制缓冲 / 关预约 / 全交回原生 / 探针 / 复制日志路径）。
`window.__gpHideButton = true` 可以连按钮一起隐藏。

同时也暴露脚本接口（面板就是用它实现的）：

```js
gaplessPlayer.status() ／ setStyle("dj") ／ xfade() ／ clearCache() ／ openPanel()
```

★ 面板代码全程 `typeof document === "undefined"` 守卫 —— 验证台没有 DOM，必须能安静跳过
（第 88 段 (e) 就是盯这个：`openPanel()` 要返回 `false` 而不是抛错）。

### 顺手删掉的

`__gpTrimPad`（作品静音裁剪）从 README 拿掉了：它只有 ≤40ms 的差别，听不出来，纯认知负担。
功能保留（面板里有开关），只是不再当"用户该知道的东西"。

### 验收

```
node test/harness.js  → 通过 457 项，失败 0 项（新增第 88 段 26 项）
node test/mutate.js   → 变异点 94 个，抓住 94 个，漏网 0 个
```

★ 做这一版时**变异测试抓到一个假的绿**：`[sched] 预约` 那条断言用的是完整前缀，
而智能默认为随机播放加了交叉后日志变成 `[sched] ★ 交叉预约 …` —— 断言从"没有预约"
变成"匹配不到这个前缀"，于是"模式闸门失效"这个变异体**漏网**了。改成匹配 `预约 ｜`
（两种写法都包含）之后恢复咬合。

## ★ v1.3.3 —— autoplay 兜底：不带启动参数也不用点播放

### 问题出在哪

`AudioContext` 在**首次用户手势之前**一直是 `suspended`，`resume()` 也只能挂在手势上
（Chromium 的 autoplay 策略）。于是真机上的现象是：

```
[play] ctx.resume() ｜ state=suspended
[play] source.start ｜ at=0.020 ｜ … ｜ ctxTime=0.000     ← ctx 时钟根本没走
```

source 照常 start，但整个图不出声（`ctxTime=0.000` 就是证据）。用户听到的就是「没声音」，
直到随手点一下 —— 所以 README 里一直挂着「建议加 `--autoplay-policy=no-user-gesture-required`」。

**JS 绕不过这个策略**（能绕的话这策略就没意义了）。所以换思路：

### 做法：起不来就先让原生播，第一次点按后接管

| 状态 | 含义 | 行为 |
|---|---|---|
| `S.deferNative` | 还没拿到手势 | 音频命令（load/play/pause/seek/setVolume）**整条放行给原生**；非音频命令照常处理（记列表、预载） |
| `S.nativeRunning` | 原生正在响 | 音频命令照样放行 —— **但 `load` 除外**：接管就是靠它把我们拉进播放 |
| 手势到达 | 任意 `pointerdown/mousedown/keydown/touchstart` | `ctx.resume()` + `deferNative=false`；下一次 `load` 进来时先 `pauseNative()` 再走我们自己的引擎 |

三个细节值得记：

1. **`load` 必须排除在放行之外**。第一版写成「`nativeRunning` 时音频命令一律放行」——
   结果 `load` 也放行了，`pauseNative()` 永远不执行，接管瞬间双声，验证台当场报红
   （第 87 段「接管后 load 被我们拦下」）。
2. **契约自答要让位**。`getPlayedTime / getPlaybackInfo` 平时由我们自答（修跳歌），
   但原生死扛阶段必须交回原生 —— 否则会答「播到 0 秒」，把客户端骗得再判一次结束。
   守卫：`!S.deferNative && !S.nativeRunning`。
3. **不能在拿到手势时立刻按住原生**。那样会把用户正在听的歌掐断；正确姿势是
   「原生把这第一首放完，下一首 `load` 到了再按住」——中间没有一段静音或双声。

### 代价（写进 README 的已知限制）

不开启动参数时，**本次启动的第一首是原生播的**：那一首没有无缝/交叉。从第二首开始照旧。
想要第一首也无缝 → 用带参数的快捷方式（`AudioContext` 一开就是 running）。

### 验收

```
node test/harness.js  → 通过 431 项，失败 0 项（新增第 87 段 16 项）
node test/mutate.js   → 变异点 90 个，抓住 90 个，漏网 0 个
```

第 87 段覆盖：suspended 时不按住原生（开机不哑）/ 自动播的 load 放行给原生且不下载 /
契约不自答 / 手势后 resume + 交回引擎 / 接管时先按住原生再播 /
ctx 能起时行为完全不变（照旧按住原生、照旧拦截）。

## ★ v1.3.2 —— 交叉曲线可选 + 高通扫频 + automix 探针（P3 的前哨）

### 先说结论：这台客户端的 automix 够不着

用户问「Automix 难不难 / 原生有的话能不能利用」，于是把客户端翻了个底朝天。实测（3.1.42.205594）：

| 在哪 | 有什么 |
|---|---|
| **原生 DLL**（cloudmusic.dll / neaudio*.dll / audioeffects.dll / cloudmusic.exe） | `automix` / `crossfade` / `智能过渡` **0 命中**；`mix_params` / `crossfade_start_time` / `tempo_values` / `eq_type` **0 命中**；`r_s-line` / `strategy_rhythm` / `band_pass` **0 命中**。只有 `AutoTrackChangeFadeIn/Out`、`Seek/Pause/StopFadeIn/Out`、`P8AudioVolumeFade` —— 固定音量淡入淡出 |
| **渲染层**（`package/orpheus.ntpk`，实为「100 字节头 + zip」，247 个 js / 21MB） | **完整的 automix 决策库**：`AutomixEffectConfig0922`（`abtest.getList` + `realtime:true`）、`__AUTOMIX_DEV`、`mix_strategy`（rhythm/vocal/atmosphere/accompaniment/silence/crossfade/donothing/custom）、`song_a/song_b` 的 `crossfade_line / crossfade_start_time / crossfade_end_time / eq_type / mix_start_time / silence_time / beat_array / bpm`、`mix_params`（`b_start_a_time` / `beat_sync_enabled` / `tempo_sync_enabled` / `b_prepare_time` / `ui_switch_time`）、`ori_song_*`（`bpm` / `repBpm` / `mode`(调性) / `genre` / `length_ms`）、`crossfade_line` 枚举（`linear/log/exp/s-line/r_*/step`） |
| **入口** | `kernel-service-play-effect` 只出现 1 次；其它 chunk 全都没有引用 automix；分析数据（bpm/repBpm/beat_array）没有任何抓取点 |
| **客户端能调的开关** | `audioplayer.switchEffect("id", [{name:"fade", on:e}])` —— 就一个 fade 开关 |

**结论**：这一版的 automix 决策层是**悬空**的 —— 算得出计划，但没人喂分析数据、也没人消费它
（决策层随版本先发了，渲染层/接线还没到，或只在服务端 + AB 命中的账号上）。原生那条路彻底堵死：
① 原生没有 automix 渲染器；② 我们已经把音频链整个换成 Web Audio，没法把 PCM 塞回原生。

顺带记下它内置的 crossfade 策略（反编译出来的算式），和我们现在的实现一致、只是时长可调：

```js
song_a.crossfade_start_time = A.length_ms - 5000   // A 最后 5 秒开始
song_b.crossfade_start_time = 0                    // B 从 0 开始
song_b.crossfade_end_time   = 5000
song_a.crossfade_line = "r_s-line" ／ song_b.crossfade_line = "s-line"   // 两边曲线形状不同
mix_params.ui_switch_time = crossfade_start_time + 2500
```

代价：**P3 的「分析 + 决策」没法白嫖**，要么等客户端接上，要么自研（服务端分析 + 缓存）。

### 那这一版做了什么（能落地、且为 P3 铺路的三件事）

**① 交叉曲线可选** —— 名字**故意对齐客户端的 `crossfade_line` 枚举**
（`equal`(默认) / `linear` / `s-line` / `r_s-line` / `exp` / `step`）。
哪天拿到它算好的计划，`crossfade_line` 可以**直接透传**，不用再翻译一层。
实现要点：淡出用 `f(1-x)` 而不是 `1-f(x)` —— 等功率的淡出是 `cos(θ)`，正好是 `sin` 的镜像；
写成 `1-sin` 就退化成线性补偿、中点塌 -3dB（正是 P2 要避免的毛病）。

**② 可选的高通扫频**（`window.__gpXfadeEq = true`，默认关：会明显改音色）。
交叉期间把出场的 A 从 20Hz 扫到 900Hz，把低频让给 B —— DJ 过渡的招牌手法。
链路改成 `src → gain → filter(highpass@20Hz) → 总线`，**常驻**插好：
平时 20Hz 高通≈直通，交叉时才去动 `frequency`。
为什么不临场插：给正在响的节点断线重连会有可闻的爆音。
扫频同样要复位（撤销/暂停/交接后拉回 20Hz），否则这一首会一直闷着。

**③ automix 探针**（`window.__gpProbe = true`，默认关、零成本）：
记 `abtest.getList` 的请求与回应、`audioplayer.*` 的**参数键名形状**（一变就打 `★ 形状变了`）、
以及没见过的命令名。三条任意一条命中 = 客户端把 automix 接上了 → 那时再走「复用它的计划」。
形状去重很重要：不然每个 `audioplayer.load` 都刷一行，真机日志会被淹掉。

### 验收

```
node test/harness.js  → 通过 415 项，失败 0 项（新增第 86 段 22 项）
node test/mutate.js   → 变异点 87 个，抓住 87 个，漏网 0 个
```

第 86 段覆盖：默认等功率中点 0.707 / linear 0.5 / s-line 前段压得更低 / step 前后分明 /
扫频只扫 A（20→900Hz、时长=交叉时长、日志 +扫频）/ 暂停后复位到 20Hz /
默认不扫频 / 探针默认不写日志 / 记请求形状 + 记回应 / 同形状只记一次 / 形状变了再记一次 / 新字段可见。

## ★ v1.3.1 —— 把「流式那一首」补成缓冲（补掉 1.2.1 的缺口）

### 缺口是什么

1.2.1 加了两级缓存（字节缓存 / 最近缓冲），但它们**只在缓冲路径上有效**：
`<audio>` 流式播放不产生 `AudioBuffer`，元素被切走之后什么都不剩。于是：

- 「随机播放听过的歌再切回来」→ 仍然从头拉一遍流（1~3s）;
- 流式播过的歌**永远当不了交叉的 B**（B 必须是缓冲）。

### 为什么不用「旁路录 PCM」

最直觉的做法是在元素那一路挂个 `ScriptProcessorNode` 把 PCM 抄下来（零额外下载）。
但它有三个真机坑：

1. 元素**暂停**时管线仍在拉数据 → 会抄进一段静音，时间轴错位（要么标记作废，要么精确跳过，都不稳）；
2. 用户**拖动**会产生空洞，必须整段作废；
3. `ScriptProcessorNode` 跑主线程，长曲子要抄 70MB，任何一次卡顿都影响播放。

而「用现成的取址链路再下一份 + 解码」复用了一条已经跑了几十个用例的路径，
行为可预测、可测。所以选了后者，代价是**一次 ~6MB 下载** —— 而这份内容本来也会被重放一遍。

### 实现要点

| 点 | 为什么 |
|---|---|
| 只听够 **8 秒**才补 | 路过一首不为它付一次下载；`livePlayedMs()` 用 `playClockStart/Stop` 维护，暂停不计 |
| **不碰预载槽** | `S.preload` 是「下一首」的专属槽；补缓冲走自己的 `promoteBusy`，抢槽会把链条打断 |
| **复用字节缓存** | 补之前先查 `hasCachedBytes()`（只查不复制），有字节就不下 |
| **同一套试听校验** | 付费/VIP 曲目只给 64s 片段 → 塞进缓存就是「下次播半首」，宁可放弃 |
| 补完进 `recentBufs` | 之后走 `startPreload` 的 `recentGet`：不下载也不解码；顺带能当交叉的 B |
| `window.__gpPromote = false` | 省流量 / 排查用 |

### 验收

```
node test/harness.js  → 通过 392 项，失败 0 项（新增第 85 段 13 项）
node test/mutate.js   → 变异点 84 个，抓住 84 个，漏网 0 个
```

第 85 段覆盖：听够 8s 才补 / 补完切回来不重新拉流（`el.load()` 计数不变）/
只听 5s 不补且一个字节都不多下 / 逃生开关 / 缓冲路径不参与 / 试听片段拒绝入库。

新增 4 个变异点（不补、不等 8s、补完不入缓存、片段照收）全部被第 85 段抓住。

## ★ v1.3.0 —— 交叉淡入淡出（P2）：把「接缝」变成「过渡」

### 要做的是什么

v0.4.1 起，B 被 `start()` 排在 A 的**结束采样**上 —— 0 间隙，但两首是「硬接」。
Spotify 的 crossfade 是另一回事：**B 提前开始，两边各走一条等功率曲线**。所以 P2 不是
在原有逻辑上加个淡入淡出，而是**在时间轴上把 B 往前挪**，并给两路各自的增益做自动化。

### 三个必须做对的地方

**① 等功率，不是线性。** 线性淡入淡出中点两条都是 0.5，功率只有 0.5（-3dB 的凹陷）——
听起来就是「接缝处音量掉一下」。所以：

```js
a[i] = rising ? Math.sin(th) : Math.cos(th);   // th = x/(N-1) · π/2
```

中点 0.707（≈-3dB），两路功率之和恒定。

**② 曲线只能打在自己的 gain 上。** 原来的音频链是 `source → S.gain(总线) → analyser → destination`，
`S.gain` 是**用户音量条**；在它上面做曲线 = 改用户的音量。所以每个 source（以及流式元素）
都插一层自己的 gain，淡入淡出走这层。

**③ 预约窗口必须跟着变宽。** 原来的窗口写死 `left ∈ [0.3, 1.5]s` ——
3s 的交叉要在还剩 3s 时就排，写死的窗口**永远进不去**。改成 `max(1.5, xf + 0.4)`。
（这也是为什么 P2 不能只加几行淡入淡出：窗口不放宽，功能根本不会被触发。）

### 时间轴（改这块前先读）

```
A:  ─────────────[ 淡出 xf 秒 ]──▶ A 结束（onended = 切歌时刻，UI 在这一刻推进）
B:                [ 淡入 xf 秒 ]────────────▶ B 结束
                  ↑ bStart = endCtxTime - xf
```

- `S.sched.startCtxTime` 存的是 **bStart**（不是结束时刻）→ 交接时
  `S.startCtxTime = sc.startCtxTime`，于是 `position()` 天然等于「B 已经播了 xf 秒」；
- A 的 `onended` 仍在 `endCtxTime` 触发 → 交接 / 认领 / 进度全部沿用 v0.4.1 的路径，**没有新增状态机**；
- 交接时 `S.srcGain = sc.gain`：B 的增益节点必须被接管，否则下一轮交叉的「淡出」会打在一个已经没人用的节点上。

### 边界与逃生

| 情况 | 行为 |
|---|---|
| `xfade = 0`（默认） | 完全走 v0.4.1：B 排结束采样、零曲线 |
| 只剩 1s 而设了 12s | 自动缩成 0.95s（宁可短暂也不排到过去） |
| 不足 0.5s | 视为关 |
| 超过 12s | 夹到 12s（Spotify 的上限） |
| 暂停 / 拖动 / 押错 | `cancelSched` / `abortSeamless` 复位增益（A→1，B→0）并停掉 B |
| B 没预载上 | 退回硬接（`<audio>` 没法采样级调度） |

设置持久化在 `localStorage["gaplessPlayer.xfade"]`，`window.__gpXfade` 改一次就会记住。

### 验收

```
node test/harness.js  → 通过 379 项，失败 0 项（新增第 84 段 41 项）
node test/mutate.js   → 变异点 80 个，抓住 80 个，漏网 0 个
```

第 84 段覆盖：默认关不冒交叉 / 窗口变宽 / 提前 3s 起播 / 两条曲线同刻等长 /
中点 -3dB / 不挂总线 / 持久化 / 交接后第二轮交叉仍正确 / 只剩 1s 自动缩短 /
12s 上限 / 暂停复位增益 / 0.3s 视为关。

新增 5 个变异点：`xf=0`（P2 失效）、线性替代等功率、曲线挂总线、撤销不复位、
交接不接管 B 的 gain —— 全部被第 84 段抓住。

## ★ v1.2.1 —— 裁剪分两层 + 去掉重复请求 / 重复下载

### 真机日志把 P0 的三个问题一次问清楚了

v1.2.0 首跑日志（`C:\betterncm\gapless-player.log`，01:55~01:57，6 条 `[trim]`）：

```
[trim] track=3363273168 ｜ LAME delay=576 pad=864 ｜ 理论=120.000s ｜ Δ=0.0ms ｜ 解码=120.000s ｜ 首=0.0ms 尾=40.0ms
[trim] track=3363273167 ｜ LAME delay=576 pad=1304 ｜ 理论=148.960s ｜ Δ=-0.0ms ｜ 解码=148.960s ｜ 首=0.0ms 尾=0.0ms
```

**结论 1：这台机器上 ffmpeg 已经把 priming / padding 裁干净了**（Δ=0、首=0）。
所以「照 LAME 声明值硬裁」= 每首切掉 13ms 真音乐 —— 上一版「用波形验、不猜」的设计被证实是对的。

**结论 2：那条 `尾=40.0ms` 不是填充，是作品自身的静音**（Δ=0 说明填充已被去掉）。
削掉它接缝更紧，但已经越过 Spotify gapless 的语义（它只削填充）→ 见「分层」。

**结论 3：同一个 id 的 `player/url` 和 `song/detail` 各打了**两遍 ——
`setCurrentPlay` 抢着解析一次（为了流式抢时间），`startPreload` 又解析一次。

### ① 裁剪分两层：填充必裁，作品静音默认不裁

```js
fitTrim(info, ab) → { enc: {...}, pad: {...}, note, deltaMs }
```

- `enc`（填充）：`Δ≈delay+padding` 时按声明值裁；**永远裁**；
- `pad`（作品静音）：`Δ≈0` 时把波形里探到的静音归到这里；**默认不裁**，
  `window.__gpTrimPad = true` 才一起削掉；
- 没有 LAME 头 → 无法区分，按波形裁但每边 ≤20ms（`enc` 档）。

日志把两笔分开写（排查时一眼看出削的是哪一层）：

```
填充=首13.1 尾22.7ms（必裁）｜ 作品静音=首0.0 尾40.0ms（不裁，__gpTrimPad 未开）
```

### ② 并发去重：`once(key, factory)`

同一个 key 的并发请求共享一个 promise，**失败也立刻清掉**（避免把一次失败记成永久结论）。
用在 `resolveUrl`（LibEAPI）、`resolveUrl320`、`resolveDurationMs` 三处。

⚠️ 验证台要能测出它，必须让假网络层**晚一个微任务**才回包（`env3x(..., { defer: true })`）——
同步回包的话两次请求根本不会重叠，测了等于没测。

### ③ 两级缓存：字节缓存（3 份）+ 最近缓冲（2 首）

| 缓存 | 键 | 上限 | 省掉 |
|---|---|---|---|
| 字节缓存 | trackId → ArrayBuffer | 3 份（约 6MB/份） | 取址 + 下载 |
| 最近缓冲 | trackId → AudioBuffer | 2 首 / 合计 ≤160MB | 下载 **+ 解码**（~600ms） |

- 字节缓存**只给预载用**：正常加载走客户端给的地址（3.x 是加密 token），
  拿缓存字节会绕过「试听片段」校验 —— 宁可少省一点也不能播半首；
- `decodeAudioData` 会 **detach** 传进去的 ArrayBuffer → 缓存里存的、交出去的都得是副本；
- 最近缓冲要先在 `startPreload` 里查（而不是只查 `loadSong`）：真机时序是
  `setCurrentPlay → maybePreload → load`，等 load 到了下载早就启动了 —— 晚了。

### 验收

```
node test/harness.js  → 通过 338 项，失败 0 项（新增第 82/83 段，第 81 段按分层重写）
node test/mutate.js   → 变异点 75 个，抓住 75 个，漏网 0 个
```

新增 5 个变异点：作品静音默认裁（越过语义）、并发去重失效、字节缓存永不命中、最近缓冲不复用、
以及原有的 P0 那 4 个。

## ★ v1.2.0 —— 首尾裁剪（P0）：把最后那 ~25ms 也削掉

### 要解决什么

v0.4.1 把接缝从 ~195ms 压到 0 之后，波形上还剩一段谁也看不见的东西：

```
MP3 解码出来 = [ encoder delay 静音 ][ 真正的音乐 ][ padding 填充 ]
                  ~13ms(576)          N samples        ~20ms
```

两首首尾相接时，这 25~40ms 是**多出来的静音**。听感上「听不出来」，
但它意味着「真无缝」还差最后一步 —— Spotify 的 gapless 就是把这个也裁掉。

### ★★ 关键实测事实：**不能照 LAME 声明值硬裁**

Chromium 底层是 ffmpeg，ffmpeg 的 mp3 解复用会读 LAME 标签并设置 `skip_samples`，
**解码时就把开头那段丢掉了**。也就是说 `decodeAudioData` 给回来的 buffer
可能已经是裁过的 —— 这时再按 LAME 声明值裁 13ms，**切掉的是真音乐**。

所以实现不猜：**用解码后的波形自己验**。

```js
// 只裁「真静音」：|x| < 1e-4（≈ -80 dBFS），并且每边有上限
var s = Math.min(silenceHead(ab, capS + 0.005), capS);
var e = Math.min(silenceTail(ab, capE + 0.005), capE);
```

- 解码器已裁过 → 开头第 1 个采样就是音乐 → `silenceHead` 返回 0 → **不裁**（不会吃音乐）；
- 解码器没裁 → 开头是一段真静音 → 裁掉它；
- 没有 LAME 头（二次转码）→ 只按波形裁，每边封顶 20ms；
- FLAC → 样本数精确，**一点都不裁**（多出来的静音是作者自己的）。

LAME 声明值（`delay` / `padding`）仍然解析，但只用来：① 定上限（有 LAME 头才敢裁到 40ms）、
② 打日志对拍 —— `[trim]` 里的 `Δ=` 是「解码时长 - 理论时长」：

| Δ | 含义 |
|---|---|
| ≈ 0 | 解码器已裁过（Chromium 正常情况） |
| ≈ (delay+padding)/sr | 解码器没裁，我们裁 |
| 其它 | VBR 帧数估算不准 / 文件被改过，仅供参考，不影响裁剪（裁剪只看波形） |

### 时间轴约定（改这块前先读）

- `S.trim = { start, end }`：**缓冲时间轴**上的裁剪量；
- `S.duration` / `position()` / `S.startOffset`：一律**可听时间轴**（= 缓冲时间轴 - `trim.start`）；
- 所以 `startSource(offset)` 必须换算：`src.start(at, offset + trim.start, S.duration - offset)`；
- **每一首的 trim 各自存**（`S.trimCache[trackId]`）：预约 B 时用 B 的，绝不能套用 A 的。

第三个参数 `duration` 不是可选的懒省事 —— 传了它，尾部填充不会被播出来，
`onended` 也正好落在「可听末尾」那个采样上，`[end]` 的时机才准。

### 踩到的坑（验证台抓到了，真机差点免重启排查）

`var ginfo` 一开始声明在 `.then(function (buf) {...})` 里，却在**下一个** `.then` 里用 →
`ReferenceError` → 被链尾 `.catch` 吞掉 → `slot.status = "failed"` → **预载 100% 失效、退回流式**。
验证台第 17/18/39 段立刻报红（「命中预载：没有再去下载」失败）。修法：声明提到 `startPreload` 函数作用域。

### 验证台 / 变异测试

- 新增第 81 段 18 项断言：没裁 / 已裁过不二次裁 / 无 LAME 头封顶 20ms / FLAC 不裁 / 逃生开关 / 预约带 B 自己的 trim；
- 用例里现造「带 Xing+LAME 头的 MP3 字节」与「首尾有真静音的假 AudioBuffer」，不依赖真文件；
- 新增 4 个变异点（裁剪恒 0 / 不验波形硬裁 / start 不加 trim / 预约不裁 B），全部被第 81 段抓住。

## ★ v0.4.2 —— 流式那一首也能预约（真机：卡 503ms → 几毫秒）

### 用户反馈

> 「手动点下一首可以做到无缝播放下一首即点即放，但是自然播完到下一首还是会卡一下」

### 真机日志里的完整证据链（v0.4.1，用户切歌单后听的第一首）

```
19:26:53.721  player.addListElement（换歌单）
19:26:53.734  setCurrentPlay        ← +13ms
19:26:53.736  开始预载（当前曲目）    ← 预载刚开始
19:26:53.846  audioplayer.load      ← 只隔 110ms → 预载根本来不及 → 走流式
19:27:04.304  [end] ★ 自然播完      ← 流式那首播完
19:27:04.752  [load]                ← +448ms（等 UI）
19:27:04.807  [play] source.start   ← **+503ms**
```

两层原因：

1. **v0.4.1 里流式那一首完全不参与预约** —— `maybeScheduleSeamless` 开头就是 `if (S.stream) return`。
   所以下一首**明明已经预载 ready**（日志里 `预载=3355459547/ready`），也用不上。
2. **为什么它会是流式**：切歌单后 13ms 就 `setCurrentPlay`、110ms 就 `load` ——
   新歌单第一首的预载根本来不及。所以「切歌单后的第一首」天然是流式。

### 解法：流式也预约，结束时刻用 `duration - currentTime` 推

```js
left = el.duration - el.currentTime;
endCtxTime = ctx.currentTime + left;
src.start(endCtxTime, 0);
```

**为什么够准**：Chrome 的 `HTMLMediaElement.currentTime` 是**按 `last_time_update` 插值**算出来的
（不是 250ms 一跳），误差只有几毫秒；而我们要排的只是 **1.5s 以内**的未来时刻，
媒体时钟与 AudioContext 的漂移也可以忽略。

**唯一不确定的是 `duration` 本身**（VBR / 流式 metadata 可能是估算值）→ 交接时还有一道兜底：

> 如果 `ended` 已经来了、而 B 还排在将来 **>30ms**，就换一个新节点「现在起播」。
> **宁可早 5ms，也不留一个空档。**

### ★ 交接时多一步：`S.stream = false`

顺序是命门：

```
playClockStop()
stopSource()        ← ★ 必须在这里（S.stream 还是 true → 才会把 <audio> 按住）
S.stream = false    ← ★ v0.4.2：从这一刻起由 B 的缓冲发声
S.source = sc.src   ← 提升 B
emitEnd()
playClockStart()
```

- `stopSource()` 放太晚 → `<audio>` 还在播 → **双声**
- `S.stream` 忘了置回 false → `position()` 还在读已经停住的元素 → **进度条卡住**

### 核验

- 验证台 **291 项断言 / 70 个场景**（新增 74~77：流式预约 / 流式交接 / 估晚兜底 / duration 无效不猜）
- 变异 **67 个，全部抓住**（新增 3 个：流式不预约 / 忘置 `S.stream` / 去掉估晚兜底）
- 包 == src（4 个文件逐文件 MD5）

### 仍然存在的一处代价

**冷启动第一首**（开机后第一首、或切到新歌单的第一首）还是流式 —— 那时没有预载可用。
但它**之后**的每一首都会接上缓冲链，所以只有「第一首 → 第二首」这一次过渡会走流式预约（现在也是几毫秒了）。

## ★ v0.4.1 —— 真无缝预约：把切歌间隙从 ~134ms 干到 0

### 起因：v0.4.0 已经「快」了，但不「无缝」

v0.4.0 真机验证通过（切歌 3.5s → ~0.5s），但量了一下**自然播完 → 下一首起播**的间隔：

```
14:38:53.637 [end] → 14:38:53.755 [play] source.start = 118 ms
14:42:08.659 → 14:42:08.803 = 144 ms
14:44:43.922 → 14:44:44.076 = 154 ms
14:49:07.156 → 14:49:07.287 = 131 ms
14:53:30.679 → 14:53:30.799 = 120 ms
16:00:03.988 → 16:00:04.126 = 138 ms
                                  平均 ≈ 134 ms
```

**这 134ms 不是下载造成的，是「等网易云 UI」**：`[end]` → +21ms `setCurrentPlay` → +121ms `audioplayer.load`
→ 再等 UI 发 `play`。预载命中省掉的是前面那 3.5s，但**起播时机仍然捏在 UI 手里**。

### ★★ 为什么只有缓冲路径能无缝

| | 怎么让下一首开始 | 什么时候真的出声 |
|---|---|---|
| 缓冲（Web Audio） | `B.start(T)`，T 是**正在播 A 的那个时钟**上的时刻 | 音频线程在**第 T 个采样**精确执行 → **0 间隙** |
| 流式（`<audio>`） | 只有 `B.play()` | `ended` + JS 事件循环 + 管线唤醒 ≈ 几十~几百 ms，**不可控也无法补偿** |

`<audio>` **没有**「指定起播采样点」的能力 → 全流式永远到不了 0。
（顺带：网易云原生播放器也不是真无缝 —— 它用 `AutoTrackChangeFadeIn/Out` 淡入淡出把间隙掩盖掉。）

### 做法：不等 UI，自己排

上一首还剩 **0.3~1.5s** 时（100ms tick 命中），自己建一个 `AudioBufferSourceNode`，
`src.start(上一首的结束采样, 0)` 排上去。UI 的 `load` 迟到 ~120ms 到达时，按 trackId **认领**（不重启）。

**三段状态机**（`S.sched.phase`）：

| 阶段 | 含义 | `S.source` | 关键动作 |
|---|---|---|---|
| `armed` | 已排上，A 还在播 | **仍是 A** | 什么都不做（★ 改了就发不出 `[end]`） |
| `live` | A 已播完、**B 已在响**、UI 还没 load（~120ms 窗口） | B | 抑制进度；等 load |
| `claimed` | UI 的 load 到了、已认领 | B | 等首个 play → 补发 `onPlayState(1)` |

**★★ 命门（两件事必须同时满足）**：

1. **预约阶段绝不能动 `S.source`** —— A 的 `onended` 守卫是 `src === S.source`，
   一旦改成 B，A 播完时守卫失败 → `onNaturalEnd` 不触发 → **不发 `[end]` → UI 永不推进**。
2. **交接时 `stopSource()` 必须在「提升 B」之前** —— 此刻 `S.source` 还是 A，只停 A；
   反过来写（先提升 B 再 stopSource）就会**把正在响的 B 停掉**。

验证台有**结构性变异 M1/M2** 专门守这两条。

### 三重闸门（全过才排）

1. **缓冲路径 + 在播**（流式那首拿不到精确结束时刻 → 不排）
2. **预载槽里正是「列表里的下一首」且 ready**（用 `peekPreloadBuffer` **只读不消费** ——
   用 `takePreload` 会清槽 + `preloadToken++`，导致① 押中率统计瞎了、② 对 B 重复预载）
3. **置信「顺序播放」**：`localStorage["NM_SETTING_PLAYER"].mode ∈ {playonce, playorder}`
   —— **能读到就一票定音**（⚠️ 单曲循环下 `seqStreak` 会冻结在高位，不能只信它）；
   读不到才退回 `seqStreak >= 2`
4. `S.sched === null`（没排过）+ 时间窗 [0.3, 1.5]s

### 撤销（六处挂载点）

`暂停` / `拖动` / `切歌`（setCurrentPlay 押错 → `abortSeamless`）/ `切歌单`（addListElement）/
`audioplayer.stop`（UI 切歌单时会发，**仍照旧放行给原生**）/ `startSource`（保险）。

- `armed` → `src.stop()`（start 在未来，stop 即取消，**不出声**）
- `live`/`claimed` → 只清标记（调用方自己决定要不要停声音）
- **押错** → `abortSeamless`：停掉已响的 B + 复位到「未就绪」，交回正常加载
  （真机时序：`setCurrentPlay` 比 `load` 早 ~120ms → **错歌只响 ~21ms**）

### 逃生开关

`window.__gpSeamless = false` → 完全不预约（退回 v0.4.0 行为，一行控制台即可）。

### 已知代价

**流式播的那一首 → 下一首仍是 ~195ms**（`<audio>` 拿不到精确结束时刻，无法预约）。
只发生在「链条断开处」（随机模式、开机第一首、押错时）；一旦接上缓冲链，后续每首都无缝。

### 核验

- 验证台 **275 项断言 / 66 个场景**（新增 61~73：闸门五种情形 / 交接不打断 B / 认领不重启 /
  三次 play / 押错收尾 / 四类撤销 / playedMs 归属 / live 抑制进度 / peek 不破坏语义）
- 变异 **64 个，全部抓住**（新增 12 个，含 M1/M2 两个**结构性变异**）
- 包 == src（4 个文件逐文件 MD5）

## ★ v0.4.0 —— 两条播放路径：能预载就缓冲（可无缝），不能就流式（快）

### 需求与最终结论

> 用户先问「能做流式播放吗」→「如果能做流式播放就不用分播放模式」→ 又追问
> 「全流式可以做到无缝衔接吗」「不能在当前这首快结束时开始预载下一首然后直接接上吗」

**答案是：全流式做不到无缝，所以做成两条路径。** 而且这不是推测 —— 这个项目的文件头第 8 行
早就写着原因：

> `<audio>` 一次只能播一个源、且**无法采样级调度**，所以做不到真无缝

「接上」那一步的区别只有一个词：**能不能指定「在哪个采样点开始出声」**。

| | 怎么让下一首开始 | 什么时候真的出声 |
|---|---|---|
| **缓冲（Web Audio）** | `B.start(T)` —— T 是**正在播 A 的那个时钟**上的时刻 | 音频线程在**第 T 个采样**精确执行 → **0 间隙** |
| **流式（`<audio>`）** | 只有 `B.play()` | `ended` 事件延迟 + JS 事件循环 + 媒体管线唤醒 ≈ **几十~几百 ms**，不可控也无法补偿 |

**「预载下一首然后直接接上」这个思路是对的 —— 但「接上」只有缓冲路径能做。**
所以预载必须留着，流式用来解决「没有预载可用时」的等待。两者互补，不是二选一。

### 实测：现在的版本**不是无缝**，还有 ~195ms

v0.2.10 真机日志，7 次自然播完（全部预载命中）：

```
[end] 播完 → [play] source.start  间隔 = 150 / 161 / 244 / 159 / 185 / 200 / 262 ms
                                      平均 ≈ 195 ms
```

而且这 195ms **不是下载造成的**，是**等网易云 UI**：
`[end]` → +39ms `setCurrentPlay` → +120ms `audioplayer.load` → 再等 UI 的 `play`。

代码侧确认：`startSource(offset, when)` 的 `when` 参数**一直是 0**，
**没有任何**「提前预约下一首」的代码 —— 文件头第 29 行写着「`start(when)` 留到 A1.5」。
→ **要真无缝，必须补上「预约」**（v0.4.1，见下）。

### 两条路径怎么分工（**按每首歌决定，不需要读播放模式**）

| 场景 | 走哪条 | 切歌表现 |
|---|---|---|
| 顺序播放 / 列表循环（预载押中） | 缓冲 | 0 等待（v0.4.1 起 + 预约无缝） |
| 随机 / 单曲循环 / 心动模式（押不中 → 自适应关预载） | 流式 | ~0.5s，**本来也不需要无缝** |
| 顺序播放但没押中 / 没来得及 | 流式 | ~0.5s（比原来的 3.5s 好得多） |
| **流式播的那一首 → 下一首** | 只能等 UI | ~195ms（`<audio>` 没有精确结束时刻，预约不了） |

★ 一旦进入「缓冲」的链条就会一直缓冲下去（每首都在播的时候把下一首预载好了）；
流式只出现在**链条断开处**（随机模式、开机第一首、押错时）。

### 流式路径的实现（照 LFP 的配方）

```js
S.el = new Audio();                              // ★ 不设 crossOrigin —— 照 LFP
S.el.preload = "auto";
S.el.volume = 1;                                 // 音量统一由 S.gain 控
S.mediaSrc = S.ctx.createMediaElementSource(S.el);
S.mediaSrc.connect(S.gain);                      // mediaSrc → gain → analyser → destination
```

- ★ **只建一个元素、只调一次 `createMediaElementSource`** —— 它对同一元素**只能调一次**
  （第二次抛 `InvalidStateError`）。切歌只换 `src`。
- ★ **`gain / analyser / destination` 完全没动** → **FFT / 可视化照常有效**。
- ★ **不设 `crossOrigin`**：跨域音频一旦被 taint，`MediaElementSource` 会输出**纯静音**；
  LFP 就是这么干的、而且它在真机上是**有声音**的 → 本机不存在这个问题。
  仍然加了**廉价自检**（见下）兜底。
- ★ **`onLoad` 必须等 `loadedmetadata`**（那时才有 `duration`），另加 **8s 超时兜底**
  （否则弱网时 UI 会一直转圈）。
- ★ **`loadProgress` 固定发 1**：真机踩过「发 0 → UI 一直转圈 + 暂停失灵」。
- ★ **换歌先摘旧事件**（`attachStreamEvents` 每次重新挂、换歌先 `detachStream()`）：
  元素的 `loadedmetadata`/`ended`/`error` **不告诉你**是哪一次 load 的，靠闭包捕获 token 判断过期。
- ★ **本地文件走 `betterncm.fs.mountFile(path)`** 拿 blob URL（LFP 的做法）。
- ★ **autoplay policy**：`el.play()` 返回 promise，被拒（`NotAllowedError`）时
  排队等**一次性手势监听**（`pointerdown`/`keydown`）命中再起播。两个坑：
  ① `doPlay()` 是**乐观**置 `S.paused = false` 的，而拒绝是**异步**的 →
  「手势重试」必须**绕过** `doPlay` 的「已经在播就忽略」守卫，直接调 `startPlayback()`；
  ② 迟到的拒绝会把手势监听重新挂上 → 用 `playGen` 代号忽略过期的那次。
- ★ **静音自检**（每 1s，几乎零成本）：`流式 + 在播 + currentTime 在涨 + 连续 ~2s FFT 全 0`
  → 判「疑似被跨域静音」→ 后续曲目自动退回缓冲路径。
  ⚠️ 已经进了 Web Audio 的元素**摘不出来**，所以自愈只能「下一首生效」。

### 逃生开关（控制台，改了立刻生效）

| 开关 | 作用 |
|---|---|
| `window.__gpStream = false` | 强制走缓冲（退回 v0.3.0 的播法） |
| `window.__gpNativeAll = true` | `audioplayer.*` 整条放行给网易云原生播放器 |
| `window.__gpLogVerbose = true` | 日志全量 |

### 顺带删掉：v0.3.0 的「按播放模式分流」

那套（非顺序模式交回原生）**已删**，因为：

- **键名写错了**：真身是 `NM_SETTING_PLAYER`，不是 `PLAYER`。
  当初在 leveldb 里搜到 `PLAYER` 就以为是键名 —— 那其实是 `NM_SETTING_PLAYER` 的**尾巴**
  （leveldb 的键是**前缀压缩**的，共享的 `NM_SETTING_` 被压掉了）→ **分流从未生效过**。
- 用户要的是「所有模式都由插件播」，只是**播法**不同。

只留了一个**手动逃生开关** `window.__gpNativeAll`（不是按模式分流）。

### 已知限制（如实写）

- **流式播的那一首没有无缝**（`<audio>` 拿不到精确结束时刻）→ 只有 ~195ms（等 UI）。
- 切歌从「预载命中 0 等待」变成「未命中 ~0.5s」—— 但**换来的是**：不再有 3.5s 的整首下载 + 解码，
  内存也不再持有 70~90MB 的解码缓冲。
- **`start(when)` 预约（真无缝）留到 v0.4.1**，见下。

### 验证

- 验证台 **229/229**（新增 51~60：走流式 / onLoad 等 metadata / 超时兜底 / play 被拒与手势重试 /
  换歌摘旧事件 / loadProgress=1 / 本地 mountFile / createMediaElementSource 只调一次 /
  静音自检 / 出厂默认）
- 变异 **51/51 干净抓住**（新增 9 个，含「手势重试走 doPlay」「不忽略迟到的拒绝」这种
  **从真机日志里挖出来的结构性 bug**）

## ★ v0.3.0 —— 按播放模式分流：只有「顺序播放 / 列表循环」才由插件播

### 需求

> 「只有顺序播放或列表循环才使用当前插件播放，其他时候使用网易云原来的方法播放」

### 为什么这么分

插件播的代价是**必须先把整首歌下完再解码**（`decodeAudioData` 要求完整文件），
真机实测切歌平均等 **3.5s**；换来的是「下一首可预测 → 预载秒开」。

而**随机模式下这个收益根本没有**（v0.2.10 实测 16 次预载 **0 命中**、白下 **1076 MB**）
→ 白等 3.5 秒。网易云原生的 C++ 播放器是**流式**的
（`audio_source_cache.cpp` + `audio_stream.cpp`，边下边解），切歌几乎立刻出声。

所以：**能预测下一首的模式**（顺序播放 / 列表循环）用插件；**不能预测的**（随机 / 单曲循环 / 心动模式）交回原生。

### ★ 播放模式怎么读：`localStorage` 的 `NM_SETTING_PLAYER`

> ⚠️ **更正（v0.4.0）**：这里原本写的是 `PLAYER`，**是错的**。真身是 `NM_SETTING_PLAYER` ——
> leveldb 的键**前缀压缩**，当初搜到的 `PLAYER` 其实是这个长键的**尾巴**。详见 v0.4.0 章节。

翻遍了 `channel.call` 的**全部命令**和 UI 注册的**全部事件**，**没有任何播放模式信号**：

| 看着像的 | 实际是 |
|---|---|
| `player.setLineMode` | **歌词行模式**（和 `setLRCColor` / `setFont` / `setOffset` 一组） |
| `player.updateTooltips` | **迷你播放器**的提示文字 |
| `play_mode` | 只出现在**埋点日志**里（`core.js` 的 `R.play_mode`） |

真正的位置在 `localStorage` —— 网易云自己就是这么存的（`core.js` 的 `dc.setting.hS()`）：

```
NM_SETTING_PLAYER → {"volume":0.229…,"autoplay":false,"mode":"playorder","speed":1,"mode2":…,"ntc":3,"time":…}
```

`core.js` 里的模式表（`s.order`）：

| 值 | 名字 | 图标 | 菜单 id | 谁播 |
|---|---|---|---|---|
| `playonce` | **顺序播放** | `icn_order` | 1043 | **插件** |
| `playorder` | **列表循环** | `icn_loop` | 1040 | **插件** |
| `playcycle` | 单曲循环 | `icn_repeat` | 1041 | 原生 |
| `playrandom` | 随机播放 | `icn_shuffle` | 1042 | 原生 |
| `playai` | 心动模式 | `icn_ai` | 1044 | 原生 |

⚠️ 还要复刻 `hS()` 的一个分支：**`mode3 && mode2` 时实际生效的是 `playai`**（名义模式被覆盖）。

**为什么直接读 localStorage 就够**：网易云切模式时就是 `localStorage.setItem("NM_SETTING_PLAYER", …)`
（`AE` → `O9` → `localStorage.setItem`），**同步、即时** → 每次要用的时候现读即可，**不需要事件**。

### ★ 怎么把播放交回去：`handle()` 返回 false

`installInterceptor` 里，`handle()` 返回 false 就走 `below.apply(...)` → 原生。

**原生确实实现了这几条命令** —— `cloudmusic.dll` 里 `audioplayer` 的方法表是：

```
enmeratorDevices / stop / setVolume / seek / play / load
```

`audioplayer.cpp` 里还能看到 `DoLoad` 读的正是 UI 传来的那几个字段
（`musicurl` / `dfsId` / `songId` / `fileSize` / `bitrate`），以及
`plugin::Player::SetSrc`、`'loading'/'buffering'/'playing'/'ended'/'paused'/'stopped'`、
`audio_visualizer_process.cpp`（`audioplayer.onAudioData`）、
`AutoTrackChangeFadeIn/Out`（自动切歌淡入淡出）。
`pause` 则是 LFP 和本插件**启动时就在用**的（「把原生播放器按住」，否则会和 Web Audio 叠成双声道）。

### 三个必须处理的细节

1. **放行前先停掉我们自己的 source** —— 否则两边同时出声（双声道）。
2. **从原生切回插件时通知原生 `audioplayer.stop`** —— 否则它还在放上一首。
3. **放行模式下不预载**（`maybePreload()` 直接 return）—— 原生在播，预载纯属白下。

### 三个控制台开关（不用出包，改了立刻生效）

| 开关 | 作用 |
|---|---|
| `window.__gpModeRoute = false` | 关掉分流，退回 v0.2.10（全部由插件播） |
| `window.__gpForceNative = true` | 强制走原生（排查用） |
| `window.__gpForcePlugin = true` | 强制走插件（排查用） |

⚠️ 模式**读不到**时保守选「插件播」（插件一定能播）。

### 真机旁证

装 v0.3.0 之前的那个会话（v0.2.10，15:26 起）日志里 `[list]` 的索引是
`0,1,2,3,4,5,6,7,8` **顺序递增**，且 `命中！跳过下载` 有 **9 次** ——
说明当时是列表循环模式、预载正在正常工作。而 leveldb 里那一份就是
`"mode":"playorder"` —— 完全对得上。

### 验证

- 验证台 **214/214**（新增 44~50：两种模式由插件播 / 三种放行 / 保守与开关 / 放行不预载 / 切回时停原生）
- 变异 **50/50 干净抓住**（新增 8 个）
- 顺带把验证台**加固**了：`last()` 返回 null 时直接 `.args[0]` 会把验证台**搞崩**（退出码 2），
  那样变异体是「崩了」而不是「干净报红」。加了 `argAt()` / `at()` / `lastOf()` 三个安全取值函数。

## ★ v0.2.10 —— 随机播放下不再白下「下一首」（自适应）

### 起因：用户问「预载下一首对随机播放是不是无效？」

拿 45 分钟真机日志（v0.2.9，`gapless-player.log` 22:27~23:12，900 行）实测 —— **是「无效」，而且是零命中**：

| 指标 | 数值 |
|---|---|
| `预载（下一首）` 次数 | 16 |
| `★★ 命中！跳过下载` | **0** |
| `预载就绪（下一首）`（真下完了） | 14 |
| **白下流量** | **1076 MB**（平均 76.9 MB/首） |
| 切歌实际等待 | **平均 3482 ms**（一点没省到） |

最硬的证据：只看**自然播完 → 自动续播**（排除「用户手动乱点」），13 次**全部没中**：

```
预载了 493275349   → 实际自动播到 460043667   ❌
预载了 518895654   → 实际自动播到 1931280236   ❌
预载了 1990743306  → 实际自动播到 25706282     ❌   …（13 次全一样）
```

### 根因

`nextTrack()` = `playlist[playlistIndex() + 1]`，**只在顺序播放成立**。
随机模式下下一首由网易云客户端自己挑，与 `player.addListElement` 给的列表顺序无关 ——
真机里当前曲目的索引是 `857 / 595 / 628 / 179 / 900 / 331 / 865 / 514 / 62 …`，完全随机。

### ★ 决定可行性的发现：网易云切歌前**不预告**下一首

逐个曲目核对「它的 id 在日志里**首次**出现的时刻」= `player.setCurrentPlay` 那一刻，
距 `audioplayer.load` 只有 **~80ms**。

→ 「在随机模式下预载得**更准**」**做不到**；唯一出路是「**别预载**」。

### 改法：自适应（不需要知道网易云的随机状态）

1. **结算押中率**：`setCurrentPlay` 时看预载槽里那首是不是要播的（`notePrediction`）。
   ⚠️ 必须赶在 `maybePreload()` **之前** —— 它会 `startPreload(当前曲目)` 把预测槽换掉，
   换掉之后就再也看不出押没押中。
2. **连续 3 次押不中** → `preloadNextOff = true`，不再预载下一首。
   **保留「预载当前曲目」**（那条是知道要播才下的，有用）。
3. **重新打开只靠免费信号**（`notePlayOrder`）：连续 2 首在列表里**索引相邻**。
   随机播放下这个概率 ≈ 1/列表长度（真机 900 首）→ 基本只可能是顺序播放，
   **不用再白下一首去试探**。
4. 只有 `why === "下一首"` 才算「预测」——「预载当前曲目」是我们**已经知道**要播的。

### 为什么砍掉是**零代价**的

随机模式下预载从未命中 → 切歌等待时间不会变差（本来就是 3.5s），
纯粹省下 **1 GB / 45 分钟** 的流量，外加白解码的 70~90 MB 内存。

### 顺带修的日志 bug

`[list] 当前曲目 track=X ｜ 索引=… ｜ 下一首=…` 里的索引/下一首原来是**上一首的** ——
v0.2.7 把 `S.curTrackId = tid` 挪到了这行日志**之后**，而 `playlistIndex()` / `nextTrack()`
读的正是 `S.curTrackId`。排查时会被误导。现在两者都接受可选 `id`，日志里显式传 `tid`。

### 验证

- 验证台 **188/188**（新增 40 随机播放关闭 / 41 why 判定 / 42 免费恢复 / 43 日志 bug）
- 变异 **42/42 干净抓住**（新增 8 个，含「结算时机错」这种结构性变异）

## ★ v0.2.9 —— 主动下线「位置记忆」：只记歌，不记进度

### 决定

> 「回退到 0.2.4，之后不需要做记忆时间的功能」

**记忆回到 v0.2.4 的形态：payload 只有 `{ id, t }`（哪首歌 + 写入时刻），不再记播放位置。**

### 删掉了什么

| 删掉 | 原来是什么 |
|---|---|
| payload 里的 `pos` | v0.2.5 加的位置字段 |
| 开机续播 | `resumePos` / `resumeTrackId` + `onBufferReady` 里那段（含边界判断） |
| 暂停 / 拖动 / 播放中周期 的位置落盘 | v0.2.5 加的三处 |
| 「同一首沿用旧 pos」规则 | `lastSaved`（那是为了保住 pos 才有的） |

### ★ 但**没有**回退到「v0.2.4 的行为」，这一点很重要

严格回退到 v0.2.4 会把一个坑带回来：**网易云开机那串恢复会冲掉记忆** ——
`setCurrentPlay` 带的是**它自己恢复的歌**，v0.2.4 照记，于是文件变成「固定一首歌」。
这个坑从 v0.2.3 就有，v0.2.7 才修掉。

所以这一版**保留了跟「位置」无关的全部修复**：

| 保留 | 它修的是什么坑 |
|---|---|
| **开机保护窗口**（v0.2.6/0.2.7） | 网易云整串恢复（`setCurrentPlay → load → seek`）不许写记忆 —— **没有它，记歌也不稳** |
| **AbortController**（v0.2.5） | 作废预载时真掐断在飞下载（不再白下 97MB） |
| **日志瘦身**（v0.2.8） | 只写排查用得上的，噪音挂 `LOG_VERBOSE` |
| **开机读取竞态守卫**（v0.2.7） | 异步读记忆时若已写过，忽略这次读取 |

结果：**只记歌，而且记歌真的稳。**

### 兼容

老记忆文件里还带着 `pos` 字段 → **直接忽略**，不报错、也不续播。

### 验证

- 验证台 **166/166**（删掉 6 个位置相关场景；测试 30 改成「payload 只有 id/t + 老记忆的 pos 被忽略」；
  测试 39 改成「点自己那首 → 关窗 + 命中预载」）。
- 变异 **34/34 全部干净抓住**（删掉 9 个引用已删代码的僵尸变异，新增 1 个
  「payload 里塞回 pos」；修 1 个锚点）。
- 出包 `GaplessPlayer-0.2.9.plugin`（解压后逐文件 MD5 == src，VERSION == manifest == 0.2.9）。

### 待真机验证

1. 重启后 `cat C:\betterncm\gapless-player.lasttrack.json` → 应该只有 `{"id":…,"t":…}`（**没有 pos**）。
2. 记忆仍不被网易云的恢复冲掉：`[mem] 开机保护窗口已开` +
   `[mem] ★ 开机恢复（网易云自己挑的…）→ 窗口保持…`，文件里的歌不变。
3. 点自己那首 → `[preload] ★★ 命中！跳过下载 + 解码`（秒开）；起播位置是 **0**（不续播，符合预期）。

## ★ v0.2.8 —— 日志瘦身：只写排查用得上的（砍掉 57%）

### 起因

> 「修改 log 文字生成部分，改成只写入当前需要的」

真机一次开机 **256 行**，其中 **147 行（57%）是噪音**，把要看的淹了：

| 类别 | 行数 | 说明 |
|---|---|---|
| `[call] 首次出现命令：xxx` | 86 | 开机把网易云所有命令名刷一遍 |
| `[call] ▶ player.*`（UI 设置类） | 33 | `setInfo` / `setCover` / `setMiniPlayerInfo`… 跟播放无关 |
| `[intro]` 注册表逐条 dump | 28 | 每次启动重复 3 遍 × 10 行 |

→ 改完预计 **256 → 109 行**。

### 改法：一个开关 + 收窄一个正则

```js
var LOG_VERBOSE = false;   // 默认只写用得上的

function logVerbose() {    // 噪音走这里
  var on = LOG_VERBOSE;
  if (!on) { try { on = !!window.__gpLogVerbose; } catch (e) { on = false; } }
  if (!on) return;
  log.apply(null, arguments);
}
```

- **默认写**：`banner` / `[env]` / `[ctx]` / `[fft]` / `[guard]` / `[boot]`、
  `[mem]` / `[resume]` / `[preload]` / `[fetch]`、
  `[list]` / `[cmd]` / `[load]` / `[play]` / `[pause]` / `[seek]` / `[emit]` / `[prog]` / `[hb]` / `[vol]`
- **默认不写**（走 `logVerbose`）：上面那三类。
- `[call] ▶` 的正则从 `/player|audio|play|pause|seek|vol/i` **收窄**成
  `/^audioplayer\.|^player\.(setCurrentPlay|addListElement)$/` —— 只留跟播放/预载真正相关的。
- `[intro]` 两行摘要**合成一行**（原来 3 次启动 × 2 行）。

### 想看全量怎么办

- **不用重新出包**：控制台里 `window.__gpLogVerbose = true`，立刻开始写全量。
- 或者把 `LOG_VERBOSE` 改 `true` 重新打包。

### 验证

- 验证台 **182/182**（测试 9b 重写成「默认不写噪音 + 开 verbose 照常写」）。
- 变异 **43/43 全部干净抓住**（新增 2 个：开关失效 / 正则又放宽）。
- 出包 `GaplessPlayer-0.2.8.plugin`（解压后逐文件 MD5 == src，VERSION == manifest == 0.2.8）。

## ★ v0.2.7 —— 保护窗口「补完」：网易云的自动恢复播放也拦下来

### 真机反馈（v0.2.6 之后）

> 「gapless-player.lasttrack.json 在播放时与关闭后写的都没有问题，但在重新启动后会自己修改回固定歌曲的固定时间」

### v0.2.6 只挡住了一半

当时 16:40 那一轮的日志备份（v0.2.6-bug）（16:40 那次）：

```
43.032 [mem] ★ 开机恢复（网易云自己挑的）｜ track=20944203 → 记忆与预载槽都不动   ← 记忆挡住了 ✅
43.082 [preload] 开始预载（当前曲目）｜ track=20944203                          ← 预载还是被抢了 ❌
43.084 [preload] 已掐断（作废/换槽）｜ track=1441581262
54.845 [call] ▶ player.setCurrentPlay ｜ args=[20944203_1_3136952023]  ← 还是「恢复」，不是用户
54.994 [call] ▶ audioplayer.load ｜ args=[20944203_...]              ← 网易云在自动播它那首
54.994 [mem] 第一次真正加载 → 开机保护窗口关闭                        ← 窗口关太早 ❌
54.995 [mem] 记住当前曲目 ｜ track=20944203 ｜ pos=0.0s ｜ 来源=加载   ← 记忆被写回网易云那首
54.996 [call] ▶ audioplayer.seek ｜ args=[…, 180.61999999999998]     ← 连它自己的进度也恢复了
54.997 [mem] 记住当前曲目 ｜ track=20944203 ｜ pos=180.6s ｜ 来源=拖动
```

**关键认知**：网易云的开机恢复是**一整串** —— `setCurrentPlay` → `load` → `seek`，
不是单独一个 `setCurrentPlay`。v0.2.6 拿 `audioplayer.load` 当「用户真的开始听了」的判据，
**而这个 load 恰恰也是恢复流程的一部分**。

### 三处漏洞，一起补

1. **`player.addListElement` 分支也会调 `maybePreload()`** —— 它拿到的是 `S.curTrackId`
   （已被恢复那首污染）→ 把「记忆那首」的预载掐断。
   → 窗口内**不再更新 `S.curTrackId`**（恢复的那首不算「当前曲目」），这一路自然就断了。
2. **窗口的关闭条件改了**：不再看 `load`，改成
   **用户切到别的歌**（≠ 恢复那首）或 **实际播放累计 ≥ 10s**
   （恢复那串是毫秒级的，能连续播 10 秒只可能是人在听）。
3. **窗口内 `loadSong` / `doPause` / `doSeek` 都不写记忆** —— `load` 和 `seek` 都是恢复流程的一部分。

### 顺带逮到一个真 bug：开机读记忆的「竞态」

`bootFromMemory()` 读文件是**异步**的。如果读返回之前插件已经写过记忆
（真机上 fs 慢的时候同样会发生），这次「开机读取」读到的就是**刚写进去的值** →
误判成「有开机记忆」→ **误开保护窗口** → 后面的正常记账全被吞掉。

```
[mem] 记住当前曲目 ｜ track=1000 ｜ 来源=选中 ｜ 已写文件     ← 先写了文件
[mem] 读到开机记忆（来自文件）｜ track=1000                  ← 异步读才回来，读到的是刚写的
[mem] 开机保护窗口已开                                      ← 误开
```

→ 加了守卫：`if (S.lastSaved) { 忽略这次读取 }`。

### 修完之后的行为

| 场景 | 结果 |
|---|---|
| 重启，网易云只恢复、不播 | 记忆完全不动 ✅ |
| 重启，网易云自动播它那首 | 记忆不动（≤10s 内你切走的话）✅ |
| 重启，网易云自动播它那首，你听了 ≥10s | 判定你在听它 → 关窗记账 ✅ |
| 重启后点**自己那首** | 关窗 → **位置保住**（同一首沿用旧 pos）→ 命中预载 + 续播 ✅ |

### 验证

- 验证台 **178/178**（测试 25 扩写「恢复是一整串」；新增 38「≥10s 关窗」、39「点自己那首」）。
- 变异 **41/41 全部干净抓住**（新增 8 个 v0.2.7 变异；删掉 2 个僵尸条目、修 2 个锚点）。
- 出包 `GaplessPlayer-0.2.7.plugin`（解压后逐文件 MD5 == src，VERSION == manifest == 0.2.7）。

### 待真机验证

1. **只恢复不播**：重启后 `cat C:\betterncm\gapless-player.lasttrack.json` 应**还是重启前那首**。
2. **自动播了也拦得住**：应看到 `[mem] 窗口内收到 load …→ 不写记忆` +
   `[mem] 窗口内 seek → 不写记忆`，记忆不变。
3. **点自己那首**：`[mem] 用户切到别的歌（track=… ≠ 开机恢复 …）→ 开机保护窗口关闭` +
   `[preload] ★★ 命中！` + `[resume] ★ 开机续播 ｜ 从 …s 起`。
4. **真听了 ≥10s**：`[mem] 窗口内已连续播放 ≥10s → 判定用户真的在听这首 → 开机保护窗口关闭并记账`。

## ★ v0.2.6 —— 开机保护窗口：网易云的「恢复」不再冲掉记忆

### 真机反馈

> 「在网易云运行时，gapless-player.lasttrack.json 里的歌曲、时间写的内容都是对的，关闭网易云后内容依旧正确，
> 但在重新启动后 gapless-player.lasttrack.json 的内容会改成固定另外一首歌中固定的一个时间」

### 日志（v0.2.5-bug 备份，全程 **0 个** `audioplayer.load`）

```
39.669 [mem] 读到开机记忆（来自文件）｜ track=2758269319 ｜ pos=121.2s   ← 文件是对的
39.669 [preload] 开始预载（开机记忆）｜ track=2758269319                 ← 正确那首开始下
41.453 [call] ▶ player.setCurrentPlay ｜ args=[1981999919_1_3136952023]  ← 网易云自己恢复的
41.455 [mem] 记住当前曲目 ｜ track=1981999919 ｜ pos=0.0s ｜ 来源=选中   ← 把正确记忆冲掉了
41.457 [preload] 已掐断（作废/换槽）｜ track=2758269319                  ← 正确那首的下载被掐断
43.645 [preload] ★★ 预载就绪 ｜ track=1981999919 ｜ 96.95 MB             ← 白下 97MB
```

**一次开机干了三件坏事**：记忆被冲掉、正确那首的预载被掐断、白下 97MB —— 而这次会话**根本没播放过**。

### 根因：开机时的 `player.setCurrentPlay` 不是「用户选歌」

它是**网易云自己恢复的那首歌**，而网易云的持久化状态跟我们的拦截**没关系**，
所以它**不等于**用户上次听的那首。真机历次对照：

| 会话 | 文件里的记忆 | 网易云开机恢复的 |
|---|---|---|
| v0.2.4（21:59） | `3439759764` | `2611706183` ← 不一样 |
| v0.2.5（16:29） | `2758269319` @121.2s | `1981999919` ← 不一样 |

而 v0.2.2 的设计前提是「一旦 `setCurrentPlay` 给出真曲目，预载槽会被 token 换掉」——
**这个前提是错的**。于是形成恶性循环：网易云恢复 B → 我们记 B → 下次开机又按 B 预载 → **永远固定在同一首错歌上**。

### 改法：「开机保护窗口」

读到记忆后开一个窗口，**窗口在本次会话第一次 `audioplayer.load` 之前一直开着**。
窗口内 `player.setCurrentPlay` 一律：

1. **不写记忆**（只打一行 `[mem] ★ 开机恢复（网易云自己挑的，不是用户选的）…`）；
2. **不调用 `maybePreload()`** —— 保住「记忆那首」的预载槽，别让它在开机 2 秒内被掐断。

窗口关闭的时机 = **第一次真正 `audioplayer.load`**（说明真的开始播了，往后的选歌才算用户行为）。

⚠️ 只有**读到了记忆**才开窗口 —— 没记忆就没什么可保护的，保持旧行为
（否则「没记忆时开机预载第一首」这条 A1.5 规则会失效，验证台测试 24 盯着这个）。

### 修完之后，用户点自己那首歌会怎样

- 开机预载的是**记忆那首**（不是网易云恢复的那首）→ 用户点它 → **命中，秒开**；
- `onBufferReady` 里 `curTrackId === resumeTrackId` → **续播位置照样生效**。

也就是：网易云恢复它的，我们保住用户的那首。

### 验证

- 验证台 **164/164**（测试 25 重写为「保护窗口」的新意图；测试 37 的「换预载目标」改为先真加载一次再换）。
- 变异 **35/35 全部干净抓住**（新增 4 个：窗口默认开着 / 读到记忆不开窗 / 加载后不关窗 /
  `setCurrentPlay` 无视窗口）。
- 出包 `GaplessPlayer-0.2.6.plugin`（解压后逐文件 MD5 == src，VERSION == manifest == 0.2.6）。

### 待真机验证

1. **记忆不被冲**：重启后应看到
   `[mem] 读到开机记忆（来自文件）…` → `[mem] 开机保护窗口已开` →
   `[mem] ★ 开机恢复（网易云自己挑的，不是用户选的）｜ track=… → 记忆与预载槽都不动`，
   然后 `cat C:\betterncm\gapless-player.lasttrack.json` **应该还是重启前那首**。
2. **点自己那首**：日志应出现 `[preload] ★★ 命中！跳过下载 + 解码` +
   `[resume] ★ 开机续播 ｜ track=… ｜ 从 …s 起`。
3. **窗口会关**：一旦真的播了，应看到 `[mem] 第一次真正加载 → 开机保护窗口关闭`，
   之后切歌照常有 `[mem] 记住当前曲目 … 来源=选中`。

## ★ v0.2.5 —— 开机续播上次位置 + 作废时真掐断下载

### 真机反馈

> 「目前 v0.2.4 没发现什么问题，继续更新」
> 「记忆的歌对了，时间好像没有记忆」

### 问题 ①：歌记住了，进度没记住

记忆文件里只有 `{ id, t }` —— **没有「播放位置」这个字段**。
位置只活在内存变量 `S.pausedAt` 里（`doPause` 时记下、`doPlay` 时拿它起播），**进程一关就归零**。
真机日志（v0.2.4b 备份的前一轮）：

```
上轮 [pause] ★ 已停 ｜ 停在 82.851s
重启 [play] source.start ｜ at=0.020 ｜ offset=0.000    ← 歌对了，进度从 0 开始
```

⚠️ 注意：这个位置**不是「网易云要的」**，是**我们自己的记忆**。
真机日志里 `audioplayer.load` / `play` 的入参都没有位置，也没有随后的 `seek`。

### 改法 ①：payload 扩成 `{ id, pos, t }`

- **存位置的时机**：暂停（最强信号）、拖动进度、播放中每 ~30s 兜底一次。
- **开机衔接**：只在「记忆那首」**第一次就绪**时把起播位置换成 `pos`，
  并赶在 `emitProgress` 之前设好 `S.pausedAt`（否则进度条会先报 0 再跳）。
- **边界**：`pos < 3s` 或 `pos > 时长 - 3s` → 视为不可用，老实从 0 开始。
- **坑**：开机时 `player.setCurrentPlay` 和 `audioplayer.load` 各会记一笔记忆。
  如果它们无脑把 `pos` 写 0，**刚读出来的位置还没用上就被抹掉** ——
  所以 `saveLastTrack` 加了一条规则：**同一首歌沿用文件里已有的位置，换歌才归零**。

### 问题 ②：「作废」其实是句空话

`fetchBytes` 以前是裸 `fetch(url)`，作废只靠 `preloadToken++` 在各个 `.then` 检查点丢结果 ——
**在飞的网络下载照跑到底**。真机日志实证（开机预载 3439759764，size=28057800）：

```
43.283 [preload] 地址来自 player/url ｜ size=28057800
43.380 [fetch] status=200 ｜ CL=28057800
43.814 [mem] 预载的 3439759764 不在新歌单里 → 作废（不白下）   ← 此刻已作废
45.253 [fetch] ★ 26.76 MB ｜ 1971ms                        ← 可 26.76MB 还是下完了
```

省掉的只是「解码 + 占内存」，带宽照样白花。跨歌单启动时每次白下 ~26MB。

### 改法 ②：`AbortController`

- `startPreload` 建 `AbortController`，`fetchBytes(url, signal)` 带上 signal。
- 新增 `dropPreload(why)` 统一「abort + 清槽 + token++」，**作废和换槽都走它**。
- 换预载目标时，也先掐断上一个在飞的。
- `AbortController` 拿不到（老 webview）→ 安静退化成旧行为，**不抛错**。
- `AbortError` 是**预期内**的，只打一行 `[preload] 已掐断`，不算失败。

### ★ 顺带修掉一个「假绿灯」：变异测试一直在空转

发现 `test/mutate.js` 的判定写的是 `r.code !== 0`，而它靠 `spawnSync` 开子进程跑验证台。
本机（Windows 沙箱）**spawn 子进程会直接 EBUSY**（连 `cmd.exe` 都起不来）→
`status` 是 `null` → `null !== 0` **恒真** → **不管验证台红不红都报「抓住了」**。

改法：`mutate.js` 改成**同进程内** `await require('harness.js')`（harness 导出它的 main() promise），
并且**先确认验证台真的跑起来了**（有输出、且不是自己崩了）才判定。
顺带把 `process.exit(1)` 换成 `process.exitCode = 1`（同进程跑时不能真的 exit）。

### 验证

- 验证台 **160/160**（新增 8 个场景：续播生效 / 边界回退 / 只认记忆那首 / 暂停落盘 /
  拖动落盘 / 心跳落盘 / payload 结构 / 作废真掐断）。
- 变异 **31/31 全部干净抓住**（新增 11 个：续播不生效 / 不校验曲目 / 不校验边界 /
  同曲不沿用旧 pos / 暂停不落盘 / 拖动不落盘 / 心跳不落盘 / payload 不带 pos /
  作废不掐断 / 换槽不掐断 / fetchBytes 不传 signal）。
- 顺手让两处「变异体把验证台搞崩」变成**干净报红**：
  用例里 `JSON.parse(文件)` → `memOf()` 容错；注册表下标访问前先 `|| {}`。
- 出包 `GaplessPlayer-0.2.5.plugin`（解压后逐文件 MD5 == src，VERSION == manifest == 0.2.5）。

### 待真机验证

1. **续播**：播一首 → 拖到中段 → 暂停 → **重启网易云** →
   应看到 `[mem] 读到开机记忆（来自文件）… pos=…`、`[mem] 开机续播已排队`、
   `[resume] ★ 开机续播 ｜ track=… ｜ 从 …s 起`，且 `[play] source.start ｜ offset=…` 不是 0。
2. **掐断**：开机记忆那首**不在**当前歌单里时，应看到
   `[mem] 预载的 … 不在新歌单里 → 作废（已掐断下载）` + `[preload] 已掐断（作废/换槽）`。
3. **老记忆兼容**：升级前那份记忆没有 `pos` 字段 → 应能正常读（`pos=0.0s`），不报错。

## ★ v0.2.4 —— 开机记忆「切歌单就作废」+ 诊断信息补足

### 真机反馈

> 「播放之前的歌单则固定在之前那一首的固定时间，切换歌单后直接没有记忆，没有歌在显示在播放」

### 日志（v0.2.3 备份）说明的事

**这次会话里其实没有发生播放。** 整份日志只有 6 秒（21:50:28 → 21:50:34），
没有任何 `player.setCurrentPlay`、没有 `audioplayer.load`、没有一条 `[hb]` 心跳
（文件 mtime 停在 21:50:34，网易云进程当时也已关闭）。
对照健康的 v0.2.1 会话（21:21:20 起，跑了 12 分钟）：`addListElement` 之后 11ms 就来
`setCurrentPlay`，然后 `audioplayer.load` → `play` → 每 10s 一条心跳。
所以「记忆更没更新」**从这份日志里判断不了** —— 没有播放，就没有东西可记。

但日志暴露了一个**真实的设计缺陷**：

```
[mem] 读到开机记忆（来自文件）｜ track=1318288373 ｜ 写入于 10/13/2026, 9:50:20 PM
[preload] 开始预载（开机记忆）｜ track=1318288373
[preload] ★★ 预载就绪（开机记忆）｜ track=1318288373 ｜ 232.0s ｜ 84.95 MB
[list] 播放列表更新 ｜ 33 首 ｜ 当前索引=-1        ← 用户切到「每日歌曲推荐」
```

**开机记忆里的 `1318288373` 根本不在这个 33 首的新歌单里** —— 插件照样把它整首下完
（22 MB），纯浪费。这正是「切歌单后没有记忆」的来源：**记忆是上一份歌单的，跟当前歌单没关系。**

### 改法

1. **切歌单时校验记忆**：`player.addListElement` 到达时，检查预载槽里那首在不在新列表里；
   不在就**作废**（清槽 + 递增 `preloadToken` 让在飞的下载自动失效），并打日志。
2. **诊断信息补足**（这次最缺的就是「看不出记忆有没有在更新」）：
   - `[list]` 行加 `｜ 首曲=… ｜ 预载中的 X 在本列表=是/否`
   - `[mem]` 行加 `来源=选中 / 来源=加载`（区分是哪条路径写的）
   - **心跳加 `｜ 记忆=… ｜ 预载=track/status`** → 每 10 秒都能看到记忆状态，一眼判断更没更新
   - `saveLastTrack` 在 `trackId` 为空时也会打一行（不再静默 return）

### 验证

- 验证台 **132/132**（新增 28：切歌单作废过期预载 / 保留有效预载；29：记忆日志来源 + 心跳带记忆）
- 变异 **20/20**（新增：切歌单不作废 / 记忆日志不写来源）
- ★ 顺带：「版本号 == manifest」那条断言**当场抓住**了我改 main.js 忘了改 manifest —— 断言有用。

### 待真机验证（这次请务必包含「播放」）

1. 开机 → **播 3~4 首不同的歌**（可以在两个歌单之间切）→ 看日志里
   `[mem] 记住当前曲目 ｜ track=… ｜ 来源=…` 是不是**每首都出现、track 在变**。
2. 看 `[hb]` 行里的 `记忆=` 是不是跟着变。
3. 重启 → `[mem] 读到开机记忆` 应该是**最后播的那首**。
4. 切歌单时若看到 `[mem] 预载的 X 不在新歌单里 → 作废`，说明新逻辑生效了。

---

## ★ v0.2.3 —— 两处真凶：函数改名漏改调用点 + 记忆存错了地方

### 真机反馈

> 「这个开机记忆在我切换了几首后重启还记忆的是固定的一首的固定时间」

日志（已备份 v0.2.2）里两处不对劲：

```
21:39:15.431 === GaplessPlayer v0.2.1 (A1 预载) 启动 ===        ← 装的是 0.2.2，横幅却写 0.2.1
...
21:39:17.138 [list] 播放列表更新 ｜ 35 首 ｜ 当前索引=-1
21:39:17.138 [guard] ★ handle(player.addListElement) 抛错 ｜ ReferenceError: maybePreloadNext is not defined
```

### 根因 ①：函数改名漏改调用点（硬 bug）

`maybePreloadNext` 在 v0.2.2 里改名成了 `maybePreload`，但 `player.addListElement`
分支还调旧名 → **每次列表更新都抛 `ReferenceError`**。

为什么之前没发现：`handle()` 外面套了 `try/catch`，抛错只留一行日志；
而且 `S.playlist = songs;` 在抛错**之前**就赋值了 → 预载看起来还是好的 → 验证台全绿。
（`[list] 播放列表更新 ｜ 35 首` 说明 JSON 解析是对的，坑就在后面那句调用。）

### 根因 ②：记忆存在 `localStorage` 里，会被强杀进程丢掉

NetEase 的 webview 里 `localStorage` 是**异步落盘**的：强制结束进程会丢掉最近的写入。
于是记忆永远停在「第一次被 flush 出去的那个值」，**连时间戳一起冻住** ——
正好对上「固定的一首、固定时间」。

**改法**：记忆改存**文件**，`localStorage` 只作备份。

```js
var MEM_FILE = "C:////betterncm////gapless-player.lasttrack.json";
betterncm.fs.writeFile(MEM_FILE, new Blob([JSON.stringify({ id: trackId, t: Date.now() })]));
```

- 读的时候**文件优先**，读不到再退回 `localStorage`（`readFile` 返回类型兼容 string / ArrayBuffer / Blob / File）。
- 记忆时机也提前：`player.setCurrentPlay`（选中）就记一次，不再只等 `audioplayer.load`。
- 每个读/写都打 `[mem]` 日志，下次一眼能看出「有没有写、写没写进去、读到的是什么」。

### 顺带：版本号与 manifest 对齐

上一轮 `VERSION` 停在 `0.2.1` 而 manifest 已是 `0.2.2`，日志横幅因此误导排查。
现在加了一条验证台断言：**横幅版本必须等于 manifest 版本**。

### 验证

- 离线验证台 **123/123 全绿**（新增 26：**handle() 不许抛错**；27：**版本号一致**；
  24 扩成「写文件 / 从文件读 / 退 localStorage / 过期不猜」四段）
- 变异测试 **18/18 全被抓住**（新增 3 个：**改名漏改调用点** / 版本号不一致 / setCurrentPlay 不记记忆）

### ★ 教训

**`try/catch` 包住的 `handle()` 会把「函数名写错」这种硬 bug 变成一行日志。**
所以验证台必须单独断言「日志里没有抛错」，不能只看功能断言 ——
因为副作用（`S.playlist = songs`）往往发生在抛错之前，功能断言照样绿。

### 待真机验证

1. 播几首不同的歌 → 打开 `C://betterncm//gapless-player.lasttrack.json`，看 `id` 是不是**最后一首**。
2. 重启 → 日志里应有 `[mem] 读到开机记忆（来自文件）｜ track=…`（而不是来自 localStorage）。
3. 日志里**不应再出现** `[guard] ★ handle(...) 抛错`。

---

## ★ v0.2.2 —— 开机就把第一首也预下（A1.5）

### 真机反馈

> 「让插件开机就把第一首也预下，目前第二首起的预载切歌正常了」

### 问题：第一首没有「上一首」可预载

A1 的预载逻辑是「**当前歌在播** → 预载**下一首**」。开机时第一首还没有「上一首」，
所以它必然走即时加载 → 开头仍要等几秒。A1.5 的 `start(when)` 也救不了它
（无缝解决的是**接缝**，不是**首播等待**）。

### 真机时序（决定这个方案可行）

```
21:10:02.005  插件 onLoad
21:10:03.741  player.setCurrentPlay   (+1.74s)   ← 此刻已经知道第一首是谁
21:10:06.842  audioplayer.load        (+4.84s)   ← 3.1 秒之后才要播
```

**中间有 3.1 秒提前量** —— 足够把「马上就要播的那首」下完 + 解码好。

### 做法：预载规则改成两条

```js
function maybePreload() {
  var cur = S.curTrackId;
  if (cur === null) return;

  // ① 当前曲目还没就绪 → 预载它自己（"开机就把第一首也预下"）
  if (S.loadedTrackId !== cur) {
    if (!hasPreload(cur)) startPreload(cur, "当前曲目");
    return;
  }

  // ② 已经在播 → 预载列表里的下一首（切歌命中）
  var nt = nextTrack();
  ...
}
```

- 新增 `S.loadedTrackId`：**已经解码好、正在播**的那首（和「当前选中」`curTrackId` 区分开）。
  就是靠它区分「该预载自己」还是「该预载下一首」。
- `player.setCurrentPlay` / `player.addListElement` / `onBufferReady` 三处统一调 `maybePreload()`。

### 再加一手：开机记忆（多抢 ~1.7s）

`setCurrentPlay` 要等到 +1.74s 才来。用 `localStorage` 记住**上次播放的那首**
（`gaplessPlayer.lastTrack`，24h 内有效），开机（onLoad，0s）就先猜着下起来。

- 猜错了不要紧：`setCurrentPlay` 一给出真曲目，预载槽会被 **token 机制**换掉（只是白下一份）。
- `LibEAPIRequest` 可能比我们晚加载 → `bootPreload` 最多重试 6 次（400ms 间隔）。
- 超过 24h 就不猜了（多半已经不是那首）。

### 验证

- 离线验证台 **115/115 全绿**（A1.5 新增：规则①预载当前 / 规则①命中 / 规则②命中 /
  开机预载 / 24h 过期不猜 / **token 抢占（猜错 → 换真曲目 → 照样命中）**）
- 变异测试 **15/15 全被抓住**（A1.5 新增 4 个：规则①失效 / 开机不预载 / 记忆不写 / 不认过期）

### 待真机验证

- 开机后第一首是否**秒开**（日志里应看到 `[preload] 开机记忆 ｜ 上次那首 track=…`
  和 `[preload] ★★ 预载就绪（当前曲目）`，随后 `[load] ★★ 就绪（预载命中）`）。
- 若第一首仍有等待：看日志里 `onLoad → setCurrentPlay` 的实际间隔，
  以及「预载就绪」发生在 `audioplayer.load` 之前还是之后。

---

## ★ v0.2.1 —— A1 预载没生效的真凶：`player.addListElement` 的 payload 是**字符串**

### 真机反馈（v0.2.0）

> 「第一次放完第一首后下一首卡了很久，不知道是预载很久还是卡住了；手动切了几次，
> 直接播放下一首将其预载好后回到上一首末尾切到下一首正常」

日志里最刺眼的一行：

```
[list] 播放列表更新 ｜ 6659 首 ｜ 当前索引=-1
[list] 当前曲目 track=2637406491 ｜ 索引=-1 ｜ 下一首=(无)
```

**索引永远 -1 → 预载从未启动过。** 「卡很久」是正常的即时加载（2~7s）；
「切回来再切下一首正常」是 **HTTP 缓存**命中，不是预载。

### 根因：payload 是 JSON 字符串，我当成了数组

三个线索拼起来才能看出来：

| 线索 | 值 |
|---|---|
| trace 日志 | `args=[[{"id":...`（**双括号**） |
| 那行日志长度 | 6720 字符 |
| 我的 handler 报的 | `播放列表更新 ｜ 6659 首` |

`args[0]` 是**一个字符串**（长度正好 6659），内容是 JSON 文本 —— `JSON.parse` 之后是 **35 首歌**。
我直接 `songs.length` → 拿到的是**字符串长度**；`S.playlist` 成了字符串 →
`playlistIndex()` 遍历的是**一个个字符** → `"a".id` 是 undefined → 索引永远 -1。

> 💡 认出它的办法：`safeArgs` 会把对象折叠成 `{...}`。日志里出现**没被折叠的长 JSON**
> （即 `args=[[...]]` 双括号），就说明那是个**字符串**而不是对象/数组。

### 修复

```js
var songs = args[0];
if (typeof songs === "string") {
  try { songs = JSON.parse(songs); } catch (e) { songs = null; }
}
if (songs && songs.length) { S.playlist = songs; maybePreloadNext(); }
```

顺带把 `safeArgs` 改成**截断超长字符串**（只留前 200 字符 + 真实长度），
免得一条日志刷 6600 字符。

### 验证

- 离线验证台 **103/103 全绿**（新增 22：**字符串形态的列表也要认出来** + 数组形态兼容）
- 变异测试 **11/11 全被抓住**（新增：不解析 JSON 字符串列表）
- ⚠️ 顺带修了验证台自己：`e1.eapi.log[0].url` 在变异体下会**崩**（不是干净报红）→ 改成 `(e1.eapi.log[0] || {}).url`

---

## ★ v0.2.0 —— A1 预载：消除「每首开头等几秒」

### 问题

A0 通了之后，剩下的体验问题很明确：**每首歌开始播之前都要等一段**。实测（真机日志）：

| 曲目 | 文件 | 下载 | 解码 | 合计 |
|---|---|---|---|---|
| 2637406491 | 29.24 MB | 2057ms | 209ms | **≈ 2.3s** |
| 207497 | 35.90 MB | 2442ms | 348ms | **≈ 2.8s** |
| 3381783034 | 35.64 MB | 6501ms | 300ms | **≈ 6.8s** |

**这不是 bug，是 A0 架构的固有代价**：`decodeAudioData` 要求**完整文件**（一次性解成 PCM），
所以「先下完、再解码」绕不开。LFP 用的是 `<audio>`（浏览器流式解码，下几百 KB 就能出声），
但 `<audio>` 一次只能播一个源、无法采样级调度 → 做不出真无缝。
**这个延迟和这个插件存在的理由，是同一枚硬币的两面。**

### 做法：提前把下一首下完 + 解码好

```
当前歌播放中 ────────────────────────────────▶ 切歌
        │
        └─ 趁这整首歌的时间，把「列表里的下一首」下完 + 解码好
                                                  │
                                          切歌时直接命中 → 延迟 ≈ 0
```

### ★ 唯一硬骨头：地址从哪来

网易云只在**切歌时**才发 `audioplayer.load`（带 `musicurl`），播放列表里也没有 URL。
所以只能**主动查** —— 走已装的 **`LibEAPIRequest`**（网易云 API 请求库）：

```js
var lib = loadedPlugins.LibEAPIRequest;
var domain = APP_CONF.domain;                    // window.APP_CONF 是 BetterNCM 自己在用的全局
lib.eapiRequest(domain + "/api/song/enhance/player/url", {
  method: "POST", type: "json",
  data: { ids: "[" + trackId + "]", br: 999000 },
  onload: function (res) { /* res.data[0].url */ },
});
// 失败再退到 /api/song/enhance/download/url（LibEAPIRequest 自己用的就是后者）
```

**数据来源**（真机日志核对过）：
- `player.addListElement` 的 payload 就是**整个播放列表**（本次 35 首，字段含 `track_id`）。
- `player.setCurrentPlay` 给当前曲目 id → 在列表里定位索引 → 下一首 = 索引 + 1。
- 实测播放顺序与列表顺序一致（2637406491 idx3 → 207497 idx4 → 3381783034 idx5）。

### 实现要点

1. **旁听不拦截**：`player.addListElement` / `player.setCurrentPlay` 只观察（`return false`，照常放行）。
2. **触发时机**：当前歌就绪（`onLoad`）后 + 每次切歌时，都尝试 `maybePreloadNext()`。
3. **命中即用**：`audioplayer.load` 到达时按 `trackId` 取预载；命中就**跳过下载 + 解码**。
4. **token 守卫**：快速切歌时旧预载自动作废（复用 `loadToken` 的思路，新增 `preloadToken`）。
5. **只留一首**：预载槽只有一个，用完即释放；内存 = 当前 1 首 + 预载 1 首。
6. **安静兜底**：`LibEAPIRequest` 不在 / 查不到地址 / 请求失败 → **退回即时加载，绝不影响正常播放**。

### 已知边界（本版故意不做）

- **只按「顺序播放」取 index+1**；随机 / 单曲循环不保证 → 退回即时加载（不命中而已，不会出错）。
- **不做采样级无缝**：本版是「预载命中」，切歌仍有极小的调度间隙。`start(when)` 接缝留到 **A1.5**。
- 预载会**多下一份**（下一首在真正播放时不会重复下，但如果用户跳过了它，那份就白下了）。

### 验证

- 离线验证台 **99/99 全绿**（新增 16~21：算出下一首 / 命中跳过下载 / 不命中即时加载 /
  库不在不崩 / 查地址失败退回 / 列表末尾不预载）
- 变异测试 **10/10 全被抓住**（新增 4 个 A1 变异点：不旁听列表 / nextTrack 取错 /
  去掉命中分支 / takePreload 不校验 trackId）

### 本轮测试配置
`GaplessPlayer-0.2.0` + `LibEAPIRequest-1.6.2` 启用；`LibFrontendPlay-1.1.0` 与 `CallTrace-0.3.0` 停用。

---

## ★ v0.1.4 —— v0.1.3 修错了：`registeredCalls` 得**自己造**

### 真机反馈（v0.1.3）

> 「进度条依旧 00:00，依旧无法暂停」

日志给出决定性事实：

```
20:44:12.037 [emit] ★ registeredCalls 不存在（BetterNCM 没注入？），只能走 triggerRegisterCall
20:44:14.970 [intro] (启动+3s) registeredCalls=undefined ｜ triggerRegisterCall=function
20:44:16.340 [intro] (收到 load) registeredCalls=undefined ｜ triggerRegisterCall=function
20:44:19.131 [play] UI 一直没发 play（500ms）→ 兜底自动起播
20:44:19.132 [emit] onPlayState ｜ 1 ｜ 2637406491_1_3136952023-bitrate-1999-zwdGNV   ← 无 |resume| 段
```

**v0.1.3 的假设错了。** 我以为 `registeredCalls` 是 BetterNCM 注入的全局，其实——

### 真相：`registeredCalls` 是 LFP 自己造的

拆开 LFP 的包（`LibFrontendPlay-1.1.0.plugin` = zip）看到：

**① 包内 `startup_script.js`（844 B，BetterNCM 按约定自动加载包根同名文件）：**

```js
var f = {};
window.registeredCalls = f;
channel.registerCall = r(channel.registerCall, (n, o) => { f[n] ??= []; f[n].push(o); }).function;
```

**② manifest 里的 `hijacks`（直接改网易云打包产物，双保险）：**

```json
{ "type": "replace",
  "from": "window.channel.registerCall=function",
  "to":   "window.channel.registerCall=(...args)=>{registeredCalls[args[0]]=registeredCalls[args[0]]||[];registeredCalls[args[0]].push(args[1]);ncmHackChannelFunc(...args);},window.ncmHackChannelFunc=function" }
```

也就是说：**LFP 把 `channel.registerCall` 包了一层，凡是 UI 注册进来的处理器都记一份到 `window.registeredCalls`，然后自己调用它们。** LFP 一旦停用，就没人建这个表了 → v0.1.3 的派发扑空。

### 注册键名（从 LFP 源码反推，已核对）

LFP 的 `mo()` 用 `e = "audioplayer.onPlayState"` 做键，而它自己的调试代码是这么挂监听器的：

```js
channel.viewCall().map(e => {
  let [t, r] = e.split(".");                       // "audioplayer.onPlayState" → t="audioplayer", r="onPlayState"
  legacyNativeCmder.appendRegisterCall(r.slice(2), t, handler);   // → appendRegisterCall("PlayState","audioplayer",fn)
});
```

→ 所以两条路径都要映射到同一个键：

| 注册方式 | 键名 |
|---|---|
| `channel.registerCall("audioplayer.onPlayState", fn)` | `audioplayer.onPlayState` |
| `legacyNativeCmder.appendRegisterCall("PlayState", "audioplayer", fn)` | `"audioplayer" + ".on" + "PlayState"` |

### v0.1.4 的修复

1. **新建 `src/startup_script.js`**：页面最早期建 `window.registeredCalls`，包 `channel.registerCall` 与 `legacyNativeCmder.appendRegisterCall`，把 UI 的处理器记进来（20ms × 750 次重试，防接口晚出现）。
2. **manifest 加 `hijacks`**：照抄 LFP 的 `recordRegisterCall`（`id` 改成 `GaplessPlayer::recordRegisterCall`），即使 startup_script 跑晚了也能兜住。
3. **`main.js` 加 `installRegistryHook()` 兜底**：插件 `onLoad` 时再包一层（幂等，带 `__gpWrapped` 标记），并让 `emit` 用多重 fallback 取注册表；`introspectRegistry()` 改为读 `window.registeredCalls`，日志里会打印到底建起来没有。

> ⚠️ `legacyNativeCmder` / `channel.registerCall` / `triggerRegisterCall` 在 `betterncm.dll` 里**一次都不出现** → 它们是**网易云自己的全局**，且 `triggerRegisterCall` **只通知原生，不调用 UI 在 JS 侧的处理器**。所以「只调 triggerRegisterCall」是永远修不好的。

### 验证

- 离线验证台 **83/83 全绿**（新增 3e 主路径 `channel.registerCall`、15 `startup_script.js` 专项）
- 变异测试 **6/6 全被抓住**（`test/mutate.js`）：不挂 `channel.registerCall` / 不挂 `appendRegisterCall` / `emit` 不派发 / startup 不包两个接口 / startup 不建表 —— 逐个都让验证台变红

### ✅ 真机验证通过（2026-10-13 20:57）

用户反馈：**「进度条和暂停都正常了」**。日志证据：

```
[intro] (插件 onLoad) registeredCalls=object ｜ triggerRegisterCall=function
[intro] registeredCalls 共 90 个键                 ← v0.1.3 这里是 undefined
[intro]   audioplayer.onLoad → 3 个处理器
[intro]   audioplayer.onPlayState → 7 个处理器
[intro]   audioplayer.onPlayProgress → 6 个处理器
...
37.199 [call] ▶ audioplayer.load ｜ args=[…-FaxSVF, {…}]
39.490 [emit] onLoad ｜ duration=137.17 ｜ err=0
39.491 [call] ▶ audioplayer.play ｜ args=[…, …|resume|HDWhSg]   ← ★ UI 自己发的 play（没走兜底）
39.492 [emit] onPlayState ｜ 1 ｜ …|resume|HDWhSg
40.625 [call] ▶ player.setTotalTime ｜ args=[137171]            ← ★ 与 LFP 基准完全一致
43.692 [call] ▶ audioplayer.pause ｜ args=[…, …|pause|a1MVTT]    ← ★ 按暂停，UI 发了命令
43.693 [emit] onPlayState ｜ 2 ｜ …|pause|f9X33W
49.539 [hb] ready=true ｜ paused=true ｜ pos=4.1s / 137.2s      ← ★ 进度冻住
```

**两条附带结论：**

1. **startup_script.js 是主力，main.js 兜底静默跳过。** 日志里**没有** `[reg] ✅ … 已挂钩` 那几行 →
   说明 `installRegistryHook()` 跑的时候接口**已经被 startup_script 包过了**（`__gpWrapped` 已置位）。
   设计意图（早挂钩 + 兜底）成立。
2. **onLoad 晚到 2.3s 也不会让 UI 超时**（v0.1.3 遗留的「待验证疑点」到此了结）：
   本次 `fetch 2081ms + 解码 209ms = 2291ms`（vs LFP 502ms），UI 照样 1ms 后就发了 play。
   → A0「整首下完再解码」的代价目前可接受；将来做 A1 无缝时再用 `start(when)` 削掉。

### 本轮测试配置
`GaplessPlayer-0.1.4` 单独启用；`LibFrontendPlay-1.1.0` 与 `CallTrace-0.3.0` 停用。网易云版本 **2.10.13**（hijack 键 `>= 2.10.0` 匹配）。

---

## ★ v0.1.3 —— 「暂停失灵」的总根因找到了：**事件派发少了一步**

### 基准对比（用 CallTrace 挂钩事件层测出来的）

| | LFP（正常） | GaplessPlayer v0.1.1（坏） |
|---|---|---|
| `load` → `onLoad` | **502ms** | **3433ms** |
| UI 收到 onLoad 后 | **发 `audioplayer.play`** | **什么都不发** |
| UI 调 `player.setTotalTime` | **有**（137171ms） | **没有** |
| `onPlayState` 第 2 参数 | `id\|resume\|token` | `id`（缺状态段） |
| 按暂停时 UI 发的命令 | **`audioplayer.pause`** | **一条都不发** |

→ 网易云 UI 收到 GaplessPlayer 的事件后**压根没往下走**：不点播放、不算总时长、不进「播放中」。
「暂停按钮不干活」只是并发症。

### 根因：`emit` 少了 `registeredCalls` 这一步

LFP 的 `mo()` 干两件事，**少一件 UI 就没反应**：

```js
function mo(e, ...t) {
  registeredCalls[e].map(n => n(...t));                     // ★ 派发给 UI 的 JS 处理器
  let [r, o] = e.split(".");
  legacyNativeCmder.triggerRegisterCall(o.slice(2), r, ...t); // 通知原生
}
```

`registeredCalls` 是 **BetterNCM 注入的全局注册表**（在 LFP 里只出现这一次，无声明）。

> ⚠️ **上面这句在 v0.1.4 已被真机推翻**：`registeredCalls` 不是 BetterNCM 注入的，而是 **LFP 自己在 `startup_script.js` + manifest `hijacks` 里建的**。LFP 停用后它就没人建了 → 见文首 v0.1.4 章节。

v0.1.2 的 `emit` 只做了第二句 → **UI 的处理器压根没被调用**。

### 附带修复：不再「解码完就抢跑起播」

LFP 下 UI 会**先**发 `audioplayer.play`（带 token `id|resume|xxx`），`onPlayState` 用的就是这个 token。
GaplessPlayer 抢在 UI 之前起播 → 拿不到 token → `onPlayState` 第 2 参数缺状态段。

现在改成：**解码完只发 onLoad / onPlayProgress，等 UI 的 play 命令；500ms 没等到再兜底自动起播。**

### 验证

- 离线验证台 **64/64 全绿**（新增：等 UI 的 play、兜底起播、`registeredCalls` 派发三项）
- 变异测试确认能抓住 bug：去掉 `registeredCalls` 派发 → **5 项变红**；恢复抢跑起播 → **3 项变红**

### 本轮测试配置
`GaplessPlayer-0.1.3` 单独启用；`LibFrontendPlay-1.1.0` 与 `CallTrace-0.3.0` 停用（减少变量）。

## v0.1.0 真机首测结果（✅ 音频链路全通）

用户实测：一首 44.7MB FLAC 从头听到尾（220s），全程正常。

| 环节 | 实测 |
|---|---|
| `channel.call` 锁定 | ✅ 全程无「有人想改写」 |
| 取字节 | ✅ 44.74 MB / 2316ms（19 MB/s） |
| 解码 | ✅ 327ms → 219.93s / 2ch @48000 / 80.54MB |
| 起播 | ✅ `ctx.resume()` 成功（suspended → running） |
| 进度推进 | ✅ 22 次心跳 3.1s → 213.1s，`ctx=running` |
| 自然播完 | ✅ `onEnd` 触发 |
| 自动切下一首 | ✅ 第二首 load → 解码 253ms → 起播 |

**⚠️ 未验证：暂停。** 整份日志没有一条 `[cmd] ▶ pause` —— 用户没按过暂停按钮。
A0 的核心问题（暂停能不能真的停住）**仍未回答**。

**⚠️ 另一个观察：切歌之间空了 13.6 秒**（19:48:17.810 播完 → 19:48:31.404 起播）。
拆开看是「网易云自己等了 9.1s 才发下一首的 load」+「下载解码 4.5s」。
后者 A1 的预载能消掉；**前者原因不明**（怀疑网易云在等原生播放器的结束回报，
而我们把它按住了），待查。

### v0.1.1 的改动：命令追踪

v0.1.0 只记「认识的」那几条命令 —— 如果网易云压根不发 `audioplayer.pause`，
日志会一片安静，又回到「看不出是没发还是没接住」的死胡同。

v0.1.1 起：
- 每个**首次出现**的命令名都记一笔（`[call] 首次出现命令：xxx`，上限 200 种）
- 名字里带 `player/audio/play/pause/seek/vol` 的命令**每次都记**，含参数与调用次数


## 为什么要有这个插件

网易云 PC 版原本的播放链是：

```
<audio> → createMediaElementSource → AnalyserNode → destination
```

`<audio>` 一次只能播一个源、也没法做采样级调度，所以**做不到真无缝**。
早期的尝试是「提前点一下网易云的下一首按钮」来遮缝 ——
这会真的推进播放列表索引，于是预载窗口里歌词和进度条提前跳、
状态错乱，最终表现为「切歌后暂停失灵」这类修不好的毛病。
GaplessPlayer 把这条路整个换掉了：不再借 UI 的手，自己排采样级接缝。

**GaplessPlayer 把链条最前面那个 `<audio>` 换成 `AudioBufferSourceNode`：**

```
网易云 UI ── channel.call("audioplayer.*") ──▶ [拦截层]
                                                ├─ 播放引擎（AudioBufferSourceNode）
                                                ├─ GainNode → AnalyserNode → destination
                                                └─ 事件伪造器（legacyNativeCmder）
```

这样播放的每一环都归我们管 —— **暂停 = `source.stop()`，不再依赖网易云发命令。**

## 目录

```
src/main.js            插件主体（拦截 channel.call + 播放引擎 + 伪造事件）
src/startup_script.js  页面最早期注入：建 registeredCalls、包注册接口
src/manifest.json      插件清单（injects + hijacks）
test/harness.js        离线验证台（假运行环境，跑一遍全部逻辑）
test/mutate.js         变异测试（抠掉关键代码，验证台必须变红）
build.py               打包 / 安装
```

## 构建与验证

```bash
node test/harness.js        # 离线验证台，必须全绿
node test/mutate.js         # 变异测试，必须「全部变异都被抓住」
python build.py --install   # 打包并安装到 C:\betterncm\plugins\
```

日志写在 `C:\betterncm\gapless-player.log`（900 条滚动窗口）。

## 阶段范围

**A0（已完成）**只验证两件事：① 接管播放后网易云的进度条 / 歌词 / 时长是否正常；② **暂停是否可用**。

**A1（已完成）**：**预载下一首，消除第二首起每首开头的加载等待**（不做采样级无缝）。

**A1.5（本版）**：**开机预下第一首**（含 `localStorage` 开机记忆），让第一首也能秒开。
采样级无缝（`start(when)`）仍留到后面。

### 已实现

- 拦截 `channel.call`：`audioplayer.load` / `.play` / `.pause` / `.seek` / `.setVolume`
- `fetch` → `decodeAudioData` → `AudioBufferSourceNode` 播放
- 事件伪造：`onLoad` / `onPlayState` / `onPlayProgress` / `onSeek` / `onVolume` / `onEnd`
- 100ms 进度心跳；10s 状态心跳（排查「UI 静悄悄崩了」）
- 本地文件走 `betterncm.fs.readFile`
- 下载失败也发 `onLoad`（带错误码），否则网易云会一直转圈
- `channel.call` 用 `defineProperty` 锁住，防止 LFP 抢回去
- 接管 `betterncm_native.audio.getFFTData` 与 `betterncm.isMRBNCM`
- **自建 `registeredCalls`**（`startup_script.js` + manifest `hijacks` + 运行时兜底）
- **A1 预载**：旁听播放列表 / 当前曲目 → 查下一首地址（`LibEAPIRequest`）→ 下完 + 解码 → 切歌命中
- **A1.5 开机预载**：预载规则两条（当前曲目未就绪 → 预载它自己；已在播 → 预载下一首）；
  记住上次播放的那首（24h 内有效，**存文件** `C://betterncm//gapless-player.lasttrack.json`，
  `localStorage` 只作备份），开机（onLoad）就先猜着下起来

### 已知取舍

- **和 LFP 的关系**：manifest 用 `loadAfter: ["LibFrontendPlay"]`，若用户装了 LFP，本插件的拦截器
  就装在它之上，`audioplayer.*` 全部截断，LFP 收不到 → 变成惰性。两边都装着也不会打架；
  没装 LFP 同样正常工作（本插件不依赖它）。
- **开机第一首能否秒开，取决于「3.1 秒窗口」够不够**：真机时序上 `onLoad` → `setCurrentPlay`
  有 ~1.7s、→ `audioplayer.load` 有 ~4.8s 提前量。网络慢（一首要下 5s+）时第一首仍可能等。
  第二首起由「上一首播放期间」预载，窗口长得多，基本稳定命中。
  （根因：`decodeAudioData` 必须拿到完整文件，不像 `<audio>` 可以边下边播。）
- **开机记忆只是「猜」**：猜错会白下一份（`setCurrentPlay` 一到就被 token 换掉，不影响播放）。
  记忆**属于某一份歌单**：切到不含这首歌的新歌单时，预载会被自动作废（v0.2.4）。
  ⚠️ 记忆**不能存 `localStorage`**：NetEase 的 webview 里它是异步落盘，强杀进程会丢最近写入
  （真机踩过：记忆停在「第一次 flush 出去的值」，时间戳一起冻住）→ 必须写文件。
- **预载依赖 `LibEAPIRequest`**：它不在 / 查不到地址 → 退回即时加载（功能降级，不会出错）。
- **`decodeAudioData` 会 detach 传入的 ArrayBuffer**（长度归零、`.slice()` 抛错）。
  本插件不需要保留原始字节，所以无影响。
- **内存**：每首解码后 63~80MB（float32）。A1 预载时要注意释放旧 buffer。
- **Worker 用不了**：`blob:` 和 `data:` 都被页面 CSP 禁。好在解码是异步的，主线程不卡。

## ★★ v0.1.1 二测：暂停完全没反应 —— 根因找到并修复（v0.1.2）

用户实测（当时 LFP 与同类的早期插件均已停用）：

| 现象 | 日志证据 |
|---|---|
| 按两次暂停都没反应 | **整份日志没有任何 `audioplayer.pause`**，连「首次出现命令」都没有 |
| 进度条一直转圈 | 网易云认为歌曲「还在加载」 |
| 时间显示 `00:00 / 00:00` | 同上 |
| 点播放卡一会 | 首次要下载 3.2s + 解码 243ms（预期内） |
| 重启不回到上次位置 | 我们 `onEnd` 的 `playedTime` 一直填 0 |

**根因**：从 LFP 插件包里挖出它的进度心跳原文 ——

```js
function rN(){
  if (!N.currentAudioPlayer || !N.enabled || N.currentAudioPlayer.buffered.length === 0) return;
  let e = N.currentAudioPlayer.buffered.end(0) / N.currentAudioPlayer.duration;  // ← 加载进度 0~1
  N.info.playProgress !== N.currentAudioPlayer.currentTime && (
    N.info.loadProgress = e,
    mo("audioplayer.onPlayProgress", N.currentAudioId[0], N.currentAudioPlayer.currentTime, e)
  );
}
```

★ **`onPlayProgress` 的第 3 个参数是「加载进度（0~1）」，不是占位符。**
我们一直发 `0` → 网易云以为「这首歌一点都没缓冲好」→
**进度条一直转圈 + 暂停按钮不干活（压根不发命令）+ 时间显示 00:00**。
一个根因，三个现象。

### v0.1.2 的修复

1. `onPlayProgress` 第 3 参数发 **`1`**（我们是整首解码完才播的，永远完全加载）
2. 照 LFP 的做法：**位置没变就不发**进度（暂停时自然不发）
3. `playedTime` 改成**真实累计播放毫秒数**（照 LFP：play 起表、pause 停表、
   `onEnd` 带上总值再清零）—— 只算真正在播的时间，暂停期间不计

### 仍未解决

- **「重启回到上次播放位置」**：这多半是**原生播放器**自己的功能，
  我们绕过了它 → 大概率修不了，属于已知代价。待确认。
- **切歌之间空 13.6 秒**（网易云自己等 9.1s 才发下一首 load）—— 原因仍未查明。

## A0 真机测试步骤

1. **停用同类做无缝的插件**（必须）—— 会和本插件打架，现象无法归因。
2. **建议也停用 `LibFrontendPlay`**（见下）—— 不是必须，但 A0 是诊断跑，少一个变量。
3. 重启网易云 → 播一首歌 → 看日志 `C:\betterncm\gapless-player.log`。

### 关于「要不要停用 LFP」

**严格来说不必须。** manifest 的 `loadAfter: ["LibFrontendPlay"]` 让我们的拦截器装在 LFP 之上，
`audioplayer.*` 全部截断；而且 `channel.call` 用 `Object.defineProperty` 锁住，
LFP 的 React `useEffect` 就算想把 `channel.call` 抢回去也会被 setter 吞掉。

**但 A0 建议一起停用**，因为：

- LFP 的 `useEffect` 触发时机（React 调度）与我们的 `plugin.onLoad` 谁先谁后，
  **我没有在真机上验证过**，`defineProperty` 万一不可用就会退化成普通赋值，LFP 可能抢赢；
- A0 是诊断跑，出问题时最好只有「我们的 bug」一种可能，而不是「谁抢赢了」；
- 日志里出现 `[guard] 有人想改写 channel.call，已拦下` 就说明 LFP 确实在抢 —— 这条日志
  本身就是验证「共存设计是否成立」的证据。

A0 跑通之后，如果想验证「能不能和 LFP 共存」，把 LFP 打开再跑一次即可。

## 关键参考：LFP 的实现蓝图

`C:\betterncm\plugins_runtime\LibFrontendPlay\index.js`（345KB 打包产物，变量名未混淆）
是本插件的施工图。要点：

- 全部拦截面只有 **4 条命令 + 6 个事件**
- 伪造事件的秘诀就 3 行：
  ```js
  function mo(event, ...args) {
    registeredCalls[event].map(f => f(...args));
    let [r, o] = event.split(".");
    legacyNativeCmder.triggerRegisterCall(o.slice(2), r, ...args);
  }
  ```
- 启动时要先 `channel.call("audioplayer.pause", ()=>{}, ["",""])` 按住原生播放器，否则双声道

## 下一步

- **A1.6 真无缝**：预载已就位，把「命中后立刻起播」升级成 `start(when)` 采样级接缝
  （当前歌还剩 N 秒时，下一首 source 预约在接缝时刻起播，两段音频首尾零缝隙）
- **A2 控制面**：seek / 上一首 / 下一首 / 音量 / 播放模式（含随机 / 单曲循环下的预载正确性）
- **A3 打磨**：编码器延迟裁剪（MP3 priming/remainder）、格式不一致回退、内存回收、预载失败重试
