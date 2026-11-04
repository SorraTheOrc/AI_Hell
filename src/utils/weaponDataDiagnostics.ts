/**
 * Dev-only self-checks for the data-driven weapon catalogue
 * (AH-0MW0Q1EYJ007RRFI).
 *
 * Three silent drifts are possible once the catalogue and the cadence come
 * from data:
 *
 * 1. **A typo falls back to code.** A malformed or missing
 *    `src/data/weapons.csv` row makes that one weapon resolve from
 *    {@link DEFAULT_WEAPON_CATALOGUE} instead of the CSV. The game still
 *    boots, so the typo would otherwise be invisible.
 * 2. **Two cadence sources disagree.** The catalogue's
 *    `subdivisions`/`fireRateMs` is the **legacy nominal** cadence
 *    (level-stat quantisation and the hold-full ghost metronome interval);
 *    the **live** fire cadence is the Euclidean ladder resolved by
 *    `resolveWeaponPattern`. A designer who edits a `subdivisions` cell
 *    expecting to retune firing is editing the wrong surface unless the
 *    divergence is visible.
 * 3. **The ladder data is unreadable.** A malformed
 *    `src/data/weapon-levels.json` entry falls back to the in-code ladder for
 *    that weapon only, so the game boots and the typo would otherwise be
 *    invisible.
 *
 * {@link warnOnWeaponDataDivergences} runs once at boot and logs one
 * `console.warn` per finding in a **dev server** session only (never in a
 * production build, and never during the test suite). It never throws: a
 * diagnostic must not be able to stop the game from booting.
 *
 * This module is the join point between `weapons.ts` and `weaponLevels.ts`:
 * `weapons.ts` cannot import the ladder (a module cycle), so the cross-check
 * lives here.
 */

import {
  DEFAULT_WEAPON_SUBDIVISIONS,
  WEAPON_CATALOGUE_INVARIANT_REPORT,
  WEAPON_CATALOGUE_LOAD_REPORT,
  WEAPON_IDS,
  formatWeaponCatalogueLoadWarning,
  type WeaponId,
} from './weapons';
import { formatWeaponCatalogueInvariantWarning } from './weaponCatalogue';
import {
  euclideanOnsetsPerBeat,
  formatWeaponLevelsLoadWarning,
  resolveWeaponPattern,
  WEAPON_LEVELS_LOAD_REPORT,
} from './weaponLevels';

/** Difference below which two cadence densities are treated as identical. */
const CADENCE_EPSILON = 1e-9;

/** One weapon whose legacy nominal cadence disagrees with the live ladder. */
export interface WeaponCadenceDivergence {
  /** The divergent weapon. */
  weaponId: WeaponId;
  /** The `subdivisions` value authored in `src/data/weapons.csv`. */
  nominalSubdivisions: number;
  /** The live Euclidean ladder's level-0 density (onsets per beat @ 80 BPM). */
  ladderOnsetsPerBeat: number;
}

/**
 * Every weapon whose authored nominal `subdivisions` differs from the live
 * Euclidean ladder's level-0 density, in catalogue order.
 *
 * Level 0 is the shipped, un-upgraded rhythm, so this is the rung a designer's
 * `subdivisions` cell is nominally describing. Pure: no environment gate, no
 * console output, so it is directly testable.
 */
export function findWeaponCadenceDivergences(): WeaponCadenceDivergence[] {
  return WEAPON_IDS.flatMap((weaponId) => {
    const nominalSubdivisions = DEFAULT_WEAPON_SUBDIVISIONS[weaponId];
    const ladderOnsetsPerBeat = euclideanOnsetsPerBeat(
      resolveWeaponPattern(weaponId, 0),
    );
    return Math.abs(nominalSubdivisions - ladderOnsetsPerBeat) <= CADENCE_EPSILON
      ? []
      : [{ weaponId, nominalSubdivisions, ladderOnsetsPerBeat }];
  });
}

/**
 * Formats the cadence-ownership diagnostic, or `null` when the nominal table
 * and the live ladder agree for every weapon.
 *
 * The message names `src/data/weapon-levels.json` as the cadence source so the
 * reader is sent to the surface that actually gates firing. The live values
 * are loaded from that file at module load (with the in-code
 * `WEAPON_EUCLIDEAN_LADDERS` as the per-weapon fallback), so the pointer is
 * literal.
 */
export function formatWeaponCadenceWarning(
  divergences: readonly WeaponCadenceDivergence[],
): string | null {
  if (divergences.length === 0) return null;
  return [
    'Weapon cadence divergence: the legacy nominal `subdivisions` in ' +
      `src/data/weapons.csv disagrees with the live Euclidean ladder for ${divergences.length} weapon(s).`,
    'The live fire cadence is `resolveWeaponPattern` — authored in ' +
      'src/data/weapon-levels.json (with the in-code ' +
      '`WEAPON_EUCLIDEAN_LADDERS` as the per-weapon fallback). The CSV ' +
      '`subdivisions` value is the ' +
      'legacy nominal used only for level-stat quantisation and the hold-full ' +
      'ghost metronome.',
    ...divergences.map(
      (divergence) =>
        `  ${divergence.weaponId}: nominal ${divergence.nominalSubdivisions} vs live ladder ${divergence.ladderOnsetsPerBeat} onsets/beat`,
    ),
  ].join('\n');
}

/**
 * Every diagnostic a boot self-check would log, in reporting order:
 * ladder-load fallbacks first, then catalogue-load fallbacks, then the
 * catalogue invariant guard (AH-0MW0Q1FT1002Q6NJ), then cadence divergence.
 */
export function collectWeaponDataDiagnostics(): string[] {
  const warnings: string[] = [];
  const ladderWarning = formatWeaponLevelsLoadWarning(
    WEAPON_LEVELS_LOAD_REPORT,
  );
  if (ladderWarning !== null) warnings.push(ladderWarning);
  const loadWarning = formatWeaponCatalogueLoadWarning(
    WEAPON_CATALOGUE_LOAD_REPORT,
  );
  if (loadWarning !== null) warnings.push(loadWarning);
  const invariantWarning = formatWeaponCatalogueInvariantWarning(
    WEAPON_CATALOGUE_INVARIANT_REPORT,
  );
  if (invariantWarning !== null) warnings.push(invariantWarning);
  const cadenceWarning = formatWeaponCadenceWarning(
    findWeaponCadenceDivergences(),
  );
  if (cadenceWarning !== null) warnings.push(cadenceWarning);
  return warnings;
}

/** Logs each message with `console.warn`, one call per message. */
export function emitWeaponDataWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(warning);
  }
}

/**
 * True only in a Vite dev-server session. A production build inlines `DEV`
 * as false, and the test suite keeps its own quiet environment (`MODE ===
 * 'test'`) so a diagnostic never pollutes test output.
 */
function isDevServer(): boolean {
  return import.meta.env.DEV === true && import.meta.env.MODE !== 'test';
}

/**
 * Boot-time self-check: logs the data-driven catalogue diagnostics once, in
 * dev only. Fail-soft by construction — it only reads module state.
 */
export function warnOnWeaponDataDivergences(): void {
  if (!isDevServer()) return;
  emitWeaponDataWarnings(collectWeaponDataDiagnostics());
}
