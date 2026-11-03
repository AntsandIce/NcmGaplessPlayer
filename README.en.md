# GaplessPlayer 3.x branch

> Real gapless playback for **NetEase Cloud Music (网易云音乐) 3.1.x** on Windows.
> Fork of [Ehytr/NcmGaplessPlayer](https://github.com/Ehytr/NcmGaplessPlayer) (upstream supports 2.10.x only).

中文说明见 [README.md](README.md) ｜ 实测记录见 [docs/verification.md](docs/verification.md)

---

## Status

| Client | Supported | Preload quality | Notes |
|---|---|---|---|
| 2.10.x | ✅ upstream | 320k | upstream behaviour kept byte-for-byte |
| **3.1.x** | ✅ **this branch** (tested on `3.1.42.205594`) | **320k** (falls back to 128k) | requires BetterNCM 1.3.4 |
| 3.0.x | ⚠️ untested | — | patched code is gated on `APP_CONF.appver` starting with `3.` |

Requires [BetterNCM](https://github.com/std-microblock/chromatic) (project renamed to *chromatic*; last BetterNCM release is 1.3.4) and optionally [LibEAPIRequest](https://github.com/BetterNCM/LibEAPIRequest).

## Install

1. Install BetterNCM 1.3.4 (put `BetterNCMII.dll` / `BetterNCMII86.dll` next to `cloudmusic.exe` renamed to `msimg32.dll`).
2. Drop `gapless-player-<version>.plugin` into `C:\betterncm\plugins\` (or `python build.py --install`).
3. Restart NetEase Cloud Music.
4. **On 3.x, click the play button once after every start.** CEF keeps `AudioContext` in `suspended` until a real user gesture; a synthetic click does not count.

## What this branch fixes on 3.x

| # | Symptom | Fix |
|---|---|---|
| 1 | BetterNCM silently skips the plugin | `manifest.json`: `"ncm3-compatible": true` |
| 2 | Preload always fails — `[preload] 放弃 ｜ n is not a function` | `LibEAPIRequest` resolves the request function by scanning window function sources; on 3.x the first match (id `1368`) is a **webpack module factory**, impossible to call. This branch ships its own URL resolution instead |
| 3 | **Skips one track** when a song ends (sometimes jumping back to the head of the playlist, occasionally ping-ponging between two tracks) | After advancing, the client asks `audioplayer.getPlayedTime` / `getPlaybackInfo` for the *new* `playId`. The native player is held paused, so it answers `{playedTime:0, result:false}` → the client concludes the new track ended too and advances again. This branch **answers both queries from its own engine state** |
| 4 | `[sched] 预约` never appears, so no real gapless | 3.x reports `mode=playrandom` and upstream refuses to arm the seam for anything but `playonce/playorder`. Now: sequential modes arm directly; random mode arms when the **previous next-track prediction was correct** (`hitStreak ≥ 1`); a wrong prediction is still cancelled by `abortSeam()` / `cancelSched()` |
| 5 | Preload capped at 128k | Added the legacy **unsigned** endpoint, which returns 320k |

## URL chain on 3.x

```
1. LibEAPIRequest.eapiRequest(dm + "/api/song/enhance/player/url")        320k  (works on 2.10 only)
2. GET /api/song/enhance/player/url?ids=[<id>]&br=320000                 320k  (unsigned legacy endpoint)
3. GET /song/media/outer/url?id=<id>.mp3                                 128k  (fallback)
4. channel.call("network.fetch", …)                                            (native network fallback)
```

Steps 2–4 go through the client's own network stack (`channel.call("network.fetch")`), so the login cookies are applied and VIP / high-quality privileges work as usual.

> ⚠️ Step 2 is a legacy endpoint: `/api/song/enhance/player/url/v1` and `/weapi/...` both require eapi signing and answer `{"msg":"参数错误","code":400}`. NetEase may remove the legacy endpoint at any time; preload then silently degrades to 128k gapless — playback is unaffected.

## Two extra fallbacks added after real-device testing

- **Retry when the encrypted `musicurl` cannot be decoded**: on 3.x `audioplayer.load` carries an
  encrypted token instead of a URL, so a few tracks make `<audio>` fail with
  `MEDIA_ELEMENT_ERROR: Format error` (the UI shows "failed to load"). The plugin then re-attaches
  an URL of its own (320k endpoint -> `outer/url`) once; the error is only reported if that fails too.
- **Trial-clip detection**: for paywalled tracks the endpoint may answer with a short preview
  (observed: 64.00s with bitrate `320006`, a non-standard value). Such results are discarded, the
  preload is abandoned and the client plays the full track itself - no gapless for that track, but
  playback no longer stops at the clip boundary.

## Known limitations

- **Random/shuffle mode**: the client picks the next track ~80 ms before switching, so gapless can only be scheduled when the previous prediction was right. Use sequential / list-loop mode for reliable gapless.
- **One real click per app start** (see Install step 4).
- **NetEase's own lyrics break** (the plugin takes over the play chain). Use e.g. [RuLyric](https://github.com/BetterNCM/RuLyric).
- Preload quality is 320k mp3; some accounts/tracks fall back to 128k.
- Depends on internal client APIs (`channel.call`, `legacyNativeCmder`); a client update can break it.
- Log: `<profile>\gapless-player.log` (`[sched]`, `[end]`, `[preload]` events).

## Develop

```bash
python build.py            # -> dist/gapless-player-<version>.plugin
python build.py --install  # build + copy into C:\betterncm\plugins and clear plugins_runtime
node test/harness.js       # offline harness: 291 assertions
```

The 3.1.x adaptation lives in `src/main.js` and is gated behind `isNcm3()`:

- `resolveUrl320()` / `api320Url()` / `outerUrlFor()` / `nativeFetchBytes()`
- the `getPlayedTime` / `getPlaybackInfo` contract block at the top of `handle()`
- `S.hitStreak` bookkeeping in `notePrediction()` and the relaxed gate in `maybeScheduleSeamless()`

Bit-for-bit upstream behaviour on 2.10.x is preserved (the fallback chain rethrows immediately on `!isNcm3()`).

## Disclaimer

Unofficial fork, not affiliated with NetEase. No client binaries or protected content are included or redistributed; the plugin only requests play URLs through endpoints the client already uses.

## Credits

- [1carus / Ehytr](https://github.com/Ehytr/NcmGaplessPlayer) — the original plugin: sample-accurate scheduling, preload scheduler, event forgery, dual playback paths.
- [std-microblock / chromatic (BetterNCM)](https://github.com/std-microblock/chromatic) — plugin loader and injection.
- [SteveXMH / LibEAPIRequest](https://github.com/BetterNCM/LibEAPIRequest) — request library (2.10.x).

## License

MIT. Original code © 2026 1carus; see [LICENSE](LICENSE).
