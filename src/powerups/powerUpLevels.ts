/**
 * Power-up level-curve catalogue, pure resolver and run-scoped level store
 * (parent AH-0MUU2QJE2007JNR6).
 *
 * Power-ups P3–P10 are **constantly upgradable**, mirroring the weapon
 * levelling system (`src/utils/weaponLevels.ts`, parent AH-0MUPMPCB2009J54J):
 *
 * - {@link POWER_UP_LEVEL_SPECS} — one spec (base, finite cap, curve rate
 *   `k`, `discrete`, label + rationale) per levelled variable, for **every**
 *   power-up P3–P10. The specs reuse the shared exponential-saturation
 *   curve from `src/utils/curve.ts` so there is exactly **one** curve
 *   implementation for weapons and power-ups (AC1/AC4).
 * - {@link resolvePowerUpAtLevel} — the **pure** resolver mapping
 *   `(powerUpId, level)` to a {@link PowerUpLevelStats} snapshot. Pure,
 *   deterministic, monotonic non-decreasing and clamped to each variable's
 *   finite cap (AC4).
 * - {@link PowerUpLevelStore} — the run-scoped level model. Every
 *   collection increments the power-up's level; the level persists across a
 *   timed effect expiring and resets only on run restart (AC2, weapon
 *   parity). Existing stack/charge semantics (P9/P10 permanent stacks, P7
 *   stored teleports, P6 charges, P8 lives) are **derived from this model**
 *   rather than tracked by a second, independent counter (AC3).
 *
 * ## Level semantics (weapon parity)
 *
 * `level` is the number of *upgrades* applied — exactly like
 * `resolveWeaponAtLevel`: the **first** collection unlocks the power-up at
 * its base (existing) strength (`resolvePowerUpAtLevel(id, 0)`), and each
 * *further* collection applies the next upgrade. The store holds the raw
 * collection count and exposes {@link PowerUpLevelStore.getUpgradeLevel}
 * for the resolver.
 *
 * ## P9/P10 hybrid reconciliation
 *
 * P9 Magnet and P10 Mineral Scoop are **hybrids**: a field pickup grants a
 * timed (refresh-only) attraction, while a hold-full reward grants a
 * permanent stack (GDD §4.4; AH-0MUTOTLCY005NZ8L / AH-0MUTPEHMP0074Y1L).
 * The level model therefore tracks **both** the total collection count
 * (which the timed path and the `magnetStacks`/`scoopStacks` cap scale with)
 * and the number of *permanent* grants. The permanent stack count is
 * `min(permanentGrants, levelCap)` — the cap is level-derived, and there is
 * no second, independently-incremented stack counter. A field pickup still
 * does not create a permanent stack, so the hybrid semantics are preserved.
 *
 * Pure and deterministic: no scene, DOM, Phaser or storage coupling.
 */

import { PowerUpId, getPowerUpById } from './types';
import {
  curveValue,
  formatDelta,
  type CurveSpec,
} from '../utils/curve';

// ── Level variables ─────────────────────────────────────────────────

/**
 * The tunable power-up level variable space. Each variable is monotonic
 * non-decreasing in level (a higher level never makes the power-up worse).
 */
export type PowerUpLevelVariable =
  /** P3 Shield — bubble duration in seconds. */
  | 'shieldDuration'
  /** P3 Shield — hits absorbed before the bubble pops. */
  | 'shieldAbsorptions'
  /** P4 Bomb — clear radius in pixels. */
  | 'bombRange'
  /** P4 Bomb — permanent pulse rate in pulses per second. */
  | 'bombFrequency'
  /** P5 Speed Boost — movement/fire-rate multiplier. */
  | 'speedMultiplier'
  /** P5 Speed Boost — duration in seconds. */
  | 'speedDuration'
  /** P6 Phase Shift — pass-through duration in seconds. */
  | 'phaseDuration'
  /** P6 Phase Shift — auto-activation charges granted per pickup. */
  | 'phaseCharges'
  /** P7 Teleport — stored stacks granted per pickup. */
  | 'teleportStacks'
  /** P7 Teleport — arrival Phase Shift duration in seconds. */
  | 'teleportPhaseDuration'
  /** P8 Extra Life — lives granted per pickup. */
  | 'lifeGain'
  /** P8 Extra Life — hard lives cap. */
  | 'livesCap'
  /** P9 Magnet — permanent stack cap (and attraction-radius growth). */
  | 'magnetStacks'
  /** P10 Mineral Scoop — permanent stack cap (radius growth). */
  | 'scoopStacks';

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
  'teleportStacks',
  'teleportPhaseDuration',
  'lifeGain',
  'livesCap',
  'magnetStacks',
  'scoopStacks',
];

/**
 * Level variables whose effect-path **consumption** is not yet wired, and
 * which a `power-up-level` change summary must therefore exclude so the
 * hold-full choice never promises a delta the effect path does not apply
 * (AC4).
 *
 * **Empty since AH-0MUVM9RAO004Y3LB** wired both the P3 `shieldAbsorptions`
 * axis (multi-hit shield) and the redesigned P4 `bombRange`/`bombFrequency`
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
 * The per-power-up level catalogue — one entry per power-up P3–P10, each
 * holding that power-up's levelable variables.
 *
 * Caps are deliberately conservative for the survivability power-ups
 * (shield, phase, lives), which are more balance-sensitive than weapon
 * damage (AC1, producer risk note).
 */
export const POWER_UP_LEVEL_SPECS: Record<PowerUpId, PowerUpLevelSpec[]> = {
  // P3 Shield — absorbs its level-resolved hits (base 1, cap 3) in a 15 s bubble.
  P3: [
    {
      variable: 'shieldDuration',
      powerUpId: 'P3',
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
      powerUpId: 'P3',
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

  // P4 Bomb — ranged clear, single on a field pickup; periodic when permanent.
  P4: [
    {
      variable: 'bombRange',
      powerUpId: 'P4',
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
      powerUpId: 'P4',
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

  // P5 Speed Boost — +50% movement and fire rate for 10 s.
  P5: [
    {
      variable: 'speedMultiplier',
      powerUpId: 'P5',
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
      powerUpId: 'P5',
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

  // P6 Phase Shift — charge-based auto pass-through.
  P6: [
    {
      variable: 'phaseDuration',
      powerUpId: 'P6',
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
      powerUpId: 'P6',
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
        'grants the second charge at the first upgrade. The hold-full P6 ' +
        'reward remains unlimited (permanent) and is unaffected.',
    },
  ],

  // P7 Teleport — stored FIFO uses, S/↓ to activate.
  P7: [
    {
      variable: 'teleportStacks',
      powerUpId: 'P7',
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
        'k=0.5 grants a second use at the first upgrade, then flattens.',
    },
    {
      variable: 'teleportPhaseDuration',
      powerUpId: 'P7',
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

  // P8 Extra Life — +1 life immediately, capped at 5.
  P8: [
    {
      variable: 'lifeGain',
      powerUpId: 'P8',
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
      powerUpId: 'P8',
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
        'is level-agnostic; P8 levels the lives *gained* per pickup instead ' +
        'of raising the ceiling.',
    },
  ],

  // P9 Magnet — hybrid timed pickup / permanent stacking upgrade.
  P9: [
    {
      variable: 'magnetStacks',
      powerUpId: 'P9',
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
        'stack). Deriving the cap from the level lets a levelled P9 reach ' +
        'the cap sooner; k=0.35 front-loads the early stacks while never ' +
        'exceeding 5.',
    },
  ],

  // P10 Mineral Scoop — hybrid timed pickup / permanent stacking upgrade.
  P10: [
    {
      variable: 'scoopStacks',
      powerUpId: 'P10',
      label: 'Scoop',
      unit: '',
      description: 'Permanent stack cap (drives the attraction radius).',
      curve: 'exponential-saturation',
      base: 1,
      cap: 5,
      k: 0.35,
      discrete: true,
      rationale:
        'Mirrors P9 so the two attraction power-ups stay behaviourally ' +
        'consistent (shared radius curve); the 5-stack cap is retained and ' +
        'the level-derived cap reaches it sooner.',
    },
  ],
};

/**
 * The order power-ups are listed in {@link POWER_UP_LEVEL_SPECS}. Iterate
 * this so catalogue-completeness checks are deterministic.
 */
export const POWER_UP_LEVEL_IDS: readonly PowerUpId[] = [
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
];

// ── Resolved stats ──────────────────────────────────────────────────

/**
 * The resolved per-variable values for a power-up at a given level. Field
 * names match {@link PowerUpLevelVariable}; only the variables that belong
 * to the resolved power-up are present.
 *
 * Every present value is monotonic non-decreasing in level and never
 * exceeds the corresponding spec cap.
 */
export interface PowerUpLevelStats {
  /** The power-up this snapshot describes. */
  powerUpId: PowerUpId;
  /** The (clamped, whole-number) upgrade level the snapshot was resolved at. */
  level: number;
  /** P3 — shield bubble duration in seconds. */
  shieldDuration?: number;
  /** P3 — hits the shield absorbs. */
  shieldAbsorptions?: number;
  /** P4 — clear radius in pixels. */
  bombRange?: number;
  /** P4 — permanent pulse rate in pulses per second. */
  bombFrequency?: number;
  /** P5 — movement/fire-rate multiplier. */
  speedMultiplier?: number;
  /** P5 — boost duration in seconds. */
  speedDuration?: number;
  /** P6 — pass-through duration in seconds. */
  phaseDuration?: number;
  /** P6 — auto-activation charges granted per pickup. */
  phaseCharges?: number;
  /** P7 — stored teleport uses granted per pickup. */
  teleportStacks?: number;
  /** P7 — arrival Phase Shift duration in seconds. */
  teleportPhaseDuration?: number;
  /** P8 — lives granted per pickup. */
  lifeGain?: number;
  /** P8 — hard lives cap. */
  livesCap?: number;
  /** P9 — permanent stack cap (attraction radius driver). */
  magnetStacks?: number;
  /** P10 — permanent stack cap (attraction radius driver). */
  scoopStacks?: number;
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
  return stats;
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

/** Default P8 lives start (mirrors `P8_LIVES_START` in `effects.ts`). */
export const POWER_UP_LIVES_START = 3;

/**
 * The run-scoped power-up level model (AC2/AC3).
 *
 * Responsibilities:
 * - Track each power-up's run-scoped **level** (number of collections).
 *   Every collection — field pickup or hold-full permanent reward —
 *   increments it; the level persists across a timed effect expiring and is
 *   cleared only by {@link reset} on run restart (weapon parity).
 * - Derive the existing stack/charge semantics from the level model rather
 *   than from second, independent counters:
 *   - P9/P10 permanent stacks = `min(permanentGrants, levelCap)`,
 *   - P7 stored teleports and P6 charges = `grants − consumed` (grants are
 *     level-derived; consumption is inherent to a consumable resource),
 *   - P8 lives = `min(livesStart + Σ lifeGain(level), livesCap)`.
 *
 * Pure and deterministic (no scene/storage coupling) so the game and every
 * gym can share exactly one level model.
 */
export class PowerUpLevelStore {
  private _levels = new Map<PowerUpId, number>();
  private _permanentGrants = new Map<PowerUpId, number>();
  private _teleportStacks = 0;
  private _phaseCharges = 0;
  private _phasePermanent = false;
  private _lives: number;
  private readonly _livesStart: number;

  constructor(livesStart: number = POWER_UP_LIVES_START) {
    this._livesStart = livesStart;
    this._lives = livesStart;
  }

  /**
   * Records a collection of `id`: increments the run-scoped level and, for
   * `permanent` (hold-full) rewards, the permanent-grant count. P8 also adds
   * the level-derived lives (clamped to the level-derived cap).
   *
   * @param id - The collected power-up.
   * @param permanent - True for a hold-full permanent reward.
   * @returns The new collection level.
   */
  collect(id: PowerUpId, permanent = false): number {
    getPowerUpById(id); // validate id (throws for unknown power-ups)
    const next = this.getLevel(id) + 1;
    this._levels.set(id, next);
    if (permanent) {
      this._permanentGrants.set(id, this.permanentGrants(id) + 1);
    }

    const stats = this.stats(id);
    switch (id) {
      case 'P6':
        if (permanent) {
          this._phasePermanent = true;
        } else {
          this._phaseCharges += stats.phaseCharges ?? 0;
        }
        break;
      case 'P7':
        this._teleportStacks += stats.teleportStacks ?? 0;
        break;
      case 'P8':
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

  /** The run-scoped collection level of `id` (0 when never collected). */
  getLevel(id: PowerUpId): number {
    return this._levels.get(id) ?? 0;
  }

  /**
   * The resolver level for `id`: the number of *upgrades* applied, i.e.
   * `collections − 1` (the first collection is base — weapon parity).
   */
  getUpgradeLevel(id: PowerUpId): number {
    return Math.max(0, this.getLevel(id) - 1);
  }

  /**
   * Snapshot of every power-up the player has collected this run, with its
   * current level (id → level ≥ 1). Used by the hold-full choice to offer
   * power-up level-ups that reflect the run's progress (AC6).
   */
  getLevels(): Array<{ id: PowerUpId; level: number }> {
    return [...this._levels.entries()]
      .filter(([, level]) => level > 0)
      .map(([id, level]) => ({ id, level }));
  }

  /** Number of permanent (hold-full) grants of `id`. */
  permanentGrants(id: PowerUpId): number {
    return this._permanentGrants.get(id) ?? 0;
  }

  /** Resolved stats for `id` at its current upgrade level. */
  stats(id: PowerUpId): PowerUpLevelStats {
    return resolvePowerUpAtLevel(id, this.getUpgradeLevel(id));
  }

  /** P9 permanent magnet stacks (derived, capped by the level model). */
  magnetStacks(): number {
    return Math.min(
      this.permanentGrants('P9'),
      this.stats('P9').magnetStacks ?? 0,
    );
  }

  /** P10 permanent mineral-scoop stacks (derived, capped by the level model). */
  scoopStacks(): number {
    return Math.min(
      this.permanentGrants('P10'),
      this.stats('P10').scoopStacks ?? 0,
    );
  }

  /** Stored P7 teleport uses (level-derived grants, minus consumes). */
  teleportStacks(): number {
    return this._teleportStacks;
  }

  /**
   * Consumes one stored teleport use. Returns true when one was available.
   */
  consumeTeleport(): boolean {
    if (this._teleportStacks <= 0) return false;
    this._teleportStacks -= 1;
    return true;
  }

  /** Stored P6 auto-activation charges (level-derived grants, minus consumes). */
  phaseCharges(): number {
    return this._phaseCharges;
  }

  /** Whether the hold-full reward granted unlimited P6 activations. */
  isPhasePermanent(): boolean {
    return this._phasePermanent;
  }

  /**
   * Consumes one P6 charge unless the permanent reward is active. Returns
   * true when an activation is available.
   */
  consumePhaseCharge(): boolean {
    if (this._phasePermanent) return true;
    if (this._phaseCharges <= 0) return false;
    this._phaseCharges -= 1;
    return true;
  }

  /** Current lives (P8 model); starts at the configured start, capped. */
  lives(): number {
    return this._lives;
  }

  /**
   * Sets the lives counter directly (clamped to `[0, livesCap]`). Lets the
   * playable game push its authoritative run state (`GameState`) into the
   * single level store when the player is hit; P8 collection still uses
   * {@link collect}. The cap is level-derived (base 5), so an authoritative
   * push can never exceed it.
   */
  setLives(value: number): void {
    this._lives = Math.max(0, Math.min(this._livesCap(), Math.floor(value)));
  }

  /** The level-derived hard lives cap. */
  private _livesCap(): number {
    return this.stats('P8').livesCap ?? 5;
  }

  /** Resets every level and derived resource (run restart). */
  reset(): void {
    this._levels.clear();
    this._permanentGrants.clear();
    this._teleportStacks = 0;
    this._phaseCharges = 0;
    this._phasePermanent = false;
    this._lives = this._livesStart;
  }
}
