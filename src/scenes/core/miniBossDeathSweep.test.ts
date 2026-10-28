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
 * - `miniBossSweepExtras(n)` — `Math.max(0, 30 - n)`; never negative, never
 *   throws, for any `n` (`0 → 30`, `1 → 29`, `29 → 1`, `30 → 0`, `40 → 0`).
 * - `collectSweepTargets(live, minions = [])` — the wave-gating scope split:
 *   keeps escorts and the mini-boss's live minions, drops every
 *   `isNonBlockingHazard` key (`asteroid`, `lane-traffic`), preserves order.
 * - `planMiniBossDeathSweep({ targets, deathX, deathY, bounds, seed })` —
 *   returns `{ bursts, sweptCount, extras, anchored, completionDelayMs }`
 *   where `sweptCount === targets.length`, `extras === miniBossSweepExtras(n)`,
 *   `anchored === 10` and `bursts.length === n + extras + 10 <= 40`. Bursts
 *   carry `{ role, delayMs, x, y, color, size, particleCount, scale,
 *   lifespanMs }` with `role` one of `'enemy' | 'scatter' | 'anchored'`:
 *   exactly one `enemy` burst per swept target, `extras` `scatter` bursts
 *   sampled inside `bounds` inset by the burst radius (so no burst is clipped
 *   entirely off-screen) and exactly 10 `anchored` bursts around
 *   `(deathX, deathY)`. Same seed ⇒ identical plan; no `Math.random()`.
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

import { describe, expect, it } from 'vitest';

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
  role: 'enemy' | 'scatter' | 'anchored';
  delayMs: number;
  x: number;
  y: number;
  color: number;
  size: number;
  particleCount: number;
  scale: number;
  lifespanMs: number;
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
  miniBossSweepExtras(sweptCount: number): number;
  collectSweepTargets(
    live: readonly SweepTarget[],
    minions?: readonly SweepTarget[],
  ): SweepTarget[];
  planMiniBossDeathSweep(input: SweepPlanInput): SweepPlan;
  spawnMiniBossDeathSweep(
    scene: unknown,
    input: SweepPlanInput,
    options?: { onComplete?: () => void },
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

  it('plans exactly 10 anchored bursts at the mini-boss death point for every n', async () => {
    const { planMiniBossDeathSweep, MINI_BOSS_SWEEP_ANCHORED_COUNT } = await sweep();
    expect(MINI_BOSS_SWEEP_ANCHORED_COUNT).toBe(10);
    for (const swept of [0, 1, 5, 29, 30, 40]) {
      const plan = planMiniBossDeathSweep(planInput(escorts(swept)));
      expect(burstsOfRole(plan, 'anchored').length, `n=${swept}`).toBe(10);
      expect(burstsOfRole(plan, 'enemy').length, `n=${swept}`).toBe(swept);
      expect(burstsOfRole(plan, 'scatter').length, `n=${swept}`).toBe(
        Math.max(0, 30 - swept),
      );
    }
  });

  it('burns at most 40 bursts in total while the extras formula applies (n ≤ 30)', async () => {
    const { planMiniBossDeathSweep } = await sweep();
    for (const swept of [0, 1, 10, 29, 30, 31, 40, 100]) {
      const plan = planMiniBossDeathSweep(planInput(escorts(swept)));
      const expected = swept + Math.max(0, 30 - swept) + 10;
      expect(plan.bursts.length, `n=${swept}`).toBe(expected);
      // The 40-burst particle budget belongs to the n ≤ 30 case, where the
      // scattered extras fill the display up to 30 + the 10 anchored bursts.
      // For n > 30 the extras clamp to 0, so the sweep is one enemy burst per
      // target plus the 10 anchored bursts (it never adds extras on top).
      if (swept <= 30) {
        expect(plan.bursts.length, `n=${swept}`).toBeLessThanOrEqual(40);
      } else {
        expect(plan.bursts.length, `n=${swept}`).toBe(swept + 10);
      }
      expect(plan.sweptCount, `n=${swept}`).toBe(swept);
      expect(plan.anchored, `n=${swept}`).toBe(10);
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
