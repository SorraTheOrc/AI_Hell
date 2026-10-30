/**
 * Power-up level-curve catalogue, pure resolver and run-scoped level store
 * (parent AH-0MUU2QJE2007JNR6).
 *
 * Power-ups Shield–Mineral Scoop are **constantly upgradable**, mirroring the weapon
 * levelling system (`src/utils/weaponLevels.ts`, parent AH-0MUPMPCB2009J54J):
 *
 * - {@link POWER_UP_LEVEL_SPECS} — one spec (base, finite cap, curve rate
 *   `k`, `discrete`, label + rationale) per levelled variable, for **every**
 *   power-up Shield–Mineral Scoop. The specs reuse the shared
 *   exponential-saturation and linear-clamped curves from `src/utils/curve.ts`
 *   so there is exactly **one** curve implementation for weapons and
 *   power-ups (AC1/AC4).
 * - {@link resolvePowerUpAtLevel} — the **pure** resolver mapping
 *   `(powerUpId, level)` to a {@link PowerUpLevelStats} snapshot. Pure,
 *   deterministic, monotonic non-decreasing and clamped to each variable's
 *   finite cap (AC4).
 * - {@link PowerUpLevelStore} — the run-scoped level model. It splits each
 *   power-up's level into a **permanent** component (hold-full rewards only)
 *   and a **temporary** component (field pickups, tied to the item's timed
 *   window). The effective level is `permanent + temporary`; only the
 *   permanent component governs the hold-full choice. Both components are
 *   cleared on run restart. Existing stack/charge semantics (Magnet/Mineral Scoop
 *   permanent stacks, Teleport stored teleports, Phase Shift charges, Extra Life lives) are
 *   **derived from this model** rather than tracked by a second, independent
 *   counter (AC3).
 *
 * Phase Shift and Teleport are **recharging pools** (AH-0MV82I7TX0009JMT):
 * each consumed charge starts its own recharge timer whose duration is the
 * level-derived recharge time at the moment of consumption (see
 * {@link PowerUpLevelStore.phaseRechargeTime} / {@link PowerUpLevelStore.teleportRechargeTime});
 * {@link PowerUpLevelStore.tickRecharge} advances the timers while the run
 * runs and a completed timer returns one charge to the pool. Both pools are
 * capped at {@link POWER_UP_CHARGE_CAP} (3) — a field pickup grants the
 * level-derived count, a hold-full reward exactly one, and a completed
 * recharge one; any grant/recharge that would exceed the cap is discarded.
 * The hold-full Phase Shift reward is a recharging pool like any other
 * charge, never an unlimited supply.
 *
 * ## Level semantics (weapon parity)
 *
 * `level` is the number of *upgrades* applied — exactly like
 * `resolveWeaponAtLevel`: the **first** collection unlocks the power-up at
 * its base (existing) strength (`resolvePowerUpAtLevel(id, 0)`), and each
 * *further* collection applies the next upgrade. The store holds the raw
 * collection counts and exposes {@link PowerUpLevelStore.getUpgradeLevel}
 * (effective) and {@link PowerUpLevelStore.getPermanentUpgradeLevel}
 * (hold-full only) for the resolver.
 *
 * ## Temporary vs permanent (AH-0MUX802450085VZZ)
 *
 * A **field pickup** (`collect(id)`) adds one *temporary* stack
 * (`tempStacks`); a **hold-full reward** (`collect(id, true)`) adds one
 * *permanent* grant (`permanentGrants`). The temporary stacks are tied to
 * the item's timed window and cleared by
 * {@link PowerUpLevelStore.clearTemporary} when that window expires; the
 * permanent grants never expire. An item is owned/active while
 * `permanentGrants + tempStacks >= 1`. This split lives **only here** (and
 * in the `Player` weapon-level state) so the game and every gym share one
 * implementation (AC7).
 *
 * Unconsumed consumable grants (Phase Shift charges, Teleport teleports) persist across a
 * temporary-window expiry: clearing the temporary level never claws back an
 * already-granted charge/teleport (producer Resolved decision 1b).
 * Power-ups with no timed effect (Bomb/Phase Shift/Teleport/Extra Life) have no temporary window, so
 * their temporary stacks persist until run reset (Resolved decision 4).
 *
 * ## Magnet/Mineral Scoop hybrid reconciliation
 *
 * Magnet and Mineral Scoop are **hybrids**: a field pickup grants a
 * timed (refresh-only) attraction, while a hold-full reward grants a
 * permanent stack (GDD §4.4; AH-0MUTOTLCY005NZ8L / AH-0MUTPEHMP0074Y1L).
 * The level model therefore tracks **both** the total collection count
 * (which the timed path and the `magnetStacks`/`scoopStacks` cap scale with)
 * and the number of *permanent* grants. The permanent stack count is
 * `min(permanentGrants, levelCap)` — the cap is level-derived, and there is
 * no second, independently-incremented stack counter. A field pickup still
 * does not create a permanent stack, so the hybrid semantics are preserved.
 *
 * ## Why consumable grants are not a distinct power-up type (AH-0MUX93S6F005LLXN)
 *
 * An exploration following AH-0MUX802450085VZZ asked whether the Phase Shift
 * charges / Teleport teleports — whose unconsumed grants persist until
 * consumed — should be modelled as a **second power-up type** rather than as
 * a level that is (temporarily) raised. **Decision: no change required.**
 *
 * The consumable pool is already a distinct **state domain** inside this one
 * store: the level components (`_permanentGrants` / `_tempStacks`) are
 * separate fields from the resource pools (`_phaseCharges` /
 * `_teleportStacks` plus their recharge timers). `clearTemporary` clears only
 * the level and provably never claws back a granted consumable (Resolved
 * decision 1b; asserted in `powerUpLevels.test.ts`). A catalogue-level
 * "consumable type" tag would add a second classification axis that must be
 * kept in sync with the drop pool, the hold-full choice, the HUD and every
 * scene/gym for no behavioural gain, and would fork the single mutation point
 * (`collect`) and the single curve/resolver that keep power-ups in parity
 * with weapons. The distinct concept is therefore expressed as a distinct
 * *state domain*, not a distinct *type*.
 *
 * Pure and deterministic: no scene, DOM, Phaser or storage coupling.
 */

import { POWER_UP_CATALOGUE, PowerUpId, getPowerUpById } from './types';
import {
  curveValue,
  formatDelta,
  type CurveSpec,
} from '../utils/curve';
import {
  SHIP_SIZE,
  SMART_BOMB_INTERVAL_BASE_SECONDS,
  SMART_BOMB_INTERVAL_FLOOR_SECONDS,
  SMART_BOMB_INTERVAL_PER_LEVEL_SECONDS,
  SMART_BOMB_RADIUS_CAP_MULTIPLIER,
  SMART_BOMB_RADIUS_PER_LEVEL,
  SMART_BOMB_RADIUS_SHIP_MULTIPLIER,
  STRIKE_INTERVAL_BEATS_BASE,
  STRIKE_INTERVAL_BEATS_FLOOR,
  STRIKE_INTERVAL_BEATS_PER_LEVEL,
  WEAPON_TIMEOUT_MS,
} from '../core/constants';
import { DEFAULT_BPM, beatPeriodMs } from '../utils/beat';

/**
 * One beat of the shared 80 BPM grid in seconds (0.75 s), the unit the
 * Orbital Strike cadence is expressed in (AH-0MVRE6N08001TE4V). Derived from
 * the beat module so the grid stays the single source of truth.
 */
const STRIKE_BEAT_SECONDS = beatPeriodMs(DEFAULT_BPM) / 1000;

// ── Level variables ─────────────────────────────────────────────────

/**
 * The tunable power-up level variable space. Each variable is monotonic
 * non-decreasing in level (a higher level never makes the power-up worse);
 * the Smart Bomb pulse interval is the exception — it is stored **descending**
 * (`max(10, 30 − 2×level)` seconds) because a shorter pulse interval is an
 * improvement, and its derived pulses/second inverse stays non-decreasing.
 * The Orbital Strike interval descends the same way, in whole beats of the
 * shared 80 BPM grid (9 → 3 beats, −1 beat per level).
 */
export type PowerUpLevelVariable =
  /** Shield — bubble duration in seconds. */
  | 'shieldDuration'
  /** Shield — hits absorbed before the bubble pops. */
  | 'shieldAbsorptions'
  /** Bomb — clear radius in pixels. */
  | 'bombRange'
  /** Bomb — permanent pulse rate in pulses per second. */
  | 'bombFrequency'
  /** Speed Boost — movement/fire-rate multiplier. */
  | 'speedMultiplier'
  /** Speed Boost — duration in seconds. */
  | 'speedDuration'
  /** Phase Shift — pass-through duration in seconds. */
  | 'phaseDuration'
  /** Phase Shift — auto-activation charges granted per pickup. */
  | 'phaseCharges'
  /** Phase Shift — recharge rate for consumed charges, in charges/second. */
  | 'phaseRechargeRate'
  /** Teleport — stored stacks granted per pickup. */
  | 'teleportStacks'
  /** Teleport — recharge rate for consumed teleports, in charges/second. */
  | 'teleportRechargeRate'
  /** Teleport — arrival Phase Shift duration in seconds. */
  | 'teleportPhaseDuration'
  /** Extra Life — lives granted per pickup. */
  | 'lifeGain'
  /** Extra Life — hard lives cap. */
  | 'livesCap'
  /** Magnet — permanent stack cap (and attraction-radius growth). */
  | 'magnetStacks'
  /** Mineral Scoop — permanent stack cap (radius growth). */
  | 'scoopStacks'
  /** Smart Bomb — ship-centred pulse radius in pixels. */
  | 'aoeRadius'
  /** Smart Bomb — hit points each enemy takes per pulse. */
  | 'smartBombDamage'
  /** Smart Bomb — permanent pulse interval in seconds (descends; the pulses/s axis is its inverse). */
  | 'smartBombInterval'
  /** Force Field — bubble duration in seconds. */
  | 'forceFieldDuration'
  /** Force Field — bullets the field reflects before it stops. */
  | 'forceFieldReflects'
  /** Mystery UFO — collector-drone lifetime in seconds. */
  | 'mysteryUfoLifetime'
  /** Mystery UFO — minerals one collector drone can carry before returning. */
  | 'mysteryUfoCapacity'
  /** Mystery UFO — collector-drone vacuum radius in pixels. */
  | 'mysteryUfoRadius'
  /** Mystery UFO — seconds between permanent collector-drone spawns (descends). */
  | 'mysteryUfoSpawnInterval'
  /** Frenzy — bonus damage hits each player bullet applies. */
  | 'frenzyBonusHits'
  /** Frenzy — timed window during which bullets deal bonus hits. */
  | 'frenzyDuration'
  /** Chrono Field — fraction of enemy-bullet speed removed while active. */
  | 'chronoSlowFactor'
  /** Chrono Field — timed window during which enemy bullets crawl. */
  | 'chronoDuration'
  /** Thorn Field — rams absorbed before the counter ends. */
  | 'thornsAbsorbs'
  /** Thorn Field — timed window during which rams are free. */
  | 'thornsDuration'
  /**
   * Thorn Field — seconds between automatic ram recharges while active
   * (descends; the derived rams/second axis is its monotonic inverse).
   */
  | 'thornsRecharge'
  /** Salvage — bonus minerals each destroyed enemy drops. */
  | 'salvageMinerals'
  /** Salvage — timed window during which wrecks pay out. */
  | 'salvageDuration'
  /** Orbital Strike — seconds between bolts (descends in whole 80 BPM beats; the strikes/s axis is its inverse). */
  | 'strikeInterval'
  /** Orbital Strike — hit points the bolt deals. */
  | 'strikeDamage';
/** Every level variable, in catalogue order (iterate this, not `Object.keys`). */
export const POWER_UP_LEVEL_VARIABLES: readonly PowerUpLevelVariable[] = [
  'shieldDuration',
  'shieldAbsorptions',
  'bombRange',
  'bombFrequency',
  'speedMultiplier',
  'speedDuration',
  'phaseDuration',
  'phaseCharges',
  'phaseRechargeRate',
  'teleportStacks',
  'teleportRechargeRate',
  'teleportPhaseDuration',
  'lifeGain',
  'livesCap',
  'magnetStacks',
  'scoopStacks',
  'aoeRadius',
  'smartBombDamage',
  'smartBombInterval',
  'forceFieldDuration',
  'forceFieldReflects',
  'mysteryUfoLifetime',
  'mysteryUfoCapacity',
  'mysteryUfoRadius',
  'mysteryUfoSpawnInterval',
  'frenzyBonusHits',
  'frenzyDuration',
  'chronoSlowFactor',
  'chronoDuration',
  'thornsAbsorbs',
  'thornsDuration',
  'thornsRecharge',
  'salvageMinerals',
  'salvageDuration',
  'strikeInterval',
  'strikeDamage',
];

/**
 * Level variables whose effect-path **consumption** is not yet wired, and
 * which a `power-up-level` change summary must therefore exclude so the
 * hold-full choice never promises a delta the effect path does not apply
 * (AC4).
 *
 * **Empty since AH-0MUVM9RAO004Y3LB** wired both the Shield `shieldAbsorptions`
 * axis (multi-hit shield) and the redesigned Bomb `bombRange`/`bombFrequency`
 * axes (ranged periodic bomb) into the effect path. The set is retained as
 * the single seam for any future deferred axis.
 */
export const DEFERRED_POWER_UP_LEVEL_VARIABLES: ReadonlySet<PowerUpLevelVariable> =
  new Set<PowerUpLevelVariable>();

// ── Level specification ─────────────────────────────────────────────

/**
 * Metadata for one power-up level variable: its level-0 value, finite
 * asymptotic cap, saturation rate `k`, whether it is a whole-number count,
 * its human-readable label/unit and the tuning rationale.
 *
 * Extends the shared {@link CurveSpec} so {@link curveValue} resolves it
 * identically to a weapon variable (single curve implementation).
 */
export interface PowerUpLevelSpec extends CurveSpec {
  /** The variable this spec describes. */
  variable: PowerUpLevelVariable;
  /** The power-up this variable belongs to. */
  powerUpId: PowerUpId;
  /** Short human-readable label (for the hold-full choice summary). */
  label: string;
  /** Display unit (e.g. `'s'`, `'×'`, `''` for a count). */
  unit: string;
  /** One-line description of what the variable does to power-up behaviour. */
  description: string;
  /**
   * Why this cap and saturation rate were chosen — the tuning rationale,
   * kept beside the numbers so balance intent cannot drift.
   */
  rationale: string;
}

/**
 * The per-power-up level catalogue — one entry per power-up Shield–Mineral Scoop, each
 * holding that power-up's levelable variables.
 *
 * Caps are deliberately conservative for the survivability power-ups
 * (shield, phase, lives), which are more balance-sensitive than weapon
 * damage (AC1, producer risk note).
 */
export const POWER_UP_LEVEL_SPECS: Record<PowerUpId, PowerUpLevelSpec[]> = {
  // Shield — absorbs its level-resolved hits (base 1, cap 3) in a 15 s bubble.
  shield: [
    {
      variable: 'shieldDuration',
      powerUpId: 'shield',
      label: 'Shield time',
      unit: 's',
      description: 'How long the shield bubble lasts.',
      curve: 'exponential-saturation',
      base: 15,
      cap: 30,
      k: 0.12,
      discrete: false,
      rationale:
        'A 30 s ceiling keeps a levelled shield a strong but finite safety ' +
        'window; k=0.12 adds ~2 s at the first upgrade and then plateaus, so ' +
        'early levels feel responsive without granting near-permanent cover.',
    },
    {
      variable: 'shieldAbsorptions',
      powerUpId: 'shield',
      label: 'Shield hits',
      unit: '',
      description: 'Hits the shield absorbs before it pops.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.5,
      discrete: true,
      rationale:
        'Absorbing more than one hit is very strong, so the cap is small ' +
        '(3) and k=0.5 grants the second hit promptly at the first upgrade, ' +
        'then flattens — a clear early payoff with no runaway durability.',
    },
  ],

  // Bomb — ranged clear, single on a field pickup; periodic when permanent.
  bomb: [
    {
      variable: 'bombRange',
      powerUpId: 'bomb',
      label: 'Bomb range',
      unit: 'px',
      description: 'Radius of the bomb clear, centred on the ship.',
      curve: 'exponential-saturation',
      base: 120,
      cap: 320,
      k: 0.3,
      discrete: false,
      rationale:
        'A 320 px ceiling clears a substantial slice of the 960×540 field ' +
        'without covering it entirely; k=0.3 adds ~52 px at the first ' +
        'upgrade, so early levels feel responsive before diminishing.',
    },
    {
      variable: 'bombFrequency',
      powerUpId: 'bomb',
      label: 'Bomb rate',
      unit: '/s',
      description: 'Pulses per second for a permanent bomb.',
      curve: 'exponential-saturation',
      base: 0.33,
      cap: 1,
      k: 0.35,
      discrete: false,
      rationale:
        'Stored as pulses/second so the axis stays monotonic non-decreasing ' +
        '(the effect computes 1/frequency). One pulse per second at the cap ' +
        'keeps a permanent bomb a strong but readable clear, never a ' +
        'continuous shield; k=0.35 front-loads the first upgrade (~0.53/s).',
    },
  ],

  // Speed Boost — +50% movement and fire rate for 10 s.
  speed_boost: [
    {
      variable: 'speedMultiplier',
      powerUpId: 'speed_boost',
      label: 'Speed boost',
      unit: '×',
      description: 'Movement and fire-rate multiplier.',
      curve: 'exponential-saturation',
      base: 1.5,
      cap: 2.5,
      k: 0.2,
      discrete: false,
      rationale:
        'A 2.5× ceiling keeps a levelled boost controllable; k=0.2 adds a ' +
        'visible step at the first upgrade (~1.6×) before diminishing.',
    },
    {
      variable: 'speedDuration',
      powerUpId: 'speed_boost',
      label: 'Boost time',
      unit: 's',
      description: 'How long the speed boost lasts.',
      curve: 'exponential-saturation',
      base: 10,
      cap: 20,
      k: 0.12,
      discrete: false,
      rationale:
        'Doubling the 10 s baseline is a meaningful but bounded window; ' +
        'k=0.12 spreads the gain across the early levels so duration and ' +
        'magnitude grow together.',
    },
  ],

  // Phase Shift — charge-based auto pass-through.
  phase_shift: [
    {
      variable: 'phaseDuration',
      powerUpId: 'phase_shift',
      label: 'Phase time',
      unit: 's',
      description: 'Pass-through duration when the phase triggers.',
      curve: 'exponential-saturation',
      base: 1.5,
      cap: 3,
      k: 0.2,
      discrete: false,
      rationale:
        'Phase is hit-immunity, so the cap is a conservative 3 s; k=0.2 ' +
        'gives a small, readable extension at the first upgrade.',
    },
    {
      variable: 'phaseCharges',
      powerUpId: 'phase_shift',
      label: 'Phase charges',
      unit: '',
      description: 'Auto-activation charges granted per pickup.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.5,
      discrete: true,
      rationale:
        'Charges are stored activations; the cap is small (3) and k=0.5 ' +
        'grants the second charge at the first upgrade. The hold-full Phase ' +
        'Shift reward adds one charge to the same recharging pool (capped at ' +
        '3) — it is never an unlimited supply (AH-0MV82I7TX0009JMT).',
    },
    {
      variable: 'phaseRechargeRate',
      powerUpId: 'phase_shift',
      label: 'Phase recharge',
      unit: '/s',
      description: 'Recharge rate for a consumed Phase Shift charge, in charges per second.',
      curve: 'exponential-saturation',
      base: 1 / 30,
      cap: 1 / 10,
      k: 0.3,
      discrete: false,
      rationale:
        'Stored as charges/second so the axis stays monotonic non-decreasing ' +
        '(the recharge engine computes 1/rate → 30 s base, 10 s cap). A ' +
        'levelled charge therefore recovers sooner; k=0.3 front-loads the ' +
        'first upgrade (~20 s) before diminishing, mirroring the Bomb/Smart ' +
        'Bomb frequency axes. The 10 s cap keeps a levelled charge a ' +
        'meaningful but finite recovery rather than near-instant.',
    },
  ],

  // Teleport — stored FIFO uses, spent automatically when the ship is in danger.
  teleport: [
    {
      variable: 'teleportStacks',
      powerUpId: 'teleport',
      label: 'Teleports',
      unit: '',
      description: 'Stored teleport uses granted per pickup.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.5,
      discrete: true,
      rationale:
        'Stored uses are a consumable escape; the cap is small (3) and ' +
        'k=0.5 grants a second use at the first upgrade, then flattens. A ' +
        'hold-full reward grants exactly one stored use (mirroring Phase ' +
        'Shift), clamped at the cap (AH-0MV82I7TX0009JMT).',
    },
    {
      variable: 'teleportRechargeRate',
      powerUpId: 'teleport',
      label: 'Teleport recharge',
      unit: '/s',
      description: 'Recharge rate for a consumed Teleport charge, in charges per second.',
      curve: 'exponential-saturation',
      base: 1 / 15,
      cap: 1 / 5,
      k: 0.3,
      discrete: false,
      rationale:
        'Stored as charges/second so the axis stays monotonic non-decreasing ' +
        '(the recharge engine computes 1/rate → 15 s base, 5 s cap). ' +
        'Teleport is the more reactive escape, so both its base and cap are ' +
        'shorter than Phase Shift; k=0.3 front-loads the first upgrade ' +
        '(~10 s) before diminishing. The 5 s cap keeps a levelled escape ' +
        'finite but snappy.',
    },
    {
      variable: 'teleportPhaseDuration',
      powerUpId: 'teleport',
      label: 'Arrival phase',
      unit: 's',
      description: 'Phase Shift duration granted on arrival.',
      curve: 'exponential-saturation',
      base: 1.5,
      cap: 3,
      k: 0.2,
      discrete: false,
      rationale:
        'The arrival phase is a landing-safety tool; a 3 s ceiling keeps ' +
        'it bounded and k=0.2 adds a small, legible step.',
    },
  ],

  // Extra Life — +1 life immediately, capped at 5.
  extra_life: [
    {
      variable: 'lifeGain',
      powerUpId: 'extra_life',
      label: 'Lives',
      unit: '',
      description: 'Lives granted per pickup.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.5,
      discrete: true,
      rationale:
        'Lives are the most precious resource, so the cap is small (3) and ' +
        'k=0.5 grants a second life at the first upgrade; the hard lives ' +
        'cap still bounds total survivability.',
    },
    {
      variable: 'livesCap',
      powerUpId: 'extra_life',
      label: 'Life cap',
      unit: '',
      description: 'Hard ceiling on the lives counter.',
      curve: 'exponential-saturation',
      base: 5,
      cap: 5,
      k: 0,
      discrete: true,
      rationale:
        'The lives ceiling is deliberately held at 5 (existing balance) and ' +
        'is level-agnostic; Extra Life levels the lives *gained* per pickup instead ' +
        'of raising the ceiling.',
    },
  ],

  // Magnet — hybrid timed pickup / permanent stacking upgrade.
  magnet: [
    {
      variable: 'magnetStacks',
      powerUpId: 'magnet',
      label: 'Magnet',
      unit: '',
      description: 'Permanent stack cap (drives the attraction radius).',
      curve: 'exponential-saturation',
      base: 1,
      cap: 5,
      k: 0.35,
      discrete: true,
      rationale:
        'The 5-stack cap is retained (existing balance: +50% radius per ' +
        'stack). Deriving the cap from the level lets a levelled Magnet reach ' +
        'the cap sooner; k=0.35 front-loads the early stacks while never ' +
        'exceeding 5.',
    },
  ],

  // Mineral Scoop — hybrid timed pickup / permanent stacking upgrade.
  mineral_scoop: [
    {
      variable: 'scoopStacks',
      powerUpId: 'mineral_scoop',
      label: 'Scoop',
      unit: '',
      description: 'Permanent stack cap (drives the attraction radius).',
      curve: 'exponential-saturation',
      base: 1,
      cap: 5,
      k: 0.35,
      discrete: true,
      rationale:
        'Mirrors Magnet so the two attraction power-ups stay behaviourally ' +
        'consistent (shared radius curve); the 5-stack cap is retained and ' +
        'the level-derived cap reaches it sooner.',
    },
  ],

  // Smart Bomb — Defender-inspired stored ship-centred pulse (re-balanced
  // in AH-0MV8GPGBL009M0D8: modest radius, rare interval, damage unchanged).
  smart_bomb: [
    {
      variable: 'aoeRadius',
      powerUpId: 'smart_bomb',
      label: 'Pulse radius',
      unit: 'px',
      description: 'Radius of the smart-bomb pulse, centred on the ship.',
      curve: 'linear-clamped',
      // Base = 10 × SHIP_SIZE = 200 px (operator Q1-A); each level adds +2 %
      // of the base (+4 px) up to a 2× base cap (400 px) — the ship-centred
      // pulse never covers the whole 960×540 field again.
      base: SMART_BOMB_RADIUS_SHIP_MULTIPLIER * SHIP_SIZE,
      cap: SMART_BOMB_RADIUS_SHIP_MULTIPLIER * SHIP_SIZE * SMART_BOMB_RADIUS_CAP_MULTIPLIER,
      k: SMART_BOMB_RADIUS_SHIP_MULTIPLIER * SHIP_SIZE * SMART_BOMB_RADIUS_PER_LEVEL,
      discrete: false,
      rationale:
        'A 200 px base radius (10 × SHIP_SIZE) covers a modest, readable ' +
        'area around the ship rather than the whole field, so the pulse is ' +
        'a panic-button wake-up, not a passive auto-win. Each level adds ' +
        '+2 % of the base (+4 px) with a 2× base cap (400 px) that keeps ' +
        'the pulse finite and the fight legible, mirroring the magnet/scoop ' +
        '“× ship size” convention.',
    },
    {
      variable: 'smartBombDamage',
      powerUpId: 'smart_bomb',
      label: 'Pulse damage',
      unit: '',
      description: 'Hit points each enemy takes from one pulse.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.3,
      discrete: true,
      rationale:
        'The pulse always deals at least one hit so 1 HP regulars die; the ' +
        'cap of 3 lets later levels chip the Harvester (5 HP) and the boss ' +
        'harder without out-and-out deleting multi-hit enemies. k=0.3 grants ' +
        'the second point at the first upgrade (readable payoff) then flattens.',
    },
    {
      variable: 'smartBombInterval',
      powerUpId: 'smart_bomb',
      label: 'Pulse interval',
      unit: 's',
      description: 'Seconds between pulses for a permanent smart bomb.',
      curve: 'linear-clamped',
      // Descending interval: max(10, 30 − 2×level) s — 30 s on the first
      // grant (level 0), −2 s per further level, floor 10 s. The stored
      // pulses/second axis (`1 / interval`) stays monotonic non-decreasing.
      base: SMART_BOMB_INTERVAL_BASE_SECONDS,
      cap: SMART_BOMB_INTERVAL_FLOOR_SECONDS,
      k: -SMART_BOMB_INTERVAL_PER_LEVEL_SECONDS,
      discrete: true,
      rationale:
        'Stored as the interval in seconds (descending, whole seconds) so ' +
        'the permanent pulse matches `max(10, 30 − 2×level)`: 30 s at level ' +
        '0, −2 s per further level, never faster than once per 10 s. The ' +
        'derived frequency `1 / interval` stays monotonic non-decreasing ' +
        '(the model’s rate-axis contract), keeping the smart bomb a rare, ' +
        'weighty clear rather than a continuous screen wipe.',
    },
  ],

  // Mystery UFO — Space Invaders-inspired bonus pickup (AH-0MV1BIXFO006Z1I7).
  // With the collector-drone epic (AH-0MV9G113S009B37I) the instant
  // mineral/score bounty is replaced by a visible collector drone; its level
  // axes (lifetime, capacity, collector radius and permanent spawn interval)
  // resolve here so the drone grows with the run without re-tuning code. The
  // instant-burst axes (score and minerals) no longer exist.
  mystery_ufo: [
    {
      variable: 'mysteryUfoLifetime',
      powerUpId: 'mystery_ufo',
      label: 'Drone lifetime',
      unit: 's',
      description: 'How long one collector drone flies before returning.',
      curve: 'exponential-saturation',
      base: 5,
      cap: 8,
      k: 0.3,
      discrete: false,
      rationale:
        'A 5 s sortie keeps the level-0 drone a brief ferry, while the 8 s ' +
        'cap lets a levelled drone reach minerals across the field before its ' +
        'lifetime expires; k=0.3 front-loads ~0.8 s on the first upgrade so ' +
        'the drone feels responsive early. Continuous so the lifetime can be ' +
        'any second value the timer reads.',
    },
    {
      variable: 'mysteryUfoCapacity',
      powerUpId: 'mystery_ufo',
      label: 'Drone capacity',
      unit: '',
      description: 'Minerals one collector drone can carry before returning.',
      curve: 'exponential-saturation',
      base: 10,
      cap: 20,
      k: 0.3,
      discrete: true,
      rationale:
        'A 10-mineral hold at level 0 grows to 20 at the cap, so a levelled ' +
        'drone ferries a full hold-full chunk per run; k=0.3 adds ~2.6 ' +
        'minerals on the first upgrade for a visible step. Discrete so the ' +
        'drone only ever holds whole minerals.',
    },
    {
      variable: 'mysteryUfoRadius',
      powerUpId: 'mystery_ufo',
      label: 'Collector radius',
      unit: 'px',
      description: 'Distance at which the drone vacuums minerals into its hold.',
      curve: 'exponential-saturation',
      base: 20,
      cap: 40,
      k: 0.3,
      discrete: false,
      rationale:
        'A 20 px vacuum radius (about one ship size) at level 0 widens to ' +
        '40 px at the cap so a levelled drone sweeps a broader arc without ' +
        'becoming a full-field magnet; k=0.3 adds ~5 px on the first upgrade. ' +
        'Continuous so the radius can be any pixel value.',
    },
    {
      variable: 'mysteryUfoSpawnInterval',
      powerUpId: 'mystery_ufo',
      label: 'Spawn interval',
      unit: 's',
      description: 'How often a permanent collector drone respawns.',
      curve: 'linear-clamped',
      // Descending interval: max(12, 30 − 2×level) s — 30 s on the first
      // grant, −2 s per further level, floor 12 s. Mirrors the Smart Bomb /
      // Orbital Strike permanent-interval schedules.
      base: 30,
      cap: 12,
      k: -2,
      discrete: true,
      rationale:
        'A permanent (full-hull) collector drone is free income, so it is ' +
        'deliberately rare: 30 s between spawns, never more often than once ' +
        'per 12 s (mirrors the Smart Bomb / Strike interval). The derived ' +
        'spawns/second inverse stays monotonic non-decreasing, matching the ' +
        'model\'s rate-axis contract. Discrete so the timer uses whole ' +
        'seconds.',
    },
  ],

  // Force Field — Gradius-inspired timed bullet reflector (AH-0MV1BIX1W006XF95).
  force_field: [
    {
      variable: 'forceFieldDuration',
      powerUpId: 'force_field',
      label: 'Field time',
      unit: 's',
      description: 'How long the reflect bubble lasts.',
      curve: 'exponential-saturation',
      base: 8,
      cap: 18,
      k: 0.15,
      discrete: false,
      rationale:
        'An 18 s ceiling keeps the bubble a strong but finite defence rather ' +
        'than perpetual cover; k=0.15 adds ~1.4 s at the first upgrade, so ' +
        'early levels feel responsive before diminishing. The window is ' +
        'cleared on expiry, at which point enemy bullets damage the ship ' +
        'again.',
    },
    {
      variable: 'forceFieldReflects',
      powerUpId: 'force_field',
      label: 'Field reflects',
      unit: '',
      description: 'Enemy bullets the field returns before it stops reflecting.',
      curve: 'exponential-saturation',
      base: 3,
      cap: 10,
      k: 0.25,
      discrete: true,
      rationale:
        'Reflection turns incoming fire into offence, so the base budget is ' +
        'small (3) and the cap modest (10); k=0.25 grants a fourth ' +
        'reflection at the first upgrade. Once the budget is spent the bubble ' +
        'keeps counting down but no longer reflects, so it can never become ' +
        'infinite offence.',
    },
  ],

  // Frenzy — timed damage amplification (epic AH-0MVCRC1Q0007JAV1): every
  // player bullet applies a level-resolved number of bonus hits to the first
  // enemy it damages, so multi-HP enemies (the 5-HP Harvester, the boss) fall
  // faster while 1-HP regulars still die in one shot.
  frenzy: [
    {
      variable: 'frenzyBonusHits',
      powerUpId: 'frenzy',
      label: 'Frenzy bonus',
      unit: '',
      description: 'Bonus damage hits each player bullet applies.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.5,
      discrete: true,
      rationale:
        'The first upgrade already doubles the damage of every player shot, ' +
        'and k=0.5 grants that second hit promptly; the 3-hit cap keeps the ' +
        'amplifier a strong but finite burst window rather than trivialising ' +
        'multi-HP encounters.',
    },
    {
      variable: 'frenzyDuration',
      powerUpId: 'frenzy',
      label: 'Frenzy time',
      unit: 's',
      description: 'How long the damage amplifier lasts.',
      curve: 'exponential-saturation',
      base: 8,
      cap: 16,
      k: 0.12,
      discrete: false,
      rationale:
        'Doubling the 8 s baseline is a meaningful but bounded damage window; ' +
        'k=0.12 spreads the gain across the early levels so magnitude and ' +
        'duration grow together (mirrors Speed Boost).',
    },
  ],

  // Chrono Field — timed enemy-bullet slowdown (AH-0MVCRC1Q0007JAV1): while
  // active, enemy bullets advance at `1 − chronoSlowFactor` of normal speed.
  chrono: [
    {
      variable: 'chronoSlowFactor',
      powerUpId: 'chrono',
      label: 'Chrono slow',
      unit: '',
      description: 'Fraction of enemy-bullet speed removed while active.',
      curve: 'exponential-saturation',
      base: 0.5,
      cap: 0.75,
      k: 0.25,
      discrete: false,
      rationale:
        'Stored as the fraction of speed *removed* (0.5 → 0.75) so the axis ' +
        'stays monotonic; the effect computes `1 − slow` → bullets crawl at ' +
        '50 % then 25 % of normal. The 25 % floor keeps the field a dodge ' +
        'tool, never a complete freeze.',
    },
    {
      variable: 'chronoDuration',
      powerUpId: 'chrono',
      label: 'Chrono time',
      unit: 's',
      description: 'How long enemy bullets crawl.',
      curve: 'exponential-saturation',
      base: 5,
      cap: 12,
      k: 0.12,
      discrete: false,
      rationale:
        'Five seconds at level 0 is already a meaningful breather; the 12 s ' +
        'cap keeps slowdown a finite relief so it cannot trivialise a whole ' +
        'wave. k=0.12 spreads the gain across the early levels.',
    },
  ],

  // Thorn Field — timed ram counter (AH-0MVCRC1Q0007JAV1): while active,
  // ramming an enemy destroys it without costing the player a hit, up to a
  // level-resolved absorb count.
  thorns: [
    {
      variable: 'thornsAbsorbs',
      powerUpId: 'thorns',
      label: 'Thorn rams',
      unit: '',
      description: 'Rams absorbed before the counter ends.',
      curve: 'exponential-saturation',
      base: 2,
      cap: 6,
      k: 0.35,
      discrete: true,
      rationale:
        'A free ram is an offence-plus-defence premium, so the base is a ' +
        'modest 2 and the cap 6; k=0.35 front-loads the third absorb at the ' +
        'first upgrade while never letting the field become permanent ' +
        'immunity.',
    },
    {
      variable: 'thornsDuration',
      powerUpId: 'thorns',
      label: 'Thorn time',
      unit: 's',
      description: 'How long the ram counter is active.',
      curve: 'exponential-saturation',
      base: 8,
      cap: 16,
      k: 0.12,
      discrete: false,
      rationale:
        'An 8 → 16 s window bounds the free-ram window; k=0.12 spreads the ' +
        'gain across the early levels (mirrors the other timed windows).',
    },
    {
      variable: 'thornsRecharge',
      powerUpId: 'thorns',
      label: 'Thorn recharge',
      unit: 's',
      description: 'Seconds between automatic ram recharges while active.',
      curve: 'linear-clamped',
      // Descending interval: max(5, 12 − 1×level) s — a spent ram returns
      // after 12 s on the first grant, one second sooner per further level,
      // floored at 5 s. The derived rams/second inverse stays monotonic
      // non-decreasing (mirrors `strikeInterval`).
      base: 12,
      cap: 5,
      k: -1,
      discrete: true,
      rationale:
        'A permanent (hold-full) Thorn Field must keep doing something for ' +
        'the whole run, so a spent ram refills on a timer rather than being ' +
        'spent once. Twelve seconds is deliberately slow — the field stays a ' +
        'buff, not permanent immunity — and the 5 s floor caps the refill ' +
        'rate exactly as the 6-ram absorb cap bounds the budget. The derived ' +
        'rate `1 / interval` stays monotonic non-decreasing.',
    },
  ],

  // Salvage — timed mineral bounty (AH-0MVCRC1Q0007JAV1): destroyed enemies
  // drop the level-resolved bonus minerals at the wreck.
  salvage: [
    {
      variable: 'salvageMinerals',
      powerUpId: 'salvage',
      label: 'Salvage minerals',
      unit: '',
      description: 'Bonus minerals each destroyed enemy drops.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 4,
      k: 0.35,
      discrete: true,
      rationale:
        'One bonus mineral per wreck from the first pickup, growing to four ' +
        'so a mining frenzy stays rewarding without flooding the hold; ' +
        'k=0.35 front-loads the second mineral at the first upgrade.',
    },
    {
      variable: 'salvageDuration',
      powerUpId: 'salvage',
      label: 'Salvage time',
      unit: 's',
      description: 'How long the mining frenzy lasts.',
      curve: 'exponential-saturation',
      base: 10,
      cap: 20,
      k: 0.12,
      discrete: false,
      rationale:
        'A 10 → 20 s window covers roughly one wave of wrecks; k=0.12 ' +
        'spreads the gain across the early levels.',
    },
  ],

  // Orbital Strike — periodic auto-targeting bolt (AH-0MVCRC1Q0007JAV1): a
  // field pickup fires one immediate bolt at the nearest enemy; a hold-full
  // reward repeats it on a level-resolved interval.
  strike: [
    {
      variable: 'strikeInterval',
      powerUpId: 'strike',
      label: 'Strike interval',
      unit: 's',
      description: 'Seconds between strikes for a permanent strike.',
      curve: 'linear-clamped',
      // Descending interval, expressed in whole beats of the shared 80 BPM
      // grid (0.75 s per beat) so every bolt lands on the same pulse the
      // rest of the game's cues are quantised to: 9 beats (6.75 s) on the
      // first grant, one beat sooner per level, floored at 3 beats (2.25 s).
      // Fractional seconds are required to stay on the grid, so this axis is
      // NOT discrete. The stored strikes/second inverse stays monotonic
      // non-decreasing.
      base: STRIKE_INTERVAL_BEATS_BASE * STRIKE_BEAT_SECONDS,
      cap: STRIKE_INTERVAL_BEATS_FLOOR * STRIKE_BEAT_SECONDS,
      k: -STRIKE_INTERVAL_BEATS_PER_LEVEL * STRIKE_BEAT_SECONDS,
      discrete: false,
      rationale:
        'A permanent bolt is strong offence, but at 30 s between bolts it ' +
        'read as "doing nothing" in play (producer rejection ' +
        'AH-0MVRE6N08001TE4V). The cadence is now a whole-beat cadence on the ' +
        'shared 80 BPM grid: 9 beats = 6.75 s (~7 s) on the first grant, so ' +
        'the bolt is an audible event that lands with the music instead of ' +
        'drifting against it. Each level sheds one beat (6.75 → 6.0 → 5.25 …) ' +
        'to a 3-beat floor (2.25 s), which caps the rate as the 3 HP damage ' +
        'cap bounds the payoff. The derived frequency `1 / interval` stays ' +
        'monotonic non-decreasing.',
    },
    {
      variable: 'strikeDamage',
      powerUpId: 'strike',
      label: 'Strike damage',
      unit: '',
      description: 'Hit points the bolt deals to the nearest enemy.',
      curve: 'exponential-saturation',
      base: 1,
      cap: 3,
      k: 0.3,
      discrete: true,
      rationale:
        'One hit from the first bolt (kills 1-HP regulars); the cap of 3 lets ' +
        'a levelled strike chip the Harvester and the boss harder without ' +
        'out-and-out deleting multi-hit enemies (mirrors Smart Bomb damage).',
    },
  ],
};

/**
 * The order power-ups are listed in {@link POWER_UP_LEVEL_SPECS}. Iterate
 * this so catalogue-completeness checks are deterministic.
 */
export const POWER_UP_LEVEL_IDS: readonly PowerUpId[] = [
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'smart_bomb',
  'force_field',
  'mystery_ufo',
  'frenzy',
  'chrono',
  'thorns',
  'salvage',
  'strike',
];


// ── Resolved stats ──────────────────────────────────────────────────

/**
 * The resolved per-variable values for a power-up at a given level. Field
 * names match {@link PowerUpLevelVariable}; only the variables that belong
 * to the resolved power-up are present.
 *
 * Every present value never leaves the corresponding spec band; the
 * variable space is monotonic non-decreasing except the Smart Bomb pulse
 * interval, which is stored **descending** for the `max(10, 30 − 2×level)`
 * schedule (its derived pulses/second inverse stays non-decreasing).
 */
export interface PowerUpLevelStats {
  /** The power-up this snapshot describes. */
  powerUpId: PowerUpId;
  /** The (clamped, whole-number) upgrade level the snapshot was resolved at. */
  level: number;
  /** Shield — shield bubble duration in seconds. */
  shieldDuration?: number;
  /** Shield — hits the shield absorbs. */
  shieldAbsorptions?: number;
  /** Bomb — clear radius in pixels. */
  bombRange?: number;
  /** Bomb — permanent pulse rate in pulses per second. */
  bombFrequency?: number;
  /** Speed Boost — movement/fire-rate multiplier. */
  speedMultiplier?: number;
  /** Speed Boost — boost duration in seconds. */
  speedDuration?: number;
  /** Phase Shift — pass-through duration in seconds. */
  phaseDuration?: number;
  /** Phase Shift — auto-activation charges granted per pickup. */
  phaseCharges?: number;
  /** Phase Shift — recharge rate for consumed charges (charges/second). */
  phaseRechargeRate?: number;
  /** Teleport — stored teleport uses granted per pickup. */
  teleportStacks?: number;
  /** Teleport — recharge rate for consumed teleports (charges/second). */
  teleportRechargeRate?: number;
  /** Teleport — arrival Phase Shift duration in seconds. */
  teleportPhaseDuration?: number;
  /** Extra Life — lives granted per pickup. */
  lifeGain?: number;
  /** Extra Life — hard lives cap. */
  livesCap?: number;
  /** Magnet — permanent stack cap (attraction radius driver). */
  magnetStacks?: number;
  /** Mineral Scoop — permanent stack cap (attraction radius driver). */
  scoopStacks?: number;
  /** Smart Bomb — ship-centred pulse radius in pixels. */
  aoeRadius?: number;
  /** Smart Bomb — hit points each enemy takes per pulse. */
  smartBombDamage?: number;
  /**
   * Smart Bomb — permanent pulse interval in seconds (descending:
   * `max(10, 30 − 2×level)`).
   */
  smartBombInterval?: number;
  /**
   * Smart Bomb — permanent pulse rate in pulses per second. **Derived** from
   * {@link smartBombInterval} (`1 / interval`) so the rate axis stays
   * monotonic non-decreasing while the stored interval descends.
   */
  smartBombFrequency?: number;
  /** Force Field — bubble duration in seconds. */
  forceFieldDuration?: number;
  /** Force Field — bullets the field reflects before it stops. */
  forceFieldReflects?: number;
  /** Mystery UFO — collector-drone lifetime in seconds. */
  mysteryUfoLifetime?: number;
  /** Mystery UFO — minerals one collector drone can carry before returning. */
  mysteryUfoCapacity?: number;
  /** Mystery UFO — collector-drone vacuum radius in pixels. */
  mysteryUfoRadius?: number;
  /**
   * Mystery UFO — seconds between permanent collector-drone spawns
   * (descending: `max(12, 30 − 2×level)`).
   */
  mysteryUfoSpawnInterval?: number;
  /** Frenzy — bonus damage hits each player bullet applies while active. */
  frenzyBonusHits?: number;
  /** Frenzy — timed window duration in seconds. */
  frenzyDuration?: number;
  /** Chrono Field — fraction of enemy-bullet speed removed while active. */
  chronoSlowFactor?: number;
  /** Chrono Field — timed window duration in seconds. */
  chronoDuration?: number;
  /** Thorn Field — rams absorbed before the counter ends. */
  thornsAbsorbs?: number;
  /** Thorn Field — timed window duration in seconds. */
  thornsDuration?: number;
  /**
   * Thorn Field — seconds between automatic ram recharges while the field
   * is active (descending: `max(5, 12 − level)`).
   */
  thornsRecharge?: number;
  /**
   * Thorn Field — ram recharge rate in rams per second. **Derived** from
   * {@link thornsRecharge} (`1 / interval`) so the rate axis stays monotonic
   * non-decreasing while the stored interval descends (mirrors the Smart
   * Bomb frequency and Orbital Strike frequency).
   */
  thornsRechargeRate?: number;
  /** Salvage — bonus minerals each destroyed enemy drops. */
  salvageMinerals?: number;
  /** Salvage — timed window duration in seconds. */
  salvageDuration?: number;
  /**
   * Orbital Strike — seconds between bolts (descending: `max(10, 30 −
   * 2×level)`). Its derived strikes/second inverse is non-decreasing.
   */
  strikeInterval?: number;
  /** Orbital Strike — hit points the bolt deals. */
  strikeDamage?: number;
  /**
   * Orbital Strike — permanent strike rate in strikes per second.
   * **Derived** from {@link strikeInterval} (`1 / interval`) so the rate
   * axis stays monotonic non-decreasing while the stored interval descends
   * (mirrors the Smart Bomb frequency).
   */
  strikeFrequency?: number;
}

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolves every level variable for `powerUpId` at `level`.
 *
 * The level is clamped to a non-negative whole number (levels are unbounded
 * above). The returned snapshot is pure and deterministic: the same
 * `(powerUpId, level)` always yields the same stats.
 *
 * @param powerUpId - The power-up to resolve (must be in the catalogue).
 * @param level - The upgrade level (0 = first collection, base values).
 * @returns The resolved per-variable stats.
 * @throws Error when `powerUpId` is not in the catalogue.
 */
export function resolvePowerUpAtLevel(
  powerUpId: PowerUpId,
  level: number,
): PowerUpLevelStats {
  // Validates the id (throws for an unknown power-up) and keeps the
  // resolver's contract aligned with the shared catalogue.
  getPowerUpById(powerUpId);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;

  const stats: PowerUpLevelStats = { powerUpId, level: safeLevel };
  const bucket = stats as unknown as Record<string, number>;
  for (const spec of POWER_UP_LEVEL_SPECS[powerUpId]) {
    bucket[spec.variable] = curveValue(spec, safeLevel);
  }
  // The Smart Bomb interval is stored descending (linear-clamped); the
  // pulses/second axis is its monotonic inverse so rate-based consumers keep
  // the model's non-decreasing contract while the interval schedule descends
  // (parent AH-0MV8GPGBL009M0D8).
  const interval = bucket.smartBombInterval;
  if (Number.isFinite(interval) && interval > 0) {
    bucket.smartBombFrequency = 1 / interval;
  }
  // The Orbital Strike interval mirrors the Smart Bomb: stored descending
  // (linear-clamped), its strikes/second inverse is the monotonic rate axis
  // (epic AH-0MVCRC1Q0007JAV1).
  const strikeInterval = bucket.strikeInterval;
  if (Number.isFinite(strikeInterval) && strikeInterval > 0) {
    bucket.strikeFrequency = 1 / strikeInterval;
  }
  // The Thorn Field recharge interval mirrors the same convention: stored
  // descending (linear-clamped), its rams/second inverse is the monotonic
  // rate axis (AH-0MVJ8YKR70096C6T).
  const thornsRecharge = bucket.thornsRecharge;
  if (Number.isFinite(thornsRecharge) && thornsRecharge > 0) {
    bucket.thornsRechargeRate = 1 / thornsRecharge;
  }
  return stats;
}

// ── Temporary-window (field-pickup TTL) resolver ─────────────────────

/**
 * The level-resolved variable that carries each timed kind's effect
 * duration — the window a field pickup opens today, exactly as
 * `EffectsRegistry._applyTimedEffect` reads it.
 *
 * Magnet and Mineral Scoop are deliberately absent: their attraction window
 * is not a levelled axis, so it resolves from the catalogue `duration` (see
 * {@link NON_LEVELLED_TIMED_WINDOW_IDS}).
 */
const TIMED_WINDOW_VARIABLES: Partial<Record<PowerUpId, PowerUpLevelVariable>> = {
  shield: 'shieldDuration',
  speed_boost: 'speedDuration',
  force_field: 'forceFieldDuration',
  frenzy: 'frenzyDuration',
  chrono: 'chronoDuration',
  thorns: 'thornsDuration',
  salvage: 'salvageDuration',
};

/**
 * Timed kinds whose window is a fixed catalogue `duration` rather than a
 * levelled variable (the Magnet / Mineral Scoop attraction window).
 */
const NON_LEVELLED_TIMED_WINDOW_IDS: readonly PowerUpId[] = [
  'magnet',
  'mineral_scoop',
];

/** True when `value` is a usable window length (finite and strictly positive). */
function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolves the **temporary window (TTL, seconds)** a field pickup of
 * `powerUpId` opens on top of the permanent level (parent AH-0MVSTKGC3003OMAC,
 * Resolved decision 1; AH-0MVUGI3Q4009MW6A).
 *
 * The window is a property of the **upgrade**, never a single global
 * constant:
 *
 * - **Timed kinds** resolve their existing level-scaled effect duration
 *   (`shieldDuration`, `speedDuration`, `forceFieldDuration`, …; the Magnet /
 *   Mineral Scoop attraction uses its catalogue `duration`). Behaviour is
 *   unchanged and a levelled kind keeps its level-scaled window.
 * - **Instant kinds** (no timed effect of their own) return the per-entry
 *   `temporaryWindow` TTL from {@link POWER_UP_CATALOGUE}.
 *
 * The catalogue is read at call time, so retuning a TTL is a pure data change.
 *
 * @param powerUpId - The power-up whose field-pickup window is required.
 * @param upgradeLevel - The upgrade level the window opens at (`0` = first
 *   collection). Only the timed kinds use it; instant TTLs are level-free.
 * @returns The window length in seconds (always finite and positive).
 * @throws Error when the kind declares no usable window at all, so a new
 *   instant kind that forgets its TTL fails loudly instead of silently
 *   reverting immediately.
 */
export function resolveTemporaryWindow(
  powerUpId: PowerUpId,
  upgradeLevel = 0,
): number {
  getPowerUpById(powerUpId); // validate the id (throws for unknown power-ups)
  const entry = POWER_UP_CATALOGUE[powerUpId];

  // Timed kinds keep their level-resolved effect duration — checked first so
  // a stray `temporaryWindow` can never flatten a level-scaled window.
  const timedVariable = TIMED_WINDOW_VARIABLES[powerUpId];
  if (timedVariable) {
    const stats = resolvePowerUpAtLevel(
      powerUpId,
      upgradeLevel,
    ) as unknown as Record<string, number | undefined>;
    const levelWindow = stats[timedVariable];
    if (isPositiveFinite(levelWindow)) return levelWindow;
  }

  // Instant kinds declare their own TTL in the catalogue (balance data).
  const declared = entry.temporaryWindow;
  if (isPositiveFinite(declared)) return declared;
  if (declared !== undefined) {
    throw new Error(
      `Power-up "${powerUpId}" declares an invalid temporary TTL ` +
        `(${String(declared)}); expected a finite positive number of seconds.`,
    );
  }

  // Non-levelled timed kinds (Magnet / Mineral Scoop attraction window).
  if (NON_LEVELLED_TIMED_WINDOW_IDS.includes(powerUpId)) {
    if (isPositiveFinite(entry.duration)) return entry.duration;
  }

  throw new Error(
    `Power-up "${powerUpId}" declares no temporary TTL: add a ` +
      '`temporaryWindow` to its catalogue entry (or a timed window ' +
      'variable) so a field pickup can revert.',
  );
}

/**
 * Default temporary window (seconds) of a field-pickup weapon — the existing
 * {@link WEAPON_TIMEOUT_MS} 10 s countdown, surfaced through the same
 * resolver shape as the power-up TTL so a future weapon definition can
 * declare its own window (AH-0MVUGI3Q4009MW6A). No behaviour change: the
 * `Player` weapon timers still use {@link WEAPON_TIMEOUT_MS}.
 */
export const DEFAULT_WEAPON_TEMPORARY_WINDOW = WEAPON_TIMEOUT_MS / 1000;

/**
 * Resolves the temporary window (seconds) a field-pickup weapon opens.
 *
 * @param definition - Optional weapon definition; when it declares a
 *   `temporaryWindow` that value wins over the {@link WEAPON_TIMEOUT_MS}
 *   default.
 * @returns The window length in seconds (always finite and positive).
 * @throws Error when a declared window is not a finite positive number.
 */
export function resolveWeaponTemporaryWindow(
  definition?: { temporaryWindow?: number },
): number {
  const declared = definition?.temporaryWindow;
  if (declared === undefined) return DEFAULT_WEAPON_TEMPORARY_WINDOW;
  if (!isPositiveFinite(declared)) {
    throw new Error(
      `Weapon temporary TTL must be a finite positive number of seconds, ` +
        `got ${String(declared)}.`,
    );
  }
  return declared;
}

// ── Upgrade-change summariser ───────────────────────────────────────

/**
 * Computes a human-readable upgrade-summary string comparing a power-up's
 * stats at `fromLevel` with those at `toLevel`.
 *
 * Every levelled variable that actually changes between the two levels
 * contributes one formatted fragment (see {@link formatDelta}); fragments
 * are joined with `", "`. When nothing changes (the curve has flattened at
 * every cap) the result is the empty string.
 *
 * This is the single source of truth for the hold-full choice overlay's
 * power-up deltas, so the displayed numbers can never drift from the level
 * maths (AC6).
 *
 * @param powerUpId - The power-up to compare.
 * @param fromLevel - The current (pre-upgrade) level.
 * @param toLevel - The next (post-upgrade) level.
 * @returns A summary such as `"+2 Shield time, +1 Shield hits"`, or `""`.
 */
export function summarisePowerUpLevelChange(
  powerUpId: PowerUpId,
  fromLevel: number,
  toLevel: number,
): string {
  const from = resolvePowerUpAtLevel(powerUpId, fromLevel);
  const to = resolvePowerUpAtLevel(powerUpId, toLevel);
  const fromBucket = from as unknown as Record<string, number>;

  const parts: string[] = [];
  for (const spec of POWER_UP_LEVEL_SPECS[powerUpId]) {
    // Deferred axes are tracked by the store but not yet applied by the
    // effect path, so they must not appear in the promised delta (AC4).
    if (DEFERRED_POWER_UP_LEVEL_VARIABLES.has(spec.variable)) {
      continue;
    }
    const before = fromBucket[spec.variable];
    const after = (to as unknown as Record<string, number>)[spec.variable];
    const delta = after - before;
    if (Math.abs(delta) < 1e-9) {
      continue;
    }
    const formatted = formatDelta(spec.label, delta, before, spec.discrete);
    if (formatted) {
      parts.push(formatted);
    }
  }

  return parts.join(', ');
}

// ── Run-scoped level store ──────────────────────────────────────────

/** Default Extra Life lives start (mirrors `P8_LIVES_START` in `effects.ts`). */
export const POWER_UP_LIVES_START = 3;

/**
 * Maximum Phase Shift / Teleport charges either pool can hold — a field
 * pickup, hold-full reward or completed recharge that would push a pool past
 * this cap is discarded (cap of 3, producer AC2).
 */
export const POWER_UP_CHARGE_CAP = 3;

/**
 * The run-scoped power-up level model (AC2/AC3).
 *
 * Responsibilities:
 * - Track each power-up's run-scoped level as a **permanent** component
 *   (hold-full grant count) plus a **temporary** component (field-pickup
 *   stacks). The effective level is their sum; a field pickup's temporary
 *   stacks are cleared by {@link clearTemporary} when its timed window
 *   expires (leaving the permanent level or, with none, making the item
 *   inactive). Both components are cleared by {@link reset} on run restart
 *   (weapon parity).
 * - Derive the existing stack/charge semantics from the level model rather
 *   than from second, independent counters:
 *   - Magnet/Mineral Scoop permanent stacks = `min(permanentGrants, levelCap)`,
 *   - Teleport stored teleports and Phase Shift charges = `grants − consumed + recharged`
 *     in a run-scoped pool capped at {@link POWER_UP_CHARGE_CAP} (3): each consumed charge
 *     starts its own level-derived recharge timer (advanced by {@link tickRecharge}); a
 *     completed timer returns one charge; grants and completed recharges are
 *     clamped so the pool never exceeds the cap,
 *   - Extra Life lives = `min(livesStart + Σ lifeGain(level), livesCap)`.
 *
 * The hold-full Phase Shift reward is an **owned flag** (`isPhasePermanent`), not an
 * unlimited supply: it adds exactly one charge to the recharging pool. The
 * recharge timers are run-scoped — they advance with {@link tickRecharge} and are
 * cleared by {@link reset} on run restart (weapon parity).
 *
 * Pure and deterministic (no scene/storage coupling) so the game and every
 * gym can share exactly one level model.
 */
export class PowerUpLevelStore {
  private _permanentGrants = new Map<PowerUpId, number>();
  private _tempStacks = new Map<PowerUpId, number>();
  private _teleportStacks = 0;
  private _phaseCharges = 0;
  private _phasePermanent = false;
  /** Remaining seconds of each Phase Shift charge currently recharging. */
  private _phaseRechargeTimers: number[] = [];
  /** Remaining seconds of each Teleport charge currently recharging. */
  private _teleportRechargeTimers: number[] = [];
  private _lives: number;
  private readonly _livesStart: number;

  constructor(livesStart: number = POWER_UP_LIVES_START) {
    this._livesStart = livesStart;
    this._lives = livesStart;
  }

  /**
   * Records a collection of `id`: increments the run-scoped level and, for
   * `permanent` (hold-full) rewards, the permanent-grant count. Extra Life also adds
   * the level-derived lives (clamped to the level-derived cap).
   *
   * **Temporary-stack contract (AC3/AC5, AH-0MVUGI4IC006PUS5).** A field
   * pickup (`permanent: false`) adds a temporary stack that is only valid
   * together with the **field-pickup window** the `EffectsRegistry` opens for
   * it; that window's expiry is the only thing that removes the stack
   * ({@link clearTemporary}). A `permanent: true` grant therefore **never
   * touches `_tempStacks`** and never cancels or re-opens an open window: an
   * active window keeps its own schedule and expires, so a permanent grant
   * landing mid-window settles on the permanent level instead of stranding
   * the temporary component. No second counter, map or timer is involved.
   *
   * @param id - The collected power-up.
   * @param permanent - True for a hold-full permanent reward.
   * @returns The new collection level.
   */
  collect(id: PowerUpId, permanent = false): number {
    getPowerUpById(id); // validate id (throws for unknown power-ups)
    if (permanent) {
      this._permanentGrants.set(id, this.permanentGrants(id) + 1);
    } else {
      this._tempStacks.set(id, this.getTempStacks(id) + 1);
    }
    const next = this.getEffectiveLevel(id);

    const stats = this.stats(id);
    switch (id) {
      case 'phase_shift':
        if (permanent) {
          // The hold-full reward is a recharging pool: it marks ownership and
          // adds exactly one charge (clamped at the cap), not an unlimited
          // supply (AH-0MV82I7TX0009JMT AC4).
          this._phasePermanent = true;
          this._phaseCharges = Math.min(
            this._phaseCharges + 1,
            POWER_UP_CHARGE_CAP,
          );
        } else {
          // A field pickup grants the level-derived count, clamped so the
          // pool never exceeds the cap (AC2).
          this._phaseCharges = Math.min(
            this._phaseCharges + (stats.phaseCharges ?? 0),
            POWER_UP_CHARGE_CAP,
          );
        }
        break;
      case 'teleport':
        // A hold-full reward grants exactly one teleport (mirroring Phase
        // Shift); a field pickup grants the level-derived count. Both are
        // clamped at the cap (AC2/AC5).
        this._teleportStacks = Math.min(
          this._teleportStacks + (permanent ? 1 : stats.teleportStacks ?? 0),
          POWER_UP_CHARGE_CAP,
        );
        break;
      case 'extra_life':
        this._lives = Math.min(
          this._livesCap(),
          this._lives + (stats.lifeGain ?? 0),
        );
        break;
      default:
        break;
    }
    return next;
  }

  /**
   * The **effective** run-scoped collection level of `id` — permanent grants
   * plus active temporary stacks (0 when the item is not owned). Drives the
   * effect path and the HUD readouts (AC5).
   */
  getLevel(id: PowerUpId): number {
    return this.getEffectiveLevel(id);
  }

  /**
   * The effective level of `id`: `permanentGrants + tempStacks` (0 when the
   * item is not owned). The temporary component is removed by
   * {@link clearTemporary} when the item's timed window expires.
   */
  getEffectiveLevel(id: PowerUpId): number {
    return this.permanentGrants(id) + this.getTempStacks(id);
  }

  /**
   * The **permanent** level of `id`: the number of hold-full grants only.
   * This is what the hold-full choice prices (AC4), so a temporary field
   * pickup never inflates the offered level.
   */
  getPermanentLevel(id: PowerUpId): number {
    return this.permanentGrants(id);
  }

  /** Number of active temporary (field-pickup) stacks of `id`. */
  getTempStacks(id: PowerUpId): number {
    return this._tempStacks.get(id) ?? 0;
  }

  /**
   * The **effective** resolver level for `id`: the number of upgrades applied
   * by permanent grants *and* temporary stacks, i.e. `effectiveLevel − 1`
   * (the first collection is base — weapon parity).
   */
  getUpgradeLevel(id: PowerUpId): number {
    return Math.max(0, this.getEffectiveLevel(id) - 1);
  }

  /**
   * The **permanent** resolver level for `id`: the number of upgrades applied
   * by hold-full grants only, i.e. `permanentGrants − 1`. Used to cap
   * permanent-stack counts so a temporary field pickup cannot raise them
   * (AC9).
   */
  getPermanentUpgradeLevel(id: PowerUpId): number {
    return Math.max(0, this.permanentGrants(id) - 1);
  }

  /**
   * Snapshot of every power-up the player **permanently** owns this run, with
   * its permanent level (id → level ≥ 1). Used by the hold-full choice to
   * offer power-up level-ups that reflect only permanent progress (AC4/AC6);
   * a field-only item is omitted, so it is still offered as `★ New`.
   */
  getLevels(): Array<{ id: PowerUpId; level: number }> {
    return [...this._permanentGrants.entries()]
      .filter(([, level]) => level > 0)
      .map(([id, level]) => ({ id, level }));
  }

  /**
   * Snapshot of every power-up with an **active temporary stack** (a field
   * pickup whose timed window has not expired). Used by the six-slot cap: a
   * temporary stack occupies a slot while it lasts (parent AH-0MVLIJT3M005HPHF,
   * producer Q4a), so occupancy must see these kinds alongside the permanent
   * grants — derived, never counted by a second counter.
   */
  getTempPowerUpIds(): PowerUpId[] {
    return [...this._tempStacks.entries()]
      .filter(([, stacks]) => stacks > 0)
      .map(([id]) => id);
  }

  /**
   * Removes `id`'s temporary stacks (its field-pickup window expired). The
   * permanent grants — and any consumable already granted (Phase Shift charges, Teleport
   * teleports) — are left intact (Resolved decision 1b). The kind therefore
   * stops occupying a six-slot slot unless it is permanently owned.
   */
  clearTemporary(id: PowerUpId): void {
    this._tempStacks.delete(id);
  }

  /** Number of permanent (hold-full) grants of `id`. */
  permanentGrants(id: PowerUpId): number {
    return this._permanentGrants.get(id) ?? 0;
  }

  /** Resolved stats for `id` at its current upgrade level. */
  stats(id: PowerUpId): PowerUpLevelStats {
    return resolvePowerUpAtLevel(id, this.getUpgradeLevel(id));
  }

  /** Magnet permanent magnet stacks (derived, capped by the level model). */
  magnetStacks(): number {
    return Math.min(
      this.permanentGrants('magnet'),
      this._permanentStats('magnet').magnetStacks ?? 0,
    );
  }

  /** Mineral Scoop permanent mineral-scoop stacks (derived, capped by the level model). */
  scoopStacks(): number {
    return Math.min(
      this.permanentGrants('mineral_scoop'),
      this._permanentStats('mineral_scoop').scoopStacks ?? 0,
    );
  }

  /** Resolved stats for `id` at its current **permanent** upgrade level. */
  private _permanentStats(id: PowerUpId): PowerUpLevelStats {
    return resolvePowerUpAtLevel(id, this.getPermanentUpgradeLevel(id));
  }

  /** Stored Teleport teleport uses (level-derived grants, minus consumes). */
  teleportStacks(): number {
    return this._teleportStacks;
  }

  /**
   * Consumes one stored teleport use. Returns true when one was available.
   * A consumed charge starts its own recharge timer whose duration is the
   * level-derived {@link teleportRechargeTime} at the moment of consumption;
   * {@link tickRecharge} returns the charge to the pool when the timer
   * elapses (per-charge recharge model, AC1).
   */
  consumeTeleport(): boolean {
    if (this._teleportStacks <= 0) return false;
    this._teleportStacks -= 1;
    this._teleportRechargeTimers.push(this.teleportRechargeTime());
    return true;
  }

  /**
   * Teleport recharge time in **seconds** — the seconds inverse (`1 / rate`)
   * of the level-derived
   * {@link PowerUpLevelStats.teleportRechargeRate}. A higher level resolves a
   * shorter time (15 s at base → 5 s at the cap). This is the API surface the
   * recharge engine consumes when a teleport charge is spent.
   */
  teleportRechargeTime(): number {
    const rate = this.stats('teleport').teleportRechargeRate ?? 0;
    return rate > 0 ? 1 / rate : 0;
  }

  /** Stored Phase Shift auto-activation charges (level-derived grants, minus consumes). */
  phaseCharges(): number {
    return this._phaseCharges;
  }

  /**
   * Whether the hold-full reward made Phase Shift permanently owned. This is
   * an ownership flag only — the pool is finite and recharges like any other
   * charge (AH-0MV82I7TX0009JMT AC4).
   */
  isPhasePermanent(): boolean {
    return this._phasePermanent;
  }

  /**
   * Consumes one Phase Shift charge. Returns true when one was available.
   * A consumed charge starts its own recharge timer whose duration is the
   * level-derived {@link phaseRechargeTime} at the moment of consumption;
   * {@link tickRecharge} returns the charge to the pool when the timer
   * elapses (per-charge recharge model, AC1). The permanent reward is not
   * an unlimited supply: an empty pool blocks activation.
   */
  consumePhaseCharge(): boolean {
    if (this._phaseCharges <= 0) return false;
    this._phaseCharges -= 1;
    this._phaseRechargeTimers.push(this.phaseRechargeTime());
    return true;
  }

  /**
   * Advances the run-scoped recharge clock by `dt` seconds. Each recharging
   * Phase Shift / Teleport charge counts down independently; when a timer
   * elapses the charge returns to its pool, clamped so the pool never
   * exceeds {@link POWER_UP_CHARGE_CAP} (a recharge landing on a full pool is
   * discarded). Negative or non-finite `dt` is a no-op.
   */
  tickRecharge(dt: number): void {
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (safeDt <= 0) return;
    this._phaseCharges = this._advanceRechargeTimers(
      this._phaseRechargeTimers,
      this._phaseCharges,
      safeDt,
    );
    this._teleportStacks = this._advanceRechargeTimers(
      this._teleportRechargeTimers,
      this._teleportStacks,
      safeDt,
    );
  }

  /**
   * Decrements every recharging timer in `timers` by `dt`, moving each
   * completed timer's charge back into `pool` (clamped at the cap). Returns
   * the adjusted pool.
   */
  private _advanceRechargeTimers(
    timers: number[],
    pool: number,
    dt: number,
  ): number {
    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i] -= dt;
      if (timers[i] > 0) continue;
      timers.splice(i, 1);
      pool = Math.min(pool + 1, POWER_UP_CHARGE_CAP);
    }
    return pool;
  }

  /**
   * Phase Shift recharge time in **seconds** — the seconds inverse
   * (`1 / rate`) of the level-derived
   * {@link PowerUpLevelStats.phaseRechargeRate}. A higher level resolves a
   * shorter time (30 s at base → 10 s at the cap). This is the API surface the
   * recharge engine consumes when a Phase Shift charge is spent.
   */
  phaseRechargeTime(): number {
    const rate = this.stats('phase_shift').phaseRechargeRate ?? 0;
    return rate > 0 ? 1 / rate : 0;
  }

  /** Current lives (Extra Life model); starts at the configured start, capped. */
  lives(): number {
    return this._lives;
  }

  /**
   * Sets the lives counter directly (clamped to `[0, livesCap]`). Lets the
   * playable game push its authoritative run state (`GameState`) into the
   * single level store when the player is hit; Extra Life collection still uses
   * {@link collect}. The cap is level-derived (base 5), so an authoritative
   * push can never exceed it.
   */
  setLives(value: number): void {
    this._lives = Math.max(0, Math.min(this._livesCap(), Math.floor(value)));
  }

  /** The level-derived hard lives cap. */
  private _livesCap(): number {
    return this.stats('extra_life').livesCap ?? 5;
  }

  /** Resets every level and derived resource (run restart). */
  reset(): void {
    this._permanentGrants.clear();
    this._tempStacks.clear();
    this._teleportStacks = 0;
    this._phaseCharges = 0;
    this._phasePermanent = false;
    this._phaseRechargeTimers = [];
    this._teleportRechargeTimers = [];
    this._lives = this._livesStart;
  }
}
