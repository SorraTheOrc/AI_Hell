# Bot Framework

The attract/demo bot is built on a small, testable framework rather than a
per-frame priority ladder. This document is the overview of that framework
and the guide to extending it with goals and behaviours.

> **Status:** framework core (AH-0MUY08WKB002N1N6). The concrete competent
> goal/behaviour content is added by its child work item
> (AH-0MUY08WX3000ZEVO); until then the framework falls back to the legacy
> survival heuristic (see [Legacy adapter](#legacy-adapter)).

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
survival) is the next epic child.

## 9. Testing

The framework's unit tests live beside it:

- `worldModel.test.ts` — prediction in isolation, including a player dodge.
- `registry.test.ts` — registration, lookup, duplicate protection, order.
- `commitment.test.ts` — the three release rules and deterministic replay.
- `botBrain.test.ts` — selection, dispatch, fallback, world integration and
  deterministic replay of a decision sequence.
- `legacyPolicy.test.ts` — parity with the original pure decision.

`botFrameworkDocs.test.ts` guards the presence of this document and its key
sections.

## References

- `src/ai/botSnapshot.ts` — the read-only snapshot contract.
- `src/ai/botDecision.ts` — the legacy pure decision (the adapter reference).
- `src/ai/botHumanLike.ts` — the human-cadence governor that consumes the
  steering intent.
- Epic: **Realistic demo/attract bot framework + playtester telemetry**
  (AH-0MUY089KR003F8S4).
