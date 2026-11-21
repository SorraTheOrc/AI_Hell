/**
 * Late-game-load-shaped determinism vehicle for the demo bot's steering
 * (AH-0MWGUMSIT0033I3Z, child of AH-0MW2DC28M00161W6).
 *
 * The demo-bot steering optimisation (`evaluateDirection` + the hazard-velocity
 * tracker) may only change how the steering *costs*, never what the bot
 * *decides*. The existing byte-identical determinism tests
 * (`src/ai/eval/arena.test.ts`, `src/ai/botSteering.integration.test.ts`)
 * validate the mechanism on small worlds; this suite pins the same property
 * **at late-game scale**, because a caching/derived-data rewrite is exactly
 * where a divergence would surface only under hundreds of live hazards and
 * live enemy fire.
 *
 * ## What it does
 *
 * It builds a seeded **late-game load** — several hundred hazards, dozens of
 * in-flight enemy shots, minerals and drops — evolves it deterministically
 * from the same RNG stream, and drives the real competent bot closed-loop for
 * a fixed tick sequence. The full trace (per-tick steering intents, the
 * governor's committed inputs and the ship's positions/facing) is serialised
 * and the whole run is repeated from an identical seed and `dt` sequence. The
 * two traces must be **byte-identical**.
 *
 * The load is generated from the run seed alone (no wall clock, no
 * `Math.random`), so the comparison is exact and the suite is fast: it never
 * boots Phaser.
 *
 * ## Cost and timeout budget
 *
 * The loop is deliberately heavy — 240 decisions over 320 live hazards, and
 * the suite's evidence comes from three independent runs — so the runs are
 * measured once in a `beforeAll` with a generous wall-clock budget instead of
 * the 5 s Vitest default. The budget covers a busy shared host, not a hang:
 * the loop length is fixed by `TICKS`, so the work itself is bounded
 * (AH-0MWP7R2C9004XE9H).
 *
 * ## Why the load shape matters
 *
 * The pre-optimisation `evaluateDirection` rescans every hazard once per fan
 * bearing (17× per decision). A derived-data cache that is subtly wrong (an
 * off-by-one in the wrapped delta, a stale velocity estimate, a missed
 * predictive exemption) would still look correct on a handful of hazards but
 * diverge under this load — which is precisely the regression this vehicle
 * exists to catch on the pre-change tree and every tree that follows.
 *
 * @module src/ai/botSteeringLateGameDeterminism.test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BotInputGovernor } from './botHumanLike';
import type { BotBullet, BotEnemy, BotSnapshot } from './botSnapshot';
import { createCompetentBotBrain } from './framework/competent';
import { createSeededRng } from '../core/rng';
import { AsteroidsModel } from '../utils/movementModel';
import type { AsteroidsInput } from '../utils/movementModel';

const DT = 1 / 60;
const WIDTH = 960;
const HEIGHT = 540;

/** Late-game scale, from the recorded PlayScene level-10 demo run. */
const HAZARD_COUNT = 320;
const INITIAL_SHOTS = 40;
const LIVE_SHOT_CAP = 60;
const MINERAL_COUNT = 10;
const DROP_COUNT = 2;

/** How many decision ticks the closed-loop run simulates (4 s at 60 Hz). */
const TICKS = 240;

/** The shipped asteroid ship physics (`src/core/configDefaults.ts`). */
const SHIP_CONFIG = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
  rotationSpeed: 3,
  rotationAcceleration: 12,
  rotationDeceleration: 60,
} as unknown as Parameters<AsteroidsModel['tick']>[5];

const model = new AsteroidsModel();

/** The run seed the two comparison runs share. */
const SAME_SEED = 0x5eed_1a7e;
/** A deliberately different seed, to prove the trace is seed-sensitive. */
const OTHER_SEED = 0x5eed_1a7f;

/** Ship kinematic state threaded through the closed loop. */
interface ShipState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  angularVelocity: number;
}

/** A live hazard with the velocity the steering fan's prediction consumes. */
interface LiveHazard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  archetype: string;
}

/** A live in-flight shot. */
interface LiveShot {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** One decision tick's recorded outcome. */
interface TraceTick {
  /** The pure bot intent (the steering decision under test). */
  intent: {
    dirX: number;
    dirY: number;
    thrust: boolean;
    longTravel: boolean;
    reverse: boolean;
    aim: boolean;
  };
  /** The governor's committed input handed to the physics model. */
  committed: {
    forward: boolean;
    turnLeft: boolean;
    turnRight: boolean;
    reverse: boolean;
  };
  /** The ship state the decision produced. */
  ship: ShipState;
}

/** The complete run trace the determinism assertion compares. */
interface RunTrace {
  ticks: TraceTick[];
  final: ShipState;
}

/** Wraps a coordinate into `[0, size)` (the arena is a four-edge torus). */
function wrap(value: number, size: number): number {
  const mod = value % size;
  return mod < 0 ? mod + size : mod;
}

/**
 * Builds the seeded late-game load: hundreds of drifting hazards, an initial
 * salvo of in-flight shots, minerals and drops. Every value is drawn from
 * `rng`, so the same seed always builds the same world.
 */
function buildLoad(seed: number): {
  hazards: LiveHazard[];
  shots: LiveShot[];
  minerals: { x: number; y: number; vx: number; vy: number }[];
  drops: { x: number; y: number; type: string }[];
  rng: () => number;
} {
  const rng = createSeededRng(seed);
  const hazards: LiveHazard[] = [];
  const archetypes = ['scout', 'diver', 'tank', 'phaser', 'asteroid'];
  for (let i = 0; i < HAZARD_COUNT; i += 1) {
    // A spread of speeds: most hazards drift slowly, a minority close fast —
    // the mix the prediction fan actually distinguishes.
    const speed = rng() < 0.25 ? 40 + rng() * 160 : 5 + rng() * 40;
    const heading = rng() * Math.PI * 2;
    hazards.push({
      x: rng() * WIDTH,
      y: rng() * HEIGHT,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      archetype: archetypes[Math.floor(rng() * archetypes.length)],
    });
  }
  const shots: LiveShot[] = [];
  for (let i = 0; i < INITIAL_SHOTS; i += 1) {
    const heading = rng() * Math.PI * 2;
    const speed = 120 + rng() * 180;
    shots.push({
      x: rng() * WIDTH,
      y: rng() * HEIGHT,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
    });
  }
  const minerals = Array.from({ length: MINERAL_COUNT }, () => ({
    x: rng() * WIDTH,
    y: rng() * HEIGHT,
    vx: (rng() - 0.5) * 8,
    vy: (rng() - 0.5) * 8,
  }));
  const drops = Array.from({ length: DROP_COUNT }, () => ({
    x: rng() * WIDTH,
    y: rng() * HEIGHT,
    type: 'spread',
  }));
  return { hazards, shots, minerals, drops, rng };
}

/**
 * Builds the read-only snapshot the bot decides from for the current world
 * state. Hand-built (no Phaser): the decision layer is a pure function of the
 * snapshot, so an exact trace is reproducible.
 */
function snapshotOf(
  seed: number,
  ship: ShipState,
  load: ReturnType<typeof buildLoad>,
): BotSnapshot {
  const enemies: BotEnemy[] = load.hazards.map((hazard, index) => ({
    id: index,
    x: hazard.x,
    y: hazard.y,
    alive: true,
    archetype: hazard.archetype,
    vx: hazard.vx,
    vy: hazard.vy,
  }));
  const enemyBullets: BotBullet[] = load.shots.map((shot) => ({
    x: shot.x,
    y: shot.y,
    vx: shot.vx,
    vy: shot.vy,
  }));
  return {
    player: { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy },
    enemies,
    enemyBullets,
    playerBullets: [],
    drops: load.drops.map((drop) => ({ x: drop.x, y: drop.y, type: drop.type })),
    minerals: load.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: 'mineral',
    })),
    boss: null,
    aliveCount: enemies.length,
    wave: null,
    runSeed: seed,
    lives: 3,
    livesCap: 5,
    reverseEnabled: true,
  };
}

/**
 * Advances the world one tick from its own seeded RNG: hazards and minerals
 * drift and wrap, shots fly (wrapping, so live fire never empties) and a
 * seeded minority of hazards fire a new in-flight shot at the ship while the
 * live-shot cap allows.
 */
function advanceWorld(
  load: ReturnType<typeof buildLoad>,
  ship: ShipState,
): void {
  for (const hazard of load.hazards) {
    hazard.x = wrap(hazard.x + hazard.vx * DT, WIDTH);
    hazard.y = wrap(hazard.y + hazard.vy * DT, HEIGHT);
  }
  for (const mineral of load.minerals) {
    mineral.x = wrap(mineral.x + mineral.vx * DT, WIDTH);
    mineral.y = wrap(mineral.y + mineral.vy * DT, HEIGHT);
  }
  for (const shot of load.shots) {
    shot.x = wrap(shot.x + shot.vx * DT, WIDTH);
    shot.y = wrap(shot.y + shot.vy * DT, HEIGHT);
  }
  // Fresh late-game fire: a hazard fires at the ship when the RNG says so and
  // the live-shot cap has room.
  if (load.shots.length < LIVE_SHOT_CAP && load.rng() < 0.35) {
    const shooter = load.hazards[Math.floor(load.rng() * load.hazards.length)];
    const dx = wrap(ship.x - shooter.x, WIDTH);
    const dy = wrap(ship.y - shooter.y, HEIGHT);
    const length = Math.hypot(dx, dy) || 1;
    const speed = 160;
    load.shots.push({
      x: shooter.x,
      y: shooter.y,
      vx: (dx / length) * speed,
      vy: (dy / length) * speed,
    });
  }
}

/**
 * Runs the competent bot closed-loop under the seeded late-game load for
 * {@link TICKS} decisions and returns the complete trace.
 *
 * A fresh brain and governor are constructed per run, so no state can leak
 * between the two comparison runs.
 */
function runLateGame(seed: number): RunTrace {
  const brain = createCompetentBotBrain();
  brain.reset();
  const governor = new BotInputGovernor();
  governor.seed(seed);
  const load = buildLoad(seed);
  let ship: ShipState = {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    vx: 0,
    vy: 0,
    facing: 0,
    angularVelocity: 0,
  };
  const ticks: TraceTick[] = [];

  for (let i = 0; i < TICKS; i += 1) {
    const intent = brain.decide(snapshotOf(seed, ship, load), DT);
    const committed = governor.update(intent, DT, {
      scheme: 'asteroids',
      facing: ship.facing,
      reverseEnabled: true,
    }) as AsteroidsInput;
    ship = model.tick(
      ship,
      committed,
      DT,
      WIDTH,
      HEIGHT,
      SHIP_CONFIG,
    ) as ShipState;
    ticks.push({
      intent: {
        dirX: intent.dirX,
        dirY: intent.dirY,
        thrust: intent.thrust === true,
        longTravel: intent.longTravel === true,
        reverse: intent.reverse === true,
        aim: intent.aim === true,
      },
      committed: {
        forward: committed.forward === true,
        turnLeft: committed.turnLeft === true,
        turnRight: committed.turnRight === true,
        reverse: committed.reverse === true,
      },
      ship: { ...ship },
    });
    advanceWorld(load, ship);
  }

  return { ticks, final: ship };
}

/**
 * Wall-clock budget for the shared late-game runs.
 *
 * One run is 240 closed-loop decisions over 320 live hazards through the
 * 17-bearing steering fan; the suite evaluates three of them. On an idle host
 * that is a couple of seconds, but the shared build hosts run several suites
 * in parallel and the wall clock moves with host load, so the budget is
 * deliberately generous — it covers a busy shared host, not a hang (the loop
 * length is fixed by {@link TICKS}, so the work is bounded). AH-0MWP7R2C9004XE9H.
 */
const LATE_GAME_RUN_TIMEOUT_MS = 120_000;

/**
 * The shared traces, measured once for the whole suite: each run is a
 * deterministic headless simulation, so measuring once keeps the suite fast
 * while every assertion reads the same evidence — the pattern
 * `src/waves/promoScenario.survival.test.ts` uses for its measured catalogue.
 *
 * `first` and `second` are two **independent** runs of the same seed: the
 * determinism assertion compares them, so they must never be collapsed into a
 * single run.
 */
let first: RunTrace;
let second: RunTrace;
let other: RunTrace;

beforeAll(() => {
  first = runLateGame(SAME_SEED);
  second = runLateGame(SAME_SEED);
  other = runLateGame(OTHER_SEED);
}, LATE_GAME_RUN_TIMEOUT_MS);

describe('late-game-load demo-bot steering determinism (AH-0MWGUMSIT0033I3Z)', () => {
  it('runs at genuinely late-game scale (hundreds of hazards, dozens of live shots)', () => {
    // Guards the vehicle itself: if the generated load ever stopped being
    // late-game shaped, this determinism suite would silently stop testing the
    // near-overload regime the optimisation targets.
    const load = buildLoad(SAME_SEED);
    expect(load.hazards.length).toBeGreaterThanOrEqual(300);
    expect(load.shots.length).toBeGreaterThanOrEqual(30);
    expect(load.hazards.some((hazard) => hazard.vx !== 0 || hazard.vy !== 0)).toBe(
      true,
    );
  });

  it('produces a byte-identical trace for two identical seeded late-game runs', () => {
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('is seed-sensitive, so a green determinism run is not vacuous', () => {
    // A trace identical across *different* seeds would mean the load or the
    // decisions never actually varied, so the determinism assertion above
    // would prove nothing. The traces must differ.
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it('exercises the steering fan (the ship actually flies)', () => {
    // Confirms the loop reaches decisions that move the ship, so the fan (the
    // hot function this vehicle protects) is genuinely exercised rather than
    // short-circuited by an idle state.
    expect(first.ticks.length).toBe(TICKS);
    const moved = first.ticks.some(
      (tick) =>
        tick.ship.x !== WIDTH / 2 || tick.ship.y !== HEIGHT / 2,
    );
    expect(moved).toBe(true);
    const forwardTicks = first.ticks.filter((tick) => tick.committed.forward).length;
    expect(forwardTicks).toBeGreaterThan(0);
  });
});
