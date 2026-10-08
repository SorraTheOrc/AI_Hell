# Automated gameplay capture (dev tooling)

> **Status: spike proof-of-concept** — AH-0MUWMFF3C002WOBK.
> The deliverable is a *working* capture path plus this written
> recommendation, not a production pipeline. Productionising it, seeding all
> RNG or wiring it into CI are explicitly **out of scope** (record those as
> follow-up work items instead).

This document records how AI_Hell can produce a gameplay video **without a
human recording their screen**: one opt-in command boots the game in a real
rendering browser, starts the **in-game attract/demo mode** (the shipped bot
plays itself), and writes a playable video file locally. A `--scripted`
fallback replays the original deterministic key plan instead
(AH-0MUX496IJ0041O3V).

## TL;DR — recommended approach

**Approach A: headless Chromium (Playwright) + `canvas.captureStream(60)` +
`MediaRecorder` → WebM.**

```bash
# one-time: install JS deps + the matching browser
npm install
npm run capture:install          # playwright install chromium (~278 MiB download)

# record a complete in-game demo run (start → game over + 5 s tail) to capture-output/…
npm run capture

# bound a long run or lengthen the post-signal tail
npm run capture -- --max-duration 1800000 --tail 5000

# or use the legacy fixed-length / scripted fallbacks
npm run capture -- --duration 20000 --output clips/demo.webm
npm run capture -- --headed      # watch it drive a visible browser
npm run capture -- --scripted    # fallback: replay the fixed scripted plan

# record the dev boss scenario: jump straight to a boss with 4 hits remaining
npm run capture -- --scenario boss-four-hits
```

This was proven end to end on 2026-10-06: a 12 s clip recorded at
**960×540, WebM/VP9 + Opus, ~2.4 MiB**, decoded back and probed at
**~1.5 % non-black pixels, ~590 distinct colours, non-zero inter-frame
motion**, with **zero page errors**. The clip also carries the **game's own
SFX** (audio peak ≈ 0.44, RMS ≈ 0.08), decoded and verified in-page — see
[Audio capture](#audio-capture).

## Exact tooling & versions

| Component | Version / notes |
|---|---|
| Playwright (npm) | `1.55.1` (devDependency; chosen to match the browser already cached on the host — any 1.55.x works) |
| Chromium | `140.0.7339.186` (Playwright build **v1193**) |
| Renderer | `Phaser.AUTO` → **WebGL**, via headless Chromium's software (SwiftShader) backend |
| Encoder | browser-native `MediaRecorder`, preferring `video/webm;codecs=vp9,opus` (falls back to VP8+Opus, then plain WebM) |
| Audio | the game's own SFX, tapped from its single shared `AudioContext` and encoded as **Opus 48 kHz stereo** |
| Output | `.webm` (VP9 + Opus), **960×540 @ 60 fps** capture of the game canvas |

## What the command does (pipeline)

`scripts/capture-gameplay.mjs` orchestrates the whole thing:

1. Starts the **Vite dev server programmatically** (`createServer` from the
   `vite` package) with `server.open: false`, so no browser window is opened
   by the usual `npm run dev` config.
2. Launches **headless Chromium** through Playwright with
   `--enable-unsafe-swiftshader` (required for software WebGL in headless
   mode) and `--no-sandbox`.
3. Installs the **page-side Web Audio tap** with `page.addInitScript`, before
   any game script runs, so the wrapper is in place when the game first
   connects its master gain to `context.destination` (see
   [Audio capture](#audio-capture)).
4. Loads the game and waits for the real `#game-container canvas` at
   `960×540`.
5. Starts a run through the **normal menu input path**: by default it presses
   **Tab** then **Enter** to activate the **Watch Demo** control (`Play Game`
   is focused by default, so Tab moves focus to Watch Demo), which starts
   `PlayScene` in demo mode; with `--scripted` it presses **Enter** to
   activate the focused **Play Game** control instead. Either gesture resumes
   the shared `AudioContext`. Waits `--warmup` ms for `PlayScene` to settle,
   then waits (bounded) for the tap to expose an audio track.
6. Calls `canvas.captureStream(60)`, muxes the canvas video tracks with the
   tapped audio tracks and starts a `MediaRecorder` **inside the page** with
   the resolved VP9+Opus mime.
7. Records the run. The default **demo** path installs a run-end listener
   **before the game boots** (`page.addInitScript`), waits for the dev-gated
   `aihell:run-ended` signal and keeps recording for `--tail` ms after it,
   bounded by `--max-duration` ms — a whole run, win or lose, instead of a
   fixed clip (see [Full-run capture](#full-run-capture-default)). With
   `--scripted` the deterministic bot plan (below) is replayed as **real
   Playwright `keyboard.down`/`keyboard.up` events** (trusted input, not
   synthesised DOM events); `--duration` keeps the legacy fixed-length clip.
8. Stops the recorder, decodes the produced WebM back through a `<video>`
   element and probes several sampled frames for **resolution, duration,
   non-black fraction, colour variety and frame-to-frame motion**, then
   decodes the audio with `decodeAudioData` for **peak and RMS**.
9. Streams the encoded chunks to Node over an `exposeFunction` binding and
   writes them to the output file.

## Dev scenarios (`--scenario`)

A real run reaches the Central AI boss only after all five levels, and the
boss then needs **400 hits** (4 phases × 100) to destroy — so neither the
recorder nor a human reviewer can practically observe the victory celebration
(AH-0MUWZ5HCV0034H44 producer-audit follow-up). A **dev scenario** is an
additive, dev-only shortcut that drops the run straight into a short boss
encounter:

```bash
# dev builds only: Play Game loads /?scenario=boss-four-hits, jumps to the
# boss with 4 hits remaining and freezes the run until the recorder releases it
npm run capture -- --scenario boss-four-hits
```

The scenario is selected by the `scenario` URL query parameter, parsed by the
pure `src/core/devScenario.ts` resolver. The capture only appends the query to
the game URL it loads (`captureUrl`) — it never reaches into Phaser internals.
Supported values:

| `scenario` | Effect |
|---|---|
| `boss-four-hits` | Jump to the boss with **4** hits remaining (the recorded demo). |
| `boss` | The same jump, with the hits tunable via `&bossHits=N` (e.g. `?scenario=boss&bossHits=12`). |

The scenario clears the opening wave, spawns the boss in its final phase with
no minions and its attacks disabled, and places the ship to the boss's left
facing it, so the auto-fire lands without input. The run is then **frozen** so
recording starts before the deliberately short fight ends; once the recorder
is live the capture releases it through the page-side scenario handle
(`window.__aiHellScenario.resume()`), so no keystroke is simulated and the
release is deterministic.

Everything is gated behind `import.meta.env.DEV`: a production build ignores
the query parameter (`resolveDevScenario` is never consulted), so the shipped
bundle and normal runs are unchanged.

## Full-run capture (default)

`npm run capture` records a **complete run**, not a fixed clip
(AH-0MUX2K8U7000GFNU). From the demo's start (Play Game / Watch Demo) through
_every level the run spans_ to the first game over, the recorder keeps
running, then continues for a **`--tail`** (default **5000 ms**) after the run
ends so the victory/defeat screen is visible, and stops.

### End-of-run signal

Because the run length varies (unseeded wave/spawn RNG), capture cannot assume
a duration — it detects the end from a small, additive, **dev-gated**
page-side signal emitted by `PlayScene._finishRun`
(AH-0MUXZ4BXK001QCEK, `src/core/runEndedSignal.ts`):

- a `CustomEvent` on `window` named **`aihell:run-ended`** whose `detail` is
  `{ won, score }`; and
- **`window.__aiHellRunState = { ended: true, won, score }`** as a race
  fallback.

Both fire for **victory and defeat**. The capture installs its listener with
`page.addInitScript` before the game boots (so a short run cannot end before
it is listening) and also polls the `window.__aiHellRunState` flag, so an
early end is still detected. The payload shape is owned by the pure
`buildRunEndedDetail` / `decodeRunEndedDetail` helpers in
`scripts/capture-run-lifecycle.mjs`, shared by the game emitter and the
capture decoder. The signal is gated by `import.meta.env.DEV`, so the shipped
bundle stays inert (`npm run check-bundle` still passes).

### Tail, cap and exit code

- **`--tail <ms>`** — how long to keep recording after the signal (default
  `5000`). Recording stops one tail after the signal, clamped to the cap.
- **`--max-duration <ms>`** — safety cap (default `1800000` = 30 min). If a
  run never signals, the recorder stops at the cap and the command **reports
  it and exits non-zero** — a capped clip is never presented as a complete
  run. The `--json` payload carries `fullRun`, `complete`, `capHit`,
  `runOutcome` (`{ won, score }` or `null`) and `runLengthMs`.
- **Backwards compatibility:** `--duration` and `--scripted` keep the legacy
  fixed-length behaviour; only the default demo path is a full run.

The stop/cap decision is the pure `evaluateRunStop` / `waitForRunEnd` pair in
`scripts/capture-run-lifecycle.mjs`, unit-tested with a fake clock and a
stubbed signal source.

### Demo game-over dwell

For the captured tail to show the outcome, the demo/attract mode holds on the
game-over screen before returning to the menu (AH-0MUXZ4CAE008QRFZ). On game
over the demo starts the shared `GameOverScene` with `{ demo: true }`, which
renders VICTORY/DEFEAT + the final score without leaderboard qualification or
initials and auto-returns to the menu after **`DEMO_GAME_OVER_DWELL_MS`**
(single-source, **>= the capture tail**). Normal (non-demo) play is unchanged,
and a demo run is **non-scoring**. The dwell is resolved by the pure
`resolveDemoGameOverDwellMs` / `shouldDemoReturnToMenu` helpers.

### Cost of long runs

A full victory run is far longer than the original 15 s spike clip: it spans
every level and the boss, so expect **minutes** of wall clock, a
correspondingly larger WebM file, and a non-deterministic length (the game is
not yet fully deterministic). A **defeat** run is typically much shorter. The
`--max-duration` cap and the heartbeat bound and surface the cost; there is
no frame-exact reproducibility yet (see
[Determinism gaps](#determinism-gaps)).

## Progress output & dependency preflight

A capture spends ~20 s producing no output (Vite + browser startup, warm-up,
recording, decode), which is easy to mistake for a hang. The command therefore
writes **milestone lines and a recording heartbeat to stderr** while reserving
stdout for the final report / `--json` payload
(AH-0MUWTNPY8003GGAA):

```
[capture] Starting Vite dev server…
[capture] Launching headless Chromium…
[capture] Loading http://127.0.0.1:46321/…
[capture] Starting in-game demo (Watch Demo)…
[capture] Recording the full run (tail 5.0s, cap 1800.0s)…
Recording [------------------------]   0%  2.0s/1800.0s  ETA 1798.0s
Recording [#-----------------------]   4%  65.0s/1800.0s  ETA 1735.0s
[capture] Encoding and probing the clip…
```

The full-run heartbeat reports **elapsed against the `--max-duration` cap**,
not against an assumed run length (the run length is not known in advance).

On a TTY the heartbeat overwrites itself in place; when redirected (logs, CI)
each heartbeat is a separate line. `--json` suppresses the human report and
prints only the JSON payload on stdout.

If the `playwright` devDependency or its Chromium binary is missing, the
command fails fast with the fix instead of a raw module-resolution stack:

```
playwright is required for automated gameplay capture but is not available.
Run: npm install && npm run capture:install
```

## The automated player (the bot)

**Default: the shipped in-game demo.** Since AH-0MUX496IJ0041O3V the capture
records the game's own **attract/demo mode** — the survival-first bot in
`src/ai/` plays a real run (seeking power-ups/minerals, dodging fire) with no
external input. The capture only starts the demo (Tab → Enter on **Watch
Demo**) and records it. `resolveCaptureMode` / `captureStartKeys` in
`scripts/capture-gameplay.mjs` select this path (default) versus the scripted
fallback. This is the higher-quality clip and exercises the same code that
ships.

**Fallback: the scripted sweep plan.** `scripts/capture-bot.mjs` owns the
legacy player, retained behind `--scripted`. It deliberately does **not**
reach into Phaser internals — it is a fixed, wall-clock-relative key plan:

- The ship **auto-fires**, so steering is the whole job.
- `BASE_SWEEP_PATTERN` is a deterministic left↔right sweep with small
  vertical bobs; `buildScriptedPlan(durationMs)` repeats it (truncating the
  final step) until the requested clip length is covered.
- Each step becomes a real `ArrowLeft` / `ArrowRight` / `ArrowUp` /
  `ArrowDown` hold via Playwright.

It drives **`PlayScene`, level 1, wave 1** (6 Scouts in a `v` formation)
straight from **Play Game** — nothing else needs to be navigated. This is the
`--scripted` fallback path; the default demo mode instead runs the shipped
`src/ai/` bot through the `Watch Demo` control.

The plan builder and the clip-verification predicate are pure functions,
unit-tested in `scripts/capture-gameplay.test.ts` (no browser
required). The browser/encode path itself is **not** unit-tested: the vitest
suite stubs the canvas (`src/test/setup.ts`), so there is nothing real to
record — it is exercised by `npm run capture` instead.

## Output & how "non-trivial" is verified

Output is a standard WebM file in `capture-output/` (git-ignored) by default.
`npm run capture` prints a report and exits **non-zero** if the clip is
trivial, so it can gate a future job:

```
AI_Hell automated gameplay capture
=================================
Output:     …/capture-output/gameplay-….webm
Size:       3561.3 KiB
Resolution: 960x540 @ 12799 ms
Renderer:   WebKit WebGL
Non-black:  1.29% of pixels
Colours:    564 distinct (16-level buckets)
Motion:     0.0033 mean frame delta
Audio:      1 track(s), peak 0.4447, rms 0.0775
Non-trivial: yes
```

The probe (`isNonTrivialClip`) rejects an **empty** recording, a clip with **no
decodable frames**, an essentially **black** frame, a frame with **too few
colours**, and **static** frames. AI_Hell is intentionally dark (neon sprites
on black), so the thresholds are deliberately loose — "actual gameplay/VFX,
not black or static" — rather than requiring a bright image.

The clip verdict is now the **combination** of the video probe and the audio
probe (see [Audio capture](#audio-capture)): a clip with no audio track, or
with decoded audio at/below the silence floor, fails and the command exits
non-zero — so `npm run capture` can no longer silently emit a silent clip.

## Rejected alternatives

### B. CDP screencast / per-frame capture

Playwright's built-in `recordVideo` (CDP `Page.startScreencast`, muxed by
Playwright's bundled ffmpeg) or `canvas.toDataURL()` per frame piped to
ffmpeg.

**Rejected because:** the screencast captures the **browser viewport**, not
the canvas, at a browser-driven cadence, so it can drop/duplicate frames under
load and may include letterboxing; and its encode path depends on Playwright's
**minimal ffmpeg build**, which (verified) ships only `libvpx` **VP8** and no
VP9/H.264 decoder — a dead end for any in-house transcoding, frame extraction
or inspection. Approach A instead yields a WebM blob we fully control and can
decode/probe in-page.

### C. In-engine snapshot loop

A dev-only mode calling `Phaser game.renderer.snapshot()` on a fixed tick,
writing frames and encoding externally.

**Rejected because:** snapshotting is synchronous and stalls the game loop;
it needs in-engine dev hooks (touching `src/`, against the spike's "opt-in,
no shipped-bundle impact" constraint); it captures only what the renderer
draws (no live composited canvas / any overlay); and audio would still need a
separate path. Strictly more code than A for no gain here.

### D. Deterministic replay

Drive `src/test/gameHarness.ts` with a recorded/seeded input sequence, render
headless and encode.

**Rejected for this spike because:** the game is **not deterministic yet** —
wave/spawn timing still draws from wall-clock and `Math.random()` (see below)
and there is no input-recording/replay format. Best long-term
reproducibility, but it would require seeding all RNG *and* building a replay
format — both explicitly out of scope. Revisit once determinism lands.

## Known limits

### Headless WebGL reliability

`Phaser.AUTO` resolves to **WebGL** in headless Chromium via the software
(SwiftShader) backend, and it renders correctly — but it is CPU-rendered, so
it is slower than a GPU and emits a deprecation warning unless
`--enable-unsafe-swiftshader` is passed (the script passes it). If a future
browser/config loses WebGL, force the renderer explicitly
(`type: Phaser.CANVAS`) or fall back to approach C. Treat headless WebGL as
"works, but verify after Playwright/Chromium upgrades".

### Audio capture

The captured clip carries the game's **own SFX**, synchronised with the
recorded gameplay — no separately generated bed and no external mux
(AH-0MUWTNPYJ0031FQE).

**How the tap works (approach A1 — page-side, no `src/` change).** The game
owns exactly one `AudioContext`: `installGameAudio` pins it to Phaser's sound
manager at boot and every SFX routes through a single master `GainNode`
connected to `context.destination` (`src/audio/sfxPlayback.ts`,
`src/audio/effects.ts`). Before the page's first script runs, the capture
installs a wrapper via Playwright's `page.addInitScript` that intercepts
`AudioNode.prototype.connect`: whenever a node is connected to
`context.destination`, the same source is **also** connected to a
`MediaStreamAudioDestinationNode` created lazily on that same context. The
recorder stream is then the canvas video tracks plus the capture
destination's audio tracks:

```js
new MediaStream([
  ...canvas.captureStream(60).getVideoTracks(),
  ...captureDest.stream.getAudioTracks(),
]);
```

Only connections to `context.destination` are mirrored, so the tap cannot
feed back into itself, and a node that bridges several inputs is still
tapped once per context. The wrapper mirrors the original `connect` return
value and never throws — a tap failure must not break the game's own audio.

Because the tap is injected page-side, `src/` and the shipped Vite bundle are
untouched (`npm run check-bundle` still passes). The recorder mime is chosen
by `resolveCaptureMimeType`: **`video/webm;codecs=vp9,opus`**, then
`video/webm;codecs=vp8,opus`, then plain `video/webm`; when no game audio is
available it falls back to the matching video-only list so the container
never advertises an Opus track it will not contain.

**Why it works under the browser autoplay policy.** Browsers block an
`AudioContext` from starting until a user gesture. The capture's Enter
keypress (which activates **Play Game**) is a real, trusted gesture, and
`MenuScene`'s handler calls `resumeAudioContext(this.sound)` — the same path
a human player uses. The capture waits (bounded, 3 s) for the shared context
to report `running` before recording; if audio never becomes available it
records video-only and reports the track as absent rather than failing.

**No system audio device needed.** Headless Chromium is CPU-rendered and has
no sound card, but `MediaStreamAudioDestinationNode` renders the Web Audio
graph into the media stream regardless of any hardware output device, so the
tap works in CI exactly as it does locally.

**How audio is verified (no auditioning).** After the recorder stops, the
in-page probe decodes the produced WebM/Opus blob with
`AudioContext.decodeAudioData`, samples every channel and reports
`audioTrackCount`, `audioPeak` and `audioRms`. The pure `evaluateAudioTrack`
helper turns those into a verdict against documented floors
(`AUDIO_SILENCE_PEAK_FLOOR = 0.005`, `AUDIO_SILENCE_RMS_FLOOR = 0.0005`);
AI_Hell's early levels are sparse, so a low but non-zero **peak** is the
primary gate. `combineClipVerdict` then requires **both** the video and the
audio verdict to pass, and the report and `--json` payload expose the result.
If decoding is unsupported or the blob cannot be decoded, the failure is
reported explicitly (`audioDecodeError` / an `Audio:` report note) and the
clip fails rather than silently passing. A clip with no audio track, or with
decoded audio at/below the floor, exits non-zero.

### Determinism gaps

Only the VFX RNG is seeded (`src/vfx/explosionParticles.ts`,
`src/vfx/playerDeathJuice.ts`). Wave/spawn/timing randomness still uses
wall-clock and `Math.random()`, so **two captures of the same scripted input
are not frame-identical**. Identified unseeded sources:
`src/waves/WaveManager.ts`, `src/entities/Swarm.ts`, `src/entities/Boss.ts`,
`src/entities/Scout.ts`, `src/entities/Mineral.ts` and
`src/entities/Asteroid.ts`. The clip is still valuable (the bot input is
identical run to run); full reproducibility needs the seeding work tracked
separately.

### No MP4 output (ffmpeg)

There is **no `ffmpeg` on `PATH`**, and Playwright's bundled ffmpeg is a
minimal build (VP8 only, no VP9/H.264 encoder), so it **cannot** transcode the
VP9 WebM to MP4 or extract frames. Output is therefore **WebM only**. An MP4
export needs a full ffmpeg install; if added, post-process *after* capture
(e.g. `ffmpeg -i gameplay.webm -c:v libx264 gameplay.mp4`) rather than
changing the capture path. The audio tap deliberately needs **no full
`ffmpeg`**: the game's Opus track is muxed in-browser by `MediaRecorder` and
the bundled minimal ffmpeg is never invoked.

### Rejected fallback: offline WAV + external mux

The alternative — reuse the offline WAV pipeline (`npm run build-audio`,
`scripts/build-audio.mjs`) and mux the WAV with the captured WebM using a full
`ffmpeg` — is **not** used. It is a separately generated bed, not the game's
own SFX, so it cannot be synchronised with in-game events (against
AH-0MUWTNPYJ0031FQE AC1), and it needs a full `ffmpeg` install that the
Playwright bundle does not provide. The shipped path requires **no full
`ffmpeg`**; retain this only as a documented fallback if the in-page Web
Audio tap ever proves impossible.

### Estimated CI cost

Measured on the reference host (2026-10-06):

- **Browser download (one-time):** `playwright install chromium` fetches
  **~174 MiB** (full Chromium) **+ ~104 MiB** (headless shell) ≈ **278 MiB**;
  ~**915 MiB** on disk for both. `playwright install --only-shell chromium`
  avoids the full build where only headless capture is needed.
- **Encode/wall time:** a 12 s **video + Opus audio** clip completes in
  **~19 s** wall clock (≈ 1.6× realtime), peak RSS ≈ **660 MB**; the
  video-only spike measured ~18 s / ~500 MB, so the audio tap and Opus encode
  are close to run-to-run variation on this host. The Opus track adds only
  ~0.1–0.2 MiB to the file (reference 12 s clip: **2.35 MiB**).
- **No audio device:** the tap renders `MediaStreamAudioDestinationNode`
  without any system sound card, so headless CI needs no audio hardware.
- **Node dependency:** the `playwright` npm package (~a few MB; browsers are
  a separate download).

Recommendation: run capture as an **opt-in local/CI job**, never as part of
`npm test` / `npm run build`.

### Additive / opt-in guarantee

- The capture code lives entirely under `scripts/` and is **never imported by
  `src/`**, so it cannot enter the shipped Vite bundle.
- `playwright` is a **devDependency**; browser binaries are downloaded by an
  explicit command.
- `capture-output/` is git-ignored.
- `npm test` and `npm run build` are unchanged and still pass.

## Files

| File | Purpose |
|---|---|
| `scripts/capture-gameplay.mjs` | Orchestrator: Vite server, headless Chromium, record, drive bot, probe, write WebM; progress + preflight |
| `scripts/capture-bot.mjs` | Deterministic bot plan + `isNonTrivialClip` / `evaluateAudioTrack` / `combineClipVerdict` predicates + the page-side `AudioNode.connect` tap (pure, testable) |
| `scripts/capture-bot.d.mts` | Types for the plain-JS bot module |
| `scripts/capture-gameplay.d.mts` | Types for the capture orchestrator's pure arg/mode helpers |
| `scripts/capture-progress.mjs` | Pure duration / ETA / progress-bar + audio-summary formatting + setup hint |
| `scripts/capture-progress.d.mts` | Types for the progress module |
| `scripts/capture-run-lifecycle.mjs` | Pure run-lifecycle contracts: signal encode/decode, tail/cap arithmetic, the `waitForRunEnd` loop, run summary and demo dwell |
| `scripts/capture-run-lifecycle.d.mts` | Types for the run-lifecycle module |
| `scripts/capture-gameplay.test.ts` | Hermetic unit tests for the plan builder, probe/audio-verdict predicates, audio tap and progress helpers |
| `src/core/devScenario.ts` | Dev-gated scenario resolver + page-side release handle consumed by `--scenario` (pure, testable; no-op in production) |
| `package.json` | `capture` / `capture:install` scripts; `playwright` devDependency |
| `.gitignore` | ignores `capture-output/` |
