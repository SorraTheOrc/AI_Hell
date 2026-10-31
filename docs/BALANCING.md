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
| `runs.jsonl` | The **raw telemetry** for every game, in the shipped record schema (one record per line). Written incrementally per run, so the sweep is never held in memory. |

The text summary is printed to stdout unless `--json` is supplied, in which
case the JSON report is printed instead. Both artifacts are always written.

### Batch flags

A batch is the same command as a normal evaluation plus `--batch`. The
batch-relevant flags are:

| Flag | Meaning | Default |
|---|---|---|
| `--batch` | Enable batch mode (sweep seeds × policies, emit the balance report). | off |
| `--skirmish` | Play the legacy single-level skirmish instead of the **full shipped campaign** (the batch default). | off (batch plays the campaign) |
| `--games <count>` | Number of games — expands to seeds `1..count`. | `100` in batch mode (`3` otherwise) |
| `--policies <a,b>` | Comma-separated policies to sweep; every policy plays every seed. | the `--policy` value (`competent`) |
| `--policy <name>` | Single policy when `--policies` is omitted. | `competent` |
| `--seed <n>` | An explicit seed (repeatable); overrides `--games`. | — |
| `--ticks <n>` | Maximum ticks per game — a **finite** budget (a run ends early on death or at the campaign boss / `gameComplete`). | `18000` in batch mode (`1800` for a single-run evaluation) |
| `--dt <seconds>` | Fixed simulation step. | `1/60` |
| `--sample-every <n>` | Record one state tick every Nth tick (smaller artifacts). | `1` |
| `--out <dir>` | Artifact output directory. | `eval-output` |
| `--json` | Print the machine-readable report instead of the text summary. | text |
| `--level <n>` | Play the **real campaign waves** of level `n` (1–10) with the real per-kill drop rule (per-level campaign mode) instead of the seeded skirmish. | off |
| `--scale-levels <on\|off>` | Level-scaling curves in per-level mode: `on` resolves the enemy-count multiplier and per-kill drop chance at the selected level; `off` resolves **both to level 1** so a pre-change baseline is captured with identical harness code and seeds. | `on` |
| `--force-fields <on\|off>` | Enemy force fields (AH-0MVJ8W4GE007OMNT): `on` (default) resolves each hostile's field at the run level from the shared `enemyForceFieldHits` curve; `off` resolves every field at level 1 — 0 hits for every shipped archetype — so a pre-change (hull-only) baseline is captured with identical harness code and seeds. | `on` |

The number of games in a batch is `policies × seeds`. For example,
`--policies competent,legacy --games 100` runs **200** games (two policies
over seeds 1..100) — comfortably above the epic's "~100 deterministic games"
requirement even for a single policy.

### Full-campaign runs (the batch default)

```bash
# the default batch: every game plays the whole shipped campaign
npm run evaluate -- --batch --games 100 --out campaign-out

# the legacy single-level skirmish, for a skirmish-era baseline
npm run evaluate -- --batch --skirmish --games 100 --out skirmish-out
```

A batch plays the **full shipped campaign** by default (AH-0MVD1RK2V009J5D2,
parent decision Q3=b): each game drives the shared `buildSequencedLevels`
campaign through the shared `WaveManager` (all levels and waves, honouring
`fixed`/`curve`/`dynamic` generation) and the shared hold-full upgrade-choice flow,
so `waveReached`, `levelReached` and `upgradesSelected` carry real non-zero
distributions instead of the old constant zero. `--skirmish` opts
back into the previous single-level skirmish for backward compatibility;
the seeded skirmish path itself is unchanged.

**Bounded tick budget.** A campaign is far longer than one skirmish, so a
batch defaults to a **finite** `18000`-tick budget (five simulated minutes at
60 Hz) instead of the single-run `1800`. Every run still ends early on death
or when the shared campaign manager reports the boss trigger /
`gameComplete`; a run that stalls (e.g. a stationary hostile the bot cannot
reach) stops at the budget. A 100-game campaign batch at this budget takes
≈5 min on a dev machine (≈10 s at the old 1800-tick skirmish window); the
current measured time and peak-memory numbers are recorded in
[Campaign batch acceptance evidence](#campaign-batch-acceptance-evidence-ah-0mvd1rppp001xjkn)
below (an earlier ≈47 s figure predates the campaign/upgrade-path work and is
superseded).

**Bounded memory.** Raw telemetry is **streamed to disk per run**, never
accumulated across the sweep: `executeEvaluation` hands each run's serialised
records to an optional `telemetrySink`, and the Node shell writes them
synchronously to `runs.jsonl` (see
[Campaign batch acceptance evidence](#campaign-batch-acceptance-evidence-ah-0mvd1rppp001xjkn)).
Peak memory is therefore bounded by a single run's telemetry and does not grow
with `--games`.

**Comparability note.** Only **batch** mode defaults to the campaign.
Single-run evaluation (`npm run evaluate` without `--batch`), A/B and the
`--human` comparison keep the **skirmish** semantics deliberately (AC5), so
their long-standing metrics stay comparable with earlier evidence and with
recorded human runs. A balance report records its resolved mode in
`config.campaign` (and `config.level` for a per-level run); the tune loop's
same-sweep guard refuses to diff a campaign batch against a skirmish batch,
so mixed-mode before/after comparisons cannot be mistaken for a tuning edit.

**Determinism.** Unchanged: same policy + config + seeds ⇒ byte-identical
records and report (`recordsHash` stable). Every campaign draw is
seed-derived, and the pure eval core still reads no wall clock and does no
I/O.

### Reading the campaign distributions

A campaign batch reports three progression fields that the seeded skirmish
could not populate (they were constant `0` / empty before
AH-0MVD1RGKM005GW0C and AH-0MVD1RIH2008YCNV):

| Field | What it measures | How to read it |
|---|---|---|
| `waveReached` | The highest **within-level** wave number reached. `WaveManager.waveNumber` is 1-based *within the active level* and resets to 1 when the next level starts, so this is wave progress inside a level, **not** a cumulative campaign wave count. | Pair it with `levelReached`: `levelReached` 1 with a high `waveReached` means runs get deep into level 1; a low `waveReached` with `levelReached` 3 means runs reach level 3 but die early in it. It is also a density signal — a wave with more enemies takes longer to wipe, which shows up as a lower `waveReached` at a fixed tick budget even when kills/run and survival are flat. |
| `levelReached` | The highest campaign level entered (1–10). | The headline progression metric. `mean` 1.15 with `min` 1 / `max` 2 says most runs stay in level 1; a rising mean means the campaign is getting easier (or the bot better). |
| `upgradesSelected` | Per-choice-id counts of the upgrade the bot took through the shared hold-full flow. | Each key (a weapon/power-up/level id) has its own `DistributionStats`. A key whose `mean` collapses after a tuning edit while `stdDev` stays low made that choice consistently unappealing; a key that is never offered is a supply problem, not a balance one. |

The per-wave aggregation is the **distribution over runs** of those per-run
fields, not a per-wave table inside a single run: use `min`/`max`/`stdDev` to
see how much run-to-run variance the campaign has, and `median` in preference
to `mean` when one degenerate run (e.g. a stalled wave that exhausts the tick
budget) skews the average. Every run is bounded by the `18000`-tick budget, so
a run that stalls contributes its last reached wave rather than an unbounded
sample.

### Per-level campaign runs

```bash
# play level 5 of the real campaign (scaled curves): per-kill drop chance 0.122, 2x enemies at level 10
npm run evaluate -- --batch --level 5 --games 40 --out level5-out

# the pre-change baseline for the same level: curves resolved to level 1
npm run evaluate -- --batch --level 5 --scale-levels off --games 40 --out level5-base-out
```

With `--level <n>` the harness switches to an **additive** per-level campaign
mode: each game plays the **real campaign waves** of that level (the shared
`Formations.LEVELS` data through the level-scaling seam, as documented in
[`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`](./ENEMY_DESIGN_AND_IMPLEMENTATION.md)
§5.1) instead of the single-level spawn reservoir, and power-up supply comes
from the **real per-kill drop rule** (the shared `src/core/levelScaling.ts`
module, the same rule the game's `PlayScene` rolls) rather than the seeded
power-up reservoir. Waves progress in level order — the next wave spawns the
moment the current wave is wiped — and clearing the final wave emits
`level_cleared`, so the report's `levelReached` faithfully reflects the
selected level.

| Flag | Meaning |
|---|---|
| `--level <n>` | Campaign level to play (1–10). |
| `--scale-levels off` | Capture a **baseline** (curves at level 1) with identical harness code and seeds. |

**Determinism.** Identical to the skirmish: same policy + config + seed ⇒
**byte-identical** records, including per-level runs and baseline runs. The
per-level mode uses only seeded streams (positions, shot probability, drop
rolls, wave progression) and never reads the wall clock.

**Fidelity boundaries.** Per-level mode is the same *closed-loop headless
arena* as the skirmish: wave members are stationary hostiles whose stats come
from their archetype's `EnemyConfig` — formation movement and Phaser spawner
behaviour are not modelled, and spawner-delivered archetypes (`ghosts`,
`horde`, `centipede`, `laneTraffic`) appear as ordinary config-driven hostiles
so the roster matches the game's wave accounting. The seeded mineral harvest
and the asteroid shadow-hazard stay live (so the small-asteroid Extra Life
roll is exercised). The **seeded skirmish** (`--skirmish`; without `--level`
the default is the full campaign) is unchanged — its drops still come from
the seeded power-up reservoir. `--level` takes precedence over the batch's
full-campaign default, so a per-level run needs no extra flag.

## Level-scaling curves and evidence (AH-0MVHT1M6O003PU7P)

The campaign scales difficulty on two independent axes as the level rises: the
waves hold **more enemies**, and each kill has a **lower power-up drop
chance**. Both curves live in one pure module,
[`src/core/levelScaling.ts`](../src/core/levelScaling.ts), and are tuning data
in `GameRules` (`src/core/rules.ts`) — the game, the level gyms and this
harness resolve them through the same functions, never a copy.

### Scaling table (levels 1–10)

Both curves are linear across the campaign range and clamp outside it. Level 1
is exactly the pre-change behaviour (`1.00×` counts, `0.18` per-kill drop
chance, `0.05` asteroid Extra Life chance), so onboarding and older baselines
stay valid.

| Level | Enemy-count multiplier | Per-kill power-up drop chance | Relative supply vs L1 | Asteroid Extra Life chance |
|---|---|---|---|---|
| 1 | 1.000× | 0.1800 | 1.000 | 0.0500 |
| 2 | 1.111× | 0.1656 | 0.920 | 0.0460 |
| 3 | 1.222× | 0.1511 | 0.840 | 0.0420 |
| 4 | 1.333× | 0.1367 | 0.759 | 0.0380 |
| 5 | 1.444× | 0.1222 | 0.679 | 0.0340 |
| 6 | 1.556× | 0.1078 | 0.599 | 0.0299 |
| 7 | 1.667× | 0.0933 | 0.519 | 0.0259 |
| 8 | 1.778× | 0.0789 | 0.438 | 0.0219 |
| 9 | 1.889× | 0.0644 | 0.358 | 0.0179 |
| 10 | 2.000× | 0.0500 | 0.278 | 0.0139 |

- **Enemy counts.** Each non-`single` wave group's `count` is multiplied by
the level's factor, rounded half up (`Math.round`), floored at 1 and capped at
`enemyCountCap` (200); `single`-formation groups stay at exactly 1. The same
helper (`applyEnemyCountScaling`) is used by `PlayScene`'s campaign-build seam
and by `GymLevel` / `GymBotTuning`, so a launched level spawns the game's
counts (see
[`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`](./ENEMY_DESIGN_AND_IMPLEMENTATION.md)
§9.6 and §5.1).
- **Supply.** Every kill-time drop roll in `PlayScene` uses
`powerUpDropChance(level)` instead of the flat level-1 rate, and the asteroid
Extra Life roll scales by the same ratio (`extraLifeDropChance`). Drop types,
weights and timed effects are unchanged; the level gyms lengthen their supply
cadence by the inverse ratio so their run is not over-supplied.
- **Rationale.** The player's permanent weapon/power-up levels compound through
the run, so both axes compensate for that growth: each level adds enemy work
while handing out proportionally less supply. The endpoints (1→2× counts,
0.18→0.05 drop chance) are the tuning contract from the parent work item; the
values are data, so a future tuning change edits `GameRules` and re-runs this
evidence.
- **Spawn parity for tuning.** A launched level also spawns, transits, marches
and fires through the same shared seams as the shipped game: the wormhole
destination rule in `src/scenes/core/spawnTransit.ts`, the `shootEnabled`
hand-off and the shared march block (§5.1 of
[`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`](./ENEMY_DESIGN_AND_IMPLEMENTATION.md)).
A balance pass recorded through `GymLevel` / `GymBotTuning` therefore measures
shipped behaviour, not a gym-only approximation.
- **Documented divergence — formation gyms.** `GymFormationScene` and its
scenes (`GymBoss`, `GymCentipede`, `GymFodderEnemies`, …) have **no
campaign-level input**, so they keep their scene-specific flat
`powerUpSpawnInterval` supply source. Only the level-based gyms (`GymLevel`,
`GymBotTuning`) adopt the curves; the reason is recorded in the `GymLevel`
scene header and in the parent work item.

### The six loadout slots — the demand-side counterpart (parent AH-0MVLIJT3M005HPHF)

The level-scaling curves above reduce the **supply** of power-ups as the
campaign rises (AH-0MVHT1M6O003PU7P); the six-slot cap is their **demand-side**
counterpart. It bounds how many *distinct kinds* one run can hold at once —
permanently **or** by an active field pickup — so the late-game ship stays
strong but bounded no matter how generous the drop rolls are. The two levers
are complementary, not redundant: supply shapes how often a reward arrives, the
cap shapes what a run can become.

- **Cap and pool.** `POWER_UP_SLOT_CAP = 6`
  ([`src/core/constants.ts`](../src/core/constants.ts)) is a single named
  constant. The six slots are **one pool shared** by power-up and weapon kinds.
  Occupancy is **derived** from the existing run-scoped stores
  (`PowerUpLevelStore.getLevels()` + `getTempPowerUpIds()`,
  `Player.getWeaponLevels()` + `getTempWeaponIds()`) — there is no second
  counter and no new persisted state.
- **Field pickups count while they last (producer Q4a).** A temporary field
  pickup occupies one of the six slots for as long as its timed window is
  active and releases it on expiry, so the cap bounds *simultaneously held
  breadth* rather than a permanent-only loadout. Churn is accepted as intended:
  a run whose six slots were filled by field pickups can see new kinds spawn
  again once those windows expire. Run restart empties the pool.
- **Blocked pickups are visible (producer Q5b).** At the cap a drop that cannot
  be taken stays on the field, applies nothing and plays the distinct
  not-collectable cue once, so a full pool never silently swallows a pickup the
  player is chasing.
- **Eligibility only, not weights.** The cap gates *which* ids may be drawn,
  collected or offered once the pool is **full**; it never retunes a weight.
  Below the cap every id remains eligible with its existing weight, so
  `powerUpWeights` / `weaponWeights` keep their meaning and the pre-cap
  distribution is unchanged — which is why the existing level-scaling baselines
  stay valid.
- **Exemptions are data and never occupy a slot (producer Q7a).** An entry that
  may still appear when the pool is full carries `availableWhenSlotsFull` on its
  power-up catalogue entry (default `false`). **Extra Life** and **Mystery UFO**
  are exempt today; the flag also excludes them from the count, so taking an
  exempt reward can never push a run past six. Adding or removing an exemption
  is a catalogue edit, and a re-baseline of the affected batches is the only
  harness work needed. The `reset` utility is likewise slot-exempt (it can never
  hold a level).
- **Shared-pool starvation is intended semantics (producer Q1 answer (c),
  reaffirmed by the Q4/Q7 answers of 2026-10-27).** Because weapons and
  power-ups share the six slots (permanent or temporary), a **weapon-heavy build
  can occupy the pool before any power-up reward is taken** — a player who keeps
  choosing weapon unlocks and level-ups may reach the cap with no permanent
  Shield, Phase Shift or Magnet. This is the producer's **chosen** rule, **not a
  bug**: the shared pool is what gives each run a coherent build identity, and
  the exempt entries plus the owned level-ups keep the choice useful when the
  pool fills. A future change that splits the pool per family (or reserves
  slots) would be a design change with new evidence, not a fix.
- **Same rule in the game and the gyms.** The cap lives once in
  [`src/powerups/slots.ts`](../src/powerups/slots.ts) and is consumed by the
  shared drop draw (`drawNextDrop`, `src/scenes/core/dropLayer.ts`), the shared
  collection gate (`CombatCoreScene`), the hold-full choice builder
  (`buildChoiceCandidates`, `src/powerups/choice.ts`) and every other offer
  surface (`filterOptionsWithinSlotPool` — the mini-boss reward's unlock half),
  so `PlayScene` and every gym behave identically (gym↔game parity) and a gym
  run is a valid place to observe the rule.
- **No reward screen can breach the cap.** The mini-boss reward (§4.4.4) used to
  offer an unlock of any still-locked weapon, a brand-new kind that bypassed the
  pool; unlocks now pass through the same eligibility predicate as the drop draw
  and the choice, so the six slots bound every acquisition path (drop, field
  pickup, hold-full choice, mini-boss upgrade and mini-boss unlock). A gated
  reward that would offer nothing falls back to base picks of the held kinds, so
  the rule can never stall a paused overlay.
- **What the player sees: a slot budget and marked non-slot rows
  (AH-0MVVJRRN10038VFR).** The HUD upgrade list is a *display* list, not the
  loadout, so it can legitimately show rows that hold no slot: an exempt entry
  (Mystery UFO — `always available`) and a Phase Shift / Teleport row that
  survives on remaining charges after its temporary window expired
  (`charges only`). To keep the cap legible the HUD renders an explicit
  **`Loadout n/6`** budget from the shared model
  (`resolvePlayerSlotState(player)`), marks those non-slot rows, and gives every
  slot-held kind a row — including a temporary one-shot that previously showed
  none. The slot-counted rows therefore equal the model's `used` and never
  exceed `POWER_UP_SLOT_CAP`, and the same wiring (`combatHudOptions`) feeds
  `PlayScene` and every gym, so gym↔game parity holds for the display too.
- **Capture/scripted setups and the checkpoint save are handled explicitly
  (AH-0MVVJS34M00551ES).** Two surfaces are worth naming because they look like
  cap breaches. (1) The capture/gym `setup` payload
  ([`src/scenes/core/sceneSetup.ts`](../src/scenes/core/sceneSetup.ts)) may
  pre-grant **more than six counted kinds** — deliberate, because the scripted
  video beats exist to show a full late-game ship; it is contained by the
  run-progress dev gate (`resolveSceneSetupState`, folded off in a shipped
  build) so normal play can never inherit it. (2) A checkpoint is bounded on
  **save** (`capCheckpointLoadout` in
  [`src/core/checkpointStore.ts`](../src/core/checkpointStore.ts)) through the
  shared predicate, so `Continue` restores at most six counted kinds and exempt
  entries still come back; the replay itself restores a hand-written payload
  verbatim, by design (the resumed run must match the saved run exactly).
- **Evidence scope.** Existing bot/batch evidence was recorded before the cap,
  so a late-game campaign run now sees a different loadout. Re-running and
  re-recording the bot batches is **out of scope** for the cap work item; it
  becomes a linked follow-up only if a gate fails. Recorded user stories and the
  producer decisions live on the parent work item (AH-0MVLIJT3M005HPHF).

### Per-upgrade temporary TTLs — how long a field pickup lasts

A field pickup is a **temporary** level (GDD §4.4.3): it reverts when its own
temporary window expires. The window length (TTL) is **balance data**, a
property of the upgrade item rather than one global constant, resolved by the
single `resolveTemporaryWindow` helper in
[`src/powerups/powerUpLevels.ts`](../src/powerups/powerUpLevels.ts). Two
families share the rule:

- **Timed kinds** keep their existing level-resolved effect duration as the
  TTL, so the window levels up with the effect (Shield 15 s → 30 s, Force
  Field 8 s → 18 s, Frenzy 8 s → 16 s, …). Nothing to tune separately.
- **Instant kinds** declare a per-entry TTL in the catalogue
  ([`src/powerups/types.ts`](../src/powerups/types.ts),
  `PowerUpEntry.temporaryWindow`). Retuning one of these is a **data edit** —
  no code change is needed:

| Instant kind | TTL (s) | Rationale |
|---|---:|---|
| Bomb | 10 | Mirrors the established 10 s weapon window (`WEAPON_TIMEOUT_MS`). |
| Smart Bomb | 10 | As Bomb — a one-shot screen pulse with the weapon-style window. |
| Orbital Strike | 10 | As Bomb — a one-shot bolt with the weapon-style window. |
| Phase Shift | 15 | Defensive kind: the shield-style 15 s window. |
| Teleport | 15 | Defensive kind: the shield-style 15 s window. |
| Extra Life | 10 | Weapon-style 10 s window; the **life itself is kept** when the level reverts. |
| Mystery UFO | 15 | Spans a full 5–8 s drone sortie, so the granted drone outlives its window. |

Weapons obey the same rule with their own 10 s TTL, surfaced as
`resolveWeaponTemporaryWindow`. The values are deliberately short so a
temporary level can never compound across a wave, and they are **not** scaled
by the campaign-level supply curves above (those shape drop frequency, not
window length).

**Consumables are never clawed back.** Lives, Phase Shift charges and
Teleport uses already granted by a temporary pickup survive the level revert
and never carry a timer of their own (producer Q2 on AH-0MVSTKGC3003OMAC).
Occupancy of a six-slot loadout still follows the window: the slot is released
when the TTL expires (see the loadout subsection above).

> The AH-0MUX802450085VZZ *"Resolved decision 4"* exception (instant kinds
> had no window at all) is **superseded** by AH-0MVSTKGC3003OMAC.

### Evidence: same-seed baseline vs post-change batches

Both batches use the **same seed set (1–100)**, the **competent** policy, 1800
ticks (`dt` 1/60), and the identical harness code at commit **`ec0ccc7b`**.
The baseline is per-level mode with the curves disabled (`--scale-levels off`,
which resolves **both** axes to level 1 — the pre-change behaviour); the
post-change batch resolves them at the selected level (`--scale-levels on`,
the default). Each level is its own pair of runs because per-level mode plays
that level's real campaign waves and real per-kill drop rule.

```bash
# baseline (curves resolved to level 1) and post-change, for a level n
node scripts/evaluate.mjs --batch --level 5 --scale-levels off --games 100 --out /tmp/evidence/l5-off
node scripts/evaluate.mjs --batch --level 5 --scale-levels on  --games 100 --out /tmp/evidence/l5-on

# level 10 only: --sample-every 10 keeps the unsampled 100-game runs.jsonl
# under Node's single-string write limit; events (and so every metric below)
# are still recorded on every tick, survival is quantised to ~0.17 s.
node scripts/evaluate.mjs --batch --level 10 --scale-levels off --games 100 --sample-every 10 --out /tmp/evidence/l10-off
node scripts/evaluate.mjs --batch --level 10 --scale-levels on  --games 100 --sample-every 10 --out /tmp/evidence/l10-on
```

Aggregate means per 100-game batch (`n = 100`; power-ups per kill is the
per-run "collected ÷ enemies killed" mean):

| Level | Batch | Power-ups collected | Enemy kills/run | Power-ups per kill | Avoidable hits | Survival (s) | Wave reached | Level reached |
|---|---|---|---|---|---|---|---|
| 1 | baseline | 0.41 | 6.42 | 0.0694 | 1.38 | 28.37 | 1.40 | 1.00 |
| 1 | post-change | 0.41 | 6.42 | 0.0694 | 1.38 | 28.37 | 1.40 | 1.00 |
| 5 | baseline | 0.31 | 4.04 | 0.0679 | 1.75 | 25.49 | 1.44 | 5.00 |
| 5 | post-change | 0.21 | 5.10 | **0.0432** (−36.4 %) | 1.91 | 25.34 | 1.24 | 5.00 |
| 10 | baseline | 0.50 | 15.84 | 0.0282 | 2.88 | 15.78 | 1.00 | 10.00 |
| 10 | post-change | 0.12 | 21.78 | **0.0055** (−80.5 %) | 2.98 | 13.14 | 1.00 | 10.00 |

Per-archetype kills (aggregate means, the field the work item requires):

| Level | Batch | Kills by archetype |
|---|---|---|
| 5 | baseline | `phaser` 4.04 |
| 5 | post-change | `phaser` 5.10 |
| 10 | baseline | `capturer` 0.32, `diver` 4.31, `ghost-ambush` 0.43, `ghost-chase` 0.50, `ghost-flank` 0.39, `ghost-wander` 0.42, `grunt` 0.38, `raider` 0.16, `swarm` 4.31, `tank` 4.62 |
| 10 | post-change | `capturer` 0.19, `diver` 6.72, `ghost-ambush` 0.26, `ghost-chase` 0.41, `ghost-flank` 0.29, `ghost-wander` 0.35, `grunt` 0.20, `raider` 0.15, `swarm` 6.32, `tank` 6.89 |

**Reading the evidence.**

1. **L1 is byte-identical.** The two level-1 reports diff clean —
   `--scale-levels off` and `on` produce the same `balance-report.json`, which
   confirms the level-1 identity of both curves.
2. **Mid/late supply per kill falls.** At level 5 it drops from 0.0679 to
   0.0432 (−36.4 %); at level 10 from 0.0282 to 0.0055 (−80.5 %). Level 5's
   collected supply (−32.3 %) closely tracks its drop-chance ratio (0.679),
   and level 10's much larger fall is the same curve compounded by shorter
   post-change runs (fewer collection opportunities).
3. **The campaign stays playable.** All 600 runs completed without a crash and
   produced a report. The reached-level metric is unchanged at both levels
   (`levelReached` 5.00 and 10.00), and the completion metric is unchanged
   (`won` / `level_cleared` = 0 in both batches — the competent bot dies before
   clearing a 10-wave level at L5/L10, before and after). The bot also kills
   **more** enemies in the same game (L5 +26 %, L10 +37 %) and survival is flat
   at L5 (−0.6 %); at L10 survival is 17 % shorter because twice as many
   enemies now occupy the same arena. At L5 the secondary `waveReached`
   progress signal moves from 1.44 to 1.24 — a wave with 44 % more enemies
   takes longer to wipe — which is the intended density escalation, not a
   starvation or crash signal (kills/run and survival do not fall).
4. **No tuning was changed after the evidence run.** The endpoints arrived at
   from the design (`1→2×`, `0.18→0.05`) already move both measured axes in
   the intended direction, so the documented values are the shipped ones. A
   future tuning change edits `GameRules`, records the reason, and re-runs the
   four commands above on the same seeds.

Artifacts (`balance-report.json`, `balance-report.txt`, `runs.jsonl`) are
written under the git-ignored output directories; the commands, seed set,
commit and aggregates above are the durable record.

## Enemy force-field evidence (AH-0MVJ8W4GE007OMNT)

Enemy force fields (GDD §2.6/§4.1, enemy guide §1.6) are a **new additive
durability layer**: from a per-archetype start level a shielded hostile absorbs
field hits **before** its hull (`health`), resolved by the same pure
`enemyForceFieldHits(level, config)` curve the game and level gyms use. The
headless arena models that layer identically (barrier first, hull second), so
balance evidence can quantify its cost.

`--force-fields off` resolves every field at level 1 — **0 hits for every
shipped archetype** — so the **pre-change hull-only baseline** is captured
with the identical harness code and seed set. Level 1 is byte-identical
on/off by construction (no shipped archetype shields at L1).

```bash
# baseline (hull-only: fields resolved at level 1) and post-change, for level n
node scripts/evaluate.mjs --batch --level 1  --force-fields off --games 15 --out /tmp/evidence/l1-off
node scripts/evaluate.mjs --batch --level 1  --force-fields on  --games 15 --out /tmp/evidence/l1-on
node scripts/evaluate.mjs --batch --level 5  --force-fields off --games 15 --out /tmp/evidence/l5-off
node scripts/evaluate.mjs --batch --level 5  --force-fields on  --games 15 --out /tmp/evidence/l5-on
node scripts/evaluate.mjs --batch --level 10 --force-fields off --games 15 --out /tmp/evidence/l10-off
node scripts/evaluate.mjs --batch --level 10 --force-fields on  --games 15 --out /tmp/evidence/l10-on
```

Aggregate means per 15-game batch (competent policy, seeds 1–15):

| Level | Batch | Survival (s) | Level reached | Avoidable hits | Kills by archetype |
|---|---|---|---|---|---|
| 1 | baseline | 67.76 | 1.00 | 3.00 | `scout` 15.13 |
| 1 | post-change | **67.76** | 1.00 | 3.00 | `scout` 15.13 |
| 5 | baseline | 48.11 | 5.00 | 3.00 | `phaser` 9.33 |
| 5 | post-change | 33.00 | 5.00 | 3.00 | `phaser` **2.40** |
| 10 | baseline | 11.55 | 10.00 | 3.00 | `tank` 7.27, `diver` 5.80, `swarm` 5.47, `raider` 0.13 |
| 10 | post-change | 12.50 | 10.00 | 3.00 | `tank` **1.33**, `diver` **1.13**, `swarm` **1.47**, `raider` **0.07** |

**Reading the evidence.**

1. **L1 is byte-identical.** The level-1 `runs.jsonl` on/off batches hash
   identically (no archetype resolves a field at L1), so onboarding and the
   pre-change baseline are untouched.
2. **The barrier measurably hardens shielded archetypes.** At L5 phaser kills
   drop 9.33 → 2.40 (−74 %); at L10 tank/diver/swarm kills drop by 66–82 %
   under the same seeds, exactly the durability the field is meant to add.
3. **The campaign stays playable.** Reached level is unchanged at every level
   (1.00 / 5.00 / 10.00) and survival at L10 is comparable (12.50 s vs 11.55 s);
   L5's shorter survival (33.00 s vs 48.11 s) is the intended extra durability
   of mid-level shielded fodder, not a stall or crash — every run produced a
   report. Evidence is **advisory**; the 5-hit cap and per-archetype CSV
   values are the tuning levers.

The headless model is pinned by `src/ai/eval/arena.test.ts` (L1 on/off
byte-identity, L5/L10 divergence, barrier-before-hull ordering).

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
- `config` — the swept `policies`, `seeds`, `ticks`, `dt` and `sampleEveryTicks`,
  plus the resolved run mode: `campaign` (the batch default) and, for a
  per-level run, `level`;
- `runs` — every run's summary (`policy`, `seed`, `stats`, `recordsHash`, `recordCount`) in sweep order;
- `aggregate` — the `BalanceAggregate`.

Object keys are recursively sorted before serialisation, so the report is
**byte-stable** for the same inputs.

### Human-play statistics (`policy: 'human'`)

A human session is recorded with the dev tooling (`npm run record`) and
converted into the **same** `BalanceReport` shape by the shared pure helper
`extractHumanBalanceStats` in
[`src/ai/eval/humanStats.ts`](../src/ai/eval/humanStats.ts), labelled with the
`human` pseudo-policy:

- `npm run record` writes `balance-stats.json` **next to** the `.jsonl`
  recording; and
- `npm run evaluate -- --human <file.jsonl> --out <dir>` writes
  `human-balance-report.json` under `--out` (beside the existing same-seed
  `comparison.json` and `ghost.svg`).

Both artifacts are versioned `BalanceReport`s (`kind: 'balance'`,
`config.policies: ['human']`, `schemaVersion:
BALANCE_STATISTICS_SCHEMA_VERSION`) that are directly comparable to a bot
batch report on the same fields. A human report omits `config.campaign` — a
recorded session is the real game, not a harness mode. The helper splits the recording's flat
`run_header` / `tick` / `event` stream into one `BalanceRunStats` per run and a
single `BalanceAggregate`, **reusing** the bot path's
`extractBalanceStats` / `aggregateBalanceStats` — the schema and the
statistics code are shared, so bot and human numbers cannot drift. Survival
time is derived from tick numbers at the default 60 Hz (`dt` 1/60) as the
recording provides no bot-config values.

A recording containing several runs yields one per-run entry in `runs` plus
one `aggregate` across every run, mirroring a bot batch. Collection is
**dev-tooling only** (AH-0MV7WVEWL005XEMN AC3): no production
telemetry/consent configuration changes and no PII in the artifact — only
schema fields (numeric statistics, seeds, archetype/upgrade keys and record
hashes).

### Intended experience and periodic validation (AH-0MV7WVHU0000U775)

A `BalanceReport` records what the game **did**; the intended experience says
what it is **supposed to do**. The committed targets artifact
[`src/data/experience-targets.json`](../src/data/experience-targets.json)
records a target band (centre + tolerance) for the key metrics, derived from a
recorded bot batch — the chosen source of intended experience. A bot report or
a recorded human session is then checked against those bands:

```bash
# human session (npm run record writes balance-stats.json beside the recording)
npm run validate-experience -- recordings/balance-stats.json

# fresh bot batch (catches a drift in the baseline itself)
npm run validate-experience -- eval-output/balance-report.json --json
```

A band is `max(2 × baseline stdDev, 10 % of |centre|, 0.5)` wide; the exact
rule is recorded in the artifact. The command writes a versioned
`experience-validation.json` and a Markdown `experience-validation.md` under
`--out` (default `experience-out/`) and **exits non-zero on drift**. The full
workflow, the report shape, scheduling and tolerance-tuning guidance are in
[`docs/EXPERIENCE_VALIDATION.md`](./EXPERIENCE_VALIDATION.md).

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
  `loadDifficultyCurves`) drive the campaign: in the default full-campaign
  batch they set every level's wave count and each wave's
  `targetDifficulty`, which the shared `buildSequencedLevels` turns into
  `fixed`/`curve`/`dynamic` wave groups. In the seeded skirmish they only set
  how many hostile waves the spawn reservoir holds.

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

## Tuning loop (baseline → edit → re-run → compare)

> Delivered by the automated-balancing work item AH-0MV8Q5EYE001R715
> (children AH-0MVBNIS59000MXW1, AH-0MVBNISIZ003C20U, AH-0MVBNISWE009QFBL,
> AH-0MVBNITA0005VQGN).

The tuning loop automates the manual chore of measuring **one** balance edit:
run a baseline batch, apply a single declarative CSV edit, re-run the
**identical** sweep against the edited file and write a versioned
before/after comparison — one auditable, repeatable command instead of the
hand diff shown in the §Acceptance-verification run.

### One-command loop

```bash
# baseline (100 games) → edit boss health 1 → 6 → identical re-run → compare
node scripts/evaluate.mjs --tune --set enemy-configs.csv boss.health=6 --games 100 --out tune-health-6
```

The command writes four artifacts under `--out`:

| Artifact | Contents |
|---|---|
| `tune-baseline-report.json` | The baseline batch report (stable JSON). |
| `tune-candidate-report.json` | The post-edit batch report (stable JSON). |
| `tune-comparison.json` | The versioned before/after comparison (schema v2): per-metric count/mean/median/min/max/stdDev deltas, per-upgrade and per-archetype deltas, the `edit` record (file/row/field/previous/new) and the `movedMetrics`/`shapeChangedMetrics` summaries. |
| `tune-comparison.txt` | The same comparison rendered as a readable text summary. |

The readable summary is printed to stdout (`--json` prints the comparison
artifact instead).

### Tune flags

| Flag | Meaning | Default |
|---|---|---|
| `--tune` | Enable the tune loop (baseline → edit → re-run → compare). | off |
| `--set <file> <assignment>` | The single declarative edit, e.g. `--set enemy-configs.csv boss.health=6` (`<rowKey>.<field>=<value>`, or `<field>=<value>` for single-row files such as `ship-config.csv`). | — |
| `--threshold <pct>` | Relative significance threshold in percent. | `10` (±10 %) |
| `--keep-edit` | Keep the CSV edit after the run instead of restoring it. | off (restore) |

The batch sweep itself uses the usual flags (`--games`, `--policies`,
`--ticks`, `--dt`, `--sample-every`, `--out`).

### Guards and guarantees

- **Fail-fast input validation (AH-0MVSE18XX006ZG5I):** before the SSR core
  boots or any sweep runs, `--out` is probed by creating the directory (when
  missing) and writing, fsyncing and unlinking a sentinel file, and the
  `--tune` CSV target is probed with a read. An invalid path therefore fails in
  well under a second with exit code `2` instead of after a full baseline and
  candidate sweep:

  ```
  output directory not writable: <dir> (<ERRNO>)   # e.g. EACCES, ENOTDIR, EROFS
  tune CSV not readable: <path> (<ERRNO>)          # e.g. ENOENT
  ```

  The write probe (not just a `mkdir`) is what catches an **existing** read-only
  directory, which accepts a recursive `mkdir` and only fails on the first
  write. The late `mkdirSync` before the artifact writes remains as an
  idempotent safety net. The measured pre-fix cost of the same invalid path was
  4.31 s at 10 games × 2000 ticks and 11.82 s at 40 games × 2000 ticks.
- **Crash-safe edit journal (AH-0MVSE1A7O002PXAO):** before the first edited
  byte is written, the pre-edit bytes are persisted to
  `src/data/<file>.tune-journal` (written to a sibling temp file, `fsync`ed and
  atomically renamed, so a kill at any moment leaves either no journal or a
  complete one). The journal is removed after a successful restore, and with
  `--keep-edit` it is removed **without** restoring. It is git-ignored
  (`src/data/*.tune-journal`), so a crashed run leaves no worktree change.

  A `SIGKILL` (OOM, an external timeout kill) runs no `finally`, so the
  in-memory restore cannot help — the journal is what makes the edit
  recoverable. The **next** `--tune` invocation reconciles a stale journal for
  its CSV target *before* validating anything, prints
  `warning: restored <csv> from a stale tune journal (…)` and continues, so the
  normal recovery needs no manual step.

  If the CLI is never run again, or the journal is unreadable (the CLI then
  refuses to run with `tune journal not reconcilable: …` and exit code `2`),
  restore it without Node:

  ```bash
  jq -r .originalBase64 src/data/enemy-configs.csv.tune-journal \
    | base64 -d > src/data/enemy-configs.csv
  rm src/data/enemy-configs.csv.tune-journal
  git diff --exit-code src/data/enemy-configs.csv   # empty == restored exactly
  ```
- **Same-sweep guard:** the comparison refuses to diff two batches whose
  sweep configuration (`policies`, `seeds`, `ticks`, `dt`,
  `sampleEveryTicks`) differs — refused **before** any delta is computed.
- **Side-effect check:** an identical-config re-run whose per-run telemetry
  hashes drift errors (`SameSweepGuardError`), so a non-determinism or I/O
  leak cannot silently corrupt a comparison.
- **Determinism:** same edit + same seeds → byte-identical
  `tune-comparison.json`; a no-op edit yields zero deltas.
- **Checkout hygiene:** after the run the edited CSV is byte-identical to its
  pre-run state on success **and** failure paths, unless `--keep-edit` is
  given — the working tree stays clean.

### Reading the comparison — worked example

Tuning `boss.health` from `1` to `6` (the same edit as the
§Acceptance-verification run) produces a comparison whose
`enemiesKilledByArchetype.boss` row shows the kill-rate drop — e.g. mean
`0.97 → 0.57` — while survival, minerals and avoidable-hit metrics move in
the same direction. `movedMetrics` lists every metric whose mean or median
moved beyond the configured threshold (default ±10 %); the shape-change
lines call out stdDev growth (variance increase) and median shifts.

```bash
node scripts/evaluate.mjs --tune --set enemy-configs.csv boss.health=6 --games 100 --out tune-boss-6
```

This produces the same evidence as the hand-CSV-edit diff below, without any
manual steps.

## Fidelity boundary and limitations

The batch runs the same **closed-loop headless arena** as the single-run
harness, not the shipped Phaser game. Because the default batch now plays the
campaign, this boundary is stated explicitly so a consumer never over-reads a
balance report.

**Modelled (the default campaign batch).**

- **Wave/level progression** — every level and wave comes from the shared
  sequencer (`buildSequencedLevels` + `WaveManager` + the level enemy-count
  scaling seam, the same build `PlayScene` uses), honouring all three
  generation modes: `fixed` (hand-authored composition), `curve`
  (`targetDifficulty`-driven) and `dynamic` (curve rebuilt from the run seed).
  The canonical `wave_start` / `wave_cleared` / `level_cleared` /
  `boss_triggered` events are emitted by the shared manager, so `waveReached`
  and `levelReached` are real per-run values.
- **Upgrade choices** — when the shared `MineralHold` fills, the arena runs
  the shared hold-full **upgrade-choice flow** (`chooseOptions` +
  `applyMineralChoiceReward`): the bot picks from three offered options on the
  seeded stream and the arena emits `choice_selected`, so `upgradesSelected`
  carries a real per-choice-id distribution.
- **Combat quantities the bot reasons about** — player Newtonian physics (the
  shipped `AsteroidsModel`), collectables, minerals, hazards, auto-fire, enemy
  fire and collisions, all driven by the real per-kill drop rule at the
  current campaign level.

**Simplified (not modelled; treat the report as a directional signal).**

- **Boss and mini-boss encounters** — clearing the final level triggers
  `boss_triggered`, which **ends the run**. No boss or mini-boss entity is
  simulated; a mini-boss wave is only its authored group composition. A boss
  balance question cannot be answered from a batch report alone.
- **VFX** — explosions, particles, shake and audio cues are absent.
- **Formations** — formation movement, burst patterns, bullet lifetimes and
  the Phaser spawner's behaviour are not modelled; wave members are stationary
  hostiles whose stats come from their archetype's `EnemyConfig`. Opt-in
  spawner archetypes appear as ordinary config-driven hostiles so the roster
  matches the game's wave accounting.
- **Rendering** — there is no renderer, camera, resize or frame-rate coupling;
  a run never boots Phaser.
- **Chosen-upgrade effects** — a selection updates the ownership context used
  by later offers, but the chosen weapon's fire pattern, shield/effect timing
  and Extra Life lifegain are not simulated (the arena's auto-fire is fixed).

Clearing the final level is therefore the run boundary, and a stall stops at
the finite tick budget. Balance conclusions drawn from a batch are a
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
  parsing and pure CLI-core behaviour, plus the tune-loop comparison core
  (`runBalanceBatch`, `buildTuneComparisonArtifacts`) and `--tune`/`--set`
  flag parsing (AH-0MVBNITA0005VQGN).
- `src/ai/eval/experienceTargets.test.ts` — the intended-experience targets
  schema, the pure comparator (in-band / above / below / missing / empty) and
  the validation report's determinism.
- `scripts/validate-experience.test.ts` — the validation CLI shell: artifacts,
  exit codes, source labelling and byte-stable output.
- `src/ai/eval/tune.test.ts` — the versioned before/after comparison and the
  same-sweep guard (determinism, empty deltas, threshold classification).
- `src/utils/csvEdit.test.ts` and `scripts/csvEdit-shell.test.ts` — the
  declarative `--set` editor and guaranteed byte-identical restore on
  success/failure paths (`--keep-edit` opt-out).
- `src/ai/eval/balancingDocs.test.ts` — this document's contract.

## Acceptance-verification run (2026-10-14, AH-0MV81Z9EI005TQMB)

Recorded evidence for the epic's end-to-end acceptance verification (epic
AC1/AC2/AC5, verifier AC1–AC5). The batch was run at commit
`d31906f5` of the automated-balancing work, on the **real** balance data files
(`src/data/enemy-configs.csv`, `ship-config.csv`, `difficulty-curves.csv` via
`loadBalanceConfig()`), against a clean checkout (no local edits).

1. **100-game batch (AC1).** `node scripts/evaluate.mjs --batch --games 100
   --out <dir>` (competent policy, seeds 1..100, 1800 ticks) completed in
   ≈18 s and wrote all three artifacts: `balance-report.json`
   (36,709 bytes), `balance-report.txt` (1,730 bytes, human-readable
   distribution summary) and `runs.jsonl` (raw telemetry, 169,437 records).
2. **Byte-identical replay (AC2).** Re-running the identical command to a
   second directory and diffing produced **empty** diffs for
   `balance-report.json`, `balance-report.txt` and `runs.jsonl` — the report
   is reproducible byte-for-byte for the same seed + config + policy. Example
   aggregate (n=100): minerals mean 5.55 (med 6, min 0, max 11, sd 2.66);
   survival 27.94 s (sd 5.52); boss kills 0.97; power-ups 0.56.
3. **CSV-edit sensitivity (AC3).** Raising `boss` `health` in
   `enemy-configs.csv` from `1` to `6` changed the batch report for the same
   seeds: `kills[boss]` mean 0.97 → 0.57, `mineralsCollected` 5.55 → 4.29,
   `avoidableHits` 0.90 → 1.30, `capturer` kills 1.16 → 0.93. The edit was
   then reverted; the checkout returned to clean.
4. **Full suite (epic AC7).** `run_tests.py --scope full` at the same commit
   passed: 254 test files / 5,292 tests, 0 failures.

Artifacts from this run are git-ignored (see `/.gitignore` `eval-output/`);
the commands and aggregate evidence above are the durable record.

## Campaign-by-default batch evidence (AH-0MVD1RK2V009J5D2)

After the batch switched to the full campaign by default (parent decision
Q3=b), a 100-game competent-policy batch on seeds 1–100 at the new
**18000-tick** budget was measured on a dev machine (commit at implementation
time, real balance CSVs via `loadBalanceConfig()`):

```bash
npm run evaluate -- --batch --games 100 --out campaign-out
```

- `waveReached`: mean 6.46 (min 2, max 10); `levelReached`: mean 1.15
  (min 1, max 2) — a real distribution instead of the old constant zero.
- `upgradesSelected` populated per choice id (the shared hold-full flow).
- Runtime ≈47 s (vs ≈10 s for the old 1800-tick skirmish batch), i.e. a
  practical, bounded 100-game campaign batch.
- A run that stalls on a wave stops at the 18000-tick budget; a run that
  clears the final level or dies ends early, so no simulation is unbounded.

The previous 2026-10-14 acceptance run above was recorded against the old
1800-tick **skirmish** default; re-run the command above to regenerate
campaign-default evidence.

## Campaign batch acceptance evidence (AH-0MVD1RPPP001XJKN)

Final acceptance pass for the campaign batch (parent AC8/AC10), measured on a
dev machine (16 logical cores, 30 GB RAM, Node 22, `/tmp` = tmpfs) against the
real balance CSVs, competent policy, seeds 1–100:

```bash
npm run evaluate -- --batch --games 100 --out campaign-out
```

- **Runtime ≈ 5 min 23 s** (323 s wall; 351 s user CPU) — a practical
  full-campaign 100-game batch. Most runs stall at the finite `18000`-tick
  budget, so the cost is the simulation itself, not unbounded looping.
- **Peak resident memory ≈ 1.0 GB** (`/usr/bin/time -v` `Maximum resident set
  size` = 1,011,344 KB), and **flat in the game count**: 20 games → 958 MB,
  50 games → 997 MB, 100 games → 1.01 GB. The plateau is one run's telemetry
  (the arena's records are per run, then folded into the summary and streamed
  out), not the sweep — memory does not grow with `--games`.
- **Artifacts:** `balance-report.json` (40 KB), `balance-report.txt` (4.6 KB)
  and `runs.jsonl` (1,812,966 records, 2.2 GB) — all three written, with the
  JSONL streamed to disk run by run rather than buffered.
- **Progression distributions** (unchanged by this pass, recorded for
  completeness): `waveReached` mean 6.46 (min 2, max 10, sd 2.48);
  `levelReached` mean 1.15 (min 1, max 2, sd 0.36); per-choice-id
  `upgradesSelected` populated through the shared hold-full flow.
- **Full suite** (`run_tests.py --scope full`): 307 test files / 6,855 tests,
  0 failures at the commit implementing the streaming sink.

When this pass was first attempted, the CLI shell accumulated **every** run's
raw telemetry in one array before writing `runs.jsonl`, so a 100-game campaign
batch died with `JavaScript heap out of memory` after ≈9 min at 4.7 GB RSS
(5 games alone peaked at 1.4 GB). The shell now streams each run to disk via
the core's `telemetrySink`; the batch core (`runBatch`) still retains only
per-run summaries, and `executeEvaluation` no longer holds raw telemetry at
all on the streaming path. Both are covered by tests in
`src/ai/eval/cli.test.ts` (one sink chunk per run, in sweep order; streamed
chunks byte-identical to the in-memory `runs.jsonl` artifact).

## Related work

- Epic: **Automated Balancing** (AH-0MV1DLUZ8009OCJW).
- Same-seed evaluation harness: [`docs/EVALUATION.md`](./EVALUATION.md).
- Periodic human-experience validation
  (AH-0MV7WVHU0000U775): [`docs/EXPERIENCE_VALIDATION.md`](./EXPERIENCE_VALIDATION.md).
- Telemetry schema: [`docs/TELEMETRY.md`](./TELEMETRY.md).
- Config source of truth: `src/data/*.csv` + `src/core/configStore.ts`.
