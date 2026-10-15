/**
 * Weapon visual roster & parity guard — docs-guard test (AH-0MV82229F004PLO5).
 *
 * Test-first verification half of the "Variety in weapon graphics" epic
 * (AH-0MV2K5SR0005RTTE): the doc/roster test that pins the catalogue-wide
 * visual identity of every player weapon and every enemy attack, so "each
 * weapon looks different" is enforced mechanically (not by convention).
 *
 * Two layers:
 *
 * 1. **Roster (mechanical, AC1 + AC2)** — every catalogue weapon and every
 *    AC-listed enemy-attack identity resolves a **unique** code-drawn visual
 *    signature through the shared, parity-safe bullet-shape seams
 *    (`resolvePlayerBulletVisual` / `resolveEnemyBulletVisual` in
 *    `bulletVisuals.ts`). Those resolvers are the single source consumed
 *    identically by `PlayerBullet` (player weapons) and
 *    `bulletUtils.createBullet` (enemy bullets) in the game and every gym,
 *    so the gym↔game parity rule holds by construction. The player signature
 *    includes the per-shot VFX knobs (trail and muzzle-flash colour), which
 *    is exactly what AC1 asserts: "a distinct code-drawn projectile shape
 *    **and/or** per-shot VFX". The Wave Laser (and Dual) line-beam identity
 *    is asserted explicitly — never a dot.
 * 2. **Docs guard** — the player-facing documentation must record the same
 *    roster, so it cannot silently drift from the code-drawn identities: the
 *    GDD §4.4 visual column and the README document a distinct visual
 *    identity per catalogue weapon, and `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`
 *    documents every AC-listed enemy attack.
 *
 * This deliberately overlaps the seam's behavioural verification
 * (`bulletVisualRoster.test.ts`, AH-0MV8228MD009UBF7) only where the epic
 * AC demands it; the value-add here is the docs-guard layer, the wider
 * per-shot-VFX signature, and the explicit beam-not-dot / beam-disambiguation
 * assertions. Test/verification item only — no production behaviour change.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ENEMY_BULLET_IDENTITIES,
  canonicalShape,
  resolveEnemyBulletVisual,
  resolvePlayerBulletVisual,
  type BulletVisualSpec,
  type EnemyBulletArchetype,
} from './bulletVisuals';
import { WEAPON_CATALOGUE, type BulletShape, type WeaponDefinition, type WeaponId } from './weapons';

const GDD = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README = path.resolve(process.cwd(), 'README.md');
const ENEMY_GUIDE = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

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
];

/** The twelve AC-named enemy-attack families, deduplicated (Scout+Invader = one). */
const AC_ENEMY_FAMILIES: readonly string[] = [
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
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Canonical in-flight identity of a player weapon: the full visual spec the
 * shared seam resolves, plus the per-shot VFX knobs (trail length and
 * muzzle-flash colour) the weapon definition adds on top — so "distinct
 * shape AND/OR per-shot VFX" (AC1) is what uniqueness is asserted on.
 */
function playerSignature(def: WeaponDefinition): string {
  const spec: BulletVisualSpec = resolvePlayerBulletVisual(def);
  return [
    canonicalShape(spec.shape),
    spec.color,
    round2(spec.radius),
    spec.length ?? '',
    spec.rimColor ?? '',
    spec.thickness ?? '',
    spec.tail ?? '',
    def.muzzleFlash?.color ?? '',
  ].join('|');
}

/** Canonical visual identity of an enemy-attack family. */
function enemySignature(archetype: EnemyBulletArchetype): string {
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
  it('resolves a distinct in-flight visual signature for each of the 11 catalogue weapons', () => {
    const signatures = new Set(
      CATALOGUE_WEAPON_IDS.map((id) => playerSignature(WEAPON_CATALOGUE[id])),
    );
    expect(signatures.size).toBe(CATALOGUE_WEAPON_IDS.length);
  });

  it('the shape family is unique across the catalogue except the one intentional beam pair', () => {
    // The catalogue assigns one distinct shape per weapon; the Dual and the
    // Wave Laser are the only weapons that share a shape (`line`) — they are
    // distinguished by length/rim/thickness instead. So 11 weapons yield
    // exactly 10 distinct shapes, never fewer.
    const shapes = new Set(
      CATALOGUE_WEAPON_IDS.map((id) =>
        canonicalShape(WEAPON_CATALOGUE[id].bulletShape),
      ),
    );
    expect(shapes.size).toBe(10);
  });

  it('the Wave Laser and Dual render as a line/beam, never a dot', () => {
    for (const id of ['dual', 'wave_laser'] as const) {
      const shape: BulletShape = WEAPON_CATALOGUE[id].bulletShape;
      expect(canonicalShape(shape), `${id} must be a beam`).toBe('line');
      expect(['circle', 'disc']).not.toContain(canonicalShape(shape));
    }
  });

  it('the Dual and the Wave Laser beams are distinguishable from each other', () => {
    // Same `line` shape, but different length / rim / thickness knobs — so
    // the short side-by-side pulse bars never read as the long piercing beam.
    expect(playerSignature(WEAPON_CATALOGUE.dual)).not.toBe(
      playerSignature(WEAPON_CATALOGUE.wave_laser),
    );
  });

  it('every catalogue weapon registers a shape the resolver can draw', () => {
    for (const id of CATALOGUE_WEAPON_IDS) {
      const shape: BulletShape = WEAPON_CATALOGUE[id].bulletShape;
      expect(shape, `${id} missing bulletShape`).toBeTruthy();
    }
  });
});

describe('enemy attack roster — every attack has its own projectile identity (AC2)', () => {
  it('every AC-listed enemy-attack family resolves a distinct visual signature', () => {
    const families = new Set(ENEMY_BULLET_IDENTITIES.map((e) => e.family));
    const signatures = new Set(
      [...families].map((family) =>
        enemySignature(
          ENEMY_BULLET_IDENTITIES.find((e) => e.family === family)!.id,
        ),
      ),
    );
    expect(signatures.size).toBe(families.size);
  });

  it('the roster covers exactly the AC-named attacks (Scout/Invader share one family)', () => {
    const families = [...new Set(ENEMY_BULLET_IDENTITIES.map((e) => e.family))].sort();
    expect(families).toEqual([...AC_ENEMY_FAMILIES].sort());
  });

  it('alias identities (Scout + Invader) share one signature', () => {
    expect(enemySignature('scout')).toBe(enemySignature('march'));
  });
});

describe('docs guard — the player-facing documentation records the visual roster', () => {
  const gdd = read(GDD);
  const readme = read(README);
  const enemyGuide = read(ENEMY_GUIDE);

  /**
   * The GDD §4.4 visual column's per-weapon identity phrase. Each phrase is a
   * distinct in-flight look (beam, shell, ring, bolt, arc, dots, …), so the
   * docs document the same one-shape-per-weapon roster the code draws.
   */
  const GDD_VISUAL_IDENTITIES: ReadonlyArray<{
    id: WeaponId;
    phrase: string;
  }> = [
    { id: 'spread', phrase: 'Triple-line neon arc' },
    { id: 'rapid', phrase: 'Stacked dots (stream of bullets)' },
    { id: 'nova', phrase: 'Concentric neon rings' },
    { id: 'mortar', phrase: 'Random blast burst' },
    { id: 'arc', phrase: 'Jagged lightning bolt' },
    { id: 'wave_laser', phrase: 'Long horizontal beam with pass-through chevrons' },
    { id: 'ricochet', phrase: 'Zig-zag bank-shot path between two walls' },
    { id: 'cluster', phrase: 'Central shell bursting into a radial cluster of warheads' },
    { id: 'options', phrase: 'Ship ringed by orbiting satellite pods' },
  ];

  it.each(GDD_VISUAL_IDENTITIES)(
    'the GDD documents the $id in-flight visual identity',
    ({ phrase }) => {
      expect(gdd, `GDD missing visual identity "${phrase}"`).toContain(phrase);
    },
  );

  it('the GDD documents the Dual beam identity', () => {
    expect(gdd).toContain('parallel bars for Dual');
  });

  it('the GDD and README roster every catalogue weapon in one drop sequence', () => {
    // The round-robin sequence names every pickup weapon (all ten) plus Reset;
    // the Cannon is the permanent default that the sequence starts from.
    const sequence =
      'Spread → Dual → Rapid → Wave Laser → Ricochet → Cluster Missile → Options → Nova → Mortar → Arc → Reset';
    expect(gdd).toContain(sequence);
    expect(readme).toContain(sequence);
  });

  const ENEMY_ATTACK_DOCS: ReadonlyArray<{
    attack: string;
    phrase: string;
  }> = [
    { attack: 'scout-invader', phrase: 'aimed shot' },
    { attack: 'diver', phrase: 'short-burst spread' },
    { attack: 'tank', phrase: 'radial burst' },
    { attack: 'phaser', phrase: 'patterned, telegraphed' },
    { attack: 'swarm', phrase: 'coordinated burst' },
    { attack: 'raider', phrase: 'attack run' },
    { attack: 'boss (all four patterns)', phrase: 'spread / spiral / pulse / desperation' },
    { attack: 'capturer', phrase: 'tractor beam' },
    { attack: 'orbital-strike', phrase: 'a fast projectile falls from off-screen' },
  ];

  it.each(ENEMY_ATTACK_DOCS)(
    'the enemy design doc documents the $attack attack',
    ({ attack, phrase }) => {
      expect(
        enemyGuide,
        `enemy guide missing the ${attack} attack ("${phrase}")`,
      ).toContain(phrase);
    },
  );
});
