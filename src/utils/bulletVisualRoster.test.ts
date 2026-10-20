/**
 * Catalogue-wide bullet-visual roster test (AH-0MV8228MD009UBF7 AC1/AC2).
 *
 * Asserts that every player weapon and every enemy bullet identity resolves a
 * **distinct** visual signature through the shared bullet-shape seam, so
 * per-weapon and per-archetype visual identity is enforced mechanically (not
 * by convention). This is the verification half of the seam item; the sibling
 * "Weapon visual roster & parity guard test" (AH-0MV82229F004PLO5) builds the
 * GDD docs-guard version on top of it once the per-weapon children land.
 *
 * The signature is the canonical serialisation of the visual metadata that
 * actually changes how a bullet is drawn: shape (normalised), fill colour,
 * length/elongation, rim colour and stroke thickness. A shared family (e.g.
 * the Scout and the Invader aimed shot) resolves one signature.
 */

import { describe, expect, it } from 'vitest';

import { WEAPON_CATALOGUE, type WeaponId, type BulletShape } from './weapons';
import {
  canonicalShape,
  resolvePlayerBulletVisual,
  resolveEnemyBulletVisual,
  ENEMY_BULLET_IDENTITIES,
  type EnemyBulletArchetype,
  type BulletVisualSpec,
} from './bulletVisuals';

/** The eleven catalogue weapons (in catalogue order). */
const CATALOGUE_WEAPON_IDS: readonly WeaponId[] = [
  'cannon',
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Canonical visual signature for a resolved player-bullet spec. */
function playerSignature(spec: BulletVisualSpec): string {
  return [
    canonicalShape(spec.shape),
    spec.color,
    round2(spec.radius),
    spec.length ?? '',
    spec.rimColor ?? '',
    spec.thickness ?? '',
  ].join('|');
}

/** Canonical visual signature for an enemy bullet identity. */
function enemySignature(
  archetype: EnemyBulletArchetype,
): string {
  const v = resolveEnemyBulletVisual(archetype);
  return [
    canonicalShape(v.shape),
    v.color,
    v.length ?? '',
    v.rimColor ?? '',
    v.thickness ?? '',
  ].join('|');
}

describe('player weapon roster — every weapon is visually unique in flight (AC1)', () => {
  it('resolves a distinct visual signature for each of the 16 catalogue weapons', () => {
    const signatures = new Set(
      CATALOGUE_WEAPON_IDS.map((id) =>
        playerSignature(resolvePlayerBulletVisual(WEAPON_CATALOGUE[id])),
      ),
    );
    expect(signatures.size).toBe(CATALOGUE_WEAPON_IDS.length);
  });

  it('the Wave Laser and Dual render as a line/beam, never a dot', () => {
    for (const id of ['dual', 'wave_laser'] as const) {
      const shape: BulletShape = WEAPON_CATALOGUE[id].bulletShape;
      expect(canonicalShape(shape)).toBe('line');
    }
  });

  it('every catalogue weapon registers a shape in the resolver', () => {
    for (const id of CATALOGUE_WEAPON_IDS) {
      const shape: BulletShape = WEAPON_CATALOGUE[id].bulletShape;
      expect(shape).toBeTruthy();
    }
  });
});

describe('enemy bullet roster — every attack has its own projectile identity (AC2)', () => {
  it('every AC-listed enemy identity resolves a distinct signature (families deduped)', () => {
    const families = new Set(ENEMY_BULLET_IDENTITIES.map((e) => e.family));
    const signatures = new Set(
      [...families].map((family) =>
        // Each family's representative entry (aliases share the same spec).
        enemySignature(
          ENEMY_BULLET_IDENTITIES.find((e) => e.family === family)!.id,
        ),
      ),
    );
    expect(signatures.size).toBe(families.size);
  });

  it('covers every enemy attack named in the epic ACs', () => {
    // Aliases (Scout + Invader) share one family, so the roster covers every
    // *family* exactly once even though it lists both archetype keys.
    expect([...new Set(ENEMY_BULLET_IDENTITIES.map((e) => e.family))].sort()).toEqual([
      'boss-desperation',
      'boss-pulse',
      'boss-spiral',
      'boss-spread',
      'capturer',
      'diver',
      'orbital-strike',
      'phaser',
      'raider',
      'scout-invader',
      'swarm',
      'tank',
    ]);
  });

  it('alias identities (Scout + Invader) share one signature', () => {
    expect(enemySignature('scout')).toBe(enemySignature('march'));
  });
});
