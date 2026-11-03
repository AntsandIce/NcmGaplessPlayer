#!/usr/bin/env node
/*
 * GaplessPlayer 变异测试
 *
 * 目的：验证「离线验证台」不是摆设。
 *   做法：把源码里某段关键逻辑抠掉 / 改坏，再跑验证台。
 *         如果验证台仍然全绿 → 说明那条断言是假的（没盯住这段代码）→ 报红。
 *         如果验证台变红 → 说明断言确实在看这段代码 → 通过。
 *
 * 用法：node test/mutate.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MUT = path.join(ROOT, ".mut");
const HARNESS = path.join(__dirname, "harness.js");

/** 每个变异：把 file 里的 find 换成 replace，然后跑验证台，要求它必须变红。 */
const MUTATIONS = [
  {
    name: "main: 不挂 channel.registerCall（UI 主路径注册不到）",
    file: "main.js",
    find: "channel.registerCall = wr;",
    replace: "/* MUTATED: 故意不挂钩 */ void wr;",
    expect: "3e",
  },
  {
    name: "main: 不挂 appendRegisterCall（UI 备用路径注册不到）",
    file: "main.js",
    find: "legacyNativeCmder.appendRegisterCall = wa;",
    replace: "/* MUTATED: 故意不挂钩 */ void wa;",
    expect: "3d",
  },
  {
    name: "main: emit 不派发给 registeredCalls（只通知原生）",
    file: "main.js",
    find: "handlers[i].apply(null, args);",
    replace: "/* MUTATED: 不派发 */ void handlers[i];",
    expect: "3c",
  },
  {
    name: "startup: 不包 channel.registerCall",
    file: "startup_script.js",
    find: "channel.registerCall = w;",
    replace: "/* MUTATED: 不包 */ void w;",
    expect: "15",
  },
  {
    name: "startup: 不包 appendRegisterCall",
    file: "startup_script.js",
    find: "legacyNativeCmder.appendRegisterCall = w;",
    replace: "/* MUTATED: 不包 */ void w;",
    expect: "15",
  },
  {
    name: "startup: 不建 window.registeredCalls",
    file: "startup_script.js",
    find: "var reg = (window.registeredCalls = window.registeredCalls || {});",
    replace: "var reg = {};",
    expect: "15",
  },
  {
    name: "A1: 不旁听播放列表（playlist 永远空 → 算不出下一首）",
    file: "main.js",
    find: "S.playlist = songs;",
    replace: "/* MUTATED: 不记列表 */ void songs;",
    expect: "17",
  },
  {
    name: "A1: nextTrack 取成当前曲目（不预载下一首）",
    file: "main.js",
    find: "return list[k + 1];",
    replace: "return list[k];",
    expect: "17",
  },
  {
    name: "A1: 去掉预载命中分支（切歌总是重新下载）",
    file: "main.js",
    find: "var pre = takePreload(trackId);",
    replace: "var pre = null; void takePreload;",
    expect: "17",
  },
  {
    name: "A1: takePreload 不校验 trackId（乱命中别人的 buffer）",
    file: "main.js",
    find: 'if (!p || p.trackId !== trackId || p.status !== "ready") return null;',
    replace: "if (!p) return null;",
    expect: "19",
  },
  {
    name: "A1: 不解析 JSON 字符串列表（真机踩过的坑）",
    file: "main.js",
    find: "songs = JSON.parse(songs);",
    replace: "/* MUTATED: 不解析，字符串当数组用 */ void songs;",
    expect: "23",
  },
  {
    name: "A1.5: 规则①失效（当前曲目没就绪也不预载它自己）",
    file: "main.js",
    find: "if (S.loadedTrackId !== cur) {",
    replace: "if (false) {",
    expect: "16",
  },
  {
    name: "A1.5: 开机不预载（bootFromMemory 不触发）",
    file: "main.js",
    find: "bootFromMemory();",
    replace: "void bootFromMemory;",
    expect: "24",
  },
  {
    name: "A1.5: 开机记忆不写文件（退回不可靠的 localStorage）",
    file: "main.js",
    find: 'betterncm.fs.writeFile(MEM_FILE, new Blob([payload], { type: "application/json" }));',
    replace: "void MEM_FILE;",
    expect: "24",
  },
  {
    name: "A1.5: 不认过期的开机记忆（>24h 也照猜）",
    file: "main.js",
    find: "if (o.t && age > 24 * 3600 * 1000) {",
    replace: "if (false) {",
    expect: "24",
  },
  {
    name: "A1.5: setCurrentPlay 不记记忆（只靠 load 记，选中即播的场景会漏）",
    file: "main.js",
    find: '          saveLastTrack(tid, "选中");',
    replace: "          void tid;",
    expect: "24",
  },
  {
    name: "A1.5: 改名漏改调用点（addListElement 分支调 maybePreloadNext）",
    file: "main.js",
    find: "          maybePreload();\n        } else {",
    replace: "          maybePreloadNext();\n        } else {",
    expect: "26",
  },
  {
    name: "A1.5: 切歌单不作废过期预载（白下上一份歌单的歌）",
    file: "main.js",
    find: "if (S.preload && !keep && S.preload.trackId !== S.curTrackId) {",
    replace: "if (false) {",
    expect: "28",
  },
  {
    name: "A1.5: 记忆日志不写来源（分不清「选中」还是「加载」）",
    file: "main.js",
    find: 'saveLastTrack(trackId, "加载");',
    replace: "saveLastTrack(trackId);",
    expect: "29",
  },
  {
    name: "版本号与 manifest 不一致（忘 bump / 装错包）",
    file: "main.js",
    // ⚠️ bump 版本号时这里要跟着改（验证台第 27 段就是盯「横幅 == manifest」的）
    find: 'var VERSION = "1.5.3";',
    replace: 'var VERSION = "0.2.1";',
    expect: "27",
  },

  /* ---- v0.2.9 只记歌不记进度 ---- */
  {
    name: "v0.2.9: 记忆 payload 里塞回 pos（说好的只记歌呢）",
    file: "main.js",
    find: "JSON.stringify({ id: trackId, t: Date.now() })",
    replace: "JSON.stringify({ id: trackId, pos: 0, t: Date.now() })",
    expect: "30",
  },

  /* ---- v0.2.5 掐断在飞下载 ---- */
  {
    name: "v0.2.5: 作废不掐断在飞下载（退回「只丢结果」）",
    file: "main.js",
    find: "        p.abort.abort();",
    replace: "        void p.abort;",
    expect: "37",
  },
  {
    name: "v0.2.5: 换预载目标时不掐断上一个",
    file: "main.js",
    find: "        old.abort.abort();",
    replace: "        void old.abort;",
    expect: "37",
  },
  {
    name: "v0.2.5: fetchBytes 不把 signal 传给 fetch",
    file: "main.js",
    find: "fetch(url, signal ? { signal: signal } : undefined)",
    replace: "fetch(url)",
    expect: "37",
  },

  /* ---- v0.2.6 开机保护窗口 ---- */
  {
    name: "v0.2.6: 保护窗口默认就开着（没记忆也开 → 第一首不预载了）",
    file: "main.js",
    find: "    bootWindow: false,",
    replace: "    bootWindow: true,",
    expect: "24",
  },
  {
    name: "v0.2.6: 读到记忆也不开保护窗口（网易云的恢复照旧冲掉记忆）",
    file: "main.js",
    find: "        S.bootWindow = true;",
    replace: "        S.bootWindow = false;",
    expect: "25",
  },
  {
    name: "v0.2.6: setCurrentPlay 无视保护窗口（开机恢复照样冲记忆、抢预载）",
    file: "main.js",
    find: "          if (S.bootWindow && (S.bootRestoreTrackId === null || tid === S.bootRestoreTrackId)) {",
    replace: "          if (false) {",
    expect: "25",
  },

  /* ---- v0.2.7 保护窗口补完 ---- */
  {
    name: "v0.2.7: 开机读记忆的竞态守卫失效（读到刚写进去的值 → 误开窗口）",
    file: "main.js",
    find: "        if (S.wroteMemory) {",
    replace: "        if (false) {",
    expect: "29",
  },
  {
    name: "v0.2.7: 窗口内的 load 照样写记忆（网易云恢复流程被当用户行为）",
    file: "main.js",
    find: '    if (S.bootWindow) {\n      log("[mem] 窗口内收到 load',
    replace: '    if (false) {\n      log("[mem] 窗口内收到 load',
    expect: "25",
  },
  {
    name: "v0.2.7: 窗口内仍然更新 curTrackId（预载被网易云恢复那首抢走）",
    file: "main.js",
    find: "            //    maybePreload() 会拿它去预载，把「记忆那首」的下载掐断（真机踩过 97MB）。\n            return false;",
    replace: "            //    maybePreload() 会拿它去预载，把「记忆那首」的下载掐断（真机踩过 97MB）。\n            S.curTrackId = tid;\n            return false;",
    expect: "25",
  },
  {
    name: "v0.2.7: 用户切到别的歌也不关窗（窗口永远吞掉记账）",
    file: "main.js",
    find: "          if (S.bootWindow) {\n            // 用户主动切到**别的**歌 → 关窗，恢复正常记账",
    replace: "          if (false) {\n            // 用户主动切到**别的**歌 → 关窗，恢复正常记账",
    expect: "25",
  },
  {
    name: "v0.2.7: 窗口内连续播放 ≥10s 也不关窗",
    file: "main.js",
    find: "        performance.now() - S.bootPlayStart >= 10000",
    replace: "        performance.now() - S.bootPlayStart >= 99999999",
    expect: "38",
  },

  /* ---- v0.2.8 日志瘦身 ---- */
  {
    name: "v0.2.8: 日志开关失效（噪音照样全写）",
    file: "main.js",
    find: "    if (!on) return;",
    replace: "    if (false) return;",
    expect: "9b",
  },
  {
    name: "v0.2.8: [call] ▶ 正则又放宽（player.* 的 UI 设置类全刷进来）",
    file: "main.js",
    find: "if (/^audioplayer\\.|^player\\.(setCurrentPlay|addListElement)$/.test(n)) {",
    replace: "if (/player|audio|play|pause|seek|vol/i.test(n)) {",
    expect: "9b",
  },

  /* ---- v0.2.10 随机播放下自适应停止「预载下一首」 ---- */
  {
    name: "v0.2.10: 不结算「预测押没押中」（永远发现不了随机播放）",
    file: "main.js",
    find: 'if (!p || p.why !== "下一首") return;',
    replace: "if (true) return;",
    expect: "40",
  },
  {
    name: "v0.2.10: slot 不记 why（「预载当前曲目」被当成预测 → 误计数）",
    file: "main.js",
    find: 'var slot = { trackId: trackId, why: why || "?", status: "pending"',
    replace: 'var slot = { trackId: trackId, why: "下一首", status: "pending"',
    expect: "41",
  },
  {
    name: "v0.2.10: 判定随机播放后照样预载下一首（白下流量没省掉）",
    file: "main.js",
    find: "    if (S.preloadNextOff) return;",
    replace: "    if (false) return;",
    expect: "40",
  },
  {
    name: "v0.2.10: 押不中阈值形同虚设（99 次才关）",
    file: "main.js",
    find: "var PRELOAD_MISS_LIMIT = 3;",
    replace: "var PRELOAD_MISS_LIMIT = 99;",
    expect: "40",
  },
  {
    name: "v0.2.10: 结算时机错（notePrediction 被挪到 maybePreload 之后 / 删掉 → 永远算不出押没押中）",
    file: "main.js",
    find: "          notePrediction(tid);\n          // ★ v0.4.1：无缝预约的三种情形",
    replace: "          // ★ v0.4.1：无缝预约的三种情形",
    expect: "40",
  },
  {
    name: "v0.2.10: 免费恢复失效（相邻再多也不重新开启）",
    file: "main.js",
    find: "    if (S.preloadNextOff && S.seqStreak >= 2) {",
    replace: "    if (S.preloadNextOff && S.seqStreak >= 99999) {",
    expect: "42",
  },
  {
    name: "v0.2.10: 「顺序播放」信号不去重（同一首被算两次，信号错乱）",
    file: "main.js",
    find: "    if (tid === S.lastOrderTrackId) return; // 同一首会重复发 setCurrentPlay，不算新的一首",
    replace: "    // （去重被删掉）",
    expect: "42",
  },
  {
    name: "v0.2.10: [list] 日志又用回旧 curTrackId（索引/下一首 是上一首的，误导排查）",
    file: "main.js",
    find: '          var nx = nextTrack(tid);\n          log("[list] 当前曲目 track=" + tid + " ｜ 索引=" + playlistIndex(tid) + " ｜ 下一首="',
    replace: '          var nx = nextTrack();\n          log("[list] 当前曲目 track=" + tid + " ｜ 索引=" + playlistIndex() + " ｜ 下一首="',
    expect: "43",
  },

  /* ---- v0.4.0 流式播放（<audio>） ---- */
  {
    name: "v0.4.0: 不挂 loadedmetadata（onLoad 永远发不出去 → UI 一直转圈）",
    file: "main.js",
    find: '    el.addEventListener("loadedmetadata", onMeta);',
    replace: "    // 忘了挂 loadedmetadata",
    expect: "52",
  },
  {
    name: "v0.4.0: metadata 之前就发 onLoad（duration=0，UI 拿不到时长）",
    file: "main.js",
    find: "    if (!apply(url)) return false;\n    return true;\n  }",
    replace: '    if (!apply(url)) return false;\n    emitLoad(0, ""); // 变异：提前发\n    return true;\n  }',
    expect: "52",
  },
  {
    name: "v0.4.0: loadProgress 改发 0（回归真机踩过的「UI 转圈 + 暂停失灵」）",
    file: "main.js",
    find: 'emit("audioplayer.onPlayProgress", S.audioId[0], pos, 1);',
    replace: 'emit("audioplayer.onPlayProgress", S.audioId[0], pos, 0);',
    expect: "56",
  },
  {
    name: "v0.4.0: 换歌不摘旧事件（旧歌的事件会串到新歌上）",
    file: "main.js",
    find: "    if (detachStream) {\n      try {\n        detachStream();\n      } catch (e) {}\n      detachStream = null;\n    }",
    replace: "    // 变异：忘了摘旧事件",
    expect: "55",
  },
  {
    name: "v0.4.0: 手势重试走 doPlay（会被乐观置的 paused 挡住 → 永远重试不成功）",
    file: "main.js",
    find: "      S.pendingPlay = false;\n      // ★ 直接调 startPlayback（**绕过** doPlay 的「已经在播就忽略」守卫）：\n      //   被拒之后 `S.paused` 可能被一次失败的乐观置位搞成 false，走 doPlay 会直接被忽略掉。\n      startPlayback();",
    replace: "      S.pendingPlay = false;\n      doPlay();",
    expect: "54",
  },
  {
    name: "v0.4.0: 不忽略「迟到的 play() 拒绝」（状态被翻回去、手势监听重新挂上）",
    file: "main.js",
    find: '    if (gen !== undefined && gen !== S.playGen) {\n      log("[play] 旧的一次 play() 拒绝被忽略（已经有更新的尝试）");\n      return;\n    }\n',
    replace: "",
    expect: "54",
  },
  {
    name: "v0.4.0: 本地文件不走 mountFile（本地歌直接播不了）",
    file: "main.js",
    find: "    if (local) {\n      // 本地文件：`betterncm.fs.mountFile` 给一个可播 URL（LFP 就是这么做的）",
    replace: "    if (false) {\n      // 本地文件：`betterncm.fs.mountFile` 给一个可播 URL（LFP 就是这么做的）",
    expect: "57",
  },
  {
    name: "v0.4.0: 每次 load 都 createMediaElementSource（第二次必抛 InvalidStateError）",
    file: "main.js",
    find: "    if (S.el) return S.el;\n    if (!S.ctx) return null;",
    replace: "    if (!S.ctx) return null;",
    expect: "58",
  },
  {
    name: "v0.4.0: 静音自检失效（被跨域静音了也不告警、不退回缓冲）",
    file: "main.js",
    find: "      if (S.silentTick >= 2 && !S.silentSuspect) {",
    replace: "      if (false) {",
    expect: "59",
  },

  /* ---- v0.4.1 真无缝预约 ---- */
  {
    name: "v0.4.1: ★★ 交接时 stopSource 挪到「提升 B」之后（把正在响的 B 停掉）",
    file: "main.js",
    find: "      playClockStop(); // 把 A 最后一段折进 playedMs\n      stopSource(); // ★ 此刻 S.source 仍是 A（流式时是元素）→ 只停 A，绝不碰 B\n      S.stream = false; // ★ v0.4.2：从这一刻起由 B 的缓冲发声\n      S.source = sc.src;",
    replace: "      playClockStop();\n      S.stream = false;\n      S.source = sc.src;\n      stopSource(); // 变异：挪到提升 B 之后 → 会把正在响的 B 停掉",
    expect: "63",
  },
  {
    name: "v0.4.1: ★★ 预约时就把 S.source 改成 B（A 的 onended 守卫失败 → [end] 永不发）",
    file: "main.js",
    find: "    // ★ 刻意**不动 `S.source`**：A 的 `onended` 守卫是 `src === S.source`，\n    //   一旦改成 B，A 播完时守卫失败 → `onNaturalEnd` 不触发 → 不发 `[end]` → UI 永不推进。\n    S.sched = {",
    replace: "    S.source = src; // 变异：预约时就把当前 source 改成 B\n    S.sched = {",
    expect: "63",
  },
  {
    name: "v0.4.1: 删掉 loadSong 顶部的「无缝认领」短路（到了 load 又重播一遍）",
    file: "main.js",
    find: "    if (S.sched && S.sched.phase === \"live\" && S.sched.trackId === trackId) {\n      claimSeamless(id, payload, trackId);\n      return;\n    }",
    replace: "    // 变异：删掉认领短路",
    expect: "64",
  },
  {
    name: "v0.4.1: 删掉 doPlay 的 announce 分支（认领后 UI 停在「暂停」）",
    file: "main.js",
    find: "      if (S.sched && S.sched.phase === \"claimed\" && !S.sched.announced) {\n        S.sched.announced = true;\n        log(\"[play] ★ 无缝认领 → 补发 onPlayState(1)（不重启）\");\n        emitPlayState(1);\n        S.sched = null;\n        return;\n      }",
    replace: "      // 变异：删掉 announce 分支",
    expect: "65",
  },
  {
    name: "v0.4.1: 时间窗失效（还剩 5 分钟也敢排）",
    file: "main.js",
    // ⚠️ v1.3.0 起窗口是 `max(1.5, xf+0.4)`（开了交叉要更早排），不再写死 1.5
    find: "      if (left < 0.3 || left > winMax) return;",
    replace: "      if (false) return; // 变异：时间窗失效",
    expect: "62",
  },
  {
    name: "v0.4.1: 模式闸门失效（随机 / 单曲循环也照样预约）",
    file: "main.js",
    // ⚠️ 3.x 分支给这道闸门加了 `hitStreak` 例外，锚点是「例外那一行」——
    //   把它删掉 = 随机模式下也一律预约（正是这条变异的语义）。
    find: "        if (!(isNcm3() && (S.hitStreak || 0) >= 1)) return;",
    replace: "        /* 变异：随机模式也照样预约 */",
    expect: "62",
  },
  {
    name: "v0.4.1: 播放模式键名又写错（用 PLAYER 而不是 NM_SETTING_PLAYER）",
    file: "main.js",
    find: 'raw = localStorage.getItem("NM_SETTING_PLAYER");',
    replace: 'raw = localStorage.getItem("PLAYER");',
    expect: "61",
  },
  {
    name: "v0.4.1: 暂停不撤销预约（B 会到点自己响）",
    file: "main.js",
    find: '    if (S.sched) cancelSched("暂停"); // ★ v0.4.1：暂停必须撤销预约（否则 B 会到点自己响）',
    replace: "    // 变异：暂停不撤销预约",
    expect: "67",
  },
  {
    name: "v0.4.1: cancelSched 不停已排上的 source（B 会到点自己响）",
    file: "main.js",
    find: '    if (sc.phase === "armed") {\n      try {\n        sc.src.onended = null;\n      } catch (e) {}\n      try {\n        sc.src.stop();\n      } catch (e) {}',
    replace: '    if (false) {\n      try {\n        sc.src.onended = null;\n      } catch (e) {}\n      try {\n        sc.src.stop();\n      } catch (e) {}',
    expect: "67",
  },
  {
    name: "v0.4.1: 押错不 abortSeamless（错歌一直响下去）",
    file: "main.js",
    find: '            } else {\n              // 押错：预约的是别的 → 撤销（live 时还要停掉已经响起来的 B）\n              abortSeamless("押错（预约 " + S.sched.trackId + "，实际 " + tid + "）");\n            }',
    replace: "            } else {\n              // 变异：押错不处理\n            }",
    expect: "66",
  },
  {
    name: "v0.4.1: 用 takePreload 代替 peekPreloadBuffer（消费掉预载槽 → 自适应瞎 + 重复预载）",
    file: "main.js",
    find: "    var buf = peekPreloadBuffer(nid);",
    replace: "    var buf = takePreload(nid);",
    expect: "73",
  },
  {
    name: "v0.4.1: live 窗口不抑制进度（进度条从 0 闪一下）",
    file: "main.js",
    find: "      if (S.sched && S.sched.phase === \"live\") return;",
    replace: "      if (false) return; // 变异：live 不抑制进度",
    expect: "72",
  },
  {
    name: "v0.4.1: 无缝交接分支整个失效（永远等 UI 的 load → ~195ms 间隙）",
    file: "main.js",
    find: "    if (sc && sc.phase === \"armed\") {",
    replace: "    if (false) { // 变异：不走无缝交接",
    expect: "63",
  },

  /* ---- v0.4.2 流式那一首也能预约 ---- */
  {
    name: "v0.4.2: 流式不参与预约（回到「流式播完必卡 503ms」）",
    file: "main.js",
    find: "    if (S.stream) {\n      if (!S.el) return;\n    } else if (!S.buffer || !S.source) {\n      return;\n    }",
    replace: "    if (S.stream) return; // 变异：流式不预约\n    if (!S.buffer || !S.source) return;",
    expect: "74",
  },
  {
    name: "v0.4.2: 交接时忘了把 S.stream 置回 false（<audio> 停住了但还在读它的位置）",
    file: "main.js",
    find: "      S.stream = false; // ★ v0.4.2：从这一刻起由 B 的缓冲发声\n",
    replace: "",
    expect: "75",
  },
  {
    name: "v0.4.2: 去掉「结束时刻估晚了 → 立刻起播」的兜底（VBR 的 duration 一偏就留空档）",
    file: "main.js",
    find: "      if (sc.startCtxTime > S.ctx.currentTime + 0.03) {",
    replace: "      if (false) { // 变异：估晚了也不管",
    expect: "76",
  },
  {
    name: "v1.2.0: 裁剪量恒为 0（等于没做 P0，接缝处仍带 ~25ms 静音）",
    file: "main.js",
    find: "    var fit = fitTrim(info, ab);",
    replace: '    var fit = { enc: { start: 0, end: 0 }, pad: { start: 0, end: 0 }, note: "变异：不裁", deltaMs: null };',
    expect: "81",
  },
  {
    name: "v1.2.0: 不看波形、硬按声明上限裁（解码器已裁过时会把真音乐切掉）",
    file: "main.js",
    find: "    var foundS = Math.min(silenceHead(ab, capS + 0.005), capS);",
    replace: "    var foundS = capS; // 变异：不验波形",
    expect: "81",
  },
  {
    name: "v1.2.0: startSource 忘了把 trim 加回缓冲偏移（时间轴整体后移 ~26ms）",
    file: "main.js",
    find: "    var bufAt = off + tr.start;",
    replace: "    var bufAt = off; // 变异：不加 trim",
    expect: "81",
  },
  {
    name: "v1.2.0: 预约 B 时不带 B 的裁剪量（B 开头那 26ms 静音又回来了）",
    file: "main.js",
    find: "      src.start(bStart, entry.offset, bPlayDur);",
    replace: "      src.start(bStart, 0, bdur); // 变异：不裁 B、也不跳入点",
    expect: "81",
  },
  {
    name: "v1.2.1: 作品静音也默认裁（越过 Spotify 的 gapless 语义，切掉作品内容）",
    file: "main.js",
    find: "  var TRIM_PAD_DEFAULT = false;",
    replace: "  var TRIM_PAD_DEFAULT = true; // 变异：默认也裁作品静音",
    expect: "81",
  },
  {
    name: "v1.2.1: 并发去重失效（同一 id 的取址/时长各打两遍）",
    file: "main.js",
    find: "    if (INFLIGHT[key]) return INFLIGHT[key];",
    replace: "    /* 变异：不去重 */",
    expect: "82",
  },
  {
    name: "v1.2.1: 字节缓存永不命中（同一首反复预载时白下 5~6MB）",
    file: "main.js",
    find: "    var e = BYTES_CACHE[trackId];",
    replace: "    var e = null; // 变异：缓存永不命中",
    expect: "83",
  },
  {
    name: "v1.2.1: 最近缓冲不复用（切回刚播过的歌又下一遍 + 重解一遍）",
    file: "main.js",
    find: "    var reuse = recentGet(trackId);",
    replace: "    var reuse = null; // 变异：不复用",
    expect: "83",
  },
  {
    name: "v1.3.0: 交叉时长永远读成 0（P2 整个失效，退化成硬接）",
    file: "main.js",
    find: "    var xf = xfadeSeconds();",
    replace: "    var xf = 0; // 变异：不做交叉",
    expect: "84",
  },
  {
    name: "v1.3.0: 用线性淡入淡出代替等功率（中点塌 -3dB，听起来音量掉一截）",
    file: "main.js",
    find: "        return Math.sin(x * Math.PI * 0.5); // equal power（默认）",
    replace: "        return x; // 变异：线性（默认档退化成线性）",
    expect: "84",
  },
  {
    name: "v1.3.0: 交叉曲线挂在主音量总线上（会改掉用户设的音量）",
    file: "main.js",
    find: "    var gB = chainB.gain;",
    replace: "    var gB = S.gain; // 变异：直接用总线",
    expect: "84",
  },
  {
    name: "v1.3.0: 停 source 时不复位增益（A 会一直留在淡出后的小声状态）",
    file: "main.js",
    // ★ 一次性干掉整条复位链路（stopSource + cancelSched + abortSeamless 都在用它）——
    //   只删一处的话另一处还会兜住，变异的语义就变成「冗余代码」，测不出来。
    find: "  function restoreGain(node, v) {\n    if (!node || !node.gain) return;",
    replace: "  function restoreGain(node, v) {\n    if (true) return; // 变异：不复位",
    expect: "84",
  },
  {
    name: "v1.3.0: 交接后不接管 B 的 gain（下一轮交叉打不到正在响的那一路）",
    file: "main.js",
    find: "      S.srcGain = sc.gain || null;",
    replace: "      S.srcGain = null; // 变异：不接管",
    expect: "84",
  },
  {
    name: "v1.3.1: 流式那首不补成缓冲（切回来仍然重新拉流，缓存只覆盖缓冲路径）",
    file: "main.js",
    find: "    if (!S.stream || !S.ready || S.paused || !S.el) return;",
    replace: "    if (true) return; // 变异：不补",
    expect: "85",
  },
  {
    name: "v1.3.1: 不等 8 秒就补（路过一首也付一次 6MB 下载）",
    file: "main.js",
    find: "    if (played < PROMOTE_AFTER_SEC * 1000) return;",
    replace: "    if (false) return; // 变异：不等",
    expect: "85",
  },
  {
    name: "v1.3.1: 补完不放进 recentBufs（等于白下）",
    file: "main.js",
    find: "        recentPut(tid, ab);",
    replace: "        /* 变异：不入缓存 */",
    expect: "85",
  },
  {
    name: "v1.3.1: 试听片段也塞进缓存（下次直接播半首）",
    file: "main.js",
    find: '              throw new Error(\n                "解码时长 " + ab.duration.toFixed(1) + "s 短于实际 " + (dtMs / 1000).toFixed(1) + "s（试听片段），不补"\n              );',
    replace: "              /* 变异：片段也照收 */",
    expect: "85",
  },
  {
    name: "v1.3.2: 曲线预设被忽略（永远等功率，__gpXfadeCurve 失效）",
    file: "main.js",
    find: "    var name = xfadeCurveName();",
    replace: '    var name = "equal"; // 变异：忽略预设',
    expect: "86",
  },
  {
    name: "v1.3.2: 高通扫频不排（DJ 过渡那一下没了）",
    file: "main.js",
    find: "      var aFilter = currentFilterNode();",
    replace: "      var aFilter = null; // 变异：不扫频",
    expect: "86",
  },
  {
    name: "v1.3.2: automix 探针不记录（客户端哪天接上计划也发现不了）",
    file: "main.js",
    find: "    if (!probeOn()) return cb;",
    replace: "    if (true) return cb; // 变异：不记录",
    expect: "86",
  },
  {
    name: "v1.3.3: ctx 起不来也硬按住原生（开机直接哑，还得点播放）",
    file: "main.js",
    find: "    if (ctxBlocked) {",
    replace: "    if (false) { // 变异：不兜底",
    expect: "87",
  },
  {
    name: "v1.3.3: 手势到了不交回引擎（永远停在原生死扛）",
    file: "main.js",
    find: "      S.deferNative = false;",
    replace: "      /* 变异：不交回 */",
    expect: "87",
  },
  {
    name: "v1.3.3: 接管第一首时不停原生（双声）",
    file: "main.js",
    find: "        if (S.nativeRunning) pauseNative();",
    replace: "        /* 变异：不停原生 */",
    expect: "87",
  },
  {
    name: "v1.4.0: 智能默认失效（随机播放也永远不交叉）",
    file: "main.js",
    find: '    if (mode === "playrandom" || mode === "playai") return "light";',
    replace: '    if (false) return "light"; // 变异：不智能',
    expect: "88",
  },
  {
    name: "v1.4.0: 显式时长不再优先（用户手动设的被风格盖掉）",
    file: "main.js",
    find: "    if (explicitSec !== null) {",
    replace: "    if (false) { // 变异：忽略显式值",
    expect: "88",
  },
  {
    name: "v1.4.0: DJ 风格不扫频（等于只是个更长的交叉）",
    file: "main.js",
    find: '    dj: { xfade: 3, curve: "s-line", eq: true, label: "DJ" },',
    replace: '    dj: { xfade: 3, curve: "s-line", eq: false, label: "DJ" }, // 变异：不扫频',
    expect: "88",
  },
  {
    name: "v1.4.0: 风格不持久化（每次重启都回到智能默认）",
    file: "main.js",
    find: "      localStorage.setItem(STYLE_KEY, name);",
    replace: "      /* 变异：不记住 */",
    expect: "88",
  },
  {
    name: "v1.5.0: 八度折算失效（120 vs 60 被当成不同步）",
    file: "main.js",
    find: "      var sp = gA.bpm / (gB.bpm * fact[i]);",
    replace: "      var sp = gA.bpm / gB.bpm; // 变异：不折八度",
    expect: "89",
  },
  {
    name: "v1.5.0: 置信度造假（静音也当高置信，硬做拍点对齐）",
    file: "main.js",
    find: "    var conf = (bestPhaseScore - meanOnset) / (bestPhaseScore + meanOnset + 1e-9);",
    replace: "    var conf = 0.9; // 变异：置信度造假",
    expect: "89",
  },
  {
    name: "v1.5.0: 低置信也判 full（明明不同步却硬对齐）",
    file: "main.js",
    find: "    if (conf >= 0.45 && bestDev <= 0.06) tier = \"full\";",
    replace: "    if (true) tier = \"full\"; // 变异：不看置信",
    expect: "89",
  },
  {
    name: "v1.5.0: 拍点吸附不生效（算出来了但没用）",
    file: "main.js",
    find: "          if (sn.delta) {",
    replace: "          if (false) { // 变异：不吸附",
    expect: "89",
  },
  {
    name: "v1.5.1: B 的入点永远从 0 开始（前奏/空白照吃不误）",
    file: "main.js",
    find: "          ? pickBEntry(gB2, btrim, bdur, buf)",
    replace: "          ? { offset: btrim.start, skip: 0, reason: '变异' }",
    expect: "90",
  },
  {
    name: "v1.5.1: 开头空白不跳过（入点落在空气声里）",
    file: "main.js",
    find: "    var from = start + Math.max(0, gap - 0.05);",
    replace: "    var from = start; // 变异：不管空白",
    expect: "90",
  },
  {
    name: "v1.5.1: 空白比上限还长也硬跳（把自己扔进静音中间）",
    file: "main.js",
    find: "      if (gap >= cap - 0.01) {",
    replace: "      if (false) { // 变异：硬跳",
    expect: "90",
  },
  {
    name: "v1.5.1: 交接后忘记入点（进度从 0 跳回）",
    file: "main.js",
    find: "      S.startOffset = sc.startOffset || 0; // ★ v1.5.1：B 可能从半拍/空白之后进场",
    replace: "      S.startOffset = 0; // 变异：丢掉入点",
    expect: "90",
  },
  {
    name: "v1.5.2: 拍点对齐默认关（还得手动开）",
    file: "main.js",
    find: '      if (typeof window !== "undefined" && window && window.__gpAutoMix === false) return false;',
    replace: "      return false; // 变异：默认关",
    expect: "91",
  },
  {
    name: "v1.5.2: 状态行不显示拍点状态（默认开这件事看不见）",
    file: "main.js",
    find: '      beatText = "开（已分析 " + bn + " 段）";',
    replace: '      beatText = "关"; // 变异：不显示',
    expect: "91",
  },
  {
    name: "v1.5.2: 分段控件不高亮（不知道现在选的哪档）",
    file: "main.js",
    find: '        b.className = on ? "on" : "";',
    replace: '        b.className = ""; // 变异：不高亮',
    expect: "91",
  },
  {
    name: "v1.5.2: 拨动开关点了不回调（样子货）",
    file: "main.js",
    find: "        onChange(sw.__on);",
    replace: "        /* 变异：不回调 */",
    expect: "91",
  },
  {
    name: "v1.5.2: 干净风格就不管开头空白了（接缝处留个洞）",
    file: "main.js",
    find: "          : pickBEntry(null, btrim, bdur, buf, { silenceOnly: true });",
    replace: "          : { offset: btrim.start, skip: 0, reason: '变异' };",
    expect: "90",
  },

  {
    name: "v1.5.2: 面板样式没注入（回到浏览器默认控件）",
    file: "main.js",
    find: '      ensurePanelCss();\n      var b = el("div", "gp-fab", "♪");',
    replace: '      var b = el("div", "gp-fab", "♪");',
    expect: "91",
  },
  {
    name: "v1.5.3: 不做预开（还是等切歌那一刻现拉流）",
    file: "main.js",
    find: "    maybePreopenNext(nid);",
    replace: "    /* 变异：不预开 */",
    expect: "92",
  },

  {
    name: "v1.5.3: 切歌时不复用预开的流（重设 src = 重新下载）",
    file: "main.js",
    find: "      if (S.preopenUrl && S.preopenTrackId !== null && S.preopenTrackId === S.curTrackId) {",
    replace: "      if (false) { // 变异：不复用",
    expect: "92",
  },
  {
    name: "v1.5.3: metadata 早已就绪也不补发（会一直等一个不会再来的事件）",
    file: "main.js",
    find: "    if (S.preopenUrl && el && Number(el.readyState) >= 1) {",
    replace: "    if (false) { // 变异：不补",
    expect: "92",
  },
  {
    name: "v1.5.3: 换预载目标时不清预开（白占一条连接）",
    file: "main.js",
    find: '      clearPreopen("换预载目标");',
    replace: "      /* 变异：不清 */",
    expect: "92",
  },
  {
    name: "v1.5.3: preopenStream 自己不守「元素在用」（复用函数被单独调用时踩雷）",
    file: "main.js",
    find: "    if (S.stream) return false; // 元素在用",
    replace: "    if (false) return false; // 变异：不管",
    expect: "92",
  },
];


/**
 * 在**同一个进程里**跑验证台。
 *
 * ⚠️ 为什么不用 spawnSync 开子进程：Windows 沙箱里 spawn 子进程会直接 EBUSY
 *    （连 cmd.exe 都起不来），拿不到任何输出。而旧版判定写的是 `r.code !== 0` ——
 *    spawn 失败时 status 是 null，`null !== 0` 恒真 → **不管验证台红不红都算「抓住」**。
 *    也就是说变异测试整个是空转的假绿灯（2026-10-14 发现）。
 *    同进程跑还有个好处：快得多（不用每轮重开一次 node）。
 */
async function runHarness(srcFile, startupFile) {
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  const origSrc = process.env.GP_SRC;
  const origStartup = process.env.GP_STARTUP;

  process.env.GP_SRC = srcFile;
  process.env.GP_STARTUP = startupFile;
  process.exitCode = 0;
  console.log = (...a) => out.push(a.map(String).join(" "));
  console.error = (...a) => out.push(a.map(String).join(" "));

  let code = 0;
  try {
    delete require.cache[require.resolve(HARNESS)];
    await require(HARNESS); // harness.js 导出的是它的 main() promise
    code = process.exitCode || 0;
  } catch (e) {
    out.push("验证台自己崩了：" + (e && e.stack ? e.stack : e));
    code = 2;
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (origSrc === undefined) delete process.env.GP_SRC;
    else process.env.GP_SRC = origSrc;
    if (origStartup === undefined) delete process.env.GP_STARTUP;
    else process.env.GP_STARTUP = origStartup;
  }
  return { code, out: out.join("\n") };
}

/** 从验证台输出里挑出「有 ✗ 的段落号」—— 段落头按顺序打印，✗ 前面最近的段落头就是它所属段落 */
function failedSections(out) {
  const secs = new Set();
  let cur = null;
  out.split("\n").forEach((line) => {
    const m = /^──\s*(\d+)\./.exec(line);
    if (m) cur = m[1];
    if (line.indexOf("✗") >= 0 && cur) secs.add(cur);
  });
  return Array.from(secs);
}

async function main() {
  fs.mkdirSync(MUT, { recursive: true });
  let caught = 0;
  const missed = [];

  for (const m of MUTATIONS) {
    const orig = fs.readFileSync(path.join(SRC, m.file), "utf8");
    if (orig.indexOf(m.find) < 0) {
      console.log("  ?? 锚点没命中：" + m.name + "  （" + m.file + " 里找不到 " + JSON.stringify(m.find) + "）");
      missed.push(m.name + " [锚点失配]");
      continue;
    }
    const mutated = orig.split(m.find).join(m.replace);
    const out = path.join(MUT, m.file.replace(/\.js$/, "") + ".mut.js");
    fs.writeFileSync(out, mutated);

    const src = m.file === "main.js" ? out : path.join(SRC, "main.js");
    const startup = m.file === "startup_script.js" ? out : path.join(SRC, "startup_script.js");
    const r = await runHarness(src, startup);

    // ★ 先确认验证台**真的跑起来了**（有输出、且不是自己崩了）。
    //   不确认这一步的话，就会重演「spawn 失败 → 判定恒真 → 假绿灯」。
    const ran = r.out.length > 0 && r.out.indexOf("验证台自己崩了") < 0;
    const failed = r.code !== 0;
    const hitSection = r.out.indexOf(m.expect) >= 0 && r.out.indexOf("✗") >= 0;

    if (!ran) {
      missed.push(m.name + " [验证台没跑起来]");
      console.log("  ?? 验证台没跑起来：" + m.name + "  ｜ 退出码=" + r.code);
    } else if (failed && hitSection) {
      caught++;
      console.log("  ✓ 抓住了：" + m.name);
    } else if (failed) {
      caught++;
      console.log("  ✓ 抓住了（但没落在预期段落 " + m.expect + "，实际红了第 " + failedSections(r.out).join("/") + " 段）：" + m.name);
    } else {
      missed.push(m.name);
      console.log("  ✗ 漏网了（验证台仍然全绿）：" + m.name);
    }
  }

  console.log("\n====================");
  console.log("变异点 " + MUTATIONS.length + " 个，抓住 " + caught + " 个，漏网 " + missed.length + " 个");
  if (missed.length) {
    console.log("\n漏网清单：");
    missed.forEach((n) => console.log("  - " + n));
    process.exit(1);
  }
  console.log("全部变异都被抓住 ✅");
  // ★ 必须显式清零：每一轮跑的验证台在「该红」时会把 process.exitCode 置 1，
  //   而最后一轮本来就是故意红的 → 不清零的话，全部抓住也会退出码 1（CI 里就是假失败）。
  process.exitCode = 0;
}

main().catch((e) => {
  console.error("变异测试自己崩了：", e);
  process.exit(2);
});
