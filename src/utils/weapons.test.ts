/**
 * Unit tests for the weapon catalogue and heading math (AC7).
 *
 * Tests cover:
 * - Pattern direction math (e.g. a backward shot at heading 90° → 270°)
 * - Heading from velocity + most-recent-heading fallback when stationary
 * - Per-weapon fire rates
 * - Round-robin drop order
 * - Bullet creation data from a heading
 */

import { describe, expect, test } from 'vitest';

import { GAME_WIDTH } from '../core/constants';

import {
  WEAPON_CATALOGUE,
  getWeaponById,
  headingFromVelocity,
  absoluteAngle,
  bulletVelocity,
  bulletForShot,
  allBulletsForShot,
  computeHeading,
  weaponDropOrder,
  weaponRoundRobin,
  createBulletsFromHeading,
  angleToVelocity,
  WEAPON_CANNON_FIRE_RATE,
  WEAPON_SPREAD_FIRE_RATE,
  WEAPON_DUAL_FIRE_RATE,
  WEAPON_RAPID_FIRE_RATE,
  WEAPON_WAVE_LASER_FIRE_RATE,
  WEAPON_WAVE_LASER_SUBDIVISION,
  WEAPON_RICOCHET_FIRE_RATE,
  WEAPON_RICOCHET_SUBDIVISION,
  WEAPON_CLUSTER_FIRE_RATE,
  WEAPON_CLUSTER_SUBDIVISION,
  CLUSTER_BASE_WARHEADS,
  CLUSTER_WARHEAD_RADIUS_SCALE,
  WEAPON_OPTIONS_FIRE_RATE,
  WEAPON_OPTIONS_SUBDIVISION,
  OPTIONS_BASE_PODS,
  OPTIONS_MAX_PODS,
  OPTIONS_ORBIT_RADIUS,
  WEAPON_NOVA_FIRE_RATE,
  WEAPON_MORTAR_FIRE_RATE,
  WEAPON_ARC_FIRE_RATE,
  WEAPON_SHARD_SWARM_FIRE_RATE,
  WEAPON_REAR_GUARD_FIRE_RATE,
  WEAPON_BROADSIDE_FIRE_RATE,
  WEAPON_HEAVY_SLUG_FIRE_RATE,
  WEAPON_CANNON_SUBDIVISION,
  WEAPON_SPREAD_SUBDIVISION,
  WEAPON_DUAL_SUBDIVISION,
  WEAPON_RAPID_SUBDIVISION,
  DEFAULT_WEAPON_SUBDIVISIONS,
  weaponFireRateMs,
  isOnBeatGrid,
  isAoeWeapon,
  AOE_WEAPON_IDS,
  AOE_RADII,
  AOE_PROJECTILE_SPEEDS,
  type WeaponId,
  BULLET_SPEED,
  BULLET_COLORS,
  WEAPON_BULLET_LIFETIME,
  WAVE_LASER_BEAM_LENGTH,
  isTimedWeapon,
} from './weapons';
import { beatPeriodMs, beatSubdivisionMs } from './beat';
import {
  WEAPON_STRENGTH_BUDGET,
  weaponStrength,
  weaponStrengthTable,
  type WeaponOutputFamily,
} from './weaponStrength';

describe('WEAPON_CATALOGUE', () => {
  test('contains the eight conventional/beam weapons, the three AOE weapons and the five net-new weapons', () => {
    expect(Object.keys(WEAPON_CATALOGUE).length).toBe(16);
    expect(WEAPON_CATALOGUE.cannon).toBeDefined();
    expect(WEAPON_CATALOGUE.spread).toBeDefined();
    expect(WEAPON_CATALOGUE.dual).toBeDefined();
    expect(WEAPON_CATALOGUE.rapid).toBeDefined();
    expect(WEAPON_CATALOGUE.wave_laser).toBeDefined();
    expect(WEAPON_CATALOGUE.ricochet).toBeDefined();
    expect(WEAPON_CATALOGUE.cluster).toBeDefined();
    expect(WEAPON_CATALOGUE.options).toBeDefined();
    expect(WEAPON_CATALOGUE.nova).toBeDefined();
    expect(WEAPON_CATALOGUE.mortar).toBeDefined();
    expect(WEAPON_CATALOGUE.arc).toBeDefined();
    // Net-new weapons (AH-0MVCRC52P001YIPW) — ordinary catalogue entries.
    expect(WEAPON_CATALOGUE.rear_guard).toBeDefined();
    expect(WEAPON_CATALOGUE.broadside).toBeDefined();
    expect(WEAPON_CATALOGUE.railgun).toBeDefined();
    expect(WEAPON_CATALOGUE.shard_swarm).toBeDefined();
    expect(WEAPON_CATALOGUE.heavy_slug).toBeDefined();
  });

  test('cannon fires single bullet (pattern length 1)', () => {
    expect(WEAPON_CATALOGUE.cannon.offsets.length).toBe(1);
    expect(WEAPON_CATALOGUE.cannon.offsets[0]).toBeCloseTo(0);
  });

  test('spread fires 3 bullets at ±30° and 0° relative to heading', () => {
    const offsets = WEAPON_CATALOGUE.spread.offsets;
    expect(offsets.length).toBe(3);
    const thirtyDeg = (30 * Math.PI) / 180;
    expect(offsets[0]).toBeCloseTo(-thirtyDeg);
    expect(offsets[1]).toBeCloseTo(0);
    expect(offsets[2]).toBeCloseTo(thirtyDeg);
  });

  test('spread declares its visuals-only feel metadata (AH-0MV8229B9009DQGA)', () => {
    const spread = WEAPON_CATALOGUE.spread;
    // In-flight identity for the catalogue guard is the unique `diamond`
    // shape family (never a second `disc`); the feel is added as visuals-only
    // metadata — a warm rim, a brief fading trail, a soft muzzle flash and a
    // distinct amber impact flash + baked hit cue.
    expect(spread.bulletShape).toBe('diamond');
    expect(spread.bulletRim).toBeDefined();
    expect(spread.bulletTrail).toBeGreaterThan(0);
    expect(spread.muzzleFlash).toBeDefined();
    expect(spread.muzzleFlash!.color).toBe(BULLET_COLORS.spread);
    expect(spread.impactFx).toBeDefined();
    expect(spread.impactFx!.color).toBe(BULLET_COLORS.spread);
    expect(spread.impactFx!.cue).toBe('playSpreadImpactSound');
  });

  test('dual declares its visuals-only feel metadata (AH-0MV8229NM009CZOA)', () => {
    const dual = WEAPON_CATALOGUE.dual;
    // In-flight identity for the catalogue guard stays the unique short
    // `line`/beam family (never a dot); the feel is added as visuals-only
    // metadata — a chunkier pulse-bar stroke, a short fading trail, a quick
    // launch flash and a distinct magenta impact flash + baked hit cue.
    expect(dual.bulletShape).toBe('line');
    expect(dual.bulletShapeLength).toBeLessThan(3); // short beam, not the wave laser
    expect(dual.bulletThickness).toBeDefined();
    expect(dual.bulletThickness).toBeGreaterThan(1);
    expect(dual.bulletTrail).toBeGreaterThan(0);
    expect(dual.muzzleFlash).toBeDefined();
    expect(dual.muzzleFlash!.color).toBe(BULLET_COLORS.dual);
    expect(dual.impactFx).toBeDefined();
    expect(dual.impactFx!.color).toBe(BULLET_COLORS.dual);
    expect(dual.impactFx!.cue).toBe('playDualImpactSound');
  });

  test('rapid declares its visuals-only feel metadata (AH-0MV822A03006UT2P)', () => {
    const rapid = WEAPON_CATALOGUE.rapid;
    // In-flight identity for the catalogue guard stays the unique `spark`
    // family (the `disc` family belongs to the cannon); the "small fast
    // disc" read comes from visuals-only metadata — a white-hot rim on the
    // small spark, a short fading trail, a staccato muzzle flash (the
    // shortest in the catalogue) and a distinct yellow impact flash + baked
    // hit cue.
    expect(rapid.bulletShape).toBe('spark');
    expect(rapid.bulletRim).toBeDefined();
    expect(rapid.bulletSize).toBeLessThan(1); // small, fast disc-like read
    expect(rapid.bulletTrail).toBeGreaterThan(0);
    expect(rapid.muzzleFlash).toBeDefined();
    // Staccato: the shortest, smallest launch flash in the catalogue.
    expect(rapid.muzzleFlash!.duration).toBeLessThan(0.1);
    expect(rapid.muzzleFlash!.radius).toBeLessThan(7);
    expect(rapid.muzzleFlash!.color).toBe(BULLET_COLORS.rapid);
    expect(rapid.impactFx).toBeDefined();
    expect(rapid.impactFx!.color).toBe(BULLET_COLORS.rapid);
    expect(rapid.impactFx!.cue).toBe('playRapidImpactSound');
  });

  test('ricochet declares its visuals-only feel metadata (AH-0MV822AP1006W2F9)', () => {
    const ricochet = WEAPON_CATALOGUE.ricochet;
    // In-flight identity: a teardrop/streak pellet with a white neon rim and
    // a short fading trail (visual metadata on the definition, drawn through
    // the shared bullet-shape seam).
    expect(ricochet.bulletShape).toBe('teardrop');
    expect(ricochet.bulletRim).toBeDefined();
    expect(ricochet.bulletTrail).toBeGreaterThan(0);
    // A clean launch flash at the ship, coloured to the pellet.
    expect(ricochet.muzzleFlash).toBeDefined();
    expect(ricochet.muzzleFlash!.color).toBe(BULLET_COLORS.ricochet);
    // A distinct green edge-flash + baked bounce/hit cue.
    expect(ricochet.impactFx).toBeDefined();
    expect(ricochet.impactFx!.color).toBe(BULLET_COLORS.ricochet);
    expect(ricochet.impactFx!.cue).toBe('playRicochetImpactSound');
  });

  test('dual fires 2 parallel bullets offset perpendicular to heading', () => {
    const weapon = WEAPON_CATALOGUE.dual;
    expect(weapon.offsets.length).toBe(2);
    // Both bullets fly parallel to the heading (0° offset)...
    expect(weapon.offsets[0]).toBeCloseTo(0);
    expect(weapon.offsets[1]).toBeCloseTo(0);
    // ...but are launched side-by-side: perpendicular positional offsets.
    expect(weapon.sideOffsets).toBeDefined();
    expect(weapon.sideOffsets![0]).toBeCloseTo(-8);
    expect(weapon.sideOffsets![1]).toBeCloseTo(8);
  });

  test('rapid fires single bullets at a markedly higher rate', () => {
    expect(WEAPON_CATALOGUE.rapid.offsets.length).toBe(1);
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_CANNON_FIRE_RATE);
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_SPREAD_FIRE_RATE);
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_DUAL_FIRE_RATE);
  });
});

describe('bulletLifetime (AC3/AC4 — per-weapon range)', () => {
  test('every weapon exposes a positive bullet lifetime', () => {
    for (const weapon of Object.values(WEAPON_CATALOGUE)) {
      expect(weapon.bulletLifetime).toBeGreaterThan(0);
    }
  });

  test('lifetimes match the agreed per-weapon defaults (AC1)', () => {
    expect(WEAPON_CATALOGUE.cannon.bulletLifetime).toBe(0.75);
    expect(WEAPON_CATALOGUE.spread.bulletLifetime).toBe(0.7);
    expect(WEAPON_CATALOGUE.dual.bulletLifetime).toBe(0.7);
    expect(WEAPON_CATALOGUE.rapid.bulletLifetime).toBe(0.375);
    expect(WEAPON_CATALOGUE.nova.bulletLifetime).toBe(0.25);
    expect(WEAPON_CATALOGUE.mortar.bulletLifetime).toBe(1.0);
    expect(WEAPON_CATALOGUE.arc.bulletLifetime).toBe(0.25);
  });

  test('every base lifetime is exactly half the pre-reduction value (AC1)', () => {
    // The operator-mandated 50 % range reduction (AH-0MUU131PU006O7ZD).
    // Pre-change values: cannon 1.5, spread 1.4, dual 1.4, rapid 0.75,
    // nova 0.5, mortar 2.0, arc 0.5.
    expect(WEAPON_BULLET_LIFETIME.cannon).toBeCloseTo(1.5 / 2, 10);
    expect(WEAPON_BULLET_LIFETIME.spread).toBeCloseTo(1.4 / 2, 10);
    expect(WEAPON_BULLET_LIFETIME.dual).toBeCloseTo(1.4 / 2, 10);
    expect(WEAPON_BULLET_LIFETIME.rapid).toBeCloseTo(0.75 / 2, 10);
    expect(WEAPON_BULLET_LIFETIME.nova).toBeCloseTo(0.5 / 2, 10);
    expect(WEAPON_BULLET_LIFETIME.mortar).toBeCloseTo(2.0 / 2, 10);
    expect(WEAPON_BULLET_LIFETIME.arc).toBeCloseTo(0.5 / 2, 10);
  });

  test('the shared WEAPON_BULLET_LIFETIME constant matches the catalogue', () => {
    expect(WEAPON_BULLET_LIFETIME.cannon).toBe(0.75);
    expect(WEAPON_BULLET_LIFETIME.spread).toBe(0.7);
    expect(WEAPON_BULLET_LIFETIME.dual).toBe(0.7);
    expect(WEAPON_BULLET_LIFETIME.rapid).toBe(0.375);
    for (const id of Object.keys(WEAPON_BULLET_LIFETIME) as WeaponId[]) {
      expect(WEAPON_CATALOGUE[id].bulletLifetime).toBe(
        WEAPON_BULLET_LIFETIME[id],
      );
    }
  });

  test('effective range (BULLET_SPEED × lifetime) is halved (AC1)', () => {
    // Cannon: 350 px/s × 0.75 s = 262.5 px (was ~525 px).
    expect(BULLET_SPEED * WEAPON_BULLET_LIFETIME.cannon).toBeCloseTo(262.5, 5);
    expect(BULLET_SPEED * WEAPON_BULLET_LIFETIME.spread).toBeCloseTo(245, 5);
    expect(BULLET_SPEED * WEAPON_BULLET_LIFETIME.dual).toBeCloseTo(245, 5);
    expect(BULLET_SPEED * WEAPON_BULLET_LIFETIME.rapid).toBeCloseTo(131.25, 5);
  });

  test('weapon lifetimes are individually tunable (rapid shorter than cannon)', () => {
    // Rapid trades range for a much higher fire rate (AC4 intent).
    expect(WEAPON_CATALOGUE.rapid.bulletLifetime).toBeLessThan(
      WEAPON_CATALOGUE.cannon.bulletLifetime,
    );
  });
});

describe('isTimedWeapon (GDD §4.4 — cumulative + timed model)', () => {
  test('the cannon is the only permanent weapon — never times out', () => {
    expect(isTimedWeapon('cannon')).toBe(false);
  });

  test('every weapon power-up (Spread, Dual, Rapid) is timed', () => {
    expect(isTimedWeapon('spread')).toBe(true);
    expect(isTimedWeapon('dual')).toBe(true);
    expect(isTimedWeapon('rapid')).toBe(true);
  });
});

describe('AOE weapons (parent AH-0MUOOB3OR001V8CD AC1)', () => {
  test('there are three mechanically distinct AOE weapons', () => {
    expect(AOE_WEAPON_IDS).toEqual(['nova', 'mortar', 'arc']);
    for (const id of AOE_WEAPON_IDS) {
      expect(isAoeWeapon(id)).toBe(true);
      expect(WEAPON_CATALOGUE[id].aoe).toBeDefined();
      // AOE weapons are collected timed drops, like spread/dual/rapid.
      expect(isTimedWeapon(id)).toBe(true);
    }
  });

  test('conventional weapons carry no AOE descriptor', () => {
    for (const id of ['cannon', 'spread', 'dual', 'rapid'] as WeaponId[]) {
      expect(isAoeWeapon(id)).toBe(false);
      expect(WEAPON_CATALOGUE[id].aoe).toBeUndefined();
    }
  });

  test('every AOE radius is the trimmed on-grid value below its level-0 budget (AC2)', () => {
    // The radii were halved by the range reduction (AH-0MUU131PU006O7ZD) to
    // Nova 45 / Mortar 35 / Arc 60, then trimmed to ≤ 60 % of that level-0
    // coverage by the non-cannon output trim (AH-0MVWAVKS0005P9VN). The trim
    // is realised as the largest whole-pixel radius whose area stays inside
    // the 60 % bound, so a non-representable target never rounds up.
    expect(AOE_RADII.nova).toBe(34);
    expect(AOE_RADII.mortar).toBe(27);
    expect(AOE_RADII.arc).toBe(46);
    // Nova: 45 → 34 px (57.1 % of the halved 45 px coverage).
    expect(AOE_RADII.nova ** 2 / 45 ** 2).toBeLessThanOrEqual(0.6);
    expect((AOE_RADII.nova + 1) ** 2 / 45 ** 2).toBeGreaterThan(0.6);
    // Mortar: 35 → 27 px (59.5 %).
    expect(AOE_RADII.mortar ** 2 / 35 ** 2).toBeLessThanOrEqual(0.6);
    expect((AOE_RADII.mortar + 1) ** 2 / 35 ** 2).toBeGreaterThan(0.6);
    // Arc: 60 → 46 px (58.8 %).
    expect(AOE_RADII.arc ** 2 / 60 ** 2).toBeLessThanOrEqual(0.6);
    expect((AOE_RADII.arc + 1) ** 2 / 60 ** 2).toBeGreaterThan(0.6);
  });

  test('the conventional base lifetime still carries the range halving (AC2/AC5)', () => {
    // The conventional base lifetime was halved by the range reduction
    // (AH-0MUU131PU006O7ZD) and is untouched by the level-0 output trim.
    expect(WEAPON_BULLET_LIFETIME.cannon).toBeCloseTo(1.5 / 2, 10);
    // The AOE radii keep their ordering (Arc > Nova > Mortar) after the trim.
    expect(AOE_RADII.arc).toBeGreaterThan(AOE_RADII.nova);
    expect(AOE_RADII.nova).toBeGreaterThan(AOE_RADII.mortar);
  });

  test('each catalogue aoe.radius reflects the halved AOE_RADII value (AC2)', () => {
    expect(WEAPON_CATALOGUE.nova.aoe!.radius).toBe(AOE_RADII.nova);
    expect(WEAPON_CATALOGUE.mortar.aoe!.radius).toBe(AOE_RADII.mortar);
    expect(WEAPON_CATALOGUE.arc.aoe!.radius).toBe(AOE_RADII.arc);
  });

  test('Nova resolves an onFire ring at the ship', () => {
    const aoe = WEAPON_CATALOGUE.nova.aoe!;
    expect(aoe.trigger).toBe('onFire');
    expect(aoe.radius).toBe(AOE_RADII.nova);
    expect(aoe.damagesEnemies).toBe(true);
    expect(aoe.clearsEnemyBullets).toBe(true);
  });

  test('Mortar resolves an onRandom detonation within its effective range', () => {
    const aoe = WEAPON_CATALOGUE.mortar.aoe!;
    expect(aoe.trigger).toBe('onRandom');
    expect(aoe.radius).toBe(AOE_RADII.mortar);
    expect(aoe.damagesEnemies).toBe(true);
    expect(aoe.clearsEnemyBullets).toBe(true);
    // `projectileSpeed × bulletLifetime` is the random-detonation range
    // basis (180 px at level 0); it stays slower than a conventional bullet.
    expect(aoe.projectileSpeed).toBe(AOE_PROJECTILE_SPEEDS.mortar);
    expect(aoe.projectileSpeed!).toBeLessThan(BULLET_SPEED);
    expect(WEAPON_CATALOGUE.mortar.bulletLifetime).toBeGreaterThan(0);
  });

  test('Arc resolves an onFire chain to nearby targets', () => {
    const aoe = WEAPON_CATALOGUE.arc.aoe!;
    expect(aoe.trigger).toBe('onFire');
    expect(aoe.radius).toBe(AOE_RADII.arc);
    expect(aoe.damagesEnemies).toBe(true);
    expect(aoe.clearsEnemyBullets).toBe(true);
    expect(aoe.chains).toBeGreaterThanOrEqual(2);
  });

  test('every AOE weapon has a name and a player-facing description', () => {
    for (const id of AOE_WEAPON_IDS) {
      const def = WEAPON_CATALOGUE[id];
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

describe('AOE fire rates on the beat grid (parent AH-0MUOOB3OR001V8CD AC7)', () => {
  test('Nova fires once every 4 beats (3000 ms at 80 BPM)', () => {
    expect(WEAPON_NOVA_FIRE_RATE).toBe(3000);
    expect(WEAPON_CATALOGUE.nova.fireRateMs).toBe(3000);
    expect(isOnBeatGrid(WEAPON_NOVA_FIRE_RATE)).toBe(true);
  });

  test('Mortar fires once every 2 beats (1500 ms at 80 BPM)', () => {
    expect(WEAPON_MORTAR_FIRE_RATE).toBe(1500);
    expect(WEAPON_CATALOGUE.mortar.fireRateMs).toBe(1500);
    expect(isOnBeatGrid(WEAPON_MORTAR_FIRE_RATE)).toBe(true);
  });

  test('Arc fires once per beat (750 ms at 80 BPM)', () => {
    expect(WEAPON_ARC_FIRE_RATE).toBe(750);
    expect(WEAPON_CATALOGUE.arc.fireRateMs).toBe(750);
    expect(isOnBeatGrid(WEAPON_ARC_FIRE_RATE)).toBe(true);
  });
});

describe('getWeaponById', () => {
  test('returns the correct definition for cannon', () => {
    const weapon = getWeaponById('cannon');
    expect(weapon.name).toBe('Cannon');
    expect(weapon.fireRateMs).toBe(WEAPON_CANNON_FIRE_RATE);
  });
});

describe('headingFromVelocity', () => {
  test('right (vx=1, vy=0) → 0 radians', () => {
    expect(headingFromVelocity(1, 0)).toBeCloseTo(0);
  });

  test('down (vx=0, vy=1) → π/2 radians', () => {
    expect(headingFromVelocity(0, 1)).toBeCloseTo(Math.PI / 2);
  });

  test('left (vx=-1, vy=0) → π radians', () => {
    expect(headingFromVelocity(-1, 0)).toBeCloseTo(Math.PI);
  });

  test('up (vx=0, vy=-1) → -π/2 radians', () => {
    expect(headingFromVelocity(0, -1)).toBeCloseTo(-Math.PI / 2);
  });

  test('diagonal down-right → π/4 radians', () => {
    expect(headingFromVelocity(1, 1)).toBeCloseTo(Math.PI / 4);
  });
});

describe('absoluteAngle: backward shot example from AC7', () => {
  test('heading 90° (down) + offset 180° → 270° (3π/2)', () => {
    // A 180° backward shot relative to a ship travelling right-down.
    // If the ship's heading is 90° (down), the backward shot is 270°.
    const heading = Math.PI / 2;
    const offset = Math.PI;
    const result = absoluteAngle(heading, offset);
    expect(result).toBeCloseTo((3 * Math.PI) / 2);
  });
});

describe('bulletVelocity', () => {
  test('0° → positive vx, zero vy', () => {
    const v = bulletVelocity(0, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(BULLET_SPEED);
    expect(v.vy).toBeCloseTo(0);
  });

  test('90° (down) → zero vx, positive vy', () => {
    const v = bulletVelocity(Math.PI / 2, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(0);
    expect(v.vy).toBeCloseTo(BULLET_SPEED);
  });

  test('magnitude equals bullet speed for all angles', () => {
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const v = bulletVelocity(angle, BULLET_SPEED);
      const magnitude = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      expect(magnitude).toBeCloseTo(BULLET_SPEED);
    }
  });
});

describe('bulletForShot / allBulletsForShot', () => {
  test('cannon fires one bullet straight ahead', () => {
    const cannon = getWeaponById('cannon');
    const bullet = bulletForShot(cannon, 0, 0);
    expect(bullet).not.toBeNull();
    expect(bullet!.vx).toBeCloseTo(BULLET_SPEED);
    expect(bullet!.vy).toBeCloseTo(0);
    expect(bullet!.color).toBe(0x00ffff);
    expect(bullet!.shape).toBe('circle');
  });

  test('spread fires three bullets at -30°/0°/+30° relative to heading', () => {
    const spread = getWeaponById('spread');
    const bullets = allBulletsForShot(spread, 0);
    expect(bullets.length).toBe(3);
    // Middle bullet straight ahead.
    expect(bullets[1].vx).toBeCloseTo(BULLET_SPEED);
    // Side bullets at ±30°.
    const thirtyDeg = (30 * Math.PI) / 180;
    expect(bullets[0].vx).toBeCloseTo(BULLET_SPEED * Math.cos(-thirtyDeg));
    expect(bullets[0].vy).toBeCloseTo(BULLET_SPEED * Math.sin(-thirtyDeg));
    expect(bullets[2].vx).toBeCloseTo(BULLET_SPEED * Math.cos(thirtyDeg));
    expect(bullets[2].vy).toBeCloseTo(BULLET_SPEED * Math.sin(thirtyDeg));
  });

  test('dual fires two parallel bullets offset perpendicular to heading (side-by-side)', () => {
    const dual = getWeaponById('dual');
    // Heading 0 (right): both bullets fly rightward (parallel).
    const bullets = allBulletsForShot(dual, 0);
    expect(bullets.length).toBe(2);
    expect(bullets[0].vx).toBeCloseTo(BULLET_SPEED);
    expect(bullets[1].vx).toBeCloseTo(BULLET_SPEED);
    expect(bullets[0].vy).toBeCloseTo(0);
    expect(bullets[1].vy).toBeCloseTo(0);
    // Positional offsets are perpendicular: travelling right → up/down.
    expect(bullets[0].offsetY).toBeCloseTo(-8);
    expect(bullets[1].offsetY).toBeCloseTo(8);
    expect(bullets[0].offsetX).toBeCloseTo(0);
    expect(bullets[1].offsetX).toBeCloseTo(0);
  });

  test('dual offset rotates with heading (travelling up → left/right)', () => {
    const dual = getWeaponById('dual');
    // Heading -90° (up): perpendicular is now the X axis.
    const bullets = allBulletsForShot(dual, -Math.PI / 2);
    expect(bullets[0].vx).toBeCloseTo(0);
    expect(bullets[0].vy).toBeCloseTo(-BULLET_SPEED);
    expect(bullets[0].offsetX).toBeCloseTo(-8);
    expect(bullets[1].offsetX).toBeCloseTo(8);
  });

  test('dual bullets are line-shaped', () => {
    const dual = getWeaponById('dual');
    const bullet = bulletForShot(dual, 0, 0);
    expect(bullet!.shape).toBe('line');
  });

  test('out-of-range bullet index returns null', () => {
    const cannon = getWeaponById('cannon');
    expect(bulletForShot(cannon, 0, -1)).toBeNull();
    expect(bulletForShot(cannon, 0, 1)).toBeNull();
  });
});

describe('createBulletsFromHeading', () => {
  test('creates one bullet descriptor for cannon at heading 0°', () => {
    const cannon = getWeaponById('cannon');
    const bullets = createBulletsFromHeading(cannon, 0, 100, 200);
    expect(bullets.length).toBe(1);
    expect(bullets[0]).toMatchObject({ x: 100, y: 200, angleDeg: 0, color: 0x00ffff });
  });

  test('spread at heading 0° produces angles -30/0/+30', () => {
    const spread = getWeaponById('spread');
    const bullets = createBulletsFromHeading(spread, 0, 0, 0);
    expect(bullets.length).toBe(3);
    expect(bullets[0].angleDeg).toBeCloseTo(-30);
    expect(bullets[1].angleDeg).toBeCloseTo(0);
    expect(bullets[2].angleDeg).toBeCloseTo(30);
  });

  test('dual at heading 0° produces two parallel bullets offset perpendicular', () => {
    const dual = getWeaponById('dual');
    const bullets = createBulletsFromHeading(dual, 0, 100, 200);
    expect(bullets.length).toBe(2);
    expect(bullets[0].angleDeg).toBeCloseTo(0);
    expect(bullets[1].angleDeg).toBeCloseTo(0);
    // Both fire from the ship position, offset perpendicular (up/down).
    expect(bullets[0].x).toBeCloseTo(100);
    expect(bullets[0].y).toBeCloseTo(200 - 8);
    expect(bullets[1].x).toBeCloseTo(100);
    expect(bullets[1].y).toBeCloseTo(200 + 8);
  });
});

describe('angleToVelocity', () => {
  test('0° → positive vx', () => {
    const v = angleToVelocity(0, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(BULLET_SPEED);
    expect(v.vy).toBeCloseTo(0);
  });

  test('90° → positive vy', () => {
    const v = angleToVelocity(90, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(0);
    expect(v.vy).toBeCloseTo(BULLET_SPEED);
  });

  test('270° → negative vy', () => {
    const v = angleToVelocity(270, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(0);
    expect(v.vy).toBeCloseTo(-BULLET_SPEED);
  });
});

describe('computeHeading', () => {
  test('returns heading from velocity when moving', () => {
    const heading = computeHeading(1, 0, null);
    expect(heading).toBeCloseTo(0);
  });

  test('falls back to lastHeading when stationary', () => {
    const heading = computeHeading(0, 0, Math.PI / 4);
    expect(heading).toBeCloseTo(Math.PI / 4);
  });

  test('falls back to defaultHeading when stationary and no lastHeading', () => {
    const heading = computeHeading(0, 0, null, Math.PI / 2);
    expect(heading).toBeCloseTo(Math.PI / 2);
  });

  test('uses velocity heading over fallback when moving', () => {
    const heading = computeHeading(1, 0, Math.PI);
    expect(heading).toBeCloseTo(0);
  });
});

describe('weaponDropOrder / weaponRoundRobin', () => {
  test('drop order is spread → dual → rapid', () => {
    expect(weaponDropOrder()).toEqual(['spread', 'dual', 'rapid']);
  });

  test('round-robin cycles through the order', () => {
    expect(weaponRoundRobin(5)).toEqual([
      'spread',
      'dual',
      'rapid',
      'spread',
      'dual',
    ]);
  });
});

describe('fire rate ordering', () => {
  test('rapid < cannon < dual = spread (lower ms = faster)', () => {
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_CANNON_FIRE_RATE);
    expect(WEAPON_CANNON_FIRE_RATE).toBeLessThan(WEAPON_DUAL_FIRE_RATE);
    // Spread and dual are both half-time (1 shot every 2 beats) — equal rates.
    expect(WEAPON_DUAL_FIRE_RATE).toBe(WEAPON_SPREAD_FIRE_RATE);
  });
});

describe('beat-grid fire rates (AH-0MUAYB8EH005RJ8B AC3)', () => {
  test('every fire rate is on the shared beat grid', () => {
    const period = beatPeriodMs();
    for (const weapon of Object.values(WEAPON_CATALOGUE)) {
      // Conventional weapons subdivide the beat; the AOE family spans whole
      // beats. `isOnBeatGrid` accepts both, and rejects off-grid rates.
      expect(isOnBeatGrid(weapon.fireRateMs)).toBe(true);
      if (weapon.fireRateMs <= period) {
        expect(period % weapon.fireRateMs).toBe(0);
      } else {
        expect(weapon.fireRateMs % period).toBe(0);
      }
    }
  });

  test('fire rates match the producer-specified subdivisions and intervals', () => {
    const period = beatPeriodMs();
    expect(period).toBe(750);
    // cannon — 2/beat (160 BPM) → 375 ms
    expect(WEAPON_CANNON_SUBDIVISION).toBe(2);
    expect(WEAPON_CANNON_FIRE_RATE).toBe(beatSubdivisionMs(2));
    expect(period / WEAPON_CANNON_FIRE_RATE).toBe(2);
    expect(WEAPON_CATALOGUE.cannon.fireRateMs).toBe(375);
    // spread — 0.5/beat (one shot every 2 beats) → 1500 ms
    expect(WEAPON_SPREAD_SUBDIVISION).toBe(0.5);
    expect(WEAPON_CATALOGUE.spread.fireRateMs).toBe(1500);
    // dual — 0.5/beat (one shot every 2 beats) → 1500 ms
    expect(WEAPON_DUAL_SUBDIVISION).toBe(0.5);
    expect(WEAPON_CATALOGUE.dual.fireRateMs).toBe(1500);
    // rapid — 3/beat (240 BPM) → 250 ms (the 1.5× cannon cap binds)
    expect(WEAPON_RAPID_SUBDIVISION).toBe(3);
    expect(WEAPON_CATALOGUE.rapid.fireRateMs).toBe(250);
  });

  test('the invariant rejects an off-grid fire rate (guards future weapons)', () => {
    // 200 ms does not divide the 750 ms beat period — a new weapon using it
    // would fail the catalogue-wide check above.
    expect(isOnBeatGrid(200)).toBe(false);
    expect(beatPeriodMs() % 200).not.toBe(0);
    // The future 20 BPM quarter-time weapon (4/beat = 187.5 ms) stays on-grid.
    expect(isOnBeatGrid(beatSubdivisionMs(4))).toBe(true);
  });

  test('the invariant accepts slow rates that span whole beats (AOE family)', () => {
    // A slow weapon fires once every N beats: the rate is an exact multiple
    // of the beat period (e.g. Nova 4 beats = 3000 ms, Mortar 2 = 1500 ms).
    expect(isOnBeatGrid(1500)).toBe(true);
    expect(isOnBeatGrid(3000)).toBe(true);
    expect(isOnBeatGrid(750 * 8)).toBe(true);
    // A rate that is neither a subdivision nor a whole-beat multiple is
    // rejected (1000 ms = 1⅓ beats — no integer relationship).
    expect(isOnBeatGrid(1000)).toBe(false);
  });

  test('the invariant accepts high subdivisions despite floating-point drift', () => {
    // Rapid reaches 11/beat and 13/beat under weapon leveling; the naive
    // `period % fireRateMs` check fails for these mathematically on-grid
    // rates, so the ratio-based check must accept them (AH-0MUQOV9JV00389E7).
    expect(isOnBeatGrid(750 / 11)).toBe(true);
    expect(isOnBeatGrid(750 / 13)).toBe(true);
    expect(isOnBeatGrid(750 / 7)).toBe(true);
  });

  test('an invalid fire rate is never on the beat grid', () => {
    expect(isOnBeatGrid(0)).toBe(false);
    expect(isOnBeatGrid(-375)).toBe(false);
    expect(isOnBeatGrid(NaN)).toBe(false);
  });
});

describe('configurable beat subdivisions (AH-0MUAYB8EH005RJ8B AC2/AC6)', () => {
  const weaponIds = Object.keys(WEAPON_CATALOGUE) as WeaponId[];

  test('weaponFireRateMs derives the catalogue defaults with no override', () => {
    for (const id of weaponIds) {
      expect(weaponFireRateMs(id)).toBe(WEAPON_CATALOGUE[id].fireRateMs);
    }
  });

  test('a subdivision override changes the derived fire rate (cadence)', () => {
    // 750 ms beat / 4 = 187.5 ms (cannon fired twice as fast as default).
    expect(
      weaponFireRateMs('cannon', {
        ...DEFAULT_WEAPON_SUBDIVISIONS,
        cannon: 4,
      }),
    ).toBe(187.5);
    // 750 ms beat / 2 = 375 ms (spread twice as fast as default).
    expect(
      weaponFireRateMs('spread', {
        ...DEFAULT_WEAPON_SUBDIVISIONS,
        spread: 2,
      }),
    ).toBe(375);
  });

  test('a BPM override changes the derived fire rate (cadence)', () => {
    // 160 BPM → 375 ms beat; cannon 2/beat → 187.5 ms.
    expect(weaponFireRateMs('cannon', DEFAULT_WEAPON_SUBDIVISIONS, 160)).toBe(
      187.5,
    );
  });

  test('the catalogue-wide on-grid invariant holds under a non-default config', () => {
    const bpm = 120;
    const subdivisions = {
      cannon: 4,
      spread: 3,
      dual: 2,
      rapid: 8,
      wave_laser: 1,
      ricochet: 1,
      cluster: 0.5,
      options: 1,
      nova: 0.25,
      mortar: 0.5,
      arc: 1,
      rear_guard: 2,
      broadside: 0.5,
      railgun: 0.25,
      shard_swarm: 1,
      heavy_slug: 0.5,
    };
    for (const id of weaponIds) {
      const rate = weaponFireRateMs(id, subdivisions, bpm);
      // On-grid covers both fast subdivisions (rate divides the period) and
      // slow AOE cadences (rate is an integer multiple of the period).
      expect(isOnBeatGrid(rate, bpm)).toBe(true);
    }
  });
});

describe('Wave laser — single red hitscan beam (AH-0MVREBUJ5004HDRQ)', () => {
  test('is a catalogue weapon with a name and a player-facing description', () => {
    const def = WEAPON_CATALOGUE.wave_laser;
    expect(def.name).toBe('Wave Laser');
    expect(def.description.length).toBeGreaterThan(0);
  });

  test('fires a single aimed beam along the ship heading (one [0] offset)', () => {
    const def = WEAPON_CATALOGUE.wave_laser;
    expect(def.offsets).toEqual([0]);
    expect(def.sideOffsets).toBeUndefined();
  });

  test('fires once every two beats (0.5 subdivision → 1500 ms at 80 BPM) on the grid', () => {
    // Halved by the curve-flattening work (AH-0MVWAVL6R001UI60): the beam has
    // no projectile/AOE lever, so its saturated output can only be held inside
    // the ≤ 50 % level-cap ceiling on the cadence axis.
    expect(WEAPON_WAVE_LASER_SUBDIVISION).toBe(0.5);
    expect(WEAPON_WAVE_LASER_FIRE_RATE).toBe(1500);
    expect(WEAPON_CATALOGUE.wave_laser.fireRateMs).toBe(1500);
    expect(isOnBeatGrid(WEAPON_CATALOGUE.wave_laser.fireRateMs)).toBe(true);
  });

  test('is a timed weapon drop (not permanent) and not part of the AOE family', () => {
    expect(isTimedWeapon('wave_laser')).toBe(true);
    expect(isAoeWeapon('wave_laser')).toBe(false);
    expect(WEAPON_CATALOGUE.wave_laser.aoe).toBeUndefined();
  });

  test('carries no damage budget — the beam is fixed at 1 damage and never pierces', () => {
    // The retired pass-through budget (AH-0MV1BIUSJ0090W92): the hitscan beam
    // stops at the first intercept and deals exactly 1 damage at every level
    // (AC2/AC7).
    expect(WEAPON_CATALOGUE.wave_laser.maxHitPoints).toBeUndefined();
  });

  test('declares a hitscan ray one screen wide and visible for 0.3 s (AC3/AC4)', () => {
    const def = WEAPON_CATALOGUE.wave_laser;
    expect(def.hitscan).toBeDefined();
    expect(def.hitscan!.length).toBe(WAVE_LASER_BEAM_LENGTH);
    expect(def.hitscan!.length).toBeGreaterThanOrEqual(GAME_WIDTH);
    expect(def.hitscan!.duration).toBeCloseTo(0.3, 6);
    // The travelling-bullet lifetime mirrors the beam's visible duration; the
    // shot itself is resolved instantly by the shared ray seam.
    expect(def.bulletLifetime).toBe(WEAPON_BULLET_LIFETIME.wave_laser);
  });

  test('is a pure-red beam, distinct from the Heavy Slug\u2019s deep red (AC1, A5)', () => {
    expect(WEAPON_CATALOGUE.wave_laser.bulletColor).toBe(BULLET_COLORS.wave_laser);
    expect(BULLET_COLORS.wave_laser).toBe(0xff0000);
    expect(WEAPON_CATALOGUE.wave_laser.bulletColor).not.toBe(
      BULLET_COLORS.heavy_slug,
    );
    expect(WEAPON_CATALOGUE.wave_laser.bulletColor).not.toBe(
      WEAPON_CATALOGUE.cannon.bulletColor,
    );
    // One beam, drawn as a line/column — never a fan and never a pair.
    expect(WEAPON_CATALOGUE.wave_laser.bulletShape).toBe('line');
    expect(WEAPON_CATALOGUE.wave_laser.offsets).toHaveLength(1);
  });

  test('carries a wide muzzle flash and a distinct impact FX (AH-0MV822ACO007CEZF)', () => {
    const def = WEAPON_CATALOGUE.wave_laser;
    // Wide launch cue at the ship — larger than the cannon's default flash.
    expect(def.muzzleFlash).toBeDefined();
    expect(def.muzzleFlash!.color).toBe(BULLET_COLORS.wave_laser);
    expect(def.muzzleFlash!.radius).toBeGreaterThan(
      WEAPON_CATALOGUE.cannon.muzzleFlash!.radius,
    );
    // Distinct red impact flash + the baked wave-laser hit cue at the point
    // where the beam stops.
    expect(def.impactFx).toBeDefined();
    expect(def.impactFx!.color).toBe(BULLET_COLORS.wave_laser);
    expect(def.impactFx!.cue).toBe('playWaveLaserImpactSound');
  });
});

describe('Centipede ricochet (AH-0MV1BIV5L005NJAI)', () => {
  test('is a catalogue weapon with a name and a player-facing description', () => {
    const def = WEAPON_CATALOGUE.ricochet;
    expect(def.name).toBe('Ricochet');
    expect(def.description.length).toBeGreaterThan(0);
  });

  test('fires a single aimed pellet along the ship heading (one [0] offset)', () => {
    const def = WEAPON_CATALOGUE.ricochet;
    expect(def.offsets).toEqual([0]);
    expect(def.sideOffsets).toBeUndefined();
  });

  test('fires once every 2 beats (0.5 subdivision → 1500 ms at 80 BPM) on the grid', () => {
    // Trimmed from 1/beat by the non-cannon level-0 output trim
    // (AH-0MVWAVKS0005P9VN): the cadence lever, so the bounce budget stays.
    expect(WEAPON_RICOCHET_SUBDIVISION).toBe(0.5);
    expect(WEAPON_RICOCHET_FIRE_RATE).toBe(1500);
    expect(WEAPON_CATALOGUE.ricochet.fireRateMs).toBe(1500);
    expect(isOnBeatGrid(WEAPON_CATALOGUE.ricochet.fireRateMs)).toBe(true);
  });

  test('supplies a base wall-bounce budget of 2 (the level curve grows it)', () => {
    expect(WEAPON_CATALOGUE.ricochet.bounce).toBe(2);
  });

  test('is a timed weapon drop (not permanent) and not part of the AOE family', () => {
    expect(isTimedWeapon('ricochet')).toBe(true);
    expect(isAoeWeapon('ricochet')).toBe(false);
    expect(WEAPON_CATALOGUE.ricochet.aoe).toBeUndefined();
  });

  test('carries a distinct neon-green pellet and no damage budget', () => {
    expect(WEAPON_CATALOGUE.ricochet.bulletColor).toBe(BULLET_COLORS.ricochet);
    expect(WEAPON_CATALOGUE.ricochet.bulletColor).not.toBe(
      WEAPON_CATALOGUE.cannon.bulletColor,
    );
    expect(WEAPON_CATALOGUE.ricochet.maxHitPoints).toBeUndefined();
  });
});
describe('Missile Command cluster missile (AH-0MV1BIVIJ007KYXU)', () => {
  test('is a catalogue weapon with a name and a player-facing description', () => {
    const def = WEAPON_CATALOGUE.cluster;
    expect(def.name).toBe('Cluster Missile');
    expect(def.description.length).toBeGreaterThan(0);
  });

  test('fires a single aimed missile along the ship heading (one [0] offset)', () => {
    const def = WEAPON_CATALOGUE.cluster;
    expect(def.offsets).toEqual([0]);
    expect(def.sideOffsets).toBeUndefined();
  });

  test('fires once every 4 beats (0.25 subdivision → 3000 ms at 80 BPM) on the grid', () => {
    // Trimmed from 0.5/beat by the non-cannon level-0 output trim
    // (AH-0MVWAVKS0005P9VN): the cadence lever, so the split payload stays.
    expect(WEAPON_CLUSTER_SUBDIVISION).toBe(0.25);
    expect(WEAPON_CLUSTER_FIRE_RATE).toBe(3000);
    expect(WEAPON_CATALOGUE.cluster.fireRateMs).toBe(3000);
    expect(isOnBeatGrid(WEAPON_CATALOGUE.cluster.fireRateMs)).toBe(true);
  });

  test('supplies a base split warhead count of 2 (the level curve grows it)', () => {
    expect(WEAPON_CATALOGUE.cluster.splits).toBe(CLUSTER_BASE_WARHEADS);
    expect(CLUSTER_BASE_WARHEADS).toBe(2);
  });

  test('is a timed weapon drop (not permanent) and not part of the AOE family', () => {
    expect(isTimedWeapon('cluster')).toBe(true);
    expect(isAoeWeapon('cluster')).toBe(false);
    expect(WEAPON_CATALOGUE.cluster.aoe).toBeUndefined();
  });

  test('carries a distinct neon-hot-pink colour and no damage/bounce budget', () => {
    expect(WEAPON_CATALOGUE.cluster.bulletColor).toBe(BULLET_COLORS.cluster);
    expect(WEAPON_CATALOGUE.cluster.bulletColor).not.toBe(
      WEAPON_CATALOGUE.cannon.bulletColor,
    );
    expect(WEAPON_CATALOGUE.cluster.maxHitPoints).toBeUndefined();
    expect(WEAPON_CATALOGUE.cluster.bounce).toBeUndefined();
  });

  test('declares its visuals-only feel metadata (AH-0MV822B1B0048UZT)', () => {
    const cluster = WEAPON_CATALOGUE.cluster;
    // In-flight identity: a small missile with an animated exhaust flame
    // (drawn through the shared bullet-shape seam) and a short fading
    // smoke trail.
    expect(cluster.bulletShape).toBe('missile');
    expect(cluster.bulletFlame).toBeDefined();
    expect(cluster.bulletFlame!).toBeGreaterThan(0);
    expect(cluster.bulletTrail).toBeGreaterThan(0);
    // A white-hot neon rim outlines the missile body so it pops against
    // the magenta core (shared seam rim knob).
    expect(cluster.bulletRim).toBeDefined();
    // A clean launch puff at the ship (shared spawn path).
    expect(cluster.muzzleFlash).toBeDefined();
    expect(cluster.muzzleFlash!.color).toBe(BULLET_COLORS.cluster);
    // A distinct hot-pink impact flash + baked hit cue on connect.
    expect(cluster.impactFx).toBeDefined();
    expect(cluster.impactFx!.color).toBe(BULLET_COLORS.cluster);
    expect(cluster.impactFx!.cue).toBe('playClusterImpactSound');
  });

  test('warhead discs stay visually distinct from the missile shell (AH-0MV822B1B0048UZT)', () => {
    const cluster = WEAPON_CATALOGUE.cluster;
    // The split payload shrinks each warhead below the shell radius and
    // renders them as small discs (not tiny missiles) so the burst reads
    // as a cluster of points.
    expect(CLUSTER_WARHEAD_RADIUS_SCALE).toBeLessThan(1);
    expect(cluster.splits).toBe(CLUSTER_BASE_WARHEADS);
  });
});

describe('Gradius Options orbiting satellites (AH-0MV1BIVVK0043TEM)', () => {
  test('is a catalogue weapon with a name and a player-facing description', () => {
    const def = WEAPON_CATALOGUE.options;
    expect(def.name).toBe('Options');
    expect(def.description.length).toBeGreaterThan(0);
  });

  test('fires once every 2 beats (0.5 subdivision → 1500 ms at 80 BPM) on the grid', () => {
    // Trimmed from 1/beat by the non-cannon level-0 output trim
    // (AH-0MVWAVKS0005P9VN): the cadence lever, so the pod count stays.
    expect(WEAPON_OPTIONS_SUBDIVISION).toBe(0.5);
    expect(WEAPON_OPTIONS_FIRE_RATE).toBe(1500);
    expect(WEAPON_CATALOGUE.options.fireRateMs).toBe(1500);
    expect(isOnBeatGrid(WEAPON_CATALOGUE.options.fireRateMs)).toBe(true);
  });

  test('carries an orbit descriptor with the base two pods and the orbit radius', () => {
    const orbit = WEAPON_CATALOGUE.options.orbit;
    expect(orbit).toBeDefined();
    expect(orbit!.pods).toBe(OPTIONS_BASE_PODS);
    expect(orbit!.pods).toBe(2);
    expect(orbit!.radius).toBe(OPTIONS_ORBIT_RADIUS);
    expect(OPTIONS_MAX_PODS).toBeGreaterThanOrEqual(orbit!.pods);
  });

  test('is a timed weapon drop (not permanent) and not part of the AOE family', () => {
    expect(isTimedWeapon('options')).toBe(true);
    expect(isAoeWeapon('options')).toBe(false);
    expect(WEAPON_CATALOGUE.options.aoe).toBeUndefined();
    expect(WEAPON_CATALOGUE.options.maxHitPoints).toBeUndefined();
    expect(WEAPON_CATALOGUE.options.bounce).toBeUndefined();
    expect(WEAPON_CATALOGUE.options.splits).toBeUndefined();
  });

  test('carries a distinct neon-aquamarine colour and a smaller pod bullet', () => {
    expect(WEAPON_CATALOGUE.options.bulletColor).toBe(BULLET_COLORS.options);
    expect(WEAPON_CATALOGUE.options.bulletColor).not.toBe(
      WEAPON_CATALOGUE.cannon.bulletColor,
    );
    expect(WEAPON_CATALOGUE.options.bulletSize).toBeLessThan(
      WEAPON_CATALOGUE.cannon.bulletSize,
    );
  });

  test('carries the pod-shot visual identity (rim tint, light trail, muzzle flash, impact fx) (AH-0MV822BDN008IYL6)', () => {
    const opts = WEAPON_CATALOGUE.options;
    // A small pod dart with its own pale-aqua tint (rim), a short faint
    // fading trail, an aqua launch flash and a baked aqua impact pop — all
    // visual metadata, distinct from the main gun.
    expect(opts.bulletShape).toBe('chevron');
    expect(opts.bulletRim).toBe(0xd9fff2);
    expect(opts.bulletTrail).toBeGreaterThan(0);
    expect(opts.muzzleFlash).toBeDefined();
    expect(opts.muzzleFlash!.color).toBe(BULLET_COLORS.options);
    expect(opts.impactFx).toBeDefined();
    expect(opts.impactFx!.cue).toBe('playOptionsImpactSound');
  });
});

describe('Nova expanding-ring shockwave (AH-0MV822BPT002GF17)', () => {
  test('carries the ring weapon definition unchanged (visual metadata only)', () => {
    const nova = WEAPON_CATALOGUE.nova;
    // The Nova shot is an expanding ring shockwave from the ship: the ring
    // bullet shape stays unique to the Nova (roster), and the muzzle flash
    // launch cue + per-shot impact are visual/feel metadata on the def.
    expect(nova.bulletShape).toBe('ring');
    expect(nova.bulletColor).toBe(BULLET_COLORS.nova);
    expect(nova.bulletSize).toBeGreaterThan(0);
    expect(nova.aoe?.trigger).toBe('onFire');
    // Fire feel: a bright flash at the ship when the ring launches (shared
    // combat-core muzzle-flash path drives it from this metadata).
    expect(nova.muzzleFlash).toBeDefined();
    expect(nova.muzzleFlash!.color).toBe(BULLET_COLORS.nova);
    expect(nova.muzzleFlash!.duration).toBeGreaterThan(0);
  });
});

describe('Mortar arcing-shell blast (AH-0MV822C250051OVN)', () => {
  test('keeps the shell shape and onRandom blast mechanics unchanged', () => {
    const mortar = WEAPON_CATALOGUE.mortar;
    // The Mortar's unique in-flight family is the `shell` primitive — no
    // other weapon claims it — so each shot reads as an arcing shell. The
    // blast still resolves instantly at a random in-range point (no
    // travelling projectile): the visual work adds feel, never behaviour.
    expect(mortar.bulletShape).toBe('shell');
    expect(mortar.bulletColor).toBe(BULLET_COLORS.mortar);
    expect(mortar.aoe?.trigger).toBe('onRandom');
    expect(mortar.aoe?.projectileSpeed).toBe(AOE_PROJECTILE_SPEEDS.mortar);
  });

  test('carries the launch-flash fire VFX through the shared combat-core path (AH-0MV822C250051OVN)', () => {
    const mortar = WEAPON_CATALOGUE.mortar;
    // A hot deep-orange launch flash at the ship when the shell fires — the
    // shared combat-core spawn path (`_autoFire`) drives it from this
    // metadata, so the game and every gym show the identical flash.
    expect(mortar.muzzleFlash).toBeDefined();
    expect(mortar.muzzleFlash!.color).toBe(BULLET_COLORS.mortar);
    expect(mortar.muzzleFlash!.radius).toBeGreaterThan(0);
    expect(mortar.muzzleFlash!.duration).toBeGreaterThan(0);
  });

  test('fires once every 2 beats and stays an AOE weapon on the grid', () => {
    // The visual/feel work must not touch the cadence: the Mortar still fires
    // once every two beats and remains an exact multiple of the beat period.
    expect(WEAPON_CATALOGUE.mortar.fireRateMs).toBe(1500);
    expect(isAoeWeapon('mortar')).toBe(true);
    expect(isOnBeatGrid(WEAPON_CATALOGUE.mortar.fireRateMs)).toBe(true);
  });
});

describe('Arc chaining-bolt feel (AH-0MV822CE7004MQ14)', () => {
  test('keeps the bolt shape and onFire chain mechanics unchanged', () => {
    const arc = WEAPON_CATALOGUE.arc;
    // The Arc's unique in-flight family is the `bolt` primitive — a jagged
    // lightning bolt between targets drawn by the shared chain VFX
    // (`spawnArcChain`). The chain still resolves instantly at fire time (no
    // travelling projectile): the visual/feel work adds feedback, never
    // behaviour.
    expect(arc.bulletShape).toBe('bolt');
    expect(arc.bulletColor).toBe(BULLET_COLORS.arc);
    expect(arc.aoe?.trigger).toBe('onFire');
    expect(arc.aoe?.chains).toBe(2);
  });

  test('carries the launch-flash fire VFX through the shared combat-core path (AH-0MV822CE7004MQ14)', () => {
    const arc = WEAPON_CATALOGUE.arc;
    // A bright electric-purple launch flash at the ship when the bolt fires —
    // the shared combat-core spawn path (`_autoFire`) drives it from this
    // metadata, so the game and every gym show the identical flash.
    expect(arc.muzzleFlash).toBeDefined();
    expect(arc.muzzleFlash!.color).toBe(BULLET_COLORS.arc);
    expect(arc.muzzleFlash!.radius).toBeGreaterThan(0);
    expect(arc.muzzleFlash!.duration).toBeGreaterThan(0);
  });

  test('carries distinct electric connect feedback (impact flash + baked cue) (AH-0MV822CE7004MQ14)', () => {
    const arc = WEAPON_CATALOGUE.arc;
    // Every bolt that lands flashes at its target and plays the baked arc
    // impact cue through the shared impact seam — routed so the game and
    // every gym connect identically.
    expect(arc.impactFx).toBeDefined();
    expect(arc.impactFx!.cue).toBe('playArcImpactSound');
    expect(arc.impactFx!.color).toBe(BULLET_COLORS.arc);
    expect(arc.impactFx!.radius).toBeGreaterThan(0);
    expect(arc.impactFx!.duration).toBeGreaterThan(0);
  });

  test('fires once per beat and stays an AOE weapon on the grid', () => {
    // The visual/feel work must not touch the cadence: the Arc still fires
    // once per beat and remains an exact subdivision of the beat period.
    expect(WEAPON_CATALOGUE.arc.fireRateMs).toBe(750);
    expect(isAoeWeapon('arc')).toBe(true);
    expect(isOnBeatGrid(WEAPON_CATALOGUE.arc.fireRateMs)).toBe(true);
  });
});

describe('net-new weapons (AH-0MVCRC52P001YIPW)', () => {
  // The five additions beyond the original 11. Each is exercised here through
  // the public catalogue/pattern helpers (the shared firing seam the game and
  // every gym consume), so these assertions cover real firing behaviour
  // rather than the catalogue shape alone.
  const NEW_WEAPON_IDS: readonly WeaponId[] = [
    'rear_guard',
    'broadside',
    'railgun',
    'shard_swarm',
    'heavy_slug',
  ];

  test('every new weapon is a complete, on-grid catalogue entry', () => {
    for (const id of NEW_WEAPON_IDS) {
      const weapon = WEAPON_CATALOGUE[id];
      expect(weapon.id, id).toBe(id);
      expect(weapon.name.length, id).toBeGreaterThan(0);
      expect(weapon.description.length, id).toBeGreaterThan(0);
      expect(weapon.offsets.length, id).toBeGreaterThan(0);
      expect(weapon.bulletSize, id).toBeGreaterThan(0);
      expect(weapon.bulletLifetime, id).toBeGreaterThan(0);
      expect(isOnBeatGrid(weapon.fireRateMs), id).toBe(true);
    }
  });

  test('Rear Guard fires one bullet directly behind the heading', () => {
    const bullets = createBulletsFromHeading(WEAPON_CATALOGUE.rear_guard, 0, 0, 0);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].angleDeg).toBeCloseTo(180);
  });

  test('Rear Guard declares a compact rose launch flash behind the ship (AH-0MVV0WN96007TU9J)', () => {
    const def = WEAPON_CATALOGUE.rear_guard;
    // A single rearward pellet launches with a small rose pop, shorter and
    // smaller than the Cannon's forward flash, so the backward shot reads as a
    // muted push rather than a second forward weapon.
    expect(def.muzzleFlash).toBeDefined();
    expect(def.muzzleFlash!.color).toBe(BULLET_COLORS.rear_guard);
    expect(def.muzzleFlash!.radius).toBe(6);
    expect(def.muzzleFlash!.radius).toBeLessThan(
      WEAPON_CATALOGUE.cannon.muzzleFlash!.radius,
    );
    expect(def.muzzleFlash!.duration).toBeGreaterThanOrEqual(0.1);
    expect(def.muzzleFlash!.duration).toBeLessThanOrEqual(0.12);
  });

  test('Rear Guard declares rose impact feedback routed through its baked pop cue (AH-0MVV0WN96007TU9J)', () => {
    const def = WEAPON_CATALOGUE.rear_guard;
    // The connect is colour-matched to the rose pellet and audible through the
    // shared impact seam instead of the generic warm-white fallback flash.
    expect(def.impactFx).toBeDefined();
    expect(def.impactFx!.color).toBe(BULLET_COLORS.rear_guard);
    expect(def.impactFx!.cue).toBe('playRearGuardImpactSound');
    expect(def.impactFx!.radius).toBe(8);
    expect(def.impactFx!.duration).toBeLessThanOrEqual(0.14);
    // Softer than the Cannon's crack, matching the single compact pellet.
    expect(def.impactFx!.duration).toBeLessThanOrEqual(
      WEAPON_CATALOGUE.cannon.impactFx!.duration,
    );
  });

  test('the Rear Guard feel package changes no behaviour or balance values (AH-0MVV0WN96007TU9J)', () => {
    const def = WEAPON_CATALOGUE.rear_guard;
    // The metadata-only package must leave the only rearward firing identity
    // exactly as shipped.
    expect(def.fireRateMs).toBe(WEAPON_REAR_GUARD_FIRE_RATE);
    expect(def.offsets).toEqual([Math.PI]);
    expect(def.bulletColor).toBe(BULLET_COLORS.rear_guard);
    expect(def.bulletShape).toBe('pellet');
    expect(def.bulletRim).toBe(0xffd0e0);
    expect(def.bulletTrail).toBe(1.6);
    expect(def.bulletSize).toBe(0.9);
    expect(def.bulletLifetime).toBe(WEAPON_BULLET_LIFETIME.rear_guard);
  });

  test('Broadside declares a wide teal launch flash for the perpendicular pair (AH-0MVV0WNOX0078G9G)', () => {
    const def = WEAPON_CATALOGUE.broadside;
    // The pair leaves the hull left and right, so the launch flash is wider
    // than the Cannon's 7 px forward pop (and inside the 12 px ceiling); one
    // flash per shot input is spawned by the shared combat-core path.
    expect(def.muzzleFlash).toBeDefined();
    expect(def.muzzleFlash!.color).toBe(BULLET_COLORS.broadside);
    expect(def.muzzleFlash!.radius).toBe(9);
    expect(def.muzzleFlash!.radius).toBeGreaterThan(
      WEAPON_CATALOGUE.cannon.muzzleFlash!.radius,
    );
    expect(def.muzzleFlash!.radius).toBeLessThanOrEqual(12);
    expect(def.muzzleFlash!.duration).toBeGreaterThan(0);
    expect(def.muzzleFlash!.duration).toBeLessThanOrEqual(0.12);
  });

  test('Broadside declares teal impact feedback routed through its baked dart tick (AH-0MVV0WNOX0078G9G)', () => {
    const def = WEAPON_CATALOGUE.broadside;
    // The connect is colour-matched to the teal dart and audible through the
    // shared impact seam instead of the generic warm-white fallback flash.
    expect(def.impactFx).toBeDefined();
    expect(def.impactFx!.color).toBe(BULLET_COLORS.broadside);
    expect(def.impactFx!.cue).toBe('playBroadsideImpactSound');
    expect(def.impactFx!.radius).toBe(8);
    expect(def.impactFx!.duration).toBeGreaterThan(0);
    expect(def.impactFx!.duration).toBeLessThanOrEqual(0.12);
  });

  test('the Broadside feel package changes no behaviour or balance values (AH-0MVV0WNOX0078G9G)', () => {
    const def = WEAPON_CATALOGUE.broadside;
    // The metadata-only package must leave the perpendicular pair and the dart
    // identity exactly as shipped — no forward shot is introduced.
    expect(def.fireRateMs).toBe(WEAPON_BROADSIDE_FIRE_RATE);
    expect(def.offsets).toEqual([(-90 * Math.PI) / 180, (90 * Math.PI) / 180]);
    expect(def.bulletColor).toBe(BULLET_COLORS.broadside);
    expect(def.bulletShape).toBe('dart');
    expect(def.bulletShapeLength).toBe(2.4);
    expect(def.bulletThickness).toBe(1.4);
    expect(def.bulletTrail).toBe(1.4);
    expect(def.bulletSize).toBe(0.9);
    expect(def.bulletLifetime).toBe(WEAPON_BULLET_LIFETIME.broadside);
  });

  test('Broadside fires one bullet to each side and none forward', () => {
    const bullets = createBulletsFromHeading(WEAPON_CATALOGUE.broadside, 0, 0, 0);
    expect(bullets).toHaveLength(2);
    const angles = bullets.map((b) => b.angleDeg).sort((a, b) => a - b);
    expect(angles[0]).toBeCloseTo(-90);
    expect(angles[1]).toBeCloseTo(90);
    expect(angles.some((a) => Math.abs(a) < 1e-9)).toBe(false);
  });

  test('Railgun is a single slow aimed shot that must earn its pass-through', () => {
    const def = WEAPON_CATALOGUE.railgun;
    // One aimed shot along the heading: the rail is a precision shot, not a
    // fan and not a pair.
    expect(def.offsets).toEqual([0]);
    // A level-0 Railgun carries a single hit point of damage budget, so the
    // tracer is consumed by the first enemy it meets — a fresh pickup does
    // NOT pass through (AH-0MVY0A23A009MRK3). The pierce is earned by the
    // first upgrade: `resolveWeaponDefinition('railgun', 1).maxHitPoints` is
    // 2 (pinned in `weaponLevels.test.ts`).
    expect(def.maxHitPoints).toBe(1);
    // Heavier than the Wave Laser by cadence — the comparison that survives
    // the Wave Laser's move to a single-hit hitscan beam
    // (AH-0MVREBUJ5004HDRQ), so "heavier" never falls back to budget depth.
    expect(def.fireRateMs).toBeGreaterThan(
      WEAPON_CATALOGUE.wave_laser.fireRateMs,
    );
  });

  test('Railgun declares sky-blue impact feedback routed through its baked hit cue (AH-0MVMIGVCE004VSNA)', () => {
    const def = WEAPON_CATALOGUE.railgun;
    // The tracer's connect is colour-matched to its sky-blue silhouette and
    // audible through the shared impact seam, instead of falling back to the
    // generic warm-white flash with no hit cue.
    expect(def.impactFx).toBeDefined();
    expect(def.impactFx!.color).toBe(BULLET_COLORS.railgun);
    expect(def.impactFx!.cue).toBe('playRailgunImpactSound');
    // Sized to the heavy single shot: at least the cannon's impact flash, and
    // no flash longer than the shipped 0.16 s ceiling (epic AC8).
    expect(def.impactFx!.radius).toBeGreaterThanOrEqual(
      WEAPON_CATALOGUE.cannon.impactFx!.radius,
    );
    expect(def.impactFx!.duration).toBeLessThanOrEqual(0.16);
  });

  test('Railgun declares a heavy sky-blue launch flash between the cannon and the wave laser (AH-0MVQ6C1YL003HU9K)', () => {
    const def = WEAPON_CATALOGUE.railgun;
    // The launch cue completes the Railgun's feel package: a sky-blue flash at
    // the hull sized for a heavy single shot — bigger than the cannon's pop,
    // smaller than the wave laser's wide flare.
    expect(def.muzzleFlash).toBeDefined();
    expect(def.muzzleFlash!.color).toBe(BULLET_COLORS.railgun);
    const cannon = WEAPON_CATALOGUE.cannon.muzzleFlash!;
    const waveLaser = WEAPON_CATALOGUE.wave_laser.muzzleFlash!;
    expect(def.muzzleFlash!.radius).toBeGreaterThan(cannon.radius);
    expect(def.muzzleFlash!.radius).toBeLessThan(waveLaser.radius);
    expect(def.muzzleFlash!.duration).toBeGreaterThan(cannon.duration);
    expect(def.muzzleFlash!.duration).toBeLessThan(waveLaser.duration);
  });

  test('Shard Swarm fires a symmetric five-way fan within ±15°', () => {
    const offsetsDeg = WEAPON_CATALOGUE.shard_swarm.offsets.map(
      (o) => (o * 180) / Math.PI,
    );
    expect(offsetsDeg).toHaveLength(5);
    for (const deg of offsetsDeg) {
      expect(Math.abs(deg)).toBeLessThanOrEqual(15 + 1e-9);
    }
    expect(offsetsDeg).toContain(0);
    // Symmetric about the heading.
    expect(offsetsDeg[0]).toBeCloseTo(-offsetsDeg[offsetsDeg.length - 1]);
    expect(offsetsDeg[1]).toBeCloseTo(-offsetsDeg[offsetsDeg.length - 2]);
  });

  test('Shard Swarm declares a lime launch flash sized for a five-shard burst (AH-0MVV0WMTE0007NGS)', () => {
    const def = WEAPON_CATALOGUE.shard_swarm;
    // The launch cue is colour-matched to the lime shards and a touch larger
    // than the cannon's single-shot pop, so the fan reads as a burst without
    // leaving the shipped 5–12 px / 0.07–0.16 s band.
    expect(def.muzzleFlash).toBeDefined();
    expect(def.muzzleFlash!.color).toBe(BULLET_COLORS.shard_swarm);
    expect(def.muzzleFlash!.radius).toBe(8);
    expect(def.muzzleFlash!.radius).toBeGreaterThan(
      WEAPON_CATALOGUE.cannon.muzzleFlash!.radius,
    );
    expect(def.muzzleFlash!.radius).toBeLessThanOrEqual(12);
    expect(def.muzzleFlash!.duration).toBeGreaterThanOrEqual(0.07);
    expect(def.muzzleFlash!.duration).toBeLessThanOrEqual(0.12);
  });

  test('Shard Swarm declares lime impact feedback routed through its baked hit cue (AH-0MVV0WMTE0007NGS)', () => {
    const def = WEAPON_CATALOGUE.shard_swarm;
    // The connect is colour-matched to the lime shards and audible through the
    // shared impact seam instead of the generic warm-white fallback flash.
    expect(def.impactFx).toBeDefined();
    expect(def.impactFx!.color).toBe(BULLET_COLORS.shard_swarm);
    expect(def.impactFx!.cue).toBe('playShardSwarmImpactSound');
    expect(def.impactFx!.radius).toBe(8);
    // A five-shard volley connects in one frame: keep the flash short so the
    // hits read as one lime impact (epic AC8 ceiling 0.16 s, brief ≤ 0.12 s).
    expect(def.impactFx!.duration).toBeLessThanOrEqual(0.12);
  });

  test('the Shard Swarm feel package changes no behaviour or balance values (AH-0MVV0WMTE0007NGS)', () => {
    const def = WEAPON_CATALOGUE.shard_swarm;
    // The metadata-only package must leave the five-shard firing identity
    // exactly as shipped.
    expect(def.fireRateMs).toBe(WEAPON_SHARD_SWARM_FIRE_RATE);
    expect(def.offsets).toEqual([
      (-15 * Math.PI) / 180,
      (-7.5 * Math.PI) / 180,
      0,
      (7.5 * Math.PI) / 180,
      (15 * Math.PI) / 180,
    ]);
    expect(def.bulletColor).toBe(BULLET_COLORS.shard_swarm);
    expect(def.bulletShape).toBe('shard');
    expect(def.bulletShapeLength).toBe(1.6);
    expect(def.bulletSize).toBe(0.72);
    expect(def.bulletLifetime).toBe(WEAPON_BULLET_LIFETIME.shard_swarm);
  });

  test('Heavy Slug declares the largest deep-red launch flash in the catalogue (AH-0MVV0WO4M001KEDG)', () => {
    const def = WEAPON_CATALOGUE.heavy_slug;
    // One huge slow round needs the heaviest launch cue: the largest flash of
    // the set, at the shipped 12 px ceiling (epic AC8 — no value above the
    // budget). A documented tie with the Wave Laser's 12 px flare is
    // acceptable and is pinned explicitly below.
    expect(def.muzzleFlash).toBeDefined();
    expect(def.muzzleFlash!.color).toBe(BULLET_COLORS.heavy_slug);
    expect(def.muzzleFlash!.radius).toBe(12);
    expect(def.muzzleFlash!.duration).toBe(0.16);
    const others = Object.entries(WEAPON_CATALOGUE).filter(
      ([id, w]) => id !== 'heavy_slug' && w.muzzleFlash,
    );
    for (const [id, w] of others) {
      expect(w.muzzleFlash!.radius, id).toBeLessThanOrEqual(
        def.muzzleFlash!.radius,
      );
    }
    // The documented tie: the Wave Laser is also at the 12 px ceiling.
    expect(WEAPON_CATALOGUE.wave_laser.muzzleFlash!.radius).toBe(12);
    expect(def.muzzleFlash!.radius).toBeLessThanOrEqual(12);
    expect(def.muzzleFlash!.duration).toBeLessThanOrEqual(0.16);
  });

  test('Heavy Slug declares deep-red impact feedback routed through its baked thud (AH-0MVV0WO4M001KEDG)', () => {
    const def = WEAPON_CATALOGUE.heavy_slug;
    // The connect is colour-matched to the deep-red shell and audible through
    // the shared impact seam instead of the generic warm-white fallback flash.
    expect(def.impactFx).toBeDefined();
    expect(def.impactFx!.color).toBe(BULLET_COLORS.heavy_slug);
    expect(def.impactFx!.cue).toBe('playHeavySlugImpactSound');
    // The largest impact radius of the set, at the 12 px ceiling.
    expect(def.impactFx!.radius).toBe(12);
    expect(def.impactFx!.radius).toBeLessThanOrEqual(12);
    expect(def.impactFx!.duration).toBe(0.16);
    expect(def.impactFx!.duration).toBeLessThanOrEqual(0.16);
  });

  test('the Heavy Slug feel package changes no behaviour or balance values (AH-0MVV0WO4M001KEDG)', () => {
    const def = WEAPON_CATALOGUE.heavy_slug;
    // The metadata-only package must leave the single huge shell exactly as
    // shipped — cadence, offsets, colour, silhouette and lifetime unchanged.
    expect(def.fireRateMs).toBe(WEAPON_HEAVY_SLUG_FIRE_RATE);
    expect(def.offsets).toEqual([0]);
    expect(def.bulletColor).toBe(BULLET_COLORS.heavy_slug);
    expect(def.bulletShape).toBe('heavy-shell');
    expect(def.bulletThickness).toBe(3);
    expect(def.bulletRim).toBe(0xffb0b0);
    expect(def.bulletTrail).toBe(2.4);
    expect(def.bulletSize).toBe(1.7);
    expect(def.bulletLifetime).toBe(WEAPON_BULLET_LIFETIME.heavy_slug);
  });

  test('Heavy Slug is the largest, slowest single round in the catalogue', () => {
    expect(WEAPON_CATALOGUE.heavy_slug.offsets).toEqual([0]);
    for (const id of Object.keys(WEAPON_CATALOGUE) as WeaponId[]) {
      if (id === 'heavy_slug') continue;
      expect(WEAPON_CATALOGUE[id].bulletSize, id).toBeLessThanOrEqual(
        WEAPON_CATALOGUE.heavy_slug.bulletSize,
      );
    }
    for (const id of ['cannon', 'spread', 'dual', 'rapid'] as const) {
      expect(WEAPON_CATALOGUE.heavy_slug.fireRateMs).toBeGreaterThan(
        WEAPON_CATALOGUE[id].fireRateMs,
      );
    }
  });

  test('the new weapons are not part of the starting drop rotation', () => {
    // The net-new weapons are ordinary catalogue entries but stay out of the
    // basic spread → dual → rapid field-drop cycle.
    const rotation = weaponDropOrder();
    for (const id of NEW_WEAPON_IDS) {
      expect(rotation).not.toContain(id);
    }
  });
});

// ── Level-0 strength budget (AH-0MVRENEME004FS8T AC1/AC2) ───────────

/**
 * Pre-change level-0 output baselines — the intake brief's measurement table
 * (AH-0MVRENEME004FS8T), transcribed as **literals** on purpose: values
 * re-derived from the catalogue under test could never catch a regression.
 *
 * Each row is `payload × shots/s` (× hit depth for the budget weapons), all
 * from the pre-change catalogue: 80 BPM beat grid, the shipped
 * `DEFAULT_WEAPON_SUBDIVISIONS`, and the then-current hit budgets. AOE rows
 * are `radius² × shots/s` in `px²/s` (`π` cancels in every ratio, so it is
 * omitted from the measure).
 *
 * The `wave_laser` (2 HP beam) and `railgun` (5 HP budget) rows are the intake
 * measurement; both budgets were lowered by later work items
 * (AH-0MVREBUJ5004HDRQ, AH-0MVY0A23A009MRK3), so those weapons already sit
 * below the ceiling. The baseline is frozen history, not live data.
 */
const LEVEL0_OUTPUT_BASELINE: Readonly<Record<WeaponId, number>> = {
  // 1 bullet × 2 shots/beat (2.67 shots/s) — FROZEN.
  cannon: 8 / 3,
  // 3 bullets × 1 shot/beat (1.33 shots/s).
  spread: 4,
  // 2 parallel bullets × 1 shot/beat.
  dual: 8 / 3,
  // 1 bullet × 6 shots/beat (8 shots/s).
  rapid: 8,
  // 1.33 shots/s × the then-2 HP beam budget.
  wave_laser: 8 / 3,
  // 1 pellet × 1.33 shots/s × (1 + 2 wall bounces) targets.
  ricochet: 4,
  // (missile + 2 warheads) × 0.67 shots/s (one shot every 2 beats).
  cluster: 2,
  // 2 pods × 1.33 shots/s.
  options: 8 / 3,
  // 45 px radius² × 0.33 shots/s (one pulse every 4 beats).
  nova: (45 * 45) / 3,
  // 35 px radius² × 0.67 shots/s (one blast every 2 beats).
  mortar: (35 * 35 * 2) / 3,
  // 60 px radius² × 1.33 shots/s (one bolt per beat).
  arc: (60 * 60 * 4) / 3,
  // 1 backward bullet × 2 shots/beat.
  rear_guard: 8 / 3,
  // 2 perpendicular bullets × 0.67 shots/s.
  broadside: 4 / 3,
  // 0.33 shots/s × the then-5 HP pass-through budget.
  railgun: 5 / 3,
  // 5 shards × 1.33 shots/s.
  shard_swarm: 20 / 3,
  // 1 slug × 0.67 shots/s.
  heavy_slug: 2 / 3,
};

/** The family the budget measures each weapon by (AC1 definition). */
const EXPECTED_FAMILY: Readonly<Record<WeaponId, WeaponOutputFamily>> = {
  cannon: 'projectile',
  spread: 'projectile',
  dual: 'projectile',
  rapid: 'projectile',
  wave_laser: 'projectile',
  ricochet: 'bounce',
  cluster: 'split',
  options: 'orbit',
  nova: 'aoe',
  mortar: 'aoe',
  arc: 'aoe',
  rear_guard: 'projectile',
  broadside: 'projectile',
  railgun: 'pierce',
  shard_swarm: 'projectile',
  heavy_slug: 'projectile',
};

/** One weapon's level-0 position against its recorded baseline. */
interface Level0BudgetRow {
  weaponId: WeaponId;
  family: string;
  output: number;
  outputUnit: string;
  baseline: number;
  /** Realised output as a share of the baseline (1 = unchanged). */
  realisedShare: number;
  /** Single-target output as a multiple of the cannon's. */
  cannonMultiple: number;
}

const BUDGET_EPSILON = 1e-9;
const ALL_WEAPON_IDS = Object.keys(WEAPON_CATALOGUE) as WeaponId[];

function level0BudgetRows(): Level0BudgetRow[] {
  const cannon = weaponStrength('cannon');
  return weaponStrengthTable(0).map((strength) => {
    const baseline = LEVEL0_OUTPUT_BASELINE[strength.weaponId];
    return {
      weaponId: strength.weaponId,
      family: strength.family,
      output: strength.output,
      outputUnit: strength.outputUnit,
      baseline,
      realisedShare: strength.output / baseline,
      cannonMultiple: strength.singleTargetOutput / cannon.singleTargetOutput,
    };
  });
}

/** Human-readable budget table — used in every assertion message. */
function formatBudgetReport(rows: Level0BudgetRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.weaponId.padEnd(12)} ${row.family.padEnd(10)} ` +
        `${row.output.toFixed(2).padStart(8)} ${row.outputUnit.padEnd(5)} ` +
        `/ baseline ${row.baseline.toFixed(2).padStart(8)} = ` +
        `${(row.realisedShare * 100).toFixed(1).padStart(5)} % ` +
        `(${row.cannonMultiple.toFixed(2)}× cannon)`,
    )
    .join('\n');
}

describe('level-0 strength budget (AH-0MVRENEME004FS8T AC1/AC2)', () => {
  test('the cannon level-0 snapshot is frozen', () => {
    // AC2: the cannon's level-0 values are byte-identical to the pre-change
    // data. The flattened upgrade curve touches its *levels*, never level 0.
    const cannon = WEAPON_CATALOGUE.cannon;
    expect(cannon.offsets).toEqual([0]);
    expect(cannon.fireRateMs).toBe(375);
    expect(cannon.bulletLifetime).toBe(0.75);
    // No budget descriptor of any kind — an ordinary single-hit bullet.
    expect(cannon.aoe).toBeUndefined();
    expect(cannon.bounce).toBeUndefined();
    expect(cannon.splits).toBeUndefined();
    expect(cannon.maxHitPoints).toBeUndefined();
    expect(cannon.orbit).toBeUndefined();
    expect(cannon.hitscan).toBeUndefined();
  });

  test("the helper reproduces the cannon's recorded baseline exactly", () => {
    // Calibrates the measurement helper against an independent literal: the
    // cannon fires 1 bullet at 2 shots/beat on the 80 BPM grid.
    const cannon = weaponStrength('cannon');
    expect(cannon.family).toBe('projectile');
    expect(cannon.outputUnit).toBe('hits/s');
    expect(cannon.shotsPerSecond).toBeCloseTo(8 / 3, 9);
    expect(cannon.projectilesPerShot).toBe(1);
    expect(cannon.hitsPerProjectile).toBe(1);
    expect(cannon.singleTargetOutput).toBeCloseTo(8 / 3, 9);
    expect(cannon.output).toBeCloseTo(LEVEL0_OUTPUT_BASELINE.cannon, 9);
  });

  test('every catalogue weapon is measured by its documented family', () => {
    for (const id of ALL_WEAPON_IDS) {
      const strength = weaponStrength(id);
      expect(strength.family, id).toBe(EXPECTED_FAMILY[id]);
      expect(strength.outputUnit, id).toBe(
        strength.family === 'aoe' ? 'px²/s' : 'hits/s',
      );
      expect(strength.output, id).toBeGreaterThan(0);
      expect(strength.descriptor.length, id).toBeGreaterThan(0);
    }
  });

  test('the report covers every weapon with a literal baseline', () => {
    // No weapon may be silently omitted from the budget: the report's ids and
    // the baseline table's ids must both be exactly the catalogue.
    const rows = level0BudgetRows();
    expect(rows.map((row) => row.weaponId)).toEqual(ALL_WEAPON_IDS);
    expect(Object.keys(LEVEL0_OUTPUT_BASELINE).sort()).toEqual(
      [...ALL_WEAPON_IDS].sort(),
    );
  });

  test('the documented ceilings match the asserted bounds', () => {
    // Pin the code constants to literals so the documentation, the tests and
    // the helper cannot drift apart — tightening/loosening the budget has to
    // be a deliberate two-place edit.
    expect(WEAPON_STRENGTH_BUDGET.level0BaselineShare).toBe(0.6);
    expect(WEAPON_STRENGTH_BUDGET.level0CannonMultiple).toBe(1.5);
    expect(WEAPON_STRENGTH_BUDGET.level1GrowthMultiple).toBe(2.5);
    expect(WEAPON_STRENGTH_BUDGET.levelCapShareOfPreChange).toBe(0.5);
  });

  test('the measured output never falls as a weapon levels up', () => {
    // The helper consumes the shared level resolver, so it inherits the
    // curve's monotonicity for every family (projectile, pierce, bounce,
    // split, orbit, AOE).
    for (const id of ALL_WEAPON_IDS) {
      const l0 = weaponStrength(id, 0).output;
      const l1 = weaponStrength(id, 1).output;
      const l3 = weaponStrength(id, 3).output;
      expect(l1, `${id} level 1`).toBeGreaterThanOrEqual(l0 - BUDGET_EPSILON);
      expect(l3, `${id} level 3`).toBeGreaterThanOrEqual(l1 - BUDGET_EPSILON);
    }
  });

  /**
   * **Green since the trim** (AH-0MVWAVKS0005P9VN). Authored red under
   * Vitest's `test.fails` by the sibling budget child; the trim flipped it
   * back to `test` once every non-cannon weapon was inside the bound.
   */
  test("every non-cannon weapon is at or below 60 % of its level-0 baseline", () => {
    const rows = level0BudgetRows();
    const overBudget = rows.filter(
      (row) =>
        row.weaponId !== 'cannon' &&
        row.realisedShare > WEAPON_STRENGTH_BUDGET.level0BaselineShare + BUDGET_EPSILON,
    );
    expect(
      overBudget.map(
        (row) =>
          `${row.weaponId}=${(row.realisedShare * 100).toFixed(1)}%`,
      ),
      `level-0 strength budget per weapon:\n${formatBudgetReport(rows)}`,
    ).toEqual([]);
  });

  /**
   * **Green since the trim** (AH-0MVWAVKS0005P9VN). The cap took precedence
   * where 60 % of the baseline was still above 1.5× the cannon (`rapid` was
   * 3.00× and `shard_swarm` 2.50× pre-trim).
   */
  test("no non-cannon weapon's single-target output exceeds 1.5× the cannon's", () => {
    const rows = level0BudgetRows();
    const overCap = rows.filter(
      (row) =>
        row.weaponId !== 'cannon' &&
        row.cannonMultiple > WEAPON_STRENGTH_BUDGET.level0CannonMultiple + BUDGET_EPSILON,
    );
    expect(
      overCap.map(
        (row) => `${row.weaponId}=${row.cannonMultiple.toFixed(2)}× cannon`,
      ),
      `level-0 single-target output vs the cannon:\n${formatBudgetReport(rows)}`,
    ).toEqual([]);
  });

  /**
   * The committed post-change table (the catalogue doc block beside
   * `WEAPON_CATALOGUE`) as **literals**: the realised level-0 output and the
   * percentage of the frozen pre-change baseline, per weapon. Pinning both
   * keeps the documentation, the values and this test in lock-step — a future
   * retune has to edit all three deliberately (AH-0MVWAVKS0005P9VN).
   */
  const LEVEL0_TRIMMED: Readonly<
    Record<WeaponId, { output: number; sharePercent: number }>
  > = {
    // The cannon is frozen at 1.00× — untouched by this trim.
    cannon: { output: 8 / 3, sharePercent: 100 },
    // 3 bullets × 0.5 shots/beat — cadence lever, 50 %.
    spread: { output: 2, sharePercent: 50 },
    // 2 parallel bullets × 0.5 shots/beat — cadence lever, 50 %.
    dual: { output: 4 / 3, sharePercent: 50 },
    // 1 bullet × 3 shots/beat — the 1.5× cannon cap binds, 50 %.
    rapid: { output: 4, sharePercent: 50 },
    // Already inside the bound (single-hit beam, AH-0MVREBUJ5004HDRQ); the
    // curve-flattening work halved its cadence again because that cadence is
    // the beam's only output axis (AH-0MVWAVL6R001UI60).
    wave_laser: { output: 2 / 3, sharePercent: 25 },
    // 1 pellet × 0.5 shots/beat × 3 bounce targets — cadence lever, 50 %.
    ricochet: { output: 2, sharePercent: 50 },
    // (missile + 2 warheads) × 0.25 shots/beat — cadence lever, 50 %.
    cluster: { output: 1, sharePercent: 50 },
    // 2 pods × 0.5 shots/beat — cadence lever, 50 %.
    options: { output: 4 / 3, sharePercent: 50 },
    // 34 px radius² × 0.33 shots/beat — nearest whole px at or below 60 %.
    nova: { output: (34 * 34) / 3, sharePercent: (34 * 34) / 2025 * 100 },
    // 27 px radius² × 0.67 shots/beat — 59.5 %.
    mortar: { output: (27 * 27 * 2) / 3, sharePercent: (27 * 27) / 1225 * 100 },
    // 46 px radius² × 1.33 shots/beat — 58.8 %.
    arc: { output: (46 * 46 * 4) / 3, sharePercent: (46 * 46) / 3600 * 100 },
    // 1 backward bullet × 1 shot/beat — cadence lever, 50 %.
    rear_guard: { output: 4 / 3, sharePercent: 50 },
    // 2 perpendicular bullets × 0.25 shots/beat — cadence lever, 50 %.
    broadside: { output: 2 / 3, sharePercent: 50 },
    // Already inside the bound (level-0 budget 1, AH-0MVY0A23A009MRK3).
    railgun: { output: 1 / 3, sharePercent: 20 },
    // 5 shards × 0.5 shots/beat — cadence lever keeps the five-shard fan, 50 %.
    shard_swarm: { output: 10 / 3, sharePercent: 50 },
    // 1 slug × 0.25 shots/beat — cadence lever, 50 %.
    heavy_slug: { output: 1 / 3, sharePercent: 50 },
  };

  test('the committed post-change level-0 table matches the catalogue', () => {
    const rows = level0BudgetRows();
    expect(Object.keys(LEVEL0_TRIMMED).sort()).toEqual(
      [...ALL_WEAPON_IDS].sort(),
    );
    for (const row of rows) {
      const expected = LEVEL0_TRIMMED[row.weaponId];
      expect(row.output, `${row.weaponId} output`).toBeCloseTo(
        expected.output,
        9,
      );
      expect(
        row.realisedShare * 100,
        `${row.weaponId} share`,
      ).toBeCloseTo(expected.sharePercent, 9);
    }
  });
});
