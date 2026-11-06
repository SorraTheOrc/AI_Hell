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
 *    divergence is visible. The known deliberate divergences (the `cannon`,
 *    `rapid` and `railgun` superposition rungs) are registered in
 *    {@link DELIBERATE_CADENCE_DIVERGENCES} and stay silent; anything else
 *    warns, and a stale registry entry warns too
 *    (AH-0MW23FEDK006BRHK AC3).
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
 * The **documented, deliberate** nominal-vs-live divergences, with the design
 * reason recorded beside each weapon (AH-0MW23FEDK006BRHK AC3).
 *
 * After the level-0 trim reached the live ladder every re-timed weapon's
 * `subdivisions` matches the rung the game plays. The three entries below are
 * the conversely *deliberate* superposition rungs: their level-0 ladder
 * density is intentionally not the legacy grid value, and every one of them
 * is inside the producer-approved level-0 budget. A divergence outside this
 * registry is an undocumented drift and still warns at dev boot.
 */
export const DELIBERATE_CADENCE_DIVERGENCES: Readonly<
  Partial<Record<WeaponId, string>>
> = Object.freeze({
  cannon:
    'Frozen default weapon: the cannon keeps the E(9,16) superposition rung ' +
    '(2.25 onsets/beat) and is exempt from the level-0 budget, so its legacy ' +
    'nominal 2/beat is documentation only (AH-0MVRENEME004FS8T).',
  rapid:
    'Deliberate superposition member: rapid plays E(13,16) (3.25 ' +
    'onsets/beat) and still lands at 54 % of its pre-change level-0 output, ' +
    'so rounding it to the nominal 3/beat would flatten its syncopation for ' +
    'no budget gain.',
  railgun:
    'Deliberate superposition member: the railgun plays E(2,16) (0.5 ' +
    'onsets/beat, twice the nominal 0.25) and pays for it with a 1 HP ' +
    'pass-through budget, staying inside both level-0 ceilings (40 % of ' +
    'baseline, 0.33x the cannon).',
});

/**
 * The divergences that are **not** in the documented deliberate registry, in
 * catalogue order — the ones a dev boot must still shout about.
 *
 * Pure and injectable so a test can feed a synthetic drift without editing the
 * committed data.
 */
export function findUndocumentedCadenceDivergences(
  divergences: readonly WeaponCadenceDivergence[] = findWeaponCadenceDivergences(),
): WeaponCadenceDivergence[] {
  return divergences.filter(
    (divergence) => DELIBERATE_CADENCE_DIVERGENCES[divergence.weaponId] === undefined,
  );
}

/**
 * Stale-registry diagnostics: every weapon the registry *claims* is deliberately
 * divergent but which now agrees with its nominal value.
 *
 * A stale entry is how the registry rots — if a later retune makes the cannon's
 * live rung 2/beat, the exemption must be deleted rather than silently masking
 * a future drift. Empty for the committed data.
 */
export function validateCadenceDivergenceRegistry(
  divergences: readonly WeaponCadenceDivergence[] = findWeaponCadenceDivergences(),
): string[] {
  const divergentIds = new Set(
    divergences.map((divergence) => divergence.weaponId),
  );
  return (Object.keys(DELIBERATE_CADENCE_DIVERGENCES) as WeaponId[])
    .filter((weaponId) => !divergentIds.has(weaponId))
    .map(
      (weaponId) =>
        `${weaponId}: listed in DELIBERATE_CADENCE_DIVERGENCES but its ` +
        `nominal subdivisions now match the live ladder — drop the stale ` +
        'registry entry.',
    );
}

/**
 * Formats the cadence-ownership diagnostic, or `null` when no **undocumented**
 * divergence remains.
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
      `src/data/weapons.csv disagrees with the live Euclidean ladder for ${divergences.length} weapon(s), ` +
      'and the weapon(s) are not in the documented deliberate set ' +
      '(DELIBERATE_CADENCE_DIVERGENCES).',
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
 * catalogue invariant guard (AH-0MW0Q1FT1002Q6NJ), then a stale cadence
 * exemption registry, then **undocumented** cadence divergence.
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
  const divergences = findWeaponCadenceDivergences();
  const staleRegistry = validateCadenceDivergenceRegistry(divergences);
  if (staleRegistry.length > 0) {
    warnings.push(
      [
        'Weapon cadence divergence registry is stale:',
        ...staleRegistry.map((entry) => `  ${entry}`),
      ].join('\n'),
    );
  }
  const cadenceWarning = formatWeaponCadenceWarning(
    findUndocumentedCadenceDivergences(divergences),
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
