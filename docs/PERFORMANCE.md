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
[Ranked hotspots](#ranked-hotspots) (AH-0MVXV0E8000937U5). The Electron and
hardware-GPU desktop numbers are **not recorded yet** — see
[What is not measurable here](#what-is-not-measurable-here-electron-and-a-hardware-gpu-desktop).

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
Those are the reproducible floor on this host, not a verdict on hardware: the
desktop GPU and Electron numbers are still missing
([why](#what-is-not-measurable-here-electron-and-a-hardware-gpu-desktop)).

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
| `method` | How frame times were sampled — `phaser-game-loop/poststep-frame-delta` (see [Measurement method](#measurement-method)). |
| `startedAt`, `host` | When and where the run happened (see [reference machine](#reference-machine)). |
| `webgl` | The WebGL backend the page actually used (`vendor`/`renderer`/`version`). Headless Chromium falls back to SwiftShader, so a run can never be mistaken for a hardware-GPU run on a label alone. |
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

## What is not measurable here (Electron and a hardware-GPU desktop)

The budget is stated for "desktop browser and Electron", but this repository and
host can only measure the software-rendered browser:

- **No Electron (or Tauri) packaging exists in this repository.** There is no
  `electron`/`tauri` dependency in `package.json` and no packaging config; the
  GDD lists Electron as an alternative and packaging as a known risk. There is
  nothing to launch, so no Electron numbers are recorded.
- **Headless Chromium cannot reach the GPU on this host.** Every launch mode
  (default, `--use-gl=angle --use-angle=gl`, `--use-gl=egl`) reports
  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader
  driver)` from `WEBGL_debug_renderer_info`, and there is no display server
  (`DISPLAY` unset, no Xvfb installed).

Consequence: the desktop baseline above is the **SwiftShader floor** — a
reproducible, pessimistic number for comparing runs of this harness on this
host, not a statement that the desktop 60 FPS budget is missed on real
hardware. Recording the hardware-GPU desktop and Electron baselines, and
re-stating the verdict for them, is tracked by
AH-0MW2DB9VN006XB63 (child of the epic).

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
| 3 | Bullet advancement / wrap, once per bullet per frame | `src/scenes/core/bulletLifecycle.ts:64` (`advanceWrappingBullets`) | 0.09 % [0.6 %] | Fold into the bullet rework (a batched position update) | AH-0MVXV0F0Y004NENT (low) |
| 4 | Enemy fire + aim-target collection | `src/entities/enemyFire.ts:111` (`fireForEnemy`), `src/scenes/core/enemyTargeting.ts:85` (`pushAimTargets`) | 0.04 % [0.2 %] | Allocation removal only | AH-0MVXV0F0Y004NENT (low) |
| 5 | Collision passes (`_handleCollisions`) | `src/scenes/core/CombatScene.ts:1310` | 0.02 % [0.2 %] | Broad-phase — **measured too small to matter at this load** | AH-0MVXV0EMF001WVQ1 (low) |
| 6 | GC / allocation pressure | V8 `(garbage collector)` | 0.40 % [2.7 %] | Allocation removal | AH-0MVXV0F0Y004NENT (low) |
| 7 | HUD / UI refresh, player auto-defence | `src/ui/HUD.ts:405` (`refresh`), `src/scenes/core/CombatScene.ts:243` (`_updateAutoDefence`) | 0.02–0.03 % **with no loadout rows**; 9.06 % of the window (~40 % of JS) once rows are present — see [Per-frame HUD rows](#per-frame-hud-rows-ah-0mvxv0ffj0066ec8) | Redraw the rows only when the rendered state changes (done); auto-defence measured too small to matter | AH-0MVXV0FFJ0066EC8 |
| 8 | Minerals update/collect | `src/scenes/core/mineralLayer.ts:130` (`collectMinerals`), `src/scenes/gym/core/GymFormationScene.ts:1464` (`_updateMinerals`) | 0.01 % in the gym (minerals disabled); 0.06 % in the busier run | None needed | — |
| 9 | **Demo-bot steering** (attract mode only) | `src/ai/framework/competent/steering.ts:327` (`evaluateDirection`), `src/ai/framework/hazardVelocity.ts:74` (`trackHazardVelocities`) | PlayScene demo run: 0.47 % [5.2 %] — the largest single game-code function there | Evaluate less often / reuse the world snapshot | AH-0MW2DC28M00161W6 (low) |
| 10 | **Dev telemetry serialisation** (dev builds only) | `src/telemetry/redact.ts:93` (`sanitiseObject`), `src/ai/botSnapshot.ts:459` (`deepFreeze`) | PlayScene demo run: ≈ 0.7 % [≈ 7 % of JS] | Skip the serialise+redact of a payload that will be discarded for exceeding the upload cap | AH-0MW2DC20A007TAVY (low) |

What this ranking changed (parent AC6 — priorities from measurement, not
speculation):

- **GPU offload / draw-call batching (AH-0MVXV0FFJ0066EC8) → `high`.** It was
  provisioned at `medium`; the measured renderer share (92.8 % of JS, plus the
  native GL submission it drives) makes it the top lever by a wide margin.
- **Collision broad-phase (AH-0MVXV0EMF001WVQ1) → `low`.** `_handleCollisions`
  is 0.2 % of JS / 0.02 % of the window — an O(n·m) pass that costs
  microseconds at 100 enemies. It stays worth doing as a scaling fix for higher
  bullet counts, not as a lever on the target.
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

## Reference machine

Record the host with every published baseline. The numbers in this document
were captured on:

| | |
|---|---|
| CPU | AMD Ryzen 7 4800H with Radeon Graphics (16 logical CPUs) |
| Memory | 30 GB |
| OS | Linux 7.0.0-38-generic (x86_64) |
| Browser | Playwright 1.55.1 Chromium, **headless** with software WebGL via `--enable-unsafe-swiftshader` |
| WebGL renderer | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` — recorded in every report under `webgl` |
| Node | v22.22.1 |

**Read the browser line carefully.** The harness runs headless with a software
WebGL backend, which is a *reproducible* but pessimistic renderer: it measures
the game loop honestly but not the desktop GPU raster path. The baseline in
this document is therefore the SwiftShader floor — use it to compare runs of the
*same* harness on the *same* host, and do not read it as the desktop budget
being missed on real hardware. The desktop GPU and Electron numbers are still
missing; see
[What is not measurable here](#what-is-not-measurable-here-electron-and-a-hardware-gpu-desktop).

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
unit-tested in `scripts/perf-report.test.ts` (no browser). The CPU-profile
attribution — buckets, self-time ranking, project-only hotspots, the JS/idle
shares and the malformed-profile guards — lives in `scripts/perf-profile.mjs`
and is unit-tested against hand-built CDP profiles in
`scripts/perf-profile.test.ts` (no browser, no CDP session). The page-side
probe's sampling contract is tested against a fake Phaser game in
`src/core/perfProbe.test.ts`. The Playwright boot path itself is not
unit-tested (same trade-off as `scripts/capture-gameplay.mjs`); it is verified
by running the harness.
