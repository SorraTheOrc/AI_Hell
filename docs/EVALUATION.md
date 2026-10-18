# Same-seed evaluation harness

> Status: delivered by AH-0MUY08XLD009K4W4 (child 8 of epic
> AH-0MUY089KR003F8S4). Source: [`src/ai/eval/`](../src/ai/eval), CLI:
> [`scripts/evaluate.mjs`](../scripts/evaluate.mjs).

The evaluation harness is how we **re-run the bot's production code** after a
change and answer "is it better?" without a human in the loop. It runs a real
bot policy headlessly on fixed seeds, emits telemetry, aggregates metrics,
compares two bot versions (A/B) with a confidence interval, and compares the
bot against a recorded human run on the same seed. For **automated
balancing** — simulating hundreds of deterministic games against the real
balance data files and reading their aggregated statistics (minerals,
upgrades, kills per archetype, survival, wave reached) — see
[`docs/BALANCING.md`](./BALANCING.md).

## Why same-seed

The epic's determinism work (AH-0MUY08V6W001SJJN) made a run reproducible from
a single seed: every gameplay RNG draw comes from one seeded stream. The
evaluation harness leans on that — it generates a scenario **from the seed**
and runs the bot closed-loop, so:

- the same seed + policy always produces the same report (AC5);
- an A/B compares the two policies on **identical scenarios**, so the
  per-seed difference removes scenario variance (AC3).

## Quick start

```bash
# evaluate the competent bot over the default seeds 1..3
npm run evaluate

# evaluate five seeds and print the machine-readable report
npm run evaluate -- --seeds 5 --json

# automated balancing: 100 deterministic games, full balance report
npm run evaluate -- --batch

# a 300-game balance batch across two policies (see docs/BALANCING.md)
npm run evaluate -- --batch --games 300 --policies competent,legacy

# tune one balance value: baseline → edit boss health → identical re-run → compare
npm run evaluate -- --tune --set enemy-configs.csv boss.health=6 --games 100

# A/B the legacy ladder against the competent bot over 10 seeds
npm run evaluate -- --baseline legacy --candidate competent --seeds 10

# compare the bot against a recorded human run on the same seed
npm run evaluate -- --human recordings/human.jsonl --human-seed 42

# also emit the optional side-by-side capture/compose plan
npm run evaluate -- --human recordings/human.jsonl --video
```

Artifacts are written under `--out` (default `eval-output/`, git-ignored):

| Artifact | Contents |
|---|---|
| `report.json` | The deterministic evaluation or A/B report (stable JSON). |
| `runs.jsonl` | The raw telemetry for every run, in the shipped record schema. |
| `comparison.json` | Same-seed metric deltas (only with `--human`). |
| `ghost.svg` | The existing human-vs-bot trajectory overlay (only with `--human`). |
| `human-balance-report.json` | The shared versioned human `BalanceReport` (`kind: 'balance'`, `policy: 'human'` — only with `--human`). |
| `side-by-side.sh` / `side-by-side.json` | The capture/compose plan (only with `--video`). |

### Flags

| Flag | Meaning | Default |
|---|---|---|
| `--policy <name>` | Bot policy: `competent`, `competent-no-fallback`, `legacy`. | `competent` |
| `--baseline <name>` | A/B baseline policy (use with `--candidate`). | — |
| `--candidate <name>` | A/B candidate policy. | — |
| `--seed <n>` | A seed; repeatable. | — |
| `--seeds <count>` | Use seeds `1..count`. | `3` |
| `--ticks <n>` | Maximum ticks per run. | `1800` |
| `--dt <seconds>` | Fixed simulation step. | `1/60` |
| `--sample-every <n>` | Record every Nth tick (smaller artifacts). | `1` |
| `--out <dir>` | Artifact output directory. | `eval-output` |
| `--human <file.jsonl>` | Compare against a recorded human run (AC2). | — |
| `--human-seed <n>` | Which human run seed to compare. | last run |
| `--video` | Emit the side-by-side capture/compose plan (AC4). | off |
| `--json` | Print the report JSON instead of text. | text |
| `--tune` | Tune loop: baseline batch → one declarative CSV edit → identical re-run → compare (see `docs/BALANCING.md`). | off |
| `--set <file> <assignment>` | The single declarative edit for `--tune`, e.g. `--set enemy-configs.csv boss.health=6`. | — |
| `--threshold <pct>` | Relative significance threshold for `--tune`. | `10` |
| `--keep-edit` | Keep the `--tune` CSV edit after the run (default: restore). | off |

## How it works

```
seed ──► arena scenario ──► BotPolicy ──► AsteroidsModel + governor
                              │
                              ▼
                        telemetry records  (run_header / tick / event)
                              │
                              ▼
             scripts/recording-analysis.mjs  ──► metrics
                              │
                              ▼
             aggregate · same-seed compare · A/B confidence
```

- **Arena** (`src/ai/eval/arena.ts`) — a deterministic, seed-derived headless
  scenario. It models player Newtonian physics (the shipped `AsteroidsModel`),
  collectables, hostiles, auto-fire, enemy fire and collisions, and emits
  telemetry-shaped records.
- **Metrics** (`src/ai/eval/metrics.ts`) — pure aggregation over those records
  using the **existing** `scripts/recording-analysis.mjs`. A headless bot run
  and a recorded human game are therefore measured by exactly the same code.
- **Engine** (`src/ai/eval/engine.ts`) — `runEvaluation`, `runAbEvaluation` and
  `compareRecordings`.
- **CLI core** (`src/ai/eval/cli.ts`) — pure artifact/report construction; the
  Node shell (`scripts/evaluate.mjs`) does argv parsing and file I/O, loading
  the TS core through Vite's SSR module loader.

## Config-driven arena

The arena consumes the **real balance data** — no hardcoded `scout/diver/phaser`
list, fire cadence or ship config (config-driven arena,
AH-0MV81YPBG0028WNM, epic AC1):

- **Enemy archetypes** (`src/data/enemy-configs.csv` via `loadAllEnemyConfigs`)
  seed the spawn reservoir and drive each hostile's behaviour — collision
  radius (`size`), hit points (`health`), fire cadence (`fireInterval`),
  projectile speed (`bulletSpeed`) and fire chance (`shotProbability`).
- **Ship stats** (`src/data/ship-config.csv` via `loadShipConfig`) map onto the
  `AsteroidsModel` physics (thrust, max speed, friction, rotation).
- **Difficulty curves** (`src/data/difficulty-curves.csv` via
  `loadDifficultyCurves`) set how many hostile *waves* the reservoir holds
  (the opening level's row count), so a curve edit changes a run too.

A resolved balance config (`ArenaBalanceConfig`) is built by
`loadBalanceConfig()` in `src/ai/eval/balanceConfig.ts`; `runArena` accepts it
via `config.balance` and falls back to resolving it from the shared store, so
every arena path is config-driven. Because each hostile derives its stats from
an `EnemyConfig`, **editing the CSV files measurably changes simulated outcomes
for the same seed** — verified by `src/ai/eval/arena.test.ts` for
`shotProbability`, `fireInterval`, `health` and ship `maxSpeed`.

### SSR loading (evaluate.mjs)

The CLI runs the TS core through Vite's SSR module loader, where the dev-server
`/api/csv/...` endpoints have no browser origin. `scripts/evaluate.mjs` awaits
`hydrateBalanceConfig()` before evaluating, which under SSR (`import.meta.env.SSR`)
reads the CSVs bundled at build time — the same content the static build uses,
so a CSV edit immediately changes headless results. A missing/unreadable CSV
falls back to the built-in defaults (the store's `loadConfigs` never throws),
so evaluation can never be blocked by a broken config file
(`src/ai/eval/balanceConfig.ssr.test.ts` spikes the SSR branch).

## Metrics

The report carries the metrics the epic asks for, extracted from telemetry:

| Metric | Source |
|---|---|
| Survival time | `run_end` / duration between first and last tick |
| Minerals / min | the peak `state.hold.minerals` over the run |
| Power-ups | `pickup` event count |
| Enemies / asteroids destroyed | `enemy_killed` / `asteroid_destroyed` counts |
| Avoidable hits | `player_hit` event count |
| Input cadence | input-change rate and key-hold histogram |
| Dodge rate | threat windows without a recorded hit |
| Reaction latency | time from a threat entering range to the next input change |
| Target choice | category most aligned with the player's velocity |

The **objective score** combines them with the operator's priorities
(minerals 4, power-ups 3, enemies 2, asteroids 1, survival 0.01, each
avoidable hit −100). A higher score is better.

## A/B and confidence

`runAbEvaluation` pairs the two policies by seed and computes the per-seed
difference, so scenario variance cancels. It reports the mean difference and
its two-sided **95% confidence interval** (Student's t, small-sample
corrected), whether that interval excludes zero, and the per-seed win/tie/loss
tally.

- `candidate-better` / `baseline-better` — the 95% CI for the score difference
  excludes zero.
- `inconclusive` — the CI includes zero, or fewer than two paired seeds.

Use more seeds (`--seeds N`) to tighten the interval. The CI is a *directional
tuning signal*, not a proof; treat a significant score change as worth
investigating, then inspect the per-metric breakdown for *why* it changed.

## Same-seed human comparison

`--human recordings/human.jsonl` loads a recording produced by the existing
`npm run record` tool, selects the run with `--human-seed` (default: the last
run in the file), runs the bot on that same seed, and emits:

- `comparison.json` — the per-metric delta between the human and the bot; and
- `ghost.svg` — the existing human-vs-bot trajectory overlay from
  `scripts/recording.mjs` (no browser required).

This is the same comparison the recording tooling already supports, now
reproducible from a single command.

Because the human session is a real recorded game, `--human` also emits the
**shared balance statistics** for it: `human-balance-report.json` is a
versioned `BalanceReport` (`kind: 'balance'`) produced by the shared pure
helper `extractHumanBalanceStats` (`src/ai/eval/humanStats.ts`) and labelled
with the `human` pseudo-policy. It reuses the automated-balancing
framework's `extractBalanceStats` / `aggregateBalanceStats`, so the same
schema a bot batch (`--batch`) reports on is computed for the human run and
both artifacts are directly comparable — see
[docs/BALANCING.md](./BALANCING.md#human-play-statistics-policy-human). A
recording with multiple runs yields one per-run entry plus one aggregate,
mirroring a batch.

## Side-by-side video (optional)

`--video` does not re-implement capture. It emits a `side-by-side.sh` plan that:

1. captures the bot/demo clip with the existing
   `scripts/capture-gameplay.mjs`; then
2. composites it beside a recorded human clip with `ffmpeg -filter_complex
   hstack`.

Record the human clip with `npm run record`, pass it via `--human`, then run
the emitted script. `ffmpeg` is required only for this optional step; the
harness itself never invokes a browser or an encoder.

## Reproducibility

- The arena's run header fixes `startedAt` to `0` and every draw comes from the
  seed, so `report.json` and `runs.jsonl` are byte-stable for the same
  seeds/config/policy. Each run entry carries an FNV-1a hash of its raw records
  so drift is detectable.
- Verify with:
  ```bash
  npm run evaluate -- --seeds 3 --out /tmp/a
  npm run evaluate -- --seeds 3 --out /tmp/b
  diff /tmp/a/report.json /tmp/b/report.json
  ```

## Fidelity boundary and limitations

The arena is a **closed-loop headless model**, not Phaser: it models the
quantities the bot reasons about (player physics, collectables, hazards,
auto-fire, collisions) rather than the full wave/VFX/enemy-behaviour stack
(enemy formations, burst patterns and bullet lifetimes are intentionally not
modelled). Each hostile's radius, health, fire cadence, bullet speed and fire
chance do come from the shared `EnemyConfig`, so balance tuning is reflected
in the simulation. That keeps evaluation fast and deterministic under
Node/vitest. For pixel-accurate, full-stack verification use the browser
capture path (`npm run capture`); both paths feed the same telemetry schema,
so a recorded capture can be analysed with `npm run analyse`.

## Testing

- `src/ai/eval/arena.test.ts` — determinism, telemetry shape, parser
  round-trip; config-driven arena (CSV edits change outcomes, AC1/AC2/AC4).
- `src/ai/eval/balanceConfig.ssr.test.ts` — SSR config hydration spike (AC5).
- `src/ai/eval/metrics.test.ts` — objective score, aggregation, same-seed
  deltas, A/B confidence.
- `src/ai/eval/engine.test.ts` — end-to-end evaluation and A/B determinism.
- `src/ai/eval/report.test.ts` — stable serialisation and hashing.
- `src/ai/eval/video.test.ts` — side-by-side plan construction.
- `src/ai/eval/cli.test.ts` — pure CLI-core behaviour.
- `scripts/evaluate-args.test.ts` — the shell's argument parsing.
- `src/ai/eval/evaluationDocs.test.ts` — this document's key sections.
- `src/ai/eval/balancingDocs.test.ts` — the automated-balancing document's
  contract ([`docs/BALANCING.md`](./BALANCING.md)).

## Related work

- Epic: **Realistic demo/attract bot framework + playtester telemetry**
  (AH-0MUY089KR003F8S4).
- Automated balancing (batch runner + shared balance-statistics schema, epic
  AH-0MV1DLUZ8009OCJW): [`docs/BALANCING.md`](./BALANCING.md).
- Telemetry: [`docs/TELEMETRY.md`](./TELEMETRY.md).
- Bot framework: [`docs/BOT_FRAMEWORK.md`](./BOT_FRAMEWORK.md).
- Recording/replay: [`docs/dev/recording-and-replay.md`](./dev/recording-and-replay.md).
- Capture: [`docs/dev/gameplay-capture.md`](./dev/gameplay-capture.md).
