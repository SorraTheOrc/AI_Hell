/**
 * Shared mini-boss death sweep (AH-0MVROEKMT005RVML).
 *
 * One implementation of the mini-boss defeat explosion sweep, consumed by
 * both the game (`PlayScene`) and the gyms (`GymMiniBoss`) — per the
 * "Game Architecture Conventions" (AGENTS.md): shared behaviour lives once,
 * any divergence is caught by `CombatScene.equivalence.test.ts`.
 *
 * The module is split in the same pure-planner / thin-executor shape as the
 * victory fireworks (`src/vfx/endOfRunJuice.ts`):
 *
 * - **Planner** (`collectSweepTargets`, `planMiniBossDeathSweep`,
 *   `miniBossSweepExtras`) — Phaser-free, pure, total and deterministic.
 *   All placement/jitter draws from the caller's run-seeded RNG; there is
 *   no `Math.random()` anywhere in this module (pinned by
 *   `miniBossDeathSweep.test.ts`).
 * - **Executor** (`spawnMiniBossDeathSweep`) — the only Phaser-aware part.
 *   Dispatches every planned burst through the shared
 *   `spawnExplosionParticles`, honours each burst's `delayMs`/`lifespanMs`
 *   via tween scheduling, and fires `options.onComplete` exactly once after
 *   the last burst has finished animating so the mini-boss reward overlay
 *   is held back (parent AC3 / AC6).
 *
 * Cosmetic only (parent AC4): the sweep awards no score, drops nothing and
 * emits no telemetry — swept entities are removed visually through the
 * caller's own teardown seam, never through the reward-bearing kill path.
 *
 * ## Sweep composition (parent AC2)
 *
 * For `n` swept wave-gating enemies (escorts + the mini-boss's live
 * minions):
 *
 * - `n` **enemy** bursts on each swept target's captured position, staggered
 *   over a short cascade window;
 * - `max(0, 30 - n)` **scatter** bursts sampled uniformly inside the
 *   playfield inset by the burst radius (no burst is clipped entirely
 *   off-screen);
 * - exactly `MINI_BOSS_SWEEP_ANCHORED_COUNT` (10) **anchored** bursts around
 *   the captured mini-boss death position.
 *
 * Total bursts `n + max(0, 30 - n) + 10`; for the realistic `n <= 30` case
 * that is `<= 40`, and above that the extras clamp to 0 so the sweep is one
 * enemy burst per target plus the 10 anchored bursts. Extras and anchored
 * bursts use a reduced particle count so the whole display stays inside the
 * particle budget.
 */

import {
  createRng,
  spawnExplosionParticles,
  type ExplosionHandle,
  type ExplosionScene,
} from '../../vfx/explosionParticles';
import { isNonBlockingHazard } from './waveTimeout';

// ── Tunable constants ─────────────────────────────────────────────

/** Extra scattered bursts target: `max(0, MINI_BOSS_SWEEP_EXTRA_BASE - n)`. */
export const MINI_BOSS_SWEEP_EXTRA_BASE = 30;

/** Anchored bursts clustered around the mini-boss death position. */
export const MINI_BOSS_SWEEP_ANCHORED_COUNT = 10;

/** Scatter inset (px) from the playfield edge — no burst clipped off-screen. */
export const MINI_BOSS_SWEEP_INSET_PX = 24;

/** Radius (px) around the death point within which anchored bursts sit. */
export const MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX = 80;

/** Total enemy-burst stagger window (ms) — the cascade is a short sweep. */
export const MINI_BOSS_SWEEP_ENEMY_WINDOW_MS = 360;

/** Total scatter-burst stagger window (ms). */
export const MINI_BOSS_SWEEP_SCATTER_WINDOW_MS = 560;

/** Total anchored-burst stagger window (ms). */
export const MINI_BOSS_SWEEP_ANCHOR_WINDOW_MS = 270;

/** Delay (ms) before the first scatter burst starts. */
export const MINI_BOSS_SWEEP_SCATTER_START_MS = 80;

/** Delay (ms) before the first anchored burst starts. */
export const MINI_BOSS_SWEEP_ANCHOR_START_MS = 60;

/** Particle count per swept-enemy burst (enemy-scale, modest). */
export const MINI_BOSS_SWEEP_ENEMY_PARTICLES = 14;

/** Reduced particle count per scatter burst (particle budget, AC2). */
export const MINI_BOSS_SWEEP_SCATTER_PARTICLES = 12;

/** Reduced particle count per anchored burst (particle budget, AC2). */
export const MINI_BOSS_SWEEP_ANCHORED_PARTICLES = 16;

/** Per-burst lifespan (ms) — same order as the shared explosion lifespan. */
export const MINI_BOSS_SWEEP_LIFESPAN_MS = 360;

/**
 * Margin (ms) the completion watchdog adds after the last burst's scheduled
 * end, so a running display always prefers the burst tweens' own completion
 * over the watchdog.
 */
export const MINI_BOSS_SWEEP_COMPLETION_MARGIN_MS = 40;

/** Geometry scale for enemy bursts — enemy-scale, not boss-scale (AC1). */
export const MINI_BOSS_SWEEP_ENEMY_SCALE = 0.8;

/** Geometry scale for scatter bursts (reduced, cosmetic-only). */
export const MINI_BOSS_SWEEP_SCATTER_SCALE = 0.7;

/** Geometry scale for anchored bursts. */
export const MINI_BOSS_SWEEP_ANCHORED_SCALE = 0.9;

/** Celebration colour palette for scatter/anchored bursts. */
const MINI_BOSS_SWEEP_PALETTE: readonly number[] = [
  0xffd166, 0xff9f1c, 0xff6b35, 0xffe066,
];

// ── Types ─────────────────────────────────────────────────────────

/** One swept target: a live wave-gating entity captured at defeat time. */
export interface MiniBossSweepTarget {
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
export interface MiniBossSweepBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A planned burst (pure data — no Phaser objects). */
export interface MiniBossSweepBurst {
  /** Which sweep part the burst belongs to. */
  role: 'enemy' | 'scatter' | 'anchored';
  /** Delay (ms) from sweep start before the burst animates. */
  delayMs: number;
  /** World X of the burst centre. */
  x: number;
  /** World Y of the burst centre. */
  y: number;
  /** Burst colour. */
  color: number;
  /** Base size handed to `spawnExplosionParticles` (geometry). */
  size: number;
  /** Particle count for the burst (reduced for extras/anchored). */
  particleCount: number;
  /** Geometry scale for the burst. */
  scale: number;
  /** Animation lifespan (ms). */
  lifespanMs: number;
}

/** The planner input. */
export interface MiniBossSweepPlanInput {
  /** The collected sweep targets (escorts + live minions, hazards excluded). */
  targets: readonly MiniBossSweepTarget[];
  /** Captured mini-boss death X (before the entity is destroyed). */
  deathX: number;
  /** Captured mini-boss death Y. */
  deathY: number;
  /** Playfield bounds the scatter must stay inside. */
  bounds: MiniBossSweepBounds;
  /** Run-seeded RNG seed — the sweep must replay identically for a seed. */
  seed: number;
  /** Scatter inset override (default `MINI_BOSS_SWEEP_INSET_PX`). */
  inset?: number;
}

/** The planner output. */
export interface MiniBossSweepPlan {
  /** Every planned burst, in sweep order (enemy, then scatter, then anchored). */
  bursts: readonly MiniBossSweepBurst[];
  /** Number of swept wave-gating enemies (`n`). */
  sweptCount: number;
  /** Number of scatter bursts (`max(0, 30 - n)`). */
  extras: number;
  /** Number of anchored bursts (always `MINI_BOSS_SWEEP_ANCHORED_COUNT`). */
  anchored: number;
  /** Delay (ms) after which the last burst has finished animating. */
  completionDelayMs: number;
}

/** Optional overrides for {@link spawnMiniBossDeathSweep}. */
export interface MiniBossDeathSweepOptions {
  /** Fires exactly once, after every burst has finished animating. */
  onComplete?: () => void;
}

/**
 * The minimal Phaser `time` surface the executor's completion watchdog needs
 * (a `Clock.delayedCall` timer). Kept structural — like {@link ExplosionScene}
 * — so headless tests can inject a double, and optional so a scene without a
 * Clock simply falls back to the bursts' own tween completion.
 */
export interface MiniBossSweepClock {
  delayedCall(
    delayMs: number,
    callback: () => void,
  ): { remove(dispatchCallback?: boolean): void } | unknown;
}

/** The scene surface `spawnMiniBossDeathSweep` needs (VFX + an optional Clock). */
export type MiniBossSweepScene = ExplosionScene & { time?: MiniBossSweepClock };

/** Live handle for a running sweep. */
export interface MiniBossDeathSweepHandle {
  /** The plan the executor is playing. */
  readonly plan: MiniBossSweepPlan;
  /** One explosion handle per planned burst (spawn order). */
  readonly explosions: readonly ExplosionHandle[];
  /** Whether the whole sweep has finished animating. */
  readonly complete: boolean;
  /** Interrupts the display immediately; never fires `onComplete`. */
  destroy(): void;
}

// ── Planner: count formula ────────────────────────────────────────

/**
 * Extra scattered burst count: `max(0, 30 - n)` for `n` swept enemies.
 * Total (never negative, never throws) for any `n`; non-integer inputs are
 * floored so the planner always yields whole burst counts.
 */
export function miniBossSweepExtras(sweptCount: number): number {
  return Math.max(0, Math.floor(MINI_BOSS_SWEEP_EXTRA_BASE - sweptCount));
}

// ── Planner: target collection (scope split) ─────────────────────

/**
 * The wave-gating scope split (parent AC1): keeps the caller's live
 * wave-gating escorts plus the mini-boss's live minions (captured before the
 * boss is destroyed), and drops every `isNonBlockingHazard` key
 * (`asteroid`, `lane-traffic`) — hazards survive the sweep. Order is
 * preserved (live entities first, then minions).
 */
export function collectSweepTargets(
  live: readonly MiniBossSweepTarget[],
  minions: readonly MiniBossSweepTarget[] = [],
): MiniBossSweepTarget[] {
  const all = [...live, ...minions];
  return all.filter((entry) => !isNonBlockingHazard(entry.key));
}

// ── Planner: burst schedule ───────────────────────────────────────

/** Evenly staggers `count` bursts across `windowMs`, starting at `startMs`. */
function staggerDelays(count: number, startMs: number, windowMs: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [startMs];
  const step = windowMs / (count - 1);
  return Array.from({ length: count }, (_unused, i) => startMs + Math.round(i * step));
}

/** Uniform sample inside `bounds` inset by `inset` (no off-screen clipping). */
function scatterPosition(
  bounds: MiniBossSweepBounds,
  inset: number,
  rng: () => number,
): { x: number; y: number } {
  const safeInset = Math.min(inset, bounds.width / 2, bounds.height / 2);
  const x = bounds.x + safeInset + rng() * Math.max(0, bounds.width - 2 * safeInset);
  const y = bounds.y + safeInset + rng() * Math.max(0, bounds.height - 2 * safeInset);
  return { x, y };
}

/** Uniform sample inside a disk of `spread` around the anchor. */
function anchoredPosition(
  deathX: number,
  deathY: number,
  spread: number,
  rng: () => number,
): { x: number; y: number } {
  const angle = rng() * Math.PI * 2;
  const radius = Math.sqrt(rng()) * spread; // sqrt → uniform over the disk
  return { x: deathX + Math.cos(angle) * radius, y: deathY + Math.sin(angle) * radius };
}

/**
 * Pure planner: turns the sweep targets + captured death position + bounds
 * + run-seeded RNG into the full burst schedule. Same seed ⇒ identical plan.
 *
 * - `enemy` bursts: one per swept target, at the target's captured position,
 *   staggered over `MINI_BOSS_SWEEP_ENEMY_WINDOW_MS` (cascade starts on the
 *   defeat frame).
 * - `scatter` bursts: `miniBossSweepExtras(n)` samples inside the bounds
 *   inset by `MINI_BOSS_SWEEP_INSET_PX`.
 * - `anchored` bursts: exactly `MINI_BOSS_SWEEP_ANCHORED_COUNT` samples
 *   within `MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX` of the death position.
 *
 * `completionDelayMs` is the moment the last burst finishes (`delay +
 * lifespan` of the last-finishing burst), which is what the executor/
 * reward-overlay wait uses.
 */
export function planMiniBossDeathSweep(
  input: MiniBossSweepPlanInput,
): MiniBossSweepPlan {
  const { targets, deathX, deathY, bounds, seed } = input;
  const rng = createRng(seed);
  const inset = input.inset ?? MINI_BOSS_SWEEP_INSET_PX;

  const n = targets.length;
  const extras = miniBossSweepExtras(n);

  const bursts: MiniBossSweepBurst[] = [];

  // Enemy bursts — cascade starts immediately, staggered over a short window.
  const enemyDelays = staggerDelays(n, 0, MINI_BOSS_SWEEP_ENEMY_WINDOW_MS);
  for (let i = 0; i < n; i += 1) {
    const target = targets[i];
    bursts.push({
      role: 'enemy',
      delayMs: enemyDelays[i],
      x: target.x,
      y: target.y,
      color: target.color,
      size: target.size,
      particleCount: MINI_BOSS_SWEEP_ENEMY_PARTICLES,
      scale: MINI_BOSS_SWEEP_ENEMY_SCALE,
      lifespanMs: MINI_BOSS_SWEEP_LIFESPAN_MS,
    });
  }

  // Scatter bursts — uniform, inside the inset bounds.
  const scatterDelays = staggerDelays(
    extras,
    MINI_BOSS_SWEEP_SCATTER_START_MS,
    MINI_BOSS_SWEEP_SCATTER_WINDOW_MS,
  );
  for (let i = 0; i < extras; i += 1) {
    const { x, y } = scatterPosition(bounds, inset, rng);
    bursts.push({
      role: 'scatter',
      delayMs: scatterDelays[i],
      x,
      y,
      color: MINI_BOSS_SWEEP_PALETTE[Math.floor(rng() * MINI_BOSS_SWEEP_PALETTE.length)],
      size: 16,
      particleCount: MINI_BOSS_SWEEP_SCATTER_PARTICLES,
      scale: MINI_BOSS_SWEEP_SCATTER_SCALE,
      lifespanMs: MINI_BOSS_SWEEP_LIFESPAN_MS,
    });
  }

  // Anchored bursts — exactly 10 within the anchor spread of the death point.
  const anchoredDelays = staggerDelays(
    MINI_BOSS_SWEEP_ANCHORED_COUNT,
    MINI_BOSS_SWEEP_ANCHOR_START_MS,
    MINI_BOSS_SWEEP_ANCHOR_WINDOW_MS,
  );
  for (let i = 0; i < MINI_BOSS_SWEEP_ANCHORED_COUNT; i += 1) {
    const { x, y } = anchoredPosition(deathX, deathY, MINI_BOSS_SWEEP_ANCHOR_SPREAD_PX, rng);
    bursts.push({
      role: 'anchored',
      delayMs: anchoredDelays[i],
      x,
      y,
      color: MINI_BOSS_SWEEP_PALETTE[Math.floor(rng() * MINI_BOSS_SWEEP_PALETTE.length)],
      size: 16,
      particleCount: MINI_BOSS_SWEEP_ANCHORED_PARTICLES,
      scale: MINI_BOSS_SWEEP_ANCHORED_SCALE,
      lifespanMs: MINI_BOSS_SWEEP_LIFESPAN_MS,
    });
  }

  const completionDelayMs = bursts.reduce(
    (latest, burst) => Math.max(latest, burst.delayMs + burst.lifespanMs),
    0,
  );

  return {
    bursts,
    sweptCount: n,
    extras,
    anchored: MINI_BOSS_SWEEP_ANCHORED_COUNT,
    completionDelayMs,
  };
}

// ── Thin Phaser executor ──────────────────────────────────────────

/**
 * Plays a planned sweep on the given scene: every burst is dispatched through
 * `spawnExplosionParticles` (honouring `delayMs`/`lifespanMs`/`count`/`scale`)
 * and each burst's completion is counted; `options.onComplete` fires exactly
 * once — only after every burst has finished animating, never on the spawn
 * frame and never on an explicit `destroy()` teardown (parent AC3).
 *
 * Each burst spawn uses a deterministic per-burst seed derived from the
 * planner's run seed, so the particles themselves are reproducible for a
 * given seed.
 *
 * **Completion seam (two real signals, never a frame count).** The preferred
 * signal is the last burst tween's own `onComplete` (every burst counted).
 * Because a Phaser scene driven only by a stopped/synthetic game loop (the
 * deterministic test harness) does not necessarily tick its tween manager,
 * the executor also arms a Clock watchdog via `scene.time.delayedCall` at
 * `plan.completionDelayMs + MINI_BOSS_SWEEP_COMPLETION_MARGIN_MS` — the
 * explicit "burst lifespan + stagger" timer the intake sanctions. Whichever
 * arrives first completes the sweep (exactly once); the watchdog is always
 * scheduled *after* the last burst's scheduled end, so a running display
 * never completes mid-animation.
 */
export function spawnMiniBossDeathSweep(
  scene: MiniBossSweepScene | null | undefined,
  input: MiniBossSweepPlanInput,
  options: MiniBossDeathSweepOptions = {},
): MiniBossDeathSweepHandle {
  const plan = planMiniBossDeathSweep(input);
  const explosions: ExplosionHandle[] = [];
  let finished = 0;
  let destroyed = false;
  let done = false;
  let timer: { remove(dispatchCallback?: boolean): void } | null = null;

  /** Completes the sweep exactly once (shared by both real completion signals). */
  const completeSweep = (): void => {
    if (destroyed || done) return;
    done = true;
    timer?.remove(false);
    timer = null;
    options.onComplete?.();
  };

  const notifyIfComplete = (): void => {
    if (destroyed || done) return;
    if (finished >= plan.bursts.length) completeSweep();
  };

  for (let i = 0; i < plan.bursts.length; i += 1) {
    const burst = plan.bursts[i];
    const handle = spawnExplosionParticles(
      scene,
      burst.x,
      burst.y,
      burst.color,
      burst.size,
      {
        patterns: ['radial'],
        count: burst.particleCount,
        lifespan: burst.lifespanMs,
        delay: burst.delayMs,
        scale: burst.scale,
        seed: (input.seed + i * 0x9e3779b1) >>> 0,
        onComplete: () => {
          finished += 1;
          notifyIfComplete();
        },
      },
    );
    if (handle) {
      explosions.push(handle);
    } else {
      // Missed spawn (missing scene) — count it so a partial display can
      // still reach completion deterministically.
      finished += 1;
    }
  }

  // Completion watchdog: an explicit lifespan + stagger timer, never a frame
  // count (a paused scene freezes it exactly like the burst tweens, so it can
  // never race ahead of the display).
  const timerHandle = scene?.time?.delayedCall(
    plan.completionDelayMs + MINI_BOSS_SWEEP_COMPLETION_MARGIN_MS,
    () => {
      timer = null;
      completeSweep();
    },
  );
  if (timerHandle && typeof (timerHandle as { remove?: unknown }).remove === 'function') {
    timer = timerHandle as { remove(dispatchCallback?: boolean): void };
  }

  // Every burst reported its own completion while the loop was spawning (a
  // zero-particle burst finishes on spawn): complete without waiting.
  notifyIfComplete();

  return {
    plan,
    explosions,
    get complete(): boolean {
      return done;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      timer?.remove(false);
      timer = null;
      for (const explosion of explosions) {
        explosion.destroy();
      }
    },
  };
}
