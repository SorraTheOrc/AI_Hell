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
AH-0MW2DB9VN006XB63). The **hardware-GPU desktop** baseline — desktop browser
and Electron, both on the reference host's RTX 3050 Ti — is recorded in
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline)
(AH-0MW2IRYJ2006PV3P). The **mobile tier** re-measured on the same hardware
WebGL backend, still under the 4× CPU throttle, is recorded in
[Hardware-WebGL mobile tier](#hardware-webgl-mobile-tier-4-cpu-throttle)
(AH-0MW3KP1R90030QY9). The **asteroid field** pair for the batched-asteroid
rendering work (parent AH-0MW4857B0004GMWR) is recorded in
[Asteroid field rendering](#asteroid-field-rendering-gymasteroidstress) — the
before half is AH-0MW507VYG009SFR5 and the after half AH-0MW508JS2004W3SR. The
**final target verification** (AH-0MVXV6VOI006P7VG) measures the finished tree
end to end and records the parity and determinism evidence — see
[Final target verification](#final-target-verification-ah-0mvxv6voi006p7vg).

## How every number is recorded

Every measurement section below opens with a **`Recorded:`** line naming the
commit hash the numbers describe, the date, the host/platform they ran on and
the CPU-throttle factor that was applied; the rows themselves name the work
item that produced them. A published number is therefore reproducible (or
disprovable) from the repository alone: check out the commit, run the harness
command in [Measuring a run](#measuring-a-run) on a matching host and compare
within the [noise floor](#noise-floor). The convention is enforced by
`src/performanceDocs.test.ts`, which fails if a section's provenance line, the
budget statement, the harness command, the baseline table or a results table is
removed.

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

## Enemy-count sweep

**`Recorded:`** commit `4901620d` (the sweep driver AH-0MW5IUEX1004AZRH plus
the CLI fix AH-0MW6CORAZ001FZZ3 — the tooling this section documents) ·
2026-11-07 · [reference machine](#reference-machine) — headless Chromium
(**SwiftShader software WebGL**, the default backend) · CPU throttle **1×**
(the default) · AH-0MW5IUG0D004LX0E. The recorded reference sweep
(AH-0MW5IUGKO003UC6T) publishes the per-step numbers this tool produces — see
[Recorded reference sweep](#recorded-reference-sweep-ah-0mw5iugko003uc6t)
below.

The stress gym measures **one** fixed load — exactly 100 late-game enemies —
because that is the number the budget is stated against; it leaves "how many
enemies can the game actually hold at a playable frame rate?" unanswered.
`npm run perf:sweep` answers that deterministically: it walks the enemy load
upward in 50-enemy steps (50, 100, 150, …), measures each step **once** for at
least **15 seconds**, and stops at the first step whose **average FPS is below
30** — that step is the failure point, the previous one the last playable
load. One command produces the headroom curve (min / average / max FPS per
load) as a per-step table plus a headline verdict, with the same data written
to a machine-readable JSON report. The skill usage guide lives in
[`.pi/skills/perf-sweep/`](../.pi/skills/perf-sweep/SKILL.md)
(AH-0MW5IUFGX00500XT).

The sweep is a **measurement tool, not a test run**: it boots a browser and
takes minutes, so it is intentionally not part of the vitest suite and not run
by the test skill. Run it from the repo root on the
[reference machine](#reference-machine) and compare numbers only within one
host load band ([noise floor](#noise-floor)) — host load is recorded per step,
so a noisy sweep is identifiable rather than silently comparable.

### Recorded reference sweep (AH-0MW5IUGKO003UC6T)

**`Recorded:`** commit `3e81aae8` (the measured tree; this documentation
change touches no game code) · 2026-11-07 ·
[reference machine](#reference-machine) — headless Chromium 140
(**SwiftShader** software WebGL, the default backend) · CPU throttle **1×**
(the default) · host load (1/5/15 min) **5.77 / 6.58 / 4.87** at the 50-enemy
step and **7.11 / 6.78 / 4.98** at the 100-enemy step · AH-0MW5IUGKO003UC6T.

One `npm run perf:sweep` at the documented defaults — derived seed
`2013458503`, aggression 5, 15 s window with a 5 s warm-up, 1× CPU throttle,
400-enemy ceiling, 30-minute budget — on a quiet reference host (no other
agent's suite was running; the 1-minute load was 3.2 at launch). The sweep
stopped at the first below-30 step:

> **playable to 50 enemies; first failure at 100 with average 27.3 FPS**

| Step | Enemies | Dive % | Loadout (level) | Min FPS | Avg FPS | Max FPS | Verdict | Host load (1/5/15 min) |
|---|---|---|---|---|---|---|---|---|
| 0 | 50 | 28 % (14 divers) | `cannon`, `rapid L4`, `wave_laser L4`, `arc L4`, `shard_swarm L4`, `phase_shift L4`, `teleport L4` | 5.0 | 46.7 | 60.6 | playable | 5.77 / 6.58 / 4.87 |
| 1 | 100 | 48 % (48 divers) | `cannon`, `rapid L4`, `wave_laser L4`, `arc L4`, `shard_swarm L4`, `phase_shift L4`, `teleport L4` | 5.0 | 27.3 | 60.2 | failure | 7.11 / 6.78 / 4.98 |

The loadout is the run-level representative late-game player — campaign level
5 → upgrade level 4, not maxed — so only the **shoot/dive mix varies per
step**. The full archetype mix was: step 0 (50) `diver` 14, `tank` 6, `swarm`
7, `phaser` 10, `raider` 8, `march` 5; step 1 (100) `diver` 48, `tank` 9,
`swarm` 14, `phaser` 9, `raider` 8, `march` 12. The **minimum FPS of 5.0** in
both rows is a single ~200 ms frame at the start of the window (a GC/OS
hitch), not the sustained load — the 50-enemy step's p95 is 33.4 ms — so judge
the load on the average and p95, per the [noise floor](#noise-floor). The
full frame-time distribution, the live enemy/bullet counts and each step's
host block are in the raw harness reports the verdict names.

The **last playable load is 50 enemies** (average 46.7 FPS); the **first
failing step is 100 enemies** (average 27.3 FPS, p50 33.3 ms). The
machine-readable verdict — scene, seed, aggression, throttle, host, commit,
both steps' loadout and levels, mix, min/average/max FPS, live counts and the
`webgl` backend — is committed at
[`docs/perf/sweep-reference.json`](./perf/sweep-reference.json).

No regression or hotspot beyond this expected playability boundary was
exposed — see [How it differs from the fixed 100-enemy
rows](#how-it-differs-from-the-fixed-100-enemy-rows) for why the sweep is not
comparable to the budget baseline — so no `discovered-from` work item was
needed.

### What the sweep measures

- **Enemies that shoot *and* dive.** Every step fields the six late-game
  firing archetypes of the stress gym — `tank`, `swarm`, `phaser`, `diver`,
  `raider`, `march` — created by the shared `createEnemyFromConfig` factory
  and firing through the shared `fireForEnemy` dispatcher. The `diver`
  archetype dives; the other five shoot. Enemies are **not** invulnerable: the
  player's fire can kill them, so the live enemy count decays within a step
  and the step's count is the peak/target load (the live counts are recorded).
- **The player fires.** Auto-fire is on with the step's loadout, so the
  measured frame cost includes the player's own bullets and kills. Minerals
  are off (`minerals: false`).
- **A semi-random, representative loadout per step**, built through the
  shipped seams and recorded with the step (ids *and* levels):
  - the permanent `cannon` is always the base weapon;
  - one weapon from **each** broad category — projectile (`spread`, `dual`,
    `rapid`), beam (`wave_laser`), area-of-effect (`nova`, `mortar`, `arc`)
    and exotic/positional (`ricochet`, `cluster`, `options`, `rear_guard`,
    `broadside`, `railgun`, `shard_swarm`, `heavy_slug`);
  - **at least one power-up** from `POWER_UP_CATALOGUE`;
  - the remaining slots are seeded picks, capped at the shipped six-slot limit
    (`POWER_UP_SLOT_CAP = 6`);
  - **levels are not maxed.** A weapon/power-up is granted at the
    *representative level* of the campaign level a hex of the configured
    `--aggression` deploys at: campaign level 1 → upgrade level 1, campaign
    `MAX_LEVEL` (10) → level 7 (`REPRESENTATIVE_LEVEL_MAX`), monotone in
    between — a strong-but-not-maxed late-game player even at the highest
    aggression.
- **A varying shoot/dive mix per step**: the `diver` share is drawn seeded per
  step in `[0.2, 0.5)`, so the mix varies across the sweep while always
  containing both behaviours. The roster is fixed at step setup, so the load
  is constant for that step's measurement window.
- **As-played, deterministic mode**: one seed for the whole run and a fixed
  per-step duration — the same seed reproduces the same loadout sequence and
  the same mixes. The seed is recorded in the verdict JSON.

### The measurement window

Each step measures for **at least 15 seconds** (`--seconds`, minimum enforced,
default 15). A 5-second warm-up (`--warmup`, default 5) lets the scene settle
before the window and is **excluded** from the measured time. Per step the
harness records **min, average and max FPS** alongside the frame-time
percentiles (p50/p95), long-frame counts and the live enemy/bullet counts
sampled through the shared `CombatScene` counts seam.

### The stop rule

- A step whose **average FPS is strictly below 30** is the sweep's
  **failure point**; exactly 30 FPS is still playable.
- The **previous step is the last playable load** (the headline reads
  *playable to N enemies; first failure at M with average X FPS*).
- A **hard ceiling** (400 enemies by default, `--ceiling`) and a
  **total-run budget** (30 minutes, `--budget`) stop a runaway sweep when no
  step ever fails.

### How to run it

Prerequisite: the Playwright Chromium build (`npm run capture:install`), the
same prerequisite the `perf:measure` harness needs.

```bash
npm run perf:sweep                                  # defaults: seed derived, aggression 5
npm run perf:sweep -- --seed 42 --aggression 6      # reproducible runs
npm run perf:sweep -- --ceiling 200 --budget 60     # bound the run
npm run perf:sweep -- --json                        # verdict JSON on stdout
npm run perf:sweep -- --out perf-output/my-sweep.json
```

`npm run perf:sweep` is `node scripts/perf-sweep.mjs`. It starts the Vite dev
server itself, launches headless Chromium through Playwright, switches to the
parameterised stress gym and walks the steps — no manual load selection.

| Option | Default | Meaning |
|---|---|---|
| `--seed N` | derived per run | Run seed for the loadout and mix streams; recorded, so an implicit seed is still reproducible. |
| `--aggression N` | `5` | Hex aggression whose campaign level the loadout levels derive from. |
| `--seconds N` | `15` | Measured window per step; rejected below 15. |
| `--warmup N` | `5` | Scene-settling seconds before each measured window (excluded from measurement). |
| `--ceiling N` | `400` | Hard upper bound on a planned step. |
| `--budget N` | `30` | Total-run budget in minutes. |
| `--cpu-throttle N` | `1` | Pass-through Chromium CPU throttle factor (e.g. `4` for the mobile tier). |
| `--scene KEY` | `GymPerformance` | Registered scene key to measure. |
| `--out FILE` | `perf-output/sweep-<ts>.json` | Verdict JSON path (under the git-ignored `perf-output/`). |
| `--json` | off | Emit the verdict JSON on stdout instead of the table. |
| `-h`, `--help` | — | Show the usage text. |

Human output is the headline verdict plus one row per step (step index, target
enemy count, the step's `diver` share, min / average / max FPS and the
`playable`/`failure` verdict); the JSON verdict names the scene, seed,
aggression, CPU throttle, started time, **host** and **commit**, the step
list, each step's loadout *and levels*, shoot/dive mix, the per-step raw
report paths and the verdict. Exit codes: `0` a completed sweep, `1` a failed
run (no partial verdict is published), `2` a usage error.

### How it differs from the fixed 100-enemy rows

The [100-enemy baseline rows](#baseline-100-enemies-60-s) are the **budget's**
worst case: exactly the 100 enemies the 60 FPS target is stated against, with
the player's auto-fire disabled so the load cannot be shot down
mid-measurement. The sweep answers the **playability** question — how many
enemies the game holds before average FPS falls below 30 — with the player
*actually playing* (auto-fire on, semi-random loadout), so the measured frame
cost includes the player's own bullets and kills. Both exist because they ask
different questions, and they are **not comparable**: different enemy counts
and composition, different player load, different window and a different
verdict metric (average FPS vs the budget's p95 frame time).

## The asteroid stress gym (`GymAsteroidStress`)

The asteroid batched-rendering work (parent AH-0MW4857B0004GMWR) needs a
reproducible field of hundreds of live rocks; `GymPerformance` is 100 firing
ships, not asteroids. `GymAsteroidStress` (AH-0MW507M5L0084TSW) is that
scenario on demand, again built entirely from the shared gym/combat core:

- **200 live asteroids**, mixed `large`/`medium` tiers, scattered over the
  playfield by a seeded pure planner (`buildAsteroidStressSpawnEvents`) and
  materialised through the shared `createAsteroidFromEvent` seam — the same
  code the game's scheduled asteroid hazard runs, so the measured render path
  is the game's own.
- **A representative late-game wave** of 12 firing enemies (two of each
  `tank`, `swarm`, `phaser`, `diver`, `raider`, `march`), built by the shared
  `createEnemyFromConfig` factory and firing through the shared `fireForEnemy`
  dispatcher from the first frame (`shootEnabled: true`).
- **Only the target load and a stable window**: the rock field is stationary
  (zero velocity, with a rock-free pocket around the ship so a ram can never
  split a rock and change the composition), formation drift 0, no wave
  timeout, no power-up layer and no seeded mineral field. Player auto-fire is
  disabled (the documented divergence the other stress gym also records), so
  the 200-rock load cannot be shot down mid-measurement; every rock still
  rotates through the shared `Asteroid` path, so the rendering work is the
  game's own.
- **Deterministic**: the field seed (`GYM_ASTEROID_STRESS_FIELD_SEED`, or a
  capture setup's `seed`) reproduces identical rock positions, velocities,
  tiers, rotations and count; the wave roster is derived from the grid offset.
- **Live readout**: a top-left overlay reports FPS, the live asteroid count,
  the wave count and the same shared `getPerformanceCounts()` fields the probe
  samples every 250 ms, so a report's `counts` block (peak/mean `enemies` =
  212 with the full load) is the authoritative load label.

```bash
npm run perf:measure -- --scene GymAsteroidStress --seconds 60 --warmup 3
```

Because the field is deterministic, a before/after pair on the same host,
scene, window and throttle isolates the asteroid rendering change. That pair is
recorded in
[Asteroid field rendering](#asteroid-field-rendering-gymasteroidstress) — the
before half (pre-batched-rendering tree) is AH-0MW507VYG009SFR5. The gym is
watchable/capturable like every other gym (`WATCHABLE_GYM_SCENE_KEYS`), and
`docs/GYM_PARITY.md` records its parity row.

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
command. The software-baseline rows below used electron 45.2.2 on Node v22.22.1;
the hardware-GPU rows in
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline) used electron
45.2.3 on the same Node.

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

`--gpu` drops the software-WebGL switch and asks Chromium for the real GPU by
naming the backend (`--ignore-gpu-blocklist`, GPU rasterisation,
`--use-gl=angle --use-angle=vulkan` — the same switch set for both hosts). The
explicit ANGLE-Vulkan pair matters: unblocklisting alone still left Chromium on
ANGLE's SwiftShader Vulkan device on a host with a working NVIDIA driver, so the
run rendered through software anyway. Because a headless Chromium asked for
hardware GL can still fall back to SwiftShader, the `--require-hardware-webgl`
guard **refuses the run** (exit 1) unless the report's `webgl.kind` is
`hardware` — a software fallback can never be published under a desktop label:

```bash
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymPerformance --seconds 60
npm run perf:measure -- --host electron --gpu --require-hardware-webgl \
  --scene GymPerformance --seconds 60
```

On this host both now pass the guard on the RTX 3050 Ti and are recorded in
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline); before the
host remediation (AH-0MW2L3JXU008I2Z8) the guard refused both, quoting the
exact software renderer string.

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
([Electron baseline](#electron-baseline-software-gpu-process-rasteriser)), the
hardware-GPU pair now holds it with a wide margin
([Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline)), and the
mobile tier clears its ≥ 30 FPS bar on the same hardware backend at the 4×
throttle ([Hardware-WebGL mobile tier](#hardware-webgl-mobile-tier-4-cpu-throttle)).

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
| `--gpu` | off | Request the hardware GPU instead of the software (SwiftShader) backend. Drops the software-permitting switch and asks ANGLE for the Vulkan backend (`--use-gl=angle --use-angle=vulkan`), so a GPU-less host reports absent/software WebGL instead of silently using it. |
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
| `frameTimeMs.min`, `frameTimeMs.p50`, `frameTimeMs.p95`, `frameTimeMs.max`, `frameTimeMs.mean` | Frame-time percentiles in milliseconds. Percentiles, not means, so one hitch does not hide the typical frame. `min` is the fastest frame and `max` the slowest. |
| `fps.effective` | `frames ÷ elapsedSeconds` — the loop's real throughput. |
| `fps.min`, `fps.max` | The slowest and fastest frame expressed as a rate (`1000 ÷ frameTimeMs.max` and `1000 ÷ frameTimeMs.min`), so min/max FPS never have to be re-derived from a partial record. |
| `fps.mean` | `frames ÷ elapsedSeconds` — the average rate (the same arithmetic as `fps.effective`, recorded under its own name for min/mean/max reporting). |
| `fps.phaserActualFps` | Phaser's own smoothed `game.loop.actualFps` reading at the end of the window (cross-check). |
| `longFrames.over33Ms`, `longFrames.over50Ms` (+ percentages) | Frames slower than 33 ms (a missed 30 FPS frame) and 50 ms (a visible hitch). Counts are strict (`>`), so a frame at exactly 33.0 ms is not a long frame. |
| `counts.peak`, `counts.mean`, `counts.last`, `counts.samples` | Live enemies, enemy bullets, player bullets and minerals sampled every 250 ms — the load that produced the frame times. `counts` is `null` when the scene exposes none. |
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

**`Recorded:`** commit `3e33e5c9` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1× · AH-0MVXV0E8000937U5.

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

**`Recorded:`** commit `3e33e5c9` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1× · AH-0MVXV0E8000937U5.

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

**`Recorded:`** commit `3e33e5c9` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1× / 2× / 4×, per row ·
AH-0MVXV0E8000937U5.

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

Those rows are the **software-WebGL floor**: on SwiftShader the rasteriser, not
the throttled JS, sets the frame time, so they describe this host without a
usable GPU rather than the mobile tier's shape (real GPU, slow CPU). The same
tier re-measured on the host's **hardware GPU** is the next section — it keeps
these rows as the floor and clears the bar.

### Hardware-WebGL mobile tier (4× CPU throttle)

**`Recorded:`** commit `ca6be545` (game code; this documentation change
touches no game code) · 2026-11-05 · desktop browser (headless Chromium
140.0.7339.186) on the **NVIDIA RTX 3050 Ti through ANGLE-Vulkan** · CPU
throttle 4× · AH-0MW3KP1R90030QY9.

The mobile tier is the same harness under a 4× CPU slowdown. Every mobile row
recorded before this section was taken on the **software** WebGL backend,
because the host had no usable GPU; the recorded verdict was *"mobile tier
target missed"* with the residual attributed to software rasterisation, not to
draw submission or simulation. Now that the host reaches its GPU
(AH-0MW2L3JXU008I2Z8, AH-0MW2IRYJ2006PV3P), the tier can be measured the way a
phone actually behaves: a **real GPU with a 4×-slowed CPU**. Four runs of
`GymPerformance` (exactly 100 late-game enemies with live fire),
`--seconds 60 --warmup 3`, with `--gpu --require-hardware-webgl` so a software
fallback refuses the run (exit 1) instead of being published (run 1 additionally
carries `--profile`):

```bash
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymPerformance \
  --seconds 60 --warmup 3 --cpu-throttle 4 \
  --profile perf-output/mobile-gpu.cpuprofile --out perf-output/mobile-gpu.json
```

**Backend, exactly as recorded in the reports.** All four reports carry
`webgl.kind: "hardware"` and `runtime: { kind: "browser", chromeVersion:
"140.0.7339.186" }`, and all four name the same renderer as the
[hardware-GPU desktop rows](#hardware-gpu-desktop-baseline):

```
ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0)), NVIDIA)
```

Host block (`host` in every report) is the [reference machine](#reference-machine)
(AMD Ryzen 7 4800H, 16 logical CPUs, 30 223 MB, Linux 7.0.0-38-generic, Node
v22.22.1). Rows are ordered by host load, and only run 1 ended inside the
documented 9–13 baseline band: the box was carrying other sessions' test
suites (and, during run 2, an unthrottled Chromium) throughout, so runs 2–4 are
labelled out of band rather than blended in — they are recorded as the
tier's **load sensitivity**, which is what they are.

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|
| 1 (profiled, in band) | 9.25 | **16.7** | **16.8** | 99.9 | 16.83 | **59.44** | 26 (0.73 %) | 3 (0.08 %) | 479 / 213.8 |
| 2 (out of band) | 16.43 | **16.7** | 33.3 | 233.3 | 18.60 | **53.77** | 246 (7.63 %) | 32 (0.99 %) | 317 / 200.2 |
| 3 (out of band) | 17.29 | **16.7** | 33.4 | 133.3 | 19.78 | **50.57** | 476 (15.69 %) | 23 (0.76 %) | 320 / 217.5 |
| 4 (out of band) | 23.20 | **16.7** | 49.9 | 183.4 | 21.34 | **46.85** | 550 (19.57 %) | 71 (2.53 %) | 328 / 207.5 |

Counts (`counts` in the reports): enemies are exactly **100** in peak *and*
mean in all four runs, so the load is fixed and the frame times are comparable
run to run; player bullets are 0 by design (the gym disables the player's
auto-fire); enemy bullets peak 317–479 and mean 200–218; live minerals stay
effectively empty (peak 2–7), as the stress gym intends.

CPU attribution over the profiled window (share of the measured window, %):

| Run | JS | simulation | renderer | ui | audio | gc | idle | native | other |
|---|---|---|---|---|---|---|---|---|
| 1 (in band, load 9.25) | 50.96 | 9.10 | 40.90 | 0.54 | 0.37 | 0.68 | 32.01 | 16.35 | 0.04 |

**Mobile-tier verdict: met.** Read the numbers this way:

- **The bar is cleared with room, at the mobile tier's throttle.** Run 1 — the
  one taken inside the documented load band — reports **59.44 FPS** against the
  ≥ 30 FPS bar, with p50 16.7 ms, p95 16.8 ms and 26 long frames in 3 566
  (0.73 %). p50 is the 60 Hz vsync step, exactly as the hardware desktop rows
  are: at this load the 4×-throttled CPU finishes the frame inside the vsync
  window (32.01 % of the window is idle) and the GPU draws it.
- **The pass is not a single lucky window.** Runs 2–4 ran at load 16.43, 17.29
  and 23.20 — busier than the documented 9–13 band, and busier than the desktop
  software baseline band — and still hold **53.77**, **50.57** and **46.85
  FPS**, 79 %, 69 % and 56 % above the bar. The tail moves with the host (p95
  33.3 → 49.9 ms) but p50 stays pinned at the 16.7 ms vsync step in all four
  runs, which is the same load-sensitivity pattern the
  [noise floor](#noise-floor) describes.
- **The mobile shortfall was the software rasteriser, as attributed.**
  `native` — the CPU rasterisation bucket that dominated the software rows —
  falls from **76.92 %** of the 4× window to **16.35 %**, and the frame time
  falls from 41.30 ms to 16.83 ms mean. Nothing in the shipped code changed to
  produce that: the same draw submission now lands on the GPU.
- **Per-frame JS is unchanged, so the backend explains the whole delta.** The
  software 4× row spends 22.23 % of a 41.30 ms frame in JS (≈ 9.2 ms); this run
  spends 50.96 % of a 16.83 ms frame (≈ 8.6 ms). The throttle stretches the JS
  bucket's *share* of a shorter window, not the work per frame — compare frame
  times across backends, not bucket percentages (see
  [Measurement method](#measurement-method)).
- **Draw submission is still the top JS cost, and it no longer decides the
  frame.** `ContainerWebGLRenderer` 4.87 %, `GraphicsWebGLRenderer` 4.29 %,
  `renderWebGLStep` 3.43 %, `batch` 1.99 %, `ImageWebGLRenderer` 1.57 % of the
  window — the same order the software rows produced. That is why the baked
  body-texture work ([Baked enemy body
  textures](#baked-enemy-body-textures-ah-0mw2iryah0055wcn)) still counts at the
  1× budget; it is simply no longer the limiting resource at 4× on a real GPU.
- **This is a proxy, not a phone.** A 4×-throttled desktop Chromium on a laptop
  GPU is a defensible proxy for "real GPU, slow CPU", not a measurement of any
  specific handset. The bar, the throttle factor and the [reference
  machine](#reference-machine) are unchanged; what changed is the backend the
  frame is drawn on.

### Electron baseline (software GPU-process rasteriser)

**`Recorded:`** commit `03f11377` · 2026-11-04 · Electron 45.2.2
(Chromium 156.0.8078.80) with SwiftShader over the GPU process · CPU throttle
1× · AH-0MW2DB9VN006XB63.

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

The hardware-GPU Electron rows are published separately, on a different
backend and Electron version: see
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline).

### PlayScene late game (supplementary)

**`Recorded:`** commit `3e33e5c9` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1× · AH-0MVXV0E8000937U5.

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

Each row carries its own commit and date, because this table spans the
baseline commit and the desktop-host commit:

| Run | Commit | Date | Host | CPU throttle | JS | simulation | renderer | ui | audio | gc | idle | native | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GymPerformance 1× (run 3, load 9.28) | `3e33e5c9` | 2026-11-04 | headless Chromium (SwiftShader) | 1× | 14.75 | 1.00 | 13.69 | 0.02 | 0.04 | 0.40 | 0.10 | 84.75 | 0.00 |
| GymPerformance 1× (run 1, load 15.48) | `3e33e5c9` | 2026-11-04 | headless Chromium (SwiftShader) | 1× | 14.70 | 1.16 | 13.43 | 0.03 | 0.05 | 0.44 | 0.11 | 84.77 | 0.00 |
| GymPerformance 4× (load 9.89) | `3e33e5c9` | 2026-11-04 | headless Chromium (SwiftShader) | 4× | 37.10 | 3.22 | 33.51 | 0.11 | 0.20 | 0.93 | 0.16 | 61.84 | 0.02 |
| PlayScene level 10 demo (load 13.39) | `3e33e5c9` | 2026-11-04 | headless Chromium (SwiftShader) | 1× | 9.10 | 3.75 | 5.23 | 0.04 | 0.05 | 0.39 | 11.93 | 78.60 | 0.00 |
| GymPerformance 1×, **Electron** (load 15.30) | `03f11377` | 2026-11-04 | Electron 45.2.2 (SwiftShader GPU process) | 1× | 15.76 | 1.10 | 14.56 | 0.06 | 0.08 | 1.21 | 51.50 | 32.18 | 0.03 |
| GymPerformance 1×, **Electron** (load 19.58) | `03f11377` | 2026-11-04 | Electron 45.2.2 (SwiftShader GPU process) | 1× | 15.80 | 1.19 | 14.53 | 0.06 | 0.08 | 1.20 | 49.39 | 34.26 | 0.03 |

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

**Caveat that must travel with this verdict.** The measurements below are taken
on
**SwiftShader**, a CPU rasteriser, so "renderer-bound" here means *draw
submission and rasterisation bound*; the rasterisation half is an artefact of
the software backend and is far cheaper on a hardware GPU. The main-thread JS
share (14.75 %) is backend-independent, so *the game's simulation is not the
bottleneck* holds on any backend; *the renderer is the bottleneck* is proven for
this backend only. The hardware-GPU pair
([below](#hardware-gpu-desktop-baseline)) keeps the draw-submission share and
removes the rasterisation half of the cost, which is why it has ~79–82 % idle
headroom at the 60 Hz vsync step.

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
   confirmation rather than a rescue: it widened the margin instead of deciding
   pass/fail. That confirmation now exists — the hardware-GPU pair reaches
   p50 16.7 / p95 16.7–16.8 ms at **59.95–60.00 effective FPS** with 0–2 frames
   over 33 ms in ~3 600, i.e. the vsync step with ~79–82 % of the main thread
   idle ([Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline)).

## Hardware-GPU desktop baseline

**`Recorded:`** commit `cfc0068e` (game code; this documentation change touches
no game code) · 2026-11-05 · desktop browser (headless Chromium 140.0.7339.186)
and Electron 45.2.3 (Chromium 156.0.8078.80), **both on the NVIDIA RTX 3050 Ti
through ANGLE-Vulkan** · CPU throttle 1× · AH-0MW2IRYJ2006PV3P.

The desktop target is stated for "desktop browser **and Electron**". This is
that measurement on a **hardware GPU**: `GymPerformance` (exactly 100 late-game
enemies with live fire), `--seconds 60 --warmup 3`, run with `--gpu
--require-hardware-webgl` on both hosts — so a software fallback would have
refused the run (exit 1) instead of being published as a desktop baseline. Two
runs per host, so the vsync-step percentiles are shown to be reproducible
rather than a single lucky window.

```bash
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymPerformance \
  --seconds 60 --warmup 3 --profile perf-output/desktop-gpu.cpuprofile \
  --out perf-output/desktop-gpu.json
npm run perf:measure -- --host electron --gpu --require-hardware-webgl \
  --scene GymPerformance --seconds 60 --warmup 3 \
  --profile perf-output/electron-gpu.cpuprofile --out perf-output/electron-gpu.json
```

**Backend, exactly as recorded in the reports.** All four reports carry
`webgl.kind: "hardware"`; `runtime` is
`{ kind: "browser", chromeVersion: "140.0.7339.186" }` and
`{ kind: "electron", electronVersion: "45.2.3", chromeVersion: "156.0.8078.80" }`;
both hosts report the **same** renderer:

```
ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0)), NVIDIA)
```

Host block (`host` in every report): AMD Ryzen 7 4800H with Radeon Graphics,
16 logical CPUs, 30 223 MB memory, Linux 7.0.0-38-generic, Node v22.22.1. Host
load is recorded per row — the box was busy with other agents' test suites for
all four runs (load 15.4–23.0), and the runs still hold the vsync step, which is
the point of the hardware row: the rasterisation is no longer competing for the
CPU.

| Host | Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|---|
| Desktop browser (Chromium 140.0.7339.186, hardware ANGLE-Vulkan) | 1 (profiled) | 17.32 | **16.7** | **16.7** | 33.3 | 16.671 | **59.99** | 1 (0.03 %) | 0 (0 %) | 423 / 200.3 |
| Desktop browser (same) | 2 | 15.38 | **16.7** | 16.8 | 50.1 | 16.680 | **59.95** | 2 (0.06 %) | 1 (0.03 %) | 327 / 208.7 |
| Desktop Electron (45.2.3 / Chromium 156.0.8078.80, hardware ANGLE-Vulkan) | 1 (profiled) | 17.26 | **16.7** | **16.7** | 16.8 | 16.666 | **60.00** | 0 (0 %) | 0 (0 %) | 429 / 217.7 |
| Desktop Electron (same) | 2 | 22.99 | **16.7** | **16.7** | 33.3 | 16.671 | **59.99** | 1 (0.03 %) | 0 (0 %) | 318 / 228.5 |

Counts (`counts` in the reports, sampled every 250 ms, 237 samples per run):
enemies are exactly **100** in peak *and* mean in all four runs, so the load is
fixed and the frame times are comparable run to run; player bullets are 0 by
design (the gym disables the player's auto-fire); live minerals peak at 1–8 and
mean 0.55–2.11, i.e. the handful of salvage drops that accumulate during the
window — the field stays effectively empty, as the stress gym intends.

CPU attribution over the two profiled windows (share of the measured window, %):

| Host | JS | simulation | renderer | ui | audio | gc | idle | native | other |
|---|---|---|---|---|---|---|---|---|
| Desktop browser 1× (run 1, load 17.32) | 14.40 | 2.40 | 11.77 | 0.12 | 0.10 | 0.34 | 78.60 | 6.67 | 0.01 |
| Desktop Electron 1× (run 1, load 17.26) | 12.99 | 2.05 | 10.75 | 0.09 | 0.09 | 0.35 | 81.54 | 5.12 | 0.01 |

**Read the numbers this way:**

- **The desktop target is met on a hardware GPU, on both hosts.** Effective FPS
  is 59.95–60.00 with 100 enemies and live fire, p50 is pinned at the 60 Hz
  vsync step (16.7 ms) in all four runs, and long frames are 0–2 per ~3 600
  frames (≤ 0.06 %) — the "no sustained long-frame spike" half of the budget is
  not close. `p95` is 16.7 ms in three of four runs; browser run 2 records
  16.8 ms, 0.1 ms above the formal bar, which is one vsync jitter frame landing
  on the 95th percentile rather than a sustained miss — the same rounding the
  software Electron rows produced (see
  [the noise floor](#noise-floor)). The formal statement is therefore: **≥ 60 FPS
  sustained and p95 = the 16.7 ms vsync step**, with the single 16.8 ms outlier
  recorded rather than rounded away.
- **The headroom is large and measurable.** 78.6 % (browser) and 81.5 %
  (Electron) of the main thread's sampled time is **idle**: on hardware the loop
  finishes each 16.7 ms frame in about a fifth of the window. The earlier
  SwiftShader runs had 0.1 % idle and 84.8–91.5 % `native`; the `native` share
  collapses to 5.1–6.7 % on the GPU, which is exactly the rasterisation half of
  the software-backend cost the
  [renderer-bound verdict](#verdict-renderer-bound-not-simulation-bound)
  said would disappear.
- **The draw-submission balance is unchanged, so the rankings stand.** JS is
  13.0–14.4 % of the window and the game's own simulation 2.05–2.40 %, against
  14.7 % / 1.0–1.2 % on SwiftShader: the renderer bucket (10.8–11.8 %) still
  dominates the simulation by ~5×, and the top JS functions under the hardware
  runs are the same Phaser draw-submission frames
  (`ContainerWebGLRenderer`, `GraphicsWebGLRenderer`, `renderWebGLStep`).
  Nothing in [Ranked hotspots](#ranked-hotspots) changes priority — every ranked
  row was already measured, and the measured levers are unchanged by the
  backend; what changes is that the desktop budget no longer depends on them.
- **This is the formal desktop pass the epic awaited.** The earlier rows were
  "at the budget on this host" on a software rasteriser; these are the same
  budget met on a real GPU driver, on both desktop hosts, and they make the
  target falsifiable on the reference machine in the way
  [Budget](#budget) requires.

### Host access history (why this needed a remediation pass)

The desktop 60 FPS target could not be falsified on a real GPU until
2026-11-04, and the record of why is kept here because the host remediation is
part of the reproducibility story (AH-0MW2L3JXU008I2Z8,
AH-0MW2OB0CN003BWOY). Before the remediation, the software-rasteriser baseline
([Electron baseline](#electron-baseline-software-gpu-process-rasteriser)) was
the only desktop number this host could produce:

- **This host had no usable GPU device for the browser/harness.** `/dev/dri`
  exists (`card0`, `card1`, `renderD128`, `renderD129`) but the render nodes are
  `root:render` with mode `660`, and the measuring user was not in the `render`
  or `video` group, so the process could not open them. (A GPU is physically
  present — an RTX 3050 Ti and a Renoir iGPU — and the NVIDIA device nodes are
  writable, but that path was faulted by a driver version mismatch; see
  [Re-verified](#re-verified-2026-11-04-commit-da8aaa8f) below.) There is also
  no display server (`DISPLAY` unset, no Xvfb installed). Every launch mode
  therefore fell back to a software renderer —
  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`
  — including with `--gpu`, which is why `--require-hardware-webgl` exists and
  refuses the run rather than labelling a software run "desktop".
- **The desktop host runs and renders without a display** (Electron with
  `--ozone-platform=headless`, rasterising in its GPU process — verified by a
  canvas read-back, 1538 distinct colours, and a GPU process at ~7.5 cores),
  but that is still SwiftShader: it says nothing about a hardware driver.

The verification run was filed as AH-0MW2IRYJ2006PV3P by AH-0MVXV6VOI006P7VG
(this host could not produce it, so it could not be part of the final
verification's own evidence there); the runs above are that item's outcome.


### Host access restored (2026-11-04)

**`Recorded:`** commit `da8aaa8f` + the host remediation of
AH-0MW2L3JXU008I2Z8 and the switch change of AH-0MW2OB0CN003BWOY · 2026-11-04 ·
both desktop hosts (headless Chromium and `--host electron`) · CPU throttle 1× ·
AH-0MW2L3JXU008I2Z8. These are again guard checks (`--seconds 3 --warmup 1`),
not measurements: they prove a **hardware** backend is reachable; the 60 s
measured windows are recorded at the top of this section.

The three diagnosed causes each had a fix, and all three are now applied on the
reference host:

1. **NVIDIA driver/library mismatch** — fixed **without a reboot**. The loaded
   module could not be unloaded because `nvidia-powerd` held 11 file handles on
   `/dev/nvidia0`/`/dev/nvidiactl` (`fuser -v /dev/nvidia*` was the only way to
   find the holder), so: `sudo systemctl stop gdm && sudo systemctl stop
   nvidia-powerd && sudo modprobe -r nvidia && sudo modprobe nvidia`.
   `/proc/driver/nvidia/version` then reported `595.99.02` (was `595.91.07`),
   matching the userspace `nvidia-driver-595-open 595.99.02`, and `nvidia-smi`
   reports the GPU (`NVIDIA GeForce RTX 3050 Ti Laptop GPU`, driver 595.99.02,
   CUDA 13.2). A reboot after the driver upgrade does the same thing; the
   module reload avoids killing the in-flight test tree.
2. **DRM render nodes** — `sudo usermod -aG video,render <user>` is applied
   (`/etc/group` carries the user), but group membership is per-session, so it
   only takes effect for a **newly started** session. The NVIDIA path does not
   need it (the `/dev/nvidia*` nodes are mode `666`), so no run depends on it.
3. **Electron** — installed explicitly (`npm install electron`, 45.2.3); it is
   an `optionalDependencies` entry, so a plain `npm install` prunes it again.
   The host cannot run the SUID sandbox helper (it is not root-owned), which is
   why every launch passes `--no-sandbox` — the harness already does
   (`COMMON_SWITCHES`), so `--host electron` runs.

**The `--gpu` switch set had to name the backend.** `--ignore-gpu-blocklist
--enable-gpu-rasterization` alone still produced
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`
on a host with a working driver, so `--require-hardware-webgl` refused every
run. `rendererSwitches({ gpu: true })` (shared by the browser and Electron
hosts) now also passes `--use-gl=angle --use-angle=vulkan`; the software path
(`gpu: false`) is unchanged, so software baselines stay reproducible.

| Invocation | Result |
|---|---|
| `--gpu --require-hardware-webgl --scene GymPerformance --seconds 3 --warmup 1` | **exit 0** — `ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0)), NVIDIA)` |
| `--host electron --gpu --require-hardware-webgl --scene GymPerformance --seconds 3 --warmup 1` | **exit 0** — the same `ANGLE (NVIDIA, Vulkan …)` renderer string |

Both rows are short guard checks, so they carry no publishable frame times;
their job is to show that the guard now *passes* on a hardware backend instead
of refusing, which is what the 60 s runs recorded at the top of this section
([Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline)) then needed.

### Re-verified (2026-11-04, commit `da8aaa8f`)

**`Recorded:`** commit `da8aaa8f` · 2026-11-04 · both desktop hosts (headless
Chromium and `--host electron`) · CPU throttle 1× · AH-0MW2IRYJ2006PV3P. These
are guard checks, not measurements: they record the harness refusing a software
backend, so there are no frame times to attribute.

Both desktop hosts were re-checked against the head of the optimisation work
(baked bullet/enemy-body textures, collision broad phase, allocation removal)
with short guard-check runs (`--seconds 3 --warmup 1`):

| Invocation | Result |
|---|---|
| `--gpu --require-hardware-webgl --scene GymPerformance` | exit 1 — *Refusing to publish a hardware-GPU baseline: the page rendered on a software WebGL backend (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`)* |
| `--host electron --gpu --require-hardware-webgl …` | exit 1 — *Electron is not installed, so `--host electron` cannot run* |

The guard is behaving correctly (a software run is never published as a desktop
hardware baseline), so the gap is **host access**, not harness behaviour. The
diagnosis is now sharper than "no GPU": there are three independent causes,
each with its own fix, and the first two are the only ones that matter.

1. **NVIDIA: kernel module and userspace driver disagree.** `nvidia-smi` fails
   with `Failed to initialize NVML: Driver/library version mismatch` (NVML
   595.99); `/proc/driver/nvidia/version` reports `NVRM … 595.91.07` (the host
   has been up ~3 days, so the loaded module predates the driver upgrade to
   `nvidia-driver-595-open 595.99.02`). The device nodes are **not** the
   problem — `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm` are mode `666`
   and open fine as the non-root measuring user — but a mismatched pair cannot
   create a GL or Vulkan context. **Fix:** reboot (or reload the nvidia
   modules) so the 595.99 module set loads, then confirm `nvidia-smi`.
2. **AMD iGPU: the DRM nodes are not openable by the measuring user.**
   `renderD128` (Renoir) and `renderD129` (NVIDIA), plus `card0`/`card1`, are
   `root:video`/`root:render` mode `660` with an ACL for `gdm-greeter` only;
   the user is in neither group, so `open()` returns `EACCES`. **Fix:**
   `usermod -aG video,render <user>` and re-login (group membership is
   per-session), or run the measurement from the graphical seat session, where
   logind grants the seat user the device ACL.
3. **Electron is not installed.** `node_modules/electron` is absent (it is an
   `optionalDependencies` entry, so a plain `npm install` prunes it again), so
   even the *software* Electron row is currently not reproducible here.
   **Fix:** `npm install electron@^45.2.2` (or `--electron-executable <path>`)
   before the Electron run.

These are operator tasks (they need `sudo`, a re-login or a reboot) and are
tracked as **AH-0MW2L3JXU008I2Z8**, which blocks the verification item
AH-0MW2IRYJ2006PV3P. The 60 s runs stayed outstanding until it completed; they
are recorded at the top of this section.

**The gap was filled** by the 60 s hardware-GPU runs recorded at the top of this
section ([Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline)): both
hosts reached the vsync step at 59.95–60.00 effective FPS. The commands and the
per-run record they ask for are reproduced there with the measured numbers, and
the re-stated verdict is in
[the hardware balance note](#hardware-gpu-desktop-baseline) — the balance did
**not** differ (JS 13.0–14.4 %, simulation 2.05–2.40 %, renderer 10.8–11.8 %), so
[Ranked hotspots](#ranked-hotspots) keeps its ordering.

## Asteroid field rendering (`GymAsteroidStress`)

The batched-asteroid work (parent AH-0MW4857B0004GMWR) is judged on a
**same-host before/after pair** of the
[asteroid stress gym](#the-asteroid-stress-gym-gymasteroidstress): 200 live
rocks plus the representative 12-enemy firing wave, 60 s after a 3 s warm-up on
the reference host's RTX 3050 Ti. The **before** half — the pre-change tree,
where every rock carries its own seeded silhouette texture and falls back to a
per-frame `Graphics` body once the 64-texture bake budget is exhausted — is
recorded below (AH-0MW507VYG009SFR5), and the **after** half — the post-change
tree, where every rock is a plain `Image` on one shared silhouette atlas — is
recorded with the deltas by AH-0MW508JS2004W3SR. Both halves use the same
command, scene, window, throttle and host, so the pair isolates the asteroid
rendering change:

```bash
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymAsteroidStress \
  --seconds 60 --warmup 3 --profile perf-output/asteroid-before.cpuprofile \
  --out perf-output/asteroid-before.json
```

### Before: one texture per rock, per-frame `Graphics` fallback (AH-0MW507VYG009SFR5)

**`Recorded:`** commit `63801fa0` (game code; this documentation change touches
no game code) · 2026-11-06 · desktop browser (headless Chromium 140.0.7339.186)
on the **NVIDIA RTX 3050 Ti through ANGLE-Vulkan** · CPU throttle 1× ·
AH-0MW507VYG009SFR5.

The tree measured here is the one the
[asteroid stress gym](#the-asteroid-stress-gym-gymasteroidstress) landed on:
every asteroid draws a unique seeded jagged polygon and bakes it into its own
texture, so 200 rocks are 200 distinct textures and 200 separate draw
submissions (plus a per-frame `Graphics` re-tessellation for any rock past the
64-texture cache cap). That is the cost the pair has to show. Two runs, so the
vsync-step percentiles are shown to be reproducible rather than a single lucky
window; run 2 repeats the same command without `--profile` (the profile half is
identical either way) and writes `perf-output/asteroid-before-2.json`.

**Backend, exactly as recorded in the reports.** Both reports carry
`webgl.kind: "hardware"` and the renderer string
`ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0)), NVIDIA)`;
`runtime` is `{ kind: "browser", chromeVersion: "140.0.7339.186" }`. Host block
(`host` in both reports): AMD Ryzen 7 4800H with Radeon Graphics, 16 logical
CPUs, 30 223 MB memory, Linux 7.0.0-38-generic, Node v22.22.1. Host load is
recorded per row (4.15 and 8.56) — both inside the quiet band the
[noise floor](#noise-floor) describes.

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemies peak/mean | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 (profiled) | 4.15 | **16.7** | **16.7** | 16.8 | 16.666 | **60.00** | 0 (0 %) | 0 (0 %) | 212 / 212 | 40 / 18.68 |
| 2 | 8.56 | **16.7** | **16.7** | 16.8 | 16.666 | **60.00** | 0 (0 %) | 0 (0 %) | 212 / 212 | 35 / 17.90 |

Counts (`counts` in the reports, sampled every 250 ms, 236 samples per run):
`enemies` is exactly **212** in peak *and* mean in both runs — the 200 rocks
plus the 12 firing enemies, so the load is fixed and the frame times are
comparable run to run. Player bullets are 0 by design (the gym disables the
player's auto-fire, so the rock load cannot be shot down mid-measurement);
minerals are 0 in run 1 and peak 2 / mean 1.91 in run 2, i.e. the handful of
salvage drops that accumulate during the window, not a field.

CPU attribution over the profiled window (run 1, 60 s, 55 393 samples, share of
the measured window, %):

| JS | simulation | renderer | ui | audio | gc | idle | native | other |
|---|---|---|---|---|---|---|---|---|
| 11.15 | 1.66 | **9.34** | 0.11 | 0.03 | 0.21 | 85.44 | 3.20 | 0.01 |

The renderer bucket is dominated by per-object draw submission, exactly the
symbols the batched path targets (self time, share of the window):

| Symbol | Source | Self time | Share |
|---|---|---|---|
| `ContainerWebGLRenderer` | Phaser (container render) | 987.0 ms | 1.63 % |
| `batch` | Phaser (batch submission) | 628.3 ms | 1.04 % |
| `GraphicsWebGLRenderer` | Phaser (Graphics pipeline) | 588.4 ms | 0.97 % |
| `renderWebGLStep` | Phaser (render step) | 564.5 ms | 0.93 % |

The hottest project functions are far smaller — `GymFormationScene.tick`
0.46 %, `CombatScene._handleCollisions` 0.12 % — so the frame is not
simulation-bound.

**Read the numbers this way:**

- **The frame time is already at the vsync step, so the win cannot be shown as
  frame time on this host.** 200 rocks + 12 firing enemies hold p50 = p95 =
  16.7 ms, 60.00 effective FPS and zero long frames in both runs. The batched
  change removes JS draw-submission work, and on a hardware GPU the 60 Hz vsync
  step absorbs the difference — so the **after** half is read from the renderer
  attribution below, not from p50/p95. Any frame-time claim for this change on
  this host would be inside the [noise floor](#noise-floor).
- **The renderer is still the lever, by a wide margin.** The `renderer` bucket
  (9.34 %) is **5.6×** the game's own `simulation` bucket (1.66 %), and 84 % of
  the renderer bucket is the four draw-submission symbols above. The main thread
  is idle for 85.44 % of the window and `native` (GL submission/raster) is
  3.20 %, so this is CPU-side per-object submission, not a saturated GPU.
- **The load is the gym's deterministic one.** 212 = 200 rocks + 12 enemies in
  every sample of both runs, so a re-run on a matching host reproduces the same
  scenario, and the before/after pair compares the same field.

**Verdict.** This is the before half of the pair only: on the reference
hardware-GPU desktop the asteroid field already meets the 60 FPS budget, and the
measured cost the batched rendering targets is **9.34 % renderer** (5.6× the
1.66 % simulation) concentrated in `ContainerWebGLRenderer`, `batch`,
`GraphicsWebGLRenderer` and `renderWebGLStep`. AH-0MW508JS2004W3SR records the
after half against these numbers.

### After: shared silhouette palette, one texture atlas (AH-0MW508JS2004W3SR)

**`Recorded:`** commit `57125ac1` (game code; this documentation change touches
no game code) · 2026-11-06 · desktop browser (headless Chromium 140.0.7339.186)
on the **NVIDIA RTX 3050 Ti through ANGLE-Vulkan** · CPU throttle 1× ·
AH-0MW508JS2004W3SR.

The tree measured here is the one the batched-asteroid change landed on
(AH-0MW5088LA007XYQM, commit `57125ac1`): every asteroid draws as a plain
`Phaser.GameObjects.Image` on one of **10 silhouettes per size tier**, all baked
once into the **single** `asteroid-atlas-v1` texture
(`src/utils/asteroidTextures.ts`), so 200 rocks share one texture bind instead
of owning 200 distinct textures, and an asteroid field never touches the
64-texture `enemy-body-` bake budget. The before half above is the same scene on
the pre-change tree, so the pair isolates exactly that rendering change. Command
— the before command with the after filenames:

```bash
npm run perf:measure -- --gpu --require-hardware-webgl --scene GymAsteroidStress \
  --seconds 60 --warmup 3 --profile perf-output/asteroid-after.cpuprofile \
  --out perf-output/asteroid-after.json
```

Run 2 repeats the same command without `--profile` and writes
`perf-output/asteroid-after-2.json`, as the before half's run 2 did.

**Backend, exactly as recorded in the reports.** Both reports carry
`webgl.kind: "hardware"` and the renderer string
`ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0)), NVIDIA)`;
`runtime` is `{ kind: "browser", chromeVersion: "140.0.7339.186" }`. Host block
(`host` in both reports): AMD Ryzen 7 4800H with Radeon Graphics, 16 logical
CPUs, 30 223 MB memory, Linux 7.0.0-38-generic, Node v22.22.1 — the same
reference host as the before half. Host load is recorded per row (4.58 and
3.69), both inside the quiet band the [noise floor](#noise-floor) describes.

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | mean (ms) | Effective FPS | Frames > 33 ms | Frames > 50 ms | Enemies peak/mean | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 (profiled) | 4.58 | **16.7** | **16.7** | 16.8 | 16.666 | **60.00** | 0 (0 %) | 0 (0 %) | 212 / 212 | 39 / 18.28 |
| 2 | 3.69 | **16.7** | **16.8** | 16.8 | 16.666 | **60.00** | 0 (0 %) | 0 (0 %) | 212 / 212 | 41 / 18.85 |

Counts (`counts` in the reports, sampled every 250 ms, 236 samples per run):
`enemies` is exactly **212** in peak *and* mean in both runs — the 200 rocks plus
the 12 firing enemies, the same fixed load the before half measured, so the pair
compares the same field. Player bullets are 0 by design (the gym disables the
player's auto-fire); minerals are peak 1 / mean 0.96 in run 1 and 0 / 0 in
run 2, i.e. the same handful of salvage drops, not a field.

CPU attribution over the profiled window (run 1, 60 s, 54 793 samples, share of
the measured window, %):

| JS | simulation | renderer | ui | audio | gc | idle | native | other |
|---|---|---|---|---|---|---|---|---|
| 9.45 | 1.72 | **7.61** | 0.08 | 0.03 | 0.11 | 87.31 | 3.13 | 0.01 |

**The pair** — same host, scene, window, warm-up and throttle in every row:

| Measure | Before (AH-0MW507VYG009SFR5) | After (this item) | Change |
|---|---|---|---|
| Effective FPS | 60.00 / 60.00 | 60.00 / 60.00 | none (both at the vsync step) |
| p50 / p95 (ms) | 16.7 / 16.7 in both runs | 16.7 / 16.7 (run 1), 16.7 / 16.8 (run 2) | none measurable |
| Frames > 33 ms | 0 / 0 | 0 / 0 | none |
| Enemies peak/mean | 212 / 212 | 212 / 212 | identical load |
| Main-thread JS | 11.15 % | **9.45 %** | **− 1.70 pp (− 15.2 %)** |
| `renderer` bucket | 9.34 % | **7.61 %** | **− 1.73 pp (− 18.5 %)** |
| `simulation` bucket | 1.66 % | 1.72 % | + 0.06 pp (noise) |
| `idle` | 85.44 % | 87.31 % | + 1.87 pp |
| `native` | 3.20 % | 3.13 % | − 0.07 pp |

The draw-submission symbols the batched path targets (self time and share of
the measured window; the before column is the recorded one, the after column is
this run's top-entries):

| Symbol | Source | Before | After | Change |
|---|---|---|---|---|
| `GraphicsWebGLRenderer` | Phaser (Graphics pipeline) | 588.4 ms / 0.97 % | 333.6 ms / 0.55 % | **− 43 %** |
| `batch` (both entries summed after) | Phaser (batch submission) | 628.3 ms / 1.04 % | 182.2 ms / 0.30 % | **− 71 %** |
| `renderWebGLStep` | Phaser (render step) | 564.5 ms / 0.93 % | 545.4 ms / 0.90 % | − 3 % (noise) |
| `ContainerWebGLRenderer` | Phaser (container render) | 987.0 ms / 1.63 % | 1167.6 ms / 1.93 % | **+ 18 % — did not fall** |

The after profile's top rows also carry the cheap sprite path the atlas feeds —
`ImageWebGLRenderer` 129.6 ms / 0.21 % with its matrix helper `GetCalcMatrix`
130.0 ms / 0.22 % — plus three Graphics render-node `run` entries (0.58 %,
0.40 %, 0.30 %): the residual per-frame Graphics work is the player ship, muzzle
flashes and the shield/force-field bubbles, not asteroid bodies. The hottest
project functions are unchanged and small — `GymFormationScene.tick` 0.40 %,
`CombatScene._handleCollisions` 0.12 % — so the frame is still not
simulation-bound.

**Read the numbers this way:**

- **The frame time is identical because both halves sit on the vsync step.**
  200 rocks + 12 firing enemies hold p50 = 16.7 ms, 60.00 effective FPS and zero
  long frames before *and* after; the after run's p95 is 16.7 ms in run 1 and
  16.8 ms (one vsync quantum) in run 2. A hardware GPU at 60 Hz absorbs the
  saved main-thread time, so the change is read from the attribution below, not
  from p50/p95 — exactly as the before half predicted.
- **The cost the change targeted fell measurably.** The `renderer` bucket is
  **18.5 % smaller** (9.34 % → 7.61 %) and main-thread JS 15.2 % smaller, with
  the freed 1.87 pp of the window going to `idle`. Inside the bucket the two
  symbols that *were* the per-rock path collapsed: `GraphicsWebGLRenderer`
  − 43 % (the per-frame `Graphics` fallback the 64-texture cap used to force) and
  `batch` − 71 % (200 separate texture submissions became one atlas bind).
- **`ContainerWebGLRenderer` did not fall, and that is recorded rather than
  claimed away.** Asteroids are still `Phaser.GameObjects.Container`s and are
  still walked one by one every frame (212 of them); the change shares one
  texture, it does not remove the per-rock container. It is now the largest
  single renderer entry and the remaining measured draw-submission cost — the
  exact shape of work that Option B (true GPU instancing, which bypasses the
  container render path entirely) would remove.
- **The load is the gym's deterministic one.** 212 = 200 rocks + 12 enemies in
  every sample of both runs, identical to the before half, so the pair compares
  the same field.

**Verdict (AC3, and the AC4 trigger).** On the reference hardware-GPU desktop
the asteroid field **meets the 60 FPS budget with the batched renderer in
place**: 200 rocks + 12 firing enemies run at 60.00 effective FPS / p50 16.7 ms
with zero frames over 33 ms, and the **minimal gate — no regression at the same
asteroid count — is met** (p50/p95, effective FPS, long-frame counts and the
212-rock load are all unchanged against the before half). The formal
`p95 ≤ 16.7 ms` bar is met in run 1 and missed by one vsync quantum (16.8 ms) in
run 2, the same quantised-vsync caveat the Electron desktop row records; no
frame-time win is claimed on this host, because there is none to claim.

What is claimed is the measured cost reduction: **`renderer` 9.34 % → 7.61 %
(− 18.5 %), main-thread JS 11.15 % → 9.45 % (− 15.2 %)**, with the per-rock
Graphics/batch submission path down 43 % / 71 % and 200 unique textures replaced
by one atlas. **AC4 is therefore not triggered:** neither the frame-time target
nor the no-regression gate is missed, so no Option B (true GPU instancing)
follow-up is filed. The measured remainder that would justify it —
`ContainerWebGLRenderer` 1.93 %, the per-rock container walk that did not fall —
is recorded here so a future scenario that regresses the budget can escalate
with evidence rather than an assumption.

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
| 10 | **Dev telemetry serialisation** (dev builds only) | `src/telemetry/sinks.ts` (`linesToNdjson`, `write`), `src/telemetry/devStreamProtocol.ts` (`splitNdjsonLines`), `src/telemetry/redact.ts:93` (`sanitiseObject`), `src/ai/botSnapshot.ts:459` (`deepFreeze`) | PlayScene demo run: ≈ 0.7 % [≈ 7 % of JS] | **Done** — the dev streamer builds each part from a bounded window and defers it off the rAF task: the whole-buffer `splitNdjsonLines`+`linesToNdjson` serialisation 2.55 % → 0.46 % of JS (see [Dev telemetry off-frame and bounded windows](#dev-telemetry-off-frame-and-bounded-windows-ah-0mwdfajac005r3ni)) | AH-0MWDFAJAC005R3NI (high) |
| 11 | **One `Graphics` object per enemy body**, re-walked, re-tessellated and re-batched every frame for a silhouette that never changes | `src/entities/BaseEnemy.ts` (`addSharedGraphics`), each archetype's `_drawBody()`, `src/entities/Phaser.ts` (ring + core) | **≈ 9.5 % of the 4× mobile window** (≈ 47 % of JS): `GraphicsWebGLRenderer` 3.6–3.9 %, `batch` 2.7–2.9 %, Graphics render-node `run` ×3 2.8–3.2 % | **Done** — every body silhouette is baked once into a cached texture and drawn as one sprite; Graphics-pipeline self time **9.5 % → 2.8 %** (see [Baked enemy body textures](#baked-enemy-body-textures-ah-0mw2iryah0055wcn)) | AH-0MW2IRYAH0055WCN (high) |

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
- **The hardware-GPU profile (AH-0MW2IRYJ2006PV3P) re-ordered nothing.** On the
  RTX 3050 Ti the same scene attributes JS 14.40 % / simulation 2.40 % /
  renderer 11.77 % (browser) and 12.99 % / 2.05 % / 10.75 % (Electron), against
  14.75 % / 1.00 % / 13.69 % on SwiftShader: the draw-submission dominance and
  the "simulation is the cheap part" finding survive the backend change, so no
  row above moves. What changes is the consequence — with 78.6–81.5 % of the
  main thread idle, none of these levers is needed for the desktop budget. See
  [Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline).

### Per-frame HUD rows (AH-0MVXV0FFJ0066EC8)

**`Recorded:`** commit `5a6905b7` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1× · AH-0MVXV0FFJ0066EC8.

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

### Dev telemetry off-frame and bounded windows (AH-0MWDFAJAC005R3NI)

**`Recorded:`** commit `ebbcda40` · 2026-11-12 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1× · AH-0MWDGQ1YD007V7DO
(verification child of AH-0MWDFAJAC005R3NI).

Ranked hotspot **#10** was the dev-only telemetry recorder paying the
whole-buffer serialise+redact cost inside the frame loop. The fix
(AH-0MWDGQ0PB000YZ9N / AH-0MWDGPZL8005QU13) builds each streaming part from a
**bounded window** (a ~2 MiB byte budget plus a 4096-record ceiling) and
**defers part build+send off the Phaser update/rAF task** through an injectable
scheduler, so the whole unconfirmed backlog is never re-split and re-joined
synchronously on the main thread. Redaction is untouched — the invariant that
no unredacted payload reaches a sink is exactly the same, and its per-tick cost
stays.

The paired measurement below is the **PlayScene late-game demo** run from
[PlayScene late game](#playscene-late-game-supplementary) —
`--setup '{"demo":true,"seed":1,"startLevel":10}'`, 60 s, dev recorder and
streaming upload enabled (the stock dev build) — profiled before (`1e1b26ba`)
and after (`ebbcda40`) the fix. Share is of JS, with the window share appended:

| Metric | Before (`1e1b26ba`) | After (`ebbcda40`) | Change |
|---|---|---|---|
| `splitNdjsonLines` (whole-buffer split) | 1.10 % / 0.070 % | **below the profile cut** | gone |
| `linesToNdjson` (whole-buffer join) | 1.45 % / 0.090 % | **0.46 % / 0.010 %** | **−68 %** |
| **Dev streaming serialisation (`splitNdjsonLines` + `linesToNdjson`)** | **2.55 % / 0.160 %** | **0.46 % / 0.010 %** | **−82 % of JS** |
| Redaction (`sanitise` + `sanitiseObject` + `isSensitiveTelemetryKey`) | 3.14 % / 0.190 % | 2.88 % / 0.090 % | unchanged (invariant) |
| All `src/telemetry/*` self time | 8.42 % / 0.520 % | 6.77 % / 0.210 % | −60 % of window |
| main-thread JS (share of window) | 6.08 % | 3.15 % | — |

The dev streaming serialisation — the cost the parent item targeted — is
**materially lower**: the whole-buffer split is gone and the join is 68 %
smaller, an 82 % drop in JS share. The remaining telemetry share is the
per-tick redaction and record write, which the redaction invariant keeps on
purpose.

**Frame time (paired before/after, 60 s PlayScene late-game demo).** The fix
does not regress the frame; it removes the frame-loop stalls the whole-buffer
split/join produced:

| Run | Host load | p50 (ms) | p95 (ms) | max (ms) | Effective FPS | Frames > 33 ms | Enemies peak/mean | Enemy bullets peak/mean |
|---|---|---|---|---|---|---|---|---|
| before (`1e1b26ba`) | 11.82 | 16.7 | 33.4 | 316.6 | 45.26 | 454 (16.7 %) | 1308 / 164.3 | 217 / 21.4 |
| after (`ebbcda40`) | 5.97 | 16.7 | 16.8 | 199.9 | 53.52 | 104 (3.2 %) | 1270 / 754.4 | 216 / 124.3 |

p95 falls from 33.4 ms to 16.8 ms and the > 33 ms long-frame share from
16.7 % to 3.2 %, with a **higher** mean enemy count in the after run — the
frame-loop stalls this item removes were the telemetry serialisation, not the
enemy load. A companion dev demo run (`scripts/verify-dev-telemetry-raf.mjs`,
boss run to victory, recorder + streaming on) asserts **zero
`requestAnimationFrame` handler invocations ≥ 200 ms** — observed max 45.7 ms
across 581 handlers, mean 1.2 ms, well below the bar.

**Verdict.** The dev telemetry recorder no longer stalls the frame loop: the
whole-buffer serialise cost is gone from the rAF task, the measured
streaming-serialisation share is 82 % lower, and the late-game demo frame time
improves with no regression. Redaction is unchanged.

### Cached bullet textures (AH-0MW2DAY2L004QSKF)

**`Recorded:`** commit `ba4e5360` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 1×, with a separate 4× mobile-tier
check · AH-0MW2DAY2L004QSKF.

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
redraw survives (AC2). The remaining boss-pattern `Graphics` redraws — bullet-free expanding effects that are not silhouettes — are covered on the flanks of this pass by the bullet/fx budget below. The Boss pulse wave (a slowly expanding ring) became a
sprite of the cached `ring` texture grown by scale and faded by alpha.
Gameplay, collision, RNG and `tick(dt)` determinism are untouched.

> **Revision (AH-0MW80W5ER005E884).** The scaled sprite was itself the source
> of a reported visual artefact: a 3 px stroke baked at radius 30 and
> magnified up to ~37× on a 1920×1080 screen reads as a ~110 px blurry,
> stair-stepped band at the edge of the wave's range. The wave is now the
> **single documented exception** to the cached-texture policy: it is a
> per-frame stroked circle on one `Phaser.GameObjects.Graphics`, redrawn at
> the current radius with a **constant 3 px stroke** and never scaled, so it
> stays crisp at every radius up to
> off-screen, and it fades smoothly to zero at its range limit. This is still
> **one cheap draw** (a single arc per frame — no per-bullet re-triangulation,
> so the AH-0MW2DAY2L004QSKF budget holds), and it also fixes the lifecycle
> leak where a superseded wave was left frozen on the display list: exactly
> one live wave exists per boss, destroyed on supersede, on range exit and on
> boss destroy.

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

### Baked enemy body textures (AH-0MW2IRYAH0055WCN)

**`Recorded:`** commit `da8aaa8f` · 2026-11-04 · headless Chromium 140
(SwiftShader software WebGL) · CPU throttle 4× (the mobile tier), 60 s paired
runs · AH-0MW2IRYAH0055WCN.

Ranked hotspot **#11** (and the material remainder of hotspot #1 after the
projectile cache landed): every regular enemy drew its silhouette into its own
`Phaser.GameObjects.Graphics`, and Phaser re-walked that command buffer,
re-tessellated every stroke (`StrokePath` → `batch`, earcut for fills) and
re-batched it on **every frame** — for a shape that never changes after
construction. At 100 enemies that is 119 non-empty `Graphics` objects per frame
(one body each, plus the Phaser's ring and core).

**Attribution (AC1 — measured, not guessed).** A 30 s profiled
`GymPerformance` run at `--cpu-throttle 4` (load 7.26, 24.65 FPS, mean 40.57 ms)
attributes the window as `renderer` **19.39 %** (JS total 23.85 %), `native`
75.27 %, `simulation` 3.97 %. Inside the renderer bucket, as share of the
window:

| Symbol | Share | Called from |
|---|---|---|
| `GraphicsWebGLRenderer` | **3.92 %** | `renderWebGLStep` 3.42 %, `ContainerWebGLRenderer` 0.39 % |
| `batch` | **2.92 %** | Graphics render-node `run` 2.89 % |
| Graphics render-node `run` ×3 (stroke 1.87, fill 0.90, other 0.47) | **3.24 %** | `GraphicsWebGLRenderer` |
| `GetCalcMatrix` | 0.32 % | `GraphicsWebGLRenderer` 0.31 % |
| `earcutLinked` + `linkedList` | 0.39 % | Graphics fill node |
| `ContainerWebGLRenderer` | 1.06 % | `renderWebGLStep` |
| `ImageWebGLRenderer` + its two `run` nodes | ≈ 1.4 % | the ~210 live enemy bullets (already cached textures) |

The Graphics pipeline is therefore **≈ 11.3 % of the 4× window (≈ 47 % of
all JS)**, and every sample of it comes from an object that redraws per frame.

**Ablation (per object type).** Each variant is a 20 s run at 4× with one
renderable group hidden; the host load moved (10.3 → 15.0) so only the JS
attribution — which is load-robust, see [Where the frame time
goes](#where-the-frame-time-goes) — is read across rows:

| Ablation | `renderer` | JS | Δ renderer |
|---|---|---|---|
| control | 20.96 % | 27.09 % | — |
| every enemy **body** `Graphics` hidden | **15.36 %** | 21.53 % | **− 5.6 pp** |
| every enemy **bullet** `Image` hidden | 21.46 % | 26.94 % | ≈ 0 |
| shared **background** layer hidden | 20.67 % | 25.96 % | ≈ 0 JS |
| bodies **and** bullets hidden | 13.83 % | 20.61 % | − 7.1 pp |

So the body is the material remaining per-frame `Graphics` submission, the
bullets are already effectively free, and the whole enemy+bullet
draw-submission surface is only ≈ 6.5 pp of the window — the simulation
(≈ 6 pp) dominates the rest. For scale, `GymPlayer` (one `Graphics`, no
enemies) at 4× runs **40.97 FPS / 24.4 ms mean** with 21.6 ms/frame of
`native`: the scene's non-enemy floor on this host is ≈ 24 ms/frame.

**What changed.** A silhouette is a pure function of the commands the subclass
queued in `_drawBody()`, so it is baked **once per distinct silhouette** into a
Phaser canvas texture (`src/utils/enemyBodyTextures.ts`) and every enemy with
that silhouette renders as one plain sprite. The seam lives once, in the shared
base class (`BaseEnemy._addStaticBodyLayer`) and in `PhaserEntity` for its
ring+core composite, so every gym and `PlayScene` run the same code (see
[`docs/GYM_PARITY.md`](GYM_PARITY.md#shared-enemy-body-texture-cache-ah-0mw2iryah0055wcn)).
The bake renders the **same command buffer** through Phaser's own canvas
Graphics renderer with only a centring translation added, so the silhouette is
identical by construction and only *when* it is drawn changes. The cache is per
game, keyed by a pure hash of the drawn commands and the extent (identical
silhouettes share one texture, different ones never collide) and bounded to 64
textures, so a stream of unique silhouettes (each asteroid's seeded polygon)
cannot grow it without limit. A scene that cannot create canvas textures keeps
the `Graphics` body — the pre-change path.

**Per-symbol result (paired 60 s runs, 4×, `--profile`, same host).**

| Symbol (share of the window) | Before (2 runs) | After (2 runs) | Change |
|---|---|---|---|
| `GraphicsWebGLRenderer` | 3.60 % / 3.89 % | 1.49 % / 1.28 % | **− 62 %** |
| `batch` | 2.70 % / 2.89 % | 0.73 % / 0.66 % | **− 75 %** |
| Graphics stroke node `run` | 1.61 % / 1.91 % | 0.45 % / 0.40 % | **− 76 %** |
| Graphics fill nodes (`run` ×2) | 0.78 % / 0.91 % + 0.41 % / 0.42 % | 0.14 % / 0.15 % (one), below the top-14 cut (other) | **− ≥ 80 %** |
| `GetCalcMatrix` (Graphics path) | 0.35 % | below the top-14 cut | gone |
| **Graphics-pipeline self time (sum)** | **9.45 % / 10.44 %** | **2.81 % / 2.49 %** | **− 70 % / − 76 %** |
| `ContainerWebGLRenderer` (one container per enemy) | 1.26 % / 1.36 % | 1.41 % / 1.41 % | unchanged (by design) |
| `ImageWebGLRenderer` + `run` ×2 (bullets) | 1.93 % / 1.83 % | 2.15 % / 2.26 % | unchanged (bullets untouched) |

The remaining `GraphicsWebGLRenderer` is the player ship's per-frame thrust
flames, the transient muzzle flashes, the shield/force-field/thorn bubbles and
the Phaser tell layer — each one object, inside the noise floor.

**Bucket result and frame time (paired, interleaved, 60 s, 4×).**

| Run | Host load | p50 (ms) | p95 (ms) | mean (ms) | Effective FPS | JS (% window) | `renderer` | `native` |
|---|---|---|---|---|---|---|---|---|
| before 1 | 10.64 | 33.4 | 50.1 | 41.41 | 24.15 | 21.00 | 18.55 | 78.26 |
| after 1 | 12.41 | 33.4 | 50.1 | 40.63 | 24.61 | **16.06** | **12.40** | 83.42 |
| before 2 | 11.94 | 33.4 | 50.1 | 38.35 | 26.07 | 23.65 | 19.65 | 75.49 |
| after 2 | 13.01 | 33.4 | 50.1 | 41.19 | 24.28 | **15.64** | **12.03** | 83.85 |

Main-thread JS falls **22.3 % → 15.9 % of the window (− 29 %)** and the
renderer bucket **19.1 % → 12.2 % (− 36 %)**, reproducibly across both pairs.
The frame time does **not** move: p50/p95 are identical (33.4 / 50.1 ms) and the
mean is inside the run-to-run spread for this load band — the freed main-thread
time moved into `native` (76.9 % → 83.6 %), i.e. into SwiftShader
rasterisation, exactly the backend caveat the [cached bullet
textures](#cached-bullet-textures-ah-0mw2day2l004qskf) section records. A baked
body quad also rasterises its full bounding box (mostly transparent) where the
`Graphics` stroke only filled a thin band, so part of the JS win is *paid back*
as raster work on a CPU rasteriser.

**Verdict.** The measured #11 hotspot is removed (Graphics-pipeline JS
− 70–76 %, renderer bucket − 36 %) for no gameplay change. The mobile-tier
target (**AC3: ≥ 30 FPS at 4×**) is **not met**: 24.3–24.6 FPS against the
30 FPS bar. The lever this item owns cannot close the gap — the whole
enemy+bullet draw-submission surface is ≈ 6.5 pp of the window, and the frame
time is set by software rasterisation on this GPU-less host. Recorded and
escalated rather than hidden; the same JS win is the half a hardware GPU does
**not** absorb, so it is expected to pay off on the real-GPU verification
(AH-0MW2IRYJ2006PV3P).

**Visual parity (checked, not assumed).** The baked sprite is verified to land
on the enemy's own origin: sampling the rendered canvas per formation slot, the
silhouette's bounding-box centre equals the slot centre exactly (e.g. slot
`(183, 80)` → bbox centre `(183.0, 80.0)`; `(513, 114)` → `(513.0, 114.0)`)
at the same ~25 px span the `Graphics` body drew. Pinned in code by
`src/entities/BaseEnemy.bodyTexture.test.ts` (one cached sprite per enemy, one
shared texture per silhouette, a distinct texture per colour, the ring+core
composite, and the `Graphics` fallback) and
`src/utils/enemyBodyTextures.test.ts`.

**Determinism (AC4).** `node scripts/evaluate.mjs --seeds 3 --ticks 1800 --json`
on the changed tree reproduces the recorded outcome hashes exactly —
`e124cb60`, `6f5f6865`, `85729723` (scores 31.3 / 44.3 / 22.3) — so
`tick(dt)`, RNG consumption and collision resolution are unchanged.

### Collision broad phase (AH-0MVXV0EMF001WVQ1)

**`Recorded:`** commit `40f6dce4` · 2026-11-04 · the Node/vitest fixture below (no
browser, no GPU, no frame times) · CPU throttle not applicable — the recorded
figures are candidate-pair counts, not milliseconds · AH-0MVXV0EMF001WVQ1.

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

**`Recorded:`** commit `d2878b60` (the "before" row is its parent,
`40f6dce4`) · 2026-11-04 · headless Chromium 140 (SwiftShader software WebGL) ·
CPU throttle 1× · AH-0MVXV0F0Y004NENT.

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

**`Recorded:`** commit `d2878b60` · 2026-11-04 · desktop browser (headless
Chromium 140, SwiftShader), Electron 45.2.2 (SwiftShader GPU process) and the
mobile tier (the browser host under throttle) · CPU throttle 1× / 4×, per
row · AH-0MVXV6VOI006P7VG.

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

Every row is measured against commit `d2878b60` (2026-11-04) on the reference
machine below; the change's own commit is listed, because that is the commit
the after-number describes.

| Work item | Commit | What it changed | Measured before → after (same harness/host) | Frame-time claim |
|---|---|---|---|---|
| AH-0MVXV0FFJ0066EC8 | `5a6905b7` | HUD rows rebuilt only when the rendered state changes | armed `GymPowerUpsCombat` JS **9.06 % → 5.44–5.79 %**; row symbols (`texImage2D`, `save`, `preDestroy`, `updateText`, …) gone from the profile | None at the 100-enemy budget — the stress gym renders no rows |
| AH-0MW2DAY2L004QSKF | `ba4e5360` | Bullet silhouettes baked once into cached textures (Image draws) | `renderer` bucket **14.77 % → 6.97 %**, main-thread JS **16.24 % → 8.09 %**, `GraphicsWebGLRenderer` −68.5 %, `batch` −63.9 %, earcut gone | None on SwiftShader — the freed JS time moved into `native` rasterisation; that half is absorbed by a real GPU |
| AH-0MVXV0EMF001WVQ1 | `40f6dce4` | Player bullets indexed in the shared uniform-grid broad phase | bullet-vs-bullet candidates **90 000 → 699** at 300 × 300 (128.8×) | None at the budget load — the pass was microseconds with no player bullets; structural at higher bullet counts |
| AH-0MVXV0F0Y004NENT | `d2878b60` | Per-frame transient arrays replaced by reused buffers | GC bucket **0.21 % → 0.21 %**; JS/simulation/renderer within 0.22 pp | None measurable — GC was never the limiting resource at this load; structural |
| AH-0MW2DB9VN006XB63 | `03f11377` | Electron desktop host + software-rasteriser baseline | browser p50 33.3 ms → **Electron p50 16.7 ms** on the same commit and rasteriser | The desktop vsync step, on the desktop host |
| **AH-0MVXV6VOI006P7VG** (this) | `d2878b60` | Final measurement, parity and determinism evidence | **aggregate** of the two JS wins: baseline JS 14.75 % / renderer 13.69 % → **JS 8.13 % / renderer 6.90 %**; mobile 4× **19.92 → 24.21 FPS**; Electron holds **p50 16.7 / p95 16.8** | Structural wins confirmed; see the verdicts below |

Two structural suspects were measured and closed as **not material** rather than
"optimised": the collision pass (0.02 % of the window with no player bullets)
and per-frame allocations (0.21 % GC). Both changes are kept for scaling and
for a garbage-free hot loop, and neither claims a frame-time win.

### Verdicts

1. **Desktop browser — not a pass on this host, and not a verdict on the game.**
   37.03 FPS with 91.53 % of the window in `native`: the frame time is set by
   **SwiftShader rasterising on the renderer main thread**, which is a property
   of this GPU-less host (see [Hardware-GPU desktop
   baseline](#hardware-gpu-desktop-baseline)), not of the
   simulation, which is 1.12 % of the window. **Follow-up result
   (AH-0MW2IRYJ2006PV3P):** on the hardware GPU the same tree holds
   **59.95–60.00 FPS** at p50 16.7 / p95 16.7–16.8 ms with 78.6 % of the main
   thread idle, so the desktop browser target is met — the earlier 37 FPS row
   was the software rasteriser, exactly as read above.
2. **Desktop Electron — at the 60 FPS step, one tenth of a millisecond short of
   the formal bar.** p50 16.7 ms / p95 16.8 ms is the vsync step at 100 enemies
   with live fire, 0.70 % of frames > 33 ms (no sustained long-frame spike); the
   effective 54.76 FPS is dragged down by 20 isolated stalls > 50 ms on a host
   at load 12.58. `p95 ≤ 16.7 ms` is missed by 0.1 ms, so this is recorded as
   *at the budget on a software rasteriser*, not as a formal pass. **Follow-up
   result (AH-0MW2IRYJ2006PV3P):** the hardware-GPU Electron run holds
   **59.99–60.00 FPS** at p50 16.7 / p95 16.7 ms with **zero** frames over
   33 ms in one run and one in the other, which is the confirmation that turns
   it into one ([Hardware-GPU desktop
   baseline](#hardware-gpu-desktop-baseline)).
3. **Mobile tier — target missed on the software rasteriser, met on hardware WebGL.**
   The 4× row measures 24.21 FPS against the ≥ 30 FPS bar on **SwiftShader**,
   this host's CPU-rasteriser floor, which is not a verdict on the mobile
   target: the same tier on the host's hardware GPU holds 46.85–59.44 FPS — see
   [Hardware-WebGL mobile tier](#hardware-webgl-mobile-tier-4-cpu-throttle).
   The software row is a real improvement over the recorded 19.92 FPS baseline
   (+21.5 %; the 4× `renderer` bucket fell from 33.51 % to 18.87 % of the
   window), but it is not the target on that backend.
   The remaining cost is draw submission (`renderer` 18.87 % of the window,
   84.91 % of JS) on top of software rasterisation (`native` 76.92 %).
   Escalated as **AH-0MW2IRYAH0055WCN** with the measured hotspot shares, and
   the parent (AH-0MVWJQUN6009IS87) is left short of `in_review`.
   **Follow-up result (AH-0MW2IRYAH0055WCN):** the remaining per-frame
   `Graphics` submission was attributed and removed — enemy body silhouettes
   are now baked into cached textures, taking the Graphics-pipeline JS from
   ≈ 9.5 % of the 4× window to ≈ 2.8 % (renderer bucket − 36 %). The mobile
   tier is **still short of 30 FPS (24.3–24.6 FPS)**: the whole enemy+bullet
   draw-submission surface is ≈ 6.5 pp of the window and the frame time is set
   by software rasterisation on this host — see [Baked enemy body
   textures](#baked-enemy-body-textures-ah-0mw2iryah0055wcn).
   **Follow-up result (AH-0MW3KP1R90030QY9):** the same 4× tier re-measured on
   the host's **hardware GPU** holds **59.44 FPS** inside the documented load
   band (46.85–53.77 FPS at load 16–23), so the mobile target is **met under
   the hardware proxy** — the 24 FPS rows were this host's software
   rasteriser, exactly as the attribution said. See [Hardware-WebGL mobile
   tier](#hardware-webgl-mobile-tier-4-cpu-throttle), which states the verdict
   for parent AC5.

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
  **Outcome:** the draw-submission half was removed (enemy bodies baked to
  cached textures; Graphics-pipeline JS − 70–76 %, renderer bucket − 36 %),
  and the mobile tier is still 24.3–24.6 FPS on the software backend. The
  residual gap is rasterisation, not draw submission — see [Baked enemy body
  textures](#baked-enemy-body-textures-ah-0mw2iryah0055wcn).
  **Resolution (AH-0MW3KP1R90030QY9):** re-measured on the host's hardware GPU
  at the same 4× throttle, the tier holds 46.85–59.44 FPS against the ≥ 30 FPS
  bar, so the residual was the software rasteriser and no further
  draw-submission work is justified by this evidence — see [Hardware-WebGL
  mobile tier](#hardware-webgl-mobile-tier-4-cpu-throttle).
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
| Browser | Playwright 1.55.1 Chromium — **headless** with software WebGL via `--enable-unsafe-swiftshader` for the baseline rows; Chromium 140.0.7339.186 headless on hardware ANGLE-Vulkan for the [hardware-GPU rows](#hardware-gpu-desktop-baseline) |
| Desktop host (Electron) | software rows: electron 45.2.2 (Chromium 156.0.8078.80), `--ozone-platform=headless`, SwiftShader over the GPU process; hardware rows: electron 45.2.3 (same Chromium), hardware ANGLE-Vulkan |
| WebGL renderer | software rows: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`; hardware rows: `ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0)), NVIDIA)` — the backend actually used is recorded in every report under `webgl` |
| GPU access | NVIDIA GeForce RTX 3050 Ti Laptop GPU, driver 595.99.02, reached through the `/dev/nvidia*` nodes (mode `666`) by the non-root measuring user. `/dev/dri` render nodes are `root:render` mode `660` and are not needed on that path; they remain unreadable in a session that predates the `video`/`render` group change |
| Node | v22.22.1 |

Hosts run with a software
WebGL backend under the `--host browser` baseline rows, which is *reproducible*
but is not the hardware raster path. The browser baseline in this document is
therefore the **headless-shell SwiftShader floor** — use it to compare runs of
the *same* harness on the *same* host, and do not read it as the desktop budget
being missed on real hardware. The Electron rows in
[Electron baseline](#electron-baseline-software-gpu-process-rasteriser) are the
desktop host on the same backend, and they show the budget being met there. The
**hardware-GPU** rows for both hosts are recorded in
[Hardware-GPU desktop baseline](#hardware-gpu-desktop-baseline).

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
