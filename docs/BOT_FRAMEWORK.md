# Bot Framework

The attract/demo bot is built on a small, testable framework rather than a
per-frame priority ladder. This document is the overview of that framework
and the guide to extending it with goals and behaviours.

> **Status:** framework core (AH-0MUY08WKB002N1N6) plus the structured
> competent bot content (AH-0MUY08WX3000ZEVO) and its content-adaptive
> configuration (AH-0MUY08X98002TRHT) described in
> [section 9](#9-the-structured-competent-bot) and
> [section 11](#11-teaching-the-bot-about-new-content). The framework still
> ships the legacy survival heuristic as the brain's default fallback (see
> [Legacy adapter](#7-legacy-adapter)).

## 1. Why a framework

The original bot (`src/ai/botDecision.ts`) evaluated a fixed survival →
clear-wave → divert → asteroid ladder every frame. It worked, but:

- every new priority was an edit to the ladder's `if`-chain;
- it had no commitment, so two close-scoring options flip-flopped;
- prediction and policy were entangled, so prediction could not be tested in
  isolation; and
- it had no place to put new content (enemies, power-ups, weapons) as data.

The framework splits the problem into four interchangeable pieces:

| Piece | Module | Responsibility |
|---|---|---|
| World model | `src/ai/framework/worldModel.ts` | Predict positions/velocities and incoming fire from a snapshot. Pure. |
| Goals & behaviours | `src/ai/framework/registry.ts` | Id-keyed content; the core never switches on ids. |
| Commitment | `src/ai/framework/commitment.ts` | Hold a selected goal until achieved, invalidated, or outranked by a margin. |
| Brain / policy | `src/ai/framework/botBrain.ts` | Map `BotSnapshot` (+ world + memory) to a `BotSteeringIntent` over an injected `dt`. |

```
BotSnapshot
   │  buildBotWorld()            ← predictor layer (AC3)
   ▼
BotWorld ──► goal.utility()/isValid()/isAchieved()   ← registry content (AC2)
   │
   ▼
selectCommittedGoal()           ← commitment / hysteresis (AC1)
   │
   ▼
behaviour.run()  ──►  BotSteeringIntent
```

## 2. World model

`buildBotWorld(snapshot, tunables?, content?, hazardVelocities?)` derives a
`BotWorld` from a read-only `BotSnapshot`. It partitions the live entities,
computes proximity and timed-wave pressure, and predicts incoming fire:

```ts
const world = buildBotWorld(snapshot);
world.liveEnemies;          // live non-asteroid enemies (+ boss)
world.liveAsteroids;        // live asteroids
world.hazards;              // every alive enemy/asteroid plus the live boss
world.incomingFire;         // predicted shots and their threat to the player
world.nearestEnemyDistance; // or Infinity
world.wavePressure;         // 0..1, 0 when no timed wave is running
```

Hazards are `BotHazardPoint`s: each carries the entity's stable bot-side `id`,
its **movement class** (`formation` / `diver` / `chaser` / `patroller` /
`roamer`) and, when the caller supplies a velocity lookup, an estimated
`vx`/`vy`
(the bot-side hazard-velocity tracker of
[section 9.10](#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)).
The class is resolved bot-side from the archetype by the frozen map in
`src/ai/framework/enemyMovementClass.ts`, which mirrors the `movementClass`
column of `src/data/enemy-configs.csv`; an unknown archetype resolves to
`roamer` and the boss resolves to `formation`. The class is consumed by the
class-shaped trajectory sampler
([section 9.10](#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)).
With no lookup — the default for direct callers — hazards stay stationary
`{ x, y }` points, exactly as before.

`predictIncomingFire` classifies every in-flight enemy bullet and every enemy
inside a fire **tell** (whose shot does not exist yet, so it is estimated as a
straight line at `assumedBulletSpeed`). Each `IncomingFireThreat` carries the
predicted time-to-closest-approach, closest distance, whether it is closing
and whether it threatens. Because the player's own velocity is included in
the relative motion, prediction captures a dodge.

The world model is a **pure function** — no memory, no wall clock — so a
prediction is exactly reproducible and testable in isolation.

### 2.1 The arena is a torus

The playfield wraps at all four edges, so the world model measures geometry on
the **shortest wrapped route**, not the raw straight line: `predictIncomingFire`
classifies a shot that will arrive across a seam, `nearestEnemyDistance` is the
wrapped distance, and the reported threat distance/time are computed on the
torus. The bot-facing helpers live in `src/ai/framework/wrapGeometry.ts` and
delegate to the single shared implementation in `src/utils/wrapGeometry.ts`
(see [section 9.11](#911-wrap-aware-torus-model-ah-0mvmisf0q00314lg)).

## 3. Goals and behaviours

A goal and a behaviour are **data**. Both register under a stable string id in
an ordered `Registry`; adding one is a registration call, never an edit to the
core (there is no `switch`/`if`-chain over ids).

### Goal

```ts
interface BotGoal {
  id: string;                 // stable, also the deterministic tie-break key
  behaviourId: string;        // behaviour that executes it
  utility(view: BotGoalView): number;      // higher wins; must be finite
  isValid?(view): boolean;                 // false => release the commitment
  isAchieved?(view): boolean;              // true  => release the commitment
}
```

- `utility` scores the current situation. Any finite comparable number works
  (probabilities, distances, counts).
- `isValid` invalidates a committed goal whose premise no longer holds
  (e.g. its target died).
- `isAchieved` releases a committed goal that is done (e.g. the mineral was
  collected).
- Registration order breaks utility ties, so selection is deterministic.

### Behaviour

```ts
interface BotBehaviour {
  id: string;
  run(context: BotBehaviourContext): BotSteeringIntent | null;
}
```

A behaviour executes the committed goal and returns a `BotSteeringIntent`
(the same intent the legacy governor consumes: cardinal booleans plus the
precise `dirX`/`dirY` bearing and the forward-model `thrust` flag). Returning
`null` means "cannot act this tick"; the brain then falls back.

### The view

Both `utility`/`isValid`/`isAchieved` and `run` receive a `BotGoalView`:

```ts
interface BotGoalView {
  snapshot: BotSnapshot;  // read-only game state
  world: BotWorld;        // derived predictions (section 2)
  memory: BotMemory;      // commitment, tick count, goal scratch
  dt: number;             // injected seconds since the previous tick
}
```

Behaviours additionally receive `goal` (the committed goal).

## 4. Commitment / hysteresis

`selectCommittedGoal(candidates, current, dt, tunables)` is a pure transition
function. A goal is held until one of three things happens:

1. it becomes **invalid** (`isValid === false`) — released immediately;
2. it is **achieved** (`isAchieved === true`) — released immediately; or
3. a challenger **outranks it by `switchMargin`** *and* the incumbent has been
   held for at least `minCommitSeconds` *and* the challenger has outranked it
   for `challengerPersistenceSeconds`.

Defaults live in `BOT_COMMITMENT_TUNABLES`:

```ts
{ minCommitSeconds: 0.2, switchMargin: 0.15, challengerPersistenceSeconds: 0 }
```

`challengerPersistenceSeconds` defaults to `0` (switch as soon as the hold and
margin are satisfied); raise it to debounce a one-tick utility spike.

## 5. Brain / policy

`BotBrain` implements the framework's policy seam:

```ts
interface BotPolicy {
  decide(snapshot: BotSnapshot, dt: number): BotSteeringIntent;
}
```

Each tick the brain:

1. builds the `BotWorld` for the snapshot;
2. resolves every registered goal's `utility`/`isValid`/`isAchieved`;
3. advances the commitment state via `selectCommittedGoal`;
4. looks up the committed goal's behaviour and runs it; or
5. falls back to its `fallback` policy when no goal applies or the behaviour
   declines.

All cross-tick state lives in an explicit `BotMemory` (commitment, `ticks`,
goal-keyed `scratch`). Call `reset()` when a run restarts so nothing leaks
between runs.

## 6. Determinism

The framework never reads a wall clock. Every time-dependent decision uses the
caller-injected `dt`, and all state is carried in `BotMemory`. Given the same
snapshot sequence pre-seeded the same way, `BotBrain` produces the same intent
sequence bit-for-bit. This is what makes headless same-seed evaluation
possible later in the epic.

## 7. Legacy adapter

The original pure decision is preserved unchanged behind `BotPolicy`:

```ts
import { createLegacyBotPolicy } from './framework';

const policy = createLegacyBotPolicy();      // decide(snapshot, dt)
```

`BotBrain` uses it as the default `fallback`, so the demo keeps working while
content goals are migrated. A parity test
(`src/ai/framework/legacyPolicy.test.ts`) pins the adapter's output to
`decideBotIntent`, so the two can never drift.

## 8. Adding a goal and behaviour

A new goal is a `BotGoal` plus the `BotBehaviour` it names, registered on the
brain. For example, a mineral-collect goal:

```ts
import {
  BotBrain,
  createBehaviourRegistry,
  createGoalRegistry,
  type BotBehaviour,
  type BotGoal,
} from './framework';

const collectGoal: BotGoal = {
  id: 'collect-mineral',
  behaviourId: 'collect-mineral',
  utility: ({ world, snapshot }) => {
    if (!snapshot.player || world.minerals.length === 0) return 0;
    const nearest = Math.min(
      ...world.minerals.map((m) =>
        Math.hypot(m.x - snapshot.player!.x, m.y - snapshot.player!.y),
      ),
    );
    return Math.max(0, 1 - nearest / 500);
  },
  isAchieved: ({ world }) => world.minerals.length === 0,
};

const collectBehaviour: BotBehaviour = {
  id: 'collect-mineral',
  run: ({ world, snapshot }) => {
    const player = snapshot.player;
    const target = world.minerals[0];
    if (!player || !target) return null;
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      up: false, down: false, left: false, right: false,
      dirX: dx / len, dirY: dy / len,
      thrust: true, longTravel: len > 250,
    };
  },
};

const brain = new BotBrain({
  goals: createGoalRegistry([collectGoal]),
  behaviours: createBehaviourRegistry([collectBehaviour]),
});
```

No core file changes — the brain discovers the goal through the registry. The
full competent goal set (minerals > power-ups > enemies > asteroids, plus
survival) is documented in
[section 9](#9-the-structured-competent-bot).

## 9. The structured competent bot

The concrete content added by AH-0MUY08WX3000ZEVO lives in
`src/ai/framework/competent/` and is bundled by
`createCompetentBotBrain()`:

```ts
import { createCompetentBotBrain } from './framework';

const brain = createCompetentBotBrain(); // BotBrain / BotPolicy
brain.decide(snapshot, dt);              // -> BotSteeringIntent
brain.reset();                           // on run restart
```

### 9.1 Goals and priorities

Goals are registered in priority/tie-break order and score in separated
**utility bands**, so the operator's order is structural (a closer
lower-priority target can never outrank a higher-priority one):

| Band | Goal id | Behaviour |
|---|---|---|
| survival | `survive` | `evade` |
| secure-life | `secure-life` | `collect` |
| boss | `engage-boss` | `engage` |
| minerals | `collect-mineral` | `collect` |
| power-ups | `collect-powerup` | `collect` |
| enemies | `engage-enemy` | `engage` |
| asteroids | `engage-asteroid` | `engage` |
| reposition | `reposition` | `reposition` |

The `engage-boss` band (AH-0MVBMESIE003YQ68 · AC2) sits directly below
`secure-life` and above every collection band. It is only valid while a live
boss is inside `COMPETENT_BOT_TUNABLES.enemySeekRange`, and its target set is
the boss **alone** — so while it is committed the `engage` behaviour cannot
pick a nearer minion (hard priority, not a weighted bias). Once the boss dies
or leaves the seek range the goal is achieved/invalid and the boss falls back
to the `enemyTargets()` set weighted by its content `threat` (2, twice the
neutral enemy weight). The band base (`bossBase`) is a competent tunable; the
boss weight lives once in `COMPETENT_BOT_CONTENT` (see [section 11](#11-teaching-the-bot-about-new-content)).

A goal's utility rises as its target gets closer (`prioritySpan`) but stays
inside its band. `survive` is only valid while a shot urgently threatens, and
releases immediately when the threat clears; collection/engagement goals are
released when their target type is gone. The hysteresis (hold, margin,
challenger persistence) is the framework's commitment mechanism from
[section 4](#4-commitment--hysteresis).

The `secure-life` band sits directly below survival and above minerals: while
the ship is below its life cap and a live **Extra Life** drop is on screen,
the bot pursues that drop over every other objective (an offered Extra Life is
also the demo bot's preferred hold-full choice). At the cap the goal is
invalid, so the drop falls back to its normal power-up value; survival still
dominates, so the bot never trades its life for a life
(AH-0MV03GXZQ00801T4). The life count and cap come from the scene's run state
via the read-only snapshot — the bot introduces no cap constant of its own.

#### Two-layer primary/secondary objective model (AH-0MWJ1680Z001QYV2)

The bands above are the **ordering**; on top of them the live competent brain
runs a **two-layer** objective model that keeps the bot from oscillating:

- **Primary** — a sticky, standing objective: survival, `secure-life`, `boss`,
  `engage-enemy`, or `reposition`. It changes only when it is achieved,
  invalidated, or a genuinely higher-value primary takes over. `survive`,
  `secure-life` and `engage-boss` are **hard** primaries: they pre-empt
  everything and block diversion while valid.
- **Secondary** — an opportunistic diversion: `collect-mineral`,
  `collect-powerup`, or `engage-asteroid`. A secondary may preempt the primary
  **only** when its diversion payoff clears `diversionThreshold` and the
  primary's urgency is at or below `secondaryUrgencyCap`. When it completes or
  is abandoned the bot returns to the suspended primary.

The payoff is deliberately **not** the raw band utility (a lone gold mineral
still bands high), so **presence alone never pulls the bot off its course**:

- a mineral's payoff is the value of the cluster around the nearest mineral,
  normalised by `mineralDepositValue` — a red deposit (value 10) or ~10
  clustered gold reaches the threshold, a lone gold dot does not;
- a power-up's payoff normalises its content value above neutral, so a strong
  drop (smart bomb, force field) diverts and an ordinary drop does not;
- an asteroid diverts only when it is within `dangerMargin` (a collision-path
  asteroid).

Mineral utility is **value-aware** (`mineralValueWeight`): a red deposit is
weighted fully and an ordinary gold dot a tenth, so a red deposit outranks a
closer gold dot within the mineral band (**red over yellow**) without ever
leaving the band's span. Engagement's **urgency** is the wave pressure, so late
in a timed wave the bot stops diverting and focuses fire.

All layering thresholds are `CompetentBotTunables` and surfaced in the
bot-tuning gym: `layeringEnabled`, `primaryMinHoldSeconds`,
`secondaryMinHoldSeconds`, `diversionThreshold`, `secondaryUrgencyCap`,
`mineralDepositValue` and `mineralClusterRadius`. Disabling `layeringEnabled`
restores the flat single-layer selection, which is the purposefulness
**baseline** the AC5 metric compares against.

### 9.2 Behaviours

- **`collect`** (mineral/power-up/secure-life): approach and scoop, braking
  via the forward model so the ship arrives rather than barrelling through,
  and using reverse retro-thrust only to correct an **imminent overshoot**
  (AH-0MV2WJSY70070HK2 · AC2).
  The `secure-life` goal restricts this behaviour to live Extra Life drops.
- **`engage`** (enemy/asteroid/boss): line the target up inside
  `engagementRange`, then hold the **aim axis** and coast so the forward-
  firing weapon stays on target (aim/fire reasoning, AC3) instead of aiming
  only by accident of travel. The `engage-boss` goal restricts the target set
  to the boss alone (AH-0MVBMESIE003YQ68 · AC3). A target whose velocity is
  exposed is **led** — the objective is the iterated intercept rather than the
  current position
  (AH-0MV1DUSM2005HL98 · AC2, [section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98)).
  Inside `reverseRetreatRange` it retreats under reverse thrust while
  keeping its nose on the target (kiting) **only when a genuine threat is
  present** — an incoming threatening shot or an imminent hazard collision —
  never merely because the target is close (AH-0MV2WJSY70070HK2 · AC3). The
  imminent-collision half uses the predictive hazard test when the bot has a
  velocity estimate for the hazard, and the positional `dangerMargin` rule
  otherwise ([section 9.10](#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)).
- **`evade`**: head away from the weighted centroid of the shots that
  threaten the ship (predictive path-around, AC2), not merely direction
  rejection.
- **`reposition`**: drift back toward the playfield centre when idle.

### 9.3 Survival is a hard constraint (AC4)

Every behaviour routes its intent through the pure `planSteering` helper,
which samples a **fan of bearings around the objective**, evaluates each one
for predicted clearance against hazards and incoming fire, and picks
the safe bearing that best trades objective progress for clearance. The four
arena edges are a **wrap, not a wall** (see
[section 9.11](#911-wrap-aware-torus-model-ah-0mvmisf0q00314lg)), so reaching
an edge never makes a bearing unsafe. Hazards
are evaluated at their **predicted** positions when the bot has a velocity
estimate for them (and `hazardPredictionEnabled` is on): a bearing is also
unsafe when the ship and a moving hazard are predicted to come within
`threatRadius` inside `hazardPredictionHorizon`
([section 9.10](#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)). When
no bearing is safe it takes the greatest-clearance bearing — the least-bad
escape — so the ship always moves rather than freezing. The never-suicide
property therefore holds regardless of which goal is committed.

### 9.4 Single-sourced tuning (AC5)

All competent-bot numbers live in `COMPETENT_BOT_TUNABLES`
(`src/ai/framework/competent/tunables.ts`): the priority bands, ranges,
safety margins, steering-fan/scoring weights, playfield size, aim-lead
parameters and the commitment/world-model overrides. The human-like input
cadence itself is the governor's `reactionTimeMs`
([section 5](#5-brain--policy)); the competent tunables set a compatible
`minCommitSeconds` so a goal cannot be re-picked faster than a human can
change input. The rotation-skill knobs — `skill`, `maxAimErrorRad`,
`aimErrorRad`, `aimErrorDecay`, `aimErrorResetDistance`, `aimLeadEnabled`,
`aimLeadAlignSeconds`, `aimLeadIterations` — live in the
same two sources ([section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98)),
as do the predictive-hazard-avoidance knobs `hazardPredictionEnabled` /
`hazardPredictionHorizon`
([section 9.10](#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)).
Reverse-thrust gating and timing live in the same two sources — see
[section 9.7](#97-reverse-thrust-ah-0mv2wjsy70070hk2).  The reverse forward
model consumes live reverse physics from the snapshot
(`reverseAcceleration` / `reverseMaxSpeed`, default/override entries like the
forward terms) — see [section 9.7](#97-reverse-thrust-ah-0mv2wjsy70070hk2).

**The physics terms are fallback defaults + tuning overrides, never the
ship's truth (AH-0MV85WH2V005NZTX).** `playerSpeed`, `frictionDeceleration`
and the reverse pair are *not* authoritative: the steering layer resolves
them against the snapshot's live thruster config with the precedence
`explicit tuning override > live ship config > compiled default` (the
`resolvePlayerSpeed` / `resolveFrictionDeceleration` / `resolveReverse*`
helpers in `tunables.ts`). A value equal to the compiled default is a
fallback and loses to the live config; a value differing from the compiled
default — e.g. a `GymBotTuning` slider or a persisted config — is an explicit
override and wins over the live config. The compiled defaults mirror the
shipped ship config (`playerSpeed: 175`, `frictionDeceleration: 100`,
`reverseAcceleration: 200`, `reverseMaxSpeed: 120`), so a ship running
defaults behaves bit-for-bit as before (default-equivalence).

### 9.5 Module layout

| Module | Responsibility |
|---|---|
| `competent/tunables.ts` | Single source of tuning + `resolveCompetentTunables`. |
| `hazardVelocity.ts` | Bot-side hazard-velocity tracker (position deltas → clamped velocity). |
| `hazardMotionModel.ts` | Class-shaped trajectory sampler: per-movement-class path over the horizon → minimum separation (and the shared closest-approach primitive). |
| `competent/steering.ts` | Pure bearing fan, safety evaluation, predictive hazard avoidance, forward model, intercept solve. |
| `competent/goals.ts` | The registered goals (survival, boss-focus, collection, engagement, reposition) and their utility bands. |
| `competent/behaviours.ts` | collect / engage / evade / reposition. |
| `competent/index.ts` | `createCompetentBotBrain()` factory. |

### 9.6 Wiring

`PlayScene`'s demo bot feeds `this.botBrain.decide(buildBotSnapshot(this),
dt)` into the human-like governor (instead of the legacy `decideBotIntent`),
and resets the brain on run (re)start. The competent brain keeps the legacy
adapter as its default fallback, so the demo still behaves sensibly if a
behaviour declines.

### 9.7 Reverse thrust (AH-0MV2WJSY70070HK2)

The demo bot reserves reverse thrust for **trouble and correction** — an
imminent overshoot or a genuine threat — never for routine positioning
(AC1–AC5). This tightens the earlier first-class reverse-thrust feature
(AH-0MV1J0OHP0072XA5), which the producer rejected for using reverse far too
often:

- **Brake assist restricted to imminent overshoot (AC2).** While closing on
  a collection or combat target, the `collect`/`engage` behaviours request
  reverse only when the remaining gap to the target falls within the
  imminent-overshoot threshold (`reverseImminentOvershootGap`, default
  `2 × collectArrivalRadius`) **and** the forward model would overshoot
  (`mayThrust` is `false`).  During a normal approach the ship coasts on
  friction; `mayReverse` exposes the predicate and never fires when the ship
  is stopped, the gap is above the threshold, or reverse braking is disabled.
- **Heading-aware reverse removed entirely (AC1).** The governor no longer
  latches a reverse mode when the travel bearing is behind the nose.  The
  ship always **turns to face** its travel bearing (including 180° turns),
  so no reverse press is emitted from this path.  The
  `reverseHeadingThresholdRad` / `reverseHeadingHysteresisRad` tunables and
  their latch are gone.
- **Kiting restricted to genuine trouble (AC3).** The `engage` behaviour
  retreats under reverse inside `reverseRetreatRange` only when there is an
  actual threat — an incoming shot flagged as threatening, or a hazard within
  `dangerMargin` (imminent collision).  Calm close combat no longer holds
  reverse.
- **Config-respecting enable flag (AC4).** `Player.isReverseEnabled()`
  is carried through `buildBotSnapshot()` → `BotSnapshot.reverseEnabled` →
  `BotWorld.reverseEnabled` and into the governor's `BotControlContext`. Every
  reverse intent is gated on it (intent **and** flag, defence in depth), so a
  player who switched the retro-thruster off sees `reverse: false` on every
  bot input and today's behaviour unchanged.
- **Human-like reverse cadence (AC5).** When reverse is legitimately
  requested, the governor holds each press for a duration drawn from
  `[reversePressMinMs, reversePressMaxMs]` (reduced by a per-press gentle
  factor), using separate seeded RNG streams so the forward press sequence is
  unchanged. The bot never toggles reverse every frame.

**Reflex vs. cadence (AH-0MWPD1IH8005GHSK).** The reverse *request* is a fast
braking reflex, exactly like forward thrust: while the chosen bearing stays
committed for the human reaction window, `BotInputGovernor.update`
re-evaluates `decision.reverse` every tick (the same `else if (typeof
decision.thrust === 'boolean')` branch) so a brake engages on time instead of
overshooting inside a held pulse. The human-like element is the *press
duration* hold (`reversePressMinMs`/`reversePressMaxMs`), which keeps the key
down for a perceptible burst rather than toggling it frame by frame. The
committed target *bearing* (`dirX`/`dirY` plus the cardinal booleans,
`longTravel` and `aim`) is what the reaction cadence governs: it is held for
`reactionTimeMs` and only re-chosen at a commit. So a cadence assertion must
project out both fast-reflex fields (`thrust` **and** `reverse`) and compare
the held bearing — otherwise an in-window brake reads as a cadence failure.

The relevant tunables are single-sourced in `COMPETENT_BOT_TUNABLES`
(`reverseBrakeEnabled`, `reverseImminentOvershootGap`, `reverseRetreatRange`)
and `BOT_HUMAN_INPUT_TUNABLES` (`reversePressMinMs`, `reversePressMaxMs`,
`reversePressGentleMinPct`, `reversePressGentleMaxPct`).  The reverse *request*
is re-evaluated every tick like forward thrust; only the press duration is
humanised, and the committed bearing is held for `reactionTimeMs`.  A
deterministic seeded run pins the regression: the restricted model cuts
reverse presses over an integration demo window from 38 to 9
(528 → 138 reverse ticks) versus the pre-change baseline.

**The reverse forward model consumes the live reverse physics
(AH-0MV85WGOO0066I9X).** The `collect`/`engage` brake-assist does not just ask
"would the ship overshoot": it models the correction with the ship's snapshot
`reverseAcceleration` and `reverseMaxSpeed` (default/override fields with the
same precedence as `playerSpeed`/`frictionDeceleration` — explicit tuning
override > live ship config > compiled default, all coinciding at the shipped
`200`/`120`).  A reverse press decelerates the ship at the live reverse
acceleration (the game model suppresses friction while the press is held), so
the reverse-assisted stopping distance is `v²/(2·a_r)`.  Reverse is requested
only when that distance fits inside the remaining gap — a press that cannot
stop the ship in time is futile and is suppressed (the pre-AC1 model omitted
reverse physics entirely) — and only while the approach speed is within the
ship's configured retro envelope (at or below the live reverse max speed), so
a player who capped the retro lower sees the bot reserve it for gentler
corrections.  The rule therefore remains strictly trouble/correction: it can
only narrow the circumstances in which reverse fires, never widen them.

#### Observing the retro-thruster

Because reverse is deliberately reserved for trouble, it is easy to miss. On
screen it reads as the **nose (front) engine flame** — the full-size
forward-pointing flame at the hull front, while the forward engines fire at
the rear — and it fires in only two situations: the final
`reverseImminentOvershootGap` (36 px) of an approach (imminent-overshoot
brake) and a threat escape inside `reverseRetreatRange` (90 px) while the nose
stays on the aim target (kiting). A deterministic 60 Hz run with the shipped
ship physics and seed `0x0b16` measures it directly in
`src/ai/framework/competent/competentBot.integration.test.ts` ("reverse
overuse regression bound"); the individual gates are covered by the
calm-vs-threat unit tests in `behaviours.test.ts` and `steering.test.ts`.

> History: the parent feature AH-0MV1J0OHP0072XA5 introduced reverse; the
> producer's review follow-up AH-0MV2WJSY70070HK2 restricted it to
> trouble/correction. See that item's RCA for why the original, more frequent
> reverse was replaced.

### 9.8 Rotation skills (AH-0MV1DUSM2005HL98)

The Asteroids turn now ramps angular velocity (`asteroidsRotationAcceleration`
/ `asteroidsRotationDeceleration`, [section 2.2 of the
game-design document](Game%20Design%20Document.md#22-movement)), so a release
chosen on the **instantaneous** heading error leaves the hull coasting a few
degrees past (or short of) the target and the forward-firing weapon misses.
This feature makes the demo bot aim with that inertia and lead moving targets.
It lives entirely in the shared `src/ai/` code, so `PlayScene` and the
bot-tuning gym fly identically.

- **Inertia-aware turn hold (AC1).** `toAsteroidsInput`
  (`src/ai/botHumanLike.ts`) resolves the turn from the ship's **predicted stop
  heading** = live facing + `angularStopDisplacement(angularVelocity,
  rotationDeceleration)` (`src/utils/movementModel.ts`) instead of the raw
  error: it keeps turning while the predicted stop is outside
  `alignmentToleranceRad`, and applies the **opposite** turn when the coast
  would overshoot (braking the spin) — except inside the reversal hysteresis
  margin (§9.12), where the turn is released so a small overshoot coasts out.
  The governor threads the ship's live
  `angularVelocity` and rotation config through `BotControlContext`, so no
  rotation constant is hard-coded in the bot layer. With `angularVelocity = 0`
  the predicted stop equals the current heading and the result is
  byte-for-byte the legacy release.
- **Lead prediction (AC2; AH-0MWR04X10002VNDG, AH-0MWR04ZDU0005O8J,
  AH-0MWR051U6003BDB9).** `engage` solves the **iterated intercept**: the
  target advances over the ship's estimated time-to-align plus the shot's time
  of flight, refined for `aimLeadIterations` passes.
  - **Velocity source (tracked → snapshot → current).** The lead velocity is
    resolved with an explicit precedence — the **bot-side tracker's** estimate
    for the target's stable id (`BotWorld.hazards[].vx/vy`, the same estimate
    the hazard predictor consumes), then the snapshot's optional `vx`/`vy`
    (sourced from entities that expose a physics body — `Asteroid`,
    `LaneTraffic`), then the current position (AH-0MWR04X10002VNDG · AC1). The
    first step is what leads scripted formation/`chaser`/`diver`/`patroller`
    enemies, whose motion the snapshot seam does not carry. A zero/absent
    estimate falls through the list, so a cold start reduces exactly to the
    current position. The source is held at the pre-change snapshot fallback
    in the avoidance sweep and in the pinned aim-accuracy baseline
    (`aimLeadFromTracker: false`), so neither comparison is moved by an aim
    feature.
  - **Live shot speed (AC2).** The time-of-flight speed is the **ship's own**
    travelling-shot speed (`resolveShotSpeed`: explicit tuning override > live
    ship speed > the compiled `shotSpeed` default, `PLAYER_BULLET_SPEED` =
    **350 px/s**). It replaces the enemy-bullet tell constant
    (`assumedBulletSpeed`, 200 px/s) that was reused here before this feature;
    `assumedBulletSpeed` now models **enemy fire tells only** and is never the
    ship's time of flight.
  - **Live turn time (AC2).** The alignment term is derived from the ship's
    live rotation model (`resolveAimAlignSeconds` → `deriveTurnAlignSeconds`,
    acceleration/deceleration + `angularStopDisplacement`), with the fixed
    `aimLeadAlignSeconds` retained only as the no-config fallback.
  - **Class-sampled intercept (AC3).** When the tracked estimate names a real
    movement class, the lead advances the target along its **sampled class
    trajectory** (`advanceHazardMotion`, the same definition the hazard
    predictor uses in
    [section 9.10](#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)) and
    re-estimates time of flight each iteration; a `roamer`, an unknown/absent
    class, a disabled motion model or a stationary target falls back to the
    pure `interceptPoint` constant-velocity solve **bit-for-bit**. The reusable
    sampler scratch lives on `aimMotion`, so the per-tick solve allocates none.
  - **Seam-aware (torus).** Both the lead solve and the route to the aim point
    run on the torus (AH-0MVT2VZR7000GS15), so a target whose shortest path
    crosses an edge is led and aimed at through that edge.
- **`skill` aim error (AC3).** A single normalised `skill` tunable in
  `BOT_HUMAN_INPUT_TUNABLES` (default **1.0**) perturbs the committed aim
  bearing by a seeded error whose bound is
  `maxAimErrorRad × (1 − skill)` (default **0.35 rad**). The draw lives in a
  dedicated governor RNG stream, so the press-length sequences are unchanged;
  `skill = 1` returns the decision untouched and consumes no draw. Only
  intents flagged as **aim** (`SteeredIntent.aim`, set by `engage` when it
  holds its weapon axis) are perturbed, so the survival/evade tier is never
  degraded.
- **Adaptive aim error (AH-0MWR057Q8004PBOD · AC4).** `aimErrorRad`
  (default **0.02 rad**) is a live, *learning* aim error, independent of
  `skill`: only **aim** intents that carry the engaged target's bot-side id
  (`SteeredIntent.targetId`, set by `engage`) are perturbed, from a sibling
  seeded stream (`seed + 5`) so the `skill` and press sequences are unchanged.
  Every confirmed hit on that target — delivered through the shared
  `notifyAimHit` seam (`CombatScene.onPlayerBulletHitEnemy` →
  `src/ai/aimHit.ts`) — multiplies the live error by `aimErrorDecay` (default
  **0.5**), floored at 0. The full error returns after a **repositioning
  move**: the ship having moved `aimErrorResetDistance` px (default **60**,
  torus-aware, measured from its position at the last hit) or changing
  engagement target. `aimErrorRad = 0` consumes no draw and is byte-for-byte
  the pre-adaptive behaviour. All three knobs are live sliders; the boss has
  no bot-side id in the hit seam, so it keeps the fixed `skill` error only.
  The curated promo presets pin `aimErrorRad = 0` so their seed-tuned
  recordings stay byte-identical to the pre-adaptive baseline (no draw at 0);
  the shipped gameplay `Default` config carries the live 0.02 rad error.
  When **aim damping** is on (§9.12), the error *angle* is drawn once per
  magnitude (arm, decay, reposition re-arm or target change) and held between
  hits, so the fallibility biases the aim instead of jittering the bearing
  every reaction; with damping off it is redrawn every commit, as before.
- **Aim damping (AH-0MWT4BBYO0085CN8 · RAC1).** The producer's play-test of
  the aim-accuracy epic showed the bot **oscillating again in both the turn
  actuator and the forward/backward control**. Two damping knobs, both live
  and both switched on in the shipped `Default` preset; the factory defaults
  stay off, so every pre-change harness baseline is byte-identical:
  - **`aimDampingEnabled`** (toggle, factory **off**, shipped preset **on**)
    is the master switch. With it on, an established **aim** turn direction
    cannot flip for `aimTurnHoldMs`, and the adaptive aim-error angle is held
    between hits (above). With it off the governor is exactly the pre-change
    code.
  - **`aimTurnHoldMs`** (default **300 ms**, the reaction window) releases a
    requested aim reversal inside the window instead of pressing the opposite
    key, so the closed-loop turn coasts through an overshoot rather than
    dithering left/right. The per-tick *release* is untouched — aim precision
    is unchanged, and `0` disables only the flip hold.
- **Standoff hysteresis (AH-0MWT4BBYO0085CN8 · RAC2).**
  `engagementRangeHysteresis` (default **40 px** in the shipped preset, **0**
  factory) makes the engage behaviour's in/out-of-standoff decision sticky:
  once inside `engagementRange` it stays inside until the target is
  `engagementRange + band` away, and outside it keeps closing until it is back
  inside. The same state gates the reverse brake, so thrust and reverse cannot
  chase each other across the boundary. A `0` band is the pre-change
  single-boundary rule.
- **Oscillation measurement (RAC3).** Two deterministic harnesses, both
  folded by the same `countControlOscillation` rule (turn sign flips,
  thrust/reverse on↔off transitions, and forward↔reverse **drive sign flips**
  — the "lunge" count):
  - `src/ai/eval/oscillation.ts` drives the shipped competent brain, the
    shipped `BotInputGovernor` and the shipped `AsteroidsModel` against a
    scripted target that breathes across the standoff boundary while its
    bearing sweeps (the two live symptoms). Both arms see the identical
    script, so a change in the counts is attributable to the damping.
    `src/ai/eval/oscillation.test.ts` asserts the shipped arm is strictly
    below the pinned pre-fix baseline (`src/ai/eval/oscillation.baseline.json`)
    and below the documented caps.
  - `runAimOscillation` in `src/ai/eval/aimAccuracy.ts` runs the **live
    arena fight** with the arena's opt-in `measureControlInputs` trace and
    `liveControlContext` (the ship's angular velocity, rotation model and
    reverse flag, as the game supplies them), reporting the same counts beside
    shots/hits/hit-rate/miss-distance per movement class and seed. Its pre-fix
    observation is pinned in `src/ai/eval/aimOscillation.baseline.json`.
- **Live tuning (AC4).** `skill`, `maxAimErrorRad`, `aimErrorRad`,
  `aimErrorDecay`, `aimErrorResetDistance`, `aimLeadAlignSeconds` and
  `aimLeadIterations` are sliders and `aimLeadEnabled` a toggle in
  `BOT_TUNING_NUMERIC_FIELDS` / `BOT_TUNING_TOGGLES`
  ([section 12](#12-tuning-the-bot-live-the-bot-tuning-gym)), applied live by
  `GymBotTuning` exactly like the existing knobs. The posture knobs
  `holdFireEnabled` (toggle), `holdFireHorizonSeconds` and
  `holdFireLineRadiusPx` (sliders) sit on the same surface — see
  [section 9.13](#913-hold-station-posture-stay-still-and-shoot-ah-0mww2pfu8001j0pm).
- **Validation (AC5).** `src/ai/botHumanLike.test.ts` covers the turn hold,
  the skill error and the adaptive decay/re-arm/determinism,
  `src/ai/framework/competent/steering.test.ts` and `behaviours.test.ts` cover
  the intercept solve and the engage aim/target id, and
  `src/ai/botRotationSkills.integration.test.ts` wires the shared
  competent brain + governor + shipped `AsteroidsModel` into a deterministic
  60 Hz run that tracks an off-axis moving enemy with a settled bearing error
  ≤ **0.05 rad**, and zeroes the live adaptive error in under repeated hits.
- **Accuracy harness (AH-0MWR05EZE0044Z01 · AC5).** The proof that the solve
  is more accurate is a number, not an opinion:
  `src/ai/eval/aimAccuracy.test.ts` measures the **shipped** aim path in the
  headless arena over a fixed seed list (`AIM_ACCURACY_SEEDS` = `[1, 7, 42]`),
  `AIM_ACCURACY_TICKS` = 1 800 ticks at `AIM_ACCURACY_DT` = 1/60 s, one
  scenario per movement class (`chaser` / `diver` / `patroller` / `formation` /
  `roamer`). Each shot is graded by `tallyAimShots`: **hit rate** =
  `shotsHit / shotsFired` and **mean miss distance** = the mean of
  `ArenaAimShot.missDistance` over shots that did not connect with the aimed
  target. The current solve is measured with `aimErrorRad = 0`
  (`runAimAccuracy({ aimErrorRad: 0 })`) so the comparison is of the solve, not
  of the fallibility knob; the pre-change baseline is reproduced with
  `aimLeadFromTracker: false` and pinned in `src/ai/eval/aimAccuracy.baseline.json`.
  The regression test `beats the pinned pre-change baseline, pooled, with
  aimErrorRad = 0` asserts the **pooled hit rate** is strictly higher and the
  **pooled mean miss distance** strictly lower, printing the per-class
  before/after table (`formatAimAccuracyComparison`) on failure. Recorded
  pooled reached **0.5624 vs 0.5099** hit rate and **22.3498 vs 23.6664** px
  mean miss distance (current vs baseline). The fixture is a recorded
  observation: a future deliberate tuning change must re-baseline on purpose,
  never silently re-snap it to pass.

### 9.9 Live thruster config carried in the snapshot (AH-0MV85WFWD0029DL7)

The `BotSnapshot` player carries the ship's **live thruster physics** so the
bot sees exactly the tuning the player configured, with no hard-coded physics
in the decision layer:

- `Player.getThrusterConfig()` exposes the forward trio
  (`thrustAcceleration` / `maxSpeed` / `frictionDeceleration`) plus the
  reverse trio (`reverseEnabled` / `reverseAcceleration` / `reverseMaxSpeed`),
  mirroring the `getRotationConfig()` precedent by reading the live/effective
  `_config`.
- `buildBotSnapshot` copies it onto `BotPlayer.thruster` through the
  optional `getThrusterConfig` seam on `BotPlayerSource` — when the source
  does not expose the getter the field is omitted, so pre-existing sources
  (and the fixture snapshots the harness builds) keep today's exact shape.
- `BotWorld.player` passes the snapshot player through unchanged: no
  re-derivation and no live-game access inside the decision layer.
- The shipped demo path (`PlayScene._advanceDemoBot` →
  `buildBotSnapshot(this)`) and the bot-tuning gym (`GymBotTuning` source)
  pick the values up automatically because the live `Player` satisfies the
  seam.

**Fallback/override precedence (AH-0MV85WH2V005NZTX).** The steering layer
resolves the carried physics against the tunables with `explicit tuning
override > live ship config > compiled default` ([section 9.4](#94-single-sourced-tuning-ac5)): at the compiled defaults the live config wins bit-for-bit
as before, while a `GymBotTuning` override (a value differing from the
compiled default) wins over the live config — through the same
`resolveCompetentTunables` seam in `PlayScene` and the bot-tuning gym
(`GymBotTuning`), so the gym and the shipped demo can never resolve the
tunables differently.

### 9.10 Predictive hazard avoidance (AH-0MVI4QDN90037DIN)

The demo bot avoids **where a moving hazard will be**, not just where it is
now. Aim lead ([section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98)) covers
leading a target; this section covers the avoidance half.

- **Bot-side velocity estimation (AC1).** The snapshot seam exposes no
  per-archetype entity velocity for formation enemies, so `buildBotSnapshot`
  assigns every enemy a **stable bot-side `id`** (a module-local `WeakMap`
  keyed by the source object; a source that already exposes a numeric `id`
  keeps it) and `trackHazardVelocities(memory, snapshot, dt)`
  (`src/ai/framework/hazardVelocity.ts`) derives each live hazard's velocity
  from its position delta across consecutive decision ticks, divided by the
  injected `dt`. The estimate lives in `BotMemory.hazardVelocities` (keyed
  `enemy:<id>` / `boss`), so it is deterministic for an identical
  snapshot+`dt` sequence and is cleared by `resetBotMemory`. Spurious jumps
  (wrap-around, respawn, teleport) are clamped to
  `HAZARD_MAX_ESTIMATED_SPEED` (900 px/s); a hazard with no history, no
  estimate, or no stable id is treated as **stationary** (today's
  behaviour); an unseen hazard keeps its last estimate for
  `HAZARD_VELOCITY_STALE_TICKS` (30) ticks before it is pruned.
- **Predictive steering (AC2).** `evaluateDirection` keeps the positional
  `dangerMargin` rule and, when `hazardPredictionEnabled` is on and the
  hazard's estimate is non-zero, additionally solves the closest approach of
  the ship (at the candidate bearing's speed) and the hazard over
  `hazardPredictionHorizon`, rejecting the bearing when they come within
  `threatRadius` — the same relative-motion primitive the incoming-fire
  prediction uses. The `engage` behaviour's kiting gate calls the shared
  `hazardThreatensPlayer` predicate, so "imminent hazard collision" means the
  same thing in both places. With prediction off — or a stationary/untracked
  hazard — both paths reduce bit-for-bit to the positional rule.
- **Class-shaped sampling (AH-0MWM0C9F9006HNXV; per-class horizon
  AH-0MWM0CB2Q003Y6AB; reconciled and shipped on by AH-0MWOKL79Z0051ZXO).** A
  single fixed-velocity solve predicts a curving hazard where it *was*.
  `predictMinimumSeparation` (`src/ai/framework/hazardMotionModel.ts`) instead
  advances the hazard's **movement-class trajectory** over its class-scaled
  threat window in a fixed sample count (`ceil(horizon / 0.05 s)`, capped at
  64 — no clock, no RNG) and returns the minimum separation over the sampled
  path with its time. The class models are documented approximations built from
  the fitted velocity: `chaser` **pure pursuit** (each sample re-aims at the
  ship's predicted position — the shipped ghost steering's own rule, so the
  fitted curvature is not used as a turn rate), `diver` a committed straight
  dive vector (aimed at the ship before the commit cone), `patroller` a straight
  patrol that runs straight at the ship once in commit range or inside the
  commit cone, `formation` a linear drift that reflects at the arena edges, and
  `roamer` linear extrapolation.
  **One trajectory definition:** `advanceHazardMotion` is the single
  implementation of each class path. The evaluation arena's opt-in
  moving-hostile mode advances its live bodies through the *same* call, so a
  harness profile cannot describe a trajectory the predictor does not (an
  unknown class throws). `src/ai/eval/arena.test.ts` pins that seam and
  `src/ai/eval/hazardMotionSweep.test.ts` is the evidence.
  **One predictive test, every consumer:** `evaluateDirection`'s hazard
  rejection, `hazardThreatensPlayer` and the `engage` kiting gate all call the
  sampler, so a change to the models, the horizon or the toggle lands in all
  three at once. The window is `hazardPredictionHorizon` scaled per movement
  class (`hazardClassHorizonScale`): only a class whose threat is a **discrete
  commit later in the window** is judged further ahead (`diver` 1.4,
  `patroller` 1.25), while a continuous closing geometry (`chaser`) or a
  straight line (`roamer`, `formation`) stays at exactly the configured horizon.
  The **drift** classes also earn a bounded boost from the fitted curvature
  (≤ 1.5×, saturating at `HAZARD_CURVATURE_SATURATION_RATE`), because their
  model is straight and an observed turn is new information; an aiming class
  already models its own turn, so boosting its window would only lengthen the
  predicted chase and make the pilot over-dodge. An exempt engagement target
  keeps only the positional `dangerMargin` rule, never the predictive test. A
  hazard that cannot reach `threatRadius` inside the horizon is dismissed by a
  triangle-inequality **early-out** without sampling (its reported separation is
  a proven lower bound); a class path that stays on its fitted velocity for the
  whole window (`roamer`, or a `formation` that does not reach a bound) returns
  the fixed-velocity solve **bit-for-bit**, which is what makes the sweep's
  straight-line controls provably unaffected; and a stationary hazard, a
  disabled `hazardMotionModelEnabled` or an unknown class reproduces the
  previous positional / fixed-velocity result exactly — on the configured
  horizon.
  **It ships on** (`hazardMotionModelEnabled` defaults to `true`) on the seeded
  per-class sweep evidence in `src/ai/eval/hazardMotionSweep.test.ts`: the
  curving classes record strictly fewer avoidable enemy-body contacts on a
  strict majority of a documented 12-seed list, the chaser arm never regresses,
  and the `roamer`/`formation` controls never increase. Two earlier dark
  defaults' causes were real model errors, both fixed in this item: the chaser's
  constant-turn-rate arc (fitted from the last two position deltas) predicted a
  threat on *every* escape bearing, so the pilot hovered beside a pursuer
  instead of fleeing it; and the chaser's 1.6 horizon made the pilot kite
  instead of fight in `promo-ghost-hunt`. `hazardMotionModel.test.ts` pins the
  default (and `promo-ghost-hunt`'s 45 s survival target stays green with the
  model on) so neither can regress silently.
- **Live tuning (AC3).** `hazardPredictionEnabled` (toggle, default **on**)
  and `hazardPredictionHorizon` (slider, default **0.6 s**) live in
  `COMPETENT_BOT_TUNABLES`, are registered in `src/ai/tuningFields.ts` with
  documented bounds/descriptions, and are applied live by `GymBotTuning`
  exactly like the aim-lead knobs ([section 12](#12-tuning-the-bot-live-the-bot-tuning-gym)).
  The motion model's own knobs are designer-facing too (AH-0MWM0CCJE000AANE):
  the `hazardMotionModelEnabled` toggle (default **on**; off reproduces the
  constant-velocity control arm) and one `hazardClassHorizonScale.<class>`
  slider per movement class (`chaser` 1, `diver` 1.4, `patroller` 1.25,
  `formation` 1, `roamer` 1 — the multiplier on `hazardPredictionHorizon`; the
  sliders are inert while the model toggle is off), applied live without a
  scene restart and carried in `src/data/bot-tuning.json`.
- **Validation (AC4).** `hazardVelocity.test.ts` covers the estimator
  (stable velocity, stationary zero, clamp, stale retention/pruning, reset,
  determinism); `steering.test.ts` and `behaviours.test.ts` cover the
  predicted rejection and the kiting gate against the disabled/stationary
  baselines; and `src/ai/botSteering.integration.test.ts` runs the shared
  competent brain in a deterministic 60 Hz kinematic loop (the steering
  model's own assumption, isolating the prediction from ship inertia) where a
  straight crossing enemy collides with prediction off and is evaded (minimum
  ship–hazard distance ≥ `threatRadius` minus tolerance) with it on.

**Movement classes at a glance.** `advanceHazardMotion`
(`src/ai/framework/hazardMotionModel.ts`) is the single definition of each
class path; the sampler walks it and the evaluation arena's opt-in
moving-hostile mode advances its live bodies through the same call (an unknown
class throws rather than diverging). The table pairs each class with the
prediction that follows from it and how it changes the threat window. The
shipped default values, slider bounds and plain-English descriptions live in
the registry (`src/ai/tuningFields.ts`) and `COMPETENT_BOT_TUNABLES` — this
document names the registry rather than duplicating them, and the bundled
baseline is `src/data/bot-tuning.json`.

| Movement class | Predicted path | Threat window (urgency) | Shipped archetypes |
|---|---|---|---|
| `chaser` | Pure pursuit: every sample re-aims at the ship's predicted position at its observed speed (the ghost steering's own `steerToward` rule); the fitted curvature is deliberately **not** a turn rate | `hazardPredictionHorizon` × the class scale (1), **no** curvature boost — the pursuit already turns the hazard onto the ship | `ghost-chase`, `ghost-ambush`, `ghost-flank`, `ghost-wander`, `grunt` |
| `diver` | Committed straight dive vector inside the ~60° commit cone; before commitment it flies the dive vector at the ship | Longer than configured (1.4) — the discrete dive commit later in the window must be seen early enough | `diver` |
| `patroller` | Straight patrol, switching to a straight attack run inside `HAZARD_PATROL_COMMIT_RANGE` or once aimed at the ship | Longer than configured (1.25) — the patrol→attack switch is a discrete later event | `raider` |
| `formation` | Linear drift plus a reflection at the arena bounds | Configured (1), plus the bounded curvature boost: its model is straight, so an observed turn is new information | the formation archetypes (`scout`, `tank`, `phaser`, `swarm`, `march`, …) |
| `roamer` | Linear extrapolation — the “assume it keeps going” control | Configured (1), same bounded curvature boost | `asteroid`, `harvester`, `lane-traffic`, `orbital-strike` |

**The disabled-path guarantee is exact.** With `hazardMotionModelEnabled` off,
prediction is the pre-existing constant-velocity solve **bit-for-bit** on the
configured `hazardPredictionHorizon` — the same separation, time and threat
verdict as before the motion model existed. An **unknown movement class**
(fixed-velocity solve) and a **zero-velocity hazard** (current positional
separation) take the same pre-existing path, and even with the model on a class
path that stays on its fitted velocity for the whole window — `roamer` always,
`formation` until it reaches a bound — returns the fixed-velocity solve
exactly. That exactness is what makes the sweep's straight-line controls
provably neutral.

**Evidence.** The seeded per-class sweep
(`src/ai/eval/hazardMotionSweep.test.ts`) records, on its documented 12-seed
list, strictly fewer avoidable enemy-body contacts with the model on for every
curving class on a strict majority of seeds, a chaser arm that never regresses
on any seed, and `roamer`/`formation` controls that never increase. The
deterministic 60 Hz proof (`src/ai/botSteering.integration.test.ts`) flies a
scripted curving chaser twice: the constant-velocity predictor's least
separation is 25.7 px — 4.3 px inside the game's 30 px contact radius — while
the class model stays clear at 38.8 px, and the test pins both margins.

### 9.11 Wrap-aware (torus) model (AH-0MVMISF0Q00314LG)

The playfield is a **torus**: the ship, bullets, asteroids and wrap-aware
enemies cross any edge and reappear on the opposite one. The bot reasons on
that same torus rather than on a bounded rectangle, so a target across a seam
is genuinely nearer and the four edges are no longer walls.

- **One shared geometry.** `src/utils/wrapGeometry.ts` is the single
  implementation: `wrapAxis`, `wrapPosition`, `wrappedAxisDelta`,
  `wrappedDelta`, `wrappedDistance`, `wrappedBearing` and
  `chooseWrappedRoute` (the near-tie hysteresis). The enemy seam modules
  (`src/scenes/core/enemyTargeting.ts`, `enemyWrap.ts`) re-export it, and
  `src/ai/framework/wrapGeometry.ts` is the bot-facing binding (`botWrapWorld`,
  `wrappedDeltaToPlayer`, …). No behaviour carries its own seam maths.
- **Wrapped steering and aim.** `bearingTo` / `interceptPoint` accept an
  optional `WrapWorld`; with it the bearing and the lead solve follow the
  shortest wrapped route (firing off one edge to arrive from the opposite
  one). The legacy `approachIntent` uses the same route chooser.
- **Wrapped nearest-selection and behaviours.** `nearestTarget`,
  `bestWeightedTarget`, the boss/enemy proximity gates, `nearestEnemyDistance`
  and the collect/engage/evade distances measure wrapped distance, so a
  mineral or enemy just across a seam wins. `evade` flees along the wrapped
  route, away from a shot that arrived across a seam.
- **Wrapped threat and hazard prediction.** `predictIncomingFire`, the
  competent `closestApproach` solves and the legacy path-crossing checks use
  the shortest wrapped relative delta, so a seam-crossing shot is predicted
  and dodged. `trackHazardVelocities` wraps its position delta, so a hazard
  that crosses a seam yields its true velocity instead of a clamped jump;
  a respawn/teleport is still clamped.
- **Near-tie hysteresis.** `chooseWrappedRoute` keeps the caller's previous
  route (else the raw route) when the raw and wrapped lengths differ by less
  than `DEFAULT_WRAP_ROUTE_TOLERANCE` (1 px), so a target near the half-width
  cannot flip duplicates tick-to-tick; a genuinely shorter route (by more than
  the tolerance) is always taken.
- **`wallMargin` retired.** The tunable no longer exists: an edge is not a
  wall, so it is neither a safety nor a clearance constraint
  (`botDecision.ts`, `competent/tunables.ts`, `style/fitting.ts`,
  `tuningFields.ts`, `src/data/bot-tuning.json`). A saved config that still
  carries the field loads and ignores it.
- **Human-like governor preserved.** `src/ai/botHumanLike.ts` is unchanged:
  reaction cadence, W/A/D control mapping, reverse control, seeded aim-skill
  noise and human-feel thrust presses all still apply. Wrap-awareness is a
  **model** property — the same governor flies the wrap-aware bot.
- **Eval parity.** The headless arena (`src/ai/eval/arena.ts`) wraps player and
  enemy bullets at all four edges, expires them by their game lifetimes and
  aims hostile fire along the shortest wrapped path, so eval scores measure the
  same wrap-around world the bot faces in the game
  ([docs/EVALUATION.md](./EVALUATION.md#fidelity-boundary-and-limitations)).

### 9.12 Smooth turning and overshoot tolerance (AH-0MWJ1680Z001QYV2 audit rejection)

The producer's review of the two-layer objective model was
**"still too much left/right turning ... trying to be very precise with its
positioning ... it should allow for a little overshoot and not rely so much on
thrusters for precise positioning"**. The objective layer was not the problem;
the *control* layer was. The ship drifts in a frictionless arena, so chasing a
bearing to a fraction of a degree with A/D — and braking onto every pickup
with S — is both impossible and unwatchable. The governor and the collection
behaviour now treat flying as a coarse, human action.

- **Turning deadband.** `alignmentToleranceRad` defaults to **0.18 rad**
  (~10°, up from 0.15): no turn key is pressed for a smaller heading error, so
  the ship simply flies on.
- **Reversal hysteresis.** `turnHysteresisRad` (**0.25 rad**) requires the
  predicted error to exceed the deadband by that margin before an established
  turn is **reversed**. Inside the margin the turn is released instead (the
  small overshoot coasts out) rather than braked with the opposite key. It is
  `0`-able and inert when the ship's live `angularVelocity` is unavailable
  (no coast to predict).
- **Turn-press hold.** `turnPressMinMs` (**40 ms**) holds an established turn
  key for a human-like burst instead of toggling on and off within a reaction;
  a flip requested inside the window is **released**, never dithered to the
  opposite key. Thrust and reverse are untouched, so a safety brake is never
  delayed. **Aim intents are exempt from this hold** — holding the weapon axis
  on a target is a precision task, so an `aim` intent keeps the closed-loop
  per-tick release (§9.8). Aim intents instead get their own, narrower
  anti-dither guard: with `aimDampingEnabled` on, an established aim turn
  cannot flip for `aimTurnHoldMs` while releases stay immediate
  (AH-0MWT4BBYO0085CN8 · RAC1, §9.8).
- **Pass-through collection.** Pickups are collected on **contact**, so the
  collect behaviour no longer retro-brakes onto one (`collectReverseBrake`
  defaults to `false`; the retro thruster is still available behind the
  toggle). It flies through the pickup and accepts the overshoot.
- **Overshoot is accepted, not chased.** A mineral/power-up inside
  `collectOvershootMargin` (**60 px**) that is **behind the ship's velocity
  vector** drops out of the collection target set (`isOvershot` /
  `withoutOvershot` in `competent/goals.ts`), so the bot does not U-turn for a
  pickup it has just passed; the pickup becomes collectable again once it is
  ahead. Both the collection goals and the collect behaviour apply the same
  filter, so the goal that is scored is the target that is flown at.
- **Reposition stops at the band edge.** The idle `reposition` behaviour gives
  the forward model `repositionRadius` as its arrival radius, so the ship
  coasts to a stop near the edge of its idle band instead of thrusting at the
  exact playfield centre, overshooting it and drifting back.
- **Measurement.** `src/ai/eval/turnChurn.ts` summarises a per-tick input trace
  (turn duty cycle, turn presses and mean press length, direct left/right
  flips, reversals and course changes, forward toggles, retro presses) and
  reads the arena's recorded input, so any seeded run is measurable.
  `competentBot.integration.test.ts` A/Bs the pre-change and shipped control on
  one seeded scenario; the smoother control halves the turn-key presses and
  cuts the turn duty cycle by roughly a third while keeping the objective
  score, and the bullet-free objective sweep still wins the large majority of
  seeds.
- **Live tuning.** All four knobs (`alignmentToleranceRad`,
  `turnHysteresisRad`, `turnPressMinMs`, plus the `collectReverseBrake` toggle
  and `collectOvershootMargin` slider) are in the bot-tuning surface
  (`src/ai/tuningFields.ts`) and the bundled baseline
  (`src/data/bot-tuning.json`).

### 9.13 Hold-station posture: stay still and shoot (AH-0MWW2PFU8001J0PM)

The aim solve (§9.8) made the bot *able* to hit a moving target, but a
play-test rejected the result for the opposite reason: **the bot kept driving
while it engaged**, and the movement spoiled the aim.

> "It is still moving when it doesn't need to and this movement means it is
> inaccurate. When it is not under threat from an incoming bullet, enemy or
> asteroid and it is not collecting powerups or minerals it should stay still
> using only the left and right thrusters to aim. … In short the bot should
> predict future hits and only move if there is no likely hit within the next
> 1s" — producer audit rejection, 2026-11-25

The posture is therefore a **prediction**, not a tuning preference.

- **Fire solution (`src/ai/framework/competent/hitPrediction.ts`).**
  `evaluateFireSolution` judges a shot aimed at a solved lead point: the
  horizon covers **the time to finish the turn** (derived from the live
  rotation model, §9.8) **plus the shot's time of flight** on the torus, so a
  distant or fast target the shot would reach too late does not justify
  holding. `resolveFireSolution` solves the lead first — the same
  `interceptPointClassAware` solve the aim uses, advancing the target along
  `advanceHazardMotion` (no second trajectory model) — and `classSampling:
  false` is its documented bit-for-bit fallback to the legacy
  constant-velocity lead, which is the cheap screen the target scan uses.
  `countShotLineTargets` is the producer's "line of targets": how many other
  hazards the shot line sweeps, on the torus.
- **Hold station while a hit is likely (`holdFireEnabled`).** While `engage`
  is **calm** — nothing incoming threatens the hull (`threatens` shots) and no
  hazard other than the engagement target is on a collision course
  (`hazardThreatensPlayer`, the class-shaped predictive test) — and a solution
  exists inside `holdFireHorizonSeconds` (**1 s**), the intent requests **no
  forward and no reverse thrust**, whatever the distance to the target, and
  `planSteering`'s `hold` option suppresses the fan's "force the throttle on
  while turning" rule. The hull only rotates onto the solved lead, so the
  weapon axis stays still instead of the ship chasing a standoff.
- **Move only when nothing can be hit.** With no solution inside the horizon
  the ordinary approach/standoff policy runs unchanged and the ship closes to
  where its shot lands in time. Danger still overrides everything: a
  threatening shot keeps diverting to `evade`, and the kiting / retro-brake
  paths still fire on a genuine threat.
- **Line-of-fire target preference (`holdFireLineRadiusPx`, default 14 px).**
  With the posture on, the engaged target is chosen from the candidates the
  ship can **actually hit** — and, among those, the one whose line also sweeps
  more bodies (`countShotLineTargets`) — instead of the merely nearest body.
  With no hittable candidate the ordinary weighted choice stands. The
  preference lives entirely inside the behaviour: goal utilities and the hard
  priority bands are untouched, and the boss goal keeps its boss-only target
  set.
- **Measurement (AC5).** `src/ai/eval/holdStation.ts` folds the scripted
  control-loop trace (§9.12's calm scenario: nothing fires, nothing dies, no
  other hazard or pickup) into **drive duty** (ticks with forward or reverse
  held) and **drift** (the distance the hull travelled), because a steady
  pointless throttle never shows up in a transition count. Measured over the
  documented matrix (5 movement classes × seeds 1/7/42 × 1 800 ticks):
  - **drive duty 9.33 % → 0.24 %** and **drift 6 087.94 px → 67.26 px**
    (forward-held ticks 2 247 → 49, reverse-held 272 → 16);
  - live accuracy on the same seeded fights (chaser/diver/patroller × the same
    seeds) **63.50 % → 71.68 %** hit rate (395/622 → 453/632 hits) — standing
    still does not cost hits.
- **Factory default off, shipped preset on.** `holdFireEnabled` is `false` in
  the compiled defaults, so every pre-change measurement (aim accuracy,
  oscillation, arena telemetry and the gym-parity fixtures) stays byte-for-
  byte identical; the shipped `Default` preset turns it on, exactly like the
  oscillation damping (AH-0MWT4BBYO0085CN8). `holdFireHorizonSeconds` and
  `holdFireLineRadiusPx` are ordinary live sliders
  ([section 12](#12-tuning-the-bot-live-the-bot-tuning-gym)).

### 9.14 Fire discipline: never fire at nothing (AH-0MWPOET5A002IPTP)

The hold-station posture (§9.13) stopped the bot driving while it engaged, but
a later play-test rejected the result from the other side of the same problem:

> "The bot will sometimes appear to be firing at nothing. It should be aware of
> the range of its weapons … The ship should never be firing away from targets,
> unless maneuvering for a defined purpose." — producer audit rejection,
> 2026-11-25

The cause is structural. The player **auto-fires along its committed facing**
(`CombatCoreScene._autoFire` → `player.tryFire`) with no aim gate, which is the
intended "hold the trigger" feel for a human. A bot that is collecting,
evading or repositioning points its nose away from every target for much of a
run, so the unconditional trigger keeps shooting into empty space. Separately,
the fire solution judged a shot only by **time** against the horizon, never by
the active weapon's **reach**, so the hold-station posture could hold at
`engagementRange` (140 px) with a short-reach weapon (Rapid ≈ 131 px) and fire
at nothing.

- **Weapon-range awareness.** `Player.getEffectiveWeaponRange()` derives the
  ship's reach from the live active loadout — `PLAYER_BULLET_SPEED ×
  bulletLifetime` for a travelling shot, `hitscan.length` for a beam,
  `aoe.projectileSpeed × bulletLifetime` for a random-detonation AOE and the
  effect radius for an instant AOE — and takes the **farthest** active weapon
  (the ship fires them all together). It is carried on the snapshot seam as
  `BotPlayer.weaponRange` (the `shotSpeed` precedent), so `src/ai` never
  hard-codes a weapon constant. `evaluateFireSolution` / `resolveFireSolution`
  report `inRange` and only count a shot as a hit inside that reach; the
  hold-station posture and the line-of-fire target preference require it. A
  snapshot **without** a range (`0`/absent) disables the gate and reproduces
  the pre-change time-of-flight-only judgement byte-for-byte, which is what
  keeps the pinned accuracy/oscillation fixtures unchanged.
- **The fire-line gate (`src/ai/framework/competent/fireLine.ts`).**
  `hasFireLine` is the single definition of "this shot has a target": a live
  body lies **ahead of the muzzle**, inside the weapon's reach, and close
  enough to the shot's ray that the body and the bullet would meet
  (perpendicular offset ≤ the body's hit radius + `BOT_FIRE_LINE_RADIUS_PX`,
  the shared bullet radius). It is torus-aware and pure.
- **One shared scene hook.** `CombatCoreScene.botFireAllowed()` defaults to
  `true` (a scene with no bot, and every human session, is unchanged). A
  bot-bearing scene overrides it with `hasFireLine` over the same targets the
  shared hitscan path intercepts — `PlayScene` in demo mode and `GymBotTuning`
  — so the game and the bot gym cannot diverge. When it returns `false` the
  shared player step spawns no bullets, muzzle flashes or fire cues, exactly
  like the run-end suppression, and the beat clock keeps advancing so the
  beat-modulated hum and explosion grid do not stall. A held shot resumes on
  the first tick the nose finds a target in reach.
- **Measurement.** `src/ai/eval/fireDiscipline.test.ts` flies the documented
  accuracy matrix (5 movement classes × seeds 1/7/42 × 1 800 ticks) twice —
  gate off (the shipped unconditional trigger) and gate on — and reports
  shots fired / hits / hit rate / **shots-at-nothing** per arm. The gate arm
  fires nothing at nothing, never fires more shots than the ungated arm and
  keeps at least the ungated hit rate. The arena models the same gate behind
  the opt-in `ArenaConfig.botFireGate`, so the measurement drives the real
  predicate rather than a harness-only copy.
- **Scope boundary.** The gate applies to the demo/attract bot only. A human
  holding fire keeps the unconditional trigger; a level-resolved loadout can
  extend the reach, and `hasFireLine` reports `true` when the reach is unknown
  so an older snapshot or fixture can never be silently silenced.

## 10. Testing

The framework's unit tests live beside it:

- `worldModel.test.ts` — prediction in isolation, including a player dodge.
- `registry.test.ts` — registration, lookup, duplicate protection, order.
- `content.test.ts` — content lookup, the documented unknown-content default,
  and duplicate protection.
- `commitment.test.ts` — the three release rules and deterministic replay.
- `botBrain.test.ts` — selection, dispatch, fallback, world integration and
  deterministic replay of a decision sequence.
- `legacyPolicy.test.ts` — parity with the original pure decision.

The competent content is tested in `src/ai/framework/competent/`:

- `steering.test.ts` — safe/unsafe bearings, path-around, aim, forward model,
  predictive hazard avoidance.
- `hazardVelocity.test.ts` — the bot-side hazard-velocity estimator.
- `goals.test.ts` — utility bands and priority order.
- `behaviours.test.ts` — collect/engage/evade/reposition intents.
- `content.test.ts` — synthetic enemy/asteroid/drop content, the shipped
  registry completeness guard, and graceful unknown content (AC3/AC4).
- `competentBot.test.ts` — commitment/hysteresis and dispatch.
- `competentBot.integration.test.ts` — a deterministic seeded run, the
  hard-constraint dodge, the priority-weighted A/B against the legacy ladder
  (AC6), and a majority-based **objective-advantage seed sweep** that compares
  the objective sub-score (minerals, power-ups, enemies) on a bullet-free
  scenario over a documented 32-seed set, so a small feel tweak cannot fail
  the suite by flipping one representative run.

`botFrameworkDocs.test.ts`, `competent/competentBotDocs.test.ts` and
`contentDocs.test.ts` guard the presence of this document and its key
sections.

## 11. Teaching the bot about new content

New enemies, power-ups and weapons are handled through the **content
registry** (`src/ai/framework/content.ts`) — no core, goal or behaviour code
changes (AH-0MUY08X98002TRHT). The registry has two profile kinds.

### 11.1 Enemy archetype profiles (`EnemyContentProfile`)

```ts
export interface EnemyContentProfile {
  id: string;                     // archetype key, e.g. 'diver'
  threat: number;                 // relative threat, neutral 1
  engagementRange?: number;       // preferred standoff px (optional)
  aim: 'none' | 'direct' | 'lead';// how to hold the aim axis
  asteroidLike: boolean;          // true = asteroid-band hazard
}
```

- **`threat`** scales the archetype's proximity score inside the enemy band,
  so a more dangerous enemy is engaged first. It is relative and **never**
  lets the enemy band outrank the collection bands.
- **`engagementRange`** is the preferred standoff. Omit it to use the
  behaviour tunable (`COMPETENT_BOT_TUNABLES.engagementRange`), keeping ranges
  single-sourced unless an archetype needs its own.
- **`aim`** is how the bot holds its aim axis. `direct` points the hull at the
  target and coasts once in range; `none` closes without aim reasoning (e.g.
  the mineral-seeking harvester); `lead` is reserved for predictive lead and
  currently behaves as `direct` because the read-only snapshot exposes no
  enemy velocity.
- **`asteroidLike`** is what the world model uses to partition the archetype
  into `liveAsteroids` (the `engage-asteroid` band). An unknown archetype is
  treated as a non-asteroid combat target.

**The shipped boss profile.** `COMPETENT_BOT_CONTENT` registers
`{ id: 'boss', threat: 2, aim: 'direct', asteroidLike: false }`
(AH-0MVBMESIE003YQ68 · AC1) — twice the neutral enemy weight, aimed directly,
with no `engagementRange` override so its standoff stays single-sourced in
the tunables. The final boss and every per-level mini-boss arrive at the bot
through the same `boss` snapshot slot, so they share this profile. While a
live boss is inside the enemy seek range the `engage-boss` band (section 9.1)
gives it hard priority regardless of nearer enemies; the `threat: 2` weight
is the *fallback* value used when the band is invalid (boss out of range).

### 11.2 Power-up / weapon drop profiles (`DropContentProfile`)

```ts
export interface DropContentProfile {
  id: string;      // drop id, e.g. 'extra_life' or 'nova'
  value: number;   // collection desirability, neutral 1
}
```

`value` is consumed twice: the `collect-powerup` goal scorer scales its
utility by it, and the `collect` behaviour prefers the best
`value / (1 + distance)` target. A higher value therefore beats a slightly
nearer lower-value drop, while a value of `1` reproduces the legacy
nearest-first behaviour exactly.

### 11.3 Registering synthetic or custom content

Build a registry and pass it to the brain; the factory's `content` option
defaults to the shipped `COMPETENT_BOT_CONTENT`:

```ts
import { createBotContent, createCompetentBotBrain } from './framework';

const content = createBotContent({
  enemies: [
    { id: 'sapper', threat: 1.4, engagementRange: 180, aim: 'direct',
      asteroidLike: false },
    { id: 'void_rock', threat: 1, aim: 'direct', asteroidLike: true },
  ],
  drops: [{ id: 'quantum_core', value: 1.5 }],
});

const brain = createCompetentBotBrain({ content });
```

The brain now treats `sapper` as a priority combat target, `void_rock` as an
asteroid-band hazard, and `quantum_core` as a high-value collection target —
with no code change anywhere in the framework or the competent content.

### 11.4 Unknown content (documented default)

Lookup for an id that is not registered resolves to the documented default
rather than throwing:

| Unknown | Resolves to | Effect |
|---|---|---|
| enemy archetype | `DEFAULT_ENEMY_PROFILE` | `threat: 1`, `aim: 'direct'`, `asteroidLike: false`, tunable engagement range |
| drop id | `DEFAULT_DROP_PROFILE` | `value: 1` (neutral, nearest-first collection) |

This mirrors the enemy factory, which falls back to `Scout` for a custom
Save-As archetype, so a new entity never freezes or derails the bot.

### 11.5 Where the shipped content lives

The shipped profiles are in `src/ai/framework/competent/content.ts`
(`COMPETENT_BOT_CONTENT`): every archetype `createEnemyFromConfig` can spawn
plus the boss (`BOSS_ENEMY_ID`, spawned by its own layer), and every id in
`POWER_UP_CATALOGUE` / `WEAPON_DROP_IDS` has an entry. A guard test fails if a
new game id is added without a profile.

## 12. Tuning the bot live (the bot-tuning gym)

The **Bot Tuning** gym (`src/scenes/gym/GymBotTuning.ts`, listed as
`BotTuning` on the gym index) is the hands-on companion to the headless
evaluation arena. It lets a designer watch the structured competent bot play
and adjust its parameters in real time.

- **Random, reproducible levels.** `src/utils/randomLevel.ts` wraps the
  runtime auto-sequencer (`src/core/difficultySequencer.ts`) to generate a
  `LevelDefinition` from a seed. The same seed produces the same level, so a
  before/after tuning comparison is apples to apples. When a level is cleared
  the gym generates a fresh one (or press **New Random Level**).
- **Shared bot behaviour.** The gym drives the player through the shared
  `CombatCoreScene.getBotInput()` seam with the same
  `createCompetentBotBrain()` policy and `BotInputGovernor` that `PlayScene`
  uses — no divergent copy. The only gym-specific state is the scenario (the
  tuning UI; the inherited supply layer below).
- **Shared supply layer.** `GymLevel` plays every level with the game's
  supply mechanics: a mineral field is seeded, a destroyed enemy leaves
  minerals via the shared `resolveMineralKillDrops` rule, and power-up/weapon
  drops appear on the field on the shared `buildDefaultDropSpawner` +
  `RandomAvoidingPlacement` cadence. Minerals and drops are collected through
  the shared `collectMinerals` / `_updateDropLayer` paths, so the bot's
  `collect-mineral`, `collect-powerup` and `secure-life` goals are exercised
  exactly as they are in the game. The live drops and minerals are exposed in
  the bot snapshot (`getBotSnapshot()`); a full mineral hold resolves through
  the shared `applyMineralChoiceReward` **without** the modal choice scene, so
  an autonomous run never pauses (the single documented gym-only divergence).
- **Live sliders.** The collapsible panel exposes one slider per entry in
  `BOT_TUNING_NUMERIC_FIELDS` (`src/ai/tuningFields.ts`) plus boolean toggles:
  the utility bands, seek ranges, standoff/danger margins, prediction
  horizons and speeds, steering weights, commitment hysteresis, the world
  model, the human-input reaction/press cadence (including the smooth-turning
  knobs `alignmentToleranceRad` / `turnHysteresisRad` / `turnPressMinMs`),
  collection's `collectReverseBrake` toggle and `collectOvershootMargin`
  slider, the rotation-skill knobs `skill` / `maxAimErrorRad` /
  `aimErrorRad` / `aimErrorDecay` / `aimErrorResetDistance` /
  `aimLeadAlignSeconds` / `aimLeadIterations` (`aimLeadEnabled` toggle), and
  the hold-station posture `holdFireEnabled` (toggle) /
  `holdFireHorizonSeconds` / `holdFireLineRadiusPx` (sliders)
  (AH-0MV1DUSM2005HL98 · AC4; posture: AH-0MWW2PFU8001J0PM,
  [section 9.13](#913-hold-station-posture-stay-still-and-shoot-ah-0mww2pfu8001j0pm);
  smooth turning:
  AH-0MWJ1680Z001QYV2 audit rejection, [section 9.12](#912-smooth-turning-and-overshoot-tolerance-ah-0mwj1680z001qyv2-audit-rejection)).
  Moving a slider rebuilds the live brain and governor immediately. The `playerSpeed` / `frictionDeceleration` sliders
  are **overrides**: moving one away from its default makes it win over the
  live ship config; left at the default it is a fallback and the ship's live
  config wins (the same precedence the shipped demo resolves —
  [section 9.4](#94-single-sourced-tuning-ac5)).
- **Adaptive aim-error knobs (AH-0MWR057Q8004PBOD · AH-0MWR05J320041SAA).**
  Three live sliders drive the learning aim error described in
  [section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98):
  - **`aimErrorRad`** (default **0.02** rad) — the live aim-error magnitude.
    It starts at this value and only perturbs intents flagged as **aim**
    (never survival/evade/travel). At **`0`** the governor consumes no draw and
    the committed decision is byte-for-byte the pre-adaptive aim.
  - **`aimErrorDecay`** (default **0.5**) — the multiplier applied to the live
    error on every confirmed hit on the engaged target (`notifyAimHit` seam),
    floored at **0**, so a bot that keeps connecting zeroes in. At **`1`** the
    error never decays (a fixed aim error); at **`0`** a single hit removes it.
  - **`aimErrorResetDistance`** (default **60** px, torus-aware) — the ship
    travel, measured from its position at the last hit, after which the error
    is restored to `aimErrorRad` (a **repositioning move**). Changing the
    engagement target also re-arms it. At **`0`** any movement re-arms
    immediately (the error never stays reduced).
  All three are ordinary `BOT_TUNING_NUMERIC_FIELDS` sliders (live-rebuild,
  persisted in `src/data/bot-tuning.json`), and the boss — which has no
  bot-side id in the hit seam — keeps the fixed `skill` error only.
- **Oscillation-damping knobs (AH-0MWT4BBYO0085CN8 · RAC5).** Three controls
  complete the anti-oscillation surface described in
  [section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98):
  - **`aimDampingEnabled`** (toggle, factory **off**, shipped `Default` preset
    **on**) — damps the aim actuator: an established aim turn cannot flip for
    `aimTurnHoldMs`, and the adaptive aim-error angle is held between confirmed
    hits instead of being redrawn every reaction. Off restores the exact
    pre-change actuator.
  - **`aimTurnHoldMs`** (default **300 ms**) — the aim flip-hold window. A
    requested reversal inside it is released (the ship coasts); a release is
    still honoured immediately, so aim precision is unchanged. At **`0`** only
    the flip hold is disabled.
  - **`engagementRangeHysteresis`** (default **40 px** in the shipped preset,
    **0** factory) — the sticky band around `engagementRange`. Inside the
    standoff the bot stays inside until the target is this much farther away,
    and the band also suppresses the reverse brake, so the forward and retro
    thrusters cannot toggle across the boundary. At **`0`** the pre-change
    single-boundary rule is restored.
- **Per-parameter tooltips.** Every slider and toggle carries a plain-English
  `description` in its `BotTuningFieldSpec`/`BotTuningToggleSpec`
  (`src/ai/tuningFields.ts`), authored in lockstep with the tunables' JSDoc.
  The gym attaches each description through the reusable `attachTooltip`
  helper (`src/utils/gymTooltip.ts`, styles in `src/style.css`): hover a
  control to read what it does, or tab-focus it — keyboard and screen-reader
  users get the same help because each control's `aria-describedby` points at
  its tooltip (which is appended to `<body>` and `position: fixed`, so the
  panel's scroll container never clips it). Adding a new tunable requires a
  non-empty `description` on its spec — a unit test in
  `src/ai/tuningFields.test.ts` fails otherwise, so no future slider can
  ship unlabelled.
- **Named configurations.** **Save** overwrites the current configuration,
  **Save As…** creates a named one, and the selector loads any saved
  configuration. Presets are persisted by `src/core/botTuningStore.ts` as a
  versioned, corrupt-safe JSON blob in `localStorage` (the same
  browser-native pattern as `src/core/rules.ts`); a missing or malformed blob
  falls back to the **bundled baseline** (`src/data/bot-tuning.json`, shipped
  via `src/core/bundledConfig.ts`) and only then to the built-in `Default`
  (AH-0MV9GZD2C005IIU3). Every Git-tracked build therefore ships the tuned
  configurations, so a fresh checkout or a distributed build (e.g. the GitHub
  Pages alpha) flies the same definitions instead of generic factory defaults.
- **Save to repo (dev server only).** The **Save to repo** button writes the
  current store state back to the Git-tracked baseline
  `src/data/bot-tuning.json` through a dev-only Vite middleware
  (`vite/plugins/botTuningPlugin.ts`, `PUT /api/bot-tuning/src/data/bot-tuning.json`),
  so refreshing the shipped baseline no longer needs the manual
  Export → overwrite → commit dance (AH-0MVBJ0DUI009B6AM). It mirrors the CSV
  write-back precedent: `apply: 'serve'` only, a one-entry allowed-path
  allowlist, schema validation before any file access, and an atomic
  temp-file + rename write. Outside the dev server the control is disabled
  and the store reports the write as unavailable, so a production/static
  build can never mutate the shipped baseline.
- **Watch Demo and recordings fly the saved config.** The shipped attract
  demo (`PlayScene` demo mode) reads the same store when it starts — and when
  the demo is re-enabled mid-session — and rebuilds its `BotBrain` /
  `BotInputGovernor` from the currently-selected configuration through the
  same `toCompetentOverrides` / `toHumanOverrides` mapping the gym uses
  (AH-0MV6MFDYG001E6PL). Outside demo mode the bot seam is inert, so a human
  run never consults the store. Because the recording tools launch a fresh
  browser, the gym's **Export** button downloads the store as JSON for
  `npm run capture -- --bot-config file.json` (and
  `npm run record -- --bot --bot-config file.json`), which injects that state
  into the recording page before the game boots — so a recorded demo flies the
  designer's tuning. Without `--bot-config` the fresh recording browser flies
  the bundled baseline (see above) — not factory defaults.

**Precedence rule:** `localStorage` (a designer's saved selection) → bundled
baseline (`src/data/bot-tuning.json`) → built-in `Default`. A user who saves a
configuration locally keeps it locally; every other context sees the shipped
baseline.

**Curated promo presets (AH-0MVSDM5T1007KBB8):** the bundled baseline also ships
a small catalogue of named presets that the dev-only promo scenarios
([gameplay capture](dev/gameplay-capture.md#promo-scenario-wave-definitions))
select **by name** at run start, so footage varies across scenarios without a
new ShipConfig row (producer answer Q1 = b on AH-0MVI5XI73000ZVYA). Each preset
is authored as a **sparse override map** — only the keys it changes are in the
file, and `coerceTuningValues` fills the rest from `Default` — and `Default`
stays the current selection, so the Watch Demo is unchanged.

| Preset | One-line intent | Distinctive tuning |
|---|---|---|
| `Default` | The shipped tuned bot; the current selection everywhere. | — |
| `aggressive-hunter` | Closes in and picks fights sooner across the whole screen. | higher `enemyBase`/`enemySeekRange`/`enemyWavePressurePort`, tighter `engagementRange`, lower `mineralBase` |
| `cautious-collector` | Collection-first: long mineral/life/power-up reach with a wide safety margin. | higher `mineralBase`/`powerUpBase`, longer `mineralSeekRange`/`powerUpSeekRange`/`lifeSeekRange`, wider `dangerMargin` |
| `evasive` | Survival above all: a wide threat bubble and room to retreat. | higher `survivalBase`/`survivalUrgencyPort`, wider `dangerMargin`/`threatRadius`, longer `reverseRetreatRange` |
| `glass-cannon` | All-out offence at point-blank range with thin defence. | higher `enemyBase`, much tighter `engagementRange`, lower `clearanceWeight`/`dangerMargin`/`survivalBase`, precise aim |
| `relentless-hunter` | The promo opener: hunts across the screen with a wide threat bubble and retreat room. | higher `enemyBase`/`enemySeekRange`, wider `dangerMargin`/`threatRadius`/`reverseRetreatRange`, longer reaction time |
| `barrage-dodger` | The promo crossfire: survival above all against an orbital threat bubble. | high `survivalUrgencyPort`, wide `dangerMargin`/`threatRadius`, long `hazardPredictionHorizon` |
| `cordon-breaker` | The promo cordon: kites the player-targeting duo at long standoff range. | high `survivalBase`, wide `reverseRetreatRange`/`dangerMargin`, patient engagement |
| `gauntlet-runner` | The promo finale: outlasts the every-showcase gauntlet between dense waves. | high `survivalBase`, wide `dangerMargin`, long `reverseRetreatRange` |

The four `promo-*`-facing presets (`relentless-hunter`, `barrage-dodger`,
`cordon-breaker`, `gauntlet-runner`) were calibrated with the authoritative
real-`PlayScene` check `src/scenes/PromoScenarioSurvival.integration.test.ts`
so every promo scenario sustains ≥45 s of bot-flown action before the run ends
(AH-0MVSDMDA1003ARV5, AH-0MW06XJKA009WX4B). The fast arena suite
`src/waves/promoScenario.survival.test.ts` is a bounded **smoke signal** only
(parity, measurement shape, determinism, tick budget) — it omits formation
descent, so it makes no ≥45 s claim.

The catalogue is pinned by `src/data/bot-tuning.test.ts` (preset lookup, sparse
authoring, deterministic coercion, slider bounds, distinctness from `Default`)
and `src/core/botTuningStore.test.ts` (every preset is served by
`getBotTuningConfig`); the same test cross-checks that every `preset` a
registered promo scenario names exists in the bundled state, so a typo in an
scenario entry fails the suite instead of producing a run with the wrong bot.

**Refresh workflow (dev server: Save to repo):** with `npm run dev` running,
tune in the gym and click **Save to repo**. The button PUTs the current store
state to the dev-only endpoint (`PUT /api/bot-tuning/src/data/bot-tuning.json`,
served by `vite/plugins/botTuningPlugin.ts`), which validates the blob against
the shared schema (`src/core/botTuningSchema.ts`) and atomically rewrites
`src/data/bot-tuning.json` in the committed format (pretty-printed JSON plus a
trailing newline). Review the diff and commit it with Git; the next build and
every fresh machine/browser fly the updated baseline. An invalid blob is
rejected with a `SaveResult` reason and the committed file stays byte-identical,
and the write path exists **only** on the dev server (a production/static build
has no endpoint and the button is disabled).

**Refresh workflow (no dev server: tune → Export → commit):** without a dev
server (e.g. a static preview), click **Export** (`bot-tuning.json`) and
overwrite `src/data/bot-tuning.json` with that exact file, then commit. Export
writes every configuration fully coerced, whereas the committed curated
presets are authored as sparse overrides (see above), so re-sparsify the
presets after an Export round-trip — the two files describe the same tuning
state either way. The GitHub
Pages alpha is cut from release tags, so a baseline committed to `dev` reaches
it at the next `dev` → `main` release.

Keep the file as the single source of the shipped
baseline — like the committed CSVs — so a stale committed baseline is the only
risk, mitigated by documenting this workflow here. Do **not** pin the file to
the built-in factory defaults in tests: the shipped baseline is expected to
carry the *tuned* values, and an equality assertion against
`defaultBotTuningValues()` would reject the very Export → commit refresh. The
end-to-end wiring is instead guarded by the discriminating tests named in
[docs/dev/gameplay-capture.md](dev/gameplay-capture.md#which-bot-values-ship-and-verifying-they-are-used).

The tuning surface is a curated subset of `COMPETENT_BOT_TUNABLES` /
`BOT_HUMAN_INPUT_TUNABLES`; `tuningFields.ts` reconstructs the nested
`commitment.*` and `world.*` overrides the brain expects. Tests live in
`src/ai/tuningFields.test.ts`, `src/core/botTuningStore.test.ts`,
`src/core/botTuningWriteBack.test.ts`, `vite/plugins/botTuningPlugin.test.ts`,
`src/utils/randomLevel.test.ts` and `src/scenes/gym/GymBotTuning.test.ts`
(the last covers the write-back affordance and the mineral/drop supply layer
end to end).

## References

- `src/ai/botSnapshot.ts` — the read-only snapshot contract.
- `src/ai/botDecision.ts` — the legacy pure decision (the adapter reference).
- `src/ai/botHumanLike.ts` — the human-cadence governor that consumes the
  steering intent.
- Epic: **Realistic demo/attract bot framework + playtester telemetry**
  (AH-0MUY089KR003F8S4).
