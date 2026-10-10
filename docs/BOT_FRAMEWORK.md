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
  and using reverse retro-thrust when forward thrust would overshoot (AC1).
  The `secure-life` goal restricts this behaviour to live Extra Life drops.
- **`engage`** (enemy/asteroid): line the target up inside `engagementRange`,
  then hold the **aim axis** and coast so the forward-firing weapon stays on
  target (aim/fire reasoning, AC3) instead of aiming only by accident of
  travel. Inside `reverseRetreatRange` it retreats under reverse thrust while
  keeping its nose on the target (kiting).
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
safety margins, steering-fan/scoring weights, playfield size and the
commitment/world-model overrides. The human-like input cadence itself is the
governor's `reactionTimeMs` ([section 5](#5-brain--policy)); the competent
tunables set a compatible `minCommitSeconds` so a goal cannot be re-picked
faster than a human can change input. Reverse-thrust gating and timing live in
the same two sources — see [section 9.7](#97-reverse-thrust-ah-0mv1j0ohp0072xa5).

### 9.5 Module layout

| Module | Responsibility |
|---|---|
| `competent/tunables.ts` | Single source of tuning + `resolveCompetentTunables`. |
| `competent/steering.ts` | Pure bearing fan, safety evaluation, forward model. |
| `competent/goals.ts` | The six registered goals and their utility bands. |
| `competent/behaviours.ts` | collect / engage / evade / reposition. |
| `competent/index.ts` | `createCompetentBotBrain()` factory. |

### 9.6 Wiring

`PlayScene`'s demo bot feeds `this.botBrain.decide(buildBotSnapshot(this),
dt)` into the human-like governor (instead of the legacy `decideBotIntent`),
and resets the brain on run (re)start. The competent brain keeps the legacy
adapter as its default fallback, so the demo still behaves sensibly if a
behaviour declines.

### 9.7 Reverse thrust (AH-0MV1J0OHP0072XA5)

The demo bot treats forward and reverse as a **first-class thrust direction**
rather than only ever thrusting forward (AC1–AC5):

- **Brake assist (AC1).** While closing on a collection target or combat
target and continuing to thrust would overshoot it (the forward model's
`mayThrust` is `false`), the `collect`/`engage` behaviours request reverse
instead of only coasting on friction; `mayReverse` exposes the predicate and
never fires when the ship is stopped or reverse braking is disabled. Reverse
braking never increases overshoot versus the friction-only model.
- **Heading-aware thrust (AC2).** When the committed travel bearing is behind
the nose by more than `reverseHeadingThresholdRad`, the human-like governor
latches **reverse mode** (with a `reverseHeadingHysteresisRad` dead-band) and
the actuator turns the nose opposite the bearing and reverses toward it
instead of spinning 180°. The hysteresis keeps the choice stable across
ticks.
- **Aim-preserving retreat / kiting (AC3).** Inside `reverseRetreatRange` of
an engaged target the `engage` behaviour holds reverse, keeping its nose on
the aim axis, so it backs away without the previous turn-away.
- **Config-respecting enable flag (AC4).** `Player.isReverseEnabled()`
is carried through `buildBotSnapshot()` → `BotSnapshot.reverseEnabled` →
`BotWorld.reverseEnabled` and into the governor's `BotControlContext`. Every
reverse intent is gated on it (intent **and** flag, defence in depth), so a
player who switched the retro-thruster off sees `reverse: false` on every
bot input and today's behaviour unchanged.
- **Human-like reverse cadence (AC5).** The governor holds each reverse press
for a duration drawn from `[reversePressMinMs, reversePressMaxMs]` (reduced
by a per-press gentle factor), using separate seeded RNG streams so the
forward press sequence is unchanged. The bot never toggles reverse every
frame.

The relevant tunables are single-sourced in `COMPETENT_BOT_TUNABLES`
(`reverseBrakeEnabled`, `reverseHeadingThresholdRad`,
`reverseHeadingHysteresisRad`, `reverseRetreatRange`) and
`BOT_HUMAN_INPUT_TUNABLES` (`reversePressMinMs`, `reversePressMaxMs`,
`reversePressGentleMinPct`, `reversePressGentleMaxPct`,
`reverseHeadingThresholdRad`, `reverseHeadingHysteresisRad`).

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

## References

- `src/ai/botSnapshot.ts` — the read-only snapshot contract.
- `src/ai/botDecision.ts` — the legacy pure decision (the adapter reference).
- `src/ai/botHumanLike.ts` — the human-cadence governor that consumes the
  steering intent.
- Epic: **Realistic demo/attract bot framework + playtester telemetry**
  (AH-0MUY089KR003F8S4).
