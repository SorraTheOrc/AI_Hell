/**
 * Weapon strength budget — the single place a weapon's **level-N output** is
 * measured (parent AH-0MVRENEME004FS8T AC1/AC2, child AH-0MVWAVJYC006WKLF).
 *
 * "40 % trim" and "≤ 1.5× the cannon" are only testable if "output" exists as
 * code, so this pure module derives, from the shipped catalogue and the
 * level resolver, the family, the per-shot payload, the cadence and the
 * resulting output of a weapon at a given level. It is **deterministic** and
 * has no Phaser/DOM/storage coupling, so a test, a gym, the balance harness or
 * a future HUD read the identical number.
 *
 * ## Output definition per family (AC1)
 *
 * | Family | Output measure |
 * |---|---|
 * | `projectile` | single-target **hits/s** — pattern bullets × shots/s |
 * | `pierce` | **hit-point budget × hits/s** (e.g. the railgun's pass-through depth) |
 * | `bounce` | **bounce depth × hits/s** — `1 + bounce` targets per pellet |
 * | `split` | **radial payload × hits/s** — the missile plus every warhead |
 * | `orbit` | **pod count × shots/s** — every pod fires once per trigger |
 * | `aoe` | **coverage × cadence** — `radius² × shots/s` in `px²/s` |
 *
 * `radius²` (rather than `π·radius²`) is deliberate: `π` is a constant scale
 * factor that cancels in every budget ratio, so the measure stays exact and
 * readable. AOE weapons never fire a pattern bullet, so their
 * `projectilesPerShot` is `1` and their `singleTargetOutput` is the cadence
 * itself (one pulse lands on a single target per shot).
 *
 * ## Ceilings
 *
 * {@link WEAPON_STRENGTH_BUDGET} records the producer-approved ceilings
 * (AH-0MVRENEME004FS8T) in code so the documentation, the level-0 catalogue
 * test (`weapons.test.ts`) and the per-level curve test (`weaponLevels.test.ts`)
 * cannot drift apart. Level-0 baselines (the pre-change table the 40 % trim is
 * measured against) live beside the catalogue in `weapons.ts`, not here: a
 * baseline is a frozen **literal** fixture, never re-derived from the data
 * under test.
 */

import { resolveWeaponDefinition } from './weaponLevels';
import {
  WEAPON_CATALOGUE,
  type WeaponDefinition,
  type WeaponId,
} from './weapons';

/**
 * The strength family a weapon belongs to — it decides which output measure
 * applies (see the module-level table).
 */
export type WeaponOutputFamily =
  | 'projectile'
  | 'pierce'
  | 'bounce'
  | 'split'
  | 'orbit'
  | 'aoe';

/**
 * Unit of a {@link WeaponStrength.output}: hits per second for every
 * single-target/area-payload family, square pixels per second for the AOE
 * coverage measure.
 */
export type WeaponOutputUnit = 'hits/s' | 'px²/s';

/**
 * The producer-approved strength budget (AH-0MVRENEME004FS8T, answers Q1 = A
 * and Q2 = A). Exported so the ceilings are asserted against literals in the
 * tests and quoted in the catalogue doc block without duplication.
 */
export const WEAPON_STRENGTH_BUDGET = {
  /**
   * Level-0 ceiling: every **non-cannon** weapon's resolved output is at or
   * below this share of its pre-change baseline (the 40 % trim).
   */
  level0BaselineShare: 0.6,
  /**
   * Level-0 cap: no non-cannon weapon's single-target output may exceed this
   * multiple of the cannon's level-0 single-target output. It takes
   * precedence where 60 % of the baseline is still too strong.
   */
  level0CannonMultiple: 1.5,
  /** Level-1 ceiling: resolved output stays at or below this multiple of level 0. */
  level1GrowthMultiple: 2.5,
  /** Saturated level-cap ceiling: at most this share of the pre-change saturated output. */
  levelCapShareOfPreChange: 0.5,
} as const;

/**
 * A weapon's resolved strength snapshot at one level.
 *
 * Every field is derived from the catalogue plus the level resolver, so the
 * game, a gym and a test always agree; `level: 0` is the shipped base data.
 */
export interface WeaponStrength {
  /** The weapon this snapshot describes. */
  weaponId: WeaponId;
  /** The (clamped) level the snapshot was resolved at. */
  level: number;
  /** The strength family (decides the output measure). */
  family: WeaponOutputFamily;
  /**
   * Shots per second of the weapon's trigger: `1000 / fireRateMs` of the
   * level-resolved definition, so it always follows the beat grid.
   */
  shotsPerSecond: number;
  /**
   * Payload emitted per shot: pattern bullets, orbit pods, or the missile plus
   * its warheads for a split weapon. Always `1` for an AOE weapon.
   */
  projectilesPerShot: number;
  /**
   * Hits one projectile can land on a single target: `1` for an ordinary
   * bullet, `1 + bounce` for a bouncing pellet, the hit-point budget for a
   * piercing weapon.
   */
  hitsPerProjectile: number;
  /**
   * Hits per second against a single target: `projectilesPerShot ×
   * shotsPerSecond` (the cannon-ceiling measure). For AOE weapons this is the
   * cadence, because one pulse lands on one target.
   */
  singleTargetOutput: number;
  /** Level-resolved AOE radius (px); `undefined` for every non-AOE weapon. */
  aoeRadius?: number;
  /** The family output measure (see {@link WeaponOutputUnit} for its unit). */
  output: number;
  /** Unit of {@link WeaponStrength.output}. */
  outputUnit: WeaponOutputUnit;
  /** Human-readable one-line derivation of {@link WeaponStrength.output}. */
  descriptor: string;
}

/** Formats a number to two decimals for the readable descriptor. */
function fixed2(value: number): string {
  return value.toFixed(2);
}

/**
 * Resolves the strength family of a level-resolved definition. Order matters:
 * an AOE weapon's expanded `offsets` are not fired as bullets, and an orbit
 * weapon's pods (not its fallback pattern) are its payload.
 */
export function weaponOutputFamily(
  definition: WeaponDefinition,
): WeaponOutputFamily {
  if (definition.aoe) return 'aoe';
  if (definition.orbit) return 'orbit';
  if (definition.splits !== undefined) return 'split';
  if (definition.bounce !== undefined) return 'bounce';
  if (definition.maxHitPoints !== undefined) return 'pierce';
  return 'projectile';
}

/** Payload emitted per shot by a level-resolved definition. */
function projectilesPerShot(definition: WeaponDefinition): number {
  if (definition.orbit) return definition.orbit.pods;
  if (definition.splits !== undefined) {
    // The missile itself plus every radial warhead it spawns.
    return definition.offsets.length + definition.splits;
  }
  if (definition.aoe) return 1;
  return definition.offsets.length;
}

/**
 * Hits one projectile lands on a single target. Bounce depth counts the
 * original target plus one per wall reflection; a piercing weapon spends its
 * whole hit-point budget on a single target; a hitscan beam is fixed at one
 * hit (AH-0MVREBUJ5004HDRQ).
 */
function hitsPerProjectile(definition: WeaponDefinition): number {
  if (definition.bounce !== undefined) return definition.bounce + 1;
  if (definition.maxHitPoints !== undefined) return definition.maxHitPoints;
  return 1;
}

/** Builds the readable derivation line for one snapshot. */
function describeStrength(
  family: WeaponOutputFamily,
  shotsPerSecond: number,
  payload: number,
  depth: number,
  radius: number | undefined,
  output: number,
  unit: WeaponOutputUnit,
): string {
  const cadence = `${fixed2(shotsPerSecond)} shots/s`;
  const total = `${fixed2(output)} ${unit}`;
  switch (family) {
    case 'aoe': {
      const area = radius === undefined ? 0 : radius * radius;
      return `AOE: ${radius} px radius (${area} px²) × ${cadence} = ${total}`;
    }
    case 'orbit':
      return `${payload} pods × ${cadence} = ${total}`;
    case 'split':
      return `${payload} projectiles (missile + warheads) × ${cadence} × ${depth} hit/round = ${total}`;
    case 'bounce':
      return `${payload} pellet × ${cadence} × ${depth} targets (bounce depth) = ${total}`;
    case 'pierce':
      return `${payload} × ${cadence} × ${depth} HP budget = ${total}`;
    default:
      return `${payload} bullet(s) × ${cadence} = ${total}`;
  }
}

/**
 * Resolves a weapon's strength at `level` (0 = un-upgraded).
 *
 * The level-resolved definition comes from
 * {@link resolveWeaponDefinition}, so cadence, pattern, AOE radius, split
 * count, orbit pods, bounce and hit-point budget are all the values the game
 * and every gym actually fire.
 *
 * @param weaponId - The weapon to measure (must be in the catalogue).
 * @param level - The weapon's level (default 0).
 * @returns The resolved {@link WeaponStrength} snapshot.
 * @throws Error when `weaponId` is not in the catalogue.
 */
export function weaponStrength(
  weaponId: WeaponId,
  level = 0,
): WeaponStrength {
  const definition = resolveWeaponDefinition(weaponId, level);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  const family = weaponOutputFamily(definition);
  const shotsPerSecond = 1000 / definition.fireRateMs;
  const payload = projectilesPerShot(definition);
  const depth = hitsPerProjectile(definition);
  const singleTargetOutput = payload * shotsPerSecond;
  const aoeRadius = definition.aoe?.radius;
  const outputUnit: WeaponOutputUnit = family === 'aoe' ? 'px²/s' : 'hits/s';
  const output =
    family === 'aoe' && aoeRadius !== undefined
      ? aoeRadius * aoeRadius * shotsPerSecond
      : singleTargetOutput * depth;

  return {
    weaponId,
    level: safeLevel,
    family,
    shotsPerSecond,
    projectilesPerShot: payload,
    hitsPerProjectile: depth,
    singleTargetOutput,
    aoeRadius,
    output,
    outputUnit,
    descriptor: describeStrength(
      family,
      shotsPerSecond,
      payload,
      depth,
      aoeRadius,
      output,
      outputUnit,
    ),
  };
}

/**
 * Measures every catalogue weapon at `level`, in catalogue order.
 *
 * The id list is the catalogue's own key order — never a second hard-coded
 * membership list — so a newly added weapon is measured automatically.
 *
 * @param level - The level to measure (default 0).
 */
export function weaponStrengthTable(level = 0): WeaponStrength[] {
  return (Object.keys(WEAPON_CATALOGUE) as WeaponId[]).map((id) =>
    weaponStrength(id, level),
  );
}
