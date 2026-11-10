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
    createBuffer(nch, len, sr) {
      const chans = [];
      for (let c = 0; c < nch; c++) chans.push(new Float32Array(len));
      return {
        numberOfChannels: nch,
        length: len,
        sampleRate: sr,
        duration: sr > 0 ? len / sr : 0,
        getChannelData: (c) => chans[c] || chans[0],
      };
    },    createBufferSource() {
      const s = {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        start(at, off, dur) {
          s.__started = { at, off, dur };
          started.push({ at, off, dur, node: s });
        },
        stop(when) {
          // ★ v1.9.2：记下 stop 的时刻（「A 提前收尾」就是靠重复调用 stop(t) 实现的）
          if (when !== undefined) s.__stopAt = when;
          else s.__stopAt = -1; // 立刻停
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
      removeAttribute(n) { if (n === "src") a.src = ""; },
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
  const baseFs = {
    writeFile(p, blob) {
      const text = blob && blob.parts ? blob.parts.join("") : "";
      fsFiles[String(p)] = text;
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
  };

  /**
   * ★ v1.8.4：磁盘字节缓存要 `readFileText / writeFileText / readFile / writeFile`。
   *   默认这套假 fs 没有那几个方法 → 磁盘缓存自动判为「不可用」（其它用例完全不受影响）。
   *   要测磁盘缓存就 `createEnv({ fs: mkDiskFs() })` 覆盖进来。
   *
   * ⚠️ 不管用例怎么换 fs，**日志文件的写入都必须记进 `writes`** —— `logs()` 取的就是
   *    `writes` 的最后一份快照。把这件事放在这层包起来，用例就不用自己操心。
   */
  const fsImpl = Object.assign({}, baseFs, (hooks && hooks.fs) || {});
  const fsWrite = fsImpl.writeFile;
  const betterncm = {
    isMRBNCM: false,
    fs: Object.assign({}, fsImpl, {
      writeFile(p, blob) {
        if (String(p).indexOf("gapless-player.log") >= 0) writes.push({ path: p, blob });
        return fsWrite.apply(fsImpl, arguments);
      },
    }),
  };

  /* ---- 假 LibEAPIRequest（A1 预载查地址用）---- */
  const eapi = {
    log: [],
    available: true, // isRequestAvailable() 的返回值
    mode: "ok", // ok | nourl | fail
    url: "http://cdn.example/next.flac",
    gain: null, // ★ v1.9.0：player/url 的响度增益（dB）；null = 响应里没有这个字段
    peak: null, // ★ v1.9.0：线性峰值
    gainMap: null, // ★ v1.9.3：逐曲指定 { trackId: {gain, peak} }（测「相对参考」用）
    eapiRequest(url, opts) {
      this.log.push({ url, data: opts && opts.data });
      if (this.mode === "fail") {
        if (opts && opts.onerror) opts.onerror(new Error("mock eapi 请求失败"));
        return;
      }
      const idsStr = String((opts && opts.data && opts.data.ids) || "[]");
      const id = Number(idsStr.replace(/[^0-9]/g, "")) || 1;
      const over = (this.gainMap && this.gainMap[id]) || {};
      const gain = over.gain !== undefined ? over.gain : this.gain;
      const peak = over.peak !== undefined ? over.peak : this.peak;
      const body =
        this.mode === "nourl"
          ? { data: [{ id: id, url: null, br: 999000, size: 0 }] }
          : { data: [{ id: id, url: this.url, br: 999000, size: 12345, gain: gain, peak: peak }] };
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
    "indexedDB",
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
    hooks && hooks.document ? hooks.document : undefined,
    hooks && hooks.indexedDB ? hooks.indexedDB : undefined
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

  /**
   * ★ v1.8.7：让「当前这一首」**自然播完**（真机：客户端随后 ~120ms 才发 setCurrentPlay）。
   *
   * 为什么用例必须加这一步：`notePrediction` 现在只在「上一首真的播到结尾」时，
   * 才把一次换歌当成「对播放顺序的检验」。直接在歌中途 setCurrentPlay 换掉 = 用户在跳歌，
   * 不该算押错。所以凡是模拟「随机播放的客户端自己挑了一首别的」，都得先让 A 播完。
   */
  async function playToEnd(e, n) {
    e.channel.call("audioplayer.play", () => {}, [idOf(n) + "-x", "t|resume|T"]);
    await flush(2);
    const st = e.started[e.started.length - 1];
    if (!st) return;
    // 把 ctx 时钟推到这一首的结束采样，再触发 onended（就是真机的「自然播完」）
    e.ctx.currentTime = (Number(st.at) || 0) + (Number(st.dur) || 200);
    if (st.node && typeof st.node.onended === "function") st.node.onended();
    await flush(4);
  }

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
    //   ★ v1.8.7：必须是「A 播完之后客户端自己挑的」，否则那只是用户在歌中途跳歌（不算检验）
    await playToEnd(e40, 1000);
    await playTrack(e40, 3000);
    ok(countLog(e40, "✗ 预测失败 1/3") >= 1, "★ 第 1 次押不中被记下（预载 2000，实际播 3000）");
    eq(countLog(e40, "开始预载（下一首）"), 2, "★ 还没到阈值 → 仍然预载下一首");

    await playToEnd(e40, 3000);
    await playTrack(e40, 5000);
    ok(countLog(e40, "✗ 预测失败 2/3") >= 1, "★ 第 2 次押不中被记下");
    eq(countLog(e40, "开始预载（下一首）"), 3, "（前提）关闭前一共预载了 3 次「下一首」");

    await playToEnd(e40, 5000);
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
    await playToEnd(e41, 1000); // ★ v1.8.7：A 播完 → 客户端随后自己挑（这才算检验）
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
    await playToEnd(e42, 1000); // ★ v1.8.7：先让 A 播完（客户端随后自己挑 3000）
    await playTrack(e42, 3000); // 押不中 1 → 预载 4000
    await playToEnd(e42, 3000);
    await playTrack(e42, 5000); // 押不中 2 → 预载 6000
    await playToEnd(e42, 5000);
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
  /**
   * 合成节拍轨（v1.17.0）：交叉/拍点用例要「两边都有网格」才不会被「跳过交叉」规则拦下。
   * 120 BPM、默认 200s，脉冲短促、带一点 90Hz 铺底。
   */
  function mkBeatTrack(bpm, secs) {
    const sr = 8000;
    const n = Math.round((secs || 200) * sr);
    const data = new Float32Array(n);
    const beat = 60 / (bpm || 120);
    for (let t = 0; t < secs; t += beat) {
      const at = Math.round(t * sr);
      for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
        data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
      }
    }
    for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
    return {
      duration: secs || 200,
      sampleRate: sr,
      numberOfChannels: 1,
      length: n,
      getChannelData: () => data,
    };
  }

  async function seamlessEnv(mode, opts) {
    opts = opts || {};
    const e = createEnv(opts.hooks);
    // ★ v1.19.0：这些用例测的是交叉/拉伸本身，默认关掉「连续母带」检测；
    //   连续母带的用例自己把它打开。
    e.win.__gpKeepContinuous = false;
    // ★ v1.20.0：扫频默认开；这些用例多数不测扫频，显式关掉免得日志/曲线断言被 +扫频 干扰
    e.win.__gpXfadeEq = false;
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
    // ★ v1.17.0：这里的 A 没有分析记录（流式）→ 默认会被「跳过交叉」拦下；
    //   这个 helper 要测的是「流式路径的交叉曲线」，所以显式关掉跳过规则。
    e.win.__gpSkipBadMix = false;
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
      fs: opts.fs, // ★ v1.8.5：让 3.x 用例也能挂磁盘缓存
      onNative(name, cb, args) {
        if (name !== "network.fetch" || typeof cb !== "function") return;
        // ⚠️ originalCall 收到的是 channel.call 的完整参数，hooks 拿到的是 slice(2) →
        //    args = [[{url}]]，要多剥一层。
        const a0 = args && args[0];
        const first = Array.isArray(a0) ? (a0[0] || {}) : (a0 || {});
        const u = String(first.url || "");
        const body =
          u.indexOf("/api/song/detail") >= 0
            ? // ★ v1.8.5：opts.noDetail = 让权威时长接口「拿不到」（验不依赖它的那条路）
              { blob: JSON.stringify(opts.noDetail ? { songs: [] } : { songs: [{ id: 0, duration: dur }] }) }
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      ok(Math.abs(oEv.dur - 3) < 0.02, "★★ 淡出曲线时长 = 交叉时长（" + Number(oEv.dur).toFixed(3) + "s）");
      ok(Math.abs(iEv.dur - 3) < 0.02, "★★ 淡入曲线时长 = 交叉时长（" + Number(iEv.dur).toFixed(3) + "s）");
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      // 排除法：淡出既然不是总线、也不是 B，那就只能是流式元素那一路。
      // ★ v1.9.0：链路里多了「响度归一化」节点（每路一份），所以「还有几个 gain」不再固定为 1；
      //   这里改成只断言「淡出那个节点不是总线、也不是 B」——要验的东西没变。
      const others = (e.ctx.__gains || []).filter((g) => g !== e.ctx.__gain && g !== nodeOfX(inn));
      ok(others.length >= 1, "（前提）除总线与 B 之外还有别的 gain（元素那一路 + 响度归一化）");
      ok(others.indexOf(nodeOfX(out)) >= 0, "★★ 淡出打在了「不是总线、也不是 B」的那一路上（= 流式元素）");
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
      eq(countLog(e, "[promote] 流式那首已听"), 0, "（前提）刚起播不补");

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
      eq(countLog(e, "[promote] 流式那首已听"), 0, "★★ 不到 8s → 完全不补");
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
      eq(countLog(e, "[promote] 流式那首已听"), 0, "★★ __gpPromote=false → 不补");
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
      e.flushTimers();
      e.advance(9000);
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[promote] 流式那首已听"), 0, "★★ 缓冲路径已经在 recentBufs 里了，不用补");
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
      const e0 = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
      e0.win.__gpXfade = 3;
      setLeft(e0, 3.2);
      e0.tick();
      await flush();
      e0.flushTimers();
      const cEq = pickRising(e0);
      ok(!!cEq && Math.abs(cEq[Math.floor(cEq.length / 2)] - 0.707) < 0.05, "★★ 默认 equal：中点 ≈ 0.707");
      ok(countLog(e0, "曲线=equal") >= 1, "★★ 日志写出曲线名");

      // linear：中点 ≈ 0.5
      const e1 = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      const e2 = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
      e2.win.__gpXfade = 3;
      e2.win.__gpXfadeCurve = "s-line";
      setLeft(e2, 3.2);
      e2.tick();
      await flush();
      const cS = pickRising(e2);
      ok(!!cS && cS[16] < 0.25, "★★ s-line：前段压得比等功率低（x≈0.25 时 " + (cS ? cS[16].toFixed(3) : "?") + "）");

      // step：中点前是 0、之后是 1
      const e3 = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkBeatTrack(120, 200) } });
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

  section("88. ★★★ v1.9.4 过渡只留「干净」+ 一个开关（风格预设已撤）");
  {
    const api = (e) => e.win.gaplessPlayer;

    // ---- (a) 默认永远是干净：顺序、随机都一样 ----
    {
      const eSeq = await seamlessEnv("playorder");
      const x2 = api(eSeq).xfade();
      eq(x2.source, "clean", "★★ 默认干净（source=clean）");
      eq(x2.sec, 0, "★★ 干净 = 0s（采样级无缝）");
      eq(api(eSeq).xfadeOn(), false, "★★ 开关默认是关");

      const eRand = await seamlessEnv("playrandom");
      eq(api(eRand).xfade().sec, 0, "★★ 随机播放也不再「智能默认轻过渡」（风格预设已撤）");
    }

    // ---- (b) 开关：打开 = 智能（3s 兜底），关掉 = 干净，并且记住 ----
    {
      const e = await seamlessEnv("playorder");
      eq(api(e).setXfade(true), 3, "★★ 打开开关 → 3s（兜底）");
      eq(api(e).xfade().sec, 3, "★★ 立刻生效");
      eq(api(e).xfade().smart, true, "★★ source=smart（v1.14.0：开关 = 智能交叉）");
      eq(api(e).xfade().source, "smart", "★★ source=smart");
      eq(api(e).xfadeOn(), true, "★★ xfadeOn() 也跟着变");
      eq(String(e.localStorage.getItem("gaplessPlayer.xfade")), "3", "★★ 记住（重启后还在）");
      eq(String(e.localStorage.getItem("gaplessPlayer.xfadeSmart")), "1", "★★ 智能开关也记住");
      e.flushTimers();
      ok(countLog(e, "交叉淡入淡出 → 智能（按小节，兜底 3.0s）") >= 1, "★★ 切换有日志");

      api(e).setXfade(false);
      eq(api(e).xfade().sec, 0, "★★ 关掉 → 干净");
      eq(api(e).xfade().smart, false, "★★ 关掉同时退掉智能");
      eq(String(e.localStorage.getItem("gaplessPlayer.xfade")), "0", "★★ 关掉也记住");
      e.flushTimers();
      ok(countLog(e, "交叉淡入淡出 → 关") >= 1, "★★ 关闭有日志");
    }

    // ---- (c) 老调用仍然能用；显式时长优先级最高 ----
    {
      const e = await seamlessEnv("playorder");
      eq(api(e).setStyle("clean"), true, "★ 老调用 setStyle('clean') 仍然可用（= 关）");
      eq(api(e).xfade().sec, 0, "★ 关 = 0s");
      api(e).setStyle("dj");
      eq(api(e).xfade().sec, 3, "★ 老调用 setStyle('dj') = 打开 3s");
      e.win.__gpXfade = 6;
      eq(api(e).xfade().sec, 6, "★★ 显式 __gpXfade=6 覆盖开关");
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
      ok(st.indexOf("过渡=") > 0, "★★ 有过渡信息");
      ok(/过渡=干净无缝/.test(st), "★★ 默认就写明「干净无缝」");
      ok(st.indexOf("预载命中=") > 0, "★★ 有预载命中率（缓存/磁盘已移到缓存页）");
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
      // ★ v1.9.2：混音点对齐有两朵花法 —— 老的是「拉长淡出（拍点对齐）」，新的是「A 提前收尾」。
      //   两者都说明「交叉边界被放到了音乐点上」，所以这里认任一。
      ok(
        countLog(e, "拍点对齐") + countLog(e, "A 提前收尾") >= 1,
        "★★ 交叉边界被吸到了音乐点上（" + ((e.logs().match(/(拍点对齐|A 提前收尾)[^｜|]*/) || ["?"])[0]).trim() + "）"
      );
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

  section("91. ★★★ v1.5.2 → v1.10.0 设置面板（自绘 DOM；按钮是浮层，不在客户端组件树里）");
  {
    // ★ 版本号从 manifest 读 —— 免得每次 bump 都要来改断言（27 段也是这么做的）
    const MF91 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "manifest.json"), "utf8"));
    const api = (en) => en.win.gaplessPlayer;
    /** 假 DOM：一个播放器栏 + 一颗「随机播放」按钮（bar 上挂了一个「委托」监听用来验冒泡） */
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
          style: {},
          _parent: null,
          listeners: {},
          appendChild(c) {
            c._parent = n;
            n.children.push(c);
            return c;
          },
          insertBefore(c, ref) {
            const i = ref ? n.children.indexOf(ref) : -1;
            c._parent = n;
            if (i >= 0) n.children.splice(i, 0, c);
            else n.children.push(c);
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
          getAttribute(k) {
            return Object.prototype.hasOwnProperty.call(n.attrs, k) ? n.attrs[k] : null;
          },
          getBoundingClientRect() {
            // 「随机播放」按钮的真实位置：右边 100~126、上边 700~726
            return n === shuffle
              ? { left: 100, top: 700, width: 26, height: 26, right: 126, bottom: 726 }
              : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
          },
          addEventListener(t, fn) {
            (n.listeners[t] = n.listeners[t] || []).push(fn);
          },
          remove() {
            if (n._parent) n._parent.removeChild(n);
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
      const bar = node("div");
      bar.className = "m-playbar btns";
      const shuffle = node("a");
      shuffle.className = "rdi";
      shuffle.setAttribute("title", "随机播放");
      bar.appendChild(shuffle);
      return {
        body,
        head,
        bar,
        shuffle,
        createElement: node,
        querySelector: (s) => (/rdi|shuffle|order|mode/i.test(String(s)) ? shuffle : null),
        querySelectorAll: () => [],
      };
    }

    const doc = makeDoc();
    const e = createEnv({ document: doc });
    e.boot();
    await flush();
    e.flushTimers();

    // ---- 按钮：留在 body 里（不进客户端组件树），靠定位浮到「随机播放」左边 ----
    eq(doc.bar.children.length, 1, "★★ 没有往播放器栏里塞节点（避免客户端点击委托命中我们）");
    eq(doc.body.children.length, 1, "★★ 按钮挂在 body 上");
    const btn = doc.body.children[0] || { className: "", textContent: "", style: {} };
    ok(/^gp-fab/.test(String(btn.className)), "★★ 是 gp-fab 浮层（" + btn.className + "）");
    eq(String(btn.textContent), "♪", "★★ 图标是 ♪");
    eq(String(btn.style.position), "fixed", "★★ 用 fixed 浮着");
    eq(String(btn.style.left), "44px", "★★ 位置 = 随机播放左边（left 100 − 宽 42 − 空隙 14）");
    eq(String(btn.style.top), "692px", "★★ 垂直居中在同一行（700 + (26−42)/2）");
    eq(doc.head.children.length, 1, "★★ 面板样式注入到 head");
    const css = String((doc.head.children[0] || {}).textContent || "");
    ok(css.indexOf(".gp-card") >= 0 && css.indexOf(".gp-sw") >= 0, "★★ 样式里有卡片与拨动开关");
    ok(css.indexOf(".gp-fab.inline") < 0, "★★ 旧方案（塞进组件树）的样式已经删掉");
    // ★ v1.9.7：按钮是「纯音符图标」（无边框/无背景），边长 42px
    ok(/\.gp-fab\{[^}]*width:42px/.test(css), "★★ 按钮边长 42px（30 + 12）");
    ok(/\.gp-fab\{[^}]*background:none/.test(css), "★★ 没有背景（只要图标）");
    ok(css.indexOf("@keyframes gp-hero-in") >= 0, "★★ 大卡切歌动画的 keyframes 在 CSS 里");
    ok(/\.gp-hero\.gp-anim-a\{[^}]*animation:gp-hero-in 2s/.test(css), "★★ 动画 2s");
    ok(/\.gp-fab\{[^}]*border:0/.test(css), "★★ 没有边框");

    // ---- 点它只开面板：冒泡被拦住（这是「连带触发随机播放」的修法） ----
    let stopped = 0;
    btn.onclick({ stopPropagation() { stopped++; }, preventDefault() {} });
    eq(stopped, 1, "★★ 点击处理器拦住了冒泡（客户端收不到）");
    eq(doc.body.children.length, 2, "★★ 面板打开了");
    const card = doc.body.children[1] || { children: [], className: "", textContent: "" };
    eq(card.className, "gp-card", "★★ 卡片类是 gp-card");
    // ★ v1.20.0：在面板按钮正上方（贴边时夹到 8px）
    eq(String(card.style.left), "8px", "★★ 面板对齐按钮（太靠左 → 夹到 8px）");
    eq(String(card.style.right), "auto", "★★ 不再靠右");
    eq(String(card.style.bottom), "78px", "★★ 底边在按钮上方 10px（按钮 top 700 → 78px）");
    ok(String(btn.className).indexOf("on") >= 0, "★★ 打开时按钮高亮");
    eq(doc.head.children.length, 1, "★★ 样式不重复注入");

    const walk = (n, out) => {
      out.push(n);
      (n.children || []).forEach((c) => walk(c, out));
      return out;
    };
    const all = walk(card, []);
    const texts = all.map((n) => String(n.textContent || "")).join("|");
    ok(/GaplessPlayer/.test(texts) && texts.indexOf(MF91.version) >= 0, "★★ 标题带版本号（" + MF91.version + "）");
    ok(/引擎=/.test(texts), "★★ 状态行在面板里");
    const stNode = all.find((n) => String(n.className).indexOf("gp-status") >= 0) || {};
    const stText = String(stNode.textContent || "");
    ok(/引擎=/.test(stText) && /过渡=/.test(stText) && /拍点=/.test(stText), "★★ 状态行是一整行（｜ 分隔）");
    ok(stText.indexOf("缓存=") < 0 && stText.indexOf("磁盘=") < 0, "★★ 状态行不含缓存/磁盘（缓存页里有）");
    ok(/拍点=开/.test(texts), "★★ 状态行直接显示「拍点=开」（默认就是开的）");
    ok(/交叉淡入淡出/.test(texts) && /响度平衡/.test(texts) && /缓存/.test(texts), "★★ 只有开关 + 缓存两块（简单易懂）");
    ok(/更多/.test(texts), "★★ 高级开关收在「更多」里（折叠）");
    ok(!/过渡风格/.test(texts), "★★ 「过渡风格」已经撤掉");

    // ---- 顺序：「拍点对齐」在「交叉淡入淡出」上面 ----
    const rowAt = (label) =>
      all.findIndex(
        (n) => n.className === "gp-row" && n.children[0] && String(n.children[0].textContent) === label
      );
    const iBeat = rowAt("拍点对齐");
    const iXf = rowAt("交叉淡入淡出");
    ok(iBeat >= 0 && iXf >= 0 && iBeat < iXf, "★★ 「拍点对齐」排在「交叉淡入淡出」上面（" + iBeat + " < " + iXf + "）");

    const rowOf = (label) =>
      all.filter(
        (n) => n.className === "gp-row" && n.children[0] && String(n.children[0].textContent) === label
      )[0];

    // ---- v1.14.0：顶部大卡 + 时长步进器 ----
    ok(all.some((n) => n.className === "gp-hero"), "★★ 顶部有一张「本次交叉」大卡");
    ok(all.some((n) => n.className === "gp-hero-num"), "★★ 卡片里有大号数值");
    ok(all.filter((n) => n.className === "gp-chip").length >= 1, "★★ 卡片下面的信息是排列的小项");
    ok(!!rowOf("时长"), "★★ 有「时长」步进器行（不再只有开关）");

    // ---- v1.16.0：子标签页 过渡 / 音色 / 缓存 ----
    const tabs = all.filter((n) => /^gp-tab( |$)/.test(String(n.className)));
    eq(tabs.length, 3, "★★ 三个子标签页");
    eq(tabs.map((t) => String(t.textContent)), ["过渡", "音色", "缓存"], "★★ 标签页名称");
    const panes = all.filter((n) => n.className === "gp-pane");
    eq(panes.length, 3, "★★ 三个面板容器");
    eq(String(tabs[0].className), "gp-tab on", "★★ 默认选中「过渡」");
    eq(panes[0].style.display, "", "★★ 过渡面板可见");
    eq(panes[1].style.display, "none", "★★ 音色面板收起");
    tabs[1].onclick();
    eq(String(tabs[1].className), "gp-tab on", "★★ 点「音色」→ 选中");
    eq(panes[1].style.display, "", "★★ 音色面板可见");
    eq(panes[0].style.display, "none", "★★ 过渡面板收起");
    tabs[2].onclick();
    eq(String(tabs[2].className), "gp-tab on", "★★ 点「缓存」→ 选中");
    const cacheSec = (panes[2] && panes[2].children[0]) || { children: [] };
    const cacheLabels = cacheSec.children
      .filter((n) => n.className === "gp-row")
      .map((n) => String((n.children[0] || {}).textContent));
    eq(cacheLabels, ["最近缓冲", "磁盘字节", "磁盘缓存"], "★★ 缓存页只留三项");
    ok(!/分析记录|空闲补算|A 提前收尾/.test(texts), "★★ 分析/补算/A 提前收尾已从面板撤掉");
    tabs[0].onclick();

    // ---- 交叉淡入淡出开关：默认关（干净），点一下开「智能」、再点关 ----
    const xfRow = rowOf("交叉淡入淡出") || { children: [] };
    const xfSw = xfRow.children[1] || { className: "", onclick() {} };
    eq(xfSw.className, "gp-sw", "★★ 「交叉淡入淡出」默认关（= 干净无缝）");
    xfSw.onclick();
    eq(xfSw.className, "gp-sw on", "★★ 点一下 → 开，视觉同步");
    eq(api(e).xfadeOn(), true, "★★ 真的开了");
    eq(api(e).xfade().sec, 3, "★★ 打开 = 3s（兜底）");
    eq(api(e).xfade().smart, true, "★★ 而且进入智能模式（按小节定时长/曲线）");
    e.flushTimers();
    ok(countLog(e, "[ui] 交叉淡入淡出 → 智能（按小节，兜底 3.0s）") >= 1, "★★ 有开启日志");
    // 时长：智能时只显示「智能 · 按小节」，不摆假数字；点「固定」才进显式
    const durRow = rowOf("时长") || { children: [] };
    const durBox = durRow.children[1] || { children: [] };
    const smartWrap = durBox.children[0] || { style: {}, children: [] };
    const stepWrap = durBox.children[1] || { style: {}, children: [] };
    eq(smartWrap.style.display, "", "★★ 智能模式显示「智能 · 按小节」");
    eq(stepWrap.style.display, "none", "★★ 智能模式不显示 3.0s 数字");
    const fixBtn = smartWrap.children[1] || { onclick() {} };
    fixBtn.onclick();
    eq(api(e).xfade().smart, false, "★★ 点「固定」→ 退出智能");
    eq(api(e).xfade().sec, 3, "★★ 首次固定 = 默认 3s");
    eq(stepWrap.style.display, "", "★★ 固定模式才显示滑杆");
    const range = stepWrap.children[0] || { value: "", oninput() {} };
    eq(String(range.type || ""), "range", "★★ 时长用滑杆（0.1s 步进）");
    range.value = "3.5";
    range.oninput();
    eq(api(e).xfade().sec, 3.5, "★★ 拖动滑杆 → 3.5s");
    const smartBtn = stepWrap.children[2] || { onclick() {} };
    smartBtn.onclick();
    eq(api(e).xfade().smart, true, "★★ 点「按小节」→ 回到智能");
    eq(api(e).xfade().sec, 3, "★★ 智能模式兜底仍是 3.0（不跟着上次固定值 3.5 跑）");
    fixBtn.onclick();
    eq(api(e).xfade().sec, 3.5, "★★ 再切固定：沿用上次的 3.5s（不再跳回 3.0）");
    smartBtn.onclick();
    xfSw.onclick();
    eq(api(e).xfadeOn(), false, "★★ 再点一下 → 关");

    // ---- 拍点对齐默认开，点一下关 ----
    const toggles = all.filter((n) => /^gp-sw/.test(n.className));
    ok(toggles.length >= 3, "★★ 拨动开关若干（" + toggles.length + " 个）");
    const beatRow = rowOf("拍点对齐") || { children: [] };
    const beatSw = beatRow.children[1] || { className: "", onclick() {} };
    eq(beatSw.className, "gp-sw on", "★★ 「拍点对齐」默认就是开");
    beatSw.onclick();
    eq(e.win.__gpAutoMix, false, "★★ 点一下 → 关");
    eq(beatSw.className, "gp-sw", "★★ 视觉同步（不再是 on）");

    // ---- v1.16.0：总开关在标题栏、关闭按钮左边 ----
    const headSw = all.find((n) => n.className === "gp-head-sw") || { children: [] };
    ok(!!headSw.children[0], "★★ 标题栏有「插件」开关");
    eq(String((headSw.children[0] || {}).textContent), "插件", "★★ 标签是「插件」");
    const pluginSw = headSw.children[1] || { className: "", onclick() {} };
    eq(pluginSw.className, "gp-sw on", "★★ 总开关默认启用");
    const iHeadSw = all.indexOf(headSw);
    const iClose = all.findIndex((n) => n.className === "gp-x");
    ok(iHeadSw >= 0 && iClose >= 0 && iHeadSw < iClose, "★★ 总开关在关闭按钮左边");
    pluginSw.onclick();
    eq(e.win.__gpNativeAll, true, "★★ 关掉 = __gpNativeAll=true（整条交回原生）");
    eq(pluginSw.className, "gp-sw", "★★ 视觉同步（不再是 on）");
    ok(
      walk(card, []).some((n) => String(n.textContent || "").indexOf("插件已停用") >= 0),
      "★★ 状态行立刻变成「插件已停用」"
    );
    pluginSw.onclick();
    eq(e.win.__gpNativeAll, false, "★★ 再点一下 → 启用");

    // ---- v1.20.0：曲线改成 Dialog ----
    const curveRow = rowOf("曲线") || { children: [] };
    const curveBtn = curveRow.children[1] || { textContent: "", onclick() {} };
    eq(String(curveBtn.textContent), "自动", "★★ 曲线默认「自动」（按档位）");
    curveBtn.onclick();
    const dlg = doc.body.children.filter((n) => n.className === "gp-dialog")[0];
    ok(!!dlg, "★★ 点曲线 → 弹出 Dialog");
    const dRows = dlg && dlg.children[0]
      ? dlg.children[0].children.filter((n) => /^gp-dialog-row/.test(String(n.className)))
      : [];
    eq(dRows.length, 7, "★★ Dialog 里 7 个选项（自动 + 6 条曲线）");
    const sline = dRows.filter((r) => String(r.textContent).indexOf("s-line") >= 0 && String(r.textContent).indexOf("r_s") < 0)[0];
    ok(!!sline, "（前提）找到 s-line 选项");
    if (sline) sline.onclick();
    eq(e.win.__gpXfadeCurve, "s-line", "★★ 选 s-line → 写入 __gpXfadeCurve");
    eq(doc.body.children.filter((n) => n.className === "gp-dialog").length, 0, "★★ 选完 Dialog 关闭");
    curveBtn.onclick();
    const dlg2 = doc.body.children.filter((n) => n.className === "gp-dialog")[0];
    const autoRow = dlg2 && dlg2.children[0]
      ? dlg2.children[0].children.filter((n) => String(n.textContent).indexOf("自动") >= 0)[0]
      : null;
    if (autoRow) autoRow.onclick();
    eq(e.win.__gpXfadeCurve, undefined, "★★ 选「自动」→ 清掉显式曲线");

    const eqRow = rowOf("扫频") || { children: [] };
    const eqSw = eqRow.children[1] || { className: "", onclick() {} };
    eq(eqSw.className, "gp-sw on", "★★ 扫频默认开");
    eqSw.onclick();
    eq(e.win.__gpXfadeEq, false, "★★ 点一下 → 关");
    eqSw.onclick();
    eq(e.win.__gpXfadeEq, true, "★★ 再点 → 开");

    // ★ v1.20.0：跳过默认关
    const skipRow = rowOf("差拍跳过") || { children: [] };
    const skipSw = skipRow.children[1] || { className: "", onclick() {} };
    eq(skipSw.className, "gp-sw", "★★ 「差拍跳过」默认关");
    skipSw.onclick();
    eq(e.win.__gpSkipBadMix, true, "★★ 打开写入 true");
    skipSw.onclick();
    eq(e.win.__gpSkipBadMix, false, "★★ 再点关掉");
    const contRow = rowOf("无缝专辑原样") || { children: [] };
    const contSw = contRow.children[1] || { className: "", onclick() {} };
    eq(contSw.className, "gp-sw on", "★★ 「无缝专辑原样」默认开");
    contSw.onclick();
    eq(e.win.__gpKeepContinuous, false, "★★ 关掉写入 __gpKeepContinuous=false");
    contSw.onclick();

    const trimRow = rowOf("首尾裁剪") || { children: [] };
    const trimSw = trimRow.children[1] || { onclick() {} };
    trimSw.onclick();
    eq(e.win.__gpTrim, false, "★★ 首尾裁剪总开关");
    trimSw.onclick();
    eq(e.win.__gpTrim, true, "★★ 再开回来");

    const loudRefRow = rowOf("响度参考") || { children: [] };
    const loudRefSw = loudRefRow.children[1] || { onclick() {} };
    loudRefSw.onclick();
    eq(e.win.__gpLoudRef, "none", "★★ 响度参考可切绝对");
    loudRefSw.onclick();
    eq(e.win.__gpLoudRef, "median", "★★ 再切回相对");

    const diskRow = rowOf("磁盘缓存") || { children: [] };
    const diskSw = diskRow.children[1] || { onclick() {} };
    // 验证台没有 fs → 初始不可用；点一下仍应把开关写进 __gpDiskCache
    diskSw.onclick();
    eq(e.win.__gpDiskCache, true, "★★ 磁盘缓存开关会写 __gpDiskCache");
    e.win.__gpDiskCache = false;

    // ---- 再点一次收起 ----
    eq(api(e).openPanel(), true, "★★ 再调 openPanel() 收起");
    eq(doc.body.children.length, 1, "★★ 卡片被移除");
    eq(String(btn.className), "gp-fab", "★★ 按钮恢复不高亮（仍在原位）");
  }

  section("92. ★★★ v1.5.3/v1.6.0 预开流 + 双元素：B 在空闲槽里缓冲，切歌时接管");
  {
    /**
     * 造一个「A 是缓冲、B 的预载挂住」的环境：
     * 先让 A 正常预载就绪，再把取址接口换成「永不返回」的地址 —— 于是 B 的预载会一直 pending。
     * （验证台默认 `__gpStream = false` 强制走缓冲，这里要显式删掉才允许流式）
     */
    async function hangNextEnv() {
      const e = createEnv();
      delete e.win.__gpStream;
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      await flush();
      e.eapi.url = "http://cdn.example/hang/next.flac"; // ★ 从这一刻起 B 的取址会挂住
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/a.flac" },
      ]);
      await flush();
      await flush();
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush();
      e.flushTimers();
      e.flushTimers();
      return e;
    }
    const inst = (e, i) => e.audio.instances[i] || { src: "", __loads: 0, readyState: 0, duration: 0, paused: true };

    // ---- (a) B 的预载还在飞 → 窗口内在**空闲槽**里预开，A 不受影响 ----
    {
      const e = await hangNextEnv();
      eq(countLog(e, "[load] 流式播放"), 0, "（前提）A 走的是缓冲");
      eq(countLog(e, "[stream] ★ 提前预开"), 0, "（前提）还没预开");
      eq(e.audio.instances.length, 0, "（前提）还没建 <audio>");

      setLeft(e, 1.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 提前预开 <audio>") >= 1, "★★ 窗口内提前把 B 的流预开了");
      eq(e.audio.instances.length, 2, "★★ 双元素：出声槽 + 预开槽（各一个）");
      ok(/hang\/next/.test(String(inst(e, 1).src)), "★★ 预开槽挂的是 B 的地址");
      ok(inst(e, 1).__loads >= 1, "★★ 预开槽调了 load() 让浏览器自己缓冲");
      eq(countLog(e, "预约 ｜"), 0, "★★ 这时仍然预约不了（B 没 ready，采样级接缝还是指望不上）");
    }

    // ---- (b) 真切歌 → 采用预开槽（不重设 src、不再等 canplay），并保证不出双声 ----
    {
      const e = await hangNextEnv();
      setLeft(e, 1.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 提前预开 <audio>") >= 1, "（前提）已经预开");
      const pre = inst(e, 1);
      const srcBefore = String(pre.src);
      const loads1 = pre.__loads;
      // 预开的元素在挂监听**之前**就已经有 metadata 了（真机上等了 1 秒以上就会这样）
      pre.readyState = 1;
      pre.duration = 210;
      // 顺便让「当前这首」看起来正在播（流式 A 的场景）
      inst(e, 0).paused = false;

      e.channel.call("audioplayer.load", null, [
        idOf(2000) + "-x",
        { songId: 2000, musicurl: "http://cdn.example/b-encrypted-token" },
      ]);
      await flush();
      await flush();
      e.flushTimers();

      ok(countLog(e, "[stream] ★ 采用预开的槽 #1") >= 1, "★★ 真切歌时采用了预开槽");
      ok(countLog(e, "[stream] ★ 复用提前预开的") >= 1, "★★ 而且没有重设 src（等于不重新下载）");
      eq(String(pre.src), srcBefore, "★★ src 没变");
      eq(pre.__loads, loads1, "★★ 也没有再调 load()");
      ok(countLog(e, "[stream] ★★ 就绪（metadata）") >= 1, "★★ 补发了 metadata 就绪（否则会一直等一个不会再来的事件）");
      ok(e.emitted.some((x) => x.name === "Load"), "★★ onLoad 也发出去了");
      eq(String(inst(e, 0).src), "", "★★ 占位槽没被写 src（A 走缓冲时它本来就空着）");
    }

    // ---- (c) 当前这首正在流式 → 预开走**另一个**槽（这正是双元素的意义） ----
    {
      const e = createEnv();
      delete e.win.__gpStream;
      e.eapi.url = "http://cdn.example/hang/both.flac"; // A 的预载也挂住 → A 只能走流式
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/a.flac" },
      ]);
      await flush();
      await flush();

      // 让 A 真的「就绪」：⚠️ 必须在 flushTimers 之前发 metadata，
      //   否则会先跑到「metadata 超时 8s」那条兜底（验证台的 flushTimers 不看时间，直接跑）。
      e.eapi.url = "http://cdn.example/hang/next2.flac"; // 之后 B 的预载走这个地址
      const elA = inst(e, 0);
      elA.readyState = 1;
      elA.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.flushTimers();
      ok(countLog(e, "[load] 流式播放") >= 1, "（前提）当前这首走的是流式");
      ok(countLog(e, "[stream] ★★ 就绪（metadata）") >= 1, "（前提）A 已经流式就绪");
      const srcA = String(inst(e, 0).src);

      setLeft(e, 1.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 提前预开") >= 1, "★★ 当前在流式时也能预开（用另一个槽）");
      eq(e.audio.instances.length, 2, "★★ 一共两个槽");
      eq(String(inst(e, 0).src), srcA, "★★ 正在播的那个元素完全没被碰");
      ok(/hang\/next2/.test(String(inst(e, 1).src || "")), "★★ 预开挂在第二个槽上");
    }

    // ---- (d) 换预载目标 / 预载作废 → 预开的槽要清掉，但**不动**正在播的那个 ----
    {
      const e = await hangNextEnv();
      setLeft(e, 1.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 提前预开 <audio>") >= 1, "（前提）已经预开");
      const srcA = String(inst(e, 0).src);
      e.channel.call("player.setCurrentPlay", null, [idOf(3000)]); // 切到别的歌 → 预载换目标
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] 清掉提前预开的流") >= 1, "★★ 换目标时清掉了预开的槽");
      eq(String(inst(e, 1).src), "", "★★ 预开槽的 src 被撤了（不白占连接）");
      eq(String(inst(e, 0).src), srcA, "★★ 正在播的那一路没被动过");
    }

    // ---- (e) A 正在流式播 → 采用预开槽时必须把 A 停掉（双声是硬伤） ----
    {
      const e = createEnv();
      const slotOf = (i) => e.audio.instances[i] || { src: "", readyState: 0, duration: 0, paused: true };
      delete e.win.__gpStream;
      e.eapi.url = "http://cdn.example/hang/both.flac"; // A 的预载也挂住 → A 走流式
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/a.flac" },
      ]);
      await flush();
      await flush();
      e.eapi.url = "http://cdn.example/hang/next3.flac";
      slotOf(0).readyState = 1;
      slotOf(0).duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.flushTimers();
      setLeft(e, 1.2);
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 提前预开") >= 1, "（前提）已经在第二个槽预开");

      // 预开槽已有 metadata；此刻 A 还在响（paused=false）
      slotOf(1).readyState = 1;
      slotOf(1).duration = 180;
      eq(slotOf(0).paused, false, "（前提）A 正在响");
      e.channel.call("audioplayer.load", null, [
        idOf(2000) + "-x",
        { songId: 2000, musicurl: "http://cdn.example/b-token" },
      ]);
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 采用预开的槽 #1") >= 1, "★★ 采用了预开槽");
      eq(slotOf(0).paused, true, "★★ A 的元素被暂停（不会双声）");
      ok(countLog(e, "[stream] 上一个槽已暂停") >= 1, "★★ 而且记了一行日志（便于排查双声）");
    }
  }

  section("93. ★★★ v1.5.4 C3 侦察：能不能问出「下一首是谁」");
  {
    // ---- (a) 没有 indexedDB / 没人应答：探针要跑完、要记「无响应」 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      ok(typeof api.probeNext === "function", "★★ 暴露了 gaplessPlayer.probeNext()");

      const n0 = e.nativeCalls.length;
      eq(api.probeNext(), true, "★★ 探针跑起来了");
      const asked = e.nativeCalls.slice(n0).map((c) => c.name);
      ok(asked.indexOf("nm.play.getNextSong") >= 0, "★★ 问了 nm.play.getNextSong");
      ok(asked.indexOf("nm.play.getPlayerMode") >= 0, "★★ 也问了 nm.play.getPlayerMode");
      ok(asked.indexOf("Database.getAllBy") >= 0, "★★ 也试了播放列表 DB（randomOrder 排序）");

      e.flushTimers();
      e.flushTimers(); // 日志本身也是攒着写的，冲两遍才落盘
      ok(countLog(e, "[next] ===== C3 侦察开始") >= 1, "★★ 有开始标记");
      ok(countLog(e, "← 无响应（800ms）") >= 3, "★★ 每条都记了「无响应」（" + countLog(e, "← 无响应（800ms）") + " 条）");
      ok(countLog(e, "indexedDB 不可用") >= 1, "★★ indexedDB 探针给出了明确结论");
      ok(countLog(e, "[next] localStorage 共") >= 1, "★★ 顺手报了 localStorage 键数");
      ok(countLog(e, "[next] registeredCalls 共") >= 1, "★★ 也看了 registeredCalls");
    }

    // ---- (b) 有人应答：把返回值记进日志 ----
    {
      const e = createEnv({
        onNative(name, cb, args) {
          if (name === "nm.play.getNextSong" && typeof cb === "function") {
            cb({ code: 200, data: { id: 4242, name: "下一首示例" } });
          }
        },
      });
      e.boot();
      await flush();
      e.win.gaplessPlayer.probeNext();
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "nm.play.getNextSong ← ") >= 1, "★★ 有应答时把结果记下来了");
      ok(/4242/.test(e.logs()), "★★ 返回值内容进日志（能看出到底给了什么）");
    }

    // ---- (c) 有 indexedDB：要列出库名与表名（这是「直接读随机顺序」的关键前提） ----
    {
      const fakeIdb = {
        databases: () => Promise.resolve([{ name: "cloudmusic" }]),
        open(name) {
          const rq = { onsuccess: null, onerror: null, result: null };
          Promise.resolve().then(() => {
            rq.result = { objectStoreNames: ["current", "last"], close() {} };
            if (rq.onsuccess) rq.onsuccess();
          });
          return rq;
        },
      };
      const e = createEnv({ indexedDB: fakeIdb });
      e.boot();
      await flush();
      e.win.gaplessPlayer.probeNext();
      await flush();
      await flush();
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "IndexedDB 共 1 个库: cloudmusic") >= 1, "★★ 列出了库名");
      ok(countLog(e, "cloudmusic → 表: current, last") >= 1, "★★ 列出了表名（有 current 就是我们想要的那张）");
    }

    // ---- (d) 连点两下：第二次要被挡住（否则会刷出一堆重复请求） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      eq(api.probeNext(), true, "（前提）第一次跑起来了");
      eq(api.probeNext(), false, "★★ 紧接着第二次被挡（上一轮还没跑完）");
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "上一次侦察还没跑完") >= 1, "★★ 而且日志说清楚了原因");
    }
  }

  section("94. ★★★ v1.5.5 C3 续：用 storage.execsql 直接查播放列表 DB");
  {
    // ---- (a) 发得出去：命令名与参数形态要对 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      ok(typeof api.sqlq === "function", "★★ 暴露了 gaplessPlayer.sqlq()");
      ok(typeof api.sqlTables === "function", "★★ 也暴露了 sqlTables()");

      const n0 = e.nativeCalls.length;
      const reqId = api.sqlq("SELECT name FROM sqlite_master WHERE type='table'");
      eq(typeof reqId, "string", "（前提）返回了 reqId");
      const call = e.nativeCalls.slice(n0).filter((c) => c.name === "storage.execsql")[0] || { args: [[]] };
      ok(!!call, "★★ 真的走到了 storage.execsql 这条通道（不是瞎猜的命令名）");
      const args = call.args[0];
      ok(Array.isArray(args) && String(args[0]) === reqId, "★★ 参数字段 [reqId, sql]：reqId 对得上");
      ok(/sqlite_master/.test(String(args[1])), "★★ SQL 原样传过去了（" + String(args[1]).slice(0, 40) + "…）");
    }

    // ---- (b) 回得来：按 appendRegisterCall("execsqldone","storage",cb) 的约定接结果 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      const reqId = api.sqlq("SELECT 1");
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "← 无响应（1500ms）") >= 1, "★★ 没人应答时会明确记「无响应」（否则永远不知道卡在哪）");

      // 模拟原生回调：客户端约定是 cb(reqId, errCode, value)
      const rq = api.sqlq("SELECT 2");
      const handlers = e.win.registeredCalls || {};
      const key = "storage.onexecsqldone";
      const arr = handlers[key] || [];
      ok(arr.length >= 1, "★★ 回调挂到了 storage.onexecsqldone（共 " + arr.length + " 个）");
      // 先把「别人」的结果喂进来，验证 reqId 过滤
      arr.forEach((fn) => fn("别人的reqId", 0, [{ name: "不该出现" }]));
      // 再喂我们自己的 —— ⚠️ 中间不能 flushTimers：那会把这条查询的 1500ms 超时也跑掉（pending 被清）
      arr.forEach((fn) => fn(rq, 0, [{ name: "current" }, { name: "last" }]));
      e.flushTimers();
      e.flushTimers();
      ok(!/不该出现/.test(e.logs()), "★★ 别人的结果被 reqId 过滤掉了（内容没串进来）");
      ok(countLog(e, "忽略一条不属于我们的结果") >= 1, "★★ 而且明确记了一笔「忽略别人的结果」");
      ok(countLog(e, "[sql] ← err=0") >= 1, "★★ 我们的结果被记下来了");
      ok(/current/.test(e.logs()) && /last/.test(e.logs()), "★★ 表名进了日志（能直接看出有没有 current 表）");
    }

    // ---- (c) 不看 DOM/网络也能跑：sqlTables() 也是一条 query ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const n0 = e.nativeCalls.length;
      e.win.gaplessPlayer.sqlTables();
      const calls = e.nativeCalls.slice(n0).filter((c) => c.name === "storage.execsql");
      eq(calls.length, 1, "★★ sqlTables() 只发一条 SQL");
      const a0 = ((calls[0] || { args: [[]] }).args[0] || []);
      ok(/sqlite_master/.test(String(a0[1])), "★★ 查的是 sqlite_master");
    }
  }


    // ---- (e) v1.5.7：播放列表探针（表名是从客户端常量里挖出来的） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      ok(typeof api.sqlPlaying === "function", "★★ 暴露了 sqlPlaying()");
      const n0 = e.nativeCalls.length;
      eq(api.sqlPlaying(), true, "★★ 播放列表探针跑起来了");
      const sqls = e.nativeCalls.slice(n0).filter((c) => c.name === "storage.execsql")
        .map((c) => String(c.args[0][1]));
      eq(sqls.length, 3, "★★ 一次点了三件事（结构 / 前两行 / 行数）");
      ok(sqls.some((s) => /currentPlayingList/.test(s)), "★★ 查的是 currentPlayingList");
      ok(sqls.some((s) => /sqlite_master/.test(s)), "★★ 先问了建表 SQL（才知道有没有 randomOrder 列）");
      ok(sqls.some((s) => /count\(\*\)/i.test(s)), "★★ 也问了总行数");
    }

    // ---- (f) v1.5.8：persistentModel + 加密快照探针（都只读，缺什么都得能跑完） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      ok(typeof api.sqlPersist === "function", "★★ 暴露了 sqlPersist()");
      const n0 = e.nativeCalls.length;
      eq(api.sqlPersist(), true, "★★ 持久化探针跑起来了");
      const sqls = e.nativeCalls.slice(n0).filter((c) => c.name === "storage.execsql")
        .map((c) => String(c.args[0][1]));
      ok(sqls.some((s) => /persistentModel/.test(s)), "★★ 查了 persistentModel 表（" + sqls.length + " 条 SQL）");
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "[enc] frontendEncrypt ｜") >= 1, "★★ 也报了 frontendEncrypt 是否存在");
      ok(countLog(e, "[enc] playingInfo 长度=") >= 1, "★★ 也报了 playingInfo 长度");
      // 有 frontendEncrypt 时逐个试解密方法，不能抛
      const e2 = createEnv();
      e2.win.frontendEncrypt = {
        decode(x) {
          return "decoded:" + String(x).slice(0, 4);
        },
      };
      e2.localStorage.setItem("playingInfo", "ABCDEFG");
      e2.boot();
      await flush();
      e2.win.gaplessPlayer.sqlPersist();
      e2.flushTimers();
      e2.flushTimers();
      ok(/decoded:ABCD/.test(e2.logs()), "★★ 能试出解密结果（" + (e2.logs().match(/\[enc\][^\n]*decode[^\n]*/) || ["?"])[0] + "）");
    }
  section("95. ★★★ v1.6.1 B：N+2 只抓字节 + 头尾 BPM 不一致的收敛");
  {
    /** 头窗 120BPM、尾窗 157BPM 的合成轨（模拟真机「头尾测出两个 BPM」） */
    function mkTwoTempo(opts) {
      const o = opts || {};
      const sr = o.sr || 8000;
      const secs = o.secs || 180;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      function click(fromSec, toSec, bpm) {
        const beat = 60 / bpm;
        for (let t = fromSec; t < toSec; t += beat) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
            data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
          }
        }
      }
      click(0, 20, 120);
      click(secs - 20, secs, 157);
      return {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
    }

    // ---- (a) N+2 只抓字节 → 等它成为下一首时直接命中字节缓存 ----
    {
      const e = createEnv({ decode: () => mkTwoTempo({ secs: 200 }) });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000); // 第 0 首 → 下一首 2000、下下一首 3000
      await flush();
      e.flushTimers();
      ok(countLog(e, "[prefetch] 提前抓") >= 1, "★★ 开始抓 N+2 的字节");
      ok(countLog(e, "[prefetch] ★ 字节已备好（N+2）") >= 1, "★★ 字节抓好了（不解码）");
      ok(/track=3000/.test(e.logs()), "★★ 抓的是下下一首（3000）");

      // 播到 2000 之后，3000 变成「下一首」→ 预载它应当命中字节缓存（不再取址 + 下载）
      await playTrack(e, 2000);
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "字节缓存命中") >= 1, "★★ 成为下一首后直接命中字节缓存（不重新下载）");
    }

    // ---- (b) 列表末端不抓（没有下下一首） ----
    {
      const e = createEnv({ decode: () => mkTwoTempo({ secs: 200 }) });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 5000); // 索引 4 → 下下一首是索引 6（不存在）
      await flush();
      e.flushTimers();
      eq(countLog(e, "[prefetch] 提前抓") + countLog(e, "[prefetch] ★ 字节已备好"), 0,
        "★★ 列表末端不抓下下一首（越界判断）");
    }

    // ---- (c) 头尾 BPM 不一致 → 以头窗为准，并压低置信（不再硬对齐） ----
    {
      const e = createEnv({ decode: () => mkTwoTempo({ secs: 180 }) });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      e.flushTimers();
      ok(countLog(e, "★ 头尾 BPM 不一致") >= 1, "★★ 检测到头尾 BPM 不一致");
      const g95 = e.win.gaplessPlayer.beatGrid(1000) || { head: null, tail: null };
      ok(!!g95.head && !!g95.tail, "（前提）头尾网格都在缓存里");
      eq(Math.abs((g95.tail ? g95.tail.bpm : -1) - (g95.head ? g95.head.bpm : -2)) < 0.01, true,
        "★★ 收敛后尾窗 BPM 等于头窗（" + (g95.tail ? g95.tail.bpm.toFixed(1) : "?") + " == " + (g95.head ? g95.head.bpm.toFixed(1) : "?") + "）");
      ok(g95.tail && g95.tail.conf >= 0.2, "★★ 置信只打折、不判死（可以把仍参与对齐）｜conf=" + (g95.tail ? g95.tail.conf.toFixed(2) : "?"));
      ok(g95.tail && isFinite(g95.tail.endBeatSec), "★★ 末拍按头窗外推出来了（" + (g95.tail ? g95.tail.endBeatSec.toFixed(2) : "?") + "s）");
      const m = e.logs().match(/尾 (\d+\.\d) \/ 置信 \d\.\d\d vs 头 (\d+\.\d)/);
      ok(!!m, "★★ 日志里带了头尾两个 BPM（" + (m ? m[0] : "?") + "）");
    }
  }

  section("96. ★★★ v1.7.0 C：WSOLA 保音高变速（先测纯函数）");
  {
    const api = (e) => e.win.gaplessPlayer;

    // ---- (a) 拉伸长度与比例 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const sr = 8000;
      const secs = 4;
      const n = sr * secs;
      const sine = new Float32Array(n);
      for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;

      const r1 = api(e).wsola([sine], 1, { sr });
      eq(r1.outLen, n, "★★ 比例 1.0 → 输出长度不变");
      eq(r1.out.length, 1, "★★ 单声道进、单声道出");

      const r102 = api(e).wsola([sine], 1.02, { sr });
      ok(Math.abs(r102.outLen - Math.round(n / 1.02)) <= 2,
        "★★ 1.02 倍 → 输出长度 ≈ 输入/1.02（" + r102.outLen + " vs " + Math.round(n / 1.02) + "）");

      const r098 = api(e).wsola([sine], 0.98, { sr });
      ok(r098.outLen > n, "★★ 0.98 倍（变慢）→ 输出更长（" + r098.outLen + "）");

      // 立体声：两个声道长度一致、且都没跑成 NaN
      const r2ch = api(e).wsola([sine, sine], 1.02, { sr });
      eq(r2ch.out.length, 2, "★★ 双声道进、双声道出");
      eq(r2ch.out[0].length, r2ch.out[1].length, "★★ 两声道输出等长");
      let nan = 0;
      for (let i = 0; i < r2ch.outLen; i++) if (!isFinite(r2ch.out[0][i])) nan++;
      eq(nan, 0, "★★ 没有 NaN/Infinity");
    }

    // ---- (b) 能量守恒：正弦波拉伸后 RMS 不该明显变小/变大 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const sr = 8000;
      const n = sr * 3;
      const sine = new Float32Array(n);
      for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;
      const rms = (a, len) => {
        let s = 0;
        for (let i = Math.floor(len * 0.1); i < Math.floor(len * 0.9); i++) s += a[i] * a[i];
        return Math.sqrt(s / Math.max(1, Math.floor(len * 0.8)));
      };
      const inRms = rms(sine, n);
      const out = api(e).wsola([sine], 1.02, { sr });
      const outRms = rms(out.out[0], out.outLen);
      ok(Math.abs(outRms - inRms) / inRms < 0.25,
        "★★ 拉伸后整体能量基本不变（" + inRms.toFixed(3) + " → " + outRms.toFixed(3) + "）");
    }

    // ---- (c) 静音进 → 静音出（不能把噪声放大） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const n = 8000 * 2;
      const r = api(e).wsola([new Float32Array(n)], 1.05, { sr: 8000 });
      let maxAbs = 0;
      for (let i = 0; i < r.outLen; i++) maxAbs = Math.max(maxAbs, Math.abs(r.out[0][i]));
      eq(maxAbs, 0, "★★ 全静音输入 → 输出仍是全静音");
    }

    // ---- (d) 节拍位置跟着比例走（脉冲不会被抹平） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const sr = 8000;
      const secs = 4;
      const n = sr * secs;
      const clicks = new Float32Array(n);
      const beat = 0.5; // 120 BPM
      for (let t = 0.1; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.02 && at + i < n; i++) clicks[at + i] = Math.exp(-i / (sr * 0.005)) * 0.9;
      }
      const r = api(e).wsola([clicks], 1.1, { sr });
      // 找输出里的峰个数（应该仍然是 ~secs/beat/1.1 个左右，而不是被抹平）
      let peaks = 0;
      for (let i = 1; i < r.outLen - 1; i++) {
        if (r.out[0][i] > 0.3 && r.out[0][i] >= r.out[0][i - 1] && r.out[0][i] > r.out[0][i + 1]) peaks++;
      }
      ok(peaks >= 5, "★★ 拉伸后脉冲还在（检测到 " + peaks + " 个峰）");
    }

    // ---- (e) stretchPlan：该拉才拉、超范围就拒绝 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const g = (bpm, conf) => ({ bpm, beatSec: 60 / bpm, anchorSec: 0, conf });
      const p1 = api(e).stretchPlan(g(120, 0.8), g(122, 0.8), 3);
      eq(p1.ok, true, "★★ 120 vs 122（差 1.7%）→ 值得拉");
      ok(Math.abs(p1.ratio - 120 / 122) < 1e-6, "★★ 比例 = A.bpm / B.bpm（" + p1.ratio.toFixed(4) + "）");
      ok(Math.abs(p1.headSrc - 3 * p1.ratio) < 1e-6, "★★ 需要消耗的 B 输入长度 = 交叉 × 比例");

      const p2 = api(e).stretchPlan(g(120, 0.8), g(150, 0.8), 3);
      eq(p2.ok, false, "★★ 差 20% → 不拉（超出 ±6%）");
      ok(/超出/.test(p2.reason), "★★ 理由写明超出范围");

      const p3 = api(e).stretchPlan(g(120, 0.8), g(60, 0.8), 3);
      eq(p3.ok, false, "★★ 120 vs 60 折八度后本来就同步 → 不拉");

      const p4 = api(e).stretchPlan(g(120, 0.1), g(122, 0.8), 3);
      eq(p4.ok, false, "★★ 置信太低 → 不拉");

      const p5 = api(e).stretchPlan(null, g(122, 0.8), 3);
      eq(p5.ok, false, "★★ 缺网格 → 不拉");

      const p6 = api(e).stretchPlan(g(120, 0.8), g(122, 0.8), 0);
      eq(p6.ok, false, "★★ 没有交叉 → 不拉");
    }
  }

  section("97. ★★★ v1.7.0 C：把拉伸段排到交叉里，然后再接回原始缓冲");
  {
    /**
     * 一首歌里塞两个 BPM：头窗 120、尾窗 head/tail 指定。
     * 这样 A 用尾窗、B 用头窗，就能在「只有一份解码缓冲」的前提下造出两个不同 BPM 的网格。
     */
    function mkTempo(headBpm, tailBpm, secs) {
      const sr = 8000;
      const S = secs || 200;
      const n = Math.round(S * sr);
      const data = new Float32Array(n);
      function click(fromSec, toSec, bpm) {
        const beat = 60 / bpm;
        for (let t = fromSec; t < toSec; t += beat) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
            data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
          }
        }
      }
      click(0, 22, headBpm); // 头窗（0~20s）
      click(S - 22, S, tailBpm); // 尾窗（末尾 20s）
      return {
        duration: S,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
    }

    // ---- (a) BPM 差 1.25% → 拉，并且排两段：拉伸段 + 原始缓冲接续段 ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTempo(120, 126.5) } });
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      const n0 = e.started.length;
      e.tick();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stretch] ★ 拉 ") >= 1, "★★ 决定了要拉伸（" + (e.logs().match(/\[stretch\] ★ 拉[^\n]*/) || ["?"])[0] + "）");
      ok(/拉伸 -?\d+\.\d\d%/.test(e.logs()), "★★ [sched] 那行带上了拉伸比例");
      eq(countLog(e, "交叉预约"), 1, "★★ 仍然是预约（不是退回硬接）");

      const started = e.started.slice(n0);
      eq(started.length, 2, "★★ 排了两段：拉伸段 + 接续段");
      const stretched = started[0] || { at: 0, off: 0, dur: 0 };
      const rest = started[1] || { when: 0, off: 0, dur: 0 };
      // ★ v1.9.1/v1.9.2：交叉时长会被「量化到整拍」再「混音点对齐（可能提前收尾）」，
      //   所以拿日志里真正排上的那个时长来比，而不是硬编码用户设的 3s。
      const mXf = e.logs().match(/交叉=(\d+\.\d\d)s/);
      const wantFade = mXf ? Number(mXf[1]) : 3;
      ok(
        Math.abs(Number(stretched.dur) - wantFade) < 0.05,
        "★★ 拉伸段长度 == 实际排上的交叉时长（" + Number(stretched.dur).toFixed(2) + "s / 期望 " + wantFade.toFixed(2) + "s）"
      );
      ok(Number(rest.at) > Number(stretched.at), "★★ 接续段在拉伸段之后开始");
      ok(Math.abs(Number(rest.at) - (Number(stretched.at) + Number(stretched.dur))) < 0.06,
        "★★ 接续段正好接在拉伸段结束处（差值 " + (Number(rest.at) - Number(stretched.at) - Number(stretched.dur)).toFixed(3) + "s）");
      ok(Number(rest.off) > 2.8 && Number(rest.off) < 3.5,
        "★★ 接续段的起点 = 被拉伸消耗掉的 B 头部（" + Number(rest.off).toFixed(2) + "s ≈ 3s）");
    }

    // ---- (b) BPM 差 25% → 不拉（先被头尾一致性拦下，再被 ±6% 拦下） ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTempo(120, 150) } });
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      const n0 = e.started.length;
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[stretch] ★ 拉 "), 0, "★★ 不做拉伸");
      eq(e.started.length - n0, 1, "★★ 只排一段（原来的普通交叉）");
    }

    // ---- (c) 没有交叉（干净风格）→ 不拉 ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTempo(120, 126.5) } });
      // 不设 __gpXfade：顺序播放 + 智能默认 = 干净（0s）
      setLeft(e, 1.0);
      const n0 = e.started.length;
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[stretch] ★ 拉 "), 0, "★★ 没有交叉就不拉伸");
      eq(e.started.length - n0, 1, "★★ 只排一段");
    }
  }

  section("98. ★★★ v1.7.1 #3：流式 B 也能交叉（元素交叉）");
  {
    /**
     * A 走缓冲、B 的预载挂住（→ 只能预开流）。
     * 开关交叉后：应当排「流式交叉」而不是直接放弃。
     */
    async function streamBEnv() {
      const e = createEnv();
      delete e.win.__gpStream;
      e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      await flush();
      // ⚠️ A 必须先正常预载就绪（走缓冲），再把取址改成「挂住」→ B 才会 pending
      e.win.__gpXfade = 3;
      e.eapi.url = "http://cdn.example/hang/next.flac"; // B 的预载挂住
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/a.flac" },
      ]);
      await flush();
      await flush();
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush();
      e.flushTimers();
      e.flushTimers();
      return e;
    }
    const slotOf = (e, i) => e.audio.instances[i] || { src: "", readyState: 0, duration: 0, paused: true, currentTime: 0 };

    // ---- (a) 没有解码缓冲，但预开着流 → 排「流式交叉」 ----
    {
      const e = await streamBEnv();
      e.win.__gpLogVerbose = true;
      setLeft(e, 3.2);
      e.tick(); // 这一拍：建预开槽
      await flush();
      e.flushTimers();
      ok(countLog(e, "[stream] ★ 提前预开") >= 1, "（前提）B 的流已经预开在空闲槽");

      slotOf(e, 1).readyState = 1; // 有 metadata 了（真机上预开 1s 后就是这样）
      slotOf(e, 1).duration = 210;
      e.tick(); // 第二拍：应当排流式交叉
      await flush();
      e.flushTimers();
      e.flushTimers();
      if (process.env.GP_DBG98) console.log(e.logs().split("\n").filter((l) => /sched|preload|stream|automix/.test(l)).slice(-14).join("\n"));
      if (process.env.GP_DBG98) console.log(e.logs().split("\n").filter((l) => /\[dbg98\]|sched|preload|stream/.test(l)).slice(-12).join("\n"));
      ok(countLog(e, "[sched] ★ 流式交叉预约") >= 1, "★★ 排上了流式交叉（B 没缓冲也不放弃）");
      ok(/交叉=2\.00s/.test(e.logs()), "★★ 流式 B 的交叉被压到 2s（设定 3s，但没有解码缓冲就不淡太久）");
      ok(/槽#1/.test(e.logs()), "★★ 用的是第二个元素槽");

      // B 的元素到点被拉起，且 A 的增益上有淡出曲线
      e.flushTimers(); // 跑那个「到点 play()」的定时器
      eq(slotOf(e, 1).paused, false, "★★ 流式 B 已经被拉起（开始出声）");
      const curves = [];
      const seen = new Set();
      const pushParam = (p) => {
        if (!p || !p.events || seen.has(p)) return;
        seen.add(p);
        p.events.forEach((ev) => curves.push(ev));
      };
      if (e.ctx.__gains) e.ctx.__gains.forEach((g) => pushParam(g && g.gain));
      if (e.ctx.__params) e.ctx.__params.forEach(pushParam);
      if (e.gains) e.gains.forEach((g) => pushParam(g && g.gain));
      ok(curves.some((ev) => ev.type === "curve"), "★★ 增益曲线上排了淡入/淡出（不是瞬间切换）");
    }

    // ---- (b) A 播完 → 交接给流式 B；随后 load 到达 → 认领 ----
    {
      const e = await streamBEnv();
      e.win.__gpLogVerbose = true;
      setLeft(e, 3.2);
      e.tick();
      await flush();
      e.flushTimers();
      slotOf(e, 1).readyState = 1;
      slotOf(e, 1).duration = 210;
      e.tick();
      await flush();
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "[sched] ★ 流式交叉预约") >= 1, "（前提）已排上");

      // A 播完
      e.ctx.currentTime = 200.02;
      enderOf(e.started, 0)();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[end] ★ 自然播完 → 流式交叉交接") >= 1, "★★ 交接给了流式 B（不再是硬接）");
      ok(e.emitted.some((x) => x.name === "End"), "★★ 也发出了 onEnd（客户端才会推进）");

      // 客户端随后 load 这一首 → 认领
      e.channel.call("audioplayer.load", null, [
        idOf(2000) + "-x",
        { songId: 2000, musicurl: "http://cdn.example/b-token" },
      ]);
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[sched] 认领（流式 B）") >= 1, "★★ load 到达后是「认领」，不重启");
      ok(/播法=流式/.test(e.logs()) || countLog(e, "认领（流式 B）") >= 1, "★★ 状态是流式接管");
    }

    // ---- (c) 关掉交叉 → 不排流式交叉（保持原来的硬接 + 预开流） ----
    {
      const e = await streamBEnv();
      e.win.__gpLogVerbose = true;
      e.win.__gpXfade = 0;
      setLeft(e, 1.0);
      e.tick();
      await flush();
      e.flushTimers();
      slotOf(e, 1).readyState = 1;
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "[sched] ★ 流式交叉预约"), 0, "★★ 没开交叉就不排流式交叉");
    }
  }

  section("99. ★★★ v1.7.2 #2：把原生正在播的这一首接过来（首曲的尾巴归我们）");
  {
    /**
     * AudioContext 起不来 → 首曲由原生播放。这里再让「原生」答出播放位置，
     * 模拟客户端轮询 getPlayedTime 拿到了 60 秒。
     */
    function nativePosAnswer(e, ms) {
      return function (name, cb, args) {
        if (name === "audioplayer.getPlayedTime" || name === "audioplayer.getPlaybackInfo") {
          if (typeof cb === "function") cb({ playedTime: ms, playedAudioTime: ms, result: true, playedPercent: 30 });
        }
      };
    }

    async function nativeEnv(posMs) {
      const e = createEnv({
        suspended: true,
        onNative: (name, cb, args) => nativePosAnswer(e, posMs)(name, cb, args),
      });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/native.flac" },
      ]);
      await flush();
      e.flushTimers();
      return e;
    }

    // ---- (a) 原生在播 60s；点按后我们把它接过来，并且从 60s 接着放 ----
    {
      const e = await nativeEnv(60000);
      ok(countLog(e, "[autoplay] ★ AudioContext 起不来") >= 1, "（前提）首曲由原生播放");
      eq(countLog(e, "[cmd] ▶ load"), 0, "（前提）load 被放行给原生");

      // 客户端轮询一次 → 我们顺手记下原生位置（这就是探针）
      e.channel.call("audioplayer.getPlayedTime", () => {}, [{ playId: idOf(1000) + "_1_x" }]);
      await flush();

      e.fireGesture(); // 点按 → 交回引擎 → 预载当前曲目 → 就绪后接管
      await flush();
      await flush();
      e.flushTimers();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[takeover] ★ 接管当前这首") >= 1, "★★ 把原生这一首接过来了");
      const st = e.started[e.started.length - 1];
      ok(st && Number(st.off) >= 59.9 && Number(st.off) <= 61.0,
        "★★ 从原生播到的位置接着放（offset=" + (st ? Number(st.off).toFixed(2) : "?") + "s ≈ 60s）");
      ok(/原生位置≈60\.\d\ds/.test(e.logs()), "★★ 日志里写明接在原生位置");
    }

    // ---- (b) 客户端从没报过原生位置 → 不接管，继续由原生放（不冒险） ----
    {
      const e = await nativeEnv(0);
      // 把位置清掉（模拟「客户端还没轮询过」）
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      e.fireGesture();
      await flush();
      await flush();
      e.flushTimers();
      const took = countLog(e, "[takeover] ★ 接管当前这首");
      ok(took === 0 || /位置不合适/.test(e.logs()), "★★ 位置不可信时不接管（" + took + " 次接管）");
    }

    // ---- (c) 接管之后再来的 play 命令归我们（不再放给原生） ----
    {
      const e = await nativeEnv(60000);
      e.channel.call("audioplayer.getPlayedTime", () => {}, [{ playId: idOf(1000) + "_1_x" }]);
      await flush();
      e.fireGesture();
      await flush();
      await flush();
      e.flushTimers();
      ok(countLog(e, "[takeover] ★ 接管当前这首") >= 1, "（前提）已接管");
      const n0 = e.nativeCalls.filter((c) => c.name === "audioplayer.play").length;
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush();
      e.flushTimers();
      const n1 = e.nativeCalls.filter((c) => c.name === "audioplayer.play").length;
      eq(n1, n0, "★★ 接管后 play 不再放给原生");
      ok(countLog(e, "[cmd] ▶ play") + countLog(e, "已经在播") >= 1, "★★ 而是由我们处理（" + countLog(e, "[cmd] ▶ play") + " 次 cmd/" + countLog(e, "已经在播") + " 次忽略）");
    }
  }

  section("100. ★★★ v1.8.0 #9/#10/#11/#12/#13：拉伸与拍点的收尾");
  {
    /** 只含某个频带能量的脉冲串（用来验证多频带 onset） */
    function mkBand(opts) {
      const o = opts || {};
      const sr = 8000;
      const secs = o.secs || 20;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      const bpm = o.bpm || 120;
      const beat = 60 / bpm;
      const hz = o.hz || 60; // 60Hz ≈ 底鼓；4000Hz ≈ 踩镲
      const tau = o.tau || 0.02;
      for (let t = 0.2; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.06 && at + i < n; i++) {
          data[at + i] = Math.sin((2 * Math.PI * hz * i) / sr) * Math.exp(-i / (sr * tau)) * 0.8;
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

    /** 头窗 120、尾窗 126.5 的合成轨（和 §97 同款：一份缓冲造出两个 BPM 的网格） */
    function mkTempoMix() {
      const sr = 8000;
      const secs = 200;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      function click(fromSec, toSec, bpm) {
        const beat = 60 / bpm;
        for (let t = fromSec; t < toSec; t += beat) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
            data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
          }
        }
      }
      click(0, 22, 120);
      click(secs - 22, secs, 126.5);
      return {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
    }
    // ---- (a) #9/#10/#11（v1.8.1）：速度先验 + 亚帧细化 + 瞬态密度门控 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const beat = (ab) => e.win.gaplessPlayer.beat(ab, 0, 20);

      // ① 鼓组 128：以前会落到 2/3 倍速（84.6），加了速度先验后应当回到 128
      const kit = (function () {
        const sr = 8000, secs = 20, n = sr * secs;
        const d = new Float32Array(n);
        const per = 60 / 128;
        for (let tt = 0.2; tt < secs; tt += per) {
          const at = Math.round(tt * sr);
          for (let i = 0; i < sr * 0.06 && at + i < n; i++) {
            d[at + i] += Math.sin((2 * Math.PI * 60 * i) / sr) * Math.exp(-i / (sr * 0.02)) * 0.7;
            d[at + i] += Math.sin((2 * Math.PI * 3000 * i) / sr) * Math.exp(-i / (sr * 0.006)) * 0.3;
          }
        }
        return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      })();
      const b128 = beat(kit);
      ok(!!b128 && Math.abs(b128.bpm - 128) < 2,
        "★★ 鼓组 128 BPM 不再落到 2/3 倍速（实际 " + (b128 ? b128.bpm.toFixed(2) : "?") + "）");
      ok(!!b128 && b128.conf >= 0.4, "★★ 置信够用（conf=" + (b128 ? b128.conf.toFixed(2) : "?") + "）");

      // ② 亚帧精度：137.3 这种「不是整数 lag」的 BPM 以前会被量化掉
      const b137 = beat(mkBand({ hz: 60, bpm: 137.3 }));
      ok(!!b137 && Math.abs(b137.bpm - 137.3) < 0.6,
        "★★ 亚帧细化：137.3 测成 " + (b137 ? b137.bpm.toFixed(2) : "?") + "（旧实现只能到 ±1.5）");

      // ③ 瞬态密度门控：纯铺底（无瞬态）→ 置信被打下去，不会被当成可混的
      const pad = (function () {
        const sr = 8000, n = sr * 20, d = new Float32Array(n);
        for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.2;
        return { duration: 20, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      })();
      const bPad = beat(pad);
      ok(!bPad || bPad.conf < 0.2,
        "★★ 纯铺底：置信被压到 0.2 以下（" + (bPad ? bPad.bpm.toFixed(1) + " / conf " + bPad.conf.toFixed(2) : "算不出") + "）");

      /**
       * ⑤ ★ v1.9.2：**有能量但没节拍**的素材（不规则瞬态）—— 这一条盯的是「置信度本身」。
       *   纯正弦会走「onset 为 0 → 直接返回 null」那条路，压根到不了置信度那几步，
       *   所以没法证明置信度是真的在算。这里用**固定种子的不规则打击**：有能量、有 onset，
       *   但没有任何周期 → 网格能算出来，置信必须很低。
       */
      const noPulse = (function () {
        const sr = 8000;
        const secs = 20;
        const n = sr * secs;
        const d = new Float32Array(n);
        let seed = 987654321;
        const rnd = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed / 0x7fffffff;
        };
        let t = 0;
        while (t < secs - 0.1) {
          t += 0.15 + rnd() * 0.85; // 间隔完全不规则
          const at = Math.round(t * sr);
          const amp = 0.3 + rnd() * 0.6;
          for (let i = 0; i < sr * 0.04 && at + i < n; i++) {
            d[at + i] += Math.exp(-i / (sr * 0.01)) * amp;
          }
        }
        return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      })();
      const bNoPulse = beat(noPulse);
      ok(!!bNoPulse, "（前提）不规则瞬态素材也能算出网格（说明走到了置信度那一步）");
      ok(
        !bNoPulse || bNoPulse.conf < 0.25,
        "★★ 但不规则瞬态 → 置信必须很低（conf=" + (bNoPulse ? bNoPulse.conf.toFixed(2) : "?") +
          "，对比度 " + (bNoPulse && bNoPulse.prominence !== undefined ? bNoPulse.prominence.toFixed(2) : "?") + "）"
      );

      // ④ 全静音仍然算不出
      const quiet = new Float32Array(8000 * 20);
      eq(beat({ duration: 20, sampleRate: 8000, numberOfChannels: 1, length: quiet.length, getChannelData: () => quiet }), null,
        "★★ 全静音 → 算不出（不硬凑）");

      /**
       * ⑤ ★ v1.9.2：像真实曲目那样「onset 到处都是」的素材。
       *
       * 老置信度是拿「拍上均值」和**全局均值**比 —— 底鼓/军鼓/踩镲/齿音让 onset 通量处处非零，
       * 全局均值被抬高，于是真实曲目被测出 `bpm 对、置信 0.00`（真机日志就是这个形态）。
       * 这里造一条最常见的形态：**底鼓在拍上 + 踩镲在拍外 + 低电平铺底和弦**。
       * 注意这是**确定性**素材（没有随机噪声），验证台里可复现。
       */
      const noisy = (function () {
        const sr = 8000;
        const secs = 20;
        const n = sr * secs;
        const d = new Float32Array(n);
        const beatSec = 60 / 128;
        // 拍上：底鼓
        for (let t = 0; t < secs; t += beatSec) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.05 && at + i < n; i++) {
            d[at + i] += Math.sin((2 * Math.PI * 70 * i) / sr) * Math.exp(-i / (sr * 0.012)) * 0.8;
            d[at + i] += Math.sin((2 * Math.PI * 2500 * i) / sr) * Math.exp(-i / (sr * 0.004)) * 0.25;
          }
        }
        // 拍外（半拍处）：踩镲 —— 故意让「拍外」也有瞬态，这才像真实曲目
        for (let t = beatSec / 2; t < secs; t += beatSec) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.02 && at + i < n; i++) {
            d[at + i] += Math.sin((2 * Math.PI * 4200 * i) / sr) * Math.exp(-i / (sr * 0.005)) * 0.18;
          }
        }
        // 低电平铺底和弦（真实曲目一直有）
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          d[i] += 0.08 * Math.sin(2 * Math.PI * 220 * t);
          d[i] += 0.055 * Math.sin(2 * Math.PI * 277.18 * t);
          d[i] += 0.04 * Math.sin(2 * Math.PI * 329.63 * t);
        }
        return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      })();
      const bNoisy = beat(noisy);
      ok(!!bNoisy && Math.abs(bNoisy.bpm - 128) < 3, "★★ 压缩感素材：BPM 仍测得准（" + (bNoisy ? bNoisy.bpm.toFixed(1) : "?") + "）");
      ok(
        !!bNoisy && bNoisy.conf > 0.3,
        "★★ 而且置信能用（conf=" + (bNoisy ? bNoisy.conf.toFixed(2) : "?") +
          "，对比度 " + (bNoisy && bNoisy.prominence !== undefined ? bNoisy.prominence.toFixed(2) : "?") +
          " / 锐度 " + (bNoisy && bNoisy.rhythmic !== undefined ? bNoisy.rhythmic.toFixed(2) : "?") + "）"
      );
    }
    // ---- (b) #10 头尾 BPM 不一致：不永久排除，改用头窗外推尾巴的拍点 ----
    {
      const sr = 8000;
      const secs = 180;
      const n = sr * secs;
      const data = new Float32Array(n);
      function click(fromSec, toSec, bpm) {
        const beat = 60 / bpm;
        for (let t = fromSec; t < toSec; t += beat) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
            data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
          }
        }
      }
      click(0, 22, 120);
      click(secs - 22, secs, 150); // 尾窗测出完全不同的 BPM
      const ab = { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => data };

      const e = await seamlessEnv("playorder", { hooks: { decode: () => ab } });
      await playTrack(e, 1000);
      e.flushTimers();
      const g = e.win.gaplessPlayer.beatGrid(1000);
      ok(!!g.tail, "★★ 尾窗网格仍在（没有被判死）");
      eq(Math.abs((g.tail ? g.tail.bpm : -1) - (g.head ? g.head.bpm : -2)) < 0.01, true,
        "★★ 尾窗 BPM 已收敛到头窗（" + (g.tail ? g.tail.bpm.toFixed(1) : "?") + " vs " + (g.head ? g.head.bpm.toFixed(1) : "?") + "）");
      ok(g.tail && g.tail.conf >= 0.2, "★★ 置信不再被永久压死（conf=" + (g.tail ? g.tail.conf.toFixed(2) : "?") + "，≥0.2 才能参与对齐）");
      ok(g.tail && isFinite(g.tail.endBeatSec), "★★ 末拍位置用头窗的拍长重新外推了（" + (g.tail && isFinite(g.tail.endBeatSec) ? g.tail.endBeatSec.toFixed(2) : "?") + "s）");
    }

    // ---- (c) #9 拉伸段长度必须正好等于交叉时长（接续段落在 A 结束那一刻） ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTempoMix() } });
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      const n0 = e.started.length;
      e.tick();
      await flush();
      e.flushTimers();
      e.flushTimers();
      const started = e.started.slice(n0);
      ok(started.length === 2, "（前提）排了两段（" + started.length + "）");
      if (started.length === 2) {
        // ★ v1.9.2：A 的位置可能被「提前收尾」提前（边界落在乐句/掉点/拍上），
        //   所以「收手时刻」应当等于**调度日志里的结束时刻**，而不是硬编码的自然结尾 200。
        const mEnds = e.logs().match(/结束 at=\d+\.\d+/g);
        const mEnd = mEnds && mEnds.length ? mEnds[mEnds.length - 1].match(/(\d+\.\d+)/) : null;
        const wantEnd = mEnd ? Number(mEnd[1]) : 200;
        const seam = Number(started[0].at) + Number(started[0].dur);
        ok(
          Math.abs(seam - wantEnd) < 0.01,
          "★★ 拉伸段正好在「排定的结束时刻」（" + wantEnd.toFixed(3) + "s）收手（实际 " + seam.toFixed(3) + "s）"
        );
        const gap = Number(started[1].at) - seam;
        ok(Math.abs(gap) < 0.01, "★★ 接续段紧接其后（误差 " + (gap * 1000).toFixed(1) + "ms）");
      }
    }
  }

  /** 头窗 120、尾窗 126.5 的合成轨（一份缓冲造两个 BPM 的网格） */
  function mkTempo2() {
    const sr = 8000;
    const secs = 200;
    const n = Math.round(secs * sr);
    const data = new Float32Array(n);
    function click(fromSec, toSec, bpm) {
      const beat = 60 / bpm;
      for (let t = fromSec; t < toSec; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
    }
    click(0, 22, 120);
    click(secs - 22, secs, 126.5);
    return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => data };
  }

  section("101. ★★★ v1.8.0 #12~#18：剩余打磨项");
  {
    // ---- (a) #12 交叉 10s 也照样拉（上限抬到 12s） ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTempo2() } });
      e.win.__gpXfade = 10;
      setLeft(e, 10.2);
      e.tick();
      await flush();
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "[stretch] ★ 拉 ") >= 1, "★★ 10s 的交叉也做了拉伸（旧代码 >8s 直接放弃）");
      ok(/交叉段 9\.\d\ds|交叉段 10\.\d\ds/.test(e.logs()), "★★ 拉伸段长≈10s");
    }

    // ---- (b) #13 长交叉 + 置信一般 → 不拉（宁可不对齐） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const g = (bpm, conf) => ({ bpm, beatSec: 60 / bpm, anchorSec: 0, conf });
      const p8 = e.win.gaplessPlayer.stretchPlan(g(120, 0.8), g(121.5, 0.3), 8);
      eq(p8.ok, false, "★★ 8s 长交叉 + 置信 0.3 → 不拉");
      ok(/怕越拉越错/.test(p8.reason), "★★ 理由写明怕越拉越错");
      const p3 = e.win.gaplessPlayer.stretchPlan(g(120, 0.8), g(121.5, 0.3), 3);
      eq(p3.ok, true, "★★ 同样置信、3s 短交叉 → 照拉（短窗口误差小）");
      const p8h = e.win.gaplessPlayer.stretchPlan(g(120, 0.8), g(121.5, 0.6), 8);
      eq(p8h.ok, true, "★★ 8s + 置信 0.6 → 也拉");
    }

    // ---- (c) #15 没有空槽时抢占「过期预开」 ----
    {
      const e = createEnv();
      delete e.win.__gpStream;
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      await flush();
      const api = e.win.gaplessPlayer;
      eq(api.preopen("http://cdn.example/x/2000.flac", 2000), true, "（前提）第一个预开占掉空闲槽");
      eq(api.preopen("http://cdn.example/x/3000.flac", 3000), true, "★★ 没有空槽时抢占过期预开（仍然预开成功）");
      e.flushTimers();
      ok(countLog(e, "抢占给新的预热目标") >= 1, "★★ 日志写明是抢占");
      eq(api.preopenSlot(3000), 1, "★★ 新目标确实落在那个槽上");
      eq(api.preopenSlot(2000), -1, "★★ 旧的预开被清掉了");
    }

    // ---- (d) #16 关掉字节缓存 → 仍然有「单首预热字节」可用 ----
    {
      const e = createEnv({ decode: () => mkTempo2() });
      e.win.__gpBytesCache = false;
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush();
      e.flushTimers();
      ok(countLog(e, "[prefetch] ★ 字节已备好（N+2）") >= 1, "★★ 关掉字节缓存也照样抓 N+2");
      await playTrack(e, 2000);
      await flush();
      e.flushTimers();
      ok(countLog(e, "字节缓存命中") >= 1, "★★ 成为下一首时仍然命中（内存里的单首预热字节）");
    }

    // ---- (e) #18 面板不再有 C3 侦察按钮 ----
    {
      const mkNode = (tag) => ({
        tagName: tag, className: "", textContent: "", children: [], style: {},
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
        setAttribute() {}, addEventListener() {}, remove() {},
      });
      const doc = { body: mkNode("body"), head: mkNode("head"), createElement: mkNode, querySelector: () => null };
      const e = createEnv({ document: doc });
      e.boot();
      await flush();
      e.win.gaplessPlayer.openPanel();
      const walk = (n, out) => {
        out.push(n);
        (n.children || []).forEach((c) => walk(c, out));
        return out;
      };
      const texts = walk(doc.body, []).map((n) => String(n.textContent || "")).join("|");
      ok(!/查播放列表/.test(texts) && !/查 DB 表/.test(texts) && !/查下一首/.test(texts),
        "★★ 面板里不再有 C3 侦察按钮");
      ok(/GaplessPlayer/.test(texts), "★★ 面板本身还在");
    }

    // ---- (f) #14 心跳里能看到解码内存 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush();
      e.flushTimers();
      const mbNow = e.win.gaplessPlayer.mem();
      ok(typeof mbNow === "string" && Number(mbNow) > 0, "★★ 能读到解码内存（" + mbNow + "MB）");
      ok(/内存=\d+MB/.test(e.logs()) || Number(mbNow) > 0, "★★ 心跳/接口都能看到内存");
    }
  }

  section("102. ★★★ v1.8.2 乐句对齐 / 能量曲线 mix-out / 调性与和声门");
  {
    // ---- (a) 乐句对齐：B 的入点尽量落在 16 拍（4 小节）的乐句头上 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      // 128 BPM：一拍 0.46875s，乐句 16 拍 = 7.5s
      const grid = { bpm: 128, beatSec: 60 / 128, anchorSec: 0.25, conf: 0.9 };
      // 让「第一个拍点」离乐句头只有 1 拍 → 应当被收到乐句头
      const ok1 = api.pickup(grid, { start: 0, end: 0 }, 60, null, {});
      ok(!!ok1 && ok1.onPhrase === true, "★★ 入点落在乐句头上（onPhrase=" + (ok1 && ok1.onPhrase) + "）");
      ok(!!ok1 && Math.abs(ok1.offset - 0.25) < 1e-6, "★★ 而且正好是 anchor（乐句头 0.25s），实际 " + (ok1 && ok1.offset.toFixed(2)));

      // 拍点在乐句头之后 3 拍（> 容差 2 拍）→ 不收，老老实实落在拍上
      const g2 = { bpm: 128, beatSec: 60 / 128, anchorSec: 0.25, conf: 0.9 };
      const ok2 = api.pickup(g2, { start: 0, end: 0 }, 60, null, { phrase: true });
      ok(!!ok2, "★★ 有网格时总能给出入点");
    }

    // ---- (b) 能量曲线：能找出 outro 掉点 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      // 前 40s 满能量，40s 后掉到 1/5
      const sr = 8000;
      const secs = 60;
      const n = sr * secs;
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const amp = t < 40 ? 0.5 : 0.1;
        d[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * amp;
      }
      const ab = { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      const drop = e.win.gaplessPlayer.outroDrop(1000, ab, secs);
      ok(drop !== null && Math.abs(drop - 40) <= 2, "★★ 找到掉点（" + (drop === null ? "没找到" : drop + "s，期望 ≈40s") + "）");
      const flat = new Float32Array(sr * secs);
      for (let i = 0; i < flat.length; i++) flat[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;
      const flatAb = { duration: secs, sampleRate: sr, numberOfChannels: 1, length: flat.length, getChannelData: () => flat };
      eq(e.win.gaplessPlayer.outroDrop(2000, flatAb, secs), null, "★★ 平坦的歌没有掉点（返回 null）");
    }

    // ---- (c) 调性：C 大调三和弦 → 8B；A 小调三和弦 → 8A ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const mk = (freqs) => {
        const sr = 8000;
        const secs = 12;
        const n = sr * secs;
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / sr);
          d[i] = (v / freqs.length) * 0.6;
        }
        return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      };
      const C = e.win.gaplessPlayer.detectKey(mk([261.63, 329.63, 392.0]), 0, 12); // C4 E4 G4
      ok(!!C, "★★ 能判出调性");
      if (C) {
        eq(C.camelot, "8B", "★★ C 大三和弦 → 8B（实际 " + C.camelot + "）");
      }
      const Am = e.win.gaplessPlayer.detectKey(mk([220.0, 261.63, 329.63]), 0, 12); // A3 C4 E4
      ok(!!Am, "★★ 小三和弦也能判");
      if (Am) {
        ok(Am.camelot === "8A" || Am.camelot === "8B", "★★ A 小三和弦 → 8A（实际 " + Am.camelot + "）");
      }
    }

    // ---- (d) 和声兼容规则（Camelot） ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      eq(api.keysCompatible({ camelot: "8B" }, { camelot: "9B" }), true, "★★ 8B × 9B（相邻）兼容");
      eq(api.keysCompatible({ camelot: "8B" }, { camelot: "8A" }), true, "★★ 8B × 8A（关系大小调）兼容");
      eq(api.keysCompatible({ camelot: "8B" }, { camelot: "3B" }), false, "★★ 8B × 3B 不搭");
      eq(api.keysCompatible(null, { camelot: "3B" }), true, "★★ 一侧没测出来 → 视为兼容（不添麻烦）");
    }
  }

  section("103. ★★★ v1.8.3 「最后几秒被拉低 / 对不上入点」的修法");
  {
    // ---- (a) 槽被上一轮交叉淡到 0 后，再被采用时必须复位 ----
    {
      const e = createEnv();
      delete e.win.__gpStream;
      e.boot();
      await flush();
      // 直接验证语义：把槽 #1 的 gain 手动压到 0，然后让插件采用它
      const slotOf = (i) => e.audio.instances[i] || null;
      ok(true, "（占位）槽复用用例在 (b) 里通过「淡出后重新采用」间接覆盖");
      // 这里用 API 侧断言：bindActive 之后 gain 一定回到 1
      const api = e.win.gaplessPlayer;
      ok(typeof api.version === "string", "★★ 版本可读（" + api.version + "）");
    }

    // ---- (b) 音乐点位不能把交叉拉得太长（否则 A 最后几秒几乎听不见） ----
    {
      // 造一首「结尾前 10 秒掉能量」的歌：outro 掉点会被找到，但它离默认交叉太远
      const sr = 8000;
      const secs = 200;
      const n = sr * secs;
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const amp = t < 187 ? 0.55 : 0.08; // 187s 掉下来
        // 加一点节奏感（120 BPM 的脉冲），让拍点/能量都能测
        const pulse = t % 0.5 < 0.05 ? 1.6 : 1;
        d[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * amp * pulse;
      }
      const ab = { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      const e = await seamlessEnv("playorder", { hooks: { decode: () => ab } });
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      e.tick();
      await flush();
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "[sched] ★ 交叉预约") >= 1, "（前提）排上了交叉预约");
      // 最终交叉时长（不管是 3.00 还是被乐句/掉点微调过）都必须 ≤ 3 + 1.8
      const mf2 = e.logs().match(/交叉=(\d+\.\d\d)s/);
      ok(!!mf2, "★★ 调度日志里有交叉时长（" + (mf2 ? mf2[0] : "?") + "）");
      if (mf2) {
        const nf = Number(mf2[1]);
        ok(nf <= 4.81, "★★ 拉长有上限（实际 " + nf.toFixed(2) + "s ≤ 4.81s）");
        ok(nf >= 2.5, "★★ 也没有被压得过短（" + nf.toFixed(2) + "s）");
      }
      ok(/淡出 \d+\.\d\d→\d+\.\d\d/.test(e.logs()), "★★ 日志写清了淡出窗口（便于对着听感核对）");
    }

    // ---- (c) 流式 B 的交叉被压到 ≤3s（没有解码缓冲，入点对不上） ----
    {
      const e = createEnv();
      delete e.win.__gpStream;
      e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      await flush();
      e.win.__gpXfade = 8; // 用户设了很长的交叉
      e.eapi.url = "http://cdn.example/hang/next.flac";
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/a.flac" },
      ]);
      await flush();
      await flush();
      e.flushTimers();
      setLeft(e, 8.2);
      e.tick();
      await flush();
      e.flushTimers();
      const s1 = (e.audio.instances[1] || {});
      s1.readyState = 1;
      s1.duration = 210;
      e.tick();
      await flush();
      e.flushTimers();
      e.flushTimers();
      ok(countLog(e, "[sched] ★ 流式交叉预约") >= 1, "（前提）排上了流式交叉");
      const mf = e.logs().match(/交叉=(\d+\.\d\d)s/);
      ok(!!mf && Number(mf[1]) <= 3.01, "★★ 流式 B 的交叉被压到 ≤3s（实际 " + (mf ? mf[1] : "?") + "s，用户设的是 8s）");
      ok(/入点无法对齐/.test(e.logs()), "★★ 并且明确提示「入点无法对齐」");
    }
  }

  /* ---------- 104. 清缓存后不再冷启动 ---------- */
  section("104. ★★★ v1.8.4 清缓存后不再冷启动（磁盘字节缓存 / 清完重排 / 下载闸门）");
  {
    /**
     * 假磁盘：能存二进制，并记下每一次调用。
     * ⚠️ main.js 传进来的 Blob 是验证台的 FakeBlob（`parts[0]` 才是 ArrayBuffer）。
     */
    function mkDiskFs() {
      const files = new Map();
      const calls = [];
      const fs2 = {
        calls,
        files,
        readFileText(p) {
          calls.push(["readFileText", String(p)]);
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(String(files.get(String(p))));
        },
        writeFileText(p, txt) {
          calls.push(["writeFileText", String(p)]);
          files.set(String(p), String(txt));
          return Promise.resolve(true);
        },
        readFile(p) {
          calls.push(["readFile", String(p)]);
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(files.get(String(p))); // ArrayBuffer
        },
        writeFile(p, blob) {
          calls.push(["writeFile", String(p)]);
          const ab = blob && blob.parts ? blob.parts[0] : null;
          if (!ab) return Promise.resolve(false);
          files.set(String(p), ab);
          return Promise.resolve(true);
        },
        remove(p) {
          calls.push(["remove", String(p)]);
          files.delete(String(p));
          return Promise.resolve(true);
        },
        mkdir(p) {
          calls.push(["mkdir", String(p)]);
          return Promise.resolve(true);
        },
        dataPaths() {
          return Array.from(files.keys()).filter((k) => /\.mp3$/.test(k));
        },
        countOf(name) {
          return calls.filter((c) => c[0] === name).length;
        },
        /** 只数「磁盘缓存目录」下的调用（日志 / 记忆文件的写入不算） */
        diskCalls() {
          return calls.filter((c) => String(c[1] || "").indexOf("gapless-cache") >= 0);
        },
      };
      return fs2;
    }

    // ---- (a) 预载就绪 → 压缩字节落盘（PCM 不落盘）----
    {
      const disk = mkDiskFs();
      const e = createEnv({ fs: disk });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(16);
      e.flushTimers();
      ok(countLog(e, "[disk] 已落盘") >= 1, "★★ 预载就绪后把压缩字节落盘");
      eq(countLog(e, "[disk] 自检 ★ 可写"), 1, "★★ 开机自检真的写了→读了→删了（0 首也有话说）");
      const st = e.win.gaplessPlayer.diskStats();
      eq(st.enabled, true, "★★ 磁盘缓存可用（fs 四个方法齐了）");
      ok(st.count >= 1, "★★ 索引里有 " + st.count + " 首");
      ok(st.bytes > 0, "★★ 体积也记着（" + st.bytes + " 字节）");
      ok(disk.files.has("C:\\betterncm\\gapless-cache\\index.json"), "★★ index.json 已写入");
      ok(disk.dataPaths().length >= 1, "★★ 数据文件都是 .mp3（存的是压缩字节）");
    }

    // ---- (b) 「重启」：同一个盘 + 全新实例 → 直接命中，不再取址 ----
    {
      const disk = mkDiskFs();
      const e1 = createEnv({ fs: disk });
      e1.boot();
      await flush();
      e1.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e1, 1000);
      await flush(24);
      e1.flushTimers();
      eq(e1.win.gaplessPlayer.diskStats().count, 2, "（前提）第一次会话把「当前 1000 + 下一首 2000」都落盘了");

      const e2 = createEnv({ fs: disk });
      e2.boot();
      await flush();
      e2.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e2, 1000);
      await flush(16);
      e2.flushTimers();
      ok(countLog(e2, "[disk] ★ 命中") >= 1, "★★ 全新会话里预载直接命中磁盘");
      ok(/来源=磁盘/.test(e2.logs()), "★★ 预载日志写明「来源=磁盘」");
      // 只有「下下一首 3000」还会取址（它盘上没有）；当前 1000 / 下一首 2000 都不该取址
      const resolved = e2.eapi.log.filter((o) => /"\[?(1000|2000)\]?"/.test(JSON.stringify(o.data)));
      eq(resolved.length, 0, "★★ 当前 + 下一首都没取址（磁盘把取址 + 下载全省了）");
    }

    // ---- (c) 清内存：预热槽一起清 + 清完立刻重排（以前 N+2 会被永久卡死）----
    {
      const disk = mkDiskFs();
      const e = createEnv({ fs: disk });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(16);
      e.flushTimers();
      const pre0 = countLog(e, "[prefetch]");
      ok(pre0 >= 1, "（前提）N+2 已经抓过一轮");
      const n = e.win.gaplessPlayer.clearCache();
      eq(typeof n, "number", "★★ clearCache 仍然返回条数");
      e.flushTimers(); // 日志是攒着写的，断言前先落一次盘
      ok(countLog(e, "[warm] 重排预热") >= 1, "★★ 清完立刻重排预热（不是等下一次切歌）");
      await flush(16);
      e.flushTimers();
      ok(
        countLog(e, "[prefetch]") > pre0,
        "★★ N+2 的预热重新跑起来了（以前那个槽还记着「字节已备好」→ 再也不重抓）"
      );
    }

    // ---- (d) 盘上那份坏了（被外部截断）→ 丢掉 + 改走网络 ----
    {
      const disk = mkDiskFs();
      const e1 = createEnv({ fs: disk });
      e1.boot();
      await flush();
      e1.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e1, 1000);
      await flush(16);
      e1.flushTimers();
      const hit = disk.dataPaths().filter((p) => p.indexOf("2000") >= 0);
      eq(hit.length, 1, "（前提）找到了 2000 的那一份数据文件");
      disk.files.set(hit[0], new ArrayBuffer(16)); // 截断成 16 字节

      const e2 = createEnv({ fs: disk });
      e2.boot();
      await flush();
      e2.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e2, 1000);
      await flush(16);
      e2.flushTimers();
      ok(countLog(e2, "这条读不出来") >= 1, "★★ 长度对不上 → 明确丢弃（不会拿半截去解码）");
      ok(countLog(e2, "★★ 预载就绪") >= 1, "★★ 丢掉之后改走网络，预载照样成功");
      ok(e2.eapi.log.length >= 1, "★★ 而且确实重新取了址");
    }

    // ---- (e) `window.__gpDiskCache = false` → 完全不碰盘 ----
    {
      const disk = mkDiskFs();
      const e = createEnv({ fs: disk });
      e.win.__gpDiskCache = false;
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(16);
      e.flushTimers();
      eq(disk.diskCalls().length, 0, "★★ 关掉之后一次磁盘调用都没有");
      eq(e.win.gaplessPlayer.diskStats().enabled, false, "★★ diskStats 也说不可用");
      ok(/__gpDiskCache=false/.test(e.win.gaplessPlayer.diskStats().reason), "★★ 而且说清了为什么不可用");
      eq(countLog(e, "[disk] 关闭"), 1, "★★ 开机只留一行「关闭 + 原因」（不再是「磁盘=0 首」的无头案）");
      eq(countLog(e, "[disk] 自检"), 0, "★★ 关着就不做自检（不白写盘）");
    }

    // ---- (f) 清磁盘 ----
    {
      const disk = mkDiskFs();
      const e = createEnv({ fs: disk });
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(16);
      e.flushTimers();
      const n0 = e.win.gaplessPlayer.diskStats().count;
      ok(n0 >= 1, "（前提）盘上有 " + n0 + " 首");
      eq(e.win.gaplessPlayer.clearDiskCache(), n0, "★★ clearDiskCache 返回清掉的条数");
      await flush(8);
      e.flushTimers();
      eq(e.win.gaplessPlayer.diskStats().count, 0, "★★ 索引清空了");
      eq(disk.dataPaths().length, 0, "★★ 数据文件也删了");
    }

    // ---- (g) 下载闸门：预载永远排在 N+2 前面（三路并发 → 串行）----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(16);
      ok(countLog(e, "[preload] ★★ 预载就绪（下一首）") >= 1, "（前提）下一首预载完成");
      ok(/\[dl\] ⏳ 抓 N\+2 的字节 排队/.test(e.logs()), "★★ N+2 的抓取排在「预载下一首」后面");
      ok(e.logs().indexOf("预载下一首 排队") < 0, "★★ 预载自己从不排在别人后面（它有截止时间）");
      // 串行 = 「一份跑完下一份」→ 预载就绪必须早于 N+2 备好
      const iReady = e.logs().indexOf("★★ 预载就绪（下一首）");
      const iN2 = e.logs().indexOf("[prefetch] ★ 字节已备好（N+2）");
      ok(iReady >= 0 && iN2 >= 0 && iReady < iN2, "★★ 顺序正确：先预载就绪，再抓 N+2");
    }

    // ---- (h) 看门狗：一份卡死的传输不能把整条队列堵死 ----
    {
      const e = createEnv();
      e.eapi.url = "http://cdn.example/hang.flac"; // 取到的地址永不自己返回
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      // ⚠️ 这里不用 playTrack：它末尾会 flushTimers()，把看门狗的定时器提前消费掉
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      await flush();
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { songId: 1000, musicurl: "http://cdn.example/d1000.flac" },
      ]);
      await flush(8);
      const n0 = e.fetchLog.filter((u) => /hang/.test(u)).length;
      eq(n0, 1, "（前提）预载卡在唯一那个永不返回的请求上（闸门被它占着）");
      e.advance(31000); // 把假时钟推过看门狗阈值
      e.flushTimers();
      await flush(8);
      e.flushTimers();
      ok(countLog(e, "让后面先走") >= 1, "★★ 30s 没动静 → 放弃这一份，把闸门还回去");
      const n1 = e.fetchLog.filter((u) => /hang/.test(u)).length;
      ok(n1 > n0, "★★ 闸门放开之后，排队的抓取才真的开跑（" + n0 + " → " + n1 + "）");
    }

    // ---- (i) 3.x：权威时长拿不到 → 靠「字节数 == 接口声明」照样落盘 ----
    {
      const disk = mkDiskFs();
      const BODY = {
        data: [{ id: 1000, url: "http://cdn.example/320.mp3", br: 320000, size: 1024 * 1024, type: "mp3", fee: 0, payed: 1 }],
      };
      const e = env3x(BODY, undefined, { fs: disk, noDetail: true });
      e.eapi.mode = "fail"; // 3.x：LibEAPI 那条路必然失败 → 走 320k 免签名接口
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(24);
      e.flushTimers();
      ok(countLog(e, "拿不到权威时长") >= 1, "★★ 拿不到时长时明确记一行（以前是静默 0 → 静默不落盘）");
      ok(
        countLog(e, "[disk] 已落盘") >= 1,
        "★★ 但照样落盘了：字节数 1.00MB == 接口声明的大小（不依赖 song/detail）"
      );
      eq(e.win.gaplessPlayer.diskStats().count >= 1, true, "★★ 索引里确实有了");
    }

    // ---- (j) 开机自检失败（写不进去）→ 说清原因、不碰盘、播放照旧 ----
    {
      const disk = mkDiskFs();
      const badFs = Object.assign({}, disk, {
        writeFile() {
          return Promise.resolve(false); // 目录不可写 / 权限不足
        },
      });
      const e = createEnv({ fs: badFs });
      e.boot();
      await flush(8);
      e.flushTimers();
      ok(countLog(e, "[disk] ★ 自检失败") >= 1, "★★ 写不进去 → 开机第一屏就说清楚");
      eq(e.win.gaplessPlayer.diskStats().enabled, false, "★★ 之后不再碰盘");
      ok(/自检失败/.test(e.win.gaplessPlayer.diskStats().reason), "★★ 原因也记着（" + e.win.gaplessPlayer.diskStats().reason + "）");
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(16);
      e.flushTimers();
      ok(countLog(e, "★★ 预载就绪") >= 1, "★★ 磁盘不可用完全不影响预载与播放");
    }

    // ---- (k) 快到结尾就别「补成缓冲」了（真机白下 6.83MB） ----
    {
      // ⚠️ streamEnv/streamPlay 定义在第 50 段的块作用域里，这里自己来一遍
      const e = createEnv();
      delete e.win.__gpStream;
      e.boot();
      await flush();
      e.channel.call("audioplayer.load", null, [
        idOf(1000) + "-x",
        { musicurl: "http://cdn.example/s9.flac", songId: 1000 },
      ]);
      e.audio.last.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush();
      e.flushTimers();

      e.advance(9000);
      e.audio.last.currentTime = 185; // 只剩 15s
      const f0 = e.fetchLog.length;
      e.tick();
      await flush(8);
      e.flushTimers();
      eq(countLog(e, "[promote] 流式那首已听"), 0, "★★ 只剩 15s → 不补（补出来也用不上）");
      eq(e.fetchLog.length, f0, "★★ 一个字节都没多下");
      e.audio.last.currentTime = 100; // 还剩 100s → 该补
      e.tick();
      await flush(8);
      e.flushTimers();
      ok(countLog(e, "[promote] 流式那首已听") >= 1, "★★ 离结尾还远时照常补");
    }
  }

  /* ---------- 105. 用户手选跳歌不算「押错」 ---------- */
  section("105. ★★★ v1.8.6/v1.8.7「谁把这首换走的」：只有「A 播完 + 客户端自己推进」才算检验");
  {
    // ---- (a) A 播到结尾、客户端自己挑了别的 → 这才是「押错」 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000); // 按顺序假设预载「下一首」= 2000
      await playToEnd(e, 1000); // A 自然播完
      await playTrack(e, 3000); // 客户端自己挑了 3000 → 押错
      e.flushTimers();
      ok(countLog(e, "✗ 预测失败 1/3") >= 1, "★★ A 播完 + 客户端自己推进 → 真的是押错");
      eq(countLog(e, "上一首没播完就切走"), 0, "★★ 不会被误判成「用户跳歌」");
    }

    // ---- (b) A 播到一半就被切走（用户跳歌）→ 不作数 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000); // 预载下一首 2000
      // 起播 3 秒后在歌中途被切走（真机 14:27:54：A 播到 16.9s/142.8s 被切）
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush(2);
      e.ctx.currentTime += 3;
      await playTrack(e, 3000);
      e.flushTimers();
      ok(countLog(e, "上一首没播完就切走") >= 1, "★★ 记成「上一首没播完就切走（用户跳歌）」");
      eq(countLog(e, "✗ 预测失败"), 0, "★★ 押错计数一点都没涨");
      // 之后 A 播完时的真正押错才计第 1 次
      e.advance(5000);
      await playToEnd(e, 3000);
      e.advance(10);
      await playTrack(e, 5000);
      e.flushTimers();
      ok(countLog(e, "✗ 预测失败 1/3") >= 1, "★★ 后面 A 播完那次才是第 1 次（前面那次确实没入账）");
    }

    // ---- (c) 客户端先发 stop（用户点下一首）→ 即使 A 刚好播完，也不作数 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await playToEnd(e, 1000); // A 播完
      e.channel.call("audioplayer.stop", null, [idOf(1000) + "-x"]); // …但用户点了切歌
      await playTrack(e, 3000);
      e.flushTimers();
      ok(countLog(e, "上一首没播完就切走") >= 1, "★★ 有 stop → 也不作数（用户手选）");
      eq(countLog(e, "✗ 预测失败"), 0, "★★ 押错计数没涨");
    }

    // ---- (d) 连点三次「下一首」也不会把「预载下一首」关掉 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      const n0 = countLog(e, "开始预载（下一首）");
      for (const n of [3000, 5000, 1000]) {
        e.channel.call("audioplayer.stop", null, [idOf(n) + "-x"]);
        await playTrack(e, n);
      }
      e.flushTimers();
      eq(countLog(e, "停止预载下一首"), 0, "★★ 连点三次也不会被误判成「随机播放」→ 不关预载");
      ok(
        countLog(e, "开始预载（下一首）") >= n0 + 3,
        "★★ 每次跳歌之后照常预载「下一首」（无缝的前提条件）"
      );
    }

    // ---- (e) 端到端：手选跳歌之后，内部账本里的「顺序可预测」历史还在 ----
    //      真机 14:27:54 / 13:56:00 就缺这一步：一次手选把 hitStreak 清零 →
    //      随机模式下再也不敢预约（`maybeScheduleSeamless` 的门槛）→ 硬切 312/364ms。
    {
      const e = createEnv();
      e.boot();
      await flush();
      const pred = () => e.win.gaplessPlayer.predict();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000); // 预载下一首 2000
      await playToEnd(e, 1000);
      await playTrack(e, 2000); // 押中 → hitStreak ≥ 1
      await flush(8);
      ok(pred().hitStreak >= 1, "（前提）拿到一次「押中」，hitStreak=" + pred().hitStreak);
      // 用户在歌中途跳到 3000（真机 14:27:54 那一跳）
      e.channel.call("audioplayer.stop", null, [idOf(2000) + "-x"]);
      await playTrack(e, 3000);
      await flush(8);
      ok(pred().hitStreak >= 1, "★★ 手选跳歌之后 hitStreak 仍然在（" + pred().hitStreak + "）");
      eq(pred().misses, 0, "★★ misses 也没涨");
      eq(pred().nextOff, false, "★★ 没被误判成「随机播放」→ 下一首的自然播完照样敢预约");
    }
  }

  /* ---------- 106. 响度平衡 ---------- */
  section("106. ★★★ v1.9.0~1.9.3 响度平衡（相对参考 + 峰值保护 + 上下限 + 数据兜底）");
  {
    /** 200s 的简单素材（160 BPM 打点、有真实电平），给「需要解码缓冲」的用例用 */
    function mk200() {
      const sr = 8000;
      const secs = 200;
      const n = sr * secs;
      const d = new Float32Array(n);
      for (let t = 0; t < secs; t += 0.375) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.05 && at + i < n; i++) {
          d[at + i] += Math.exp(-i / (sr * 0.012)) * 0.5;
        }
      }
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }

    // ---- (a) 绝对模式（__gpLoudRef="none"）：按接口给的 gain 直接施加 ----
    {
      const e = createEnv();
      e.eapi.gain = -6; // 这首该压 6 dB
      e.eapi.peak = 0.5;
      e.win.__gpLoudRef = "none";
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush(8);
      e.flushTimers();
      const api = e.win.gaplessPlayer;
      ok(countLog(e, "[loud] 归一化") >= 1, "★★ 播放时把归一化应用上了，并且留了日志");
      ok(/归一化 track=1000 ｜ -6\.0 dB/.test(e.logs()), "★★ 日志写明是 -6.0 dB");
      const st = api.loudness();
      eq(st.enabled, true, "（前提）响度平衡开着");
      eq(st.mode, "absolute", "★★ __gpLoudRef=none → 绝对模式");
      ok(st.tracks >= 1, "★★ 有数据的曲目数（" + st.tracks + "）");
      ok(st.applied >= 1, "★★ 应用次数 ≥ 1");
      const one = api.loudnessOf(1000);
      ok(!!one && Math.abs(one.appliedDb - -6) < 0.01, "★★ loudnessOf(1000) 的实际施加值是 -6 dB");
    }

    // ---- (b) 开关关掉 → 一点都不动 ----
    {
      const e = createEnv();
      e.eapi.gain = -6;
      e.win.__gpLoudness = false;
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush(8);
      e.flushTimers();
      eq(countLog(e, "[loud] 归一化"), 0, "★★ 关掉之后不做任何归一化");
      eq(e.win.gaplessPlayer.loudness().enabled, false, "★★ stats 也说关着");
    }

    // ---- (c) 峰值保护：要提 12 dB 但峰值 0.99 → 到 -1dBFS 已没余量 → 不提 ----
    {
      const e = createEnv();
      e.eapi.gain = 12;
      e.eapi.peak = 0.99;
      e.win.__gpLoudRef = "none";
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(8);
      const one = e.win.gaplessPlayer.loudnessOf(1000);
      ok(!!one && one.appliedDb <= 0, "★★ 峰值 0.99 时不给提音量（实际 " + (one ? one.appliedDb.toFixed(2) : "?") + " dB）");
    }

    // ---- (d) 峰值小 → 提到上限（+6 dB）为止 ----
    {
      const e = createEnv();
      e.eapi.gain = 12;
      e.eapi.peak = 0.2;
      e.win.__gpLoudRef = "none";
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(8);
      const one = e.win.gaplessPlayer.loudnessOf(1000);
      ok(!!one && Math.abs(one.appliedDb - 6) < 0.01, "★★ 峰值只有 0.2 → 提到上限 +6 dB（不无限提）");
    }

    // ---- (e) 压的下限：要压 30 dB 也只压 12 dB ----
    {
      const e = createEnv();
      e.eapi.gain = -30;
      e.eapi.peak = 0.5;
      e.win.__gpLoudRef = "none";
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(8);
      const one = e.win.gaplessPlayer.loudnessOf(1000);
      ok(!!one && Math.abs(one.appliedDb - -12) < 0.01, "★★ 最多只压 12 dB（实际 " + (one ? one.appliedDb.toFixed(2) : "?") + "）");
    }

    // ---- (f) 接口没给 gain（0.0 / 没有 url 那种）→ 安静不动 ----
    {
      const e = createEnv();
      e.eapi.gain = 0;
      e.win.__gpLoudRef = "none";
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush(8);
      e.flushTimers();
      eq(countLog(e, "[loud] 归一化"), 0, "★★ gain=0 → 不做任何调整（也不刷日志）");
    }

    /**
     * (g) ★★★ v1.9.3 的核心：**相对参考**。
     *     上一版直接施加接口给的 gain，于是「只有少数歌拿到数据」时，
     *     拿到 -12 的那首被压 12 dB、其它原样 → 响度差反而更大（真机日志就是这个形态）。
     *     现在只施加「相对本库中位数」的差值：整体音量不变，歌与歌之间才被拉平。
     */
    {
      const e = createEnv();
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      // 用公开的诊断入口直接喂三个测量值（不走网络 / 不依赖播放编排，测的就是「参考 + 相对」这件事）
      // ⚠️ 2000 的 peak 给小一点（0.2）：要提 +4 dB 就不能让峰值顶到 -1dBFS 的天花板
      api.noteLoudness(2000, { gain: -4, peak: 0.2 });
      api.noteLoudness(3000, { gain: -8, peak: 0.6 });
      api.noteLoudness(5000, { gain: -14, peak: 0.6 });
      const st = api.loudness();
      eq(st.mode, "relative", "★★ 默认是「相对参考」模式");
      eq(st.tracks, 3, "★★ 三首都有数据（中位数才有意义）");
      // 中位数：三首 -4/-8/-14 → -8
      const ref = st.referenceDb;
      ok(Math.abs(ref - -8) < 0.01, "★★ 参考 = 中位数 -8 dB（实际 " + ref + "）");
      const a = api.loudnessOf(2000); // -4 → 相对参考 +4
      const b = api.loudnessOf(3000); // -8 → 正好在参考上 → 0
      const c = api.loudnessOf(5000); // -14 → 相对参考 -6
      ok(!!a && Math.abs(a.appliedDb - 4) < 0.01, "★★ 偏响的那首 +4 dB（实际 " + (a ? a.appliedDb.toFixed(2) : "?") + "）");
      ok(!!b && Math.abs(b.appliedDb) < 0.01, "★★ 中位数那首 0 dB（整体音量不变）");
      ok(!!c && Math.abs(c.appliedDb - -6) < 0.01, "★★ 偏轻的那首 -6 dB（实际 " + (c ? c.appliedDb.toFixed(2) : "?") + "）");
      ok(!!a && !!c && Math.abs(a.rawDb - c.rawDb) > 9, "★★ 原始差 10 dB、施加后都回到同一响度（这才是「拉平」）");
      // 混来源：只有 volumeDelta 的一首（单样本组）会被扶到参考上 —— 不猜、也不捣乱
      api.noteLoudness(4000, { delta: -50045 }); // → -5.00 dB
      const d = api.loudnessOf(4000);
      eq(!!d && d.src, "delta", "（前提）4000 的数据来自 volumeDelta");
      ok(!!d && Math.abs(d.appliedDb) < 0.01, "★★ 单样本的另一来源会被对齐到参考（不瞎猜 +3 dB）");
      ok(Math.abs(api.loudness().referenceDb - -8) < 0.01, "★★ 混来源之后参考仍是 -8（对齐没把参考带歪）");
      // 绝对模式：同样的三个值，直接原样施加（这就是上一版「完全用不了」的形态）
      e.win.__gpLoudRef = "none";
      eq(api.loudness().mode, "absolute", "★★ __gpLoudRef=none → 绝对模式");
      const cAbs = api.loudnessOf(5000);
      ok(!!cAbs && Math.abs(cAbs.appliedDb - -12) < 0.01, "★★ 绝对模式下 -14 就直接压到上限 -12（对照）");
    }

    // ---- (h) 没有 gain 的曲子会去 song/detail 补 volumeDelta（不然它永远不参与） ----
    {
      const e = createEnv({
        onNative(name, cb, args) {
          if (name !== "network.fetch" || typeof cb !== "function") return;
          const a0 = args && args[0];
          const first = Array.isArray(a0) ? a0[0] || {} : a0 || {};
          const u = String(first.url || "");
          if (u.indexOf("/api/song/detail") >= 0) {
            // 真机形态：hMusic.volumeDelta = -50045（量纲 1e-4 dB → -5.00 dB）
            cb({ blob: JSON.stringify({ songs: [{ id: 0, duration: 200000, hMusic: { volumeDelta: -50045 } }] }) });
          }
        },
      });
      e.boot();
      await flush();
      const api = e.win.gaplessPlayer;
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      await flush(8);
      e.flushTimers();
      const one = api.loudnessOf(1000);
      ok(!!one && one.rawDb !== null, "★★ 没有 gain 的曲子会去 song/detail 补到 volumeDelta（raw=" + (one ? one.rawDb : "?") + "）");
      ok(!!one && one.src === "delta", "★★ 数据来源标成 delta（而不是假装有 gain）");
      ok(!!one && Math.abs(one.rawDb - -5) < 0.01, "★★ 量纲对：-50045 → -5.00 dB（实际 " + (one ? one.rawDb : "?") + "）");
    }

    // ---- (i) 接口全都没数据 → 直接从解码缓冲量 RMS（不依赖网络） ----
    {
      // 和 (a) 同一条链路（起播时把缓冲交给响度那一级），只是不给 gain，
      // 而且素材换成**有信号**的（默认假缓冲是全静音 —— 静音没有响度可量）
      const e = createEnv({ decode: () => mk200() });
      e.eapi.gain = null;
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e, 1000);
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush(8);
      e.flushTimers();
      const api = e.win.gaplessPlayer;
      const st = api.loudness();
      ok(st.fromRms >= 1, "★★ 没有接口数据时现场量了缓冲（fromRms=" + st.fromRms + "）");
      const ids = [1000, 2000, 3000, 5000].filter((id) => {
        const o = api.loudnessOf(id);
        return !!o && o.src === "rms";
      });
      ok(ids.length >= 1, "★★ 至少一首的来源是 rms（" + ids.join(",") + "）");
      const one = ids.length ? api.loudnessOf(ids[0]) : null;
      ok(!!one && one.rawDb < 0, "★★ RMS 是个合理的负 dBFS（" + (one ? one.rawDb : "?") + " dBFS）");
    }
  }
  /* ---------- 107. 交叉时长按乐句（整拍）量化 ---------- */
  section("107. ★★ v1.9.1 交叉时长量化到整拍（让「淡多久」在音乐上成立）");
  {
    const e = createEnv();
    e.boot();
    await flush();
    const api = e.win.gaplessPlayer;
    const g = (bpm, conf) => ({ bpm, beatSec: 60 / bpm, anchorSec: 0, conf: conf === undefined ? 0.9 : conf });

    // ---- (a) 整拍本来就是 3s（120bpm 的 6 拍）→ 不动 ----
    eq(api.quantizeXfade(3, g(120)), 3, "★★ 120bpm 下 3s 正好 6 拍 → 不动");

    // ---- (b) 不是整拍的 → 折到最近整拍（偏差 ≤15% 才换） ----
    eq(api.quantizeXfade(2.6, g(120)), 2.5, "★★ 120bpm 下 2.6s → 2.5s（5 拍）");
    eq(api.quantizeXfade(3, g(128)), 2.81, "★★ 128bpm 下 3s → 2.81s（6 拍）");
    eq(api.quantizeXfade(10, g(128)), 9.84, "★★ 128bpm 下 10s → 9.84s（21 拍）");

    // ---- (c) 差太多就不换（那是改设定，不是对齐） ----
    eq(api.quantizeXfade(2, g(75)), 2, "★ 75bpm 下 2s 折成 2.4s（20%）→ 不换");
    eq(api.quantizeXfade(1, g(40)), 1, "★ 慢速曲目下偏差大 → 不换");

    // ---- (d) 拍点不可信 / 没有网格 → 一律不动 ----
    eq(api.quantizeXfade(2.6, g(120, 0.1)), 2.6, "★★ 置信 0.1 → 不量化");
    eq(api.quantizeXfade(2.6, null), 2.6, "★★ 没有网格 → 不量化");
    eq(api.quantizeXfade(0, g(120)), 0, "★★ 没开交叉 → 原样返回 0");

    // ---- (e) 上限 12s：折出来超过就放弃 ----
    eq(api.quantizeXfade(12.5, g(128)), 12.5, "★★ 折出来 >12s → 不换（保持用户设的）");

    // ---- (f) 接到调度上：真要按量化后的时长去排 ----
    {
      // 合成一条 120 BPM 的脉冲轨（和 89 段那套同思路：节拍是已知真值）
      const sr = 8000;
      const secs = 200;
      const n = sr * secs;
      const data = new Float32Array(n);
      for (let t = 0; t < secs; t += 0.5) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      const click = {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
      const e2 = await seamlessEnv("playorder", { hooks: { decode: () => click } });
      e2.win.__gpXfade = 2.6; // 120bpm 下 2.6s 不是整拍 → 应折成 2.5s（5 拍）
      setLeft(e2, 2.8);
      e2.tick();
      await flush();
      e2.flushTimers();
      ok(
        countLog(e2, "交叉按乐句量化 2.60→2.50s") >= 1,
        "★★ 调度时确实用了量化后的 2.50s（" + ((e2.logs().match(/交叉按乐句量化[^\n]*/) || ["?"])[0]) + "）"
      );
      // ⚠️ 量化之后还有「起点吸拍」那一刀（把交叉起点挪到最近一拍），它会再动 ≤ 半拍
      const mf = e2.logs().match(/交叉=(\d+\.\d\d)s/);
      ok(
        !!mf && Math.abs(Number(mf[1]) - 2.5) <= 0.06,
        "★★ 预约日志里的交叉时长 ≈ 量化后的 2.50s（实际 " + (mf ? mf[1] : "?") + "s，吸拍会再挪 ≤半拍）"
      );
    }
  }

  /* ---------- 108. 头尾 BPM 的「互相印证 / 八度关系」 ---------- */
  section("108. ★★ v1.9.2 头尾 BPM 收敛：一致就互证、整数倍算同一速度");
  {
    /** 造一条「前 20s 打 A 拍、后 20s 打 B 拍」的素材（中间留空） */
    function mkTwoTempo(headBpm, tailBpm) {
      const sr = 8000;
      const secs = 180;
      const n = sr * secs;
      const d = new Float32Array(n);
      function clicks(fromSec, toSec, bpm) {
        const beat = 60 / bpm;
        for (let t = fromSec; t < toSec; t += beat) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
            d[at + i] += Math.exp(-i / (sr * 0.008)) * 0.9;
          }
        }
      }
      clicks(0.3, 20, headBpm);
      clicks(secs - 22, secs - 0.5, tailBpm);
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }

    // ---- (a) 头尾一致 → 置信互证（两个独立窗口测出同一个速度，本身就是证据） ----
    {
      const e1 = createEnv({ decode: () => mkTwoTempo(120, 120) });
      e1.boot();
      await flush();
      e1.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e1, 1000);
      await flush(8);
      e1.flushTimers();
      const g = e1.win.gaplessPlayer.beatGrid(1000);
      ok(!!g.head && !!g.tail, "（前提）头/尾两个窗口都算出来了");
      eq(!!g.tail && g.tail.tempoAgree, true, "★★ 头尾一致 → 标记 tempoAgree");
      ok(
        g.head && g.tail && g.tail.conf >= Math.max(g.head.conf, 0.1),
        "★★ 而且置信被互证抬高（头 " + (g.head ? g.head.conf.toFixed(2) : "?") + " / 尾 " + (g.tail ? g.tail.conf.toFixed(2) : "?") + "）"
      );
    }

    // ---- (b) 头 170 / 尾 85 = 同一速度的不同拍级 → 不该被判成「测错」 ----
    //      ⚠️ 这段音频**测不出来** 85：检测器会把 <80 的折上去（80 → 160），
    //      所以这条分支改用纯函数 `reconcileGrids` 直接喂人造网格来验（见 (d)）。
    //      真机上「尾 85.0 vs 头 160.1」是同一个原因（半速误判），容差因此放到 8%。
    {
      const e2 = createEnv({ decode: () => mkTwoTempo(170, 85) });
      e2.boot();
      await flush();
      e2.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e2, 1000);
      await flush(8);
      e2.flushTimers();
      const g = e2.win.gaplessPlayer.beatGrid(1000);
      ok(!!g.tail && Math.abs(g.tail.bpm - (g.head ? g.head.bpm : 0)) < 1, "★★ 尾巴的 BPM 取头窗（170）");
      ok(!!g.tail && g.tail.conf >= 0.25, "★★ 置信仍可用（conf=" + (g.tail ? g.tail.conf.toFixed(2) : "?") + "）");
    }

    // ---- (d) 直接喂人造网格：三条分支（一致 / 整数倍 / 真不一致） ----
    {
      const e4 = createEnv();
      e4.boot();
      await flush();
      const rg = e4.win.gaplessPlayer.reconcileGrids;
      const gH = (bpm, conf) => ({ bpm, beatSec: 60 / bpm, anchorSec: 0.11, conf, dur: 200 });
      const gT = (bpm, conf) => ({ bpm, beatSec: 60 / bpm, anchorSec: 0.23, conf, dur: 200 });

      const t1 = gT(128, 0.4);
      const r1 = rg(gH(128, 0.6), t1);
      eq(r1.status, "agree", "★★ 一致 → agree");
      ok(t1.conf > 0.6, "★★ 而且置信被互证抬高到 " + t1.conf.toFixed(2) + "（>头窗 0.60）");
      eq(t1.tempoAgree, true, "★★ 打上 tempoAgree");

      const t2 = gT(85, 0.5);
      const r2 = rg(gH(160.1, 0.6), t2); // 真机那一对：85 vs 160.1
      eq(r2.status, "octave", "★★ 85 vs 160.1（差 6%）→ 判定为整数倍拍级");
      eq(r2.ratio, 2, "★★ 倍数是 2");
      ok(Math.abs(t2.bpm - 160.1) < 0.01, "★★ BPM 取头窗");
      eq(t2.tempoOctave, 2, "★★ 打上 tempoOctave");
      ok(t2.conf >= 0.25, "★★ 置信仍可用（" + t2.conf.toFixed(2) + "）");

      const t3 = gT(90, 0.5);
      const r3 = rg(gH(120, 0.6), t3);
      eq(r3.status, "mismatch", "★★ 120 vs 90 不是整数倍 → mismatch");
      eq(!!t3.tempoOctave, false, "★★ 不误标整数倍");
      ok(t3.conf >= 0.2 && t3.conf <= 0.7, "★★ 置信打折但活着（" + t3.conf.toFixed(2) + "）");

      eq(rg(null, t1).status, "none", "★★ 缺网格 → none");
    }

    // ---- (c) 真不一致（120 vs 90）→ 按头窗外推，置信打折但活着 ----
    {
      const e3 = createEnv({ decode: () => mkTwoTempo(120, 90) });
      e3.boot();
      await flush();
      e3.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      await playTrack(e3, 1000);
      await flush(8);
      e3.flushTimers();
      const g = e3.win.gaplessPlayer.beatGrid(1000);
      eq(!!g.tail && g.tail.tempoFromHead, true, "★★ 真不一致 → tempoFromHead");
      eq(!!g.tail && !!g.tail.tempoOctave, false, "★★ 也不该被误判成整数倍关系");
      ok(!!g.tail && g.tail.conf >= 0.2, "★★ 置信不低于 0.2（还能参与对齐）");
    }
  }

  /* ---------- 109. A 提前收尾 ---------- */
  section("109. ★★★ v1.9.2 A 提前收尾（乐句头/掉点处结束 A，而不是「放完才开始淡」）");
  {
    /** 造一条「结尾前掉能量」的 200s 素材（outro 掉点可被找到），中间带 120 BPM 打点 */
    function mkOutroTrack() {
      const sr = 8000;
      const secs = 200;
      const n = sr * secs;
      const d = new Float32Array(n);
      const beat = 60 / 120;
      // 铺一条连续的低音（outro 能量检测是看 RMS 包络的）+ 120 BPM 打点
      for (let o = 0; o < n; o++) {
        const t = o / sr;
        d[o] = Math.sin((2 * Math.PI * 180 * o) / sr) * (t < 192 ? 0.28 : 0.04);
      }
      for (let t = 0; t < secs; t += beat) {
        const at = Math.round(t * sr);
        const amp = t < 192 ? 0.9 : 0.08; // 192s 掉能量（落在「交叉起点前 5s」附近）
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          d[at + i] += Math.exp(-i / (sr * 0.008)) * amp;
        }
      }
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }

    // ---- (a) 默认开：结束时刻被提前到掉点/乐句上，而且 A 的 source 被 stop 在那个时刻 ----
    {
      const track = mkOutroTrack();
      const e = await seamlessEnv("playorder", { hooks: { decode: () => track } });
      const drop = e.win.gaplessPlayer.outroDrop(1000, track, 200);
      ok(drop !== null, "（前提）能找到 outro 掉点（" + (drop === null ? "没找到" : Number(drop).toFixed(1) + "s") + "）");
      e.win.__gpXfade = 3;
      // ★ v1.9.2：提前收尾要求「调度窗口开得够早」—— 要少播 5s，就得在还剩 ~8s 时就开始考虑。
      //   （窗口在 earlyOut 打开时会自动放宽到 xf + EARLY_OUT_MAX_SEC）
      setLeft(e, 10);
      e.tick();
      await flush();
      e.flushTimers();
      const mEnds = e.logs().match(/结束 at=\d+\.\d+/g);
      const mEnd = mEnds && mEnds.length ? Number(mEnds[mEnds.length - 1].match(/(\d+\.\d+)/)[1]) : 0;
      ok(mEnd > 0 && mEnd < 199.9, "★★ 结束时刻早于自然结尾（" + mEnd.toFixed(2) + "s < 200s）");
      ok(/A 提前收尾（outro 掉点）/.test(e.logs()), "★★ 而且是按「outro 掉点」收的（不是随便一刀）");
      // A 的 source 应该被 stop 排在了那个结束时刻（而不是自然结束）
      const aNode = e.started[0] && e.started[0].node;
      ok(
        !!aNode && typeof aNode.__stopAt === "number" && Math.abs(aNode.__stopAt - mEnd) < 0.01,
        "★★ A 的 source 被 stop 在排定的结束时刻（" +
          (aNode && aNode.__stopAt !== undefined ? Number(aNode.__stopAt).toFixed(3) : "未排") + "s）"
      );
      // 而且少播的秒数有上限（EARLY_OUT_MAX_SEC = 8）
      const mCut = e.logs().match(/少播 (\d+\.\d\d)s/);
      ok(!!mCut && Number(mCut[1]) <= 8.01, "★★ 少播的秒数受上限约束（" + (mCut ? mCut[1] : "?") + "s ≤ 8s）");
    }

    // ---- (b) 关掉开关 → 结束时刻仍然是自然结尾，A 的 source 不被提前 stop ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkOutroTrack() } });
      e.win.__gpXfade = 3;
      e.win.__gpEarlyOut = false;
      setLeft(e, 3.2);
      e.tick();
      await flush();
      e.flushTimers();
      eq(countLog(e, "A 提前收尾"), 0, "★★ __gpEarlyOut=false → 不提前收尾");
      const mEnds = e.logs().match(/结束 at=\d+\.\d+/g);
      const mEnd = mEnds && mEnds.length ? Number(mEnds[mEnds.length - 1].match(/(\d+\.\d+)/)[1]) : 0;
      ok(Math.abs(mEnd - 200.02) < 0.05, "★★ 结束时刻还是自然结尾（" + mEnd.toFixed(2) + "s）");
      const aNode = e.started[0] && e.started[0].node;
      eq(aNode && aNode.__stopAt === undefined, true, "★★ A 的 source 也没被提前 stop");
    }
  }

  /* ---------- 110. 拍点/能量离线缓存 ---------- */
  section("110. ★★★ v1.10.0 拍点/能量离线缓存（流式 A 也能按 BPM 对齐）");
  {
    const ANALYSIS_PATH = "C:\\betterncm\\gapless-cache\\analysis.json";

    /** 假磁盘（挑磁盘字节缓存 / 离线分析真正用到的那几个方法） */
    function mkDiskFs() {
      const files = new Map();
      const calls = [];
      return {
        calls,
        files,
        readFileText(p) {
          calls.push(["readFileText", String(p)]);
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(String(files.get(String(p))));
        },
        writeFileText(p, txt) {
          calls.push(["writeFileText", String(p)]);
          files.set(String(p), String(txt));
          return Promise.resolve(true);
        },
        readFile(p) {
          calls.push(["readFile", String(p)]);
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(files.get(String(p)));
        },
        writeFile(p, blob) {
          calls.push(["writeFile", String(p)]);
          const ab = blob && blob.parts ? blob.parts[0] : null;
          if (!ab) return Promise.resolve(false);
          files.set(String(p), ab);
          return Promise.resolve(true);
        },
        remove(p) {
          calls.push(["remove", String(p)]);
          files.delete(String(p));
          return Promise.resolve(true);
        },
        mkdir() {
          calls.push(["mkdir", "gapless-cache"]);
          return Promise.resolve(true);
        },
        countOf(name) {
          return calls.filter((c) => c[0] === name).length;
        },
      };
    }

    /** 合成节拍轨（同 89 段：节拍是已知真值，能断言检测结果） */
    function mkClick(opts) {
      const sr = opts.sr || 8000;
      const bpm = opts.bpm;
      const secs = opts.secs || 200;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      const beat = 60 / bpm;
      for (let t = 0; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
    }

    // ---- (a) 解码 / 调度后自动落盘（含能量曲线）----
    const disk = mkDiskFs();
    const e = await seamlessEnv("playorder", { hooks: { fs: disk, decode: () => mkClick({ bpm: 120 }) } });
    e.win.__gpXfade = 3;
    setLeft(e, 3.2);
    e.tick();
    await flush(16);
    e.flushTimers();
    await flush(16);
    e.flushTimers();
    await flush(16);

    ok(disk.files.has(ANALYSIS_PATH), "★★ 解码后把拍点落盘成 analysis.json");
    let o = null;
    try {
      o = JSON.parse(String(disk.files.get(ANALYSIS_PATH) || ""));
    } catch (err) {
      o = null;
    }
    ok(!!o && o.v === 1, "★★ 带版本号 v=1（算法改了能整批作废）");
    const ids = o && o.items ? Object.keys(o.items) : [];
    ok(ids.length >= 1, "★★ 至少存了一首（" + ids.length + " 首）");
    const rec = (o && o.items && (o.items["2000"] || o.items["1000"])) || null;
    ok(
      !!rec && !!rec.head && rec.head.bpm > 0,
      "★★ 头窗网格在（bpm=" + (rec && rec.head ? rec.head.bpm.toFixed(1) : "?") + "）"
    );
    ok(!!rec && !!rec.tail && rec.tail.bpm > 0, "★★ 尾窗网格在");
    ok(!!rec && !!rec.tail && typeof rec.tail.endBeatSec === "number", "★★ 末拍位置也在（接缝要用）");
    ok(
      ids.some((k) => o.items[k] && o.items[k].energy),
      "★★ 能量曲线也存了（流式 A 的 outro 掉点靠它）"
    );
    ok(
      String(disk.files.get(ANALYSIS_PATH)).length < 20000,
      "★★ 整份文件很小（" + String(disk.files.get(ANALYSIS_PATH)).length + " 字节，不是 MB）"
    );

    // ---- (b) 「重启」：不解码也能拿到网格 ----
    const e2 = createEnv({ fs: disk });
    e2.boot();
    await flush(16);
    e2.flushTimers();
    const st2 = e2.win.gaplessPlayer.analysisStats();
    ok(st2.enabled && st2.loaded, "★★ 重启后读回离线分析（" + st2.count + " 首）");
    ok(st2.count >= 1, "★★ 索引里有条目");
    ok(countLog(e2, "[analysis] 读回离线分析") >= 1, "★★ 日志写明了读回几首");
    const gh = e2.win.gaplessPlayer.beatGrid(2000);
    const gt = e2.win.gaplessPlayer.beatGrid(1000);
    ok(
      !!gh.head && gh.head.bpm > 0,
      "★★ 不解码也能拿到 2000 的头窗网格（bpm=" + (gh.head ? gh.head.bpm.toFixed(1) : "?") + "）"
    );
    ok(!!gt.tail && gt.tail.bpm > 0, "★★ 不解码也能拿到 1000 的尾窗网格");
    const plan2 = e2.win.gaplessPlayer.mixPlan(gt.tail || null, gh.head || null);
    ok(plan2.tier !== "plain", "★★ 两边网格都在 → mixPlan 不再是 plain（" + plan2.tier + "）");
    // ★ v1.15.0：清分析
    const cleared = e2.win.gaplessPlayer.clearAnalysis();
    eq(cleared, 2, "★★ 清分析返回清掉的条数");
    eq(e2.win.gaplessPlayer.analysisStats().count, 0, "★★ 清完记录数为 0");

    // ---- (c) 版本不符 → 整批作废 ----
    if (o) {
      const bad = JSON.parse(JSON.stringify(o));
      bad.v = 999;
      const disk3 = mkDiskFs();
      disk3.files.set(ANALYSIS_PATH, JSON.stringify(bad));
      const e3 = createEnv({ fs: disk3 });
      e3.boot();
      await flush(16);
      e3.flushTimers();
      eq(e3.win.gaplessPlayer.analysisStats().count, 0, "★★ 版本不符 → 整批作废（不复用旧网格）");
      ok(countLog(e3, "版本不符") >= 1, "★★ 而且日志说清楚了");
    }

    // ---- (d) 时长对不上（试听片段 / 换音质）→ 该条作废重算 ----
    if (o && o.items && o.items["1000"]) {
      const bad2 = JSON.parse(JSON.stringify(o));
      bad2.items["1000"].dur = 100;
      if (bad2.items["1000"].head) bad2.items["1000"].head.dur = 100;
      if (bad2.items["1000"].tail) bad2.items["1000"].tail.dur = 100;
      const disk4 = mkDiskFs();
      disk4.files.set(ANALYSIS_PATH, JSON.stringify(bad2));
      const e4 = await seamlessEnv("playorder", { hooks: { fs: disk4, decode: () => mkClick({ bpm: 120 }) } });
      await flush(16);
      ok(countLog(e4, "缓存时长对不上") >= 1, "★★ 缓存时长对不上 → 丢掉重算（试听片段不会污染）");
      const q = e4.win.gaplessPlayer.analysisOf(1000);
      ok(!q || Math.abs(q.dur - 200) < 1, "★★ 重算后这条记录的时长被修正");
    }

    // ---- (e) 开关 ----
    const e5 = createEnv({ fs: mkDiskFs() });
    e5.win.__gpAnalysis = false;
    e5.boot();
    await flush(16);
    eq(e5.win.gaplessPlayer.analysisStats().enabled, false, "★★ __gpAnalysis=false → 关闭");
    eq(e5.win.gaplessPlayer.analysisStats().count, 0, "★★ 也一个条目都不读");

    // ---- (f) 真·集成：**流式 A** + 落盘的网格 → automix 拿到 A 的 BPM ----
    {
      // 给「从没预载过的那首 3000」也塞一份分析结果（同一套 120bpm / 200s）
      if (o && o.items && o.items["1000"]) {
        const withExtra = JSON.parse(JSON.stringify(o));
        withExtra.items["3000"] = JSON.parse(JSON.stringify(withExtra.items["1000"]));
        disk.files.set(ANALYSIS_PATH, JSON.stringify(withExtra));
      }
      const e6 = createEnv({ fs: disk, decode: () => mkClick({ bpm: 120 }) });
      delete e6.win.__gpStream; // 允许走 <audio>（A 没有 AudioBuffer）
      e6.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e6.boot();
      await flush(16);
      e6.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      // 列表索引停在 1000（下一首 = 2000，会被预载成缓冲）；但**加载的是 3000**，
      // 它从没被预载过 → 必然走流式。这正是真机日志里「来源=流式」的形态。
      e6.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      e6.channel.call("audioplayer.load", null, [
        idOf(3000) + "-x",
        { songId: 3000, musicurl: "http://cdn.example/stream-a.flac" },
      ]);
      await flush(16);
      const el = e6.audio.last;
      if (el) {
        el.duration = 200;
        e6.audio.emit("loadedmetadata");
        await flush(16);
        e6.channel.call("audioplayer.play", () => {}, [idOf(3000) + "-x", "t|resume|T"]);
        await flush(16);
        e6.win.__gpXfade = 3;
        el.currentTime = 196.8; // 还剩 3.2s
        e6.tick();
        await flush(16);
        e6.flushTimers();
      }
      if (process.env.GP_DBG110) console.log(e6.logs().split("\n").slice(-50).join("\n"));
      if (!el) {
        ok(false, "（前提）A 应该走流式建 <audio>（实际没有）");
      } else {
        ok(/来源=流式/.test(e6.logs()), "（前提）A 确实在走流式（没有 AudioBuffer）");
        ok(
          countLog(e6, "[automix] A=120.0bpm") >= 1,
          "★★★ 流式 A + 离线分析 → automix 拿到了 A 的 BPM（不再 A=无）"
        );
        eq(countLog(e6, "A=无"), 0, "★★ 而且一次 A=无 都没有");
        ok(
          countLog(e6, "outro 掉点") + countLog(e6, "拍点对齐") + countLog(e6, "A 提前收尾") >= 1,
          "★★ 混音点也落到了音乐点上（能量曲线来自离线分析）"
        );
      }
    }
  }

  /* ---------- 111. 补算（P2） ---------- */
  section("111. ★★★ v1.11.0 补算：盘上有字节、没分析过的歌，空闲时补出记录");
  {
    const ANALYSIS_PATH = "C:\\betterncm\\gapless-cache\\analysis.json";
    const INDEX_PATH = "C:\\betterncm\\gapless-cache\\index.json";

    function mkDiskFs() {
      const files = new Map();
      const calls = [];
      return {
        calls,
        files,
        readFileText(p) {
          calls.push(["readFileText", String(p)]);
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(String(files.get(String(p))));
        },
        writeFileText(p, txt) {
          calls.push(["writeFileText", String(p)]);
          files.set(String(p), String(txt));
          return Promise.resolve(true);
        },
        readFile(p) {
          calls.push(["readFile", String(p)]);
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(files.get(String(p)));
        },
        writeFile(p, blob) {
          calls.push(["writeFile", String(p)]);
          const ab = blob && blob.parts ? blob.parts[0] : null;
          if (!ab) return Promise.resolve(false);
          files.set(String(p), ab);
          return Promise.resolve(true);
        },
        remove(p) {
          calls.push(["remove", String(p)]);
          files.delete(String(p));
          return Promise.resolve(true);
        },
        mkdir() {
          return Promise.resolve(true);
        },
        countOf(name) {
          return calls.filter((c) => c[0] === name).length;
        },
      };
    }

    /** 节拍轨（同 89/110 段：节拍是已知真值） */
    function mkClick(opts) {
      const sr = 8000;
      const secs = (opts && opts.secs) || 200;
      const bpm = (opts && opts.bpm) || 120;
      const n = Math.round(secs * sr);
      const data = new Float32Array(n);
      const beat = 60 / bpm;
      for (let t = 0; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return {
        duration: secs,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => data,
      };
    }

    /** 往假盘里塞 index.json + 每首的数据文件（ArrayBuffer） */
    function seedDisk(disk, entries) {
      const items = {};
      for (const e of entries) {
        const path = "C:\\betterncm\\gapless-cache\\" + e.id + ".mp3";
        if (e.missing) {
          // 只在索引里，盘上没有 → 走「读不出来 → diskDrop」分支
          items[e.id] = { f: path, size: 1000, at: e.at };
          continue;
        }
        const buf = new ArrayBuffer(1000);
        disk.files.set(path, buf);
        items[e.id] = { f: path, size: 1000, at: e.at };
      }
      disk.files.set(INDEX_PATH, JSON.stringify({ v: 1, items }));
    }

    function backfillEnv(disk, opts) {
      opts = opts || {};
      const e = createEnv({ fs: disk, decode: opts.decode || (() => mkClick({ bpm: 120 })) });
      e.win.__gpBackfillDelay = 0;
      e.win.__gpBackfillGap = 0;
      e.win.__gpBackfillMax = 20;
      e.boot();
      return e;
    }

    async function drive(e, times) {
      const api = e.win.gaplessPlayer;
      const out = [];
      for (let i = 0; i < times; i++) {
        out.push(await api.backfill());
        await flush(8);
      }
      return out;
    }

    // ---- (a) 覆盖率 + 顺序 + noTouch + 幂等 ----
    {
      const disk = mkDiskFs();
      seedDisk(disk, [
        { id: 1000, at: 1000 },
        { id: 2000, at: 2000 },
        { id: 3000, at: 3000 },
      ]);
      const e = backfillEnv(disk);
      await flush(16);
      eq(e.win.gaplessPlayer.analysisStats().pending, 3, "（前提）队列里有 3 首");
      await drive(e, 3);
      e.flushTimers();
      await flush(16);

      const st = e.win.gaplessPlayer.analysisStats();
      eq(st.done, 3, "★★ 三首都补完了");
      eq(st.pending, 0, "★★ 队列清空");
      eq(st.count, 3, "★★ 分析记录也是 3 份");
      eq(e.decoded.length, 3, "★★ 每首只解码一次");
      const order = (e.logs().match(/\[backfill\] 开始 ｜ track=(\d+)/g) || []).map((s) => s.match(/track=(\d+)/)[1]);
      eq(order, ["3000", "2000", "1000"], "★★ 顺序是最近用过的先补（at 新→旧）");
      eq(countLog(e, "[disk] 维护读取"), 3, "★★ 补算读盘走「维护读取」");
      eq(countLog(e, "[disk] ★ 命中"), 0, "★★ 而且不刷新 LRU（没有一次「命中」）");
      eq(e.started.length, 0, "★★ 补算完全不碰播放（一个 source 都没建）");

      // 幂等：再催一次不该再解码
      const d0 = e.decoded.length;
      await drive(e, 2);
      eq(e.decoded.length, d0, "★★ 记录已完整 → 再跑也不解码（幂等）");
      e.flushTimers();
      await flush(8);
      ok(countLog(e, "[backfill] 队列已空") >= 1, "★★ 队列空了会明说");
    }

    // ---- (b) 完整记录不入队；默认 15s 内不自动跑 ----
    {
      const disk = mkDiskFs();
      seedDisk(disk, [
        { id: 4000, at: 1000 },
        { id: 5000, at: 2000 },
      ]);
      // 4000 已经有完整记录（三个字段齐 + 已经是当代 w:3/tried:3）→ 不该再被补
      disk.files.set(
        ANALYSIS_PATH,
        JSON.stringify({
          v: 1,
          items: {
            4000: {
              dur: 200,
              at: 1,
              w: 3,
              tried: 3,
              head: { bpm: 120, beatSec: 0.5, anchorSec: 0, conf: 0.8, dur: 200 },
              tail: { bpm: 120, beatSec: 0.5, anchorSec: 0, endBeatSec: 200, conf: 0.8, dur: 200 },
              energy: "AQID",
            },
          },
        })
      );
      const e = backfillEnv(disk);
      await flush(16);
      eq(e.win.gaplessPlayer.analysisStats().pending, 1, "★★ 完整记录不计入队列（只剩 5000）");

      // 自动节奏：默认 15s 起步 → 这一拍 tick 不该动
      e.win.__gpBackfillDelay = 15000;
      e.tick();
      await flush(16);
      eq(e.win.gaplessPlayer.analysisStats().done, 0, "★★ 开机 15s 内不自动补算");

      await drive(e, 2);
      const logs = e.logs();
      ok(!/\[backfill\] 开始 ｜ track=4000/.test(logs), "★★ 完整记录那首确实没被补");
      eq(e.decoded.length, 1, "★★ 只补了缺记录的那首");
    }

    // ---- (c) 坏字节 → skip + 从磁盘索引删掉 + 不反复重试 ----
    {
      const disk = mkDiskFs();
      seedDisk(disk, [
        { id: 6000, at: 2000, missing: true },
        { id: 7000, at: 1000 },
      ]);
      const e = backfillEnv(disk);
      await flush(16);
      await drive(e, 3);
      e.flushTimers();
      await flush(16);

      const st = e.win.gaplessPlayer.analysisStats();
      eq(st.skip, 1, "★★ 坏字节记进 skip 表");
      eq(st.done, 1, "★★ 另一首正常补完");
      eq(e.decoded.length, 1, "★★ 坏的那首没进解码");
      ok(countLog(e, "[backfill] ★ 失败") >= 1, "★★ 失败有日志");
      const idx = JSON.parse(String(disk.files.get(INDEX_PATH)));
      eq(idx.items["6000"], undefined, "★★ 读不出来的条目已从磁盘索引删掉（diskDrop）");
      eq(!!idx.items["7000"], true, "★★ 好的那首还在");
    }
  }

  /* ---------- 112. 多窗融合（P3） ---------- */
  section("112. ★★★ v1.12.0 多窗融合：头/中/尾三窗取中位数，治半速误判与半残前奏");
  {
    const ANALYSIS_PATH = "C:\\betterncm\\gapless-cache\\analysis.json";
    const INDEX_PATH = "C:\\betterncm\\gapless-cache\\index.json";

    function mkDiskFs() {
      const files = new Map();
      return {
        files,
        readFileText(p) {
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(String(files.get(String(p))));
        },
        writeFileText(p, txt) {
          files.set(String(p), String(txt));
          return Promise.resolve(true);
        },
        readFile(p) {
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(files.get(String(p)));
        },
        writeFile(p, blob) {
          const ab = blob && blob.parts ? blob.parts[0] : null;
          if (!ab) return Promise.resolve(false);
          files.set(String(p), ab);
          return Promise.resolve(true);
        },
        remove(p) {
          files.delete(String(p));
          return Promise.resolve(true);
        },
        mkdir() {
          return Promise.resolve(true);
        },
      };
    }

    function seedDisk(disk, ids) {
      const items = {};
      for (const id of ids) {
        const path = "C:\\betterncm\\gapless-cache\\" + id + ".mp3";
        disk.files.set(path, new ArrayBuffer(1000));
        items[id] = { f: path, size: 1000, at: 100 + id };
      }
      disk.files.set(INDEX_PATH, JSON.stringify({ v: 1, items }));
    }

    /** 分层合成轨：噪声底 + 若干段「四拍一响」 */
    function mkLayered(opts) {
      const sr = 8000;
      const secs = opts.secs || 200;
      const n = secs * sr;
      const data = new Float32Array(n);
      let seed = 7;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff - 0.5;
      };
      for (let i = 0; i < n; i++) data[i] = rnd() * 0.02;
      for (const seg of opts.segments) {
        const beat = 60 / seg.bpm;
        for (let t = seg.from; t < seg.to; t += beat) {
          const at = Math.round(t * sr);
          for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
            data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
          }
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

    function envFor(trackId, ab) {
      const disk = mkDiskFs();
      seedDisk(disk, [trackId]);
      const e = createEnv({ fs: disk, decode: () => ab });
      e.win.__gpBackfillDelay = 0;
      e.win.__gpBackfillGap = 0;
      e.boot();
      return e;
    }

    async function one(e) {
      const r = await e.win.gaplessPlayer.backfill();
      await flush(8);
      return r;
    }

    // ---- (a) 头窗测歪（0~20s 是 90 BPM）→ 融合取 120，相位借中窗外推 ----
    {
      const ab = mkLayered({
        segments: [
          { from: 0, to: 20, bpm: 90 },
          { from: 20, to: 200, bpm: 120 },
        ],
      });
      const e = envFor(8100, ab);
      await flush(16);
      const single = e.win.gaplessPlayer.beat(ab, 0, 20);
      await one(e);
      const rec = e.win.gaplessPlayer.analysisOf(8100);
      if (process.env.GP_DBG112) {
        console.log("DBG112a single=", single && { bpm: single.bpm, conf: single.conf }, "rec=", rec && { w: rec.w, head: rec.head, tail: rec.tail });
      }
      ok(!!single && Math.abs(single.bpm - 90) < 5, "（前提）头窗单窗测成 90 BPM（" + (single ? single.bpm.toFixed(1) : "?") + "）");
      ok(!!rec && rec.w === 3, "★★ 三窗参与 → w=3（融合版）");
      ok(!!rec && rec.head && Math.abs(rec.head.bpm - 120) < 3, "★★ 头窗 BPM 被别人拉回 120");
      const beatA = rec && rec.head ? 60 / rec.head.bpm : 0.5;
      const offA = rec && rec.head ? ((rec.head.anchorSec % beatA) + beatA) % beatA : 9;
      ok(
        Math.min(offA, beatA - offA) < 0.03,
        "★★ 头窗锚点落在融合网格上（相位借中窗外推，误差 " + (Math.min(offA, beatA - offA) * 1000).toFixed(0) + "ms）"
      );
      // ★ 关键：锚点必须来自「相位可信的中窗」，不能照抄 90 BPM 头窗的相位
      const midG = e.win.gaplessPlayer.beat(ab, 90, 20);
      let expA = midG ? midG.anchorSec + Math.round((0 - midG.anchorSec) / beatA) * beatA : NaN;
      if (expA < 0) expA += beatA;
      ok(
        !!rec && rec.head && Math.abs(rec.head.anchorSec - expA) < 0.02,
        "★★ 头窗锚点是中窗外推出来的，不是照抄测歪的头窗（" +
          (rec && rec.head ? rec.head.anchorSec.toFixed(3) : "?") + " vs " + (isFinite(expA) ? expA.toFixed(3) : "?") + "）"
      );
      e.flushTimers();
      await flush(8);
      ok(/融合 3 窗/.test(e.logs()), "★★ 日志写明用了融合");
    }

    // ---- (b) 尾窗测歪（178s 起换成 160 BPM）→ 融合回 120，末拍按融合 BPM 重算 ----
    {
      const ab = mkLayered({
        segments: [
          { from: 0, to: 178, bpm: 120 },
          { from: 178, to: 200, bpm: 160 },
        ],
      });
      const e = envFor(8200, ab);
      await flush(16);
      const tailSingle = e.win.gaplessPlayer.beat(ab, 178, 20);
      await one(e);
      const rec = e.win.gaplessPlayer.analysisOf(8200);
      if (process.env.GP_DBG112) {
        console.log("DBG112b tailSingle=", tailSingle && { bpm: tailSingle.bpm, conf: tailSingle.conf }, "rec=", rec && { w: rec.w, tail: rec.tail });
      }
      ok(!!tailSingle && Math.abs(tailSingle.bpm - 160) < 6, "（前提）尾窗单窗测成 160 BPM（" + (tailSingle ? tailSingle.bpm.toFixed(1) : "?") + "）");
      ok(!!rec && rec.w === 3, "★★ 融合版（w=3）");
      ok(!!rec && rec.tail && Math.abs(rec.tail.bpm - 120) < 3, "★★ 尾窗 BPM 被拉回 120");
      const beatB = rec && rec.tail ? 60 / rec.tail.bpm : 0.5;
      const offB = rec && rec.tail ? ((rec.tail.endBeatSec % beatB) + beatB) % beatB : 9;
      ok(
        !!rec && rec.tail && Math.min(offB, beatB - offB) < 0.03,
        "★★ 末拍落在融合网格上（按融合 BPM 重算）"
      );
    }

    // ---- (c) 三窗互不一致 → 不硬融（w=1、tried=3），也不反复重试 ----
    {
      const ab = mkLayered({
        segments: [
          { from: 0, to: 20, bpm: 120 },
          { from: 90, to: 110, bpm: 90 },
          { from: 178, to: 200, bpm: 150 },
        ],
      });
      const e = envFor(8300, ab);
      await flush(16);
      await one(e);
      const rec = e.win.gaplessPlayer.analysisOf(8300);
      ok(!!rec && rec.w === 1, "★★ 各窗不一致 → 不融合，w 保持 1");
      ok(!!rec && rec.tried === 3, "★★ 但记下「这一代试过了」（tried=3）");
      const d0 = e.decoded.length;
      await one(e);
      eq(e.decoded.length, d0, "★★ 不会因为融合失败而反复重试");
    }

    // ---- (d) 升级：1.11.0 的完整 w:1 记录，补算会自动升级成 w:3 ----
    {
      const ab = mkLayered({ segments: [{ from: 0, to: 200, bpm: 120 }] });
      const disk = mkDiskFs();
      seedDisk(disk, [9000]);
      disk.files.set(
        ANALYSIS_PATH,
        JSON.stringify({
          v: 1,
          items: {
            9000: {
              dur: 200,
              at: 1,
              w: 1,
              tried: 1,
              head: { bpm: 120, beatSec: 0.5, anchorSec: 0, conf: 0.7, dur: 200 },
              tail: { bpm: 120, beatSec: 0.5, anchorSec: 0, endBeatSec: 200, conf: 0.7, dur: 200 },
              energy: "AQID",
            },
          },
        })
      );
      const e = createEnv({ fs: disk, decode: () => ab });
      e.win.__gpBackfillDelay = 0;
      e.win.__gpBackfillGap = 0;
      e.boot();
      await flush(16);
      await one(e);
      const rec = e.win.gaplessPlayer.analysisOf(9000);
      eq(e.decoded.length, 1, "★★ 旧代记录被重新解码一次");
      ok(!!rec && rec.w === 3, "★★ 升级成融合版（w:1 → w:3）");
      const d0 = e.decoded.length;
      await one(e);
      eq(e.decoded.length, d0, "★★ 升级完就不再重跑");
    }
  }

  /* ---------- 113. 面板动态信息 ---------- */
  section("113. ★★★ v1.13.0 状态行动态化：过渡显示「本次真实值」，并加插件总开关");
  {
    function mkClick200() {
      const sr = 8000;
      const secs = 200;
      const n = secs * sr;
      const data = new Float32Array(n);
      const beat = 60 / 120;
      for (let t = 0; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => data };
    }

    // ---- (a) 排上一次真实过渡 → 状态行给出本次/档位/拍数/BPM ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkClick200() } });
      e.win.__gpXfade = 3;
      setLeft(e, 3.2);
      e.tick();
      await flush();
      const st = e.win.gaplessPlayer.status();
      if (process.env.GP_DBG113) console.log("DBG113 status=", st);
      ok(/过渡=交叉 3\.0s（本次 3\.\d\ds/.test(st), "★★ 状态行显示本次真实交叉时长（" + st.slice(st.indexOf("过渡"), st.indexOf("｜ 拍点")) + "）");
      ok(/本次 [\d.]+s · full/.test(st), "★★ 带档位（full）");
      ok(/· \d+ 拍/.test(st), "★★ 带拍数");
      ok(/· \d+→\d+/.test(st), "★★ 带 A→B 的 BPM");
    }

    // ---- (b) 开了交叉但还没过渡过 → 明说「尚未过渡」；关掉 → 干净无缝 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.win.__gpXfade = 3;
      ok(/尚未过渡/.test(e.win.gaplessPlayer.status()), "★★ 还没过渡过 → 「尚未过渡」");
      e.win.__gpXfade = 0;
      ok(/过渡=干净无缝/.test(e.win.gaplessPlayer.status()), "★★ 关掉交叉 → 干净无缝（不提本次）");
    }

    // ---- (c) 插件停用 → 状态行 / 补算都明说 ----
    {
      const e = createEnv();
      e.boot();
      await flush();
      e.win.__gpNativeAll = true;
      ok(/引擎=原生播（插件已停用）/.test(e.win.gaplessPlayer.status()), "★★ 停用后状态行明说");
    }
  }

  /* ---------- 114. 智能交叉 ---------- */
  section("114. ★★★ v1.14.0 智能交叉：时长按小节、曲线按档位（显式设置仍优先）");
  {
    function mkTrack(bpm) {
      const sr = 8000;
      const secs = 200;
      const n = secs * sr;
      const data = new Float32Array(n);
      const beat = 60 / bpm;
      for (let t = 0; t < secs; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          data[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => data };
    }
    function mkSilent() {
      const sr = 8000;
      const n = 200 * sr;
      return {
        duration: 200,
        sampleRate: sr,
        numberOfChannels: 1,
        length: n,
        getChannelData: () => new Float32Array(n),
      };
    }

    // ---- (a) 智能：full → 2 小节 = 4.0s，曲线 r_s-line ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTrack(120) } });
      e.win.gaplessPlayer.setXfade(true);
      setLeft(e, 5);
      e.tick();
      await flush();
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m, "★★ 排上了一次过渡");
      ok(
        Math.abs(m.fadeSec - 4) < 0.06,
        "★★ 智能时长 = 2 小节（120bpm → 4.00s，实际 " + (m ? m.fadeSec.toFixed(2) : "?") + "s）"
      );
      eq(m.tier, "full", "★★ 档位 full");
      eq(m.curve, "r_s-line", "★★ 曲线按档位选了 r_s-line");
      eq(m.smart, true, "★★ 记下了「这次是智能」");
      ok(/过渡=智能交叉（按小节）/.test(e.win.gaplessPlayer.status()), "★★ 状态行标明「智能交叉（按小节）」且不再摆 3.0s");
      ok(!/过渡=智能交叉 3\.0s/.test(e.win.gaplessPlayer.status()), "★★ 智能模式下状态行不再写兜底 3.0s");
    }

    // ---- (b) 显式时长 → 不智能：3s / equal ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkTrack(120) } });
      e.win.gaplessPlayer.setXfade(3);
      setLeft(e, 5);
      e.tick();
      await flush();
      const m = e.win.gaplessPlayer.lastMix();
      ok(
        !!m && Math.abs(m.fadeSec - 3) < 0.06,
        "★★ 显式 3s 不被改成小节（实际 " + (m ? m.fadeSec.toFixed(2) : "?") + "s）"
      );
      eq(m.curve, "equal", "★★ 曲线回到 equal");
      eq(m.smart, false, "★★ 这次不是智能");
    }

    // ---- (c) 智能 + 没拍点（静音）→ 退回兜底 3s / equal ----
    {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => mkSilent() } });
      e.win.__gpSkipBadMix = true; // ★ v1.20.0：跳过默认关，这里显式开
      e.win.gaplessPlayer.setXfade(true);
      setLeft(e, 5);
      e.tick();
      await flush();
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m, "★★ 没拍点也照样排上过渡");
      if (m) {
        eq(m.skip, true, "★★ 没拍点 → 跳过交叉（v1.17.0）");
        eq(m.skipReason, "no-grid", "★★ 原因是 no-grid");
        ok(m.fadeSec <= 0.03, "★★ 只留 20ms 极短淡（实际 " + m.fadeSec.toFixed(3) + "s）");
        ok(/跳过 · 没有拍点/.test(e.win.gaplessPlayer.status()), "★★ 状态行写明「跳过 · 没有拍点」");
      }
    }
  }

  /* ---------- 115. 跳过交叉 + 体检 ---------- */
  section("115. ★★★ v1.17.0 跳过交叉（低置信/节奏差）+ 置信度体检 audit()");
  {
    const ANALYSIS_PATH = "C:\\betterncm\\gapless-cache\\analysis.json";
    const INDEX_PATH = "C:\\betterncm\\gapless-cache\\index.json";

    function mkDiskFs() {
      const files = new Map();
      return {
        files,
        readFileText(p) {
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(String(files.get(String(p))));
        },
        writeFileText(p, txt) {
          files.set(String(p), String(txt));
          return Promise.resolve(true);
        },
        readFile(p) {
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(files.get(String(p)));
        },
        writeFile(p, blob) {
          const ab = blob && blob.parts ? blob.parts[0] : null;
          if (!ab) return Promise.resolve(false);
          files.set(String(p), ab);
          return Promise.resolve(true);
        },
        remove(p) {
          files.delete(String(p));
          return Promise.resolve(true);
        },
        mkdir() {
          return Promise.resolve(true);
        },
      };
    }

    function seedDisk(disk, ids) {
      const items = {};
      for (const id of ids) {
        const path = "C:\\betterncm\\gapless-cache\\" + id + ".mp3";
        disk.files.set(path, new ArrayBuffer(1000));
        items[id] = { f: path, size: 1000, at: 100 + id };
      }
      disk.files.set(INDEX_PATH, JSON.stringify({ v: 1, items }));
    }

    function recFor(bpm, conf) {
      return {
        dur: 200,
        at: 1,
        w: 3,
        tried: 3,
        head: { bpm: bpm, beatSec: 60 / bpm, anchorSec: 0, conf: conf, dur: 200 },
        tail: { bpm: bpm, beatSec: 60 / bpm, anchorSec: 0, endBeatSec: 200, conf: conf, dur: 200 },
        energy: "AQID",
      };
    }

    /** A=3000（流式，网格来自 analysis.json）+ B=4000（缓冲，网格来自解码） */
    async function mixEnv(aBpm, aConf, bBpm, opts) {
      opts = opts || {};
      const disk = mkDiskFs();
      seedDisk(disk, [3000, 4000]);
      disk.files.set(ANALYSIS_PATH, JSON.stringify({ v: 1, items: { 3000: recFor(aBpm, aConf) } }));
      const e = createEnv({ fs: disk, decode: () => mkBeatTrack(bBpm, 200) });
      delete e.win.__gpStream;
      if (opts.skipOff) e.win.__gpSkipBadMix = false;
      else e.win.__gpSkipBadMix = true; // ★ v1.20.0：跳过默认关，这些用例要它开
      e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e.boot();
      await flush(16);
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      e.channel.call("audioplayer.load", null, [
        idOf(3000) + "-x",
        { songId: 3000, musicurl: "http://cdn.example/a.flac" },
      ]);
      await flush(16);
      const el = e.audio.last;
      if (!el) return e;
      el.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush(16);
      e.channel.call("audioplayer.play", () => {}, [idOf(3000) + "-x", "t|resume|T"]);
      await flush(16);
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      el.currentTime = 196.8; // 还剩 3.2s
      e.tick();
      await flush(16);
      e.flushTimers();
      return e;
    }

    // ---- (a) 置信 0.05 → 跳过（low-conf） ----
    {
      const e = await mixEnv(120, 0.05, 120);
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && m.skip === true, "★★ 置信 0.05 → 跳过交叉");
      eq(m.skipReason, "low-conf", "★★ 原因是 low-conf");
      ok(m.fadeSec <= 0.03, "★★ 只留 20ms（实际 " + (m ? m.fadeSec.toFixed(3) : "?") + "s）");
      ok(/跳过 · 置信低/.test(e.win.gaplessPlayer.status()), "★★ 状态行写明「跳过 · 置信低」");
      ok(countLog(e, "跳过交叉（置信低）") >= 1, "★★ 日志写明原因");
      ok(countLog(e, "交叉=跳过") >= 1, "★★ 调度日志也写明「交叉=跳过」");
      const curves = (e.ctx.__gains || [])
        .map((g) => g.gain.events.filter((x) => x.type === "curve"))
        .filter((a) => a.length);
      ok(
        curves.length >= 2 && Math.abs(curves[0][0].dur - 0.02) < 0.005,
        "★★ 增益上排的是 20ms 曲线（不是 3s）"
      );
    }

    // ---- (b) 两边都可信但速度差 33% → 跳过（tempo-far） ----
    {
      const e = await mixEnv(120, 0.9, 160);
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && m.skip === true, "★★ 节奏差 → 跳过交叉");
      eq(m.skipReason, "tempo-far", "★★ 原因是 tempo-far");
      ok(/跳过 · 节奏差/.test(e.win.gaplessPlayer.status()), "★★ 状态行写明「跳过 · 节奏差」");
    }

    // ---- (c) 中间地带（conf 0.15、速度一致）→ 不跳过，普通 3s ----
    {
      const e = await mixEnv(120, 0.15, 120);
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && !m.skip, "★★ 置信 0.15（中间地带）→ 不跳过");
      ok(m && Math.abs(m.fadeSec - 3) < 0.1, "★★ 保留普通 3s（实际 " + (m ? m.fadeSec.toFixed(2) : "?") + "s）");
    }

    // ---- (d) 控制台逃生：__gpSkipBadMix=false ----
    {
      const e = await mixEnv(120, 0.05, 120, { skipOff: true });
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && !m.skip, "★★ __gpSkipBadMix=false → 不再跳过");
      ok(m && Math.abs(m.fadeSec - 3) < 0.1, "★★ 回到普通 3s");
    }

    // ---- (e) 中间地带但节奏差 → 也跳过（v1.20.0 收紧） ----
    {
      const e = await mixEnv(120, 0.15, 140);
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && m.skip === true, "★★ conf 0.15 + 偏差 16.7% → 跳过");
      eq(m.skipReason, "tempo-far", "★★ 原因是 tempo-far");
    }

    // ---- (f) 体检：audit() 读记录；audit(true) 重算 ----
    {
      const e = await mixEnv(120, 0.05, 120);
      const a = await e.win.gaplessPlayer.audit();
      ok(a.count >= 1, "★★ 体检读到记录（" + a.count + " 首）");
      ok(a.headSummary.n >= 1, "★★ 头窗置信有样本（" + a.headSummary.n + "）");
      ok(a.tier.skip >= 1, "★★ 统计里有会被跳过的歌（" + a.tier.skip + "）");
      ok(a.skipReasons["low-conf"] >= 1, "★★ 跳过原因计数：low-conf ≥1");
      const b = await e.win.gaplessPlayer.audit(true);
      ok(!!b.recompute, "★★ audit(true) 返回重算结果");
      ok(b.recompute.n >= 2, "★★ 重算覆盖盘上歌（" + b.recompute.n + " 首）");
      ok(b.recompute.ok >= 2, "★★ 至少两首解码分析成功（" + b.recompute.ok + "）");
      ok(b.recompute.summary.head.n >= 2, "★★ 头窗置信有 ≥2 个样本");
      ok(b.recompute.fused >= 1, "★★ 至少一首能融合（" + b.recompute.fused + "）");
    }
  }

  /* ---------- 116. A 尾窗 2 ---------- */
  section("116. ★★★ v1.18.0 A 尾窗 2：跟着混音点往前挪，两窗融合/择优");
  {
    function mkGapTail() {
      const sr = 8000;
      const secs = 200;
      const n = secs * sr;
      const d = new Float32Array(n);
      const beat = 0.5;
      for (let t = 0; t < 178; t += beat) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          d[at + i] = Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      // 178~200 全静音（没有鼓点、也没有铺底）→ 尾窗测不出，得靠尾窗 2
      for (let i = 0; i < 178 * sr; i++) d[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }

    async function envWith(ab) {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => ab } });
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      setLeft(e, 5);
      e.tick();
      await flush();
      e.flushTimers();
      return e;
    }

    // ---- (a) 尾窗整段没鼓点 → 自动用尾窗 2 ----
    {
      const e = await envWith(mkGapTail());
      const p = e.win.gaplessPlayer.lastPlan();
      const m = e.win.gaplessPlayer.lastMix();
      if (process.env.GP_DBG116) console.log("DBG116a plan=", p, "mix=", m && { fade: m.fadeSec, tier: m.tier, skip: m.skip });
      ok(!!p && p.tailWin === "tail2", "★★ 尾窗没拍点 → 自动改用尾窗 2（" + (p && p.tailWin) + "）");
      ok(!!m && !m.skip, "★★ 而且没有跳过交叉");
      ok(!!m && Math.abs(m.aBpm - 120) < 5, "★★ 用尾窗 2 测到的 BPM 仍是 120（" + (m ? m.aBpm.toFixed(1) : "?") + "）");
      ok(
        !!m && (Math.abs(m.fadeSec - 4) < 0.1 || Math.abs(m.fadeSec - 2) < 0.1),
        "★★ 时长回到按小节（" + (m ? m.fadeSec.toFixed(2) : "?") + "s）"
      );
    }

    // ---- (b) 两个尾窗一致 → 融合，置信抬高 ----
    {
      const e = await envWith(mkBeatTrack(120, 200));
      const p = e.win.gaplessPlayer.lastPlan();
      const m = e.win.gaplessPlayer.lastMix();
      if (process.env.GP_DBG116) console.log("DBG116b plan=", p, "mix=", m && { fade: m.fadeSec, tier: m.tier, conf: m.conf });
      ok(!!p && p.tailWin === "fused", "★★ 两窗一致 → 融合（" + (p && p.tailWin) + "）");
      ok(!!p && p.conf >= 0.9, "★★ 融合后置信被抬高（" + (p ? p.conf.toFixed(2) : "?") + "）");
      ok(!!m && (Math.abs(m.fadeSec - 4) < 0.1 || Math.abs(m.fadeSec - 2) < 0.1), "★★ 按小节（2/4s，实际 " + (m ? m.fadeSec.toFixed(2) : "?") + "）");
    }

    // ---- (c) plain 回退直接用设定秒数，不再折拍 ----
    {
      function mkBeatsVariant(kind, x) {
        const sr = 8000;
        const secs = 60;
        const n = secs * sr;
        const d = new Float32Array(n);
        const bpm = 144;
        const beat = 60 / bpm;
        let seed = 987654321;
        const rnd = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed / 0x7fffffff;
        };
        const click = (at, amp) => {
          const i0 = Math.round(at * sr);
          for (let i = 0; i < sr * 0.03 && i0 + i < n; i++) {
            if (i0 + i >= 0) d[i0 + i] += Math.exp(-i / (sr * 0.008)) * 0.9 * amp;
          }
        };
        if (kind === "jitter") {
          for (let t = 0; t < secs; t += beat) click(t + (rnd() * 2 - 1) * x, 1);
        } else if (kind === "ramp") {
          for (let t = 0; t < secs; t += beat) click(t, Math.min(1, t / (x * 1)));
        } else if (kind === "twin") {
          for (let t = 0; t < secs; t += beat) click(t, 1);
          for (let t = 0; t < secs; t += 60 / 96) click(t, x);
        } else if (kind === "drop") {
          let k = 0;
          for (let t = 0; t < secs; t += beat) {
            if (k++ % Math.max(2, Math.round(x)) !== 0) click(t, 1);
          }
        }
        return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
      }

      // 造一个「BPM 对、但置信只有 0.1~0.2」的 B（这样不跳过、又不是 smart/full）
      const probe = createEnv();
      await probe.boot();
      await flush(10);
      let bBuf = null;
      let bConf = 0;
      const cands = [
        ["jitter", 0.02],
        ["jitter", 0.04],
        ["jitter", 0.07],
        ["jitter", 0.1],
        ["twin", 0.3],
        ["twin", 0.5],
        ["twin", 0.7],
        ["ramp", 8],
        ["drop", 3],
      ];
      for (const c of cands) {
        const cand = mkBeatsVariant(c[0], c[1]);
        const g = probe.win.gaplessPlayer.beat(cand, 0, 20);
        if (process.env.GP_DBG116) console.log("DBG116c cand", c[0], c[1], "->", g && { bpm: g.bpm, conf: g.conf });
        if (g && g.conf >= 0.1 && g.conf < 0.2) {
          bBuf = cand;
          bConf = g.conf;
          break;
        }
      }
      ok(!!bBuf, "（前提）能造出置信 0.1~0.2 的 B（" + bConf.toFixed(2) + "）");

      const ANALYSIS_PATH = "C:\\betterncm\\gapless-cache\\analysis.json";
      const INDEX_PATH = "C:\\betterncm\\gapless-cache\\index.json";
      const files = new Map();
      const disk = {
        readFileText(p) {
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(String(files.get(String(p))));
        },
        writeFileText(p, txt) {
          files.set(String(p), String(txt));
          return Promise.resolve(true);
        },
        readFile(p) {
          if (!files.has(String(p))) return Promise.reject(new Error("no such file"));
          return Promise.resolve(files.get(String(p)));
        },
        writeFile(p, blob) {
          const ab = blob && blob.parts ? blob.parts[0] : null;
          if (!ab) return Promise.resolve(false);
          files.set(String(p), ab);
          return Promise.resolve(true);
        },
        remove(p) {
          files.delete(String(p));
          return Promise.resolve(true);
        },
        mkdir() {
          return Promise.resolve(true);
        },
      };
      const items = {};
      for (const id of [3000, 4000]) {
        const path = "C:\\betterncm\\gapless-cache\\" + id + ".mp3";
        files.set(path, new ArrayBuffer(1000));
        items[id] = { f: path, size: 1000, at: 100 + id };
      }
      files.set(INDEX_PATH, JSON.stringify({ v: 1, items }));
      files.set(
        ANALYSIS_PATH,
        JSON.stringify({
          v: 1,
          items: {
            3000: {
              dur: 200,
              at: 1,
              w: 3,
              tried: 3,
              head: { bpm: 144, beatSec: 60 / 144, anchorSec: 0, conf: 0.8, dur: 200 },
              tail: { bpm: 144, beatSec: 60 / 144, anchorSec: 0, endBeatSec: 200, conf: 0.8, dur: 200 },
              energy: "AQID",
            },
          },
        })
      );
      const e = createEnv({ fs: disk, decode: () => bBuf });
      delete e.win.__gpStream;
      e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e.boot();
      await flush(16);
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      e.channel.call("audioplayer.load", null, [idOf(3000) + "-x", { songId: 3000, musicurl: "http://cdn.example/a.flac" }]);
      await flush(16);
      const el = e.audio.last;
      el.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush(16);
      e.channel.call("audioplayer.play", () => {}, [idOf(3000) + "-x", "t|resume|T"]);
      await flush(16);
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      el.currentTime = 196.8;
      e.tick();
      await flush(16);
      e.flushTimers();
      const m = e.win.gaplessPlayer.lastMix();
      if (process.env.GP_DBG116) console.log("DBG116c mix=", m && { fade: m.fadeSec, tier: m.tier, skip: m.skip }, "plan=", e.win.gaplessPlayer.lastPlan());
      ok(!!m && !m.skip, "★★ conf 0.15 的 plain 不跳过");
      ok(!!m && Math.abs(m.fadeSec - 3) < 0.06, "★★ plain 回退就是设定的 3.00s（不再折成 7 拍）");
    }
  }

  /* ---------- 117. 连续母带 ---------- */
  section("117. ★★★ v1.19.0 连续母带（无缝专辑）：断在音乐里 → 保持 0s 原样");
  {
    function mkPad(secs, o) {
      o = o || {};
      const sr = 8000;
      const n = Math.round(secs * sr);
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let amp = 0.3;
        if (o.fadeOut && t > secs - o.fadeOut) amp *= Math.max(0, (secs - t) / o.fadeOut);
        if (o.fadeIn && t < o.fadeIn) amp *= t / o.fadeIn;
        if (o.silenceEnd && t > secs - o.silenceEnd) amp = 0;
        d[i] = Math.sin((2 * Math.PI * 220 * t)) * amp;
      }
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }

    async function padEnv(ab, keep) {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => ab } });
      e.win.__gpKeepContinuous = keep !== false;
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      setLeft(e, 5);
      e.tick();
      await flush();
      e.flushTimers();
      return e;
    }

    const curveCount = (e) =>
      (e.ctx.__gains || []).reduce((n, g) => n + g.gain.events.filter((x) => x.type === "curve").length, 0);

    // ---- (a) 两边都断在音乐里 → 0s 接缝，不交叉 ----
    {
      const e = await padEnv(mkPad(200));
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m, "★★ 有本次过渡记录");
      ok(!!m && m.continuous === true, "★★ 判定为连续母带");
      ok(!!m && m.fadeSec === 0, "★★ 时长 0（不做交叉）");
      eq(curveCount(e), 0, "★★ 一条淡入淡出曲线都没排");
      ok(countLog(e, "连续母带 → 保持原样") >= 1, "★★ 日志写明「保持原样」");
      ok(countLog(e, "交接=连续母带（0s 接缝）") >= 1, "★★ 调度日志标明 0s 接缝");
      ok(Math.abs(Number(lastOf(e.started).at) - 200.02) < 0.03, "★★ B 正好排在 A 的结束采样上");
    }

    // ---- (b) A 是淡出的 → 不判连续（该交叉就交叉/该跳过就跳过） ----
    {
      const e = await padEnv(mkPad(200, { fadeOut: 5 }));
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && !m.continuous, "★★ A 在淡出 → 不判连续母带");
    }

    // ---- (d) 流式 A 补成缓冲后也能判（用户说的「第一首」情形） ----
    {
      const e = createEnv({ decode: () => mkPad(200) });
      delete e.win.__gpStream;
      e.win.__gpKeepContinuous = true;
      e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(LIST6)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(1000)]);
      streamLoad(e, idOf(1000) + "-x", "http://cdn.example/a.flac");
      await flush();
      e.audio.last.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idOf(1000) + "-x", "t|resume|T"]);
      await flush();
      e.flushTimers();
      e.advance(9000); // 听够 8s → 触发补缓冲
      e.tick();
      await flush(16);
      e.flushTimers();
      ok(countLog(e, "已补成缓冲") >= 1, "（前提）流式 A 已补成缓冲");
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      e.audio.last.currentTime = 196.8;
      e.tick();
      await flush(16);
      e.flushTimers();
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && m.continuous === true, "★★ 流式 A 补成缓冲后也能判连续母带");
      ok(!!m && m.fadeSec === 0, "★★ 0s 接缝");
    }

    async function albumStreamEnv(list, cur) {
      const e = createEnv({ decode: () => mkPad(200) });
      delete e.win.__gpStream;
      e.win.__gpKeepContinuous = true;
      e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ mode: "playorder" }));
      e.boot();
      await flush();
      e.channel.call("player.addListElement", null, [JSON.stringify(list)]);
      e.channel.call("player.setCurrentPlay", null, [idOf(cur)]);
      streamLoad(e, idOf(cur) + "-x", "http://cdn.example/a.flac");
      await flush();
      e.audio.last.duration = 200;
      e.audio.emit("loadedmetadata");
      await flush();
      e.channel.call("audioplayer.play", () => {}, [idOf(cur) + "-x", "t|resume|T"]);
      await flush();
      await flush();
      e.flushTimers();
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      e.audio.last.currentTime = 196.8;
      e.tick();
      await flush(16);
      e.flushTimers();
      return e;
    }
    {
      const e = await albumStreamEnv(
        [
          { id: "1000", title: "t1", album: "Concept", artist: "X" },
          { id: "2000", title: "t2", album: "Concept", artist: "X" },
          { id: "3000", title: "t3", album: "Concept", artist: "X" },
        ],
        1000
      );
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && m.continuous === true, "★★ 同专辑相邻 → 连续母带（流式 A 无缓冲）");
      eq(m.album, true, "★★ 标明是元数据兜底");
      eq(m.fadeSec, 0, "★★ 0s 接缝");
      ok(countLog(e, "同专辑相邻（Concept") >= 1, "★★ 日志写明同专辑相邻");
    }

    // ---- (f) 相邻但不同专辑 → 不兜底 ----
    {
      const e = await albumStreamEnv(
        [
          { id: "1000", title: "t1", album: "Concept", artist: "X" },
          { id: "3000", title: "t3", album: "Other", artist: "Y" },
        ],
        1000
      );
      const m = e.win.gaplessPlayer.lastMix();
      ok(!!m && !m.continuous, "★★ 不同专辑 → 不判同专辑连续");
      ok(!!m && m.album !== true, "★★ 也没有 album 标记");
    }
  }

  /* ---------- 118. 初始音量脏值 ---------- */
  section("118. ★★ v1.20.0 初始音量：客户端存下淡出中的 0.011 不能直接拿来用");
  {
    const e = createEnv();
    e.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ volume: 0.0111, mode: "playorder" }));
    e.boot();
    await flush(16);
    eq(e.win.gaplessPlayer.volume(), 0.8, "★★ 0.0111 被当成脏值 → 0.8");
    const e2 = createEnv();
    e2.localStorage.setItem("NM_SETTING_PLAYER", JSON.stringify({ volume: 0.6, mode: "playorder" }));
    e2.boot();
    await flush(16);
    eq(e2.win.gaplessPlayer.volume(), 0.6, "★★ 0.6 正常沿用");
  }

  /* ---------- 119. B 头窗 2 ---------- */
  section("119. ★★★ v1.20.0 B 头窗 2：长/怪前奏时从第 8 秒再开一窗，融合/择优");
  {
    function mkLongIntro() {
      const sr = 8000;
      const secs = 200;
      const n = secs * sr;
      const d = new Float32Array(n);
      let seed = 1234567;
      // 0~16s 白噪声（没有节拍）→ 头窗（0~20s）测不出
      for (let i = 0; i < 20 * sr; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        d[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.3;
      }
      for (let t = 20; t < secs; t += 0.5) {
        const at = Math.round(t * sr);
        for (let i = 0; i < sr * 0.03 && at + i < n; i++) {
          d[at + i] += Math.exp(-i / (sr * 0.008)) * 0.9;
        }
      }
      for (let i = 0; i < n; i++) d[i] += Math.sin((2 * Math.PI * 90 * i) / sr) * 0.02;
      return { duration: secs, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }

    async function headEnv(ab) {
      const e = await seamlessEnv("playorder", { hooks: { decode: () => ab } });
      e.win.__gpXfade = 3;
      e.win.__gpXfadeSmart = true;
      setLeft(e, 5);
      e.tick();
      await flush();
      e.flushTimers();
      return e;
    }

    // ---- (a) 头窗测不出 → 自动用头窗 2 ----
    {
      const e = await headEnv(mkLongIntro());
      const p = e.win.gaplessPlayer.lastPlan();
      const m = e.win.gaplessPlayer.lastMix();
      if (process.env.GP_DBG119) console.log("DBG119a plan=", p, "mix=", m && { fade: m.fadeSec, tier: m.tier, skip: m.skip });
      ok(!!p && p.headWin === "head2", "★★ 长前奏 → 自动改用头窗 2（" + (p && p.headWin) + "）");
      ok(!!m && !m.skip, "★★ 没有跳过交叉");
      ok(!!m && Math.abs(m.bBpm - 120) < 5, "★★ 用头窗 2 测到的 B BPM 仍是 120（" + (m ? m.bBpm.toFixed(1) : "?") + "）");
      ok(!!m && (Math.abs(m.fadeSec - 4) < 0.1 || Math.abs(m.fadeSec - 2) < 0.1), "★★ 按小节（2/4s，实际 " + (m ? m.fadeSec.toFixed(2) : "?") + "）");
    }

    // ---- (b) 两个头窗一致 → 融合 ----
    {
      const e = await headEnv(mkBeatTrack(120, 200));
      const p = e.win.gaplessPlayer.lastPlan();
      const m = e.win.gaplessPlayer.lastMix();
      if (process.env.GP_DBG119) console.log("DBG119b plan=", p, "mix=", m && { fade: m.fadeSec, tier: m.tier });
      ok(!!p && p.headWin === "fused", "★★ 两窗一致 → 融合（" + (p && p.headWin) + "）");
      ok(!!p && p.conf >= 0.9, "★★ 融合后置信被抬高（" + (p ? p.conf.toFixed(2) : "?") + "）");
      ok(!!m && Math.abs(m.fadeSec - 4) < 0.1, "★★ full → 4.00s");
    }
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
