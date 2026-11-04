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
 * It is **not** silent, though: the display is also the level's biggest audio
 * moment. Every planned burst that passes the per-role thinning rule schedules
 * its matching explosion cue at the burst's own `delayMs`; the mini-boss's own
 * body plays its one boss-scale death cue from the entity's shared death seam
 * (never doubled here — see the executor's note). The palette is
 * **reuse-only** (producer decision Q1 = a): `enemy` / `scatter` / `anchored`
 * bursts reuse the shared enemy-destruction cue, `finale` bursts use the
 * victory-explosion boom and the body uses the boss-destruction boom — no new
 * ToneForge recipe, asset or manifest entry. See
 * {@link playMiniBossSweepSound} for the dispatch and
 * [docs/AUDIO_TONEFORGE_CUE_MAPPING.md](../../../docs/AUDIO_TONEFORGE_CUE_MAPPING.md)
 * for the palette record.
 *
 * ## Sweep audio density policy (AC2)
 *
 * A scripted 60-burst cascade voiced one-for-one would be a clipped wall, so
 * the planner makes the audio decision **per burst** and this module owns the
 * only tunables:
 *
 * - **Per-role thinning** — `MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N` (1) keeps
 *   every escort burst, `..._SCATTER_EVERY_N` (2) and `..._ANCHORED_EVERY_N`
 *   (2) keep one in every two celebration bursts, and `..._FINALE_EVERY_N` (1)
 *   keeps **both** voices of every finale pair so the climax is never thinned.
 * - **Per-role volume scales** — `MINI_BOSS_SWEEP_SFX_*_VOLUME`, trimmed
 *   against the shared destruction cues; the finale is the loudest per-burst
 *   layer so the 20-burst climax still reads as the biggest beat.
 * - **Timing** — every cue is scheduled at its burst's own `delayMs`
 *   (producer decision Q3 = a, **visual-timed**). The sweep deliberately does
 *   **not** route through the shared 16th-note accent grid used by ordinary
 *   enemy kills (`playExplosionCue`), because quantising would shift cues up
 *   to 187.5 ms off their bursts and the 4-per-tick accent cap would drop most
 *   of the cascade. This is the one documented divergence from the accent
 *   grid, and it is why the cue layer's explicit-`delay` bypass exists.
 * - **Mix backstop** — the shared per-cue voice limiter
 *   (`MAX_CONCURRENT_CUE_VOICES` 4 / `CUE_VOICE_WINDOW_MS` 150) stays in place
 *   and unchanged. It caps *immediate* cue bursts (a mass kill); a
 *   caller-scheduled cascade is admitted up-front, which is why the plan
 *   itself is bounded and pinned: no plan for the 60-burst maximum dispatches
 *   more than `MINI_BOSS_SWEEP_SFX_MAX_PER_WINDOW` cues inside any
 *   `MINI_BOSS_SWEEP_SFX_WINDOW_MS` (250 ms) window, asserted by
 *   `miniBossDeathSweep.test.ts`.
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
 *   the captured mini-boss death position;
 * - `MINI_BOSS_SWEEP_FINALE_COUNT` (20) **finale** bursts clustered in and
 *   around the death position, fired in pairs — two every
 *   `MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS` (250 ms) — so the mini-boss's
 *   own death reads as the biggest explosion on screen (producer review on
 *   AH-0MVOFGB6K003YD0Z: "Cluster another 20 explosions in and around the
 *   mini-boss, with 2 going off every 0.25 of a second").
 *
 * Total bursts `n + max(0, 30 - n) + 10 + 20`; for the realistic `n <= 30`
 * case that is `<= 60`, and above that the extras clamp to 0 so the sweep is
 * one enemy burst per target plus the 30 mini-boss bursts. Extras, anchored
 * and finale bursts use a reduced particle count so the whole display stays
 * inside the particle budget.
 */

import {
  createRng,
  spawnExplosionParticles,
  type ExplosionHandle,
  type ExplosionScene,
} from '../../vfx/explosionParticles';
import {
  playMiniBossSweepSound,
  type MiniBossSweepSoundCueName,
} from '../../audio/effects';
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

/**
 * Additional mini-boss **finale** bursts, on top of the anchored set.
 * Producer review (AH-0MVOFGB6K003YD0Z): "Cluster another 20 explosions in
 * and around the mini-boss, with 2 going off every 0.25 of a second."
 */
export const MINI_BOSS_SWEEP_FINALE_COUNT = 20;

/** Finale cadence: bursts are scheduled in pairs (2 per interval). */
export const MINI_BOSS_SWEEP_FINALE_PAIR_SIZE = 2;

/** Interval (ms) between finale pairs — 2 bursts every 0.25 s. */
export const MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS = 250;

/**
 * Delay (ms) before the first finale pair starts: the finale follows the
 * anchored celebration rather than competing with it, so the display builds
 * to the mini-boss's biggest burst at the end.
 */
export const MINI_BOSS_SWEEP_FINALE_START_MS =
  MINI_BOSS_SWEEP_ANCHOR_START_MS + MINI_BOSS_SWEEP_ANCHOR_WINDOW_MS + 10;

/**
 * Radius (px) around the death point the finale pairs scatter within —
 * wider than the anchored cluster so the bursts read as "in and around" the
 * mini-boss.
 */
export const MINI_BOSS_SWEEP_FINALE_SPREAD_PX = 160;

/** Particle count per finale burst (denser than anchored: the biggest hit). */
export const MINI_BOSS_SWEEP_FINALE_PARTICLES = 20;

/** Geometry scale for finale bursts (larger than anchored). */
export const MINI_BOSS_SWEEP_FINALE_SCALE = 1.2;

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

// ── Explosion SFX tunables (AC2/AC3) ──────────────────────────────
//
// Every audio knob of the sweep lives here and nowhere else (producer user
// story: "named, tunable constants in one shared place"). The planner reads
// them, the executor reads them, and no call site carries an inline tuning
// literal.

/** Master switch for the sweep's SFX (default on). */
export const MINI_BOSS_SWEEP_SFX_ENABLED = true;

/** Cue family for `enemy` / `scatter` / `anchored` bursts (reuse-only, Q1=a). */
export const MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE: MiniBossSweepSoundCueName =
  'playDestructionSound';

/** Cue for the `finale` bursts — the victory-explosion boom (Q1=a). */
export const MINI_BOSS_SWEEP_SFX_FINALE_CUE: MiniBossSweepSoundCueName =
  'playVictoryExplosionSound';

/** Every `enemy` (escort) burst is voiced — thinning stride 1. */
export const MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N = 1;

/** One in every two `scatter` bursts is voiced (thinning stride 2). */
export const MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N = 2;

/** One in every two `anchored` bursts is voiced (thinning stride 2). */
export const MINI_BOSS_SWEEP_SFX_ANCHORED_EVERY_N = 2;

/**
 * Every `finale` burst is voiced — both voices of every pair, so the climax is
 * never thinned (the display's biggest beat must not lose a voice).
 */
export const MINI_BOSS_SWEEP_SFX_FINALE_EVERY_N = 1;

/**
 * Per-role mix trims for the sweep's explosion cues. The display is dense (a
 * scripted cascade of up to 60 bursts), so each cue is trimmed against the
 * shared destruction/boss cues rather than playing them at full kill volume.
 */
export const MINI_BOSS_SWEEP_SFX_ENEMY_VOLUME = 0.55;
/** Mix trim for the scattered celebration bursts. */
export const MINI_BOSS_SWEEP_SFX_SCATTER_VOLUME = 0.3;
/** Mix trim for the bursts anchored on the death point. */
export const MINI_BOSS_SWEEP_SFX_ANCHORED_VOLUME = 0.4;
/** Mix trim for the finale pairs — the mini-boss's biggest beat (loudest). */
export const MINI_BOSS_SWEEP_SFX_FINALE_VOLUME = 0.65;
/**
 * Window (ms) the density bound is expressed over — the audible overlap of the
 * short baked explosion cues, and the same order as the shared per-cue voice
 * window.
 */
export const MINI_BOSS_SWEEP_SFX_WINDOW_MS = 250;

/**
 * Documented density bound (AC2): the maximum number of kept cues any plan for
 * the **60-burst maximum** may dispatch inside a
 * {@link MINI_BOSS_SWEEP_SFX_WINDOW_MS} window.
 *
 * Derived from the shipping schedule with the per-role strides above, over
 * every plan size `n ∈ [0, 30]` (the range in which the total stays at or
 * below 60 bursts). The worst case is `n = 30` — 30 escort bursts staggered
 * over `MINI_BOSS_SWEEP_ENEMY_WINDOW_MS` (360 ms) on top of the anchored
 * celebration — where a window straddling the enemy cascade and the first
 * anchored/finale beats holds 27 kept cues. Escalating any of the volume
 * scales or dropping a stride to 1 raises this number: re-derive it and update
 * this constant (and the pinning test) together.
 */
export const MINI_BOSS_SWEEP_SFX_MAX_PER_WINDOW = 27;

/**
 * Seed salt for the sweep's audio-decision RNG stream. The variant draws are
 * taken from a stream *separate* from the placement RNG, so adding audio can
 * never shift a single burst position (the display stays byte-identical to
 * the shipped sweep for a given seed).
 */
export const MINI_BOSS_SWEEP_SFX_SEED_SALT = 0x85eb_ca6b;

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

/**
 * The sweep's per-burst audio decision (AC1/AC2/AC3/AC5). Pure data: the
 * planner decides the cue, the baked-variant draw, the mix trim and whether
 * the thinning rule keeps the burst voiced — the executor only dispatches it.
 */
export interface MiniBossSweepBurstAudio {
  /** Cue the burst plays (reuse-only palette, Q1 = a). */
  cue: MiniBossSweepSoundCueName;
  /**
   * Run-seeded draw in `[0, 1)` selecting one of the cue's baked variants, so
   * the same run seed replays the same audio (AC5).
   */
  variantPick: number;
  /** Per-role mix trim ({@link MINI_BOSS_SWEEP_SFX_ENEMY_VOLUME} etc.). */
  volume: number;
  /**
   * Whether the per-role thinning rule keeps this burst voiced (AC1/AC2). A
   * dropped burst is silent **only** because of this rule; no other reason
   * exists for a planned burst to go unvoiced.
   */
  kept: boolean;
}

/** A planned burst (pure data — no Phaser objects). */
export interface MiniBossSweepBurst {
  /** Which sweep part the burst belongs to. */
  role: 'enemy' | 'scatter' | 'anchored' | 'finale';
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
  /** The burst's audio decision (cue, baked-variant draw, volume, kept). */
  audio: MiniBossSweepBurstAudio;
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
  /** Number of finale bursts (always `MINI_BOSS_SWEEP_FINALE_COUNT`). */
  finale: number;
  /** Delay (ms) after which the last burst has finished animating. */
  completionDelayMs: number;
}

/** Optional overrides for {@link spawnMiniBossDeathSweep}. */
export interface MiniBossDeathSweepOptions {
  /** Fires exactly once, after every burst has finished animating. */
  onComplete?: () => void;
  /**
   * Whether the sweep schedules its SFX (default
   * {@link MINI_BOSS_SWEEP_SFX_ENABLED}). When `false` the display rights
   * play, nothing is dispatched and completion is unaffected (AC5/AC9).
   */
  soundEnabled?: boolean;
  /**
   * Per-cue sound dispatcher (test seam / custom audio routing). Receives one
   * request per dispatched cue — the mini-boss's own body first, then every
   * kept burst at its own delay — and defaults to
   * {@link MINI_BOSS_SWEEP_DEFAULT_SOUND_PLAYER}, gated by `soundEnabled`.
   * A throwing seam never affects the display or `onComplete` (AC9).
   */
  playSound?: MiniBossSweepSoundPlayer;
}

/**
 * One cue the sweep dispatches: a kept burst, at the moment its visual plays.
 */
export interface MiniBossSweepSoundRequest {
  /** The burst's role (which sweep layer the cue belongs to). */
  role: MiniBossSweepBurst['role'];
  /** Cue to play (reuse-only palette). */
  cue: MiniBossSweepSoundCueName;
  /** Scheduled offset (ms) from sweep start — the burst's own `delayMs`. */
  delayMs: number;
  /** Mix trim for this cue. */
  volume: number;
  /** Run-seeded baked-variant draw (AC5). */
  variantPick?: number;
}

/**
 * Per-cue sound player seam: dispatches one sweep cue. Injectable for tests
 * and custom audio routing, so a suite can record the whole audio timeline
 * without audio hardware (AC5).
 */
export type MiniBossSweepSoundPlayer = (
  request: MiniBossSweepSoundRequest,
) => void;

/**
 * Default cue dispatcher: routes one sweep cue to the shared audio layer
 * ({@link playMiniBossSweepSound}) at the burst's own delay. Safe no-op
 * without an `AudioContext`, like every cue (AC5).
 */
export const MINI_BOSS_SWEEP_DEFAULT_SOUND_PLAYER: MiniBossSweepSoundPlayer = (
  request,
) => {
  playMiniBossSweepSound(request.cue, {
    delay: Math.max(0, request.delayMs) / 1000,
    volume: request.volume,
    variantPick: request.variantPick,
  });
};

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

/**
 * Staggers `count` bursts in groups of `pairSize`, one group every
 * `intervalMs`, starting at `startMs` — the finale cadence (two bursts every
 * 0.25 s), so each pair reads as one heavier beat in the display.
 */
function pairedDelays(
  count: number,
  pairSize: number,
  startMs: number,
  intervalMs: number,
): number[] {
  const safePairSize = Math.max(1, Math.floor(pairSize));
  return Array.from(
    { length: Math.max(0, count) },
    (_unused, i) => startMs + Math.floor(i / safePairSize) * intervalMs,
  );
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
 * - `finale` bursts: exactly `MINI_BOSS_SWEEP_FINALE_COUNT` samples within
 *   `MINI_BOSS_SWEEP_FINALE_SPREAD_PX` of the death position, scheduled in
 *   pairs two every `MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS` after the
 *   anchored window.
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

  // Geometry first (positions/colours draw from the placement RNG), then the
  // audio decision in a second pass so the two streams never interfere.
  const planned: Array<Omit<MiniBossSweepBurst, 'audio'>> = [];

  // Enemy bursts — cascade starts immediately, staggered over a short window.
  const enemyDelays = staggerDelays(n, 0, MINI_BOSS_SWEEP_ENEMY_WINDOW_MS);
  for (let i = 0; i < n; i += 1) {
    const target = targets[i];
    planned.push({
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
    planned.push({
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
    planned.push({
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

  // Finale bursts — the mini-boss's own biggest explosion: 20 clustered
  // bursts fired in pairs, two every 250 ms, starting once the anchored
  // celebration has swept past the death point.
  const finaleDelays = pairedDelays(
    MINI_BOSS_SWEEP_FINALE_COUNT,
    MINI_BOSS_SWEEP_FINALE_PAIR_SIZE,
    MINI_BOSS_SWEEP_FINALE_START_MS,
    MINI_BOSS_SWEEP_FINALE_PAIR_INTERVAL_MS,
  );
  for (let i = 0; i < MINI_BOSS_SWEEP_FINALE_COUNT; i += 1) {
    const { x, y } = anchoredPosition(
      deathX,
      deathY,
      MINI_BOSS_SWEEP_FINALE_SPREAD_PX,
      rng,
    );
    planned.push({
      role: 'finale',
      delayMs: finaleDelays[i],
      x,
      y,
      color: MINI_BOSS_SWEEP_PALETTE[Math.floor(rng() * MINI_BOSS_SWEEP_PALETTE.length)],
      size: 18,
      particleCount: MINI_BOSS_SWEEP_FINALE_PARTICLES,
      scale: MINI_BOSS_SWEEP_FINALE_SCALE,
      lifespanMs: MINI_BOSS_SWEEP_LIFESPAN_MS,
    });
  }

  const bursts = applySweepAudio(planned, seed);

  const completionDelayMs = planned.reduce(
    (latest, burst) => Math.max(latest, burst.delayMs + burst.lifespanMs),
    0,
  );

  return {
    bursts,
    sweptCount: n,
    extras,
    anchored: MINI_BOSS_SWEEP_ANCHORED_COUNT,
    finale: MINI_BOSS_SWEEP_FINALE_COUNT,
    completionDelayMs,
  };
}

// ── Planner: per-burst audio decision ─────────────────────────────

/**
 * The per-role thinning stride (how many bursts of a role share one voice).
 *
 * `1` voices every burst of that role; `2` voices one in every two. Exported
 * as a table so the rule is one declarative lookup rather than a switch that
 * can drift from the tunables.
 */
const MINI_BOSS_SWEEP_SFX_EVERY_N: Readonly<
  Record<MiniBossSweepBurst['role'], number>
> = {
  enemy: MINI_BOSS_SWEEP_SFX_ENEMY_EVERY_N,
  scatter: MINI_BOSS_SWEEP_SFX_SCATTER_EVERY_N,
  anchored: MINI_BOSS_SWEEP_SFX_ANCHORED_EVERY_N,
  finale: MINI_BOSS_SWEEP_SFX_FINALE_EVERY_N,
};

/** The per-role mix trim table (same shape as the thinning table). */
const MINI_BOSS_SWEEP_SFX_VOLUME: Readonly<
  Record<MiniBossSweepBurst['role'], number>
> = {
  enemy: MINI_BOSS_SWEEP_SFX_ENEMY_VOLUME,
  scatter: MINI_BOSS_SWEEP_SFX_SCATTER_VOLUME,
  anchored: MINI_BOSS_SWEEP_SFX_ANCHORED_VOLUME,
  finale: MINI_BOSS_SWEEP_SFX_FINALE_VOLUME,
};

/**
 * Attaches the audio decision to every planned burst (pure, deterministic).
 *
 * Per burst, from its `role` and its **intra-role index**:
 *
 * - `cue` — {@link MINI_BOSS_SWEEP_SFX_FINALE_CUE} for `finale`, otherwise
 *   {@link MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE} (reuse-only palette, Q1 = a).
 * - `variantPick` — a run-seeded draw in `[0, 1)` taken from a stream salted
 *   off the run seed ({@link MINI_BOSS_SWEEP_SFX_SEED_SALT}), so the same seed
 *   replays the same baked variant and placement is untouched (AC5).
 * - `volume` — the role's mix trim.
 * - `kept` — the per-role thinning rule: burst `i` of a role is voiced when
 *   `i % everyN === 0`. This is the **only** reason a planned burst is silent
 *   (AC1), and `finale` has stride `1`, so the climax is never thinned (AC2).
 *
 * The stride is applied to the burst's **own role counter**, not its index in
 * the plan, so dropping voices never shifts which bursts of another role are
 * voiced.
 */
function applySweepAudio(
  planned: readonly Omit<MiniBossSweepBurst, 'audio'>[],
  seed: number,
): MiniBossSweepBurst[] {
  const sfxRng = createRng((seed ^ MINI_BOSS_SWEEP_SFX_SEED_SALT) >>> 0);
  const roleIndex: Record<MiniBossSweepBurst['role'], number> = {
    enemy: 0,
    scatter: 0,
    anchored: 0,
    finale: 0,
  };

  return planned.map((burst) => {
    const index = roleIndex[burst.role];
    roleIndex[burst.role] = index + 1;
    const everyN = Math.max(1, Math.floor(MINI_BOSS_SWEEP_SFX_EVERY_N[burst.role]));
    const cue =
      burst.role === 'finale'
        ? MINI_BOSS_SWEEP_SFX_FINALE_CUE
        : MINI_BOSS_SWEEP_SFX_DESTRUCTION_CUE;
    return {
      ...burst,
      audio: {
        cue,
        variantPick: sfxRng(),
        volume: MINI_BOSS_SWEEP_SFX_VOLUME[burst.role],
        kept: index % everyN === 0,
      },
    };
  });
}

// ── Thin Phaser executor ──────────────────────────────────────────

/**
 * Plays a planned sweep on the given scene: every burst is dispatched through
 * `spawnExplosionParticles` (honouring `delayMs`/`lifespanMs`/`count`/`scale`)
 * and each burst's completion is counted; `options.onComplete` fires exactly
 * once — only after every burst has finished animating, never on the spawn
 * frame and never on an explicit `destroy()` teardown (parent AC3).
 *
 * The **audio** for the cascade is dispatched from this one seam too (never
 * from a scene), so `PlayScene` and `GymMiniBoss` are identical in what the
 * sweep sounds like (AC4): one cue per burst the thinning rule **kept**,
 * scheduled at that burst's own `delayMs` so the audio lands with its visual
 * (AC1 / Q3 = a).
 *
 * The mini-boss's **own body** cue (`playBossDestructionSound()`) is *not*
 * dispatched here: it belongs to the entity's shared death seam, which already
 * plays it exactly once on the killing blow (`Boss.takeDamage` in the game and
 * the gym's DAMAGE control, `Boss.playDestructionAudio()` for the gym's
 * EXPLODE). Re-dispatching it from the sweep would double the boom on every
 * kill, which "exactly once" forbids — so the sweep deliberately stays out of
 * it.
 *
 * Every dispatch happens synchronously on the spawn frame — the audio layer
 * holds the schedule — so no cue can fire after the display ends, and the
 * dispatch is fire-and-forget: it never affects completion ordering, and a
 * throwing player seam is swallowed so `onComplete` still fires exactly once
 * (AC9). `soundEnabled: false` dispatches nothing at all (AC5).
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
  const soundEnabled = options.soundEnabled ?? MINI_BOSS_SWEEP_SFX_ENABLED;
  const playSound = options.playSound ?? MINI_BOSS_SWEEP_DEFAULT_SOUND_PLAYER;
  /**
   * Dispatches one cue, swallowing any failure from the player seam: the
   * display is cosmetic and must never be broken — nor have its `onComplete`
   * delayed — by audio (AC9).
   */
  const dispatchSound = (request: MiniBossSweepSoundRequest): void => {
    if (!soundEnabled) return;
    try {
      playSound(request);
    } catch {
      // Audio is best-effort: a broken audio layer must never break the sweep.
    }
  };
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

    // Every kept burst schedules its matching explosion cue at its own delay,
    // so audio lands with the burst it belongs to (AC1). Fire-and-forget: the
    // cue never affects completion, and a dropped burst (thinning rule) never
    // produces one.
    if (burst.audio.kept) {
      dispatchSound({
        role: burst.role,
        cue: burst.audio.cue,
        delayMs: burst.delayMs,
        volume: burst.audio.volume,
        variantPick: burst.audio.variantPick,
      });
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
