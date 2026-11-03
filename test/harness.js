#!/usr/bin/env node
/*
 * GaplessPlayer 离线验证台
 *
 * 目的：插件不能热重载，每次试错都要重启网易云。所以先用假的运行环境把
 *       src/main.js 完整跑一遍，验证拦截层、播放引擎、事件伪造三块逻辑。
 *
 * 用法：node test/harness.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MAIN = process.env.GP_SRC || path.join(__dirname, "..", "src", "main.js");
const STARTUP =
  process.env.GP_STARTUP || path.join(__dirname, "..", "src", "startup_script.js");

/* ==================== 断言框架 ==================== */

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    failures.push(label);
    console.log("  ✗ " + label);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label + "  (期望 " + e + "，实际 " + a + ")");
}

/**
 * 安全取事件参数。★ 变异体把事件搞没了时 `last()` 返回 null ——
 * 直接 `last(...).args[0]` 会把验证台**整个搞崩**（退出码 2），
 * 那样变异体是「崩了」而不是「干净报红」，报告就没法看了。
 */
function argsOf(ev) {
  return (ev && ev.args) || [];
}
/** 取第 i 个参数；越界 / null / undefined 返回 {}（下游 `eq` 会干净地报红，不会抛错） */
function argAt(ev, i) {
  const a = argsOf(ev);
  if (i >= a.length) return {};
  // ⚠️ 不能写 `a[i] || {}` —— 那样合法的 0 / "" 会被吃掉
  return a[i] === null || a[i] === undefined ? {} : a[i];
}
/** 取数组第 i 个元素；越界 / null 返回 {}（变异体把数组清空时别把验证台搞崩） */
function at(arr, i) {
  return arr && i < arr.length && arr[i] != null ? arr[i] : {};
}
/** 取数组最后一个元素；空数组返回 {} */
function lastOf(arr) {
  return (arr && arr.length ? arr[arr.length - 1] : null) || {};
}
/** 取第 i 个已启动 source 的 `onended` 回调；缺失时返回空函数
 *  （变异体没排 source 时，直接 `.node.onended()` 会把验证台**搞崩** → 必须干净报红） */
function enderOf(arr, i) {
  const s = arr && i >= 0 && i < arr.length ? arr[i] : null;
  return s && s.node && typeof s.node.onended === "function" ? s.node.onended : function () {};
}
/** 取第 i 个已启动 source 的节点；缺失返回 null（用于 identity 断言，别用 {}） */
function nodeOf(arr, i) {
  const s = arr && i >= 0 && i < arr.length ? arr[i] : null;
  return s && s.node ? s.node : null;
}

function section(name) {
  console.log("\n── " + name + " ──");
}

/* ==================== 假环境 ==================== */

function createEnv(hooks) {
  const emitted = []; // triggerRegisterCall 记录
  const nativeCalls = []; // 落到「原版 channel.call」的调用
  const started = []; // source.start 记录
  const stopped = []; // source.stop 记录
  const writes = []; // 日志写入
  const intervals = []; // setInterval 回调（手动触发）
  const timeouts = [];
  const decoded = []; // decodeAudioData 收到的 buffer 大小
  const meSrcCalls = []; // createMediaElementSource 收到过的元素（★ 同一元素只能调一次）
  let startupCalls = []; // 启动阶段落到原版 channel.call 的调用

  /* ---- 假的 AudioContext ---- */
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    state: "running",    destination: { __node: "destination" },
    createGain() {
      // ★ v1.3.0：参数要能记录自动化事件（交叉淡入淡出就是靠 setValueCurveAtTime）
      const param = {
        value: 1,
        events: [], // { type:"curve"|"set", t, dur, curve }
        setValueAtTime(v, t) {
          param.events.push({ type: "set", v, t });
          param.value = v;
        },
        setValueCurveAtTime(curve, t, dur) {
          // 与真实现一致：区间内已有事件（含重叠的曲线）就抛 —— 这样才测得出「先 cancel」那条
          for (const e of param.events) {
            const eT = e.t || 0;
            const eEnd = e.type === "curve" ? eT + e.dur : eT;
            if (eEnd > t && eT < t + dur) {
              const err = new Error("overlapping automation event");
              err.name = "NotSupportedError";
              throw err;
            }
          }
          param.events.push({ type: "curve", curve, t, dur, at: t, len: dur });
          param.value = curve[curve.length - 1];
        },
        cancelScheduledValues(t) {
          param.events = param.events.filter((e) => (e.t || 0) < t);
        },
      };
      const g = {
        gain: param,
        connect() {},
        disconnect() {},
      };
      // ★ ctx.__gain 永远指向**第一个**建的 gain（= 插件的主音量总线），
      //   后面的（每个 source 自己的、流式元素的）进 __gains，方便交叉淡入淡出的用例去找。
      if (!ctx.__gain) ctx.__gain = g;
      (ctx.__gains = ctx.__gains || []).push(g);
      return g;
    },
    createAnalyser() {
      return {
        frequencyBinCount: 1024,
        // ★ 默认给非零数据：真实音频的 FFT 不可能全 0。
        //   全 0 是「被跨域静音（taint）」的判据，所以验证台要能主动造出来（ctx.__analyserZeros）。
        getByteFrequencyData(o) {
          if (!ctx.__analyserZeros) for (let i = 0; i < o.length; i++) o[i] = 50;
        },
        connect() {},
        disconnect() {},
      };
    },
    /** ★ v1.3.2：交叉淡入淡出会用到高通扫频，假环境也得有 BiquadFilter */
    createBiquadFilter() {
      const param = (v) => ({
        value: v,
        events: [],
        setValueAtTime(x, t) {
          this.events.push({ type: "set", v: x, t });
          this.value = x;
        },
        linearRampToValueAtTime(x, t) {
          this.events.push({ type: "ramp", v: x, t });
          this.value = x;
        },
        cancelScheduledValues() {
          this.events = [];
        },
      });
      const f = {
        type: "lowpass",
        frequency: param(350),
        Q: param(1),
        connect() {},
        disconnect() {},
      };
      (ctx.__filters = ctx.__filters || []).push(f);
      return f;
    },
    createMediaElementSource(el) {
      meSrcCalls.push(el);
      return { connect() {}, disconnect() {} };
    },
    createBufferSource() {
      const s = {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        start(at, off, dur) {
          s.__started = { at, off, dur };
          started.push({ at, off, dur, node: s });
        },
        stop() {
          stopped.push(s);
        },
      };
      return s;
    },
    decodeAudioData(buf) {
      decoded.push(buf ? buf.byteLength : -1);
      // ★ v1.2.0：允许用例注入「假 AudioBuffer」（要测首尾裁剪，就得能控制波形与时长）
      if (hooks && typeof hooks.decode === "function") {
        const r = hooks.decode(buf);
        if (r) return Promise.resolve(r);
      }
      return Promise.resolve({
        duration: 200,
        numberOfChannels: 2,
        sampleRate: 48000,
        length: 9600000,
      });
    },
    resume() {
      ctx.state = "running";
      return Promise.resolve();
    },
  };
  // ★ v1.3.3：模拟「autoplay 策略把 AudioContext 卡在 suspended」（不带启动参数的真机就是这样）
  if (hooks && hooks.suspended) ctx.state = "suspended";

  /* ---- 假 performance（可控时钟，用来验证 playedTime 累计）---- */
  const perf = {
    _t: 1000,
    now() {
      return this._t;
    },
  };

  /* ---- 假 window ---- */
  const winListeners = {};
  const win = {
    AudioContext: function () {
      return ctx;
    },
    betterncm_native: {},
    // ★ v0.4.0：验证台默认强制走缓冲（`__gpStream = false`），
    //   这样 16~43 那批「预载 / 记忆 / 窗口」老场景继续覆盖缓冲路径。
    //   流式场景显式 `delete e.win.__gpStream` 或设成 true；另有 1 条断言盯着「不设开关时走流式」。
    __gpStream: false,
    addEventListener(n, fn) {
      (winListeners[n] = winListeners[n] || []).push(fn);
    },
    removeEventListener(n, fn) {
      const arr = winListeners[n] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  /** 模拟用户点了一下（用来测 autoplay policy 的「等手势再起播」） */
  function fireGesture() {
    (winListeners.pointerdown || []).slice().forEach((fn) => fn());
  }

  /* ---- 假 <audio>（v0.4.0 流式路径）---- */
  const audio = {
    listeners: {},
    instances: [],
    last: null,
    playReject: null, // 设成 "NotAllowedError" 就模拟 play() 被拒
    /** 触发所有已注册的某个元素事件（loadedmetadata / ended / error） */
    emit(name) {
      const a = audio.last;
      if (!a) return;
      (audio.listeners[name] || []).slice().forEach((fn) => fn({ type: name }));
    },
    count(name) {
      return (audio.listeners[name] || []).length;
    },
  };
  function FakeAudio() {
    const a = {
      src: "",
      preload: "",
      volume: 1,
      muted: false,
      currentTime: 0,
      duration: NaN,
      paused: true,
      ended: false,
      readyState: 0,
      error: null,
      buffered: { length: 1, end: () => 10 },
      seekable: { length: 1, end: () => 200 },
      __loads: 0,
      load() {
        a.__loads++;
      },
      play() {
        if (audio.playReject) {
          const e = new Error("play() failed");
          e.name = audio.playReject;
          return Promise.reject(e);
        }
        a.paused = false;
        return Promise.resolve();
      },
      pause() {
        a.paused = true;
      },
      addEventListener(n, fn) {
        (audio.listeners[n] = audio.listeners[n] || []).push(fn);
      },
      removeEventListener(n, fn) {
        const arr = audio.listeners[n] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      canPlayType() {
        return "probably";
      },
      removeAttribute() {},
    };
    audio.instances.push(a);
    audio.last = a;
    return a;
  }

  /* ---- 假 fetch（★ v0.2.5：支持 AbortSignal —— 作废时要能「真的掐断」）---- */
  const fetchLog = [];
  const abortedFetches = []; // 被 abort 掐掉的 URL（验证「作废 = 真掐断」用）
  function mkAbortError() {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  }
  function fetch(url, opt) {
    fetchLog.push(url);
    const signal = opt && opt.signal;
    const body = {
      status: 200,
      type: "basic",
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: () => Promise.resolve(hooks && hooks.bytes ? hooks.bytes : new ArrayBuffer(1024 * 1024)),
    };
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        abortedFetches.push(String(url));
        return reject(mkAbortError());
      }
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            abortedFetches.push(String(url));
            reject(mkAbortError());
          },
          { once: true }
        );
      }
      // /hang/ 的请求**永不自己兑现** —— 专门留给「作废能不能掐断在飞下载」的用例
      if (/hang/.test(String(url))) return;
      // 延后一个微任务再兑现，好让「同步 abort」有机会先把它拒掉
      Promise.resolve().then(() => {
        if (signal && signal.aborted) return; // 已经被 abort 拒了，别再兑现
        if (/^fail/.test(String(url))) return reject(new Error("mock network down"));
        resolve(body);
      });
    });
  }

  /* ---- 假 betterncm ---- */
  const fsFiles = {}; // 假文件系统：路径 -> 文本（记忆文件、日志都写这里）
  const betterncm = {
    isMRBNCM: false,
    fs: {
      writeFile(p, blob) {
        const text = blob && blob.parts ? blob.parts.join("") : "";
        fsFiles[String(p)] = text;
        // ⚠️ 只有「日志文件」才计入 writes —— logs() 取的是 writes 的最后一份快照，
        //    要是把记忆文件也塞进来，logs() 就会返回记忆文件的内容（所有断言全乱）。
        if (String(p).indexOf("gapless-player.log") >= 0) writes.push({ path: p, blob });
      },
      /** ★ v0.4.0：本地文件走流式时用它换一个可播 URL（LFP 就是这么做的） */
      mountFile(p) {
        return Promise.resolve("blob:mock/" + p);
      },
      readFile(p) {
        const key = String(p);
        if (Object.prototype.hasOwnProperty.call(fsFiles, key)) {
          const s = fsFiles[key];
          const buf = new ArrayBuffer(s.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff;
          return Promise.resolve(buf);
        }
        if (/^missing/.test(key)) return Promise.reject(new Error("no such file"));
        return Promise.resolve(new ArrayBuffer(2048 * 1024));
      },
    },
  };

  /* ---- 假 LibEAPIRequest（A1 预载查地址用）---- */
  const eapi = {
    log: [],
    available: true, // isRequestAvailable() 的返回值
    mode: "ok", // ok | nourl | fail
    url: "http://cdn.example/next.flac",
    eapiRequest(url, opts) {
      this.log.push({ url, data: opts && opts.data });
      if (this.mode === "fail") {
        if (opts && opts.onerror) opts.onerror(new Error("mock eapi 请求失败"));
        return;
      }
      const body =
        this.mode === "nourl"
          ? { data: [{ id: 1, url: null, br: 999000, size: 0 }] }
          : { data: [{ id: 1, url: this.url, br: 999000, size: 12345 }] };
      if (opts && opts.onload) opts.onload(body);
    },
  };
  const loadedPlugins = {
    LibEAPIRequest: {
      isRequestAvailable() {
        return eapi.available;
      },
      eapiRequest: (u, o) => eapi.eapiRequest(u, o),
    },
  };
  const APP_CONF = { domain: "https://music.163.com", appver: "2.10.13.202675" };

  /* ---- 假 legacyNativeCmder ---- */
  const legacyNativeCmder = {
    appended: [],
    appendRegisterCall(name, ns, handler) {
      this.appended.push({ name, ns, handler });
    },
    triggerRegisterCall(name, ns) {
      const args = Array.prototype.slice.call(arguments, 2);
      emitted.push({ name, ns, args });
    },
  };

  /* ---- 假 registeredCalls（UI 的事件处理器注册表）---- */
  const registeredCalls = {};
  function on(event, fn) {
    (registeredCalls[event] = registeredCalls[event] || []).push(fn);
  }
  win.registeredCalls = registeredCalls;

  /* ---- 假 channel ---- */
  const originalCall = function (name, cb) {
    const callArgs = Array.prototype.slice.call(arguments, 2);
    nativeCalls.push({ name, args: callArgs });
    // ★ 3.x 用例需要假的「原生网络层」：插件会 channel.call("network.fetch", cb, [{url}])
    if (hooks && typeof hooks.onNative === "function") hooks.onNative(name, cb, callArgs);
  };
  // 假的原生桥：UI 用 channel.registerCall("audioplayer.onPlayState", cb) 注册。
  // 真机上它是 cloudmusic.dll 里 native function 包的壳；这里只记录调用。
  const nativeRegistered = [];
  const channel = {
    call: originalCall,
    registerCall(name, cb) {
      nativeRegistered.push({ name, cb });
    },
  };

  /* ---- 假 plugin ---- */
  let boot = null;
  const plugin = {
    onLoad(fn) {
      boot = fn;
    },
  };

  /* ---- 假定时器 ---- */
  const fakeSetInterval = function (fn) {
    intervals.push(fn);
    return intervals.length;
  };
  const fakeSetTimeout = function (fn) {
    timeouts.push(fn);
    return timeouts.length;
  };

  const localStorage = {
    _d: {},
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
  };

  /* ---- 装载 main.js ---- */
  const src = fs.readFileSync(MAIN, "utf8");
  const wrapper = new Function(
    "window",
    "betterncm",
    "channel",
    "legacyNativeCmder",
    "registeredCalls",
    "location",
    "fetch",
    "AbortController",
    "performance",
    "Blob",
    "setInterval",
    "setTimeout",
    "plugin",
    "localStorage",
    "loadedPlugins",
    "APP_CONF",
    "Audio",
    "console",
    "document",
    src
  );

  function FakeBlob(parts) {
    this.parts = parts;
  }

  wrapper(
    win,
    betterncm,
    channel,
    legacyNativeCmder,
    registeredCalls,
    { origin: "orpheus://orpheus" },
    fetch,
    AbortController,
    perf,
    FakeBlob,
    fakeSetInterval,
    fakeSetTimeout,
    plugin,
    localStorage,
    loadedPlugins,
    APP_CONF,
    FakeAudio,
    { log() {}, warn() {}, error() {} },
    // ★ v1.5.2：默认没有 DOM（面板会安静跳过）；需要测面板时用 createEnv({ document: fakeDoc() })
    hooks && hooks.document ? hooks.document : undefined
  );

  return {
    ctx,
    channel,
    emitted,
    nativeCalls,
    started,
    stopped,
    writes,
    intervals,
    timeouts,
    decoded,
    fetchLog,
    originalCall,
    betterncm,
    win,
    registeredCalls,
    on,
    legacyNativeCmder,
    nativeRegistered,
    audio,
    winListeners,
    fireGesture,
    meSrcCalls,
    eapi,
    loadedPlugins,
    APP_CONF,
    localStorage,
    files: fsFiles,
    fetch,
    perf,
    abortedFetches,
    boot() {
      if (!boot) throw new Error("plugin.onLoad 没被调用");
      boot();
      // 启动阶段会故意调一次原版 channel.call（按住原生播放器），
      // 单独存起来，免得干扰后面「播放命令有没有被拦下」的断言。
      startupCalls = nativeCalls.splice(0, nativeCalls.length);
    },
    get startupCalls() {
      return startupCalls;
    },
    /** 触发所有已注册的 interval 回调一次 */
    tick() {
      intervals.forEach((fn) => fn());
    },
    /** 触发所有已注册的 setTimeout 回调（让日志真正落盘） */
    flushTimers() {
      const fns = timeouts.splice(0, timeouts.length);
      fns.forEach((fn) => fn());
    },
    /** 推进假时钟（performance.now()） */
    advance(ms) {
      perf._t += ms;
    },
    last(name) {
      for (let i = emitted.length - 1; i >= 0; i--) {
        if (emitted[i].name === name) return emitted[i];
      }
      return null;
    },
    all(name) {
      return emitted.filter((e) => e.name === name);
    },
    /**
     * 取日志内容。
     * ⚠️ 只取**最后一次**写入 —— 插件的 flush 每次写的是整份缓冲区快照，
     *    如果把多次快照拼起来，行数会翻倍，任何「某行出现了几次」的断言都会失效。
     */
    logs() {
      if (!writes.length) return "";
      const last = writes[writes.length - 1];
      return last.blob && last.blob.parts ? last.blob.parts.join("") : "";
    },
  };
}

/** 把 promise 队列冲干净 */
function flush(n = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

/* ==================== 用例 ==================== */

async function main() {
  console.log("GaplessPlayer 离线验证台\n====================");

  /* ---------- 1. 启动与守卫 ---------- */
  section("1. 启动与 channel.call 守卫");
  let env = createEnv();
  env.boot();

  const locked = env.channel.call;
  ok(typeof locked === "function", "channel.call 是函数");
  try {
    env.channel.call = function hijacked() {};
  } catch (e) {
    /* 有些实现会直接抛，也算锁住 */
  }
  ok(env.channel.call === locked, "★ channel.call 被锁住，外部改写无效（防 LFP 抢回）");

  // 启动时必须先「按住原生播放器」，否则会和我们的 Web Audio 叠成双声道
  eq(env.startupCalls.length, 1, "★ 启动时调用了一次原版 channel.call");
  eq(env.startupCalls[0] && env.startupCalls[0].name, "audioplayer.pause", "★ 那次调用是 audioplayer.pause（按住原生播放器）");

  env.flushTimers();
  ok(env.logs().indexOf("GaplessPlayer") >= 0, "启动日志已写入文件");

  /* ---------- 2. 加载在线歌曲 ---------- */
  section("2. audioplayer.load（在线 FLAC）");
  env = createEnv();
  env.boot();

  env.channel.call("audioplayer.load", null, ["AID1", { musicurl: "http://m801.x/a.flac", format: "flac", bitrate: 999, fileSize: 44 }]);
  ok(env.fetchLog.length === 1, "fetch 被调用一次");
  eq(env.fetchLog[0], "http://m801.x/a.flac", "fetch 的 URL 正确");
  ok(env.nativeCalls.length === 0, "load 被拦下，没有落到原版 channel.call");

  await flush();
  eq(env.decoded.length, 1, "decodeAudioData 被调用一次");
  const load = env.last("Load");
  ok(!!load, "★ onLoad 已发出");
  eq(argAt(load, 0), "AID1", "onLoad 的 audioId 正确");
  eq(argAt(load, 1).duration, 200, "onLoad 带上了解码后的真实时长");
  eq(argAt(load, 1).errorCode, 0, "onLoad 无错误");

  /* ---------- 3. 等 UI 的 play 命令（v0.1.3 关键行为） ---------- */
  section("3. 解码完成后【不】抢跑，等 UI 的 play 命令");
  eq(env.started.length, 0, "★ 解码完不再立刻起播（v0.1.2 会抢跑 → 拿不到 token）");
  env.channel.call("audioplayer.play", () => {}, ["AID1", "AID1|resume|TOK123"]);
  eq(env.started.length, 1, "★ UI 发 play 后创建并启动 source");
  eq(at(env.started, 0).off, 0, "从 0 秒开始");
  const ps1 = env.last("PlayState");
  eq(argAt(ps1, 2), 1, "★ onPlayState = 1（播放中）");
  eq(argAt(ps1, 1), "AID1|resume|TOK123", "★★ onPlayState 第 2 参数带上了 UI 的 token（v0.1.2 缺状态段）");

  /* ---------- 3b. UI 一直不发 play → 兜底起播 ---------- */
  section("3b. UI 一直不发 play → 500ms 兜底起播");
  let envB = createEnv();
  envB.boot();
  envB.channel.call("audioplayer.load", null, ["BID", { musicurl: "http://x/b.flac" }]);
  await flush();
  eq(envB.started.length, 0, "还没起播");
  envB.flushTimers();
  eq(envB.started.length, 1, "★ 兜底自动起播（避免一直不出声）");

  /* ---------- 3c. ★★ emit 必须派发给 registeredCalls ---------- */
  section("3c. ★★ emit 必须派发给 registeredCalls（UI 的处理器就挂这里）");
  const envR = createEnv();
  const got = [];
  envR.on("audioplayer.onLoad", (id, payload) => got.push({ ev: "Load", id, dur: payload && payload.duration }));
  envR.on("audioplayer.onPlayState", (id, s, n) => got.push({ ev: "PlayState", n }));
  envR.on("audioplayer.onPlayProgress", (id, pos, lp) => got.push({ ev: "Progress", lp }));
  envR.boot();
  envR.channel.call("audioplayer.load", null, ["RID", { musicurl: "http://x/r.flac" }]);
  await flush();
  envR.channel.call("audioplayer.play", () => {}, ["RID", "RID|resume|Z"]);
  const evNames = got.map((g) => g.ev);
  ok(evNames.indexOf("Load") >= 0, "★ registeredCalls 收到了 onLoad");
  ok(evNames.indexOf("PlayState") >= 0, "★ registeredCalls 收到了 onPlayState");
  ok(evNames.indexOf("Progress") >= 0, "★ registeredCalls 收到了 onPlayProgress");
  const rLoad = got.find((g) => g.ev === "Load") || {};
  eq(rLoad.dur, 200, "onLoad 里带着真实时长");
  ok(
    got.some((g) => g.ev === "Progress" && g.lp === 1),
    "onPlayProgress 第 3 参数是加载进度"
  );

  /* ---------- 3d. ★★ 从 appendRegisterCall 自动捕获 UI 处理器 ---------- */
  section("3d. ★★ 自动捕获 UI 处理器（appendRegisterCall → registeredCalls）");
  const envG = createEnv();
  envG.boot();
  ok(
    typeof envG.legacyNativeCmder.appendRegisterCall.__gpWrapped === "boolean",
    "★ appendRegisterCall 已被挂钩（兜底）"
  );
  // 模拟网易云 UI 注册它的处理器（真机上它就是这么注册的）
  const uiGot = [];
  envG.legacyNativeCmder.appendRegisterCall("Load", "audioplayer", (id, payload) => uiGot.push(["Load", id, payload && payload.duration]));
  envG.legacyNativeCmder.appendRegisterCall("PlayState", "audioplayer", (id, s, n) => uiGot.push(["PlayState", n]));
  ok((envG.registeredCalls["audioplayer.onLoad"] || []).length === 1, "★ onLoad 处理器被记进 registeredCalls（键名 audioplayer.onLoad）");
  ok((envG.registeredCalls["audioplayer.onPlayState"] || []).length === 1, "★ PlayState 处理器被记进 registeredCalls");

  envG.channel.call("audioplayer.load", null, ["GID", { musicurl: "http://x/g.flac" }]);
  await flush();
  envG.channel.call("audioplayer.play", () => {}, ["GID", "GID|resume|T"]);
  ok(uiGot.some((g) => g[0] === "Load"), "★★ UI 的 onLoad 处理器被真的调用了");
  ok(uiGot.some((g) => g[0] === "PlayState" && g[1] === 1), "★★ UI 的 onPlayState 处理器被真的调用了");

  /* ---------- 3e. ★★ 主路径：UI 用 channel.registerCall 注册 ---------- */
  // 真机上 UI 走的是 channel.registerCall("audioplayer.onPlayState", cb)
  // （LFP 的 startup_script 就是包这个函数来建 registeredCalls 的）。
  // 这条路径比 appendRegisterCall 更关键，必须单独盯住。
  section("3e. ★★ 主路径：channel.registerCall → registeredCalls");
  const envH = createEnv();
  envH.boot();
  ok(
    typeof envH.channel.registerCall.__gpWrapped === "boolean",
    "★ channel.registerCall 已被挂钩"
  );
  const uiGot2 = [];
  envH.channel.registerCall("audioplayer.onLoad", (id, payload) => uiGot2.push(["Load", id, payload && payload.duration]));
  envH.channel.registerCall("audioplayer.onPlayState", (id, s, n) => uiGot2.push(["PlayState", n]));
  eq((envH.registeredCalls["audioplayer.onLoad"] || []).length, 1, "★ onLoad 处理器被记进 registeredCalls（键名原样保留）");
  eq((envH.registeredCalls["audioplayer.onPlayState"] || []).length, 1, "★ onPlayState 处理器被记进 registeredCalls");
  ok(
    envH.nativeRegistered.some((r) => r.name === "audioplayer.onPlayState"),
    "★ 原生的 registerCall 也照常收到（没把桥截断）"
  );

  envH.channel.call("audioplayer.load", null, ["HID", { musicurl: "http://x/h.flac" }]);
  await flush();
  envH.channel.call("audioplayer.play", () => {}, ["HID", "HID|resume|T"]);
  ok(uiGot2.some((g) => g[0] === "Load"), "★★ UI 的 onLoad 处理器被真的调用了");
  ok(uiGot2.some((g) => g[0] === "PlayState" && g[1] === 1), "★★ UI 的 onPlayState 处理器被真的调用了");

  /* ---------- 4. 进度心跳 ---------- */
  section("4. onPlayProgress 进度心跳");
  const before = env.all("PlayProgress").length;
  env.ctx.currentTime += 5;
  env.tick();
  const after = env.all("PlayProgress");
  ok(after.length > before, "心跳发出了新的 onPlayProgress");
  const pos = Number(argAt(after[after.length - 1], 1)) || 0;
  ok(Math.abs(pos - 4.98) < 0.2, "★ 进度值跟随 AudioContext 时间（约 4.98s，实际 " + pos.toFixed(2) + "）");
  eq(argAt(after[after.length - 1], 2), 1, "★★ 第 3 个参数是加载进度 = 1（发 0 会让网易云一直转圈、暂停失灵）");

  // 位置没变时不应该重复发（照 LFP 的做法）
  const n1 = env.all("PlayProgress").length;
  env.tick();
  env.tick();
  eq(env.all("PlayProgress").length, n1, "★ 位置没变就不重复发进度");

  /* ---------- 5. 暂停（A0 的核心验证点） ---------- */
  section("5. audioplayer.pause（A0 核心验证点）");
  env.ctx.currentTime += 10; // 播到约 15s
  env.channel.call("audioplayer.pause", () => {}, ["", ""]);
  ok(env.stopped.length >= 1, "★ source.stop() 被调用（音频真的停了）");
  const ps2 = env.last("PlayState");
  eq(argAt(ps2, 2), 2, "★ onPlayState = 2（已暂停）");

  const pausedPos = env.ctx.currentTime;
  env.ctx.currentTime += 30; // 暂停后时间流逝
  env.tick();
  const posAfterPause = Number(argAt(env.last("PlayProgress"), 1)) || 0;
  ok(Math.abs(posAfterPause - 14.98) < 0.3, "★ 暂停后进度冻住不再前进（" + posAfterPause.toFixed(2) + "s）");

  /* ---------- 6. 继续播放 ---------- */
  section("6. audioplayer.play（从暂停点续播）");
  const startCountBefore = env.started.length;
  env.channel.call("audioplayer.play", () => {}, ["AID1", "AID1|play|"]);
  eq(env.started.length, startCountBefore + 1, "★ 重新创建了 source");
  const off = Number(lastOf(env.started).off) || 0;
  ok(Math.abs(off - 14.98) < 0.3, "★ 从暂停点续播（offset ≈ 14.98，实际 " + off.toFixed(2) + "）");
  eq(argAt(env.last("PlayState"), 2), 1, "onPlayState = 1");

  /* ---------- 7. 拖动进度条 ---------- */
  section("7. audioplayer.seek");
  env.channel.call("audioplayer.seek", () => {}, ["AID1", "AID1|play|", 120]);
  const seek = env.last("Seek");
  ok(!!seek, "★ onSeek 已发出");
  eq(argAt(seek, 3), 120, "onSeek 带上了目标位置");
  eq(lastOf(env.started).off, 120, "★ source 从 120s 重新起播");

  /* ---------- 8. 音量 ---------- */
  section("8. audioplayer.setVolume");
  env.channel.call("audioplayer.setVolume", () => {}, ["AID1", "AID1", 0.3]);
  ok(Math.abs(env.ctx.__gain.gain.value - 0.3) < 1e-6, "★ GainNode 音量已改");
  const vol = env.last("Volume");
  eq(argAt(vol, 3), 0.3, "onVolume 已发出");

  /* ---------- 9. 非播放命令必须放行 ---------- */
  section("9. 非 audioplayer.* 命令要放行");
  env.channel.call("playlist.play", () => {}, []);
  env.channel.call("storage.init", () => {}, ["", "1", ""]);
  eq(env.nativeCalls.length, 2, "★ 两条非播放命令都落到了原版 channel.call");
  eq(at(env.nativeCalls, 0).name, "playlist.play", "放行的命令名正确");

  /* ---------- 9b. 日志瘦身（v0.2.8：默认只写用得上的） ---------- */
  section("9b. ★★ v0.2.8 日志默认不写噪音（真机里这三类占 46%）");
  env.channel.call("player.setInfo", () => {}, [{}, 1]); // UI 设置类调用
  env.flushTimers();
  const logs9 = env.logs();
  ok(logs9.indexOf("首次出现命令") < 0, "★★ 默认不写「首次出现命令」（真机里占 86 行）");
  ok(logs9.indexOf("▶ player.setInfo") < 0, "★★ 默认不写 player.* 的 UI 设置类调用");
  ok(logs9.indexOf("[intro]   ") < 0, "★★ 默认不写注册表逐条 dump（真机里占 31 行）");
  ok(logs9.indexOf("▶ audioplayer.load") >= 0, "★ 但音频命令照常逐次记录（这是排查要用的）");
  ok(logs9.indexOf("[intro] (") >= 0, "★ 注册表摘要那一行还留着");

  // 打开 verbose → 噪音照常写（用全新 env，免得 seenCmds 已经记过）
  const envV = createEnv();
  envV.win.__gpLogVerbose = true;
  envV.boot();
  envV.channel.call("playlist.play", () => {}, []);
  envV.channel.call("storage.init", () => {}, ["", "1", ""]);
  envV.flushTimers();
  const lgV = envV.logs();
  ok(lgV.indexOf("首次出现命令：playlist.play") >= 0, "★ 开了 verbose 后，首次出现的命令名被记下");
  ok(lgV.indexOf("首次出现命令：storage.init") >= 0, "★ 第二条新命令也被记下");
  const firstCount = (lgV.match(/首次出现命令：playlist\.play/g) || []).length;
  envV.channel.call("playlist.play", () => {}, []);
  envV.flushTimers();
  const secondCount = (envV.logs().match(/首次出现命令：playlist\.play/g) || []).length;
  eq(secondCount, firstCount, "重复命令不会重复刷「首次出现」");

  /* ---------- 10. 本地文件 ---------- */
  section("10. audioplayer.load（本地文件走 readFile）");
  env = createEnv();
  env.boot();
  env.channel.call("audioplayer.load", null, ["LID", { path: "E:\\music\\a.flac", format: "flac" }]);
  ok(env.fetchLog.length === 0, "本地文件没有走 fetch");
  await flush();
  eq(env.decoded.length, 1, "★ readFile 的字节被送去解码");
  eq(env.decoded[0], 2048 * 1024, "解码用的是 readFile 的字节");
  ok(!!env.last("Load"), "onLoad 已发出");

  /* ---------- 11. 网络失败要有兜底 ---------- */
  section("11. 下载失败要有兜底");
  env = createEnv();
  env.boot();
  env.channel.call("audioplayer.load", null, ["FID", { musicurl: "fail://boom" }]);
  await flush();
  const bad = env.last("Load");
  ok(!!bad, "★ 失败也发了 onLoad（否则网易云会一直转圈）");
  ok(argAt(bad, 1).errorCode !== 0, "★ onLoad 带上了错误码（" + argAt(bad, 1).errorCode + "）");
  eq(env.started.length, 0, "失败时不启动播放");

  /* ---------- 12. 切歌要丢掉上一首的残留 ---------- */
  section("12. 快速切歌：旧加载不能污染新歌");
  env = createEnv();
  env.boot();
  env.channel.call("audioplayer.load", null, ["S1", { musicurl: "http://x/1.flac" }]);
  env.channel.call("audioplayer.load", null, ["S2", { musicurl: "http://x/2.flac" }]);
  await flush();
  const loads = env.all("Load");
  eq(loads.length, 1, "★ 只有后一首有回音（前一首被 token 守卫丢弃，否则会用旧歌污染新歌）");
  eq(argAt(at(loads, 0), 0), "S2", "★ 最终就绪的是后一首 S2");
  eq(env.decoded.length, 1, "前一首的字节没有被送去解码");
  env.flushTimers(); // 触发兜底起播
  ok(env.started.length >= 1, "有 source 被启动");

  /* ---------- 13. 自然播完 ---------- */
  section("13. 自然播完要发 onEnd（含真实 playedTime）");
  env = createEnv();
  env.boot();
  env.channel.call("audioplayer.load", null, ["E1", { musicurl: "http://x/e.flac" }]);
  await flush();
  env.flushTimers(); // 触发兜底起播
  const srcNode = lastOf(env.started).node || { onended() {} };
  ok(typeof srcNode.onended === "function", "source 挂了 onended");

  env.advance(5000); // 假装听了 5 秒
  srcNode.onended();
  ok(!!env.last("End"), "★ onEnd 已发出");
  const played = Number(argAt(env.last("End"), 1).playedTime) || 0;
  ok(Math.abs(played - 5000) < 5, "★★ onEnd 的 playedTime 是真实播放毫秒数（约 5000，实际 " + Math.round(played) + "）");
  eq(argAt(env.last("PlayProgress"), 1), 0, "播完后进度归零");

  /* ---------- 13b. 暂停后 playedTime 要累计 ---------- */
  section("13b. 播放 → 暂停 → 续播，playedTime 要累计");
  env = createEnv();
  env.boot();
  env.channel.call("audioplayer.load", null, ["P1", { musicurl: "http://x/p.flac" }]);
  await flush();
  env.flushTimers(); // 触发兜底起播
  env.advance(3000); // 听 3 秒
  env.channel.call("audioplayer.pause", () => {}, ["", ""]);
  env.advance(10000); // 暂停 10 秒（这段时间不该算进去）
  env.channel.call("audioplayer.play", () => {}, ["P1", "P1"]);
  env.advance(2000); // 再听 2 秒
  const node2 = lastOf(env.started).node || { onended() {} };
  node2.onended();
  const played2 = Number(argAt(env.last("End"), 1).playedTime) || 0;
  ok(Math.abs(played2 - 5000) < 5, "★★ 只累计真正在播的时间（3+2=5 秒，实际 " + Math.round(played2) + "ms）");

  /* ---------- 14. FFT 接管 ---------- */
  section("14. FFT / isMRBNCM 接管");
  ok(env.betterncm.isMRBNCM === true, "★ betterncm.isMRBNCM = true");
  ok(env.win.betterncm_native && typeof env.win.betterncm_native.audio.getFFTData === "function", "★ betterncm_native.audio.getFFTData 已接管");

  /* ---------- 15. startup_script.js（真机主路径） ---------- */
  // 真机上 startup_script.js 在页面最早期执行，把 channel.registerCall /
  // appendRegisterCall 包一层，这样 UI 之后注册的处理器都能被记进
  // window.registeredCalls —— 这正是 v0.1.3 缺失、导致「暂停失灵」的那一环。
  section("15. ★★ startup_script.js（真机主路径：自建 registeredCalls）");
  {
    const sWin = {};
    const sNative = []; // channel.registerCall 的透传记录
    const sAppend = []; // appendRegisterCall 的透传记录
    const sIntervals = [];
    const sChannel = {
      registerCall(name, cb) {
        sNative.push({ name, cb });
      },
    };
    const sCmder = {
      appendRegisterCall(name, ns, handler) {
        sAppend.push({ name, ns, handler });
      },
    };
    const sSrc = fs.readFileSync(STARTUP, "utf8");
    const sFn = new Function(
      "window",
      "channel",
      "legacyNativeCmder",
      "setInterval",
      "clearInterval",
      "console",
      sSrc
    );
    sFn(
      sWin,
      sChannel,
      sCmder,
      (fn) => {
        sIntervals.push(fn);
        return sIntervals.length;
      },
      () => {},
      { log() {}, warn() {}, error() {} }
    );

    ok(sWin.registeredCalls && typeof sWin.registeredCalls === "object", "★★ 自建了 window.registeredCalls");
    ok(typeof sChannel.registerCall.__gpWrapped === "boolean", "★ channel.registerCall 被包了一层");
    ok(typeof sCmder.appendRegisterCall.__gpWrapped === "boolean", "★ appendRegisterCall 被包了一层");

    // ★ 兜底取注册表：变异体「不建 window.registeredCalls」时它会是 undefined，
    //   直接下标访问会把验证台搞崩（退出码 2），那样就不是「干净报红」了。
    const reg = sWin.registeredCalls || {};

    // UI 走主路径注册
    const h1 = () => {};
    sChannel.registerCall("audioplayer.onPlayState", h1);
    eq((reg["audioplayer.onPlayState"] || []).length, 1, "★★ UI 经 channel.registerCall 注册 → 被记进 registeredCalls");
    eq(sNative.length, 1, "★ 原桥照常收到（没截断）");

    // UI 走 appendRegisterCall 注册
    const h2 = () => {};
    sCmder.appendRegisterCall("Load", "audioplayer", h2);
    eq((reg["audioplayer.onLoad"] || []).length, 1, "★★ appendRegisterCall(Load,audioplayer) → 键名 audioplayer.onLoad");
    eq(sAppend.length, 1, "★ 原 appendRegisterCall 照常收到");

    // 重复注册同一个 handler 不应重复记（幂等）
    sChannel.registerCall("audioplayer.onPlayState", h1);
    eq((reg["audioplayer.onPlayState"] || []).length, 1, "★ 同一个处理器重复注册不会重复记");
  }

  /* ---------- 16~25. A1 / A1.5 预载 ---------- */
  const SONG_A = { id: "1000_1_3136952023", track_id: 1000, title: "A" };
  const SONG_B = { id: "2000_1_3136952023", track_id: 2000, title: "B" };
  const SONG_C = { id: "3000_1_3136952023", track_id: 3000, title: "C" };
  const LIST = [SONG_A, SONG_B, SONG_C];
  const isNext = (u) => /next\.flac/.test(u); // 预载走的 mock url
  const directCount = (e) => e.fetchLog.filter((u) => !isNext(u)).length; // 「即时下载」次数
  const askedFor = (e, id) => e.eapi.log.some((r) => String(JSON.stringify(r.data || {})).indexOf(String(id)) >= 0);
  /**
   * 安全读记忆文件。★ 必须容错：变异体把「写记忆」那段抠掉后文件根本不存在，
   * 直接 JSON.parse(undefined) 会把验证台整个搞崩（退出码 2），
   * 那样变异体是「崩了」而不是「干净报红」，报告就没法看了。
   */
  const memOf = (e) => {
    try {
      return JSON.parse(e.files[MEM_FILE] || "{}");
    } catch (err) {
      return {};
    }
  };

  section("16. ★ A1.5 规则①：当前曲目未就绪 → 预载它自己（开机第一首）");
  {
    const e1 = createEnv();
    e1.boot();
    e1.channel.call("player.addListElement", null, [JSON.stringify(LIST)]); // ★ 真机就是这个形态：JSON 字符串，不是数组
    e1.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    eq(e1.eapi.log.length, 1, "★ 向 LibEAPIRequest 发了 1 次请求");
    const req = e1.eapi.log[0] || {}; // 用 `|| {}` 兜住：变异体要「干净地报红」而不是让验证台自己崩
    ok(/player\/url/.test(req.url || ""), "★ 优先用 player/url 接口");
    ok(String(JSON.stringify(req.data)).indexOf("1000") >= 0, "★★ 查的是【当前曲目】自己（track=1000），不是下一首");
  }

  section("17. ★★ A1.5 规则①命中：开机第一首秒开（跳过下载 + 解码）");
  {
    const e2 = createEnv();
    e2.boot();
    e2.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e2.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    eq(e2.fetchLog.filter(isNext).length, 1, "★ 当前曲目已经被预下过");
    const before = directCount(e2);
    // 开始播第一首 → 命中预载（payload 给的 url 是「另一个」，命中就不该去下它）
    e2.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-bitrate-1999-XYZ",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    eq(directCount(e2), before, "★★ 命中预载：没有再去下载（即时下载次数没变）");
    ok(!e2.fetchLog.some((u) => /A-direct/.test(u)), "★★ 没下载 audioplayer.load 给的 url");
    ok(e2.all("Load").length >= 1, "★ onLoad 照常发出");
    ok(askedFor(e2, 2000), "★ 第一首就绪后，规则②顺手预载下一首（2000）");
  }

  section("18. ★★ A1.5 规则②命中：切到下一首也秒开");
  {
    const e2b = createEnv();
    e2b.boot();
    e2b.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e2b.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    // 播第一首（命中预载）→ 触发规则②预载 2000
    e2b.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    ok(askedFor(e2b, 2000), "（前提）2000 已被预载");
    const before = directCount(e2b);
    // 切到第二首：先 setCurrentPlay（真机顺序），再 load
    e2b.channel.call("player.setCurrentPlay", null, ["2000_1_3136952023"]);
    e2b.channel.call("audioplayer.load", null, [
      "2000_1_3136952023-x",
      { songId: 2000, musicurl: "http://cdn.example/B-direct.flac" },
    ]);
    await flush();
    eq(directCount(e2b), before, "★★ 第二首命中预载：没再去下载");
    ok(!e2b.fetchLog.some((u) => /B-direct/.test(u)), "★★ 没下载第二首的即时 url");
    ok(e2b.all("Load").length >= 2, "★ 两首都发出了 onLoad");
  }

  section("19. ★ A1.5 不命中：正常即时加载");
  {
    const e3 = createEnv();
    e3.boot();
    e3.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e3.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    // 直接跳到 C（既不是预载的 1000，也不是下一首 2000）
    e3.channel.call("audioplayer.load", null, [
      "3000_1_3136952023-x",
      { songId: 3000, musicurl: "http://cdn.example/C.flac" },
    ]);
    await flush();
    ok(e3.fetchLog.some((u) => /C\.flac/.test(u)), "★ 没命中 → 老老实实下载");
    ok(e3.all("Load").length >= 1, "★ onLoad 照常发出");
  }

  section("20. ★ A1.5 兜底：LibEAPIRequest 不在也不崩");
  {
    const e4 = createEnv();
    e4.loadedPlugins.LibEAPIRequest = null;
    e4.boot();
    e4.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e4.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    eq(e4.eapi.log.length, 0, "★ 没发请求（库不在）");
    e4.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A.flac" },
    ]);
    await flush();
    ok(e4.fetchLog.some((u) => /A\.flac/.test(u)), "★★ 预载不可用时，正常加载不受影响");
    ok(e4.all("Load").length >= 1, "★ onLoad 照常发出");
  }

  section("21. ★ A1.5 兜底：查地址失败也退回即时加载");
  {
    const e5 = createEnv();
    e5.eapi.mode = "fail";
    e5.boot();
    e5.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e5.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    e5.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A2.flac" },
    ]);
    await flush();
    ok(e5.fetchLog.some((u) => /A2\.flac/.test(u)), "★ 预载失败 → 下载了 payload 的 url");
    ok(e5.all("Load").length >= 1, "★ onLoad 照常发出");
  }

  section("22. ★ A1.5 边界：列表末尾不预载下一首");
  {
    const e6 = createEnv();
    e6.boot();
    e6.channel.call("player.addListElement", null, [JSON.stringify([SONG_A])]);
    e6.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    eq(e6.eapi.log.length, 1, "★ 只预载了当前曲目自己（1 次请求）");
    e6.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A.flac" },
    ]);
    await flush();
    eq(e6.eapi.log.length, 1, "★ 没有下一首 → 不再多预载（还是 1 次请求）");
  }

  section("23. ★★ A1.5 回归：列表是 JSON 字符串时也要认出来（v0.2.0 踩过的坑）");
  {
    // 规则①不依赖列表；真正吃列表的是规则②（算下一首）。所以这条必须走到规则②。
    const e7 = createEnv();
    e7.boot();
    const raw = JSON.stringify(LIST);
    e7.channel.call("player.addListElement", null, [raw]);
    e7.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    ok(typeof raw === "string" && raw.length > 100, "（前提）payload 确实是长字符串");
    e7.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    ok(askedFor(e7, 2000), "★★ 字符串形态的列表也能解析 → 算出下一首并预载（track=2000）");

    // 兼容：万一是数组形态也不能坏
    const e8 = createEnv();
    e8.boot();
    e8.channel.call("player.addListElement", null, [LIST]);
    e8.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    e8.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    ok(askedFor(e8, 2000), "★ 数组形态也照常能用（防御）");
  }

  const MEM_FILE = "C:\\betterncm\\gapless-player.lasttrack.json";

  section("24. ★★ A1.5 开机预载：记忆存【文件】，开机就下起来");
  {
    // (1) 写入：播一首 → 记忆落到文件里（不依赖 localStorage 落盘）
    const e9 = createEnv();
    e9.boot();
    e9.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e9.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    ok(String(e9.files[MEM_FILE] || "").indexOf("1000") >= 0, "★★ 一选中（setCurrentPlay）就写记忆文件（不必等 load）");
    e9.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A.flac" },
    ]);
    await flush();
    const memRaw = e9.files[MEM_FILE];
    ok(!!memRaw, "★★ 记忆写进了【文件】（真机上强杀进程也不丢）");
    ok(String(memRaw || "").indexOf("1000") >= 0, "★★ 文件里记的是刚播的这首（track=1000）");
    ok(String(memRaw || "").indexOf('"t"') >= 0, "★ 文件里带时间戳");

    // (2) 读取：新一次启动，文件里有记忆 → 开机即预载
    const e9b = createEnv();
    e9b.files[MEM_FILE] = JSON.stringify({ id: 2000, t: Date.now() });
    e9b.boot();
    await flush();
    eq(e9b.eapi.log.length, 1, "★★ 开机没等 setCurrentPlay 就去查地址了");
    ok(askedFor(e9b, 2000), "★★ 查的是记忆文件里的那首（track=2000）");

    // (3) 文件没有 → 退回 localStorage 备份
    const e9c = createEnv();
    e9c.localStorage.setItem("gaplessPlayer.lastTrack", JSON.stringify({ id: 3000, t: Date.now() }));
    e9c.boot();
    await flush();
    ok(askedFor(e9c, 3000), "★ 文件读不到时，退回 localStorage 备份（track=3000）");

    // (4) 记忆过期（>24h）→ 不猜
    const e9d = createEnv();
    e9d.files[MEM_FILE] = JSON.stringify({ id: 2000, t: Date.now() - 25 * 3600 * 1000 });
    e9d.boot();
    await flush();
    eq(e9d.eapi.log.length, 0, "★ 记忆超过 24h → 不猜（等 setCurrentPlay）");
  }

  section("25. ★★ v0.2.6 开机保护窗口：网易云的「恢复」不抢记忆、也不抢预载槽");
  {
    // ★ 这条推翻了 v0.2.2 的一个前提（「一旦 setCurrentPlay 给出真曲目，预载槽会被换掉」）。
    //   真机踩过（16:29 那次，全程 0 个 audioplayer.load）：
    //     文件里是 (2758269319, 121.2s)，开机 2 秒后网易云发 setCurrentPlay(1981999919)，
    //     我们照记 → 正确记忆被冲成 (1981999919, 0)；正确那首的预载还被掐断、白下 97MB。
    //   根因：开机时的 setCurrentPlay 是【网易云自己恢复的歌】，不等于用户上次听的那首。
    const MEM_SONG = { id: "9999_1_3136952023", track_id: 9999, title: "MEM" };
    const LIST_WITH_MEM = [MEM_SONG, SONG_A, SONG_B];

    const e10 = createEnv();
    e10.files[MEM_FILE] = JSON.stringify({ id: 9999, pos: 42.5, t: Date.now() });
    e10.boot();
    await flush();
    ok(askedFor(e10, 9999), "（前提）开机先按记忆预载了 9999");

    // ★ 按真机顺序来：addListElement → setCurrentPlay → addListElement（网易云会发两次列表）
    e10.channel.call("player.addListElement", null, [JSON.stringify(LIST_WITH_MEM)]);
    e10.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]); // 网易云自己恢复的是 1000
    await flush();
    // ★★ 第二次 addListElement 才是「抢预载槽」的真凶：它分支里也会调 maybePreload()，
    //    那时 S.curTrackId 若已被恢复那首污染，就会去预载它、把记忆那首掐断（真机踩过 97MB）。
    e10.channel.call("player.addListElement", null, [JSON.stringify(LIST_WITH_MEM)]);
    await flush();
    e10.flushTimers();
    const lg = e10.logs();
    ok(lg.indexOf("开机保护窗口已开") >= 0, "★ 读到记忆后开了保护窗口");
    ok(lg.indexOf("开机恢复（网易云自己挑的") >= 0, "★★ 认出这是开机恢复（不是用户选歌）");
    eq(e10.eapi.log.length, 1, "★★ 没有为「网易云恢复的那首」再查一次地址（预载槽没被抢）");
    eq(e10.abortedFetches.length, 0, "★★ 记忆那首的预载【没】被掐断");
    eq(memOf(e10).id, 9999, "★★ 记忆文件没被覆盖（还是 9999）");
    eq(memOf(e10).pos, 42.5, "★★ 记忆里的位置也还在");

    // ★ v0.2.7：网易云恢复是**一整串**（setCurrentPlay → load → seek），
    //   所以窗口内 load / seek **都不该**关窗、也不该写记忆。
    e10.channel.call("audioplayer.load", null, [
      "9999_1_3136952023-x",
      { songId: 9999, musicurl: "http://cdn.example/MEM.flac" },
    ]);
    await flush();
    e10.channel.call("audioplayer.seek", () => {}, ["9999_1_3136952023-x", "t|seek|z", 77.7]);
    await flush();
    e10.flushTimers();
    ok(e10.logs().indexOf("窗口内收到 load") >= 0, "★★ 窗口内的 load 不写记忆（它也是恢复流程的一部分）");
    eq(memOf(e10).id, 9999, "★★ 记忆仍没被覆盖（还是 9999）");
    // ★ v0.2.9：文件是**整份没动过** —— 连老文件里带的 pos 都原样还在
    eq(memOf(e10).pos, 42.5, "★★ 记忆文件完全没被动过（连老 pos 都还在）");

    // 关窗条件①：用户主动切到【别的】歌
    e10.channel.call("player.setCurrentPlay", null, ["2000_1_3136952023"]);
    await flush();
    e10.flushTimers();
    ok(e10.logs().indexOf("用户切到别的歌") >= 0, "★★ 用户切到别的歌 → 关窗");
    eq(memOf(e10).id, 2000, "★★ 关窗后，切歌照常记记忆");
  }

  section("26. ★★ 回归：handle() 绝不能抛错（v0.2.3 真凶：函数改名漏改调用点）");
  {
    // 这个坑很阴：handle() 外面套了 try/catch，抛错只会留一行日志，
    // 而 S.playlist 在抛错【之前】已经赋值 → 预载看起来还是好的 → 验证台全绿。
    // 所以必须单独盯「日志里有没有抛错」。
    const e11 = createEnv();
    e11.boot();
    e11.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e11.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    e11.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    e11.channel.call("audioplayer.pause", null, ["", ""]);
    await flush();
    e11.flushTimers();
    const lg = e11.logs();
    ok(lg.indexOf("抛错") < 0, "★★ 日志里没有 [guard] handle(...) 抛错");
    ok(lg.indexOf("ReferenceError") < 0, "★★ 日志里没有 ReferenceError（调用点与函数名一致）");
  }

  section("27. ★ 启动横幅版本号 == manifest.json（防止「装的是新版、横幅写旧版」）");
  {
    const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "manifest.json"), "utf8"));
    const e12 = createEnv();
    e12.boot();
    e12.flushTimers();
    ok(
      e12.logs().indexOf("GaplessPlayer v" + mf.version) >= 0,
      "★ 横幅版本与 manifest 一致（" + mf.version + "）"
    );
  }

  section("28. ★★ A1.5 切歌单：开机记忆不在新歌单里 → 预载作废（不白下）");
  {
    // 真机踩过：开机记忆是「上一份歌单」的歌，用户切歌单后它还在下，白下 22MB。
    const e13 = createEnv();
    e13.files[MEM_FILE] = JSON.stringify({ id: 2000, t: Date.now() }); // 记忆 = 2000（旧歌单的歌）
    e13.boot();
    await flush();
    ok(askedFor(e13, 2000), "（前提）开机先按记忆预载了 2000");
    // 切到一个【不含 2000】的新歌单
    const NEWLIST = [
      { id: "5000_10_", track_id: 5000, title: "X" },
      { id: "6000_10_", track_id: 6000, title: "Y" },
    ];
    e13.channel.call("player.addListElement", null, [JSON.stringify(NEWLIST)]);
    await flush();
    e13.flushTimers();
    ok(e13.logs().indexOf("不在新歌单里 → 作废") >= 0, "★★ 预载作废（日志里能看到）");
    ok(e13.logs().indexOf("预载中的 2000 在本列表=否") >= 0, "★ 列表日志标了「不在本列表」");
    const n = e13.fetchLog.length;
    await flush();
    eq(e13.fetchLog.length, n, "★ 作废后不再有新的下载");

    // 对照：记忆里的歌【在】歌单里 → 保留
    const e13b = createEnv();
    e13b.files[MEM_FILE] = JSON.stringify({ id: 2000, t: Date.now() });
    e13b.boot();
    await flush();
    e13b.channel.call("player.addListElement", null, [JSON.stringify(LIST)]); // LIST 含 2000
    e13b.flushTimers();
    ok(e13b.logs().indexOf("预载中的 2000 在本列表=是") >= 0, "★ 记忆里的歌在歌单里 → 保留（不作废）");
    ok(e13b.logs().indexOf("作废") < 0, "★ 没有误作废");
  }

  section("29. ★ 记忆日志：能看出是「选中」还是「加载」写的 + 心跳带记忆");
  {
    const e14 = createEnv();
    e14.boot();
    e14.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e14.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    e14.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A.flac" },
    ]);
    await flush();
    e14.tick(); // 触发心跳
    e14.flushTimers();
    const lg = e14.logs();
    ok(lg.indexOf("来源=选中") >= 0, "★ 选中时记了一笔（来源=选中）");
    ok(lg.indexOf("来源=加载") >= 0, "★ 加载时记了一笔（来源=加载）");
    ok(lg.indexOf("记忆=") >= 0, "★ 心跳里带上了「记忆=」（方便看它有没有在更新）");
  }

  /* ---------- 30~39. 记忆 payload / 掐断下载 / 保护窗口 ---------- */

  section("30. ★★ v0.2.9 记忆 payload 回到 { id, t }（只记歌，不记进度）");
  {
    const e22 = createEnv();
    e22.boot();
    e22.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e22.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
    await flush();
    const mem = memOf(e22);
    eq(typeof mem.id, "number", "★ payload 有 id");
    eq(typeof mem.t, "number", "★ payload 有 t");
    eq(mem.pos, undefined, "★★ payload 里**没有** pos（v0.2.9 起不再记位置）");

    // 老记忆文件里还带着 pos → 要能读，而且那个字段被**忽略**（不续播）
    const e23 = createEnv();
    e23.files[MEM_FILE] = JSON.stringify({ id: 2000, pos: 123.4, t: Date.now() });
    e23.boot();
    await flush();
    ok(askedFor(e23, 2000), "★ 带 pos 的老记忆照样能读出来（track=2000）");
    e23.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e23.channel.call("player.setCurrentPlay", null, ["2000_1_3136952023"]);
    await flush();
    e23.channel.call("audioplayer.load", null, [
      "2000_1_3136952023-x",
      { songId: 2000, musicurl: "http://cdn.example/B.flac" },
    ]);
    await flush();
    e23.channel.call("audioplayer.play", () => {}, ["2000_1_3136952023-x", "t|resume|T"]);
    await flush();
    e23.flushTimers();
    ok(/offset=0\.000/.test(e23.logs()), "★★ 老记忆里的 pos 被忽略 → 仍从 0 起播（不续播）");
    ok(e23.logs().indexOf("开机续播") < 0, "★★ 日志里也不再有「开机续播」");
  }

  section("37. ★★ v0.2.5 作废 = 真的掐断在飞下载（AbortController）");
  {
    // 真机踩过：43.814 作废，45.253 那 26.76MB 还是下完了（token 只丢结果，连接照跑）。
    const e23 = createEnv();
    e23.eapi.url = "http://cdn.example/hang.flac"; // 这个请求永不自己返回
    e23.files[MEM_FILE] = JSON.stringify({ id: 2000, t: Date.now() });
    e23.boot();
    await flush();
    ok(e23.fetchLog.some((u) => /hang/.test(u)), "（前提）开机预载 2000 已经在下载了");
    eq(e23.abortedFetches.length, 0, "（前提）此刻还没被掐断");
    // 切到一个【不含 2000】的新歌单 → 作废
    e23.channel.call("player.addListElement", null, [JSON.stringify([{ id: "5000_10_", track_id: 5000, title: "X" }])]);
    await flush();
    e23.flushTimers();
    ok(e23.logs().indexOf("不在新歌单里 → 作废") >= 0, "★ 预载作废了");
    eq(e23.abortedFetches.length, 1, "★★ 在飞的下载被真的掐断了（abort 命中 1 次）");
    ok(e23.logs().indexOf("已掐断") >= 0, "★ 日志能看到「已掐断」");
    ok(e23.logs().indexOf("抛错") < 0, "★ 主动掐断没有被当成错误");

    // 换预载目标（不是作废）也要掐断上一个。
    // ⚠️ v0.2.6 起必须先「真加载」过一次 —— 开机保护窗口里 setCurrentPlay 是不换预载槽的。
    const e24 = createEnv();
    e24.eapi.url = "http://cdn.example/hang.flac"; // 预载用的地址永不自己返回
    e24.boot();
    await flush();
    e24.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e24.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    ok(e24.fetchLog.some((u) => /hang/.test(u)), "（前提）下一首的预载正在下载（且永不返回）");
    const n0 = e24.abortedFetches.length;
    e24.channel.call("player.setCurrentPlay", null, ["3000_1_3136952023"]); // 用户切歌 → 换预载目标
    await flush();
    eq(e24.abortedFetches.length, n0 + 1, "★★ 换预载目标时，上一个在飞下载也被掐断");
  }

  section("38. ★★ v0.2.7 窗口内真的听了 ≥10s → 关窗并记账（否则一直吞）");
  {
    const e25 = createEnv();
    e25.files[MEM_FILE] = JSON.stringify({ id: 9999, pos: 42.5, t: Date.now() });
    e25.boot();
    await flush();
    e25.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e25.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]); // 网易云恢复那首
    await flush();
    e25.channel.call("audioplayer.load", null, [
      "1000_1_3136952023-x",
      { songId: 1000, musicurl: "http://cdn.example/A-direct.flac" },
    ]);
    await flush();
    e25.channel.call("audioplayer.play", () => {}, ["1000_1_3136952023-x", "t|resume|T"]);
    await flush();
    e25.flushTimers();
    eq(memOf(e25).id, 9999, "（前提）刚开始播，窗口还开着，记忆没动");

    // 窗口内暂停也不写记忆（v0.2.9 起暂停本来就不写）
    e25.channel.call("audioplayer.pause", () => {}, ["1000_1_3136952023-x", "t|pause|x"]);
    await flush();
    e25.flushTimers();
    eq(memOf(e25).id, 9999, "★★ 窗口内暂停 → 记忆没动（还是 9999）");
    e25.channel.call("audioplayer.play", () => {}, ["1000_1_3136952023-x", "t|resume|T"]);
    await flush();

    e25.perf._t += 11000; // 假装连续播了 11 秒
    e25.tick();
    await flush();
    e25.flushTimers();
    ok(e25.logs().indexOf("连续播放 ≥10s") >= 0, "★★ 连续播放 ≥10s → 判定用户真在听 → 关窗");
    eq(memOf(e25).id, 1000, "★★ 关窗并记账（track=1000）");
  }

  section("39. ★★ v0.2.9 真机正解：重启后点【自己那首】→ 关窗 + 命中预载（秒开）");
  {
    // 用户真正要的流程：网易云恢复它那首，用户点自己的歌 → 记忆立刻归自己，而且秒开。
    const e26 = createEnv();
    e26.files[MEM_FILE] = JSON.stringify({ id: 2000, t: Date.now() });
    e26.boot();
    await flush();
    e26.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
    e26.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]); // 网易云恢复它自己的那首
    await flush();
    eq(memOf(e26).id, 2000, "（前提）窗口内记忆没被网易云的恢复冲掉");

    e26.channel.call("player.setCurrentPlay", null, ["2000_1_3136952023"]); // 用户点自己那首 → 关窗
    await flush();
    e26.flushTimers();
    ok(e26.logs().indexOf("用户切到别的歌") >= 0, "★★ 用户切到别的歌 → 开机保护窗口关闭");
    eq(memOf(e26).id, 2000, "★★ 记忆还是自己那首");

    // 点自己那首 → 开机预载（就是记忆那首）应该命中
    const before = directCount(e26);
    e26.channel.call("audioplayer.load", null, [
      "2000_1_3136952023-x",
      { songId: 2000, musicurl: "http://cdn.example/B-direct.flac" },
    ]);
    await flush();
    e26.flushTimers();
    ok(e26.logs().indexOf("★★ 命中！跳过下载 + 解码") >= 0, "★★ 命中开机预载 → 秒开");
    eq(directCount(e26), before, "★★ 没再去下载（即时下载次数没变）");
  }

  /* ---------- 40~43. v0.2.10 随机播放下自适应停止「预载下一首」 ---------- */

  /**
   * 真机证据（v0.2.9，45 分钟日志 22:27~23:12）：
   *   预载（下一首）16 次 ｜ `命中！跳过下载` **0 次** ｜ 白下 **1076 MB**（76.9 MB/首）
   *   切歌实际等待 **平均 3482 ms**（一点没省到）
   *   只看「自然播完 → 自动续播」的 13 次，**13 次全部没中**（预载 A、实际播到 B）
   * → 连续 3 次押不中就停掉它，只留「预载当前曲目」（那条是知道要播才下的，有用）。
   */
  const S6 = [1000, 2000, 3000, 4000, 5000, 6000].map((n) => ({
    id: n + "_1_3136952023",
    track_id: n,
    title: "T" + n,
  }));
  const LIST6 = S6;
  const idOf = (n) => n + "_1_3136952023";
  /** 让某首走完「选中 → 加载 → 就绪」（就绪后 maybePreload 才会跑，才看得到预载行为） */
  async function playTrack(e, n) {
    e.channel.call("player.setCurrentPlay", null, [idOf(n)]);
    await flush();
    e.channel.call("audioplayer.load", null, [
      idOf(n) + "-x",
      { songId: n, musicurl: "http://cdn.example/d" + n + ".flac" },
    ]);
    await flush();
    e.flushTimers();
  }
  /** ★ 用计数差，别用 indexOf —— 日志每次 flush 是**整份缓冲区重写**，indexOf 会被前面场景污染 */
  const countLog = (e, s) => e.logs().split(s).length - 1;

  section("40. ★★ v0.2.10 随机播放：连续 3 次押不中 → 停止「预载下一首」");
  {
    const e40 = createEnv();
    e40.boot();
    await flush();
    e40.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(e40, 1000); // 索引 0 → 就绪后按「顺序」假设预载下一首 = 2000
    eq(countLog(e40, "开始预载（下一首）"), 1, "（前提）按顺序假设预载了「下一首」");
    ok(countLog(e40, "开始预载（下一首）｜ track=2000") >= 1, "（前提）预载的确实是列表里的 2000");

    // 客户端「随机」挑了 3000（不是列表里的下一首 2000）→ 押不中
    await playTrack(e40, 3000);
    ok(countLog(e40, "✗ 预测失败 1/3") >= 1, "★ 第 1 次押不中被记下（预载 2000，实际播 3000）");
    eq(countLog(e40, "开始预载（下一首）"), 2, "★ 还没到阈值 → 仍然预载下一首");

    await playTrack(e40, 5000);
    ok(countLog(e40, "✗ 预测失败 2/3") >= 1, "★ 第 2 次押不中被记下");
    eq(countLog(e40, "开始预载（下一首）"), 3, "（前提）关闭前一共预载了 3 次「下一首」");

    await playTrack(e40, 1000); // 第 3 次押不中 → 关
    ok(countLog(e40, "✗ 预测失败 3/3") >= 1, "★★ 第 3 次押不中");
    ok(countLog(e40, "停止预载下一首") >= 1, "★★ 判定「播放顺序 ≠ 列表顺序」（随机播放）→ 停止预载下一首");

    // ★ v0.4.0 行为变更：判定「顺序不可预测」之后**什么都不预载** ——
    //   这两首会走流式（浏览器边下边播），预载纯属白下，连「当前曲目」也不例外。
    const cur0 = countLog(e40, "开始预载（当前曲目）");
    await playTrack(e40, 2000);
    await playTrack(e40, 4000);
    eq(countLog(e40, "开始预载（下一首）"), 3, "★★ 关掉之后一次「下一首」预载都没有（不再白下）");
    eq(countLog(e40, "开始预载（当前曲目）"), cur0, "★★ 连「当前曲目」也不预载了（流式兜底，预载是白下）");
  }

  section("41. ★ v0.2.10 只有「下一首」算预测：「预载当前曲目」的槽不参与押中率统计");
  {
    const e41 = createEnv();
    e41.boot();
    await flush();
    e41.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(e41, 1000); // 就绪后预载「下一首」= 2000
    e41.channel.call("player.setCurrentPlay", null, [idOf(3000)]); // 押不中 1；槽换成「当前曲目」3000
    await flush();
    e41.flushTimers();
    eq(countLog(e41, "✗ 预测失败"), 1, "（前提）第 1 次押不中");

    // ★ 3000 还没 load/就绪，槽里是「当前曲目」3000 → 再切一首不该算「预测失败」
    e41.channel.call("player.setCurrentPlay", null, [idOf(5000)]);
    await flush();
    e41.flushTimers();
    eq(countLog(e41, "✗ 预测失败"), 1, "★★ 槽里是「当前曲目」→ 不算预测，失败次数没涨");
    ok(countLog(e41, "✗ 预测失败 2/3") === 0, "★ 没有误记成第 2 次");
    ok(countLog(e41, "开始预载（当前曲目）") >= 3, "★ 「当前曲目」预载照常（1000 / 3000 / 5000 各一次）");
  }

  section("42. ★★ v0.2.10 免费恢复：连续 2 首在列表里索引相邻 → 重新开启「预载下一首」");
  {
    const e42 = createEnv();
    e42.boot();
    await flush();
    e42.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    // 先逼到「关闭」状态（一路随机挑，全押不中）
    await playTrack(e42, 1000); // 预载 2000
    await playTrack(e42, 3000); // 押不中 1 → 预载 4000
    await playTrack(e42, 5000); // 押不中 2 → 预载 6000
    await playTrack(e42, 1000); // 押不中 3 → 关闭
    ok(countLog(e42, "停止预载下一首") >= 1, "（前提）已经关掉了");
    eq(countLog(e42, "开始预载（下一首）"), 3, "（前提）关闭前预载了 3 次下一首");

    // 现在用户切回「顺序播放」：1000(索引0) → 2000(索引1) → 3000(索引2)
    await playTrack(e42, 2000);
    eq(countLog(e42, "开始预载（下一首）"), 3, "★ 第 1 首相邻还不够（seqStreak=1），仍然关着");
    eq(countLog(e42, "重新开启「预载下一首」"), 0, "★ 还没到阈值 2");

    await playTrack(e42, 3000);
    ok(countLog(e42, "重新开启「预载下一首」") >= 1, "★★ 连续 2 首索引相邻 → 判定顺序播放 → 重新开启");
    ok(countLog(e42, "开始预载（下一首）") > 3, "★★ 恢复之后又开始预载「下一首」了（4000）");
  }

  section("43. ★ v0.2.10 修日志 bug：[list] 的「索引 / 下一首」是【当前曲目】的（原来是上一首的）");
  {
    const BAR = "\uFF5C"; // ｜
    const e43 = createEnv();
    e43.boot();
    await flush();
    e43.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(e43, 1000); // 1000 在索引 0
    e43.channel.call("player.setCurrentPlay", null, [idOf(4000)]); // 换到索引 3 的 4000
    await flush();
    e43.flushTimers();
    const lg = e43.logs();
    const want = "当前曲目 track=4000 " + BAR + " 索引=3 " + BAR + " 下一首=5000";
    const bad = "当前曲目 track=4000 " + BAR + " 索引=0 " + BAR + " 下一首=2000";
    ok(lg.indexOf(want) >= 0, "★★ [list] 的索引/下一首是 4000 自己的（3 / 5000）");
    ok(lg.indexOf(bad) < 0, "★★ 不再出现「新曲目 + 上一首的索引/下一首」这种误导组合（0 / 2000）");
  }

  /* ---------- 51~60. v0.4.0 流式播放（<audio>） ---------- */

  /**
   * 验证台默认 `__gpStream = false`（让 16~43 那批老场景继续覆盖缓冲路径），
   * 这里显式把它**删掉** —— 等价于出厂默认（不设开关 → 走流式）。
   */
  function streamEnv() {
    const e = createEnv();
    delete e.win.__gpStream;
    return e;
  }
  /** 发一次流式 load（不带预载 → 必然走流式） */
  function streamLoad(e, idStr, url) {
    e.channel.call("audioplayer.load", null, [
      idStr,
      { musicurl: url, songId: Number(String(idStr).split("_")[0]) },
    ]);
  }

  section("51. ★★ v0.4.0 没有预载 → 走流式：设 el.src + el.load()，不再下载 + 解码");
  {
    const e51 = streamEnv();
    e51.boot();
    await flush();
    streamLoad(e51, "1000_1_3136952023", "http://cdn.example/stream-a.flac");
    const el = e51.audio.last;
    ok(!!el, "★★ 建了 <audio> 元素");
    eq(el.src, "http://cdn.example/stream-a.flac", "★★ 把 musicurl 挂到了 el.src");
    eq(el.__loads, 1, "★★ 调了 el.load()");
    eq(e51.fetchLog.length, 0, "★★ 一条 fetch 都没有（不再整首下载）");
    eq(e51.decoded.length, 0, "★★ decodeAudioData 也没被调（不再整首解码）");
    await flush();
    e51.flushTimers();
    ok(countLog(e51, "流式播放 ｜ src=") >= 1, "★ 日志写明了走流式");
  }

  section("52. ★★ v0.4.0 onLoad 必须等 loadedmetadata（否则 UI 拿不到 duration）");
  {
    const e52 = streamEnv();
    e52.boot();
    await flush();
    streamLoad(e52, "1000_1_3136952023", "http://cdn.example/stream-b.flac");
    await flush();
    eq(e52.all("Load").length, 0, "★★ metadata 还没到 → 一条 onLoad 都不发");

    e52.audio.last.duration = 201.5;
    e52.audio.emit("loadedmetadata");
    await flush();
    eq(e52.all("Load").length, 1, "★★ metadata 到了才发 onLoad");
    const ld = e52.last("Load");
    eq(argAt(ld, 1).duration, 201.5, "★★ onLoad 带上了真实时长");
    eq(argAt(ld, 1).errorCode, 0, "★ 无错误码");
    ok(e52.all("PlayProgress").length >= 1, "★ 顺手发了首帧进度");

    // 重复 metadata 不该重复发 onLoad
    e52.audio.emit("loadedmetadata");
    eq(e52.all("Load").length, 1, "★ 重复的 metadata 被忽略（不重复发 onLoad）");
  }

  section("53. ★★ v0.4.0 metadata 超时兜底：8s 没来也要发 onLoad，免得 UI 一直转圈");
  {
    const e53 = streamEnv();
    e53.boot();
    await flush();
    streamLoad(e53, "1000_1_3136952023", "http://cdn.example/stream-c.flac");
    await flush();
    eq(e53.all("Load").length, 0, "（前提）metadata 没来就没 onLoad");
    e53.flushTimers(); // 触发 8s 超时
    e53.flushTimers(); // ★ 再冲一次：超时回调是在「日志 flush」之后才写行的
    eq(e53.all("Load").length, 1, "★★ 超时兜底发了 onLoad");
    eq(argAt(e53.last("Load"), 1).duration, 0, "★ 兜底的 duration 是 0");
    ok(countLog(e53, "metadata 超时") >= 1, "★ 日志说明了是超时兜底");
  }

  section("54. ★★ v0.4.0 play() 被拒（autoplay policy）→ 排队等手势，不抛未处理拒绝");
  {
    const e54 = streamEnv();
    e54.boot();
    await flush();
    streamLoad(e54, "1000_1_3136952023", "http://cdn.example/stream-d.flac");
    e54.audio.last.duration = 200;
    e54.audio.emit("loadedmetadata");
    await flush();

    e54.audio.playReject = "NotAllowedError";
    e54.channel.call("audioplayer.play", () => {}, ["1000_1_3136952023", "tok"]);
    await flush();
    e54.flushTimers();
    ok(countLog(e54, "el.play() 被拒") >= 1, "★★ 记下了被拒（而不是静默失败）");
    eq(e54.audio.last.paused, true, "★★ 被拒后不算「在播」");
    ok(e54.winListeners.pointerdown && e54.winListeners.pointerdown.length >= 1, "★★ 挂了一次性手势监听");

    // 用户点一下 → 重试起播
    e54.audio.playReject = null;
    e54.fireGesture();
    await flush();
    e54.flushTimers();
    ok(countLog(e54, "收到用户手势 → 重试起播") >= 1, "★★ 手势到了就重试");
    eq(e54.audio.last.paused, false, "★★ 这次真的播上了");
    eq(e54.winListeners.pointerdown.length, 0, "★ 监听用完即摘（不残留）");
  }

  section("55. ★★ v0.4.0 切歌先摘旧事件：新歌不会收到旧歌的事件");
  {
    const e55 = streamEnv();
    e55.boot();
    await flush();
    streamLoad(e55, "1000_1_3136952023", "http://cdn.example/s1.flac");
    eq(e55.audio.count("loadedmetadata"), 1, "（前提）第一首挂了 1 个 metadata 监听");
    streamLoad(e55, "2000_1_3136952023", "http://cdn.example/s2.flac");
    eq(e55.audio.count("loadedmetadata"), 1, "★★ 换歌后还是只有 1 个（旧的被摘掉了，不会串扰）");
    eq(e55.audio.count("ended"), 1, "★★ ended 同理");
    eq(e55.audio.count("error"), 1, "★★ error 同理");
    eq(e55.audio.last.src, "http://cdn.example/s2.flac", "★ src 换成了新歌");
  }

  section("56. ★★ v0.4.0 loadProgress 固定发 1（发 0 会让 UI 转圈 + 暂停失灵）");
  {
    const e56 = streamEnv();
    e56.boot();
    await flush();
    streamLoad(e56, "1000_1_3136952023", "http://cdn.example/stream-e.flac");
    e56.audio.last.duration = 200;
    e56.audio.emit("loadedmetadata");
    await flush();
    eq(argAt(e56.last("PlayProgress"), 2), 1, "★★ 首帧进度的第 3 参是 1");
    e56.audio.last.currentTime = 5;
    e56.tick();
    await flush();
    eq(argAt(e56.last("PlayProgress"), 2), 1, "★★ 心跳里的进度第 3 参也是 1");
    ok(argAt(e56.last("PlayProgress"), 1) > 0, "★ 位置跟随 el.currentTime");
  }

  section("57. ★★ v0.4.0 本地文件走 betterncm.fs.mountFile 拿可播 URL");
  {
    const e57 = streamEnv();
    e57.boot();
    await flush();
    e57.channel.call("audioplayer.load", null, ["L1", { path: "C:\\x\\y.flac" }]);
    await flush();
    eq(e57.audio.last.src, "blob:mock/C:\\x\\y.flac", "★★ 本地文件挂的是 mountFile 给的 blob URL");
    eq(e57.fetchLog.length, 0, "★ 没有走 fetch");
  }

  section("58. ★★ v0.4.0 createMediaElementSource 只调一次（同一元素只能调一次）");
  {
    const e58 = streamEnv();
    e58.boot();
    await flush();
    streamLoad(e58, "1000_1_3136952023", "http://cdn.example/a1.flac");
    streamLoad(e58, "2000_1_3136952023", "http://cdn.example/a2.flac");
    streamLoad(e58, "3000_1_3136952023", "http://cdn.example/a3.flac");
    await flush();
    eq(e58.meSrcCalls.length, 1, "★★ 三次换歌，createMediaElementSource 只调了 1 次");
    eq(e58.audio.instances.length, 1, "★★ <audio> 也只建了 1 个（复用它换 src）");
  }

  section("59. ★★ v0.4.0 静音自检：元素在走但 FFT 全 0 → 告警并退回缓冲");
  {
    const e59 = streamEnv();
    e59.boot();
    await flush();
    streamLoad(e59, "1000_1_3136952023", "http://cdn.example/silent.flac");
    e59.audio.last.duration = 200;
    e59.audio.emit("loadedmetadata");
    await flush();
    e59.channel.call("audioplayer.play", () => {}, ["1000_1_3136952023", "tok"]);
    await flush();

    e59.audio.last.currentTime = 1;
    e59.tick(); // 第一次只是记下基准
    e59.ctx.__analyserZeros = true; // 造「被静音」：FFT 全 0
    e59.audio.last.currentTime = 2;
    e59.tick();
    e59.audio.last.currentTime = 3;
    e59.tick();
    e59.flushTimers();
    ok(countLog(e59, "疑似被跨域静音") >= 1, "★★ 连续 2s FFT 全 0 + 元素在走 → 判定被静音");

    // 后续曲目自动退回缓冲路径
    const f0 = e59.fetchLog.length;
    streamLoad(e59, "4000_1_3136952023", "http://cdn.example/after-silent.flac");
    await flush();
    ok(e59.fetchLog.length > f0, "★★ 判定静音后，下一首自动改走缓冲（下载了）");
  }

  section("60. ★★ v0.4.0 出厂默认：不设 __gpStream 开关时走流式");
  {
    // 验证台默认把它设成 false（为了老场景覆盖缓冲路径），这里删掉 = 出厂默认
    const e60 = streamEnv();
    eq(e60.win.__gpStream, undefined, "（前提）开关已删除");
    e60.boot();
    await flush();
    streamLoad(e60, "1000_1_3136952023", "http://cdn.example/default.flac");
    eq(e60.audio.last.src, "http://cdn.example/default.flac", "★★ 不设开关 → 走流式");
    eq(e60.fetchLog.length, 0, "★★ 没有走缓冲（没下载）");

    // 反过来：显式关掉开关 → 强制缓冲
    const e60b = createEnv(); // 验证台默认 __gpStream = false
    e60b.boot();
    await flush();
    streamLoad(e60b, "1000_1_3136952023", "http://cdn.example/forced-buffer.flac");
    await flush();
    eq(e60b.audio.instances.length, 0, "★★ __gpStream=false → 连元素都不建");
    eq(e60b.fetchLog.length, 1, "★★ 老老实实走缓冲（下载了）");
  }

  /* ---------- 61~73. v0.4.1 真无缝预约 ---------- */

  /**
   * 造一个「缓冲路径在播 + 下一首已预载就绪」的环境（还没排预约）。
   * 默认 `__gpStream=false`（createEnv 的默认）→ 走缓冲路径，才有 start(when) 可用。
   * @param mode  写进 localStorage 的 `NM_SETTING_PLAYER.mode`（不传就不写 → 走 seqStreak 兜底）
   */
  async function seamlessEnv(mode, opts) {
    opts = opts || {};
    const e = createEnv(opts.hooks);
    if (mode) e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode }));
    if (opts.eapiUrl) e.eapi.url = opts.eapiUrl;
    e.boot();
    await flush();
    const cur = opts.cur || 1000;
    e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    e.channel.call("player.setCurrentPlay", null, [idOf(cur)]);
    await flush();
    e.channel.call("audioplayer.load", null, [
      idOf(cur) + "-x",
      { songId: cur, musicurl: "http://cdn.example/seam.flac" },
    ]);
    await flush();
    await flush();
    await flush();
    e.channel.call("audioplayer.play", () => {}, [idOf(cur) + "-x", "t|resume|T"]);
    await flush();
    e.flushTimers(); // 让日志落盘（顺带把兜底起播的定时器冲掉，此时已在播 → 无害）
    return e;
  }
  /** 把 ctx.currentTime 推到「距上一首结束 left 秒」的位置（buffer.duration=200、startCtxTime=0.02） */
  function setLeft(e, left) {
    e.ctx.currentTime = 0.02 + 200 - left;
  }
  /** 缓冲那一首的结束时刻（startCtxTime=0.02 + duration=200） */
  const A_END = 200.02;
  /**
   * 让缓冲那一首「自然播完」：**先把 ctx 时钟推到它的结束时刻**，再触发 onended。
   * ★ 必须推时钟 —— 否则「结束时刻估晚了 → 立刻起播」那道兜底会误触发
   *   （真机上 `onended` 就是在 endCtxTime 那一刻来的）。
   */
  function endA(e) {
    e.ctx.currentTime = A_END;
    enderOf(e.started, 0)();
  }

  section("61. ★★ v0.4.1 顺序播放 + 下一首已就绪 → 到点前预约（start 排在结束采样上）");
  {
    const e = await seamlessEnv("playorder");
    ok(countLog(e, "预载就绪（下一首）｜ track=2000") >= 1, "（前提）2000 已预载就绪");
    const n0 = e.started.length;
    setLeft(e, 1.0); // 距结束 ~1.0s（落在 [0.3,1.5] 窗口内）
    e.tick();
    await flush();
    e.flushTimers();
    ok(countLog(e, "预约 ｜") >= 1, "★★ 预约了（日志 [sched] 预约）");
    eq(e.started.length, n0 + 1, "★★ 多排了一个 source（B）");
    const s = lastOf(e.started);
    eq(s.off, 0, "★ 预约从 0 开始");
    ok(Math.abs(s.at - 200.02) < 0.15, "★★ start 排在「上一首的结束采样」上（at≈endCtxTime，实际 " + Number(s.at).toFixed(3) + "）");

    // 再 tick 不该重复预约
    const n1 = e.started.length;
    e.tick();
    await flush();
    eq(e.started.length, n1, "★★ 已经排过 → 不重复预约");
  }

  section("62. ★★ v0.4.1 闸门：条件不满足一律不预约");
  {
    // (a) 下一首的预载还在飞（status=pending）→ 不预约
    const ea = await seamlessEnv("playorder", { eapiUrl: "http://cdn.example/hang/n.flac" });
    setLeft(ea, 1.0);
    ea.tick();
    await flush();
    ea.flushTimers();
    eq(countLog(ea, "预约 ｜"), 0, "★★ 槽里还没 ready（在飞）→ 不预约");

    // (b) 太早（还剩 2.5s）
    const eb = await seamlessEnv("playorder");
    setLeft(eb, 2.5);
    eb.tick();
    await flush();
    eb.flushTimers();
    eq(countLog(eb, "预约 ｜"), 0, "★★ 还剩 2.5s（太早）→ 不预约");

    // (c) 太晚（还剩 0.1s）
    const ec = await seamlessEnv("playorder");
    setLeft(ec, 0.1);
    ec.tick();
    await flush();
    ec.flushTimers();
    eq(countLog(ec, "预约 ｜"), 0, "★★ 还剩 0.1s（太晚）→ 不预约");

    // (d) 随机播放模式 → 不预约
    const ed = await seamlessEnv("playrandom");
    setLeft(ed, 1.0);
    ed.tick();
    await flush();
    ed.flushTimers();
    eq(countLog(ed, "预约 ｜"), 0, "★★ 模式是随机播放 → 不预约");

    // (e) 当前是列表最后一首（nextTrack() 为 null）→ 不预约
    const ee = await seamlessEnv("playorder", { cur: 6000 });
    setLeft(ee, 1.0);
    ee.tick();
    await flush();
    ee.flushTimers();
    eq(countLog(ee, "预约 ｜"), 0, "★★ 最后一首没有下一首 → 不预约");
  }

  section("63. ★★★ v0.4.1 交接：上一首播完 → 下一首直接接上，且**绝不打断已接上的 B**");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, e.started.length - 1);
    const stopped0 = e.stopped.length;
    const nAfter = e.started.length;

    endA(e); // 上一首自然播完
    await flush();
    e.flushTimers();
    ok(countLog(e, "无缝交接") >= 1, "★★ 走「无缝交接」分支");
    ok(!!e.last("End"), "★★ [end] 已发出（UI 才会推进到下一首）");
    ok(!!bNode && e.stopped.indexOf(bNode) < 0, "★★★ 已经接上的 B **没被停掉**（结构性不变量的核心）");
    eq(e.started.length, nAfter, "★★ 交接没有重新 start（B 就是排好的那个）");
    ok(e.stopped.length > stopped0, "★ 只停了上一首的 A");
  }

  section("64. ★★ v0.4.1 认领：UI 的 load 到了 → 认领（不重启、duration 用 B 的）");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    endA(e);
    await flush();
    const n1 = e.started.length;

    e.channel.call("player.setCurrentPlay", null, [idOf(2000)]);
    await flush();
    e.channel.call("audioplayer.load", null, [
      idOf(2000) + "-y",
      { songId: 2000, musicurl: "http://cdn.example/claim.flac" },
    ]);
    await flush();
    e.flushTimers();
    ok(countLog(e, "[sched] 认领") >= 1, "★★ 认领了（日志 [sched] 认领）");
    eq(e.started.length, n1, "★★ 认领**没有**重新 start");
    eq(argAt(e.last("Load"), 0), idOf(2000) + "-y", "★ onLoad 的 audioId 是 B 的");
    eq(argAt(e.last("Load"), 1).duration, 200, "★ duration 是 B 的");
  }

  section("65. ★★ v0.4.1 UI 连发 3 次 play：首个补发 onPlayState(1)，后两次忽略，都不重启");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    endA(e);
    await flush();
    e.channel.call("player.setCurrentPlay", null, [idOf(2000)]);
    await flush();
    e.channel.call("audioplayer.load", null, [idOf(2000) + "-y", { songId: 2000, musicurl: "http://cdn.example/p.flac" }]);
    await flush();
    const n2 = e.started.length;
    const ps0 = e.all("PlayState").length;

    e.channel.call("audioplayer.play", () => {}, [idOf(2000) + "-y", "t|resume|T2"]);
    await flush();
    e.flushTimers();
    eq(e.all("PlayState").length, ps0 + 1, "★★ 首个 play 补发了一条 onPlayState");
    eq(argAt(e.last("PlayState"), 2), 1, "★ 是「播放中」");
    eq(argAt(e.last("PlayState"), 0), idOf(2000) + "-y", "★ 用的是 B 的 audioId");
    ok(countLog(e, "无缝认领 → 补发 onPlayState(1)") >= 1, "★ 日志说明是「认领补发」");

    e.channel.call("audioplayer.play", () => {}, [idOf(2000) + "-y", "t|resume|T2"]);
    e.channel.call("audioplayer.play", () => {}, [idOf(2000) + "-y", "t|resume|T2"]);
    await flush();
    e.flushTimers();
    eq(countLog(e, "已经在播，忽略"), 2, "★ 后两次走「已经在播，忽略」");
    eq(e.started.length, n2, "★★ 三次 play 都没重启 source");
  }

  section("66. ★★ v0.4.1 押错：预约 B 但 UI 要 C → 停掉已响的 B，随后 load(C) 走正常路径");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, e.started.length - 1);
    endA(e); // 交接 → B 已响
    await flush();
    e.channel.call("player.setCurrentPlay", null, [idOf(5000)]); // UI 其实要 5000
    await flush();
    e.flushTimers();
    ok(countLog(e, "[sched] ★ 押错") >= 1, "★★ 押错被识别并撤销");
    ok(e.stopped.indexOf(bNode) >= 0, "★★ 已经响起来的 B 被停掉（只响了 ~21ms）");

    const n = e.started.length;
    e.channel.call("audioplayer.load", null, [idOf(5000) + "-z", { songId: 5000, musicurl: "http://cdn.example/c5.flac" }]);
    await flush();
    e.flushTimers();
    ok(e.started.length > n, "★ 随后 load(5000) 走正常路径（重新起播）");
  }

  section("67. ★ v0.4.1 撤销-暂停：排上的 B 不会到点自己响");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, e.started.length - 1);
    e.channel.call("audioplayer.pause", () => {}, ["", ""]);
    await flush();
    e.flushTimers();
    ok(countLog(e, "[sched] 撤销") >= 1, "★★ 暂停撤销了预约");
    ok(e.stopped.indexOf(bNode) >= 0, "★★ 排上的 B 被停掉（不会到点自己响）");
  }

  section("68. ★ v0.4.1 撤销-拖动：预约作废，新 source 从拖动位置起");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, e.started.length - 1);
    e.channel.call("audioplayer.seek", () => {}, ["", "", 10]);
    await flush();
    e.flushTimers();
    ok(countLog(e, "[sched] 撤销") >= 1, "★★ 拖动撤销了预约");
    ok(e.stopped.indexOf(bNode) >= 0, "★★ 排上的 B 被停掉");
    eq(lastOf(e.started).off, 10, "★ 新的 source 从 10s 起播");
  }

  section("69. ★ v0.4.1 撤销-切歌单（addListElement）");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, e.started.length - 1);
    e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await flush();
    e.flushTimers();
    ok(countLog(e, "[sched] 撤销") >= 1, "★★ 切歌单撤销了预约");
    ok(e.stopped.indexOf(bNode) >= 0, "★★ 排上的 B 被停掉");
  }

  section("70. ★ v0.4.1 撤销-audioplayer.stop：仍照旧放行给原生");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, e.started.length - 1);
    e.channel.call("audioplayer.stop", () => {}, [idOf(1000)]);
    await flush();
    e.flushTimers();
    ok(countLog(e, "[sched] 撤销") >= 1, "★★ UI 的 stop 撤销了预约");
    ok(e.stopped.indexOf(bNode) >= 0, "★★ 排上的 B 被停掉");
    ok(e.nativeCalls.some((c) => c.name === "audioplayer.stop"), "★★ 但这条命令**仍放行**给原生");
  }

  section("71. ★★ v0.4.1 playedMs 归属：交接后只给 B 计时（onEnd 不含 A 的时间）");
  {
    const e = await seamlessEnv("playorder");
    e.advance(4000); // A 已经听了 4 秒
    setLeft(e, 1.0);
    e.tick();
    await flush();
    endA(e); // 交接
    await flush();
    const aPlayed = Number(argAt(e.last("End"), 1).playedTime) || 0;
    ok(Math.abs(aPlayed - 4000) < 50, "★★ A 的 onEnd.playedTime ≈ 4000（含它自己那段）");

    e.advance(3000); // B 听了 3 秒
    enderOf(e.started, e.started.length - 1)(); // B 播完
    const bPlayed = Number(argAt(e.last("End"), 1).playedTime) || 0;
    ok(Math.abs(bPlayed - 3000) < 50, "★★ B 的 onEnd.playedTime ≈ 3000（不含 A 的 4 秒，实际 " + Math.round(bPlayed) + "）");
  }

  section("72. ★★ v0.4.1 live 窗口抑制进度（避免进度条从 0 闪一下）");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    endA(e); // 交接 → phase=live
    await flush();
    const p0 = e.all("PlayProgress").length;
    e.tick();
    await flush();
    eq(e.all("PlayProgress").length, p0, "★★ live 窗口内不发进度（UI 不会看到位置跳回 0）");
  }

  section("73. ★★ v0.4.1 peek 不消费预载槽：认领不重复下载、押中率统计照常");
  {
    const e = await seamlessEnv("playorder");
    setLeft(e, 1.0);
    e.tick();
    await flush();
    const miss0 = countLog(e, "✗ 预测失败");
    e.channel.call("player.setCurrentPlay", null, [idOf(2000)]);
    await flush();
    e.flushTimers();
    eq(countLog(e, "✗ 预测失败"), miss0, "★★ 预约没有消费预载槽 → 没被误记成「押不中」");
    eq(countLog(e, "开始预载（当前曲目）｜ track=2000"), 0, "★★ 槽还在 → 不会把 B 当「当前曲目」重复预载");

    const f0 = e.fetchLog.length;
    e.channel.call("audioplayer.load", null, [idOf(2000) + "-y", { songId: 2000, musicurl: "http://cdn.example/pk.flac" }]);
    await flush();
    e.flushTimers();
    ok(!e.fetchLog.slice(f0).some((u) => /pk\.flac/.test(String(u))), "★★ 认领路径没有下载 payload 给的 URL（B 早就预载好了）");
    ok(countLog(e, "开始预载（下一首）｜ track=3000") >= 1, "★ 认领后接着预载「下一首的下一首」3000（无缝链条不断）");
  }

  /* ---------- 74~77. v0.4.2 流式那一首也能预约 ---------- */

  /**
   * 造一个「流式在播 + 下一首已预载就绪」的环境。
   * ★ 这是真机最常见的形态：切歌单后 110ms 就 `load`，新歌单第一首的预载根本来不及 → 只能流式。
   *   然后它自然播完，就是用户听到的「卡一下」（实测 503ms）。
   */
  async function streamSeamEnv(mode) {
    const e = createEnv();
    delete e.win.__gpStream; // 出厂默认 → 流式
    if (mode) e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode }));
    e.boot();
    await flush();
    e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
    // ★ 要紧跟 load（真机只隔 110ms）——中间 await 的话预载会提前就绪，就变成缓冲了
    streamLoad(e, idOf(1000) + "-x", "http://cdn.example/ss.flac");
    await flush();
    e.audio.last.duration = 200;
    e.audio.emit("loadedmetadata");
    await flush();
    e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
    await flush();
    await flush();
    await flush();
    e.flushTimers();
    return e;
  }

  section("74. ★★★ v0.4.2 流式那一首也能预约（把实测 503ms 的卡顿干掉）");
  {
    const e = await streamSeamEnv("playorder");
    ok(countLog(e, "预载就绪（下一首）｜ track=2000") >= 1, "（前提）2000 已预载就绪");
    const n0 = e.started.length;
    e.audio.last.currentTime = 199.0; // 距结束 1.0s
    e.tick();
    await flush();
    e.flushTimers();
    ok(countLog(e, "预约 ｜") >= 1, "★★ 流式那一首也预约了（原来这里直接 return）");
    ok(countLog(e, "｜ 来源=流式") >= 1, "★★ 日志标明来源是流式");
    eq(e.started.length, n0 + 1, "★★ 排上了一个 buffer source");
    const s = lastOf(e.started);
    eq(s.off, 0, "★ 从 0 开始");
    ok(
      Math.abs(Number(s.at) - 1.0) < 0.15,
      "★★ at = ctx.now + (duration - currentTime) ≈ 1.0（实际 " + Number(s.at).toFixed(3) + "）"
    );
  }

  section("75. ★★★ v0.4.2 流式交接：<audio> 被按住、B 直接接上、这一首改由缓冲发声");
  {
    const e = await streamSeamEnv("playorder");
    e.audio.last.currentTime = 199.0;
    e.tick();
    await flush();
    const bNode = nodeOf(e.started, 0);
    e.ctx.currentTime = 1.0; // 到点（B 排在 ctx 1.0）
    e.audio.last.currentTime = 200;
    e.audio.emit("ended");
    await flush();
    e.flushTimers();
    ok(countLog(e, "无缝交接 ｜ A=1000 → B=2000 ｜ 来源=流式") >= 1, "★★ 走「无缝交接」分支且来源是流式");
    ok(!!e.last("End"), "★★ [end] 已发出（UI 才会推进）");
    ok(!!bNode && e.stopped.indexOf(bNode) < 0, "★★★ 已经接上的 B 没被停掉");
    eq(e.audio.last.paused, true, "★★ 交接时把 <audio> 按住了（否则会双声）");
    e.tick();
    await flush();
    e.flushTimers();
    ok(countLog(e, "播法=缓冲") >= 1, "★★ 交接后这一首改由缓冲发声（S.stream 置回 false）");
  }

  section("76. ★★ v0.4.2 流式的「结束时刻」估晚了 → 交接时立刻起播（不留空档）");
  {
    const e = await streamSeamEnv("playorder");
    e.audio.last.currentTime = 199.0; // 推 1.0s 后结束
    e.tick();
    await flush();
    const n1 = e.started.length;
    const schedNode = nodeOf(e.started, n1 - 1);
    // 模拟 duration 被高估：ended 在 ctx 还没走到 1.0 的时候就来了
    e.audio.last.currentTime = 200;
    e.audio.emit("ended");
    await flush();
    e.flushTimers();
    ok(countLog(e, "结束时刻估晚了") >= 1, "★★ 识别出「估晚了」");
    eq(e.started.length, n1 + 1, "★★ 换了一个新节点立刻起播");
    ok(Math.abs(Number(lastOf(e.started).at) - 0.005) < 0.01, "★★ 新节点就在当前时刻起播（不等原来那个未来时刻）");
    ok(!!schedNode && e.stopped.indexOf(schedNode) >= 0, "★ 原来那个排在将来的被停掉，不会晚点再响一遍");
  }

  section("77. ★ v0.4.2 流式的 duration 还不可用（NaN）→ 不预约（不瞎猜）");
  {
    const e = await streamSeamEnv("playorder");
    e.audio.last.duration = NaN;
    e.tick();
    await flush();
    e.flushTimers();
    eq(countLog(e, "预约 ｜"), 0, "★★ duration 无效 → 不预约");
  }

  /* ==================== 3.1.x 适配（本分支新增） ==================== */

  /** 3.x 环境：APP_CONF.appver = 3.1.x，并让假原生桥能回答 network.fetch */
  /**
   * 3.x 环境。
   * @param jsonBody  player/url 接口的返回
   * @param durMs     可选：song/detail 的权威时长；不给就按 size/br 自洽推算
   */
  function env3x(jsonBody, durMs, opts) {
    opts = opts || {};
    const d0 = (jsonBody && jsonBody.data && jsonBody.data[0]) || {};
    const implied = d0.size && d0.br ? Math.round((d0.size / (d0.br / 8)) * 1000) : 158600;
    const dur = durMs || implied;
    const e = createEnv({
      onNative(name, cb, args) {
        if (name !== "network.fetch" || typeof cb !== "function") return;
        // ⚠️ originalCall 收到的是 channel.call 的完整参数，hooks 拿到的是 slice(2) →
        //    args = [[{url}]]，要多剥一层。
        const a0 = args && args[0];
        const first = Array.isArray(a0) ? (a0[0] || {}) : (a0 || {});
        const u = String(first.url || "");
        const body = u.indexOf("/api/song/detail") >= 0
          ? { blob: JSON.stringify({ songs: [{ id: 0, duration: dur }] }) }
          : { blob: JSON.stringify(jsonBody) };
        // ★ opts.defer：把回包推迟一个微任务 —— 用来制造「真并发」，
        //   验证 `once()` 确实把同一个 id 的两次请求合并了（同步回答的话它们根本不会重叠）。
        if (opts.defer) Promise.resolve().then(() => cb(body));
        else cb(body);
      },
    });
    e.APP_CONF.appver = "3.1.42.205594";
    return e;
  }

  section("78. ★★★ 3.1.x 事件契约：getPlayedTime / getPlaybackInfo 由插件自答（修「跳歌」）");
  {
    const e78 = createEnv();
    e78.APP_CONF.appver = "3.1.42.205594";
    e78.boot();
    await flush();
    e78.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(e78, 1000);
    e78.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
    await flush();
    e78.ctx.currentTime += 5; // 播 5 秒
    e78.tick();

    const pt = [];
    e78.channel.call("audioplayer.getPlayedTime", (r) => pt.push(r), [{ playId: idOf(1000) + "-x" }]);
    const a = pt[0] || {};
    eq(a.result, true, "★★ 3.x：getPlayedTime 由插件自答（result=true，不再让原生回 false → 客户端不会再判一次结束）");
    ok(Number(a.playedTime) > 0, "★★ 自答里是引擎的真实播放位置（" + a.playedTime + "ms）");
    eq(!!a.playedAudioTime, true, "★★ 契约字段 playedAudioTime 也在");

    const pi = [];
    e78.channel.call("audioplayer.getPlaybackInfo", (r) => pi.push(r), [{ playId: idOf(1000) + "-x" }]);
    const b = pi[0] || {};
    eq(b.result, true, "★★ 3.x：getPlaybackInfo 也被自答");
    eq(b.playId, idOf(1000) + "-x", "★★ playId 原样回填（否则客户端对不上）");
    ok(Number(b.playedTime) > 0, "★★ 带真实 playedTime");
    eq(!!b.deviceAudioFormat, true, "★★ 契约字段 deviceAudioFormat 在");

    const other = [];
    e78.channel.call("audioplayer.getPlayedTime", (r) => other.push(r), [{ playId: "999999_zzz" }]);
    eq(other.length, 0, "★★ 不认识的 playId → 不乱答");
    ok(
      e78.nativeCalls.some((x) => x.name === "audioplayer.getPlayedTime"),
      "★★ 放行时确实落到了原版 channel.call"
    );
  }

  section("79. ★★★ 3.1.x 预载：免签名 320k 接口 / 试听片段被拒");
  {
    // 正常 320k
    const eOk = env3x({ data: [{ url: "http://cdn.example/320.mp3", br: 320000, size: 6000000, type: "mp3", fee: 1, payed: 1 }] });
    eOk.eapi.available = false; // 3.x 上 LibEAPIRequest 找不到请求函数
    eOk.boot();
    await flush();
    eOk.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(eOk, 1000);
    await flush();
    await flush();
    ok(countLog(eOk, "320k 接口") >= 1, "★★ 3.x：LibEAPI 不可用时走免签名 320k 接口");
    ok(
      eOk.fetchLog.some((u) => String(u).indexOf("cdn.example/320.mp3") >= 0),
      "★★ 真的按接口给的地址预载了"
    );
    ok(countLog(eOk, "预载就绪（下一首）") >= 1, "★★ 预载就绪");

    // 试听片段（br 非标准值）
    // ★ 关键：br 是 320000（不是 320006），但 size 只够 64s，权威时长 158.6s → 靠时长判定拦下
    const eClip = env3x({ data: [{ url: "http://cdn.example/clip.mp3", br: 320000, size: 2562133, type: "mp3", fee: 1, payed: 1 }] }, 158600);
    eClip.eapi.available = false;
    eClip.boot();
    await flush();
    eClip.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(eClip, 1000);
    await flush();
    await flush();
    eClip.flushTimers(); // 日志是攒着写的，断言前要刷一次
    if (process.env.GP_DEBUG_3X) console.log("---- eClip log ----\n" + eClip.logs().slice(-2000));
    ok(countLog(eClip, "试听片段") >= 1, "★★ 试听片段（估算 64s ≠ 实际 158.6s）被识别");
    eq(
      eClip.fetchLog.filter((u) => String(u).indexOf("clip.mp3") >= 0).length,
      0,
      "★★ 试听片段没有被下载（否则歌会在片段边界断掉）"
    );
    ok(
      countLog(eClip, "outer/url(128k) 兜底") >= 1,
      "★★ 试听片段被拒后按预期降级（退 128k 直链 → 拿不到就安静放弃）"
    );
  }

  section("80. ★★★ 3.1.x 加密 musicurl 播不了 → 用自有地址重试一次");
  {
    const e80 = env3x({ data: [{ url: "http://cdn.example/retry.mp3", br: 320000, size: 5000000, type: "mp3" }] });
    delete e80.win.__gpStream; // 走流式
    e80.boot();
    await flush();
    e80.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
    streamLoad(e80, idOf(1000) + "-x", "TOKEN_ENC");
    await flush();
    const el = e80.audio.last;
    eq(el.src, "TOKEN_ENC", "（前提）先把客户端的加密 token 挂到 el.src");
    el.error = { message: "Format error" };
    e80.audio.emit("error");
    await flush();
    await flush();
    await flush();
    e80.flushTimers(); // 日志是攒着写的
    eq(el.src, "http://cdn.example/retry.mp3", "★★ 媒体错误后改用自有 320k 地址重挂");
    ok(countLog(e80, "改用自有地址重试") >= 1, "★★ 日志写明走了重试");
  }
  /* ---------- 81. v1.2.0 P0：MP3 首尾裁剪 ---------- */

  /**
   * 合成一个「带 Xing + LAME 标签」的 MP3 字节串 —— 只为了让解析器有东西可读，
   * 不是有效的音频（不需要是：裁剪解析只看头部结构）。
   * 结构：帧头 4B + side info 32B + "Xing" + flags + frames + bytes + TOC(100B)
   *       + quality(4B) + LAME 标签（delay/padding 在标签 +21 起 3 字节）。
   */
  function makeLameMp3(opts) {
    const delay = opts.delay;
    const padding = opts.padding;
    const frames = opts.frames || 1000;
    const buf = new Uint8Array(512);
    let p = 0;
    // MPEG1 / Layer III / 128kbps / 44.1kHz / 立体声
    buf[p++] = 0xff;
    buf[p++] = 0xfb;
    buf[p++] = 0x90;
    buf[p++] = 0x00;
    p += 32; // side info
    "Xing".split("").forEach((c) => (buf[p++] = c.charCodeAt(0)));
    const put32 = (v) => {
      buf[p++] = (v >>> 24) & 0xff;
      buf[p++] = (v >>> 16) & 0xff;
      buf[p++] = (v >>> 8) & 0xff;
      buf[p++] = v & 0xff;
    };
    put32(0x0f); // flags: frames | bytes | TOC | quality
    put32(frames);
    put32(123456); // bytes
    p += 100; // TOC
    put32(0); // quality
    const lame = p;
    "LAME3.100".split("").forEach((c) => (buf[p++] = c.charCodeAt(0)));
    p = lame + 21;
    buf[p++] = (delay >> 4) & 0xff;
    buf[p++] = ((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f);
    buf[p++] = padding & 0xff;
    return buf.buffer;
  }

  /** 合成一个「开头/结尾各一段真静音、中间是有声音」的假 AudioBuffer */
  function mkBuf(opts) {
    const sr = opts.sr || 44100;
    const duration = opts.duration;
    const n = Math.round(duration * sr);
    const head = Math.round((opts.head || 0) * sr);
    const tail = Math.round((opts.tail || 0) * sr);
    const data = new Float32Array(n);
    for (let i = head; i < n - tail; i++) data[i] = i % 2 ? 0.5 : -0.5; // 满幅方波 = 绝不可能是静音
    return {
      duration: duration,
      sampleRate: sr,
      numberOfChannels: 1,
      length: n,
      getChannelData() {
        return data;
      },
    };
  }

  /** 合成一个最小 FLAC（"fLaC" + STREAMINFO，sr=44100、total=132300） */
  function makeFlacInfo() {
    const b = new Uint8Array(128); // 真实 FLAC 都有几 KB；这里只要过「长度 >= 64」的解析门槛
    "fLaC".split("").forEach((c, i) => (b[i] = c.charCodeAt(0)));
    b[4] = 0x00; // 块类型 0 = STREAMINFO（且是最后一个块）
    b[7] = 34; // 块长度
    b[18] = 0x0a; // sr = (0x0a<<12)|(0xc4<<4)|(0x4) = 44100
    b[19] = 0xc4;
    b[20] = 0x40;
    b[21] = 0x00; // total samples 36bit = 132300
    b[22] = 0x00;
    b[23] = 0x02;
    b[24] = 0x04;
    b[25] = 0xcc;
    return b.buffer;
  }

  section("81. ★★ v1.2.0/v1.2.1 P0：MP3 首尾裁剪（填充必裁 / 作品静音默认不裁）");
  {
    // 一套自洽的数值：解码全长 = 帧数 × 1152；理论可听 = 全长 - delay - padding。
    // 这样「解码器没裁」那一档的期望值是精确的（可听时长 == 理论时长）。
    const SR = 44100, SPF = 1152, FRAMES = 1000, DELAY = 576, PAD = 1000;
    const LAME = makeLameMp3({ delay: DELAY, padding: PAD, frames: FRAMES });
    const FULL = (FRAMES * SPF) / SR; // ≈26.122s（含首尾填充）
    const AUDIBLE = (FRAMES * SPF - DELAY - PAD) / SR; // ≈26.087s（理论可听）
    const DS = DELAY / SR; // ≈13.1ms
    const PE = PAD / SR; // ≈22.7ms

    /** 跑到「预载命中 → 已起播」，并让日志落盘 */
    async function playWith(env, url) {
      env.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
      env.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
      await flush();
      await flush();
      env.channel.call("audioplayer.load", null, ["1000_1_3136952023-x", { songId: 1000, musicurl: url }]);
      await flush();
      env.channel.call("audioplayer.play", () => {}, ["1000_1_3136952023-x", "t|resume|T"]);
      await flush();
      env.flushTimers();
    }

    // ---- (a) 解码器没裁（Δ ≈ delay+padding）→ 填充必须裁，可听 == 理论 ----
    {
      const ea = createEnv({ bytes: LAME, decode: () => mkBuf({ duration: FULL, head: DS, tail: PE }) });
      ea.boot();
      await flush();
      await playWith(ea, "http://cdn.example/t1.mp3");

      const ld = ea.last("Load");
      ok(
        Math.abs(argAt(ld, 1).duration - AUDIBLE) < 0.002,
        "★★ 可听时长 == LAME 理论时长（" + Number(argAt(ld, 1).duration).toFixed(3) + "s）"
      );
      ok(countLog(ea, "解码器未裁") >= 1, "★★ 判定为「解码器未裁」→ 按声明值裁填充");
      ok(countLog(ea, "（必裁）") >= 1, "★★ 日志把「填充」标成必裁");
      const s = lastOf(ea.started);
      ok(
        Math.abs(s.off - DS) < 0.002,
        "★★ start 从填充之后起播（off≈13.1ms，实际 " + Number(s.off).toFixed(4) + "）"
      );
      ok(
        Math.abs(s.dur - AUDIBLE) < 0.002,
        "★★ start 的 duration 只到「可听末尾」（实际 " + Number(s.dur).toFixed(4) + "）"
      );
    }

    // ---- (b) 解码器已裁（Δ≈0）+ 作品静音 → 默认**不裁**（忠实 Spotify 的 gapless 语义） ----
    {
      const eb = createEnv({ bytes: LAME, decode: () => mkBuf({ duration: AUDIBLE, head: 0.04, tail: 0.03 }) });
      eb.boot();
      await flush();
      await playWith(eb, "http://cdn.example/t2.mp3");
      const ld = eb.last("Load");
      ok(Math.abs(argAt(ld, 1).duration - AUDIBLE) < 0.002, "★★ 作品静音默认不裁 → 时长不变（一点真内容都不吃）");
      ok(countLog(eb, "作品静音=首40.0 尾30.0ms（不裁") >= 1, "★★ 日志写明「探到的是作品静音，不裁」");
      const s = lastOf(eb.started);
      eq(s.off, 0, "★★ start 仍从 0 开始");
    }

    // ---- (b2) 打开 __gpTrimPad → 作品静音也一起削掉（想要更紧的接缝） ----
    {
      const eb2 = createEnv({ bytes: LAME, decode: () => mkBuf({ duration: AUDIBLE, head: 0.04, tail: 0.03 }) });
      eb2.win.__gpTrimPad = true;
      eb2.boot();
      await flush();
      await playWith(eb2, "http://cdn.example/t2b.mp3");
      const ld = eb2.last("Load");
      ok(
        Math.abs(argAt(ld, 1).duration - (AUDIBLE - 0.07)) < 0.002,
        "★★ __gpTrimPad=true → 作品静音也裁（" + Number(argAt(ld, 1).duration).toFixed(3) + "s）"
      );
      ok(countLog(eb2, "（已裁）") >= 1, "★★ 日志标明作品静音已裁");
      const s = lastOf(eb2.started);
      ok(Math.abs(s.off - 0.04) < 0.002, "★★ start 从 40ms 处起（" + Number(s.off).toFixed(4) + "）");
    }

    // ---- (c) 没有 LAME 头 → 只按波形裁，且每边最多 20ms ----
    {
      const ec = createEnv({ bytes: new ArrayBuffer(512), decode: () => mkBuf({ duration: 3, head: 0.03, tail: 0.03 }) });
      ec.boot();
      await flush();
      ec.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
      ec.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
      await flush();
      await flush();
      ec.channel.call("audioplayer.load", null, [
        "1000_1_3136952023-x",
        { songId: 1000, musicurl: "http://cdn.example/t3.mp3" },
      ]);
      await flush();
      const ld = ec.last("Load");
      ok(Math.abs(argAt(ld, 1).duration - 2.96) < 0.002, "★★ 无 gapless 信息 → 每边只裁 20ms（实际 " + Number(argAt(ld, 1).duration).toFixed(3) + "）");
      ec.flushTimers();
      ok(countLog(ec, "无 gapless 信息") >= 1, "★ 日志说明了「没有 gapless 信息」");
    }

    // ---- (d) FLAC 样本精确 → 一点都不裁（多出来的静音是作者自己的） ----
    {
      const ed = createEnv({ bytes: makeFlacInfo(), decode: () => mkBuf({ duration: 3, head: 0.03, tail: 0.03 }) });
      ed.boot();
      await flush();
      ed.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
      ed.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
      await flush();
      await flush();
      ed.channel.call("audioplayer.load", null, [
        "1000_1_3136952023-x",
        { songId: 1000, musicurl: "http://cdn.example/t4.flac" },
      ]);
      await flush();
      const ld = ed.last("Load");
      eq(Number(argAt(ld, 1).duration), 3, "★★ FLAC 不裁（样本数精确）");
      ed.flushTimers();
      ok(countLog(ed, "FLAC 样本精确") >= 1, "★★ 日志写明 FLAC 样本精确");
    }

    // ---- (e) 逃生开关 ----
    {
      const ee = createEnv({ bytes: LAME, decode: () => mkBuf({ duration: 3, head: 0.026, tail: 0.02 }) });
      ee.win.__gpTrim = false;
      ee.boot();
      await flush();
      ee.channel.call("player.addListElement", null, [JSON.stringify(LIST)]);
      ee.channel.call("player.setCurrentPlay", null, ["1000_1_3136952023"]);
      await flush();
      await flush();
      ee.channel.call("audioplayer.load", null, [
        "1000_1_3136952023-x",
        { songId: 1000, musicurl: "http://cdn.example/t5.mp3" },
      ]);
      await flush();
      ee.flushTimers();
      const ld = ee.last("Load");
      eq(Number(argAt(ld, 1).duration), 3, "★★ __gpTrim=false → 完全不裁");
      ok(countLog(ee, "已关闭（window.__gpTrim=false）") >= 1, "★★ 日志写明了被开关关掉");
    }

    // ---- (f) 预约下一首时必须带【B 自己的】裁剪量，不能套用 A 的 ----
    {
      const ef = await seamlessEnv("playorder", {
        hooks: { bytes: LAME, decode: () => mkBuf({ duration: 200, head: DS, tail: PE }) },
      });
      ok(countLog(ef, "预载就绪（下一首）｜ track=2000") >= 1, "（前提）2000 已预载就绪");
      const bdur = 200 - DS - PE; // 200 - 13.1ms - 22.7ms
      const n0 = ef.started.length;
      setLeft(ef, 1.0);
      ef.tick();
      await flush();
      eq(ef.started.length, n0 + 1, "★★ 多排了一个 source（B）");
      const s = lastOf(ef.started);
      ok(
        Math.abs(s.off - DS) < 0.002,
        "★★ B 从自己的「可听起点」起播（off≈13.1ms，实际 " + Number(s.off).toFixed(4) + "）"
      );
      ok(Math.abs(s.dur - bdur) < 0.01, "★★ B 的 duration 也裁过（实际 " + Number(s.dur).toFixed(3) + "）");
      ok(Math.abs(s.at - (0.02 + bdur)) < 0.05, "★★ 接缝时刻 = A 的「可听结束」（实际 " + Number(s.at).toFixed(3) + "）");
    }
  }

  section("82. ★★ v1.2.1 并发去重：同一个 id 的取址 / 时长只打一次");
  {
    const BODY = { data: [{ url: "http://cdn.example/320.mp3", br: 320000, size: 6000000, type: "mp3" }] };
    // ★ defer：让原生网络层「晚一个微任务」才回包 —— 这样 setCurrentPlay 的抢解析
    //   与 startPreload 的预载会**真的重叠**（同步回包的话根本测不出并发去重）。
    const e82 = env3x(BODY, 165000, { defer: true });
    e82.eapi.available = false; // 3.x 上 LibEAPIRequest 找不到请求函数 → 必然走 320k 免签名接口
    e82.boot();
    await flush();
    e82.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(e82, 1000);
    await flush();
    await flush();
    e82.flushTimers();

    /** 原生网络层收到的、含某个片段且针对某个 trackId 的请求数 */
    const netCount = (needle, tid) =>
      e82.nativeCalls.filter((c) => {
        if (c.name !== "network.fetch") return false;
        const a0 = c.args && c.args[0];
        const first = Array.isArray(a0) ? a0[0] || {} : a0 || {};
        const u = String(first.url || "");
        return u.indexOf(needle) >= 0 && u.indexOf("[" + tid + "]") >= 0;
      }).length;

    eq(netCount("/api/song/enhance/player/url", 1000), 1, "★★ 曲目 1000 的 320k 接口只打一次（并发合并）");
    eq(netCount("/api/song/detail", 1000), 1, "★★ 曲目 1000 的 song/detail 也只打一次");
  }

  section("83. ★★ v1.2.1 不重复下载：字节缓存 + 最近缓冲复用");
  {
    // (a) 字节缓存：同一首被「换槽 → 换回来」时不再下载
    const e83 = createEnv();
    e83.boot();
    await flush();
    e83.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    e83.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
    await flush();
    await flush(); // 预载 1000 就绪 → 字节进缓存
    e83.channel.call("player.setCurrentPlay", null, [idOf(2000)]);
    await flush(); // 预载槽被换成 2000
    e83.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
    await flush();
    await flush();
    e83.flushTimers();
    ok(
      countLog(e83, "字节缓存命中 → 跳过取址 + 下载 ｜ track=1000") >= 1,
      "★★ 再次预载同一首 → 命中字节缓存（跳过取址 + 下载）"
    );
    eq(countLog(e83, "[trim] track=1000"), 2, "★ 但确实重新解码了一次（字节缓存只省下载，不省解码）");

    // (b) 最近缓冲：搬回「刚播过」的那首 → 既不下载也不解码
    const e83b = createEnv();
    e83b.win.__gpBytesCache = false; // 关掉字节缓存，单独验「最近缓冲」
    e83b.boot();
    await flush();
    e83b.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
    await playTrack(e83b, 1000); // 播第一首（解码一次）
    await playTrack(e83b, 2000); // 切走
    const nDec = e83b.decoded.length;
    await playTrack(e83b, 1000); // 切回「刚播过的」那首
    await flush();
    e83b.flushTimers();
    ok(
      countLog(e83b, "复用刚播过的缓冲（不下载 / 不解码）｜ track=1000") >= 1,
      "★★ 切回刚播过的歌 → 直接复用缓冲（预载都不启动下载）"
    );
    eq(e83b.decoded.length, nDec, "★★ 一个字节都没再解码（decoded 计数没变）");
    ok(e83b.all("Load").length >= 3, "★ onLoad 照常发出（UI 不会觉得卡住）");
  }

  section("84. ★★★ v1.3.0 P2：等功率交叉淡入淡出（0~12s，Spotify 的 crossfade）");
  {
    /** 找出「带自动化曲线」的 gain 节点 */
    const curveNodes = (e) =>
      (e.ctx.__gains || [])
        .map((g) => ({ node: g, ev: g.gain.events.filter((x) => x.type === "curve") }))
        .filter((x) => x.ev.length > 0);
    const isFalling = (ev) => ev.curve[0] > ev.curve[ev.curve.length - 1];
    const isRising = (ev) => ev.curve[0] < ev.curve[ev.curve.length - 1];
    // ★ 变异体可能让「预约」根本没发生 → 这些取值必须**不抛错**，
    //   否则验证台会「崩了」（退出码 2）而不是干净报红，报告就没法看了。
    const evOf = (x) => (x && x.ev && x.ev[0]) || {};
    const curveOf = (x) => (x && x.ev && x.ev[0] && x.ev[0].curve) || [];
    const gainOf = (x) => (x && x.node && x.node.gain) || { value: null };
    const nodeOfX = (x) => (x && x.node) || null;

    // ---- (a) 默认 0s：绝对不能自己冒出交叉（Spotify 出厂也是关的） ----
    {
      const e = await seamlessEnv("playorder");
      eq(e.win.__gpXfade, undefined, "（前提）没有设 __gpXfade");
      setLeft(e, 1.0);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "预约 ｜") >= 1, "★★ 默认仍然照常预约（硬接）");
      eq(countLog(e, "交叉=关"), 1, "★★ 日志写明「交叉=关」");
      eq(curveNodes(e).length, 0, "★★ 一条自动化曲线都没排");
      ok(Math.abs(Number(lastOf(e.started).at) - 200.02) < 0.05, "★★ B 还是排在 A 的结束采样上");
    }

    // ---- (b) __gpXfade=3：窗口变宽 + B 提前 3s + 两条等功率曲线 ----
    {
      const e = await seamlessEnv("playorder");
      e.win.__gpXfade = 3;
      setLeft(e, 3.2); // ★ 3.2s：旧版本（窗口只有 1.5s）根本进不来
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "★ 交叉预约") >= 1, "★★ 窗口跟着变宽（3s 的交叉必须提前 3s 就排）");
      ok(countLog(e, "交叉=3.00s（曲线=equal）") >= 1, "★★ 日志写明 3.00s、曲线=equal（等功率）");
      const t0 = 200.02 - 3;
      ok(Math.abs(Number(lastOf(e.started).at) - t0) < 0.02, "★★ B 提前 3s 起播（" + Number(lastOf(e.started).at).toFixed(3) + "）");

      const nodes = curveNodes(e);
      eq(nodes.length, 2, "★★ 恰好两条曲线（A 淡出 + B 淡入）");
      const out = nodes.find((x) => isFalling(x.ev[0]));
      const inn = nodes.find((x) => isRising(x.ev[0]));
      ok(!!out && !!inn, "★★ 一条往下（淡出）一条往上（淡入）");
      const oEv = evOf(out);
      const iEv = evOf(inn);
      ok(
        Math.abs((oEv.t === undefined ? -999 : oEv.t) - t0) < 0.02 &&
          Math.abs((iEv.t === undefined ? -999 : iEv.t) - t0) < 0.02,
        "★★ 两条曲线同一时刻开始"
      );
      eq(oEv.dur, 3, "★★ 淡出曲线时长 = 交叉时长");
      eq(iEv.dur, 3, "★★ 淡入曲线时长 = 交叉时长");
      const oCurve = curveOf(out);
      const iCurve = curveOf(inn);
      const mid = Math.max(0, Math.floor(oCurve.length / 2) - 1);
      ok(Math.abs((oCurve[mid] || 0) - 0.707) < 0.05, "★★ 淡出中点 ≈ -3dB（" + Number(oCurve[mid] || 0).toFixed(3) + "）");
      ok(Math.abs((iCurve[mid] || 0) - 0.707) < 0.05, "★★ 淡入中点 ≈ -3dB（等功率，不是线性的 0.5）");
      ok(nodeOfX(out) !== e.ctx.__gain && nodeOfX(inn) !== e.ctx.__gain, "★★ 曲线没挂在主音量总线上（否则会改用户音量）");
      ok(!!nodeOfX(out) && nodeOfX(out) !== nodeOfX(inn), "★★ 两条曲线各挂各的节点");
      eq(String(e.localStorage.getItem("gaplessPlayer.xfade")), "3", "★★ 设置被记住（重启后还在）");

      // ---- (e) 交接之后：B 的 gain 必须被接管（否则下一轮交叉会打在空气上） ----
      e.ctx.currentTime = 200.02;
      enderOf(e.started, 0)(); // A 播完 → 无缝交接
      await flush();
      e.flushTimers();
      ok(countLog(e, "自然播完 → 无缝交接") >= 1, "（前提）交接发生了");
      e.channel.call("audioplayer.load", null, [
        "2000_1_3136952023-x",
        { songId: 2000, musicurl: "http://cdn.example/seam2.flac" },
      ]);
      await flush();
      // UI 的 play 到了 → 认领结束（S.sched 才会被清掉，下一轮才能再排）
      e.channel.call("audioplayer.play", () => {}, ["2000_1_3136952023-x", "t|resume|T"]);
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "预载就绪（下一首）｜ track=3000") >= 1, "（前提）3000 已预载就绪");

      const bEnd = t0 + 200; // B 从 t0 起、时长 200
      e.ctx.currentTime = bEnd - 3.2;
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "A=2000 → B=3000") >= 1, "★★ 第二轮交叉照样排得上（A=2000 → B=3000）");
      const bNodeNow = curveNodes(e).find((x) => nodeOfX(x) === nodeOfX(inn));
      ok(
        !!bNodeNow && bNodeNow.ev.some((x) => isFalling(x) && x.t > 390),
        "★★ 第二轮把「淡出」打在了 B 自己的 gain 上（交接带过来的增益节点）"
      );
    }

    // ---- (c) 只剩 1s 时设 12s → 自动缩短成「剩多少用多少」 ----
    {
      const e = await seamlessEnv("playorder");
      e.win.__gpXfade = 12;
      setLeft(e, 1.0);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "交叉预约") >= 1, "★ 剩 1s 也能排（xf 把窗口从 1.5s 撑到 12.4s）");
      ok(countLog(e, "交叉=0.95s") >= 1, "★★ 交叉自动缩到 0.95s（不是硬接，也不是排到过去）");
      ok(Math.abs(Number(lastOf(e.started).at) - (200.02 - 0.95)) < 0.02, "★ B 在 0.95s 前起播");
    }

    // ---- (d) 上限 12s + 暂停时把增益复位（A 不能永远留在小声） ----
    {
      const e = await seamlessEnv("playorder");
      e.win.__gpXfade = 99; // 超上限
      setLeft(e, 12.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "交叉=12.00s") >= 1, "★★ 交叉时长被夹到 12s（Spotify 的上限）");
      const nodes = curveNodes(e);
      const out = nodes.find((x) => isFalling(x.ev[0]));
      const inn = nodes.find((x) => isRising(x.ev[0]));
      ok(!!out && !!inn, "（前提）两条曲线都在");
      const bNode = lastOf(e.started).node;

      e.channel.call("audioplayer.pause", null, []);
      await flush();
      eq(gainOf(out).value, 1, "★★ 暂停后 A 的增益复位到 1（否则会一直小声播）");
      eq(gainOf(inn).value, 0, "★★ B 的增益被拉回 0");
      ok(bNode !== undefined && e.stopped.indexOf(bNode) >= 0, "★★ 排上的 B 被停掉（不会到点自己响）");
    }

    // ---- (f) 太短的值直接当关（0.3s 没有意义） ----
    {
      const e = await seamlessEnv("playorder");
      e.win.__gpXfade = 0.3;
      setLeft(e, 1.0);
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "交叉=关"), 1, "★★ < 0.5s 视为关（不排曲线）");
      eq(curveNodes(e).length, 0, "★★ 一条曲线都不排");
    }

    // ---- (g) A 走流式时也能淡出（曲线打在元素那一路的 gain 上） ----
    {
      const e = await streamSeamEnv("playorder");
      ok(countLog(e, "预载就绪（下一首）｜ track=2000") >= 1, "（前提）2000 已预载就绪");
      e.win.__gpXfade = 3;
      const now = e.ctx.currentTime; // 距结束 3.0s → 交叉被压到 2.95s（留 0.05s 余量）
      e.audio.last.currentTime = 197.0;
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "★ 交叉预约") >= 1, "★★ 流式那一首也能排交叉");
      ok(countLog(e, "来源=流式") >= 1, "★★ 日志标明来源是流式");
      const nodes = curveNodes(e);
      eq(nodes.length, 2, "★★ 仍是两条曲线");
      const out = nodes.find((x) => isFalling(x.ev[0]));
      const inn = nodes.find((x) => isRising(x.ev[0]));
      ok(!!out && !!inn, "★★ 一条淡出一条淡入");
      // 排除法：增益节点只可能有三个 —— 总线、元素那一路、B 那一路。
      // 淡出既然不是总线也不是 B，那就只能是元素那一路（= 流式的 gain）。
      const others = (e.ctx.__gains || []).filter((g) => g !== e.ctx.__gain && g !== nodeOfX(inn));
      eq(others.length, 1, "（前提）除总线与 B 之外只剩一个 gain（元素那一路）");
      ok(nodeOfX(out) === others[0], "★★ 淡出打在了流式元素自己的 gain 上");
      ok(Math.abs(evOf(inn).t - (now + 0.05)) < 0.06, "★★ B 提前约 3s 起播（曲线从 " + Number(evOf(inn).t).toFixed(3) + " 开始）");
      ok(Math.abs(evOf(inn).dur - 2.95) < 0.06, "★★ 交叉时长被压到 2.95s（剩 3.0s，留 0.05 余量）");
    }
  }

  section("85. ★★ v1.3.1 把流式那首补成缓冲（缓存不再只覆盖缓冲路径）");
  {
    /** 起一首流式并让它播起来（不建播放列表 → 不触发预载） */
    async function streamPlay(e, idStr, url) {
      e.boot();
      await flush();
      streamLoad(e, idStr, url);
      e.audio.last.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idStr + "-x", "t|resume|T"]);
      await flush();
      e.flushTimers();
    }

    // ---- (a) 听够 8s → 后台补成缓冲；之后切回来不再拉流 ----
    {
      const e = streamEnv();
      await streamPlay(e, idOf(1000), "http://cdn.example/s1.flac");
      eq(countLog(e, "[promote]"), 0, "（前提）刚起播不补");

      e.advance(9000); // 真听了 9 秒
      const f0 = e.fetchLog.length;
      e.tick();
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "★ 已补成缓冲") >= 1, "★★ 听够 8s → 后台补成缓冲");
      ok(countLog(e, "补成缓冲（切回来秒开，也能当交叉的 B）｜ track=1000") >= 1, "★★ 补的正是这一首（1000）");
      ok(e.fetchLog.length > f0, "★ 确实下载了一份（这份内容本来也会被重放一遍）");

      // 切走再切回来：应该命中「最近缓冲」，不再走流式
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(2000)]);
      await flush();
      streamLoad(e, idOf(2000), "http://cdn.example/s2.flac");
      e.audio.last.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idOf(2000) + "-x", "t|resume|T"]);
      await flush();

      const loads0 = e.audio.last.__loads;
      const dec0 = e.decoded.length;
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-y",
        { songId: 1000, musicurl: "http://cdn.example/s1-again.flac" },
      ]);
      await flush();
      e.flushTimers();
      // ⚠️ 断言必须点名「复用刚播过的缓冲」这条路径：只写「不重新拉流」的话，
      //   就算补完没进 recentBufs，也会从**字节缓存**重新解码一遍而照样通过（变异体测不出来）。
      ok(countLog(e, "复用刚播过的缓冲（不下载 / 不解码）") >= 1, "★★ 切回来走的是「最近缓冲复用」（不是字节缓存重解码）");
      eq(e.decoded.length, dec0, "★★ 一次解码都没有（真的复用了内存里的那份）");
      eq(e.audio.last.__loads, loads0, "★★ 元素一次 load 都没再调（没有重新拉流）");
    }

    // ---- (b) 只听 5s → 不补（不为「路过」付一次下载） ----
    {
      const e = streamEnv();
      await streamPlay(e, idOf(1000), "http://cdn.example/s3.flac");
      e.advance(5000);
      const f0 = e.fetchLog.length;
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[promote]"), 0, "★★ 不到 8s → 完全不补");
      eq(e.fetchLog.length, f0, "★★ 一个字节都没多下");
    }

    // ---- (c) 逃生开关 ----
    {
      const e = streamEnv();
      e.win.__gpPromote = false;
      await streamPlay(e, idOf(1000), "http://cdn.example/s4.flac");
      e.advance(9000);
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[promote]"), 0, "★★ __gpPromote=false → 不补");
    }

    // ---- (d) 缓冲路径不参与（它本来就有 AudioBuffer） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush();
      e.advance(9000);
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[promote]"), 0, "★★ 缓冲路径已经在 recentBufs 里了，不用补");
    }

    // ---- (e) 3.x 试听片段 → 绝不把「半首」塞进缓存 ----
    {
      const BODY = { data: [{ url: "http://cdn.example/clip.mp3", br: 320000, size: 8200000, type: "mp3" }] };
      const e = env3x(BODY, 205000); // 权威时长 205s，而解码出来只有 200s → 片段
      delete e.win.__gpStream; // 走流式才谈得上「补成缓冲」
      e.eapi.available = false;
      await streamPlay(e, idOf(1000), "http://cdn.example/s5.mp3");
      e.advance(9000);
      e.tick();
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "试听片段"), "★★ 片段被识别");
      ok(countLog(e, "放弃（不影响播放）｜ track=1000") >= 1, "★★ 宁可不补，也不把半首塞进缓存");
      ok(countLog(e, "★ 已补成缓冲") === 0, "★★ 没有补成");
    }
  }

  section("86. ★★ v1.3.2 交叉曲线可选（对齐客户端 automix 的 crossfade_line）+ 高通扫频 + automix 探针");
  {
    const curveNodes86 = (e) =>
      (e.ctx.__gains || [])
        .map((g) => ({ node: g, ev: g.gain.events.filter((x) => x.type === "curve") }))
        .filter((x) => x.ev.length > 0);
    const isRising86 = (ev) => ev.curve[0] < ev.curve[ev.curve.length - 1];
    const pickRising = (e) => {
      const n = curveNodes86(e).find((x) => isRising86(x.ev[0]));
      return n ? n.ev[0].curve : null;
    };

    // ---- (a) 曲线预设 ----
    {
      // 默认：等功率（中点 ≈ 0.707）
      const e0 = await seamlessEnv("playorder");
      e0.win.__gpXfade = 3;
      setLeft(e0, 3.2);
      e0.tick();
      await flush();
      e0.flushTimers();
      const cEq = pickRising(e0);
      ok(!!cEq && Math.abs(cEq[Math.floor(cEq.length / 2)] - 0.707) < 0.05, "★★ 默认 equal：中点 ≈ 0.707");
      ok(countLog(e0, "曲线=equal") >= 1, "★★ 日志写出曲线名");

      // linear：中点 ≈ 0.5
      const e1 = await seamlessEnv("playorder");
      e1.win.__gpXfade = 3;
      e1.win.__gpXfadeCurve = "linear";
      setLeft(e1, 3.2);
      e1.tick();
      await flush();
      e1.flushTimers();
      const cLin = pickRising(e1);
      ok(!!cLin && Math.abs(cLin[Math.floor(cLin.length / 2)] - 0.49) < 0.06, "★★ linear：中点 ≈ 0.5");
      ok(countLog(e1, "曲线=linear") >= 1, "★★ 日志写明曲线=linear");

      // s-line（smoothstep）：x≈0.25 处应当明显低于等功率的 0.38
      const e2 = await seamlessEnv("playorder");
      e2.win.__gpXfade = 3;
      e2.win.__gpXfadeCurve = "s-line";
      setLeft(e2, 3.2);
      e2.tick();
      await flush();
      const cS = pickRising(e2);
      ok(!!cS && cS[16] < 0.25, "★★ s-line：前段压得比等功率低（x≈0.25 时 " + (cS ? cS[16].toFixed(3) : "?") + "）");

      // step：中点前是 0、之后是 1
      const e3 = await seamlessEnv("playorder");
      e3.win.__gpXfade = 3;
      e3.win.__gpXfadeCurve = "step";
      setLeft(e3, 3.2);
      e3.tick();
      await flush();
      const cStep = pickRising(e3);
      ok(!!cStep && cStep[10] === 0 && cStep[54] === 1, "★★ step：前半 0、后半 1（硬切式）");
    }

    // ---- (b) 高通扫频（DJ 过渡的招牌手法） ----
    {
      const e = await seamlessEnv("playorder");
      e.win.__gpXfade = 3;
      e.win.__gpXfadeEq = true;
      setLeft(e, 3.2);
      e.tick();
      await flush();
      e.flushTimers();
      const filters = (e.ctx.__filters || []).filter((f) => f.frequency.events.some((x) => x.type === "ramp"));
      eq(filters.length, 1, "★★ 只有 A 那一路被扫频（B 不动）");
      const evs = filters.length ? filters[0].frequency.events : [];
      const setEv = evs.find((x) => x.type === "set");
      const rampEv = evs.find((x) => x.type === "ramp");
      eq(setEv && setEv.v, 20, "★★ 从 20Hz（直通）起");
      eq(rampEv && rampEv.v, 900, "★★ 扫到 900Hz");
      ok(!!rampEv && Math.abs(rampEv.t - (200.02 - 3 + 3)) < 0.05, "★★ 扫频时长 = 交叉时长");
      ok(countLog(e, "+扫频") >= 1, "★★ 日志标出「+扫频」");

      // 撤销（暂停）后必须复位 —— 否则这一首会一直闷着
      e.channel.call("audioplayer.pause", null, []);
      await flush();
      eq(filters.length ? filters[0].frequency.value : -1, 20, "★★ 暂停后高通复位到 20Hz（不再闷）");
    }

    // ---- (c) 默认不扫频（会改音色，得用户自己开） ----
    {
      const e = await seamlessEnv("playorder");
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      e.tick();
      await flush();
      e.flushTimers();
      const ramps = (e.ctx.__filters || []).filter((f) => f.frequency.events.some((x) => x.type === "ramp"));
      eq(ramps.length, 0, "★★ __gpXfadeEq 没开 → 一条扫频都不排");
      eq(countLog(e, "+扫频"), 0, "★★ 日志里也不会写 +扫频");
    }

    // ---- (d) automix 探针：默认不打扰，开了才记（含「参数形状变了」） ----
    {
      const eOff = createEnv();
      eOff.boot();
      await flush();
      eOff.channel.call("abtest.getList", () => {}, [{ list: [{ name: "AutomixEffectConfig0922" }] }]);
      eOff.flushTimers();
      eq(countLog(eOff, "[probe]"), 0, "★★ 默认关：一条探针日志都不写");

      const eOn = createEnv({
        onNative(name, cb) {
          if (name === "abtest.getList" && typeof cb === "function") {
            cb({ code: 200, data: { automixEffect: { enable: 1 } } });
          }
        },
      });
      eOn.win.__gpProbe = true;
      eOn.boot();
      await flush();
      eOn.channel.call("abtest.getList", () => {}, [{ list: [{ name: "AutomixEffectConfig0922" }] }]);
      eOn.flushTimers();
      ok(countLog(eOn, "[probe] abtest.getList ｜") >= 1, "★★ 记下了 AB 请求的参数形状（能看出有没有问 AutomixEffectConfig0922）");
      ok(countLog(eOn, "[probe] abtest.getList ←") >= 1, "★★ 也记下了回应（AB 到底有没有下发）");
      ok(countLog(eOn, "automixEffect") >= 1, "★★ 回应里出现 automixEffect 字样");

      // 同形状只记一次；形状一变就再记一次（这是「客户端开始塞计划字段」的探测器）
      eOn.channel.call("audioplayer.load", () => {}, ["a", { musicurl: "http://x/a.mp3" }]);
      eOn.channel.call("audioplayer.load", () => {}, ["a", { musicurl: "http://x/a.mp3" }]);
      eOn.flushTimers();
      eq(countLog(eOn, "[probe] audioplayer.load ｜"), 1, "★★ 同一形状只记一次（不刷屏）");
      eOn.channel.call("audioplayer.load", () => {}, [
        "a",
        { musicurl: "http://x/a.mp3", mix_strategy: "strategy_crossfade", crossfade_start_time: 1234 },
      ]);
      eOn.flushTimers();
      eq(countLog(eOn, "[probe] audioplayer.load ｜"), 2, "★★ 形状变了 → 再记一次");
      ok(countLog(eOn, "[probe] audioplayer.load ｜ ★ 形状变了") >= 1, "★★ 明确标出「形状变了」");
      ok(countLog(eOn, "mix_strategy:str(") >= 1, "★★ 新字段（mix_strategy）一眼可见 —— 这就是 automix 接上时的信号");
    }
  }

  section("87. ★★★ v1.3.3 autoplay 兜底：不带启动参数也不用点播放（先让原生播，第一次点按后接管）");
  {
    // ---- (a) ctx 卡在 suspended → 开机不按住原生，音频命令整条放行 ----
    const e = createEnv({ suspended: true });
    e.boot();
    await flush();
    e.flushTimers();
    ok(countLog(e, "[autoplay] ★ AudioContext 起不来") >= 1, "★★ 识别出 autoplay 被挡（ctx=suspended）");
    eq(
      e.startupCalls.some((c) => c.name === "audioplayer.pause"),
      false,
      "★★ 开机**没有**按住原生播放器（否则就没声了）"
    );
    ok(countLog(e, "已挂上「第一次点按」监听") >= 1, "★★ 挂上了「第一次点按」监听");

    // 客户端自己自动播 → 命令放行给原生（我们不拦、也就不下载）
    streamLoad(e, "1000_1_3136952023", "http://cdn.example/auto.flac");
    await flush();
    e.flushTimers();
    ok(
      e.nativeCalls.some((c) => c.name === "audioplayer.load"),
      "★★ 自动播的 load 被放行给原生（这一首由原生播，用户不用点播放）"
    );
    eq(e.fetchLog.length, 0, "★★ 我们一行都没下载（没有接管）");
    eq(countLog(e, "[cmd] ▶ load"), 0, "★★ 也没进我们的 load 分支");

    // 契约自答必须让位给原生（否则会答「播到 0 秒」把客户端骗了）
    const pt = [];
    e.channel.call("audioplayer.getPlayedTime", (r) => pt.push(r), [{ playId: "1000_1_3136952023" }]);
    eq(pt.length, 0, "★★ getPlayedTime 没有自答（原生死扛阶段交给原生）");
    ok(
      e.nativeCalls.some((c) => c.name === "audioplayer.getPlayedTime"),
      "★★ 放行到了原生"
    );

    // ---- (b) 第一次点按 → 拉起 ctx + 交回引擎；下一次 load 由我们播 ----
    e.fireGesture();
    await flush();
    e.flushTimers();
    eq(e.ctx.state, "running", "★★ 手势后 AudioContext 被 resume（state=running）");
    ok(countLog(e, "★ 交回 Web Audio 引擎") >= 1, "★★ 交回我们的引擎");

    const f0 = e.fetchLog.length;
    e.channel.call("audioplayer.load", null, [
      "2000_1_3136952023-x",
      { songId: 2000, musicurl: "http://cdn.example/takeover.flac" },
    ]);
    await flush();
    await flush();
    e.flushTimers();
    ok(countLog(e, "[cmd] ▶ load") >= 1, "★★ 接管后 load 被我们拦下");
    ok(e.fetchLog.length > f0, "★★ 走了我们自己的链路（下载 + 解码）");
    ok(
      e.nativeCalls.some((c) => c.name === "audioplayer.pause"),
      "★★ 接管时先把原生按住（否则双声）"
    );

    // ---- (c) 正常启动（ctx=running，比如带了启动参数）→ 行为完全不变 ----
    const e2 = createEnv();
    e2.boot();
    await flush();
    e2.flushTimers();
    eq(countLog(e2, "[autoplay] ★ AudioContext 起不来"), 0, "★★ ctx 能起时不会有兜底日志");
    eq(
      e2.startupCalls.some((c) => c.name === "audioplayer.pause"),
      true,
      "★★ 照旧开机就按住原生"
    );
    streamLoad(e2, "1000_1_3136952023", "http://cdn.example/normal.flac");
    await flush();
    e2.flushTimers();
    ok(countLog(e2, "[cmd] ▶ load") >= 1, "★★ 照旧由我们接管");
  }

  section("88. ★★★ v1.4.0 过渡风格智能默认 + 状态行 + 设置面板 API");
  {
    const api = (e) => e.win.gaplessPlayer;

    // ---- (a) 智能默认：随机 → 轻过渡；顺序 → 干净 ----
    {
      const eRand = await seamlessEnv("playrandom");
      const x1 = api(eRand).xfade();
      eq(x1.source, "auto:light", "★★ 随机播放 → 智能默认「轻过渡」（source=auto:light）");
      eq(x1.sec, 2.5, "★★ 轻过渡 = 2.5s");
      eq(x1.curve, "equal", "★★ 轻过渡用等功率");
      eq(x1.eq, false, "★★ 轻过渡不扫频");

      const eSeq = await seamlessEnv("playorder");
      const x2 = api(eSeq).xfade();
      eq(x2.source, "auto:clean", "★★ 顺序播放 → 智能默认「干净」（source=auto:clean）");
      eq(x2.sec, 0, "★★ 干净 = 0s（采样级无缝）");
    }

    // ---- (b) 用户选风格 → 立刻生效并记住 ----
    {
      const e = await seamlessEnv("playorder");
      eq(api(e).xfade().sec, 0, "（前提）顺序播放默认不交叉");
      ok(api(e).setStyle("dj") === true, "★★ setStyle('dj') 成功");
      const x = api(e).xfade();
      eq(x.source, "style:dj", "★★ 变成 style:dj");
      eq(x.sec, 3, "★★ DJ = 3s");
      eq(x.curve, "s-line", "★★ DJ 用 s-line 曲线");
      eq(x.eq, true, "★★ DJ 打开高通扫频");
      eq(String(e.localStorage.getItem("gaplessPlayer.style")), "dj", "★★ 风格被记住（重启后还在）");

      // 关掉风格（改回干净）
      api(e).setStyle("clean");
      eq(api(e).xfade().sec, 0, "★★ 切回「干净」= 0s");
    }

    // ---- (c) 显式时长 > 风格（老开关仍然优先级最高） ----
    {
      const e = await seamlessEnv("playorder");
      api(e).setStyle("dj");
      e.win.__gpXfade = 6; // 显式 6s
      const x = api(e).xfade();
      eq(x.source, "explicit", "★★ 显式设过时长 → source=explicit");
      eq(x.sec, 6, "★★ 显式 6s 覆盖风格的 3s");
      eq(String(e.localStorage.getItem("gaplessPlayer.xfade")), "6", "★★ 显式时长也会记住");
    }

    // ---- (d) 状态行：回答「谁在播 / 过渡怎么定的 / 缓存与命中率」 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000); // 预载命中一次 → 命中率应有数
      e.flushTimers();
      const st = api(e).status();
      ok(st.indexOf("引擎=") === 0, "★★ 状态行以「引擎=」开头（" + st.slice(0, 40) + "…）");
      ok(st.indexOf("过渡=") > 0, "★★ 有过渡信息（含来源）");
      ok(st.indexOf("缓存=") > 0, "★★ 有缓存占用");
      ok(/预载命中=\d+%/.test(st), "★★ 有预载命中率（" + st.slice(st.indexOf("预载命中")) + "）");
      ok(countLog(e, "[status] ") >= 1, "★★ 启动时也往日志里写一行状态");
    }

    // ---- (e) 清缓存 + 面板在没有 DOM 时安静跳过 ----
    {
      const e = await seamlessEnv("playorder");
      ok((e.ctx.__gains || []).length > 0, "（前提）已经在播");
      const n = api(e).clearCache();
      eq(typeof n, "number", "★★ clearCache 返回清掉的条数");
      eq(api(e).openPanel(), false, "★★ 没有 document（验证台）时 openPanel 安静返回 false，不抛错");
      e.flushTimers();
      ok(countLog(e, "[ui] ★ 打不开面板") + countLog(e, "[ui] 已清空缓存") >= 1, "★ 至少记了一行 UI 日志");
    }
  }

  section("89. ★★★ v1.5.0 拍点分析（无变速版 Automix 的地基）");
  {
    /**
     * 合成一条「节拍轨」：在指定 BPM / 相位上放短促的打击脉冲。
     * 用它的意义：节拍是**已知真值**，可以断言检测结果对不对（真机曲目没法当基准）。
     */
    function mkClick(opts) {
      const sr = opts.sr || 8000;
      const bpm = opts.bpm;
      const secs = opts.secs || 20;
      const phase = opts.phase || 0;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      const beat = 60 / bpm;
      for (let t = phase; t < secs; t += beat) {
        const at = Math.round(t * sr);
        // 30ms 的衰减脉冲（模拟鼓点）
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      // 铺一点很轻的低频（更接近真实曲目，不至于只剩脉冲）
      for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData() {
          return data;
        },
      };
    }

    // ---- (a) BPM 检测：120 / 90 / 150 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      ok(!!api && typeof api.beat === "function", "★★ 暴露了 gaplessPlayer.beat()（诊断/脚本用）");

      const g120 = api.beat(mkClick({ bpm: 120 }), 0, 20);
      ok(!!g120, "★★ 120 BPM 能算出网格");
      ok(Math.abs(g120.bpm - 120) < 3, "★★ 120 BPM 检测准（实际 " + (g120 ? g120.bpm.toFixed(1) : "?") + "）");
      ok(g120 && g120.conf > 0.3, "★★ 置信度够高（" + (g120 ? g120.conf.toFixed(2) : "?") + "）");

      const beat120 = 60 / 120;
      const off = g120 ? Math.abs(g120.anchorSec % beat120) : 1;
      ok(Math.min(off, beat120 - off) < 0.06, "★★ 锚点落在拍点上（误差 " + (off * 1000).toFixed(0) + "ms 内）");

      const g90 = api.beat(mkClick({ bpm: 90 }), 0, 20);
      ok(g90 && Math.abs(g90.bpm - 90) < 3, "★★ 90 BPM（实际 " + (g90 ? g90.bpm.toFixed(1) : "?") + "）");

      const g150 = api.beat(mkClick({ bpm: 150 }), 0, 20);
      ok(g150 && Math.abs(g150.bpm - 150) < 4, "★★ 150 BPM（实际 " + (g150 ? g150.bpm.toFixed(1) : "?") + "）");

      const gOff = api.beat(mkClick({ bpm: 120, phase: 0.25 }), 0, 20);
      const relOff = gOff ? (gOff.anchorSec - 0.25) % beat120 : 9;
      ok(
        gOff && (Math.abs(relOff) < 0.06 || Math.abs(relOff - beat120) < 0.06),
        "★★ 相位 0.25s 的拍点也能对上（误差 " + (gOff ? (relOff * 1000).toFixed(0) : "?") + "ms）"
      );
    }

    // ---- (b) 没有节拍（静音）→ 不该硬报一个 BPM ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const n = 8000 * 20;
      const flat = {
        duration: 20,
        sampleRate: 8000,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => new Float32Array(n),
      };
      const g = e.win.gaplessPlayer.beat(flat, 0, 20);
      ok(g === null || g.conf < 0.2, "★★ 静音 → 不给网格/置信度极低（" + (g ? "conf=" + g.conf.toFixed(2) : "null") + "）");

      // ★ 噪声：有能量但**没有节拍**。这才是「置信度不可信」的真正考验 ——
      //   数字静音的 onset 全是 0 会提前返回 null，测不出置信度公式的对错。
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff - 0.5;
      };
      const noise = new Float32Array(n);
      for (let i = 0; i < n; i++) noise[i] = rnd() * 0.4;
      const gn = e.win.gaplessPlayer.beat(
        { duration: 20, sampleRate: 8000, numberOfChannels: 1, length: n, getChannelData: () => noise },
        0,
        20
      );
      ok(
        gn === null || gn.conf < 0.45,
        "★★ 白噪声（无节拍）→ 置信度必须低，不许当「有拍」（" + (gn ? "conf=" + gn.conf.toFixed(2) : "null") + "）"
      );
      // 噪声偶尔也能凑出个「还行」的自相关峰（可能落到 smart 档，只影响 ≤半拍的起点位移，无害）；
      // 但绝不该判成 full —— full 要求置信 ≥0.45，这条同时也守住「置信度不能造假」。
      const pn = gn ? e.win.gaplessPlayer.mixPlan(gn, gn) : { tier: "plain" };
      eq(
        pn.tier === "full",
        false,
        "★★ 噪声网格不能判成 full（tier=" + (pn && pn.tier) + "，conf=" + (gn ? gn.conf.toFixed(2) : "null") + "）"
      );
    }

    // ---- (c) 判定档位：偏差小的才做拍点对齐 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      const mk = (bpm, conf) => ({ bpm: bpm, beatSec: 60 / bpm, anchorSec: 0, conf: conf });

      const p1 = api.mixPlan(mk(120, 0.8), mk(120, 0.8));
      eq(p1.tier, "full", "★★ 120 vs 120、置信高 → full");
      eq(Math.round(p1.dev * 1000) / 1000, 0, "★★ 偏差 0");

      const p2 = api.mixPlan(mk(120, 0.8), mk(123, 0.8));
      eq(p2.tier, "full", "★★ 120 vs 123（差 2.4%）→ 仍算同步，full");

      const p3 = api.mixPlan(mk(120, 0.8), mk(150, 0.8));
      eq(p3.tier, "plain", "★★ 120 vs 150（差 20%）→ plain，不硬对齐");

      const p4 = api.mixPlan(mk(120, 0.15), mk(120, 0.8));
      eq(p4.tier, "plain", "★★ 置信太低（0.15）→ plain");

      const p5 = api.mixPlan(mk(120, 0.8), mk(60, 0.8));
      eq(p5.tier, "full", "★★ 八度折算：120 vs 60 视为同步 → full");

      const p6 = api.mixPlan(null, mk(120, 0.8));
      eq(p6.tier, "plain", "★★ 缺一侧网格 → plain");

      const snap = api.snapToBeat(mk(120, 0.8), 0.7); // 拍点 0 / 0.5 / 1.0 …
      ok(
        Math.abs(snap.pos - 0.5) < 0.02 || Math.abs(snap.pos - 1.0) < 0.02,
        "★★ 0.7s 被吸到最近拍（" + snap.pos.toFixed(3) + "）"
      );
    }

    // ---- (d) 接到调度上：解码后就分析、调度时有判定、不崩 ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkClick({ bpm: 120, secs: 200 }) } });
      e.win.__gpXfade = 3; // 开交叉才会走到拍点对齐
      ok(countLog(e, "｜ 头窗") + countLog(e, "｜ 尾窗") >= 1, "★★ 解码后就分析了拍点（头/尾窗口）");
      setLeft(e, 3.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[automix] A=") >= 1, "★★ 调度时打出 automix 判定");
      ok(countLog(e, "120.0bpm") >= 1, "★★ 判定里能看到 A 的 120 BPM");
      ok(countLog(e, "拍点对齐") >= 1, "★★ 交叉起点被吸到了拍点上（" + (e.logs().match(/拍点对齐[^｜|]*/) || ["?"])[0].trim() + "）");
      const lp = e.win.gaplessPlayer.lastPlan();
      ok(!!lp && typeof lp.tier === "string", "★★ lastPlan() 能取到（" + (lp ? lp.tier : "?") + "）");
    }
  }

  section("90. ★★★ v1.5.1 B 的入点（跳过前奏/空白，落在拍上）");
  {
    /** 带「开头静音」的节拍轨（模拟前奏里的空气声） */
    function mkClickGap(opts) {
      const sr = opts.sr || 8000;
      const bpm = opts.bpm;
      const secs = opts.secs || 20;
      const gap = opts.gap || 0;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      const beat = 60 / bpm;
      for (let t = gap; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      return {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
    }

    // ---- (a) 直接测选点：贴拍不跳、离拍就跳到第一拍、空白优先跳、超上限不跳 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      ok(typeof api.pickup === "function", "★★ 暴露了 gaplessPlayer.pickup()");
      const bt = { start: 0.013, end: 0 };
      const noData = { duration: 200, sampleRate: 8000, numberOfChannels: 1, length: 1, getChannelData: null };

      // 锚点 0（拍在 0 / 0.5 / 1.0…），起点 0.013 本来就贴着拍 → 不该跳
      const r1 = api.pickup({ bpm: 120, beatSec: 0.5, anchorSec: 0, conf: 0.9 }, bt, 200, noData);
      ok(r1.skip < 0.02, "★★ 起点本来就贴着拍 → 不跳（skip=" + (r1.skip * 1000).toFixed(0) + "ms）");

      // 锚点 0.25（拍在 0.25 / 0.75…）→ 应跳到 0.25
      const r2 = api.pickup({ bpm: 120, beatSec: 0.5, anchorSec: 0.25, conf: 0.9 }, bt, 200, noData);
      ok(Math.abs(r2.offset - 0.25) < 0.02, "★★ 离拍 0.24s → 跳到第一拍（offset=" + r2.offset.toFixed(3) + "）");
      eq(r2.reason, "对齐到第一拍", "★★ 理由写清楚了");

      // 开头 1.5s 空白 → 优先跳过空白
      const gapBuf = mkClickGap({ bpm: 120, gap: 1.5 });
      const r3 = api.pickup({ bpm: 120, beatSec: 0.5, anchorSec: 1.5, conf: 0.9 }, bt, 200, gapBuf);
      ok(r3.skip > 1.3, "★★ 开头 1.5s 空白 → 跳过去（skip=" + r3.skip.toFixed(2) + "s）");
      ok(r3.skip < 1.9, "★★ 但只跳到空白之后的第一拍，不多吃");
      ok(/空白/.test(r3.reason), "★★ 日志理由写明「空白」");

      // 空白 8s > 上限 6s → 放弃跳
      const bigGap = mkClickGap({ bpm: 120, gap: 8, secs: 20 });
      const r4 = api.pickup({ bpm: 120, beatSec: 0.5, anchorSec: 8, conf: 0.9 }, bt, 200, bigGap);
      eq(r4.skip, 0, "★★ 空白比上限还长 → 不硬跳（不吃歌）");
      ok(/上限|拍/.test(r4.reason), "★★ 理由写清楚了（" + r4.reason + "）");

      // 没有网格 → 原样返回
      const r5 = api.pickup(null, bt, 200, noData);
      eq(r5.skip, 0, "★★ 没有拍点网格 → 不跳");
    }

    // ---- (b) 接到调度上：B 跳过前奏、进来源改动、进度从入点开始 ----
    {
      const e = await seamlessEnv("playorder", {
        hooks: { decode: () => mkClickGap({ bpm: 120, gap: 1.2, secs: 200 }) },
      });
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      const n0 = e.started.length;
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[automix] B 入点") >= 1, "★★ 调度时打出了 B 入点");
      eq(e.started.length, n0 + 1, "（前提）排上了 B");
      const s = lastOf(e.started);
      ok(Number(s.off) > 1.0, "★★ B 从空白之后进场（off=" + Number(s.off).toFixed(2) + "s）");
      ok(Number(s.dur) < 199, "★★ 可播时长相应变短（dur=" + Number(s.dur).toFixed(1) + "s）");
      ok(countLog(e, "B入点=+") >= 1, "★★ [sched] 那行也带上了入点");

      // 交接后进度要从入点开始，而不是从 0 跳回
      e.ctx.currentTime = 200.02;
      enderOf(e.started, 0)();
      await flush();
      // live 窗口期间进度是被刻意抑制的（UI 还没 load）→ 先让 UI 认领，再看进度
      e.channel.call("audioplayer.load", null, [
        "2000_1_3136952023-x",
        { songId: 2000, musicurl: "http://cdn.example/seam2.flac" },
      ]);
      await flush();
      e.tick();
      await flush();
      e.flushTimers();
      const prog = e.last("PlayProgress"); // 事件名是去掉 `audioplayer.on` 之后的
      const pos = Number(argAt(prog, 1));
      // 期望 pos ≈ 交叉时长(3s) + 入点(≈1.2s)；丢掉入点的话会正好是 3.0s
      ok(pos > 3.4, "★★ 交接后进度从入点开始（pos=" + pos.toFixed(2) + "s ≈ 3 + 入点，不是 3）");
    }

    // ---- (c) 干净风格（没有交叉）也跳过 B 开头的空白，但不做拍点对齐 ----
    {
      const e = await seamlessEnv("playorder", {
        hooks: { decode: () => mkClickGap({ bpm: 120, gap: 1.2, secs: 200 }) },
      });
      eq(e.win.gaplessPlayer.xfade().sec, 0, "（前提）顺序播放 + 智能默认 = 干净风格（0s 交叉）");
      setLeft(e, 1.0); // 0s 交叉时预约窗口更窄（winMax=1.5）
      const n1 = e.started.length;
      e.tick();
      await flush();
      e.flushTimers();
      eq(e.started.length, n1 + 1, "（前提）照常预约了 B");
      ok(countLog(e, "[automix] B 入点") >= 1, "★★ 没有交叉时也会选入点");
      ok(countLog(e, "开头空白") >= 1, "★★ 只跳空白，不做拍点对齐");
      const s2 = lastOf(e.started);
      ok(Number(s2.off) > 1.0, "★★ B 从空白之后开始（off=" + Number(s2.off).toFixed(2) + "s）");
      ok(Number(s2.dur) < 199, "★★ 可播时长相应变短（dur=" + Number(s2.dur).toFixed(1) + "s）");
    }
  }

  section("91. ★★★ v1.5.2 设置面板（自绘 DOM / 分段控件 / 拨动开关）");
  {
    /* 极简假 DOM：只覆盖面板真正用到的那点 API（appendChild / className / textContent / onclick…） */
    function makeDoc() {
      function node(tag) {
        const n = {
          tagName: tag,
          className: "",
          textContent: "",
          value: "",
          checked: false,
          children: [],
          attrs: {},
          _parent: null,
          appendChild(c) {
            c._parent = n;
            n.children.push(c);
            return c;
          },
          removeChild(c) {
            n.children = n.children.filter((x) => x !== c);
            if (c) c._parent = null;
            return c;
          },
          setAttribute(k, v) {
            n.attrs[k] = v;
          },
          get lastChild() {
            return n.children[n.children.length - 1] || null;
          },
          get parentNode() {
            return n._parent;
          },
        };
        return n;
      }
      const body = node("body");
      const head = node("head");
      return { body, head, createElement: node, querySelector: () => null };
    }

    const doc = makeDoc();
    const e = createEnv({ document: doc });
    e.boot();
    await flush();
    e.flushTimers();

    // ---- 右下角按钮 + 样式只注入一次 ----
    eq(doc.body.children.length, 1, "★★ 右下角按钮注入（1 个元素）");
    eq(doc.body.children[0].className, "gp-fab", "★★ 用的是新的圆角图标按钮");
    eq(String(doc.body.children[0].textContent), "♪", "★★ 图标是 ♪");
    eq(doc.head.children.length, 1, "★★ 面板样式注入到 head");
    const css = String((doc.head.children[0] || {}).textContent || "");
    ok(css.indexOf(".gp-card") >= 0 && css.indexOf(".gp-sw") >= 0, "★★ 样式里有卡片与拨动开关");
    ok(css.indexOf(".gp-seg>button.on") >= 0, "★★ 分段控件的选中态样式也在");

    const api = e.win.gaplessPlayer;
    eq(api.openPanel(), true, "★★ openPanel() 打开面板");
    eq(doc.body.children.length, 2, "★★ 卡片挂到 body");
    const card = doc.body.children[1] || { children: [], className: "", textContent: "" };
    eq(card.className, "gp-card", "★★ 卡片类是 gp-card");
    eq(doc.body.children[0].className, "gp-fab on", "★★ 打开时按钮高亮");
    eq(doc.head.children.length, 1, "★★ 样式不重复注入");

    const walk = (n, out) => {
      out.push(n);
      (n.children || []).forEach((c) => walk(c, out));
      return out;
    };
    const all = walk(card, []);
    const texts = all.map((n) => String(n.textContent || "")).join("|");
    ok(/GaplessPlayer/.test(texts) && /1\.5\.2/.test(texts), "★★ 标题带版本号");
    ok(/引擎=/.test(texts), "★★ 状态行在面板里");
    ok(/拍点=开/.test(texts), "★★ 状态行直接显示「拍点=开」（默认就是开的）");
    ok(/过渡风格/.test(texts) && /播放行为/.test(texts) && /缓存/.test(texts), "★★ 分了三个区（过渡/行为/缓存）");
    ok(/诊断/.test(texts), "★★ 诊断还是折叠的");

    // ---- 分段控件：点 DJ 立刻生效并高亮 ----
    const segBtns = all.filter(
      (n) => n.tagName === "button" && ["干净", "轻过渡", "DJ"].indexOf(String(n.textContent)) >= 0
    );
    eq(segBtns.length, 3, "★★ 三个风格按钮（分段控件）");
    segBtns[2].onclick();
    eq(api.xfade().source, "style:dj", "★★ 点 DJ → 立刻生效");
    eq(segBtns[2].className, "on", "★★ 选中的那个高亮");
    eq(segBtns[0].className, "", "★★ 其余不高亮");

    // ---- 拨动开关：拍点对齐默认开，点一下关、再点开 ----
    const toggles = all.filter((n) => /^gp-sw/.test(n.className));
    ok(toggles.length >= 4, "★★ 拨动开关若干（" + toggles.length + " 个）");
    // 按「行的标签」定位开关（顺序不可靠：扫频开关在行为开关之前）
    const rowOf = (label) =>
      all.filter(
        (n) => n.className === "gp-row" && n.children[0] && String(n.children[0].textContent) === label
      )[0];
    const beatRow = rowOf("拍点对齐") || { children: [] };
    const beatSw = beatRow.children[1] || { className: "", onclick() {} };
    eq(beatSw.className, "gp-sw on", "★★ 「拍点对齐」那一行的开关默认是开");
    eq(beatSw.className, "gp-sw on", "★★ 「拍点对齐」默认就是开");
    beatSw.onclick();
    eq(e.win.__gpAutoMix, false, "★★ 点一下 → 关");
    eq(beatSw.className, "gp-sw", "★★ 视觉同步（不再是 on）");
    e.flushTimers(); // 日志是攒着写的，断言前得先冲一遍
    ok(countLog(e, "[ui] 拍点对齐 → 关") >= 1, "★★ 有关闭日志");
    beatSw.onclick();
    eq(e.win.__gpAutoMix, true, "★★ 再点一下 → 开");

    // ---- 滑杆：拖一下就是显式时长 ----
    const range = all.filter((n) => n.tagName === "input" && n.className === "gp-range")[0];
    ok(!!range, "★★ 有时长滑杆");
    range.value = "6";
    range.oninput();
    eq(api.xfade().source, "explicit", "★★ 拖滑杆 → 变成显式时长（优先级最高）");
    eq(api.xfade().sec, 6, "★★ 值 = 6s");

    // ---- 再点一次收起 ----
    eq(api.openPanel(), true, "★★ 再调 openPanel() 收起");
    eq(doc.body.children.length, 1, "★★ 卡片被移除");
    eq(doc.body.children[0].className, "gp-fab", "★★ 按钮恢复不高亮");
  }

  /* ---------- 汇总 ---------- */
  console.log("\n====================");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail) {
    console.log("\n失败清单：");
    failures.forEach((f) => console.log("  - " + f));
    // ★ 用 exitCode 而不是 process.exit() —— 这样 test/mutate.js 能**在同进程内**跑我们。
    //   原因：Windows 沙箱里 spawnSync 子进程会 EBUSY，mutate.js 以前那种「开子进程」
    //   跑法整个是空转的（拿不到输出 → 判定恒真 → 假绿灯）。
    process.exitCode = 1;
    return;
  }
  console.log("全部通过 ✅");
}

// ★ 导出这个 promise：test/mutate.js 直接 await 它，不用开子进程。
module.exports = main().catch((e) => {
  console.error("验证台自己崩了：", e);
  process.exitCode = 2;
});
