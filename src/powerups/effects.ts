/**
 * Active power-up effects registry (GDD §4.4).
 *
 * Engine-agnostic state for power-ups P3–P9 after collection, aggregated
 * for the standalone HUD (`src/ui/HUD.ts`) and by the combat gym for
 * hit-response. Non-combat (P5/P8/P9) are always available; combat-coupled
 * (P3/P4/P6/P7) are exercised by the GymPowerUpsCombat scene with live
 * scout threats (AH-0MTC2P6G3007PJ40).
 *
 * ## Single run-scoped level model (AH-0MUV5CLW6005VF7K)
 *
 * The registry no longer keeps its own lives/stack/charge counters. It
 * consumes the **one** run-scoped {@link PowerUpLevelStore} owned by the
 * player (producer decision Q1=A): every scene injects the player's store
 * through {@link EffectsRegistry.setStore}/{@link EffectsRegistry.setStoreResolver},
 * and {@link EffectsRegistry.applyCollect} calls `store.collect(...)` as the
 * single mutation point. Since AH-0MUX802450085VZZ the store splits each
 * item's level into a **permanent** component (hold-full rewards only) and a
 * **temporary** component (field pickups); the registry clears the temporary
 * component when the item's timed window expires, so a field pickup's level
 * reverts to the permanent level (or the item becomes inactive). Effect strengths (durations, the P5 multiplier,
 * caps) are resolved from the catalogue via `store.stats(...)` rather than
 * raw tuning constants, so balance intent cannot drift between scenes
 * (AC1/AC2/AC3). `P9_MAGNET_DURATION` / `P10_SCOOP_DURATION` are the only
 * non-levelled effect constants that remain: the P9/P10 **field-pickup**
 * timed duration is not a catalogue axis (documented, AC2).
 *
 * - **P5 Speed Boost** — timed: `speedMultiplier` movement speed and
 *   fire-rate for `speedDuration` seconds (both use the same level-resolved
 *   multiplier); re-collecting refreshes the timer to full duration (never
 *   additive).
 * - **P8 Extra Life** — immediate: adds the level-resolved `lifeGain`,
 *   clamped to the level-resolved `livesCap` (base 3 start, cap 5).
 * - **P9 Magnet** — attracts nearby drops: a timed 15 s effect when
 *   collected as a field drop (refresh-only, never stacking), or a
 *   permanent stacking effect when granted as a hold-full reward.
 *   Shares the P9/P10 attraction radius curve (base 1× ship size, +50%/stack).
 * - **P10 Mineral Scoop** — attracts nearby minerals: a timed 15 s effect
 *   when collected as a field drop (refresh-only, never stacking), or a
 *   permanent stacking effect when granted as a hold-full reward.
 *   Shares the P9 attraction radius curve (base 1× ship size, +50%/stack).
 * - **P3 Shield** — timed `shieldDuration` bubble; absorbs the level-resolved
 *   `shieldAbsorptions` hits (base 1, cap 3) before popping, refreshing the
 *   bubble and its remaining-hit count on re-collect before expiry. The
 *   remaining absorptions are run-scoped registry state, cleared by
 *   `reset()` and surfaced to the HUD via `activeEffects()` (`stacks`).
 *   Because a field pickup's level is **temporary** (AH-0MUX802450085VZZ),
 *   the bubble's expiry clears the temporary level (reverting to the
 *   permanent level, if any); a hold-full reward grants a permanent shield
 *   that never expires (AH-0MUVM9RAO004Y3LB).
 * - **P4 Bomb** — ranged periodic clear (AH-0MUVM9RAO004Y3LB): the model
 *   exposes `bombRange` (px) and `bombFrequency` (pulses/s); the effect path
 *   clears on-screen enemy bullets within the resolved range (a single pulse
 *   for a field pickup, an immediate-then-periodic pulse when permanent),
 *   without damaging 1-HP enemies (GDD §4.4).
 * - **P6 Phase Shift** — charge-based auto-trigger (parent
 *   AH-0MUIYX1EE008FVS8). Collecting P6 stores the level-resolved
 *   `phaseCharges` auto-activation charges (or grants unlimited activations
 *   for the hold-full reward); the shared combat core calls
 *   {@link EffectsRegistry.updateDanger} each frame and the registry
 *   activates a `phaseDuration` pass-through the moment the player is in
 *   real danger and a charge is available. After expiry it re-arms only once
 *   danger has cleared and a short cooldown has elapsed (Q2/Q3).
 * - **P7 Teleport** — stored FIFO stacks (no timer); Space consumes one use
 *   and grants P6 Phase Shift for `teleportPhaseDuration` at the landing
 *   spot without consuming an auto-activation charge (Q6). Safe-spot
 *   resolution is the scene's responsibility; this module tracks only the
 *   stored count.
 *
 * The registry is pure (no Phaser imports). The scene layers
 * movement/ship integration, bullet clearing, hit-response and teleport
 * teleportation on top of it.
 */

import {
  PowerUpId,
  PowerUpType,
  getPowerUpById,
} from './types';
import {
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
  PHASE_REARM_COOLDOWN,
} from '../core/constants';
import {
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  type PowerUpLevelStats,
} from './powerUpLevels';
import type { WeaponId } from '../utils/weapons';

// Re-export the magnet tuning values for convenience.
export {
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
};

// Re-export weapon type for consumers.
export type { WeaponId };

// ── Non-levelled effect values ──────────────────────────────────────

/**
 * Lives counter initial value (P8 model). Mirrors the store's start so
 * standalone-registry tests and the store agree (AC3).
 */
export const P8_LIVES_START = POWER_UP_LIVES_START;

/**
 * Duration in seconds of the P9 field-pickup drop attraction. **Not a
 * levelled axis** — the P9/P10 field-pickup timed window stays constant
 * while only the permanent stack cap (and hence the attraction radius)
 * levels (AC2).
 */
export const P9_MAGNET_DURATION = 15;

/**
 * Duration in seconds of the P10 field-pickup mineral attraction. **Not a
 * levelled axis**, mirroring {@link P9_MAGNET_DURATION}.
 */
export const P10_SCOOP_DURATION = 15;

/** Duration in seconds for timed weapon effects (GDD §4.4). */
export const WEAPON_EFFECT_DURATION = 10;

// ── Active-effect model (consumed by the HUD) ─────────────────────────

/** A weapon effect entry displayed in the HUD. */
export interface WeaponEffect {
  /** Weapon identifier (e.g. "spread", "dual", "rapid"). */
  weaponId: WeaponId;
  /** Full duration in seconds (timed weapons). */
  duration: number;
  /** Remaining seconds until expiry. */
  remaining: number;
  /** True when the effect was granted permanently for the run (never expires). */
  permanent?: boolean;
}

export interface ActiveEffect {
  /** Power-up ID (e.g. "P5"). */
  id: PowerUpId;
  /** Effect type. */
  type: PowerUpType;
  /** Full duration in seconds (timed types). */
  duration?: number;
  /** Remaining seconds (timed types). */
  remaining?: number;
  /**
   * Stack count (stackable types, e.g. P9 magnet, P7 teleport) or, for the
   * P3 shield, the remaining absorptions before the bubble pops.
   */
  stacks?: number;
  /**
   * True when the effect has unlimited uses for the run (e.g. the hold-full
   * P6 reward). Rendered as an unlimited marker rather than a count.
   */
  permanent?: boolean;
}

/**
 * Applies the P5 speed multiplier live to a movement config: both thrust
 * and max-speed scale by `multiplier`; friction is untouched.
 */
export function applySpeedMultiplier<T extends { thrust: number; maxSpeed: number; friction: number }>(
  config: T,
  multiplier: number,
): T {
  return {
    ...config,
    thrust: config.thrust * multiplier,
    maxSpeed: config.maxSpeed * multiplier,
  };
}

/**
 * Computes the magnet attraction radius for the given ship size and stack
 * count: base 1× ship size, +50% of the base per stack.
 */
export function magnetRadius(shipSize: number, stacks: number): number {
  return (
    MAGNET_RADIUS_BASE_MULTIPLIER *
    shipSize *
    (1 + MAGNET_RADIUS_PER_STACK * stacks)
  );
}

/** Supplies the run-scoped level store the registry should consume. */
export type PowerUpLevelStoreResolver = () => PowerUpLevelStore | null;

// ── Effects registry ────────────────────────────────────────────────

interface TimedEffectState {
  id: PowerUpId;
  type: PowerUpType;
  duration: number;
  /**
   * Remaining seconds. For a non-permanent effect this is the effect's own
   * lifetime; for a permanent effect it is the remaining temporary
   * field-pickup window (0 when none is active).
   */
  remaining: number;
  /** True when the base effect was granted permanently for the run. */
  permanent?: boolean;
  /**
   * True while a field-pickup temporary window is active for this effect.
   * Its expiry clears the store's temporary stacks for the id (the permanent
   * base, if any, stays active). Left false for non-collection timed effects
   * such as the P7-arrival phase, whose expiry must not clear temporary
   * stacks (Resolved decision 4).
   */
  tempWindow?: boolean;
}

/**
 * Tracks all active power-up effects and their state. Call `applyCollect`
 * when a drop is collected, `tick(dt)` each frame (seconds), and read the
 * aggregated model via the accessors (used by the scene and the HUD).
 *
 * Lives/stack/charge state is **delegated** to the injected run-scoped
 * {@link PowerUpLevelStore}; only timing state (active durations, timers,
 * P6 re-arm) lives here.
 */
export class EffectsRegistry {
  private _timed = new Map<PowerUpId, TimedEffectState>();
  /** Active timed weapons: each weapon has its own countdown. */
  private _weapons: Map<WeaponId, WeaponEffect> = new Map();

  // ── P6 auto-trigger timing state (Q2/Q3/Q6) ──────────────────────
  /**
   * Whether danger has cleared since the last auto-trigger. A fresh P6 is
   * armed (`true`); firing latches it off until danger drops below the
   * threshold (Q2).
   */
  private _phaseDangerCleared = true;
  /** Seconds of re-arm cooldown remaining after the last phase expired. */
  private _phaseRearmCooldown = 0;

  // ── P3 shield remaining-absorptions state (AH-0MUVM9RAO004Y3LB) ──
  /**
   * Hits the active P3 shield can still absorb before it pops, resolved from
   * the level store on every collection (base 1, cap 3). Run-scoped: reset()
   * and P3 expiry clear it. Zero means "no shield active".
   */
  private _shieldRemaining = 0;

  // ── P4 bomb pulse state (AH-0MUVM9RAO004Y3LB) ────────────────────
  /**
   * True when a hold-full P4 granted a permanent bomb for the run: it never
   * expires and pulses every {@link bombInterval} seconds. Cleared only by
   * `reset()`.
   */
  private _bombPermanent = false;
  /** Seconds until the next permanent-bomb pulse (unused when not permanent). */
  private _bombPulseTimer = 0;
  /**
   * One-shot pulse request queued by a field pickup: the next
   * {@link updateBomb} fires exactly once and clears it. A field pickup
   * stores no other persistent state (AC1).
   */
  private _bombPulsePending = false;

  // ── Single run-scoped level store (AC1) ──────────────────────────
  /** Private fallback store for standalone use/tests (no scene wiring). */
  private _store: PowerUpLevelStore;
  /**
   * Optional dynamic resolver (e.g. the scene's live player). Consulted on
   * every store access so a respawned player's store is picked up
   * automatically. When it yields `null`, {@link _store} is used.
   */
  private _storeResolver: PowerUpLevelStoreResolver | null = null;

  /**
   * @param store — the run-scoped level store to consume. Defaults to a
   *   private store so the registry is usable standalone (tests); real
   *   scenes inject the player's store via {@link setStore} or
   *   {@link setStoreResolver}.
   */
  constructor(store?: PowerUpLevelStore) {
    this._store = store ?? new PowerUpLevelStore();
  }

  /** Binds the registry to a specific run-scoped level store instance. */
  setStore(store: PowerUpLevelStore): void {
    this._store = store;
    this._storeResolver = null;
  }

  /**
   * Binds the registry to a resolver that yields the current run-scoped
   * store (typically `() => getPlayer()?.getPowerUpLevelStore() ?? null`).
   * Unlike {@link setStore}, the resolver is consulted on every access, so
   * a player respawn/restart is picked up without re-wiring.
   */
  setStoreResolver(resolver: PowerUpLevelStoreResolver | null): void {
    this._storeResolver = resolver;
  }

  /** The level store the registry currently consumes. */
  private get _levelStore(): PowerUpLevelStore {
    return this._storeResolver?.() ?? this._store;
  }

  /**
   * Applies the effect of a collected power-up.
   *
   * Advances the single run-scoped level store by exactly one collection,
   * then applies the registry-local timing state resolved from the new
   * level's stats (AC1/AC2/AC3):
   *
   * - P3/P5: starts the timed `shieldDuration`/`speedDuration`, or refreshes
   *   it to the new full duration if already active.
   * - P4: a field pickup queues a single ranged explosion (no persistent
   *   state); the hold-full reward sets the run-scoped permanent flag and
   *   pulses every resolved interval. The shared combat core performs the
   *   actual clear from these requests (it alone knows the player/bullets).
   * - P6: stores the level-resolved `phaseCharges` (or marks the permanent
   *   reward); the phase itself is applied later by the shared combat core
   *   via `updateDanger`.
   * - P7: the store grants the level-resolved stored teleport uses. No timer.
   * - P8: the store grants the level-resolved lives, clamped to the cap.
   * - P9/P10: a field pickup (no flag) starts the timed refresh-only
   *   attraction; the hold-full reward adds a permanent stack via the store
   *   (hybrid preserved).
   *
   * @param id — the collected power-up.
   * @param permanent — when true, timed effects never expire for the run
   *   (used by the hold-full choice).
   */
  applyCollect(id: PowerUpId, permanent = false): void {
    const store = this._levelStore;
    // The single mutation point: every collection (field or hold-full)
    // advances the level exactly once and derives the grants (AC1/AC3).
    store.collect(id, permanent);
    this._applyTimedEffect(id, permanent, store.stats(id));
  }

  /**
   * Applies the registry-local timing state for a collection, resolving the
   * effect strength from the supplied level stats.
   */
  private _applyTimedEffect(
    id: PowerUpId,
    permanent: boolean,
    stats: PowerUpLevelStats,
  ): void {
    const entry = getPowerUpById(id);
    switch (entry.type) {
      case PowerUpType.SHIELD:
        this._startOrRefreshTimed(
          id,
          entry.type,
          stats.shieldDuration ?? 15,
          permanent,
        );
        // Refresh (never add) the remaining absorptions to the newly
        // resolved count — a level-up mid-bubble strengthens the shield
        // (AC1/AC3).
        this._shieldRemaining = stats.shieldAbsorptions ?? 1;
        break;
      case PowerUpType.SPEED_BOOST:
        this._startOrRefreshTimed(
          id,
          entry.type,
          stats.speedDuration ?? 10,
          permanent,
        );
        break;
      case PowerUpType.MAGNET:
        // P9 hybrid: only the field pickup opens a timed attraction; the
        // hold-full reward is a permanent stack handled by the store.
        if (!permanent) {
          this._startOrRefreshTimed(id, entry.type, P9_MAGNET_DURATION, false);
        }
        break;
      case PowerUpType.MINERAL_SCOOP:
        // P10 hybrid: mirrors P9.
        if (!permanent) {
          this._startOrRefreshTimed(id, entry.type, P10_SCOOP_DURATION, false);
        }
        break;
      case PowerUpType.BOMB:
        // P4: a field pickup queues one ranged explosion; the hold-full
        // reward additionally makes it permanent and pulses immediately
        // (AH-0MUVM9RAO004Y3LB).
        this._bombPulsePending = true;
        if (permanent) {
          this._bombPermanent = true;
          this._bombPulseTimer = this.bombInterval();
        }
        break;
      default:
        // P6 phase, P7 teleport, P8 life: no registry-local timed state —
        // the level store owns charges/stacks/lives.
        break;
    }
  }

  /** Starts a timed effect or refreshes it to the (possibly new) duration. */
  private _startOrRefreshTimed(
    id: PowerUpId,
    type: PowerUpType,
    duration: number,
    permanent: boolean,
  ): void {
    const existing = this._timed.get(id);
    if (existing) {
      // Refresh to the current full duration — never additive. A level-up
      // mid-effect strengthens it (resolved-live, weapon parity).
      existing.duration = duration;
      if (permanent) {
        // A hold-full reward makes the base effect permanent and adds no
        // temporary stack, so any existing temporary window is left to
        // expire on its own schedule (AC2).
        existing.permanent = true;
      } else {
        // A field pickup (re)starts the temporary window (AC1).
        existing.tempWindow = true;
        existing.remaining = duration;
      }
    } else {
      this._timed.set(id, {
        id,
        type,
        duration,
        remaining: permanent ? 0 : duration,
        ...(permanent ? { permanent: true } : { tempWindow: true }),
      });
    }
  }

  /**
   * Refreshes a timed effect's timer to its full duration (same semantics
   * as re-collecting it). No-op for permanent types.
   */
  refresh(id: PowerUpId): void {
    const existing = this._timed.get(id);
    if (existing) {
      existing.remaining = existing.duration;
    }
  }

  /**
   * Advances timers by `dt` seconds, removing expired effects and weapons.
   * Permanent effects (granted by the hold-full choice) never expire, but an
   * active temporary field-pickup window on top of one still expires and
   * clears the store's temporary level (AC1/AC2).
   */
  tick(dt: number): void {
    // Expire timed power-up effects (permanent effects are skipped unless a
    // temporary window is active on top of them).
    for (const [id, effect] of [...this._timed]) {
      if (effect.permanent && !effect.tempWindow) continue;
      effect.remaining -= dt;
      if (effect.remaining > 0) continue;
      this._expireTimedEffect(id, effect);
    }
    // Expire timed weapons (permanent weapons are skipped).
    for (const [weaponId, weapon] of this._weapons) {
      if (weapon.permanent) continue;
      weapon.remaining -= dt;
      if (weapon.remaining <= 0) {
        this._weapons.delete(weaponId);
      }
    }
  }

  /**
   * Expires a timed effect: clears its temporary level if it owns a field
   * window, then removes the entry unless a permanent base remains.
   */
  private _expireTimedEffect(id: PowerUpId, effect: TimedEffectState): void {
    if (effect.tempWindow) {
      this._levelStore.clearTemporary(id);
      effect.tempWindow = false;
    }
    effect.remaining = 0;
    if (effect.permanent) return;
    this._timed.delete(id);
    // Start the P6 re-arm cooldown the moment a phase expires (Q2).
    if (id === 'P6') {
      this._phaseRearmCooldown = PHASE_REARM_COOLDOWN;
    }
    // The shield's remaining absorptions end with its bubble; the temporary
    // level is cleared above and the permanent level persists (AC3).
    if (id === 'P3') {
      this._shieldRemaining = 0;
    }
  }

  /** Whether the given timed effect is currently active. */
  isActive(id: PowerUpId): boolean {
    return this._timed.has(id);
  }

  /** Whether the ship is shielded (P3 active). */
  get isShielded(): boolean {
    return this._timed.has('P3');
  }

  /** Whether the ship is in phase shift (P6 active) — intangibility. */
  get isPhased(): boolean {
    return this._timed.has('P6');
  }

  /** Whether the ship is hit-immune (shield OR phase active). */
  get isHitImmune(): boolean {
    return this._timed.has('P3') || this._timed.has('P6');
  }

  /**
   * Absorbs a hit with the shield (P3): while a shield is active, decrements
   * its remaining-absorptions count and returns true (hit absorbed). The
   * shield stays active until its last absorption (the count resolved from
   * `store.stats('P3').shieldAbsorptions`: base 1, cap 3), when it pops.
   * Returns false when no shield is active.
   *
   * Phase does NOT absorb — it prevents hits via pass-through before they
   * are tested (scene should skip collision checks when phased).
   */
  tryAbsorbShield(): boolean {
    if (!this._timed.has('P3')) return false;
    this._shieldRemaining -= 1;
    if (this._shieldRemaining <= 0) {
      this._timed.delete('P3');
      this._shieldRemaining = 0;
      // The shield popped, ending its temporary field window too.
      this._levelStore.clearTemporary('P3');
    }
    return true;
  }

  /**
   * Hits the active P3 shield can still absorb before it pops (0 when no
   * shield is active). Surfaced for the HUD's `Shield ×N` row.
   */
  shieldAbsorptionsRemaining(): number {
    return this._shieldRemaining;
  }

  // ── P4 bomb pulse (AH-0MUVM9RAO004Y3LB) ────────────────────────────

  /** Whether a permanent (hold-full) P4 bomb is active for the run. */
  isBombPermanent(): boolean {
    return this._bombPermanent;
  }

  /**
   * The resolved P4 clear radius in px at the current level. Resolved live,
   * so a level-up mid-run enlarges every subsequent pulse (AC3).
   */
  bombRange(): number {
    return this._levelStore.stats('P4').bombRange ?? 120;
  }

  /**
   * The resolved P4 pulse interval in seconds (`1 / bombFrequency`). The
   * model stores a monotonic pulses/second rate; the effect inverts it.
   */
  bombInterval(): number {
    const frequency = this._levelStore.stats('P4').bombFrequency ?? 0.33;
    return frequency > 0 ? 1 / frequency : Number.POSITIVE_INFINITY;
  }

  /**
   * Advances the P4 bomb pulse state by `dt` and reports whether a pulse is
   * due this frame.
   *
   * - A field-pickup request fires exactly once and is then gone (AC1).
   * - A permanent bomb fires immediately on grant and then once per
   *   {@link bombInterval} seconds for the rest of the run (AC2).
   *
   * The registry owns the decision; the shared combat core performs the
   * actual ranged clear and VFX (it alone knows the player and the bullets),
   * so the game and every gym run the same code (AC4).
   *
   * @param dt - Frame delta in seconds.
   * @returns True when a pulse should be applied this frame.
   */
  updateBomb(dt: number): boolean {
    if (this._bombPulsePending) {
      this._bombPulsePending = false;
      if (this._bombPermanent) {
        this._bombPulseTimer = this.bombInterval();
      }
      return true;
    }
    if (!this._bombPermanent) return false;
    this._bombPulseTimer -= dt;
    if (this._bombPulseTimer <= 0) {
      this._bombPulseTimer = this.bombInterval();
      return true;
    }
    return false;
  }

  /**
   * Activates P6 Phase Shift (upgrade-level duration for P7 arrivals) —
   * e.g. on P7 teleport arrival. Refreshes if already active — never
   * additive. This is the direct, charge-free activation path; it does not
   * consume an auto-activation charge (Q6).
   */
  applyPhaseShift(): void {
    this._activatePhase(
      this._levelStore.stats('P7').teleportPhaseDuration ?? 1.5,
    );
  }

  /** (Re)activates the P6 timed effect at `duration` seconds. */
  private _activatePhase(duration: number): void {
    const existing = this._timed.get('P6');
    if (existing) {
      existing.duration = duration;
      existing.remaining = duration;
    } else {
      this._timed.set('P6', {
        id: 'P6' as PowerUpId,
        type: PowerUpType.PHASE_SHIFT,
        duration,
        remaining: duration,
      });
    }
  }

  /**
   * Feeds the shared per-frame danger signal into the P6 auto-trigger model
   * (Q1/Q2/Q3). Call once per frame after {@link tick}.
   *
   * When `inDanger` is true, the player is not already phased, a charge is
   * available (or the reward is permanent), danger has cleared since the
   * last trigger and the re-arm cooldown has elapsed, this activates Phase
   * Shift for the level-resolved `phaseDuration` and consumes one charge
   * (permanent rewards do not consume).
   *
   * @param inDanger — whether the danger helper reports the ship surrounded.
   * @param dt — frame delta in seconds (advances the re-arm cooldown).
   * @returns whether Phase Shift was auto-activated this frame.
   */
  updateDanger(inDanger: boolean, dt: number): boolean {
    if (this._phaseRearmCooldown > 0) {
      this._phaseRearmCooldown = Math.max(0, this._phaseRearmCooldown - dt);
    }
    if (!inDanger) {
      // Danger has cleared — re-arm for the next episode.
      this._phaseDangerCleared = true;
      return false;
    }
    if (this._timed.has('P6')) return false;
    if (!this._phaseDangerCleared) return false;
    if (this._phaseRearmCooldown > 0) return false;

    const store = this._levelStore;
    // `consumePhaseCharge` returns false only when neither a real charge nor
    // the permanent reward is available (AC3: one derived charge model).
    if (!store.consumePhaseCharge()) return false;

    this._activatePhase(store.stats('P6').phaseDuration ?? 1.5);
    this._phaseDangerCleared = false;
    return true;
  }

  /** Stored P6 auto-activation charges (0 for a permanent reward). */
  phaseCharges(): number {
    return this._levelStore.phaseCharges();
  }

  /** Whether the hold-full reward granted unlimited Phase Shift activations. */
  isPhasePermanent(): boolean {
    return this._levelStore.isPhasePermanent();
  }

  /** Stored teleport uses (P7). */
  teleportStacks(): number {
    return this._levelStore.teleportStacks();
  }

  /** Whether at least one teleport use is stored. */
  hasTeleport(): boolean {
    return this._levelStore.teleportStacks() > 0;
  }

  /**
   * Consumes one stored teleport use (FIFO — one stack) and grants
   * P6 Phase Shift at the landing spot. Returns true if consumed, false
   * if none were stored.
   */
  consumeTeleport(): boolean {
    if (!this._levelStore.consumeTeleport()) return false;
    this.applyPhaseShift();
    return true;
  }

  /** Remaining seconds for a timed effect, or undefined when inactive. */
  remaining(id: PowerUpId): number | undefined {
    return this._timed.get(id)?.remaining;
  }

  /**
   * Current movement multiplier from P5: the level-resolved
   * `speedMultiplier` while active, else 1.
   */
  speedMultiplier(): number {
    if (!this._timed.has('P5')) return 1;
    return this._levelStore.stats('P5').speedMultiplier ?? 1;
  }

  /**
   * Current fire-rate multiplier from P5: the same level-resolved
   * `speedMultiplier` while active, else 1, so both axes cannot diverge
   * (single source of truth — AC2/AC3).
   */
  fireRateMultiplier(): number {
    return this.speedMultiplier();
  }

  /** Current lives count (P8 model); starts at 3, capped level-resolved. */
  lives(): number {
    return this._levelStore.lives();
  }

  /**
   * Sets the lives counter directly (clamped to `[0, livesCap]`).
   * Lets the playable game drive the HUD from its authoritative run state
   * (GameState) when a player is hit; P8 collection still uses
   * `applyCollect('P8')`.
   */
  setLives(value: number): void {
    this._levelStore.setLives(value);
  }

  /** Current permanent magnet stack count (P9); level-capped. */
  magnetStacks(): number {
    return this._levelStore.magnetStacks();
  }

  /** Whether any magnet effect (timed or permanent) is currently active. */
  isMagnetActive(): boolean {
    return this._timed.has('P9') || this._levelStore.magnetStacks() > 0;
  }

  /**
   * Effective magnet stacks driving the attraction radius: the permanent
   * stack count when any upgrade was chosen, otherwise one stack while the
   * timed field pickup is active (mirroring "one magnet\'s worth" of pull),
   * otherwise zero (no attraction). The shared helper consumes this so the
   * timed and permanent paths use the exact same radius curve.
   */
  magnetEffectStacks(): number {
    const stacks = this._levelStore.magnetStacks();
    if (stacks > 0) return stacks;
    return this._timed.has('P9') ? 1 : 0;
  }

  /** Current permanent mineral-scoop stack count (P10); level-capped. */
  scoopStacks(): number {
    return this._levelStore.scoopStacks();
  }

  /** Whether the timed P10 field-pickup mineral attraction is active. */
  isScoopActive(): boolean {
    return this._timed.has('P10');
  }

  /**
   * Effective scoop stacks driving the attraction radius: the permanent
   * stack count when any upgrade was chosen, otherwise one stack while the
   * timed field pickup is active (mirroring "one magnet's worth" of pull),
   * otherwise zero (no attraction). The shared helper consumes this so the
   * timed and permanent paths use the exact same radius curve.
   */
  scoopEffectStacks(): number {
    const stacks = this._levelStore.scoopStacks();
    if (stacks > 0) return stacks;
    return this._timed.has('P10') ? 1 : 0;
  }

  // ── Weapon accessors ──────────────────────────────────────────────

  /** Current active timed weapons (id → remaining seconds). */
  activeWeapons(): WeaponEffect[] {
    return Array.from(this._weapons.values());
  }

  /** Whether a specific timed weapon is currently active. */
  hasWeapon(weaponId: WeaponId): boolean {
    return this._weapons.has(weaponId);
  }

  /**
   * Applies the effect of a collected weapon (spread, dual, rapid):
   * equips it for the full duration, refreshing the timer if it is
   * already active. Returns true when freshly equipped, false when
   * already active (refreshed).
   *
   * @param weaponId — the collected weapon.
   * @param permanent — when true, the weapon never expires for the run
   *   (used by the hold-full choice).
   */
  applyWeapon(weaponId: WeaponId, permanent = false): boolean {
    const existing = this._weapons.get(weaponId);
    if (existing) {
      existing.remaining = WEAPON_EFFECT_DURATION;
      if (permanent) existing.permanent = true;
      return false; // already active, refreshed
    }
    this._weapons.set(weaponId, {
      weaponId,
      duration: WEAPON_EFFECT_DURATION,
      remaining: WEAPON_EFFECT_DURATION,
      ...(permanent ? { permanent: true } : {}),
    });
    return true;
  }

  /**
   * Resets all timed weapons (Reset drop effect). Returns true if
   * weapons were actually present.
   */
  tryResetWeapons(): boolean {
    if (this._weapons.size === 0) return false;
    this._weapons.clear();
    return true;
  }

  /**
   * Snapshot of the active timed effects plus permanent stack/lives state —
   * the aggregated model the standalone HUD renders from. P7 teleport is
   * included as a stack entry when any uses are stored. Weapons are
   * exposed separately via `activeWeapons()`.
   */
  activeEffects(): ActiveEffect[] {
    const result: ActiveEffect[] = [];
    for (const effect of this._timed.values()) {
      // P3 carries its remaining absorptions so the HUD renders `Shield xN`
      // and updates as hits are absorbed (AC6).
      const stacks =
        effect.id === 'P3' ? this._shieldRemaining : undefined;
      // A permanent base with no active temporary window shows its full
      // duration (it never counts down); an active temporary window shows
      // the window remaining (AC1/AC2).
      const remaining =
        effect.permanent && !effect.tempWindow
          ? effect.duration
          : effect.remaining;
      result.push({
        id: effect.id,
        type: effect.type,
        duration: effect.duration,
        remaining,
        ...(stacks !== undefined ? { stacks } : {}),
      });
    }
    // P9 permanent upgrades render as a stack row; the timed field pickup
    // is already surfaced from `_timed` above. A zero stack count is never
    // surfaced (no misleading "x0").
    const magnetStacks = this._levelStore.magnetStacks();
    if (magnetStacks > 0) {
      result.push({
        id: 'P9' as PowerUpId,
        type: PowerUpType.MAGNET,
        stacks: magnetStacks,
      });
    }
    // P10 permanent upgrades render as a stack row; the timed field pickup
    // is already surfaced from `_timed` above. A zero stack count is never
    // surfaced (no misleading "x0").
    const scoopStacks = this._levelStore.scoopStacks();
    if (scoopStacks > 0) {
      result.push({
        id: 'P10' as PowerUpId,
        type: PowerUpType.MINERAL_SCOOP,
        stacks: scoopStacks,
      });
    }
    // A permanent P4 bomb is a run-scoped active effect (never expires); a
    // field pickup leaves no row (AC6).
    if (this._bombPermanent) {
      result.push({
        id: 'P4' as PowerUpId,
        type: PowerUpType.BOMB,
        permanent: true,
      });
    }
    const teleportStacks = this._levelStore.teleportStacks();
    if (teleportStacks > 0) {
      result.push({
        id: 'P7' as PowerUpId,
        type: PowerUpType.TELEPORT,
        stacks: teleportStacks,
      });
    }
    // P6 auto-activation charges (parent AH-0MUIYX1EE008FVS8): a finite
    // stock-pile renders as a count, the hold-full reward as unlimited. A
    // zero charge count is never surfaced (no misleading "x0").
    if (this.isPhasePermanent()) {
      result.push({
        id: 'P6' as PowerUpId,
        type: PowerUpType.PHASE_SHIFT,
        permanent: true,
      });
    } else {
      const phaseCharges = this._levelStore.phaseCharges();
      if (phaseCharges > 0) {
        result.push({
          id: 'P6' as PowerUpId,
          type: PowerUpType.PHASE_SHIFT,
          stacks: phaseCharges,
        });
      }
    }
    return result;
  }

  /**
   * Resets the entire registry to initial state (for scene restart): clears
   * the local timing state and resets the run-scoped level store (levels and
   * derived resources together, AC6).
   */
  reset(): void {
    this._timed.clear();
    this._weapons.clear();
    this._phaseDangerCleared = true;
    this._phaseRearmCooldown = 0;
    this._shieldRemaining = 0;
    this._bombPermanent = false;
    this._bombPulseTimer = 0;
    this._bombPulsePending = false;
    this._levelStore.reset();
  }
}
