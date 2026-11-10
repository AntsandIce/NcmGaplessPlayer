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

  var VERSION = "1.20.0";
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
    xfadeSmart: false, // ★ v1.14.0：智能交叉（时长按小节、曲线按档位）
    lastMix: null, // ★ v1.13.0：最近一次真实过渡 {fadeSec, beats, tier, aBpm, bBpm, earlyCut, stretchRatio, curve}
    style: null, // ★ v1.4.0：用户选的过渡风格（clean/light/dj）；null = 智能默认
    beatCache: {}, // ★ v1.5.0：trackId|head/tail → 拍点网格
    lastPlan: null, // ★ v1.5.0：最近一次 automix 判定（排查用）
    preopenUrl: null, // ★ v1.5.3：为 B 提前预开的 <audio> 地址（切歌时复用）
    preopenTrackId: null, // ★ v1.5.3：预开的是哪一首（3.x 的 musicurl 是加密 token，只能比 id）
    stats: { plays: 0, hitPreload: 0, hitRecent: 0 }, // ★ v1.4.0：状态行用
    srcGain: null, // 当前缓冲 source 自己的增益（淡出用；不动总线 S.gain）
    srcFilter: null, // ★ v1.3.2：同一路的「高通」（交叉时做扫频淡出，平时 20Hz = 直通）
    srcNorm: null, // ★ v1.9.0：这一路的响度归一化节点（曲线之外的那一级）
    mediaGain: null, // 流式元素那一路的增益（同上）
    mediaFilter: null, // ★ v1.3.2：流式元素那一路的高通
    mediaNorm: null, // ★ v1.9.0：流式那一路的响度归一化节点
    /* ---- v1.3.3：autoplay 兜底 ---- */
    deferNative: false, // 还没拿到用户手势 → 音频命令整条放行给原生
    nativeRunning: false, // 原生正在响（接管那一首要先把原生按住）
    nativePosMs: 0, // ★ v1.7.2（#2）：原生报上来的播放位置（毫秒）
    nativePosAt: 0, // ★ v1.7.2：上面那个位置是什么时候采到的（performance.now）
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
    // ★ v1.8.6：上一次「用户手选/点下一首」的时刻（客户端手选前会先发 audioplayer.stop）。
    //   用来区分「顺序播放/随机播放的自然推进」和「用户自己跳的」—— 见 notePrediction。
    //   ⚠️ 初值必须是 **-1** 而不是 0：验证台的假时钟从 0 起，0 会被 `if (x)` 当成「从没收到过」。
    lastUserStopAt: -1,

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
  /* ---- ★ v1.6.0：元素池（双元素流水线）----
   *
   * 之前只有一个 `<audio>`：它在给当前这首用时，下一首就**没法预热**（动它就断音）。
   * 现在按需扩到 2 个槽：A 在槽 0 出声，B 在槽 1 静静缓冲；真切歌时把「出声槽」切过去。
   *
   * ★ 每个 `<audio>` 只能 `createMediaElementSource()` 一次 → 每个槽建一次、长期复用。
   * ★ 槽的 gain 走自己的链路（gain → highpass → 总线），所以「切槽」就是一次淡入淡出。
   */
  var elPool = []; // [{ el, src, gain, filter, preopenTrackId }]
  var elActive = 0;

  function slotAt(i) {
    return elPool[i] || null;
  }

  function activeSlot() {
    return elPool[elActive] || null;
  }

  /** 把「当前出声」的槽绑定到 S.el / S.mediaSrc / S.mediaGain / S.mediaFilter */
  function bindActive(i, trackId) {
    var s = slotAt(i);
    if (!s) return null;
    // ★ v1.8.3：**必须**把这一槽的增益/高通复位 ——
    //   它可能刚在上一轮交叉里被淡到 0（出声音那个槽），如果不复位，
    //   这一首就会「从头到尾声音极小」。这正是「最后几秒声音被拉得极低」的一种成因。
    try {
      restoreGain(s.gain, 1);
      restoreEq(s.filter);
    } catch (e) {}
    // ★ v1.9.0：这一槽的「响度归一化」按要播的那一首设（默认当前曲目）
    try {
      setNorm(s.norm, trackId === undefined ? S.curTrackId : trackId, null, "流式");
    } catch (e) {}
    elActive = i;
    S.el = s.el;
    S.mediaSrc = s.src;
    S.mediaGain = s.gain;
    S.mediaFilter = s.filter;
    S.mediaNorm = s.norm || null;
    return s;
  }

  /** 建一个槽（失败返回 null，调用方负责退化） */
  function makeSlot(i) {
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
    var src = null;
    try {
      El.preload = "auto";
      El.volume = 1; // 音量统一由 S.gain 控，别两处都调
      src = S.ctx.createMediaElementSource(El);
    } catch (e) {
      log("[stream] ★ createMediaElementSource 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
      return null;
    }
    var g = null;
    var f = null;
    var nrm = null;
    try {
      g = S.ctx.createGain();
      f = S.ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = EQ_BASE_HZ;
      // ★ v1.9.0：曲线增益之后串响度归一化（每个槽一份，按曲目设）
      try {
        nrm = S.ctx.createGain();
      } catch (e4) {
        nrm = null;
      }
      src.connect(g);
      g.connect(f);
      if (nrm) {
        f.connect(nrm);
        nrm.connect(S.gain); // src → gain → filter → norm → 总线 → analyser → destination
      } else {
        f.connect(S.gain); // src → gain → filter → 总线 → analyser → destination
      }
    } catch (e) {
      log("[stream] ★ 流式的 gain/高通建不起来 → 直连总线（交叉时没有淡出）｜ " + (e && e.message));
      g = null;
      f = null;
      nrm = null;
      try {
        src.connect(S.gain);
      } catch (e2) {}
    }
    var slot = { el: El, src: src, gain: g, filter: f, norm: nrm, preopenTrackId: null };
    El.addEventListener("durationchange", function () {
      var a = activeSlot();
      if (S.stream && a && a.el === El && isFinite(El.duration) && El.duration > 0) S.duration = El.duration;
    });
    log("[stream] <audio> 已建好（槽#" + i + "）");
    return slot;
  }

  function ensureEl() {
    if (elPool.length) {
      if (S.el) return S.el;
      bindActive(elActive < elPool.length ? elActive : 0);
      return S.el;
    }
    var s = makeSlot(0);
    if (!s) {
      S.el = null;
      S.mediaSrc = null;
      S.mediaGain = null;
      S.mediaFilter = null;
      return null;
    }
    elPool.push(s);
    bindActive(0);
    return S.el;
  }

  /** 把池子扩到至少 n 个槽（第二个槽只在要预开时才建） */
  function ensureSlotCount(n) {
    if (!S.ctx) return elPool.length;
    while (elPool.length < n) {
      var wasEmpty = elPool.length === 0;
      var s = makeSlot(elPool.length);
      if (!s) break;
      elPool.push(s);
      // 第一个槽永远当「出声槽」占位（即使当前这首走缓冲），这样后续判断「空闲槽」才稳
      if (wasEmpty) bindActive(0);
    }
    return elPool.length;
  }

  /** 上一首挂的流式事件清理函数（换歌时先摘掉，天然防「旧歌事件串到新歌」） */
  var detachStream = null;

  /**
   * 给这一首挂流式事件。**每首歌重新挂、换歌先摘** —— 这是最可靠的 token 守卫：
   * 元素的 `loadedmetadata` / `ended` / `error` 本身**不告诉你**是哪一次 load 的，
   * 只有让闭包捕获 token，才能判断「这条事件是不是已经过期」。
   */
  function attachStreamEvents(token, adoptSlot) {
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
    if (adoptSlot >= 0 && el && Number(el.readyState) >= 1) {
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
    // ★ v1.6.0：这一首已经在别的槽里预热过 → 直接把它变成出声槽（不重设 src，省掉 canplay 等待）
    var prevEl = S.el;
    var adoptSlot = findPreopenSlot(S.curTrackId);
    if (adoptSlot >= 0) {
      log("[stream] ★ 采用预开的槽 #" + adoptSlot + "（这一首已经缓冲过了）");
      bindActive(adoptSlot);
    }
    var el = ensureEl();
    if (!el) return false;
    // ★ v1.6.0：接手新槽之前先把「上一个出声槽」停掉（否则会双声）
    if (prevEl && prevEl !== el) {
      try {
        prevEl.pause();
        log("[stream] 上一个槽已暂停（避免双声）");
      } catch (e) {}
    }
    S.stream = true;
    S.trim = null; // ★ v1.2.0：流式 =<audio>的原始时间轴，没法做首尾裁剪（也没有采样级控制）
    S.elToken = token;
    attachStreamEvents(token, adoptSlot);
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
      if (adoptSlot >= 0) {
        log("[stream] ★ 复用提前预开的 <audio>（不重设 src）");
        slotAt(adoptSlot).preopenTrackId = null; // 接管完成，交回正常流程
        return true;
      }
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
   * ★ v1.9.4：**「过渡风格」整套撤掉** —— 现在只有一种默认行为：**干净**（0s，采样级无缝）。
   *
   * 交叉淡入淡出保留成一个**开关**（面板上「交叉淡入淡出」，默认关）。
   * 打开后默认 3s 等功率；老开关仍然有效并且优先级最高：
   *   `window.__gpXfade = 秒数`（0 = 关）｜ `__gpXfadeCurve`｜`__gpXfadeEq`
   *
   * 为什么撤掉风格：那三个预设（干净/轻过渡/DJ）把「曲线 + 扫频 + 时长」打成一包，
   * 用户选完不知道自己在改什么，出问题也没法定位；现在只留一个开关 + 一个时长，
   * 其余全部走默认值（等功率、不扫频）。
   */
  var XFADE_ON_SEC_DEFAULT = 3;
  /**
   * ★ v1.14.0：**智能交叉** —— 打开开关后不再固定 3 秒 / 固定等功率：
   *   - 时长：按 A 的 BPM 取整小节（full = 2 小节、smart = 1 小节），夹在 2~10s；
   *   - 曲线：full → r_s-line（DJ 端部更陡）、smart → s-line、plain → equal（最中性）；
   *   - 显式设过秒数/曲线（`setXfade(6)` / `__gpXfadeCurve`）永远优先。
   * `XFADE_ON_SEC_DEFAULT` 只作为「没有拍点可依」时的兜底秒数。
   */
  var XFADE_SMART_KEY = "gaplessPlayer.xfadeSmart";
  var XFADE_SMART_BEATS_FULL = 8; // 2 小节（4/4）
  var XFADE_SMART_BEATS_SMART = 4; // 1 小节
  var XFADE_SMART_MIN = 2;
  var XFADE_SMART_MAX = 10;

  function xfadeSmart() {
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpXfadeSmart === "boolean") {
        return window.__gpXfadeSmart;
      }
    } catch (e) {}
    return !!S.xfadeSmart;
  }

  function saveXfadeSmart(v) {
    try {
      S.xfadeSmart = !!v;
      localStorage.setItem(XFADE_SMART_KEY, S.xfadeSmart ? "1" : "0");
    } catch (e) {}
  }

  function loadXfadeSmart() {
    try {
      var raw = localStorage.getItem(XFADE_SMART_KEY);
      if (raw !== null) S.xfadeSmart = raw === "1";
    } catch (e) {}
  }

  /**
   * 智能时长：按 A 的 BPM 取整小节。full → 2 小节、smart → 1 小节；
   * plain / 没网格 / 置信太低 → 0（调用方退回秒数）。
   */
  function smartFadeSec(grid, tier) {
    if (!grid || !(grid.bpm > 0) || !(grid.conf >= 0.3)) return 0;
    var beats = tier === "full" ? XFADE_SMART_BEATS_FULL : tier === "smart" ? XFADE_SMART_BEATS_SMART : 0;
    if (!beats) return 0;
    var beat = 60 / grid.bpm;
    if (!(beat > 0.05) || beat > 2) return 0; // BPM 离谱（<30 或 >1200）
    var sec = beats * beat;
    if (sec < XFADE_SMART_MIN) sec = XFADE_SMART_MIN;
    if (sec > XFADE_SMART_MAX) sec = XFADE_SMART_MAX;
    return Math.round(sec * 100) / 100;
  }

  /** 智能曲线：full 用 DJ 的端部更陡；smart 用平滑 S；plain 用最中性的等功率 */
  function smartCurveFor(tier) {
    if (tier === "full") return "r_s-line";
    if (tier === "smart") return "s-line";
    return "equal";
  }

  /**
   * 合成最终的 {sec, curve, eq, smart, source}。默认 **干净（0s）**，只有动过开关才不是 0。
   * `source` 只用于日志与面板显示。
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

    var sec = explicitSec === null ? 0 : Number(explicitSec);
    if (!isFinite(sec) || sec <= 0) sec = 0;
    else if (sec > XFADE_MAX) sec = XFADE_MAX;
    else if (sec < 0.5) sec = 0;

    var curve = "equal";
    var curveExplicit = false;
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpXfadeCurve === "string") {
        curve = String(window.__gpXfadeCurve).toLowerCase();
        curveExplicit = true;
      }
    } catch (e) {}

    // ★ v1.20.0：扫频默认开（`__gpXfadeEq === false` 才关）
    var eq = true;
    try {
      if (typeof window !== "undefined" && window && window.__gpXfadeEq === false) eq = false;
    } catch (e) {}

    var smart = sec > 0 && xfadeSmart();
    return {
      sec: sec,
      curve: curve,
      curveExplicit: curveExplicit,
      eq: eq && sec > 0,
      smart: smart,
      source: sec > 0 ? (smart ? "smart" : "on") : "clean",
    };
  }

  /** ★ v1.9.4：面板上的「交叉淡入淡出」开关（默认关 = 干净） */
  function xfadeOn() {
    return effectiveXfade().sec > 0;
  }

  /**
   * ★ v1.14.0：开关语义变了 —— `setXfade(true)` = **智能**（按小节，3s 兜底）；
   * `setXfade(true, 6)` / `setXfade(6)` = 显式 6s；`setXfade(false)` / `setXfade(0)` = 关。
   */
  function setXfadeSwitch(on, sec) {
    var explicitSec = typeof on === "number" ? Number(on) : Number(sec) > 0 ? Number(sec) : 0;
    var isOn = typeof on === "number" ? Number(on) > 0 : !!on;
    var smart = isOn && !(explicitSec > 0);
    if (explicitSec > 0) rememberXfadeSec(explicitSec);
    // ★ v1.20.0 修：智能模式的**兜底**固定用 3.0，不跟着「上次固定值」跑。
    //   否则固定里调过 1.9，切回智能后兜底也变 1.9（看起来像"智能=1.9s"，其实是错的）。
    //   上次固定值只在「智能 → 固定」时用来恢复（rememberXfadeSec）。
    var s = isOn ? (explicitSec > 0 ? explicitSec : XFADE_ON_SEC_DEFAULT) : 0;
    if (!isFinite(s) || s < 0) s = 0;
    if (s < 0.5) {
      s = 0;
      smart = false;
    }
    try {
      window.__gpXfade = s;
      window.__gpXfadeSmart = smart;
    } catch (e) {}
    saveXfade(s);
    saveXfadeSmart(smart);
    log(
      "[ui] 交叉淡入淡出 → " +
        (s > 0 ? (smart ? "智能（按小节，兜底 " + s.toFixed(1) + "s）" : s.toFixed(1) + "s") : "关（干净无缝）")
    );
    return s;
  }

  /** 当前生效的交叉曲线名（显式 > 智能档位 > equal） */
  function xfadeCurveName(tier) {
    var e = effectiveXfade();
    if (e.curveExplicit) return e.curve;
    if (e.smart) return smartCurveFor(tier || "plain");
    return e.curve;
  }

  /**
   * ★ v1.15.0：曲线选择（面板「曲线」按钮点一下循环）。
   * `auto` = 按档位智能；其余 = 显式 `__gpXfadeCurve`。
   */
  var CURVE_CYCLE = ["auto", "equal", "s-line", "r_s-line", "linear", "exp", "step"];

  function currentCurveChoice() {
    var e = effectiveXfade();
    return e.curveExplicit ? e.curve : "auto";
  }

  function cycleCurve() {
    var cur = currentCurveChoice();
    var i = CURVE_CYCLE.indexOf(cur);
    if (i < 0) i = 0;
    var next = CURVE_CYCLE[(i + 1) % CURVE_CYCLE.length];
    try {
      if (next === "auto") delete window.__gpXfadeCurve;
      else window.__gpXfadeCurve = next;
    } catch (e) {}
    log("[ui] 曲线 → " + (next === "auto" ? "自动（按档位）" : next));
    refreshPanel();
    return next;
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
  function crossfadeCurve(rising, name) {
    var nm = name || xfadeCurveName();
    var a = new Float32Array(XFADE_POINTS);
    for (var i = 0; i < XFADE_POINTS; i++) {
      var x = i / (XFADE_POINTS - 1);
      a[i] = curveShape(nm, rising ? x : 1 - x);
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

  /* ★ v1.20.0：记住「上一次的固定秒数」—— 智能 ↔ 固定 来回切时不再跳回 3.0 */
  var XFADE_LAST_KEY = "gaplessPlayer.xfadeLastSec";

  function rememberXfadeSec(v) {
    var n = Number(v);
    if (!(n > 0) || !isFinite(n)) return;
    S.lastXfadeSec = Math.min(n, XFADE_MAX);
    try {
      localStorage.setItem(XFADE_LAST_KEY, String(S.lastXfadeSec));
    } catch (e) {}
  }

  function lastXfadeSec() {
    var n = Number(S.lastXfadeSec);
    if (n > 0) return n;
    try {
      n = Number(localStorage.getItem(XFADE_LAST_KEY));
    } catch (e) {
      n = 0;
    }
    if (n > 0 && isFinite(n)) return Math.min(n, XFADE_MAX);
    return 0;
  }

  function loadXfade() {
    try {
      var raw = localStorage.getItem(XFADE_KEY);
      if (raw === null) return;
      var v = Number(raw);
      S.xfadeExplicit = true;
      if (isFinite(v) && v > 0) {
        S.xfade = Math.min(v, XFADE_MAX);
        rememberXfadeSec(S.xfade);
      }
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

  /** ★ v1.15.0：不带「交叉是否开着」的原始开关（面板显示用） */
  function xfadeEqRaw() {
    try {
      if (typeof window !== "undefined" && window && window.__gpXfadeEq === false) return false;
    } catch (e) {}
    return true; // ★ v1.20.0：默认开
  }

  function newSourceChain() {
    var g = null;
    var f = null;
    var n = null;
    try {
      g = S.ctx.createGain();
      f = S.ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = EQ_BASE_HZ;
      try {
        f.Q.value = 0.707;
      } catch (e) {}
      // ★ v1.9.0：曲线增益之后串一个**固定**的响度归一化节点（交叉曲线代码一行都不用改）
      try {
        n = S.ctx.createGain();
      } catch (e3) {
        n = null;
      }
      g.connect(f);
      if (n) {
        f.connect(n);
        n.connect(S.gain);
      } else {
        f.connect(S.gain);
      }
    } catch (e) {
      log("[xfade] ★ 建 gain/filter 失败 ｜ " + (e && e.message));
      // 退化成老链路：直接接总线
      try {
        if (g) g.connect(S.gain);
      } catch (e2) {}
      return { gain: g, filter: null, norm: null };
    }
    return { gain: g, filter: f, norm: n };
  }

  /** 从 t0 起用 xf 秒把 param 走一条曲线（rising=true 淡入 / false 淡出）
   *  ★ v1.14.0：`name` 可选 —— 调度时把「这次档位决定的曲线」传进来 */
  function scheduleFade(param, t0, xf, rising, name) {
    if (!param || !(xf > 0)) return false;
    try {
      param.cancelScheduledValues(0); // ⚠️ 不清掉旧的，setValueCurveAtTime 会因「区间内有事件」抛错
      param.setValueCurveAtTime(crossfadeCurve(rising, name), t0, xf);
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
    // ★ v1.9.0：这一首的响度归一化（曲线之外的那一级）
    try {
      S.srcNorm = chain.norm || null;
      setNorm(chain.norm, S.curTrackId, S.buffer, "缓冲");
    } catch (e) {}
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
      // ★ v1.7.1（#3）：流式 B —— 元素已经在响（gain 曲线已经走完），直接把它变成出声槽
      if (sc.streamSlot !== undefined && sc.streamSlot !== null && sc.streamSlot >= 0) {
        log(
          "[end] ★ 自然播完 → 流式交叉交接 ｜ A=" + S.curTrackId + " → B=" + sc.trackId +
            " ｜ 交叉=" + (sc.xfade || 0).toFixed(2) + "s（B 是流式，靠元素交叉）"
        );
        playClockStop();
        stopSource(); // 此刻 S.source / S.el 还是 A → 只停 A
        bindActive(sc.streamSlot, sc.trackId); // ★ v1.9.0：按 B 自己的响度归一
        S.stream = true;
        S.buffer = null;
        S.source = null;
        S.trim = null;
        S.srcGain = null;
        S.srcFilter = null;
        S.duration = Number(S.el && S.el.duration) || 0;
        S.startCtxTime = sc.startCtxTime;
        S.startOffset = 0;
        S.pausedAt = 0;
        S.paused = false;
        sc.phase = "live";
        emitEnd();
        playClockStart();
        return;
      }
      // ★ v0.4.1 无缝交接：A 播完 → B 已经在响（start 排在了 A 的结束采样上）→ 0 间隙。
      //   ★ 顺序是命门：`stopSource()` 必须在「提升 B」**之前**（此刻 S.source 仍是 A → 只停 A）。
      //   反过来写（先提升 B 再 stopSource）就会**把正在响的 B 停掉**。
      // ★ v1.8.0（#17）：流式那首的结束时刻是「duration - currentTime」推出来的；
      //   媒体时钟与 AudioContext 时钟若真有漂移，这里会量化出来（正常应 ≈0）。
      var __driftMs = (sc.endCtxTime - S.ctx.currentTime) * 1000;
      if (Math.abs(__driftMs) > 150) {
        log("[sched] ★ 结束时刻与预测差 " + __driftMs.toFixed(0) + "ms（媒体时钟/时长估算）→ 已按实际交接");
      }
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
              // ★ v1.9.0：2.10 这条路同一个响应里也有 gain/peak
              try {
                noteTrackGain(trackId, d.gain, d.peak);
              } catch (e) {}
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

  /* ---- ★ v1.7.2（#2）：原生这一首的「接管」 ---- */

  /** 原生此刻大概播到哪（秒）。原生是 1× 播放，所以按「采样时刻 + 经过时间」外推。 */
  function nativePosEstimate() {
    try {
      if (!isFinite(S.nativePosMs) || !S.nativePosAt) return null;
      var now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      var age = (now - S.nativePosAt) / 1000;
      if (!(age >= 0) || age > 3) return null; // 太久没刷新 → 不可信
      return S.nativePosMs / 1000 + age;
    } catch (e) {
      return null;
    }
  }

  /**
   * ★ v1.7.2（结构性限制 #2）：把**原生正在播的这一首**接过来。
   *
   * 为什么要接：首曲由原生播放（autoplay 策略）时，它的尾巴不归我们 ——
   * 于是「首曲 → 第二首」只能硬切（等客户端 load，真机 80~190ms）。
   * 一旦我们在点按后把当前这首接管过来，它的尾巴就归我们，第二首就能正常交叉/接拍。
   *
   * 安全边界（任何一条不满足就老实留给原生，绝不影响正在播的歌）：
   *   - 必须已经拿到手势（AudioContext 能跑）；
   *   - 原生确实在响，而我们自己还没出声；
   *   - 当前这首**已经解码**（recentGet 命中）；
   *   - 原生位置可用且不离谱（避开开头 0.5s 和结尾 2s）；
   *   - 起播比原生早 60ms，然后立刻按住原生 → 同曲同位置短暂重叠，不留空档。
   */
  function tryTakeoverCurrent(why) {
    try {
      if (S.deferNative) return false; // 还没手势
      if (!S.nativeRunning) return false; // 原生不在响 / 已经接管过
      if (!S.ctx || S.ctx.state === "suspended") return false;
      if (S.source || (S.stream && S.el && !S.el.paused)) return false; // 我们自己已经在出声
      var cur = S.curTrackId;
      if (cur === null || cur === undefined) return false;
      var ab = recentGet(cur) || peekPreloadBuffer(cur); // 预载槽里也可能就是它
      if (!ab) {
        logVerbose("[takeover] 当前这首（" + cur + "）还没解码完 → 这一首仍由原生放");
        return false;
      }
      var pos = nativePosEstimate();
      if (pos === null) {
        logVerbose("[takeover] 没有可用的原生位置（客户端还没报过）→ 这一首仍由原生放");
        return false;
      }
      var tr = trimOf(cur);
      var dur = Math.max(0.02, ab.duration - tr.start - tr.end);
      if (pos < 0.5 || pos > dur - 2) {
        log("[takeover] 位置不合适（" + pos.toFixed(2) + "s / " + dur.toFixed(2) + "s）→ 这一首仍由原生放");
        return false;
      }
      S.buffer = ab;
      S.duration = dur;
      S.trim = tr;
      S.audioId = [S.audioId[0] || String(cur), S.audioId[1] || ""];
      S.paused = false;
      S.pausedAt = 0;
      S.lastEmitPos = -1;
      playClockStop();
      S.playedMs = pos * 1000; // 接上原生已经播过的部分（进度条不跳）
      var lead = 0.06;
      var when = S.ctx.currentTime + 0.03;
      startSource(pos + lead, when);
      S.loadedTrackId = cur;
      pauseNative(); // 按住原生（它内部会把 nativeRunning 置 false）
      playClockStart();
      emitProgress(true);
      log(
        "[takeover] ★ 接管当前这首（" + (why || "?") + "）｜ track=" + cur + " ｜ 原生位置≈" +
          pos.toFixed(2) + "s ｜ 下一首起就能交叉/接拍了"
      );
      return true;
    } catch (e) {
      log("[takeover] ★ 接管失败（继续用原生放）｜ " + (e && e.message));
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
    // ★ v1.7.2（#2）：当前这首若已经解码、而原生还在响 → 接手它（幂等，不满足条件就什么都不做）
    tryTakeoverCurrent("预载就绪");
    // ③ ★ v1.6.1（B）：顺手把「下下一首」的**字节**抓下来（不解码，几乎不占内存）
    //    —— 等它真的成为下一首时，startPreload 会命中字节缓存，省掉取址 + 下载那一段。
    maybePrefetchN2();
  }

  /**
   * ★ v1.6.1（B）：第二预载槽 —— 只抓字节，不解码。
   *
   * 为什么只抓字节：解一首要 60~90MB 内存，两首都解会撑爆；而压缩字节只有 7~10MB，
   * 并且 `startPreload` 本来就有「字节缓存命中 → 跳过取址 + 下载」这条路，
   * 所以只要提前把字节放进 `BYTES_CACHE`，这条捷径就自然生效了。
   *
   * 只在「顺序可预测」时做：随机模式下押下一首都押不中，押下下一首纯属白下。
   */
  function maybePrefetchN2() {
    try {
      if (S.preloadNextOff) return;
      // ★ v1.8.0（#16）：只受总开关管 —— 字节缓存关掉时，预热字节会存进内存里的单首槽
      if (!cacheEnabled()) return;
      if (S.loadedTrackId !== S.curTrackId) return; // 当前还没就绪 → 先顾当前
      var list = S.playlist || [];
      var idx = playlistIndex(S.curTrackId);
      if (idx < 0 || idx + 2 >= list.length) return; // 没有「下下一首」
      var id2 = trackIdOf(list[idx + 2] && list[idx + 2].id);
      if (id2 === null || id2 === S.curTrackId) return;
      if (hasPreload(id2)) return; // 已经整首预载了，不用再抓字节
      if (hasCachedBytes(id2)) return; // 字节已经在手里
      if (S.prefetch && S.prefetch.trackId === id2 && S.prefetch.status !== "failed") return;

      if (S.prefetch && S.prefetch.abort) {
        try {
          S.prefetch.abort.abort(); // 换目标前把上一次在飞的抓取掐断
        } catch (e) {}
      }
      var ac = null;
      try {
        if (typeof AbortController === "function") ac = new AbortController();
      } catch (e) {
        ac = null;
      }
      var slot = { trackId: id2, status: "pending", abort: ac };
      S.prefetch = slot;
      var t0 = performance.now();
      log("[prefetch] 提前抓「下下一首」的字节（不解码）｜ track=" + id2);
      // ★ v1.8.4：进闸门（优先级 1）。它没人等 —— 让「预载下一首」先走。
      downloadGate(1, "抓 N+2 的字节", ac ? ac.signal : null, function (sig) {
        // ★ v1.8.4：盘上已经有这一首 → 别再下一遍（重启之后这一条直接省掉 6MB）。
        //   ⚠️ 这里只查**已经读进内存的索引**（同步、不会卡住闸门）；
        //     索引还没读起来就当没有 —— 顶多多下一份，不能让 N+2 把预载堵在闸门里。
        if (diskHas(id2)) {
          slot.status = "disk";
          log("[prefetch] ★ 盘上已有，不用抓 ｜ track=" + id2 + " ｜ " + (performance.now() - t0).toFixed(0) + "ms");
          return null;
        }
        return resolveUrl(id2)
          .catch(function (e) {
            if (!isNcm3()) throw e;
            return resolveUrl320(id2);
          })
          .then(function (u) {
            if (!u) throw new Error("没拿到地址");
            return fetchBytes(u, sig);
          });
      })
        .then(function (buf) {
          if (!buf) return;
          cachePutBytes(id2, buf);
          slot.status = "bytes";
          log(
            "[prefetch] ★ 字节已备好（N+2）｜ track=" + id2 + " ｜ " + mb(buf.byteLength) + " MB ｜ " +
              (performance.now() - t0).toFixed(0) + "ms"
          );
        })
        .catch(function (e) {
          if (e && e.name === "AbortError") {
            log("[prefetch] 已掐断（换目标/作废）｜ track=" + id2);
            // ★ v1.8.4：槽位一起清掉，否则这道「已经在抓了」的闸门会把 N+2 永久锁死
            if (S.prefetch === slot) S.prefetch = null;
            return;
          }
          slot.status = "failed";
          log("[prefetch] 放弃（不影响播放）｜ track=" + id2 + " ｜ " + (e && e.message));
        });
    } catch (e) {}
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
    /**
     * ★ v1.8.6 / v1.8.7：先分清「这次换歌是谁干的」。
     *
     * 真机两个反例（都是「手选跳歌把 hitStreak 清零 → 下一首本该无缝却不敢预约」）：
     *
     *   ① 13:56 那一轮：`▶ audioplayer.stop` → setCurrentPlay(别的) → ✗ 预测失败 → 26 秒后
     *      `[end] ★ 自然播完`（没有「→ 无缝交接」），硬切 312ms。
     *   ② 14:27:54 那一轮：客户端**没发 stop**（是换歌单 + 手选），A(1625) 才播到 16.9s/142.8s
     *      就被切走 → ✗ 预测失败 1/3；26 秒后同样是硬切 364ms。
     *
     * 所以判据不能只看 stop，要看**上一首是不是真播到结尾了**：
     *   - `S.__endedAt`：我们刚发过 onEnd（= 这一首自然播完 / 客户端该推进了）；
     *   - 或者 3 秒内收到过 `audioplayer.stop`（用户点了切歌）。
     * 两者都不满足 ⇒ 这次换歌是用户在歌中途跳的 ⇒ **既不算押中、也不算押错**
     * （不退 hitStreak、不涨 preloadMisses）—— 它根本不包含「播放顺序可不可预测」的信息。
     */
    var sinceEnd = S.__endedAt ? Date.now() - S.__endedAt : Infinity;
    var sinceStop = S.lastUserStopAt >= 0 ? performance.now() - S.lastUserStopAt : Infinity;
    // 用户动作优先：3 秒内有 stop ⇒ 无论 A 有没有播完，都不作数
    // 否则必须「A 真的刚播完」（3 秒内发过 onEnd）才算一次「对顺序的检验」
    if (sinceStop <= 3000 || sinceEnd > 3000) {
      log(
        "[preload] 预载的是 " + p.trackId + "，来的却是 " + tid +
          " → 上一首没播完就切走（用户跳歌）→ 不作数；「顺序可预测」的历史保持不变"
      );
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

  /**
   * `opts.noDisk` 只给一处用：磁盘那份解不开时丢掉它、改走网络重来一次
   * （见下面 catch 里的「磁盘那份解不开」）。平时调用都是 `startPreload(id, why)`。
   */
  function startPreload(trackId, why, opts) {
    // ★ v0.2.5：换槽前先把上一个在飞的下载掐断（否则它照跑到底，白花带宽）
    var old = S.preload;
    // ★ v1.6.0：换的是**别的歌** → 之前为它预开的槽没用了（保留当前这首那一份）
    if (!(old && old.trackId === trackId) && S.curTrackId !== null) {
      clearPreopensExcept(S.curTrackId, "换预载目标");
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
    // ★ v1.8.5：落盘用的字节句柄。**必须在 decode 之前抓住**，原因有两条：
    //   ① `decodeAudioData` 会 detach 传进去的 ArrayBuffer；
    //   ② 内存字节缓存只有 2 格、单首预热槽只有 1 格 —— 等 decode 完（~700ms）再回头找，
    //      那一格可能已经被「抓 N+2」的预热顶掉了（真机就是这么一行都没落成盘的）。
    var diskHandle = null;
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
    var cachedBytes = cacheGetBytes(trackId) || getWarmBytes(trackId); // ★ v1.8.0（#16）
    if (cachedBytes) log("[preload] ★ 字节缓存命中 → 跳过取址 + 下载 ｜ track=" + trackId);
    // ★ v1.8.4：字节从哪儿来的（mem / disk / net）—— 「解不开就重来」和「要不要落盘」都要看它
    slot.from = cachedBytes ? "mem" : "net";
    // ★ v1.8.4：预载要**同步**抢占闸门（pri 0）。否则同一拍里发起的「抓 N+2 的字节」
    //   会因为它少几个微任务而先跑起来，把最有截止时间的那一份挤到后面排队（真机日志里就是这样）。
    slot.promise = (cachedBytes
      ? Promise.resolve(cachedBytes)
      : downloadGate(0, "预载（" + (why || "?") + "）", ac ? ac.signal : null, function (sig) {
          return Promise.resolve()
            // ★ v1.8.4：先问磁盘（清内存 / 重启之后这一步能把取址 + 下载全省掉）
            .then(function () {
              if (opts && opts.noDisk) return null;
              return diskGetBytes(trackId);
            })
            .then(function (db) {
              if (db) {
                slot.from = "disk";
                return db;
              }
              slot.from = "net";
              return resolveUrl(trackId)
                .then(function (url) {
                  if (url) slot.url = url; // ★ v1.5.3：记下来，B 没下完时用它提前预开流
                  if (tk !== S.preloadToken) return null;
                  return fetchBytes(url, sig);
                })
                .catch(function (e) {
                  // ★ 3.x：LibEAPI 那条取址路在 3.x 上必然失败（扫到的是 webpack 模块工厂）→
                  //   320k 免签名接口 → outer/url(128k) → 原生网络取字节。
                  //   2.10.x 保持上游语义（失败直接抛给下游 → 退回流式），不多打请求。
                  if (!isNcm3()) throw e;
                  if (tk !== S.preloadToken) return null;
                  logVerbose("[preload] LibEAPI 不可用（" + (e && e.message) + "）→ 试 320k 免签名接口");
                  return resolveUrl320(trackId)
                    .then(function (url320) {
                      if (tk !== S.preloadToken) return null;
                      return fetchBytes(url320, sig);
                    })
                    .catch(function (e2) {
                      if (tk !== S.preloadToken) return null;
                      log("[preload] 320k 接口失败（" + (e2 && e2.message) + "）→ outer/url(128k) 兜底");
                      return fetchBytes(outerUrlFor(trackId), sig).catch(function (e3) {
                        if (tk !== S.preloadToken) return null;
                        log("[preload] 128k 直链也失败（" + (e3 && e3.message) + "）→ 原生网络取字节");
                        return nativeFetchBytes(outerUrlFor(trackId));
                      });
                    });
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
        // ★ v1.8.5：现在就抓住落盘句柄（缓存命中就直接用那份副本，不额外复制；
        //   缓存没命中/被挤掉才复制一份 —— 这一步不能省，否则磁盘缓存会静默不工作）
        try {
          diskHandle = peekBytesForDisk(trackId);
          if (!diskHandle && typeof buf.slice === "function") diskHandle = buf.slice(0);
        } catch (e) {
          diskHandle = null;
        }
        return ctx.decodeAudioData(buf).then(function (ab) {
          // ★ 3.x：解出来的时长若明显短于权威时长 → 这是试听/片段，丢掉（否则歌会在边界断掉）
          //   ⚠️ v1.8.4：从**磁盘**来的字节当初就是验过的，这里不再多打一次 song/detail
          //   （否则磁盘缓存的收益会被这一个请求吃掉一半）。
          //   `slot.trusted` = 「这次真的拿到权威时长比过」—— 只有它才允许落盘（约束 ①）。
          if (!isNcm3() || !ab || slot.from === "disk") {
            slot.trusted = true; // 2.10 上游语义本来就没这一步；磁盘来源当初验过
            return ab;
          }
          return resolveDurationMs(trackId)
            .catch(function (e) {
              // ★ v1.8.5：别把「拿不到」吞成 0 —— 那样既跳过校验、又悄悄不落盘，谁都看不出来
              log("[preload] 拿不到权威时长（" + (e && e.message) + "）→ 试听校验跳过 ｜ track=" + trackId);
              return 0;
            })
            .then(function (dtMs) {
              if (dtMs && ab.duration && dtMs / 1000 - ab.duration > 3) {
                throw new Error(
                  "解码时长 " + ab.duration.toFixed(1) + "s 短于实际 " + (dtMs / 1000).toFixed(1) + "s（试听片段），放弃预载"
                );
              }
              // ⚠️ 拿不到权威时长（接口失败）就只是「没验过」，不是「验过了」→ 这一份不落盘
              if (dtMs) slot.trusted = true;
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
        // ★ v1.8.4/v1.8.5：落盘判据（约束 ①）——
        //   「真验过试听片段」**或**「字节数 == 接口声明的大小」（后者不依赖 song/detail 是否可用）。
        //   磁盘命中的那份不用再写回去；跳过时**一定要留一行日志**，否则就是「磁盘=0 首」的无头案。
        if (slot.from !== "disk") {
          try {
            var declared = declaredSizeOf(trackId);
            var sizeOk = !!declared && !!diskHandle && diskHandle.byteLength === declared;
            if (!diskEnabled()) {
              /* 关着：不刷日志 */
            } else if (!slot.trusted && !sizeOk) {
              DISK.skipped++;
              log(
                "[disk] 跳过落盘（没验过试听、也没有声明大小可比）｜ track=" + trackId +
                  " ｜ 字节=" + (diskHandle ? diskHandle.byteLength : "无") + " ｜ 声明=" + (declared || "无")
              );
            } else if (!diskHandle) {
              DISK.skipped++;
              log("[disk] 跳过落盘（没拿到字节句柄）｜ track=" + trackId);
            } else {
              diskPutBytes(trackId, diskHandle);
            }
          } catch (e) {}
        }
        S.preloadState = "ready";
        log(
          "[preload] ★★ 预载就绪（" + (why || "?") + "）｜ track=" + trackId + " ｜ " + ab.duration.toFixed(1) + "s ｜ " +
            mb(ab.length * ab.numberOfChannels * 4) + " MB ｜ 耗时 " + (performance.now() - t0).toFixed(0) + "ms" +
            (slot.from === "disk" ? " ｜ 来源=磁盘" : slot.from === "mem" ? " ｜ 来源=内存字节" : "")
        );
        // ★ v1.7.2（#2）：如果这一首正是原生在播的那首、而且我们已经有原生位置 → 现在就接手
        if (trackId === S.curTrackId) tryTakeoverCurrent("预载就绪");
        return ab;
      })
      .catch(function (e) {
        // ★ v0.2.5：被我们**主动掐断**的（作废 / 换槽）不算失败，安静记一笔就行
        if (e && e.name === "AbortError") {
          log("[preload] 已掐断（作废/换槽）｜ track=" + trackId);
          return null;
        }
        // ★ v1.8.4：磁盘那份解不开（被外部截断 / 换了编码）→ 丢掉它，改走网络再来一次。
        //   只重来一次（`noDisk`），不会打转。
        if (slot.from === "disk" && !(opts && opts.noDisk)) {
          log("[preload] 磁盘那份解不开（" + (e && e.message) + "）→ 丢掉，改走网络再试一次");
          slot.status = "failed";
          if (tk === S.preloadToken) S.preloadState = "failed";
          diskDrop(trackId);
          return startPreload(trackId, why, { noDisk: true });
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
    // ★ v1.6.0：预载作废 → 为它预开的槽也一起清掉（保留正在播那首的预开）
    if (!(opts && opts.keepPreopen)) {
      clearPreopensExcept(S.curTrackId, "预载作废");
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
    // ★ v1.9.2：撤销「A 提前收尾」—— 把 stop 时间改回自然结束（stop 可重复调，后一次覆盖前一次）
    if (sc.earlyStopSrc && sc.naturalEndCtx) {
      try {
        sc.earlyStopSrc.stop(sc.naturalEndCtx);
      } catch (e) {}
    }
    // ★ v1.3.0：撤销时把 A 的增益拉回来 —— 否则它会被留在淡出中途的音量上
    //   （暂停/拖动都走这里，A 还要继续响）
    restoreGain(sc.fadeA, 1);
    restoreGain(sc.fadeB, 0);
    restoreEq(sc.eqA); // ★ v1.3.2：扫频也要复位，否则 A 会一直闷着
    // ★ v1.7.0：拉伸段是独立的 source，撤销时必须一起停，否则它会继续响
    if (sc.stretchedSrc) {
      try {
        sc.stretchedSrc.stop();
      } catch (e) {}
    }
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
    // ★ v1.9.2：押错时 A 还要继续播完 → 撤销「提前收尾」
    if (sc.earlyStopSrc && sc.naturalEndCtx) {
      try {
        sc.earlyStopSrc.stop(sc.naturalEndCtx);
      } catch (e) {}
    }
    log("[sched] ★ 押错 → 撤销预约（" + (why || "?") + "）｜ 原本预约 " + sc.trackId);
    restoreGain(sc.fadeA, 1); // ★ v1.3.0：押错时 A 还要继续响，增益必须复位
    restoreGain(sc.fadeB, 0);
    restoreEq(sc.eqA); // ★ v1.3.2
    if (sc.stretchedSrc) {
      try {
        sc.stretchedSrc.stop();
      } catch (e) {}
    }
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
  /* ==================== v1.5.5 · C3 续：直接查播放列表 DB（storage.execsql）==================== */

  /**
   * C3 第一轮探针的结论（真机 09:05 / 09:07 / 09:08 三次）：
   *
   *   nm.play.getNextSong / getPlayerMode / getCurrentSong → 全部 `undefined`
   *     （渲染层的 channel.call 路由不到 tinyapp 桥的命令，这条路封死）
   *   Database.getAllBy                                    → `undefined`（同上，名字也不对）
   *   IndexedDB 只有 1 个库 `columnGrow`：keyvaluepairs / local-forage-detect-blob-support
   *     （那是 localForage 的 KV，**不是**播放列表）
   *   registeredCalls 里没有任何 next/random 相关处理器
   *   localStorage 193 个键，没有随机序列/种子（只有 playingInfo 那种加密快照）
   *
   * 但静态分析找到了真正的路：客户端的播放列表 DB 走的是**通道命令**
   *
   *     channel.call("storage.execsql", cb, [reqId, sqlText])
   *     legacyNativeCmder.appendRegisterCall("execsqldone", "storage", function (reqId, errCode, value) {...})
   *
   * 也就是说：只要这条通道对我们开放，我们就能**直接 SELECT 出 randomOrder**——
   * 而客户端的随机顺序就是「按 randomOrder 排序」，于是「下一首是谁」完全可算。
   *
   * 这一段就是去验证这条通道。只读 SQL、不改数据；带了 reqId 过滤，不会误接别人的结果。
   */

  var sqlSeq = 0;
  var sqlPending = {}; // reqId → 回调（一次只认一条，别人查库的结果不会串进来）
  var sqlHandlerReady = false;

  /** 只注册一次（否则每查一次就多挂一个处理器，越用越多） */
  function ensureSqlHandler() {
    if (sqlHandlerReady) return true;
    try {
      if (typeof legacyNativeCmder === "undefined" || !legacyNativeCmder ||
          typeof legacyNativeCmder.appendRegisterCall !== "function") {
        log("[sql] ★ 没有 appendRegisterCall，查不了 DB");
        return false;
      }
      legacyNativeCmder.appendRegisterCall("execsqldone", "storage", function (id, err, value) {
        var key = String(id);
        var cb = sqlPending[key];
        if (!cb) {
          // 客户端自己也在用这条通道 → 别人的结果直接忽略（记一笔，便于排查「结果串台」）
          log("[sql] 忽略一条不属于我们的结果 ｜ id=" + key);
          return;
        }
        delete sqlPending[key];
        try {
          cb(err, value);
        } catch (e) {}
      });
      sqlHandlerReady = true;
      return true;
    } catch (e) {
      log("[sql] ★ 注册 execsqldone 失败 ｜ " + (e && e.message));
      return false;
    }
  }

  /**
   * 发一条只读 SQL。结果靠 `storage.onexecsqldone` 回来（客户端自己也是这么拿结果的）。
   * @param cb 可选：function(errCode, value)
   * @returns reqId（用于在日志里对照）
   */
  function probeSql(sql, cb) {
    var reqId = "gp" + Date.now() + "_" + ++sqlSeq;
    if (!ensureSqlHandler()) return null;
    sqlPending[reqId] = function (err, value) {
      log("[sql] ← err=" + err + " ｜ " + briefJson(value, 3000));
      if (typeof cb === "function") {
        try {
          cb(err, value);
        } catch (e) {}
      }
    };
    log("[sql] → " + briefJson(sql, 200) + " ｜ reqId=" + reqId);
    try {
      channel.call("storage.execsql", function (res) {
        if (res !== undefined && res !== null) log("[sql] 直接回调 ← " + briefJson(res, 300));
      }, [reqId, sql]);
    } catch (e) {
      delete sqlPending[reqId];
      log("[sql] ★ channel.call 抛错 ｜ " + (e && e.message));
      return reqId;
    }
    setTimeout(function () {
      if (sqlPending[reqId]) {
        delete sqlPending[reqId];
        log("[sql] ← 无响应（1500ms）｜ 这条 SQL 没等到结果");
      }
    }, 1500);
    return reqId;
  }

  /**
   * 第一步探针：
   *   ① 直接找「哪张表有 randomOrder 列」—— 这就是随机顺序的存放处
   *   ② 顺便把建表 SQL 里带 randomOrder 的那条的完整定义打出来（看列名/索引）
   */
  function probeSqlTables() {
    log("[sql] ===== 找 randomOrder 所在的表 =====");
    probeSql(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND (sql LIKE '%randomOrder%' OR name LIKE '%order%')",
      function (err, value) {
        var rows = Array.isArray(value) ? value : [];
        if (!rows.length) {
          log("[sql] 没找到含 randomOrder 的表/建表语句（可能需要看别的库）");
          return;
        }
        for (var i = 0; i < rows.length; i++) {
          log("[sql] ★ 候选表 " + (rows[i] && rows[i].name) + " ｜ " + briefJson(rows[i] && rows[i].sql, 600));
        }
        // ★ 顺手看一眼最像「播放顺序」的那张表（结构 + 前 3 行，只读）
        for (var k = 0; k < rows.length && k < 3; k++) {
          var nm = rows[k] && rows[k].name;
          if (nm && /order|current|playing/i.test(nm)) {
            probeSqlTable(nm);
            break;
          }
        }
      }
    );
    return true;
  }

  /**
   * ★ v1.5.7：直接看**播放列表**那两张表。
   * 从客户端常量里挖到的真实表名是 `currentPlayingList` / `lastPlayingList`
   * （`{current:"currentPlayingList", last:"lastPlayingList"}`），
   * 随机顺序就是它们里面的 `randomOrder` 列排序。
   *
   * 一次点完三件事：建表 SQL → 头两行（列名/值一览）→ 总行数。
   */
  function probePlayingList() {
    log("[sql] ===== 看播放列表表（currentPlayingList / lastPlayingList）=====");
    probeSql(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('currentPlayingList','lastPlayingList')",
      function (err, rows) {
        var list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
          log("[sql] ★ 这张库里没有 currentPlayingList/lastPlayingList（可能不在这条连接上）");
          return;
        }
        for (var i = 0; i < list.length; i++) {
          log("[sql] ★ 表 " + list[i].name + " ｜ " + briefJson(list[i].sql, 900));
        }
      }
    );
    probeSql("SELECT * FROM currentPlayingList LIMIT 2", function (err, rows) {
      var list = Array.isArray(rows) ? rows : [];
      log("[sql] currentPlayingList 前 2 行: " + briefJson(list, 1500));
    });
    probeSql("SELECT count(*) AS n FROM currentPlayingList");
    return true;
  }
  /**
   * ★ v1.5.8：最后的两个线索（都只读）。
   *
   *   ① `persistentModel` 表 —— 名字像是「持久化的 store」，如果播放列表的 redux 状态在里面，
   *      那 `curPlayingList`（含每行的 randomOrder）就能直接读到；
   *   ② `window.frontendEncrypt` —— 客户端的加解密入口（window 上确实有），
   *      localStorage 里的 `playingInfo`（十几 KB 的密文）很可能就是「播放列表快照」。
   *      能解开它，就不需要 DB 也不需要 store。
   */
  function probePersist() {
    log("[sql] ===== persistentModel / 加密快照 =====");
    probeSql("SELECT sql FROM sqlite_master WHERE type='table' AND name='persistentModel'");
    probeSql("SELECT * FROM persistentModel LIMIT 3", function (err, rows) {
      log("[sql] persistentModel 前 3 行: " + briefJson(rows, 2000));
    });

    try {
      var fe = (typeof window !== "undefined" && window && window.frontendEncrypt) || null;
      log("[enc] frontendEncrypt ｜ typeof=" + typeof fe + " ｜ keys=" + (fe ? Object.keys(fe).join(",") : "（无）"));
      var pi = null;
      try {
        pi = (typeof localStorage !== "undefined" && localStorage) ? localStorage.getItem("playingInfo") : null;
      } catch (e) {
        pi = null;
      }
      log("[enc] playingInfo 长度=" + (pi ? pi.length : 0));
      if (fe && pi) {
        var cands = ["decode", "decrypt", "decodeStr", "aesDecrypt", "aesDecode", "strDecrypt"];
        for (var i = 0; i < cands.length; i++) {
          var k = cands[i];
          if (typeof fe[k] !== "function") continue;
          try {
            var out = fe[k](pi);
            log("[enc] frontendEncrypt." + k + "(playingInfo) → " + briefJson(out, 600));
          } catch (e2) {
            log("[enc] frontendEncrypt." + k + " 抛错 ｜ " + (e2 && e2.message));
          }
        }
      }
    } catch (e) {
      log("[enc] 探针抛错 ｜ " + (e && e.message));
    }
    return true;
  }
  /** 通用：把「某张表的结构 + 前几行」打出来 */
  function probeSqlTable(name) {
    var t = String(name || "");
    if (!/^[A-Za-z0-9_]+$/.test(t)) {
      log("[sql] ★ 表名不合法: " + t);
      return null;
    }
    log("[sql] ===== 看表 " + t + " =====");
    probeSql("SELECT sql FROM sqlite_master WHERE type='table' AND name='" + t + "'");
    return probeSql('SELECT * FROM "' + t + '" LIMIT 3');
  }

  /* ==================== v1.5.4 · C3 侦察：能不能问出「下一首是谁」==================== */

  /**
   * 随机播放做不到无缝的**根因**不是 DSP，而是「不知道下一首是谁」：
   *   - 客户端的随机顺序是**存起来的**（播放列表 DB 里每一行有个 `randomOrder`，播放时按它排序；
   *     切随机模式时会整列重刷随机值）；
   *   - 渲染层还有 `setRandomNextInPlayingList` 这个动作，把「下一次随机挑中的那首」写进 store。
   *
   * 但这些都是**客户端内部状态**：插件能不能读到，取决于桥/存储是否对我们开放。
   * 所以这一段只做**侦察**（只读、不改任何行为），把几条可能的入口一次性问清楚：
   *
   *   ① 直接问 native：`nm.play.getNextSong` / `getPlayerMode` / `getCurrentSong`
   *      （这几个名字是客户端 tinyapp 桥的命令白名单里的，看渲染层的 channel.call 能不能路由过去）
   *   ② 问播放列表 DB：`Database.getAllBy { tableName: "current", orderBy: randomOrder }`
   *   ③ 看 IndexedDB：库里有什么 database、每个库里有什么表（如果是 IndexedDB，我们就能直接读）
   *   ④ 看 localStorage：有没有存着顺序/种子
   *   ⑤ 看 registeredCalls：有没有 next/random 相关的处理器
   *
   * 结论怎么用：哪一条先给出可用数据，下一步就顺着那条做「提前知道下一首」。
   */

  var NEXT_CMDS = [
    "nm.play.getNextSong",
    "nm.play.getPlayerMode",
    "nm.play.getCurrentSong",
  ];

  var probeBusy = false;

  function briefJson(v, max) {
    var lim = max || 220;
    try {
      if (v === null || v === undefined) return String(v);
      if (typeof v === "string") return v.length > lim ? v.slice(0, lim) + "…(" + v.length + "B)" : v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      var s = JSON.stringify(v);
      if (s === undefined) return String(v);
      return s.length > lim ? s.slice(0, lim) + "…(" + s.length + "B)" : s;
    } catch (e) {
      return "[不可序列化]";
    }
  }

  /** 问一条命令：有回调就记结果，800ms 没动静就记「无响应」 */
  function askCmd(name, args) {
    var done = false;
    try {
      channel.call(
        name,
        function (res) {
          done = true;
          log("[next] " + name + " ← " + briefJson(res));
        },
        args || []
      );
    } catch (e) {
      log("[next] " + name + " ｜ 调用抛错 ｜ " + (e && e.message));
      return;
    }
    setTimeout(function () {
      if (!done) log("[next] " + name + " ← 无响应（800ms）");
    }, 800);
  }

  function probeStorage() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return;
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        try {
          keys.push(localStorage.key(i));
        } catch (e) {}
      }
      log("[next] localStorage 共 " + keys.length + " 个键");
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        if (!k) continue;
        // 只打「看起来跟顺序/队列/模式有关」的，或者键总数不多时全打
        if (keys.length > 40 && !/random|shuffle|order|queue|list|play|mode/i.test(k)) continue;
        var v = null;
        try {
          v = localStorage.getItem(k);
        } catch (e) {}
        log("[next]   " + k + " = " + briefJson(v, 120));
      }
    } catch (e) {
      log("[next] localStorage 探针抛错 ｜ " + (e && e.message));
    }
  }

  function probeRegistry() {
    try {
      var RC =
        (typeof registeredCalls !== "undefined" && registeredCalls) ||
        (typeof window !== "undefined" && window && window.registeredCalls);
      var keys = RC ? Object.keys(RC) : [];
      var hit = [];
      for (var i = 0; i < keys.length; i++) {
        if (/next|random|shuffle|mode|queue|playlist/i.test(keys[i])) hit.push(keys[i]);
      }
      log("[next] registeredCalls 共 " + keys.length + " 个 ｜ 相关: " + (hit.length ? hit.join(", ") : "（无）"));
    } catch (e) {}
  }

  function probeIdb() {
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) {
        log("[next] indexedDB 不可用（这个环境没有）");
        return;
      }
      if (typeof indexedDB.databases !== "function") {
        log("[next] indexedDB.databases() 不可用（Chromium < 71？）");
        return;
      }
      var pr = indexedDB.databases();
      if (!pr || typeof pr.then !== "function") {
        log("[next] indexedDB.databases() 没返回 promise");
        return;
      }
      pr.then(function (list) {
        list = list || [];
        var names = [];
        for (var i = 0; i < list.length; i++) names.push(list[i] && list[i].name);
        log("[next] IndexedDB 共 " + list.length + " 个库: " + names.join(", "));
        // 前几个库报一下表名（只读：open 不加版本号，不会触发升级）
        for (var j = 0; j < list.length && j < 6; j++) {
          (function (nm) {
            if (!nm) return;
            try {
              var rq = indexedDB.open(nm);
              rq.onsuccess = function () {
                try {
                  var db = rq.result;
                  var stores = [];
                  var sn = (db && db.objectStoreNames) || [];
                  for (var t = 0; t < sn.length; t++) stores.push(sn[t]);
                  log("[next]   " + nm + " → 表: " + (stores.length ? stores.join(", ") : "（无）"));
                  try {
                    db.close();
                  } catch (e) {}
                } catch (e) {}
              };
              rq.onerror = function () {
                log("[next]   " + nm + " → 打不开");
              };
            } catch (e) {}
          })(names[j]);
        }
      }).catch(function (e) {
        log("[next] indexedDB.databases() 失败 ｜ " + (e && e.message));
      });
    } catch (e) {
      log("[next] indexedDB 探针抛错 ｜ " + (e && e.message));
    }
  }

  /** C3 侦察入口：只读、幂等，随便点几下都不会有副作用 */
  function probeNext() {
    if (probeBusy) {
      log("[next] 上一次侦察还没跑完，等一下");
      return false;
    }
    probeBusy = true;
    log("[next] ===== C3 侦察开始（只读）=====");
    // ① native 命令
    for (var i = 0; i < NEXT_CMDS.length; i++) askCmd(NEXT_CMDS[i]);
    // ② 播放列表 DB（随机顺序就是 randomOrder 排序）
    askCmd("Database.getAllBy", [
      { tableName: "current", colNames: ["id", "resourceId", "randomOrder"], orderBy: [{ name: "randomOrder", order: "ASC" }] },
    ]);
    // ③④⑤ 本地可读的状态
    probeIdb();
    probeStorage();
    probeRegistry();
    log("[next] ===== 侦察请求已发出（等日志里的 ← 结果）=====");
    setTimeout(function () {
      probeBusy = false;
    }, 1200);
    return true;
  }

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
  /** 清掉某个槽上的预开（绝不碰正在出声的槽） */
  function clearSlotPreopen(i, why) {
    var s = slotAt(i);
    if (!s || s.preopenTrackId === null) return;
    var was = s.preopenTrackId;
    s.preopenTrackId = null;
    log("[stream] 清掉提前预开的流（" + (why || "?") + "）｜ 槽#" + i + " track=" + was);
    if (i === elActive) return; // 正在出声的槽绝不动
    try {
      s.el.pause();
      if (typeof s.el.removeAttribute === "function") s.el.removeAttribute("src");
      if (typeof s.el.load === "function") s.el.load();
    } catch (e) {}
  }

  /** 清掉所有预开，但**保留**指定曲目那一份（换预载目标时用） */
  function clearPreopensExcept(keepTrackId, why) {
    for (var i = 0; i < elPool.length; i++) {
      if (keepTrackId !== null && keepTrackId !== undefined && elPool[i].preopenTrackId === keepTrackId) continue;
      clearSlotPreopen(i, why);
    }
  }

  function clearPreopen(why) {
    clearPreopensExcept(null, why);
  }

  function findPreopenSlot(trackId) {
    if (trackId === null || trackId === undefined) return -1;
    for (var i = 0; i < elPool.length; i++) {
      if (elPool[i].preopenTrackId === trackId) return i;
    }
    return -1;
  }

  /**
   * 提前把下一首的流挂到**空闲槽**上让它自己缓冲。
   * ★ 与 v1.5.3 的区别：那时受「唯一元素正被当前这首占用」限制，只能在不走流式时才预开；
   *   现在用到第二个槽，**当前在流式也能预开**（这正是双元素的意义）。
   */
  function preopenStream(url, trackId) {
    if (!url) return false;
    if (passAllToNative()) return false;
    if (!S.ctx) return false;
    if (trackId === null || trackId === undefined) return false;
    if (findPreopenSlot(trackId) >= 0) return false; // 已经为这一首预开过（幂等）
    ensureSlotCount(2);
    var idx = -1;
    for (var i = 0; i < elPool.length; i++) {
      if (i !== elActive && elPool[i].preopenTrackId === null) {
        idx = i;
        break;
      }
    }
    // ★ v1.8.0（#15）：没有空槽时，**抢占一个过期的预开**（它预开的既不是当前这首、也不是目标）
    //   —— 之前这种情况直接放弃预热，等于白白退化回「等 canplay」。
    if (idx < 0) {
      for (var i2 = 0; i2 < elPool.length; i2++) {
        if (i2 === elActive) continue;
        var pt = elPool[i2].preopenTrackId;
        if (pt === null || pt === S.curTrackId || pt === trackId) continue;
        clearSlotPreopen(i2, "抢占给新的预热目标");
        idx = i2;
        break;
      }
    }
    if (idx < 0) return false; // 实在没有可用槽 → 放弃预热（退化成原来的行为）
    var s = elPool[idx];
    try {
      s.el.preload = "auto";
      s.el.src = String(url);
      if (typeof s.el.load === "function") s.el.load();
      s.preopenTrackId = trackId;
      log("[stream] ★ 提前预开 <audio>（B 还没就绪）｜ 槽#" + idx + " ｜ " + String(url).slice(-64));
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

    // ★ v1.7.1：B 可能是「已解码的缓冲」，也可能是「在空闲槽里预开着的流」。
    //   这里只做**最基本的**资格判断，真正的分支在取到 buf 之后。
    var p = S.preload;
    var pHasBuf = !!(p && p.trackId === nid && p.status === "ready" && p.why === "下一首");
    if (!pHasBuf && findPreopenSlot(nid) < 0) return; // 既没缓冲也没预开流 → 没得排

    // ③ 置信「顺序播放」：能读到模式就让它权威（⚠️ 单曲循环下 seqStreak 会冻结在高位）
    var mode = readPlayMode();
    if (mode !== null) {
      if (mode !== "playonce" && mode !== "playorder") {
        // ★ v1.20.0：随机模式下，**预载槽已经是「列表下一首」且就绪**时也放行 ——
        //   否则用户手选一首（押不中 → hitStreak 归零）之后，流式那首永远排不上，
        //   流式无缝衔接就"又不行了"。押错的话 setCurrentPlay 分支会撤销预约。
        var seqPreloadOk = !!(pHasBuf && S.preload && S.preload.why === "下一首" && S.preload.status === "ready");
        if (!(isNcm3() && ((S.hitStreak || 0) >= 1 || seqPreloadOk))) return;
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
    // ★ v1.9.1：交叉时长按乐句量化（128bpm 下 3s → 3.75s = 2 小节）。
    //   只在 A 是缓冲、拍点可信时才做；量化后的值也必须用于窗口 —— 否则变长的交叉永远进不了窗口。
    // ★ v1.10.0：流式 A 也要试 —— 拍点可能来自落盘的离线分析（`beatGridNear` 现在缓存优先），
    //   或者来自后台补缓冲出来的 `recentBufs`（之前这份成果被 `!S.stream` 白白挡掉了）。
    var aBufForMix = S.buffer || recentGet(S.curTrackId);
    var gAq = autoMixEnabled() ? beatTail(S.curTrackId, aBufForMix) : null;
    // ★ v1.14.0：智能交叉先用「2 小节」估一个窗口（档位要等 B 的网格才知道），
    //   拿不到网格 / 显式设过 → 走原来的整拍量化。
    var smartOn = xfadeSmart();
    var xfq = smartOn && gAq ? smartFadeSec(gAq, "full") : 0;
    if (!(xfq > 0)) xfq = quantizeXfadeSec(xf, gAq);
    // ⚠️ 这个函数每 100ms 跑一次；窗口开着但排不上（比如 B 还没就绪）时会反复进这里 —— 同一组值只记一次
    if (xfq !== xf && xf > 0 && gAq) {
      var sig = (smartOn ? "s" : "x") + xf.toFixed(2) + ">" + xfq.toFixed(2);
      if (S.__lastXfqSig !== sig) {
        S.__lastXfqSig = sig;
        var beatsN = Math.round(xfq / (60 / gAq.bpm));
        log(
          smartOn
            ? "[automix] 智能按小节 → " + xfq.toFixed(2) + "s ｜ " + gAq.bpm.toFixed(1) + "bpm × " + beatsN +
              " 拍（兜底秒数 " + xf.toFixed(2) + "s 不参与，实际见 [sched]）"
            : "[automix] 交叉按乐句量化 " + xf.toFixed(2) + "→" + xfq.toFixed(2) + "s ｜ " +
              gAq.bpm.toFixed(1) + "bpm × " + beatsN + " 拍（原始设定 " + xf.toFixed(2) + "s）"
        );
      }
    }
    var winMax = Math.max(1.5, xfq + 0.4, xfq > 0 && earlyOutEnabled() ? xfq + EARLY_OUT_MAX_SEC + 0.4 : 0);
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
    if (!buf) {
      // ★ v1.7.1（#3）：B 还没有解码缓冲 —— 但如果它已经在**空闲槽**里预开着流，
      //   就用「元素交叉」：A 淡出 + B 的元素淡入（两个 <audio> 各自出声）。
      //   ⚠️ 这是结构性限制 #3 的修法：流式 B 拿不到 AudioBuffer，只能靠元素做交叉。
      return scheduleStreamCrossfade(nid, left, endCtxTime, xfq);
    }

    // ★★ v1.2.0：B 自己的首尾裁剪 —— 绝不能套用 A 的（两首的 delay/padding 不一样）。
    //   start(t0, btrim.start, bdur)：从 B 的「可听起点」起，只播「可听长度」，
    //   于是 A 的最后一个可听采样 → B 的第一个可听采样，中间没有编码器补的静音。
    var btrim = trimOf(nid);
    var bdur = Math.max(0.02, buf.duration - btrim.start - btrim.end);

    // ★ v1.19.0：连续母带（无缝专辑）→ 这一次保持原样（0s 接缝）
    var continuous = false;
    var contInfo = null;
    var contAlbum = null;
    if (xf > 0) {
      try {
        // ★ v1.20.0：A 用「这首自己的裁剪量」—— 流式 A 的 `S.trim` 是 null，
        //   但补成缓冲时 noteTrim 已经把真实 trim 记在 trimCache 里；不用它就会把
        //   编码器尾部填充当成音乐尾巴（A 在淡出 → 连续母带漏判，正是"第一首测不出"）。
        contInfo = detectContinuousPair(aBufForMix, buf, trimOf(S.curTrackId), btrim);
      } catch (eC) {
        contInfo = null;
      }
      if (contInfo) {
        continuous = true;
        xf = 0;
        xfq = 0;
        S.lastPlan = { tier: "plain", dev: 0, conf: 0, skip: "", tailWin: "", continuous: true };
        log(
          "[automix] 连续母带 → 保持原样（0s 接缝，不交叉/不早收/不跳入点）｜ 边界电平差 " +
            contInfo.db.toFixed(1) + "dB"
        );
      } else if (continuousEnabled() && btrim.start <= CONT_SILENCE_SEC) {
        // ★ v1.20.0：音频测不了（流式 A 没缓冲）→ 用歌单元数据兜底：同专辑 + 列表相邻
        try {
          contAlbum = sameAlbumAdjacent(S.curTrackId, nid);
        } catch (eA) {
          contAlbum = null;
        }
        if (contAlbum) {
          continuous = true;
          xf = 0;
          xfq = 0;
          S.lastPlan = { tier: "plain", dev: 0, conf: 0, skip: "", tailWin: "", continuous: true, album: true };
          log(
            "[automix] 同专辑相邻（" + contAlbum.album +
              (contAlbum.artist ? " · " + contAlbum.artist : "") +
              "）→ 保持原样（0s 接缝，元数据兜底）"
          );
        }
      }
    }

    // ★ v1.3.0：交叉窗口。xf 受三件事约束：用户设的上限、A 还剩多少、B 有多长。
    var bStart = endCtxTime;
    var fadeSec = 0;
    if (xf > 0) {
      fadeSec = Math.min(xfq, left - 0.05, bdur - 0.05);
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
    var earlyCut = 0; // ★ v1.9.2：A 提前收尾的秒数（0 = 不提前）
    var skipInfo = null; // ★ v1.17.0：这一跳要不要跳过交叉
    var tailWin = "tail"; // ★ v1.18.0：这次用的是哪个尾窗（tail / tail2 / fused）
    var headWin = "head"; // ★ v1.20.0：这次用的是哪个头窗（head / head2 / fused）
    try {
      if (fadeSec > 0 && autoMixEnabled()) {
        var gA2pick = pickTailForMix(beatTail(S.curTrackId, aBufForMix), beatTail2(S.curTrackId, aBufForMix));
        var gA2 = gA2pick.grid;
        tailWin = gA2pick.win;
        var gB2pick = pickHeadForMix(beatHead(nid, buf), beatHead2(nid, buf));
        var gB2 = gB2pick.grid;
        headWin = gB2pick.win;
        var plan = mixPlan(gA2, gB2);
        // ★ v1.14.0：知道档位后再定「智能时长」——full 2 小节、smart 1 小节；
        //   plain（对不上）绝不沿用「2 小节」的预估值（v1.18.0：也不再折拍，直接用你设的秒数）。
        if (smartOn && gA2) {
          var wantSec = smartFadeSec(gA2, plan.tier);
          if (!(wantSec > 0)) wantSec = xf;
          if (
            wantSec > 0 &&
            Math.abs(wantSec - fadeSec) > 0.03 &&
            wantSec <= left - 0.05 &&
            wantSec <= bdur - 0.05
          ) {
            log(
              "[automix] 智能时长 " + fadeSec.toFixed(2) + "→" + wantSec.toFixed(2) + "s ｜ " + plan.tier +
                (plan.tier === "plain"
                  ? "（退回兜底秒数）"
                  : " × " + (plan.tier === "full" ? XFADE_SMART_BEATS_FULL : XFADE_SMART_BEATS_SMART) + " 拍")
            );
            fadeSec = wantSec;
            bStart = endCtxTime - fadeSec;
          }
        }
        // ★ v1.17.0：低置信 / 节奏差 → 这一次不做交叉
        skipInfo = skipReason(plan, gA2, gB2);
        if (skipInfo) {
          mixNote =
            " ｜ 跳过交叉（" + skipReasonLabel(skipInfo) + "）";
          if (skipInfo.reason === "tempo-far") {
            mixNote += "，偏差 " + (skipInfo.dev * 100).toFixed(1) + "%";
          } else {
            mixNote += "，置信 " + Number(skipInfo.conf || 0).toFixed(2);
          }
        }
        if (!skipInfo && plan.tier !== "plain" && gA2) {
          // 拍点网格跑在「缓冲时间轴」上 → 先把可听位置换算过去（加 trim.start）
          var trA = S.trim || zeroTrim();
          var bufPos = S.duration - fadeSec + trA.start;
          // ★ v1.8.2：mix-out 候选按「优先级」逐个试，**第一个可行的才算数**：
          //   ① 能量曲线的 outro 掉点（最自然）② 乐句头（4 小节）③ 最近的拍（保底）
          //   ⚠️ 每个候选都要通过「下一刀之后仍然可行」的检查，否则退到下一个 ——
          //   之前写成「优先用乐句头」而没有级联，结果窗口不够时连拍点对齐都丢了。
          var cands = [];
          var dropSec = outroDropSec(S.curTrackId, aBufForMix, S.duration);
          if (dropSec !== null) {
            cands.push({ pos: dropSec + trA.start, how: "outro 掉点", pull: OUTRO_PULL_MAX_SEC });
          }
          var pb2 = phraseAtOrBefore(gA2, bufPos);
          cands.push({
            pos: pb2,
            how: "乐句头",
            pull: PHRASE_MIXOUT_MAX_BEATS * gA2.beatSec,
          });
          cands.push({ pos: snapToBeat(gA2, bufPos).pos, how: "拍", pull: gA2.beatSec });
          var sn = { delta: 0, early: false };
          var how = "拍";
          for (var ci = 0; ci < cands.length; ci++) {
            var cd = cands[ci];
            var dl = cd.pos - bufPos;
            if (dl > 0.05 || -dl > cd.pull + 1e-6) continue;
            /**
             * 一个候选能怎么用，取决于两种花法各自的约束：
             *   - 提前收尾：`dl < 0`（真的更早），少播 ≤ 上限，且交叉还得放得下；
             *   - 拉长淡出（老办法）：新的交叉时长不能超过「还剩多少」和 B 的长度。
             * ⚠️ 以前这里只有后者 —— 于是「提前收尾」的候选会被 `nf <= left` 一条条否掉。
             */
            var cut = -dl;
            var canEarly =
              earlyOutEnabled() &&
              cut >= 0.05 &&
              cut <= EARLY_OUT_MAX_SEC &&
              endCtxTime + dl - S.ctx.currentTime >= fadeSec + 0.1;
            var nf = fadeSec - dl;
            var canExtend = nf >= 0.5 && nf <= left - 0.05 && nf <= bdur - 0.05;
            if (!canEarly && !canExtend) continue;
            sn = { delta: dl, early: canEarly };
            how = cd.how;
            break;
          }
          if (sn.delta) {
            /**
             * ★ v1.9.2：找到的混音点有两种花法 ——
             *   ① **提前收尾**（DJ 做法，默认）：交叉时长不变，把 A 的**结束**挪到这个音乐点上
             *      （少播最后几秒），淡出边界因此落在乐句/掉点上，而不是「歌放完了才开始淡」；
             *   ② 老办法（`__gpEarlyOut = false`）：结束不动，把多出来的时间算进交叉（淡出变长）。
             *   ⚠️ ①会改变「这首歌是否放完」—— 所以有开关，而且只在这个混音点有据可依时才做
             *      （候选已经限了 pull，再加一道绝对上限）。
             */
            var newEndTry = endCtxTime + sn.delta;
            if (sn.early) {
              earlyCut = -sn.delta;
              endCtxTime = newEndTry;
              bStart = endCtxTime - fadeSec;
              mixNote =
                " ｜ A 提前收尾（" + how + "）少播 " + earlyCut.toFixed(2) + "s（交叉 " + fadeSec.toFixed(2) + "s）";
            } else {
              var newFade = fadeSec - sn.delta;
              if (newFade >= 0.5 && newFade <= left - 0.05 && newFade <= bdur - 0.05) {
                mixNote =
                  " ｜ 拍点对齐（" + how + "）" + (sn.delta * 1000).toFixed(0) + "ms（交叉 " + fadeSec.toFixed(2) +
                  "→" + newFade.toFixed(2) + "s）";
                fadeSec = newFade;
                bStart = endCtxTime - fadeSec;
              }
            }
          }
        }
        S.lastPlan = {
          aBpm: gA2 ? gA2.bpm : 0,
          bBpm: gB2 ? gB2.bpm : 0,
          tier: plan.tier,
          dev: plan.dev,
          conf: plan.conf,
          skip: skipInfo ? skipInfo.reason : "",
          tailWin: tailWin,
          headWin: headWin,
        };
        log(
          "[automix] A=" + (gA2 ? gA2.bpm.toFixed(1) + "bpm/置信" + gA2.conf.toFixed(2) : "无") +
            " B=" + (gB2 ? gB2.bpm.toFixed(1) + "bpm/置信" + gB2.conf.toFixed(2) : "无") +
            " → " + plan.tier + "（八度折算后偏差 " + (plan.dev * 100).toFixed(1) + "%）" +
            (tailWin !== "tail" ? " ｜ 尾窗=" + tailWin : "") +
            (headWin !== "head" ? " ｜ 头窗=" + headWin : "") + mixNote
        );
      }
    } catch (e) {
      log("[automix] ★ 拍点对齐失败（不影响播放）｜ " + (e && e.message));
    }

    // ★ v1.17.0：跳过交叉 → 只留 20ms 极短淡（B 从「结束−20ms」进）
    if (skipInfo) {
      fadeSec = 0.02;
      bStart = endCtxTime - fadeSec;
    }

    // ★ v1.14.0：这次过渡用什么曲线 —— 显式优先，否则按档位智能选
    var mixTier = (S.lastPlan && S.lastPlan.tier) || "plain";
    var curveNow = fadeSec > 0 ? xfadeCurveName(mixTier) : "equal";
    if (fadeSec > 0 && xfadeSmart() && !effectiveXfade().curveExplicit) {
      log("[automix] 智能曲线 → " + curveNow + "（" + mixTier + "）");
    }

    // ★ v1.5.1：B 的**入点** —— 用 B 自己的拍点选「从哪一拍进」，顺手跳过开头的空气声。
    //   只在有交叉时才有意义（没交叉就是 A 播完 B 从 0 开始，跳过头就成"吃歌"了）。
    // ★ v1.5.2：没有交叉（干净风格）时也做一件小事 —— 跳过 B 开头的**真静音**
    //   （只跳空白，不做拍点对齐：没有交叉就没有拍点关系，多吃一个整拍等于白吃歌）。
    var entry = { offset: btrim.start, skip: 0, reason: "未启用" };
    if (autoMixEnabled()) {
      try {
        entry =
          fadeSec > 0 && !skipInfo
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
        "[automix] B 入点 → " + entry.reason + (entry.onPhrase ? "（乐句头）" : "") + " ｜ 跳过 " + (entry.skip * 1000).toFixed(0) +
          "ms ｜ 起点=" + entry.offset.toFixed(2) + "s（缓冲）"
      );
    }

    // ★ v1.7.0（C）：能拉就拉 —— 只拉 B 的「交叉段」，拉完从原始缓冲接回
    var stretch = null;
    var stretchNote = "";
    try {
      if (fadeSec > 0 && autoMixEnabled() && !skipInfo) {
        var sp = stretchPlan(gA2, gB2, fadeSec);
        // ★ v1.8.2：和声门 —— 两边调性都可信但不搭（Camelot 规则）→ 这次不做变速贴拍
        if (sp && sp.ok && !keysCompatible(keyOf(gA2), keyOf(gB2))) {
          log("[automix] 和声不搭（" + (keyOf(gA2) ? keyOf(gA2).camelot : "?") + " × " + (keyOf(gB2) ? keyOf(gB2).camelot : "?") + "）→ 这次不做变速贴拍");
          sp = { ok: false, ratio: sp.ratio, reason: "和声不搭" };
        }
        if (sp && sp.ok && fadeSec <= STRETCH_MAX_SEC) {
          stretch = buildStretchedHead(buf, btrim, entry, sp, fadeSec);
          if (stretch) stretchNote = " ｜ 拉伸 " + ((sp.ratio - 1) * 100).toFixed(2) + "%";
        } else if (sp && !sp.ok) {
          logVerbose("[stretch] 不拉伸 ｜ " + sp.reason);
        }
      }
    } catch (e) {
      log("[stretch] ★ 拉伸失败（退回普通交叉）｜ " + (e && e.message));
      stretch = null;
    }

    // ★ 手写建 source —— **不能复用 `startSource()`**：它第 3 行无条件 `stopSource()`，会把正在播的 A 停掉。
    var src = S.ctx.createBufferSource();
    src.buffer = buf;
    // ★ v1.3.0/v1.3.2：B 走自己的 gain + 高通（交叉时在它身上做淡入）
    var chainB = newSourceChain();
    var gB = chainB.gain;
    if (gB) src.connect(gB);
    else src.connect(S.gain);
    // ★ v1.9.0：B 那一级的响度归一化按 B 自己的响度设（和 A 各归各的）
    try {
      setNorm(chainB.norm, nid, buf, "缓冲B");
    } catch (e) {}
    src.onended = function () {
      if (src === S.source) onNaturalEnd();
    };
    if (fadeSec > 0 && gB) {
      // 淡入：从 0 起，按当前曲线（默认等功率）到 1
      if (!scheduleFade(gB.gain, bStart, fadeSec, true, curveNow)) {
        restoreGain(gB, 1); // 曲线排不上就别淡了（宁可硬接）
      }
    }
    // ★ v1.7.0（C）：拉伸段先响（它就是「被拉过的 B 的前奏」），原始缓冲在交叉结束时接上
    var srcRest = src; // 接续那一段（默认就是同一个 source）
    var bStartRest = bStart;
    var bOffsetRest = entry.offset;
    var bPlayDurRest = bPlayDur;
    var restOffsetSec = entry.skip;
    var stretchedSrc = null;
    if (stretch) {
      stretchedSrc = S.ctx.createBufferSource();
      stretchedSrc.buffer = stretch.buffer;
      var chainS = newSourceChain();
      if (chainS.gain) stretchedSrc.connect(chainS.gain);
      else stretchedSrc.connect(S.gain);
      // ★ v1.9.0：拉伸段也是 B，响度归一化同样按 B 设
      try {
        setNorm(chainS.norm, nid, buf, "缓冲B拉伸");
      } catch (e) {}
      if (chainS.gain && fadeSec > 0) {
        if (!scheduleFade(chainS.gain.gain, bStart, fadeSec, true, curveNow)) restoreGain(chainS.gain, 1);
      }
      try {
        stretchedSrc.start(bStart, 0, stretch.outLen);
      } catch (e) {
        log("[stretch] ★ 拉伸段起播失败 → 只用原始缓冲 ｜ " + (e && e.message));
        stretch = null;
        stretchedSrc = null;
      }
      if (stretch) {
        // 原始缓冲：从「拉伸段消耗掉的位置」接着放，并在 20ms 内淡入（盖住接缝）
        bStartRest = bStart + stretch.outLen;
        bOffsetRest = entry.offset + stretch.consumed;
        bPlayDurRest = Math.max(0.02, bdur - entry.skip - stretch.consumed);
        restOffsetSec = entry.skip + stretch.consumed;
        if (gB && scheduleFade(gB.gain, bStartRest, 0.02, true)) {
          // 走的是 20ms 的短淡入
        } else if (gB) {
          restoreGain(gB, 1);
        }
      }
    }
    try {
      if (stretch) src.start(bStartRest, bOffsetRest, bPlayDurRest);
      else src.start(bStart, entry.offset, bPlayDur);
    } catch (e) {
      log("[sched] ★ start 失败 ｜ " + (e && e.name) + ": " + (e && e.message));
      try {
        src.disconnect();
      } catch (e2) {}
      try {
        if (stretchedSrc) stretchedSrc.disconnect();
      } catch (e3) {}
      return;
    }

    // ★ v1.3.0：A 的淡出（缓冲用 source 的 gain，流式用元素的 gain）
    var gA = null;
    if (fadeSec > 0) {
      var aNode = currentGainNode();
      if (aNode && aNode.gain) {
        if (scheduleFade(aNode.gain, bStart, fadeSec, false, curveNow)) gA = aNode;
        else log("[sched] ★ A 的淡出曲线没排上（交叉会变成硬切）");
      } else {
        log("[sched] ★ 找不到 A 的增益节点（交叉会变成硬切）");
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
      startOffset: restOffsetSec, // ★ v1.5.1/v1.7.0：交接那一刻 B 应该处的可听位置（拉伸段已消耗 headSrc）
      bufOffset: bOffsetRest, // ★ v1.5.1：缓冲时间轴上的起点（兜底节点重启时用）
      playDur: bPlayDurRest, // ★ v1.5.1：从入点起还能播多久
      trim: btrim,
      gain: gB, // ★ v1.3.0：B 的增益节点（交接后成为 S.srcGain）
      filter: chainB.filter, // ★ v1.3.2：B 的高通（交接后成为 S.srcFilter）
      fadeA: gA, // 被淡出的那一路（撤销时要复位）
      fadeB: gB && fadeSec > 0 ? gB : null,
      eqA: eqA, // 被扫频的那一路（撤销时要复位）
      xfade: fadeSec,
      stretchedSrc: stretchedSrc, // ★ v1.7.0：拉伸段（交接时它还可能在响，撤销时要一起停）
      stretchRatio: stretch ? stretch.ratio : 1, // ★ v1.7.0
      // ★ v1.7.0：有拉伸时，接续那一段是从「交叉结束」才开始播的
      startCtxTime: stretch ? bStartRest : bStart,
      endCtxTime: endCtxTime,
      phase: "armed",
      announced: false,
    };
    // ★ v1.9.2：A 提前收尾 —— 让 A 的 source 在 endCtxTime 就停（它的自然结束在更后面）。
    //   ⚠️ `stop()` 可以反复调（后一次覆盖前一次），所以撤销预约时能把结束时间改回去。
    if (earlyCut > 0 && !S.stream && S.source) {
      var naturalEndCtx = S.startCtxTime + (S.duration - S.startOffset);
      try {
        S.source.stop(endCtxTime);
        S.sched.earlyCut = earlyCut;
        S.sched.earlyStopSrc = S.source;
        S.sched.naturalEndCtx = naturalEndCtx;
        log(
          "[sched] ★ A 提前收尾 ｜ 少播 " + earlyCut.toFixed(2) + "s（原结束 at=" + naturalEndCtx.toFixed(3) +
            " → " + endCtxTime.toFixed(3) + "）"
        );
      } catch (e) {
        log("[sched] ★ 提前收尾没排上（A 的 stop 失败）｜ " + (e && e.message));
      }
    }
    // ★ v1.13.0：记下「这一次真实过渡」的样子（状态行 / 面板显示用，不参与调度）
    if (fadeSec > 0 || continuous) {
      try {
        var beatA = gA2 && gA2.bpm > 0 ? 60 / gA2.bpm : 0;
        S.lastMix = {
          trackA: S.curTrackId,
          trackB: nid,
          fadeSec: fadeSec,
          beats: beatA > 0 ? fadeSec / beatA : 0,
          tier: (S.lastPlan && S.lastPlan.tier) || "plain",
          aBpm: gA2 && gA2.bpm > 0 ? gA2.bpm : 0,
          bBpm: gB2 && gB2.bpm > 0 ? gB2.bpm : 0,
          earlyCut: earlyCut,
          stretchRatio: stretch && stretch.ratio ? stretch.ratio : 1,
          curve: curveNow,
          smart: xfadeSmart(),
          skip: !!skipInfo,
          skipReason: skipInfo ? skipInfo.reason : "",
          continuous: !!continuous,
          album: !!contAlbum,
          mode: continuous ? "continuous" : skipInfo ? "skip" : "cross",
          at: Date.now(),
        };
        // ★ v1.20.0：大卡的切歌动画要**当场**起，不等面板 1s 轮询
        try {
          refreshPanel();
        } catch (eR2) {}
      } catch (eL) {}
    }
    log(
      "[sched] " + (fadeSec > 0 ? "★ 交叉预约" : "预约") + " ｜ A=" + S.curTrackId + " → B=" + nid + " ｜ at=" +
        bStart.toFixed(3) + " ｜ 还剩 " + left.toFixed(2) + "s ｜ 结束 at=" + endCtxTime.toFixed(3) +
        " ｜ 模式=" + (mode || "seqStreak=" + S.seqStreak) +
        " ｜ 来源=" + (S.stream ? "流式" : "缓冲") +
        (entry.skip > 0.02 ? " ｜ B入点=+" + (entry.skip * 1000).toFixed(0) + "ms" : "") +
        " ｜ B裁剪=首" + (btrim.start * 1000).toFixed(1) + "ms 尾" + (btrim.end * 1000).toFixed(1) + "ms" +
        stretchNote +
        (fadeSec > 0
          ? " ｜ " + (skipInfo
              ? "交叉=跳过（20ms 极短淡，原因 " + skipReasonLabel(skipInfo) + "）"
              : "交叉=" + fadeSec.toFixed(2) + "s（曲线=" + curveNow + (eqA ? "+扫频" : "") + "）") +
            " ｜ 淡出 " + bStart.toFixed(2) + "→" + endCtxTime.toFixed(2)
          : continuous
            ? " ｜ 交接=连续母带（0s 接缝）"
            : " ｜ 交叉=关")
    );
  }

  /**
   * UI 的 `load` 到了，而这一首**已经在响**（我们提前排上的）→ 认领，**不重启**。
   * 真机时序：`load(B)` 在 `[end]` 之后约 +134ms 到达。
   */
  /**
   * ★ v1.7.1（结构性限制 #3）：**流式 B 也能交叉**。
   *
   * 流式 B 没有 `AudioBuffer`，做不了采样级调度；但它可以挂在一个**空闲的元素槽**上，
   * 和 A 各出一个声：A 的 gain 从 1 淡到 0、B 槽的 gain 从 0 淡到 1，两者都是
   * `AudioParam` 曲线 —— 时间精确到音频时钟，不需要「瞬间切换」。
   *
   * 细节（都是踩过的地方）：
   *   - B 槽在 bStart 之前必须**静音**（gain 先置 0），否则它会提前出声；
   *   - `play()` 不能排到未来，所以用 `setTimeout` 在 bStart 前 20ms 拉起 —— 交叉有几百毫秒到几秒，
   *     这点定时误差听不出来；
   *   - B 的 `currentTime` 置 0（从可听头开始），交给 gain 曲线淡入。
   */
  function scheduleStreamCrossfade(nid, left, endCtxTime, xf) {
    try {
      var slot = findPreopenSlot(nid);
      if (slot < 0) return;
      var s = slotAt(slot);
      if (!s || !s.el) return;
      if (Number(s.el.readyState) < 1) return; // 连 metadata 都没有 → 不冒险，走原路
      if (!s.gain || !s.gain.gain) return; // 没有独立增益就没法淡入
      // ★ v1.8.3：流式 B 没有解码缓冲 → 入点对不上（只能从 0 开始）。
      //   所以把交叉压短（≤3s），避免「A 淡完了 B 还在前奏里」听着像掉音量。
      var fadeSec = Math.min(xf, left - 0.05, 2);
      if (!(fadeSec >= 0.5)) return;
      var bStart = endCtxTime - fadeSec;
      var now = S.ctx.currentTime;
      if (bStart < now + 0.05) {
        bStart = now + 0.05;
        fadeSec = Math.max(0.3, endCtxTime - bStart);
      }

      // ① B 槽先静音（准备淡入）
      try {
        s.gain.gain.cancelScheduledValues(now);
        s.gain.gain.setValueAtTime(0, now);
      } catch (e) {}
      // ② A 淡出
      var gA = null;
      var aNode = currentGainNode();
      if (aNode && aNode.gain) {
        if (scheduleFade(aNode.gain, bStart, fadeSec, false)) gA = aNode;
      }
      // ③ B 淡入
      if (!scheduleFade(s.gain.gain, bStart, fadeSec, true)) restoreGain(s.gain, 0);
      // ④ 到点把元素拉起来（提前 20ms，让缓冲数据就位）
      var delay = Math.max(0, (bStart - now - 0.02) * 1000);
      var token = S.loadToken;
      setTimeout(function () {
        try {
          if (!S.sched || S.sched.streamSlot !== slot) return; // 已被撤销
          s.el.currentTime = 0;
          var pr = s.el.play();
          if (pr && pr.catch) pr.catch(function () {});
          log("[sched] ★ 流式 B 起播（槽#" + slot + "）");
        } catch (e) {
          log("[sched] ★ 流式 B 起播失败 ｜ " + (e && e.message));
        }
      }, delay);
      try {
        attachStreamEvents(token, -1);
      } catch (e) {}

      S.sched = {
        src: null,
        streamSlot: slot,
        trackId: nid,
        buffer: null,
        duration: 0, // 等 metadata / 认领时再填
        startOffset: 0,
        bufOffset: 0,
        playDur: 0,
        trim: null,
        gain: s.gain,
        filter: s.filter || null,
        fadeA: gA,
        fadeB: s.gain,
        eqA: null,
        xfade: fadeSec,
        startCtxTime: bStart,
        endCtxTime: endCtxTime,
        phase: "armed",
        announced: false,
      };
      log("[sched] ★ 流式 B 没有解码缓冲 → 入点无法对齐（只能从 0 开始），交叉压到 " + fadeSec.toFixed(2) + "s");
      log(
        "[sched] ★ 流式交叉预约 ｜ A=" + S.curTrackId + " → B=" + nid + " ｜ at=" + bStart.toFixed(3) +
          " ｜ 交叉=" + fadeSec.toFixed(2) + "s ｜ 槽#" + slot + "（B 没有解码缓冲，用元素做交叉）"
      );
    } catch (e) {
      log("[sched] ★ 流式交叉失败（退回原路）｜ " + (e && e.message));
    }
  }

  function claimSeamless(id, payload, trackId) {
    var sc = S.sched;
    var token = ++S.loadToken;
    // ★ v1.7.1（#3）：流式 B 的认领 —— 那一首已经在**元素槽**里响着了，别去碰 buffer
    if (sc.streamSlot !== undefined && sc.streamSlot !== null && sc.streamSlot >= 0) {
      bindActive(sc.streamSlot, sc.trackId); // ★ v1.9.0：按 B 自己的响度归一
      S.stream = true;
      S.buffer = null;
      S.source = null;
      S.trim = null;
      S.srcGain = null;
      S.srcFilter = null;
      S.mediaGain = S.el ? (activeSlot() || {}).gain || null : null;
      S.duration = Number(S.el && S.el.duration) || 0;
      S.startCtxTime = sc.startCtxTime;
      S.startOffset = 0;
      S.elToken = token;
      S.audioId = [id, id];
      S.ready = true;
      S.paused = false;
      S.pausedAt = 0;
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
      try {
        attachStreamEvents(token, -1);
      } catch (e) {}
      log("[sched] 认领（流式 B）｜ track=" + trackId + " ｜ 已在播（不重启）｜ duration=" + S.duration.toFixed(2) + "s");
      if (S.bootWindow) {
        log("[mem] 窗口内收到 load（track=" + trackId + "）→ 不写记忆（属于网易云的恢复流程）");
      } else {
        saveLastTrack(trackId, "加载");
        notePlayOrder(trackId);
      }
      emitLoad(0, "");
      emitProgress(true);
      maybePreload();
      return;
    }

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
      // ★ v1.9.0：顺手收下 volumeDelta（量纲 1e-4 dB，只当诊断备份，不施加）
      try {
        if (s) {
          var q = s.hMusic || s.mMusic || s.lMusic || s.bMusic || null;
          if (q && q.volumeDelta !== undefined && q.volumeDelta !== null) noteVolumeDelta(trackId, q.volumeDelta);
        }
      } catch (e) {}
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

  /**
   * ★ v1.8.5：320k 接口声明的字节数（trackId → size）。
   *
   * 拿它干什么：落盘前判断「这一份是不是完整文件」。
   * 以前只认 `song/detail` 的权威时长（`slot.trusted`）—— 那个接口一旦拿不到，
   * `trusted` 就永远是 false，于是**磁盘缓存一声不响地一行都不写**（真机日志 `磁盘=0 首`）。
   * 声明大小是同一份响应里就有的东西，比对字节数同样能挡住试听片段/半截文件，还不用多打一个请求。
   */
  var DECLARED_SIZE = {};

  function noteDeclaredSize(trackId, size) {
    try {
      var n = Number(size);
      if (!n || n <= 0) return;
      var keys = Object.keys(DECLARED_SIZE);
      if (keys.length > 800) DECLARED_SIZE = {}; // 防无限长（几百条也就几十 KB）
      DECLARED_SIZE[String(trackId)] = n;
    } catch (e) {}
  }

  function declaredSizeOf(trackId) {
    try {
      return DECLARED_SIZE[String(trackId)] || 0;
    } catch (e) {
      return 0;
    }
  }

  /* ==================== v1.9.0 · 响度平衡（按曲目归一化）==================== */

  /**
   * 为什么做：接缝再准，「一声大一声小」照样毁听感。
   *
   * 数据从哪来（已核实，**不用额外请求**）：
   *   `/api/song/enhance/player/url` 的响应本来就带 **`gain`（dB）** 与 **`peak`（线性峰值）**
   *   —— 就是 ReplayGain 那一套。本插件一直在打这个接口，以前只读了 br/size/url。
   *   ⚠️ 未授权 / 没给 url 时它们是 `gain:0.0 / peak:null`，所以必须**看出来到底有没有值**。
   *
   * 兜底（只当诊断，不施加）：`/api/song/detail` 里每首还有 `hMusic.volumeDelta`。
   *   实测量纲 = **1e-4 dB**（七首样本：热门流行 -5.0~-6.8 dB、卡拉扬贝九 +1.0~+2.4 dB、
   *   月光奏鸣曲首乐章 +20.7 dB；若按 1e-3 读就是 -276 dB 的荒唐值）。
   *   它不参与施加：与 `gain` 的参考电平未必一致，混用只会让响度更乱。
   *
   * 施加方式：每一路（缓冲 source / 流式元素）在「曲线增益」之后串一个**固定**归一化节点：
   *   src → gain(交叉曲线) → filter → **norm(本曲响度)** → S.gain(用户音量) → 输出
   *   这样淡入淡出那些曲线代码一行都不用改，A/B 各按自己的响度进曲线。
   *
   * 三道边界：
   *   ① 最多压 `__gpLoudCut` dB（默认 12）、最多提 `__gpLoudBoost` dB（默认 6）；
   *   ② **峰值保护**：要提音量时先算「到 -1 dBFS 还剩多少余量」，不够就不提；
   *      拿不到峰值（接口没给、也还没有缓冲）→ 干脆不提，宁小声也别爆音；
   *   ③ `window.__gpLoudness = false` 一键关掉。
   */
  var LOUD_TARGET_PEAK = 0.891; // ≈ -1 dBFS
  var LOUD_CUT_DEFAULT = 12;
  var LOUD_BOOST_DEFAULT = 6;

  var TRACK_LOUD = {}; // trackId -> { db, peak, src, delta }
  var LOUD_STAT = { url: 0, delta: 0, rms: 0, applied: 0, maxCut: 0, maxBoost: 0, dirty: true };
  var LOUD_PENDING = {}; // ★ v1.9.3：正在补数据的曲目（避免重复请求）

  function loudEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpLoudness === false) return false;
    } catch (e) {}
    return true;
  }

  function loudMaxCut() {
    try {
      var v = Number(typeof window !== "undefined" && window ? window.__gpLoudCut : NaN);
      if (isFinite(v) && v > 0) return v;
    } catch (e) {}
    return LOUD_CUT_DEFAULT;
  }

  function loudMaxBoost() {
    try {
      var v = Number(typeof window !== "undefined" && window ? window.__gpLoudBoost : NaN);
      if (isFinite(v) && v >= 0) return v;
    } catch (e) {}
    return LOUD_BOOST_DEFAULT;
  }

  /** 20·log10(x)；x<=0 → -Infinity */
  function db20(x) {
    return x > 0 ? (20 * Math.log(x)) / Math.LN10 : -Infinity;
  }

  /** 记下「接口给的响度增益」（权威来源：player/url 的 gain / peak） */
  function noteTrackGain(trackId, gainDb, peak) {
    try {
      if (trackId === null || trackId === undefined) return;
      // ⚠️ 字段**缺失**（undefined/null）和「真的是 0 dB」是两件事：
      //   前者是「这首歌没测量值」，后者是合法的「不用调」。不能把前者当成 0 —— 那会把参考拉歪。
      if (gainDb === null || gainDb === undefined) return;
      var g = Number(gainDb);
      if (!isFinite(g)) return;
      var id = String(trackId);
      var e = TRACK_LOUD[id] || (TRACK_LOUD[id] = { gainDb: NaN, deltaDb: NaN, peak: 0, src: "" });
      if (e.src !== "url") LOUD_STAT.url++;
      e.gainDb = g;
      e.src = "url";
      var pk = Number(peak);
      if (isFinite(pk) && pk > 0) e.peak = pk;
      LOUD_STAT.dirty = true;
    } catch (e) {}
  }

  /** 记下 song/detail 的 volumeDelta（量纲 1e-4 dB；`gain` 缺失时用它兜底） */
  function noteVolumeDelta(trackId, delta) {
    try {
      if (trackId === null || trackId === undefined) return;
      var d = Number(delta);
      if (!isFinite(d)) return;
      var id = String(trackId);
      var e = TRACK_LOUD[id] || (TRACK_LOUD[id] = { gainDb: NaN, deltaDb: NaN, peak: 0, src: "" });
      e.deltaDb = d / 10000; // → dB
      LOUD_STAT.delta++;
      LOUD_STAT.dirty = true;
    } catch (e) {}
  }

  /**
   * 这一首的「原始响度增益」（dB）。三个来源按优先级取：
   *   `gain`（player/url，带 peak）→ `volumeDelta`（song/detail，1e-4 dB）
   *   → **`rms`（直接从已解码缓冲量，不依赖任何接口）**。
   * 返回 NaN = 这一首还没有数据。
   */
  function loudRawDb(e) {
    if (!e) return NaN;
    if (isFinite(e.gainDb)) return e.gainDb;
    if (isFinite(e.deltaDb)) return e.deltaDb;
    if (isFinite(e.rmsDb)) return e.rmsDb;
    return NaN;
  }

  /** 这一首的数据来自哪个来源（对齐参考电平时要按来源分组） */
  function loudSrcOf(e) {
    if (!e) return "";
    if (isFinite(e.gainDb)) return "gainDb";
    if (isFinite(e.deltaDb)) return "deltaDb";
    if (isFinite(e.rmsDb)) return "rmsDb";
    return "";
  }

  function medianOf(arr) {
    if (!arr || !arr.length) return NaN;
    var a = arr.slice(0).sort(function (x, y) {
      return x - y;
    });
    var n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /**
   * ★ v1.9.3：**多来源对齐 + 相对参考**（这是上一版「完全用不了」的修法）。
   *
   * 上一版直接把接口给的 `gain` 当增益用：结果**只有少数歌拿到数据**（真机：一整晚只有 1 首
   * 拿到 `-12 dB`），那一首被压了 12 dB、其它歌原样 —— 于是响度差**更大**了。
   *
   * 正确做法：先算「本库参考」（所有已测曲目的中位数），只施加**相对参考的差值**：
   *   `applied_i = 已测增益_i − 参考`
   * 这样「所有歌被拉到同一响度」这件事依然成立（增益本身与原始响度成反比），
   * 但**整体音量不会掉一截**（中位数那一首正好不动）。
   *
   * 三个来源的参考电平各不相同（`gain` 是 ReplayGain 参考、`volumeDelta` 是客户端那套、
   * `rms` 是 dBFS），所以按来源分组，各自平移到锚点组的中位数，再统一算中位数。
   */
  function loudReference() {
    var ids = Object.keys(TRACK_LOUD);
    var groups = { gainDb: [], deltaDb: [], rmsDb: [] };
    for (var i = 0; i < ids.length; i++) {
      var e = TRACK_LOUD[ids[i]];
      var s = loudSrcOf(e);
      if (s) groups[s].push(loudRawDb(e));
    }
    var order = ["gainDb", "deltaDb", "rmsDb"];
    var anchor = NaN;
    var anchorKey = "";
    // 先从「有两个以上样本」的组里挑锚点（单样本的组不可比），再从任意非空组里挑
    for (var k1 = 0; k1 < order.length && !isFinite(anchor); k1++) {
      if (groups[order[k1]].length >= 2) {
        anchor = medianOf(groups[order[k1]]);
        anchorKey = order[k1];
      }
    }
    for (var k2 = 0; k2 < order.length && !isFinite(anchor); k2++) {
      if (groups[order[k2]].length >= 1) {
        anchor = medianOf(groups[order[k2]]);
        anchorKey = order[k2];
      }
    }
    if (!isFinite(anchor)) anchor = 0;

    var all = [];
    var shifts = {};
    for (var k3 = 0; k3 < order.length; k3++) {
      var key = order[k3];
      var g = groups[key];
      var m = medianOf(g);
      var sh = isFinite(m) ? anchor - m : 0;
      shifts[key] = sh;
      for (var j = 0; j < g.length; j++) all.push(g[j] + sh);
    }
    var ref = medianOf(all);
    if (!isFinite(ref)) ref = 0;
    return {
      ref: ref,
      anchor: anchor,
      anchorKey: anchorKey,
      shifts: shifts,
      nGain: groups.gainDb.length,
      nDelta: groups.deltaDb.length,
      nRms: groups.rmsDb.length,
      n: all.length,
    };
  }

  /** 当前生效的参考（`__gpLoudRef === "none"` 时退化成 0 = 直接用接口原始值） */
  function loudRefSwitchedOff() {
    try {
      if (typeof window !== "undefined" && window && window.__gpLoudRef === "none") return true;
    } catch (e) {}
    return false;
  }

  function loudRefMode() {
    return loudRefSwitchedOff() ? 0 : loudReference().ref;
  }

  /**
   * ★ v1.9.3：**没有任何数据的曲子也要有数据**。
   *   只在 `player/url` 里有 `gain`，而那条路上大部分响应并没有（真机一整晚只有 1 首拿到）。
   *   `song/detail` 里每首都有 `volumeDelta`，而且我们本来就在用它查权威时长 ——
   *   所以没数据时**在后台补一次**（`once` 去重、`S.durCache` 缓存，不会重复打请求）。
   */
  function loudEnsure(trackId) {
    try {
      if (!loudEnabled()) return;
      if (trackId === null || trackId === undefined) return;
      var e = TRACK_LOUD[String(trackId)];
      if (e && isFinite(loudRawDb(e))) return;
      if (LOUD_PENDING[String(trackId)]) return;
      LOUD_PENDING[String(trackId)] = true;
      resolveDurationMs(trackId)
        .catch(function () {
          return 0;
        })
        .then(function (dt) {
          delete LOUD_PENDING[String(trackId)];
          var got = isFinite(loudRawDb(TRACK_LOUD[String(trackId)]));
          logVerbose("[loud] 补数据 track=" + trackId + " ｜ 时长=" + (dt || "?") + " ｜ " +
            (got ? "拿到 volumeDelta" : "仍然没有"));
          // 补到了就立刻用在正在响的那一路上
          if (got) applyLoudNow(trackId, "补数据后");
        });
    } catch (e) {}
  }

  /**
   * ★ v1.9.3：**从已解码缓冲直接量响度**（不依赖任何接口）。
   *   `player/url` 的 `gain` 不是每首都带、`song/detail` 也可能被限流，
   *   但**缓冲就在手里** —— 算个 RMS 就能给出「这首有多响」的相对量。
   *   它不是 LUFS，但只要两首用同一种量法，差值就是可用的（我们只需要相对差）。
   * 返回 { rmsDb, peak }；拿不到给 null。
   */
  function bufferStats(buffer) {
    try {
      if (!buffer) return null;
      var ch = Math.min(2, buffer.numberOfChannels || 1);
      var n = buffer.length || 0;
      if (!(n > 1000)) return null;
      var stride = Math.max(1, Math.floor(n / 250000)); // 最多采 25 万个点，够准也够快
      var acc = 0;
      var cnt = 0;
      var peak = 0;
      for (var c = 0; c < ch; c++) {
        var d = buffer.getChannelData(c);
        if (!d) continue;
        for (var i = 0; i < n; i += stride) {
          var v = d[i];
          acc += v * v;
          cnt++;
          if (v < 0) v = -v;
          if (v > peak) peak = v;
        }
      }
      if (!cnt || !(acc > 0)) return { rmsDb: NaN, peak: peak };
      var rms = Math.sqrt(acc / cnt);
      return { rmsDb: db20(rms), peak: peak };
    } catch (e) {
      return null;
    }
  }

  /** 已解码缓冲的采样峰值（0 = 拿不到） */
  function peakOfBuffer(buffer) {
    var st = bufferStats(buffer);
    return st && isFinite(st.peak) ? st.peak : 0;
  }

  /**
   * 这一首该给多少 dB（已经过「相对参考」+ 峰值保护 + 上下限）。
   * `buffer` 在「没有接口数据」时用来现场量响度，也可用来取峰值（算一次就缓存）。
   */
  function loudDb(trackId, buffer) {
    if (!loudEnabled()) return 0;
    if (trackId === null || trackId === undefined) return 0;
    var id = String(trackId);
    var e = TRACK_LOUD[id];
    var raw = loudRawDb(e);
    if (!isFinite(raw) && buffer) {
      // ★ v1.9.3：接口没数据 → 直接量缓冲（立刻可用，不用等网络）
      var st = bufferStats(buffer);
      if (st && isFinite(st.rmsDb)) {
        if (!e) e = TRACK_LOUD[id] = { gainDb: NaN, deltaDb: NaN, rmsDb: NaN, peak: 0, src: "" };
        e.rmsDb = st.rmsDb;
        if (!(e.peak > 0) && st.peak > 0) e.peak = st.peak;
        raw = e.rmsDb;
        LOUD_STAT.rms++;
        logVerbose("[loud] 现场量 track=" + trackId + " ｜ RMS " + st.rmsDb.toFixed(1) + " dBFS ｜ 峰值 " + st.peak.toFixed(3));
      }
    }
    if (!isFinite(raw)) {
      loudEnsure(trackId); // 顺便后台补一次（补到了会 applyLoudNow）
      return 0;
    }
    var r = loudReference();
    // 绝对模式（__gpLoudRef="none"）下：不平移、不减参考，直接施加接口原始值
    var rel = loudRefSwitchedOff() ? 0 : r.ref;
    var shift = loudRefSwitchedOff() ? 0 : r.shifts[loudSrcOf(e)] || 0;
    var db = raw + shift - rel;
    if (!isFinite(db) || Math.abs(db) < 0.05) return 0;

    if (db > 0) {
      var pk = e.peak;
      if (!(pk > 0) && buffer) {
        pk = peakOfBuffer(buffer);
        if (pk > 0) e.peak = pk;
      }
      if (pk > 0) {
        var room = db20(LOUD_TARGET_PEAK / pk); // 到 -1 dBFS 还剩多少余量
        if (room < db) db = room;
      } else {
        db = 0; // 拿不到峰值就别提（宁小声不爆音）
      }
    }
    var cut = loudMaxCut();
    var boost = loudMaxBoost();
    if (db > boost) db = boost;
    if (db < -cut) db = -cut;
    return db;
  }

  /** 线性归一化增益（永远 > 0） */
  function loudGain(trackId, buffer) {
    var db = loudDb(trackId, buffer);
    if (!db) return 1;
    var g = Math.pow(10, db / 20);
    if (!isFinite(g) || g <= 0) return 1;
    return g;
  }

  /** 把归一化节点设成这一首的值（节点不存在就什么都不做） */
  function setNorm(node, trackId, buffer, why) {
    if (!node || !node.gain) return;
    var g = loudGain(trackId, buffer);
    try {
      node.gain.cancelScheduledValues(0);
      // ★ v1.9.3：数据可能是「播到一半才补上的」，这时要平滑过渡（直接跳会咔哒一声）
      var ramp = typeof node.gain.linearRampToValueAtTime === "function" && S.ctx ? 0.25 : 0;
      if (ramp > 0) {
        var t0 = S.ctx.currentTime;
        var cur = Number(node.gain.value);
        if (!isFinite(cur) || cur <= 0) cur = 1;
        node.gain.setValueAtTime(cur, t0);
        node.gain.linearRampToValueAtTime(g, t0 + ramp);
      } else {
        node.gain.value = g;
      }
    } catch (e) {}
    if (g !== 1) {
      LOUD_STAT.applied++;
      var db = db20(g);
      if (db < 0 && -db > LOUD_STAT.maxCut) LOUD_STAT.maxCut = -db;
      if (db > 0 && db > LOUD_STAT.maxBoost) LOUD_STAT.maxBoost = db;
      var ent = TRACK_LOUD[String(trackId)];
      var raw = ent ? loudRawDb(ent) : NaN;
      log(
        "[loud] 归一化 track=" + trackId + " ｜ " + (db > 0 ? "+" : "") + db.toFixed(1) + " dB" +
          " ｜ " + (why || "") +
          (isFinite(raw) ? " ｜ 原始 " + raw.toFixed(1) + " / 参考 " + loudRefMode().toFixed(1) : "") +
          (ent && ent.peak ? " ｜ 峰值 " + ent.peak.toFixed(3) : "")
      );
    }
  }

  /**
   * ★ v1.9.3：数据补上之后**立刻用到现在正在响的那一路**（否则第一遍听永远是没归一化的）。
   * 只在这一段确实是「当前曲目」时才动。
   */
  function applyLoudNow(trackId, why) {
    try {
      if (String(S.curTrackId) !== String(trackId)) return;
      if (!loudEnabled()) return;
      var g = loudGain(trackId, null);
      if (g === 1) return;
      setNorm(S.srcNorm, trackId, null, why || "补数据后（缓冲）");
      setNorm(S.mediaNorm, trackId, null, why || "补数据后（流式）");
    } catch (e) {}
  }

  function loudnessStats() {
    var ids = Object.keys(TRACK_LOUD);
    var nUrl = 0;
    var nDelta = 0;
    var nRms = 0;
    for (var i = 0; i < ids.length; i++) {
      var ent = TRACK_LOUD[ids[i]];
      var s = loudSrcOf(ent);
      if (s === "gainDb") nUrl++;
      else if (s === "deltaDb") nDelta++;
      else if (s === "rmsDb") nRms++;
    }
    var r = loudReference();
    return {
      enabled: loudEnabled(),
      mode: loudRefSwitchedOff() ? "absolute" : "relative", // ★ v1.9.3
      tracks: nUrl + nDelta + nRms, // 有数据的曲目数
      fromUrl: nUrl, // gain 来自 player/url
      fromDelta: nDelta, // volumeDelta（song/detail）
      fromRms: nRms, // ★ v1.9.3：现场从缓冲量的 RMS（不依赖接口）
      referenceDb: Number((r.ref || 0).toFixed(2)), // 当前参考（中位数）
      anchorSource: r.anchorKey || "", // 参考锚在哪个来源组上
      applied: LOUD_STAT.applied,
      maxCutDb: Number(LOUD_STAT.maxCut.toFixed(2)),
      maxBoostDb: Number(LOUD_STAT.maxBoost.toFixed(2)),
      cutLimitDb: loudMaxCut(),
      boostLimitDb: loudMaxBoost(),
    };
  }

  /** 单曲查详情（`gaplessPlayer.loudnessOf(id)`） */
  function loudnessOf(trackId) {
    var e = TRACK_LOUD[String(trackId)] || null;
    if (!e) return null;
    var raw = loudRawDb(e);
    var s = loudSrcOf(e);
    var r = loudReference();
    return {
      src: s === "gainDb" ? "url" : s === "deltaDb" ? "delta" : s === "rmsDb" ? "rms" : "",
      rawDb: isFinite(raw) ? Number(raw.toFixed(2)) : null,
      peak: e.peak,
      gainDb: isFinite(e.gainDb) ? e.gainDb : null,
      deltaDb: isFinite(e.deltaDb) ? Number(e.deltaDb.toFixed(2)) : null,
      rmsDb: isFinite(e.rmsDb) ? Number(e.rmsDb.toFixed(2)) : null,
      referenceDb: Number((loudRefSwitchedOff() ? 0 : r.ref).toFixed(2)),
      appliedDb: loudDb(trackId, null),
    };
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
      // ★ v1.8.5：声明大小记下来 —— 落盘前的完整性判据（见 noteDeclaredSize 的注释）
      noteDeclaredSize(trackId, d.size);
      // ★ v1.9.0：响度归一化（同一份响应里就有 gain/peak；没有就安静不动）
      noteTrackGain(trackId, d.gain, d.peak);
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

  /* ==================== v1.8.4 · 下载闸门（同一个时刻只跑一份大块下载）==================== */

  /**
   * 为什么要有它（真机日志 12:22:45 ~ 12:22:49，冷启动三路并发）：
   *
   *   45.607 [preload]  开始预载（下一首）        ← 6.5MB
   *   45.622 [prefetch] 提前抓「下下一首」的字节   ← 5.9MB
   *   46.665 [promote]  流式那首补成缓冲          ← 6.5MB
   *   49.502 [fetch] ★ 6.50 MB ｜ 3694ms          ← 6MB 走了 3.7 秒
   *
   * 同样一份 6MB 在空闲时只要 **337ms**（12:28:19.062）。三份同时跑 = 每份都慢 10 倍，
   * 而这三份里**只有「预载下一首」有截止时间**（A 播完之前必须解好），却被挤在最慢那档。
   *
   * 所以按优先级**串行**，一次只跑一份：
   *   pri 0 = 预载下一首（有截止时间，最高）
   *   pri 1 = 抓「下下一首」的字节（早一点好，但没人等它）
   *   pri 2 = 把流式那首补成缓冲（纯锦上添花，可以被抢）
   *
   * 抢占**只对 pri 2 开**：它在 100ms 心跳里每拍都会重试，掐断零代价；
   * pri 1 只排队、不抢占（正在下的那份掐了要从头再来，不划算）。
   *
   * ★ 两个「不许把队列堵死」的保险：
   *   ① 每个 job 有自己的 AbortController，**上游**（预载槽 / promote）掐断时转发进来 ——
   *      这样「作废 = 真的掐断在飞下载」这条老规矩在闸门里照样成立；
   *   ② 看门狗：某份传输 30s 没动静就掐掉它让后面先走（`fetch` 自己没有超时，
   *      一个卡死的连接会把整条队列一起卡住）。
   *
   * ⚠️ 闸门只串行「传输」，不串行「解码」：解码是 CPU 活，和下载重叠是赚的。
   */
  var DLQ = { running: null, q: [], seq: 0 };
  var DLQ_TIMEOUT_MS = 30000;

  function dlAbortError() {
    var e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  }

  /** 队列里最高的优先级（没有排队 → null） */
  function dlQueuedPri() {
    var best = null;
    for (var i = 0; i < DLQ.q.length; i++) {
      if (best === null || DLQ.q[i].pri < best) best = DLQ.q[i].pri;
    }
    return best;
  }

  /**
   * 把一份下载排进闸门。
   * @param pri      0 预载下一首 / 1 抓 N+2 的字节 / 2 流式补缓冲
   * @param name     日志里怎么称呼它
   * @param upstream 上游的 AbortSignal（可空）：它一断，闸门里这份也断
   * @param run      function(signal) → Promise。⚠️ 内部必须用传进来的 signal 去 fetch
   */
  function downloadGate(pri, name, upstream, run) {
    return new Promise(function (resolve, reject) {
      var own = null;
      try {
        if (typeof AbortController === "function") own = new AbortController();
      } catch (e) {
        own = null;
      }
      // 上游掐断 → 转发到闸门这一份
      if (own && upstream && typeof upstream.addEventListener === "function") {
        try {
          if (upstream.aborted) own.abort();
          else
            upstream.addEventListener(
              "abort",
              function () {
                try {
                  own.abort();
                } catch (e) {}
              },
              { once: true }
            );
        } catch (e) {}
      }
      var job = {
        pri: pri,
        name: name,
        run: run,
        own: own,
        sig: own ? own.signal : null,
        resolve: resolve,
        reject: reject,
        seq: ++DLQ.seq,
        timer: 0,
      };
      DLQ.q.push(job);
      if (DLQ.running) {
        log("[dl] ⏳ " + job.name + " 排队（优先级 " + pri + "，正在下的是 " + DLQ.running.name + "）");
      }
      pumpDownloads();
    });
  }

  function pumpDownloads() {
    if (DLQ.running) {
      var top = dlQueuedPri();
      // 只有「可以被抢」的那档（promote）才让位
      if (top !== null && top < DLQ.running.pri && DLQ.running.pri >= 2 && DLQ.running.own) {
        var victim = DLQ.running;
        log("[dl] ⏹ " + victim.name + " 让出带宽（优先级 " + victim.pri + "，前面来了 " + top + " 的活）");
        try {
          victim.own.abort();
        } catch (e) {}
      }
      return;
    }
    if (!DLQ.q.length) return;
    DLQ.q.sort(function (a, b) {
      return a.pri - b.pri || a.seq - b.seq;
    });
    var job = DLQ.q.shift();
    // 排队期间就被上游掐断的 → 直接丢掉，别占着闸门
    if (job.sig && job.sig.aborted) {
      job.reject(dlAbortError());
      pumpDownloads();
      return;
    }
    DLQ.running = job;
    job.startedAt = performance.now();
    // ★ 看门狗：卡住的传输不能把整条队列堵死。
    //   `fetch` 自己没有超时，取址那条链（LibEAPI）也没有 —— 所以这里不光「掐断」，
    //   还要**把闸门还回去**：只 abort 不放手的话，一个卡死的取址就能让后面的预载排队 30s。
    //   这一份被放弃的 run 之后就算自己回来了，结果也会被已 settled 的 promise 丢掉。
    job.timer = setTimeout(function () {
      if (DLQ.running !== job) return;
      // 计时器可能被提前触发（验证台的假时钟 / 系统休眠后的补发）→ 按真实耗时再判一次
      if (performance.now() - job.startedAt < DLQ_TIMEOUT_MS) return;
      log("[dl] ★ " + job.name + " 超过 " + DLQ_TIMEOUT_MS / 1000 + "s 没动静 → 放弃这一份，让后面先走");
      DLQ.running = null;
      try {
        if (job.own) job.own.abort();
      } catch (e) {}
      job.reject(new Error("下载超时（" + DLQ_TIMEOUT_MS / 1000 + "s）"));
      pumpDownloads();
    }, DLQ_TIMEOUT_MS);
    Promise.resolve()
      .then(function () {
        return job.run(job.sig);
      })
      .then(
        function (v) {
          if (DLQ.running === job) DLQ.running = null;
          try {
            clearTimeout(job.timer);
          } catch (e) {}
          job.resolve(v);
          pumpDownloads();
        },
        function (e) {
          if (DLQ.running === job) DLQ.running = null;
          try {
            clearTimeout(job.timer);
          } catch (e) {}
          job.reject(e);
          pumpDownloads();
        }
      );
  }

  /** 走闸门的 fetch（音频字节都从这里过；取址那类小请求不进闸门，别给关键路径加延迟） */
  function fetchBytesGated(url, upstream, pri, name) {
    return downloadGate(pri, name, upstream, function (sig) {
      return fetchBytes(url, sig);
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
  var BYTES_CACHE_MAX = 2; // ★ v1.8.0（#14）：3 → 2（省 ~8MB；丢掉的命中由 recentBufs 兜）
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
    // ★ v1.8.0（#16）：字节缓存**关掉**时，仍然留一份「只在内存里、不落盘、只留最近一首」的
    //   N+2 预热字节 —— 否则关掉缓存就失去「成为下一首时跳过取址 + 下载」这条捷径。
    if (!bytesCacheEnabled()) {
      putWarmBytes(trackId, buf);
      return;
    }
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

  /* ---- ★ v1.8.0（#16）：字节缓存关闭时的「单首预热字节」（只留最近一首） ---- */
  function putWarmBytes(trackId, buf) {
    try {
      if (!buf || typeof buf.slice !== "function") return;
      S.warmBytes = { trackId: trackId, buf: buf.slice(0) };
    } catch (e) {
      S.warmBytes = null;
    }
  }

  function getWarmBytes(trackId) {
    var w = S.warmBytes;
    if (!w || w.trackId !== trackId || !w.buf) return null;
    try {
      return w.buf.slice(0);
    } catch (e) {
      return null;
    }
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

  /** ★ v1.8.0（#14）：当前「解码缓冲」占了多少 MB（心跳里显示，方便发现内存异常） */
  function decodedMemMB() {
    var total = 0;
    try {
      if (S.buffer && S.buffer.length) total += S.buffer.length * (S.buffer.numberOfChannels || 1) * 4;
      if (S.preload && S.preload.buffer && S.preload.buffer.length) {
        total += S.preload.buffer.length * (S.preload.buffer.numberOfChannels || 1) * 4;
      }
      var list = S.recentBufs || [];
      for (var i = 0; i < list.length; i++) {
        var ab = list[i] && list[i].buffer;
        if (ab && ab.length) total += ab.length * (ab.numberOfChannels || 1) * 4;
      }
      var keys = 0;
      for (var k in BYTES_CACHE) if (Object.prototype.hasOwnProperty.call(BYTES_CACHE, k)) keys++;
      total += keys * 8 * 1024 * 1024; // 字节缓存按每首约 8MB 估
      if (S.warmBytes && S.warmBytes.buf) total += S.warmBytes.buf.byteLength || 0;
    } catch (e) {}
    return (total / 1048576).toFixed(0);
  }
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

  /* ==================== v1.8.4 · 磁盘字节缓存（清内存 / 重启都不再冷启动）==================== */

  /**
   * 为什么要有它：
   *   `BYTES_CACHE` / `recentBufs` / `warmBytes` **全在内存里** —— 面板上点一下「清空」、
   *   或者重启客户端，下一次预载就退化成完全冷路径。真机日志量得出来的账：
   *
   *     命中 recentBufs（解码缓冲）→ 0ms
   *     命中字节缓存（只剩解码）  → 704 / 710 / 781ms
   *     完全冷（取址+下载+解码）  → 1398ms（三路并发时 3330ms）
   *
   *   **解码那段（~700ms）省不掉**（Web Audio 不给流式 buffer 源），
   *   但取址 + 下载（~300ms，被挤时 3000ms）可以省 —— 把**压缩字节**存盘就行。
   *   `decodeAudioData` 出来的是 ~60MB 的 PCM，落盘不划算；压缩字节只有 5~7MB。
   *
   * 放哪儿：`C:\betterncm\gapless-cache\`（和日志、记忆文件同一个地方），
   *   用 `betterncm.fs`（本插件已经在用它写 `gapless-player.lasttrack.json`）。
   *
   * 四条安全约束（改这块代码前先读）：
   *   ① **只有「已经验过试听片段」的字节才落盘**。付费 / VIP 曲目的 320k 接口只给片段，
   *      存下来 = 下次直接播半首。所以落盘点在「预载就绪」之后，**不在**下载之后；
   *   ② **索引才是真相**：先写数据文件，写成功才记进 `index.json`。进程被杀 → 留下一个
   *      没人引用的孤儿文件（下次同名覆盖），不会出现「索引说有、读出来只有半截」；
   *   ③ 读回来**再对一次长度**（索引里记的 size），对不上 → 当它不存在并删掉；
   *   ④ 任何一步失败（没 fs API / 目录不可写 / 磁盘满）→ `DISK.broken`，本次会话不再碰盘，
   *      播放照旧。**磁盘缓存永远不是必需品。**
   *
   * 开关：`window.__gpDiskCache = false` 关掉 / `window.__gpDiskMB = 300` 容量 /
   *       `window.__gpDiskDir = "D:\\gp-cache"` 换目录。
   */
  var DISK_DIR_DEFAULT = "C:\\betterncm\\gapless-cache";
  var DISK_CAP_DEFAULT = 300 * 1024 * 1024; // 约 50 首 320k（每首 5~7MB）
  var DISK_ITEM_MAX = 600; // 条数上限（防止索引文件越滚越大）
  var DISK_FILE_MAX = 40 * 1024 * 1024; // 单首上限：超过就是不认识的音质，不占盘

  var DISK = {
    index: null,
    loading: null,
    broken: false,
    reason: "",
    hits: 0,
    writes: 0,
    skipped: 0,
    drop: 0,
    chain: null,
    pending: false,
  };

  function diskDir() {
    try {
      if (typeof window !== "undefined" && window && typeof window.__gpDiskDir === "string" && window.__gpDiskDir) {
        return window.__gpDiskDir;
      }
    } catch (e) {}
    return DISK_DIR_DEFAULT;
  }

  function diskIndexPath() {
    return diskDir() + "\\index.json";
  }

  function diskCapBytes() {
    try {
      if (typeof window !== "undefined" && window) {
        var m = Number(window.__gpDiskMB);
        if (m > 0) return m * 1024 * 1024;
      }
    } catch (e) {}
    return DISK_CAP_DEFAULT;
  }

  /** 磁盘缓存能不能用（要在**每次**用之前问，开关是运行时改的） */
  function diskEnabled() {
    if (!cacheEnabled()) return false; // 总开关 `__gpCache = false` 一关就全关
    if (DISK.broken) return false;
    try {
      if (typeof window !== "undefined" && window && window.__gpDiskCache === false) return false;
    } catch (e) {}
    try {
      var f = betterncm && betterncm.fs;
      // 少了任何一件都安静退化（2.10.x / 老版 BetterNCM 可能没有这几个）
      return !!(
        f &&
        typeof f.readFileText === "function" &&
        typeof f.writeFileText === "function" &&
        typeof f.readFile === "function" &&
        typeof f.writeFile === "function"
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * ★ v1.8.5：**为什么**不可用。
   * 真机踩过：日志里只有一句 `磁盘=0 首`，看不出是「关着」「写不进去」还是「一行都没写成功」。
   * 现在状态行 / 面板 / `diskStats()` 都能给出这句话。
   */
  function diskReason() {
    if (DISK.reason) return DISK.reason;
    if (!cacheEnabled()) return "总开关 __gpCache=false";
    if (DISK.broken) return "本次会话已判定不可用";
    try {
      if (typeof window !== "undefined" && window && window.__gpDiskCache === false) return "__gpDiskCache=false";
    } catch (e) {}
    var f = null;
    try {
      f = betterncm && betterncm.fs;
    } catch (e) {}
    if (!f) return "拿不到 betterncm.fs";
    var miss = [];
    if (typeof f.readFileText !== "function") miss.push("readFileText");
    if (typeof f.writeFileText !== "function") miss.push("writeFileText");
    if (typeof f.readFile !== "function") miss.push("readFile");
    if (typeof f.writeFile !== "function") miss.push("writeFile");
    if (miss.length) return "BetterNCM 的 fs 少了 " + miss.join("/");
    return "";
  }

  /**
   * ★ v1.8.5：给 fs 调用套超时。
   * `betterncm.fs` 背后是本机 HTTP，正常都是几十毫秒；但**万一它不回来**，
   * 落盘那条链会挂在那里 —— 不报错、不记日志、`磁盘=0 首`（真机遇到的就是这个形态）。
   * 超时之后我们会明说，并把它记成不可用，绝不让它拖住别的逻辑。
   */
  function diskWithTimeout(p, ms, what) {
    var t0 = performance.now();
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        // 计时器可能被提前触发（验证台的假时钟 / 系统休眠补发）→ 按真实耗时再判一次
        if (performance.now() - t0 < ms) return;
        done = true;
        reject(new Error(what + " 超时（" + ms + "ms 没返回）"));
      }, ms);
      Promise.resolve(p).then(
        function (v) {
          if (done) return;
          done = true;
          try {
            clearTimeout(t);
          } catch (e) {}
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          try {
            clearTimeout(t);
          } catch (e) {}
          reject(e);
        }
      );
    });
  }

  /**
   * ★ v1.8.5：开机自检 —— 真的写进去、读回来、删掉。
   *
   * 为什么值得多花这一次往返：磁盘缓存有四种「不可用」的形态（没 fs API / 目录不可写 /
   * 墙 / 返回 false），以前它们都只表现为**磁盘=0 首**，谁也不知道卡在哪。
   * 自检把结论写进日志第一屏，之后再看 `磁盘=K 首` 就知道是真在写。
   */
  function diskSelfTest() {
    if (!diskEnabled()) {
      log("[disk] 关闭 ｜ " + diskReason() + " ｜ 预载本身照常，只是清内存/重启后要重新下载");
      return Promise.resolve(false);
    }
    var path = diskDir() + "\\_selftest.tmp";
    var t0 = performance.now();
    return diskLoadIndex()
      .then(function () {
        if (betterncm.fs && typeof betterncm.fs.mkdir === "function") {
          return diskWithTimeout(betterncm.fs.mkdir(diskDir()), 4000, "mkdir").catch(function () {
            return false;
          });
        }
        return true;
      })
      .then(function () {
        return diskWithTimeout(betterncm.fs.writeFile(path, new Blob([new Uint8Array([7, 11, 13])])), 8000, "writeFile");
      })
      .then(function (okv) {
        if (okv === false) throw new Error("writeFile 返回 false");
        return diskWithTimeout(betterncm.fs.readFile(path), 5000, "readFile");
      })
      .then(toArrayBuffer)
      .then(function (b) {
        var u8 = b ? new Uint8Array(b) : null;
        if (!u8 || u8.length !== 3 || u8[0] !== 7 || u8[2] !== 13) {
          throw new Error("读回来对不上（" + (b ? b.byteLength : 0) + " 字节）");
        }
        try {
          if (betterncm.fs && typeof betterncm.fs.remove === "function") {
            Promise.resolve(betterncm.fs.remove(path)).catch(function () {});
          }
        } catch (e) {}
        log(
          "[disk] 自检 ★ 可写（" + (performance.now() - t0).toFixed(0) + "ms）｜ " + diskDir() +
            " ｜ 已有 " + diskCount() + " 首 / " + mb(diskBytes()) + " MB ｜ 上限 " + Math.round(diskCapBytes() / 1048576) + " MB"
        );
        return true;
      })
      .catch(function (e) {
        DISK.broken = true;
        DISK.reason = "开机自检失败：" + (e && e.message);
        log("[disk] ★ 自检失败 → 本次会话不用磁盘缓存（不影响播放）｜ " + (e && e.message));
        return false;
      });
  }

  /** 读索引（一次会话只读一次；读不到 / 坏了都当空，绝不抛） */
  function diskLoadIndex() {
    if (DISK.index) return Promise.resolve(DISK.index);
    // ⚠️ 不缓存这个空结果：开关是运行时改的，用户可能在控制台里再打开
    if (!diskEnabled()) return Promise.resolve({ v: 1, items: {} });
    if (DISK.loading) return DISK.loading;
    DISK.loading = Promise.resolve()
      .then(function () {
        return betterncm.fs.readFileText(diskIndexPath());
      })
      .then(function (txt) {
        var o = null;
        try {
          o = JSON.parse(String(txt || ""));
        } catch (e) {
          o = null;
        }
        var raw = (o && o.items) || {};
        var items = {};
        var n = 0;
        for (var k in raw) {
          if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
          var it = raw[k];
          // 形状不对的一律丢掉（索引被外部动过 / 老版本写的）
          if (!it || typeof it.size !== "number" || !(it.size > 0)) continue;
          items[k] = { f: String(it.f || ""), size: it.size, at: Number(it.at) || 0 };
          n++;
        }
        DISK.index = { v: 1, items: items };
        if (n) log("[disk] 读到索引 ｜ " + n + " 首 ｜ " + mb(diskBytes()) + " MB ｜ " + diskDir());
        return DISK.index;
      })
      .catch(function () {
        DISK.index = { v: 1, items: {} };
        return DISK.index;
      })
      .then(function (ix) {
        DISK.loading = null;
        return ix;
      });
    return DISK.loading;
  }

  /** 写索引（串行化：并发保存会互相覆盖；排队期间有新改动就再补一次，别丢更新） */
  function diskSaveIndex() {
    if (!diskEnabled()) return Promise.resolve(false);
    if (DISK.chain) {
      DISK.pending = true;
      return DISK.chain;
    }
    var txt = null;
    try {
      txt = JSON.stringify(DISK.index || { v: 1, items: {} });
    } catch (e) {
      return Promise.resolve(false);
    }
    DISK.pending = false;
    DISK.chain = Promise.resolve()
      .then(function () {
        return betterncm.fs.writeFileText(diskIndexPath(), txt);
      })
      .then(
        function (okv) {
          return !!okv;
        },
        function () {
          return false;
        }
      )
      .then(function (okv) {
        DISK.chain = null;
        if (DISK.pending) {
          DISK.pending = false;
          return diskSaveIndex(); // 保存期间又有改动 → 再写一遍
        }
        return okv;
      });
    return DISK.chain;
  }

  function diskBytes() {
    var ix = DISK.index;
    if (!ix || !ix.items) return 0;
    var total = 0;
    for (var k in ix.items) {
      if (Object.prototype.hasOwnProperty.call(ix.items, k)) total += ix.items[k].size || 0;
    }
    return total;
  }

  function diskCount() {
    var ix = DISK.index;
    if (!ix || !ix.items) return 0;
    var n = 0;
    for (var k in ix.items) {
      if (Object.prototype.hasOwnProperty.call(ix.items, k)) n++;
    }
    return n;
  }

  /** 盘上有没有这一首（只查索引；索引还没读起来就是 false） */
  function diskHas(trackId) {
    if (!diskEnabled()) return false;
    var ix = DISK.index;
    if (!ix || !ix.items) return false;
    var it = ix.items[String(trackId)];
    return !!(it && it.f);
  }

  /** 删掉一条（内存索引 + 数据文件）；`noSave` 用于批量清理时统一保存 */
  function diskDrop(trackId, noSave) {
    var ix = DISK.index;
    var id = String(trackId);
    var it = ix && ix.items ? ix.items[id] : null;
    if (!it) return;
    var f = it.f;
    delete ix.items[id];
    DISK.drop++;
    try {
      if (f && betterncm.fs && typeof betterncm.fs.remove === "function") {
        Promise.resolve(betterncm.fs.remove(f)).catch(function () {});
      }
    } catch (e) {}
    if (!noSave) diskSaveIndex();
  }

  /** 按容量 / 条数裁掉最旧的（LRU：`at` 是最后一次用它的时间） */
  function diskTrim() {
    var ix = DISK.index;
    if (!ix || !ix.items) return;
    var keys = [];
    for (var k in ix.items) {
      if (Object.prototype.hasOwnProperty.call(ix.items, k)) keys.push(k);
    }
    var total = diskBytes();
    keys.sort(function (a, b) {
      return (ix.items[a].at || 0) - (ix.items[b].at || 0);
    });
    var cap = diskCapBytes();
    while (keys.length && (total > cap || keys.length > DISK_ITEM_MAX)) {
      var k2 = keys.shift();
      total -= ix.items[k2].size || 0;
      log("[disk] 裁掉最旧的 ｜ track=" + k2 + " ｜ 剩余 " + keys.length + " 首 / " + mb(total) + " MB");
      diskDrop(k2, true);
    }
  }

  /** 从盘上取一首的字节；没命中 / 不可用都给 null（调用方接着走网络）
   *  ★ v1.11.0：`noTouch=true` 时**不刷新 LRU**（补算/诊断的维护性读取，不该延长旧字节寿命）。
   */
  function diskGetBytes(trackId, noTouch) {
    if (!diskEnabled()) return Promise.resolve(null);
    if (trackId === null || trackId === undefined) return Promise.resolve(null);
    var id = String(trackId);
    var t0 = performance.now();
    return diskLoadIndex()
      .then(function (ix) {
        var it = ix.items[id];
        if (!it || !it.f) return null;
        return Promise.resolve()
          .then(function () {
            // ★ v1.8.5：读也套超时 —— 卡住的读会连带把预载（闸门）一起拖住
            return diskWithTimeout(betterncm.fs.readFile(it.f), 6000, "readFile");
          })
          .then(toArrayBuffer)
          .then(function (buf) {
            if (!buf || !buf.byteLength) throw new Error("读出来是空的");
            if (buf.byteLength !== it.size) throw new Error("长度对不上（" + buf.byteLength + " ≠ " + it.size + "）");
            if (!noTouch) {
              it.at = Date.now(); // LRU：真在用的才刷新
              DISK.hits++;
              log(
                "[disk] ★ 命中（" + mb(buf.byteLength) + " MB，" + (performance.now() - t0).toFixed(0) +
                  "ms）→ 跳过取址 + 下载 ｜ track=" + id
              );
            } else {
              log(
                "[disk] 维护读取（不改 LRU）｜ " + mb(buf.byteLength) + " MB ｜ " +
                  (performance.now() - t0).toFixed(0) + "ms ｜ track=" + id
              );
            }
            return buf;
          });
      })
      .catch(function (e) {
        log("[disk] 这条读不出来 → 丢掉并走网络 ｜ track=" + id + " ｜ " + (e && e.message));
        diskDrop(id);
        return null;
      });
  }

  /**
   * 把一首的压缩字节落盘。**只应该在「已经验过试听片段」之后调**（见约束 ①）。
   * `buf` 不会被 decode 吞掉（调用方给的是字节缓存里的副本）。
   */
  function diskPutBytes(trackId, buf) {
    if (!diskEnabled()) return Promise.resolve(false);
    if (!buf || typeof buf.slice !== "function" || !buf.byteLength) return Promise.resolve(false);
    if (buf.byteLength > DISK_FILE_MAX) return Promise.resolve(false);
    if (trackId === null || trackId === undefined) return Promise.resolve(false);
    var id = String(trackId);
    var size = buf.byteLength;
    var t0 = performance.now();
    return diskLoadIndex().then(function (ix) {
      var old = ix.items[id];
      if (old && old.size === size) return false; // 盘上已经是同一份，不重复写
      var path = diskDir() + "\\" + id + ".mp3";
      return Promise.resolve()
        .then(function () {
          if (betterncm.fs && typeof betterncm.fs.mkdir === "function") {
            return diskWithTimeout(betterncm.fs.mkdir(diskDir()), 4000, "mkdir").catch(function () {
              return false;
            });
          }
          return true;
        })
        .then(function () {
          return diskWithTimeout(betterncm.fs.writeFile(path, new Blob([buf])), 15000, "writeFile");
        })
        .then(function (okv) {
          if (okv === false) throw new Error("writeFile 返回 false");
          // 数据文件写成功了才记进索引（约束 ②）
          ix.items[id] = { f: path, size: size, at: Date.now() };
          DISK.writes++;
          diskTrim();
          log(
            "[disk] 已落盘（" + mb(size) + " MB，" + (performance.now() - t0).toFixed(0) + "ms）｜ track=" +
              id + " ｜ 共 " + diskCount() + " 首 / " + mb(diskBytes()) + " MB"
          );
          diskSaveIndex();
          return true;
        })
        .catch(function (e) {
          DISK.broken = true; // 目录不可写 / 磁盘满 → 本次会话别再试了
          DISK.reason = "落盘失败：" + (e && e.message);
          log("[disk] ★ 落盘失败 → 本次会话不再写盘 ｜ " + (e && e.message));
          return false;
        });
    });
  }

  /**
   * 供落盘用的「不复制」取字节：从内存字节缓存（或单首预热槽）里拿。
   * ⚠️ 只读不改；`new Blob([buf])` 自己会复制一份，所以不会 detach 缓存里的这份。
   */
  function peekBytesForDisk(trackId) {
    var e = BYTES_CACHE[trackId];
    if (e && e.buf) return e.buf;
    var w = S.warmBytes;
    if (w && w.trackId === trackId && w.buf) return w.buf;
    return null;
  }

  function diskStats() {
    return {
      enabled: diskEnabled(),
      reason: diskEnabled() ? "" : diskReason(),
      count: diskCount(),
      bytes: diskBytes(),
      cap: diskCapBytes(),
      hits: DISK.hits,
      writes: DISK.writes,
      skipped: DISK.skipped,
      dir: diskDir(),
    };
  }

  /** 清空磁盘缓存（面板按钮 / 控制台 `gaplessPlayer.clearDiskCache()`） */
  function clearDiskCache() {
    var ix = DISK.index;
    var n = 0;
    if (ix && ix.items) {
      var ids = [];
      for (var k in ix.items) {
        if (Object.prototype.hasOwnProperty.call(ix.items, k)) ids.push(k);
      }
      for (var i = 0; i < ids.length; i++) {
        diskDrop(ids[i], true);
        n++;
      }
      ix.items = {};
    }
    log("[disk] 已清空磁盘缓存（" + n + " 首）｜ " + diskDir());
    diskSaveIndex();
    return n;
  }

  /* ==================== v1.10.0 · 拍点/能量离线缓存（P1）==================== */

  /**
   * 为什么需要它（v1.9.7 真机日志定位到的缺口）：
   *   交叉"固定 3 秒"不是没做拍点，而是**这一轮拿不到拍点** —— A 走 `<audio>` 流式
   *   就永远没有 AudioBuffer，`beatTail()` 拿到 null，`mixPlan()` 只能退 plain。
   *   但同一首歌在别的时刻（预载成 B、上上次播放）其实已经算过头窗/尾窗，结果只存在
   *   内存 `S.beatCache` 里：重启就没了；而且 `beatGridNear` 要求**先有 buffer 才肯查缓存**
   *   （`!ab → return null` 在读缓存之前）—— 等于白算。
   *
   * 做法：把"已经算出来的"结果按 trackId 落盘（一首约 400 字节），和音频缓存**完全解耦**：
   *   音频按 300MB 淘汰、缓冲只留 2 首，这份只按 2000 条淘汰最旧的。
   *   于是流式 A 下次再当当前曲时，直接读盘上的尾窗网格 → 量化 / 吸拍 / 变速全部生效。
   *
   * 存：头窗网格、尾窗网格、每秒能量（outro 掉点候选也要它）。
   * 不存：PCM（60MB 级）、onset 包络（只在分析那一次有用）。
   *
   * 四条约束（与磁盘字节缓存同款）：
   *   ① 版本号对不上 → 整批作废（算法改了，旧结果就是错的）；
   *   ② 时长对不上（试听片段 64s / 换音质）→ 这一条作废，重算；
   *   ③ 落盘失败只记一次日志，本次会话不再重试；播放照旧；
   *   ④ 任何异常都不许冒泡到播放链路。
   * 开关：`window.__gpAnalysis = false`（磁盘缓存 / 总开关关掉时一起关，目录都不碰）。
   */
  var ANALYSIS_V = 1;
  var ANALYSIS_MAX = 2000;
  var ANALYSIS_SAVE_DELAY = 2500;

  var ANALYSIS = {
    items: null, // trackId -> { dur, at, head?, tail?, energy?, w?, tried? }
    skip: null, // ★ v1.11.0：trackId -> { n, until, reason }（坏字节别每次开机重试）
    loaded: false,
    loading: null,
    chain: null,
    pending: false,
    timer: 0,
    broken: false,
    writes: 0,
    fails: 0,
  };

  function analysisEnabled() {
    // 和磁盘字节缓存共用一个目录、一套 fs 能力：用户关掉磁盘缓存就别再偷偷写
    if (!diskEnabled()) return false;
    if (ANALYSIS.broken) return false;
    try {
      if (typeof window !== "undefined" && window && window.__gpAnalysis === false) return false;
    } catch (e) {}
    return true;
  }

  /** ★ v1.15.0：面板显示用的原始开关（不受磁盘层影响） */
  function analysisRawEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpAnalysis === false) return false;
    } catch (e) {}
    return true;
  }

  function analysisPath() {
    return diskDir() + "\\analysis.json";
  }

  function analysisItems() {
    return ANALYSIS.items || (ANALYSIS.items = {});
  }

  /** 只留后续真正会用到的字段（PCM / onset 包络不进 JSON） */
  function slimGrid(g) {
    if (!g || !(g.bpm > 0)) return null;
    var o = {
      bpm: g.bpm,
      beatSec: g.beatSec,
      anchorSec: g.anchorSec,
      conf: g.conf,
      dur: g.dur,
      windowSec: g.windowSec,
    };
    if (g.endBeatSec !== undefined && g.endBeatSec !== null) o.endBeatSec = g.endBeatSec;
    if (g.key && typeof g.key === "object") {
      o.key = {
        pitchClass: g.key.pitchClass,
        minor: !!g.key.minor,
        conf: g.key.conf,
        camelot: g.key.camelot,
      };
    }
    return o;
  }

  /* base64：不依赖 btoa/atob（不同 webview 版本不一定有） */
  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function b64FromBytes(u8) {
    var out = "";
    for (var i = 0; i < u8.length; i += 3) {
      var a = u8[i];
      var b = i + 1 < u8.length ? u8[i + 1] : 0;
      var c = i + 2 < u8.length ? u8[i + 2] : 0;
      out += B64_CHARS.charAt(a >> 2);
      out += B64_CHARS.charAt(((a & 3) << 4) | (b >> 4));
      out += i + 1 < u8.length ? B64_CHARS.charAt(((b & 15) << 2) | (c >> 6)) : "=";
      out += i + 2 < u8.length ? B64_CHARS.charAt(c & 63) : "=";
    }
    return out;
  }
  function bytesFromB64(s) {
    var str = String(s || "");
    var out = [];
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === "=") break;
      var v = B64_CHARS.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
        buf = buf & ((1 << bits) - 1); // 只留没消费的位，别让 buf 无限左移
      }
    }
    try {
      return new Uint8Array(out);
    } catch (e) {
      return null;
    }
  }

  /** 把读回来的网格装填进内存缓存（**运行时算出来的优先**，不覆盖已有的） */
  function analysisSeedCache() {
    var c = beatCache();
    var items = analysisItems();
    var n = 0;
    for (var k in items) {
      if (!Object.prototype.hasOwnProperty.call(items, k)) continue;
      var r = items[k];
      var kh = k + "|head";
      var kt = k + "|tail";
      if (r.head && !Object.prototype.hasOwnProperty.call(c, kh)) {
        c[kh] = r.head;
        n++;
      }
      if (r.tail && !Object.prototype.hasOwnProperty.call(c, kt)) {
        c[kt] = r.tail;
        n++;
      }
    }
    return n;
  }

  /**
   * 读索引（一次会话只读一次）。读不到 / 坏了 / 版本不符都当空，**绝不抛**。
   * ⚠️ 与读盘并发时可能已经有新算出来的条目 → 在 `.then` 里按 trackId 合并，运行时优先。
   */
  function analysisLoadIndex() {
    if (ANALYSIS.loaded) return Promise.resolve(analysisItems());
    if (ANALYSIS.loading) return ANALYSIS.loading;
    if (!analysisEnabled()) return Promise.resolve(analysisItems());
    var path = analysisPath();
    var t0 = performance.now();
    ANALYSIS.loading = Promise.resolve()
      .then(function () {
        return diskWithTimeout(betterncm.fs.readFileText(path), 4000, "analysis.read");
      })
      .then(function (txt) {
        var o = null;
        try {
          o = JSON.parse(String(txt || ""));
        } catch (e) {
          o = null;
        }
        if (!o || !o.items || typeof o.items !== "object") return { items: {}, skip: {} };
        if (o.v !== ANALYSIS_V) {
          log("[analysis] 版本不符（盘上 v=" + String(o.v) + "，要 " + ANALYSIS_V + "）→ 整批作废重算");
          return { items: {}, skip: {} };
        }
        var out = {};
        var n = 0;
        for (var k in o.items) {
          if (!Object.prototype.hasOwnProperty.call(o.items, k)) continue;
          var raw = o.items[k];
          if (!raw || !(raw.dur > 0)) continue;
          var rec = { dur: Number(raw.dur) || 0, at: Number(raw.at) || 0, head: null, tail: null };
          rec.head = raw.head ? slimGrid(raw.head) : null;
          rec.tail = raw.tail ? slimGrid(raw.tail) : null;
          if (rec.head) rec.head.dur = rec.dur;
          if (rec.tail) rec.tail.dur = rec.dur;
          if (raw.energy) rec.energy = String(raw.energy);
          // ★ v1.11.0/v1.12.0：w = 参与融合的窗口数（1 = 单窗），tried = 补算时这一代的窗口数
          if (raw.w !== undefined) rec.w = Number(raw.w) || 0;
          if (raw.tried !== undefined) rec.tried = Number(raw.tried) || 0;
          if (rec.head || rec.tail || rec.energy || rec.tried) {
            out[k] = rec;
            n++;
          }
        }
        var skip = {};
        if (o.skip && typeof o.skip === "object") {
          for (var sk in o.skip) {
            if (!Object.prototype.hasOwnProperty.call(o.skip, sk)) continue;
            var sv = o.skip[sk];
            if (!sv || typeof sv !== "object") continue;
            skip[sk] = {
              n: Number(sv.n) || 0,
              until: Number(sv.until) || 0,
              reason: String(sv.reason || "").slice(0, 120),
            };
          }
        }
        log("[analysis] 读回离线分析 " + n + " 首（" + (performance.now() - t0).toFixed(0) + "ms）｜ " + path);
        return { items: out, skip: skip };
      })
      .catch(function (e) {
        log("[analysis] 读不到（首次运行 / 文件坏了）→ 当作空 ｜ " + (e && e.message));
        return { items: {}, skip: {} };
      })
      .then(function (out) {
        var loadedItems = (out && out.items) || {};
        var cur = ANALYSIS.items || {};
        for (var k in cur) {
          if (Object.prototype.hasOwnProperty.call(cur, k) && !loadedItems[k]) loadedItems[k] = cur[k];
        }
        var loadedSkip = (out && out.skip) || {};
        var curSkip = ANALYSIS.skip || {};
        for (var ks in curSkip) {
          if (Object.prototype.hasOwnProperty.call(curSkip, ks) && !loadedSkip[ks]) loadedSkip[ks] = curSkip[ks];
        }
        ANALYSIS.items = loadedItems;
        ANALYSIS.skip = loadedSkip;
        ANALYSIS.loaded = true;
        ANALYSIS.loading = null;
        var seeded = analysisSeedCache();
        if (seeded) log("[analysis] 已装填内存拍点缓存 " + seeded + " 份（流式 A 也能直接对齐）");
        return loadedItems;
      });
    return ANALYSIS.loading;
  }

  function analysisGet(trackId) {
    if (trackId === null || trackId === undefined) return null;
    return analysisItems()[String(trackId)] || null;
  }

  /** 流式 A：直接取落盘的能量曲线（outro 掉点候选也要它） */
  function analysisEnergy(trackId, dur) {
    var rec = analysisGet(trackId);
    if (!rec || !rec.energy) return null;
    if (dur > 0 && rec.dur > 0 && Math.abs(rec.dur - dur) > 0.75) return null;
    var u8 = bytesFromB64(rec.energy);
    if (!u8 || !u8.length) return null;
    ENERGY_PROFILE[trackId] = { buf: u8, dur: rec.dur, at: Date.now() };
    return u8;
  }

  /**
   * 把某首「内存里现有的头/尾网格」写进待落盘的记录。
   * 只在**刚刚算出**网格时调用（读缓存不重复写）。
   */
  function analysisNoteTrack(trackId, dur) {
    if (!analysisEnabled() || trackId === null || trackId === undefined || !(dur > 0)) return;
    analysisLoadIndex()
      .then(function (items) {
        var id = String(trackId);
        var rec = items[id] || (items[id] = { dur: dur, at: 0 });
        rec.dur = dur;
        rec.at = Date.now();
        var c = beatCache();
        var head = slimGrid(c[trackId + "|head"]);
        var tail = slimGrid(c[trackId + "|tail"]);
        if (head) rec.head = head;
        if (tail) rec.tail = tail;
        if (head || tail) {
          rec.w = 1; // ★ v1.11.0：在播分析 = 单窗（1.12.0 的补算会把它抬成 3）
          analysisScheduleSave();
        }
      })
      .catch(function () {});
  }

  /**
   * ★ v1.11.0：记下「这一代补算已经做过」。
   * `tried` 存的是**这一代的分析窗口数**（1.11.0 = 1，1.12.0 = 3）。
   * 以后换代只需要改 `ANALYSIS_W`，`analysisNeedsBackfill` 会自动把旧记录重新排进队列 ——
   * 不需要迁移脚本。
   * @param w     这条记录实际用上的窗口数（融合成功 = 3，失败/退化 = 1）
   * @param tried 这一代试过没有（默认 = w；退化时仍传 3，避免反复重试）
   */
  function analysisMarkBackfilled(trackId, dur, w, tried) {
    if (!analysisEnabled() || trackId === null || trackId === undefined || !(dur > 0)) return;
    var gen = Number(w) || 1;
    var triedGen = Number(tried) || gen;
    analysisLoadIndex()
      .then(function (items) {
        var id = String(trackId);
        var rec = items[id] || (items[id] = { dur: dur, at: 0 });
        rec.dur = dur;
        rec.at = Date.now();
        rec.w = gen;
        rec.tried = triedGen;
        // 顺手把内存里现有的网格一起写进记录（融合路径只 seed 缓存，不另外调 analysisNoteTrack）
        var c = beatCache();
        var gh = slimGrid(c[trackId + "|head"]);
        var gt = slimGrid(c[trackId + "|tail"]);
        if (gh) rec.head = gh;
        if (gt) rec.tail = gt;
        analysisSkipClear(id);
        analysisScheduleSave();
      })
      .catch(function () {});
  }

  function analysisNoteEnergy(trackId, dur, prof) {
    if (!analysisEnabled() || !prof || !(dur > 0) || trackId === null || trackId === undefined) return;
    var b64;
    try {
      b64 = b64FromBytes(prof);
    } catch (e) {
      return;
    }
    if (!b64) return;
    analysisLoadIndex()
      .then(function (items) {
        var id = String(trackId);
        var rec = items[id] || (items[id] = { dur: dur, at: 0 });
        rec.dur = dur;
        rec.at = Date.now();
        rec.energy = b64;
        analysisScheduleSave();
      })
      .catch(function () {});
  }

  /**
   * ★ v1.11.0：补算失败表 —— 坏字节 / 解码失败别每次开机重试同一首。
   * 同一首连续失败 2 次 → 7 天内不再补算；成功一次就清掉。
   */
  function analysisSkipMap() {
    return ANALYSIS.skip || (ANALYSIS.skip = {});
  }

  function analysisSkipBlocked(trackId) {
    var k = String(trackId);
    var s = analysisSkipMap()[k];
    if (!s) return false;
    if (s.until && Date.now() > s.until) {
      delete analysisSkipMap()[k];
      return false;
    }
    return true;
  }

  function analysisSkipPut(trackId, reason) {
    var m = analysisSkipMap();
    var k = String(trackId);
    var s = m[k] || { n: 0, until: 0, reason: "" };
    s.n = (s.n || 0) + 1;
    s.reason = String(reason || "").slice(0, 120);
    if (s.n >= 2 && !s.until) s.until = Date.now() + 7 * 24 * 3600 * 1000;
    m[k] = s;
    analysisScheduleSave();
    return s;
  }

  function analysisSkipClear(trackId) {
    var m = analysisSkipMap();
    var k = String(trackId);
    if (Object.prototype.hasOwnProperty.call(m, k)) {
      delete m[k];
      analysisScheduleSave();
    }
  }

  /** 只按条数淘汰最旧的（一首才几百字节，没必要按容量算） */
  function analysisTrim() {
    var items = analysisItems();
    var keys = [];
    for (var k in items) if (Object.prototype.hasOwnProperty.call(items, k)) keys.push(k);
    if (keys.length > ANALYSIS_MAX) {
      keys.sort(function (a, b) {
        return (items[a].at || 0) - (items[b].at || 0);
      });
      var drop = keys.length - ANALYSIS_MAX;
      for (var i = 0; i < drop; i++) delete items[keys[i]];
      log("[analysis] 条数超过 " + ANALYSIS_MAX + " → 丢掉最旧的 " + drop + " 首");
    }
    // ★ v1.11.0：skip 表也收口（先清过期，再按 500 条硬上限）
    var sk = analysisSkipMap();
    var now = Date.now();
    var skk = [];
    for (var s in sk) {
      if (!Object.prototype.hasOwnProperty.call(sk, s)) continue;
      var sv = sk[s];
      if (!sv) {
        delete sk[s];
        continue;
      }
      if (sv.until && now > sv.until) {
        delete sk[s];
        continue;
      }
      skk.push(s);
    }
    for (var j = 0; j < skk.length - 500; j++) delete sk[skk[j]];
  }

  function analysisScheduleSave() {
    if (!analysisEnabled()) return;
    if (ANALYSIS.timer) return;
    ANALYSIS.timer = setTimeout(function () {
      ANALYSIS.timer = 0;
      analysisSaveNow().catch(function () {});
    }, ANALYSIS_SAVE_DELAY);
  }

  /** 串行落盘：并发保存会互相覆盖，排队期间有新改动就再补一次（同 diskSaveIndex） */
  function analysisSaveNow() {
    if (!analysisEnabled()) return Promise.resolve(false);
    if (ANALYSIS.chain) {
      ANALYSIS.pending = true;
      return ANALYSIS.chain;
    }
    analysisTrim();
    var txt = null;
    try {
      txt = JSON.stringify({
        v: ANALYSIS_V,
        savedAt: Date.now(),
        items: analysisItems(),
        skip: ANALYSIS.skip || {}, // ★ v1.11.0
      });
    } catch (e) {
      txt = null;
    }
    if (!txt) return Promise.resolve(false);
    var path = analysisPath();
    ANALYSIS.pending = false;
    ANALYSIS.chain = Promise.resolve()
      .then(function () {
        if (betterncm.fs && typeof betterncm.fs.mkdir === "function") {
          return diskWithTimeout(betterncm.fs.mkdir(diskDir()), 4000, "analysis.mkdir").catch(function () {
            return false;
          });
        }
        return true;
      })
      .then(function () {
        return diskWithTimeout(betterncm.fs.writeFileText(path, txt), 6000, "analysis.write");
      })
      .then(function (okv) {
        if (okv === false) throw new Error("writeFileText 返回 false");
        ANALYSIS.writes++;
        log(
          "[analysis] 已落盘 ｜ " + Object.keys(analysisItems()).length + " 首 ｜ " + txt.length + " 字节 ｜ " + path
        );
        return true;
      })
      .catch(function (e) {
        ANALYSIS.fails++;
        ANALYSIS.broken = true;
        log("[analysis] ★ 落盘失败（不影响播放，本次会话不再重试）｜ " + (e && e.message));
        return false;
      })
      .then(function (okv) {
        ANALYSIS.chain = null;
        if (ANALYSIS.pending) {
          ANALYSIS.pending = false;
          return analysisSaveNow();
        }
        return okv;
      });
    return ANALYSIS.chain;
  }

  function analysisStats() {
    var items = analysisItems();
    var n = 0;
    for (var k in items) if (Object.prototype.hasOwnProperty.call(items, k)) n++;
    return {
      enabled: analysisEnabled(),
      loaded: ANALYSIS.loaded,
      count: n,
      // ★ v1.11.0：补算（P2）的可见指标
      pending: backfillPending(),
      skip: backfillSkipCount(),
      done: BACKFILL.done,
      failed: BACKFILL.fail,
      backfilling: BACKFILL.busy,
      safe: backfillSafeNow(),
      writes: ANALYSIS.writes,
      fails: ANALYSIS.fails,
      broken: !!ANALYSIS.broken,
      path: analysisPath(),
    };
  }

  /** ★ v1.15.0：清空分析记录（面板按钮 / 控制台 `gaplessPlayer.clearAnalysis()`） */
  function clearAnalysis() {
    var items = analysisItems();
    var n = 0;
    for (var k in items) if (Object.prototype.hasOwnProperty.call(items, k)) n++;
    ANALYSIS.items = {};
    ANALYSIS.skip = {};
    try {
      S.beatCache = {};
    } catch (e) {}
    analysisScheduleSave();
    analysisSaveNow().catch(function () {});
    log("[analysis] 已清空分析记录（" + n + " 首）");
    return n;
  }

  /* ==================== v1.17.0 · 置信度体检（audit）==================== */

  /** 置信度分布：中位数 + 4 个桶 */
  function confSummary(arr) {
    var out = { n: arr.length, p50: 0, p90: 0, lt01: 0, lt02: 0, lt045: 0, ge045: 0 };
    if (!arr.length) return out;
    var s = arr.slice().sort(function (a, b) {
      return a - b;
    });
    out.p50 = s[Math.floor(s.length * 0.5)];
    out.p90 = s[Math.floor(s.length * 0.9)];
    for (var i = 0; i < s.length; i++) {
      var v = s[i];
      if (v < 0.1) out.lt01++;
      else if (v < 0.2) out.lt02++;
      else if (v < 0.45) out.lt045++;
      else out.ge045++;
    }
    return out;
  }

  /** 头/尾两个网格是「一致 / 整数倍 / 真不一致」 */
  function octaveFit(h, t) {
    var rawDev = Math.abs(t.bpm - h.bpm) / h.bpm;
    if (rawDev <= 0.08) return { kind: "agree", dev: rawDev };
    var rs = [2, 3];
    for (var i = 0; i < rs.length; i++) {
      var R = rs[i];
      var up = Math.abs(t.bpm * R - h.bpm) / h.bpm;
      var down = Math.abs(t.bpm - h.bpm * R) / h.bpm;
      if (up <= 0.08 || down <= 0.08) return { kind: "octave", dev: Math.min(up, down) };
    }
    return { kind: "mismatch", dev: rawDev };
  }

  /** 读现有记录做统计（零成本） */
  function auditRecords() {
    var items = analysisItems();
    var out = {
      count: 0,
      head: [],
      tail: [],
      w: { w1: 0, w2: 0, w3: 0, other: 0 },
      octave: { agree: 0, octave: 0, mismatch: 0, oneSide: 0 },
      tier: { full: 0, smart: 0, plain: 0, skip: 0 },
      skipReasons: { "no-grid": 0, "low-conf": 0, "tempo-far": 0 },
      path: analysisPath(),
    };
    for (var k in items) {
      if (!Object.prototype.hasOwnProperty.call(items, k)) continue;
      out.count++;
      var r = items[k] || {};
      var h = r.head;
      var t = r.tail;
      if (h && h.bpm > 0) out.head.push(h.conf || 0);
      if (t && t.bpm > 0) out.tail.push(t.conf || 0);
      var w = Number(r.w || 1);
      if (w === 1) out.w.w1++;
      else if (w === 2) out.w.w2++;
      else if (w === 3) out.w.w3++;
      else out.w.other++;
      if (!h || !t || !(h.bpm > 0) || !(t.bpm > 0)) {
        out.octave.oneSide++;
        out.skipReasons["no-grid"]++;
        out.tier.skip++;
        continue;
      }
      var fit = octaveFit(h, t);
      out.octave[fit.kind]++;
      var conf = Math.min(h.conf || 0, t.conf || 0);
      var plan = {
        tier: conf >= 0.45 && fit.dev <= 0.06 ? "full" : conf >= 0.2 && fit.dev <= 0.06 ? "smart" : "plain",
        dev: fit.dev,
        conf: conf,
      };
      var sr = skipRule(plan, h, t);
      if (sr) {
        out.tier.skip++;
        out.skipReasons[sr.reason]++;
      } else {
        out.tier[plan.tier]++;
      }
    }
    out.headSummary = confSummary(out.head);
    out.tailSummary = confSummary(out.tail);
    delete out.head;
    delete out.tail;
    return out;
  }

  /** 重算：对盘上字节逐首解码、算头/中/尾三窗（串行，最多 30 首） */
  function auditRecompute(limit) {
    var max = Number(limit) > 0 ? Math.min(Number(limit), 50) : 30;
    return diskLoadIndex().then(function (ix) {
      var list = [];
      for (var k in ix.items) {
        if (!Object.prototype.hasOwnProperty.call(ix.items, k)) continue;
        list.push({ id: k, at: ix.items[k].at || 0 });
      }
      list.sort(function (a, b) {
        return b.at - a.at;
      });
      list = list.slice(0, max);
      var out = { n: list.length, ok: 0, fail: 0, fused: 0, tracks: [], head: [], mid: [], tail: [] };
      var chain = Promise.resolve();
      list.forEach(function (it) {
        chain = chain.then(function () {
          return diskGetBytes(it.id, true)
            .then(function (bytes) {
              if (!bytes) throw new Error("盘上读不到");
              var ctx = ensureCtx();
              if (!ctx) throw new Error("没有 AudioContext");
              return ctx.decodeAudioData(bytes);
            })
            .then(function (ab) {
              var dur = Number(ab.duration) || 0;
              if (!(dur > 0)) throw new Error("解码结果不可用");
              var head = analyzeBeats(ab, 0, Math.min(BEAT_WIN_SEC, dur));
              var midFrom = Math.max(0, dur / 2 - BEAT_WIN_SEC / 2);
              var mid = analyzeBeats(ab, midFrom, Math.min(BEAT_WIN_SEC, dur - midFrom));
              var tailFrom = BEAT_WIN_SEC + 2 <= dur ? dur - BEAT_WIN_SEC - 2 : 0;
              var tail = analyzeBeats(ab, tailFrom, Math.min(BEAT_WIN_SEC, dur - tailFrom));
              var fused = null;
              try {
                fused = fuseWindows([head, mid, tail]);
              } catch (eF) {
                fused = null;
              }
              out.tracks.push({
                id: it.id,
                head: head ? Math.round(head.conf * 100) / 100 : null,
                mid: mid ? Math.round(mid.conf * 100) / 100 : null,
                tail: tail ? Math.round(tail.conf * 100) / 100 : null,
                fused: fused ? Math.round(fused.conf * 100) / 100 : null,
              });
              if (head) out.head.push(head.conf);
              if (mid) out.mid.push(mid.conf);
              if (tail) out.tail.push(tail.conf);
              if (fused) out.fused++;
              out.ok++;
            })
            .catch(function () {
              out.fail++;
            });
        });
      });
      return chain.then(function () {
        out.summary = { head: confSummary(out.head), mid: confSummary(out.mid), tail: confSummary(out.tail) };
        delete out.head;
        delete out.mid;
        delete out.tail;
        return { records: auditRecords(), recompute: out };
      });
    });
  }

  /** ★ v1.17.0：体检入口（`audit()` 读记录；`audit(true)` 重算） */
  function auditConfidence(recompute, limit) {
    try {
      if (!recompute) return Promise.resolve(auditRecords());
      return auditRecompute(limit);
    } catch (e) {
      return Promise.resolve({ error: (e && e.message) || "audit 失败" });
    }
  }

  /* ==================== v1.11.0 · 补算（P2：把盘上没分析过的歌补出记录）==================== */

  /**
   * 为什么要有它（v1.10.0 留下的缺口）：
   *   分析记录只在「解码那一刻」产生 —— 预载成 B、正常加载 A、补缓冲。
   *   但盘上有字节不代表本次解码过：1.10.0 之前的旧字节、`预取`（N+2）抓了字节
   *   却还没轮到播的歌，都只有字节、没有记录。它们一旦以**流式 A** 身份被播到，
   *   交叉就只能退成固定 3 秒 —— 正是 P1 还没堵上的那个洞。
   *
   * 做法：空闲时一首一首地「读盘 → 解码 → 只分析 → 立刻丢弃解码缓冲」。
   *   不下载、不进 `recentBufs`、不进字节缓存 —— 补算只产出**分析记录**。
   *
   * 节奏（真机 17 首 / 107MB，约 700ms/首）：
   *   - 开机 15s 后才起步（避开预载/自检/首曲解码的启动风暴）；
   *   - 串行，每首之间让 2s；每会话最多 30 首；
   *   - 每个起跑点都要过安全门：没在交接（`S.sched` 空）、没有下载在飞、
   *     解码内存 <120MB、离当前曲结束 >15s。
   * 顺序：`at` 新→旧（最近进缓存的先补 —— 随机播放更可能再碰到它们）。
   * 读盘不刷新 LRU（维护性读取，不该让旧歌赖在盘上）。
   * 开关：`window.__gpBackfill = false`（默认开；`__gpAnalysis=false` 会连它一起关）。
   */
  var ANALYSIS_W = 3; // ★ v1.12.0：分析代数 = 3（多窗融合）。1.11.0 的单窗记录会自动重排进补算队列
  var BACKFILL_START_MS = 15000;
  var BACKFILL_GAP_MS = 2000;
  var BACKFILL_MAX = 30;
  var BACKFILL_MEM_MB = 120;
  var BACKFILL_NEAR_SEC = 15;

  var BACKFILL = {
    bootAt: 0,
    lastAt: 0,
    done: 0,
    fail: 0,
    busy: null,
    drained: false,
  };

  function backfillEnabled() {
    if (!analysisEnabled()) return false;
    if (passAllToNative()) return false; // ★ v1.13.0：插件停用 → 后台补算也停
    try {
      if (typeof window !== "undefined" && window && window.__gpBackfill === false) return false;
    } catch (e) {}
    return true;
  }

  /** ★ v1.15.0：面板显示用的原始开关 */
  function backfillRawEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpBackfill === false) return false;
    } catch (e) {}
    return true;
  }

  function numKnob(name, def) {
    try {
      var v = window && window[name];
      if (typeof v === "number" && isFinite(v) && v >= 0) return v;
    } catch (e) {}
    return def;
  }

  function backfillStartMs() {
    return numKnob("__gpBackfillDelay", BACKFILL_START_MS);
  }
  function backfillGapMs() {
    return numKnob("__gpBackfillGap", BACKFILL_GAP_MS);
  }
  function backfillMax() {
    return numKnob("__gpBackfillMax", BACKFILL_MAX);
  }

  /**
   * 这一代分析够不够？1.11.0：缺记录 / 缺 head / 缺 tail / 缺 energy → 要补。
   * ★ 1.12.0 会把这里改成「w < 3 也要补」（单窗记录升级成融合版）—— 见 v1.12.0 注释。
   */
  function analysisNeedsBackfill(rec) {
    if (!rec) return true;
    if ((rec.tried || 0) >= ANALYSIS_W) return false; // 这一代已经试过（可能真没拍）
    if (!(rec.head && rec.tail && rec.energy)) return true; // 半成品：缺网格/缺能量
    if ((rec.w || 0) >= ANALYSIS_W) return false; // 完整且已是这一代
    return true; // 完整但代数不够 → 升级（1.12.0 起：w:1 → w:3）
  }

  /** 现在能不能开始一首（安全门） */
  function backfillSafeNow() {
    try {
      if (!S.ready) return true; // 没在播 = 最安全
      if (S.sched) return false; // 下一首已排好 / 交接中，别抢
      if (DLQ.running) return false; // 有下载在飞
      if (Number(decodedMemMB()) > BACKFILL_MEM_MB) return false;
      if (!S.paused) {
        var left = 0;
        if (S.stream) {
          if (S.el && isFinite(S.el.duration)) left = Number(S.el.duration) - Number(S.el.currentTime);
        } else if (S.duration > 0) {
          left = S.duration - position();
        }
        if (left > 0 && left < BACKFILL_NEAR_SEC) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function backfillSkipCount() {
    var m = analysisSkipMap();
    var n = 0;
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) n++;
    return n;
  }

  /** 队列里还有多少首（只数「盘上有字节」的） */
  function backfillPending() {
    var ix = DISK.index;
    if (!ix || !ix.items) return 0;
    var n = 0;
    for (var k in ix.items) {
      if (!Object.prototype.hasOwnProperty.call(ix.items, k)) continue;
      if (analysisSkipBlocked(k)) continue;
      if (!analysisNeedsBackfill(analysisGet(k))) continue;
      n++;
    }
    return n;
  }

  /** 按 `at` 新→旧挑一首（同时间按 trackId 稳定排序） */
  function backfillPick() {
    var ix = DISK.index;
    if (!ix || !ix.items) return null;
    var ids = [];
    for (var k in ix.items) {
      if (!Object.prototype.hasOwnProperty.call(ix.items, k)) continue;
      ids.push({ id: k, at: ix.items[k].at || 0 });
    }
    ids.sort(function (a, b) {
      if (b.at !== a.at) return b.at - a.at;
      return Number(a.id) - Number(b.id);
    });
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i].id;
      if (analysisSkipBlocked(id)) continue;
      if (!analysisNeedsBackfill(analysisGet(id))) continue;
      return id;
    }
    return null;
  }

  /* ---- ★ v1.12.0：多窗融合（P3）---- */

  /**
   * 为什么要它：置信低有两大来源 ——「素材本来没拍」和「测到了错的倍速」；
   * 单窗还有个更常见的问题：某一窗正好落在 breakdown / 自由节奏前奏上。
   * 做法：头 / 中点 / 尾三个窗各算一次，用「八度折算后的中位数 + 一致比例」合成：
   *   - 中位数天然免疫单个离谱值；
   *   - 一致比例要求 ≥2/3（3 窗）/ =1（2 窗），否则宁可不融合；
   *   - **锚点/末拍仍取自各自窗口**（相位不能投票得到）。
   * 只在补算里做 —— 在播路径（起播时）多算两窗会把切歌拖慢半拍。
   */
  var FUSE_TOL = 0.02; // 「一致」的容差：中位数 ±2%
  var FUSE_MIN_FRAC_3 = 0.66;
  var FUSE_CONF_BONUS = 0.25;

  /** 把 bpm 按 0.5/1/2 折到离 ref 最近的那个拍级 */
  function foldToRef(bpm, ref) {
    var best = bpm;
    var bestDev = Infinity;
    var fs = [0.5, 1, 2];
    for (var i = 0; i < fs.length; i++) {
      var v = bpm * fs[i];
      var d = Math.abs(v - ref);
      if (d < bestDev) {
        bestDev = d;
        best = v;
      }
    }
    return best;
  }

  /** @returns {bpm, conf, agreeFrac, windows} 或 null（各窗不一致 → 不融合） */
  function fuseWindows(list) {
    var usable = [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (g && g.bpm > 0) usable.push(g);
    }
    if (usable.length < 2) return null;
    // 参考取头窗（B 的入口用它）——但头窗置信太低（半残前奏/自由节奏）时改取置信最高的一窗
    var ref = 0;
    if (list && list[0] && list[0].bpm > 0 && (list[0].conf || 0) >= 0.2) ref = list[0].bpm;
    if (!(ref > 0)) {
      var bestConf = -1;
      for (var j = 0; j < usable.length; j++) {
        if ((usable[j].conf || 0) > bestConf) {
          bestConf = usable[j].conf || 0;
          ref = usable[j].bpm;
        }
      }
    }
    var folded = [];
    for (var k = 0; k < usable.length; k++) {
      folded.push({ g: usable[k], bpm: foldToRef(usable[k].bpm, ref) });
    }
    var bpms = folded
      .map(function (x) {
        return x.bpm;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var median = bpms[Math.floor(bpms.length / 2)];
    if (!(median > 0)) return null;
    var agree = 0;
    for (var m = 0; m < folded.length; m++) {
      if (Math.abs(folded[m].bpm - median) / median <= FUSE_TOL) agree++;
    }
    var frac = agree / folded.length;
    var need = folded.length >= 3 ? FUSE_MIN_FRAC_3 : 1;
    if (frac < need) return null;
    var confs = folded
      .map(function (x) {
        return x.g.conf || 0;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var medConf = confs[Math.floor(confs.length / 2)];
    var conf = Math.min(1, medConf + FUSE_CONF_BONUS * frac);
    return { bpm: median, conf: conf, agreeFrac: frac, windows: folded.length };
  }

  /** 用融合结论覆盖 bpm/beatSec/conf，锚点仍来自这个窗口自己 */
  /**
   * 用融合结论生成一侧网格（head 或 tail）。
   *
   * ⚠️ 相位不能投票：只有「本窗 BPM 与融合值同拍级（八度折算后 ≈ 融合值）」的窗口，
   *    它的锚点才可信。所以挑一个**相位可信且离目标位置最近**的窗口，用融合 BPM 外推：
   *    - head：目标 0s（取最早的窗口，向前/向后外推到 0 附近最近一拍）；
   *    - tail：目标 dur-0.2s（取最晚的窗口，外推成末拍）。
   * 这样「头窗测歪 / 尾窗测歪」时，相位仍能借用另一窗 + 融合速度外推出来。
   */
  function buildFusedSide(list, fused, dur, side) {
    var beat = 60 / fused.bpm;
    var target = side === "head" ? 0 : Math.max(0, dur - 0.2);
    var order = [];
    for (var i = 0; i < list.length; i++) order.push(i);
    if (side === "tail") order.reverse();
    var src = null;
    for (var j = 0; j < order.length; j++) {
      var g = list[order[j]];
      if (!g || !(g.bpm > 0)) continue;
      var folded = foldToRef(g.bpm, fused.bpm);
      if (Math.abs(folded - fused.bpm) / fused.bpm > FUSE_TOL) continue; // 这一窗相位不可信
      src = g;
      break;
    }
    if (!src) return null;
    var anchor = src.anchorSec + Math.round((target - src.anchorSec) / beat) * beat;
    if (side === "head" && anchor < 0) anchor += beat;
    var o = {
      bpm: fused.bpm,
      beatSec: beat,
      anchorSec: anchor,
      conf: fused.conf,
      dur: dur,
    };
    if (side === "head" && list[0] && list[0].key) o.key = list[0].key; // 调性仍取头窗
    if (side === "tail") o.endBeatSec = anchor;
    return o;
  }

  /**
   * 补算用：三个窗各算一次 → 融合 → 写进内存缓存（记录由 analysisMarkBackfilled 落盘）。
   * @returns {w:3|1, fused, agreeFrac, head, tail}
   */
  function analysisFuseTrack(trackId, ab, dur) {
    var win = BEAT_WIN_SEC;
    var head = null;
    var mid = null;
    var tail = null;
    try {
      head = analyzeBeats(ab, 0, Math.min(win, dur));
    } catch (eH) {
      head = null;
    }
    var midFrom = Math.max(0, Math.min(dur - 1, dur / 2 - win / 2));
    try {
      mid = analyzeBeats(ab, midFrom, Math.min(win, dur - midFrom));
    } catch (eM) {
      mid = null;
    }
    var tailFrom = win + 2 <= dur ? dur - win - 2 : 0;
    try {
      tail = analyzeBeats(ab, tailFrom, Math.min(win, dur - tailFrom));
    } catch (eT) {
      tail = null;
    }

    if (head) {
      try {
        head.key = detectKey(ab, 0, Math.min(KEY_WINDOW_SEC, dur));
      } catch (eK) {
        head.key = null;
      }
    }

    var fused = null;
    try {
      fused = fuseWindows([head, mid, tail]);
    } catch (eF) {
      fused = null;
    }

    var outHead = null;
    var outTail = null;
    if (fused) {
      outHead = buildFusedSide([head, mid, tail], fused, dur, "head");
      outTail = buildFusedSide([head, mid, tail], fused, dur, "tail");
    } else {
      // 不融合：退回 P2 的单窗口径（尾窗末拍按它自己的拍长算）
      outHead = head;
      outTail = tail;
      if (outTail && outTail.bpm > 0) {
        var tb = outTail.beatSec;
        var tt = Math.max(0, dur - 0.2);
        outTail.endBeatSec = outTail.anchorSec + Math.round((tt - outTail.anchorSec) / tb) * tb;
      }
    }
    var c = beatCache();
    c[trackId + "|head"] = outHead || null;
    c[trackId + "|tail"] = outTail || null;

    return {
      w: fused ? 3 : 1,
      fused: !!fused,
      agreeFrac: fused ? fused.agreeFrac : 0,
      head: outHead,
      tail: outTail,
    };
  }

  /** 定时器每拍调一次；真正的「读盘→解码→分析」在 backfillStep 里 */
  function maybeBackfill() {
    if (!backfillEnabled()) return;
    if (BACKFILL.busy) return;
    if (!BACKFILL.bootAt) BACKFILL.bootAt = Date.now();
    var now = Date.now();
    if (now - BACKFILL.bootAt < backfillStartMs()) return;
    if (BACKFILL.done + BACKFILL.fail >= backfillMax()) return;
    if (BACKFILL.lastAt && now - BACKFILL.lastAt < backfillGapMs()) return;
    if (!backfillSafeNow()) return;
    BACKFILL.lastAt = now;
    backfillStep();
  }

  /** 补一首（也可以人工/验证台直接调） */
  function backfillStep() {
    if (!backfillEnabled()) return Promise.resolve(false);
    if (BACKFILL.busy) return Promise.resolve(false);
    return diskLoadIndex()
      .then(function () {
        var id = backfillPick();
        if (id === null) {
          if (!BACKFILL.drained) {
            BACKFILL.drained = true;
            log(
              "[backfill] 队列已空 ｜ 本会话补算 " + BACKFILL.done + " 首 ｜ 跳过 " +
                backfillSkipCount() + " 首"
            );
          }
          return false;
        }
        BACKFILL.busy = id;
        BACKFILL.drained = false;
        var left = backfillPending();
        log("[backfill] 开始 ｜ track=" + id + " ｜ 队列还剩 " + left + " 首");
        var t0 = performance.now();
        return diskGetBytes(id, true) // ★ noTouch：维护性读取，不刷新 LRU
          .then(function (bytes) {
            if (!bytes) throw new Error("盘上读不到");
            var ctx = ensureCtx();
            if (!ctx) throw new Error("没有 AudioContext");
            return ctx.decodeAudioData(bytes);
          })
          .then(function (ab) {
            if (!ab || !(ab.duration > 0)) throw new Error("解码结果不可用");
            var dur = Number(ab.duration) || 0;
            // ★ v1.12.0：三窗融合（失败就退回 P2 的单窗，行为不变）
            var fused = null;
            if (ANALYSIS_W >= 3) {
              try {
                fused = analysisFuseTrack(id, ab, dur);
              } catch (eF) {
                log("[fusion] ★ 融合失败（退回单窗）｜ track=" + id + " ｜ " + (eF && eF.message));
                fused = null;
              }
            }
            if (!fused) {
              beatHead(id, ab);
              beatTail(id, ab);
            }
            try {
              buildEnergyProfile(id, dur);
            } catch (eE) {}
            var w = fused ? fused.w : 1;
            analysisMarkBackfilled(id, dur, w, ANALYSIS_W);
            BACKFILL.done++;
            log(
              "[backfill] 完成 ｜ track=" + id + " ｜ " + dur.toFixed(1) + "s ｜ " +
                (fused
                  ? fused.fused
                    ? "融合 3 窗（一致 " + Math.round(fused.agreeFrac * 100) + "%）"
                    : "单窗（各窗不一致，不硬融）"
                  : "单窗") +
                " ｜ " + (performance.now() - t0).toFixed(0) + "ms ｜ 本会话 " + BACKFILL.done + " 首"
            );
            return true;
          })
          .catch(function (e) {
            BACKFILL.fail++;
            analysisSkipPut(id, (e && e.message) || "未知错误");
            log("[backfill] ★ 失败 ｜ track=" + id + " ｜ " + (e && e.message));
            return false;
          })
          .then(function (okv) {
            BACKFILL.busy = null;
            analysisScheduleSave(); // 防抖落盘（2.5s 内多次完成只写一次）
            return okv;
          });
      })
      .catch(function (e) {
        BACKFILL.busy = null;
        log("[backfill] ★ 队列失败 ｜ " + (e && e.message));
        return false;
      });
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
  /** ★ v1.8.5：剩不到这么长就别补了（补出来的缓冲用不上，还白占 60MB + 一次下载） */
  var PROMOTE_MIN_LEFT = 20;

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
  function fetchDecoded(trackId, signal, abort) {
    var ginfo = null;
    var fromDisk = false;
    var trusted = false;
    var diskHandle = null;
    var cached = cacheGetBytes(trackId) || getWarmBytes(trackId); // ★ v1.8.0（#16）
    var p = cached
      ? Promise.resolve(cached)
      : diskGetBytes(trackId).then(function (db) {
          // ★ v1.8.4：盘上有就直接用（重启之后「补成缓冲」也不用再下一遍）
          if (db) {
            fromDisk = true;
            return db;
          }
          return resolveUrl(trackId)
            .catch(function (e) {
              // 2.10 保持上游语义（失败就放弃）；3.x 退到免签名 320k 接口
              if (!isNcm3()) throw e;
              return resolveUrl320(trackId);
            })
            .then(function (u) {
              if (!u) throw new Error("没拿到地址");
              // ★ v1.8.4：进闸门最低优先级 —— 预载需要带宽时它让位（下一拍重试）
              return fetchBytesGated(u, signal || null, 2, "流式补缓冲", abort);
            });
        });
    return p
      .then(function (buf) {
        var ctx = ensureCtx();
        if (!ctx) throw new Error("没有 AudioContext");
        try {
          ginfo = gaplessInfo(buf);
        } catch (e) {}
        cachePutBytes(trackId, buf); // decode 会 detach → 先留副本
        // ★ v1.8.5：落盘句柄在这里抓住（同 startPreload：decode 之后缓存可能已被挤掉）
        try {
          diskHandle = peekBytesForDisk(trackId);
          if (!diskHandle && typeof buf.slice === "function") diskHandle = buf.slice(0);
        } catch (e) {
          diskHandle = null;
        }
        return ctx.decodeAudioData(buf);
      })
      .then(function (ab) {
        // ★ v1.8.4：磁盘那份当初就验过试听，不再多打一次 song/detail。
        //   `trusted` = 「这次真的拿到权威时长比过」→ 只有它才允许落盘（同 startPreload）。
        if (!isNcm3() || !ab || fromDisk) {
          trusted = true;
          return ab;
        }
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
            if (dtMs) trusted = true;
            return ab;
          });
      })
      .then(function (ab) {
        if (ab) noteTrim(trackId, ginfo, ab);
        // ★ v1.8.5：把「能不能落盘」和「落盘用的字节」跟着结果一起交出去
        var declared = declaredSizeOf(trackId);
        var sizeOk = !!declared && !!diskHandle && diskHandle.byteLength === declared;
        return { ab: ab, trusted: !!trusted || sizeOk, bytes: diskHandle };
      });
  }

  /** ★ v1.20.0：补缓冲「为什么没跑」也要留痕（同曲同因只记一次） */
  function logPromoteSkip(tid, why) {
    if (tid === null || tid === undefined) return;
    var sig = tid + "|" + why;
    if (S.__promoteSig === sig) return;
    S.__promoteSig = sig;
    log("[promote] 跳过补缓冲： " + why + " ｜ track=" + tid);
  }

  function maybePromoteStream() {
    if (!promoteEnabled()) {
      logPromoteSkip(S.curTrackId, "已关（__gpPromote=false）");
      return;
    }
    if (S.promoteBusy) return;
    if (!S.stream || !S.ready || S.paused || !S.el) return;
    var tid = S.curTrackId;
    if (tid === null || tid === undefined) return;
    var played = livePlayedMs();
    if (played < PROMOTE_AFTER_SEC * 1000) return;
    if (recentGet(tid)) {
      logPromoteSkip(tid, "缓冲已在手（不用再补）");
      return;
    }
    if (hasCachedBytes(tid)) {
      logPromoteSkip(tid, "字节已在手（下次预载直接解码）");
      return;
    }
    /**
     * ★ v1.8.5：快要播完了就别补了。
     *
     * 真机证据（13:38:12.758，用户 seek 到 164.65s / 全长 178.94s）：
     *   还剩 14s，插件照样下了 6.83MB、解了 65.53MB 塞进 recentBufs —— 15 秒后这首歌就结束了，
     *   那 65MB 一次都没被用到，还顺手把「下一首」的余量挤掉了。
     */
    var left = S.duration ? S.duration - position() : 0;
    if (left > 0 && left < PROMOTE_MIN_LEFT) {
      logPromoteSkip(tid, "只剩 " + left.toFixed(0) + "s（< " + PROMOTE_MIN_LEFT + "s）");
      return;
    }
    S.promoteBusy = tid;
    var t0 = performance.now();
    // ★ v1.8.4：这一份是「锦上添花」，可以被预载抢占（抢了就在下一拍重试）
    var pac = null;
    try {
      if (typeof AbortController === "function") pac = new AbortController();
    } catch (e) {
      pac = null;
    }
    log("[promote] 流式那首已听 " + (played / 1000).toFixed(1) + "s → 后台补成缓冲 ｜ track=" + tid);
    fetchDecoded(tid, pac ? pac.signal : null, pac)
      .then(function (r) {
        var ab = r && r.ab;
        if (!ab) return;
        recentPut(tid, ab);
        // ★ v1.8.4/v1.8.5：补出来的这份也落盘（重启之后切回它也是秒开）——
        //   判据同预载：验过试听 **或** 字节数与接口声明一致；句柄由 fetchDecoded 抓好递出来
        if (r.trusted && r.bytes) {
          try {
            diskPutBytes(tid, r.bytes);
          } catch (e) {}
        }
        log(
          "[promote] ★ 已补成缓冲（切回来秒开，也能当交叉的 B）｜ track=" + tid + " ｜ " +
            mb(ab.length * ab.numberOfChannels * 4) + " ｜ 耗时 " + (performance.now() - t0).toFixed(0) + "ms" +
            (r.trusted ? "" : " ｜ 未验过试听（不落盘）")
        );
      })
      .catch(function (e) {
        if (e && e.name === "AbortError") {
          log("[promote] 让出带宽（下一拍重试）｜ track=" + tid);
          return;
        }
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
    /**
     * ★ v1.9.2（#BPM-0）：flux 改成**相对跳变**（除以局部电平），不再用绝对值。
     *
     * 为什么：绝对 flux 会被「铺底/母带电平」拉偏 —— 一旦有持续和弦或压得很死的总线，
     * 鼓点的 env 增量在绝对值上就不显眼了，自相关随之乱掉（实测：同一套 128 BPM 鼓点，
     * 加一层 0.10 的持续和弦就从 128.01 偏到 141.67；加到 0.07 还准）。
     * 用 `Δenv / 局部均值` 之后，「拍上跳多少百分比」和铺底电平无关，鼓点重新占主导。
     */
    var w = Math.max(3, Math.round(0.6 / BEAT_HOP_SEC));
    var envMean = new Float32Array(frames);
    for (var fe = 0; fe < frames; fe++) {
      var lo0 = Math.max(0, fe - w);
      var hi0 = Math.min(frames - 1, fe + w);
      var s0 = 0;
      for (var q0 = lo0; q0 <= hi0; q0++) s0 += env[q0];
      envMean[fe] = s0 / (hi0 - lo0 + 1);
    }
    var flux = new Float32Array(frames);
    for (var f2 = 1; f2 < frames; f2++) {
      var dd = env[f2] - env[f2 - 1];
      if (!(dd > 0)) continue;
      var lvl = envMean[f2];
      flux[f2] = dd / (lvl > 1e-6 ? lvl : 1e-6); // 相对跳变（无量纲）
    }
    // 去局部均值（窗口 ~0.6s）：避免「整体渐强」被误当成节拍
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
    var meanOnset = onsetSum / frames;    if (!(meanOnset > 0)) return null;

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
    /**
     * ★ v1.8.1（#9）：**速度先验**。人耳/流行乐的重心在 ~120 BPM 附近，
     * 用对数尺度上的高斯去轻微加权，就能把「2/3 倍速」这类歧义掰回来
     * （128 被测成 84.6 时，84.6 离 120 有半个八度，先验会明显压它）。
     * ★ 只是**轻微**加权（σ=0.9 八度）：有真凭据的倍速关系仍然能赢。
     */
    function tempoPrior(b) {
      if (!(b > 0)) return 0;
      var oct = Math.log(b / BEAT_PREFERRED_BPM) / Math.LN2;
      return Math.exp(-0.5 * (oct / BEAT_PRIOR_OCTAVES) * (oct / BEAT_PRIOR_OCTAVES));
    }
    var bestLag = 0;
    var bestScore = -1;
    for (var lg = minLag; lg <= maxLag; lg++) {
      var sc2 = comb(lg) * tempoPrior(60 / (lg * hopSec));
      if (sc2 > bestScore) {
        bestScore = sc2;
        bestLag = lg;
      }
    }
    if (!(bestLag > 0)) return null;

    // ★ v1.8.1（#10/#13）：**亚帧细化** —— 原来 BPM 只能取到整数 lag（hop≈11.6ms），
    //   128 BPM 处相当于 ±1.5 BPM（≈1.2%）的误差；这个误差在 12s 的长交叉里会累成上百毫秒。
    //   这里先对相关峰做抛物线插值，再把「周期 × 相位」在细网格上再搜一遍。
    var refinedLag = bestLag; // ★ v1.8.1：周期细搜（refinePeriodPhase）已覆盖，抛物线插值属冗余

    // 折回 80~180 BPM（人耳对这段最敏感，也避免把 1/2、1/3 倍当基频）
    var bpm = 60 / (refinedLag * hopSec);
    while (bpm > 180 && refinedLag * 2 <= maxLag) {
      refinedLag *= 2;
      bpm = 60 / (refinedLag * hopSec);
    }
    while (bpm < 80 && Math.round(refinedLag / 2) >= minLag) {
      refinedLag = Math.round(refinedLag / 2);
      bpm = 60 / (refinedLag * hopSec);
    }

    var fine = refinePeriodPhase(onset, frames, refinedLag);
    var period = fine.period;
    bpm = 60 / (period * hopSec);
    var bestPhase = fine.phase;
    var onScore = fine.score;

    /**
     * ★ v1.9.2（#BPM-1）：置信度改成「**拍上 vs 拍外**」的对比度。
     *
     * 老算法拿「拍点上的 onset 均值」去和**全局均值**比。这在真实曲目上很吃亏：
     * 流行/电子这类曲子的 onset 通量**到处都有**（底鼓、军鼓、踩镲、人声齿音都算），
     * 于是「拍上的均值」只比全局高一点点 → 置信被算成 0.00 —— 真机日志里
     * `bpm=160.1 ｜ 置信=0.00` 一大片，就是这个原因（BPM 明明测对了，却不被信任）。
     *
     * 正确的问法是：**这套网格是不是把能量对上去了**？所以把同样的网格整体挪
     * 1/2、1/4、3/4 拍（拍外）再算一次均值，取其中最像的那个当对手：
     *   - 鼓点清楚 → 拍上远高于拍外 → 对比度高；
     *   - 铺底/自由节奏 → 拍上和拍外差不多 → 对比度≈0。
     * 这个量对「onset 到处都是」是**不敏感**的（两边都被同样的底噪抬起来），
     * 所以它比「对比全局均值」稳得多。
     */
    var offScore = 0;
    var offFracs = [0.5, 0.25, 0.75];
    for (var ofi = 0; ofi < offFracs.length; ofi++) {
      var offPhase = (bestPhase + period * offFracs[ofi]) % period;
      var os = gridMeanOnset(onset, frames, period, offPhase);
      if (os > offScore) offScore = os;
    }
    var promOff = onScore + offScore > 1e-12 ? (onScore - offScore) / (onScore + offScore) : 0;
    if (!isFinite(promOff) || promOff < 0) promOff = 0;
    if (promOff > 1) promOff = 1;

    /**
     * ⚠️ 只看「拍外」会把**八分/十六分音符铺满**的真实曲目误判成「没有拍子」
     * （踩镲就在半拍处 → 拍外能量本来就高）。所以还要看一个更基本的问题：
     * **拍点上的能量相对「整段平均」是不是显著**（有拍子的曲子，绝大多数帧是安静的）。
     * 两个量加权：前者管「相位靠不靠谱」，后者管「到底有没有脉冲」。
     */
    var promGlobal = onScore + meanOnset > 1e-12 ? (onScore - meanOnset) / (onScore + meanOnset) : 0;
    if (!isFinite(promGlobal) || promGlobal < 0) promGlobal = 0;
    if (promGlobal > 1) promGlobal = 1;
    var prominence = 0.6 * promGlobal + 0.4 * promOff;

    /**
     * ★ v1.9.2（#BPM-2）：瞬态锐度改成**软因子**。
     *   老实现数「RMS 包络相对局部均值跳变 >50% 的帧占比」，而现代母线压得很死、
     *   整首响度平坦 → 跳变极少 → 因子直接 0 → 置信被一票否决。
     *   现在用「onset 峰值 / onset 均值」衡量尖锐程度，并且只做**软**加权
     *   （0.35 + 0.65·r）：铺底依然会被压下去（r≈0 → ×0.35，再乘对比度就 <0.2），
     *   但真有鼓点的曲子不会被这一项一票否决。
     */
    var rhythmic = onsetPeakiness(onset, frames);
    /**
     * ★ v1.9.2（#BPM-4）：**覆盖率** —— 这套网格「解释」了多少 onset 能量。
     *
     * 为什么还需要它：稀疏但**不规则**的瞬态（说话、偶发打击）总能被某条网格「碰巧对上」
     * 一部分，于是「拍上/拍外」的比值也会好看（实测：20s 里 25 个不规则打击 → 置信 0.79）。
     * 但真实鼓点里**绝大多数 onset 都落在拍上**，覆盖率高；不规则素材只有一小部分能被解释。
     * 阈值借用了「有拍子的歌，至少三成 onset 能量在拍上」这个经验值（下界 0.30 只做软加权，
     * 不硬砍 —— 免得把铺满十六分音符的曲子误杀）。
     */
    var coverage = gridCoverage(onset, frames, period, bestPhase);
    // ⚠️ 平方：覆盖率是「网格解释了多少能量」，它比别的量更能区分「真有鼓点」和「碰巧对上」，
    //   所以让它的影响更陡一点（0.5 以上视为满分，0.2 只剩 0.16 倍）。
    var covNorm = Math.min(1, coverage / 0.5);
    var coverFactor = covNorm * covNorm;

    /**
     * ★ v1.9.2（#BPM-5）：**统计显著性** —— 把「拍上均值」放到「所有相位」的分布里去比。
     *
     * 为什么还要这一道：稀疏但**不规则**的瞬态，任何一条网格都能「碰巧」命中最强的那几个打击，
     * 于是「拍上/拍外」的比值也高（实测 0.79）。正确的问法是：**拍上这一相位是不是显著地
     * 比其它相位都强**？在真正的节拍里它是离群值（z 很大），在随机素材里它只是 16 个相位里
     * 的一个（z ≈ 1）。
     */
    var K = 16;
    var ss = [];
    var sumPh = 0;
    for (var pk = 0; pk < K; pk++) {
      var sph = (bestPhase + (period * pk) / K) % period;
      var vpk = gridMeanOnset(onset, frames, period, sph);
      ss.push(vpk);
      sumPh += vpk;
    }
    var meanPh = sumPh / K;
    var varPh = 0;
    for (var pk2 = 0; pk2 < K; pk2++) {
      var dph = ss[pk2] - meanPh;
      varPh += dph * dph;
    }
    var sdPh = Math.sqrt(varPh / K);
    var zScore = sdPh > 1e-9 ? (onScore - meanPh) / sdPh : 0;
    var promStat = Math.min(1, Math.max(0, zScore / 3.5));

    /**
     * ⚠️ 四个因子**不要连乘**：它们都是 [0,1] 的时候，一首「还不错」的曲子会被稀释成 0.3 左右，
     *   于是贴拍/变速/长交叉的阈值全被卡住。所以：
     *   - `prominence`（有没有脉冲）与 `coverage`（网格解释了多少能量）作为**门**，连乘；
     *   - `promStat`（相位显著性）与 `rhythmic`（瞬态锐度）作为**质量**，取加权平均。
     */
    var quality = 0.5 * promStat + 0.5 * (0.35 + 0.65 * rhythmic);
    var conf = prominence * coverFactor * quality;
    if (!isFinite(conf) || conf < 0) conf = 0;
    if (conf > 1) conf = 1;

    return {
      bpm: bpm,
      beatSec: 60 / bpm,
      anchorSec: start + bestPhase * hopSec, // 绝对曲目时间
      conf: conf,
      rhythmic: rhythmic, // ★ v1.9.2：onset 锐度（排查「为什么置信低」时看它）
      prominence: prominence, // ★ v1.9.2：拍上/拍外与拍上/全局的加权对比度
      promGlobal: promGlobal, // ★ v1.9.2：「到底有没有脉冲」
      promOff: promOff, // ★ v1.9.2：「相位靠不靠谱」
      coverage: coverage, // ★ v1.9.2：网格解释了多少 onset 能量
      onScore: onScore,
      offScore: offScore,
      frames: frames,
      windowSec: span,
      dur: dur, // ★ v1.8.0：整首时长（头尾不一致时用它把末拍外推出来）
    };
  }

  /**
   * ★ v1.9.2：这套网格「解释」了多少 onset 能量（±1 帧内算命中）。
   *   真实鼓点 → 大部分能量都在拍上（0.6~0.95）；不规则/无节奏素材 → 只有一小部分。
   */
  function gridCoverage(onset, frames, period, phase) {
    if (!(period >= 1) || !(frames > 8)) return 0;
    var mask = new Uint8Array(frames);
    var pos = phase;
    if (!(pos >= 0)) pos = 0;
    while (pos < frames) {
      var idx = Math.round(pos);
      for (var d = -1; d <= 1; d++) {
        var j = idx + d;
        if (j >= 0 && j < frames) mask[j] = 1;
      }
      pos += period;
    }
    var onE = 0;
    var totE = 0;
    for (var i = 0; i < frames; i++) {
      var v = onset[i];
      totE += v;
      if (mask[i]) onE += v;
    }
    return totE > 1e-12 ? onE / totE : 0;
  }

  /** 某个「周期 × 相位」网格上的 onset 均值（refinePeriodPhase 与置信度评估共用） */
  function gridMeanOnset(onset, frames, period, phase) {
    if (!(period >= 1)) return 0;
    var sum = 0;
    var cnt = 0;
    var pos = phase;
    if (!(pos >= 0)) pos = 0;
    while (pos < frames) {
      var idx = Math.round(pos);
      if (idx >= frames) idx = frames - 1;
      sum += onset[idx];
      cnt++;
      pos += period;
    }
    return cnt ? sum / cnt : 0;
  }

  /**
   * ★ v1.9.2：onset 的「尖锐程度」= 峰值 / 均值（再做线性归一到 [0,1]）。
   *   鼓组：峰值远高于均值（20 以上）；铺底：接近 2~3。
   *   比「数 RMS 跳变」稳，而且**不吃母带压缩**的亏。
   */
  function onsetPeakiness(onset, frames) {
    if (!onset || !(frames > 8)) return 0;
    var max = 0;
    var sum = 0;
    for (var i = 0; i < frames; i++) {
      var v = onset[i];
      if (v > max) max = v;
      sum += v;
    }
    var mean = sum / frames;
    if (!(mean > 1e-12) || !(max > 0)) return 0;
    var ratio = max / mean;
    var r = (ratio - 3) / 12; // 3 以下≈平，15 以上≈很尖
    if (!isFinite(r) || r < 0) r = 0;
    if (r > 1) r = 1;
    return r;
  }

  /**
   * ★ v1.8.1（#11）：瞬态密度 → [0,1] 的可信度因子。
   * 思路：把 RMS 包络先做局部平滑得到「基线」，再数「相对基线跳变超过 50%」的比例。
   * 鼓组/打点很密（0.1 以上），铺底驻波/和声接近 0 —— 用它把后者的置信压下去。
   */
  function transientRhythmic(env, frames) {
    if (!env || !(frames > 8)) return 0.5;
    var R = 2;
    var level = new Float32Array(frames);
    for (var i = 0; i < frames; i++) {
      var sum = 0;
      var cnt = 0;
      for (var k = -R; k <= R; k++) {
        var j = i + k;
        if (j >= 0 && j < frames) {
          sum += env[j];
          cnt++;
        }
      }
      level[i] = cnt ? sum / cnt : 0;
    }
    var mean = 0;
    for (var i2 = 0; i2 < frames; i2++) mean += level[i2];
    mean /= frames;
    if (!(mean > 1e-9)) return 0;
    var hits = 0;
    for (var i3 = 1; i3 < frames; i3++) {
      if ((level[i3] - level[i3 - 1]) / mean > BEAT_TRANSIENT_JUMP) hits++;
    }
    var density = hits / frames;
    var lo = BEAT_DENSITY_MIN;
    var hi = BEAT_DENSITY_FULL;
    var r = (density - lo) / (hi - lo);
    if (!isFinite(r) || r < 0) r = 0;
    if (r > 1) r = 1;
    return r;
  }

  /**
   * ★ v1.8.1（#10/#13）：在「周期 × 相位」二维细网格上再搜一遍。
   * 目标函数 = 拍点处 onset 的平均值（拍点越集中越好）。
   * 周期在粗估计 ±2% 内按 0.05% 步进 → 128 BPM 处可达 ±0.06 BPM。
   */
  function refinePeriodPhase(onset, frames, coarsePeriod) {
    var best = { period: coarsePeriod, phase: 0, score: -1 };
    if (!(coarsePeriod >= 2)) return best;
    var steps = BEAT_REFINE_STEPS;
    var frac = BEAT_REFINE_FRACTION;
    for (var s = -steps; s <= steps; s++) {
      var period = coarsePeriod * (1 + s * frac);
      if (period < 2) continue;
      var offRange = Math.max(1, Math.round(period));
      for (var off = 0; off < offRange; off++) {
        var sum = 0;
        var cnt = 0;
        var pos = off;
        while (pos < frames) {
          var idx = Math.round(pos);
          if (idx >= frames) idx = frames - 1;
          sum += onset[idx];
          cnt++;
          pos += period;
        }
        if (!cnt) continue;
        var score = sum / cnt;
        if (score > best.score) best = { period: period, phase: off, score: score };
      }
    }
    return best;
  }

  /* ---- ★ v1.8.2：调性检测（Camelot）+ 和声兼容 ----
   * 方法参考 Convx（GPL-3.0）的 KeyDetector 概念（Krumhansl 调性模板 + Camelot 轮）；
   * **代码为本项目独立实现**。
   */

  var KEY_MIN_CONF = 0.45; // 两侧都达到这个置信才参与「和声门」
  var KEY_WINDOW_SEC = 12; // 用歌曲开头这么长来判断调性
  var KEY_STRIDE_SEC = 1; // 只取这些片段的样本（省时间）

  // Krumhansl 调性原型（大调 / 小调）
  var KEY_MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var KEY_MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  // Camelot 轮：按半音（C=0 … B=11）索引
  var CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  var CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

  function camelotOf(pc, minor) {
    var n = minor ? CAMELOT_MINOR[pc] : CAMELOT_MAJOR[pc];
    return n + (minor ? "A" : "B");
  }

  /** 从网格里取调性（没有就 null） */
  function keyOf(grid) {
    return grid && grid.key && grid.key.conf >= KEY_MIN_CONF ? grid.key : null;
  }

  /**
   * 和声兼容（Camelot 规则）：
   *   - 同号（A↔A / B↔B）相邻（±1）→ 兼容
   *   - 同号码、不同字母（关系大小调）→ 兼容
   * 任一侧没有可信调性 → **视为兼容**（不给用户添麻烦，只是不做额外约束）。
   */
  function keysCompatible(ka, kb) {
    if (!ka || !kb) return true;
    var na = parseInt(String(ka.camelot), 10);
    var nb = parseInt(String(kb.camelot), 10);
    var la = String(ka.camelot).slice(-1);
    var lb = String(kb.camelot).slice(-1);
    if (na === nb) return true;
    if (la === lb && Math.abs(na - nb) === 1) return true;
    return false;
  }

  /**
   * ★ v1.8.2：检测调性 —— 12 个半音的 chroma（Goertzel，3 个八度）→ 与 Krumhansl 原型相关。
   * @returns {pitchClass, minor, conf, camelot} 或 null
   */
  function detectKey(ab, from, len) {
    try {
      if (!ab || typeof ab.getChannelData !== "function") return null;
      var sr = Number(ab.sampleRate) || 44100;
      var dur = Number(ab.duration) || 0;
      if (!(dur > 4)) return null;
      var start = Math.max(0, Math.min(dur - 2, Number(from) || 0));
      var span = Math.min(Number(len) || KEY_WINDOW_SEC, dur - start);
      if (!(span >= 4)) return null;
      var nch = Math.min(2, Number(ab.numberOfChannels) || 1);
      var stride = Math.max(1, Math.round(KEY_STRIDE_SEC * 0 + 2)); // 每 2 个采样取一个
      var a0 = Math.floor(start * sr);
      var a1 = Math.min(ab.length, Math.floor((start + span) * sr));
      var n = Math.floor((a1 - a0) / stride);
      if (n < sr * 0.5) return null;
      var srEff = sr / stride;

      var chans = [];
      for (var c = 0; c < nch; c++) {
        var d = ab.getChannelData(c);
        if (d && d.length) chans.push(d);
      }
      if (!chans.length) return null;

      // chroma：三个八度（C3~B5）共 36 个频点
      var chroma = new Float64Array(12);
      var noteNames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      for (var oct = 0; oct < 3; oct++) {
        for (var pci = 0; pci < 12; pci++) {
          var midi = 48 + oct * 12 + pci; // 48 = C3
          var f = 440 * Math.pow(2, (midi - 69) / 12);
          if (f > srEff / 2.2) continue; // 超过奈奎斯特就不算
          var w = (2 * Math.PI * f) / srEff;
          var coeff = 2 * Math.cos(w);
          var s1 = 0;
          var s2 = 0;
          for (var i = 0; i < n; i++) {
            var idx = a0 + i * stride;
            var v = 0;
            for (var c2 = 0; c2 < chans.length; c2++) v += chans[c2][idx] || 0;
            v /= chans.length;
            var s0 = v + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
          }
          var mag = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
          chroma[noteNames[pci]] += mag / Math.sqrt(n);
        }
      }
      var total = 0;
      for (var q = 0; q < 12; q++) total += chroma[q];
      if (!(total > 1e-9)) return null;
      for (var q2 = 0; q2 < 12; q2++) chroma[q2] /= total;

      function corr(profile, root) {
        var mx = 0;
        var my = 0;
        for (var t = 0; t < 12; t++) {
          mx += chroma[(t + root) % 12];
          my += profile[t];
        }
        mx /= 12;
        my /= 12;
        var num = 0;
        var dx = 0;
        var dy = 0;
        for (var t2 = 0; t2 < 12; t2++) {
          var ax = chroma[(t2 + root) % 12] - mx;
          var by = profile[t2] - my;
          num += ax * by;
          dx += ax * ax;
          dy += by * by;
        }
        if (!(dx > 0) || !(dy > 0)) return 0;
        return num / Math.sqrt(dx * dy);
      }

      var best = null;
      var second = -2;
      for (var root = 0; root < 12; root++) {
        var maj = corr(KEY_MAJOR_PROFILE, root);
        var min = corr(KEY_MINOR_PROFILE, root);
        var pick = maj >= min ? { root: root, minor: false, r: maj } : { root: root, minor: true, r: min };
        if (!best || pick.r > best.r) {
          second = best ? best.r : -2;
          best = pick;
        } else if (pick.r > second) {
          second = pick.r;
        }
      }
      if (!best) return null;
      var conf = Math.max(0, Math.min(1, (best.r - Math.max(0, second)) / (1 - Math.max(0, second) + 1e-9)));
      return {
        pitchClass: best.root,
        minor: best.minor,
        conf: conf,
        r: best.r,
        camelot: camelotOf(best.root, best.minor),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 取某首歌「靠近某个时间点」的拍点网格（带缓存）。
   * 我们只关心两个位置：**开头**（B 的入点）和**结尾**（A 的接缝），所以只算两段 20s 窗口。
   *
   * ★ v1.10.0：改成**缓存优先，且缓存命中不再需要 AudioBuffer**。
   *   这是「离线分析」能起作用的开关 —— 流式 A 没有 buffer，但盘上有上次算好的尾窗网格，
   *   于是 `beatTail()` 照样能返回网格，`mixPlan()` 就不会再退 plain。
   *   参数 `atEndOpt` 让调用方显式说明要头窗还是尾窗（没有 buffer 时算不出 `nearSec > dur/2`）。
   */
  function beatGridNear(trackId, ab, nearSec, atEndOpt) {
    if (trackId === null || trackId === undefined) return null;
    var dur = Number(ab && ab.duration) || 0;
    var atEnd = atEndOpt === true || (atEndOpt === undefined && dur > BEAT_MIN_SEC && nearSec > dur / 2);
    var key = trackId + (atEnd ? "|tail" : "|head");
    var cache = beatCache();
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      var hit = cache[key];
      // 命中且（没有 buffer，或时长对得上）→ 直接用
      if (!hit || !ab || !(dur > 0) || !(hit.dur > 0) || Math.abs(hit.dur - dur) <= 0.75) return hit;
      // ★ v1.10.0：时长对不上（试听片段 64s / 换音质 / 换版本）→ 这条作废，重算
      log(
        "[beat] ★ 缓存时长对不上（缓存 " + Number(hit.dur).toFixed(2) + "s vs 现在 " + dur.toFixed(2) +
          "s）→ 丢掉重算 ｜ track=" + trackId
      );
      delete cache[key];
    }
    if (!ab) return null; // 缓存里真没有 → 这轮就是拿不到（行为与 v1.9.7 一致）
    if (!(dur > BEAT_MIN_SEC)) return null;

    var from = atEnd ? Math.max(0, dur - BEAT_WIN_SEC - 2) : 0;

    var grid = null;
    try {
      grid = analyzeBeats(ab, from, Math.min(BEAT_WIN_SEC, dur - from));
    } catch (e) {
      log("[beat] ★ 分析抛错 ｜ track=" + trackId + " ｜ " + (e && e.message));
      grid = null;
    }
    // ★ v1.8.2：头窗顺便判一下调性（Camelot），给「和声门」用
    if (grid && !atEnd) {
      try {
        grid.key = detectKey(ab, from, Math.min(KEY_WINDOW_SEC, dur - from));
      } catch (eK) {
        grid.key = null;
      }
    }
    if (grid && atEnd && grid.bpm > 0) {
      // 把锚点折算到「结尾附近最近的一拍」，接缝直接取用
      var beat = grid.beatSec;
      var t = Math.max(0, dur - 0.2);
      grid.endBeatSec = grid.anchorSec + Math.round((t - grid.anchorSec) / beat) * beat;
    }
    cache[key] = grid;
    // ★ v1.6.1：只要头/尾都算过，就顺手收敛一次 BPM（幂等；不递归 —— 它不调 beatGridNear）
    reconcileTempo(trackId);
    // ★ v1.10.0：算出来就落盘（和音频缓存解耦；流式 A 下次直接命中）
    if (grid) analysisNoteTrack(trackId, dur);
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
    return beatGridNear(trackId, ab, 0, false);
  }

  /**
   * ★ v1.20.0：**头窗 2** —— 从第 8 秒起的 20 秒窗。
   *
   * 为什么：头窗固定 0~20s，长前奏 / 自由节奏前奏 / 氛围铺底会把 BPM 与相位带偏，
   * 入点就落在「它以为的拍」上。再算一个「往后挪 8 秒」的窗：两窗一致就融合抬置信，
   * 不一致就取置信高的。只在「B 已解码缓冲 + 第一次调度」时算一次（缓存 `trackId|head2`）。
   */
  function beatHead2(trackId, ab) {
    if (trackId === null || trackId === undefined || !ab) return null;
    var dur = Number(ab.duration) || 0;
    if (!(dur > BEAT_WIN_SEC + 8)) return null;
    var key = trackId + "|head2";
    var cache = beatCache();
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    var from = 8;
    var grid = null;
    try {
      grid = analyzeBeats(ab, from, Math.min(BEAT_WIN_SEC, dur - from));
    } catch (e) {
      grid = null;
    }
    cache[key] = grid;
    if (grid) {
      log(
        "[beat] track=" + trackId + " ｜ 头窗2 ｜ bpm=" + grid.bpm.toFixed(1) + " ｜ 锚点=" +
          grid.anchorSec.toFixed(2) + "s ｜ 置信=" + grid.conf.toFixed(2)
      );
    }
    return grid;
  }

  /**
   * 两个头窗怎么用：
   *   - 只缺一边 → 用另一边；
   *   - 一致（±2%）→ 融合：锚点/拍长仍用「靠开头」的那一窗（入点靠近 0），置信抬高；
   *   - 不一致 → 取置信高的；靠后的窗锚点也是绝对拍点，往前推算入点即可。
   * @returns { grid, win }
   */
  function pickHeadForMix(g1, g2) {
    if (!g2 || !(g2.bpm > 0)) return { grid: g1, win: g1 ? "head" : "none" };
    if (!g1 || !(g1.bpm > 0)) return { grid: g2, win: "head2" };
    var dev = Math.abs(g2.bpm - g1.bpm) / g1.bpm;
    if (dev <= FUSE_TOL) {
      return {
        grid: {
          bpm: g1.bpm,
          beatSec: g1.beatSec,
          anchorSec: g1.anchorSec,
          conf: Math.min(1, Math.max(g1.conf || 0, g2.conf || 0) + 0.15),
          dur: g1.dur,
          windowSec: g1.windowSec,
        },
        win: "fused",
      };
    }
    if ((g2.conf || 0) > (g1.conf || 0)) return { grid: g2, win: "head2" };
    return { grid: g1, win: "head" };
  }

  /** 尾窗网格（A 的接缝用） */
  function beatTail(trackId, ab) {
    return beatGridNear(trackId, ab, Number(ab && ab.duration) || 0, true);
  }

  /**
   * ★ v1.18.0：**尾窗 2** —— 结束在「结尾前 10 秒」的 20 秒窗。
   *
   * 为什么：`beatTail` 固定取最后 22 秒；可 A 提前收尾后实际混音点可能早十几秒，
   * 那一窗常常落在淡出/空段上（置信低或干脆测不出）。再算一个「往前挪 10 秒」的窗，
   * 两窗一致就融合抬置信，不一致就取置信高的那一窗。
   * 只在「已解码缓冲 + 第一次调度」时算一次（缓存 `trackId|tail2`），不进记录。
   */
  function beatTail2(trackId, ab) {
    if (trackId === null || trackId === undefined || !ab) return null;
    var dur = Number(ab.duration) || 0;
    if (!(dur > BEAT_MIN_SEC)) return null;
    var key = trackId + "|tail2";
    var cache = beatCache();
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    var from = Math.max(0, dur - BEAT_WIN_SEC - 10);
    var grid = null;
    try {
      grid = analyzeBeats(ab, from, Math.min(BEAT_WIN_SEC, dur - from));
    } catch (e) {
      grid = null;
    }
    cache[key] = grid;
    if (grid) {
      log(
        "[beat] track=" + trackId + " ｜ 尾窗2 ｜ bpm=" + grid.bpm.toFixed(1) + " ｜ 锚点=" +
          grid.anchorSec.toFixed(2) + "s ｜ 置信=" + grid.conf.toFixed(2)
      );
    }
    return grid;
  }

  /**
   * 两个尾窗怎么用：
   *   - 只缺一边 → 用另一边；
   *   - 一致（折算后 ±2%）→ 融合：锚点/末拍仍用「靠结尾」的那一窗，置信抬高；
   *   - 不一致 → 取置信高的；若取的是尾窗 2（靠前），末拍按它的拍长外推到结尾。
   * @returns { grid, win }
   */
  function pickTailForMix(g1, g2) {
    if (!g2 || !(g2.bpm > 0)) return { grid: g1, win: g1 ? "tail" : "none" };
    if (!g1 || !(g1.bpm > 0)) {
      return { grid: extendTailToEnd(g2), win: "tail2" };
    }
    var dev = Math.abs(g2.bpm - g1.bpm) / g1.bpm;
    if (dev <= FUSE_TOL) {
      var conf = Math.min(1, Math.max(g1.conf || 0, g2.conf || 0) + 0.15);
      return {
        grid: {
          bpm: g1.bpm,
          beatSec: g1.beatSec,
          anchorSec: g1.anchorSec,
          endBeatSec: g1.endBeatSec,
          conf: conf,
          dur: g1.dur,
          windowSec: g1.windowSec,
        },
        win: "fused",
      };
    }
    if ((g2.conf || 0) > (g1.conf || 0)) return { grid: extendTailToEnd(g2), win: "tail2" };
    return { grid: g1, win: "tail" };
  }

  /** 把「靠前的尾窗」的末拍按它自己的拍长外推到结尾（其余字段不动） */
  function extendTailToEnd(g) {
    if (!g || !(g.bpm > 0)) return g;
    var beat = g.beatSec;
    var dur = Number(g.dur) || 0;
    var t = Math.max(0, dur - 0.2);
    return {
      bpm: g.bpm,
      beatSec: beat,
      anchorSec: g.anchorSec,
      endBeatSec: g.anchorSec + Math.round((t - g.anchorSec) / beat) * beat,
      conf: g.conf,
      dur: g.dur,
      windowSec: g.windowSec,
    };
  }

  /* ==================== v1.19.0 · 连续母带（无缝专辑）====================
   *
   * 问题：有些专辑是**按连续母带**做的 —— A 的尾音直接切进 B 的开头，中间没有淡出、
   * 没有静音，甚至鼓点跨曲继续。这种时候任何交叉（哪怕是智能交叉）都是在两段音乐上
   * 叠一层淡入淡出，把原本的衔接毁掉；A 提前收尾更是直接吃掉尾音。
   *
   * 判据（两边都是缓冲，逐条都要满足）：
   *   1. A 结尾 0.25s 有声音，且不低于全曲平均的 35%（= 没有淡出）；
   *   2. B 开头 0.25s 有声音，且不低于全曲平均的 35%（= 没有淡入）；
   *   3. A 没有尾部静音（trim.end ≤ 20ms）、B 没有头部静音（trim.start ≤ 20ms）；
   *   4. 两侧边界电平差 ≤ 6dB（同一个母带做出来的，电平不会跳）。
   * 满足 → 这一次**保持原样**：0s 接缝、不交叉、不早收、不跳 B 的入点。
   * 关闭：`window.__gpKeepContinuous = false`。
   */
  var CONT_RMS_MIN = 0.006;
  var CONT_LEVEL_DB = 6;
  var CONT_QUIET_RATIO = 0.35;
  var CONT_SILENCE_SEC = 0.02;

  function continuousEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpKeepContinuous === false) return false;
    } catch (e) {}
    return true;
  }

  /** 某段（秒）的 RMS */
  function rmsOf(ab, fromSec, lenSec) {
    if (!ab || typeof ab.getChannelData !== "function") return 0;
    var sr = Number(ab.sampleRate) || 44100;
    var total = Number(ab.length) || Math.round((Number(ab.duration) || 0) * sr);
    var n = Math.max(1, Math.round(lenSec * sr));
    var from = Math.round(fromSec * sr);
    if (from < 0) from = 0;
    if (from + n > total) n = Math.max(1, total - from);
    var ch = Number(ab.numberOfChannels) || 1;
    if (ch > 2) ch = 2;
    var sum = 0;
    var cnt = 0;
    for (var c = 0; c < ch; c++) {
      var d = ab.getChannelData(c);
      if (!d) continue;
      for (var i = 0; i < n; i++) {
        var v = d[from + i] || 0;
        sum += v * v;
        cnt++;
      }
    }
    return cnt ? Math.sqrt(sum / cnt) : 0;
  }

  /** 全曲平均 RMS（粗采样，48 段 × 0.25s） */
  function rmsMean(ab) {
    var dur = Number(ab && ab.duration) || 0;
    if (!(dur > 1)) return 0;
    var segs = Math.max(4, Math.min(48, Math.floor(dur)));
    var step = dur / segs;
    var sum = 0;
    var cnt = 0;
    for (var i = 0; i < segs; i++) {
      var r = rmsOf(ab, i * step + step / 2 - 0.125, 0.25);
      if (isFinite(r)) {
        sum += r;
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  }

  /** 边界电平差（dB），给日志用 */
  function dbDiff(a, b) {
    if (!(a > 0) || !(b > 0)) return 99;
    return Math.abs(20 * (Math.log(a / b) / Math.LN10));
  }

  /* ---- ★ v1.20.0：同专辑相邻（元数据兜底）----
   *
   * 音频检测需要 A 的缓冲：流式 A 还没补成缓冲时测不了（第一首常见）。
   * `player.addListElement` 的歌单条目里有 `album` / `artist`（真机 JSON 已确认），
   * 同一张专辑 **且在列表里相邻** → 当成连续母带处理，保持 0s 原样。
   * 再要求 B 的开头没有静音（`trim.start ≤ 20ms`）—— 普通专辑曲间有留白时不会命中。
   */
  function albumKeyOf(trackId) {
    var list = S.playlist;
    if (!list || !list.length || trackId === null || trackId === undefined) return null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || trackIdOf(e.id) !== trackId) continue;
      var al = e.album || (e.al && e.al.name) || "";
      var ar = e.artist || "";
      if (!ar && e.ar && e.ar.length) {
        var names = [];
        for (var k = 0; k < e.ar.length; k++) names.push((e.ar[k] && e.ar[k].name) || "");
        ar = names.join("/");
      }
      if (!al) return null;
      return { album: String(al), artist: String(ar), key: String(al) + "|" + String(ar) };
    }
    return null;
  }

  /** 同一个专辑 + 列表相邻 → { album }；否则 null */
  function sameAlbumAdjacent(aId, bId) {
    var ia = playlistIndex(aId);
    var ib = playlistIndex(bId);
    if (ia < 0 || ib < 0 || Math.abs(ia - ib) !== 1) return null;
    var ka = albumKeyOf(aId);
    var kb = albumKeyOf(bId);
    if (!ka || !kb || ka.key !== kb.key) return null;
    return { album: ka.album, artist: ka.artist };
  }

  /**
   * 这一次是不是「连续母带」的一对？（两边都必须是已解码缓冲）
   * @returns null 或 { aTail, bHead, db }
   */
  function detectContinuousPair(aBuf, bBuf, trimA, trimB) {
    if (!continuousEnabled()) return null;
    if (!aBuf || !bBuf || typeof aBuf.getChannelData !== "function" || typeof bBuf.getChannelData !== "function") {
      // 流式 A 没有 AudioBuffer：测不了（日志里说清楚，免得看起来像"没生效"）
      try {
        if (typeof window !== "undefined" && window && window.__gpContDebug) {
          var k0 = "nb|" + S.curTrackId;
          if (S.__contDbgSig !== k0) {
            S.__contDbgSig = k0;
            log("[cont] A 没有缓冲（流式）→ 这一跳测不了连续母带");
          }
        }
      } catch (e0) {}
      return null;
    }
    var durA = Number(aBuf.duration) || 0;
    var durB = Number(bBuf.duration) || 0;
    if (!(durA > 5) || !(durB > 5)) return null;
    var endA = durA - ((trimA && trimA.end) || 0);
    var startB = (trimB && trimB.start) || 0;
    if (!(endA > 1) || !(startB < durB - 1)) return null;
    var aTail = rmsOf(aBuf, endA - 0.25, 0.25);
    var bHead = rmsOf(bBuf, startB, 0.25);
    var aMean = rmsMean(aBuf);
    var bMean = rmsMean(bBuf);
    var db = dbDiff(aTail, bHead);
    var why = "";
    if (!(aTail > CONT_RMS_MIN)) why = "A 尾太轻";
    else if (!(bHead > CONT_RMS_MIN)) why = "B 头太轻";
    else if (aTail < aMean * CONT_QUIET_RATIO) why = "A 在淡出";
    else if (bHead < bMean * CONT_QUIET_RATIO) why = "B 在淡入";
    else if (((trimA && trimA.end) || 0) > CONT_SILENCE_SEC) why = "A 尾部有静音";
    else if (startB > CONT_SILENCE_SEC) why = "B 头部有静音";
    else if (db > CONT_LEVEL_DB) why = "电平差 " + db.toFixed(1) + "dB 太大";
    // ★ v1.20.0：诊断日志常开（同一对歌只记一次）—— 连续母带没命中时能直接看出是哪条没过
    try {
      var sig = S.curTrackId + "|" + (aTail.toFixed(4) + bHead.toFixed(4) + (why || "cont"));
      if (S.__contDbgSig !== sig) {
        S.__contDbgSig = sig;
        log(
          "[cont] A尾=" + aTail.toFixed(4) + "（均值 " + aMean.toFixed(4) + "）｜ B头=" + bHead.toFixed(4) +
            "（均值 " + bMean.toFixed(4) + "）｜ trim=" + ((trimA && trimA.end) || 0).toFixed(3) + "/" + startB.toFixed(3) +
            " ｜ 电平差 " + db.toFixed(1) + "dB ｜ " + (why ? "不连续：" + why : "连续")
        );
      }
    } catch (eD) {}
    if (why) return null;
    return { aTail: aTail, bHead: bHead, db: db };
  }

  /** ★ v1.6.1：头窗/尾窗 BPM 允许差多少（超过就以头窗为准，并且这次不硬对齐） */
  var BEAT_BPM_MISMATCH = 0.08;

  /**
   * ★ v1.6.1：同一首歌的头窗与尾窗可能测出**两个不同的 BPM**
   *   （真机例子：头 120.5 置信 0.65 / 尾 157.0 置信 0.33 —— 尾窗那段大概率没有稳定鼓点）。
   * 这种时候尾窗只能「借」它的相位去定位末拍，**BPM 一律以头窗为准**；
   * 同时把置信压到很低，让 mixPlan 退回 plain —— 宁可不对齐，也不要照错的 BPM 硬贴。
   */
  /**
   * ★ v1.9.2：把上面的判定抽成**纯函数**（输入 head/tail 两个网格，输出收敛后的结论），
   *   这样验证台可以直接喂人造网格去测「一致 / 整数倍 / 真不一致」三条分支，
   *   不用去凑一个恰好能让检测器报出 85 BPM 的音频。
   * @returns {status:"agree"|"octave"|"mismatch"|"none", ratio, conf}
   */
  function reconcileGrids(head, tail) {
    if (!head || !tail || !(head.bpm > 0) || !(tail.bpm > 0)) return { status: "none" };
    var dev = Math.abs(tail.bpm - head.bpm) / head.bpm;
    if (dev <= BEAT_BPM_MISMATCH) {
      var agreeConf = Math.min(1, Math.max(head.conf || 0, tail.conf || 0) + 0.1);
      if (agreeConf > (tail.conf || 0)) tail.conf = agreeConf;
      tail.tempoAgree = true;
      return { status: "agree", ratio: tail.bpm / head.bpm, conf: tail.conf };
    }
    var ratios = [2, 3];
    for (var ri = 0; ri < ratios.length; ri++) {
      var R = ratios[ri];
      // ⚠️ 放宽到 8%：真机那对是「尾 85.0 vs 头 160.1」，85×2=170 与 160 差 6% ——
      //   严格按 4% 就抓不到这种最常见的「半速」误判。
      var devUp = Math.abs(tail.bpm * R - head.bpm) / head.bpm;
      var devDown = Math.abs(tail.bpm - head.bpm * R) / head.bpm;
      if (devUp <= 0.08 || devDown <= 0.08) {
        var tailBpmO = tail.bpm;
        var octConf = Math.min(1, Math.max(head.conf || 0, tail.conf || 0) * 0.9);
        tail.bpm = head.bpm;
        tail.beatSec = 60 / head.bpm;
        var durO = Number(tail.dur || head.dur || 0);
        if (durO > 0) {
          var tO = Math.max(0, durO - 0.2);
          tail.endBeatSec = head.anchorSec + Math.round((tO - head.anchorSec) / tail.beatSec) * tail.beatSec;
        }
        tail.tempoFromHead = true;
        tail.tempoOctave = R;
        tail.conf = Math.max(0.25, octConf);
        return { status: "octave", ratio: R, from: tailBpmO, conf: tail.conf };
      }
    }
    var tailBpm = tail.bpm;
    var tailConf = tail.conf;
    tail.bpm = head.bpm;
    tail.beatSec = 60 / head.bpm;
    // ★ v1.8.0（#10）：**不再把置信永久压死**（那样这首歌此后永远不参与对齐/拉伸）。
    //   正确做法：BPM 用头窗，**末拍位置**也用「头窗的锚点 + 头窗的拍长」重新外推到结尾，
    //   置信只按两边较好的那个打个折 —— 这样它仍然能参与贴拍，只是不如头尾一致的歌那么硬。
    var dur = Number(tail.dur || head.dur || 0);
    if (dur > 0) {
      var tt = Math.max(0, dur - 0.2);
      tail.endBeatSec = head.anchorSec + Math.round((tt - head.anchorSec) / tail.beatSec) * tail.beatSec;
    }
    tail.tempoFromHead = true;
    tail.conf = Math.max(0.2, Math.min(Math.max(head.conf || 0, tailConf || 0) * 0.85, 0.7));
    return { status: "mismatch", from: tailBpm, conf: tail.conf };
  }

  function reconcileTempo(trackId) {
    try {
      var cache = beatCache();
      var head = cache[trackId + "|head"];
      var tail = cache[trackId + "|tail"];
      if (!head || !tail || !(head.bpm > 0) || !(tail.bpm > 0)) return;
      if (tail.tempoFixed) return;
      tail.tempoFixed = true;
      var before = { bpm: tail.bpm, conf: tail.conf };
      var r = reconcileGrids(head, tail);
      if (r.status === "agree") {
        log("[beat] 头尾一致（" + head.bpm.toFixed(1) + "bpm）→ 置信互证 " + Number(r.conf || 0).toFixed(2));
      } else if (r.status === "octave") {
        log(
          "[beat] 头尾成 " + r.ratio + " 倍关系（尾 " + Number(r.from || 0).toFixed(1) + " vs 头 " +
            head.bpm.toFixed(1) + "）→ 同一速度的不同拍级，BPM 取头窗，置信 " + Number(r.conf || 0).toFixed(2)
        );
      } else if (r.status === "mismatch") {
        log(
          "[beat] ★ 头尾 BPM 不一致（尾 " + Number(r.from || 0).toFixed(1) + " / 置信 " +
            Number(before.conf || 0).toFixed(2) + " vs 头 " + head.bpm.toFixed(1) +
            "）→ BPM 与末拍都按头窗外推，置信折到 " + Number(r.conf || 0).toFixed(2)
        );
      }
    } catch (e) {}
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

  /* ==================== v1.17.0 · 跳过交叉（低置信 / 节奏差）====================
   *
   * 为什么要有它：`plain` 现在会照常做 3 秒等功率交叉。可当两边**速度明显不合**
   * （dev > 6%）时，交叉是两个节奏在打架；当一边**根本测不准**（conf < 0.1）时，
   * 3 秒也糊。这两种情况 20ms 的极短淡比 3 秒交叉好听得多。
   *
   * 判定（Q6）：
   *   - 任一侧没有网格 → no-grid（数据缺失，但听感上同样不该硬贴）；
   *   - min(conf) < 0.1 → low-conf；
   *   - 两侧都可信（min(conf) ≥ 0.2）且 dev > 6% → tempo-far；
   *   - 中间地带（0.1~0.2，dev 小）→ 不跳过，保留普通 3s。
   * 边界：拍点对齐关掉 → 不跳过（否则等于全变硬切）；`__gpSkipBadMix = false` 可关。
   */
  var SKIP_CONF_LOW = 0.1;
  var SKIP_TEMPO_DEV = 0.06;

  function skipMixEnabled() {
    if (!autoMixEnabled()) return false;
    // ★ v1.20.0：默认**关**；只有显式 `__gpSkipBadMix = true` 才启用
    try {
      if (typeof window !== "undefined" && window && window.__gpSkipBadMix === true) return true;
    } catch (e) {}
    return false;
  }

  function skipReasonLabel(r) {
    var k = typeof r === "string" ? r : r && r.reason;
    if (k === "tempo-far") return "节奏差";
    if (k === "low-conf") return "置信低";
    if (k === "no-grid") return "没有拍点";
    return "跳过";
  }

  /**
   * 纯规则：这次该不该跳过（不看开关）。
   * ★ v1.20.0：`dev > 6%` 不再要求「两侧都可信」—— 真机数据里中间地带（conf 0.1~0.2）
   *   恰好是偏差 13~28% 的那批，3 秒交叉就是两个节奏在打架。测不准时的 dev 是噪声，
   *   但「跳过」比「糊在一起」安全。
   * @returns null（不跳过）或 { reason, conf, dev }
   */
  function skipRule(plan, gA, gB) {
    var aOk = gA && gA.bpm > 0;
    var bOk = gB && gB.bpm > 0;
    if (!aOk || !bOk) {
      return {
        reason: "no-grid",
        conf: Math.min(aOk ? gA.conf || 0 : 0, bOk ? gB.conf || 0 : 0),
        dev: plan ? plan.dev : 1,
      };
    }
    var conf = Math.min(gA.conf || 0, gB.conf || 0);
    if (conf < SKIP_CONF_LOW) return { reason: "low-conf", conf: conf, dev: plan ? plan.dev : 1 };
    if (plan && plan.dev > SKIP_TEMPO_DEV) return { reason: "tempo-far", conf: conf, dev: plan.dev };
    return null;
  }

  function skipReason(plan, gA, gB) {
    if (!skipMixEnabled()) return null;
    return skipRule(plan, gA, gB);
  }

  /** ★ v1.20.0：面板显示用（默认开；`__gpSkipBadMix === false` 才关） */
  function skipMixRawOn() {
    try {
      if (typeof window !== "undefined" && window && window.__gpSkipBadMix === true) return true;
    } catch (e) {}
    return false; // ★ v1.20.0：默认关
  }

  function skipReason(plan, gA, gB) {
    if (!skipMixEnabled()) return null;
    return skipRule(plan, gA, gB);
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

  /* ==================== v1.8.2：乐句对齐 / 能量曲线 / 调性 ====================
   * 方法参考 Convx（GPL-3.0）的 BeatGrid.phraseAtOrBeforeMs、EnergyProfile、KeyDetector 概念；
   * **代码为本项目独立实现**（MIT 项目不吸收 GPL 代码）。
   */

  /** 乐句长度（拍）。16 拍 = 4 小节 4/4 —— 流行乐最常见的段落单位 */
  var BEATS_PER_PHRASE = 16;
  /** B 的入点允许往回贴到乐句头的最多拍数（往回 = 多吃一点前奏，交叉里无害） */
  var PHRASE_ENTRY_TOL_BEATS = 2;
  /** A 的 mix-out 允许为对齐乐句头而提前的最多拍数 */
  var PHRASE_MIXOUT_MAX_BEATS = 8;

  /**
   * ★ v1.9.2：**A 提前收尾**（DJ 做法）—— 在乐句头/掉点处就把 A 收掉，少播最后几秒，
   * 让淡出边界落在音乐点上，而不是「歌放完了才开始淡」。
   * 它会改变「这首歌是否放完」→ 有开关（`window.__gpEarlyOut = false` 关），再加一道绝对上限。
   */
  var EARLY_OUT_MAX_SEC = 8;

  function earlyOutEnabled() {
    try {
      if (typeof window !== "undefined" && window && window.__gpEarlyOut === false) return false;
    } catch (e) {}
    return true;
  }

  function beatAtOrAfter(grid, pos) {
    if (!grid || !(grid.bpm > 0)) return pos;
    var beat = grid.beatSec;
    return grid.anchorSec + Math.ceil((pos - grid.anchorSec) / beat - 1e-6) * beat;
  }

  function phraseAtOrBefore(grid, pos) {
    if (!grid || !(grid.bpm > 0)) return pos;
    var ph = grid.beatSec * BEATS_PER_PHRASE;
    return grid.anchorSec + Math.floor((pos - grid.anchorSec) / ph + 1e-6) * ph;
  }

  function phraseAtOrAfter(grid, pos) {
    if (!grid || !(grid.bpm > 0)) return pos;
    var ph = grid.beatSec * BEATS_PER_PHRASE;
    return grid.anchorSec + Math.ceil((pos - grid.anchorSec) / ph - 1e-6) * ph;
  }
  /** ★ v1.8.2：outro 掉点最多允许提前多少秒（再多就不像「自然的收尾」了） */
  var OUTRO_PULL_MAX_SEC = 25;
  /** ★ v1.8.2：掉点的最小能量比（前 2s / 后 2s）；低于它就当没有掉点 */
  var OUTRO_DROP_MIN_RATIO = 1.8;
  /** ★ v1.8.2：能量曲线的粒度（每秒一个值） */
  var ENERGY_PROFILE = {}; // trackId -> { buf: Uint8Array, dur, at }

  function cacheEnergy(trackId) {
    try {
      if (Object.prototype.hasOwnProperty.call(ENERGY_PROFILE, trackId)) return ENERGY_PROFILE[trackId];
    } catch (e) {}
    return null;
  }

  /**
   * ★ v1.8.2：每秒一个能量值（0..255）。
   * 为什么要它：真实曲子的收尾常常是「最后一段副歌 → 掉下来 → 渐弱」，
   * 在**掉下来的那一下**混出去，听感比「按剩余秒数硬切」自然得多。
   * 计算很便宜：每隔 ~200 个采样取一个点算 RMS，一首歌几万次乘法。
   */
  function buildEnergyProfile(trackId, ab, dur) {
    if (!(dur > 4) || trackId === null || trackId === undefined) return null;
    var hit = cacheEnergy(trackId);
    if (hit && Math.abs(hit.dur - dur) < 0.5) return hit.buf;
    // ★ v1.10.0：流式 A 没有 buffer → 用落盘的能量曲线（outro 掉点候选照样能用）
    if (!ab) return analysisEnergy(trackId, dur);
    var sr = Number(ab.sampleRate) || 48000;
    var nch = Math.min(2, Number(ab.numberOfChannels) || 1);
    var seconds = Math.max(1, Math.floor(dur));
    var stride = Math.max(1, Math.floor(sr * 0.05)); // 50ms 一个采样点
    var perSec = Math.max(1, Math.round(sr / stride));
    var prof = new Uint8Array(seconds);
    var peak = 0;
    for (var s = 0; s < seconds; s++) {
      var sum = 0;
      var cnt = 0;
      for (var k = 0; k < perSec; k++) {
        var base = (s * perSec + k) * stride;
        if (base >= ab.length) break;
        var win = Math.min(stride, ab.length - base);
        // ★ v1.8.2：窗内多点取样（每 4 个取一个）—— 只取单点的话，
        //   一旦信号周期正好是步长的整数倍，就会一直取到同一个相位（全 0），能量被判成 0。
        var acc = 0;
        var got = 0;
        for (var j = 0; j < win; j += 4) {
          var idx = base + j;
          var v = 0;
          for (var c = 0; c < nch; c++) {
            var d = ab.getChannelData(c);
            v += d ? d[idx] || 0 : 0;
          }
          v /= nch;
          acc += v * v;
          got++;
        }
        if (!got) continue;
        sum += acc / got;
        cnt++;
      }
      var rms = cnt ? Math.sqrt(sum / cnt) : 0;
      var v8 = Math.round(Math.min(1, rms * 4) * 255); // ×4 提一下灵敏度（音乐 RMS 通常 < 0.25）
      prof[s] = v8;
      if (v8 > peak) peak = v8;
    }
    if (!(peak > 0)) return null;
    ENERGY_PROFILE[trackId] = { buf: prof, dur: dur, at: Date.now() };
    // ★ v1.10.0：能量曲线也落盘（1 字节/秒，一首 200~400 字节）
    analysisNoteEnergy(trackId, dur, prof);
    // 只留最近 4 首（每秒 1 字节，202s 的歌 = 202 字节，几乎不占内存）
    var keys = [];
    for (var kk in ENERGY_PROFILE) if (Object.prototype.hasOwnProperty.call(ENERGY_PROFILE, kk)) keys.push(kk);
    if (keys.length > 4) {
      keys.sort(function (a, b) { return (ENERGY_PROFILE[a].at || 0) - (ENERGY_PROFILE[b].at || 0); });
      for (var d2 = 0; d2 < keys.length - 4; d2++) delete ENERGY_PROFILE[keys[d2]];
    }
    return prof;
  }

  /**
   * ★ v1.8.2：找「outro 掉点」—— 在最后 OUTRO_PULL_MAX_SEC 秒里，
   * 找一个「前 2 秒明显比后 2 秒响」的位置（能量比最大者）。
   * @returns 可听时间轴上的秒数；找不到返回 null
   */
  function outroDropSec(trackId, ab, dur) {
    try {
      var prof = buildEnergyProfile(trackId, ab, dur);
      if (!prof) return null;
      var secs = prof.length;
      if (secs < 20) return null;
      var from = Math.max(2, secs - OUTRO_PULL_MAX_SEC);
      var best = -1;
      var bestRatio = 0;
      for (var s = from; s < secs - 3; s++) {
        var pre = 0;
        var post = 0;
        for (var i = 0; i < 2; i++) {
          pre += prof[s - 1 - i] || 0;
          post += prof[s + 1 + i] || 0;
        }
        if (pre < 12) continue; // 本来就很安静 → 不是「掉下来」
        var ratio = pre / Math.max(6, post);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = s;
        }
      }
      if (best < 0 || bestRatio < OUTRO_DROP_MIN_RATIO) return null;
      return best;
    } catch (e) {
      return null;
    }
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

  /* ★ v1.8.1：拍点判定的一组常量（速度先验 / 亚帧细化 / 瞬态密度）
   *   方法参考：Convx（GPL-3.0）的 BeatTracker 概念 —— **只借鉴思路，代码为本项目独立实现**。
   *   （MIT 项目不能直接拷贝 GPL 代码；算法与数学方法本身不受版权保护。） */
  var BEAT_PREFERRED_BPM = 120; // 速度先验的中心
  var BEAT_PRIOR_OCTAVES = 0.9; // 先验的宽度（八度）—— 只要「轻微」加权
  var BEAT_REFINE_STEPS = 40; // 细网格步数（±2%）
  var BEAT_REFINE_FRACTION = 0.0005; // 每步 0.05%
  var BEAT_TRANSIENT_JUMP = 0.5; // 包络相对基线跳多少算一次瞬态
  var BEAT_DENSITY_MIN = 0.004; // 低于它 → 完全不可信
  var BEAT_DENSITY_FULL = 0.015; // 高于它 → 完全可信



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

    // ★ v1.8.2：再从「拍点」往回收一点，尽量落在**乐句头**（16 拍 = 4 小节）。
    //   对 B 的入点来说，往前收 = 多吃一点前奏，这段在交叉里本来就被淡入盖住，无害；
    //   反过来（往后贴到下一个乐句头）会白吃 1~16 拍，所以只往前收，且最多 2 拍。
    var onPhrase = false;
    if (!silenceOnly && grid && grid.bpm > 0) {
      var pb = phraseAtOrBefore(grid, off);
      var back = off - pb;
      if (back >= 0 && back <= PHRASE_ENTRY_TOL_BEATS * beat && pb >= from - 1e-6) {
        off = pb;
        onPhrase = true;
      }
    }

    // ③ 跳太多就不跳
    var skip = off - start;
    if (!(skip >= 0) || skip > cap + 1e-6) {
      return { offset: start, skip: 0, reason: "跳过 " + skip.toFixed(2) + "s 超出上限" };
    }
    var reason;
    if (skip < 0.02) reason = onBeat || onPhrase ? "本来就在拍上" : "起点即拍点";
    else if (gapCapped) reason = "空白比上限还长 → 只跳到第一拍";
    else if (gap >= 0.25) reason = "跳过 " + gap.toFixed(2) + "s 空白，落到第一拍";
    else reason = "对齐到第一拍";
    return { offset: off, skip: skip, reason: reason, onPhrase: onPhrase };
  }

  /* ==================== v1.7.0 · C：WSOLA 保音高变速（接拍对齐）==================== */

  /**
   * WSOLA（Waveform Similarity Overlap-Add）：**变速不变调**。
   *
   * 为什么需要它：两首歌 BPM 不同时，只对齐入点是不够的 —— 交叉期间两边鼓点会互相错开。
   * 真正的做法是把 B 加速/减速 r 倍（r = A.bpm / B.bpm），而直接改 `playbackRate` 会**变调**，
   * 所以要用「改时间不改音高」的算法：分帧 → 在 ±搜索窗内找波形最相似的位置 → 重叠相加。
   *
   * ★ 只处理「交叉那一小段」（几秒），不处理整首 —— 成本从十亿级降到千万级。
   * ★ 相关性用**降采样后的单声道**算，找到的偏移同时套到所有声道（左/右不错位）。
   *
   * @param chs   [{Float32Array}, ...] 各声道输入（等长）
   * @param speed 播放速度倍数（>1 变快、输出更短；<1 变慢、输出更长）
   * @returns {out: [Float32Array...], outLen, frames}
   */
  function wsolaStretch(chs, speed, opts) {
    var o = opts || {};
    var sr = Number(o.sr) || 48000;
    var speed2 = Number(speed);
    if (!(speed2 > 0.5) || speed2 > 2) speed2 = 1;
    var nch = (chs && chs.length) || 0;
    if (!nch) return { out: [], outLen: 0, frames: 0 };
    var len = chs[0].length;
    if (!(len > 0)) return { out: chs.map(function () { return new Float32Array(0); }), outLen: 0, frames: 0 };

    var N = Math.max(64, Math.round((o.frameMs || 30) * sr / 1000)); // 帧长
    var Hs = Math.max(32, Math.round(N / 2)); // 合成跳距（50% 重叠）
    var D = Math.max(8, Math.round((o.searchMs || 6) * sr / 1000)); // 搜索半径
    var outLen = Math.max(1, Math.round(len / speed2));
    var Ha = Math.max(1, Math.round(Hs * speed2)); // 分析跳距
    var ov = N - Hs; // 重叠长度

    // 降采样单声道导引（相关性只在它上面算，省 4 倍运算）
    var dec = 4;
    var mlen = Math.floor(len / dec);
    var mono = new Float32Array(mlen);
    for (var i = 0; i < mlen; i++) {
      var sum = 0;
      var base = i * dec;
      for (var c0 = 0; c0 < nch; c0++) sum += chs[c0][base] || 0;
      mono[i] = sum / nch;
    }

    var win = new Float32Array(N);
    for (var w = 0; w < N; w++) win[w] = 0.5 - 0.5 * Math.cos((2 * Math.PI * w) / (N - 1)); // Hann

    var out = [];
    for (var c = 0; c < nch; c++) out.push(new Float32Array(outLen));
    var wsum = new Float32Array(outLen);

    var ovD = Math.max(4, Math.round(ov / dec)); // 重叠区在降采样域的长度
    var prevStart = 0;
    var frames = 0;
    for (var k = 0; k * Hs < outLen; k++) {
      var nominal = Math.round(k * Ha);
      var bestStart = nominal;
      if (k > 0) {
        var from = Math.max(0, nominal - D);
        var to = Math.min(len - N, nominal + D);
        var refBase = prevStart + Hs; // 上一帧「本该接下去」的位置
        var refD = Math.round(refBase / dec);
        var best = -Infinity;
        for (var s = from; s <= to; s += 1) {
          var sD = Math.round(s / dec);
          if (sD + ovD > mlen || refD + ovD > mlen) break;
          var corr = 0;
          for (var j = 0; j < ovD; j++) corr += mono[sD + j] * mono[refD + j];
          if (corr > best) {
            best = corr;
            bestStart = s;
          }
        }
      } else {
        bestStart = Math.max(0, Math.min(nominal, len - N));
      }
      if (bestStart < 0) bestStart = 0;
      if (bestStart + N > len) bestStart = Math.max(0, len - N);

      // 重叠相加（各声道用同一个偏移）
      for (var c2 = 0; c2 < nch; c2++) {
        var src = chs[c2];
        var dst = out[c2];
        for (var t = 0; t < N; t++) {
          var oi = k * Hs + t;
          if (oi >= outLen) break;
          var si = bestStart + t;
          if (si >= len) break;
          dst[oi] += src[si] * win[t];
        }
      }
      for (var t2 = 0; t2 < N; t2++) {
        var oi2 = k * Hs + t2;
        if (oi2 < outLen) wsum[oi2] += win[t2];
      }
      prevStart = bestStart;
      frames++;
    }

    // 归一化（Hann 50% 重叠的和约等于 1，但仍按实际权重除一次，避免端部衰减）
    for (var c3 = 0; c3 < nch; c3++) {
      var d3 = out[c3];
      for (var i3 = 0; i3 < outLen; i3++) {
        var ws = wsum[i3];
        if (ws > 1e-6) d3[i3] /= ws;
      }
    }
    return { out: out, outLen: outLen, frames: frames };
  }

  /**
   * ★ v1.7.0（C）：算出「拉伸过的交叉段」AudioBuffer。
   *
   * 只取 B 的 `headSrc` 秒（= 交叉时长 × 比例）做 WSOLA，输出正好 `fadeSec` 秒：
   *   [B 的头 headSrc 秒] --拉伸--> 播 fadeSec 秒
   * 之后从原始缓冲的 `entry.offset + headSrc` 处接回未拉伸的 B（见调度处）。
   *
   * @returns {buffer, outLen, consumed, ratio} 或 null（数据不够 / 算失败）
   */
  function buildStretchedHead(buf, btrim, entry, sp, fadeSec) {
    if (!buf || !S.ctx) return null;
    var sr = Number(buf.sampleRate) || 48000;
    var nch = Math.min(2, Number(buf.numberOfChannels) || 1);
    var startIn = Number(entry && entry.offset) || Number(btrim && btrim.start) || 0;
    // ★ v1.8.0（#9）：多取 0.25s 余量 —— WSOLA 输出长度由比例取整决定，余量让我们能**裁到正好 fadeSec**
    var srcLen = Math.max(1, Math.round((sp.headSrc + 0.25) * sr));
    if (!(buf.length > startIn + srcLen + sr * 0.05)) return null; // B 太短，不值得拉
    var chs = [];
    for (var c = 0; c < nch; c++) {
      var d = buf.getChannelData(c);
      if (!d) return null;
      chs.push(d.subarray(startIn, startIn + srcLen));
    }
    var outLen = Math.max(1, Math.round(fadeSec * sr));
    var t0 = performance.now();
    var r = wsolaStretch(chs, sp.ratio, { sr: sr, frameMs: 30, searchMs: 6 });
    if (!r || !r.outLen) return null;
    if (r.outLen < outLen) return null; // 余量不够（不该发生）→ 退回普通交叉
    var n = outLen; // ★ v1.8.0（#9）：裁到正好 fadeSec，接续段才会落在 A 结束那一刻
    if (n < sr * 0.1) return null;
    var ab = S.ctx.createBuffer(nch, n, sr);
    for (var c2 = 0; c2 < nch; c2++) {
      var dst = ab.getChannelData(c2);
      if (!dst || !dst.set) return null;
      dst.set(r.out[c2].subarray(0, n));
    }
    log(
      "[stretch] ★ 拉 " + ((sp.ratio - 1) * 100).toFixed(2) + "% ｜ 交叉段 " + fadeSec.toFixed(2) +
        "s ｜ 消耗 B " + sp.headSrc.toFixed(2) + "s ｜ " + (performance.now() - t0).toFixed(0) + "ms"
    );
    return { buffer: ab, outLen: n / sr, consumed: sp.headSrc, ratio: sp.ratio };
  }


  var STRETCH_MAX_DEV = 0.06;
  /** ★ v1.7.0：最短小于这个值就不值得拉（听不出来） */
  var STRETCH_MIN_RATIO = 0.002;
  /** ★ v1.8.0（#12）：最长拉多长的交叉段（48kHz 立体声实测：8s≈91ms、12s≈137ms） */
  var STRETCH_MAX_SEC = 12;
  /** ★ v1.8.0（#13）：超过这个时长算「长交叉」——比例误差会被放大，要求更高置信 */
  var STRETCH_LONG_SEC = 6;
  var STRETCH_LONG_CONF = 0.45;

  /**
   * 决定「要不要为这次交叉做变速」，以及拉多少。
   * @param gA A 的网格（尾窗）、gB B 的网格（头窗）
   * @param fadeSec 交叉时长
   * @returns {ok, ratio, headOut, headSrc, conf, reason}
   */
  /**
   * ★ v1.9.1：把「交叉时长」量化到音乐上有意义的长度（拍 / 小节）。
   *
   * 现在用户和风格给的是**秒**（2.5s、3s），跟拍子没关系；DJ 的交叉是「4 拍 / 8 拍 / 2 小节」。
   * 所以按 A 的 BPM 折成候选（半小节 / 1 / 2 / 4 / 8 小节），取最近的一个。
   *
   * 两条边界：
   *   ① **只在偏差 ≤35% 时才换** —— 用户设的 3s 变成 7.5s 就是「改设定」而不是「对齐」了；
   *   ② 量化后仍受 12s 上限约束；拍点不可信（conf < 0.3）或 BPM 离谱 → 原样返回。
   *
   * 意义：交叉的**长度**成了整拍；再配合「起点吸拍」（v1.5.0）+「B 入点落乐句头」（v1.8.2），
   *   一次过渡的三个量就都在拍子上了。
   *   ⚠️ 顺序是「先量化长度、后吸起点」——吸起点会把长度再挪动 ≤ 半拍（终点固定在 A 的结尾）。
   *   顺带一个好处：长度是整拍 A → `headSrc = fadeSec × ratio` 也是整拍 B，
   *   所以 WSOLA 拉伸段结束、接回原缓冲的那一刻，B 的拍子也是对齐的。
   */
  function quantizeXfadeSec(xf, grid) {
    if (!(xf > 0)) return xf;
    if (!grid || !(grid.bpm > 0) || !(grid.conf >= 0.3)) return xf;
    var beat = 60 / grid.bpm;
    if (!(beat > 0.05) || beat > 2) return xf; // BPM 离谱（<30 或 >1200）→ 不参与
    // ★ 量化到「整拍」。为什么不强制整小节：用户设的是秒（2.5 / 3 / 10），
    //   强行折成 4 拍/8 拍会把 3s 变成 2s 或 4s —— 那是改设定，不是对齐。
    //   整拍已经够了：它同时让「拉伸段消耗的 B 也是整拍」，两边的拍子才能一路对齐下去。
    var n = Math.round(xf / beat);
    if (!(n >= 1)) n = 1;
    var len = n * beat;
    if (len > 12) return xf; // 超过交叉上限就不换
    if (Math.abs(len - xf) / xf > 0.15) return xf; // 差超过 15% → 保用户设的那个
    return Math.round(len * 100) / 100;
  }

  function stretchPlan(gA, gB, fadeSec) {
    if (!gA || !gB || !(gA.bpm > 0) || !(gB.bpm > 0)) return { ok: false, ratio: 1, reason: "缺拍点网格" };
    if (!(fadeSec > 0.3)) return { ok: false, ratio: 1, reason: "没有交叉可拉" };
    var conf = Math.min(gA.conf, gB.conf);
    if (conf < 0.2) return { ok: false, ratio: 1, conf: conf, reason: "置信太低（" + conf.toFixed(2) + "）" };

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
    if (bestDev > STRETCH_MAX_DEV) {
      return { ok: false, ratio: best, conf: conf, reason: "BPM 偏差 " + (bestDev * 100).toFixed(1) + "% 超出 ±6%" };
    }
    if (Math.abs(best - 1) < STRETCH_MIN_RATIO) {
      return { ok: false, ratio: best, conf: conf, reason: "本来就同步，不需要拉伸" };
    }
    // ★ v1.8.0（#13）：交叉越长，BPM 的那点误差被放大得越多（10 秒里 1% 就是 100ms）
    //   → 长交叉要求更高置信，否则宁可不对齐。
    if (fadeSec > STRETCH_LONG_SEC && conf < STRETCH_LONG_CONF) {
      return {
        ok: false,
        ratio: best,
        conf: conf,
        reason: "长交叉 " + fadeSec.toFixed(1) + "s 但置信只有 " + conf.toFixed(2) + "，怕越拉越错"
      };
    }
    return {
      ok: true,
      ratio: best,
      conf: conf,
      dev: bestDev,
      headOut: fadeSec, // 输出（时间轴）长度 = 交叉时长
      headSrc: fadeSec * best, // 需要消耗的 B 输入长度
      reason: "拉伸 " + ((best - 1) * 100).toFixed(2) + "%",
    };
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
      log("[autoplay] ★ 交回 Web Audio 引擎");
      // ★ v1.7.2（#2）：先把「当前这首」预下起来；解码好了就把它从原生手里接过来，
      //   这样它的尾巴归我们 → 切到下一首时才有交叉/接拍（否则首曲只能硬切）。
      try {
        maybePreload();
        tryTakeoverCurrent("拿到手势");
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
    // ★ v1.7.2（#2）：原生在响时，顺手把**原生报上来的播放位置**记下来（接管当前这首要用）。
    //   做法：把客户端的回调包一层（S.__cbSwap 会让拦截器把包装后的回调交给原生），
    //   这样客户端的轮询就顺便成了我们的「原生位置探针」。
    if ((S.deferNative || S.nativeRunning) && typeof cb === "function" &&
        (name === "audioplayer.getPlayedTime" || name === "audioplayer.getPlaybackInfo")) {
      var __posCb = cb;
      S.__cbSwap = function (res) {
        try {
          if (res && isFinite(res.playedTime)) {
            S.nativePosMs = Number(res.playedTime) || 0;
            S.nativePosAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
          }
        } catch (e) {}
        try {
          return __posCb.apply(null, arguments);
        } catch (e) {}
      };
    }    // ★ v0.4.0：逃生开关 —— `window.__gpNativeAll = true` 时把播放整条交回原生。
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
        // ★ v1.8.6：客户端在**用户手选/点下一首**之前会先发 stop（自然播完不会发）。
        //   notePrediction 靠它把「用户跳的」从「随机播放押不中」里摘出去。
        S.lastUserStopAt = performance.now();
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
          // ★ v1.6.1：N+2 的字节抓取同理 —— 那首不在新列表里就掐掉，别白下
          if (S.prefetch && !playlistHas(S.prefetch.trackId)) {
            var dead2 = S.prefetch.trackId;
            if (S.prefetch.abort) {
              try {
                S.prefetch.abort.abort();
              } catch (e) {}
            }
            S.prefetch = null;
            log("[prefetch] N+2 的 " + dead2 + " 不在新歌单里 → 作废（已掐断）");
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
  /**
   * ★ v1.13.0：把「上一次真实过渡」压成一句话（状态行与面板共用）。
   * 只描述**已经排上的那一次**：设定值在别处（`过渡=交叉 3.0s`），这里是实际发生了什么。
   */
  function mixSummary() {
    var m = S.lastMix;
    if (!m) return "";
    if (m.continuous) return m.album ? "保持原样 · 同专辑连续" : "保持原样 · 连续母带";
    if (!(m.fadeSec > 0)) return "";
    if (m.skip) return "跳过 · " + skipReasonLabel(m.skipReason);
    var s = "本次 " + Number(m.fadeSec).toFixed(2) + "s";
    if (m.tier && m.tier !== "plain") s += " · " + m.tier;
    if (m.beats > 0 && Math.abs(m.beats - Math.round(m.beats)) < 0.03) {
      s += " · " + Math.round(m.beats) + " 拍";
    }
    if (m.aBpm > 0 && m.bBpm > 0) s += " · " + Math.round(m.aBpm) + "→" + Math.round(m.bBpm);
    if (m.earlyCut > 0.05) s += " · A 收尾 -" + m.earlyCut.toFixed(1) + "s";
    if (m.stretchRatio && Math.abs(m.stretchRatio - 1) > 0.001) {
      s += " · 拉伸 " + ((m.stretchRatio - 1) * 100).toFixed(1) + "%";
    }
    return s;
  }

  /**
   * ★ v1.14.0：面板顶部大卡用的「本次交叉」两行数据（大数字 + 一行细节）。
   */
  /* ★ v1.20.0：面板顶部一张卡片 = 上一次真实过渡（大数字 + 横向排列的小项） */
  function fmtDur(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function heroCardModel() {
    var xf = effectiveXfade();
    var m = S.lastMix;
    if (!m) {
      return {
        cap: "本次交叉",
        num: xf.sec > 0 ? "—" : "干净",
        items: [xf.sec > 0 ? "尚未过渡" : "交叉已关闭"],
      };
    }
    if (!(m.fadeSec > 0) && !m.continuous) {
      return { cap: "本次交叉", num: "—", items: ["尚未过渡"] };
    }
    var num;
    var items = [];
    if (m.skip) {
      num = "跳过";
      items = [skipReasonLabel(m.skipReason), "20ms 极短淡"];
    } else if (m.continuous) {
      num = "原样";
      items = [m.album ? "同专辑" : "连续母带", "0s 接缝"];
    } else {
      num = Number(m.fadeSec).toFixed(2) + "s";
      items.push(m.tier === "full" ? "full" : m.tier === "smart" ? "smart" : "plain");
      var beats = Math.round(m.beats || 0);
      if (beats > 0) items.push(beats + " 拍");
      if (m.aBpm > 0 || m.bBpm > 0) {
        items.push((m.aBpm ? Math.round(m.aBpm) : "?") + "→" + (m.bBpm ? Math.round(m.bBpm) : "?"));
      }
      items.push(m.curve || "equal");
      if (m.earlyCut > 0.05) items.push("早收 " + m.earlyCut.toFixed(1) + "s");
      if (m.stretchRatio && Math.abs(m.stretchRatio - 1) > 0.002) {
        items.push("拉伸 " + ((m.stretchRatio - 1) * 100).toFixed(1) + "%");
      }
    }
    return { cap: "本次交叉", num: num, items: items };
  }

  function renderHeroCard(numEl, itemsEl, spec) {
    if (numEl) numEl.textContent = spec.num;
    if (!itemsEl) return;
    try {
      while (itemsEl.children && itemsEl.children.length) itemsEl.removeChild(itemsEl.children[0]);
    } catch (e) {}
    for (var i = 0; i < spec.items.length; i++) {
      itemsEl.appendChild(el("span", "gp-chip", spec.items[i]));
    }
  }

  /** ★ v1.20.0：状态行拆成「一项一列」——面板里分列展示，日志/API 仍拼成一行 */
  function statusItems() {
    var xf = effectiveXfade();
    var eng;
    if (passAllToNative()) eng = "原生播（插件已停用）";
    else if (S.deferNative) eng = "原生播（等首次点按）";
    else if (!S.ctx) eng = "未建 AudioContext";
    else eng = "Web Audio" + (S.ctx.state === "running" ? "" : "（" + S.ctx.state + "）");

    // ★ v1.13.0：设定 + 实际。只有设了交叉才谈「本次」；还没过渡过就明说。
    // ★ v1.16.1：智能模式**不再把兜底的 3.0s 摆出来**（它是占位值，不是实际时长）
    var trans =
      xf.sec > 0
        ? xf.smart
          ? "智能交叉（按小节）" + (xf.eq ? " + 扫频" : "")
          : "交叉 " + xf.sec.toFixed(1) + "s" + (xf.eq ? " + 扫频" : "")
        : "干净无缝";
    if (xf.sec > 0) trans += "（" + (mixSummary() || "尚未过渡") + "）";

    var plays = S.stats.plays || 0;
    var hit = (S.stats.hitPreload || 0) + (S.stats.hitRecent || 0);
    var hitText = plays ? Math.round((hit / plays) * 100) + "%（" + hit + "/" + plays + "）" : "—";

    // 「拍点」优先报「分析记录数」（一首一份，比头/尾段数好懂）；没有就退回段数
    var beatText = "关";
    if (autoMixEnabled()) {
      var anaCount = 0;
      try {
        anaCount = analysisStats().count;
      } catch (e) {}
      if (anaCount > 0) {
        beatText = "开（已分析 " + anaCount + " 首）";
      } else {
        var bn = 0;
        var bc = S.beatCache || {};
        for (var bk in bc) {
          if (Object.prototype.hasOwnProperty.call(bc, bk)) bn++;
        }
        beatText = "开（已分析 " + bn + " 段）";
      }
    }

    var items = [
      "引擎=" + eng,
      "过渡=" + trans,
      "拍点=" + beatText,
      "预载命中=" + hitText,
    ];
    // ★ v1.13.0：补算进度（有活才显示，闲着不占地方）
    try {
      var bs = analysisStats();
      if (bs.pending > 0 || bs.done > 0) {
        items.push("补算=剩 " + bs.pending + " 首" + (bs.done ? "（完成 " + bs.done + "）" : ""));
      }
    } catch (e) {}
    return items;
  }

  function statusLine() {
    return statusItems().join(" ｜ ");
  }

  /**
   * ★ v1.8.4：清完缓存**立刻重排预热**。
   *
   * 为什么这件事不能省：以前「清空」只是把内存里的三份数据删掉，然后**什么都不做** ——
   * 于是要等下一次切歌才从头走冷路径（取址 + 下载 + 解码，真机 1398ms，三路并发时 3330ms）。
   * 用户看到的就是「清一下缓存，接下来几首接缝就散了」。
   *
   * 现在：清完当场按 **当前曲目 → 下一首(N+1) → 下下一首(N+2)** 的顺序重新排队，
   * 该下载的下载（走闸门，优先级 0），该落盘的落盘。下一首的余量从 0 恢复到满。
   */
  function rewarm(why) {
    try {
      maybePreload();
    } catch (e) {}
    try {
      maybePrefetchN2();
    } catch (e) {}
    var p = S.preload;
    log(
      "[warm] 重排预热（" + (why || "?") + "）｜ 当前=" + (S.curTrackId === null ? "无" : S.curTrackId) +
        " ｜ 预载槽=" + (p ? p.trackId + "/" + p.status : "空") +
        " ｜ 磁盘=" + (diskEnabled() ? diskCount() + " 首" : "关")
    );
  }

  /**
   * 清掉内存里的三级缓存（面板按钮 + 控制台 API 都用它）。
   *
   * ★ v1.8.4：以前这里只清了 `recentBufs` 和 `BYTES_CACHE`，漏了两处，后果都不轻：
   *   ① `S.warmBytes`（v1.8.0 的单首预热字节，~6MB）没清 → 「清空」其实没清干净，
   *      心跳里的内存统计也还算着它；
   *   ② `S.prefetch` 没清 → 那个槽还记着 `status="bytes"`，而 `maybePrefetchN2()` 的准入条件
   *      是「槽里是它且状态不是 failed」→ **字节已经被删了却再也不重抓**，
   *      N+2 的提前量整整丢一首歌（要等目标换人才自己恢复）。
   *
   * 磁盘缓存**不在这里清**（它就是为了「清内存也不冷启动」才存在的）；
   * 要连盘一起清 → 面板上单独的按钮 / `gaplessPlayer.clearDiskCache()`。
   */
  function clearCaches() {
    var n = (S.recentBufs || []).length;
    S.recentBufs = [];
    for (var k in BYTES_CACHE) {
      if (Object.prototype.hasOwnProperty.call(BYTES_CACHE, k)) delete BYTES_CACHE[k];
    }
    var extra = 0;
    if (S.warmBytes) {
      S.warmBytes = null;
      extra++;
    }
    if (S.prefetch) {
      try {
        if (S.prefetch.abort) S.prefetch.abort.abort();
      } catch (e) {}
      S.prefetch = null;
    }
    log("[ui] 已清空缓存（缓冲 " + n + " 首 + 字节缓存" + (extra ? " + 预热字节" : "") + "）");
    rewarm("清空缓存后");
    return n;
  }

  /** ★ v1.9.4：交叉淡入淡出的开关（面板 / 控制台 `gaplessPlayer.setXfade(true, 3)` 都走这里） */
  function applyStyle(name) {
    // 兼容老调用：setStyle("clean") = 关；其它任何名字 = 打开（默认 3s）
    var on = String(name) !== "clean";
    setXfadeSwitch(on, 0);
    refreshPanel();
    return true;
  }

  /* ---- 面板（自绘 DOM + 一次性注入样式；不依赖客户端 CSS，也不引外部文件） ---- */

  var panel = { box: null, btn: null, css: null, timer: 0 };

  var PANEL_CSS = [
    // ★ v1.14.0：面板重做 —— 344px 玻璃卡片、顶部大号「本次交叉」、分组清晰的开关
    ".gp-card{position:fixed;right:16px;bottom:64px;z-index:2147483000;width:344px;max-height:min(80vh,660px);",
    "overflow:auto;box-sizing:border-box;",
    "background:linear-gradient(180deg,rgba(31,34,41,.98),rgba(21,23,29,.985));color:#e9ecf3;",
    "border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:16px 16px 12px;",
    "font:12px/1.55 -apple-system,'Segoe UI',system-ui,sans-serif;",
    "box-shadow:0 26px 70px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.05);",
    "backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}",
    ".gp-card::-webkit-scrollbar{width:6px}",
    ".gp-card::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}",
    ".gp-head{display:flex;align-items:center;gap:9px;margin-bottom:14px}",
    ".gp-dot{width:8px;height:8px;border-radius:50%;background:#4d7cff;box-shadow:0 0 12px rgba(77,124,255,.9);flex:0 0 auto}",
    ".gp-brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:13.5px;letter-spacing:.2px;flex:1}",
    ".gp-head-sw{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
    ".gp-head-sw-label{font-size:10px;color:#7c8498}",
    // 子标签页（过渡 / 音色 / 缓存）
    ".gp-tabs{display:flex;gap:4px;background:rgba(255,255,255,.05);border-radius:10px;padding:3px;margin-bottom:12px}",
    ".gp-tab{all:unset;flex:1;text-align:center;cursor:pointer;font-size:12px;color:#9aa3b8;padding:6px 0;border-radius:8px;",
    "transition:background .15s,color .15s}",
    ".gp-tab:hover{color:#d6dbe6}",
    ".gp-tab.on{background:rgba(255,255,255,.13);color:#fff}",
    ".gp-ver{font-size:10px;font-weight:500;color:#9aa3b8;background:rgba(255,255,255,.06);",
    "border:1px solid rgba(255,255,255,.07);border-radius:999px;padding:1px 8px}",
    ".gp-x{all:unset;cursor:pointer;width:24px;height:24px;line-height:22px;text-align:center;border-radius:8px;",
    "color:#8b93a7;font-size:17px;transition:background .15s,color .15s}",
    ".gp-x:hover{background:rgba(255,255,255,.1);color:#fff}",
    // 顶部「本次交叉」大卡
    ".gp-hero{border-radius:14px;padding:13px 14px 12px;margin-bottom:10px;",
    "background:radial-gradient(130% 150% at 0% 0%,rgba(77,124,255,.24),rgba(77,124,255,.05) 55%,transparent),rgba(255,255,255,.03);",
    "border:1px solid rgba(255,255,255,.07)}",
    ".gp-hero-cap{font-size:9.5px;letter-spacing:1.6px;text-transform:uppercase;color:#8e97ad;margin-bottom:1px}",
    ".gp-hero-num{font-size:31px;font-weight:700;letter-spacing:-.6px;font-variant-numeric:tabular-nums;color:#fff;line-height:1.15}",
    ".gp-hero-sub{margin-top:4px;color:#a7b0c6;font-size:11px;line-height:1.55}",
    ".gp-status{display:block;color:#7c8498;font-size:10.5px;line-height:1.7;word-break:break-all;margin:0 0 12px}",
    ".gp-sec{margin-bottom:13px}",
    ".gp-cap{font-size:9.5px;letter-spacing:1.6px;text-transform:uppercase;color:#7c8498;margin:0 0 6px 2px}",
    ".gp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 2px}",
    ".gp-row>span:first-child{color:#ccd2df}",
    ".gp-hint{font-size:10.5px;color:#767e92;padding:0 2px 4px}",
    ".gp-val{color:#8e97ad;font-variant-numeric:tabular-nums}",
    ".gp-sw{position:relative;display:inline-block;width:36px;height:21px;border-radius:999px;cursor:pointer;",
    "background:rgba(255,255,255,.13);transition:background .18s;flex:0 0 auto}",
    ".gp-sw>i{position:absolute;top:3px;left:3px;width:15px;height:15px;border-radius:50%;background:#fff;",
    "transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.4)}",
    ".gp-sw.on{background:#3d6ef5}",
    ".gp-sw.on>i{transform:translateX(15px)}",
    // 时长步进器
    ".gp-stepper{display:flex;align-items:center;gap:8px}",
    ".gp-mini{all:unset;cursor:pointer;width:24px;height:24px;line-height:24px;text-align:center;border-radius:7px;",
    "background:rgba(255,255,255,.07);color:#ccd2df;font-size:14px;transition:background .15s,color .15s}",
    ".gp-mini:hover{background:rgba(255,255,255,.14);color:#fff}",
    ".gp-step-val{min-width:78px;text-align:center;color:#e9ecf3;font-variant-numeric:tabular-nums;font-size:11.5px}",
    ".gp-btn{all:unset;cursor:pointer;color:#ccd2df;background:rgba(255,255,255,.07);border-radius:8px;",
    "padding:5px 10px;font-size:11.5px;transition:background .15s,color .15s}",
    ".gp-btn:hover{background:rgba(255,255,255,.14);color:#fff}",
    ".gp-diag{margin-top:2px;border-top:1px solid rgba(255,255,255,.07);padding-top:10px}",
    ".gp-diag>summary{cursor:pointer;color:#7c8498;font-size:11px;letter-spacing:.4px;list-style:none;margin-bottom:6px}",
    ".gp-diag>summary::-webkit-details-marker{display:none}",
    // ★ v1.20.0：三块卡片（本次/本首歌 轮换 + 预告常驻）
    ".gp-hero2{display:flex;gap:8px;margin-bottom:12px}",
    ".gp-hcard{flex:1;min-width:0;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);",
    "border-radius:12px;padding:10px 12px;overflow:hidden}",
    ".gp-hcard-cap{font-size:10px;color:#7c8498;letter-spacing:.3px}",
    ".gp-hcard-num{font-size:21px;font-weight:700;line-height:1.2;margin:3px 0 5px;white-space:nowrap}",
    ".gp-hcard-items{display:flex;flex-wrap:wrap;gap:4px}",
    ".gp-chip{font-size:10px;color:#9aa3b8;background:rgba(255,255,255,.06);border-radius:6px;padding:1px 6px;white-space:nowrap}",
    ".gp-hero.gp-anim-a{animation:gp-hero-in 2s ease-out}",
    ".gp-hero.gp-anim-b{animation:gp-hero-in2 2s ease-out}",
    // ★ v1.20.0：本次交叉切换时的 1s 过渡动画
    "@keyframes gp-hero-in{from{opacity:.35;transform:translateY(6px)}to{opacity:1;transform:none}}",
    "@keyframes gp-hero-in2{from{opacity:.35;transform:translateY(6px)}to{opacity:1;transform:none}}",
    // ★ v1.20.0：时长滑杆 + 曲线 Dialog + 上下两组
    ".gp-range{width:120px;accent-color:#4d7cff}",
    ".gp-dialog{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;",
    "justify-content:center;z-index:100001}",
    ".gp-dialog-card{width:240px;background:rgba(28,32,42,.98);border:1px solid rgba(255,255,255,.12);",
    "border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:6px;box-shadow:0 18px 50px rgba(0,0,0,.5)}",
    ".gp-dialog-title{font-size:12px;color:#9aa3b8;margin-bottom:2px}",
    ".gp-dialog-row{all:unset;cursor:pointer;font-size:12.5px;color:#dfe4ee;padding:8px 10px;border-radius:8px}",
    ".gp-dialog-row:hover{background:rgba(255,255,255,.08)}",
    ".gp-dialog-row.on{background:rgba(77,124,255,.25);color:#fff}",
    ".gp-pane .gp-sec + .gp-sec{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.07)}",
    ".gp-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#6f7689;",
    "font-size:10px;margin-top:10px}",
    // ★ v1.9.7：**只要一个音符** —— 去掉边框/背景/毛玻璃，纯图标；尺寸 30 → 42px（+12px）
    ".gp-fab{position:fixed;right:14px;bottom:16px;width:42px;height:42px;border:0;background:none;",
    "z-index:2147482999;display:flex;align-items:center;justify-content:center;cursor:pointer;",
    "color:#a8b0c2;font-size:21px;line-height:1;opacity:.66;padding:0;box-shadow:none;",
    "backdrop-filter:none;-webkit-backdrop-filter:none;",
    "transition:opacity .18s,color .18s,transform .18s}",
    ".gp-fab:hover{opacity:1;color:#fff;transform:scale(1.06)}",
    ".gp-fab.on{opacity:1;color:#3d6ef5}",
    // ★ v1.9.6：⚠️ 不再用 .inline（那是「塞进客户端组件树」的方案，会导致点击连带触发随机播放）。
    //   现在按钮留在 body 里，用 fixed 浮在随机播放左边 —— 样式就是上面的 .gp-fab，
    //   只把「贴着随机播放」这件事交给 JS 算位置（positionButtonNearShuffle）。
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

  /** ★ v1.15.0：把开关的视觉/内部状态同步到真实状态（控制台改过也不怕） */
  function syncSw(sw, on) {
    if (!sw) return;
    sw.__on = !!on;
    sw.className = "gp-sw" + (on ? " on" : "");
  }

  function refreshPanel() {
    if (!panel.box) return;
    try {
      // ★ v1.20.0：状态信息回到原来的一行（`｜` 分隔）
      if (panel.status) panel.status.textContent = statusLine();
      // ★ v1.14.0：顶部大卡 = 上一次真实过渡
      // ★ v1.20.0：一张大卡（本次交叉）+ 横向排列的小项
      var hc = heroCardModel();
      renderHeroCard(panel.heroNum, panel.heroItems, hc);
      var heroSig = hc.num + "|" + hc.items.join(",");
      if (panel.__heroSig !== undefined && panel.__heroSig !== heroSig && panel.hero) {
        panel.__animFlip = !panel.__animFlip;
        panel.hero.className = "gp-hero " + (panel.__animFlip ? "gp-anim-a" : "gp-anim-b");
        if (panel.__heroTimer) {
          try {
            clearTimeout(panel.__heroTimer);
          } catch (eT) {}
        }
        panel.__heroTimer = setTimeout(function () {
          if (panel.hero) panel.hero.className = "gp-hero";
          panel.__heroTimer = 0;
        }, 2050);
      }
      panel.__heroSig = heroSig;
      // ★ v1.15.0：所有开关都从真实状态同步（控制台改过也不会显示错）
      syncSw(panel.pluginSw, !passAllToNative());
      syncSw(panel.autoMixSw, autoMixEnabled());
      syncSw(panel.xfadeSw, xfadeOn());
      syncSw(panel.eqSw, xfadeEqRaw());
      syncSw(panel.earlySw, earlyOutEnabled());
      syncSw(panel.loudSw, loudEnabled());
      syncSw(panel.loudRefSw, !loudRefSwitchedOff());
      syncSw(panel.trimSw, trimEnabled());
      syncSw(panel.trimPadSw, trimPadEnabled());
      syncSw(panel.diskSw, diskEnabled());
      syncSw(panel.analysisSw, analysisRawEnabled());
      syncSw(panel.backfillSw, backfillRawEnabled());
      syncSw(panel.skipSw, skipMixRawOn());
      syncSw(panel.contSw, continuousEnabled());
      if (panel.curveBtn) {
        var cc = currentCurveChoice();
        panel.curveBtn.textContent = cc === "auto" ? "自动" : cc;
      }
      // ★ v1.16.0：智能模式只显示「智能 · 按小节」；显式模式才显示秒数
      var on = xfadeOn();
      var sm = on && xfadeSmart();
      if (panel.smartText) panel.smartText.textContent = on ? "智能 · 按小节" : "关（未启用）";
      if (panel.smartWrap) panel.smartWrap.style.display = sm || !on ? "" : "none";
      if (panel.stepWrap) panel.stepWrap.style.display = sm || !on ? "none" : "";
      if (panel.stepVal) panel.stepVal.textContent = on ? xfadeSeconds().toFixed(1) + "s" : "关";
      if (panel.range) panel.range.value = String(xfadeSeconds());
      if (panel.cacheText) {
        panel.cacheText.textContent = (S.recentBufs || []).length + " 首 · " + sizeText(recentBytes());
      }
      if (panel.diskText) {
        panel.diskText.textContent = diskEnabled()
          ? diskCount() + " 首 · " + sizeText(diskBytes())
          : "不可用";
      }
    } catch (e) {}
  }

  function closePanel() {
    try {
      if (panel.__heroTimer) {
        clearTimeout(panel.__heroTimer);
        panel.__heroTimer = 0;
      }
    } catch (eT) {}
    try {
      if (panel.closeCurveDialog) panel.closeCurveDialog();
    } catch (e0) {}
    try {
      if (panel.box && panel.box.parentNode) panel.box.parentNode.removeChild(panel.box);
    } catch (e) {}
    panel.box = null;
    if (panel.btn) panel.btn.className = "gp-fab";
  }

  /** ★ v1.20.0：时长滑杆（0.1s 步进）——保留 ± 接口给控制台/旧脚本用 */
  function setXfadeSecondsFine(v) {
    var n = Math.round(Number(v) * 10) / 10;
    if (!isFinite(n)) return;
    if (n < 0.5) n = 0.5;
    if (n > XFADE_MAX) n = XFADE_MAX;
    setXfadeSwitch(n);
    refreshPanel();
  }

  /** ★ v1.14.0：时长 ±0.5s（点一下就把「智能」切成显式时长） */
  function bumpXfade(d) {
    var cur = xfadeOn() ? xfadeSeconds() : XFADE_ON_SEC_DEFAULT;
    var next = Math.round((cur + d) * 2) / 2;
    if (next < 0.5) next = 0.5;
    if (next > XFADE_MAX) next = XFADE_MAX;
    setXfadeSwitch(next);
    refreshPanel();
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

      /* ---- 标题：品牌 + 版本 + 插件启用 + 关闭 ---- */
      var head = el("div", "gp-head");
      head.appendChild(el("span", "gp-dot"));
      var brand = el("div", "gp-brand");
      brand.appendChild(el("span", null, "GaplessPlayer"));
      brand.appendChild(el("span", "gp-ver", VERSION));
      head.appendChild(brand);
      var plug = el("div", "gp-head-sw");
      plug.appendChild(el("span", "gp-head-sw-label", "插件"));
      panel.pluginSw = toggleEl(!passAllToNative(), function (v) {
        try {
          window.__gpNativeAll = v ? false : true;
        } catch (e) {}
        log("[ui] 插件 → " + (v ? "启用" : "停用（整条交回原生）"));
      });
      panel.pluginSw.title = "插件启用：关掉 = 整条交回原生播放器（从下一条播放命令起生效）";
      plug.appendChild(panel.pluginSw);
      head.appendChild(plug);
      var x = el("button", "gp-x", "×");
      x.onclick = function () {
        closePanel();
      };
      head.appendChild(x);
      box.appendChild(head);

      /* ---- 顶部大卡：上一次真实过渡（大数字 + 横向排列的小项） ---- */
      panel.hero = el("div", "gp-hero");
      panel.heroCap = el("div", "gp-hero-cap", "本次交叉");
      panel.heroNum = el("div", "gp-hero-num", "—");
      panel.heroItems = el("div", "gp-hcard-items");
      panel.hero.appendChild(panel.heroCap);
      panel.hero.appendChild(panel.heroNum);
      panel.hero.appendChild(panel.heroItems);
      box.appendChild(panel.hero);

      /* ---- 状态行（小字，完整信息） ---- */
      panel.status = el("div", "gp-status", statusLine());
      box.appendChild(panel.status);

      /* ---- 子标签页：过渡 / 音色 / 缓存 ---- */
      var tabBar = el("div", "gp-tabs");
      var paneWrap = el("div", "gp-panes");
      panel.tabBtns = {};
      panel.panes = {};
      function showTab(key) {
        for (var k in panel.tabBtns) {
          if (!Object.prototype.hasOwnProperty.call(panel.tabBtns, k)) continue;
          panel.tabBtns[k].className = "gp-tab" + (k === key ? " on" : "");
          if (panel.panes[k]) panel.panes[k].style.display = k === key ? "" : "none";
        }
      }
      [
        ["mix", "过渡"],
        ["tone", "音色"],
        ["cache", "缓存"],
      ].forEach(function (it) {
        var b = el("button", "gp-tab", it[1]);
        b.onclick = function () {
          showTab(it[0]);
        };
        panel.tabBtns[it[0]] = b;
        tabBar.appendChild(b);
        var pane = el("div", "gp-pane");
        panel.panes[it[0]] = pane;
        paneWrap.appendChild(pane);
      });
      box.appendChild(tabBar);
      box.appendChild(paneWrap);
      showTab("mix");

      /* ---- 过渡（上半）：时长 / 曲线 ---- */
      var sec1 = el("div", "gp-sec");
      panel.autoMixSw = toggleEl(autoMixEnabled(), function (v) {
        try {
          window.__gpAutoMix = !!v;
        } catch (e) {}
        log("[ui] 拍点对齐 → " + (v ? "开" : "关"));
      });
      sec1.appendChild(rowEl("拍点对齐", panel.autoMixSw));
      panel.xfadeSw = toggleEl(xfadeOn(), function (v) {
        setXfadeSwitch(v, 0);
      });
      sec1.appendChild(rowEl("交叉淡入淡出", panel.xfadeSw));

      // ★ v1.20.0：智能只写「智能 · 按小节」；「固定」沿用上次的秒数（不再跳回 3.0）
      panel.smartWrap = el("div", "gp-stepper");
      panel.smartText = el("span", "gp-step-val", "智能 · 按小节");
      var fixBtn = el("button", "gp-btn", "固定");
      fixBtn.title = "改用固定秒数（沿用上次的值）";
      fixBtn.onclick = function () {
        var v = lastXfadeSec() || XFADE_ON_SEC_DEFAULT;
        setXfadeSwitch(v);
        refreshPanel();
      };
      panel.smartWrap.appendChild(panel.smartText);
      panel.smartWrap.appendChild(fixBtn);

      panel.stepWrap = el("div", "gp-stepper");
      panel.range = el("input", "gp-range");
      try {
        panel.range.type = "range";
        panel.range.min = "0.5";
        panel.range.max = String(XFADE_MAX);
        panel.range.step = "0.1";
      } catch (eR) {}
      panel.range.oninput = function () {
        setXfadeSwitch(Number(panel.range.value));
        refreshPanel();
      };
      panel.stepVal = el("span", "gp-step-val", "");
      var smartBtn = el("button", "gp-btn", "按小节");
      smartBtn.title = "改回按小节自动";
      smartBtn.onclick = function () {
        setXfadeSwitch(true, 0);
        refreshPanel();
      };
      panel.stepWrap.appendChild(panel.range);
      panel.stepWrap.appendChild(panel.stepVal);
      panel.stepWrap.appendChild(smartBtn);

      var durBox = el("div", "gp-stepper");
      durBox.appendChild(panel.smartWrap);
      durBox.appendChild(panel.stepWrap);
      sec1.appendChild(rowEl("时长", durBox));

      panel.curveBtn = el("button", "gp-btn", "自动");
      panel.curveBtn.title = "选择过渡曲线";
      panel.curveBtn.onclick = function () {
        openCurveDialog();
      };
      sec1.appendChild(rowEl("曲线", panel.curveBtn));
      panel.eqSw = toggleEl(xfadeEqRaw(), function (v) {
        try {
          window.__gpXfadeEq = !!v;
        } catch (e) {}
        log("[ui] 交叉扫频 → " + (v ? "开" : "关"));
      });
      sec1.appendChild(rowEl("扫频", panel.eqSw));
      panel.panes.mix.appendChild(sec1);

      /* ---- 过渡（下半）：行为 ---- */
      var sec1b = el("div", "gp-sec");
      sec1b.appendChild(el("div", "gp-cap", "行为"));
      panel.skipSw = toggleEl(skipMixRawOn(), function (v) {
        try {
          window.__gpSkipBadMix = !!v;
        } catch (e) {}
        log("[ui] 差拍/低置信跳过 → " + (v ? "开" : "关"));
      });
      panel.skipSw.title = "差拍或置信太低时不做交叉（20ms 极短淡）";
      sec1b.appendChild(rowEl("差拍跳过", panel.skipSw));
      panel.contSw = toggleEl(continuousEnabled(), function (v) {
        try {
          window.__gpKeepContinuous = !!v;
        } catch (e) {}
        log("[ui] 无缝专辑保持原样 → " + (v ? "开" : "关"));
      });
      panel.contSw.title = "两边都断在音乐里（无缝专辑）→ 保持 0s 原样";
      sec1b.appendChild(rowEl("无缝专辑原样", panel.contSw));
      panel.panes.mix.appendChild(sec1b);

      // ★ v1.20.0：曲线改成 Dialog（自动 + 6 条自定义）
      function closeCurveDialog() {
        try {
          if (panel.dialog && panel.dialog.parentNode) panel.dialog.parentNode.removeChild(panel.dialog);
        } catch (e) {}
        panel.dialog = null;
      }
      function openCurveDialog() {
        closeCurveDialog();
        var mask = el("div", "gp-dialog");
        var card = el("div", "gp-dialog-card");
        card.appendChild(el("div", "gp-dialog-title", "过渡曲线"));
        var opts = [
          ["auto", "自动（按档位）"],
          ["equal", "equal · 等功率"],
          ["s-line", "s-line · 平滑 S"],
          ["r_s-line", "r_s-line · 端部更陡"],
          ["linear", "linear · 线性"],
          ["exp", "exp · 指数"],
          ["step", "step · 阶跃"],
        ];
        var cur = currentCurveChoice();
        opts.forEach(function (it) {
          var b = el("button", "gp-dialog-row" + (it[0] === cur ? " on" : ""), it[1]);
          b.onclick = function () {
            try {
              if (it[0] === "auto") delete window.__gpXfadeCurve;
              else window.__gpXfadeCurve = it[0];
            } catch (e) {}
            log("[ui] 曲线 → " + (it[0] === "auto" ? "自动（按档位）" : it[0]));
            closeCurveDialog();
            refreshPanel();
          };
          card.appendChild(b);
        });
        var closeBtn = el("button", "gp-btn", "取消");
        closeBtn.onclick = closeCurveDialog;
        card.appendChild(closeBtn);
        mask.appendChild(card);
        document.body.appendChild(mask);
        panel.dialog = mask;
      }
      panel.closeCurveDialog = closeCurveDialog;

      /* ---- 音色 ---- */
      var sec2 = el("div", "gp-sec");
      panel.loudSw = toggleEl(loudEnabled(), function (v) {
        try {
          window.__gpLoudness = !!v;
        } catch (e) {}
        log("[ui] 响度平衡 → " + (v ? "开" : "关"));
      });
      sec2.appendChild(rowEl("响度平衡", panel.loudSw));
      panel.loudRefSw = toggleEl(!loudRefSwitchedOff(), function (v) {
        try {
          window.__gpLoudRef = v ? "median" : "none";
        } catch (e) {}
        log("[ui] 响度参考 → " + (v ? "本库中位数（相对）" : "接口原始值（绝对）"));
      });
      sec2.appendChild(rowEl("响度参考", panel.loudRefSw));
      panel.trimSw = toggleEl(trimEnabled(), function (v) {
        try {
          window.__gpTrim = !!v;
        } catch (e) {}
        log("[ui] 首尾裁剪 → " + (v ? "开" : "关"));
      });
      sec2.appendChild(rowEl("首尾裁剪", panel.trimSw));
      panel.trimPadSw = toggleEl(trimPadEnabled(), function (v) {
        try {
          window.__gpTrimPad = !!v;
        } catch (e) {}
      });
      sec2.appendChild(rowEl("裁作品静音", panel.trimPadSw));
      panel.panes.tone.appendChild(sec2);

      /* ---- 缓存（只留：最近缓冲 / 磁盘字节 / 磁盘缓存） ---- */
      var sec3 = el("div", "gp-sec");
      panel.cacheText = el("span", "gp-val", "");
      var clearBtn = el("button", "gp-btn", "清内存");
      clearBtn.title = "清掉解码缓冲 + 内存字节（磁盘那份会保留，清完立刻重排预热）";
      clearBtn.onclick = function () {
        clearCaches();
        refreshPanel();
      };
      var cacheWrap = el("div", "gp-stepper");
      cacheWrap.appendChild(panel.cacheText);
      cacheWrap.appendChild(clearBtn);
      sec3.appendChild(rowEl("最近缓冲", cacheWrap));

      panel.diskText = el("span", "gp-val", "");
      var diskBtn = el("button", "gp-btn", "清磁盘");
      diskBtn.title = "清掉 " + diskDir() + " 下的字节缓存（下次预载要重新下载）";
      diskBtn.onclick = function () {
        clearDiskCache();
        refreshPanel();
      };
      var diskWrap = el("div", "gp-stepper");
      diskWrap.appendChild(panel.diskText);
      diskWrap.appendChild(diskBtn);
      sec3.appendChild(rowEl("磁盘字节", diskWrap));

      panel.diskSw = toggleEl(diskEnabled(), function (v) {
        try {
          window.__gpDiskCache = !!v;
        } catch (e) {}
        log("[ui] 磁盘缓存 → " + (v ? "开" : "关"));
      });
      sec3.appendChild(rowEl("磁盘缓存", panel.diskSw));
      panel.panes.cache.appendChild(sec3);

      /* ---- 诊断（折叠；高级开关都在这里，平时不用碰） ---- */
      var diag = el("details", "gp-diag");
      diag.appendChild(el("summary", null, "更多"));
      [
        ["流式补缓冲", "__gpPromote", true],
        ["强制缓冲路径", "__gpStream", false],
        ["关掉预约", "__gpSeamless", false],
      ].forEach(function (it) {
        var dfltOnOut = it[2] === true;
        diag.appendChild(
          rowEl(
            it[0],
            toggleEl(dfltOnOut, function (v) {
              try {
                window[it[1]] = v ? true : dfltOnOut ? false : undefined;
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

      // ★ v1.20.0：回到「面板按钮正上方」（水平对齐 ♪ 按钮，太靠边就夹住）
      try {
        var br = panel.btn && panel.btn.getBoundingClientRect ? panel.btn.getBoundingClientRect() : null;
        if (!br || !(br.width > 0)) {
          var anchor = findPlayModeButton();
          br = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        }
        if (br && br.width > 0 && typeof window !== "undefined" && window) {
          var wBox = 344;
          var left = br.left + br.width / 2 - wBox / 2;
          var maxLeft = (window.innerWidth || 1024) - wBox - 8;
          if (maxLeft < 8) maxLeft = 8;
          if (left > maxLeft) left = maxLeft;
          if (left < 8) left = 8;
          box.style.left = Math.round(left) + "px";
          box.style.right = "auto";
          box.style.bottom = Math.round(Math.max(8, (window.innerHeight || 768) - br.top + 10)) + "px";
        } else {
          box.style.left = "8px";
          box.style.right = "auto";
          box.style.bottom = "88px";
        }
      } catch (e) {}
      if (panel.btn) panel.btn.className = "gp-fab on";

      if (!panel.timer) {
        panel.timer = setInterval(function () {
          if (!panel.box) return;
          try {
            refreshPanel();
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

  /**
   * ★ v1.9.4：面板按钮从「右下角浮标」改成**播放器里、随机播放按钮左边**的一颗小钮。
   *
   * 找随机/顺序按钮用的是「宽进」策略（不同客户端版本 class 不一样）：
   *   ① 明确写着乱序/顺序/循环的 title / aria-label / data-action
   *   ② class 里带 shuffle / order / random / loop
   *   ③ 已知的几个老 selector（`.m-playbar .rdi`、`.oper .icn`、`[class*=mode]`）
   * 找到就把自己插在它**前面**（同一个父节点）；找不到 → 退回右下角浮标（老行为），
   * 并且每 1.5s 再试一次（播放器栏有时是懒渲染的）。
   */
  var SHUFFLE_HINTS = ["随机", "顺序", "循环", "乱序", "shuffle", "order", "random", "loop", "mode"];
  var SHUFFLE_SELECTORS = [
    ".m-playbar .rdi",
    ".m-playbar [class*='shuffle']",
    ".m-playbar [class*='order']",
    "[data-action*='order']",
    "[data-action*='shuffle']",
    "[data-action*='mode']",
    ".btns [class*='order']",
    ".oper [class*='order']",
  ];

  function looksLikePlayMode(el2) {
    if (!el2 || !el2.getAttribute) return false;
    var bits = [
      el2.getAttribute("title"),
      el2.getAttribute("aria-label"),
      el2.getAttribute("data-action"),
      el2.getAttribute("data-log"),
      el2.className,
    ];
    var s = "";
    for (var i = 0; i < bits.length; i++) if (bits[i]) s += " " + bits[i];
    s = s.toLowerCase();
    for (var k = 0; k < SHUFFLE_HINTS.length; k++) {
      if (s.indexOf(SHUFFLE_HINTS[k].toLowerCase()) >= 0) return true;
    }
    return false;
  }

  /** 找「随机播放」那颗按钮（找不到返回 null） */
  function findPlayModeButton() {
    try {
      for (var i = 0; i < SHUFFLE_SELECTORS.length; i++) {
        var cand = document.querySelector(SHUFFLE_SELECTORS[i]);
        if (cand) return cand;
      }
      // 兜底：扫一遍播放器栏里的可点元素，看谁的 title/class 像「播放模式」
      var bars = document.querySelectorAll(".m-playbar, #g_player, .playbar, footer");
      for (var b = 0; b < (bars ? bars.length : 0); b++) {
        var kids = bars[b].querySelectorAll("a,button,i,span,div");
        for (var j = 0; j < (kids ? kids.length : 0); j++) {
          if (looksLikePlayMode(kids[j])) return kids[j];
        }
      }
    } catch (e) {}
    return null;
  }

  /**
   * 把按钮挂到播放器栏（随机播放左边）；挂不上就退回右下角浮标。
   * 返回 true = 已经挂进播放器栏。
   */
  /**
   * ★ v1.9.6：**不再把自己塞进客户端的 DOM**。
   *
   * 之前是把 ♪ `insertBefore` 到「随机播放」按钮前面（同一个父节点）。结果就是
   * 「点 ♪ 会连带触发随机播放」—— 因为客户端在那层容器上做**点击委托**
   * （事件冒泡到容器 → 容器按坐标/目标判断是哪颗按钮 → 我们成了它的子节点，就被当成组员）。
   * 在子节点上 `stopPropagation` 也不一定拦得住（如果是容器上的 capture 监听）。
   *
   * 现在改成：按钮留在 `document.body` 里（完全不进客户端组件树），
   * 用 `position:fixed` **贴着随机播放左边浮着**，位置按它的 `getBoundingClientRect()` 实时算。
   * 这样：
   *   - 点 ♪ 的事件不会经过客户端的任何容器（它压根不在那棵树上）；
   *   - 看起来仍然在「随机播放」左边；
   *   - 客户端重渲染播放器栏也不影响我们（只是位置要跟着重算）。
   */
  var PANEL_BTN_GAP = 14; // 按钮与「随机播放」之间的空隙（px）—— 「再左一些」就调它
  var PANEL_BTN_SIZE = 42; // ★ v1.9.7：按钮边长（原来 30，按「再大 12px」改成 42）

  /** 把 ♪ 贴到随机播放按钮左边（算不出来就返回 false，退回落浮标位置） */
  function positionButtonNearShuffle() {
    try {
      if (!panel.btn) return false;
      var target = findPlayModeButton();
      if (!target || typeof target.getBoundingClientRect !== "function") return false;
      var r = target.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return false;
      var w = PANEL_BTN_SIZE;
      var h = PANEL_BTN_SIZE;
      var left = Math.max(2, r.left - w - PANEL_BTN_GAP);
      var top = r.top + (r.height - h) / 2;
      panel.btn.style.position = "fixed";
      panel.btn.style.right = "auto";
      panel.btn.style.bottom = "auto";
      panel.btn.style.left = Math.round(left) + "px";
      panel.btn.style.top = Math.round(top) + "px";
      panel.btn.__nearShuffle = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function mountPanelButton() {
    try {
      if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return false;
      if (window.__gpHideButton) return false;
      ensurePanelCss();
      if (panel.btn && panel.btn.parentNode) {
        // 已经挂着了：只更新位置（播放器栏可能挪过/重渲染过）
        if (positionButtonNearShuffle()) return true;
        return !!panel.btn.__nearShuffle;
      }
      var b = panel.btn || el("div", "gp-fab", "♪");
      b.textContent = "♪";
      b.title = "GaplessPlayer 设置";
      // ★ v1.9.6：点击**只归我们**，并且尽力拦住冒泡（双保险；它本来就不在客户端组件树里）
      b.onclick = function (ev) {
        try {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (ev && ev.preventDefault) ev.preventDefault();
        } catch (e) {}
        openPanel();
      };
      ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "dblclick"].forEach(function (t) {
        try {
          b.addEventListener(t, function (ev) {
            try {
              if (ev && ev.stopPropagation) ev.stopPropagation();
            } catch (e) {}
          });
        } catch (e) {}
      });
      b.className = "gp-fab" + (panel.box ? " on" : "");
      document.body.appendChild(b);
      panel.btn = b;
      if (positionButtonNearShuffle()) {
        log("[ui] 设置按钮已浮在「随机播放」左边（不在客户端组件树里，点它不会触发随机播放）");
        return true;
      }
      log("[ui] 设置面板按钮已注入（右下角「♪」；window.__gpHideButton = true 可隐藏）");
      return false;
    } catch (e) {
      log("[ui] ★ 注入按钮失败 ｜ " + (e && e.message));
      return false;
    }
  }

  /** 老名字保留（内部/测试都在用）：拿不到播放器栏时它就是「右下角浮标」 */
  function initPanel() {
    if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
    if (window.__gpHideButton) return;
    mountPanelButton();
    // ★ v1.9.6：按钮是浮层（贴在随机播放左边），所以要**定期重算位置** ——
    //   窗口缩放、播放器栏展开/收起、歌词模式切换都会让它挪窝。
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      try {
        if (!panel.btn || !panel.btn.parentNode) {
          mountPanelButton();
        } else {
          positionButtonNearShuffle();
          // 位置一直算不出来（播放器栏还没出来）→ 试 20 次就放弃，留在右下角
          if (panel.btn.__nearShuffle || tries < 20) {
            if (panel.btn.__nearShuffle && tries > 3) clearInterval(t); // 已经稳定 → 交给 resize 事件
          } else {
            clearInterval(t);
          }
        }
      } catch (e) {
        clearInterval(t);
      }
    }, 1000);
    try {
      if (window.addEventListener) {
        window.addEventListener("resize", function () {
          try {
            positionButtonNearShuffle();
          } catch (e) {}
        });
      }
    } catch (e) {}
  }

  /* ==================== 启动 ==================== */

  plugin.onLoad(function () {
    log("=== GaplessPlayer v" + VERSION + " (缓冲 + 流式 + 首尾裁剪" + (xfadeSeconds() > 0 ? " + 交叉淡入淡出" : "") + ") 启动 ===");
    loadXfade(); // ★ v1.3.0：读回上次设的交叉时长（0 = 干净无缝）
    loadXfadeSmart(); // ★ v1.14.0：读回「智能交叉」开关
    // ★ v1.10.0：读回「离线分析」（拍点/能量）—— 和音频缓存解耦，流式 A 靠它对齐
    try {
      if (!analysisEnabled()) {
        log("[analysis] 关（磁盘缓存/总开关关着，或 __gpAnalysis=false）");
      } else {
        analysisLoadIndex()
          .then(function () {
            var st = analysisStats();
            log(
              "[analysis] 离线分析 ｜ " + st.count + " 首 ｜ " + st.path +
                " ｜ __gpAnalysis=false 可关"
            );
          })
          .catch(function () {});
      }
    } catch (e) {}
    // ★ v1.11.0：补算（P2）—— 空闲时把「盘上有字节、没分析过」的歌补出记录
    try {
      BACKFILL.bootAt = Date.now();
      if (backfillEnabled()) {
        log(
          "[backfill] 已排班 ｜ 开机 " + Math.round(backfillStartMs() / 1000) + "s 后起步 ｜ 串行、每首间隔 " +
            Math.round(backfillGapMs() / 1000) + "s ｜ 本会话上限 " + backfillMax() +
            " 首 ｜ __gpBackfill=false 可关"
        );
        setInterval(maybeBackfill, 1000);
      } else {
        log("[backfill] 关（__gpBackfill=false 或分析层关着）");
      }
    } catch (e) {}
    try {
      log(
        "[xfade] 交叉淡入淡出=" +
          (xfadeSeconds() > 0
            ? xfadeSeconds().toFixed(1) + "s（" + (xfadeSmart() ? "智能：按小节定时长/曲线" : "曲线=" + xfadeCurveName()) +
              (xfadeEqEnabled() ? "+扫频" : "") + "）"
            : "关") +
          " ｜ window.__gpXfade = 3 开启（0~12s，会记住）｜ __gpXfadeSmart / __gpXfadeCurve / __gpXfadeEq 可调"
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
      if (typeof cfg.volume === "number") {
        var v0 = cfg.volume;
        if (v0 > 1) v0 = v0 / 100; // 0~100 量纲
        // ★ v1.20.0：客户端退出时可能把「淡出中的音量」（如 0.011）存下来 →
        //   重启后整条链路只剩 1% 音量，用户必须手动拉回来。低于 5% 一律当脏值。
        if (!isFinite(v0) || !(v0 > 0.05)) {
          log("[env] 初始音量 " + cfg.volume + " 太小/异常 → 用 0.8（等客户端音量事件校正）");
          v0 = 0.8;
        }
        S.volume = v0;
      }
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
    if (window && window.__gpProbeNext) {
      try {
        probeNext();
      } catch (e) {}
    }
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
        probeNext: probeNext, // ★ v1.5.4：C3 侦察（只读，查「下一首是谁」能不能问出来）
        sqlq: probeSql, // ★ v1.5.5：直接向播放列表 DB 发只读 SQL
        sqlTables: probeSqlTables, // ★ v1.5.5：找 randomOrder 在哪张表；★ v1.5.6：直接给出候选表+建表 SQL
        sqlTable: probeSqlTable, // ★ v1.5.6：看某张表的结构 + 前 3 行
        sqlPlaying: probePlayingList, // ★ v1.5.7：直接看 currentPlayingList（随机顺序就在里面）
        sqlPersist: probePersist, // ★ v1.5.8：看 persistentModel 表 + 试着解开 playingInfo
        snapToBeat: snapToBeat,
        // ★ v1.9.1：交叉时长的乐句量化（纯函数，验证台直接测）
        quantizeXfade: quantizeXfadeSec,
        // ★ v1.9.2：头尾网格收敛（纯函数）
        reconcileGrids: reconcileGrids,
        // ★ v1.8.0（#14）：当前解码内存（MB）
        mem: function () {
          return decodedMemMB();
        },
        preopenSlot: function (id) {
          return findPreopenSlot(id);
        },        // ★ v1.7.1：看当前预约（排查用）
        sched: function () {
          var sc = S.sched;
          if (!sc) return null;
          return {
            trackId: sc.trackId,
            phase: sc.phase,
            streamSlot: sc.streamSlot === undefined ? -1 : sc.streamSlot,
            xfade: sc.xfade,
            startCtxTime: sc.startCtxTime,
            endCtxTime: sc.endCtxTime,
          };
        },        lastPlan: function () {
          return S.lastPlan;
        },
        // ★ v1.7.0：C 的纯函数（验证台直接测它们，不进 Worker）
        // ★ v1.8.2：乐句/能量/调性
        phraseAtOrBefore: phraseAtOrBefore,
        outroDrop: function (trackId, ab, dur) {
          return outroDropSec(trackId, ab, dur);
        },
        detectKey: function (ab, from, len) {
          return detectKey(ab, from, len);
        },
        keysCompatible: keysCompatible,        wsola: function (chs, speed, opts) {
          return wsolaStretch(chs, speed, opts);
        },
        stretchPlan: stretchPlan,        // ★ v1.6.1：读某首的拍点网格（头/尾各一份），排查「头尾 BPM 不一致」时用
        beatGrid: function (trackId) {
          var c = S.beatCache || {};
          return { head: c[trackId + "|head"] || null, tail: c[trackId + "|tail"] || null };
        },
        setStyle: applyStyle, // 兼容老调用：setStyle("clean") = 关，其它 = 开（3s）
        // ★ v1.9.4：`setXfade(true)` = 开 3s｜`setXfade(false)` = 关｜`setXfade(6)` = 直接 6s
        setXfade: setXfadeSwitch,
        xfadeOn: xfadeOn,
        clearCache: clearCaches,
        // ★ v1.8.6：自适应判定「顺序可预测」的内部账本（排查「为什么这首没预约」用）
        predict: function () {
          return {
            hitStreak: S.hitStreak || 0,
            misses: S.preloadMisses || 0,
            nextOff: !!S.preloadNextOff,
            seqStreak: S.seqStreak || 0,
            lastStopAgoMs: S.lastUserStopAt >= 0 ? Math.round(performance.now() - S.lastUserStopAt) : -1,
            lastEndAgoMs: S.__endedAt ? Math.round(Date.now() - S.__endedAt) : -1,
          };
        },
        // ★ v1.8.4：磁盘字节缓存（清内存不冷启动靠它）
        clearDiskCache: clearDiskCache,
        diskStats: diskStats,
        // ★ v1.10.0：拍点/能量离线缓存（诊断/脚本用）
        analysisStats: analysisStats,
        analysisOf: function (trackId) {
          return analysisGet(trackId);
        },
        // ★ v1.11.0：补算（P2）—— 控制台可以手动催一首；验证台也用它
        backfill: backfillStep,
        backfillStats: analysisStats,
        // ★ v1.13.0：最近一次真实过渡（面板/脚本用）
        lastMix: function () {
          return S.lastMix;
        },
        // ★ v1.15.0：清空分析记录（面板「清分析」按钮也走它）
        clearAnalysis: clearAnalysis,
        // ★ v1.20.0：当前增益（0~1；诊断/验证台用）
        volume: function () {
          return S.volume;
        },
        // ★ v1.17.0：置信度体检（audit() 读记录；audit(true) 重算）
        audit: auditConfidence,
        // ★ v1.9.3：响度平衡（数据来自 player/url 的 gain/peak、song/detail 的 volumeDelta、
        //   或直接从解码缓冲量的 RMS）
        loudness: loudnessStats,
        loudnessOf: loudnessOf,
        // 脚本/验证台用：直接喂一个测量值（{gain,peak} 或 {delta}），不走网络
        noteLoudness: function (trackId, o) {
          o = o || {};
          if (o.gain !== undefined) noteTrackGain(trackId, o.gain, o.peak);
          if (o.delta !== undefined) noteVolumeDelta(trackId, o.delta);
          return loudnessOf(trackId);
        },
        rewarm: rewarm,
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
      // ★ v1.13.0：插件停用（整条交回原生）→ 进度/预约全交给原生，别再发我们自己的伪造进度
      if (passAllToNative()) return;
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
          " ｜ 播法=" + (S.stream ? "流式" : "缓冲") + (S.silentSuspect ? "（已判静音）" : "") +
          // ★ v1.8.0（#14）：把解码内存打出来（双元素 + 预载 + 最近缓冲 + 字节缓存）
          " ｜ 内存=" + decodedMemMB() + "MB"
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

    // ★ v1.8.5：开机把磁盘缓存「到底能不能用」写成一行日志（写→读→删一件小事）。
    //   真机踩过：日志里只有 `磁盘=0 首`，看不出是关着、还是写不进去。
    try {
      diskSelfTest();
    } catch (e) {}

    // ★ v1.9.0：响度平衡的开关与上限写在第一屏（`gain/peak` 有没有值，之后每首会打一行 [loud]）
    try {
      log(
        "[loud] 响度平衡=" + (loudEnabled() ? "开" : "关") +
          " ｜ 上限 压 " + loudMaxCut() + " dB / 提 " + loudMaxBoost() + " dB" +
          " ｜ 数据来自 player/url 的 gain/peak（没有就安静不动）｜ window.__gpLoudness = false 可关"
      );
    } catch (e) {}

    log("[boot] 就绪 —— 请随便播一首歌");
  });
})();
