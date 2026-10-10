/**
 * Active power-up effects registry (GDD §4.4).
 *
 * Engine-agnostic state for power-ups Shield–Magnet after collection, aggregated
 * for the standalone HUD (`src/ui/HUD.ts`) and by the combat gym for
 * hit-response. Non-combat (Speed Boost/Extra Life/Magnet) are always available; combat-coupled
 * (Shield/Bomb/Phase Shift/Teleport) are exercised by the GymPowerUpsCombat scene with live
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
 * reverts to the permanent level (or the item becomes inactive). Effect strengths (durations, the Speed Boost multiplier,
 * caps) are resolved from the catalogue via `store.stats(...)` rather than
 * raw tuning constants, so balance intent cannot drift between scenes
 * (AC1/AC2/AC3). `P9_MAGNET_DURATION` / `P10_SCOOP_DURATION` are the only
 * non-levelled effect constants that remain: the Magnet/Mineral Scoop **field-pickup**
 * timed duration is not a catalogue axis (documented, AC2).
 *
 * - **Speed Boost** — timed: `speedMultiplier` movement speed and
 *   fire-rate for `speedDuration` seconds (both use the same level-resolved
 *   multiplier); re-collecting refreshes the timer to full duration (never
 *   additive).
 * - **Extra Life** — immediate: adds the level-resolved `lifeGain`,
 *   clamped to the level-resolved `livesCap` (base 3 start, cap 5).
 * - **Magnet** — attracts nearby drops: a timed 15 s effect when
 *   collected as a field drop (refresh-only, never stacking), or a
 *   permanent stacking effect when granted as a hold-full reward.
 *   Shares the Magnet/Mineral Scoop attraction radius curve (base 1× ship size, +50%/stack).
 * - **Mineral Scoop** — attracts nearby minerals: a timed 15 s effect
 *   when collected as a field drop (refresh-only, never stacking), or a
 *   permanent stacking effect when granted as a hold-full reward.
 *   Shares the Magnet attraction radius curve (base 1× ship size, +50%/stack).
 * - **Shield** — timed `shieldDuration` bubble; absorbs the level-resolved
 *   `shieldAbsorptions` hits (base 1, cap 3) before popping, refreshing the
 *   bubble and its remaining-hit count on re-collect before expiry. The
 *   remaining absorptions are run-scoped registry state, cleared by
 *   `reset()` and surfaced to the HUD via `activeEffects()` (`stacks`).
 *   Because a field pickup's level is **temporary** (AH-0MUX802450085VZZ),
 *   the bubble's expiry clears the temporary level (reverting to the
 *   permanent level, if any); a hold-full reward grants a permanent shield
 *   that never expires (AH-0MUVM9RAO004Y3LB).
 * - **Bomb** — ranged periodic clear (AH-0MUVM9RAO004Y3LB): the model
 *   exposes `bombRange` (px) and `bombFrequency` (pulses/s); the effect path
 *   clears on-screen enemy bullets within the resolved range (a single pulse
 *   for a field pickup, an immediate-then-periodic pulse when permanent),
 *   without damaging 1-HP enemies (GDD §4.4).
 * - **Phase Shift** — charge-based auto-trigger (parent
 *   AH-0MUIYX1EE008FVS8). Collecting Phase Shift stores the level-resolved
 *   `phaseCharges` auto-activation charges (or grants unlimited activations
 *   for the hold-full reward); the shared combat core calls
 *   {@link EffectsRegistry.updateDanger} each frame and the registry
 *   activates a `phaseDuration` pass-through the moment the player is in
 *   real danger and a charge is available. After expiry it re-arms only once
 *   danger has cleared and a short cooldown has elapsed (Q2/Q3).
 * - **Teleport** — stored FIFO stacks (no timer); the shared automatic
 *   defence feed spends one FIFO use when Teleport is selected
 *   (AH-0MUZE4AIP009HZWC) and grants Phase Shift for
 *   `teleportPhaseDuration` at the landing spot without consuming an
 *   auto-activation charge (Q6). Safe-spot resolution is the scene's
 *   responsibility; this module tracks only the stored count.
 *
 * The registry is pure (no Phaser imports). The scene layers
 * movement/ship integration, bullet clearing, hit-response and teleport
 * teleportation on top of it.
 */

import {
  PowerUpId,
} from './types';
import {
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
  PHASE_REARM_COOLDOWN,
  FORCE_FIELD_RADIUS_FACTOR,
  SHIP_SIZE,
} from '../core/constants';
import {
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  type PowerUpLevelStats,
} from './powerUpLevels';
import { FRIGHTEN_DEFAULT_DURATION } from '../scenes/core/frightenedState';
import type { AoEDescriptor, WeaponId } from '../utils/weapons';

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
 * Lives counter initial value (Extra Life model). Mirrors the store's start so
 * standalone-registry tests and the store agree (AC3).
 */
export const P8_LIVES_START = POWER_UP_LIVES_START;

/**
 * Duration in seconds of the Magnet field-pickup drop attraction. **Not a
 * levelled axis** — the Magnet/Mineral Scoop field-pickup timed window stays constant
 * while only the permanent stack cap (and hence the attraction radius)
 * levels (AC2).
 */
export const P9_MAGNET_DURATION = 15;

/**
 * Duration in seconds of the Mineral Scoop field-pickup mineral attraction. **Not a
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
  /**
   * True while a field-pickup temporary window is active on top of the
   * weapon (AH-0MUX802450085VZZ). A permanent weapon re-collected in the
   * field keeps `permanent: true` **and** opens this window, which counts
   * down and clears on expiry while the permanent base remains. The HUD
   * renders the window as a countdown timer (vs `∞` for a permanent-only
   * weapon).
   */
  tempWindow?: boolean;
}

export interface ActiveEffect {
  /** Power-up ID (e.g. "speed_boost"). */
  id: PowerUpId;
  /** Effect type — the same identifier as {@link id}. */
  type: PowerUpId;
  /** Full duration in seconds (timed types). */
  duration?: number;
  /** Remaining seconds (timed types). */
  remaining?: number;
  /**
   * Stack count (stackable types, e.g. Magnet magnet, Teleport teleport) or, for the
   * Shield shield, the remaining absorptions before the bubble pops.
   */
  stacks?: number;
  /**
   * True when the effect has unlimited uses for the run (e.g. the hold-full
   * Phase Shift reward). Rendered as an unlimited marker rather than a count.
   */
  permanent?: boolean;
}

/**
 * Applies the Speed Boost speed multiplier live to a movement config: both thrust
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

// ── Automatic defence selection (AH-0MUZE4AIP009HZWC) ───────────────

/** A defensive ability the automatic defence feed may spend. */
export type AutoDefenceChoice = 'phase_shift' | 'teleport';

/**
 * Outcome of feeding one frame of the shared danger signal into
 * {@link EffectsRegistry.updateDanger}:
 *
 * - `'phase_shift'` — the registry activated Phase Shift itself.
 * - `'teleport'` — Teleport was selected; the scene must perform the warp
 *   through its shared `triggerTeleport` path (which consumes one FIFO
 *   stack and grants Phase Shift on arrival).
 * - `null` — nothing should fire this frame.
 */
export type DangerDecision = AutoDefenceChoice | null;

/**
 * Picks the defensive ability to spend from the available stocks, using the
 * producer's charge-count rule (AH-0MUZE4AIP009HZWC, AC2):
 *
 * - Neither available → `null`.
 * - Only one available → that ability.
 * - Both available → the ability with the **greater** available count.
 * - Equal finite counts → a uniform 50/50 pick driven by `rng`.
 * - A permanent Phase Shift is **unbounded** (count `Infinity`) and so
 *   always outranks a finite Teleport stack, conserving Teleports while
 *   unlimited Phase Shift is owned (documented assumption).
 *
 * Pure and engine-agnostic so the game and every gym share one rule and the
 * tie-break is deterministically testable via an injectable `rng`.
 *
 * @param phaseCharges — stored Phase Shift auto-activation charges.
 * @param phasePermanent — whether the Phase Shift reward is unlimited.
 * @param teleportStacks — stored Teleport FIFO stacks.
 * @param rng — random source in `[0, 1)`; only consulted for an exact tie
 *   between two finite counts. Injectable/seeded for deterministic tests.
 * @returns the ability to spend, or `null` when none is available.
 */
export function selectAutoDefence(
  phaseCharges: number,
  phasePermanent: boolean,
  teleportStacks: number,
  rng: () => number = Math.random,
): AutoDefenceChoice | null {
  const phaseCount = phasePermanent
    ? Number.POSITIVE_INFINITY
    : Math.max(0, phaseCharges);
  const teleportCount = Math.max(0, teleportStacks);
  const phaseAvailable = phaseCount > 0;
  const teleportAvailable = teleportCount > 0;

  if (!phaseAvailable && !teleportAvailable) return null;
  if (phaseAvailable && !teleportAvailable) return 'phase_shift';
  if (teleportAvailable && !phaseAvailable) return 'teleport';
  if (phaseCount > teleportCount) return 'phase_shift';
  if (teleportCount > phaseCount) return 'teleport';
  // Both finite and equal — uniform 50/50 tie-break.
  return rng() < 0.5 ? 'phase_shift' : 'teleport';
}

// ── Effects registry ────────────────────────────────────────────────

interface TimedEffectState {
  id: PowerUpId;
  type: PowerUpId;
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
   * such as the Teleport-arrival phase, whose expiry must not clear temporary
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
 * Phase Shift re-arm) lives here.
 */
export class EffectsRegistry {
  private _timed = new Map<PowerUpId, TimedEffectState>();
  /** Active timed weapons: each weapon has its own countdown. */
  private _weapons: Map<WeaponId, WeaponEffect> = new Map();

  // ── Shared automatic-defence timing state (Q2/Q3/Q6, AH-0MUZE4AIP009HZWC) ──
  /**
   * Whether danger has cleared since the last auto-activation. A fresh
   * defence is armed (`true`); firing latches it off until danger drops below
   * the threshold (Q2). One governor covers both Phase Shift and Teleport, so
   * at most one ability fires per danger episode (AC5).
   */
  private _dangerCleared = true;
  /** Seconds of shared re-arm cooldown remaining after the last phase expired. */
  private _rearmCooldown = 0;
  /**
   * Random source for the Phase Shift/Teleport exact-tie pick (AC2).
   * Injectable/seeded via the constructor or {@link setRng} so the tie-break
   * is deterministically testable.
   */
  private _rng: () => number;

  // ── Shield shield remaining-absorptions state (AH-0MUVM9RAO004Y3LB) ──
  /**
   * Hits the active Shield shield can still absorb before it pops, resolved from
   * the level store on every collection (base 1, cap 3). Run-scoped: reset()
   * and Shield expiry clear it. Zero means "no shield active".
   */
  private _shieldRemaining = 0;

  // ── Bomb bomb pulse state (AH-0MUVM9RAO004Y3LB) ────────────────────
  /**
   * True when a hold-full Bomb granted a permanent bomb for the run: it never
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

  // ── Smart Bomb screen-pulse state (AH-0MV1BIWP9003EHRQ) ──────────────
  /**
   * True when a hold-full Smart Bomb granted a permanent pulse for the run:
   * it never expires and pulses every {@link smartBombInterval} seconds.
   * Cleared only by `reset()`.
   */
  private _smartBombPermanent = false;
  /** Seconds until the next permanent smart-bomb pulse (unused when not permanent). */
  private _smartBombPulseTimer = 0;
  /**
   * One-shot pulse request queued by a field pickup: the next
   * {@link updateSmartBomb} fires exactly once and clears it. A field pickup
   * stores no other persistent state (mirrors the Bomb).
   */
  private _smartBombPulsePending = false;

  // ── Force Field reflect state (AH-0MV1BIX1W006XF95) ──────────────────
  /**
   * Enemy bullets the active Force Field can still reflect before it stops
   * (resolved from the level store on every collection: base 3, cap 10).
   * Run-scoped: reset() and bubble expiry clear it. Zero means "the bubble no
   * longer reflects" (it may still be counting down).
   */
  private _forceFieldRemaining = 0;

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
  constructor(store?: PowerUpLevelStore, rng: () => number = Math.random) {
    this._store = store ?? new PowerUpLevelStore();
    this._rng = rng;
  }

  /**
   * Injects the random source used for the Phase Shift/Teleport tie-break
   * (AC2). Pass a seeded generator for deterministic tests.
   */
  setRng(rng: () => number): void {
    this._rng = rng;
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
   * - shield/speed_boost: starts the timed `shieldDuration`/`speedDuration`,
   *   or refreshes it to the new full duration if already active.
   * - bomb: a field pickup queues a single ranged explosion (no persistent
   *   state); the hold-full reward sets the run-scoped permanent flag and
   *   pulses every resolved interval. The shared combat core performs the
   *   actual clear from these requests (it alone knows the player/bullets).
   * - phase_shift: stores the level-resolved `phaseCharges` (or marks the
   *   permanent reward); the phase itself is applied later by the shared
   *   combat core via `updateDanger`.
   * - teleport: the store grants the level-resolved stored teleport uses. No timer.
   * - extra_life: the store grants the level-resolved lives, clamped to the cap.
   * - magnet/mineral_scoop: a field pickup (no flag) starts the timed
   *   refresh-only attraction; the hold-full reward adds a permanent stack via
   *   the store (hybrid preserved).
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
    switch (id) {
      case 'shield':
        this._startOrRefreshTimed(
          id,
          id,
          stats.shieldDuration ?? 15,
          permanent,
        );
        // Refresh (never add) the remaining absorptions to the newly
        // resolved count — a level-up mid-bubble strengthens the shield
        // (AC1/AC3).
        this._shieldRemaining = stats.shieldAbsorptions ?? 1;
        break;
      case 'speed_boost':
        this._startOrRefreshTimed(
          id,
          id,
          stats.speedDuration ?? 10,
          permanent,
        );
        break;
      case 'magnet':
        // Magnet hybrid: only the field pickup opens a timed attraction; the
        // hold-full reward is a permanent stack handled by the store.
        if (!permanent) {
          this._startOrRefreshTimed(id, id, P9_MAGNET_DURATION, false);
        }
        break;
      case 'mineral_scoop':
        // Mineral Scoop hybrid: mirrors Magnet.
        if (!permanent) {
          this._startOrRefreshTimed(id, id, P10_SCOOP_DURATION, false);
        }
        break;
      case 'power_pellet':
        // Power Pellet: a timed window the shared combat core reads to make
        // enemies flee and suppress fire (Pac-Man adaptation). The window is
        // the item's timed window, so a field pickup opens a temporary one
        // and the hold-full reward makes the state permanent.
        this._startOrRefreshTimed(
          id,
          id,
          stats.frightenDuration ?? FRIGHTEN_DEFAULT_DURATION,
          permanent,
        );
        break;
      case 'bomb':
        // bomb: a field pickup queues one ranged explosion; the hold-full
        // reward additionally makes it permanent and pulses immediately
        // (AH-0MUVM9RAO004Y3LB).
        this._bombPulsePending = true;
        if (permanent) {
          this._bombPermanent = true;
          this._bombPulseTimer = this.bombInterval();
        }
        break;
      case 'smart_bomb':
        // smart_bomb: a field pickup queues one screen-wide pulse; the
        // hold-full reward additionally makes it permanent and pulses
        // immediately (mirrors the Bomb; AH-0MV1BIWP9003EHRQ).
        this._smartBombPulsePending = true;
        if (permanent) {
          this._smartBombPermanent = true;
          this._smartBombPulseTimer = this.smartBombInterval();
        }
        break;
      case 'force_field':
        // force_field: a timed reflect bubble (Gradius homage,
        // AH-0MV1BIX1W006XF95). Re-collecting refreshes the bubble to the
        // newly resolved duration and reflect budget (never additive); the
        // shared combat core consumes the budget as bullets meet the bubble.
        this._startOrRefreshTimed(
          id,
          id,
          stats.forceFieldDuration ?? 8,
          permanent,
        );
        this._forceFieldRemaining = Math.max(
          0,
          Math.floor(stats.forceFieldReflects ?? 3),
        );
        break;
      default:
        // Phase Shift phase, Teleport teleport, Extra Life life: no registry-local timed state —
        // the level store owns charges/stacks/lives.
        break;
    }
  }

  /** Starts a timed effect or refreshes it to the (possibly new) duration. */
  private _startOrRefreshTimed(
    id: PowerUpId,
    type: PowerUpId,
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
    // Expire timed weapons (permanent weapons with no active temporary
    // window are skipped; a field-pickup window on top of a permanent base
    // still expires and clears the window, leaving the permanent base).
    for (const [weaponId, weapon] of this._weapons) {
      if (weapon.permanent && !weapon.tempWindow) continue;
      weapon.remaining -= dt;
      if (weapon.remaining > 0) continue;
      if (weapon.tempWindow) {
        weapon.tempWindow = false;
        weapon.remaining = 0;
        if (weapon.permanent) continue;
      }
      this._weapons.delete(weaponId);
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
    // Start the shared re-arm cooldown the moment an auto-triggered phase
    // expires (Q2) — this covers both a Phase Shift activation and the Phase
    // Shift granted on a Teleport arrival (AC5).
    if (id === 'phase_shift') {
      this._rearmCooldown = PHASE_REARM_COOLDOWN;
    }
    // The shield's remaining absorptions end with its bubble; the temporary
    // level is cleared above and the permanent level persists (AC3).
    if (id === 'shield') {
      this._shieldRemaining = 0;
    }
    // The Force Field stops reflecting when its bubble expires, whether the
    // window was temporary or permanent (AH-0MV1BIX1W006XF95).
    if (id === 'force_field') {
      this._forceFieldRemaining = 0;
    }
  }

  /** Whether the given timed effect is currently active. */
  isActive(id: PowerUpId): boolean {
    return this._timed.has(id);
  }

  /** Whether the ship is shielded (Shield active). */
  get isShielded(): boolean {
    return this._timed.has('shield');
  }

  /** Whether the ship is in phase shift (Phase Shift active) — intangibility. */
  get isPhased(): boolean {
    return this._timed.has('phase_shift');
  }

  /** Whether the ship is hit-immune (shield OR phase active). */
  get isHitImmune(): boolean {
    return this._timed.has('shield') || this._timed.has('phase_shift');
  }

  /**
   * Absorbs a hit with the shield (Shield): while a shield is active, decrements
   * its remaining-absorptions count and returns true (hit absorbed). The
   * shield stays active until its last absorption (the count resolved from
   * `store.stats('shield').shieldAbsorptions`: base 1, cap 3), when it pops.
   * Returns false when no shield is active.
   *
   * Phase does NOT absorb — it prevents hits via pass-through before they
   * are tested (scene should skip collision checks when phased).
   */
  tryAbsorbShield(): boolean {
    if (!this._timed.has('shield')) return false;
    this._shieldRemaining -= 1;
    if (this._shieldRemaining <= 0) {
      this._timed.delete('shield');
      this._shieldRemaining = 0;
      // The shield popped, ending its temporary field window too.
      this._levelStore.clearTemporary('shield');
    }
    return true;
  }

  /**
   * Hits the active Shield shield can still absorb before it pops (0 when no
   * shield is active). Surfaced for the HUD's `Shield ×N` row.
   */
  shieldAbsorptionsRemaining(): number {
    return this._shieldRemaining;
  }

  // ── Force Field reflector (AH-0MV1BIX1W006XF95) ──────────────────────

  /**
   * Whether the Force Field reflect bubble is active. While true an enemy
   * bullet that meets the bubble is bounced back as a player-owned bullet
   * (until the reflect budget is spent).
   */
  isForceFieldActive(): boolean {
    return this._timed.has('force_field');
  }

  /**
   * Enemy bullets the active Force Field can still reflect (0 when inactive
   * or exhausted). Surfaced for the HUD's `Force Field ×N` row and consumed
   * by the shared combat core's reflect branch.
   */
  forceFieldRemaining(): number {
    return this._forceFieldRemaining;
  }

  /**
   * The reflect bubble radius in px (`SHIP_SIZE × FORCE_FIELD_RADIUS_FACTOR`).
   * The shared bubble visual and the combat-core reflect branch use the same
   * value, so the drawn boundary and the gameplay boundary cannot diverge.
   */
  forceFieldRadius(): number {
    return SHIP_SIZE * FORCE_FIELD_RADIUS_FACTOR;
  }

  /**
   * Consumes one reflect from the active Force Field. Returns true when a
   * reflection is available (bubble active and budget remaining) and
   * decrements the budget; false when there is no bubble or it has spent its
   * reflect budget. Once false, enemy bullets damage the ship normally again.
   */
  tryConsumeForceFieldReflect(): boolean {
    if (!this._timed.has('force_field')) return false;
    if (this._forceFieldRemaining <= 0) return false;
    this._forceFieldRemaining -= 1;
    return true;
  }

  // ── Bomb bomb pulse (AH-0MUVM9RAO004Y3LB) ────────────────────────────

  /** Whether a permanent (hold-full) Bomb bomb is active for the run. */
  isBombPermanent(): boolean {
    return this._bombPermanent;
  }

  /**
   * The resolved Bomb clear radius in px at the current level. Resolved live,
   * so a level-up mid-run enlarges every subsequent pulse (AC3).
   */
  bombRange(): number {
    return this._levelStore.stats('bomb').bombRange ?? 120;
  }

  /**
   * The resolved Bomb pulse interval in seconds (`1 / bombFrequency`). The
   * model stores a monotonic pulses/second rate; the effect inverts it.
   */
  bombInterval(): number {
    const frequency = this._levelStore.stats('bomb').bombFrequency ?? 0.33;
    return frequency > 0 ? 1 / frequency : Number.POSITIVE_INFINITY;
  }

  /**
   * Advances the Bomb bomb pulse state by `dt` and reports whether a pulse is
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

  // ── Smart Bomb screen pulse (AH-0MV1BIWP9003EHRQ) ────────────────────

  /** Whether a permanent (hold-full) Smart Bomb is active for the run. */
  isSmartBombPermanent(): boolean {
    return this._smartBombPermanent;
  }

  /**
   * The resolved Smart Bomb pulse rate in pulses per second at the current
   * level. Resolved live, so a level-up mid-run quickens every subsequent
   * pulse.
   */
  smartBombFrequency(): number {
    return this._levelStore.stats('smart_bomb').smartBombFrequency ?? 0.2;
  }

  /**
   * The resolved Smart Bomb pulse interval in seconds (`1 / frequency`). The
   * model stores a monotonic pulses/second rate; the effect inverts it.
   */
  smartBombInterval(): number {
    const frequency = this.smartBombFrequency();
    return frequency > 0 ? 1 / frequency : Number.POSITIVE_INFINITY;
  }

  /**
   * The shared {@link AoEDescriptor} describing one Smart Bomb pulse: a
   * screen-wide (`aoeRadius`) area that damages every enemy once for the
   * level-resolved `smartBombDamage` and clears every enemy bullet.
   *
   * Building the descriptor here (rather than hand-rolling an area effect in
   * the scene) means the pulse resolves through the **same** AOE seam as the
   * Nova/Mortar/Arc weapons — one target-selection and damage implementation,
   * shared by the game and every gym (AC5). The `'screenPulse'` trigger marks
   * it as a non-weapon, once-per-activation resolution.
   */
  smartBombAoe(): AoEDescriptor {
    const stats = this._levelStore.stats('smart_bomb');
    return {
      trigger: 'screenPulse',
      radius: stats.aoeRadius ?? 1200,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      damage: Math.max(1, Math.floor(stats.smartBombDamage ?? 1)),
    };
  }

  /**
   * Advances the Smart Bomb pulse state by `dt` and reports whether a pulse
   * is due this frame.
   *
   * - A field-pickup request fires exactly once and is then gone.
   * - A permanent smart bomb fires immediately on grant and then once per
   *   {@link smartBombInterval} seconds for the rest of the run.
   *
   * The registry owns the decision; the shared combat core performs the
   * screen-wide clear/damage through {@link smartBombAoe} so the game and
   * every gym run the same code.
   *
   * @param dt - Frame delta in seconds.
   * @returns True when a pulse should be applied this frame.
   */
  updateSmartBomb(dt: number): boolean {
    if (this._smartBombPulsePending) {
      this._smartBombPulsePending = false;
      if (this._smartBombPermanent) {
        this._smartBombPulseTimer = this.smartBombInterval();
      }
      return true;
    }
    if (!this._smartBombPermanent) return false;
    this._smartBombPulseTimer -= dt;
    if (this._smartBombPulseTimer <= 0) {
      this._smartBombPulseTimer = this.smartBombInterval();
      return true;
    }
    return false;
  }

  /**
   * Activates Phase Shift (upgrade-level duration for Teleport arrivals) —
   * e.g. on Teleport teleport arrival. Refreshes if already active — never
   * additive. This is the direct, charge-free activation path; it does not
   * consume an auto-activation charge (Q6).
   */
  applyPhaseShift(): void {
    this._activatePhase(
      this._levelStore.stats('teleport').teleportPhaseDuration ?? 1.5,
    );
  }

  /** (Re)activates the Phase Shift timed effect at `duration` seconds. */
  private _activatePhase(duration: number): void {
    const existing = this._timed.get('phase_shift');
    if (existing) {
      existing.duration = duration;
      existing.remaining = duration;
    } else {
      this._timed.set('phase_shift', {
        id: 'phase_shift' as PowerUpId,
        type: 'phase_shift',
        duration,
        remaining: duration,
      });
    }
  }

  /**
   * Feeds the shared per-frame danger signal into the automatic-defence model
   * (Q1/Q2/Q3; AH-0MUZE4AIP009HZWC). Call once per frame after {@link tick}.
   *
   * When `inDanger` is true, the player is not already phased, danger has
   * cleared since the last activation and the shared re-arm cooldown has
   * elapsed, this selects which defensive ability to spend via
   * {@link selectAutoDefence} (greater charge count wins; an exact tie is a
   * seeded 50/50) and, for Phase Shift, activates the level-resolved
   * `phaseDuration` and consumes one charge (permanent rewards do not
   * consume). Teleport is **not** consumed here — the registry has no player
   * or warp — so the scene performs the warp on the returned decision. Either
   * way the danger episode is latched so at most one ability fires per
   * episode (AC5).
   *
   * @param inDanger — whether the danger helper reports the ship surrounded.
   * @param dt — frame delta in seconds (advances the shared re-arm cooldown).
   * @returns the ability fired/selected this frame, or `null` for none.
   */
  updateDanger(inDanger: boolean, dt: number): DangerDecision {
    if (this._rearmCooldown > 0) {
      this._rearmCooldown = Math.max(0, this._rearmCooldown - dt);
    }
    if (!inDanger) {
      // Danger has cleared — re-arm for the next episode.
      this._dangerCleared = true;
      return null;
    }
    if (this._timed.has('phase_shift')) return null;
    if (!this._dangerCleared) return null;
    if (this._rearmCooldown > 0) return null;

    const store = this._levelStore;
    const choice = selectAutoDefence(
      store.phaseCharges(),
      store.isPhasePermanent(),
      store.teleportStacks(),
      this._rng,
    );
    if (choice === null) return null;

    // Latch the episode regardless of which ability is spent, so a failed or
    // interrupted scene-side Teleport does not retry every frame (AC5).
    this._dangerCleared = false;

    if (choice === 'phase_shift') {
      // `consumePhaseCharge` returns false only when neither a real charge
      // nor the permanent reward is available (AC3: one derived model).
      if (!store.consumePhaseCharge()) return null;
      this._activatePhase(store.stats('phase_shift').phaseDuration ?? 1.5);
    }
    return choice;
  }

  /** Stored Phase Shift auto-activation charges (0 for a permanent reward). */
  phaseCharges(): number {
    return this._levelStore.phaseCharges();
  }

  /** Whether the hold-full reward granted unlimited Phase Shift activations. */
  isPhasePermanent(): boolean {
    return this._levelStore.isPhasePermanent();
  }

  /** Stored teleport uses (Teleport). */
  teleportStacks(): number {
    return this._levelStore.teleportStacks();
  }

  /** Whether at least one teleport use is stored. */
  hasTeleport(): boolean {
    return this._levelStore.teleportStacks() > 0;
  }

  /**
   * Consumes one stored teleport use (FIFO — one stack) and grants
   * Phase Shift at the landing spot. Returns true if consumed, false
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
   * Current movement multiplier from speed_boost: the level-resolved
   * `speedMultiplier` while active, else 1.
   */
  speedMultiplier(): number {
    if (!this._timed.has('speed_boost')) return 1;
    return this._levelStore.stats('speed_boost').speedMultiplier ?? 1;
  }

  /**
   * Current fire-rate multiplier from speed_boost: the same level-resolved
   * `speedMultiplier` while active, else 1, so both axes cannot diverge
   * (single source of truth — AC2/AC3).
   */
  fireRateMultiplier(): number {
    return this.speedMultiplier();
  }

  /** Current lives count (Extra Life model); starts at 3, capped level-resolved. */
  lives(): number {
    return this._levelStore.lives();
  }

  /**
   * Sets the lives counter directly (clamped to `[0, livesCap]`).
   * Lets the playable game drive the HUD from its authoritative run state
   * (GameState) when a player is hit; Extra Life collection still uses
   * `applyCollect('extra_life')`.
   */
  setLives(value: number): void {
    this._levelStore.setLives(value);
  }

  /** Current permanent magnet stack count (Magnet); level-capped. */
  magnetStacks(): number {
    return this._levelStore.magnetStacks();
  }

  /** Whether any magnet effect (timed or permanent) is currently active. */
  isMagnetActive(): boolean {
    return this._timed.has('magnet') || this._levelStore.magnetStacks() > 0;
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
    return this._timed.has('magnet') ? 1 : 0;
  }

  /** Current permanent mineral-scoop stack count (Mineral Scoop); level-capped. */
  scoopStacks(): number {
    return this._levelStore.scoopStacks();
  }

  /** Whether the timed Mineral Scoop field-pickup mineral attraction is active. */
  isScoopActive(): boolean {
    return this._timed.has('mineral_scoop');
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
    return this._timed.has('mineral_scoop') ? 1 : 0;
  }

  // ── Frightened enemy status (Power Pellet, AH-0MV1BIW95004POSX) ─────

  /**
   * Whether the Power Pellet fright window is active — every live enemy
   * flees the ship and suppresses fire while true. A permanent (hold-full)
   * reward keeps the state active for the rest of the run.
   */
  isFrightened(): boolean {
    const effect = this._timed.get('power_pellet');
    if (!effect) return false;
    if (effect.permanent && !effect.tempWindow) return true;
    return effect.remaining > 0;
  }

  /**
   * Seconds the fright window has been active (0 when inactive). The shared
   * flee-offset maths uses this to retreat enemies further the longer the
   * window has been open; a permanent window saturates at the default
   * duration (the offset is capped regardless).
   */
  frightenElapsed(): number {
    const effect = this._timed.get('power_pellet');
    if (!effect) return 0;
    if (effect.permanent && !effect.tempWindow) {
      return FRIGHTEN_DEFAULT_DURATION;
    }
    return Math.max(0, effect.duration - effect.remaining);
  }

  /** The level-resolved flee-speed multiplier for the active Power Pellet. */
  frightenSpeedMultiplier(): number {
    return this._levelStore.stats('power_pellet').frightenSpeedMultiplier ?? 1;
  }

  // ── Weapon accessors ──────────────────────────────────────────────

  /** Current active timed weapons (id → remaining seconds). */
  activeWeapons(): WeaponEffect[] {
    return Array.from(this._weapons.values());
  }

  // ── HUD level accessors (AH-0MUX802450085VZZ) ────────────────────

  /**
   * The **effective** run-scoped level of a power-up
   * (`permanentGrants + tempStacks`, 0 when unowned). Consumed by the HUD
   * so a single row shows the current level (AC5).
   */
  powerUpLevel(id: PowerUpId): number {
    return this._levelStore.getEffectiveLevel(id);
  }

  /**
   * Seconds remaining on the power-up's active **temporary** window, or
   * `undefined` when no temporary level-up is active for the item (its
   * level is permanent for the run). Drives the HUD's `∞`/countdown value:
   * a permanent base with no window reads `∞`; an active field-pickup (or
   * timed-effect) window reads a countdown (AC1/AC5).
   *
   * A permanent base with an active field window still returns the window's
   * remaining seconds; a permanent base with no window never does.
   */
  powerUpTemporaryRemaining(id: PowerUpId): number | undefined {
    const effect = this._timed.get(id);
    if (!effect) return undefined;
    if (effect.permanent && !effect.tempWindow) return undefined;
    return Math.max(0, effect.remaining);
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
      if (permanent) {
        // A hold-full reward makes the base permanent; an already-active
        // field window keeps counting down on its own schedule, so the HUD
        // still shows a timer until it expires (mirrors power-ups, AC2).
        existing.permanent = true;
        return false; // already active, upgraded to permanent
      }
      // A field pickup (re)opens the temporary window (AC1).
      existing.tempWindow = true;
      existing.remaining = WEAPON_EFFECT_DURATION;
      return false; // already active, refreshed
    }
    this._weapons.set(weaponId, {
      weaponId,
      duration: WEAPON_EFFECT_DURATION,
      remaining: WEAPON_EFFECT_DURATION,
      ...(permanent ? { permanent: true } : { tempWindow: true }),
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
   * the aggregated model the standalone HUD renders from. Teleport teleport is
   * included as a stack entry when any uses are stored. Weapons are
   * exposed separately via `activeWeapons()`.
   */
  activeEffects(): ActiveEffect[] {
    const result: ActiveEffect[] = [];
    for (const effect of this._timed.values()) {
      // Shield carries its remaining absorptions so the HUD renders `Shield xN`
      // and updates as hits are absorbed (AC6).
      const stacks =
        effect.id === 'shield'
          ? this._shieldRemaining
          : effect.id === 'force_field'
            ? this._forceFieldRemaining
            : undefined;
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
    // Magnet permanent upgrades render as a stack row; the timed field pickup
    // is already surfaced from `_timed` above. A zero stack count is never
    // surfaced (no misleading "x0").
    const magnetStacks = this._levelStore.magnetStacks();
    if (magnetStacks > 0) {
      result.push({
        id: 'magnet' as PowerUpId,
        type: 'magnet',
        stacks: magnetStacks,
      });
    }
    // Mineral Scoop permanent upgrades render as a stack row; the timed field pickup
    // is already surfaced from `_timed` above. A zero stack count is never
    // surfaced (no misleading "x0").
    const scoopStacks = this._levelStore.scoopStacks();
    if (scoopStacks > 0) {
      result.push({
        id: 'mineral_scoop' as PowerUpId,
        type: 'mineral_scoop',
        stacks: scoopStacks,
      });
    }
    // A permanent Bomb bomb is a run-scoped active effect (never expires); a
    // field pickup leaves no row (AC6).
    if (this._bombPermanent) {
      result.push({
        id: 'bomb' as PowerUpId,
        type: 'bomb',
        permanent: true,
      });
    }
    // A permanent Smart Bomb likewise renders one run-scoped row; a field
    // pickup leaves no row (AH-0MV1BIWP9003EHRQ).
    if (this._smartBombPermanent) {
      result.push({
        id: 'smart_bomb' as PowerUpId,
        type: 'smart_bomb',
        permanent: true,
      });
    }
    const teleportStacks = this._levelStore.teleportStacks();
    if (teleportStacks > 0) {
      result.push({
        id: 'teleport' as PowerUpId,
        type: 'teleport',
        stacks: teleportStacks,
      });
    }
    // Phase Shift auto-activation charges (parent AH-0MUIYX1EE008FVS8): a finite
    // stock-pile renders as a count, the hold-full reward as unlimited. A
    // zero charge count is never surfaced (no misleading "x0").
    if (this.isPhasePermanent()) {
      result.push({
        id: 'phase_shift' as PowerUpId,
        type: 'phase_shift',
        permanent: true,
      });
    } else {
      const phaseCharges = this._levelStore.phaseCharges();
      if (phaseCharges > 0) {
        result.push({
          id: 'phase_shift' as PowerUpId,
          type: 'phase_shift',
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
    this._dangerCleared = true;
    this._rearmCooldown = 0;
    this._shieldRemaining = 0;
    this._bombPermanent = false;
    this._bombPulseTimer = 0;
    this._bombPulsePending = false;
    this._smartBombPermanent = false;
    this._smartBombPulseTimer = 0;
    this._smartBombPulsePending = false;
    this._forceFieldRemaining = 0;
    this._levelStore.reset();
  }
}
