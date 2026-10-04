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
  WEAPON_NOVA_FIRE_RATE,
  WEAPON_MORTAR_FIRE_RATE,
  WEAPON_ARC_FIRE_RATE,
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
  WEAPON_BULLET_LIFETIME,
  isTimedWeapon,
} from './weapons';
import { beatPeriodMs, beatSubdivisionMs } from './beat';

describe('WEAPON_CATALOGUE', () => {
  test('contains the four conventional weapons plus the three AOE weapons', () => {
    expect(Object.keys(WEAPON_CATALOGUE).length).toBe(7);
    expect(WEAPON_CATALOGUE.cannon).toBeDefined();
    expect(WEAPON_CATALOGUE.spread).toBeDefined();
    expect(WEAPON_CATALOGUE.dual).toBeDefined();
    expect(WEAPON_CATALOGUE.rapid).toBeDefined();
    expect(WEAPON_CATALOGUE.nova).toBeDefined();
    expect(WEAPON_CATALOGUE.mortar).toBeDefined();
    expect(WEAPON_CATALOGUE.arc).toBeDefined();
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

  test('every AOE radius is exactly half the pre-reduction value (AC2)', () => {
    // Pre-change radii: Nova 90, Mortar 70, Arc 120 (AH-0MUU131PU006O7ZD).
    expect(AOE_RADII.nova).toBe(45);
    expect(AOE_RADII.mortar).toBe(35);
    expect(AOE_RADII.arc).toBe(60);
    expect(AOE_RADII.nova).toBeCloseTo(90 / 2, 10);
    expect(AOE_RADII.mortar).toBeCloseTo(70 / 2, 10);
    expect(AOE_RADII.arc).toBeCloseTo(120 / 2, 10);
  });

  test('AOE radii are halved alongside the conventional bullet range (AC2/AC5)', () => {
    // The conventional base lifetime and AOE radii were halved together, so
    // the shared sources of truth stay in step (AH-0MUU131PU006O7ZD).
    const halvings: Array<[number, number]> = [
      [WEAPON_BULLET_LIFETIME.cannon, 1.5],
      [AOE_RADII.nova, 90],
      [AOE_RADII.mortar, 70],
      [AOE_RADII.arc, 120],
    ];
    for (const [after, before] of halvings) {
      expect(after).toBeCloseTo(before / 2, 10);
    }
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

  test('Mortar resolves an onImpact detonation', () => {
    const aoe = WEAPON_CATALOGUE.mortar.aoe!;
    expect(aoe.trigger).toBe('onImpact');
    expect(aoe.radius).toBe(AOE_RADII.mortar);
    expect(aoe.damagesEnemies).toBe(true);
    expect(aoe.clearsEnemyBullets).toBe(true);
    // The mortar shell travels slower than a conventional bullet so its
    // detonation point is legible.
    expect(aoe.projectileSpeed).toBe(AOE_PROJECTILE_SPEEDS.mortar);
    expect(aoe.projectileSpeed!).toBeLessThan(BULLET_SPEED);
    // The mortar shell lives long enough to reach a target and detonate.
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
    // Spread and dual are both whole-time (1 shot per beat) — equal rates.
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
    // spread — 1/beat (80 BPM) → 750 ms
    expect(WEAPON_SPREAD_SUBDIVISION).toBe(1);
    expect(WEAPON_CATALOGUE.spread.fireRateMs).toBe(750);
    // dual — 1/beat (80 BPM) → 750 ms
    expect(WEAPON_DUAL_SUBDIVISION).toBe(1);
    expect(WEAPON_CATALOGUE.dual.fireRateMs).toBe(750);
    // rapid — 6/beat (480 BPM) → 125 ms
    expect(WEAPON_RAPID_SUBDIVISION).toBe(6);
    expect(WEAPON_CATALOGUE.rapid.fireRateMs).toBe(125);
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
      nova: 0.25,
      mortar: 0.5,
      arc: 1,
    };
    for (const id of weaponIds) {
      const rate = weaponFireRateMs(id, subdivisions, bpm);
      // On-grid covers both fast subdivisions (rate divides the period) and
      // slow AOE cadences (rate is an integer multiple of the period).
      expect(isOnBeatGrid(rate, bpm)).toBe(true);
    }
  });
});