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

# validate a measured balance report (human or bot) against the committed
# intended-experience targets; exits non-zero on drift (docs/EXPERIENCE_VALIDATION.md)
npm run validate-experience -- eval-output/balance-report.json

# also emit the optional side-by-side capture/compose plan
npm run evaluate -- --human recordings/human.jsonl --video
```

Artifacts are written under `--out` (default `eval-output/`, git-ignored):

| Artifact | Contents |
|---|---|
| `report.json` | The deterministic evaluation or A/B report (stable JSON). |
| `runs.jsonl` | The raw telemetry for every run, in the shipped record schema. In a batch it is streamed to disk run by run (bounded memory), never accumulated. |
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
| `--batch` | Batch mode: sweep seeds × policies and emit the versioned balance report (see `docs/BALANCING.md`). A batch plays the **full shipped campaign** by default. | off |
| `--skirmish` | Batch mode only: opt back into the legacy single-level skirmish (the batch default is the full campaign, AH-0MVD1RK2V009J5D2). Single-run evaluation, A/B and `--human` are **always** skirmish-scoped (AC5). | off |
| `--ticks <n>` | Maximum ticks per run (finite; a run ends early on death or at the campaign boss/`gameComplete`). | `1800` single-run; `18000` batch |
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
| `--watchdog <secs>` | Bounded-runtime guard for `--tune`: abort with exit `124` once the budget is spent, restoring the CSV first (see `docs/BALANCING.md`). | `0` (off) |

### Exit codes and fail-fast validation

`0` success, `1` unexpected runtime error, `2` usage error **or** the fail-fast input
validation failed, `124` the `--tune` watchdog expired.

`--out` and the `--tune` CSV target are validated **before** the SSR core boots or any
sweep runs, so an invalid path fails in well under a second with
`output directory not writable: <dir> (<ERRNO>)` or
`tune CSV not readable: <path> (<ERRNO>)` instead of after a full sweep
(AH-0MVSE18XX006ZG5I). The full contract — plus the crash-safe CSV journal that survives a
`SIGKILL` and the per-run progress lines on stderr — is in
[`docs/BALANCING.md`](./BALANCING.md) §Tuning loop.

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
  telemetry-shaped records. The **batch** arena additionally drives the full
  campaign wave/level sequencer and the hold-full upgrade-choice flow (see
  [`docs/BALANCING.md`](./BALANCING.md#fidelity-boundary-and-limitations)).
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
  (the opening level's row count) in the seeded skirmish, and drive the whole
  campaign in batch mode (`buildSequencedLevels` honours `fixed`/`curve`/
  `dynamic` generations), so a curve edit changes a run either way.

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

The spike boots a minimal Vite SSR server (client dependency pre-bundling and
file watching disabled — neither is needed to transform modules for SSR, and
they were the load- and lock-sensitive parts behind the recurring full-suite
timeout, AH-0MVFBNZZD002JGI3). The same hydration contract is also covered by a
fast, load-free unit test in `src/core/configStore.test.ts` ("SSR fallback to
bundled CSVs").

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

### Aggregate assertions in regression tests

The bot micro-simulation tests follow the same principle: a single
hand-picked seed is a knife-edge calibration that a small, legitimate feel
tweak can flip without any change in decision quality. Tests therefore assert
**distribution-stable** properties — a majority over a documented, explicit
seed set — instead of one lucky run. The documented seed list (never an RNG and
never a cherry-picked subset) keeps every run reproducible, and the majority
rule means one seed flipping cannot fail the suite.

- The style-match sweep (`src/ai/style/evaluation.test.ts`) asserts the styled
  bot is closer to the human on a majority of its seed set, and bounds the
  competence regressions at the count recorded from the measured distribution.
  The current bound is 19 of 32 (measured 2026-11-22 with the re-fitted governor
  knobs, AH-0MWLCGWUF00631UX); it was re-justified from the original 16 because
  the regressed count is chaotic rather than governor-driven — see
  [`docs/STYLE_MATCHING.md`](./STYLE_MATCHING.md) § "Seed-sweep stability".
- The competent-vs-legacy sweep
  (`src/ai/framework/competent/competentBot.integration.test.ts`) asserts an
  **objective** advantage (minerals, power-ups, enemies) on a bullet-free
  scenario over a majority of seeds, so chaotic collision luck cannot distort
  the comparison.

The single-seed demonstrations remain as readable representative cases; they
are no longer the sole determinant of the assertion.

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
- A batch streams each run's telemetry to `runs.jsonl` as the run finishes
  (`executeEvaluation`'s `telemetrySink`), so memory is bounded by one run and
  does not grow with `--games`; the streamed bytes are identical to the
  accumulated JSONL (asserted in `src/ai/eval/cli.test.ts`).
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
(enemy formations and burst patterns are intentionally not modelled), and it
never boots a renderer or reads the wall clock. Each hostile's radius, health,
fire cadence, bullet speed and fire chance do come from the shared
`EnemyConfig`, so balance tuning is reflected in the simulation. That keeps
evaluation fast and deterministic under Node/vitest.

**Wrap parity (AH-0MVT2W5EL004OXNN).** Bullets are modelled on the same
torus as the game: player and enemy bullets wrap at all four edges and expire
by their game lifetimes (0.75 s player, 1.5 s enemy) instead of being culled
off-field, and hostile fire aims along the **shortest wrapped path**, so a
hostile near one edge shoots a player near the opposite edge across the seam.
A bullet that crosses a seam therefore stays a live, hittable projectile, and
the arena's avoidable-hit/damage metrics measure wrap-aware play rather than a
world in which the seam does not exist for bullets.

For pixel-accurate, full-stack verification use the browser capture path
(`npm run capture`); both paths feed the same telemetry schema, so a recorded
capture can be analysed with `npm run analyse`.

**Batch mode widens the boundary.** A `--batch` run plays the **whole shipped
campaign** by default — the shared wave/level sequencer (`fixed`/`curve`/
`dynamic` waves) and the hold-full upgrade-choice flow are driven, so the
balance report's `waveReached`, `levelReached` and `upgradesSelected` carry
real values. What stays **simplified** exactly, what the bounded tick budget
covers, and how to read the per-wave / per-level distributions is documented
in [`docs/BALANCING.md`](./BALANCING.md#fidelity-boundary-and-limitations)
(which owns the batch semantics); the short version is that boss/mini-boss
encounters, formation movement, VFX and rendering remain unmodelled, so a balance
report is a directional signal rather than a full-stack simulation. See
[`docs/BALANCING.md`](./BALANCING.md#full-campaign-runs-the-batch-default)
and `--skirmish` above for the opt-out.

## Ring timing harness

The Hangar War's outer loop is budgeted at the unit a player actually
experiences — **5–15 minutes per hex deployment**
(`docs/OUTER_LOOP_CANDIDATES.md` § Session shape) — with each ring's window
derived from its hex count: the one-ring MVP (6 hexes) **30–90 minutes** and
ring 2 (12 hexes) **60–180 minutes**. Those numbers are **measured**, not
guessed, by
[`src/ai/eval/ringTiming.ts`](../src/ai/eval/ringTiming.ts) — a thin driver over
the same headless arena described above.

```bash
# measure both rings for both playstyle lines (seeds 1–3)
npm run ring-timing

# machine-readable evidence (the committed baseline)
npm run ring-timing -- --json --out docs/dev/ring-timing-baseline.json

# one ring, one line, one seed
npm run ring-timing -- --ring 2 --strategy grind --seed 7
```

### What is measured

A hex deployment is "one hex, one level": the mini-boss ending
(AH-0MWBW1B1Z0059CC2) turns a deployment into exactly **one campaign level** —
played as the shipped **five-wave sortie** (the level's first four regular waves
plus its wave-5 mini-boss composition, truncated with the same pure helper the
game uses, `truncateCampaignForDeployment`). The harness reproduces exactly
that — `runArena` in **per-level mode** at the hex's aggression-selected level,
playing the deployment's wave set through the truncation seam
(`ArenaConfig.levelDefinition`) — and measures each deployment's duration from
the arena's **`level_cleared` event tick** (`level_cleared.tick × dt`): the
deployment ends the moment the sortie clears, never at the tick loop's end.
The aggression → level mapping is the shipped `hexDifficultyProfile`; the wave
set and difficulty come from the shipped level data through the game's own
truncation and `difficulty-curves.csv`. Nothing in the measurement is invented.

### What a deployment launches with

A deployment does not start from the campaign's bare state: the hangar resolves
a **loadout** first (`src/scenes/hangarWar/hangarDeployment.ts`). The harness
models it (AH-0MW9QA2YC009PSF5) from the shipped data — `HANGAR_CATALOGUE`,
`resolveHexGrant` and `src/data/hexRingDefinitions.ts` — never from a hardcoded
item list:

- **Entering ring 1** — hull `hull-1` and no equipped weapon. The starter
  `spread` is owned but never auto-equipped, so the first deployment flies the
  bare cannon (`AH-0MVZJ6V1J001DA9D`).
- **Within a ring** — the plan's play order (weakest aggression first) is the
  earning order: a **captured** hex's grant is owned from the next deployment
  onwards, so later deployments of the same ring launch with it. A **lost**
  deployment grants nothing — the retry replays the same hex with the same
  loadout.
- **Entering ring 2** — ring 1's six grants: the `ricochet`, `rapid` and
  `wave_laser` weapons, the `hull-2` hull, `hardened_plating` and the
  grant-only `hull-4` special-mission hull (which replaced the `core-bank`
  grant no authored hex carries any more).
- **Equip convention (deterministic)** — every owned weapon is equipped,
  trimmed by the shared six-slot cap (`capDropIdsToSlotPool`); the strongest
  owned hull is active (entering ring 2 that is `hull-2`: 4 lives, 0.85 speed;
  once ring 2's `hex-r2-3` is captured it is `hull-3`: 5 lives, 0.8 speed,
  AH-0MWF0CUS3009M5SY, scaled through the shared `scaleShipConfigForHull` helper
  a shipped deployment uses); every owned `extra-lives` modifier applies,
  capped at the run's 5 lives. **Every authored hex grant now resolves to a
  catalogue entry**: the catalogue derives one weapon entry per
  `src/data/weapons.csv` row bar the documented `cannon` exclusion, and its
  build-time guards fail closed on an authored weapon grant with no entry, so a
  granted weapon is owned **and** deployable — ring 2's `arc`, `broadside`,
  `dual`, `nova` and `rapid` grants included. A grant that intentionally carries
  no run stat is on the short effect-free allowlist (`armour-plating`,
  `systems-upgrade`, `firepower-up`); the `resolveHexGrant`
  "catalogue does not itemise" fallback remains only as defence-in-depth for a
  hypothetical future uncatalogued grant (a `hull-9`) — it is no longer a path a
  weapon grant can take.

The loadout changes the run's **starting** state only: the aggression model, the
deployment window and every retry/exposure allowance below are unchanged, and
the model is an explicit input (`RingTimingOptions.ownership`), so a caller can
state a different earned state without editing authored data. The seam it feeds
(`ArenaConfig.startingLoadout`) is inert by default and defensive when
malformed: an omitted loadout reproduces the shipped bare-cannon run
byte-identically, and an invalid life count or speed multiplier falls back to
the shipped defaults while an uncatalogued weapon id is ignored, so bad model
data degrades a run rather than crashing the harness.

### What is modelled (and why)

Around the measured deployments the harness models what the arena cannot see,
with every allowance an explicit, documented default:

| Allowance | Default | Why |
|---|---|---|
| Between-sortie time | 2 min | Hangar shopping, salvage banking, the map and the defence report between runs. |
| Retry per lost deployment | the lost sortie's own measured length (× `retriesPerLoss`) | A deployment that ends before its level cleared (the player died) is a **loss**; a real player replays it, so the retry replays the same deployment at its measured length — never the retired flat 5-minute window. |
| Exposed-hex re-capture | frontier attack chance (70 %) | The **rush** line pushes into the next ring with the current one partly held, so each unheld hex costs its expected re-capture work — the line's **measured mean deployment** plus the 2-minute visit (producer ruling Q4 = a). The chance is the shipped frontier clock's `attackChancePercent`. |

### The two playstyle lines

- **grind** — secure the ring first: every hex, **weakest aggression first**, so
the single weapon hex (the ring's hardest) is taken last. Slower, but the ring
is secured and the rear is never exposed.
- **rush** — take the **weapon hex first**, then push into the next ring with the
rest of this ring unheld. Faster (one deployment here), but the unheld hexes
are exposed and the ring is not secured.

### Measured baseline

> **The table below is requoted from the regenerated artifact** on the shipped
> one-level five-wave sortie (AH-0MWCQ4GTE005YG02, AH-0MWCQ4IS6001X7W3): a
> deployment is the aggression-selected level played as the shipped sortie —
> first four regular waves then the wave-5 mini-boss composition, truncated by
> `truncateCampaignForDeployment` (`DEPLOYMENT_WAVE_COUNT = 5`), measured at the
> wave-5 composition clear; the mini-boss encounter's own duration is not
> simulated (documented fidelity gap). The grind verdicts are re-rated against
> the re-authored per-hex budget: both rings read `within-tolerance`, each
> re-ruled by the linked rebalancing items AH-0MWFDQ9EY004NO4X (ring 1) and
> AH-0MWFDQCFV007BZE5 (ring 2). The arena also models the shipped game's
> kill-drop mineral economy (AH-0MWT5CRJ600382MS), which pays salvage for every
> wreck, plus hostile mineral absorption (AH-0MWT5CSF8003CFQF), which re-drops
> the swallowed count — both lifted the grind lines without touching a window or
> the budget.

Committed evidence:
[`docs/dev/ring-timing-baseline.json`](./dev/ring-timing-baseline.json)
(seeds 1–3, competent bot, regeneration command above).

| Ring | Line | Per-deployment (mean) | Total (mean, min–max) | Losses | Expected losses | Budget |
|---|---|---|---|---|---|---|
| 1 (6 hexes) | grind | 13.59 min | **27.8 min** (26.5–29.0) | 3.0 | 3.0 | 30–90 min · **within-tolerance** (AH-0MWFDQ9EY004NO4X) |
| 1 (6 hexes) | rush | 0.21 min | **10.2 min** (9.4–10.9) | 1.0 | 4.5 | not applicable (ring not secured) |
| 2 (12 hexes) | grind | 28.62 min | **60.3 min** (52.9–69.7) | 6.0 | 6.0 | 60–180 min · **in-window** (AH-0MWFDQCFV007BZE5) |
| 2 (12 hexes) | rush | 0.48 min | **22.1 min** (19.1–24.4) | 1.0 | 8.7 | not applicable (ring not secured) |

The **Per-deployment (mean)** column is the artifact's
`summary.deploymentMinutes.mean` for that ring and line — the measured arena
time of a single one-level deployment, which is what the retry term replays and
what the grind totals are built from. It is deliberately **not** the ring total
(that is the next column): ring 2 grind is 28.62 min of measured deployments
plus 24 min of modelled between-sortie visits plus 7.72 min of modelled retries
(six losses replaying their own measured length) plus 0.0 min of re-capture,
which sums to the 60.3 min total.

Reading the baseline:

- **The verdicts are re-rated against the per-hex budget.** The per-level arena
honours each wave's `shootEnabled` gate (AH-0MWFDQ9EY004NO4X), so the levels
1–3 opening is the no-fire sortie it is in the game: the weaker hexes are
captured and the firing tail is lost. Since the arena began modelling the
shipped game's kill-drop mineral economy (AH-0MWT5CRJ600382MS), every wreck pays
salvage, so the firing tail shortens: ring 1 grind measures **27.8 min** and
sits **within-tolerance** of the derived 30–90 window (2.2 min under the window
floor, above the 24-minute tolerance floor), while ring 2 grind **60.3 min**
sits **in-window** of the derived 60–180 window (0.3 min above the window
floor).
The budget assertion states a **10 %
tolerance** of each window's width (±6 min for ring 1, ±12 min for ring 2).
Each verdict is re-computed by the harness and re-ruled by its own linked
rebalancing item — **AH-0MWFDQ9EY004NO4X** (ring 1) and
**AH-0MWFDQCFV007BZE5** (ring 2) — never re-worded.
- **The playstyle trade is real.** The rush line is **faster** (10.2 vs 27.8 min
for ring 1; 22.1 vs 60.3 min for ring 2) but **riskier** — it leaves five (ring
1) / eleven (ring 2) hexes exposed (≈3.5 / 7.7 expected retakes), forfeits the
salvage of its failed attempts and does not secure the ring, while the grind
secures it. Neither line dominates.
- **The retry allowance prices only the lost attempts.** A captured sortie is
not retried, so a ring's total is its measured deployment time plus the
between-sortie visits plus the replay of the *lost* half (three of six on ring
1, six of twelve on ring 2). The rush line adds the exposed-hex re-capture bill
(measured mean deployment + the 2-minute visit) at the shipped 70 % frontier
attack chance.

### Confidence and fidelity boundary

- **Determinism.** Same seeds, same hexes, same allowances ⇒ identical report
  (asserted by a test); the harness never reads the wall clock.
- **Test runtime is not a signal.** The real-arena evidence tests in
  `src/ai/eval/ringTiming.test.ts` are compute-bound, not wall-clock-bound: the
  ring-2 grind (3 seeds × 12 hexes) takes ~20 s on an idle machine and measured
  126–220 s on a shared 16-core host running several concurrent test suites.
  They therefore carry a generous per-test cap (`REAL_ARENA_TIMEOUT_MS`, 300 s)
  so host contention cannot masquerade as a behavioural regression, while a
  genuine hang still fails the suite. The assertions compare modelled in-game
  minutes; none of them asserts how fast the simulation runs
  (AH-0MW0M42H1003J8HW).
- **Evidence quality.** The arena is a closed-loop model, not a human playtest
  (intake assumption A1 / Q4): its run durations and capture/loss verdicts are
  the measurement, and the build/retry allowances are explicit model
  parameters, not observations. A recorded human playtest remains desirable and
  is not a gate for the recorded target.
- **The launch loadout is a stated assumption, not data.** Which weapons a
  player equips and which hull they fly is a choice; the harness states one
  deterministic convention (earn in plan order, equip every owned weapon,
  strongest owned hull) and pins it per ring, so a reader can see which
  assumption a budget verdict rests on (AH-0MW9QA2YC009PSF5).
- **Aggression growth.** Each ring is measured from its **authored base
  aggressions** — the numbers the map publishes — plus its **capture-progress
  ramp** (`deploymentAggressionFor`, AH-0MWFDQ9EY004NO4X): a fresh ring deploys
  at its authored aggression and every hex taken in the ring raises the later
  deployments, by up to `HEX_AGGRESSION_RAMP_PER_RING` (two aggression points)
  across the whole ring. It is the same rule the game's deployment builder
  applies, not a harness-only assumption; ring 2's own ruling is tracked by
  AH-0MWFDQCFV007BZE5.

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
- `src/ai/eval/experienceTargets.test.ts` — the intended-experience targets
  schema, the pure comparator and the validation report
  ([`docs/EXPERIENCE_VALIDATION.md`](./EXPERIENCE_VALIDATION.md)).
- `src/ai/eval/ringTiming.test.ts` — the ring-timing harness: deployment plan,
  modelled allowances, budget verdicts, determinism against the real arena, the
  two ring budgets and the rush-vs-grind comparison (this document's
  [Ring timing harness](#ring-timing-harness) section).
- `scripts/ring-timing.test.ts` — the ring-timing CLI shell's argument parsing.
- `scripts/validate-experience.test.ts` — the validation CLI shell
  (artifacts, exit codes, determinism).

## Related work

- Epic: **Realistic demo/attract bot framework + playtester telemetry**
  (AH-0MUY089KR003F8S4).
- Automated balancing (batch runner + shared balance-statistics schema, epic
  AH-0MV1DLUZ8009OCJW): [`docs/BALANCING.md`](./BALANCING.md).
- Periodic human-experience validation
  (AH-0MV7WVHU0000U775): [`docs/EXPERIENCE_VALIDATION.md`](./EXPERIENCE_VALIDATION.md).
- Telemetry: [`docs/TELEMETRY.md`](./TELEMETRY.md).
- Bot framework: [`docs/BOT_FRAMEWORK.md`](./BOT_FRAMEWORK.md).
- Recording/replay: [`docs/dev/recording-and-replay.md`](./dev/recording-and-replay.md).
- Capture: [`docs/dev/gameplay-capture.md`](./dev/gameplay-capture.md).
