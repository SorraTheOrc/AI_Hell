# Automated balancing (batch evaluation)

> Status: delivered by AH-0MV81Z2EJ006HD5T (child 5 of epic
> AH-0MV1DLUZ8009OCJW). Source: [`src/ai/eval/`](../src/ai/eval), CLI:
> [`scripts/evaluate.mjs`](../scripts/evaluate.mjs). Builds on the same-seed
> evaluation harness, documented in [`docs/EVALUATION.md`](./EVALUATION.md).

Automated balancing turns the same-seed evaluation harness into a **batch
runner**: it simulates hundreds of deterministic bot games against the **real
balance data files**, aggregates full balance statistics across the games and
writes a stable, versioned report. It exists so a balance change can be
measured from evidence (a distribution of outcomes) instead of judged from a
single hand-watched run.

## Quick start

```bash
# run the default batch: 100 deterministic games with the competent bot
npm run evaluate -- --batch

# run 250 games across two policies and print the JSON report
npm run evaluate -- --batch --games 250 --policies competent,legacy --json

# a small, fast batch for iteration
npm run evaluate -- --batch --games 20 --out balance-out
```

A batch writes three artifacts under `--out` (default `eval-output/`,
git-ignored):

| Artifact | Contents |
|---|---|
| `balance-report.json` | The versioned balance report (stable JSON): config, per-run summaries and the aggregate distributions. |
| `balance-report.txt` | The same report rendered as a human-readable distribution summary. |
| `runs.jsonl` | The **raw telemetry** for every game, in the shipped record schema (one record per line). |

The text summary is printed to stdout unless `--json` is supplied, in which
case the JSON report is printed instead. Both artifacts are always written.

### Batch flags

A batch is the same command as a normal evaluation plus `--batch`. The
batch-relevant flags are:

| Flag | Meaning | Default |
|---|---|---|
| `--batch` | Enable batch mode (sweep seeds × policies, emit the balance report). | off |
| `--games <count>` | Number of games — expands to seeds `1..count`. | `100` in batch mode (`3` otherwise) |
| `--policies <a,b>` | Comma-separated policies to sweep; every policy plays every seed. | the `--policy` value (`competent`) |
| `--policy <name>` | Single policy when `--policies` is omitted. | `competent` |
| `--seed <n>` | An explicit seed (repeatable); overrides `--games`. | — |
| `--ticks <n>` | Maximum ticks per game (a game may end early on death). | `1800` |
| `--dt <seconds>` | Fixed simulation step. | `1/60` |
| `--sample-every <n>` | Record one state tick every Nth tick (smaller artifacts). | `1` |
| `--out <dir>` | Artifact output directory. | `eval-output` |
| `--json` | Print the machine-readable report instead of the text summary. | text |

The number of games in a batch is `policies × seeds`. For example,
`--policies competent,legacy --games 100` runs **200** games (two policies
over seeds 1..100) — comfortably above the epic's "~100 deterministic games"
requirement even for a single policy.

## Statistics schema

The report uses one **versioned, shared** schema so bot runs, human-play
statistics (AH-0MV7WVEWL005XEMN) and periodic human-experience validation
(AH-0MV7WVHU0000U775) all measure the same quantities and can be compared
directly. It is defined in [`src/ai/eval/types.ts`](../src/ai/eval/types.ts)
and exported from [`src/ai/eval/index.ts`](../src/ai/eval/index.ts) — consumers
import it rather than duplicating it.

- `BALANCE_STATISTICS_SCHEMA_VERSION` — the schema version, carried on every
  per-run statistic and every aggregate. Bump it on any
  backwards-incompatible change so a consumer can key a migration off it.
- `BalanceRunStats` — the statistics of **one** run, extracted purely from
  that run's telemetry record stream.
- `BalanceAggregate` — the distribution summary across a set of runs.
- `DistributionStats` — the distribution of one numeric metric.

### Per-run statistics (`BalanceRunStats`)

| Field | Meaning |
|---|---|
| `seed` | The run's RNG seed (from the `run_header`). |
| `mineralsCollected` | Minerals collected into the hold (cumulative total, or the count of `mineral_collected` events when the stream omits a running total). |
| `upgradesSelected` | Upgrade/choice selection counts, keyed by upgrade/choice id. |
| `enemiesKilledByArchetype` | Enemy kill counts, keyed by archetype (asteroids excluded). |
| `asteroidsDestroyed` | Asteroids destroyed. |
| `powerUpsCollected` | Power-ups/weapons collected. |
| `avoidableHits` | Hits that cost a life (absorbed hits excluded). |
| `survivalSeconds` | Survival time derived from the last recorded tick. |
| `waveReached` | Highest wave number reached. |
| `levelReached` | Highest level reached. |

### Aggregate statistics (`BalanceAggregate`)

The aggregate carries a `DistributionStats` for each scalar metric
(`mineralsCollected`, `powerUpsCollected`, `asteroidsDestroyed`,
`avoidableHits`, `survivalSeconds`, `waveReached`, `levelReached`) plus a
`DistributionStats` per upgrade id (`upgradesSelected`) and per enemy
archetype (`enemiesKilledByArchetype`). It also records `runs` (how many runs
were aggregated) and `seeds` (the seeds, in input order).

### Interpreting a distribution (`DistributionStats`)

Each distribution reports the same six numbers:

| Statistic | Meaning | How to read it |
|---|---|---|
| `count` | Number of finite runs contributing. | A count lower than `runs` means some runs had no value for that metric. |
| `mean` | Arithmetic average. | The expected outcome; compare the same metric across batches. |
| `median` | Middle value (mean of the two middle values for an even count). | Robust to outliers — prefer it over `mean` when a single lucky/degenerate run skews the average. |
| `min` / `max` | Smallest / largest observed value. | The spread of possible experiences; a wide `max − min` signals high run-to-run variance. |
| `stdDev` | Population standard deviation. | Run-to-run variance. A **small** standard deviation means the change affects most runs consistently; a **large** one means outcomes depend heavily on the scenario. |

Per-key distributions (upgrades, archetypes) are read the same way: for each
key, the numbers describe how often that upgrade was chosen or that archetype
was killed across the games. This is the evidence a balance change is judged
against: for example, if an upgrade's `mean` selection count collapses after a
tuning edit while `stdDev` stays low, the change made that upgrade
consistently unappealing.

### Report shape (`BalanceReport`)

The JSON artifact is a versioned `BalanceReport`:

- `schemaVersion` — `BALANCE_STATISTICS_SCHEMA_VERSION`;
- `datasetVersion` — the evaluation *interpretation* version
  (`EVAL_DATASET_VERSION`, bumped on a report shape change);
- `kind: 'balance'`;
- `config` — the swept `policies`, `seeds`, `ticks`, `dt` and `sampleEveryTicks`;
- `runs` — every run's summary (`policy`, `seed`, `stats`, `recordsHash`, `recordCount`) in sweep order;
- `aggregate` — the `BalanceAggregate`.

Object keys are recursively sorted before serialisation, so the report is
**byte-stable** for the same inputs.

## Config-driven simulation

The batch consumes the **real balance data** through the shared config
loaders — there is no divergent copy of enemy, ship or wave stats:

- **Enemy archetypes** (`src/data/enemy-configs.csv` via `loadAllEnemyConfigs`)
  seed the spawn reservoir and drive each hostile's behaviour — collision
  radius (`size`), hit points (`health`), fire cadence (`fireInterval`),
  projectile speed (`bulletSpeed`) and fire chance (`shotProbability`).
- **Ship stats** (`src/data/ship-config.csv` via `loadShipConfig`) map onto the
  `AsteroidsModel` physics.
- **Difficulty curves** (`src/data/difficulty-curves.csv` via
  `loadDifficultyCurves`) set how many hostile waves the spawn reservoir holds.

`loadBalanceConfig()` in [`src/ai/eval/balanceConfig.ts`](../src/ai/eval/balanceConfig.ts)
builds the resolved config; the Node shell awaits `hydrateBalanceConfig()`
before evaluating so the batch reads the CSV-backed values (SSR-safe). A
missing/unreadable CSV falls back to the built-in defaults and never blocks a
run. **Editing a CSV value therefore changes batch results for the same
seeds** — verified by `src/ai/eval/arena.test.ts`.

## Determinism and reproducibility

- Every run's scenario, hazards and input-governor jitter come from the run
  seed; the simulation never reads the wall clock and the run header's
  `startedAt` is fixed at `0`.
- The aggregate is computed by folding each run's statistics into an
  incremental aggregator, so batch memory is bounded by the small per-run
  summaries rather than by telemetry volume.
- Each run entry carries an FNV-1a hash of its stable-serialised records
  (`recordsHash`) so drift is detectable.

Together these mean **same seeds + config + policies yields a byte-identical
report**. Verify it:

```bash
npm run evaluate -- --batch --games 100 --out /tmp/a
npm run evaluate -- --batch --games 100 --out /tmp/b
diff /tmp/a/balance-report.json /tmp/b/balance-report.json
# (empty output == reproducible)
```

## Fidelity boundary and limitations

The batch runs the same **closed-loop headless arena** as the single-run
harness, not the shipped Phaser game. It models the quantities the bot
reasons about (player physics, collectables, hazards, auto-fire, enemy fire
and collisions) rather than the full wave/VFX/enemy-behaviour stack (enemy
formations, burst patterns and bullet lifetimes are intentionally not
modelled). Balance conclusions drawn from a batch are therefore a
**directional signal**, to be confirmed against the human-play statistics and
periodic human-experience validation before a tuning change ships. For
pixel-accurate, full-stack verification use the browser capture path
(`npm run capture`); both paths feed the same telemetry schema.

## Testing

- `src/ai/eval/balanceStats.test.ts` — extraction, aggregation (incl. median
  correctness), empty-series and determinism over the pure core.
- `src/ai/eval/arena.test.ts` — config-driven arena: CSV edits change outcomes
  for the same seed; determinism preserved.
- `src/ai/eval/engine.test.ts` — batch size handling, reproducibility and
  incremental-aggregation equivalence.
- `src/ai/eval/report.test.ts` — stable serialisation and the human-readable
  balance summary.
- `src/ai/eval/cli.test.ts` and `scripts/evaluate-args.test.ts` — batch flag
  parsing and pure CLI-core behaviour.
- `src/ai/eval/balancingDocs.test.ts` — this document's contract.

## Related work

- Epic: **Automated Balancing** (AH-0MV1DLUZ8009OCJW).
- Same-seed evaluation harness: [`docs/EVALUATION.md`](./EVALUATION.md).
- Telemetry schema: [`docs/TELEMETRY.md`](./TELEMETRY.md).
- Config source of truth: `src/data/*.csv` + `src/core/configStore.ts`.
