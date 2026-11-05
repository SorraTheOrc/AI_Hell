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
  player is chasing. It sticks to the ship for `BLOCKED_DROP_STICK_SECONDS =
  1.5` s and is then thrown away at `BLOCKED_DROP_THROW_SPEED = 400` px/s until
  it leaves the screen (parent AH-0MW0UAQ23005AC9L), so a full loadout does not
  trail a permanent uncollectable icon; a slot freeing inside that window still
  collects the drop normally.
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
  choosing weapons and level-ups may reach the cap with no permanent Shield,
  Phase Shift or Magnet. This is the producer's **chosen** rule, **not a
  bug**: the shared pool is what gives each run a coherent build identity, and
  the exempt entries plus the owned level-ups keep the choice useful when the
  pool fills. A future change that splits the pool per family (or reserves
  slots) would be a design change with new evidence, not a fix.
- **Same rule in the game and the gyms.** The cap lives once in
  [`src/powerups/slots.ts`](../src/powerups/slots.ts) and is consumed by the
  shared drop draw (`drawNextDrop`, `src/scenes/core/dropLayer.ts`), the shared
  collection gate (`CombatCoreScene`), the hold-full choice builder
  (`buildChoiceCandidates`, `src/powerups/choice.ts`) and every other offer
  surface (`filterOptionsWithinSlotPool` for the choice/reward offers; the
  mini-boss wheel's wedges are derived directly from the same
  `resolvePlayerSlotState(...).ownedIds` accounting),
  so `PlayScene` and every gym behave identically (gym↔game parity) and a gym
  run is a valid place to observe the rule.
- **No reward screen can breach the cap.** The mini-boss reward (§4.4.4) is
  the spin-the-wheel upgrade reward: its wedges are built from the **held
  kinds** (`resolvePlayerSlotState(...).ownedIds`), and it has **no unlock
  half** (the run-scoped unlock feature was removed with the wheel rework,
  parent AH-0MVLISU03006WDOD AC5), so it can never grant a brand-new kind. The wheel population reads the same
  shared `ownedIds` accounting as the drop draw and the choice, so the six slots
  bound every acquisition path (drop, field pickup, hold-full choice and
  mini-boss wheel). With **nothing** owned the reward falls back to the
  hold-full-style three-option choice, which is itself built through the shared
  strategy and its six-slot gate, so the rule can never stall a paused overlay.
- **What the player sees: a slot budget and marked non-slot rows
  (AH-0MVVJRRN10038VFR).** The HUD upgrade list is a *display* list, not the
  loadout, so it can legitimately show rows that hold no slot: an exempt entry
  (Mystery UFO — `always available`) and a Phase Shift / Teleport row that
  survives outside the loadout after its temporary window expired (a Phase
  Shift charge pool on its remaining charges, a single-use Teleport on its
  ready-or-recharging warp — `charges only`). To keep the cap legible the HUD renders an explicit
  **`Loadout n/6`** budget from the shared model
  (`resolvePlayerSlotState(player)`), marks those non-slot rows, and renders
  them **dimmed** (`NON_SLOT_ROW_ALPHA`, half opacity) so the slot-counted
  rows are the ones a player counts — a non-slot row cannot be mistaken for a
  seventh upgrade (AH-0MVZ0GGW1004502H). Non-slot rows are also grouped below a
  **`Not in loadout`** heading rather than interleaved with the loadout, so the
  visible loadout list is contiguous and never longer than `used`
  (AH-0MVVF0POV001JNKX). It also gives every
  slot-held kind a row — including a temporary one-shot that previously showed
  none. The slot-counted rows therefore equal the model's `used` and never
  exceed `POWER_UP_SLOT_CAP`, and the same wiring (`combatHudOptions`) feeds
  `PlayScene` and every gym, so gym↔game parity holds for the display too.
  The row classes worth knowing: an exempt entry (Mystery UFO,
  `always available`) and a held kind surviving outside the loadout
  (`charges only` — a Phase Shift charge pool after its expired window, or the
  single-use Teleport's ready-or-recharging warp, including a Phase Shift row
  opened by a Teleport arrival)
  hold **no** slot; Extra Life has **no** row (the lives counter carries it);
  a temporary one-shot (Orbital Strike, Smart Bomb) holds a slot while its
  window is open and therefore renders a countdown row. A temporary **field
  pickup** must have a slot to fill: below the cap it opens a new counted
  slot, but at the cap a brand-new kind is refused by the shared collection
  gate (`isWithinSlotPool`) and only a pickup of a kind already held is
  admitted — it levels that kind's existing slot rather than opening a
  seventh.
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
  entries still come back; the replay itself restores the saved payload
  verbatim, by design (`Continue` must match the saved run exactly,
  AH-0MVSHI07B003BZIP). A legacy pre-cap save is therefore the one documented
  exception; every payload this build writes is capped on save.
- **A Hangar War deployment is gated too (AH-0MVVF0POV001JNKX).** The hangar
  lets a fleet own and equip more weapons than a run can hold, so
  `applyHangarWarDeployment` trims the deployment's starting weapons through the
  shared `capDropIdsToSlotPool` predicate
  ([`src/powerups/slots.ts`](../src/powerups/slots.ts)) before equipping them: a
  deployment starts within the same six-slot model as the arcade run and can
  never begin a run above `POWER_UP_SLOT_CAP` counted kinds.
- **How a "> six equipped" report is triaged (AH-0MVVF0POV001JNKX).** Because
  rows are not slots, a report is classified from a recording, not a row count:
  capture the run (a stock `npm run dev` auto-records to
  `recordings/session-<timestamp>.jsonl`; or `npm run record -- --auto`, stopping
  the recorder with Ctrl+C in its own terminal — closing the browser loses the
  buffer, recorder defect **AH-0MVVH57LL00038WQ**), replay it against
  `resolveSlotState(...)` (permanent kinds from the tick vector, temporary
  holdings from the `pickup` events plus each kind's TTL) and classify every row
  as slot-counted or not. A counted kind above six is a real gate bug on a named
  acquisition surface (drop draw, field collection, the hold-full choice, the
  mini-boss reward, checkpoint resume, a Hangar War deployment loadout or a
  capture setup); a `always available` / `charges only` row is the documented
  presentation, not a seventh slot.
- **Evidence scope.** Existing bot/batch evidence was recorded before the cap,
  so a late-game campaign run now sees a different loadout. Re-running and
  re-recording the bot batches is **out of scope** for the cap work item; it
  becomes a linked follow-up only if a gate fails. Recorded user stories and the
  producer decisions live on the parent work item (AH-0MVLIJT3M005HPHF).

### Mini-boss wheel reward — always pays out (AH-0MVLISU03006WDOD)

The mini-boss reward is a **power guarantee**, not an optional pick: every
mini-boss victory should leave the build meaningfully stronger. The wheel's
payout follows a literal **100-slot distribution** (`MINI_BOSS_WHEEL_DISTRIBUTION`
in [`src/powerups/miniBossWheel.ts`](../src/powerups/miniBossWheel.ts)):

| Slots | Outcome | Effect | Expected level-gains |
|-------|---------|--------|----------------------|
| 1 | **bonus** | +1 level to **every** owned permanent kind | `1 × owned` |
| 5 | **three-upgrade** | +1 level to 3 distinct owned kinds | `15` |
| 10 | **two-upgrade** | +1 level to 2 distinct owned kinds | `20` |
| 84 | **one-upgrade** | +1 level to 1 owned kind | `84` |

The expected number of level-gains per spin is therefore
`(1 × owned + 15 + 20 + 84) / 100 = 1.19 + 0.01 × owned` — always **≥ 1.19**
levels, and higher as the run owns more kinds (the bonus slot scales with the
build). Multi-upgrade slots pick **distinct** kinds where possible and repeat a
kind only when there are fewer owned kinds than picks, so a narrow build
concentrates its gains (one owned power-up on a three-upgrade slot gains +3
levels on it) while a broad build spreads them.

Balance consequences:

- **No zero-reward outcome.** There is **no level-cap filter** (parity with the
  hold-full choice's `buildOwnedLevelUpOptions`): the run-scoped level stores
  are unbounded and only the derived stat saturates, so every spin increments a
  level. A refusable or empty reward would recreate the perceived-nothing
  outcome this reward exists to remove.
- **The empty-owned fallback still pays out.** With no permanent kinds owned
  (possible at the level-1 mini-boss) the wheel is replaced by the
  hold-full-style **three-option** choice, so the 1/5/10/84 split never applies
  to an empty wheel.
- **The split is not rebalanced here.** Whether 1/5/10/84 keeps its value once
  average owned-kind counts and per-kind caps are considered is a follow-up
  balance question (recorded on the parent work item); the shipped split is the
  producer-approved reference.
- **Spin tension is cosmetic, not balance.** The ≈2.2 s fast-start/ease-out
  spin and the ≈0.45 s landed-wedge reveal change how the guaranteed payout is
  experienced, never what it is.

### Per-upgrade temporary TTLs — how long a field pickup lasts

A field pickup is a **temporary** level (GDD §4.4.3): it reverts when its own
temporary window expires. The window length (TTL) is **balance data**, a
property of the upgrade item rather than one global constant, resolved by the
single `resolveTemporaryWindow` helper in
[`src/powerups/powerUpLevels.ts`](../src/powerups/powerUpLevels.ts). Two
families share the rule:

- **Timed kinds** keep their existing level-resolved effect duration as the
  TTL, so the window levels up with the effect (Speed Boost 10 s → 20 s,
  Frenzy 8 s → 16 s, …). Nothing to tune separately.
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
| Shield | 15 | Absorbed-hit kind: the former level-scaled bubble window was retired, so the flat producer-approved TTL (Q-A2=a) applies instead (AH-0MVVD8SXO004QLZW). |
| Thorn Field | 8 | Absorbed-hit kind: the former level-scaled ram window was retired, so the flat producer-approved TTL (Q-A2=a) applies instead (AH-0MVVD8SXO004QLZW). |
| Force Field | 8 | Absorbed-hit kind: the former level-scaled bubble window was retired, so the flat producer-approved TTL (Q-A2=a) applies instead (AH-0MVVD8SXO004QLZW). |

Weapons obey the same rule with their own 10 s TTL, surfaced as
`resolveWeaponTemporaryWindow`. The values are deliberately short so a
temporary level can never compound across a wave, and they are **not** scaled
by the campaign-level supply curves above (those shape drop frequency, not
window length).

**Consumables are never clawed back.** Lives, Phase Shift charges and the
ready Teleport warp already granted by a temporary pickup survive the level
revert and never carry a timer of their own (producer Q2 on AH-0MVSTKGC3003OMAC).
Occupancy of a six-slot loadout still follows the window: the slot is released
when the TTL expires (see the loadout subsection above).

**Teleport is single-use — its recharge, not its TTL, is the balance lever**
(parent AH-0MVY096RT006QMF4). The 15 s TTL above is the *temporary-level
window*; the escape itself is one warp whose recharge interval is the
level-derived `teleportRechargeRate` axis (stored charges/second, inverted to
seconds by the store), so there is no stored-charge or stack count to tune:

| Teleport recharge axis | Level 0 | Upgrade cap | Curve |
|---|---:|---:|---|
| `teleportRechargeRate` (seconds per warp) | **60 s** | **20 s** | exponential-saturation, `k = 0.3` |
| `teleportPhaseDuration` (arrival phase) | 1.5 s | 3 s | exponential-saturation, `k = 0.2` |

60 s at level 0 makes evading a threat a real decision and the 20 s cap keeps
an upgraded escape from restoring near-permanent cover; the 3:1 base:cap ratio
is the pre-existing one, only the numbers moved. The retired cap-3 pool
(15 s → 5 s) is **not** a tuning surface any more: a pickup or a hold-full
grant simply readies the one warp, so no grant can exceed a cap of one and no
stack count exists to tune.

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
| `--watchdog <secs>` | Bounded-runtime guard: abort the run (exit `124`) once the budget is spent, restoring the CSV first. | `0` (off) |

The batch sweep itself uses the usual flags (`--games`, `--policies`,
`--ticks`, `--dt`, `--sample-every`, `--out`).

### Progress output and the runtime bound (AH-0MVSE1OPF008G1SB)

Every `--tune` run reports its progress on **stderr**, one line per completed
run plus the phase transitions:

```
[tune] baseline 1/2 seed=1 policy=competent
[tune] baseline 2/2 seed=2 policy=competent
[tune] edit applied: enemy-configs.csv boss.health 1 -> 7
[tune] candidate 1/2 seed=1 policy=competent
[tune] candidate 2/2 seed=2 policy=competent
[tune] comparing baseline and candidate
[tune] restoring the edited CSV
```

stdout keeps exactly the report it printed before, so artifact/print parity and
the determinism tests are unaffected. The lines come from the shared
`runBatch` per-run hook (`runBalanceBatch(options, {onRun})`), not a second
progress mechanism.

`--watchdog <secs>` (default `0` = off) bounds the run. The deadline is checked
at every phase boundary — hydrating the config, the baseline sweep, the edit,
the re-hydrate, the candidate sweep — and a timer records an expiry reached
while the run yields to the event loop. On expiry the CLI prints
`tune watchdog expired after <n> s during <phase>`, restores the CSV (and clears
the journal) and exits with code **`124`** — distinct from the fail-fast/usage
code `2` — so a scripted caller can tell a bound-trip from a validation error.

**Accepted limitation:** a *blocking* synchronous sweep that never yields to
the event loop cannot be interrupted by a timer. Such a stall is caught when
the sweep returns (the boundary check then trips), and the per-run progress
lines are the primary signal while it runs. The known 2026-10-21 hang is
removed by the fail-fast validation above rather than by the watchdog.

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
  write. A **pseudo-filesystem** target (procfs, sysfs, debugfs, tracefs,
  cgroup/cgroup2, devpts, securityfs, configfs, bpf, nsfs) is refused *before*
  it is touched, because a recursive `mkdir` there blocks for ever
  (AH-0MVWLQQKB0075A1U): the probe reads the filesystem type of the nearest
  existing ancestor with `statfsSync` and reports
  `output directory not writable: <dir> (unsupported filesystem type 0x<magic>)`
  — so the documented negative probe `--out /proc/nope/x` fails in ~0.3 s
  instead of hanging. The guard is fail-open: when `statfsSync` is unavailable
  or fails, the `mkdir` probe runs unchanged. The late `mkdirSync` before the
  artifact writes remains as an idempotent safety net. The measured pre-fix
  cost of the same invalid path was 4.31 s at 10 games × 2000 ticks and 11.82 s
  at 40 games × 2000 ticks (and 166.6 minutes for `/proc/nope/x`, which blocked
  the `mkdir` after both sweeps had already run).
- **Crash-safe edit journal (AH-0MVSE1A7O002PXAO):** before the first edited
  byte is written, the pre-edit bytes are persisted to
  `src/data/<file>.tune-journal` (written to a sibling temp file, `fsync`ed and
  atomically renamed, so a kill at any moment leaves either no journal or a
  complete one). The journal is removed after a successful restore, and with
  `--keep-edit` it is removed **without** restoring. An abort that lands
  between the journal write and the edit — the watchdog's `applying the CSV
  edit` boundary, or an edit that throws — reconciles the journal it wrote
  itself (each journal records the `pid` that wrote it, so a concurrent run's
  journal is never touched), restoring the CSV and removing the journal. A
  finished run therefore never leaves one behind; only a hard-killed process
  does, and that is what the next invocation reconciles. The journal is
  git-ignored (`src/data/*.tune-journal`), so a crashed run leaves no worktree
  change.

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
- `scripts/evaluate-failfast.test.ts` — the up-front `--out` / `--tune` CSV
  probes, the CLI exit codes for each failure path, and the proof that the
  validation runs **before** the SSR core boots (a mocked `vite` boot is never
  attempted) (AH-0MVSE18XX006ZG5I).
- `scripts/csvEditJournal.test.ts` — the crash-safe journal: atomic write,
  restore-from-journal, `--keep-edit` clear, the unreadable-journal refusal, a
  real `SIGKILL`ed editing child whose CSV is restored byte-identically, the
  reconcile-before-validate behaviour of the next `--tune` run, and the
  `.gitignore` guard (AH-0MVSE1A7O002PXAO).
- `scripts/evaluate-tune-progress.test.ts` — the per-run progress lines on
  stderr (stdout parity), the opt-in `--watchdog` exit `124` with a restored
  CSV, and the rejected budgets (AH-0MVSE1OPF008G1SB).
- `src/ai/eval/balancingDocs.test.ts` — this document's contract.
- `scripts/tune-verify.e2e.test.ts` — the gated end-to-end tune loop
  (`/skill:test --type e2e`).

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

## Weapon tuning CSV (AH-0MW0Q01VM004EPY7)

The player-weapon catalogue is **data**. Every tunable value for the sixteen
weapons lives in committed files that are parsed once at module load
(`src/utils/weapons.ts` → `parseWeaponCatalogue` in `src/core/csv.ts`), checked
by runtime invariants (`src/utils/weaponCatalogue.ts`) and bundled into the
build (`?raw` imports in `src/core/bundledConfig.ts`), so the shipped game is
read-only. Retuning a bullet colour, a bullet size, an impact cue or a Nova
blast radius needs no TypeScript edit.

### The three data files

| File | Shape | Holds |
|---|---|---|
| [`src/data/weapons.csv`](../src/data/weapons.csv) | one row per weapon, one cell per column | every scalar tunable: colours, bullet size and lifetime, damage/bounce/split budgets, the AOE/orbit/hitscan descriptors, and the muzzle/impact feedback |
| [`src/data/weapon-patterns.csv`](../src/data/weapon-patterns.csv) | long format, one row per pattern bullet | the heading-relative shot angles (`angleDeg`) and the perpendicular side offsets (`sideOffsetPx`) |
| [`src/data/weapon-levels.json`](../src/data/weapon-levels.json) | `weaponId` → ordered rungs of `{ k, n, rotation }` | the **live fire cadence** — the Euclidean ladder documented in [Weapon Euclidean upgrade ladder](#weapon-euclidean-upgrade-ladder-ah-0mvya291j000ck64) |

The sixteen catalogue ids, in catalogue order, are `cannon`, `spread`, `dual`,
`rapid`, `wave_laser`, `ricochet`, `cluster`, `options`, `nova`, `mortar`,
`arc`, `rear_guard`, `broadside`, `railgun`, `shard_swarm` and `heavy_slug`.
Every file lists them in that order, and an `id` cell must be one of them.

### `weapons.csv` columns

One table row per column, in the committed header order. "Required" means the
cell must be non-blank on every row; "optional" means a blank cell is legal
(and means something — see [Blank means absent](#blank-means-absent)).

| Column | Meaning | Units and legal values |
|---|---|---|
| `id` | Weapon id — the row's key. | One of the sixteen ids listed above. Required. |
| `name` | Display name (weapon HUD, help overlay, choice offer). | Free text; quote it if it contains a comma. Required. |
| `description` | One-line player-facing effect description. | Free text; quote it if it contains a comma. Required. |
| `subdivisions` | Shots per beat on the 80 BPM grid (`2` = double time, `0.5` = half time). | Positive and an exact subdivision or multiple of the 750 ms beat period (`0.25`, `0.5`, `1`, `2`, `3`, `4`, …). Required. This is the **legacy nominal** cadence, not the live one. |
| `bulletColor` | Bullet colour. | `0xrrggbb` (six hex digits, lower case in the committed file). Required. |
| `bulletShape` | Bullet visual shape. | A `BulletShape` enum value (full list below). Required. |
| `bulletSize` | Bullet radius multiplier. | Number > 0. Required. |
| `bulletLifetime` | Bullet lifetime (effective range = bullet speed × lifetime). | Seconds, > 0. Required. |
| `bulletShapeLength` | Long-axis multiplier for elongated shapes. | Number ≥ 0. Optional. |
| `bulletRim` | Neon rim/outline colour. | `0xrrggbb`. Optional. |
| `bulletThickness` | Stroke-thickness multiplier for stroked shapes. | Number ≥ 0. Optional. |
| `bulletTrail` | Trail length. | Multiple of the bullet radius, ≥ 0. Optional. |
| `bulletFlame` | Exhaust-flame length. | Multiple of the bullet radius, ≥ 0. Optional. |
| `maxHitPoints` | Pass-through hit-point budget, spent one hit point per hit. | Number ≥ 0 (a whole count in practice). Optional (blank = no budget, the bullet expires on first hit). |
| `bounce` | Wall-bounce budget before the bullet expires. | Number ≥ 0 (a whole count). Optional (blank = no bounce). |
| `splits` | Radial warheads spawned once on impact/expiry. | Number ≥ 0 (a whole count). Optional (blank = no split). |
| `orbitPods` | Orbiting satellite-pod count. **Opens** the orbit group. | Number ≥ 1 (a whole count). Optional (blank = no orbit). |
| `orbitRadius` | Orbit radius around the ship. | px, > 0. Required when `orbitPods` is present. |
| `aoeTrigger` | When the area effect resolves. **Opens** the AOE group. | `onFire`, `onImpact`, `onRandom` or `screenPulse` (list below). Optional (blank = no AOE). |
| `aoeRadius` | Effect radius. | px, > 0. Required when `aoeTrigger` is present. |
| `aoeDamagesEnemies` | Does the effect damage enemies inside the radius? | `true` or `false` (`1`/`0` are also accepted). Required when `aoeTrigger` is present. |
| `aoeClearsEnemyBullets` | Does the effect clear enemy bullets inside the radius? | `true` or `false`. Required when `aoeTrigger` is present. |
| `aoeDamage` | Hit points each affected enemy takes per resolution. | Number ≥ 0 (a whole count). Optional AOE extra. |
| `aoeChains` | Extra targets an `onFire` effect may chain to. | Number ≥ 0 (a whole count). Optional AOE extra. |
| `aoeProjectileSpeed` | Projectile speed, required to sample an `onRandom` range. | px/s, > 0. Optional AOE extra. |
| `hitscanLength` | Beam length. **Opens** the hitscan group. | px, > 0. Optional (blank = no beam). |
| `hitscanDuration` | How long the resolved beam stays visible. | Seconds, > 0. Required when `hitscanLength` is present. |
| `hitscanAimBias` | Probability a shot aims at the nearest living enemy instead of a uniform random direction. Grows with weapon level through the Homing curve. | Number in `[0, 1]`. Required when `hitscanLength` is present. |
| `muzzleColor` | Launch-flash colour. **Opens** the muzzle-flash group. | `0xrrggbb`. Optional; defaults to `bulletColor`. |
| `muzzleRadius` | Launch-flash core radius. | px, > 0. Optional; default `7`. |
| `muzzleDuration` | Launch-flash fade duration. | Seconds, > 0. Optional; default `0.12`. |
| `impactColor` | Impact-flash colour. **Opens** the impact group. | `0xrrggbb`. Optional (blank = no impact flash, the generic warm-white fallback applies). |
| `impactRadius` | Impact-flash radius. | px, > 0. Required when `impactColor` is present. |
| `impactDuration` | Impact-flash fade duration. | Seconds, > 0. Required when `impactColor` is present. |
| `impactCue` | Baked impact cue export name. | A cue exported by `src/audio/effects.ts` (e.g. `playCannonImpactSound`). Required when `impactColor` is present. |

Hex colours are validated case-insensitively, but the committed files are
written in lower case: `npm run generate:weapon-csv-seed` serialises through the
codec, and the seed test compares the file bytes, so an upper-case cell fails
that guard even though it parses.

**`bulletShape` legal values.** `circle`, `disc`, `line`, `teardrop`, `missile`,
`ring`, `shell`, `heavy-shell`, `shard`, `bolt`, `phaser-bolt`, `fleck`, `dart`,
`boss-pellet`, `spiral-pellet`, `pulse-ring`, `tracer`, `warhead`, `diamond`,
`spark`, `chevron`, `pellet`. `disc` is an alias of `circle` (the uniqueness
invariant compares the *canonical* shape family, so the two cannot be used to
smuggle in a duplicate).

**`aoeTrigger` legal values.** `onFire`, `onImpact`, `onRandom`, `screenPulse`.

### `weapon-patterns.csv` columns

One row per pattern bullet, grouped by weapon; `index` must be a contiguous
0-based sequence within each weapon.

| Column | Meaning | Units and legal values |
|---|---|---|
| `weaponId` | Weapon the row belongs to. | One of the sixteen catalogue ids. Required. |
| `index` | Bullet position within the pattern. | Non-negative whole number, 0-based. Required. |
| `angleDeg` | Angle relative to the ship's heading. | **Degrees**, negative = anticlockwise. Required; converted to radians on parse. |
| `sideOffsetPx` | Perpendicular positional offset (e.g. Dual's two parallel bullets). | px, may be negative. Optional; a blank cell means centred. |

Angles are authored in **degrees** because that is what a spreadsheet and a
level designer can read; the codec converts them with `(degrees × π) / 180` at
the boundary (`parseWeaponPatterns` in `src/core/csv.ts`) and the engine works
in **radians** everywhere after that. Edit `angleDeg`, never a radian value.

### The designer workflow

**By hand (either file).**

1. Open `src/data/weapons.csv` (or `src/data/weapon-patterns.csv`). The `#`
   block above the header lists every column; keep its wording in step with any
   schema change.
2. Change cells, keeping the canonical formatting: lower-case `0xrrggbb`
   colours, plain decimal numbers (`2`, `0.75` — not `2.0`), `true`/`false`
   booleans, and an **empty** cell where the weapon has no such capability.
3. Save and refresh the `npm run dev` page. The files are bundled with `?raw`
   and parsed at module load, so a refresh re-reads them and every consumer
   (`Player`, the shared combat core, every gym) fires the new value on the
   next shot.
4. Verify the change (the worked examples below), then run the retune
   tripwires listed under [Verifying a change](#verifying-a-change).
5. Normalise the committed file with `npm run generate:weapon-csv-seed` — it
   re-serialises the parsed catalogue through the same writer the panel uses —
   and regenerate the frozen fixtures as part of the deliberate change.

**From the panel (dev only).**

1. Gym Index → **WeaponTuning** (the panel titled **Weapon Tuning**,
   `src/scenes/gym/GymWeaponTuning.ts`).
2. Select a weapon and change a control. Every input applies to the live
   catalogue as a draft, and the preview ship fires the edited definition on
   its next shot against an inert target — the preview runs the shared combat
   core, so it cannot drift from the game.
3. **Save** upserts the selected row into `src/data/weapons.csv` through the
   dev-only CSV plugin and then re-reads both weapon files, so the running
   catalogue is exactly the file just saved. **Save As** appends a row under a
   new id and is refused unless that id already has a code fallback definition
   (an icon arm in `src/powerups/icons.ts` and an audio cue arm in
   `src/audio/effects.ts`) — a bare CSV row cannot add a weapon.
4. The rhythm section of the panel is **read-only**: it renders the selected
   weapon's ladder rungs from `WEAPON_EUCLIDEAN_LADDERS`, auditions them, and
   states that cadence is authored in `src/data/weapon-levels.json`. There is
   deliberately no fire-rate control.

**Production is read-only and needs a rebuild.** The CSV cells are inlined
into the bundle at build time, so a shipped build keeps the values it was built
with: a retune reaches production only after `npm run build` and a redeploy.
The write endpoint exists only under `npm run dev`; in a production or static
build **Save**/**Save As** are disabled and the panel shows the message
`Weapon writes are unavailable in production builds (read-only CSV).` Nothing
is fetched or written at runtime.

### Blank means absent

**A blank cell means the weapon has no such capability** — it is never read as
`0`. That matters because the combat core dispatches on the **presence** of a
descriptor: a `0` bounce budget, a zero-radius AOE or a `false`
`aoeDamagesEnemies` would be a live descriptor with inert behaviour instead of
no descriptor at all. The coercion therefore omits a blank optional cell
entirely, and presence-based dispatch keeps working unchanged. An explicit `0`
is preserved (and, in a descriptor group, flagged as a data smell by the
invariants — the cell should simply be blank).

Descriptors are **all-or-nothing groups**, declared by an opening column:

| Group | Opening column | Other columns in the group |
|---|---|---|
| orbit | `orbitPods` | `orbitRadius` |
| AOE | `aoeTrigger` | `aoeRadius`, `aoeDamagesEnemies`, `aoeClearsEnemyBullets` (required); `aoeDamage`, `aoeChains`, `aoeProjectileSpeed` (extras) |
| hitscan | `hitscanLength` | `hitscanDuration`, `hitscanAimBias` |
| muzzle flash | `muzzleColor` | `muzzleRadius`, `muzzleDuration` (both have defaults) |
| impact | `impactColor` | `impactRadius`, `impactDuration`, `impactCue` |

A group's opener present and non-blank authors the group, so its required
members must be non-blank too. An opener cell that is blank while every other
cell in the group is blank means the group is absent (a header may list a group
nobody uses). A member cell with the opener absent is a diagnostic: it belongs
to a descriptor that was never opened. The muzzle flash is the one group that is
always present — its colour defaults to `bulletColor` and its radius/duration to
`7`/`0.12` — so `muzzleColor` is a pure override.

### Fire rate: shots per beat, on the beat grid

`subdivisions` is authored as **shots per beat** on the shared 80 BPM grid,
and the runtime interval is derived, never stored:
`fireRateMs = beatPeriodMs(80) / subdivisions` (`src/utils/beat.ts`). The value
must stay **on the beat grid** — an exact subdivision or multiple of the beat
period — which `isOnBeatGrid` enforces catalogue-wide. An off-grid cell (for
example `1.37`) is rejected and the weapon falls back to its code default, so a
hand edit can never desynchronise a weapon from the clock everything else moves
on (the same lattice the Euclidean ladders step on, see
[Weapon Euclidean upgrade ladder](#weapon-euclidean-upgrade-ladder-ah-0mvya291j000ck64)).

**This cell is the legacy nominal cadence, not what you hear.** It drives the
level-stat quantisation and the hold-full ghost metronome interval only. The
**live** firing cadence is the Euclidean ladder in
`src/data/weapon-levels.json` (resolved by `resolveWeaponPattern` in
`src/utils/weaponLevels.ts`), which is why the ladder section below says that
file — not `weapons.csv` `subdivisions` — is the fire rate. A dev-only boot
diagnostic (`src/utils/weaponDataDiagnostics.ts`) reports where the two
disagree, so editing the wrong surface is visible rather than folklore.

### Runtime invariants and the code fallback

The guarantees that used to be compiler-enforced are re-asserted against the
**parsed catalogue** at module load (`src/utils/weaponCatalogue.ts`, applied by
`applyWeaponCatalogueGuards`):

- **On-beat grid** — every derived `fireRateMs` is an exact subdivision or
  multiple of the beat period.
- **Unique bullet colour** — no two weapons share `bulletColor`.
- **Unique shape family** — no two weapons resolve the same canonical shape
  (`disc`/`circle` collapse to one family). The single documented allowance is
  the Dual / Wave Laser `line` beam pair, encoded as data with a reason.
- **Sane magnitudes** — positive size/lifetime, non-negative budgets and AOE
  radius, positive orbit radius, 24-bit colours.
- **Structural coherence** — an AOE/orbit descriptor carries its companion
  radius, and a degenerate `0` budget is flagged.

A row that is missing, malformed or invariant-breaking falls back to its **code
default** in `DEFAULT_WEAPON_CATALOGUE` (`src/utils/weapons.ts`) — for that
weapon only, so one bad cell never changes the other fifteen. The fallback
applies in **every** environment, not only production: the game and the gyms
must run the same roster, and a dev-only broken roster is exactly the
split-source divergence the parity rule forbids. Boot never throws — the game
still boots and degrades to the shipped values — and the load report
(`WEAPON_CATALOGUE_LOAD_REPORT`) records which ids came from data and which fell
back. Under `npm run dev` a boot diagnostic
(`warnOnWeaponDataDivergences` in `src/utils/weaponDataDiagnostics.ts`) logs one
`console.warn` naming the file, the weapon and the problem, so a typo is
visible instead of silently ignored.

### What each surface cannot do

| Surface | Cannot | Follow-up |
|---|---|---|
| `src/data/weapons.csv` | **Add a weapon.** A row whose `id` is not one of the sixteen is rejected; a new weapon needs the `WeaponId` union, an icon arm in `src/powerups/icons.ts`, an audio cue arm in `src/audio/effects.ts`, and a code fallback definition (which is exactly what **Save As** checks for). | Create a work item for the new weapon; the CSV can then tune it. |
| `src/data/weapons.csv` | **Cannot change the fire cadence.** `subdivisions` is the legacy nominal value only. | Edit the rung in `src/data/weapon-levels.json`. |
| `src/data/weapons.csv` | **Change the level ladder** (rungs, rotations, threshold curve). | Same file: `src/data/weapon-levels.json`; the `fireRate` curve lives in `WEAPON_UPGRADE_SPECS` (`src/utils/weaponLevels.ts`). |
| `src/data/weapon-levels.json` | **Add a weapon.** A weapon with no entry (or a malformed one) falls back to its in-code ladder, and the catalogue still has no row for it. | The new-weapon path above. |
| `src/data/weapon-patterns.csv` | **Add a weapon.** Rows for an unknown `weaponId` are rejected. | The new-weapon path above. |

`src/data/weapon-levels.json` cannot add a weapon either: an entry tunes the
cadence of an existing catalogue id, and a weapon the catalogue does not carry
still has no icon arm and no audio cue arm, so it could never be dropped or
drawn. Neither file can change the level ladder's activation curve: that is
the `fireRate` spec in `WEAPON_UPGRADE_SPECS` (`src/utils/weaponLevels.ts`).

The catalogue keeps its exported name and type
(`Record<WeaponId, WeaponDefinition>`), so every consumer — `Player`, the shared
combat core, the drop layer, the gym help and the gyms — reads the data without
changing.

### Worked examples

**1. Change a bullet colour (Cannon).** In `src/data/weapons.csv`, find the
`cannon` row and change `bulletColor` from `0x00ffff` to `0xff00ff`; save,
refresh `npm run dev`, and fire — the bullets are magenta. Or do it live: Gym
Index → **WeaponTuning**, select Cannon, use the colour input, watch the
preview, press **Save**. Verify the change took effect by firing in the game
and in **GymWeapons** (both read the same catalogue), and then run the retune
tripwires — the frozen catalogue fixture will fail until it is regenerated as
part of the deliberate change.

**2. Change a fire rate (Cannon, level 0).** Edit the first rung in
`src/data/weapon-levels.json` — for example `{ "k": 9, "n": 16, "rotation": 0
}` → `{ "k": 10, "n": 16, "rotation": 0 }` — save and restart/refresh
`npm run dev` (the ladders are built at module load). Audition it in Gym Index
→ **Rhythm**, or in the tuning panel's read-only rhythm section, and update the
machine-verified ledger table in the ladder section below: the suite compares
that table row-for-row against `WEAPON_EUCLIDEAN_LADDERS`, so a rung edit that
is not mirrored there fails. Regenerate `src/data/weapon-levels-parity.json` in
the same change.

**3. Change the Nova AoE radius.** In `src/data/weapons.csv`, find the `nova`
row and change `aoeRadius` (shipped: `34`) to, say, `44`; save and refresh
`npm run dev`. Keep the AOE group whole — `aoeTrigger`, `aoeRadius`,
`aoeDamagesEnemies` and `aoeClearsEnemyBullets` are authored together. Trigger a
Nova in **GymWeapons** (it demonstrates the shared AOE ring) or in
**WeaponTuning** (select Nova and fire at the dummy target): the ring should
clear enemies and bullets out to the new radius. A blank radius with a trigger
present is rejected and falls back to the code default instead of shipping a
zero-radius blast.

### Verifying a change

The suite is the tripwire, and each guard answers a different question:

| Guard | Pins |
|---|---|
| `src/data/weaponsCsvSeed.test.ts` | the committed files parse with zero diagnostics, deep-equal the resolved catalogue, keep every column documented in the `#` block, and are **byte-identical** to `npm run generate:weapon-csv-seed` |
| `src/data/weaponCatalogueParity.test.ts` | the resolved catalogue is deep-equal to the frozen snapshot `src/data/weapon-catalogue-parity.json` |
| `src/data/weaponLevelsParity.test.ts` | `resolveWeaponPattern(weaponId, level)` for all sixteen weapons at levels 0–10 equals `src/data/weapon-levels-parity.json` |
| `src/utils/weaponLevels.test.ts` | the machine-verified ladder ledger in this document, row for row against the resolved ladders |
| `src/weaponDataRetuningDocs.test.ts` | this guide: every column, enum value and workflow claim above |
| `src/utils/weaponsCatalogueLoad.test.ts` | the runtime roster covers all sixteen ids and the load report names what fell back |

The two parity fixtures are **frozen snapshots**, not comparisons against the
current fallback: they are the safety net that makes a typo a failing test
rather than a silent retune. A deliberate balance change regenerates them in
the same commit (a one-off snapshot of `WEAPON_CATALOGUE` /
`resolveWeaponPattern` loaded through `vite.ssrLoadModule`, written with
`JSON.stringify(value, null, 2)`), so the fixture diff is the reviewable record
of exactly what moved. Never regenerate a fixture to make an accidental edit
pass: read the diff first.

## Weapon Euclidean upgrade ladder (AH-0MVYA291J000CK64)

Every weapon's fire cadence is a deterministic **Euclidean rhythm**
`E(k, n)` — `k` onsets distributed as evenly as possible over a tile of `n`
steps — phase-shifted by a whole number of steps (`rotation`). The unit of a
step is the shared **16th-note lattice** at the default 80 BPM
(187.5 ms per step; the same lattice `src/utils/beat.ts` schedules against), so
a `n = 16` tile spans one 4-beat bar. At another tempo the step scales with
`beatPeriodMs(bpm)`; the `(k, n, rotation)` shape is tempo-independent. The
pure resolver is `resolveWeaponPattern(weaponId, level)` in
`src/utils/weaponLevels.ts`; the catalogue is `WEAPON_EUCLIDEAN_LADDERS`.

### Where the ladders are authored — `src/data/weapon-levels.json`

**AH-0MW0Q1TQV009M8AO.** The authored rungs are **data**, not TypeScript.
`src/data/weapon-levels.json` maps every weapon id to its ordered rung list:

```json
{
  "cannon": [
    { "k": 9, "n": 16, "rotation": 0 },
    { "k": 10, "n": 16, "rotation": 0 },
    { "k": 13, "n": 16, "rotation": 0 }
  ]
}
```

- **Key:** `weaponId` — all sixteen shipped weapons must be present.
- **Rung:** `{ k, n, rotation }`. `k` onsets are distributed as evenly as
  possible over a tile of `n` steps, phase-shifted by `rotation` whole steps;
  `1 <= k <= n` and `0 <= rotation < n` (all three are whole numbers).
- **`stepMs` is not authored.** Every rung steps on the shared 16th-note
  lattice — 187.5 ms at the 80 BPM default, scaled with `beatPeriodMs(bpm)` at
  other tempos — so the loader injects `stepMs = SIXTEENTH_NOTE_STEP_MS` and a
  data edit can never desynchronise a rung from the beat grid.
- **Order:** rungs are listed in level order. A rung's **activation level is
  derived, never authored**: it is the first level whose desired density
  (`level-0 rung density × curveValue(WEAPON_UPGRADE_SPECS.fireRate, level)`,
  base 1×, cap 2.2×, `k = 0.12`) supports the rung, and never earlier than one
  level after the previous rung. Rungs at or above the 2.2× asymptote are
  omitted (the exponential curve approaches their density but never reaches
  it). Editing a rung therefore also moves the upgrade thresholds that follow
  it.

**Load order and fallback precedence.** The bundled file is imported as raw
text (`src/core/bundledConfig.ts` → `?raw`) and parsed **once at module load**
in `src/utils/weaponLevels.ts`:

1. the parsed JSON rungs are the runtime ladders;
2. a weapon whose entry is **missing or malformed** falls back to the
   pre-migration in-code ladders (`CODE_WEAPON_EUCLIDEAN_LADDER_SPECS`) — for
   that weapon only, so one bad rung never changes the other fifteen;
3. `WEAPON_LEVELS_LOAD_REPORT` records what came from data and what fell back,
   and the dev-only boot self-check (`warnOnWeaponDataDivergences`) logs one
   `console.warn` naming the file, the fallback weapons and the parse
   diagnostics. Boot never throws: malformed or missing data degrades to the
   shipped code ladders instead of crashing the game.

**Workflow.** Edit a rung, restart `npm run dev` (the ladders are built at
module load) and the new rhythm is live — no TypeScript edit and no source
rebuild. The machine-verifiable ledger below reflects the result on the next
test run. `src/data/weapon-levels-parity.json` freezes
`resolveWeaponPattern(weaponId, level)` for all sixteen weapons at levels 0–10
and `src/data/weaponLevelsParity.test.ts` asserts it, so an accidental retune
while editing data fails the suite: regenerate the fixture only as part of a
deliberate balance change.

**Single source of truth for cadence.** `weapon-levels.json` is the only
surface that authors how a weapon's rhythm evolves across levels — it *is* the
fire rate. `weapons.csv` `subdivisions` remains the **legacy nominal** value
(level-stat quantisation and the hold-full ghost metronome interval); the dev
boot diagnostic reports where the two disagree and names
`src/data/weapon-levels.json` as the cadence source, so the divergence is
visible rather than folklore. The three deliberate divergences (`cannon`,
`rapid`, `railgun`) are registered in `DELIBERATE_CADENCE_DIVERGENCES`
(`src/utils/weaponDataDiagnostics.ts`) with their reason, so a dev boot is
silent for the committed data while any *undocumented* drift — or a stale
registry entry — still warns. The strength measurement
(`src/utils/weaponStrength.ts`) reads the same live ladder, not the nominal
`fireRateMs`, so a "cadence" in this document always means what the scheduler
plays. The designer-facing schema, file shape and worked
retune examples for all three data files are in
[Weapon tuning CSV](#weapon-tuning-csv-ah-0mw0q01vm004epy7) above.

The generator that turns a tile into onset steps, and the helpers that turn
those steps into exact tick times, live in `src/utils/euclid.ts`
(`euclidPattern`, `stepIndexAt`, `isOnset`, `nextOnsetTick`,
`nextOnsetDelayMs`, on the shared `euclidStepMs()` 16th-note step derived from
`beatSubdivisionMs` in `src/utils/beat.ts`; AH-0MVYA1VHT004L2O0). Canonical
fixtures and the rotation convention (rotation 0 roots at step 0, so the
published `E(5,8) = x.xx.x.x` is the shipped `x.xx.xx.` rotated by five steps)
are pinned by `src/utils/euclid.test.ts`.

**Density is the invariant.** Effective density is
`k / (n × stepMs)` onsets per millisecond, reported by
`euclideanOnsetsPerMinute(pattern)` (and per beat through
`euclideanOnsetsPerBeat`). A fire-rate upgrade must never reduce density:
onsets-per-minute are monotonic non-decreasing in level for every weapon, while
the **shape** (`k`, `n`) and **phase** (`rotation`) may change. Two equal-density
morphs are deliberate:

- **bar-halving** — the tile `n` halves (e.g. `cannon` `E(16,16)` → `E(8,8)`) so
  the same density repeats twice per bar instead of once: a shape change, not a
  speed change;
- **rotation** — a level moves the same `(k, n)` pattern's phase (e.g. `dual`
  `E(4,16) rot 0` → `E(4,16) rot 2`, and `arc` `E(9,16) rot 4` → `rot 6`), so the
  density is identical and only the groove's alignment moves.

**Curve-derived rungs.** Each rung becomes active at the first level where the
shipped `fireRate` exponential-saturation curve (base 1×, cap 2.2×, `k = 0.12`)
desires at least that rung's density, and never earlier than one level after the
previous rung. The desired density is
`baseDensity × curveValue(WEAPON_UPGRADE_SPECS.fireRate, level)`
(`weaponPatternDesiredOnsetsPerBeat`). Because the curve is monotonic, so is the
ladder. Rungs at or above the 2.2× asymptote are omitted: the exponential curve
approaches but never reaches it, and the 16th-note lattice itself caps a v1
pattern at one onset per step (4 onsets/beat).

**Legacy parity.** A degenerate straight pattern (`k === n`) is all-onsets, so
its step interval is exactly the legacy on-grid interval. `straightEuclidean`
builds that form for any `quantiseSubdivision` rate (e.g. subdivision 2 → an
onset every 375 ms; subdivision 0.5 → every 1 500 ms), and `quantiseEuclidean`
returns the same degenerate form whenever the desired rate is already an on-grid
subdivision. Every shipped fire rate therefore remains available as the
all-onsets subset of the ladder.

**Canonical six-weapon superposition.** At level 0 the canonical fixture is
`heavy_slug E(1,16)`, `railgun E(2,16)`, `cannon E(9,16)`, `arc E(4,16 rot 4)`,
`rapid E(13,16)` and `shard_swarm E(2,16)`: **31 onsets per bar** in total
(1 + 2 + 9 + 4 + 13 + 2), pinned by
`src/utils/weaponLevels.test.ts`. The cannon and the arc no longer share
`k = 9`: the `<= 60 %` level-0 budget takes the arc down to a straight
one-shot-per-beat rung, so the bar's uneven tiles are the cannon's `E(9,16)`
and rapid's `E(13,16)` (see [the level-0 cadence
retime](#the-level-0-cadence-retime-ah-0mw23fedk006brhk) below).

The **Rhythm gym** (`src/scenes/gym/GymRhythm.ts`) auditions this exact fixture
through the shipped scheduler, drawing the sixteen-step onset stack from the
live `Player.getFirePattern` data; its playhead reads the shared beat clock and
every recorded fire is the scheduler's own onset tick, so the gym and the game
cannot drift (`src/scenes/gym/GymRhythm.test.ts`).

### The level-0 cadence retime (AH-0MW23FEDK006BRHK)

The **live** cadence of every non-cannon weapon was trimmed to the nominal
`subdivisions` already authored for it — the level-0 output trim
(AH-0MVWAVKS0005P9VN) reached the catalogue's *nominal* table only, so the
shipped game was firing 10 of its 15 non-cannon weapons faster than the strength budget
described. Each affected weapon's **whole ladder** was then scaled by the same
factor as its level-0 rung and snapped up to a whole `k` on the 16-step tile,
so the curve-derived `minLevel` thresholds and every producer-approved ceiling
(`level1GrowthMultiple` 2.5×, `levelCapShareOfPreChange` 50 %) are
**mathematically unchanged** — only the absolute density moved.

| Weapon | Level-0 rung before | after | Onsets/beat | Live cut |
|---|---|---|---|---|
| `spread`, `options` | `E(4,16)` | **`E(2,16)`** | 1 → 0.5 | 2× slower |
| `dual`, `ricochet` | `E(4,16)` | **`E(2,16)`** | 1 → 0.5 | 2× slower |
| `wave_laser` | `E(4,16)` | **`E(2,16)`** | 1 → 0.5 | 2× slower |
| `rear_guard` | `E(8,16)` | **`E(4,16)`** | 2 → 1 | 2× slower |
| `cluster`, `broadside` | `E(2,16)` | **`E(1,16)`** | 0.5 → 0.25 | 2× slower |
| `arc` | `E(9,16)` | **`E(4,16)`** | 2.25 → 1 | 2.25× slower |
| `heavy_slug` | `E(3,16)` | **`E(1,16)`** | 0.75 → 0.25 | 3× slower |
| `shard_swarm` | `E(10,16)` | **`E(2,16)`** | 2.5 → 0.5 | 5× slower |

Consequences, all deliberate and test-pinned:

- **The arc leaves the superposition set.** The `<= 60 %` level-0 budget forces
  `E(9,16) → E(4,16)`, a straight (degenerate) rung; the arc's phase morph
  (`rot 4 → rot 6`) survives, and `shard_swarm`/`heavy_slug` likewise become
  straight at level 0.
- **The wave laser's curve-flattening carve-out becomes real.** Its catalogue
  `subdivisions` was already halved to 0.5 by AH-0MVWAVL6R001UI60 because the
  beam has no projectile lever, but the live ladder never received it. The
  live cut is required for a second reason: with the cadence measured live its
  old saturated rung `E(8,16)` scored 66.7 % of the pre-change level cap,
  breaching the 50 % ceiling.
- **The railgun's top of ladder is trimmed, not its base.** Its level-0
  `E(2,16)` rung is inside the level-0 budget (40 % of baseline, 0.33× the
  cannon), but its old saturated rung `E(5,16)` scored 55.6 % of the pre-change
  cap once measured live, so the ladder now ends at `E(3,16)`.
- **Sparse ladders lose rungs.** A 2.2× fire-rate asymptote can carry only
  whole-`k` steps above a small base: `cluster`, `broadside`, `heavy_slug` and
  `railgun` keep two rungs, `spread`/`options`/`wave_laser`/`shard_swarm` three.
- **Three nominal divergences remain, all documented** — `cannon` (2 vs 2.25),
  `rapid` (3 vs 3.25) and `railgun` (0.25 vs 0.5) — because their level-0
  superposition rungs are inside the budget. They are registered in
  `DELIBERATE_CADENCE_DIVERGENCES`, so the dev boot diagnostic is silent for
  the committed data and still warns for any other drift.

**Machine-verifiable ledger.** The table below is the complete resolved
ladder — one row per rung, in level order. It is compared row-for-row against
`WEAPON_EUCLIDEAN_LADDERS` by the test suite, so a code change that is not
mirrored here fails the suite (and vice versa).

<!-- euclidean-ladder:start -->
| Weapon | Level | k | n | Rotation | Step (ms) | Onsets/beat | Onsets/min |
|--------|-------|---|---|----------|-----------|-------------|------------|
| `cannon` | 0 | 9 | 16 | 0 | 187.5 | 2.25 | 180 |
| `cannon` | 1 | 10 | 16 | 0 | 187.5 | 2.5 | 200 |
| `cannon` | 4 | 13 | 16 | 0 | 187.5 | 3.25 | 260 |
| `cannon` | 9 | 16 | 16 | 0 | 187.5 | 4 | 320 |
| `cannon` | 10 | 8 | 8 | 0 | 187.5 | 4 | 320 |
| `spread` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `spread` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `spread` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `dual` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `dual` | 1 | 2 | 16 | 2 | 187.5 | 0.5 | 40 |
| `dual` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `dual` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `rapid` | 0 | 13 | 16 | 0 | 187.5 | 3.25 | 260 |
| `rapid` | 1 | 14 | 16 | 0 | 187.5 | 3.5 | 280 |
| `rapid` | 2 | 15 | 16 | 0 | 187.5 | 3.75 | 300 |
| `rapid` | 3 | 16 | 16 | 0 | 187.5 | 4 | 320 |
| `rapid` | 4 | 8 | 8 | 0 | 187.5 | 4 | 320 |
| `wave_laser` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `wave_laser` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `wave_laser` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `ricochet` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `ricochet` | 1 | 2 | 16 | 1 | 187.5 | 0.5 | 40 |
| `ricochet` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `ricochet` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `cluster` | 0 | 1 | 16 | 0 | 187.5 | 0.25 | 20 |
| `cluster` | 15 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `options` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `options` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `options` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `nova` | 0 | 1 | 16 | 0 | 187.5 | 0.25 | 20 |
| `nova` | 15 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `mortar` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `mortar` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `mortar` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `arc` | 0 | 4 | 16 | 4 | 187.5 | 1 | 80 |
| `arc` | 1 | 4 | 16 | 6 | 187.5 | 1 | 80 |
| `arc` | 2 | 5 | 16 | 6 | 187.5 | 1.25 | 100 |
| `arc` | 5 | 6 | 16 | 6 | 187.5 | 1.5 | 120 |
| `arc` | 15 | 8 | 16 | 0 | 187.5 | 2 | 160 |
| `arc` | 16 | 4 | 8 | 0 | 187.5 | 2 | 160 |
| `rear_guard` | 0 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `rear_guard` | 2 | 5 | 16 | 0 | 187.5 | 1.25 | 100 |
| `rear_guard` | 5 | 6 | 16 | 0 | 187.5 | 1.5 | 120 |
| `rear_guard` | 9 | 7 | 16 | 0 | 187.5 | 1.75 | 140 |
| `rear_guard` | 15 | 8 | 16 | 0 | 187.5 | 2 | 160 |
| `rear_guard` | 16 | 4 | 8 | 0 | 187.5 | 2 | 160 |
| `broadside` | 0 | 1 | 16 | 0 | 187.5 | 0.25 | 20 |
| `broadside` | 15 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `railgun` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `railgun` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `shard_swarm` | 0 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
| `shard_swarm` | 5 | 3 | 16 | 0 | 187.5 | 0.75 | 60 |
| `shard_swarm` | 15 | 4 | 16 | 0 | 187.5 | 1 | 80 |
| `shard_swarm` | 16 | 2 | 8 | 0 | 187.5 | 1 | 80 |
| `heavy_slug` | 0 | 1 | 16 | 0 | 187.5 | 0.25 | 20 |
| `heavy_slug` | 15 | 2 | 16 | 0 | 187.5 | 0.5 | 40 |
<!-- euclidean-ladder:end -->

Notes on individual ladders:

- Rung thresholds are **derived** from the weapon `fireRate` curve (base 1×,
  cap 2.2×, `k = 0.12`) — every desk above is the first level whose desired
  onset density supports that rung. The curve was flattened by
  AH-0MVWAVL6R001UI60 (was cap 3× / `k = 0.18`), so the same rungs now arrive
  later, and any rung whose density sits at or above the 2.2× asymptote is
  omitted (the exponential curve approaches the density, never reaches it).
  After the level-0 retime that asymptote is also **absolute**: a weapon whose
  level-0 rung is `E(2,16)` can never climb past `k = 4` (1 onset/beat), which
  is why `spread`/`options`/`wave_laser`/`shard_swarm` end at `E(4,16)`,
  `dual`/`ricochet` at the same density via a rotation / `E(2,8)` morph, and
  `cluster`/`broadside`/`heavy_slug`/`railgun` stop at `E(2,16)`/`E(3,16)`.
- `cannon` walks the documented shape morph
  `E(9,16) → E(10,16) → E(13,16) → E(16,16) → E(8,8)` (levels 0, 1, 4, 9 and
  10). The work item's example ledger starts at `E(8,16)`, but the canonical
  six-weapon fixture fixes the level-0 cannon rung at `E(9,16)` (so the
  fixture totals 31 onsets per bar); the ladder above follows the same
  `E(10,16) → E(13,16) → E(16,16) → E(8,8)` shape from that one-onset-higher
  base.
- `heavy_slug`, `railgun`, `cluster`, `mortar`, `broadside` and `nova` stay
  **sparse**, moving through irregular tiles such as `E(3,16)` and `E(5,16)`
  as well as the straight low-density `E(2,16)`/`E(1,16)` tiles — they are
  never limited to whole-beat multiples. `heavy_slug` and `railgun` now walk
  `E(1,16)`/`E(2,16)` and `E(2,16)`/`E(3,16)` respectively: the sparse end of
  the lattice cannot carry more whole-`k` rungs under the 2.2× asymptote.
- `rapid` starts near the lattice ceiling (`E(13,16)` = 3.25 onsets/beat) and
  reaches `E(8,8)` at 4 onsets/beat; faster-than-16th patterns need a
  sub-16th step size and are deferred to a follow-up tuning item.
- `arc`, `rear_guard` and `shard_swarm` keep a **bar-halving shape morph** at
  the top of their ladders (`E(4,16) → E(4,8)`, `E(8,16) → E(4,8)` and
  `E(4,16) → E(2,8)`), so the density repeats twice per bar exactly as the
  cannon's `E(16,16) → E(8,8)` does.

## Weapon 40 % trim / flattened curve — measured before/after gate (AH-0MVRENEME004FS8T)

Producer answer **Q3 = B** made the weapon nerf (40 % level-0 trim plus the
flattened per-level curve, parent **Weapon upgrades are too powerful**
(AH-0MVRENEME004FS8T)) acceptable only with a pre/post batch comparison. That
comparison is recorded here. The strength budget it is *not* able to check —
the `≤ 60 % of baseline` level-0 bound, the `≤ 1.5× cannon` ceiling and the
`≤ 2.5× L0` / `≤ 50 % of the old saturated output` level bounds — is asserted
numerically by `src/utils/weapons.test.ts` and
`src/utils/weaponLevels.test.ts`; see GDD §4.4 / §4.4.2.

### Strength budget (the numeric half of Q3 = B)

The batch gate below cannot see weapon output (the arena fires on a fixed
cadence constant and imports only the `WeaponId` type), so the binding
acceptance evidence for the trim is the numeric budget. It is documented in
full — per-family output definition, the frozen level-0 baseline table, the
post-change table and the level-0 / level-1 / level-cap ceilings (60 %, 1.5×
the cannon, 2.5× L0 and 50 % of the pre-change saturated output) — in the GDD
[§4.4 Power-Ups](./Game%20Design%20Document.md#44-power-ups) and
[§4.4.2 Weapon Leveling](./Game%20Design%20Document.md#442-weapon-leveling-ah-0mupmpcb2009j54j).
In code, `WEAPON_STRENGTH_BUDGET` (`src/utils/weaponStrength.ts`) holds the
ceilings, the frozen level-0 baselines sit beside `WEAPON_CATALOGUE`
(`src/utils/weapons.ts`), and `src/utils/weapons.test.ts` /
`src/utils/weaponLevels.test.ts` assert the bounds table-driven against literal
baselines. Any future weapon must satisfy the same budget before it ships.

### The two runs (same sweep)

```bash
# BEFORE — commit 47609296, clean tree, no weapon data edits
npm run evaluate -- --batch --games 100 --out eval-output/baseline-run
# (artefacts copied to the dated, retained-for-comparison path)
#   eval-output/baseline-2026-11-03/balance-report.json|.txt

# AFTER — commit ffd79aa2 (level-0 trim 9586e7f4 + flattened curve ffd79aa2)
npm run evaluate -- --batch --games 100 --out eval-output/post-change-2026-11-04
```

Both batches are git-ignored artefacts under `eval-output/`; the durable
record is this section plus the work-item comment on
AH-0MVWAVM03002FLLL.

| Side | Commit | Date | Artefact directory |
|---|---|---|---|
| before | `47609296` | 2026-11-03 | `eval-output/baseline-2026-11-03/` |
| after | `ffd79aa2` | 2026-11-04 | `eval-output/post-change-2026-11-04/` |

**Same sweep, verified from the report `config` block:** campaign mode,
`policies: ["competent"]`, seeds `1..100`, `ticks: 18000`, `dt: 1/60`,
`sampleEveryTicks: 1`. The two `config` blocks are byte-identical and the two
`balance-report.json` files are **byte-identical**, including every per-run
`recordsHash`.

### Before / after / delta

Aggregate means per 100-game campaign batch (`n = 100`):

| Metric | Before (`47609296`) | After (`ffd79aa2`) | Delta |
|---|---:|---:|---:|
| `survivalSeconds` | 300.00 | 300.00 | **0.00** |
| `waveReached` | 5.89 | 5.89 | **0.00** |
| `levelReached` | 1.09 | 1.09 | **0.00** |
| `upgradesSelected` (sum of per-choice-id means) | 2.00 | 2.00 | **0.00** |
| `mineralsCollected` | 18.00 | 18.00 | **0.00** |
| `avoidableHits` | 0.00 | 0.00 | **0.00** |
| `powerUpsCollected` | 12.95 | 12.95 | **0.00** |
| `asteroidsDestroyed` | 12.00 | 12.00 | **0.00** |

Per-band deltas against `src/data/experience-targets.json`
(`targetsVersion` 1) are likewise unchanged:

| Band | Before | After | Band delta | Verdict |
|---|---:|---:|---:|---|
| `survivalSeconds` (300 ± 30) | 300 | 300 | 0 | in-band |
| `mineralsCollected` (18 ± 1.8) | 18 | 18 | 0 | in-band |
| `upgradesSelected` (2 ± 0.5) | 2.00 | 2.00 | 0 | in-band |
| `waveReached` (6.46 ± 4.9592) | 5.89 | 5.89 | 0 | in-band (pre-existing −0.57) |
| `levelReached` (1.15 ± 0.7141) | 1.09 | 1.09 | 0 | in-band (pre-existing −0.06) |
| `avoidableHits` (0 ± 0.5) | 0 | 0 | 0 | in-band |

`node scripts/validate-experience.mjs eval-output/post-change-2026-11-04/balance-report.json`
returns `verdict: pass`, `driftedMetrics: []` and exit 0 — so **no band moved
materially and `src/data/experience-targets.json` is deliberately NOT
re-baselined** (no `targetsVersion` bump, and GDD §2.7 is unchanged).

### Why the numbers cannot move: the harness does not model weapon output

A byte-identical report is the **structurally expected** result of this change,
not evidence that the nerf is ineffective in the game. The closed-loop headless
arena fires the player's shots on a **fixed cadence constant**
(`FIRE_INTERVAL_TICKS = 9` in `src/ai/eval/arena.ts`) and imports only the
**type** `WeaponId` from `src/utils/weapons` — a type-only import is erased at
compile time, so no `WEAPON_CATALOGUE`, `DEFAULT_WEAPON_SUBDIVISIONS`,
`AOE_RADII`, hit-budget or `WEAPON_UPGRADE_SPECS` value can reach the
simulation. This is the already-documented fidelity boundary above: "choices
affect the ownership context used by later offers — the arena does **not** model
the chosen weapon's fire pattern".

Measured, not inferred — a sensitivity probe on the same tree:

```bash
node scripts/evaluate.mjs --batch --games 3 --out /tmp/probe/control   # control
# temporary edit: DEFAULT_WEAPON_SUBDIVISIONS.cannon 2 -> 12 (6x cadence)
node scripts/evaluate.mjs --batch --games 3 --out /tmp/probe/edited    # 6x cannon fire rate
git checkout -- src/utils/weapons.ts    # reverted; `git status --porcelain` empty
```

`diff /tmp/probe/control/balance-report.json /tmp/probe/edited/balance-report.json`
is **empty**: even a 6× change to the starting weapon's level-0 cadence —
several times larger than the 40 % trim under test — leaves the batch report
byte-identical. **The batch gate is blind to weapon-output levers.**

### Decision, and what still gates the change

- **No retune iteration is recorded, because no retune can change a metric the
  harness never reads.** Re-tuning weapon data to move these numbers would be
  evidence-free churn; the stated bounds were therefore not re-entered.
- **The numeric half of Q3 = B is the binding gate** for this change: the
  level-0 `≤ 60 %` bound, the `≤ 1.5× cannon` ceiling and the
  `≤ 2.5× L0` / `≤ 50 % of the pre-change saturated output` level bounds are
  asserted table-driven against literal baselines by
  `src/utils/weapons.test.ts` and `src/utils/weaponLevels.test.ts`.
- **What the batch gate does still verify** here: the change is not a
  campaign-shape regression — the sweep stays playable, in-band and
  deterministic, and the same seeds reproduce the same report byte-for-byte
  (a stronger reproducibility statement than the same-tree replay in
  §Determinism and reproducibility, since the two runs happened on different
  trees).
- **Evidence limitation (carry it forward):** this batch is *directional* bot
  evidence and cannot speak to weapon feel. A **human play-check is required**
  after merge before the nerf is considered validated.
- **Follow-up:** modelling the player's weapon fire (catalogue cadence, pattern
  count, bullet lifetime, budgets and the level curve) in the arena, so a
  future weapon-output change is measurable by this gate, is filed as
  **Model player weapon fire output in the balance harness**
  (AH-0MW1OLFM20060MOE, `discovered-from:AH-0MVRENEME004FS8T`) — out of scope
  here (AC4 scope guard) but the reason this gate cannot answer the question.

## Related work

- Epic: **Automated Balancing** (AH-0MV1DLUZ8009OCJW).
- Weapon Euclidean upgrade ladder (AH-0MVYA291J000CK64): the per-weapon
  `E(k, n, rotation)` ledger above, resolved by
  `src/utils/weaponLevels.ts` (`WEAPON_EUCLIDEAN_LADDERS` /
  `resolveWeaponPattern`).
- Same-seed evaluation harness: [`docs/EVALUATION.md`](./EVALUATION.md).
- Periodic human-experience validation
  (AH-0MV7WVHU0000U775): [`docs/EXPERIENCE_VALIDATION.md`](./EXPERIENCE_VALIDATION.md).
- Telemetry schema: [`docs/TELEMETRY.md`](./TELEMETRY.md).
- Config source of truth: `src/data/*.csv` + `src/core/configStore.ts`.
