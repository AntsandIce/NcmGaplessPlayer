/*
 * GaplessPlayer —— A1 预载
 *
 * 目标：用 Web Audio 自建播放引擎，把切歌间隙压到 0。
 *
 * 为什么要做（背景）：
 *   原本的播放链是  <audio> → createMediaElementSource → Analyser → destination。
 *   <audio> 一次只能播一个源、且无法采样级调度，所以做不到真无缝；
 *   早期的做法是「提前点一下网易云的下一首按钮」来遮缝 —— 这会真的推进播放列表索引，
 *   于是预载窗口里歌词/进度条提前跳、状态错乱。
 *   GaplessPlayer 换掉了那个做法：不再借 UI 的手，自己排采样级接缝。
 *
 * 本插件的做法：把链条最前面那个 <audio> 换成 AudioBufferSourceNode。
 *   网易云 UI ── channel.call("audioplayer.*") ──▶ [我们的拦截层]
 *                                                    ├─ 播放引擎（AudioBufferSourceNode）
 *                                                    ├─ 预载调度器（下一首提前下完+解码）
 *                                                    └─ 事件伪造器（legacyNativeCmder）
 *
 * ── A0（已完成，v0.1.4 真机通过）────────────────────────────────────
 *   ① 接管播放后，网易云的进度条 / 歌词 / 时长 正常；
 *   ② 暂停可用。
 *
 * ── A1 预载（本版）──────────────────────────────────────────────────
 *   问题：`decodeAudioData` 要求**完整文件**，所以「先下完、再解码」绕不开。
 *         实测每首开头要等 2.3s ~ 6.9s（取决于网络）。
 *   做法：当前歌还在播时，就把**列表里的下一首**下完 + 解码好；切歌时直接命中。
 *   地址从哪来：网易云只在切歌时才发 `audioplayer.load`（带 musicurl），
 *         列表里也没有 URL → 只能主动查，走已装的 `LibEAPIRequest`。
 *         它不可用就安静退回即时加载，绝不影响正常播放。
 *   ⚠️ 本版**只做预载命中**，不做采样级无缝（`start(when)` 留到 A1.5）。
 *   ⚠️ 只按「顺序播放」取 index+1；随机 / 单曲循环不保证，退回即时加载。
 *
 * ── A1.5 开机预下第一首（v0.2.2 / v0.2.3）──────────────────────────
 *   问题：第一首没有「上一首」可预载，所以开机第一首仍要等。
 *   真机时序（开机）：
 *     插件 onLoad 02.005 →(+1.74s) setCurrentPlay 03.741 →(+4.84s) audioplayer.load 06.842
 *     中间有 **3.1 秒**，足够把「马上就要播的那首」下完。
 *   做法：预载规则改成两条 ——
 *     ① 当前曲目**还没就绪**（`loadedTrackId !== curTrackId`）→ 预载**它自己**；
 *     ② 当前曲目**已在播** → 预载列表里的**下一首**。
 *   额外：记住上次播放的那首（24h 内有效），开机就猜着先下，再抢 ~1.7s。
 *     猜错了会被 token 机制换掉（只是白下一份，不影响播放）。
 *
 * ── v0.2.3 关键修复（来自真机日志）──────────────────────────────────
 *   ① **函数改名漏改调用点**：`maybePreloadNext` 已改名 `maybePreload`，但
 *      `player.addListElement` 分支还调旧名 → 每次列表更新都抛
 *      `ReferenceError: maybePreloadNext is not defined`（被 handle 的 try 吞掉，
 *      只在日志里留一行 `[guard] ★ handle(...) 抛错`）。验证台加了「不许抛错」断言。
 *   ② **记忆改存文件**：原来用 `localStorage`。NetEase 的 webview 里 localStorage
 *      **异步落盘**，强杀进程会丢最近写入 → 记忆永远停在「第一次 flush 出去的值」，
 *      时间戳一起冻住（真机现象：「切了几首后重启，记忆还是固定的一首、固定时间」）。
 *      改成 `betterncm.fs.writeFile(C:\betterncm\gapless-player.lasttrack.json)` 直写文件，
 *      localStorage 只作备份。
 *   ③ 启动横幅版本号与 manifest 对齐（加了验证台断言，防止再出现「装的是 0.2.2、
 *      横幅却写 0.2.1」这种误导）。
 *
 * ── v0.4.2 流式那一首也能预约（真机实测：不预约要卡 503ms）──────────────
 *   真机日志（v0.4.1，用户切歌单后听的第一首）：
 *     19:26:53.721  player.addListElement（换歌单）
 *     19:26:53.734  setCurrentPlay      ← +13ms
 *     19:26:53.736  开始预载（当前曲目）  ← 预载刚开始
 *     19:26:53.846  audioplayer.load    ← 只隔 110ms → 预载根本来不及 → 走流式
 *     19:27:04.304  [end] ★ 自然播完    ← 流式那首播完
 *     19:27:04.752  [load]              ← +448ms（等 UI）
 *     19:27:04.807  [play] source.start ← **+503ms**
 *   → 这就是用户听到的「卡一下」。v0.4.1 里 `maybeScheduleSeamless` 开头有 `if (S.stream) return`，
 *     所以**流式那一首完全不参与预约**，下一首预载再 ready 也用不上。
 *
 *   解法：流式也预约 —— 结束时刻用 `el.duration - el.currentTime` 推。
 *     ★ 为什么够准：Chrome 的 `HTMLMediaElement.currentTime` 是**按 `last_time_update` 插值**算的
 *       （不是 250ms 一跳），误差只有几毫秒；而我们只排 1.5s 以内的未来时刻，
 *       媒体时钟与 AudioContext 的漂移也可以忽略。
 *     ⚠️ 唯一不确定的是 `duration` 本身（VBR / 流式 metadata 可能是估算值）
 *       → 交接时还有一道兜底：**如果 `ended` 已经来了而 B 还排在将来 >30ms，
 *         就换一个新节点「现在起播」**（宁可早 5ms，也不留空档）。
 *
 *   ★ 交接时多一步 `S.stream = false`：`stopSource()` 必须在它**之前**调（那时 `S.stream`
 *     还是 true，才会把 `<audio>` 按住）；置回 false 之后 `position()` 才会去读缓冲的时钟。
 *
 * ── v0.4.1 真无缝预约：把切歌间隙从 ~195ms 干到 0 ───────────────────────
 *   做法：**不等 UI** —— 上一首快结束时（还剩 0.3~1.5s），自己把下一首
 *     `AudioBufferSourceNode.start(上一首的结束采样)` 排上，音频线程在「最后一个采样
 *     的下一个采样」精确接上 → **0 间隙**。UI 的 `load` 迟到 ~120ms，到了就按 trackId **认领**（不重启）。
 *
 *   ★ 为什么只有缓冲路径能排：`<audio>` 没有「指定起播采样点」的能力（只有 `play()`），
 *     启动延迟几十~几百 ms 且不可控 → 全流式永远到不了 0。**流式那一首不预约**
 *     （拿不到精确结束时刻）→ 代价是「流式 → 下一首」这一次过渡仍是 ~195ms，只发生在链条断开处。
 *
 *   ★ 三段状态机（`S.sched.phase`）：
 *     armed   = 已排上，A 还在播（★ `S.source` **仍是 A**，否则 A 的 onended 守卫失败 → 不发 `[end]`）
 *     live    = A 已播完、**B 已在响**、UI 还没 load（~120ms 窗口，期间**抑制进度**）
 *     claimed = UI 的 load 到了、已认领，等首个 play（首个 play 补发 `onPlayState(1)`，不重启）
 *
 *   ★★ 命门：交接时 `stopSource()` 必须在「提升 B」**之前**（此刻 `S.source` 还是 A → 只停 A）。
 *     反过来写就会**把正在响的 B 停掉**。（验证台有结构性变异 M1/M2 守着。）
 *
 *   三重闸门：缓冲路径在播 + 槽里正是「列表里的下一首」且 ready + 置信顺序播放
 *     （`NM_SETTING_PLAYER.mode` 能读到就**一票定音**，读不到退回 `seqStreak >= 2`）+ 时间窗。
 *   逃生开关：`window.__gpSeamless = false` → 完全不预约（退回 v0.4.0 行为）。
 *
 * ── v0.4.0 两条播放路径：能预载就缓冲（可无缝），不能就流式（快）──────────
 *   起因：v0.3.0 试过「按播放模式分流」（非顺序模式交回原生）—— **已删**，因为
 *     (a) 键名写错：真身是 `NM_SETTING_PLAYER`，不是 `PLAYER`
 *         （leveldb 的键**前缀压缩**，我搜到的 `PLAYER` 其实是它的尾巴 → 分流**从未生效**）；
 *     (b) 用户要的是「所有模式都由插件播」，只是**播法**不同。
 *
 *   实测（v0.2.10 真机日志，7 次自然播完、全部预载命中）：
 *     `[end]` → `[play] source.start` = 150/161/244/159/185/200/262 ms，**平均 ≈195 ms**
 *   → **现在不是无缝**，还有 ~195ms 空档。而且这 195ms **不是下载造成的**，是**等网易云 UI**：
 *     `[end]` → +39ms `setCurrentPlay` → +120ms `audioplayer.load` → 再等 UI 的 `play`。
 *
 *   ★ 为什么是两条路径，而不是「全流式」：
 *     `<audio>` **没有**「指定起播采样点」的能力（只有 `play()`），启动延迟 50~500ms
 *     且不可控 → **全流式永远到不了 0 间隙**。真无缝只能靠 `AudioBufferSourceNode.start(when)`
 *     把下一首排到「上一首结束的那一个采样」上 → 所以缓冲路径**必须留着**。
 *     反过来，流式解决的是「没有预载可用时」的 3.5s 等待（`decodeAudioData` 要求完整文件）。
 *     两者互补，不是二选一。
 *
 *   分流规则（**按每首歌决定，不需要读播放模式**）：
 *     预载槽里这一首**已就绪** → 【缓冲】切歌 0 等待（v0.4.1 起还能预约无缝）
 *     否则                     → 【流式】`<audio>` 边下边播，~0.5s 出声
 *   ★ 一旦进入「缓冲」的链条就会一直缓冲下去（每首都在播的时候把下一首预载好了）；
 *     流式只出现在链条断开处（随机模式、开机第一首、押错时）。
 *
 *   逃生开关（控制台，改了立刻生效）：
 *     `window.__gpStream = false`    → 强制走缓冲（退回 v0.3.0 的播法）
 *     `window.__gpNativeAll = true`  → `audioplayer.*` 整条放行给网易云原生播放器
 *     `window.__gpLogVerbose = true` → 日志全量
 *
 *   ★ 备查：网易云原生播放器**真实存在**，`cloudmusic.dll` 里 `audioplayer` 的方法表是
 *     `enmeratorDevices / stop / setVolume / seek / play / load`
 *     （`pause` 是 LFP 和本插件启动时就在用的「把原生播放器按住」，否则会和 Web Audio
 *      叠成双声道 → 六条都认）。它也是**流式**的（`audio_source_cache` + `audio_stream`
 *      边下边解），自动切歌靠 `AutoTrackChangeFadeIn/Out` 淡入淡出掩盖间隙 ——
 *      **它也不是真无缝**。
 *
 * ── v0.2.10 随机播放下不再白下「下一首」（自适应）──────────────────────
 *   用户问：「预载下一首对随机播放是不是无效？」→ 拿 45 分钟真机日志实测，**是「无效」，
 *   而且是零命中**（v0.2.9，`gapless-player.log` 22:27~23:12，900 行）：
 *     预载（下一首）16 次 ｜ `命中！跳过下载` **0 次** ｜ 预载就绪（下一首）14 首
 *     白下 **1076 MB**（平均 76.9 MB/首）｜ 切歌实际等待 **平均 3482 ms**（一点没省到）
 *   最硬的证据：只看**自然播完后的自动续播**（排除「用户手动乱点」），13 次**全部没中**：
 *     预载了 493275349 → 实际自动播到 460043667；预载了 518895654 → 实际播到 1931280236 …
 *
 *   根因：`nextTrack()` = `playlist[playlistIndex()+1]`，**只在顺序播放成立**。
 *   随机模式下下一首由网易云客户端自己挑，与 `player.addListElement` 给的列表顺序无关
 *   （真机里当前曲目的索引是 857 / 595 / 628 / 179 / 900 / 331 / 865 / 514 / 62 … 完全随机）。
 *
 *   ★★ 决定可行性的发现：**网易云切歌前不预告下一首**。逐个曲目核对「它的 id 在日志里首次
 *      出现的时刻」= `player.setCurrentPlay` 那一刻，距 `audioplayer.load` 只有 ~80ms。
 *      → 「在随机模式下预载得更准」**做不到**；唯一出路是「**别预载**」。
 *
 *   改法（自适应，不需要知道网易云的随机状态）：
 *     ① `setCurrentPlay` 时结算上一次「预载下一首」押没押中（`notePrediction`）。
 *        ⚠️ 必须赶在 `maybePreload()` **之前** —— 一旦它发现当前曲目没预载，就会
 *        `startPreload(当前曲目)` 把那个预测槽**换掉**，之后再也看不出押没押中。
 *     ② 连续 `PRELOAD_MISS_LIMIT`(3) 次押不中 → `preloadNextOff = true`，
 *        不再预载下一首（**保留「预载当前曲目」**，那条是知道要播才下的，有用）。
 *     ③ 重新打开只靠**免费**信号（`notePlayOrder`）：连续 2 首在列表里**索引相邻**。
 *        随机播放下这个概率 ≈ 1/列表长度（真机 900 首），所以基本只可能是顺序播放 ——
 *        **不用再白下一首去试探**。
 *     ④ 顺带修一个会误导排查的日志 bug：`[list]` 那行的「索引 / 下一首」原来是**上一首的**
 *        （v0.2.7 把 `S.curTrackId = tid` 挪到了这行日志之后）。改成显式传 `tid`。
 *
 *   ★ 为什么砍掉是**零代价**的：随机模式下预载从未命中 → 切歌等待时间不会变差，
 *     纯粹省流量（外加白解码的 70~90MB 内存）。
 *
 * ── v0.2.9 主动下线「位置记忆」：只记歌，不记进度 ──────────────────────
 *   用户决定：**不需要「记住播到哪儿」这个功能**，记忆回到 v0.2.4 的形态 ——
 *   只记「哪首歌」（payload `{ id, t }`）。
 *
 *   删掉：
 *     · payload 里的 `pos`（v0.2.5 加的）；
 *     · 开机续播（`resumePos` / `resumeTrackId` + `onBufferReady` 里那段）；
 *     · 暂停 / 拖动 / 播放中周期 的「位置落盘」；
 *     · 「同一首沿用旧 pos」那条规则（`lastSaved`）。
 *
 *   ★ **但 v0.2.5~v0.2.8 里跟「位置」无关的修复全部保留** —— 因为它们修的是别的坑：
 *     · **开机保护窗口**（v0.2.6/0.2.7）：网易云开机那串恢复（`setCurrentPlay → load → seek`）
 *       不许写记忆。没有它，记忆会被冲成「固定一首歌」，**记歌也不稳**（v0.2.3 起就有这坑）；
 *     · **AbortController**（v0.2.5）：作废预载时真掐断在飞下载；
 *     · **日志瘦身**（v0.2.8）：只写排查用得上的，噪音挂 `LOG_VERBOSE`；
 *     · **开机读取竞态守卫**（v0.2.7）：异步读记忆时若已写过，忽略这次读取。
 *   所以这一版是「**只记歌、而且记歌真的稳**」。
 *
 * ── v0.2.8 日志瘦身：只写排查用得上的 ────────────────────────────────
 *   真机一次开机 256 行里，**117 行（46%）是噪音**，把要看的淹了：
 *     · [call] 首次出现命令：xxx        —— 86 行（开机把网易云所有命令名刷一遍）
 *     · [intro] 注册表逐条 dump          —— 31 行（每次启动重复 3 遍 × 10 行）
 *     · [call] ▶ player.*（UI 设置类）   —— 20+ 行（setInfo / setCover / setMiniPlayerInfo…）
 *   改法：加 `LOG_VERBOSE` 开关（默认 false）+ `logVerbose()`；
 *     上面三类改走 `logVerbose`，其余照旧。想全量：
 *     改 `LOG_VERBOSE = true` 重新打包，或运行时控制台 `window.__gpLogVerbose = true`（不用出包）。
 *   ⚠️ `[call] ▶` 的正则也收窄了：原来 `/player|audio|play|pause|seek|vol/i` 会把
 *     `player.setInfo` 这类 UI 设置调用全刷进来；现在只留
 *     `audioplayer.*` + `player.setCurrentPlay` + `player.addListElement`。
 *
 * ── v0.2.7 保护窗口「补完」：网易云的自动恢复播放也拦下来 ──────────────
 *   v0.2.6 只挡住了 `setCurrentPlay`，**没挡住它后面那一串自动播放**。
 *   真机（`gapless-player.log` 16:40 那次）：
 *     43.032 [mem] ★ 开机恢复（网易云自己挑的）｜ track=20944203 → 记忆与预载槽都不动  ← 挡住了 ✅
 *     43.082 [preload] 开始预载（当前曲目）｜ track=20944203                          ← 没挡住 ❌
 *     43.084 [preload] 已掐断（作废/换槽）｜ track=1441581262
 *     54.845 [call] ▶ player.setCurrentPlay ｜ args=[20944203_1_3136952023]  ← 还是「恢复」，不是用户
 *     54.994 [call] ▶ audioplayer.load ｜ args=[20944203_...]              ← 网易云在**自动播**它那首
 *     54.994 [mem] 第一次真正加载 → 开机保护窗口关闭                        ← 窗口关太早 ❌
 *     54.995 [mem] 记住当前曲目 ｜ track=20944203 ｜ pos=0.0s ｜ 来源=加载   ← 记忆被写回网易云那首
 *     54.996 [call] ▶ audioplayer.seek ｜ args=[…, 180.61999999999998]     ← 连它自己的进度也恢复了
 *     54.997 [mem] 记住当前曲目 ｜ track=20944203 ｜ pos=180.6s ｜ 来源=拖动
 *   → 用户看到的就是「重启后记忆变成固定一首歌的固定位置」。
 *
 *   三处漏洞，一起补：
 *     ① `player.addListElement` 分支也会调 `maybePreload()`。它拿到的是 `S.curTrackId`
 *        （已被恢复那首污染）→ 把「记忆那首」的预载掐断。**窗口内不再更新 `S.curTrackId`**
 *        （恢复的那首不算「当前曲目」），这一路自然就断了。
 *     ② 窗口的关闭条件错了：**`audioplayer.load` 也是网易云恢复流程的一部分**，
 *        不能拿它当「用户真的开始听了」。改成：**用户切到别的歌**（≠ 恢复那首）
 *        或 **实际播放累计 ≥ 10s**（恢复那串是毫秒级的，10 秒只可能是人在听）。
 *     ③ 窗口内 `loadSong` / `doPause` / `doSeek` 都不写记忆（`load` 和 `seek` 都是恢复流程的一部分）。
 *
 * ── v0.2.6 开机保护窗口（★ 这条推翻了 v0.2.2 的一个前提）──────────────
 *   真机现象：**关掉时记忆文件是对的，一重启就被改成「另一首固定的歌、位置 0」**。
 *   日志（`gapless-player.log` 16:29 那次，全程 0 个 audioplayer.load）：
 *     39.669 [mem] 读到开机记忆（来自文件）｜ track=2758269319 ｜ pos=121.2s
 *     39.669 [preload] 开始预载（开机记忆）｜ track=2758269319
 *     41.453 [call] ▶ player.setCurrentPlay ｜ args=[1981999919_1_3136952023]   ← 网易云自己恢复的
 *     41.455 [mem] 记住当前曲目 ｜ track=1981999919 ｜ pos=0.0s ｜ 来源=选中    ← 把正确记忆冲掉了
 *     41.457 [preload] 已掐断（作废/换槽）｜ track=2758269319                  ← 正确那首的预载被掐断
 *     43.645 [preload] ★★ 预载就绪 ｜ track=1981999919 ｜ 96.95 MB            ← 白下 97MB
 *
 *   根因：`player.setCurrentPlay` 在开机时带的是**网易云自己恢复的那首歌**，
 *   它**不等于**用户上次听的那首（网易云的持久化状态跟我们的拦截没关系）。
 *   而 v0.2.2 的设计前提是「一旦 setCurrentPlay 给出真曲目，预载槽会被 token 换掉」——
 *   **这个前提是错的**：它不是「真曲目」，是网易云自己的恢复动作。
 *   于是：正确记忆被覆盖 → 下次开机又按错的那首预载 → 永远固定在同一首错歌上。
 *
 *   改法：读到记忆后开一个「**开机保护窗口**」，窗口在**本次会话第一次 `audioplayer.load`
 *   之前**一直开着。窗口内 `player.setCurrentPlay` 一律：
 *     ① 不写记忆（只打一行 `[mem] ★ 开机恢复…`）；
 *     ② 不调用 maybePreload（保住「记忆那首」的预载槽，别让它在开机 2 秒内被掐断）。
 *   窗口关闭的时机 = 第一次真正 `audioplayer.load`（说明真的开始播了，后面的选歌才是用户行为）。
 *   ⚠️ 只有**读到了记忆**才开窗口 —— 没记忆就没什么可保护的，保持旧行为
 *      （否则「没记忆时开机预载第一首」这条 A1.5 规则会失效）。
 *
 * ── v0.2.5 两个改动 ─────────────────────────────────────────────────
 *   ① **开机续播位置**：以前记忆只存 `{id, t}`（哪首歌 + 写入时刻），
 *      所以重启后「歌对了，进度却是 0」。真机日志实证：
 *        上轮 `[pause] ★ 已停 ｜ 停在 82.851s` → 重启 `[play] source.start ｜ offset=0.000`。
 *      改法：payload 扩成 `{id, pos, t}`；
 *        存位置的时机 = **暂停** / **拖动进度** / **播放中每 ~30s**；
 *        开机只在「记忆那首」的第一次就绪时把起播位置换成 `pos`
 *        （`pos < 3s` 或 `> 时长-3s` 视为不可用 → 老实从 0 开始）。
 *      ⚠️ 位置**不是**「网易云要的」，是**我们自己的记忆** —— 真机日志里
 *         `audioplayer.load` / `play` 的入参都没有位置，也没有随后的 `seek`。
 *   ② **作废时真掐断下载（AbortController）**：`fetchBytes` 以前是裸 `fetch(url)`，
 *      作废只靠 `preloadToken++` 在各检查点丢结果 —— **在飞的网络下载照跑到底**。
 *      真机实证（开机预载 3439759764，size=28057800）：
 *        43.380 [fetch] status=200 ｜ CL=28057800
 *        43.814 [mem] 预载的 3439759764 不在新歌单里 → 作废
 *        45.253 [fetch] ★ 26.76 MB ｜ 1971ms        ← 作废之后还是下完了
 *      改法：`startPreload` 建 `AbortController`，`fetchBytes(url, signal)`；
 *        新增 `dropPreload()` 统一「abort + 清槽 + token++」，作废/换槽都走它。
 *        `AbortController` 拿不到时（老 webview）安静退化成旧行为，不抛错。
 *
 * ── v0.1.4 关键修复（来自真机日志）──────────────────────────────────
 *   v0.1.3 补了 `registeredCalls[event].map(...)` 派发，但真机日志显示
 *   `registeredCalls=undefined` —— 因为 **它不是 BetterNCM 注入的**，
 *   而是 LibFrontendPlay 自己在 `startup_script.js` 里造的！
 *
 *   更根本的事实：`legacyNativeCmder` / `channel.registerCall` 都是**网易云自己的全局**
 *   （betterncm.dll 里一次都没出现）。`triggerRegisterCall` 只把事件「通知原生」，
 *   **并不会调用 UI 注册在 JS 侧的处理器** —— 所以只调它，UI 完全不反应。
 *
 *   修法：GaplessPlayer 自己建这份注册表（`startup_script.js` + 运行时兜底钩子），
 *   然后像 LFP 的 mo() 那样自己调用 UI 的处理器。
 *
 * 日志：C:\betterncm\gapless-player.log
 */
(function () {
  "use strict";

  var VERSION = "1.5.3";
  var LOG = "C:\\betterncm\\gapless-player.log";
  var TICK_MS = 100;
  // ★ v0.2.10：连续几次「预载下一首」押不中就认定「播放顺序 ≠ 列表顺序」
  //   （随机播放）→ 停止预载下一首。真机实测：随机播放下 16 次预载 **0 次命中**，
  //   白下 1076 MB / 45min，而切歌等待时间一点没省到（还是平均 3.5s）。
  var PRELOAD_MISS_LIMIT = 3;

  /* ==================== v0.4.0：两条播放路径 ==================== */

  // 插件截下自己播的这几条命令；其它命令一律放行给下层（原生）
  var AUDIO_CMDS = {
    "audioplayer.load": 1,
    "audioplayer.play": 1,
    "audioplayer.pause": 1,
    "audioplayer.seek": 1,
    "audioplayer.setVolume": 1,
  };

  /**
   * ★ 播放模式（留着备查 —— v0.4.1 的「无缝预约」会拿它当额外的置信信号）
   *
   * 位置：`localStorage` 的 **`NM_SETTING_PLAYER`**。⚠️ **不是 `PLAYER`** ——
   * 当初在 leveldb 里搜到 `PLAYER` 就以为是键名，那其实是 **`NM_SETTING_PLAYER` 的尾巴**：
   * leveldb 的键是**前缀压缩**的，共享的 `NM_SETTING_` 被压掉了。
   * （`core.js` 里 `m="NM_SETTING_PLAYER"`，`dc.setting.hS()` 读的就是它。）
   * 值：`{"volume":0.229…,"mode":"playorder","speed":1,"mode2":false,"mode3":false,"ntc":3,"time":…}`
   * 模式表：playonce=顺序播放 / playorder=列表循环 / playcycle=单曲循环 /
   *        playrandom=随机播放 / playai=心动模式。⚠️ `mode3 && mode2` 时实际生效 `playai`。
   *
   * ⚠️ v0.3.0 曾按这个模式「分流」（非顺序模式交回原生）—— **v0.4.0 已删**：
   *    (a) 当时键名写错（`PLAYER`），分流**从未生效**过；
   *    (b) 用户要的是「所有模式都由插件播」，只是**播法**不同（能预载就缓冲，不能就流式）。
   */

  /* ==================== 日志 ==================== */

  var lines = [];
  var timer = null;

  function fmt(a) {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.name + ": " + a.message;
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }

  function log() {
    var d = new Date();
    var p = function (n, w) {
      w = w || 2;
      return String(n).padStart ? String(n).padStart(w, "0") : String(n);
    };
    var ts =
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
    lines.push(ts + " " + parts.join(" "));
    if (lines.length > 900) lines.splice(0, lines.length - 900);
    schedule();
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, 400);
  }

  function flush() {
    timer = null;
    try {
      betterncm.fs.writeFile(LOG, new Blob([lines.join("\n") + "\n"], { type: "text/plain" }));
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ==================== 日志开关（v0.2.8）====================
   * 默认**只写排查用得上的**那几类：
   *   banner / [env] / [ctx] / [fft] / [guard] / [boot]、
   *   [mem] / [preload] / [fetch]、
   *   [list] / [cmd] / [load] / [play] / [pause] / [seek] / [emit] / [prog] / [hb] / [vol]
   *
   * 噪音类默认**不写**（需要时打开全量）：
   *   ① `[intro]` 注册表逐条 dump；
   *   ② `[call] 首次出现命令：xxx`（开机一次就 80+ 行）；
   *   ③ `[call] ▶ player.*` 里那些 UI 设置类调用（setInfo / setCover / setMiniPlayerInfo…）。
   *
   * 依据：真机一次开机 256 行里，这三类占了 117 行（**46%**），把真正要看的淹了。
   * 想看全量：把 `LOG_VERBOSE` 改 true 重新打包，或运行时在控制台
   *   `window.__gpLogVerbose = true`（不用重新出包）。
   */
  var LOG_VERBOSE = false;

  function logVerbose() {
    var on = LOG_VERBOSE;
    if (!on) {
      try {
        on = !!window.__gpLogVerbose;
      } catch (e) {
        on = false;
      }
    }
    if (!on) return;
    log.apply(null, arguments);
  }

  function mb(b) {
    return (b / 1048576).toFixed(2);
  }

  /* ==================== 状态 ==================== */

  var S = {
    ctx: null,
    gain: null,
    analyser: null,
    buffer: null, // 当前曲的 AudioBuffer（缓冲路径）
    source: null, // 正在播的 AudioBufferSourceNode（缓冲路径）
    /* ---- v0.4.1 真无缝预约 ---- */
    // 提前排到「上一首结束采样」上的下一首 source（只有缓冲路径能排）。
    //   { src, trackId, buffer, duration, startCtxTime, endCtxTime, phase:"armed"|"live"|"claimed", announced }
    //   armed   = 已排上，上一首还在播（S.source 仍是它）
    //   live    = 上一首已播完、下一首**已在响**、UI 还没发 load（~120ms 窗口）
    //   claimed = UI 的 load 到了、已认领，等首个 play
    sched: null,
    /* ---- v1.3.0：交叉淡入淡出（P2）---- */
    xfade: 0, // 交叉时长（秒）；0 = 关。显式设置过才会被 xfadeExplicit 标记
    xfadeExplicit: false, // ★ v1.4.0：用户显式设过时长 → 不被风格/智能默认覆盖
    style: null, // ★ v1.4.0：用户选的过渡风格（clean/light/dj）；null = 智能默认
    beatCache: {}, // ★ v1.5.0：trackId|head/tail → 拍点网格
    lastPlan: null, // ★ v1.5.0：最近一次 automix 判定（排查用）
    preopenUrl: null, // ★ v1.5.3：为 B 提前预开的 <audio> 地址（切歌时复用）
    preopenTrackId: null, // ★ v1.5.3：预开的是哪一首（3.x 的 musicurl 是加密 token，只能比 id）
    stats: { plays: 0, hitPreload: 0, hitRecent: 0 }, // ★ v1.4.0：状态行用
    srcGain: null, // 当前缓冲 source 自己的增益（淡出用；不动总线 S.gain）
    srcFilter: null, // ★ v1.3.2：同一路的「高通」（交叉时做扫频淡出，平时 20Hz = 直通）
    mediaGain: null, // 流式元素那一路的增益（同上）
    mediaFilter: null, // ★ v1.3.2：流式元素那一路的高通
    /* ---- v1.3.3：autoplay 兜底 ---- */
    deferNative: false, // 还没拿到用户手势 → 音频命令整条放行给原生
    nativeRunning: false, // 原生正在响（接管那一首要先把原生按住）
    gestureSeen: false, // 是否已经拿到过用户手势
    __rawCall: null, // 原始 channel.call（绕开拦截用）
    __armedGesture: false, // 手势监听是否已挂（防止重复挂）
    /* ---- v0.4.0 流式路径（<audio>）---- */
    el: null, // ★ 持久的 <audio>：createMediaElementSource 对同一元素只能调一次 → 全生命周期复用
    mediaSrc: null, // MediaElementSource → 接进 S.gain
    stream: false, // 当前这一首走的是流式（true）还是缓冲（false）
    elToken: 0, // 流式那一首的 loadToken（事件守卫）
    metaTimer: 0, // metadata 超时兜底
    pendingSeek: null, // 还没就绪时收到的 seek 目标
    playGen: 0, // 第几次尝试起播（用来忽略「迟到的 play() 拒绝」）
    silentTick: 0, // 静音自检：连续读到 FFT 全 0 的次数
    silentSuspect: false, // 疑似被跨域静音（taint）→ 退回缓冲路径
    audioId: ["", ""], // [id, idStr]
    duration: 0, // ★ v1.2.0：**可听**时长（缓冲路径 = 解码时长 - trim.start - trim.end）
    trim: null, // ★ v1.2.0：当前曲目的首尾裁剪 { start, end }（秒，缓冲时间轴）；流式/未就绪 = null
    startCtxTime: 0, // 本段开始时的 ctx.currentTime
    startOffset: 0, // 本段从曲目的第几秒开始
    paused: true,
    pausedAt: 0, // 暂停时停在曲目的第几秒
    volume: 0.5,
    ready: false,
    loadToken: 0, // 丢弃过期加载
    startedOnce: false,
    lastEmitPos: -1, // 上次发出的进度位置（照 LFP：位置没变就不发）
    playedMs: 0, // 本曲累计播放毫秒（onEnd 要用）
    playStartedAt: 0, // 本次起播的 performance.now()
    pendingPlay: false, // 还没解码完就收到了 play 命令
    autoPlayTimer: 0, // 「等 UI 发 play」的兜底定时器

    /* ---- A1 预载 ---- */
    playlist: null, // player.addListElement 给的播放列表（数组）
    curTrackId: null, // 当前曲目的 track_id（数字）
    loadedTrackId: null, // 已经解码好、正在播的那首的 track_id
    lastTrack: null, // v0.2.4：最近记进「开机记忆」的 track_id（心跳里打出来，方便看它有没有更新）
    // v0.2.10：slot 多一个 why（"当前曲目" / "下一首" / "开机记忆"），
    // 用来区分「预测」和「已知」—— 只有 why==="下一首" 才参与押中率统计。
    preload: null, // { trackId, why, status:"pending"|"ready"|"failed", buffer, promise, abort }
    preloadToken: 0, // 丢弃过期预载
    preloadState: "idle", // idle | fetching | decoding | ready | failed
    // ★ v1.2.1：trackId → { start, end } 首尾裁剪量。按曲目缓存 —— 预载时算好，
    //   起播/预约/认领时按 trackId 取（预载命中与「即时加载」共用同一份）。
    trimCache: {},
    // ★ v1.2.1：最近播过的缓冲（最多 2 首，见 recentPut）→ 切回来时不下载也不解码
    recentBufs: [],
    // ★ v1.3.1：正在后台把「流式那首」补成缓冲（存 trackId，防重复发起）
    promoteBusy: null,

    /* ---- v0.2.10 自适应：播放顺序到底可不可预测 ---- */
    preloadMisses: 0, // 连续「预载下一首」押不中的次数
    preloadNextOff: false, // true = 已判定「顺序不可预测」（随机播放）→ 不再预载下一首
    seqStreak: 0, // 连续「在列表里索引相邻」的曲目数（免费的「顺序播放」信号）
    lastOrderIdx: -1, // 上一首在列表里的索引
    lastOrderTrackId: null, // 上一首（用来去重：同一首会重复发 setCurrentPlay）

    /* ---- v0.2.9：不再记「播放位置」，只记「哪首歌」 ---- */
    // 「已经写过记忆」的标记。用途只有一个：开机**异步**读记忆时防竞态 ——
    // 读返回前若已写过，说明读到的是刚写进去的值，不能拿它当开机记忆。
    wroteMemory: false,

    /* ---- v0.2.6 / v0.2.7 开机保护窗口 ---- */
    // 读到记忆后开窗。窗口内网易云的「恢复」是**一整串**（setCurrentPlay → load → seek），
    // 全都不算用户行为：不写记忆、不改 curTrackId、不抢预载槽。
    // 关窗条件：用户切到别的歌（≠ 恢复那首），或实际播放累计 ≥10s。
    // （详见文件头 v0.2.6 / v0.2.7 注释）
    bootWindow: false,
    bootRestoreTrackId: null, // 窗口内被判定为「网易云开机恢复」的那首
    bootPlayStart: 0, // 窗口内第一次起播的 performance.now()（判「播放累计 ≥10s」用）
  };

  /* ==================== Web Audio ==================== */

  function ensureCtx() {
    if (S.ctx) return S.ctx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (typeof Ctx !== "function") {
      log("[ctx] ★ 没有 AudioContext");
      return null;
    }
    try {
      S.ctx = new Ctx();
      S.gain = S.ctx.createGain();
      S.gain.gain.value = S.volume;
      S.analyser = S.ctx.createAnalyser();
      S.gain.connect(S.analyser);
      S.analyser.connect(S.ctx.destination);
      log("[ctx] 建图完成 ｜ sampleRate=" + S.ctx.sampleRate + " ｜ state=" + S.ctx.state + " ｜ volume=" + S.volume);
      installFft();
    } catch (e) {
      log("[ctx] ★ 创建失败 ｜ " + (e && e.name) + ": " + (e && e.message));
      S.ctx = null;
    }
    return S.ctx;
  }

  function installFft() {
    try {
      var getFFTData = function () {
        var o = new Uint8Array(S.analyser.frequencyBinCount);
        S.analyser.getByteFrequencyData(o);
        return o;
      };
      window.betterncm_native = window.betterncm_native || {};
      window.betterncm_native.audio = { getFFTData: getFFTData, acquireFFTData: function () {}, releaseFFTData: function () {} };
      betterncm.isMRBNCM = true;
      log("[fft] betterncm_native.audio / betterncm.isMRBNCM 已接管");
    } catch (e) {
      log("[fft] 失败 " + (e && e.message));
    }
  }

  /* ==================== v0.4.0 流式播放（<audio>） ==================== */

  /**
   * 这一首该不该走流式？
   * `window.__gpStream = false` 或自检发现被静音 → 强制走缓冲（退路）。
   */
  function useStream() {
    if (S.silentSuspect) return false;
    try {
      if (typeof window !== "undefined" && window && window.__gpStream === false) return false;
    } catch (e) {}
    return true;
  }

  /**
   * 建（并复用）那个 `<audio>` 元素，把它接进现有音频链。
   *
   * ★ 为什么只建一次：`createMediaElementSource(el)` **对同一个元素只能调一次**，
   *   第二次会抛 `InvalidStateError`。所以整个生命周期复用一个元素，切歌只换 `src`。
   * ★ 为什么**不设 `crossOrigin`**：照 LFP 的做法 —— 它就是这么干的，而且在真机上
   *   **有声音**（跨域音频一旦被 taint，MediaElementSource 会输出**纯静音**，
   *   LFP 不可能能用那么久）→ 这台机器上不存在这个问题。
   */
  function ensureEl() {
    if (S.el) return S.el;
    if (!S.ctx) return null;
    var El = null;
    try {
      if (typeof Audio === "function") El = new Audio();
    } catch (e) {
      El = null;
    }
    if (!El) {
      log("[stream] ★ 拿不到 Audio 构造器 → 这一首走缓冲路径");
      return null;
    }
    try {
      El.preload = "auto";
      El.volume = 1; // 音量统一由 S.gain 控，别两处都调
      S.mediaSrc = S.ctx.createMediaElementSource(El);
    } catch (e) {
      log("[stream] ★ createMediaElementSource 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
      S.el = null;
      S.mediaSrc = null;
      S.mediaGain = null;
      S.mediaFilter = null;
      return null;
    }
    // ★ v1.3.0/v1.3.2：流式这一路也插「自己的 gain + 高通」，交叉时才能淡出 / 扫频。
    //   ⚠️ 这两层建不起来不能连累流式播放本身 → 退化成直连总线。
    try {
      S.mediaGain = S.ctx.createGain();
      S.mediaFilter = S.ctx.createBiquadFilter();
      S.mediaFilter.type = "highpass";
      S.mediaFilter.frequency.value = EQ_BASE_HZ;
      S.mediaSrc.connect(S.mediaGain);
      S.mediaGain.connect(S.mediaFilter);
      S.mediaFilter.connect(S.gain); // mediaSrc → mediaGain → mediaFilter → gain → analyser → destination
    } catch (e) {
      log("[stream] ★ 流式的 gain/高通建不起来 → 直连总线（交叉时没有淡出）｜ " + (e && e.message));
      S.mediaGain = null;
      S.mediaFilter = null;
      try {
        S.mediaSrc.connect(S.gain);
      } catch (e2) {}
    }
    S.el = El;
    El.addEventListener("durationchange", function () {
      if (S.stream && S.el && isFinite(S.el.duration) && S.el.duration > 0) S.duration = S.el.duration;
    });
    log("[stream] <audio> 已建好（mediaSrc → mediaGain → gain → analyser → destination）");
    return El;
  }

  /** 上一首挂的流式事件清理函数（换歌时先摘掉，天然防「旧歌事件串到新歌」） */
  var detachStream = null;

  /**
   * 给这一首挂流式事件。**每首歌重新挂、换歌先摘** —— 这是最可靠的 token 守卫：
   * 元素的 `loadedmetadata` / `ended` / `error` 本身**不告诉你**是哪一次 load 的，
   * 只有让闭包捕获 token，才能判断「这条事件是不是已经过期」。
   */
  function attachStreamEvents(token) {
    if (detachStream) {
      try {
        detachStream();
      } catch (e) {}
      detachStream = null;
    }
    var el = S.el;
    function onMeta() {
      if (token !== S.loadToken) {
        log("[stream] 旧 token 的 loadedmetadata 被丢弃");
        return;
      }
      if (S.ready) return; // 已经有了，不重复
      clearMetaTimer();
      S.duration = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
      S.pausedAt = 0;
      S.ready = true;
      S.loadedTrackId = S.curTrackId;
      log("[stream] ★★ 就绪（metadata）｜ 时长=" + S.duration.toFixed(2) + "s");
      if (S.pendingSeek !== null) {
        try {
          el.currentTime = S.pendingSeek;
        } catch (e) {}
        S.pendingSeek = null;
      }
      afterReady();
    }
    function onErr() {
      if (token !== S.loadToken) return;
      clearMetaTimer();
      var msg = (el.error && (el.error.message || "code " + el.error.code)) || "unknown";
      log("[stream] ★ 媒体错误 ｜ " + msg);
      // ★ 3.x：客户端通过 audioplayer.load 给的是**加密 musicurl**（不是 URL），
      //   <audio> 直接吃它多数时候能播，但部分曲目会 Format error → 表现为「加载失败」。
      //   这里用插件自己的取址链路重试一次；仍失败才把错误抛给 UI。
      if (isNcm3() && S.elRetryToken !== token) {
        S.elRetryToken = token;
        var tid = S.curTrackId;
        log("[stream] 3.x：加密 token 不可播 → 改用自有地址重试 ｜ track=" + tid);
        var pu2 = S.proactiveUrl;
        var urlP = (pu2 && pu2.promise && pu2.trackId === tid)
          ? pu2.promise.then(function (u) { return u || outerUrlFor(tid); })
          : resolveUrl320(tid).catch(function () { return outerUrlFor(tid); });
        urlP
          .then(function (u) {
            if (token !== S.loadToken) return;
            try {
              el.src = u;
              el.load();
              log("[stream] 重试 src=" + String(u).slice(0, 90));
              armMetaTimer(token);
            } catch (e) {
              log("[stream] ★ 重试设置 src 失败 ｜ " + (e && e.message));
              S.ready = false;
              emitLoad(-1, String(msg));
            }
          })
          .catch(function (e2) {
            log("[stream] ★ 自有地址也不可用 ｜ " + (e2 && e2.message));
            S.ready = false;
            emitLoad(-1, String(msg));
          });
        return;
      }
      S.ready = false;
      emitLoad(-1, String(msg));
    }
    function onEnded() {
      if (token !== S.loadToken) return;
      onNaturalEnd();
    }
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onErr);
    el.addEventListener("ended", onEnded);
    detachStream = function () {
      try {
        el.removeEventListener("loadedmetadata", onMeta);
      } catch (e) {}
      try {
        el.removeEventListener("error", onErr);
      } catch (e) {}
      try {
        el.removeEventListener("ended", onEnded);
      } catch (e) {}
    };

    // ★ v1.5.3：这首的流**提前预开过** → metadata 可能在我们挂监听之前就发完了，
    //   那就补一次（否则会一直等一个不会再来第二次的事件）。
    if (S.preopenUrl && el && Number(el.readyState) >= 1) {
      log("[stream] ★ 复用提前预开的流（metadata 早已就绪）｜ readyState=" + el.readyState);
      onMeta();
    }
  }

  function clearMetaTimer() {
    if (S.metaTimer) {
      clearTimeout(S.metaTimer);
      S.metaTimer = 0;
    }
  }

  /**
   * metadata 兜底：弱网 / 异常源可能一直不触发 `loadedmetadata`，
   * 那样 `onLoad` 就发不出去 → 网易云会**一直转圈**。到点硬发一个 duration=0 的 onLoad。
   */
  function armMetaTimer(token) {
    clearMetaTimer();
    S.metaTimer = setTimeout(function () {
      S.metaTimer = 0;
      if (token !== S.loadToken || S.ready) return;
      log("[stream] ★ metadata 超时（8s）→ 先发 onLoad（duration=0），免得 UI 一直转圈");
      S.ready = true;
      S.loadedTrackId = S.curTrackId;
      afterReady();
    }, 8000);
  }

  /**
   * 起流式播放。返回 true = 已接管（不要再走缓冲路径）。
   * 拿不到元素 / 没有可用 URL → 返回 false，安静退回缓冲路径。
   */
  function startStream(token, url, local) {
    var el = ensureEl();
    if (!el) return false;
    S.stream = true;
    S.trim = null; // ★ v1.2.0：流式 =<audio>的原始时间轴，没法做首尾裁剪（也没有采样级控制）
    S.elToken = token;
    attachStreamEvents(token);
    armMetaTimer(token);

    /** 真正把 src 挂上去。返回 false = 失败（调用方负责退回缓冲路径） */
    function apply(u) {
      // ★ 3.x：若 setCurrentPlay 时预解析的地址**已经到手**，直接用（随机模式下省掉 token 试错那一圈）；
      //   还没到就先用 token（不阻塞起播），失败后由 onErr 复用同一个 promise 重试。
      if (isNcm3()) {
        var pu = S.proactiveUrl;
        if (pu && pu.url && pu.trackId === trackIdOf(token)) {
          log("[stream] 3.x：用预解析地址直接起播（省掉 token 试错）");
          u = pu.url;
        }
      }
      if (token !== S.loadToken) return true; // 已经过期 → 当作已处理
      // ★ v1.5.3：这一首的流已经预开过 → **别再重设 src**（重设 = 重新下载，等于白预开）
      if (S.preopenUrl && S.preopenTrackId !== null && S.preopenTrackId === S.curTrackId) {
        log("[stream] ★ 复用提前预开的 <audio>（不重设 src）");
        S.preopenUrl = null; // 接管完成，交回正常流程
        S.preopenTrackId = null;
        return true;
      }
      S.preopenUrl = null;
      try {
        el.pause();
        el.src = u;
        el.load();
        log("[load] 流式播放 ｜ src=" + String(u).slice(-70));
        return true;
      } catch (e) {
        log("[stream] ★ 设置 src 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
        S.stream = false;
        return false;
      }
    }

    if (local) {
      // 本地文件：`betterncm.fs.mountFile` 给一个可播 URL（LFP 就是这么做的）
      var fs = null;
      try {
        fs = betterncm && betterncm.fs;
      } catch (e) {}
      if (!fs || typeof fs.mountFile !== "function") {
        log("[stream] ★ 本地文件但 fs.mountFile 不在 → 退回缓冲路径");
        S.stream = false;
        return false;
      }
      var r = null;
      try {
        r = fs.mountFile(local);
      } catch (e) {
        log("[stream] ★ mountFile 抛错 → 退回缓冲路径 ｜ " + (e && e.message));
        S.stream = false;
        return false;
      }
      if (r && typeof r.then === "function") {
        r.then(function (u) {
          if (!apply(u)) normalLoad(token, url, local);
        }).catch(function (e) {
          log("[stream] ★ mountFile 失败 → 退回缓冲路径 ｜ " + (e && e.message));
          if (token !== S.loadToken) return;
          S.stream = false;
          normalLoad(token, url, local);
        });
        return true;
      }
      if (!apply(r)) return false;
      return true;
    }

    if (!url) {
      log("[stream] ★ 既没有 musicurl 也没有 path → 退回缓冲路径");
      S.stream = false;
      return false;
    }
    if (!apply(url)) return false;
    return true;
  }

  /**
   * `el.play()` 被拒（最典型是 **autoplay policy**：页面还没有过用户手势）。
   * 做法：排队等下一次用户手势，命中时再起播；**绝不让 promise 的拒绝漏出去**。
   *
   * ⚠️ `gen` 是「第几次尝试起播」的代号：迟到的拒绝（属于更早那次尝试）必须忽略 ——
   *    否则它会把 `S.paused` 翻回去、把手势监听重新挂上，状态就乱了。
   * ⚠️ 这里**刻意不发 `onPlayState(2)`**：UI 刚发过 play，回一个「暂停」可能让它再发一次 play
   *    → 可能变成重试风暴。被拒是罕见的，只记日志，等手势到了自然接上。
   */
  function handlePlayReject(e, gen) {
    if (gen !== undefined && gen !== S.playGen) {
      log("[play] 旧的一次 play() 拒绝被忽略（已经有更新的尝试）");
      return;
    }
    var name = (e && e.name) || "?";
    log("[play] ★ el.play() 被拒 ｜ " + name + " ｜ " + (e && e.message));
    if (name !== "NotAllowedError") return;
    S.paused = true;
    S.pendingPlay = true;
    playClockStop();
    armGestureRetry();
  }

  var gestureArmed = false;

  /** 挂一次性手势监听，用来「等用户第一次点一下」再起播（autoplay policy 的绕法） */
  function armGestureRetry() {
    if (gestureArmed) return;
    gestureArmed = true;
    var fire = function () {
      gestureArmed = false;
      try {
        window.removeEventListener("pointerdown", fire, true);
      } catch (e) {}
      try {
        window.removeEventListener("keydown", fire, true);
      } catch (e) {}
      log("[play] 收到用户手势 → 重试起播");
      try {
        if (S.ctx && S.ctx.state === "suspended") {
          var pr = S.ctx.resume();
          if (pr && pr.catch) pr.catch(function () {});
        }
      } catch (e) {}
      S.pendingPlay = false;
      // ★ 直接调 startPlayback（**绕过** doPlay 的「已经在播就忽略」守卫）：
      //   被拒之后 `S.paused` 可能被一次失败的乐观置位搞成 false，走 doPlay 会直接被忽略掉。
      startPlayback();
    };
    try {
      window.addEventListener("pointerdown", fire, true);
      window.addEventListener("keydown", fire, true);
    } catch (e) {
      gestureArmed = false;
    }
  }

  /* ==================== v1.3.0 · 交叉淡入淡出（P2）==================== */

  /**
   * Spotify 的 crossfade 是**等功率**（equal-power）交叉，不是线性：
   *   淡出 cos(θ·π/2)、淡入 sin(θ·π/2)，θ 从 0 到 π/2。
   *   两条曲线中点都是 -3dB，功率之和恒定；线性交叉中点会「塌一下」（音量听起来掉一截）。
   *
   * ⚠️ 与 v0.4.1 的「无缝预约」是同一条时间轴上的两种模式：
   *   xfade = 0 → B 排在 A 的**结束采样**上（0 间隙，v0.4.1 行为，默认）
   *   xfade > 0 → B 提前 `xf` 秒起播，两边各走一条等功率曲线（Spotify 的 crossfade）
   */

  var XFADE_MAX = 12; // Spotify 的上限就是 12s
  var XFADE_KEY = "gaplessPlayer.xfade";
  var XFADE_POINTS = 64;

  /**
   * ★ v1.4.0：用户只需要选「过渡风格」，不用懂曲线/扫频/时长。
   *
   *   干净 → 0s（采样级无缝，专辑/古典/现场就该这样）
   *   轻过渡 → 2.5s 等功率（歌单日常）
   *   DJ → 3s + 高通扫频 + s 曲线（随机/电子/串烧）
   *
   * 优先级（从高到低）：
   *   ① `window.__gpXfade` 显式时长 / `window.__gpXfadeCurve` / `window.__gpXfadeEq`（老开关，仍然有效）
   *   ② 用户选过的风格（`window.__gpStyle` 或存下来的）
   *   ③ **智能默认**：看播放模式 —— 随机/心动 → 轻过渡；顺序/列表循环/单曲循环 → 干净
   *
   * ★ 为什么智能默认用播放模式：这是我们唯一**可靠**的上下文信号（`NM_SETTING_PLAYER.mode`）。
   *   专辑连听几乎不该交叉，随机歌单几乎都该有一点 —— 用这一个信号就能覆盖大多数人的预期，
   *   而且用户什么都不用设。
   */
  var STYLE_KEY = "gaplessPlayer.style";

  var STYLE_PRESETS = {
    clean: { xfade: 0, curve: "equal", eq: false, label: "干净" },
    light: { xfade: 2.5, curve: "equal", eq: false, label: "轻过渡" },
    dj: { xfade: 3, curve: "s-line", eq: true, label: "DJ" },
  };

  function styleFromMode() {
    var mode = readPlayMode();
    // 随机 / 心动 → 前后没有专辑连续性，给一点过渡
    if (mode === "playrandom" || mode === "playai") return "light";
    return "clean";
  }

  /** 用户显式选过的风格（window > 已存），没选过返回 null（= 走智能默认） */
  function xfadeStyle() {
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpStyle === "string") {
        var w = String(window.__gpStyle).toLowerCase();
        if (STYLE_PRESETS[w]) {
          if (S.style !== w) saveStyle(w);
          return w;
        }
      }
    } catch (e) {}
    return S.style && STYLE_PRESETS[S.style] ? S.style : null;
  }

  function saveStyle(name) {
    try {
      if (!STYLE_PRESETS[name]) return;
      S.style = name;
      localStorage.setItem(STYLE_KEY, name);
    } catch (e) {}
  }

  function loadStyle() {
    try {
      var raw = localStorage.getItem(STYLE_KEY);
      if (raw && STYLE_PRESETS[raw]) S.style = raw;
    } catch (e) {}
  }

  /**
   * 把「显式开关 / 风格 / 智能默认」合成最终的 {sec, curve, eq, source}。
   * `source` 只用于日志与面板显示（好让用户知道现在为什么是这个值）。
   */
  function effectiveXfade() {
    var explicitSec = null;
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpXfade === "number") {
        explicitSec = window.__gpXfade;
        if (Number(S.xfade) !== Number(explicitSec)) saveXfade(explicitSec);
      }
    } catch (e) {}
    if (explicitSec === null && S.xfadeExplicit) explicitSec = S.xfade;

    var styleName = xfadeStyle();
    var preset = styleName ? STYLE_PRESETS[styleName] : null;
    var autoName = styleName ? null : styleFromMode();
    var autoPreset = autoName ? STYLE_PRESETS[autoName] : null;

    var sec;
    var source;
    if (explicitSec !== null) {
      sec = explicitSec;
      source = "explicit";
    } else if (preset) {
      sec = preset.xfade;
      source = "style:" + styleName;
    } else {
      sec = autoPreset ? autoPreset.xfade : 0;
      source = "auto:" + autoName;
    }
    sec = Number(sec);
    if (!isFinite(sec) || sec <= 0) sec = 0;
    else if (sec > XFADE_MAX) sec = XFADE_MAX;
    else if (sec < 0.5) sec = 0;

    // 曲线：显式 > 风格 > 默认
    var curve = "equal";
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpXfadeCurve === "string") {
        curve = String(window.__gpXfadeCurve).toLowerCase();
      } else if (preset) {
        curve = preset.curve;
      }
    } catch (e) {}

    // 扫频：显式 > 风格 > 关
    var eq = false;
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpXfadeEq === "boolean") {
        eq = window.__gpXfadeEq === true;
      } else if (preset) {
        eq = preset.eq === true;
      }
    } catch (e) {}

    return { sec: sec, curve: curve, eq: eq && sec > 0, source: source };
  }

  /** 当前生效的交叉曲线名（显式 > 风格 > equal） */
  function xfadeCurveName() {
    return effectiveXfade().curve;
  }

  /** 单调 0→1 的曲线形状（f(x)，x∈[0,1]） */
  function curveShape(name, x) {
    switch (name) {
      case "linear":
        return x;
      case "s":
      case "s-line":
        return 3 * x * x - 2 * x * x * x; // smoothstep
      case "rs":
      case "r_s-line": // 端部更陡的 S（反向 smoothstep）
        return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
      case "exp":
        return x * x * x;
      case "step":
      case "r_step":
        return x < 0.5 ? 0 : 1;
      case "none":
        return x < 1 ? 0 : 1;
      default:
        return Math.sin(x * Math.PI * 0.5); // equal power（默认）
    }
  }

  /**
   * 生成一条交叉曲线（rising=true 是淡入 0→1）。
   * ★ 淡出用 `f(1-x)` 而不是 `1-f(x)`：等功率的淡出是 cos(θ)，正好是 sin 的镜像；
   *   写成 `1-sin` 就退化成「线性补偿」，中点会塌 -3dB（正是 P2 要避免的毛病）。
   */
  function crossfadeCurve(rising) {
    var name = xfadeCurveName();
    var a = new Float32Array(XFADE_POINTS);
    for (var i = 0; i < XFADE_POINTS; i++) {
      var x = i / (XFADE_POINTS - 1);
      a[i] = curveShape(name, rising ? x : 1 - x);
    }
    return a;
  }

  /** 当前生效的交叉时长（秒），0 = 关。 */
  function xfadeSeconds() {
    return effectiveXfade().sec;
  }

  function saveXfade(v) {
    try {
      S.xfade = Number(v) || 0;
      S.xfadeExplicit = true; // ★ v1.4.0：显式设过时长 → 不再被风格/智能默认覆盖
      localStorage.setItem(XFADE_KEY, String(S.xfade));
    } catch (e) {}
  }

  function loadXfade() {
    try {
      var raw = localStorage.getItem(XFADE_KEY);
      if (raw === null) return;
      var v = Number(raw);
      S.xfadeExplicit = true;
      if (isFinite(v) && v > 0) S.xfade = Math.min(v, XFADE_MAX);
    } catch (e) {}
  }

  /**
   * 每个 source 自己的「增益 + 高通」两级节点链：
   *
   *   src ──▶ gain ──▶ filter(highpass @20Hz，听感上等于直通) ──▶ 总线 S.gain ──▶ …
   *
   * ★ 为什么要提前建好 filter：交叉时想给 A 做「高通扫频淡出」（DJ 过渡的招牌手法），
   *   必须**在起播前**就插在链路里 —— 否则要断开正在响的节点再重连，
   *   真机上会有可闻的爆音。
   * ★ 为什么不能挂在 `S.gain` 上：那是用户音量条，在它上面做曲线 = 改用户的音量。
   */
  var EQ_BASE_HZ = 20; // 默认频率（20Hz 高通≈直通，只挡掉次声）
  var EQ_SWEEP_HZ = 900; // 交叉时 A 扫到多少

  function xfadeEqEnabled() {
    return effectiveXfade().eq;
  }

  function newSourceChain() {
    var g = null;
    var f = null;
    try {
      g = S.ctx.createGain();
      f = S.ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = EQ_BASE_HZ;
      try {
        f.Q.value = 0.707;
      } catch (e) {}
      g.connect(f);
      f.connect(S.gain);
    } catch (e) {
      log("[xfade] ★ 建 gain/filter 失败 ｜ " + (e && e.message));
      // 退化成老链路：直接接总线
      try {
        if (g) g.connect(S.gain);
      } catch (e2) {}
      return { gain: g, filter: null };
    }
    return { gain: g, filter: f };
  }

  /** 从 t0 起用 xf 秒把 param 走一条曲线（rising=true 淡入 / false 淡出） */
  function scheduleFade(param, t0, xf, rising) {
    if (!param || !(xf > 0)) return false;
    try {
      param.cancelScheduledValues(0); // ⚠️ 不清掉旧的，setValueCurveAtTime 会因「区间内有事件」抛错
      param.setValueCurveAtTime(crossfadeCurve(rising), t0, xf);
      return true;
    } catch (e) {
      log(
        "[xfade] ★ " + (rising ? "淡入" : "淡出") + "排不上 ｜ " + (e && e.name) + ": " + (e && e.message)
      );
      return false;
    }
  }

  /** 交叉期间给「出场的 A」做高通扫频（20Hz → 900Hz），把低频让给新歌 */
  function scheduleEqSweep(filter, t0, xf) {
    if (!filter || !filter.frequency || !(xf > 0)) return false;
    try {
      var p = filter.frequency;
      p.cancelScheduledValues(0);
      p.setValueAtTime(EQ_BASE_HZ, t0);
      p.linearRampToValueAtTime(EQ_SWEEP_HZ, t0 + xf);
      return true;
    } catch (e) {
      log("[xfade] ★ 扫频排不上 ｜ " + (e && e.name) + ": " + (e && e.message));
      return false;
    }
  }

  /** 撤销预约 / 暂停 / 押错时：把被改过的增益拉回原值（否则 A 会一直以淡出后的音量播） */
  function restoreGain(node, v) {
    if (!node || !node.gain) return;
    try {
      node.gain.cancelScheduledValues(0);
      node.gain.value = v;
    } catch (e) {}
  }

  /** 把高通拉回直通 */
  function restoreEq(filter) {
    if (!filter || !filter.frequency) return;
    try {
      filter.frequency.cancelScheduledValues(0);
      filter.frequency.value = EQ_BASE_HZ;
    } catch (e) {}
  }

  /** 当前“正在响的那一路”的增益节点（缓冲是 source 自己的，流式是元素的） */
  function currentGainNode() {
    return S.stream ? S.mediaGain : S.srcGain;
  }

  /** 当前“正在响的那一路”的高通节点 */
  function currentFilterNode() {
    return S.stream ? S.mediaFilter : S.srcFilter;
  }

  /** 两条路径都停：缓冲的 source + 流式的元素 */
  function stopSource() {
    if (S.source) {
      try {
        S.source.onended = null;
        S.source.stop();
      } catch (e) {}
      try {
        S.source.disconnect();
      } catch (e) {}
      S.source = null;
    }
    // ★ v1.3.0：交叉淡入淡出可能把增益留在中间，停的时候要拉回 1
    restoreGain(S.srcGain, 1);
    S.srcGain = null;
    restoreEq(S.srcFilter); // ★ v1.3.2
    S.srcFilter = null;
    if (S.el && S.stream) {
      try {
        S.el.pause();
      } catch (e) {}
      restoreGain(S.mediaGain, 1); // 流式那一路同理
      restoreEq(S.mediaFilter);
    }
  }

  /** 从 offset 秒处开始播。when = 0 表示立刻。 */
  function startSource(offset, when) {
    if (!S.ctx || !S.buffer) return;
    if (S.sched) cancelSched("重启 source"); // ★ v0.4.1：保险 —— 有预约在就先撤掉，免得双声
    stopSource();
    var src = S.ctx.createBufferSource();
    src.buffer = S.buffer;
    // ★ v1.3.0/v1.3.2：source → 自己的 gain → 自己的高通 → 总线。
    //   有了这两层，A 才能被淡出 / 扫频，而且**不动用户的音量**（S.gain 才是音量条）。
    var chain = newSourceChain();
    if (chain.gain) src.connect(chain.gain);
    else src.connect(S.gain);
    src.onended = function () {
      if (src === S.source) onNaturalEnd();
    };
    var at = when > 0 ? when : S.ctx.currentTime + 0.02;
    // ★★ v1.2.0：offset 是「可听时间轴」上的秒数（UI / pausedAt / position() 都用它），
    //   start() 要的是「缓冲时间轴」→ 必须 + trim.start。
    //   同时把时长传到「可听末尾」为止（第 3 个参数）：尾部填充不会被播出来，
    //   `onended` 也正好落在真正该结束的那个采样上（而不是填充之后）。
    var tr = S.trim || zeroTrim();
    var off = offset || 0;
    var bufAt = off + tr.start;
    var playDur = Math.max(0.02, S.duration - off);
    try {
      src.start(at, bufAt, playDur);
    } catch (e) {
      log("[play] ★ start 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
      return;
    }
    S.source = src;
    S.srcGain = chain.gain; // ★ v1.3.0
    S.srcFilter = chain.filter; // ★ v1.3.2
    S.startCtxTime = at;
    S.startOffset = off; // 仍记「可听时间轴」→ position() 不用改
    log(
      "[play] source.start ｜ at=" +
        at.toFixed(3) +
        " ｜ offset=" +
        off.toFixed(3) +
        " ｜ 缓冲偏移=" +
        bufAt.toFixed(3) +
        " ｜ 时长=" +
        playDur.toFixed(3) +
        " ｜ ctxTime=" +
        S.ctx.currentTime.toFixed(3)
    );
  }

  /** 当前播放位置（曲目内秒数） */
  function position() {
    if (!S.ready) return 0;
    // ★ v0.4.0：流式路径的位置直接问元素要（`currentTime` 在暂停时也是停住的值，
    //   所以不需要 pausedAt 那套「暂停时冻结」的逻辑）
    if (S.stream) {
      if (!S.el) return 0;
      var s = Number(S.el.currentTime) || 0;
      if (s < 0) s = 0;
      if (S.duration > 0 && s > S.duration) s = S.duration;
      return s;
    }
    if (S.paused) return S.pausedAt;
    var p = S.startOffset + (S.ctx.currentTime - S.startCtxTime);
    if (p < 0) p = 0;
    if (S.duration > 0 && p > S.duration) p = S.duration;
    return p;
  }

  /* ==================== 事件伪造 ==================== */

  /**
   * 这是「让网易云 UI 不崩」的全部秘诀（照抄 LFP 的做法）。
   *
   * ★★ v0.1.3 关键修复：**必须做两步，少一步 UI 就没反应。**
   *    LFP 的 mo() 是：
   *      registeredCalls[e].map(f => f(...t));                   ← 派发给 UI 的 JS 处理器
   *      legacyNativeCmder.triggerRegisterCall(name, ns, ...t);   ← 通知原生
   *    v0.1.2 只做了第二句 → UI 的处理器压根没被调用 →
   *    UI 不点播放、不算总时长、不进「播放中」→ 暂停按钮点了没反应。
   */
  function emit(event) {
    var args = Array.prototype.slice.call(arguments, 1);

    // ★ 第一步：派发给 UI 的 JS 处理器（我们自己建的注册表）
    try {
      var RC =
        (typeof registeredCalls !== "undefined" && registeredCalls) ||
        (typeof window !== "undefined" && window.registeredCalls) ||
        null;
      if (RC && RC[event] && RC[event].length) {
        var handlers = RC[event];
        for (var i = 0; i < handlers.length; i++) {
          try {
            handlers[i].apply(null, args);
          } catch (e) {
            log("[emit] ★ 处理器抛错 " + event + " ｜ " + (e && e.message));
          }
        }
      } else if (!RC) {
        if (!emit._warned) {
          emit._warned = true;
          log("[emit] ★ registeredCalls 不存在（startup_script 没生效？），只能走 triggerRegisterCall");
        }
      } else if (!emit._emptyWarned) {
        emit._emptyWarned = true;
        log("[emit] ★ registeredCalls 里没有 " + event + " 的处理器（UI 还没注册？）");
      }
    } catch (e) {
      log("[emit] ★ registeredCalls 派发失败 ｜ " + (e && e.name) + ": " + (e && e.message));
    }

    // 第二步：通知原生
    try {
      if (typeof legacyNativeCmder === "undefined" || !legacyNativeCmder) {
        log("[emit] ★ legacyNativeCmder 不存在，发不出 " + event);
        return;
      }
      var dot = event.indexOf(".");
      var ns = event.slice(0, dot);
      var fn = event.slice(dot + 1); // "onPlayProgress"
      legacyNativeCmder.triggerRegisterCall.apply(legacyNativeCmder, [fn.slice(2), ns].concat(args));
    } catch (e) {
      log("[emit] ★ " + event + " 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
    }
  }

  function emitLoad(errCode, errStr) {
    var payload = {
      activeCode: 0,
      code: errCode || 0,
      duration: S.duration || 0,
      errorCode: errCode || 0,
      errorString: errStr || "",
    };
    log("[emit] onLoad ｜ duration=" + (S.duration || 0).toFixed(2) + " ｜ err=" + (errCode || 0));
    emit("audioplayer.onLoad", S.audioId[0], payload);
  }

  function emitPlayState(n) {
    // n: 1=播放 2=暂停；stateStr 里的 |xxx| 是状态位标记
    var stateStr = String(S.audioId[1] || "");
    stateStr = stateStr.replace(/\|(\S+)\|/, n === 1 ? "|resume|" : "|pause|");
    log("[emit] onPlayState ｜ " + n + " ｜ " + stateStr);
    emit("audioplayer.onPlayState", S.audioId[0], stateStr, n);
  }

  /**
   * 进度心跳。
   *
   * ★★ 第 3 个参数是**加载进度（0~1）**，不是占位符。这是从 LFP 源码里挖出来的：
   *      mo("audioplayer.onPlayProgress", id, currentTime, buffered.end(0) / duration)
   *
   *    v0.1.1 之前一直发 0 → 网易云以为「这首歌一点都没缓冲好」→
   *    进度条一直转圈 + 暂停按钮不干活（压根不发 audioplayer.pause）+ 时间显示 00:00。
   *    我们是整首解码完才播的，所以永远是 1（完全加载）。
   *
   * 另外照 LFP 的做法：**位置没变就不发**（暂停时自然就不发了）。
   */
  function emitProgress(force) {
    var pos = position();
    var first = S.lastEmitPos < 0;
    if (!force && Math.abs(pos - S.lastEmitPos) < 0.0005) return;
    S.lastEmitPos = pos;
    if (first) log("[prog] 首次进度 ｜ pos=" + pos.toFixed(3) + " ｜ loadProgress=1（整首已解码完）");
    emit("audioplayer.onPlayProgress", S.audioId[0], pos, 1);
  }

  /* 播放时长累计（onEnd 的 playedTime 要真实毫秒数，不能一直是 0） */

  function playClockStart() {
    if (!S.playStartedAt) S.playStartedAt = performance.now();
  }

  function playClockStop() {
    if (S.playStartedAt) {
      S.playedMs += performance.now() - S.playStartedAt;
      S.playStartedAt = 0;
    }
  }

  function emitSeek(t) {
    log("[emit] onSeek ｜ → " + t);
    emit("audioplayer.onSeek", S.audioId[0], S.audioId[1], 0, t);
  }

  function emitVolume(v) {
    log("[emit] onVolume ｜ " + v);
    emit("audioplayer.onVolume", S.audioId[0], "", 0, v);
  }

  function isNcm3() {
    try {
      var conf = (typeof APP_CONF !== "undefined" && APP_CONF) ||
        (typeof window !== "undefined" && window && window.APP_CONF) || null;
      return /^3\./.test(String((conf && conf.appver) || ""));
    } catch (e) {
      return false;
    }
  }
  function emitEnd() {
    // ★ 3.1.42 兼容补丁：3.x 客户端**自己也会判定播完并推进**，我们伪造的 onEnd 会和它叠加，
    //   表现为「快播完时直接跳到第三首」（实测 200ms 内两次 player.setCurrentPlay）。
    //   所以 3.x 上先不伪造，等客户端自己推进；1.5s 内没动静才补发兜底。
    // ★ 3.x 撤回：客户端不会自己推进，必须立刻伪造 onEnd（否则必然多 1.5s 静音）。
    //   「跳一首」留给 getPlaybackInfo/getPlayedTime 的抑制逻辑去处理。
    S.__endedAt = Date.now();
    realEmitEnd();
  }
  function realEmitEnd() {
    log("[emit] onEnd ｜ playedTime=" + Math.round(S.playedMs) + "ms");
    emit("audioplayer.onEnd", S.audioId[0], {
      activeCode: 0,
      code: 0,
      errorCode: 0,
      errorString: "",
      playedTime: S.playedMs,
    });
    emit("audioplayer.onPlayProgress", S.audioId[0], 0, 0);
    S.playedMs = 0;
    S.lastEmitPos = -1;
  }

  /* ==================== 播放控制 ==================== */

  /** 等 UI 的 play 命令；500ms 没等到就兜底自动起播（避免一直不出声） */
  function scheduleAutoPlayFallback() {
    if (S.autoPlayTimer) clearTimeout(S.autoPlayTimer);
    S.autoPlayTimer = setTimeout(function () {
      S.autoPlayTimer = 0;
      if (!S.ready || !S.paused) return;
      log("[play] UI 一直没发 play（500ms）→ 兜底自动起播");
      doPlay();
    }, 500);
  }

  /**
   * ★ v0.4.0：**真的去起播**（不做「已经在播就忽略」的判断）。
   *   为什么要把这段单独拆出来：`el.play()` 的拒绝是**异步**的（微任务），
   *   而 `doPlay()` 是**乐观**地把 `S.paused` 置成 false 的 —— 于是「一次失败的尝试」
   *   会把状态留在「看起来在播」，让后续的 `doPlay()` 直接 `已经在播，忽略` 而不去真播。
   *   所以「等手势重试」必须绕过那个守卫，直接调这里。
   */
  function startPlayback() {
    S.paused = false;
    // ★ 每次尝试都记一个代号：迟到的拒绝（属于更早那次尝试）直接忽略，
    //   否则它会把「手势监听」重新挂上、让状态来回翻。
    var gen = ++S.playGen;
    if (S.stream) {
      if (!S.el) {
        log("[play] ★ 流式却没有元素，忽略");
        S.paused = true;
        return;
      }
      var p = null;
      try {
        p = S.el.play();
      } catch (e) {
        log("[play] ★ el.play() 抛错 ｜ " + (e && e.name) + ": " + (e && e.message));
      }
      if (p && p.catch) {
        p.catch(function (e) {
          handlePlayReject(e, gen);
        });
      }
    } else {
      startSource(S.pausedAt, 0);
    }
    playClockStart();
    emitPlayState(1);
  }

  function doPlay() {
    if (!S.ready) {
      log("[play] 还没就绪，排队等就绪");
      S.pendingPlay = true;
      return;
    }
    if (!S.paused) {
      // ★ v0.4.1：无缝认领路径 —— 交接后 UI 才发首个 play，此时 B **已经在播**，
      //   不能重启；但要**补发 onPlayState(1)**，否则 UI 可能停在「暂停」
      //   （v0.4.0 里首个 play 是靠 startPlayback() 发的，认领路径跳过了它）。
      if (S.sched && S.sched.phase === "claimed" && !S.sched.announced) {
        S.sched.announced = true;
        log("[play] ★ 无缝认领 → 补发 onPlayState(1)（不重启）");
        emitPlayState(1);
        S.sched = null;
        return;
      }
      log("[play] 已经在播，忽略");
      return;
    }
    try {
      if (S.ctx && S.ctx.state === "suspended") {
        var pr = S.ctx.resume();
        if (pr && pr.catch) pr.catch(function () {}); // ★ 别让 promise 的拒绝漏出去
        log("[play] ctx.resume() ｜ state=" + S.ctx.state);
      }
    } catch (e) {}
    // ★ v0.2.7：窗口内记下第一次起播时刻，用来判「播放累计 ≥10s」
    //   （网易云那串恢复是毫秒级的，能连续播 10 秒只可能是人在听）
    if (S.bootWindow && !S.bootPlayStart) S.bootPlayStart = performance.now();
    startPlayback();
  }

  function doPause() {
    if (S.sched) cancelSched("暂停"); // ★ v0.4.1：暂停必须撤销预约（否则 B 会到点自己响）
    if (!S.ready) {
      log("[pause] 还没就绪，忽略");
      S.pendingPlay = false;
      return;
    }
    if (S.paused) {
      log("[pause] 已经是暂停态，忽略");
      return;
    }
    S.pausedAt = position();
    S.paused = true;
    if (S.stream) {
      if (S.el) {
        try {
          S.el.pause();
        } catch (e) {}
      }
    } else {
      stopSource();
    }
    playClockStop();
    log("[pause] ★ 已停 ｜ 停在 " + S.pausedAt.toFixed(3) + "s");
    // ★ v0.2.9：暂停**不再**落盘（不记位置了）。歌名在「选中 / 加载」时已经记过。
    emitPlayState(2);
  }

  function doSeek(t) {
    t = Number(t);
    if (!isFinite(t) || t < 0) t = 0;
    if (S.sched) cancelSched("拖动"); // ★ v0.4.1：拖动改变了结束时刻 → 预约作废
    if (!S.ready) {
      // ★ v0.4.0：还没就绪也能记下来，等就绪后再跳（流式下 metadata 还没到就没法设 currentTime）
      log("[seek] 还没就绪 → 记下 " + t.toFixed(3) + "s，等就绪后再跳");
      S.pendingSeek = t;
      return;
    }
    if (S.duration > 0 && t > S.duration) t = S.duration;
    S.pausedAt = t;
    if (S.stream) {
      if (S.el) {
        try {
          S.el.currentTime = t;
        } catch (e) {
          log("[seek] ★ 设 el.currentTime 失败 ｜ " + (e && e.message));
        }
      }
    } else if (!S.paused) {
      startSource(t, 0);
    }
    log("[seek] ★ 跳到 " + t.toFixed(3) + "s ｜ 播放中=" + !S.paused);
    // ★ v0.2.9：拖动**不再**落盘（不记位置了）。
    emitSeek(t);
    emitProgress(true);
  }

  function doSetVolume(v) {
    v = Number(v);
    if (!isFinite(v)) return;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    S.volume = v;
    if (S.gain) S.gain.gain.value = v;
    log("[vol] ★ 音量 = " + v);
    emitVolume(v);
  }

  function onNaturalEnd() {
    var sc = S.sched;
    if (sc && sc.phase === "armed") {
      // ★ v0.4.1 无缝交接：A 播完 → B 已经在响（start 排在了 A 的结束采样上）→ 0 间隙。
      //   ★ 顺序是命门：`stopSource()` 必须在「提升 B」**之前**（此刻 S.source 仍是 A → 只停 A）。
      //   反过来写（先提升 B 再 stopSource）就会**把正在响的 B 停掉**。
      log(
        "[end] ★ 自然播完 → 无缝交接 ｜ A=" + S.curTrackId + " → B=" + sc.trackId +
          " ｜ 来源=" + (S.stream ? "流式" : "缓冲") +
          (sc.xfade ? " ｜ 交叉=" + sc.xfade.toFixed(2) + "s" : "")
      );
      // ★ v0.4.2：流式的「结束时刻」是从 `duration - currentTime` 推的。万一估晚了
      //   （VBR / 流式 metadata 的 duration 是估算值），`ended` 已经来了而 B 还排在将来
      //   → 立刻换一个新节点「现在起播」：宁可早 5ms，也不留一个空档。
      //   ⚠️ v1.3.0：开了交叉时 `startCtxTime` 是「交叉起点」，本来就早于结束时刻，
      //   所以这里的判断天然不会误触发（真触发了说明交叉根本没开始）。
      if (sc.startCtxTime > S.ctx.currentTime + 0.03) {
        try {
          sc.src.onended = null;
          sc.src.stop();
          sc.src.disconnect();
        } catch (e) {}
        var fix = S.ctx.createBufferSource();
        fix.buffer = sc.buffer;
        if (sc.gain) fix.connect(sc.gain); // ★ v1.3.0：复用 B 的 gain（淡入曲线已经在它身上排好了）
        else fix.connect(S.gain);
        fix.onended = function () {
          if (fix === S.source) onNaturalEnd();
        };
        try {
          // ★ v1.2.0：补起的节点也必须带 B 自己的裁剪（否则这一段会把 B 的首部静音播出来）
          // ★ v1.5.1：入点也要带上（B 可能跳过了一段前奏）
          var fixTrim = sc.trim || zeroTrim();
          fix.start(
            S.ctx.currentTime + 0.005,
            sc.bufOffset !== undefined ? sc.bufOffset : fixTrim.start,
            sc.playDur !== undefined ? sc.playDur : sc.duration
          );
        } catch (e2) {}
        sc.src = fix;
        sc.startCtxTime = S.ctx.currentTime + 0.005;
        log("[sched] ★ 结束时刻估晚了 → B 改成立刻起播（不留空档）");
      }
      playClockStop(); // 把 A 最后一段折进 playedMs
      stopSource(); // ★ 此刻 S.source 仍是 A（流式时是元素）→ 只停 A，绝不碰 B
      S.stream = false; // ★ v0.4.2：从这一刻起由 B 的缓冲发声
      S.source = sc.src;
      S.buffer = sc.buffer;
      S.duration = sc.duration;
      S.trim = sc.trim || zeroTrim(); // ★ v1.2.0：从这一刻起 B 的裁剪量生效
      // ★ v1.3.0：B 自己的 gain 接管（它的淡入曲线已经走完了，值是 1）
      S.srcGain = sc.gain || null;
      S.srcFilter = sc.filter || null; // ★ v1.3.2
      sc.gain = null;
      sc.filter = null;
      sc.fadeA = null;
      sc.fadeB = null;
      sc.eqA = null;
      S.startCtxTime = sc.startCtxTime;
      S.startOffset = sc.startOffset || 0; // ★ v1.5.1：B 可能从半拍/空白之后进场
      S.pausedAt = 0;
      S.paused = false;
      sc.phase = "live";
      emitEnd(); // 发 [end]（用 A 的 audioId + playedMs）；内部清零 playedMs / lastEmitPos
      playClockStart(); // 给 B 重新起表
      return;
    }
    log("[end] ★ 自然播完 ｜ 本曲累计播放 " + Math.round(S.playedMs + (S.playStartedAt ? performance.now() - S.playStartedAt : 0)) + "ms");
    S.paused = true;
    S.pausedAt = S.duration;
    stopSource();
    playClockStop();
    emitEnd();
  }

  /* ==================== A1 预载 ==================== */

  /**
   * 预载下一首：在当前歌还在播的时候，就把下一首下完 + 解码好，
   * 切歌时直接命中，把「每首开头等 2~7 秒」抹掉。
   *
   * ★ 怎么拿到下一首的地址（A0 遗留的唯一硬骨头）：
   *   网易云只在切歌时才发 `audioplayer.load`（带 musicurl），播放列表里也没有 URL。
   *   所以只能主动查 —— 走已装的 LibEAPIRequest（「网易云 API 请求库」）。
   *   它不在 / 查不到 → 安静退回即时加载，绝不影响正常播放。
   */

  /** 从各种形态里抠出数字 track_id（列表项 id / audioId / songId） */
  function trackIdOf(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === "number") return isFinite(x) ? x : null;
    var head = String(x).split("-")[0].split("_")[0];
    return /^\d+$/.test(head) ? Number(head) : null;
  }

  /** 某首 track 在不在当前播放列表里（v0.2.4：判断预载槽/记忆是否还有效） */
  function playlistHas(trackId) {
    if (trackId === null || trackId === undefined) return false;
    var list = S.playlist;
    if (!list || !list.length) return false;
    for (var i = 0; i < list.length; i++) {
      if (trackIdOf(list[i] && list[i].id) === trackId) return true;
    }
    return false;
  }

  /** 当前曲目在列表里的索引（找不到返回 -1） */
  /**
   * 当前曲目（或指定曲目）在列表里的索引；找不到返回 -1。
   * ★ v0.2.10：加了可选参数 `id`。原来只能读 `S.curTrackId`，导致 `setCurrentPlay` 里
   *   那行日志（`S.curTrackId = tid` 还没执行）打出来的索引是**上一首的** —— 会误导排查。
   */
  function playlistIndex(id) {
    var list = S.playlist;
    if (id === undefined) id = S.curTrackId;
    if (!list || !list.length || id === null || id === undefined) return -1;
    for (var i = 0; i < list.length; i++) {
      if (trackIdOf(list[i] && list[i].id) === id) return i;
    }
    return -1;
  }

  /**
   * 列表里的下一首。
   * ⚠️ 只在**顺序播放**下才等于「真正会播的下一首」。随机模式下由网易云客户端自己挑
   * （真机实测：13 次自动续播全部对不上）→ 由 `preloadNextOff` 自适应关掉，见 v0.2.10。
   */
  function nextTrack(id) {
    var list = S.playlist;
    var k = playlistIndex(id);
    if (k < 0 || k + 1 >= list.length) return null;
    return list[k + 1];
  }

  /** 走 LibEAPIRequest 查某首歌的播放地址（★ v1.2.1：并发只发一次，见 `once()`） */
  function resolveUrl(trackId) {
    return once("eapi:" + trackId, function () {
      return resolveUrlOnce(trackId);
    });
  }

  /** 真正的取址实现（别直接调它 —— 走 `resolveUrl` 才有并发去重） */
  function resolveUrlOnce(trackId) {
    return new Promise(function (resolve, reject) {
      var lib = null;
      try {
        lib = (typeof loadedPlugins !== "undefined" && loadedPlugins && loadedPlugins.LibEAPIRequest) || null;
      } catch (e) {}
      if (!lib || typeof lib.eapiRequest !== "function") {
        reject(new Error("LibEAPIRequest 不在（未安装 / 未启用）"));
        return;
      }
      if (typeof lib.isRequestAvailable === "function" && !lib.isRequestAvailable()) {
        reject(new Error("LibEAPIRequest 说请求函数不可用（网易云版本不匹配？）"));
        return;
      }
      var domain = null;
      try {
        domain = (typeof APP_CONF !== "undefined" && APP_CONF && APP_CONF.domain) || null;
      } catch (e) {}
      if (!domain) {
        reject(new Error("拿不到 APP_CONF.domain"));
        return;
      }
      var done = false;
      function pick(res, tag) {
        try {
          var d = res && res.data && res.data[0];
          var u = d && d.url;
          if (u) {
            if (!done) {
              done = true;
              log("[preload] 地址来自 " + tag + " ｜ br=" + (d.br || "?") + " ｜ size=" + (d.size || "?"));
              resolve(u);
            }
          } else {
            log("[preload] " + tag + " 没给 url ｜ res=" + JSON.stringify(res).slice(0, 160));
          }
        } catch (e) {}
      }
      function fallbackDownload() {
        lib.eapiRequest(domain + "/api/song/enhance/download/url", {
          method: "POST",
          type: "json",
          data: { id: trackId, br: 999000 },
          onload: function (res) {
            pick(res, "download/url");
            if (!done) reject(new Error("两个接口都没给 url"));
          },
          onerror: function (e) {
            if (!done) reject(e || new Error("请求失败"));
          },
        });
      }
      // 优先播放接口（正是播放器在用的那个）；失败再试下载接口（LibEAPIRequest 自己用的就是后者）
      lib.eapiRequest(domain + "/api/song/enhance/player/url", {
        method: "POST",
        type: "json",
        data: { ids: "[" + trackId + "]", br: 999000 },
        onload: function (res) {
          pick(res, "player/url");
          if (!done) fallbackDownload();
        },
        onerror: function () {
          fallbackDownload();
        },
      });
    });
  }

  /* ==================== 逃生开关：整条放行给原生 ==================== */

  /**
   * `window.__gpNativeAll = true` → `audioplayer.*` 一律放行给网易云原生播放器。
   *
   * ⚠️ 这**不是**「按播放模式分流」（v0.3.0 那套已删）。它只是一个**手动逃生开关**：
   * 万一流式播放在这台机器上出意外（最典型的是跨域音频被静音 → 彻底没声音），
   * 在控制台敲一行就能把播放整条交回原生，不用重装插件。
   */
  function passAllToNative() {
    try {
      return !!(typeof window !== "undefined" && window && window.__gpNativeAll);
    } catch (e) {
      return false;
    }
  }

  /**
   * 该不该预载、预载谁。
   *
   * ★ v0.2.2 两条规则：
   *   ① 当前曲目**还没就绪** → 预载它**自己**（"开机就把第一首也预下"）。
   *      真机时序（开机）：插件 onLoad →(+1.74s) setCurrentPlay →(+4.84s) audioplayer.load。
   *      中间有 **3.1 秒**，足够把「马上就要播的那首」下完 → 第一首也秒开。
   *   ② 当前曲目**已经在播** → 预载列表里的**下一首**（切歌命中）。
   */
  function maybePreload() {
    // ★ v0.4.0：已经判定「播放顺序 ≠ 列表顺序」（随机播放）→ **什么都不预载**。
    //   这条曲目和下一首都会走流式（浏览器边下边播），预载纯属白下
    //   （真机：随机模式下 45 分钟白下 1076MB，就是这个坑）。
    //   重新打开只靠「连续 2 首在列表里索引相邻」这个**免费**信号（见 notePlayOrder）。
    if (S.preloadNextOff) return;
    var cur = S.curTrackId;
    if (cur === null) return;

    // ① 当前曲目还没就绪（刚切过来 / 还没播上）→ 预载它自己
    if (S.loadedTrackId !== cur) {
      if (!hasPreload(cur)) startPreload(cur, "当前曲目");
      return;
    }

    // ② 已在播 → 预载下一首（它是「无缝预约」和「切歌 0 等待」的前提）
    var nt = nextTrack();
    if (!nt) return;
    var id = trackIdOf(nt.id);
    if (id === null || id === cur) return;
    if (!hasPreload(id)) startPreload(id, "下一首");
  }

  /**
   * ★ v0.2.10：结算上一次「预载下一首」押没押中。
   *
   * ⚠️ 必须在 `maybePreload()` **之前**调用！一旦 maybePreload 发现当前曲目没预载，
   *    它会 `startPreload(当前曲目)` 把那个预测槽**换掉**（真机时序：setCurrentPlay → 80ms → load，
   *    换槽发生在 setCurrentPlay 那一刻），之后再也看不出押没押中。
   *
   * 只有 `why === "下一首"` 才算「预测」——「预载当前曲目」是我们**已经知道**要播才下的，
   * 押不押中不说明「播放顺序可不可预测」。
   */
  function notePrediction(tid) {
    var p = S.preload;
    if (!p || p.why !== "下一首") return;
    if (p.trackId === tid) {
      // ★ 3.1.42：命中历史（随机模式下就靠它决定敢不敢预约无缝）
      S.hitStreak = (S.hitStreak || 0) + 1;
      // 押中了 → 顺序可预测，计数清零（之前误判过的话在这里恢复）
      if (S.preloadNextOff) {
        S.preloadNextOff = false;
        S.preloadMisses = 0;
        log("[preload] ★ 预测恢复命中（预载 " + tid + " = 实际要播的）→ 重新开启「预载下一首」");
      } else if (S.preloadMisses) {
        log("[preload] ✓ 预测命中 → 连续失败计数清零（原 " + S.preloadMisses + "）");
      }
      S.preloadMisses = 0;
      return;
    }
    S.hitStreak = 0;
    S.preloadMisses++;
    log(
      "[preload] ✗ 预测失败 " + S.preloadMisses + "/" + PRELOAD_MISS_LIMIT +
        " ｜ 预载的是 " + p.trackId + "，实际要播 " + tid
    );
    if (S.preloadMisses >= PRELOAD_MISS_LIMIT && !S.preloadNextOff) {
      S.preloadNextOff = true;
      log(
        "[preload] ★★ 连续 " + PRELOAD_MISS_LIMIT + " 次押不中 → 判定「播放顺序 ≠ 列表顺序」" +
          "（随机播放？）→ 停止预载下一首（保留「预载当前曲目」）"
      );
    }
  }

  /**
   * ★ v0.2.10：**免费**的「顺序播放」信号 —— 连续几首在列表里索引相邻。
   *
   * 随机播放下「连续 2 首恰好在列表里相邻」的概率 ≈ 1/列表长度（真机 900 首）→ 几乎不会误判。
   * 所以这比「再白下一首去试探」好得多：零流量。
   */
  function notePlayOrder(tid) {
    if (tid === null || tid === undefined) return;
    if (tid === S.lastOrderTrackId) return; // 同一首会重复发 setCurrentPlay，不算新的一首
    var idx = playlistIndex(tid);
    var adj = idx >= 0 && S.lastOrderIdx >= 0 && idx === S.lastOrderIdx + 1;
    S.seqStreak = adj ? S.seqStreak + 1 : 0;
    S.lastOrderIdx = idx;
    S.lastOrderTrackId = tid;
    if (S.preloadNextOff && S.seqStreak >= 2) {
      S.preloadNextOff = false;
      S.preloadMisses = 0;
      log(
        "[preload] ★ 连续 " + S.seqStreak + " 首在列表里索引相邻 → 判定「顺序播放」" +
          "→ 重新开启「预载下一首」"
      );
    }
  }

  /** 预载槽里是不是已经有这一首（pending / ready 都算） */
  function hasPreload(trackId) {
    return !!(S.preload && S.preload.trackId === trackId);
  }

  function startPreload(trackId, why) {
    // ★ v0.2.5：换槽前先把上一个在飞的下载掐断（否则它照跑到底，白花带宽）
    var old = S.preload;
    // ★ v1.5.3：换的是**别的歌** → 之前为它预开的流没用了，清掉（别白占连接）
    if (S.preopenUrl && S.preopenTrackId !== S.curTrackId && (!old || old.trackId !== trackId)) {
      clearPreopen("换预载目标");
    }
    if (old && old.abort) {
      try {
        old.abort.abort();
      } catch (e) {}
    }
    var tk = ++S.preloadToken;
    // ★ v1.2.0：gapless 信息在这里解析、留到后面两个 .then 用 ——
    //   ⚠️ 必须声明在**函数作用域**：放进去 `then(buf)` 里下一层就取不到了（会 ReferenceError → 预载永远失败）。
    var ginfo = null;
    // AbortController 拿不到就安静退化（老 webview 没有它 → 退回旧行为，不抛错）
    var ac = null;
    try {
      if (typeof AbortController === "function") ac = new AbortController();
    } catch (e) {
      ac = null;
    }
    var slot = { trackId: trackId, why: why || "?", status: "pending", buffer: null, promise: null, abort: ac, url: null };
    S.preload = slot;
    S.preloadState = "fetching";
    var t0 = performance.now();
    log("[preload] 开始预载（" + (why || "?") + "）｜ track=" + trackId);
    // ★ v1.2.1：这一首刚播过（缓冲还在 LRU 里）→ 直接把槽填成 ready，不下载也不解码。
    //   真机证据：A→B→A 这种「切走再切回来」每次都会白下一整首（5~6MB）+ 重解 ~600ms。
    var reuse = recentGet(trackId);
    if (reuse) {
      slot.status = "ready";
      slot.buffer = reuse;
      slot.trim = trimOf(trackId);
      S.preloadState = "ready";
      slot.promise = Promise.resolve(reuse);
      log(
        "[preload] ★ 复用刚播过的缓冲（不下载 / 不解码）｜ track=" + trackId + " ｜ " +
          mb(reuse.length * reuse.numberOfChannels * 4)
      );
      return slot.promise;
    }
    // ★ v1.2.1：字节缓存命中就完全跳过「取址 + 下载」（真机实测同一首会被反复预载）
    var cachedBytes = cacheGetBytes(trackId);
    if (cachedBytes) log("[preload] ★ 字节缓存命中 → 跳过取址 + 下载 ｜ track=" + trackId);
    slot.promise = (cachedBytes
      ? Promise.resolve(cachedBytes)
      : resolveUrl(trackId)
          .then(function (url) {
            if (url) slot.url = url; // ★ v1.5.3：记下来，B 没下完时用它提前预开流
            if (tk !== S.preloadToken) return null;
            return fetchBytes(url, ac ? ac.signal : null);
          })
          .catch(function (e) {
            // ★ 3.x：LibEAPI 那条取址路在 3.x 上必然失败（扫到的是 webpack 模块工厂）→
            //   320k 免签名接口 → outer/url(128k) → 原生网络取字节。
            //   2.10.x 保持上游语义（失败直接抛给下游 → 退回流式），不多打请求。
            if (!isNcm3()) throw e;
            if (tk !== S.preloadToken) return null;
            log("[preload] LibEAPI 不可用（" + (e && e.message) + "）→ 试 320k 免签名接口");
            return resolveUrl320(trackId)
              .then(function (url320) {
                if (tk !== S.preloadToken) return null;
                return fetchBytes(url320, ac ? ac.signal : null);
              })
              .catch(function (e2) {
                if (tk !== S.preloadToken) return null;
                log("[preload] 320k 接口失败（" + (e2 && e2.message) + "）→ outer/url(128k) 兜底");
                return fetchBytes(outerUrlFor(trackId), ac ? ac.signal : null).catch(function (e3) {
                  if (tk !== S.preloadToken) return null;
                  log("[preload] 128k 直链也失败（" + (e3 && e3.message) + "）→ 原生网络取字节");
                  return nativeFetchBytes(outerUrlFor(trackId));
                });
              });
          }))
      .then(function (buf) {
        if (!buf || tk !== S.preloadToken) return null;
        S.preloadState = "decoding";
        var ctx = ensureCtx();
        if (!ctx) throw new Error("没有 AudioContext");
        // ★ v1.2.0：gapless 信息必须在 decode **之前**解析 —— decodeAudioData 会转移
        //   这个 ArrayBuffer 的所有权，解完再读就 detach 了（读会抛）。
        try {
          ginfo = gaplessInfo(buf);
        } catch (e) {}
        // ★ v1.2.1：给「字节缓存」留一份副本（decode 会把 buf 本身 detach 掉）
        try {
          cachePutBytes(trackId, buf);
        } catch (e) {}
        return ctx.decodeAudioData(buf).then(function (ab) {
          // ★ 3.x：解出来的时长若明显短于权威时长 → 这是试听/片段，丢掉（否则歌会在边界断掉）
          if (!isNcm3() || !ab) return ab;
          return resolveDurationMs(trackId).catch(function () { return 0; }).then(function (dtMs) {
            if (dtMs && ab.duration && dtMs / 1000 - ab.duration > 3) {
              throw new Error(
                "解码时长 " + ab.duration.toFixed(1) + "s 短于实际 " + (dtMs / 1000).toFixed(1) + "s（试听片段），放弃预载"
              );
            }
            return ab;
          });
        });
      })
      .then(function (ab) {
        if (!ab || tk !== S.preloadToken) return null;
        slot.status = "ready";
        slot.buffer = ab;
        slot.trim = noteTrim(trackId, ginfo, ab); // ★ v1.2.0：首尾裁剪（试听校验之后才裁，别影响判定）
        // ★ v1.5.0：预载时就把拍点算好 —— 轮到它当 B 时调度就在眼前，来不及现算
        if (autoMixEnabled()) {
          try {
            beatHead(trackId, ab);
            beatTail(trackId, ab);
          } catch (e) {}
        }
        S.preloadState = "ready";
        log(
          "[preload] ★★ 预载就绪（" + (why || "?") + "）｜ track=" + trackId + " ｜ " + ab.duration.toFixed(1) + "s ｜ " +
            mb(ab.length * ab.numberOfChannels * 4) + " MB ｜ 耗时 " + (performance.now() - t0).toFixed(0) + "ms"
        );
        return ab;
      })
      .catch(function (e) {
        // ★ v0.2.5：被我们**主动掐断**的（作废 / 换槽）不算失败，安静记一笔就行
        if (e && e.name === "AbortError") {
          log("[preload] 已掐断（作废/换槽）｜ track=" + trackId);
          return null;
        }
        slot.status = "failed";
        if (tk === S.preloadToken) S.preloadState = "failed";
        log("[preload] 放弃（不影响播放）｜ track=" + trackId + " ｜ " + (e && e.message));
        return null;
      });
    return slot.promise;
  }

  /**
   * ★ v0.2.5：作废当前预载槽，并**真的掐断在飞的下载**。
   *
   * 以前只有 `preloadToken++` —— 那只是在各个 .then 检查点丢弃结果，
   * `fetch` 自己照跑到底。真机实测（开机预载 3439759764，size=28057800）：
   *   43.814 [mem] 预载的 3439759764 不在新歌单里 → 作废
   *   45.253 [fetch] ★ 26.76 MB ｜ 1971ms        ← 作废之后那 26.76MB 还是下完了
   * 所以「不白下」是句空话：省掉的只是解码 + 内存，带宽照样花。
   */
  function dropPreload(why, opts) {
    var p = S.preload;
    if (p && p.abort) {
      try {
        p.abort.abort();
      } catch (e) {}
    }
    // ★ v1.5.3：预载作废 → 为它预开的流也一起清掉
    if (S.preopenUrl && !(opts && opts.keepPreopen) && S.preopenTrackId !== S.curTrackId) {
      clearPreopen("预载作废");
    }
    S.preload = null;
    S.preloadToken++;
    S.preloadState = "idle";
    if (why) log("[preload] 作废（" + why + "）｜ track=" + (p ? p.trackId : "?"));
    return p;
  }

  /** 取走**已就绪**的预载（命中返回 buffer 并清空预载槽，否则返回 null） */
  function takePreload(trackId) {
    var p = S.preload;
    if (!p || p.trackId !== trackId || p.status !== "ready") return null;
    S.preload = null;
    S.preloadToken++; // 作废还在飞的预载
    S.preloadState = "idle";
    return p.buffer;
  }

  /** 预载还在飞？返回它的 promise（让 loadSong 等它，别重复下载同一首） */
  function pendingPreload(trackId) {
    var p = S.preload;
    if (!p || p.trackId !== trackId || p.status !== "pending") return null;
    return p.promise;
  }

  /* ==================== v0.4.1 真无缝预约 ==================== */

  /**
   * 读当前播放模式。
   *
   * ★ 真身在 `localStorage` 的 **`NM_SETTING_PLAYER`** 键（`core.js` 的 `m="NM_SETTING_PLAYER"`，
   *   `dc.setting.hS()` 读它）。⚠️ **不是 `PLAYER`** —— leveldb 的键是**前缀压缩**的，
   *   早先在 leveldb 里搜到的 `PLAYER` 其实是这个长键的**尾巴**。
   * 复刻 `hS()`：`mode3 && mode2` 时**实际生效的是 playai**。
   * 读不到 / 格式不对 → 返回 null（调用方退回 `seqStreak` 那个免费信号）。
   */
  function readPlayMode() {
    var raw = null;
    try {
      if (typeof localStorage !== "undefined" && localStorage) raw = localStorage.getItem("NM_SETTING_PLAYER");
    } catch (e) {
      raw = null;
    }
    if (!raw) return null;
    var o = null;
    try {
      o = JSON.parse(raw);
    } catch (e) {
      o = null;
    }
    if (!o || typeof o.mode !== "string") return null;
    if (o.mode3 && o.mode2) return "playai"; // 「心动模式」生效中
    return o.mode;
  }

  /**
   * **只读不消费**地拿预载槽里的 buffer。
   *
   * ★ 为什么不能用 `takePreload()`：它会**清槽 + `preloadToken++`**，导致
   *   ① `notePrediction()` 再也看不出押没押中（自适应瞎了）；
   *   ② `setCurrentPlay(B)` 会触发对 B 的**重复预载**（槽空了 → 规则① 又去下 B）。
   */
  function peekPreloadBuffer(trackId) {
    var p = S.preload;
    if (!p || p.trackId !== trackId || p.status !== "ready") return null;
    return p.buffer;
  }

  /**
   * 撤销预约。
   *   `armed`（source 还没响）→ 停掉它（`stop()` 在起播前调用 = 取消，**不出声**）；
   *   `live` / `claimed`（已在响）→ **只清标记**，别动声音（调用方自己决定要不要停）。
   */
  function cancelSched(why) {
    var sc = S.sched;
    if (!sc) return;
    S.sched = null;
    // ★ v1.3.0：撤销时把 A 的增益拉回来 —— 否则它会被留在淡出中途的音量上
    //   （暂停/拖动都走这里，A 还要继续响）
    restoreGain(sc.fadeA, 1);
    restoreGain(sc.fadeB, 0);
    restoreEq(sc.eqA); // ★ v1.3.2：扫频也要复位，否则 A 会一直闷着
    if (sc.phase === "armed") {
      try {
        sc.src.onended = null;
      } catch (e) {}
      try {
        sc.src.stop();
      } catch (e) {}
      try {
        sc.src.disconnect();
      } catch (e) {}
    }
    log(
      "[sched] 撤销（" + (why || "?") + "）｜ track=" + sc.trackId + " ｜ 阶段=" + sc.phase +
        (sc.xfade ? " ｜ 交叉=" + sc.xfade.toFixed(2) + "s（已复位增益）" : "")
    );
  }

  /**
   * 押错 / 非法：预约的那首不是 UI 真正要播的。
   * `live` 时 B 已经在响 → 必须**停掉它**并复位到「未就绪」，交回正常加载路径。
   * （真机时序：`[end]` 之后 +21ms 就来 `setCurrentPlay` → **错歌只会响 ~21ms**。）
   */
  function abortSeamless(why) {
    var sc = S.sched;
    if (!sc) return;
    S.sched = null;
    log("[sched] ★ 押错 → 撤销预约（" + (why || "?") + "）｜ 原本预约 " + sc.trackId);
    restoreGain(sc.fadeA, 1); // ★ v1.3.0：押错时 A 还要继续响，增益必须复位
    restoreGain(sc.fadeB, 0);
    restoreEq(sc.eqA); // ★ v1.3.2
    if (sc.phase === "armed") {
      try {
        sc.src.onended = null;
      } catch (e) {}
      try {
        sc.src.stop();
      } catch (e) {}
      try {
        sc.src.disconnect();
      } catch (e) {}
      return;
    }
    // live / claimed：B 已经在响 → 停掉 + 复位
    if (S.source === sc.src) {
      try {
        S.source.onended = null;
      } catch (e) {}
      try {
        S.source.stop();
      } catch (e) {}
      try {
        S.source.disconnect();
      } catch (e) {}
      S.source = null;
    }
    // ★ v0.4.2：如果这一首是从流式预约过来的，元素也要按住（防御性，正常已在交接时停掉）
    try {
      if (S.el) S.el.pause();
    } catch (e) {}
    S.ready = false;
    S.paused = true;
    S.buffer = null;
    S.duration = 0;
    S.trim = null; // ★ v1.2.0：押错了 → 裁剪量也跟着作废（下一首自己会重算）
    S.playedMs = 0;
    S.playStartedAt = 0;
  }

  /**
   * 该不该「提前把下一首排到上一首的结束采样上」（真无缝的唯一实现方式）。
   *
   * ★ 为什么必须提前排、不能等 UI：真机实测 `[end]` → +39ms `setCurrentPlay` → +120ms `load`
   *   → 再等 UI 的 `play`，平均 **~195ms** 空档。这 195ms **不是下载造成的，是「等 UI」**。
   *   只有 `AudioBufferSourceNode.start(when)` 能把声音精确排到某个采样点 → 0 间隙。
   *
   * 三重闸门（全过才排）：
   *   ① 当前这一首真的在出声（缓冲要 source / 流式要元素）—— **v0.4.2 起流式也能排**
   *   ② 预载槽里正是「列表里的下一首」且 ready（`why === "下一首"`）
   *   ③ 置信「顺序播放」：`NM_SETTING_PLAYER.mode` 能读到就**一票定音**；读不到退回 `seqStreak >= 2`
   *   ④ 距结束 [0.3, 1.5]s（由 100ms tick 命中）
   */
  /* ==================== v1.5.3 · 提前预开流（B 没下完时缩短接缝空档）==================== */

  /**
   * 问题：无缝的前提是 B **整首下载完 + 解码完**（`AudioBufferSourceNode` 只能播完整的
   *   `AudioBuffer`，Web Audio 没有「流式 buffer 源」）。所以 B 还在下的时候，只能退回流式接力 ——
   *   而流式接力的代价是：`el.src = url` → 等 `canplay` → 才出声，真机实测约 **500ms 空档**。
   *
   * ★ 但这一段空档里，B 的歌其实**已经在本地/在路上了**（预载槽 status=pending，地址也有了）。
   *   所以这里提前把 `<audio>` 的 src 挂上、让它自己缓冲 —— 等真切歌时，`canplay` 往往已经满足，
   *   只剩 `play()` 那一下。
   *
   * 安全边界（这几点必须同时成立，否则宁可不预开）：
   *   ① 当前这首**不走流式**（`S.stream` 为假）—— 那个 `<audio>` 正被当前这首用着，动它就断音；
   *   ② B 的预载槽是 **pending**（还在下/还在解），且**地址已经解析出来**；
   *   ③ 不是「整条交回原生」的逃生状态。
   */

  /** 清掉提前预开的流（换歌 / 预载作废时调） */
  function clearPreopen(why) {
    if (!S.preopenUrl) return;
    S.preopenTrackId = null;
    var was = S.preopenUrl;
    S.preopenUrl = null;
    log("[stream] 清掉提前预开的流（" + (why || "?") + "）｜ " + String(was).slice(-48));
    if (S.stream) return; // 元素正在给当前这首播 → 绝对不动
    try {
      if (S.el) {
        S.el.pause();
        if (typeof S.el.removeAttribute === "function") S.el.removeAttribute("src");
        if (typeof S.el.load === "function") S.el.load();
      }
    } catch (e) {}
  }

  function preopenStream(url, trackId) {
    if (!url) return false;
    if (S.stream) return false; // 元素在用
    if (passAllToNative()) return false;
    var u = String(url);
    if (S.preopenUrl === u) return false; // 已经预开过这一首
    var el = ensureEl();
    if (!el) return false;
    try {
      el.preload = "auto";
      el.src = u;
      if (typeof el.load === "function") el.load();
      S.preopenUrl = u;
      S.preopenTrackId = trackId;
      log("[stream] ★ 提前预开 <audio>（B 还没就绪）｜ " + u.slice(-64));
      return true;
    } catch (e) {
      log("[stream] ★ 预开失败（忽略，照旧走原路）｜ " + (e && e.message));
      return false;
    }
  }

  /** 调度窗口里发现 B 还没 ready → 顺手把它的流预开 */
  function maybePreopenNext(nid) {
    try {
      if (!useStream()) return;
      // ★ 「元素正在用就不许动」这道闸在 preopenStream 内部（这里再判一次是死代码：删掉行为不变）
      if (passAllToNative()) return;
      var p = S.preload;
      if (!p || p.trackId !== nid) return;
      if (p.status !== "pending") return; // ready 就不需要流；failed 也不值得试
      if (!p.url) return; // 地址还没解析出来 → 等下一次 tick
      preopenStream(p.url, p.trackId);
    } catch (e) {}
  }

  function maybeScheduleSeamless() {
    try {
      if (typeof window !== "undefined" && window && window.__gpSeamless === false) return;
    } catch (e) {}
    if (S.sched) return;
    if (!S.ready || S.paused) return;
    // ① 当前这一首必须真的在出声
    if (S.stream) {
      if (!S.el) return;
    } else if (!S.buffer || !S.source) {
      return;
    }
    if (S.preloadNextOff) return; // 已判定「顺序不可预测」→ 不排（流式兜底）

    var nt = nextTrack();
    if (!nt) return;
    var nid = trackIdOf(nt.id);
    if (nid === null || nid === S.curTrackId) return;

    // ★ v1.5.3：B 还没就绪就先把它的流预开（真切歌时省掉 canplay 那几百毫秒）
    maybePreopenNext(nid);

    var p = S.preload;
    if (!p || p.trackId !== nid || p.status !== "ready" || p.why !== "下一首") return;

    // ③ 置信「顺序播放」：能读到模式就让它权威（⚠️ 单曲循环下 seqStreak 会冻结在高位）
    var mode = readPlayMode();
    if (mode !== null) {
      if (mode !== "playonce" && mode !== "playorder") {
        // ★ 3.1.42：随机/心动模式下也未必不可预测 —— 只要**上一次「预载下一首」押中了**
        //   （说明客户端这会儿是顺序推进），就允许预约；没命中就老实等流式接力。
        if (!(isNcm3() && (S.hitStreak || 0) >= 1)) return;
      }
    } else if (!isNcm3() && S.seqStreak < 2) {
      // ★ 3.1.42：3.x 读不到 NM_SETTING_PLAYER（localStorage 拿不到）→ 不能靠 seqStreak 等两首。
      //   改为直接信任「预载槽 == 列表下一首 且 ready」这个已校验过的条件；
      //   万一押错，setCurrentPlay 分支的 abortSeam / cancelSched 会把它撤销。
      return;
    }

    // ④ 时间窗 + 结束时刻
    //   ★ v1.3.0：开了交叉淡入淡出时，窗口要**跟着变宽** —— 3s 的交叉必须在
    //   还剩 ≥3s 的时候就把 B 排上，否则永远进不了这个窗口（旧窗口只有 1.5s）。
    var xf = xfadeSeconds();
    var winMax = Math.max(1.5, xf + 0.4);
    var left;
    var endCtxTime;
    if (S.stream) {
      // ★ v0.4.2：流式那一首也能预约（真机实测：不预约的话自然播完要卡 **503ms**）。
      //   `<audio>` 给不出「采样级」的结束时刻，但 `duration - currentTime` 在 Chrome 里是
      //   **按 last_time_update 插值算出来的**（不是 250ms 一跳），误差只有几毫秒；
      //   而我们要排的只是几秒以内的未来时刻，媒体时钟与 AudioContext 的漂移也可以忽略。
      //   ⚠️ 唯一不确定的是 `duration` 本身（VBR / 流式 metadata 可能是估算值）
      //   → 交接时还有一道「估晚了就立刻起播」的兜底（见 onNaturalEnd）。
      var ed = Number(S.el.duration);
      var ec = Number(S.el.currentTime);
      if (!isFinite(ed) || !isFinite(ec) || ed <= 0) return;
      left = ed - ec;
      if (left < 0.3 || left > winMax) return;
      endCtxTime = S.ctx.currentTime + left;
    } else {
      // ★ v1.2.0：用「可听时长」而不是 `S.buffer.duration` —— 否则会把 A 尾部那 10~40ms
      //   填充也算成音乐，B 就晚进来那么一点点（正是 P0 要消掉的那段）。
      endCtxTime = S.startCtxTime + (S.duration - S.startOffset);
      left = endCtxTime - S.ctx.currentTime;
      if (left < 0.3 || left > winMax) return;
    }

    var buf = peekPreloadBuffer(nid);
    if (!buf) return;

    // ★★ v1.2.0：B 自己的首尾裁剪 —— 绝不能套用 A 的（两首的 delay/padding 不一样）。
    //   start(t0, btrim.start, bdur)：从 B 的「可听起点」起，只播「可听长度」，
    //   于是 A 的最后一个可听采样 → B 的第一个可听采样，中间没有编码器补的静音。
    var btrim = trimOf(nid);
    var bdur = Math.max(0.02, buf.duration - btrim.start - btrim.end);

    // ★ v1.3.0：交叉窗口。xf 受三件事约束：用户设的上限、A 还剩多少、B 有多长。
    var bStart = endCtxTime;
    var fadeSec = 0;
    if (xf > 0) {
      fadeSec = Math.min(xf, left - 0.05, bdur - 0.05);
      if (fadeSec >= 0.5) {
        bStart = endCtxTime - fadeSec;
        if (bStart < S.ctx.currentTime + 0.05) {
          // 排晚了（比如用户刚拖到结尾）→ 只能缩短交叉，宁短暂也不留空档
          bStart = S.ctx.currentTime + 0.05;
          fadeSec = endCtxTime - bStart;
        }
      } else {
        fadeSec = 0; // 窗口不够 → 退回硬接（v0.4.1 行为）
      }
    }
    if (fadeSec < 0.5) fadeSec = 0;

    // ★ v1.5.0：无变速版 Automix —— 用拍点把「交叉起点」吸到 A 的拍上。
    //   交叉起点对应 A 的可听位置 `S.duration - fadeSec`；把它吸到最近一拍，
    //   位移量反向加到交叉时长上（终点不动 = A 的结束时刻不变，只是淡出变长/变短一点）。
    var mixNote = "";
    try {
      if (fadeSec > 0 && autoMixEnabled()) {
        var gA2 = beatTail(S.curTrackId, S.buffer);
        var gB2 = beatHead(nid, buf);
        var plan = mixPlan(gA2, gB2);
        if (plan.tier !== "plain" && gA2) {
          // 拍点网格跑在「缓冲时间轴」上 → 先把可听位置换算过去（加 trim.start）
          var trA = S.trim || zeroTrim();
          var bufPos = S.duration - fadeSec + trA.start;
          var sn = snapToBeat(gA2, bufPos);
          if (sn.delta) {
            var newFade = fadeSec - sn.delta;
            if (newFade >= 0.5 && newFade <= left - 0.05 && newFade <= bdur - 0.05) {
              mixNote =
                " ｜ 拍点对齐 " + (sn.delta * 1000).toFixed(0) + "ms（交叉 " + fadeSec.toFixed(2) +
                "→" + newFade.toFixed(2) + "s）";
              fadeSec = newFade;
              bStart = endCtxTime - fadeSec;
            }
          }
        }
        S.lastPlan = {
          aBpm: gA2 ? gA2.bpm : 0,
          bBpm: gB2 ? gB2.bpm : 0,
          tier: plan.tier,
          dev: plan.dev,
          conf: plan.conf,
        };
        log(
          "[automix] A=" + (gA2 ? gA2.bpm.toFixed(1) + "bpm/置信" + gA2.conf.toFixed(2) : "无") +
            " B=" + (gB2 ? gB2.bpm.toFixed(1) + "bpm/置信" + gB2.conf.toFixed(2) : "无") +
            " → " + plan.tier + "（八度折算后偏差 " + (plan.dev * 100).toFixed(1) + "%）" + mixNote
        );
      }
    } catch (e) {
      log("[automix] ★ 拍点对齐失败（不影响播放）｜ " + (e && e.message));
    }

    // ★ v1.5.1：B 的**入点** —— 用 B 自己的拍点选「从哪一拍进」，顺手跳过开头的空气声。
    //   只在有交叉时才有意义（没交叉就是 A 播完 B 从 0 开始，跳过头就成"吃歌"了）。
    // ★ v1.5.2：没有交叉（干净风格）时也做一件小事 —— 跳过 B 开头的**真静音**
    //   （只跳空白，不做拍点对齐：没有交叉就没有拍点关系，多吃一个整拍等于白吃歌）。
    var entry = { offset: btrim.start, skip: 0, reason: "未启用" };
    if (autoMixEnabled()) {
      try {
        entry = fadeSec > 0
          ? pickBEntry(gB2, btrim, bdur, buf)
          : pickBEntry(null, btrim, bdur, buf, { silenceOnly: true });
        if (entry.skip <= 0.02) {
          entry = { offset: btrim.start, skip: 0, reason: entry.reason };
        }
      } catch (e) {
        log("[automix] ★ 选入点失败（不影响播放）｜ " + (e && e.message));
      }
    }
    var bPlayDur = Math.max(0.02, bdur - entry.skip);
    if (entry.skip > 0.02) {
      log(
        "[automix] B 入点 → " + entry.reason + " ｜ 跳过 " + (entry.skip * 1000).toFixed(0) +
          "ms ｜ 起点=" + entry.offset.toFixed(2) + "s（缓冲）"
      );
    }

    // ★ 手写建 source —— **不能复用 `startSource()`**：它第 3 行无条件 `stopSource()`，会把正在播的 A 停掉。
    var src = S.ctx.createBufferSource();
    src.buffer = buf;
    // ★ v1.3.0/v1.3.2：B 走自己的 gain + 高通（交叉时在它身上做淡入）
    var chainB = newSourceChain();
    var gB = chainB.gain;
    if (gB) src.connect(gB);
    else src.connect(S.gain);
    src.onended = function () {
      if (src === S.source) onNaturalEnd();
    };
    if (fadeSec > 0 && gB) {
      // 淡入：从 0 起，按当前曲线（默认等功率）到 1
      if (!scheduleFade(gB.gain, bStart, fadeSec, true)) {
        restoreGain(gB, 1); // 曲线排不上就别淡了（宁可硬接）
      }
    }
    try {
      src.start(bStart, entry.offset, bPlayDur);
    } catch (e) {
      log("[sched] ★ start 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
      try {
        src.disconnect();
      } catch (e2) {}
      return;
    }

    // ★ v1.3.0：A 的淡出（缓冲用 source 的 gain，流式用元素的 gain）
    var gA = null;
    if (fadeSec > 0) {
      var aNode = currentGainNode();
      if (aNode && aNode.gain) {
        if (scheduleFade(aNode.gain, bStart, fadeSec, false)) gA = aNode;
      }
    }
    // ★ v1.3.2：A 的高通扫频（20Hz→900Hz），把低频让给新歌 —— DJ 过渡的招牌手法
    var eqA = null;
    if (fadeSec > 0 && xfadeEqEnabled()) {
      var aFilter = currentFilterNode();
      if (aFilter && scheduleEqSweep(aFilter, bStart, fadeSec)) eqA = aFilter;
    }

    // ★ 刻意**不动 `S.source`**：A 的 `onended` 守卫是 `src === S.source`，
    //   一旦改成 B，A 播完时守卫失败 → `onNaturalEnd` 不触发 → 不发 `[end]` → UI 永不推进。
    S.sched = {
      src: src,
      trackId: nid,
      buffer: buf,
      duration: bdur, // 整首的可听时长（交接后 S.duration 用它，进度条才不会错）
      startOffset: entry.skip, // ★ v1.5.1：B 的入点（交接后 S.startOffset 用它）
      bufOffset: entry.offset, // ★ v1.5.1：缓冲时间轴上的起点（兜底节点重启时用）
      playDur: bPlayDur, // ★ v1.5.1：从入点起还能播多久
      trim: btrim,
      gain: gB, // ★ v1.3.0：B 的增益节点（交接后成为 S.srcGain）
      filter: chainB.filter, // ★ v1.3.2：B 的高通（交接后成为 S.srcFilter）
      fadeA: gA, // 被淡出的那一路（撤销时要复位）
      fadeB: gB && fadeSec > 0 ? gB : null,
      eqA: eqA, // 被扫频的那一路（撤销时要复位）
      xfade: fadeSec,
      startCtxTime: bStart,
      endCtxTime: endCtxTime,
      phase: "armed",
      announced: false,
    };
    log(
      "[sched] " + (fadeSec > 0 ? "★ 交叉预约" : "预约") + " ｜ A=" + S.curTrackId + " → B=" + nid + " ｜ at=" +
        bStart.toFixed(3) + " ｜ 还剩 " + left.toFixed(2) + "s ｜ 结束 at=" + endCtxTime.toFixed(3) +
        " ｜ 模式=" + (mode || "seqStreak=" + S.seqStreak) +
        " ｜ 来源=" + (S.stream ? "流式" : "缓冲") +
        (entry.skip > 0.02 ? " ｜ B入点=+" + (entry.skip * 1000).toFixed(0) + "ms" : "") +
        " ｜ B裁剪=首" + (btrim.start * 1000).toFixed(1) + "ms 尾" + (btrim.end * 1000).toFixed(1) + "ms" +
        (fadeSec > 0
          ? " ｜ 交叉=" + fadeSec.toFixed(2) + "s（曲线=" + xfadeCurveName() + (eqA ? "+扫频" : "") + "）"
          : " ｜ 交叉=关")
    );
  }

  /**
   * UI 的 `load` 到了，而这一首**已经在响**（我们提前排上的）→ 认领，**不重启**。
   * 真机时序：`load(B)` 在 `[end]` 之后约 +134ms 到达。
   */
  function claimSeamless(id, payload, trackId) {
    var sc = S.sched;
    var token = ++S.loadToken;
    S.stream = false;
    S.audioId = [id, id];
    S.ready = true;
    S.paused = false;
    S.pausedAt = 0;
    S.duration = sc.duration;
    S.buffer = sc.buffer;
    S.trim = sc.trim || zeroTrim(); // ★ v1.2.0：B 的首尾裁剪一并接管
    S.lastEmitPos = -1;
    S.pendingSeek = null;
    if (S.autoPlayTimer) {
      clearTimeout(S.autoPlayTimer);
      S.autoPlayTimer = 0;
    }
    clearMetaTimer();
    S.curTrackId = trackId;
    S.loadedTrackId = trackId;
    sc.phase = "claimed";
    log("[sched] 认领 ｜ track=" + trackId + " ｜ 已在播（不重启）｜ duration=" + sc.duration.toFixed(2) + "s");

    if (S.bootWindow) {
      log("[mem] 窗口内收到 load（track=" + trackId + "）→ 不写记忆（属于网易云的恢复流程）");
    } else {
      saveLastTrack(trackId, "加载");
      notePlayOrder(trackId);
    }
    log("[load] token=" + token + " ｜ track=" + trackId + " ｜ （无缝认领）");
    emitLoad(0, "");
    emitProgress(true);
    maybePreload(); // 规则② → 预载「下一首的下一首」
  }

  /* ---- 开机预载：记住上次播放的那首，下次启动立刻下起来 ---- */

  var MEM_FILE = "C:\\betterncm\\gapless-player.lasttrack.json";
  var LAST_TRACK_KEY = "gaplessPlayer.lastTrack";

  /**
   * ★ v0.2.3：记忆改存**文件**（betterncm.fs），localStorage 只作备份。
   *
   * 为什么不用 localStorage：真机反馈「切了几首后重启，记忆还是固定的一首、时间也不变」。
   * NetEase 的 webview 里 localStorage 是**异步落盘**的 —— 强制结束进程会丢掉最近的写入，
   * 于是记忆永远停在「第一次被 flush 出去的那个值」（时间戳也一起冻住）。
   * betterncm.fs.writeFile 是直写文件（日志就是这么写的，能稳定读到），不受影响。
   *
   * ★ v0.2.9：**只记「哪首歌」**，不记播放位置（payload 回到 `{ id, t }`）。
   */
  function saveLastTrack(trackId, why) {
    if (trackId === null || trackId === undefined) {
      log("[mem] ★ 想记记忆，但 trackId 是空（来源=" + (why || "?") + "）");
      return;
    }
    S.lastTrack = trackId;
    S.wroteMemory = true;
    var payload = JSON.stringify({ id: trackId, t: Date.now() });
    try {
      if (betterncm.fs && typeof betterncm.fs.writeFile === "function") {
        betterncm.fs.writeFile(MEM_FILE, new Blob([payload], { type: "application/json" }));
        log("[mem] 记住当前曲目 ｜ track=" + trackId + " ｜ 来源=" + (why || "?") + " ｜ 已写文件");
      } else {
        log("[mem] ★ betterncm.fs.writeFile 不可用 → 只写 localStorage 备份");
      }
    } catch (e) {
      log("[mem] ★ 写记忆文件失败 ｜ " + (e && e.message));
    }
    try {
      localStorage.setItem(LAST_TRACK_KEY, payload);
    } catch (e) {
      log("[mem] ★ 写 localStorage 备份失败 ｜ " + (e && e.message));
    }
  }

  /** 把各种形态的 readFile 返回值统一成字符串（不同版本 betterncm 返回类型不一样） */
  function toText(r) {
    if (r === null || r === undefined) return Promise.resolve(null);
    if (typeof r === "string") return Promise.resolve(r);
    if (typeof ArrayBuffer !== "undefined" && r instanceof ArrayBuffer) {
      try {
        return Promise.resolve(new TextDecoder().decode(r));
      } catch (e) {
        return Promise.resolve(null);
      }
    }
    if (typeof r.text === "function") {
      return Promise.resolve(r.text()).catch(function () {
        return null;
      });
    }
    if (typeof r.arrayBuffer === "function") {
      return Promise.resolve(r.arrayBuffer())
        .then(function (b) {
          try {
            return new TextDecoder().decode(b);
          } catch (e) {
            return null;
          }
        })
        .catch(function () {
          return null;
        });
    }
    return Promise.resolve(String(r));
  }

  function readMemoryFile() {
    return Promise.resolve()
      .then(function () {
        if (!betterncm.fs || typeof betterncm.fs.readFile !== "function") return null;
        return betterncm.fs.readFile(MEM_FILE);
      })
      .then(toText)
      .catch(function () {
        return null;
      });
  }

  function readMemoryLocal() {
    try {
      return localStorage.getItem(LAST_TRACK_KEY);
    } catch (e) {
      return null;
    }
  }

  /** 解析记忆内容（校验 + 24h 过期），返回 trackId 或 null */
  function parseMemory(raw, from) {
    if (!raw) return null;
    var o = null;
    try {
      o = JSON.parse(raw);
    } catch (e) {
      o = null;
    }
    if (!o || typeof o.id !== "number") return null;
    var age = o.t ? Date.now() - o.t : 0;
    if (o.t && age > 24 * 3600 * 1000) {
      log("[mem] 开机记忆过期（" + Math.round(age / 3600000) + "h > 24h）→ 不猜");
      return null;
    }
    // ★ v0.2.9：老记忆文件里可能还带着 `pos` 字段，**直接忽略**（不再记位置）。
    log(
      "[mem] 读到开机记忆（来自" + from + "）｜ track=" + o.id + " ｜ 写入于 " +
        (o.t ? new Date(o.t).toLocaleString() : "?")
    );
    return o.id;
  }

  /** 开机读记忆：先文件（可靠），读不到再退回 localStorage 备份 */
  function bootFromMemory() {
    readMemoryFile()
      .then(function (raw) {
        var id = parseMemory(raw, "文件");
        if (id !== null) return id;
        return parseMemory(readMemoryLocal(), "localStorage");
      })
      .then(function (id) {
        // ★★ v0.2.7：读文件是**异步**的。如果这期间已经有新的写入（`saveLastTrack` 设过
        //    `S.wroteMemory`），那这次读到的很可能是「刚写进去的值」，**不能**拿它当开机记忆 ——
        //    否则会误开保护窗口，把后面的正常记账全吞掉。
        //    （验证台测试 29 就这么被咬过：先 setCurrentPlay 写了文件，异步读才回来。）
        if (S.wroteMemory) {
          log("[mem] 开机读记忆来晚了（这期间已有更新的写入）→ 忽略这次读取结果");
          return;
        }
        if (id === null) {
          log("[mem] 没有可用的开机记忆 → 等 setCurrentPlay 给真曲目");
          return;
        }
        // ★ v0.2.6：读到了记忆 → 开「开机保护窗口」。
        //   窗口内网易云恢复发来的 setCurrentPlay 不算「用户选歌」，不许覆盖记忆、不许抢预载槽。
        S.bootWindow = true;
        S.bootRestoreTrackId = null;
        S.bootPlayStart = 0;
        log("[mem] 开机保护窗口已开 ｜ 网易云的整串恢复（setCurrentPlay→load→seek）都不算「用户选歌」");
        bootPreload(id);
      })
      .catch(function (e) {
        log("[mem] ★ 读开机记忆失败 ｜ " + (e && e.message));
      });
  }

  /**
   * 开机预载：LibEAPIRequest 可能比我们晚加载，所以要重试几次。
   * 猜错了也不要紧 —— 一旦 setCurrentPlay 给出真曲目，预载槽会被换掉（token 机制）。
   */
  function bootPreload(trackId) {
    var tries = 0;
    function go() {
      tries++;
      if (S.loadedTrackId === trackId || hasPreload(trackId)) return; // 已经不需要了
      var lib = null;
      try {
        lib = (typeof loadedPlugins !== "undefined" && loadedPlugins && loadedPlugins.LibEAPIRequest) || null;
      } catch (e) {}
      if (!lib && tries < 6) {
        setTimeout(go, 400);
        return;
      }
      startPreload(trackId, "开机记忆");
    }
    go();
  }

  /* ==================== 加载 ==================== */

    /* ===== 3.1.42 兼容补丁：原生网络层取流 ===== */
  function outerUrlFor(trackId) {
    return "https://music.163.com/song/media/outer/url?id=" + trackId + ".mp3";
  }
  function strToBuf(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a.buffer;
  }
  function toArrayBuffer(res) {
    var cands = [res, res && res.blob, res && res.data, res && res.body, res && res.buffer, res && res.content, res && res.bytes, res && res.result];
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (!v) continue;
      if (typeof v === "string") { if (v.length) return Promise.resolve(strToBuf(v)); continue; }
      if (v instanceof ArrayBuffer) return Promise.resolve(v);
      if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(v)) return Promise.resolve(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      if (typeof Blob !== "undefined" && v instanceof Blob) return v.arrayBuffer();
      if (typeof v.arrayBuffer === "function") { try { return Promise.resolve(v.arrayBuffer()); } catch (e) {} }
      if (typeof v.byteLength === "number" && typeof v.length === "number") { try { return Promise.resolve(new Uint8Array(v).buffer); } catch (e) {} }
      if (typeof v.length === "number" && v.length > 0 && typeof v[0] === "number") { try { return Promise.resolve(new Uint8Array(v).buffer); } catch (e) {} }
    }
    return Promise.resolve(null);
  }
  function nativeFetchBytes(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error("原生网络超时")); }
      }, timeoutMs || 25000);
      function fin(err, val) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (err) reject(err); else resolve(val);
      }
      try {
        channel.call("network.fetch", function (res) {
          try {
            log("[nafetch] 返回类型=" + Object.prototype.toString.call(res) + " ｜ keys=" + (res && typeof res === "object" ? Object.keys(res).slice(0, 6).join(",") : "?"));
          } catch (e) {}
          toArrayBuffer(res)
            .then(function (buf) {
              if (!buf || !buf.byteLength) { fin(new Error("原生网络没返回字节")); return; }
              log("[nafetch] ★ " + mb(buf.byteLength) + " MB ｜ " + String(url).slice(0, 70));
              fin(null, buf);
            })
            .catch(function (e) { fin(e); });
        }, [{ url: url }]);
      } catch (e) { fin(e); }
    });
  }

  // ★★ 3.x 320k：免签名接口（实测无需 eapi 签名，走客户端原生网络会自动带 cookie）
  //   GET /api/song/enhance/player/url?ids=[id]&br=320000 → data[0].url（br=320000）
  //   ⚠️ /v1 和 /weapi 两个变体都要求签名，会返回 {"msg":"参数错误","code":400}
  function api320Url(trackId) {
    return "https://music.163.com/api/song/enhance/player/url?ids=[" + trackId + "]&br=320000";
  }
  /** 权威时长（ms）：走免签名的 /api/song/detail（公开接口，不需要 cookie）。
   *  用来识别「试听片段」—— 该接口对不同曲目会回 br=320001/320006 等变体，
   *  光看 br 会把完整的 320k 误判成片段。 */
  function resolveDurationMs(trackId) {
    return once("dur:" + trackId, function () {
      return resolveDurationMsOnce(trackId);
    });
  }

  function resolveDurationMsOnce(trackId) {
    var cache = S.durCache || (S.durCache = {});
    if (cache[trackId]) return Promise.resolve(cache[trackId]);
    return nativeFetchBytes("https://music.163.com/api/song/detail?ids=[" + trackId + "]", 12000).then(function (buf) {
      var txt = "";
      try {
        txt = new TextDecoder("utf-8").decode(new Uint8Array(buf));
      } catch (e) {
        var a = new Uint8Array(buf);
        for (var i = 0; i < Math.min(a.length, 8000); i++) txt += String.fromCharCode(a[i]);
      }
      var j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      var s = j && j.songs && j.songs[0];
      var dt = s && (s.duration || s.dt);
      if (!dt) throw new Error("拿不到时长");
      cache[trackId] = Number(dt);
      return Number(dt);
    });
  }

  function resolveUrl320(trackId) {
    return once("url320:" + trackId, function () {
      return resolveUrl320Once(trackId);
    });
  }

  function resolveUrl320Once(trackId) {
    return nativeFetchBytes(api320Url(trackId), 15000).then(function (buf) {
      var txt = "";
      try {
        txt = new TextDecoder("utf-8").decode(new Uint8Array(buf));
      } catch (e) {
        var a = new Uint8Array(buf);
        var s = "";
        for (var i = 0; i < Math.min(a.length, 8000); i++) s += String.fromCharCode(a[i]);
        txt = s;
      }
      var j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      var d = j && j.data && j.data[0];
      if (!d || !d.url) throw new Error("320k 接口没给 url ｜ " + txt.slice(0, 120));
      log("[preload] 320k 接口 ★ br=" + d.br + " ｜ size=" + d.size + " ｜ type=" + d.type +
        " ｜ fee=" + d.fee + " ｜ payed=" + d.payed + " ｜ flag=" + d.flag +
        (d.freeTrialInfo ? " ｜ 试听片段=" + JSON.stringify(d.freeTrialInfo) : ""));
      // ★ 付费/VIP 曲目该接口可能只给**试听片段**，预载它会在片段边界直接断掉。
      //   ⚠️ 不能只看 br：实测完整 320k 会回 br=320001，试听回 320006，数值不可靠。
      //   改为「size/br 估算时长」对比「/api/song/detail 的权威时长」，差得多就是片段。
      if (d.freeTrialInfo) throw new Error("只有试听片段（freeTrialInfo），放弃预载");
      var est = d.size && d.br ? d.size / (d.br / 8) : 0;
      return resolveDurationMs(trackId).catch(function () { return 0; }).then(function (dtMs) {
        if (dtMs && est && Math.abs(est - dtMs / 1000) > 5) {
          throw new Error(
            "试听片段（估算 " + est.toFixed(1) + "s ≠ 实际 " + (dtMs / 1000).toFixed(1) + "s），放弃预载"
          );
        }
        return d.url;
      });
    });
  }
  function fetchBytes(url, signal) {
    var t0 = performance.now();
    // ★ v0.2.5：带上 signal，作废时才能真正把连接掐掉（不传就退回旧的裸 fetch）
    return fetch(url, signal ? { signal: signal } : undefined)
      .then(function (r) {
        log("[fetch] status=" + r.status + " ｜ type=" + r.type + " ｜ CL=" + r.headers.get("content-length"));
        return r.arrayBuffer();
      })
      .then(function (b) {
        log("[fetch] ★ " + mb(b.byteLength) + " MB ｜ " + (performance.now() - t0).toFixed(0) + "ms");
        return b;
      });
  }

  /* ==================== v1.2.1 · 去重与复用（真机日志里的两笔浪费）==================== */

  /**
   * 同一个 key 的并发请求只真正发一次（多个调用方共享同一个 promise）。
   *
   * ★ 真机证据（v1.2.0 首跑日志，01:55:35）：`player.setCurrentPlay` 会先抢着解析一次
   *   320k 地址，`startPreload` 又解析一次 → 同一个 id 的 `player/url` 与 `song/detail`
   *   **各打了两遍**。`once()` 把并发合并成一次；**失败也清掉**，不会把一次失败记成永久结论。
   */
  var INFLIGHT = {};

  function once(key, factory) {
    if (INFLIGHT[key]) return INFLIGHT[key];
    var p;
    try {
      p = factory();
    } catch (e) {
      return Promise.reject(e);
    }
    INFLIGHT[key] = p;
    function clear() {
      if (INFLIGHT[key] === p) delete INFLIGHT[key];
    }
    p.then(clear, clear);
    return p;
  }

  /**
   * 下载过的字节（trackId → ArrayBuffer），LRU 最多 3 份（320k 约 6MB/份）。
   * 真机证据：同一首会被反复预载（换槽 → 换回来），每次都白下一遍 5~6MB。
   *
   * ⚠️ 只给「预载」用：正常加载走的是客户端给的地址（3.x 是加密 token），
   *    拿这里的字节会绕过「试听片段」校验，宁可少省一点也不能播半首。
   * ⚠️ `decodeAudioData` 会 **detach** 传进去的 ArrayBuffer → 交出/存下的都得是副本。
   */
  var BYTES_CACHE_MAX = 3;
  var BYTES_CACHE = {}; // trackId -> { buf, seq }
  var bytesSeq = 0;

  /** 全局缓存开关：`window.__gpCache = false` → 字节缓存与最近缓冲都停用（省内存 / 排查用） */
  function cacheEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpCache === false) return false;
    } catch (e) {}
    return true;
  }

  /** 逃生开关：`window.__gpBytesCache = false` → 只关字节缓存 */
  function bytesCacheEnabled() {
    if (!cacheEnabled()) return false;
    try {
      if (typeof window !== "undefined" && window && window.__gpBytesCache === false) return false;
    } catch (e) {}
    return true;
  }

  function cacheGetBytes(trackId) {
    if (!bytesCacheEnabled()) return null;
    var e = BYTES_CACHE[trackId];
    if (!e || !e.buf || typeof e.buf.slice !== "function") return null;
    e.seq = ++bytesSeq; // LRU：取用即刷新
    try {
      return e.buf.slice(0);
    } catch (err) {
      return null;
    }
  }

  function cachePutBytes(trackId, buf) {
    if (!buf || trackId === null || trackId === undefined) return;
    if (typeof buf.slice !== "function") return;
    if (!bytesCacheEnabled()) return;
    try {
      BYTES_CACHE[trackId] = { buf: buf.slice(0), seq: ++bytesSeq };
    } catch (e) {
      return;
    }
    var keys = [];
    for (var k in BYTES_CACHE) {
      if (Object.prototype.hasOwnProperty.call(BYTES_CACHE, k)) keys.push(k);
    }
    keys.sort(function (a, b) {
      return BYTES_CACHE[a].seq - BYTES_CACHE[b].seq;
    });
    for (var i = 0; i < keys.length - BYTES_CACHE_MAX; i++) delete BYTES_CACHE[keys[i]];
  }

  /**
   * 「刚刚播过的那几首」的缓冲（最多 2 首 / 合计 ≤160MB）。
   * 真机证据：切歌像换台（A→B→A→B→C→B）时，同一首会反复下载 + 解码
   * （日志里 `[trim] track=X` 出现 4 次 = 解了 4 遍）。这里把最近播过的缓冲留住，
   * 再回到它时**不下载也不解码**。
   *
   * ⚠️ 内存：每首 320k 的 3 分钟歌解出来约 50MB。2 首都留下 → 最坏情况
   *    「当前 + 预载 + 2 首最近」= 4 份。所以按字节预算封顶，超了就丢最旧的。
   */
  var RECENT_MAX = 2;
  var RECENT_BUDGET = 160 * 1024 * 1024; // 两首 4~5 分钟的歌（各约 70MB）刚好放下

  function recentGet(trackId) {
    if (!cacheEnabled()) return null;
    var list = S.recentBufs || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].trackId === trackId && list[i].buffer) {
        // LRU：命中的挪到最前
        if (i > 0) {
          var e = list.splice(i, 1)[0];
          list.unshift(e);
        }
        return list[0].buffer;
      }
    }
    return null;
  }

  function recentPut(trackId, buffer) {
    if (!buffer || trackId === null || trackId === undefined) return;
    if (!cacheEnabled()) return;
    var bytes = (buffer.length || 0) * (buffer.numberOfChannels || 1) * 4;
    if (!bytes || bytes > RECENT_BUDGET) return; // 单首就超预算 → 干脆不留
    var list = S.recentBufs || (S.recentBufs = []);
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].trackId === trackId) list.splice(i, 1);
    }
    list.unshift({ trackId: trackId, buffer: buffer, bytes: bytes });
    var total = 0;
    for (var k = 0; k < list.length; k++) total += list[k].bytes;
    while (list.length > RECENT_MAX || total > RECENT_BUDGET) {
      var drop = list.pop();
      if (!drop) break;
      total -= drop.bytes;
    }
  }

  /** 只查「字节缓存里有没有」，不复制（复制 6MB 只为了判断存在与否太浪费） */
  function hasCachedBytes(trackId) {
    if (!bytesCacheEnabled()) return false;
    var e = BYTES_CACHE[trackId];
    return !!(e && e.buf);
  }

  /* ==================== v1.3.1 · 把「流式那一首」补成缓冲 ==================== */

  /**
   * 为什么要有它（v1.2.1 留下的缺口）：
   *   两级缓存（字节缓存 / 最近缓冲）都只在**缓冲路径**上生效 ——
   *   而 `<audio>` 流式播放**不产生 AudioBuffer**，元素被切走之后什么都不剩。
   *   于是「随机播放听过的歌再切回来」还得从头拉一遍流（1~3s），也永远当不了交叉的 B。
   *
   * 做法：这首**真的听了 ≥8 秒**之后，在后台用插件自己的取址链路下一份 + 解码，
   *      塞进 `S.recentBufs`。代价是一次 ~6MB 的下载（这份内容本来就会被重放一遍），
   *      换来「切回来秒开」+「能参与交叉」。
   *
   * ⚠️ 必须走和预载**同一套试听校验**：付费/VIP 曲目 320k 接口只给 64s 片段，
   *   把片段塞进缓存 = 下次直接播半首。宁可放弃，也不能播半首。
   * 逃生开关：`window.__gpPromote = false`。
   */
  var PROMOTE_AFTER_SEC = 8;

  function promoteEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpPromote === false) return false;
    } catch (e) {}
    return true;
  }

  /** 这首「真听了」多少毫秒（暂停期间不计，playClockStart/Stop 维护） */
  function livePlayedMs() {
    return Number(S.playedMs || 0) + (S.playStartedAt ? performance.now() - S.playStartedAt : 0);
  }

  /** 后台把某首下载 + 解码成 AudioBuffer（带试听校验）；**不碰预载槽** */
  function fetchDecoded(trackId) {
    var ginfo = null;
    var cached = cacheGetBytes(trackId);
    var p = cached
      ? Promise.resolve(cached)
      : resolveUrl(trackId)
          .catch(function (e) {
            // 2.10 保持上游语义（失败就放弃）；3.x 退到免签名 320k 接口
            if (!isNcm3()) throw e;
            return resolveUrl320(trackId);
          })
          .then(function (u) {
            if (!u) throw new Error("没拿到地址");
            return fetchBytes(u, null);
          });
    return p
      .then(function (buf) {
        var ctx = ensureCtx();
        if (!ctx) throw new Error("没有 AudioContext");
        try {
          ginfo = gaplessInfo(buf);
        } catch (e) {}
        cachePutBytes(trackId, buf); // decode 会 detach → 先留副本
        return ctx.decodeAudioData(buf);
      })
      .then(function (ab) {
        if (!isNcm3() || !ab) return ab;
        return resolveDurationMs(trackId)
          .catch(function () {
            return 0;
          })
          .then(function (dtMs) {
            if (dtMs && ab.duration && dtMs / 1000 - ab.duration > 3) {
              throw new Error(
                "解码时长 " + ab.duration.toFixed(1) + "s 短于实际 " + (dtMs / 1000).toFixed(1) + "s（试听片段），不补"
              );
            }
            return ab;
          });
      })
      .then(function (ab) {
        if (ab) noteTrim(trackId, ginfo, ab);
        return ab;
      });
  }

  function maybePromoteStream() {
    if (!promoteEnabled()) return;
    if (S.promoteBusy) return;
    if (!S.stream || !S.ready || S.paused || !S.el) return;
    var tid = S.curTrackId;
    if (tid === null || tid === undefined) return;
    var played = livePlayedMs();
    if (played < PROMOTE_AFTER_SEC * 1000) return;
    if (recentGet(tid)) return; // 缓冲已经在手里，不用补
    if (hasCachedBytes(tid)) return; // 字节有了 → 下次预载直接解码，别现在再下一份
    S.promoteBusy = tid;
    var t0 = performance.now();
    log("[promote] 流式那首已听 " + (played / 1000).toFixed(1) + "s → 后台补成缓冲 ｜ track=" + tid);
    fetchDecoded(tid)
      .then(function (ab) {
        if (!ab) return;
        recentPut(tid, ab);
        log(
          "[promote] ★ 已补成缓冲（切回来秒开，也能当交叉的 B）｜ track=" + tid + " ｜ " +
            mb(ab.length * ab.numberOfChannels * 4) + " ｜ 耗时 " + (performance.now() - t0).toFixed(0) + "ms"
        );
      })
      .catch(function (e) {
        log("[promote] 放弃（不影响播放）｜ track=" + tid + " ｜ " + (e && e.message));
      })
      .then(function () {
        if (S.promoteBusy === tid) S.promoteBusy = null;
      });
  }

  function readLocal(path) {
    return Promise.resolve()
      .then(function () {
        if (!betterncm.fs || typeof betterncm.fs.readFile !== "function") throw new Error("没有 betterncm.fs.readFile");
        return betterncm.fs.readFile(path);
      })
      .then(function (r) {
        log("[local] readFile 返回 " + Object.prototype.toString.call(r));
        if (r instanceof ArrayBuffer) return r;
        if (r && typeof r.arrayBuffer === "function") return r.arrayBuffer();
        throw new Error("readFile 返回类型不认识");
      });
  }

  /* ==================== v1.2.0 · 首尾裁剪（P0：MP3 priming / padding）==================== */

  /**
   * 为什么需要它（Spotify 那套 gapless 里最容易漏掉的一层）：
   *   MP3 是有损帧格式，编码器会在**开头补一段静音**（encoder delay / priming），
   *   在**结尾补填充**（padding）。解码出来是「静音 + 音乐 + 静音」，
   *   直接把两首首尾相接，接缝处就多出 **~25ms 空白** —— 比原来的 195ms 小得多，
   *   所以「听不出来」，但它确实还不是 0。FLAC 样本数精确，天然没有这段。
   *
   * ★★ 决定实现方式的关键事实：**Chromium 自己可能已经裁过了**。
   *   它底层是 ffmpeg，ffmpeg 的 mp3 解复用会读 LAME 标签并设置 skip_samples，
   *   解码时就把开头那段丢掉了。所以「照 LAME 声明值硬裁」有可能**把真音乐裁掉**。
   *   → 本实现**不猜**：用解码后的波形自己验（开头/结尾是不是真静音），
   *     LAME 声明值只用来定上限、并打一行 `Δ=` 日志与「理论时长」对拍。
   *
   * 三道保险：
   *   ① 只裁**真静音**（|x| < 1e-4 ≈ -80 dBFS）。安静的前奏/气声不会被吃掉；
   *   ② 每边封顶：有 LAME 头 40ms（encoder 13ms + decoder 约 12ms，再留余量），
   *      没有 LAME 头 20ms；FLAC 不裁（样本精确，多出来的是作者自己的静音）；
   *   ③ `window.__gpTrim = false` 一键关掉，**改了立刻生效，不用出包**。
   *
   * 时间轴约定（改这块代码前先读）：
   *   `S.trim.start/end` 是「缓冲时间轴」上的裁剪量；`S.duration` 与 `position()` /
   *   `startOffset` 一律用**可听时间轴**（= 缓冲时间轴 - trim.start）。
   *   所以 `startSource(offset)` 必须把 offset 换算成 `offset + trim.start` 才交给 start()。
   */

  var TRIM_MAX_START = 0.04; // 开头最多裁 40ms（有 LAME 声明时）
  var TRIM_MAX_END = 0.04; // 结尾最多裁 40ms
  var TRIM_MAX_UNKNOWN = 0.02; // 没有 gapless 信息时，每边只敢裁 20ms
  var TRIM_SILENCE = 1e-4; // 「真静音」阈值（≈ -80 dBFS）
  var TRIM_MIN = 0.0005; // 小于 0.5ms 视为没裁，免得日志里全是 0.1ms 的噪音
  var TRIM_CACHE_MAX = 64; // 裁剪结果缓存条数上限（每首 ~40 字节，防无限增长）

  /** MPEG 版本（2 bit）→ 采样率表；索引非法时该位置为 0（= 保留/非法） */
  var MP3_SR = { "3": [44100, 48000, 32000], "2": [22050, 24000, 16000], "0": [11025, 12000, 8000] };

  function trimEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpTrim === false) return false;
    } catch (e) {}
    return true;
  }

  /**
   * ★ v1.2.1：作品自身的首尾静音要不要一起裁？**默认不裁**。
   *   理由（真机 1.2.0 首跑日志）：这台机器上 ffmpeg 已经把 MP3 的编码器填充裁干净了
   *   （所有曲目 Δ=0.0ms、首=0.0ms），此时波形里还能探到的静音属于作品本身 ——
   *   Spotify 的 gapless 只裁填充，不动作品内容，所以这里默认只裁「填充」那一档。
   *   想要「连作品静音也削掉」（接缝更紧）→ 控制台 `window.__gpTrimPad = true`。
   */
  var TRIM_PAD_DEFAULT = false;

  function trimPadEnabled() {
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpTrimPad === "boolean") {
        return window.__gpTrimPad;
      }
    } catch (e) {}
    return TRIM_PAD_DEFAULT;
  }

  function zeroTrim() {
    return { start: 0, end: 0 };
  }

  /**
   * 从 MP3 字节里读 LAME 的 delay / padding（单位：采样）。找不到 → null。
   *
   * 结构（公开规范，别自己拍脑袋）：
   *   ID3v2（可选）→ 第一个 MPEG 帧头 → 帧内 "Xing"/"Info"
   *   → flags 后的可选字段（frames / bytes / TOC(100B) / quality）
   *   → LAME 标签 → 标签 +21 起 3 字节 = delay(12bit) + padding(12bit)
   *     delay   = (b21 << 4) | (b22 >>> 4)
   *     padding = ((b22 & 0x0F) << 8) | b23
   */
  function parseMp3Gapless(u8) {
    var n = u8.length;
    var i = 0;
    // 跳过 ID3v2（"ID3" + 版本 2B + flags + 同步安全整数大小 4B）
    if (n > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
      var sz = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
      i = 10 + sz + (u8[5] & 0x10 ? 10 : 0); // flags & 0x10 → 还有 10 字节 footer
      if (i < 0 || i >= n) return null;
    }
    // 找第一个帧同步 0xFFEx（ID3 里可能塞了封面，所以不能只看偏移 0）
    var frame = -1;
    var limit = Math.min(n - 4, i + 65536);
    for (var k = i; k < limit; k++) {
      if (u8[k] === 0xff && (u8[k + 1] & 0xe0) === 0xe0) {
        frame = k;
        break;
      }
    }
    if (frame < 0) return null;

    var h1 = u8[frame + 1];
    var h2 = u8[frame + 2];
    var verBits = (h1 >> 3) & 3; // 3=MPEG1 / 2=MPEG2 / 0=MPEG2.5 / 1=保留
    var srTab = MP3_SR[String(verBits)];
    if (!srTab) return null;
    var sr = srTab[(h2 >> 2) & 3];
    if (!sr) return null;
    var spf = verBits === 3 ? 1152 : 576; // MPEG1 Layer III = 1152，MPEG2/2.5 = 576

    // 帧内找 "Xing"/"Info"（帧头 4B 之后是 side info，最多再往后 200B）
    var x = -1;
    var xEnd = Math.min(n - 8, frame + 200);
    for (var j = frame + 4; j < xEnd; j++) {
      if (u8[j] === 0x58 && u8[j + 1] === 0x69 && u8[j + 2] === 0x6e && u8[j + 3] === 0x67) {
        x = j; // "Xing"
        break;
      }
      if (u8[j] === 0x49 && u8[j + 1] === 0x6e && u8[j + 2] === 0x66 && u8[j + 3] === 0x6f) {
        x = j; // "Info"
        break;
      }
    }
    if (x < 0) return null;

    var p = x + 4;
    var flags = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
    p += 4;
    var frames = 0;
    if (flags & 1) {
      frames = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
      p += 4;
    }
    if (flags & 2) p += 4; // bytes
    if (flags & 4) p += 100; // TOC
    if (flags & 8) p += 4; // quality
    if (p + 24 > n) return null;

    // LAME 标签第一个字节是编码器名（"LAME"/"Lavc"/"GOGO"…）→ 必须是可打印 ASCII
    if (u8[p] < 0x20 || u8[p] > 0x7e) return null;
    var delay = (u8[p + 21] << 4) | (u8[p + 22] >> 4);
    var padding = ((u8[p + 22] & 0x0f) << 8) | u8[p + 23];
    if (delay > 4000 || padding > 4000) return null; // 明显是别的数据，别信

    return {
      codec: "mp3",
      sr: sr,
      delay: delay,
      padding: padding,
      // 理论样本数：帧数 × 每帧样本 - 首尾补的。只用于日志对拍，不参与裁剪决策
      samples: frames ? frames * spf - delay - padding : 0,
    };
  }

  /** FLAC：STREAMINFO 里有精确样本数 → 天生无缝，返回它只为了日志对拍 */
  function parseFlacInfo(u8) {
    if (u8.length < 42) return null;
    if (u8[0] !== 0x66 || u8[1] !== 0x4c || u8[2] !== 0x61 || u8[3] !== 0x43) return null; // "fLaC"
    var b = 18; // 4("fLaC") + 4(块头) + 10(min/max block/frame size) = STREAMINFO 的第 10 字节
    var sr = (u8[b] << 12) | (u8[b + 1] << 4) | (u8[b + 2] >> 4);
    var total =
      (u8[b + 3] & 0x0f) * 4294967296 +
      ((u8[b + 4] << 24) >>> 0) +
      (u8[b + 5] << 16) +
      (u8[b + 6] << 8) +
      u8[b + 7];
    if (!sr || !total) return null;
    return { codec: "flac", sr: sr, delay: 0, padding: 0, samples: total };
  }

  /** 把各种形态的字节统一成 Uint8Array（拿不到 → null） */
  function asBytes(bytes) {
    if (!bytes) return null;
    try {
      if (typeof Uint8Array !== "undefined" && bytes instanceof Uint8Array) return bytes;
      if (typeof ArrayBuffer !== "undefined" && bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
      if (bytes.buffer instanceof ArrayBuffer) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength || 0);
      }
    } catch (e) {}
    return null;
  }

  /** 解析 gapless 信息：FLAC 先认（"fLaC" 在偏移 0，ID3 封面里的假 "fLaC" 骗不到它） */
  function gaplessInfo(bytes) {
    var u8 = asBytes(bytes);
    if (!u8 || u8.length < 64) return null;
    try {
      return parseFlacInfo(u8) || parseMp3Gapless(u8);
    } catch (e) {
      log("[trim] ★ 解析异常 ｜ " + (e && e.message));
      return null;
    }
  }

  /** 取每个声道的 Float32 数据；拿不到（验证台的假 buffer / 老实现）→ null */
  function channelData(ab) {
    if (!ab || typeof ab.getChannelData !== "function") return null;
    var ch = ab.numberOfChannels || 1;
    var out = [];
    try {
      for (var c = 0; c < ch; c++) {
        var d = ab.getChannelData(c);
        if (!d || typeof d.length !== "number") return null;
        out.push(d);
      }
    } catch (e) {
      return null;
    }
    return out.length ? out : null;
  }

  /** 开头连续真静音的长度（秒），最多看到 maxSec */
  function silenceHead(ab, maxSec) {
    var fin = channelData(ab);
    if (!fin) return 0;
    var sr = ab.sampleRate || 44100;
    var ch = fin.length;
    var n = Math.min(fin[0].length, Math.ceil(Math.max(maxSec, 0) * sr));
    var i = 0;
    for (; i < n; i++) {
      var loud = false;
      for (var c = 0; c < ch; c++) {
        var v = fin[c][i];
        if (v > TRIM_SILENCE || v < -TRIM_SILENCE) {
          loud = true;
          break;
        }
      }
      if (loud) break;
    }
    return i / sr;
  }

  /** 结尾连续真静音的长度（秒），最多看到 maxSec */
  function silenceTail(ab, maxSec) {
    var fin = channelData(ab);
    if (!fin) return 0;
    var sr = ab.sampleRate || 44100;
    var ch = fin.length;
    var total = fin[0].length;
    var n = Math.min(total, Math.ceil(Math.max(maxSec, 0) * sr));
    var i = 0;
    for (; i < n; i++) {
      var idx = total - 1 - i;
      var loud = false;
      for (var c = 0; c < ch; c++) {
        var v = fin[c][idx];
        if (v > TRIM_SILENCE || v < -TRIM_SILENCE) {
          loud = true;
          break;
        }
      }
      if (loud) break;
    }
    return i / sr;
  }

  /**
   * 把「解析出来的声明值」+「解码后的真实波形」合成两份裁剪量：
   *
   *   enc = 编码器/解码器残留的填充（**必须裁**，不然接缝处是空白）
   *   pad = 作品自身的首尾静音（**默认不裁**，见 TRIM_PAD_DEFAULT）
   *
   * 为什么要分开：真机日志（v1.2.0 首跑）显示这台机器上 ffmpeg **已经把填充裁干净了**
   * （所有曲目 Δ=0.0ms、首=0.0ms），此时波形里还能探到的静音就是作品自己的 ——
   * 把它也削掉虽然让接缝更紧，但已经越过了 Spotify gapless 的语义（它只削填充）。
   * 所以默认只裁 enc，pad 留一个开关（`window.__gpTrimPad = true`）。
   */
  function fitTrim(info, ab) {
    var zero = zeroTrim();
    if (!ab) return { enc: zero, pad: zero, note: "没有 buffer", deltaMs: null };
    if (info && info.codec === "flac") {
      return {
        enc: zeroTrim(),
        pad: zeroTrim(),
        note: "FLAC 样本精确（" + info.samples + "），不裁",
        deltaMs: null,
      };
    }
    var hasLame = !!(info && info.codec === "mp3" && (info.delay || info.padding));
    var capS = hasLame ? TRIM_MAX_START : TRIM_MAX_UNKNOWN;
    var capE = hasLame ? TRIM_MAX_END : TRIM_MAX_UNKNOWN;
    // 多扫 5ms：静音正好等于上限时也要能探到边界，否则会把「刚好 40ms」误判成「>=40ms」
    var foundS = Math.min(silenceHead(ab, capS + 0.005), capS);
    var foundE = Math.min(silenceTail(ab, capE + 0.005), capE);
    if (foundS < TRIM_MIN) foundS = 0;
    if (foundE < TRIM_MIN) foundE = 0;
    if (ab.duration - foundS - foundE < 1) {
      return { enc: zeroTrim(), pad: zeroTrim(), note: "太短，不裁", deltaMs: null };
    }

    // ★ Δ = 解码时长 - LAME 理论时长：≈0 → 解码器已经裁过；≈(delay+padding) → 没裁
    var deltaMs = null;
    if (info && info.samples && info.sr) deltaMs = (ab.duration - info.samples / info.sr) * 1000;

    var encS = 0, encE = 0, padS = 0, padE = 0, note;
    if (!hasLame) {
      // 没有声明值 → 无法区分，只能把「探到的静音」当成残留填充（上限 20ms/边）
      encS = foundS;
      encE = foundE;
      note = "无 gapless 信息 → 按波形裁残留（每边 ≤" + TRIM_MAX_UNKNOWN * 1000 + "ms）";
    } else if (deltaMs !== null && Math.abs(deltaMs) < 3) {
      encS = 0;
      encE = 0;
      padS = foundS;
      padE = foundE;
      note = "解码器已裁（Δ=" + deltaMs.toFixed(1) + "ms）→ 探到的都是作品静音";
    } else {
      var wantS = info.delay / info.sr;
      var wantE = info.padding / info.sr;
      encS = Math.min(foundS, wantS);
      padS = foundS - encS;
      encE = Math.min(foundE, wantE);
      padE = foundE - encE;
      note =
        "解码器未裁（Δ=" + (deltaMs === null ? "?" : deltaMs.toFixed(1) + "ms") + "）→ 按声明值裁填充";
    }
    return {
      enc: { start: encS, end: encE },
      pad: { start: padS, end: padE },
      note: note,
      deltaMs: deltaMs,
    };
  }

  /**
   * 算一首歌的首尾裁剪 → 记进 `S.trimCache[trackId]` → 打一行 `[trim]` 日志。
   * `info` 是**解码前**从字节里解析出来的 gapless 信息（可为 null：拿不到字节 / 没有 LAME 头）。
   *
   * ⚠️ 为什么让调用方先解析、而不是传字节进来：`decodeAudioData` 对 ArrayBuffer 是
   *    **转移所有权**的（解码完原 buffer 就 detach，再读会抛），所以解析必须发生在 decode 之前。
   */
  function noteTrim(trackId, info, ab) {
    if (!ab) return zeroTrim();
    var c = S.trimCache || (S.trimCache = {});
    if (!trimEnabled()) {
      c[trackId] = zeroTrim();
      log("[trim] 已关闭（window.__gpTrim=false）｜ track=" + trackId);
      return zeroTrim();
    }
    var fit = fitTrim(info, ab);
    var padOn = trimPadEnabled();
    var tr = {
      start: fit.enc.start + (padOn ? fit.pad.start : 0),
      end: fit.enc.end + (padOn ? fit.pad.end : 0),
    };
    c[trackId] = { start: tr.start, end: tr.end };

    // 缓存别无限长（真机一次会话可能听过上百首）
    var keys = [];
    for (var k in c) {
      if (Object.prototype.hasOwnProperty.call(c, k)) keys.push(k);
    }
    for (var i = 0; i < keys.length - TRIM_CACHE_MAX; i++) delete c[keys[i]];

    var ms = function (v) {
      return (v * 1000).toFixed(1);
    };
    log(
      "[trim] track=" +
        trackId +
        " ｜ 编码=" +
        ((info && info.codec) || "?") +
        (info && info.codec === "mp3" ? " ｜ LAME delay=" + info.delay + " pad=" + info.padding : "") +
        " ｜ " +
        fit.note +
        (fit.deltaMs === null ? "" : " ｜ Δ=" + fit.deltaMs.toFixed(1) + "ms") +
        (info && info.samples && info.sr ? " ｜ 理论=" + (info.samples / info.sr).toFixed(3) + "s" : "") +
        " ｜ 解码=" +
        ab.duration.toFixed(3) +
        "s ｜ 填充=首" +
        ms(fit.enc.start) +
        " 尾" +
        ms(fit.enc.end) +
        "ms（必裁）｜ 作品静音=首" +
        ms(fit.pad.start) +
        " 尾" +
        ms(fit.pad.end) +
        "ms" +
        (padOn ? "（已裁）" : "（不裁，__gpTrimPad 未开）") +
        " ｜ 可听=" +
        (ab.duration - tr.start - tr.end).toFixed(3) +
        "s"
    );
    return { start: tr.start, end: tr.end };
  }

  /** 取某首的裁剪量（没算过 / 没就绪 → 0，行为与旧版一致） */
  function trimOf(trackId) {
    var c = S.trimCache;
    if (!c || trackId === null || trackId === undefined) return zeroTrim();
    var t = c[trackId];
    if (!t) return zeroTrim();
    return { start: Number(t.start) || 0, end: Number(t.end) || 0 };
  }

  /** 缓冲就绪：落状态、发 onLoad / onPlayProgress，再决定「起播」还是「等 UI」 */
  /**
   * ★ v0.4.0：**两条播放路径共用的「就绪之后」**。
   *   缓冲路径（onBufferReady）和流式路径（<audio> 的 loadedmetadata）都走这里，
   *   免得两边的时序逻辑各写一遍、慢慢跑偏。
   */
  function afterReady() {
    emitLoad(0, "");
    emitProgress(true);
    // ★ A1：这首歌已经就绪 → 现在预载「下一首」
    //   （它同时是「切歌 0 等待」和「无缝预约」的前提）
    maybePreload();
    // ★ v0.1.3：不再抢跑起播。
    //   等 UI 发 `audioplayer.play`（这样 onPlayState 才有 token），500ms 没等到再兜底。
    if (S.pendingPlay) {
      log("[play] 就绪时已收到过 play 命令 → 直接起播");
      S.pendingPlay = false;
      doPlay();
    } else {
      scheduleAutoPlayFallback();
    }
  }

  function onBufferReady(token, ab, tag) {
    if (!ab) return;
    if (token !== S.loadToken) {
      log("[load] 就绪但 token 过期，丢弃");
      return;
    }
    S.stream = false;
    S.buffer = ab;
    // ★★ v1.2.0：可听时长 = 解码时长 - 首尾填充；`trim` 按 trackId 从缓存取（预载时已算好）
    var tr = trimOf(S.curTrackId);
    S.trim = tr;
    S.duration = Math.max(0.05, ab.duration - tr.start - tr.end);
    S.pausedAt = 0;
    S.ready = true;
    S.loadedTrackId = S.curTrackId; // ★ 标记「这一首已经就绪」
    // ★ v1.2.1：留一份「刚刚播过」的引用（最多 2 首）——
    //   真机上「切走再切回来」会重新下载 + 解码一整首，而缓冲其实刚在手里。
    // ★ v1.5.0：算拍点（分析的是刚解码好的 buffer，只算头/尾两段 20s 窗口，带缓存）
    if (autoMixEnabled()) {
      try {
        beatHead(S.curTrackId, ab);
        beatTail(S.curTrackId, ab);
      } catch (e) {}
    }
    recentPut(S.curTrackId, ab);
    // ★ v0.2.9：不再有「开机续播」—— 记忆只记「哪首歌」，不记「播到哪儿」。
    log(
      "[load] ★★ 就绪" + (tag ? "（" + tag + "）" : "") + " ｜ 时长=" +
        S.duration.toFixed(2) + "s（解码 " + ab.duration.toFixed(2) + "s，裁首 " +
        (tr.start * 1000).toFixed(1) + "ms / 尾 " + (tr.end * 1000).toFixed(1) + "ms）｜ " +
        ab.numberOfChannels + "ch @" + ab.sampleRate +
        " ｜ 内存=" + mb(ab.length * ab.numberOfChannels * 4) + " MB"
    );
    afterReady();
  }

  function loadSong(id, payload) {
    var trackId = trackIdOf((payload && payload.songId) || id);
    // ★ v0.4.1：无缝认领 —— 这一首**已经在响**（我们提前排上的）→ 不重新加载、不重启 source。
    if (S.sched && S.sched.phase === "live" && S.sched.trackId === trackId) {
      claimSeamless(id, payload, trackId);
      return;
    }
    if (S.sched) cancelSched("load 非预约曲"); // 还挂着别的预约 → 撤掉（避免双声）
    var token = ++S.loadToken;
    S.audioId = [id, id];
    S.ready = false;
    S.pendingPlay = false;
    S.paused = true;
    S.pausedAt = 0;
    S.duration = 0;
    S.trim = null; // ★ v1.2.0：这一首的裁剪量等 onBufferReady 时按 trackId 取
    S.buffer = null;
    S.lastEmitPos = -1;
    S.playedMs = 0;
    S.playStartedAt = 0;
    S.pendingSeek = null;
    if (S.autoPlayTimer) {
      clearTimeout(S.autoPlayTimer);
      S.autoPlayTimer = 0;
    }
    stopSource(); // ★ 注意：它要用**旧的** S.stream 判断「要不要把 <audio> 也暂停」
    S.stream = false; // 默认这一首走缓冲；流式分支会把它设回 true
    clearMetaTimer();

    var url = payload && payload.musicurl;
    var local = payload && payload.path;
    S.curTrackId = trackId;
    // ★ v0.2.7：窗口内的 load 也是网易云恢复流程的一部分（setCurrentPlay→load→seek），
    //   不能拿它当「用户真的开始听了」，也不能让它写记忆。
    //   （v0.2.6 就是错在「一见 load 就关窗」，于是记忆被写回网易云那首 + 它的进度。）
    if (S.bootWindow) {
      log("[mem] 窗口内收到 load（track=" + trackId + "）→ 不写记忆（属于网易云的恢复流程）");
    } else {
      saveLastTrack(trackId, "加载"); // ★ 记住，供下次开机预载
      // ★ v0.2.10：也在这里喂一次「顺序播放」信号 —— 万一某条路径没发 setCurrentPlay，
      //   load 才是「真的播了什么」的可靠来源。notePlayOrder 自带去重（同一首不重复算）。
      notePlayOrder(trackId);
    }
    log(
      "[load] token=" + token + " ｜ track=" + trackId + " ｜ format=" + (payload && payload.format) + " ｜ bitrate=" + (payload && payload.bitrate) + " ｜ fileSize=" + (payload && payload.fileSize) + " ｜ level=" + (payload && payload.level)
    );
    log("[load] path=" + (local || "(无)"));
    log("[load] musicurl=" + (url ? String(url).slice(-70) : "(无)"));

    // ★★ A1：预载已就绪 → 跳过「下载 + 解码」，直接起播（省下的就是那几秒）
    var pre = takePreload(trackId);
    if (pre) {
      S.stats.plays++;
      S.stats.hitPreload++;
      log("[preload] ★★ 命中！跳过下载 + 解码");
      onBufferReady(token, pre, "预载命中");
      return;
    }

    // ★ v1.2.1：刚刚播过的那一首又回来了 → 缓冲还在，跳过下载 + 解码
    var rb = recentGet(trackId);
    if (rb) {
      S.stats.plays++;
      S.stats.hitRecent++;
      log(
        "[load] ★ 最近缓冲命中（同一首切回来）→ 跳过下载 + 解码 ｜ " +
          mb(rb.length * rb.numberOfChannels * 4)
      );
      onBufferReady(token, rb, "最近缓冲命中");
      return;
    }
    S.stats.plays++; // 没命中（要么流式、要么现下）

    // ★★ v0.4.0：没有就绪的预载 → 走流式（`<audio>` 边下边播，~0.5s 出声）。
    //   旧行为是「等这一首的预载下完 + 解码」（真机实测平均 3.5s）—— 流式把这段等待抹掉。
    if (useStream()) {
      // 顺手掐掉「这一首自己的」在飞预载（已经没用了）；但**别动「下一首」那一份**
      if (S.preload && S.preload.trackId === trackId) {
        log("[preload] 这一首改走流式 → 掐掉它自己的在飞预载");
        dropPreload('这一首改走流式', { keepPreopen: true }); // ★ v1.5.3：预开的流正是给它用的
      }
      if (startStream(token, url, local)) return;
      log("[stream] ★ 流式起不来 → 退回缓冲路径");
    }

    // ★ 同一首的预载还在飞 → 等它，别重复下载同一份
    var pend = pendingPreload(trackId);
    if (pend) {
      log("[preload] 同一首的预载还在飞 → 等它（不重复下载）");
      pend.then(function (ab) {
        if (token !== S.loadToken) return;
        if (ab) onBufferReady(token, ab, "预载(等待)");
        else normalLoad(token, url, local); // 预载失败 → 老老实实自己下
      });
      return;
    }

    normalLoad(token, url, local);
  }

  /** 即时加载：下载（或读本地）→ 解码 → 就绪 */
  function normalLoad(token, url, local) {
    if (token !== S.loadToken) return;
    var p;
    if (local) {
      p = readLocal(local);
    } else if (url) {
      p = fetchBytes(url);
    } else {
      log("[load] ★ 既没有 musicurl 也没有 path，放弃");
      emitLoad(-1, "no url");
      return;
    }

    p.then(function (buf) {
      if (token !== S.loadToken) {
        log("[load] token 过期，丢弃");
        return null;
      }
      var ctx = ensureCtx();
      if (!ctx) throw new Error("没有 AudioContext");
      log("[load] 开始解码…");
      var t = performance.now();
      // ★ v1.2.0：先解析 gapless 信息（decode 会转移 buffer 所有权），解码后再按波形验裁
      var ginfo = null;
      try {
        ginfo = gaplessInfo(buf);
      } catch (e) {}
      return ctx.decodeAudioData(buf).then(function (ab) {
        log("[load] ★ 解码完成 ｜ " + (performance.now() - t).toFixed(0) + "ms");
        noteTrim(S.curTrackId, ginfo, ab); // normalLoad 没有 trackId 参数 → 用「当前曲目」
        return ab;
      });
    })
      .then(function (ab) {
        onBufferReady(token, ab, "");
      })
      .catch(function (e) {
        if (token !== S.loadToken) return;
        log("[load] ★ 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
        emitLoad(-2, String((e && e.message) || e));
      });
  }

  /* ==================== 拦截层 ==================== */

  /**
   * 兜底：万一 startup_script.js 没生效（或跑得比 UI 注册晚），
   * 在插件 onLoad 时再把注册接口包一层，把 UI 的处理器记进 registeredCalls。
   */
  function installRegistryHook() {
    try {
      if (typeof window !== "undefined" && !window.registeredCalls) window.registeredCalls = {};
    } catch (e) {}
    var reg =
      (typeof registeredCalls !== "undefined" && registeredCalls) ||
      (typeof window !== "undefined" && window.registeredCalls) ||
      null;
    if (!reg) {
      log("[reg] ★ 连 window.registeredCalls 都建不出来");
      return;
    }
    function record(key, handler) {
      if (!key || typeof handler !== "function") return;
      var arr = (reg[key] = reg[key] || []);
      if (arr.indexOf(handler) < 0) arr.push(handler);
    }
    try {
      if (typeof legacyNativeCmder !== "undefined" && legacyNativeCmder) {
        var oa = legacyNativeCmder.appendRegisterCall;
        if (typeof oa === "function" && !oa.__gpWrapped) {
          var wa = function (name, ns, handler) {
            record(String(ns) + ".on" + String(name), handler);
            return oa.apply(this, arguments);
          };
          wa.__gpWrapped = true;
          legacyNativeCmder.appendRegisterCall = wa;
          log("[reg] ✅ appendRegisterCall 已挂钩（兜底）");
        }
      }
    } catch (e) {
      log("[reg] ★ appendRegisterCall 挂钩失败 ｜ " + (e && e.message));
    }
    try {
      if (typeof channel !== "undefined" && channel) {
        var orc = channel.registerCall;
        if (typeof orc === "function" && !orc.__gpWrapped) {
          var wr = function (name, handler) {
            record(String(name), handler);
            return orc.apply(this, arguments);
          };
          wr.__gpWrapped = true;
          channel.registerCall = wr;
          log("[reg] ✅ channel.registerCall 已挂钩（兜底）");
        }
      }
    } catch (e) {
      log("[reg] ★ channel.registerCall 挂钩失败 ｜ " + (e && e.message));
    }
  }

  /** 内省：注册表里到底有没有 UI 的处理器 */
  function introspectRegistry(tag) {
    try {
      var RC =
        (typeof registeredCalls !== "undefined" && registeredCalls) ||
        (typeof window !== "undefined" && window.registeredCalls) ||
        null;
      var ks = RC ? Object.keys(RC) : [];
      // ★ v0.2.8：两行摘要合成一行（原来 3 次启动 × 2 行，纯噪音）
      log(
        "[intro] (" + tag + ") registeredCalls=" + typeof RC + " ｜ 共 " + ks.length + " 个键" +
          " ｜ triggerRegisterCall=" + typeof (legacyNativeCmder && legacyNativeCmder.triggerRegisterCall)
      );
      if (!RC) return;
      // ★ v0.2.8：逐条明细默认不写（3 次启动 × 最多 20 行）；要看就开 verbose
      var audioKs = ks.filter(function (k) {
        return /audio/i.test(k);
      });
      if (!audioKs.length) {
        logVerbose("[intro]   （没有 audio 相关的键）");
        return;
      }
      for (var i = 0; i < audioKs.length && i < 20; i++) {
        var k = audioKs[i];
        var arr = RC[k];
        logVerbose("[intro]   " + k + " → " + (arr && arr.length ? arr.length : 0) + " 个处理器");
      }
    } catch (e) {
      log("[intro] ★ 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
    }
  }

  /* ==================== v1.5.0 · 拍点分析（无变速版 Automix 的地基）==================== */

  /**
   * 目标：只用**思路**（教科书做法），自己算一首歌的「BPM + 拍点锚点 + 置信度」。
   *
   * 流程（不依赖 ML/onnx，也不需要额外下载 —— 分析的是我们**已经解码好的 AudioBuffer**）：
   *   ① 单声道 + 抽取到 ~11kHz（只为了 onset 包络，音质无所谓）
   *   ② 一阶高通压掉低频漂移 → 按 ~11.6ms 一帧取能量包络
   *   ③ 正向差分 + 去局部均值 = onset 通量（打击感越强，脉冲越明显）
   *   ④ 通量自相关在「40~220 BPM」的滞后区间里找峰 → 基频周期
   *   ⑤ 梳状评分（周期的整数倍处也该有峰）把倍/半速折回 80~180 BPM
   *   ⑥ 在周期上扫相位，拍点处通量最集中的那个相位 = 锚点
   *   ⑦ 置信度 = (最佳相位均值 - 全局均值) / (两者之和)，落在 [0,1]
   *
   * 成本控制：每次只分析 **20 秒窗口**（开头一段给 B 的入点，结尾一段给 A 的接缝），
   *   分析对象是已经躺在内存里的 buffer，只在「加载/预载就绪」时算一次并缓存。
   */

  var BEAT_DECIM_HZ = 11025; // 抽取后的标称采样率
  var BEAT_HOP_SEC = 0.0116; // 一帧 ~11.6ms
  var BEAT_WIN_SEC = 20; // 每次分析的窗口
  var BEAT_MIN_SEC = 6; // 窗口不足这么长就不算（算不准）

  function autoMixEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpAutoMix === false) return false;
    } catch (e) {}
    return true;
  }

  function beatCache() {
    return S.beatCache || (S.beatCache = {});
  }

  /**
   * 分析一段音频的拍点。
   * @param ab   AudioBuffer（要能 getChannelData）
   * @param from 秒（窗口起点）
   * @param len  秒（窗口长度）
   * @returns {bpm, beatSec, anchorSec（绝对曲目时间）, conf, frames, windowSec} 或 null
   */
  function analyzeBeats(ab, from, len) {
    if (!ab || typeof ab.getChannelData !== "function") return null;
    var sr = Number(ab.sampleRate) || 44100;
    var ch = Number(ab.numberOfChannels) || 1;
    var dur = Number(ab.duration) || 0;
    if (!(dur > 0)) return null;

    var start = Math.max(0, Math.min(dur - 1, from));
    var span = Math.min(len, dur - start);
    if (span < BEAT_MIN_SEC) return null;

    var fromSample = Math.floor(start * sr);
    var toSample = Math.min(Math.floor(ab.length), Math.floor((start + span) * sr));
    var count = toSample - fromSample;
    if (count < sr * BEAT_MIN_SEC) return null;

    // ① 单声道 + 抽取
    var step = Math.max(1, Math.round(sr / BEAT_DECIM_HZ));
    var srEff = sr / step;
    var n = Math.floor(count / step);
    var mono = new Float32Array(n);
    var data = [];
    for (var c = 0; c < ch; c++) {
      try {
        var d = ab.getChannelData(c);
        if (!d || typeof d.length !== "number") return null;
        data.push(d);
      } catch (e) {
        return null;
      }
    }
    for (var i = 0; i < n; i++) {
      var sum = 0;
      var base = fromSample + i * step;
      for (var c2 = 0; c2 < ch; c2++) sum += data[c2][base] || 0;
      mono[i] = sum / ch;
    }

    // ② 一阶高通（~200Hz，突出瞬态；不做它的话低频会把包络糊住）
    var a = Math.max(0, Math.min(0.999, 1 - (2 * Math.PI * 200) / srEff));
    var px = 0;
    var py = 0;
    for (var k = 0; k < n; k++) {
      var x = mono[k];
      var y = a * (py + x - px);
      px = x;
      py = y;
      mono[k] = y;
    }

    // ③ 能量包络 → onset 通量
    var hop = Math.max(8, Math.round(srEff * BEAT_HOP_SEC));
    var frames = Math.floor(n / hop);
    if (frames < 32) return null;
    var env = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      var off = f * hop;
      var acc = 0;
      for (var m = 0; m < hop; m++) {
        var v = mono[off + m];
        acc += v * v;
      }
      env[f] = Math.sqrt(acc / hop);
    }
    var flux = new Float32Array(frames);
    for (var f2 = 1; f2 < frames; f2++) {
      var dd = env[f2] - env[f2 - 1];
      flux[f2] = dd > 0 ? dd : 0;
    }
    // 去局部均值（窗口 ~0.6s）：避免「整体渐强」被误当成节拍
    var w = Math.max(3, Math.round(0.6 / BEAT_HOP_SEC));
    var base2 = new Float32Array(frames);
    for (var f3 = 0; f3 < frames; f3++) {
      var lo = Math.max(0, f3 - w);
      var hi = Math.min(frames - 1, f3 + w);
      var s = 0;
      for (var q = lo; q <= hi; q++) s += flux[q];
      base2[f3] = s / (hi - lo + 1);
    }
    var onset = new Float32Array(frames);
    var onsetSum = 0;
    for (var f4 = 0; f4 < frames; f4++) {
      var r = flux[f4] - base2[f4];
      onset[f4] = r > 0 ? r : 0;
      onsetSum += onset[f4];
    }
    var meanOnset = onsetSum / frames;
    if (!(meanOnset > 0)) return null;

    // ④ 自相关找周期（40~220 BPM）
    var hopSec = hop / srEff;
    var minLag = Math.max(2, Math.round(60 / 220 / hopSec));
    var maxLag = Math.min(frames - 2, Math.round(60 / 40 / hopSec));
    if (maxLag <= minLag) return null;
    var ac = new Float32Array(maxLag + 1);
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s2 = 0;
      for (var t = 0; t + lag < frames; t++) s2 += onset[t] * onset[t + lag];
      ac[lag] = s2 / (frames - lag);
    }

    // ⑤ 梳状评分：真正的基本周期，其整数倍处也应有峰（压掉倍/半速误判）
    function comb(lag) {
      var sc = 0;
      var wsum = 0;
      for (var mul = 1; mul <= 4; mul++) {
        var L = Math.round(lag * mul);
        if (L >= minLag && L <= maxLag) {
          sc += ac[L] / mul;
          wsum += 1 / mul;
        }
      }
      return wsum > 0 ? sc / wsum : 0;
    }
    var bestLag = 0;
    var bestScore = -1;
    for (var lg = minLag; lg <= maxLag; lg++) {
      var sc2 = comb(lg);
      if (sc2 > bestScore) {
        bestScore = sc2;
        bestLag = lg;
      }
    }
    if (!(bestLag > 0)) return null;

    // 折回 80~180 BPM（人耳对这段最敏感，也避免把 1/2、1/3 倍当基频）
    var bpm = 60 / (bestLag * hopSec);
    while (bpm > 180 && bestLag * 2 <= maxLag) {
      bestLag *= 2;
      bpm = 60 / (bestLag * hopSec);
    }
    while (bpm < 80 && Math.round(bestLag / 2) >= minLag) {
      bestLag = Math.round(bestLag / 2);
      bpm = 60 / (bestLag * hopSec);
    }

    // ⑥ 相位：拍点处 onset 最集中的那个相位
    var period = bestLag;
    var bestPhase = 0;
    var bestPhaseScore = -1;
    for (var ph = 0; ph < period; ph++) {
      var s3 = 0;
      var cnt = 0;
      for (var idx = ph; idx < frames; idx += period) {
        s3 += onset[idx];
        cnt++;
      }
      var avg2 = cnt ? s3 / cnt : 0;
      if (avg2 > bestPhaseScore) {
        bestPhaseScore = avg2;
        bestPhase = ph;
      }
    }

    // ⑦ 置信度：拍点均值相对全局均值的对比度
    var conf = (bestPhaseScore - meanOnset) / (bestPhaseScore + meanOnset + 1e-9);
    if (!isFinite(conf) || conf < 0) conf = 0;
    if (conf > 1) conf = 1;

    return {
      bpm: bpm,
      beatSec: 60 / bpm,
      anchorSec: start + bestPhase * hopSec, // 绝对曲目时间
      conf: conf,
      frames: frames,
      windowSec: span,
    };
  }

  /**
   * 取某首歌「靠近某个时间点」的拍点网格（带缓存）。
   * 我们只关心两个位置：**开头**（B 的入点）和**结尾**（A 的接缝），所以只算两段 20s 窗口。
   */
  function beatGridNear(trackId, ab, nearSec) {
    if (trackId === null || trackId === undefined || !ab) return null;
    var dur = Number(ab.duration) || 0;
    if (!(dur > BEAT_MIN_SEC)) return null;
    var atEnd = nearSec > dur / 2;
    var key = trackId + (atEnd ? "|tail" : "|head");
    var cache = beatCache();
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

    var from = atEnd ? Math.max(0, dur - BEAT_WIN_SEC - 2) : 0;
    var grid = null;
    try {
      grid = analyzeBeats(ab, from, Math.min(BEAT_WIN_SEC, dur - from));
    } catch (e) {
      log("[beat] ★ 分析抛错 ｜ track=" + trackId + " ｜ " + (e && e.message));
      grid = null;
    }
    if (grid && atEnd && grid.bpm > 0) {
      // 把锚点折算到「结尾附近最近的一拍」，接缝直接取用
      var beat = grid.beatSec;
      var t = Math.max(0, dur - 0.2);
      grid.endBeatSec = grid.anchorSec + Math.round((t - grid.anchorSec) / beat) * beat;
    }
    cache[key] = grid;
    if (grid) {
      log(
        "[beat] track=" + trackId + " ｜ " + (atEnd ? "尾窗" : "头窗") + " ｜ bpm=" + grid.bpm.toFixed(1) +
          " ｜ 锚点=" + grid.anchorSec.toFixed(2) + "s ｜ 置信=" + grid.conf.toFixed(2) +
          (grid.endBeatSec !== undefined ? " ｜ 末拍=" + grid.endBeatSec.toFixed(2) + "s" : "")
      );
    } else {
      log("[beat] track=" + trackId + " ｜ " + (atEnd ? "尾窗" : "头窗") + " ｜ 算不出（太短/太安静/没 buffer）");
    }
    return grid;
  }

  /** 头窗网格（B 的入点用） */
  function beatHead(trackId, ab) {
    return beatGridNear(trackId, ab, 0);
  }

  /** 尾窗网格（A 的接缝用） */
  function beatTail(trackId, ab) {
    return beatGridNear(trackId, ab, Number(ab && ab.duration) || 0);
  }

  /**
   * 由两个网格定档位。**无变速版**：档位只决定要不要做拍点对齐，不改速度。
   * 思路：把 BPM 用 0.5/1/2 倍折算到最接近 A 的那个，比偏差；
   * 偏差 >6% 说明两首拍点本来就不同步，硬对齐没意义 → 退回普通交叉。
   */
  function mixPlan(gA, gB) {
    if (!gA || !gB || !(gA.bpm > 0) || !(gB.bpm > 0)) {
      return { tier: "plain", ratio: 1, dev: 1, conf: 0 };
    }
    var best = 1;
    var bestDev = 1e9;
    var fact = [0.5, 1, 2];
    for (var i = 0; i < 3; i++) {
      var sp = gA.bpm / (gB.bpm * fact[i]);
      var dev = Math.abs(sp - 1);
      if (dev < bestDev) {
        bestDev = dev;
        best = sp;
      }
    }
    var conf = Math.min(gA.conf, gB.conf);
    var tier = "plain";
    if (conf >= 0.45 && bestDev <= 0.06) tier = "full";
    else if (conf >= 0.2 && bestDev <= 0.06) tier = "smart";
    return { tier: tier, ratio: best, dev: bestDev, conf: conf };
  }

  /** 把「曲目时间 pos」吸到最近的拍点上（偏移不超过半拍；偏移过大就不动） */
  function snapToBeat(grid, pos) {
    if (!grid || !(grid.bpm > 0)) return { pos: pos, delta: 0 };
    var beat = grid.beatSec;
    var nb = grid.anchorSec + Math.round((pos - grid.anchorSec) / beat) * beat;
    var delta = nb - pos;
    if (Math.abs(delta) > beat / 2) delta = 0;
    return { pos: pos + delta, delta: delta };
  }

  /**
   * ★ v1.5.1：给 B 选一个**入点**（都在「缓冲时间轴」上算）。
   *
   * 为什么需要：B 原来永远从 0 开始 —— 于是交叉可能落在 B 的**半拍中间**，
   * 或者落在 B 开头那段留白/空气声里（很多歌前奏就有 1~2 秒）。这一步只做决策，不动任何 DSP：
   *
   *   ① 先看 B 开头有没有**真静音**（和 trim 用的是同一个检测，阈值 -80dBFS）：
   *      有就优先跳到空白之后 —— 交叉期间听到空气声是最差的入点；
   *   ② 再找 ≥ 该点的**第一个拍点**；起点本来就贴着拍（差 ≤60ms）时，不为对齐再吃一个整拍；
   *   ③ 跳过量超过上限（6s 或 B 的一半）就放弃，老实从可听起点开始。
   *
   * @returns {offset（缓冲时间轴）, skip（跳过的秒数）, reason}
   */
  var BEAT_PICKUP_MAX = 6; // 最多跳过这么长的前奏
  var BEAT_PICKUP_TOL = 0.06; // 起点已经「贴着拍」的容差

  function pickBEntry(grid, btrim, bdur, ab, opts) {
    var start = (btrim && btrim.start) || 0;
    var len = Number(bdur) || 0;
    var silenceOnly = !!(opts && opts.silenceOnly); // ★ v1.5.2：只跳空白，不做拍点对齐
    if (!(len > 1)) {
      return { offset: start, skip: 0, reason: "时长无效" };
    }
    if (!silenceOnly && (!grid || !(grid.bpm > 0))) {
      return { offset: start, skip: 0, reason: "无拍点网格" };
    }
    var beat = grid ? grid.beatSec : 0;
    var cap = Math.min(BEAT_PICKUP_MAX, len * 0.5);

    // ① 开头的空白。⚠️ 只跳「量得完」的空白：silenceHead 扫到上限就返回上限，
    //   那种情况说明空白比上限还长 —— 硬跳会把自己扔进空白中间，宁可不跳。
    var gap = 0;
    var gapCapped = false;
    try {
      gap = silenceHead(ab, cap) || 0;
      if (gap >= cap - 0.01) {
        gap = 0;
        gapCapped = true;
      }
    } catch (e) {
      gap = 0;
    }

    // ★ v1.5.2：没有任何交叉（干净风格）时也做一件事 —— 把 B 开头的**真静音**跳掉。
    //   否则 A 播完接上来的就是 1~2 秒空气，听感上等于留了个洞（而这跟"无缝"的初衷正相反）。
    //   ⚠️ 此时**不做拍点对齐**：没有交叉就没有拍点关系，多吃一个整拍等于白吃歌。
    if (silenceOnly) {
      if (gapCapped) return { offset: start, skip: 0, reason: "开头空白比上限还长 → 不跳" };
      if (gap < 0.1) return { offset: start, skip: 0, reason: "开头没有空白" };
      // gap 已经在上面的 gapCapped 检查里保证「量得完且 ≤ cap」，这里不必再夹一次（夹了反而是死代码）
      var offS = start + gap;
      return {
        offset: offS,
        skip: offS - start,
        reason: "跳过 " + gap.toFixed(2) + "s 开头空白",
      };
    }

    var from = start + Math.max(0, gap - 0.05);

    // ② 第一个 ≥ from 的拍点；如果 from 本来就贴着上一拍，就用 from（不为对齐吃一个整拍）
    var k = Math.ceil((from - grid.anchorSec) / beat - 1e-6);
    var off = grid.anchorSec + k * beat;
    var prev = off - beat;
    var onBeat = false;
    var d = from - prev;
    if (d >= 0 && d <= BEAT_PICKUP_TOL) {
      off = Math.max(from, prev);
      onBeat = true;
    }
    if (off < start) off = start;

    // ③ 跳太多就不跳
    var skip = off - start;
    if (!(skip >= 0) || skip > cap + 1e-6) {
      return { offset: start, skip: 0, reason: "跳过 " + skip.toFixed(2) + "s 超出上限" };
    }
    var reason;
    if (skip < 0.02) reason = onBeat ? "本来就在拍上" : "起点即拍点";
    else if (gapCapped) reason = "空白比上限还长 → 只跳到第一拍";
    else if (gap >= 0.25) reason = "跳过 " + gap.toFixed(2) + "s 空白，落到第一拍";
    else reason = "对齐到第一拍";
    return { offset: off, skip: skip, reason: reason };
  }

  /* ==================== v1.3.3 · autoplay 兜底（不带启动参数也不用点播放）==================== */

  /**
   * 问题：Chromium 的 autoplay 策略让 `AudioContext` 在**首次用户手势之前**一直是 `suspended`，
   *   `resume()` 也只能挂在手势上。于是就出现「每次启动都要先点一次播放」——
   *   按 README 加 `--autoplay-policy=no-user-gesture-required` 能解决，但那是让用户改快捷方式。
   *
   * ★ JS 里**没有办法**绕过这个策略（能绕的话这策略就没意义了）。所以换个思路：
   *   起不来的时候**先让原生播放器播**（它走 C++ 音频引擎，不受网页策略限制），
   *   等用户第一次点按（点哪里都算）→ 再 `ctx.resume()` 并交回我们的引擎。
   *
   * 结果：不加任何启动参数也不用点「播放」，只是**第一首是原生播的**（那一首没有无缝/交叉），
   *   从下一首开始照旧全部由我们接管。
   *
   * 两个关键状态：
   *   S.deferNative  = 还没拿到手势 → 音频命令整条放行给原生
   *   S.nativeRunning = 原生正在响（接管的第一首 load 到了要先把原生按住，否则双声）
   */

  /** 原始 `channel.call`（绕开我们自己的拦截） */
  function rawCall(name, cb, args) {
    var fn = S.__rawCall;
    if (typeof fn !== "function") {
      log("[env] ★ 没有原始 channel.call，命令发不出去 ｜ " + name);
      return;
    }
    try {
      fn.call(channel, name, cb || function () {}, args || []);
    } catch (e) {
      log("[env] ★ rawCall(" + name + ") 失败 ｜ " + (e && e.message));
    }
  }

  /** 把原生播放器按住（避免和我们的 Web Audio 叠成双声道） */
  function pauseNative() {
    rawCall("audioplayer.pause", function () {}, ["", ""]);
    S.nativeRunning = false;
    log("[env] 已命令原生播放器暂停");
  }

  /**
   * 等第一次用户手势。
   * ★ 一旦拿到手势就把 ctx 拉起来（哪怕不是在放音频 —— 早拉起来后续切歌才不会有静默）；
   *   如果此时还在「原生死扛」阶段，就交出接管权，让下一次 `load` 由我们的引擎播。
   */
  function armTakeover() {
    if (S.__armedGesture) return;
    S.__armedGesture = true;
    var EVENTS = ["pointerdown", "mousedown", "keydown", "touchstart"];
    function onGesture() {
      for (var i = 0; i < EVENTS.length; i++) {
        try {
          window.removeEventListener(EVENTS[i], onGesture, true);
        } catch (e) {}
      }
      S.gestureSeen = true;
      try {
        if (S.ctx && S.ctx.state === "suspended") {
          var pr = S.ctx.resume();
          if (pr && pr.catch) pr.catch(function () {});
          log("[autoplay] 收到手势 → AudioContext.resume() ｜ state=" + S.ctx.state);
        }
      } catch (e) {}
      if (!S.deferNative) return;
      S.deferNative = false;
      log("[autoplay] ★ 交回 Web Audio 引擎（原生这一首继续放完，下一首起由我们接管）");
      // 提前把「当前曲目 / 下一首」预下起来，争取接管那一首就能无缝
      try {
        maybePreload();
      } catch (e) {}
    }
    for (var i = 0; i < EVENTS.length; i++) {
      try {
        window.addEventListener(EVENTS[i], onGesture, true);
      } catch (e) {}
    }
    log("[autoplay] 已挂上「第一次点按」监听（任何点击/按键都算）");
  }

  function handle(name, cb, args) {
    args = args || [];
    // ★ v1.3.3：还在「原生死扛」阶段（或原生正在响）→ 音频命令一律放行给原生。
    //   ⚠️ 这条必须在所有拦截逻辑**之前**，否则我们会把命令截下来、原生却还在放 → 双声/失控。
    //   ⚠️ `load` 要排除在外：接管的第一首就是靠它把我们拉进播放（进去之后第一件事是按住原生）。
    if (AUDIO_CMDS[name] && (S.deferNative || (S.nativeRunning && name !== "audioplayer.load"))) return false;
    // ★★ 3.x 事件契约重写：getPlayedTime / getPlaybackInfo 由**我们自己**按引擎真实状态回答。
    //   原生播放器被我们按住（暂停/未加载），对「新曲目的 playId」只会回
    //     {playedTime:0, result:false} → 客户端据此再判一次「结束」→ 跳歌 / ping-pong。
    //   实测契约（3.1.42）：
    //     请求 args[0] = { playId: "<trackId>_<sid>" }
    //     getPlayedTime  期望 → { playedAudioTime, playedTime, result }
    //     getPlaybackInfo期望 → { playId, playedTime, playedPercent, result, deviceAudioFormat, playAudioFormat, ... }
    if (!S.deferNative && !S.nativeRunning && isNcm3() &&
        (name === "audioplayer.getPlaybackInfo" || name === "audioplayer.getPlayedTime")) {
      try {
        var __q = (args && args[0]) || {};
        var __qid = typeof __q.playId === "string" ? __q.playId : "";
        var __qTrack = trackIdOf(__qid);

        var __mine = (__qTrack !== null) &&
          (__qTrack === S.loadedTrackId || __qTrack === S.curTrackId || (S.sched && S.sched.trackId === __qTrack));
        if (__mine && typeof cb === "function") {
          var __pos = Math.round(position() * 1000) || 0;
          var __dur = Math.round((S.duration || 0) * 1000) || 0;
          if (__pos < 0) __pos = 0;
          if (__dur > 0 && __pos > __dur) __pos = __dur;
          if (name === "audioplayer.getPlayedTime") {
            cb({ playedAudioTime: __pos, playedTime: __pos, result: true });
          } else {
            var __fmt = { channels: 2, samplerate: (S.ctx && S.ctx.sampleRate) || 48000, samplesize: 16 };
            cb({
              cacheStrategyCode: "", cdnUsed: false, deviceAudioFormat: __fmt,
              hasNetworkJanks: false, hasSeekJanks: false, hasSystemJanks: false,
              p2pUsed: false, playAudioFormat: __fmt, playId: __qid,
              playedPercent: __dur > 0 ? Math.min(100, (__pos / __dur) * 100) : 0,
              playedTime: __pos, preloadWholeCached: false, result: true
            });
          }

          return true; // 不交给原生（避免 result:false 触发客户端二次结束判定）
        }

      } catch (e) { log("[guard] 契约重写异常 ｜ " + (e && e.message)); }
    }
    // ★ v0.4.0：逃生开关 —— `window.__gpNativeAll = true` 时把播放整条交回原生。
    //   放行 = 返回 false → installInterceptor 里 `below.apply(...)` 交给原生。
    if (AUDIO_CMDS[name] && passAllToNative()) {
      if (name === "audioplayer.load") stopSource();
      return false;
    }
    switch (name) {
      case "audioplayer.load":
        log("[cmd] ▶ load ｜ audioId=" + args[0]);
        // ★ v1.3.3：接管的第一首 —— 原生还在放它，不按住就会和我们叠成双声道
        if (S.nativeRunning) pauseNative();
        introspectRegistry("收到 load");
        loadSong(args[0], args[1]);
        return true; // 照 LFP：不回调

      case "audioplayer.play":
        S.audioId = [args[0], args[1]]; // ★ 第 2 个是 token（onPlayState 要用它）
        log("[cmd] ▶ play ｜ id=" + args[0] + " ｜ token=" + args[1]);
        if (S.autoPlayTimer) {
          clearTimeout(S.autoPlayTimer);
          S.autoPlayTimer = 0;
        }
        doPlay();
        if (typeof cb === "function") cb();
        return true;

      case "audioplayer.pause":
        log("[cmd] ▶ pause");
        doPause();
        if (typeof cb === "function") cb();
        return true;

      // ★ v0.4.1：UI 切歌单时会发它（args=[上一个 audioId]）。我们只借它撤销预约，
      //   **仍照旧放行给原生**（return false → 交给 below）。
      case "audioplayer.stop":
        log("[cmd] ▶ stop ｜ args=" + JSON.stringify(args));
        if (S.sched) cancelSched("UI stop");
        return false;

      case "audioplayer.seek":
        log("[cmd] ▶ seek ｜ args=" + JSON.stringify(args));
        doSeek(args[2]);
        if (typeof cb === "function") cb();
        return true;

      case "audioplayer.setVolume":
        log("[cmd] ▶ setVolume ｜ args=" + JSON.stringify(args));
        doSetVolume(args[2]);
        if (typeof cb === "function") cb(true);
        return true;

      // ---- A1：旁听播放列表 / 当前曲目（只观察，照常放行给原生） ----
      case "player.addListElement": {
        if (S.sched) cancelSched("切歌单"); // ★ v0.4.1：换歌单 → 预约作废
        // ★★ 真机实测（v0.2.0 踩坑）：这个 payload 是**一个 JSON 字符串**，不是数组！
        //    直接当数组用 → `songs.length` 变成「字符串长度」（6659）→
        //    playlistIndex() 遍历的是一串字符 → 索引永远 -1 → 预载永远不触发。
        //    （看日志能认出：trace 里是 `args=[[{...}]]` 双括号，且长度等于字符数。）
        var songs = args[0];
        if (typeof songs === "string") {
          try {
            songs = JSON.parse(songs);
          } catch (e) {
            songs = null;
          }
        }
        if (songs && songs.length) {
          S.playlist = songs;
          var firstId = trackIdOf(songs[0] && songs[0].id);
          var keep = S.preload ? playlistHas(S.preload.trackId) : false;
          log(
            "[list] 播放列表更新 ｜ " + songs.length + " 首 ｜ 当前索引=" + playlistIndex() +
              " ｜ 首曲=" + firstId +
              (S.preload ? " ｜ 预载中的 " + S.preload.trackId + " 在本列表=" + (keep ? "是" : "否") : "")
          );
          // ★ v0.2.4：预载槽里那首不在新歌单里 → 作废。
          //   真机踩过：开机记忆是「上一份歌单」的歌，切歌单后它还在下，白下 22MB。
          if (S.preload && !keep && S.preload.trackId !== S.curTrackId) {
            var dead = S.preload.trackId;
            dropPreload("不在新歌单"); // ★ v0.2.5：真的 abort 掉在飞的下载，不只是丢结果（预开也一并清掉）
            log("[mem] 预载的 " + dead + " 不在新歌单里 → 作废（已掐断下载）");
          }
          maybePreload();
        } else {
          log("[list] ★ 列表读不出来 ｜ args[0] 的类型=" + typeof args[0]);
        }
        return false;
      }

      case "player.setCurrentPlay": {
        var tid = trackIdOf(args[0]);
        if (tid !== null) {
          // ★ 3.x：客户端自己推进了 → 撤掉「补发 onEnd」的兜底计时器
          if (S.__endTimer) { clearTimeout(S.__endTimer); S.__endTimer = 0; }
          S.__advancedAt = Date.now();
          S.__endFallbackGen = (S.__endFallbackGen || 0) + 1;
          // ★ 3.x 抢时间：setCurrentPlay 比 audioplayer.load 早 ~80~110ms，
          //   现在就把地址解析好 → load 一到就能直接用，省掉「加密 token 先失败再重试」那一圈
          //   （随机播放没有预载可命中，这几百毫秒就是全部收益）。
          if (isNcm3()) {
            try {
              var __tid = tid;
              var __slot = { trackId: __tid, url: null, promise: null };
              __slot.promise = resolveUrl320(__tid).then(function (u) {
                if (u) __slot.url = u;
                return u;
              }).catch(function () { return null; });
              S.proactiveUrl = __slot;
            } catch (e) {}
          }
          // ★ v0.2.10：修掉「索引 / 下一首 是上一首的」这个会误导排查的日志 bug —— 显式传 tid。
          //   （`S.curTrackId = tid` 在这行之后才执行，v0.2.7 起就是这样。）
          var nx = nextTrack(tid);
          log("[list] 当前曲目 track=" + tid + " ｜ 索引=" + playlistIndex(tid) + " ｜ 下一首=" + (nx ? trackIdOf(nx.id) : "(无)"));

          // ★ v0.2.6 / v0.2.7：窗口内网易云恢复的那首 → 整段忽略。
          if (S.bootWindow && (S.bootRestoreTrackId === null || tid === S.bootRestoreTrackId)) {
            if (S.bootRestoreTrackId === null) {
              S.bootRestoreTrackId = tid;
              log(
                "[mem] ★ 开机恢复（网易云自己挑的，不是用户选的）｜ track=" + tid +
                  " → 窗口保持：记忆 / 当前曲目 / 预载槽都不动"
              );
            } else {
              log("[mem] ★ 仍是开机恢复那串（track=" + tid + "）→ 不动");
            }
            // ★★ 刻意**不更新 S.curTrackId**：否则 `player.addListElement` 分支里的
            //    maybePreload() 会拿它去预载，把「记忆那首」的下载掐断（真机踩过 97MB）。
            return false;
          }

          if (S.bootWindow) {
            // 用户主动切到**别的**歌 → 关窗，恢复正常记账
            S.bootWindow = false;
            log(
              "[mem] 用户切到别的歌（track=" + tid + " ≠ 开机恢复 " + S.bootRestoreTrackId +
                "）→ 开机保护窗口关闭"
            );
          }
          // ★ v0.2.10：结算上一次「预载下一首」押没押中。
          //   ⚠️ 必须赶在 maybePreload() **之前** —— 它会 startPreload(当前曲目)
          //   把这个预测槽换掉，换掉之后就再也看不出押没押中了。
          notePrediction(tid);
          // ★ v0.4.1：无缝预约的三种情形
          if (S.sched) {
            if (S.sched.trackId === tid) {
              if (S.sched.phase === "armed") {
                // UI 要**正常加载**这一首了 → 撤掉预约（否则正常 load 的 B + armed 的 B 双声）
                cancelSched("UI 切到预约曲");
              }
              // phase === "live"：什么都不做 —— 等 load 来认领（B 已经在响）
            } else {
              // 押错：预约的是别的 → 撤销（live 时还要停掉已经响起来的 B）
              abortSeamless("押错（预约 " + S.sched.trackId + "，实际 " + tid + "）");
            }
          }
          // ★ v0.2.10：免费的「顺序播放」信号（连续几首在列表里索引相邻）。
          notePlayOrder(tid);
          S.curTrackId = tid;
          // ★ v0.2.3：选中就记一笔。比等 `audioplayer.load` 更早，也更贴近
          //   「下次开机会继续听的那首」——就算用户只是选中没播，也能记住。
          saveLastTrack(tid, "选中");
          maybePreload();
        }
        return false;
      }

      default:
        return false;
    }
  }

  /* ---------- 命令追踪：搞清楚网易云到底发了什么 ---------- */

  /**
   * 之前只记「认识的」那几条命令，结果是：如果网易云压根不发 audioplayer.pause，
   * 日志会一片安静 —— 又回到「看不出是没发还是没接住」的死胡同。
   * 现在每个**首次出现**的命令名都记一笔，音频相关的每次都记。
   */
  var seenCmds = {};
  var cmdKindCount = 0;

  function safeArgs(a) {
    try {
      if (!a) return "(无)";
      var out = [];
      for (var i = 0; i < a.length; i++) {
        var v = a[i];
        if (v === null) out.push("null");
        else if (typeof v === "object") out.push("{...}");
        else {
          var s = String(v);
          // 有些 payload 是超长 JSON 字符串（如 player.addListElement 的列表），
          // 整条刷进日志没意义还刷屏 —— 截断，但把真实长度写出来（排查时有用）。
          if (s.length > 200) s = s.slice(0, 200) + "…(共 " + s.length + " 字符)";
          out.push(s);
        }
      }
      return "[" + out.join(", ") + "]";
    } catch (e) {
      return "(读不到)";
    }
  }

  function traceCommand(name, args) {
    var n = String(name);
    var isNew = !seenCmds[n];
    if (isNew) {
      seenCmds[n] = 0;
      if (cmdKindCount < 200) {
        cmdKindCount++;
        // ★ v0.2.8：这条开机一次就 80+ 行，默认不写（要看新命令名就开 verbose）
        logVerbose("[call] 首次出现命令：" + n);
      }
    }
    seenCmds[n]++;
    // ★ v0.2.8：只逐次记「跟播放有关」的那几条。
    //   原来那个宽正则（/player|audio|play|pause|seek|vol/i）会把 player.setInfo /
    //   player.setCover / player.setMiniPlayerState 这类 **UI 设置调用**也刷进来（真机 20+ 行）。
    if (/^audioplayer\.|^player\.(setCurrentPlay|addListElement)$/.test(n)) {
      log("[call] ▶ " + n + " ｜ 第 " + seenCmds[n] + " 次 ｜ args=" + safeArgs(args));
    }
  }

  function installInterceptor() {
    if (typeof channel === "undefined" || !channel) {
      log("[guard] ★ channel 不存在，拦截装不上");
      return;
    }
    var below = channel.call;
    var wrapped = function (name, callback, args) {
      try {
        traceCommand(name, args);
      } catch (e) {}
      // ★ v1.3.2：automix 探针（默认关；只记录不干预，见 probeWrap 的注释）
      try {
        callback = probeWrap(name, callback, args);
      } catch (e) {}
      try {
        if (handle(name, callback, args)) return;
      } catch (e) {
        log("[guard] ★ handle(" + name + ") 抛错 ｜ " + (e && e.name) + ": " + (e && e.message));
      }
      // ★ 支持「包装回调」：handle 里把替换后的回调放进 S.__cbSwap，这里才能真正交给原生。
      var __cb = callback;
      try {
        if (S && S.__cbSwap) { __cb = S.__cbSwap; S.__cbSwap = null; }
      } catch (e) {}
      return below.call(this, name, __cb, args);
    };
    try {
      Object.defineProperty(channel, "call", {
        configurable: true,
        get: function () {
          return wrapped;
        },
        set: function () {
          log("[guard] 有人想改写 channel.call，已拦下");
        },
      });
      log("[guard] ✅ channel.call 已锁定（defineProperty）");

    } catch (e) {
      channel.call = wrapped;
      log("[guard] defineProperty 不可用，改用普通赋值 ｜ " + (e && e.message));
    }
  }

  /* ==================== v1.3.2 · automix 探针（只记录，不干预）==================== */

  /**
   * 为什么要有它（静态分析给的结论）：
   *   本机客户端（3.1.42.205594）的渲染层里有一整套 automix **决策库**：
   *   `AutomixEffectConfig0922`（AB 实验）＋ `mix_strategy` / `crossfade_start_time` /
   *   `eq_type` / `tempo_values` / `mix_params` 的计划骨架，策略有
   *   rhythm/vocal/atmosphere/accompaniment/silence/crossfade/custom。
   *
   *   但：① 原生模块（cloudmusic.dll / neaudio*.dll / audioeffects.dll）里
   *   `mix_params` / `crossfade_start_time` / `r_s-line` / `strategy_rhythm` **全部 0 命中**；
   *   ② 除它自己那个 bundle 之外，**没有任何 chunk 引用它**；
   *   ③ 分析数据（bpm/repBpm/beat_array）没有任何抓取点。
   *   → 这一版的决策层是「悬空的」：算得出计划，但没人给它喂数据、也没人消费。
   *
   * 所以先放一个探针盯着（等客户端把它接上/AB 命中，第一时间就能发现）：
   *   ① `abtest.getList` 有没有真的下发 `AutomixEffectConfig0922`；
   *   ② `audioplayer.*` 的**参数键名**有没有多出计划字段；
   *   ③ 有没有出现没见过的命令名（例如 `audioplayer.setMixPlan`）。
   *
   * 开关：`window.__gpProbe = true`（默认关，零成本；同一形状只记一次，不会刷屏）
   */
  function probeOn() {
    try {
      return !!(typeof window !== "undefined" && window && window.__gpProbe);
    } catch (e) {
      return false;
    }
  }

  /** 把一个参数树压成「键名 + 类型」的形状描述（最多两层，够看出计划字段） */
  function probeShape(v, depth) {
    if (v === null) return "null";
    var t = typeof v;
    if (t === "string") return "str(" + v.length + ")";
    if (t !== "object") return t + "(" + String(v).slice(0, 24) + ")";
    var isArr = Object.prototype.toString.call(v) === "[object Array]";
    if (depth >= 2) return isArr ? "array" : "object";
    var keys = [];
    try {
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k);
      }
    } catch (e) {}
    if (!keys.length) return isArr ? "array[0]" : "{}";
    var out = [];
    for (var i = 0; i < keys.length && i < 20; i++) {
      var sv;
      try {
        sv = probeShape(v[keys[i]], depth + 1);
      } catch (e) {
        sv = "?";
      }
      out.push(keys[i] + ":" + sv);
    }
    return (isArr ? "[" : "{") + out.join(",") + (keys.length > 20 ? ",…" : "") + (isArr ? "]" : "}");
  }

  /** 包一层回调/记录参数形状。返回原回调（或包装后的）——不改变任何行为 */
  function probeWrap(name, cb, args) {
    if (!probeOn()) return cb;
    try {
      var shape = probeShape(args, 0);
      var st = S.probeSeen || (S.probeSeen = {});
      var isNew = !Object.prototype.hasOwnProperty.call(st, name);
      if (isNew || st[name] !== shape) {
        st[name] = shape;
        // ★ 命令名放最前面、变化标记放中间：这样 `[probe] <命令> ｜` 可以稳定地数次数
        log(
          "[probe] " + name + " ｜ " + (isNew ? "首次" : "★ 形状变了") + " ｜ " + String(shape).slice(0, 800)
        );
      }
    } catch (e) {}
    // 回应只抓「和过渡 / AB 有关」的命令，避免把每个调用的返回值都刷进日志
    if (typeof cb !== "function" || !/abtest\.|mix|effect|strategy|automix/i.test(name)) return cb;
    return function () {
      try {
        var out;
        try {
          out = JSON.stringify(arguments[0]);
        } catch (e) {
          out = String(arguments[0]);
        }
        log("[probe] " + name + " ← " + String(out).slice(0, 900));
      } catch (e) {}
      return cb.apply(this, arguments);
    };
  }

  /* ==================== v1.4.0 · 状态行 + 设置面板 ==================== */

  function sizeText(bytes) {
    if (!bytes) return "0 MB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function recentBytes() {
    var t = 0;
    var list = S.recentBufs || [];
    for (var i = 0; i < list.length; i++) t += list[i].bytes || 0;
    return t;
  }

  /**
   * 一行状态。回答用户最容易困惑的三件事：
   *   ① 现在是原生在放还是插件在放（第一首没无缝时最需要）；
   *   ② 过渡到底生效没有、为什么是这个值（显式 / 风格 / 智能默认）；
   *   ③ 缓存吃了多少内存、预载命中率如何。
   */
  function statusLine() {
    var xf = effectiveXfade();
    var eng;
    if (S.deferNative) eng = "原生播（等首次点按）";
    else if (!S.ctx) eng = "未建 AudioContext";
    else eng = "Web Audio" + (S.ctx.state === "running" ? "" : "（" + S.ctx.state + "）");

    var trans =
      xf.sec > 0
        ? xf.sec.toFixed(1) + "s · " + xf.curve + (xf.eq ? " + 扫频" : "") + " · " + xf.source
        : "关 · " + xf.source;

    var plays = S.stats.plays || 0;
    var hit = (S.stats.hitPreload || 0) + (S.stats.hitRecent || 0);
    var hitText = plays ? Math.round((hit / plays) * 100) + "%（" + hit + "/" + plays + "）" : "—";

    // ★ v1.5.2：把「拍点对齐」的默认状态摆出来（默认就是开的，别让人以为是关的）
    var beatText = "关";
    if (autoMixEnabled()) {
      var bn = 0;
      var bc = S.beatCache || {};
      for (var bk in bc) {
        if (Object.prototype.hasOwnProperty.call(bc, bk)) bn++;
      }
      beatText = "开（已分析 " + bn + " 段）";
    }

    return (
      "引擎=" + eng + " ｜ 过渡=" + trans + " ｜ 拍点=" + beatText + " ｜ 缓存=" +
      (S.recentBufs || []).length + " 首/" + sizeText(recentBytes()) + " ｜ 预载命中=" + hitText
    );
  }

  /** 清掉两级缓存（面板上的按钮 + 控制台 API 都用它） */
  function clearCaches() {
    var n = (S.recentBufs || []).length;
    S.recentBufs = [];
    for (var k in BYTES_CACHE) {
      if (Object.prototype.hasOwnProperty.call(BYTES_CACHE, k)) delete BYTES_CACHE[k];
    }
    log("[ui] 已清空缓存（缓冲 " + n + " 首 + 字节缓存）");
    return n;
  }

  /** 切换过渡风格（面板按钮 / 控制台 `gaplessPlayer.setStyle("dj")` 都走这里） */
  function applyStyle(name) {
    if (!STYLE_PRESETS[name]) return false;
    saveStyle(name);
    log("[ui] 过渡风格 → " + name + "（" + STYLE_PRESETS[name].label + "，" + effectiveXfade().sec + "s）");
    refreshPanel();
    return true;
  }

  /* ---- 面板（自绘 DOM + 一次性注入样式；不依赖客户端 CSS，也不引外部文件） ---- */

  var panel = { box: null, btn: null, css: null, timer: 0 };

  var PANEL_CSS = [
    ".gp-card{position:fixed;right:16px;bottom:64px;z-index:2147483000;width:312px;box-sizing:border-box;",
    "background:rgba(28,30,36,.96);color:#e8eaf0;border:1px solid rgba(255,255,255,.08);border-radius:14px;",
    "padding:14px 14px 10px;font:12px/1.55 -apple-system,'Segoe UI',system-ui,sans-serif;",
    "box-shadow:0 18px 48px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.04);",
    "backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}",
    ".gp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}",
    ".gp-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;letter-spacing:.2px}",
    ".gp-ver{font-size:10px;font-weight:500;color:#8b93a7;background:rgba(255,255,255,.06);",
    "border:1px solid rgba(255,255,255,.07);border-radius:999px;padding:1px 7px}",
    ".gp-x{all:unset;cursor:pointer;width:22px;height:22px;line-height:20px;text-align:center;border-radius:7px;",
    "color:#8b93a7;font-size:16px;transition:background .15s,color .15s}",
    ".gp-x:hover{background:rgba(255,255,255,.09);color:#fff}",
    ".gp-status{display:block;color:#98a0b4;background:rgba(255,255,255,.04);border-radius:10px;",
    "padding:8px 10px;margin-bottom:12px;font-size:11px;line-height:1.7;word-break:break-all}",
    ".gp-sec{margin-bottom:12px}",
    ".gp-cap{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#7d8598;margin:0 0 7px 2px}",
    ".gp-seg{display:flex;background:rgba(255,255,255,.05);border-radius:10px;padding:3px;gap:3px}",
    ".gp-seg>button{all:unset;flex:1;text-align:center;cursor:pointer;padding:6px 0;border-radius:8px;",
    "font-size:12px;color:#a8b0c2;transition:background .15s,color .15s,box-shadow .15s}",
    ".gp-seg>button:hover{color:#fff;background:rgba(255,255,255,.06)}",
    ".gp-seg>button.on{background:#3d6ef5;color:#fff;box-shadow:0 2px 10px rgba(61,110,245,.4)}",
    ".gp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 2px}",
    ".gp-row>span:first-child{color:#c6cbd8}",
    ".gp-val{color:#8b93a7;font-variant-numeric:tabular-nums}",
    ".gp-range{width:100%;height:22px;margin:2px 0 6px;-webkit-appearance:none;background:transparent}",
    ".gp-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(255,255,255,.13)}",
    ".gp-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;",
    "border-radius:50%;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.5);transition:transform .12s}",
    ".gp-range:active::-webkit-slider-thumb{transform:scale(1.15)}",
    ".gp-sel{all:unset;cursor:pointer;color:#e8eaf0;background:rgba(255,255,255,.07);border-radius:8px;",
    "padding:5px 9px;font-size:12px}",
    ".gp-sw{position:relative;display:inline-block;width:34px;height:20px;border-radius:999px;cursor:pointer;",
    "background:rgba(255,255,255,.14);transition:background .18s}",
    ".gp-sw>i{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;",
    "transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.4)}",
    ".gp-sw.on{background:#3d6ef5}",
    ".gp-sw.on>i{transform:translateX(14px)}",
    ".gp-btn{all:unset;cursor:pointer;color:#c6cbd8;background:rgba(255,255,255,.07);border-radius:8px;",
    "padding:5px 10px;font-size:12px;transition:background .15s,color .15s}",
    ".gp-btn:hover{background:rgba(255,255,255,.13);color:#fff}",
    ".gp-diag{margin-top:4px;border-top:1px solid rgba(255,255,255,.07);padding-top:8px}",
    ".gp-diag>summary{cursor:pointer;color:#7d8598;font-size:11px;letter-spacing:.4px;list-style:none}",
    ".gp-diag>summary::-webkit-details-marker{display:none}",
    ".gp-foot{display:flex;justify-content:space-between;align-items:center;color:#6f7689;",
    "font-size:10px;margin-top:8px}",
    ".gp-fab{position:fixed;right:14px;bottom:16px;width:30px;height:30px;border-radius:12px;",
    "z-index:2147482999;display:flex;align-items:center;justify-content:center;cursor:pointer;",
    "color:#a8b0c2;font-size:15px;background:rgba(32,34,42,.72);border:1px solid rgba(255,255,255,.1);",
    "opacity:.5;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);",
    "transition:opacity .18s,transform .18s,border-color .18s,background .18s}",
    ".gp-fab:hover{opacity:1;transform:translateY(-1px);border-color:rgba(255,255,255,.22)}",
    ".gp-fab.on{opacity:1;color:#fff;background:#3d6ef5;border-color:#3d6ef5}",
  ].join("");

  function ensurePanelCss() {
    if (panel.css) return;
    try {
      if (typeof document === "undefined" || !document || !document.head) return;
      var st = document.createElement("style");
      st.setAttribute("data-gaplessplayer", "style");
      st.textContent = PANEL_CSS;
      document.head.appendChild(st);
      panel.css = st;
    } catch (e) {}
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function rowEl(label, right) {
    var r = el("div", "gp-row");
    r.appendChild(el("span", null, label));
    if (typeof right === "string") r.appendChild(el("span", "gp-val", right));
    else if (right) r.appendChild(right);
    return r;
  }

  /** 拨动开关（比默认 checkbox 好看，也统一了各处交互） */
  function toggleEl(initial, onChange) {
    var sw = el("span", "gp-sw");
    sw.appendChild(el("i"));
    sw.__on = !!initial;
    if (sw.__on) sw.className = "gp-sw on";
    sw.onclick = function () {
      sw.__on = !sw.__on;
      sw.className = "gp-sw" + (sw.__on ? " on" : "");
      try {
        onChange(sw.__on);
      } catch (e) {}
      refreshPanel();
    };
    return sw;
  }

  function refreshPanel() {
    if (!panel.box) return;
    try {
      if (panel.status) panel.status.textContent = statusLine();
      var styleNow = xfadeStyle();
      var autoNow = styleFromMode();
      for (var i = 0; i < (panel.styleBtns || []).length; i++) {
        var b = panel.styleBtns[i];
        var on = styleNow === null ? b.__style === autoNow : b.__style === styleNow;
        b.className = on ? "on" : "";
      }
      var xf = effectiveXfade();
      if (panel.range) {
        panel.range.value = String(xf.sec);
        if (panel.rangeLabel) {
          panel.rangeLabel.textContent = xf.sec > 0 ? xf.sec.toFixed(1) + "s" : "关";
        }
      }
      if (panel.curve) panel.curve.value = xf.curve;
      if (panel.eqSw) panel.eqSw.className = "gp-sw" + (xf.eq ? " on" : "");
      if (panel.cacheText) {
        panel.cacheText.textContent = (S.recentBufs || []).length + " 首 · " + sizeText(recentBytes());
      }
    } catch (e) {}
  }

  function closePanel() {
    try {
      if (panel.box && panel.box.parentNode) panel.box.parentNode.removeChild(panel.box);
    } catch (e) {}
    panel.box = null;
    if (panel.btn) panel.btn.className = "gp-fab";
  }

  function openPanel() {
    try {
      if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return false;
      if (panel.box) {
        closePanel();
        return true;
      }
      ensurePanelCss();
      var box = el("div", "gp-card");
      box.setAttribute("data-gaplessplayer", "panel");

      /* ---- 标题 ---- */
      var head = el("div", "gp-head");
      var brand = el("div", "gp-brand");
      brand.appendChild(el("span", null, "GaplessPlayer"));
      brand.appendChild(el("span", "gp-ver", VERSION));
      head.appendChild(brand);
      var x = el("button", "gp-x", "×");
      x.onclick = function () {
        closePanel();
      };
      head.appendChild(x);
      box.appendChild(head);

      /* ---- 状态 ---- */
      panel.status = el("div", "gp-status", statusLine());
      box.appendChild(panel.status);

      /* ---- 过渡风格 ---- */
      var sec1 = el("div", "gp-sec");
      sec1.appendChild(el("div", "gp-cap", "过渡风格"));
      var seg = el("div", "gp-seg");
      panel.styleBtns = [];
      ["clean", "light", "dj"].forEach(function (k) {
        var b = el("button", null, STYLE_PRESETS[k].label);
        b.__style = k;
        b.onclick = function () {
          applyStyle(k);
        };
        panel.styleBtns.push(b);
        seg.appendChild(b);
      });
      sec1.appendChild(seg);

      var r1 = rowEl("交叉时长", "");
      panel.rangeLabel = r1.lastChild;
      sec1.appendChild(r1);
      var range = el("input", "gp-range");
      range.type = "range";
      range.min = "0";
      range.max = "12";
      range.step = "0.5";
      range.oninput = function () {
        saveXfade(Number(range.value));
        refreshPanel();
      };
      panel.range = range;
      sec1.appendChild(range);

      var sel = el("select", "gp-sel");
      ["equal", "linear", "s-line", "r_s-line", "exp", "step"].forEach(function (c) {
        var o = el("option", null, c);
        o.value = c;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        try {
          window.__gpXfadeCurve = sel.value;
        } catch (e) {}
        refreshPanel();
      };
      panel.curve = sel;
      sec1.appendChild(rowEl("曲线", sel));

      panel.eqSw = toggleEl(
        effectiveXfade().eq,
        function (v) {
          try {
            window.__gpXfadeEq = !!v;
          } catch (e) {}
        }
      );
      sec1.appendChild(rowEl("高通扫频", panel.eqSw));
      box.appendChild(sec1);

      /* ---- 行为 ---- */
      var sec2 = el("div", "gp-sec");
      sec2.appendChild(el("div", "gp-cap", "播放行为"));
      sec2.appendChild(
        rowEl(
          "拍点对齐",
          toggleEl(autoMixEnabled(), function (v) {
            try {
              window.__gpAutoMix = !!v;
            } catch (e) {}
            log("[ui] 拍点对齐 → " + (v ? "开" : "关"));
          })
        )
      );
      sec2.appendChild(
        rowEl(
          "流式补缓冲",
          toggleEl(promoteEnabled(), function (v) {
            try {
              window.__gpPromote = !!v;
            } catch (e) {}
          })
        )
      );
      sec2.appendChild(
        rowEl(
          "裁作品静音",
          toggleEl(trimPadEnabled(), function (v) {
            try {
              window.__gpTrimPad = !!v;
            } catch (e) {}
          })
        )
      );
      box.appendChild(sec2);

      /* ---- 缓存 ---- */
      var sec3 = el("div", "gp-sec");
      sec3.appendChild(el("div", "gp-cap", "缓存"));
      panel.cacheText = el("span", "gp-val", (S.recentBufs || []).length + " 首 · " + sizeText(recentBytes()));
      var clearBtn = el("button", "gp-btn", "清空");
      clearBtn.onclick = function () {
        clearCaches();
        refreshPanel();
      };
      sec3.appendChild(rowEl("最近缓冲", panel.cacheText));
      var r3 = el("div", "gp-row");
      r3.appendChild(el("span", null, "字节缓存"));
      r3.appendChild(clearBtn);
      sec3.appendChild(r3);
      box.appendChild(sec3);

      /* ---- 诊断（折叠） ---- */
      var diag = el("details", "gp-diag");
      diag.appendChild(el("summary", null, "诊断"));
      [
        ["强制缓冲路径", "__gpStream"],
        ["关掉预约", "__gpSeamless"],
        ["整条交回原生", "__gpNativeAll"],
        ["automix 探针", "__gpProbe"],
      ].forEach(function (it) {
        diag.appendChild(
          rowEl(
            it[0],
            toggleEl(false, function (v) {
              try {
                window[it[1]] = v ? true : undefined;
              } catch (e) {}
            })
          )
        );
      });
      var logBtn = el("button", "gp-btn", "复制日志路径");
      logBtn.onclick = function () {
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(LOG);
        } catch (e) {}
      };
      var foot = el("div", "gp-foot");
      foot.appendChild(el("span", null, "日志：" + LOG));
      diag.appendChild(foot);
      diag.appendChild(logBtn);
      box.appendChild(diag);

      document.body.appendChild(box);
      panel.box = box;
      if (panel.btn) panel.btn.className = "gp-fab on";

      if (!panel.timer) {
        panel.timer = setInterval(function () {
          if (!panel.box) return;
          try {
            if (panel.status) panel.status.textContent = statusLine();
            if (panel.cacheText) {
              panel.cacheText.textContent =
                (S.recentBufs || []).length + " 首 · " + sizeText(recentBytes());
            }
          } catch (e) {}
        }, 1000);
      }
      refreshPanel();
      return true;
    } catch (e) {
      log("[ui] ★ 打不开面板 ｜ " + (e && e.name) + ": " + (e && e.message));
      return false;
    }
  }

  /** 右下角一颗小圆钮（很淡，hover 才明显）；`window.__gpHideButton = true` 可隐藏 */
  function initPanel() {
    try {
      if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
      if (window.__gpHideButton) return;
      if (panel.btn) return;
      ensurePanelCss();
      var b = el("div", "gp-fab", "♪");
      b.title = "GaplessPlayer 设置";
      b.onclick = function () {
        openPanel();
      };
      document.body.appendChild(b);
      panel.btn = b;
      log("[ui] 设置面板按钮已注入（右下角「♪」；window.__gpHideButton = true 可隐藏）");
    } catch (e) {
      log("[ui] ★ 注入按钮失败 ｜ " + (e && e.message));
    }
  }

  /* ==================== 启动 ==================== */

  plugin.onLoad(function () {
    log("=== GaplessPlayer v" + VERSION + " (缓冲 + 流式 + 首尾裁剪" + (xfadeSeconds() > 0 ? " + 交叉淡入淡出" : "") + ") 启动 ===");
    loadXfade(); // ★ v1.3.0：读回上次设的交叉时长
    loadStyle(); // ★ v1.4.0：读回上次选的过渡风格（没选过 → 智能默认）
    try {
      log(
        "[xfade] 交叉淡入淡出=" + (xfadeSeconds() > 0 ? xfadeSeconds().toFixed(1) + "s（曲线=" + xfadeCurveName() +
          (xfadeEqEnabled() ? "+扫频" : "") + "）" : "关") +
          " ｜ window.__gpXfade = 3 开启（0~12s，会记住）｜ __gpXfadeCurve / __gpXfadeEq 可调曲线与扫频"
      );
      log("[status] " + statusLine());
    } catch (e) {}
    try {
      log("[env] origin=" + location.origin + " ｜ AudioContext=" + typeof AudioContext + " ｜ legacyNativeCmder=" + typeof legacyNativeCmder);
      log("[env] betterncm.isMRBNCM(前)=" + String(betterncm.isMRBNCM));
    } catch (e) {}

    // ★ 预载能力探测：LibEAPIRequest 在不在、请求函数能不能用、域名拿不拿得到。
    //   这三样决定了「预载」这条腿能不能站住；缺一样就安静退回即时加载。
    try {
      var lib = (typeof loadedPlugins !== "undefined" && loadedPlugins && loadedPlugins.LibEAPIRequest) || null;
      var ok = !!(lib && typeof lib.eapiRequest === "function");
      var avail = ok && typeof lib.isRequestAvailable === "function" ? lib.isRequestAvailable() : null;
      var dom = (typeof APP_CONF !== "undefined" && APP_CONF && APP_CONF.domain) || null;
      log(
        "[preload] 能力探测 ｜ LibEAPIRequest=" + (ok ? "有" : "无") + " ｜ 请求函数可用=" + String(avail) +
          " ｜ domain=" + (dom || "(拿不到)")
      );
    } catch (e) {
      log("[preload] 能力探测失败 ｜ " + (e && e.message));
    }

    // ★ A1.5：开机就把「上次播放的那首」预下起来（真机时序上能抢到 ~1.7s 提前量）。
    //   猜错了不要紧 —— 一旦 setCurrentPlay 给出真曲目，预载槽会被 token 机制换掉。
    //   记忆存在 C:\betterncm\gapless-player.lasttrack.json（文件），localStorage 只是备份。
    try {
      log("[mem] 记忆文件 = " + MEM_FILE);
      bootFromMemory();
    } catch (e) {
      log("[mem] ★ 开机预载启动失败 ｜ " + (e && e.message));
    }


    // ★ 越早越好：先把「UI 事件处理器注册表」的兜底钩子装上
    installRegistryHook();
    introspectRegistry("插件 onLoad");

    // 音量沿用网易云自己的设置
    try {
      var cfg = JSON.parse(localStorage.getItem("NM_SETTING_PLAYER") || "{}");
      if (typeof cfg.volume === "number") S.volume = cfg.volume;
      log("[env] 初始音量 = " + S.volume);
    } catch (e) {}

    // 把原生播放器按住（照 LFP 的做法），否则会和我们的 Web Audio 叠成双声道。
    // ★ v1.3.3：改成「先看 AudioContext 能不能起」——起不来就先让原生播（见下）。
    try {
      S.__rawCall = channel.call; // 原始通道（pauseNative / rawCall 用，绕开自己的拦截）
    } catch (e) {}

    ensureCtx();
    var ctxBlocked = !!(S.ctx && S.ctx.state === "suspended");
    armTakeover();
    if (ctxBlocked) {
      S.deferNative = true;
      S.nativeRunning = true;
      log(
        "[autoplay] ★ AudioContext 起不来（state=suspended）→ 先让**原生**播放器播；" +
          "第一次点按（点哪里都算）后交回 Web Audio。本次启动的第一首没有无缝/交叉。"
      );
    } else {
      pauseNative();
    }

    installInterceptor();
    initPanel(); // ★ v1.4.0：右下角「G」→ 设置面板（没有 document 时自动跳过）
    try {
      // ★ v1.4.0：给用户一个可脚本化的入口（控制台一行就能改）
      window.gaplessPlayer = {
        version: VERSION,
        status: statusLine,
        xfade: effectiveXfade, // 现在是 {sec, curve, eq, source}，方便脚本/排查
        // ★ v1.5.0：拍点相关的调试入口（面板/测试/排查都用它）
        beat: function (ab, from, len) {
          return analyzeBeats(ab, from, len);
        },
        mixPlan: mixPlan,
        pickup: pickBEntry, // ★ v1.5.1：给 B 选入点
        preopen: preopenStream, // ★ v1.5.3：诊断用（也会走「元素在用就不动」的守卫）
        snapToBeat: snapToBeat,
        lastPlan: function () {
          return S.lastPlan;
        },
        setStyle: applyStyle,
        setXfade: saveXfade,
        clearCache: clearCaches,
        openPanel: openPanel,
      };
    } catch (e) {}

    // 启动 3 秒后看一眼 UI 的处理器注册表（那时 UI 已经起来了）
    setTimeout(function () {
      introspectRegistry("启动+3s");
    }, 3000);

    // 进度心跳：每 100ms 伪造一次 onPlayProgress
    setInterval(function () {
      if (!S.ready) return;
      // ★ v0.4.1：每 100ms 看一眼该不该「提前把下一首排到结束采样上」（真无缝）
      maybeScheduleSeamless();
      // ★ v1.3.1：流式那首听够一会儿就后台补成缓冲（切回来秒开，也能当交叉的 B）
      maybePromoteStream();
      // ★ v0.4.1：live 窗口（A 已播完、B 已在响、UI 还没 load）→ **抑制进度**：
      //   此刻 S.audioId 还是 A 的，但 position() 已经是 B 的（从 0 起）→ 发出去会让进度条闪。
      if (S.sched && S.sched.phase === "live") return;
      emitProgress();
    }, TICK_MS);

    // 状态心跳：每 10s 打一行，方便排查「UI 静悄悄崩了」+ 看记忆有没有在更新
    setInterval(function () {
      var pl = S.preload ? S.preload.trackId + "/" + S.preload.status : "无";
      log(
        "[hb] ready=" + S.ready + " ｜ paused=" + S.paused + " ｜ pos=" + position().toFixed(1) + "s / " + S.duration.toFixed(1) + "s ｜ ctx=" + (S.ctx ? S.ctx.state : "无") + " ｜ vol=" + S.volume +
          " ｜ 记忆=" + (S.lastTrack === null ? "无" : S.lastTrack) + " ｜ 预载=" + pl +
          // ★ v0.4.0：把「这一首走的是哪条路径」打出来 —— 排查「切歌怎么还是慢」时一眼就看得出
          " ｜ 播法=" + (S.stream ? "流式" : "缓冲") + (S.silentSuspect ? "（已判静音）" : "")
      );
      // ★ v0.2.7：窗口内如果真的一直在播（≥10s），说明用户确实在听这首 → 关窗并记账。
      //   （网易云那串恢复是毫秒级的，能连续播 10 秒只可能是人在听。）
      if (
        S.bootWindow && S.ready && !S.paused && S.bootPlayStart &&
        performance.now() - S.bootPlayStart >= 10000
      ) {
        S.bootWindow = false;
        log("[mem] 窗口内已连续播放 ≥10s → 判定用户真的在听这首 → 开机保护窗口关闭并记账");
        saveLastTrack(S.curTrackId, "播放中");
      }
      // ★ v0.2.9：不再有「播放中周期落盘」—— 只记歌不记位置，歌名在「选中 / 加载」时就记过了。
    }, 10000);

    // ★ v0.4.0 静音自检（每 1s 一次，几乎零成本）：
    //   跨域音频一旦被 taint，`MediaElementSource` 会输出**纯静音** —— 元素在走（currentTime 在涨），
    //   但 FFT 全 0。判据：**流式 + 在播 + currentTime 在涨 + 连续 ~2s FFT 全 0**。
    //   命中 → 记 `silentSuspect`，后续曲目自动退回缓冲路径（缓冲路径还在，天然是退路）。
    //   ⚠️ 已经进了 Web Audio 的元素**摘不出来**，所以自愈只能「下一首生效」。
    setInterval(function () {
      if (!S.stream || !S.ready || S.paused || !S.el || !S.analyser) {
        S.silentTick = 0;
        return;
      }
      var t = Number(S.el.currentTime) || 0;
      var moved = S.lastSilentT !== undefined && t - S.lastSilentT > 0.3;
      S.lastSilentT = t;
      if (!moved) return; // 还没开始走 → 不算
      var sum = 0;
      try {
        var buf = new Uint8Array(S.analyser.frequencyBinCount);
        S.analyser.getByteFrequencyData(buf);
        for (var i = 0; i < buf.length; i++) sum += buf[i];
      } catch (e) {
        S.silentTick = 0;
        return;
      }
      if (sum > 0) {
        S.silentTick = 0;
        return;
      }
      S.silentTick++;
      if (S.silentTick >= 2 && !S.silentSuspect) {
        S.silentSuspect = true;
        log("[stream] ★★★ 疑似被跨域静音（taint）：元素在走但 FFT 连续全 0 → 后续曲目自动退回缓冲路径");
        log("[stream] ★★★ 如果此刻确实没声音：控制台敲 window.__gpStream = false 立即全部退回缓冲");
      }
    }, 1000);

    log("[boot] 就绪 —— 请随便播一首歌");
  });
})();
