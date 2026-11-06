/**
 * Runtime invariant guards for the data-driven weapon catalogue
 * (AH-0MW0Q1FT1002Q6NJ, parent AH-0MW0Q01VM004EPY7).
 *
 * Before the CSV migration the roster guarantees were enforced by the type
 * system (`Record<WeaponId, WeaponDefinition>`) and by docs-guard tests
 * (`weaponVisualRoster.docs.test.ts`). A hand edit to `src/data/weapons.csv`
 * is not type-checked, so the same guarantees are re-asserted here against the
 * **parsed catalogue** at module-load time:
 *
 * - **On-beat grid** — every `fireRateMs` is an exact subdivision or multiple
 *   of the beat period ({@link isOnBeatGrid}), so a fractional
 *   `subdivisions` cell (e.g. `1.37`) is reported with the nearest on-grid
 *   value instead of silently firing off the shared beat.
 * - **Unique bullet colour** — no two weapons share `bulletColor`.
 * - **Unique bullet shape family** — no two weapons resolve the same
 *   `canonicalShape` (the `circle`/`disc` alias collapsed). The one
 *   documented exception is the Dual / Wave Laser `line` beam pair, encoded
 *   as data (with a reason) in {@link SHARED_SHAPE_ALLOWANCES}.
 * - **Sane magnitudes** — positive bullet size/lifetime, non-negative AOE
 *   radius, positive orbit radius, 24-bit colours.
 * - **Structural coherence** — an AOE/orbit descriptor carries its companion
 *   radius, and a degenerate budget of `0` is flagged (a zero standing in for
 *   "no capability" is a data smell: the field should simply be omitted).
 *
 * ## Wiring
 *
 * {@link applyWeaponCatalogueGuards} runs at catalogue build time
 * (`src/utils/weapons.ts`): every weapon the guard rejects is replaced by its
 * code default ({@link DEFAULT_WEAPON_CATALOGUE}) so a hand edit can never
 * ship a broken roster. The fallback is applied in **every** environment, not
 * only in production: the game and the gyms must run the same roster, and a
 * dev-only broken roster is exactly the divergence the repo's parity rule
 * forbids. The diagnostics themselves are surfaced in a dev server session by
 * `utils/weaponDataDiagnostics.ts` (one `console.warn` per finding), so a
 * designer sees why an edit did not take effect.
 *
 * This module is a **leaf**: it imports only pure helpers (`canonicalShape`
 * from the leaf `bulletShape.ts`, the beat clock) and type-only declarations
 * from `weapons.ts`, so `weapons.ts` can import it without a module cycle —
 * and Node-only tooling (the Vite config loader / dev CSV write plugin) can
 * run the same guards without importing a Phaser-typed renderer
 * (AH-0MW0Q1GMK005HOF0).
 */

import { DEFAULT_BPM, beatPeriodMs } from './beat';
import { canonicalShape } from './bulletShape';
import type { BulletShape, WeaponDefinition, WeaponId } from './weapons';

// ── Beat-grid invariant ─────────────────────────────────────────────

/**
 * Returns true when `fireRateMs` is an exact subdivision of the beat period
 * for `bpm`: `beatPeriodMs(bpm) % fireRateMs === 0`. This is the
 * catalogue-wide invariant (AH-0MUAYB8EH005RJ8B): every weapon must fire on
 * the shared beat grid, so a future 20 BPM quarter-time weapon (or any other
 * addition) is on-grid by construction and an off-grid rate is rejected.
 *
 * @param fireRateMs - Fire interval in milliseconds.
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns True when the interval divides the beat period exactly.
 */
export function isOnBeatGrid(
  fireRateMs: number,
  bpm: number = DEFAULT_BPM,
): boolean {
  if (typeof fireRateMs !== 'number' || !Number.isFinite(fireRateMs) || fireRateMs <= 0) {
    return false;
  }
  const period = beatPeriodMs(bpm);
  // Compare in *ratio* space rather than via `%`: `period % fireRateMs` loses
  // precision for high subdivisions (e.g. rapid at 11/beat = 68.18 ms), where
  // 750 / 68.18… evaluates to 10.999… and the remainder check fails on a
  // mathematically on-grid rate. A relative tolerance on the subdivision
  // count is stable across the whole catalogue (AH-0MUQOV9JV00389E7).
  const tolerance = 1e-6;
  const subdivisions = period / fireRateMs;
  if (subdivisions >= 1) {
    return Math.abs(subdivisions - Math.round(subdivisions)) <= tolerance;
  }
  // Slower than the beat: the rate is an exact integer multiple of the beat
  // period (the AOE family, e.g. Nova 3000 ms = 4 beats, Mortar 1500 ms = 2).
  // This keeps an arbitrary off-grid rate (e.g. 200 ms, or 1000 ms = 1⅓
  // beats) rejected.
  const beats = fireRateMs / period;
  return Math.abs(beats - Math.round(beats)) <= tolerance;
}

/** Highest subdivision count searched when reporting an off-grid rate. */
const MAX_GRID_SUBDIVISIONS = 64;

/** Highest beat multiple searched when reporting an off-grid rate. */
const MAX_GRID_MULTIPLES = 32;

/** An on-grid fire interval and its shot-per-beat subdivision count. */
export interface OnBeatGridValue {
  /** The on-grid interval in milliseconds. */
  fireRateMs: number;
  /** Shots per beat for that interval (`>= 1` faster than the beat, `< 1` slower). */
  subdivisions: number;
}

/** Trims a number to at most three decimals for a diagnostic. */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** Trims a millisecond value to at most two decimals for a diagnostic. */
function formatMs(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * The on-grid interval nearest to `fireRateMs` on the `bpm` beat grid, or
 * `null` when no on-grid value can be derived (invalid input).
 *
 * The grid is every integer subdivision of the beat (`period / n`) and every
 * integer multiple of it (`period × m`). A tie is broken towards the faster
 * cadence (the smaller interval) so the reported value is deterministic.
 */
export function nearestOnBeatFireRate(
  fireRateMs: number,
  bpm: number = DEFAULT_BPM,
): OnBeatGridValue | null {
  if (!Number.isFinite(fireRateMs) || fireRateMs <= 0) return null;
  const period = beatPeriodMs(bpm);

  let best: OnBeatGridValue | null = null;
  const consider = (candidateMs: number, subdivisions: number): void => {
    if (!Number.isFinite(candidateMs) || candidateMs <= 0) return;
    const current = best;
    if (current === null) {
      best = { fireRateMs: candidateMs, subdivisions };
      return;
    }
    const candidateDistance = Math.abs(candidateMs - fireRateMs);
    const bestDistance = Math.abs(current.fireRateMs - fireRateMs);
    if (
      candidateDistance < bestDistance ||
      (candidateDistance === bestDistance && candidateMs < current.fireRateMs)
    ) {
      best = { fireRateMs: candidateMs, subdivisions };
    }
  };

  for (let subdivisions = 1; subdivisions <= MAX_GRID_SUBDIVISIONS; subdivisions += 1) {
    consider(period / subdivisions, subdivisions);
  }
  for (let beats = 1; beats <= MAX_GRID_MULTIPLES; beats += 1) {
    consider(period * beats, 1 / beats);
  }
  return best;
}

// ── Roster allowances ───────────────────────────────────────────────

/** A documented exception to one-visual-shape-per-weapon. */
export interface SharedShapeAllowance {
  /** The weapons allowed to share the canonical shape. */
  readonly weaponIds: readonly WeaponId[];
  /** Why the share is intentional (data with a reason, never a call-site special case). */
  readonly reason: string;
}

/**
 * The roster's documented shared-shape exception. The Dual's parallel pulse
 * bars and the Wave Laser's column are both `line` beams; they are told apart
 * by length/rim/thickness (`weaponVisualRoster.docs.test.ts` asserts the two
 * signatures differ), so the shared *family* is intentional. Any other
 * shape family — or a third weapon joining this one — is a duplicate.
 */
export const SHARED_SHAPE_ALLOWANCES: Readonly<
  Partial<Record<BulletShape, SharedShapeAllowance>>
> = {
  line: {
    weaponIds: ['dual', 'wave_laser'],
    reason:
      'The Dual side-by-side pulse bars and the Wave Laser column are both ' +
      '`line` beams; they are distinguished by length/rim/thickness, which ' +
      'the visual-roster docs guard asserts.',
  },
};

// ── Diagnostics ─────────────────────────────────────────────────────

/** Whether a diagnostic rejects the weapon or merely advises. */
export type WeaponCatalogueIssueSeverity = 'error' | 'warning';

/** One actionable finding from {@link validateWeaponCatalogue}. */
export interface WeaponCatalogueDiagnostic {
  /** `error` rejects the weapon(s); `warning` is advisory only. */
  readonly severity: WeaponCatalogueIssueSeverity;
  /** Every weapon the diagnostic is about (a roster collision names all offenders). */
  readonly weaponIds: readonly WeaponId[];
  /** The field/column at fault (e.g. `fireRateMs`, `bulletColor`, `bulletShape`). */
  readonly field: string;
  /** One human-readable line naming the ids, the field and the reason. */
  readonly message: string;
}

/** The result of validating a catalogue. */
export interface WeaponCatalogueValidation {
  /** True when the catalogue carries no `error` diagnostic. */
  readonly ok: boolean;
  /** Every finding, in catalogue order (body first, roster collisions last). */
  readonly diagnostics: readonly WeaponCatalogueDiagnostic[];
  /** Ids the guard rejects, in catalogue order (empty when `ok`). */
  readonly rejectedIds: readonly WeaponId[];
}

/** Builds one diagnostic with the catalogue's house-style message shape. */
function diagnostic(
  severity: WeaponCatalogueIssueSeverity,
  weaponIds: readonly WeaponId[],
  field: string,
  reason: string,
): WeaponCatalogueDiagnostic {
  return {
    severity,
    weaponIds,
    field,
    message: `${weaponIds.join(', ')}: ${field}: ${reason}`,
  };
}

/** A 24-bit `0xRRGGBB` colour. */
function isValidColour(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0x000000 &&
    value <= 0xffffff
  );
}

/** Formats a value for a diagnostic (colours as `0xRRGGBB`). */
function formatValue(value: unknown): string {
  if (typeof value === 'number' && isValidColour(value)) {
    return `0x${value.toString(16).padStart(6, '0')}`;
  }
  return String(value);
}

const BUDGET_FIELDS = ['splits', 'bounce', 'maxHitPoints'] as const;

/**
 * Validate a parsed weapon catalogue against the roster invariants.
 *
 * Pure and non-throwing: a malformed definition (including one a caller cast
 * past the type system) becomes a diagnostic, never an exception. Every
 * `error` names the offending weapon id(s) and the field, so the message is
 * directly actionable for a designer looking at the CSV.
 *
 * @param catalogue - The parsed definitions to check (a partial map is valid:
 *   the caller has already fallen back per missing id).
 * @param bpm - Tempo in beats per minute (default 80).
 */
export function validateWeaponCatalogue(
  catalogue: Readonly<Partial<Record<WeaponId, WeaponDefinition>>>,
  bpm: number = DEFAULT_BPM,
): WeaponCatalogueValidation {
  const diagnostics: WeaponCatalogueDiagnostic[] = [];
  const ids = Object.keys(catalogue) as WeaponId[];
  const reject = (weaponIds: readonly WeaponId[], field: string, reason: string) =>
    diagnostics.push(diagnostic('error', weaponIds, field, reason));
  const warn = (weaponIds: readonly WeaponId[], field: string, reason: string) =>
    diagnostics.push(diagnostic('warning', weaponIds, field, reason));

  const colourGroups = new Map<number, WeaponId[]>();
  const shapeGroups = new Map<BulletShape, WeaponId[]>();

  for (const id of ids) {
    const definition = catalogue[id];
    if (definition === undefined) continue;

    // ── On-beat grid ────────────────────────────────────────────────
    if (!isOnBeatGrid(definition.fireRateMs, bpm)) {
      const nearest = nearestOnBeatFireRate(definition.fireRateMs, bpm);
      const nearestText =
        nearest === null
          ? 'no on-grid value could be derived'
          : `nearest on-grid value is ${formatMs(nearest.fireRateMs)} ms ` +
            `(${formatNumber(nearest.subdivisions)} subdivisions/beat)`;
      reject(
        [id],
        'fireRateMs',
        `Off the ${formatNumber(bpm)} BPM beat grid: ${formatMs(definition.fireRateMs)} ms ` +
          `is not an exact subdivision or multiple of the ${formatMs(beatPeriodMs(bpm))} ms beat ` +
          `— ${nearestText}`,
      );
    }

    // ── Sane magnitudes ─────────────────────────────────────────────
    for (const field of ['bulletSize', 'bulletLifetime'] as const) {
      const value = definition[field];
      if (!Number.isFinite(value) || value <= 0) {
        reject([id], field, `Invalid magnitude: ${formatValue(value)} — must be a positive number`);
      }
    }

    for (const field of ['bulletColor', 'bulletRim'] as const) {
      const value = definition[field];
      if (value !== undefined && !isValidColour(value)) {
        reject(
          [id],
          field,
          `Invalid colour: ${formatValue(value)} — expected a 24-bit colour in 0x000000–0xffffff`,
        );
      }
    }
    if (definition.muzzleFlash !== undefined && !isValidColour(definition.muzzleFlash.color)) {
      reject(
        [id],
        'muzzleColor',
        `Invalid colour: ${formatValue(definition.muzzleFlash.color)} — expected a 24-bit colour in 0x000000–0xffffff`,
      );
    }
    if (definition.impactFx !== undefined && !isValidColour(definition.impactFx.color)) {
      reject(
        [id],
        'impactColor',
        `Invalid colour: ${formatValue(definition.impactFx.color)} — expected a 24-bit colour in 0x000000–0xffffff`,
      );
    }

    // ── Structural coherence ────────────────────────────────────────
    if (definition.aoe !== undefined) {
      const radius = definition.aoe.radius;
      if (!Number.isFinite(radius) || radius < 0) {
        reject(
          [id],
          'aoeRadius',
          `Invalid magnitude: ${formatValue(radius)} — the AOE descriptor requires a radius of 0 or more`,
        );
      }
    }
    if (definition.orbit !== undefined) {
      const { pods, radius } = definition.orbit;
      if (!Number.isFinite(radius) || radius <= 0) {
        reject(
          [id],
          'orbitRadius',
          `Invalid magnitude: ${formatValue(radius)} — the orbit descriptor requires a positive radius`,
        );
      }
      if (!Number.isFinite(pods) || pods <= 0) {
        reject(
          [id],
          'orbitPods',
          `Invalid pod count: ${formatValue(pods)} — the orbit descriptor requires at least one pod`,
        );
      }
    }
    for (const field of BUDGET_FIELDS) {
      const value = definition[field];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0) {
        reject([id], field, `Invalid budget: ${formatValue(value)} — must not be negative`);
      } else if (value === 0) {
        warn(
          [id],
          field,
          'Degenerate budget: 0 — omit the field rather than setting it to 0 unless the degenerate value is intentional',
        );
      }
    }

    // ── Roster groupings ────────────────────────────────────────────
    if (isValidColour(definition.bulletColor)) {
      const group = colourGroups.get(definition.bulletColor) ?? [];
      group.push(id);
      colourGroups.set(definition.bulletColor, group);
    }
    const canonical = canonicalShape(definition.bulletShape);
    const shapeGroup = shapeGroups.get(canonical) ?? [];
    shapeGroup.push(id);
    shapeGroups.set(canonical, shapeGroup);
  }

  // ── Unique bullet colour ──────────────────────────────────────────
  for (const [colour, group] of colourGroups) {
    if (group.length < 2) continue;
    reject(
      group,
      'bulletColor',
      `Duplicate bullet colour ${formatValue(colour)} — every weapon must have its own bullet colour`,
    );
  }

  // ── Unique bullet-shape family (the documented line pair allowed) ──
  for (const [shape, group] of shapeGroups) {
    if (group.length < 2) continue;
    const allowance = SHARED_SHAPE_ALLOWANCES[shape];
    const allowed =
      allowance !== undefined &&
      allowance.weaponIds.length === group.length &&
      allowance.weaponIds.every((id) => group.includes(id));
    if (allowed) continue;
    reject(
      group,
      'bulletShape',
      `Duplicate bullet shape family "${shape}" (circle/disc collapse to one family) — every weapon must resolve a distinct canonical shape`,
    );
  }

  const rejectedIds = ids.filter((id) =>
    diagnostics.some(
      (entry) => entry.severity === 'error' && entry.weaponIds.includes(id),
    ),
  );

  return {
    ok: diagnostics.every((entry) => entry.severity !== 'error'),
    diagnostics,
    rejectedIds,
  };
}

// ── Build-time wiring ───────────────────────────────────────────────

/** What the catalogue build had to repair, and every finding it saw. */
export interface WeaponCatalogueInvariantReport {
  /** Every diagnostic the guard raised (the actionable dev message). */
  readonly diagnostics: readonly WeaponCatalogueDiagnostic[];
  /** Weapons whose data was replaced by the code default, in catalogue order. */
  readonly resolvedFromFallback: readonly WeaponId[];
}

/** The guarded runtime catalogue plus its invariant report. */
export interface WeaponCatalogueGuardResult {
  /** The catalogue the game must run. */
  readonly catalogue: Record<WeaponId, WeaponDefinition>;
  /** What the guard found and what it repaired. */
  readonly report: WeaponCatalogueInvariantReport;
}

/**
 * Validate a built catalogue and replace every rejected weapon with its code
 * default, so a hand edit can never ship a broken roster.
 *
 * Never throws: the returned catalogue keeps all input ids (a rejected one is
 * simply the fallback definition), which is what keeps the game bootable after
 * a malformed data edit.
 *
 * @param catalogue - The runtime catalogue built from the parsed CSV.
 * @param fallback - The code-default catalogue (one definition per id).
 * @param bpm - Tempo in beats per minute (default 80).
 */
export function applyWeaponCatalogueGuards(
  catalogue: Readonly<Record<WeaponId, WeaponDefinition>>,
  fallback: Readonly<Record<WeaponId, WeaponDefinition>>,
  bpm: number = DEFAULT_BPM,
): WeaponCatalogueGuardResult {
  const firstPass = validateWeaponCatalogue(catalogue, bpm);
  if (firstPass.rejectedIds.length === 0) {
    return {
      catalogue: { ...catalogue },
      report: { diagnostics: firstPass.diagnostics, resolvedFromFallback: [] },
    };
  }

  const guarded: Record<WeaponId, WeaponDefinition> = { ...catalogue };
  for (const id of firstPass.rejectedIds) {
    guarded[id] = fallback[id];
  }

  // Defensive: the fallback roster is asserted clean by the test suite, so a
  // surviving error means the fallback itself is broken. Report it rather than
  // silently shipping it; warnings are not repeated to avoid duplicates.
  const afterFallback = validateWeaponCatalogue(guarded, bpm);
  const surviving = afterFallback.diagnostics.filter(
    (entry) => entry.severity === 'error',
  );

  return {
    catalogue: guarded,
    report: {
      diagnostics: [...firstPass.diagnostics, ...surviving],
      resolvedFromFallback: firstPass.rejectedIds,
    },
  };
}

/**
 * Formats the invariant report as one actionable dev message, or `null` when
 * the catalogue is clean. Kept pure so the boot-time diagnostic
 * (`utils/weaponDataDiagnostics.ts`) and its tests share the exact wording a
 * developer sees.
 */
export function formatWeaponCatalogueInvariantWarning(
  report: WeaponCatalogueInvariantReport,
): string | null {
  if (report.diagnostics.length === 0) return null;
  const errors = report.diagnostics.filter((entry) => entry.severity === 'error');
  const lines = [
    `Weapon catalogue invariant guard: ${report.diagnostics.length} problem(s) ` +
      'found in the data-driven catalogue.',
  ];
  if (report.resolvedFromFallback.length > 0) {
    lines.push(
      `Fell back to the code default for: ${report.resolvedFromFallback.join(', ')} ` +
        `(${errors.length} invariant violation(s)).`,
    );
  }
  lines.push(
    ...report.diagnostics.map((entry) => `  ${entry.severity}: ${entry.message}`),
  );
  return lines.join('\n');
}
