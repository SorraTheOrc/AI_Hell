# Performance

How the game's frame time is measured, what the numbers mean, and how to
compare two runs. This is the prerequisite for every optimisation in the
Optimization pass epic (parent AH-0MVWJQUN6009IS87): nothing is optimised or
claimed as an improvement without a harness number before and after.

The harness itself is AH-0MVXV0DER009ER70. The 100-enemy stress gym, the
recorded desktop/Electron/mobile baseline and the per-hotspot results are
tracked by the sibling children (AH-0MVXV0DT50028RF8, AH-0MVXV0E8000937U5,
AH-0MVXV0FUP006W8OR).

## Budget

| Tier | Target | Notes |
|---|---|---|
| Desktop browser and Electron | **60 FPS** with 100 late-game enemies alive — p95 frame time ≤ 16.7 ms with no sustained long-frame spike | The number every optimisation child must beat. |
| Mobile browser | **≥ 30 FPS** under a fixed CPU throttle (≥ 4×) with 100 enemies | Mobile is explicitly allowed a lower target, but must stay playable. |

The target is only falsifiable alongside a **reference machine**. Every report
records the host it ran on (`host` in the JSON: platform, CPU model, CPU count,
memory, load average, Node version); record that description next to any
baseline you publish.

## Measuring a run

```bash
npm run perf:measure                                   # PlayScene, 10 s, headless
npm run perf:measure -- --seconds 60                   # the 60-second target run
npm run perf:measure -- --scene GymPerformance --seconds 60
npm run perf:measure -- --cpu-throttle 4               # the mobile tier
npm run perf:measure -- --out perf-baseline.json       # keep the JSON report
npm run perf:measure -- --compare perf-baseline.json    # before/after deltas
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
| `elapsedSeconds`, `frames` | The measured wall-clock span and the number of sampled frame intervals. |
| `frameTimeMs.p50`, `.p95`, `.max`, `.mean` | Frame-time percentiles in milliseconds. Percentiles, not means, so one hitch does not hide the typical frame. |
| `fps.effective` | `frames ÷ elapsedSeconds` — the loop's real throughput. |
| `fps.phaserActualFps` | Phaser's own smoothed `game.loop.actualFps` reading at the end of the window (cross-check). |
| `longFrames.over33Ms`, `.over50Ms` (+ percentages) | Frames slower than 33 ms (a missed 30 FPS frame) and 50 ms (a visible hitch). Counts are strict (`>`), so a frame at exactly 33.0 ms is not a long frame. |
| `counts.peak`, `.mean`, `.last`, `.samples` | Live enemies, enemy bullets, player bullets and minerals sampled every 250 ms — the load that produced the frame times. `counts` is `null` when the scene exposes none. |
| `activeSceneKeys`, `pageErrors` | Proof of which scene actually ran, and any page exception during the window (a page error fails the run). |

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

## Reference machine

Record the host with every published baseline. The numbers in this document
were captured on:

| | |
|---|---|
| CPU | AMD Ryzen 7 4800H with Radeon Graphics (16 logical CPUs) |
| Memory | 30 GB |
| OS | Linux 7.0.0-38-generic (x86_64) |
| Browser | Playwright 1.55.1 Chromium, **headless** with software WebGL (SwiftShader) via `--enable-unsafe-swiftshader` |
| Node | v22.22.1 |

**Read the browser line carefully.** The harness runs headless with a software
WebGL backend, which is a *reproducible* but pessimistic renderer: it measures
the game loop honestly but not the desktop GPU raster path. The desktop target
(60 FPS on desktop browser and Electron) must therefore be recorded with a
real GPU renderer by the baseline child (AH-0MVXV0E8000937U5); the headless
figures are for comparing runs of the *same* harness on the *same* host, not
for declaring the desktop budget met.

## Noise floor

Two consecutive 10-second `PlayScene` runs on this host at load average
~10–11 on 16 CPUs (the host was **not** idle — another agent's work was
running) produced:

| Metric | Run 1 | Run 2 | Delta |
|---|---|---|---|
| p50 frame time | 16.7 ms | 16.7 ms | 0.0 % |
| p95 frame time | 33.4 ms | 33.4 ms | **0.0 %** |
| max frame time | 33.4 ms | 50.0 ms | +49.7 % |
| effective FPS | 44.4 | 45.0 | +1.4 % |
| long frames (> 33 ms) | 156 (35.1 %) | 149 (33.0 %) | −4.5 % |
| live enemies (peak/mean) | 5 / 5.0 | 5 / 5.0 | — |

What this tells us:

- **Percentiles are stable, the tail is not.** p50 and p95 matched exactly
  across the two runs (p95 within the 20 % noise-floor expectation used by
  `--compare`), while `max` moved by ~50 % — a single frame can always be
  delayed by the OS or GC. Judge an optimisation on **p50/p95 and effective
  FPS**, and treat `max` as a hitch indicator that needs several runs before it
  means anything.
- **The headless software renderer is the floor, not the target.** ~45 FPS
  effective on level 1 with five enemies is the SwiftShader raster cost, not
  gameplay cost; it will move when the renderer or the host changes far more
  than when the game loop is optimised. Always compare runs captured on the
  same host, in the same mode, with the same `--seconds`/`--warmup`.
- **Record the load.** Every report carries the host's load average; a "win"
  measured at load 2 against a baseline at load 12 is not a win. Re-run a
  suspicious comparison on a quieter host.

A 4× CPU-throttled 5-second run (the mobile-tier profile) on the same host
measured ~32 FPS effective (p50 33.3 ms, p95 50 ms), confirming the throttle
option is applied and materially changes the result.

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

The percentile, long-frame, FPS-derivation, count-summary, report-header and
comparison maths live in `scripts/perf-report.mjs` and are unit-tested in
`scripts/perf-report.test.ts` (no browser). The page-side probe's sampling
contract is tested against a fake Phaser game in
`src/core/perfProbe.test.ts`. The Playwright boot path itself is not
unit-tested (same trade-off as `scripts/capture-gameplay.mjs`); it is verified
by running the harness.
