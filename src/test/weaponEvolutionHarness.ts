/**
 * Cross-cutting verification harness for weapon evolutions
 * (AH-0MWU7BAA0009X1MN; epic AH-0MWL7OWPF003E4TP AC5, AC6, AC9).
 *
 * The evolved weapon is **pattern, not power**: a fusion may widen coverage and
 * change the rhythm's shape, but it must never raise the number of damage
 * instances per cadence tick, move the cadence off the shared 16th-note
 * lattice, morph a pattern off a bar downbeat, or make the same seed and input
 * trace produce a different firing trace. Those four rules are measured here,
 * once, as pure functions, so the field-tier and balance-evidence children
 * extend a gate that already exists rather than inventing one.
 *
 * ## Why a harness module rather than test-local helpers
 *
 * Three suites consume the same measurements (the resolver suite, the beat
 * suite and the shared combat-core suite), and the field-tier child consumes
 * them again. Defining "damage instances per cadence tick" or "bar downbeat"
 * three times is exactly the drift this epic forbids, so the measurement lives
 * once — here — and every check returns a structured verdict.
 *
 * The module is **pure**: no Phaser, no DOM, no storage, no wall clock. The one
 * stochastic input (the seeded firing input trace) draws from the shared
 * `createSeededRng`, so a seed is always reproducible.
 *
 * ## Red-first by construction
 *
 * Each check returns `{ holds, violations }` and accepts the pattern/damage
 * providers it reads, defaulting to the shipped resolvers. A test can therefore
 * feed a deliberately broken provider and assert the check reports the exact
 * violation (red), then assert the shipped table holds (green) — proving the
 * gate actually fails when the rule is broken, before any implementation child
 * turns it green.
 *
 * ## What "damage instances per cadence tick" means
 *
 * A **cadence tick** is one beat of the shared lattice; a pattern's instance
 * count is its onsets per beat (`k / (n / 4)`). A damage instance is a
 * projectile the shared fire path emits **at firing time**: one per evolved
 * onset ({@link EVOLVED_DAMAGE_INSTANCES_PER_ONSET}). Downstream instances a
 * bullet creates by itself (a Chain Ricochet hop, a Cluster Barrage lingering
 * blast) are collisions, not cadence ticks, and stay out of this measure — that
 * is what keeps a fusion a *pattern* change rather than a damage multiplier.
 *
 * The halves' instance rate comes from the catalogue's per-volley bullet count
 * (`offsets.length`), so the comparison is between real damage output per beat,
 * not just onset counts.
 *
 * ## Lattice and morph rules
 *
 * - Every evolved rung resolves on the shared 16th-note step at `beatBpm`
 *   (`beatSubdivisionMs(4, bpm)`), so onsets are whole 16th notes.
 * - Every rung tiles a whole number of bars ({@link CADENCE_STEPS_PER_BAR}), so
 *   a rung boundary — the only point a pattern can morph — coincides with a bar
 *   downbeat.
 * - A morph is scheduled on the bar grid: the fire path's morph time is the
 *   next bar downbeat, never mid-bar.
 *
 * @module src/test/weaponEvolutionHarness
 */

import { createSeededRng } from '../core/rng';
import {
  DEFAULT_BPM,
  SIXTEENTH_NOTE_SUBDIVISIONS,
  beatSubdivisionMs,
  isOnGrid,
  nextTick,
} from '../utils/beat';
import { euclidPattern } from '../utils/euclid';
import { WEAPON_CATALOGUE, type WeaponId } from '../utils/weapons';
import {
  WEAPON_PAIRINGS,
  resolveEvolvedWeaponPattern,
  type EvolvedWeaponId,
  type WeaponPairing,
} from '../utils/weaponEvolutions';
import {
  resolveWeaponPattern,
  type EuclideanPattern,
} from '../utils/weaponLevels';

// ── Rules and units ─────────────────────────────────────────────────

/** Steps per beat on the shared lattice (a 16th note: 4 per beat). */
export const CADENCE_STEPS_PER_BEAT = SIXTEENTH_NOTE_SUBDIVISIONS;

/** Steps in one 4-beat bar — the only boundary a pattern may morph on. */
export const CADENCE_STEPS_PER_BAR = CADENCE_STEPS_PER_BEAT * 4;

/**
 * Damage instances an evolved weapon emits per cadence onset — exactly one.
 *
 * This is the harness's contract for the field tier: coverage may travel *with*
 * the projectile (bounce, hop, lingering blast), but a fusion never spawns extra
 * projectiles at the same onset to buy damage. A change to this constant is a
 * balance decision that must update the damage-parity comparison deliberately.
 */
export const EVOLVED_DAMAGE_INSTANCES_PER_ONSET = 1;

/** Evolution levels the damage-parity comparison covers (0 through 12). */
export const DAMAGE_PARITY_LEVELS: readonly number[] = Object.freeze(
  Array.from({ length: 13 }, (_, level) => level),
);

/** Tempos the lattice-conformance check covers. */
export const LATTICE_BPMS: readonly number[] = Object.freeze([
  DEFAULT_BPM,
  100,
  120,
  160,
]);

/** Tolerance for comparing authored densities. */
const DENSITY_EPSILON = 1e-9;

/** Tolerance for comparing millisecond values (the beat module's epsilon). */
const MS_EPSILON = 1e-6;

// ── Verdicts ────────────────────────────────────────────────────────

/** One broken rule, with enough detail to reproduce it. */
export interface VerificationViolation {
  /** Stable rule id (e.g. `damage-parity/evolved-exceeds-halves`). */
  readonly rule: string;
  /** Human-readable facts: which weapon, level, pattern and values. */
  readonly detail: string;
}

/** A check's verdict: `holds` plus one violation per broken rule. */
export interface VerificationVerdict {
  readonly holds: boolean;
  readonly violations: readonly VerificationViolation[];
}

// ── Damage instances per cadence tick ───────────────────────────────

/**
 * Onsets per beat for a pattern: `k × stepsPerBeat / n`.
 *
 * An unusable pattern resolves to `0` rather than `NaN`/`Infinity`.
 */
export function onsetsPerBeat(pattern: EuclideanPattern): number {
  if (!Number.isFinite(pattern.k) || !(pattern.n > 0)) return 0;
  return (pattern.k * CADENCE_STEPS_PER_BEAT) / pattern.n;
}

/**
 * Damage instances a pattern emits per beat — its onsets per beat times the
 * instances each onset spawns.
 */
export function damageInstancesPerBeat(
  pattern: EuclideanPattern,
  instancesPerOnset: number = EVOLVED_DAMAGE_INSTANCES_PER_ONSET,
): number {
  if (!Number.isFinite(instancesPerOnset) || instancesPerOnset <= 0) return 0;
  return onsetsPerBeat(pattern) * instancesPerOnset;
}

/**
 * Bullets a catalogue weapon emits per onset at level 0 — the per-volley count
 * its `offsets` pattern spawns. Always at least one, so a malformed catalogue
 * row cannot make a half look silent.
 */
export function catalogueInstancesPerOnset(weaponId: WeaponId): number {
  const definition = WEAPON_CATALOGUE[weaponId];
  return Math.max(1, definition?.offsets.length ?? 0);
}

/** One half of a pairing, with its damage-instance rate. */
export interface DamageParityHalf {
  readonly weaponId: WeaponId;
  readonly instancesPerBeat: number;
}

/** One measured row: a pairing at one evolution level. */
export interface DamageParityRow {
  readonly evolvedId: EvolvedWeaponId;
  readonly level: number;
  readonly evolvedInstancesPerBeat: number;
  readonly halves: readonly DamageParityHalf[];
  readonly halfSumInstancesPerBeat: number;
  readonly holds: boolean;
}

/** Injected providers, so a red fixture can replace the shipped resolvers. */
export interface DamageParityProviders {
  /** Pairings to measure (default {@link WEAPON_PAIRINGS}). */
  readonly pairings?: readonly WeaponPairing[];
  /** Evolved cadence provider (default {@link resolveEvolvedWeaponPattern}). */
  readonly evolvedPatternFor?: (
    evolvedId: EvolvedWeaponId,
    level: number,
  ) => EuclideanPattern;
  /** Catalogue cadence provider (default `resolveWeaponPattern`). */
  readonly cataloguePatternFor?: (
    weaponId: WeaponId,
    level: number,
  ) => EuclideanPattern;
  /** Per-volley bullet count provider (default the catalogue's offsets). */
  readonly instancesPerOnsetFor?: (weaponId: WeaponId) => number;
}

/** The damage-parity verdict, with every measured row. */
export interface DamageParityResult extends VerificationVerdict {
  readonly rows: readonly DamageParityRow[];
}

/**
 * Measures damage-instance parity for every pairing at every level: the evolved
 * weapon must emit **no more damage instances per cadence tick than the two
 * halves it replaces together**, and it must not be silent.
 *
 * The comparison is against the halves' **sum**, because a fusion replaces both:
 * the shipped evolved ladders are deliberately allowed to out-pace a single half
 * at high levels (Chain Ricochet matches Ricochet's ladder while Arc is the
 * denser half), yet the player gives up the other half's output, so total
 * damage per tick falls. Pinning the sum is what stops a fusion becoming a
 * damage upgrade.
 *
 * This is the guard against a fusion quietly out-damaging its inputs: a denser
 * evolved ladder, or a fusion that spawns extra projectiles per onset on top of
 * both halves, fails here.
 *
 * @param providers - Optional replacement pairings/pattern sources.
 * @param levels - Evolution levels to measure (default
 *   {@link DAMAGE_PARITY_LEVELS}).
 */
export function checkDamageParity(
  providers: DamageParityProviders = {},
  levels: readonly number[] = DAMAGE_PARITY_LEVELS,
): DamageParityResult {
  const pairings = providers.pairings ?? WEAPON_PAIRINGS;
  const evolvedPatternFor = providers.evolvedPatternFor
    ?? ((evolvedId: EvolvedWeaponId, level: number) =>
      resolveEvolvedWeaponPattern(evolvedId, level));
  const cataloguePatternFor = providers.cataloguePatternFor
    ?? resolveWeaponPattern;
  const instancesPerOnsetFor = providers.instancesPerOnsetFor
    ?? catalogueInstancesPerOnset;

  const rows: DamageParityRow[] = [];
  const violations: VerificationViolation[] = [];

  for (const pairing of pairings) {
    for (const level of levels) {
      const evolvedPattern = evolvedPatternFor(pairing.evolvedId, level);
      const evolvedInstancesPerBeat = damageInstancesPerBeat(
        evolvedPattern,
        EVOLVED_DAMAGE_INSTANCES_PER_ONSET,
      );
      const halves: DamageParityHalf[] = pairing.baseIds.map((weaponId) => ({
        weaponId,
        instancesPerBeat: damageInstancesPerBeat(
          cataloguePatternFor(weaponId, level),
          instancesPerOnsetFor(weaponId),
        ),
      }));
      const halfSumInstancesPerBeat = halves.reduce(
        (total, half) => total + half.instancesPerBeat,
        0,
      );

      const label = `${pairing.evolvedId} at level ${level}`;
      const rowViolations: VerificationViolation[] = [];

      if (evolvedInstancesPerBeat <= DENSITY_EPSILON) {
        rowViolations.push({
          rule: 'damage-parity/evolved-silent',
          detail: `${label} emits no damage instances per beat`,
        });
      }
      if (
        evolvedInstancesPerBeat >
        halfSumInstancesPerBeat + DENSITY_EPSILON
      ) {
        rowViolations.push({
          rule: 'damage-parity/evolved-exceeds-halves',
          detail: `${label} emits ${evolvedInstancesPerBeat} instances/beat, exceeding both halves' ${halfSumInstancesPerBeat}`,
        });
      }

      violations.push(...rowViolations);
      rows.push({
        evolvedId: pairing.evolvedId,
        level,
        evolvedInstancesPerBeat,
        halves,
        halfSumInstancesPerBeat,
        holds: rowViolations.length === 0,
      });
    }
  }

  return { holds: violations.length === 0, violations, rows };
}

// ── Boss hit budget ─────────────────────────────────────────────────

/** One boss-budget row: hits required at one evolution level. */
export interface BossHitBudgetRow {
  readonly level: number;
  readonly hitsRequired: number;
  readonly holds: boolean;
}

/** The boss-budget verdict, with every measured row. */
export interface BossHitBudgetResult extends VerificationVerdict {
  readonly rows: readonly BossHitBudgetRow[];
}

/**
 * Measures that the boss hit budget is unchanged by weapon evolution: the hits
 * required to fell the boss must equal the pool at **every** evolution level,
 * i.e. levelling an evolved weapon never reduces hits-to-kill (epic AC5: the
 * boss still requires 200 hits at every weapon level).
 *
 * The pool is passed in (rather than imported) so this pure module never pulls
 * Phaser in through the boss entity; the combat-core suite supplies
 * `BOSS_PHASE_COUNT × BOSS_HIT_POINTS_PER_PHASE`.
 *
 * @param hitPool - The boss's total hit points (200 for the shipped boss).
 * @param levels - Evolution levels to measure (default
 *   {@link DAMAGE_PARITY_LEVELS}).
 * @param damagePerInstanceFor - Injectable damage-per-instance provider
 *   (default one, the shared player-bullet damage).
 */
export function checkBossHitBudget(
  hitPool: number,
  levels: readonly number[] = DAMAGE_PARITY_LEVELS,
  damagePerInstanceFor: (level: number) => number = () => 1,
): BossHitBudgetResult {
  const requiredAt = (level: number): number => {
    const damage = damagePerInstanceFor(level);
    if (!Number.isFinite(damage) || damage <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.ceil(hitPool / damage);
  };

  const baseline = requiredAt(levels[0] ?? 0);
  const rows: BossHitBudgetRow[] = [];
  const violations: VerificationViolation[] = [];

  for (const level of levels) {
    const hitsRequired = requiredAt(level);
    const holds = hitsRequired === baseline;
    if (!holds) {
      violations.push({
        rule: 'boss/level-changes-hits',
        detail: `level ${level} requires ${hitsRequired} hits, but the level ${levels[0] ?? 0} pool requires ${baseline}`,
      });
    }
    rows.push({ level, hitsRequired, holds });
  }

  return { holds: violations.length === 0, violations, rows };
}

// ── Lattice conformance ─────────────────────────────────────────────

/** One lattice row: an evolved cadence at one level and tempo. */
export interface LatticeRow {
  readonly evolvedId: EvolvedWeaponId;
  readonly level: number;
  readonly bpm: number;
  readonly pattern: EuclideanPattern;
  /** Onset times inside one tile, in ms, each a whole 16th-note tick. */
  readonly onsetTimesMs: readonly number[];
  readonly holds: boolean;
}

/** Injected providers for the lattice check. */
export interface LatticeProviders {
  /** Evolved ids to measure (default every shipped id). */
  readonly evolvedIds?: readonly EvolvedWeaponId[];
  /** Evolved cadence provider (default {@link resolveEvolvedWeaponPattern}). */
  readonly evolvedPatternFor?: (
    evolvedId: EvolvedWeaponId,
    level: number,
    bpm: number,
  ) => EuclideanPattern;
  /** Tempos to measure (default {@link LATTICE_BPMS}). */
  readonly bpms?: readonly number[];
}

/** The lattice verdict, with every measured row. */
export interface LatticeResult extends VerificationVerdict {
  readonly rows: readonly LatticeRow[];
}

/**
 * Measures that every evolved cadence lands on whole 16th-note onsets at
 * `beatBpm` on the shared lattice (epic AC6), and that every rung tiles a whole
 * number of bars so a pattern morph can only coincide with a bar downbeat.
 *
 * A pattern is measured at every level across every shipped tempo; the same
 * shape is tempo-independent, only the step scales.
 *
 * @param providers - Optional replacement ids/pattern source/tempos.
 * @param levels - Evolution levels to measure (default
 *   {@link DAMAGE_PARITY_LEVELS}).
 */
export function checkLatticeConformance(
  providers: LatticeProviders = {},
  levels: readonly number[] = DAMAGE_PARITY_LEVELS,
): LatticeResult {
  const evolvedIds: readonly EvolvedWeaponId[] =
    providers.evolvedIds ??
    WEAPON_PAIRINGS.map((pairing) => pairing.evolvedId);
  const bpms = providers.bpms ?? LATTICE_BPMS;
  const evolvedPatternFor = providers.evolvedPatternFor
    ?? ((evolvedId: EvolvedWeaponId, level: number, bpm: number) =>
      resolveEvolvedWeaponPattern(evolvedId, level, bpm));

  const rows: LatticeRow[] = [];
  const violations: VerificationViolation[] = [];

  for (const evolvedId of evolvedIds) {
    for (const level of levels) {
      for (const bpm of bpms) {
        const pattern = evolvedPatternFor(evolvedId, level, bpm);
        const label = `${evolvedId} at level ${level}, ${bpm} BPM`;
        const sixteenthStepMs = beatSubdivisionMs(
          CADENCE_STEPS_PER_BEAT,
          bpm,
        );
        const rowViolations: VerificationViolation[] = [];

        if (Math.abs(pattern.stepMs - sixteenthStepMs) > MS_EPSILON) {
          rowViolations.push({
            rule: 'lattice/step-off-16th',
            detail: `${label} resolves stepMs ${pattern.stepMs}, not the shared 16th-note step ${sixteenthStepMs}`,
          });
        }

        const shapeValid =
          Number.isInteger(pattern.k) &&
          pattern.k >= 1 &&
          Number.isInteger(pattern.n) &&
          pattern.n >= 1 &&
          Number.isInteger(pattern.rotation) &&
          pattern.rotation >= 0 &&
          pattern.rotation < pattern.n;
        if (!shapeValid) {
          rowViolations.push({
            rule: 'lattice/invalid-shape',
            detail: `${label} resolves an invalid (k, n, rotation) ${pattern.k}/${pattern.n}/${pattern.rotation}`,
          });
        }

        if (
          !Number.isInteger(pattern.n) ||
          pattern.n % CADENCE_STEPS_PER_BAR !== 0
        ) {
          rowViolations.push({
            rule: 'lattice/tile-not-whole-bars',
            detail: `${label} tiles ${pattern.n} steps, which is not a whole number of ${CADENCE_STEPS_PER_BAR}-step bars`,
          });
        }

        const tile = euclidPattern(
          pattern.k,
          pattern.n,
          pattern.rotation,
        );
        const onsetTimesMs = tile.onsets.map((step) => step * pattern.stepMs);
        for (const onsetTimeMs of onsetTimesMs) {
          if (!isOnGrid(onsetTimeMs, sixteenthStepMs)) {
            rowViolations.push({
              rule: 'lattice/onset-off-16th',
              detail: `${label} has an onset at ${onsetTimeMs} ms, which is not a whole ${sixteenthStepMs} ms 16th-note tick`,
            });
          }
        }

        violations.push(...rowViolations);
        rows.push({
          evolvedId,
          level,
          bpm,
          pattern,
          onsetTimesMs,
          holds: rowViolations.length === 0,
        });
      }
    }
  }

  return { holds: violations.length === 0, violations, rows };
}

// ── Bar-downbeat morphs ─────────────────────────────────────────────

/**
 * True when `timeMs` is exactly a bar downbeat of the lattice with step
 * `stepMs` — the boundary a pattern morph may land on.
 */
export function isBarDownbeat(
  timeMs: number,
  stepMs: number,
  anchorMs = 0,
): boolean {
  return isOnGrid(timeMs, CADENCE_STEPS_PER_BAR * stepMs, anchorMs);
}

/**
 * The next bar downbeat at or after `timeMs` — the fire path's morph boundary.
 * An exact downbeat returns itself (delay 0).
 */
export function nextBarDownbeat(
  timeMs: number,
  stepMs: number,
  anchorMs = 0,
): number {
  return nextTick(timeMs, CADENCE_STEPS_PER_BAR * stepMs, anchorMs);
}

/** One morph row: a mid-bar request and the boundary it resolved to. */
export interface MorphRow {
  readonly bpm: number;
  readonly requestedAtMs: number;
  readonly morphAtMs: number;
  readonly holds: boolean;
}

/** Injected providers for the morph check. */
export interface MorphProviders {
  /** Tempos to measure (default {@link LATTICE_BPMS}). */
  readonly bpms?: readonly number[];
  /** Mid-bar probe times to morph from (default a spread of mid-bar times). */
  readonly probeTimesMs?: readonly number[];
  /** Morph scheduler (default {@link nextBarDownbeat}). */
  readonly morphAtFor?: (timeMs: number, stepMs: number) => number;
}

/** The morph verdict, with every measured row. */
export interface MorphResult extends VerificationVerdict {
  readonly rows: readonly MorphRow[];
}

/**
 * Measures that a pattern morph is scheduled on a bar downbeat — never mid-bar
 * (epic AC6). For every tempo and mid-bar probe time, the resolved morph time
 * must be at/after the request and inside the next bar.
 *
 * @param providers - Optional replacement tempos/probe times/scheduler.
 */
export function checkBarDownbeatMorphs(
  providers: MorphProviders = {},
): MorphResult {
  const bpms = providers.bpms ?? LATTICE_BPMS;
  const probeTimesMs = providers.probeTimesMs ?? [
    0, 1, 187, 500, 1125, 2999, 4567,
  ];
  const morphAtFor = providers.morphAtFor ?? nextBarDownbeat;

  const rows: MorphRow[] = [];
  const violations: VerificationViolation[] = [];

  for (const bpm of bpms) {
    const stepMs = beatSubdivisionMs(CADENCE_STEPS_PER_BEAT, bpm);
    const barMs = CADENCE_STEPS_PER_BAR * stepMs;
    for (const requestedAtMs of probeTimesMs) {
      const morphAtMs = morphAtFor(requestedAtMs, stepMs);
      const rowViolations: VerificationViolation[] = [];

      if (morphAtMs < requestedAtMs - MS_EPSILON) {
        rowViolations.push({
          rule: 'morph/before-request',
          detail: `${bpm} BPM: morph at ${morphAtMs} ms precedes the request at ${requestedAtMs} ms`,
        });
      }
      if (!isBarDownbeat(morphAtMs, stepMs)) {
        rowViolations.push({
          rule: 'morph/not-bar-downbeat',
          detail: `${bpm} BPM: morph at ${morphAtMs} ms is not a ${barMs} ms bar downbeat (request ${requestedAtMs} ms)`,
        });
      }
      if (morphAtMs - requestedAtMs > barMs + MS_EPSILON) {
        rowViolations.push({
          rule: 'morph/beyond-next-bar',
          detail: `${bpm} BPM: morph at ${morphAtMs} ms is more than one ${barMs} ms bar after the request at ${requestedAtMs} ms`,
        });
      }

      violations.push(...rowViolations);
      rows.push({
        bpm,
        requestedAtMs,
        morphAtMs,
        holds: rowViolations.length === 0,
      });
    }
  }

  return { holds: violations.length === 0, violations, rows };
}

// ── Determinism: a seeded input trace ───────────────────────────────

/** One frame of a seeded firing input trace. */
export interface FiringInputStep {
  /** Frame delta in milliseconds. */
  readonly frameMs: number;
  /** Weapons collected at the start of this frame, in draw order. */
  readonly equipWeaponIds: readonly WeaponId[];
}

/** A reproducible firing input trace: the same seed always yields this. */
export interface FiringInputTrace {
  readonly seed: number;
  readonly steps: readonly FiringInputStep[];
  /** Total elapsed game time the trace drives, in ms. */
  readonly totalMs: number;
}

/** Options for {@link createSeededFiringInputTrace}. */
export interface FiringInputTraceOptions {
  /** Number of frames (default 120). */
  readonly frames?: number;
  /** Inclusive minimum frame delta in ms (default 8). */
  readonly minFrameMs?: number;
  /** Inclusive maximum frame delta in ms (default 32). */
  readonly maxFrameMs?: number;
  /** Weapons a collection can grant (default cannon/spread/rapid/ricochet/arc). */
  readonly pool?: readonly WeaponId[];
  /** Probability a frame collects a weapon, in `[0, 1]` (default 0.04). */
  readonly equipChance?: number;
}

const DEFAULT_FIRING_POOL: readonly WeaponId[] = [
  'cannon',
  'spread',
  'rapid',
  'ricochet',
  'arc',
];

/**
 * Builds a reproducible frame-delta + collection trace from a seed — the input
 * side of the determinism gate (epic AC9).
 *
 * The same seed always produces the same frame deltas and the same collection
 * events, so driving the shared fire path twice with one trace must produce one
 * firing trace; a different seed produces a different input trace, so a test
 * can prove the trace is not vacuously constant.
 *
 * Frame deltas are jittered so a frame-rate change cannot be mistaken for
 * determinism: firing is grid-quantised, so the *collection schedule* and the
 * elapsed total are what carry the seed.
 *
 * @param seed - Run seed (normalised by the shared seeded RNG).
 * @param options - Frame count, delta bounds, weapon pool and collection rate.
 */
export function createSeededFiringInputTrace(
  seed: number,
  options: FiringInputTraceOptions = {},
): FiringInputTrace {
  const frames = Math.max(0, Math.trunc(options.frames ?? 120));
  const minFrameMs = Math.max(1, Math.trunc(options.minFrameMs ?? 8));
  const maxFrameMs = Math.max(
    minFrameMs,
    Math.trunc(options.maxFrameMs ?? 32),
  );
  const pool = options.pool ?? DEFAULT_FIRING_POOL;
  const equipChance = Math.min(1, Math.max(0, options.equipChance ?? 0.04));
  const rng = createSeededRng(seed);

  const steps: FiringInputStep[] = [];
  let totalMs = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const frameMs =
      minFrameMs + Math.floor(rng() * (maxFrameMs - minFrameMs + 1));
    const equipWeaponIds: WeaponId[] = [];
    if (pool.length > 0 && rng() < equipChance) {
      equipWeaponIds.push(pool[Math.floor(rng() * pool.length)]);
    }
    steps.push({ frameMs, equipWeaponIds });
    totalMs += frameMs;
  }

  return { seed, steps, totalMs };
}
