/**
 * Hold-full overlay metronome scheduler (AH-0MV55O9R5005W6J0).
 *
 * When the hold-full power-up choice opens, `PlayScene`/gym launchers pause
 * the owning scene at the SceneManager level, which freezes the shared beat
 * clock (the paused scene stops calling `advance`). The silence breaks the
 * run's rhythmic feel. This module supplies the shared, deterministic piece
 * of the fix: a **pure metronome scheduler** that, given the frozen
 * game-time at overlay open, each currently active player weapon's grid
 * interval and the elapsed overlay time, emits on-grid ghost ticks — the
 * fire cues continue at a reduced volume with **no projectiles and no
 * gameplay simulation**.
 *
 * Every ghost tick is derived from `src/utils/beat.ts` grid maths, never a
 * wall-clock read, so the game, every gym and the tests share one grid:
 * - AC1 — each active weapon cues at its exact beat-grid interval;
 * - AC2 — only the supplied active player weapons emit (no enemy cues);
 * - AC3 — the first ghost tick lands on the beat tick the next real shot
 *   would have used (phase preserved) and every subsequent tick stays on
 *   the same grid.
 *
 * The launcher builds a {@link HoldFullFireSchedule} from the shared
 * `Player.getActiveWeapons()` / `getFireInterval` / `getBeatClock` seams
 * ({@link buildHoldFullFireSchedule}) and passes it to `MineralChoiceScene`
 * as its `fireSchedule` launch payload; the overlay drives the metronome
 * each frame with its own elapsed time. The single shared implementation is
 * consumed identically by `PlayScene` and every gym launcher (AGENTS.md
 * gym↔game parity).
 */

import { nextTick } from '../../utils/beat';
import type { WeaponId } from '../../utils/weapons';

// ── Types ───────────────────────────────────────────────────────────

/** One active player weapon's ghost-fire cadence. */
export interface HoldFullWeaponSchedule {
  /** Active player weapon id (cannon or a collected timed weapon). */
  weaponId: WeaponId;
  /** This weapon's fire interval in ms (its subdivision of the beat). */
  intervalMs: number;
}

/**
 * The frozen fire schedule captured when the overlay opens: the grid the
 * player was firing on (anchor + tempo) at the exact game-time the scene
 * paused, plus every currently active weapon's interval.
 */
export interface HoldFullFireSchedule {
  /** Grid origin in ms (the shared beat clock's anchor). */
  anchorMs: number;
  /**
   * Tempo in beats per minute for the shared beat grid — one beat of the
   * 3-2-1 restart countdown (AH-0MV55OAQT004NMSN). Mirrors the beat clock
   * that produced the schedule.
   */
  bpm: number;
  /**
   * Frozen game-time (ms) when the overlay opened — `beatClock.now()` at
   * launch. The metronome continues the grid from here, so the first ghost
   * tick is the tick the next real shot would have used (AC3).
   */
  startMs: number;
  /** Active player weapons and their per-weapon intervals (AC2). */
  weapons: HoldFullWeaponSchedule[];
}

/** The minimal player surface the schedule builder needs (shared seam). */
export interface HoldFullFirePlayerSource {
  getActiveWeapons(): WeaponId[];
  getFireInterval(weaponId: WeaponId): number;
  getBeatClock(): { now(): number; anchorMs: number; bpm: number };
}

// ── Tunables / grid constants ───────────────────────────────────────

/** Epsilon (ms) for grouping a tick that has just been reached. */
const METRONOME_EPSILON_MS = 1e-6;

// ── Metronome ───────────────────────────────────────────────────────

/**
 * A deterministic hold-full fire metronome. It holds a per-weapon
 * accumulator of the *next due ghost tick* (an absolute grid time derived
 * from {@link nextTick}) plus an overlay-relative elapsed clock; every
 * {@link HoldFullFireMetronome.advance} crosses reached ticks and returns
 * the weapons due (a weapon may appear more than once when one advance
 * crosses several of its ticks). It never touches audio, projectiles or
 * gameplay — it only answers "which weapons should cue now".
 */
export interface HoldFullFireMetronome {
  /**
   * Advances the metronome by `dtMs` of overlay time and returns the
   * weapons whose ghost tick has been reached. A non-positive or
   * non-finite delta is a no-op (time never runs backwards).
   */
  advance(dtMs: number): WeaponId[];
  /** Total overlay-relative elapsed time (ms) accumulated so far. */
  elapsedMs(): number;
  /**
   * The absolute grid time of the next due ghost tick for `weaponId`, or
   * `undefined` when the weapon is not in the schedule.
   */
  nextTickMs(weaponId: WeaponId): number | undefined;
  /**
   * The absolute grid time of the most recently emitted ghost tick for
   * `weaponId`, or `undefined` before its first emission.
   */
  lastTickMs(weaponId: WeaponId): number | undefined;
}

/**
 * Creates a {@link HoldFullFireMetronome} for *schedule*. Each weapon's
 * first ghost tick is `nextTick(startMs, interval)` — the beat tick the
 * next real shot would have used — except when `startMs` itself is already
 * exactly on that weapon's grid: the player fires on grid ticks, so a
 * freeze exactly on a tick means that tick already fired and the next real
 * shot is one interval later (no doubled ghost).
 *
 * @param schedule - The frozen schedule captured at overlay open.
 * @returns A fresh, deterministic metronome at overlay elapsed time 0.
 */
export function createHoldFullFireMetronome(
  schedule: HoldFullFireSchedule,
): HoldFullFireMetronome {
  const { anchorMs, startMs, weapons } = schedule;
  let elapsedMs = 0;

  // next due absolute grid tick per weapon, seeded phase-locked to the beat
  // the player is on (AC3).
  const nextDue = new Map<WeaponId, number>();
  const lastTick = new Map<WeaponId, number>();
  for (const weapon of weapons) {
    let due = nextTick(startMs, weapon.intervalMs, anchorMs);
    // A freeze exactly on a tick: that tick already fired (the player fires
    // on grid ticks), so the next real shot is one interval later.
    if (due === startMs) due += weapon.intervalMs;
    nextDue.set(weapon.weaponId, due);
  }

  return {
    advance(dtMs: number): WeaponId[] {
      if (!Number.isFinite(dtMs) || dtMs <= 0) return [];
      elapsedMs += dtMs;
      const nowAbs = startMs + elapsedMs;
      const due: WeaponId[] = [];
      for (const weapon of weapons) {
        const id = weapon.weaponId;
        let dueTick = nextDue.get(id) ?? 0;
        while (dueTick <= nowAbs + METRONOME_EPSILON_MS) {
          due.push(id);
          lastTick.set(id, dueTick);
          dueTick += weapon.intervalMs;
        }
        nextDue.set(id, dueTick);
      }
      return due;
    },
    elapsedMs: () => elapsedMs,
    nextTickMs: (weaponId: WeaponId) => nextDue.get(weaponId),
    lastTickMs: (weaponId: WeaponId) => lastTick.get(weaponId),
  };
}

/**
 * Captures the hold-full fire schedule from a launcher's live player: every
 * currently active weapon (cannon + each collected timed weapon) with its
 * current grid interval, plus the frozen beat-clock time/anchor at the
 * moment the overlay opens. Shared by `PlayScene.openMineralChoice` and
 * `GymFormationScene.openMineralChoice` so the game and every gym build an
 * identical payload (AGENTS.md gym↔game parity).
 *
 * @param player - The active `Player` (or equivalent structural source).
 * @returns The frozen schedule, or `null` when the player is unavailable.
 */
export function buildHoldFullFireSchedule(
  player: HoldFullFirePlayerSource | null | undefined,
): HoldFullFireSchedule | null {
  if (!player) return null;
  const clock = player.getBeatClock();
  return {
    anchorMs: clock.anchorMs,
    bpm: clock.bpm,
    startMs: clock.now(),
    weapons: player.getActiveWeapons().map((weaponId) => ({
      weaponId,
      intervalMs: player.getFireInterval(weaponId),
    })),
  };
}
