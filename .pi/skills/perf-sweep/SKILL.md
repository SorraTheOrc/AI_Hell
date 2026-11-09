---
name: perf-sweep
description: >-
  Run and interpret the 50-enemy performance sweep for AI Hell: walk the enemy
  load up in 50-enemy steps with a seeded representative loadout and a varying
  shoot/dive mix until a step's average FPS drops below 30, then report the
  playable ceiling and a machine-readable verdict. Use when someone asks how
  many enemies the game can hold at a playable frame rate, or when a
  reproducible sweep needs recording or re-running.
---

# perf-sweep — the 50-enemy FPS sweep

The repository can measure one fixed load with `npm run perf:measure -- --scene
GymPerformance --seconds 60` (the 100-enemy stress gym), but that does not
answer "how many enemies can we actually hold at a playable frame rate?".
`perf-sweep` answers it deterministically: it walks the enemy load upward in
50-enemy steps, measures each step once with a seeded, representative player
loadout and a varying shoot/dive enemy mix, and stops at the first step whose
average FPS is below 30. One command produces the headroom curve (min /
average / max FPS per load) as a per-step table plus a headline verdict, with
the same data written to a machine-readable JSON report.

This skill documents the sweep: what it measures, the load definition, the
measurement window, the stop rule, how to run it, how to read the result, and
what not to do with it.

## What the sweep measures

- **Enemies that shoot *and* dive.** Every step fields the six late-game firing
  archetypes of the stress gym — `tank`, `swarm`, `phaser`, `diver`, `raider`,
  `march` — created by the shared `createEnemyFromConfig` factory and firing
  through the shared `fireForEnemy` dispatcher. The `diver` archetype dives;
  the other five shoot. Enemies are **not** invulnerable: the player's fire
  can kill them, so the live enemy count decays within a step and the step's
  `count` is the peak/target load (the live counts are recorded).
- **The player fires.** Auto-fire is on with the step's loadout, so the
  measured frame cost includes the player's own bullets and kills. Minerals are
  off (`minerals: false`).
- **As-played, deterministic mode.** One seed for the whole run and a fixed
  per-step duration: the same seed reproduces the same loadout sequence and the
  same shoot/dive mixes. The seed is recorded in the report.

## The load definition

- **Steps of 50 enemies** — start at 50, then 100, 150, … up to a hard
  ceiling of 400 (`SWEEP_COUNT_CEILING`).
- **A semi-random, representative loadout** per step, built through the shipped
  seams and recorded with the step (ids *and* levels):
  - the permanent `cannon` is always the base weapon;
  - one weapon from **each** broad category — projectile (`spread`, `dual`,
    `rapid`), beam (`wave_laser`), area-of-effect (`nova`, `mortar`, `arc`)
    and exotic/positional (`ricochet`, `cluster`, `options`, `rear_guard`,
    `broadside`, `railgun`, `shard_swarm`, `heavy_slug`);
  - **at least one power-up** from `POWER_UP_CATALOGUE`;
  - the remaining slots are filled with seeded picks, capped at the shipped
    six-slot limit (`POWER_UP_SLOT_CAP = 6`);
  - **levels are not maxed.** A weapon/power-up is granted at the
    *representative level* of the campaign level a hex of the configured
    `--aggression` deploys at: campaign level 1 → upgrade level 1, campaign
    `MAX_LEVEL` (10) → level 7 (`REPRESENTATIVE_LEVEL_MAX`), monotone in
    between. Even the strongest aggression therefore fields a strong-but-not-
    maxed late-game player.
- **A varying shoot/dive mix** per step: the `diver` share is drawn seeded per
  step in `[0.2, 0.5)`, so the mix varies across the sweep while always
  containing both behaviours. The roster is fixed at step setup, so the load is
  constant for that step's measurement window.

## The measurement window

Each step measures for **at least 15 seconds** (`--seconds`, minimum enforced,
default 15). A 5-second warm-up (`--warmup`, default 5) lets the scene settle
before the window and is **excluded** from the measured time — the warm-up is
reported per step. The run budget counts warm-up + window, because both are
real wall-clock cost. Per step the harness records **min, average and max FPS**
alongside the frame-time percentiles (p50/p95), long-frame counts and the live
enemy/bullet counts sampled through the shared `CombatScene` counts seam.

## The stop rule

- A step whose **average FPS is strictly below 30** is the sweep's **failure
  point**; exactly 30 FPS is still playable.
- The **previous step is the last playable load**.
- A **hard ceiling** (400 enemies, `--ceiling`) and a **total-run budget**
  (30 minutes, `--budget`) stop a runaway sweep when no step ever fails.

## How to run it

Prerequisite: the Playwright Chromium build (`npm run capture:install`), the
same prerequisite the `perf:measure` harness needs.

```bash
npm run perf:sweep                                  # defaults: seed derived, aggression 5
npm run perf:sweep -- --seed 42 --aggression 6      # reproducible runs
npm run perf:sweep -- --ceiling 200 --budget 60     # bound the run
npm run perf:sweep -- --json                        # verdict JSON on stdout instead of the table
npm run perf:sweep -- --out perf-output/my-sweep.json
npm run perf:sweep -- -h                             # usage text (also --help)
```

`npm run perf:sweep` runs `node scripts/perf-sweep.mjs`. It starts the Vite
dev server itself, launches headless Chromium through Playwright, switches to
the parameterised stress gym, and walks the steps — no manual load selection.

Options (from the driver's own usage text):

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

Exit codes: `0` a completed sweep, `1` a failed run (e.g. a failed measurement
— no partial verdict is published), `2` a usage error.

## How to read the result

The human output is the **headline verdict** plus one row per step:

```
[sweep] playable to 100 enemies; first failure at 150 with average 28.4 FPS
[sweep] step  enemies  dive %  min FPS  avg FPS  max FPS  verdict
[sweep]  0       50     32%     58.2     60.3     61.9  playable
[sweep]   loadout: cannon, spread L3, wave_laser L3, mortar L3, ricochet L3, heal L3
[sweep]   report: perf-output/step-050.json
[sweep]  1      100     41%     55.1     57.8     59.4  playable
[sweep]   loadout: cannon, dual L3, nova L3, options L3, railgun L3, beam L3
[sweep]   report: perf-output/step-100.json
[sweep]  2      150     27%     26.9     28.4     30.1  failure
[sweep]   loadout: cannon, rapid L3, arc L3, broadside L3, shard_swarm L3, spread L3
[sweep]   report: perf-output/step-150.json
[sweep] verdict: perf-output/sweep-<ts>.json
```

- **Columns** — step index, target enemy count, the step's `diver` share
  (dive %), min / average / max FPS, and the verdict (`playable` or
  `failure`). A `failure` row stops the table.
- **Headline** — with a failure: `playable to N enemies; first failure at M
  with average X FPS`. Without one: `playable to N enemies; no failure within
  the sweep` (ceiling stop) or `… no failure before the run budget` (budget
  stop).
- **Loadout line** — the base weapon plus every granted weapon/power-up with
  its level, exactly what was measured.
- **JSON report** (`--out`, default under `perf-output/`) — the machine-
  readable verdict naming the scene, seed, aggression, CPU throttle, started
  time, **host** and **commit**, the step list, each step's loadout *and
  levels*, shoot/dive mix, min/average/max FPS, the raw harness `counts` and
  `webgl` blocks, the per-step raw report path and the verdict. The per-step
  raw harness reports (`perf-output/step-<NNN>.json`) carry the full
  frame-time distribution (p50/p95, long frames, live counts) the verdict
  summarises.

### Publishing a sweep — the provenance rule

`docs/PERFORMANCE.md` requires every published measurement to open with a
**`Recorded:`** line naming the **commit hash** the numbers describe, the
**date**, the **host/platform** and the **CPU-throttle factor** (enforced by
`src/performanceDocs.test.ts`). A published sweep must do the same, and the
JSON verdict already records host, commit, webgl backend, seed and started
time to make that line derivable. Compare numbers only within one host load
band — the noise-floor rule: the host load is part of the measurement, so a
sweep run while the host is busy is identifiable (host load per step) rather
than silently comparable.

## What not to do

- **Do not wire the sweep into the test suite.** It is a measurement tool, not
  a test run: it boots a browser, takes minutes, and is intentionally not part
  of the vitest suite and not run by the test skill.
- **Do not publish a noisy-host sweep.** Record the run conditions and the
  host; a sweep taken while other agents' suites are running must be
  identifiable, not silently published as a baseline.
- **Do not optimise inside this skill.** A hot spot or regression found by a
  sweep becomes its own work item (a `discovered-from:` child), per the
  parent's out-of-scope rule.
