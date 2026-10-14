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

`buildBotWorld(snapshot, tunables?)` derives a `BotWorld` from a read-only
`BotSnapshot`. It partitions the live entities, computes proximity and
timed-wave pressure, and predicts incoming fire:

```ts
const world = buildBotWorld(snapshot);
world.liveEnemies;          // live non-asteroid enemies (+ boss)
world.liveAsteroids;        // live asteroids
world.hazards;              // every alive enemy/asteroid plus the live boss
world.incomingFire;         // predicted shots and their threat to the player
world.nearestEnemyDistance; // or Infinity
world.wavePressure;         // 0..1, 0 when no timed wave is running
```

`predictIncomingFire` classifies every in-flight enemy bullet and every enemy
inside a fire **tell** (whose shot does not exist yet, so it is estimated as a
straight line at `assumedBulletSpeed`). Each `IncomingFireThreat` carries the
predicted time-to-closest-approach, closest distance, whether it is closing
and whether it threatens. Because the player's own velocity is included in
the relative motion, prediction captures a dodge.

The world model is a **pure function** — no memory, no wall clock — so a
prediction is exactly reproducible and testable in isolation.

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
| minerals | `collect-mineral` | `collect` |
| power-ups | `collect-powerup` | `collect` |
| enemies | `engage-enemy` | `engage` |
| asteroids | `engage-asteroid` | `engage` |
| reposition | `reposition` | `reposition` |

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

### 9.2 Behaviours

- **`collect`** (mineral/power-up/secure-life): approach and scoop, braking
  via the forward model so the ship arrives rather than barrelling through,
  and using reverse retro-thrust only to correct an **imminent overshoot**
  (AH-0MV2WJSY70070HK2 · AC2).
  The `secure-life` goal restricts this behaviour to live Extra Life drops.
- **`engage`** (enemy/asteroid): line the target up inside `engagementRange`,
  then hold the **aim axis** and coast so the forward-firing weapon stays on
  target (aim/fire reasoning, AC3) instead of aiming only by accident of
  travel. A target whose velocity is exposed is **led** — the objective is the
  iterated intercept rather than the current position
  (AH-0MV1DUSM2005HL98 · AC2, [section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98)).
  Inside `reverseRetreatRange` it retreats under reverse thrust while
  keeping its nose on the target (kiting) **only when a genuine threat is
  present** — an incoming threatening shot or an imminent hazard collision —
  never merely because the target is close (AH-0MV2WJSY70070HK2 · AC3).
- **`evade`**: head away from the weighted centroid of the shots that
  threaten the ship (predictive path-around, AC2), not merely direction
  rejection.
- **`reposition`**: drift back toward the playfield centre when idle.

### 9.3 Survival is a hard constraint (AC4)

Every behaviour routes its intent through the pure `planSteering` helper,
which samples a **fan of bearings around the objective**, evaluates each one
for predicted clearance against walls, hazards and incoming fire, and picks
the safe bearing that best trades objective progress for clearance. When no
bearing is safe it takes the greatest-clearance bearing — the least-bad
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
`aimLeadEnabled`, `aimLeadAlignSeconds`, `aimLeadIterations` — live in the
same two sources ([section 9.8](#98-rotation-skills-ah-0mv1dusm2005hl98)).
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
| `competent/steering.ts` | Pure bearing fan, safety evaluation, forward model, intercept solve. |
| `competent/goals.ts` | The six registered goals and their utility bands. |
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

The relevant tunables are single-sourced in `COMPETENT_BOT_TUNABLES`
(`reverseBrakeEnabled`, `reverseImminentOvershootGap`, `reverseRetreatRange`)
and `BOT_HUMAN_INPUT_TUNABLES` (`reversePressMinMs`, `reversePressMaxMs`,
`reversePressGentleMinPct`, `reversePressGentleMaxPct`).  A deterministic
seeded run pins the regression: the restricted model cuts reverse presses over
an integration demo window from 38 to 9 (528 → 138 reverse ticks) versus the
pre-change baseline.

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
  would overshoot (braking the spin). The governor threads the ship's live
  `angularVelocity` and rotation config through `BotControlContext`, so no
  rotation constant is hard-coded in the bot layer. With `angularVelocity = 0`
  the predicted stop equals the current heading and the result is
  byte-for-byte the legacy release.
- **Lead prediction (AC2).** The `BotSnapshot` enemy seam carries optional
  `vx`/`vy` (sourced from entities that expose a physics body — `Asteroid`,
  `LaneTraffic` — and defaulting to zero for formation-positioned enemies).
  `enemyTargets` threads it into the `ContentTarget`, and `engage` solves the
  **iterated intercept** with the pure `interceptPoint` helper: the target
  advances over the estimated `aimLeadAlignSeconds` plus the projectile's
  time of flight (`assumedBulletSpeed`), refined for `aimLeadIterations`
  passes. A zero/absent velocity reduces exactly to the current position.
- **`skill` aim error (AC3).** A single normalised `skill` tunable in
  `BOT_HUMAN_INPUT_TUNABLES` (default **1.0**) perturbs the committed aim
  bearing by a seeded error whose bound is
  `maxAimErrorRad × (1 − skill)` (default **0.35 rad**). The draw lives in a
  dedicated governor RNG stream, so the press-length sequences are unchanged;
  `skill = 1` returns the decision untouched and consumes no draw. Only
  intents flagged as **aim** (`SteeredIntent.aim`, set by `engage` when it
  holds its weapon axis) are perturbed, so the survival/evade tier is never
  degraded.
- **Live tuning (AC4).** `skill`, `maxAimErrorRad`, `aimLeadAlignSeconds` and
  `aimLeadIterations` are sliders and `aimLeadEnabled` a toggle in
  `BOT_TUNING_NUMERIC_FIELDS` / `BOT_TUNING_TOGGLES`
  ([section 12](#12-tuning-the-bot-live-the-bot-tuning-gym)), applied live by
  `GymBotTuning` exactly like the existing knobs.
- **Validation (AC5).** `src/ai/botHumanLike.test.ts` covers the turn hold and
  the skill error, `src/ai/framework/competent/steering.test.ts` and
  `behaviours.test.ts` cover the intercept solve and the engage aim, and
  `src/ai/botRotationSkills.integration.test.ts` wires the shared
  competent brain + governor + shipped `AsteroidsModel` into a deterministic
  60 Hz run that tracks an off-axis moving enemy with a settled bearing error
  ≤ **0.05 rad**.

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

- `steering.test.ts` — safe/unsafe bearings, path-around, aim, forward model.
- `goals.test.ts` — utility bands and priority order.
- `behaviours.test.ts` — collect/engage/evade/reposition intents.
- `content.test.ts` — synthetic enemy/asteroid/drop content, the shipped
  registry completeness guard, and graceful unknown content (AC3/AC4).
- `competentBot.test.ts` — commitment/hysteresis and dispatch.
- `competentBot.integration.test.ts` — a deterministic seeded run, the
  hard-constraint dodge, and the priority-weighted A/B against the legacy
  ladder (AC6).

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
and every id in `POWER_UP_CATALOGUE` / `WEAPON_DROP_IDS` has an entry. A guard
test fails if a new game id is added without a profile.

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
  the utility bands, seek ranges, standoff/danger/wall margins, prediction
  horizons and speeds, steering weights, commitment hysteresis, the world
  model, the human-input reaction/press cadence, and the rotation-skill
  knobs `skill` / `maxAimErrorRad` / `aimLeadAlignSeconds` /
  `aimLeadIterations` (`aimLeadEnabled` toggle)
  (AH-0MV1DUSM2005HL98 · AC4). Moving a slider rebuilds the live brain and
  governor immediately. The `playerSpeed` / `frictionDeceleration` sliders
  are **overrides**: moving one away from its default makes it win over the
  live ship config; left at the default it is a fallback and the ship's live
  config wins (the same precedence the shipped demo resolves —
  [section 9.4](#94-single-sourced-tuning-ac5)).
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
  falls back to the built-in `Default`.
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
  designer's tuning.

The tuning surface is a curated subset of `COMPETENT_BOT_TUNABLES` /
`BOT_HUMAN_INPUT_TUNABLES`; `tuningFields.ts` reconstructs the nested
`commitment.*` and `world.*` overrides the brain expects. Tests live in
`src/ai/tuningFields.test.ts`, `src/core/botTuningStore.test.ts`,
`src/utils/randomLevel.test.ts` and `src/scenes/gym/GymBotTuning.test.ts`
(the latter covers the mineral/drop supply layer end to end).

## References

- `src/ai/botSnapshot.ts` — the read-only snapshot contract.
- `src/ai/botDecision.ts` — the legacy pure decision (the adapter reference).
- `src/ai/botHumanLike.ts` — the human-cadence governor that consumes the
  steering intent.
- Epic: **Realistic demo/attract bot framework + playtester telemetry**
  (AH-0MUY089KR003F8S4).
