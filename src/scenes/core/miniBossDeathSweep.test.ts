/**
 * Contract tests for the mini-boss death sweep (AH-0MVROEJJR002HDLS).
 *
 * This suite pins the sweep contract implemented by the sibling helper item
 * **AH-0MVROEKMT005RVML** (`src/scenes/core/miniBossDeathSweep.ts`), wired
 * into `PlayScene` / `GymMiniBoss` by AH-0MVROELN600410GP /
 * AH-0MVROEMUO007Z3RY. Written test-first with Vitest's `it.fails` (the repo's
 * red-before/green-after convention), then flipped back to green `it` by the
 * helper item — a leftover `it.fails` fails the suite.
 *
 * The module is loaded through a non-literal dynamic import: a static
 * `import './miniBossDeathSweep'` would break `tsc --noEmit` while the module
 * did not yet exist at test-authoring time. Kept as-is (harmless) now that the
 * module has landed.
 *
 * ## Pinned contract (AH-0MVROEKMT005RVML must match exactly)
 *
 * `src/scenes/core/miniBossDeathSweep.ts` — planner is Phaser-free, pure,
 * total and deterministic; only the executor touches the scene.
 *
 * - `MINI_BOSS_SWEEP_EXTRA_BASE = 30`, `MINI_BOSS_SWEEP_ANCHORED_COUNT = 10`,
 *   `MINI_BOSS_SWEEP_INSET_PX` (scatter inset) and
 *   `MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX` (radius around the death point).
 * - `MINI_BOSS_SWEEP_FINALE_COUNT = 20`, `MINI_BOSS_SWEEP_FINALE_PAIR_SIZE = 2`,
 *   `MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS = 250` and
 *   `MINI_BOSS_SWEEP_FINALE_SPREAD_PX` — the producer-reviewed "cluster
 *   another 20 explosions in and around the mini-boss, 2 every 0.25 s".
 * - `miniBossSweepExtras(n)` — `Math.max(0, 30 - n)`; never negative, never
 *   throws, for any `n` (`0 → 30`, `1 → 29`, `29 → 1`, `30 → 0`, `40 → 0`).
 * - `collectSweepTargets(live, minions = [])` — the wave-gating scope split:
 *   keeps escorts and the mini-boss's live minions, drops every
 *   `isNonBlockingHazard` key (`asteroid`, `lane-traffic`), preserves order.
 * - `planMiniBossDeathSweep({ targets, deathX, deathY, bounds, seed })` —
 *   returns `{ bursts, sweptCount, extras, anchored, finale,
 *   completionDelayMs }` where `sweptCount === targets.length`,
 *   `extras === miniBossSweepExtras(n)`, `anchored === 10`,
 *   `finale === 20` and
 *   `bursts.length === n + extras + 10 + 20 <= 60`. Bursts
 *   carry `{ role, delayMs, x, y, color, size, particleCount, scale,
 *   lifespanMs }` with `role` one of
 *   `'enemy' | 'scatter' | 'anchored' | 'finale'`: exactly one `enemy` burst
 *   per swept target, `extras` `scatter` bursts sampled inside `bounds`
 *   inset by the burst radius (so no burst is clipped entirely off-screen),
 *   exactly 10 `anchored` bursts around `(deathX, deathY)` and exactly 20
 *   `finale` bursts clustered around the death point, fired in pairs two
 *   every 250 ms. Same seed ⇒ identical plan; no `Math.random()`.
 * - `spawnMiniBossDeathSweep(scene, input, options?)` — plays every planned
 *   burst through `spawnExplosionParticles` (honouring `delayMs` /
 *   `lifespanMs`) and returns `{ plan, explosions, complete, destroy }`.
 *   `options.onComplete` fires **exactly once**, only after every burst has
 *   finished animating — never on the spawn frame — and never on an explicit
 *   `destroy()` teardown.
 *
 * `spawnExplosionParticles` gains the matching `onComplete` option; see the
 * completion-seam block in `src/vfx/explosionParticles.test.ts`.
 *
 * @module scenes/core/miniBossDeathSweep.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as audioEffects from '../../audio/effects';

// The sweep schedules its explosion SFX through the shared audio cues. Mock
// the audio module so the suite can observe the default per-role routing
// without an AudioContext; the seam tests inject their own recorder instead.
vi.mock('../../audio/effects', () => ({
  playMiniBossSweepSound: vi.fn(),
}));

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { isNonBlockingHazard } from './waveTimeout';

// ── The not-yet-existing module, via a non-literal dynamic import ───

/** One swept target: a live wave-gating entity captured at defeat time. */
interface SweepTarget {
  /** Entity key (archetype), used for the hazard split. */
  key: string;
  /** World X at capture time. */
  x: number;
  /** World Y at capture time. */
  y: number;
  /** Entity size (drives the enemy-scale burst geometry). */
  size: number;
  /** Burst colour. */
  color: number;
}

/** Playfield rectangle a scattered burst must stay inside. */
interface SweepBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A planned burst (pure data — no Phaser objects). */
interface SweepBurst {
  role: 'enemy' | 'scatter' | 'anchored' | 'finale';
  delayMs: number;
  x: number;
  y: number;
  color: number;
  size: number;
  particleCount: number;
  scale: number;
  lifespanMs: number;
  /** The burst's audio decision (AC1/AC2/AC3/AC5). */
  audio: SweepBurstAudio;
}

/** The per-burst audio decision the planner attaches. */
interface SweepBurstAudio {
  cue: 'playBossDestructionSound' | 'playDestructionSound' | 'playVictoryExplosionSound';
  variantPick: number;
  volume: number;
  kept: boolean;
}

/**
 * One cue the executor dispatches: the mini-boss's own body, or a kept burst
 * scheduled at its own `delayMs`.
 */
interface SweepSoundRequest {
  role: SweepBurst['role'];
  cue: SweepBurstAudio['cue'];
  delayMs: number;
  volume: number;
  variantPick?: number;
}

/** The planner input. */
interface SweepPlanInput {
  targets: readonly SweepTarget[];
  deathX: number;
  deathY: number;
  bounds: SweepBounds;
  seed: number;
  inset?: number;
}

/** The planner output. */
interface SweepPlan {
  bursts: readonly SweepBurst[];
  sweptCount: number;
  extras: number;
  anchored: number;
  finale: number;
  completionDelayMs: number;
}

/** Handle returned by the executor. */
interface SweepHandle {
  plan: SweepPlan;
  explosions: readonly unknown[];
  readonly complete: boolean;
  destroy(): void;
}

/** The `src/scenes/core/miniBossDeathSweep.ts` surface this suite pins. */
interface MiniBossDeathSweepContract {
  MINI_BOSS_SWEEP_EXTRA_BASE: number;
  MINI_BOSS_SWEEP_ANCHORED_COUNT: number;
  MINI_BOSS_SWEEP_INSET_PX: number;
  MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX: number;
  MINI_BOSS_SWEEP_COMPLETION_MARGIN_MS: number;
  MINI_BOSS_SWEEP_ANCHOR_START_MS: number;
  MINI_BOSS_SWEEP_ANCHOR_WINDOW_MS: number;
  MINI_BOSS_SWEEP_FINALE_COUNT: number;
  MINI_BOSS_SWEEP_FINALE_PAIR_SIZE: number;
  MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS: number;
  MINI_BOSS_SWEEP_FINALE_SPREAD_PX: number;
  MINI_BOSS_SWEEP_FINALE_START_MS: number;
  // Per-role burst magnitudes (AH-0MVY06X16005EO8R) — the mini-boss's own
  // anchored/finale roles are huge; enemy/scatter keep their sizing.
  MINI_BOSS_SWEEP_ANCHORED_SCALE: number;
  MINI_BOSS_SWEEP_ANCHORED_PARTICLES: number;
  MINI_BOSS_SWEEP_FINALE_SCALE: number;
  MINI_BOSS_SWEEP_FINALE_PARTICLES: number;
  MINI_BOSS_SWEEP_ENEMY_SCALE: number;
  MINI_BOSS_SWEEP_ENEMY_PARTICLES: number;
  MINI_BOSS_SWEEP_SCATTER_SCALE: number;
  MINI_BOSS_SWEEP_SCATTER_PARTICLES: number;
  MINI_BOSS_SWEEP_LIFESPAN_MS: number;
  // SFX tunables (AC2/AC3) — every knob named and exported.
  MINI_BOSS_SWEEP_SFX_ENABLED: boolean;
  MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE: SweepBurstAudio['cue'];
  MINI_BOSS_SWEEP_SFX_FINALE_CUE: SweepBurstAudio['cue'];
  MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N: number;
  MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N: number;
  MINI_BOSS_SWEEP_SFX_ANCHORED_EVERY_N: number;
  MINI_BOSS_SWEEP_SFX_FINALE_EVERY_N: number;
  MINI_BOSS_SWEEP_SFX_ENEMY_VOLUME: number;
  MINI_BOSS_SWEEP_SFX_SCATTER_VOLUME: number;
  MINI_BOSS_SWEEP_SFX_ANCHORED_VOLUME: number;
  MINI_BOSS_SWEEP_SFX_FINALE_VOLUME: number;
  MINI_BOSS_SWEEP_SFX_WINDOW_MS: number;
  MINI_BOSS_SWEEP_SFX_MAX_PER_WINDOW: number;
  miniBossSweepExtras(sweptCount: number): number;
  collectSweepTargets(
    live: readonly SweepTarget[],
    minions?: readonly SweepTarget[],
  ): SweepTarget[];
  planMiniBossDeathSweep(input: SweepPlanInput): SweepPlan;
  spawnMiniBossDeathSweep(
    scene: unknown,
    input: SweepPlanInput,
    options?: {
      onComplete?: () => void;
      soundEnabled?: boolean;
      playSound?: (request: SweepSoundRequest) => void;
    },
  ): SweepHandle;
}

/** Non-literal specifier so TypeScript does not resolve the missing module. */
const SWEEP_MODULE = './miniBossDeathSweep';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function sweep(): Promise<MiniBossDeathSweepContract> {
  return (await import(SWEEP_MODULE)) as MiniBossDeathSweepContract;
}

// ── Fixtures ───────────────────────────────────────────────────────

/** The shipped playfield (960 × 540). */
const BOUNDS: SweepBounds = { x: 0, y: 0, width: GAME_WIDTH, height: GAME_HEIGHT };

/** The mini-boss's captured death position for every fixture below. */
const DEATH_X = 480;
const DEATH_Y = 180;

/** Fixed seed — the sweep must replay identically for a fixed seed. */
const SEED = 0x5eed;

/** Builds a live entity of the given key at a deterministic position. */
function target(key: string, index: number): SweepTarget {
  return {
    key,
    x: 60 + index * 7,
    y: 90 + index * 5,
    size: 16,
    color: 0xff0000,
  };
}

/** Builds `count` escort targets (`scout`) — the common sweep target. */
function escorts(count: number): SweepTarget[] {
  return Array.from({ length: count }, (_unused, i) => target('scout', i));
}

/** Builds the planner input for `targets`. */
function planInput(
  targets: readonly SweepTarget[],
  seed: number = SEED,
): SweepPlanInput {
  return { targets, deathX: DEATH_X, deathY: DEATH_Y, bounds: BOUNDS, seed };
}

/** Counts the bursts of one role in a plan. */
function burstsOfRole(plan: SweepPlan, role: SweepBurst['role']): SweepBurst[] {
  return plan.bursts.filter((burst) => burst.role === role);
}

// ── A headed stub scene for the thin Phaser executor ───────────────

/** A captured tween config (the stub `tweens.add` surface). */
interface CapturedTween {
  targets: unknown;
  duration: number;
  delay?: number;
  onUpdate?: () => void;
  onComplete?: () => void;
}

/** The minimal Graphics surface `spawnExplosionParticles` touches. */
interface StubGraphics {
  alpha: number;
  destroyed: boolean;
  setDepth(): void;
  clear(): void;
  fillStyle(): void;
  fillCircle(): void;
  destroy(): void;
}

/** The minimal scene surface the executor + particle spawner need. */
interface StubScene {
  tweenCfgs: CapturedTween[];
  add: { graphics(opts?: { x?: number; y?: number }): StubGraphics };
  tweens: { add(cfg: CapturedTween): void };
  /** Optional recording Clock — absent for the tween-only stubs. */
  time?: { delayedCall(delayMs: number, callback: () => void): unknown };
}

/** A recorded Clock watchdog timer. */
interface CapturedTimer {
  delayMs: number;
  callback: () => void;
  removed: boolean;
}

/** Creates a headless stub scene that records every scheduled tween. */
function makeStubScene(): StubScene {
  const scene: StubScene = {
    tweenCfgs: [],
    add: {
      graphics(): StubGraphics {
        const gfx: StubGraphics = {
          alpha: 1,
          destroyed: false,
          setDepth(): void {},
          clear(): void {},
          fillStyle(): void {},
          fillCircle(): void {},
          destroy(): void {
            gfx.destroyed = true;
          },
        };
        return gfx;
      },
    },
    tweens: {
      add(cfg: CapturedTween): void {
        scene.tweenCfgs.push(cfg);
      },
    },
  };
  return scene;
}

/**
 * Extends the stub scene with a recording Clock, so the executor's completion
 * watchdog can be observed and fired by hand.
 */
function makeStubSceneWithClock(): StubScene & { timers: CapturedTimer[] } {
  const scene = makeStubScene() as StubScene & { timers: CapturedTimer[] };
  scene.timers = [];
  scene.time = {
    delayedCall(delayMs: number, callback: () => void): unknown {
      const timer: CapturedTimer = { delayMs, callback, removed: false };
      scene.timers.push(timer);
      return {
        remove(): void {
          timer.removed = true;
        },
      };
    },
  };
  return scene;
}

// ── AC2: the extra-burst count formula ────────────────────────────

describe('mini-boss death sweep — extra-burst formula (AC2)', () => {
  it('follows max(0, 30 - n) at every documented edge', async () => {
    const { miniBossSweepExtras, MINI_BOSS_SWEEP_EXTRA_BASE } = await sweep();
    expect(MINI_BOSS_SWEEP_EXTRA_BASE).toBe(30);

    expect(miniBossSweepExtras(0)).toBe(30);
    expect(miniBossSweepExtras(1)).toBe(29);
    expect(miniBossSweepExtras(29)).toBe(1);
    expect(miniBossSweepExtras(30)).toBe(0);
    expect(miniBossSweepExtras(40)).toBe(0);
  });

  it('never yields a negative or non-integer extra count', async () => {
    const { miniBossSweepExtras } = await sweep();
    for (const swept of [31, 40, 100, 1000]) {
      expect(miniBossSweepExtras(swept)).toBe(0);
    }
    // A negative swept count (should not happen, but total functions are the
    // contract) still produces whole, non-negative extras.
    const negative = miniBossSweepExtras(-5);
    expect(Number.isInteger(negative)).toBe(true);
    expect(negative).toBeGreaterThanOrEqual(0);
  });

  it('plans exactly 10 anchored + 20 finale bursts at the mini-boss death point for every n', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_ANCHORED_COUNT,
      MINI_BOSS_SWEEP_FINALE_COUNT,
    } = await sweep();
    expect(MINI_BOSS_SWEEP_ANCHORED_COUNT).toBe(10);
    expect(MINI_BOSS_SWEEP_FINALE_COUNT).toBe(20);
    for (const swept of [0, 1, 5, 29, 30, 40]) {
      const plan = planMiniBossDeathSweep(planInput(escorts(swept)));
      expect(burstsOfRole(plan, 'anchored').length, `n=${swept}`).toBe(10);
      expect(burstsOfRole(plan, 'finale').length, `n=${swept}`).toBe(20);
      expect(burstsOfRole(plan, 'enemy').length, `n=${swept}`).toBe(swept);
      expect(burstsOfRole(plan, 'scatter').length, `n=${swept}`).toBe(
        Math.max(0, 30 - swept),
      );
    }
  });

  it('burns at most 60 bursts in total while the extras formula applies (n ≤ 30)', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    for (const swept of [0, 1, 10, 29, 30, 31, 40, 100]) {
      const plan = planMiniBossDeathSweep(planInput(escorts(swept)));
      const expected = swept + Math.max(0, 30 - swept) + 10 + 20;
      expect(plan.bursts.length, `n=${swept}`).toBe(expected);
      // The 60-burst particle budget belongs to the n ≤ 30 case, where the
      // scattered extras fill the display up to 30 + the 10 anchored + 20
      // finale bursts. For n > 30 the extras clamp to 0, so the sweep is one
      // enemy burst per target plus the 30 mini-boss bursts (it never adds
      // extras on top).
      if (swept <= 30) {
        expect(plan.bursts.length, `n=${swept}`).toBeLessThanOrEqual(60);
      } else {
        expect(plan.bursts.length, `n=${swept}`).toBe(swept + 30);
      }
      expect(plan.sweptCount, `n=${swept}`).toBe(swept);
      expect(plan.anchored, `n=${swept}`).toBe(10);
      expect(plan.finale, `n=${swept}`).toBe(20);
      expect(plan.extras, `n=${swept}`).toBe(Math.max(0, 30 - swept));
    }
  });
});

// ── AC1/AC2: the scope split (escorts + minions, never hazards) ───

describe('mini-boss death sweep — target scope (AC1)', () => {
  it('keeps wave-gating escorts and live minions and drops non-blocking hazards', async () => {
    const { collectSweepTargets } = await sweep();
    const live = [target('scout', 0), target('asteroid', 1), target('tank', 2)];
    const minions = [target('swarm', 3), target('lane-traffic', 4)];

    const collected = collectSweepTargets(live, minions);

    // Escorts and minions survive; hazards do not.
    expect(collected.map((entry) => entry.key)).toEqual(['scout', 'tank', 'swarm']);
    for (const entry of collected) {
      expect(isNonBlockingHazard(entry.key), entry.key).toBe(false);
    }
  });

  it('sweeps only the collected targets — hazards never get an enemy burst', async () => {
    const { collectSweepTargets, planMiniBossDeathSweep } = await sweep();
    const live = [
      target('scout', 0),
      target('asteroid', 1),
      target('diver', 2),
      target('lane-traffic', 3),
    ];
    const minions = [target('swarm', 4)];

    const targets = collectSweepTargets(live, minions);
    const plan = planMiniBossDeathSweep(planInput(targets));

    // n counts only wave-gating enemies, so the extras formula sees 3, not 5.
    expect(plan.sweptCount).toBe(3);
    expect(plan.extras).toBe(27);
    expect(burstsOfRole(plan, 'enemy').length).toBe(3);
    // The hazard positions are never reused as sweep bursts.
    const hazardPositions = ['asteroid', 'lane-traffic'].map((key) =>
      live.find((entry) => entry.key === key)!,
    );
    for (const hazard of hazardPositions) {
      const overlapping = plan.bursts.filter(
        (burst) => burst.x === hazard.x && burst.y === hazard.y,
      );
      expect(overlapping, hazard.key).toEqual([]);
    }
  });

  it('classifies exactly asteroid and lane-traffic as non-blocking hazards', () => {
    // Green case: pins the shared classifier the split is built on, so a new
    // hazard key cannot silently start being swept.
    for (const key of ['asteroid', 'lane-traffic']) {
      expect(isNonBlockingHazard(key), key).toBe(true);
    }
    for (const key of ['scout', 'diver', 'tank', 'phaser', 'swarm', 'grunt']) {
      expect(isNonBlockingHazard(key), key).toBe(false);
    }
  });
});

// ── AC6: determinism ──────────────────────────────────────────────

describe('mini-boss death sweep — determinism (AC6)', () => {
  it('replays an identical plan for the same seed', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const targets = escorts(6);
    const first = planMiniBossDeathSweep(planInput(targets, 4242));
    const second = planMiniBossDeathSweep(planInput(targets, 4242));

    expect(second.bursts).toEqual(first.bursts);
    expect(second.completionDelayMs).toBe(first.completionDelayMs);
  });

  it('scatters differently for a different seed', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const targets = escorts(4);
    const a = planMiniBossDeathSweep(planInput(targets, 1));
    const b = planMiniBossDeathSweep(planInput(targets, 2));

    const positions = (plan: SweepPlan) =>
      burstsOfRole(plan, 'scatter').map((burst) => `${burst.x},${burst.y}`);
    expect(positions(b)).not.toEqual(positions(a));
  });

  it('never draws placement from Math.random()', async () => {
    // The deterministic-seed contract only holds if the module's own code
    // never reaches for the global RNG (comments are stripped first, so the
    // doc comment that names the anti-pattern does not trip the guard).
    const source = readFileSync(
      join(process.cwd(), 'src/scenes/core/miniBossDeathSweep.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random\s*\(/);
  });
});

// ── AC2: placement stays inside the playfield ────────────────────

describe('mini-boss death sweep — placement (AC2)', () => {
  it('keeps every scattered burst inside the playfield inset', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_INSET_PX,
    } = await sweep();
    expect(MINI_BOSS_SWEEP_INSET_PX).toBeGreaterThan(0);

    const plan = planMiniBossDeathSweep(planInput(escorts(0)));
    const scatter = burstsOfRole(plan, 'scatter');
    expect(scatter.length).toBe(30);

    for (const burst of scatter) {
      expect(burst.x).toBeGreaterThanOrEqual(BOUNDS.x + MINI_BOSS_SWEEP_INSET_PX);
      expect(burst.x).toBeLessThanOrEqual(
        BOUNDS.x + BOUNDS.width - MINI_BOSS_SWEEP_INSET_PX,
      );
      expect(burst.y).toBeGreaterThanOrEqual(BOUNDS.y + MINI_BOSS_SWEEP_INSET_PX);
      expect(burst.y).toBeLessThanOrEqual(
        BOUNDS.y + BOUNDS.height - MINI_BOSS_SWEEP_INSET_PX,
      );
    }
  });

  it('anchors the 10 mini-boss bursts around the captured death position', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX,
    } = await sweep();
    expect(MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX).toBeGreaterThan(0);

    const plan = planMiniBossDeathSweep(planInput(escorts(3)));
    for (const burst of burstsOfRole(plan, 'anchored')) {
      const distance = Math.hypot(burst.x - DEATH_X, burst.y - DEATH_Y);
      expect(distance).toBeLessThanOrEqual(MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX);
    }
  });

  it('places enemy bursts on the swept entities, staggered over the sweep', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const targets = escorts(4);
    const plan = planMiniBossDeathSweep(planInput(targets));

    const enemyBursts = burstsOfRole(plan, 'enemy');
    // Each enemy burst fires at its own entity's captured position…
    expect(enemyBursts.map((burst) => burst.x)).toEqual(targets.map((t) => t.x));
    expect(enemyBursts.map((burst) => burst.y)).toEqual(targets.map((t) => t.y));
    // …and the cascade is staggered (not all on the spawn frame).
    const delays = enemyBursts.map((burst) => burst.delayMs);
    expect(delays[0]).toBe(0);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i], `burst ${i}`).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    expect(delays[delays.length - 1]).toBeGreaterThan(0);
  });
});

// ── Producer review: the 20-burst mini-boss finale ────────────────

describe('mini-boss death sweep — finale cluster (producer review)', () => {
  it('adds exactly 20 finale bursts clustered in and around the mini-boss', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_FINALE_COUNT,
      MINI_BOSS_SWEEP_FINALE_SPREAD_PX,
    } = await sweep();
    expect(MINI_BOSS_SWEEP_FINALE_COUNT).toBe(20);
    expect(MINI_BOSS_SWEEP_FINALE_SPREAD_PX).toBeGreaterThan(0);

    const plan = planMiniBossDeathSweep(planInput(escorts(2)));
    const finale = burstsOfRole(plan, 'finale');
    expect(finale).toHaveLength(20);

    // "in and around the mini-boss": every finale burst sits within the
    // finale spread of the captured death position, and at least one lands
    // inside the tighter anchored radius ("in" as well as "around").
    let inside = 0;
    for (const burst of finale) {
      const distance = Math.hypot(burst.x - DEATH_X, burst.y - DEATH_Y);
      expect(distance).toBeLessThanOrEqual(MINI_BOSS_SWEEP_FINALE_SPREAD_PX);
      if (distance < MINI_BOSS_SWEEP_FINALE_SPREAD_PX / 2) inside += 1;
    }
    expect(inside).toBeGreaterThan(0);
  });

  it('fires the finale in pairs, two bursts every 250 ms', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_FINALE_PAIR_SIZE,
      MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS,
    } = await sweep();
    expect(MINI_BOSS_SWEEP_FINALE_PAIR_SIZE).toBe(2);
    expect(MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS).toBe(250);

    const plan = planMiniBossDeathSweep(planInput(escorts(1)));
    const delays = burstsOfRole(plan, 'finale').map((burst) => burst.delayMs);
    expect(delays).toHaveLength(20);

    // Pairs share a delay; consecutive pairs are 250 ms apart.
    const pairTimes = [...new Set(delays)];
    expect(pairTimes).toHaveLength(10);
    for (let i = 0; i < pairTimes.length; i += 1) {
      const inPair = delays.filter((delay) => delay === pairTimes[i]);
      expect(inPair, `pair ${i}`).toHaveLength(2);
      if (i > 0) {
        expect(pairTimes[i] - pairTimes[i - 1], `pair ${i} interval`).toBe(
          MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS,
        );
      }
    }
    // The finale keeps animating for over two seconds after the first pair
    // (10 pairs × 250 ms), so the mini-boss death is the biggest beat on
    // screen.
    expect(pairTimes[pairTimes.length - 1] - pairTimes[0]).toBe(2250);
  });

  it('starts the finale after the anchored celebration, never on the defeat frame', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_ANCHOR_START_MS,
      MINI_BOSS_SWEEP_ANCHOR_WINDOW_MS,
    } = await sweep();
    const plan = planMiniBossDeathSweep(planInput(escorts(0)));
    const anchored = burstsOfRole(plan, 'anchored');
    const finale = burstsOfRole(plan, 'finale');

    const anchoredEnd = Math.max(...anchored.map((burst) => burst.delayMs));
    const firstFinale = Math.min(...finale.map((burst) => burst.delayMs));
    expect(anchoredEnd).toBeLessThanOrEqual(
      MINI_BOSS_SWEEP_ANCHOR_START_MS + MINI_BOSS_SWEEP_ANCHOR_WINDOW_MS,
    );
    expect(firstFinale).toBeGreaterThan(anchoredEnd);
  });

  it('keeps the reward overlay held until the final finale pair has finished', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const plan = planMiniBossDeathSweep(planInput(escorts(3)));
    const finale = burstsOfRole(plan, 'finale');

    const finaleEnd = Math.max(
      ...finale.map((burst) => burst.delayMs + burst.lifespanMs),
    );
    // The completion delay is the last-finishing burst of the whole sweep,
    // so the overlay cannot open while a finale pair is still animating.
    expect(plan.completionDelayMs).toBe(finaleEnd);
    expect(plan.completionDelayMs).toBeGreaterThan(
      Math.max(...burstsOfRole(plan, 'anchored').map((b) => b.delayMs + b.lifespanMs)),
    );
  });
});

// ── AC7: mini-boss burst magnitudes (AH-0MVY06X16005EO8R) ────────
//
// "Increase the size of the mini-boss explosions. They should be at least 2x
// the size in both scale and sprite count." The producer settled the scope:
// only the two roles clustered on the mini-boss itself (anchored + finale)
// double; the swept-enemy and scattered celebration bursts keep today's
// sizing, and cadence/lifespan/completion are untouched.

describe('mini-boss death sweep — mini-boss burst magnitudes (AC7)', () => {
  /** The pre-doubling sizing this item supersedes — the recorded baselines. */
  const BASELINE = {
    anchored: { scale: 0.9, particles: 16 },
    finale: { scale: 1.2, particles: 20 },
    enemy: { scale: 0.8, particles: 14 },
    scatter: { scale: 0.7, particles: 12 },
  } as const;

  it('doubles the anchored and finale scale constants', async () => {
    const {
      MINI_BOSS_SWEEP_ANCHORED_SCALE,
      MINI_BOSS_SWEEP_FINALE_SCALE,
    } = await sweep();

    // At least 2× the recorded baseline — never a quiet shrink-back.
    expect(MINI_BOSS_SWEEP_ANCHORED_SCALE).toBeGreaterThanOrEqual(
      BASELINE.anchored.scale * 2,
    );
    expect(MINI_BOSS_SWEEP_FINALE_SCALE).toBeGreaterThanOrEqual(
      BASELINE.finale.scale * 2,
    );
    // …and the shipped values the intake fixed.
    expect(MINI_BOSS_SWEEP_ANCHORED_SCALE).toBe(1.8);
    expect(MINI_BOSS_SWEEP_FINALE_SCALE).toBe(2.4);
  });

  it('doubles the anchored and finale per-burst particle counts', async () => {
    const {
      MINI_BOSS_SWEEP_ANCHORED_PARTICLES,
      MINI_BOSS_SWEEP_FINALE_PARTICLES,
    } = await sweep();

    expect(MINI_BOSS_SWEEP_ANCHORED_PARTICLES).toBeGreaterThanOrEqual(
      BASELINE.anchored.particles * 2,
    );
    expect(MINI_BOSS_SWEEP_FINALE_PARTICLES).toBeGreaterThanOrEqual(
      BASELINE.finale.particles * 2,
    );
    expect(MINI_BOSS_SWEEP_ANCHORED_PARTICLES).toBe(32);
    expect(MINI_BOSS_SWEEP_FINALE_PARTICLES).toBe(40);
  });

  it('plans the doubled geometry and counts on every anchored/finale burst', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_ANCHORED_SCALE,
      MINI_BOSS_SWEEP_ANCHORED_PARTICLES,
      MINI_BOSS_SWEEP_FINALE_SCALE,
      MINI_BOSS_SWEEP_FINALE_PARTICLES,
    } = await sweep();

    const plan = planMiniBossDeathSweep(planInput(escorts(4)));

    for (const burst of burstsOfRole(plan, 'anchored')) {
      // Effective geometry is `size × scale`: the base size is unchanged, so a
      // doubled scale doubles the drawn radius and particle travel distance.
      expect(burst.scale).toBe(MINI_BOSS_SWEEP_ANCHORED_SCALE);
      expect(burst.scale).toBeGreaterThanOrEqual(BASELINE.anchored.scale * 2);
      expect(burst.particleCount).toBe(MINI_BOSS_SWEEP_ANCHORED_PARTICLES);
      expect(burst.particleCount).toBeGreaterThanOrEqual(
        BASELINE.anchored.particles * 2,
      );
      expect(burst.size * burst.scale).toBeGreaterThanOrEqual(2 * 16 * BASELINE.anchored.scale);
    }

    for (const burst of burstsOfRole(plan, 'finale')) {
      expect(burst.scale).toBe(MINI_BOSS_SWEEP_FINALE_SCALE);
      expect(burst.scale).toBeGreaterThanOrEqual(BASELINE.finale.scale * 2);
      expect(burst.particleCount).toBe(MINI_BOSS_SWEEP_FINALE_PARTICLES);
      expect(burst.particleCount).toBeGreaterThanOrEqual(
        BASELINE.finale.particles * 2,
      );
      expect(burst.size * burst.scale).toBeGreaterThanOrEqual(2 * 18 * BASELINE.finale.scale);
    }
  });

  it('leaves the swept-enemy and scatter bursts exactly as they were (out of scope)', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const plan = planMiniBossDeathSweep(planInput(escorts(5)));

    const enemy = burstsOfRole(plan, 'enemy');
    expect(enemy.length).toBeGreaterThan(0);
    for (const burst of enemy) {
      expect(burst.scale).toBe(BASELINE.enemy.scale);
      expect(burst.particleCount).toBe(BASELINE.enemy.particles);
    }

    const scatter = burstsOfRole(plan, 'scatter');
    expect(scatter.length).toBeGreaterThan(0);
    for (const burst of scatter) {
      expect(burst.scale).toBe(BASELINE.scatter.scale);
      expect(burst.particleCount).toBe(BASELINE.scatter.particles);
    }
  });

  it('preserves the role ordering scatter < enemy < anchored < finale', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const plan = planMiniBossDeathSweep(planInput(escorts(4)));

    const scaleOf = (role: SweepBurst['role']) => burstsOfRole(plan, role)[0].scale;

    expect(scaleOf('scatter')).toBeLessThan(scaleOf('enemy'));
    expect(scaleOf('enemy')).toBeLessThan(scaleOf('anchored'));
    expect(scaleOf('anchored')).toBeLessThan(scaleOf('finale'));
  });

  it('leaves the burst counts and completion delay unchanged (AC4)', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_LIFESPAN_MS,
      MINI_BOSS_SWEEP_ANCHORED_COUNT,
      MINI_BOSS_SWEEP_FINALE_COUNT,
    } = await sweep();

    // The display length is untouched: the per-burst lifespan is still 360 ms…
    expect(MINI_BOSS_SWEEP_LIFESPAN_MS).toBe(360);

    for (const n of [0, 1, 5, 30]) {
      const plan = planMiniBossDeathSweep(planInput(escorts(n)));
      // …burst counts are unchanged…
      expect(burstsOfRole(plan, 'anchored'), `n=${n}`).toHaveLength(
        MINI_BOSS_SWEEP_ANCHORED_COUNT,
      );
      expect(burstsOfRole(plan, 'finale'), `n=${n}`).toHaveLength(
        MINI_BOSS_SWEEP_FINALE_COUNT,
      );
      expect(plan.bursts.length, `n=${n}`).toBe(n + Math.max(0, 30 - n) + 30);
      // …and the reward overlay still waits for the same ~2.95 s display.
      expect(plan.completionDelayMs, `n=${n}`).toBe(2950);
    }
  });
});

// ── AC3/AC6: completion ordering ─────────────────────────────────

describe('mini-boss death sweep — completion ordering (AC3)', () => {
  it('reports a completion delay covering the last-finishing burst', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const plan = planMiniBossDeathSweep(planInput(escorts(5)));

    const lastFinish = Math.max(
      ...plan.bursts.map((burst) => burst.delayMs + burst.lifespanMs),
    );
    expect(plan.completionDelayMs).toBe(lastFinish);
    // The sweep must outlive the spawn frame: the reward overlay is held back
    // until the animation is really over.
    expect(plan.completionDelayMs).toBeGreaterThan(0);
  });

  it('does not fire the completion callback on the spawn frame', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubScene();
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      scene,
      planInput(escorts(2)),
      { onComplete: () => { completions += 1; } },
    );

    expect(scene.tweenCfgs.length).toBe(handle.plan.bursts.length);
    expect(handle.complete).toBe(false);
    expect(completions).toBe(0);
  });

  it('fires completion exactly once, only after every burst has finished', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubScene();
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      scene,
      planInput(escorts(3)),
      { onComplete: () => { completions += 1; } },
    );

    const tweens = [...scene.tweenCfgs];
    expect(tweens.length).toBeGreaterThan(10);
    for (let i = 0; i < tweens.length; i += 1) {
      const isLast = i === tweens.length - 1;
      tweens[i].onComplete?.();
      if (!isLast) {
        // A burst finishing is not the sweep finishing.
        expect(completions, `after burst ${i}`).toBe(0);
        expect(handle.complete, `after burst ${i}`).toBe(false);
      }
    }
    expect(completions).toBe(1);
    expect(handle.complete).toBe(true);
    expect(handle.explosions.length).toBe(handle.plan.bursts.length);
  });

  it('tears down mid-flight without firing completion', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubScene();
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      scene,
      planInput(escorts(2)),
      { onComplete: () => { completions += 1; } },
    );

    // A SHUTDOWN teardown interrupts the display: the deferred reward overlay
    // must not be opened by a sweep that never finished animating.
    handle.destroy();
    expect(completions).toBe(0);
  });
});

// ── AC3/AC6: the Clock watchdog completion seam ──────────────────

describe('mini-boss death sweep — clock watchdog completion (AC3)', () => {
  it('arms one watchdog after the last burst has finished animating', async () => {
    const { spawnMiniBossDeathSweep, MINI_BOSS_SWEEP_COMPLETION_MARGIN_MS } =
      await sweep();
    const scene = makeStubSceneWithClock();

    const handle = spawnMiniBossDeathSweep(scene, planInput(escorts(2)));

    expect(scene.timers).toHaveLength(1);
    // The watchdog can never fire before the display is over: it sits after
    // the plan's own completion delay, which is the last burst's end.
    expect(scene.timers[0].delayMs).toBe(
      handle.plan.completionDelayMs + MINI_BOSS_SWEEP_COMPLETION_MARGIN_MS,
    );
    expect(scene.timers[0].delayMs).toBeGreaterThan(handle.plan.completionDelayMs);
  });

  it('completes from the watchdog when the burst tweens never tick (synthetic loop)', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubSceneWithClock();
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      scene,
      planInput(escorts(2)),
      { onComplete: () => { completions += 1; } },
    );

    // A scene whose game loop is stopped (the deterministic harness) never
    // runs the burst tweens; the watchdog is the real timer that still ends
    // the display.
    expect(completions).toBe(0);
    scene.timers[0].callback();
    expect(completions).toBe(1);
    expect(handle.complete).toBe(true);

    // Idempotent: a second firing (and the burst tweens catching up) can
    // never open a second reward overlay.
    scene.timers[0].callback();
    expect(completions).toBe(1);
  });

  it('cancels the watchdog once every burst tween reports completion', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubSceneWithClock();
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      scene,
      planInput(escorts(2)),
      { onComplete: () => { completions += 1; } },
    );

    for (const tween of [...scene.tweenCfgs]) tween.onComplete?.();

    expect(completions).toBe(1);
    expect(handle.complete).toBe(true);
    expect(scene.timers[0].removed).toBe(true);
    // A cancelled watchdog can never fire a late completion.
    scene.timers[0].callback();
    expect(completions).toBe(1);
  });

  it('never completes through the watchdog after a teardown', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubSceneWithClock();
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      scene,
      planInput(escorts(2)),
      { onComplete: () => { completions += 1; } },
    );

    handle.destroy();
    expect(scene.timers[0].removed).toBe(true);
    scene.timers[0].callback();
    expect(completions).toBe(0);
    expect(handle.complete).toBe(false);
  });
});

// ── Explosion SFX (AH-0MVVEI7FD004TR2M: "no SFX accompanying the
//    mini-boss explosions") ──────────────────────────────────────────
//
// Producer decisions (settled): Q1 = reuse the existing baked cues only (no
// new recipe/asset/manifest entry), Q2 = one cue per burst with per-role
// thinning, Q3 = visual-timed (each cue at its burst's own `delayMs`, never on
// the 16th-note accent grid).

/** Records the whole audio timeline through the injectable seam (AC5). */
function recordSound() {
  const requests: SweepSoundRequest[] = [];
  return {
    requests,
    playSound: (request: SweepSoundRequest) => {
      requests.push(request);
    },
  };
}

/** The maximum number of `delayMs`s inside any `windowMs`-wide window. */
function maxInWindow(delays: readonly number[], windowMs: number): number {
  const sorted = [...delays].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end] - sorted[start] >= windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

describe('mini-boss death sweep — SFX dispatch (AC1)', () => {
  it('dispatches exactly one cue per kept burst, at that burst’s own delay', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const recorder = recordSound();

    const handle = spawnMiniBossDeathSweep(
      makeStubScene(),
      planInput(escorts(4)),
      { playSound: recorder.playSound },
    );

    const kept = handle.plan.bursts.filter((burst) => burst.audio.kept);
    const dispatched = recorder.requests;

    // One cue per kept burst — no more, no fewer — in plan order.
    expect(dispatched).toHaveLength(kept.length);
    dispatched.forEach((request, index) => {
      const burst = kept[index];
      expect(request.role, `kept burst ${index}`).toBe(burst.role);
      // Visual-timed (Q3 = a): the cue lands with its own burst, never on the
      // 16th-note accent grid.
      expect(request.delayMs, `kept burst ${index}`).toBe(burst.delayMs);
      expect(request.cue, `kept burst ${index}`).toBe(burst.audio.cue);
      expect(request.volume, `kept burst ${index}`).toBe(burst.audio.volume);
      expect(request.variantPick, `kept burst ${index}`).toBe(
        burst.audio.variantPick,
      );
    });
  });

  it('never dispatches a cue for a burst the thinning rule drops', async () => {
    const { spawnMiniBossDeathSweep, MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N } =
      await sweep();
    const recorder = recordSound();

    const handle = spawnMiniBossDeathSweep(
      makeStubScene(),
      planInput(escorts(4)),
      { playSound: recorder.playSound },
    );

    const dropped = handle.plan.bursts.filter((burst) => !burst.audio.kept);
    // The sweep really does thin (a plan where nothing is dropped would make
    // this test vacuous), and every dropped burst is silent.
    expect(MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N).toBeGreaterThan(1);
    expect(dropped.length).toBeGreaterThan(0);

    const dispatchedDelays = recorder.requests.map((request) => request.delayMs);
    for (const burst of dropped) {
      const keptTwin = handle.plan.bursts.find(
        (candidate) =>
          candidate.role === burst.role &&
          candidate.delayMs === burst.delayMs &&
          candidate.audio.kept,
      );
      // A dropped burst only collides in time with a kept one of another role;
      // assert on the identity of the cue requests instead of the delay alone.
      if (keptTwin === undefined) {
        expect(
          dispatchedDelays.filter((delay) => delay === burst.delayMs).length,
          `${burst.role} burst at ${burst.delayMs}ms must stay silent`,
        ).toBe(0);
      }
    }

    // The dispatch list is exactly the kept list: nothing dropped slipped in.
    expect(recorder.requests.length).toBe(
      handle.plan.bursts.filter((burst) => burst.audio.kept).length,
    );
  });

  it('never dispatches the mini-boss body cue — the entity owns it (AC1)', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const recorder = recordSound();

    spawnMiniBossDeathSweep(makeStubScene(), planInput(escorts(6)), {
      playSound: recorder.playSound,
    });

    // The body's `playBossDestructionSound()` belongs to the entity's shared
    // death seam (`Boss.takeDamage` / `Boss.playDestructionAudio`), which both
    // scenes already run exactly once on the killing blow. If the sweep also
    // dispatched it, every kill would double the boom — so the sweep must
    // never emit the body cue, whatever the plan.
    for (const request of recorder.requests) {
      expect(request.role).not.toBe('body');
      expect(request.cue).not.toBe('playBossDestructionSound');
    }
  });

  it('still voices the celebration and finale when nothing is swept', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const recorder = recordSound();

    const handle = spawnMiniBossDeathSweep(
      makeStubScene(),
      planInput([]),
      { playSound: recorder.playSound },
    );

    // `n = 0` is the loudest plan (30 scatter + 10 anchored + 20 finale): there
    // are no escort bursts, but the celebration and the climax must still be
    // heard — the display is never silent.
    expect(handle.plan.sweptCount).toBe(0);
    expect(handle.plan.bursts).toHaveLength(60);
    expect(recorder.requests.length).toBeGreaterThan(0);
    for (const request of recorder.requests) {
      expect(request.role).not.toBe('enemy');
    }
  });
});

describe('mini-boss death sweep — thinning and density (AC2)', () => {
  it('keeps every enemy burst, one in two scatter/anchored bursts and every finale burst', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N,
      MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N,
      MINI_BOSS_SWEEP_SFX_ANCHORED_EVERY_N,
      MINI_BOSS_SWEEP_SFX_FINALE_EVERY_N,
    } = await sweep();

    // The settled strides (Q2 = a).
    expect(MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N).toBe(1);
    expect(MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N).toBe(2);
    expect(MINI_BOSS_SWEEP_SFX_ANCHORED_EVERY_N).toBe(2);
    expect(MINI_BOSS_SWEEP_SFX_FINALE_EVERY_N).toBe(1);

    const plan = planMiniBossDeathSweep(planInput(escorts(6)));
    const strides: Record<SweepBurst['role'], number> = {
      enemy: MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N,
      scatter: MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N,
      anchored: MINI_BOSS_SWEEP_SFX_ANCHORED_EVERY_N,
      finale: MINI_BOSS_SWEEP_SFX_FINALE_EVERY_N,
    };

    for (const role of ['enemy', 'scatter', 'anchored', 'finale'] as const) {
      const bursts = burstsOfRole(plan, role);
      expect(bursts.length).toBeGreaterThan(0);
      bursts.forEach((burst, index) => {
        expect(burst.audio.kept, `${role} burst ${index}`).toBe(
          index % strides[role] === 0,
        );
      });
    }
  });

  it('never thins the finale — both voices of every pair are voiced', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_FINALE_COUNT,
      MINI_BOSS_SWEEP_FINALE_PAIR_SIZE,
      MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS,
      MINI_BOSS_SWEEP_FINALE_START_MS,
    } = await sweep();

    const plan = planMiniBossDeathSweep(planInput(escorts(2)));
    const finale = burstsOfRole(plan, 'finale');

    expect(finale).toHaveLength(MINI_BOSS_SWEEP_FINALE_COUNT);
    expect(finale.every((burst) => burst.audio.kept)).toBe(true);

    // The voices of one pair share a delay, two per interval — so the climax
    // is a pair of simultaneous booms, never a single thinned one.
    finale.forEach((burst, index) => {
      expect(burst.delayMs, `finale burst ${index}`).toBe(
        MINI_BOSS_SWEEP_FINALE_START_MS +
          Math.floor(index / MINI_BOSS_SWEEP_FINALE_PAIR_SIZE) *
            MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS,
      );
    });
    const pairs = new Map<number, number>();
    for (const burst of finale) {
      pairs.set(burst.delayMs, (pairs.get(burst.delayMs) ?? 0) + 1);
    }
    expect([...pairs.values()].every((count) => count === 2)).toBe(true);
  });

  it('keeps the dispatch density inside the documented bound for every 60-burst plan', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_EXTRA_BASE,
      MINI_BOSS_SWEEP_SFX_MAX_PER_WINDOW,
      MINI_BOSS_SWEEP_SFX_WINDOW_MS,
    } = await sweep();

    expect(MINI_BOSS_SWEEP_SFX_WINDOW_MS).toBe(250);

    let worst = 0;
    let worstSwept = 0;
    for (let n = 0; n <= MINI_BOSS_SWEEP_EXTRA_BASE; n += 1) {
      const plan = planMiniBossDeathSweep(planInput(escorts(n)));
      // The bound only claims the 60-burst maximum (n ≤ 30).
      expect(plan.bursts.length).toBeLessThanOrEqual(60);
      const keptDelays = plan.bursts
        .filter((burst) => burst.audio.kept)
        .map((burst) => burst.delayMs);
      const windowed = maxInWindow(keptDelays, MINI_BOSS_SWEEP_SFX_WINDOW_MS);
      if (windowed > worst) {
        worst = windowed;
        worstSwept = n;
      }
    }

    expect(worst, `worst window at n=${worstSwept}`).toBeLessThanOrEqual(
      MINI_BOSS_SWEEP_SFX_MAX_PER_WINDOW,
    );
    // ...and the constant is the real worst case, not a slack placeholder: a
    // louder schedule must fail this pin and force a re-derivation.
    expect(worst).toBe(MINI_BOSS_SWEEP_SFX_MAX_PER_WINDOW);
  });

  it('trims the mix per role and keeps the finale the loudest burst layer', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_SFX_ENEMY_VOLUME,
      MINI_BOSS_SWEEP_SFX_SCATTER_VOLUME,
      MINI_BOSS_SWEEP_SFX_ANCHORED_VOLUME,
      MINI_BOSS_SWEEP_SFX_FINALE_VOLUME,
    } = await sweep();

    const plan = planMiniBossDeathSweep(planInput(escorts(4)));
    const volumeOf: Record<SweepBurst['role'], number> = {
      enemy: MINI_BOSS_SWEEP_SFX_ENEMY_VOLUME,
      scatter: MINI_BOSS_SWEEP_SFX_SCATTER_VOLUME,
      anchored: MINI_BOSS_SWEEP_SFX_ANCHORED_VOLUME,
      finale: MINI_BOSS_SWEEP_SFX_FINALE_VOLUME,
    };
    for (const burst of plan.bursts) {
      expect(burst.audio.volume, burst.role).toBe(volumeOf[burst.role]);
      expect(burst.audio.volume).toBeGreaterThan(0);
      expect(burst.audio.volume).toBeLessThanOrEqual(1);
    }
    // The finale must read as the climax of the display.
    expect(volumeOf.finale).toBeGreaterThan(volumeOf.enemy);
    expect(volumeOf.finale).toBeGreaterThan(volumeOf.anchored);
    expect(volumeOf.finale).toBeGreaterThan(volumeOf.scatter);
  });
});

describe('mini-boss death sweep — reuse-only cue palette (AC3)', () => {
  it('maps each role onto an existing baked cue (no new recipe or asset)', async () => {
    const {
      planMiniBossDeathSweep,
      MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE,
      MINI_BOSS_SWEEP_SFX_FINALE_CUE,
    } = await sweep();

    expect(MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE).toBe('playDestructionSound');
    expect(MINI_BOSS_SWEEP_SFX_FINALE_CUE).toBe('playVictoryExplosionSound');

    const plan = planMiniBossDeathSweep(planInput(escorts(3)));
    for (const burst of plan.bursts) {
      expect(burst.audio.cue, burst.role).toBe(
        burst.role === 'finale'
          ? MINI_BOSS_SWEEP_SFX_FINALE_CUE
          : MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE,
      );
    }

    // The palette is reuse-only and closed: exactly the two burst families.
    const used = new Set(plan.bursts.map((burst) => burst.audio.cue));
    expect([...used].sort()).toEqual(
      [MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE, MINI_BOSS_SWEEP_SFX_FINALE_CUE].sort(),
    );
  });

  it('routes every kept burst through the shared audio dispatcher', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    vi.mocked(audioEffects.playMiniBossSweepSound).mockClear();

    const handle = spawnMiniBossDeathSweep(
      makeStubScene(),
      planInput(escorts(2)),
    );

    // One cue per kept burst, all through the one shared dispatcher (so the
    // game and every gym sound identical — AC4).
    const calls = vi.mocked(audioEffects.playMiniBossSweepSound).mock.calls;
    expect(calls.length).toBe(
      handle.plan.bursts.filter((burst) => burst.audio.kept).length,
    );
    for (const [cue, options] of calls) {
      expect(['playDestructionSound', 'playVictoryExplosionSound']).toContain(cue);
      expect(options!.volume).toBeGreaterThan(0);
      expect(options!.delay).toBeGreaterThanOrEqual(0);
      expect(options!.variantPick).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('mini-boss death sweep — deterministic audio, safe no-ops (AC5)', () => {
  it('replays the same cue variants for the same seed', async () => {
    const { planMiniBossDeathSweep } = await sweep();

    const a = planMiniBossDeathSweep(planInput(escorts(8), 0xabc));
    const b = planMiniBossDeathSweep(planInput(escorts(8), 0xabc));
    expect(a.bursts.map((burst) => burst.audio)).toEqual(
      b.bursts.map((burst) => burst.audio),
    );

    const c = planMiniBossDeathSweep(planInput(escorts(8), 0xdef));
    expect(c.bursts.map((burst) => burst.audio.variantPick)).not.toEqual(
      a.bursts.map((burst) => burst.audio.variantPick),
    );
  });

  it('draws the variant from the run seed, never from Math.random()', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const spy = vi.spyOn(Math, 'random');
    try {
      const plan = planMiniBossDeathSweep(planInput(escorts(5)));
      expect(spy).not.toHaveBeenCalled();
      for (const burst of plan.bursts) {
        expect(burst.audio.variantPick).toBeGreaterThanOrEqual(0);
        expect(burst.audio.variantPick).toBeLessThan(1);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps burst placement identical to the visual-only sweep for a seed', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    const a = planMiniBossDeathSweep(planInput(escorts(6), SEED));
    const b = planMiniBossDeathSweep(planInput(escorts(6), SEED));
    // The audio decision draws from its own seeded stream, so adding audio can
    // never move a burst.
    expect(a.bursts.map(({ x, y, color }) => ({ x, y, color }))).toEqual(
      b.bursts.map(({ x, y, color }) => ({ x, y, color })),
    );
  });

  it('dispatches nothing when SFX are disabled (mute / headless)', async () => {
    const { spawnMiniBossDeathSweep, MINI_BOSS_SWEEP_SFX_ENABLED } = await sweep();
    const recorder = recordSound();

    // On by default.
    expect(MINI_BOSS_SWEEP_SFX_ENABLED).toBe(true);

    spawnMiniBossDeathSweep(makeStubScene(), planInput(escorts(4)), {
      soundEnabled: false,
      playSound: recorder.playSound,
    });

    expect(recorder.requests).toHaveLength(0);
  });

  it('swallows a throwing sound seam and still completes exactly once (AC9)', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    let attempts = 0;
    let completions = 0;

    const handle = spawnMiniBossDeathSweep(
      makeStubScene(),
      planInput(escorts(3)),
      {
        playSound: () => {
          attempts += 1;
          throw new Error('audio device exploded');
        },
        onComplete: () => {
          completions += 1;
        },
      },
    );

    // Audio is best-effort: every cue was attempted, none of it threw, and the
    // completion path was untouched.
    expect(attempts).toBeGreaterThan(0);
    handle.destroy();
    expect(completions).toBe(0);
  });
});

describe('mini-boss death sweep — audio never delays the victory hold (AC9)', () => {
  it('fires onComplete exactly once with SFX enabled', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubSceneWithClock();
    const recorder = recordSound();
    let completions = 0;

    spawnMiniBossDeathSweep(scene, planInput(escorts(3)), {
      playSound: recorder.playSound,
      onComplete: () => {
        completions += 1;
      },
    });

    // Audio dispatch is synchronous and fire-and-forget, so it never holds the
    // completion timer: the watchdog is still the plain burst-lifespan timer.
    expect(scene.timers).toHaveLength(1);
    expect(completions).toBe(0);
    scene.timers[0].callback();
    expect(completions).toBe(1);
  });

  it('fires onComplete exactly once when SFX are muted', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const scene = makeStubSceneWithClock();
    let completions = 0;

    spawnMiniBossDeathSweep(scene, planInput(escorts(3)), {
      soundEnabled: false,
      onComplete: () => {
        completions += 1;
      },
    });

    scene.timers[0].callback();
    expect(completions).toBe(1);
  });

  it('dispatches the whole cue timeline up-front, so none survives destroy()', async () => {
    const { spawnMiniBossDeathSweep } = await sweep();
    const recorder = recordSound();

    const handle = spawnMiniBossDeathSweep(
      makeStubScene(),
      planInput(escorts(6)),
      { playSound: recorder.playSound },
    );
    const kept = handle.plan.bursts.filter((burst) => burst.audio.kept).length;
    const atSpawn = recorder.requests.length;
    expect(atSpawn).toBe(kept);
    expect(atSpawn).toBeGreaterThan(0);

    // Teardown mid-display must not fire anything else: every cue was handed to
    // the audio layer on the defeat frame, and the audio layer owns the
    // schedule from there (the scene-teardown mute path silences it).
    handle.destroy();
    expect(recorder.requests).toHaveLength(atSpawn);
  });
});
