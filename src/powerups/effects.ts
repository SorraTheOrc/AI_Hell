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
 * single mutation point. Effect strengths (durations, the P5 multiplier,
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
 * - **P3 Shield** — timed `shieldDuration` bubble; absorbs one hit, popped
 *   on absorb, refreshes on re-collect before expiry. The multi-hit
 *   `shieldAbsorptions` axis is tracked by the store but its consumption is
 *   deferred to AH-0MUVM9RAO004Y3LB.
 * - **P4 Bomb** — instant: clears on-screen enemy bullets on collect (does
 *   not damage 1-HP enemies, GDD §4.4); the store tracks `bombCharges` but
 *   consumption is deferred to AH-0MUVM9RAO004Y3LB.
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
  /** Stack count (stackable types, e.g. P9 magnet, P7 teleport). */
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
  remaining: number;
  /** True when granted permanently for the run (never expires). */
  permanent?: boolean;
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
   * - P4: instant bomb — no registry state (scene clears bullets); the store
   *   still tracks the collection.
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
      default:
        // P4 bomb, P6 phase, P7 teleport, P8 life: no registry-local timed
        // state — the level store owns charges/stacks/lives.
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
      existing.remaining = duration;
      if (permanent) existing.permanent = true;
    } else {
      this._timed.set(id, {
        id,
        type,
        duration,
        remaining: duration,
        ...(permanent ? { permanent: true } : {}),
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
   * Permanent effects (granted by the hold-full choice) never expire.
   */
  tick(dt: number): void {
    // Expire timed power-up effects (permanent effects are skipped).
    for (const [id, effect] of this._timed) {
      if (effect.permanent) continue;
      effect.remaining -= dt;
      if (effect.remaining <= 0) {
        this._timed.delete(id);
        // Start the P6 re-arm cooldown the moment a phase expires (Q2).
        if (id === 'P6') {
          this._phaseRearmCooldown = PHASE_REARM_COOLDOWN;
        }
      }
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
   * Absorbs a hit with the shield (P3): removes P3 if active and returns
   * true (hit absorbed); otherwise returns false (hit not absorbed).
   * Phase does NOT absorb — it prevents hits via pass-through before they
   * are tested (scene should skip collision checks when phased).
   *
   * The multi-hit `shieldAbsorptions` axis is deferred to
   * AH-0MUVM9RAO004Y3LB, so the shield still absorbs exactly one hit.
   */
  tryAbsorbShield(): boolean {
    if (!this._timed.has('P3')) return false;
    this._timed.delete('P3');
    return true;
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
      result.push({
        id: effect.id,
        type: effect.type,
        duration: effect.duration,
        remaining: effect.remaining,
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
    this._levelStore.reset();
  }
}
