# Performance

How the game's frame time is measured, what the numbers mean, and how to
compare two runs. This is the prerequisite for every optimisation in the
Optimization pass epic (parent AH-0MVWJQUN6009IS87): nothing is optimised or
claimed as an improvement without a harness number before and after.

The harness itself is AH-0MVXV0DER009ER70. The reproducible 100-enemy worst
case is the **`GymPerformance` stress gym** (AH-0MVXV0DT50028RF8) — see
[the stress gym](#the-stress-gym-gymperformance) below. The measured baseline,
the CPU profile and the ranked hotspot list are recorded in
[Baseline (100 enemies, 60 s)](#baseline-100-enemies-60-s) and
[Ranked hotspots](#ranked-hotspots) (AH-0MVXV0E8000937U5). The **Electron
desktop host** is now measurable and has its own recorded baseline
([Electron baseline](#electron-baseline-software-gpu-process-rasteriser),
AH-0MW2DB9VN006XB63). The **hardware-GPU desktop-browser** baseline is still
outstanding — see
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline-outstanding). The
**final target verification** (AH-0MVXV6VOI006P7VG) measures the finished tree
end to end and records the parity and determinism evidence — see
[Final target verification](#final-target-verification-ah-0mvxv6voi006p7vg).

## The stress gym (`GymPerformance`)

The performance budget is stated against **100 late-game enemies alive**, but
the shipped curated waves never field that many, so the target had no
reproducible worst case. `GymPerformance` (AH-0MVXV0DT50028RF8) is that case
on demand, built entirely from the shared gym/combat core — it is not a second
simulation:

- **Exactly 100 enemies** (the budget's number) on a fixed 10 × 10 row-major
grid. The archetypes are the **firing** archetypes the campaign's final third
(levels 6–10) fields — `tank`, `swarm`, `phaser`, `diver`, `raider` and `march`
— round-robined over the grid. Non-firing late-game threats (the `capturer`
beam, the `harvester`, the `grunt` horde) are excluded because the measured
load is *enemies plus bullets*.
- **Live fire from the first frame**: every entity is created by the shared
`createEnemyFromConfig` factory and fires through the shared `fireForEnemy`
dispatcher, at its own archetype's cadence. The scene boots with the SHOOT
toggle ON (`shootEnabled: true` in its formation config) instead of needing a
click.
- **Only the target load**: formation drift is 0 (the block does not scroll
off), there is no wave timeout (the count stays at 100 for the whole window),
no power-up layer and **no seeded mineral field** (`minerals: false`). The
shared player ship sits at the bottom centre — enemy aimed and spread fire
targets it, so the fire behaviour is the game's — but **its auto-fire is
disabled** (`autoFireEnabled()` is `false`), so player bullets cannot shoot the
100-enemy load down mid-measurement.
- **Live readout**: a top-left overlay reports FPS and the live entity counts,
refreshed at 4 Hz (never per frame) so the overlay stays off the measured hot
path. The authoritative counts for reports come from the same shared
`CombatScene.getPerformanceCounts()` seam the probe samples; the stress gym
adds its (empty) mineral count so the report shape matches `PlayScene`.

```bash
npm run perf:measure -- --scene GymPerformance --seconds 60 --warmup 3
```

Read the numbers with the `counts` block, not just the frame times: enemy
bullets build up while firing is live and the mix shifts as divers dive and
raiders break formation, so compare two `GymPerformance` runs only when the
scene, warmup, window, CPU throttle and host all match. The gym is also
watchable/capturable like every other gym (`WATCHABLE_GYM_SCENE_KEYS`, see
[docs/dev/gameplay-capture.md](dev/gameplay-capture.md)).

## The desktop host (Electron)

The budget is stated for "desktop browser **and Electron**". The browser half
is measured by the default harness path; the Electron half needed a desktop
host, which this repository now has: `electron/main.mjs` hosts the game in an
Electron `BrowserWindow`, and `--host electron` measures it with the **same**
probe, scene, report and comparison maths as a browser run
(AH-0MW2DB9VN006XB63).

```bash
npm run dev                                       # the host loads the dev server
npm run electron                                  # windowed desktop host (hardware GPU)
npm run electron:headless                         # no display, software WebGL
npm run perf:measure:electron -- --scene GymPerformance --seconds 60 --warmup 3
npm run perf:measure -- --host electron --gpu --scene GymPerformance --seconds 60
```

Electron is an **optional dependency** (`optionalDependencies`), so an install
that cannot fetch the ~110 MB binary — a Node version below the package's
`engines` floor, or an offline CI image — still leaves the browser harness and
the rest of the project working; `--host electron` then stops with the install
command. The measured rows below used electron 45.2.2 on Node v22.22.1.

What the host is, and what it is not:

- **It hosts the dev build.** The in-page probe is dev-gated
  (`window.__aiHellPerfProbe`, `src/core/perfProbe.ts`), so a production bundle
  contains nothing the harness can sample. `npm run electron:dist` loads
  `dist/index.html` to check that the desktop host boots the shipped bundle;
  that run is not measurable. Installer/packaging config (electron-builder,
  Tauri, signing) is **not** part of this change — the host is the renderer a
  packaged app would use.
- **A hidden window is throttled to ~1 Hz.** Chromium treats a never-shown
  window as occluded and throttles `requestAnimationFrame`, so the host shows
  its window even under `--ozone-platform=headless` (where there is no screen),
  and the harness fails the run if the window never became visible instead of
  publishing 1 Hz frame times.
- **The renderer profile does not see GPU-process work.** Under
  `--host electron` this host rasterises in Chromium's **GPU process**
  (multi-threaded SwiftShader on a software-only host, ~7.5 cores at 100
  enemies). A renderer-side CDP profile therefore shows that rasterisation as
  *idle*, not as `native` — the `native`/`idle` split is **not** comparable
  between a browser run and an Electron run. Read the frame times and the JS
  attribution; do not compare those buckets across hosts.
- **`--cpu-throttle` only throttles the renderer process.** Under
  `--host electron` it does not slow the GPU process, so the mobile tier must
  be measured with `--host browser` (headless Chromium, software GL on the
  renderer thread).

### Measuring a hardware-GPU run

`--gpu` drops the software-WebGL switch and asks Chromium for the real GPU
(`--ignore-gpu-blocklist`, GPU rasterisation). Because a headless Chromium
asked for hardware GL can still fall back to SwiftShader, the
`--require-hardware-webgl` guard **refuses the run** (exit 1) unless the
report's `webgl.kind` is `hardware` — a software fallback can never be
published under a desktop label:

```bash
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymPerformance --seconds 60
npm run perf:measure -- --host electron --gpu --require-hardware-webgl \
  --scene GymPerformance --seconds 60
```

On this host the guard refuses both, quoting the exact software renderer string
— see [Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline-outstanding).

## Budget

| Tier | Target | Notes |
|---|---|---|
| Desktop browser and Electron | **60 FPS** with 100 late-game enemies alive — p95 frame time ≤ 16.7 ms with no sustained long-frame spike | The number every optimisation child must beat. |
| Mobile browser | **≥ 30 FPS** under a fixed CPU throttle (≥ 4×) with 100 enemies | Mobile is explicitly allowed a lower target, but must stay playable. |

The target is only falsifiable alongside a **reference machine**. Every report
records the host it ran on (`host` in the JSON: platform, CPU model, CPU count,
memory, load average, Node version) and the WebGL backend it actually used
(`webgl`); record both next to any baseline you publish.

The recorded baseline (headless Chromium with the **SwiftShader** software
renderer) is below both targets today — 36.2 FPS desktop, 19.9 FPS at the
mobile-tier throttle — see [Baseline (100 enemies, 60 s)](#baseline-100-enemies-60-s).
Those are the reproducible floor of the **headless-shell browser path** on this
host, not a verdict on hardware: the Electron desktop host holds the 60 FPS
step on the same software rasteriser
([Electron baseline](#electron-baseline-software-gpu-process-rasteriser)), and
a hardware-GPU desktop run is still outstanding
([why](#hardware-gpu-desktop-baseline-outstanding)).

## Measuring a run

```bash
npm run perf:measure                                   # PlayScene, 10 s, headless
npm run perf:measure -- --seconds 60                   # the 60-second target run
npm run perf:measure -- --scene GymPerformance --seconds 60
npm run perf:measure -- --cpu-throttle 4               # the mobile tier
npm run perf:measure -- --out perf-baseline.json       # keep the JSON report
npm run perf:measure -- --compare perf-baseline.json    # before/after deltas
npm run perf:measure -- --profile perf-output/gym.cpuprofile   # + a CPU profile
npm run perf:measure -- --scene PlayScene --setup '{"demo":true,"seed":1,"startLevel":10}'
npm run perf:measure -- --host electron --electron-executable /path/to/electron   # desktop host
npm run perf:measure -- --gpu --require-hardware-webgl                           # a real GPU, or exit 1
```

`npm run perf:measure` is `node scripts/measure-performance.mjs`. The harness
starts the Vite dev server itself, launches headless Chromium through
Playwright, activates **Play Game** with a real `Enter` gesture (or switches to
a gym `--scene` inside the already-running page through the dev-only capture
director), lets the scene settle for `--warmup` seconds, samples the loop for
`--seconds`, and exits. It needs the Playwright Chromium build:
`npm run capture:install`.

### Options

| Option | Default | Meaning |
|---|---|---|
| `--scene <key>` | `PlayScene` | The shipped game or any watchable gym key (`GymPlayer`, `GymBoss`, … — the list is the shared capture registry `scripts/capture-scenes.mjs`). |
| `--host <name>` | `browser` | `browser` (headless Chromium, the original path) or `electron` (the desktop host in `electron/main.mjs`). Recorded in the report as `runtime.kind`. |
| `--gpu` | off | Request the hardware GPU instead of the software (SwiftShader) backend. Drops the software-permitting switch, so a GPU-less host reports absent/software WebGL instead of silently using it. |
| `--require-hardware-webgl` | off | Fail the run (exit 1) unless `webgl.kind` is `hardware` — use it on every run published as a desktop baseline. |
| `--electron-executable <path>` | the installed `electron` package | Electron binary for `--host electron` (also `$AI_HELL_ELECTRON_BIN`). |
| `--seconds <n>` | `10` | Measured window (max 600). |
| `--warmup <n>` | `3` | Seconds before sampling starts, so scene creation, first-wave spawns and texture uploads are not counted. |
| `--cpu-throttle <n>` | `1` | Chromium CPU throttling factor applied before sampling (e.g. `4` for the mobile tier). Applied through the DevTools protocol. |
| `--out <file>` | — | Also write the JSON report to `<file>`. |
| `--compare <file>` | — | Compare the new run against a previously written report (see below). |
| `--profile <file>` | — | Capture a CDP CPU profile over the measured window and write the raw `.cpuprofile` to `<file>` (see [CPU profiling](#cpu-profiling)). |
| `--profile-interval <µs>` | `1000` | CDP CPU sampling interval in microseconds (100–10000). |
| `--setup <json>` | — | Scene launch data forwarded to the dev-gated capture director — e.g. `{"demo":true,"seed":1,"startLevel":10}` to measure late-game `PlayScene` (see [PlayScene late game](#playscene-late-game-supplementary)). |
| `--json` | off | Suppress the human summary; print JSON only (for CI). |
| `--headed` | off | Show the browser window instead of running headless. |
| `--port <n>` | ephemeral | Fixed Vite dev-server port. |

### Output

The **JSON report goes to stdout** (and to `--out`); the human summary and
progress milestones go to stderr, so piping stdout into `jq` always works:

```bash
npm run perf:measure -- --seconds 60 --json 2>/dev/null | jq '.frameTimeMs'
```

Report fields:

| Field | Meaning |
|---|---|
| `scene`, `requestedSeconds`, `warmupSeconds`, `cpuThrottle` | The run configuration (**always** recorded, so two reports can be compared only when they match). |
| `runtime` | The measured host: `kind` (`browser`/`electron`) plus the Electron and Chromium versions. |
| `method` | How frame times were sampled — `phaser-game-loop/poststep-frame-delta` (see [Measurement method](#measurement-method)). |
| `startedAt`, `host` | When and where the run happened (see [reference machine](#reference-machine)). |
| `webgl` | The WebGL backend the page actually used (`vendor`/`renderer`/`version`), plus `kind`: `software` for a CPU rasteriser (SwiftShader, llvmpipe, …), `hardware` for a real GPU driver string, `unknown` when there is no context. Headless Chromium falls back to SwiftShader, so a run can never be mistaken for a hardware-GPU run on a label alone. |
| `elapsedSeconds`, `frames` | The measured wall-clock span and the number of sampled frame intervals. |
| `frameTimeMs.p50`, `.p95`, `.max`, `.mean` | Frame-time percentiles in milliseconds. Percentiles, not means, so one hitch does not hide the typical frame. |
| `fps.effective` | `frames ÷ elapsedSeconds` — the loop's real throughput. |
| `fps.phaserActualFps` | Phaser's own smoothed `game.loop.actualFps` reading at the end of the window (cross-check). |
| `longFrames.over33Ms`, `.over50Ms` (+ percentages) | Frames slower than 33 ms (a missed 30 FPS frame) and 50 ms (a visible hitch). Counts are strict (`>`), so a frame at exactly 33.0 ms is not a long frame. |
| `counts.peak`, `.mean`, `.last`, `.samples` | Live enemies, enemy bullets, player bullets and minerals sampled every 250 ms — the load that produced the frame times. `counts` is `null` when the scene exposes none. |
| `activeSceneKeys`, `pageErrors` | Proof of which scene actually ran, and any page exception during the window (a page error fails the run). |
| `profile`, `profileFile` | The CPU-profile summary (buckets, JS/idle shares, ranked hotspots) and the raw profile path — present only with `--profile` (see [CPU profiling](#cpu-profiling)). |

Exit codes: `0` success, `1` a failed run (missing dependency, no frames, page
error), `2` a bad argument. The harness is CI-runnable as-is; wiring a pipeline
job is deliberately left to a follow-up.

## Measurement method

`method: phaser-game-loop/poststep-frame-delta` — frame times are the
differences between consecutive Phaser `Phaser.Core.Events.POST_STEP`
(`poststep`) timestamps, read by the dev-gated page probe
(`window.__aiHellPerfProbe`, `src/core/perfProbe.ts`) registered at boot in dev
builds only — the global is never written in a production build. This is
Phaser's own loop, fired once per rendered frame after the scene manager
updates, so the number is the **game loop's real frame interval** (simulation +
render + browser scheduling) rather than a bare `requestAnimationFrame` counter
or a nominal 60 FPS.

The probe is the only page-side measurement code; it also samples the entity
counts (250 ms cadence, so the probe stays off the measured frame's hot path)
from the shared `CombatScene.getPerformanceCounts()` seam, which every combat
gym and `PlayScene` implement — the counts therefore come from one shared
implementation (gym↔game parity) rather than per-scene telemetry copies.

`method` is part of the report header so numbers from a different sampling
strategy can never be compared by accident.

## CPU profiling

Frame time tells you *that* the loop is slow; the CPU profile tells you *where*.
`--profile <file>` records a Chrome DevTools CPU profile
(`Profiler.start`/`Profiler.stop` over the **same measured window** as the frame
times) and writes the raw `.cpuprofile` to `<file>`; the run's JSON report also
carries a summary under `profile`:

```bash
npm run perf:measure -- --scene GymPerformance --seconds 60 \
  --profile perf-output/gym.cpuprofile --out perf-output/gym.json
```

The raw file opens in Chrome DevTools (Performance → Load profile) or
[speedscope](https://www.speedscope.app/). Profiles are generated locally and
**not committed** (`perf-output/` is gitignored); the published numbers live in
this document.

### What the summary contains

| Field | Meaning |
|---|---|
| `samplingIntervalUs` | CDP sampling interval (`--profile-interval`, default 1000 µs, range 100–10000) |
| `windowSeconds`, `samples`, `totalMs` | The profiled window and how much sampled time it contains |
| `buckets[]` | Self time per bucket, in ms and as a share of the window (see below) |
| `mainThreadJsPercent` | Share of the window spent **running JavaScript** — the number the CPU-bound question is read from |
| `mainThreadIdlePercent` | Share of the window the main thread spent idle (waiting on vsync/compositor/GPU) |
| `topFunctions[]`, `topProjectFunctions[]`, `topFiles[]` | Hotspots ranked by **self time** (game code only for `topProjectFunctions`), each with the share of the window **and** the share of JS |

`selfMs` is the sum of the sample deltas attributed to that function, so a
parent is never credited for its children's work.

### Buckets

| Bucket | What it holds |
|---|---|
| `simulation` | Game code under `src/` that advances the world (scenes, entities, waves, AI, utils, core) |
| `renderer` | Phaser internals — per-object draw submission, batching, the Graphics pipeline, texture work |
| `ui` | `src/ui/` and the HUD/banner modules in `src/core/` |
| `audio` | `src/audio/` and ToneForge |
| `gc` | V8 `(garbage collector)` samples — allocation pressure |
| `idle` | V8 `(idle)` samples — the main thread waiting |
| `native` | Native/VM frames the JS profiler cannot attribute (`(program)`, `(root)`, URL-less frames): GL command submission, raster, DOM, structured clone |
| `other` | Third-party dependencies other than Phaser, and the dev-only measurement probe |

Two caveats matter when reading a verdict:

- **`native` cannot distinguish "busy" from "blocked".** A main thread blocked
  inside a synchronous GL call is sampled as `native`, exactly like one running
  native code. Read `native` as "the main thread was inside non-JS work (or
  waiting in it)", never as "the CPU was saturated".
- **`line` is the transpiled line.** The profile records lines in the module the
  browser executed (the esbuild-transpiled dev output), not the TypeScript
  source line. Resolve a hotspot to its source declaration by function name —
  every row in [Ranked hotspots](#ranked-hotspots) is resolved that way.

## Baseline (100 enemies, 60 s)

This is the "before" number every optimisation child must beat (parent
AH-0MVWJQUN6009IS87 AC3, recorded by AH-0MVXV0E8000937U5 on top of commit
`3e33e5c9` — the same change added `--profile`/`--setup` to the harness and
touched no game code, so the numbers describe the game at that commit).
Every row is `GymPerformance` — exactly 100 late-game enemies with live fire,
~200 live enemy bullets, minerals disabled, player auto-fire disabled —
measured with `--seconds 60 --warmup 3` on the reference machine below, in
headless Chromium with the **SwiftShader** software WebGL backend (the exact
renderer string is recorded in every report under `webgl`). "Host load" is the
1-minute load average recorded with the report.

### Desktop tier (headless Chromium, software WebGL)

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 8.97 | 33.3 | 33.4 | 66.7 | 27.57 | 36.27 | 1356 (62.3 %) | 10 (0.46 %) | 323 / 203.9 |
| 2 | 12.63 | 33.3 | 33.4 | 66.7 | 27.06 | 36.96 | 1360 (61.4 %) | 5 (0.23 %) | 328 / 210.4 |
| 3 (profiled) | 9.28 | 33.3 | 33.4 | 66.6 | 27.59 | 36.24 | 1413 (65.0 %) | 5 (0.23 %) | 345 / 215.0 |

Enemies are exactly 100 in peak *and* mean in every run, so the load is fixed
and the frame times are comparable run to run.

**Reproducibility.** Runs 1–3 agree to within 1.9 % on effective FPS and
**0.0 %** on p50 and p95 — well inside the ±20 % p95 noise floor. The baseline
is trustworthy (parent AC6).

### Host-load sensitivity (why the load is recorded)

The same scene and commit on a **busier** host (other agents' test suites
running) is ~27 % slower, and the tail moves most:

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms |
|---|---|---|---|---|---|---|---|
| 4 | 15.48 | 33.4 | 50.1 | 100.0 | 26.77 | 1462 (91.1 %) | 114 (7.10 %) |
| 5 | 17.89 | 33.4 | 50.1 | 99.9 | 26.80 | 1419 (88.3 %) | 127 (7.90 %) |

Runs 4–5 are reproducible *with each other*, so this is host load, not
measurement noise: SwiftShader rasterises on the CPU, so a busy host slows the
renderer. Compare only runs from the same load band, and use runs 1–3 as the
baseline.

### CPU-throttle sensitivity and the mobile tier

| CPU throttle | Host load | p50 (ms) | p95 (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms |
|---|---|---|---|---|---|---|
| 1× | 12.63 | 33.3 | 33.4 | 36.96 | 1360 (61.4 %) | 5 (0.23 %) |
| 2× | 11.81 | 33.4 | 50.1 | 26.06 | 1483 (94.9 %) | 88 (5.63 %) |
| 4× (mobile tier) | 9.89 | 50.0 | 66.7 | 19.92 | 1193 (99.8 %) | 341 (28.5 %) |

**Mobile-tier baseline: 19.9 FPS at 4× throttle — below the ≥ 30 FPS mobile
target.** A 4× slowdown of the JS path would take 36.96 FPS down to ~9 FPS; it
lands at 19.9 FPS, so the throttled JS is not what sets the frame time (see the
verdict below). The three rows ran at comparable host load, but the 2× and 4×
rows are single runs — re-measure before claiming a mobile improvement.

### Electron baseline (software GPU-process rasteriser)

Measured with `--host electron` on the desktop host (AH-0MW2DB9VN006XB63):
`GymPerformance`, exactly 100 enemies with live fire,
`--seconds 60 --warmup 3 --profile`, on the reference machine below:

```bash
npm run perf:measure:electron -- --scene GymPerformance --seconds 60 --warmup 3 \
  --profile perf-output/electron.cpuprofile
```

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 15.30 | **16.7** | **16.8** | 2183.3 | 22.36 | 44.72 | 43 (1.60 %) | 43 (1.60 %) | 457 / 267.2 |
| 2 | 19.58 | **16.7** | **16.8** | 2916.6 | 22.64 | 44.18 | 44 (1.68 %) | 44 (1.68 %) | 568 / 261.9 |

**Backend, exactly as recorded in the reports** — `runtime`:
`{ kind: "electron", electronVersion: "45.2.2", chromeVersion: "156.0.8078.80" }`;
`webgl.kind`: `software`; `webgl.renderer`:

```
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
```

**Paired browser rows on the same commit and in the same load band**, for the
host comparison (the rows the browser path produces today, measured after the
cached-bullet-texture change — see
[Cached bullet textures](#cached-bullet-textures-ah-0mw2day2l004qskf)):

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|
| 1 | 19.48 | 33.3 | 66.6 | 200.0 | 36.13 | 27.68 | 1482 (89.3 %) | 332 / 203.6 |
| 2 | 19.76 | 33.3 | 50.0 | 133.4 | 33.63 | 29.73 | 1556 (87.3 %) | 321 / 202.0 |

How to read these two blocks:

- **The 60 FPS frame-time budget is met on the Electron host, on a software
  rasteriser.** p50 16.7 ms and p95 16.8 ms are the 60 Hz vsync step with no
  long-frame *rate* to speak of (1.6 %), against the browser's p50 33.3 ms /
  p95 50–67 ms at the same load. `p95 ≤ 16.7` is missed by one tenth of a
  millisecond, so this is "at the budget on this host", not a formal pass on a
  hardware GPU.
- **Only `p50`/`p95` are the verdict here.** `max` (2.2 s / 2.9 s) and the
  effective FPS (44) are dragged down by 43–44 stalls of > 50 ms taken while
  the box was at load 15–20: the Electron GPU process holds ~7.5 cores of
  SwiftShader rasterisation, so another agent's test suite can starve a frame.
  The percentiles are identical across both runs, which is the load-robust
  signal — the same rule the [noise floor](#noise-floor) states for every
  other row in this document.
- **The bullet counts are higher in the Electron runs** (peak 457/568 vs
  321/332) because the faster loop gives the enemies more firing ticks. The
  Electron rows therefore carry *more* load AND deliver a better frame time;
  the comparison does not favour the browser.
- **The two hosts use different software rasterisation paths.** Headless
  Chromium's SwiftShader runs on the renderer main thread (profile `native`
  90–91 %, `idle` 0.1 %), while the Electron host rasterises in Chromium's GPU
  process (renderer profile `idle` 49–51 %, `native` 32–34 %, with the GPU
  process itself at ~7.5 cores). That is why the same scene and the same
  *renderer string* produce different frame times, and why the profile buckets
  must not be compared across hosts.

No hardware-GPU Electron rows are published: see
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline-outstanding).

### PlayScene late game (supplementary)

`--setup '{"demo":true,"seed":1,"startLevel":10}'` starts the shipped
`PlayScene` at campaign level 10 in **demo (attract-mode) flight**, which is the
only way to reach late-game pressure in the harness — a stationary non-demo run
is destroyed before the window ends:

| Scene | Host load | p50 (ms) | p95 (ms) | max (ms) | Effective FPS | Frames > 33 ms | Enemies peak/mean | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|
| PlayScene, level 10, demo | 13.39 | 16.7 | 50.0 | 116.6 | 49.9 | 313 (10.5 %) | 1789 / 269.1 | 209 / 33.0 |

This row is **not** comparable to the gym: the demo bot kills most of the
spawned enemies (mean 269 enemies but only ~33 live bullets) and the horde
spawner is unbounded. It is recorded to show the shipped scene under real
late-game pressure, and it is the run whose profile exposes the demo-bot and
dev-telemetry hotspots.

### Where the frame time goes

CPU profiles of the runs above (share of the measured window, %):

| Run | JS | simulation | renderer | ui | audio | gc | idle | native | other |
|---|---|---|---|---|---|---|---|---|---|
| GymPerformance 1× (run 3, load 9.28) | 14.75 | 1.00 | 13.69 | 0.02 | 0.04 | 0.40 | 0.10 | 84.75 | 0.00 |
| GymPerformance 1× (run 1, load 15.48) | 14.70 | 1.16 | 13.43 | 0.03 | 0.05 | 0.44 | 0.11 | 84.77 | 0.00 |
| GymPerformance 4× (load 9.89) | 37.10 | 3.22 | 33.51 | 0.11 | 0.20 | 0.93 | 0.16 | 61.84 | 0.02 |
| PlayScene level 10 demo (load 13.39) | 9.10 | 3.75 | 5.23 | 0.04 | 0.05 | 0.39 | 11.93 | 78.60 | 0.00 |
| GymPerformance 1×, **Electron** (load 15.30) | 15.76 | 1.10 | 14.56 | 0.06 | 0.08 | 1.21 | 51.50 | 32.18 | 0.03 |
| GymPerformance 1×, **Electron** (load 19.58) | 15.80 | 1.19 | 14.53 | 0.06 | 0.08 | 1.20 | 49.39 | 34.26 | 0.03 |

Two things stand out:

- **The bucket attribution is load-robust; the frame rate is not.** The two gym
  runs at load 9.28 and 15.48 differ by 35 % in effective FPS yet attribute the
  window almost identically (JS 14.75 % vs 14.70 %, renderer 13.69 % vs
  13.43 %). Use the profile to decide *what to fix*, and a same-load-band
  frame-time pair to prove the fix.
- **Within JS, draw submission dominates.** Of the JS time, Phaser's renderer is
  92.8 % (gym 1×) and 90.4 % (gym 4×), while the game's own simulation is 6.8 %
  and 8.7 %. In the PlayScene demo run the split differs — simulation is 41.3 %
  of JS — because the attract-mode bot and the dev telemetry recorder run there.

**The Electron rows are not comparable bucket-for-bucket.** Both Electron runs
agree with each other (JS 15.76/15.80 %, renderer 14.56/14.53 %, simulation
1.10/1.19 %, `idle` ~50 %, `native` 32–34 %) and agree with the browser rows on
**JS and renderer** — the JS-side draw submission is the same code and the same
cost. They disagree on `native`/`idle` for a structural reason: this host's
Electron rasterises in the **GPU process** (multi-threaded SwiftShader, ~7.5
cores), which a renderer-side CDP profile cannot attribute, so that work shows
up as idle. Read `native` as "non-JS work *on the renderer main thread*" and
never compare it across hosts.

### Verdict: renderer-bound, not simulation-bound

The epic's premise ("assuming we are CPU bound") is **refuted for the game
loop** and **confirmed for the renderer**. Evidence, in order of strength:

1. **84.75 % of the main thread's sampled time is native** with **0.10 % idle** —
   the loop is inside draw submission / GL work, not idle and not running game
   JS, which is 14.75 % of the window.
2. **Within JS, 92.8 % is Phaser draw submission and 6.8 % is the game's own
   simulation** — the simulation is the cheap part of the JS that does run.
3. **A 4× CPU throttle costs 46 % of the frame rate (36.96 → 19.92 FPS), not
   ~75 %.** A loop limited by main-thread JS would collapse to ~9 FPS under a
   4× throttle. It does not, so main-thread JS is not the limiting resource.
4. **Cost tracks live bullets, not enemies.** The gym (100 enemies, ~200 live
   enemy bullets) sits at p50 33.3 ms; the PlayScene late-game demo (mean 269
   enemies, ~33 live bullets) sits at p50 16.7 ms. Every bullet is one
   `Graphics` object, re-batched every frame.

**Caveat that must travel with this verdict.** The measurements are taken on
**SwiftShader**, a CPU rasteriser, so "renderer-bound" here means *draw
submission and rasterisation bound*; the rasterisation half is an artefact of
the software backend and is far cheaper on a hardware GPU. The main-thread JS
share (14.75 %) is backend-independent, so *the game's simulation is not the
bottleneck* holds on any backend; *the renderer is the bottleneck* is proven for
this backend only. A hardware-GPU desktop number is not obtainable here — see
below.

### Verdict re-stated for the Electron host

The Electron baseline
([above](#electron-baseline-software-gpu-process-rasteriser)) keeps the same
verdict and changes its consequence:

1. **The simulation is still the cheap part.** Renderer JS is 14.5 % of the
   window and the game's own simulation 1.1–1.2 % — the ratio the browser runs
   show (13.7 % / 1.0 %) is reproduced on the desktop host.
2. **The renderer-bound verdict is about *draw submission*, not about a
   hopeless frame rate.** On the desktop host the same software rasteriser
   holds the 60 FPS step at 100 enemies, because the rasterisation runs in the
   GPU process across cores instead of on the renderer's main thread. The
   browser's 36 FPS floor was therefore **a property of the headless-shell
   renderer path, not of the game** — the earlier "SwiftShader floor" numbers
   must not be read as the desktop app's performance.
3. **The desktop frame-time target is met on this host with a software
   rasteriser** (p50 16.7 / p95 16.8 ms), which makes the hardware-GPU run a
   confirmation rather than a rescue: it should widen the margin, not decide
   pass/fail. The formal `p95 ≤ 16.7 ms` check and the Electron hardware-GPU
   number still belong on a GPU-capable reference machine.

## Hardware-GPU desktop baseline (outstanding)

The desktop host is now measurable and its software-rasteriser baseline is
recorded ([Electron baseline](#electron-baseline-software-gpu-process-rasteriser)).
What this host still **cannot** produce is a **hardware-GPU** run, so the
desktop 60 FPS target is not yet falsified on a real GPU:

- **This host has no usable GPU device for the browser/harness.** `/dev/dri`
  exists (`card0`, `card1`, `renderD128`, `renderD129`) but the render nodes are
  `root:render` with mode `660`, and the measuring user is not in the `render`
  or `video` group, so the process cannot open them. There is also no display
  server (`DISPLAY` unset, no Xvfb installed). Every launch mode therefore falls
  back to a software renderer —
  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`
  — including with `--gpu`, which is why `--require-hardware-webgl` exists and
  refuses the run rather than labelling a software run "desktop".
- **The desktop host runs and renders without a display** (Electron with
  `--ozone-platform=headless`, rasterising in its GPU process — verified by a
  canvas read-back, 1538 distinct colours, and a GPU process at ~7.5 cores),
  but that is still SwiftShader: it says nothing about a hardware driver.

The verification run itself is tracked by AH-0MW2IRYJ2006PV3P (filed by
AH-0MVXV6VOI006P7VG: this host cannot produce it, so it cannot be part of the
final verification's own evidence here).

**To fill the gap**, on a machine with a hardware GPU (and, for the Electron
row, a display or a GPU-capable headless setup):

```bash
# desktop browser, hardware GPU — the guard refuses a software fallback
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymPerformance \
  --seconds 60 --warmup 3 --profile perf-output/desktop-gpu.cpuprofile \
  --out perf-output/desktop-gpu.json

# Electron, hardware GPU
npm run perf:measure -- --host electron --gpu --require-hardware-webgl \
  --scene GymPerformance --seconds 60 --warmup 3 \
  --profile perf-output/electron-gpu.cpuprofile --out perf-output/electron-gpu.json
```

Record in this document, per run: the `host` block (CPU model, memory, load
average — i.e. the reference machine), `runtime` (`browser` or `electron` plus
versions), the **exact** `webgl.renderer` string, and the whole frame-time /
long-frame / counts block. Compare the GPU pair against the SwiftShader rows
above only within a matching host-load band, and re-state the
[verdict](#verdict-re-stated-for-the-electron-host) — the balance is expected to
stay simulation-cheap / draw-submission-dominated, but that is a prediction, not
a measurement, until these two runs exist. If the hardware balance does differ,
the optimisation children's priorities
([Ranked hotspots](#ranked-hotspots)) move with it; the current priorities are
derived from the SwiftShader profiles and are unchanged by this item.

## Ranked hotspots

Ranked by measured impact from the profile of the low-load desktop baseline
(run 3: `GymPerformance`, 100 enemies, 60 s, load 9.28) unless a row says
otherwise. "Share" is of the measured window, with the share of JS in brackets.
Source lines are the **TypeScript** declaration lines, resolved by function name
(the profile itself records transpiled lines).

| # | Hotspot | Source | Measured share | Lever | Work item |
|---|---|---|---|---|---|
| 1 | **One `Graphics` object per bullet**, re-batched every frame by Phaser (`GraphicsWebGLRenderer` 4.18 % [28.3 %], `batch` 2.97 % [20.1 %], Graphics pipeline `run` ×3 ≈ 2.82 % [19.2 %]) | `src/entities/bulletUtils.ts:80` (`createBullet` → `scene.add.graphics()`), `src/utils/bulletVisuals.ts:203` (`drawBulletShape`) | **≈ 10.0 % [≈ 68 % of JS]**, and it drives most of the 84.75 % `native` GL submission | **Done** — every bullet is an `Image` of its cached texture; renderer bucket −52.8 % (see [Cached bullet textures](#cached-bullet-textures-ah-0mw2day2l004qskf)) | AH-0MW2DAY2L004QSKF (high) |
| 2 | **Animated pellets redraw their `Graphics` every frame**, so earcut re-triangulates the path every frame (`earcutLinked` 0.49 %, `linkedList` 0.21 %) | `src/utils/bulletVisuals.ts:1120` (`_pellet`), redraw wired at `src/entities/bulletUtils.ts:105` | 0.70 % [4.7 %] | **Done** — the same texture cache as #1, with the pulse animated by image scale/alpha; earcut no longer appears in the profile | AH-0MW2DAY2L004QSKF |
| 3 | Bullet advancement / wrap, once per bullet per frame | `src/scenes/core/bulletLifecycle.ts:64` (`advanceWrappingBullets`), `advancePlayerBullets` | 0.09 % [0.6 %] | **Done** — player-bullet survivors are compacted in place; no per-frame survivor array (see [Per-frame allocations](#per-frame-allocations-ah-0mvxv0f0y004nent)) | AH-0MVXV0F0Y004NENT (low) |
| 4 | Enemy fire + aim-target collection | `src/entities/enemyFire.ts:111` (`fireForEnemy`), `src/scenes/core/enemyTargeting.ts:85` (`pushAimTargets`) | 0.04 % [0.2 %] | **Done** — allocation-free `collectEnemyFire` appends into the live list, aim/seek pushes share one reused snapshot buffer (see [Per-frame allocations](#per-frame-allocations-ah-0mvxv0f0y004nent)) | AH-0MVXV0F0Y004NENT (low) |
| 5 | Collision passes (`_handleCollisions`) | `src/scenes/core/CombatScene.ts:1418` | 0.02 % [0.2 %] — but the measured pass had **no player bullets** (see the caveat below) | **Done** — player bullets indexed per pass: 90 000 → **699** candidate pairs at 300 × 300 (see [Collision broad phase](#collision-broad-phase-ah-0mvxv0emf001wvq1)) | AH-0MVXV0EMF001WVQ1 (low) |
| 6 | GC / allocation pressure | V8 `(garbage collector)` | 0.40 % [2.7 %] | **Done** — the per-frame transient arrays are gone; the paired GC bucket is unchanged (see [Per-frame allocations](#per-frame-allocations-ah-0mvxv0f0y004nent)) | AH-0MVXV0F0Y004NENT (low) |
| 7 | HUD / UI refresh, player auto-defence | `src/ui/HUD.ts:405` (`refresh`), `src/scenes/core/CombatScene.ts:243` (`_updateAutoDefence`) | 0.02–0.03 % **with no loadout rows**; 9.06 % of the window (~40 % of JS) once rows are present — see [Per-frame HUD rows](#per-frame-hud-rows-ah-0mvxv0ffj0066ec8) | Redraw the rows only when the rendered state changes (done); auto-defence measured too small to matter | AH-0MVXV0FFJ0066EC8 |
| 8 | Minerals update/collect | `src/scenes/core/mineralLayer.ts:130` (`collectMinerals`), `src/scenes/gym/core/GymFormationScene.ts:1464` (`_updateMinerals`) | 0.01 % in the gym (minerals disabled); 0.06 % in the busier run | None needed | — |
| 9 | **Demo-bot steering** (attract mode only) | `src/ai/framework/competent/steering.ts:327` (`evaluateDirection`), `src/ai/framework/hazardVelocity.ts:74` (`trackHazardVelocities`) | PlayScene demo run: 0.47 % [5.2 %] — the largest single game-code function there | Evaluate less often / reuse the world snapshot | AH-0MW2DC28M00161W6 (low) |
| 10 | **Dev telemetry serialisation** (dev builds only) | `src/telemetry/redact.ts:93` (`sanitiseObject`), `src/ai/botSnapshot.ts:459` (`deepFreeze`) | PlayScene demo run: ≈ 0.7 % [≈ 7 % of JS] | Skip the serialise+redact of a payload that will be discarded for exceeding the upload cap | AH-0MW2DC20A007TAVY (low) |

What this ranking changed (parent AC6 — priorities from measurement, not
speculation):

- **GPU offload / draw-call batching (AH-0MVXV0FFJ0066EC8) → `high`.** It was
  provisioned at `medium`; the measured renderer share (92.8 % of JS, plus the
  native GL submission it drives) makes it the top lever by a wide margin.
- **Collision broad-phase (AH-0MVXV0EMF001WVQ1) → `low`, then implemented.**
  `_handleCollisions` profiled at 0.2 % of JS / 0.02 % of the window — microseconds
  at 100 enemies — so it cannot move the target. That reading has a caveat the
  profile alone does not show: `GymPerformance` disables the player's auto-fire,
  so the bullet-vs-bullet pass ran with **zero player bullets** and the sampled
  time says nothing about it (see [Collision broad
  phase](#collision-broad-phase-ah-0mvxv0emf001wvq1)). It was kept as a scaling
  fix for higher bullet counts and is now implemented; no frame-time win is
  claimed for the 100-enemy budget.
- **Per-frame allocations (AH-0MVXV0F0Y004NENT) → `low`.** GC is 2.7 % of JS /
  0.40 % of the window.
- **HUD rows (AH-0MVXV0FFJ0066EC8) → measured by ablation, not by this
  ranking.** This profile's scenario holds no power-ups, so it never rendered a
  loadout row; with a scripted loadout the per-frame row rebuild costs 9.06 % of
  the window (~40 % of JS) and is now removed — see
  [Per-frame HUD rows](#per-frame-hud-rows-ah-0mvxv0ffj0066ec8). The chrome
  around it (bubbles, escort pods, timer bar) measures inside the noise floor.
- **A new child was created for the measured #1 hotspot**
  (AH-0MW2DAY2L004QSKF) because the pre-provisioned draw-call child's scope
  (HUD, bubbles, pods, timer bar) does not cover the per-bullet Graphics cost.

### Per-frame HUD rows (AH-0MVXV0FFJ0066EC8)

The stress gym holds **no power-ups**, so the baseline profile above never
rendered a HUD loadout row and ranked `HUD.refresh` at 0.02–0.03 % of the
window (hotspot #7, "none needed"). That reading is **incomplete**: the row
list is empty in that scenario. Re-measured with a scripted combat loadout,
the per-frame row rebuild was the single largest cost in the chrome this item
owns — and it is now gone.

**What was wrong.** `HUD.refresh()` ran on every frame (via `update()`) and
destroyed and re-created every row's `Graphics` icon and `Text` objects — two
`Text` objects per row, each regenerating a canvas texture and re-uploading it
on creation. The rendered state it rebuilt from changes at most once a second
(the countdowns are whole seconds: `formatHUDValue` → `Ns`,
`buildHUDLabel` → `next in Ns`), and only on a pickup/spend during play, so
~59 frames in 60 paid the full rebuild for an identical result.

**Measurement.** `GymPowerUpsCombat` with the fixed scenario
`--setup '{"threatCount":12}'` (plain) against the same scene with a scripted
combat loadout — `--setup '{"powerUps":{"shield":1,"force_field":1,"thorns":1,"magnet":1,"bomb":1},"player":{"weapons":["options"]},"threatCount":12}'`
(armed: five HUD rows plus the Shield, Force Field and Thorn Field bubbles and
the Options escort) — 30 s window, 5 s warm-up, `--profile`, same host:

| Run | Host load | JS (% window) | `ui` bucket | `gc` bucket | FPS | p95 (ms) | Frames > 33 ms |
|---|---|---|---|---|---|---|---|
| plain, before | 5.64 | 5.05 | 0.02 | 0.18 | 58.8 | 16.8 | 36 |
| plain, after | 8.88 | 4.96 | 0.08 | 0.22 | 57.5 | 16.8 | 76 |
| armed, before | 7.14 | **9.06** | 0.13 | 0.39 | 51.3 | 33.4 | 261 |
| armed, after (run A) | 13.49 | **5.44** | 0.08 | 0.18 | 53.2 | 33.3 | 200 |
| armed, after (run B, final code) | 10.26 | **5.79** | 0.14 | 0.21 | 49.8 | 33.4 | 306 |

On this shared host the **FPS and percentile columns are noise-dominated** (these
runs were taken while other agents' suites were loading the box, and the
load-average column moves with them); the **JS attribution is the stable
signal**, exactly as the bucket table in [Where the frame time
goes](#where-the-frame-time-goes) shows. Read the fix from `JS`/`ui`/`gc` and the
per-symbol table below, not from a few FPS.

The JS attribution is the decisive part, and it is unambiguous — these
functions only appear in the profile when the HUD rows are present, and every
one of them vanishes after the change (self time, % of the measured window):

| Symbol (Phaser text path) | armed, before | armed, after |
|---|---|---|
| `texImage2D` (texture upload) | 0.99 | — |
| `save` (canvas state) | 0.49 | — |
| `preDestroy` (row teardown) | 0.47 | — |
| `updateText` | 0.39 | — |
| `MeasureText` / `measureText` | 0.27 / 0.20 | — |
| `setStyle` | 0.27 | — |
| `Text` (constructor) / `create` | 0.25 / 0.25 | — |
| `fillText` | 0.19 | — |

"—" means below the profile's top-16 cut (each < 0.15 %). The `armed` run now
sits within noise of the `plain` run on every bucket (5.44 % vs 4.96 % JS,
4.45 % vs 4.03 % renderer, `gc` 0.18 vs 0.22) **despite a load average almost
twice as high**, so the HUD rows are effectively free and the remaining chrome
the armed setup adds — the three player bubbles and the Options escort, one
`Graphics` object each, plus the wave-timer bar in `PlayScene` — is inside the
noise floor (`GraphicsWebGLRenderer` 1.05 % armed vs 1.07 % plain). That agrees
with the ranked hotspot: the measured draw-submission cost is the **per-bullet**
`Graphics` object (hotspot #1, AH-0MW2DAY2L004QSKF), not the chrome.

**What changed.** `HUD.refresh()` now resolves a *render plan* — the rows, their
indices, labels, values, greyed/marker state, the lives label and the layout
inputs — and rebuilds the row objects only when that plan's signature differs
from the one on screen. The mineral hold bar redraws only when its geometry
(fill width / visibility) changes. Both live in `src/ui/HUD.ts`, which every
combat gym and `PlayScene` consume, so the win is shared by construction
(gym↔game parity). The countdown rows still advance exactly on the second they
always did; the tests in `src/ui/HUD.refreshCadence.test.ts` pin both halves —
stable objects while the state is stable, a rebuild on every visible change.

**Not done, deliberately.** The bubbles, the Options escort and the wave-timer
bar are still clear-and-redraw `Graphics`: each is one object whose geometry
either moves every frame (the orbiting pods, the depleting timer fill) or is
cheaper to redraw than to diff, and the measurement above puts the whole set
inside the noise floor. Converting them to cached textures would trade a
measurable-zero draw cost for a visual-parity risk, so it is not part of this
change; if a future profile makes them material, the same ablation method
(plain vs armed setup, compare `topFunctions`) is how to show it.

**No regression at the target load.** A 60 s `GymPerformance` re-run of the
same change (100 enemies, 326 enemy-bullet peak) at host load 15.71 reproduced
the documented **high-load** baseline rows 4–5 exactly — 26.81 FPS vs
26.77 / 26.80, p50 33.4 ms, p95 50.0 ms vs 50.1 ms — as the host-load
sensitivity table predicts for that band. The stress gym holds no power-ups, so
it renders no HUD rows and the change is not expected to move its numbers; the
run confirms it does not.

### Cached bullet textures (AH-0MW2DAY2L004QSKF)

Ranked hotspots **#1 and #2** were the same root cause: every projectile was
its own `Phaser.GameObjects.Graphics` object, re-triangulated (earcut) and
re-batched through the Graphics pipeline every frame. The fix bakes each
bullet *silhouette* (shape + colour + rim + tail) **once per visual spec** into
a cached Phaser canvas texture and renders each bullet as one plain
`Image` of it (`src/utils/bulletTextures.ts`, consumed by
`src/entities/bulletUtils.ts` and `src/entities/PlayerBullet.ts`). The bake
draws through the **same** `drawBulletShape` seam the game and every gym
already used, so the silhouette is identical by construction and only *when*
it is drawn changed (once, at bake time). Time-driven parts are baked at
`time = 0` — the mean phase of every animated part — and the shapes whose
motion reads as a pulse/breathe/shimmer (the pellet's pulse ring, the heavy
shell's breathing glow, the shard's glint) are animated with **image
scale/alpha** from the bullet's own age, so no per-frame `drawBulletShape`
redraw survives (AC2). The Boss pulse wave (a slowly expanding ring) became a
sprite of the cached `ring` texture grown by scale and faded by alpha.
Gameplay, collision, RNG and `tick(dt)` determinism are untouched.

**What the profile says (profiled pair, 60 s, same host, ~load 14).** The
bullet draw submission is gone; the *frame time* is not, because this backend
rasterises on the CPU:

| Bucket / symbol (share of the measured window) | Before | After | Change |
|---|---|---|---|
| `renderer` bucket | 14.77 % | **6.97 %** | **−52.8 %** |
| main-thread JS | 16.24 % | **8.09 %** | **−50.2 %** |
| `GraphicsWebGLRenderer` (hotspot #1) | 4.45 % | 1.40 % | −68.5 % |
| `batch` (hotspot #1) | 3.02 % | 1.09 % | −63.9 % |
| Graphics pipeline `run` (three hottest) | 3.22 % | 1.26 % | −60.9 % |
| `earcutLinked` (hotspot #2 — per-frame re-triangulation) | 0.64 % | below top-16 | gone |
| `native` `(program)` bucket | 83.16 % | 91.55 % | **+8.4 pp** |

The renderer-side JS the item targeted halved and the two ranked hotspots
dropped out of the profile — the freed main-thread time went straight into the
software rasteriser, which is why the frame time did not move. **This is the
backend caveat the baseline already records**: every launch mode on this host
reports SwiftShader, and SwiftShader rasterises on the CPU, so
*"the renderer is the bottleneck"* is proven for this backend only while
*"the game's simulation is not the bottleneck"* is backend-independent. Draw
submission is JS on the main thread, so the halved JS cost is the half that a
hardware GPU does not absorb.

**Frame time (paired before/after, 60 s `GymPerformance`, SwiftShader).** Both
halves sit at the 30 FPS vsync step, so p50 is quantised and cannot show the
halved JS:

| Run | Host load | p50 (ms) | p95 (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|
| before, run A | 13.92 | 33.3 | 49.9 | 29.76 | 33.60 | 72.6 % | 319 / 192.0 |
| after, run A | 14.95 | 33.3 | 50.0 | 31.07 | 32.18 | 77.0 % | 347 / 215.2 |
| after, run B | 14.01 | 33.3 | 50.0 | 32.85 | 30.44 | 82.0 % | 333 / 216.9 |
| before, run B | 10.64 | 33.3 | 50.0 | 31.64 | 31.61 | 80.3 % | 326 / 216.3 |

Both before and after runs land inside the same spread as the documented
run-to-run noise for this load band — **no p50/p95 frame-time change is
measurable on this backend**, and none is claimed. The mobile-tier check
agrees: at `--cpu-throttle 4` the after run reports p50 50.0 ms / p95 68.4 ms /
20.0 FPS vs the recorded 4× baseline **50.0 ms / 66.7 ms / 19.9 FPS**.

**Verdict.** The measured #1/#2 hotspots are removed (renderer JS −52.8 %, the
two hotspot symbols −64 % to −69 %, earcut gone) for no gameplay change and no
frame-time regression. The item's frame-time target (p50/p95 ≥ 20 % better)
**is not demonstrable on the SwiftShader floor** — that requires the
hardware-GPU desktop run already tracked by AH-0MW2DB9VN006XB63, which
re-states every optimisation's verdict for real GPUs.

### Collision broad phase (AH-0MVXV0EMF001WVQ1)

Ranked hotspot **#5** was the shared `_handleCollisions` pass: player bullets
were compared with **every** live enemy bullet, every frame. It profiled at
0.02 % of the measured window / 0.2 % of JS, which is why the item was
re-ranked to `low` — but that number has a caveat.

**The baseline never exercised the pass.** The stress gym sets
`autoFireEnabled()` to `false` so the 100-enemy load cannot be shot down
during a measurement (see [the stress gym](#the-stress-gym-gymperformance)),
which means the player has **no bullets** for the whole 60 s window. The
bullet-vs-bullet pass therefore compared nothing at all, and its sampled time
is not evidence that the pass is cheap — it is evidence that the scenario
never ran it. The pass is quadratic in the live bullet count, and the game
*does* fire: the shipped auto-fire plus the Options escort keeps a steady
stream of player bullets in flight while enemy bullets peak in the hundreds.

**What changed.** `_handleCollisions` now indexes the player bullets once per
pass in the shared uniform-grid broad phase
(`src/utils/spatialHash.ts`) and queries it per enemy bullet with the same
radius its narrow-phase test uses, so only bullets in neighbouring cells are
candidates. The grid only ever *removes impossible pairs*: candidates come
back in ascending bullet order and are re-tested with the same `_overlaps`
predicate, which reproduces the nested loop's first-hit selection, destruction
order and hook order exactly.

**Measured candidate-pair collapse.** Both columns are measured through the
production pass (`getCollisionBroadPhaseStats()`), not asserted from a formula:
a degenerate single-cell grid *is* the nested loop, and the test runs the same
fixture through both (`src/scenes/core/CombatScene.broadPhase.test.ts`).

| Fixture | All-pairs tests | Broad-phase candidate tests | Reduction |
|---|---|---|---|
| 300 player bullets × 300 enemy bullets, uniform over the play area (seeded) | 90 000 | **699** | **128.8×** |
| Same fixture with the grid degenerated to one cell (the pre-change nested loop) | 90 000 | 90 000 | 1× (baseline) |

**Not claimed: a frame-time win at the budget load.** At 100 enemies the player
fires a handful of bullets, so the pass was already microseconds and the
SwiftShader baseline cannot resolve the difference — the same conclusion the
[cached bullet textures](#cached-bullet-textures-ah-0mw2day2l004qskf) section
recorded. The win is structural: the pass is no longer `n × m`, so a later
scenario that pushes live bullets far above ~350 (the re-rank trigger) pays a
linear, not quadratic, cost.

**What was deliberately left alone.** The other collision passes are scans, and
stay scans:

- **Player bullets vs enemies** re-reads `getEnemyEntities()` for *every*
  bullet, and that live snapshot is part of its contract — a kill can spawn
  entities synchronously (an asteroid splits into children) and a later bullet
  in the same pass may legitimately hit one. A per-pass index would change that
  same-frame visibility, so broadening it would change behaviour, not just
  cost.
- **Enemy bullets vs player** and **player body vs enemies** are already
  linear: one player body and one player bullet list owner, so a single scan is
  the lower bound and an index would cost more to build than it saves.

**No behaviour change.** The collision fixtures in
`CombatScene.broadPhase.test.ts` cover bullet-vs-bullet (including two bullets
at one point, which is where candidate ordering matters), bullet-vs-player,
body-vs-body, Force Field reflect, AOE detonation and splitting projectiles;
each is run through the shipped grid and through the degenerate grid and must
produce the identical outcome. The existing parity and equivalence suites are
unchanged and green.

### Per-frame allocations (AH-0MVXV0F0Y004NENT)

Ranked hotspots **#3, #4 and #6** were one root cause: the per-frame path
allocated transient arrays even on a frame where nothing changed. At 100
enemies that is thousands of short-lived objects per second, and the GC bucket
was 0.40 % of the window / 2.7 % of JS — small, which is why the item was
re-ranked to `low`, and why its AC allows closing on evidence that the
allocations are not material.

**What was allocating (and what replaced it).** Every entry is a reused,
scene-owned or pass-owned buffer, refilled in place — never a fresh array:

| Per-frame allocation | Where | Now |
|---|---|---|
| `this.spawned.filter(...).map(...)` for the aim push | `PlayScene._collectEnemyFire` | one reused live-enemy snapshot buffer, shared with the seek push |
| `this.spawned.filter(...).map(...)` for the seek push | `PlayScene._moveEnemies` | the same reused snapshot buffer |
| `push(...fireForEnemy(...))` — a transient array per firing enemy | `PlayScene._collectEnemyFire` | `collectEnemyFire()` appends straight into the live bullet list |
| `this.spawned.map(s => s.entity)` on every collision pass | `PlayScene.getEnemyEntities`, `GymLevel.getEnemyEntities` | one cached snapshot list, refilled per call |
| fresh `keptEnemy` / `keptEnemy2` survivor arrays | `CombatScene._handleCollisions` passes 2 and 3 | recycled survivor buffers (the released list becomes the next frame's buffer) |
| a filtered copy of the player-bullet list | `CombatScene._resolvePlayerBulletsVsEnemies`, and the consumed-bullet filter in pass 2 | stable in-place compaction into the live list |
| `filter().map()` candidate wrappers for the Diver re-anchor | `PlayScene._applyFormationReanchor` | a pooled candidate array refilled per frame |
| `const positioned: WrapAwareBody[] = []` | `PlayScene._moveEnemies` | one reused positioned-body buffer |
| a fresh survivor array per frame | `bulletLifecycle.advancePlayerBullets` | in-place compaction, same array returned |
| a fresh `collisionStats` object per pass | `CombatScene._handleCollisions` | updated in place |

**Ordering is unchanged.** Every replacement is a stable pass: survivors keep
their original relative order, so collision resolution order, first-hit
selection, hook order and the RNG sequence are identical to the filtered copies
this replaces. The recycled collision buffers are pinned by
`src/scenes/core/CombatScene.recycledBuffers.test.ts` (buffer identity across
frames, survivor order, and no stale survivors resurfacing from a recycled
tail); the `PlayScene` buffers are pinned in `PlayScene.test.ts` (reused
snapshot/bullet/positioned buffers, and the aim/seek pushes receiving them);
`bulletLifecycle.test.ts` and `enemyFire.test.ts` cover the two helpers.

**Measured: the GC bucket does not move, and that is the honest result.** Two
paired 60 s `GymPerformance` runs on the same host, same scene and same load
(`--profile`, SwiftShader, 100 enemies, enemy-bullet peak 323 in both) — one at
the parent commit `dev` (the "before") and one with this change:

| Run | Host load | p50 (ms) | p95 (ms) | Effective FPS | Frames > 33 ms | JS (% window) | simulation | renderer | `gc` |
|---|---|---|---|---|---|---|---|---|---|
| before (`dev`, 40f6dce4) | 11.05 | 33.3 | 33.4 | 36.90 | 61.6 % | 7.81 | 0.94 | 6.79 | **0.21** |
| after (this change) | 10.98 | 33.3 | 33.4 | 34.84 | 66.0 % | 7.59 | 0.88 | 6.63 | **0.21** |

The GC bucket is identical to the resolution of the profile (0.21 % of the
window ≈ 128 ms of a 60 s run), the JS/simulation/renderer buckets move by
0.06–0.22 pp, and p50/p95 are unchanged — the effective-FPS difference (36.9 vs
34.8) is inside the run-to-run noise this document already documents for this
load band. So: **the allocations are removed and the frame time is not
measurably affected, which is what the baseline predicted** — the loop is
draw-submission bound (92 % `native`, 6.6 % renderer JS) and per-frame garbage
was never the limiting resource at this load. The value is structural: the hot
loop no longer grows a garbage pile in proportion to enemy and bullet count, so
a later change that makes GC spikes visible in p95/max has no avoidable
transient arrays to collect. No frame-time win is claimed.

**Gym↔game parity.** The shared helpers keep their signatures
(`pushAimTargets`, `pushSeekTargets`, `advanceWrappingBullets`,
`advancePlayerBullets`) — only their inputs and their internals changed — and
`collectEnemyFire` is the same dispatch body `fireForEnemy` now wraps, so a gym
that still consumes `fireForEnemy` runs the identical dispatch and produces the
identical bullets. The formation gyms' per-frame collection is a
`collectBullets(entity, now): TBullet[]` config seam, so they keep the
allocating form; that is a difference in the seam's shape, not a second
implementation of the rule.

## Final target verification (AH-0MVXV6VOI006P7VG)

This is the outcome check the whole epic exists for: the finished tree measured
end to end — desktop browser, Electron and the mobile tier — with the per-child
wins attributed, the parity suites green and determinism proven by a seeded bot
run. It was measured on **commit `d2878b60`** (2026-11-04), the tip of the
optimisation tree after children 1–6, the bullet-texture cache change and the
desktop/Electron host work.

```bash
npm run perf:measure -- --scene GymPerformance --seconds 60 --warmup 3 \
  --profile perf-output/final-browser.cpuprofile --out perf-output/final-browser.json
npm run perf:measure -- --host electron --scene GymPerformance --seconds 60 --warmup 3 \
  --profile perf-output/final-electron.cpuprofile --out perf-output/final-electron.json
npm run perf:measure -- --scene GymPerformance --seconds 60 --warmup 3 --cpu-throttle 4 \
  --profile perf-output/final-mobile.cpuprofile --out perf-output/final-mobile.json
```

All three are `GymPerformance` — exactly 100 enemies with live fire, minerals
disabled, player auto-fire disabled — on the reference machine below. Every row
was produced by the same harness, `method`, scene, warm-up and window as the
recorded baseline; only the host load band differs, and it is recorded per row.
The mobile-tier row was measured on the same **browser** host, not Electron:
`--cpu-throttle` only slows the renderer process, so under `--host electron` it
would not represent the mobile tier (see [The desktop host](#the-desktop-host-electron)).

### Final numbers (100 enemies, 60 s)

| Host | CPU throttle | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|---|
| Desktop browser (Chromium 140.0.7339.186, SwiftShader) | 1× | 9.54 | 33.3 | 33.4 | 100.0 | 27.01 | **37.03** | 1342 (60.4 %) | 8 (0.36 %) | 337 / 207.5 |
| Desktop Electron (45.2.2, Chromium 156.0.8078.80, software GPU process) | 1× | 12.58 | **16.7** | **16.8** | 1850.0 | 18.26 | **54.76** | 23 (0.70 %) | 20 (0.61 %) | 432 / 216.1 |
| Mobile tier (headless Chromium, 4× throttle) | 4× | 11.96 | 33.4 | 50.1 | 150.1 | 41.30 | **24.21** | 1445 (99.4 %) | 122 (8.4 %) | 350 / 213.7 |

CPU attribution over the same windows (share of the measured window, %):

| Host | JS | simulation | renderer | ui | audio | gc | idle | native |
|---|---|---|---|---|---|---|---|---|
| Desktop browser 1× | **8.13** | 1.12 | **6.90** | 0.07 | 0.04 | 0.25 | 0.09 | **91.53** |
| Desktop Electron 1× | 15.35 | 1.21 | 14.06 | 0.04 | 0.04 | 0.69 | 68.60 | 15.37 |
| Mobile tier 4× | 22.23 | 3.03 | **18.87** | 0.14 | 0.17 | 0.59 | 0.26 | 76.92 |

**Reproducibility against the recorded baseline.** The browser row reproduces
the baseline band (`36.27–36.96` FPS at load 9–13) and the post-bullet-texture
attribution almost exactly (JS 8.13 vs 8.09, renderer 6.90 vs 6.97, `native`
91.53 vs 91.55) at the same load band, so the tree is measured, not re-labelled.
The Electron `p50`/`p95` are identical to the recorded Electron rows
(16.7 / 16.8); its effective FPS is higher (54.76 vs 44.2–44.7) because those
rows were taken at load 15.3–19.6 — the per-row load band is the controlling
variable, exactly as the [noise floor](#noise-floor) states. The mobile row is a
single run against a single baseline run and is read directionally, not as a
noise-floor-certified delta.

### Per-child attribution, next to the final numbers

| Work item | What it changed | Measured before → after (same harness/host) | Frame-time claim |
|---|---|---|---|
| AH-0MVXV0FFJ0066EC8 | HUD rows rebuilt only when the rendered state changes | armed `GymPowerUpsCombat` JS **9.06 % → 5.44–5.79 %**; row symbols (`texImage2D`, `save`, `preDestroy`, `updateText`, …) gone from the profile | None at the 100-enemy budget — the stress gym renders no rows |
| AH-0MW2DAY2L004QSKF | Bullet silhouettes baked once into cached textures (Image draws) | `renderer` bucket **14.77 % → 6.97 %**, main-thread JS **16.24 % → 8.09 %**, `GraphicsWebGLRenderer` −68.5 %, `batch` −63.9 %, earcut gone | None on SwiftShader — the freed JS time moved into `native` rasterisation; that half is absorbed by a real GPU |
| AH-0MVXV0EMF001WVQ1 | Player bullets indexed in the shared uniform-grid broad phase | bullet-vs-bullet candidates **90 000 → 699** at 300 × 300 (128.8×) | None at the budget load — the pass was microseconds with no player bullets; structural at higher bullet counts |
| AH-0MVXV0F0Y004NENT | Per-frame transient arrays replaced by reused buffers | GC bucket **0.21 % → 0.21 %**; JS/simulation/renderer within 0.22 pp | None measurable — GC was never the limiting resource at this load; structural |
| AH-0MW2DB9VN006XB63 | Electron desktop host + software-rasteriser baseline | browser p50 33.3 ms → **Electron p50 16.7 ms** on the same commit and rasteriser | The desktop vsync step, on the desktop host |
| **AH-0MVXV6VOI006P7VG** (this) | Final measurement, parity and determinism evidence | **aggregate** of the two JS wins: baseline JS 14.75 % / renderer 13.69 % → **JS 8.13 % / renderer 6.90 %**; mobile 4× **19.92 → 24.21 FPS**; Electron holds **p50 16.7 / p95 16.8** | Structural wins confirmed; see the verdicts below |

Two structural suspects were measured and closed as **not material** rather than
"optimised": the collision pass (0.02 % of the window with no player bullets)
and per-frame allocations (0.21 % GC). Both changes are kept for scaling and
for a garbage-free hot loop, and neither claims a frame-time win.

### Verdicts

1. **Desktop browser — not a pass on this host, and not a verdict on the game.**
   37.03 FPS with 91.53 % of the window in `native`: the frame time is set by
   **SwiftShader rasterising on the renderer main thread**, which is a property
   of this GPU-less host (see [Hardware-GPU desktop
   baseline](#hardware-gpu-desktop-baseline-outstanding)), not of the
   simulation, which is 1.12 % of the window. The formal desktop pass needs the
   hardware-GPU run tracked by **AH-0MW2IRYJ2006PV3P**.
2. **Desktop Electron — at the 60 FPS step, one tenth of a millisecond short of
   the formal bar.** p50 16.7 ms / p95 16.8 ms is the vsync step at 100 enemies
   with live fire, 0.70 % of frames > 33 ms (no sustained long-frame spike); the
   effective 54.76 FPS is dragged down by 20 isolated stalls > 50 ms on a host
   at load 12.58. `p95 ≤ 16.7 ms` is missed by 0.1 ms, so this is recorded as
   *at the budget on a software rasteriser*, not as a formal pass. The
   hardware-GPU Electron run (AH-0MW2IRYJ2006PV3P) is the confirmation that
   turns it into one.
3. **Mobile tier — target missed.** 24.21 FPS against the ≥ 30 FPS bar at a
   fixed 4× throttle. It is a real improvement over the recorded 19.92 FPS
   baseline (+21.5 %; the 4× `renderer` bucket fell from 33.51 % to 18.87 % of
   the window), but it is not the target.
   The remaining cost is draw submission (`renderer` 18.87 % of the window,
   84.91 % of JS) on top of software rasterisation (`native` 76.92 %).
   Escalated as **AH-0MW2IRYAH0055WCN** with the measured hotspot shares, and
   the parent (AH-0MVWJQUN6009IS87) is left short of `in_review`.

### Parity and determinism evidence

- **Parity.** The optimisations landed in the shared core
  (`src/scenes/core/`) and shared helpers, so gyms and `PlayScene` run the same
  code. The shared-core equivalence suite
  (`src/scenes/core/CombatScene.equivalence.test.ts`), the gym-parity docs guard
  (`src/scenes/core/gymParityDocs.test.ts`) and the parity suites
  (`captureBeam.parity`, `choicePool.parity`, `consumableChargeParity`,
  `powerUpLeveling.parity`, `mineralLayer.equivalence`) all run in the full
  project suite, which the dev-push gate enforces on every push.
- **Determinism.** The seeded bot run is the same before and after the
  optimisation tree — not merely stable run to run:

  ```bash
  node scripts/evaluate.mjs --seeds 3 --ticks 1800 --json --out <dir>
  ```

  Run on the pre-optimisation commit **`a17a953b`** and on the finished tree
  **`d2878b60`**, with fixed policy `competent`, `dt = 1/60` and seeds 1–3, the
  artefacts are **identical**: `report.json` is equal field for field and
  `runs.jsonl` is byte-for-byte identical (5464 records, 1815–1827 per seed).
  The per-seed outcome hashes match exactly:

  | Seed | Outcome hash | Score | Enemies destroyed | Survival | Minerals | Power-ups |
  |---|---|---|---|---|---|---|
  | 1 | `e124cb60` | 31.3 | 5 | 30 s | 4 | 0 |
  | 2 | `6f5f6865` | 44.3 | 6 | 30 s | 6 | 1 |
  | 3 | `85729723` | 22.3 | 1 | 30 s | 4 | 0 |

  `tick(dt)` order, RNG consumption and collision resolution are therefore
  unchanged by the optimisation tree, which is parent AC7's requirement.

### Escalation (parent AC6)

Both missed targets are escalated rather than hidden, ranked by measured impact:

- **AH-0MW2IRYAH0055WCN** — mobile-tier shortfall: cut the remaining Phaser
  draw-submission cost at 4× throttle. Evidence: `renderer` 18.87 % of the
  window (84.91 % of JS), `GraphicsWebGLRenderer` 3.78 %, `batch` 2.70 %,
  Graphics pipeline `run` ×5 ≈ 4.1 %, `ContainerWebGLRenderer` 1.20 %.
- **AH-0MW2IRYJ2006PV3P** — hardware-GPU desktop verification runs (browser and
  Electron). Evidence: Electron p50 16.7 / p95 16.8 ms on a software rasteriser;
  browser 91.53 % `native`. This host cannot produce a hardware-GPU row at all.

## Reference machine

Record the host with every published baseline. The numbers in this document
were captured on:

| | |
|---|---|
| CPU | AMD Ryzen 7 4800H with Radeon Graphics (16 logical CPUs) |
| Memory | 30 GB |
| OS | Linux 7.0.0-38-generic (x86_64) |
| Browser | Playwright 1.55.1 Chromium, **headless** with software WebGL via `--enable-unsafe-swiftshader` |
| Desktop host (Electron) | electron 45.2.2 (Chromium 156.0.8078.80), `--ozone-platform=headless`, software WebGL, GPU-process rasterisation |
| WebGL renderer | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` — recorded in every report under `webgl` |
| GPU access | `/dev/dri` render nodes are `root:render` mode `660`; the measuring user is not in the `render`/`video` group, so no hardware GPU is reachable |
| Node | v22.22.1 |

**Read the browser line carefully.** On this host both hosts run with a software
WebGL backend, which is *reproducible* but is not the hardware raster path. The
browser baseline in this document is therefore the **headless-shell SwiftShader
floor** — use it to compare runs of the *same* harness on the *same* host, and
do not read it as the desktop budget being missed on real hardware. The
Electron rows in
[Electron baseline](#electron-baseline-software-gpu-process-rasteriser) are the
desktop host on the same backend, and they show the budget being met there. A
hardware-GPU run on both hosts is still missing; see
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline-outstanding).

## Noise floor

Two consecutive runs of the same scene and commit define what "no change" looks
like. On this host the **percentiles are stable and the tail is not**, and the
*load band* decides the absolute numbers:

| Metric | Run 1 (load 8.97) | Run 2 (load 12.63) | Delta |
|---|---|---|---|
| p50 frame time | 33.3 ms | 33.3 ms | 0.0 % |
| p95 frame time | 33.4 ms | 33.4 ms | 0.0 % |
| max frame time | 66.7 ms | 66.7 ms | 0.0 % |
| effective FPS | 36.27 | 36.96 | +1.9 % |
| long frames (> 33 ms) | 1356 (62.3 %) | 1360 (61.4 %) | +0.3 % |
| enemy bullets (peak/mean) | 323 / 203.9 | 328 / 210.4 | — |

What this tells us:

- **Percentiles are the verdict, the tail is a hitch indicator.** p50 and p95
  matched exactly across the three baseline runs; `max` moved by ~50 % between
  load bands (66.7 ms at load ~9 vs 100 ms at load ~16) because a single frame
  can always be delayed by the OS, GC or another process. Judge an optimisation
  on **p50/p95 and effective FPS**, and treat `max` as needing several runs
  before it means anything.
- **The host load is part of the measurement.** Runs 4–5 (load 15.5/17.9) were
  reproducible *with each other* at 26.8 FPS while runs 1–3 (load ~9–13) were
  reproducible *with each other* at ~36 FPS. A "win" measured at load 9 against
  a baseline at load 16 is not a win. Re-run a suspicious comparison on a
  quieter host, and compare only within one load band.
- **The profile is the load-robust signal.** The bucket attribution barely moved
  between load bands (JS 14.70 % vs 14.75 %), so profile-based hotspot decisions
  survive a busy host even when frame times do not.

## Comparing two runs

Write a baseline report, then let the harness diff the next run:

```bash
npm run perf:measure -- --seconds 60 --out perf-before.json
# ... land the optimisation ...
npm run perf:measure -- --seconds 60 --out perf-after.json --compare perf-before.json
```

`--compare` prints a table of deltas for p50, p95, max, effective FPS and the
long-frame count, plus a verdict on the **20 % p95 noise floor**:

- **p95 within ±20 %** — the change is inside the documented run-to-run noise;
  do not claim a performance change on it. Re-run, or measure a heavier scene.
- **p95 beyond ±20 %** — outside the noise floor, so it is worth investigating
  (and worth re-confirming with a second run).

The comparison is also embedded in the JSON under `comparison`, so a CI job can
read `comparison.p95Within20Percent` and `comparison.p95DeltaPercent` directly.
Compare only reports with the same `scene`, `cpuThrottle`, `seconds` and
`method` — the harness prints the header fields so a mismatch is visible.

## Tests and coverage

The percentile, long-frame, FPS-derivation, count-summary, report-header,
WebGL-backend and comparison maths live in `scripts/perf-report.mjs` and are
unit-tested in `scripts/perf-report.test.ts` (no browser), together with the
backend classifier and the `--require-hardware-webgl` guard
(`classifyWebglBackend`, `hardwareBackendProblem`) and the `--host`/`--gpu`
argument surface. The launch configuration for both hosts — renderer switches
(software vs GPU must be mutually exclusive), the headless/Electron switches and
the runtime label — lives in `scripts/perf-launch.mjs` and is unit-tested in
`scripts/perf-launch.test.ts` (no browser, no Electron app). The CPU-profile
attribution — buckets, self-time ranking, project-only hotspots, the JS/idle
shares and the malformed-profile guards — lives in `scripts/perf-profile.mjs`
and is unit-tested against hand-built CDP profiles in
`scripts/perf-profile.test.ts` (no browser, no CDP session). The page-side
probe's sampling contract is tested against a fake Phaser game in
`src/core/perfProbe.test.ts`. The Playwright boot paths (Chromium and Electron,
including the "the Electron window must be visible or the loop is throttled to
1 Hz" guard) are not unit-tested — the same trade-off as
`scripts/capture-gameplay.mjs` — and are verified by running the harness; the
Electron rows in this document are that verification.

The collision broad phase is covered without a browser: the grid's contract
(superset of in-radius entries, ascending index order, no duplicate indices,
injective cell keys, the degenerate single-cell shape) is unit-tested in
`src/utils/spatialHash.test.ts`, and the equivalence/cost tests in
`src/scenes/core/CombatScene.broadPhase.test.ts` drive the real shared pass
through both grids on collision fixtures and read the candidate counts from
`getCollisionBroadPhaseStats()`.

The per-frame allocation removals are covered the same way: the recycled
collision buffers by `src/scenes/core/CombatScene.recycledBuffers.test.ts`
(buffer identity across frames, survivor order, no stale recycled tail), the
`PlayScene` hot-loop buffers by the allocation-removal suite in
`src/scenes/PlayScene.test.ts`, and the two shared helpers by
`src/scenes/core/bulletLifecycle.test.ts` and `src/entities/enemyFire.test.ts`
(the allocation-free `collectEnemyFire` entry point, including its equivalence
with `fireForEnemy` across every mapped archetype).
