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
 * - **Shield** — one charge absorbs one hit (base cap 1, cap 3): a field
 *   pickup grants exactly one charge into the shared pool and opens no effect
 *   window; the bubble is drawn while a charge is held and pops on the last
 *   absorb. A hold-full reward makes the Shield **permanently owned**: it adds
 *   one charge (never a level) and the pool regenerates on `shieldRecharge`
 *   (parent AH-0MVTQMREN009DSFW AC1). A pickup-only charge never regenerates
 *   (Q-A1=b, AH-0MVUVSW4J0009QUW).
 * - **Bomb** — ranged periodic clear (AH-0MUVM9RAO004Y3LB): the model
 *   exposes `bombRange` (px) and `bombFrequency` (pulses/s); the effect path
 *   clears on-screen enemy bullets within the resolved range (a single pulse
 *   for a field pickup, an immediate-then-periodic pulse when permanent),
 *   without damaging 1-HP enemies (GDD §4.4).
 * - **Phase Shift** — charge-based auto-trigger (parent
 *   AH-0MUIYX1EE008FVS8). Collecting Phase Shift stores the level-resolved
 *   `phaseCharges` auto-activation charges in a **finite recharging pool**
 *   (the hold-full reward adds exactly one charge — never unlimited,
 *   AH-0MV82I7TX0009JMT); the shared combat core calls
 *   {@link EffectsRegistry.updateDanger} each frame and the registry
 *   activates a `phaseDuration` pass-through the moment the player is in
 *   real danger and a charge is available. Spent charges return through the
 *   shared {@link EffectsRegistry.tick} recharge clock
 *   (AH-0MV82I8IL0012RXY). After expiry it re-arms only once danger has
 *   cleared and a short cooldown has elapsed (Q2/Q3).
 * - **Teleport** — a **single-use** ability with one level-derived recharge
 *   timer (parent AH-0MVY096RT006QMF4): the shared automatic defence feed
 *   consumes the ready warp when Teleport is selected (AH-0MUZE4AIP009HZWC)
 *   and grants Phase Shift for `teleportPhaseDuration` at the landing spot
 *   without consuming an auto-activation charge (Q6). Spending it starts the
 *   one timer, which the shared {@link EffectsRegistry.tick} clock counts
 *   down; there is no stored-use count. Safe-spot resolution is the scene's
 *   responsibility; this module tracks only the readiness state.
 *
 * ## Shared consumable charge pool (parent AH-0MVTQMREN009DSFW)
 *
 * The six consumables (Shield, Thorn Field, Phase Shift, Teleport, Force
 * Field, Mystery UFO) share **one** charge pool in the run-scoped
 * `PowerUpLevelStore`. A hold-full reward adds one charge (never a level); a
 * charge buys exactly one event — one absorbed hit, one free ram, one
 * reflected bullet, one phase, one warp, one drone spawn — and starts its own
 * level-derived regeneration timer. Regeneration advances only from
 * {@link EffectsRegistry.tick}, the single call site the game and every gym
 * share. The armed state and the budget
 * accessors ({@link EffectsRegistry.shieldAbsorptionsRemaining},
 * {@link EffectsRegistry.thornsRemaining},
 * {@link EffectsRegistry.forceFieldRemaining}) project that pool for **all**
 * acquisition paths — a field pickup also grants exactly one charge and opens
 * no effect window, so the pool is the one model for both paths, differing
 * only in whether a charge regenerates (a pickup-only budget charge never
 * refills — the catalogue `regenRequiresOwnership` gate).
 * {@link EffectsRegistry.consumableCharges} and
 * {@link EffectsRegistry.consumableRechargeRemaining} are the HUD read seams.
 *
 * The registry is pure (no Phaser imports). The scene layers
 * movement/ship integration, bullet clearing, hit-response and teleport
 * teleportation on top of it.
 */

import {
  PowerUpId,
  getPowerUpById,
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
  isConsumablePowerUpId,
  resolvePowerUpAtLevel,
  resolveTemporaryWindow,
  type PowerUpLevelStats,
} from './powerUpLevels';
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
   * Seconds until a **single-use** ability is ready again (Teleport), or
   * absent when it is ready. A single-use kind has no stack count, so this
   * countdown is the whole rendering state (parent AH-0MVY096RT006QMF4).
   */
  recharge?: number;
  /**
   * True when the effect is permanently owned for the run and has no timed
   * window (e.g. a hold-full Bomb, or the Phase Shift ownership marker).
   * Rendered as the ∞ permanent value (– the level is permanent for the
   * run), never an unlimited supply: the Phase Shift pool itself is finite,
   * recharges (AH-0MV82I7TX0009JMT) and is surfaced as a ` ×N` pool count.
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
 *   through its shared `triggerTeleport` path (which spends the single ready
 *   warp and grants Phase Shift on arrival).
 * - `null` — nothing should fire this frame.
 */
export type DangerDecision = AutoDefenceChoice | null;

/**
 * Picks the defensive ability to spend from the two readiness flags
 * (AH-0MVY096RT006QMF4 AC7 / AH-0MW231NAR008K9IS AC1):
 *
 * - Neither available → `null`.
 * - Only one available → that ability.
 * - Both available → a uniform 50/50 pick driven by `rng`.
 *
 * Availability is decided by readiness, never by a stock count: Phase Shift is
 * available while it holds **at least one** auto-activation charge, and
 * Teleport is available while its single escape is **ready** (a boolean —
 * Teleport has no stored count any more, parent AH-0MVY096RT006QMF4). The
 * greater-count rule that used to rank the two was retired because Teleport
 * has no count to compare: once it is ready the two escapes are equally
 * valuable, and a levelled Phase Shift pool must not silently starve Teleport
 * (producer answer Q3 = C). The rng is consulted **only** in the
 * both-available case, so single-ability and neither-available frames stay
 * deterministic.
 *
 * Phase Shift contributes its finite charge count only as a readiness test.
 * There is no unbounded /permanent-Infinity branch — the permanent Phase Shift
 * reward is an ownership flag, not an unlimited supply (AH-0MV82I8IL0012RXY
 * AC2).
 *
 * Pure and engine-agnostic so the game and every gym share one rule and the
 * 50/50 split is deterministically testable via an injectable `rng`.
 *
 * @param phaseCharges — available Phase Shift auto-activation charges; any
 *   value `> 0` means available.
 * @param teleportReady — `true` when the single ready Teleport is available,
 *   `false` while it recharges or is not held (there is no stored Teleport
 *   count any more — parent AH-0MVY096RT006QMF4).
 * @param rng — random source in `[0, 1)`; consulted only when both abilities
 *   are available. Injectable/seeded for deterministic tests.
 * @returns the ability to spend, or `null` when none is available.
 */
export function selectAutoDefence(
  phaseCharges: number,
  teleportReady: boolean,
  rng: () => number = Math.random,
): AutoDefenceChoice | null {
  const phaseReady = Math.max(0, phaseCharges) > 0;

  if (!phaseReady && !teleportReady) return null;
  if (phaseReady && !teleportReady) return 'phase_shift';
  if (teleportReady && !phaseReady) return 'teleport';
  // Both ready — uniform 50/50, independent of the Phase Shift charge count.
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
   * base, if any, stays active). Left false for effect timers that do not own
   * a field-pickup window (e.g. the Phase Shift activation, which is timed
   * separately in `_phaseRemaining`).
   */
  tempWindow?: boolean;
  /**
   * True when this entry times a **temporary level window only** — an
   * instant kind (`bomb`, `smart_bomb`, `strike`, `phase_shift`,
   * `teleport`, `extra_life`, `mystery_ufo`) whose gameplay effect is a
   * one-shot/consumable rather than a timed effect (AH-0MVUGI448000GNMJ).
   *
   * A level window must not surface as an active effect (`isActive`,
   * `activeEffects`, `remaining`): it only makes the store's temporary
   * level revert on expiry through the existing `_expireTimedEffect` path.
   * Phase Shift keeps its actual phase activation in a separate timer
   * (`_phaseRemaining`) so the window never makes the ship intangible.
   */
  levelWindow?: boolean;
}

/**
 * Tracks all active power-up effects and their state. Call `applyCollect`
 * when a drop is collected, `tick(dt)` each frame (seconds), and read the
 * aggregated model via the accessors (used by the scene and the HUD).
 *
 * Lives/stack/charge state is **delegated** to the injected run-scoped
 * {@link PowerUpLevelStore}; only timing state (active durations, timers,
 * Phase Shift re-arm) lives here. `tick(dt)` also forwards `dt` to the
 * store's recharge clock, so every scene that ticks the registry (the game
 * and each gym) recovers spent Phase Shift/Teleport charges identically
 * through one shared path (AH-0MV82I8IL0012RXY AC1/AC5).
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

  // ── Phase Shift activation timer (AH-0MVUGI448000GNMJ) ────────────
  /**
   * Seconds remaining on an active Phase Shift phase (auto-activated or
   * granted on a Teleport arrival). Kept separate from the `_timed` map so a
   * field pickup's per-upgrade **level window** can expire independently of
   * the 1.5 s activation — sharing one countdown would either make the ship
   * intangible for the whole window or clobber the window on activation.
   * Zero when not phased.
   */
  private _phaseRemaining = 0;
  /** Full duration of the current phase (HUD/`activeEffects` reporting). */
  private _phaseDuration = 0;

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
  /**
   * Clear radius (px) captured when a pulse is **decided** — at the field
   * pickup that queues it, or at the permanent interval tick
   * (AH-0MVUGI448000GNMJ AC4). A temporary level window may expire between
   * the decision and the frame the pulse fires; the pulse must keep its
   * decision-time stats rather than re-reading a reverted store. Cleared on
   * the next pulse-free advance.
   */
  private _bombPulseRange: number | null = null;

  // ── Smart Bomb pulse state (AH-0MV1BIWP9003EHRQ) ─────────────────────
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
  /**
   * AOE descriptor captured when a pulse is **decided** (pickup or permanent
   * interval tick), mirroring {@link _bombPulseRange} so a reverted temporary
   * level can never re-price an already-decided screen pulse
   * (AH-0MVUGI448000GNMJ AC4). Cleared on the next pulse-free advance.
   */
  private _smartBombPulseAoe: AoEDescriptor | null = null;

  // ── Mystery UFO collector drone (AH-0MV9G113S009B37I) ──────────────
  /**
   * Pending one-shot collector-drone spawns: incremented for every
   * **field** `mystery_ufo` pickup and drained by the shared scene pass via
   * {@link consumeMysteryUfoSpawns}. A full-hull (permanent) reward does not
   * queue a one-shot — it is owned through the level store's permanent grant
   * and drives the periodic auto-spawn instead. Cleared by {@link reset}.
   */
  private _mysteryUfoPendingSpawns = 0;

  // ── Orbital Strike bolt state (AH-0MVCRC1Q0007JAV1) ───────────────
  /**
   * True when a hold-full Strike granted a permanent bolt for the run: it
   * never expires and strikes every {@link strikeInterval} seconds — a
   * whole-beat cadence on the shared 80 BPM grid (6.75 s at the first grant,
   * AH-0MVRE6N08001TE4V). Cleared only by `reset()`.
   */
  private _strikePermanent = false;
  /** Seconds until the next permanent strike (unused when not permanent). */
  private _strikePulseTimer = 0;
  /**
   * One-shot strike request queued by a field pickup. The next
   * {@link updateStrike} latches it (see {@link _strikeLatched}) instead of
   * consuming it, so a bolt decided with no valid target is never lost.
   */
  private _strikePulsePending = false;
  /**
   * True while a decided bolt is **due but unresolved**
   * (AH-0MVS2T2DJ0069C0Y). The registry reports `true` from
   * {@link updateStrike} every frame until the shared combat core calls
   * {@link resolveStrike} after actually landing the bolt, so a strike
   * decided while no live enemy (or no live player) exists is retained and
   * lands on the first valid frame.
   *
   * At most one bolt is ever latched: while it is held the permanent strike
   * interval timer is frozen, so a long enemy-free gap cannot bank a volley.
   * Cleared by {@link resolveStrike} or {@link reset}.
   */
  private _strikeLatched = false;
  /**
   * Damage resolved when the currently latched bolt was **decided**
   * (AH-0MVUGI448000GNMJ AC4). A temporary level window may expire while the
   * bolt waits for a live target, so `strikeDamage()` returns this captured
   * value instead of re-reading the (reverted) level store. Null when no
   * bolt is latched.
   */
  private _strikeLatchedDamage: number | null = null;

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

  /**
   * The level store the registry currently consumes, exposed for read-only
   * ownership checks (HUD/choice surfaces read the consumable owned flag, not
   * just the level — parent AH-0MVTQMREN009DSFW AC1).
   */
  levelStore(): PowerUpLevelStore {
    return this._levelStore;
  }

  /** The level store the registry currently consumes. */
  private get _levelStore(): PowerUpLevelStore {
    return this._storeResolver?.() ?? this._store;
  }

  // ── Shared consumable charge pool (parent AH-0MVTQMREN009DSFW) ─────
  //
  // One pool serves all six consumables: a charge buys one event, charges
  // regenerate on the level-derived interval through the shared `tick` path,
  // and a hold-full reward adds a charge instead of a level. The registry is
  // the single consumption seam, so the game and every gym spend and
  // regenerate identically (F3, AH-0MVUXH1LV0058TS3).

  /**
   * Available charges of the consumable `id` in the run-scoped shared pool.
   *
   * `0` means the pool is empty (and, for a permanently-owned kind, that it is
   * currently disarmed); a non-consumable id always reports `0` because it has
   * no charge pool. HUD-facing (parent AC6).
   */
  consumableCharges(id: PowerUpId): number {
    return this._levelStore.consumableCharges(id);
  }

  /**
   * Whether a hold-full reward has made the consumable `id` **permanently
   * owned** this run. Ownership is a flag, never an endless supply: an owned
   * kind with an empty pool is still visible (greyed) and still regenerating.
   * `false` for a non-consumable id.
   */
  isConsumableOwned(id: PowerUpId): boolean {
    return this._levelStore.isConsumableOwned(id);
  }

  /**
   * Seconds until the next spent charge of the consumable `id` returns, or
   * `undefined` when no countdown applies (parent AC6):
   *
   * - the pool is **full** — nothing is owed, so the HUD shows no countdown;
   * - nothing is **recharging** — a grant below the cap opens no timer, so
   *   there is no fabricated `next in 0s`;
   * - `id` is not a consumable.
   *
   * A live countdown is always `> 0`; regeneration itself advances only on
   * {@link tick} (the shared call site), never here. HUD-facing.
   */
  consumableRechargeRemaining(id: PowerUpId): number | undefined {
    if (!isConsumablePowerUpId(id)) return undefined;
    // A single-use kind has no pool and no `next charge`: its countdown is the
    // readiness clock, read through {@link teleportRechargeRemaining}.
    if (getPowerUpById(id).singleUse === true) return undefined;
    const cap = this._levelStore.consumableChargeCap(id);
    if (cap <= 0) return undefined;
    if (this._levelStore.consumableCharges(id) >= cap) return undefined;
    const remaining = this._levelStore.consumableRechargeRemaining(id);
    return remaining > 0 ? remaining : undefined;
  }

  /**
   * Spends **exactly one** shared-pool charge of the consumable `id`.
   *
   * Returns `false` when the pool is empty (nothing armed) or `id` is not a
   * consumable. The spent charge starts its own level-derived regeneration
   * timer inside the store, which {@link tick} advances — so no scene keeps a
   * second timer (parent AC7). This is the pool-backed spend seam; the
   * per-kind methods below (`tryAbsorbShield`, `tryConsumeThornsRam`,
   * `tryConsumeForceFieldReflect`) are thin routes into it for **all**
   * acquisition paths — pickup and permanent alike — because the absorbed-hit
   * model (AH-0MVVD8SIT000CO9H) retired the field-pickup timed budget.
   */
  tryConsumeConsumableCharge(id: PowerUpId): boolean {
    return this._levelStore.consumeConsumableCharge(id);
  }

  /**
   * Spends one shared-pool charge for one collector-drone spawn (parent AC4).
   *
   * Returns `false` when the pool is empty, so a permanently-owned Mystery UFO
   * spawns at most `mysteryUfoChargeCap` drones per regeneration interval
   * instead of spawning forever. The shared scene spawn path calls this before
   * spawning; a **field** pickup keeps its queued one-shot
   * ({@link consumeMysteryUfoSpawns}) and spends no charge.
   */
  consumeMysteryUfoCharge(): boolean {
    return this.tryConsumeConsumableCharge('mystery_ufo');
  }

  /**
   * Applies the effect of a collected power-up.
   *
   * Advances the single run-scoped level store by exactly one collection,
   * then applies the registry-local timing state resolved from the new
   * level's stats (AC1/AC2/AC3):
   *
   * - shield/force_field/thorns: the level store grants one charge into the
   *   shared consumable pool (absorbed-hit pickup model, no effect window);
   *   the registry opens only the per-upgrade level window.
   * - speed_boost: starts the timed `speedDuration`, or refreshes it to the
   *   new full duration if already active.
   * - bomb: a field pickup queues a single ranged explosion (no persistent
   *   state); the hold-full reward sets the run-scoped permanent flag and
   *   pulses every resolved interval. The shared combat core performs the
   *   actual clear from these requests (it alone knows the player/bullets).
   * - phase_shift: stores the level-resolved `phaseCharges` (or marks the
   *   permanent reward); the phase itself is applied later by the shared
   *   combat core via `updateDanger`.
   * - teleport: the store readies the single warp (no stored count) — a
   *   pickup or hold-full grant resets its one recharge timer to 0.
   * - extra_life: the store grants the level-resolved lives, clamped to the cap.
   * - magnet/mineral_scoop: a field pickup (no flag) starts the timed
   *   refresh-only attraction; the hold-full reward adds a permanent stack via
   *   the store (hybrid preserved).
   *
   * **Every field pickup also gets a temporary level window.** For the timed
   * kinds above the window *is* the effect window (its level-resolved
   * duration); the ten instant kinds (`bomb`, `smart_bomb`, `strike`,
   * `shield`, `force_field`, `thorns`, `phase_shift`, `teleport`,
   * `extra_life`, `mystery_ufo`) open a separate per-upgrade **level window**
   * sized by `resolveTemporaryWindow` (AH-0MVUGI448000GNMJ; parent
   * AH-0MVSTKGC3003OMAC). The declared instant TTLs are catalogue data —
   * Bomb / Smart Bomb / Orbital Strike **10 s**, Phase Shift / Teleport /
   * Mystery UFO **15 s**, Extra Life **10 s**, Shield **15 s**, Thorn Field /
   * Force Field **8 s** (the absorbed-hit kinds, AH-0MVVD8SXO004QLZW) — so no
   * kind is exempt from expiry and retuning one is a data edit. The one-shot
   * or consumable grant lands immediately; the window only makes the temporary
   * level revert to the permanent level (or to unowned) at its TTL, through
   * the existing `clearTemporary` expiry path, and a granted consumable is
   * never clawed back. A hold-full grant opens no window and never resurrects
   * one.
   *
   * @param id — the collected power-up.
   * @param permanent — when true, timed effects never expire for the run
   *   (used by the hold-full choice).
   */
  applyCollect(id: PowerUpId, permanent = false): void {
    const store = this._levelStore;
    // The single mutation point: every collection (field or hold-full)
    // advances the level exactly once and derives the grants (AC1/AC3).
    // Only a **field** pickup opens a temporary window (`_applyTimedEffect`),
    // and every kind resolves one through `resolveTemporaryWindow` (which
    // throws when a kind declares no TTL), so this is the only writer that
    // can pair a temporary stack with its expiry. A permanent grant therefore
    // never strands a stack: it leaves any open window alone and the window's
    // expiry clears the temporary component (AC3/AC4, AH-0MVUGI4IC006PUS5).
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
      case 'thorns':
      case 'force_field': {
        // Absorbed-hit kinds (parent AH-0MVUVSW4J0009QUW, Q-A1=b): the
        // **level store owns the whole model** for these three kinds now. A
        // field pickup grants exactly one charge into the shared pool
        // (clamped at the level-resolved cap) and opens no **effect** window —
        // the per-upgrade level window still opens so the temporary stack
        // reverts at its own TTL (the charge is never clawed back). A
        // hold-full reward is handled by the store (owned + one charge) and
        // opens nothing here.
        if (!permanent) {
          this._levelStore.grantConsumableCharge(id, 1);
          this._openInstantWindow(id);
        }
        break;
      }
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
      case 'bomb':
        // bomb: a field pickup queues one ranged explosion; the hold-full
        // reward additionally makes it permanent and pulses immediately
        // (AH-0MUVM9RAO004Y3LB). The field pickup also opens its per-upgrade
        // level window and snapshots the pulse range at decision time so a
        // reverted level can never re-price the queued pulse
        // (AH-0MVUGI448000GNMJ).
        this._bombPulsePending = true;
        if (permanent) {
          this._bombPermanent = true;
          this._bombPulseTimer = this.bombInterval();
        } else {
          this._bombPulseRange = this.bombRange();
          this._openInstantWindow(id);
        }
        break;
      case 'smart_bomb':
        // smart_bomb: a field pickup queues one ship-centred pulse; the
        // hold-full reward additionally makes it permanent and pulses
        // immediately (mirrors the Bomb; AH-0MV1BIWP9003EHRQ). The field
        // pickup opens its level window and snapshots the pulse AOE
        // (AH-0MVUGI448000GNMJ).
        this._smartBombPulsePending = true;
        if (permanent) {
          this._smartBombPermanent = true;
          this._smartBombPulseTimer = this.smartBombInterval();
        } else {
          this._smartBombPulseAoe = this.smartBombAoe();
          this._openInstantWindow(id);
        }
        break;
      case 'mystery_ufo':
        // mystery_ufo: a visible collector drone (Space Invaders homage,
        // AH-0MV1BIXFO006Z1I7 → AH-0MV9G113S009B37I). A field pickup queues
        // exactly one drone spawn for the shared scene pass and opens its
        // per-upgrade level window; a full-hull permanent reward owns the
        // periodic auto-spawn through the level store's permanent grant.
        // There is no instant mineral or score burst any more.
        if (!permanent) {
          this._mysteryUfoPendingSpawns += 1;
          this._openInstantWindow(id);
        }
        break;
      case 'frenzy':
        // frenzy: a timed damage amplifier. No registry-local consumable
        // state — the shared bullet/AOE damage seams read the level-resolved
        // bonus while the window is active (AH-0MVCRC1Q0007JAV1).
        this._startOrRefreshTimed(
          id,
          id,
          stats.frenzyDuration ?? 8,
          permanent,
        );
        break;
      case 'chrono':
        // chrono: a timed enemy-bullet slowdown. The shared enemy-bullet
        // advance scales dt while the window is active (AH-0MVCRC1Q0007JAV1).
        this._startOrRefreshTimed(
          id,
          id,
          stats.chronoDuration ?? 5,
          permanent,
        );
        break;
      case 'salvage':
        // salvage: a timed mineral bounty. The shared kill-drop seam adds the
        // level-resolved bonus minerals while the window is active.
        this._startOrRefreshTimed(
          id,
          id,
          stats.salvageDuration ?? 10,
          permanent,
        );
        break;
      case 'strike':
        // strike: a field pickup queues one immediate bolt; the hold-full
        // reward makes it permanent and pulses on the resolved interval
        // (mirrors the Bomb/Smart Bomb; AH-0MVCRC1Q0007JAV1). The field
        // pickup also opens its per-upgrade level window
        // (AH-0MVUGI448000GNMJ); the bolt's damage is snapshotted when the
        // bolt is latched.
        this._strikePulsePending = true;
        if (permanent) {
          this._strikePermanent = true;
          this._strikePulseTimer = this.strikeInterval();
        } else {
          this._openInstantWindow(id);
        }
        break;
      case 'phase_shift':
      case 'teleport':
      case 'extra_life':
        // Consumable/one-shot kinds: the level store owns the charge/stack/
        // life grant (never deferred to the window), and the field pickup
        // still opens its per-upgrade level window so the temporary level
        // reverts (AH-0MVUGI448000GNMJ). Phase Shift's actual phase
        // activation is a separate timer (`_phaseRemaining`), so the window
        // never makes the ship intangible. A hold-full grant opens no window.
        if (!permanent) this._openInstantWindow(id);
        break;
      default:
        // Every POWER_UP_LEVEL_IDS kind is handled above; the default keeps
        // the switch exhaustive if a future kind is added.
        break;
    }
  }

  /**
   * Opens (or refreshes) the per-upgrade **temporary level window** a field
   * pickup of an instant kind grants (AH-0MVUGI448000GNMJ; parent
   * AH-0MVSTKGC3003OMAC).
   *
   * The window is sized by the shared `resolveTemporaryWindow` resolver at
   * the effective upgrade level the pickup lands at, so the TTL is
   * per-upgrade data rather than a global constant — catalogue data for the
   * instant kinds (Bomb / Smart Bomb / Orbital Strike 10 s, Phase Shift /
   * Teleport / Mystery UFO 15 s, Extra Life 10 s) and the level-resolved
   * effect duration for the timed kinds. Re-collecting during an
   * open window refreshes it to the full TTL — one timer per kind, never
   * additive (AC5).
   *
   * The entry is a *level window only*: it never surfaces as an active timed
   * effect (`isActive`/`activeEffects`/`remaining`) and never activates the
   * kind's gameplay effect; its sole job is to clear the store's temporary
   * stack when it expires through the existing `_expireTimedEffect` path. A
   * hold-full grant must never call this: it opens no window and never
   * resurrects an expired one (AC2).
   */
  private _openInstantWindow(id: PowerUpId): void {
    const window = resolveTemporaryWindow(
      id,
      this._levelStore.getUpgradeLevel(id),
    );
    this._startOrRefreshTimed(id, id, window, false, true);
  }

  /** Starts a timed effect or refreshes it to the (possibly new) duration. */
  private _startOrRefreshTimed(
    id: PowerUpId,
    type: PowerUpId,
    duration: number,
    permanent: boolean,
    levelWindowOnly = false,
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
      if (levelWindowOnly) existing.levelWindow = true;
    } else {
      this._timed.set(id, {
        id,
        type,
        duration,
        remaining: permanent ? 0 : duration,
        ...(permanent ? { permanent: true } : { tempWindow: true }),
        ...(levelWindowOnly ? { levelWindow: true } : {}),
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
   * Advances timers by `dt` seconds: the run-scoped recharge clock (a spent
   * Phase Shift/Teleport charge returns to its finite pool when its timer
   * elapses) and the timed effect/weapon windows, removing expired effects
   * and weapons. Permanent effects (granted by the hold-full choice) never
   * expire, but an active temporary field-pickup window on top of one still
   * expires and clears the store's temporary level (AC1/AC2).
   */
  tick(dt: number): void {
    // Advance the run-scoped recharge clock through the shared tick path, so
    // the game and every gym recover spent Phase Shift/Teleport charges
    // identically (AH-0MV82I8IL0012RXY AC1/AC5). The store ignores
    // non-positive/non-finite `dt`.
    this._levelStore.tickRecharge(dt);
    // Advance the Phase Shift activation timer. It is deliberately separate
    // from the `_timed` level window: the 1.5 s phase must expire long before
    // a field pickup's 15 s level window, and its expiry starts the shared
    // re-arm cooldown (existing behaviour, unchanged).
    this._advancePhase(dt);
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
  }

  /**
   * Advances the Phase Shift activation timer by `dt` seconds. When the
   * phase expires the shared re-arm cooldown starts (Q2/Q3) — covering both
   * an auto-activated Phase Shift and the Phase Shift granted on a Teleport
   * arrival (AC5). The level window is a separate entry/timer and is never
   * touched here.
   */
  private _advancePhase(dt: number): void {
    if (this._phaseRemaining <= 0) return;
    this._phaseRemaining = Math.max(0, this._phaseRemaining - dt);
    if (this._phaseRemaining > 0) return;
    this._phaseDuration = 0;
    this._rearmCooldown = PHASE_REARM_COOLDOWN;
  }

  /** Whether the given timed effect is currently active. */
  isActive(id: PowerUpId): boolean {
    const effect = this._timed.get(id);
    return effect !== undefined && effect.levelWindow !== true;
  }

  /**
   * Whether the ship is shielded (Shield active).
   *
   * Armed means the shared charge pool holds at least one charge (parent
   * AH-0MVTQMREN009DSFW AC1 / AH-0MVUVSW4J0009QUW): a field pickup grants
   * exactly one charge and no effect window, so the pool is the whole model —
   * the bubble is drawn while a charge is held and pops on the last absorb.
   */
  get isShielded(): boolean {
    return this._levelStore.consumableCharges('shield') > 0;
  }

  /** Whether the ship is in phase shift (Phase Shift active) — intangibility. */
  get isPhased(): boolean {
    return this._phaseRemaining > 0;
  }

  /** Whether the ship is hit-immune (shield OR phase active). */
  get isHitImmune(): boolean {
    return this.isShielded || this.isPhased;
  }

  /**
   * Absorbs a hit with the shield (Shield): spends exactly one shared-pool
   * charge and returns true (hit absorbed), false at zero. One charge = one
   * absorbed hit; the bubble pops when the last charge is spent (parent
   * AH-0MVTQMREN009DSFW AC1). A pickup-only charge is never regenerated
   * (Q-A1=b), so an unowned Shield stays inert after its one event.
   *
   * Phase does NOT absorb — it prevents hits via pass-through before they
   * are tested (scene should skip collision checks when phased).
   */
  tryAbsorbShield(): boolean {
    return this.tryConsumeConsumableCharge('shield');
  }

  /**
   * Hits the active Shield shield can still absorb (0 when disarmed). The
   * pool is the whole model (parent AH-0MVTQMREN009DSFW AC1): the armed state
   * and the HUD stack read one source, never a parallel window counter.
   */
  shieldAbsorptionsRemaining(): number {
    return this._levelStore.consumableCharges('shield');
  }

  // ── Force Field reflector (AH-0MV1BIX1W006XF95) ──────────────────────

  /**
   * Whether the Force Field reflect bubble is active. While true an enemy
   * bullet that meets the bubble is bounced back as a player-owned bullet
   * (until the reflect budget is spent).
   *
   * A permanently-owned bubble stays up for the run — dimmed while its shared
   * charge pool is empty and bright again as a charge returns (parent AC3). A
   * field pickup grants exactly one charge and no effect window, so a
   * pickup-only bubble is armed while the pool holds a charge and pops when
   * it is spent (parent AH-0MVUVSW4J0009QUW).
   */
  isForceFieldActive(): boolean {
    return (
      this._levelStore.isConsumableOwned('force_field') ||
      this._levelStore.consumableCharges('force_field') > 0
    );
  }

  /**
   * Enemy bullets the active Force Field can still reflect (0 when inactive
   * or exhausted). Surfaced for the HUD's `Force Field ×N` row and consumed
   * by the shared combat core's reflect branch. The pool is the whole model
   * (parent AC3): never a parallel window counter.
   */
  forceFieldRemaining(): number {
    return this._levelStore.consumableCharges('force_field');
  }

  /**
   * The reflect bubble radius in px (`SHIP_SIZE × FORCE_FIELD_RADIUS_FACTOR`).
   * The shared bubble visual and the combat-core reflect branch use the same
   * value, so the drawn boundary and the gameplay boundary cannot diverge.
   */
  forceFieldRadius(): number {
    return SHIP_SIZE * FORCE_FIELD_RADIUS_FACTOR;
  }

  // ── Mystery UFO collector drone (AH-0MV9G113S009B37I) ────────────────

  /**
   * Drains and returns the number of collector drones a field
   * `mystery_ufo` pickup has queued since the last drain. The shared scene
   * pass spawns exactly that many drones, so every pickup produces exactly
   * one visible collector. Draining (not merely reading) means a pickup is
   * granted exactly once, even if two land in the same frame.
   */
  consumeMysteryUfoSpawns(): number {
    const pending = this._mysteryUfoPendingSpawns;
    this._mysteryUfoPendingSpawns = 0;
    return pending;
  }

  /**
   * Whether the full-hull (permanent) Mystery UFO reward has been taken —
   * i.e. the ship owns at least one permanent grant. While true the shared
   * scene pass keeps a collector drone spawning on the level-resolved
   * interval.
   */
  isMysteryUfoPermanent(): boolean {
    // Ownership is the per-kind flag now that a hold-full reward of a
    // consumable adds a charge instead of a level (parent AH-0MVTQMREN009DSFW
    // AC1); the shipped permanent-grant count is kept as a fallback so a
    // scripted setup that set a permanent level still reads as owned.
    return (
      this._levelStore.isConsumableOwned('mystery_ufo') ||
      this._levelStore.permanentGrants('mystery_ufo') > 0
    );
  }

  /**
   * The level-resolved interval (seconds) between permanent collector-drone
   * spawns: 30 s at level 0, descending by 2 s per level to a 12 s floor.
   * Surfaced for the HUD/help copy, tests and the shared spawn timer.
   */
  mysteryUfoSpawnInterval(): number {
    const level = this._levelStore.getEffectiveLevel('mystery_ufo');
    return Math.max(
      0,
      resolvePowerUpAtLevel('mystery_ufo', level).mysteryUfoSpawnInterval ??
        0,
    );
  }

  /**
   * Consumes one reflect from the active Force Field. Returns true when a
   * reflection is available (pool holds a charge) and spends exactly one
   * charge; false at zero. Once false, enemy bullets damage the ship normally
   * again. An empty pool leaves an owned bubble up but inert until a charge
   * returns (parent AC3); a pickup-only charge is never regenerated (Q-A1=b).
   */
  tryConsumeForceFieldReflect(): boolean {
    return this.tryConsumeConsumableCharge('force_field');
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
   * The clear radius the **currently decided** Bomb pulse will use: the
   * radius captured when the pulse was decided (pickup or permanent interval
   * tick), falling back to the live value when no pulse is in flight
   * (AH-0MVUGI448000GNMJ AC4). The shared combat core reads this after
   * {@link updateBomb} reports a pulse, so a temporary level window that
   * expires before the pulse fires can never re-price it.
   */
  bombPulseRange(): number {
    return this._bombPulseRange ?? this.bombRange();
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
      // A queued pulse keeps its pickup-time radius; a permanent grant that
      // queued it falls back to the level resolved now.
      this._bombPulseRange ??= this.bombRange();
      if (this._bombPermanent) {
        this._bombPulseTimer = this.bombInterval();
      }
      return true;
    }
    if (!this._bombPermanent) {
      // The pulse is resolved; the next request resolves its own stats.
      this._bombPulseRange = null;
      return false;
    }
    this._bombPulseTimer -= dt;
    if (this._bombPulseTimer <= 0) {
      this._bombPulseTimer = this.bombInterval();
      this._bombPulseRange = this.bombRange();
      return true;
    }
    this._bombPulseRange = null;
    return false;
  }

  // ── Smart Bomb screen pulse (AH-0MV1BIWP9003EHRQ) ────────────────────

  /** Whether a permanent (hold-full) Smart Bomb is active for the run. */
  isSmartBombPermanent(): boolean {
    return this._smartBombPermanent;
  }

  /**
   * The resolved Smart Bomb pulse rate in pulses per second at the current
   * level — the derived inverse (`1 / interval`) of the stored descending
   * interval schedule, monotonic non-decreasing by construction. Resolved
   * live, so a level-up mid-run quickens every subsequent pulse.
   */
  smartBombFrequency(): number {
    const interval = this.smartBombInterval();
    return Number.isFinite(interval) && interval > 0
      ? 1 / interval
      : 0;
  }

  /**
   * The resolved Smart Bomb pulse interval in seconds: `max(10, 30 − 2×level)`
   * (30 s on the first grant, 10 s at and beyond level 10). Stored
   * descending on the level schedule so the shared effect path reads it
   * directly; {@link smartBombFrequency} is its monotonic inverse.
   */
  smartBombInterval(): number {
    const interval = this._levelStore.stats('smart_bomb').smartBombInterval;
    return interval !== undefined && Number.isFinite(interval) && interval > 0
      ? interval
      : Number.POSITIVE_INFINITY;
  }

  /**
   * The shared {@link AoEDescriptor} describing one Smart Bomb pulse: a
   * ship-centred (`aoeRadius`) area that damages every enemy once for the
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
      radius: stats.aoeRadius ?? 200,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      damage: Math.max(1, Math.floor(stats.smartBombDamage ?? 1)),
    };
  }

  /**
   * The AOE descriptor of the **currently decided** Smart Bomb pulse: the
   * descriptor captured when the pulse was decided (pickup or permanent
   * interval tick), falling back to the live value when no pulse is in
   * flight (AH-0MVUGI448000GNMJ AC4). The shared combat core reads this after
   * {@link updateSmartBomb} reports a pulse.
   */
  smartBombPulseAoe(): AoEDescriptor {
    return this._smartBombPulseAoe ?? this.smartBombAoe();
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
   * ship-centred area clear/damage through {@link smartBombAoe} so the game
   * and every gym run the same code.
   *
   * @param dt - Frame delta in seconds.
   * @returns True when a pulse should be applied this frame.
   */
  updateSmartBomb(dt: number): boolean {
    if (this._smartBombPulsePending) {
      this._smartBombPulsePending = false;
      // A queued pulse keeps its pickup-time AOE; a permanent grant that
      // queued it falls back to the level resolved now.
      this._smartBombPulseAoe ??= this.smartBombAoe();
      if (this._smartBombPermanent) {
        this._smartBombPulseTimer = this.smartBombInterval();
      }
      return true;
    }
    if (!this._smartBombPermanent) {
      this._smartBombPulseAoe = null;
      return false;
    }
    this._smartBombPulseTimer -= dt;
    if (this._smartBombPulseTimer <= 0) {
      this._smartBombPulseTimer = this.smartBombInterval();
      this._smartBombPulseAoe = this.smartBombAoe();
      return true;
    }
    this._smartBombPulseAoe = null;
    return false;
  }

  // ── Frenzy damage amplifier (AH-0MVCRC1Q0007JAV1) ────────────────────

  /**
   * Bonus damage hits each player bullet currently applies, or 0 while the
   * Frenzy window is inactive. The shared bullet/AOE damage seams read this
   * so the game and every gym amplify identically.
   */
  frenzyBonusHits(): number {
    if (!this._timed.has('frenzy')) return 0;
    return Math.max(0, Math.floor(this._levelStore.stats('frenzy').frenzyBonusHits ?? 1));
  }

  // ── Chrono Field enemy-bullet slowdown (AH-0MVCRC1Q0007JAV1) ────────

  /**
   * Current enemy-bullet speed scale (1 = normal, <1 while the Chrono Field
   * window is active). The shared enemy-bullet advance multiplies dt by this
   * so the game and every gym slow bullets identically.
   */
  enemyBulletTimeScale(): number {
    if (!this._timed.has('chrono')) return 1;
    const slow = this._levelStore.stats('chrono').chronoSlowFactor ?? 0.5;
    return Math.max(0, Math.min(1, 1 - slow));
  }

  // ── Thorn Field ram counter (AH-0MVCRC1Q0007JAV1) ──────────────────

  /**
   * Rams the active Thorn Field can still absorb (0 when inactive or
   * exhausted). Surfaced for the HUD and consumed by the shared collision
   * ram branch. The pool is the whole model (parent AC2): never a parallel
   * window counter.
   */
  thornsRemaining(): number {
    return this._levelStore.consumableCharges('thorns');
  }

  /**
   * Whether the ramp counter can absorb another ram right now (the pool
   * holds at least one charge).
   */
  hasThornsRam(): boolean {
    return this.thornsRemaining() > 0;
  }

  /**
   * Consumes one ram absorb from the active Thorn Field. Returns true when
   * a ram was absorbed (the player does not take the hit) and spends exactly
   * one charge; false at zero. Once false, rams cost the player a hit
   * normally again. A pickup-only charge is never regenerated (Q-A1=b); an
   * owned field re-arms on the level-derived interval (parent AC2).
   */
  tryConsumeThornsRam(): boolean {
    return this.tryConsumeConsumableCharge('thorns');
  }

  /**
   * The level-resolved maximum ram budget of the Thorn Field (base 2 → cap
   * 6) — the pool's charge cap. Bound so a regeneration can never exceed what
   * a fresh collection grants; clamped to at least 1 so the field always has
   * a usable budget. The HUD/aura show the same cap the pool enforces.
   */
  thornsMaxAbsorbs(): number {
    return Math.max(1, this._levelStore.consumableChargeCap('thorns'));
  }

  /**
   * Seconds between automatic ram recharges at the current Thorn Field
   * level — the level-derived `thornsRecharge` interval (12 s base → 5 s
   * floor). Returns 0 when no interval is configured, which disables the
   * recharge.
   */
  thornsRechargeTime(): number {
    return this._levelStore.consumableRechargeTime('thorns');
  }

  /**
   * Seconds until the active Thorn Field regains one spent ram, or 0 when
   * it is not recharging. The shared pool's clock is the only regeneration
   * source (parent AC2): an owned field's spent charge counts down on the
   * level-derived interval, while a pickup-only charge never starts a clock
   * (Q-A1=b), so an unowned field reads 0. Surfaced for the HUD's `next ram
   * in Ns` countdown and read by the shared aura helper, so both stay pure
   * functions of registry state.
   */
  thornsRechargeRemaining(): number {
    return this.consumableRechargeRemaining('thorns') ?? 0;
  }

  // ── Salvage mineral bounty (AH-0MVCRC1Q0007JAV1) ────────────────────

  /**
   * Bonus minerals each destroyed enemy currently drops, or 0 while the
   * Salvage window is inactive. The shared kill-drop sears adds this at the
   * wreck so the game and every gym pay out identically.
   */
  salvageBonusMinerals(): number {
    if (!this._timed.has('salvage')) return 0;
    return Math.max(0, Math.round(this._levelStore.stats('salvage').salvageMinerals ?? 1));
  }

  // ── Orbital Strike auto-targeting bolt (AH-0MVCRC1Q0007JAV1) ────────

  /** Whether a permanent (hold-full) Orbital Strike is active for the run. */
  isStrikePermanent(): boolean {
    return this._strikePermanent;
  }

  /**
   * The resolved strike interval in seconds: a whole-beat cadence on the
   * shared 80 BPM grid (`src/utils/beat.ts`) — **9 beats = 6.75 s (~7 s) on
   * the first grant**, one beat (0.75 s) sooner per level, floored at
   * **3 beats = 2.25 s** (AH-0MVRE6N08001TE4V). The beat-aligned cadence keeps
   * every bolt on the pulse the rest of the game's cues are quantised to. The
   * seconds themselves live in `POWER_UP_LEVEL_SPECS.strike`; the constants in
   * `src/core/constants.ts` state the same cadence in beats.
   */
  strikeInterval(): number {
    const interval = this._levelStore.stats('strike').strikeInterval;
    return interval !== undefined && Number.isFinite(interval) && interval > 0
      ? interval
      : Number.POSITIVE_INFINITY;
  }

  /**
   * The level-resolved damage the Orbital Strike bolt deals (whole hits,
   * minimum 1). While a bolt is latched this is the damage resolved **when
   * the bolt was decided**, so a temporary level window that expires while
   * the bolt waits for a target can never weaken or re-price it
   * (AH-0MVUGI448000GNMJ AC4). With no bolt latched it resolves live.
   */
  strikeDamage(): number {
    return this._strikeLatchedDamage ?? this._resolveStrikeDamage();
  }

  /** Live (current-level) Orbital Strike damage. */
  private _resolveStrikeDamage(): number {
    return Math.max(
      1,
      Math.floor(this._levelStore.stats('strike').strikeDamage ?? 1),
    );
  }

  /**
   * Advances the Orbital Strike bolt state by `dt` and reports whether a
   * bolt is due this frame.
   *
   * - A field pickup queues exactly one bolt. A permanent strike fires
   *   immediately on grant and then once per {@link strikeInterval} seconds
   *   for the rest of the run — at the first grant that is 6.75 s (9 beats of
   *   the shared 80 BPM grid, ~7 s), shortening by one beat per level to a
   *   2.25 s floor (AH-0MVRE6N08001TE4V).
   * - A decided bolt is **latched**, not consumed: `true` is reported on
   *   every frame until the shared combat core acknowledges it through
   *   {@link resolveStrike} once the bolt has actually landed. That keeps a
   *   bolt decided with no live enemy (or no live player) from being
   *   silently wasted (AH-0MVS2T2DJ0069C0Y).
   * - While a bolt is latched the permanent interval timer is frozen, so at
   *   most one bolt is ever retained and a long enemy-free gap cannot bank a
   *   volley.
   *
   * The registry owns the decision; the shared combat core selects the
   * nearest enemy, resolves the damage and then acknowledges
   * (AH-0MVCRC1Q0007JAV1).
   *
   * @param dt - Frame delta in seconds.
   * @returns True when a bolt is due (retried every frame until resolved).
   */
  updateStrike(dt: number): boolean {
    if (this._strikeLatched) return true;
    if (this._strikePulsePending) {
      this._strikePulsePending = false;
      this._strikeLatched = true;
      // Resolve once, at decision time (AC4).
      this._strikeLatchedDamage = this._resolveStrikeDamage();
      if (this._strikePermanent) {
        this._strikePulseTimer = this.strikeInterval();
      }
      return true;
    }
    if (!this._strikePermanent) return false;
    this._strikePulseTimer -= dt;
    if (this._strikePulseTimer <= 0) {
      this._strikePulseTimer = this.strikeInterval();
      this._strikeLatched = true;
      this._strikeLatchedDamage = this._resolveStrikeDamage();
      return true;
    }
    return false;
  }

  /**
   * Acknowledges that the latched Orbital Strike bolt has been resolved (its
   * damage was applied), consuming it (AH-0MVS2T2DJ0069C0Y).
   *
   * Called by the shared core only after `CombatCoreScene.onOrbitalStrike`
   * reports the bolt actually landed. A no-op when no bolt is latched, so an
   * acknowledgement with nothing due can never mint a bolt. A bolt that could
   * not be resolved (no live enemy or no live player) is left latched and is
   * retried on the next frame.
   */
  resolveStrike(): void {
    this._strikeLatched = false;
    this._strikeLatchedDamage = null;
  }

  /**
   * Seconds until the next Orbital Strike bolt for a **permanent** (hold-full)
   * strike, or `undefined` when the countdown does not apply
   * (AH-0MVS2T40T006QL7H).
   *
   * Read-only projection of the registry's own strike clock — the very
   * `_strikePulseTimer` that {@link updateStrike} advances — so the HUD renders
   * the countdown without recomputing the level-resolved interval. The value is
   * `undefined` (never a fabricated number) when:
   *
   * - no permanent strike is armed — a field pickup is a one-shot and leaves no
   *   HUD row, so there is no interval to count down; or
   * - a bolt is currently latched/landing — the permanent interval timer is
   *   frozen while the bolt is retained (AH-0MVS2T2DJ0069C0Y), so a countdown
   *   would stall and misreport the remaining time.
   *
   * @returns Seconds until the next bolt (always `> 0` and finite), or
   *   `undefined` when the countdown is not applicable.
   */
  strikeNextBoltSeconds(): number | undefined {
    if (!this._strikePermanent || this._strikeLatched) return undefined;
    const seconds = this._strikePulseTimer;
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return seconds;
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
    // Refresh, never additive. A field pickup's level window lives in the
    // `_timed` map and is deliberately untouched by an activation, so the
    // phase cannot shorten or extend the temporary level's TTL.
    this._phaseDuration = duration;
    this._phaseRemaining = duration;
  }

  /**
   * Feeds the shared per-frame danger signal into the automatic-defence model
   * (Q1/Q2/Q3; AH-0MUZE4AIP009HZWC). Call once per frame after {@link tick}.
   *
   * When `inDanger` is true, the player is not already phased, danger has
   * cleared since the last activation and the shared re-arm cooldown has
   * elapsed, this selects which defensive ability to spend via
   * {@link selectAutoDefence} (Phase Shift available above zero charges,
   * Teleport available while ready — a uniform 50/50 whenever both are) and,
   * for Phase Shift, activates the level-resolved `phaseDuration` and consumes
   * one charge from the **finite** pool (the permanent reward is an ownership
   * flag — never an unlimited supply).
   * Teleport is **not** consumed here — the registry has no player or warp —
   * so the scene performs the warp on the returned decision. Either way the
   * danger episode is latched so at most one ability fires per episode
   * (AC5).
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
    if (this.isPhased) return null;
    if (!this._dangerCleared) return null;
    if (this._rearmCooldown > 0) return null;

    const store = this._levelStore;
    const choice = selectAutoDefence(
      store.phaseCharges(),
      store.hasTeleport(),
      this._rng,
    );
    if (choice === null) return null;

    // Latch the episode regardless of which ability is spent, so a failed or
    // interrupted scene-side Teleport does not retry every frame (AC5).
    this._dangerCleared = false;

    if (choice === 'phase_shift') {
      // `consumePhaseCharge` returns false only when the finite pool is
      // empty (AC3); `selectAutoDefence` already required a non-zero count,
      // so the fallback only guards a raced consumption.
      if (!store.consumePhaseCharge()) return null;
      this._activatePhase(store.stats('phase_shift').phaseDuration ?? 1.5);
    }
    return choice;
  }

  /**
   * Stored Phase Shift auto-activation charges (0 when the finite pool is
   * empty — even for a permanent owner, AH-0MV82I8IL0012RXY AC3). HUD-facing.
   */
  phaseCharges(): number {
    return this._levelStore.phaseCharges();
  }

  /**
   * Whether the hold-full reward made Phase Shift permanently owned. This is
   * an ownership flag only — the pool is finite and recharges like any
   * other charge (AH-0MV82I7TX0009JMT AC4).
   */
  isPhasePermanent(): boolean {
    return this._levelStore.isPhasePermanent();
  }

  /**
   * Whether the single ready Teleport is available (held and not recharging).
   * The whole Teleport state is a readiness flag plus a countdown — there is
   * no stored-use count anywhere (parent AH-0MVY096RT006QMF4 AC1).
   */
  hasTeleport(): boolean {
    return this._levelStore.hasTeleport();
  }

  /** Whether a spent Teleport is still counting down (unavailable until 0). */
  isTeleportRecharging(): boolean {
    return this._levelStore.isTeleportRecharging();
  }

  /**
   * Whether the held Teleport is ready to fire — the explicit HUD-facing alias
   * of {@link hasTeleport} (parent AH-0MVY096RT006QMF4).
   */
  isTeleportReady(): boolean {
    return this._levelStore.hasTeleport();
  }

  /**
   * Seconds until the held Teleport is ready — 0 when it is ready or not held
   * (parent AC4).
   */
  teleportRechargeRemaining(): number {
    return this._levelStore.teleportRechargeRemaining();
  }

  /**
   * Phase Shift recharge time in seconds at the current level — the
   * HUD-facing view of the recharge clock a spent charge is counting down
   * (30 s base → 10 s cap, level-derived via `phaseRechargeRate`;
   * AH-0MV82I8IL0012RXY AC4).
   */
  phaseRechargeTime(): number {
    return this._levelStore.phaseRechargeTime();
  }

  /**
   * Teleport recharge time in seconds at the current level — the HUD-facing
   * view of the single readiness clock a spent warp is counting down (60 s
   * base → 20 s cap, level-derived via `teleportRechargeRate`; parent
   * AH-0MVY096RT006QMF4).
   */
  teleportRechargeTime(): number {
    return this._levelStore.teleportRechargeTime();
  }

  /**
   * Spends the single ready Teleport warp (starting its one recharge timer)
   * and grants Phase Shift at the landing spot. Returns true when the warp
   * was available, false while it is recharging.
   */
  consumeTeleport(): boolean {
    if (!this._levelStore.consumeTeleport()) return false;
    this.applyPhaseShift();
    return true;
  }

  /**
   * Remaining seconds for a timed effect, or undefined when inactive.
   *
   * An instant kind's temporary **level window** is not an effect and is
   * reported through {@link powerUpTemporaryRemaining} instead, so it never
   * shows up here (AH-0MVUGI448000GNMJ). Phase Shift's activation timer is
   * separate from its level window and is reported here while phased.
   */
  remaining(id: PowerUpId): number | undefined {
    if (id === 'phase_shift') {
      return this._phaseRemaining > 0 ? this._phaseRemaining : undefined;
    }
    const effect = this._timed.get(id);
    if (!effect || effect.levelWindow) return undefined;
    return effect.remaining;
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
   * **A permanent grant never strands a temporary window (AC3,
   * AH-0MVUGI4IC006PUS5).** A permanent weapon has no window at all (`∞` in
   * the HUD), and `Player.equipWeapon(id, true)` clears the weapon's
   * temporary level at grant time, so this registry mirrors that strategy:
   * an open field-pickup window is **closed** when the weapon becomes
   * permanent instead of counting down to zero. The weapon stays active for
   * the run and its row immediately reads `∞`.
   *
   * @param weaponId — the collected weapon.
   * @param permanent — when true, the weapon never expires for the run
   *   (used by the hold-full choice).
   */
  applyWeapon(weaponId: WeaponId, permanent = false): boolean {
    const existing = this._weapons.get(weaponId);
    if (existing) {
      if (permanent) {
        // A hold-full reward makes the weapon permanent; the temporary window
        // (and the temporary level it carried in `Player`) is closed at grant
        // time, so no countdown survives on a permanent weapon (AC3).
        existing.permanent = true;
        existing.tempWindow = false;
        existing.remaining = existing.duration;
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
   * the aggregated model the standalone HUD renders from. Teleport is
   * included while it is held, as a readiness entry with **no** stack count
   * (a running recharge is published as `recharge` seconds instead). Weapons
   * are exposed separately via `activeWeapons()`.
   */
  activeEffects(): ActiveEffect[] {
    const result: ActiveEffect[] = [];
    for (const effect of this._timed.values()) {
      // A level window only times the temporary level of an instant kind; it
      // is not an active effect and must not render a row
      // (AH-0MVUGI448000GNMJ).
      if (effect.levelWindow) continue;
      // Shield/Force Field/Thorn Field carry their remaining budget so the
      // HUD renders `Shield xN` and updates as events are spent (AC6). The
      // accessors project the shared charge pool for a permanently-owned kind,
      // so the stacks column and the armed state read one source (parent
      // AH-0MVTQMREN009DSFW AC1–AC3).
      const stacks =
        effect.id === 'shield'
          ? this.shieldAbsorptionsRemaining()
          : effect.id === 'force_field'
            ? this.forceFieldRemaining()
            : effect.id === 'thorns'
              ? this.thornsRemaining()
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
    // An active Phase Shift phase (auto- or Teleport-granted) renders its own
    // row; its level window is not surfaced (see above).
    if (this._phaseRemaining > 0) {
      result.push({
        id: 'phase_shift' as PowerUpId,
        type: 'phase_shift',
        duration: this._phaseDuration,
        remaining: this._phaseRemaining,
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
    // A permanent Orbital Strike renders one run-scoped row; a field pickup
    // (one immediate bolt) leaves no row (AH-0MVCRC1Q0007JAV1).
    if (this._strikePermanent) {
      result.push({
        id: 'strike' as PowerUpId,
        type: 'strike',
        permanent: true,
      });
    }
    // Teleport is **single-use** (parent AH-0MVY096RT006QMF4): its row is
    // published while held and never carries a stack count — a running
    // recharge is surfaced as the remaining seconds instead.
    if (this._levelStore.isTeleportHeld()) {
      const recharge = this.teleportRechargeRemaining();
      result.push({
        id: 'teleport' as PowerUpId,
        type: 'teleport',
        ...(this._levelStore.isConsumableOwned('teleport')
          ? { permanent: true }
          : {}),
        ...(recharge > 0 ? { recharge } : {}),
      });
    }
    // Phase Shift auto-activation charges (parent AH-0MUIYX1EE008FVS8): a
    // finite stock-pile renders as a count; the permanent owner marker as an
    // ∞ value (the level is permanent for the run) — never an unlimited
    // supply, the pool is finite, recharges and is surfaced via phaseCharges()
    // (the HUD grey-out for an empty pool is AH-0MV82I97Y007MB6M). A zero
    // charge count is never surfaced (no misleading "x0").
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
    this._phaseRemaining = 0;
    this._phaseDuration = 0;
    this._bombPermanent = false;
    this._bombPulseTimer = 0;
    this._bombPulsePending = false;
    this._bombPulseRange = null;
    this._smartBombPermanent = false;
    this._smartBombPulseTimer = 0;
    this._smartBombPulsePending = false;
    this._smartBombPulseAoe = null;
    this._mysteryUfoPendingSpawns = 0;
    this._strikePermanent = false;
    this._strikePulseTimer = 0;
    this._strikePulsePending = false;
    // A latched (retained) bolt never survives into a fresh run
    // (AH-0MVS2T2DJ0069C0Y).
    this._strikeLatched = false;
    this._strikeLatchedDamage = null;
    this._levelStore.reset();
  }
}
