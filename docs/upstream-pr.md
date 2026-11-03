# feat: support NetEase Cloud Music 3.1.x (sample-accurate gapless on 3.1.42)

## Why

3.1.x is a rewrite of the client: the plugin installs but does not work there.
Four independent problems, each fixed in its own commit:

1. **BetterNCM refuses to install it** — 3.x only loads plugins whose manifest
   opts in (`ncm3-compatible`).
2. **Preload never succeeds** — `[preload] 放弃 ｜ n is not a function`.
   `LibEAPIRequest` locates the client's request function by scanning function
   sources on the window tree; on 3.x the first match (module id `1368`) is a
   **webpack module factory**, so calling it without `__webpack_require__`
   throws. Preload therefore needs its own URL resolution.
3. **A track is skipped when the previous one ends** — and in some states the
   client ping-pongs between two tracks, reloading an audioId every second.
   After advancing, the client asks `audioplayer.getPlayedTime` /
   `getPlaybackInfo` for the **new** `playId`; the native player is held paused
   by the plugin, so it answers `{playedTime: 0, result: false}`, which reads as
   "this track is not playing either" → the client advances a second time.
4. **No gapless at all** — `[sched] 预约` never appears. 3.1.x reports
   `mode=playrandom` even when the list is played in order, and the current gate
   only arms the seam for `playonce` / `playorder`.

## What changed

| Area | Change |
|---|---|
| manifest | `ncm3-compatible: true`; `loadAfter` also lists `LibEAPIRequest` |
| preload | fallback chain gated behind `isNcm3()`: unsigned legacy `player/url` (320k) → `outer/url` (128k) → `channel.call("network.fetch")` for the bytes; every step re-checks `S.preloadToken`, and 2.10.x keeps the upstream behaviour byte-for-byte |
| playback | `getPlayedTime` / `getPlaybackInfo` are answered from the plugin's own engine state (`result: true`, real `playedTime` / `playedPercent`, `playId` echoed); unknown `playId`s still go to native |
| playback | when `<audio>` fails on the encrypted `musicurl` token (`MEDIA_ELEMENT_ERROR: Format error`), retry once with the plugin's own URL |
| preload | reject trial clips: `freeTrialInfo` present **or** non-standard `br` (observed `320006`, a 64s preview) → abandon preload, let the client play the real track |
| seamless | `S.hitStreak` records correct next-track predictions; in `playrandom` the seam is armed when the previous prediction was right (a wrong one is still cancelled by `abortSeam()` / `cancelSched()`) |

## Why the unsigned endpoint

3.1.x signs its API calls with eapi; the signed variants answer `400`:

```
/api/song/enhance/player/url/v1?ids=[id]&br=320000  -> {"msg":"参数错误","code":400}
/weapi/song/enhance/player/url                      -> empty
```

The legacy unsigned endpoint still answers and returns 320k:

```
/api/song/enhance/player/url?ids=[id]&br=320000
-> {"data":[{"url":"http://m701.music.126.net/...","br":320000,"size":6859799,...}]}
```

It is requested through the client's own network stack
(`channel.call("network.fetch")`), so login cookies and VIP privileges apply.
It is a legacy endpoint and may disappear; preload then silently degrades to
128k gapless, and playback is never affected.

## Testing

- `node test/harness.js` — **309 assertions, 0 failures**. Upstream baseline was
  291; three new sections cover this port:
  - 78: contract self-answer (+ unknown `playId` passthrough) — regression guard
    for the skip bug.
  - 79: 320k endpoint used and fetched; trial clip (`br=320006`) rejected and
    never downloaded.
  - 80: `Format error` on the encrypted token → own URL re-attached.
- Real device: NetEase 3.1.42.205594 + BetterNCM 1.3.4, verified preload at
  320k, sample-accurate handoff (`[sched] 预约 → [end] 无缝交接 → 认领`), and no
  track skipping. See `docs/verification.md` for log excerpts.
- 2.10.13: unchanged behaviour (all 3.x code paths return early on `!isNcm3()`).

## Notes for reviewers

- The 3.x code is deliberately additive: `isNcm3()` gates every branch, and the
  upstream preload chain keeps its shape (`resolveUrl → token guard →
  fetchBytes → decodeAudioData`).
- `channel.deData()` / `deSerialData()` return an empty string for the encrypted
  `musicurl`, so decrypting the client's token is not an option; the retry uses
  our own URL instead.
- One user gesture per app start is still required on 3.x (CEF keeps
  `AudioContext` suspended until a real click); the plugin already handles the
  retry, so no code change was needed for that.