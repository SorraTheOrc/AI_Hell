# Automated gameplay capture (dev tooling)

> **Status: spike proof-of-concept** — AH-0MUWMFF3C002WOBK.
> The deliverable is a *working* capture path plus this written
> recommendation, not a production pipeline. Productionising it, seeding all
> RNG or wiring it into CI are explicitly **out of scope** (record those as
> follow-up work items instead).

This document records how AI_Hell can produce a gameplay video **without a
human recording their screen**: one opt-in command boots the game in a real
rendering browser, plays a scripted segment automatically, and writes a
playable video file locally.

## TL;DR — recommended approach

**Approach A: headless Chromium (Playwright) + `canvas.captureStream(60)` +
`MediaRecorder` → WebM.**

```bash
# one-time: install JS deps + the matching browser
npm install
npm run capture:install          # playwright install chromium (~278 MiB download)

# record a 15 s clip (default) to capture-output/gameplay-<timestamp>.webm
npm run capture

# or control it explicitly
npm run capture -- --duration 20000 --output clips/demo.webm
npm run capture -- --headed      # watch it drive a visible browser
```

This was proven end to end on 2026-10-06: a 12 s clip recorded at
**960×540, WebM/VP9, ~3.5 MiB**, decoded back and probed at **2.2 % non-black
pixels, 1161 distinct colours, non-zero inter-frame motion**, with **zero page
errors**.

## Exact tooling & versions

| Component | Version / notes |
|---|---|
| Playwright (npm) | `1.55.1` (devDependency; chosen to match the browser already cached on the host — any 1.55.x works) |
| Chromium | `140.0.7339.186` (Playwright build **v1193**) |
| Renderer | `Phaser.AUTO` → **WebGL**, via headless Chromium's software (SwiftShader) backend |
| Encoder | browser-native `MediaRecorder`, preferring `video/webm;codecs=vp9` (falls back to VP8 / plain WebM) |
| Output | `.webm` (VP9), **960×540 @ 60 fps** capture of the game canvas |

## What the command does (pipeline)

`scripts/capture-gameplay.mjs` orchestrates the whole thing:

1. Starts the **Vite dev server programmatically** (`createServer` from the
   `vite` package) with `server.open: false`, so no browser window is opened
   by the usual `npm run dev` config.
2. Launches **headless Chromium** through Playwright with
   `--enable-unsafe-swiftshader` (required for software WebGL in headless
   mode) and `--no-sandbox`.
3. Loads the game and waits for the real `#game-container canvas` at
   `960×540`.
4. Presses **Enter**, which activates the focused **Play Game** control in
   `MenuScene` (the whole game is keyboard-navigable — see the README's
   *Keyboard-only navigation* note), then waits `--warmup` ms for
   `PlayScene` to settle.
5. Calls `canvas.captureStream(60)` → `new MediaRecorder(stream, …)` **inside
   the page** and starts it.
6. Replays the deterministic bot plan (below) as **real Playwright
   `keyboard.down`/`keyboard.up` events** (trusted input, not synthesised DOM
   events).
7. Stops the recorder, decodes the produced WebM back through a `<video>`
   element and probes several sampled frames for **resolution, duration,
   non-black fraction, colour variety and frame-to-frame motion**.
8. Streams the encoded chunks to Node over an `exposeFunction` binding and
   writes them to the output file.

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
[capture] Starting PlayScene (Enter)…
[capture] Recording 15.0s of scripted gameplay…
Recording [########----------------]  34%  5.1s/15.5s  ETA 10.4s
Recording [################--------]  67%  10.4s/15.5s  ETA 5.1s
Recording [########################] 100%  15.5s/15.5s  ETA 0.0s
[capture] Encoding and probing the clip…
```

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

`scripts/capture-bot.mjs` owns the player. It deliberately does **not** reach
into Phaser internals — it is a fixed, wall-clock-relative key plan:

- The ship **auto-fires**, so steering is the whole job.
- `BASE_SWEEP_PATTERN` is a deterministic left↔right sweep with small
  vertical bobs; `buildScriptedPlan(durationMs)` repeats it (truncating the
  final step) until the requested clip length is covered.
- Each step becomes a real `ArrowLeft` / `ArrowRight` / `ArrowUp` /
  `ArrowDown` hold via Playwright.

It drives **`PlayScene`, level 1, wave 1** (6 Scouts in a `v` formation)
straight from **Play Game** — nothing else needs to be navigated.

The plan builder and the clip-verification predicate are pure functions,
unit-tested in `scripts/capture-gameplay.test.ts` (19 tests, no browser
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
Non-trivial: yes
```

The probe (`isNonTrivialClip`) rejects an **empty** recording, a clip with **no
decodable frames**, an essentially **black** frame, a frame with **too few
colours**, and **static** frames. AI_Hell is intentionally dark (neon sprites
on black), so the thresholds are deliberately loose — "actual gameplay/VFX,
not black or static" — rather than requiring a bright image.

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

### Audio capture — explicitly **deferred**

The captured clip is **silent**. Web Audio is gated behind a user gesture and
the capture path does not currently mix an audio track. Deferring was a
deliberate time-box decision. To add it later: route the game's Web Audio
through a `MediaStreamAudioDestinationNode`, combine it with the canvas
stream (`new MediaStream([...videoTracks, ...audioTracks])`) before handing it
to `MediaRecorder`, and use the Enter keypress as the gesture that resumes the
`AudioContext`. Alternatively reuse the offline WAV pipeline
(`npm run build-audio`, `scripts/build-audio.mjs`) and mux it externally.

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
changing the capture path.

### Estimated CI cost

Measured on the reference host (2026-10-06):

- **Browser download (one-time):** `playwright install chromium` fetches
  **~174 MiB** (full Chromium) **+ ~104 MiB** (headless shell) ≈ **278 MiB**;
  ~**915 MiB** on disk for both. `playwright install --only-shell chromium`
  avoids the full build where only headless capture is needed.
- **Encode/wall time:** a 12 s clip completes in **~18 s** wall clock
  (≈ 1.5× realtime), peak RSS ≈ **500 MB**.
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
| `scripts/capture-bot.mjs` | Deterministic bot plan + `isNonTrivialClip` predicate (pure, testable) |
| `scripts/capture-bot.d.mts` | Types for the plain-JS bot module |
| `scripts/capture-progress.mjs` | Pure duration / ETA / progress-bar formatting + setup hint |
| `scripts/capture-progress.d.mts` | Types for the progress module |
| `scripts/capture-gameplay.test.ts` | Hermetic unit tests for the plan builder, probe predicate and progress helpers |
| `package.json` | `capture` / `capture:install` scripts; `playwright` devDependency |
| `.gitignore` | ignores `capture-output/` |
